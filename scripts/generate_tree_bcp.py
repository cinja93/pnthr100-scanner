#!/usr/bin/env python3
"""
PNTHR Tree Fund, LP — Business Continuity & Disaster Recovery Plan v1.0
Converted from Carnivore Quant Fund BCP v1.1.

Changes from Carnivore v1.1:
  - Fund name: "Carnivore Quant Fund, LP" -> "PNTHR Tree Fund, LP"
  - All headers/footers/breadcrumbs updated
  - Version: v1.1 -> v1.0, Date: April 2026 -> May 2026
  - Content is operationally identical (shared infrastructure)

Output: ~/Downloads/PNTHR_Tree_Fund_BCP_v1.0_2026.pdf
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
    f"~/Downloads/PNTHR_Tree_Fund_BCP_{VERSION}_2026.pdf")

# ── Local styles ──────────────────────────────────────────────────────────────
SECTION_TITLE = ParagraphStyle(
    name="section_title", fontName="Helvetica-Bold", fontSize=18, leading=22,
    alignment=TA_LEFT, spaceBefore=16, spaceAfter=6,
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
        title_line_1="Business Continuity &amp;",
        title_line_2="Disaster Recovery Plan",
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
    # I. Purpose
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("I. Purpose", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "This Business Continuity Plan (BCP) establishes the procedures STT Capital Advisors, "
        "LLC will follow to maintain critical business operations in the event of a significant "
        "disruption, including natural disasters, pandemics, technology failures, and key "
        "personnel incapacitation. The goal is to minimize disruption to Fund operations and "
        "protect investor capital at all times."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # II. Key Personnel & Succession
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("II. Key Personnel &amp; Succession", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(make_table(
        ["Role", "Primary", "Backup", "Responsibility"],
        [
            ["CIO / CCO", "Scott McBrien", "Cindy Eagar (liquidation authority)",
             "Investment decisions, signal system management, trade execution, compliance oversight"],
            ["COO / CISO", "Cindy Eagar", "Scott McBrien",
             "Operations, information security, investor relations, fund administration"],
        ],
        col_widths=[1.1 * inch, 1.2 * inch, 1.6 * inch, 2.6 * inch],
    ))

    story.append(spacer(8))
    story.append(Paragraph("Key Person Contingency", SUB2_TITLE))
    story.append(P(
        "In the event that Scott McBrien is incapacitated and unable to manage the portfolio:"
    ))

    story.append(Paragraph(
        "•  Cindy Eagar is authorized to execute the Liquidation Protocol - an orderly "
        "unwinding of all open positions using the Fund's protective trailing-stop discipline",
        BULLET))
    story.append(Paragraph(
        "•  All pending orders will be cancelled immediately", BULLET))
    story.append(Paragraph(
        "•  No new positions will be opened", BULLET))
    story.append(Paragraph(
        "•  Investors will be notified within 24 hours", BULLET))
    story.append(Paragraph(
        "•  If incapacitation exceeds 30 days, the Fund will initiate an orderly wind-down "
        "as described in the Limited Partnership Agreement", BULLET))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # III. Technology Infrastructure
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("III. Technology Infrastructure", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(Paragraph("Data Backup &amp; Recovery", SUB2_TITLE))
    story.append(make_table(
        ["System", "Provider", "Backup Method", "Recovery Time"],
        [
            ["Database",         "MongoDB Atlas", "Auto-replicated across 3 nodes; continuous backup", "&lt; 1 hour"],
            ["Application Code", "GitHub",        "Full version history; all branches preserved",      "&lt; 30 minutes"],
            ["Frontend Hosting", "Vercel",        "Auto-deployed from GitHub; CDN replicated globally", "&lt; 5 minutes"],
            ["Backend Hosting",  "Render",        "Auto-deployed from GitHub; container-based",         "&lt; 15 minutes"],
            ["Market Data",      "FMP API",       "Candle cache in MongoDB (12-week age cap)",          "Immediate (cached)"],
        ],
        col_widths=[1.3 * inch, 1.1 * inch, 2.4 * inch, 1.7 * inch],
    ))

    story.append(spacer(8))
    story.append(Paragraph("Critical Vendor Dependencies", SUB2_TITLE))
    story.append(make_table(
        ["Vendor", "Function", "Alternative / Mitigation"],
        [
            ["Interactive Brokers", "Trade execution, custody, NAV sync",
             "Positions can be managed directly via TWS or IBKR mobile in emergency"],
            ["FMP API", "Market data (price, EMA, RSI, volume)",
             "Candle cache provides 12 weeks of historical data; alternative data providers available"],
            ["MongoDB Atlas", "All application data, signals, portfolio",
             "Triple-replicated; point-in-time recovery; local backup capability"],
            ["Vercel", "Frontend hosting (React/Vite)",
             "Can be redeployed to any static host (Netlify, AWS S3) within 1 hour"],
            ["Render", "Backend hosting (Node.js/Express)",
             "Can be redeployed to any Node.js host (Railway, Fly.io, AWS) within 1 hour"],
        ],
        col_widths=[1.3 * inch, 1.8 * inch, 3.4 * inch],
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # IV. Remote Operations
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("IV. Remote Operations", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "STT Capital Advisors, LLC is a fully remote-capable operation. All critical systems "
        "are cloud-based and accessible from any location with internet connectivity. Both key "
        "personnel maintain:"
    ))

    story.append(Paragraph(
        "•  Laptop with all necessary software pre-configured", BULLET))
    story.append(Paragraph(
        "•  Mobile access to IBKR TWS for emergency trade management", BULLET))
    story.append(Paragraph(
        "•  2FA-enabled access to all critical systems", BULLET))
    story.append(Paragraph(
        "•  Encrypted communications (end-to-end) for sensitive discussions", BULLET))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # V. Communication Plan
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("V. Communication Plan", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "In the event of a significant disruption affecting Fund operations:"
    ))

    story.append(spacer(4))
    story.append(make_table(
        ["Stakeholder", "Notification Method", "Timeline"],
        [
            ["Limited Partners",      "Email and phone",                          "Within 24 hours"],
            ["Prime Broker (IBKR)",   "Platform notification + phone",            "Immediately"],
            ["Legal Counsel",         "Phone + email",                            "Within 24 hours"],
            ["Regulators",            "As required by applicable regulation",     "Per regulatory requirement"],
        ],
        col_widths=[1.5 * inch, 2.5 * inch, 2.5 * inch],
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # VI. Cybersecurity
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("VI. Cybersecurity", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P("The Manager maintains the following security controls:"))

    story.append(Paragraph(
        "•  Two-Factor Authentication (2FA) on all accounts (IBKR, MongoDB, GitHub, email)",
        BULLET))
    story.append(Paragraph(
        "•  Encryption at rest for all database storage (MongoDB Atlas)", BULLET))
    story.append(Paragraph(
        "•  JWT-based authentication with role-based access control for the PNTHR application",
        BULLET))
    story.append(Paragraph(
        "•  No shared passwords - individual accounts for all systems", BULLET))
    story.append(Paragraph(
        "•  Regular security updates applied to all hosting environments", BULLET))
    story.append(Paragraph(
        "•  API keys rotated periodically and stored in environment variables (never in code)",
        BULLET))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # VII. Testing & Review
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("VII. Testing &amp; Review", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "This BCP will be reviewed and tested annually or upon any material change to the "
        "Manager's technology infrastructure, key personnel, or vendor relationships. Testing "
        "includes verification of backup recovery procedures, communication protocols, and "
        "emergency access to all critical systems."
    ))

    # ── Build PDF ─────────────────────────────────────────────────────────────
    doc = make_doc_template(
        OUT_PATH,
        title_meta=f"{FUND} - Business Continuity & Disaster Recovery Plan {VERSION}",
        subject="Business Continuity & Disaster Recovery Plan",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Business Continuity & Disaster Recovery Plan",
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
