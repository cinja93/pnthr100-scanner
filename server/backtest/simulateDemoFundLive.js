// server/backtest/simulateDemoFundLive.js
// ── $10M "PNTHR 6-16-25" Fund Simulation ─────────────────────────────────────
//
// Same rules as simulateDemoFund.js but ONLY trades entering June 16, 2025+
// with a fresh $10M starting NAV. Persists to pnthr_journal with
// fundPeriod: 'live_fund' tag.
//
// Also tags existing full-backtest entries with fundPeriod: 'full_backtest'.
//
// Usage:  cd server && node backtest/simulateDemoFundLive.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';

// ── Constants ──────────────────────────────────────────────────────────────
const STARTING_NAV    = 10_000_000;
const RISK_PCT        = 0.01;
const TICKER_CAP_PCT  = 0.10;
const HEAT_CAP_PCT    = 0.10;
const STRIKE_PCT      = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT_NAMES       = ['The Scent', 'The Stalk', 'The Strike', 'The Jugular', 'The Kill'];
const OWNER_ID        = 'demo_fund';
const FUND_START      = '2025-06-16';
const FUND_PERIOD     = 'live_fund';

// IBKR Pro Fixed commissions
const COMMISSION_PER_SHARE = 0.005;
const COMMISSION_MIN_ORDER = 1.00;
const COMMISSION_MAX_PCT   = 0.01;

function calcCommission(shares, price) {
  const raw = shares * COMMISSION_PER_SHARE;
  const maxComm = shares * price * COMMISSION_MAX_PCT;
  return Math.max(COMMISSION_MIN_ORDER, Math.min(raw, maxComm));
}

