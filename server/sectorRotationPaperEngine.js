// server/sectorRotationPaperEngine.js
// ── PNTHR SECTOR ROTATION — STRUCTURALLY-ISOLATED PAPER ENGINE ───────────────
// The 2026-07-10 candidate: 6-MONTH momentum, TOP-2-PER-SECTOR, QUARTERLY rebalance,
// 1x, equal-weight, AI-300. This is the FORWARD, survivorship-free live test — it
// picks from the real evolving universe and marks true forward returns (the only
// clean answer to "is the backtest edge real or hindsight", per the 2026-07-10 debate).
//
// ISOLATION (mirrors the Elite paper engine):
//   • Writes ONLY pnthr_sectrot_paper_positions / _trades / _config (+ __ownerId variants).
//   • Imports NO order / IBKR / bridge code. Cannot place a real trade. Pure simulation
//     off the nightly AI candle store (ranking) + live FMP quotes (marks + fills).
// ────────────────────────────────────────────────────────────────────────────
import { connectToDatabase, getUserProfile } from './database.js';
import { SECTORS } from './scripts/aiUniverse/aiUniverseData.js';
import { fetchAiQuotesBatch } from './aiIntradayOverlay.js';
import { calcCommission, calcSlippage } from './backtest/costEngine.js';

const SOURCE = 'SECTROT_6MO_PAPER';
const LOOKBACK_MONTHS = 6;
const TOP_N = 2;
const NAV0_HOUSE = 100000;
const H = { COLL: 'pnthr_sectrot_paper_positions', TRADES: 'pnthr_sectrot_paper_trades', CFG: 'pnthr_sectrot_paper_config' };

function todayET() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
function currentQuarter(ymd) { const y = ymd.slice(0, 4), m = +ymd.slice(5, 7); return `${y}-Q${Math.floor((m - 1) / 3) + 1}`; }

// HOUSE (no ownerId) vs MEMBER (owner-scoped, walled off) — same convention as the other paper books.
async function resolveBook(db, ownerId) {
  if (!ownerId) return { ...H, nav: NAV0_HOUSE, ownerId: null };
  let base = 50000;
  try { const p = await getUserProfile(ownerId); if (p?.accountSize > 0) base = p.accountSize; } catch { /* default $50k */ }
  return { COLL: `${H.COLL}__${ownerId}`, TRADES: `${H.TRADES}__${ownerId}`, CFG: `${H.CFG}__${ownerId}`, nav: base, ownerId };
}

// Top-2-per-sector by TRAILING 6-MONTH return, from the nightly daily candle store.
export async function computeSectorRotationPicks(db) {
  const tickerSector = {}; for (const s of SECTORS) for (const h of s.holdings) tickerSector[h.ticker] = s.id;
  const docs = await db.collection('pnthr_ai_bt_candles').find({ ticker: { $in: Object.keys(tickerSector) } }, { projection: { ticker: 1, daily: 1 } }).toArray();
  const cut = new Date(); cut.setMonth(cut.getMonth() - LOOKBACK_MONTHS); const cutStr = cut.toISOString().slice(0, 10);
  const bySec = {};
  for (const doc of docs) {
    const bars = (doc.daily || []).filter(b => +b.close > 0 && b.date).sort((a, b) => a.date.localeCompare(b.date));
    if (bars.length < 20) continue;
    const now = +bars[bars.length - 1].close;
    let past = null; for (const b of bars) { if (b.date <= cutStr) past = +b.close; else break; }
    if (!(past > 0)) continue;                                   // needs a full 6-month lookback (skips recent listings)
    (bySec[tickerSector[doc.ticker]] ||= []).push({ ticker: doc.ticker, sid: tickerSector[doc.ticker], ret6mo: now / past - 1 });
  }
  const picks = [];
  for (const sid of Object.keys(bySec)) { bySec[sid].sort((a, b) => b.ret6mo - a.ret6mo); picks.push(...bySec[sid].slice(0, TOP_N)); }
  return picks;
}

