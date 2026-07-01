// PNTHR Accounting — Trial Balance engine (Doc 3 foundation).
//
// Computes the period's 40-line double-entry GL by ROLLING FORWARD: this month's Begin (E) = last
// month's Ending (G); Ending (G) = Begin (E) + period change (F). Seed = pnthrAccountingTrialBalanceSeed.json
// (May-2026 endings, from NAV's own golden). Everything derives from the WORKING combined-MTM Flex
// query + the Bucket-B ledger + positions — the dead R&U query is NOT required.
//
// Convention: balance-sheet accounts carry natural balances (assets +, liabilities/credits −). P&L
// accounts are debit-positive (an expense/loss is +, income is −), matching NAV's "Net (Income)/Loss".
//
// RESIDUAL (labeled, not golden-validated): the gross split between interest income/expense and
// dividend income/expense (rows 28/29/31/32) — the NET ties exactly to broker truth, but the gross
// allocation follows IBKR's credit/debit + payment-in-lieu detail and could not be cell-matched to a
// NAV golden because IBKR cannot serve a month for which we also hold the golden. Flagged per line.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, 'pnthrAccountingTrialBalanceSeed.json'), 'utf8'));
const r2 = (n) => +(+(n || 0)).toFixed(2);
const r6 = (n) => +(+(n || 0)).toFixed(6);
const N = (v) => +(+v || 0);

// Seed lookup by GL financial-account label (stable key across months).
const seedByFinancial = Object.fromEntries(SEED.accounts.map((a) => [a.financial, a]));
function begin(financial) {
  const a = seedByFinancial[financial];
  return a ? N(a.mayEnding) : 0;
}

// ── Extract the period's raw figures from parsed Flex + ledger ────────────────
export function trialBalanceInputs({ parsed, ledger, bankBalance }) {
  const S = parsed.sections || {};
  const c = (S.ChangeInNAV || [])[0] || {};
  const cash = (S.CashReport || [])[0] || {};
  const eq = S.EquitySummaryInBase || [];
  const last = eq[eq.length - 1] || {};
  const fifo = S.FIFOPerformanceSummaryInBase || [];
  const tier = S.TierInterestDetails || [];

  // Commission from ChangeInNAV if the combined-MTM query, else CashReport (the R&U query bundles
  // commission into "realized" and reports ChangeInNAV.commissions=0).
  const commission = r2(N(c.commissions) || N(cash.commissions));
  // Combined trading P&L EXCLUDING commission: use ChangeInNAV.mtm if present (combined query),
  // else reconstruct from the R&U split minus commission.
  const mtm = N(c.mtm) !== 0 ? N(c.mtm) : r6(N(c.realized) + N(c.changeInUnrealized) - commission);
  const endUnrealized = r6(fifo.reduce((a, r) => a + N(r.totalUnrealizedPnl), 0));   // 0 when flat
  const stockMarket = r6(N(last.stock));
  const brokerCash = r6(N(last.cash));
  const divAccrualEnd = r6(N(last.dividendAccruals));
  const intAccrualEnd = r6(N(last.interestAccruals));

  // Interest gross (credit=income, debit=expense) from tier detail; net reconciled to ChangeInNAV.
  const tierCredit = r2(tier.filter((r) => /Credit/i.test(r.interestType)).reduce((a, r) => a + N(r.totalInterest), 0));
  const tierDebit = r2(tier.filter((r) => /Debit/i.test(r.interestType)).reduce((a, r) => a + N(r.totalInterest), 0));
  const netInterestToNav = r2(N(c.interest) + N(c.changeInInterestAccruals));         // authoritative net (ties)

  // Dividends: ChangeInNAV.dividends is gross (cash + payment-in-lieu); accrual change ties.
  const grossDividends = r2(N(c.dividends));
  const paymentInLieu = r2(N(cash.paymentInLieu));
  const netDividendToNav = r2(N(c.dividends) + N(c.changeInDividendAccruals));

  return {
    mtm, endUnrealized, stockMarket, brokerCash, divAccrualEnd, intAccrualEnd,
    commissions: commission, otherFees: r2(N(c.otherFees) || N(cash.otherFees)),
    tierCredit, tierDebit, netInterestToNav, grossDividends, paymentInLieu, netDividendToNav,
    changeInDivAccruals: r2(N(c.changeInDividendAccruals)),
    bankBalance: r2(bankBalance), ledger,
  };
}

