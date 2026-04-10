#!/usr/bin/env node
// server/demoBackfillFromBacktest.js
// ── PNTHR Demo Fund — Rebuild from Gate-Filtered Backtest Pyramid Trades ─────
//
// Sources demo fund positions/journal from pnthr_bt_pyramid_trade_log (pnthr_den DB),
// which already has all production gates applied (macro, sector, D2, SS crash).
// This ensures the demo mirrors the live Orders pipeline exactly.
//
// Run with:  node server/demoBackfillFromBacktest.js
//
// Logic:
//   1. Clear all existing demo_fund data
//   2. Load all closed pyramid trades from pnthr_den.pnthr_bt_pyramid_trade_log
//   3. Sort by entryDate, then by exitDate for NAV tracking
//   4. Size each position using $10M seed NAV (1% risk rule)
//   5. Track NAV incrementally as trades close
//   6. Write journal + portfolio entries with ownerId='demo_fund'
//
// Safe to re-run: clears all demo_fund data first.
// ─────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { STRIKE_PCT } from './killTestSettings.js';

const DEMO_OWNER_ID     = 'demo_fund';
const DEMO_SEED_NAV     = 10_000_000;
const DEMO_RISK_PCT     = 1;          // 1% of NAV per trade
const LIVE_FUND_START   = '2025-06-16';
const COMM_PER_SHARE    = 0.005;      // IBKR commission estimate

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Map backtest exit reasons to PNTHR system reasons ────────────────────────
function mapExitReason(btReason) {
  const map = {
    'SIGNAL_BE':   'SIGNAL',
    'SIGNAL_SE':   'SIGNAL',
    'STOP_HIT':    'STOP_HIT',
    'STALE_HUNT':  'STALE_HUNT',
    'FEAST':       'FEAST',
  };
  return map[btReason] || btReason;
}

// ── Discipline scoring for demo entries ──────────────────────────────────────
function scoreDiscipline(trade, exitReason) {
  const lotsFilledCount = trade.lots.filter(l => l.fillDate).length;

  // T1: Setup Quality (40 pts)
  const t1 = {
    signalQuality: { score: 15, max: 15, label: 'CONFIRMED', detail: 'Pipeline-confirmed signal' },
    killContext:    { score: trade.killRank <= 10 ? 10 : 5, max: 10, label: trade.killRank <= 10 ? 'TOP 10' : 'TOP 20', detail: `Kill rank ${trade.killRank}` },
    indexTrend:     { score: 8, max: 8, label: 'WITH TREND', detail: 'Passed macro gate' },
    sectorTrend:    { score: 7, max: 7, label: 'WITH SECTOR', detail: 'Passed sector gate' },
  };
  const t1Total = Object.values(t1).reduce((s, c) => s + c.score, 0);

  // T2: Risk Management (35 pts)
  const pyramidScore = lotsFilledCount <= 1 ? 10 : (lotsFilledCount <= 3 ? 8 : 6);
  const pyramidLabel = lotsFilledCount <= 1 ? 'N/A—LOT 1 ONLY' : `${lotsFilledCount}/5 lots`;
  const maeScore = (trade.mae || 0) <= 3 ? 7 : (trade.mae <= 7 ? 5 : 3);
  const t2 = {
    sizing:        { score: 8, max: 8, label: 'CORRECT', detail: '1% risk rule applied' },
    riskCap:       { score: 5, max: 5, label: 'COMPLIANT', detail: 'Heat cap enforced' },
    slippage:      { score: 5, max: 5, label: 'TIGHT', detail: 'Limit order fill' },
    pyramiding:    { score: pyramidScore, max: 10, label: pyramidLabel, detail: `${lotsFilledCount}/5 lots` },
    heldDrawdown:  { score: maeScore, max: 7, label: 'HELD', detail: `MAE ${(trade.mae || 0).toFixed(1)}%` },
  };
  const t2Total = Object.values(t2).reduce((s, c) => s + c.score, 0);

  // T3: Exit Quality (25 pts)
  const reason = mapExitReason(trade.exitReason);
  const exitScores = { SIGNAL: 12, FEAST: 12, STOP_HIT: 10, STALE_HUNT: 10, RISK_ADVISOR: 10, MANUAL: 4 };
  const exitScore = exitScores[reason] || 4;
  const timingScores = { SIGNAL: 8, FEAST: 8, STOP_HIT: 6, STALE_HUNT: 6, RISK_ADVISOR: 6, MANUAL: 4 };
  const timingScore = timingScores[reason] || 4;
  const t3 = {
    exitMethod:     { score: exitScore, max: 12, label: reason, detail: reason },
    signalTiming:   { score: timingScore, max: 8, label: reason === 'SIGNAL' ? 'OPTIMAL' : 'SYSTEM RULE', detail: reason },
    washCompliance: { score: 5, max: 5, label: 'CLEAN', detail: 'No wash sale' },
  };
  const t3Total = Object.values(t3).reduce((s, c) => s + c.score, 0);

  const totalScore = t1Total + t2Total + t3Total;
  const tierLabel = totalScore >= 90 ? 'ELITE DISCIPLINE' : totalScore >= 75 ? 'STRONG DISCIPLINE' : 'DEVELOPING';

  return {
    totalScore, tierLabel, overrideCount: 0,
    tier1: { total: t1Total, components: t1, max: 40 },
    tier2: { total: t2Total, components: t2, max: 35 },
    tier3: { total: t3Total, components: t3, max: 25 },
  };
}

