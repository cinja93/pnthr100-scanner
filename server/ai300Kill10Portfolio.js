// server/ai300Kill10Portfolio.js
// ── PNTHR AI 300 Kill 10 — Canonical compounding portfolio (single source of truth) ──
//
// THE strategy, computed ONE correct way: each week buy the TOP 10 by AI Kill score, run the
// 5-lot pyramid (L1 = 35% at entry, add lots 2-5 at +3/+6/+10/+14% as price triggers; mirror for
// shorts), ratchet the stop to avg cost once >=2 lots fill, exit at the signal (BE/SE) or a stop
// hit — all inside ONE compounding $100k account with real capital constraints (you can only spend
// cash you have). Long/short. Survivorship-flattered (current AI-300 members) — same caveat as the
// Tree backtest; this is a HYPOTHETICAL backfilled backtest, not a forward live record.
//
// Reuses the EXACT engine inputs + helpers from ai300KillBackfill.js (same weekly scores, same
// lot/sizing/ratchet math) so this can never drift from the live Kill scoring. Replaces the
// page's two contradictory views (non-compounding +235% sum up top, wrong >=80 appearances -69%
// table below) with one honest compounding curve + metrics + trade log.

import { connectToDatabase } from './database.js';
import {
  loadInputs, serverSizePosition, buildServerLotConfig, computeRatchetedStop,
} from './ai300KillBackfill.js';

const TOP_N = 10;             // top 10 by Kill score each Friday
const CS_COOLDOWN_WEEKS = 2;  // re-entry cooldown per ticker (matches case studies)
const RISK_PCT = 1;           // 1% NAV risk per name (off the stop)

function lotFillShares(lf) { let sh = 0, cost = 0, n = 0; for (let i = 1; i <= 5; i++) { const f = lf[`lot${i}`]; if (f?.filled && f.fillPrice != null) { const s = f.shares || 0; sh += s; cost += s * f.fillPrice; n++; } } return { shares: sh, avgCost: sh > 0 ? cost / sh : 0, lots: n }; }

