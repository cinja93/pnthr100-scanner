// server/ambush/ambushLiveReconcile.js
// PNTHR AMBUSH — LIVE reconcile (the verification harness).
// IBKR is the SOURCE OF TRUTH. For every held position we check the engine's view and the
// engine's protective stop against what IBKR actually holds, plus the Ambush-specific rules
// (correct 2-bar stop level, full-position stop quantity, 10% notional cap, 1%-NAV risk).
// Each check returns {status: green|yellow|red|gray, reason}. The row rolls up to the worst.
// This is an INDEPENDENT check — it recomputes the "correct" values itself, so it catches the
// engine being wrong. Works in dry-run AND live. Drives the Devour-row pills + the Copy-Diag.
import { getAmbushPositions, getAmbushConfig } from './ambushStateManager.js';
import { getUserProfile } from '../database.js';

const FMP_API_KEY = process.env.FMP_API_KEY;
const TOL = { AVG: 0.03, STOP: 0.03, LEVEL: 0.03 };
const CAP_PCT = 0.10;      // 10% NAV max notional per ticker
const RISK_PCT_CAP = 0.01; // 1% NAV max risk per position (at full 5 lots)
const MAX_LOSS = 150;      // Scott's per-position max loss for current NAV — the binding cap is min($150, 1% NAV)

function worst(...s) {
  if (s.includes('red')) return 'red';
  if (s.includes('yellow')) return 'yellow';
  if (s.includes('green')) return 'green';
  return 'gray';
}

// ── FMP 30-min → :00 clock-hour bars (mirrors ambushCron 5a; the engine trails off these) ──
async function fmp30(ticker) {
  try {
    const r = await fetch(`https://financialmodelingprep.com/api/v3/historical-chart/30min/${ticker}?apikey=${FMP_API_KEY}`);
    const d = await r.json(); return Array.isArray(d) ? d : [];
  } catch { return []; }
}
function clockHours(raw, today, nowMin) {
  const byHour = {};
  for (const b of raw) { if (!(b.date || '').startsWith(today)) continue; const h = parseInt(b.date.split(' ')[1].slice(0, 2), 10); (byHour[h] = byHour[h] || []).push(b); }
  const out = [];
  for (const h of Object.keys(byHour).map(Number).sort((a, b) => a - b)) {
    if ((h + 1) * 60 > nowMin) continue; // forming hour dropped
    const bs = byHour[h];
    out.push({ low: Math.min(...bs.map(x => +x.low)), high: Math.max(...bs.map(x => +x.high)) });
  }
  return out;
}

