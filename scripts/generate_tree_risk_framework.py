#!/usr/bin/env python3
"""
PNTHR Tree Fund, LP — Risk Management Framework v1.0
Forked from the AI Elite 300 Risk Management Framework (2026-06-19). Same fund
structure / fees / service providers. Risk controls REWRITTEN to the PNTHR Tree
strategy: 2% NAV per-position risk, 10% single-name cap, ADV participation cap,
FULL-SIZE entry (no pyramid), a single 2-week-low trailing stop with breakeven
snap, and a 2.0x gross-exposure cap. NO regime gate, NO sector rotation, NO
multi-factor scoring, NO time-based / stale-position or momentum-exhaustion exit.
Worst-Case Validation states the honest ~50.7% gross max drawdown (high-vol momentum).

Output: ~/Downloads/PNTHR_Tree_Fund_Risk_Management_Framework_v1.0_2026.pdf
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

FUND       = "PNTHR Tree Fund, LP"
FUND_UPPER = "PNTHR TREE FUND"
VERSION    = "v1.0"
DATE_DISP  = "May 2026"

OUT_PATH = os.path.expanduser(
    f"~/Downloads/PNTHR_Tree_Fund_Risk_Management_Framework_{VERSION}_2026.pdf")

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
        f"The {FUND} is a directional, long-only, high-conviction momentum strategy. It is "
        "high-beta and highly correlated to the equity market, and it will experience high "
        "volatility and large portfolio drawdowns (see the Worst-Case Validation section "
        "below). Its risk controls are designed to bound loss at the level of each individual "
        "trade, not to cap overall portfolio drawdown. Every aspect of the system, from breakout "
        "selection to position sizing to exit discipline, is enforced systematically with zero "
        "discretionary override, spanning position sizing, portfolio-level exposure limits, and "
        "automated alert systems."
    ))

    story.append(spacer(10))

    # ==========================================================================
    # Position Sizing
    # ==========================================================================
    story.append(Paragraph("Position Sizing", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "The Fund sizes each position by reference to the distance between the entry price and the "
        "initial protective stop (risk per share). Each position is sized to the smaller of "
        "(i) a share count whose risk-per-share times shares does not exceed 2.0% of NAV, and "
        "(ii) a share count whose entry value does not exceed 10% of NAV. Each entry is further "
        "capped at a fraction of the name's 20-day average daily trading volume (ADV) to preserve "
        "executability as Fund assets grow. Share count is floor(risk budget / risk per share): a "
        "wider stop produces fewer shares, never more risk. The full position is established at entry."
    ))
    story.append(spacer(6))
    story.append(make_table(
        ["Control", "Limit", "Rationale"],
        [
            ["Per-position risk", "2.0% of NAV (to the initial stop)", "Core risk unit; caps loss on any single name"],
            ["Per-name value cap", "10% of NAV at entry", "Single-name concentration limit"],
            ["ADV participation", "Fraction of 20-day ADV", "Executability / capacity at scale"],
        ],
        col_widths=[1.6 * inch, 2.2 * inch, 2.7 * inch],
    ))
    story.append(spacer(10))

    # ==========================================================================
    # Full-Size Entry (No Pyramiding)
    # ==========================================================================
    story.append(Paragraph("Full-Size Entry (No Pyramiding)", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "The Strategy establishes each position at its full intended size at the moment of the "
        "new-high breakout. It does not scale in, pyramid, or average down. Entry is a resting "
        "buy-stop at the breakout level, filled at that level or at the opening price on a "
        "gap-through. This single-entry design keeps execution simple and the risk on each trade "
        "fixed and known at entry."
    ))
    story.append(spacer(10))

    # ==========================================================================
    # Portfolio Leverage Limit (2.0x Gross Cap)
    # ==========================================================================
    story.append(Paragraph("Portfolio Leverage Limit (2.0x Gross Cap)", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "Aggregate gross exposure is subject to a hard cap of two times (2.0x) NAV. When the "
        "per-position sizing rules would push aggregate gross exposure above this limit, "
        "additional entries are suspended until exposure returns within the cap. This is the "
        "Fund's primary portfolio-level risk governor: without it, the per-name 2% / 10% sizing "
        "can compound into excessive total exposure during broad advances when many breakout "
        "signals occur at once. The current implementation is long-only, and the 2.0x gross cap "
        "governs total market exposure."
    ))
    story.append(spacer(10))

    # ==========================================================================
    # No Regime Gate, Sector Rotation, or Scoring
    # ==========================================================================
    story.append(Paragraph("No Regime Gate, Sector Rotation, or Scoring", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "Entries are driven solely by single-name breakouts to new multi-month highs. The Strategy "
        "does NOT apply a market-wide or sector regime gate, does NOT rotate among AI sub-sectors, "
        "and does NOT rank candidates through a multi-factor scoring model. Every qualifying "
        "breakout is eligible for entry, subject only to the per-position, single-name, ADV, and "
        "2.0x gross-exposure limits above. There is no fixed sector-concentration cap; the Strategy "
        "may concentrate where breakouts cluster, bounded by the 10% single-name limit and the "
        "2.0x gross cap."
    ))
    story.append(PageBreak())

    # ==========================================================================
    # Stop Loss System: Trailing Stop + Break-Even Snap
    # ==========================================================================
    story.append(Paragraph("Stop Loss System: Trailing Stop + Break-Even Snap", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "Every open position is protected by a single, rules-based trailing stop. The governing "
        "stop is anchored to the prior two-week (10 trading day) low and is ratcheted upward only "
        "- it never moves against the trade. A position is exited when the market trades through "
        "the prevailing stop; stop fills are modeled conservatively, including gap-through pricing "
        "where an opening gap carries price beyond the stop level."
    ))
    story.append(spacer(6))
    story.append(P(
        "A break-even protection rule supplements the trail: once a position has accrued a "
        "threshold amount of open profit and confirmed favorable short-interval price action, the "
        "stop is raised to the position's entry price (break-even) on a raise-only basis, after "
        "which the two-week-low trail resumes ratcheting upward. There are no pyramid lots, so a "
        "single stop governs the whole position. Specific lookback periods and profit thresholds "
        "are proprietary."
    ))
    story.append(spacer(10))

    # ==========================================================================
    # Exit Discipline
    # ==========================================================================
    story.append(Paragraph("Exit Discipline", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "Exits are systematic: a position is held until its trailing stop is met. The Strategy does "
        "not employ a fixed time-based or stale-position exit, an overbought-reduction "
        "(momentum-exhaustion) alert, or discretionary profit-taking. A single mechanical exit rule "
        "lets winners run and removes discretion from the exit decision."
    ))
    story.append(spacer(10))

    # ==========================================================================
    # Worst-Case Validation
    # ==========================================================================
    story.append(Paragraph("Worst-Case Validation", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "The Strategy is a high-volatility momentum strategy and has experienced, and will again "
        "experience, large drawdowns. In the hypothetical AI-300 backtest (January 3, 2023 through "
        "June 11, 2026; current index members only, survivorship-flattered; Filet 100K tier), the "
        "gross maximum drawdown was approximately -50.7% on a daily mark-to-market basis; net "
        "drawdowns are somewhat deeper once fund fees and their quarterly crystallization timing "
        "are applied. Investors must be prepared for drawdowns of this magnitude."
    ))
    story.append(P(
        "Capital protection operates at the trade level: each position risks no more than 2% of NAV "
        "to its initial stop, single-name exposure is capped at 10% of NAV, and total gross "
        "exposure is capped at 2.0x NAV. These controls bound the loss on any single name and the "
        "Fund's total market exposure, but they do NOT cap the Fund's overall drawdown, which can "
        "be substantial. Past hypothetical performance is not indicative of future results, and the "
        "Fund may lose capital."
    ))

    doc = make_doc_template(
        OUT_PATH,
        title_meta=f"{FUND} - Risk Management Framework {VERSION}",
        subject="Risk Management Framework",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Risk Management Framework",
        doc_date_display=DATE_DISP,
        fund_name="PNTHR Tree Fund",
        fund_name_upper=FUND_UPPER,
    )
    doc.build(story, onFirstPage=on_cover, onLaterPages=on_page)
    sz = os.path.getsize(OUT_PATH)
    print(f"PDF generated: {OUT_PATH}")
    print(f"Size: {sz:,} bytes")


if __name__ == "__main__":
    build()
