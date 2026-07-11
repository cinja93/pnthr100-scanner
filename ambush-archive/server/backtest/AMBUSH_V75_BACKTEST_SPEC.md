# PNTHR Ambush V7.5 — Defensible Backtest: Methodology & Build Specification

**Status:** Build spec, locked 2026-06-04. This is the single source of truth. Build exactly to this.
**Purpose:** Produce a **regulator/court-defensible** backtest of the Ambush V7.5 intraday strategy —
real frictions, real fills, standard hedge-fund methodology, GROSS and NET. No optimistic shortcuts.
**Audience:** Regulated fund (Reg D 506(c) 3(c)(1) Long/Short). Numbers must be defensible to a judge.

> If anything here is ambiguous, ASK Scott before coding. Do not "improve" or deviate silently.

---

## 0. Why this spec exists (read first)

Earlier attempts bolted V7.5 logic onto the V7.4 day-loop backtest and produced **physically impossible
numbers** (Profit Factor 80x, Win Rate 73%, $163M from $83K). Root causes — the artifacts this build
MUST avoid:
1. **Deferred management:** positions created mid-day were only managed starting the *next* day, so
   tight re-entry stops were never tested intraday → whippy re-entries "survived" → massive inflation.
2. **No gap-through on stops:** exits filled at the exact stop price (real stops fill *worse*).
3. **No capacity cap:** unlimited fill size and ~75 trades/day with no ADV limit.
4. **No fund fees in the headline:** only trading costs, not the 2% mgmt + 30% perf overlay.

**Sanity gate (if any of these fail, there is a bug — STOP and fix):**
- Profit Factor should be **low single digits** (a trend-follower is ~2–4x, not >10x).
- Win Rate for this style is **~30–45%** (small losses, few big wins), NOT >60%.
- Worst single trade ≈ **the risk cap** ($300 at 100% sizing tier; ~$150 at 50%). Not multiples of it.
- Fees should roughly **halve** gross (per the benchmark IR: gross +973% → net +488%).
- With the withdrawal rule, **working capital stays ~$1M–$2M** (capacity-bounded).

---

## 1. The strategy (V7.5) — exact rules

Source of truth for the strategy = the signed-off walkthrough `scripts/ambush_walkthrough_v75.html`
(Rev 5) plus the locked memory files:
`project_ambush_entry_stop_redesign_2026_06_04`, `feedback_ambush_reentry_daily_frozen`.

**Universe:** AI 300 (~300 names), both longs and shorts. (`AI_TICKER_META` from `aiUniverseData.js`.)

**The three signals — all must point the SAME direction:**
1. **Weekly (direction-setter):** proprietary sector-tuned EMA + PNTHR signal system. A name has an
   active **Buy-Long (BL)** or **Sell-Short (SS)** weekly signal. Use `detectAllSignals(weeklyBars,
   period, false, null, gateOffset)` with the AI sector EMA period (`SECTOR_EMA_PERIODS`, ~18–30w) and
   `gateOffset = 0.25`. The weekly signal decides which names are eligible and **in which direction**.
   It is **signal-only** for re-entry (no weekly *price* gate).
2. **Daily breakout:** current price **above the higher of the prior two days' highs + $0.01** (long) /
   **below the lower of the prior two days' lows − $0.01** (short).
3. **Hourly trigger (N=1):** live price breaks the **high of the most-recent COMPLETED hourly bar + $0.01**
   (long) / **its low − $0.01** (short). **Any bar color — NO green-bar requirement.** Earliest entry is
   after the first hour completes (10:30 ET).

**Sector filter (directional):** a **long only in a BULL sector** (sector's **5-day return ≥ 0**), a
**short only in a BEAR sector** (5-day return < 0). Source = `pnthr_ai_sector_rank_daily`, field
`fiveDayReturn` per `sectorId` per date (this is the AiSectorsPage BULL/BEAR badge). Look up the
sector's 5-day return on/before the trade date; sign must match the trade direction.

**Regime gate:** OFF in V7.5 (longs and shorts in any market regime).

**Position sizing:** total shares = smallest of `$300 / risk-per-share`, `(1% × NAV) / rps`,
`(10% × NAV) / entryPrice`; then × graduated tier (**50%** < $125K NAV, **75%** < $166K, **100%** ≥ $166K).
Risk-per-share = |entry − stop|. (`sizeLots` in `ambushEngine.js` — reuse, but see §2 ADV cap.)

**Five-lot pyramid:** 35 / 25 / 20 / 12 / 8% of total shares, added at entry / +3% / +6% / +10% / +14%
(long; mirror for short). `STRIKE_PCT`, `LOT_OFFSETS` in `ambushEngine.js`. Only Lot 1 at entry; lots
2–5 add as price moves in favor. Each add updates avg cost. **Lot counter = count of lots filled**
(`deriveNextLot`); after L1, next lot index = 1.

**10% NAV cap maintained on EVERY add:** before adding a lot, recompute against current NAV; if the add
would push the position over 10% of NAV, **trim shares from the top lot down (L5 first)** so the position
stays ≤ 10% NAV (mark-to-market at the lot price). This holds the average cost lower. (This is the
`lotMath.js` dynamic-replan pattern.)

**Stops:**
- **New-entry initial stop = the first-hour low − a fee** (long) / first-hour high + fee (short). It
  stays the stop while it is still the lowest of the last two completed hourly bars; once two more bars
  form and the first hour ages out of the two-bar window, the normal 2-bar trailing stop takes over.
- **Re-entry initial stop = the ENTRY BAR's low** (the bar that broke the prior bar's high) — tight. If
  price dips below it → exit (small loss); the name is then eligible to re-enter again on the next break
  (no cooldown). Hold the entry-bar-low stop through the entry bar + the next **2 completed hourly bars**,
  then the normal 2-bar trailing stop takes over.
