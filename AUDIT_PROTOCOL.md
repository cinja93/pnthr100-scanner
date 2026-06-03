# PNTHR Trading-System Audit Protocol

**Purpose:** a complete, repeatable audit that proves exactly what can touch the live IBKR
account and that the live books are internally consistent. Created 2026-06-03 after the
Ambush/ai300 shadow-contamination incident, where spot-checks of one engine kept missing
**system-level** defects (a second engine trading the same names; a see-saw gate that
re-enabled the ai300 suite the instant Ambush was disabled).

**Governing principle (single shared IBKR account):**
1. **Exactly ONE engine owns a ticker at a time.** IBKR shows only the NET position — there is
   no way to attribute shares to an engine, so two engines on one name = guaranteed corruption.
2. **Only the intended engine(s) may place orders.** Current intent (2026-06-03): **ONLY Ambush
   V7.4 trades, and ONLY AI-300 names.** Every other auto-execution engine is OFF.
3. **Every engine reconciles against live IBKR before it acts.** No engine trades on its own
   internal share count alone.

An audit **PASSES** only when all 6 sections below pass. Run the whole thing — never a subset —
before declaring "all set," before re-enabling any engine, and after any change to an order
path, a cron, or an engine gate.

---

## Section 0 — How to run

```
cd server
node crossEngineAudit.js            # automated: Sections 5 (data-state). Exit 0 = pass.
```
Sections 1–4 are code-inventory checks: run the grep commands shown and compare the output to
the **expected** table. Any new row that isn't in the table is a finding until classified.

---

## Section 1 — ENGINE ENABLEMENT (what is allowed to trade)

The authoritative list of every engine that can create positions or place orders, how it is
turned on/off, and its REQUIRED state under current intent.

| Engine | File | Enable mechanism | REQUIRED state | Notes |
|---|---|---|---|---|
| **Ambush V7.4** | `ambush/ambushCron.js` | `pnthr_ambush_config.enabled` (DB) | **ON** (when trading) | The ONLY engine that may open new trades. AI-300 only. |
| ai300 Weekly stage/exec | `aiAutoExecute.js` `stageWeeklyOrders`/`executeWeeklyOrders` | env `AI_AUTO_EXECUTE` **+** `!isAmbushModeActive()` | **OFF** | See SEE-SAW WARNING. |
| ai300 MCE daily | `aiAutoExecute.js` `executeMceEntries` | env `IBKR_MCE_AUTO_EXECUTE` **+** `!isAmbushModeActive()` | **OFF** | Created the 15 shadow entries on 2026-06-03. |
| ai300 Intraday upgrades | `aiAutoExecute.js` `monitorAndStageUpgrades` | env `AI_AUTO_EXECUTE` **+** `!isAmbushModeActive()` | **OFF** | |
| ai300 Position manager | `aiPositionManager.js` | gated by `!isAmbushModeActive()` | **OFF** | Sells/modifies ai300 stops. |
| ai300/679 Stop ratchet | `stopRatchetCron.js` | cron, iterates `pnthr_portfolio` | **OFF for non-Ambush** | Only acts on tickers present in `pnthr_portfolio`. Keep empty of Ambush tickers. |
| ai300/679 Lot triggers | `lotTriggerCron.js` | cron, iterates `pnthr_portfolio` | **OFF for non-Ambush** | Fired the pyramid lot-adds that churned $709. |
| ai300 auto-open (sync) | `ibkrSync.js` `processNewPositions` | runs on every IBKR sync | **GUARDED** | Skips Ambush tickers as of commit `4e6b83c`. |
| Orphan janitor | `orphanOrderJanitor.js` | env `IBKR_AUTO_CANCEL_ORPHANS` | protective (Ambush-aware) | Cancels stray orders; protects Ambush tickers. |
| Protective stop dedup | `protectiveStopDedup.js` | cron | protective | Cancels duplicate stops. |
| Demo fund | `demoEngine.js`/`demoBackfill*.js` | `DEMO_OWNER_ID` only | N/A | Never touches the real account. |
| Manual (UI/API) | `commandCenter.js`, `index.js`, `pendingEntries.js` | user-initiated | user's call | Not automated. |

> **🚨 SEE-SAW WARNING (the 2026-06-03 root cause).** `isAmbushModeActive()` in `index.js` is
> `return !!ambushConfig.enabled`. Every ai300 engine is gated by `!isAmbushModeActive()`, so
> **disabling Ambush AUTO-ENABLES the entire ai300 suite.** Under current intent the ai300
> engines must be OFF *independently* (env flags false **and** code-level guard), so that NEITHER
> Ambush-on NOR Ambush-off can ever let them trade.

**Env flags that gate trading (verify on Render):**
`AI_AUTO_EXECUTE` (must be `false`), `IBKR_MCE_AUTO_EXECUTE` (`false`), `AI_AUTO_EXECUTE_DRY_RUN`,
`IBKR_AUTO_PLACE_STOP`, `IBKR_AUTO_SYNC_STOPS`, `RECONCILIATION_CRON_ENABLED`,
`IBKR_AUTO_CANCEL_ORPHANS`, `IBKR_AUTO_CLOSE_GHOSTS`.

