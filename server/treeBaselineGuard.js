// server/treeBaselineGuard.js
// ── Reproducibility guard for the Tree backtest baseline ────────────────────
// The dashboard's Tree backtest (treeProjectionBaseline.json) is a FROZEN historical
// artifact (2023-01-03 → 2026-06-11). It can only become wrong if its INPUTS change —
// i.e. the candle data it was built on gets rewritten (a split re-sync rescaling history,
// an FMP revision, a universe add/remove). That is exactly the failure that surfaced the
// +1,169% vs +795% discrepancy days late.
//
// This guard fingerprints those exact inputs. The generator stamps the fingerprint into the
// baseline file when it builds it; the nightly cron recomputes the fingerprint on current
// data and ALARMS if it no longer matches — so a drift trips the same day, not weeks later.
// computeInputHash is the SINGLE shared source of truth (the generator imports it too), so
// the guard and the generator can never disagree by replica drift.
import crypto from 'crypto';
import fs from 'fs';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { loadTreeData, simulateTree, DEFAULT_START, DEFAULT_END } from './backtest/treeSim.js';

// MUST match build_tree_baseline.mjs: same universe (current AI-300 members), freeze date,
// and min-history filter (ENTRY_HIGH_LOOKBACK+5). Lookback is the 42-week high (210 trading days).
const END = '2026-06-11';
const MIN_BARS = 210 + 5;
const AI_SET = new Set(); for (const s of SECTORS) for (const h of s.holdings) AI_SET.add(h.ticker);
const BASELINE_PATH = new URL('./data/treeProjectionBaseline.json', import.meta.url).pathname;

// Canonical fingerprint of every candle series the backtest consumes (frozen window only).
// OHLC at 4dp catches split rescales (e.g. $1,500 → $150) AND vendor revisions; ticker set
// catches universe add/remove. Order-independent (parts sorted).
export async function computeInputHash(db) {
  const docs = await db.collection('pnthr_ai_bt_candles').find({}).toArray();
  const parts = [];
  for (const d of docs) {
    if (!AI_SET.has(d.ticker)) continue;   // current index members only (matches the backtest universe)
    const bars = (d.daily || [])
      .filter(b => +b.low > 0 && +b.close > 0 && b.date <= END)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (bars.length < MIN_BARS) continue;
    parts.push((d.ticker || '') + '|' + bars.map(b =>
      `${b.date}:${(+b.open).toFixed(4)},${(+b.high).toFixed(4)},${(+b.low).toFixed(4)},${(+b.close).toFixed(4)}`).join(';'));
  }
  parts.sort();
  return { hash: crypto.createHash('sha1').update(parts.join('\n')).digest('hex'), names: parts.length };
}

// Tolerances above the 1-decimal precision the baseline stores, so floating noise never trips.
const NET_TOL = 0.5;    // pts of total-return %
const CAGR_TOL = 0.3;   // pts of CAGR %

// Re-run the LOCKED engine on CURRENT data and return the headline NET return + CAGR. This is the
// single thing that decides whether the displayed track record is actually stale. (Fresh load,
// one run — simulateTree mutates its inputs, so it must never be reused across runs.)
async function recomputeHeadline(db) {
  const data = await loadTreeData(db, { end: DEFAULT_END, universe: 'ai' });
  const sim = simulateTree(data, { nav0: 100000, start: DEFAULT_START });
  const endEq = sim.equity[sim.equity.length - 1].eq;
  const years = (Date.parse(data.lastDate) - Date.parse(sim.equity[0].date)) / (365.25 * 86400000);
  return {
    net: +(((endEq - 100000) / 100000) * 100).toFixed(1),
    cagr: +(((Math.pow(endEq / 100000, 1 / years)) - 1) * 100).toFixed(1),
    names: Object.keys(data.T).length,
  };
}

