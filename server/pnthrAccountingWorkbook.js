// PNTHR Accounting — Doc 3 Fund Accounting Workbook generator (10 tabs).
//
// Design: NAV's May golden (may_funds.xlsx) is committed as pnthrAccountingWorkbookTemplate.json —
// the exact static grid (labels, GL numbers, account categories, number formats, merges, column
// widths, SUBTOTAL formulas). This generator INHERITS that template byte-for-byte and OVERLAYS only
// the period-specific cells: the numeric values + the three date/timestamp strings. Every tab is a
// view of the Trial Balance (engine, validated to the penny) + the income statement + NAV roll +
// Fund Ledger + $0 fees, so the numbers are OURS (computed), placed onto NAV's exact template.
//
// Going forward we own the layout, so June+ keep May's fixed chart-of-accounts rows (a zero line
// renders as NAV's dash via the number format). Validation: feed May's fundamentals through the
// mappers, render, and diff cell-for-cell vs may_funds.xlsx (0 mismatches) — this proves layout,
// placement, formats, and every derived-cell formula. Number DERIVATION from raw Flex is proven
// separately by the June Trial Balance tie (pnthrAccountingTrialBalance.js) + reconciliation gate.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderGridWorkbook } from './pnthrAccountingRenderXlsx.js';
import { TB_SEED } from './pnthrAccountingTrialBalance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = JSON.parse(fs.readFileSync(path.join(__dirname, 'pnthrAccountingWorkbookTemplate.json'), 'utf8'));
const WB_SEED = JSON.parse(fs.readFileSync(path.join(__dirname, 'pnthrAccountingWorkbookSeed.json'), 'utf8'));

const N = (v) => (v == null || v === '' ? 0 : Number(v));
// Emit full float precision (NAV stores unrounded floats). Rounding to a fixed decimal count can
// land a value on a banker's-rounding boundary and disagree with NAV at the 4th decimal, so we
// only coerce to Number and never truncate.
const r6 = (n) => +(n || 0);
const seedByRow = Object.fromEntries(TB_SEED.accounts.map((a) => [a.row, a]));
const seedByFinancial = Object.fromEntries(TB_SEED.accounts.map((a) => [a.financial, a]));
// Account Summary attributes each account to a custodian column by the GL's broker field:
// Axos bank -> F, the fund account -> E, IBKR -> G.
function acctCol(financial) {
  const b = seedByFinancial[financial]?.broker || '';
  if (/bank|axos/i.test(b)) return 'F';
  if (/fund account/i.test(b)) return 'E';
  return 'G';
}

// ── Overlay plumbing ─────────────────────────────────────────────────────────
// A per-tab mapper returns { ref: value }. buildWorkbook clones the template sheet and replaces
// the value of each ref that EXISTS in the template (keeping the template's numFmt/bold/formula),
// leaving labels/structure/formats exactly as NAV authored them. Refs NOT in the template are
// ignored — NAV leaves a zero income line BLANK (not dashed), so a mapper freely computes every
// line and the blank ones (absent from the template) simply don't render. A non-zero value whose
// ref is missing from the template signals a going-forward shape change and is logged.
function overlaySheet(templateSheet, valueMap) {
  const present = new Set(templateSheet.cells.map((c) => c.ref));
  const cells = templateSheet.cells.map((c) =>
    Object.prototype.hasOwnProperty.call(valueMap, c.ref) ? { ...c, value: valueMap[c.ref] } : c);
  for (const [ref, value] of Object.entries(valueMap)) {
    if (!present.has(ref) && typeof value === 'number' && Math.abs(value) > 1e-9) {
      console.warn(`[workbook] ${templateSheet.name}: nonzero ${ref}=${value} not in template (shape change?)`);
    }
  }
  return { ...templateSheet, cells };
}

function sheetByName(name) {
  const s = TEMPLATE.sheets.find((x) => x.name === name);
  if (!s) throw new Error(`template missing sheet ${name}`);
  return s;
}

// ── Tab mappers ──────────────────────────────────────────────────────────────
// Each takes the normalized `f` (fundamentals) and returns { ref: value }.