// ── Per-check functions (IBKR truth vs engine) ──────────────────────────────
function checkDir(engineDir, ibSh) {
  const ibDir = ibSh == null || ibSh === 0 ? null : (ibSh > 0 ? 'LONG' : 'SHORT');
  if (!ibDir && !engineDir) return { status: 'gray' };
  if (!ibDir) return { status: 'red', reason: `engine ${engineDir}, IBKR flat` };
  if (!engineDir) return { status: 'red', reason: `IBKR ${ibDir}, engine has no position` };
  return ibDir === engineDir ? { status: 'green' } : { status: 'red', reason: `IBKR ${ibDir} vs engine ${engineDir}` };
}
function checkShares(engSh, ibSh) {
  const e = Math.abs(+engSh || 0), i = Math.abs(+ibSh || 0);
  if (e === 0 && i === 0) return { status: 'gray' };
  if (e === i) return { status: 'green' };
  return { status: 'red', reason: `engine ${e}sh vs IBKR ${i}sh` };
}
function checkAvg(engAvg, ibAvg) {
  if (engAvg == null || ibAvg == null || !engAvg || !ibAvg) return { status: 'gray' };
  const d = Math.abs(engAvg - ibAvg);
  if (d <= TOL.AVG) return { status: 'green' };
  return { status: d < ibAvg * 0.0025 ? 'yellow' : 'red', reason: `avg engine ${engAvg.toFixed(2)} vs IBKR ${ibAvg.toFixed(2)} ($${d.toFixed(2)})` };
}
function checkStopExists(held, isLong, ibStops) {
  if (!held) return { status: 'gray' };
  const want = isLong ? 'SELL' : 'BUY';
  const has = ibStops.some(s => s.action === want);
  return has ? { status: 'green' } : { status: 'red', reason: 'NAKED — no protective stop in IBKR' };
}
function checkStopPrice(engStop, ibStops, isLong) {
  if (engStop == null) return { status: 'gray' };
  const want = isLong ? 'SELL' : 'BUY';
  const mine = ibStops.filter(s => s.action === want);
  if (!mine.length) return { status: 'red', reason: 'no IBKR stop to compare' };
  if (mine.length > 1) return { status: 'red', reason: `${mine.length} duplicate stops in IBKR` };
  const ibPx = +mine[0].stopPrice;
  const d = Math.abs(ibPx - engStop);
  return d <= TOL.STOP ? { status: 'green' } : { status: 'red', reason: `IBKR stop ${ibPx.toFixed(2)} vs engine ${engStop.toFixed(2)} ($${d.toFixed(2)})` };
}
function checkStopLevel(engStop, correctTrail) {
  if (engStop == null || correctTrail == null) return { status: 'gray' };
  const d = Math.abs(engStop - correctTrail);
  return d <= TOL.LEVEL ? { status: 'green' } : { status: 'red', reason: `stop ${engStop.toFixed(2)} vs correct 2-bar ${correctTrail.toFixed(2)} ($${d.toFixed(2)})` };
}
function checkStopQty(ibStops, ibSh, isLong) {
  const want = isLong ? 'SELL' : 'BUY';
  const mine = ibStops.filter(s => s.action === want);
  const pos = Math.abs(+ibSh || 0);
  if (!mine.length || pos === 0) return { status: 'gray' };
  const stopSh = mine.reduce((a, s) => a + Math.abs(+s.shares || +s.totalQuantity || 0), 0);
  if (stopSh === pos) return { status: 'green' };
  return { status: 'red', reason: `stop covers ${stopSh}sh of ${pos}sh position` };
}
function checkCap(notional, nav) {
  if (!notional || !nav) return { status: 'gray' };
  const pct = notional / nav;
  if (pct <= CAP_PCT) return { status: 'green' };
  return { status: 'red', reason: `${(pct * 100).toFixed(1)}% of NAV (cap ${CAP_PCT * 100}%)` };
}
function checkRisk(riskAtFull, nav) {
  if (riskAtFull == null || !nav) return { status: 'gray' };
  const cap = Math.min(MAX_LOSS, nav * RISK_PCT_CAP); // binding = smaller of $150 and 1% NAV
  if (riskAtFull <= cap) return { status: 'green' };
  return { status: riskAtFull < cap * 1.25 ? 'yellow' : 'red', reason: `$${riskAtFull.toFixed(0)} risk at 5 lots > $${cap.toFixed(0)} cap (max-loss $${MAX_LOSS} / 1% NAV $${(nav * RISK_PCT_CAP).toFixed(0)})` };
}

