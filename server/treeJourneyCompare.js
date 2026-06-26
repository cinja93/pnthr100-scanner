// server/treeJourneyCompare.js
// ── TREE PLAN vs YOUR MANAGEMENT ─────────────────────────────────────────────
// Answers Scott's question (2026-06-26): for every stock TREE entered, does my
// active in-and-out management beat just leaving TREE alone?
//
//   A — the untouched PLAN: bought at your original TREE entry, held with TREE's
//       real raise-only 2-week-low − $0.01 trailing stop (+ $250 breakeven snap),
//       exits the day that stop is hit (loss OR trailed profit). Simulated forward
//       on daily bars — byte-for-byte the locked treeSim rule (server/backtest/treeSim.js).
//   B — what you ACTUALLY did: your real fills on that name over the same journey
//       (early exits, re-entries, or just staying out).
//   edge = B − A : positive = your management beat the plan; negative = the ins/outs
//       (or staying out of a name that recovered) cost you vs holding.
//
// A is MODELED (daily-bar counterfactual), B is REAL fills. Labeled as such.
// Both anchor on your actual original fill price, so the comparison isolates ONLY
// what you did after entry — an overnight gap hits A and B equally and cancels out.
import { reconstructEpisodes } from './pnthrTreeScorecard.js';
import { fetchFMP } from './stockService.js';

const STOP_LOOKBACK   = 10;    // 2 trading weeks (matches treeSim + the live engine)
const BE_SNAP_PROFIT  = 250;   // breakeven snap: ≥ $250 open profit on a green day → stop to entry

// loStop[i] = lowest low of the prior STOP_LOOKBACK bars (EXCLUDING today) — the same
// reference treeSim.js uses. null until a full window exists.
export function computeLoStop(bars) {
  const out = new Array(bars.length).fill(null);
  for (let i = STOP_LOOKBACK; i < bars.length; i++) {
    let sl = Infinity;
    for (let j = i - STOP_LOOKBACK; j < i; j++) if (bars[j].low < sl) sl = bars[j].low;
    out[i] = sl;
  }
  return out;
}

// PURE: simulate TREE's untouched exit forward from an entry bar. Mirrors treeSim's
// daily loop: trail the stop up to the 2-week low, gap-through exit at min(stop, open),
// breakeven snap at the close (governs the next bar). Returns the plan's exit or open state.
export function planExit(bars, loStop, entryIdx, entryFill, shares, beSnap = BE_SNAP_PROFIT) {
  let stop = loStop[entryIdx] != null ? +(loStop[entryIdx] - 0.01).toFixed(2) : null;   // initial stop set at entry
  for (let i = entryIdx + 1; i < bars.length; i++) {
    const bar = bars[i];
    if (loStop[i] != null) { const s = +(loStop[i] - 0.01).toFixed(2); stop = stop == null ? s : Math.max(stop, s); }   // raise-only trail
    if (stop != null && bar.low <= stop) {
      const exitPx = Math.min(stop, bar.open);   // gap-through: a gap-open below the stop fills at the open
      return { exited: true, exitIdx: i, exitDate: bar.date, exitPrice: +exitPx.toFixed(2), reason: stop >= entryFill ? 'TRAIL_PROFIT' : 'STOP_LOSS', daysHeld: i - entryIdx };
    }
    if (beSnap > 0 && bar.close >= bar.open && (bar.close - entryFill) * shares >= beSnap) {   // BE snap on a green day
      const be = +entryFill.toFixed(2); if (stop == null || be > stop) stop = be;
    }
  }
  const last = bars[bars.length - 1];
  return { exited: false, lastDate: last?.date || null, lastClose: last?.close ?? null, stop, daysHeld: bars.length - 1 - entryIdx };
}

