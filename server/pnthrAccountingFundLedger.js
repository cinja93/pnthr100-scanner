// PNTHR Accounting — Bucket B: the Fund Ledger.
//
// The fund-level accrual layer NAV Consulting added on top of the broker/custodian balance.
// Fund NAV = broker NAV (IBKR Flex, Bucket A) + Bucket-B net. It seeds from a known balance
// sheet (the NAV->us handoff at May 2026) and rolls FORWARD each month by posting the recurring
// accruals + monthly inputs (the bank balance), so we self-produce what NAV used to.
//
// Bucket-B accounts (everything in NAV's balance sheet that is NOT at the broker — the broker
// cash/stock/interest/dividend accruals all come from Flex):
//   assets:       bank, orgPrepaid, dueFromAffiliates
//   liabilities:  adminPayable, professionalPayable, operatingPayable
//   Bucket-B net = (assets) - (liabilities)
//
// Schedule derived from NAV's own roll-forward (verified Apr->May to the penny) + Scott's
// go-forward decisions (2026-06-25): admin -> $0 (self-administered), GP reimbursement fixed
// $4,160/mo, fees waived (official) with a pro-forma 2%/tiered track (see computeFees).

const r2 = (n) => +(+n).toFixed(2);

// Go-forward monthly accrual schedule.
export const LEDGER_SCHEDULE = {
  adminAccrual: 0,             // was $516.67 (NAV admin $350 + FS-prep $166.67) — now self-administered
  professionalAccrual: 1770.84, // audit $1,250 + tax $520.84 (continues: Spicer Jeffries + tax prep)
  operatingAccrual: 1325.78,   // compliance $659.11 + insurance $666.67 (accrued to the operating payable)
  orgAmortization: 546.72,     // organization-cost prepaid amortized monthly
  gpReimbursement: 4160,       // GP covers $4,160/mo of expenses -> accrues to Due from Affiliates
  bankCharges: 0,              // actual bank fees paid from the bank account this month (input; ~$46.82 historically)
};

// The NAV->us handoff: Bucket-B balances at 2026-05-31 (NAV's last produced balance sheet).
export const SEED_2026_05 = {
  bank: 2996.93, orgPrepaid: 26088.40, dueFromAffiliates: 16281.46,
  adminPayable: 3533.33, professionalPayable: 23020.84, operatingPayable: 19242.65,
};

// Net Bucket-B layer (assets - liabilities) to add to the broker NAV.
export function bucketBNet(b) {
  return r2((b.bank + b.orgPrepaid + b.dueFromAffiliates) - (b.adminPayable + b.professionalPayable + b.operatingPayable));
}

// Roll one month forward. `bankBalance` (this month-end, from Scott) is authoritative when given;
// otherwise it's derived from prior bank less the scheduled bank charges. Returns the new balances,
// the income-statement expense lines this layer contributes (negatives = expense), and Bucket-B net.
export function postMonth(prior, { bankBalance = null, schedule = LEDGER_SCHEDULE } = {}) {
  const s = schedule;
  const balances = {
    bank: r2(bankBalance != null ? bankBalance : prior.bank - s.bankCharges),
    orgPrepaid: r2(prior.orgPrepaid - s.orgAmortization),
    dueFromAffiliates: r2(prior.dueFromAffiliates + s.gpReimbursement),
    adminPayable: r2(prior.adminPayable + s.adminAccrual),
    professionalPayable: r2(prior.professionalPayable + s.professionalAccrual),
    operatingPayable: r2(prior.operatingPayable + s.operatingAccrual),
  };
  // Income-statement contribution (the Account Statement "Expenses" + reimbursement lines).
  const expenseLines = {
    admin: r2(-s.adminAccrual),
    professional: r2(-s.professionalAccrual),
    operating: r2(-(s.operatingAccrual + s.bankCharges)),   // compliance + insurance + bank charges
    orgCost: r2(-s.orgAmortization),
    reimbursement: r2(s.gpReimbursement),                   // positive: GP reimbursement reduces net expense
  };
  return { balances, expenseLines, bucketBNet: bucketBNet(balances) };
}

// ── Dual fee tracks ──────────────────────────────────────────────────────────
// Official statements = fees WAIVED (the audited reality). Pro-forma = illustrative
// (NOT the official books): 2%/yr management + tiered performance allocation over the
// US-2yr hurdle + high-water mark. Per the PPM (v1.0, 2026-06-01, p.11).
export const PERF_RATE = { Wagyu: 0.20, Porterhouse: 0.25, Filet: 0.30 };          // < 36 months continuous
export const PERF_RATE_36MO = { Wagyu: 0.15, Porterhouse: 0.20, Filet: 0.25 };     // >= 36 months continuous
export const MGMT_RATE_ANNUAL = 0.02;

// inc = result of pnthrAccountingEngine.computeIncentiveFee (HWM + loss-recovery, quarterly).
export function computeFees({ nav, classTier = 'Filet', monthsInvested = 0, incentive = null }) {
  const official = { managementFee: 0, performanceAllocation: 0, note: 'waived' };
  const rate = (monthsInvested >= 36 ? PERF_RATE_36MO : PERF_RATE)[classTier] ?? PERF_RATE.Filet;
  const proForma = {
    managementFee: r2(nav * MGMT_RATE_ANNUAL / 12),               // 2%/yr accrued monthly
    performanceAllocationRate: rate,
    performanceAllocation: incentive ? r2(incentive.fee || 0) : 0, // $0 while underwater (HWM)
    note: 'illustrative — not the official books',
  };
  return { official, proForma };
}
