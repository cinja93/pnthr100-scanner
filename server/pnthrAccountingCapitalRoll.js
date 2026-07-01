// PNTHR Accounting — Capital Roll History (Doc 5) go-forward generator.
//
// The Capital Roll is an inception-to-date roll-forward of the investor's capital account, one row
// per month. Rows June-2025 -> May-2026 are the NAV-administered history: their exact values live in
// pnthrAccountingCapitalSeed.json (generated cell-for-cell from NAV's own May-2026 Capital Roll — the
// golden fixture — so they are immutable and never recomputed). Each go-forward month (June-2026+)
// appends ONE computed row from that month's close, persisted in pnthr_acct_capital_series, and the
// workbook is re-rendered from seed history + all persisted go-forward rows.
//
// Official-books fee treatment (Scott, 2026-07-01): management fee and incentive fee are WAIVED to $0
// (a separate pro-forma view carries the 2%/tiered fees). netToInvestor therefore = totalIncome.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderCapitalRollHistory } from './pnthrAccountingRenderXlsx.js';
import { connectToDatabase } from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, 'pnthrAccountingCapitalSeed.json'), 'utf8'));
const SERIES_COLL = 'pnthr_acct_capital_series';   // per-period go-forward rows (June-2026+)

const r2 = (n) => +(+(n || 0)).toFixed(2);
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Last calendar day of the month for a YYYY-MM period (UTC-safe).
function lastDay(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Compute one go-forward Capital Roll row from a month's close. Fees waived ($0 official books).
export function computeCapitalRollRow(period, { beginning, totalIncome, additions = 0, redemptions = 0 }) {
  const [year, month] = period.split('-').map(Number);
  const managementFee = 0, incentiveFee = 0;
  const netToInvestor = r2(totalIncome) - managementFee - incentiveFee;
  const ending = r2(beginning + additions + netToInvestor - redemptions);
  const base = beginning + additions;
  const ror = base === 0 ? 0 : netToInvestor / base;
  return {
    period, month, subMonth: 1, year, subMonthDay: lastDay(period),
    beginning, additions, totalIncome: r2(totalIncome),
    managementFee, incentiveFee, redemptions, ending, ror,
  };
}

// Map the seed investor object to the shape renderCapitalRollHistory expects.
function investorForRender() {
  const i = SEED.investor;
  return {
    number: i.number, name: i.name,
    address1: i.address1, address2: i.address2, address3: i.address3,
    address4: i.address4, address5: i.address5,
    entityType: i.entityType, classDescription: i.classDescription,
  };
}

// Assemble the renderer data object: seed history + go-forward rows, through `period`.
export function buildCapitalRollData(period, goForwardRows = []) {
  const [y, m] = period.split('-').map(Number);
  const title = `Investor Capital Roll History as of ${MONTHS[m - 1]} ${lastDay(period)}, ${y}`;
  // Seed rows are always the full inception history (through 2026-05). Go-forward rows are 2026-06+.
  const rows = [...SEED.inceptionRows, ...goForwardRows]
    .filter((r) => r.period <= period)
    .sort((a, b) => a.period.localeCompare(b.period));
  return { fundName: SEED.fundName, title, investor: investorForRender(), rows };
}

// Prior month's ending balance = this month's beginning (full precision, self-consistent roll).
export async function priorCapitalEnding(db, period) {
  const all = [...SEED.inceptionRows, ...(await db.collection(SERIES_COLL).find({}).toArray())]
    .filter((r) => r.period < period)
    .sort((a, b) => a.period.localeCompare(b.period));
  return all.length ? all[all.length - 1].ending : 0;
}

// Generate + persist the Capital Roll for a go-forward month. Returns the rendered Buffer.
// Idempotent: upserts the month's row, so re-running a close never duplicates.
export async function generateCapitalRoll(period, { totalIncome, additions = 0, redemptions = 0 }) {
  const db = await connectToDatabase();
  const beginning = await priorCapitalEnding(db, period);
  const row = computeCapitalRollRow(period, { beginning, totalIncome, additions, redemptions });
  await db.collection(SERIES_COLL).updateOne({ period }, { $set: { ...row, updatedAt: new Date() } }, { upsert: true });
  const goForward = (await db.collection(SERIES_COLL).find({}).toArray())
    .map(({ _id, updatedAt, ...r }) => r);
  const data = buildCapitalRollData(period, goForward);
  const buffer = await renderCapitalRollHistory(data);
  return { buffer, row, data };
}
