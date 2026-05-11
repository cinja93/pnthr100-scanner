# PNTHR Scanner v5.0 — Comprehensive Codebase Audit

**Date:** 2026-05-11
**Commit:** `6b46820` (469 commits since v4.4.0)
**Auditor:** Claude Opus 4.6
**Scope:** Full stack — server (85 files), client (79 files), infrastructure, bridge, deployment

---

## EXECUTIVE SUMMARY

The PNTHR Scanner is a ~83,000-line full-stack application (Node.js/Express + React/Vite + MongoDB Atlas + Python IBKR bridge) running a live regulated fund. The codebase is functionally rich and operationally mature, but carries significant technical debt from rapid feature development over 469 commits since v4.4.0.

**Findings:** 11 Critical, 20 High, 17 Medium, 15 Low

The three highest-priority items for a regulated fund:
1. No database backup automation (data loss = fund-ending)
2. Unauthenticated write endpoints (scanner data can be corrupted by anyone)
3. No process-level crash handlers (server dies silently, fund operations stop)

---

## CRITICAL FINDINGS (11)

### C1. No Database Backup Strategy
- **Area:** Infrastructure
- **Impact:** If MongoDB Atlas data is corrupted or deleted, ALL position data, trade history, journal entries, signal history, and compliance records are permanently lost
- **Details:** No `mongodump` script, no scheduled backup, no backup verification. MongoDB Atlas M0/M2/M5 tiers have NO automatic backup. If running on these tiers, there is zero recovery capability
- **Fix:** Verify Atlas tier includes continuous backup (M10+). If not, upgrade immediately OR script a nightly `mongodump` to cloud storage. Test restore procedure

### C2. Unauthenticated Write Endpoints
- **Area:** Server Security
- **Files:** `server/index.js` lines 788, 822, 1005
- **Impact:** Anyone with the API URL can modify scanner data without authentication
- **Endpoints affected:**
  - `POST /api/supplemental-stocks` — add stocks to scan list
  - `DELETE /api/supplemental-stocks/:ticker` — remove stocks
  - `POST /api/rankings/save` — force ranking save
  - `POST /api/signals` (line 1031) — trigger signal computation
  - `POST /api/laser-signals` (line 1060) — trigger laser signal computation
  - `POST /api/entry-dates` (line 1089) — entry date lookup
  - `POST /api/portfolio/optimize` (line 1186) — portfolio optimization
- **Note:** These routes sit under `/api/` which has a catch-all API_KEY check at line 305, but that only works if the `API_KEY` env var is set AND the client sends it. The web client uses JWT auth, not API_KEY. These endpoints are effectively open to anyone who discovers the URL
- **Fix:** Add `authenticateJWT, requireAdmin` to all write endpoints

### C3. No Process-Level Crash Handlers
- **Area:** Server Reliability
- **Impact:** An unhandled promise rejection in any cron job or background task crashes the Node process silently. Fund operations (stop ratchets, lot triggers, reconciliation) stop without any alert
- **Details:** No `process.on('unhandledRejection')` or `process.on('uncaughtException')` handlers anywhere in the codebase
- **Fix:** Add handlers in `server/index.js` that log the error and optionally alert via email/SMS before graceful shutdown

### C4. XSS in Newsletter Rendering (Client)
- **Area:** Client Security
- **File:** `client/src/components/NewsPage.jsx` line 477
- **Impact:** Newsletter content (Markdown from MongoDB) is parsed through `marked.parse()` and injected via `dangerouslySetInnerHTML` with NO sanitization. If newsletter content ever contains malicious HTML/JS (via admin editor compromise or MongoDB injection), it executes in every user's browser
- **Fix:** Install DOMPurify, sanitize before rendering: `dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(content)) }}`

### C5. XSS in Admin Approval Page (Server)
- **Area:** Server Security
- **File:** `server/index.js` lines 270-276
- **Impact:** The `page()` function interpolates `user.name` and `user.email` directly into HTML without escaping. A user who registers with `name: "<script>alert(1)</script>"` gets script injection on the admin approval page
- **Fix:** HTML-escape all interpolated values: `const esc = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))`

