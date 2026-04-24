import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set');
  process.exit(1);
}

const JWT_EXPIRY = '30d';

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// Role is embedded in the token so every request carries it without a DB lookup
export function generateToken(userId, email, role = 'member') {
  return jwt.sign({ userId: userId.toString(), email, role }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

// ── Impersonation token ──────────────────────────────────────────────────────
// Admin-only, short-lived (30 min), read-only. JWT carries the TARGET user's
// identity so every downstream data query filters to their ownerId. The
// impersonatedBy/impersonatorEmail claims let the server log the admin and
// let the client render a "VIEWING AS ..." banner.
//
// readOnly: true is enforced by authenticateJWT below — any non-GET request
// carrying this claim is rejected with 403, even if the client UI bypasses
// its disabled-state checks.
export function generateImpersonationToken({
  targetUserId,
  targetEmail,
  targetRole,
  targetDisplayName,
  impersonatorUserId,
  impersonatorEmail,
}) {
  return jwt.sign(
    {
      userId:            targetUserId.toString(),
      email:             targetEmail,
      role:              targetRole,
      impersonatedBy:    impersonatorUserId.toString(),
      impersonatorEmail,
      targetDisplayName,
      readOnly:          true,
    },
    JWT_SECRET,
    { expiresIn: '30m' },
  );
}

// Returns the set of admin emails from the ADMIN_EMAILS env var (comma-separated)
export function getAdminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

// Resolves the correct role for a user: ADMIN_EMAILS env var always wins
export function resolveRole(email) {
  const admins = getAdminEmails();
  return admins.includes(email.toLowerCase().trim()) ? 'admin' : 'member';
}

// Express middleware — verifies Bearer token and sets req.user = { userId, email, role }
// When ?demo=1 is present and user is admin, swaps userId to demo_fund.
export function authenticateJWT(req, res, next) {
  const authHeader = req.headers['authorization'];
  // Support ?token= query param for new-tab document viewing (no Authorization header available)
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.query?.token;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);

    // ── Impersonation path ─────────────────────────────────────────────────
    // Admin-scoped token pretending to be another user. Token's role is
    // fixed at issuance (target's actual role); we do NOT re-resolve against
    // ADMIN_EMAILS because that would leak admin privileges into the
    // impersonated session. readOnly is enforced here before any handler runs.
    if (payload.impersonatedBy) {
      // The stop endpoint writes the session's stop-time to the audit log, so
      // it's the only non-GET allowed from within an impersonation session.
      const isStopEndpoint = req.path === '/api/admin/impersonate/stop';
      if (payload.readOnly && req.method !== 'GET' && !isStopEndpoint) {
        return res.status(403).json({
          error: 'Impersonation session is read-only. This action cannot be performed.',
          code:  'IMPERSONATION_READ_ONLY',
        });
      }
      req.user = {
        userId:            payload.userId,
        email:             payload.email,
        role:              payload.role,
        impersonatedBy:    payload.impersonatedBy,
        impersonatorEmail: payload.impersonatorEmail,
        targetDisplayName: payload.targetDisplayName,
        readOnly:          !!payload.readOnly,
      };
      return next();
    }

    // Investor tokens carry source: 'den_investors' — keep role as 'investor', skip ADMIN_EMAILS
    if (payload.source === 'den_investors') {
      req.user = { userId: payload.userId, email: payload.email, role: 'investor', isInvestor: true, source: 'den_investors' };
      return next();
    }

    // Always re-resolve role from ADMIN_EMAILS so promotions/demotions take effect
    // on the next request without requiring re-login
    const role = resolveRole(payload.email);
    req.user = { userId: payload.userId, email: payload.email, role };
    // Demo mode: swap userId to demo_fund for admin users (exclude /api/demo/* endpoints)
    const demoRequested = req.headers['x-demo-mode'] === '1' || req.query?.demo === '1';
    if (demoRequested && role === 'admin' && !req.path?.includes('/demo')) {
      req.user.userId = 'demo_fund';
      req.user._isDemo = true;
    }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// One-time HMAC token for approve/deny email links — scoped to userId + action
export function generateApprovalToken(userId) {
  return crypto.createHmac('sha256', JWT_SECRET)
    .update(userId.toString() + 'approval')
    .digest('hex')
    .substring(0, 32);
}

export function verifyApprovalToken(userId, token) {
  return token === generateApprovalToken(userId);
}

// Middleware — rejects non-admins with 403
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
