// server/killTestDailyUpdate.js
// ── PNTHR Kill Test — Daily Price Tracking ────────────────────────────────────
//
// Runs Mon–Fri at 4:30 PM ET (after market close).
// For every active Kill Test appearance, fetches daily OHLC and:
//   1. Checks if any lot trigger prices were hit (intra-day high/low range)
//   2. Checks if the stop price was hit
//   3. Ratchets stop after lot fills (Lot 2+ → avg cost of all filled lots = true breakeven)
//   4. Saves a daily snapshot to the appearance record
//   5. Marks exit if stop is hit (exitReason: 'STOP')
//
// NOTE: Feast Alert (RSI check) runs inside the Friday pipeline, not here,
// because PNTHR uses WEEKLY RSI which is computed during Kill scoring.
//
// Collections updated: pnthr_kill_appearances
// ─────────────────────────────────────────────────────────────────────────────

import { connectToDatabase }   from './database.js';
import {
  getKillTestSettings,
  serverSizePosition,
  buildServerLotConfig,
  computeRatchetedStop,
} from './killTestSettings.js';

const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

// ── Date helpers ──────────────────────────────────────────────────────────────

function getTodayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}

function isWeekday() {
  const day = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return !['Sat', 'Sun'].includes(day);
}

// ── FMP: fetch single day OHLC ────────────────────────────────────────────────
// Returns { date, open, high, low, close, volume } or null
async function fetchDailyOHLC(ticker, dateStr) {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;
  try {
    // Fetch the last 3 trading days to ensure today's bar is included
    const fromDate = new Date(dateStr);
    fromDate.setDate(fromDate.getDate() - 3);
    const from = fromDate.toISOString().split('T')[0];
    const url  = `${FMP_BASE}/historical-price-full/${ticker}?from=${from}&to=${dateStr}&apikey=${key}`;
    const res  = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const hist = data?.historical;
    if (!hist || !hist.length) return null;
    // Return the most recent bar (sorted newest first by FMP)
    return hist[0];
  } catch {
    return null;
  }
}

// ── Compute lot config from CURRENT settings (always recomputed — never cached) ─
// DESIGN INTENT: Share counts are a pure function of (NAV, riskPct, entry, stop).
// We NEVER trust the stored lotConfig.totalShares because the user may have changed
// NAV or riskPct. Changing settings must retroactively rescale all P&L.
// The only historical facts we preserve are: fillDate and fillPrice.
function computeLotConfig(appearance, settings) {
  const { nav, riskPctPerTrade } = settings;
  const entry = appearance.firstAppearancePrice;
  const stop  = appearance.firstStopPrice;
  if (!entry || !stop) return null;

  const sized = serverSizePosition({ nav, entryPrice: entry, stopPrice: stop, riskPct: riskPctPerTrade });
  if (!sized || sized.totalShares <= 0) return null;

  const lots = buildServerLotConfig(sized.totalShares, entry, appearance.signal);
  return {
    nav,
    riskPct:       riskPctPerTrade,
    totalShares:   sized.totalShares,
    maxRiskDollar: sized.maxRiskDollar,
    lots,
  };
}

// ── Ensure initial lot fill DATES exist (date/price only — no shares stored) ──
// Lot 1 is always filled immediately at first appearance.
// We store only (filled, fillDate, fillPrice) — NOT shares or costBasis,
// because those are recomputed from current settings dynamically.
function ensureInitialLotFills(appearance) {
  if (appearance.lotFills) {
    // Strip stale shares/costBasis from stored fills — they will be recomputed
    const cleaned = {};
    for (let i = 1; i <= 5; i++) {
      const k = `lot${i}`;
      const f = appearance.lotFills[k];
      if (f) cleaned[k] = { filled: !!f.filled, fillDate: f.fillDate ?? null, fillPrice: f.fillPrice ?? null };
    }
    return cleaned;
  }
  return {
    lot1: { filled: true,  fillDate: appearance.firstAppearanceDate, fillPrice: appearance.firstAppearancePrice },
    lot2: { filled: false, fillDate: null, fillPrice: null },
    lot3: { filled: false, fillDate: null, fillPrice: null },
    lot4: { filled: false, fillDate: null, fillPrice: null },
    lot5: { filled: false, fillDate: null, fillPrice: null },
  };
}

