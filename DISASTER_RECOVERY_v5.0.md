# PNTHR Scanner v5.0 — Disaster Recovery Guide

**Date:** 2026-05-11
**Purpose:** If everything collapses, this document + the git repo is all you need to be back online in 24 hours.

---

## WHAT YOU NEED BEFORE YOU START

1. **This git repository** — `git clone git@github.com:cinja93/pnthr100-scanner.git`
2. **MongoDB Atlas account** — atlas.mongodb.com (credentials held by Scott/Cindy)
3. **FMP API key** — financialmodelingprep.com (Scott's account)
4. **Vercel account** — vercel.com (deploys the client/frontend)
5. **Render account** — render.com (deploys the server/backend)
6. **Domain DNS access** — pnthrfunds.com (for den.pnthrfunds.com, investor.pnthrfunds.com)
7. **IBKR TWS** — Interactive Brokers Trader Workstation (Scott's Mac, for bridge)
8. **Anthropic API key** — for Perch newsletter AI generation
9. **SMTP credentials** — for email notifications

---

## STEP 1: RESTORE THE DATABASE (Hour 1)

### If MongoDB Atlas cluster still exists:
- Log into atlas.mongodb.com
- Database name: `pnthr100` (or whatever `MONGODB_DB_NAME` is set to)
- If backups exist, restore to latest point-in-time
- Verify collections exist (see collection list below)

### If MongoDB Atlas cluster is gone:
- Create a new M10+ cluster (M10 minimum for automatic backups)
- Region: US-East (closest to Render server)
- Database name: `pnthr100`
- The app will recreate indexes on first connection
- **Data is lost** — positions, journal, signal history start fresh
- Import any mongodump backups if available

### Critical collections (62 total):

**Fund operations (MUST have data):**
- `pnthr_portfolio` — all active/closed positions
- `pnthr_journal` — trade journal entries
- `pnthr_ibkr_positions` — latest IBKR sync snapshot
- `pnthr_ibkr_outbox` — pending bridge commands
- `pnthr_ibkr_executions` — processed execution records
- `pnthr_pending_entries` — queue review entries
- `pnthr_closed_trades` — closed trade archive
- `pnthr_reconciliation_log` — audit trail

**Scanner data (rebuilt automatically by crons):**
- `rankings` — auto-rebuilt by 4:30 PM daily save
- `ai_rankings` — auto-rebuilt by 5:30 PM AI cron
- `pnthr_signals` / `pnthr_daily_signals` / `signal_history` — rebuilt by signal crons
- `pnthr_kill_scores` / `pnthr_kill_history` — rebuilt by Friday pipeline
- `pnthr_orders` — rebuilt by orders pipeline
- `pnthr_ai_index_candles*` — rebuilt by AI Universe cron
- `pnthr_ai_sector_*` — rebuilt by AI sectors cron

**User data:**
- `users` — login credentials (bcrypt hashed)
- `user_profiles` — preferences, NAV, settings
- `watchlist` — user watchlists
- `den_investors` — investor portal accounts

**Content:**
- `newsletter_issues` — published Perch newsletters
- `pnthr_kill_case_studies` — Kill case studies

---

## STEP 2: DEPLOY THE SERVER ON RENDER (Hour 2)

### Create a new Web Service on render.com:
- **Name:** `pnthr100-scanner-api`
- **Repository:** `github.com/cinja93/pnthr100-scanner`
- **Branch:** `main`
- **Root Directory:** `server`
- **Runtime:** Node
- **Build Command:** `npm install`
- **Start Command:** `node index.js`
- **Plan:** Starter or higher (free tier has cold starts that disrupt the bridge)

### Set these environment variables on Render:

```
# REQUIRED — server won't function without these
JWT_SECRET=<generate a random 64-char string>
MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/?retryWrites=true&w=majority
FMP_API_KEY=<your FMP API key>
ADMIN_EMAILS=Scott@pnthrfunds.com,cindy@pnthrfunds.com
API_KEY=<generate a random 32-char string for API-key auth>

# REQUIRED — CORS (comma-separated, no trailing slashes)
ALLOWED_ORIGIN=https://den.pnthrfunds.com,https://investor.pnthrfunds.com,http://localhost:5173,http://localhost:5174

# DATABASE
MONGODB_DB_NAME=pnthr100

# EMAIL (for access request flow)
SMTP_HOST=<your SMTP host>
SMTP_PORT=587
SMTP_USER=<your SMTP user>
SMTP_PASS=<your SMTP password>
APPROVAL_EMAIL=cindy@pnthrfunds.com
FRONTEND_URL=https://den.pnthrfunds.com

# AI GENERATION (Perch newsletter)
ANTHROPIC_API_KEY=<your Anthropic API key>

# ECONOMIC DATA
FRED_API_KEY=<your FRED API key>

# IBKR BRIDGE FLAGS (all default to false — enable after bridge is running)
RECONCILIATION_CRON_ENABLED=true
IBKR_AUTO_SYNC_STOPS=true
IBKR_AUTO_SYNC_LOT_TRIGGERS=true
IBKR_AUTO_CANCEL_ORPHANS=true
IBKR_AUTO_CLOSE_GHOSTS=true
IBKR_AUTO_RECORD_ADD_FILLS=true
IBKR_AUTO_CATCH_UP=true
GHOST_THRESHOLD_MS=300000
```

### Verify server is running:
- Hit `https://<your-render-url>/health` — should return `{ "status": "ok" }`
- Hit `https://<your-render-url>/api/health` — should return health + DB status

---

## STEP 3: DEPLOY THE CLIENT ON VERCEL (Hour 3)

### Create a new project on vercel.com:
- **Repository:** `github.com/cinja93/pnthr100-scanner`
- **Framework Preset:** Vite
- **Root Directory:** `client`
- **Build Command:** `npm run build`
- **Output Directory:** `dist`

### Set these environment variables on Vercel:
```
VITE_API_URL=https://<your-render-url>
```

### Configure custom domain:
- Add `den.pnthrfunds.com` as a custom domain
- Add `investor.pnthrfunds.com` if using investor portal
- Update DNS CNAME records to point to Vercel

### Verify client is running:
- Visit `https://den.pnthrfunds.com` — should show login page
- Log in with admin credentials
- Check that scanner data loads (may take a few minutes for first FMP fetch)

---

## STEP 4: SET UP THE IBKR BRIDGE (Hour 4-5)

### Prerequisites:
- IBKR Trader Workstation running on Scott's Mac
- TWS API enabled: TWS > Global Config > API > Settings > Enable ActiveX and Socket Clients
- Socket port: 7496 (paper: 7497)

### Bridge setup:
```bash
cd /path/to/pnthr100-scanner

# Create bridge config
cat > .env.bridge << 'EOF'
PNTHR_API_URL=https://<your-render-url>
PNTHR_TOKEN=<30-day JWT — generate from login endpoint>
TWS_HOST=127.0.0.1
TWS_PORT=7496
TWS_CLIENT_ID=100
IBKR_WRITES_ENABLED=true
IBKR_WRITES_DRY_RUN=false
EOF

# Install Python dependencies (if needed)
pip3 install ibapi requests python-dotenv

# Run the bridge
python3 -u pnthr-ibkr-bridge.py
```

### Generate bridge JWT:
```bash
# From any machine with curl:
curl -X POST https://<your-render-url>/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"Scott@pnthrfunds.com","password":"<password>"}'

# Copy the token from the response and paste into .env.bridge as PNTHR_TOKEN
```

### Desktop launcher:
The file `~/Desktop/Desktop Apps/Start PNTHR Bridge.command` auto-checks token expiry and launches. Recreate it if lost:
```bash
#!/bin/bash
cd /path/to/pnthr100-scanner
source .env.bridge
# Check token expiry
EXP=$(echo "$PNTHR_TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['exp'])")
NOW=$(date +%s)
if [ "$EXP" -lt "$NOW" ]; then
  echo "Token expired. Paste a fresh token from Den localStorage:"
  read NEW_TOKEN
  sed -i '' "s|PNTHR_TOKEN=.*|PNTHR_TOKEN=$NEW_TOKEN|" .env.bridge
fi
python3 -u pnthr-ibkr-bridge.py
```

### Verify bridge is working:
- Server logs should show `[IBKR-SYNC] ... positions synced`
- Den > PNTHR Assistant > IBKR discrepancy badge should disappear
- Bridge syncs every 60 seconds

---

## STEP 5: VERIFY EVERYTHING (Hour 5-6)

### Checklist:
- [ ] Login works (admin + member accounts)
- [ ] Scanner page loads with stock data
- [ ] Kill page shows scored tickers
- [ ] Prey page loads all 6 strategies
- [ ] ETF page loads both 140 and AI ETF tabs
- [ ] PNTHR Assistant shows positions
- [ ] PNTHR Assistant Live table shows IBKR reconciliation
- [ ] Charts open in modal
- [ ] Signals show BL/SS labels
- [ ] Movers banner appears (if market hours)
- [ ] Bridge syncing (check server logs)
- [ ] Stop ratchets syncing (check reconciliation log)
- [ ] Lot triggers staging (check outbox)
- [ ] Perch newsletter generates (admin only)

### Cron verification (wait for scheduled times):
- 4:30 PM ET: Rankings auto-save (check `rankings` collection)
- 5:00 PM ET: KillTest daily (check `pnthr_kill_test_metrics`)
- 5:30 PM ET: AI Universe chain (check server logs for completion)
- Every minute: Reconciliation cron (check `pnthr_reconciliation_log`)

---

## TECHNOLOGY STACK REFERENCE

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend | React | 18.2.0 |
| Build | Vite | 5.0.8 |
| Charts | lightweight-charts | 5.1.0 |
| Charts (analytics) | recharts | 3.8.1 |
| Markdown | marked | 17.0.4 |
| Server | Node.js / Express | 4.18.2 |
| Database | MongoDB (native driver) | 7.1.0 |
| Auth | jsonwebtoken + bcryptjs | 9.0.3 / 3.0.3 |
| Security | helmet + express-rate-limit + express-mongo-sanitize | 8.1.0 / 8.2.1 / 2.2.0 |
| Cron | node-cron | 4.2.1 |
| Email | nodemailer | 8.0.3 |
| PDF | pdfkit | 0.18.0 |
| AI | @anthropic-ai/sdk | 0.78.0 |
| Bridge | Python + ibapi | 3.x |
| Client hosting | Vercel | - |
| Server hosting | Render | - |
| Database hosting | MongoDB Atlas | - |

---

## KEY FILE MAP

```
pnthr100-scanner/
├── client/                          # React/Vite frontend
│   ├── src/
│   │   ├── App.jsx                  # Main app, routing, auth, banners (1,594 lines)
│   │   ├── AuthContext.jsx          # Auth provider, useAuth() hook
│   │   ├── components/              # 67 page/component files
│   │   │   ├── AssistantPage.jsx    # PNTHR Assistant (daily dashboard, 5,606 lines)
│   │   │   ├── AssistantLiveTable.jsx # IBKR live reconciliation table
│   │   │   ├── ApexPage.jsx         # PNTHR Kill scoring page
│   │   │   ├── PreyPage.jsx         # Multi-strategy screening
│   │   │   ├── PulsePage.jsx        # Mission control (679 + AI 300)
│   │   │   ├── OrdersPage.jsx       # Weekly order sheet
│   │   │   ├── ChartModal.jsx       # Weekly chart with signal overlay
│   │   │   ├── NewsPage.jsx         # Perch newsletter
│   │   │   ├── JournalPage.jsx      # Trade journal
│   │   │   ├── Sidebar.jsx          # Navigation
│   │   │   └── ...                  # ETF, Sector, Calendar, Search, etc.
│   │   ├── services/api.js          # All API calls (1,160 lines)
│   │   ├── contexts/                # AnalyzeContext, DemoContext, etc.
│   │   └── utils/                   # Scoring, signals, sizing, dates
│   ├── vercel.json                  # SPA rewrite rule
│   ├── vite.config.js               # Build config, proxy, no sourcemaps
│   └── package.json
│
├── server/                          # Node.js/Express backend
│   ├── index.js                     # ALL routes + crons (9,900 lines)
│   ├── auth.js                      # JWT auth, bcrypt, roles
│   ├── database.js                  # MongoDB connection, user/ranking CRUD
│   ├── signalService.js             # Weekly EMA signal state machine
│   ├── apexService.js               # Kill 8-dimension scoring engine
│   ├── commandCenter.js             # Position CRUD, regime, pipeline
│   ├── ibkrSync.js                  # Bridge receiver (Phase 1-3)
│   ├── ibkrOutbox.js                # Outbox queue (Phase 4)
│   ├── lotTriggerCron.js            # Phase 4g lot trigger sync
│   ├── lotMath.js                   # 5-lot pyramid math
│   ├── stopRatchetCron.js           # Phase 4c stop sync
│   ├── reconciliationCron.js        # Unified every-minute reconciler
│   ├── positionReconciler.js        # Share drift reconciler
│   ├── ghostPositionReconciler.js   # Auto-close ghost positions
│   ├── orphanOrderJanitor.js        # Orphan TWS order cleanup
│   ├── protectiveStopDedup.js       # Duplicate stop cancellation
│   ├── exitService.js               # Exit recording
│   ├── assistantService.js          # Assistant task engine
│   ├── assistantLiveReconcile.js    # Live table data builder
│   ├── ordersPipeline.js            # Weekly/daily order generation
│   ├── fridayPipeline.js            # Friday Kill pipeline
│   ├── preyService.js               # Prey 6-strategy scan
│   ├── perchService.js              # Newsletter generation
│   ├── etfService.js                # ETF 140 + AI ETF data
│   ├── journalService.js            # Journal CRUD + rescore
│   ├── disciplineScoring.js         # 11-component discipline score
│   ├── portfolioGuard.js            # Sacred field protection
│   ├── sectorEmaConfig.js           # Sector-optimized EMA periods
│   ├── sectorUtils.js               # Sector name normalization
│   ├── killScoringConfig.js         # Kill weight config
│   ├── impersonationService.js      # Admin impersonation
│   ├── investorService.js           # Investor portal CRUD
│   ├── emailService.js              # SMTP email
│   ├── accessRequests.js            # Self-signup flow
│   ├── demoEngine.js                # Demo fund simulation
│   ├── .env                         # Environment variables (NEVER committed)
│   └── package.json
│
├── pnthr-ibkr-bridge.py             # Python IBKR TWS bridge
├── .env.bridge                      # Bridge config (NEVER committed)
├── package.json                     # Root (concurrently for local dev)
└── .gitignore
```

---

## EMERGENCY CONTACTS & ACCESS

| System | URL | Who Has Access |
|--------|-----|---------------|
| GitHub | github.com/cinja93/pnthr100-scanner | Scott, Cindy |
| MongoDB Atlas | atlas.mongodb.com | Scott, Cindy |
| Render | render.com | Scott, Cindy |
| Vercel | vercel.com | Scott, Cindy |
| FMP API | financialmodelingprep.com | Scott |
| IBKR TWS | Local Mac | Scott |
| Domain DNS | pnthrfunds.com registrar | Scott |

---

## IF YOU ONLY HAVE 1 HOUR

Priority order to get the scanner visible (no bridge, no automation):

1. **Deploy server on Render** with `MONGODB_URI`, `JWT_SECRET`, `FMP_API_KEY`, `ADMIN_EMAILS`, `ALLOWED_ORIGIN`
2. **Deploy client on Vercel** with `VITE_API_URL` pointing to Render
3. **Login** — scanner data auto-fetches from FMP on first load
4. Kill, Prey, ETF pages work immediately
5. Bridge + automation can be added later

---

*Generated 2026-05-11 by Claude Opus 4.6 as part of PNTHR v5.0 audit*
