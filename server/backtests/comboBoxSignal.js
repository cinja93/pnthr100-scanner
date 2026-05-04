// Combination test: Box-Breakout + BL/SS signals
//
// Goal: Does combining a box-breakout (Rule #2) with a fresh BL/SS signal
// improve trade quality vs. either signal alone?
//
// Method:
//  - Pull all completed trades from pnthr_bt_trades (16,257 BL/SS entries with
//    entry/exit/profit already computed).
//  - Pull all box-breakout events from pnthr_bt_box_alerts.
//  - For each trade, look for a matching box breakout (same ticker, matching
//    direction, breakout date within ±WINDOW_DAYS of trade entry date).
//  - Stratify trades into:
//      "BL all"         — every BL trade
//      "BL + box-up"    — BL trades that also had a box-UP breakout nearby
//      "BL no box"      — BL trades with NO box breakout nearby
//      "SS all" / "SS + box-down" / "SS no box"
//  - Sweep WINDOW_DAYS = [3, 7, 14, 30] to find the best proximity.
//  - Report: N, win rate, avg %, median %, total $ PnL, avg trading days

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const WINDOWS = [3, 7, 14, 30];

function median(nums) {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stats(trades) {
  const n = trades.length;
  if (n === 0) return { n: 0, winRate: 0, avgPct: 0, medianPct: 0, totalDollar: 0, avgDays: 0 };
  const wins = trades.filter(t => t.isWinner).length;
  const pcts = trades.map(t => t.profitPct);
  const dollars = trades.map(t => t.profitDollar || t.dollarPnl || 0);
  const days = trades.map(t => t.tradingDays || 0);
  return {
    n,
    winRate:    +(wins / n * 100).toFixed(1),
    avgPct:     +(pcts.reduce((s, x) => s + x, 0) / n).toFixed(2),
    medianPct:  +median(pcts).toFixed(2),
    totalDollar: Math.round(dollars.reduce((s, x) => s + x, 0)),
    avgDays:    +(days.reduce((s, x) => s + x, 0) / n).toFixed(1),
  };
}

function dateAddDays(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.abs((new Date(a) - new Date(b)) / 86400000);
}

async function main() {
  const c = new MongoClient(process.env.MONGODB_URI);
  await c.connect();
  const db = c.db('pnthr_den');

  console.log('Loading trades + box alerts...');
  const trades = await db.collection('pnthr_bt_trades').find({}, {
    projection: { ticker: 1, signal: 1, entryDate: 1, exitDate: 1, profitPct: 1, profitDollar: 1, isWinner: 1, tradingDays: 1 },
  }).toArray();

  const boxDocs = await db.collection('pnthr_bt_box_alerts').find({}).toArray();

  // Index box breakouts by ticker → list of {date, dir}
  const boxByTicker = new Map();
  for (const d of boxDocs) {
    const list = [];
    for (const b of d.boxes || []) {
      if (b.breakoutDate && b.status !== 'active') {
        list.push({ date: b.breakoutDate, dir: b.status === 'broken-up' ? 'UP' : 'DOWN' });
      }
    }
    if (list.length) boxByTicker.set(d.ticker, list);
  }

  console.log(`Trades: ${trades.length}`);
  console.log(`Tickers with boxes: ${boxByTicker.size}`);
  console.log(`Total box breakouts: ${[...boxByTicker.values()].reduce((s, x) => s + x.length, 0)}\n`);

  // For each trade, find nearest matching-direction box breakout
  function nearestBoxDays(trade, requireMatchingDir) {
    const list = boxByTicker.get(trade.ticker);
    if (!list) return null;
    const wantDir = trade.signal === 'BL' ? 'UP' : 'DOWN';
    let best = null;
    for (const b of list) {
      if (requireMatchingDir && b.dir !== wantDir) continue;
      const d = daysBetween(b.date, trade.entryDate);
      if (best === null || d < best) best = d;
    }
    return best;
  }

  for (const W of WINDOWS) {
    console.log('━'.repeat(72));
    console.log(`WINDOW = ±${W} days  (matching direction required)`);
    console.log('━'.repeat(72));

    const blAll = trades.filter(t => t.signal === 'BL');
    const ssAll = trades.filter(t => t.signal === 'SS');

    const blWithBox = blAll.filter(t => {
      const d = nearestBoxDays(t, true);
      return d !== null && d <= W;
    });
    const ssWithBox = ssAll.filter(t => {
      const d = nearestBoxDays(t, true);
      return d !== null && d <= W;
    });
    const blNoBox = blAll.filter(t => {
      const d = nearestBoxDays(t, true);
      return d === null || d > W;
    });
    const ssNoBox = ssAll.filter(t => {
      const d = nearestBoxDays(t, true);
      return d === null || d > W;
    });

    const rows = [
      ['BL all',          stats(blAll)],
      ['BL + box-UP',     stats(blWithBox)],
      ['BL  no box',      stats(blNoBox)],
      ['SS all',          stats(ssAll)],
      ['SS + box-DOWN',   stats(ssWithBox)],
      ['SS  no box',      stats(ssNoBox)],
    ];

    const pad = (s, n) => String(s).padEnd(n);
    console.log(pad('Cohort', 18) + pad('N', 7) + pad('Win%', 8) + pad('AvgPct', 9) + pad('MedPct', 9) + pad('Tot$', 12) + pad('AvgDays', 8));
    for (const [label, s] of rows) {
      console.log(
        pad(label, 18) +
        pad(s.n, 7) +
        pad(s.winRate + '%', 8) +
        pad((s.avgPct >= 0 ? '+' : '') + s.avgPct + '%', 9) +
        pad((s.medianPct >= 0 ? '+' : '') + s.medianPct + '%', 9) +
        pad('$' + s.totalDollar.toLocaleString(), 12) +
        pad(s.avgDays, 8)
      );
    }
    console.log();
  }

  // Bonus: compare opposite-direction overlap (BL + box-DOWN, SS + box-UP).
  // Hypothesis check: does a box breaking the OPPOSITE way kill the trade?
  console.log('━'.repeat(72));
  console.log(`Bonus: opposite-direction overlap  (window ±14 days)`);
  console.log('━'.repeat(72));
  const W = 14;
  function nearestBoxDaysAnyDir(trade) {
    const list = boxByTicker.get(trade.ticker);
    if (!list) return null;
    let best = null;
    for (const b of list) {
      const d = daysBetween(b.date, trade.entryDate);
      if (best === null || d < best) best = { d, dir: b.dir };
    }
    return best;
  }
  const blAll = trades.filter(t => t.signal === 'BL');
  const ssAll = trades.filter(t => t.signal === 'SS');
  const blOpp = blAll.filter(t => {
    const x = nearestBoxDaysAnyDir(t);
    return x && x.d <= W && x.dir === 'DOWN';
  });
  const ssOpp = ssAll.filter(t => {
    const x = nearestBoxDaysAnyDir(t);
    return x && x.d <= W && x.dir === 'UP';
  });
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('Cohort', 18) + pad('N', 7) + pad('Win%', 8) + pad('AvgPct', 9) + pad('MedPct', 9) + pad('Tot$', 12));
  for (const [label, s] of [['BL + box-DOWN', stats(blOpp)], ['SS + box-UP', stats(ssOpp)]]) {
    console.log(
      pad(label, 18) +
      pad(s.n, 7) +
      pad(s.winRate + '%', 8) +
      pad((s.avgPct >= 0 ? '+' : '') + s.avgPct + '%', 9) +
      pad((s.medianPct >= 0 ? '+' : '') + s.medianPct + '%', 9) +
      pad('$' + s.totalDollar.toLocaleString(), 12)
    );
  }

  await c.close();
}

main().catch(e => { console.error(e); process.exit(1); });
