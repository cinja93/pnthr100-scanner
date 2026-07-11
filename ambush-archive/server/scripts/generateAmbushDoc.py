#!/usr/bin/env python3
"""Generate PNTHR Ambush V7.1 System Walkthrough PDF"""

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, HRFlowable
)
import os

OUTPUT = os.path.expanduser("~/Downloads/PNTHR_Ambush_V7.1_System_Walkthrough.pdf")

doc = SimpleDocTemplate(
    OUTPUT,
    pagesize=letter,
    leftMargin=0.75*inch,
    rightMargin=0.75*inch,
    topMargin=0.75*inch,
    bottomMargin=0.75*inch,
)

styles = getSampleStyleSheet()

# Custom styles
styles.add(ParagraphStyle(
    'DocTitle', parent=styles['Title'],
    fontSize=22, leading=28, textColor=HexColor('#000000'),
    spaceAfter=4,
))
styles.add(ParagraphStyle(
    'DocSubtitle', parent=styles['Normal'],
    fontSize=11, leading=14, textColor=HexColor('#555555'),
    alignment=TA_CENTER, spaceAfter=20,
))
styles.add(ParagraphStyle(
    'H1', parent=styles['Heading1'],
    fontSize=16, leading=20, textColor=HexColor('#1a1a1a'),
    spaceBefore=20, spaceAfter=8,
    borderWidth=0, borderPadding=0,
))
styles.add(ParagraphStyle(
    'H2', parent=styles['Heading2'],
    fontSize=13, leading=16, textColor=HexColor('#333333'),
    spaceBefore=14, spaceAfter=6,
))
styles.add(ParagraphStyle(
    'H3', parent=styles['Heading3'],
    fontSize=11, leading=14, textColor=HexColor('#444444'),
    spaceBefore=10, spaceAfter=4,
))
styles.add(ParagraphStyle(
    'Body', parent=styles['Normal'],
    fontSize=10, leading=14, textColor=HexColor('#222222'),
    spaceAfter=6,
))
styles.add(ParagraphStyle(
    'BulletPnthr', parent=styles['Normal'],
    fontSize=10, leading=14, textColor=HexColor('#222222'),
    leftIndent=18, bulletIndent=6, spaceAfter=3,
))
styles.add(ParagraphStyle(
    'SubBullet', parent=styles['Normal'],
    fontSize=9.5, leading=13, textColor=HexColor('#333333'),
    leftIndent=36, bulletIndent=24, spaceAfter=2,
))
styles.add(ParagraphStyle(
    'CodePnthr', parent=styles['Normal'],
    fontSize=9, leading=12, textColor=HexColor('#333333'),
    fontName='Courier', leftIndent=12, spaceAfter=6,
    backColor=HexColor('#f5f5f5'),
))
styles.add(ParagraphStyle(
    'TableCell', parent=styles['Normal'],
    fontSize=9, leading=12, textColor=HexColor('#222222'),
))
styles.add(ParagraphStyle(
    'TableHeader', parent=styles['Normal'],
    fontSize=9, leading=12, textColor=HexColor('#ffffff'),
    fontName='Helvetica-Bold',
))
styles.add(ParagraphStyle(
    'Footer', parent=styles['Normal'],
    fontSize=8, leading=10, textColor=HexColor('#999999'),
    alignment=TA_CENTER,
))

story = []

def h1(text):
    story.append(Paragraph(text, styles['H1']))
    story.append(HRFlowable(width="100%", thickness=1, color=HexColor('#cccccc'), spaceAfter=8))

def h2(text):
    story.append(Paragraph(text, styles['H2']))

def h3(text):
    story.append(Paragraph(text, styles['H3']))

def p(text):
    story.append(Paragraph(text, styles['Body']))

def bullet(text):
    story.append(Paragraph(text, styles['BulletPnthr'], bulletText='•'))

def sub_bullet(text):
    story.append(Paragraph(text, styles['SubBullet'], bulletText='–'))

def code(text):
    for line in text.strip().split('\n'):
        story.append(Paragraph(line.replace(' ', '&nbsp;'), styles['CodePnthr']))
    story.append(Spacer(1, 4))

def spacer(h=8):
    story.append(Spacer(1, h))

