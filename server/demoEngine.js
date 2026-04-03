// server/demoEngine.js
// ── PNTHR Demo Fund Engine ──────────────────────────────────────────────────
//
// Auto-trades the Kill top 10 for ownerId='demo_fund'.
// Uses the same collections (pnthr_portfolio, pnthr_journal) with a dedicated
// ownerId so ALL existing code paths (Command Center, Journal, Assistant)
// render demo data identically to real data.
//
// Called by fridayPipeline.js after the real pipeline completes.
// Also runs a 15-min price update loop when demo mode is active.
//
// NAV tracks cumulatively from a ~$10M seed, adjusted by realized P&L.
// ─────────────────────────────────────────────────────────────────────────────

import { connectToDatabase } from './database.js';
import { serverSizePosition, buildServerLotConfig, STRIKE_PCT, LOT_OFFSETS } from './killTestSettings.js';
import { getSignals } from './signalService.js';
import { getLastFriday } from './technicalUtils.js';
import { createJournalEntry } from './journalService.js';

export const DEMO_OWNER_ID  = 'demo_fund';
const DEMO_SEED_NAV         = 9_847_312.64;   // Irregular seed — looks real
const DEMO_RISK_PCT         = 1;               // 1% risk per trade
const LOT_TIME_GATE_DAYS    = 5;               // 5 trading days before Lot 2
const STALE_HUNT_LIMIT      = 20;              // Max trading days before liquidation
const FMP_API_KEY           = () => process.env.FMP_API_KEY;
const FMP_BASE              = 'https://financialmodelingprep.com/api/v3';

