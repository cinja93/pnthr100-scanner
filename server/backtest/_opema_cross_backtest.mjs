// ── PNTHR AI-300 — OpEMA buy/sell signal backtest (Scott's request 2026-07-10) ──
// Tests three LONG-ONLY interpretations of "use the OpEMA as a buy/sell signal":
//   V1 PURE CROSS      : long when weekly close > OpEMA;   flat when weekly close < OpEMA
//   V2 CROSS +1% BAND  : long when weekly close > OpEMA*1.01; flat when < OpEMA*0.99 (hysteresis)
//   V3 APP BL/BE SIGNAL: the exact live signal (detectAllSignals): 2wk-high breakout entry above a
//                        rising OpEMA in the 1%-25% daylight band; exit on the 2wk-low structural stop.
//
// OpEMA = each stock's AI-SECTOR weekly EMA period (pnthrAiSectorsConfig.js: 30W default, 36/36/40),
//   with the app's effectivePeriod() 21W short-history fallback. Verified vs aiUniverseSignalsService.js.
// Universe = CURRENT AI-300 members (aiUniverseData.js) -> SURVIVORSHIP-FLATTERED. Disclosed.
// EXECUTION (all variants, NO LOOK-AHEAD): signal is confirmed at the weekly CLOSE (Friday = lastDate);
//   fill at the NEXT daily OPEN. End-of-window open positions marked at the last close.
// Costs: commission + 5bps slippage per leg (costEngine.js). 1x, long-only -> no margin/borrow.
//
// Run: node --env-file=../.env _opema_cross_backtest.mjs

import { connectToDatabase } from '../database.js';
import { calcCommission, calcSlippage } from './costEngine.js';
import { calculateEMA, detectAllSignals } from '../signalDetection.js';
import { SECTORS } from '../scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from '../data/pnthrAiSectorsConfig.js';

const NAV0 = 100000;
const AI_GATE_OFFSET = 0.25;      // matches aiUniverseSignalsService.js (1.25x first-BL gate)
const END = process.env.END || '2026-06-11';         // frozen last session before Tree go-live
const BULL_START = '2023-01-03';                      // Tree/Pounce comparability sub-window
const LOT = 10000;                                    // per-trade notional for View A (costEngine convention)

// ticker -> AI-sector OpEMA period
const TK_PERIOD = {};
for (const s of SECTORS) for (const h of s.holdings) if (TK_PERIOD[h.ticker] == null) TK_PERIOD[h.ticker] = SECTOR_EMA_PERIODS[s.id] || 30;
const AI_TICKERS = Object.keys(TK_PERIOD);

// effectivePeriod — VERBATIM from aiUniverseSignalsService.js (21W fallback for short history)
function effectivePeriod(barCount, sectorPeriod) {
  if (barCount >= sectorPeriod * 3) return sectorPeriod;
  if (barCount >= 21 + 2) return 21;
  return null;
}

const db = await connectToDatabase();
if (!db) { console.error('no db'); process.exit(1); }

// ── Load candles (daily + weekly) for the AI-300 members ─────────────────────
const dailyDocs = await db.collection('pnthr_ai_bt_candles')
  .find({ ticker: { $in: AI_TICKERS } }, { projection: { ticker: 1, daily: 1 } }).toArray();
const weeklyDocs = await db.collection('pnthr_ai_bt_candles_weekly')
  .find({ ticker: { $in: AI_TICKERS } }, { projection: { ticker: 1, weekly: 1 } }).toArray();

const D = {};   // ticker -> { dates:[asc], o:{date:open}, c:{date:close} }
for (const doc of dailyDocs) {
  const bars = (doc.daily || []).map(b => ({ date: b.date, o: +b.open, c: +b.close }))
    .filter(b => b.date && b.date <= END && b.o > 0 && b.c > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length < 30) continue;
  const o = {}, c = {}; for (const b of bars) { o[b.date] = b.o; c[b.date] = b.c; }
  D[doc.ticker] = { dates: bars.map(b => b.date), o, c };
}
const W = {};   // ticker -> weekly bars asc [{weekOf, lastDate, open, high, low, close}]
for (const doc of weeklyDocs) {
  const wb = (doc.weekly || []).map(b => ({ weekOf: b.weekOf, lastDate: b.lastDate || b.weekOf, open: +b.open, high: +b.high, low: +b.low, close: +b.close }))
    .filter(b => b.weekOf && b.lastDate <= END && b.close > 0)
    .sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  if (wb.length) W[doc.ticker] = wb;
}