def make_table(headers, rows, col_widths=None):
    data = [[Paragraph(h, styles['TableHeader']) for h in headers]]
    for row in rows:
        data.append([Paragraph(str(c), styles['TableCell']) for c in row])

    t = Table(data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), HexColor('#333333')),
        ('TEXTCOLOR', (0, 0), (-1, 0), HexColor('#ffffff')),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 6),
        ('TOPPADDING', (0, 0), (-1, 0), 6),
        ('BOTTOMPADDING', (0, 1), (-1, -1), 4),
        ('TOPPADDING', (0, 1), (-1, -1), 4),
        ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#cccccc')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [HexColor('#ffffff'), HexColor('#f8f8f8')]),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))
    story.append(t)
    spacer(8)


# ══════════════════════════════════════════════════════════════════════════
# DOCUMENT CONTENT
# ══════════════════════════════════════════════════════════════════════════

story.append(Paragraph("PNTHR AMBUSH V7.1", styles['DocTitle']))
story.append(Paragraph("Complete System Walkthrough", styles['DocSubtitle']))
story.append(Paragraph("Confidential - PNTHR Funds | Version 7.1.0 | May 2026", styles['Footer']))
spacer(12)

# ── What is Ambush ──
h1("What is Ambush?")
p("Ambush is a fully automated intraday trading system that runs on the AI 300 universe (297 stocks). It watches for momentum continuation breakouts during market hours, enters positions, manages a 5-lot pyramid, protects profits with a trailing stop, and re-enters when stopped out - all without any manual intervention.")
p("The entire system runs as a single function called <b>runAmbushTick()</b> that fires <b>every 60 seconds</b> during market hours, powered by live IBKR prices.")

# ── The Clock ──
h1("The Clock: When Does It Run?")
p("A cron job fires <b>every 60 seconds from 9:30 AM to 4:05 PM ET</b>, Monday through Friday. That is roughly <b>390 ticks per day</b>.")
spacer(4)
p("The tick is split into two modes:")
bullet("<b>First Hour (9:30-10:30 AM ET)</b>: Data collection only. Captures the first-hour low and first-hour high from live IBKR prices. No entries, exits, or lot triggers fire. These 60 ticks build the first-hour price range.")
bullet("<b>After First Hour (10:30 AM - 4:05 PM ET)</b>: Full processing. Stops, lot triggers, Break Even, trailing ratchets, breakout detection, and new entries all run every 60 seconds.")
spacer(4)
p("There is a guard - if a tick is still running when the next one fires, it skips. No overlap.")

# ── Tick Startup ──
h1("Tick Startup: What Happens First")
p("Every tick starts the same way:")

h3("Step 1: Check if enabled")
p("Reads <b>pnthr_ambush_config</b> from MongoDB. If enabled is false, the tick returns immediately. Nothing happens.")

h3("Step 2: Read live NAV")
p("The IBKR bridge syncs your account's net liquidation value to <b>user_profiles.accountSize</b> every 60 seconds. The cron reads this by looking up the user profile linked to config.ownerId. Fallback chain: IBKR NAV -> config.nav -> $83,000.")

h3("Step 3: Compute sizing tier")
p("Based on the live NAV:")
make_table(
    ['NAV Range', 'Multiplier', 'Effect'],
    [
        ['Below $125,000', '50% (0.50x)', 'Half-sized positions, more trades, builds cash faster'],
        ['$125,000 - $165,999', '75% (0.75x)', 'Three-quarter sized, still conservative'],
        ['$166,000+', '100% (1.00x)', 'Full position sizes, account can handle it'],
    ],
    col_widths=[1.8*inch, 1.2*inch, 3.5*inch]
)

h3("Step 4: Load signal context")
p("One database query loads weekly candles for all AI 300 tickers (for BL/SS signal detection), PAI300 index weekly candles with 36-week EMA (for regime gate), AI sector tier rankings by date (for sector gate), and pre-computed signal periods.")

h3("Step 5: Fetch live prices")
p("Two data sources provide real-time prices:")
bullet("<b>IBKR bridge</b>: For held positions (ACTIVE/PROTECT), the bridge syncs marketPrice into pnthr_ibkr_positions every 60 seconds. This is the primary price source - real IBKR live data, no delay.")
bullet("<b>FMP batch quote</b>: For non-held tickers (STALKING, ATTACK, and MCE candidates), a single FMP /quote API call fetches prices for up to 50 tickers at once. Lightweight and fast.")
p("IBKR prices take priority. If the bridge is down, FMP quotes serve as fallback for everything.")

