// client/src/components/RiskSummaryBar.jsx
// Shared risk summary bar — single source of truth for the heat-math display.
// Used at the bottom of PNTHR Assistant and inside PNTHR Command.
//
// Two input modes:
//   • precomputed={pulsePositionsBlock}  — server-computed (used by Assistant)
//                                          shape: { total, long, short, recycled,
//                                                   heat: { stockRisk, etfRisk,
//                                                   totalRisk, stockRiskPct,
//                                                   etfRiskPct, totalRiskPct }, nav }
//   • positions={array} + nav={number}   — client-computes via calcHeat
//                                          (used by Command Center, which has
//                                          local-state positions)
// If both are passed, precomputed wins.

import { calcHeat } from '../utils/sizingUtils.js';

function MC({ label, value, sub, sub2, accent }) {
  const valLen = typeof value === 'string' ? value.length : 0;
  const valSize = valLen > 14 ? 15 : valLen > 10 ? 18 : 22;
  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '12px 14px',
      border: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ fontSize: 10, color: '#777', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: valSize, fontWeight: 700, color: accent || '#e8e6e3', marginTop: 2, fontFamily: 'monospace' }}>{value}</div>
      {sub  && <div style={{ fontSize: 10, color: '#555', marginTop: 2 }}>{sub}</div>}
      {sub2 && <div style={{ fontSize: 10, color: '#888', marginTop: 1 }}>{sub2}</div>}
    </div>
  );
}

export default function RiskSummaryBar({
  positions = [],
  nav = 0,
  isDemo = false,
  portfolioEquity = null,
  precomputed = null,
}) {
  // Resolve heat + counts + nav from whichever input was provided.
  let heat, totalPos, recycledCnt, liveCnt, navNum;
  if (precomputed && precomputed.heat) {
    heat = {
      stockRisk:    +(+precomputed.heat.stockRisk    || 0).toFixed(0),
      etfRisk:      +(+precomputed.heat.etfRisk      || 0).toFixed(0),
      totalRisk:    +(+precomputed.heat.totalRisk    || 0).toFixed(0),
      stockRiskPct: +(+precomputed.heat.stockRiskPct || 0),
      etfRiskPct:   +(+precomputed.heat.etfRiskPct   || 0),
      totalRiskPct: +(+precomputed.heat.totalRiskPct || 0),
    };
    totalPos    = +precomputed.total    || 0;
    recycledCnt = +precomputed.recycled || 0;
    liveCnt     = totalPos - recycledCnt;
    navNum      = +precomputed.nav || +nav || 0;
  } else {
    const h = calcHeat(positions || [], +nav || 0);
    heat        = h;
    totalPos    = h.totalPos;
    recycledCnt = h.recycledCnt;
    liveCnt     = h.liveCnt;
    navNum      = +nav || 0;
  }

  const cols = isDemo && portfolioEquity != null ? 7 : 6;
  const navDisplay = isDemo
    ? `$${navNum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${Math.round(navNum / 1000).toLocaleString()}K`;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 10, marginBottom: 16 }}>
      {isDemo && portfolioEquity != null && (
        <MC label="Portfolio equity"
          value={`$${portfolioEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          sub={`${portfolioEquity >= navNum ? '+' : ''}$${(portfolioEquity - navNum).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} unrealized`}
          accent={portfolioEquity >= navNum ? '#28a745' : '#dc3545'} />
      )}
      <MC label="Net liquidity" value={navDisplay} />
      <MC label="Stock risk"
        value={`$${heat.stockRisk.toLocaleString()}`}
        sub={`${heat.stockRiskPct}% of NAV`}
        sub2="Cap: 10%"
        accent={heat.stockRiskPct > 10 ? '#dc3545' : heat.stockRiskPct > 8 ? '#ffc107' : '#28a745'} />
      <MC label="ETF risk"
        value={`$${heat.etfRisk.toLocaleString()}`}
        sub={`${heat.etfRiskPct}% of NAV`}
        sub2="Cap: 5%"
        accent={heat.etfRiskPct > 5 ? '#dc3545' : heat.etfRiskPct > 4 ? '#ffc107' : '#28a745'} />
      <MC label="Total risk"
        value={`$${heat.totalRisk.toLocaleString()}`}
        sub={`${heat.totalRiskPct}% of NAV`}
        sub2="Cap: 15%"
        accent={heat.totalRiskPct > 15 ? '#dc3545' : heat.totalRiskPct > 12 ? '#ffc107' : '#28a745'} />
      <MC label="Recycled" value={recycledCnt} sub="$0 risk" accent="#28a745" />
      <MC label="Total positions" value={totalPos} sub={`${liveCnt} live · ${recycledCnt} recycled`} />
    </div>
  );
}
