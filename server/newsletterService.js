// server/newsletterService.js
// PNTHR'S PERCH — Weekly AI-generated market intelligence newsletter
import Anthropic from '@anthropic-ai/sdk';
import { connectToDatabase } from './database.js';
import { getJungleStocks } from './stockService.js';
import { getSignals } from './signalService.js';
import { getSp400Longs, getSp400Shorts } from './sp400Service.js';
import { getPreyResults } from './preyService.js';

const COLLECTION = 'newsletter_issues';

function getAnthropicClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// Most recent Friday date as YYYY-MM-DD
export function getMostRecentFriday() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun..6=Sat
  // days to subtract to reach most recent Friday
  const daysBack = day === 5 ? 0 : day === 6 ? 1 : day + 2;
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().split('T')[0];
}

function formatDateLong(isoDate) {
  return new Date(isoDate + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

// ── Jargon → plain-English translation ───────────────────────────────────────
// Converts internal PNTHR signal notation (BL+1, SS+2, BE, SE, etc.) into
// phrasing a generalist investor understands. Runs on data summaries BEFORE
// they're embedded in the generation prompt; the prompt also instructs Claude
// to write in plain English as defense in depth.
function translateSignal(sig) {
  if (!sig) return '';
  const s = String(sig).toUpperCase().trim();
  if (s === 'BL') return 'long';
  if (s === 'SS') return 'short';
  if (s === 'BE') return 'long exit';
  if (s === 'SE') return 'short cover';
  const m = s.match(/^(BL|SS)\+(\d+)$/);
  if (m) {
    const dir = m[1] === 'BL' ? 'long' : 'short';
    const n = +m[2];
    if (n === 1) return `new ${dir} signal this week`;
    if (n === 2) return `${dir} signal from last week`;
    return `${dir} signal from ${n} weeks ago`;
  }
  return s.toLowerCase();
}

function summarizeRows(rows, limit = 10) {
  if (!rows || rows.length === 0) return 'None this week.';
  return rows.slice(0, limit).map(r => {
    const ticker = r.ticker || '';
    const rawSignal = r.signal || r.signalBadge || '';
    const signalText = translateSignal(rawSignal);
    const isNew = r.isNewSignal ? ' NEW' : '';
    const price = r.currentPrice ? ` $${Number(r.currentPrice).toFixed(2)}` : '';
    const sector = r.sector ? ` [${r.sector}]` : '';
    return `${ticker}${signalText ? ' (' + signalText + isNew + ')' : ''}${price}${sector}`;
  }).join(', ');
}

// Full list (no limit) with new-signal flag, for directional context
function summarizeAllRows(rows) {
  if (!rows || rows.length === 0) return 'None.';
  return rows.map(r => {
    const ticker = r.ticker || '';
    const isNew  = r.isNewSignal ? ' NEW' : '';
    const price  = r.currentPrice ? ` $${Number(r.currentPrice).toFixed(2)}` : '';
    const sector = r.sector ? ` [${r.sector}]` : '';
    return `${ticker}${isNew}${price}${sector}`;
  }).join(', ');
}

// Full sector signal breakdown across ALL 679 PNTHR stocks — used for intermarket analysis
// Returns per-sector counts of new and existing BL/SS/BE/SE signals with directional lean
function computeFullSectorCounts(signals, stockMeta) {
  const map = {};
  for (const [ticker, sig] of Object.entries(signals)) {
    const sector = stockMeta[ticker]?.sector || 'Unknown';
    if (!map[sector]) map[sector] = { newBL: 0, BL: 0, BE: 0, newSS: 0, SS: 0, SE: 0, total: 0 };
    map[sector].total++;
    const s    = sig.signal;
    const isNew = sig.isNewSignal ?? false;
    if      (s === 'BL') { map[sector].BL++; if (isNew) map[sector].newBL++; }
    else if (s === 'BE')   map[sector].BE++;
    else if (s === 'SS') { map[sector].SS++; if (isNew) map[sector].newSS++; }
    else if (s === 'SE')   map[sector].SE++;
  }

  return Object.entries(map)
    .filter(([, c]) => c.newBL + c.newSS + c.BL + c.SS + c.BE + c.SE > 0)
    .sort((a, b) => (b[1].newBL + b[1].newSS) - (a[1].newBL + a[1].newSS))
    .map(([sector, c]) => {
      const parts = [];
      if (c.newBL) parts.push(`${c.newBL} new long signals this week`);
      if (c.BL)    parts.push(`${c.BL} longs from prior weeks still active`);
      if (c.BE)    parts.push(`${c.BE} long exits`);
      if (c.newSS) parts.push(`${c.newSS} new short signals this week`);
      if (c.SS)    parts.push(`${c.SS} shorts from prior weeks still active`);
      if (c.SE)    parts.push(`${c.SE} short covers`);
      const lean = c.newSS > c.newBL ? 'bearish' : c.newBL > c.newSS ? 'bullish' : 'neutral';
      return `${sector} [${lean} lean this week]: ${parts.join(', ')} | ${c.total} stocks tracked`;
    }).join('\n');
}

// Sector ETFs tracked for 5D performance context
const SECTOR_ETFS = [
  { ticker: 'SPY',  label: 'S&P 500' },
  { ticker: 'QQQ',  label: 'Nasdaq 100' },
  { ticker: 'XLK',  label: 'Technology' },
  { ticker: 'XLF',  label: 'Financials' },
  { ticker: 'XLE',  label: 'Energy' },
  { ticker: 'XLV',  label: 'Healthcare' },
  { ticker: 'XLY',  label: 'Consumer Discretionary' },
  { ticker: 'XLP',  label: 'Consumer Staples' },
  { ticker: 'XLI',  label: 'Industrials' },
  { ticker: 'XLB',  label: 'Materials' },
  { ticker: 'XLRE', label: 'Real Estate' },
  { ticker: 'XLU',  label: 'Utilities' },
  { ticker: 'XLC',  label: 'Communication Services' },
];

// Fetch SPY, QQQ, and sector ETF weekly signals + 5D return
async function fetchMarketContext() {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return { spyStatus: 'unknown', qqqStatus: 'unknown', sectorReturns: '' };

  try {
    const tickers = SECTOR_ETFS.map(e => e.ticker).join(',');
    const url = `https://financialmodelingprep.com/api/v3/quote/${tickers}?apikey=${apiKey}`;
    const res = await fetch(url);
    const quotes = await res.json();
    if (!Array.isArray(quotes)) return { spyStatus: 'unknown', qqqStatus: 'unknown', sectorReturns: '' };

    const quoteMap = {};
    for (const q of quotes) quoteMap[q.symbol] = q;

    // SPY and QQQ status based on changesPercentage (5D proxy = week's % change)
    function statusLine(ticker, label) {
      const q = quoteMap[ticker];
      if (!q) return `${label}: data unavailable`;
      const chg = q.changesPercentage ?? 0;
      const dir = chg >= 0 ? '+' : '';
      // price vs 200-day SMA as EMA proxy — FMP quote includes priceAvg200
      const above = q.price > (q.priceAvg200 ?? q.price) ? 'ABOVE' : 'BELOW';
      return `${label} (${ticker}): price $${Number(q.price).toFixed(2)}, 5D ${dir}${chg.toFixed(2)}%, currently ${above} 200-day avg`;
    }

    const spyStatus = statusLine('SPY', 'S&P 500 (SPY)');
    const qqqStatus = statusLine('QQQ', 'Nasdaq 100 (QQQ)');

    // Sector ETF 5D returns table (excludes SPY/QQQ — shown separately above)
    const sectorLines = SECTOR_ETFS
      .filter(e => e.ticker !== 'SPY' && e.ticker !== 'QQQ')
      .map(e => {
        const q = quoteMap[e.ticker];
        if (!q) return `  ${e.label} (${e.ticker}): no data`;
        const chg = q.changesPercentage ?? 0;
        const dir = chg >= 0 ? '+' : '';
        const arrow = chg >= 1 ? '▲' : chg <= -1 ? '▼' : '→';
        return `  ${arrow} ${e.label} (${e.ticker}): ${dir}${chg.toFixed(2)}% this week`;
      });

    return {
      spyStatus,
      qqqStatus,
      sectorReturns: sectorLines.join('\n'),
    };
  } catch (err) {
    console.warn('[Newsletter] Market context fetch failed:', err.message);
    return { spyStatus: 'unavailable', qqqStatus: 'unavailable', sectorReturns: '' };
  }
}

// Sector long-lean percentage (active longs as % of active long+short signals)
// per sector. Used to drive the week-over-week sector rotation chart on the
// rendered newsletter — compared against the prior issue's dataSnapshot.
// Sectors with fewer than 3 active signals are skipped as noisy.
function computeSectorLongLeanPct(signals, stockMeta) {
  const bySector = {};
  for (const [ticker, sig] of Object.entries(signals)) {
    const sector = stockMeta[ticker]?.sector;
    if (!sector || sector === 'Unknown') continue;
    const s = sig.signal;
    // Count active positions only; exits and covers don't affect current lean.
    if (s !== 'BL' && s !== 'SS') continue;
    if (!bySector[sector]) bySector[sector] = { longs: 0, shorts: 0 };
    if (s === 'BL') bySector[sector].longs++;
    else            bySector[sector].shorts++;
  }
  const out = {};
  for (const [sector, c] of Object.entries(bySector)) {
    const total = c.longs + c.shorts;
    if (total < 3) continue;
    out[sector] = Math.round((c.longs / total) * 100);
  }
  return out;
}

// Compute Sprint movers — stocks that rose in PNTHR rank or are new entries
function computeSprintMovers(stocks) {
  const risers = stocks
    .filter(s => s.rankChange > 0 || s.rankChange === null)
    .sort((a, b) => (b.rankChange ?? 999) - (a.rankChange ?? 999))
    .slice(0, 15);

  if (risers.length === 0) return 'No notable rank risers this week.';
  return risers.map(s => {
    const tag = s.rankChange === null ? 'NEW ENTRY' : `+${s.rankChange} rank`;
    return `${s.ticker} [${s.sector || ''}] (${tag})`;
  }).join(', ');
}

export async function fetchPreyData() {
  const [specLongs, specShorts] = await Promise.all([getSp400Longs(), getSp400Shorts()]);
  const stocks = await getJungleStocks(specLongs, specShorts);
  const tickers = stocks.map(s => s.ticker);
  const stockMeta = {};
  for (const s of stocks) {
    stockMeta[s.ticker] = {
      companyName: s.companyName,
      sector: s.sector,
      exchange: s.exchange,
      currentPrice: s.currentPrice,
    };
  }
  const nlSectorMap = Object.fromEntries(tickers.map(t => [t, stockMeta[t]?.sector]).filter(([, s]) => s));
  const jungleSignals = await getSignals(tickers, { sectorMap: nlSectorMap });
  const preyResults = await getPreyResults(tickers, stockMeta, jungleSignals);
  return { ...preyResults, signals: jungleSignals, stockMeta };
}

// Find profitable exits this week. weekOf is YYYY-MM-DD (Friday).
// weekStart of that week is the Monday 4 days prior.
// Exported so perchService.js can fall back to live signals when the
// pnthr679_trade_archive collection is empty for the current week.
export function findBestExits(signals, stockMeta, weekOf) {
  // Determine Monday of the newsletter week
  const fri = new Date(weekOf + 'T12:00:00');
  const mon = new Date(fri);
  mon.setDate(fri.getDate() - 4);
  const weekStart = mon.toISOString().split('T')[0];

  const exits = Object.entries(signals)
    .filter(([, sig]) =>
      (sig.signal === 'BE' || sig.signal === 'SE') &&
      sig.profitDollar != null &&
      sig.profitDollar > 0 &&
      sig.signalDate === weekStart
    )
    .map(([ticker, sig]) => ({
      ticker,
      signal: sig.signal,
      direction: sig.signal === 'BE' ? 'long' : 'short',
      profitDollar: sig.profitDollar,
      profitPct: sig.profitPct,
      companyName: stockMeta[ticker]?.companyName || '',
      sector: stockMeta[ticker]?.sector || '',
      currentPrice: stockMeta[ticker]?.currentPrice ?? null,
    }));

  if (exits.length === 0) return { exits: [], bestDollar: null, bestPct: null };

  const byDollar = [...exits].sort((a, b) => b.profitDollar - a.profitDollar);
  const byPct    = [...exits].sort((a, b) => b.profitPct   - a.profitPct);

  return {
    exits,
    bestDollar: byDollar[0],
    bestPct: byPct[0],
  };
}

async function getPriorPublishedIssues(limit = 4) {
  const db = await connectToDatabase();
  if (!db) return [];
  // dataSnapshot included so we can pull last week's sector long-lean
  // percentages for the week-over-week sector rotation chart.
  return db.collection(COLLECTION)
    .find({ status: 'published' }, { projection: { narrative: 1, weekOf: 1, dataSnapshot: 1 } })
    .sort({ weekOf: -1 })
    .limit(limit)
    .toArray();
}

export async function generateIssue(weekOf) {
  const client = getAnthropicClient();

  // Fetch all data in parallel
  console.log('[Newsletter] Fetching data for generation...');
  const [prey, marketCtx] = await Promise.all([
    fetchPreyData(),
    fetchMarketContext(),
  ]);

  // Find this week's most profitable exits
  const { exits, bestDollar, bestPct } = findBestExits(prey.signals || {}, prey.stockMeta || {}, weekOf);

  // Sprint movers from full stock list
  const allStocks = Object.entries(prey.stockMeta || {}).map(([ticker, meta]) => ({ ticker, ...meta }));
  const sprintSummary = computeSprintMovers(allStocks);

  // Fetch prior issues for lookback context
  const priorIssues = await getPriorPublishedIssues(4);

  // Internal note: these lists only contain stocks whose very first signal is
  // THIS WEEK — i.e. brand-new entries. Older continuing signals are excluded.
  const dinnerLongs  = prey.dinner?.longs  || [];
  const dinnerShorts = prey.dinner?.shorts || [];

  const dinnerSummary = [
    `Every stock listed below triggered a NEW entry signal THIS WEEK (these are first-week entries, not continuations of older signals).`,
    ``,
    `New long signals this week (first-week entries): ${dinnerLongs.length}`,
    `New short signals this week (first-week entries): ${dinnerShorts.length}`,
    `Ratio of new short signals to new long signals: ${dinnerLongs.length === 0 ? 'N/A (no new longs)' : (dinnerShorts.length / dinnerLongs.length).toFixed(1) + ':1'}`,
    ``,
    `New long tickers: ${summarizeAllRows(dinnerLongs) || 'None'}`,
    `New short tickers: ${summarizeAllRows(dinnerShorts) || 'None'}`,
  ].join('\n');

  const alphaSummary  = 'LONG: ' + summarizeRows(prey.alphas?.longs, 10) + ' | SHORT: ' + summarizeRows(prey.alphas?.shorts, 10);
  const springSummary = 'LONG: ' + summarizeRows(prey.springs?.longs, 10) + ' | SHORT: ' + summarizeRows(prey.springs?.shorts, 10);
  const sneakSummary = 'LONG: ' + summarizeRows(prey.sneak?.longs, 10) + ' | SHORT: ' + summarizeRows(prey.sneak?.shorts, 10);

  // Full sector breakdown across all 679 PNTHR stocks — drives intermarket analysis
  const sectorSummary = computeFullSectorCounts(prey.signals || {}, prey.stockMeta || {});

  // Sector long-lean % this week, used to drive the week-over-week rotation
  // chart on the rendered newsletter. We compare against the prior issue's
  // stored snapshot; on the very first generation (or when a sector had no
  // signals last week) the "lastWeek" bar will be null and the chart will
  // show only this week's bar.
  const thisWeekLongLean = computeSectorLongLeanPct(prey.signals || {}, prey.stockMeta || {});
  const lastWeekLongLean = priorIssues[0]?.dataSnapshot?.sectorLongLeanPct || {};
  const sectorRotationChart = Object.keys(thisWeekLongLean)
    .map(sector => {
      const thisWeek = thisWeekLongLean[sector];
      const lastWeek = Object.prototype.hasOwnProperty.call(lastWeekLongLean, sector)
        ? lastWeekLongLean[sector]
        : null;
      const delta = lastWeek == null ? null : thisWeek - lastWeek;
      return { sector, thisWeek, lastWeek, delta };
    })
    // Strongest sectors first (longest bar at the top).
    .sort((a, b) => b.thisWeek - a.thisWeek);

  // Trade of the Week summary for prompt
  function tradeStr(t) {
    if (!t) return null;
    const dir = t.signal === 'BE' ? 'Long exit (trade closed profitably)' : 'Short cover (trade closed profitably)';
    return `${t.ticker} (${t.companyName}, ${t.sector}) — ${dir} | Profit: +$${t.profitDollar.toFixed(2)} / +${t.profitPct.toFixed(2)}%`;
  }
  const totw_dollar = tradeStr(bestDollar);
  const totw_pct    = tradeStr(bestPct && bestPct.ticker !== bestDollar?.ticker ? bestPct : null);
  const totwSummary = exits.length === 0
    ? 'No profitable exits closed this week.'
    : [
        `Total profitable exits this week: ${exits.length}`,
        totw_dollar ? `Best by dollar profit: ${totw_dollar}` : null,
        totw_pct    ? `Best by % return: ${totw_pct}` : null,
      ].filter(Boolean).join('\n');

  const lookbackContext = priorIssues.length === 0
    ? 'No prior published issues available yet — this is the inaugural issue.'
    : priorIssues.map(iss => {
        const wk = formatDateLong(iss.weekOf);
        const excerpt = (iss.narrative || '').slice(0, 500).replace(/\n/g, ' ');
        return `**Week of ${wk}:** ${excerpt}...`;
      }).join('\n\n');

  const prompt = `You are PNTHR, a sophisticated market intelligence system. Write the weekly "PNTHR's Perch" newsletter for the week of ${formatDateLong(weekOf)}.

PNTHR scans roughly 679 stocks across the S&P 500 and S&P 400 using a sector-optimized trend-following model. The key weekly metric is the ratio of new long signals (first-week entries) to new short signals — a rising ratio of new shorts to new longs signals broader market weakness. New first-week signals are fundamentally different from continuing signals that triggered in prior weeks, and the newsletter must keep that distinction clear in plain language.

---

THIS WEEK'S DATA:

INDEX STATUS (S&P 500 vs Nasdaq 100 — differentiate these, capital can flow into one while leaving the other):
${marketCtx.spyStatus}
${marketCtx.qqqStatus}

SECTOR ETF 5-DAY PERFORMANCE (use to identify which sectors are leading and lagging):
${marketCtx.sectorReturns || 'Sector ETF data unavailable this week.'}

NEW SIGNALS THIS WEEK (first-week long and short entries — these are the acceleration signals):
${dinnerSummary}

FULL SECTOR SIGNAL BREAKDOWN across all 679 PNTHR stocks (new entries, continuing signals, and exits by sector):
${sectorSummary}

PNTHR SPRINT — stocks rising in PNTHR rank or new to the scan this week:
${sprintSummary}

TRADE OF THE WEEK candidates (profitable closed trades this week):
${totwSummary}

SPRING SETUPS (stocks tightening up near a trigger point):
${springSummary}

COMPRESSION SETUPS (price ranges tightening before a likely larger move):
${sneakSummary}

PRIOR WEEKS CONTEXT (for lookback section):
${lookbackContext}

---

Write the newsletter in EXACTLY this structure and format. Follow the section names and markdown precisely — the rendering engine depends on them:

# PNTHR's Perch — Week of ${formatDateLong(weekOf)}

[INTRO HOOK — 1 punchy paragraph, no heading. Open with the ratio of new long signals to new short signals this week, using the EXACT numbers from the data. State what it means for the market right now in plain language. If the S&P 500 and Nasdaq 100 are diverging, call it out. Take a clear stance. Make PNTHR sound like it sees something others don't.]

## PNTHR Trade of the Week - [TICKER]

[If profitable exits exist, use the best one. Replace [TICKER] in the heading above with the actual ticker symbol — this is used by the rendering engine to build the chart button. Then write 1-2 paragraphs about what the trade captured, what it says about the stock or sector, and what the reader should take away. Ground it in market insight, not just numbers.]

> **[TICKER] - [Company Name]** | [Sector]
> [Long exit (trade closed profitably) / Short cover (trade closed profitably)]
> **Profit: +$[X.XX] (+[X.XX]%)**

[If no profitable exits this week, write one sentence acknowledging it and note whether open positions are holding or showing stress. Skip the blockquote. Use a placeholder ticker in the heading such as "## PNTHR Trade of the Week - WATCH" in that case.]

## Market Overview

[S&P 500 and Nasdaq 100 trend status, the ratio of new long signals to new short signals this week, and what the combination signals. Differentiate S&P 500 from Nasdaq 100 — they can diverge. State clearly: is this an accelerating weakness, an acceleration upward, or a neutral tape? 2-3 paragraphs.]

## Sector Intelligence

[This is the most important section. Use the sector signal breakdown AND the sector ETF 5-day returns together. Lead with the sectors generating the most new short signals — those are actively weakening. Call out any sector with new long signals against a weak broader tape as a contrarian tell. Identify the rotation story: where is capital leaving and where is it hiding? Connect the dots. Make the reader see something they would not have found on their own. 3-5 paragraphs.]

## New Signals This Week

[For each new long entry this week: ticker, sector, current price, and 2-3 sentences of interpretation. Why is THIS stock strengthening when the broader tape is [direction]? What does it say about its sector? Is it a defensive rotation, a contrarian bet, or a true outlier? Cover every new long ticker from the data above.]

## PNTHR Sprint

[Highlight the top rank risers and new entries from the sprint data above. What does their sector mix tell us about where momentum is building? 1-2 paragraphs.]

## The Bottom Line

[1 tight summary paragraph. Tell the investor exactly what to DO this week. Not just what happened — what action to take, what to watch, and what would change the thesis. End with a forward-looking thought about what this week's market structure signals for the weeks ahead.]

---

ABSOLUTE RULES — violations break the rendering engine or mislead readers:
1. NEVER use em-dashes (the character —). Use commas, semicolons, colons, or hyphens instead. This is not a style preference — em-dashes break the newsletter formatting.
2. The ## PNTHR Trade of the Week heading MUST contain the ticker symbol after a hyphen (e.g. "## PNTHR Trade of the Week - DAR"). The rendering engine extracts it from there.
3. The blockquote MUST start with > **[TICKER] - [Company Name]** as the very first line. Do not put > **TRADE OF THE WEEK** or any other text before the ticker line.
4. Use only markdown. No HTML, no emojis, no special characters outside standard markdown.
5. Always distinguish NEW first-week signals from CONTINUING signals that triggered in prior weeks. These are fundamentally different market signals and the reader must never be left unsure which is which.
6. Analyze and conclude — do not just list data. Every section must leave the reader with a point of view and an action.
7. PLAIN ENGLISH ONLY. The audience may not know trading jargon. The following terms are FORBIDDEN in the output: BL, SS, BE, SE, BL+1, SS+1, BL+N, SS+N, RSI, OBV, ADX, EMA, 21W EMA, FEAST, ALPHA, SPRING, SNEAK, HUNT, SPRINT (as acronyms in body copy), breakout, breakdown, coiling, oversold, overbought. Say instead: "new long signal this week," "new short signal this week," "long exit," "short cover," "the trend," "tightening up," "pushing higher," "breaking down," "stretched." Define any branded term on first use (e.g. "PNTHR Sprint — our list of stocks climbing the rankings") and prefer plain descriptions after that.`;

  console.log('[Newsletter] Calling Claude API...');
  // max_tokens: 8000 — the previous 3000 cap was causing the narrative to get
  // cut off mid-section on weeks with ≥15 new long signals. The same fix
  // was applied months ago to the old perchService.js but was never ported
  // here. 8000 leaves comfortable headroom for 6 sections + per-stock detail.
  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  const narrative = message.content[0]?.type === 'text' ? message.content[0].text : '';
  const wasTruncated = message.stop_reason === 'max_tokens';
  if (wasTruncated) {
    console.warn(`[Newsletter] ⚠ Narrative hit the max_tokens ceiling (${message.usage?.output_tokens} output tokens). Narrative is likely cut off mid-section — consider bumping max_tokens and regenerating.`);
  }

  // Save to MongoDB
  const db = await connectToDatabase();
  if (!db) throw new Error('Database not available');

  const col = db.collection(COLLECTION);
  const existing = await col.findOne({ weekOf });

  const doc = {
    weekOf,
    status: 'draft',
    narrative,
    wasTruncated, // true if Claude hit max_tokens — a red flag for the editor
    featuredTrade: bestDollar ?? null,
    profitableExits: exits.slice(0, 20),
    // Precomputed chart data the client renders inline with the narrative.
    // Kept server-side (rather than generated from signal data on the fly on
    // the client) so the numbers never drift from what the prompt saw.
    charts: {
      sectorRotation: sectorRotationChart,
    },
    dataSnapshot: {
      dinnerLongs:  (prey.dinner?.longs  || []).slice(0, 10).map(r => r.ticker),
      dinnerShorts: (prey.dinner?.shorts || []).slice(0, 10).map(r => r.ticker),
      alphaLongs:   (prey.alphas?.longs  || []).slice(0, 10).map(r => r.ticker),
      alphaShorts:  (prey.alphas?.shorts || []).slice(0, 10).map(r => r.ticker),
      springLongs:  (prey.springs?.longs || []).slice(0, 10).map(r => r.ticker),
      springShorts: (prey.springs?.shorts|| []).slice(0, 10).map(r => r.ticker),
      // Stored so NEXT week's generation can compare week-over-week for the
      // sector rotation chart (this week's values become next week's "last week").
      sectorLongLeanPct: thisWeekLongLean,
    },
    generatedAt: new Date(),
  };

  if (existing) {
    await col.updateOne({ weekOf }, { $set: doc });
    return { ...existing, ...doc, _id: existing._id };
  } else {
    const result = await col.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }
}

export async function listIssues(limit = 52) {
  const db = await connectToDatabase();
  if (!db) return [];
  return db.collection(COLLECTION)
    .find({}, { projection: { narrative: 0, dataSnapshot: 0 } })
    .sort({ weekOf: -1 })
    .limit(limit)
    .toArray();
}

export async function getIssue(id) {
  const { ObjectId } = await import('mongodb');
  const db = await connectToDatabase();
  if (!db) return null;
  return db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
}

export async function updateIssueNarrative(id, narrative) {
  const { ObjectId } = await import('mongodb');
  const db = await connectToDatabase();
  if (!db) throw new Error('Database not available');
  await db.collection(COLLECTION).updateOne(
    { _id: new ObjectId(id) },
    { $set: { narrative, editedAt: new Date() } }
  );
}

export async function publishIssue(id) {
  const { ObjectId } = await import('mongodb');
  const db = await connectToDatabase();
  if (!db) throw new Error('Database not available');
  await db.collection(COLLECTION).updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: 'published', publishedAt: new Date() } }
  );
}
