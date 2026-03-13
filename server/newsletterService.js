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

  const prompt = `You are PNTHR, a sophisticated institutional-grade market intelligence system. Write the weekly "PNTHR's Perch" newsletter for the week of ${formatDateLong(weekOf)}.

PNTHR is a 21-week EMA-based trend-following system scanning ~679 stocks (S&P 500 + S&P 400 leaders). Signals:
- **BL (Buy Long)**: price breaks above 21-week EMA with momentum and structure
- **SS (Sell Short)**: price breaks below 21-week EMA with downward momentum
- **BE (Break Even / Exit Long)**: structural break — exit the long
- **SE (Short Exit)**: structure break — close the short

This week's scanner snapshot:

**PNTHR DINNER** — Current open BL/SS positions (highest conviction, in-trade):
${dinnerSummary}

**PNTHR ALPHA** — Recent BL/SS entries, ranked by momentum quality:
${alphaSummary}

**PNTHR SPRING** — Coiled setups approaching breakout trigger:
${springSummary}

**PNTHR CROUCH** — Bollinger Band squeeze (pre-explosion volatility compression):
${crouchSummary}

---

Prior weeks' narrative excerpts (for The Perch lookback):
${lookbackContext}

---

Write the newsletter with these EXACT sections in markdown:

# PNTHR's Perch — Week of ${formatDateLong(weekOf)}

## Market Pulse
2–3 sentences on the current market environment as suggested by the distribution of BL vs SS signals, activity in PNTHR Dinner and Alpha, and sector breadth.

## This Week's Prey
Highlight 3–5 specific names from Alpha, Spring, or Hunt. For each: ticker, signal type, and 1–2 sentences on why it stands out structurally. Be specific — price vs EMA, momentum, sector context.

## The Squeeze Watch
Comment on names in PNTHR Crouch. What sectors are compressing? What does the squeeze distribution signal about potential near-term volatility expansion?

## The Perch — Looking Back
Humbly and specifically review prior calls. Were tickers highlighted in previous issues that now show follow-through (or failed)? Be honest. When something worked, say so. When it didn't, own it. Cite specific tickers and weeks where possible.

## Closing Thought
1–2 sentences. A precise, forward-looking insight on what the panther is watching for next week.

---

Tone: Analytical, precise, confident — like a seasoned institutional trader who lets the data speak. No hype. No filler. No emojis. Markdown only.`;

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
