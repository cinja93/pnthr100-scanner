// PNTHR Accounting — the fund-accounting engine.
//
// Computes the monthly close from the two input buckets and reconciles it, so the
// numbers are OURS (computed), not copied from NAV. These are pure, deterministic
// functions validated against NAV's actual monthly packages (Dec 2025 - May 2026) to
// the penny. Go-forward, Bucket A comes from IBKR Flex and Bucket B from the Fund
// Ledger; the SAME functions then produce July+ statements.
//
// Sign convention (matches NAV): income positive, expenses stored NEGATIVE, the GP
// expense reimbursement positive. So totals are simple additions.

const n = (v) => (v == null || v === '' ? 0 : Number(v));
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

// ── Statement of Income ─────────────────────────────────────────────────────────
// li = { realizedPL, unrealizedPL, commission, otherTradingCost, brokerInterestIncome,
//        divIncomeUS, divIncomeForeign, brokerInterestExpense, divExpenseUS,
//        divExpenseForeign, admin, legal, professional, operating, orgCost, reimbursement }
export function computeIncomeStatement(li) {
  const tradingSubtotal = n(li.realizedPL) + n(li.unrealizedPL) + n(li.commission) + n(li.otherTradingCost);
  const totalIncome = tradingSubtotal + n(li.brokerInterestIncome) + n(li.divIncomeUS) + n(li.divIncomeForeign);
  const totalExpenses = n(li.brokerInterestExpense) + n(li.divExpenseUS) + n(li.divExpenseForeign)
    + n(li.admin) + n(li.legal) + n(li.professional) + n(li.operating) + n(li.orgCost) + n(li.reimbursement);
  const netIncome = totalIncome + totalExpenses;
  return { tradingSubtotal, totalIncome, totalExpenses, netIncome };
}

// ── Statement of Changes in NAV ─────────────────────────────────────────────────
export function computeNavRollForward({ beginning, additions = 0, netIncome, redemptions = 0 }) {
  return n(beginning) + n(additions) + n(netIncome) - n(redemptions);
}

// ── Rate of Return ──────────────────────────────────────────────────────────────
// Simple net/beginning (matches NAV when there are no mid-period capital flows). When
// contributions/redemptions occur mid-period this must become time/flow-weighted —
// flagged for when the fund takes additional capital.
export function computeRoR({ netIncome, beginning, additions = 0 }) {
  // Allocation base = period-beginning capital + contributions made at period start
  // (covers the inception period, where beginning=0 and the base is the subscription).
  // Mid-period flows would require time-weighting — flagged for when that occurs.
  const base = n(beginning) + n(additions);
  if (base === 0) return 0;
  return n(netIncome) / base;
}

// ── Incentive fee (high-water mark + hurdle) ────────────────────────────────────
// Returns $0 while the investor is below the high-water mark / hurdle (cumulative
// profit <= cumulative hurdle profit) — which is the case for every month so far.
// The exact hurdle ACCRUAL/day-count and crystallization schedule come from the
// PPM/LPA; `cumulativeHurdleProfit` is taken as an input until those terms are wired.
export function computeIncentiveFee({ cumulativeProfitCarryForward, gainForPeriod, cumulativeHurdleProfit = 0, incentiveRate = 0.20 }) {
  const cumulativeProfit = n(cumulativeProfitCarryForward) + n(gainForPeriod);
  const outPerformance = cumulativeProfit - n(cumulativeHurdleProfit);
  const fee = outPerformance > 0 ? incentiveRate * outPerformance : 0;
  return { cumulativeProfit, outPerformance, fee };
}

// ── Balance-sheet identity (Assets - Liabilities = NAV) ─────────────────────────
export function reconcileBalanceSheet({ assets, liabilities, nav, tolerance = 0.01 }) {
  const computedNav = n(assets) - n(liabilities);
  const diff = computedNav - n(nav);
  return { computedNav, diff, ok: Math.abs(diff) <= tolerance };
}

// ── Reconciliation gate: our books vs the custodian (IBKR) + bank ───────────────
// booksNav must equal broker equity + bank balance + net fund-level accruals
// (the GP reimbursement receivable, expense payables, prepaid org cost, etc.).
// If this fails the monthly close is RED and must NOT be finalized/published.
export function reconcileToCustodian({ booksNav, brokerEquity, bankBalance, accruedNet = 0, tolerance = 0.01 }) {
  const custodian = n(brokerEquity) + n(bankBalance) + n(accruedNet);
  const diff = n(booksNav) - custodian;
  return { custodian, diff, ok: Math.abs(diff) <= tolerance };
}

// ── Investor capital roll-forward (cumulative chain) ────────────────────────────
// months: ordered [{ beginning?(first only), additions, totalIncome, managementFee,
//   incentiveFee, redemptions }]. Each month's ending becomes the next month's
// beginning. Returns computed { beginning, ending, ror } per month.
export function computeCapitalRoll(months) {
  let prevEnding = null;
  return months.map((m, i) => {
    const beginning = i === 0 ? n(m.beginning) : prevEnding;
    const netToInvestor = n(m.totalIncome) - n(m.managementFee) - n(m.incentiveFee);
    const ending = beginning + n(m.additions) + netToInvestor - n(m.redemptions);
    const base = beginning + n(m.additions); // allocation base incl. period-start contributions
    const ror = base === 0 ? 0 : netToInvestor / base;
    prevEnding = ending;
    return { beginning, ending, ror, netToInvestor };
  });
}

export { n as _num, round2 as _round2 };
