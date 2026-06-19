#!/usr/bin/env python3
"""
PNTHR Tree Fund, LP — Investment Process Overview v2.0
Long-only 42-week-high momentum breakout on the AI-300 universe.

Output: ~/Downloads/PNTHR_Tree_Fund_Investment_Process_Overview_v2.0_2026.pdf
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
VERSION    = "v2.0"
DATE_DISP  = "May 2026"

OUT_PATH = os.path.expanduser(
    f"~/Downloads/PNTHR_Tree_Fund_Investment_Process_Overview_{VERSION}_2026.pdf")

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
        f"{FUND} employs a proprietary systematic momentum-breakout equity strategy built on the "
        "PNTHR Signal System. The Fund is authorized long/short; its current systematic "
        "implementation is LONG-ONLY. Each trading day the system identifies names in the PNTHR "
        "AI 300 Universe that break out to a new multi-month (42-week) high and enters them at "
        "full size via a resting buy-stop at the breakout level - no scaling, no pyramiding. Each "
        "position is then managed by a single ratcheting trailing stop (anchored to the prior "
        "two-week low, raised only) with a break-even snap. The Strategy applies no market or "
        "sector regime gate, no sector rotation, and no multi-factor scoring; every qualifying "
        "breakout is eligible, subject to disciplined per-position, single-name, and 2.0x "
        "gross-exposure limits."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # The PNTHR AI 300 Universe
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("The PNTHR AI 300 Universe", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Each trading day the system scans approximately 300 AI-focused U.S. equities spanning "
        "AI infrastructure, semiconductors, cloud/SaaS, cybersecurity, robotics, autonomous "
        "vehicles, quantum computing, and related sectors. The universe was curated for direct "
        "exposure to the artificial intelligence megatrend, with constituents selected for "
        "liquidity, AI revenue relevance, and representation across the full AI value chain. "
        "The Fund trades common equity in this universe; it does not trade ETFs or derivatives."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # PNTHR Proprietary Buy Long Signal (BL)
    # ==========================================================================
    # The New-High Breakout Signal (Buy Long)
    # ==========================================================================
    story.append(Paragraph("The New-High Breakout Signal (Buy Long)", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "The Strategy's core signal is a breakout to a new multi-month high. A Buy Long (BL) "
        "signal is generated when a security's intraday high trades above the highest high it "
        "recorded over the prior ~210 trading days (about 42 weeks), excluding the current day - "
        "confirming a fresh breakout. Entry is executed as a resting buy-stop order at the "
        "breakout level plus one cent; it fills at that level, or at the opening price if the "
        "stock gaps above it. The Strategy uses only price data available at or before the moment "
        "of entry and relies on no forward-looking information. There is no market or sector "
        "regime gate - a qualifying breakout is eligible in any market environment."
    ))
    story.append(spacer(10))

    # ==========================================================================
    # Directional Mandate (Long/Short Authorization)
    # ==========================================================================
    story.append(Paragraph("Directional Mandate (Long/Short Authorization)", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "The Fund is authorized to take both long and short positions at the Investment Manager's "
        "discretion. The current systematic implementation is LONG-ONLY: it initiates long "
        "positions on confirmed new-high breakouts and does not at present initiate shorts. "
        "Consistent with the long/short mandate, the Manager reserves the right to implement a "
        "Sell Short (SS) component - a mirror signal generated on a breakdown to a new "
        "multi-month low - in its sole discretion. No short positions were taken in the backtest, "
        "and no short performance is presented or implied; any material change would be disclosed."
    ))
    story.append(spacer(10))

    # ==========================================================================
    # Position Sizing and Full-Size Entry
    # ==========================================================================
    story.append(Paragraph("Position Sizing and Full-Size Entry", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "Each position is established at its full intended size at the breakout - the Strategy "
        "does not scale, pyramid, or average into positions. Size is the smaller of (i) a share "
        "count whose risk to the initial stop is 2.0% of NAV and (ii) a share count whose entry "
        "value is 10% of NAV, further capped at a fraction of the name's 20-day average daily "
        "volume for executability. Aggregate gross exposure is capped at a hard 2.0x NAV; new "
        "entries are suspended when that limit is reached."
    ))
    story.append(spacer(6))
    story.append(make_table(
        ["Control", "Limit"],
        [
            ["Per-position risk (to initial stop)", "2.0% of NAV"],
            ["Single-name value cap", "10% of NAV at entry"],
            ["ADV participation cap", "Fraction of 20-day ADV"],
            ["Aggregate gross exposure", "2.0x NAV (hard cap)"],
        ],
        col_widths=[3.5 * inch, 2.5 * inch],
    ))
    story.append(spacer(10))

    # ==========================================================================
    # Exit: Trailing Stop and Break-Even Snap
    # ==========================================================================
    story.append(Paragraph("Exit: Trailing Stop and Break-Even Snap", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "Every open position is governed by a single ratcheting trailing stop anchored to the "
        "prior two-week (10 trading day) low, minus one cent, raised only in the direction of the "
        "trade and never against it. A position exits when the market trades through the stop; "
        "stop fills are modeled conservatively, including gap-through pricing. A break-even rule "
        "supplements the trail: once a position has accrued threshold open profit with favorable "
        "short-interval confirmation, the stop is lifted to the entry price, after which the "
        "two-week-low trail resumes ratcheting upward. The Strategy holds a position until its "
        "trailing stop is met; there is no fixed time-based or stale-position exit and no "
        "overbought-reduction alert."
    ))
    story.append(spacer(10))

    # ==========================================================================
    # Daily Process Pipeline
    # ==========================================================================
    story.append(Paragraph("Daily Process Pipeline", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "<b>Daily breakout scan:</b> on each trading session the system evaluates every name in "
        "the AI 300 Universe for a new 42-week-high breakout, places resting buy-stop orders at "
        "the breakout levels for names not already held, and validates each against the "
        "per-position, single-name, ADV, and 2.0x gross-exposure limits."
    ))
    story.append(spacer(6))
    story.append(P(
        "<b>Daily position management:</b> for every open position the system recomputes the "
        "two-week-low trailing stop and the break-even snap, raises the protective stop where "
        "warranted (raise-only), and exits any position whose stop is met. All activity is "
        "reconciled to the prime broker at the close and persisted for reporting."
    ))

    doc = make_doc_template(
        OUT_PATH,
        title_meta=f"{FUND} - Investment Process Overview {VERSION}",
        subject="Investment Process Overview",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Investment Process Overview",
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