**PASS:** Ambush enable matches intent; every other engine's env flag AND code guard is OFF.

---

## Section 2 — ORDER-PATH INVENTORY (what can place an IBKR order)

Orders reach IBKR **only** through two outbox queues. Enumerate every writer — this is the
complete, provable list of order sources.

```
# Writers to the ai300/679 order queue:
grep -rn "enqueueOutbox(" server/*.js | grep -v "function enqueueOutbox"
# Writers to the Ambush order queue:
grep -rn "enqueueAmbushOrder(" server/*.js server/ambush/*.js
```

**Expected ai300/679 outbox writers:** `aiAutoExecute.js`, `aiPositionManager.js`,
`lotTriggerCron.js`, `stopRatchetCron.js`, `ibkrSync.js`, `orphanOrderJanitor.js`,
`protectiveStopDedup.js`, `exitService.js`, `commandCenter.js`, `index.js` (manual endpoints).
**Expected Ambush outbox writer:** `ambush/ambushCron.js` (via `enqueueAmbushOrder`).

**PASS:** no writer outside the expected list; every non-Ambush writer is in a disabled engine
(Section 1) or is manual/protective.

---

## Section 3 — POSITION-CREATION INVENTORY (what can open a position record)

```
grep -rn "pnthr_portfolio')\.insertOne\|COLL_PORTFOLIO)\.insertOne\|upsertAmbushPosition" server/*.js server/ambush/*.js
```
**Expected portfolio inserters:** `aiAutoExecute.js` (×3 — disabled), `ibkrSync.js` (guarded),
`pendingEntries.js` (manual confirm), `commandCenter.js` (manual), `index.js` (manual),
`demoEngine.js`/`demoBackfill*.js` (demo only).
**Expected Ambush position writer:** `ambush/ambushCron.js` (`upsertAmbushPosition`).

**PASS:** no new inserter; all automatic inserters are either guarded or in a disabled engine.

---

## Section 4 — CRON INVENTORY (what runs on a schedule)

```
grep -n "cron.schedule\|setInterval" server/index.js
```
For each schedule, confirm purpose + gating. Any cron that can place orders or create positions
must be in Section 1 with the correct REQUIRED state. **PASS:** every order/position-capable
cron is OFF except Ambush; the rest are read-only/analytics/snapshots.

---

## Section 5 — DATA-STATE INTEGRITY (automated — `crossEngineAudit.js`)

Run `node server/crossEngineAudit.js`. Invariants checked against the live books + IBKR snapshot:

| Code | Severity | Invariant |
|---|---|---|
| `CROSS_ENGINE_COLLISION` | VIOLATION | No ticker in BOTH `pnthr_portfolio` (ACTIVE/PARTIAL) and `pnthr_ambush_positions`. |
| `DIRECTION_INVERSION` | VIOLATION | Recorded direction matches IBKR share sign (catches the AVGO flip). |
| `PHANTOM_POSITION` | VIOLATION | Engine tracks shares but IBKR holds 0 (catches phantom-share trades). |
| `NO_PROTECTIVE_STOP` | VIOLATION | Every held IBKR position has a correct-side STP. |
| `UNTRACKED_IBKR_POSITION` | WARN | IBKR holds a name no engine tracks. |
| `SHARE_DIVERGENCE` | WARN | Engine share count ≠ IBKR. |
| `DUPLICATE_STOPS` | WARN | More than one protective stop on a name. |
| `STALE_IBKR_SNAPSHOT` | WARN | IBKR snapshot older than 5 min (bridge down) — comparisons unreliable. |

**PASS:** zero VIOLATIONS. (Warnings are advisory but every one must be explained.)

---

## Section 6 — PRE-FLIGHT GATE (run before re-enabling anything)

1. [ ] Section 1: only Ambush enabled; ai300 env flags false; code guards in place.
2. [ ] Section 2 & 3: no unexpected order/position path.
3. [ ] Bridge restarted with a FRESH IBKR sync (`crossEngineAudit` shows snapshot < 5 min old).
4. [ ] Section 5: `crossEngineAudit.js` exits 0 (no violations).
5. [ ] Ambush records reconciled to IBKR (no PHANTOM/DIVERGENCE on Ambush names).
6. [ ] Outbox backlog clear: no stale PENDING orders in `pnthr_ibkr_outbox` / `pnthr_ambush_outbox`.

Only when all 6 are checked may an engine be turned on. Record the run (date, result) below.

### Audit log
| Date | Run by | Result | Notes |
|---|---|---|---|
| 2026-06-03 | incident response | FAIL → remediation in progress | 45 violations found (15 collisions, phantoms); MCE see-saw identified; ai300 suite being hard-disabled. |
