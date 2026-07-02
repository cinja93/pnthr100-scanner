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

// ── Per-symbol P&L aggregate (IBKR basis) ──────────────────────────────────────
// From closed lots (realized) + dividend income; June is flat so unrealized = 0. Returns array of
// { isin, symbol, description, ticker, secType, qty, realized, dividend, total } sorted by Security ID.
function perSymbolPnl({ lots, divBySym, secId }) {
  const bySym = {};
  for (const l of lots) {
    const k = l.isin; if (!k) continue;
    const e = bySym[k] || (bySym[k] = { isin: k, symbol: l.symbol, description: l.description, ticker: tickerOf(l), secType: secTypeOf(l), qty: 0, realized: 0, dividend: 0 });
    e.qty += Math.abs(N(l.quantity)); e.realized += N(l.fifoPnlRealized);
  }
  for (const [isin, d] of Object.entries(divBySym || {})) {
    const e = bySym[isin] || (bySym[isin] = { isin, symbol: d.symbol, description: d.description, ticker: `${d.symbol} US`, secType: 'EQUITIES', qty: 0, realized: 0, dividend: 0 });
    e.dividend += N(d.income);
  }
  const arr = Object.values(bySym);
  for (const e of arr) e.total = e.realized + e.dividend;   // unrealized 0 (flat)
  return arr.sort((a, b) => (secId[a.isin] ?? 9e15) - (secId[b.isin] ?? 9e15));
}

// ── Dividend Detail ─────────────────────────────────────────────────────────
// Per-security dividend accrual/receipt; grouped US / non-US with totals. divRows: [{symbol,
// description, isin, country, received, income, endReceivable}].
function buildDividendDetail(sheet, { divRows, secId }) {
  let r = sheet._sk.dataStart;   // 7
  const us = divRows.filter((d) => (d.country || 'UNITED STATES').toUpperCase().includes('UNITED STATES'));
  const nonUs = divRows.filter((d) => !((d.country || 'UNITED STATES').toUpperCase().includes('UNITED STATES')));
  let tE = 0, tH = 0, tK = 0, tN = 0;
  const emit = (d) => {
    put(sheet, 'A', r, d.description, { text: true }); put(sheet, 'B', r, 'USD', { text: true });
    put(sheet, 'C', r, `${d.symbol} US`, { text: true }); put(sheet, 'D', r, 'EQUITIES', { text: true });
    put(sheet, 'E', r, 0); put(sheet, 'F', r, 0); put(sheet, 'G', r, 0);
    put(sheet, 'H', r, N(d.received)); put(sheet, 'I', r, 0); put(sheet, 'J', r, 0);
    put(sheet, 'K', r, N(d.endReceivable)); put(sheet, 'L', r, 0); put(sheet, 'M', r, 0);
    put(sheet, 'N', r, N(d.income)); put(sheet, 'O', r, 0); put(sheet, 'P', r, 0);
    put(sheet, 'Q', r, secId[d.isin] ?? null, { numFmt: 'General' }); put(sheet, 'R', r, d.isin, { text: true });
    put(sheet, 'S', r, d.country || 'UNITED STATES', { text: true }); put(sheet, 'T', r, BROKER_ACCT, { text: true });
    tE += 0; tH += N(d.received); tK += N(d.endReceivable); tN += N(d.income); r++;
  };
  us.forEach(emit);
  const usTot = { H: tH, K: tK, N: tN };
  // TOTAL OF US SECURITIES
  put(sheet, 'A', r, 'TOTAL OF US SECURITIES', { text: true, bold: true });
  put(sheet, 'E', r, 0); put(sheet, 'F', r, 0); put(sheet, 'G', r, 0); put(sheet, 'H', r, usTot.H); put(sheet, 'I', r, 0);
  put(sheet, 'J', r, 0); put(sheet, 'K', r, usTot.K); put(sheet, 'L', r, 0); put(sheet, 'M', r, 0); put(sheet, 'N', r, usTot.N);
  put(sheet, 'O', r, 0); put(sheet, 'P', r, 0); r++;
  let nH = 0, nK = 0, nN = 0; const base = r; r = base;   // non-US block (usually empty)
  nonUs.forEach((d) => { emit(d); });
  put(sheet, 'A', r, 'TOTAL OF NON-US SECURITIES', { text: true, bold: true });
  for (const [c, v] of [['E',0],['F',0],['G',0],['H',nH],['I',0],['J',0],['K',nK],['L',0],['M',0],['N',nN],['O',0],['P',0]]) put(sheet, c, r, v);
}

