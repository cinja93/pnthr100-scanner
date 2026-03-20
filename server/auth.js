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
export function authenticateJWT(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Always re-resolve role from ADMIN_EMAILS so promotions/demotions take effect
    // on the next request without requiring re-login
    const role = resolveRole(payload.email);
    req.user = { userId: payload.userId, email: payload.email, role };
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
