#!/usr/bin/env python3
# Generates: ~/Downloads/PNTHR_Ambush_V7.3_System_Walkthrough.pdf
# Plain-English walkthrough of the LIVE Ambush V7.3 engine + the Den UI.
# Content traced directly from server/ambush/*.js, pnthr-ibkr-bridge.py,
# and client/src/components/AmbushPage.jsx.

import os
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak, ListFlowable, ListItem,
)

OUT = os.path.join(os.path.expanduser("~"), "Downloads",
                   "PNTHR_Ambush_V7.3_System_Walkthrough.pdf")

INK = colors.HexColor("#1a1a1a")
GREY = colors.HexColor("#666666")
HDR = colors.HexColor("#2b2b2b")
ROW = colors.HexColor("#f4f4f4")
RULE = colors.HexColor("#cccccc")

styles = getSampleStyleSheet()

def S(name, **kw):
    base = kw.pop("parent", styles["Normal"])
    return ParagraphStyle(name, parent=base, **kw)

title_st   = S("t",  parent=styles["Title"], fontSize=26, leading=30, textColor=INK, spaceAfter=4)
sub_st     = S("s",  fontSize=11, leading=15, textColor=GREY, alignment=TA_LEFT, spaceAfter=2)
h1_st      = S("h1", fontSize=16, leading=20, textColor=INK, spaceBefore=16, spaceAfter=4, fontName="Helvetica-Bold")
h2_st      = S("h2", fontSize=12.5, leading=16, textColor=INK, spaceBefore=10, spaceAfter=3, fontName="Helvetica-Bold")
body_st    = S("b",  fontSize=10.5, leading=15.5, textColor=INK, spaceAfter=7)
bullet_st  = S("bl", fontSize=10.5, leading=15, textColor=INK)
cell_st    = S("c",  fontSize=9.5, leading=12.5, textColor=INK)
cellb_st   = S("cb", fontSize=9.5, leading=12.5, textColor=colors.white, fontName="Helvetica-Bold")
mono_st    = S("m",  fontSize=9, leading=13, textColor=INK, fontName="Courier")
note_st    = S("n",  fontSize=9.5, leading=13.5, textColor=GREY, spaceAfter=7)

story = []

def h1(t):
    story.append(Paragraph(t, h1_st))
    story.append(HRFlowable(width="100%", thickness=1, color=RULE, spaceBefore=2, spaceAfter=8))

def h2(t): story.append(Paragraph(t, h2_st))
def p(t):  story.append(Paragraph(t, body_st))
def note(t): story.append(Paragraph(t, note_st))
def sp(h=6): story.append(Spacer(1, h))

def bullets(items):
    flow = [ListItem(Paragraph(it, bullet_st), leftIndent=10, value=None) for it in items]
    story.append(ListFlowable(flow, bulletType="bullet", start="•", leftIndent=14, spaceAfter=7))

def table(headers, rows, col_widths):
    data = [[Paragraph(h, cellb_st) for h in headers]]
    for r in rows:
        data.append([Paragraph(str(c), cell_st) for c in r])
    t = Table(data, colWidths=col_widths, repeatRows=1)
    st = [
        ("BACKGROUND", (0,0), (-1,0), HDR),
        ("GRID", (0,0), (-1,-1), 0.5, RULE),
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("TOPPADDING", (0,0), (-1,-1), 5),
        ("BOTTOMPADDING", (0,0), (-1,-1), 5),
        ("LEFTPADDING", (0,0), (-1,-1), 6),
        ("RIGHTPADDING", (0,0), (-1,-1), 6),
    ]
    for i in range(1, len(data)):
        if i % 2 == 0:
            st.append(("BACKGROUND", (0,i), (-1,i), ROW))
    t.setStyle(TableStyle(st))
    story.append(t)
    sp(8)

