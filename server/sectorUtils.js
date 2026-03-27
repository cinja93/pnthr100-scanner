/**
 * PNTHR Sector Name Normalization — single source of truth
 *
 * FMP returns different sector strings depending on the endpoint:
 *   - /stable/profile       → "Consumer Cyclical", "Consumer Defensive", etc.
 *   - /api/v3/sp500_constituent → closer to GICS but still inconsistent
 *
 * Canonical names used throughout PNTHR (matches SECTOR_KEY_TO_GICS values
 * in index.js and the SECTOR_MAP in apexService.js):
 *
 *   Technology · Healthcare · Financial Services · Consumer Discretionary ·
 *   Consumer Staples · Communication Services · Industrials · Basic Materials ·
 *   Real Estate · Utilities · Energy
 *
 * Normalize at INGESTION, not at display, so every downstream service
 * (apex scoring, signal counts, kill scores, newsletter, portfolio checks)
 * always sees the canonical string.
 */

// All known FMP aliases → canonical PNTHR/GICS name
export const SECTOR_NORMALIZE_MAP = {
  // FMP company-profile names (most common mismatches)
  'Consumer Cyclical':          'Consumer Discretionary',
  'Consumer Defensive':         'Consumer Staples',
  'Financial Services':         'Financial Services', // already canonical — explicit for logging guard
  'Financials':                 'Financial Services', // appears in some FMP endpoints
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

// Set of canonical sector names — used by the unknown-sector logger
export const KNOWN_SECTORS = new Set(Object.values(SECTOR_NORMALIZE_MAP));

/**
 * Normalize a raw FMP/Morningstar sector string to the canonical PNTHR name.
 * Returns 'Unknown' for null/undefined/empty input.
 *
 * @param {string|null|undefined} rawSector
 * @returns {string}
 */
export function normalizeSector(rawSector) {
  if (!rawSector) return 'Unknown';
  return SECTOR_NORMALIZE_MAP[rawSector] ?? rawSector;
}

/**
 * Warn once per process about sector names not in SECTOR_NORMALIZE_MAP.
 * Surfaces FMP naming changes immediately in server logs instead of
 * silently dropping stocks from sector counts / Kill scoring.
 */
const _warned = new Set();
export function warnUnknownSector(rawSector, context = '') {
  const normalized = normalizeSector(rawSector);
  if (!KNOWN_SECTORS.has(normalized) && normalized !== 'Unknown') {
    const key = `${rawSector}|${context}`;
    if (!_warned.has(key)) {
      _warned.add(key);
      console.warn(
        `[SECTOR] Unknown sector name: "${rawSector}" → "${normalized}"${context ? ` (${context})` : ''}. ` +
        'Add to SECTOR_NORMALIZE_MAP in server/sectorUtils.js.'
      );
    }
  }
}
