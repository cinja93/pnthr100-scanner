// server/pnthrTreeScorecard.js
// ── RISK SCORECARD ───────────────────────────────────────────────────────────
// Scores how YOU managed each trade vs the UNTOUCHED strategy, per ticker, in % terms.
//   • Your trades  → reconstructed from pnthr_tree_fills (the forward fill ledger).
//   • Strategy     → the paper engine's trades (pnthr_tree_trades) — full-size in, stop out.
//   • Drawdown     → worst peak-to-trough dip off DAILY LOWS over each leg's holding window
//                    (pnthr_ai_bt_candles), so it's size-neutral and precise.
//   • Score        → return-per-drawdown (return% ÷ drawdown%); WIN if you matched/beat the
//                    return AND took less drawdown; MIXED / LOSS otherwise; plus a % edge.
// Forward-only: it can only score trades made AFTER the fill ledger started recording.
// The math lives in pure helpers (reconstructEpisodes / priceDrawdownPct / scoreEpisode)
// so it is unit-tested and proven correct before real trades arrive.
import { SECTORS as AI_SECTORS } from './scripts/aiUniverse/aiUniverseData.js';

const AI_META = {};
for (const s of AI_SECTORS) for (const h of s.holdings) AI_META[h.ticker] = { name: h.name, sector: s.sector };

// ── PURE: reconstruct closed trade episodes from a fill ledger ───────────────
// Walks each ticker's fills in time order. An episode opens on the first buy from flat and
// closes when net shares return to ≤0. Handles scaling in/out: weighted avg entry/exit,
// realized P&L on matched shares, peak shares held. Open (still-held) episodes are omitted.
export function reconstructEpisodes(fills, { includeOpen = false } = {}) {
  const byT = {};
  for (const f of fills) (byT[f.ticker] ||= []).push(f);
  const episodes = [];
  for (const [ticker, fs] of Object.entries(byT)) {
    fs.sort((a, b) => String(a.execTime || a.date).localeCompare(String(b.execTime || b.date)) || (a.side === 'BOT' ? -1 : 1));
    let net = 0, buyShares = 0, buyCost = 0, sellShares = 0, sellProceeds = 0, entryDate = null, maxShares = 0;
    const reset = () => { net = 0; buyShares = 0; buyCost = 0; sellShares = 0; sellProceeds = 0; entryDate = null; maxShares = 0; };
    for (const f of fs) {
      const sh = Math.abs(+f.shares || 0), px = +f.price || 0;
      if (f.side === 'BOT') {
        if (net <= 0) entryDate = f.date;          // opening a fresh episode
        net += sh; buyShares += sh; buyCost += sh * px; maxShares = Math.max(maxShares, net);
      } else {                                       // SLD
        net -= sh; sellShares += sh; sellProceeds += sh * px;
      }
      if (net <= 0 && buyShares > 0) {               // episode closed (flat)
        const matched = Math.min(buyShares, sellShares);
        const avgEntry = buyShares > 0 ? buyCost / buyShares : 0;
        const avgExit = sellShares > 0 ? sellProceeds / sellShares : 0;
        const costBasis = avgEntry * matched;
        const realizedPnl = (avgExit - avgEntry) * matched;
        episodes.push({
          ticker, entryDate, exitDate: f.date, shares: maxShares,
          avgEntry: +avgEntry.toFixed(2), avgExit: +avgExit.toFixed(2),
          costBasis: Math.round(costBasis), realizedPnl: Math.round(realizedPnl),
          returnPct: costBasis > 0 ? +((realizedPnl / costBasis) * 100).toFixed(2) : 0,
        });
        reset();
      }
    }
    // Still-open leg (currently held). Needed so a re-entry that hasn't closed yet can still
    // anchor a round-trip. avgExit/returnPct are null — it isn't closed.
    if (includeOpen && net > 0 && buyShares > 0) {
      const avgEntry = buyCost / buyShares;
      episodes.push({
        ticker, entryDate, exitDate: null, shares: maxShares,
        avgEntry: +avgEntry.toFixed(2), avgExit: null,
        costBasis: Math.round(avgEntry * maxShares), realizedPnl: 0, returnPct: null, open: true,
      });
    }
  }
  return episodes;
}

// ── PURE: pair each completed exit with the NEXT entry in the same name (a round trip) ──
// Trade-skill savings (Scott 2026-06-18): savings$ = (exit price − re-entry price) × shares.
// POSITIVE = you stepped aside and bought back lower (the drop you avoided in dollars);
// NEGATIVE = the move ran away and you re-entered higher (the round trip cost you). The
// re-entry leg may still be open — that's fine, we just need its entry price.
export function pairRoundTrips(legs) {
  const byT = {};
  for (const l of legs) (byT[l.ticker] ||= []).push(l);
  const trips = [];
  for (const [ticker, ls] of Object.entries(byT)) {
    ls.sort((a, b) => String(a.entryDate).localeCompare(String(b.entryDate)));
    for (let i = 0; i < ls.length - 1; i++) {
      const prev = ls[i], next = ls[i + 1];
      if (prev.exitDate == null || prev.avgExit == null) continue;   // prev must be a real (closed) exit
      const shares = Math.min(prev.shares || 0, next.shares || 0);
      if (shares <= 0) continue;
      trips.push({
        ticker, exitDate: prev.exitDate, exitPx: prev.avgExit,
        reentryDate: next.entryDate, reentryPx: next.avgEntry, shares,
        savings: Math.round((prev.avgExit - next.avgEntry) * shares),
        reentryOpen: !!next.open,
      });
    }
  }
  return trips;
}