function genPositionId() {
  return 'LF' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function daysBetween(d1, d2) {
  return Math.round((new Date(d2) - new Date(d1)) / 86400000);
}

// ── Discipline Scoring (same as full sim) ─────────────────────────────────
function scoreDiscipline(trade, washViolation) {
  const { signal, lotsFilledCount, lots, pyramidExitReason, pyramidProfitPct,
          killRank, original, mfe, mae } = trade;

  // T1: Stock Selection (40 pts)
  const signalQuality = { score: 15, max: 15, label: 'CONFIRMED', detail: 'Pipeline-confirmed signal' };

  let killScore, killLabel;
  if (killRank != null && killRank <= 10) { killScore = 10; killLabel = 'TOP 10'; }
  else if (killRank != null && killRank <= 25) { killScore = 7; killLabel = 'TOP 25%'; }
  else if (killRank != null && killRank <= 50) { killScore = 4; killLabel = 'TOP 50%'; }
  else { killScore = 2; killLabel = 'RANKED'; }
  const killContext = { score: killScore, max: 10, label: killLabel, detail: `Kill rank #${killRank || 'N/A'}` };

  const indexTrend = { score: signal === 'BL' ? 8 : 6, max: 8, label: signal === 'BL' ? 'ALIGNED' : 'COUNTER', detail: 'Macro gate passed' };
  const sectorTrend = { score: 5, max: 7, label: 'ALIGNED', detail: 'Sector EMA aligned' };

  const t1 = signalQuality.score + killContext.score + indexTrend.score + sectorTrend.score;

  // T2: Execution (35 pts)
  const sizing = { score: 8, max: 8, label: 'CORRECT', detail: '1% risk rule applied' };
  const riskCap = { score: 5, max: 5, label: 'WITHIN', detail: 'Heat cap respected' };
  const slippage = { score: 4, max: 5, label: 'LIMIT', detail: 'Limit order fill' };

  let pyramidScore, pyramidLabel;
  const lotCount = lotsFilledCount || lots?.length || 1;
  if (lotCount >= 4) { pyramidScore = 10; pyramidLabel = `${lotCount} LOTS`; }
  else if (lotCount >= 3) { pyramidScore = 8; pyramidLabel = `${lotCount} LOTS`; }
  else if (lotCount >= 2) { pyramidScore = 5; pyramidLabel = `${lotCount} LOTS`; }
  else { pyramidScore = 3; pyramidLabel = '1 LOT'; }
  const pyramiding = { score: pyramidScore, max: 10, label: pyramidLabel, detail: `${lotCount} of 5 lots filled` };

  const profitPct = pyramidProfitPct || 0;
  let heldDDScore, heldDDLabel;
  if (profitPct > 0) { heldDDScore = 7; heldDDLabel = 'WINNER'; }
  else if (profitPct > -3) { heldDDScore = 5; heldDDLabel = 'SMALL LOSS'; }
  else if (profitPct > -8) { heldDDScore = 3; heldDDLabel = 'MANAGED'; }
  else { heldDDScore = 1; heldDDLabel = 'DRAWDOWN'; }
  const heldDrawdown = { score: heldDDScore, max: 7, label: heldDDLabel, detail: `${profitPct.toFixed(1)}% P&L` };

  const t2 = sizing.score + riskCap.score + slippage.score + pyramiding.score + heldDrawdown.score;

  // T3: Exit (25 pts)
  let exitScore, exitLabel;
  const reason = pyramidExitReason;
  if (reason === 'SIGNAL_BE' || reason === 'SIGNAL_SE') { exitScore = 12; exitLabel = 'SIGNAL'; }
  else if (reason === 'FEAST') { exitScore = 12; exitLabel = 'FEAST'; }
  else if (reason === 'STOP_HIT') { exitScore = 10; exitLabel = 'STOP HIT'; }
  else if (reason === 'STALE_HUNT') { exitScore = 10; exitLabel = 'STALE HUNT'; }
  else { exitScore = profitPct > 0 ? 4 : 0; exitLabel = 'MANUAL'; }
  const exitMethod = { score: exitScore, max: 12, label: exitLabel, detail: reason };

  let timingScore, timingLabel;
  if (reason === 'SIGNAL_BE' || reason === 'SIGNAL_SE') { timingScore = 8; timingLabel = 'SIGNAL EXIT'; }
  else if (reason === 'FEAST') { timingScore = 8; timingLabel = 'FEAST EXIT'; }
  else if (reason === 'STOP_HIT') { timingScore = 6; timingLabel = 'STOP RULE'; }
  else if (reason === 'STALE_HUNT') { timingScore = 6; timingLabel = 'STALE RULE'; }
  else { timingScore = 3; timingLabel = 'DISCRETIONARY'; }
  const signalTiming = { score: timingScore, max: 8, label: timingLabel, detail: reason };

  const washCompliance = { score: washViolation ? 0 : 5, max: 5, label: washViolation ? 'VIOLATION' : 'CLEAN', detail: washViolation ? '30-day re-entry' : 'No wash conflict' };

  const t3 = exitMethod.score + signalTiming.score + washCompliance.score;
  const totalScore = t1 + t2 + t3;

  let tier;
  if (totalScore >= 90) tier = 'ELITE';
  else if (totalScore >= 75) tier = 'STRONG';
  else if (totalScore >= 60) tier = 'MODERATE';
  else if (totalScore >= 40) tier = 'WEAK';
  else tier = 'OVERRIDE';

  return {
    totalScore,
    tier,
    overrideCount: 0,
    t1: { total: t1, max: 40, signalQuality, killContext, indexTrend, sectorTrend },
    t2: { total: t2, max: 35, sizing, riskCap, slippage, pyramiding, heldDrawdown },
    t3: { total: t3, max: 25, exitMethod, signalTiming, washCompliance },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('DB unavailable'); process.exit(1); }

  const journalCol  = db.collection('pnthr_journal');
  const profileCol  = db.collection('user_profiles');
  const returnsCol  = db.collection('pnthr_portfolio_returns');

  // ── Step 1: Tag existing full-backtest entries ──
  console.log('Tagging existing demo_fund entries as full_backtest...');
  const tagResult = await journalCol.updateMany(
    { ownerId: OWNER_ID, fundPeriod: { $exists: false } },
    { $set: { fundPeriod: 'full_backtest' } }
  );
  console.log(`  Tagged ${tagResult.modifiedCount} entries`);

  // ── Step 2: Clear any previous live_fund entries ──
  const deleted = await journalCol.deleteMany({ ownerId: OWNER_ID, fundPeriod: FUND_PERIOD });
  console.log(`  Cleared ${deleted.deletedCount} previous live_fund entries`);

  // ── Step 3: Load pyramid trades from June 16+ ──
  const allTrades = await db.collection('pnthr_bt_pyramid_trades')
    .find({ 'original.entryDate': { $gte: FUND_START } })
    .sort({ 'original.entryDate': 1 })
    .toArray();

  console.log(`\nLoaded ${allTrades.length} trades entering on/after ${FUND_START}`);

  // ── Build timeline events ──
  const events = [];
  for (let i = 0; i < allTrades.length; i++) {
    const t = allTrades[i];
    events.push({ type: 'ENTRY', date: t.original.entryDate, tradeIdx: i });
    events.push({ type: 'EXIT', date: t.pyramidExitDate, tradeIdx: i });
    for (let li = 1; li < t.lots.length; li++) {
      events.push({ type: 'LOT_FILL', date: t.lots[li].fillDate, tradeIdx: i, lotIdx: li });
    }
  }
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const order = { EXIT: 0, LOT_FILL: 1, ENTRY: 2 };
    return (order[a.type] || 1) - (order[b.type] || 1);
  });

  // ── Simulation State ──
  let nav = STARTING_NAV;
  const openPositions = new Map();
  const closedTrades = [];
  const washHistory = [];
  let skippedHeat = 0;
  let totalCommissions = 0;

  // Weekly NAV tracking
  const weeklyNavMap = new Map(); // friday → nav
  let lastEventDate = null;

  function getFriday(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z');
    const day = d.getUTCDay();
    const diff = day <= 5 ? (5 - day) : (5 - day + 7);
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().split('T')[0];
  }

  console.log(`\nRunning simulation: $${(nav / 1e6).toFixed(0)}M starting NAV from ${FUND_START}\n`);

  for (const event of events) {
    const trade = allTrades[event.tradeIdx];
    lastEventDate = event.date;

    // Track NAV at each Friday boundary
    const friday = getFriday(event.date);
    if (!weeklyNavMap.has(friday)) {
      weeklyNavMap.set(friday, nav);
    }

    if (event.type === 'ENTRY') {
      if (openPositions.has(event.tradeIdx)) continue;

      const isLong = trade.signal === 'BL';
      const entryPrice = trade.original.entryPrice;
      const stopPrice = trade.original.stop;
      const riskPerShare = Math.abs(entryPrice - stopPrice);
      if (riskPerShare <= 0) continue;

      const riskBudget = nav * RISK_PCT;
      const tickerCap = nav * TICKER_CAP_PCT;
      const sharesByRisk = Math.floor(riskBudget / riskPerShare);
      const sharesByCap = Math.floor(tickerCap / entryPrice);
      const totalShares = Math.min(sharesByRisk, sharesByCap);
      if (totalShares <= 0) continue;

      const lotShares = STRIKE_PCT.map(pct => Math.max(1, Math.round(totalShares * pct)));
      const lot1Shares = lotShares[0];

      let currentHeat = 0;
      for (const [, pos] of openPositions) {
        currentHeat += pos.liveRisk;
      }
      const newPositionRisk = lot1Shares * riskPerShare;
      if ((currentHeat + newPositionRisk) > nav * HEAT_CAP_PCT) {
        skippedHeat++;
        continue;
      }

      const lot1Commission = calcCommission(lot1Shares, entryPrice);
      totalCommissions += lot1Commission;

      const positionId = genPositionId();
      openPositions.set(event.tradeIdx, {
        positionId,
        ticker: trade.ticker,
        signal: trade.signal,
        direction: isLong ? 'LONG' : 'SHORT',
        sector: trade.sector,
        exchange: trade.exchange,
        entryPrice,
        stopPrice,
        currentStop: stopPrice,
        riskPerShare,
        totalSharesTarget: totalShares,
        lotSharesTarget: lotShares,
        filledLots: [{
          lot: 1, name: LOT_NAMES[0], shares: lot1Shares,
          price: entryPrice, date: trade.original.entryDate,
          commission: lot1Commission,
        }],
        totalFilledShares: lot1Shares,
        totalCost: lot1Shares * entryPrice,
        avgCost: entryPrice,
        liveRisk: newPositionRisk,
        navAtEntry: nav,
        killRank: trade.killRank,
        killScore: trade.original?.apexScore || null,
        tradeData: trade,
      });

    } else if (event.type === 'LOT_FILL') {
      const pos = openPositions.get(event.tradeIdx);
      if (!pos) continue;

      const lotIdx = event.lotIdx;
      const pyramidLot = trade.lots[lotIdx];
      if (!pyramidLot) continue;

      const shares = pos.lotSharesTarget[lotIdx];
      if (!shares || shares <= 0) continue;

      const fillPrice = pyramidLot.fillPrice;
      const lotCommission = calcCommission(shares, fillPrice);
      totalCommissions += lotCommission;

      pos.filledLots.push({
        lot: lotIdx + 1, name: LOT_NAMES[lotIdx], shares,
        price: fillPrice, date: pyramidLot.fillDate,
        commission: lotCommission,
      });

      pos.totalFilledShares += shares;
      pos.totalCost += shares * fillPrice;
      pos.avgCost = pos.totalCost / pos.totalFilledShares;

      // Stop ratchet
      const lotNum = lotIdx + 1;
      const isLong = pos.direction === 'LONG';
      let ratchetStop = pos.currentStop;

      if (lotNum === 2) ratchetStop = parseFloat(pos.avgCost.toFixed(2));
      else if (lotNum === 3) ratchetStop = pos.filledLots[0].price;
      else if (lotNum === 4 && pos.filledLots.length >= 2) ratchetStop = pos.filledLots[1].price;
      else if (lotNum === 5 && pos.filledLots.length >= 3) ratchetStop = pos.filledLots[2].price;

      if (isLong && ratchetStop > pos.currentStop) pos.currentStop = parseFloat(ratchetStop.toFixed(2));
      else if (!isLong && ratchetStop < pos.currentStop) pos.currentStop = parseFloat(ratchetStop.toFixed(2));

      const newRiskPerShare = Math.abs(pos.avgCost - pos.currentStop);
      pos.liveRisk = Math.max(0, pos.totalFilledShares * newRiskPerShare);

    } else if (event.type === 'EXIT') {
      const pos = openPositions.get(event.tradeIdx);
      if (!pos) continue;

      const exitPrice = trade.pyramidExitPrice;
      const exitDate = trade.pyramidExitDate;
      const exitReason = trade.pyramidExitReason;
      const isLong = pos.direction === 'LONG';

      const exitCommission = calcCommission(pos.totalFilledShares, exitPrice);
      totalCommissions += exitCommission;

      let totalDollarPnl = 0;
      for (const lot of pos.filledLots) {
        let lotPnl = isLong
          ? (exitPrice - lot.price) * lot.shares
          : (lot.price - exitPrice) * lot.shares;
        const exitCommPortion = exitCommission * (lot.shares / pos.totalFilledShares);
        lotPnl -= lot.commission + exitCommPortion;
        totalDollarPnl += lotPnl;
      }

      const profitPct = isLong
        ? ((exitPrice - pos.avgCost) / pos.avgCost * 100)
        : ((pos.avgCost - exitPrice) / pos.avgCost * 100);

      nav += totalDollarPnl;

      // Update weekly NAV after this exit
      const friday = getFriday(exitDate);
      weeklyNavMap.set(friday, nav);

      const isLoss = totalDollarPnl < 0;
      const washViolation = washHistory.some(w =>
        w.ticker === pos.ticker && w.isLoss &&
        daysBetween(w.exitDate, pos.filledLots[0].date) <= 30
      );
      washHistory.push({ ticker: pos.ticker, exitDate, isLoss });

      const discipline = scoreDiscipline(trade, washViolation);

      let journalExitReason;
      if (exitReason === 'SIGNAL_BE' || exitReason === 'SIGNAL_SE') journalExitReason = 'SIGNAL';
      else if (exitReason === 'STOP_HIT') journalExitReason = 'STOP_HIT';
      else if (exitReason === 'STALE_HUNT') journalExitReason = 'STALE_HUNT';
      else if (exitReason === 'FEAST') journalExitReason = 'FEAST';
      else journalExitReason = 'MANUAL';

      // Wash sale data for journal
      const washSale = isLoss ? {
        isLoss: true,
        exitDate: new Date(exitDate + 'T16:00:00Z'),
        expiryDate: new Date(new Date(exitDate + 'T16:00:00Z').getTime() + 30 * 86400000),
        triggered: washViolation,
      } : null;

      closedTrades.push({
        ownerId: OWNER_ID,
        fundPeriod: FUND_PERIOD,
        positionId: pos.positionId,
        ticker: pos.ticker,
        direction: pos.direction,
        signal: pos.signal,
        exchange: pos.exchange,
        sector: pos.sector,

        entry: {
          signalType: pos.signal,
          fillDate: pos.filledLots[0].date,
          fillPrice: pos.filledLots[0].price,
          stopPrice: pos.stopPrice,
          killRank: pos.killRank,
          killScore: pos.killScore,
          killTier: pos.killRank != null && pos.killRank <= 10 ? 'ALPHA PNTHR KILL' : null,
          isKillTop10: pos.killRank != null && pos.killRank <= 10,
          marketAtEntry: {
            spyPosition: 'above',
            qqqPosition: 'above',
            sectorPosition: pos.signal === 'BL' ? 'above' : 'below',
            regime: { label: pos.signal === 'BL' ? 'BULL_TREND' : 'BEAR_TREND' },
          },
          sectorAtEntry: { sector: pos.sector },
        },

        lots: pos.filledLots.map(l => ({
          lot: l.lot, shares: l.shares, price: l.price, date: l.date,
        })),
        totalFilledShares: pos.totalFilledShares,

        exits: [{
          reason: journalExitReason,
          price: exitPrice,
          shares: pos.totalFilledShares,
          date: exitDate,
          pnlDollar: parseFloat(totalDollarPnl.toFixed(2)),
          pnlPct: parseFloat(profitPct.toFixed(2)),
        }],

        performance: {
          status: 'CLOSED',
          remainingShares: 0,
          avgExitPrice: exitPrice,
          totalPnlDollar: parseFloat(totalDollarPnl.toFixed(2)),
          realizedPnlDollar: parseFloat(totalDollarPnl.toFixed(2)),
        },

        washSale: washSale,
        entryContext: 'CONFIRMED_SIGNAL',
        signalAge: 1,
        signalPrice: pos.entryPrice,
        navAtEntry: pos.navAtEntry,
        discipline,
        tags: washViolation ? ['wash-sale'] : [],
        notes: [],
        dataSource: 'DEMO_FUND_LIVE',

        outcome: {
          exitPrice,
          profitPct: parseFloat(profitPct.toFixed(2)),
          profitDollar: parseFloat(totalDollarPnl.toFixed(2)),
          holdingDays: trade.tradingDays,
          exitReason: journalExitReason,
        },

        createdAt: new Date(pos.filledLots[0].date + 'T12:00:00Z'),
        updatedAt: new Date(exitDate + 'T16:00:00Z'),
        closedAt: new Date(exitDate + 'T16:00:00Z'),
      });

      openPositions.delete(event.tradeIdx);
    }
  }

  console.log(`\nSimulation complete.`);
  console.log(`  Final NAV: $${nav.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
  console.log(`  Closed trades: ${closedTrades.length}`);
  console.log(`  Still open: ${openPositions.size}`);
  console.log(`  Skipped (heat cap): ${skippedHeat}`);
  console.log(`  Total commissions: $${totalCommissions.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);

  // ── Persist closed trades ──
  console.log(`\nPersisting ${closedTrades.length} closed trades to pnthr_journal (fundPeriod: ${FUND_PERIOD})...`);
  if (closedTrades.length > 0) {
    await journalCol.insertMany(closedTrades);
  }

  // ── Persist open positions ──
  if (openPositions.size > 0) {
    // Clear previous live_fund positions
    await db.collection('pnthr_portfolio').deleteMany({ ownerId: OWNER_ID, fundPeriod: FUND_PERIOD });

    const openDocs = [];
    for (const [tradeIdx, pos] of openPositions) {
      const fills = {};
      for (const lot of pos.filledLots) {
        fills[lot.lot] = { filled: true, price: lot.price, shares: lot.shares, date: lot.date };
      }
      for (let i = pos.filledLots.length + 1; i <= 5; i++) {
        fills[i] = { filled: false };
      }
      openDocs.push({
        id: pos.positionId,
        ownerId: OWNER_ID,
        fundPeriod: FUND_PERIOD,
        ticker: pos.ticker,
        direction: pos.direction,
        signal: pos.signal,
        status: 'ACTIVE',
        entryPrice: pos.entryPrice,
        originalStop: pos.stopPrice,
        stopPrice: pos.currentStop,
        currentPrice: pos.filledLots[pos.filledLots.length - 1].price,
        fills,
        totalFilledShares: pos.totalFilledShares,
        remainingShares: pos.totalFilledShares,
        sector: pos.sector,
        exchange: pos.exchange,
        killScore: pos.killScore,
        killRank: pos.killRank,
        isETF: false,
        entryContext: 'CONFIRMED_SIGNAL',
        navAtEntry: pos.navAtEntry,
        dataSource: 'DEMO_FUND_LIVE',
        createdAt: new Date(pos.filledLots[0].date + 'T12:00:00Z'),
        updatedAt: new Date(),
      });
    }
    await db.collection('pnthr_portfolio').insertMany(openDocs);
    console.log(`  Persisted ${openDocs.length} open positions`);
  }

  // ── Generate weekly NAV snapshots ──
  console.log('\nGenerating weekly NAV snapshots for live fund...');
  await returnsCol.deleteMany({ ownerId: OWNER_ID, fundPeriod: FUND_PERIOD });

  // Build complete weekly series
  const rfWeekly = 0.05 / 52;
  const sortedWeeks = [...weeklyNavMap.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);

  // Fill gaps (weeks with no activity)
  const allFridays = [];
  if (sortedWeeks.length > 0) {
    const startFri = new Date(sortedWeeks[0][0] + 'T12:00:00Z');
    const endFri = new Date(sortedWeeks[sortedWeeks.length - 1][0] + 'T12:00:00Z');
    const cur = new Date(startFri);
    while (cur <= endFri) {
      allFridays.push(cur.toISOString().split('T')[0]);
      cur.setUTCDate(cur.getUTCDate() + 7);
    }
  }

  let prevNav = STARTING_NAV;
  const snapshots = [];
  for (const friday of allFridays) {
    const navAtFriday = weeklyNavMap.get(friday) || prevNav;
    const weeklyReturn = (navAtFriday - prevNav) / prevNav;
    const cumulativeReturn = (navAtFriday - STARTING_NAV) / STARTING_NAV;

    snapshots.push({
      ownerId: OWNER_ID,
      fundPeriod: FUND_PERIOD,
      date: new Date(friday + 'T20:00:00Z'),
      nav: Math.round(navAtFriday * 100) / 100,
      weeklyReturn: parseFloat(weeklyReturn.toFixed(6)),
      cumulativeReturn: parseFloat(cumulativeReturn.toFixed(6)),
      riskFreeRate: parseFloat(rfWeekly.toFixed(6)),
      createdAt: new Date(),
    });
    prevNav = navAtFriday;
  }

  if (snapshots.length > 0) {
    await returnsCol.insertMany(snapshots);
    console.log(`  Inserted ${snapshots.length} weekly snapshots`);
  }

  // ── Save live fund NAV to profile ──
  await profileCol.updateOne(
    { userId: OWNER_ID },
    { $set: { liveFundNav: Math.round(nav), liveFundStartDate: FUND_START } }
  );

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('  PNTHR FUND (6-16-25) — $10M SIMULATION RESULTS');
  console.log('═══════════════════════════════════════════════════════════════════════════\n');

  const totalReturn = (nav - STARTING_NAV) / STARTING_NAV * 100;
  const winners = closedTrades.filter(t => t.performance.totalPnlDollar > 0);
  const losers = closedTrades.filter(t => t.performance.totalPnlDollar <= 0);

  console.log(`  Fund Start:        ${FUND_START}`);
  console.log(`  Starting NAV:      $${STARTING_NAV.toLocaleString()}`);
  console.log(`  Final NAV:         $${Math.round(nav).toLocaleString()}`);
  console.log(`  Total Return:      ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(1)}%`);
  console.log(`  Total P&L:         $${Math.round(nav - STARTING_NAV).toLocaleString()}`);
  console.log(`  Total Commissions: $${Math.round(totalCommissions).toLocaleString()}`);
  console.log(`  Trades Executed:   ${closedTrades.length} closed + ${openPositions.size} open`);
  console.log(`  Trades Skipped:    ${skippedHeat} (heat cap)`);
  console.log(`  Win Rate:          ${(winners.length / closedTrades.length * 100).toFixed(1)}%`);
  console.log(`  Avg Win:           $${winners.length > 0 ? Math.round(winners.reduce((s, t) => s + t.performance.totalPnlDollar, 0) / winners.length).toLocaleString() : 0}`);
  console.log(`  Avg Loss:          $${losers.length > 0 ? Math.round(losers.reduce((s, t) => s + t.performance.totalPnlDollar, 0) / losers.length).toLocaleString() : 0}`);
  console.log(`  Weekly snapshots:  ${snapshots.length}`);

  // Wash sale stats
  const washViolations = closedTrades.filter(t => t.tags?.includes('wash-sale'));
  console.log(`  Wash violations:   ${washViolations.length}`);

  // Year breakdown
  const yearMap = {};
  for (const t of closedTrades) {
    const yr = t.closedAt.getFullYear();
    if (!yearMap[yr]) yearMap[yr] = { count: 0, pnl: 0, wins: 0 };
    yearMap[yr].count++;
    yearMap[yr].pnl += t.performance.totalPnlDollar;
    if (t.performance.totalPnlDollar > 0) yearMap[yr].wins++;
  }
  console.log('\n  Year   Trades   Win%     P&L $');
  console.log('  ────   ──────   ────     ─────');
  for (const [yr, s] of Object.entries(yearMap).sort()) {
    console.log(`  ${yr}   ${String(s.count).padStart(6)}   ${(s.wins / s.count * 100).toFixed(0).padStart(3)}%   $${Math.round(s.pnl).toLocaleString()}`);
  }

  console.log('\nDone!');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
