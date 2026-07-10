// ── OpEMA cross — POINT-IN-TIME vs SURVIVOR-BIASED (isolates survivorship) ────
// Uses pnthr_sp500_membership (_id: pit_membership): true point-in-time S&P 500
// membership intervals over 2022-10-25 -> 2026-06-07 (566 union names, 63 dropped).
//
//   POINT-IN-TIME : hold a name ONLY while it was actually an index member (enter
//                   only when a member; force-exit on the day it is dropped). Includes
//                   the 63 dropped names during their membership -> NO survivorship.
//   SURVIVOR      : the naive bias I used on the AI-300 -> take only TODAY's members
//                   and backtest them over the whole window as if always tradeable.
//
// OpEMA = GICS-sector period (sectorEmaConfig.js, 18-26W). Long-only, next-open fills,
// no look-ahead. Costs: commission + 5bps slippage/leg. Same viewB engine as the AI run.
// Run: node --env-file=../.env _opema_pit_test.mjs

import { connectToDatabase } from '../database.js';
import { calcCommission, calcSlippage } from './costEngine.js';
import { calculateEMA } from '../signalDetection.js';
import { getSectorEmaPeriod } from '../sectorEmaConfig.js';

const NAV0 = 100000, LOT = 10000;
const db = await connectToDatabase();
const mem = await db.collection('pnthr_sp500_membership').findOne({ _id: 'pit_membership' });
const WIN_START = mem.window.start, WIN_END = mem.window.end;
const M = mem.members; const names = Object.keys(M);
const periodOf = t => getSectorEmaPeriod(M[t].sector);
const memStart = t => M[t].intervals[0].start, memEnd = t => M[t].intervals[M[t].intervals.length - 1].end;
const isCurrent = t => memEnd(t) >= WIN_END;

// candles
const dailyDocs = await db.collection('pnthr_bt_candles').find({ ticker: { $in: names } }, { projection: { ticker: 1, daily: 1 } }).toArray();
const weeklyDocs = await db.collection('pnthr_bt_candles_weekly').find({ ticker: { $in: names } }, { projection: { ticker: 1, weekly: 1 } }).toArray();
const D = {};
for (const doc of dailyDocs) {
  const bars = (doc.daily || []).map(b => ({ date: b.date, o: +b.open, c: +b.close })).filter(b => b.date && b.date <= WIN_END && b.o > 0 && b.c > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length < 30) continue;
  const o = {}, c = {}; for (const b of bars) { o[b.date] = b.o; c[b.date] = b.c; }
  D[doc.ticker] = { dates: bars.map(b => b.date), o, c };
}
const W = {};
for (const doc of weeklyDocs) {
  const wb = (doc.weekly || []).map(b => ({ weekOf: b.weekOf, lastDate: b.lastDate || b.weekOf, close: +b.close })).filter(b => b.weekOf && b.lastDate <= WIN_END && b.close > 0).sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  if (wb.length) W[doc.ticker] = wb;
}
const allDates = [...new Set(Object.values(D).flatMap(d => d.dates))].filter(d => d >= WIN_START && d <= WIN_END).sort();

function fillAfter(t, after) { const dts = D[t]?.dates; if (!dts) return null; let lo = 0, hi = dts.length - 1, a = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (dts[m] > after) { a = dts[m]; hi = m - 1; } else lo = m + 1; } return a; }
function firstOnOrAfter(t, d) { const dts = D[t]?.dates; if (!dts) return null; for (const x of dts) if (x >= d) return x; return null; }

// cross trades (pure) over full history -> {entryFill, exitFill}
function crossTrades(t) {
  const wb = W[t]; if (!wb) return []; const period = periodOf(t); if (wb.length < period + 2) return [];
  const emaArr = calculateEMA(wb.map(b => ({ time: b.weekOf, close: b.close })), period);
  const emaBy = {}; for (const e of emaArr) emaBy[e.time] = e.value;
  const raw = []; let state = 'flat', ew = null;
  for (const b of wb) { const ema = emaBy[b.weekOf]; if (ema == null) continue; if (state === 'flat') { if (b.close > ema) { state = 'long'; ew = b; } } else if (b.close < ema) { state = 'flat'; raw.push({ ew, xw: b }); ew = null; } }
  if (state === 'long') raw.push({ ew, xw: null });
  const out = [];
  for (const tr of raw) { const ef = fillAfter(t, tr.ew.lastDate); if (!ef || ef > WIN_END) continue; let xf = tr.xw ? fillAfter(t, tr.xw.lastDate) : null; if (xf && xf > WIN_END) xf = null; out.push({ ticker: t, entryFill: ef, exitFill: xf }); }
  return out;
}

