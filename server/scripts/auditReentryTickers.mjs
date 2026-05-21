// Audit script: prints full ticker lists and GE trade analysis
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(envPath) {
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!process.env[key]) process.env[key] = val;
    }
    return true;
  } catch { return false; }
}

loadEnvFile(path.resolve(__dirname, '../.env'));
loadEnvFile('/Users/cindyeagar/pnthr100-scanner/server/.env');

const { connectToDatabase } = await import('../database.js');
const { SECTORS } = await import('./aiUniverse/aiUniverseData.js');

const AI_TICKERS = new Set();
for (const sec of SECTORS) for (const h of sec.holdings) AI_TICKERS.add(h.ticker);

const db = await connectToDatabase();

const [daily679, daily_ai] = await Promise.all([
  db.collection('pnthr_bt_candles').find({}, { projection: { ticker: 1, daily: 1 } }).toArray(),
  db.collection('pnthr_ai_bt_candles').find({}, { projection: { ticker: 1, daily: 1 } }).toArray(),
]);

function computeTTMReturn(dailyBars) {
  if (!dailyBars || dailyBars.length < 2) return null;
  const sorted = [...dailyBars].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1];
  const cutoff = new Date(last.date);
  cutoff.setDate(cutoff.getDate() - 365);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  let ref = sorted[0];
  for (const bar of sorted) { if (bar.date >= cutoffStr) { ref = bar; break; } }
  if (ref.date === last.date) return null;
  return (last.close - ref.close) / ref.close;
}

// 679 top 100
const daily679Map = {};
for (const doc of daily679) daily679Map[doc.ticker] = doc.daily || [];
const tickers679 = Object.keys(daily679Map);
const ttm679 = [];
for (const ticker of tickers679) {
  const ttm = computeTTMReturn(daily679Map[ticker]);
  if (ttm !== null) ttm679.push({ ticker, ttm });
}
ttm679.sort((a, b) => b.ttm - a.ttm);
const top679 = ttm679.slice(0, 100);

// AI top 100
const dailyAiMap = {};
for (const doc of daily_ai) dailyAiMap[doc.ticker] = doc.daily || [];
const tickersAI = [...AI_TICKERS].filter(t => dailyAiMap[t]);
const ttmAI = [];
for (const ticker of tickersAI) {
  const ttm = computeTTMReturn(dailyAiMap[ticker]);
  if (ttm !== null) ttmAI.push({ ticker, ttm });
}
ttmAI.sort((a, b) => b.ttm - a.ttm);
const topAI = ttmAI.slice(0, 100);

console.log('\n=== 679 TOP 100 TICKERS (ranked by TTM return, as of latest data) ===');
for (const [i, x] of top679.entries()) {
  console.log(`${String(i+1).padStart(3)}. ${x.ticker.padEnd(8)} ${(x.ttm*100).toFixed(1)}%`);
}

console.log('\n=== AI 300 TOP 100 TICKERS (ranked by TTM return, as of latest data) ===');
for (const [i, x] of topAI.entries()) {
  console.log(`${String(i+1).padStart(3)}. ${x.ticker.padEnd(8)} ${(x.ttm*100).toFixed(1)}%`);
}

// Re-entry opportunity averages
console.log('\n=== RE-ENTRY OPPORTUNITY AVERAGES (from main backtest run) ===');
console.log('679 Re-entry: 1312 trades / 100 tickers = ' + (1312/100).toFixed(2) + ' opportunities per ticker avg');
console.log('AI Re-entry:  1287 trades / 100 tickers = ' + (1287/100).toFixed(2) + ' opportunities per ticker avg');
console.log('Combined:     2599 trades / 200 tickers = ' + (2599/200).toFixed(2) + ' opportunities per ticker avg');

// GE 170.64R trade breakdown
const geEntry = 312.89;
const geStop  = 312.75;
const geExit  = 336.78;
const geRisk  = geEntry - geStop;
const geGain  = geExit - geEntry;
const geR     = geGain / geRisk;
console.log('\n=== GE 170.64R TRADE — EXACT BREAKDOWN ===');
console.log('Entry date:      2026-02-12');
console.log('Exit date:       2026-02-24');
console.log('Entry price:     $' + geEntry);
console.log('Stop price:      $' + geStop);
console.log('Exit price:      $' + geExit);
console.log('Risk/share:      $' + geRisk.toFixed(2) + '  (entry $' + geEntry + ' - stop $' + geStop + ')');
console.log('Gain/share:      $' + geGain.toFixed(2) + '  (exit $' + geExit + ' - entry $' + geEntry + ')');
console.log('R multiple:      ' + geR.toFixed(2) + 'R');
console.log('Hold:            7 trading days');
console.log('');
console.log('VERDICT: DATA ARTIFACT');
console.log('  The stop was placed at 2-bar-low - $0.01 = $312.75');
console.log('  That is only $0.14 below the entry price ($312.89)');
console.log('  GE is a ~$300 stock; $0.14 is noise — this stop would fire on any 0.04% wiggle');
console.log('  The gain of $23.89/share was real, but sizing was based on $0.14 risk,');
console.log('  which no real trader would use. R = $23.89 / $0.14 = 170.64');
console.log('  In real trading you would NOT use a $0.14 stop on a $313 stock.');
console.log('  This inflates the entire profit factor and Sortino ratio for 679 Re-entry.');

process.exit(0);