// ── Helpers ──────────────────────────────────────────────────────────────────

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function tradingDaysSince(dateStr) {
  if (!dateStr) return 0;
  const start = new Date(dateStr);
  const end   = new Date();
  let count   = 0;
  const d     = new Date(start);
  while (d < end) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

// Fetch current quotes from FMP in batches
async function fetchQuotes(tickers) {
  if (!tickers.length) return {};
  const quotes = {};
  const batches = [];
  for (let i = 0; i < tickers.length; i += 20) {
    batches.push(tickers.slice(i, i + 20));
  }
  for (const batch of batches) {
    try {
      const url = `${FMP_BASE}/quote/${batch.join(',')}?apikey=${FMP_API_KEY()}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        for (const q of data) {
          quotes[q.symbol] = {
            price: q.price,
            dayHigh: q.dayHigh,
            dayLow: q.dayLow,
          };
        }
      }
    } catch (e) {
      console.warn('[DemoEngine] Quote fetch failed:', e.message);
    }
  }
  return quotes;
}

// ── Get or Create Demo NAV Profile ───────────────────────────────────────────

async function getDemoNav(db) {
  const profile = await db.collection('user_profiles').findOne({ userId: DEMO_OWNER_ID });
  if (profile) return profile.accountSize || DEMO_SEED_NAV;
  // First time — create demo profile
  await db.collection('user_profiles').insertOne({
    userId:      DEMO_OWNER_ID,
    email:       'demo@pnthr.fund',
    role:        'member',
    accountSize: DEMO_SEED_NAV,
    defaultPage: 'command',
    createdAt:   new Date(),
  });
  return DEMO_SEED_NAV;
}

async function updateDemoNav(db, newNav) {
  await db.collection('user_profiles').updateOne(
    { userId: DEMO_OWNER_ID },
    { $set: { accountSize: +(newNav.toFixed(2)), updatedAt: new Date() } },
    { upsert: true }
  );
}

// ── Core: Open New Positions from Kill Top 10 ────────────────────────────────

async function openDemoPositions(db, killScores, regime, nav) {
  // Get current active demo positions
  const active = await db.collection('pnthr_portfolio')
    .find({ ownerId: DEMO_OWNER_ID, status: { $ne: 'CLOSED' } })
    .toArray();
  const activeTickers = new Set(active.map(p => p.ticker));

  // Kill top 10 that we don't already hold
  const top10 = killScores
    .filter(k => k.killRank && k.killRank <= 10 && !activeTickers.has(k.ticker))
    .sort((a, b) => a.killRank - b.killRank);

  if (top10.length === 0) return [];

  // Fetch current prices
  const quotes = await fetchQuotes(top10.map(k => k.ticker));
  const opened = [];

  for (const k of top10) {
    const quote = quotes[k.ticker];
    if (!quote?.price) continue;

    const entryPrice = quote.price;
    const isLong     = k.signal === 'BL';
    const direction  = isLong ? 'LONG' : 'SHORT';

    // Compute stop from signal data in kill scores
    // Use a conservative 3% structural stop if no signal stop available
    const fallbackStop = isLong
      ? +(entryPrice * 0.97).toFixed(2)
      : +(entryPrice * 1.03).toFixed(2);
    const stopPrice = fallbackStop;

    // Size the position
    const sized = serverSizePosition({
      nav,
      entryPrice,
      stopPrice,
      riskPct: DEMO_RISK_PCT,
    });
    if (!sized || sized.totalShares <= 0) continue;

    const totalShares = sized.totalShares;
    const lot1Shares  = Math.max(1, Math.round(totalShares * STRIKE_PCT[0]));

    const posId    = genId();
    const entryDate = todayStr();

    const fills = {
      1: { filled: true,  price: entryPrice, shares: lot1Shares, date: entryDate },
      2: { filled: false },
      3: { filled: false },
      4: { filled: false },
      5: { filled: false },
    };

    const position = {
      id:            posId,
      ticker:        k.ticker,
      direction,
      entryPrice,
      originalStop:  stopPrice,
      stopPrice,
      currentPrice:  entryPrice,
      fills,
      sector:        k.sector || null,
      exchange:      k.exchange || null,
      signal:        k.signal,
      signalAge:     k.signalAge ?? 0,
      entryContext:  'CONFIRMED_SIGNAL',
      killScore:     k.totalScore ?? k.apexScore ?? null,
      killTier:      k.tier || null,
      isETF:         false,
      maxGapPct:     0,
      status:        'ACTIVE',
      ownerId:       DEMO_OWNER_ID,
      outcome:       { exitPrice: null, profitPct: null, profitDollar: null, holdingDays: null, exitReason: null },
      createdAt:     new Date(),
      updatedAt:     new Date(),
    };

    try {
      await db.collection('pnthr_portfolio').insertOne(position);

      // Create journal entry
      const enrichment = {
        killScoreAtEntry: { rank: k.killRank, totalScore: k.totalScore, tier: k.tier },
        marketAtEntry: regime ? {
          spyPosition:    regime.spyAboveEma ? 'above' : 'below',
          qqqPosition:    regime.qqqAboveEma ? 'above' : 'below',
          sectorPosition: null,
          regime:         { label: regime.spyAboveEma ? 'BULL_TREND' : 'BEAR_TREND' },
        } : null,
        signal:              k.signal,
        signalAge:           k.signalAge ?? 0,
        exchange:            k.exchange || null,
        navAtEntry:          nav,
        analyzeScoreAtEntry: null,
        entryContext:        'CONFIRMED_SIGNAL',
        dataSource:          'DEMO_ENGINE',
      };

      try {
        await createJournalEntry(db, position, DEMO_OWNER_ID, null, null, null, enrichment);
      } catch (je) {
        console.warn(`[DemoEngine] Journal entry failed for ${k.ticker}:`, je.message);
      }

      opened.push(k.ticker);
    } catch (e) {
      // Duplicate key = already exists, skip silently
      if (e.code !== 11000) console.warn(`[DemoEngine] Failed to open ${k.ticker}:`, e.message);
    }
  }

  if (opened.length > 0) {
    console.log(`[DemoEngine] Opened ${opened.length} positions: ${opened.join(', ')}`);
  }
  return opened;
}

// ── Core: Check Lot Fills on Active Positions ────────────────────────────────

async function checkLotFills(db, positions, quotes) {
  let fillCount = 0;

  for (const p of positions) {
    const quote = quotes[p.ticker];
    if (!quote?.price) continue;

    const price  = quote.price;
    const isLong = p.direction === 'LONG';
    const anchor = p.fills?.[1]?.price || p.entryPrice;
    const lot1Date = p.fills?.[1]?.date || p.createdAt?.toISOString?.()?.split('T')[0];
    const daysSinceLot1 = tradingDaysSince(lot1Date);

    // Compute total shares from sizing
    const sized = serverSizePosition({
      nav: await getDemoNav(db),
      entryPrice: anchor,
      stopPrice:  p.stopPrice,
      riskPct:    DEMO_RISK_PCT,
    });
    if (!sized) continue;
    const totalShares = sized.totalShares;

    let updated = false;

    for (let lot = 2; lot <= 5; lot++) {
      const fill = p.fills?.[lot];
      if (fill?.filled) continue; // Already filled

      // Check if prior lot is filled (lots fill sequentially)
      const priorFill = p.fills?.[lot - 1];
      if (!priorFill?.filled) break; // Prior lot not filled, stop checking

      // Lot 2 has a 5-day time gate
      if (lot === 2 && daysSinceLot1 < LOT_TIME_GATE_DAYS) break;

      // Calculate trigger price
      const offset = LOT_OFFSETS[lot - 1];
      const triggerPrice = isLong
        ? +(anchor * (1 + offset)).toFixed(2)
        : +(anchor * (1 - offset)).toFixed(2);

      // Check if price has reached trigger
      const triggered = isLong
        ? price >= triggerPrice
        : price <= triggerPrice;

      if (!triggered) break; // Price hasn't reached this lot, stop

      // Fill the lot
      const lotShares = Math.max(1, Math.round(totalShares * STRIKE_PCT[lot - 1]));
      const updates = {
        [`fills.${lot}`]: {
          filled: true,
          price:  triggerPrice,
          shares: lotShares,
          date:   todayStr(),
        },
        updatedAt: new Date(),
      };

      // Ratchet stop after Lot 2+ fills (to avg cost / breakeven)
      if (lot >= 2) {
        const allFills = { ...p.fills };
        allFills[lot] = { filled: true, price: triggerPrice, shares: lotShares };
        let cumCost = 0, cumShr = 0;
        for (let n = 1; n <= 5; n++) {
          const f = allFills[n];
          if (f?.filled && f?.price && f?.shares) {
            cumCost += f.shares * f.price;
            cumShr  += f.shares;
          }
        }
        if (cumShr > 0) {
          const avgCost  = +(cumCost / cumShr).toFixed(2);
          const newStop  = avgCost;
          const safeStop = isLong
            ? Math.max(p.stopPrice, newStop)
            : Math.min(p.stopPrice, newStop);
          updates.stopPrice = safeStop;
        }
      }

      await db.collection('pnthr_portfolio').updateOne(
        { id: p.id, ownerId: DEMO_OWNER_ID },
        { $set: updates }
      );

      // Update local copy for subsequent lot checks
      p.fills[lot] = updates[`fills.${lot}`];
      if (updates.stopPrice) p.stopPrice = updates.stopPrice;

      fillCount++;
      console.log(`[DemoEngine] Lot ${lot} filled: ${p.ticker} @ $${triggerPrice}`);
    }
  }

  return fillCount;
}

// ── Core: Check Exit Conditions ──────────────────────────────────────────────

async function checkExits(db, positions, quotes) {
  let nav = await getDemoNav(db);
  const closed = [];

  // Fetch current signals for all position tickers to check for BE/SE
  const tickers = positions.map(p => p.ticker);
  let signals = {};
  try {
    signals = await getSignals(tickers);
  } catch (e) {
    console.warn('[DemoEngine] Signal fetch failed:', e.message);
  }

  for (const p of positions) {
    const quote = quotes[p.ticker];
    if (!quote?.price) continue;

    const price  = quote.price;
    const isLong = p.direction === 'LONG';
    let exitReason = null;
    let exitPrice  = null;

    // 1. Stop hit
    if (isLong && price <= p.stopPrice) {
      exitReason = 'STOP_HIT';
      exitPrice  = p.stopPrice;
    } else if (!isLong && price >= p.stopPrice) {
      exitReason = 'STOP_HIT';
      exitPrice  = p.stopPrice;
    }

    // 2. BE/SE signal — LONG exits on BE, SHORT exits on SE
    if (!exitReason) {
      const sig = signals[p.ticker]?.signal;
      if (isLong && sig === 'BE') {
        exitReason = 'SIGNAL';
        exitPrice  = price;
      } else if (!isLong && sig === 'SE') {
        exitReason = 'SIGNAL';
        exitPrice  = price;
      }
    }

    // 3. Stale hunt (Day 20+) — only close LOSING positions; let winners run
    if (!exitReason) {
      const lot1Date = p.fills?.[1]?.date || p.createdAt?.toISOString?.()?.split('T')[0];
      const days = tradingDaysSince(lot1Date);
      if (days >= STALE_HUNT_LIMIT) {
        const filledArr = Object.values(p.fills || {}).filter(f => f?.filled && f?.price && f?.shares);
        const totalCost = filledArr.reduce((s, f) => s + f.shares * f.price, 0);
        const totalShr  = filledArr.reduce((s, f) => s + f.shares, 0);
        if (totalShr > 0) {
          const avgCost = totalCost / totalShr;
          const profitable = isLong ? price > avgCost : price < avgCost;
          if (!profitable) {
            exitReason = 'STALE_HUNT';
            exitPrice  = price;
          }
        }
      }
    }

    if (!exitReason) continue;

    // Calculate P&L
    const filledArr = Object.values(p.fills || {}).filter(f => f?.filled && f?.price && f?.shares);
    const totalShares = filledArr.reduce((s, f) => s + f.shares, 0);
    const totalCost   = filledArr.reduce((s, f) => s + f.shares * f.price, 0);
    if (totalShares === 0) continue;

    const avgCost    = totalCost / totalShares;
    const profitPct  = isLong
      ? ((exitPrice - avgCost) / avgCost) * 100
      : ((avgCost - exitPrice) / avgCost) * 100;
    const profitDollar = isLong
      ? (exitPrice - avgCost) * totalShares
      : (avgCost - exitPrice) * totalShares;

    const lot1Date = p.fills?.[1]?.date || p.createdAt?.toISOString?.()?.split('T')[0];
    const holdingDays = tradingDaysSince(lot1Date);

    // Close the position
    await db.collection('pnthr_portfolio').updateOne(
      { id: p.id, ownerId: DEMO_OWNER_ID },
      {
        $set: {
          status:       'CLOSED',
          currentPrice: exitPrice,
          closedAt:     new Date(),
          updatedAt:    new Date(),
          outcome: {
            exitPrice,
            profitPct:    +profitPct.toFixed(2),
            profitDollar: +profitDollar.toFixed(2),
            holdingDays,
            exitReason,
          },
        },
      }
    );

    // Update NAV
    nav += profitDollar;
    await updateDemoNav(db, nav);

    // Update journal entry
    try {
      await db.collection('pnthr_journal').updateOne(
        { positionId: p.id, ownerId: DEMO_OWNER_ID },
        {
          $set: {
            'performance.status':          'CLOSED',
            'performance.avgExitPrice':    exitPrice,
            'performance.totalPnlDollar':  +profitDollar.toFixed(2),
            'performance.realizedPnlDollar': +profitDollar.toFixed(2),
            'performance.remainingShares': 0,
            exits: [{
              reason: exitReason,
              price:  exitPrice,
              date:   new Date(),
              shares: totalShares,
              pnlDollar: +profitDollar.toFixed(2),
              pnlPct:    +profitPct.toFixed(2),
            }],
            updatedAt: new Date(),
          },
        }
      );
    } catch (je) {
      console.warn(`[DemoEngine] Journal close failed for ${p.ticker}:`, je.message);
    }

    closed.push(`${p.ticker} (${exitReason}, ${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(1)}%)`);
  }

  if (closed.length > 0) {
    console.log(`[DemoEngine] Closed ${closed.length}: ${closed.join(', ')}`);
  }
  return closed;
}

// ── Friday Update: Called After Kill Pipeline ────────────────────────────────

export async function updateDemoPortfolio() {
  const start = Date.now();
  console.log('\n[DemoEngine] ── Friday Demo Portfolio Update ──');

  const db = await connectToDatabase();
  if (!db) { console.error('[DemoEngine] No DB'); return; }

  const weekOf = getLastFriday();

  // 1. Load this week's Kill scores
  const killScores = await db.collection('pnthr_kill_scores')
    .find({ weekOf })
    .sort({ killRank: 1 })
    .toArray();
  if (killScores.length === 0) {
    console.warn('[DemoEngine] No Kill scores for', weekOf);
    return;
  }

  // 2. Load regime
  const regime = await db.collection('pnthr_kill_regime')
    .findOne({}, { sort: { weekOf: -1 } });

  // 3. Get current NAV
  let nav = await getDemoNav(db);
  console.log(`[DemoEngine] NAV: $${nav.toLocaleString()}`);

  // 4. Get active positions
  const active = await db.collection('pnthr_portfolio')
    .find({ ownerId: DEMO_OWNER_ID, status: { $ne: 'CLOSED' } })
    .toArray();

  // 5. Fetch quotes for all relevant tickers
  const allTickers = new Set([
    ...active.map(p => p.ticker),
    ...killScores.filter(k => k.killRank && k.killRank <= 10).map(k => k.ticker),
  ]);
  const quotes = await fetchQuotes([...allTickers]);

  // 6. Check exits on ALL active positions (stop hit, stale hunt if losing)
  // Positions that drop from the top 10 are NOT closed — they stay open
  // and are managed by stops. The portfolio accumulates week over week.
  await checkExits(db, active, quotes);

  // 8. Refresh NAV after exits
  nav = await getDemoNav(db);

  // 9. Open new positions for top 10 tickers we don't hold
  await openDemoPositions(db, killScores, regime, nav);

  // 10. Check lot fills on all active positions
  const activeAfter = await db.collection('pnthr_portfolio')
    .find({ ownerId: DEMO_OWNER_ID, status: { $ne: 'CLOSED' } })
    .toArray();
  await checkLotFills(db, activeAfter, quotes);

  // 11. Update demo watchlist (Kill ranks 11-17)
  await updateDemoWatchlist(db, killScores);

  // 12. Save portfolio return snapshot
  const finalNav = await getDemoNav(db);
  try {
    const last  = await db.collection('pnthr_portfolio_returns').findOne({ ownerId: DEMO_OWNER_ID }, { sort: { date: -1 } });
    const first = await db.collection('pnthr_portfolio_returns').findOne({ ownerId: DEMO_OWNER_ID }, { sort: { date: 1 } });
    const prevNav      = last?.nav || DEMO_SEED_NAV;
    const inceptionNav = first?.nav || DEMO_SEED_NAV;
    const weeklyReturn     = ((finalNav - prevNav) / prevNav) * 100;
    const cumulativeReturn = ((finalNav - inceptionNav) / inceptionNav) * 100;
    await db.collection('pnthr_portfolio_returns').insertOne({
      ownerId: DEMO_OWNER_ID,
      date: new Date(),
      nav: finalNav,
      weeklyReturn:     +weeklyReturn.toFixed(4),
      cumulativeReturn: +cumulativeReturn.toFixed(4),
    });
  } catch { /* non-fatal */ }

  console.log(`[DemoEngine] Complete in ${((Date.now() - start) / 1000).toFixed(1)}s | NAV: $${finalNav.toLocaleString()}`);
}

// ── 15-min Price Refresh (for demo mode live feel) ───────────────────────────

export async function refreshDemoPrices() {
  const db = await connectToDatabase();
  if (!db) return;

  const active = await db.collection('pnthr_portfolio')
    .find({ ownerId: DEMO_OWNER_ID, status: { $ne: 'CLOSED' } })
    .toArray();

  if (active.length === 0) return;

  const quotes = await fetchQuotes(active.map(p => p.ticker));

  for (const p of active) {
    const quote = quotes[p.ticker];
    if (!quote?.price) continue;
    await db.collection('pnthr_portfolio').updateOne(
      { id: p.id, ownerId: DEMO_OWNER_ID },
      {
        $set: {
          currentPrice: quote.price,
          dayHigh:      quote.dayHigh,
          dayLow:       quote.dayLow,
          updatedAt:    new Date(),
        },
      }
    );
  }

  // Also check exits and lot fills during price refresh
  await checkExits(db, active, quotes);
  const stillActive = await db.collection('pnthr_portfolio')
    .find({ ownerId: DEMO_OWNER_ID, status: { $ne: 'CLOSED' } })
    .toArray();
  await checkLotFills(db, stillActive, quotes);
}

// ── Demo Watchlist: Kill ranks 11-17 ─────────────────────────────────────────

async function updateDemoWatchlist(db, killScores) {
  const watchTickers = killScores
    .filter(k => k.killRank && k.killRank >= 11 && k.killRank <= 17)
    .map(k => k.ticker);

  // Replace demo watchlist entirely
  await db.collection('watchlists').deleteMany({ userId: DEMO_OWNER_ID });
  if (watchTickers.length > 0) {
    const docs = watchTickers.map(ticker => ({
      userId:    DEMO_OWNER_ID,
      ticker,
      addedAt:   new Date(),
      createdAt: new Date(),
    }));
    await db.collection('watchlists').insertMany(docs);
  }
  console.log(`[DemoEngine] Watchlist updated: ${watchTickers.join(', ')}`);
}

// ── Demo Price Refresh Interval ──────────────────────────────────────────────

let _demoInterval = null;

export function startDemoPriceRefresh() {
  if (_demoInterval) return; // Already running
  console.log('[DemoEngine] Starting 15-min price refresh loop');
  _demoInterval = setInterval(async () => {
    try {
      await refreshDemoPrices();
    } catch (e) {
      console.warn('[DemoEngine] Price refresh error:', e.message);
    }
  }, 15 * 60 * 1000); // 15 minutes
}

export function stopDemoPriceRefresh() {
  if (_demoInterval) {
    clearInterval(_demoInterval);
    _demoInterval = null;
    console.log('[DemoEngine] Stopped price refresh loop');
  }
}