h3("Step 6: Build synthetic bars")
p("Each 60-second price tick is accumulated into a synthetic hourly OHLC bar stored on the position document. Open = first price of the hour, High = max, Low = min, Close = latest. When the hour rolls over, the current bar finalizes and becomes the previous bar. This gives the engine hourly candle patterns for breakout detection and trailing exit logic, built entirely from live prices.")

# ── Phase A ──
story.append(PageBreak())
h1("Phase A: Manage Existing Positions (ACTIVE + PROTECT)")
p("This is where your money is. Every ACTIVE and PROTECT position is checked against the live IBKR price every 60 seconds. Stops, lots, Break Even, and trailing all evaluate in real time.")

h2("Step A1: First-Hour Data Collection (9:30-10:30)")
p("During the first hour, each 60-second tick captures the running first-hour low and first-hour high from live IBKR prices. After 10:30, these values are final for the day. They serve as both the initial stop level AND the intraday exit tripwire.")

h2("Step A2: Trailing Stop Ratchet (PROTECT only)")
p("After the first hour closes, if the position has hit Break Even AND trailing is active:")
bullet("<b>LONG</b>: If today's first-hour low is HIGHER than the current stop, move stop up to the first-hour low. The stop only ratchets up, never down.")
bullet("<b>SHORT</b>: If today's first-hour high is LOWER than the current stop, move stop down to the first-hour high.")
p("A MODIFY_STOP order is written to the outbox for the IBKR bridge. After the ratchet, subsequent ticks are no-ops (firstHourLow equals stop).")

h2("Step A3: Real-Time Price Checks (Every 60 Seconds)")
p("After the first hour, every 60-second tick checks the live IBKR price against these conditions in order:")

h3("Check 1: 1H Low/High Break (Pre-Trailing Exit)")
p("Before the trailing stop activates, the first-hour low/high acts as your safety net.")
bullet("<b>LONG</b>: If the live price drops below the first-hour low, EXIT IMMEDIATELY")
sub_bullet("Exit price = first-hour low minus 5bps slippage")
sub_bullet("P&L = (exit price x shares) - commission - (avg cost x shares)")
sub_bullet("Trade logged, position transitions to STALKING with cycleNum + 1")
sub_bullet("Running low set to current price (for re-entry stop calculation)")
sub_bullet("Order: SELL_EXIT with reason 1H_LOW_BREAK")
bullet("<b>SHORT</b>: If the live price breaks above the first-hour high, same logic reversed")
spacer(4)
p("This is the V7.1 innovation - instead of a weekly structural stop (much wider), the first-hour range is used as a tight initial stop. The backtest showed a <b>2.5x better Sharpe ratio</b> because the stop is closer to entry, risk per share is smaller, and losses are cut faster. With 60-second ticks, this exit fires within seconds of the breach, not up to an hour later.")

h3("Check 2: Trailing Stop Exit (2 Consecutive Bars)")
p("Only fires when trailingActive is true (the day AFTER Break Even was hit). Uses synthetic hourly bars built from 60-second price ticks:")
bullet("<b>LONG</b>: The consecutive lower-low counter updates when a new hourly bar completes. If the completed bar made a lower low than the bar before it AND that low was at or below the stop, the counter increments. Additionally, every 60-second tick checks if the CURRENT bar's running low is extending a lower-low sequence into the stop. If the previous completed bar was already a lower-low and the current bar confirms, EXIT fires immediately - within 60 seconds of the condition being met.")
bullet("<b>SHORT</b>: Same logic tracking consecutive higher-high bars against the stop")
spacer(4)
p("This 'give it room to breathe' exit avoids whipsaw stops. You wait for 2 bars confirming the trend has turned against you. But the 60-second intra-bar check means the exit fires the moment it confirms, not an hour later.")

h3("Check 3: Lot Trigger Fill")
p("If the position has unfilled lots (nextLot <= 4), check if the live price hit the trigger:")
make_table(
    ['Lot', 'Offset', '% of Total', 'Purpose'],
    [
        ['L1', '0% (at entry)', '35%', 'Initial position'],
        ['L2', '+3%', '25%', 'First add'],
        ['L3', '+6%', '20%', 'Second add'],
        ['L4', '+10%', '12%', 'Third add'],
        ['L5', '+14%', '8%', 'Final add'],
    ],
    col_widths=[0.6*inch, 1.2*inch, 1.0*inch, 3.7*inch]
)
p("When triggered: fill price = trigger + 5bps slippage. Avg cost recalculated with new shares. If already at Break Even, the stop is recalculated to the new avg cost + fees.")