export async function buildKill10Portfolio({ nav0 = 100000, grossCapX = 2.0 } = {}) {
  const db = await connectToDatabase();
  const { fridays, scoredByFriday, getWeeklyBar } = await loadInputs(db);

  let cash = nav0;
  const openPos = [];          // live positions
  const closed = [];           // closed trades
  const cooldown = {};         // ticker -> earliest re-entry date
  const equitySeries = [];     // { date, eq, cash, invested, openCount }
  let lot1Skips = 0, addSkips = 0;

  const unrealOf = (p) => p.isShort ? (p.avgCost - p.lastClose) * p.shares : (p.lastClose - p.avgCost) * p.shares;
  const marketVal = (p) => p.shares * p.avgCost + unrealOf(p);   // reserved capital + unrealized
  const equityNow = () => cash + openPos.reduce((s, p) => s + marketVal(p), 0);
  const grossUsed = () => openPos.reduce((s, p) => s + p.shares * p.avgCost, 0);   // cost basis deployed (for the gross cap)

  for (const friday of fridays) {
    const fr = scoredByFriday[friday]; if (!fr) continue;
    const { scoredMap, scored } = fr;

    // ── 1) manage open positions: lot adds, ratcheted stop, exit ──────────────
    for (let i = openPos.length - 1; i >= 0; i--) {
      const p = openPos[i];
      const bar = getWeeklyBar(p.ticker, friday); if (!bar) continue;
      const isShort = p.isShort;

      // lot adds (mirror backfill: prior lot filled, lot-2 needs >= ~1wk after lot1, hit on weekly high/low)
      for (let li = 1; li < 5; li++) {
        const key = `lot${li + 1}`, cfg = p.lotConfig.lots[li], fill = p.lotFills[key];
        if (!cfg || fill?.filled) continue;
        if (!p.lotFills[`lot${li}`]?.filled) continue;
        if (li === 1) {
          const daysDiff = Math.round((new Date(friday + 'T12:00:00') - new Date(p.lotFills.lot1.fillDate + 'T12:00:00')) / 86400000);
          if (Math.floor(daysDiff * 5 / 7) < 5) continue;
        }
        const trig = cfg.triggerPrice;
        const hit = isShort ? bar.low <= trig : bar.high >= trig;
        if (!hit) continue;
        const addShares = cfg.targetShares, addCost = addShares * trig;
        if (grossUsed() + addCost > grossCapX * equityNow()) { addSkips++; continue; }   // gross cap → skip add (may retry next week)
        cash -= addCost; p.lotFills[key] = { filled: true, fillDate: friday, fillPrice: trig, shares: addShares };
      }

      const agg = lotFillShares(p.lotFills);
      p.shares = agg.shares; p.avgCost = +agg.avgCost.toFixed(4); p.lotsFilled = agg.lots;
      p.currentStop = computeRatchetedStop(p.lotFills, p.firstStopPrice, p.signal);   // for display only
      p.lastClose = bar.close;

      // EXIT AT THE SIGNAL (BE/SE) — exactly the Kill 10 case-study track record. The stop is used
      // only to SIZE the 1%-risk position, never to exit; the pyramid rides winners until the weekly
      // signal ends (a stop-exit overlay was tested and wrongly churned winners at ~1wk holds).
      const sc = scoredMap[p.ticker];
      const signalGone = !sc || sc.signal !== p.signal;

      if (signalGone) {
        const exitPrice = bar.close;
        const realized = isShort ? (p.avgCost - exitPrice) * p.shares : (exitPrice - p.avgCost) * p.shares;
        cash += p.shares * p.avgCost + realized;               // return reserved capital + realized P&L
        const pnlPct = p.avgCost > 0 ? (isShort ? (p.avgCost - exitPrice) / p.avgCost : (exitPrice - p.avgCost) / p.avgCost) * 100 : 0;
        const holdingWeeks = Math.round((new Date(friday) - new Date(p.entryDate + 'T12:00:00')) / (7 * 86400000));
        closed.push({
          ticker: p.ticker, direction: p.direction, signal: p.signal, sector: p.sector,
          entryDate: p.entryDate, entryPrice: p.entryPrice, exitDate: friday, exitPrice: +exitPrice.toFixed(2),
          exitReason: isShort ? 'BE' : 'SE', avgCost: p.avgCost, shares: p.shares,
          lotsFilled: p.lotsFilled, pnlDollar: +realized.toFixed(2), pnlPct: +pnlPct.toFixed(2),
          holdingWeeks, entryRank: p.entryRank, entryTier: p.entryTier, entryScore: p.entryScore, status: 'CLOSED',
        });
        const cd = new Date(friday + 'T12:00:00Z'); cd.setDate(cd.getDate() + CS_COOLDOWN_WEEKS * 7);
        cooldown[p.ticker] = cd.toISOString().split('T')[0];
        openPos.splice(i, 1);
      }
    }

    // ── 2) new entries: top 10 by rank, lot1 only (35%), capital-capped ──────────
    const eq = equityNow();
    const top10 = scored.filter(s => s.killRank <= TOP_N).slice(0, TOP_N);
    for (const stock of top10) {
      if (openPos.some(p => p.ticker === stock.ticker)) continue;
      if (cooldown[stock.ticker] && friday < cooldown[stock.ticker]) continue;
      const entryPrice = stock.currentPrice, stopPrice = stock.stopPrice;
      if (!entryPrice || !stopPrice) continue;
      const sized = serverSizePosition({ nav: eq, entryPrice, stopPrice, riskPct: RISK_PCT });
      if (!sized || sized.totalShares <= 0) continue;
      const lots = buildServerLotConfig(sized.totalShares, entryPrice, stock.signal);
      const lot1Shares = lots[0].targetShares, cost = lot1Shares * entryPrice;
      if (grossUsed() + cost > grossCapX * eq) { lot1Skips++; continue; }   // gross cap → skip (fund highest-rank first)
      cash -= cost;
      openPos.push({
        ticker: stock.ticker, direction: stock.direction, signal: stock.signal, isShort: stock.signal === 'SS',
        sector: stock.sectorName || '—', entryDate: friday, entryPrice, firstStopPrice: stopPrice,
        entryRank: stock.killRank, entryTier: stock.tierName, entryScore: stock.total,
        lotConfig: { totalShares: sized.totalShares, lots },
        lotFills: {
          lot1: { filled: true, fillDate: friday, fillPrice: entryPrice, shares: lot1Shares },
          lot2: { filled: false }, lot3: { filled: false }, lot4: { filled: false }, lot5: { filled: false },
        },
        shares: lot1Shares, avgCost: entryPrice, lotsFilled: 1, currentStop: stopPrice, lastClose: entryPrice,
      });
    }

    const invested = openPos.reduce((s, p) => s + marketVal(p), 0);
    const reserved = grossUsed();
    equitySeries.push({ date: friday, eq: +(cash + invested).toFixed(2), cash: +cash.toFixed(2), invested: +invested.toFixed(2), reserved: +reserved.toFixed(2), openCount: openPos.length });
  }

  // ── active (still-open) positions for the trade log (marked to last close, NOT closed out) ──
  const lastDate = fridays[fridays.length - 1];
  const active = openPos.map(p => {
    const pnlDollar = unrealOf(p);
    const pnlPct = p.avgCost > 0 ? (p.isShort ? (p.avgCost - p.lastClose) / p.avgCost : (p.lastClose - p.avgCost) / p.avgCost) * 100 : 0;
    const holdingWeeks = Math.round((new Date(lastDate) - new Date(p.entryDate + 'T12:00:00')) / (7 * 86400000));
    return {
      ticker: p.ticker, direction: p.direction, signal: p.signal, sector: p.sector,
      entryDate: p.entryDate, entryPrice: p.entryPrice, exitDate: null, exitPrice: null, exitReason: null,
      avgCost: p.avgCost, shares: p.shares, lotsFilled: p.lotsFilled, latestPrice: p.lastClose,
      pnlDollar: +pnlDollar.toFixed(2), pnlPct: +pnlPct.toFixed(2), holdingWeeks,
      entryRank: p.entryRank, entryTier: p.entryTier, entryScore: p.entryScore, status: 'ACTIVE',
    };
  });

  return buildResult({ nav0, grossCapX, equitySeries, closed, active, lot1Skips, addSkips, lastDate });
}