// ── Process lot triggers for a single day's OHLC bar ─────────────────────────
// Returns updated lotFills (immutable style — new object if changed)
function processLotTriggers(appearance, lotFills, lotConfig, ohlc, today) {
  if (!lotFills || !lotConfig || !ohlc) return { lotFills, newFills: [] };
  const isShort = appearance.signal === 'SS';
  let updated   = { ...lotFills };
  const newFills = [];

  for (let i = 1; i < 5; i++) {  // lots 2–5 (lot 1 always filled at appearance)
    const key     = `lot${i + 1}`;
    const lot     = lotConfig.lots[i];
    const fill    = updated[key];
    if (!fill || fill.filled) continue;

    // Check prior lot is filled (gate: lots must fill in order)
    const priorKey = `lot${i}`;
    if (!updated[priorKey]?.filled) continue;

    // Lot 2 time gate: 5 trading days after lot 1 fill
    if (i === 1) {
      const lot1Date = new Date(updated.lot1.fillDate + 'T12:00:00');
      const todayD   = new Date(today + 'T12:00:00');
      const daysDiff = Math.round((todayD - lot1Date) / (1000 * 60 * 60 * 24));
      const tradingDays = Math.floor(daysDiff * 5 / 7); // rough trading day estimate
      if (tradingDays < 5) continue; // gate not cleared
    }

    // Check if daily price range crossed the trigger
    const trigger = lot.triggerPrice;
    const hit     = isShort
      ? ohlc.low  <= trigger  // SS: price falls to or below trigger
      : ohlc.high >= trigger; // BL: price rises to or above trigger

    if (hit) {
      updated = {
        ...updated,
        [key]: {
          filled:    true,
          fillDate:  today,
          fillPrice: trigger,
          // shares/costBasis intentionally NOT stored — recomputed from settings at query time
        },
      };
      newFills.push({ lotNum: i + 1, fillPrice: trigger, shares: lot.targetShares });
    }
  }

  return { lotFills: updated, newFills };
}

// ── Compute current position metrics from lot fills + current lot config ───────
// shares come from lotConfig (dynamic, based on current NAV)
// prices come from lotFills (historical facts: fillDate, fillPrice)
function computePositionMetrics(lotFills, lotConfig) {
  if (!lotFills || !lotConfig) return { totalShares: 0, totalCost: 0, avgCost: 0, lotsFilledCount: 0 };
  let totalShares = 0, totalCost = 0, lotsFilledCount = 0;
  for (let i = 0; i < 5; i++) {
    const f    = lotFills[`lot${i + 1}`];
    const lot  = lotConfig.lots[i];
    if (f?.filled && lot) {
      const lotShares = lot.targetShares;
      const fillPrice = f.fillPrice ?? lot.triggerPrice;
      totalShares    += lotShares;
      totalCost      += lotShares * fillPrice;
      lotsFilledCount++;
    }
  }
  return {
    totalShares,
    totalCost:  +totalCost.toFixed(2),
    avgCost:    totalShares > 0 ? +(totalCost / totalShares).toFixed(4) : 0,
    lotsFilledCount,
  };
}

// ── Compute P&L ───────────────────────────────────────────────────────────────
function computePnl(avgCost, currentPrice, totalShares, signal) {
  if (!avgCost || !currentPrice || totalShares === 0) return { pnlPct: 0, pnlDollar: 0 };
  const isShort  = signal === 'SS';
  const pnlPct   = isShort
    ? ((avgCost - currentPrice) / avgCost) * 100
    : ((currentPrice - avgCost) / avgCost) * 100;
  const pnlDollar = isShort
    ? (avgCost - currentPrice) * totalShares
    : (currentPrice - avgCost) * totalShares;
  return { pnlPct: +pnlPct.toFixed(4), pnlDollar: +pnlDollar.toFixed(2) };
}

// ── Main daily update ─────────────────────────────────────────────────────────

