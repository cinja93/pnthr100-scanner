// SIGNAL CENSUS — counts how many BL/SS signals the ENTIRE liquid U.S. market produces,
// to measure true strategy capacity (capacity is bounded by signal supply, not index size).
// Weekly bars only (cheap). Liquid screen = price>$5, mcap>$300M, vol>300k, NYSE/NASDAQ.
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { detectAllSignals } from '../signalDetection.js';
import { getSectorEmaPeriod } from '../sectorEmaConfig.js';
import { normalizeSector } from '../sectorUtils.js';

dotenv.config();
const KEY = process.env.FMP_API_KEY;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function screener() {
  const url = `https://financialmodelingprep.com/api/v3/stock-screener?priceMoreThan=5&marketCapMoreThan=300000000&volumeMoreThan=300000&exchange=NYSE,NASDAQ&isActivelyTrading=true&limit=10000&apikey=${KEY}`;
  const d = await (await fetch(url)).json();
  return (Array.isArray(d) ? d : []).filter(x => x.symbol && !/[.\-]/.test(x.symbol));
}

function dailyToWeekly(daily) {
  const weeks = {};
  for (const b of daily) {
    const d = new Date(b.date + 'T12:00:00'); const dow = d.getDay(); const monOff = dow === 0 ? -6 : 1 - dow;
    const m = new Date(d); m.setDate(d.getDate() + monOff); const wk = m.toISOString().slice(0, 10);
    if (!weeks[wk]) weeks[wk] = { time: wk, open: b.open, high: b.high, low: b.low, close: b.close };
    else { weeks[wk].high = Math.max(weeks[wk].high, b.high); weeks[wk].low = Math.min(weeks[wk].low, b.low); weeks[wk].close = b.close; }
  }
  return Object.values(weeks).sort((a, b) => a.time.localeCompare(b.time));
}

async function fetchDaily(ticker) {
  const url = `https://financialmodelingprep.com/api/v3/historical-price-full/${ticker}?from=2021-06-01&apikey=${KEY}`;
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) { await sleep(1500 * a); continue; }
      const d = await r.json();
      return (d.historical || []).map(h => ({ date: h.date, open: h.open, high: h.high, low: h.low, close: h.close })).reverse();
    } catch { await sleep(400 * a); }
  }
  return [];
}

async function main() {
  if (!KEY) { console.error('Missing FMP_API_KEY'); process.exit(1); }
  const names = await screener();
  console.log(`[SIGNAL CENSUS] ${names.length} liquid names from screener\n`);
  let withData = 0, activeBL = 0, activeSS = 0, newBL52 = 0, newSS52 = 0, done = 0;
  const bySector = {};
  for (const s of names) {
    const t = s.symbol; const sector = normalizeSector(s.sector); const period = getSectorEmaPeriod(sector);
    done++;
    const daily = await fetchDaily(t); await sleep(55);
    if (daily.length < 260) continue;
    const weekly = dailyToWeekly(daily);
    if (weekly.length < 35) continue;
    withData++;
    if (!bySector[sector]) bySector[sector] = { names: 0, activeBL: 0, activeSS: 0 };
    bySector[sector].names++;
    let res;
    try { res = detectAllSignals(weekly, period, false, null, 0.10); } catch { continue; }
    const evts = res.events || [];
    // current state (last open BL or SS that hasn't been exited)
    let state = null;
    for (const e of evts) {
      if (e.signal === 'BL') state = 'BL';
      else if (e.signal === 'SS') state = 'SS';
      else if (e.signal === 'BE' || e.signal === 'SE') state = null;
    }
    if (state === 'BL') { activeBL++; bySector[sector].activeBL++; }
    else if (state === 'SS') { activeSS++; bySector[sector].activeSS++; }
    // new entries in the last 52 weekly bars
    const cutoff = weekly[Math.max(0, weekly.length - 52)].time;
    for (const e of evts) {
      if (e.time >= cutoff) { if (e.signal === 'BL') newBL52++; else if (e.signal === 'SS') newSS52++; }
    }
    if (done % 250 === 0) console.log(`  ${done}/${names.length}  (data ${withData})  activeBL ${activeBL}  activeSS ${activeSS}`);
  }
  console.log(`\n========================================================`);
  console.log(`[CENSUS RESULT]  liquid names with usable data: ${withData}`);
  console.log(`  CURRENTLY ACTIVE:  BL ${activeBL}  +  SS ${activeSS}  =  ${activeBL + activeSS} concurrent signals`);
  console.log(`  NEW ENTRIES / yr:  BL+1 ${newBL52}  +  SS+1 ${newSS52}  =  ${newBL52 + newSS52} new signals/yr  (~${Math.round((newBL52 + newSS52) / 52)}/wk)`);
  console.log(`  vs S&P 500 (503 names, ~$3.9M/yr capacity) -> this universe is ${(withData / 503).toFixed(1)}x the names`);
  console.log(`\n  Active signals by sector:`);
  for (const [sec, v] of Object.entries(bySector).sort((a, b) => (b[1].activeBL + b[1].activeSS) - (a[1].activeBL + a[1].activeSS))) {
    console.log(`    ${sec.padEnd(24)} names ${String(v.names).padStart(4)}   activeBL ${String(v.activeBL).padStart(4)}   activeSS ${String(v.activeSS).padStart(4)}`);
  }
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
