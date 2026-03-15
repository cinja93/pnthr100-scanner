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

function summarizeRows(rows, limit = 10) {
  if (!rows || rows.length === 0) return 'None this week.';
  return rows.slice(0, limit).map(r => {
    const ticker = r.ticker || '';
    const signal = r.signal || r.signalBadge || '';
    const isNew  = r.isNewSignal ? ' *NEW*' : '';
    const price  = r.currentPrice ? ` $${Number(r.currentPrice).toFixed(2)}` : '';
    const sector = r.sector ? ` [${r.sector}]` : '';
    return `${ticker}${signal ? ' (' + signal + isNew + ')' : ''}${price}${sector}`;
  }).join(', ');
}

// Full list (no limit) with new-signal flag, for directional context
function summarizeAllRows(rows) {
  if (!rows || rows.length === 0) return 'None.';
  return rows.map(r => {
    const ticker = r.ticker || '';
    const isNew  = r.isNewSignal ? ' *NEW*' : '';
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
      if (c.newBL) parts.push(`NEW BL+1: ${c.newBL}`);
      if (c.BL)    parts.push(`Existing BL: ${c.BL}`);
      if (c.BE)    parts.push(`BE exits (longs sold off): ${c.BE}`);
      if (c.newSS) parts.push(`NEW SS+1: ${c.newSS}`);
      if (c.SS)    parts.push(`Existing SS: ${c.SS}`);
      if (c.SE)    parts.push(`SE covers (shorts covered): ${c.SE}`);
      const lean = c.newSS > c.newBL ? 'BEARISH' : c.newBL > c.newSS ? 'BULLISH' : 'NEUTRAL';
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

async function fetchPreyData() {
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
  const jungleSignals = await getSignals(tickers);
  const preyResults = await getPreyResults(tickers, stockMeta, jungleSignals);
  return { ...preyResults, signals: jungleSignals, stockMeta };
}

// Find profitable exits this week. weekOf is YYYY-MM-DD (Friday).
// weekStart of that week is the Monday 4 days prior.
function findBestExits(signals, stockMeta, weekOf) {
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
  return db.collection(COLLECTION)
    .find({ status: 'published' }, { projection: { narrative: 1, weekOf: 1 } })
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

  // PNTHR Feast by definition only shows BL+1 and SS+1 (first week of signal, still in the zone).
  // Every stock in Feast IS a new signal this week — no further filtering needed.
  const dinnerLongs  = prey.dinner?.longs  || [];
  const dinnerShorts = prey.dinner?.shorts || [];

  const dinnerSummary = [
    `SIGNAL NOTATION: BL+1 = brand-new Buy Long entry THIS WEEK. SS+1 = brand-new Sell Short entry THIS WEEK. The PNTHR Feast section only contains BL+1 and SS+1 stocks, meaning every stock listed below triggered a new entry signal this week.`,
    ``,
    `New BL+1 signals this week (new long entries): ${dinnerLongs.length}`,
    `New SS+1 signals this week (new short entries): ${dinnerShorts.length}`,
    `Ratio of new shorts to new longs: ${dinnerLongs.length === 0 ? 'N/A (no new longs)' : (dinnerShorts.length / dinnerLongs.length).toFixed(1) + ':1'}`,
    ``,
    `New longs (BL+1): ${summarizeAllRows(dinnerLongs) || 'None'}`,
    `New shorts (SS+1): ${summarizeAllRows(dinnerShorts) || 'None'}`,
  ].join('\n');

  const alphaSummary  = 'LONG: ' + summarizeRows(prey.alphas?.longs, 10) + ' | SHORT: ' + summarizeRows(prey.alphas?.shorts, 10);
  const springSummary = 'LONG: ' + summarizeRows(prey.springs?.longs, 10) + ' | SHORT: ' + summarizeRows(prey.springs?.shorts, 10);
  const sneakSummary = 'LONG: ' + summarizeRows(prey.sneak?.longs, 10) + ' | SHORT: ' + summarizeRows(prey.sneak?.shorts, 10);

  // Full sector breakdown across all 679 PNTHR stocks — drives intermarket analysis
  const sectorSummary = computeFullSectorCounts(prey.signals || {}, prey.stockMeta || {});

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

PNTHR scans roughly 679 stocks across the S&P 500 and S&P 400 using a 21-week EMA trend-following model. BL+1 = brand-new Buy Long entry THIS WEEK. SS+1 = brand-new Sell Short entry THIS WEEK. The BL+1 to SS+1 ratio is the primary market pulse indicator. NEVER confuse new signals (BL+1/SS+1) with existing open positions (BL+N/SS+N where N > 1).

---

THIS WEEK'S DATA:

INDEX STATUS (SPY vs QQQ — differentiate these, money can flow into one and out of the other):
${marketCtx.spyStatus}
${marketCtx.qqqStatus}

SECTOR ETF 5-DAY PERFORMANCE (use to identify which sectors are leading and lagging):
${marketCtx.sectorReturns || 'Sector ETF data unavailable this week.'}

NEW SIGNALS THIS WEEK (BL+1 = new longs, SS+1 = new shorts — these are the acceleration signals):
${dinnerSummary}

FULL SECTOR SIGNAL BREAKDOWN across all 679 PNTHR stocks (new entries + full open book + exits):
${sectorSummary}

PNTHR SPRINT — stocks rising in PNTHR rank or new to the scan this week:
${sprintSummary}

TRADE OF THE WEEK candidates (profitable closed trades this week):
${totwSummary}

SPRING SETUPS (stocks coiling near breakout trigger):
${springSummary}

BOLLINGER BAND COMPRESSIONS (pre-explosion coils):
${sneakSummary}

PRIOR WEEKS CONTEXT (for lookback section):
${lookbackContext}

---

Write the newsletter in EXACTLY this structure and format. Follow the section names and markdown precisely — the rendering engine depends on them:

# PNTHR's Perch — Week of ${formatDateLong(weekOf)}

[INTRO HOOK — 1 punchy paragraph, no heading. Open with the BL+1 to SS+1 ratio using the EXACT numbers from the data. State what it means for the market right now. If SPY and QQQ are diverging, call it out. Take a clear stance. Make The PNTHR sound like it sees something others don't.]

## PNTHR Trade of the Week - [TICKER]

[If profitable exits exist, use the best one. Replace [TICKER] in the heading above with the actual ticker symbol — this is used by the rendering engine to build the chart button. Then write 1-2 paragraphs about what the trade captured, what it says about the stock or sector, and what the reader should take away. Ground it in market insight, not just numbers.]

> **[TICKER] - [Company Name]** | [Sector]
> [Long exit (trade closed profitably) / Short cover (trade closed profitably)]
> **Profit: +$[X.XX] (+[X.XX]%)**

[If no profitable exits this week, write one sentence acknowledging it and note whether open positions are holding or showing stress. Skip the blockquote. Use a placeholder ticker in the heading such as "## PNTHR Trade of the Week - WATCH" in that case.]

## Market Overview

[SPY vs QQQ EMA status, the BL+1/SS+1 ratio and what it signals. Differentiate S&P 500 from Nasdaq 100 — they can diverge. State clearly: is this an accelerating breakdown, an acceleration upward, or a neutral tape? 2-3 paragraphs.]

## Sector Intelligence

[This is the most important section. Use the sector signal breakdown AND the sector ETF 5D returns together. Lead with the sectors generating the most NEW SS+1 signals — those are actively breaking down. Call out any sector with NEW BL+1 signals against a bearish tape as a contrarian tell. Identify the rotation story: where is capital leaving and where is it hiding? Connect the dots. Make the reader see something they would not have found on their own. 3-5 paragraphs.]

## New BL+1 Breakdown

[For each new long entry this week: ticker, sector, current price, and 2-3 sentences of interpretation. Why is THIS stock breaking out when the broader tape is [direction]? What does it say about its sector? Is it a defensive rotation, a contrarian bet, or a true outlier? Cover every BL+1 stock from the data above.]

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
5. Differentiate NEW signals (BL+1/SS+1) from existing trends (BL+N/SS+N where N>1) at all times. These are fundamentally different market signals.
6. Write for an intelligent investor audience. Analyze and conclude — do not just list data. Every section must leave the reader with a point of view and an action.`;

  console.log('[Newsletter] Calling Claude API...');
  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const narrative = message.content[0]?.type === 'text' ? message.content[0].text : '';

  // Save to MongoDB
  const db = await connectToDatabase();
  if (!db) throw new Error('Database not available');

  const col = db.collection(COLLECTION);
  const existing = await col.findOne({ weekOf });

  const doc = {
    weekOf,
    status: 'draft',
    narrative,
    featuredTrade: bestDollar ?? null,
    profitableExits: exits.slice(0, 20),
    dataSnapshot: {
      dinnerLongs:  (prey.dinner?.longs  || []).slice(0, 10).map(r => r.ticker),
      dinnerShorts: (prey.dinner?.shorts || []).slice(0, 10).map(r => r.ticker),
      alphaLongs:   (prey.alphas?.longs  || []).slice(0, 10).map(r => r.ticker),
      alphaShorts:  (prey.alphas?.shorts || []).slice(0, 10).map(r => r.ticker),
      springLongs:  (prey.springs?.longs || []).slice(0, 10).map(r => r.ticker),
      springShorts: (prey.springs?.shorts|| []).slice(0, 10).map(r => r.ticker),
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