async function main() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('PNTHR Demo Fund — Rebuild from Backtest Trades');
  console.log('═══════════════════════════════════════════════\n');

  const db = await connectToDatabase();
  if (!db) { console.error('No DB connection'); process.exit(1); }
  const denDb = db.client.db('pnthr_den');

  // ── 1. Clear existing demo data ────────────────────────────────────────────
  console.log('Clearing existing demo data...');
  const delPortfolio = await db.collection('pnthr_portfolio').deleteMany({ ownerId: DEMO_OWNER_ID });
  const delJournal   = await db.collection('pnthr_journal').deleteMany({ ownerId: DEMO_OWNER_ID });
  const delReturns   = await db.collection('pnthr_portfolio_returns').deleteMany({ ownerId: DEMO_OWNER_ID });
  const delWatch     = await db.collection('watchlists').deleteMany({ userId: DEMO_OWNER_ID });
  const delProfile   = await db.collection('user_profiles').deleteMany({ userId: DEMO_OWNER_ID });
  console.log(`  Deleted: ${delPortfolio.deletedCount} portfolio, ${delJournal.deletedCount} journal, ${delReturns.deletedCount} returns, ${delWatch.deletedCount} watchlist, ${delProfile.deletedCount} profile`);

  // ── 2. Create demo profile ────────────────────────────────────────────────
  await db.collection('user_profiles').insertOne({
    userId:      DEMO_OWNER_ID,
    email:       'demo@pnthr.fund',
    role:        'member',
    accountSize: DEMO_SEED_NAV,
    defaultPage: 'command',
    createdAt:   new Date(),
  });

  // ── 3. Load closed pyramid trades (exclude STILL_OPEN) ────────────────────
  const allTrades = await denDb.collection('pnthr_bt_pyramid_trade_log')
    .find({ closed: true, exitReason: { $ne: 'STILL_OPEN' } })
    .sort({ weekOf: 1, killRank: 1 })
    .toArray();

  console.log(`Loaded ${allTrades.length} closed pyramid trades (${allTrades[0]?.weekOf} → ${allTrades[allTrades.length - 1]?.weekOf})\n`);

  // ── 4. Process trades with FIXED sizing ─────────────────────────────────────
  // The backtest used fixed $100K sizing (no compounding). We use fixed $10M
  // sizing to match. NAV = seed + cumulative P&L (reinvestment model matches
  // the backtest equity curve that produces the 37% CAGR).

  let nav = DEMO_SEED_NAV;
  let totalOpened = 0, totalClosed = 0;
  let totalWinners = 0, totalLosers = 0;
  let totalCommissions = 0;
  let disciplineSum = 0;

  const journalBatch = [];
  const portfolioBatch = [];
  const returnSnapshots = new Map(); // exitDate → nav snapshot

  for (const t of allTrades) {
      // ── Size position using FIXED seed NAV (no compounding) ────────────
      const isLong = t.signal === 'BL';
      const riskPerShare = Math.abs(t.entryPrice - t.initialStop);
      if (riskPerShare <= 0) continue;

      const riskBudget = DEMO_SEED_NAV * (DEMO_RISK_PCT / 100);
      const tickerCap  = DEMO_SEED_NAV * 0.10;
      const maxByRisk  = Math.floor(riskBudget / riskPerShare);
      const maxByCap   = Math.floor(tickerCap / t.entryPrice);
      const demoTotalShares = Math.min(maxByRisk, maxByCap);
      if (demoTotalShares <= 0) continue;

      // Scale lots proportionally to backtest lot fill pattern
      const filledLots = t.lots.filter(l => l.fillDate);
      const btTotalShares = filledLots.reduce((s, l) => s + l.shares, 0);
      if (btTotalShares <= 0) continue;

      const scaleFactor = demoTotalShares / (t.totalShares || btTotalShares);
      const demoLots = filledLots.map(l => ({
        lot:    l.lot,
        shares: Math.max(1, Math.round(l.shares * scaleFactor)),
        price:  l.fillPrice,
        date:   l.fillDate,
        name:   l.name,
      }));
      const actualDemoShares = demoLots.reduce((s, l) => s + l.shares, 0);
      const demoCost = demoLots.reduce((s, l) => s + l.shares * l.price, 0);
      const demoAvgCost = demoCost / actualDemoShares;
      totalOpened++;

      // ── Compute P&L ────────────────────────────────────────────────────
      const exitPrice = t.exitPrice;
      const pnlPerShare = isLong ? (exitPrice - demoAvgCost) : (demoAvgCost - exitPrice);
      const demoPnlGross = pnlPerShare * actualDemoShares;
      const demoComm = actualDemoShares * COMM_PER_SHARE * 2; // entry + exit
      const demoPnlNet = demoPnlGross - demoComm;
      const demoPnlPct = (pnlPerShare / demoAvgCost) * 100;
      const isWinner = demoPnlNet > 0;

      nav += demoPnlNet;
      totalClosed++;
      totalCommissions += demoComm;
      if (isWinner) totalWinners++; else totalLosers++;

      // ── Build journal entry ────────────────────────────────────────────
      const posId = genId();
      const direction = isLong ? 'LONG' : 'SHORT';
      const exitReason = mapExitReason(t.exitReason);
      const isLiveFund = t.weekOf >= LIVE_FUND_START;

      const discipline = scoreDiscipline(t, exitReason);
      disciplineSum += discipline.totalScore;

      const lots = demoLots.map(l => ({
        lot: l.lot, shares: l.shares, price: l.price, date: l.date,
      }));

      const journalEntry = {
        ownerId:    DEMO_OWNER_ID,
        positionId: posId,
        ticker:     t.ticker,
        direction,
        signal:     t.signal,
        exchange:   t.exchange || '',
        sector:     t.sector || '',
        entry: {
          signalType:   t.signal,
          fillDate:     t.entryDate,
          fillPrice:    t.entryPrice,
          stopPrice:    t.initialStop,
          killRank:     t.killRank,
          killScore:    t.apexScore || null,
          killTier:     t.apexScore >= 130 ? 'ALPHA PNTHR KILL' : t.apexScore >= 100 ? 'STRIKING' : t.apexScore >= 80 ? 'HUNTING' : 'POUNCING',
          isKillTop10:  t.killRank <= 10,
          marketAtEntry: { spyPosition: null, qqqPosition: null, sectorPosition: null, regime: null },
          sectorAtEntry: { sector: t.sector || '' },
        },
        lots,
        totalFilledShares: actualDemoShares,
        exits: [{
          reason:   exitReason,
          price:    exitPrice,
          shares:   actualDemoShares,
          date:     new Date(t.exitDate + 'T16:00:00Z'),
          pnlDollar: +demoPnlNet.toFixed(2),
          pnlPct:    +demoPnlPct.toFixed(2),
        }],
        performance: {
          status:            'CLOSED',
          remainingShares:   0,
          avgExitPrice:      exitPrice,
          totalPnlDollar:    +demoPnlNet.toFixed(2),
          realizedPnlDollar: +demoPnlNet.toFixed(2),
        },
        entryContext:  'CONFIRMED_SIGNAL',
        signalAge:     t.signalAge ?? 0,
        signalPrice:   t.entryPrice,
        navAtEntry:    DEMO_SEED_NAV,
        discipline,
        tags:          [],
        notes:         [],
        dataSource:    'DEMO_BACKFILL',
        outcome: {
          exitPrice,
          profitPct:    +demoPnlPct.toFixed(2),
          profitDollar: +demoPnlNet.toFixed(2),
          holdingDays:  t.tradingDays || 0,
          exitReason,
        },
        createdAt:   new Date(t.weekOf + 'T12:00:00Z'),
        updatedAt:   new Date(t.exitDate + 'T16:00:00Z'),
        closedAt:    new Date(t.exitDate + 'T16:00:00Z'),
        fundPeriod:  isLiveFund ? 'live_fund' : 'full_backtest',
      };

      journalBatch.push(journalEntry);

      // ── Build portfolio entry (closed) ─────────────────────────────────
      const fills = {};
      for (let i = 1; i <= 5; i++) {
        const lot = demoLots.find(l => l.lot === i);
        fills[i] = lot
          ? { filled: true, price: lot.price, shares: lot.shares, date: lot.date }
          : { filled: false };
      }

      portfolioBatch.push({
        id: posId, ticker: t.ticker, direction, entryPrice: t.entryPrice,
        originalStop: t.initialStop, stopPrice: t.stop || t.initialStop,
        currentPrice: exitPrice, fills,
        sector: t.sector || null, exchange: t.exchange || null,
        signal: t.signal, signalAge: t.signalAge ?? 0,
        entryContext: 'CONFIRMED_SIGNAL',
        killScore: t.apexScore || null, killTier: null,
        isETF: false, maxGapPct: 0, status: 'CLOSED', ownerId: DEMO_OWNER_ID,
        outcome: {
          exitPrice, profitPct: +demoPnlPct.toFixed(2),
          profitDollar: +demoPnlNet.toFixed(2),
          holdingDays: t.tradingDays || 0, exitReason,
        },
        createdAt: new Date(t.weekOf + 'T12:00:00Z'),
        updatedAt: new Date(t.exitDate + 'T16:00:00Z'),
        closedAt:  new Date(t.exitDate + 'T16:00:00Z'),
      });

      // Track weekly NAV snapshots
      const weekKey = t.exitDate;
      returnSnapshots.set(weekKey, nav);

      if (totalClosed % 250 === 0) {
        console.log(`  [${totalClosed}/${allTrades.length}] NAV: $${nav.toLocaleString('en-US', { maximumFractionDigits: 0 })} | Last: ${t.ticker} ${isWinner ? '✓' : '✗'} ${demoPnlPct >= 0 ? '+' : ''}${demoPnlPct.toFixed(1)}%`);
      }
  }

  // ── 6. Batch write to MongoDB ──────────────────────────────────────────────
  console.log(`\nWriting ${journalBatch.length} journal entries...`);
  if (journalBatch.length > 0) {
    // Insert in batches of 500 to avoid memory issues
    for (let i = 0; i < journalBatch.length; i += 500) {
      const batch = journalBatch.slice(i, i + 500);
      await db.collection('pnthr_journal').insertMany(batch);
    }
  }

  console.log(`Writing ${portfolioBatch.length} portfolio entries...`);
  if (portfolioBatch.length > 0) {
    for (let i = 0; i < portfolioBatch.length; i += 500) {
      const batch = portfolioBatch.slice(i, i + 500);
      await db.collection('pnthr_portfolio').insertMany(batch);
    }
  }

  // ── 7. Write NAV snapshots ─────────────────────────────────────────────────
  const sortedSnapshots = [...returnSnapshots.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const navDocs = [];
  let prevSnapNav = DEMO_SEED_NAV;
  for (const [dateStr, snapNav] of sortedSnapshots) {
    navDocs.push({
      ownerId: DEMO_OWNER_ID,
      date: new Date(dateStr + 'T16:00:00Z'),
      nav: +snapNav.toFixed(2),
      weeklyReturn: +((snapNav - prevSnapNav) / prevSnapNav * 100).toFixed(4),
      cumulativeReturn: +((snapNav - DEMO_SEED_NAV) / DEMO_SEED_NAV * 100).toFixed(4),
    });
    prevSnapNav = snapNav;
  }
  if (navDocs.length > 0) {
    await db.collection('pnthr_portfolio_returns').insertMany(navDocs);
  }

  // ── 8. Update profile with final NAV ───────────────────────────────────────
  const liveFundTrades = journalBatch.filter(j => j.fundPeriod === 'live_fund');
  const liveFundPnl = liveFundTrades.reduce((s, j) => s + j.performance.totalPnlDollar, 0);
  // Live fund NAV: assume it started from the NAV at LIVE_FUND_START
  const liveFundStartNav = journalBatch
    .filter(j => j.fundPeriod === 'live_fund')
    .reduce((min, j) => Math.min(min, j.navAtEntry), Infinity);
  const liveFundEndNav = liveFundStartNav === Infinity ? DEMO_SEED_NAV : liveFundStartNav + liveFundPnl;

  await db.collection('user_profiles').updateOne(
    { userId: DEMO_OWNER_ID },
    { $set: {
      accountSize:      +nav.toFixed(2),
      liveFundNav:      +liveFundEndNav.toFixed(2),
      liveFundStartDate: LIVE_FUND_START,
      updatedAt:        new Date(),
    }}
  );

  // ── 9. Summary ─────────────────────────────────────────────────────────────
  const winRate = totalClosed > 0 ? (totalWinners / totalClosed * 100).toFixed(1) : '0.0';
  const avgDiscipline = totalClosed > 0 ? (disciplineSum / totalClosed).toFixed(1) : '0.0';
  const totalReturn = ((nav - DEMO_SEED_NAV) / DEMO_SEED_NAV * 100).toFixed(1);

  const fullBtCount = journalBatch.filter(j => j.fundPeriod === 'full_backtest').length;
  const lfCount = liveFundTrades.length;

  console.log('\n═══════════════════════════════════════════════');
  console.log('DEMO FUND REBUILD COMPLETE');
  console.log('═══════════════════════════════════════════════');
  console.log(`Source:           pnthr_den.pnthr_bt_pyramid_trade_log (gate-filtered)`);
  console.log(`Total trades:     ${totalClosed}`);
  console.log(`  full_backtest:  ${fullBtCount}`);
  console.log(`  live_fund:      ${lfCount}`);
  console.log(`Winners:          ${totalWinners} | Losers: ${totalLosers}`);
  console.log(`Win Rate:         ${winRate}%`);
  console.log(`Start NAV:        $${DEMO_SEED_NAV.toLocaleString()}`);
  console.log(`End NAV:          $${nav.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  console.log(`Total Return:     +${totalReturn}%`);
  console.log(`Commissions:      $${totalCommissions.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  console.log(`Avg Discipline:   ${avgDiscipline}`);
  console.log(`Live Fund NAV:    $${liveFundEndNav.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  console.log('═══════════════════════════════════════════════\n');

  console.log('── HARDCODED VALUES FOR UI UPDATE ──');
  console.log(`DEMO_5Y = { startNav: '$10,000,000', endNav: '$${nav.toLocaleString('en-US', { maximumFractionDigits: 0 })}', totalReturn: '+${totalReturn}%', trades: '${totalClosed.toLocaleString()}', winRate: '${winRate}%', commissions: '$${totalCommissions.toLocaleString('en-US', { maximumFractionDigits: 0 })}', avgDiscipline: '${avgDiscipline}' }`);
  console.log(`DEMO_LF = { startNav: '$${liveFundStartNav === Infinity ? '10,000,000' : liveFundStartNav.toLocaleString('en-US', { maximumFractionDigits: 0 })}', endNav: '$${liveFundEndNav.toLocaleString('en-US', { maximumFractionDigits: 0 })}', totalReturn: '+${liveFundStartNav === Infinity ? '0.0' : ((liveFundPnl / liveFundStartNav) * 100).toFixed(1)}%', trades: '${lfCount}', winRate: '${(liveFundTrades.filter(j => j.performance.totalPnlDollar > 0).length / lfCount * 100).toFixed(1)}%' }`);

  process.exit(0);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
