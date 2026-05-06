/**
 * PNTHR NAV — Single Source of Truth
 *
 * All server code that needs a user's Net Asset Value reads from here.
 * Authority chain:
 *   1. IBKR bridge updates user_profiles.accountSize every 60 seconds
 *   2. Manual Command Center edit updates user_profiles.accountSize
 *   3. This function reads user_profiles.accountSize
 *
 * Never hardcode NAV or read it from a different collection.
 */

import { getUserProfile } from './database.js';

/**
 * Read the NAV (account size) for a user from user_profiles.accountSize.
 *
 * Uses getUserProfile() which converts hex-24 userIds to ObjectId — must
 * match the read path used by upsertUserProfile() (where the docs are
 * written) or the lookup misses and returns null. db param retained for
 * API compatibility; the helper opens its own connection.
 *
 * @param {string} userId - The user's ID string (from JWT)
 * @param {import('mongodb').Db} db - Connected MongoDB database instance (unused but retained)
 * @returns {Promise<number|null>} Account size in dollars, or null if not set
 */
export async function getNAV(userId, db) {
  if (!userId) return null;
  try {
    const profile = await getUserProfile(userId);
    return profile?.accountSize ?? null;
  } catch (err) {
    console.warn(`[NAV] Failed to read NAV for user ${userId}:`, err.message);
    return null;
  }
}
