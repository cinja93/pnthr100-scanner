// PNTHR Accounting — year-end deliverable packages (auditor + tax).
//
// buildAuditPackageZip(year)  -> one zip the GP hands the independent auditor (Spicer
//   Jeffries): all 12 monthly statements + working papers, the fund-level reference docs,
//   and the IBKR Flex custodian source files, plus a MANIFEST. One-button download.
//
// These bundle what the engine already produced/stored — they don't recompute anything,
// so the package always matches the finalized monthly documents.

import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { connectToDatabase } from './database.js';
import { listPeriods, getDocument, listReferenceDocuments } from './pnthrAccountingService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const buf = (doc) => Buffer.from(doc.data?.buffer || doc.data);

export async function buildAuditPackageZip(year) {
  const zip = new JSZip();
  const { periods } = await listPeriods();
  const months = (periods || []).filter(p => p.year === year && (p.documents || []).length).sort((a, b) => a.month - b.month);

  const manifest = [
    'PNTHR Funds, LLC — PNTHR Carnivore Quant Fund, LP',
    `AUDIT PACKAGE — Fiscal Year ${year}`,
    `Prepared by PNTHR Funds, LLC (General Partner) on ${new Date().toISOString().slice(0, 10)}`,
    '',
    'This package contains the fund-accounting records for the period, produced by the',
    'General Partner from Interactive Brokers custodian data and the Fund Ledger.',
    '',
    'CONTENTS',
    '========',
  ];

  let fileCount = 0;
  for (const p of months) {
    manifest.push('', `${p.period} (${p.label})  —  reconciliation: ${p.reconciliation?.status || 'n/a'}`);
    for (const d of (p.documents || []).sort((a, b) => a.docType.localeCompare(b.docType))) {
      const full = await getDocument(d.id); if (!full) continue;
      const b = buf(full);
      zip.file(`${p.period}/${d.filename}`, b);
      manifest.push(`   ${d.filename}  (${(b.length / 1024).toFixed(0)} KB)`);
      fileCount++;
    }
  }

  // Fund-level reference documents (disclosure statement, statements guide).
  const ref = await listReferenceDocuments().catch(() => ({ documents: [] }));
  if ((ref.documents || []).length) {
    manifest.push('', '_reference/ (fund-level)');
    for (const d of ref.documents) {
      const full = await getDocument(d.id); if (!full) continue;
      const b = buf(full); zip.file(`_reference/${d.filename}`, b);
      manifest.push(`   ${d.filename}  (${(b.length / 1024).toFixed(0)} KB)`); fileCount++;
    }
  }

  // IBKR Flex custodian source statements (the raw broker truth behind Bucket A).
  try {
    const db = await connectToDatabase();
    const raws = await db.collection('pnthr_acct_ibkr_raw').find({ period: { $regex: `^${year}-` } }).sort({ period: 1 }).toArray();
    if (raws.length) {
      manifest.push('', '_ibkr_flex/ (custodian source — Interactive Brokers Flex statements)');
      for (const r of raws) {
        if (!r.xml) continue;
        zip.file(`_ibkr_flex/${r.period}.xml`, r.xml);
        manifest.push(`   ${r.period}.xml  (acct ${r.accountId || '—'})`); fileCount++;
      }
    }
  } catch { /* raw collection optional */ }

  manifest.push('', `TOTAL FILES: ${fileCount}`);
  zip.file('MANIFEST.txt', manifest.join('\n'));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// ── K-1 tax-data package (per investor) ──────────────────────────────────────
// Compiles the year's partnership tax data a CPA needs to prepare Form 1065 +
// Schedule K-1: income by character, deductions, and the partner's capital account.
// NOT a filed K-1 — it's the data package that hands to the tax preparer. Sourced
// from the year-end (December) Account Statement YTD column (taxable items only —
// realized gains + income, NOT the unrealized/book mark).

const LOGO_BLACK = path.resolve(__dirname, '../client/public/pnthr-logo-black-bg.png');
// Per-investor identity (single-LP fund today; extend as LPs are admitted).
const INVESTORS = {
  '1001': { name: 'CINDY EAGAR', taxId: '___-__-____', address: ['12014 W LUXTON LN', 'AVONDALE, AZ 85323'], class: 'Filet Interests', ownership: 1.0 },
};
const PARSER = path.resolve(__dirname, '../scripts/navAccountStatementParser.py');
const Y = 3;   // index of the Year-to-Date column in the parser's [PTD,MTD,QTD,YTD] arrays

export async function buildK1DataPackage(year, investorNo) {
  const inv = INVESTORS[String(investorNo)] || { name: `INVESTOR ${investorNo}`, taxId: '___-__-____', address: [], class: '', ownership: 1.0 };
  // year-end (December) Fund Accounting workbook = the full-year YTD source
  const { periods } = await listPeriods();
  const dec = (periods || []).find(p => p.period === `${year}-12`);
  const wbDoc = dec?.documents?.find(d => d.docType === 'fund_accounting_workbook');
  if (!wbDoc) throw new Error(`No year-end (December) workbook stored for ${year} — a K-1 package needs a completed fiscal year.`);
  const full = await getDocument(wbDoc.id);
  // Parse the Account Statement tab via openpyxl (ExcelJS trips on the embedded logo). Same
  // parser the PDF backfill uses; reads the rebranded workbook's cached YTD values reliably.
  const tmp = path.join(os.tmpdir(), `pnthr_k1_${year}.xlsx`);
  fs.writeFileSync(tmp, buf(full));
  const parsed = JSON.parse(execFileSync('python3', [PARSER, tmp, `${year}-12`], { encoding: 'utf8' }));
  const li = parsed.lineItems, ns = parsed.navStored || {};
  const yv = (a) => (Array.isArray(a) ? (a[Y] || 0) : 0);
  const income = {
    realizedShortTerm: yv(li.realizedPL), interest: yv(li.brokerInterestIncome),
    dividendsUS: yv(li.divIncomeUS), dividendsForeign: yv(li.divIncomeForeign),
    admin: yv(li.admin), legal: yv(li.legal), professional: yv(li.professional),
    operating: yv(li.operating), orgCost: yv(li.orgCost), reimbursement: yv(li.reimbursement),
  };
  const capital = {
    beginning: yv(parsed.beginning), additions: yv(parsed.additions), redemptions: yv(parsed.redemptions),
    netIncome: yv(ns.netIncome), ending: yv(ns.ending),
  };

  const o = inv.ownership;
  const sh = (v) => +(((v || 0) * o)).toFixed(2);   // this partner's share
  return renderK1Pdf({ year, inv, income, capital, sh });
}

function renderK1Pdf({ year, inv, income, capital, sh }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'letter', margin: 0, bufferPages: true, info: { Title: `K-1 Data Package ${year}`, Author: 'PNTHR Funds, LLC' } });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const PW = 612, ML = 40, CR = PW - 40, YELLOW = '#FCF000', INK = '#222';
    const $ = (v) => (v < 0 ? '(' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (v < 0 ? ')' : '');
    doc.rect(0, 0, PW, 792).fill('#fff');
    // header band
    doc.rect(14, 12, PW - 28, 70).fill('#000'); doc.lineWidth(1.5).strokeColor(YELLOW).rect(14, 12, PW - 28, 70).stroke();
    if (fs.existsSync(LOGO_BLACK)) { try { doc.image(LOGO_BLACK, 26, 24, { height: 24 }); } catch { /* */ } }
    doc.fillColor(YELLOW).font('Helvetica-Bold').fontSize(14).text('PNTHR Funds, Carnivore Quant Fund, LP', 110, 22);
    doc.font('Helvetica').fontSize(9.5).text(`Schedule K-1 Data Package — Tax Year ${year}`, 110, 42);
    doc.fontSize(8).fillColor('#ddd').text('FOR THE TAX PREPARER — this is a data package, NOT a filed Schedule K-1.', 110, 58);
    let y = 100;
    const line = (l, v, opt = {}) => { doc.fillColor(opt.bold ? '#000' : INK).font(opt.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opt.bold ? 10 : 9.5).text(l, ML + (opt.indent || 0), y); if (v != null) doc.text(typeof v === 'number' ? $(v) : v, CR - 160, y, { width: 160, align: 'right' }); y += opt.gap || 15; };
    const head = (t) => { doc.fillColor('#000').font('Helvetica-Bold').fontSize(10.5).text(t, ML, y); y += 4; doc.moveTo(ML, y + 8).lineTo(CR, y + 8).lineWidth(0.6).strokeColor('#000').stroke(); y += 16; };

    head('PARTNERSHIP'); line('Name', 'PNTHR Carnivore Quant Fund, LP'); line('General Partner', 'PNTHR Funds, LLC'); line('EIN', '__-_______ (per tax preparer)'); y += 6;
    head('PARTNER'); line('Name', inv.name); line('Class', inv.class); line('Address', (inv.address || []).join(', '), { gap: 28 }); line('Ownership %', (inv.ownership * 100).toFixed(2) + '%'); y += 6;

    head('PART III — PARTNER’S SHARE OF INCOME (taxable items, year-to-date)');
    line('Interest income (Box 5)', sh(income.interest));
    line('Dividend income — US (Box 6a)', sh(income.dividendsUS));
    line('Dividend income — foreign (Box 6a)', sh(income.dividendsForeign || 0));
    line('Net short-term capital gain/(loss) (Box 8)', sh(income.realizedShortTerm));
    line('Net long-term capital gain/(loss) (Box 9a)', 0);
    const deductions = (income.admin || 0) + (income.legal || 0) + (income.professional || 0) + (income.operating || 0) + (income.orgCost || 0);
    line('Other deductions — fund expenses (Box 13)', sh(deductions));
    line('GP expense reimbursement (offsets expenses)', sh(income.reimbursement));
    y += 6;

    head('ITEM L — PARTNER’S CAPITAL ACCOUNT (tax-basis)');
    line('Beginning capital account', sh(capital.beginning));
    line('Capital contributed during the year', sh(capital.additions));
    line('Current year net income (loss)', sh(capital.netIncome));
    line('Withdrawals & distributions', sh(capital.redemptions ? -Math.abs(capital.redemptions) : 0));
    line('Ending capital account', sh(capital.ending), { bold: true });
    y += 10;

    doc.fillColor('#666').font('Helvetica').fontSize(7.5).text(
      'NOTES: Figures are the partner’s allocated share of the Fund’s year-to-date results from the December statement (taxable / realized items only; the unrealized mark is excluded). The Tree strategy holds positions under one year, so realized gains are short-term. Commissions are netted into realized gain by the broker. Qualified-dividend split, wash sales, §704(b)/(c) allocations, and final Box character are to be determined by the tax preparer. This package supports preparation of Form 1065 and Schedule K-1; it is not a filed return.',
      ML, y, { width: CR - ML, lineGap: 1.5 });
    doc.fillColor('#2b5fa8').font('Helvetica-Bold').fontSize(8).text(`Prepared by PNTHR Funds, LLC (General Partner) — generated ${new Date().toISOString().slice(0, 10)}`, ML, 740);
    doc.end();
  });
}
