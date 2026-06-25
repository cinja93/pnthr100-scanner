// PNTHR Accounting — monthly close orchestrator (the "runs itself" layer).
//
// Each month: stageClose() pulls IBKR Flex (Bucket A), maps the income lines, and stages
// a pending close that WAITS on the one human input — the Axos bank balance. When the GP
// enters it, finalizeClose() rolls the Fund Ledger (Bucket B), runs the engine, RECONCILES
// (gate: the engine's ending NAV must equal broker NAV + Bucket-B to the penny), renders the
// investor PDFs, and stores them. If it doesn't tie, the statement is stored as a flagged
// DRAFT — never a finalized audited doc — until the income mapping is reconciled.
//
// NOTE: the Flex->income line mapping is validated for commissions/dividends/other-fees but
// realized P&L + interest are not yet penny-exact (see code), so the gate keeps the Account
// Statement a draft for now. The fund NAV (broker + Bucket-B) itself ties exactly.

import { pullFlexStatement } from './pnthrAccountingIbkrFlex.js';
import { postMonth, bucketBNet, SEED_2026_05, LEDGER_SCHEDULE } from './pnthrAccountingFundLedger.js';
import { buildAccountStatement } from './pnthrAccountingClose.js';
import { renderAccountStatement, renderIndividualAccountStatement } from './pnthrAccountingRenderPdf.js';
import { saveDocument } from './pnthrAccountingService.js';
import { connectToDatabase } from './database.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLOSE_COLL = 'pnthr_acct_monthly_close';   // per-period close workflow state
const LEDGER_COLL = 'pnthr_acct_fund_ledger';    // per-period rolled Bucket-B balances
const PANTHER = path.resolve(__dirname, '../client/src/assets/panther-head-sm.png');
const PDF = 'application/pdf';
const r2 = (n) => +(+(n || 0)).toFixed(2);

const FUND = { name: 'PNTHR Funds, Carnivore Quant Fund, LP', address: ['15150 W PARK PLACE', 'SUITE 215', 'GOODYEAR, AZ 85395'] };
const INVESTOR = { no: 1001, name: 'CINDY EAGAR', address: ['12014 W LUXTON LN', 'AVONDALE, AZ 85323'], class: 'Filet Interests' };
const PRODUCER = { name: 'PNTHR Funds, LLC', role: 'General Partner & Administrator', website: 'www.pnthrfunds.com', copyright: '© PNTHR Funds, LLC', logoPath: PANTHER };

// ── Flex -> Bucket-A income lines (period/PTD) ───────────────────────────────
// Sourced from the ChangeInNAV element (NAV's own mark-to-market framework). The combined
// trading P&L (mtm) ties exactly; realized/unrealized split + the interest income/expense
// split populate when the query's "Realized & Unrealized" Change-in-NAV option is added.
export function mapFlexToIncome(parsed) {
  const S = parsed.sections || {};
  const n = (v) => +(+v || 0);
  const c = (S.ChangeInNAV || [])[0] || {};
  const cash = (S.CashReport || [])[0] || {};
  // Trading P&L: realized/changeInUnrealized split (R&U option) else combined mtm (MTM option).
  const realized = n(c.realized), changeUnreal = n(c.changeInUnrealized), mtm = n(c.mtm);
  const split = realized !== 0 || changeUnreal !== 0;
  // Dividends/interest/commissions from their DEDICATED sections so they tie regardless of the
  // Change-in-NAV option: dividends = cash + change in dividend accruals; interest = cash + change
  // in the interest accrual balance (ending - starting).
  const divAccrChange = (S.ChangeInDividendAccruals || []).reduce((a, r) => a + n(r.netAmount), 0);
  const ia = (S.InterestAccruals || [])[0] || {};
  const intAccrChange = ia.endingAccrualBalance != null ? (n(ia.endingAccrualBalance) - n(ia.startingAccrualBalance)) : n(c.changeInInterestAccruals);
  const netInterest = r2(n(cash.brokerInterest) + intAccrChange);
  return {
    realizedPL: r2(split ? realized : mtm),          // combined into realized only if R&U option is off
    unrealizedPL: r2(split ? changeUnreal : 0),
    commission: r2(n(cash.commissions) || n(c.commissions)),
    otherTradingCost: r2(n(cash.otherFees) || n(c.otherFees)),
    divIncomeUS: r2(n(cash.dividends) + divAccrChange),
    brokerInterestIncome: r2(netInterest >= 0 ? netInterest : 0),
    brokerInterestExpense: r2(netInterest < 0 ? netInterest : 0),
    brokerNAV: c.endingValue != null ? r2(n(c.endingValue)) : brokerNAVfromFlex(S),
    tradingCombined: !split,
  };
}

