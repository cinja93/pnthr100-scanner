// client/src/components/GrowthChart.jsx
// ── Investor Growth Chart — Backtest Returns with PPM Fee Structure ──────────
import React, { useState, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts';
import pantherHead from '../assets/panther head.png';

// ── PPM Fee Constants ────────────────────────────────────────────────────────
const MGMT_FEE_ANNUAL = 0.02; // 2% per annum
const MGMT_FEE_MONTHLY = MGMT_FEE_ANNUAL / 12;

// Performance allocation by tier (before loyalty discount)
const TIERS = {
  filet:       { label: 'Filet',       startingCapital: 100_000,   perfAlloc: 0.30, loyaltyAlloc: 0.25, color: '#ff6b6b' },
  porterhouse: { label: 'Porterhouse', startingCapital: 500_000,   perfAlloc: 0.25, loyaltyAlloc: 0.20, color: '#4ecdc4' },
  wagyu:       { label: 'Wagyu',       startingCapital: 1_000_000, perfAlloc: 0.20, loyaltyAlloc: 0.15, color: '#fcf000' },
};

// Determine tier from arbitrary amount
function getTierForAmount(amount) {
  if (amount >= 1_000_000) return { key: 'wagyu', ...TIERS.wagyu, startingCapital: amount };
  if (amount >= 500_000)   return { key: 'porterhouse', ...TIERS.porterhouse, startingCapital: amount };
  return { key: 'filet', ...TIERS.filet, startingCapital: amount };
}

// ── Fee Calculation Engine ───────────────────────────────────────────────────
function computeGrowth(monthlyReturns, hurdleRates, tier, yearFilter) {
  const { startingCapital, perfAlloc, loyaltyAlloc } = tier;

  // Filter months for the requested year(s)
  const months = yearFilter === 'all'
    ? monthlyReturns
    : monthlyReturns.filter(m => m.month.startsWith(String(yearFilter)));

  if (!months.length) return { chartData: [], stats: {} };

  let nav = startingCapital;
  let hwm = startingCapital; // High Water Mark
  let totalMgmtFees = 0;
  let totalPerfFees = 0;
  let totalGrossReturn = 0;
  let monthsInvested = 0;
  let currentYear = null;
  let yearStartNav = nav;
  let yearHurdleRate = 0;
  let yearGrossProfit = 0;

  const chartData = [];
  const yearStats = {};

  // Add starting point
  const startMonth = months[0].month;
  chartData.push({
    month: yearFilter === 'all' ? getMonthBefore(startMonth) : `${yearFilter}-01`,
    nav: +nav.toFixed(2),
    label: '$' + formatCompact(nav),
  });

  for (const m of months) {
    const yr = parseInt(m.month.slice(0, 4));
    monthsInvested++;

    // New fiscal year — apply performance allocation for previous year
    if (currentYear !== null && yr !== currentYear) {
      const perfFee = calcPerfAllocation(yearGrossProfit, yearStartNav, hwm, yearHurdleRate, monthsInvested > 36 ? loyaltyAlloc : perfAlloc);
      nav -= perfFee;
      totalPerfFees += perfFee;
      if (nav > hwm) hwm = nav;
      yearStats[currentYear] = buildYearStats(currentYear, yearStartNav, nav, yearGrossProfit, totalMgmtFees, perfFee, yearHurdleRate, monthsInvested > 36);
      yearStartNav = nav;
      yearGrossProfit = 0;
    }
    if (currentYear !== yr) {
      currentYear = yr;
      yearHurdleRate = hurdleRates[yr] || 0;
      if (!yearStats[yr]) {
        yearStartNav = nav;
        yearGrossProfit = 0;
      }
    }

    // Each tier's trade log (pnthr_bt_pyramid_nav_{100k|500k|1m}_trade_log) records
    // dollar P&L sized to that tier's starting NAV. So the rate-of-return at month M
    // must use that same starting NAV as the running-NAV anchor — not a hardcoded
    // $100K (which only matches Filet).
    const returnRate = m.net / getRunningBacktestNav(months, m.month, startingCapital);
    const monthGross = nav * returnRate;

    totalGrossReturn += monthGross;
    yearGrossProfit += monthGross;
    nav += monthGross;

    // Monthly management fee (accrued monthly, 2% annualized)
    const mgmtFee = nav * MGMT_FEE_MONTHLY;
    nav -= mgmtFee;
    totalMgmtFees += mgmtFee;

    chartData.push({
      month: m.month,
      nav: +nav.toFixed(2),
      label: '$' + formatCompact(nav),
      grossPnl: +monthGross.toFixed(2),
      mgmtFee: +mgmtFee.toFixed(2),
      trades: m.trades,
    });
  }

  // Final year perf allocation
  if (currentYear !== null) {
    const perfFee = calcPerfAllocation(yearGrossProfit, yearStartNav, hwm, yearHurdleRate, monthsInvested > 36 ? loyaltyAlloc : perfAlloc);
    nav -= perfFee;
    totalPerfFees += perfFee;
    if (nav > hwm) hwm = nav;
    yearStats[currentYear] = buildYearStats(currentYear, yearStartNav, nav, yearGrossProfit, totalMgmtFees, perfFee, yearHurdleRate, monthsInvested > 36);
    // Update last chart point
    if (chartData.length > 0) {
      chartData[chartData.length - 1].nav = +nav.toFixed(2);
      chartData[chartData.length - 1].label = '$' + formatCompact(nav);
    }
  }

  const totalReturn = nav - startingCapital;
  const totalReturnPct = ((nav / startingCapital - 1) * 100);

  return {
    chartData,
    stats: {
      startingCapital,
      endingNav: +nav.toFixed(2),
      totalReturn: +totalReturn.toFixed(2),
      totalReturnPct: +totalReturnPct.toFixed(1),
      totalMgmtFees: +totalMgmtFees.toFixed(2),
      totalPerfFees: +totalPerfFees.toFixed(2),
      totalFees: +(totalMgmtFees + totalPerfFees).toFixed(2),
      hwm: +hwm.toFixed(2),
      yearStats,
    },
  };
}

// Running backtest NAV to compute return rates
function getRunningBacktestNav(months, upToMonth, startNav) {
  let nav = startNav;
  for (const m of months) {
    if (m.month >= upToMonth) break;
    nav += m.net;
  }
  return Math.max(nav, 1); // prevent division by zero
}

function getMonthBefore(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Performance allocation: on profits above HWM, in excess of hurdle
function calcPerfAllocation(yearGrossProfit, yearStartNav, hwm, hurdleRate, allocRate) {
  if (yearGrossProfit <= 0) return 0;
  const navBeforeFees = yearStartNav + yearGrossProfit;
  const profitAboveHwm = Math.max(0, navBeforeFees - Math.max(hwm, yearStartNav));
  if (profitAboveHwm <= 0) return 0;
  const hurdleAmount = yearStartNav * (hurdleRate / 100);
  const excessProfit = Math.max(0, profitAboveHwm - hurdleAmount);
  return excessProfit * allocRate;
}

function buildYearStats(year, startNav, endNav, grossProfit, mgmtFees, perfFee, hurdleRate, isLoyalty) {
  return {
    year,
    startNav: +startNav.toFixed(2),
    endNav: +endNav.toFixed(2),
    grossReturn: +grossProfit.toFixed(2),
    grossReturnPct: +((grossProfit / startNav) * 100).toFixed(1),
    netReturn: +(endNav - startNav).toFixed(2),
    netReturnPct: +(((endNav - startNav) / startNav) * 100).toFixed(1),
    mgmtFee: +mgmtFees.toFixed(2),
    perfFee: +perfFee.toFixed(2),
    hurdleRate,
    loyaltyApplied: isLoyalty,
  };
}

function formatCompact(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return n.toFixed(0);
}

function formatDollar(n) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatPct(n) {
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
}

// ── Custom Tooltip ───────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 6, padding: '8px 12px', fontSize: 11 }}>
      <div style={{ color: '#ccc', fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span>{p.name}:</span>
          <span style={{ fontWeight: 700 }}>{formatDollar(p.value)}</span>
        </div>
      ))}
      {d?.trades > 0 && <div style={{ color: '#666', marginTop: 4 }}>{d.trades} trades</div>}
    </div>
  );
}