# ============================================================ COVER
story.append(Spacer(1, 36))
story.append(Paragraph("PNTHR AMBUSH V7.3", title_st))
story.append(Paragraph("Complete System Walkthrough", S("st2", fontSize=14, leading=18, textColor=GREY, spaceAfter=10)))
story.append(HRFlowable(width="100%", thickness=1.2, color=RULE, spaceBefore=2, spaceAfter=10))
story.append(Paragraph("Confidential - PNTHR Funds | Version 7.3.0 | Generated from live code", sub_st))
story.append(Paragraph("This document describes EXACTLY what the code does today and EXACTLY what you "
                       "see on the Ambush V7.3 page in PNTHR's Den. Where the live engine does not yet "
                       "match the backtest, that is stated plainly in the 'What Is Not Built Yet' section "
                       "at the end. Nothing here is aspirational.", note_st))
sp(6)

# ============================================================ WHAT IS IT
h1("What Ambush V7.3 Is")
p("Ambush is a fully automated intraday trading engine that runs on the PNTHR AI 300 universe "
  "(about 297 stocks). It watches for momentum-continuation breakouts during market hours, enters "
  "positions, manages a 5-lot pyramid, protects profits with a trailing stop, and re-enters when "
  "stopped out, all without manual intervention.")
p("The whole engine is one function, <b>runAmbushTick()</b>, that fires every 60 seconds during "
  "market hours using live Interactive Brokers prices for held positions and FMP quotes for everything "
  "it is watching.")
p("<b>The V7.3 stop model.</b> The initial stop is the <b>low of the first hour of trading</b> "
  "(9:30-10:30 ET), minus the IBKR commission per share. There is <b>no weekly structural stop</b> in "
  "Ambush. Because that first-hour stop is tight, the engine buys <b>more shares</b> for the same fixed "
  "dollar risk, which is exactly what you want. (Carnivore and the weekly AI 300 strategy still use "
  "weekly stops; those are separate systems and are untouched.)")

# ============================================================ THE CLOCK
h1("The Clock: When It Runs")
p("A cron job fires every minute from 9:30 AM to 4:05 PM ET, Monday to Friday (roughly 390 ticks per "
  "day). The engine's own market-hours check keeps it inside 9:30-4:05. If a tick is still running when "
  "the next one fires, it skips, so two ticks never overlap.")
h2("Two modes inside the day")
bullets([
    "<b>First hour (9:30-10:30 ET):</b> data collection only. The engine records the running "
    "first-hour low and high from live prices. No entries, exits, or lot triggers fire. These ticks "
    "build the first-hour range that becomes the day's stop reference.",
    "<b>After the first hour (10:30 AM - 4:05 PM ET):</b> full processing. Stops, lot triggers, Break "
    "Even, trailing ratchets, breakout detection, and new entries all run every 60 seconds.",
])

# ============================================================ TICK STARTUP
h1("What Happens at the Start of Every Tick")
h2("Step 1 - Is it enabled?")
p("The engine reads <b>pnthr_ambush_config</b>. If <b>enabled</b> is false, the tick returns "
  "immediately and nothing happens. This is the LIVE / OFF switch on the dashboard.")
h2("Step 2 - Read live NAV")
p("The IBKR bridge syncs your account's net liquidation value to your user profile every 60 seconds. "
  "The engine reads it from the profile linked to the config's ownerId. Fallback chain: <b>IBKR NAV "
  "-&gt; config.nav -&gt; $83,000.</b>")
note("IMPORTANT: ownerId must be set (it is saved when you save the config from the dashboard while "
     "logged in as the admin whose IBKR account is synced). If it is missing, the engine gets no IBKR "
     "prices for held positions AND NAV silently falls back to $83,000.")
h2("Step 3 - Pick the sizing tier")
p("Based on live NAV, the engine picks the graduated sizing multiplier (covered in detail below): "
  "50% under $125K, 75% from $125K to $166K, 100% above $166K.")
h2("Step 4 - Load signal context (one database read)")
p("Loads weekly candles for all AI 300 tickers (for the BL/SS weekly signal), the PAI300 index weekly "
  "candles with a 36-week EMA (the regime gate), and the AI sector tier rankings by date (the sector "
  "gate). Every AI 300 ticker uses the PAI300 regime and the AI sector tiers. There is no SPY gate and "
  "no Carnivore ETF gate in Ambush.")