function mapReportLinks(f) {
  return { A3: `For the Period ${f.dates.monthStart} to ${f.dates.monthEnd}` };
}

function mapManagementFee(f) {
  const m = f.mgmtFee;
  return {
    A4: `For the Period ${f.dates.monthStart}  To  ${f.dates.monthEnd}`,
    D8: r6(m.base),      // Management Fee Base = ending NAV
    // E8 (rate 0) and F8 (fee 0) are already 0 in the template; D9/F9 are SUBTOTAL formulas (kept).
    A11: `Report generated on ${f.dates.genTs}`,
  };
}

function mapBalanceSheet(f) {
  const t = f.tb;   // { financial: {begin, change, ending} }
  const asset = (fin) => r6(t[fin].ending);
  const liab = (fin) => r6(-t[fin].ending);   // liabilities shown positive on the balance sheet
  const totalAssets = r6(
    asset('Broker Cash Balance') + asset('Bank Balance') + asset('Long Portfolio Value- Cost') +
    asset('Long Portfolio Value-Unrealized Gain/Loss') + asset('Broker Interest Receivable') +
    asset('Dividend Receivable - US Stock') + asset('Organization Cost Prepaid') + asset('Due from Affiliates'));
  const totalLiab = r6(
    liab('Broker Interest Payable') + liab('Administration Expenses Payable') +
    liab('Professional Expenses Payable') + liab('Operating Expenses Payable'));
  return {
    A4: `As of ${f.dates.monthEnd}`,
    D7: asset('Broker Cash Balance'),
    D8: asset('Bank Balance'),
    D9: asset('Long Portfolio Value- Cost'),
    D10: asset('Long Portfolio Value-Unrealized Gain/Loss'),
    D11: asset('Broker Interest Receivable'),
    D12: asset('Dividend Receivable - US Stock'),
    D13: asset('Organization Cost Prepaid'),
    D14: asset('Due from Affiliates'),
    D15: totalAssets,
    D17: liab('Broker Interest Payable'),
    D18: liab('Administration Expenses Payable'),
    D19: liab('Professional Expenses Payable'),
    D20: liab('Operating Expenses Payable'),
    D21: totalLiab,
    D23: r6(totalAssets - totalLiab),   // Ending NAV (balance-sheet identity)
    A25: `Report generated on: ${f.dates.genTs}`,
  };
}

// ── Trial Balance tab ─────────────────────────────────────────────────────────
// Places the engine's begin(E)/change(F)/ending(G) per account at the seed's fixed rows, then
// COMPUTES the four subtotal rows (cash, Net Assets, Net (Income)/Loss, Capital) from the seed's
// sumRows. Labels/GL/category/broker are static (template). f.tb keyed by financial account.
function mapTrialBalance(f) {
  const out = { A4: `As of ${f.dates.priorMonthEnd} and ${f.dates.monthEnd}`, B46: f.dates.genTs };
  for (const a of TB_SEED.accounts) {
    const v = f.tb[a.financial];
    if (!v) continue;
    out[`E${a.row}`] = r6(v.begin);
    out[`F${a.row}`] = r6(v.change);
    out[`G${a.row}`] = r6(v.ending);
  }
  for (const s of TB_SEED.subtotals) {
    let e = 0, ch = 0, g = 0;
    for (const row of s.sumRows) {
      const fin = seedByRow[row]?.financial;
      const v = fin && f.tb[fin];
      if (v) { e += v.begin; ch += v.change; g += v.ending; }
    }
    out[`E${s.row}`] = r6(e); out[`F${s.row}`] = r6(ch); out[`G${s.row}`] = r6(g);
  }
  return out;
}

// ── Statement of Income helper ──────────────────────────────────────────────────
// li per column = the 16 income/expense lines. Returns the four NAV subtotals.
const IS_LINES = ['realizedPL','unrealizedPL','commission','otherTradingCost','brokerIntIncome',
  'divIncomeUS','divIncomeForeign','brokerIntExpense','divExpenseUS','divExpenseForeign',
  'admin','legal','professional','operating','orgCost','reimbursement'];