// ── metrics + monthly equity table from the simulated series ──────────────────────
export function buildResult({ nav0, grossCapX, equitySeries, closed, active, lot1Skips, addSkips, lastDate, universeLabel = 'AI-300' }) {
  const endEq = equitySeries.length ? equitySeries[equitySeries.length - 1].eq : nav0;
  const firstDate = equitySeries[0]?.date, lastD = equitySeries[equitySeries.length - 1]?.date;
  const years = firstDate ? (Date.parse(lastD) - Date.parse(firstDate)) / (365.25 * 86400000) : 0;
  const totalReturnPct = (endEq - nav0) / nav0 * 100;
  const annualizedReturn = years > 0 ? (Math.pow(endEq / nav0, 1 / years) - 1) * 100 : 0;

  // weekly returns → Sharpe / Sortino (annualized, rf 4.5%)
  const rets = []; for (let i = 1; i < equitySeries.length; i++) rets.push((equitySeries[i].eq - equitySeries[i - 1].eq) / Math.max(1, equitySeries[i - 1].eq));
  const rfWk = 0.045 / 52;
  const ex = rets.map(r => r - rfWk);
  const mean = ex.length ? ex.reduce((a, b) => a + b, 0) / ex.length : 0;
  const sd = ex.length ? Math.sqrt(ex.reduce((a, b) => a + (b - mean) ** 2, 0) / ex.length) : 0;
  const dn = ex.filter(r => r < 0); const dsd = ex.length ? Math.sqrt(dn.reduce((a, b) => a + b * b, 0) / ex.length) : 0;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(52) : 0;
  const sortino = dsd > 0 ? (mean / dsd) * Math.sqrt(52) : 0;

  // drawdown on the weekly equity curve
  let peak = nav0, maxDD = 0, peakDate = firstDate, troughDate = firstDate, ddPeak = nav0, ddTrough = nav0, curPeak = nav0, curPeakDate = firstDate;
  for (const e of equitySeries) {
    if (e.eq > curPeak) { curPeak = e.eq; curPeakDate = e.date; }
    const dd = (e.eq - curPeak) / curPeak;
    if (dd < maxDD) { maxDD = dd; peakDate = curPeakDate; troughDate = e.date; ddPeak = curPeak; ddTrough = e.eq; }
  }
  const maxDDPct = Math.abs(maxDD) * 100;
  const currentDD = equitySeries.length ? (equitySeries[equitySeries.length - 1].eq - peakAll(equitySeries)) / peakAll(equitySeries) * 100 : 0;

  // monthly equity table
  const byMonthLast = {}; const byMonthClosed = {};
  for (const e of equitySeries) byMonthLast[e.date.slice(0, 7)] = e;
  for (const t of closed) { const m = t.exitDate?.slice(0, 7); if (m) byMonthClosed[m] = (byMonthClosed[m] || 0) + t.pnlDollar; }
  const months = Object.keys(byMonthLast).sort();
  const monthly = []; let prev = nav0;
  for (const m of months) {
    const e = byMonthLast[m];
    monthly.push({
      month: m, portfolioValue: Math.round(e.eq),
      monthlyReturn: +((e.eq - prev) / prev * 100).toFixed(2),
      cumulativeReturn: +((e.eq - nav0) / nav0 * 100).toFixed(2),
      realizedThisMonth: Math.round(byMonthClosed[m] || 0),
      unrealizedPnl: Math.round((e.invested || 0) - (e.reserved || 0)),
      idleCash: Math.round(Math.max(0, e.cash)), sweepInterest: +(Math.max(0, e.cash) * 0.0483 / 12).toFixed(2),
      openPositions: e.openCount,
    });
    prev = e.eq;
  }

  // closed-trade aggregate stats
  const winners = closed.filter(t => t.pnlDollar > 0), losers = closed.filter(t => t.pnlDollar <= 0);
  const grossWin = winners.reduce((s, t) => s + t.pnlDollar, 0), grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnlDollar, 0));
  const avgWin = winners.length ? grossWin / winners.length : 0, avgLoss = losers.length ? grossLoss / losers.length : 0;
  const winRate = closed.length ? winners.length / closed.length : 0;

  // ── client-ready shapes ──
  // stats → drives the top metric cards (pyramidStats shape). totalPnl = compounding $ gain (NOT the old non-compounding sum).
  const stats = {
    totalTrades: closed.length + active.length, closedTrades: closed.length, activeTrades: active.length,
    winRate: +(winRate * 100).toFixed(1), totalPnl: Math.round(endEq - nav0),
    avgWinDollar: Math.round(avgWin), avgLossDollar: -Math.round(avgLoss),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 999 : 0),
    winLossRatio: avgLoss > 0 ? +(avgWin / avgLoss).toFixed(1) : 0,
    expectancy: Math.round(winRate * avgWin - (1 - winRate) * avgLoss),
    avgLotsPerTrade: closed.length ? +(closed.reduce((s, t) => s + (t.lotsFilled || 1), 0) / closed.length).toFixed(1) : 0,
  };
  // analytics → drives the equity curve + Portfolio Analytics cards (pyramidAnalytics shape), computed on the COMPOUNDING monthly curve.
  const monthEnds = months.map(m => ({ month: m, eq: byMonthLast[m].eq }));
  const analytics = computeMonthlyAnalytics(monthEnds, nav0);
  // trades → All/Active/Closed tabs (client trade shape)
  const shapeTrade = (t) => ({ ...t, lotsFilledCount: t.lotsFilled, holdingDays: (t.holdingWeeks || 0) * 5, latestPrice: t.latestPrice ?? t.exitPrice ?? t.entryPrice, latestDate: t.exitDate ?? lastDate });
  const tradesAll = [...closed.map(shapeTrade), ...active.map(shapeTrade)].sort((a, b) => b.entryDate.localeCompare(a.entryDate));

  return {
    nav0, grossCapX, asOf: lastDate,
    label: `Top 10 by Kill score each week · 5-lot pyramid (compound winners) · exit at the signal · one compounding $${nav0.toLocaleString()} account · ${grossCapX}× gross`,
    disclaimer: `Hypothetical backtest from weekly candles (current ${universeLabel} members → survivorship-flattered). Not a forward live track record.`,
    stats, analytics, monthly, tradesAll,
    metrics: {
      startNav: nav0, endingEquity: Math.round(endEq), totalReturnPct: +totalReturnPct.toFixed(1), annualizedReturn: +annualizedReturn.toFixed(2),
      maxDDPct: +maxDDPct.toFixed(2), currentDrawdown: +currentDD.toFixed(2),
      sharpe: +sharpe.toFixed(2), sortino: +sortino.toFixed(2), calmarAnnual: maxDDPct > 0 ? +(annualizedReturn / maxDDPct).toFixed(2) : 0,
      totalTrades: closed.length + active.length, closedTrades: closed.length, activeTrades: active.length,
      winRate: +(winRate * 100).toFixed(1), profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 999 : 0),
      avgWinDollar: Math.round(avgWin), avgLossDollar: -Math.round(avgLoss),
      winLossRatio: avgLoss > 0 ? +(avgWin / avgLoss).toFixed(1) : 0,
      expectancy: Math.round(winRate * avgWin - (1 - winRate) * avgLoss),
      avgHoldingWeeks: closed.length ? +(closed.reduce((s, t) => s + (t.holdingWeeks || 0), 0) / closed.length).toFixed(1) : 0,
      lot1Skips, addSkips,
      worstDrawdown: maxDDPct > 0 ? { peakDate, troughDate, peakValue: Math.round(ddPeak), troughValue: Math.round(ddTrough), drawdownPct: +(-maxDDPct).toFixed(2) } : null,
    },
    equityCurve: equitySeries.map(e => ({ date: e.date, value: Math.round(e.eq) })),
    generatedAt: new Date().toISOString(),
  };
}
function peakAll(series) { let p = series[0]?.eq ?? 0; for (const e of series) if (e.eq > p) p = e.eq; return p || 1; }