### C6. JWT Token Exposed in URL Parameters (Client)
- **Area:** Client Security
- **Files:** `client/src/components/CompliancePage.jsx` line 188, `client/src/components/DataRoomPage.jsx` line 125
- **Impact:** JWT auth token passed as `?token=` query parameter. Appears in browser history, server logs, referrer headers, proxy logs. For a regulated fund, this is an audit-failing pattern
- **Fix:** Fetch documents as blobs via auth headers, open with `URL.createObjectURL()`

### C7. Position Creation Race Condition
- **Area:** Server Data Integrity
- **File:** `server/commandCenter.js` — `positionsSave` function
- **Impact:** The duplicate guard does `findOne` then `insertOne` (not atomic). Two concurrent requests for the same ticker can both pass the check, creating duplicate active positions. Duplicate positions cause double-counting of exposure
- **Fix:** Use a unique compound index `{ticker:1, ownerId:1, status:1}` with `unique: true` and catch the duplicate key error, OR use `findOneAndUpdate` with `upsert: true`

### C8. Missing requireAdmin on Position Write Endpoints
- **Area:** Server Security
- **File:** `server/index.js` lines 2657-3067
- **Impact:** Any authenticated member can create, modify, and delete positions in the fund's portfolio database. The documented policy says "non-admins CANNOT Add/close positions" but this is only enforced client-side
- **Endpoints affected:**
  - `POST /api/positions` (line 2657)
  - `DELETE /api/positions/:id` (line 2660)
  - `PATCH /api/positions/:id/direction` (line 2663)
  - `PATCH /api/positions/:id/stop-price` (line 2970)
  - `PATCH /api/positions/:id/shares` (line 2994)
  - `PATCH /api/positions/:id/avg-cost` (line 3067)
  - `POST /api/positions/:id/exit` (line 4109)
- **Note:** Routes DO scope by `ownerId: req.user.userId`, so members can only affect their own positions. But the stated policy is no member writes at all
- **Fix:** Add `requireAdmin` middleware to all position-mutation routes

### C9. No Cron Overlap Protection
- **Area:** Server Reliability
- **File:** `server/index.js` lines 5325-5432
- **Impact:** Only the reconciliation cron has a `tickInProgress` mutex. The Friday Kill pipeline, Orders pipeline, AI Universe daily, and KillTest daily crons have no overlap protection. If a cron takes longer than its interval (e.g., Render cold start), it double-runs
- **Fix:** Add `let running = false` guard to each cron callback

### C10. 5:30 PM Cron Chain is Single Point of Failure
- **Area:** Server Reliability
- **File:** `server/index.js` lines 5403-5432
- **Impact:** Seven sequential async operations in one cron job. If step 1 (`runAiUniverseDailyUpdate`) throws, steps 2-7 (PAI300 index, sectors, rotation, kill, orders) are ALL skipped for the day. No retry, no partial recovery, no alert
- **Fix:** Wrap each step independently with its own try/catch. Add alerting for failures

### C11. No Startup Guard for MONGODB_URI and FMP_API_KEY
- **Area:** Server Reliability
- **File:** `server/index.js` (missing), `server/database.js` line 57
- **Impact:** If either env var is missing, the server starts but every operation fails with unhelpful errors. `JWT_SECRET` has a startup guard (`process.exit(1)`) but these don't
- **Fix:** Add `if (!process.env.MONGODB_URI) { console.error('MONGODB_URI required'); process.exit(1); }` pattern

---

## HIGH FINDINGS (20)

### H1. No Test Suite
- **Area:** Quality
- **Impact:** Zero tests for a regulated fund's trading infrastructure. No unit tests, no integration tests, no CI pipeline. Every push to `main` deploys directly to production
- **Fix:** Start with critical-path tests: signal detection, lot math, discipline scoring, exit recording

### H2. 9,900-Line Monolith (server/index.js)
- **Area:** Maintainability
- **Impact:** 225 API endpoints in one file. Security review, debugging, and onboarding are impractical
- **Fix:** Extract route groups into `/server/routes/` files (positions, admin, ibkr, scanner)

