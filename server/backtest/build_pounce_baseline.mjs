// ── PNTHR POUNCE — BUILD PROJECTION BASELINE ────────────────────────────────
// Runs the LOCKED Pounce strategy through the SAME cost + fee engines as Tree and
// writes server/data/pounceProjectionBaseline.json (identical shape to Tree's
// baseline → the shared AumTracker/ForwardProjection render Pounce's OWN numbers).
//
//   AI-300 · LONG-only · pullback ENTRY: weekly-OpEMA touch (prior wk close > OpEMA,
//   this wk low ≤ OpEMA·1.02) filled next daily open, gated by daily RSI-14 ≥ 50 AND
//   the AI-300 11-week index regime gate · stop = lowest low of prior 10 daily bars − .01,
//   trail up · size = min(2% NAV/risk, 10% NAV/price, 2% ADV) · GROSS ≤ 2× · breakeven snap.
//   Executable / no look-ahead. Costs: commission + slippage every leg + margin financing.
//   SURVIVORSHIP-FLATTERED + BULL-ONLY. RSI≥50 floor validated 2026-07-09 (_pounce_rsi.mjs).
//
// Run: node --env-file=../.env build_pounce_baseline.mjs

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import fs from 'fs';
import { connectToDatabase } from '../database.js';
import { loadTreeData, MOST_LIQUID, VITALITY_PCT, TICKER_CAP_PCT, ADV_CAP_PCT, DEFAULT_START, DEFAULT_END } from './treeSim.js';
import { calcCommission, calcSlippage, calcMarginInterest } from './costEngine.js';
import { applyFeeEngine } from './ai300FeeOverlay.js';
import { calculateEMA } from '../signalDetection.js';
import { SECTORS } from '../scripts/aiUniverse/aiUniverseData.js';
import { SECTOR_EMA_PERIODS } from '../data/pnthrAiSectorsConfig.js';

const NAV0 = 100000, NEAR_BAND = 0.02, BE_SNAP = 250, GATE_N = 11, RSI_FLOOR = 50, RSI_N = 14, MAXG = 2.0;
const START = process.env.START || DEFAULT_START, END = process.env.END || DEFAULT_END;
const TK_PERIOD = {};
for (const s of SECTORS) for (const h of s.holdings) if (TK_PERIOD[h.ticker] == null) TK_PERIOD[h.ticker] = SECTOR_EMA_PERIODS[s.id] || 30;
const weekKey = iso => { const d = new Date(iso + 'T00:00:00Z'); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); };
function ema(v, n) { const k = 2 / (n + 1), o = new Array(v.length).fill(null); let p; for (let i = 0; i < v.length; i++) { if (i < n - 1) continue; if (i === n - 1) { let s = 0; for (let j = 0; j < n; j++) s += v[j]; p = s / n; } else p = v[i] * k + p * (1 - k); o[i] = p; } return o; }
function gateFor(C, O, L, n) { const e = ema(C, n); let st = 'IN'; const r = new Array(C.length); for (let i = 0; i < C.length; i++) { if (st === 'IN') { if (e[i] != null && C[i] < e[i]) st = 'CASH'; } else if (C[i] > O[i]) st = 'IN'; r[i] = st; } return d => { let lo = 0, hi = L.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m] < d) { a = m; lo = m + 1; } else hi = m - 1; } return a < 0 ? true : r[a] === 'IN'; }; }
function armedWeekOfs(wb, period) { if (!wb || wb.length < period + 2) return []; const e = calculateEMA(wb.map(b => ({ time: b.weekOf, close: b.close })), period); const byW = {}; for (const x of e) byW[x.time] = x.value; const out = []; for (let k = 1; k < wb.length; k++) { const c = byW[wb[k].weekOf], cp = byW[wb[k - 1].weekOf]; if (c == null || cp == null) continue; const low = wb[k].low != null ? wb[k].low : wb[k].close; if (wb[k - 1].close > cp && low <= c * (1 + NEAR_BAND)) out.push(wb[k].weekOf); } return out; }
function emaOnlyFills(daily, weekly, period) { const dW = daily.map(b => weekKey(b.date)); const f = new Set(); for (const M of armedWeekOfs(weekly, period)) for (let i = 0; i < daily.length; i++) if (dW[i] > M) { f.add(daily[i].date); break; } return f; }
function wilderRSI(closes, n = RSI_N) { const out = new Array(closes.length).fill(null); if (closes.length < n + 1) return out; let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; } let aG = g / n, aL = l / n; out[n] = aL === 0 ? 100 : 100 - 100 / (1 + aG / aL); for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1], gg = d > 0 ? d : 0, ll = d < 0 ? -d : 0; aG = (aG * (n - 1) + gg) / n; aL = (aL * (n - 1) + ll) / n; out[i] = aL === 0 ? 100 : 100 - 100 / (1 + aG / aL); } return out; }

