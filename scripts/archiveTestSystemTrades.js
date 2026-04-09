#!/usr/bin/env node
// scripts/archiveTestSystemTrades.js
// Archives non-PNTHR-system trades (those without Kill ranks/scores)
// from pnthr_journal and pnthr_portfolio into pnthr_test_system_archive.
// Usage: node scripts/archiveTestSystemTrades.js

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, '../server/') + '/');
const { MongoClient } = require('mongodb');

// Manual .env parsing (no dotenv dependency needed)
const envPath = resolve(__dirname, '../server/.env');
const envLines = readFileSync(envPath, 'utf8').split('\n');
for (const line of envLines) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'pnthr_den';

if (!uri) {
  console.error('ERROR: MONGODB_URI not set. Add it to server/.env or pass as env var.');
  process.exit(1);
}

async function run() {
  const client = new MongoClient(uri);
  await client.connect();
  console.log(`Connected to MongoDB — database: ${dbName}\n`);
  const db = client.db(dbName);

  const archive = db.collection('pnthr_test_system_archive');
  const journal = db.collection('pnthr_journal');
  const portfolio = db.collection('pnthr_portfolio');

  // ── STEP 1: Archive journal entries without Kill ranks ──
  console.log('=== STEP 1: Journal entries without Kill ranks ===\n');

  // Find entries where BOTH entry.killRank and killScoreAtEntry.rank are missing/null
  const journalNoKill = await journal.find({
    $and: [
      { $or: [{ 'entry.killRank': null }, { 'entry.killRank': { $exists: false } }] },
      { $or: [{ 'killScoreAtEntry.rank': null }, { 'killScoreAtEntry.rank': { $exists: false } }] }
    ]
  }).toArray();

  console.log(`Found ${journalNoKill.length} journal entries without Kill rank`);

  const archivedJournalTickers = [];
  if (journalNoKill.length > 0) {
    // Insert into archive with metadata
    const archiveDocs = journalNoKill.map(doc => ({
      ...doc,
      _originalId: doc._id,
      archivedFrom: 'pnthr_journal',
      archivedAt: new Date()
    }));
    // Remove _id so MongoDB generates new ones for archive
    archiveDocs.forEach(d => delete d._id);

    await archive.insertMany(archiveDocs);

    // Delete from journal
    const idsToDelete = journalNoKill.map(d => d._id);
    await journal.deleteMany({ _id: { $in: idsToDelete } });

    journalNoKill.forEach(d => {
      const ticker = d.ticker || d.entry?.ticker || d.symbol || 'UNKNOWN';
      archivedJournalTickers.push(ticker);
      console.log(`  Archived: ${ticker}`);
    });
  }

  // ── STEP 2: Archive portfolio positions without Kill scores ──
  console.log('\n=== STEP 2: Portfolio positions without killScore ===\n');

  // All positions (open AND closed) where killScore is null/missing
  const portfolioNoKill = await portfolio.find({
    $or: [{ killScore: null }, { killScore: { $exists: false } }]
  }).toArray();

  console.log(`Found ${portfolioNoKill.length} portfolio positions without killScore`);

  const archivedPortfolioTickers = [];
  if (portfolioNoKill.length > 0) {
    const archiveDocs = portfolioNoKill.map(doc => ({
      ...doc,
      _originalId: doc._id,
      archivedFrom: 'pnthr_portfolio',
      archivedAt: new Date()
    }));
    archiveDocs.forEach(d => delete d._id);

    await archive.insertMany(archiveDocs);

    const idsToDelete = portfolioNoKill.map(d => d._id);
    await portfolio.deleteMany({ _id: { $in: idsToDelete } });

    portfolioNoKill.forEach(d => {
      const ticker = d.ticker || d.symbol || 'UNKNOWN';
      const status = d.status || 'unknown';
      archivedPortfolioTickers.push(`${ticker} (${status})`);
      console.log(`  Archived: ${ticker} — status: ${status}`);
    });
  }

  // ── STEP 3: Report ──
  console.log('\n=== FINAL REPORT ===\n');

  const journalRemaining = await journal.countDocuments();
  const portfolioRemaining = await portfolio.countDocuments();
  const archiveTotal = await archive.countDocuments();

  console.log(`Journal entries archived:    ${journalNoKill.length}`);
  console.log(`Portfolio positions archived: ${portfolioNoKill.length}`);
  console.log(`Journal entries remaining:   ${journalRemaining}`);
  console.log(`Portfolio positions remaining: ${portfolioRemaining}`);
  console.log(`Total in archive collection: ${archiveTotal}`);

  if (archivedJournalTickers.length > 0) {
    console.log(`\nArchived journal tickers: ${archivedJournalTickers.join(', ')}`);
  }
  if (archivedPortfolioTickers.length > 0) {
    console.log(`Archived portfolio tickers: ${archivedPortfolioTickers.join(', ')}`);
  }

  // Show what remains
  const remainingJournal = await journal.find({}, { projection: { ticker: 1, 'entry.ticker': 1, symbol: 1 } }).toArray();
  const remainingPortfolio = await portfolio.find({}, { projection: { ticker: 1, symbol: 1, status: 1 } }).toArray();

  if (remainingJournal.length > 0) {
    const kept = remainingJournal.map(d => d.ticker || d.entry?.ticker || d.symbol || '?');
    console.log(`\nKept journal tickers: ${kept.join(', ')}`);
  }
  if (remainingPortfolio.length > 0) {
    const kept = remainingPortfolio.map(d => `${d.ticker || d.symbol || '?'} (${d.status || '?'})`);
    console.log(`Kept portfolio tickers: ${kept.join(', ')}`);
  }

  await client.close();
  console.log('\nDone.');
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