export async function runKillTestDailyUpdate() {
  if (!isWeekday()) {
    console.log('[KillTest Daily] Weekend — skipping');
    return;
  }

  const today = getTodayET();
  console.log(`\n[KillTest Daily] Running for ${today}...`);

  const db       = await connectToDatabase();
  if (!db) { console.error('[KillTest Daily] DB unavailable'); return; }

  const settings = await getKillTestSettings();
  const appearances = await db.collection('pnthr_kill_appearances')
    .find({ exitDate: null })
    .toArray();

  console.log(`[KillTest Daily] Processing ${appearances.length} active appearances`);

  let processed = 0, stopped = 0, lotsFilled = 0;

  for (const appr of appearances) {
    try {
      const ohlc = await fetchDailyOHLC(appr.ticker, today);
      if (!ohlc) {
        console.warn(`[KillTest Daily] No OHLC for ${appr.ticker}`);
        continue;
      }

      const isShort   = appr.signal === 'SS';
      const lotConfig = computeLotConfig(appr, settings);   // always recomputed from current NAV
      let lotFills    = ensureInitialLotFills(appr);         // historical dates/prices only

      // ── 1. Check lot triggers ─────────────────────────────────────────
      const { lotFills: updatedFills, newFills } = processLotTriggers(
        appr, lotFills, lotConfig, ohlc, today
      );
      lotFills = updatedFills;
      lotsFilled += newFills.length;
      if (newFills.length) {
        console.log(`[KillTest Daily] ${appr.ticker}: Lots filled — ${newFills.map(f => `Lot${f.lotNum}@$${f.fillPrice}`).join(', ')}`);
      }

      // ── 2. Compute new ratcheted stop ─────────────────────────────────
      const currentStop = computeRatchetedStop(
        lotFills,
        appr.firstStopPrice,
        appr.signal
      );

      // ── 3. Check stop hit ─────────────────────────────────────────────
      // SS: stop hit if daily HIGH >= stop (price moved against us)
      // BL: stop hit if daily LOW  <= stop (price moved against us)
      const stopHit = isShort
        ? ohlc.high >= currentStop
        : ohlc.low  <= currentStop;

      // ── 4. Compute position metrics (shares from current NAV, prices from history)
      const { totalShares, totalCost, avgCost, lotsFilledCount } = computePositionMetrics(lotFills, lotConfig);
      const exitPrice = stopHit ? currentStop : null;
      const closePrice = stopHit ? exitPrice : ohlc.close;
      const { pnlPct, pnlDollar } = computePnl(avgCost, closePrice, totalShares, appr.signal);

      // ── 5. Build daily snapshot ───────────────────────────────────────
      const snapshot = {
        date:           today,
        open:           ohlc.open,
        high:           ohlc.high,
        low:            ohlc.low,
        close:          ohlc.close,
        currentStop,
        lotsFilledCount,
        totalShares,
        avgCost,
        pnlPct:         +pnlPct.toFixed(2),
        pnlDollar:      +pnlDollar.toFixed(2),
        stopHit,
        newLotsFilledToday: newFills.length,
      };

      // ── 6. Build update object ────────────────────────────────────────
      const $set = {
        lotConfig,
        lotFills,
        currentStop,
        currentAvgCost:  avgCost,
        currentShares:   totalShares,
        lotsFilledCount,
        lastSeenPrice:   ohlc.close,
        lastSeenDate:    today,
        currentPnlPct:   +pnlPct.toFixed(2),
        currentPnlDollar: +pnlDollar.toFixed(2),
        updatedAt:       new Date(),
      };

      if (stopHit) {
        $set.exitDate   = today;
        $set.exitPrice  = exitPrice;
        $set.exitReason = 'STOP';
        $set.profitPct  = +pnlPct.toFixed(4);
        $set.profitDollar = +pnlDollar.toFixed(2);
        $set.isWinner   = pnlPct > 0;
        $set.holdingWeeks = Math.round(
          (new Date(today) - new Date(appr.firstAppearanceDate + 'T12:00:00')) / (7 * 24 * 60 * 60 * 1000)
        );
        stopped++;
        console.log(`[KillTest Daily] ${appr.ticker} STOPPED OUT @ $${exitPrice} | P&L: ${pnlPct.toFixed(2)}% ($${pnlDollar.toFixed(0)})`);
      }

      await db.collection('pnthr_kill_appearances').updateOne(
        { _id: appr._id },
        {
          $set,
          $push: { dailySnapshots: snapshot },
        }
      );

      processed++;
    } catch (err) {
      console.error(`[KillTest Daily] ${appr.ticker} error:`, err.message);
    }
  }

  console.log(`[KillTest Daily] Done — ${processed} processed, ${lotsFilled} lot triggers, ${stopped} stopped out`);
}

// ── Feast Alert Check (called from Friday pipeline after scoring) ──────────────
// Weekly RSI is available from the scored Kill data on Fridays
export async function checkFeastAlerts(db, scored, weekOf) {
  const appearances = await db.collection('pnthr_kill_appearances')
    .find({ exitDate: null })
    .toArray();
  if (!appearances.length) return;

  const scoredMap = {};
  for (const s of scored) scoredMap[s.ticker] = s;

  let feastCount = 0;
  for (const appr of appearances) {
    const s = scoredMap[appr.ticker];
    if (!s) continue;

    // Get RSI from D6 dimension data
    const rsi = s.scoreDetail?.d6?.rsi ?? s.dimensions?.d6?.rsi ?? null;
    if (rsi == null) continue;

    const isShort = appr.signal === 'SS';
    const feastTriggered = isShort ? rsi <= 15 : rsi >= 85;

    if (!feastTriggered) continue;
    if (appr.feastFired) continue; // already fired

    // Feast: exit 50% of position at Friday close
    const exitPrice = s.currentPrice ?? appr.lastSeenPrice;
    const sharesOut = appr.currentShares ? Math.floor(appr.currentShares * 0.5) : 0;
    const { pnlPct } = computePnl(
      appr.currentAvgCost || appr.firstAppearancePrice,
      exitPrice,
      sharesOut,
      appr.signal
    );

    await db.collection('pnthr_kill_appearances').updateOne(
      { _id: appr._id },
      {
        $set: {
          feastFired:       true,
          feastDate:        weekOf,
          feastRsi:         rsi,
          feastExitPrice:   exitPrice,
          feastExitShares:  sharesOut,
          feastPnlPct:      +pnlPct.toFixed(2),
          // Remaining 50% stays open — not closing full position
          currentShares: appr.currentShares
            ? appr.currentShares - sharesOut
            : null,
          updatedAt: new Date(),
        },
        $push: {
          dailySnapshots: {
            date:         weekOf,
            close:        exitPrice,
            rsi,
            feastTrigger: true,
            feastShares:  sharesOut,
            pnlPct:       +pnlPct.toFixed(2),
          },
        },
      }
    );
    feastCount++;
    console.log(`[KillTest Feast] ${appr.ticker} RSI ${rsi} — exiting 50% (${sharesOut} shr) @ $${exitPrice}`);
  }

  if (feastCount > 0) console.log(`[KillTest Feast] ${feastCount} feast alerts fired`);
}
