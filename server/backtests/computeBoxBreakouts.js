// Box-Breakout Rule (Rule #2 v1) — backtest engine
//
// Detects "basing patterns" on weekly bars and breakout events on daily bars.
//
// Locked spec (PNTHR Den, 2026-05-03 discussion):
//  - Base = ≥ 8 contiguous weeks where:
//      * Each week's volume ≤ 1.5× trailing 20-week average volume
//      * Slope from first close to last close ≤ 1.5%/week (absolute, normalized
//        to first close)
//      * No "major breakout" inside the span — defined as a weekly wick > prior
//        running high × 1.01 OR < prior running low × 0.99 with weekly volume
//        > 1.5× the trailing 20W avg
//  - Box top    = highest weekly wick (high) inside the base
//  - Box bottom = lowest weekly wick (low) inside the base
//  - Breakout trigger (forward-looking, daily bars): first daily CLOSE that
//    breaks the box by > 1% AND has daily volume > 1.5× trailing 20-day avg
//  - Each ticker can have multiple historical boxes; we record them all so the
//    TEST page can paint history (live UI will only show the most recent)
//
// Output collections:
//  - pnthr_bt_box_alerts        { ticker, boxes: [...] }  (one doc/ticker)
//  - pnthr_bt_box_alerts_meta   { _id: 'latest', lastRunAt, alertsTotal,
//                                 tickersTotal, params }

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

// ── Tunable parameters (v2 — refined 2026-05-03) ──
//   v1 → v2 changes:
//     B1: MIN_GAP_WEEKS_BETWEEN_BASES new (4 weeks) — fixes ABT-style stacking
//     C1: MAX_SLOPE_PCT_PER_WK 1.5 → 2.5 — admits INTC-style slow grinds
//     D : REQUIRE_VOLUME_CONTRACTION new — Wyckoff accumulation signature
//     G2: DAILY_VOL_MULTIPLIER 1.5 → 2.0 — stronger breakout confirmation
const MIN_BASE_WEEKS        = 8;
const VOL_LOOKBACK_WEEKS    = 20;
const VOL_SPIKE_MULTIPLIER  = 1.5;     // inside-base check (unchanged)
const MAX_SLOPE_PCT_PER_WK  = 2.5;     // v2: was 1.5
const BREAKOUT_PCT          = 0.01;
const DAILY_VOL_LOOKBACK    = 20;
const DAILY_VOL_MULTIPLIER  = 2.0;     // v2: was 1.5 (stronger breakout vol)
const BACKTEST_START_WEEK   = '2020-05-04';
const BOX_VISIBLE_AFTER_BREAK_WEEKS = 4;
const MIN_GAP_WEEKS_BETWEEN_BASES = 4; // v2 NEW
const REQUIRE_VOLUME_CONTRACTION  = true; // v2 NEW
const CONTRACTION_BUCKET_WEEKS    = 4; // last-N vs first-N weeks

function rollingAvg(arr, idx, lookback) {
  const start = Math.max(0, idx - lookback);
  if (start === idx) return null;
  let sum = 0, n = 0;
  for (let i = start; i < idx; i++) { sum += arr[i]; n++; }
  return n > 0 ? sum / n : null;
}

