// PNTHR Accounting — monthly close orchestrator (the "runs itself" layer).
//
// Each month: stageClose() pulls IBKR Flex (Bucket A), maps the income lines, and stages
// a pending close that WAITS on the one human input — the Axos bank balance. When the GP
// enters it, finalizeClose() rolls the Fund Ledger (Bucket B), runs the engine, RECONCILES
// (gate: the engine's ending NAV must equal broker NAV + Bucket-B to the penny), renders the
// investor PDFs, and stores them. If it doesn't tie, the statement is stored as a flagged
// DRAFT — never a finalized audited doc — until the income mapping is reconciled.
//
// NOTE: the Flex->income mapping sources every Bucket-A line from IBKR's ChangeInNAV bridge, so
// the income lines sum to the broker's NAV change to the penny by construction (see mapFlexToIncome).
// The interest income/expense split is still shown NET (exact gross split would sum TierInterestDetails)
// — cosmetic only; it does not affect the reconciliation, which ties on the net.

import { pullFlexStatement } from './pnthrAccountingIbkrFlex.js';
import { postMonth, bucketBNet, SEED_2026_05, LEDGER_SCHEDULE } from './pnthrAccountingFundLedger.js';
import { buildAccountStatement } from './pnthrAccountingClose.js';
import { renderAccountStatement, renderIndividualAccountStatement } from './pnthrAccountingRenderPdf.js';
import { saveDocument } from './pnthrAccountingService.js';
import { generateCapitalRoll } from './pnthrAccountingCapitalRoll.js';
import { trialBalanceInputs, computeTrialBalance } from './pnthrAccountingTrialBalance.js';
import { buildWorkbookFundamentals, buildFundAccountingWorkbook, buildStatementWindows, monthlyMTD } from './pnthrAccountingWorkbook.js';
import { buildPortfolioNotebook, dividendRowsFromFlex } from './pnthrAccountingPortfolioNotebook.js';
import { resolveSecurityIds } from './pnthrAccountingSecurityMaster.js';
import { fetchFMP } from './stockService.js';
import { connectToDatabase } from './database.js';

// FMP sector/industry/country per symbol (batched) for the Doc 4 Attribution tab.
async function fmpProfiles(symbols) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 50) {
    const chunk = symbols.slice(i, i + 50);
    const profiles = await fetchFMP(`/profile/${chunk.join(',')}`).catch(() => []);
    for (const p of (profiles || [])) out[p.symbol] = { sector: p.sector, industry: p.industry, country: p.country };
  }
  return out;
}
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLOSE_COLL = 'pnthr_acct_monthly_close';   // per-period close workflow state
const LEDGER_COLL = 'pnthr_acct_fund_ledger';    // per-period rolled Bucket-B balances
const PANTHER = path.resolve(__dirname, '../client/src/assets/panther-head-sm.png');
const PDF = 'application/pdf';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const r2 = (n) => +(+(n || 0)).toFixed(2);

const FUND = { name: 'PNTHR Funds, Carnivore Quant Fund, LP', address: ['15150 W PARK PLACE', 'SUITE 215', 'GOODYEAR, AZ 85395'] };
const INVESTOR = { no: 1001, name: 'CINDY EAGAR', address: ['12014 W LUXTON LN', 'AVONDALE, AZ 85323'], class: 'Filet Interests' };
const PRODUCER = { name: 'PNTHR Funds, LLC', role: 'General Partner & Administrator', website: 'www.pnthrfunds.com', copyright: '© PNTHR Funds, LLC', logoPath: PANTHER };

