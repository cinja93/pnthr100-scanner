// server/aiUniverseService.js
// ── PNTHR AI Universe — backend service ─────────────────────────────────────
//
// Powers /api/ai-universe (the PNTHR AI Jungle page).
//
// Architecture:
//   • Basket of holdings = canonical scripts/aiUniverse/aiUniverseData.js
//     (single source of truth, versioned in git, drives white paper too).
//   • Live current price = FMP /quote, chunked (matches 679 Jungle pipeline).
//   • Year-start price   = FMP getYearStartPrices() with indefinite per-year
//     cache (matches 679 Jungle pipeline, identical semantics).
//   • Mongo pnthr_ai_bt_candles is the system of record for historical bars
//     and is reserved for the eventual signal / Pulse Score / backtest layer
//     once methodology is locked. Daily cron keeps it fresh.
//
// PNTHR signals (weekly + daily) intentionally return {} until the AI Universe
// methodology is locked. The page renders blank signal columns by design.
// ────────────────────────────────────────────────────────────────────────────

import { SECTORS, FUND_META } from './scripts/aiUniverse/aiUniverseData.js';
import { fetchFMP, getYearStartPrices } from './stockService.js';
import { getAiUniverseSignals } from './aiUniverseSignalsService.js';
import { getAiUniverseKill } from './aiUniverseKillService.js';

// ── Flatten holdings once at module load ────────────────────────────────────
const FLAT_HOLDINGS = [];
const SECTOR_META = SECTORS.map(s => ({
  id:     s.id,
  name:   s.name,
  weight: s.weight,
  count:  s.holdings.length,
}));

for (const sector of SECTORS) {
  for (const h of sector.holdings) {
    FLAT_HOLDINGS.push({
      ticker:      h.ticker,
      companyName: h.name,
      sectorId:    sector.id,
      sectorName:  sector.name,
    });
  }
}

export function getAiUniverseHoldings() { return FLAT_HOLDINGS; }
export function getAiUniverseSectorMeta() { return SECTOR_META; }
export function getAiUniverseFundMeta() { return FUND_META; }

// ── In-memory cache (30s, refresh=1 bypass) ─────────────────────────────────
// 30s matches the Den's auto-refresh cadence on AiJunglePage. The /api/ai-universe
// payload is dominated by one batched FMP /quote call (300 tickers fits in a
// single call — see QUOTE_CHUNK below), and signals/Kill come from their own
// 5-min caches and return instantly here. So at 30s the only real work each
// cycle is one FMP call: ~120 calls/hour during RTH, well under any plan.
let cache     = null;
let cacheTime = 0;
const CACHE_MS = 30 * 1000;

export function clearAiUniverseCache() { cache = null; cacheTime = 0; }

// ── Main entry ──────────────────────────────────────────────────────────────
// FMP /quote/<csv> accepts up to 1000 tickers per call; the AI Universe basket
// is 297, so one chunk = one call. (Was 200, which split into 2 calls + a 250ms
// inter-chunk sleep — wasted work.)
const QUOTE_CHUNK = 300;

export async function getAiUniverse({ refresh = false } = {}) {
  const now = Date.now();
  if (cache && !refresh && (now - cacheTime) < CACHE_MS) return cache;

  const tickers = FLAT_HOLDINGS.map(h => h.ticker);

  // Live quotes (FMP) — chunked, identical pattern to getJungleStocks.
  const quoteMap = {};
  for (let i = 0; i < tickers.length; i += QUOTE_CHUNK) {
    const chunk  = tickers.slice(i, i + QUOTE_CHUNK);
    const quotes = await fetchFMP(`/quote/${chunk.join(',')}`).catch(() => []);
    if (Array.isArray(quotes)) for (const q of quotes) quoteMap[q.symbol] = q;
    if (i + QUOTE_CHUNK < tickers.length) await new Promise(r => setTimeout(r, 250));
  }

  // Year-start prices (Dec 31 close of prior year). Cache is module-scoped
  // and only ever fetches missing tickers — for AI Universe, this is one
  // 304-ticker hit on first load each calendar year.
  const yearStart = await getYearStartPrices(tickers);

  // Build records + compute YTD
  const stocks = [];
  for (const h of FLAT_HOLDINGS) {
    const q   = quoteMap[h.ticker];
    const ysp = yearStart[h.ticker];
    if (!q || q.price == null) continue;
    const currentPrice = q.price;
    const ytdReturn    = (ysp != null && ysp > 0)
      ? ((currentPrice - ysp) / ysp) * 100
      : null;
    stocks.push({
      ticker:       h.ticker,
      companyName:  h.companyName,
      sectorId:     h.sectorId,
      sector:       h.sectorName,
      currentPrice: parseFloat(currentPrice.toFixed(2)),
      ytdReturn:    ytdReturn != null ? parseFloat(ytdReturn.toFixed(2)) : null,
      rank:         null,
      rankChange:   null,
    });
  }

  // Rank by YTD desc, nulls last
  stocks.sort((a, b) => {
    if (a.ytdReturn == null && b.ytdReturn == null) return 0;
    if (a.ytdReturn == null) return 1;
    if (b.ytdReturn == null) return -1;
    return b.ytdReturn - a.ytdReturn;
  });
  const ranked = stocks.map((s, i) => ({ ...s, rank: i + 1 }));

  // Per-stock BL/SS/BE/SE + PNTHR Stops. Each stock uses its AI sector's
  // tunable EMA period applied to its weekly bars (weekly signal) and the
  // same period applied to its daily bars (daily signal).
  const { signals: weeklySig, dailySignals: dailySig } = await getAiUniverseSignals();

  // PNTHR AI Kill — D1-D8 with AI substitutions (PAI300 regime, AI sector
  // indices, sector-tuned EMAs). Merged onto each stock for the Kill column.
  const killData = await getAiUniverseKill();
  for (const s of ranked) {
    const k = killData.stocks?.[s.ticker];
    if (k) {
      s.killScore = k.total;
      s.killTier  = k.tier;
      s.killRank  = k.rank ?? null;
      s.killD3Confirmation = k.d3?.confirmation ?? null;
    }
  }

  const payload = {
    stocks:        ranked,
    signals:       weeklySig,
    dailySignals:  dailySig,
    sectors:       SECTOR_META,
    killSummary:   {
      asOf:         killData.asOf,
      pai300Regime: killData.pai300 ? (killData.pai300.aboveEma ? 'bull' : 'bear') : null,
      pai300Slope:  killData.pai300?.emaSlope ?? null,
      signalCounts: killData.signalCounts,
      top10:        killData.ranked?.slice(0, 10) ?? [],
    },
    fundMeta:      FUND_META,
    fetchedCount:  ranked.length,
    requestedCount: FLAT_HOLDINGS.length,
  };

  cache     = payload;
  cacheTime = now;
  console.log(`🧠 AI Universe: ${ranked.length}/${FLAT_HOLDINGS.length} holdings priced (${SECTOR_META.length} sectors, FUND_META ${FUND_META.version})`);
  return payload;
}
