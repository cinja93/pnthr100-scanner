// client/src/components/GrowthChart.jsx
// ── Investor Growth Chart — Backtest Returns with PPM Fee Structure ──────────
import React, { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine
} from 'recharts';

// ── PPM Fee Constants ────────────────────────────────────────────────────────
const MGMT_FEE_ANNUAL = 0.02; // 2% per annum
const MGMT_FEE_MONTHLY = MGMT_FEE_ANNUAL / 12;

// Performance allocation by tier (before loyalty discount)
const TIERS = {
  filet:       { label: 'Filet',       startingCapital: 100_000,   perfAlloc: 0.30, loyaltyAlloc: 0.25, color: '#ff6b6b' },
  porterhouse: { label: 'Porterhouse', startingCapital: 500_000,   perfAlloc: 0.25, loyaltyAlloc: 0.20, color: '#4ecdc4' },
  wagyu:       { label: 'Wagyu',       startingCapital: 1_000_000, perfAlloc: 0.20, loyaltyAlloc: 0.15, color: '#fcf000' },
};

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

    // Gross return for this month (scaled proportionally to account size)
    // The backtest ran on $100K — scale returns to this tier's starting capital
    const scaleFactor = nav / (startingCapital === 100_000 ? 100_000 : getScaledBase(months, m.month, startingCapital));
    const grossPnl = m.net * (startingCapital / 100_000);
    // Actually: since we're tracking NAV growth, use the return RATE from the backtest
    // Monthly return rate = backtest net P&L / backtest NAV at that point
    // Simpler approach: track cumulative backtest NAV and derive return rate
    const returnRate = m.net / getRunningBacktestNav(months, m.month, 100_000);
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

function getScaledBase() { return 100_000; }

