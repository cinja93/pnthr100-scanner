# PNTHR — Backtest Execution Rules (no look-ahead)

**Status: LOCKED standard for every PNTHR backtest, IR number, and tearsheet.**
Origin: 2026-06-08 audit found the Ambush "green-confirm re-entry" was a look-ahead that
inflated the headline from an honest **−100%** to a fake **+789%**. We *had* a prose rule and it
still happened. So this standard is **enforced by a mandatory STRICT run**, not trust.

A backtest result is valid only if every fill is a price a real broker order would have gotten,
using only information available at that instant. Concretely:

## The 5 clauses
1. **Closed-period only.** A signal computed from a period (week/day/hour) is unknown until that
   period *closes*. Act on it starting the **next** period — never within the period it's computed from.
2. **No intra-bar peeking.** A decision made "inside" a forming bar may use only the bar's **open**
   and prior *completed* bars. Its close/high/low are unknown until the bar ends. Any rule that
   references them ⇒ the earliest executable action is the **next bar's open**.
3. **Fill at the trigger or worse.** Fill at the level that authorized the trade (plus slippage),
   never at a better price the bar reached *earlier*.
4. **Resting orders only — no cherry-picking outcomes.** Every entry/exit must be expressible as a
   resting market/stop/limit order placed from past data that fills on **every** touch. You may not
   keep only the bars/periods that "worked out" (e.g. only the ones that *closed* green) while
   filling at a pre-outcome price. This is the most dangerous and least obvious look-ahead.
5. **Costs always on.** Slippage + commission + borrow + gap-through stops on every leg.

## Two-line litmus test (apply to any result before trusting it)
- **"At the exact instant of this fill, what did I actually know?"** If the answer includes anything
  from later in the same bar, or a not-yet-closed period — it's look-ahead.
- **Resting-order test:** could a broker have filled this with a resting order placed from yesterday's
  data, filling on every touch (winners and losers)? If not, the result is not real.

## ENFORCEMENT — every backtest MUST do this
- **A. Ship a STRICT mode** that turns on: closed-period signals, next-bar-open fills for any
  close-dependent trigger, and fill-at-trigger-or-worse. (In `pai300HourlyV75_defensible.js`:
  `SIGNAL_LAG_WEEKS=1 REENTRY_NEXTOPEN=1` + the post-breakout new-entry guard.)
- **B. The HEADLINE number is the STRICT number.** Any optimistic variant may be reported only
  labelled `NON-EXECUTABLE — upper bound`.
- **C. Report STRICT vs modeled side-by-side.** A large gap is not noise — it is a look-ahead to hunt
  down before anything is trusted. The §0 sanity gate should flag it RED.
- **D. Live parity.** The live engine must match the STRICT model. Diff the live entry price vs the
  STRICT backtest entry price; if they differ, live underperforms forever ("BEHIND vs backtest").

## Pre-flight checklist (tick before quoting any backtest number)
- [ ] STRICT mode exists and was run; the quoted number IS the strict one.
- [ ] No entry/exit references the current bar's close/high/low *and* fills at a different level.
- [ ] No signal is acted on within the period it was computed from.
- [ ] Every entry/exit = a resting order that fills on every touch (no outcome filter + cheap fill).
- [ ] Slippage, commission, borrow, gap-through all on.
- [ ] STRICT-vs-modeled gap reviewed; large gap investigated to root cause.
- [ ] Live entry/exit prices diffed against STRICT backtest.
