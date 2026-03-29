// server/perchService.js
// PNTHR's Perch v3 — MongoDB-powered newsletter generation
//
// Data sources (per diagnostic spec March 28, 2026):
//   pnthr_kill_regime   — Market regime (SPY/QQQ, signal counts) — Friday weekOf
//   pnthr_kill_scores   — Ranked Kill scores w/ sector — Friday weekOf
//   signal_history      — Weekly per-stock snapshots — Monday weekOf
//   pnthr679_trade_archive — 6,797 closed historical trades
//   pnthr_perch_track_record_log — Rotation log (avoid repeat archives)

import Anthropic from '@anthropic-ai/sdk';

// ── Model ─────────────────────────────────────────────────────────────────────
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4000;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Convert Friday weekOf (pnthr_kill_regime/scores) to Monday weekOf (signal_history)
function fridayToMonday(friday) {
  const d = new Date(friday + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 4);
  return d.toISOString().split('T')[0];
}

// Monday and Friday of the week containing the given Friday date
function weekBounds(fridayDate) {
  const fri = new Date(fridayDate + 'T12:00:00Z');
  const mon = new Date(fri);
  mon.setUTCDate(fri.getUTCDate() - 4);
  return { weekStart: mon, weekEnd: fri };
}

// Compute date N weeks before a given YYYY-MM-DD string
function weeksBack(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n * 7);
  return d.toISOString().split('T')[0];
}

// ── Blacklist ─────────────────────────────────────────────────────────────────

const BLACKLIST = [
  /\bBL\+\d+\b/, /\bSS\+\d+\b/,
  /\b(BL|SS)\b(?!\s*[a-z])/,  // BL/SS as standalone codes
  /\bBE\b/, /\bSE\b/,
  /\bKill Score\b/i, /\bKill Rank\b/i, /\bKill score\b/i,
  /\b(D1|D2|D3|D4|D5|D6|D7|D8)\b/,
  /\b21-?week EMA\b/i, /\bEMA\b/,
  /\bALPHA PNTHR KILL\b/i, /\bSTRIKING\b/, /\bPOUNCING\b/,
  /\bHUNTING\b/, /\bCOILING\b/, /\bSTALKING\b/, /\bTRACKING\b/,
  /\bPROWLING\b/, /\bSTIRRING\b/, /\bDORMANT\b/, /\bOVEREXTENDED\b/,
  /\bFEAST\b/, /\bHUNT\b/, /\bSPRINT\b/,
  /\bsignal age\b/i, /\bregime multiplier\b/i,
  /\bdiscipline score\b/i, /\banalyze score\b/i, /\bcomposite score\b/i,
  /\bconfirmation status\b/i, /\boverextension filter\b/i,
  /\bheat rules\b/i, /\bFriday pipeline\b/i, /\bapex cache\b/i,
  /\bsignal structure\b/i, /\bopen ratio\b/i, /\bnew ratio\b/i,
  /\bBollinger Band compression\b/i, /\bSpring Setup\b/i,
  /\bcase study\b/i, /\benriched signals\b/i,
];

function checkBlacklist(text) {
  const violations = [];
  for (const pattern of BLACKLIST) {
    const match = text.match(pattern);
    if (match) violations.push(match[0]);
  }
  return violations;
}

// ── Data Queries ──────────────────────────────────────────────────────────────

async function getRegimeData(db) {
  const regime = await db.collection('pnthr_kill_regime')
    .findOne({}, { sort: { weekOf: -1 } });
  if (!regime) throw new Error('No regime data found in pnthr_kill_regime');

  const prevArr = await db.collection('pnthr_kill_regime')
    .find({ weekOf: { $lt: regime.weekOf } })
    .sort({ weekOf: -1 })
    .limit(1)
    .toArray();
  const prev = prevArr[0] ?? null;

  const spyPos  = regime.spyAboveEma  ? 'above' : 'below';
  const spyDir  = regime.spyEmaRising ? 'rising' : 'falling';
  const qqqPos  = regime.qqqAboveEma  ? 'above' : 'below';
  const qqqDir  = regime.qqqEmaRising ? 'rising' : 'falling';
  const regimeLabel = (regime.spyAboveEma && regime.qqqAboveEma) ? 'BULL'
    : (!regime.spyAboveEma && !regime.qqqAboveEma) ? 'BEAR' : 'MIXED';

  return {
    weekOf:      regime.weekOf,
    regimeLabel,
    spy:  { position: spyPos, slope: spyDir, price: regime.spy?.close ?? null, ema21: regime.spy?.ema21 ?? null },
    qqq:  { position: qqqPos, slope: qqqDir, price: regime.qqq?.close ?? null, ema21: regime.qqq?.ema21 ?? null },
    blCount:    regime.blCount    ?? 0,
    ssCount:    regime.ssCount    ?? 0,
    newBlCount: regime.newBlCount ?? 0,
    newSsCount: regime.newSsCount ?? 0,
    vix:        regime.vix        ?? null,
    prevWeek: prev ? {
      blCount:    prev.blCount    ?? 0,
      ssCount:    prev.ssCount    ?? 0,
      newBlCount: prev.newBlCount ?? 0,
      newSsCount: prev.newSsCount ?? 0,
    } : null,
  };
}

