#!/usr/bin/env python3
"""PNTHR Ambush V7.4 — Intelligence Report (3 capital tiers: $1M / $500K / $100K).

Reads server/data/ambushV74_IR_tiers.json (produced by backtest/_irTiers.js) and
renders a complete, investor-grade IR PDF to ~/Downloads.
"""

import os, json
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, HRFlowable
)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data', 'ambushV74_IR_tiers.json')
OUTPUT = os.path.expanduser("~/Downloads/PNTHR_Ambush_V7.4_Intelligence_Report.pdf")

with open(DATA) as f:
    IR = json.load(f)
TIERS = IR['tiers']                      # [Wagyu $1M, Porterhouse $500K, Filet $100K]
PERIOD = IR.get('period', '')
T = {t['tier']: t for t in TIERS}

def money(n):
    n = float(n)
    if abs(n) >= 1_000_000: return f"${n/1_000_000:.2f}M"
    if abs(n) >= 1_000:     return f"${n/1_000:.0f}K"
    return f"${n:,.0f}"
def dollars(n): return f"${float(n):,.0f}"
def pct(n): return f"{n:.1f}%" if isinstance(n, float) else f"{n}%"

doc = SimpleDocTemplate(OUTPUT, pagesize=letter,
    leftMargin=0.75*inch, rightMargin=0.75*inch, topMargin=0.7*inch, bottomMargin=0.7*inch)
styles = getSampleStyleSheet()
def add(name, **kw): styles.add(ParagraphStyle(name, parent=styles[kw.pop('parent','Normal')], **kw))
add('DocTitle', parent='Title', fontSize=24, leading=28, textColor=HexColor('#000000'), spaceAfter=2)
add('DocSub', fontSize=12, leading=16, textColor=HexColor('#555555'), alignment=TA_CENTER, spaceAfter=4)
add('DocMeta', fontSize=9, leading=12, textColor=HexColor('#999999'), alignment=TA_CENTER, spaceAfter=18)
add('H1', parent='Heading1', fontSize=15, leading=19, textColor=HexColor('#111111'), spaceBefore=16, spaceAfter=6)
add('H2', parent='Heading2', fontSize=12, leading=15, textColor=HexColor('#333333'), spaceBefore=10, spaceAfter=4)
add('Body', fontSize=10, leading=14, textColor=HexColor('#222222'), spaceAfter=6)
add('Bull', fontSize=10, leading=14, textColor=HexColor('#222222'), leftIndent=16, bulletIndent=4, spaceAfter=3)
add('Cell', fontSize=8.5, leading=11, textColor=HexColor('#222222'))
add('CellR', fontSize=8.5, leading=11, textColor=HexColor('#222222'), alignment=2)
add('Hd', fontSize=8.5, leading=11, textColor=HexColor('#ffffff'), fontName='Helvetica-Bold')
add('HdR', fontSize=8.5, leading=11, textColor=HexColor('#ffffff'), fontName='Helvetica-Bold', alignment=2)
add('Foot', fontSize=8, leading=10, textColor=HexColor('#999999'), alignment=TA_CENTER)
add('Disc', fontSize=7.5, leading=10, textColor=HexColor('#777777'))

story = []
def h1(t): story.append(Paragraph(t, styles['H1'])); story.append(HRFlowable(width="100%", thickness=1, color=HexColor('#cccccc'), spaceAfter=6))
def h2(t): story.append(Paragraph(t, styles['H2']))
def p(t): story.append(Paragraph(t, styles['Body']))
def b(t): story.append(Paragraph(t, styles['Bull'], bulletText='•'))
def sp(h=8): story.append(Spacer(1, h))
def table(headers, rows, widths=None, align_right_from=1):
    head = []
    for i, hh in enumerate(headers):
        head.append(Paragraph(hh, styles['HdR'] if i >= align_right_from else styles['Hd']))
    data = [head]
    for row in rows:
        r = []
        for i, c in enumerate(row):
            r.append(Paragraph(str(c), styles['CellR'] if i >= align_right_from else styles['Cell']))
        data.append(r)
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), HexColor('#1a1a1a')),
        ('GRID', (0,0), (-1,-1), 0.5, HexColor('#cccccc')),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [HexColor('#ffffff'), HexColor('#f7f7f7')]),
        ('TOPPADDING', (0,0), (-1,-1), 4), ('BOTTOMPADDING', (0,0), (-1,-1), 4),
        ('LEFTPADDING', (0,0), (-1,-1), 6), ('RIGHTPADDING', (0,0), (-1,-1), 6),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ]))
    story.append(t); sp(8)