// ── Compute the full Trial Balance for a period ──────────────────────────────
// Returns { accounts:[{financial,gl,category,broker,begin,change,ending,note?}], subtotals, checks }.
export function computeTrialBalance(period, inputs) {
  const L = inputs.ledger || {};
  const beginUnreal = begin('Long Portfolio Value-Unrealized Gain/Loss');

  // Period change in the balance-sheet unrealized asset (NAV's TB basis).
  const changeUnrealBS = r6(inputs.endUnrealized - beginUnreal);
  // Trading total (debit-positive) = -mtm; split into realized + change-in-unrealized (P&L).
  const tradingTotalDebit = r2(-inputs.mtm);
  const changeUnrealPL = r2(-changeUnrealBS);                 // double-entry with the BS asset
  const realizedPL = r2(tradingTotalDebit - changeUnrealPL);  // remainder = realized

  // Gross interest split (RESIDUAL — net ties, gross derived from tier detail).
  const grossIntIncome = r2(inputs.tierCredit);               // credit interest earned
  // expense reconciled so income - expense = net-to-nav (keeps NAV tie exact):
  const grossIntExpense = r2(grossIntIncome - inputs.netInterestToNav);

  // Gross dividend split (RESIDUAL): expense = payment-in-lieu; income set so the two lines NET to
  // the tied net-dividend figure (income - expense = net-to-NAV).
  const divExpense = r2(inputs.paymentInLieu);
  const divIncome = r2(inputs.netDividendToNav + divExpense);

  // Helper to build a line: ending = begin + change (balance sheet) OR begin + change (P&L cumulative).
  const line = (financial, change, note) => {
    const s = seedByFinancial[financial] || {};
    return { financial, gl: s.gl, category: s.category, broker: s.broker, begin: N(s.mayEnding), change: r6(change), ending: r6(N(s.mayEnding) + change), note };
  };
  // Balance-sheet line where we KNOW the ending; change = ending - begin.
  const bsEnd = (financial, ending, note) => {
    const s = seedByFinancial[financial] || {};
    return { financial, gl: s.gl, category: s.category, broker: s.broker, begin: N(s.mayEnding), change: r6(ending - N(s.mayEnding)), ending: r6(ending), note };
  };

  const accounts = [
    // ── Assets / Liabilities (balance sheet) ──
    bsEnd('Bank Balance', inputs.bankBalance),
    bsEnd('Broker Cash Balance', inputs.brokerCash),
    bsEnd('Long Portfolio Value- Cost', r6(inputs.stockMarket - inputs.endUnrealized)),
    bsEnd('Long Portfolio Value-Unrealized Gain/Loss', inputs.endUnrealized),
    bsEnd('Broker Interest Receivable', inputs.intAccrualEnd >= 0 ? inputs.intAccrualEnd : 0, 'RESIDUAL: interest receivable/payable gross split'),
    bsEnd('Dividend Receivable - US Stock', inputs.divAccrualEnd),
    bsEnd('Broker Interest Payable', inputs.intAccrualEnd < 0 ? inputs.intAccrualEnd : 0, 'RESIDUAL: interest receivable/payable gross split'),
    bsEnd('Administration Expenses Payable', N(L.adminPayable) * -1 === 0 ? N(L.adminPayable) : -Math.abs(N(L.adminPayable))),
    bsEnd('Professional Expenses Payable', -Math.abs(N(L.professionalPayable))),
    bsEnd('Operating Expenses Payable', -Math.abs(N(L.operatingPayable))),
    bsEnd('Organization Cost Prepaid', N(L.orgPrepaid)),
    bsEnd('Due from Affiliates', N(L.dueFromAffiliates)),
    // ── Income / Expense (P&L, cumulative; change = period activity) ──
    line('Realized P&L - Short Term', realizedPL),
    line('Change In Unrealized P&L', changeUnrealPL),
    line('Commission Expenses', r2(-inputs.commissions)),
    line('Other Trading Cost', r2(-inputs.otherFees)),
    line('Broker Interest Income', r2(-grossIntIncome), 'RESIDUAL: interest income gross split'),
    line('Dividend Income - US Stock', r2(-divIncome), 'RESIDUAL: dividend income gross split'),
    line('Dividend Income - Foreign Stock', 0),
    line('Broker Interest Expense', r2(grossIntExpense), 'RESIDUAL: interest expense gross split'),
    line('Dividend Expense - US Stock', r2(divExpense), 'RESIDUAL: dividend expense (payment-in-lieu)'),
    line('Dividend Expense - Foreign Stock', 0),
    // ── Bucket-B operating/org expenses (period change from ledger expenseLines) ──
    line('Administration Expenses', Math.abs(N(L.expenseLines?.admin))),
    line('Legal Expenses', 0),
    line('Professional Expenses', Math.abs(N(L.expenseLines?.professional))),
    line('Operating Expenses', Math.abs(N(L.expenseLines?.operating))),
    line('Organization Cost', Math.abs(N(L.expenseLines?.orgCost))),
    line('Reimbursement to/from Affiliates', -Math.abs(N(L.expenseLines?.reimbursement))),
    // ── Capital ──
    line('Beginning Capital', 0),
    line('Begin Of Period Additions', 0),
  ];

  // Subtotals (per the seed's subtotal defs, matched by seed row → financial).
  const bsAssetsLiab = accounts.filter((a) => [
    'Bank Balance','Broker Cash Balance','Long Portfolio Value- Cost','Long Portfolio Value-Unrealized Gain/Loss',
    'Broker Interest Receivable','Dividend Receivable - US Stock','Broker Interest Payable',
    'Administration Expenses Payable','Professional Expenses Payable','Operating Expenses Payable',
    'Organization Cost Prepaid','Due from Affiliates'].includes(a.financial));
  const pnl = accounts.filter((a) => [
    'Realized P&L - Short Term','Change In Unrealized P&L','Commission Expenses','Other Trading Cost',
    'Broker Interest Income','Dividend Income - US Stock','Dividend Income - Foreign Stock','Broker Interest Expense',
    'Dividend Expense - US Stock','Dividend Expense - Foreign Stock','Administration Expenses','Legal Expenses',
    'Professional Expenses','Operating Expenses','Organization Cost','Reimbursement to/from Affiliates'].includes(a.financial));

  const sum = (arr, k) => r6(arr.reduce((a, x) => a + x[k], 0));
  const subtotals = {
    netAssets: { begin: sum(bsAssetsLiab, 'begin'), change: sum(bsAssetsLiab, 'change'), ending: sum(bsAssetsLiab, 'ending') },  // = fund NAV
    netIncomeLoss: { begin: sum(pnl, 'begin'), change: sum(pnl, 'change'), ending: sum(pnl, 'ending') },
  };

  // Internal checks (necessary conditions).
  const netIncomeThisPeriod = r2(-subtotals.netIncomeLoss.change);   // -(debit-positive net loss) = net income
  const checks = {
    everyLineBalances: accounts.every((a) => Math.abs(r6(a.begin + a.change) - a.ending) < 1e-6),
    navEnding: r2(subtotals.netAssets.ending),
  };
  return { period, accounts, subtotals, netIncomeThisPeriod, checks };
}

export { SEED as TB_SEED };