async function getSectorBreakdown(db, weekOf) {
  // pnthr_kill_scores has sector + signal, Friday weekOf
  const rows = await db.collection('pnthr_kill_scores').aggregate([
    { $match: { weekOf } },
    { $group: {
      _id: '$sector',
      totalBL:  { $sum: { $cond: [{ $eq: ['$signal', 'BL'] }, 1, 0] } },
      totalSS:  { $sum: { $cond: [{ $eq: ['$signal', 'SS'] }, 1, 0] } },
      newBL:    { $sum: { $cond: [{ $and: [{ $eq: ['$signal', 'BL'] }, { $lte: ['$signalAge', 1] }] }, 1, 0] } },
      newSS:    { $sum: { $cond: [{ $and: [{ $eq: ['$signal', 'SS'] }, { $lte: ['$signalAge', 1] }] }, 1, 0] } },
    }},
    { $sort: { totalSS: -1 } },
  ]).toArray();

  return rows.map(r => ({
    sector:  r._id ?? 'Unknown',
    totalBL: r.totalBL,
    totalSS: r.totalSS,
    newBL:   r.newBL,
    newSS:   r.newSS,
    lean:    r.totalSS > r.totalBL ? 'bearish' : r.totalBL > r.totalSS ? 'bullish' : 'neutral',
  }));
}

async function getTop10Longs(db, weekOf) {
  return db.collection('pnthr_kill_scores')
    .find({ weekOf, signal: 'BL' })
    .sort({ totalScore: -1 })
    .limit(10)
    .project({ ticker: 1, sector: 1, currentPrice: 1, totalScore: 1, signalAge: 1, _id: 0 })
    .toArray();
}

async function getTop10Shorts(db, weekOf) {
  return db.collection('pnthr_kill_scores')
    .find({ weekOf, signal: 'SS' })
    .sort({ totalScore: -1 })
    .limit(10)
    .project({ ticker: 1, sector: 1, currentPrice: 1, totalScore: 1, signalAge: 1, _id: 0 })
    .toArray();
}

async function getNewSignalsSummary(db, weekOf) {
  const rows = await db.collection('pnthr_kill_scores')
    .find({ weekOf, signalAge: { $lte: 1 } })
    .project({ ticker: 1, signal: 1, sector: 1, currentPrice: 1, _id: 0 })
    .toArray();

  const bySector = {};
  for (const r of rows) {
    const sec = r.sector ?? 'Unknown';
    if (!bySector[sec]) bySector[sec] = { newBL: [], newSS: [] };
    if (r.signal === 'BL') bySector[sec].newBL.push(r.ticker);
    else if (r.signal === 'SS') bySector[sec].newSS.push(r.ticker);
  }
  return bySector;
}

async function getTradeOfWeek(db, weekOf) {
  // Trade of the Week = most profitable CONFIRMED exit in pnthr679_trade_archive
  // where exitDate falls within the current week (Monday-Friday).
  // closeConvictionPct >= 8 ensures we're in the 70%+ win rate universe, not the 42% baseline.
  const { weekStart, weekEnd } = weekBounds(weekOf);

  const rows = await db.collection('pnthr679_trade_archive')
    .find({
      exitDate:           { $gte: weekStart, $lte: weekEnd },
      exitSignal:         { $in: ['BE', 'SE'] },
      closeConvictionPct: { $gte: 8 },
      profitPct:          { $gt: 0 },
    })
    .sort({ profitPct: -1 })
    .limit(1)
    .toArray();

  if (rows.length === 0) return null;
  const best = rows[0];

  return {
    ticker:       best.ticker,
    sector:       best.sector ?? 'Unknown',
    direction:    best.signal === 'BL' ? 'LONG' : 'SHORT',
    entryDate:    best.entryDate instanceof Date ? best.entryDate.toISOString().split('T')[0] : best.entryDate,
    exitDate:     best.exitDate  instanceof Date ? best.exitDate.toISOString().split('T')[0]  : best.exitDate,
    profitPct:    best.profitPct,
    holdingWeeks: best.holdingWeeks ?? null,
    bigWinner:    best.bigWinner ?? (best.profitPct >= 20),
  };
}

