// PNTHR Accounting — Security Master (ISIN -> stable Security ID).
//
// NAV assigned a stable internal Security ID to every security it ever administered. We harvested
// all 829 of them (+ the "Trading Expenses" pseudo-security) from NAV's historical Portfolio
// Notebooks (Jun-2025..May-2026, 0 conflicts) into pnthrAccountingSecurityMasterSeed.json — so every
// security NAV ever reported keeps its EXACT NAV id, forever. For a security that entered the fund
// only AFTER we took over administration (NAV never assigned an id — none exists to reproduce), we
// assign a stable PNTHR id ONCE, in a range that can never collide with a real NAV id (NAV max is
// ~5.03M; PNTHR ids start at 9,000,001), persisted in Mongo so it is identical every month, forever.
// Self-healing: a brand-new ticker is registered automatically on first sight and never changes.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectToDatabase } from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, 'pnthrAccountingSecurityMasterSeed.json'), 'utf8'));
const NAV_MAP = SEED.map;                 // ISIN -> NAV Security ID (exact, immutable)
const TRADING_EXPENSES_ID = SEED.tradingExpensesId ?? 1;
const COLL = 'pnthr_acct_security_master'; // persisted PNTHR-assigned ids for post-NAV securities
const PNTHR_ID_BASE = 9_000_000;           // PNTHR-assigned ids live at 9,000,001+ (never collide with NAV)

// Exact NAV id if NAV ever reported this ISIN, else null. Pure (no DB).
export function navIdForIsin(isin) {
  if (!isin) return null;
  if (isin === 'Trading Expenses') return TRADING_EXPENSES_ID;
  return Object.prototype.hasOwnProperty.call(NAV_MAP, isin) ? NAV_MAP[isin] : null;
}

// Resolve a set of ISINs to Security IDs. NAV-known ISINs return their exact NAV id with no DB write.
// Unknown ISINs are assigned a stable PNTHR id ONCE (persisted) and returned identically thereafter.
// Returns a plain object { isin: securityId }. Deterministic: new ISINs are assigned in sorted order.
export async function resolveSecurityIds(isins) {
  const out = {};
  const unknown = [];
  for (const isin of new Set(isins)) {
    if (!isin) continue;
    const navId = navIdForIsin(isin);
    if (navId != null) out[isin] = navId;
    else unknown.push(isin);
  }
  if (unknown.length === 0) return out;

  const db = await connectToDatabase();
  const coll = db.collection(COLL);
  // Load any already-persisted PNTHR ids for the unknowns.
  const existing = await coll.find({ _id: { $in: unknown } }).toArray();
  for (const d of existing) out[d._id] = d.id;
  const toAssign = unknown.filter((isin) => out[isin] == null).sort();
  for (const isin of toAssign) {
    // Atomic counter so ids are unique even if two closes ever overlap.
    const c = await coll.findOneAndUpdate(
      { _id: '__counter__' },
      { $inc: { next: 1 } },
      { upsert: true, returnDocument: 'after' },
    );
    const seq = (c.value?.next ?? c.next);      // driver-version tolerant
    const id = PNTHR_ID_BASE + Number(seq);
    await coll.updateOne({ _id: isin }, { $set: { id, source: 'pnthr', assignedAt: new Date() } }, { upsert: true });
    out[isin] = id;
  }
  return out;
}

export { NAV_MAP as SECURITY_MASTER_NAV_MAP };