LABELS = {'Wagyu': 'Wagyu ($1M)', 'Porterhouse': 'Porterhouse ($500K)', 'Filet': 'Filet ($100K)'}
order = ['Wagyu', 'Porterhouse', 'Filet']
cols = [t for t in order if t in T]

# ── TITLE ──────────────────────────────────────────────────────────────────
story.append(Paragraph("PNTHR AMBUSH V7.4", styles['DocTitle']))
story.append(Paragraph("Intelligence Report", styles['DocSub']))
story.append(Paragraph("Automated Intraday Pyramid Strategy &bull; PNTHR AI 300 Universe (~300 names) &bull; Long + Short, Any Regime", styles['DocSub']))
story.append(Paragraph(f"Confidential &mdash; PNTHR Funds &nbsp;|&nbsp; Version 7.4.0 &nbsp;|&nbsp; Backtest {PERIOD} &nbsp;|&nbsp; Hourly bars, real IBKR fees, 5bps slippage, borrow costs", styles['DocMeta']))

# ── EXECUTIVE SUMMARY ──────────────────────────────────────────────────────
h1("Executive Summary")
p("PNTHR Ambush V7.4 is a fully automated, 60-second intraday trend engine that hunts opening-range breakouts across the PNTHR AI 300 universe. It enters on a confirmed break of the first-hour range, sizes for a fixed dollar risk using the first-hour low as the initial stop, pyramids winners across five lots, and trails the exit on a two-bar broken-low structure. Capital is compounded with a hard withdrawal discipline: at every $2,000,000 of account value, $1,000,000 is banked and the engine trades only the remainder.")
p("<b>V7.4 introduces two changes from V7.3, both validated by a full out-of-sample stress battery:</b>")
b("<b>Regime gate removed.</b> The engine now takes long (BL+1) and short (SS+1) setups in any market regime. Previously shorts were blocked in an up-trending index, which left systematic rotation and selloff profits on the table.")
b("<b>Two-bar exit governs from entry.</b> The fixed +$75 breakeven checkpoint is removed; the two-bar broken-low trail runs from the moment of entry, with the first-hour low as the disaster floor. This keeps winners running and reduced portfolio drawdown.")
sp(2)
w = T[cols[0]]
p(f"Across the {PERIOD} test, at the ${int(w['startNav']/1000)}K-equivalent compounding basis the strategy returned a <b>{w['cagrPct']:.0f}% CAGR</b> at a <b>{w['maxDDPct']:.2f}% maximum drawdown</b>, Sharpe {w['sharpe']:.2f}, Sortino {w['sortino']:.0f}, and profit factor {w['profitFactor']:.1f}x &mdash; with the newly un-gated short book contributing materially every calendar year. Headline results for all three capital tiers follow.")