async function getFromArchives(db, totwTicker) {
  // Don't repeat a stock within 8 weeks
  const eightWeeksAgo = weeksBack(new Date().toISOString().split('T')[0], 8);
  const recentDocs = await db.collection('pnthr_perch_track_record_log')
    .find({ featuredWeekOf: { $gte: eightWeeksAgo } })
    .project({ ticker: 1 })
    .toArray();
  const recentTickers = recentDocs.map(d => d.ticker);
  if (totwTicker) recentTickers.push(totwTicker);

  // Every ~6 weeks feature a loser for credibility (check log count to determine)
  const totalLogged = await db.collection('pnthr_perch_track_record_log').countDocuments();
  const featureLoser = totalLogged > 0 && totalLogged % 6 === 0;

  let candidate = null;
  if (featureLoser) {
    const losers = await db.collection('pnthr679_trade_archive')
      .find({
        isWinner: false,
        closeConvictionPct: { $gte: 8 },
        profitPct: { $lt: -5 },
        ticker: { $nin: recentTickers },
      })
      .sort({ profitPct: 1 })
      .limit(5)
      .toArray();
    candidate = losers[Math.floor(Math.random() * Math.min(losers.length, 3))] ?? null;
  }

  if (!candidate) {
    const winners = await db.collection('pnthr679_trade_archive')
      .find({
        isWinner: true,
        closeConvictionPct: { $gte: 8 },
        profitPct: { $gte: 15 },
        ticker: { $nin: recentTickers },
      })
      .sort({ profitPct: -1 })
      .limit(20)
      .toArray();

    if (winners.length === 0) return null;
    // Pick randomly from the top 10 pool for variety
    const pool = winners.slice(0, Math.min(10, winners.length));
    candidate = pool[Math.floor(Math.random() * pool.length)];
  }

  if (!candidate) return null;

  return {
    ticker:      candidate.ticker,
    sector:      candidate.sector ?? 'Unknown',
    direction:   candidate.signal === 'BL' ? 'LONG' : 'SHORT',
    entryDate:   candidate.entryDate instanceof Date
      ? candidate.entryDate.toISOString().split('T')[0]
      : candidate.entryDate,
    exitDate:    candidate.exitDate instanceof Date
      ? candidate.exitDate.toISOString().split('T')[0]
      : candidate.exitDate,
    profitPct:   candidate.profitPct,
    holdingWeeks: candidate.holdingWeeks,
    bigWinner:   candidate.bigWinner,
    isLoss:      !candidate.isWinner,
  };
}

// ── Prompt Templates ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Scott, the founder of PNTHR Funds, writing your weekly market newsletter called "PNTHR's Perch." You are an opinionated market strategist who runs a proprietary quantitative model that scans nearly 700 large-cap US stocks every week. You use data-driven insights to identify where money is flowing, which sectors are leading or lagging, and which individual stocks have the highest-conviction setups on both the long and short side.

YOUR VOICE:
- Confident but never arrogant. You have strong opinions backed by data, but you respect the reader.
- You write in first person plural ("we" for PNTHR Funds).
- Short, punchy sentences mixed with longer analytical ones. Varied rhythm.
- You respect the reader's intelligence. No hand-holding, no dumbing down, but also no jargon that only a quant would understand.
- You are direct. You take positions. "Energy is the place to be right now" not "Energy might be worth considering."
- You are approachable. The average investor should feel welcomed, not excluded.
- When discussing short setups, be objective and measured. Never gleeful about declines.
- When you are wrong, you own it. When you are right, you let the numbers speak.
- No em dashes anywhere. Use commas, periods, or semicolons instead.

CRITICAL RULES -- NEVER VIOLATE:

