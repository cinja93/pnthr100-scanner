/**
 * PNTHR Risk Advisor v2 — Net Directional Exposure Model
 *
 * Replaces the blunt "max 3 per sector" count rule with a net directional
 * exposure model that recognizes long/short positions partially offset each other.
 *
 * Net Exposure = |longs - shorts|
 *
 * Levels:
 *   0–2  → CLEAR    (no warning)
 *   3    → AT_LIMIT (yellow)
 *   4+   → CRITICAL (red)
 *
 * ETFs are exempt — they ARE the diversification.
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

  // Calculate net exposure and level for each sector
  for (const data of Object.values(sectors)) {
    data.netExposure  = Math.abs(data.longCount - data.shortCount);
    data.netDirection = data.longCount >= data.shortCount ? 'LONG' : 'SHORT';

    if (data.netExposure >= 4) {
      data.level = 'CRITICAL';
    } else if (data.netExposure === 3) {
      data.level = 'AT_LIMIT';
    } else {
      data.level = 'CLEAR';
    }
  }

  return sectors;
}

/**
 * Generate Risk Advisor recommendations for sector concentration.
 *
 * @param {Object} sectorExposure - output from calculateSectorExposure()
 * @param {Object} killMap        - Kill scores keyed by ticker (from pnthr_kill_scores)
 * @returns {Array} recommendations sorted by priority (CRITICAL first)
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

    const excess         = data.netExposure - 2; // positions needed to reach net 2
    const oppositeSignal = data.netDirection === 'LONG' ? 'SS' : 'BL';
    const oppositeLabel  = data.netDirection === 'LONG' ? 'short' : 'long';

    // Option A: Close weakest positions in the net-heavy direction
    const heavyTickers = data.netDirection === 'LONG' ? data.longs : data.shorts;
    const rankedHeavy  = heavyTickers
      .map(t => ({
        ticker:    t,
        killScore: killMap[t]?.totalScore ?? 0,
        killRank:  killMap[t]?.killRank   ?? 999,
      }))
      .sort((a, b) => a.killScore - b.killScore); // weakest first

    rec.options.push({
      type:    'CLOSE',
      action:  `Close ${excess} ${data.netDirection.toLowerCase()} position${excess > 1 ? 's' : ''} to reduce net exposure to 2`,
      detail:  `Weakest by Kill score: ${rankedHeavy.slice(0, excess).map(r => `${r.ticker} (score: ${Math.round(r.killScore)})`).join(', ')}`,
      tickers: rankedHeavy.slice(0, excess).map(r => r.ticker),
    });

    // Option B: Add opposite-direction positions to balance
    const sectorCandidates = Object.values(killMap)
      .filter(s =>
        normalizeSector(s.sector) === sector &&
        s.signal === oppositeSignal &&
        !data.longs.includes(s.ticker) &&
        !data.shorts.includes(s.ticker)
      )
      .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
      .slice(0, 3);

    if (sectorCandidates.length > 0) {
      rec.options.push({
        type:    'BALANCE',
        action:  `Add ${excess} ${oppositeLabel} position${excess > 1 ? 's' : ''} in ${sector} to balance exposure`,
        detail:  `Top ${oppositeSignal} candidates:`,
        tickers: sectorCandidates.map(c => c.ticker),
        candidateDetails: sectorCandidates.map(c => ({
          ticker:    c.ticker,
          signal:    c.signal,
          killScore: Math.round(c.totalScore || 0),
          rank:      c.killRank,
          tier:      c.tier,
        })),
      });
    }

    // Option C: AT_LIMIT — hold guidance
    if (data.level === 'AT_LIMIT') {
      rec.options.push({
        type:    'HOLD',
        action:  `At limit. No new ${data.netDirection.toLowerCase()} positions in ${sector} unless balanced with a ${oppositeLabel}`,
        detail:  `Current: ${data.longCount}L / ${data.shortCount}S = net ${data.netExposure} ${data.netDirection.toLowerCase()}`,
        tickers: [],
      });
    }

    recommendations.push(rec);
  }

  // CRITICAL first, then AT_LIMIT; within each level sort by highest net exposure
  recommendations.sort((a, b) => {
    if (a.level === 'CRITICAL' && b.level !== 'CRITICAL') return -1;
    if (b.level === 'CRITICAL' && a.level !== 'CRITICAL') return  1;
    return b.netExposure - a.netExposure;
  });

  return recommendations;
}