function incomeSubtotals(li) {
  const g = (k) => N(li[k]);
  const trading = g('realizedPL') + g('unrealizedPL') + g('commission') + g('otherTradingCost');
  const totalIncome = trading + g('brokerIntIncome') + g('divIncomeUS') + g('divIncomeForeign');
  const totalExpenses = g('brokerIntExpense') + g('divExpenseUS') + g('divExpenseForeign') +
    g('admin') + g('legal') + g('professional') + g('operating') + g('orgCost') + g('reimbursement');
  return { trading, totalIncome, totalExpenses, netIncome: totalIncome + totalExpenses };
}

// ── Account Statement tab (columns B=PTD C=MTD D=QTD E=YTD) ──────────────────────
// f.is[line] = {ptd,mtd,qtd,ytd}; f.navRoll.beginning = {ptd,mtd,qtd,ytd}. Everything else derived.
function mapAccountStatement(f) {
  const cols = { B: 'ptd', C: 'mtd', D: 'qtd', E: 'ytd' };
  const row = { realizedPL: 8, unrealizedPL: 9, commission: 10, otherTradingCost: 11,
    brokerIntIncome: 14, divIncomeUS: 15, divIncomeForeign: 16, brokerIntExpense: 19,
    divExpenseUS: 20, divExpenseForeign: 21, admin: 22, legal: 23, professional: 24,
    operating: 25, orgCost: 26, reimbursement: 27 };
  const out = {
    A4: `For the Period Ended ${f.dates.monthNameYear}`,
    C4: `Start Of Period : ${f.dates.monthStart}`,
    C5: `End Of Period  : ${f.dates.monthEnd}`,
    A40: `Report generated on: ${f.dates.genTs}`,
  };
  for (const [col, k] of Object.entries(cols)) {
    const li = {}; for (const line of IS_LINES) li[line] = f.is[line]?.[k] || 0;
    for (const line of IS_LINES) out[`${col}${row[line]}`] = r6(li[line]);
    const s = incomeSubtotals(li);
    const beginning = N(f.navRoll.beginning[k]);
    out[`${col}12`] = r6(s.trading);
    out[`${col}17`] = r6(s.totalIncome);
    out[`${col}28`] = r6(s.totalExpenses);
    out[`${col}29`] = r6(s.netIncome);
    out[`${col}31`] = r6(beginning);
    out[`${col}33`] = r6(s.netIncome);
    out[`${col}35`] = r6(beginning + s.netIncome);           // ending balance
    out[`${col}36`] = beginning === 0 ? 0 : r6(s.netIncome / beginning); // NET ROR
  }
  return out;
}

// ── Summary Equity Schedule (single investor; row 8 + total row 9) ───────────────
// f.equitySummary = { beginning, grossIncome, incentiveFee }. RORs from f.navRoll.ror.
function mapSummaryEquity(f) {
  const e = f.equitySummary, ror = f.navRoll.ror;
  const base = N(e.beginning);                  // + period-begin capital changes (0)
  const net = N(e.grossIncome) - N(e.incentiveFee);
  const ending = base + net;
  const cells = { D: base, E: 0, F: base, G: N(e.grossIncome), H: N(e.incentiveFee), I: net, J: 0,
    K: ending, L: ror.ptd, M: ror.mtd, N: ror.qtd, O: ror.ytd };
  const out = { A4: `For the Period ${f.dates.monthStart} To ${f.dates.monthEnd}`, B11: f.dates.genTs };
  for (const [col, v] of Object.entries(cells)) { out[`${col}8`] = r6(v); out[`${col}9`] = r6(v); }
  return out;
}

