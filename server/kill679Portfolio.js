// server/kill679Portfolio.js
// ── PNTHR Kill 10 (679 Carnivore) — canonical compounding portfolio ──────────────
//
// Mirrors ai300Kill10Portfolio.js for the 679 universe: top 10 by Kill score each week,
// 5-lot pyramid (compound winners), exit AT THE SIGNAL, one compounding $100k account.
//
// The 679 Kill has NO deterministic backfill engine (unlike AI-300), so there is no per-Friday
// scoring replay to reconstruct entries from. Instead we drive the sim off the engine's OWN recorded
// top-10 trades (pnthr_kill_case_studies: ticker/dir/entry/stop/EXIT already determined by the live
// Friday pipeline's signal-exit logic) and reconstruct only the pyramid lot fills from the 679 weekly
// candles (pnthr_bt_candles_weekly). Recorded entry + recorded signal exit + pyramid sizing +
// compounding. NOTE: 679 case studies currently cover ~2026-01 onward only (no historical backfill);
// a full multi-year 679 track record would require replaying the apexService D1–D8 scoring.
// Reuses buildResult (output shaping/metrics) + the lot helpers from the AI-300 modules. NO WRITES.

import { connectToDatabase } from './database.js';
import { serverSizePosition, buildServerLotConfig, computeRatchetedStop, KILL10_STRIKE_PCT } from './ai300KillBackfill.js';
import { buildResult } from './ai300Kill10Portfolio.js';

const TOP_N = 10, RISK_PCT = 1;
const CASE_STUDIES = 'pnthr_kill_case_studies';
const WEEKLY = 'pnthr_bt_candles_weekly';

function lotFillShares(lf) { let sh = 0, cost = 0, n = 0; for (let i = 1; i <= 5; i++) { const f = lf[`lot${i}`]; if (f?.filled && f.fillPrice != null) { const s = f.shares || 0; sh += s; cost += s * f.fillPrice; n++; } } return { shares: sh, avgCost: sh > 0 ? cost / sh : 0, lots: n }; }