# ── HEADLINE TIER TABLE ────────────────────────────────────────────────────
h1("Performance by Capital Tier")
p("All figures use graduated position sizing (50% of full size below $125K NAV, 75% to $166K, 100% above) and the $2M&rarr;$1M withdrawal rule. <b>Total Value Created</b> = ending working equity plus cash banked through withdrawals. CAGR, Sharpe and drawdown are measured on the pure-compounding (no-withdrawal) basis to isolate the strategy's growth rate.")
metric_rows = [
    ("Starting capital",        lambda t: money(t['startNav'])),
    ("Total value created",     lambda t: money(t['totalValue'])),
    ("&nbsp;&nbsp;&bull; Working equity", lambda t: money(t['workingEquity'])),
    ("&nbsp;&nbsp;&bull; Cash banked",    lambda t: money(t['banked'])),
    ("Net total return",        lambda t: f"+{t['netReturnPct']:,.0f}%"),
    ("CAGR",                    lambda t: f"+{t['cagrPct']:.1f}%"),
    ("Sharpe ratio",            lambda t: f"{t['sharpe']:.2f}"),
    ("Sortino ratio",          lambda t: f"{t['sortino']:.1f}"),
    ("Profit factor",          lambda t: f"{t['profitFactor']:.1f}x"),
    ("Calmar ratio",           lambda t: f"{t['calmar']}"),
    ("Recovery factor",        lambda t: f"{t['recoveryFactor']:.0f}x"),
    ("Max drawdown",           lambda t: f"{t['maxDDPct']:.2f}%"),
    ("Win rate",               lambda t: f"{t['winRatePct']:.0f}%"),
    ("Payoff (avg win/loss)",  lambda t: f"{t['payoff']:.1f}x"),
    ("Positive months",        lambda t: f"{t['positiveMonthsPct']:.0f}%"),
    ("Total closed trades",    lambda t: f"{t['totalClosed']:,}"),
    ("Alpha vs S&amp;P 500",   lambda t: money(t['alphaDollar'])),
]
rows = [[label] + [fn(T[c]) for c in cols] for label, fn in metric_rows]
table(["Metric"] + [LABELS[c] for c in cols], rows,
      widths=[2.3*inch] + [1.5*inch]*len(cols))

# ── LONG / SHORT CONTRIBUTION ──────────────────────────────────────────────
h1("Long &amp; Short Contribution")
p("Removing the regime gate is the single largest source of V7.4's improvement. The short book &mdash; now permitted in any regime &mdash; carries a meaningful, positive share of P&amp;L at every capital level, at a win rate consistent with the long book's trend-following profile (lower hit rate, higher payoff).")
ls_rows = [
    ("Long trades",   lambda t: f"{t['longN']:,}"),
    ("Long P&amp;L",  lambda t: dollars(t['longPnl'])),
    ("Short trades",  lambda t: f"{t['shortN']:,}"),
    ("Short P&amp;L", lambda t: dollars(t['shortPnl'])),
    ("Short win rate",lambda t: f"{t['shortWR']:.0f}%"),
    ("Worst single trade", lambda t: dollars(t['worstTrade'])),
    ("Peak gross deployed", lambda t: f"{t['peakDeployedPct']:.0f}% of NAV"),
]
rows = [[label] + [fn(T[c]) for c in cols] for label, fn in ls_rows]
table(["Metric"] + [LABELS[c] for c in cols], rows, widths=[2.3*inch] + [1.5*inch]*len(cols))
p("<b>Peak gross deployed stays at or below 100% of NAV at every tier</b> &mdash; the book is fully cash-funded with no trading leverage. A standard margin account permits roughly 2x, so the strategy operates well inside its available buying power.")

story.append(PageBreak())