### H3. No Infrastructure-as-Code for Render
- **Area:** Infrastructure
- **Impact:** If the Render service is deleted or misconfigured, there is no declarative config to recreate it. All config lives in the Render dashboard
- **Fix:** Create `render.yaml` in repo root

### H4. No .env.example File
- **Area:** Disaster Recovery
- **Impact:** 20+ env vars exist only in Render's dashboard and developer memory. If access is lost, reconstruction requires reading every source file
- **Fix:** Create `.env.example` with every required variable documented (see DR package below)

### H5. .env.bridge Not in .gitignore
- **Area:** Security
- **Impact:** One accidental `git add .` could commit the bridge JWT token (30-day admin access)
- **Fix:** Add `.env.bridge` to `.gitignore`

### H6. No Structured/Audit Logging
- **Area:** Compliance
- **Impact:** All output goes to `console.log/error`. No log levels, no log rotation, no tamper-evident audit trail. For a regulated fund, compliance requires formal logging
- **Fix:** Adopt Winston or Pino with JSON output and log forwarding

### H7. Approval Token Never Expires
- **Area:** Server Security
- **File:** `server/auth.js` lines 134-143
- **Impact:** `generateApprovalToken` uses static HMAC — same token forever per user. An intercepted email link grants permanent approve/deny power
- **Fix:** Include timestamp in HMAC payload, validate within 24-hour window

### H8. No Client-Side JWT Expiry Check
- **Area:** Client Security
- **File:** `client/src/App.jsx`
- **Impact:** No proactive session timeout. Stale tabs display outdated data until next API call returns 401. No refresh token mechanism
- **Fix:** Decode JWT `exp` claim, show session-expiring warning, implement refresh

### H9. AnalyzeContext Uses Raw fetch() (Client)
- **Area:** Client Auth
- **File:** `client/src/contexts/AnalyzeContext.jsx` lines 26-40
- **Impact:** Five API calls bypass the centralized `apiFetch()` 401 handler. Expired sessions show stale regime/NAV data without logout redirect — could produce incorrect composite scores for trade decisions
- **Fix:** Replace all five `fetch()` calls with `apiFetch()`

### H10. ManageStocks.jsx Hardcoded to localhost, No Auth
- **Area:** Client
- **File:** `client/src/components/ManageStocks.jsx`
- **Impact:** `const API_URL = 'http://localhost:3000/api'` — completely broken in production. All fetch calls have no auth headers
- **Fix:** Remove file if unused, or migrate to `services/api.js`

### H11. Impersonation Token in URL
- **Area:** Client Security
- **File:** `client/src/contexts/ImpersonationContext.jsx` lines 66-77
- **Impact:** JWT from `?impersonate=` URL parameter stored in sessionStorage. URL appears in browser history, bookmarks, referrer headers. An attacker who obtains such a URL gains admin-as-user access
- **Fix:** Use a one-time opaque code that server exchanges for JWT

### H12. No FMP Fetch Timeout
- **Area:** Server Reliability
- **Impact:** `fetch()` calls to FMP have no `AbortSignal.timeout()` (except one instance at line 1447). Hung FMP requests block crons and route handlers indefinitely
- **Fix:** Add `signal: AbortSignal.timeout(10000)` to all FMP fetches

### H13. No FMP Rate Limit Handling
- **Area:** Server Reliability
- **Impact:** FMP returns 429 when rate-limited. No backoff logic. During heavy cron windows (5:00-5:30 PM ET), rate limits are likely
- **Fix:** Check for 429 status, implement exponential backoff

### H14. Unbounded In-Memory Caches
- **Area:** Server Memory
- **File:** `server/index.js` — `earningsCache`, `hourlyEmaCache`, `pulseRsiCache`, `speculativeSectorCache`
- **Impact:** Caches grow unboundedly. Old entries never evicted. Over weeks of uptime, memory consumption grows until the Render container is killed
- **Fix:** Implement LRU eviction or periodic cache sweeps

