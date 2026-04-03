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
const FMP_API_KEY    = () => process.env.FMP_API_KEY;
const FMP_BASE       = 'https://financialmodelingprep.com/api/v3';

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Get the next trading day (Monday, or Tuesday if Monday is a holiday)
function getNextMonday(fridayStr) {
  const friday = new Date(fridayStr + 'T12:00:00Z');
  const monday = new Date(friday);
  monday.setDate(monday.getDate() + 3);
  return monday.toISOString().split('T')[0];
}

// Fetch Monday opening prices for a batch of tickers after a Friday
async function fetchMondayOpenPrices(tickers, fridayWeekOf) {
  const mondayStr = getNextMonday(fridayWeekOf);
  // Fetch a few days range in case Monday is a holiday
  const endDate = new Date(mondayStr + 'T12:00:00Z');
  endDate.setDate(endDate.getDate() + 4);
  const endStr = endDate.toISOString().split('T')[0];

  const results = {};
  for (const ticker of tickers) {
    try {
      const url = `${FMP_BASE}/historical-price-full/${ticker}?from=${mondayStr}&to=${endStr}&apikey=${FMP_API_KEY()}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const bars = data?.historical || [];
        // Bars come newest-first; find the earliest bar (first trading day after Friday)
        bars.sort((a, b) => a.date.localeCompare(b.date));
        const firstBar = bars[0];
        if (firstBar?.open) {
          results[ticker] = { open: firstBar.open, date: firstBar.date };
        }
      }
    } catch (e) {
      console.warn(`  ⚠ Failed to fetch Monday open for ${ticker}:`, e.message);
    }
  }
  return results;
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

    // ── Check exits on active positions (stop hit, stale hunt if losing) ────
    // Positions that drop from the top 10 are NOT closed — they stay open
    // and are managed by stops. The portfolio accumulates week over week.
    for (const [ticker, pos] of activePositions) {
      const ks = killScores.find(k => k.ticker === ticker);
      const currentPrice = ks?.currentPrice || pos.currentPrice || pos.entryPrice;

      const isLong      = pos.direction === 'LONG';
      const filledArr   = Object.values(pos.fills).filter(f => f?.filled && f?.price && f?.shares);
      const totalShares = filledArr.reduce((s, f) => s + f.shares, 0);
      const totalCost   = filledArr.reduce((s, f) => s + f.shares * f.price, 0);
      if (totalShares === 0) { activePositions.delete(ticker); continue; }

      const avgCost = totalCost / totalShares;

      // Check stop hit
      let exitReason = null;
      let exitPrice  = null;
      if (isLong && currentPrice <= pos.stopPrice) {
        exitReason = 'STOP_HIT';
        exitPrice  = pos.stopPrice;
      } else if (!isLong && currentPrice >= pos.stopPrice) {
        exitReason = 'STOP_HIT';
        exitPrice  = pos.stopPrice;
      }

      // Check BE/SE signal — LONG exits on signal flip to SS/BE, SHORT on flip to BL/SE
      // In kill scores, the signal field reflects the current state machine output.
      // A LONG entered on BL should exit if the ticker now shows BE (or flipped to SS).
      // A SHORT entered on SS should exit if the ticker now shows SE (or flipped to BL).
      if (!exitReason && ks) {
        const curSignal = ks.signal;
        if (isLong && (curSignal === 'BE' || curSignal === 'SS')) {
          exitReason = 'SIGNAL';
          exitPrice  = currentPrice;
        } else if (!isLong && (curSignal === 'SE' || curSignal === 'BL')) {
          exitReason = 'SIGNAL';
          exitPrice  = currentPrice;
        }
      }

      // Check stale hunt (Day 20+) — only close if losing
      if (!exitReason) {
        const entryDate = pos.fills[1]?.date;
        const holdingWeeks = entryDate
          ? Math.round((new Date(weekOf) - new Date(entryDate)) / (7 * 24 * 60 * 60 * 1000))
          : 0;
        const holdingDays = holdingWeeks * 5;
        if (holdingDays >= 20) {
          const profitable = isLong ? currentPrice > avgCost : currentPrice < avgCost;
          if (!profitable) {
            exitReason = 'STALE_HUNT';
            exitPrice  = currentPrice;
          }
        }
      }

      if (!exitReason) {
        // Update current price for tracking
        pos.currentPrice = currentPrice;
        continue;
      }

      // Close the position
      const profitPct    = isLong ? ((exitPrice - avgCost) / avgCost) * 100 : ((avgCost - exitPrice) / avgCost) * 100;
      const profitDollar = isLong ? (exitPrice - avgCost) * totalShares : (avgCost - exitPrice) * totalShares;
      const entryDate    = pos.fills[1]?.date;
      const holdingWeeks = entryDate ? Math.round((new Date(weekOf) - new Date(entryDate)) / (7 * 24 * 60 * 60 * 1000)) : 1;

      await db.collection('pnthr_portfolio').updateOne(
        { id: pos.id, ownerId: DEMO_OWNER_ID },
        {
          $set: {
            status: 'CLOSED', currentPrice: exitPrice, closedAt: new Date(weekOf + 'T20:15:00Z'),
            updatedAt: new Date(weekOf + 'T20:15:00Z'),
            outcome: {
              exitPrice, profitPct: +profitPct.toFixed(2), profitDollar: +profitDollar.toFixed(2),
              holdingDays: holdingWeeks * 5, exitReason,
            },
          },
        }
      );

      await db.collection('pnthr_journal').updateOne(
        { positionId: pos.id, ownerId: DEMO_OWNER_ID },
        {
          $set: {
            'performance.status': 'CLOSED',
            'performance.avgExitPrice': exitPrice,
            'performance.totalPnlDollar': +profitDollar.toFixed(2),
            'performance.realizedPnlDollar': +profitDollar.toFixed(2),
            'performance.remainingShares': 0,
            exits: [{ reason: exitReason, price: exitPrice, date: new Date(weekOf + 'T20:15:00Z'),
              shares: totalShares, pnlDollar: +profitDollar.toFixed(2), pnlPct: +profitPct.toFixed(2) }],
            updatedAt: new Date(weekOf + 'T20:15:00Z'),
          },
        }
      );

      nav += profitDollar;
      activePositions.delete(ticker);
      totalClosed++;
      console.log(`  CLOSED ${ticker} (${exitReason}) — ${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(1)}% ($${profitDollar.toFixed(0)})`);
    }

    // ── Open new positions for top 10 we don't hold ─────────────────────────
    // Fetch Monday opening prices — we enter at Monday open, not Friday close
    const newTickers = top10.filter(k => !activePositions.has(k.ticker)).map(k => k.ticker);
    const mondayDate = getNextMonday(weekOf);
    const mondayIsInFuture = new Date(mondayDate + 'T12:00:00Z') > new Date();
    const mondayPrices = (newTickers.length > 0 && !mondayIsInFuture)
      ? await fetchMondayOpenPrices(newTickers, weekOf)
      : {};

    for (const k of top10) {
      if (activePositions.has(k.ticker)) continue;

      // Use Monday open price; fall back to Friday's Kill price if FMP data unavailable
      // If Monday hasn't happened yet, leave Lot 1 unfilled for live engine to fill
      const mondayData = mondayPrices[k.ticker];
      const entryPrice = mondayData?.open || k.currentPrice;
      const entryDate  = mondayData?.date || mondayDate;
      if (!entryPrice) continue;

      const lot1Filled = !mondayIsInFuture; // Only fill if Monday has passed

      if (mondayData?.open) {
        console.log(`  📊 ${k.ticker}: Friday $${k.currentPrice?.toFixed(2)} → Monday open $${mondayData.open.toFixed(2)} (${mondayData.date})`);
      } else if (mondayIsInFuture) {
        console.log(`  ⏳ ${k.ticker}: Lot 1 pending — Monday open not yet available`);
      }

      const isLong    = k.signal === 'BL';
      const direction = isLong ? 'LONG' : 'SHORT';

      // Conservative 3% stop from Monday's open price
      const stopPrice = isLong
        ? +(entryPrice * 0.97).toFixed(2)
        : +(entryPrice * 1.03).toFixed(2);

      const sized = serverSizePosition({ nav, entryPrice, stopPrice, riskPct: DEMO_RISK_PCT });
      if (!sized || sized.totalShares <= 0) continue;

      const totalShares = sized.totalShares;
      const lot1Shares  = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));
      const posId       = genId();

      const fills = {
        1: lot1Filled
          ? { filled: true, price: entryPrice, shares: lot1Shares, date: entryDate }
          : { filled: false, shares: lot1Shares },
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

  // ── Final price refresh: update all active positions with live market prices ─
  console.log('\nRefreshing active positions with live market prices...');
  const activeFinal = await db.collection('pnthr_portfolio')
    .find({ ownerId: DEMO_OWNER_ID, status: { $ne: 'CLOSED' } })
    .toArray();
  const liveTickers = [...new Set(activeFinal.map(p => p.ticker))];
  if (liveTickers.length > 0) {
    const liveQuotes = {};
    for (let i = 0; i < liveTickers.length; i += 20) {
      const batch = liveTickers.slice(i, i + 20);
      try {
        const url = `${FMP_BASE}/quote/${batch.join(',')}?apikey=${FMP_API_KEY()}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          for (const q of data) {
            liveQuotes[q.symbol] = q.price;
          }
        }
      } catch (e) {
        console.warn(`  ⚠ Live quote batch failed:`, e.message);
      }
    }
    let priceUpdates = 0;
    for (const p of activeFinal) {
      const livePrice = liveQuotes[p.ticker];
      if (livePrice && livePrice !== p.currentPrice) {
        await db.collection('pnthr_portfolio').updateOne(
          { id: p.id, ownerId: DEMO_OWNER_ID },
          { $set: { currentPrice: livePrice, updatedAt: new Date() } }
        );
        priceUpdates++;
      }
    }
    console.log(`  Updated ${priceUpdates}/${activeFinal.length} positions with live prices`);
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
