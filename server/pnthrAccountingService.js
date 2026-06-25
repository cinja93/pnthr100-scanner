// PNTHR Accounting — self-administration document service.
//
// Replaces NAV Fund Services as administrator: we self-produce the identical
// monthly fund-accounting package (2 investor PDFs + 3 Excel working papers)
// from our own data. This service owns the STORAGE + monthly PLACEHOLDER layer:
//   - pnthr_acct_periods    : one bucket per calendar month (fund inception June 2025 → 2027)
//   - pnthr_acct_documents  : the generated PDF/Excel files (Buffer in Mongo), keyed
//                             by period + docType (per-investor docs also keyed by investorNo)
//
// The accounting engine + renderers + IBKR Flex ingestion + Fund Ledger are built
// in later phases; this layer is what the PNTHR Accounting page reads/serves and is
// the slot each month's generated documents auto-drop into.

import { connectToDatabase } from './database.js';
import { ObjectId } from 'mongodb';

const PERIODS = 'pnthr_acct_periods';
const DOCS = 'pnthr_acct_documents';

// Monthly placeholders span fund inception (the first monthly statement) through the
// horizon, so every month's documents have a home — historical (backfilled) and future.
export const INCEPTION = { year: 2025, month: 6 };   // June 2025 — first monthly statement
export const HORIZON_END = { year: 2027, month: 12 };

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// The 5 documents that make up NAV's monthly package, in display order.
// `perInvestor` docs can have one file per investor (e.g. the Individual Account Statement).
export const DOC_TYPES = [
  { key: 'individual_account_statement', label: 'Individual Account Statement', ext: 'pdf',  contentType: 'application/pdf', perInvestor: true },
  { key: 'account_statement',            label: 'Account Statement',            ext: 'pdf',  contentType: 'application/pdf', perInvestor: false },
  { key: 'fund_accounting_workbook',     label: 'Fund Accounting Workbook',     ext: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', perInvestor: false },
  { key: 'portfolio_notebook',           label: 'Portfolio Notebook',           ext: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', perInvestor: false },
  { key: 'capital_roll_history',         label: 'Capital Roll History',         ext: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', perInvestor: false },
];

const DOC_TYPE_KEYS = new Set(DOC_TYPES.map(d => d.key));

export function periodId(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`; // e.g. "2026-04"
}

export function periodLabel(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`; // e.g. "April 2026"
}

// Idempotent, self-healing: ensure a placeholder exists for every month from fund
// inception to the horizon. Only inserts the ones that are missing — never touches existing
// buckets (so generated docs + reconciliation status are preserved across calls).
export async function ensurePeriods() {
  const db = await connectToDatabase();
  if (!db) return [];

  // Make the period key unique so we can never double-seed a month.
  try {
    await db.collection(PERIODS).createIndex({ period: 1 }, { unique: true });
    await db.collection(DOCS).createIndex({ period: 1, docType: 1, investorNo: 1 });
  } catch { /* index already exists */ }

  const wanted = [];
  let y = INCEPTION.year, mo = INCEPTION.month;
  while (y < HORIZON_END.year || (y === HORIZON_END.year && mo <= HORIZON_END.month)) {
    wanted.push({ year: y, month: mo, period: periodId(y, mo) });
    mo++; if (mo > 12) { mo = 1; y++; }
  }

  const existing = new Set(
    (await db.collection(PERIODS).find({}, { projection: { period: 1 } }).toArray()).map(p => p.period),
  );

  const now = new Date();
  const toInsert = wanted
    .filter(w => !existing.has(w.period))
    .map(w => ({
      period: w.period,
      year: w.year,
      month: w.month,
      label: periodLabel(w.year, w.month),
      status: 'empty',             // empty | draft | finalized
      reconciliation: null,        // { status: 'green'|'red', diff, checkedAt }
      createdAt: now,
      updatedAt: now,
    }));

  if (toInsert.length > 0) {
    await db.collection(PERIODS).insertMany(toInsert, { ordered: false });
  }
  return toInsert.map(p => p.period);
}

// List every monthly bucket (newest-first), each enriched with the documents that
// currently live in it (metadata only — never the raw Buffer).
export async function listPeriods() {
  const db = await connectToDatabase();
  if (!db) return { docTypes: DOC_TYPES, periods: [] };

  await ensurePeriods();

  const periods = await db.collection(PERIODS)
    .find({})
    .sort({ year: -1, month: -1 })
    .toArray();

  const docs = await db.collection(DOCS)
    .find({}, { projection: { data: 0 } })
    .sort({ generatedAt: -1 })
    .toArray();

  const byPeriod = new Map();
  for (const d of docs) {
    if (!byPeriod.has(d.period)) byPeriod.set(d.period, []);
    byPeriod.get(d.period).push({
      id: d._id.toString(),
      docType: d.docType,
      label: d.label,
      filename: d.filename,
      contentType: d.contentType,
      size: d.size,
      status: d.status,
      investorNo: d.investorNo ?? null,
      generatedAt: d.generatedAt,
      generatedBy: d.generatedBy ?? null,
      fingerprint: d.fingerprint ?? null,
    });
  }

  return {
    docTypes: DOC_TYPES,
    periods: periods.map(p => ({
      period: p.period,
      year: p.year,
      month: p.month,
      label: p.label,
      status: p.status,
      reconciliation: p.reconciliation ?? null,
      documents: byPeriod.get(p.period) || [],
    })),
  };
}

// Fetch a single generated document WITH its Buffer (for view/download serving).
export async function getDocument(id) {
  const db = await connectToDatabase();
  if (!db) return null;
  if (!ObjectId.isValid(id)) return null;
  return db.collection(DOCS).findOne({ _id: new ObjectId(id) });
}

// Upsert a generated document into a month's placeholder. Used by the renderers /
// engine in later phases; one file per (period, docType, investorNo). Re-running a
// month overwrites that slot rather than piling up duplicates.
export async function saveDocument({ period, docType, investorNo = null, label, filename, contentType, data, status = 'draft', generatedBy = 'engine', fingerprint = null }) {
  const db = await connectToDatabase();
  if (!db) throw new Error('Database unavailable');
  if (!DOC_TYPE_KEYS.has(docType)) throw new Error(`Unknown docType: ${docType}`);
  if (!Buffer.isBuffer(data)) throw new Error('Document data must be a Buffer');

  const now = new Date();
  const filter = { period, docType, investorNo };
  await db.collection(DOCS).updateOne(
    filter,
    {
      $set: {
        period, docType, investorNo,
        label, filename, contentType,
        data, size: data.length,
        status, generatedBy, fingerprint,
        generatedAt: now,
      },
    },
    { upsert: true },
  );

  // Reflect that the bucket now holds at least a draft.
  await db.collection(PERIODS).updateOne(
    { period },
    { $set: { status, updatedAt: now } },
  );

  return db.collection(DOCS).findOne(filter, { projection: { data: 0 } });
}