- **2-bar trailing stop (the exit):** stop = **lowest low of the last two COMPLETED hourly bars − $0.01**
  (long) / highest high + $0.01 (short). It **trails UP only** (one-way; it can never move down under a
  live position because a drop below the level fires the stop first). Governs from entry (no $75 BE snap).
  **Pyramiding NEVER touches the protective stop** — the 2-bar trail is the single stop manager.

**Re-entry daily gate (FROZEN):** when a trade first qualifies a cycle, **freeze the daily breakout
price** (the 2-day-high level, e.g. $463.89). A name may re-enter only while price holds **above that
frozen daily level** (long) / below it (short). If price falls back below, it is not eligible; if it
reclaims above, it is eligible again. **NOT rolled** to a new level each day. The hourly trigger is
separate and fresh each time (a *lower* hourly re-entry is welcome — cheaper entry — as long as price is
above the frozen daily floor). The frozen rule is **daily only** — weekly is signal-only, hourly is fresh.
Frozen level resets only when a new weekly signal cycle begins.

**No cooldown / no per-day re-entry cap** in the strategy spec. (Capacity is governed by the 2% ADV cap
and the withdrawal rule, §2/§3 — NOT by an artificial per-day count.)

**Trading windows:** entries fire **after the first hour (10:30) up to the 4:00 close**. No new entries
in the open blackout (9:25–9:35) or post-bell (16:00–16:05). Existing positions are protected the whole
time by their resting stop (it fires intraday, first hour included); the engine just doesn't re-tighten
the stop until 10:30.

---

## 2. Friction & execution model (the defensibility core — do NOT skip any)

**All on every leg, entries AND exits:**
- **Commission:** `calcCommission(shares, price)` from `backtest/costEngine.js` — IBKR Pro Fixed
  ($0.005/share, $1.00 min, 1% of trade value max).
- **Slippage:** **5 basis points per leg** — `calcSlippage(shares, price)` or `entrySlip/exitSlip`
  (5 bps). Entries fill 5 bps worse, exits fill 5 bps worse.
- **Short borrow:** `calcBorrowCost(shares, entryPrice, tradingDays, sector)` — sector-tiered 1.0–2.0%
  annualized × holding days, applied to every short on exit. (`getBorrowRate(sector)`.)

**Gap-through stops (REQUIRED):** when a stop is hit, the fill is the **WORSE of the stop price or the
bar's open**. Long: if the bar opens **below** the stop (gapped down), fill at the **open**; otherwise
fill at the stop. Short mirror. Then apply exit slippage. Real stops slip through on gaps — model it.

**2% ADV cap on EVERY fill (REQUIRED for executability):** no single fill (initial lot or pyramid add)
may exceed **2% of the ticker's trailing 20-day average daily volume**. Compute 20-day ADV from the daily
candles' `volume` field (trailing 20 sessions as of the trade date). If the sized shares exceed 2% ADV,
**trim to 2% ADV**. This is standard practice for defensible executability (the benchmark IR uses it).

**Intraday management (REQUIRED — this is the fix):** every position is managed **bar-by-bar from its
real entry bar**, same day. A position entered at hour H is managed from hour H+1 onward that same day —
NOT deferred to the next day. Within each bar: **stop first (pessimistic, with gap-through), then lot
adds (ADV-capped, 10% trim), then update the 2-bar trail.**

---

## 3. Capital, withdrawals, no leverage

- **Starting capital: $100,000.** (Tier = "Filet 100k".)
- **Withdrawal rule:** whenever the **working balance reaches $2,000,000**, withdraw **$1,000,000**
  (banked, locked, removed from trading). This keeps working capital between **$1M and $2M** at all
  times — capacity/liquidity realistic. Track total banked separately. Check at start of each day.
- **No leverage, no margin.** Total deployed ≤ available cash. Entries/adds skip when cash is unavailable.
- Period = the hourly-data range (~2022-11 to 2026-05). Returns begin when signals warm up.

---

## 4. Gross → Net (fees) — match the IR exactly

1. Build the **GROSS** daily NAV curve from the simulation (after trading costs in §2, before fund fees).
2. Apply `applyFeeEngine(grossCurve, tier, opts)` from `backtest/ai300FeeOverlay.js` with the **Filet
   100k tier**: `{ startingCapital: 100_000, baseRate: 0.30, loyaltyRate: 0.25 }`. This applies: 2% annual
   mgmt fee (accrued), quarterly **performance allocation** with **High-Water Mark**, **US 2-Year Treasury
   hurdle (US2Y/4 per quarter)**, loss-recovery account, and the **loyalty step-down to 25% after 36
   months**. Returns the **NET** curve + total mgmt/perf fees.
