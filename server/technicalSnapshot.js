// server/technicalSnapshot.js
// ── PNTHR Technical Snapshot — RSI, ATR, ADX, OBV, Volume, 52-week range, Earnings ──
// Captured at entry and exit. Stored as techAtEntry / techAtExit on pnthr_journal.
// All calls run in parallel; individual failures return null (non-fatal).
// ─────────────────────────────────────────────────────────────────────────────

const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

async function fmpFetch(path) {
  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error('FMP_API_KEY not set');
  const url = `${FMP_BASE}${path}${path.includes('?') ? '&' : '?'}apikey=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status}: ${path}`);
  return res.json();
}

export async function fetchTechnicalSnapshot(ticker) {
  if (!ticker) return null;

  const [rsiData, atrData, adxData, quoteData, calendarData, candleData] = await Promise.all([
    fmpFetch(`/technical_indicator/daily/${ticker}?period=14&type=rsi`).catch(() => null),
    fmpFetch(`/technical_indicator/daily/${ticker}?period=14&type=atr`).catch(() => null),
    fmpFetch(`/technical_indicator/daily/${ticker}?period=14&type=adx`).catch(() => null),
    fmpFetch(`/quote/${ticker}`).catch(() => null),
    fmpFetch(`/earning_calendar?symbol=${ticker}`).catch(() => null),
    fmpFetch(`/historical-price-full/${ticker}?timeseries=20`).catch(() => null),
  ]);

  // RSI(14)
  const rsi14 = rsiData?.[0]?.rsi != null ? +rsiData[0].rsi.toFixed(1) : null;

  // ATR(14)
  const atr14 = atrData?.[0]?.atr != null ? +atrData[0].atr.toFixed(2) : null;

  // ADX
  const adx = adxData?.[0]?.adx != null ? +adxData[0].adx.toFixed(1) : null;

  // Quote-derived fields
  const quote      = Array.isArray(quoteData) ? quoteData[0] : null;
  const avgVolume  = quote?.avgVolume || null;
  const volume     = quote?.volume    || null;
  const volumeRatio = avgVolume && volume ? +(volume / avgVolume).toFixed(2) : null;
  const yearHigh   = quote?.yearHigh  || null;
  const yearLow    = quote?.yearLow   || null;
  const price      = quote?.price     || null;
  const range52wk  = yearHigh && yearLow && yearHigh > yearLow && price
    ? +((price - yearLow) / (yearHigh - yearLow) * 100).toFixed(1)
    : null;

  // OBV trend: compare buying pressure in first 10 vs last 10 bars
  let obvTrend = null;
  try {
    const hist = candleData?.historical;
    if (Array.isArray(hist) && hist.length >= 10) {
      const bars = [...hist].reverse(); // oldest → newest
      let obvFirst = 0, obvSecond = 0;
      const mid = Math.floor(bars.length / 2);
      for (let i = 1; i < mid; i++) {
        if (bars[i].close > bars[i - 1].close) obvFirst  += bars[i].volume;
        else if (bars[i].close < bars[i - 1].close) obvFirst -= bars[i].volume;
      }
      for (let i = mid; i < bars.length; i++) {
        if (bars[i].close > bars[i - 1].close) obvSecond  += bars[i].volume;
        else if (bars[i].close < bars[i - 1].close) obvSecond -= bars[i].volume;
      }
      obvTrend = obvSecond > obvFirst * 1.1  ? 'RISING'
               : obvSecond < obvFirst * 0.9  ? 'DECLINING'
               : 'FLAT';
    }
  } catch { /* non-fatal */ }

  // Days to next earnings
  let daysToEarnings = null;
  try {
    if (Array.isArray(calendarData) && calendarData.length > 0) {
      const now = new Date();
      const upcoming = calendarData
        .filter(e => e.date && new Date(e.date) > now)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      if (upcoming[0]) {
        daysToEarnings = Math.ceil((new Date(upcoming[0].date) - now) / (1000 * 60 * 60 * 24));
      }
    }
  } catch { /* non-fatal */ }

  return {
    rsi14,
    atr14,
    adx,
    obvTrend,
    avgVolume,
    volume,
    volumeRatio,
    range52wk,
    yearHigh,
    yearLow,
    daysToEarnings,
    capturedAt: new Date(),
  };
}