// gate a trade list to a holding window [gStart,gEnd] per ticker (point-in-time membership)
function gate(trades, gStart, gEnd) {
  const out = [];
  for (const tr of trades) {
    const gs = gStart(tr.ticker), ge = gEnd(tr.ticker);
    if (tr.entryFill < gs || tr.entryFill > ge) continue;          // must ENTER while eligible
    let xf = tr.exitFill;
    // force exit no later than eligibility end (dropped from index -> sell)
    if (!xf || xf > ge) { const f = firstOnOrAfter(tr.ticker, ge); xf = (f && f <= WIN_END) ? f : null; }
    out.push({ ticker: tr.ticker, entryFill: tr.entryFill, exitFill: xf });
  }
  return out;
}

// equal-weight-at-entry portfolio (cash recycled), cappable — same engine as the AI run
function viewB(trades, net, cap = Infinity, dates = allDates) {
  const capPx = (e, p) => cap === Infinity ? p : Math.min(p, e * (1 + cap));
  const eByD = {}, xByD = {};
  trades.forEach((tr, i) => { (eByD[tr.entryFill] ||= []).push(i); if (tr.exitFill) (xByD[tr.exitFill] ||= []).push(i); });
  let cash = NAV0; const pos = {}; const equity = []; let cost = 0;
  for (const date of dates) {
    for (const i of (xByD[date] || [])) { const tr = trades[i]; const p = pos[tr.ticker]; if (!p) continue; const px = capPx(p.entry, D[tr.ticker].o[date] ?? p.entry); let pr = p.sh * px; if (net) { const c = calcCommission(p.sh, px) + calcSlippage(p.sh, px); pr -= c; cost += c; } cash += pr; delete pos[tr.ticker]; }
    const news = (eByD[date] || []).filter(i => !pos[trades[i].ticker] && D[trades[i].ticker].o[date] > 0);
    if (news.length) {
      let eq = cash; for (const t of Object.keys(pos)) eq += pos[t].sh * capPx(pos[t].entry, D[t].c[date] ?? pos[t].entry);
      const budget = Math.min(eq / (Object.keys(pos).length + news.length), cash / news.length);
      for (const i of news) { const t = trades[i].ticker; const px = D[t].o[date]; let sh = Math.floor(budget / px); if (sh < 1) continue; let out = sh * px; if (net) { const c = calcCommission(sh, px) + calcSlippage(sh, px); out += c; cost += c; } if (out > cash) { sh = Math.floor(cash * 0.999 / px); if (sh < 1) continue; } cash -= sh * px + (net ? calcCommission(sh, px) + calcSlippage(sh, px) : 0); pos[t] = { sh, entry: px }; }
    }
    let eq = cash; for (const t of Object.keys(pos)) eq += pos[t].sh * capPx(pos[t].entry, D[t].c[date] ?? pos[t].entry); equity.push({ date, eq });
  }
  return { equity, cost: Math.round(cost) };
}
function metrics(equity) {
  if (equity.length < 2) return null;
  const s = equity[0].eq, e = equity[equity.length - 1].eq;
  const yrs = (Date.parse(equity[equity.length - 1].date) - Date.parse(equity[0].date)) / (365.25 * 86400000);
  let peak = s, mdd = 0; for (const p of equity) { if (p.eq > peak) peak = p.eq; const d = (p.eq - peak) / peak; if (d < mdd) mdd = d; }
  const r = []; for (let i = 1; i < equity.length; i++) r.push(equity[i].eq / equity[i - 1].eq - 1);
  const mean = r.reduce((a, b) => a + b, 0) / r.length, sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length);
  return { retPct: +((e / s - 1) * 100).toFixed(1), cagrPct: +((Math.pow(e / s, 1 / yrs) - 1) * 100).toFixed(1), maxDDPct: +(mdd * 100).toFixed(1), sharpe: +(sd > 0 ? mean / sd * Math.sqrt(252) : 0).toFixed(2) };
}