1. BLACKLISTED TERMS (never use any of these):
   BL, SS, BL+1, SS+1, BE, SE, Kill Score, Kill Rank, D1, D2, D3, D4, D5, D6, D7, D8,
   EMA (say "moving average" generically if needed), ALPHA PNTHR KILL, STRIKING, POUNCING,
   HUNTING, COILING, STALKING, TRACKING, PROWLING, STIRRING, DORMANT, OVEREXTENDED,
   FEAST, HUNT, SPRINT, signal age, regime multiplier, discipline score, analyze score,
   composite score, confirmation status, overextension filter, heat rules, Friday pipeline,
   apex cache, signal structure, open ratio, new ratio, Bollinger Band compression,
   Spring Setup, case study, enriched signals

2. NEVER explain how the model works mechanically. The reader trusts the conclusions.

3. NEVER reference internal scoring, tier names, or dimension breakdowns.

4. Translate all model outputs into plain market language using the translation guide below.

5. Use market-standard terms: momentum, trend, relative strength, rotation, conviction, setup, opportunity.

6. NUMBERS THAT ARE OKAY: stock prices, percentage returns, sector ETF performance.
   Frame signal counts as "our model identified X new opportunities" not "X signals fired."

7. Always include the full legal disclaimer exactly as provided in the data payload.

8. Keep total length between 1,200 and 2,000 words (excluding disclaimer).

9. No em dashes anywhere in the output.

10. BOTH DIRECTIONS: Always make clear that the model trades long AND short.
    When featuring short setups, include a brief plain-language explanation of short selling
    for readers who may be unfamiliar.

TRANSLATION GUIDE:
- BL / new long signal = "buy candidate" / "new long opportunity" / "fresh upside momentum"
- SS / new short signal = "short candidate" / "new short opportunity" / "our model sees downside"
- BE exit = "exit signal" / "time to take profits" / "momentum faded"
- SE exit = "cover signal" / "short thesis played out" / "downside exhausted"
- Model rank = "ranks highest in our model" / "top-ranked setup"
- Conviction filter = "fully confirmed setup" / "all conditions met"
- 679 universe = "nearly 700 large-cap US stocks"
- Signal counts by sector = "our model sees the most new opportunities in [sector]"`;

const DISCLAIMER = `---

IMPORTANT DISCLOSURES

PNTHR's Perch is published weekly by PNTHR Funds for informational and educational purposes only. Nothing contained in this newsletter constitutes investment advice, an investment recommendation, or a solicitation to buy, sell, short, or hold any security or financial instrument. The content reflects the opinions of the author as of the date of publication and is based on proprietary quantitative models and data analysis that may not be suitable for all investors.

SHORT SELLING RISK: This newsletter discusses both long and short trading opportunities. Short selling involves substantial risk, including the potential for unlimited losses. Short selling is not appropriate for all investors and requires a margin account. You should fully understand the risks of short selling before considering any short positions.

PAST PERFORMANCE IS NOT INDICATIVE OF FUTURE RESULTS. All investments involve risk, including the possible loss of principal. Historical returns, whether actual or indicated by the model's backtested or forward-tested track record, do not guarantee future performance. The model's signals are based on historical price patterns and technical indicators that may not persist in the future.

NO FIDUCIARY RELATIONSHIP: PNTHR Funds is not a registered investment advisor, broker-dealer, or financial planner. No fiduciary relationship exists between PNTHR Funds and the reader. You should consult with a qualified, registered financial advisor before making any investment decisions based on information presented in this newsletter.

CONFLICTS OF INTEREST: PNTHR Funds, its affiliates, principals, and employees may hold positions (long or short) in the securities discussed in this newsletter. Positions may be established or liquidated at any time without notice.

By reading this newsletter, you acknowledge that you are solely responsible for your own investment decisions and that PNTHR Funds bears no liability for any losses you may incur.

(c) 2026 PNTHR Funds. All rights reserved.`;

function buildUserPrompt({ weekOf, regime, sectors, top10Longs, top10Shorts, newSignals, tradeOfWeek, trackRecord, disclaimer }) {
  // Format sector table for readability
  const sectorLines = sectors
    .filter(s => s.totalBL + s.totalSS > 0)
    .map(s => `${s.sector}: ${s.totalBL} long / ${s.totalSS} short opportunities open${s.newBL || s.newSS ? ` (${s.newBL} new long, ${s.newSS} new short this week)` : ''} — ${s.lean} lean`)
    .join('\n');

  // Format top setups
  const fmtLong  = top10Longs.slice(0, 5).map(s => `${s.ticker} (${s.sector ?? 'Unknown'}, $${s.currentPrice ?? 'N/A'})`).join(', ');
  const fmtShort = top10Shorts.slice(0, 5).map(s => `${s.ticker} (${s.sector ?? 'Unknown'}, $${s.currentPrice ?? 'N/A'})`).join(', ');

  // Format new signals by sector
  const newSigLines = Object.entries(newSignals)
    .filter(([, v]) => v.newBL.length + v.newSS.length > 0)
    .map(([sec, v]) => {
      const parts = [];
      if (v.newBL.length) parts.push(`${v.newBL.length} new long: ${v.newBL.join(', ')}`);
      if (v.newSS.length) parts.push(`${v.newSS.length} new short: ${v.newSS.join(', ')}`);
      return `${sec}: ${parts.join(' | ')}`;
    }).join('\n');

  // Format trade of week
  const totwSection = tradeOfWeek
    ? `TRADE OF THE WEEK (most profitable model exit this week):
