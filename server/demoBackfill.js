#!/usr/bin/env node
// server/demoBackfill.js
// ── PNTHR Demo Fund — Historical Backfill ───────────────────────────────────
//
// One-time script: generates historical demo trades from past Kill pipeline data.
// Run with:  node server/demoBackfill.js
//
// Logic:
//   1. Query all distinct weekOf dates from pnthr_kill_scores (oldest → newest)
//   2. For each week, simulate the demo engine:
//      - Close positions that fell out of top 10
//      - Open positions that entered top 10
//      - Size based on NAV at that point
//      - Track cumulative NAV from P&L
//   3. Writes to same collections with ownerId='demo_fund'
//
// Safe to re-run: clears all demo_fund data first.
// ─────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { serverSizePosition, STRIKE_PCT, LOT_OFFSETS } from './killTestSettings.js';

const DEMO_OWNER_ID  = 'demo_fund';
const DEMO_SEED_NAV  = 9_847_312.64;
const DEMO_RISK_PCT  = 1;

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function main() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('PNTHR Demo Fund — Historical Backfill');
  console.log('═══════════════════════════════════════════════\n');

  const db = await connectToDatabase();
  if (!db) { console.error('No DB connection'); process.exit(1); }

  // ── 1. Clear existing demo data ────────────────────────────────────────────
  console.log('Clearing existing demo data...');
  await db.collection('pnthr_portfolio').deleteMany({ ownerId: DEMO_OWNER_ID });
  await db.collection('pnthr_journal').deleteMany({ ownerId: DEMO_OWNER_ID });
  await db.collection('pnthr_portfolio_returns').deleteMany({ ownerId: DEMO_OWNER_ID });
  await db.collection('watchlists').deleteMany({ userId: DEMO_OWNER_ID });
  await db.collection('user_profiles').deleteMany({ userId: DEMO_OWNER_ID });

  // ── 2. Create demo profile ────────────────────────────────────────────────
  await db.collection('user_profiles').insertOne({
    userId:      DEMO_OWNER_ID,
    email:       'demo@pnthr.fund',
    role:        'member',
    accountSize: DEMO_SEED_NAV,
    defaultPage: 'command',
    createdAt:   new Date(),
  });

  // ── 3. Get all unique weeks from Kill scores ──────────────────────────────
  const weeks = await db.collection('pnthr_kill_scores').distinct('weekOf');
  weeks.sort(); // chronological
  console.log(`Found ${weeks.length} weeks of Kill data: ${weeks[0]} → ${weeks[weeks.length - 1]}\n`);

  if (weeks.length === 0) {
    console.log('No Kill data to backfill from. Run the Friday pipeline first.');
    process.exit(0);
  }

  // ── 4. Simulate week by week ──────────────────────────────────────────────
  let nav = DEMO_SEED_NAV;
  const activePositions = new Map(); // ticker → position doc
  let totalOpened = 0, totalClosed = 0;

  for (const weekOf of weeks) {
    console.log(`\n── Week: ${weekOf} ─────────────────────────────`);

    // Load Kill scores for this week
    const killScores = await db.collection('pnthr_kill_scores')
      .find({ weekOf })
      .sort({ killRank: 1 })
      .toArray();

    // Load regime
    const regime = await db.collection('pnthr_kill_regime').findOne({ weekOf });

    // Top 10 tickers
    const top10 = killScores.filter(k => k.killRank && k.killRank <= 10);
    const top10Tickers = new Set(top10.map(k => k.ticker));

    // ── Close positions that dropped out of top 10 ──────────────────────────
    for (const [ticker, pos] of activePositions) {
      if (top10Tickers.has(ticker)) continue;

      // Use the current price from this week's Kill scores (if available)
      const ks = killScores.find(k => k.ticker === ticker);
      const exitPrice = ks?.currentPrice || pos.currentPrice || pos.entryPrice;

      const isLong      = pos.direction === 'LONG';
      const filledArr   = Object.values(pos.fills).filter(f => f?.filled && f?.price && f?.shares);
      const totalShares = filledArr.reduce((s, f) => s + f.shares, 0);
      const totalCost   = filledArr.reduce((s, f) => s + f.shares * f.price, 0);
      if (totalShares === 0) { activePositions.delete(ticker); continue; }

      const avgCost      = totalCost / totalShares;
      const profitPct    = isLong ? ((exitPrice - avgCost) / avgCost) * 100 : ((avgCost - exitPrice) / avgCost) * 100;
      const profitDollar = isLong ? (exitPrice - avgCost) * totalShares : (avgCost - exitPrice) * totalShares;

      // Calculate holding weeks
      const entryDate = pos.fills[1]?.date;
      const holdingWeeks = entryDate
        ? Math.round((new Date(weekOf) - new Date(entryDate)) / (7 * 24 * 60 * 60 * 1000))
        : 1;

      // Close in DB
      await db.collection('pnthr_portfolio').updateOne(
        { id: pos.id, ownerId: DEMO_OWNER_ID },
        {
          $set: {
            status: 'CLOSED', currentPrice: exitPrice, closedAt: new Date(weekOf + 'T20:15:00Z'),
            updatedAt: new Date(weekOf + 'T20:15:00Z'),
            outcome: {
              exitPrice, profitPct: +profitPct.toFixed(2), profitDollar: +profitDollar.toFixed(2),
              holdingDays: holdingWeeks * 5, exitReason: 'SIGNAL',
            },
          },
        }
      );

      // Close journal entry
      await db.collection('pnthr_journal').updateOne(
        { positionId: pos.id, ownerId: DEMO_OWNER_ID },
        {
          $set: {
            'performance.status': 'CLOSED',
            'performance.avgExitPrice': exitPrice,
            'performance.totalPnlDollar': +profitDollar.toFixed(2),
            'performance.realizedPnlDollar': +profitDollar.toFixed(2),
            'performance.remainingShares': 0,
            exits: [{ reason: 'SIGNAL', price: exitPrice, date: new Date(weekOf + 'T20:15:00Z'),
              shares: totalShares, pnlDollar: +profitDollar.toFixed(2), pnlPct: +profitPct.toFixed(2) }],
            updatedAt: new Date(weekOf + 'T20:15:00Z'),
          },
        }
      );

      nav += profitDollar;
      activePositions.delete(ticker);
      totalClosed++;
      console.log(`  CLOSED ${ticker} (${isLong ? 'LONG' : 'SHORT'}) — ${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(1)}% ($${profitDollar.toFixed(0)})`);
    }

    // ── Open new positions for top 10 we don't hold ─────────────────────────
    for (const k of top10) {
      if (activePositions.has(k.ticker)) continue;

      const entryPrice = k.currentPrice;
      if (!entryPrice) continue;

      const isLong    = k.signal === 'BL';
      const direction = isLong ? 'LONG' : 'SHORT';

      // Conservative 3% stop
      const stopPrice = isLong
        ? +(entryPrice * 0.97).toFixed(2)
        : +(entryPrice * 1.03).toFixed(2);

      const sized = serverSizePosition({ nav, entryPrice, stopPrice, riskPct: DEMO_RISK_PCT });
      if (!sized || sized.totalShares <= 0) continue;

      const totalShares = sized.totalShares;
      const lot1Shares  = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));
      const posId       = genId();
      const entryDate   = weekOf;

      const fills = {
        1: { filled: true, price: entryPrice, shares: lot1Shares, date: entryDate },
        2: { filled: false }, 3: { filled: false }, 4: { filled: false }, 5: { filled: false },
      };

      const position = {
        id: posId, ticker: k.ticker, direction, entryPrice, originalStop: stopPrice,
        stopPrice, currentPrice: entryPrice, fills,
        sector: k.sector || null, exchange: k.exchange || null,
        signal: k.signal, signalAge: k.signalAge ?? 0,
        entryContext: 'CONFIRMED_SIGNAL',
        killScore: k.totalScore ?? null, killTier: k.tier || null,
        isETF: false, maxGapPct: 0, status: 'ACTIVE', ownerId: DEMO_OWNER_ID,
        outcome: { exitPrice: null, profitPct: null, profitDollar: null, holdingDays: null, exitReason: null },
        createdAt: new Date(weekOf + 'T20:15:00Z'), updatedAt: new Date(weekOf + 'T20:15:00Z'),
      };

      await db.collection('pnthr_portfolio').insertOne(position);
      activePositions.set(k.ticker, position);
      totalOpened++;

      // Create journal entry
      const enrichment = {
        killScoreAtEntry: { rank: k.killRank, totalScore: k.totalScore, tier: k.tier },
        marketAtEntry: regime ? {
          spyPosition: regime.spyAboveEma ? 'above' : 'below',
          qqqPosition: regime.qqqAboveEma ? 'above' : 'below',
          sectorPosition: null,
          regime: { label: regime.spyAboveEma ? 'BULL_TREND' : 'BEAR_TREND' },
        } : null,
        signal: k.signal, signalAge: k.signalAge ?? 0,
        exchange: k.exchange || null, navAtEntry: nav,
        entryContext: 'CONFIRMED_SIGNAL', dataSource: 'DEMO_BACKFILL',
      };

      try {
        const { createJournalEntry } = await import('./journalService.js');
        await createJournalEntry(db, position, DEMO_OWNER_ID, null, null, null, enrichment);
      } catch { /* journal creation best-effort */ }

      console.log(`  OPENED ${k.ticker} (${direction}) @ $${entryPrice.toFixed(2)} | Kill #${k.killRank} ${k.tier}`);
    }

    // ── Update NAV and snapshot ──────────────────────────────────────────────
    await db.collection('user_profiles').updateOne(
      { userId: DEMO_OWNER_ID },
      { $set: { accountSize: +nav.toFixed(2), updatedAt: new Date(weekOf + 'T20:15:00Z') } }
    );

    // Save return snapshot
    const first = await db.collection('pnthr_portfolio_returns').findOne({ ownerId: DEMO_OWNER_ID }, { sort: { date: 1 } });
    const inceptionNav = first?.nav || DEMO_SEED_NAV;
    const last  = await db.collection('pnthr_portfolio_returns').findOne({ ownerId: DEMO_OWNER_ID }, { sort: { date: -1 } });
    const prevNav = last?.nav || DEMO_SEED_NAV;
    await db.collection('pnthr_portfolio_returns').insertOne({
      ownerId: DEMO_OWNER_ID,
      date: new Date(weekOf + 'T20:15:00Z'),
      nav: +nav.toFixed(2),
      weeklyReturn:     +((nav - prevNav) / prevNav * 100).toFixed(4),
      cumulativeReturn: +((nav - inceptionNav) / inceptionNav * 100).toFixed(4),
    });

    // Update watchlist (Kill ranks 11-17)
    const watchTickers = killScores.filter(k => k.killRank >= 11 && k.killRank <= 17).map(k => k.ticker);
    await db.collection('watchlists').deleteMany({ userId: DEMO_OWNER_ID });
    if (watchTickers.length > 0) {
      await db.collection('watchlists').insertMany(
        watchTickers.map(t => ({ userId: DEMO_OWNER_ID, ticker: t, addedAt: new Date(weekOf), createdAt: new Date(weekOf) }))
      );
    }

    console.log(`  NAV: $${nav.toLocaleString()} | Active: ${activePositions.size} positions`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(50)}`);
  console.log('BACKFILL COMPLETE');
  console.log(`${'═'.repeat(50)}`);
  console.log(`Weeks processed:    ${weeks.length}`);
  console.log(`Positions opened:   ${totalOpened}`);
  console.log(`Positions closed:   ${totalClosed}`);
  console.log(`Currently active:   ${activePositions.size}`);
  console.log(`Final NAV:          $${nav.toLocaleString()}`);
  console.log(`Return:             ${((nav - DEMO_SEED_NAV) / DEMO_SEED_NAV * 100).toFixed(2)}%`);

  process.exit(0);
}

main().catch(e => { console.error('Backfill failed:', e); process.exit(1); });