// ── Main ────────────────────────────────────────────────────────────────────
export async function getAmbushLiveReconcile(db) {
  const cfg = await getAmbushConfig(db);
  let nav = cfg?.nav || 83000;
  if (cfg?.ownerId) { try { const p = await getUserProfile(cfg.ownerId); if (p?.accountSize > 0) nav = p.accountSize; } catch {} }

  const snap = await db.collection('pnthr_ibkr_positions').findOne({ ownerId: cfg?.ownerId });
  const snapAgeMin = snap?.syncedAt ? (Date.now() - new Date(snap.syncedAt).getTime()) / 60000 : Infinity;
  const ib = {}; for (const p of (snap?.positions || [])) { const t = (p.symbol || p.ticker || '').toUpperCase(); if (t) ib[t] = { sh: +p.shares || 0, avg: +p.avgCost || 0, px: +p.marketPrice || +p.avgCost || 0 }; }
  const ibStops = {}; for (const s of (snap?.stopOrders || [])) { const t = (s.symbol || '').toUpperCase(); if (t && (s.orderType === 'STP' || s.orderType === 'STP LMT')) (ibStops[t] = ibStops[t] || []).push(s); }

  const positions = await getAmbushPositions(db);
  const held = positions.filter(p => p.state === 'ACTIVE' || p.state === 'PROTECT' || (+p.totalShares || 0) !== 0);

  // union of engine-held tickers and IBKR-held tickers (catch positions the engine doesn't know about)
  const tickers = new Set([...held.map(p => p.ticker.toUpperCase()), ...Object.keys(ib).filter(t => ib[t].sh !== 0)]);

  const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date())) p[x.type] = x.value;
  const nowMin = +p.hour * 60 + +p.minute;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  const rows = [];
  for (const t of [...tickers].sort()) {
    const pos = held.find(x => x.ticker.toUpperCase() === t) || null;
    const ibP = ib[t] || null;
    const stops = ibStops[t] || [];
    const isLong = pos ? pos.direction === 'LONG' : (ibP && ibP.sh > 0);
    const engSh = pos ? +pos.totalShares || 0 : 0;
    const engStop = pos ? pos.stop : null;
    const held_ = (ibP && ibP.sh !== 0) || engSh !== 0;

    // correct current 2-bar level (independent recompute)
    const hrs = clockHours(await fmp30(t), today, nowMin);
    let correctTrail = null;
    if (hrs.length >= 2) { const A = hrs[hrs.length - 1], B = hrs[hrs.length - 2]; correctTrail = isLong ? +(Math.min(A.low, B.low) - 0.01).toFixed(2) : +(Math.max(A.high, B.high) + 0.01).toFixed(2); }

    const px = (ibP && ibP.px) || pos?.livePrice || pos?.avgCost || (hrs.length ? (isLong ? hrs[hrs.length - 1].low : hrs[hrs.length - 1].high) : 0);
    const notional = Math.abs((ibP?.sh ?? engSh)) * px;

    // risk ladder: NAV% at each lot level, and risk ($) at full 5 lots
    const lotPlan = pos?.lotPlan || null;
    const rps = (pos && engStop != null && pos.avgCost) ? Math.abs(pos.avgCost - engStop) : null; // risk per share now
    const fullSh = lotPlan ? lotPlan.reduce((a, b) => a + b, 0) : null;
    const riskAtFull = (rps != null && fullSh != null) ? +(rps * fullSh).toFixed(2) : (rps != null ? +(rps * engSh).toFixed(2) : null);
    const lotLadder = lotPlan ? lotPlan.map((_, i) => {
      const shAtLot = lotPlan.slice(0, i + 1).reduce((a, b) => a + b, 0);
      return { lot: i + 1, shares: shAtLot, navPct: rps != null ? +((rps * shAtLot) / nav * 100).toFixed(2) : null, notionalPct: +((shAtLot * px) / nav * 100).toFixed(1) };
    }) : null;

    const checks = {
      direction: checkDir(pos?.direction || null, ibP?.sh),
      shares:    checkShares(engSh, ibP?.sh),
      avgCost:   checkAvg(pos?.avgCost ?? null, ibP?.avg ?? null),
      stopExists: checkStopExists(held_, isLong, stops),
      stopPrice: checkStopPrice(engStop, stops, isLong),
      stopLevel: checkStopLevel(engStop, correctTrail),
      stopQty:   checkStopQty(stops, ibP?.sh, isLong),
      cap:       checkCap(notional, nav),
      risk:      checkRisk(riskAtFull, nav),
    };
    const rollup = worst(...Object.values(checks).map(c => c.status));
    const reasons = Object.entries(checks).filter(([, c]) => c.status === 'red' || c.status === 'yellow').map(([k, c]) => `${k}: ${c.reason}`);

    rows.push({
      ticker: t, state: pos?.state || 'UNTRACKED', direction: pos?.direction || (ibP?.sh > 0 ? 'LONG' : ibP?.sh < 0 ? 'SHORT' : '?'),
      engineShares: engSh, ibkrShares: ibP?.sh ?? null, engineStop: engStop, ibkrStop: stops.map(s => +s.stopPrice),
      correctTrail, notionalPct: nav ? +(notional / nav * 100).toFixed(1) : null, riskAtFull, riskPct: (riskAtFull != null && nav) ? +(riskAtFull / nav * 100).toFixed(2) : null,
      lotLadder, checks, rollup, reasons,
    });
  }

  const summary = { green: 0, yellow: 0, red: 0, gray: 0 };
  for (const r of rows) summary[r.rollup]++;
  // snapshot health: empty-but-engine-holds = the failure that started today
  const snapHealth = (Object.keys(ib).filter(t => ib[t].sh !== 0).length === 0 && held.length > 0)
    ? { status: 'red', reason: `IBKR snapshot EMPTY but engine holds ${held.length} — failed sync` }
    : (snapAgeMin > 5 ? { status: 'yellow', reason: `snapshot ${snapAgeMin.toFixed(0)}m stale` } : { status: 'green' });

  // ── DIAG: copy-pasteable text of everything that isn't green ──
  const diagLines = [`AMBUSH LIVE RECONCILE — ${today} ${p.hour}:${p.minute} ET | NAV $${Math.round(nav).toLocaleString()} | snapshot ${snapAgeMin === Infinity ? 'MISSING' : snapAgeMin.toFixed(1) + 'm'}`,
    `pills: ${summary.green} green, ${summary.yellow} amber, ${summary.red} RED | snapshot health: ${snapHealth.status}${snapHealth.reason ? ' (' + snapHealth.reason + ')' : ''}`, ''];
  for (const r of rows.filter(r => r.rollup === 'red' || r.rollup === 'yellow')) {
    diagLines.push(`${r.rollup.toUpperCase()} ${r.ticker} (${r.direction}): ${r.reasons.join(' | ')}`);
  }
  if (!rows.some(r => r.rollup === 'red' || r.rollup === 'yellow')) diagLines.push('ALL GREEN — engine matches IBKR, stops correct, no cap/risk breach.');

  return { rows, summary, snapHealth, snapAgeMin: snapAgeMin === Infinity ? null : +snapAgeMin.toFixed(1), nav, diag: diagLines.join('\n') };
}