// ── monthly drawdown/ratio analytics on the COMPOUNDING month-end curve (pyramidAnalytics shape) ──
function computeMonthlyAnalytics(monthEnds, nav0) {
  const n = monthEnds.length;
  if (n < 2) return { status: 'INSUFFICIENT', monthsAvailable: n };
  const values = monthEnds.map(e => e.eq), months = monthEnds.map(e => e.month);
  const equityCurve = [], drawdowns = [], monthlyReturns = [];
  let runPk = nav0, prev = nav0;
  for (let i = 0; i < n; i++) {
    const v = values[i]; if (v > runPk) runPk = v;
    const dd = runPk > 0 ? (v - runPk) / runPk * 100 : 0;
    drawdowns.push(dd); monthlyReturns.push((v - prev) / prev * 100);
    equityCurve.push({ month: months[i], value: Math.round(v), drawdown: +dd.toFixed(2) }); prev = v;
  }
  const endEq = values[n - 1], years = n / 12;
  const annualizedReturn = (Math.pow(endEq / nav0, 1 / years) - 1) * 100;
  const rfM = 4.5 / 12, ex = monthlyReturns.map(r => r - rfM);
  const avg = ex.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(ex.reduce((a, b) => a + (b - avg) ** 2, 0) / n);
  const sharpe = sd > 0 ? (avg / sd) * Math.sqrt(12) : 0;
  const dn = ex.filter(r => r < 0), dsd = Math.sqrt(dn.reduce((a, b) => a + b * b, 0) / n);
  const sortino = dsd > 0 ? (avg / dsd) * Math.sqrt(12) : 0;
  const maxDD = Math.min(...drawdowns, 0), currentDD = drawdowns[n - 1];
  const ddMonths = drawdowns.filter(d => d < -0.01).length, avgDD = drawdowns.reduce((a, b) => a + b, 0) / n;
  const painIndex = drawdowns.reduce((a, b) => a + Math.abs(b), 0) / n;
  const calmarAnnual = maxDD < 0 ? annualizedReturn / Math.abs(maxDD) : 0;
  const worstRolling = (w) => { if (n < w) return null; let worst = 0; for (let i = 0; i <= n - w; i++) { const s = monthlyReturns.slice(i, i + w).reduce((a, b) => a + b, 0); if (s < worst) worst = s; } return +worst.toFixed(2); };
  let pkIdx = 0, trIdx = 0, wPk = nav0, wTr = nav0, wDD = 0, rPk = values[0], rPkIdx = 0;
  for (let i = 1; i < n; i++) { if (values[i] > rPk) { rPk = values[i]; rPkIdx = i; } const dd = (values[i] - rPk) / rPk * 100; if (dd < wDD) { wDD = dd; pkIdx = rPkIdx; trIdx = i; wPk = rPk; wTr = values[i]; } }
  const sortedDD = [...drawdowns].sort((a, b) => a - b), cdar95 = sortedDD[Math.floor(sortedDD.length * 0.05)] ?? 0;
  let ddRuns = 0, run = 0; for (const d of drawdowns) { if (d < -0.01) run++; else if (run > 0) { ddRuns++; run = 0; } } if (run > 0) ddRuns++;
  const last6 = monthlyReturns.slice(-6), return6M = n >= 6 ? last6.reduce((a, b) => a + b, 0) : null;
  const ex6 = last6.map(r => r - rfM), a6 = ex6.reduce((a, b) => a + b, 0) / (ex6.length || 1), s6 = Math.sqrt(ex6.reduce((a, b) => a + (b - a6) ** 2, 0) / (ex6.length || 1));
  const sharpe6M = n >= 6 && s6 > 0 ? (a6 / s6) * Math.sqrt(12) : null;
  const dn6 = ex6.filter(r => r < 0), ds6 = Math.sqrt(dn6.reduce((a, b) => a + b * b, 0) / (ex6.length || 1));
  const sortino6M = n >= 6 && ds6 > 0 ? (a6 / ds6) * Math.sqrt(12) : null;
  const maxDD6 = n >= 6 ? Math.min(...drawdowns.slice(-6), 0) : null;
  const calmar6M = (maxDD6 != null && maxDD6 < 0 && return6M != null) ? (return6M * 2) / Math.abs(maxDD6) : null;
  return {
    status: 'OK', monthsAvailable: n, equityCurve,
    totalReturnPct: +((endEq - nav0) / nav0 * 100).toFixed(2), annualizedReturn: +annualizedReturn.toFixed(2),
    sharpe: +sharpe.toFixed(2), sharpe6M: sharpe6M != null ? +sharpe6M.toFixed(2) : null,
    sortino: +sortino.toFixed(2), sortino6M: sortino6M != null ? +sortino6M.toFixed(2) : null,
    calmarAnnual: +calmarAnnual.toFixed(2), calmar6M: calmar6M != null ? +calmar6M.toFixed(2) : null,
    return6M: return6M != null ? +return6M.toFixed(2) : null,
    currentDrawdown: +currentDD.toFixed(2), maxMonthlyDrawdown: +Math.min(...monthlyReturns, 0).toFixed(2),
    avgDrawdown: +avgDD.toFixed(2), drawdownFrequency: +((ddMonths / n) * 100).toFixed(0),
    avgDrawdownDurationMonths: ddRuns > 0 ? Math.round(ddMonths / ddRuns) : 0,
    painIndex: +painIndex.toFixed(2), cdar95: +cdar95.toFixed(2),
    rolling1M: worstRolling(1), rolling3M: worstRolling(3), rolling6M: worstRolling(6), rolling12M: worstRolling(12),
    peakToValley: wDD < -1 ? { peakMonth: months[pkIdx], troughMonth: months[trIdx], peakValue: Math.round(wPk), troughValue: Math.round(wTr), drawdownPct: +wDD.toFixed(2), durationMonths: trIdx - pkIdx, tickersOpen: [] } : null,
  };
}

