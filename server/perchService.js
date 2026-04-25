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
import { fetchPreyData, findBestExits } from './newsletterService.js';
import { archiveThisWeeksExits } from './tradeArchiveWriter.js';
import { getAllTickers } from './constituents.js';
import { getSp400Longs, getSp400Shorts } from './sp400Service.js';
import { connectToDatabase } from './database.js';

// ── Model ─────────────────────────────────────────────────────────────────────
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8000;  // increased from 4000 — newsletters were getting cut off

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
  /\bexponential moving average\b/i, /\bmoving average\b/i,
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

// Sector classification for rotation analysis. Names MUST match the canonical
// GICS strings stored in pnthr_kill_scores (see sectorUtils.normalizeSector).
const DEFENSIVE_SECTORS = ['Utilities', 'Consumer Staples', 'Healthcare', 'Real Estate'];
const CYCLICAL_SECTORS  = ['Technology', 'Consumer Discretionary', 'Industrials', 'Financial Services', 'Energy', 'Basic Materials', 'Communication Services'];

async function getSectorRotationData(db, weekOf) {
  // Get previous week's sector breakdown for comparison
  const prevFriday = new Date(weekOf + 'T12:00:00Z');
  prevFriday.setUTCDate(prevFriday.getUTCDate() - 7);
  const prevWeekOf = prevFriday.toISOString().split('T')[0];

  const prevRows = await db.collection('pnthr_kill_scores').aggregate([
    { $match: { weekOf: prevWeekOf } },
    { $group: {
      _id: '$sector',
      totalBL: { $sum: { $cond: [{ $eq: ['$signal', 'BL'] }, 1, 0] } },
      totalSS: { $sum: { $cond: [{ $eq: ['$signal', 'SS'] }, 1, 0] } },
    }},
  ]).toArray();

  const prevMap = {};
  for (const r of prevRows) prevMap[r._id] = { totalBL: r.totalBL, totalSS: r.totalSS };

  return { prevWeekOf, prevMap };
}

