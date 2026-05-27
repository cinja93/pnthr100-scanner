#!/usr/bin/env node
/**
 * One-time migration: reorganize AI Elite 300 data room from one flat section
 * into 4 sub-categories for investor clarity.
 *
 * Usage:
 *   node scripts/migrate-dataroom-ai-sections.js              # dry run (default)
 *   node scripts/migrate-dataroom-ai-sections.js --execute     # actually move docs
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const require = createRequire(import.meta.url);
const { MongoClient } = require(join(__dirname, '..', 'server', 'node_modules', 'mongodb'));

// Load .env manually (dotenv not available outside server/)
const envPath = join(__dirname, '..', 'server', '.env');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch (e) { console.error('Could not read server/.env:', e.message); process.exit(1); }

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) { console.error('MONGODB_URI not set in server/.env'); process.exit(1); }

const DRY_RUN = !process.argv.includes('--execute');

const OLD_SECTION = 'PNTHR AI Elite 300 Fund';

const SECTIONS = {
  overview:      'PNTHR AI Elite 300 — Fund Overview & Performance',
  legal:         'PNTHR AI Elite 300 — Fund Legal Documents',
  qualification: 'PNTHR AI Elite 300 — Investor Qualification',
  operations:    'PNTHR AI Elite 300 — Operations & Compliance',
};

// Rules checked in order — first match wins. Patterns match against document label.
const RULES = [
  // ── Fund Overview & Performance ──
  { pattern: /intelligence report|IR.*filet|IR.*porterhouse|IR.*wagyu/i, section: SECTIONS.overview, order: 0 },
  { pattern: /performance summary/i,   section: SECTIONS.overview, order: 10 },
  { pattern: /investor explanation/i,   section: SECTIONS.overview, order: 20 },
  { pattern: /investment process/i,     section: SECTIONS.overview, order: 30 },
  { pattern: /index members/i,         section: SECTIONS.overview, order: 40 },

  // ── Fund Legal Documents ──
  { pattern: /private placement|PPM/i,                         section: SECTIONS.legal, order: 0 },
  { pattern: /limited partnership|LPA/i,                       section: SECTIONS.legal, order: 10 },
  { pattern: /subscription agreement|sub agreement|sub agmt/i, section: SECTIONS.legal, order: 20 },
  { pattern: /investment management agreement|IMA\b/i,         section: SECTIONS.legal, order: 30 },
  { pattern: /GP operating|general partner operating/i,        section: SECTIONS.legal, order: 40 },
  { pattern: /fee schedule/i,                                  section: SECTIONS.legal, order: 50 },
  { pattern: /letter of intent/i,                              section: SECTIONS.legal, order: 60 },

  // ── Investor Qualification ──
  { pattern: /subscriber.*questionnaire|investor.*questionnaire/i, section: SECTIONS.qualification, order: 0 },
  { pattern: /accredited investor/i,                               section: SECTIONS.qualification, order: 10 },

  // ── Operations & Compliance ──
  { pattern: /key personnel/i,                          section: SECTIONS.operations, order: 0 },
  { pattern: /risk management/i,                        section: SECTIONS.operations, order: 10 },
  { pattern: /compliance manual|code of ethics/i,       section: SECTIONS.operations, order: 20 },
  { pattern: /AML|KYC|anti-money laundering|know your customer/i, section: SECTIONS.operations, order: 30 },
  { pattern: /BCP|disaster recovery|business continuity/i, section: SECTIONS.operations, order: 40 },
  { pattern: /DDQ|due diligence/i,                      section: SECTIONS.operations, order: 50 },
  { pattern: /overlap ticker/i,                         section: SECTIONS.operations, order: 60 },
  { pattern: /service provider/i,                       section: SECTIONS.operations, order: 70 },
];

async function migrate() {
  console.log(DRY_RUN ? '=== DRY RUN (pass --execute to apply) ===\n' : '=== EXECUTING MIGRATION ===\n');

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db('pnthr_den');

  // 1. Fetch all docs currently in the old AI Elite section
  const docs = await db.collection('dataroom_documents')
    .find({ section: OLD_SECTION }, { projection: { label: 1, filename: 1, section: 1, sortOrder: 1 } })
    .sort({ sortOrder: 1, uploadedAt: -1 })
    .toArray();

  console.log(`Found ${docs.length} documents in "${OLD_SECTION}"\n`);

  if (docs.length === 0) {
    console.log('Nothing to migrate. Exiting.');
    await client.close();
    return;
  }

  // 2. Match each document to a new section
  const moves = [];
  const unmatched = [];

  for (const doc of docs) {
    const label = doc.label || doc.filename || '';
    let matched = false;

    for (const rule of RULES) {
      if (rule.pattern.test(label)) {
        moves.push({ id: doc._id, label, newSection: rule.section, ruleOrder: rule.order });
        matched = true;
        break;
      }
    }

    if (!matched) {
      unmatched.push({ id: doc._id, label });
    }
  }

  // Sort moves by section then by rule order, then assign sequential sortOrder
  const sectionCounters = {};
  for (const name of Object.values(SECTIONS)) sectionCounters[name] = 0;
  moves.sort((a, b) => {
    if (a.newSection !== b.newSection) return a.newSection.localeCompare(b.newSection);
    return a.ruleOrder - b.ruleOrder;
  });
  for (const m of moves) {
    m.sortOrder = sectionCounters[m.newSection]++;
  }

  // Print the mapping grouped by section
  for (const [key, sectionName] of Object.entries(SECTIONS)) {
    const inSection = moves.filter(m => m.newSection === sectionName);
    console.log(`\n── ${sectionName} (${inSection.length} docs) ──`);
    for (const m of inSection) {
      console.log(`  ${m.sortOrder.toString().padStart(2)}  ${m.label}`);
    }
  }

  if (unmatched.length > 0) {
    console.log(`\n⚠  UNMATCHED (${unmatched.length} docs — will stay in old section):`);
    for (const u of unmatched) {
      console.log(`     ${u.label}`);
    }
  }

  console.log(`\nSummary: ${moves.length} matched, ${unmatched.length} unmatched out of ${docs.length} total`);

  if (DRY_RUN) {
    console.log('\n=== DRY RUN COMPLETE — no changes made ===');
    console.log('Run with --execute to apply these changes.');
    await client.close();
    return;
  }

  // 3. Create new sections
  for (const name of Object.values(SECTIONS)) {
    await db.collection('dataroom_sections').updateOne(
      { name },
      { $set: { name, createdAt: new Date() } },
      { upsert: true }
    );
    console.log(`\n✓ Section created: ${name}`);
  }

  // 4. Move documents
  const ops = moves.map(m => ({
    updateOne: {
      filter: { _id: m.id },
      update: { $set: { section: m.newSection, sortOrder: m.sortOrder } }
    }
  }));

  if (ops.length > 0) {
    const result = await db.collection('dataroom_documents').bulkWrite(ops);
    console.log(`✓ ${result.modifiedCount} documents moved to new sections`);
  }

  // 5. Clean up old section if empty
  const remaining = await db.collection('dataroom_documents').countDocuments({ section: OLD_SECTION });
  if (remaining === 0) {
    await db.collection('dataroom_sections').deleteOne({ name: OLD_SECTION });
    console.log(`✓ Old section "${OLD_SECTION}" removed (empty)`);
  } else {
    console.log(`ℹ  ${remaining} documents still in old section`);
  }

  await client.close();
  console.log('\n=== MIGRATION COMPLETE ===');
}

migrate().catch(err => { console.error('Migration failed:', err); process.exit(1); });