h2("Step 5 - Fetch live prices")
bullets([
    "<b>IBKR bridge</b> provides marketPrice for held positions (ACTIVE / PROTECT). This is the "
    "primary, real-time source.",
    "<b>FMP batch quote</b> provides prices for everything else (stalking, attack, and new-entry "
    "candidates), up to 50 tickers per call.",
    "IBKR prices take priority; FMP is the fallback when the bridge is quiet.",
])
h2("Step 6 - Build synthetic hourly bars")
p("Each 60-second price is folded into a synthetic hourly OHLC bar stored on the position. Open = first "
  "price of the hour, High = max, Low = min, Close = latest. When the hour rolls over, the bar finalizes "
  "and becomes the previous bar. These give the engine hourly candle patterns for breakout detection and "
  "the trailing exit, built entirely from live prices.")

# ============================================================ THE STOP
h1("The Heart of V7.3: The First-Hour Stop and Position Size")
p("This is the part that changed and the part that matters most. Here is exactly what the code does for "
  "a brand-new long entry:")
bullets([
    "<b>Initial stop</b> = first-hour low minus $0.005 per share (the IBKR commission). For a short, "
    "it is the first-hour high plus $0.005.",
    "<b>Risk per share (RPS)</b> = entry price minus the stop.",
    "<b>Total shares</b> = the smallest of three caps, then scaled by the tier multiplier:",
])
table(
    ["Cap", "Formula", "What it protects"],
    [
        ["Max loss", "$300 / RPS", "No single trade risks more than $300 to its stop"],
        ["NAV risk", "1% of NAV / RPS", "No single trade risks more than 1% of the fund"],
        ["Concentration", "10% of NAV / entry", "No single name is more than 10% of NAV in notional"],
    ],
    [1.1*inch, 1.7*inch, 3.6*inch],
)
p("The engine takes the <b>smallest</b> of those three share counts, then multiplies by the tier "
  "multiplier (0.50 / 0.75 / 1.00). At launch ($83K NAV, 50% tier) that means the most a trade can lose "
  "to its stop is about <b>$150</b>, not $300.")
note("Why $300 usually wins over the 1% cap: 1% of $100K is $1,000, far bigger than $300, so the $300 "
     "cap (or the 10% concentration cap on a tight-stop, high-priced name) is what limits you in "
     "practice. The 1% cap only bites when the fund is small.")
h2("How the position is split into 5 lots")
p("The total share count is divided into the 5-lot pyramid. Lot 1 is 35% of the total and fills at "
  "entry; the rest are buy-stops above (for longs) at fixed offsets:")
table(
    ["Lot", "Offset from entry", "Share weight", "Role"],
    [
        ["L1", "0% (at entry)", "35%", "Initial position"],
        ["L2", "+3%", "25%", "First add"],
        ["L3", "+6%", "20%", "Second add"],
        ["L4", "+10%", "12%", "Third add"],
        ["L5", "+14%", "8%", "Final add"],
    ],
    [0.7*inch, 1.8*inch, 1.3*inch, 2.6*inch],
)
note("Worked example, NVDA, $100K NAV (50% tier), entry $136.00, first-hour low $134.00: RPS = $2.00; "
     "raw shares = min(300/2=150, 1000/2=500, 10000/136=73) = 73 (the 10% cap binds here); times 0.50 = "
     "36 total shares; L1 = round(36 x 0.35) = 13 shares. Worst case to the $134 stop is about $72 on "
     "that lot and about $72 at full size, well under the $150 tier limit.")

# ============================================================ GRADUATED SIZING
h1("Graduated Sizing: How It Steps Up")
p("Starting at $83K, full-size positions would burn cash too fast and force skipped trades. Graduated "
  "sizing fixes that by holding the same risk-to-NAV ratio as the fund grows:")
table(
    ["Tier", "Sizing", "Max loss / trade", "NAV threshold", "Meaning"],
    [
        ["Start", "50%", "$150", "$83K (launch)", "Half size, builds cash, more trades"],
        ["Step 2", "75%", "$225", "$125K", "Three-quarter size, still conservative"],
        ["Step 3", "100%", "$300", "$166K", "Full size, account can carry it"],
    ],
    [0.7*inch, 0.8*inch, 1.4*inch, 1.4*inch, 2.4*inch],
)
p("Each step is roughly a 50% NAV increase from the prior one, so you only size up after the strategy "
  "has proven itself at the current tier. The tier is read live from IBKR NAV every tick - no manual "
  "switch. In the backtest, graduated sizing matched full-size returns (about $8.4M from the baseline) "
  "while improving every risk metric: higher Sharpe, lower drawdown, and fewer cash-skip events.")