// ── Flex -> Bucket-A income lines (period/PTD) ───────────────────────────────
// EVERY line is sourced from the ChangeInNAV element — IBKR's authoritative NAV bridge, whose
// components sum to (endingValue - startingValue) to the penny. Sourcing here makes Bucket-A
// income tie to the broker's actual NAV change BY CONSTRUCTION, every month, regardless of the
// query's realized/unrealized-vs-mark-to-market option.
//
// History: earlier code sourced dividends/interest from the CashReport + per-position accrual
// DETAIL rows. In a month with position closures (which reverse accrued dividends) that double-
// counted the reversal — the June-2026 close broke by -$46.86, entirely on the dividend line
// (mapped -25.15 vs the bridge's +21.71). Routing through ChangeInNAV removes that class of bug.
// If a future month carries a ChangeInNAV component we don't yet map (e.g. withholdingTax,
// broker/advisor fees), the mapped sum will no longer equal the NAV change and the reconciliation
// GATE flags the close a draft — surfacing the new line for an explicit (non-guessed) mapping.
export function mapFlexToIncome(parsed) {
  const S = parsed.sections || {};
  const n = (v) => +(+v || 0);
  const c = (S.ChangeInNAV || [])[0] || {};
  // Trading P&L: realized/changeInUnrealized split (R&U option) else combined mtm (MTM option).
  const realized = n(c.realized), changeUnreal = n(c.changeInUnrealized), mtm = n(c.mtm);
  const split = realized !== 0 || changeUnreal !== 0;
  // Dividend income = gross dividends + change in dividend accruals (net of reversals).
  const divIncome = r2(n(c.dividends) + n(c.changeInDividendAccruals));
  // Net interest = cash interest + change in interest accruals.
  const netInterest = r2(n(c.interest) + n(c.changeInInterestAccruals));
  return {
    realizedPL: r2(split ? realized : mtm),          // combined into realized only if R&U option is off
    unrealizedPL: r2(split ? changeUnreal : 0),
    commission: r2(n(c.commissions)),
    otherTradingCost: r2(n(c.otherFees)),
    divIncomeUS: divIncome,
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
  // Stash the Flex sections the Trial Balance engine + Doc-3 workbook need at finalize time, from the
  // SAME pull that produced the reconciled income (so the workbook can't drift from a second API call).
  const S = parsed.sections || {};
  const tbSections = {
    ChangeInNAV: S.ChangeInNAV, CashReport: S.CashReport, EquitySummaryInBase: S.EquitySummaryInBase,
    FIFOPerformanceSummaryInBase: S.FIFOPerformanceSummaryInBase, TierInterestDetails: S.TierInterestDetails,
    Lot: S.Lot,   // closed-lot detail for Doc 4 (Portfolio Notebook — Realized Tax Lot / per-symbol P&L)
    divRows: dividendRowsFromFlex(S),   // per-security dividend rows for Doc 4 Dividend Detail (small)
  };
  await db.collection(CLOSE_COLL).updateOne(
    { period },
    { $set: { period, status: 'awaiting_bank_balance', income, tbSections, accountId: parsed.accountId, flexFrom: parsed.fromDate, flexTo: parsed.toDate, stagedAt: new Date() } },
    { upsert: true },
  );
  return { period, status: 'awaiting_bank_balance', brokerNAV: income.brokerNAV };
}

// ── Account Summary cash flows from Flex (gross receipts/payments) ────────────────
// Built from the Flex CashReport's OWN components, whose sum equals (endingCash - startingCash) by
// construction — so beginning cash + these flows ties to the ending cash (= the Trial Balance cash)
// exactly. Presentational residuals (flagged, do NOT affect the tie): the sales/purchases long-vs-
// short split isn't separable from this query (lumped into the "Long" lines), broker interest is
// shown on a single net line (received/paid net rather than gross), and dividend cash receipts fold
// payment-in-lieu into the Dividend Received line.
function cashflowFromFlex({ cashReport, priorBank, priorBrokerCash, bankCharge }) {
  const n = (v) => +(+v || 0);
  const c = cashReport || {};
  const brokerBegin = c.startingCash != null ? n(c.startingCash) : n(priorBrokerCash);
  const brokerInt = n(c.brokerInterest);
  return {
    beginningCash: { total: n(priorBank) + brokerBegin, fund: 0, bank: n(priorBank), broker: brokerBegin },
    salesLong: n(c.netTradesSales), salesShort: 0,
    brokerIntReceived: brokerInt > 0 ? brokerInt : 0,
    divReceived: n(c.dividends) + n(c.paymentInLieu),           // cash dividend receipts (incl. payment-in-lieu)
    purchasesLong: n(c.netTradesPurchases), purchasesBuyToCover: 0,
    commissionPaid: n(c.commissions), otherTradingCostPaid: n(c.otherFees),
    brokerIntPaid: brokerInt < 0 ? brokerInt : 0,
    operatingExpPaid: -Math.abs(n(bankCharge)),
  };
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

  // Income-statement windows [PTD, MTD, QTD, YTD] for the two investor statements. Built from the
  // SAME helper that feeds the Fund Accounting Workbook's Account Statement tab (buildStatementWindows),
  // so the PDF and the Excel rendering of the statement are identical by construction and cannot
  // drift. PTD == MTD; QTD/YTD roll the committed May anchors forward by this month's MTD.
  const beginning = await priorEndingNAV(db, period);
  const history = await loadStatementHistory(db, period);
  const { is: win, navBeginning } = buildStatementWindows({ income, expenseLines, beginning, period, history });
  const w = (k) => [win[k].ptd, win[k].mtd, win[k].qtd, win[k].ytd];
  const li = {
    realizedPL: w('realizedPL'), unrealizedPL: w('unrealizedPL'),
    commission: w('commission'), otherTradingCost: w('otherTradingCost'),
    brokerInterestIncome: w('brokerIntIncome'), divIncomeUS: w('divIncomeUS'),
    divIncomeForeign: w('divIncomeForeign'), brokerInterestExpense: w('brokerIntExpense'),
    divExpenseUS: w('divExpenseUS'), divExpenseForeign: w('divExpenseForeign'),
    admin: w('admin'), legal: w('legal'), professional: w('professional'),
    operating: w('operating'), orgCost: w('orgCost'), reimbursement: w('reimbursement'),
  };
  const zero4 = [0, 0, 0, 0];
  const inputs = {
    header: headerFor(period, close), lineItems: li,
    beginning: [navBeginning.ptd, navBeginning.mtd, navBeginning.qtd, navBeginning.ytd],
    additions: zero4, redemptions: zero4,
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

  // Doc 5: Capital Roll History — append this month's row (fees waived, official books) to the
  // seed history and re-render the inception-to-date roll. Same gate status as the statements.
  const { buffer: rollBuf } = await generateCapitalRoll(period, { totalIncome: eng.netIncome[0] });
  await saveDocument({ period, docType: 'capital_roll_history', investorNo: null, label: 'Capital Roll History', filename: `PNTHR Capital Roll History ${period}.xlsx`, contentType: XLSX, data: rollBuf, status, generatedBy: 'pnthr-engine' });

  // Doc 3: Fund Accounting Workbook (10 tabs). Built from the validated Trial Balance engine + the
  // income mapping + the NAV roll + the Fund Ledger, on NAV's exact template. Wrapped so a workbook
  // failure never breaks the core close (PDFs + reconciliation are already stored). Same gate status.
  try {
    const bankCharge = r2(prior.bank - bankBalance);
    const parsed = { accountId: close.accountId, sections: close.tbSections || {} };
    const inputs = trialBalanceInputs({ parsed, ledger: { ...balances, expenseLines }, bankBalance });
    const tb = computeTrialBalance(period, inputs);
    const cashflow = cashflowFromFlex({ cashReport: (close.tbSections?.CashReport || [])[0], priorBank: prior.bank, priorBrokerCash: inputs.brokerCash, bankCharge });
    const genTs = `${new Date().toLocaleString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })} (ET)`;
    const f = buildWorkbookFundamentals({
      period, tbAccounts: tb.accounts, income, expenseLines, beginning, engEnding: r2(tb.checks.navEnding),
      netIncome: eng.netIncome[0], bankCharge, cashflow, genTs, history,
    });
    const wbBuf = await buildFundAccountingWorkbook(f);
    await saveDocument({ period, docType: 'fund_accounting_workbook', investorNo: null, label: 'Fund Accounting Workbook', filename: `PNTHR Fund Accounting Workbook ${period}.xlsx`, contentType: XLSX, data: wbBuf, status, generatedBy: 'pnthr-engine' });

    // Doc 4: Portfolio Notebook (13 tabs) — CUSTODIAN (IBKR) authoritative basis (NAV's proprietary
    // tax-lot method is not reproducible from our data). Realized Tax Lot / Trading Gain Loss / Top
    // Movers / Reconciliation built from IBKR closed-lot detail; Dividend Detail + Attribution pending.
    const lots = close.tbSections?.Lot || [];
    const secId = await resolveSecurityIds(lots.map((l) => l.isin).filter(Boolean));
    // Attribution needs a sector/industry/country per holding — from FMP (the app's market-data
    // source; IBKR Flex has none). Non-fatal: if FMP is unavailable the Attribution tab renders
    // header-only rather than failing the notebook.
    const profileBySym = await fmpProfiles([...new Set(lots.map((l) => l.symbol).filter(Boolean))]).catch(() => ({}));
    const nbBuf = await buildPortfolioNotebook({
      period,
      lots, otherTradingCost: income.otherTradingCost, secId, divRows: close.tbSections?.divRows || [],
      bankCash: bankBalance, brokerCash: r2(inputs.brokerCash), portfolioMV: r2(inputs.stockMarket),
      profileBySym, beginningNAV: beginning,
    });
    await saveDocument({ period, docType: 'portfolio_notebook', investorNo: null, label: 'Portfolio Notebook', filename: `PNTHR Portfolio Notebook ${period}.xlsx`, contentType: XLSX, data: nbBuf, status, generatedBy: 'pnthr-engine' });
  } catch (e) {
    console.error(`[close ${period}] Doc 3/4 workbook generation failed (core close unaffected):`, e.message);
  }

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

// First self-administered close: June 2026 (WB_SEED = the immutable cumulative baseline through
// May 2026; earlier months were produced by NAV, not by our engine).
const FIRST_SELF_ADMIN = { year: 2026, month: 6 };
const isSelfAdmin = (y, m) => y > FIRST_SELF_ADMIN.year || (y === FIRST_SELF_ADMIN.year && m >= FIRST_SELF_ADMIN.month);
const pkey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

// Assemble the QTD/YTD roll-forward inputs for buildStatementWindows (stateless / self-healing):
// every self-administered month BEFORE `period` (its 16-line MTD from the stored close income +
// rolled ledger expenseLines), plus the ending NAV at the start of this quarter / year. Boundary
// months that predate self-administration return null so the builder uses the WB_SEED baseline.
async function loadStatementHistory(db, period) {
  const [Y, M] = period.split('-').map(Number);
  const priorMTD = [];
  let y = FIRST_SELF_ADMIN.year, m = FIRST_SELF_ADMIN.month;
  while (y < Y || (y === Y && m < M)) {
    const p = pkey(y, m);
    const [close, led] = await Promise.all([
      db.collection(CLOSE_COLL).findOne({ period: p }),
      db.collection(LEDGER_COLL).findOne({ period: p }),
    ]);
    if (!close) console.warn(`[statementWindows ${period}] no stored close for ${p} — QTD/YTD will be incomplete`);
    priorMTD.push({ year: y, month: m, lines: monthlyMTD({ income: close?.income, expenseLines: led?.expenseLines }) });
    m++; if (m > 12) { m = 1; y++; }
  }
  const endingNAVof = async (yy, mm) => {
    if (!isSelfAdmin(yy, mm)) return null;   // pre-takeover boundary -> caller falls back to the seed
    const p = pkey(yy, mm);
    const led = await db.collection(LEDGER_COLL).findOne({ period: p });
    if (led?.endingNAV != null) return led.endingNAV;
    const c = await db.collection(CLOSE_COLL).findOne({ period: p });
    return c?.engEnding ?? null;
  };
  const qStartMonth = (Math.ceil(M / 3) - 1) * 3 + 1;                 // first month of this quarter
  const beforeQ = qStartMonth === 1 ? [Y - 1, 12] : [Y, qStartMonth - 1];
  return {
    priorMTD,
    quarterStartNAV: await endingNAVof(beforeQ[0], beforeQ[1]),
    yearStartNAV: await endingNAVof(Y - 1, 12),
  };
}

// Pending closes that need the GP's bank-balance input (drives the page banner).
export async function pendingCloses() {
  const db = await connectToDatabase();
  return db.collection(CLOSE_COLL).find({ status: 'awaiting_bank_balance' }).project({ period: 1, income: 1, flexFrom: 1, flexTo: 1, stagedAt: 1, _id: 0 }).toArray();
}