export async function buildKill679Portfolio({ nav0 = 100000, grossCapX = 2.0 } = {}) {
  const db = await connectToDatabase();
  const cs = await db.collection(CASE_STUDIES).find({}).sort({ entryDate: 1 }).toArray();
  if (!cs.length) return buildResult({ nav0, grossCapX, equitySeries: [{ date: '—', eq: nav0, cash: nav0, invested: 0, reserved: 0, openCount: 0 }], closed: [], active: [], lot1Skips: 0, addSkips: 0, lastDate: '—', universeLabel: 'Carnivore 679' });

  // weekly OHLC for every case-study ticker
  const tickers = [...new Set(cs.map(s => s.ticker))];
  const wdocs = await db.collection(WEEKLY).find({ ticker: { $in: tickers } }, { projection: { ticker: 1, weekly: 1 } }).toArray();
  const wkByTicker = {};
  for (const d of wdocs) wkByTicker[d.ticker] = [...(d.weekly || [])].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  const getWeeklyBar = (t, date) => { const wk = wkByTicker[t]; if (!wk) return null; for (let i = wk.length - 1; i >= 0; i--) if (wk[i].weekOf <= date) return wk[i]; return null; };

  // timeline: every weekOf across the case-study tickers within the study window, plus entry/exit dates
  const entryDates = cs.map(s => s.entryDate).filter(Boolean);
  const minDate = entryDates.sort()[0];
  const maxDate = cs.map(s => s.exitDate || '9999').concat(cs.map(s => s.entryDate)).filter(d => d && d !== '9999').sort().slice(-1)[0];
  const dateSet = new Set();
  for (const t of tickers) for (const b of (wkByTicker[t] || [])) if (b.weekOf >= minDate && b.weekOf <= maxDate) dateSet.add(b.weekOf);
  for (const s of cs) { if (s.entryDate) dateSet.add(s.entryDate); if (s.exitDate) dateSet.add(s.exitDate); }
  const timeline = [...dateSet].sort();
  const lastDate = timeline[timeline.length - 1];
  const byEntry = {}; for (const s of cs) (byEntry[s.entryDate] ||= []).push(s);

  let cash = nav0; const openPos = []; const closed = []; const equitySeries = [];
  let lot1Skips = 0, addSkips = 0;
  const isLong = (p) => p.signal !== 'SS';
  const unrealOf = (p) => isLong(p) ? (p.lastClose - p.avgCost) * p.shares : (p.avgCost - p.lastClose) * p.shares;
  const marketVal = (p) => p.shares * p.avgCost + unrealOf(p);
  const equityNow = () => cash + openPos.reduce((s, p) => s + marketVal(p), 0);
  const grossUsed = () => openPos.reduce((s, p) => s + p.shares * p.avgCost, 0);

  for (const date of timeline) {
    // 1) manage open positions: pyramid lot adds, then RECORDED signal exit
    for (let i = openPos.length - 1; i >= 0; i--) {
      const p = openPos[i];
      const bar = getWeeklyBar(p.ticker, date); if (!bar) continue;
      const short = p.signal === 'SS';
      for (let li = 1; li < 5; li++) {
        const key = `lot${li + 1}`, cfg = p.lotConfig.lots[li], fill = p.lotFills[key];
        if (!cfg || fill?.filled) continue;
        if (!p.lotFills[`lot${li}`]?.filled) continue;
        if (li === 1) {
          const daysDiff = Math.round((new Date(date + 'T12:00:00') - new Date(p.lotFills.lot1.fillDate + 'T12:00:00')) / 86400000);
          if (Math.floor(daysDiff * 5 / 7) < 5) continue;
        }
        const trig = cfg.triggerPrice, hit = short ? bar.low <= trig : bar.high >= trig;
        if (!hit) continue;
        const addShares = cfg.targetShares, addCost = addShares * trig;
        if (grossUsed() + addCost > grossCapX * equityNow()) { addSkips++; continue; }
        cash -= addCost; p.lotFills[key] = { filled: true, fillDate: date, fillPrice: trig, shares: addShares };
      }
      const agg = lotFillShares(p.lotFills);
      p.shares = agg.shares; p.avgCost = +agg.avgCost.toFixed(4); p.lotsFilled = agg.lots;
      p.currentStop = computeRatchetedStop(p.lotFills, p.firstStopPrice, p.signal);   // display only
      p.lastClose = bar.close;
      // exit at the recorded signal exit (the live pipeline's BE/SE)
      if (p.exitDate && date >= p.exitDate) {
        const exitPrice = +p.recordedExitPrice;
        const realized = short ? (p.avgCost - exitPrice) * p.shares : (exitPrice - p.avgCost) * p.shares;
        cash += p.shares * p.avgCost + realized;
        const pnlPct = p.avgCost > 0 ? (short ? (p.avgCost - exitPrice) / p.avgCost : (exitPrice - p.avgCost) / p.avgCost) * 100 : 0;
        const holdingWeeks = Math.round((new Date(p.exitDate) - new Date(p.entryDate + 'T12:00:00')) / (7 * 86400000));
        closed.push({
          ticker: p.ticker, direction: p.direction, signal: p.signal, sector: p.sector,
          entryDate: p.entryDate, entryPrice: p.entryPrice, exitDate: p.exitDate, exitPrice: +exitPrice.toFixed(2),
          exitReason: p.exitReason || (short ? 'BE' : 'SE'), avgCost: p.avgCost, shares: p.shares,
          lotsFilled: p.lotsFilled, pnlDollar: +realized.toFixed(2), pnlPct: +pnlPct.toFixed(2),
          holdingWeeks, entryRank: p.entryRank, entryTier: p.entryTier, entryScore: p.entryScore, status: 'CLOSED',
        });
        openPos.splice(i, 1);
      }
    }
    // 2) new entries: top-10 (by rank) entering this date, lot1 only, capital-capped
    const eq = equityNow();
    for (const s of (byEntry[date] || []).filter(x => (x.entryRank || 99) <= TOP_N).sort((a, b) => (a.entryRank || 99) - (b.entryRank || 99))) {
      if (openPos.some(p => p.ticker === s.ticker)) continue;
      const entryPrice = s.entryPrice, stopPrice = s.stopPrice;
      if (!entryPrice || !stopPrice) continue;
      const sized = serverSizePosition({ nav: eq, entryPrice, stopPrice, riskPct: RISK_PCT });
      if (!sized || sized.totalShares <= 0) continue;
      const lots = buildServerLotConfig(sized.totalShares, entryPrice, s.signal);
      const lot1Shares = lots[0].targetShares, cost = lot1Shares * entryPrice;
      if (grossUsed() + cost > grossCapX * eq) { lot1Skips++; continue; }
      cash -= cost;
      openPos.push({
        ticker: s.ticker, direction: s.direction, signal: s.signal, sector: s.sector,
        entryDate: s.entryDate, entryPrice, firstStopPrice: stopPrice,
        entryRank: s.entryRank, entryTier: s.entryTier, entryScore: s.entryScore,
        exitDate: s.status === 'CLOSED' ? s.exitDate : null, recordedExitPrice: s.exitPrice, exitReason: s.exitReason,
        lotConfig: { totalShares: sized.totalShares, lots },
        lotFills: { lot1: { filled: true, fillDate: s.entryDate, fillPrice: entryPrice, shares: lot1Shares }, lot2: { filled: false }, lot3: { filled: false }, lot4: { filled: false }, lot5: { filled: false } },
        shares: lot1Shares, avgCost: entryPrice, lotsFilled: 1, currentStop: stopPrice, lastClose: entryPrice,
      });
    }
    const invested = openPos.reduce((s, p) => s + marketVal(p), 0);
    equitySeries.push({ date, eq: +(cash + invested).toFixed(2), cash: +cash.toFixed(2), invested: +invested.toFixed(2), reserved: +grossUsed().toFixed(2), openCount: openPos.length });
  }

  // still-open positions for the trade log (marked to last close; not closed out)
  const active = openPos.map(p => {
    const short = p.signal === 'SS';
    const pnlDollar = short ? (p.avgCost - p.lastClose) * p.shares : (p.lastClose - p.avgCost) * p.shares;
    const pnlPct = p.avgCost > 0 ? (short ? (p.avgCost - p.lastClose) / p.avgCost : (p.lastClose - p.avgCost) / p.avgCost) * 100 : 0;
    return {
      ticker: p.ticker, direction: p.direction, signal: p.signal, sector: p.sector,
      entryDate: p.entryDate, entryPrice: p.entryPrice, exitDate: null, exitPrice: null, exitReason: null,
      avgCost: p.avgCost, shares: p.shares, lotsFilled: p.lotsFilled, latestPrice: p.lastClose,
      pnlDollar: +pnlDollar.toFixed(2), pnlPct: +pnlPct.toFixed(2),
      holdingWeeks: Math.round((new Date(lastDate) - new Date(p.entryDate + 'T12:00:00')) / (7 * 86400000)),
      entryRank: p.entryRank, entryTier: p.entryTier, entryScore: p.entryScore, status: 'ACTIVE',
    };
  });

  return buildResult({ nav0, grossCapX, equitySeries, closed, active, lot1Skips, addSkips, lastDate, universeLabel: 'Carnivore 679' });
}

const _cache = {};
export async function getKill679Portfolio(nav0 = 100000, grossCapX = 2.0) {
  const key = `${nav0}|${grossCapX}`; const now = Date.now();
  if (_cache[key] && now - _cache[key].at < 30 * 60 * 1000) return _cache[key].data;
  const data = await buildKill679Portfolio({ nav0, grossCapX });
  _cache[key] = { at: now, data };
  return data;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dotenv = await import('dotenv'); dotenv.default.config();
  for (const gx of [1.0, 2.0]) {
    const r = await buildKill679Portfolio({ nav0: 100000, grossCapX: gx });
    const m = r.metrics;
    console.log(`679 Kill 10 ${gx}x: $100k → $${m.endingEquity.toLocaleString()}  TOTAL ${m.totalReturnPct}%  CAGR ${m.annualizedReturn}%  MaxDD ${m.maxDDPct}%  Calmar ${m.calmarAnnual} | trades ${m.totalTrades} (active ${m.activeTrades}) WR ${m.winRate}% PF ${m.profitFactor} | lot1skip ${m.lot1Skips} addskip ${m.addSkips} | months ${r.analytics.monthsAvailable}`);
  }
  process.exit(0);
}