# ============================================================ WITHDRAWAL
h1("The $2M Withdrawal Rule")
p("To bound risk and bank profits, the engine follows a withdrawal rule: <b>whenever the account reaches "
  "$2,000,000, it sizes off only the remaining $1,000,000 and raises a WITHDRAW $1M alert.</b> You then "
  "manually wire $1M out of the IBKR account. Once the cash is actually pulled (real NAV drops back below "
  "$2M), the engine sizes off the real NAV again, and the cycle repeats at the next $2M.")
p("Why it makes MORE money, not less: the strategy's edge is in DOLLARS per trade (loss capped near $300). "
  "At $1M NAV those dollars are a big percentage, so the account doubles $1M to $2M quickly; at $10M NAV "
  "the same dollars barely move the needle. Keeping NAV low via withdrawals holds the percentage growth "
  "rate high. In the backtest, withdrawing $1M at every $2M produced about <b>$15.2M of TOTAL value</b> "
  "($8.2M still in the account plus $7M banked) versus about $9.7M if left to compound - with far less "
  "money at risk at any moment.")
note("IMPORTANT: the engine CANNOT move money. It sizes off the reduced 'trading NAV' and shows the alert; "
     "the actual $1M wire is a manual action you take. This rule is dormant at the $83K launch - it does "
     "not trigger until the account first reaches $2M.")

# ============================================================ PHASE A
h1("Phase A: Managing Your Open Positions")
p("Every ACTIVE and PROTECT position is checked against its live price every 60 seconds. During the "
  "first hour the engine only collects the first-hour low/high and skips the checks below. After 10:30 "
  "it runs these in order:")
h2("The stop, start to finish (this is the V7.3 model)")
p("1) <b>Entry to +$75:</b> the stop is the <b>first-hour low</b> (minus fees), held fixed - no daily "
  "ratchet. If price breaks it, the position exits and drops to STALKING (reason <b>1H_LOW_BREAK</b> for "
  "longs, <b>1H_HIGH_BREAK</b> for shorts). 2) <b>At +$75 profit:</b> the stop jumps to <b>breakeven</b> "
  "(avg cost plus fees) and the state flips ACTIVE to PROTECT. 3) <b>As each new lot fills after "
  "breakeven:</b> the stop moves up to the <b>previous lot's trigger price</b>, but NEVER worse than the "
  "recomputed breakeven - that is the guardrail that caps cheap-stock give-backs. There is NO daily "
  "first-hour-low ratchet anywhere in V7.3.")
h2("Check A - Lot trigger")
p("If price reaches the next lot's trigger (+3 / +6 / +10 / +14%), the lot fills at the trigger plus "
  "slippage and the average cost is recomputed. Post-breakeven the stop then follows the lots (previous "
  "lot price, floored at breakeven) and a MODIFY_STOP goes to the bridge.")
h2("Check B - 2-bar broken-low exit (post-breakeven)")
p("Once past breakeven, the engine watches for two completed hourly bars making lower lows (higher highs "
  "for shorts). When a later bar takes out that low by $0.01, it exits THERE - at the broken low - as long "
  "as that price is better than the hard stop. The 60-second check fires it the moment it confirms. (Exit "
  "reason: <b>TRAILING_STOP</b>.)")
h2("Check C - Hard stop")
p("If price hits the stop, the position exits at the stop: pre-breakeven that is the first-hour stop "
  "(<b>1H_LOW_BREAK</b>); post-breakeven it is the lot/breakeven stop (<b>LOT_STOP</b>).")
h2("Check D - Break Even")
p("When unrealized profit reaches <b>$75</b>, the stop jumps to breakeven, the state flips ACTIVE to "
  "PROTECT, and a MODIFY_STOP goes to the bridge. From here the trade cannot give back more than fees.")

