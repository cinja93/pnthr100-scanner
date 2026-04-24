# PNTHR v4.0.0 Verification Checklist
**Run after each major deploy. Goal: confirm every number on every page comes from one source.**

---

## Pre-Flight: Admin Endpoints

Open these first. Both should return healthy before proceeding.

- [ ] `GET /api/pipeline-health` → `healthy: true`, all collections on same `weekOf`
- [ ] `GET /api/cache-status` → apex/ETF/signal all show `warm` (may need to visit Kill page first to warm apex)

---

## Category 1: PNTHR Stop Consistency
**Pick 5 tickers with active BL or SS signals. For each, verify the PNTHR Stop matches across all surfaces.**

| Ticker | Kill Page Stop | Search Stop | ChartModal Stop | Command Card Stop | Match? |
|--------|---------------|-------------|-----------------|-------------------|--------|
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |

**How to check:**
1. PNTHR Kill → find ticker in table → note stop in score detail or ChartModal badge
2. PNTHR Search → search ticker → note PNTHR Stop field
3. Open ChartModal from Kill → amber dashed stop line value in header badge
4. Command Center → if ticker is in portfolio, check stop on position card

**Pass criteria:** All four values identical to the cent.

---

## Category 2: Sector Names
**Verify FMP raw sector names are being canonicalized before storage.**

- [ ] Open Command Center → Add Position → search a ticker (e.g. AMZN) → sector field shows `Consumer Discretionary` (not `Consumer Cyclical`)
- [ ] Search META → sector shows `Communication Services` (not `Communication`)
- [ ] Search JPM → sector shows `Financial Services` (not `Financials`)
- [ ] Search UNH → sector shows `Healthcare` (not `Health Care`)
- [ ] PNTHR Kill table → Technology/Healthcare/etc. columns use canonical names

---

## Category 3: Sacred Fields (Race Condition Guard)
**Verify price refresh does NOT overwrite user fill prices.**

- [ ] Open Command Center → edit Lot 1 fill price on a position → save
- [ ] Wait 60+ seconds (IBKR sync interval) → refresh the page
- [ ] Confirm fill price is unchanged
- [ ] Confirm stop price is unchanged after price refresh
- [ ] Confirm entry price is unchanged after price refresh

---

## Category 4: Cache Status
- [ ] `/api/cache-status` shows apex `warm` with count > 0 after visiting Kill page
- [ ] `/api/cache-status` shows ETF `warm` with count > 0 after visiting ETF page
- [ ] `/api/cache-status` shows candle count > 0 (populated from Friday pipeline)
- [ ] `/api/cache-status` shows regime `weekOf` = most recent Friday

---

## Category 5: Sector Normalization at Ingestion
- [ ] New position ticker lookup → sector is canonical (see Category 2 examples)
- [ ] PNTHR Kill sector column uses canonical names
- [ ] PNTHR Sectors page shows 11 canonical sector names (no duplicates like "Technology" + "Information Technology")
- [ ] SIZE IT sector concentration check uses same canonical name as portfolio sector field

---

## Category 6: NAV Single Source
- [ ] Command Center NAV matches what IBKR bridge last synced (check `● IBKR Xs ago` timestamp)
- [ ] SIZE IT uses same NAV as Command Center header
- [ ] IBKR sync updates Command Center NAV within 60 seconds of TWS change
- [ ] Manual NAV edit in Command persists after page refresh

---

## Category 7: Pipeline Health
- [ ] `/api/pipeline-health` → `healthy: true`
- [ ] All four collections (`scores`, `regime`, `history`, `snapshot`) show same `weekOf`
- [ ] Changelog shows last Friday's pipeline run with no `PIPELINE_WARNING` entries
- [ ] Kill page loads instantly (serving pre-computed MongoDB data, not live FMP compute)

---

## Category 8: Data Quality (FMP)
- [ ] Kill page loads without errors in browser console
- [ ] No tickers showing $0 or null price on Kill table
- [ ] No "NaN" values in any score dimension
- [ ] Search for a valid ticker → all fields populated (price, EMA, sector)
- [ ] Search for invalid ticker (e.g. `XXXXXX`) → graceful error, no crash

---

## Category 9: MongoDB Indexes
*(Verify via Render logs — index creation runs at startup)*
- [ ] Server start logs show `[CC] Command Center MongoDB indexes ensured`
- [ ] No `MongoServerError: too many open cursors` or slow query warnings in logs
- [ ] Kill pipeline completes in < 3 minutes (index performance)
- [ ] `/api/positions` returns in < 500ms

---

## Category 10: Frontend State
- [ ] Edit fill price → leave page → return → price persists (from server, not browser cache)
- [ ] Add a lot fill → refresh → fill is still there
- [ ] Close a position → it moves from Active to Closed immediately (optimistic UI)
- [ ] If a save fails (simulate by killing network) → UI reverts or shows error (not silent corruption)

---

## Category 11: Date Format Consistency
- [ ] Signal dates display correctly on Kill page (no "Invalid Date" or epoch timestamps)
- [ ] Journal entry dates display correctly (entry date, exit date)
- [ ] Signal History → all 5 tabs load with correct week-of-date headers
- [ ] PNTHR 679 Jungle → signal dates are readable (YYYY-MM-DD or natural format)

---

## Category 12: Error Handling
- [ ] Kill page loads even if 1–2 tickers fail FMP (others still score)
- [ ] Command Center loads even if IBKR bridge is offline
- [ ] ChartModal opens even if a ticker has no candle history (shows graceful error)
- [ ] Newsletter page loads even if AI generation fails

---

## Full Page Smoke Test

Run through every page in the Den and confirm it loads without console errors:

- [ ] PNTHR Kill (+ verify top 10 Kill Badges show in ChartModal)
- [ ] PNTHR Prey (Feast / Alpha / Spring / Sneak / Hunt / Sprint tabs)
- [ ] PNTHR's Perch (newsletter renders, chart links open ChartModal)
- [ ] PNTHR Search (search a ticker, verify stop + signal data)
- [ ] PNTHR Jungle (all 679 tickers listed, signals showing)
- [ ] PNTHR 100 Longs / PNTHR 100 Shorts
- [ ] PNTHR ETFs
- [ ] PNTHR Sectors (11 sectors, signal counts > 0)
- [ ] PNTHR Calendar
- [ ] Watchlist
- [ ] PNTHR Command (positions, lots, NAV, IBKR indicator)
- [ ] PNTHR Journal (entries load, discipline scores visible)
- [ ] Signal History (all 5 tabs)
- [ ] PNTHR Pulse (all gauges, Kill Top 10, sector bars)

---

## Sign-Off

| Check | Result | Notes |
|-------|--------|-------|
| Stop prices consistent (5 tickers) | PASS / FAIL | |
| Sector names canonical | PASS / FAIL | |
| Sacred fields protected | PASS / FAIL | |
| Cache status green | PASS / FAIL | |
| Pipeline health green | PASS / FAIL | |
| All pages load clean | PASS / FAIL | |

**Version:** v4.0.0
**Date verified:** ___________
**Verified by:** ___________

Once all rows are PASS → this is the verified v4.0.0 baseline. All future development builds on this foundation.
