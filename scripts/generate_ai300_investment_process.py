#!/usr/bin/env python3
"""
PNTHR AI Elite 300 Fund, LP — Investment Process Overview v2.0
Updated for Multi-strategy + MCE (Momentum Continuation Entry).

Output: ~/Downloads/PNTHR_AI_Elite_300_Investment_Process_Overview_v2.0_2026.pdf
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (
    Paragraph, Spacer, PageBreak, Table, TableStyle,
)
from reportlab.lib import colors

from pnthr_design import (
    PALETTE_YELLOW, PALETTE_BLACK, PALETTE_WHITE, PALETTE_DIM_GRAY,
    PALETTE_PURE_BLACK, PALETTE_TABLE_GRAY,
    H1, H2, BODY, BODY_LEFT,
    make_doc_template, make_page_handlers, build_cover_header,
)

FUND       = "PNTHR AI Elite 300 Fund, LP"
FUND_UPPER = "PNTHR AI ELITE 300 FUND"
VERSION    = "v2.0"
DATE_DISP  = "May 2026"

OUT_PATH = os.path.expanduser(
    f"~/Downloads/PNTHR_AI_Elite_300_Investment_Process_Overview_{VERSION}_2026.pdf")

# ── Local styles ──────────────────────────────────────────────────────────────
SECTION_TITLE = ParagraphStyle(
    name="section_title", fontName="Helvetica-Bold", fontSize=18, leading=22,
    alignment=TA_LEFT, spaceBefore=16, spaceAfter=6,
)
SUBSECTION_TITLE = ParagraphStyle(
    name="subsection_title", fontName="Helvetica-Bold", fontSize=14, leading=18,
    alignment=TA_LEFT, spaceBefore=14, spaceAfter=6,
)
SUB2_TITLE = ParagraphStyle(
    name="sub2_title", fontName="Helvetica-Bold", fontSize=12, leading=15,
    alignment=TA_LEFT, spaceBefore=10, spaceAfter=4,
)
TH = ParagraphStyle(
    name="th", fontName="Helvetica-Bold", fontSize=10, leading=13,
    alignment=TA_LEFT, textColor=PALETTE_WHITE,
)
TD = ParagraphStyle(
    name="td", fontName="Helvetica", fontSize=10, leading=13,
    alignment=TA_LEFT,
)
BULLET = ParagraphStyle(
    name="bullet", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=2, spaceAfter=2,
    leftIndent=18, firstLineIndent=-14,
)
SMALL_NOTE = ParagraphStyle(
    name="small_note", fontName="Helvetica-Oblique", fontSize=9, leading=11,
    alignment=TA_LEFT, spaceBefore=4, spaceAfter=8,
    textColor=PALETTE_DIM_GRAY,
)
SCORE_NOTE = ParagraphStyle(
    name="score_note", fontName="Helvetica", fontSize=10, leading=13,
    alignment=TA_LEFT, spaceBefore=6, spaceAfter=10,
)


def P(text, style=BODY):
    return Paragraph(text, style)


def spacer(h=8):
    return Spacer(1, h)


def yellow_rule():
    return Paragraph(
        '<font color="#fcf000">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</font>',
        ParagraphStyle(name="rule", fontSize=6, leading=8, alignment=TA_LEFT,
                       spaceBefore=4, spaceAfter=4))


def make_table(header_cols, rows, col_widths=None):
    if col_widths is None:
        n = len(header_cols)
        col_widths = [6.5 * inch / n] * n

    hdr_row = [Paragraph(c, TH) for c in header_cols]
    data = [hdr_row]
    for row in rows:
        data.append([Paragraph(cell, TD) for cell in row])

    tbl = Table(data, colWidths=col_widths)
    tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, 0),  PALETTE_PURE_BLACK),
        ("TEXTCOLOR",     (0, 0), (-1, 0),  PALETTE_WHITE),
        ("LINEABOVE",     (0, 0), (-1, 0),  2, PALETTE_YELLOW),
        ("BOX",           (0, 0), (-1, -1), 0.5, colors.Color(0.7, 0.7, 0.7)),
        ("INNERGRID",     (0, 1), (-1, -1), 0.3, colors.Color(0.85, 0.85, 0.85)),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
        ("TOPPADDING",    (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return tbl


def build():
    # ── Cover ─────────────────────────────────────────────────────────────────
    story = build_cover_header(
        title_line_1="Investment Process Overview",
        title_line_2=None,
        subtitle=FUND,
        date_line=f"{VERSION} - {DATE_DISP}",
        revision_line=None,
        issuer_line="STT Capital Advisors, LLC",
        confidential_title="CONFIDENTIAL: FOR ACCREDITED INVESTOR / QUALIFIED CLIENT USE ONLY",
        confidential_body=(
            "This document is the property of STT Capital Advisors, LLC "
            "and may not be reproduced or distributed without prior written consent."
        ),
    )

    # ══════════════════════════════════════════════════════════════════════════
    # Strategy Overview
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Strategy Overview", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        f"{FUND} employs a proprietary Multi-strategy + MCE (Momentum Continuation Entry) "
        "systematic long/short equity strategy built on the PNTHR Signal System. The Fund "
        "identifies high-conviction entry points through two complementary engines: <b>weekly "
        "BL/SS signals</b> ranked by a multi-dimensional scoring framework, and <b>daily MCE "
        "entries</b> that capture momentum continuation on active weekly positions. Positions "
        "are entered through a disciplined five-lot pyramid structure and managed via the PNTHR "
        "Proprietary Stop Loss System (PPSLS) and portfolio-level controls. The strategy is "
        "designed to generate alpha through both long (BL) and short (SS) signals, with a "
        "structural long bias reflecting the long-term upward drift of U.S. equity markets."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # The PNTHR AI 300 Universe
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("The PNTHR AI 300 Universe", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Every week the system scans approximately 300 AI-focused U.S. equities spanning "
        "AI infrastructure, semiconductors, cloud/SaaS, cybersecurity, robotics, autonomous "
        "vehicles, quantum computing, and related sectors. The universe was curated for direct "
        "exposure to the artificial intelligence megatrend, with constituents selected for "
        "liquidity, AI revenue relevance, and representation across the full AI value chain. "
        "ETFs (sector SPDRs and major index funds) are included for macro and sector exposure."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # PNTHR Proprietary Buy Long Signal (BL)
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("PNTHR Proprietary Buy Long Signal (BL)", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "A BL signal is generated when the following conditions are simultaneously true. "
        "Specific thresholds, lookback periods, and parameter values are proprietary and "
        "not disclosed:"
    ))

    story.append(Paragraph(
        "•  Weekly close above the stock's sector-specific optimized exponential moving "
        "average (EMA)", BULLET))
    story.append(Paragraph(
        "•  Sector EMA slope is positive, confirming the underlying trend is genuine", BULLET))
    story.append(Paragraph(
        "•  Structural breakout confirmation on the weekly bar", BULLET))
    story.append(Paragraph(
        '•  Sufficient separation ("daylight") between weekly bar and EMA to filter '
        "false breakouts", BULLET))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # PNTHR Proprietary Sell Short Signal (SS)
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("PNTHR Proprietary Sell Short Signal (SS)", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "An SS signal is generated when the following conditions are simultaneously true:"
    ))

    story.append(Paragraph(
        "•  Weekly close below the stock's sector-specific optimized EMA", BULLET))
    story.append(Paragraph(
        "•  Sector EMA slope is negative, confirming the underlying downtrend is genuine",
        BULLET))
    story.append(Paragraph(
        "•  Structural breakdown confirmation on the weekly bar", BULLET))
    story.append(Paragraph(
        "•  Sufficient separation between weekly bar and EMA to filter false breakdowns",
        BULLET))

    story.append(spacer(6))
    story.append(P(
        "Additionally, SS signals require the PNTHR SS Crash Gate to be satisfied: the "
        "PAI300 regime index must show confirmed downward slope persistence AND the stock's "
        "AI sub-sector must show pronounced short-term weakness. This gate is deliberately "
        "restrictive to limit short exposure to market-stress regimes. Exact slope and "
        "sector-weakness thresholds are proprietary."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # PNTHR Momentum Continuation Entry (MCE)
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("PNTHR Momentum Continuation Entry (MCE)", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Between weekly Friday signals, the Fund runs a daily MCE scan to capture momentum "
        "continuation opportunities on stocks already in confirmed uptrends. MCE adds a "
        "second entry dimension that the backtest proved increases net CAGR by +10-12% without "
        "meaningfully increasing drawdowns."
    ))

    story.append(spacer(4))
    story.append(P(
        "An MCE entry is generated when the following conditions are simultaneously true:"
    ))

    story.append(Paragraph(
        "•  The stock has an <b>active weekly BL signal</b> (entered and not yet exited)", BULLET))
    story.append(Paragraph(
        "•  The stock ranks in the <b>TTM top 100</b> of the AI 300 universe by trailing "
        "twelve-month momentum", BULLET))
    story.append(Paragraph(
        "•  The stock's daily price breaks above the <b>highest high of the prior 2 completed "
        "daily bars</b> by at least $0.01 (daily breakout confirmation)", BULLET))

    story.append(spacer(4))
    story.append(P(
        "MCE entries use the <b>weekly PNTHR Stop</b> as the protective stop, maintaining "
        "consistency with the primary strategy's risk management. MCE positions flow through "
        "the same 5-lot pyramid structure and are subject to all portfolio-level risk gates "
        "(10% heat cap, 10% per-ticker concentration cap, 20% buying power reserve). MCE "
        "entries execute same-day at market price, typically at the 10:30 AM ET daily scan."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Orders Pipeline Gates
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Orders Pipeline Gates", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Before any BL or SS candidate becomes a trade, it must pass sequential gates. The "
        "orders pipeline applies these gates in order and rejects any candidate failing any gate."
    ))

    story.append(Paragraph(
        "•  <b>PAI300 Regime Gate:</b> The proprietary PNTHR AI 300 Index (PAI300), a "
        "capped market-cap-weighted index of approximately 300 AI-focused equities "
        "(base 2022-11-30 = 1000, monthly rebalanced), serves as the macro regime filter. "
        "The PAI300's weekly close must be above its 21-week EMA for BL entries; below for "
        "SS entries.", BULLET))

    story.append(Paragraph(
        "•  <b>AI Sub-Sector Rotation Gate:</b> The stock's AI sub-sector is evaluated "
        "against its sector-specific optimized EMA period. BL candidates pass if their "
        "sub-sector ETF is positioned correctly above its filter; SS candidates pass if below. "
        "Specific periods are empirically optimized per sector and are proprietary.", BULLET))

    story.append(Paragraph(
        "•  <b>Sector Return Gate (D2):</b> The stock's sector directional return component "
        "of the Kill score must be non-negative.", BULLET))

    story.append(Paragraph(
        "•  <b>SS Crash Gate:</b> (SS candidates only) The restrictive short-entry gate "
        "described above.", BULLET))

    story.append(spacer(4))
    story.append(P(
        "Candidates surviving the gates are ranked by Kill score. The top 10 BL and top 5 SS "
        "candidates by score are selected each week."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # The PNTHR Kill Scoring Engine
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("The PNTHR Kill Scoring Engine", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "The PNTHR Kill Scoring Engine is the intellectual core of the strategy: approximately "
        "four years of historical research and out-of-sample validation distilled into a "
        "multi-dimensional scoring framework that transforms the PNTHR AI 300 universe into a "
        "precision-ranked list each week. The system does not guess; it measures, confirms, "
        "and ranks systematically."
    ))

    story.append(spacer(4))
    story.append(P(
        "The Kill score integrates the following categories of measurement (exact weights, "
        "formulas, and parameter values are proprietary):"
    ))

    story.append(Paragraph(
        "•  Market regime: PAI300 index-level direction and slope, with bear-regime "
        "amplification of short signals and bull-regime amplification of long signals", BULLET))
    story.append(Paragraph(
        "•  Sector alignment: short-term and medium-term directional returns of the stock's "
        "AI sub-sector", BULLET))
    story.append(Paragraph(
        "•  Entry quality: technical characteristics of the signal-week weekly bar (close "
        "conviction, slope, separation)", BULLET))
    story.append(Paragraph(
        "•  Signal freshness: how recently the signal was generated, with decay for aging "
        "signals", BULLET))
    story.append(Paragraph(
        "•  Rank dynamics: week-over-week ranking improvement and rate of acceleration",
        BULLET))
    story.append(Paragraph(
        "•  Momentum confirmation: multi-oscillator technical momentum (RSI, OBV, ADX, volume)",
        BULLET))
    story.append(Paragraph(
        "•  Multi-strategy convergence: independent confirmation from the PNTHR Prey strategy "
        "overlay", BULLET))

    story.append(spacer(4))
    story.append(P(
        "The Kill score produces tiered categorization (ALPHA PNTHR KILL, STRIKING, HUNTING, "
        "POUNCING, COILING, STALKING, TRACKING, PROWLING, STIRRING, DORMANT, OVEREXTENDED) "
        "used by the Analyze pre-trade scoring system and the orders pipeline. Tier thresholds "
        "and scoring ranges are proprietary."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # PNTHR Analyze Pre-Trade Scoring
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("PNTHR Analyze Pre-Trade Scoring", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "The PNTHR Analyze system answers the question every trader must answer before "
        "entering: is this the right trade, right now? Every one of Analyze's 100 points can "
        "be evaluated at the exact moment the scan runs. No estimation, no guesswork."
    ))

    story.append(spacer(6))
    story.append(make_table(
        ["Tier", "Points", "Components"],
        [
            ["T1: Setup Quality",    "40",
             "Signal Quality (15), Kill Context (10), Index Trend (8), Sector Trend (7)"],
            ["T2: Risk Profile",     "35",
             "Freshness (12), Risk/Reward (8), Prey Presence (8), Conviction (7)"],
            ["T3: Entry Conditions", "25",
             "Slope Strength (5), Sector Concentration (5), Wash Compliance (5), "
             "Volatility/RSI (5), Portfolio Fit (5)"],
        ],
        col_widths=[1.5 * inch, 0.8 * inch, 4.2 * inch],
    ))

    story.append(Paragraph(
        'Score <font color="green">&gt;=75%</font> = green (optimal). '
        '<font color="#cccc00">&gt;=55%</font> = yellow (proceed with awareness). '
        '<font color="red">&lt;55%</font> = red (reconsider). '
        "The Analyze score is preserved as the authoritative snapshot for all downstream "
        "journal and discipline scoring.",
        SCORE_NOTE))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # PNTHR Position Sizing and Pyramiding
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("PNTHR Position Sizing and Pyramiding", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Position sizing is where discipline becomes quantifiable. The PNTHR pyramid model "
        "ensures maximum capital is only deployed when the market has confirmed the trade "
        "multiple times. A new entry receives only 35% of the intended position. Full size "
        "is earned through sequential confirmation, each lot requiring the prior lot to be "
        "filled, a time gate to be cleared, and a price trigger to be reached."
    ))

    story.append(spacer(6))
    story.append(make_table(
        ["Lot", "Name", "Alloc", "Trigger", "Gate", "Purpose"],
        [
            ["Lot 1", "The Scent",   "35%", "Signal entry",              "None",          "Initial position; market must confirm"],
            ["Lot 2", "The Stalk",   "25%", "Price confirmation + time", "5 trading days", "Largest add; time + price both required"],
            ["Lot 3", "The Strike",  "20%", "Price confirmation",        "Lot 2 filled",  "Momentum continuation confirmed"],
            ["Lot 4", "The Jugular", "12%", "Price confirmation",        "Lot 3 filled",  "Trend extension"],
            ["Lot 5", "The Kill",    "8%",  "Price confirmation",        "Lot 4 filled",  "Maximum conviction; full position"],
        ],
        col_widths=[0.55 * inch, 0.85 * inch, 0.55 * inch, 1.5 * inch, 1.05 * inch, 2.0 * inch],
    ))
    story.append(Paragraph(
        "Specific price thresholds at which Lots 2 through 5 trigger are proprietary and "
        "are not disclosed.",
        SMALL_NOTE))

    story.append(spacer(8))

    # Stop Ratchet
    story.append(Paragraph("Stop Ratchet on Each Lot Fill", SUB2_TITLE))
    story.append(spacer(4))
    story.append(make_table(
        ["Lot Fill Event", "Stop Moves To", "Effect"],
        [
            ["Lot 2 fills", "Initial stop (unchanged)",  "Time + price confirmed, position monitored"],
            ["Lot 3 fills", "Average cost (breakeven)",  "Capital protected; initial investment covered"],
            ["Lot 4 fills", "Lot 2 fill price",          "Lot 2 gain locked in as minimum exit"],
            ["Lot 5 fills", "Lot 3 fill price",          "Full pyramid; aggressive ratcheted stop"],
        ],
        col_widths=[1.3 * inch, 2.3 * inch, 2.9 * inch],
    ))

    story.append(spacer(4))
    story.append(P(
        "Stops never move backwards. The ratchet is a one-way lock. SS positions: ratchets "
        "down only."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # PNTHR Entry Workflow
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("PNTHR Entry Workflow", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(make_table(
        ["Step", "Action", "What Happens"],
        [
            ["1", "SIZE IT",
             "Analyze scoring (100 pts). Blocked when errors detected. "
             "Green &gt;=75%. Yellow 55-74%. Red &lt;55%"],
            ["2", "QUEUE IT",
             "Order queued: ticker, direction, lot size, target price, Analyze score. "
             "Per-user, persists across sessions"],
            ["3", "SEND TO COMMAND",
             "4-source cascade: Analyze snapshot (authoritative) to queue entry to "
             "MongoDB pipeline to signal cache updated"],
        ],
        col_widths=[0.5 * inch, 1.3 * inch, 4.7 * inch],
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Systematic Exit Discipline
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Systematic Exit Discipline", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Every exit is categorized and scored for discipline. Manual overrides are tracked "
        "and penalized. The system rewards systematic behavior:"
    ))

    story.append(spacer(6))
    story.append(make_table(
        ["Exit Type", "Trigger", "Discipline Score"],
        [
            ["PNTHR Signal",         "Proprietary PNTHR Exit Signal is generated",
             "12/12 (Perfect)"],
            ["FEAST",                "RSI &gt; 85 momentum exhaustion, sell 50% immediately",
             "12/12 (Perfect)"],
            ["PNTHR PPSLS Stop Hit", "Ratchet stop hit",
             "10/12"],
            ["RISK_ADVISOR",         "Proactive exit on elevated sector or portfolio exposure advisory",
             "10/12"],
            ["STALE_HUNT",           "20-day position without development, mandatory closure",
             "10/12"],
            ["MANUAL",               "Discretionary exit",
             "4/12 (profit) or 0/12 (loss)"],
        ],
        col_widths=[1.4 * inch, 3.1 * inch, 2.0 * inch],
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Friday Pipeline
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Signal Generation Pipeline", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "<b>Weekly Friday Pipeline (4:15 PM ET):</b> Every Friday after the close, the system "
        "refreshes all Kill scores, updates the signal state machine, recalculates stops, and "
        "persists results to the database. This produces the weekly BL/SS signal list and "
        "ensures all scoring data is current for the following week's trading decisions."
    ))

    story.append(spacer(6))

    story.append(P(
        "<b>Daily MCE Scan (10:30 AM ET, Mon–Fri):</b> Each trading morning, the system "
        "scans the TTM top-100 AI 300 names for Momentum Continuation Entry triggers. "
        "Stocks with an active weekly BL signal whose current price exceeds the 2-bar daily "
        "high breakout level are flagged for same-day entry. MCE signals are staged and "
        "executed through the same STAGE → EXECUTE → BRIDGE pipeline as weekly signals, "
        "with identical risk gates (10% heat cap, 10% per-ticker cap, 20-position cap)."
    ))

    # ── Build PDF ─────────────────────────────────────────────────────────────
    doc = make_doc_template(
        OUT_PATH,
        title_meta=f"{FUND} - Investment Process Overview {VERSION}",
        subject="Investment Process Overview",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Investment Process Overview",
        doc_date_display=DATE_DISP,
        fund_name="PNTHR AI Elite 300 Fund",
        fund_name_upper=FUND_UPPER,
    )
    doc.build(story, onFirstPage=on_cover, onLaterPages=on_page)
    sz = os.path.getsize(OUT_PATH)
    print(f"PDF generated: {OUT_PATH}")
    print(f"Size: {sz:,} bytes")


if __name__ == "__main__":
    build()