const db = await connectToDatabase();
const data = await loadTreeData(db, { end: END, universe: 'ai' });
const { T, allDates, spyAt, lastDate } = data;
const wdocs = await db.collection('pnthr_ai_bt_candles_weekly').find({}, { projection: { ticker: 1, weekly: 1 } }).toArray();
const wByT = {}; for (const d of wdocs) wByT[d.ticker] = (d.weekly || []).map(b => ({ weekOf: b.weekOf || b.date, low: +b.low, close: +b.close })).filter(b => b.weekOf && Number.isFinite(b.close) && b.close > 0 && b.weekOf <= END).sort((a, b) => a.weekOf < b.weekOf ? -1 : 1);
const fills = {}; for (const t of Object.keys(T)) { const f = emaOnlyFills(T[t].bars, wByT[t], TK_PERIOD[t] || 30); if (f.size) fills[t] = f; }
const dRSI = {}; for (const t of Object.keys(T)) dRSI[t] = wilderRSI(T[t].bars.map(b => b.c));
const idx = await db.collection('pnthr_ai_index_candles_weekly').findOne({});
const iw = (idx.weekly || []).slice().sort((a, b) => a.weekOf.localeCompare(b.weekOf));
const gate = gateFor(iw.map(w => +w.close), iw.map(w => +w.open), iw.map(w => w.lastDate), GATE_N);