// ── PURE: worst peak-to-trough drawdown (%) off daily lows over [start,end] ───
export function priceDrawdownPct(bars, startDate, endDate) {
  let peak = -Infinity, maxDD = 0;
  for (const b of bars) {
    if (b.date < startDate || b.date > endDate) continue;
    const hi = +b.high, lo = +b.low;
    if (hi > peak) peak = hi;
    if (peak > 0 && lo > 0) { const dd = (peak - lo) / peak; if (dd > maxDD) maxDD = dd; }
  }
  return +(maxDD * 100).toFixed(2);
}

// ── PURE: score your episode vs the strategy's (return-per-drawdown) ─────────
export function scoreEpisode(actual, strategy) {
  const eff = (r, dd) => dd > 0 ? r / dd : (r > 0 ? Infinity : 0);   // return per unit of drawdown
  const aEff = eff(actual.returnPct, actual.ddPct);
  const sEff = eff(strategy.returnPct, strategy.ddPct);
  const edgePct = (isFinite(sEff) && sEff > 0 && isFinite(aEff)) ? Math.round(((aEff / sEff) - 1) * 100) : null;
  const sameOrBetterReturn = actual.returnPct >= strategy.returnPct - 0.01;
  const lessOrEqualDD = actual.ddPct <= strategy.ddPct + 0.01;
  let verdict;
  if (sameOrBetterReturn && lessOrEqualDD) verdict = 'WIN';        // more (or equal) return for less (or equal) risk
  else if (!sameOrBetterReturn && !lessOrEqualDD) verdict = 'LOSS'; // less return AND more risk
  else verdict = 'MIXED';                                          // traded one for the other
  return { verdict, edgePct, actualEff: isFinite(aEff) ? +aEff.toFixed(2) : null, strategyEff: isFinite(sEff) ? +sEff.toFixed(2) : null };
}

