// PNTHR Accounting — Doc 4 Portfolio Notebook generator (13 tabs).
//
// BASIS DECISION (Scott, 2026-07-01): NAV's tax-lot tabs used a proprietary cost-basis/lot-matching
// method that is NOT reproducible from our data (proven: identical share counts showed opposite-sign
// realized P&L — e.g. Micron 82 sh: NAV +$1,064.81 vs IBKR −$2,735.54 — because NAV marks cost to the
// prior month-end while IBKR reports since original purchase). For self-administration we use the
// CUSTODIAN'S AUTHORITATIVE RECORD — IBKR's own closed-lot/trade data — laid out exactly like NAV's
// notebook. The tax-lot tabs therefore reflect IBKR's methodology (a documented, defensible basis),
// not NAV's historical proprietary numbers; the ReportLinks/header note states this. Everything that
// ties to the reconciled books (Reconciliation Summary, positions, cash) still ties to the penny.
//
// Layout comes from NAV's May golden as a committed skeleton (pnthrAccountingNotebookSkeleton.json):
// per tab we keep the exact title/header/footer static cells + column number formats + widths +
// merges, and generate the data rows from the Flex detail. renderGridWorkbook writes the workbook.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderGridWorkbook } from './pnthrAccountingRenderXlsx.js';
import { navIdForIsin } from './pnthrAccountingSecurityMaster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKELETON = JSON.parse(fs.readFileSync(path.join(__dirname, 'pnthrAccountingNotebookSkeleton.json'), 'utf8'));
const SK = Object.fromEntries(SKELETON.sheets.map((s) => [s.name, s]));

const N = (v) => (v == null || v === '' ? 0 : Number(v));
const COLS = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z','AA','AB','AC','AD','AE','AF','AG','AH'];
const BROKER_ACCT = 'PNTHR_IB_U18248579';
const MONEY = '[$-010409]#,##0.00;(#,##0.00);-';

