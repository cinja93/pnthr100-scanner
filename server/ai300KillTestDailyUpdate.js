// server/ai300KillTestDailyUpdate.js
// ── PNTHR AI 300 Kill Test — Daily Price Tracking ───────────────────────────
//
// Mirrors killTestDailyUpdate.js but operates on pnthr_ai300_kill_appearances.
// Uses AI 300 Kill Test settings (separate NAV/risk params).

import { connectToDatabase } from './database.js';
import {
  serverSizePosition,
  buildServerLotConfig,
  computeRatchetedStop,
} from './killTestSettings.js';
import { getAi300KillTestSettings } from './ai300KillTestSettings.js';

const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

function getTodayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isWeekday() {
  const day = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return !['Sat', 'Sun'].includes(day);
}

async function fetchDailyOHLC(ticker, dateStr) {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;
  try {
    const fromDate = new Date(dateStr);
    fromDate.setDate(fromDate.getDate() - 3);
    const from = fromDate.toISOString().split('T')[0];
    const url  = `${FMP_BASE}/historical-price-full/${ticker}?from=${from}&to=${dateStr}&apikey=${key}`;
    const res  = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const hist = data?.historical;
    if (!hist || !hist.length) return null;
    return hist[0];
  } catch { return null; }
}

function computeLotConfig(appearance, settings) {
  const { nav, riskPctPerTrade } = settings;
  const entry = appearance.firstAppearancePrice;
  const stop  = appearance.firstStopPrice;
  if (!entry || !stop) return null;
  const sized = serverSizePosition({ nav, entryPrice: entry, stopPrice: stop, riskPct: riskPctPerTrade });
  if (!sized || sized.totalShares <= 0) return null;
  const lots = buildServerLotConfig(sized.totalShares, entry, appearance.signal);
  return { nav, riskPct: riskPctPerTrade, totalShares: sized.totalShares, maxRiskDollar: sized.maxRiskDollar, lots };
}