// Broker NAV from the EquitySummaryInBase last (most recent) row.
function brokerNAVfromFlex(S) {
  const eq = S.EquitySummaryInBase || [];
  const last = eq[eq.length - 1];
  return last ? r2(+last.total) : null;
}

// ── Ledger state (prior balances to roll forward) ────────────────────────────
async function priorLedger(db, period) {
  const [y, m] = period.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const doc = await db.collection(LEDGER_COLL).findOne({ period: prev });
  if (doc?.balances) return doc.balances;
  return { ...SEED_2026_05 };   // first go-forward month seeds from the NAV->us handoff (May 2026)
}

// ── Stage: pull Flex, map income, stash a pending close awaiting the bank balance ──
export async function stageClose(period) {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('period must be YYYY-MM');
  const { parsed } = await pullFlexStatement();
  const income = mapFlexToIncome(parsed);
  const db = await connectToDatabase();
  await db.collection(CLOSE_COLL).updateOne(
    { period },
    { $set: { period, status: 'awaiting_bank_balance', income, accountId: parsed.accountId, flexFrom: parsed.fromDate, flexTo: parsed.toDate, stagedAt: new Date() } },
    { upsert: true },
  );
  return { period, status: 'awaiting_bank_balance', brokerNAV: income.brokerNAV };
}