// ── ORCHESTRATOR ─────────────────────────────────────────────────────────────
export async function buildTreeJourneyCompare(db) {
  // LIVE fills only (real money, post go-live) — same basis as the scorecard.
  const fills = await db.collection('pnthr_tree_fills').find({ mode: { $ne: 'paper' } }).toArray();
  if (!fills.length) return { rows: [], totals: { planNet: 0, actualNet: 0, edge: 0 }, note: 'No live fills yet.' };

  const tickers = [...new Set(fills.map(f => f.ticker))];

  // daily candles WITH open (treeSim needs the open for gap-through fills). Stored newest-first → sort asc.
  const candleDocs = await db.collection('pnthr_ai_bt_candles').find({ ticker: { $in: tickers } }).toArray();
  const barsByT = {};
  for (const d of candleDocs) {
    barsByT[d.ticker] = (d.daily || [])
      .map(b => ({ date: b.date, open: +b.open, high: +b.high, low: +b.low, close: +b.close }))
      .filter(b => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // live quotes to mark journeys whose plan is still open (and your open residual)
  const liveByT = {};
  try {
    for (let i = 0; i < tickers.length; i += 200) {
      const chunk = tickers.slice(i, i + 200);
      const qs = await fetchFMP(`/quote/${chunk.join(',')}`).catch(() => null);
      if (Array.isArray(qs)) for (const q of qs) if (q && q.symbol && +q.price > 0) liveByT[q.symbol.toUpperCase()] = +q.price;
    }
  } catch { /* fall back to last close below */ }

  // your fills grouped per ticker (for B)
  const fillsByT = {};
  for (const f of fills) (fillsByT[f.ticker] ||= []).push(f);

  // your episodes per ticker → first episode = the ORIGINAL TREE entry (the journey anchor)
  const episodes = reconstructEpisodes(fills, { includeOpen: true });
  const firstEpByT = {};
  for (const e of episodes.slice().sort((a, b) => String(a.entryDate).localeCompare(String(b.entryDate)))) {
    if (!firstEpByT[e.ticker]) firstEpByT[e.ticker] = e;   // earliest entry per ticker
  }

  const rows = [];
  const carried = [];   // positions carried IN from before go-live — no live TREE entry to compare against
  const pending = [];   // entered too recently (e.g. today) — no forward bars yet to play the journey out
  for (const t of tickers) {
    // Carried-in detection: walk the live fills in time order; if the running net share count ever
    // goes negative, a pre-go-live base position existed (its establishing BUY is in the paper/
    // pre-live era, not this ledger) — so there's no clean live TREE entry to anchor Plan A on.
    const fsOrdered = (fillsByT[t] || []).slice()
      .sort((a, b) => String(a.execTime || a.date).localeCompare(String(b.execTime || b.date)) || (a.side === 'BOT' ? -1 : 1));
    let runNet = 0, minNet = 0;
    for (const f of fsOrdered) { runNet += (f.side === 'BOT' ? 1 : -1) * Math.abs(+f.shares || 0); if (runNet < minNet) minNet = runNet; }
    if (minNet < -0.5) { carried.push({ ticker: t, reason: 'entered before go-live — no live TREE entry' }); continue; }

    const ep = firstEpByT[t]; const bars = barsByT[t]; const lo = bars ? computeLoStop(bars) : null;
    if (!ep || !bars || !bars.length) { rows.push({ ticker: t, skip: 'no candles' }); continue; }
    const P0 = +ep.avgEntry, N0 = +ep.shares || 0;
    if (!(P0 > 0) || N0 < 1) { rows.push({ ticker: t, skip: 'bad entry' }); continue; }
    // entry bar index = first bar on/after the entry date
    let entryIdx = bars.findIndex(b => b.date >= ep.entryDate);
    if (entryIdx < 0) { pending.push({ ticker: t, entryDate: ep.entryDate, entryPrice: +P0.toFixed(2), reason: 'entered today — no journey yet' }); continue; }

    const plan = planExit(bars, lo, entryIdx, P0, N0);

    // endpoint: where BOTH A and B are measured. Plan stopped out → its exit date/price;
    // plan still running → today's live price (fall back to last close).
    const endPrice = plan.exited ? plan.exitPrice : (liveByT[t] || plan.lastClose || P0);
    const endDate  = plan.exited ? plan.exitDate  : (plan.lastDate || null);
    const planNet  = +(((plan.exited ? plan.exitPrice : endPrice) - P0) * N0).toFixed(2);
    const planPct  = P0 > 0 ? +((((plan.exited ? plan.exitPrice : endPrice) - P0) / P0) * 100).toFixed(2) : 0;

    // B = your actual result on the name through the journey: net cash from your fills + open residual
    // marked at the endpoint price. (For a still-held name, residual = net shares you hold.)
    const fs = fillsByT[t] || [];
    let boughtCost = 0, boughtSh = 0, soldProceeds = 0, soldSh = 0;
    for (const f of fs) {
      const sh = Math.abs(+f.shares || 0), px = +f.price || 0;
      if (f.side === 'BOT') { boughtCost += sh * px; boughtSh += sh; }
      else { soldProceeds += sh * px; soldSh += sh; }
    }
    const openSh = Math.max(0, boughtSh - soldSh);
    const actualNet = +(soldProceeds - boughtCost + openSh * endPrice).toFixed(2);
    const actualPct = boughtCost > 0 ? +((actualNet / boughtCost) * 100).toFixed(2) : 0;

    rows.push({
      ticker: t,
      entryDate: ep.entryDate, entryPrice: +P0.toFixed(2), planShares: N0,
      plan: { exited: plan.exited, exitDate: endDate, exitPrice: plan.exited ? plan.exitPrice : +endPrice.toFixed(2), reason: plan.exited ? plan.reason : 'OPEN', daysHeld: plan.daysHeld },
      planNet, planPct,
      yourTrades: fs.length, openShares: openSh,
      actualNet, actualPct,
      edge: +(actualNet - planNet).toFixed(2),                 // B − A : your management's $ impact vs holding
      verdict: (actualNet - planNet) > 0 ? 'HELPED' : (actualNet - planNet) < 0 ? 'HURT' : 'EVEN',
      marked: plan.exited ? 'plan exit' : (liveByT[t] ? 'live' : 'last close'),
    });
  }

  const scored = rows.filter(r => !r.skip);
  const planNetSum   = +scored.reduce((a, r) => a + r.planNet, 0).toFixed(2);
  const actualNetSum = +scored.reduce((a, r) => a + r.actualNet, 0).toFixed(2);
  // common denominator for both returns = the original TREE position cost (entry × planned shares),
  // so A% and B% are the same trade measured two ways (apples-to-apples).
  const cost = +scored.reduce((a, r) => a + r.entryPrice * r.planShares, 0).toFixed(2);
  const totals = {
    planNet:   planNetSum,
    actualNet: actualNetSum,
    edge:      +(actualNetSum - planNetSum).toFixed(2),
    cost,
    planPct:   cost > 0 ? +((planNetSum / cost) * 100).toFixed(2) : 0,
    actualPct: cost > 0 ? +((actualNetSum / cost) * 100).toFixed(2) : 0,
    edgePct:   cost > 0 ? +(((actualNetSum - planNetSum) / cost) * 100).toFixed(2) : 0,
    helped:    scored.filter(r => r.verdict === 'HELPED').length,
    hurt:      scored.filter(r => r.verdict === 'HURT').length,
    count:     scored.length,
    stopped:   scored.filter(r => r.plan.reason === 'STOP_LOSS').length,    // plan rode it down to the stop (a loss)
    trailed:   scored.filter(r => r.plan.reason === 'TRAIL_PROFIT').length, // plan trailed up and locked a profit
    openPlan:  scored.filter(r => r.plan.reason === 'OPEN').length,         // plan still riding (not stopped yet)
  };
  rows.sort((a, b) => (b.edge || -1e9) - (a.edge || -1e9));   // biggest help first
  totals.carried = carried.length;
  totals.pending = pending.length;
  return { rows: scored, carried, pending, totals, note: 'A = modeled (daily-bar TREE trailing-stop simulation from your entry); B = your real fills. edge = B − A. Carried positions (entered before go-live) and just-entered names are listed separately — no completed live journey to compare yet.' };
}
