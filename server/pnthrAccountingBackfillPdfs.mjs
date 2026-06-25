// PNTHR Accounting — regenerate the two investor PDFs (Account Statement +
// Individual Account Statement) for every month that has a Fund Accounting workbook.
//
// Reproducible + self-healing: for each period it pulls the stored Fund Accounting
// workbook, parses its "Account Statement" tab (rebranding never changes the numbers),
// runs the engine, and RECONCILES the engine's computed totals against NAV's own stored
// totals to the penny BEFORE rendering. A month that does not reconcile is skipped, not
// stored. Go-forward (July+), inputs will come from IBKR Flex + the Fund Ledger instead
// of a NAV workbook, but this same close/render path produces the statements.
//
// Usage (from server/):  node pnthrAccountingBackfillPdfs.mjs [--store] [YYYY-MM ...]
//   --store      persist to MongoDB (else dry-run: write PDFs to /tmp/render for review)
//   YYYY-MM ...  limit to specific periods (default: every month with a workbook)

import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildAccountStatement } from './pnthrAccountingClose.js';
import { renderAccountStatement, renderIndividualAccountStatement } from './pnthrAccountingRenderPdf.js';
import { getDocument, saveDocument, listPeriods } from './pnthrAccountingService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARSER = path.resolve(__dirname, '../scripts/navAccountStatementParser.py');
const PANTHER = path.resolve(__dirname, '../client/src/assets/panther-head-sm.png');
const PDF = 'application/pdf';

// Constant investor/fund identity (single-LP fund — Investor 1001 owns 100%, so the
// individual statement is the QTD/YTD slice of the fund-level close).
const FUND = { name: 'PNTHR Funds, Carnivore Quant Fund, LP', address: ['15150 W PARK PLACE', 'SUITE 215', 'GOODYEAR, AZ 85395'] };
const INVESTOR = { no: 1001, name: 'CINDY EAGAR', address: ['12014 W LUXTON LN', 'AVONDALE, AZ 85323'], class: 'Filet Interests' };
const PRODUCER = { name: 'PNTHR Funds, LLC', role: 'General Partner & Administrator', website: 'www.pnthrfunds.com', copyright: '© PNTHR Funds, LLC', logoPath: PANTHER };
const GENON = `Report generated on: ${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })} (ET)`;

const STORE = process.argv.includes('--store');
const ONLY = process.argv.filter(a => /^\d{4}-\d{2}$/.test(a));

const moneyOK = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.01);
const rorOK = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.0001);
function reconcile(close, ns) {
  const fails = [];
  for (const k of ['totalIncome', 'totalExpenses', 'netIncome', 'ending']) {
    for (let i = 0; i < 4; i++) if (!moneyOK(close[k][i], ns[k]?.[i])) fails.push(`${k}[${i}] engine=${close[k][i]} nav=${ns[k]?.[i]}`);
  }
  for (let i = 0; i < 4; i++) if (!rorOK(close.ror[i], ns.ror?.[i])) fails.push(`ror[${i}] engine=${close.ror[i]} nav=${ns.ror?.[i]}`);
  return fails;
}

const { periods } = await listPeriods();
let targets = periods.filter(p => (p.documents || []).some(d => d.docType === 'fund_accounting_workbook'));
if (ONLY.length) targets = targets.filter(p => ONLY.includes(p.period));

let ok = 0; const bad = [];
for (const p of targets) {
  const wbDoc = p.documents.find(d => d.docType === 'fund_accounting_workbook');
  const full = await getDocument(wbDoc.id);
  const tmp = path.join(os.tmpdir(), `pnthr_acct_${p.period}.xlsx`);
  fs.writeFileSync(tmp, Buffer.from(full.data.buffer || full.data));
  const inp = JSON.parse(execFileSync('python3', [PARSER, tmp, p.period], { encoding: 'utf8' }));
  inp.signatory = inp.signatory?.length ? inp.signatory : ['For PNTHR Funds, LLC', 'General Partner of PNTHR Funds, Carnivore Quant Fund, LP'];
  inp.generatedOn = GENON;

  const { data, close } = buildAccountStatement(inp);
  const fails = reconcile(close, inp.navStored);
  if (fails.length) { console.log(`✗ ${p.period} RECONCILE FAILED:\n   ${fails.slice(0, 6).join('\n   ')}`); bad.push(p.period); continue; }

  const acctPdf = await renderAccountStatement(data);
  const q = 2, y = 3; // QTD, YTD slice -> individual statement
  const indPdf = await renderIndividualAccountStatement({
    fund: FUND, investor: INVESTOR, periodEnded: inp.header.periodEnded,
    capitalAccount: { rows: [
      { label: 'Beginning Balance', values: [inp.beginning[q], inp.beginning[y]] },
      { label: 'Additions', values: [inp.additions[q], inp.additions[y]] },
      { label: 'Redemptions', values: [inp.redemptions[q], inp.redemptions[y]] },
      { label: 'Net Income', values: [close.netIncome[q], close.netIncome[y]] },
      { label: 'Ending Balance', values: [close.ending[q], close.ending[y]], bold: true, shaded: true },
      { label: 'Rate of Return', values: [close.ror[q], close.ror[y]], isPercent: true },
    ] },
    producer: PRODUCER, logoPath: PANTHER,
  });

  if (STORE) {
    await saveDocument({ period: p.period, docType: 'account_statement', investorNo: null, label: 'Account Statement', filename: `PNTHR_Account_Statement_${p.period}.pdf`, contentType: PDF, data: acctPdf, status: 'finalized', generatedBy: 'pnthr-generated' });
    await saveDocument({ period: p.period, docType: 'individual_account_statement', investorNo: '1001', label: 'Individual Account Statement', filename: `PNTHR_Individual_Account_Statement_${p.period}.pdf`, contentType: PDF, data: indPdf, status: 'finalized', generatedBy: 'pnthr-generated' });
    console.log(`✓ ${p.period} reconciled + stored`);
  } else {
    fs.mkdirSync('/tmp/render', { recursive: true });
    fs.writeFileSync(`/tmp/render/${p.period}_account.pdf`, acctPdf);
    fs.writeFileSync(`/tmp/render/${p.period}_individual.pdf`, indPdf);
    console.log(`✓ ${p.period} reconciled (DRY)  end YTD=${close.ending[3].toFixed(2)} ror=${(close.ror[3] * 100).toFixed(2)}%`);
  }
  ok++;
}
console.log(`\nReconciled: ${ok}/${targets.length}. Failed: ${bad.length}${bad.length ? ' (' + bad.join(', ') + ')' : ''}`);
process.exit(bad.length ? 1 : 0);