function buildSectorRotationAnalysis(sectors, prevMap) {
  // Compute rotation metrics
  const rotationLines = [];
  let defensiveBL = 0, defensiveSS = 0, cyclicalBL = 0, cyclicalSS = 0;

  for (const s of sectors) {
    if (s.totalBL + s.totalSS === 0) continue;
    const total = s.totalBL + s.totalSS;
    const blPct = Math.round((s.totalBL / total) * 100);
    const prev = prevMap[s.sector];
    const prevTotal = prev ? prev.totalBL + prev.totalSS : 0;
    const prevBlPct = prevTotal > 0 ? Math.round((prev.totalBL / prevTotal) * 100) : null;

    // Week-over-week shift
    let shift = '';
    if (prev) {
      const blDelta = s.totalBL - prev.totalBL;
      const ssDelta = s.totalSS - prev.totalSS;
      if (blDelta > 0 && ssDelta <= 0) shift = 'improving';
      else if (ssDelta > 0 && blDelta <= 0) shift = 'deteriorating';
      else if (blDelta > 0 && ssDelta > 0) shift = 'expanding (both sides)';
      else if (blDelta === 0 && ssDelta === 0) shift = 'unchanged';
      else shift = 'mixed';
    }

    rotationLines.push(
      `${s.sector}: ${blPct}% long-leaning (${s.totalBL} active long opportunities / ${s.totalSS} active short opportunities)` +
      (prevBlPct !== null ? ` | was ${prevBlPct}% last week` : '') +
      (shift ? ` | trend: ${shift}` : '')
    );

    // Accumulate defensive vs cyclical
    if (DEFENSIVE_SECTORS.includes(s.sector)) {
      defensiveBL += s.totalBL;
      defensiveSS += s.totalSS;
    } else if (CYCLICAL_SECTORS.includes(s.sector)) {
      cyclicalBL += s.totalBL;
      cyclicalSS += s.totalSS;
    }
  }

  const defTotal = defensiveBL + defensiveSS;
  const cycTotal = cyclicalBL + cyclicalSS;
  const defPct = defTotal > 0 ? Math.round((defensiveBL / defTotal) * 100) : 0;
  const cycPct = cycTotal > 0 ? Math.round((cyclicalBL / cycTotal) * 100) : 0;

  let rotationType;
  if (defPct >= 70 && cycPct < 55) rotationType = 'RISK-OFF: Heavy defensive rotation. Capital is hiding in safe havens.';
  else if (cycPct >= 70 && defPct < 55) rotationType = 'RISK-ON: Aggressive cyclical rotation. Capital is chasing growth.';
  else if (defPct >= 60 && cycPct >= 60) rotationType = 'BROAD BULL: Both defensive and cyclical sectors leaning long. Broad market strength.';
  else if (defPct < 45 && cycPct < 45) rotationType = 'BROAD BEAR: Both defensive and cyclical sectors leaning short. Broad market weakness.';
  else rotationType = 'SELECTIVE: Mixed rotation. Capital is discriminating between sectors. No clear risk-on/risk-off trend.';

  return {
    rotationLines: rotationLines.join('\n'),
    defensiveSummary: `Defensive sectors (Utilities, Staples, Healthcare, Real Estate): ${defPct}% long-leaning (${defensiveBL} active long opportunities / ${defensiveSS} active short opportunities)`,
    cyclicalSummary: `Cyclical sectors (Tech, Discretionary, Industrials, Financials, Energy, Materials, Communication): ${cycPct}% long-leaning (${cyclicalBL} active long opportunities / ${cyclicalSS} active short opportunities)`,
    rotationType,
  };
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

// ── Upcoming-week earnings (PNTHR Calendar) ───────────────────────────────────
// Pulls the FMP earning calendar for the Mon–Fri that immediately follows the
// newsletter's Friday weekOf, then narrows it to the PNTHR 679 universe so
// The Week Ahead only surfaces companies the reader already tracks.
async function getUpcomingEarnings(weekOf) {
  const FMP_API_KEY = process.env.FMP_API_KEY;
  if (!FMP_API_KEY) return [];

  const fri = new Date(weekOf + 'T12:00:00Z');
  const mon = new Date(fri); mon.setUTCDate(fri.getUTCDate() + 3);
  const nfr = new Date(fri); nfr.setUTCDate(fri.getUTCDate() + 7);
  const from = mon.toISOString().split('T')[0];
  const to   = nfr.toISOString().split('T')[0];

  try {
    const [calendar, sp517, sp400L, sp400S] = await Promise.all([
      fetch(`https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${FMP_API_KEY}`)
        .then(r => r.json()).catch(() => []),
      getAllTickers(),
      getSp400Longs(),
      getSp400Shorts(),
    ]);
    if (!Array.isArray(calendar)) return [];
    const universe = new Set([...sp517, ...sp400L, ...sp400S]);
    return calendar
      .filter(e => e.symbol && !e.symbol.includes('.') && universe.has(e.symbol))
      .map(e => ({
        date:   e.date,
        ticker: e.symbol,
        name:   e.name || e.symbol,
        time:   e.time || null, // 'bmo' | 'amc' | null
      }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
  } catch (err) {
    console.warn('[Perch v3] Upcoming earnings fetch failed:', err.message);
    return [];
  }
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
   EMA, 21W EMA, 21-week EMA, exponential moving average, moving average
   (always say "the trend" instead),
   ALPHA PNTHR KILL, STRIKING, POUNCING,
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
- Signal counts by sector = "our model sees the most new opportunities in [sector]"
- Trend reference (21-week EMA, optimized EMA, any EMA variant) = always "the trend" (e.g. "above trend," "back above trend," "trending higher")`;

// The leading `---` and `## IMPORTANT DISCLOSURES` heading are emitted by the
// prompt's section-9 instruction. This template is the disclosure BODY only;
// paste it verbatim under the heading.
const DISCLAIMER = `PNTHR's Perch is published weekly by PNTHR Funds for informational and educational purposes only. Nothing contained in this newsletter constitutes investment advice, an investment recommendation, or a solicitation to buy, sell, short, or hold any security or financial instrument. The content reflects the opinions of the author as of the date of publication and is based on proprietary quantitative models and data analysis that may not be suitable for all investors.

SHORT SELLING RISK: This newsletter discusses both long and short trading opportunities. Short selling involves substantial risk, including the potential for unlimited losses. Short selling is not appropriate for all investors and requires a margin account. You should fully understand the risks of short selling before considering any short positions.

PAST PERFORMANCE IS NOT INDICATIVE OF FUTURE RESULTS. All investments involve risk, including the possible loss of principal. Historical returns, whether actual or indicated by the model's backtested or forward-tested track record, do not guarantee future performance. The model's signals are based on historical price patterns and technical indicators that may not persist in the future.

NO FIDUCIARY RELATIONSHIP: PNTHR Funds is not a registered investment advisor, broker-dealer, or financial planner. No fiduciary relationship exists between PNTHR Funds and the reader. You should consult with a qualified, registered financial advisor before making any investment decisions based on information presented in this newsletter.

CONFLICTS OF INTEREST: PNTHR Funds, its affiliates, principals, and employees may hold positions (long or short) in the securities discussed in this newsletter. Positions may be established or liquidated at any time without notice.

By reading this newsletter, you acknowledge that you are solely responsible for your own investment decisions and that PNTHR Funds bears no liability for any losses you may incur.

(c) 2026 PNTHR Funds. All rights reserved.`;

function buildUserPrompt({ weekOf, regime, sectors, top10Longs, top10Shorts, newSignals, tradeOfWeek, trackRecord, sectorRotation, upcomingEarnings, disclaimer }) {
  // Regime-driven directional filter. In BULL we hide short data so Claude
  // can't accidentally reference shorts; in BEAR we hide long data; in MIXED
  // we keep both. See feedback_perch_regime_aware_content.md for the rule.
  const isBull  = regime.regimeLabel === 'BULL';
  const isBear  = regime.regimeLabel === 'BEAR';

  // Format sector table for readability. Regime filter strips the irrelevant
  // side so the LLM can't quote it.
  const sectorLines = sectors
    .filter(s => s.totalBL + s.totalSS > 0)
    .map(s => {
      if (isBull) {
        return `${s.sector}: ${s.totalBL} active long opportunities${s.newBL ? ` (${s.newBL} new this week)` : ''} — ${s.lean} lean`;
      }
      if (isBear) {
        return `${s.sector}: ${s.totalSS} active short opportunities${s.newSS ? ` (${s.newSS} new this week)` : ''} — ${s.lean} lean`;
      }
      return `${s.sector}: ${s.totalBL} active long / ${s.totalSS} active short opportunities${s.newBL || s.newSS ? ` (${s.newBL} new long, ${s.newSS} new short this week)` : ''} — ${s.lean} lean`;
    })
    .join('\n');

  // Format top setups. Regime filter: in BULL we hide shorts, in BEAR we hide longs.
  const fmtLong  = isBear ? '' : top10Longs.slice(0, 5).map(s => `${s.ticker} (${s.sector ?? 'Unknown'}, $${s.currentPrice ?? 'N/A'})`).join(', ');
  const fmtShort = isBull ? '' : top10Shorts.slice(0, 5).map(s => `${s.ticker} (${s.sector ?? 'Unknown'}, $${s.currentPrice ?? 'N/A'})`).join(', ');

  // Format new signals by sector. Regime filter strips the off-trend side.
  const newSigLines = Object.entries(newSignals)
    .filter(([, v]) => v.newBL.length + v.newSS.length > 0)
    .map(([sec, v]) => {
      const parts = [];
      if (v.newBL.length && !isBear) parts.push(`${v.newBL.length} new long: ${v.newBL.join(', ')}`);
      if (v.newSS.length && !isBull) parts.push(`${v.newSS.length} new short: ${v.newSS.join(', ')}`);
      if (parts.length === 0) return null;
      return `${sec}: ${parts.join(' | ')}`;
    }).filter(Boolean).join('\n');

  // Format trade of week
  const totwSection = tradeOfWeek
    ? `TRADE OF THE WEEK (most profitable model exit this week):
Ticker: ${tradeOfWeek.ticker}
Company: ${tradeOfWeek.companyName || tradeOfWeek.ticker}
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

  // Upcoming-week earnings from the PNTHR Calendar (filtered to the 679
  // universe). Formatted by weekday so 'The Week Ahead' can cite specific
  // names without guessing.
  const earningsSection = (() => {
    if (!upcomingEarnings || upcomingEarnings.length === 0) {
      return 'PNTHR CALENDAR EARNINGS (upcoming Mon–Fri): No PNTHR-universe companies are scheduled to report this coming week.';
    }
    const byDate = new Map();
    for (const e of upcomingEarnings) {
      if (!byDate.has(e.date)) byDate.set(e.date, []);
      byDate.get(e.date).push(e);
    }
    const lines = [];
    for (const [date, items] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const label = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      const names = items.slice(0, 12).map(e => {
        const when = e.time === 'bmo' ? ' (before open)' : e.time === 'amc' ? ' (after close)' : '';
        return `${e.ticker} (${e.name})${when}`;
      }).join(', ');
      const extra = items.length > 12 ? ` — plus ${items.length - 12} more` : '';
      lines.push(`${label}: ${names}${extra}`);
    }
    return `PNTHR CALENDAR EARNINGS (upcoming Mon–Fri, companies in our 679 universe only):\n${lines.join('\n')}`;
  })();

  const regimeDesc = regime.regimeLabel === 'BULL'
    ? `BULL market: Both SPY (${regime.spy.position} trend, ${regime.spy.slope}) and QQQ (${regime.qqq.position} trend, ${regime.qqq.slope}) are in uptrends. The dominant trend is UP. Trade with the trend.`
    : regime.regimeLabel === 'BEAR'
    ? `BEAR market: Both SPY (${regime.spy.position} trend, ${regime.spy.slope}) and QQQ (${regime.qqq.position} trend, ${regime.qqq.slope}) are in downtrends. The dominant trend is DOWN. Trade with the trend.`
    : `MIXED market: SPY is ${regime.spy.position} its trend (${regime.spy.slope}), QQQ is ${regime.qqq.position} its trend (${regime.qqq.slope}). Selectivity is required — the indexes do not agree.`;

  // Regime-aware section instructions for sections 5 and 6 of the locked
  // 9-section format. In BULL we don't discuss shorts at all; in BEAR we
  // don't discuss longs. MIXED keeps both. See feedback memory.
  const longSideInstruction = isBear
    ? `## STOCKS TO WATCH: LONG SIDE — Replace the usual long picks with 1 short paragraph (3-5 sentences). The major indexes are in a clear downtrend right now, so we are not adding long positions this week. Explain in plain English why: when the broad market is trending down, individual long ideas tend to fight the tape; buying weakness because a stock looks cheap is the wrong instinct in this environment; the disciplined move is to wait until the major indexes turn back up before stepping in on the long side. Do NOT name any specific tickers. Do NOT use technical terms like "EMA", "moving average", "regime", or any signal codes.`
    : `## STOCKS TO WATCH: LONG SIDE (top 3-5 long setups, brief plain-English thesis per stock)`;

  const shortSideInstruction = isBull
    ? `## STOCKS TO WATCH: SHORT SIDE — Replace the usual short picks with 1 short paragraph (3-5 sentences). The major indexes are in a clear uptrend right now, so we are not taking short positions this week. Explain in plain English why: when the broad market is trending up, shorting individual names tends to fight the tape; selling strong markets because they feel extended is the wrong instinct in this environment; the disciplined move is to wait until the major indexes turn back down before stepping in on the short side. Do NOT name any specific tickers. Do NOT define what shorting is. Do NOT use technical terms like "EMA", "moving average", "regime", or any signal codes.`
    : `## STOCKS TO WATCH: SHORT SIDE (top 3-5 short setups, brief plain-English thesis per stock)`;

  // Regime stats line — strip the off-trend counts so the LLM can't quote them.
  const regimeStatsLine = isBull
    ? `Active long opportunities open: ${regime.blCount} (${regime.newBlCount} new this week)`
    : isBear
    ? `Active short opportunities open: ${regime.ssCount} (${regime.newSsCount} new this week)`
    : `Active long opportunities open: ${regime.blCount} (${regime.newBlCount} new this week) | Active short opportunities open: ${regime.ssCount} (${regime.newSsCount} new this week)`;

  const prevWeekLine = regime.prevWeek
    ? (isBull
        ? `Previous week: ${regime.prevWeek.blCount} active long (${regime.prevWeek.newBlCount} new)`
        : isBear
        ? `Previous week: ${regime.prevWeek.ssCount} active short (${regime.prevWeek.newSsCount} new)`
        : `Previous week: ${regime.prevWeek.blCount} active long / ${regime.prevWeek.ssCount} active short (${regime.prevWeek.newBlCount} new long, ${regime.prevWeek.newSsCount} new short)`)
    : '';

  return `Write this week's PNTHR's Perch newsletter for the week of ${weekOf}.

Use the data below to draw conclusions. Never expose raw data, signal codes, or scoring mechanics to the reader.

DATA LABEL GUARDRAIL — read carefully before writing:
- "active long opportunities" / "active short opportunities" = total positions still being tracked right now (a stock that the model flagged weeks ago and is still in the watchlist counts here).
- "new this week" = opportunities that appeared in the last 7 days. These are the only ones you may describe as "new", "fresh", or "this week".
- Do NOT call an "active" count "new". Example: "22 active long opportunities" must NEVER be paraphrased as "22 new long opportunities this week".
- When citing counts, use the exact phrasing from the data so the reader gets the right meaning.

MARKET REGIME:
${regimeDesc}
${regimeStatsLine}
${regime.vix ? `VIX: ${regime.vix}` : ''}
${prevWeekLine}

${isBull ? 'REGIME-DRIVEN CONTENT RULE: This is a BULL regime. Do NOT discuss shorts, short setups, short tickers, or "what to short" anywhere in this issue. The short-side data has been intentionally omitted from the inputs above. Section 6 has been replaced with an educational paragraph about not fighting the trend (see section 6 instructions below).' : ''}${isBear ? 'REGIME-DRIVEN CONTENT RULE: This is a BEAR regime. Do NOT discuss longs, long setups, long tickers, or "what to buy" anywhere in this issue. The long-side data has been intentionally omitted from the inputs above. Section 5 has been replaced with an educational paragraph about not fighting the trend (see section 5 instructions below).' : ''}${!isBull && !isBear ? 'REGIME-DRIVEN CONTENT RULE: This is a MIXED regime. Cover both sides but frame the week as one requiring SELECTIVITY — the indexes do not agree, so the reader should be more discriminating than usual.' : ''}

SECTOR BREAKDOWN (active opportunities by sector, plus new this week):
${sectorLines || 'No sector data available.'}

SECTOR ROTATION ANALYSIS (week-over-week changes, defensive vs cyclical flow):
${sectorRotation ? `${sectorRotation.rotationType}

${sectorRotation.defensiveSummary}
${sectorRotation.cyclicalSummary}

Per-sector detail with week-over-week trend:
${sectorRotation.rotationLines}` : 'No rotation data available.'}

${isBear ? 'TOP LONG SETUPS: REGIME-OMITTED. Bear regime — long-side setups intentionally suppressed.' : `TOP LONG SETUPS (highest-conviction opportunities on the long side):
${fmtLong || 'No long setups this week.'}`}

${isBull ? 'TOP SHORT SETUPS: REGIME-OMITTED. Bull regime — short-side setups intentionally suppressed.' : `TOP SHORT SETUPS (highest-conviction opportunities on the short side):
${fmtShort || 'No short setups this week.'}`}

NEW OPPORTUNITIES THIS WEEK (fresh setups, by sector):
${newSigLines || 'No new setups this week.'}

${totwSection}

${archiveSection}

${earningsSection}

Write the newsletter using the LOCKED section structure below. The section names, their order, and their markdown are a contract with the frontend rendering engine — do not rename, reorder, merge, split, or skip sections (other than explicit OMIT rules). Do NOT include a top-level title (no "# PNTHR's Perch") and do NOT include a date line (no "Week of...") — the frontend header already shows those. Start the output directly with the first ## section heading.

Use ## for each section heading exactly as shown. The nine sections below are the ONLY sections allowed, and they must appear in exactly this order:

1. ## THE OPENING (2-3 paragraphs, set the tone, take a position on what the week means)
2. ## PNTHR TRADE OF THE WEEK - [TICKER]   <-- REQUIRED section whenever TRADE OF THE WEEK data was provided above. Replace [TICKER] with the exact ticker symbol from the data (heading MUST be "## PNTHR TRADE OF THE WEEK - AAPL" style; the frontend extracts the ticker from this heading to render a chart button, so the format is not optional). Write 1-2 paragraphs about what the trade captured and what the reader should take away, then END the section with a 3-line blockquote callout formatted EXACTLY like this (one leading ">" per line, no blank lines between, no extra text):
   > **[TICKER] - [Company Name]** | [Sector]
   > [Long exit (trade closed profitably) / Short cover (trade closed profitably)]
   > **Profit: +$[X.XX] (+[X.XX]%)**
   Use "Long exit" when the trade direction from the data is long, "Short cover" when the direction is short. Use the exact profit dollar and % numbers from the data above, rounded to two decimals. Skip this section entirely ONLY if the TRADE OF THE WEEK data above literally says "No confirmed exits this week. OMIT".
3. ## SECTOR ROTATION (2-3 paragraphs analyzing how capital is flowing between sectors. Use the rotation data to tell the story: which sectors are getting stronger/weaker, is money rotating into defensive names or cyclical names, what does that say about institutional sentiment and risk appetite? Connect the rotation to macro context like tariffs, trade policy, interest rates, earnings, or geopolitical uncertainty. Be specific about which sectors are improving/deteriorating vs last week. This section should feel like institutional-grade market intelligence. NOTE: The frontend automatically renders a week-over-week sector-rotation bar chart at the end of this section — do NOT describe it as "above" or "below" or embed any chart yourself.)
4. ## WHERE THE MONEY IS MOVING (3-4 paragraphs, deeper dive into specific sector opportunities and stock-level themes)
5. ${longSideInstruction}
6. ${shortSideInstruction}
7. ## FROM THE ARCHIVES (ONLY if data provided above -- 2 sentences max)
8. ## THE WEEK AHEAD (1-2 forward-looking paragraphs. If PNTHR Calendar earnings data was provided above, explicitly call out the most notable companies reporting in the upcoming Mon–Fri window and what to watch for — only reference names from the PNTHR Calendar earnings list, NEVER from external sources or memory. If the data above says no companies are scheduled, say so plainly and pivot to what the reader should watch instead. Close with a sign-off on a new line: "Scott" then "PNTHR Funds" -- no comma before Scott.)
9. ## IMPORTANT DISCLOSURES (REQUIRED final section. Emit this EXACT block verbatim — a horizontal rule, then the heading, then the body below. No paraphrasing, no summarizing, no omissions. This section is legally required on every issue.):

---

## IMPORTANT DISCLOSURES

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

  const [sectors, top10Longs, top10Shorts, newSignals, tradeOfWeekFromArchive, rotationData] = await Promise.all([
    getSectorBreakdown(db, regime.weekOf),
    getTop10Longs(db, regime.weekOf),
    getTop10Shorts(db, regime.weekOf),
    getNewSignalsSummary(db, regime.weekOf),
    getTradeOfWeek(db, regime.weekOf),
    getSectorRotationData(db, regime.weekOf),
  ]);

  // Fallback: pnthr679_trade_archive is only refreshed by a manual CSV import
  // (scripts/importTradeArchive.js) — it had no ongoing writer and data went
  // stale at 2026-03-09. If the archive query returned no candidate for this
  // week, recompute from live signals AND upsert the week's exits into the
  // archive so both TOTW and 'From the Archives' have fresh data going
  // forward.
  let tradeOfWeek = tradeOfWeekFromArchive;
  if (!tradeOfWeek) {
    try {
      console.log('[Perch v3] Archive had no TOTW candidate for this week. Falling back to live signals...');
      const prey = await fetchPreyData();

      // Self-heal the archive: upsert this week's BE/SE exits.
      try {
        const { upserted, modified, total } = await archiveThisWeeksExits({
          weekOf:    regime.weekOf,
          signals:   prey.signals   || {},
          stockMeta: prey.stockMeta || {},
        });
        console.log(`[Perch v3] Archived ${total} weekly exits (${upserted} new, ${modified} updated) into pnthr679_trade_archive`);
      } catch (archErr) {
        console.warn('[Perch v3] Archive write failed (non-fatal):', archErr.message);
      }

      const { bestPct } = findBestExits(prey.signals || {}, prey.stockMeta || {}, regime.weekOf);
      if (bestPct) {
        tradeOfWeek = {
          ticker:       bestPct.ticker,
          companyName:  bestPct.companyName || bestPct.ticker,
          sector:       bestPct.sector || 'Unknown',
          direction:    bestPct.direction === 'long' ? 'LONG' : 'SHORT',
          entryDate:    null,
          exitDate:     regime.weekOf,
          profitPct:    bestPct.profitPct,
          profitDollar: bestPct.profitDollar,
          holdingWeeks: null,
          bigWinner:    bestPct.profitPct >= 20,
        };
        console.log(`[Perch v3] Live-signal TOTW: ${tradeOfWeek.ticker} +${tradeOfWeek.profitPct}%`);
      }
    } catch (err) {
      console.warn('[Perch v3] Live-signal TOTW fallback failed:', err.message);
    }
  }

  const trackRecord = await getFromArchives(db, tradeOfWeek?.ticker ?? null);

  // PNTHR Calendar earnings for the upcoming Mon–Fri, filtered to the 679
  // universe. Surfaced to the prompt so 'The Week Ahead' can call out the
  // specific names reporting next week without inventing them.
  const upcomingEarnings = await getUpcomingEarnings(regime.weekOf);
  console.log(`[Perch v3] Upcoming-week earnings in PNTHR universe: ${upcomingEarnings.length}`);

  // Build sector rotation analysis
  const sectorRotation = buildSectorRotationAnalysis(sectors, rotationData.prevMap);
  console.log(`[Perch v3] Sector rotation: ${sectorRotation.rotationType}`);

  // Chart data for the inline week-over-week sector rotation chart on the
  // rendered newsletter. Reuses the same totals the prompt already saw, so
  // the narrative and the chart can't drift apart. Sectors with <3 active
  // signals are filtered out as noisy. Sorted by thisWeek desc (longest bar
  // first) so the strongest sectors read from the top.
  const sectorRotationChart = sectors
    .filter(s => s.totalBL + s.totalSS >= 3)
    .map(s => {
      const thisTotal = s.totalBL + s.totalSS;
      const thisWeek  = Math.round((s.totalBL / thisTotal) * 100);
      const prev      = rotationData.prevMap[s.sector];
      const prevTotal = prev ? prev.totalBL + prev.totalSS : 0;
      const lastWeek  = prevTotal >= 3 ? Math.round((prev.totalBL / prevTotal) * 100) : null;
      const delta     = lastWeek == null ? null : thisWeek - lastWeek;
      return { sector: s.sector, thisWeek, lastWeek, delta };
    })
    .sort((a, b) => b.thisWeek - a.thisWeek);

  console.log(`[Perch v3] Data assembled — longs: ${top10Longs.length}, shorts: ${top10Shorts.length}, TOTW: ${tradeOfWeek?.ticker ?? 'none'}, archive: ${trackRecord?.ticker ?? 'none'}`);

  // 2. Build prompts
  const userPrompt = buildUserPrompt({
    weekOf: regime.weekOf,
    regime, sectors, top10Longs, top10Shorts,
    newSignals, tradeOfWeek, trackRecord,
    sectorRotation, upcomingEarnings,
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

  // ── Truncation check ──────────────────────────────────────────────────────
  if (response.stop_reason === 'max_tokens') {
    console.error('[Perch v3] ⚠ GENERATION TRUNCATED — hit max_tokens limit! Newsletter is incomplete.');
  }

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

  // 6. Truncation flag
  const wasTruncated = response.stop_reason === 'max_tokens';

  // 7. Return
  return {
    narrative,
    wasTruncated,
    blacklistViolations: violations,
    charts: {
      // Week-over-week sector long-lean %. The client renders this below the
      // SECTOR ROTATION section with yellow (this week) vs gray (last week)
      // bars.
      sectorRotation: sectorRotationChart,
    },
    // Structured TOTW record the frontend uses to rebuild the callout's
    // direction + profit lines when Claude renders only the ticker row.
    featuredTrade: tradeOfWeek ? {
      ticker:       tradeOfWeek.ticker,
      signal:       tradeOfWeek.signal ?? (tradeOfWeek.direction === 'short' ? 'SE' : 'BE'),
      direction:    tradeOfWeek.direction,
      profitDollar: tradeOfWeek.profitDollar ?? null,
      profitPct:    tradeOfWeek.profitPct    ?? null,
      companyName:  tradeOfWeek.companyName  ?? null,
      sector:       tradeOfWeek.sector       ?? null,
    } : null,
    metadata: {
      weekOf:         regime.weekOf,
      regimeLabel:    regime.regimeLabel,
      generatedAt:    new Date().toISOString(),
      model:          MODEL,
      stopReason:     response.stop_reason,
      dataInputs: {
        newLongs:       regime.newBlCount,
        newShorts:      regime.newSsCount,
        totalLongs:     regime.blCount,
        totalShorts:    regime.ssCount,
        topLong:        top10Longs[0]?.ticker  ?? null,
        topShort:       top10Shorts[0]?.ticker ?? null,
        tradeOfWeek:    tradeOfWeek?.ticker    ?? null,
        archiveTrade:   trackRecord?.ticker    ?? null,
        rotationType:   sectorRotation?.rotationType ?? null,
        upcomingEarningsCount: upcomingEarnings.length,
      },
    },
  };
}

// ── Generate + persist (single source of truth for cron AND admin route) ──────
// Both the Friday 5PM cron and the POST /api/newsletter/generate endpoint call
// this wrapper so there's exactly one generator. It runs generatePerch, upserts
// the doc into newsletter_issues, and returns the saved record.
export async function generateAndSavePerch(weekOfOverride) {
  const db = await connectToDatabase();
  if (!db) throw new Error('Database not available');

  const result = await generatePerch(db);
  const { narrative, wasTruncated, metadata, blacklistViolations, charts, featuredTrade } = result;
  const weekOf = weekOfOverride || metadata.weekOf;

  const col = db.collection('newsletter_issues');
  const existing = await col.findOne({ weekOf });
  const doc = {
    weekOf,
    status: 'draft',
    narrative,
    generatedAt: new Date(),
    generatorVersion: 'perch-v3',
    metadata,
    ...(charts && { charts }),
    ...(featuredTrade && { featuredTrade }),
    ...(wasTruncated && { wasTruncated: true }),
    ...(blacklistViolations.length > 0 && { blacklistViolations }),
  };

  if (existing) {
    await col.updateOne({ weekOf }, { $set: doc });
    return { ...existing, ...doc, _id: existing._id };
  }
  const insert = await col.insertOne(doc);
  return { ...doc, _id: insert.insertedId };
}
