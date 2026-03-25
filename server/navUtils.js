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

/**
 * Read the NAV (account size) for a user from user_profiles.accountSize.
 *
 * @param {string} userId - The user's ID string (from JWT)
 * @param {import('mongodb').Db} db - Connected MongoDB database instance
 * @returns {Promise<number|null>} Account size in dollars, or null if not set
 */
export async function getNAV(userId, db) {
  if (!userId || !db) return null;
  try {
    const profile = await db.collection('user_profiles').findOne({ userId });
    return profile?.accountSize ?? null;
  } catch (err) {
    console.warn(`[NAV] Failed to read NAV for user ${userId}:`, err.message);
    return null;
  }
}