// Pounce sim — mirrors simulateTree's NET/GROSS/margin bookkeeping, only the entry differs.
function simulatePounce() {
  const positions = {};
  let realized = 0, realizedGross = 0, totalComm = 0, totalSlip = 0, totalMarginInterest = 0, prevDate = null;
  const closed = [], equity = [], equityGross = [];
  let peak = NAV0, maxDDfrac = 0, maxDDdollar = 0, peakG = NAV0, maxDDfracG = 0, maxDDdollarG = 0;
  const unreal = m => { let u = 0; for (const [t, p] of Object.entries(positions)) { const px = m[t]; if (px == null) continue; u += (px - p.fill) * p.sh; } return u; };
  const equityAt = m => NAV0 + realized + unreal(m);
  const equityGrossAt = m => NAV0 + realizedGross + unreal(m);
  const grossAt = m => { let g = 0; for (const [t, p] of Object.entries(positions)) g += p.sh * (m[t] ?? p.fill); return g; };
  const closePos = (t, px, date) => {
    const p = positions[t]; if (!p) return;
    const comm = calcCommission(p.sh, px), slip = calcSlippage(p.sh, px), gross = (px - p.fill) * p.sh;
    realizedGross += gross; realized += gross - comm - slip; totalComm += comm; totalSlip += slip;
    const ei = T[t]?.idxByDate[p.entryDate], xi = T[t]?.idxByDate[date];
    closed.push({ ticker: t, pnl: gross - comm - slip, pnlGross: gross, returnPct: p.fill > 0 ? +(((px - p.fill) / p.fill) * 100).toFixed(2) : 0, holdDays: (ei != null && xi != null) ? xi - ei : null });
    delete positions[t];
  };
  for (const date of allDates) {
    if (date < START) continue; if (date > END) break;
    const bear = !gate(date);
    if (bear) for (const t of Object.keys(positions)) { const tk = T[t]; const i = tk ? tk.idxByDate[date] : null; closePos(t, i != null ? tk.bars[i].o : positions[t].fill, date); }
    for (const t of Object.keys(positions)) { const tk = T[t]; const i = tk.idxByDate[date]; if (i == null) continue; const bar = tk.bars[i], p = positions[t]; if (tk.loStop[i] != null) { const s = tk.loStop[i] - 0.01; p.stop = p.stop == null ? s : Math.max(p.stop, s); } if (p.stop != null && bar.l <= p.stop) closePos(t, Math.min(p.stop, bar.o), date); }
    const mark = {}; for (const t of Object.keys(positions)) { const i = T[t].idxByDate[date]; if (i != null) mark[t] = T[t].bars[i].c; }
    const mp = {}; for (const t of Object.keys(positions)) { const i = T[t].idxByDate[date]; if (i == null) continue; mp[t] = i > 0 ? T[t].bars[i - 1].c : positions[t].fill; }
    const cur = equityAt(mp);
    if (!bear) {
      const cands = [];
      for (const t of Object.keys(fills)) {
        if (positions[t] || !fills[t].has(date)) continue;
        const tk = T[t]; if (!tk) continue; const i = tk.idxByDate[date]; if (i == null || tk.loStop[i] == null) continue;
        const rsiEntry = (i > 0 && dRSI[t]) ? dRSI[t][i - 1] : null;
        if (!(rsiEntry != null && rsiEntry >= RSI_FLOOR)) continue;               // RSI floor (validated)
        const fill = tk.bars[i].o, stop = +(tk.loStop[i] - 0.01).toFixed(2), rps = fill - stop;
        if (rps <= 0.01 || stop >= fill) continue;
        let sh = Math.min(Math.floor(cur * VITALITY_PCT / rps), Math.floor(cur * TICKER_CAP_PCT / fill));
        const am = Math.floor((tk.adv20[i] || 0) * ADV_CAP_PCT); if (am > 0) sh = Math.min(sh, am);
        if (sh < 1) continue;
        cands.push({ t, fill, stop, sh, adv: tk.adv20[i] || 0 });
      }
      cands.sort(MOST_LIQUID);
      for (const c of cands) { if (grossAt(mp) + c.sh * c.fill > MAXG * cur) continue; const comm = calcCommission(c.sh, c.fill), slip = calcSlippage(c.sh, c.fill); realized -= comm + slip; totalComm += comm; totalSlip += slip; positions[c.t] = { sh: c.sh, fill: c.fill, stop: c.stop, entryDate: date }; mp[c.t] = c.fill; }
    }
    for (const t of Object.keys(positions)) { const tk = T[t]; const i = tk.idxByDate[date]; if (i == null) continue; const bar = tk.bars[i], p = positions[t]; if (bar.c < bar.o) continue; if ((bar.c - p.fill) * p.sh < BE_SNAP) continue; const be = +p.fill.toFixed(2); if (p.stop == null || be > p.stop) p.stop = be; }
    if (prevDate) { const bor = Math.max(0, grossAt(mark) - equityAt(mark)); const days = Math.max(0, Math.round((Date.parse(date) - Date.parse(prevDate)) / 86400000)); const mi = calcMarginInterest(bor, date, days); if (mi > 0) { realized -= mi; totalMarginInterest += mi; } }
    prevDate = date;
    const eq = equityAt(mark); equity.push({ date, eq });
    if (eq > peak) peak = eq; const ddf = (eq - peak) / peak; if (ddf < maxDDfrac) maxDDfrac = ddf; if (peak - eq > maxDDdollar) maxDDdollar = peak - eq;
    const eqG = equityGrossAt(mark); equityGross.push({ date, eq: eqG });
    if (eqG > peakG) peakG = eqG; const ddfG = (eqG - peakG) / peakG; if (ddfG < maxDDfracG) maxDDfracG = ddfG; if (peakG - eqG > maxDDdollarG) maxDDdollarG = peakG - eqG;
  }
  const lastSeen = equity.length ? equity[equity.length - 1].date : END;
  for (const t of Object.keys(positions)) { const i = T[t].idxByDate[lastSeen]; closePos(t, i != null ? T[t].bars[i].c : positions[t].fill, lastSeen); }
  return { equity, equityGross, closed, maxDDfrac, maxDDdollar, maxDDfracG, maxDDdollarG, totalComm, totalSlip, totalMarginInterest };
}