3. Report **GROSS and NET side by side**, exactly like the benchmark IR (gross/net CAGR, return, Sharpe,
   Sortino, Calmar, max DD, ending equity, fee drag).

> Note on the withdrawal interaction: decide and document how withdrawals interact with the HWM/perf-fee
> base. Recommended: withdrawals are investor capital returns (not fees); the perf fee is on net trading
> profit above the HWM regardless of withdrawals. Confirm with Scott before finalizing.

---

## 5. Metrics & outputs (standard hedge-fund set)

Compute on the **daily NAV curve** (use `computeSharpe`, `computeSortino` from `irLiveService.js` for
method-consistency with the live IR page):
- Net & Gross **CAGR**, total return; **Sharpe**, **Sortino**, **Calmar** (CAGR / maxDD).
- **Max peak-to-trough (paper) drawdown** and **max realized drawdown** (from closed-trade P&L).
- **Profit Factor**, **Win Rate**, **payoff ratio**, **recovery factor**, **positive months %**.
- **Alpha vs S&P 500** (SPY from `pnthr_bt_candles_weekly`), **beta**, **R²**, CAPM alpha.
- **Withdrawal headline:** total value = **banked + working**, banked $, working $, peak deployed,
  peak NAV (to show capacity stays ~$1–2M).
- Trade count, avg win/loss in $.

**Outputs:** console metric cards (GROSS + NET, IR-style); a JSON results file; closed-trades CSV +
daily NAV ledger CSV to ~/Downloads (name them `PNTHR_Ambush_V7.5_*`). Do **not** overwrite the live
`ambushProjectionBaseline.json` — use a `_v75` filename.

---

## 6. Data sources (MongoDB collections)

- `pnthr_ai_bt_candles` — daily OHLCV (has `volume` for the ADV cap).
- `pnthr_ai_bt_candles_weekly` — weekly bars (signals).
- `pnthr_ai_hourly_candles` — hourly bars (intraday sim).
- `pnthr_ai_sector_rank_daily` — per-date `ranks: [{ sectorId, fiveDayReturn, tier }]` (sector BULL/BEAR).
- `pnthr_ai_index_candles_weekly` (PAI300) — regime (computed, gate OFF).
- `pnthr_bt_candles_weekly` ticker `SPY` — benchmark.

Reuse the data-loading + signal-computation block from `pai300HourlyV74.js` (it is correct). The thing
to rebuild is the **simulation core** (clean bar-by-bar, §2 intraday + gap-through + ADV cap), NOT the
data/signal loading.

---

## 7. Building blocks to REUSE (don't reinvent)

- `backtest/costEngine.js`: `calcCommission`, `calcSlippage`, `calcBorrowCost`, `getBorrowRate`.
- `backtest/ai300FeeOverlay.js`: `applyFeeEngine`, `FEE_TIERS` (Filet 100k).
- `irLiveService.js`: `computeSharpe`, `computeSortino`.
- `ambush/ambushEngine.js`: `STRIKE_PCT`, `LOT_OFFSETS`, `sizeLots`, `deriveNextLot`, `entrySlip`,
  `exitSlip`, `getWeekOf`, `detectAllSignals` wiring, sector EMA periods.
- Data + signal loading: copy from `pai300HourlyV74.js` (lines ~117–236).

`pai300HourlyV75.js` exists but is a **work-in-progress with the artifacts described in §0** — use it
ONLY as a reference for the V7.5 logic edits already made (sector filter, frozen daily, 1-bar break,
entry-bar stop, 10% trim). Do **not** trust its numbers. The new build replaces its simulation core.

---

## 8. Build order (suggested)

1. New file `backtest/pai300HourlyV75_defensible.js`. Reuse data/signal loading.
2. Precompute per-ticker trailing 20-day ADV by date (for the 2% cap).
3. Build the clean bar-by-bar core: day → hour → tickers; manage-then-scan; intraday; gap-through; ADV cap.
4. Wire all frictions (§2). $100K + withdrawal (§3).
5. Produce the GROSS daily NAV curve.
6. Apply `applyFeeEngine` (Filet 100k) → NET (§4).
7. Compute + print metrics (GROSS + NET), write JSON + CSVs (§5).
8. **Run the §0 sanity gate.** If PF > ~5x or WR > ~55% or worst trade ≫ risk cap → there is a bug; fix
   before reporting. Report GROSS and NET honestly, with the working-capital/capacity figures.

---

## 9. What "done" looks like

A single command (`node backtest/pai300HourlyV75_defensible.js`) that prints IR-style GROSS and NET
metric cards for Ambush V7.5 — $100K start, $2M→$1M withdrawal, all real frictions — that **pass the §0
sanity gate** and that Scott can defend line-by-line to a regulator. Plus the JSON + CSV artifacts.
