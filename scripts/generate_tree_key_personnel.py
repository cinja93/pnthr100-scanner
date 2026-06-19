#!/usr/bin/env python3
"""
PNTHR Tree Fund, LP — Key Personnel v1.0
Converted from Carnivore Quant Fund Key Personnel v1.3.

Changes from Carnivore v1.3:
  - Fund name: "Carnivore Quant Fund, LP" -> "PNTHR Tree Fund, LP"
  - All headers/footers/breadcrumbs updated
  - Cover subtitle: "PNTHR Tree Fund, LP" (yellow)
  - Version: v1.3 -> v1.0
  - Date: April 2026 -> May 2026
  - Fund launch references: 2025 -> 2026, fund name updated
  - Cindy's Fund Operations row updated for Tree

Output: ~/Downloads/PNTHR_Tree_Fund_Key_Personnel_v1.0_2026.pdf
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (
    Paragraph, Spacer, PageBreak, Table, TableStyle, Image as RLImage,
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

OUT_PATH = os.path.expanduser(f"~/Downloads/PNTHR_Tree_Fund_Key_Personnel_{VERSION}_2026.pdf")

SCOTT_IMG = os.path.expanduser("~/Downloads/Scott-PNTHR-glow.PNG")
CINDY_IMG = os.path.expanduser("~/Downloads/Cindy-PNTHR-glow.PNG")

# ── Local styles ──────────────────────────────────────────────────────────────
NAME_STYLE = ParagraphStyle(
    name="person_name", fontName="Helvetica-Bold", fontSize=18, leading=22,
    alignment=TA_LEFT, spaceBefore=6, spaceAfter=2,
)
ROLE_STYLE = ParagraphStyle(
    name="person_role", fontName="Helvetica-Bold", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=0, spaceAfter=10,
    textColor=PALETTE_PURE_BLACK,
)
BIO_BODY = ParagraphStyle(
    name="bio_body", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=8,
)
TBL_LABEL = ParagraphStyle(
    name="tbl_label", fontName="Helvetica", fontSize=10, leading=13,
    alignment=TA_LEFT, spaceAfter=0, textColor=PALETTE_DIM_GRAY,
)
TBL_VALUE = ParagraphStyle(
    name="tbl_value", fontName="Helvetica", fontSize=10, leading=13,
    alignment=TA_LEFT, spaceAfter=0,
)


def P(text, style=BIO_BODY):
    return Paragraph(text, style)


def spacer(h=8):
    return Spacer(1, h)


def detail_table(rows):
    data = []
    for label, value in rows:
        data.append([
            Paragraph(label, TBL_LABEL),
            Paragraph(value, TBL_VALUE),
        ])
    tbl = Table(data, colWidths=[1.8 * inch, 4.7 * inch])
    tbl.setStyle(TableStyle([
        ("BOX",           (0, 0), (-1, -1), 0.5, colors.black),
        ("INNERGRID",     (0, 0), (-1, -1), 0.3, colors.Color(0.85, 0.85, 0.85)),
        ("BACKGROUND",    (0, 0), (0, -1),  colors.Color(0.96, 0.96, 0.96)),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
        ("TOPPADDING",    (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LINEABOVE",     (0, 0), (-1, 0),  1.5, PALETTE_YELLOW),
    ]))
    return tbl


def build():
    # ── Cover ─────────────────────────────────────────────────────────────────
    story = build_cover_header(
        title_line_1="Key Personnel",
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

    # ── Intro ─────────────────────────────────────────────────────────────────
    story.append(Paragraph("Key Personnel", H1))
    story.append(spacer(4))
    story.append(P(
        "STT Capital Advisors, LLC is led by a complementary team combining "
        "quantitative strategy development with institutional-grade operations. "
        "Together, they designed, built, and backtested the entire PNTHR Signal "
        "System and operational infrastructure."
    ))
    story.append(spacer(6))

    # ── SCOTT McBRIEN ─────────────────────────────────────────────────────────
    story.append(Paragraph(
        '<font color="#fcf000">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</font>',
        ParagraphStyle(name="rule_y", fontSize=6, leading=8, alignment=TA_LEFT,
                       spaceBefore=4, spaceAfter=4)))

    story.append(Paragraph("Scott McBrien", NAME_STYLE))
    story.append(Paragraph(
        "Managing Member, Chief Investment Officer &amp; Chief Compliance Officer",
        ROLE_STYLE))

    if os.path.exists(SCOTT_IMG):
        img = RLImage(SCOTT_IMG, width=1.6 * inch, height=2.13 * inch)
        img.hAlign = "CENTER"
        story.append(img)
        story.append(spacer(8))

    story.append(P(
        "Scott McBrien is the Founder and Managing Member of STT Capital "
        "Advisors, LLC (the Investment Manager) and Co-Founder of PNTHR Funds, "
        "LLC (the General Partner), serving as Chief Investment Officer and Chief "
        f"Compliance Officer for {FUND}. An accomplished investment professional "
        "with decades of experience in equities, futures, and quantitative "
        "investment strategies, Scott began his career in investment banking, "
        "holding Series 7, 63, and 3 SEC/FINRA licenses. He was offered a "
        "position as Head of Trading in Chicago, where he traded a range of "
        "futures contracts and developed a proprietary strategy that doubled the "
        "firm's account in profits within nine months."
    ))

    story.append(P(
        f"In 2026, Scott and his Co-Founder, Cindy Eagar, launched {FUND}, "
        "a Regulation D, Rule 506(c), Section 3(c)(1) long/short equity hedge "
        "fund open to Accredited Investors who are also Qualified Clients. "
        "Together they engineered the proprietary PNTHR Signal System from the "
        "ground up, including the new-high breakout signal engine, the single "
        "ratcheting trailing-stop discipline, and all risk management protocols. "
        "This technology now serves as the strategic engine behind the fund's performance."
    ))

    story.append(P(
        'Scott authored <i>The Sigma Investor™</i> (2024), which debuted '
        'as an Amazon #1 New Release. The book chronicles his contrarian '
        'investment philosophy and documents exceptional performance, including '
        'during the market downturn of 2022, providing insights into navigating '
        'volatile environments.'
    ))

    story.append(P(
        "Scott's expertise has been recognized by major financial media outlets "
        "including <b>CNN</b>, <b>U.S. News &amp; World Report</b>, "
        "<b>The Business Journals</b>, and <b>Business Insider</b>. Business "
        "Insider, with over 200 million global readers, featured his timely short "
        "positions in banking stocks (executed weeks before the March 2023 "
        "collapse of Silicon Valley Bank), highlighting how his system helped "
        "protect investors from significant losses."
    ))

    story.append(spacer(6))
    story.append(detail_table([
        ("Licenses Held",
         "Series 7, Series 63, Series 3 (SEC/FINRA)"),
        ("Career History",
         "Stock &amp; Futures Broker, Senior Technical Analyst, Head of Trading "
         "(Chicago), Futures Trader"),
        ("Published Work",
         "The Sigma Investor™: Amazon #1 New Release (2024)"),
        ("Media &amp; Press",
         "CNN, U.S. News &amp; World Report, The Business Journals, Business "
         "Insider, plus industry podcasts and publications"),
        ("Notable Achievement",
         "Architect of the PNTHR Signal System, a proprietary systematic "
         "trading methodology validated through multi-year backtesting across "
         "bull markets and major drawdowns (the COVID crash, the 2022 bear "
         "market, and the 2025 Liberation Day correction)"),
    ]))

    story.append(PageBreak())

    # ── CINDY EAGAR ───────────────────────────────────────────────────────────
    story.append(Paragraph(
        '<font color="#fcf000">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</font>',
        ParagraphStyle(name="rule_y2", fontSize=6, leading=8, alignment=TA_LEFT,
                       spaceBefore=4, spaceAfter=4)))

    story.append(Paragraph("Cindy Eagar", NAME_STYLE))
    story.append(Paragraph(
        "Chief Operating Officer &amp; Chief Information Security Officer",
        ROLE_STYLE))

    if os.path.exists(CINDY_IMG):
        img = RLImage(CINDY_IMG, width=1.6 * inch, height=2.13 * inch)
        img.hAlign = "CENTER"
        story.append(img)
        story.append(spacer(8))

    story.append(P(
        "Cindy Eagar is the Co-Founder of PNTHR Funds, LLC (the General "
        "Partner) and serves as Chief Operating Officer and Chief Information "
        "Security Officer of STT Capital Advisors, LLC (the Investment Manager) "
        f"and of {FUND}, a U.S.-based hedge fund serving family offices, "
        "high-net-worth, and ultra-high-net-worth investors seeking disciplined, "
        "asymmetric growth strategies. Drawing on nearly two decades in executive "
        "leadership and business growth, Cindy brings a unique perspective to "
        "capital management rooted in risk awareness, strategic positioning, and "
        "operational excellence."
    ))

    story.append(P(
        "Before launching PNTHR FUNDS, Cindy played key executive roles in "
        "scaling venture-backed technology companies. Most notably, she helped "
        "SaaS leader <b>Keap</b> (formerly Infusionsoft) grow from $10M to $100M "
        "in revenue. She has also advised and built partnerships for numerous "
        "high-growth businesses, working closely with founders, operators, and "
        "investors to navigate complex growth stages."
    ))

    story.append(P(
        "At PNTHR FUNDS, Cindy leads technology development, systems engineering, "
        "and data infrastructure. She co-developed the PNTHR Signal System and "
        "built all operational infrastructure for the Fund, including the investor "
        "data room, compliance framework, AML/KYC procedures, and investor "
        "relations processes. She and Co-Founder Scott McBrien focus on protecting "
        "the downside while positioning capital for significant upside through a "
        "disciplined, research-driven approach."
    ))

    story.append(P(
        "Cindy's insights on investing, entrepreneurship, and business strategy "
        "have been featured in and quoted by <b>Business Insider</b>, "
        "<b>U.S. News &amp; World Report</b>, <b>The Business Journals</b>, "
        "and additional industry publications and podcasts."
    ))

    story.append(spacer(6))
    story.append(detail_table([
        ("Operations Experience",
         "Nearly 20 years in executive leadership, project management, and "
         "operations across technology and financial services"),
        ("Key Prior Role",
         "Executive at Keap (Infusionsoft): helped scale from $10M to $100M "
         "in revenue"),
        ("Fund Operations",
         "3+ years building fund operations, compliance infrastructure, and "
         "investor relations across PNTHR fund products"),
        ("Media &amp; Press",
         "Business Insider, U.S. News &amp; World Report, The Business Journals, "
         "plus industry podcasts and publications"),
        ("Responsibilities",
         "Fund operations, information security, technology development, investor "
         "onboarding, data room management, reporting"),
        ("Notable Achievement",
         "Built the complete operational and compliance framework for an emerging "
         "hedge fund, from partnership agreements to data room to investor "
         "communications, establishing institutional-grade infrastructure prior to "
         "accepting outside capital"),
    ]))

    # ── Build PDF ─────────────────────────────────────────────────────────────
    doc = make_doc_template(
        OUT_PATH,
        title_meta=f"{FUND} - Key Personnel {VERSION}",
        subject="Key Personnel",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Key Personnel",
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
