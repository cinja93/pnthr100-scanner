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
  'Financial':                  'Financial Services',
  'Health Care':                'Healthcare',
  'Information Technology':     'Technology',
  'Materials':                  'Basic Materials',
  'Communication':              'Communication Services',
  'Telecommunication Services': 'Communication Services',

  // FMP ETF category names — commodity/thematic ETFs use non-GICS strings
  'Energy & Infrastructure':    'Energy',              // USO, UNG, XOP, OIH
  'Natural Resources':          'Energy',              // broad commodity ETFs
  'Precious Metals':            'Basic Materials',     // GLD, SLV, GDX, GDXJ
  'Technology & Communications': 'Technology',         // thematic tech ETFs
  'Healthcare & Biotech':       'Healthcare',          // XBI, IBB, ARKG
  'Industrial & Services':      'Industrials',         // thematic industrial ETFs
  'Consumer & Retail':          'Consumer Discretionary', // XRT, IBUY
  'Autos & Transportation':     'Industrials',         // CARZ, IYT
  'Banks & Credit':             'Financial Services',  // KBE, KRE
  'Insurance':                  'Financial Services',

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