// Detect every distinct base in chronological order. Walk forward; whenever we
// see a "major breakout" (or run out of bars), we close out any active base
// and try to open a new one starting after the breakout week.
function detectBases(weekly) {
  const startIdx = Math.max(0, weekly.findIndex(w => w.weekOf >= BACKTEST_START_WEEK));
  if (startIdx < 0 || startIdx >= weekly.length) return [];

  const bases = [];
  const volumes = weekly.map(w => w.volume);

  // Walk one base at a time. baseStart is the index of the first week.
  let baseStart = startIdx;

  while (baseStart < weekly.length - MIN_BASE_WEEKS) {
    let runHigh = weekly[baseStart].high;
    let runLow  = weekly[baseStart].low;
    let lastIdx = baseStart;

    for (let i = baseStart + 1; i < weekly.length; i++) {
      const w = weekly[i];
      const volAvg = rollingAvg(volumes, i, VOL_LOOKBACK_WEEKS);

      // Volume spike inside what would be the base?
      const isVolSpike = volAvg && w.volume > volAvg * VOL_SPIKE_MULTIPLIER;

      // Major breakout test (against PRIOR running high/low, before adding w):
      const wickBreaksUp   = w.high > runHigh * (1 + BREAKOUT_PCT);
      const wickBreaksDown = w.low  < runLow  * (1 - BREAKOUT_PCT);

      if ((wickBreaksUp || wickBreaksDown) && isVolSpike) {
        lastIdx = i - 1;
        // Major breakout — close the candidate base BEFORE this week. The
        // breakout week itself is excluded from the base. Note: we use weekly
        // wicks here only to *invalidate* the base; the actual breakout alert
        // for downstream is daily-close-driven (computed separately below).
        break;
      }

      // Slope check — normalize (last close − first close) / first close /
      // weeks elapsed. If it exceeds 1.5%/week absolute, the period is no
      // longer flat enough to call a base.
      const weeksElapsed = i - baseStart;
      const slopePctPerWk = weeksElapsed > 0
        ? Math.abs((w.close - weekly[baseStart].close) / weekly[baseStart].close) * 100 / weeksElapsed
        : 0;
      if (slopePctPerWk > MAX_SLOPE_PCT_PER_WK) {
        lastIdx = i - 1;
        break;
      }

      // Volume spike alone (no price breakout) also disqualifies — base
      // requires "average volume" inside.
      if (isVolSpike) {
        lastIdx = i - 1;
        break;
      }

      // Extend the base
      runHigh = Math.max(runHigh, w.high);
      runLow  = Math.min(runLow,  w.low);
      lastIdx = i;
    }

    // If we walked off the end of the data without breaking, lastIdx is the
    // last bar — base is still "active". Otherwise lastIdx is the last week
    // before the break.
    const baseLen = lastIdx - baseStart + 1;

    if (baseLen >= MIN_BASE_WEEKS) {
      // Recompute box top/bottom from the actual span
      let top = weekly[baseStart].high;
      let bot = weekly[baseStart].low;
      for (let j = baseStart; j <= lastIdx; j++) {
        if (weekly[j].high > top) top = weekly[j].high;
        if (weekly[j].low  < bot) bot = weekly[j].low;
      }

      // v2 — D: Wyckoff volume contraction filter
      // Average volume in the LAST CONTRACTION_BUCKET_WEEKS of the base must
      // be ≤ average in the FIRST CONTRACTION_BUCKET_WEEKS. Real accumulation
      // bases show declining volume as the consolidation matures.
      let baseAccepted = true;
      if (REQUIRE_VOLUME_CONTRACTION && baseLen >= CONTRACTION_BUCKET_WEEKS * 2) {
        let firstSum = 0, lastSum = 0;
        for (let j = baseStart; j < baseStart + CONTRACTION_BUCKET_WEEKS; j++) firstSum += weekly[j].volume;
        for (let j = lastIdx - CONTRACTION_BUCKET_WEEKS + 1; j <= lastIdx; j++) lastSum += weekly[j].volume;
        if (lastSum > firstSum) baseAccepted = false;
      }

      if (baseAccepted) {
        bases.push({
          startIdx: baseStart,
          endIdx:   lastIdx,
          startDate: weekly[baseStart].weekOf,
          endDate:   weekly[lastIdx].weekOf,
          top,
          bottom: bot,
        });
        // v2 — B1: skip ahead MIN_GAP_WEEKS_BETWEEN_BASES weeks past the break
        baseStart = lastIdx + 1 + MIN_GAP_WEEKS_BETWEEN_BASES;
      } else {
        // Base failed contraction filter — slide forward by 1
        baseStart += 1;
      }
    } else {
      baseStart += 1;
    }
  }

  return bases;
}

// For each completed base, look at daily bars AFTER the base ends and find
// the first daily close that breaks the box by >1% with confirming volume.
function findBreakout(daily, base) {
  const startDate = base.endDate;          // the last weekly bar in the base
  const dailyAfter = daily.filter(d => d.date > startDate);
  if (dailyAfter.length === 0) return null;

  for (let i = 0; i < dailyAfter.length; i++) {
    const d = dailyAfter[i];

    // 20-day rolling avg volume on the trailing daily bars (looking back into
    // the original `daily` array so we include pre-base history).
    const dailyIdx = daily.findIndex(x => x.date === d.date);
    if (dailyIdx < 0) continue;
    const start = Math.max(0, dailyIdx - DAILY_VOL_LOOKBACK);
    let sum = 0, n = 0;
    for (let j = start; j < dailyIdx; j++) { sum += daily[j].volume; n++; }
    const avgVol = n > 0 ? sum / n : null;
    const volRatio = avgVol ? d.volume / avgVol : null;

    const above = d.close > base.top    * (1 + BREAKOUT_PCT);
    const below = d.close < base.bottom * (1 - BREAKOUT_PCT);
    const volOk = avgVol && d.volume > avgVol * DAILY_VOL_MULTIPLIER;

    if ((above || below) && volOk) {
      return {
        direction:    above ? 'UP' : 'DOWN',
        breakoutDate: d.date,
        breakoutPrice: d.close,
        volRatio:     +volRatio.toFixed(2),
      };
    }
  }
  return null;
}