// One tick: SEED (first run) → REBALANCE (on a new quarter) → else MARK to live quotes.
// probe = run the full path but write NOTHING (read-only diagnostic).
export async function runSectorRotationPaperTick({ ownerId = null, probe = false } = {}) {
  const db = await connectToDatabase(); if (!db) return { error: 'NO_DB' };
  const bk = await resolveBook(db, ownerId);
  const today = todayET(), curQ = currentQuarter(today);
  const cfg = await db.collection(bk.CFG).findOne({ _id: 'state' });
  const positions = await db.collection(bk.COLL).find({}).toArray();
  const wUpsert = (coll, f, d) => probe ? Promise.resolve() : db.collection(coll).updateOne(f, { $set: d }, { upsert: true });
  const wInsert = (coll, d) => probe ? Promise.resolve() : db.collection(coll).insertOne(d);
  const wDelete = (coll, f) => probe ? Promise.resolve() : db.collection(coll).deleteMany(f);

  const needRebalance = !cfg?.seeded || cfg.rebalanceQuarter !== curQ;
  const universe = new Set(positions.map(p => p.ticker));
  let picks = null;
  if (needRebalance) { picks = await computeSectorRotationPicks(db); for (const p of picks) universe.add(p.ticker); }
  const quotes = await fetchAiQuotesBatch([...universe]).catch(() => ({}));
  const px = t => { const q = quotes[t]; return q && +q.price > 0 ? +q.price : null; };

  if (needRebalance) {
    let cash = cfg?.seeded ? (cfg.cash || 0) : bk.nav;
    if (cfg?.seeded) {                                            // sell the outgoing book at live prices → realized trades
      for (const p of positions) {
        const sell = px(p.ticker) || p.avgCost;
        const cost = calcCommission(p.totalShares, sell) + calcSlippage(p.totalShares, sell);
        cash += p.totalShares * sell - cost;
        await wInsert(bk.TRADES, { ticker: p.ticker, direction: 'LONG', entryDate: p.entryDate, exitDate: today, entryPrice: p.avgCost, exitPrice: +sell.toFixed(2), shares: p.totalShares, pnl: +((sell - p.avgCost) * p.totalShares - cost - (p.entryCost || 0)).toFixed(2), exitReason: 'REBALANCE', source: SOURCE });
      }
      await wDelete(bk.COLL, {});
    }
    const buyable = picks.filter(p => px(p.ticker) > 0);
    const perName = cash / (buyable.length || 1);
    let deployed = 0;
    for (const p of buyable) {
      const buy = px(p.ticker); const sh = Math.floor(perName / buy); if (sh < 1) continue;
      const cost = calcCommission(sh, buy) + calcSlippage(sh, buy); cash -= sh * buy + cost; deployed++;
      await wUpsert(bk.COLL, { ticker: p.ticker }, { ticker: p.ticker, direction: 'LONG', sectorId: p.sid, totalShares: sh, avgCost: +buy.toFixed(2), entryDate: today, entryCost: +cost.toFixed(2), currentPrice: +buy.toFixed(2), livePnl: 0, stop: 0, momentum6moPct: +(p.ret6mo * 100).toFixed(1), source: SOURCE });
    }
    await wUpsert(bk.CFG, { _id: 'state' }, { _id: 'state', seeded: true, rebalanceQuarter: curQ, nav0: bk.nav, cash: +cash.toFixed(2), lastRebalance: today, lastTick: new Date(), source: SOURCE });
    return { action: cfg?.seeded ? 'REBALANCED' : 'SEEDED', quarter: curQ, positions: deployed, cash: +cash.toFixed(2), ownerId };
  }
  // MARK to live
  let marked = 0;
  for (const p of positions) { const cur = px(p.ticker); if (cur == null) continue; await wUpsert(bk.COLL, { ticker: p.ticker }, { currentPrice: +cur.toFixed(2), livePnl: +((cur - p.avgCost) * p.totalShares).toFixed(2) }); marked++; }
  await wUpsert(bk.CFG, { _id: 'state' }, { lastTick: new Date() });
  return { action: 'MARKED', quarter: curQ, held: positions.length, marked, ownerId };
}

export async function getSectorRotationPaperPositions({ ownerId } = {}) {
  const db = await connectToDatabase(); if (!db) return [];
  const bk = await resolveBook(db, ownerId);
  return db.collection(bk.COLL).find({}).toArray();
}
export async function getSectorRotationPaperTrades(limit = 50, { ownerId } = {}) {
  const db = await connectToDatabase(); if (!db) return [];
  const bk = await resolveBook(db, ownerId);
  return db.collection(bk.TRADES).find({}).sort({ exitDate: -1 }).limit(limit).toArray();
}
export async function resetSectorRotationPaper({ ownerId } = {}) {
  const db = await connectToDatabase(); if (!db) return { error: 'NO_DB' };
  const bk = await resolveBook(db, ownerId);
  await db.collection(bk.COLL).deleteMany({}); await db.collection(bk.TRADES).deleteMany({}); await db.collection(bk.CFG).deleteMany({});
  return { reset: true, ownerId };
}
