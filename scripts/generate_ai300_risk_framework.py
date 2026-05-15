#!/usr/bin/env python3
"""
PNTHR AI Elite 300 Fund, LP — Risk Management Framework v1.0
Converted from Carnivore Quant Fund Risk Management Framework v1.2.

Changes from Carnivore v1.2:
  - Fund name: "Carnivore Quant Fund, LP" -> "PNTHR AI Elite 300 Fund, LP"
  - All headers/footers/breadcrumbs updated
  - Cover subtitle: "PNTHR AI Elite 300 Fund, LP" (yellow)
  - Version: v1.2 -> v1.0
  - Date: April 2026 -> May 2026
  - Macro & Sector Gates rewritten: PAI300 regime gate replaces SPY/QQQ/MDY
    direction-index gate; AI sub-sector rotation replaces traditional sector ETF list
  - Investment universe: 679 -> ~300 AI-focused names
  - Worst-Case Validation: updated to AI 300 backtest (1,619 trades, Jan 2022-May 2026)
  - Sector concentration: AI sub-sector rotation engine language

Output: ~/Downloads/PNTHR_AI_Elite_300_Risk_Management_Framework_v1.0_2026.pdf
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
VERSION    = "v1.0"
DATE_DISP  = "May 2026"

OUT_PATH = os.path.expanduser(
    f"~/Downloads/PNTHR_AI_Elite_300_Risk_Management_Framework_{VERSION}_2026.pdf")

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
    """Build a branded table with yellow-topped header row."""
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
        title_line_1="Risk Management Framework",
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
    # Risk Management Philosophy
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Risk Management Philosophy", SECTION_TITLE))
    yellow_rule_elem = yellow_rule()
    story.append(yellow_rule_elem)
    story.append(spacer(4))

    story.append(P(
        f"The {FUND} is engineered for capital preservation first, alpha generation second. "
        "Every aspect of the system, from signal selection to position sizing to exit discipline, "
        "ensures the portfolio can absorb adverse conditions without meaningful drawdown. The Fund "
        "employs a multi-layered risk architecture spanning position sizing, portfolio-level "
        "controls, and automated alert systems, all enforced systematically with zero "
        "discretionary override."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Position Sizing: 1% Vitality Cap
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Position Sizing: 1% Vitality Cap", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "The Fund sizes full positions between 0.5% and 2.0% of NAV, with 1.0% of NAV as the "
        "standard allocation for individual equities and 0.5% of NAV for ETFs. Because the "
        "initial entry (Lot 1) deploys only 35% of the full position, the actual capital at risk "
        "on any new trade is just 0.35% of NAV, ensuring minimal impact from any single entry. "
        "Share count is calculated as floor(risk budget / risk per share). A wider stop produces "
        "fewer shares, never more risk."
    ))

    story.append(spacer(6))
    story.append(make_table(
        ["Asset Type", "Max Position Size", "Initial Entry (Lot 1)", "Rationale"],
        [
            ["Individual Equities (Vitality)",
             "0.5%-2.0% of NAV (1.0% standard)",
             "0.35% of NAV (at 1.0%)",
             "Core risk unit; full size earned through pyramid confirmation"],
            ["ETFs",
             "0.5% of NAV",
             "0.175% of NAV",
             "Reduced allocation reflects lower alpha potential"],
        ],
        col_widths=[1.6 * inch, 1.5 * inch, 1.4 * inch, 2.0 * inch],
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # 5-Lot Pyramid System
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("5-Lot Pyramid System", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Initial entry deploys only 35% of the full position. Subsequent lots at +3%, +6%, +10%, "
        "+14% are earned through sequential confirmation, each lot requiring the prior lot to be "
        "filled, a time gate to be cleared, and a price trigger to be reached. Maximum capital "
        "is only deployed when the market has confirmed the trade multiple times."
    ))

    story.append(spacer(6))
    story.append(make_table(
        ["Lot", "Name", "Alloc", "Trigger", "Gate", "Purpose"],
        [
            ["Lot 1", "The Scent",   "35%", "Signal entry",                "None",           "Initial position; market must confirm"],
            ["Lot 2", "The Stalk",   "25%", "Price confirmation + time",   "5 trading days",  "Largest add; time + price both required"],
            ["Lot 3", "The Strike",  "20%", "Price confirmation",          "Lot 2 filled",    "Momentum continuation confirmed"],
            ["Lot 4", "The Jugular", "12%", "Price confirmation",          "Lot 3 filled",    "Trend extension"],
            ["Lot 5", "The Kill",    "8%",  "Price confirmation",          "Lot 4 filled",    "Maximum conviction; full position"],
        ],
        col_widths=[0.55 * inch, 0.85 * inch, 0.55 * inch, 1.5 * inch, 1.05 * inch, 2.0 * inch],
    ))
    story.append(Paragraph(
        "Specific price thresholds at which Lots 2 through 5 trigger are proprietary and are not disclosed.",
        SMALL_NOTE))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # 10% Max Portfolio Risk Exposure
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("10% Max Portfolio Risk Exposure", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "At no point does the Fund risk more than 10% of total portfolio NAV across all open "
        "positions combined. This portfolio-level risk ceiling ensures that even in a worst-case "
        "scenario where every open position hits its stop simultaneously, the maximum drawdown "
        "is capped at 10%. Recycled positions (stop beyond entry) carry $0 risk and do not "
        "count toward this limit."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Portfolio Heat Caps
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Portfolio Heat Caps", SUBSECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        'Open risk ("heat") is further segmented by direction to prevent overweighting either '
        "side of the book:"
    ))

    story.append(spacer(6))
    story.append(make_table(
        ["Control", "Cap", "Description"],
        [
            ["Long Heat",  "10% of NAV", "Total open risk across all long positions"],
            ["Short Heat", "5% of NAV",  "Total open risk across all short positions"],
            ["Combined",   "15% of NAV", "Theoretical max if both sides fully deployed"],
        ],
        col_widths=[1.5 * inch, 1.2 * inch, 3.8 * inch],
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Sector Concentration: Advisory Framework
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Sector Concentration: Advisory Framework", SUBSECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "The Fund does not enforce a fixed sector concentration cap. The Strategy may concentrate "
        "in a single sector when trend and macro conditions favor it. Prior backtesting "
        "demonstrated that eliminating a hard position cap produced superior risk-adjusted "
        "returns. Primary capital protection is provided by: the 1% vitality cap per position, "
        "portfolio heat caps (10% long / 5% short / 15% total), the PNTHR Proprietary Stop Loss "
        "System (PPSLS), the 20-day stale-position exit, and the FEAST momentum-exhaustion alert."
    ))

    story.append(P(
        "The Risk Advisor emits an advisory warning at elevated net directional exposure "
        "(3 or more positions same direction in a sector). The warning is informational only and "
        "does not block trade entry. Two optional rebalancing paths are suggested:"
    ))

    story.append(Paragraph(
        "•  Option A: Close the weakest position (by Kill score) in the concentrated sector",
        BULLET))
    story.append(Paragraph(
        "•  Option B: Add an opposite-direction position using top Kill candidates to balance exposure",
        BULLET))
    story.append(P(
        "ETFs are exempt from the concentration calculation (they are diversification instruments)."
    ))

    story.append(PageBreak())

    # ══════════════════════════════════════════════════════════════════════════
    # Stop Loss System: PNTHR Proprietary Stop Loss System (PPSLS)
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph(
        "Stop Loss System: PNTHR Proprietary Stop Loss System (PPSLS)", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "All positions are protected by the PPSLS, a proprietary stop loss calculation that "
        "determines the most conservative of two variables and applies that price as the PNTHR "
        "Stop on all trades. The system allows price movement while remaining ready for "
        "counter-trend adverse directional risk. Stops never move against the trade:"
    ))

    story.append(Paragraph(
        "•  BL positions: Stop ratchets UP only (never moves down)", BULLET))
    story.append(Paragraph(
        "•  SS positions: Stop ratchets DOWN only (never moves up)", BULLET))

    story.append(spacer(8))
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

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Systematic Exit Discipline
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Systematic Exit Discipline", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Every exit is categorized and scored for discipline. Manual overrides are tracked and "
        "penalized. The system rewards systematic behavior:"
    ))

    story.append(spacer(6))
    story.append(make_table(
        ["Exit Type", "Trigger", "Discipline Score"],
        [
            ["PNTHR Signal",       "Proprietary PNTHR Exit Signal is generated",                     "12/12 (Perfect)"],
            ["FEAST",              "RSI &gt; 85 momentum exhaustion, sell 50% immediately",          "12/12 (Perfect)"],
            ["PNTHR PPSLS Stop Hit", "Ratchet stop hit",                                             "10/12"],
            ["RISK_ADVISOR",       "Sector/portfolio concentration breach",                          "10/12"],
            ["STALE_HUNT",         "20-day position without development, mandatory closure",         "10/12"],
            ["MANUAL",             "Discretionary exit",                                             "4/12 (profit) or 0/12 (loss)"],
        ],
        col_widths=[1.4 * inch, 3.1 * inch, 2.0 * inch],
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Automated Alert Systems
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Automated Alert Systems", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(Paragraph("FEAST Alert (Momentum Exhaustion)", SUB2_TITLE))
    story.append(P(
        "When weekly RSI exceeds 85 on any long position, the system triggers a FEAST Alert, "
        "a high-urgency notification to sell 50% of the position immediately. RSI &gt; 85 "
        "historically signals extreme momentum exhaustion with high reversal probability."
    ))

    story.append(spacer(6))
    story.append(Paragraph("Stale Hunt Timer", SUB2_TITLE))
    story.append(P(
        "Positions that fail to develop are automatically flagged based on trading days since entry:"
    ))

    story.append(spacer(4))
    story.append(make_table(
        ["Trading Days", "Status", "Action"],
        [
            ["15-17 days", "STALE (Yellow)",    "Review position thesis"],
            ["18-19 days", "STALE (Orange)",    "Prepare for liquidation"],
            ["20+ days",   "LIQUIDATE (Red)",   "Mandatory position closure"],
        ],
        col_widths=[1.5 * inch, 2.0 * inch, 3.0 * inch],
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Wash Sale Compliance
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Wash Sale Compliance", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "30-day re-entry lockout on losing trades, automatically enforced by the pipeline. Any "
        "attempt to re-enter a position within 30 calendar days of closing at a loss is blocked "
        "at the pre-trade scoring level (Analyze Score penalizes wash sale violations with "
        "0/5 points)."
    ))

    story.append(PageBreak())

    # ══════════════════════════════════════════════════════════════════════════
    # Pre-Trade Risk Assessment (Analyze Score)
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Pre-Trade Risk Assessment (Analyze Score)", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Every potential trade is scored through the Analyze system, a 100-point pre-trade "
        "assessment where every point is evaluable at scan time. No estimation, no guesswork:"
    ))

    story.append(spacer(6))
    story.append(make_table(
        ["Tier", "Weight", "Components"],
        [
            ["T1: Setup Quality",    "40 points",
             "Signal Quality (15), Kill Context (10), Index Trend (8), Sector Trend (7)"],
            ["T2: Risk Profile",     "35 points",
             "Freshness (12), Risk/Reward (8), Prey Presence (8), Conviction (7)"],
            ["T3: Entry Conditions", "25 points",
             "Slope Strength (5), Sector Concentration (5), Wash Compliance (5), "
             "Volatility/RSI (5), Portfolio Fit (5)"],
        ],
        col_widths=[1.5 * inch, 1.0 * inch, 4.0 * inch],
    ))

    story.append(Paragraph(
        'Score <font color="green">&gt;=75%</font> = green (optimal). '
        '<font color="#cccc00">&gt;=55%</font> = yellow (proceed with awareness). '
        '<font color="red">&lt;55%</font> = red (reconsider). '
        "SIZE IT is blocked when Analyze detects errors in underlying data.",
        SCORE_NOTE))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Macro & Sector Gates (AI 300 architecture)
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Macro &amp; Sector Gates", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "The orders pipeline applies sequential gates before any position can be opened. A "
        "candidate must pass all gates or the trade is rejected for that week."
    ))

    story.append(Paragraph(
        "•  <b>PAI300 Regime Gate:</b> The proprietary PNTHR AI 300 Index (PAI300), "
        "a capped market-cap-weighted index of approximately 300 AI-focused equities "
        "(base 2022-11-30 = 1000, monthly rebalanced), serves as the macro regime filter. "
        "The PAI300's close must be above its 21-week EMA for BL entries; below for SS entries. "
        "This purpose-built AI regime filter ensures the Fund trades in alignment with the "
        "broader AI sector trend.",
        BULLET))

    story.append(Paragraph(
        "•  <b>AI Sub-Sector Rotation Engine:</b> Rather than a single sector ETF gate, "
        "the AI Elite 300 Fund employs a proprietary AI sub-sector rotation engine that "
        "evaluates each AI sub-sector (semiconductors, cloud/SaaS, cybersecurity, robotics, "
        "autonomous vehicles, quantum computing, etc.) against its sector-specific optimized "
        "EMA period. BL candidates pass if their AI sub-sector is above its filter; SS candidates "
        "pass if below. Specific EMA periods are empirically optimized per sector and are "
        "proprietary.",
        BULLET))

    story.append(Paragraph(
        "•  <b>D2 Gate:</b> The stock's multi-dimensional Kill score D2 component "
        "(sector directional return) must be non-negative.",
        BULLET))

    story.append(Paragraph(
        "•  <b>SS Crash Gate:</b> Short candidates only. Requires dual confirmation of "
        "sustained bearish regime momentum and pronounced recent sector weakness. Specific "
        "thresholds are proprietary. Gate intentionally restrictive to limit short exposure "
        "to market-stress regimes.",
        BULLET))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Worst-Case Validation
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Worst-Case Validation", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Across all 1,619 closed pyramid trades in the AI 300 backtest (January 2022 through "
        "May 2026, Wagyu tier), the worst-case gross maximum drawdown was -20.49% "
        "(mark-to-market, daily NAV). At Lot 1 NAV-scaled sizing (35% of 1% vitality), the "
        "actual capital deployed on any initial entry is just 0.35% of NAV, ensuring that no "
        "single adverse trade can materially impair investor capital."
    ))

    story.append(P(
        "Even during the months when worst-case drawdowns occurred, the portfolio remained "
        "profitable on a net basis. The 1% vitality cap and 35% initial lot sizing ensure that "
        "no single adverse trade can materially impair investor capital. No historical backtest "
        "period resulted in permanent capital loss on a full-position basis."
    ))

    # ── Build PDF ─────────────────────────────────────────────────────────────
    doc = make_doc_template(
        OUT_PATH,
        title_meta=f"{FUND} - Risk Management Framework {VERSION}",
        subject="Risk Management Framework",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Risk Management Framework",
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