// ── ORCHESTRATOR: build the scorecard from the DB ────────────────────────────
export async function getPnthrTreeScorecard(db) {
  const fills = await db.collection('pnthr_tree_fills').find({}).toArray();
  const paperTrades = await db.collection('pnthr_tree_trades').find({}).sort({ exitDate: 1 }).toArray();
  const openPaper = await db.collection('pnthr_tree_positions').find({ status: 'ACTIVE' }).toArray();

  // candles (daily OHLC) for every ticker we need a drawdown window or a mark-to-market on
  const tickers = [...new Set([...fills.map(f => f.ticker), ...paperTrades.map(t => t.ticker), ...openPaper.map(p => p.ticker)])];
  const candleDocs = tickers.length ? await db.collection('pnthr_ai_bt_candles').find({ ticker: { $in: tickers } }).toArray() : [];
  const barsByT = {};
  // sort ASCENDING — the stored .daily is newest-first, but lastBar()/mark-to-market need oldest→newest
  for (const d of candleDocs) barsByT[d.ticker] = (d.daily || []).map(b => ({ date: b.date, high: +b.high, low: +b.low, close: +b.close })).sort((a, b) => a.date.localeCompare(b.date));
  const lastBar = (t) => { const b = barsByT[t]; return b && b.length ? b[b.length - 1] : null; };
  const latestDate = Object.values(barsByT).reduce((m, b) => { const d = b.length ? b[b.length - 1].date : ''; return d > m ? d : m; }, '');

  // STRATEGY benchmark legs — the untouched engine. CLOSED legs from the trade ledger, PLUS
  // still-OPEN legs marked to the latest candle close, so a trade you exited while the strategy
  // is STILL holding it gets scored against the heat the strategy is sitting through ("so far"),
  // instead of falling through to "no strategy match".
  const strategyClosed = paperTrades.map(t => {
    const cost = (+t.entryPrice || 0) * (+t.shares || 0);
    return {
      ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate, shares: +t.shares || 0,
      avgEntry: +t.entryPrice || 0, avgExit: +t.exitPrice || 0, costBasis: Math.round(cost),
      realizedPnl: Math.round(+t.pnl || 0), returnPct: cost > 0 ? +(((+t.pnl || 0) / cost) * 100).toFixed(2) : 0,
      ddPct: priceDrawdownPct(barsByT[t.ticker] || [], t.entryDate, t.exitDate), open: false,
    };
  });
  const strategyOpen = openPaper.map(p => {
    const entry = +p.entryPrice || +p.avgCost || 0;
    const lb = lastBar(p.ticker); const mark = lb ? lb.close : entry; const markDate = lb ? lb.date : p.entryDate;
    return {
      // Still held → its overlap window runs to today (sentinel), not the last candle, so a trade
      // you closed TODAY (candles lag a day) still matches. DD/mark use the real last candle.
      ticker: p.ticker, entryDate: p.entryDate, exitDate: '9999-12-31', markDate, shares: p.totalShares || p.shares || 0,
      avgEntry: +entry.toFixed(2), avgExit: +mark.toFixed(2), costBasis: Math.round(entry * (p.totalShares || p.shares || 0)),
      realizedPnl: 0, returnPct: entry > 0 ? +(((mark - entry) / entry) * 100).toFixed(2) : 0,
      ddPct: priceDrawdownPct(barsByT[p.ticker] || [], p.entryDate, markDate), open: true,
    };
  });
  const strategyLegs = [...strategyClosed, ...strategyOpen];

  // YOUR legs (from the fill ledger) — closed episodes + the currently-open leg (for round trips)
  const yourLegs = reconstructEpisodes(fills, { includeOpen: true }).map(e => ({
    ...e, ddPct: e.exitDate ? priceDrawdownPct(barsByT[e.ticker] || [], e.entryDate, e.exitDate) : null,
  }));
  const actualEpisodes = yourLegs.filter(e => !e.open);   // only CLOSED trades are scored vs the strategy

  // Match each of YOUR closed trades to a strategy leg in the same name (overlapping dates;
  // closed legs first, else the still-open marked leg), then score on return-per-drawdown.
  const usedStrat = new Set();
  const scored = actualEpisodes.map(a => {
    let best = null, bestI = -1;
    strategyLegs.forEach((s, i) => {
      if (usedStrat.has(i) || s.ticker !== a.ticker) return;
      if (s.exitDate < a.entryDate || s.entryDate > a.exitDate) return;   // must overlap in time
      if (!best || (!s.open && best.open)) { best = s; bestI = i; }       // prefer a closed strategy leg
    });
    if (best) usedStrat.add(bestI);
    const company = AI_META[a.ticker]?.name || null, sector = AI_META[a.ticker]?.sector || null;
    if (!best) return { ...a, company, sector, strategy: null, score: null, ddAvoidedPct: null };
    const ddAvoidedPct = (a.ddPct != null && best.ddPct != null) ? +(best.ddPct - a.ddPct).toFixed(2) : null;
    return { ...a, company, sector, strategy: best, score: scoreEpisode(a, best), ddAvoidedPct };
  });

  // ── TRADE-SKILL SAVINGS — round trips (your exit → your next re-entry, $ avoided) ──
  const roundTrips = pairRoundTrips(yourLegs)
    .map(rt => ({ ...rt, company: AI_META[rt.ticker]?.name || null }))
    .sort((a, b) => String(b.exitDate).localeCompare(String(a.exitDate)));
  const savings = {
    totalSaved: roundTrips.reduce((a, rt) => a + rt.savings, 0),
    closedTrips: roundTrips.filter(rt => !rt.reentryOpen).length,
    openTrips: roundTrips.filter(rt => rt.reentryOpen).length,
    wins: roundTrips.filter(rt => rt.savings > 0).length,
    costs: roundTrips.filter(rt => rt.savings < 0).length,
  };

  const counts = scored.reduce((acc, s) => {
    const v = s.score?.verdict; if (v) acc[v] = (acc[v] || 0) + 1; return acc;
  }, { WIN: 0, MIXED: 0, LOSS: 0 });

  // Portfolio drawdown roll-up: YOUR actual AUM peak-to-trough vs the backtest's max DD.
  const aum = await db.collection('pnthr_tree_aum').find({}).sort({ date: 1 }).toArray();
  let peak = -Infinity, actualMaxDD = 0;
  for (const a of aum) { const v = +a.actualAum || 0; if (v > peak) peak = v; if (peak > 0) { const dd = (peak - v) / peak; if (dd > actualMaxDD) actualMaxDD = dd; } }
  let backtestDDPct = null;
  try { backtestDDPct = JSON.parse((await import('fs')).readFileSync(new URL('./data/treeProjectionBaseline.json', import.meta.url), 'utf8')).metrics?.maxDDPct ?? null; } catch { /* ignore */ }

  return {
    scored: scored.sort((a, b) => String(b.exitDate).localeCompare(String(a.exitDate))),
    strategyOnly: strategyLegs.filter((s, i) => !usedStrat.has(i) && !s.open).map(s => ({ ...s, company: AI_META[s.ticker]?.name || null })),
    roundTrips, savings,
    counts,
    portfolio: {
      actualMaxDDPct: +(actualMaxDD * 100).toFixed(2),
      backtestDDPct,
      aumDays: aum.length,
      since: aum.length ? aum[0].date : null,
    },
    fillsRecorded: fills.length,
    note: 'Forward-only: scores trades made after the fill ledger started. Drawdown = worst peak-to-trough dip off daily lows over each leg’s holding window. Savings = round trip: (exit − re-entry) × shares; strategy legs still held are marked to the latest close (“so far”).',
    updatedAt: new Date().toISOString(),
  };
}