Ticker: ${tradeOfWeek.ticker}
Sector: ${tradeOfWeek.sector}
Direction: ${tradeOfWeek.direction}
Exit Date: ${tradeOfWeek.exitDate}
Return: +${tradeOfWeek.profitPct?.toFixed(2)}%${tradeOfWeek.profitDollar ? ` / +$${tradeOfWeek.profitDollar.toFixed(2)}` : ''}${tradeOfWeek.holdingWeeks ? ` over ${tradeOfWeek.holdingWeeks} weeks` : ''}
Big Winner: ${tradeOfWeek.bigWinner ? 'Yes (20%+ return)' : 'No'}`
    : 'TRADE OF THE WEEK: No confirmed exits this week. OMIT this section entirely.';

  // Format track record / From the Archives
  const archiveSection = trackRecord
    ? `FROM THE ARCHIVES (past confirmed trade to feature):
Ticker: ${trackRecord.ticker}
Sector: ${trackRecord.sector}
Direction: ${trackRecord.direction}
Entry: ${trackRecord.entryDate}
Exit: ${trackRecord.exitDate}
Return: ${trackRecord.isLoss ? '' : '+'}${trackRecord.profitPct?.toFixed(1)}%
Holding Period: ${trackRecord.holdingWeeks} weeks
${trackRecord.isLoss ? 'NOTE: This is a LOSING trade. Frame as: "Not every call works out. Discipline means taking losses quickly and moving on."' : ''}`
    : 'FROM THE ARCHIVES: OMIT this section entirely.';

  const regimeDesc = regime.regimeLabel === 'BULL'
    ? `BULL market: Both SPY (${regime.spy.position} trend, ${regime.spy.slope}) and QQQ (${regime.qqq.position} trend, ${regime.qqq.slope}) are in uptrends.`
    : regime.regimeLabel === 'BEAR'
    ? `BEAR market: Both SPY (${regime.spy.position} trend, ${regime.spy.slope}) and QQQ (${regime.qqq.position} trend, ${regime.qqq.slope}) are in downtrends.`
    : `MIXED market: SPY is ${regime.spy.position} its trend (${regime.spy.slope}), QQQ is ${regime.qqq.position} its trend (${regime.qqq.slope}).`;

  return `Write this week's PNTHR's Perch newsletter for the week of ${weekOf}.

Use the data below to draw conclusions. Never expose raw data, signal codes, or scoring mechanics to the reader.

MARKET REGIME:
${regimeDesc}
Total long opportunities open: ${regime.blCount} | Total short opportunities open: ${regime.ssCount}
New long opportunities this week: ${regime.newBlCount} | New short opportunities this week: ${regime.newSsCount}
${regime.vix ? `VIX: ${regime.vix}` : ''}
${regime.prevWeek ? `Previous week: ${regime.prevWeek.blCount} long / ${regime.prevWeek.ssCount} short open (${regime.prevWeek.newBlCount} new long, ${regime.prevWeek.newSsCount} new short)` : ''}

SECTOR BREAKDOWN (long vs short opportunities, new opportunities this week):
${sectorLines || 'No sector data available.'}

TOP LONG SETUPS (highest-conviction opportunities on the long side):
${fmtLong || 'No long setups this week.'}

TOP SHORT SETUPS (highest-conviction opportunities on the short side):
${fmtShort || 'No short setups this week.'}

NEW OPPORTUNITIES THIS WEEK (fresh setups, by sector):
${newSigLines || 'No new setups this week.'}

${totwSection}

${archiveSection}

Write the newsletter in this section structure. Do NOT include a title, headline, or date at the top — the frontend already displays the branded header. Start directly with section 1:

