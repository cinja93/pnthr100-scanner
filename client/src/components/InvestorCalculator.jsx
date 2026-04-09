// client/src/components/InvestorCalculator.jsx
// ── Investor Return Calculator Modal ─────────────────────────────────────────
import React, { useState, useMemo } from 'react';

const MGMT_FEE_ANNUAL = 0.02;
const MGMT_FEE_MONTHLY = MGMT_FEE_ANNUAL / 12;

const TIER_DEFS = {
  wagyu:       { label: 'Wagyu',       min: 1_000_000, perfAlloc: 0.20, loyaltyAlloc: 0.15, color: '#fcf000' },
  porterhouse: { label: 'Porterhouse', min: 500_000,   perfAlloc: 0.25, loyaltyAlloc: 0.20, color: '#4ecdc4' },
  filet:       { label: 'Filet',       min: 100_000,   perfAlloc: 0.30, loyaltyAlloc: 0.25, color: '#ff6b6b' },
};

function getTier(amount) {
  if (amount >= 1_000_000) return TIER_DEFS.wagyu;
  if (amount >= 500_000) return TIER_DEFS.porterhouse;
  return TIER_DEFS.filet;
}

function formatDollar(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

function formatPct(n) {
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
}

export default function InvestorCalculator({ monthlyReturns, hurdleRates, onClose }) {
  const [investmentAmount, setInvestmentAmount] = useState(100_000);
  const [startMonth, setStartMonth] = useState('');
  const [endMonth, setEndMonth] = useState('');

  // Available months from backtest data
  const availableMonths = useMemo(() => {
    if (!monthlyReturns?.length) return [];
    return monthlyReturns.map(m => m.month);
  }, [monthlyReturns]);

  // Set defaults once data loads
  useMemo(() => {
    if (availableMonths.length && !startMonth) {
      setStartMonth(availableMonths[0]);
      setEndMonth(availableMonths[availableMonths.length - 1]);
    }
  }, [availableMonths, startMonth]);

  const result = useMemo(() => {
    if (!monthlyReturns?.length || !startMonth || !endMonth || investmentAmount < 100_000) return null;

    const tier = getTier(investmentAmount);
    const months = monthlyReturns.filter(m => m.month >= startMonth && m.month <= endMonth);
    if (!months.length) return null;

    let nav = investmentAmount;
    let hwm = investmentAmount;
    let totalMgmtFees = 0;
    let totalPerfFees = 0;
    let monthsInvested = 0;
    let currentYear = null;
    let yearStartNav = nav;
    let yearGrossProfit = 0;
    let yearHurdleRate = 0;
    // Track running backtest NAV for return rate calculation
    let backtestNav = 100_000;

    const monthlyBreakdown = [];

    for (const m of months) {
      const yr = parseInt(m.month.slice(0, 4));
      monthsInvested++;

      // Year boundary — apply performance allocation
      if (currentYear !== null && yr !== currentYear) {
        const allocRate = monthsInvested > 36 ? tier.loyaltyAlloc : tier.perfAlloc;
        const perfFee = calcPerfAllocation(yearGrossProfit, yearStartNav, hwm, yearHurdleRate, allocRate);
        nav -= perfFee;
        totalPerfFees += perfFee;
        if (nav > hwm) hwm = nav;
        yearStartNav = nav;
        yearGrossProfit = 0;
      }
      if (currentYear !== yr) {
        currentYear = yr;
        yearHurdleRate = hurdleRates[yr] || 0;
      }

      // Return rate from backtest
      const returnRate = m.net / Math.max(backtestNav, 1);
      backtestNav += m.net;

      const grossPnl = nav * returnRate;
      yearGrossProfit += grossPnl;
      nav += grossPnl;

      // Management fee
      const mgmtFee = nav * MGMT_FEE_MONTHLY;
      nav -= mgmtFee;
      totalMgmtFees += mgmtFee;

      monthlyBreakdown.push({
        month: m.month,
        nav: +nav.toFixed(2),
        grossPnl: +grossPnl.toFixed(2),
        mgmtFee: +mgmtFee.toFixed(2),
        trades: m.trades,
      });
    }

    // Final year perf allocation
    if (currentYear !== null) {
      const allocRate = monthsInvested > 36 ? tier.loyaltyAlloc : tier.perfAlloc;
      const perfFee = calcPerfAllocation(yearGrossProfit, yearStartNav, hwm, yearHurdleRate, allocRate);
      nav -= perfFee;
      totalPerfFees += perfFee;
      if (nav > hwm) hwm = nav;
    }

    const totalReturn = nav - investmentAmount;
    const totalReturnPct = ((nav / investmentAmount - 1) * 100);
    const annualizedReturn = months.length > 0
      ? (Math.pow(nav / investmentAmount, 12 / months.length) - 1) * 100
      : 0;

    return {
      tier,
      endingNav: +nav.toFixed(2),
      totalReturn: +totalReturn.toFixed(2),
      totalReturnPct: +totalReturnPct.toFixed(1),
      annualizedReturn: +annualizedReturn.toFixed(1),
      totalMgmtFees: +totalMgmtFees.toFixed(2),
      totalPerfFees: +totalPerfFees.toFixed(2),
      totalFees: +(totalMgmtFees + totalPerfFees).toFixed(2),
      hwm: +hwm.toFixed(2),
      months: months.length,
      monthlyBreakdown,
    };
  }, [monthlyReturns, hurdleRates, investmentAmount, startMonth, endMonth]);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: '#111', border: '1px solid #333', borderRadius: 12, padding: '24px 28px',
        maxWidth: 560, width: '90%', maxHeight: '85vh', overflowY: 'auto',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ color: '#fcf000', fontSize: 16, fontWeight: 700, margin: 0 }}>Investor Return Calculator</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>

        {/* Inputs */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
          <div>
            <label style={{ color: '#888', fontSize: 10, fontWeight: 700, display: 'block', marginBottom: 4 }}>INVESTMENT AMOUNT</label>
            <input
              type="number"
              value={investmentAmount}
              onChange={e => setInvestmentAmount(Number(e.target.value))}
              min={100000}
              step={50000}
              style={{
                width: '100%', background: '#1a1a1a', border: '1px solid #333', borderRadius: 6,
                padding: '8px 10px', color: '#fff', fontSize: 13, fontWeight: 600,
              }}
            />
            <div style={{ color: '#555', fontSize: 9, marginTop: 2 }}>Min $100,000</div>
          </div>
          <div>
            <label style={{ color: '#888', fontSize: 10, fontWeight: 700, display: 'block', marginBottom: 4 }}>START DATE</label>
            <select
              value={startMonth}
              onChange={e => setStartMonth(e.target.value)}
              style={{
                width: '100%', background: '#1a1a1a', border: '1px solid #333', borderRadius: 6,
                padding: '8px 10px', color: '#fff', fontSize: 12,
              }}
            >
              {availableMonths.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label style={{ color: '#888', fontSize: 10, fontWeight: 700, display: 'block', marginBottom: 4 }}>END DATE</label>
            <select
              value={endMonth}
              onChange={e => setEndMonth(e.target.value)}
              style={{
                width: '100%', background: '#1a1a1a', border: '1px solid #333', borderRadius: 6,
                padding: '8px 10px', color: '#fff', fontSize: 12,
              }}
            >
              {availableMonths.filter(m => m >= startMonth).map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>

        {/* Tier badge */}
        {result && (
          <div style={{
            background: `${result.tier.color}15`, border: `1px solid ${result.tier.color}44`,
            borderRadius: 6, padding: '6px 12px', marginBottom: 16, fontSize: 11, textAlign: 'center',
          }}>
            <span style={{ color: result.tier.color, fontWeight: 700 }}>{result.tier.label} Class</span>
            <span style={{ color: '#888', marginLeft: 8 }}>
              Perf Allocation: {(result.tier.perfAlloc * 100).toFixed(0)}%
              {result.months > 36 && ` → ${(result.tier.loyaltyAlloc * 100).toFixed(0)}% (loyalty)`}
            </span>
          </div>
        )}

        {/* Results */}
        {result && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 20px', fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#888' }}>Starting Investment</span>
                <span style={{ color: '#fff', fontWeight: 700 }}>{formatDollar(investmentAmount)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#888' }}>Period</span>
                <span style={{ color: '#aaa' }}>{result.months} months</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#888' }}>Ending NAV</span>
                <span style={{ color: '#fcf000', fontWeight: 700, fontSize: 14 }}>{formatDollar(result.endingNav)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#888' }}>Annualized Return</span>
                <span style={{ color: result.annualizedReturn >= 0 ? '#4ecdc4' : '#ff6b6b', fontWeight: 700 }}>{formatPct(result.annualizedReturn)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#888' }}>Total Net Return</span>
                <span style={{ color: result.totalReturn >= 0 ? '#4ecdc4' : '#ff6b6b', fontWeight: 700 }}>
                  {formatDollar(result.totalReturn)} ({formatPct(result.totalReturnPct)})
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#888' }}>High Water Mark</span>
                <span style={{ color: '#aaa' }}>{formatDollar(result.hwm)}</span>
              </div>
            </div>

            {/* Fees breakdown */}
            <div style={{ borderTop: '1px solid #222', marginTop: 12, paddingTop: 12 }}>
              <div style={{ color: '#888', fontSize: 10, fontWeight: 700, marginBottom: 6 }}>FEE BREAKDOWN</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 20px', fontSize: 11 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#888' }}>Management Fee (2% p.a.)</span>
                  <span style={{ color: '#ff6b6b' }}>-{formatDollar(result.totalMgmtFees)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#888' }}>Performance Allocation</span>
                  <span style={{ color: '#ff6b6b' }}>-{formatDollar(result.totalPerfFees)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gridColumn: 'span 2', borderTop: '1px solid #222', paddingTop: 4, marginTop: 4 }}>
                  <span style={{ color: '#ccc', fontWeight: 700 }}>Total Fees</span>
                  <span style={{ color: '#ff6b6b', fontWeight: 700 }}>-{formatDollar(result.totalFees)}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {!result && investmentAmount < 100_000 && (
          <div style={{ color: '#ff6b6b', fontSize: 11, textAlign: 'center', padding: 20 }}>
            Minimum investment is $100,000
          </div>
        )}

        <div style={{ color: '#444', fontSize: 9, textAlign: 'center', marginTop: 12 }}>
          Based on PNTHR backtest data. Past performance does not guarantee future results.
        </div>
      </div>
    </div>
  );
}

function calcPerfAllocation(yearGrossProfit, yearStartNav, hwm, hurdleRate, allocRate) {
  if (yearGrossProfit <= 0) return 0;
  const navBeforeFees = yearStartNav + yearGrossProfit;
  const profitAboveHwm = Math.max(0, navBeforeFees - Math.max(hwm, yearStartNav));
  if (profitAboveHwm <= 0) return 0;
  const hurdleAmount = yearStartNav * (hurdleRate / 100);
  const excessProfit = Math.max(0, profitAboveHwm - hurdleAmount);
  return excessProfit * allocRate;
}
