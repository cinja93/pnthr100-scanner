# Ambush archive (retired 2026-07-10)

Historical artifacts of the **PNTHR Ambush** intraday strategy, which was retired as a
failed strategy (it was a look-ahead mirage: an unexecutable +789% collapsed to an honest
-100% once run strictly). Moved here out of the active tree so nothing references them, while
preserving the research trail.

## What's here
- `server/backtest/` — the Ambush backtest iterations (`pai300Hourly*`, `ambushSp500_defensible`)
  and IR/doc generators (`genAmbush*`, `AMBUSH_V75_BACKTEST_SPEC.md`).
- `server/data/` — Ambush IR tier data (`ambushIr/`), projection baselines, `.bak` snapshots.
- `server/scripts/`, `scripts/` — Ambush doc + walkthrough generators (`generateAmbush*`, `ambush_walkthrough_*.html`).
- `server/_ambush_*.mjs`, `_diag_ambush.mjs`, `_probe_ambush_paper.mjs` — one-off diagnostic scratch scripts.

Original repo paths are preserved under this folder (e.g. `ambush-archive/server/backtest/...`).

## Notes
- These scripts' relative imports (e.g. `./costEngine.js`, `../treeSim.js`) point at shared
  modules that stayed in `server/backtest/`. They will NOT run as-is from here without fixing
  those paths. They are kept as **evidence / reference**, not as runnable code.
- This is NOT the live order pipeline. The live-money pipeline that PNTHR Tree trades through
  (`server/ambush/`, the `pnthr_ambush_outbox`/`_positions`/`_config`/`_trades`/`_hourly`
  collections, and the Python IBKR bridge) is still in active use and was deliberately left in
  place. Renaming that pipeline off the "ambush" name is a separate, supervised migration (a
  standing to-do), not part of this archive.