h3("Check 4: Peak P&L Update")
p("Calculates unrealized P&L using the live price. If it is a new high-water mark, updates peak.")

h3("Check 5: Break Even Transition (ACTIVE to PROTECT)")
p("If unrealized P&L reaches <b>$75</b>:")
bullet("atBE flips to true, trailingActive stays false (activates TOMORROW)")
bullet("beDate set to today")
bullet("Stop moves to <b>avg cost + fees per share</b> (LONG) or avg cost - fees per share (SHORT)")
bullet("Fees per share = IBKR Pro Fixed commission ($0.005/share, $1 min, 1% max) / total shares")
bullet("State changes from ACTIVE to PROTECT")
p("This is the critical moment - even if the stock immediately reverses, you exit at roughly breakeven plus a tiny profit to cover fees.")

h3("Check 6: Trailing Activation")
p("The day AFTER Break Even, trailingActive flips to true. This enables the daily first-hour-low ratchet and the 2-bar trailing exit. The one-day delay prevents whipsawing on the day Break Even triggers.")

# ── Phase B ──
story.append(PageBreak())
h1("Phase B: Execute Pending Re-entries (ATTACK to ACTIVE)")
p("ATTACK means 'a breakout was confirmed, execute the entry on the next tick.'")

h3("Step B1: Position cap check")
p("Count all ACTIVE + PROTECT positions. If at the cap, skip with SKIPPED_CAP action.")

h3("Step B2: Calculate entry price")
p("Uses the current live IBKR price, with 5bps slippage applied. For LONG, slippage adds to price. For SHORT, slippage subtracts. Because ticks run every 60 seconds, the entry happens within 60 seconds of the breakout confirmation.")

h3("Step B3: Calculate re-entry stop")
p("Different from a new entry's 1H stop:")
bullet("<b>LONG</b>: running low - $0.01 (the running low is the lowest low since the last exit)")
bullet("<b>SHORT</b>: running high + $0.01")
p("Because the stock pulled back before breaking out again, this stop is typically tighter than the original 1H stop, meaning smaller risk per share.")

h3("Step B4: Validate and size")
p("If the stop is on the wrong side of entry, the position is deleted. The sizing function calculates: RPS = entry - stop. Total shares = min($300/RPS, 1%NAV/RPS, 10%NAV/entry) x sizing multiplier. Split into 5 lots [35%, 25%, 20%, 12%, 8%].")

h3("Step B5: Create ACTIVE position")
p("All fields set, L1 shares filled, nextLot = 1. cycleNum carried forward. Orders enqueued to outbox.")

# ── Phase C ──
h1("Phase C: Watch for Re-entry Breakouts (STALKING)")
p("STALKING means 'I was stopped out, I am watching for a confirmed breakout to re-enter.'")

h3("Step C1: Signal expiration check")
p("If the weekly BL (LONG) or SS (SHORT) signal is no longer active, the position is <b>deleted entirely</b>. No more re-entry attempts. The weekly trend has ended.")

h3("Step C2: Regime check")
p("PAI300 index must be above its 36-week EMA for LONG (bull regime), below for SHORT (bear regime). If wrong regime, skip but do not delete - regime might flip back.")

h3("Step C3: Sector check")
p("The ticker's AI sector must not be in the AVOID tier. If it is, skip this tick.")

h3("Step C4: Breakout scan using synthetic bars")
p("After the first hour, each 60-second tick checks the current synthetic bar (in progress) against the previous completed synthetic bar:")
bullet("<b>Confirmed Green Breakout (LONG)</b>: current bar shows close > open, high > previous bar's high, AND close > previous bar's high")
bullet("<b>Confirmed Red Breakdown (SHORT)</b>: current bar shows close < open, low < previous bar's low, AND close < previous bar's low")
p("The 'close' of the in-progress bar is the latest live price. This means breakouts are detected within 60 seconds of the conditions forming, rather than waiting for the hourly bar to close.")

h3("Step C5: Update running extremes")
p("Each tick updates the running low (if new low) and running high (if new high) from the live price. These are used for re-entry stop calculation.")