export async function computeBoxBreakouts() {
  const c = new MongoClient(process.env.MONGODB_URI);
  await c.connect();
  const db = c.db('pnthr_den');
  const weeklyColl = db.collection('pnthr_bt_candles_weekly');
  const dailyColl  = db.collection('pnthr_bt_candles');
  const out        = db.collection('pnthr_bt_box_alerts');
  const metaColl   = db.collection('pnthr_bt_box_alerts_meta');

  const tickers = await weeklyColl.distinct('ticker');
  tickers.sort();

  let alertsTotal = 0;
  let tickersWithBoxes = 0;

  // Wipe prior results
  await out.deleteMany({});

  for (let tIdx = 0; tIdx < tickers.length; tIdx++) {
    const ticker = tickers[tIdx];
    if (tIdx % 50 === 0) console.log(`[box-bt] ${tIdx}/${tickers.length} ${ticker}`);

    try {
      const wDoc = await weeklyColl.findOne({ ticker });
      const dDoc = await dailyColl.findOne({ ticker });
      if (!wDoc?.weekly || wDoc.weekly.length < MIN_BASE_WEEKS + VOL_LOOKBACK_WEEKS) continue;

      const weekly = [...wDoc.weekly].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
      const daily  = dDoc?.daily ? [...dDoc.daily].sort((a, b) => a.date.localeCompare(b.date)) : [];

      const bases = detectBases(weekly);
      if (bases.length === 0) continue;

      const boxes = bases.map(base => {
        const breakout = daily.length ? findBreakout(daily, base) : null;
        let status = 'active';
        let displayEndDate = base.endDate;
        if (breakout) {
          status = breakout.direction === 'UP' ? 'broken-up' : 'broken-down';
          // Box visible 4 weeks past the breakout date
          const breakoutDt = new Date(breakout.breakoutDate);
          breakoutDt.setUTCDate(breakoutDt.getUTCDate() + BOX_VISIBLE_AFTER_BREAK_WEEKS * 7);
          displayEndDate = breakoutDt.toISOString().slice(0, 10);
        }
        return {
          startDate: base.startDate,
          endDate:   displayEndDate,
          baseEndDate: base.endDate,
          top:    +base.top.toFixed(2),
          bottom: +base.bottom.toFixed(2),
          weeks:  base.endIdx - base.startIdx + 1,
          status,
          breakoutDate:  breakout?.breakoutDate  || null,
          breakoutPrice: breakout ? +breakout.breakoutPrice.toFixed(2) : null,
          breakoutVolRatio: breakout?.volRatio || null,
        };
      });

      const breakoutCount = boxes.filter(b => b.status !== 'active').length;
      alertsTotal += breakoutCount;
      tickersWithBoxes += 1;

      await out.insertOne({ ticker, boxes, computedAt: new Date() });
    } catch (e) {
      console.error(`[box-bt] ${ticker} failed:`, e.message);
    }
  }

  await metaColl.replaceOne(
    { _id: 'latest' },
    {
      _id: 'latest',
      lastRunAt: new Date(),
      alertsTotal,
      tickersTotal: tickersWithBoxes,
      tickersScanned: tickers.length,
      params: {
        MIN_BASE_WEEKS, VOL_LOOKBACK_WEEKS, VOL_SPIKE_MULTIPLIER,
        MAX_SLOPE_PCT_PER_WK, BREAKOUT_PCT, DAILY_VOL_LOOKBACK,
        DAILY_VOL_MULTIPLIER, BACKTEST_START_WEEK,
      },
    },
    { upsert: true },
  );

  await c.close();
  return {
    alertsWritten: alertsTotal,
    tickersProcessed: tickersWithBoxes,
    tickersScanned: tickers.length,
  };
}

// CLI entrypoint: `node server/backtests/computeBoxBreakouts.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  computeBoxBreakouts()
    .then(r => { console.log('Done:', r); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
