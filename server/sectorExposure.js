/**
 * PNTHR Risk Advisor v2 — Net Directional Sector Concentration (Advisory)
 *
 * Net Exposure = |longs - shorts| per sector.
 *
 * Fund policy: NO hard sector concentration cap — manager discretion governs.
 * This module surfaces ADVISORY information only. It does not enforce.
 *
 * Levels (informational):
 *   0–2  → CLEAR       (routine)
 *   3    → ELEVATED    (worth reviewing)
 *   4+   → HEIGHTENED  (noticeable concentration — manager awareness)
 *
 * ETFs are exempt — they are the diversification layer.
 */

import { normalizeSector } from './sectorUtils.js';

/**
 * Calculate net directional exposure per sector for a set of positions.
 *
 * @param {Array} positions - portfolio positions with { ticker, sector, direction, isETF, status }
 * @returns {Object} sectorExposure map keyed by canonical sector name
 */
export function calculateSectorExposure(positions) {
  const sectors = {};

  for (const p of positions) {
    // ETFs are exempt from sector concentration
    if (p.isETF) continue;
    // Only count ACTIVE and PARTIAL positions (not CLOSED)
    if (p.status !== 'ACTIVE' && p.status !== 'PARTIAL') continue;

    const sector = normalizeSector(p.sector || 'Unknown');
    if (!sectors[sector]) {
      sectors[sector] = {
        longs:       [],
        shorts:      [],
        longCount:   0,
        shortCount:  0,
        totalCount:  0,
        netExposure: 0,
        netDirection: null,
        level:       'CLEAR',
      };
    }

    const dir = (p.direction || '').toUpperCase();
    if (dir === 'LONG') {
      sectors[sector].longs.push(p.ticker);
      sectors[sector].longCount++;
    } else {
      sectors[sector].shorts.push(p.ticker);
      sectors[sector].shortCount++;
    }
    sectors[sector].totalCount++;
  }

  // Calculate net exposure and level for each sector (advisory labels).
  for (const data of Object.values(sectors)) {
    data.netExposure  = Math.abs(data.longCount - data.shortCount);
    data.netDirection = data.longCount >= data.shortCount ? 'LONG' : 'SHORT';

    if (data.netExposure >= 4) {
      data.level = 'HEIGHTENED';
    } else if (data.netExposure === 3) {
      data.level = 'ELEVATED';
    } else {
      data.level = 'CLEAR';
    }
  }

  return sectors;
}

/**
 * Generate Risk Advisor informational recommendations for sector concentration.
 * All options are ADVISORY — no enforcement. Manager discretion governs.
 *
 * @param {Object} sectorExposure - output from calculateSectorExposure()
 * @param {Object} killMap        - Kill scores keyed by ticker (from pnthr_kill_scores)
 * @returns {Array} recommendations sorted by priority (HEIGHTENED first)
 */
export function generateSectorRecommendations(sectorExposure, killMap = {}) {
  const recommendations = [];

  for (const [sector, data] of Object.entries(sectorExposure)) {
    if (data.level === 'CLEAR') continue;

    const rec = {
      sector,
      level:        data.level,
      longCount:    data.longCount,
      shortCount:   data.shortCount,
      totalCount:   data.totalCount,
      netExposure:  data.netExposure,
      netDirection: data.netDirection,
      options:      [],
    };

    const oppositeSignal = data.netDirection === 'LONG' ? 'SS' : 'BL';
    const oppositeLabel  = data.netDirection === 'LONG' ? 'short' : 'long';

    // Heavy-side ticker list — shown as context for manager review.
    const heavyTickers = data.netDirection === 'LONG' ? data.longs : data.shorts;
    const rankedHeavy  = heavyTickers
      .map(t => ({
        ticker:    t,
        killScore: killMap[t]?.totalScore ?? 0,
        killRank:  killMap[t]?.killRank   ?? 999,
      }))
      .sort((a, b) => a.killScore - b.killScore); // weakest first (informational)

    // ADVISORY: concentration summary + optional weakest-by-Kill for manager reference
    rec.options.push({
      type:    'ADVISORY',
      action:  `${sector} net ${data.netDirection.toLowerCase()} exposure at ${data.netExposure}. Manager discretion on new additions.`,
      detail:  rankedHeavy.length > 0
        ? `Weakest in direction by Kill score: ${rankedHeavy.slice(0, Math.min(3, rankedHeavy.length)).map(r => `${r.ticker} (score: ${Math.round(r.killScore)})`).join(', ')}`
        : 'No positions on the heavy side.',
      tickers: rankedHeavy.slice(0, Math.min(3, rankedHeavy.length)).map(r => r.ticker),
    });

    // ADVISORY: opposite-direction candidates for awareness (no prescription)
    const candidateCount = Math.max(3, data.netExposure);
    const sectorCandidates = Object.values(killMap)
      .filter(s =>
        normalizeSector(s.sector) === sector &&
        s.signal === oppositeSignal &&
        !data.longs.includes(s.ticker) &&
        !data.shorts.includes(s.ticker)
      )
      .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
      .slice(0, candidateCount);

    if (sectorCandidates.length > 0) {
      rec.options.push({
        type:    'OPPOSITE_CANDIDATES',
        action:  `Available ${oppositeLabel} candidates in ${sector} (manager awareness only)`,
        detail:  `Top ${oppositeSignal} candidates:`,
        tickers: sectorCandidates.map(c => c.ticker),
        candidateDetails: sectorCandidates.map(c => ({
          ticker:    c.ticker,
          signal:    c.signal,
          killScore: Math.round(c.totalScore || 0),
          rank:      c.killRank,
          tier:      c.tier,
          signalAge: c.signalAge ?? null,
        })),
      });
    }

    recommendations.push(rec);
  }

  // HEIGHTENED first, then ELEVATED; within each level sort by highest net exposure
  recommendations.sort((a, b) => {
    if (a.level === 'HEIGHTENED' && b.level !== 'HEIGHTENED') return -1;
    if (b.level === 'HEIGHTENED' && a.level !== 'HEIGHTENED') return  1;
    return b.netExposure - a.netExposure;
  });

  return recommendations;
}
