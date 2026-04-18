/**
 * accessRequests.js
 *
 * Collection + helpers for the `pnthr_access_requests` table. Public signup
 * requests land here in a `pending` state — Scott reviews in PNTHR Assistant
 * and promotes to either `users` (member) or `den_investors` (investor).
 *
 * Statuses:
 *   pending           — awaiting admin review
 *   approved-member   — moved to users collection
 *   approved-investor — moved to den_investors collection
 *   denied            — admin rejected
 *   expired           — auto-marked after 14 days without action
 *
 * Approved / denied / expired records are kept for audit but filtered out
 * of the default list so the UI stays focused on actionable items.
 */

import { ObjectId } from 'mongodb';
import { connectToDatabase, createUser } from './database.js';
import { createInvestor } from './investorService.js';

const COLLECTION       = 'pnthr_access_requests';
const EXPIRY_DAYS      = 14;
const EXPIRY_MS        = EXPIRY_DAYS * 24 * 60 * 60 * 1000;

export async function ensureAccessRequestIndexes() {
  const db = await connectToDatabase();
  await db.collection(COLLECTION).createIndex({ email: 1 });
  await db.collection(COLLECTION).createIndex({ status: 1, createdAt: -1 });
}

// ── Public create ──────────────────────────────────────────────────────────

// Caller passes hashed password (so we don't double-hash on approval).
export async function createAccessRequest({ name, email, hashedPassword }) {
  const db = await connectToDatabase();
  const lower = email.toLowerCase().trim();
  await db.collection(COLLECTION).insertOne({
    name:          name.trim(),
    email:         lower,
    hashedPassword,
    status:        'pending',
    createdAt:     new Date(),
    actionedAt:    null,
    actionedBy:    null,
  });
  return { email: lower };
}

// Returns true if the email already exists anywhere that would block signup
// (active user, active investor, OR a pending request).
export async function emailAlreadyInUse(email) {
  const db = await connectToDatabase();
  const lower = email.toLowerCase().trim();
  const [user, investor, pending] = await Promise.all([
    db.collection('users').findOne({ email: lower }),
    db.collection('den_investors').findOne({ email: lower }),
    db.collection(COLLECTION).findOne({ email: lower, status: 'pending' }),
  ]);
  return !!(user || investor || pending);
}

// ── Admin list / action ────────────────────────────────────────────────────

// Returns pending requests (after auto-expiring stale ones) plus recently
// actioned requests for audit context. Frontend can filter client-side.
export async function listAccessRequests() {
  const db = await connectToDatabase();
  await expireStale(db);
  return db.collection(COLLECTION)
    .find({})
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
}

async function expireStale(db) {
  const cutoff = new Date(Date.now() - EXPIRY_MS);
  await db.collection(COLLECTION).updateMany(
    { status: 'pending', createdAt: { $lt: cutoff } },
    { $set: { status: 'expired', actionedAt: new Date(), actionedBy: 'system' } }
  );
}

async function loadPendingRequest(db, id) {
  const request = await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
  if (!request)                     return { error: 'Request not found', code: 404 };
  if (request.status !== 'pending') return { error: `Request already ${request.status}`, code: 409 };
  return { request };
}

export async function approveAsMember(id, actionedBy) {
  const db = await connectToDatabase();
  const { error, code, request } = await loadPendingRequest(db, id);
  if (error) return { error, code };

  try {
    await createUser(request.email, request.hashedPassword, { name: request.name, status: 'active' });
  } catch (e) {
    if (e.message.includes('already exists')) return { error: 'An active user already exists for this email', code: 409 };
    throw e;
  }

  await db.collection(COLLECTION).updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: 'approved-member', actionedAt: new Date(), actionedBy } }
  );
  return { ok: true, accountType: 'member', email: request.email, name: request.name };
}

export async function approveAsInvestor(id, actionedBy) {
  const db = await connectToDatabase();
  const { error, code, request } = await loadPendingRequest(db, id);
  if (error) return { error, code };

  // createInvestor re-hashes — so we bypass it and insert directly with the
  // already-hashed password from the request. Keeps a single hash pass.
  try {
    await db.collection('den_investors').insertOne({
      name:             request.name,
      email:            request.email,
      company:          '',
      hashedPassword:   request.hashedPassword,
      status:           'active',
      role:             'investor',
      createdBy:        actionedBy,
      createdAt:        new Date(),
      lastLoginAt:      null,
      disabledAt:       null,
      loginCount:       0,
      maxLogins:        5,
      investmentAmount: null,     // investor sets their own on first login
      dataroomSections: [],
    });
  } catch (e) {
    if (e.code === 11000) return { error: 'An investor account already exists for this email', code: 409 };
    throw e;
  }

  await db.collection(COLLECTION).updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: 'approved-investor', actionedAt: new Date(), actionedBy } }
  );
  return { ok: true, accountType: 'investor', email: request.email, name: request.name };
}

export async function denyAccessRequest(id, actionedBy) {
  const db = await connectToDatabase();
  const { error, code, request } = await loadPendingRequest(db, id);
  if (error) return { error, code };
  await db.collection(COLLECTION).updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: 'denied', actionedAt: new Date(), actionedBy } }
  );
  return { ok: true, email: request.email, name: request.name };
}

// Unused import stub so createInvestor stays referenced (future proofing)
export { createInvestor };
