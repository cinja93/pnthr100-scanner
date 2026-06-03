// Source GICS sector for every S&P 500 ticker from FMP /profile, normalize to PNTHR's
// canonical sectors, and store a ticker->sector map in `pnthr_sp500_sectors`.
// Run after market close (it's a light pull, ~503 calls). Used by the S&P 500 backtest.
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { connectToDatabase } from '../database.js';
import { getSp500Tickers } from '../constituents.js';
import { normalizeSector } from '../sectorUtils.js';

dotenv.config();
const FMP_KEY = process.env.FMP_API_KEY;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchSector(ticker) {
  const url = `https://financialmodelingprep.com/api/v3/profile/${ticker}?apikey=${FMP_KEY}`;
  for (let a = 1; a <= 3; a++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(1500 * a); continue; }
      const d = await res.json();
      if (Array.isArray(d) && d[0]) return d[0].sector || null;
      return null;
    } catch { await sleep(400 * a); }
  }
  return null;
}

async function main() {
  if (!FMP_KEY) { console.error('Missing FMP_API_KEY'); process.exit(1); }
  const db = await connectToDatabase();
  const col = db.collection('pnthr_sp500_sectors');
  await col.createIndex({ ticker: 1 }, { unique: true });

  const tickers = [...new Set((await getSp500Tickers()).map(t => t.toUpperCase()))];
  console.log(`[SP500 SECTORS] sourcing ${tickers.length} tickers...`);
  const counts = {};
  let done = 0, missing = 0;
  for (const ticker of tickers) {
    const existing = await col.findOne({ ticker }, { projection: { sector: 1 } });
    if (existing?.sector) { counts[existing.sector] = (counts[existing.sector] || 0) + 1; done++; continue; }
    const raw = await fetchSector(ticker);
    const sector = raw ? normalizeSector(raw) : null;
    if (!sector) { missing++; console.log(`  ${ticker}: no sector (raw=${raw})`); }
    else counts[sector] = (counts[sector] || 0) + 1;
    await col.updateOne({ ticker }, { $set: { ticker, sector, rawSector: raw, at: new Date().toISOString() } }, { upsert: true });
    done++;
    await sleep(120);
  }
  console.log(`\n[SP500 SECTORS] done=${done} missing=${missing}`);
  console.log('Sector distribution:');
  for (const [s, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(s).padEnd(24)} ${n}`);
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
