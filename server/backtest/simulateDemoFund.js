// server/backtest/simulateDemoFund.js
// ── $10M Demo Fund Simulation ──────────────────────────────────────────────
//
// Reads:  pnthr_bt_pyramid_trades (1,676 validated pyramid trades)
// Writes: pnthr_journal (closed trades, ownerId: 'demo_fund')
//         pnthr_portfolio (open positions, ownerId: 'demo_fund')
//         user_profiles (final NAV for demo_fund)
//
// Rules:
//   - Starting NAV: $10,000,000
//   - 1% risk per position (NAV × 0.01 / riskPerShare)
//   - 10% max portfolio heat (sum of live dollar risk across all positions)
//   - Lot sizing: 35/25/20/12/8% of total shares
//   - IBKR Pro Fixed: $0.005/share, $1.00 min per order
//   - Wash sale tracking: 30-day lookback per ticker
//   - Full discipline scoring on closed trades
//
// Usage:  cd server && node backtest/simulateDemoFund.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';

// ── Constants ──────────────────────────────────────────────────────────────
const STARTING_NAV    = 10_000_000;
const RISK_PCT        = 0.01;      // 1% of NAV per position
const TICKER_CAP_PCT  = 0.10;      // 10% of NAV max per ticker
const HEAT_CAP_PCT    = 0.10;      // 10% of NAV max portfolio heat
const STRIKE_PCT      = [0.35, 0.25, 0.20, 0.12, 0.08];
const LOT_NAMES       = ['The Scent', 'The Stalk', 'The Strike', 'The Jugular', 'The Kill'];
const OWNER_ID        = 'demo_fund';

// IBKR Pro Fixed commissions
const COMMISSION_PER_SHARE = 0.005;
const COMMISSION_MIN_ORDER = 1.00;
const COMMISSION_MAX_PCT   = 0.01; // 1% of trade value

function calcCommission(shares, price) {
  const raw = shares * COMMISSION_PER_SHARE;
  const maxComm = shares * price * COMMISSION_MAX_PCT;
  return Math.max(COMMISSION_MIN_ORDER, Math.min(raw, maxComm));
}

// ── Discipline Scoring ─────────────────────────────────────────────────────