### H15. Bridge Offline = Silent Data Drift
- **Area:** Bridge Integration
- **Impact:** When bridge is offline, IBKR positions diverge from PNTHR without any server-side alert. Stop ratchets, lot triggers, reconciliation all stop. Only the client-side discrepancy badge shows the problem
- **Fix:** Add server-side alerting when bridge sync age exceeds threshold (email/SMS)

### H16. PortfolioPage.jsx Duplicate Auth Infrastructure
- **Area:** Client
- **File:** `client/src/components/PortfolioPage.jsx`
- **Impact:** Defines own `API_BASE`, `authHeaders()`, bypassing centralized `services/api.js`. Falls back to `http://localhost:3000` in production
- **Fix:** Import from `services/api.js`

### H17. useEventTracker.js Raw fetch()
- **Area:** Client Auth
- **File:** `client/src/hooks/useEventTracker.js`
- **Impact:** Fire-and-forget tracking calls bypass 401 handler. Expired investor sessions fail silently
- **Fix:** Use `apiFetch()`

### H18. Exit Recording Has No Atomicity
- **Area:** Server Data Integrity
- **File:** `server/exitService.js`
- **Impact:** `recordExit` does multiple MongoDB operations (read position, compute PnL, write exit, update status, write journal). Server crash mid-operation leaves inconsistent state. MongoDB free tier doesn't support multi-collection transactions
- **Fix:** Implement a two-phase commit pattern, or use a single-collection design that can be atomically updated

### H19. Race Between Bridge Sync and Reconciliation Cron
- **Area:** Server Data Integrity
- **Impact:** Both run every 60s, both read/write `pnthr_portfolio` and `pnthr_ibkr_positions` concurrently. Reconciler could act on stale IBKR snapshot mid-update
- **Fix:** The staleness guard mitigates this but doesn't eliminate it. Consider a lock flag

### H20. No npm audit in Deploy Pipeline
- **Area:** Infrastructure
- **Impact:** No automated vulnerability scanning of dependencies before deploy
- **Fix:** Add `npm audit --production` to build script

---

## MEDIUM FINDINGS (17)

| # | Area | Finding | File(s) |
|---|------|---------|---------|
| M1 | Client | Zero `React.memo()` usage across 67 components. Every context change re-renders entire tree | All components |
| M2 | Client | 30+ concurrent polling intervals with no coordination or visibility-based throttling | Multiple |
| M3 | Client | No CSRF protection for state-mutating requests | `services/api.js` |
| M4 | Client | Race condition in loadCurrentStocks/loadAiStocks — signals can mismatch stocks on rapid tab switch | `App.jsx:999-1065` |
| M5 | Client | 17 eslint-disable comments suppressing react-hooks/exhaustive-deps | Multiple |
| M6 | Client | Portal mode override via `?portal=investor` query param in production | `PortalContext.jsx:35` |
| M7 | Client | App.jsx is 1,594 lines with multiple inline components | `App.jsx` |
| M8 | Server | FMP API key in URL path visible in logs | Multiple |
| M9 | Server | No input length validation on tickers arrays | `index.js:1031-1056` |
| M10 | Server | `connectToDatabase()` returns null on failure — callers that forget null check crash | `database.js:57` |
| M11 | Server | Background refresh flag `stockRefreshInProgress` has no timeout — hung FMP request blocks all future refreshes | `index.js:455` |
| M12 | Server | Ghost reconciler uses estimated exit price — audit risk for recorded PnL | `ghostPositionReconciler.js` |
| M13 | Server | Approval URLs logged to console when SMTP unconfigured — HMAC tokens visible in logs | `emailService.js` |
| M14 | Server | CSP disabled in Helmet, not configured in Vercel | `index.js:131` |
| M15 | Infra | No MongoDB reconnect handling if connection drops mid-session | `database.js` |
| M16 | Infra | Bridge JWT is 30-day bearer token with no IP restriction | `.env.bridge` |
| M17 | Infra | `sectorEmaConfig.js` duplicated between client and server — drift risk | Both copies |

---

## LOW FINDINGS (15)