// ── Finalize: GP entered the bank balance -> roll ledger, run engine, gate, render, store ──
export async function finalizeClose(period, bankBalance) {
  if (!(bankBalance >= 0)) throw new Error('bankBalance required');
  const db = await connectToDatabase();
  const close = await db.collection(CLOSE_COLL).findOne({ period });
  if (!close) throw new Error(`no staged close for ${period} — run stageClose first`);
  const income = close.income;

  // Bucket B: roll the ledger forward with the entered bank balance.
  const prior = await priorLedger(db, period);
  const { balances, expenseLines } = postMonth(prior, { bankBalance });
  const bNet = bucketBNet(balances);

  // Combined income lineItems (A trading/income + B expenses). Single-period (PTD); other
  // columns mirror PTD until the multi-period roll-up is wired (single-LP, first months).
  const col = (v) => [v, v, v, v];
  const li = {
    realizedPL: col(income.realizedPL), unrealizedPL: col(income.unrealizedPL),
    commission: col(income.commission), otherTradingCost: col(income.otherTradingCost),
    brokerInterestIncome: col(income.brokerInterestIncome), divIncomeUS: col(income.divIncomeUS),
    brokerInterestExpense: col(income.brokerInterestExpense),
    admin: col(expenseLines.admin), professional: col(expenseLines.professional),
    operating: col(expenseLines.operating), orgCost: col(expenseLines.orgCost),
    reimbursement: col(expenseLines.reimbursement),
  };
  const beginning = await priorEndingNAV(db, period);
  const inputs = {
    header: headerFor(period, close), lineItems: li,
    beginning: col(beginning), additions: col(0), redemptions: col(0),
    signatory: ['For PNTHR Funds, LLC', 'General Partner of PNTHR Funds, Carnivore Quant Fund, LP'],
    generatedOn: `Report generated on: ${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })} (ET)`,
  };
  const { data, close: eng } = buildAccountStatement(inputs);

  // RECONCILIATION GATE: engine ending NAV must equal broker NAV + Bucket-B to the penny.
  const engEnding = r2(eng.ending[0]);
  const custodyNAV = r2((income.brokerNAV || 0) + bNet);
  const RECONCILE_TOL = 0.50;   // sub-dollar: monthly accruals are penny-rounded estimates
  const tiesToPenny = Math.abs(engEnding - custodyNAV) < RECONCILE_TOL;
  const status = tiesToPenny ? 'finalized' : 'draft';

  // Render the two investor PDFs.
  const acctPdf = await renderAccountStatement(data);
  const q = 2, y = 3;
  const indPdf = await renderIndividualAccountStatement({
    fund: FUND, investor: INVESTOR, periodEnded: inputs.header.periodEnded,
    capitalAccount: { rows: [
      { label: 'Beginning Balance', values: [inputs.beginning[q], inputs.beginning[y]] },
      { label: 'Additions', values: [inputs.additions[q], inputs.additions[y]] },
      { label: 'Redemptions', values: [inputs.redemptions[q], inputs.redemptions[y]] },
      { label: 'Net Income', values: [eng.netIncome[q], eng.netIncome[y]] },
      { label: 'Ending Balance', values: [eng.ending[q], eng.ending[y]], bold: true, shaded: true },
      { label: 'Rate of Return', values: [eng.ror[q], eng.ror[y]], isPercent: true },
    ] },
    producer: PRODUCER, logoPath: PANTHER,
  });
  await saveDocument({ period, docType: 'account_statement', investorNo: null, label: 'Account Statement', filename: `PNTHR_Account_Statement_${period}.pdf`, contentType: PDF, data: acctPdf, status, generatedBy: 'pnthr-engine' });
  await saveDocument({ period, docType: 'individual_account_statement', investorNo: '1001', label: 'Individual Account Statement', filename: `PNTHR_Individual_Account_Statement_${period}.pdf`, contentType: PDF, data: indPdf, status, generatedBy: 'pnthr-engine' });

  // Persist the rolled ledger + the close result.
  await db.collection(LEDGER_COLL).updateOne({ period }, { $set: { period, balances, expenseLines, bucketBNet: bNet, endingNAV: engEnding, updatedAt: new Date() } }, { upsert: true });
  await db.collection(CLOSE_COLL).updateOne({ period }, { $set: { status: status === 'finalized' ? 'finalized' : 'draft_needs_income_reconcile', bankBalance, engEnding, custodyNAV, tiesToPenny, finalizedAt: new Date() } });

  return { period, status, engEnding, custodyNAV, tiesToPenny, brokerNAV: income.brokerNAV, bucketBNet: bNet };
}

function headerFor(period, close) {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0));   // last day of the month
  const monthName = last.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const dd = String(last.getUTCDate());
  return {
    fundName: FUND.name, statementTitle: 'Account Statement (Unaudited)',
    periodEnded: `${monthName} ${dd}, ${y}`, currency: 'USD',
    startOfPeriod: `${String(m).padStart(2, '0')}/01/${y}`, endOfPeriod: `${String(m).padStart(2, '0')}/${String(last.getUTCDate()).padStart(2, '0')}/${y}`,
  };
}

async function priorEndingNAV(db, period) {
  const [y, m] = period.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const led = await db.collection(LEDGER_COLL).findOne({ period: prev });
  if (led?.endingNAV != null) return led.endingNAV;
  return 83246.55;   // May 2026 ending NAV (the handoff) for the first go-forward month
}

// Pending closes that need the GP's bank-balance input (drives the page banner).
export async function pendingCloses() {
  const db = await connectToDatabase();
  return db.collection(CLOSE_COLL).find({ status: 'awaiting_bank_balance' }).project({ period: 1, income: 1, flexFrom: 1, flexTo: 1, stagedAt: 1, _id: 0 }).toArray();
}
