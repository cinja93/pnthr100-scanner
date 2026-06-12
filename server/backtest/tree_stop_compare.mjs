// ── PNTHR TREE — STOP COMPARISON: daily-10-bar vs weekly-2-bar ───────────────
// Runs the EXACT live Tree strategy (pnthrTreeEngine.js) over the AI-300, twice,
// changing ONLY the trailing-stop reference, so we pick the stop on numbers.
//
//   Strategy (matches live):  AI-300 · LONG-only · FULL size (no pyramid) ·
//     enter on a NEW intraday 52wk high (resting buy-stop, fill at worse of level/open) ·
//     size = min(2% NAV / risk-per-share, 10% NAV / price) · gross UNCAPPED (live has no cap) ·
//     no circuit-breaker / regime / manufactured-DD.
//   Stop A (daily10): lowest low of the PRIOR 10 daily bars (excl today) − .01, trails up.
//   Stop B (weekly2): lowest low of the 2 most recent COMPLETED weekly bars (excl this week) − .01, trails up.
//   Executable / no look-ahead: prior bars only; gap-through fills (worse of stop vs open).
//   Costs: commission + slippage every leg (long-only → no borrow).
//
// Run: node --env-file=../.env tree_stop_compare.mjs

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import { connectToDatabase } from '../database.js';
import { calcCommission, calcSlippage } from './costEngine.js';

const NAV0           = 100000;
const VITALITY_PCT   = 0.02;
const TICKER_CAP_PCT = 0.10;
const LOOKBACK_52W   = 252;
const STOP_LOOKBACK  = 10;
const START          = process.env.START || '2023-01-03';   // ~252 bars after 2022-01-03 data start

// Monday-anchored week key (epoch-day of that week's Monday). 1970-01-01 = Thursday.
function weekKeyOf(dateStr) {
  const ed = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 86400000);
  const dow = (((ed + 3) % 7) + 7) % 7;   // Mon=0 .. Sun=6
  return ed - dow;
}

const db = await connectToDatabase();

// ── Load + precompute per-ticker: 52wk high, daily-10 stop, weekly-2 stop, ADV ──
const docs = await db.collection('pnthr_ai_bt_candles').find({}).toArray();
const T = {};
const allDatesSet = new Set();
for (const d of docs) {
  const bars = (d.daily || []).map(b => ({ date: b.date, o: +b.open, h: +b.high, l: +b.low, c: +b.close, v: +b.volume || 0 }))
    .filter(b => b.l > 0 && b.c > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length < LOOKBACK_52W + 5) continue;
  const n = bars.length;
  const hi52 = new Array(n).fill(null), loStop = new Array(n).fill(null), adv20 = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    if (i >= LOOKBACK_52W) { let mh = -Infinity; for (let j = i - LOOKBACK_52W; j < i; j++) if (bars[j].h > mh) mh = bars[j].h; hi52[i] = mh; }
    if (i >= STOP_LOOKBACK) { let sl = Infinity; for (let j = i - STOP_LOOKBACK; j < i; j++) if (bars[j].l < sl) sl = bars[j].l; loStop[i] = sl; }
    if (i >= 20) { let v = 0; for (let j = i - 20; j < i; j++) v += bars[j].v; adv20[i] = v / 20; }
    allDatesSet.add(bars[i].date);
  }

  // weekly bars (Mon-anchored) → weekStop[i] = min low of the 2 completed weeks before bar i's week
  const wk = []; const byKey = new Map();
  for (let i = 0; i < n; i++) {
    const k = weekKeyOf(bars[i].date);
    if (!byKey.has(k)) { const w = { low: bars[i].l, order: wk.length }; byKey.set(k, w); wk.push(w); }
    else { const w = byKey.get(k); if (bars[i].l < w.low) w.low = bars[i].l; }
  }
  const weekStop = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const ord = byKey.get(weekKeyOf(bars[i].date)).order;
    if (ord >= 2) weekStop[i] = Math.min(wk[ord - 1].low, wk[ord - 2].low);
  }

  const idxByDate = {}; bars.forEach((b, i) => { idxByDate[b.date] = i; });
  T[d.ticker] = { bars, idxByDate, hi52, loStop, weekStop, adv20 };
}
const allDates = [...allDatesSet].sort();
const ADV_CAP_PCT = 0.02;