h3("Step C6: Transition to ATTACK")
p("If a confirmed breakout is detected, position moves to ATTACK. The actual entry happens on the NEXT 60-second tick. Running low/high and cycle number are carried forward.")

# ── Phase D ──
story.append(PageBreak())
h1("Phase D: New MCE Entries (Fresh Signals to ACTIVE)")
p("MCE = Momentum Continuation Entry. This is how brand new positions enter the system. The system scans every AI 300 ticker with no existing Ambush position.")

h2("The Entry Funnel (All Gates Must Pass)")

h3("Gate 1: PAI300 Regime")
p("The PAI300 index must be above its 36-week EMA for LONG entries, below for SHORT. This is the macro filter.")

h3("Gate 2: Sector OK")
p("The ticker's AI sector must not be ranked AVOID in the daily sector tier rankings.")

h3("Gate 3: Active Weekly Signal")
p("The ticker must have an active BL (Buy Long) signal for LONG, or active SS (Sell Short) for SHORT. This comes from the weekly EMA trend model with sector-optimized periods.")

h3("Gate 4: 2-Day Breakout Trigger")
p("A cheap pre-filter using cached daily bar data (fetched once per day from FMP):")
bullet("<b>LONG</b>: Today's live price must exceed the highest high of the prior 2 trading days + $0.01")
bullet("<b>SHORT</b>: Today's live price must break below the lowest low of the prior 2 trading days - $0.01")
p("Only tickers passing this filter proceed to the more expensive hourly breakout check.")

h3("Gate 5: Confirmed Hourly Breakout")
p("For the narrow set of tickers that pass all pre-filters (typically 5-20), FMP hourly bars are fetched to check for a confirmed green breakout (LONG) or red breakdown (SHORT) in two consecutive bars after the first hour.")

h3("Gate 6: 1H Stop Validity")
p("The initial stop is calculated from the first hour:")
bullet("<b>LONG stop</b> = first-hour low - $0.005 per share (commission)")
bullet("<b>SHORT stop</b> = first-hour high + $0.005 per share")
p("The stop must be below entry (LONG) or above entry (SHORT). If no first-hour data or stop is invalid, skip.")

h3("Gate 7: Sizing")
p("Must produce at least 1 share from the sizing function.")

h3("Gate 8: Position Cap")
p("Total ACTIVE + PROTECT positions must be below the maximum (default 999).")
spacer(4)
p("If ALL gates pass, a new ACTIVE position is created with L1 shares filled. Orders enqueued to the IBKR outbox.")

# ── Outbox ──
h1("The Outbox: How Orders Reach IBKR")
p("Every order action writes a command to the pnthr_ambush_outbox MongoDB collection:")
make_table(
    ['Command', 'When', 'What It Tells the Bridge'],
    [
        ['BUY_ENTRY', 'New LONG entry or re-entry', 'Buy X shares at market'],
        ['SHORT_ENTRY', 'New SHORT entry or re-entry', 'Short X shares at market'],
        ['SELL_EXIT', 'LONG position exited', 'Sell all shares at market'],
        ['COVER_EXIT', 'SHORT position covered', 'Buy to cover all shares'],
        ['MODIFY_STOP', 'Break Even or trailing ratchet', 'Move stop to new price'],
        ['PLACE_LOT_TRIGGER', 'Lot 2-5 triggered', 'Place buy stop at trigger price'],
    ],
    col_widths=[1.3*inch, 1.8*inch, 3.4*inch]
)
p("The IBKR bridge polls this outbox and executes via the TWS API.")

# ── Costs ──
h1("The Costs: What Is Baked In")
p("Every entry and exit has real costs applied:")
bullet("<b>5bps slippage</b> on every fill (entry AND exit). For a $100 stock, that is $0.05 per share adverse.")
bullet("<b>IBKR Pro Fixed commissions</b>: $0.005/share, $1.00 minimum per order, 1% of trade value maximum.")
bullet("<b>Short borrow cost</b>: Calculated from days held and sector rate (SHORT positions only).")
p("These are the same costs used in the backtest, so live performance should track backtested results.")

