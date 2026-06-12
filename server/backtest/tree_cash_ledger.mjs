// ── PNTHR TREE — CASH LEDGER & MARGIN STRESS TEST ───────────────────────────
// Runs the LOCKED Tree strategy (daily-10 stop, 2× gross cap — matches the live
// engine) but tracks the actual CASH BALANCE and MARGIN every day, to answer:
// does the account ever break? Two break conditions:
//   1. BLOWUP   — equity <= 0 (you owe more than the positions are worth).
//   2. MARGIN CALL — equity / longMV < maintenance margin (forced liquidation).
//      Reg-T maintenance = 25% (lev > 4×). AI/momentum names often carry a higher
//      house requirement, so we also report 30% and 35%.
// Checks both close-of-day AND the intraday worst case (every position at its day low
// simultaneously) — the harshest "did it break at any point" test.
//
// Run: node --env-file=../.env tree_cash_ledger.mjs

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import fs from 'fs';
import { connectToDatabase } from '../database.js';
import { calcCommission, calcSlippage } from './costEngine.js';

const NAV0 = 100000, VITALITY_PCT = 0.02, TICKER_CAP_PCT = 0.10, MAX_GROSS = 2.0;
const LOOKBACK_52W = 252, STOP_LOOKBACK = 10, ADV_CAP_PCT = 0.02;
const START = '2023-01-03';
const MAINT_LEVELS = [0.25, 0.30, 0.35];   // maintenance-margin thresholds to test

const db = await connectToDatabase();
const docs = await db.collection('pnthr_ai_bt_candles').find({}).toArray();
const T = {}; const allDatesSet = new Set();
for (const d of docs) {
  const bars = (d.daily || []).map(b => ({ date: b.date, o: +b.open, h: +b.high, l: +b.low, c: +b.close, v: +b.volume || 0 }))
    .filter(b => b.l > 0 && b.c > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length < LOOKBACK_52W + 5) continue;
  const n = bars.length;
  const hi52 = new Array(n).fill(null), loStop = new Array(n).fill(null), adv20 = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (i >= LOOKBACK_52W) { let mh = -Infinity; for (let j = i - LOOKBACK_52W; j < i; j++) if (bars[j].h > mh) mh = bars[j].h; hi52[i] = mh; }
    if (i >= STOP_LOOKBACK) { let sl = Infinity; for (let j = i - STOP_LOOKBACK; j < i; j++) if (bars[j].l < sl) sl = bars[j].l; loStop[i] = sl; }
    if (i >= 20) { let v = 0; for (let j = i - 20; j < i; j++) v += bars[j].v; adv20[i] = v / 20; }
    allDatesSet.add(bars[i].date);
  }
  const idxByDate = {}; bars.forEach((b, i) => { idxByDate[b.date] = i; });
  T[d.ticker] = { bars, idxByDate, hi52, loStop, adv20 };
}
// COMPLETED SESSIONS ONLY (BACKTEST_EXECUTION_RULES): if the script runs
// intraday, some tickers carry a partial today-bar while most end yesterday —
// positions without a today-bar would be marked at their FILL price, faking a
// crash on the final day. Cap the timeline at the last fully closed session.
const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const allDates = [...allDatesSet].sort().filter(d => d < todayET);

// ── sim with explicit cash ledger ────────────────────────────────────────────
const positions = {};
let cash = NAV0;                  // ← the cash ledger (negative = margin loan)
let realized = 0;
const ledger = [];               // per-day: {date, cash, longMV, equity, lev, equityLow, levLow}
let peakEq = NAV0, maxDD = 0;

const longMVat = (priceOf) => { let mv = 0; for (const [t, p] of Object.entries(positions)) mv += p.sh * priceOf(t); return mv; };
function closePos(t, exitPx, date) {
  const p = positions[t]; if (!p) return;
  const comm = calcCommission(p.sh, exitPx), slip = calcSlippage(p.sh, exitPx);
  cash += p.sh * exitPx - comm - slip;        // sell proceeds back to cash
  realized += (exitPx - p.fill) * p.sh - comm - slip;
  delete positions[t];
}