// global sorted union of daily trading dates (<= END)
const allDatesSet = new Set();
for (const t of Object.keys(D)) for (const d of D[t].dates) allDatesSet.add(d);
const allDates = [...allDatesSet].sort();
const START = allDates[0];

// first daily date strictly after a given (weekly close) date, for a ticker
function fillAfter(ticker, afterDate) {
  const dts = D[ticker]?.dates; if (!dts) return null;
  // binary search first date > afterDate
  let lo = 0, hi = dts.length - 1, ans = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (dts[m] > afterDate) { ans = dts[m]; hi = m - 1; } else lo = m + 1; }
  return ans;
}

// ── Signal generators → list of trades [{entryFill, exitFill|null}] (daily open fill dates) ──
function crossTrades(ticker, dPct) {
  const wb = W[ticker]; if (!wb) return [];
  const period = effectivePeriod(wb.length, TK_PERIOD[ticker]); if (!period) return [];
  const emaArr = calculateEMA(wb.map(b => ({ time: b.weekOf, close: b.close })), period);
  const emaBy = {}; for (const e of emaArr) emaBy[e.time] = e.value;
  const trades = []; let state = 'flat', entryWk = null;
  for (const b of wb) {
    const ema = emaBy[b.weekOf]; if (ema == null) continue;
    if (state === 'flat') { if (b.close > ema * (1 + dPct)) { state = 'long'; entryWk = b; } }
    else { if (b.close < ema * (1 - dPct)) { state = 'flat'; trades.push({ entryWk, exitWk: b }); entryWk = null; } }
  }
  if (state === 'long') trades.push({ entryWk, exitWk: null });
  return materialize(ticker, trades);
}
function appTrades(ticker) {
  const wb = W[ticker]; if (!wb) return [];
  const period = effectivePeriod(wb.length, TK_PERIOD[ticker]); if (!period) return [];
  const bars = wb.map(b => ({ time: b.weekOf, open: b.open, high: b.high, low: b.low, close: b.close }));
  const { events } = detectAllSignals(bars, period, false, null, AI_GATE_OFFSET);   // isETF=false, 1% daylight, 1.25x gate
  const wkByTime = {}; for (const b of wb) wkByTime[b.weekOf] = b;
  const trades = []; let entryWk = null;
  for (const ev of events) {
    if (!entryWk && ev.signal === 'BL') entryWk = wkByTime[ev.time];
    else if (entryWk && ev.signal === 'BE') { trades.push({ entryWk, exitWk: wkByTime[ev.time] }); entryWk = null; }
    // SS / SE ignored (long-only)
  }
  if (entryWk) trades.push({ entryWk, exitWk: null });
  return materialize(ticker, trades);
}
// weekly-signal trades -> daily open fill dates (next open after the weekly close)
function materialize(ticker, trades) {
  const out = [];
  for (const tr of trades) {
    const entryFill = fillAfter(ticker, tr.entryWk.lastDate);
    if (!entryFill || entryFill > END) continue;                       // no next bar / past window
    let exitFill = tr.exitWk ? fillAfter(ticker, tr.exitWk.lastDate) : null;
    if (exitFill && exitFill > END) exitFill = null;                   // exit falls past window -> hold to end
    out.push({ ticker, entryFill, exitFill });                        // exitFill null => open at END
  }
  return out;
}

