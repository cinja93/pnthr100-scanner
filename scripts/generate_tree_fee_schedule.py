#!/usr/bin/env python3
"""
PNTHR Tree Fund, LP — Fee Schedule Summary v1.0
Converted from Carnivore Quant Fund Fee Schedule Summary v1.1.

Changes from Carnivore v1.1:
  - Fund name: "Carnivore Quant Fund, LP" -> "PNTHR Tree Fund, LP"
  - All headers/footers/breadcrumbs updated
  - Version: v1.1 -> v1.0
  - Date: April 2026 -> May 2026
  - Fee structure and terms are IDENTICAL between funds

Output: ~/Downloads/PNTHR_Tree_Fund_Fee_Schedule_Summary_v1.0_2026.pdf
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
FUND_UPPER = "PNTHR AI ELITE 300 FUND"
VERSION    = "v1.0"
DATE_DISP  = "May 2026"

OUT_PATH = os.path.expanduser(
    f"~/Downloads/PNTHR_Tree_Fund_Fee_Schedule_Summary_{VERSION}_2026.pdf")

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
    name="sub2_title", fontName="Helvetica-Oblique", fontSize=12, leading=15,
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
SMALL_DISCLAIMER = ParagraphStyle(
    name="small_disclaimer", fontName="Helvetica-Oblique", fontSize=9, leading=12,
    alignment=TA_JUSTIFY, spaceBefore=12, spaceAfter=6,
    textColor=PALETTE_DIM_GRAY,
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
        title_line_1="Fee Schedule Summary",
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
    # Interest Classes
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Interest Classes", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "The Fund offers three classes of Limited Partner Interests, differentiated by minimum "
        "investment level and corresponding performance allocation rate. All classes are subject "
        "to the same management fee, redemption terms, and investment strategy."
    ))

    story.append(spacer(6))
    story.append(make_table(
        ["Feature", "Wagyu Class", "Porterhouse Class", "Filet Class"],
        [
            ["Minimum Investment",   "&gt;= $1,000,000", "$500,000 - $999,999", "&lt; $500,000 (min. $100,000)"],
            ["Performance Allocation", "20%",             "25%",                  "30%"],
            ["3-Year Loyalty Rate",  "15%",               "20%",                  "25%"],
            ["Management Fee",       "2.0% p.a.",         "2.0% p.a.",            "2.0% p.a."],
            ["Hurdle Rate",          "US2Y",              "US2Y",                 "US2Y"],
            ["High Water Mark",      "Yes",               "Yes",                  "Yes"],
            ["Lock-Up",              "1 year",            "1 year",               "1 year"],
        ],
        col_widths=[1.6 * inch, 1.6 * inch, 1.7 * inch, 1.6 * inch],
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Management Fee
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Management Fee", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "2.0% per annum on Net Asset Value, accrued monthly and paid quarterly in advance."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Performance Allocation
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Performance Allocation", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "The performance allocation is calculated quarterly (non-cumulative), at the end of "
        "each fiscal quarter, based on the net appreciation of each Limited Partner's capital "
        "account above the High Water Mark and in excess of the quarterly Hurdle Rate (the "
        "annualized US2Y yield divided by four) for such quarter. Each quarter is evaluated "
        "independently."
    ))

    story.append(spacer(6))
    story.append(Paragraph("Class Upgrade Path", SUB2_TITLE))
    story.append(P(
        "Limited Partners whose aggregate capital commitment increases to or above a higher "
        "tier threshold may request reclassification to the applicable higher class. Upgrades "
        "are effective at the beginning of the next full performance period following written "
        "request and confirmation by the General Partner. The performance allocation rate for "
        "the prior period will be calculated at the rate applicable to the investor's prior "
        "class. Downgrades (to a lower class due to partial withdrawal) are at the sole "
        "discretion of the General Partner."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Hurdle Rate
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Hurdle Rate", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "The US 2-Year Treasury Yield (US2Y), applied as a quarterly hurdle (the annualized "
        "yield divided by four). No performance allocation is earned on any quarter's net "
        "appreciation until the Fund's quarterly return exceeds this threshold."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # High Water Mark with Loss Carryforward
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("High Water Mark with Loss Carryforward", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Performance allocations are calculated only on net profits above the High Water Mark. "
        "The High Water Mark is a running maximum of the Limited Partner's adjusted NAV per unit."
    ))

    story.append(P(
        "If a Limited Partner's capital account has a net loss in any calendar quarter, the "
        "Loss Carryforward Provision applies: the deficit must be fully recovered in subsequent "
        "periods before any performance allocation is charged. The Loss Carryforward is specific "
        "to each Limited Partner's account and is not aggregated across investors."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # 3-Year Loyalty Discount
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("3-Year Loyalty Discount", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Limited Partners who maintain continuous investment for 36 consecutive months are "
        "eligible for a permanent 5% reduction in performance allocation rate for all subsequent "
        "performance periods. The loyalty discount is applied prospectively beginning in the "
        "performance period following the 36-month anniversary."
    ))

    story.append(spacer(6))
    story.append(make_table(
        ["Class", "Standard Rate", "Loyalty Rate (36+ Months)", "Savings"],
        [
            ["Wagyu",       "20%", "15%", "5%"],
            ["Porterhouse", "25%", "20%", "5%"],
            ["Filet",       "30%", "25%", "5%"],
        ],
        col_widths=[1.5 * inch, 1.5 * inch, 2.0 * inch, 1.5 * inch],
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Redemptions
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Redemptions", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Quarterly, as of the last day of each calendar quarter, upon at least sixty (60) days' "
        "prior written notice, subject to the lock-up provisions described herein. The General "
        "Partner reserves the right to impose gates, suspend redemptions, or satisfy redemptions "
        "in kind."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Lock-Up Period
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Lock-Up Period", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "One (1) year from the date of initial investment, unless waived by the General Partner."
    ))

    story.append(spacer(6))
    story.append(Paragraph("Early Withdrawal Penalty", SUB2_TITLE))
    story.append(P(
        "Redemptions made during the lock-up period (if permitted by the General Partner) are "
        "subject to a 25% early withdrawal penalty applied to the redeemed amount."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Redemption Restrictions
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Redemption Restrictions", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(Paragraph(
        "•  Minimum Withdrawal: $25,000", BULLET))
    story.append(Paragraph(
        "•  Minimum Balance: $50,000 must remain in the Limited Partner's capital account "
        "following any redemption. If a redemption would reduce the balance below $50,000, "
        "the General Partner may require a full redemption.", BULLET))
    story.append(Paragraph(
        "•  Gate Provision: The General Partner may limit aggregate quarterly redemptions to "
        "25% of the Fund's NAV. Redemption requests in excess of the gate will be fulfilled "
        "pro rata and the unfulfilled portion carried forward to the next quarter.", BULLET))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Eligible Investors
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Eligible Investors", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "The Fund is offered exclusively under Regulation D, Rule 506(c). All investors must "
        "qualify as both Accredited Investors and Qualified Clients as defined under the "
        "Securities Act of 1933 and the Investment Advisers Act of 1940, respectively."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Subscription Periods
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Subscription Periods", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Monthly, on the first Business Day of each calendar month, upon thirty (30) days' "
        "prior written notice to the General Partner."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # Fiscal Year
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("Fiscal Year", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P("<b>January 1 through December 31.</b>"))

    story.append(spacer(12))

    # ── Disclaimer ────────────────────────────────────────────────────────────
    story.append(Paragraph(
        "This summary is provided for convenience only and does not modify or supersede the "
        "terms of the Private Placement Memorandum or Limited Partnership Agreement. In the "
        "event of any conflict, the PPM and LPA govern.",
        SMALL_DISCLAIMER))

    # ── Build PDF ─────────────────────────────────────────────────────────────
    doc = make_doc_template(
        OUT_PATH,
        title_meta=f"{FUND} - Fee Schedule Summary {VERSION}",
        subject="Fee Schedule Summary",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Fee Schedule Summary",
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
