#!/usr/bin/env python3
"""
PNTHR Tree Fund, LP — Service Provider Summary v1.0
Converted from Carnivore Quant Fund Service Provider Summary v1.0.

Changes from Carnivore v1.0:
  - Fund name throughout
  - Version stays v1.0 (new fund), Date: April 2026 -> May 2026
  - FMP Market Data details: "PNTHR 679 universe" -> "PNTHR AI 300 universe"

Output: ~/Downloads/PNTHR_Tree_Fund_Service_Provider_Summary_v1.0_2026.pdf
"""

import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import Paragraph, Spacer, Table, TableStyle
from reportlab.lib import colors

from pnthr_design import (
    PALETTE_YELLOW, PALETTE_WHITE, PALETTE_DIM_GRAY, PALETTE_PURE_BLACK,
    H1, H2, BODY,
    make_doc_template, make_page_handlers, build_cover_header,
)

FUND       = "PNTHR Tree Fund, LP"
FUND_UPPER = "PNTHR TREE FUND"
VERSION    = "v1.0"
DATE_DISP  = "May 2026"

OUT_PATH = os.path.expanduser(
    f"~/Downloads/PNTHR_Tree_Fund_Service_Provider_Summary_{VERSION}_2026.pdf")

SECTION_TITLE = ParagraphStyle(
    name="section_title", fontName="Helvetica-Bold", fontSize=18, leading=22,
    alignment=TA_LEFT, spaceBefore=16, spaceAfter=6)
SUBSECTION_TITLE = ParagraphStyle(
    name="subsection_title", fontName="Helvetica-Bold", fontSize=14, leading=18,
    alignment=TA_LEFT, spaceBefore=14, spaceAfter=6)
TH = ParagraphStyle(
    name="th", fontName="Helvetica-Bold", fontSize=10, leading=13,
    alignment=TA_LEFT, textColor=PALETTE_WHITE)
TD = ParagraphStyle(
    name="td", fontName="Helvetica", fontSize=10, leading=13, alignment=TA_LEFT)

def P(text, style=BODY):
    return Paragraph(text, style)

def spacer(h=8):
    return Spacer(1, h)

def yellow_rule():
    return Paragraph(
        '<font color="#fcf000">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</font>',
        ParagraphStyle(name="rule", fontSize=6, leading=8, alignment=TA_LEFT,
                       spaceBefore=4, spaceAfter=4))

