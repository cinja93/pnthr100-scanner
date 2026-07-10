// ── (c) Does an OpEMA-cross exit overlay improve Tree's drawdown? ─────────────
// Baseline = the REAL locked simulateTree (treeSim.js). Overlay = a byte-faithful
// COPY of simulateTree + ONE added exit: close a held Tree long at the next open
// once that stock's last COMPLETED weekly close is below its OpEMA (no look-ahead).
// The live engine is NOT touched. Fidelity is proven: overlay-OFF must equal baseline.
//
// Tree already exits on the daily-10 low stop; this asks whether the slower weekly
// OpEMA-cross exit helps (Tree runs 2x, so drawdown is the thing that matters).
// Run: node --env-file=../.env _tree_opema_overlay.mjs

import { connectToDatabase } from '../database.js';
import { loadTreeData, simulateTree, MOST_LIQUID, DEFAULT_START, DEFAULT_END, VITALITY_PCT, TICKER_CAP_PCT, MAX_GROSS, ENTRY_HIGH_LOOKBACK, STOP_LOOKBACK, ADV_CAP_PCT, BE_SNAP_PROFIT } from './treeSim.js';
import { calcCommission, calcSlippage, calcMarginInterest } from './costEngine.js';
import { calculateEMA } from '../signalDetection.js';
import { SECTORS } from '../scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from '../data/pnthrAiSectorsConfig.js';

const END = process.env.END || DEFAULT_END;
const TK_PERIOD = {}; for (const s of SECTORS) for (const h of s.holdings) if (TK_PERIOD[h.ticker] == null) TK_PERIOD[h.ticker] = SECTOR_EMA_PERIODS[s.id] || 30;
function effectivePeriod(barCount, sectorPeriod) { if (barCount >= sectorPeriod * 3) return sectorPeriod; if (barCount >= 23) return 21; return null; }
function calendarDayGap(a, b) { return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86400000)); }

const db = await connectToDatabase();
const data = await loadTreeData(db, { end: END, universe: 'ai' });

// ── per-stock "below OpEMA as of the last completed week" (band = 0 raw cross, or 1% hysteresis) ──
async function buildExitGate(band) {
  const wdocs = await db.collection('pnthr_ai_bt_candles_weekly').find({}, { projection: { ticker: 1, weekly: 1 } }).toArray();
  const belowBy = {};
  for (const doc of wdocs) {
    const t = doc.ticker; if (!TK_PERIOD[t]) continue;
    const wb = (doc.weekly || []).map(b => ({ weekOf: b.weekOf, lastDate: b.lastDate || b.weekOf, close: +b.close })).filter(b => b.close > 0 && b.lastDate <= END).sort((a, b) => a.weekOf.localeCompare(b.weekOf));
    const period = effectivePeriod(wb.length, TK_PERIOD[t]); if (!period) continue;
    const emaArr = calculateEMA(wb.map(b => ({ time: b.weekOf, close: b.close })), period);
    const emaBy = {}; for (const e of emaArr) emaBy[e.time] = e.value;
    const arr = []; let below = false;
    for (const b of wb) { const ema = emaBy[b.weekOf]; if (ema == null) continue; if (b.close < ema * (1 - band)) below = true; else if (b.close > ema * (1 + band)) below = false; arr.push({ lastDate: b.lastDate, below }); }
    belowBy[t] = arr;
  }
  return (ticker, date) => {
    const arr = belowBy[ticker]; if (!arr) return false;
    let lo = 0, hi = arr.length - 1, ans = null;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].lastDate < date) { ans = arr[m]; lo = m + 1; } else hi = m - 1; }
    return ans ? ans.below : false;
  };
}

