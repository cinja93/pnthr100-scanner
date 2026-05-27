/**
 * PNTHR MCE Signal Service (Momentum Continuation Entry) — AI 300 Only
 *
 * Detects daily MCE opportunities for AI 300 stocks with an active weekly BL signal.
 * Strategy: Top 100 by TTM return, daily 2-bar high breakout trigger.
 *
 * Signal = AI 300 ticker + weekly BL active + in top 100 TTM rank + not already held +
 *          today's daily HIGH > max(prev2 daily highs) + $0.01
 *
 * Stop  = current weekly PNTHR stop (from signal cache — already ratcheted to today)
 * Sizing = 1% vitality NAV / rps, 10% ticker cap, 35/25/20/12/8% lot splits
 */

import { getCachedSignals } from './signalService.js';
import { getAiUniverseSignals } from './aiUniverseSignalsService.js';
import { SECTORS as AI_SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { connectToDatabase } from './database.js';
import { STRIKE_PCT, LOT_OFFSETS } from './lotMath.js';

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE    = 'https://financialmodelingprep.com/api/v3';

const TOP_N          = 100;
const SIGNAL_TTL_MS  = 60_000;        // re-entry trigger cache: 60 seconds
const TTM_TTL_MS     = 60 * 60_000;   // TTM rank cache: 1 hour

const AI_TICKER_SET = new Set();
for (const sec of AI_SECTORS) for (const h of sec.holdings) AI_TICKER_SET.add(h.ticker);

// ── TTM rank cache ─────────────────────────────────────────────────────────────
let ttmCache = { at: 0, topAI: null };

async function computeTTMRanks() {
  const db = await connectToDatabase();
  if (!db) return { topAI: new Set() };

  const allAI  = [...AI_TICKER_SET];

  const CHUNK = 100;
  const priceMap = new Map();
  for (let i = 0; i < allAI.length; i += CHUNK) {
    const chunk = allAI.slice(i, i + CHUNK).join(',');
    try {
      const res = await fetch(`${FMP_BASE}/quote/${chunk}?apikey=${FMP_API_KEY}`,
        { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) for (const q of data) priceMap.set(q.symbol, q.price);
      }
    } catch {}
  }

  const today   = new Date();
  const yearAgo = new Date(today);
  yearAgo.setFullYear(today.getFullYear() - 1);
  const yearAgoStr = yearAgo.toISOString().split('T')[0];

  const docs = await db.collection('pnthr_ai_bt_candles')
    .find({ ticker: { $in: allAI } }, { projection: { ticker: 1, daily: 1 } })
    .toArray();
  const ranked = [];
  for (const doc of docs) {
    const todayPrice = priceMap.get(doc.ticker);
    if (!todayPrice) continue;
    const daily = (doc.daily || [])
      .filter(b => b.date >= yearAgoStr)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!daily.length) continue;
    const yearAgoClose = daily[0].close;
    if (!yearAgoClose) continue;
    ranked.push({ ticker: doc.ticker, ttm: (todayPrice - yearAgoClose) / yearAgoClose });
  }
  ranked.sort((a, b) => b.ttm - a.ttm);
  const topAI = new Set(ranked.slice(0, TOP_N).map(x => x.ticker));
  return { topAI };
}

async function getTopN() {
  const now = Date.now();
  if (ttmCache.at && now - ttmCache.at < TTM_TTL_MS && ttmCache.topAI) return ttmCache;
  const ranks = await computeTTMRanks();
  ttmCache = { at: now, ...ranks };
  return ttmCache;
}