// ── PNTHR logo dot for last data point ──────────────────────────────────────
function PnthrDot({ cx, cy, index, dataLength }) {
  if (index !== dataLength - 1) return null;
  return (
    <image
      href={pantherHead}
      x={cx - 12}
      y={cy - 12}
      width={24}
      height={24}
      style={{ filter: 'drop-shadow(0 0 4px rgba(252,240,0,0.6))' }}
    />
  );
}

// ── Data Box Component ───────────────────────────────────────────────────────
function DataBox({ tier, stats, yearFilter }) {
  if (!stats?.endingNav) return null;
  const ys = yearFilter !== 'all' && stats.yearStats?.[yearFilter];
  return (
    <div style={{
      background: '#141414', border: `1px solid ${tier.color}33`, borderRadius: 8,
      padding: '10px 14px', minWidth: 200, flex: 1,
    }}>
      <div style={{ color: tier.color, fontWeight: 700, fontSize: 12, marginBottom: 6 }}>
        {tier.label} — {formatDollar(tier.startingCapital)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px', fontSize: 11 }}>
        <span style={{ color: '#888' }}>Ending NAV</span>
        <span style={{ color: '#fff', fontWeight: 600, textAlign: 'right' }}>{formatDollar(stats.endingNav)}</span>
        <span style={{ color: '#888' }}>Total Return</span>
        <span style={{ color: stats.totalReturn >= 0 ? '#4ecdc4' : '#ff6b6b', fontWeight: 600, textAlign: 'right' }}>
          {formatDollar(stats.totalReturn)} ({formatPct(stats.totalReturnPct)})
        </span>
        <span style={{ color: '#888' }}>Mgmt Fees (2%)</span>
        <span style={{ color: '#ff6b6b', textAlign: 'right' }}>-{formatDollar(stats.totalMgmtFees)}</span>
        <span style={{ color: '#888' }}>Perf Alloc ({(tier.perfAlloc * 100).toFixed(0)}%)</span>
        <span style={{ color: '#ff6b6b', textAlign: 'right' }}>-{formatDollar(stats.totalPerfFees)}</span>
        <span style={{ color: '#888' }}>Total Fees</span>
        <span style={{ color: '#ff6b6b', fontWeight: 600, textAlign: 'right' }}>-{formatDollar(stats.totalFees)}</span>
        {ys && (
          <>
            <span style={{ color: '#888' }}>US2Y Hurdle</span>
            <span style={{ color: '#aaa', textAlign: 'right' }}>{ys.hurdleRate}%</span>
            {ys.loyaltyApplied && (
              <>
                <span style={{ color: '#888' }}>Loyalty</span>
                <span style={{ color: '#4ecdc4', textAlign: 'right' }}>-5% discount</span>
              </>
            )}
          </>
        )}
        <span style={{ color: '#888' }}>HWM</span>
        <span style={{ color: '#aaa', textAlign: 'right' }}>{formatDollar(stats.hwm)}</span>
      </div>
    </div>
  );
}

// ── SPY Data Box ────────────────────────────────────────────────────────────
function SpyDataBox({ spyReturnPct, startingCapital, endingNav }) {
  return (
    <div style={{
      background: '#141414', border: '1px solid #55555533', borderRadius: 8,
      padding: '10px 14px', minWidth: 200, flex: 1,
    }}>
      <div style={{ color: '#888', fontWeight: 700, fontSize: 12, marginBottom: 6 }}>
        S&P 500 — {formatDollar(startingCapital)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 12px', fontSize: 11 }}>
        <span style={{ color: '#888' }}>Ending NAV</span>
        <span style={{ color: '#fff', fontWeight: 600, textAlign: 'right' }}>{formatDollar(endingNav)}</span>
        <span style={{ color: '#888' }}>Total Return</span>
        <span style={{ color: spyReturnPct >= 0 ? '#4ecdc4' : '#ff6b6b', fontWeight: 600, textAlign: 'right' }}>
          {formatDollar(endingNav - startingCapital)} ({formatPct(spyReturnPct)})
        </span>
        <span style={{ color: '#888' }}>Expense Ratio</span>
        <span style={{ color: '#aaa', textAlign: 'right' }}>0.03% (VOO)</span>
        <span style={{ color: '#888' }}>Perf Allocation</span>
        <span style={{ color: '#aaa', textAlign: 'right' }}>None</span>
      </div>
    </div>
  );
}

// ── Year Stats Panel ─────────────────────────────────────────────────────────
function YearStatsPanel({ stats }) {
  if (!stats?.yearStats) return null;
  const years = Object.keys(stats.yearStats).sort();
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {years.map(yr => {
          const ys = stats.yearStats[yr];
          return (
            <div key={yr} style={{
              background: '#111', border: '1px solid #333', borderRadius: 6,
              padding: '8px 10px', minWidth: 140, fontSize: 10,
            }}>
              <div style={{ color: '#fcf000', fontWeight: 700, fontSize: 12, marginBottom: 4 }}>{yr}</div>
              <div style={{ color: '#888' }}>US2Y: <span style={{ color: '#fff' }}>{ys.hurdleRate}%</span></div>
              <div style={{ color: '#888' }}>Gross: <span style={{ color: ys.grossReturn >= 0 ? '#4ecdc4' : '#ff6b6b' }}>{formatDollar(ys.grossReturn)} ({formatPct(ys.grossReturnPct)})</span></div>
              <div style={{ color: '#888' }}>Net: <span style={{ color: ys.netReturn >= 0 ? '#4ecdc4' : '#ff6b6b' }}>{formatDollar(ys.netReturn)} ({formatPct(ys.netReturnPct)})</span></div>
              <div style={{ color: '#888' }}>Mgmt Fee: <span style={{ color: '#ff6b6b' }}>-{formatDollar(ys.mgmtFee)}</span></div>
              <div style={{ color: '#888' }}>Perf Fee: <span style={{ color: '#ff6b6b' }}>-{formatDollar(ys.perfFee)}</span></div>
              {ys.loyaltyApplied && <div style={{ color: '#4ecdc4' }}>Loyalty -5%</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Comparison Dropdown ─────────────────────────────────────────────────────
const COMPARE_PRESETS = [
  { label: '$100,000 (Filet)', value: 100_000 },
  { label: '$500,000 (Porterhouse)', value: 500_000 },
  { label: '$1,000,000 (Wagyu)', value: 1_000_000 },
];

function CompareDropdown({ compareAmount, onSelect }) {
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  const handlePreset = (val) => {
    onSelect(compareAmount === val ? null : val);
    setOpen(false);
    setShowCustom(false);
  };

  const handleCustomSubmit = () => {
    const raw = Number(customInput.replace(/[^0-9]/g, ''));
    if (raw >= 100_000) {
      onSelect(raw);
      setOpen(false);
      setShowCustom(false);
    }
  };

  const activeLabel = compareAmount
    ? `vs S&P 500 · ${formatDollar(compareAmount)}`
    : 'Compare vs S&P 500';

  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(!open)} style={{
        padding: '3px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
        border: compareAmount ? '1px solid #888' : '1px solid #444', borderRadius: 4,
        background: compareAmount ? '#222' : '#111', color: compareAmount ? '#fff' : '#666',
        letterSpacing: 0.3, whiteSpace: 'nowrap',
      }}>
        {activeLabel} {open ? '▴' : '▾'}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 100,
          background: '#1a1a1a', border: '1px solid #444', borderRadius: 6,
          padding: 4, minWidth: 200, boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
        }}>
          {compareAmount && (
            <div
              onClick={() => { onSelect(null); setOpen(false); setShowCustom(false); }}
              style={{
                padding: '6px 10px', fontSize: 11, color: '#ff6b6b', cursor: 'pointer',
                borderRadius: 4, fontWeight: 700,
              }}
              onMouseEnter={e => e.currentTarget.style.background = '#222'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              Clear comparison
            </div>
          )}
          {COMPARE_PRESETS.map(p => (
            <div
              key={p.value}
              onClick={() => handlePreset(p.value)}
              style={{
                padding: '6px 10px', fontSize: 11, cursor: 'pointer', borderRadius: 4,
                color: compareAmount === p.value ? '#fcf000' : '#ccc', fontWeight: compareAmount === p.value ? 700 : 400,
              }}
              onMouseEnter={e => e.currentTarget.style.background = '#222'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              {p.label}
            </div>
          ))}
          <div
            onClick={() => setShowCustom(true)}
            style={{
              padding: '6px 10px', fontSize: 11, color: '#4ecdc4', cursor: 'pointer',
              borderRadius: 4, borderTop: '1px solid #333', marginTop: 2,
            }}
            onMouseEnter={e => e.currentTarget.style.background = '#222'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            Custom amount...
          </div>
          {showCustom && (
            <div style={{ display: 'flex', gap: 4, padding: '4px 6px' }}>
              <input
                type="text"
                inputMode="numeric"
                placeholder="100,000+"
                value={customInput}
                onChange={e => setCustomInput(e.target.value.replace(/[^0-9,]/g, ''))}
                onKeyDown={e => { if (e.key === 'Enter') handleCustomSubmit(); }}
                style={{
                  flex: 1, background: '#111', border: '1px solid #444', borderRadius: 4,
                  padding: '4px 8px', color: '#fff', fontSize: 11,
                }}
                autoFocus
              />
              <button onClick={handleCustomSubmit} style={{
                background: '#4ecdc4', color: '#111', border: 'none', borderRadius: 4,
                padding: '4px 8px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
              }}>GO</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main GrowthChart Component ───────────────────────────────────────────────
export default function GrowthChart({ monthlyReturnsByTier, hurdleRates, yearFilter = 'all', showDataBoxes = true, spyGrowth, onRequestSpy }) {
  const [compareAmount, setCompareAmount] = useState(null);

  // When user selects a comparison amount, request SPY data if needed
  const handleCompareSelect = (amount) => {
    setCompareAmount(amount);
    if (amount && onRequestSpy) onRequestSpy();
  };

  // All 3 tiers computed always (for non-compare view) — each tier uses ITS OWN
  // monthly returns so the chart matches the v5 per-tier IR PDFs exactly. Driving
  // all three curves from one tier's data was the BUG-1 root cause (rate inflation
  // for non-Filet tiers).
  const results = useMemo(() => {
    if (!monthlyReturnsByTier) return null;
    const anyData = Object.values(monthlyReturnsByTier).some(arr => arr?.length);
    if (!anyData) return null;
    const out = {};
    for (const [key, tier] of Object.entries(TIERS)) {
      const tierData = monthlyReturnsByTier[key] || [];
      out[key] = computeGrowth(tierData, hurdleRates, tier, yearFilter);
    }
    return out;
  }, [monthlyReturnsByTier, hurdleRates, yearFilter]);

  // In compare mode: compute for the selected amount (may be custom). Use the
  // monthly returns for the tier that the amount maps to.
  const compareTier = useMemo(() => {
    if (!compareAmount) return null;
    return getTierForAmount(compareAmount);
  }, [compareAmount]);

  const compareResult = useMemo(() => {
    if (!compareTier || !monthlyReturnsByTier) return null;
    const tierData = monthlyReturnsByTier[compareTier.key] || [];
    if (!tierData.length) return null;
    return computeGrowth(tierData, hurdleRates, compareTier, yearFilter);
  }, [compareTier, monthlyReturnsByTier, hurdleRates, yearFilter]);

  if (!results) return <div style={{ color: '#666', padding: 20, textAlign: 'center' }}>Loading growth data...</div>;

  // Compare mode: scale SPY data to match the selected starting amount
  const spyByMonth = useMemo(() => {
    if (!compareAmount || !spyGrowth?.length) return null;
    const scale = compareAmount / 100_000;
    const map = {};
    if (yearFilter === 'all') {
      for (const s of spyGrowth) map[s.month] = +(s.nav * scale).toFixed(2);
    } else {
      const yearData = spyGrowth.filter(s => s.month.startsWith(String(yearFilter)));
      if (!yearData.length) return null;
      const allBefore = spyGrowth.filter(s => s.month < `${yearFilter}-01`);
      const baseNav = allBefore.length ? allBefore[allBefore.length - 1].nav : yearData[0].nav;
      for (const s of yearData) {
        map[s.month] = +((s.nav / baseNav) * compareAmount).toFixed(2);
      }
    }
    return map;
  }, [compareAmount, spyGrowth, yearFilter]);

  // In compare mode: 2 lines (PNTHR + SPY). Otherwise: 3 tier lines.
  const isCompareMode = compareAmount && compareResult && spyByMonth;

  const mergedData = useMemo(() => {
    const allMonths = new Set();

    if (isCompareMode) {
      for (const d of compareResult.chartData) allMonths.add(d.month);
      for (const m of Object.keys(spyByMonth)) allMonths.add(m);
    } else {
      for (const r of Object.values(results)) {
        for (const d of r.chartData) allMonths.add(d.month);
      }
    }

    return [...allMonths].sort().map(month => {
      const row = { month };
      if (isCompareMode) {
        const pt = compareResult.chartData.find(d => d.month === month);
        row.pnthr = pt?.nav || null;
        row.spy = spyByMonth[month] || null;
        row.trades = pt?.trades || 0;
      } else {
        for (const [key, r] of Object.entries(results)) {
          const pt = r.chartData.find(d => d.month === month);
          row[key] = pt?.nav || null;
        }
      }
      return row;
    });
  }, [results, compareResult, spyByMonth, isCompareMode]);

  const title = yearFilter === 'all'
    ? 'Cumulative Growth (2019\u20132026)'
    : `${yearFilter} Growth`;

  // SPY stats for annotation
  const spyStats = useMemo(() => {
    if (!spyByMonth || !compareAmount) return null;
    const vals = Object.values(spyByMonth);
    if (!vals.length) return null;
    const endNav = vals[vals.length - 1];
    const returnPct = +((endNav / compareAmount - 1) * 100).toFixed(1);
    return { endNav, returnPct };
  }, [spyByMonth, compareAmount]);

  const dataLength = mergedData.length;

  return (
    <div style={{ background: '#0d0d0d', border: '1px solid #222', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 style={{ color: '#fcf000', fontSize: 15, fontWeight: 700, margin: 0 }}>{title}</h3>
          <CompareDropdown compareAmount={compareAmount} onSelect={handleCompareSelect} />
        </div>
        <span style={{ color: '#666', fontSize: 10 }}>Net of 2% mgmt fee + performance allocation + US2Y hurdle + HWM</span>
      </div>

      <ResponsiveContainer width="100%" height={340}>
        <LineChart data={mergedData} margin={{ top: 10, right: 30, left: 10, bottom: 5 }}>
          <CartesianGrid stroke="#222" strokeDasharray="3 3" />
          <XAxis
            dataKey="month"
            tick={{ fill: '#666', fontSize: 10 }}
            interval="preserveStartEnd"
            tickFormatter={v => {
              const [y, m] = v.split('-');
              return m === '01' ? y : ['', 'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m];
            }}
          />
          <YAxis
            tick={{ fill: '#666', fontSize: 10 }}
            tickFormatter={v => '$' + formatCompact(v)}
            domain={['auto', 'auto']}
          />
          <Tooltip content={<ChartTooltip />} />
          <Legend
            wrapperStyle={{ fontSize: 11, color: '#aaa' }}
            formatter={(value) => {
              if (value === 'spy') return `S&P 500 (${formatDollar(compareAmount)}, net 0.03% ER)`;
              if (value === 'pnthr') return `PNTHR Fund (${formatDollar(compareAmount)})`;
              return TIERS[value]?.label || value;
            }}
          />

          {isCompareMode ? (
            <>
              <Line
                type="monotone"
                dataKey="pnthr"
                name="pnthr"
                stroke={compareTier.color}
                strokeWidth={2.5}
                dot={<PnthrDot dataLength={dataLength} />}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="spy"
                name="spy"
                stroke="#888"
                strokeWidth={1.5}
                strokeDasharray="6 3"
                dot={false}
                connectNulls
              />
            </>
          ) : (
            Object.entries(TIERS).map(([key, tier]) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                name={key}
                stroke={tier.color}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            ))
          )}
        </LineChart>
      </ResponsiveContainer>

      {/* Data boxes — compare mode: PNTHR + SPY side by side */}
      {showDataBoxes && isCompareMode && compareResult?.stats && spyStats && (
        <>
          <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
            <DataBox tier={compareTier} stats={compareResult.stats} yearFilter={yearFilter} />
            <SpyDataBox
              spyReturnPct={spyStats.returnPct}
              startingCapital={compareAmount}
              endingNav={spyStats.endNav}
            />
          </div>
          {/* Alpha annotation */}
          <div style={{
            background: '#141414', border: '1px solid #333', borderRadius: 8,
            padding: '10px 16px', marginTop: 12, display: 'flex', gap: 24,
            alignItems: 'center', flexWrap: 'wrap', fontSize: 12,
          }}>
            <div>
              <span style={{ color: '#888' }}>PNTHR ({compareTier.label}): </span>
              <span style={{ color: compareResult.stats.totalReturnPct >= 0 ? '#4ecdc4' : '#ff6b6b', fontWeight: 700 }}>
                {formatPct(compareResult.stats.totalReturnPct)}
              </span>
            </div>
            <div>
              <span style={{ color: '#888' }}>S&P 500: </span>
              <span style={{ color: spyStats.returnPct >= 0 ? '#4ecdc4' : '#ff6b6b', fontWeight: 700 }}>
                {formatPct(spyStats.returnPct)}
              </span>
            </div>
            <div>
              <span style={{ color: '#888' }}>Alpha: </span>
              <span style={{
                color: (compareResult.stats.totalReturnPct - spyStats.returnPct) >= 0 ? '#4ecdc4' : '#ff6b6b',
                fontWeight: 800, fontSize: 14,
              }}>
                {formatPct(+(compareResult.stats.totalReturnPct - spyStats.returnPct).toFixed(1))}
              </span>
            </div>
          </div>
        </>
      )}

      {/* Data boxes — normal 3-tier view */}
      {showDataBoxes && !isCompareMode && (
        <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          {Object.entries(TIERS).map(([key, tier]) => (
            <DataBox key={key} tier={tier} stats={results[key]?.stats} yearFilter={yearFilter} />
          ))}
        </div>
      )}

      {/* Year-by-year stats for cumulative view (non-compare) */}
      {yearFilter === 'all' && !isCompareMode && (
        <div style={{ marginTop: 16 }}>
          <div style={{ color: '#888', fontSize: 11, fontWeight: 700, marginBottom: 6 }}>YEAR-BY-YEAR BREAKDOWN (Wagyu)</div>
          <YearStatsPanel stats={results.wagyu?.stats} />
        </div>
      )}

      {/* Year-by-year stats for compare mode */}
      {yearFilter === 'all' && isCompareMode && compareResult?.stats && (
        <div style={{ marginTop: 16 }}>
          <div style={{ color: '#888', fontSize: 11, fontWeight: 700, marginBottom: 6 }}>YEAR-BY-YEAR BREAKDOWN ({compareTier.label})</div>
          <YearStatsPanel stats={compareResult.stats} />
        </div>
      )}
    </div>
  );
}

export { TIERS };