// ── COPY of simulateTree (treeSim.js) + one added exit (exitGate). exitGate=null => byte-identical. ──
function simulateTreeOverlay({ T, allDates, spyAt, lastDate }, { nav0 = 100000, start = DEFAULT_START, beSnap = BE_SNAP_PROFIT, entrySort = null, maxGross = MAX_GROSS, marginFinancing = true } = {}, exitGate = null) {
  const NAV0 = nav0; const positions = {};
  let realized = 0, realizedGross = 0, totalComm = 0, totalSlip = 0, totalMarginInterest = 0, prevDate = null;
  const closed = [], equity = [], equityGross = [];
  let peak = NAV0, maxDDfrac = 0, maxDDdollar = 0, peakG = NAV0, maxDDfracG = 0, maxDDdollarG = 0;
  let opemaExits = 0;
  const unrealAt = m => { let u = 0; for (const [t, p] of Object.entries(positions)) { const px = m[t]; if (px == null) continue; u += (px - p.fill) * p.sh; } return u; };
  const equityAt = m => NAV0 + realized + unrealAt(m);
  const equityGrossAt = m => NAV0 + realizedGross + unrealAt(m);
  const grossAt = m => { let g = 0; for (const [t, p] of Object.entries(positions)) g += p.sh * (m[t] ?? p.fill); return g; };
  function closePos(t, exitPx, date, reason = 'STOP') {
    const p = positions[t]; if (!p) return;
    const comm = calcCommission(p.sh, exitPx), slip = calcSlippage(p.sh, exitPx); totalComm += comm; totalSlip += slip;
    const gross = (exitPx - p.fill) * p.sh; realizedGross += gross; realized += gross - comm - slip;
    closed.push({ ticker: t, pnl: gross - comm - slip, pnlGross: gross, returnPct: p.fill > 0 ? +(((exitPx - p.fill) / p.fill) * 100).toFixed(2) : 0, exitReason: reason });
    if (reason === 'OPEMA_EXIT') opemaExits++;
    delete positions[t];
  }
  for (const date of allDates) {
    if (date < start) continue;
    for (const t of Object.keys(positions)) {
      const tk = T[t]; const i = tk.idxByDate[date]; if (i == null) continue;
      const bar = tk.bars[i]; const pos = positions[t];
      if (tk.loStop[i] != null) { const s = tk.loStop[i] - 0.01; pos.stop = pos.stop == null ? s : Math.max(pos.stop, s); }
      if (pos.stop != null && bar.l <= pos.stop) closePos(t, Math.min(pos.stop, bar.o), date, 'STOP');
      if (exitGate && positions[t] && exitGate(t, date)) closePos(t, bar.o, date, 'OPEMA_EXIT');   // <-- ONLY addition
    }
    const mark = {}; for (const t of Object.keys(positions)) { const i = T[t].idxByDate[date]; if (i != null) mark[t] = T[t].bars[i].c; }
    const markPrev = {}; for (const t of Object.keys(positions)) { const i = T[t].idxByDate[date]; if (i == null) continue; markPrev[t] = (i > 0 ? T[t].bars[i - 1].c : positions[t].fill); }
    const curEq = equityAt(markPrev);
    let cands = [];
    for (const t of Object.keys(T)) {
      if (positions[t]) continue;
      const tk = T[t]; const i = tk.idxByDate[date]; if (i == null || i < ENTRY_HIGH_LOOKBACK) continue;
      const bar = tk.bars[i];
      if (tk.hi52[i] == null || bar.h < tk.hi52[i] + 0.01 || tk.loStop[i] == null) continue;
      const trig = +(tk.hi52[i] + 0.01).toFixed(2); const fill = Math.max(trig, bar.o); const stop = +(tk.loStop[i] - 0.01).toFixed(2);
      const rps = fill - stop; if (rps <= 0.01 || stop >= fill) continue;
      const shTarget = Math.min(Math.floor((curEq * VITALITY_PCT) / rps), Math.floor((curEq * TICKER_CAP_PCT) / fill));
      let sh = shTarget; const advMax = Math.floor((tk.adv20[i] || 0) * ADV_CAP_PCT); if (advMax > 0) sh = Math.min(sh, advMax);
      if (sh < 1) continue;
      cands.push({ t, fill, stop, sh, trig, adv: tk.adv20[i] || 0 });
    }
    if (entrySort) cands.sort(entrySort);
    for (const c of cands) {
      if (grossAt(markPrev) + c.sh * c.fill > maxGross * curEq) continue;
      const comm = calcCommission(c.sh, c.fill), slip = calcSlippage(c.sh, c.fill); totalComm += comm; totalSlip += slip; realized -= comm + slip;
      positions[c.t] = { sh: c.sh, fill: c.fill, stop: c.stop, entryDate: date }; markPrev[c.t] = c.fill;
    }
    if (beSnap > 0) for (const t of Object.keys(positions)) {
      const tk = T[t]; const i = tk.idxByDate[date]; if (i == null) continue; const bar = tk.bars[i]; const pos = positions[t];
      if (bar.c < bar.o) continue; if ((bar.c - pos.fill) * pos.sh < beSnap) continue; const be = +pos.fill.toFixed(2); if (pos.stop == null || be > pos.stop) pos.stop = be;
    }
    if (marginFinancing && prevDate) { const borrowed = Math.max(0, grossAt(mark) - equityAt(mark)); const interest = calcMarginInterest(borrowed, date, calendarDayGap(prevDate, date)); if (interest > 0) { realized -= interest; totalMarginInterest += interest; } }
    prevDate = date;
    const eq = equityAt(mark); equity.push({ date, eq }); if (eq > peak) peak = eq; const ddf = (eq - peak) / peak; if (ddf < maxDDfrac) maxDDfrac = ddf; if (peak - eq > maxDDdollar) maxDDdollar = peak - eq;
    const eqG = equityGrossAt(mark); equityGross.push({ date, eq: eqG }); if (eqG > peakG) peakG = eqG; const ddfG = (eqG - peakG) / peakG; if (ddfG < maxDDfracG) maxDDfracG = ddfG; if (peakG - eqG > maxDDdollarG) maxDDdollarG = peakG - eqG;
  }
  for (const t of Object.keys(positions)) { const i = T[t].idxByDate[lastDate]; closePos(t, i != null ? T[t].bars[i].c : positions[t].fill, lastDate, 'OPEN_AT_END'); }
  return { equity, closed, maxDDfrac, maxDDdollar, NAV0, lastDate, totalMarginInterest, opemaExits };
}

