// server/backtest/exportAuditLog.js
// ── Investor-Grade Auditable Trade Log ───────────────────────────────────────
//
// Reads the cost-enriched trade log from pnthr_bt_trade_log and produces:
//
//   1. pnthr_bt_audit_log (MongoDB) — canonical investor-grade record with
//      deterministic trade IDs, all cost fields, regime context, R-multiples,
//      and a verification fingerprint for each trade.
//
//   2. Console output — summary statistics with cost attribution breakdown
//      suitable for copying into the investor methodology document.
//
// The audit log is the source of truth for:
//   - CSV export (via /api/backtest/audit-export)
//   - Professional investor due diligence requests
//   - CPA / third-party auditor verification
//
// Every trade in the audit log can be independently verified by:
//   1. Pulling historical prices from FMP: /historical-price-full/{ticker}
//   2. Applying the signal logic (per the methodology document)
//   3. Applying costEngine.js to verify commission/slippage/borrow
//
// Prerequisite: run exportOrdersTrades.js first (populates pnthr_bt_trade_log)
//
// Usage:  cd server && node backtest/exportAuditLog.js
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

import { connectToDatabase } from '../database.js';
import { COST_METHODOLOGY } from './costEngine.js';

const AUDIT_VERSION  = '1.0.0';
const BACKTEST_CONFIG = 'NEW_ASYM_SS (BL top 10 + SS crash gate top 5, Optimal EMA per sector)';

// ── Deterministic Trade ID ────────────────────────────────────────────────────
// Format: {SIGNAL}-{YEAR}-{MM}-{TICKER}-{SEQ}
// Example: BL-2022-03-AAPL-0042
// This ID is stable across audit log regenerations for the same trade.
function makeTradeId(trade, index) {
  const signal = trade.signal || 'XX';
  const year   = (trade.entryDate || trade.weekOf || '0000-00').slice(0, 4);
  const month  = (trade.entryDate || trade.weekOf || '0000-00').slice(5, 7);
  const ticker = (trade.ticker || 'UNKN').padEnd(4).slice(0, 6).replace(/\s/g, '_');
  const seq    = String(index + 1).padStart(4, '0');
  return `${signal}-${year}-${month}-${ticker.trim()}-${seq}`;
}