// ── Detailed Equity Schedule (single investor; wide) ─────────────────────────────
// Re-presents the MTD income-statement lines per investor + the roll + gross/net RORs.
function mapDetailedEquity(f) {
  const m = (k) => N(f.is[k]?.mtd);
  const beginning = N(f.equitySummary.beginning);
  const realizedST = m('realizedPL');
  const brokerCommission = m('commission') + m('otherTradingCost');
  const changeUnreal = m('unrealizedPL');
  const brokerInt = m('brokerIntIncome');
  const usDiv = m('divIncomeUS') + m('divIncomeForeign');
  const intExpense = m('brokerIntExpense') + m('divExpenseUS') + m('divExpenseForeign');
  const operatingExp = m('admin') + m('legal') + m('professional') + m('operating') + m('reimbursement');
  const orgCost = m('orgCost');
  const grossIncome = realizedST + brokerCommission + changeUnreal + brokerInt + usDiv + intExpense + operatingExp + orgCost;
  const mgmtBase = beginning + grossIncome;      // = ending NAV (fees waived)
  const mgmtFee = 0, incentive = 0;
  const netIncome = grossIncome - mgmtFee - incentive;
  const ending = beginning + netIncome;
  const grossRor = beginning === 0 ? 0 : grossIncome / beginning;
  const netRor = beginning === 0 ? 0 : netIncome / beginning;
  const R = f.navRoll.ror;                         // QTD/YTD from anchors (net == gross, fees 0)
  const cells = { D: beginning, E: 0, F: beginning, G: beginning, H: realizedST, I: brokerCommission,
    J: changeUnreal, K: brokerInt, L: usDiv, M: intExpense, N: operatingExp, O: orgCost, P: grossIncome,
    Q: mgmtBase, R: mgmtFee, S: N(f.equity.cumulativeProfit), T: incentive, U: netIncome, V: 0, W: ending,
    X: 0, Y: grossRor, Z: netRor, AA: grossRor, AB: netRor, AC: R.qtd, AD: R.qtd, AE: R.ytd, AF: R.ytd };
  const out = { A4: `For the Period ${f.dates.monthStart}  To  ${f.dates.monthEnd}`, B11: f.dates.genTs };
  for (const [col, v] of Object.entries(cells)) { out[`${col}8`] = r6(v); out[`${col}9`] = r6(v); }
  return out;
}

// ── Incentive Fee (single investor; fee $0 while underwater / waived) ────────────
// Roll-forward state (hurdle base/rate/amount, cumulative hurdle profit, cumulative profit carry
// forward) is atomic (f.incentive); K/L and the gain-for-period are derived; fees are 0.
function mapIncentiveFee(f) {
  const i = f.incentive;
  const gain = N(f.equitySummary.grossIncome) - N(f.equitySummary.incentiveFee); // net income for period
  const cumProfit = N(i.cumProfitCarryFwd) + gain;
  const outPerf = cumProfit - N(i.cumHurdleProfit);
  const ending = N(i.endingCapital);
  const cells = { D: N(i.hurdleBase), E: i.hurdleRate, F: N(i.hurdleAmt), G: N(i.cumHurdleProfit),
    H: 0, I: N(i.cumProfitCarryFwd), J: gain, K: cumProfit, L: outPerf, M: 0, N: 0, O: 0, P: 0, Q: 0,
    R: ending };
  const out = { A4: `For the Period ${f.dates.monthStart} To ${f.dates.monthEnd}`, A11: `Report generated on ${f.dates.genTs}` };
  const totalSkip = new Set(['E', 'M']);   // NAV's Incentive-Fee total row omits the two rate columns
  for (const [col, v] of Object.entries(cells)) {
    out[`${col}8`] = r6(v);
    if (!totalSkip.has(col)) out[`${col}9`] = r6(v);
  }
  return out;
}