for (const date of allDates) {
  if (date < START) continue;
  // 1. manage stops (sell → cash in)
  for (const t of Object.keys(positions)) {
    const tk = T[t]; const i = tk.idxByDate[date]; if (i == null) continue;
    const bar = tk.bars[i]; const pos = positions[t];
    if (tk.loStop[i] != null) { const s = tk.loStop[i] - 0.01; pos.stop = pos.stop == null ? s : Math.max(pos.stop, s); }
    if (pos.stop != null && bar.l <= pos.stop) closePos(t, Math.min(pos.stop, bar.o), date);
  }
  const closeOf = (t) => { const i = T[t].idxByDate[date]; return i != null ? T[t].bars[i].c : positions[t].fill; };
  const lowOf = (t) => { const i = T[t].idxByDate[date]; return i != null ? T[t].bars[i].l : positions[t].fill; };
  let equity = cash + longMVat(closeOf);
  let grossNow = longMVat(closeOf);   // existing positions at close; new same-day adds counted at fill (matches the baseline's gross accounting exactly)

  // 2. entries (buy → cash out), gross-capped at 2× equity
  for (const t of Object.keys(T)) {
    if (positions[t]) continue;
    const tk = T[t]; const i = tk.idxByDate[date]; if (i == null || i < LOOKBACK_52W) continue;
    const bar = tk.bars[i];
    if (tk.hi52[i] == null || bar.h < tk.hi52[i] + 0.01 || tk.loStop[i] == null) continue;
    const trig = +(tk.hi52[i] + 0.01).toFixed(2);
    const fill = Math.max(trig, bar.o);
    const stop = +(tk.loStop[i] - 0.01).toFixed(2);
    const rps = fill - stop; if (rps <= 0.01 || stop >= fill) continue;
    let sh = Math.min(Math.floor((equity * VITALITY_PCT) / rps), Math.floor((equity * TICKER_CAP_PCT) / fill));
    const advMax = Math.floor((tk.adv20[i] || 0) * ADV_CAP_PCT); if (advMax > 0) sh = Math.min(sh, advMax);
    if (sh < 1) continue;
    if (grossNow + sh * fill > MAX_GROSS * equity) continue;     // 2× gross cap
    const comm = calcCommission(sh, fill), slip = calcSlippage(sh, fill);
    cash -= sh * fill + comm + slip;          // buy: cash out (goes negative = margin loan)
    realized -= comm + slip;
    positions[t] = { sh, fill, stop };
    grossNow += sh * fill;
  }

  // 3. record the ledger row (close + intraday worst case)
  const longMV = longMVat(closeOf);
  equity = cash + longMV;
  const longMVLow = longMVat(lowOf);
  const equityLow = cash + longMVLow;
  ledger.push({
    date, cash, longMV, equity,
    lev: equity > 0 ? longMV / equity : Infinity,
    equityLow, longMVLow,
    levLow: equityLow > 0 ? longMVLow / equityLow : Infinity,
    posCount: Object.keys(positions).length,
  });
  if (equity > peakEq) peakEq = equity;
  const dd = (equity - peakEq) / peakEq; if (dd < maxDD) maxDD = dd;
}
// close residual
const last = allDates[allDates.length - 1];
for (const t of Object.keys(positions)) { const i = T[t].idxByDate[last]; closePos(t, i != null ? T[t].bars[i].c : positions[t].fill, last); }

// ── analysis ──────────────────────────────────────────────────────────────
const minCash = Math.min(...ledger.map(r => r.cash));
const minEquity = ledger.reduce((m, r) => r.equity < m.equity ? r : m);
const minEquityLow = ledger.reduce((m, r) => r.equityLow < m.equityLow ? r : m);
const maxLev = ledger.reduce((m, r) => r.lev > m.lev ? r : m);
const maxLevLow = ledger.reduce((m, r) => (isFinite(r.levLow) && r.levLow > m.levLow) ? r : m, ledger[0]);
const blowupClose = ledger.filter(r => r.equity <= 0);
const blowupIntraday = ledger.filter(r => r.equityLow <= 0);
const endEq = NAV0 + realized;

const f = n => '$' + Math.round(n).toLocaleString();
console.log('\n  ════════ PNTHR TREE — CASH LEDGER & MARGIN STRESS (daily-10 stop, 2× cap) ════════');
console.log(`  Period: ${ledger[0].date} → ${ledger[ledger.length-1].date}  ·  ${ledger.length} trading days  ·  start ${f(NAV0)}`);
console.log(`  Ending equity: ${f(endEq)}   ·   max equity drawdown: ${(Math.abs(maxDD)*100).toFixed(1)}%`);
console.log('\n  ── CASH LEDGER ──');
console.log(`  Min cash balance (deepest margin loan): ${f(minCash)}  ${minCash < 0 ? '(borrowed ' + f(-minCash) + ')' : '(never on margin)'}`);
console.log(`  Lowest equity (close):    ${f(minEquity.equity)}  on ${minEquity.date}  (lev ${minEquity.lev.toFixed(2)}×)`);
console.log(`  Lowest equity (intraday): ${f(minEquityLow.equityLow)}  on ${minEquityLow.date}  (worst-case all-at-low)`);
console.log('\n  ── LEVERAGE ──');
console.log(`  Peak leverage (close):    ${maxLev.lev.toFixed(2)}×  on ${maxLev.date}  (longMV ${f(maxLev.longMV)} / equity ${f(maxLev.equity)})`);
console.log(`  Peak leverage (intraday): ${maxLevLow.levLow.toFixed(2)}×  on ${maxLevLow.date}  (worst-case)`);
console.log('\n  ── BREAK TESTS ──');
console.log(`  Account BLOWUP (equity <= 0):       close ${blowupClose.length} days · intraday ${blowupIntraday.length} days  ${(blowupClose.length||blowupIntraday.length)?'❌ BREAKS':'✅ never'}`);
for (const m of MAINT_LEVELS) {
  // margin call when equity/longMV < maint  ⇔  leverage > 1/maint
  const callClose = ledger.filter(r => r.longMV > 0 && r.equity / r.longMV < m);
  const callIntra = ledger.filter(r => r.longMVLow > 0 && r.equityLow / r.longMVLow < m);
  console.log(`  MARGIN CALL @ ${(m*100)}% maint (lev > ${(1/m).toFixed(1)}×): close ${callClose.length} days · intraday ${callIntra.length} days  ${(callClose.length||callIntra.length)?'⚠️':'✅ never'}`);
}
console.log('\n  ── worst 8 days by intraday leverage ──');
ledger.slice().filter(r=>isFinite(r.levLow)).sort((a,b)=>b.levLow-a.levLow).slice(0,8).forEach(r =>
  console.log(`     ${r.date}  lev(close) ${r.lev.toFixed(2)}×  lev(intraday) ${r.levLow.toFixed(2)}×  equity ${f(r.equity)}  cash ${f(r.cash)}  longMV ${f(r.longMV)}`));
