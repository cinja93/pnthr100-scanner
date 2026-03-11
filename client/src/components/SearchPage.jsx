import { useState, useEffect, useRef } from 'react';
import StockTable from './StockTable';
import ChartModal from './ChartModal';
import { fetchStockSearch, fetchEarnings, fetchAutocompleteSuggestions } from '../services/api';
import styles from './SearchPage.module.css';
import pantherHead from '../assets/panther head.png';

export default function SearchPage() {
  const [query, setQuery]           = useState('');
  const [stock, setStock]           = useState(null);
  const [signals, setSignals]       = useState({});
  const [earnings, setEarnings]     = useState({});
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [eyesMoving, setEyesMoving] = useState(false);
  const [chartIndex, setChartIndex] = useState(null);
  const [chartStocks, setChartStocks] = useState([]);
  const debounceRef   = useRef(null);
  const inputRef      = useRef(null);
  const dropdownRef   = useRef(null);

  // Autocomplete: debounce 280ms
  useEffect(() => {
    if (query.length < 1) {
      setSuggestions([]);
      setShowSuggestions(false);
      setEyesMoving(false);
      return;
    }
    setEyesMoving(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const results = await fetchAutocompleteSuggestions(query);
      setSuggestions(results);
      setShowSuggestions(results.length > 0);
    }, 280);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  // Close dropdown on outside click
  useEffect(() => {
    function onDown(e) {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target) &&
        inputRef.current    && !inputRef.current.contains(e.target)
      ) setShowSuggestions(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  async function doSearch(ticker) {
    const t = (ticker || query).trim().toUpperCase();
    if (!t) return;
    setEyesMoving(false);
    setShowSuggestions(false);
    setLoading(true);
    setError(null);
    setStock(null);
    setSignals({});
    try {
      const result = await fetchStockSearch(t);
      setStock(result.stock);
      setSignals(result.signals || {});
      fetchEarnings([result.stock.ticker]).then(setEarnings);
    } catch (err) {
      setError(err.message || 'Ticker not found.');
    } finally {
      setLoading(false);
    }
  }

  function handleSuggestionClick(ticker) {
    setQuery(ticker);
    setShowSuggestions(false);
    setEyesMoving(false);
    doSearch(ticker);
  }

  function handleTickerClick(_s, idx, sortedStocks) {
    setChartStocks(sortedStocks);
    setChartIndex(idx);
  }

  return (
    <div className={styles.page}>

      <div className={styles.searchLayout}>

        {/* ── Left column: input + dropdown + result table ── */}
        <div className={styles.searchCol}>
          <h1 className={styles.title}>
            <img src={pantherHead} alt="PNTHR" className={styles.titleLogo} />
            PNTHR Search
          </h1>
          <p className={styles.subtitle}>NYSE · Nasdaq · ETFs</p>

          <form onSubmit={e => { e.preventDefault(); doSearch(); }} className={styles.searchForm}>
            <div className={styles.inputRow} ref={inputRef}>
              <input
                className={styles.searchInput}
                type="text"
                placeholder="Ticker or company name…"
                value={query}
                onChange={e => setQuery(e.target.value.toUpperCase())}
                autoFocus
                autoComplete="off"
              />
              <button className={styles.searchBtn} type="submit" disabled={loading || !query.trim()}>
                {loading ? '…' : 'Search'}
              </button>
            </div>

            {showSuggestions && (
              <ul className={styles.dropdown} ref={dropdownRef}>
                {suggestions.map(s => (
                  <li
                    key={s.ticker}
                    className={styles.dropdownItem}
                    onMouseDown={() => handleSuggestionClick(s.ticker)}
                  >
                    <span className={styles.suggTicker}>{s.ticker}</span>
                    <span className={styles.suggName}>{s.name}</span>
                    <span className={styles.suggExchange}>{s.exchange}</span>
                  </li>
                ))}
              </ul>
            )}
          </form>

          {error && <div className={styles.errorMsg}>{error}</div>}

          {!loading && stock && (
            <div className={styles.resultWrap}>
              <StockTable
                stocks={[stock]}
                signals={signals}
                signalsLoading={false}
                earnings={earnings}
                onTickerClick={handleTickerClick}
                scanType="long"
              />
            </div>
          )}
        </div>

        {/* ── Right column: big panther with animated eyes ── */}
        <div className={styles.pantherCol}>
          <div className={styles.pantherWrap}>
            <img src={pantherHead} alt="PNTHR" className={styles.pantherBig} />
            {/* Static yellow bases always covering the logo's own black pupils */}
            <div className={`${styles.eyeBase} ${styles.eyeLeft}`} />
            <div className={`${styles.eyeBase} ${styles.eyeRight}`} />
            {/* Animated eyes on top */}
            <div className={`${styles.eye} ${styles.eyeLeft}  ${eyesMoving ? styles.eyeMoving : ''}`} />
            <div className={`${styles.eye} ${styles.eyeRight} ${eyesMoving ? styles.eyeMoving : ''}`} />
          </div>
        </div>

      </div>

      {chartIndex != null && (
        <ChartModal
          stocks={chartStocks}
          initialIndex={chartIndex}
          signals={signals}
          earnings={earnings}
          onClose={() => setChartIndex(null)}
        />
      )}
    </div>
  );
}
