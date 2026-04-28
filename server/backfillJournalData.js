// server/backfillJournalData.js
// ── One-time backfill: marketAtEntry, techAtEntry (ATR), mfe, mae ──────────────
// Run from project root: node server/backfillJournalData.js
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config();

import { connectToDatabase } from './database.js';
import { getSectorEtf } from './marketSnapshot.js';
import { getSectorEmaPeriod, REGIME_EMA_PERIOD } from './sectorEmaConfig.js';

const KEY  = process.env.FMP_API_KEY;
const FMP  = 'https://financialmodelingprep.com/api/v3';
const FMP4 = 'https://financialmodelingprep.com/api/v4';

if (!KEY) { console.error('❌ FMP_API_KEY not set in .env'); process.exit(1); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

async function fmpGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${FMP}${path}${sep}apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status}: ${path}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data?.historical || data || []);
}

async function fmp4Get(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${FMP4}${path}${sep}apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP4 ${res.status}: ${path}`);
  return res.json();
}

// Daily OHLCV bars, ascending
async function getDaily(ticker, from, to) {
  const data = await fmpGet(`/historical-price-full/${ticker}?from=${from}&to=${to}`).catch(() => []);
  const rows = Array.isArray(data) ? data : (data?.historical || []);
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

// Most recent value of a technical indicator at or before a target date
// Uses a 40-day lookback so FMP has enough history to calculate ATR/RSI/ADX properly
async function getTechVal(ticker, type, period, date) {
  const from = addDays(date, -40);
  const to   = addDays(date, 1);
  const data = await fmpGet(`/technical_indicator/1day/${ticker}?type=${type}&period=${period}&from=${from}&to=${to}`).catch(() => []);
  const rows = (Array.isArray(data) ? data : [])
    .filter(r => r.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date));
  return rows[0] || null;
}

// EMA at a specific date (pulls 60-day window to ensure enough bars).
// Direction index (SPY/QQQ/MDY) uses 21W; stocks/sector ETFs use OpEMA period.
async function getEmaAtDate(ticker, date, period) {
  const from = addDays(date, -60);
  const to   = addDays(date, 1);
  const data = await fmpGet(`/technical_indicator/1day/${ticker}?type=ema&period=${period}&from=${from}&to=${to}`).catch(() => []);
  const rows = (Array.isArray(data) ? data : [])
    .filter(r => r.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date));
  return rows[0]?.ema ? +Number(rows[0].ema).toFixed(4) : null;
}

// Wilder ATR(14) from a set of ascending bars, at the last bar
function computeAtr14(bars) {
  if (bars.length < 15) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < 14) return null;
  let atr = trs.slice(0, 14).reduce((s, v) => s + v, 0) / 14;
  for (let i = 14; i < trs.length; i++) atr = (atr * 13 + trs[i]) / 14;
  return +atr.toFixed(2);
}

// OBV trend from the last N bars (RISING / DECLINING / FLAT)
function computeObvTrend(bars) {
  if (bars.length < 10) return null;
  let obv = 0;
  const series = [0];
  for (let i = 1; i < bars.length; i++) {
    const chg = bars[i].close - bars[i - 1].close;
    obv += chg > 0 ? bars[i].volume : chg < 0 ? -bars[i].volume : 0;
    series.push(obv);
  }
  const half = Math.floor(series.length / 2);
  const recent = series.slice(-half).reduce((s, v) => s + v, 0) / half;
  const prior  = series.slice(0, half).reduce((s, v) => s + v, 0) / half;
  if (recent > prior * 1.001) return 'RISING';
  if (recent < prior * 0.999) return 'DECLINING';
  return 'FLAT';
}

// 52-week range position (0–100%)
function compute52WkPct(bars, price) {
  if (bars.length < 2) return null;
  const high = Math.max(...bars.map(b => b.high));
  const low  = Math.min(...bars.map(b => b.low));
  return high === low ? null : +((price - low) / (high - low) * 100).toFixed(1);
}

// MFE and MAE from trade bars
function computeMfeMae(bars, entryPrice, direction) {
  const ep = Number(entryPrice);
  if (!bars.length || !ep) return { mfe: null, mae: null };
  let mfePct = 0, maePct = 0, mfePrice = null, maePrice = null;
  for (const bar of bars) {
    const h = Number(bar.high), l = Number(bar.low);
    if (direction === 'LONG') {
      const fav = (h - ep) / ep * 100;
      const adv = (ep - l) / ep * 100;
      if (fav > mfePct) { mfePct = fav; mfePrice = h; }
      if (adv > maePct) { maePct = adv; maePrice = l; }
    } else {
      const fav = (ep - l) / ep * 100;
      const adv = (h - ep) / ep * 100;
      if (fav > mfePct) { mfePct = fav; mfePrice = l; }
      if (adv > maePct) { maePct = adv; maePrice = h; }
    }
  }
  return {
    mfe: mfePrice != null ? { price: +mfePrice.toFixed(4), percent: +mfePct.toFixed(4) } : null,
    mae: maePrice != null ? { price: +maePrice.toFixed(4), percent: +maePct.toFixed(4) } : null,
  };
}

// ── Per-entry backfill ────────────────────────────────────────────────────────

async function backfillEntry(db, entry) {
  const ticker    = entry.ticker;
  const direction = entry.direction || 'LONG';
  const exits     = Array.isArray(entry.exits) ? entry.exits : [];
  const lastExit  = exits[exits.length - 1];
  const entryDate = entry.entry?.fillDate
    ? new Date(entry.entry.fillDate).toISOString().split('T')[0]
    : new Date(entry.createdAt).toISOString().split('T')[0];
  const exitDate  = lastExit?.date
    ? new Date(lastExit.date).toISOString().split('T')[0]
    : entryDate;
  const entryPrice = entry.entry?.fillPrice ?? entry.entryPrice;
  const sector     = entry.sector || null;
  const sectorEtf  = sector ? getSectorEtf(sector) : null;

  console.log(`\n📊 ${ticker}  entry: ${entryDate}  exit: ${exitDate}  dir: ${direction}  sector: ${sector || 'N/A'}`);

  const updates = {};

  // ── 1. Market snapshot at entry ───────────────────────────────────────────
  if (!entry.marketAtEntry?.spyPrice) {
    console.log('  → market snapshot...');
    try {
      const [spyEma, qqqEma, spyBars, qqqBars] = await Promise.all([
        getEmaAtDate('SPY', entryDate, REGIME_EMA_PERIOD),
        getEmaAtDate('QQQ', entryDate, REGIME_EMA_PERIOD),
        getDaily('SPY', addDays(entryDate, -3), addDays(entryDate, 1)),
        getDaily('QQQ', addDays(entryDate, -3), addDays(entryDate, 1)),
      ]);

      const snap  = { ...(entry.marketAtEntry || {}) };
      const spyBar = spyBars.filter(b => b.date <= entryDate).at(-1);
      const qqqBar = qqqBars.filter(b => b.date <= entryDate).at(-1);

      if (spyBar) {
        snap.spyPrice    = spyBar.close;
        snap.spyChange1D = spyBar.changePercent != null ? +Number(spyBar.changePercent).toFixed(2) : null;
        if (spyEma) {
          snap.spyEma21    = spyEma;
          snap.spyVsEma    = +((spyBar.close - spyEma) / spyEma * 100).toFixed(2);
          snap.spyPosition = spyBar.close > spyEma ? 'above' : 'below';
        }
      }
      if (qqqBar) {
        snap.qqqPrice    = qqqBar.close;
        snap.qqqChange1D = qqqBar.changePercent != null ? +Number(qqqBar.changePercent).toFixed(2) : null;
        if (qqqEma) {
          snap.qqqEma21    = qqqEma;
          snap.qqqVsEma    = +((qqqBar.close - qqqEma) / qqqEma * 100).toFixed(2);
          snap.qqqPosition = qqqBar.close > qqqEma ? 'above' : 'below';
        }
      }
      if (snap.spyPosition && snap.qqqPosition) {
        snap.regime = snap.spyPosition === 'above' && snap.qqqPosition === 'above' ? 'BULLISH'
                    : snap.spyPosition === 'below' && snap.qqqPosition === 'below' ? 'BEARISH' : 'MIXED';
      } else if (snap.spyPosition) {
        snap.regime = snap.spyPosition === 'above' ? 'BULLISH' : 'BEARISH';
      }

      // Sector ETF
      if (sectorEtf) {
        const [sectEma, sectBars] = await Promise.all([
          getEmaAtDate(sectorEtf, entryDate, getSectorEmaPeriod(sector)),
          getDaily(sectorEtf, addDays(entryDate, -3), addDays(entryDate, 1)),
        ]);
        const sectBar = sectBars.filter(b => b.date <= entryDate).at(-1);
        if (sectBar) {
          snap.sectorEtf      = sectorEtf;
          snap.sectorPrice    = sectBar.close;
          snap.sectorChange1D = sectBar.changePercent != null ? +Number(sectBar.changePercent).toFixed(2) : null;
          if (sectEma) {
            snap.sectorVsEma    = +((sectBar.close - sectEma) / sectEma * 100).toFixed(2);
            snap.sectorPosition = sectBar.close > sectEma ? 'above' : 'below';
          }
        }
      }

      // Treasury yields
      try {
        const tData = await fmp4Get(`/treasury?from=${addDays(entryDate, -5)}&to=${addDays(entryDate, 1)}`);
        const tRow  = (Array.isArray(tData) ? tData : [])
          .filter(r => r.date <= entryDate)
          .sort((a, b) => b.date.localeCompare(a.date))[0];
        if (tRow) {
          snap.treasury2Y  = tRow.year2  != null ? +Number(tRow.year2).toFixed(3)  : null;
          snap.treasury10Y = tRow.year10 != null ? +Number(tRow.year10).toFixed(3) : null;
          snap.treasury30Y = tRow.year30 != null ? +Number(tRow.year30).toFixed(3) : null;
          if (snap.treasury2Y != null && snap.treasury10Y != null)
            snap.spread2Y10Y = +((snap.treasury10Y - snap.treasury2Y).toFixed(3));
        }
      } catch (e) { console.warn('  ⚠ treasury:', e.message); }

      updates.marketAtEntry = snap;
      console.log(`  ✓ SPY=${snap.spyPrice} (${snap.spyPosition}), QQQ=${snap.qqqPrice} (${snap.qqqPosition}), regime=${snap.regime}`);
      if (sectorEtf) console.log(`  ✓ ${sectorEtf}=${snap.sectorPrice} (${snap.sectorPosition ?? 'no EMA'})`);
    } catch (e) { console.warn('  ⚠ market snapshot failed:', e.message); }
  } else {
    console.log('  ✓ market snapshot already present');
  }

  // ── 2. Technical snapshot at entry (ATR, RSI, ADX, OBV, vol ratio) ────────
  if (!entry.techAtEntry?.atr14) {
    console.log('  → technical snapshot...');
    try {
      const [rsiRow, adxRow] = await Promise.all([
        getTechVal(ticker, 'rsi', 14, entryDate),
        getTechVal(ticker, 'adx', 14, entryDate),
      ]);

      // Daily bars for ATR (calculated manually), OBV, 52wk%, volume ratio
      const bars252 = await getDaily(ticker, addDays(entryDate, -280), addDays(entryDate, 1));
      const barsAtEntry = bars252.filter(b => b.date <= entryDate);
      const lastBar     = barsAtEntry.at(-1);

      const tech = { ...(entry.techAtEntry || {}) };
      if (rsiRow?.rsi != null) tech.rsi14 = +Number(rsiRow.rsi).toFixed(1);
      if (adxRow?.adx != null) tech.adx   = +Number(adxRow.adx).toFixed(1);
      // ATR computed from bars — reliable for any date with enough history
      const computedAtr = computeAtr14(barsAtEntry.slice(-30));
      if (computedAtr != null) tech.atr14 = computedAtr;
      if (barsAtEntry.length >= 10) tech.obvTrend   = computeObvTrend(barsAtEntry.slice(-20));
      if (barsAtEntry.length >= 30 && lastBar) {
        tech.range52wk = compute52WkPct(barsAtEntry.slice(-252), lastBar.close);
      }
      if (lastBar) {
        const vol20 = barsAtEntry.slice(-20);
        const avgVol = vol20.reduce((s, b) => s + (b.volume || 0), 0) / vol20.length;
        if (avgVol > 0) tech.volumeRatio = +(lastBar.volume / avgVol).toFixed(2);
      }

      updates.techAtEntry = tech;
      console.log(`  ✓ RSI=${tech.rsi14}, ATR=${tech.atr14}, ADX=${tech.adx}, OBV=${tech.obvTrend}, VOLx=${tech.volumeRatio}`);
    } catch (e) { console.warn('  ⚠ tech snapshot failed:', e.message); }
  } else {
    console.log('  ✓ ATR already present');
  }

  // ── 3. MFE and MAE ────────────────────────────────────────────────────────
  if (!entry.mfe?.price && entryPrice) {
    console.log('  → MFE / MAE...');
    try {
      const allBars = await getDaily(ticker, entryDate, addDays(exitDate, 1));
      const tradeBars = allBars.filter(b => b.date >= entryDate && b.date <= exitDate);
      if (tradeBars.length > 0) {
        const { mfe, mae } = computeMfeMae(tradeBars, entryPrice, direction);
        if (mfe) { updates.mfe = mfe; console.log(`  ✓ MFE: +${mfe.percent?.toFixed(2)}% @ $${mfe.price}`); }
        if (mae) { updates.mae = mae; console.log(`  ✓ MAE: -${mae.percent?.toFixed(2)}% @ $${mae.price}`); }
      } else {
        console.warn('  ⚠ no trade bars found between', entryDate, 'and', exitDate);
      }
    } catch (e) { console.warn('  ⚠ MFE/MAE failed:', e.message); }
  } else if (!entryPrice) {
    console.warn('  ⚠ no entry price — skipping MFE/MAE');
  } else {
    console.log('  ✓ MFE already present');
  }

  // ── 4. Write to MongoDB ───────────────────────────────────────────────────
  if (Object.keys(updates).length > 0) {
    await db.collection('pnthr_journal').updateOne(
      { _id: entry._id },
      { $set: { ...updates, updatedAt: new Date() } }
    );
    console.log(`  ✅ Saved: ${Object.keys(updates).join(', ')}`);
  } else {
    console.log('  ℹ  Nothing to update');
  }

  // Polite pause between entries (FMP rate limits)
  await new Promise(r => setTimeout(r, 500));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🦁 PNTHR Journal Backfill\n');

  const db = await connectToDatabase();
  if (!db) { console.error('❌ MongoDB connection failed'); process.exit(1); }

  const entries = await db.collection('pnthr_journal').find({
    $or: [
      { 'marketAtEntry.spyPrice': { $in: [null, undefined] } },
      { 'marketAtEntry.spyPrice': { $exists: false } },
      { 'mfe.price': { $in: [null, undefined] } },
      { 'mfe.price': { $exists: false } },
      { 'techAtEntry.atr14': { $in: [null, undefined] } },
      { 'techAtEntry.atr14': { $exists: false } },
    ],
  }).toArray();

  if (!entries.length) {
    console.log('✅ All journal entries are fully populated — nothing to do.');
    process.exit(0);
  }

  console.log(`Found ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} to backfill:\n`);
  for (const e of entries) {
    const ed = e.entry?.fillDate ? new Date(e.entry.fillDate).toISOString().split('T')[0] : '?';
    const missing = [
      !e.marketAtEntry?.spyPrice && 'market',
      !e.mfe?.price             && 'MFE/MAE',
      !e.techAtEntry?.atr14     && 'ATR',
    ].filter(Boolean).join(', ');
    console.log(`  • ${e.ticker} (${e.direction || 'LONG'})  entered ${ed}  missing: ${missing}`);
  }

  console.log('\n─────────────────────────────────────────');
  for (const entry of entries) {
    await backfillEntry(db, entry);
  }

  console.log('\n✅ Backfill complete!');
  process.exit(0);
}

main().catch(e => { console.error('❌ Fatal error:', e); process.exit(1); });
