/**
 * investorService.js
 *
 * Business logic for investor portal: CRUD for investor accounts,
 * event tracking, and analytics aggregation.
 */

import { ObjectId } from 'mongodb';
import { connectToDatabase } from './database.js';
import { hashPassword, verifyPassword } from './auth.js';

const INVESTORS = 'den_investors';
const EVENTS    = 'den_events';

// ── Indexes (call once at startup) ──────────────────────────────────────────

export async function ensureInvestorIndexes() {
  const db = await connectToDatabase();
  await db.collection(INVESTORS).createIndex({ email: 1 }, { unique: true });
  await db.collection(INVESTORS).createIndex({ status: 1 });
  await db.collection(EVENTS).createIndex({ investorId: 1, timestamp: -1 });
  await db.collection(EVENTS).createIndex({ type: 1, timestamp: -1 });
}

// ── Investor CRUD ───────────────────────────────────────────────────────────

export async function createInvestor({ name, email, company, password, dataroomSections, createdBy }) {
  const db = await connectToDatabase();
  const hashed = await hashPassword(password);
  const doc = {
    name,
    email: email.toLowerCase().trim(),
    company: company || '',
    hashedPassword: hashed,
    status: 'active',
    role: 'investor',
    createdBy,
    createdAt: new Date(),
    lastLoginAt: null,
    disabledAt: null,
    dataroomSections: dataroomSections || [],
  };
  const result = await db.collection(INVESTORS).insertOne(doc);
  return { _id: result.insertedId, ...doc, hashedPassword: undefined };
}

export async function findInvestorByEmail(email) {
  const db = await connectToDatabase();
  return db.collection(INVESTORS).findOne({ email: email.toLowerCase().trim() });
}

export async function findInvestorById(id) {
  const db = await connectToDatabase();
  return db.collection(INVESTORS).findOne({ _id: new ObjectId(id) });
}

export async function listInvestors() {
  const db = await connectToDatabase();
  return db.collection(INVESTORS)
    .find({}, { projection: { hashedPassword: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
}

export async function updateInvestor(id, updates) {
  const db = await connectToDatabase();
  const allowed = {};
  if (updates.status !== undefined) {
    allowed.status = updates.status;
    if (updates.status === 'disabled') allowed.disabledAt = new Date();
  }
  if (updates.name !== undefined) allowed.name = updates.name;
  if (updates.company !== undefined) allowed.company = updates.company;
  if (updates.dataroomSections !== undefined) allowed.dataroomSections = updates.dataroomSections;
  if (updates.password) allowed.hashedPassword = await hashPassword(updates.password);

  await db.collection(INVESTORS).updateOne(
    { _id: new ObjectId(id) },
    { $set: allowed }
  );
}

export async function deleteInvestor(id) {
  const db = await connectToDatabase();
  await db.collection(INVESTORS).deleteOne({ _id: new ObjectId(id) });
  // Also clean up their events
  await db.collection(EVENTS).deleteMany({ investorId: new ObjectId(id) });
}

export async function recordLogin(investorId) {
  const db = await connectToDatabase();
  await db.collection(INVESTORS).updateOne(
    { _id: new ObjectId(investorId) },
    { $set: { lastLoginAt: new Date() } }
  );
}

// ── Investor Login ──────────────────────────────────────────────────────────

export async function authenticateInvestor(email, password) {
  const investor = await findInvestorByEmail(email);
  if (!investor) return null;
  if (investor.status !== 'active') return null;
  const valid = await verifyPassword(password, investor.hashedPassword);
  if (!valid) return null;
  await recordLogin(investor._id);
  return investor;
}

// ── Event Tracking ──────────────────────────────────────────────────────────

export async function logEvent(investorId, type, metadata = {}, req = null) {
  const db = await connectToDatabase();
  const event = {
    investorId: new ObjectId(investorId),
    type,
    page: metadata.page || null,
    documentId: metadata.documentId ? new ObjectId(metadata.documentId) : null,
    documentName: metadata.documentName || null,
    metadata: metadata.extra || null,
    ip: req?.ip || req?.headers?.['x-forwarded-for'] || null,
    userAgent: req?.headers?.['user-agent'] || null,
    timestamp: new Date(),
  };
  await db.collection(EVENTS).insertOne(event);
}

// ── Activity & Analytics ────────────────────────────────────────────────────

export async function getInvestorActivity(investorId, limit = 100) {
  const db = await connectToDatabase();
  return db.collection(EVENTS)
    .find({ investorId: new ObjectId(investorId) })
    .sort({ timestamp: -1 })
    .limit(limit)
    .toArray();
}

export async function getAnalyticsSummary() {
  const db = await connectToDatabase();

  // All investors with their last activity
  const investors = await db.collection(INVESTORS)
    .find({}, { projection: { hashedPassword: 0 } })
    .sort({ createdAt: -1 })
    .toArray();

  // Event counts per investor
  const eventCounts = await db.collection(EVENTS).aggregate([
    { $group: {
      _id: '$investorId',
      totalEvents: { $sum: 1 },
      pageViews: { $sum: { $cond: [{ $eq: ['$type', 'page_view'] }, 1, 0] } },
      docViews: { $sum: { $cond: [{ $eq: ['$type', 'document_view'] }, 1, 0] } },
      sessions: { $sum: { $cond: [{ $eq: ['$type', 'session_start'] }, 1, 0] } },
      lastActivity: { $max: '$timestamp' },
    }},
  ]).toArray();

  const countsMap = {};
  for (const ec of eventCounts) {
    countsMap[ec._id.toString()] = ec;
  }

  // Compute engagement score per investor
  const enriched = investors.map(inv => {
    const c = countsMap[inv._id.toString()] || { totalEvents: 0, pageViews: 0, docViews: 0, sessions: 0, lastActivity: null };
    const score = (c.pageViews * 1) + (c.docViews * 3) + (c.sessions * 5);
    let tier = 'Cold';
    if (score > 80) tier = 'Ready';
    else if (score > 50) tier = 'Hot';
    else if (score > 20) tier = 'Warm';
    return { ...inv, ...c, engagementScore: score, engagementTier: tier };
  });

  // Most viewed documents
  const topDocs = await db.collection(EVENTS).aggregate([
    { $match: { type: 'document_view', documentName: { $ne: null } } },
    { $group: { _id: '$documentName', views: { $sum: 1 } } },
    { $sort: { views: -1 } },
    { $limit: 10 },
  ]).toArray();

  // Most viewed pages
  const topPages = await db.collection(EVENTS).aggregate([
    { $match: { type: 'page_view', page: { $ne: null } } },
    { $group: { _id: '$page', views: { $sum: 1 } } },
    { $sort: { views: -1 } },
    { $limit: 10 },
  ]).toArray();

  return { investors: enriched, topDocs, topPages };
}