// ── VIEW A: per-trade stats ($LOT notional, gross + net via real cost engine) ─
function viewA(trades, winStart) {
  const rows = [];
  for (const tr of trades) {
    if (tr.entryFill < winStart) continue;
    const entry = D[tr.ticker].o[tr.entryFill];
    let exitPx, exitDate;
    if (tr.exitFill) { exitPx = D[tr.ticker].o[tr.exitFill]; exitDate = tr.exitFill; }
    else { const dts = D[tr.ticker].dates; exitDate = dts[dts.length - 1]; exitPx = D[tr.ticker].c[exitDate]; }  // mark to last close
    if (!(entry > 0) || !(exitPx > 0)) continue;
    const sh = Math.max(1, Math.round(LOT / entry));
    const gross = sh * (exitPx - entry);
    const cost = calcCommission(sh, entry) + calcSlippage(sh, entry) + calcCommission(sh, exitPx) + calcSlippage(sh, exitPx);
    const net = gross - cost;
    const di = D[tr.ticker].dates.indexOf(tr.entryFill), xi = D[tr.ticker].dates.indexOf(exitDate);
    rows.push({ grossPct: (exitPx / entry - 1) * 100, netPct: net / (sh * entry) * 100, gross, net, hold: (di >= 0 && xi >= 0) ? xi - di : null, open: !tr.exitFill });
  }
  const n = rows.length;
  if (!n) return { n: 0 };
  const sum = a => a.reduce((x, y) => x + y, 0);
  const winG = rows.filter(r => r.gross > 0), winN = rows.filter(r => r.net > 0);
  const grossWinDollars = sum(winN.map(r => r.net > 0 ? r.net : 0)); // for PF use net
  const netWins = rows.filter(r => r.net > 0), netLoss = rows.filter(r => r.net <= 0);
  const pf = sum(netLoss.map(r => -r.net)) > 0 ? sum(netWins.map(r => r.net)) / sum(netLoss.map(r => -r.net)) : Infinity;
  const holds = rows.map(r => r.hold).filter(h => h != null).sort((a, b) => a - b);
  const med = a => a.length ? a[Math.floor(a.length / 2)] : null;
  return {
    n, winRateGross: +(winG.length / n * 100).toFixed(1), winRateNet: +(winN.length / n * 100).toFixed(1),
    avgGrossPct: +(sum(rows.map(r => r.grossPct)) / n).toFixed(2), avgNetPct: +(sum(rows.map(r => r.netPct)) / n).toFixed(2),
    medGrossPct: +med(rows.map(r => r.grossPct).sort((a, b) => a - b)).toFixed(2),
    totalNet: Math.round(sum(rows.map(r => r.net))), totalGross: Math.round(sum(rows.map(r => r.gross))),
    avgHold: holds.length ? +(sum(holds) / holds.length).toFixed(0) : null, medHold: med(holds),
    pf: pf === Infinity ? 'inf' : +pf.toFixed(2), openTrades: rows.filter(r => r.open).length,
    bestPct: +Math.max(...rows.map(r => r.grossPct)).toFixed(0), worstPct: +Math.min(...rows.map(r => r.grossPct)).toFixed(0),
  };
}