// ── One full simulation for a given stop mode ────────────────────────────────
function runSim(stopMode, maxGross) {
  const positions = {};
  let realized = 0, totalComm = 0, totalSlip = 0;
  const closed = [];           // {ticker, pnl, holdDays}
  const equity = [];
  let peak = NAV0, maxDD = 0;
  let grossSum = 0, grossDays = 0, grossPeak = 0;

  const stopRef = (tk, i) => (stopMode === 'weekly2' ? tk.weekStop[i] : tk.loStop[i]);

  const equityAt = (mark) => {
    let unreal = 0;
    for (const [t, p] of Object.entries(positions)) { const px = mark[t]; if (px == null) continue; unreal += (px - p.fill) * p.sh; }
    return NAV0 + realized + unreal;
  };
  const grossAt = (mark) => { let g = 0; for (const [t, p] of Object.entries(positions)) g += p.sh * (mark[t] ?? p.fill); return g; };

  function closePos(t, exitPx, date) {
    const p = positions[t]; if (!p) return;
    const g = (exitPx - p.fill) * p.sh;
    const comm = calcCommission(p.sh, exitPx), slip = calcSlippage(p.sh, exitPx);
    totalComm += comm; totalSlip += slip;
    const pnl = g - comm - slip; realized += pnl;
    const holdDays = Math.max(1, Math.round((Date.parse(date) - Date.parse(p.entryDate)) / 86400000));
    closed.push({ ticker: t, pnl, holdDays });
    delete positions[t];
  }

  for (const date of allDates) {
    if (date < START) continue;

    // 1. manage: trail stop, then stop-out (gap-through)
    for (const t of Object.keys(positions)) {
      const tk = T[t]; const i = tk.idxByDate[date]; if (i == null) continue;
      const bar = tk.bars[i]; const pos = positions[t];
      const raw = stopRef(tk, i); if (raw != null) { const s = raw - 0.01; pos.stop = pos.stop == null ? s : Math.max(pos.stop, s); }
      if (pos.stop != null && bar.l <= pos.stop) { closePos(t, Math.min(pos.stop, bar.o), date); }
    }

    const mark = {};
    for (const t of Object.keys(positions)) { const i = T[t].idxByDate[date]; if (i != null) mark[t] = T[t].bars[i].c; }
    const curEq = equityAt(mark);

    // 2. entries: every fresh 52wk high we don't hold (FULL size, no pyramid)
    for (const t of Object.keys(T)) {
      if (positions[t]) continue;
      const tk = T[t]; const i = tk.idxByDate[date]; if (i == null || i < LOOKBACK_52W) continue;
      const bar = tk.bars[i];
      if (tk.hi52[i] == null || bar.h < tk.hi52[i] + 0.01) continue;       // no new high
      const sref = stopRef(tk, i); if (sref == null) continue;
      const trig = +(tk.hi52[i] + 0.01).toFixed(2);
      const fill = Math.max(trig, bar.o);                                   // gap-through
      const stop = +(sref - 0.01).toFixed(2);
      const rps = fill - stop; if (rps <= 0.01 || stop >= fill) continue;
      let sh = Math.min(Math.floor((curEq * VITALITY_PCT) / rps), Math.floor((curEq * TICKER_CAP_PCT) / fill));
      const advMax = Math.floor((tk.adv20[i] || 0) * ADV_CAP_PCT); if (advMax > 0) sh = Math.min(sh, advMax);
      if (sh < 1) continue;
      if (grossAt(mark) + sh * fill > maxGross * curEq) continue;          // gross leverage cap
      const comm = calcCommission(sh, fill), slip = calcSlippage(sh, fill);
      totalComm += comm; totalSlip += slip; realized -= comm + slip;
      positions[t] = { sh, fill, stop, entryDate: date };
    }

    // 3. equity / dd / leverage
    const eq = equityAt(mark); equity.push({ date, eq });
    if (eq > peak) peak = eq; const dd = (eq - peak) / peak; if (dd < maxDD) maxDD = dd;
    const g = grossAt(mark); grossSum += g / Math.max(1, eq); grossDays++; if (g / Math.max(1, eq) > grossPeak) grossPeak = g / Math.max(1, eq);
  }
  // close residual at last bar
  const lastDate = allDates[allDates.length - 1];
  for (const t of Object.keys(positions)) { const i = T[t].idxByDate[lastDate]; closePos(t, i != null ? T[t].bars[i].c : positions[t].fill, lastDate); }

  // metrics
  const endEq = equity.length ? equity[equity.length - 1].eq : NAV0;
  const firstDate = equity[0]?.date || START;
  const years = (Date.parse(lastDate) - Date.parse(firstDate)) / (365.25 * 86400000);
  const cagr = Math.pow(endEq / NAV0, 1 / years) - 1;
  const rets = []; for (let i = 1; i < equity.length; i++) rets.push((equity[i].eq - equity[i - 1].eq) / Math.max(1, equity[i - 1].eq));
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  const dsd = Math.sqrt(rets.filter(r => r < 0).reduce((a, b) => a + b * b, 0) / (rets.length || 1));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  const sortino = dsd > 0 ? (mean / dsd) * Math.sqrt(252) : 0;
  const wins = closed.filter(t => t.pnl > 0), losses = closed.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0), grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  const avgWin = wins.length ? grossWin / wins.length : 0, avgLoss = losses.length ? grossLoss / losses.length : 0;
  const uniqueNames = new Set(closed.map(t => t.ticker)).size;
  const avgHold = closed.reduce((a, t) => a + t.holdDays, 0) / (closed.length || 1);

  return {
    stopMode, firstDate, lastDate, years: +years.toFixed(2), endEq: Math.round(endEq),
    totRetPct: +(((endEq - NAV0) / NAV0) * 100).toFixed(1), cagrPct: +(cagr * 100).toFixed(1),
    sharpe: +sharpe.toFixed(2), sortino: +sortino.toFixed(2), maxDDPct: +(Math.abs(maxDD) * 100).toFixed(1),
    calmar: maxDD < 0 ? +(cagr / Math.abs(maxDD)).toFixed(2) : 0,
    pf: pf === Infinity ? 'inf' : +pf.toFixed(2), trades: closed.length, uniqueNames,
    tradesPerName: +(closed.length / (uniqueNames || 1)).toFixed(2),
    winRatePct: +((wins.length / (closed.length || 1)) * 100).toFixed(1),
    payoff: avgLoss > 0 ? +(avgWin / avgLoss).toFixed(2) : 0, avgHoldDays: +avgHold.toFixed(0),
    avgGrossX: +(grossSum / Math.max(1, grossDays)).toFixed(2), peakGrossX: +grossPeak.toFixed(2),
    comm: Math.round(totalComm), slip: Math.round(totalSlip),
  };
}