// ── helpers ──────────────────────────────────────────────────────────────────
function ymd(flexDt) {                     // "20260603;093544" or "20260603" -> ISO date (UTC midnight)
  const s = String(flexDt || '').slice(0, 8);
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
const tickerOf = (l) => `${l.symbol} US`;                       // NAV Bloomberg-style suffix (all holdings US-listed)
const secTypeOf = (l) => (l.assetCategory === 'STK' ? 'EQUITIES' : String(l.assetCategory || ''));
const isLongTerm = (openDt, closeDt) => {
  const o = ymd(openDt), c = ymd(closeDt);
  if (!o || !c) return false;
  return (new Date(c + 'Z') - new Date(o + 'Z')) / 86400000 > 365;
};

// Start a sheet spec from the skeleton's static cells (title/header/footer) + widths + merges,
// applying each static cell's captured numFmt/bold. Data-row cells are appended by the builder.
function fromSkeleton(name) {
  const sk = SK[name];
  const cells = sk.static.map((c) => {
    const cell = { ref: c.ref, value: c.value, numFmt: c.numFmt };
    if (c.bold) cell.bold = true;
    if (typeof c.value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(c.value)) cell.isDate = true;
    return cell;
  });
  return { name, cells, colWidths: sk.colWidths || {}, merges: sk.merges || [], _sk: sk };
}
const put = (sheet, col, row, value, opts = {}) => {
  const cell = { ref: `${col}${row}`, value, numFmt: opts.numFmt || sheet._sk.colFmt?.[col] || MONEY };
  if (opts.bold) cell.bold = true;
  if (opts.isDate) cell.isDate = true;
  if (opts.text) cell.numFmt = 'General';
  sheet.cells.push(cell);
  return cell;
};
const finalize = (sheet) => { delete sheet._sk; return sheet; };

// ── Realized Tax Lot ─────────────────────────────────────────────────────────
// Grouped by security (sorted by NAV/PNTHR Security ID ascending, matching NAV), each closed lot a
// row, K = fifoPnlRealized (= close − open), ST/LT by holding period, SUB TOTAL per group + blank row,
// GRAND TOTAL at the end. First group = the "Trading Expenses" pseudo-security (other trading cost).
function buildRealizedTaxLot(sheet, { lots, otherTradingCost, secId }) {
  let r = sheet._sk.dataStart;   // 6
  let tF = 0, tH = 0, tJ = 0, tK = 0, tL = 0, tM = 0;
  const emitSubtotal = (F, H, J, K, L, M) => {
    put(sheet, 'B', r, 'SUB TOTAL', { text: true, bold: true });
    put(sheet, 'F', r, F); put(sheet, 'H', r, H); put(sheet, 'J', r, J);
    put(sheet, 'K', r, K); put(sheet, 'L', r, L); put(sheet, 'M', r, M);
    r += 2;   // subtotal row + blank row
  };
  // Trading Expenses pseudo-row (other trading cost / reg fees), NAV Security ID = 1.
  if (Math.abs(N(otherTradingCost)) > 0) {
    put(sheet, 'B', r, 'Trading Expenses', { text: true }); put(sheet, 'C', r, 'USD', { text: true });
    put(sheet, 'E', r, 'TRADING EXPENSES', { text: true }); put(sheet, 'F', r, 0);
    put(sheet, 'K', r, N(otherTradingCost)); put(sheet, 'L', r, N(otherTradingCost)); put(sheet, 'M', r, 0);
    put(sheet, 'O', r, 1); put(sheet, 'P', r, 'Trading Expenses', { text: true }); put(sheet, 'Q', r, BROKER_ACCT, { text: true });
    r++;
    emitSubtotal(0, 0, 0, N(otherTradingCost), N(otherTradingCost), 0);
    tK += N(otherTradingCost); tL += N(otherTradingCost);
  }
  // Group closed lots by ISIN, order groups by Security ID ascending.
  const groups = {};
  for (const l of lots) { (groups[l.isin] = groups[l.isin] || []).push(l); }
  const ordered = Object.keys(groups).sort((a, b) => (secId[a] ?? 9e15) - (secId[b] ?? 9e15));
  for (const isin of ordered) {
    const g = groups[isin];
    let gF = 0, gH = 0, gJ = 0, gK = 0, gL = 0, gM = 0;
    for (const l of g) {
      const qty = Math.abs(N(l.quantity));
      const H = N(l.cost);                               // open amount (net of commission)
      const K = N(l.fifoPnlRealized);                    // realized = close − open
      const J = H + K;                                   // close amount (proceeds not populated on lots)
      const lt = isLongTerm(l.openDateTime, l.dateTime);
      put(sheet, 'A', r, ymd(l.dateTime), { isDate: true });
      put(sheet, 'B', r, l.description, { text: true }); put(sheet, 'C', r, 'USD', { text: true });
      put(sheet, 'D', r, tickerOf(l), { text: true }); put(sheet, 'E', r, secTypeOf(l), { text: true });
      put(sheet, 'F', r, qty); put(sheet, 'G', r, qty ? H / qty : 0); put(sheet, 'H', r, H);
      put(sheet, 'I', r, qty ? J / qty : 0); put(sheet, 'J', r, J);
      put(sheet, 'K', r, K); put(sheet, 'L', r, lt ? 0 : K); put(sheet, 'M', r, lt ? K : 0);
      put(sheet, 'N', r, ymd(l.openDateTime), { isDate: true });
      put(sheet, 'O', r, secId[isin] ?? null, { numFmt: 'General' });
      put(sheet, 'P', r, isin, { text: true }); put(sheet, 'Q', r, BROKER_ACCT, { text: true });
      r++;
      gF += qty; gH += H; gJ += J; gK += K; if (lt) gM += K; else gL += K;
    }
    emitSubtotal(gF, gH, gJ, gK, gL, gM);
    tF += gF; tH += gH; tJ += gJ; tK += gK; tL += gL; tM += gM;
  }
  // GRAND TOTAL
  put(sheet, 'A', r, 'GRAND TOTAL', { text: true, bold: true });
  put(sheet, 'F', r, tF); put(sheet, 'H', r, tH); put(sheet, 'J', r, tJ);
  put(sheet, 'K', r, tK); put(sheet, 'L', r, tL); put(sheet, 'M', r, tM);
  return { grandTotalRealized: tK, grandTotalQty: tF };
}

// ── Reconciliation Summary ─────────────────────────────────────────────────────
// Per custodian: our-books (NAV cols D-F) vs broker (G-I) cash + portfolio MV; ties => diffs 0.
function buildReconciliation(sheet, { bankCash, brokerCash, portfolioMV }) {
  const row = (r, name, acct, cash, mv) => {
    put(sheet, 'A', r, name, { text: true }); put(sheet, 'B', r, acct, { text: true }); put(sheet, 'C', r, 'USD', { text: true });
    put(sheet, 'D', r, cash); put(sheet, 'E', r, mv); put(sheet, 'F', r, cash + mv);
    put(sheet, 'G', r, cash); put(sheet, 'H', r, mv); put(sheet, 'I', r, cash + mv);
    for (const c of ['J','K','L','M','N','O']) put(sheet, c, r, 0);
  };
  const sub = (r, cash, mv) => { put(sheet, 'A', r, 'SUB TOTAL IN BASE CURRENCY', { text: true, bold: true });
    put(sheet, 'D', r, cash); put(sheet, 'E', r, mv); put(sheet, 'F', r, cash + mv);
    put(sheet, 'G', r, cash); put(sheet, 'H', r, mv); put(sheet, 'I', r, cash + mv);
    for (const c of ['J','K','L','M','N','O']) put(sheet, c, r, 0); };
  row(7, 'Axos Bank', 'PNTHR_Axos_890000204895', N(bankCash), 0);
  sub(8, N(bankCash), 0);
  row(10, 'Interactive', BROKER_ACCT, N(brokerCash), N(portfolioMV));
  sub(11, N(brokerCash), N(portfolioMV));
  put(sheet, 'A', 13, 'GRAND TOTAL IN BASE CURRENCY', { text: true, bold: true });
  const tc = N(bankCash) + N(brokerCash), tm = N(portfolioMV);
  put(sheet, 'D', 13, tc); put(sheet, 'E', 13, tm); put(sheet, 'F', 13, tc + tm);
  put(sheet, 'G', 13, tc); put(sheet, 'H', 13, tm); put(sheet, 'I', 13, tc + tm);
  for (const c of ['J','K','L','M','N','O']) put(sheet, c, 13, 0);
}

// ── "No Data Found" tabs (empty for a flat/clean month) ────────────────────────
function buildNoData(sheet) {
  put(sheet, 'A', sheet._sk.dataStart, 'No Data Found', { text: true });
}

// ── Public API ─────────────────────────────────────────────────────────────────
// data = { lots, otherTradingCost, secId, bankCash, brokerCash, portfolioMV, hasOpenPositions }
export function buildPortfolioNotebookSpec(data) {
  const secId = {};
  for (const l of data.lots || []) if (l.isin && secId[l.isin] == null) secId[l.isin] = navIdForIsin(l.isin);
  Object.assign(secId, data.secId || {});   // resolved (incl. PNTHR-assigned) ids override
  const out = { sheets: [] };
  for (const s of SKELETON.sheets) {
    const sheet = fromSkeleton(s.name);
    switch (s.name) {
      case 'Realized Tax Lot':
        buildRealizedTaxLot(sheet, { lots: data.lots || [], otherTradingCost: data.otherTradingCost, secId }); break;
      case 'Reconciliation Summary':
        buildReconciliation(sheet, data); break;
      case 'Glossary': break;   // fully static
      // Genuinely empty for a flat/clean month (June liquidated to cash → 0 open positions/lots;
      // clean books → no breaks) — "No Data Found" is CORRECT here.
      case 'Portfolio Valuation':
      case 'Open Tax Lot':
      case 'Trade Break':
      case 'Trade Pending Cash':
      case 'Unmapped Cash':
        buildNoData(sheet); break;
      // TODO (not yet built — do NOT emit a false "No Data Found"; header-only for now):
      // Trading Gain Loss, Attribution (needs GICS sector data — not in Flex), Top Movers,
      // Dividend Detail, Interest Detail. Header renders from the skeleton; data rows pending.
      default: break;
    }
    out.sheets.push(finalize(sheet));
  }
  return out;
}

export async function buildPortfolioNotebook(data) {
  return renderGridWorkbook(buildPortfolioNotebookSpec(data));
}

export { SKELETON as NOTEBOOK_SKELETON };
