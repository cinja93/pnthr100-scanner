// server/impersonationService.js
// ── PNTHR admin impersonation ───────────────────────────────────────────────
//
// Admin-only, read-only, audit-logged. Lets an admin see exactly what a
// specific VIP user sees when they log in, without switching identities or
// touching the target's data.
//
// Endpoints:
//   GET  /api/admin/impersonate/targets  — list of impersonatable users
//   POST /api/admin/impersonate          — start a session → returns scoped JWT
//   POST /api/admin/impersonate/stop     — log the stop event (client restores)
//
// Security guardrails (layered):
//   1. All endpoints require role === 'admin' AND NOT already impersonating.
//   2. The issued JWT carries `impersonatedBy` + `readOnly: true`. authenticateJWT
//      rejects any non-GET request from such a token before handlers run.
//   3. Every start / stop is persisted to pnthr_impersonation_log with admin
//      identity, target identity, timestamps, and IP.

import { ObjectId } from 'mongodb';
import { connectToDatabase } from './database.js';
import { generateImpersonationToken, getAdminEmails } from './auth.js';

const LOG_COLLECTION = 'pnthr_impersonation_log';
const USERS_COLLECTION = 'users';

// Synthetic target used by the "View as Vanilla" option — no MongoDB record,
// no data anywhere, so every per-user query comes back empty. Gives the admin
// a clean first-login UX preview without polluting the user list.
const VANILLA_TARGET = {
  id:          'vanilla-preview',
  displayName: 'Vanilla',
  email:       'vanilla@preview.local',
  role:        'member',
};

// Reject nested impersonation — an already-impersonating token must not be
// able to initiate another session. The target's own role is never 'admin'
// under our rules, so this is redundant with the role check, but defense
// in depth keeps the audit log clean.
function blockIfAlreadyImpersonating(req, res) {
  if (req.user?.impersonatedBy) {
    res.status(403).json({ error: 'Cannot start impersonation from within an impersonation session.' });
    return true;
  }
  return false;
}

function adminOnly(req, res) {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required.' });
    return true;
  }
  return false;
}

// GET /api/admin/impersonate/targets
// Lists impersonatable users. Currently: all users with role 'member' that the
// admin considers a "VIP" — we treat every non-admin / non-investor member as
// a VIP for this purpose. Adding more VIPs later just means creating their
// user account; they'll auto-surface here.
export async function impersonationListTargets(req, res) {
  if (adminOnly(req, res)) return;
  if (blockIfAlreadyImpersonating(req, res)) return;
  try {
    const db = await connectToDatabase();
    // Only active members — never admins, investors, or pending/denied accounts.
    // role 'member' covers normal Den users; the $exists fallback catches any
    // legacy docs missing the field.
    const users = await db.collection(USERS_COLLECTION)
      .find(
        {
          $or:    [{ role: 'member' }, { role: { $exists: false } }],
          status: { $in: ['active', null] },
        },
        { projection: { _id: 1, email: 1, name: 1, role: 1, status: 1 } },
      )
      .toArray();

    // Shape into a flat list for the dropdown. Vanilla is always first.
    // Admin emails come from the ADMIN_EMAILS env var, NOT the users
    // collection. The DB role field for admins is usually 'member' and gets
    // promoted dynamically via resolveRole() — so the role filter alone
    // would let admins (including the caller) appear here. Hard-exclude by
    // email so an admin can never start an impersonation session against
    // themselves or another admin.
    const adminEmailSet = new Set(getAdminEmails());
    const realTargets = users
      .filter(u => u.email
        && u.email !== VANILLA_TARGET.email
        && !adminEmailSet.has(u.email.toLowerCase().trim()))
      .map(u => ({
        id:          u._id.toString(),
        // Prefer the stored `name`; fall back to the email local-part if it's
        // empty (some older accounts predate the name field).
        displayName: u.name || (u.email ? u.email.split('@')[0] : 'User'),
        email:       u.email,
        role:        u.role || 'member',
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    res.json({
      vanilla: VANILLA_TARGET,
      targets: realTargets,
    });
  } catch (err) {
    console.error('[impersonation/targets]', err.message);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/admin/impersonate
// Body: { targetUserId }  — use 'vanilla-preview' for the empty-user mode
// Returns: { token, target: { displayName, email, role }, expiresAt }
export async function impersonationStart(req, res) {
  if (adminOnly(req, res)) return;
  if (blockIfAlreadyImpersonating(req, res)) return;

  const { targetUserId } = req.body || {};
  if (!targetUserId) {
    return res.status(400).json({ error: 'targetUserId is required.' });
  }

  try {
    let target;
    if (targetUserId === VANILLA_TARGET.id) {
      target = VANILLA_TARGET;
    } else {
      const db = await connectToDatabase();
      let userDoc;
      try {
        userDoc = await db.collection(USERS_COLLECTION).findOne({ _id: new ObjectId(targetUserId) });
      } catch {
        return res.status(400).json({ error: 'Invalid target user id.' });
      }
      if (!userDoc) {
        return res.status(404).json({ error: 'Target user not found.' });
      }
      if (userDoc.role === 'admin') {
        return res.status(403).json({ error: 'Cannot impersonate another admin.' });
      }
      target = {
        id:          userDoc._id.toString(),
        displayName: userDoc.name || userDoc.email.split('@')[0],
        email:       userDoc.email,
        role:        userDoc.role || 'member',
      };
    }

    const token = generateImpersonationToken({
      targetUserId:       target.id,
      targetEmail:        target.email,
      targetRole:         target.role,
      targetDisplayName:  target.displayName,
      impersonatorUserId: req.user.userId,
      impersonatorEmail:  req.user.email,
    });

    // Audit trail — record every session start.
    try {
      const db = await connectToDatabase();
      await db.collection(LOG_COLLECTION).insertOne({
        adminUserId:   req.user.userId,
        adminEmail:    req.user.email,
        targetUserId:  target.id,
        targetEmail:   target.email,
        targetName:    target.displayName,
        startedAt:     new Date(),
        stoppedAt:     null,
        ip:            req.ip || req.headers['x-forwarded-for'] || null,
        userAgent:     req.headers['user-agent'] || null,
      });
    } catch (err) {
      // Non-fatal — logging should never block the admin workflow. Surfaced
      // in server console if it happens so we can investigate.
      console.warn('[impersonation] audit log write failed:', err.message);
    }

    res.json({
      token,
      target: { displayName: target.displayName, email: target.email, role: target.role },
      // 30-minute TTL matches generateImpersonationToken.
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
  } catch (err) {
    console.error('[impersonation/start]', err.message);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/admin/impersonate/stop
// Logs the stop event; the client also clears its local impersonation token.
// Called from inside the impersonation session itself, so the token's
// impersonatedBy claim is what lets us look up the matching audit row.
export async function impersonationStop(req, res) {
  if (!req.user?.impersonatedBy) {
    return res.status(400).json({ error: 'No active impersonation session to stop.' });
  }
  try {
    const db = await connectToDatabase();
    // Close the most recent open session for this admin+target pair.
    await db.collection(LOG_COLLECTION).updateOne(
      {
        adminUserId:  req.user.impersonatedBy,
        targetUserId: req.user.userId,
        stoppedAt:    null,
      },
      { $set: { stoppedAt: new Date() } },
      { sort: { startedAt: -1 } },
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[impersonation/stop]', err.message);
    res.status(500).json({ error: err.message });
  }
}
