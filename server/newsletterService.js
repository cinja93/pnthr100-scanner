// server/newsletterService.js
// PNTHR'S PERCH — shared helpers for the Perch newsletter pipeline.
//
// The generator itself lives in perchService.js (single source of truth for
// both the Friday 5PM cron and the admin Generate button). This module now
// only hosts:
//   • getMostRecentFriday — weekOf derivation shared by the cron + route
//   • fetchPreyData / findBestExits — data utilities perchService imports
//   • listIssues / getIssue / updateIssueNarrative / publishIssue — DB CRUD
//     for newsletter_issues used by routes/newsletter.js
//
// The old bespoke prompt + Claude call (generateIssue) was retired here on
// 2026-04-22 — it produced a different section structure than perchService
// and had drifted out of sync with the locked layout.

import { connectToDatabase } from './database.js';
import { getJungleStocks } from './stockService.js';
import { getSignals } from './signalService.js';
import { getSp400Longs, getSp400Shorts } from './sp400Service.js';
import { getPreyResults } from './preyService.js';

const COLLECTION = 'newsletter_issues';

// Most recent Friday date as YYYY-MM-DD
export function getMostRecentFriday() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun..6=Sat
  // days to subtract to reach most recent Friday
  const daysBack = day === 5 ? 0 : day === 6 ? 1 : day + 2;
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().split('T')[0];
}

// Load the full jungle universe + sector-aware signals in one shot. Perch
// uses this to compute live-signal fallbacks when the archive is empty for
// the current week.
export async function fetchPreyData() {
  const [specLongs, specShorts] = await Promise.all([getSp400Longs(), getSp400Shorts()]);
  const stocks = await getJungleStocks(specLongs, specShorts);
  const tickers = stocks.map(s => s.ticker);
  const stockMeta = {};
  for (const s of stocks) {
    stockMeta[s.ticker] = {
      companyName: s.companyName,
      sector: s.sector,
      exchange: s.exchange,
      currentPrice: s.currentPrice,
    };
  }
  const nlSectorMap = Object.fromEntries(tickers.map(t => [t, stockMeta[t]?.sector]).filter(([, s]) => s));
  const jungleSignals = await getSignals(tickers, { sectorMap: nlSectorMap });
  const preyResults = await getPreyResults(tickers, stockMeta, jungleSignals);
  return { ...preyResults, signals: jungleSignals, stockMeta };
}

// Find profitable exits this week. weekOf is YYYY-MM-DD (Friday).
// weekStart of that week is the Monday 4 days prior. Exported so perchService
// can fall back to live signals when pnthr679_trade_archive is empty for the
// current week.
export function findBestExits(signals, stockMeta, weekOf) {
  const fri = new Date(weekOf + 'T12:00:00');
  const mon = new Date(fri);
  mon.setDate(fri.getDate() - 4);
  const weekStart = mon.toISOString().split('T')[0];

  const exits = Object.entries(signals)
    .filter(([, sig]) =>
      (sig.signal === 'BE' || sig.signal === 'SE') &&
      sig.profitDollar != null &&
      sig.profitDollar > 0 &&
      sig.signalDate === weekStart
    )
    .map(([ticker, sig]) => ({
      ticker,
      signal: sig.signal,
      direction: sig.signal === 'BE' ? 'long' : 'short',
      profitDollar: sig.profitDollar,
      profitPct: sig.profitPct,
      companyName: stockMeta[ticker]?.companyName || '',
      sector: stockMeta[ticker]?.sector || '',
      currentPrice: stockMeta[ticker]?.currentPrice ?? null,
    }));

  if (exits.length === 0) return { exits: [], bestDollar: null, bestPct: null };

  const byDollar = [...exits].sort((a, b) => b.profitDollar - a.profitDollar);
  const byPct    = [...exits].sort((a, b) => b.profitPct   - a.profitPct);

  return {
    exits,
    bestDollar: byDollar[0],
    bestPct: byPct[0],
  };
}

// ── DB CRUD (newsletter_issues) ──────────────────────────────────────────────

export async function listIssues(limit = 52) {
  const db = await connectToDatabase();
  if (!db) return [];
  return db.collection(COLLECTION)
    .find({}, { projection: { narrative: 0, dataSnapshot: 0 } })
    .sort({ weekOf: -1 })
    .limit(limit)
    .toArray();
}

export async function getIssue(id) {
  const { ObjectId } = await import('mongodb');
  const db = await connectToDatabase();
  if (!db) return null;
  return db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
}

export async function updateIssueNarrative(id, narrative) {
  const { ObjectId } = await import('mongodb');
  const db = await connectToDatabase();
  if (!db) throw new Error('Database not available');
  await db.collection(COLLECTION).updateOne(
    { _id: new ObjectId(id) },
    { $set: { narrative, editedAt: new Date() } }
  );
}

export async function publishIssue(id) {
  const { ObjectId } = await import('mongodb');
  const db = await connectToDatabase();
  if (!db) throw new Error('Database not available');
  await db.collection(COLLECTION).updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: 'published', publishedAt: new Date() } }
  );
}
