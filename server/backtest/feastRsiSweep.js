// server/backtest/feastRsiSweep.js
// ── FEAST RSI Exit Optimization — finds the RSI threshold where the biggest
//    selloffs occurred, so we know the optimal level to sell 50%.
//
// Approach: for each closed backtest trade, load weekly bars and compute RSI-14
// at each bar while the position was open. For each candidate RSI threshold,
// check if RSI crossed that level during the trade and what the price was at
// that point vs the actual exit. Reports total alpha gained/lost at each level.
//
// Usage: cd server && node backtest/feastRsiSweep.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';

const RSI_PERIOD = 14;
const THRESHOLDS_BL = [75, 78, 80, 82, 85, 87, 90]; // longs: sell when RSI >= X
const THRESHOLDS_SS = [25, 22, 20, 18, 15, 13, 10]; // shorts: cover when RSI <= X

function computeRSI(closes) {
  if (closes.length < RSI_PERIOD + 1) return [];
  const rsi = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= RSI_PERIOD; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) avgGain += delta; else avgLoss += Math.abs(delta);
  }
  avgGain /= RSI_PERIOD;
  avgLoss /= RSI_PERIOD;
  rsi[RSI_PERIOD] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = RSI_PERIOD + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;
    avgGain = (avgGain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD;
    avgLoss = (avgLoss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

async function run() {
  const db = await connectToDatabase();

  // Load all closed backtest trades (Wagyu 1M tier has the most data)
  const trades = await db.collection('pnthr_ai_bt_pyramid_nav_1m_trade_log')
    .find({ exitReason: { $exists: true } })
    .toArray();
  console.log(`Loaded ${trades.length} closed backtest trades`);

  // Group by ticker so we only load bars once per ticker
  const byTicker = {};
  for (const t of trades) {
    if (!byTicker[t.ticker]) byTicker[t.ticker] = [];
    byTicker[t.ticker].push(t);
  }

  const tickers = Object.keys(byTicker);
  console.log(`${tickers.length} unique tickers\n`);

  // Results: for each threshold, track trades where FEAST would have fired
  const resultsLong = {};
  const resultsShort = {};
  for (const th of THRESHOLDS_BL) resultsLong[th] = { fires: 0, totalAlpha: 0, trades: [] };
  for (const th of THRESHOLDS_SS) resultsShort[th] = { fires: 0, totalAlpha: 0, trades: [] };

  let processed = 0;
  for (const ticker of tickers) {
    // Load weekly bars for this ticker (stored as array in doc.weekly)
    const doc = await db.collection('pnthr_ai_bt_candles_weekly')
      .findOne({ ticker });
    if (!doc || !doc.weekly || doc.weekly.length < RSI_PERIOD + 2) continue;

    const bars = doc.weekly;
    const closes = bars.map(b => b.close);
    const rsiValues = computeRSI(closes);
    const barDates = bars.map(b => b.weekOf);

    for (const trade of byTicker[ticker]) {
      const isLong = trade.signal === 'BL';
      const entryDate = trade.entryDate;
      const exitDate = trade.exitDate;
      const exitPrice = trade.exitPrice;
      const avgCost = trade.avgCost || trade.entryPrice;
      if (!entryDate || !exitDate || !exitPrice || !avgCost) continue;

      // Find bar indices during the trade's life
      const entryIdx = barDates.findIndex(d => d >= entryDate);
      const exitIdx = barDates.findIndex(d => d >= exitDate);
      if (entryIdx < 0) continue;
      const lastIdx = exitIdx >= 0 ? exitIdx : bars.length - 1;

      // For each bar in the trade window, check RSI against each threshold
      const thresholds = isLong ? THRESHOLDS_BL : THRESHOLDS_SS;
      const results = isLong ? resultsLong : resultsShort;

      for (const th of thresholds) {
        let feastFired = false;
        for (let i = entryIdx; i <= lastIdx; i++) {
          const rsi = rsiValues[i];
          if (rsi == null) continue;
          const triggered = isLong ? rsi >= th : rsi <= th;
          if (triggered) {
            // FEAST would fire here — sell 50% at this bar's close
            const feastPrice = bars[i].close;
            const feastDate = bars[i].weekOf;

            // Compute what happens: sell 50% at feastPrice, remaining 50% exits at actual exitPrice
            // Compare to actual: 100% exits at exitPrice
            // Alpha = (feastPrice - exitPrice) * 0.5 for BL (positive = FEAST was better)
            const alpha = isLong
              ? (feastPrice - exitPrice) / avgCost * 50 // in % terms (50% of position)
              : (exitPrice - feastPrice) / avgCost * 50;

            results[th].fires++;
            results[th].totalAlpha += alpha;
            results[th].trades.push({
              ticker, entryDate, exitDate, exitReason: trade.exitReason,
              feastDate, feastRsi: rsi.toFixed(1), feastPrice: feastPrice.toFixed(2),
              exitPrice: exitPrice.toFixed(2), alphaPct: alpha.toFixed(2),
            });
            feastFired = true;
            break; // Only count first trigger per trade
          }
        }
      }
    }
    processed++;
    if (processed % 50 === 0) process.stdout.write(`  ${processed}/${tickers.length} tickers...\r`);
  }

  console.log(`\n\n${'═'.repeat(70)}`);
  console.log('FEAST RSI SWEEP — LONG EXITS (sell 50% when RSI >= threshold)');
  console.log('═'.repeat(70));
  console.log(`${'RSI'.padStart(5)} | ${'Fires'.padStart(6)} | ${'Avg Alpha%'.padStart(11)} | ${'Total Alpha%'.padStart(13)} | Note`);
  console.log('─'.repeat(70));
  for (const th of THRESHOLDS_BL) {
    const r = resultsLong[th];
    const avgAlpha = r.fires > 0 ? (r.totalAlpha / r.fires).toFixed(2) : '0.00';
    const note = r.fires > 0 ? (r.totalAlpha > 0 ? 'FEAST HELPS' : 'FEAST HURTS') : '';
    console.log(`${('≥' + th).padStart(5)} | ${String(r.fires).padStart(6)} | ${avgAlpha.padStart(11)} | ${r.totalAlpha.toFixed(2).padStart(13)} | ${note}`);
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log('FEAST RSI SWEEP — SHORT EXITS (cover 50% when RSI <= threshold)');
  console.log('═'.repeat(70));
  console.log(`${'RSI'.padStart(5)} | ${'Fires'.padStart(6)} | ${'Avg Alpha%'.padStart(11)} | ${'Total Alpha%'.padStart(13)} | Note`);
  console.log('─'.repeat(70));
  for (const th of THRESHOLDS_SS) {
    const r = resultsShort[th];
    const avgAlpha = r.fires > 0 ? (r.totalAlpha / r.fires).toFixed(2) : '0.00';
    const note = r.fires > 0 ? (r.totalAlpha > 0 ? 'FEAST HELPS' : 'FEAST HURTS') : '';
    console.log(`${('≤' + th).padStart(5)} | ${String(r.fires).padStart(6)} | ${avgAlpha.padStart(11)} | ${r.totalAlpha.toFixed(2).padStart(13)} | ${note}`);
  }

  // Show top 5 biggest alpha trades at the optimal threshold
  const bestLongTh = THRESHOLDS_BL.reduce((best, th) =>
    resultsLong[th].totalAlpha > resultsLong[best].totalAlpha ? th : best, THRESHOLDS_BL[0]);
  const bestShortTh = THRESHOLDS_SS.reduce((best, th) =>
    resultsShort[th].totalAlpha > resultsShort[best].totalAlpha ? th : best, THRESHOLDS_SS[0]);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`OPTIMAL LONG THRESHOLD: RSI ≥ ${bestLongTh} (${resultsLong[bestLongTh].fires} fires, ${resultsLong[bestLongTh].totalAlpha.toFixed(2)}% total alpha)`);
  console.log('─'.repeat(70));
  const topLong = [...resultsLong[bestLongTh].trades].sort((a, b) => parseFloat(b.alphaPct) - parseFloat(a.alphaPct)).slice(0, 10);
  for (const t of topLong) {
    console.log(`  ${t.ticker.padEnd(6)} RSI=${t.feastRsi} on ${t.feastDate} → feast@$${t.feastPrice} vs exit@$${t.exitPrice} (${t.exitReason}) = ${t.alphaPct}% alpha`);
  }

  console.log(`\nOPTIMAL SHORT THRESHOLD: RSI ≤ ${bestShortTh} (${resultsShort[bestShortTh].fires} fires, ${resultsShort[bestShortTh].totalAlpha.toFixed(2)}% total alpha)`);
  console.log('─'.repeat(70));
  const topShort = [...resultsShort[bestShortTh].trades].sort((a, b) => parseFloat(b.alphaPct) - parseFloat(a.alphaPct)).slice(0, 10);
  for (const t of topShort) {
    console.log(`  ${t.ticker.padEnd(6)} RSI=${t.feastRsi} on ${t.feastDate} → feast@$${t.feastPrice} vs exit@$${t.exitPrice} (${t.exitReason}) = ${t.alphaPct}% alpha`);
  }

  // Also show the biggest LOSSES from FEAST at the optimal threshold (where selling early was wrong)
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`BIGGEST FEAST MISSES AT RSI ≥ ${bestLongTh} (selling early was WRONG)`);
  console.log('─'.repeat(70));
  const worstLong = [...resultsLong[bestLongTh].trades].sort((a, b) => parseFloat(a.alphaPct) - parseFloat(b.alphaPct)).slice(0, 10);
  for (const t of worstLong) {
    if (parseFloat(t.alphaPct) >= 0) break;
    console.log(`  ${t.ticker.padEnd(6)} RSI=${t.feastRsi} on ${t.feastDate} → feast@$${t.feastPrice} vs exit@$${t.exitPrice} (${t.exitReason}) = ${t.alphaPct}% alpha`);
  }

  console.log('\nDone.');
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