const sim = simulatePounce();
const { equity, equityGross, closed, maxDDfrac, maxDDdollar, maxDDfracG, maxDDdollarG, totalComm, totalSlip, totalMarginInterest } = sim;

// computeMetrics — VERBATIM from build_tree_baseline.mjs (apples-to-apples with Tree).
function computeMetrics(eqArr, pnlField, mDDfrac, mDDdollar) {
  const endEq = eqArr[eqArr.length - 1].eq, firstDate = eqArr[0].date;
  const years = (Date.parse(lastDate) - Date.parse(firstDate)) / (365.25 * 86400000);
  const cagr = Math.pow(endEq / NAV0, 1 / years) - 1;
  const rets = []; for (let i = 1; i < eqArr.length; i++) rets.push((eqArr[i].eq - eqArr[i - 1].eq) / Math.max(1, eqArr[i - 1].eq));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length, sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  const dsd = Math.sqrt(rets.filter(r => r < 0).reduce((a, b) => a + b * b, 0) / rets.length);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0, sortino = dsd > 0 ? (mean / dsd) * Math.sqrt(252) : 0;
  const wins = closed.filter(t => t[pnlField] > 0), losses = closed.filter(t => t[pnlField] <= 0);
  const grossWin = wins.reduce((a, t) => a + t[pnlField], 0), grossLoss = Math.abs(losses.reduce((a, t) => a + t[pnlField], 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0, avgLoss = losses.length ? grossLoss / losses.length : 0;
  const medOf = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const avgArr = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const winRets = wins.map(t => t.returnPct ?? 0), lossRets = losses.map(t => t.returnPct ?? 0);
  const winHolds = wins.map(t => t.holdDays).filter(h => h != null), lossHolds = losses.map(t => t.holdDays).filter(h => h != null);
  const maxDDPct = Math.abs(mDDfrac) * 100;
  const monthEnd = {}, monthDays = {};
  for (const e of eqArr) { const k = e.date.slice(0, 7); monthEnd[k] = e.eq; (monthDays[k] ||= []).push(e.eq); }
  const months = Object.keys(monthEnd).sort(); let posM = 0, totM = 0, prev = NAV0; const mRets = [];
  for (const m of months) { const r = monthEnd[m] / prev - 1; mRets.push(r * 100); if (r > 0) posM++; totM++; prev = monthEnd[m]; }
  const avgOf = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const ups = mRets.filter(r => r > 0), downs = mRets.filter(r => r < 0);
  const maxMonthlyDD = mRets.length ? Math.min(...mRets) : 0;
  let mPk = -Infinity, worstStretch = 0; for (const m of months) { const v = monthEnd[m]; if (v > mPk) mPk = v; if (mPk > 0) { const d = (v - mPk) / mPk * 100; if (d < worstStretch) worstStretch = d; } }
  const intra = []; for (const m of months) { let pk = -Infinity, dd = 0; for (const v of monthDays[m]) { if (v > pk) pk = v; if (pk > 0) { const d = (v - pk) / pk; if (d < dd) dd = d; } } intra.push(dd * 100); }
  let worstRolling30 = 0;
  for (let i = 0; i < eqArr.length; i++) { let lp = eqArr[i].eq; for (let j = i; j < eqArr.length; j++) { if ((Date.parse(eqArr[j].date) - Date.parse(eqArr[i].date)) / 86400000 > 31) break; if (eqArr[j].eq > lp) lp = eqArr[j].eq; const d = (eqArr[j].eq - lp) / lp * 100; if (d < worstRolling30) worstRolling30 = d; } }
  const spyFirst = spyAt(firstDate, +1), spyLast = spyAt(lastDate, -1), spyRet = (spyFirst && spyLast) ? (spyLast / spyFirst - 1) : 0;
  const alphaDollar = endEq - NAV0 * (1 + spyRet);
  return {
    netReturnPct: +(((endEq - NAV0) / NAV0) * 100).toFixed(1), cagrPct: +(cagr * 100).toFixed(1),
    sharpe: +sharpe.toFixed(2), sortino: +sortino.toFixed(2), profitFactor: +pf.toFixed(2),
    calmar: maxDDPct > 0 ? +((cagr * 100) / maxDDPct).toFixed(2) : 0,
    recoveryFactor: mDDdollar > 0 ? +((endEq - NAV0) / mDDdollar).toFixed(1) : 0,
    positiveMonthsPct: totM > 0 ? +((posM / totM) * 100).toFixed(1) : 0,
    winRatePct: +((wins.length / (closed.length || 1)) * 100).toFixed(0),
    payoff: avgLoss > 0 ? +(avgWin / avgLoss).toFixed(2) : 0,
    maxDDPct: +maxDDPct.toFixed(2), totalClosed: closed.length, endingEquity: Math.round(endEq),
    alphaDollar: Math.round(alphaDollar), alphaPct: +((alphaDollar / NAV0) * 100).toFixed(0), spyReturnPct: +(spyRet * 100).toFixed(1), startNav: NAV0,
    maxMonthlyDDPct: +maxMonthlyDD.toFixed(1), avgDownMonthPct: +avgOf(downs).toFixed(1), avgWithinMonthDipPct: +avgOf(intra).toFixed(1),
    worstRolling30Pct: +worstRolling30.toFixed(1), worstStretchPct: +worstStretch.toFixed(1),
    bestMonthPct: +Math.max(0, ...mRets).toFixed(1), avgUpMonthPct: +avgOf(ups).toFixed(1), avgMonthPct: +avgOf(mRets).toFixed(1),
    winnersN: wins.length, losersN: losses.length,
    avgWinPct: +avgArr(winRets).toFixed(1), avgWinDollar: Math.round(avgWin), winnerHoldDays: +avgArr(winHolds).toFixed(1), winnerHoldMed: medOf(winHolds), largestWinPct: +(winRets.length ? Math.max(...winRets) : 0).toFixed(1),
    avgLossPct: +avgArr(lossRets).toFixed(1), avgLossDollar: -Math.round(avgLoss), loserHoldDays: +avgArr(lossHolds).toFixed(1), loserHoldMed: medOf(lossHolds), largestLossPct: +(lossRets.length ? Math.min(...lossRets) : 0).toFixed(1),
  };
}

const holds = closed.map(c => c.holdDays).filter(h => h != null).sort((a, b) => a - b);
const avgHoldDays = holds.length ? +(holds.reduce((a, b) => a + b, 0) / holds.length).toFixed(1) : null;
const medianHoldDays = holds.length ? holds[Math.floor(holds.length / 2)] : null;
const metrics = computeMetrics(equity, 'pnl', maxDDfrac, maxDDdollar);
const grossMetrics = computeMetrics(equityGross, 'pnlGross', maxDDfracG, maxDDdollarG);
const _filetGross = equity.map(e => ({ date: e.date, equity: +e.eq }));
const { netCurve } = applyFeeEngine(_filetGross, { startingCapital: NAV0, baseRate: 0.30, loyaltyRate: 0.25 });
const _feeEq = netCurve.map(s => ({ date: s.date, eq: +s.netEquity }));
let _fPk = -Infinity, _fMddFrac = 0, _fMddDollar = 0;
for (const p of _feeEq) { if (p.eq > _fPk) _fPk = p.eq; const df = (p.eq - _fPk) / _fPk, dd = p.eq - _fPk; if (df < _fMddFrac) _fMddFrac = df; if (dd < _fMddDollar) _fMddDollar = dd; }
const metricsNetFees = computeMetrics(_feeEq, 'pnl', _fMddFrac, Math.abs(_fMddDollar));
const factors = equity.map((e, i) => ({ i, date: e.date, factor: +(e.eq / NAV0).toFixed(6) }));

const out = {
  generatedFrom: 'build_pounce_baseline.mjs',
  strategy: `AI-300 · LONG-only · pullback to weekly OpEMA (2% band) · daily RSI-14 ≥ 50 · 11W index regime gate · daily-10 trailing stop · 2% risk / 10% cap / 2% ADV · 2× gross cap · MOST-LIQUID buy priority · breakeven snap (+$${BE_SNAP} & green)`,
  disclosure: 'Hypothetical. Universe = current AI-300 members → SURVIVORSHIP-FLATTERED, and the 2023-2026 window is a BULL market only (the AI-300 has no bear-market history). Entry = a pullback to the sector-optimized weekly EMA, confirmed at the weekly close and filled at the next daily open, gated by a daily RSI-14 ≥ 50 momentum floor (skips falling-knife dips; validated 2026-07-09) and the AI-300 11-week index regime gate. Scarce-capital entry priority = most-liquid (deterministic, order-invariant). Costs modeled: commission + slippage every leg, AND margin financing on the borrowed balance of the 2× leverage. Sizing + 2× cap admission use PRIOR-close marks (executable). Breakeven snap modeled on a green-DAY proxy for the live green-HOUR rule (approximate). Backtest FROZEN at 2026-06-11; live PAPER tracking begins 2026-07-09. Not a track record.',
  version: `pounce-${lastDate}`,
  backtestStart: equity[0].date, backtestEnd: lastDate, backtestStartNav: NAV0, backtestEndNav: metrics.endingEquity,
  tradingDays: factors.length, avgHoldDays, medianHoldDays,
  metrics, metricsGross: grossMetrics, metricsNetFees,
  costs: { commission: Math.round(totalComm), slippage: Math.round(totalSlip), marginInterest: Math.round(totalMarginInterest || 0) },
  factors,
};
const outPath = new URL('../data/pounceProjectionBaseline.json', import.meta.url).pathname;
if (process.env.NO_WRITE !== '1') fs.writeFileSync(outPath, JSON.stringify(out, null, 1));

console.log('\n  ════ POUNCE BASELINE WRITTEN ════');
console.log('  ' + outPath);
console.log(`  Period ${equity[0].date}→${lastDate} · ${factors.length} sessions · ${closed.length} trades`);
console.log('  NET (of costs):', JSON.stringify({ ret: metrics.netReturnPct, cagr: metrics.cagrPct, dd: metrics.maxDDPct, sharpe: metrics.sharpe, sortino: metrics.sortino, calmar: metrics.calmar, pf: metrics.profitFactor, win: metrics.winRatePct }));
console.log('  GROSS:', JSON.stringify({ ret: grossMetrics.netReturnPct, cagr: grossMetrics.cagrPct, dd: grossMetrics.maxDDPct, sharpe: grossMetrics.sharpe, calmar: grossMetrics.calmar }));
console.log('  NET after fund fees (Filet):', JSON.stringify({ ret: metricsNetFees.netReturnPct, cagr: metricsNetFees.cagrPct, dd: metricsNetFees.maxDDPct, sharpe: metricsNetFees.sharpe, calmar: metricsNetFees.calmar }));
console.log(`  costs: comm $${Math.round(totalComm).toLocaleString()} · slip $${Math.round(totalSlip).toLocaleString()} · margin $${Math.round(totalMarginInterest).toLocaleString()}`);
process.exit(0);
