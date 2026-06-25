// PNTHR Accounting — monthly close orchestration (engine -> document data).
//
// Ties the engine's computed numbers to the renderers' data contracts. Given the raw
// inputs for a period (Bucket A line items + Bucket B accruals + capital balances),
// it runs the engine and emits the data object the PDF/Excel renderers consume — so
// the documents are produced from OUR computed numbers. Go-forward, the inputs come
// from IBKR Flex + the Fund Ledger; the same close produces July+ statements.

import { computeIncomeStatement, computeNavRollForward, computeRoR } from './pnthrAccountingEngine.js';

const COLS = 4; // PTD, MTD, QTD, YTD
const col = (arr, i) => (arr && arr[i] != null ? arr[i] : null);

// Build the Account Statement renderer payload from raw inputs.
// inputs.lineItems: each key is a 4-element array [PTD,MTD,QTD,YTD] (null allowed).
// inputs.beginning / inputs.additions / inputs.redemptions: 4-element arrays.
export function buildAccountStatement(inputs) {
  const li = inputs.lineItems;
  const trading = [], totalIncome = [], totalExpenses = [], netIncome = [], ending = [], ror = [];
  for (let i = 0; i < COLS; i++) {
    const r = computeIncomeStatement({
      realizedPL: col(li.realizedPL, i), unrealizedPL: col(li.unrealizedPL, i),
      commission: col(li.commission, i), otherTradingCost: col(li.otherTradingCost, i),
      brokerInterestIncome: col(li.brokerInterestIncome, i), divIncomeUS: col(li.divIncomeUS, i),
      divIncomeForeign: col(li.divIncomeForeign, i), brokerInterestExpense: col(li.brokerInterestExpense, i),
      divExpenseUS: col(li.divExpenseUS, i), divExpenseForeign: col(li.divExpenseForeign, i),
      admin: col(li.admin, i), legal: col(li.legal, i), professional: col(li.professional, i),
      operating: col(li.operating, i), orgCost: col(li.orgCost, i), reimbursement: col(li.reimbursement, i),
    });
    trading.push(r.tradingSubtotal); totalIncome.push(r.totalIncome);
    totalExpenses.push(r.totalExpenses); netIncome.push(r.netIncome);
    ending.push(computeNavRollForward({ beginning: col(inputs.beginning, i), additions: col(inputs.additions, i), netIncome: r.netIncome, redemptions: col(inputs.redemptions, i) }));
    ror.push(computeRoR({ netIncome: r.netIncome, beginning: col(inputs.beginning, i), additions: col(inputs.additions, i) }));
  }
  const hasAdditions = (inputs.additions || []).some(v => v != null && Number(v) !== 0);
  const hasRedemptions = (inputs.redemptions || []).some(v => v != null && Number(v) !== 0);

  const data = {
    header: inputs.header,
    income: [
      { type: 'subheader', label: 'Trading Income (Expenses):' },
      { label: 'Realized P&L - Short Term', values: li.realizedPL },
      { label: 'Change In Unrealized P&L', values: li.unrealizedPL },
      { label: 'Commission Expenses', values: li.commission },
      { label: 'Other Trading Cost', values: li.otherTradingCost },
      { type: 'subtotal', values: trading },
      { type: 'subheader', label: 'Other Incomes:' },
      { label: 'Broker Interest Income', values: li.brokerInterestIncome },
      { label: 'Dividend Income - US Stock', values: li.divIncomeUS },
      { label: 'Dividend Income - Foreign Stock', values: li.divIncomeForeign },
      { type: 'total', label: 'Total Income (Loss):', values: totalIncome },
      { type: 'subheader', label: 'Expenses:' },
      { label: 'Broker Interest Expense', values: li.brokerInterestExpense },
      { label: 'Dividend Expense - US Stock', values: li.divExpenseUS },
      { label: 'Dividend Expense - Foreign Stock', values: li.divExpenseForeign },
      { label: 'Administration Expenses', values: li.admin },
      { label: 'Legal Expenses', values: li.legal },
      { label: 'Professional Expenses', values: li.professional },
      { label: 'Operating Expenses', values: li.operating },
      { label: 'Organization Cost', values: li.orgCost },
      { label: 'Reimbursement to/from Affiliates', values: li.reimbursement },
      { type: 'total', label: 'Total Expenses:', values: totalExpenses },
      { type: 'net', label: 'Net Income (Loss) :', values: netIncome },
    ],
    navChanges: [
      { label: 'Beginning Balance', values: inputs.beginning },
      hasAdditions ? { label: 'Additions', values: inputs.additions } : { label: 'Additions' },
      { label: 'Net Income (Loss)', values: netIncome },
      hasRedemptions ? { label: 'Redemptions', values: inputs.redemptions } : { label: 'Redemptions' },
      { type: 'total', label: 'Ending Balance:', values: ending },
      { type: 'total', label: 'NET ROR:', values: ror, isPercent: true },
    ],
    certification: inputs.certification || 'TO THE BEST OF MY KNOWLEDGE AND BELIEF THE INFORMATION CONTAINED HEREIN IS ACCURATE AND COMPLETE.',
    signatory: inputs.signatory,
    generatedOn: inputs.generatedOn,
  };
  return { data, close: { trading, totalIncome, totalExpenses, netIncome, ending, ror } };
}