# ============================================================ PHASE B/C/D
h1("Phase B: Executing Re-entries (ATTACK to ACTIVE)")
p("ATTACK means a breakout was confirmed and the entry executes on the next tick. The engine enters at "
  "the live price with slippage and sets a <b>tighter</b> re-entry stop: the running low minus $0.01 "
  "(long) or running high plus $0.01 (short). Because the stock pulled back before breaking out again, "
  "this stop is usually tighter than the original, so risk per share shrinks with each cycle. It sizes "
  "with the same 3-cap rule and the tier multiplier, then transitions to ACTIVE.")

h1("Phase C: Watching for Re-entries (STALKING)")
p("STALKING means the engine was stopped out and is watching for a clean re-entry. Each tick: if the "
  "weekly BL (long) or SS (short) signal has expired, the position is deleted entirely - the trend is "
  "over. Otherwise it checks the PAI300 regime and the sector tier, updates the running low/high, and "
  "looks for a confirmed breakout on the completed synthetic bars (a green breakout for longs: the bar "
  "closes up, takes out the prior bar's high, and closes above it). On a confirmed breakout it moves to "
  "ATTACK and the entry fires on the next tick.")

h1("Phase D: New Entries (Fresh Signals to ACTIVE)")
p("This is how brand-new positions enter. The engine scans every AI 300 ticker with no existing Ambush "
  "position. To enter, a ticker must pass every gate:")
table(
    ["Gate", "Test"],
    [
        ["1. Regime", "PAI300 above its 36-week EMA for a long, below it for a short."],
        ["2. Sector", "The ticker's AI sector is not ranked AVOID that day."],
        ["3. Weekly signal", "An active BL (long) or SS (short) from the weekly trend model."],
        ["4. 2-day trigger", "Today's price clears the highest high (long) / lowest low (short) of the prior 2 days by $0.01."],
        ["5. Hourly breakout", "FMP hourly bars show a confirmed breakout in 2 consecutive bars after the first hour."],
        ["6. Stop validity", "First-hour low (minus fee) is a valid stop below entry (above, for shorts)."],
        ["7. Sizing", "The sizing math produces at least 1 share."],
        ["8. Position room", "Total open positions below the max (see note on the cap below)."],
    ],
    [1.4*inch, 5.0*inch],
)
p("If every gate passes, a new ACTIVE position is created with Lot 1 filled and the orders are queued "
  "to the bridge.")
note("On the position cap: in Ambush V7.3 there is effectively NO position cap - your only limits are "
     "NAV and the cash available to hold risk. The internal maxPositions value defaults to 999 (a "
     "stand-in for 'unlimited').")

# ============================================================ OUTBOX / BRIDGE
h1("How Orders Reach Interactive Brokers")
p("Every order action writes a command to the <b>pnthr_ambush_outbox</b> collection. The Python bridge "
  "polls that outbox every 15 seconds and executes each command through the TWS API, then marks it DONE "
  "or FAILED.")
table(
    ["Command", "When", "What the bridge does"],
    [
        ["BUY_ENTRY", "New long entry or re-entry", "Market buy, then place the protective stop"],
        ["SHORT_ENTRY", "New short entry or re-entry", "Market short, then place the protective stop"],
        ["SELL_EXIT", "Long exited", "Cancel related orders, then market sell all shares"],
        ["COVER_EXIT", "Short covered", "Cancel related orders, then buy to cover all shares"],
        ["MODIFY_STOP", "Break Even or trailing ratchet", "Move the protective stop to the new price"],
        ["PLACE_LOT_TRIGGER", "Lot 2-5 triggered", "Place the buy-stop at the trigger price"],
    ],
    [1.6*inch, 2.1*inch, 2.7*inch],
)
note("The bridge only places real orders when three switches are on: IBKR_WRITES_ENABLED=true, "
     "dry-run OFF, and AMBUSH_ENABLED=true. By default writes are OFF and dry-run is ON, so nothing "
     "reaches TWS until those are flipped on the machine running the bridge.")

# ============================================================ COSTS
h1("The Costs Baked In")
bullets([
    "<b>Slippage:</b> 5 basis points on every fill, entry and exit (about $0.05 per share on a $100 "
    "stock).",
    "<b>Commission:</b> IBKR Pro Fixed - $0.005 per share, $1.00 minimum per order, 1% of trade value "
    "maximum.",
    "<b>Short borrow:</b> for shorts only, based on days held and the sector borrow rate.",
])
p("These are the same costs the backtest used, so live results should track the backtest closely - "
  "subject to the gaps listed at the very end of this document.")