// ── VIEW B: equal-weight-at-entry portfolio, cash recycled, gross + net curve ─
// Enter at open (equal target = equity / post-event long count, cash-capped, order-invariant).
// Hold to signal exit (no rebalance of existing = realistic low turnover). Mark daily at close.
function viewB(trades, net, cap = Infinity) {
  const capPx = (entry, px) => cap === Infinity ? px : Math.min(px, entry * (1 + cap));
  // index trades by fill date
  const entriesByDate = {}, exitsByDate = {};
  for (let i = 0; i < trades.length; i++) {
    const tr = trades[i];
    (entriesByDate[tr.entryFill] ||= []).push(i);
    if (tr.exitFill) (exitsByDate[tr.exitFill] ||= []).push(i);
  }
  let cash = NAV0; const pos = {};   // ticker -> {sh, entry}
  const equity = []; let totalCost = 0, legs = 0;
  const markClose = t => { const d = curDate; return D[t].c[d] ?? pos[t].entry; };
  let curDate;
  const openPx = (t, d) => D[t].o[d];
  for (const date of allDates) {
    curDate = date;
    // 1. exits at open
    for (const i of (exitsByDate[date] || [])) {
      const tr = trades[i]; if (!pos[tr.ticker]) continue;
      const p = pos[tr.ticker]; const px = capPx(p.entry, openPx(tr.ticker, date) ?? p.entry);
      let proceeds = p.sh * px;
      if (net) { const c = calcCommission(p.sh, px) + calcSlippage(p.sh, px); proceeds -= c; totalCost += c; legs++; }
      cash += proceeds; delete pos[tr.ticker];
    }
    // 2. entries at open (equal target off current equity, cash-split capped)
    const news = (entriesByDate[date] || []).filter(i => !pos[trades[i].ticker] && openPx(trades[i].ticker, date) > 0);
    if (news.length) {
      let eqNow = cash; for (const t of Object.keys(pos)) eqNow += pos[t].sh * capPx(pos[t].entry, D[t].c[date] ?? D[t].o[date] ?? pos[t].entry);
      const targetEach = eqNow / (Object.keys(pos).length + news.length);
      const capEach = cash / news.length;         // never spend more cash than available, split equally (order-invariant)
      const budget = Math.min(targetEach, capEach);
      for (const i of news) {
        const t = trades[i].ticker; const px = openPx(t, date);
        let sh = Math.floor(budget / px); if (sh < 1) continue;
        let outlay = sh * px;
        if (net) { const c = calcCommission(sh, px) + calcSlippage(sh, px); outlay += c; totalCost += c; legs++; }
        if (outlay > cash) { sh = Math.floor((cash * 0.999) / px); if (sh < 1) continue; outlay = sh * px; if (net) { const c = calcCommission(sh, px) + calcSlippage(sh, px); outlay += c; totalCost += c; } }
        cash -= outlay; pos[t] = { sh, entry: px };
      }
    }
    // 3. mark to close
    let eq = cash; for (const t of Object.keys(pos)) eq += pos[t].sh * capPx(pos[t].entry, D[t].c[date] ?? pos[t].entry);
    equity.push({ date, eq });
  }
  return { equity, totalCost: Math.round(totalCost), legs };
}