console.log('\n  (Hypothetical · survivorship-flattered AI-300 · gross-capped 2×. Reg-T maintenance 25% = margin call at 4× leverage.)\n');

// ── weekly results (full backtest, Monday-anchored) ──────────────────────────
// One row per week from the very first trading day: end-of-week equity, weekly
// P&L, the week's worst intraday leverage, deepest margin loan, open positions.
const mondayOf = (iso) => {
  const d = new Date(iso + 'T12:00:00Z');
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
};
const weeklyRaw = [];
let wk = null;
for (const r of ledger) {
  const w = mondayOf(r.date);
  if (!wk || wk.weekOf !== w) {
    if (wk) weeklyRaw.push(wk);
    wk = { weekOf: w, endDate: r.date, endEquity: r.equity, maxLevIntraday: isFinite(r.levLow) ? r.levLow : 0, minCash: r.cash, posCount: r.posCount };
  } else {
    wk.endDate = r.date; wk.endEquity = r.equity; wk.posCount = r.posCount;
    wk.maxLevIntraday = Math.max(wk.maxLevIntraday, isFinite(r.levLow) ? r.levLow : 0);
    wk.minCash = Math.min(wk.minCash, r.cash);
  }
}
if (wk) weeklyRaw.push(wk);
let prevEq = NAV0;
const weekly = weeklyRaw.map(w => {
  const row = {
    weekOf: w.weekOf, endDate: w.endDate,
    equity: Math.round(w.endEquity),
    pnl: Math.round(w.endEquity - prevEq),
    pnlPct: +((w.endEquity / prevEq - 1) * 100).toFixed(1),
    maxLevIntraday: +w.maxLevIntraday.toFixed(2),
    minCash: Math.round(w.minCash),
    posCount: w.posCount,
  };
  prevEq = w.endEquity;
  return row;
});
console.log(`  Weekly results: ${weekly.length} weeks (${weekly[0].weekOf} → ${weekly[weekly.length - 1].weekOf})`);

// ── write the summary the UI panel reads ──────────────────────────────────────
const callDays = (m) => ledger.filter(r => r.longMVLow > 0 && r.equityLow / r.longMVLow < m).length;
const summary = {
  generatedFrom: 'tree_cash_ledger.mjs',
  strategy: 'AI-300 long-only · daily-10 stop · 2% risk / 10% cap · 2× gross cap',
  disclosure: 'Hypothetical · survivorship-flattered AI-300 · gross-capped 2×. Reg-T maintenance 25% → margin call at 4× leverage.',
  period: `${ledger[0].date} → ${ledger[ledger.length - 1].date}`,
  tradingDays: ledger.length,
  startCash: NAV0,
  endingEquity: Math.round(endEq),
  maxDDPct: +(Math.abs(maxDD) * 100).toFixed(1),
  lowestEquity: Math.round(minEquityLow.equityLow),
  lowestEquityDate: minEquityLow.date,
  deepestMarginLoan: Math.round(-minCash),
  peakLevClose: +maxLev.lev.toFixed(2),
  peakLevIntraday: +maxLevLow.levLow.toFixed(2),
  callMaintBreakevenPct: +(100 / maxLevLow.levLow).toFixed(1),   // margin-call only if blended maintenance exceeds this
  breaks: {
    blowupDays: blowupIntraday.length,
    call25Days: callDays(0.25), call30Days: callDays(0.30), call35Days: callDays(0.35),
  },
  worstDays: ledger.slice().filter(r => isFinite(r.levLow)).sort((a, b) => b.levLow - a.levLow).slice(0, 8).map(r => ({
    date: r.date, levClose: +r.lev.toFixed(2), levIntraday: +r.levLow.toFixed(2),
    equity: Math.round(r.equity), cash: Math.round(r.cash), longMV: Math.round(r.longMV),
  })),
  weekly,
};
fs.writeFileSync(new URL('../data/treeCashLedger.json', import.meta.url).pathname, JSON.stringify(summary, null, 1));
console.log('  → wrote server/data/treeCashLedger.json\n');
process.exit(0);