function ensureInitialLotFills(appearance) {
  if (appearance.lotFills) {
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

function processLotTriggers(appearance, lotFills, lotConfig, ohlc, today) {
  if (!lotFills || !lotConfig || !ohlc) return { lotFills, newFills: [] };
  const isShort = appearance.signal === 'SS';
  let updated   = { ...lotFills };
  const newFills = [];

  for (let i = 1; i < 5; i++) {
    const key  = `lot${i + 1}`;
    const lot  = lotConfig.lots[i];
    const fill = updated[key];
    if (!fill || fill.filled) continue;
    const priorKey = `lot${i}`;
    if (!updated[priorKey]?.filled) continue;

    if (i === 1) {
      const lot1Date = new Date(updated.lot1.fillDate + 'T12:00:00');
      const todayD   = new Date(today + 'T12:00:00');
      const daysDiff = Math.round((todayD - lot1Date) / (1000 * 60 * 60 * 24));
      const tradingDays = Math.floor(daysDiff * 5 / 7);
      if (tradingDays < 5) continue;
    }

    const trigger = lot.triggerPrice;
    const hit = isShort ? ohlc.low <= trigger : ohlc.high >= trigger;
    if (hit) {
      updated = { ...updated, [key]: { filled: true, fillDate: today, fillPrice: trigger } };
      newFills.push({ lotNum: i + 1, fillPrice: trigger, shares: lot.targetShares });
    }
  }
  return { lotFills: updated, newFills };
}

function computePositionMetrics(lotFills, lotConfig) {
  if (!lotFills || !lotConfig) return { totalShares: 0, totalCost: 0, avgCost: 0, lotsFilledCount: 0 };
  let totalShares = 0, totalCost = 0, lotsFilledCount = 0;
  for (let i = 0; i < 5; i++) {
    const f   = lotFills[`lot${i + 1}`];
    const lot = lotConfig.lots[i];
    if (f?.filled && lot) {
      const lotShares = lot.targetShares;
      const fillPrice = f.fillPrice ?? lot.triggerPrice;
      totalShares    += lotShares;
      totalCost      += lotShares * fillPrice;
      lotsFilledCount++;
    }
  }
  return { totalShares, totalCost: +totalCost.toFixed(2), avgCost: totalShares > 0 ? +(totalCost / totalShares).toFixed(4) : 0, lotsFilledCount };
}

function computePnl(avgCost, currentPrice, totalShares, signal) {
  if (!avgCost || !currentPrice || totalShares === 0) return { pnlPct: 0, pnlDollar: 0 };
  const isShort  = signal === 'SS';
  const pnlPct   = isShort ? ((avgCost - currentPrice) / avgCost) * 100 : ((currentPrice - avgCost) / avgCost) * 100;
  const pnlDollar = isShort ? (avgCost - currentPrice) * totalShares : (currentPrice - avgCost) * totalShares;
  return { pnlPct: +pnlPct.toFixed(4), pnlDollar: +pnlDollar.toFixed(2) };
}

export async function runAi300KillTestDailyUpdate() {
  if (!isWeekday()) { console.log('[AI300 KillTest Daily] Weekend — skipping'); return; }

  const today = getTodayET();
  console.log(`\n[AI300 KillTest Daily] Running for ${today}...`);

  const db = await connectToDatabase();
  if (!db) { console.error('[AI300 KillTest Daily] DB unavailable'); return; }

  const settings = await getAi300KillTestSettings();
  const appearances = await db.collection('pnthr_ai300_kill_appearances')
    .find({ exitDate: null }).toArray();

  console.log(`[AI300 KillTest Daily] Processing ${appearances.length} active appearances`);

  let processed = 0, stopped = 0, lotsFilled = 0;

  for (const appr of appearances) {
    try {
      const ohlc = await fetchDailyOHLC(appr.ticker, today);
      if (!ohlc) { continue; }

      const isShort   = appr.signal === 'SS';
      const lotConfig = computeLotConfig(appr, settings);
      let lotFills    = ensureInitialLotFills(appr);

      const { lotFills: updatedFills, newFills } = processLotTriggers(appr, lotFills, lotConfig, ohlc, today);
      lotFills = updatedFills;
      lotsFilled += newFills.length;

      const currentStop = computeRatchetedStop(lotFills, appr.firstStopPrice, appr.signal);
      const stopHit = isShort ? ohlc.high >= currentStop : ohlc.low <= currentStop;

      const { totalShares, totalCost, avgCost, lotsFilledCount } = computePositionMetrics(lotFills, lotConfig);
      const exitPrice = stopHit ? currentStop : null;
      const closePrice = stopHit ? exitPrice : ohlc.close;
      const { pnlPct, pnlDollar } = computePnl(avgCost, closePrice, totalShares, appr.signal);

      const snapshot = {
        date: today, open: ohlc.open, high: ohlc.high, low: ohlc.low, close: ohlc.close,
        currentStop, lotsFilledCount, totalShares, avgCost,
        pnlPct: +pnlPct.toFixed(2), pnlDollar: +pnlDollar.toFixed(2),
        stopHit, newLotsFilledToday: newFills.length,
      };

      const $set = {
        lotConfig, lotFills, currentStop,
        currentAvgCost: avgCost, currentShares: totalShares, lotsFilledCount,
        lastSeenPrice: ohlc.close, lastSeenDate: today,
        currentPnlPct: +pnlPct.toFixed(2), currentPnlDollar: +pnlDollar.toFixed(2),
        updatedAt: new Date(),
      };

      if (stopHit) {
        $set.exitDate     = today;
        $set.exitPrice    = exitPrice;
        $set.exitReason   = 'STOP';
        $set.profitPct    = +pnlPct.toFixed(4);
        $set.profitDollar = +pnlDollar.toFixed(2);
        $set.isWinner     = pnlPct > 0;
        $set.holdingWeeks = Math.round((new Date(today) - new Date(appr.firstAppearanceDate + 'T12:00:00')) / (7 * 24 * 60 * 60 * 1000));
        stopped++;
        console.log(`[AI300 KillTest Daily] ${appr.ticker} STOPPED OUT @ $${exitPrice} | P&L: ${pnlPct.toFixed(2)}% ($${pnlDollar.toFixed(0)})`);
      }

      await db.collection('pnthr_ai300_kill_appearances').updateOne(
        { _id: appr._id },
        { $set, $push: { dailySnapshots: snapshot } }
      );
      processed++;
    } catch (err) {
      console.error(`[AI300 KillTest Daily] ${appr.ticker} error:`, err.message);
    }
  }

  console.log(`[AI300 KillTest Daily] Done — ${processed} processed, ${lotsFilled} lot triggers, ${stopped} stopped out`);
}