// metrics off a daily equity curve, sub-windowed from >= winStart
function metrics(equity, winStart) {
  const eq = equity.filter(e => e.date >= winStart);
  if (eq.length < 2) return null;
  const start = eq[0].eq, end = eq[eq.length - 1].eq;
  const years = (Date.parse(eq[eq.length - 1].date) - Date.parse(eq[0].date)) / (365.25 * 86400000);
  const cagr = years > 0 ? (Math.pow(end / start, 1 / years) - 1) : 0;
  let peak = start, mdd = 0; for (const e of eq) { if (e.eq > peak) peak = e.eq; const d = (e.eq - peak) / peak; if (d < mdd) mdd = d; }
  const rets = []; for (let i = 1; i < eq.length; i++) rets.push(eq[i].eq / eq[i - 1].eq - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  return { start: Math.round(start), end: Math.round(end), retPct: +((end / start - 1) * 100).toFixed(1), cagrPct: +(cagr * 100).toFixed(1), maxDDPct: +(mdd * 100).toFixed(1), sharpe: +sharpe.toFixed(2), days: eq.length };
}

// ── Benchmarks: SPY buy-hold + AI-300 equal-weight buy-hold ──────────────────
async function spyCurve() {
  const spy = {};
  for (const coll of ['pnthr_bt_candles', 'pnthr_candle_cache']) {
    const d = await db.collection(coll).findOne({ ticker: 'SPY' });
    if (d) for (const b of (d.daily || d.candles || [])) if (+b.close > 0 && b.date <= END) spy[b.date] = +b.close;
  }
  return allDates.filter(d => spy[d]).map(d => ({ date: d, eq: spy[d] }));
}
function universeEWCurve() {
  // equal-weight daily-return index of every AI-300 name with data that day (buy-hold the universe)
  const curve = []; let idx = 1000;
  for (let k = 0; k < allDates.length; k++) {
    const d = allDates[k];
    if (k > 0) {
      const pd = allDates[k - 1]; const rs = [];
      for (const t of Object.keys(D)) { const c0 = D[t].c[pd], c1 = D[t].c[d]; if (c0 > 0 && c1 > 0) rs.push(c1 / c0 - 1); }
      if (rs.length) idx *= (1 + rs.reduce((a, b) => a + b, 0) / rs.length);
    }
    curve.push({ date: d, eq: idx });
  }
  return curve;
}

// ── RUN all three variants ───────────────────────────────────────────────────
const V = {
  'V1 PURE CROSS':     AI_TICKERS.flatMap(t => crossTrades(t, 0)),
  'V2 CROSS +1% BAND': AI_TICKERS.flatMap(t => crossTrades(t, 0.01)),
  'V3 APP BL/BE':      AI_TICKERS.flatMap(t => appTrades(t)),
};

const namesWithSignal = new Set();
for (const t of AI_TICKERS) { const wb = W[t]; if (wb && effectivePeriod(wb.length, TK_PERIOD[t])) namesWithSignal.add(t); }

console.log('\n========================================================================');
console.log('  PNTHR AI-300 — OpEMA BUY/SELL BACKTEST  (long-only, next-open fills)');
console.log('========================================================================');
console.log(`  Universe: ${AI_TICKERS.length} AI-300 members | with price data: ${Object.keys(D).length} | eligible for a weekly signal: ${namesWithSignal.size}`);
console.log(`  Data window: ${START} -> ${END}  (SURVIVORSHIP-FLATTERED; current members only)`);
console.log(`  OpEMA = AI-sector period (30/36/40W) w/ 21W short-history fallback | 1% weekly daylight | 1.25x gate (V3)`);

const spy = await spyCurve(), uni = universeEWCurve();

for (const [label, trades] of Object.entries(V)) {
  console.log(`\n──────── ${label} ─────────────────────────────────────────────`);
  console.log(`  trades (full ${START.slice(0,4)}+): ${trades.length}`);
  for (const [wlabel, ws] of [['FULL '+START.slice(0,7)+'->'+END, START], ['BULL '+BULL_START+'->'+END, BULL_START]]) {
    const a = viewA(trades, ws);
    if (!a.n) { console.log(`  [${wlabel}] no trades`); continue; }
    const bG = viewB(trades, false), bN = viewB(trades, true);
    const mG = metrics(bG.equity, ws), mN = metrics(bN.equity, ws);
    console.log(`  [${wlabel}]`);
    console.log(`    View A (per-trade, $${LOT/1000}k each): trades=${a.n} winRate net=${a.winRateNet}% gross=${a.winRateGross}% | avgTrade net=${a.avgNetPct}% gross=${a.avgGrossPct}% | med=${a.medGrossPct}% | avgHold=${a.avgHold}d medHold=${a.medHold}d | PF(net)=${a.pf} | best=${a.bestPct}% worst=${a.worstPct}% | openAtEnd=${a.openTrades}`);
    console.log(`    View B (EW portfolio):  GROSS ret=${mG.retPct}% cagr=${mG.cagrPct}% maxDD=${mG.maxDDPct}% sharpe=${mG.sharpe}  |  NET ret=${mN.retPct}% cagr=${mN.cagrPct}% maxDD=${mN.maxDDPct}% sharpe=${mN.sharpe}  (cost $${bN.totalCost.toLocaleString()}, ${bN.legs} legs)`);
  }
}

// benchmarks per window
console.log(`\n──────── BENCHMARKS ──────────────────────────────────────────`);
for (const [wlabel, ws] of [['FULL '+START.slice(0,7)+'->'+END, START], ['BULL '+BULL_START+'->'+END, BULL_START]]) {
  const ms = metrics(spy, ws), mu = metrics(uni, ws);
  console.log(`  [${wlabel}]`);
  console.log(`    SPY buy-hold:            ret=${ms.retPct}% cagr=${ms.cagrPct}% maxDD=${ms.maxDDPct}% sharpe=${ms.sharpe}`);
  console.log(`    AI-300 EW buy-hold:      ret=${mu.retPct}% cagr=${mu.cagrPct}% maxDD=${mu.maxDDPct}% sharpe=${mu.sharpe}`);
}
console.log('\n  (Hypothetical. Survivorship-flattered. Next-open executable, no look-ahead. Not a track record.)');

if (process.env.DIAG) {
  console.log('\n\n================ DIAGNOSTIC (robustness) ================');
  for (const [label, trades] of Object.entries(V)) {
    const rows = [];
    for (const tr of trades) {
      const entry = D[tr.ticker].o[tr.entryFill]; if (!(entry > 0)) continue;
      let exitPx, exitDate;
      if (tr.exitFill) { exitPx = D[tr.ticker].o[tr.exitFill]; exitDate = tr.exitFill; }
      else { const dts = D[tr.ticker].dates; exitDate = dts[dts.length - 1]; exitPx = D[tr.ticker].c[exitDate]; }
      if (!(exitPx > 0)) continue;
      rows.push({ t: tr.ticker, entryFill: tr.entryFill, entry, exitDate, exitPx, pct: (exitPx / entry - 1) * 100 });
    }
    rows.sort((a, b) => b.pct - a.pct);
    console.log(`\n── ${label}: top 8 trades by return ──`);
    for (const r of rows.slice(0, 8)) console.log(`   ${r.t.padEnd(6)} ${r.entryFill} @${r.entry.toFixed(2)} -> ${r.exitDate} @${r.exitPx.toFixed(2)}  = ${r.pct.toFixed(0)}%`);
    // distribution
    const b = { '>500': 0, '100..500': 0, '50..100': 0, '20..50': 0, '0..20': 0, '-20..0': 0, '-50..-20': 0, '<-50': 0 };
    for (const r of rows) { const p = r.pct; if (p > 500) b['>500']++; else if (p > 100) b['100..500']++; else if (p > 50) b['50..100']++; else if (p > 20) b['20..50']++; else if (p > 0) b['0..20']++; else if (p > -20) b['-20..0']++; else if (p > -50) b['-50..-20']++; else b['<-50']++; }
    console.log(`   distribution: ${JSON.stringify(b)}`);
    // outlier price verification against raw daily doc
    const top = rows[0];
    const raw = await db.collection('pnthr_ai_bt_candles').findOne({ ticker: top.t }, { projection: { daily: 1 } });
    const rd = (raw?.daily || []).filter(x => x.date >= top.entryFill && x.date <= top.exitDate).map(x => +x.close).filter(x => x > 0);
    console.log(`   outlier ${top.t}: raw daily closes ${top.entryFill}->${top.exitDate}: min=${Math.min(...rd).toFixed(2)} max=${Math.max(...rd).toFixed(2)} bars=${rd.length} (entry ${top.entry.toFixed(2)} exit ${top.exitPx.toFixed(2)})`);
  }
  // View B robustness: cap any single trade's contribution -> tests moonshot dependence.
  console.log('\n── View B WINSORIZED (cap any one trade at +CAP%): does the edge survive without the moonshots? ──');
  for (const [label, trades] of Object.entries(V)) {
    const line = [];
    for (const cap of [Infinity, 3.0, 1.0, 0.5]) {
      const b = viewB(trades, true, cap);
      const m = metrics(b.equity, START), mb = metrics(b.equity, BULL_START);
      line.push(`cap=${cap === Infinity ? 'none' : '+' + cap * 100 + '%'}: FULL ${m.retPct}%/${m.cagrPct}%cagr  BULL ${mb.retPct}%/${mb.cagrPct}%cagr`);
    }
    console.log(`   ${label}:`);
    for (const l of line) console.log(`      ${l}`);
  }
  // FAIR benchmark: buy-hold run through the IDENTICAL portfolio engine (viewB), capped the SAME way.
  // Every name enters at its first bar >= START and is held to END -> EW buy-hold, apples-to-apples.
  console.log('\n── FAIR compare: AI-300 EW buy-hold through the SAME engine, SAME winner cap ──');
  const bhTrades = Object.keys(D).map(t => ({ ticker: t, entryFill: D[t].dates.find(d => d >= START), exitFill: null })).filter(x => x.entryFill);
  for (const cap of [Infinity, 3.0, 1.0, 0.5]) {
    const b = viewB(bhTrades, true, cap);
    const m = metrics(b.equity, START), mb = metrics(b.equity, BULL_START);
    console.log(`   BUY-HOLD cap=${cap === Infinity ? 'none' : '+' + cap * 100 + '%'}: FULL ${m.retPct}%/${m.cagrPct}%cagr/${m.maxDDPct}%DD  BULL ${mb.retPct}%/${mb.cagrPct}%cagr/${mb.maxDDPct}%DD`);
  }

  // Split/data-artifact scan: biggest 1-day jumps on the top outlier names
  console.log('\n── Split-artifact scan: largest single-day move on outlier names (>60% = suspect) ──');
  for (const t of ['SNDK', 'MU', 'WDC', 'LITE', 'BE', 'PLTR']) {
    const raw = await db.collection('pnthr_ai_bt_candles').findOne({ ticker: t }, { projection: { daily: 1 } });
    const bars = (raw?.daily || []).filter(b => b.date <= END && +b.close > 0).sort((a, b) => a.date.localeCompare(b.date));
    let maxJump = 0, jd = null, jf = null, jt = null;
    for (let i = 1; i < bars.length; i++) { const r = +bars[i].close / +bars[i - 1].close - 1; if (Math.abs(r) > Math.abs(maxJump)) { maxJump = r; jd = bars[i].date; jf = +bars[i - 1].close; jt = +bars[i].close; } }
    const first = bars[0], last = bars[bars.length - 1];
    console.log(`   ${t.padEnd(6)} ${first?.date} $${(+first?.close).toFixed(2)} -> ${last?.date} $${(+last?.close).toFixed(2)}  | biggest 1-day: ${(maxJump * 100).toFixed(0)}% on ${jd} ($${jf?.toFixed(2)}->$${jt?.toFixed(2)})`);
  }
}

if (process.env.DIAG2) {
  console.log('\n\n================ V3 RE-ENTRY / REPURCHASE VERIFICATION ================');
  const v3 = V['V3 APP BL/BE'];
  const perTicker = {}; for (const tr of v3) perTicker[tr.ticker] = (perTicker[tr.ticker] || 0) + 1;
  const counts = Object.values(perTicker); const dist = {};
  for (const c of counts) { const k = c >= 8 ? '8+' : String(c); dist[k] = (dist[k] || 0) + 1; }
  const totalBL = AI_TICKERS.reduce((n, t) => { const wb = W[t]; if (!wb) return n; const p = effectivePeriod(wb.length, TK_PERIOD[t]); if (!p) return n; const { events } = detectAllSignals(wb.map(b => ({ time: b.weekOf, open: b.open, high: b.high, low: b.low, close: b.close })), p, false, null, AI_GATE_OFFSET); return n + events.filter(e => e.signal === 'BL').length; }, 0);
  console.log(`  V3 total BL events across universe: ${totalBL} | V3 trades captured: ${v3.length} (open-at-end kept) | tickers traded: ${counts.length}`);
  console.log(`  trades-per-ticker distribution: ${JSON.stringify(dist)}  (many tickers with 2..8+ => re-purchase IS happening)`);
  console.log(`  max trades on one ticker: ${Math.max(...counts)}`);
  for (const t of ['SNDK', 'NVDA', 'PLTR', 'MU', 'AVGO']) {
    const wb = W[t]; if (!wb) { console.log(`\n  ${t}: no weekly data`); continue; }
    const period = effectivePeriod(wb.length, TK_PERIOD[t]);
    const { events } = detectAllSignals(wb.map(b => ({ time: b.weekOf, open: b.open, high: b.high, low: b.low, close: b.close })), period, false, null, AI_GATE_OFFSET);
    console.log(`\n  ── ${t} (OpEMA ${period}W) — ${events.filter(e => e.signal === 'BL').length} BL / ${events.filter(e => e.signal === 'BE').length} BE events ──`);
    console.log(`     event stream: ${events.map(e => `${e.signal}@${e.time}`).join('  ')}`);
    const trades = appTrades(t);
    console.log(`     V3 trades (${trades.length}), each entry->exit with return:`);
    for (const tr of trades) {
      const e = D[t].o[tr.entryFill]; const xd = tr.exitFill || D[t].dates[D[t].dates.length - 1]; const x = tr.exitFill ? D[t].o[tr.exitFill] : D[t].c[xd];
      console.log(`        ${tr.entryFill} @$${e?.toFixed(2)}  ->  ${tr.exitFill || 'END'} @$${x?.toFixed(2)}  = ${((x / e - 1) * 100).toFixed(0)}%`);
    }
  }
}
process.exit(0);