// Detect drift, persist a flag, log loudly ONLY when it matters.
// The raw-OHLC fingerprint (computeInputHash) changes on EVERY split re-sync, but a correctly
// applied split is return-neutral: prices, shares, stop and exit all scale together, so the
// backtest numbers are unchanged. Fingerprint-only alarms therefore cried wolf on every split
// (HON/MLI/CRWD etc.). We now alarm only on MATERIAL drift — the engine re-run on current data
// shows the SHOWN numbers actually moved — which is the only case that needs a human to
// regenerate + re-commit the baseline (a real AI-300 membership change, or a trade-moving data
// revision / corruption). Return-neutral splits are auto-acknowledged, no action, no banner.
export async function checkTreeBaselineDrift(db) {
  let stored;
  try { stored = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); }
  catch (e) { console.error('[Tree Baseline Guard] baseline file unreadable:', e.message); return { ok: false, error: 'unreadable' }; }

  const { hash, names } = await computeInputHash(db);
  const storedHash = stored.inputHash || null;
  const inputChanged = storedHash != null && storedHash !== hash;
  const storedNet = stored.metrics?.netReturnPct ?? null;
  const storedCagr = stored.metrics?.cagrPct ?? null;

  // The decisive test: did the displayed numbers move? Re-run the locked engine on current data.
  let currentNet = null, currentCagr = null, material = null, engineError = null;
  try {
    const cur = await recomputeHeadline(db);
    currentNet = cur.net; currentCagr = cur.cagr;
    material = storedNet != null &&
      (Math.abs(currentNet - storedNet) > NET_TOL || Math.abs(currentCagr - (storedCagr ?? 0)) > CAGR_TOL);
  } catch (e) { engineError = e.message; }

  // Banner fires on MATERIAL drift only. If the engine can't recompute, fall back to the raw-input
  // signal (conservative — better a false alarm than a silently-stale number we couldn't verify).
  const drifted = engineError ? inputChanged : (material === true);
  const cosmeticOnly = !engineError && inputChanged && material === false;

  const result = {
    drifted, material, cosmeticOnly, inputChanged,
    hasStoredHash: storedHash != null, storedHash, currentHash: hash, names,
    storedNet, currentNet, storedCagr, currentCagr, engineError,
    checkedAt: new Date().toISOString(),
  };

  try {
    await db.collection('pnthr_tree_config').updateOne({}, { $set: { baselineDrift: result } }, { upsert: true });
  } catch (e) { console.error('[Tree Baseline Guard] could not persist flag:', e.message); }

  if (drifted && material) {
    console.error(`🔴 [Tree Baseline Guard] MATERIAL DRIFT — the Tree backtest numbers moved: stored ${storedNet}% net / ${storedCagr}% CAGR vs current ${currentNet}% / ${currentCagr}% (${names} names). Likely an AI-300 membership change or a trade-moving data revision. Regenerate: cd server/backtest && node --env-file=../.env build_tree_baseline.mjs, then commit treeProjectionBaseline.json.`);
  } else if (drifted && engineError) {
    console.error(`🔴 [Tree Baseline Guard] inputs changed AND engine recompute failed (${engineError}) — cannot confirm the backtest is unaffected. Investigate. (stored ${storedHash?.slice(0, 10)} vs current ${hash.slice(0, 10)})`);
  } else if (cosmeticOnly) {
    console.log(`ℹ️ [Tree Baseline Guard] inputs changed but backtest UNAFFECTED (return-neutral split / data revision) — numbers hold at ${currentNet}% net / ${currentCagr}% CAGR. Auto-acknowledged, no action needed. (hash ${storedHash?.slice(0, 10)} → ${hash.slice(0, 10)}, ${names} names)`);
  } else if (storedHash == null) {
    console.warn('[Tree Baseline Guard] baseline has no inputHash yet — regenerate it to enable drift detection.');
  } else {
    console.log(`[Tree Baseline Guard] OK — backtest numbers unchanged (${currentNet ?? storedNet}% net, ${names} names).`);
  }
  return result;
}
