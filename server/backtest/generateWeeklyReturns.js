// server/backtest/generateWeeklyReturns.js
// ── Generate weekly NAV snapshots for demo_fund from journal data ────────────
//
// Reads:  pnthr_journal (closed trades for demo_fund)
// Writes: pnthr_portfolio_returns (weekly NAV snapshots for demo_fund)
//
// Rebuilds the equity curve week-by-week from trade exit dates + P&L,
// then persists weekly return snapshots for the Risk-Adjusted Performance
// analytics section.
//
// Usage:  cd server && node backtest/generateWeeklyReturns.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';

const STARTING_NAV = 10_000_000;
const OWNER_ID     = 'demo_fund';
const RF_ANNUAL    = 0.05;  // ~5% risk-free rate (approximate average 2021-2026)

function getFriday(dateStr) {
  // Returns the Friday of the week containing dateStr (ISO YYYY-MM-DD)
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay(); // 0=Sun, 5=Fri
  const diff = day <= 5 ? (5 - day) : (5 - day + 7);
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().split('T')[0];
}

async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('DB unavailable'); process.exit(1); }

  // Fetch all closed demo_fund journal entries
  const entries = await db.collection('pnthr_journal')
    .find({ ownerId: OWNER_ID, 'performance.status': 'CLOSED' })
    .toArray();

  console.log(`Found ${entries.length} closed trades for ${OWNER_ID}`);

  if (entries.length === 0) {
    console.log('No trades found. Exiting.');
    process.exit(0);
  }

  // Build weekly P&L map: { 'YYYY-MM-DD' (Friday) → totalPnl }
  const weeklyPnl = new Map();

  for (const entry of entries) {
    const exitDate = entry.closedAt
      ? new Date(entry.closedAt).toISOString().split('T')[0]
      : entry.exits?.[0]?.date;
    if (!exitDate) continue;

    const friday = getFriday(exitDate);
    const pnl = entry.performance?.totalPnlDollar || entry.performance?.realizedPnlDollar || 0;
    weeklyPnl.set(friday, (weeklyPnl.get(friday) || 0) + pnl);
  }

  // Sort weeks chronologically
  const weeks = [...weeklyPnl.keys()].sort();
  console.log(`Spanning ${weeks.length} weeks: ${weeks[0]} → ${weeks[weeks.length - 1]}`);

  // Build equity curve with weekly returns
  const rfWeekly = RF_ANNUAL / 52;
  let nav = STARTING_NAV;
  const snapshots = [];

  // Fill in all weeks (including weeks with no trades → 0 return)
  const startDate = new Date(weeks[0] + 'T12:00:00Z');
  const endDate = new Date(weeks[weeks.length - 1] + 'T12:00:00Z');

  // Generate every Friday from start to end
  const allFridays = [];
  const cur = new Date(startDate);
  while (cur <= endDate) {
    allFridays.push(cur.toISOString().split('T')[0]);
    cur.setUTCDate(cur.getUTCDate() + 7);
  }

  let prevNav = STARTING_NAV;
  for (const friday of allFridays) {
    const pnl = weeklyPnl.get(friday) || 0;
    nav = prevNav + pnl;

    const weeklyReturn = (nav - prevNav) / prevNav;
    const cumulativeReturn = (nav - STARTING_NAV) / STARTING_NAV;

    snapshots.push({
      ownerId: OWNER_ID,
      date: new Date(friday + 'T20:00:00Z'), // 4pm ET on Friday
      nav: Math.round(nav * 100) / 100,
      weeklyReturn: parseFloat(weeklyReturn.toFixed(6)),
      cumulativeReturn: parseFloat(cumulativeReturn.toFixed(6)),
      riskFreeRate: parseFloat(rfWeekly.toFixed(6)),
      pnlThisWeek: parseFloat(pnl.toFixed(2)),
      tradesClosedThisWeek: weeklyPnl.has(friday) ? 1 : 0, // simplified
      createdAt: new Date(),
    });

    prevNav = nav;
  }

  console.log(`\nGenerated ${snapshots.length} weekly snapshots`);
  console.log(`  Start NAV: $${STARTING_NAV.toLocaleString()}`);
  console.log(`  End NAV:   $${Math.round(nav).toLocaleString()}`);
  console.log(`  Total Return: ${((nav - STARTING_NAV) / STARTING_NAV * 100).toFixed(1)}%`);

  // Sample some weekly returns for sanity check
  const returns = snapshots.map(s => s.weeklyReturn);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const negReturns = returns.filter(r => r < 0);
  console.log(`  Avg Weekly Return: ${(avgReturn * 100).toFixed(3)}%`);
  console.log(`  Weeks with Losses: ${negReturns.length} / ${returns.length}`);

  // Compute preview of what analytics will show
  const excess = returns.map(r => r - rfWeekly);
  const avgExcess = excess.reduce((a, b) => a + b, 0) / excess.length;
  const variance = returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  const downside = excess.filter(r => r < 0);
  const dsVar = downside.length > 0 ? downside.reduce((s, r) => s + r * r, 0) / downside.length : 0;
  const dsDev = Math.sqrt(dsVar);
  const ann = Math.sqrt(52);
  const sharpe = stdDev > 0 ? (avgExcess / stdDev) * ann : null;
  const sortino = dsDev > 0 ? (avgExcess / dsDev) * ann : null;

  console.log(`\n  Preview Risk-Adjusted Metrics:`);
  console.log(`    Sharpe:  ${sharpe?.toFixed(2) ?? 'N/A'}`);
  console.log(`    Sortino: ${sortino?.toFixed(2) ?? 'N/A'}`);

  // ── Persist ──
  console.log(`\nClearing existing demo_fund snapshots...`);
  await db.collection('pnthr_portfolio_returns').deleteMany({ ownerId: OWNER_ID });

  console.log(`Inserting ${snapshots.length} weekly snapshots...`);
  await db.collection('pnthr_portfolio_returns').insertMany(snapshots);

  // Create index for efficient queries
  await db.collection('pnthr_portfolio_returns').createIndex(
    { ownerId: 1, date: -1 },
    { background: true }
  );

  console.log('Done!');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