function metrics(sim) {
  const eq = sim.equity, NAV0 = sim.NAV0;
  const endEq = eq[eq.length - 1].eq, firstDate = eq[0].date;
  const years = (Date.parse(sim.lastDate) - Date.parse(firstDate)) / (365.25 * 86400000);
  const cagr = Math.pow(endEq / NAV0, 1 / years) - 1;
  const rets = []; for (let i = 1; i < eq.length; i++) rets.push((eq[i].eq - eq[i - 1].eq) / Math.max(1, eq[i - 1].eq));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length, sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  const sharpe = sd > 0 ? mean / sd * Math.sqrt(252) : 0, mdd = Math.abs(sim.maxDDfrac) * 100;
  return { retPct: +((endEq / NAV0 - 1) * 100).toFixed(1), cagrPct: +(cagr * 100).toFixed(1), maxDDPct: +mdd.toFixed(1), sharpe: +sharpe.toFixed(2), calmar: mdd > 0 ? +(cagr * 100 / mdd).toFixed(2) : 0, trades: sim.closed.length, endEq: Math.round(endEq) };
}

const OPTS = { nav0: 100000, start: DEFAULT_START, beSnap: BE_SNAP_PROFIT, entrySort: MOST_LIQUID, marginFinancing: true };
const base = simulateTree(data, OPTS);
const off = simulateTreeOverlay(data, OPTS, null);
const gateRaw = await buildExitGate(0);
const gateBand = await buildExitGate(0.01);
const onRaw = simulateTreeOverlay(data, OPTS, gateRaw);
const onBand = simulateTreeOverlay(data, OPTS, gateBand);

const mBase = metrics(base), mOff = metrics(off), mRaw = metrics(onRaw), mBand = metrics(onBand);
console.log('\n==================================================================');
console.log('  (c) TREE + OpEMA-cross EXIT OVERLAY   (AI-300, ' + DEFAULT_START + ' -> ' + END + ', 2x, NET)');
console.log('==================================================================');
const fidelity = mBase.retPct === mOff.retPct && mBase.maxDDPct === mOff.maxDDPct && mBase.trades === mOff.trades;
console.log(`  FIDELITY CHECK (overlay-OFF must equal real simulateTree): ${fidelity ? 'PASS' : 'FAIL'}`);
console.log(`     real simulateTree : ret ${mBase.retPct}%  DD ${mBase.maxDDPct}%  trades ${mBase.trades}`);
console.log(`     my copy overlayOFF: ret ${mOff.retPct}%  DD ${mOff.maxDDPct}%  trades ${mOff.trades}`);
if (!fidelity) { console.log('\n  STOP: copy does not match baseline; delta not trustworthy.'); process.exit(1); }
const row = (label, m, extra = '') => console.log(`  ${label.padEnd(30)} ret ${String(m.retPct).padStart(6)}%  cagr ${String(m.cagrPct).padStart(5)}%  maxDD ${String(m.maxDDPct).padStart(5)}%  Sharpe ${m.sharpe}  Calmar ${m.calmar}  trades ${m.trades}${extra}`);
console.log('\n  ── result ──');
row('Tree BASELINE (locked)', mBase);
row('Tree + OpEMA exit (raw cross)', mRaw, `  (${onRaw.opemaExits} opema exits)`);
row('Tree + OpEMA exit (1% band)', mBand, `  (${onBand.opemaExits} opema exits)`);
console.log('\n  Verdict: overlay helps ONLY if maxDD drops meaningfully without gutting return/Calmar.');
process.exit(0);
