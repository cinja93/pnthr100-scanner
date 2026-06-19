// server/backtest/genTreeIrData.js
// ── PNTHR TREE — generate per-tier Investor Report data ──────────────────────
// Mirrors genAmbushIrData.js: runs the SHARED Tree sim (treeSim.js — identical to
// the live dashboard baseline) at each PPM tier seed, applies the canonical PPM
// fee overlay (2% mgmt + tiered performance fee w/ US-2Y hurdle + HWM + loyalty
// step-down), and writes server/data/treeIr/{tier}.json in the exact shape the
// IR page (IrLivePage fund="tree" via treeIrService.js) consumes.
//
//   GROSS (before fund fees) = strategy NAV net of commission+slippage (sim.equity)
//   NET   (after fund fees)  = GROSS minus the PPM fee schedule (applyFeeEngine)
//
// Run: cd server/backtest && node --env-file=../.env genTreeIrData.js

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
import fs from 'fs';
import path from 'path';
import { connectToDatabase } from '../database.js';
import { SECTORS } from '../scripts/aiUniverse/aiUniverseData.js';
import { loadTreeData, simulateTree } from './treeSim.js';
import { applyFeeEngine } from './ai300FeeOverlay.js';
import { computeTradeStats } from '../irLiveService.js';

// Canonical PPM fee schedule per tier — SAME as AI Elite 300 (Scott confirmed 2026-06-19).
// Base rate Years 1-3 (monthIdx < 36), loyalty rate Years 4+.
const FEE_RATES = {
  '100k': { baseRate: 0.30, loyaltyRate: 0.25 },   // Filet
  '500k': { baseRate: 0.25, loyaltyRate: 0.20 },   // Porterhouse
  '1m':   { baseRate: 0.20, loyaltyRate: 0.15 },   // Wagyu
};
const TIERS = [
  { key: '1m',   seedNav: 1_000_000 },
  { key: '500k', seedNav: 500_000 },
  { key: '100k', seedNav: 100_000 },
];

const AI_META = {};
for (const s of SECTORS) for (const h of s.holdings) AI_META[h.ticker] = { sector: s.name };

function wdays(entry, exit) {
  if (!entry || !exit) return 0;
  let n = 0; const d = new Date(entry + 'T12:00:00'); const e = new Date(exit + 'T12:00:00');
  while (d < e) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}

const db = await connectToDatabase();
if (!db) { console.error('No DB — run with --env-file=../.env'); process.exit(1); }

console.log('  PNTHR TREE — per-tier IR data (shared treeSim engine + PPM fee overlay)');
const data = await loadTreeData(db, {});   // LOCKED production defaults (AI-300, frozen END, 210d) — same as the dashboard baseline

const outDir = new URL('../data/treeIr/', import.meta.url).pathname;
fs.mkdirSync(outDir, { recursive: true });

for (const t of TIERS) {
  process.stdout.write(`  ${t.key} ($${(t.seedNav / 1000).toFixed(0)}K)...`);
  const sim = simulateTree(data, { nav0: t.seedNav });
  // GROSS = strategy NAV after trading costs (commission+slippage already in sim.equity).
  const grossDaily = sim.equity.map(e => ({ date: e.date, equity: +(+e.eq).toFixed(2) }));
  // NET = GROSS minus the full PPM fee schedule (quarterly crystallization = real fee economics).
  const feeTier = { startingCapital: t.seedNav, ...FEE_RATES[t.key] };
  const { netCurve, totalMgmtFees, totalPerfFees } = applyFeeEngine(grossDaily, feeTier);
  const netDaily = netCurve.map(s => ({ date: s.date, netEquity: +(+s.netEquity).toFixed(2) }));

  // Trade log — Tree is LONG-only, so signal is always 'BL'. OPEN_AT_END = positions still
  // held at the freeze date (carried into the live book) → shown ACTIVE, exit fields null.
  const trades = sim.closed.map(c => {
    const open = c.exitReason === 'OPEN_AT_END';
    return {
      ticker: c.ticker, signal: 'BL', direction: 'LONG', sectorName: AI_META[c.ticker]?.sector || '—',
      entryDate: c.entryDate, exitDate: open ? null : c.exitDate,
      entryPrice: +(+c.entryPrice).toFixed(2), exitPrice: open ? null : +(+c.exitPrice).toFixed(2),
      avgCost: +(+c.entryPrice).toFixed(2), totalShares: c.shares || 0, lots: null,
      tradingDays: c.holdDays ?? wdays(c.entryDate, c.exitDate),
      exitReason: open ? 'ACTIVE' : (c.exitReason || 'STOP'),
      // returnPct is the price move (cost-independent); dollar P&L is net of trading costs (matches grossDaily).
      grossProfitPct: +(+c.returnPct).toFixed(2), netProfitPct: +(+c.returnPct).toFixed(2),
      grossDollarPnl: +(+c.pnl).toFixed(2), netDollarPnl: +(+c.pnl).toFixed(2), netIsWinner: c.pnl > 0,
    };
  });
  const tradeStats = computeTradeStats(trades, t.seedNav, 1);
  const closedSorted = trades.filter(x => x.entryDate).sort((a, b) => String(a.entryDate).localeCompare(String(b.entryDate)));
  const firstTradeDate = closedSorted.length ? String(closedSorted[0].entryDate).slice(0, 10) : null;
  const tradeLog = closedSorted.slice(-1500);   // cap the display log to the most recent 1500

  fs.writeFileSync(path.join(outDir, `${t.key}.json`), JSON.stringify({
    tier: t.key, seedNav: t.seedNav, version: '1.0.0', firstTradeDate,
    grossDaily, netDaily, tradeStats, tradeLog, totalTrades: trades.length,
  }));

  const grossEnd = grossDaily[grossDaily.length - 1].equity;
  const netEnd = netDaily[netDaily.length - 1].netEquity;
  console.log(` days ${grossDaily.length}  trades ${trades.length} (log ${tradeLog.length})  GROSS $${Math.round(grossEnd).toLocaleString()} -> NET $${Math.round(netEnd).toLocaleString()} (mgmt $${Math.round(totalMgmtFees).toLocaleString()} + perf $${Math.round(totalPerfFees).toLocaleString()} = drag ${(((grossEnd - netEnd) / grossEnd) * 100).toFixed(1)}%)`);
}
console.log('\n  Wrote per-tier Tree IR data to server/data/treeIr/');
process.exit(0);
