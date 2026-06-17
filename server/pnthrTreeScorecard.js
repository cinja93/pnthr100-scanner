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
export function reconstructEpisodes(fills) {
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
  }
  return episodes;
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

  // candles (daily OHLC) for every ticker we need a drawdown window on
  const tickers = [...new Set([...fills.map(f => f.ticker), ...paperTrades.map(t => t.ticker)])];
  const candleDocs = tickers.length ? await db.collection('pnthr_ai_bt_candles').find({ ticker: { $in: tickers } }).toArray() : [];
  const barsByT = {};
  for (const d of candleDocs) barsByT[d.ticker] = (d.daily || []).map(b => ({ date: b.date, high: +b.high, low: +b.low }));

  // STRATEGY episodes (the untouched benchmark)
  const strategyEpisodes = paperTrades.map(t => {
    const cost = (+t.entryPrice || 0) * (+t.shares || 0);
    return {
      ticker: t.ticker, entryDate: t.entryDate, exitDate: t.exitDate, shares: +t.shares || 0,
      avgEntry: +t.entryPrice || 0, avgExit: +t.exitPrice || 0, costBasis: Math.round(cost),
      realizedPnl: Math.round(+t.pnl || 0), returnPct: cost > 0 ? +(((+t.pnl || 0) / cost) * 100).toFixed(2) : 0,
      ddPct: priceDrawdownPct(barsByT[t.ticker] || [], t.entryDate, t.exitDate),
    };
  });

  // YOUR episodes (from the fill ledger)
  const actualEpisodes = reconstructEpisodes(fills).map(e => ({
    ...e, ddPct: priceDrawdownPct(barsByT[e.ticker] || [], e.entryDate, e.exitDate),
  }));

  // Match each of YOUR closed trades to the strategy's version of the same ticker (overlapping
  // dates), then score. Unmatched are surfaced too (you traded it / strategy didn't, or vice versa).
  const usedStrat = new Set();
  const scored = actualEpisodes.map(a => {
    let best = null, bestI = -1;
    strategyEpisodes.forEach((s, i) => {
      if (usedStrat.has(i) || s.ticker !== a.ticker) return;
      if (s.exitDate < a.entryDate || s.entryDate > a.exitDate) return;   // must overlap in time
      if (!best) { best = s; bestI = i; }
    });
    if (best) usedStrat.add(bestI);
    const company = AI_META[a.ticker]?.name || null, sector = AI_META[a.ticker]?.sector || null;
    if (!best) return { ...a, company, sector, strategy: null, score: null };
    return { ...a, company, sector, strategy: best, score: scoreEpisode(a, best) };
  });

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
    strategyOnly: strategyEpisodes.filter((_, i) => !usedStrat.has(i)).map(s => ({ ...s, company: AI_META[s.ticker]?.name || null })),
    counts,
    portfolio: {
      actualMaxDDPct: +(actualMaxDD * 100).toFixed(2),
      backtestDDPct,
      aumDays: aum.length,
      since: aum.length ? aum[0].date : null,
    },
    fillsRecorded: fills.length,
    note: 'Forward-only: scores trades made after the fill ledger started. Drawdown = worst peak-to-trough dip off daily lows over each leg’s holding window.',
    updatedAt: new Date().toISOString(),
  };
}