function scoreDiscipline(trade, washViolation) {
  const { signal, lotsFilledCount, lots, pyramidExitReason, pyramidProfitPct,
          killRank, original, mfe, mae } = trade;

  // T1: Stock Selection (40 pts)
  // Signal Quality (15 pts) - all are confirmed signals from the pipeline
  const signalQuality = { score: 15, max: 15, label: 'CONFIRMED', detail: 'Pipeline-confirmed signal' };

  // Kill Context (10 pts)
  let killScore, killLabel;
  if (killRank != null && killRank <= 10) { killScore = 10; killLabel = 'TOP 10'; }
  else if (killRank != null && killRank <= 25) { killScore = 7; killLabel = 'TOP 25%'; }
  else if (killRank != null && killRank <= 50) { killScore = 4; killLabel = 'TOP 50%'; }
  else { killScore = 1; killLabel = 'UNRANKED'; }
  const killContext = { score: killScore, max: 10, label: killLabel, detail: `Kill rank ${killRank || 'N/A'}` };

  // Index Trend (8 pts) - all trades passed macro gate, so WITH TREND
  const indexTrend = { score: 8, max: 8, label: 'WITH TREND', detail: 'Passed macro gate' };

  // Sector Trend (7 pts) - all trades passed sector gate
  const sectorTrend = { score: 7, max: 7, label: 'WITH SECTOR', detail: 'Passed sector gate' };

  const tier1Total = signalQuality.score + killContext.score + indexTrend.score + sectorTrend.score;

  // T2: Execution (35 pts)
  // Sizing (8 pts) - system-sized, always correct
  const sizing = { score: 8, max: 8, label: 'CORRECT', detail: '1% risk rule applied' };

  // Risk Cap (5 pts) - system enforced
  const riskCap = { score: 5, max: 5, label: 'COMPLIANT', detail: 'Heat cap enforced' };

  // Slippage (5 pts) - fills at trigger/signal price (limit orders)
  const slippage = { score: 5, max: 5, label: 'TIGHT', detail: 'Limit order fill' };

  // Pyramiding (10 pts) - based on how many lots filled correctly
  let pyrScore, pyrLabel;
  if (lotsFilledCount === 1) { pyrScore = 10; pyrLabel = 'N/A—LOT 1 ONLY'; }
  else if (lotsFilledCount >= 4) { pyrScore = 10; pyrLabel = `${lotsFilledCount} LOTS FILLED`; }
  else if (lotsFilledCount === 3) { pyrScore = 8; pyrLabel = '3 LOTS FILLED'; }
  else { pyrScore = 6; pyrLabel = '2 LOTS FILLED'; }
  const pyramiding = { score: pyrScore, max: 10, label: pyrLabel, detail: `${lotsFilledCount}/5 lots` };

  // Held Drawdown (7 pts) - check if MAE indicates held through drawdown
  let heldScore;
  if (mae < -5) { heldScore = 7; } // held through significant drawdown
  else if (mae < -2) { heldScore = 7; }
  else { heldScore = 7; } // system held, no panic sell
  const heldDrawdown = { score: heldScore, max: 7, label: 'HELD', detail: `MAE ${mae?.toFixed(1) || 0}%` };

  const tier2Total = sizing.score + riskCap.score + slippage.score + pyramiding.score + heldDrawdown.score;

  // T3: Exit (25 pts)
  // Exit Method (12 pts)
  let exitMethodScore, exitMethodLabel;
  const reason = pyramidExitReason;
  if (reason === 'SIGNAL_BE' || reason === 'SIGNAL_SE') {
    exitMethodScore = 12; exitMethodLabel = 'SIGNAL';
  } else if (reason === 'STOP_HIT') {
    exitMethodScore = 10; exitMethodLabel = 'STOP_HIT';
  } else if (reason === 'STALE_HUNT') {
    exitMethodScore = 10; exitMethodLabel = 'STALE_HUNT';
  } else if (reason === 'FEAST') {
    exitMethodScore = 12; exitMethodLabel = 'FEAST';
  } else {
    exitMethodScore = pyramidProfitPct >= 0 ? 4 : 0;
    exitMethodLabel = 'MANUAL';
  }
  const exitMethod = { score: exitMethodScore, max: 12, label: exitMethodLabel, detail: reason };

  // Signal Timing (8 pts)
  let timingScore, timingLabel;
  if (reason === 'SIGNAL_BE' || reason === 'SIGNAL_SE') {
    timingScore = 8; timingLabel = 'ON SIGNAL';
  } else if (reason === 'STOP_HIT' || reason === 'STALE_HUNT' || reason === 'FEAST') {
    timingScore = 6; timingLabel = 'SYSTEM RULE';
  } else {
    timingScore = 0; timingLabel = 'MANUAL';
  }
  const signalTiming = { score: timingScore, max: 8, label: timingLabel, detail: reason };

  // Wash Compliance (5 pts)
  const washCompliance = {
    score: washViolation ? 0 : 5,
    max: 5,
    label: washViolation ? 'WASH VIOLATION' : 'CLEAN',
    detail: washViolation ? 'Same ticker loss within 30 days' : 'No wash sale',
  };

  const tier3Total = exitMethod.score + signalTiming.score + washCompliance.score;
  const totalScore = tier1Total + tier2Total + tier3Total;

  let tierLabel;
  if (totalScore >= 90) tierLabel = 'ELITE DISCIPLINE';
  else if (totalScore >= 75) tierLabel = 'STRONG DISCIPLINE';
  else if (totalScore >= 60) tierLabel = 'MODERATE DISCIPLINE';
  else if (totalScore >= 40) tierLabel = 'WEAK DISCIPLINE';
  else tierLabel = 'SYSTEM OVERRIDE';

  return {
    totalScore,
    tierLabel,
    overrideCount: 0,
    tier1: {
      total: tier1Total,
      components: { signalQuality, killContext, indexTrend, sectorTrend },
    },
    tier2: {
      total: tier2Total,
      components: { sizing, riskCap, slippage, pyramiding, heldDrawdown },
    },
    tier3: {
      total: tier3Total,
      components: { exitMethod, signalTiming, washCompliance },
    },
  };
}