def make_table(header_cols, rows, col_widths):
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
    story = build_cover_header(
        title_line_1="Service Provider Summary",
        title_line_2=None,
        subtitle=FUND,
        date_line=f"{VERSION} - {DATE_DISP}",
        revision_line=None,
        issuer_line="STT Capital Advisors, LLC",
        confidential_title="CONFIDENTIAL: FOR ACCREDITED INVESTOR / QUALIFIED CLIENT USE ONLY",
        confidential_body=(
            "This document is the property of STT Capital Advisors, LLC "
            "and may not be reproduced or distributed without prior written consent."),
    )

    # ── Intro ─────────────────────────────────────────────────────────────────
    story.append(Paragraph("Service Provider Summary", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        f"The following service providers support the operations of {FUND}. As the Fund "
        "scales, additional providers will be engaged to meet institutional requirements. "
        "All service provider relationships are reviewed annually."))

    story.append(spacer(10))

    # ── Current Service Providers ─────────────────────────────────────────────
    story.append(Paragraph("Current Service Providers", SUBSECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(make_table(
        ["Function", "Provider", "Status", "Details"],
        [
            ["Prime Broker / Custodian", "Interactive Brokers LLC", "Active",
             "Trade execution, custody, real-time NAV sync via proprietary Python bridge (TWS API)"],
            ["Banking", "Axos Bank", "Active",
             "Fund operating account"],
            ["Database / Cloud", "MongoDB Atlas", "Active",
             "Primary data store; encrypted at rest; auto-replicated; continuous backup"],
            ["Frontend Hosting", "Vercel", "Active",
             "React/Vite application hosting with global CDN"],
            ["Backend Hosting", "Render", "Active",
             "Node.js/Express API server with auto-deploy from GitHub"],
            ["Market Data", "Financial Modeling Prep (FMP)", "Active",
             "Price data, fundamentals, technical indicators for PNTHR AI 300 universe"],
            ["Version Control", "GitHub", "Active",
             "Source code management, deployment pipeline integration"],
        ],
        col_widths=[1.3 * inch, 1.4 * inch, 0.7 * inch, 3.1 * inch],
    ))

    story.append(spacer(10))

    # ── Engaged Service Providers ─────────────────────────────────────────────
    story.append(Paragraph("Engaged Service Providers", SUBSECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(make_table(
        ["Function", "Provider", "Status", "Details"],
        [
            ["Legal Counsel", "David S. Hunt, P.C.", "Engaged",
             "Partnership, investment manager, and GP counsel; "
             "66 Exchange Place, Suite 201, Salt Lake City, UT 84111"],
            ["Fund Administrator", "NAV Consulting, Inc.", "Engaged",
             "NAV calculation, accounting, subscriptions/redemptions, AML functions; "
             "1 Trans Am Plaza Dr, Suite 400, Oakbrook Terrace, IL 60181"],
            ["Independent Auditor", "Spicer Jeffries, LLP", "Intended",
             "Annual financial statement audit per U.S. GAAP; upon admission of "
             "non-affiliated LPs; 4601 DTC Blvd, Suite 700, Denver, CO 80237"],
        ],
        col_widths=[1.3 * inch, 1.4 * inch, 0.7 * inch, 3.1 * inch],
    ))

    story.append(spacer(10))

    # ── Planned Service Providers ─────────────────────────────────────────────
    story.append(Paragraph("Planned Service Providers", SUBSECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(make_table(
        ["Function", "Target Provider", "Engagement Trigger", "Purpose"],
        [
            ["Insurance (E&amp;O; / D&amp;O;)", "TBD", "Prior to Outside Capital",
             "Errors &amp; omissions, directors &amp; officers liability coverage"],
            ["Tax Advisers", "TBD", "Prior to Outside Capital",
             "Annual Schedule K-1 preparation, Fund-level tax compliance"],
            ["KYC/AML Provider", "TBD", "At scale",
             "Automated identity verification, sanctions screening, PEP monitoring"],
        ],
        col_widths=[1.3 * inch, 1.3 * inch, 1.3 * inch, 2.6 * inch],
    ))

    story.append(spacer(10))

    # ── Technology Architecture ───────────────────────────────────────────────
    story.append(Paragraph("Technology Architecture", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "The Fund's technology stack is designed for reliability, security, and rapid recovery:"))
    story.append(spacer(4))
    story.append(make_table(
        ["Layer", "Technology", "Provider", "Security"],
        [
            ["Frontend",   "React + Vite",       "Vercel",              "HTTPS, CDN, auto-deploy"],
            ["Backend",    "Node.js + Express",   "Render",              "JWT auth, RBAC, 2FA"],
            ["Database",   "MongoDB",             "Atlas (AWS)",         "Encrypted at rest, 3-node replica"],
            ["Execution",  "TWS API",             "Interactive Brokers", "Socket API, 2FA, account segregation"],
            ["Market Data", "REST API",           "FMP",                 "API key auth, rate limiting, candle cache"],
        ],
        col_widths=[1.2 * inch, 1.3 * inch, 1.5 * inch, 2.5 * inch],
    ))

    # ── Build PDF ─────────────────────────────────────────────────────────────
    doc = make_doc_template(
        OUT_PATH,
        title_meta=f"{FUND} - Service Provider Summary {VERSION}",
        subject="Service Provider Summary",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Service Provider Summary",
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