// ── Account Summary (Statement of Net Assets by Account) ─────────────────────────
// Columns D=Total, E=Fund Account, F=Axos Bank, G=IBKR. Three sections: cash receipts/payments
// (gross flows, atomic from Flex CashReport), the balance-sheet view (tb endings attributed by
// custodian), and the P&L view (mtd income lines attributed). Net-asset and net-income rows and
// the ROR are derived.
function mapAccountSummary(f) {
  const t = f.tb, cf = f.cashflow, out = {};
  out.A4 = `For the Period ${f.dates.monthStart} To ${f.dates.monthEnd}`;
  out.A52 = `Report generated on: ${f.dates.genTs}`;
  const put = (row, col, v) => { out[`${col}${row}`] = r6(v); };
  const putTotalIn = (row, financial, v) => { put(row, 'D', v); put(row, acctCol(financial), v); };

  // ── Section 1: cash flows (rows 8-19) ──
  const bc = cf.beginningCash;
  put(8, 'D', bc.total); put(8, 'E', bc.fund); put(8, 'F', bc.bank); put(8, 'G', bc.broker);
  const brokerFlow = (row, v) => { put(row, 'D', v); put(row, 'G', v); };
  brokerFlow(9, cf.salesLong); brokerFlow(10, cf.salesShort); brokerFlow(11, cf.brokerIntReceived);
  brokerFlow(12, cf.divReceived); brokerFlow(13, cf.purchasesLong); brokerFlow(14, cf.purchasesBuyToCover);
  brokerFlow(15, cf.commissionPaid); brokerFlow(16, cf.otherTradingCostPaid); brokerFlow(17, cf.brokerIntPaid);
  put(18, 'D', cf.operatingExpPaid); put(18, 'F', cf.operatingExpPaid);            // paid from the bank
  const bankEnd = N(t['Bank Balance'].ending), brokerCashEnd = N(t['Broker Cash Balance'].ending);
  put(19, 'D', bankEnd + brokerCashEnd); put(19, 'F', bankEnd); put(19, 'G', brokerCashEnd);

  // ── Section 2: balance-sheet view (rows 21-30) attributed by custodian ──
  const bsRows = { 21: 'Long Portfolio Value- Cost', 22: 'Long Portfolio Value-Unrealized Gain/Loss',
    23: 'Broker Interest Receivable', 24: 'Dividend Receivable - US Stock', 25: 'Broker Interest Payable',
    26: 'Administration Expenses Payable', 27: 'Professional Expenses Payable', 28: 'Operating Expenses Payable',
    29: 'Organization Cost Prepaid', 30: 'Due from Affiliates' };
  for (const [row, fin] of Object.entries(bsRows)) putTotalIn(+row, fin, N(t[fin].ending));
  // Net assets row 31: fund/bank/broker splits of every balance-sheet ending (incl. the cash accounts).
  let fund = 0, broker = 0;
  const bsFin = ['Broker Cash Balance', 'Long Portfolio Value- Cost', 'Long Portfolio Value-Unrealized Gain/Loss',
    'Broker Interest Receivable', 'Dividend Receivable - US Stock', 'Broker Interest Payable',
    'Administration Expenses Payable', 'Professional Expenses Payable', 'Operating Expenses Payable',
    'Organization Cost Prepaid', 'Due from Affiliates'];
  for (const fin of bsFin) {
    const col = acctCol(fin), v = N(t[fin].ending);
    if (col === 'E') fund += v; else if (col === 'G') broker += v;
  }
  put(31, 'E', fund); put(31, 'F', bankEnd); put(31, 'G', broker); put(31, 'D', fund + bankEnd + broker);

  // ── Section 3: P&L view (rows 33-44) mtd income lines attributed ──
  const plRows = { 33: 'realizedPL', 34: 'unrealizedPL', 35: 'commission', 36: 'otherTradingCost',
    37: 'brokerIntIncome', 38: 'divIncomeUS', 39: 'brokerIntExpense', 40: 'admin', 41: 'professional',
    42: 'operating', 43: 'orgCost', 44: 'reimbursement' };
  const plFin = { realizedPL: 'Realized P&L - Short Term', unrealizedPL: 'Change In Unrealized P&L',
    commission: 'Commission Expenses', otherTradingCost: 'Other Trading Cost', brokerIntIncome: 'Broker Interest Income',
    divIncomeUS: 'Dividend Income - US Stock', brokerIntExpense: 'Broker Interest Expense', admin: 'Administration Expenses',
    professional: 'Professional Expenses', operating: 'Operating Expenses', orgCost: 'Organization Cost',
    reimbursement: 'Reimbursement to/from Affiliates' };
  for (const [row, k] of Object.entries(plRows)) putTotalIn(+row, plFin[k], N(f.is[k]?.mtd));
  // Net income row 45: fund/broker split of every mtd P&L line.
  let plFundNet = 0, plBrokerNet = 0, plTotal = 0;
  for (const k of IS_LINES) {
    const v = N(f.is[k]?.mtd); plTotal += v;
    const col = acctCol(plFin[k] || seedByFinancial[k]?.financial || '');
    // legal/foreign-dividend lines share the fund/broker custody of their expense class:
    const fin = plFin[k] || ({ legal: 'Legal Expenses', divIncomeForeign: 'Dividend Income - Foreign Stock',
      divExpenseUS: 'Dividend Expense - US Stock', divExpenseForeign: 'Dividend Expense - Foreign Stock' }[k]);
    const c = acctCol(fin);
    if (c === 'E') plFundNet += v; else plBrokerNet += v;
  }
  put(45, 'D', plTotal); put(45, 'E', plFundNet); put(45, 'G', plBrokerNet);
  const beginning = N(f.navRoll.beginning.mtd);
  out.D47 = beginning === 0 ? 0 : r6(plTotal / beginning);
  return out;
}