// ── Daily bars + trigger check ─────────────────────────────────────────────────
async function fetchLast5Daily(ticker) {
  const from = new Date();
  from.setDate(from.getDate() - 14);
  const fromStr = from.toISOString().split('T')[0];
  try {
    const url = `${FMP_BASE}/historical-price-full/${ticker}?from=${fromStr}&apikey=${FMP_API_KEY}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.historical || [])
      .map(b => ({ time: b.date, high: +b.high, low: +b.low, close: +b.close }))
      .sort((a, b) => a.time.localeCompare(b.time))
      .slice(-5);
  } catch { return null; }
}

function checkTrigger(bars) {
  if (bars.length < 3) return null;
  const last  = bars[bars.length - 1];
  const prev1 = bars[bars.length - 2];
  const prev2 = bars[bars.length - 3];
  const trigger = parseFloat((Math.max(prev1.high, prev2.high) + 0.01).toFixed(2));
  return last.high >= trigger ? trigger : null;
}

// ── Sizing ─────────────────────────────────────────────────────────────────────
function computeLotSizes(entryPrice, stopPrice, nav) {
  const rps = entryPrice - stopPrice;
  if (rps <= 0.01) return null;
  const total = Math.floor(Math.min((nav * 0.01) / rps, (nav * 0.10) / entryPrice));
  if (total < 1) return null;
  return STRIKE_PCT.map(pct => Math.max(1, Math.round(total * pct)));
}

// ── Cooldown gate: tickers with positions closed in the last 24h need a
//    green 1-hour candle (close > open) after the close before re-entering MCE.
const greenBarCache = new Map();   // ticker → { checkedAt, cleared, greenBarTime }
const GREEN_BAR_CACHE_MS = 5 * 60_000;  // re-check FMP every 5 min if not yet cleared

async function fetchHourlyBars(ticker) {
  try {
    const url = `${FMP_BASE}/historical-chart/1hour/${ticker}?apikey=${FMP_API_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function hasGreenBarAfter(ticker, closedAt) {
  const cached = greenBarCache.get(ticker);
  const now = Date.now();
  if (cached) {
    if (cached.cleared) return true;
    if (now - cached.checkedAt < GREEN_BAR_CACHE_MS) return false;
  }
  const bars = await fetchHourlyBars(ticker);
  const closeTime = new Date(closedAt).getTime();
  const found = bars.some(b => {
    const barTime = new Date(b.date).getTime();
    return barTime > closeTime && b.close > b.open;
  });
  greenBarCache.set(ticker, { checkedAt: now, cleared: found, greenBarTime: found ? now : null });
  return found;
}

// ── Re-entry signal cache ──────────────────────────────────────────────────────
let signalCache = { at: 0, signals: [] };

export async function getReentrySignals(ownerId, nav = 100_000) {
  const now = Date.now();
  if (signalCache.at && now - signalCache.at < SIGNAL_TTL_MS) return signalCache.signals;

  try {
    // Merge 679 signal cache + AI Universe signals so AI-only tickers (GEV, etc.)
    // that aren't in the S&P 500/400 still get picked up for MCE re-entry.
    const cached679 = getCachedSignals() || {};
    let aiSignals = {};
    try {
      const aiResult = await getAiUniverseSignals();
      if (aiResult?.signals) {
        for (const [t, s] of Object.entries(aiResult.signals)) {
          aiSignals[t] = {
            signal:     s.signal,
            stopPrice:  s.pnthrStop ?? s.stopPrice ?? null,
            pnthrStop:  s.pnthrStop ?? null,
            signalDate: s.signalDate || null,
          };
        }
      }
    } catch (e) {
      console.warn('[MCE] AI Universe signals fetch failed, using 679 cache only:', e.message);
    }
    // AI signals take precedence (sector-tuned EMA) over 679 for overlapping tickers
    const allSignals = { ...cached679, ...aiSignals };
    if (Object.keys(allSignals).length === 0) return [];

    const db = await connectToDatabase();

    // Active positions this user already holds — skip these tickers
    const held = new Set();
    const closedToday = new Map();  // ticker → closedAt (most recent close in last 24h)
    if (db && ownerId) {
      const pos = await db.collection('pnthr_portfolio')
        .find({ ownerId, status: { $in: ['ACTIVE', 'PARTIAL'] } }, { projection: { ticker: 1 } })
        .toArray();
      for (const p of pos) held.add(p.ticker);

      const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentlyClosed = await db.collection('pnthr_portfolio')
        .find({ ownerId, status: 'CLOSED', closedAt: { $gte: cutoff24h } },
               { projection: { ticker: 1, closedAt: 1 } })
        .toArray();
      for (const p of recentlyClosed) {
        if (held.has(p.ticker)) continue;
        const existing = closedToday.get(p.ticker);
        if (!existing || new Date(p.closedAt) > new Date(existing)) {
          closedToday.set(p.ticker, p.closedAt);
        }
      }
    }

    const { topAI } = await getTopN();

    // Build candidates: AI 300 only — active BL + in top-100 TTM + not held
    const candidates = [];
    for (const [ticker, sig] of Object.entries(allSignals)) {
      if (sig.signal !== 'BL') continue;
      if (held.has(ticker)) continue;
      if (!AI_TICKER_SET.has(ticker)) continue;
      if (!topAI.has(ticker)) continue;
      const weeklyStop = sig.pnthrStop ?? sig.stopPrice;
      if (!weeklyStop) continue;
      candidates.push({ ticker, weeklyStop, fund: 'AI 300', signalDate: sig.signalDate });
    }

    // Check daily trigger in parallel batches of 10
    const results = [];
    const BATCH   = 10;
    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      const resolved = await Promise.all(batch.map(async (c) => {
        const bars    = await fetchLast5Daily(c.ticker);
        if (!bars) return null;
        const trigger = checkTrigger(bars);
        if (!trigger || trigger <= c.weeklyStop) return null;
        const lotShares = computeLotSizes(trigger, c.weeklyStop, nav);
        if (!lotShares) return null;
        return {
          ticker:       c.ticker,
          fund:         c.fund,
          entryTrigger: trigger,
          weeklyStop:   c.weeklyStop,
          rps:          parseFloat((trigger - c.weeklyStop).toFixed(2)),
          lotShares,
          l1Price:      trigger,
          l2Price:      parseFloat((trigger * (1 + LOT_OFFSETS[1])).toFixed(2)),
          l3Price:      parseFloat((trigger * (1 + LOT_OFFSETS[2])).toFixed(2)),
          l4Price:      parseFloat((trigger * (1 + LOT_OFFSETS[3])).toFixed(2)),
          l5Price:      parseFloat((trigger * (1 + LOT_OFFSETS[4])).toFixed(2)),
          signalDate:   c.signalDate,
          topN:         TOP_N,
        };
      }));
      for (const r of resolved) if (r) results.push(r);
    }

    // Dedup: one row per ticker — main MCE candidates win over heat re-entries
    const seenTickers = new Set(results.map(r => r.ticker));

    // ── Heat re-entries: recycled positions that got stopped out ──────────
    // These are manual-only (not auto-executed). They show in the MCE table
    // with a "Heat" badge so the user can decide to re-enter.
    if (db && ownerId) {
      const today = new Date().toISOString().slice(0, 10);
      const heatReentries = await db.collection('pnthr_mce_heat_reentries')
        .find({ ownerId, status: 'PENDING', eligibleDate: { $lte: today } })
        .toArray();
      for (const hr of heatReentries) {
        if (held.has(hr.ticker)) continue;
        if (seenTickers.has(hr.ticker)) continue;
        const sig = allSignals[hr.ticker];
        if (!sig || sig.signal !== 'BL') continue;
        const weeklyStop = sig.pnthrStop ?? sig.stopPrice;
        if (!weeklyStop) continue;
        const bars = await fetchLast5Daily(hr.ticker);
        if (!bars || bars.length === 0) continue;
        const currentPrice = bars[bars.length - 1]?.close || hr.originalEntryPrice;
        if (currentPrice <= weeklyStop) continue;
        const lotShares = computeLotSizes(currentPrice, weeklyStop, nav);
        if (!lotShares) continue;
        results.push({
          ticker:       hr.ticker,
          fund:         'AI 300',
          entryTrigger: currentPrice,
          weeklyStop,
          rps:          parseFloat((currentPrice - weeklyStop).toFixed(2)),
          lotShares,
          l1Price:      currentPrice,
          l2Price:      parseFloat((currentPrice * (1 + LOT_OFFSETS[1])).toFixed(2)),
          l3Price:      parseFloat((currentPrice * (1 + LOT_OFFSETS[2])).toFixed(2)),
          l4Price:      parseFloat((currentPrice * (1 + LOT_OFFSETS[3])).toFixed(2)),
          l5Price:      parseFloat((currentPrice * (1 + LOT_OFFSETS[4])).toFixed(2)),
          signalDate:   sig.signalDate,
          topN:         TOP_N,
          heatReentry:  true,
          heatReentryId: hr._id,
        });
      }
    }

    // ── Cooldown gate: positions closed in last 24h need a green 1H bar ────
    if (closedToday.size > 0) {
      const gated = [];
      for (let i = results.length - 1; i >= 0; i--) {
        const closedAt = closedToday.get(results[i].ticker);
        if (!closedAt) continue;
        const cleared = await hasGreenBarAfter(results[i].ticker, closedAt);
        if (!cleared) {
          gated.push(results[i].ticker);
          results.splice(i, 1);
        } else {
          results[i].reentry = true;
        }
      }
      if (gated.length) console.log(`[MCE Cooldown] gated (no green 1H bar yet): ${gated.join(', ')}`);
    }

    // Final dedup: keep first occurrence of each ticker (MCE trigger > heat re-entry)
    const finalSeen = new Set();
    const deduped = [];
    for (const r of results) {
      if (finalSeen.has(r.ticker)) continue;
      finalSeen.add(r.ticker);
      deduped.push(r);
    }

    // Highest RPS first (most room between entry and stop = more shares = bigger trade)
    deduped.sort((a, b) => b.rps - a.rps);

    signalCache = { at: now, signals: deduped };
    return results;
  } catch (err) {
    console.error('[reentrySignalService]', err.message);
    return signalCache.signals;
  }
}

export function clearReentryCache() {
  signalCache = { at: 0, signals: [] };
  ttmCache    = { at: 0, topAI: null };
  greenBarCache.clear();
}
