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

// Group rows by sector, return a summary string with counts and new-signal counts
function sectorBreakdown(longs, shorts) {
  const map = {};
  const add = (rows, dir) => {
    (rows || []).forEach(r => {
      const sec = r.sector || 'Unknown';
      if (!map[sec]) map[sec] = { newLong: 0, long: 0, newShort: 0, short: 0, be: 0, se: 0 };
      if (dir === 'long')  { r.isNewSignal ? map[sec].newLong++ : map[sec].long++; }
      if (dir === 'short') { r.isNewSignal ? map[sec].newShort++ : map[sec].short++; }
      if (dir === 'be')    map[sec].be++;
      if (dir === 'se')    map[sec].se++;
    });
  };
  add(longs,  'long');
  add(shorts, 'short');
  return Object.entries(map)
    .sort((a, b) => (b[1].newShort + b[1].short) - (a[1].newShort + a[1].short))
    .map(([sec, c]) => {
      const parts = [];
      if (c.newLong)  parts.push(`${c.newLong} new long${c.newLong > 1 ? 's' : ''}`);
      if (c.long)     parts.push(`${c.long} existing long${c.long > 1 ? 's' : ''}`);
      if (c.newShort) parts.push(`${c.newShort} new short${c.newShort > 1 ? 's' : ''}`);
      if (c.short)    parts.push(`${c.short} existing short${c.short > 1 ? 's' : ''}`);
      if (c.be)       parts.push(`${c.be} long exit${c.be > 1 ? 's' : ''} (BE)`);
      if (c.se)       parts.push(`${c.se} short cover${c.se > 1 ? 's' : ''} (SE)`);
      return `${sec}: ${parts.join(', ')}`;
    }).join('\n');
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
  return getPreyResults(tickers, stockMeta, jungleSignals);
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

  // Fetch live prey data
  console.log('[Newsletter] Fetching prey data for generation...');
  const prey = await fetchPreyData();

  // Fetch prior issues for lookback context
  const priorIssues = await getPriorPublishedIssues(4);

  const dinnerLongs  = prey.dinner?.longs  || [];
  const dinnerShorts = prey.dinner?.shorts || [];
  const newDinnerLongs  = dinnerLongs.filter(r => r.isNewSignal);
  const newDinnerShorts = dinnerShorts.filter(r => r.isNewSignal);

  const dinnerSummary = [
    `Total open longs: ${dinnerLongs.length} (${newDinnerLongs.length} new this week)`,
    `Total open shorts: ${dinnerShorts.length} (${newDinnerShorts.length} new this week)`,
    `New longs this week: ${summarizeAllRows(newDinnerLongs) || 'None'}`,
    `New shorts this week: ${summarizeAllRows(newDinnerShorts) || 'None'}`,
    `All open longs: ${summarizeAllRows(dinnerLongs)}`,
    `All open shorts: ${summarizeAllRows(dinnerShorts)}`,
  ].join('\n');

  const alphaSummary  = 'LONG: ' + summarizeRows(prey.alphas?.longs, 10) + ' | SHORT: ' + summarizeRows(prey.alphas?.shorts, 10);
  const springSummary = 'LONG: ' + summarizeRows(prey.springs?.longs, 10) + ' | SHORT: ' + summarizeRows(prey.springs?.shorts, 10);
  const crouchSummary = 'LONG: ' + summarizeRows(prey.crouch?.longs, 10) + ' | SHORT: ' + summarizeRows(prey.crouch?.shorts, 10);

  const sectorSummary = sectorBreakdown(dinnerLongs, dinnerShorts);

  const lookbackContext = priorIssues.length === 0
    ? 'No prior published issues available yet — this is the inaugural issue.'
    : priorIssues.map(iss => {
        const wk = formatDateLong(iss.weekOf);
        const excerpt = (iss.narrative || '').slice(0, 500).replace(/\n/g, ' ');
        return `**Week of ${wk}:** ${excerpt}...`;
      }).join('\n\n');

  const prompt = `You are PNTHR, a sophisticated market intelligence system. Write the weekly "PNTHR's Perch" newsletter for the week of ${formatDateLong(weekOf)}.

PNTHR scans roughly 679 stocks across the S&P 500 and S&P 400 using a 21-week EMA trend-following model. Each week the system identifies stocks breaking into new uptrends (longs) or breaking down into downtrends (shorts), stocks approaching their breakout trigger (spring setups), and stocks compressing in tight Bollinger Bands ahead of a potential volatility expansion. Long exits (BE) and short covers (SE) signal potential sector reversals.

---

THIS WEEK'S MARKET SNAPSHOT:

Open positions (current in-trade universe):
${dinnerSummary}

New momentum entries this week (ranked by signal quality):
${alphaSummary}

Setups coiling near breakout trigger:
${springSummary}

Bollinger Band compressions (pre-explosion):
${crouchSummary}

Sector breakdown of current open positions:
${sectorSummary}

---

Prior weeks' narrative excerpts (for the lookback section):
${lookbackContext}

---

Write the newsletter with these EXACT sections in markdown:

# PNTHR's Perch — Week of ${formatDateLong(weekOf)}

## Market Pulse
3–4 sentences. The new longs vs new shorts count in the open positions this week is your primary directional compass. If the system is generating far more new shorts than new longs, say so plainly and interpret what that means: is this a market in distribution, a response to a macro shock, or the early stages of a broader downturn? Be direct and be willing to take a stance.

## Sector Analysis
This is the most important section. Look at the sector breakdown above. For each sector that has notable activity, interpret what it means economically. Do not just list the sectors; explain them. If financials are breaking down heavily, what does that say about credit conditions, lending, or systemic risk? If consumer discretionary names at both the low and high end of the income spectrum are showing weakness simultaneously, what does that tell us about the health of the American consumer? A K-shaped economy can get hit from both ends at once: dollar stores and luxury brands suffering together is not a contradiction, it is a signal. If industrials are breaking down, what historical patterns does that echo? If energy is holding up while everything else falls, what is the market pricing in? Write 3–5 paragraphs, one per meaningful sector cluster. This section should make the reader think about what the economy is actually doing beneath the headlines.

## This Week's Prey
Highlight 3–5 specific names from the data above. For each: ticker, price, direction (long or short), and 2–3 sentences of interpretation. Do not just describe the signal. Ask why this stock is moving this way, what it says about its sector, and what that sector's behavior suggests about the broader economy. Go deeper than the chart.

## The Squeeze Watch
Look at the compressed Bollinger Band setups. Which sectors are sitting in tight coils right now, and what does that tension tell us about where the next big move may be hiding? Interpret the setup, not just the list.

## The Perch — Looking Back
Humbly and specifically review prior calls from previous issues. Which tickers followed through and which failed? Be honest. Own the misses. Cite specific names and weeks. If a pattern of misses is emerging in a particular sector, say so.

## Closing Thought
1–2 sentences. A forward-looking thought about what this week's market structure signals for the weeks ahead. Give the reader something to think about.

---

CRITICAL TONE AND STYLE RULES:
- Never use em-dashes (the — character). Use commas, semicolons, colons, or rewrite the sentence instead.
- Write for an intelligent but general audience. Avoid proprietary system jargon. Say "current open long positions" not "Dinner longs." Say "momentum entries" not "Alpha signals." If you must reference a system category, explain it briefly in plain English.
- The new longs vs new shorts ratio is the headline directional signal each week. Lead with it in Market Pulse and let it inform the tone of the entire issue.
- The goal is to help the reader think, not just inform them. Every section should leave the reader with a question or a point of view about what is actually happening in the economy.
- Tone: Analytical, confident, and opinionated, like a seasoned portfolio manager writing a weekly letter to investors. No hype. No filler. No emojis. Markdown only.
- Max tokens are limited, so be concise within each section. Prioritize depth over length.`;

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
