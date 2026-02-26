import { useState, useEffect, useCallback } from 'react';
import styles from './PortfolioPage.module.css';

const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? '' : 'http://localhost:3000');
function authHeaders(extra = {}) {
  return { 'x-api-key': import.meta.env.VITE_API_KEY, ...extra };
}

async function apiFetchPortfolio() {
  const res = await fetch(`${API_BASE}/api/portfolio`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiFetchTicker(ticker) {
  const res = await fetch(`${API_BASE}/api/portfolio/ticker/${ticker}`, { headers: authHeaders() });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `Ticker ${ticker} not found`);
  }
  return res.json();
}

async function apiOptimize(accountSize, riskPct, tickers) {
  const res = await fetch(`${API_BASE}/api/portfolio/optimize`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ accountSize, riskPct, tickers }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Compute position sizing for one stock given a dollar account size and risk % per trade.
// Returns null fields if account size isn't set yet.
function computePosition(stock, accountSize, riskPct = 1) {
  if (!accountSize || accountSize <= 0) {
    return { baseShares: null, positionValue: null, riskDollar: null, riskPctPerShare: null };
  }
  const riskPerShare = stock.stopPrice != null
    ? Math.abs(stock.currentPrice - stock.stopPrice)
    : stock.currentPrice * 0.08;
  if (riskPerShare <= 0) {
    return { baseShares: 0, positionValue: 0, riskDollar: 0, riskPctPerShare: 0 };
  }
  const baseShares = Math.floor(accountSize * (riskPct / 100) / riskPerShare);
  return {
    baseShares,
    positionValue: baseShares * stock.currentPrice,
    riskDollar: riskPerShare * baseShares,
    riskPctPerShare: (riskPerShare / stock.currentPrice) * 100,
  };
}

function fmt$(n, decimals = 2) {
  if (n == null) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtPct(n) {
  if (n == null) return '—';
  return n.toFixed(1) + '%';
}

export default function PortfolioPage() {
  const [portfolio, setPortfolio] = useState([]);
  const [included, setIncluded] = useState(new Set());
  const [accountSizeStr, setAccountSizeStr] = useState('');
  const [riskPctStr, setRiskPctStr] = useState('1');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [addTicker, setAddTicker] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState('');

  const [optimizing, setOptimizing] = useState(false);
  const [optimizeError, setOptimizeError] = useState('');
  const [optimized, setOptimized] = useState(null); // { resultsMap, sortino, sharpe, scaleFactor, maxDrawdown, portfolioVol, avgCorrelation, excludedCount }

  const accountSize = parseFloat(accountSizeStr.replace(/,/g, '')) || 0;
  const riskPct = Math.min(Math.max(parseFloat(riskPctStr) || 1, 0.1), 10); // clamp 0.1–10%

  useEffect(() => {
    loadPortfolio();
  }, []);

  async function loadPortfolio() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetchPortfolio();
      setPortfolio(data);
      // Default: check only the top 25 from each direction (rank 1–25)
      setIncluded(new Set(data.filter(s => s.rank <= 25).map(s => s.ticker)));
    } catch (err) {
      setError('Failed to load portfolio data. Make sure the server is running.');
    } finally {
      setLoading(false);
    }
  }

  function toggleInclude(ticker) {
    setIncluded(prev => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
    // Clear optimization results when selection changes
    setOptimized(null);
    setOptimizeError('');
  }

  async function handleAddTicker(e) {
    if (e.key !== 'Enter') return;
    const ticker = addTicker.trim().toUpperCase();
    if (!ticker) return;
    if (portfolio.some(s => s.ticker === ticker)) {
      setAddError(`${ticker} is already in the list`);
      return;
    }
    setAddLoading(true);
    setAddError('');
    try {
      const stock = await apiFetchTicker(ticker);
      setPortfolio(prev => [...prev, { ...stock, direction: 'LONG' }]);
      setIncluded(prev => new Set([...prev, ticker]));
      setAddTicker('');
      setOptimized(null);
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAddLoading(false);
    }
  }

  async function handleOptimize() {
    const tickerList = portfolio.filter(s => included.has(s.ticker)).map(s => s.ticker);
    if (tickerList.length < 2 || accountSize <= 0) return;
    setOptimizing(true);
    setOptimizeError('');
    setOptimized(null);
    try {
      const result = await apiOptimize(accountSize, riskPct, tickerList);
      const resultsMap = new Map();
      for (const r of (result.results || [])) {
        resultsMap.set(r.ticker, r);
      }
      setOptimized({
        resultsMap,
        sortino: result.sortino,
        sharpe: result.sharpe,
        scaleFactor: result.scaleFactor,
        maxDrawdown: result.maxDrawdown,
        vix: result.vix,
        avgCorrelation: result.avgCorrelation,
        excludedCount: result.excludedCount,
      });
    } catch (err) {
      setOptimizeError(err.message || 'Optimization failed');
    } finally {
      setOptimizing(false);
    }
  }

  // Summary stats for checked rows
  const checkedStocks = portfolio.filter(s => included.has(s.ticker));
  const totalBaseValue = checkedStocks.reduce((sum, s) => {
    const { positionValue } = computePosition(s, accountSize, riskPct);
    return sum + (positionValue || 0);
  }, 0);
  const totalOptValue = optimized
    ? Array.from(optimized.resultsMap.values()).reduce((sum, r) => sum + (r.optValue || 0), 0)
    : null;
  const longCount = optimized
    ? checkedStocks.filter(s => s.direction === 'LONG' && (optimized.resultsMap.get(s.ticker)?.optShares ?? 0) >= 1).length
    : checkedStocks.filter(s => s.direction === 'LONG').length;
  const shortCount = optimized
    ? checkedStocks.filter(s => s.direction === 'SHORT' && (optimized.resultsMap.get(s.ticker)?.optShares ?? 0) >= 1).length
    : checkedStocks.filter(s => s.direction === 'SHORT').length;

  const canOptimize = accountSize > 0 && checkedStocks.length >= 2 && !optimizing;

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>Loading portfolio data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.page}>
        <div className={styles.errorState}>
          <p>{error}</p>
          <button onClick={loadPortfolio} className={styles.retryBtn}>Try Again</button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h1 className={styles.title}>Portfolio Optimizer</h1>
        <p className={styles.subtitle}>Top 50 long + short — top 25 of each checked by default, Sortino optimized</p>
      </div>

      {/* Controls */}
      <div className={styles.controls}>
        <div className={styles.accountField}>
          <label className={styles.accountLabel} htmlFor="accountSize">Account Size ($)</label>
          <input
            id="accountSize"
            type="text"
            className={styles.accountInput}
            value={accountSizeStr}
            onChange={e => {
              setAccountSizeStr(e.target.value);
              setOptimized(null);
              setOptimizeError('');
            }}
            placeholder="e.g. 100000"
          />
        </div>
        <div className={styles.accountField}>
          <label className={styles.accountLabel} htmlFor="riskPct">Risk per Trade (%)</label>
          <input
            id="riskPct"
            type="number"
            className={styles.accountInput}
            value={riskPctStr}
            onChange={e => {
              setRiskPctStr(e.target.value);
              setOptimized(null);
              setOptimizeError('');
            }}
            placeholder="e.g. 1"
            min="0.1"
            max="10"
            step="0.1"
          />
        </div>
        <button
          className={`${styles.optimizeBtn} ${optimizing ? styles.optimizingBtn : ''}`}
          onClick={handleOptimize}
          disabled={!canOptimize}
          title={
            accountSize <= 0 ? 'Enter an account size first' :
            checkedStocks.length < 2 ? 'Select at least 2 stocks' :
            'Optimize: sector caps, volatility targeting, Sortino maximization'
          }
        >
          {optimizing ? '⏳ Optimizing...' : '📊 Optimize Portfolio'}
        </button>
      </div>

      {optimizeError && (
        <div className={styles.optimizeError}>{optimizeError}</div>
      )}

      {/* Summary cards */}
      {accountSize > 0 && (
        <div className={styles.summary}>
          <div className={styles.summaryCard}>
            <span className={styles.cardLabel}>Base Exposure</span>
            <strong className={styles.cardValue}>{fmt$(totalBaseValue, 0)}</strong>
          </div>
          {optimized && (
            <div className={styles.summaryCard}>
              <span className={styles.cardLabel}>Opt. Exposure</span>
              <strong className={styles.cardValue}>{fmt$(totalOptValue, 0)}</strong>
            </div>
          )}
          <div className={styles.summaryCard}>
            <span className={styles.cardLabel}>Long Positions</span>
            <strong className={styles.cardValue}>{longCount}</strong>
          </div>
          <div className={styles.summaryCard}>
            <span className={styles.cardLabel}>Short Positions</span>
            <strong className={styles.cardValue}>{shortCount}</strong>
          </div>
          {optimized?.sortino != null && (
            <div className={`${styles.summaryCard} ${styles.sortinoCard}`}>
              <span className={styles.cardLabel}>Sortino Ratio</span>
              <strong className={styles.cardValue}>{optimized.sortino.toFixed(2)}</strong>
            </div>
          )}
          {optimized?.scaleFactor != null && (
            <div className={styles.summaryCard}>
              <span className={styles.cardLabel}>Scale Factor</span>
              <strong className={styles.cardValue}>{(optimized.scaleFactor * 100).toFixed(0)}%</strong>
            </div>
          )}
          {optimized?.vix != null && (
            <div className={styles.summaryCard}>
              <span className={styles.cardLabel}>VIX</span>
              <strong className={styles.cardValue}>{optimized.vix.toFixed(1)}</strong>
            </div>
          )}
          {optimized?.maxDrawdown != null && (
            <div className={styles.summaryCard}>
              <span className={styles.cardLabel}>Max Drawdown</span>
              <strong className={styles.cardValue}>{(optimized.maxDrawdown * 100).toFixed(1)}%</strong>
            </div>
          )}
          {optimized?.sharpe != null && (
            <div className={`${styles.summaryCard} ${styles.sharpeCard}`}>
              <span className={styles.cardLabel}>Sharpe Ratio</span>
              <strong className={styles.cardValue}>{optimized.sharpe.toFixed(2)}</strong>
            </div>
          )}
          {optimized?.excludedCount > 0 && (
            <div className={styles.summaryCard}>
              <span className={styles.cardLabel}>Sector-Capped</span>
              <strong className={styles.cardValue}>{optimized.excludedCount}</strong>
            </div>
          )}
        </div>
      )}

      {/* Table */}
      <div className={styles.tableContainer}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.chkCol}></th>
              <th className={styles.rankCol}>Current Rank #</th>
              <th className={styles.dirCol}>L/S</th>
              <th>Ticker</th>
              <th>Company</th>
              <th className={styles.numCol}>Price</th>
              <th className={styles.numCol}>Stop</th>
              <th className={styles.numCol}>Risk per Share</th>
              <th className={styles.numCol}>Risk %</th>
              <th className={styles.numCol}>Max Shares</th>
              <th className={styles.numCol}>Pos. Value</th>
              {optimized && <th className={styles.numCol}>Optimal Shares</th>}
              {optimized && <th className={styles.numCol}>Optimal Position Value</th>}
            </tr>
          </thead>
          <tbody>
            {(() => {
              // Group portfolio by sector, preserving original order within each group
              const sectorMap = {};
              const sectorOrder = [];
              for (const stock of portfolio) {
                const sector = stock.sector || 'N/A';
                if (!sectorMap[sector]) {
                  sectorMap[sector] = [];
                  sectorOrder.push(sector);
                }
                sectorMap[sector].push(stock);
              }
              sectorOrder.sort((a, b) => a.localeCompare(b));
              const colSpan = optimized ? 13 : 11;

              return sectorOrder.map(sector => (
                <>
                  <tr key={`sector-${sector}`} className={styles.sectorRow}>
                    <td colSpan={colSpan} className={styles.sectorCell}>{sector}</td>
                  </tr>
                  {sectorMap[sector].map(stock => {
                    const isLong = stock.direction === 'LONG';
                    const isIncluded = included.has(stock.ticker);
                    const pos = computePosition(stock, accountSize, riskPct);
                    const opt = optimized?.resultsMap?.get(stock.ticker);

                    const hasOptShares = opt && opt.optShares >= 1;

                    return (
                      <tr
                        key={stock.ticker}
                        className={[
                          styles.row,
                          isLong ? styles.longRow : styles.shortRow,
                          !isIncluded ? styles.excludedRow : '',
                          hasOptShares ? styles.optActiveRow : '',
                        ].join(' ')}
                      >
                        <td className={styles.chkCol}>
                          <input
                            type="checkbox"
                            checked={isIncluded}
                            onChange={() => toggleInclude(stock.ticker)}
                            className={styles.checkbox}
                          />
                        </td>
                        <td className={styles.rankCol}>{stock.rank ?? ''}</td>
                        <td className={styles.dirCol}>
                          <span className={isLong ? styles.longTag : styles.shortTag}>
                            {isLong ? 'L' : 'S'}
                          </span>
                        </td>
                        <td className={styles.tickerCell}>{stock.ticker}</td>
                        <td className={styles.companyCell}>{stock.companyName || ''}</td>
                        <td className={styles.numCol}>{fmt$(stock.currentPrice)}</td>
                        <td className={styles.numCol}>
                          {stock.stopPrice != null
                            ? <>{fmt$(stock.stopPrice)}{stock.stopProxy && <span className={styles.proxyMark} title="8% proxy — no laser signal">*</span>}</>
                            : <span className={styles.dimVal}>—</span>}
                        </td>
                        <td className={styles.numCol}>
                          {isIncluded && pos.riskDollar != null
                            ? fmt$(pos.riskDollar)
                            : <span className={styles.dimVal}>—</span>}
                        </td>
                        <td className={styles.numCol}>
                          {isIncluded && pos.riskPctPerShare != null
                            ? fmtPct(pos.riskPctPerShare)
                            : <span className={styles.dimVal}>—</span>}
                        </td>
                        <td className={`${styles.numCol} ${styles.sharesCell}`}>
                          {isIncluded && pos.baseShares != null
                            ? pos.baseShares.toLocaleString()
                            : <span className={styles.dimVal}>—</span>}
                        </td>
                        <td className={styles.numCol}>
                          {isIncluded && pos.positionValue != null
                            ? fmt$(pos.positionValue, 0)
                            : <span className={styles.dimVal}>—</span>}
                        </td>
                        {optimized && (
                          <td className={`${styles.numCol} ${styles.sharesCell}`}>
                            {opt ? opt.optShares.toLocaleString() : <span className={styles.dimVal}>—</span>}
                          </td>
                        )}
                        {optimized && (
                          <td className={styles.numCol}>
                            {opt ? fmt$(opt.optValue, 0) : <span className={styles.dimVal}>—</span>}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </>
              ));
            })()}

            {/* Add-ticker row */}
            <tr className={styles.addRow}>
              <td colSpan={optimized ? 13 : 11} className={styles.addCell}>
                <input
                  type="text"
                  className={styles.addInput}
                  value={addTicker}
                  onChange={e => { setAddTicker(e.target.value.toUpperCase()); setAddError(''); }}
                  onKeyDown={handleAddTicker}
                  placeholder={addLoading ? 'Loading…' : '+ Type ticker and press Enter to add'}
                  disabled={addLoading}
                  maxLength={10}
                />
                {addError && <span className={styles.addError}>{addError}</span>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className={styles.note}>* Stop price estimated at 8% below current price (no laser signal available)</p>
    </div>
  );
}