// buy-hold trade sets (one hold per name, gated the same way)
const bhAll = names.filter(t => D[t]).map(t => ({ ticker: t, entryFill: firstOnOrAfter(t, WIN_START), exitFill: null })).filter(x => x.entryFill);

// build trade sets
const allCross = {}; for (const t of names) if (D[t] && W[t]) allCross[t] = crossTrades(t);
const crossFlat = Object.values(allCross).flat();

// POINT-IN-TIME: gate by real membership interval (all 566, incl 63 dropped)
const pitCross = gate(crossFlat, memStart, memEnd);
const pitBH = gate(bhAll, memStart, memEnd);
// SURVIVOR: only current members, gate only by window (pretend always member)
const survCross = gate(crossFlat.filter(tr => isCurrent(tr.ticker)), () => WIN_START, () => WIN_END);
const survBH = gate(bhAll.filter(tr => isCurrent(tr.ticker)), () => WIN_START, () => WIN_END);

const nCandle = Object.keys(D).length, nDrop = names.filter(t => !isCurrent(t)).length, nDropCandle = names.filter(t => !isCurrent(t) && D[t]).length;
console.log('\n==================================================================');
console.log('  OpEMA CROSS — POINT-IN-TIME vs SURVIVOR-BIASED (S&P 500)');
console.log('==================================================================');
console.log(`  Window ${WIN_START} -> ${WIN_END} | union ${names.length} (candles ${nCandle}) | dropped ${nDrop} (candles ${nDropCandle}) | current ${names.filter(isCurrent).length}`);
console.log('  Pure OpEMA cross, long-only, next-open, GICS OpEMA (18-26W). NET of costs.\n');

function row(label, trades, dates = allDates) {
  const out = [];
  for (const cap of [Infinity, 1.0]) { const m = metrics(viewB(trades, true, cap, dates).equity); out.push(`cap=${cap === Infinity ? 'none' : '+100%'}: ret ${m.retPct}% cagr ${m.cagrPct}% DD ${m.maxDDPct}% shrp ${m.sharpe}`); }
  console.log(`  ${label.padEnd(26)} ${out.join('   |   ')}`);
}
console.log('  ── CROSS strategy ──');
row('POINT-IN-TIME cross', pitCross);
row('SURVIVOR cross', survCross);
console.log('  ── BUY-HOLD benchmark ──');
row('POINT-IN-TIME buy-hold', pitBH);
row('SURVIVOR buy-hold', survBH);
console.log(`\n  trades: PIT ${pitCross.length} vs SURVIVOR ${survCross.length}`);
console.log('  (Point-in-time removes backfill bias. NOTE: only 2/63 dropped names have candles, so the');
console.log('   dropped-name drag is UNDER-counted -> true point-in-time would be even lower. Window is bull-only.)');

// ── LONG-WINDOW downside-protection test (SURVIVOR-biased, spans 2018 Q4 + 2020 COVID + 2022) ──
const LONG_START = '2018-06-01';
const longDates = [...new Set(Object.values(D).flatMap(d => d.dates))].filter(d => d >= LONG_START && d <= WIN_END).sort();
const longCross = gate(crossFlat.filter(tr => isCurrent(tr.ticker)), () => LONG_START, () => WIN_END);
const bhLong = names.filter(t => D[t] && isCurrent(t)).map(t => ({ ticker: t, entryFill: firstOnOrAfter(t, LONG_START), exitFill: null })).filter(x => x.entryFill);
console.log(`\n  ── DOWNSIDE-PROTECTION test: S&P current members ${LONG_START}->${WIN_END} (survivor-biased; incl 2018Q4 + 2020 COVID + 2022) ──`);
row('  cross (trend filter)', longCross, longDates);
row('  buy-hold', bhLong, longDates);
console.log('  (If the cross earns its keep, its edge shows up as SHALLOWER drawdown here, across real downturns.)');
process.exit(0);