const CAPS = [
  { label: '1x (no leverage)', g: 1.0 },
  { label: '2x leverage',      g: 2.0 },
  { label: 'UNCAPPED (live as-is)', g: 99 },
];
const metricRows = (d, w) => [
  ['Ending equity ($100k)', '$' + d.endEq.toLocaleString(), '$' + w.endEq.toLocaleString()],
  ['Total return', d.totRetPct + '%', w.totRetPct + '%'],
  ['CAGR', d.cagrPct + '%', w.cagrPct + '%'],
  ['Max drawdown', d.maxDDPct + '%', w.maxDDPct + '%'],
  ['Sharpe', d.sharpe, w.sharpe],
  ['Sortino', d.sortino, w.sortino],
  ['Calmar (CAGR/DD)', d.calmar, w.calmar],
  ['Profit factor', d.pf, w.pf],
  ['Win rate', d.winRatePct + '%', w.winRatePct + '%'],
  ['Payoff', d.payoff + 'x', w.payoff + 'x'],
  ['Total trades (whipsaw)', d.trades.toLocaleString(), w.trades.toLocaleString()],
  ['Trades per name (churn)', d.tradesPerName, w.tradesPerName],
  ['Avg hold (days)', d.avgHoldDays, w.avgHoldDays],
  ['Avg gross leverage', d.avgGrossX + 'x', w.avgGrossX + 'x'],
  ['Peak gross leverage', d.peakGrossX + 'x', w.peakGrossX + 'x'],
];
console.log(`\n  TREE 52WK-HIGH — STOP COMPARISON (net of costs · ${daily0Period()})`);
function daily0Period() { const x = runSim('daily10', 1); return `${x.firstDate}→${x.lastDate} ${x.years}y`; }
for (const c of CAPS) {
  const d = runSim('daily10', c.g), w = runSim('weekly2', c.g);
  const rows = metricRows(d, w);
  const w0 = Math.max(...rows.map(r => r[0].length), 14);
  const w1 = Math.max(...rows.map(r => String(r[1]).length), 14);
  console.log(`\n  ════════ ${c.label} ════════`);
  console.log('  ' + 'METRIC'.padEnd(w0) + '  ' + 'DAILY 10-BAR'.padEnd(w1) + '  WEEKLY 2-BAR');
  console.log('  ' + '-'.repeat(w0 + w1 + 16));
  for (const r of rows) console.log('  ' + r[0].padEnd(w0) + '  ' + String(r[1]).padEnd(w1) + '  ' + r[2]);
}
console.log('\n  (Universe = current AI-300 → SURVIVORSHIP-FLATTERED; hypothetical, not a track record.)\n');
process.exit(0);