# ============================================================ STATE MACHINE
h1("The State Machine in One Picture")
story.append(Paragraph(
    "[no position] -- all 8 gates pass --------------------&gt; ACTIVE<br/>"
    "ACTIVE -- unrealized P&amp;L reaches $75 ----------------&gt; PROTECT<br/>"
    "ACTIVE -- price breaks today's first-hour low --------&gt; STALKING (cycle + 1)<br/>"
    "PROTECT -- 2-bar trailing exit ----------------------&gt; STALKING (cycle + 1)<br/>"
    "PROTECT -- first-hour break (trailing not yet on) ---&gt; STALKING (cycle + 1)<br/>"
    "STALKING -- weekly signal expires -------------------&gt; [deleted]<br/>"
    "STALKING -- confirmed breakout ----------------------&gt; ATTACK<br/>"
    "ATTACK -- next tick, sizing OK ----------------------&gt; ACTIVE<br/>"
    "ATTACK -- bad stop or sizing fails ------------------&gt; [deleted]",
    mono_st))
sp(8)
p("The system is relentless: it enters, gets stopped out, watches for a tighter re-entry, and enters "
  "again. Each cycle gets a tighter stop, so risk per share falls with each attempt. It only quits a "
  "name when the weekly signal expires, meaning the trend has genuinely ended.")

# ============================================================ UI
story.append(PageBreak())
h1("What You See on the Ambush V7.3 Page in PNTHR's Den")
p("This is a section-by-section description of the live dashboard, top to bottom. It auto-refreshes "
  "every 60 seconds.")

h2("1. Status Bar (top)")
bullets([
    "<b>LIVE / OFF toggle</b> - the master switch (writes config.enabled). Green LIVE, grey OFF.",
    "<b>NAV</b> with its source in parentheses - (IBKR) when the bridge fed it, (config) on fallback.",
    "<b>Sizing</b> tier badge (50% / 75% / 100%) with an info circle explaining the thresholds.",
    "<b>Positions</b> count shown as open / max.",
    "<b>Last tick</b> time, the price source, and an amber <b>1H CAPTURE</b> flag during the first hour.",
    "<b>Stats row:</b> Trades, Win Rate, total P&amp;L, live-prices-this-tick, and a <b>Manual Tick</b> "
    "button to force a tick.",
])

h2("2. Flow Indicator")
p("A single row showing STALKING -&gt; ATTACK -&gt; ACTIVE -&gt; PROTECT with a colored count badge under "
  "each, so you can see the whole pipeline at a glance.")

h2("3. Last Tick Actions (collapsible)")
p("A color-coded feed of everything that happened on the most recent tick: green for new entries and "
  "re-entries, blue for Break Even and trailing, amber for lot fills and cap-skips, red for exits, "
  "purple for breakout detections, grey for expired signals.")

h2("4. Live Positions (ACTIVE + PROTECT, PROTECT listed first)")
p("One row per open position with these columns:")
table(
    ["Column", "What it shows"],
    [
        ["State", "ACTIVE (pre-Break Even) or PROTECT (Break Even hit, trailing)."],
        ["Ticker / Dir", "Symbol and LONG (green) / SHORT (red)."],
        ["Entry", "Lot 1 fill price with slippage."],
        ["Avg Cost", "Weighted average across filled lots."],
        ["Shares", "Filled shares / total planned at L5."],
        ["Stop", "Current stop. Starts at the first-hour low, jumps to Break Even, ratchets up while trailing."],
        ["1H Exit", "Today's first-hour low (long) or high (short) - the tight exit tripwire."],
        ["Risk $", "Loss if stopped now: (avg cost - stop) x shares. Turns red above $200."],
        ["RPS", "Risk per share = avg cost minus stop."],
        ["Lots", "Pyramid progress, e.g. L1/5, L3/5."],
        ["Peak P&amp;L", "Highest unrealized profit; shows a blue 'BE' check once at Break Even."],
        ["Cycle / Date", "Re-entry cycle number and entry date."],
    ],
    [1.3*inch, 5.1*inch],
)
p("<b>Click any row to expand</b> a detail panel:")
bullets([
    "<b>Lot Plan:</b> L1-L5 with trigger price, share count, status dot (green FILLED / amber WAITING / "
    "grey LOCKED), and the % offset. Plus total shares and notional at full L5.",
    "<b>Trailing Status (PROTECT):</b> Break Even date, trailing ACTIVE or PENDING (day after BE), the "
    "consecutive lower-low counter (X / 2), the previous bar low, and the profit locked in at the stop.",
    "<b>Break Even Progress (ACTIVE):</b> a bar showing peak profit against the $75 threshold.",
])

