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

// MUST match build_tree_baseline.mjs: same universe (current AI-300 members), freeze date,
// and min-history filter (LOOKBACK_52W+5).
const END = '2026-06-11';
const MIN_BARS = 252 + 5;
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

// Recompute the fingerprint, compare to the committed baseline, persist a flag, log loudly on drift.
export async function checkTreeBaselineDrift(db) {
  let stored;
  try { stored = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); }
  catch (e) { console.error('[Tree Baseline Guard] baseline file unreadable:', e.message); return { ok: false, error: 'unreadable' }; }

  const { hash, names } = await computeInputHash(db);
  const storedHash = stored.inputHash || null;
  const drifted = storedHash != null && storedHash !== hash;
  const result = { drifted, hasStoredHash: storedHash != null, storedHash, currentHash: hash, names, storedNet: stored.metrics?.netReturnPct ?? null, checkedAt: new Date().toISOString() };

  try {
    await db.collection('pnthr_tree_config').updateOne({}, { $set: { baselineDrift: result } }, { upsert: true });
  } catch (e) { console.error('[Tree Baseline Guard] could not persist flag:', e.message); }

  if (drifted) {
    console.error(`🔴 [Tree Baseline Guard] DRIFT DETECTED — the Tree backtest inputs changed (stored ${storedHash.slice(0, 10)} vs current ${hash.slice(0, 10)}, ${names} names). The dashboard backtest (${stored.metrics?.netReturnPct}% net) is now STALE. Re-run: cd server/backtest && node --env-file=../.env build_tree_baseline.mjs, then commit treeProjectionBaseline.json.`);
  } else if (storedHash == null) {
    console.warn('[Tree Baseline Guard] baseline has no inputHash yet — regenerate it to enable drift detection.');
  } else {
    console.log(`[Tree Baseline Guard] OK — backtest inputs unchanged (${hash.slice(0, 10)}, ${names} names).`);
  }
  return result;
}
