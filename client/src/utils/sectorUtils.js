/**
 * PNTHR Sector Name Normalization — client-side copy of server/sectorUtils.js
 *
 * Keep in sync with the server version. Canonical names:
 *   Technology · Healthcare · Financial Services · Consumer Discretionary ·
 *   Consumer Staples · Communication Services · Industrials · Basic Materials ·
 *   Real Estate · Utilities · Energy
 */

export const SECTOR_NORMALIZE_MAP = {
  'Consumer Cyclical':          'Consumer Discretionary',
  'Consumer Defensive':         'Consumer Staples',
  'Financial Services':         'Financial Services',
  'Financials':                 'Financial Services',
  'Health Care':                'Healthcare',
  'Information Technology':     'Technology',
  'Materials':                  'Basic Materials',
  'Communication':              'Communication Services',
  'Telecommunication Services': 'Communication Services',

  // Identity mappings — canonical names pass through unchanged
  'Technology':                 'Technology',
  'Healthcare':                 'Healthcare',
  'Consumer Discretionary':     'Consumer Discretionary',
  'Consumer Staples':           'Consumer Staples',
  'Energy':                     'Energy',
  'Industrials':                'Industrials',
  'Basic Materials':            'Basic Materials',
  'Communication Services':     'Communication Services',
  'Real Estate':                'Real Estate',
  'Utilities':                  'Utilities',
};

export const KNOWN_SECTORS = new Set(Object.values(SECTOR_NORMALIZE_MAP));

/**
 * Normalize a raw FMP sector string to the canonical PNTHR name.
 * @param {string|null|undefined} rawSector
 * @returns {string}
 */
export function normalizeSector(rawSector) {
  if (!rawSector) return 'Unknown';
  return SECTOR_NORMALIZE_MAP[rawSector] ?? rawSector;
}