// ── Operating Expense Schedule (per-accrual-line sub-ledger) ─────────────────────
// f.opExpense[row] = { begin, accrual, paid, ytdAccrual, ytdPaid } for the 15 named accrual lines
// (rows 8-22); ending G = begin + accrual + paid. Row 23 = totals. The lower section (rows 26-28)
// lists the actual cash payments this month: f.opExpensePayments = [{ date, category, description, amount }].
const OPEX_ROWS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
function mapOperatingExpense(f) {
  const out = { A4: `For the Period ${f.dates.monthStart} To ${f.dates.monthEnd}`, A30: `Report generated on: ${f.dates.genTs}` };
  let D = 0, E = 0, F = 0, G = 0, H = 0, I = 0;
  for (const row of OPEX_ROWS) {
    const l = f.opExpense[row]; if (!l) continue;
    const end = N(l.begin) + N(l.accrual) + N(l.paid);
    out[`D${row}`] = r6(l.begin); out[`E${row}`] = r6(l.accrual); out[`F${row}`] = r6(l.paid);
    out[`G${row}`] = r6(end); out[`H${row}`] = r6(l.ytdAccrual); out[`I${row}`] = r6(l.ytdPaid);
    D += N(l.begin); E += N(l.accrual); F += N(l.paid); G += end; H += N(l.ytdAccrual); I += N(l.ytdPaid);
  }
  out.D23 = r6(D); out.E23 = r6(E); out.F23 = r6(F); out.G23 = r6(G); out.H23 = r6(H); out.I23 = r6(I);
  // Payments detail (rows 27+, total on the following row).
  const pays = f.opExpensePayments || [];
  let payTotal = 0;
  pays.forEach((p, i) => {
    const row = 27 + i;
    out[`A${row}`] = p.date; out[`B${row}`] = p.category; out[`C${row}`] = p.description; out[`D${row}`] = r6(p.amount);
    payTotal += N(p.amount);
  });
  out[`D${27 + pays.length}`] = r6(payTotal);
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────────
const MAPPERS = {
  ReportLinks: mapReportLinks,
  'Management Fee': mapManagementFee,
  'Balance Sheet': mapBalanceSheet,
  'Trial Balance': mapTrialBalance,
  'Account Statement': mapAccountStatement,
  'Summary Equity Schedule': mapSummaryEquity,
  'Detailed Equity Schedule': mapDetailedEquity,
  'Incentive Fee': mapIncentiveFee,
  'Account Summary': mapAccountSummary,
  'Operating Expense Schedule': mapOperatingExpense,
};

export function buildWorkbookSpec(f) {
  const sheets = TEMPLATE.sheets.map((tmpl) => {
    const mapper = MAPPERS[tmpl.name];
    if (!mapper) return tmpl;               // not yet implemented -> pass template through unchanged
    return overlaySheet(tmpl, mapper(f));
  });
  return { sheets };
}

export async function buildFundAccountingWorkbook(f) {
  return renderGridWorkbook(buildWorkbookSpec(f));
}

// The committed May anchors (WB_SEED) are the fixed PRE-TAKEOVER baseline: cumulative through
// this month-end. Self-administered closes (June-2026 onward) each contribute their own MTD; the
// windows below sum the baseline + the self-admin months that fall inside the target window.
export const SEED_THROUGH = { year: 2026, month: 5 };   // WB_SEED = cumulative through May 2026
const quarterOf = (m) => Math.ceil(m / 3);

// The 16 income-statement lines for ONE month, from the close's income (Bucket A) + ledger
// expenseLines (Bucket B). PTD == MTD for a monthly close. Exported so prior months can be
// re-derived identically when rolling QTD/YTD forward. Lines the close doesn't feed are 0.
export function monthlyMTD({ income = {}, expenseLines = {} } = {}) {
  return {
    realizedPL: N(income.realizedPL), unrealizedPL: N(income.unrealizedPL), commission: N(income.commission),
    otherTradingCost: N(income.otherTradingCost), brokerIntIncome: N(income.brokerInterestIncome),
    divIncomeUS: N(income.divIncomeUS), divIncomeForeign: 0, brokerIntExpense: N(income.brokerInterestExpense),
    divExpenseUS: 0, divExpenseForeign: 0, admin: N(expenseLines.admin), legal: 0,
    professional: N(expenseLines.professional), operating: N(expenseLines.operating),
    orgCost: N(expenseLines.orgCost), reimbursement: N(expenseLines.reimbursement),
  };
}

// ── Statement windows (PTD/MTD/QTD/YTD) — single source for the PDFs AND the workbook ──
// Exported so the two investor PDFs and the Fund Accounting Workbook's Account Statement tab are
// built from the SAME windows and cannot drift. STATELESS + self-healing: QTD/YTD are recomputed
// each time from the immutable May baseline + the stored self-admin months, so quarter/year
// rollovers are handled automatically and regenerating any month is safe.
//   income/expenseLines : THIS month's Bucket A / Bucket B (its MTD).
//   period              : "YYYY-MM" of this close (drives quarter/year membership).
//   history.priorMTD    : [{ year, month, lines }] for stored self-admin months BEFORE `period`.
//   history.quarterStartNAV / yearStartNAV : ending NAV before this quarter / year (null → seed).
// For the June-2026 bootstrap (seed quarter Q2 + seed year 2026, no prior self-admin months) this
// reduces exactly to seed + June-MTD, so June's output is unchanged.
export function buildStatementWindows({ income, expenseLines, beginning, period, history = {} }) {
  const cur = monthlyMTD({ income, expenseLines });
  const { priorMTD = [], quarterStartNAV = null, yearStartNAV = null } = history;
  const [Y, M] = period ? period.split('-').map(Number) : [SEED_THROUGH.year, SEED_THROUGH.month + 1];
  const Q = quarterOf(M);
  const seedQuarter = (Y === SEED_THROUGH.year && Q === quarterOf(SEED_THROUGH.month));  // seed covers this quarter
  const seedYear = (Y === SEED_THROUGH.year);                                            // seed covers this year
  const sameQuarter = priorMTD.filter((p) => p.year === Y && quarterOf(p.month) === Q);
  const sameYear = priorMTD.filter((p) => p.year === Y);
  const is = {};
  for (const k of IS_LINES) {
    const seedA = WB_SEED.isAnchors[k] || { qtd: 0, ytd: 0 };
    const qtd = (seedQuarter ? seedA.qtd : 0) + cur[k] + sameQuarter.reduce((s, p) => s + N(p.lines[k]), 0);
    const ytd = (seedYear ? seedA.ytd : 0) + cur[k] + sameYear.reduce((s, p) => s + N(p.lines[k]), 0);
    is[k] = { ptd: cur[k], mtd: cur[k], qtd, ytd };
  }
  const navBeginning = {
    ptd: beginning, mtd: beginning,
    qtd: seedQuarter ? WB_SEED.navBeginning.qtd : N(quarterStartNAV),
    ytd: seedYear ? WB_SEED.navBeginning.ytd : N(yearStartNAV),
  };
  return { mtd: cur, is, navBeginning };
}

// ── Going-forward fundamentals builder (June+) ──────────────────────────────────
// Assembles the normalized `f` the mappers consume from the monthly-close pieces + the committed
// May anchors (WB_SEED). MTD lines come from the close's income/expense mapping (which ties to the
// broker NAV change by construction); QTD/YTD roll the anchors + MTD; the Trial Balance comes from
// the validated engine. Presentational residuals (flagged): the incentive-fee HURDLE columns need
// the PPM day-count (the fee itself is $0 while deeply underwater), the interest/dividend GROSS
// split (net ties), and the Account Summary sales/purchases long-vs-short split (totals tie).
function ddmmyyyy(y, m, d) { return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`; }

export function buildWorkbookFundamentals(args) {
  const { period, tbAccounts, income, expenseLines, beginning, engEnding, netIncome, bankCharge,
    cashflow, genTs, history } = args;
  const [y, m] = period.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const prev = new Date(Date.UTC(y, m - 1, 0));
  const dates = {
    monthStart: ddmmyyyy(y, m, 1), monthEnd: ddmmyyyy(y, m, lastDay),
    priorMonthEnd: ddmmyyyy(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate()),
    monthNameYear: `${new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${lastDay}, ${y}`,
    genTs,
  };

  // Trial Balance (engine) -> keyed by financial account.
  const tb = {};
  for (const a of tbAccounts) tb[a.financial] = { begin: a.begin, change: a.change, ending: a.ending };

  // Income-statement windows (PTD/MTD/QTD/YTD) — SAME source the investor PDFs use, so the two
  // renderings of the statement cannot drift. Baseline + stored self-admin months (self-healing).
  const { is, navBeginning } = buildStatementWindows({ income, expenseLines, beginning, period, history });
  const navRoll = { beginning: navBeginning, ror: {} };
  for (const [col, k] of [['ptd', 'ptd'], ['mtd', 'mtd'], ['qtd', 'qtd'], ['ytd', 'ytd']]) {
    const li = {}; for (const line of IS_LINES) li[line] = is[line][k];
    const ni = incomeSubtotals(li).netIncome;
    const b = navRoll.beginning[k];
    navRoll.ror[col] = b === 0 ? 0 : ni / b;
  }

  // Incentive-fee roll (fee $0; cumulative-profit columns exact, hurdle columns best-effort).
  const inc = WB_SEED.incentive;
  const incentive = {
    hurdleBase: inc.hurdleBase, hurdleRate: inc.hurdleRate, hurdleAmt: inc.hurdleAmtMay,
    cumHurdleProfit: inc.cumHurdleProfitEnding + inc.hurdleAmtMay,  // roll the monthly hurdle accrual
    cumProfitCarryFwd: inc.cumProfitEnding, endingCapital: engEnding,
  };

  // Operating Expense per-line roll from the seed (June begin = May ending; recurring monthly accrual;
  // the Bank Charges line uses the month's actual bank charge, paid from the bank).
  const isBankCharge = (l) => /bank charge/i.test(l.description || '');
  const opExpense = {};
  for (const l of WB_SEED.opexLines) {
    const accrual = isBankCharge(l) ? N(bankCharge) : N(l.monthlyAccrual);
    const paid = isBankCharge(l) ? -N(bankCharge) : 0;
    opExpense[l.row] = {
      begin: l.endingMay, accrual, paid,
      ytdAccrual: N(l.ytdAccrualMay) + accrual, ytdPaid: N(l.ytdPaidMay) + paid,
    };
  }
  const opExpensePayments = N(bankCharge) > 0
    ? [{ date: ddmmyyyy(y, m, 15), category: 'Operating Expenses', description: 'Bank Charges', amount: -N(bankCharge) }]
    : [];

  return {
    dates, tb, is, navRoll,
    mgmtFee: { base: engEnding, rate: 0, fee: 0 },
    equitySummary: { beginning, grossIncome: netIncome, incentiveFee: 0 },
    equity: { cumulativeProfit: inc.cumProfitEnding + netIncome },
    incentive,
    cashflow,
    opExpense, opExpensePayments,
  };
}

export { TEMPLATE as WORKBOOK_TEMPLATE, WB_SEED as WORKBOOK_SEED };