// ── Simple deterministic hash for data verification ──────────────────────────
// Not cryptographic — for audit trail, shows data was not tampered with
// after generation. Uses entry/exit price + dates as fingerprint inputs.
function makeFingerprint(trade) {
  const str = [
    trade.ticker,
    trade.entryDate,
    trade.entryPrice?.toFixed(4),
    trade.exitDate,
    trade.exitPrice?.toFixed(4),
    trade.grossDollarPnl?.toFixed(4),
  ].join('|');

  // Simple djb2-style hash (32-bit, hex-encoded)
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;  // Convert to 32-bit integer
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ── R-Multiple calculation ────────────────────────────────────────────────────
// R = net P&L / initial risk
// Initial risk per share = |entryPrice - initialStop|
// If no stop stored, we cannot compute R reliably — returns null
function calcRMultiple(trade) {
  // The trade log stores the initial stop on the position object
  // For trades without a stored stop, we cannot back-calculate it
  if (trade.initialStop == null) return null;
  const riskPerShare = Math.abs(trade.entryPrice - trade.initialStop);
  if (riskPerShare <= 0) return null;
  const netPnlPerShare = trade.netDollarPnl / (trade.shares || 1);
  return parseFloat((netPnlPerShare / riskPerShare).toFixed(2));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const db = await connectToDatabase();
  if (!db) { console.error('Cannot connect to MongoDB'); process.exit(1); }

  // ── Load source trade log ─────────────────────────────────────────────────
  const trades = await db.collection('pnthr_bt_trade_log').find({}).sort({ entryDate: 1 }).toArray();

  if (trades.length === 0) {
    console.error('\nNo trades in pnthr_bt_trade_log.');
    console.error('Run exportOrdersTrades.js first.\n');
    process.exit(1);
  }

  const hasCostData = trades[0].netDollarPnl !== undefined;
  if (!hasCostData) {
    console.error('\npnthr_bt_trade_log does not have cost fields (netDollarPnl missing).');
    console.error('Run exportOrdersTrades.js with costEngine.js integration first.\n');
    process.exit(1);
  }

  const allDates = trades.map(t => t.entryDate || t.weekOf).filter(Boolean).sort();
  const dateFrom = allDates[0];
  const dateTo   = allDates[allDates.length - 1];

  console.log('\n' + '═'.repeat(80));
  console.log('  PNTHR Investor Audit Log Generator');
  console.log(`  Config:  ${BACKTEST_CONFIG}`);
  console.log(`  Period:  ${dateFrom} → ${dateTo}`);
  console.log(`  Trades:  ${trades.length}`);
  console.log(`  Version: ${AUDIT_VERSION}`);
  console.log('═'.repeat(80));

  // ── Build audit records ───────────────────────────────────────────────────
  const auditRecords = trades.map((t, i) => {
    const rMultiple = calcRMultiple(t);
    const fingerprint = makeFingerprint(t);

    return {
      // ── Identity ──
      tradeId:          makeTradeId(t, i),
      auditVersion:     AUDIT_VERSION,
      backtestConfig:   BACKTEST_CONFIG,
      generatedAt:      new Date(),
      costEngineVersion: t.costEngineVersion || COST_METHODOLOGY.version,

      // ── Signal ──
      ticker:           t.ticker,
      exchange:         t.exchange || null,
      sector:           t.sector   || null,
      signal:           t.signal,             // 'BL' or 'SS'
      weekOf:           t.weekOf,             // Friday the signal was active
      killRank:         t.killRank    ?? null,
      filteredRank:     t.filteredRank ?? null,
      killScore:        t.apexScore   ?? null,

      // ── Entry ──
      entryDate:        t.entryDate,
      entryPrice:       t.entryPrice,
      shares:           t.shares,
      positionValue:    t.positionValue,
      initialStop:      t.initialStop ?? null,

      // ── Exit ──
      exitDate:         t.exitDate,
      exitPrice:        t.exitPrice,
      tradingDays:      t.tradingDays,
      exitReason:       t.exitReason,         // STOP_HIT | SIGNAL_BE | SIGNAL_SE | STALE_HUNT

      // ── Trade Excursions ──
      maxFavorablePct:  t.maxFavorable  ?? null,   // Best price move in our favor (%)
      maxAdversePct:    t.maxAdverse    ?? null,    // Worst price move against us (%)

      // ── Gross Performance (before any costs) ──
      grossDollarPnl:   t.grossDollarPnl,
      grossProfitPct:   t.grossProfitPct,
      isWinner:         t.isWinner,

      // ── Commission (IBKR Pro Fixed) ──
      commissionIn:     t.commissionIn,
      commissionOut:    t.commissionOut,
      commissionTotal:  t.commissionTotal,

      // ── Slippage (5 bps/leg, conservative limit-order estimate) ──
      slippageIn:       t.slippageIn,
      slippageOut:      t.slippageOut,
      slippageTotal:    t.slippageTotal,

      // ── Borrow Cost (SS trades only) ──
      borrowRate:       t.borrowRate,          // Annualized (e.g. 0.010 = 1.0%)
      borrowCost:       t.borrowCost,          // $ for this trade's holding period
      borrowDays:       t.borrowDays,          // Trading days borrowed

      // ── Total Friction ──
      totalFrictionDollar: t.totalFrictionDollar,
      totalFrictionPct:    t.totalFrictionPct,    // % of position value

      // ── Net Performance (what the investor actually earned) ──
      netDollarPnl:     t.netDollarPnl,
      netProfitPct:     t.netProfitPct,
      netIsWinner:      t.netIsWinner,
      rMultiple:        rMultiple,             // Net P&L / initial risk (null if no stop stored)

      // ── Audit Trail ──
      dataSource:       'FMP /historical-price-full',
      dataSourceNote:   'Entry/exit prices derived from weekly OHLCV via pnthr_bt_candles',
      fingerprint:      fingerprint,           // djb2 hash of ticker|entryDate|entryPrice|exitDate|exitPrice|grossPnl
    };
  });

  // ── Persist to MongoDB ────────────────────────────────────────────────────
  await db.collection('pnthr_bt_audit_log').deleteMany({});
  await db.collection('pnthr_bt_audit_log').insertMany(auditRecords);
  await db.collection('pnthr_bt_audit_log').createIndex({ tradeId: 1 }, { unique: true });
  await db.collection('pnthr_bt_audit_log').createIndex({ signal: 1, entryDate: 1 });
  await db.collection('pnthr_bt_audit_log').createIndex({ ticker: 1 });
  console.log(`\n  ✓ Saved ${auditRecords.length} records to pnthr_bt_audit_log`);

  // ── Cost attribution summary ──────────────────────────────────────────────
  const blRecs = auditRecords.filter(t => t.signal === 'BL');
  const ssRecs = auditRecords.filter(t => t.signal === 'SS');

  function costSummary(recs, label) {
    if (recs.length === 0) return;
    const total  = (field) => recs.reduce((s, t) => s + (t[field] || 0), 0);
    const avg    = (field) => total(field) / recs.length;
    const netWin = recs.filter(t => t.netIsWinner).length;

    console.log(`\n  ── ${label} Cost Attribution (${recs.length} trades) ──`);
    console.log(`  ${'Category'.padEnd(28)} ${'Total $'.padStart(12)}  ${'Avg $/trade'.padStart(12)}  ${'Avg % pos'.padStart(10)}`);
    console.log(`  ${'─'.repeat(68)}`);

    const commTotal   = total('commissionTotal');
    const slipTotal   = total('slippageTotal');
    const borrTotal   = total('borrowCost');
    const frictTotal  = total('totalFrictionDollar');
    const grossTotal  = total('grossDollarPnl');
    const netTotal    = total('netDollarPnl');
    const avgPos      = total('positionValue') / recs.length;

    const row = (name, val, count) => {
      const avgVal = val / count;
      const avgPct = avgPos > 0 ? (avgVal / avgPos * 100).toFixed(3) : '—';
      console.log(`  ${name.padEnd(28)} $${String(val.toFixed(2)).padStart(11)}  $${String(avgVal.toFixed(2)).padStart(11)}  ${String(avgPct).padStart(9)}%`);
    };

    row('Commission (IBKR Pro)',     commTotal,  recs.length);
    row('Slippage (5 bps/leg)',      slipTotal,  recs.length);
    if (label.includes('SS') || label.includes('Combined')) {
      row('Borrow Cost (SS only)',   borrTotal,  recs.filter(t => t.signal === 'SS').length || 1);
    }
    console.log(`  ${'─'.repeat(68)}`);
    row('TOTAL FRICTION',            frictTotal, recs.length);
    console.log();
    console.log(`  Gross P&L:    $${grossTotal.toFixed(2).padStart(12)}   Avg: $${(grossTotal / recs.length).toFixed(2)}`);
    console.log(`  Net P&L:      $${netTotal.toFixed(2).padStart(12)}   Avg: $${(netTotal   / recs.length).toFixed(2)}`);
    console.log(`  Cost drag:    $${frictTotal.toFixed(2).padStart(12)}   (${(frictTotal / Math.abs(grossTotal) * 100).toFixed(2)}% of gross P&L)`);
    console.log(`  Net win rate: ${(netWin / recs.length * 100).toFixed(1)}% vs gross ${(recs.filter(t => t.isWinner).length / recs.length * 100).toFixed(1)}%`);
  }

  costSummary(blRecs,             'BL (Longs)');
  costSummary(ssRecs,             'SS (Shorts)');
  costSummary(auditRecords,       'Combined');

  // ── Investor disclosure text ──────────────────────────────────────────────
  const blFrict    = blRecs.reduce((s, t) => s + t.totalFrictionDollar, 0);
  const ssFrict    = ssRecs.reduce((s, t) => s + t.totalFrictionDollar, 0);
  const combFrict  = auditRecords.reduce((s, t) => s + t.totalFrictionDollar, 0);

  console.log('\n' + '═'.repeat(80));
  console.log('  INVESTOR DISCLOSURE — COPY FOR METHODOLOGY DOCUMENT');
  console.log('═'.repeat(80));
  console.log(`
  Cost Model Applied: costEngine.js v${COST_METHODOLOGY.version} (${COST_METHODOLOGY.effectiveDate})

  Commission: IBKR Pro Fixed pricing — $0.005/share, $1.00 minimum, 1% maximum
  per order leg — applied to both entry and exit of every trade.
  Total commissions across ${auditRecords.length} trades: $${(auditRecords.reduce((s,t)=>s+t.commissionTotal,0)).toFixed(2)}

  Slippage: Conservative limit-order estimate of 5 basis points (0.05%) adverse
  per leg, applied to both entry and exit. PNTHR signals use weekly EMA breakout
  entries placed at the 2-week high/low — limit orders that fill naturally when
  price reaches the level. Institutional standard for liquid equities with limit
  orders is 1-3 bps; our 5 bps model is deliberately conservative.
  Total slippage across ${auditRecords.length} trades: $${(auditRecords.reduce((s,t)=>s+t.slippageTotal,0)).toFixed(2)}

  Short Borrow Cost: Applied to all ${ssRecs.length} SS trades. Rate is sector-tiered
  based on IBKR ETB (Easy to Borrow) rates: 1.0%-2.0% annualized depending on
  sector. Applied daily: annualRate / 252 × tradingDays × positionValue.
  Total borrow cost across ${ssRecs.length} SS trades: $${ssRecs.reduce((s,t)=>s+t.borrowCost,0).toFixed(2)}

  Total Friction Summary:
    BL trades (${blRecs.length}):    $${blFrict.toFixed(2)} total  |  $${(blFrict/blRecs.length).toFixed(2)} avg per trade
    SS trades (${ssRecs.length}):    $${ssFrict.toFixed(2)} total  |  $${ssRecs.length > 0 ? (ssFrict/ssRecs.length).toFixed(2) : '0.00'} avg per trade
    Combined (${auditRecords.length}): $${combFrict.toFixed(2)} total  |  $${(combFrict/auditRecords.length).toFixed(2)} avg per trade

  All cost-adjusted net P&L figures use the 'netDollarPnl' and 'netProfitPct'
  fields in pnthr_bt_audit_log. Every record includes a fingerprint hash
  for tamper detection. Full trade log available via:
    GET /api/backtest/audit-export?format=csv
  `);

  console.log('  Run complete. pnthr_bt_audit_log is ready for CSV export.');
  console.log('  Next: The API endpoint /api/backtest/audit-export serves CSV downloads.\n');

  process.exit(0);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