// ── Position ID generator (matches live system) ────────────────────────────
function genPositionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  const pyramidCol = db.collection('pnthr_bt_pyramid_trades');
  const journalCol = db.collection('pnthr_journal');
  const portfolioCol = db.collection('pnthr_portfolio');
  const profileCol = db.collection('user_profiles');

  // ── Clear existing demo data ──
  console.log('\nClearing existing demo_fund data...');
  const jDel = await journalCol.deleteMany({ ownerId: OWNER_ID });
  const pDel = await portfolioCol.deleteMany({ ownerId: OWNER_ID });
  console.log(`  Deleted ${jDel.deletedCount} journal entries, ${pDel.deletedCount} portfolio positions`);

  // ── Load pyramid trades ──
  const allTrades = await pyramidCol.find({}).sort({ 'original.entryDate': 1 }).toArray();
  console.log(`\nLoaded ${allTrades.length} pyramid trades`);

  // ── Build timeline events ──
  // Each trade has entry events (lot fills) and an exit event
  // We need to process them chronologically to track NAV and heat
  const events = [];
  for (let i = 0; i < allTrades.length; i++) {
    const t = allTrades[i];
    events.push({ type: 'ENTRY', date: t.original.entryDate, tradeIdx: i });
    events.push({ type: 'EXIT', date: t.pyramidExitDate, tradeIdx: i });
    // Lot fills (lots 2+)
    for (let li = 1; li < t.lots.length; li++) {
      events.push({ type: 'LOT_FILL', date: t.lots[li].fillDate, tradeIdx: i, lotIdx: li });
    }
  }
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    // Process exits before entries on same day (free up capital first)
    const order = { EXIT: 0, LOT_FILL: 1, ENTRY: 2 };
    return (order[a.type] || 1) - (order[b.type] || 1);
  });

  // ── Simulation State ──
  let nav = STARTING_NAV;
  const openPositions = new Map(); // tradeIdx → position state
  const closedTrades = [];
  const washHistory = []; // { ticker, exitDate, isLoss } for 30-day lookback
  let skippedHeat = 0;
  let totalCommissions = 0;

  console.log(`\nRunning simulation: $${(nav/1e6).toFixed(0)}M starting NAV\n`);

  for (const event of events) {
    const trade = allTrades[event.tradeIdx];

    if (event.type === 'ENTRY') {
      // Skip if already open (shouldn't happen, but safety check)
      if (openPositions.has(event.tradeIdx)) continue;

      const isLong = trade.signal === 'BL';
      const entryPrice = trade.original.entryPrice;
      const stopPrice = trade.original.stop;
      const riskPerShare = Math.abs(entryPrice - stopPrice);

      if (riskPerShare <= 0) continue;

      // Calculate position size
      const riskBudget = nav * RISK_PCT;
      const tickerCap = nav * TICKER_CAP_PCT;
      const sharesByRisk = Math.floor(riskBudget / riskPerShare);
      const sharesByCap = Math.floor(tickerCap / entryPrice);
      const totalShares = Math.min(sharesByRisk, sharesByCap);
      if (totalShares <= 0) continue;

      // Calculate lot shares
      const lotShares = STRIKE_PCT.map(pct => Math.max(1, Math.round(totalShares * pct)));
      const lot1Shares = lotShares[0];

      // Check heat cap before entering
      let currentHeat = 0;
      for (const [, pos] of openPositions) {
        currentHeat += pos.liveRisk;
      }
      const newPositionRisk = lot1Shares * riskPerShare;
      if ((currentHeat + newPositionRisk) > nav * HEAT_CAP_PCT) {
        skippedHeat++;
        continue;
      }

      // Commission on lot 1 entry
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
          lot: 1,
          name: LOT_NAMES[0],
          shares: lot1Shares,
          price: entryPrice,
          date: trade.original.entryDate,
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
        lot: lotIdx + 1,
        name: LOT_NAMES[lotIdx],
        shares,
        price: fillPrice,
        date: pyramidLot.fillDate,
        commission: lotCommission,
      });

      pos.totalFilledShares += shares;
      pos.totalCost += shares * fillPrice;
      pos.avgCost = pos.totalCost / pos.totalFilledShares;

      // Stop ratchet (same rules as pyramid sim)
      const lotNum = lotIdx + 1;
      const isLong = pos.direction === 'LONG';
      let ratchetStop = pos.currentStop;

      if (lotNum === 2) {
        ratchetStop = parseFloat(pos.avgCost.toFixed(2));
      } else if (lotNum === 3) {
        ratchetStop = pos.filledLots[0].price; // Lot 1
      } else if (lotNum === 4 && pos.filledLots.length >= 2) {
        ratchetStop = pos.filledLots[1].price; // Lot 2
      } else if (lotNum === 5 && pos.filledLots.length >= 3) {
        ratchetStop = pos.filledLots[2].price; // Lot 3
      }

      if (isLong && ratchetStop > pos.currentStop) {
        pos.currentStop = parseFloat(ratchetStop.toFixed(2));
      } else if (!isLong && ratchetStop < pos.currentStop) {
        pos.currentStop = parseFloat(ratchetStop.toFixed(2));
      }

      // Recalculate live risk with new stop
      const newRiskPerShare = Math.abs(pos.avgCost - pos.currentStop);
      pos.liveRisk = Math.max(0, pos.totalFilledShares * newRiskPerShare);

    } else if (event.type === 'EXIT') {
      const pos = openPositions.get(event.tradeIdx);
      if (!pos) continue;

      const exitPrice = trade.pyramidExitPrice;
      const exitDate = trade.pyramidExitDate;
      const exitReason = trade.pyramidExitReason;
      const isLong = pos.direction === 'LONG';

      // Commission on exit
      const exitCommission = calcCommission(pos.totalFilledShares, exitPrice);
      totalCommissions += exitCommission;

      // Calculate P&L per lot
      let totalDollarPnl = 0;
      const exitDetails = [];
      for (const lot of pos.filledLots) {
        let lotPnl;
        if (isLong) {
          lotPnl = (exitPrice - lot.price) * lot.shares;
        } else {
          lotPnl = (lot.price - exitPrice) * lot.shares;
        }
        // Subtract commissions (entry + proportional exit)
        const exitCommPortion = exitCommission * (lot.shares / pos.totalFilledShares);
        lotPnl -= lot.commission + exitCommPortion;
        totalDollarPnl += lotPnl;
      }

      const profitPct = isLong
        ? ((exitPrice - pos.avgCost) / pos.avgCost * 100)
        : ((pos.avgCost - exitPrice) / pos.avgCost * 100);

      // Update NAV
      nav += totalDollarPnl;

      // Wash sale check
      const isLoss = totalDollarPnl < 0;
      const washViolation = washHistory.some(w =>
        w.ticker === pos.ticker &&
        w.isLoss &&
        daysBetween(w.exitDate, pos.filledLots[0].date) <= 30
      );
      washHistory.push({ ticker: pos.ticker, exitDate, isLoss });

      // Discipline scoring
      const discipline = scoreDiscipline(trade, washViolation);

      // Map exit reason to journal format
      let journalExitReason;
      if (exitReason === 'SIGNAL_BE' || exitReason === 'SIGNAL_SE') journalExitReason = 'SIGNAL';
      else if (exitReason === 'STOP_HIT') journalExitReason = 'STOP_HIT';
      else if (exitReason === 'STALE_HUNT') journalExitReason = 'STALE_HUNT';
      else if (exitReason === 'FEAST') journalExitReason = 'FEAST';
      else journalExitReason = 'MANUAL';

      closedTrades.push({
        ownerId: OWNER_ID,
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
            spyPosition: 'above',  // All BL passed macro gate
            qqqPosition: 'above',
            sectorPosition: pos.signal === 'BL' ? 'above' : 'below',
            regime: { label: pos.signal === 'BL' ? 'BULL_TREND' : 'BEAR_TREND' },
          },
          sectorAtEntry: { sector: pos.sector },
        },

        lots: pos.filledLots.map(l => ({
          lot: l.lot,
          shares: l.shares,
          price: l.price,
          date: l.date,
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

        entryContext: 'CONFIRMED_SIGNAL',
        signalAge: 1,
        signalPrice: pos.entryPrice,
        navAtEntry: pos.navAtEntry,
        discipline,
        tags: washViolation ? ['wash-sale'] : [],
        notes: [],
        dataSource: 'DEMO_BACKFILL',

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

  // ── Persist closed trades to journal ──
  console.log(`\nPersisting ${closedTrades.length} closed trades to pnthr_journal...`);
  if (closedTrades.length > 0) {
    await journalCol.insertMany(closedTrades);
  }
  console.log('  Done.');

  // ── Persist open positions to portfolio ──
  const openDocs = [];
  for (const [tradeIdx, pos] of openPositions) {
    const trade = allTrades[tradeIdx];
    const fills = {};
    for (const lot of pos.filledLots) {
      fills[lot.lot] = {
        filled: true,
        price: lot.price,
        shares: lot.shares,
        date: lot.date,
      };
    }
    // Fill empty lots as unfilled
    for (let i = pos.filledLots.length + 1; i <= 5; i++) {
      fills[i] = { filled: false };
    }

    openDocs.push({
      id: pos.positionId,
      ownerId: OWNER_ID,
      ticker: pos.ticker,
      direction: pos.direction,
      signal: pos.signal,
      status: 'ACTIVE',
      entryPrice: pos.entryPrice,
      originalStop: pos.stopPrice,
      stopPrice: pos.currentStop,
      currentPrice: pos.filledLots[pos.filledLots.length - 1].price, // last known
      maxGapPct: 5, // default estimate
      fills,
      totalFilledShares: pos.totalFilledShares,
      remainingShares: pos.totalFilledShares,
      sector: pos.sector,
      exchange: pos.exchange,
      killScore: pos.killScore,
      killRank: pos.killRank,
      isETF: false,
      entryContext: 'CONFIRMED_SIGNAL',
      signalAge: 1,
      navAtEntry: pos.navAtEntry,
      dataSource: 'DEMO_BACKFILL',
      createdAt: new Date(pos.filledLots[0].date + 'T12:00:00Z'),
      updatedAt: new Date(),
    });
  }

  if (openDocs.length > 0) {
    console.log(`\nPersisting ${openDocs.length} open positions to pnthr_portfolio...`);
    await portfolioCol.insertMany(openDocs);
    console.log('  Done.');

    console.log('\n── Open Positions ──');
    for (const p of openDocs) {
      console.log(`  ${p.ticker} ${p.direction} | Entry: $${p.entryPrice} | Stop: $${p.stopPrice} | Shares: ${p.totalFilledShares} | Lots: ${p.fills ? Object.values(p.fills).filter(f => f.filled).length : 0}`);
    }
  }

  // ── Update demo user profile with final NAV ──
  await profileCol.updateOne(
    { userId: OWNER_ID },
    { $set: { accountSize: Math.round(nav) } }
  );
  console.log(`\nUpdated demo_fund accountSize to $${Math.round(nav).toLocaleString()}`);

  // ── Summary Report ──
  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('  PNTHR DEMO FUND — $10M SIMULATION RESULTS');
  console.log('═══════════════════════════════════════════════════════════════════════════\n');

  const totalReturn = (nav - STARTING_NAV) / STARTING_NAV * 100;
  const winners = closedTrades.filter(t => t.performance.totalPnlDollar > 0);
  const losers = closedTrades.filter(t => t.performance.totalPnlDollar <= 0);

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

  // Discipline summary
  const avgDiscipline = closedTrades.reduce((s, t) => s + t.discipline.totalScore, 0) / closedTrades.length;
  const eliteCount = closedTrades.filter(t => t.discipline.totalScore >= 90).length;
  const strongCount = closedTrades.filter(t => t.discipline.totalScore >= 75 && t.discipline.totalScore < 90).length;
  const washCount = closedTrades.filter(t => t.tags.includes('wash-sale')).length;

  console.log(`\n  Avg Discipline:    ${avgDiscipline.toFixed(1)}/100`);
  console.log(`  Elite (90+):       ${eliteCount}`);
  console.log(`  Strong (75-89):    ${strongCount}`);
  console.log(`  Wash Violations:   ${washCount}`);

  // Year-by-year
  console.log('\n── Year-by-Year ──\n');
  console.log('  Year   Trades   Win%     P&L $            NAV End');
  const years = [...new Set(closedTrades.map(t => t.closedAt.getFullYear()))].sort();
  let runningNav = STARTING_NAV;
  for (const yr of years) {
    const yrTrades = closedTrades.filter(t => t.closedAt.getFullYear() === yr);
    const yrPnl = yrTrades.reduce((s, t) => s + t.performance.totalPnlDollar, 0);
    const yrWins = yrTrades.filter(t => t.performance.totalPnlDollar > 0).length;
    runningNav += yrPnl;
    console.log(
      `  ${yr}   ${String(yrTrades.length).padStart(6)}   ${(yrWins / yrTrades.length * 100).toFixed(1).padStart(5)}%   ` +
      `${yrPnl >= 0 ? '+' : ''}$${Math.round(yrPnl).toLocaleString()}`.padStart(16) +
      `   $${Math.round(runningNav).toLocaleString()}`
    );
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════\n');
  process.exit(0);
}

function daysBetween(date1, date2) {
  const d1 = new Date(date1 + 'T00:00:00Z');
  const d2 = new Date(date2 + 'T00:00:00Z');
  return Math.abs(Math.round((d2 - d1) / (1000 * 60 * 60 * 24)));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