h2("5. Stalking - Re-entry Watch")
p("Tickers stopped out and watching for re-entry. Columns: Ticker, Dir, Cycle number, Running Low "
  "(long) / Running High (short), the estimated re-entry stop (running low - $0.01), and the last bar "
  "seen. Admins get a remove button.")

h2("6. Attack - Entry Queued")
p("Only appears when something is queued. Shows the ticker, direction, cycle, estimated stop, and "
  "'ENTRY QUEUED'. This state usually lasts one tick.")

h2("7. Recent Trades")
p("The last closed trades with entry, exit, shares, net P&amp;L, commission, borrow, peak profit, an "
  "exit-type badge (TRAIL / 1H LOW / 1H HIGH), cycle, and date.")

h2("8. Outbox (collapsible)")
p("Every bridge command with its details and a status of PENDING (amber), DONE (green), or FAILED "
  "(red), plus the time it was queued.")

h2("Info circles")
p("Small 'i' circles throughout open plain-English popups explaining what the engine does with each "
  "metric, so every number on the page is self-documenting.")

# ============================================================ GAPS
story.append(PageBreak())
h1("What Is NOT Built Yet in the Live Engine (Read This)")
p("In the spirit of no surprises, here is exactly where the LIVE engine does not yet match the backtest "
  "or the intended design. These are honest gaps, not features.")
bullets([
    "<b>IBKR fill reconciliation - NOT built (the main one).</b> The engine places real resting stops at "
    "IBKR (first-hour stop, then breakeven, then the lot-trail). If IBKR fills one of those stops, the "
    "engine does not yet detect the closed position - it only watches price - so its own record can "
    "drift. The intended design: the resting stop fills at IBKR, then Ambush reconciles about 60 seconds "
    "later and arms the next order. This is the top remaining build item.",
    "<b>Cash gate is approximate.</b> The live engine now skips a new entry it cannot fund (available "
    "cash = trading NAV minus capital already deployed), but it does not track lot fills or in-flight "
    "exits to the penny like the backtest. IBKR buying power is the hard backstop.",
    "<b>No writer-gate on the cron.</b> If the Node server ever runs in more than one place at once "
    "(for example locally while Render is up), both could tick the same database and double-process. "
    "The reconciliation cron has a writer-gate; the Ambush cron does not yet. Run ONE server instance.",
    "<b>Operational switches to confirm before go-live:</b> bridge writes enabled and dry-run off, "
    "config.enabled true with ownerId set, the three data collections fresh through the prior Friday's "
    "close, and the FMP key present on the server.",
])
sp(6)
p("<b>What IS in the live engine now (V7.3):</b> first-hour stop, bigger share count, graduated sizing, "
  "the lot-based trailing stop with the breakeven guardrail, the 2-bar broken-low exit, re-entries, the "
  "$2M withdrawal alert + trade-only-$1M sizing, and an approximate cash gate. The remaining work is the "
  "fill reconciliation, the cron writer-gate, and flipping the operational switches.")
sp(10)
story.append(HRFlowable(width="100%", thickness=1, color=RULE, spaceBefore=2, spaceAfter=6))
story.append(Paragraph("PNTHR Ambush V7.3 System Walkthrough - Confidential - PNTHR Funds - "
                       "generated directly from the live code.", note_st))

doc = SimpleDocTemplate(OUT, pagesize=letter,
                        leftMargin=0.85*inch, rightMargin=0.85*inch,
                        topMargin=0.7*inch, bottomMargin=0.7*inch,
                        title="PNTHR Ambush V7.3 System Walkthrough",
                        author="PNTHR Funds")
doc.build(story)
print("WROTE", OUT)