1. The Opening (2-3 paragraphs, set the tone, take a position on what the week means)
2. Where the Money Is Moving (3-4 paragraphs, sector rotation story)
3. Trade of the Week (1-2 paragraphs + callout -- ONLY if data provided above)
4. Stocks to Watch: Long Side (top 3-5 long setups, brief thesis per stock)
5. Stocks to Watch: Short Side (top 3-5 short setups, include a sentence explaining short selling for unfamiliar readers)
6. From the Archives (ONLY if data provided above -- 2 sentences max)
7. The Week Ahead (1-2 forward-looking paragraphs, close with a sign-off on a new line: "Scott" then "PNTHR Funds" -- no comma before Scott)
8. Legal Disclaimer (use this EXACTLY as written below):

${disclaimer}

Remember: use the data to draw conclusions. Never show the data itself.
Write as Scott. Confident, direct, approachable. No em dashes. No jargon.`;
}

// ── Main Export ───────────────────────────────────────────────────────────────

export async function generatePerch(db) {
  console.log('[Perch v3] Starting generation...');

  // 1. Fetch all data sources in parallel
  const regime = await getRegimeData(db);
  console.log(`[Perch v3] Regime: ${regime.regimeLabel}, weekOf: ${regime.weekOf}`);

  const [sectors, top10Longs, top10Shorts, newSignals, tradeOfWeek] = await Promise.all([
    getSectorBreakdown(db, regime.weekOf),
    getTop10Longs(db, regime.weekOf),
    getTop10Shorts(db, regime.weekOf),
    getNewSignalsSummary(db, regime.weekOf),
    getTradeOfWeek(db, regime.weekOf),
  ]);

  const trackRecord = await getFromArchives(db, tradeOfWeek?.ticker ?? null);

  console.log(`[Perch v3] Data assembled — longs: ${top10Longs.length}, shorts: ${top10Shorts.length}, TOTW: ${tradeOfWeek?.ticker ?? 'none'}, archive: ${trackRecord?.ticker ?? 'none'}`);

  // 2. Build prompts
  const userPrompt = buildUserPrompt({
    weekOf: regime.weekOf,
    regime, sectors, top10Longs, top10Shorts,
    newSignals, tradeOfWeek, trackRecord,
    disclaimer: DISCLAIMER,
  });

  // 3. Call Claude API
  console.log('[Perch v3] Calling Claude API...');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  let narrative = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  // Strip redundant title/date lines — the frontend header already shows these
  narrative = narrative
    .replace(/^#\s+PNTHR['']s Perch\s*\n+/i, '')
    .replace(/^Week of [A-Za-z]+ \d+,\s*\d+\s*\n+/m, '')
    .trimStart();

  // 4. Blacklist check
  const violations = checkBlacklist(narrative);
  if (violations.length > 0) {
    console.warn(`[Perch v3] ⚠ Blacklist violations found: ${violations.join(', ')}`);
  } else {
    console.log('[Perch v3] ✅ Blacklist check passed — zero violations');
  }

  // 5. Log the Archive trade to prevent repeats
  if (trackRecord) {
    await db.collection('pnthr_perch_track_record_log').insertOne({
      ticker:          trackRecord.ticker,
      featuredWeekOf:  regime.weekOf,
      profitPct:       trackRecord.profitPct,
      direction:       trackRecord.direction,
      section:         'FROM_ARCHIVES',
      createdAt:       new Date(),
    });
  }
  if (tradeOfWeek) {
    await db.collection('pnthr_perch_track_record_log').insertOne({
      ticker:          tradeOfWeek.ticker,
      featuredWeekOf:  regime.weekOf,
      profitPct:       tradeOfWeek.profitPct,
      direction:       tradeOfWeek.direction,
      section:         'TRADE_OF_WEEK',
      createdAt:       new Date(),
    });
  }

  // 6. Return
  return {
    narrative,
    blacklistViolations: violations,
    metadata: {
      weekOf:         regime.weekOf,
      regimeLabel:    regime.regimeLabel,
      generatedAt:    new Date().toISOString(),
      model:          MODEL,
      dataInputs: {
        newLongs:      regime.newBlCount,
        newShorts:     regime.newSsCount,
        totalLongs:    regime.blCount,
        totalShorts:   regime.ssCount,
        topLong:       top10Longs[0]?.ticker  ?? null,
        topShort:      top10Shorts[0]?.ticker ?? null,
        tradeOfWeek:   tradeOfWeek?.ticker    ?? null,
        archiveTrade:  trackRecord?.ticker    ?? null,
      },
    },
  };
}