# ── Graduated Sizing ──
story.append(PageBreak())
h1("Graduated Sizing: How It Protects You")
p("Starting with $83K, full position sizes would use up cash too quickly and force skipping entries (the backtest showed 3,860 cash-skip events). Graduated sizing solves this:")
make_table(
    ['NAV', 'Multiplier', 'Effect'],
    [
        ['Below $125K', '50%', 'Half-sized positions, more trades, builds cash'],
        ['$125K - $166K', '75%', 'Three-quarter sized, still conservative'],
        ['$166K+', '100%', 'Full sizing, account can handle it'],
    ],
    col_widths=[1.5*inch, 1.0*inch, 4.0*inch]
)
p("The multiplier applies to total shares AFTER the 3-way minimum (max loss / NAV risk / concentration cap).")
spacer(4)
p("The backtest proved this gives essentially identical total returns (both hit $8.4M from $83K) but with better risk metrics:")
bullet("Sharpe: 10.05 -> 10.17")
bullet("Max drawdown: 3.62% -> 3.07%")
bullet("Cash skips: 3,860 -> 3,034")
bullet("Hit $1M five days FASTER (more trades taken)")
spacer(4)
p("Tier bumps happen automatically. Each tick reads the live IBKR NAV. No manual intervention required.")

# ── State Machine ──
h1("The State Machine (Summary)")
code("""[no position] --- Phase D: full funnel pass ----------> ACTIVE
                                                        |
ACTIVE --- unrealized P&L >= $75 --------------------> PROTECT
ACTIVE --- 1H low break (pre-trailing) --------------> STALKING (cycle+1)
                                                        |
PROTECT --- trailing stop (2 consecutive bars) -------> STALKING (cycle+1)
PROTECT --- 1H break (if trailing not yet on) --------> STALKING (cycle+1)
                                                        |
STALKING --- weekly signal expires -------------------> [deleted]
STALKING --- confirmed breakout ----------------------> ATTACK
                                                        |
ATTACK --- next tick, sizing OK ----------------------> ACTIVE
ATTACK --- invalid stop or sizing fails --------------> [deleted]""")

p("The system is relentless - it enters, gets stopped out, watches for re-entry, enters again. Each cycle gets a tighter stop (running low instead of 1H low), so risk per share decreases with each attempt. It only quits when the weekly signal expires, meaning the trend has genuinely ended.")

# ── Dashboard ──
h1("The Dashboard: What You See")

h3("Status Bar")
p("Live/Off toggle, NAV with source (IBKR or config fallback), sizing tier badge with info popup, position count, last tick time, manual tick button, trade stats.")

h3("Flow Indicator")
p("STALKING -> ATTACK -> ACTIVE -> PROTECT with colored count badges showing the pipeline at a glance.")

h3("Last Tick Actions")
p("Collapsible event feed from the most recent 60-second tick. Color-coded: green for entries, blue for Break Even/trailing, amber for lot fills, red for exits, purple for breakout detections.")

h3("Live Positions Table")
p("Every ACTIVE and PROTECT position with: entry, avg cost, shares (filled/total at L5), stop price, 1H exit level, risk at stop, risk per share, lot status, peak P&L or Break Even checkmark, cycle number, entry date. Click any row to expand:")
bullet("Full 5-lot plan with trigger prices, shares, status dots (green FILLED / amber WAITING / grey LOCKED)")
bullet("Total shares and notional value at full L5")
bullet("Break Even progress bar (ACTIVE) showing peak vs $75 threshold")
bullet("Trailing status (PROTECT): BE date, trailing active/pending, consecutive LL counter, prev bar low, profit locked at stop")

h3("Stalking Table")
p("Tickers watching for re-entry. Shows cycle number, running low/high, estimated re-entry stop.")

h3("Attack Table")
p("Tickers with entry queued for the next 60-second tick. Usually empty since ATTACK lasts only one tick.")

h3("Recent Trades")
p("Last 20 closed trades with entry/exit prices, shares, net P&L, commission, borrow cost, peak profit, exit type badge (TRAIL or 1H LOW/HIGH).")

h3("Outbox")
p("Collapsible panel showing all bridge commands with PENDING/DONE/FAILED status.")

h3("Info Circles")
p("20+ clickable info popups throughout the dashboard explaining exactly what the engine does with each metric.")

spacer(20)
story.append(HRFlowable(width="100%", thickness=1, color=HexColor('#cccccc'), spaceAfter=8))
story.append(Paragraph("PNTHR Ambush V7.1 System Walkthrough - Confidential - PNTHR Funds", styles['Footer']))
story.append(Paragraph("Generated May 2026", styles['Footer']))

# Build
doc.build(story)
print(f"PDF saved to: {OUTPUT}")