function getMonthBefore(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Performance allocation: on profits above HWM, in excess of hurdle
function calcPerfAllocation(yearGrossProfit, yearStartNav, hwm, hurdleRate, allocRate) {
  if (yearGrossProfit <= 0) return 0;
  // Only on profits above HWM
  const navBeforeFees = yearStartNav + yearGrossProfit;
  const profitAboveHwm = Math.max(0, navBeforeFees - Math.max(hwm, yearStartNav));
  if (profitAboveHwm <= 0) return 0;
  // Subtract hurdle (hurdle = hurdleRate% of starting NAV)
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

// ── Data Box Component ───────────────────────────────────────────────────────
function DataBox({ tierKey, tier, stats, yearFilter }) {
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

// ── Year Stats Panel ─────────────────────────────────────────────────────────
function YearStatsPanel({ stats, hurdleRates, tierKey }) {
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

// ── Main GrowthChart Component ───────────────────────────────────────────────
export default function GrowthChart({ monthlyReturns, hurdleRates, yearFilter = 'all', showDataBoxes = true, showSpy = false, onToggleSpy, spyGrowth }) {
  const results = useMemo(() => {
    if (!monthlyReturns?.length) return null;
    const out = {};
    for (const [key, tier] of Object.entries(TIERS)) {
      out[key] = computeGrowth(monthlyReturns, hurdleRates, tier, yearFilter);
    }
    return out;
  }, [monthlyReturns, hurdleRates, yearFilter]);

  if (!results) return <div style={{ color: '#666', padding: 20, textAlign: 'center' }}>Loading growth data...</div>;

  // Prepare SPY data for current view (rebase for single-year views)
  const spyByMonth = useMemo(() => {
    if (!showSpy || !spyGrowth?.length) return null;
    const map = {};
    if (yearFilter === 'all') {
      for (const s of spyGrowth) map[s.month] = s.nav;
    } else {
      // Rebase to $100K at start of year
      const yearData = spyGrowth.filter(s => s.month.startsWith(String(yearFilter)));
      if (!yearData.length) return null;
      // Find the NAV right before this year to use as base
      const allBefore = spyGrowth.filter(s => s.month < `${yearFilter}-01`);
      const baseNav = allBefore.length ? allBefore[allBefore.length - 1].nav : yearData[0].nav;
      for (const s of yearData) {
        map[s.month] = +((s.nav / baseNav) * 100_000).toFixed(2);
      }
    }
    return map;
  }, [showSpy, spyGrowth, yearFilter]);

  // Merge chart data across tiers
  const mergedData = useMemo(() => {
    const allMonths = new Set();
    for (const r of Object.values(results)) {
      for (const d of r.chartData) allMonths.add(d.month);
    }
    if (spyByMonth) {
      for (const m of Object.keys(spyByMonth)) allMonths.add(m);
    }
    return [...allMonths].sort().map(month => {
      const row = { month };
      for (const [key, r] of Object.entries(results)) {
        const pt = r.chartData.find(d => d.month === month);
        row[key] = pt?.nav || null;
      }
      if (spyByMonth) row.spy = spyByMonth[month] || null;
      return row;
    });
  }, [results, spyByMonth]);

  const title = yearFilter === 'all'
    ? 'Cumulative Growth (2019–2026)'
    : `${yearFilter} Growth`;

  return (
    <div style={{ background: '#0d0d0d', border: '1px solid #222', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 style={{ color: '#fcf000', fontSize: 15, fontWeight: 700, margin: 0 }}>{title}</h3>
          {onToggleSpy && (
            <button onClick={onToggleSpy} style={{
              padding: '3px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
              border: showSpy ? '1px solid #888' : '1px solid #444', borderRadius: 4,
              background: showSpy ? '#222' : '#111', color: showSpy ? '#fff' : '#666',
              letterSpacing: 0.3,
            }}>vs S&P 500</button>
          )}
        </div>
        <span style={{ color: '#666', fontSize: 10 }}>Net of 2% mgmt fee + performance allocation + US2Y hurdle + HWM</span>
      </div>

      <ResponsiveContainer width="100%" height={340}>
        <LineChart data={mergedData} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
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
              if (value === 'spy') return 'S&P 500 ($100K, net 0.03% ER)';
              return TIERS[value]?.label || value;
            }}
          />
          {Object.entries(TIERS).map(([key, tier]) => (
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
          ))}
          {showSpy && spyByMonth && (
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
          )}
        </LineChart>
      </ResponsiveContainer>

      {/* Data boxes */}
      {showDataBoxes && (
        <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          {Object.entries(TIERS).map(([key, tier]) => (
            <DataBox key={key} tierKey={key} tier={tier} stats={results[key]?.stats} yearFilter={yearFilter} />
          ))}
        </div>
      )}

      {/* SPY comparison annotation */}
      {showSpy && spyByMonth && results.filet?.stats?.totalReturnPct != null && (() => {
        const spyVals = Object.values(spyByMonth);
        if (!spyVals.length) return null;
        const spyEnd = spyVals[spyVals.length - 1];
        const spyReturnPct = +((spyEnd / 100_000 - 1) * 100).toFixed(1);
        const filetPct = results.filet.stats.totalReturnPct;
        const alpha = +(filetPct - spyReturnPct).toFixed(1);
        return (
          <div style={{
            background: '#141414', border: '1px solid #333', borderRadius: 8,
            padding: '10px 16px', marginTop: 12, display: 'flex', gap: 24,
            alignItems: 'center', flexWrap: 'wrap', fontSize: 12,
          }}>
            <div>
              <span style={{ color: '#888' }}>PNTHR Filet ($100K): </span>
              <span style={{ color: filetPct >= 0 ? '#4ecdc4' : '#ff6b6b', fontWeight: 700 }}>{formatPct(filetPct)}</span>
            </div>
            <div>
              <span style={{ color: '#888' }}>S&P 500 ($100K): </span>
              <span style={{ color: spyReturnPct >= 0 ? '#4ecdc4' : '#ff6b6b', fontWeight: 700 }}>{formatPct(spyReturnPct)}</span>
            </div>
            <div>
              <span style={{ color: '#888' }}>Alpha: </span>
              <span style={{ color: alpha >= 0 ? '#4ecdc4' : '#ff6b6b', fontWeight: 800, fontSize: 14 }}>{formatPct(alpha)}</span>
            </div>
          </div>
        );
      })()}

      {/* Year-by-year stats for cumulative view */}
      {yearFilter === 'all' && (
        <div style={{ marginTop: 16 }}>
          <div style={{ color: '#888', fontSize: 11, fontWeight: 700, marginBottom: 6 }}>YEAR-BY-YEAR BREAKDOWN (Wagyu)</div>
          <YearStatsPanel stats={results.wagyu?.stats} hurdleRates={hurdleRates} tierKey="wagyu" />
        </div>
      )}
    </div>
  );
}

export { TIERS };
