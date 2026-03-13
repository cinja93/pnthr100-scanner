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
    const price  = r.currentPrice ? ` $${Number(r.currentPrice).toFixed(2)}` : '';
    const sector = r.sector ? ` [${r.sector}]` : '';
    return `${ticker}${signal ? ' (' + signal + ')' : ''}${price}${sector}`;
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

  const dinnerSummary = 'LONG: ' + summarizeRows(prey.dinner?.longs, 8) + ' | SHORT: ' + summarizeRows(prey.dinner?.shorts, 5);
  const alphaSummary  = 'LONG: ' + summarizeRows(prey.alphas?.longs, 8) + ' | SHORT: ' + summarizeRows(prey.alphas?.shorts, 5);
  const springSummary = 'LONG: ' + summarizeRows(prey.springs?.longs, 8) + ' | SHORT: ' + summarizeRows(prey.springs?.shorts, 5);
  const crouchSummary = 'LONG: ' + summarizeRows(prey.crouch?.longs, 8) + ' | SHORT: ' + summarizeRows(prey.crouch?.shorts, 5);

  const lookbackContext = priorIssues.length === 0
    ? 'No prior published issues available yet — this is the inaugural issue.'
    : priorIssues.map(iss => {
        const wk = formatDateLong(iss.weekOf);
        const excerpt = (iss.narrative || '').slice(0, 500).replace(/\n/g, ' ');
        return `**Week of ${wk}:** ${excerpt}...`;
      }).join('\n\n');

  const prompt = `You are PNTHR, a sophisticated market intelligence system. Write the weekly "PNTHR's Perch" newsletter for the week of ${formatDateLong(weekOf)}.

PNTHR scans roughly 679 stocks across the S&P 500 and S&P 400 using a 21-week EMA trend-following model. Each week the system identifies stocks breaking into new uptrends (longs) or breaking down into downtrends (shorts), stocks approaching their breakout trigger (spring setups), and stocks compressing in tight Bollinger Bands ahead of a potential volatility expansion.

This week's data snapshot:

Current open positions (in-trade):
${dinnerSummary}

New entries this week, ranked by momentum quality:
${alphaSummary}

Setups coiling near breakout trigger:
${springSummary}

Bollinger Band compressions (pre-explosion):
${crouchSummary}

---

Prior weeks' narrative excerpts (for the lookback section):
${lookbackContext}

---

Write the newsletter with these EXACT sections in markdown:

# PNTHR's Perch — Week of ${formatDateLong(weekOf)}

## Market Pulse
3–4 sentences. Do not simply list what signals fired. Interpret what the market is telling us. Which sectors are leading long, which are breaking down, and what does that distribution say about the economy right now? Is institutional money rotating into defense and utilities because recession risk is real, or is this a healthy pause in a bull market? Is the weakness in consumer names at both the high and low end of the income spectrum, something a K-shaped economy would show, telling us something about consumer stress that the headlines are missing? Be specific about sectors, and be willing to make a case about what this moment in the market means.

## This Week's Prey
Highlight 3–5 specific names from the data above. For each: ticker, price, direction (long or short), and 2–3 sentences of interpretation. Do not just describe the signal. Ask why this stock is moving this way, what it says about its sector, and what that sector's behavior suggests about the broader economy. A major financial breaking down is not just a chart event, it is a statement about credit conditions, lending appetite, or systemic confidence. A healthcare name breaking up or down may reflect reimbursement pressure, demographic shifts, or risk-off rotation. Go deeper.

## The Squeeze Watch
Look at the compressed setups. Which sectors are sitting in tight coils right now, and what does that tell us about where the next big move is hiding? If technology and industrials are both compressing simultaneously, is that coincidence or is the market holding its breath ahead of a macro event? Interpret the tension, not just the list.

## The Perch — Looking Back
Humbly and specifically review prior calls. Which tickers highlighted in previous issues followed through, and which failed? Be honest. Own the misses. Cite specific names and weeks. If a pattern of misses is emerging in a particular sector, say so and ask what that tells us.

## Closing Thought
1–2 sentences. A forward-looking thought about what the market setup is signaling for the weeks ahead. Give the reader something to think about, not just something to act on.

---

CRITICAL TONE AND STYLE RULES:
- Never use em-dashes (the — character). Use commas, semicolons, colons, or rewrite the sentence instead.
- Write for an intelligent but general audience. Avoid proprietary system jargon. Say "current open long positions" not "Dinner longs." Say "momentum entries" not "Alpha signals." If you must reference a system category, explain it briefly in plain English.
- The goal is to help the reader think, not just inform them. Every section should leave the reader asking a question or forming an opinion about what is happening in the economy and markets.
- Tone: Analytical, confident, and opinionated, like a seasoned portfolio manager writing a weekly letter to investors. No hype. No filler. No emojis. Markdown only.`;

  console.log('[Newsletter] Calling Claude API...');
  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2000,
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