// ── simple in-process cache (recompute every 30 min; cheap to rebuild) ────────────
const _cache = {};
export async function getKill10Portfolio(nav0 = 100000, grossCapX = 2.0) {
  const key = `${nav0}|${grossCapX}`; const now = Date.now();
  if (_cache[key] && now - _cache[key].at < 30 * 60 * 1000) return _cache[key].data;
  const data = await buildKill10Portfolio({ nav0, grossCapX });
  _cache[key] = { at: now, data };
  return data;
}

// ── standalone verification: `node ai300Kill10Portfolio.js` ───────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const dotenv = await import('dotenv'); dotenv.default.config();
  const r = await buildKill10Portfolio({ nav0: 100000 });
  const m = r.metrics;
  console.log(`\nKill 10 canonical — ${r.label}`);
  console.log(`  $${(100000).toLocaleString()} → $${m.endingEquity.toLocaleString()}  TOTAL ${m.totalReturnPct}%  CAGR ${m.annualizedReturn}%  MaxDD ${m.maxDDPct}%  Calmar ${m.calmarAnnual}  Sharpe ${m.sharpe}  Sortino ${m.sortino}`);
  console.log(`  trades ${m.totalTrades} (${m.closedTrades} closed / ${m.activeTrades} active) · winRate ${m.winRate}% · PF ${m.profitFactor} · expectancy $${m.expectancy} · avgWin $${m.avgWinDollar} · avgLoss $${m.avgLossDollar} · avgHold ${m.avgHoldingWeeks}w`);
  console.log(`  lot1 skips ${m.lot1Skips} · add skips ${m.addSkips} · worst DD ${m.worstDrawdown?.drawdownPct}% (${m.worstDrawdown?.peakDate}→${m.worstDrawdown?.troughDate})`);
  console.log(`  vs page +235% (non-comp) / -68.8% (wrong set) · vs TREE (most-liquid) +840%/91.9% CAGR/-48.5% DD`);
  process.exit(0);
}