| # | Finding |
|---|---------|
| L1 | Accessibility minimal — 13 ARIA attributes across 67 components |
| L2 | API_BASE defined redundantly in 4 places |
| L3 | Source maps correctly disabled in production (positive) |
| L4 | No test infrastructure at all |
| L5 | Large components not code-split (AssistantPage 5,606 lines loaded eagerly) |
| L6 | `marked` library requires consumer-side sanitization |
| L7 | ~30 silent `catch {}` blocks throughout codebase |
| L8 | No CSP meta tag configured |
| L9 | Unused `mongoose` dependency in server package.json |
| L10 | No `npm audit` automation |
| L11 | Bridge EST/EDT fallback hardcoded to EDT on older Python |
| L12 | No graceful shutdown handler for MongoDB connection |
| L13 | PDFs committed to git root (~10MB bloat) |
| L14 | No rate limiting specific to bridge sync endpoint |
| L15 | `setInterval` for Friday scheduler never cleared on shutdown |

---

## ARCHITECTURE OVERVIEW

```
                    +-------------------+
                    |   Vercel (CDN)    |
                    |  React/Vite SPA   |
                    +--------+----------+
                             |
                             | HTTPS
                             v
                    +-------------------+
                    |  Render (Server)  |
                    |  Node/Express     |
                    |  9,900-line index |
                    |  + 84 services    |
                    +--------+----------+
                             |
                +------------+------------+
                |                         |
                v                         v
        +---------------+        +----------------+
        | MongoDB Atlas |        |  FMP API       |
        | ~40 collections|       |  Price/Quote   |
        +---------------+        +----------------+
                ^
                |
        +---------------+
        | Python Bridge |
        | IBKR TWS API  |
        | (local Mac)   |
        +---------------+
```

**Collections** (core): `pnthr_portfolio`, `pnthr_ibkr_positions`, `pnthr_ibkr_outbox`, `pnthr_ibkr_executions`, `pnthr_journal`, `pnthr_pending_entries`, `user_profiles`, `rankings`, `signals_cache`, `pnthr_reconciliation_log`, `pnthr_ai_index_candles`, `pnthr_ai_sector_weights`, `pnthr_earnings_cache`

**Cron Schedule (all ET):**
| Time | Job | File |
|------|-----|------|
| Every 1 min | Reconciliation (stops, lots, ghosts, positions, orphans, dedup) | `reconciliationCron.js` |
| 4:15 PM Fri | Kill pipeline | `fridayPipeline.js` |
| 4:30 PM M-F | Auto-save rankings | `index.js:9888` |
| 5:00 PM M-F | KillTest daily | `index.js:5358` |
| 5:30 PM M-F | AI Universe + PAI300 + sectors + kill + orders chain | `index.js:5403` |

---

## VERSION RECOMMENDATION

Given 469 commits since v4.4.0 including:
- IBKR bridge (Phase 1-4g: sync, auto-open, auto-close, outbox, stops, lots, reconciliation)
- AI 300 universe (PAI300 index, AI sectors, AI Kill, AI Orders)
- PNTHR Assistant redesign (live table, reconciliation, self-healing)
- Dark theme
- Position pyramid automation
- Movers banner
- Compliance/DataRoom pages

**Recommended version: v5.0.0** — This is a major version. The IBKR bridge alone changes the operational model from manual to automated.

---

## RECOMMENDED FIX PRIORITY

### Immediate (this week)
1. Add `.env.bridge` to `.gitignore`
2. Add `authenticateJWT, requireAdmin` to unprotected write endpoints
3. Add `process.on('unhandledRejection')` handler
4. Add startup guards for `MONGODB_URI` and `FMP_API_KEY`
5. Verify MongoDB Atlas backup tier

### Short-term (next 2 weeks)
6. Sanitize `dangerouslySetInnerHTML` with DOMPurify
7. Stop passing JWT in URL parameters
8. Add FMP fetch timeouts
9. Add cron overlap protection
10. Create `.env.example` and `render.yaml`

### Medium-term (next month)
11. Add critical-path tests (signal detection, lot math, exit recording)
12. Extract index.js into route modules
13. Replace raw `fetch()` with `apiFetch()` in client
14. Add structured logging
15. Implement client-side JWT expiry checking
