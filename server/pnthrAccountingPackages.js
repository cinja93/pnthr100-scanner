// PNTHR Accounting — year-end deliverable packages (auditor + tax).
//
// buildAuditPackageZip(year)  -> one zip the GP hands the independent auditor (Spicer
//   Jeffries): all 12 monthly statements + working papers, the fund-level reference docs,
//   and the IBKR Flex custodian source files, plus a MANIFEST. One-button download.
//
// These bundle what the engine already produced/stored — they don't recompute anything,
// so the package always matches the finalized monthly documents.

import JSZip from 'jszip';
import { connectToDatabase } from './database.js';
import { listPeriods, getDocument, listReferenceDocuments } from './pnthrAccountingService.js';

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