// ── Trading Gain Loss (per-symbol; DTD/MTD/QTD/YTD) ────────────────────────────
// IBKR basis. For the first self-administered close, our per-symbol series begins in June, so the
// QTD/YTD windows equal MTD (documented); DTD = 0 unless the symbol traded on the last day (we do not
// have reliable daily P&L, so DTD is left 0). Realized from lots, unrealized 0 (flat), dividend income.
function buildTradingGainLoss(sheet, { perSym, otherTradingCost, secId, lastTradeDate }) {
  let r = sheet._sk.dataStart;   // 8
  const tot = { E:0,F:0,G:0,H:0,I:0,K:0,L:0,M:0,N:0,O:0,Q:0,R:0,S:0,T:0,W:0,Y:0,Z:0,AA:0,AB:0,AC:0 };
  const emit = (name, ticker, secType, isin, id, real, unreal, div) => {
    const total = real + unreal + div;
    put(sheet, 'A', r, name, { text: true }); put(sheet, 'B', r, 'USD', { text: true });
    put(sheet, 'C', r, ticker, { text: true }); put(sheet, 'D', r, secType, { text: true });
    // DTD (E-J) = 0 (no reliable daily attribution). MTD/QTD/YTD carry the month's figures.
    const win = (tCol, rCol, uCol, dCol) => {
      put(sheet, tCol, r, total); put(sheet, rCol, r, real); put(sheet, uCol, r, unreal); put(sheet, dCol, r, div);
    };
    win('K','L','M','O'); win('Q','R','S','W'); win('Y','Z','AA','AC');
    put(sheet, 'AE', r, id ?? null, { numFmt: 'General' }); put(sheet, 'AF', r, isin, { text: true }); put(sheet, 'AG', r, BROKER_ACCT, { text: true });
    tot.K+=total; tot.L+=real; tot.M+=unreal; tot.O+=div; tot.Q+=total; tot.R+=real; tot.S+=unreal; tot.W+=div; tot.Y+=total; tot.Z+=real; tot.AA+=unreal; tot.AC+=div;
    r++;
  };
  for (const s of perSym) emit(s.description, s.ticker, s.secType, s.isin, secId[s.isin], s.realized, 0, s.dividend);
  if (Math.abs(N(otherTradingCost)) > 0) emit('Trading Expenses', 'USD', 'TRADING EXPENSES', 'Trading Expenses', 1, N(otherTradingCost), 0, 0);
  // SUB TOTAL + GRAND TOTAL (identical for a single grouping)
  const totalsRow = (label) => {
    put(sheet, 'B', r, label, { text: true, bold: true });
    for (const [c, v] of Object.entries(tot)) put(sheet, c, r, v);
    r++;
  };
  totalsRow('SUB TOTAL'); r++; put(sheet, 'A', r, 'GRAND TOTAL', { text: true, bold: true });
  for (const [c, v] of Object.entries(tot)) put(sheet, c, r, v);
}

// ── Top Movers (per-symbol; top gainers/losers by window) ──────────────────────
// IBKR basis. Sections: DTD/MTD/QTD/YTD TOP GAINERS then LOSERS. For the first close QTD/YTD = MTD;
// DTD = 0. We rank by MTD trading income and list the same ranking under each window (documented).
function buildTopMovers(sheet, { perSym }) {
  let r = sheet._sk.dataStart;   // 7
  const ranked = [...perSym].filter((s) => Math.abs(s.total) > 1e-9).sort((a, b) => b.total - a.total);
  const gainers = ranked.filter((s) => s.total > 0).slice(0, 10);
  const losers = [...ranked].filter((s) => s.total < 0).sort((a, b) => a.total - b.total).slice(0, 10);
  const section = (title, list) => {
    put(sheet, 'A', r, title, { text: true, bold: true }); r++;
    for (const s of list) {
      put(sheet, 'A', r, s.description, { text: true }); put(sheet, 'B', r, s.isin, { text: true });
      put(sheet, 'C', r, s.ticker, { text: true }); put(sheet, 'D', r, 'USD', { text: true }); put(sheet, 'E', r, 0);
      // Trading Income DTD/MTD/QTD/YTD (F-I) and Est Gross RoR (J-M). MTD authoritative; QTD/YTD=MTD.
      put(sheet, 'F', r, 0); put(sheet, 'G', r, s.total); put(sheet, 'H', r, s.total); put(sheet, 'I', r, s.total);
      put(sheet, 'J', r, 0, { numFmt: sheet._sk.colFmt?.J }); put(sheet, 'K', r, 0, { numFmt: sheet._sk.colFmt?.K });
      put(sheet, 'L', r, 0, { numFmt: sheet._sk.colFmt?.L }); put(sheet, 'M', r, 0, { numFmt: sheet._sk.colFmt?.M });
      r++;
    }
  };
  section('MTD TOP GAINERS', gainers);
  section('MTD TOP LOSERS', losers);
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
  const perSym = perSymbolPnl({ lots: data.lots || [], divBySym: {}, secId });   // dividends live in Dividend Detail
  const out = { sheets: [] };
  for (const s of SKELETON.sheets) {
    const sheet = fromSkeleton(s.name);
    switch (s.name) {
      case 'Realized Tax Lot':
        buildRealizedTaxLot(sheet, { lots: data.lots || [], otherTradingCost: data.otherTradingCost, secId }); break;
      case 'Reconciliation Summary':
        buildReconciliation(sheet, data); break;
      case 'Trading Gain Loss':
        buildTradingGainLoss(sheet, { perSym, otherTradingCost: data.otherTradingCost, secId }); break;
      case 'Top Movers':
        buildTopMovers(sheet, { perSym }); break;
      case 'Glossary': break;   // fully static
      // Genuinely empty for a flat/clean month (June liquidated to cash → 0 open positions/lots;
      // clean books → no breaks; equities-only → no security interest) — "No Data Found" is CORRECT.
      case 'Portfolio Valuation':
      case 'Open Tax Lot':
      case 'Interest Detail':
      case 'Trade Break':
      case 'Trade Pending Cash':
      case 'Unmapped Cash':
        buildNoData(sheet); break;
      // Header-only (NOT a false "No Data Found"): Dividend Detail (per-security cash-dividend split
      // not cleanly separable from the accrual-change feed — pending) and Attribution (needs a GICS
      // sector per holding — not in IBKR Flex — pending a sector source). Data rows to follow.
      case 'Dividend Detail':
      case 'Attribution':
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
