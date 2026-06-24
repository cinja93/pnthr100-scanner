// server/scripts_den/den_upload_tree_perf_correction_2026_06_23.js
//
// Replace the 3 PNTHR Tree data-room docs whose performance numbers were stale after the
// Tree baseline drift fix (PSTG/PRO/BITF delisting + split re-syncs corrected the backtest
// from +1,030% to the reproducible +774% gross / per-tier set). All three now reconcile to
// the locked treeSim engine via irLiveService.computeSide (same source as the dashboard +
// in-app Tree IR). v2.1 -> v2.2 in place (labels unchanged; file content + filename + size).
//
//   UPDATE "Performance Summary"               -> PNTHR_Tree_Fund_Performance_Summary_v2.2_2026.pdf
//   UPDATE "Investor Explanation"              -> PNTHR_Tree_Fund_Investor_Explanation_v2.2_2026.pdf
//   UPDATE "Due Diligence Questionnaire (DDQ)" -> PNTHR_Tree_Fund_DDQ_v2.2_2026.pdf
//
// Safety: backs up the full dataroom_documents collection first; DRY-RUN by default;
// validates each v2.2 PDF carries the corrected numbers and NOT the stale ones before upload.
// Run (dry-run):  node --env-file=../.env scripts_den/den_upload_tree_perf_correction_2026_06_23.js
// Run (apply):    node --env-file=../.env scripts_den/den_upload_tree_perf_correction_2026_06_23.js --execute

import { MongoClient, Binary } from 'mongodb';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || 'pnthr_den';
const COLLECTION = 'dataroom_documents';
const BACKUP_COLLECTION = 'dataroom_documents_backup_tree_perf_correction_2026_06_23';
const EXECUTE = process.argv.includes('--execute');
const DOWNLOADS = path.join(os.homedir(), 'Downloads');

// matchLabel = the EXACT current Den label (unique per scan); filename = the corrected v2.2 PDF.
// mustHave / mustNotHave = text guards so we never upload a stale or wrong PDF.
const OPS = [
  { matchLabel: 'Performance Summary',
    filename: 'PNTHR_Tree_Fund_Performance_Summary_v2.2_2026.pdf',
    mustHave: ['+774.1%', '+407.4%'], mustNotHave: ['1,030.1', '+102.5%'] },
  { matchLabel: 'Investor Explanation',
    filename: 'PNTHR_Tree_Fund_Investor_Explanation_v2.2_2026.pdf',
    mustHave: ['+60.4%', '+87.9%'], mustNotHave: ['+70.7%', '+102.5%', '627,769'] },
  { matchLabel: 'Due Diligence Questionnaire (DDQ)',
    filename: 'PNTHR_Tree_Fund_DDQ_v2.2_2026.pdf',
    mustHave: ['1,333', '+60.4%'], mustNotHave: ['1,351', '+102.5%', '+70.7%'] },
];

async function main() {
  if (!URI) { console.error('No MONGODB_URI — run with --env-file=../.env'); process.exit(1); }

  // ── Load + validate the PDFs ────────────────────────────────────────────────
  const buffers = {};
  let bad = 0;
  for (const o of OPS) {
    const p = path.join(DOWNLOADS, o.filename);
    if (!fs.existsSync(p)) { console.error(`MISSING: ${o.filename}`); bad++; continue; }
    const buf = fs.readFileSync(p);
    let txt = '';
    try { txt = execSync(`pdftotext "${p}" - 2>/dev/null`, { maxBuffer: 1e8 }).toString(); } catch { /* */ }
    const missHave = o.mustHave.filter(s => !txt.includes(s));
    const hasStale = o.mustNotHave.filter(s => txt.includes(s));
    if (missHave.length) { console.error(`VALIDATION FAIL ${o.filename}: missing ${JSON.stringify(missHave)}`); bad++; continue; }
    if (hasStale.length) { console.error(`VALIDATION FAIL ${o.filename}: still contains stale ${JSON.stringify(hasStale)}`); bad++; continue; }
    buffers[o.filename] = buf;
    console.log(`  OK  ${o.filename}  (${(buf.length / 1024).toFixed(1)} KB) — corrected numbers verified, no stale numbers`);
  }
  if (bad > 0) { console.error(`\n${bad} PDF(s) failed validation — abort.`); process.exit(2); }

  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const col = db.collection(COLLECTION);

  // ── Preflight: every label must match exactly one current doc ────────────────
  const current = await col.find({}).toArray();
  const byLabel = new Map(current.map(d => [d.label, d]));
  console.log(`\nCurrent Den: ${current.length} docs (db ${DB_NAME})`);
  let unmatched = 0;
  for (const o of OPS) if (!byLabel.has(o.matchLabel)) { console.error(`NO MATCH: "${o.matchLabel}"`); unmatched++; }
  if (unmatched > 0) { console.error(`${unmatched} labels unmatched — abort`); await client.close(); process.exit(4); }

  console.log('\nPlanned operations:');
  for (const [i, o] of OPS.entries()) {
    const cur = byLabel.get(o.matchLabel);
    console.log(`  ${i + 1}. UPDATE "${o.matchLabel}"`);
    console.log(`       ${((cur.size || (cur.data?.length) || 0) / 1024).toFixed(1)} KB [${cur.filename}] -> ${(buffers[o.filename].length / 1024).toFixed(1)} KB [${o.filename}]`);
  }

  if (!EXECUTE) {
    console.log('\nDRY-RUN COMPLETE — no changes made. Re-run with --execute to apply.');
    await client.close();
    return;
  }

  // ── Backup, then apply ───────────────────────────────────────────────────────
  const backupCol = db.collection(BACKUP_COLLECTION);
  if (await backupCol.countDocuments() > 0) { console.error(`Backup "${BACKUP_COLLECTION}" already exists — drop it first.`); await client.close(); process.exit(5); }
  await backupCol.insertMany(current);
  console.log(`\nBacked up ${current.length} docs -> ${BACKUP_COLLECTION}`);

  console.log('\nApplying:');
  for (const o of OPS) {
    const cur = byLabel.get(o.matchLabel);
    const buf = buffers[o.filename];
    const r = await col.updateOne(
      { _id: cur._id },
      { $set: { label: o.matchLabel, filename: o.filename, contentType: 'application/pdf', size: buf.length, data: new Binary(buf), uploadedAt: new Date() } }
    );
    console.log(`  UPDATE "${o.matchLabel}" (matched=${r.matchedCount}, modified=${r.modifiedCount})`);
  }
  console.log(`\nFinal Den: ${await col.countDocuments()} docs · backup: ${DB_NAME}.${BACKUP_COLLECTION}`);
  console.log(`Rollback: db.${COLLECTION}.drop(); db.${BACKUP_COLLECTION}.aggregate([{$out:"${COLLECTION}"}])`);
  await client.close();
}

main().catch(e => { console.error(e.stack || e.message); process.exit(99); });