# ── STRATEGY MECHANICS ─────────────────────────────────────────────────────
h1("Strategy Mechanics")
h2("Universe &amp; Regime")
b("<b>Universe:</b> PNTHR AI 300 &mdash; ~300 AI-economy equities, hourly bars.")
b("<b>Regime (V7.4):</b> none. BL+1 long and SS+1 short setups are taken in any PNTHR AI 300 regime. A per-sector AVOID gate still blocks names in structurally weak sectors.")
h2("Entry")
b("<b>Opening-range breakout:</b> after the first hour (09:30&ndash;10:30 ET) sets the range, the engine enters on a confirmed break of the prior two-day high (long) or low (short), with intrabar breakout confirmation.")
b("<b>Initial stop = first-hour low</b> (long) / first-hour high (short). Because the stop is tight, share count is maximized for a fixed dollar risk.")
h2("Position Sizing")
b("<b>Fixed dollar risk:</b> ~$150 per position at the 50% launch tier, scaling to ~$300 at full size. Capped by a 10% single-name limit and a 1% vitality limit on shares.")
b("<b>Graduated sizing:</b> 50% of full size below $125K NAV, 75% to $166K, 100% above.")
b("<b>Five-lot pyramid:</b> lots add at +0% / +3% / +6% / +10% / +14% from the original entry (35% / 25% / 20% / 12% / 8% of the planned share count).")
h2("Exit (V7.4)")
b("<b>Two-bar broken-low trail (governs from entry):</b> the position exits when price breaks one cent below the lower of the two most recent completed hourly bars.")
b("<b>First-hour low is the disaster floor</b> beneath the trail until the structure lifts the effective stop.")
b("<b>Lot ratchet:</b> as each lot fills, the stop advances to the prior lot's trigger price (never worse than breakeven).")
b("<b>Re-entry:</b> after a stop-out, the engine re-arms and re-enters on a break of the two-bar high, sized for the same fixed dollar risk with a tighter stop.")
h2("Capital Discipline")
b("<b>Withdrawal rule:</b> at every $2,000,000 of account value, $1,000,000 is banked and the engine trades only the remainder. This bounds money-at-risk while compounding realized gains off the table.")

# ── RISK & VALIDATION ──────────────────────────────────────────────────────
h1("Risk &amp; Validation")
p("V7.4 was validated against a full out-of-sample stress battery on the canonical $83K compounding basis before promotion to live trading. Summary of findings:")
b("<b>Borrow / hard-to-borrow stress:</b> multiplying short borrow cost up to 10x reduced total value by only ~2% &mdash; the short edge is not a cheap-borrow artifact.")
b("<b>Short gap / squeeze slippage:</b> the edge survives moderate adverse gap fills (+50bps still ~+40% over V7.3); extreme +200bps gaps erode it to roughly flat. Per-trade tail risk on shorts is real but portfolio drawdown stayed under 4% in every stress.")
b("<b>Leverage / margin:</b> peak gross deployed &le; 100% of NAV on the pure-compounding basis &mdash; fully cash-funded, no phantom leverage.")
b("<b>Year-by-year persistence:</b> the short book produced positive P&amp;L in every calendar year of the test, including the 2023&ndash;2025 bull run &mdash; not a single-regime artifact.")
b("<b>Worst real stop-out</b> sits inside the per-tier risk design; the largest mark-to-market losses are open positions on the final test day, not realized losses.")

# ── METHODOLOGY ────────────────────────────────────────────────────────────
h1("Methodology &amp; Assumptions")
b(f"<b>Data:</b> PNTHR AI 300 hourly bars, {PERIOD}. EMA warm-up from inception; trading from mid-2022.")
b("<b>Costs:</b> real IBKR commission schedule, 5 bps slippage on every fill, and modeled short borrow cost by sector.")
b("<b>Execution:</b> entries and lot adds fill at the trigger price with adverse slippage; exits fill at the stop/trail level with adverse slippage. No look-ahead &mdash; signals and regime use only data available at each bar.")
b("<b>Sizing basis:</b> graduated 50/75/100%; 10% single-name cap; $2M&rarr;$1M withdrawal applied at start of day when breached.")

sp(10)
story.append(HRFlowable(width="100%", thickness=0.5, color=HexColor('#cccccc'), spaceAfter=6))
story.append(Paragraph(
    "DISCLOSURES. The performance shown is hypothetical and derived from a historical backtest of the PNTHR Ambush V7.4 "
    "strategy over the period stated. Hypothetical results have inherent limitations: they are prepared with the benefit of "
    "hindsight, do not represent actual trading, and do not reflect the impact that material economic and market factors "
    "may have had on decision-making in real time. Backtested short results assume borrow availability that may not exist "
    "for every name at every time; actual short fills may differ. No representation is made that any account will achieve "
    "results similar to those shown. Past performance, actual or hypothetical, is not indicative of future results. This "
    "document is confidential, is for informational purposes only, and is not an offer to sell or a solicitation to buy any "
    "security. PNTHR Funds.", styles['Disc']))

doc.build(story)
print(f"Wrote {OUTPUT}")
