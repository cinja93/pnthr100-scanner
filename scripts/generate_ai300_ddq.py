#!/usr/bin/env python3
"""
PNTHR AI Elite 300 Fund, LP — Due Diligence Questionnaire v2.0
All numbers sourced from AI Elite IR v10.1 Multi-strategy + MCE.

Output: ~/Downloads/PNTHR_AI_Elite_300_DDQ_v2.0_2026.pdf
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
    f"~/Downloads/PNTHR_AI_Elite_300_DDQ_{VERSION}_2026.pdf")

# ── Local styles ──────────────────────────────────────────────────────────────
SECTION_TITLE = ParagraphStyle(
    name="section_title", fontName="Helvetica-Bold", fontSize=16, leading=20,
    alignment=TA_LEFT, spaceBefore=16, spaceAfter=10,
)
TH = ParagraphStyle(
    name="th", fontName="Helvetica-Bold", fontSize=10, leading=13,
    alignment=TA_LEFT, textColor=PALETTE_WHITE,
)
TD_LABEL = ParagraphStyle(
    name="td_label", fontName="Helvetica-Bold", fontSize=10, leading=13,
    alignment=TA_LEFT,
)
TD_VALUE = ParagraphStyle(
    name="td_value", fontName="Helvetica", fontSize=10, leading=13,
    alignment=TA_LEFT,
)
DISCLAIMER = ParagraphStyle(
    name="disclaimer", fontName="Helvetica", fontSize=9, leading=12,
    alignment=TA_JUSTIFY, spaceBefore=4, spaceAfter=6,
    textColor=PALETTE_DIM_GRAY,
)
DISCLAIMER_BOLD = ParagraphStyle(
    name="disclaimer_bold", fontName="Helvetica-Bold", fontSize=9, leading=12,
    alignment=TA_JUSTIFY, spaceBefore=12, spaceAfter=4,
    textColor=PALETTE_DIM_GRAY,
)


def P(text, style=BODY):
    return Paragraph(text, style)


def spacer(h=8):
    return Spacer(1, h)


def section_table(header_cols, rows, col_widths=None):
    """Build a branded table with yellow-topped header row."""
    if col_widths is None:
        col_widths = [2.2 * inch, 4.3 * inch]

    hdr_row = [Paragraph(c, TH) for c in header_cols]
    data = [hdr_row]
    for row in rows:
        data.append([
            Paragraph(row[0], TD_LABEL),
            Paragraph(row[1], TD_VALUE),
        ])

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


def section_table_3col(header_cols, rows, col_widths=None):
    """3-column table variant for Key Personnel."""
    if col_widths is None:
        col_widths = [1.4 * inch, 1.6 * inch, 3.5 * inch]

    hdr_row = [Paragraph(c, TH) for c in header_cols]
    data = [hdr_row]
    for row in rows:
        data.append([Paragraph(cell, TD_VALUE) for cell in row])

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
        title_line_1="Due Diligence Questionnaire",
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
    # I. Organization & Structure
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("I. Organization &amp; Structure", SECTION_TITLE))
    story.append(section_table(
        ["Item", "Detail"],
        [
            ["Fund Name",
             "PNTHR Funds, PNTHR AI Elite 300 Fund, LP"],
            ["General Partner",
             "PNTHR Funds, LLC"],
            ["Investment Manager",
             "STT Capital Advisors, LLC"],
            ["Domicile",
             "Delaware Limited Partnership"],
            ["Fund Inception",
             "Strategy operational June 1, 2026; first Limited Partner admission "
             "targeted Q3 2026"],
            ["Strategy",
             "Systematic Long/Short U.S. Equity"],
            ["Offering Type",
             "Regulation D, Rule 506(c) - Accredited Investors and Qualified Clients"],
            ["Auditor",
             "Spicer Jeffries, LLP (intended, upon admission of Limited Partners)"],
            ["Fund Administrator",
             "NAV Consulting, Inc. (engaged)"],
            ["Legal Counsel",
             "David S. Hunt, P.C. (engaged)"],
            ["Prime Broker / Custodian",
             "Interactive Brokers LLC"],
            ["Bank",
             "Axos Bank"],
        ],
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # II. Key Personnel
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("II. Key Personnel", SECTION_TITLE))
    story.append(section_table_3col(
        ["Name", "Title", "Experience"],
        [
            ["Scott McBrien",
             "Managing Member, CIO &amp; CCO",
             "Decades of experience in equities, futures, and quantitative strategies; "
             "Series 7, 63, and 3 SEC/FINRA licenses; Head of Trading (Chicago); "
             "authored The Sigma Investor (Amazon #1 New Release); designed and "
             "built the entire PNTHR Signal System; featured in CNN, Business Insider, "
             "U.S. News &amp; World Report, The Business Journals"],
            ["Cindy Eagar",
             "COO &amp; CISO",
             "Nearly 20 years in executive leadership and operations; helped scale "
             "Keap (Infusionsoft) from $10M to $100M in revenue; built all fund "
             "operational infrastructure, compliance framework, and investor data room; "
             "co-developed the PNTHR Signal System; featured in Business Insider, "
             "U.S. News &amp; World Report, The Business Journals"],
        ],
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # III. Investment Strategy
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("III. Investment Strategy", SECTION_TITLE))
    story.append(section_table(
        ["Question", "Answer"],
        [
            ["Strategy Description",
             "Multi-strategy + MCE (Momentum Continuation Entry) systematic long/short equity "
             "strategy using the proprietary PNTHR Signal System. Weekly BL and SS signals are "
             "generated based on sector-specific trend-filter dynamics, then ranked through a "
             "multi-dimensional scoring framework (Kill Score). Daily MCE entries add momentum "
             "continuation positions on active weekly BL signals when the daily 2-bar high breakout "
             "triggers for TTM top-100 ranked names. Candidates pass through a "
             "PAI300 regime gate (proprietary PNTHR AI 300 Index 21-week EMA), "
             "a sector ETF gate (sector-specific trend-filter periods, empirically optimized per sector; "
             "specific periods proprietary), an AI sub-sector rotation engine, "
             "and an SS Crash Gate (dual "
             "confirmation of sustained bearish direction-index momentum and pronounced recent "
             "sector weakness; specific thresholds proprietary) for short entries. Positions are "
             "entered via a 5-lot pyramid structure (35% / 25% / 20% / 12% / 8%) with the PNTHR "
             "Proprietary Stop Loss System (PPSLS)."],
            ["Investment Universe",
             "PNTHR AI 300 - curated universe of approximately 300 AI-focused U.S. equities "
             "spanning AI infrastructure, semiconductors, cloud/SaaS, cybersecurity, robotics, "
             "autonomous vehicles, quantum computing, and related sectors, plus sector ETFs"],
            ["Position Holding Period",
             "Swing (typically 4-6 weeks; 20-day stale position exit if price fails to progress)"],
            ["Long/Short Allocation",
             "Dynamic based on regime and signal availability; structural long bias (top 10 BL + top 5 "
             "SS per week maximum, plus daily MCE entries). Per backtest: 1,371 BL / 134 SS trades "
             "= 91.1% / 8.9% by trade count"],
            ["Use of Leverage",
             "The Fund may employ leverage of up to 2:1 gross exposure."],
            ["Use of Derivatives",
             "None. The Fund trades common equity and ETFs only."],
        ],
    ))

    story.append(PageBreak())

    # ══════════════════════════════════════════════════════════════════════════
    # IV. Risk Management
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("IV. Risk Management", SECTION_TITLE))
    story.append(section_table(
        ["Question", "Answer"],
        [
            ["Position Sizing",
             "1.0% vitality cap per equity (0.5% per ETF); 10% per-ticker cap; NAV-scaled "
             "(vitality = NAV x 1.0%, tickerCap = NAV x 10%)"],
            ["Stop Loss Methodology",
             "PNTHR Proprietary Stop Loss System (PPSLS); stops never loosen; ratchet on "
             "pyramid lot fills (Lot 3 to breakeven, Lot 4 to Lot 2 fill, Lot 5 to Lot 3 fill)"],
            ["Portfolio Heat Caps",
             "10% gross long, 5% gross short, 15% total portfolio heat"],
            ["Sector Concentration",
             "No fixed sector concentration cap. The Fund may concentrate in a single sector when "
             "trend and macro conditions favor it. Sector allocation is governed by the AI sub-sector "
             "rotation engine and sector ETF gate (each sector ETF must be above/below its "
             "per-sector optimized EMA for BL/SS respectively)"],
            ["Automated Alerts",
             "FEAST (RSI &gt; 85, 50% reduction signal), Stale Hunt (20 trading days without progress)"],
            ["Pre-Trade Assessment",
             "100-point Analyze Score; minimum 55% required to proceed"],
        ],
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # V. Fees & Terms
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("V. Fees &amp; Terms", SECTION_TITLE))
    story.append(section_table(
        ["Question", "Answer"],
        [
            ["Management Fee",
             "2.0% per annum on NAV, accrued monthly, paid quarterly in advance"],
            ["Performance Allocation",
             "20-30% quarterly, non-cumulative (Wagyu 20%, Porterhouse 25%, Filet 30%)"],
            ["Hurdle Rate",
             "US 2-Year Treasury yield, applied quarterly (annualized yield / 4)"],
            ["High Water Mark",
             "Yes - running maximum of adjusted NAV per unit, with Loss Carryforward Provision"],
            ["Loyalty Discount",
             "5% reduction in performance allocation after 36 consecutive months"],
            ["Lock-Up Period",
             "1 year (25% early withdrawal penalty if redeemed during lock-up)"],
            ["Redemption",
             "Quarterly with 60 days prior written notice; $25K minimum; $50K balance floor; 25% "
             "quarterly gate"],
            ["Minimum Investment",
             "Filet: $100,000; Porterhouse: $500,000-$999,999; Wagyu: $1,000,000+"],
            ["Eligible Investors",
             "Must be both Accredited Investors and Qualified Clients"],
        ],
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # VI. Operations & Technology
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("VI. Operations &amp; Technology", SECTION_TITLE))
    story.append(section_table(
        ["Question", "Answer"],
        [
            ["Trading Platform",
             "Interactive Brokers Trader Workstation (TWS) - automated sync via proprietary Python "
             "bridge"],
            ["Data Infrastructure",
             "MongoDB Atlas (encrypted at rest, auto-replicated), Vercel (frontend), Render "
             "(backend)"],
            ["Market Data Provider",
             "Financial Modeling Prep (FMP) API"],
            ["Security Controls",
             "2FA on all accounts, JWT authentication, role-based access control, encrypted data at "
             "rest"],
            ["Reporting Frequency",
             "Monthly performance letters; quarterly detailed reports"],
            ["NAV Calculation",
             "Real-time NAV from IBKR account sync; reconciled daily"],
        ],
    ))

    story.append(PageBreak())

    # ══════════════════════════════════════════════════════════════════════════
    # VII. Regulatory & Compliance
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("VII. Regulatory &amp; Compliance", SECTION_TITLE))
    story.append(section_table(
        ["Question", "Answer"],
        [
            ["SEC Registration",
             "Relying on private fund adviser exemption (sub-$150M AUM). Will file as Exempt "
             "Reporting Adviser (ERA) when required."],
            ["Form D",
             "To be filed upon acceptance of first LP capital"],
            ["Compliance Program",
             "Written compliance manual, personal trading policy with pre-clearance, code of ethics, "
             "AML/KYC procedures"],
            ["Chief Compliance Officer",
             "Scott McBrien, CIO &amp; CCO"],
            ["Chief Information Security Officer",
             "Cindy Eagar, COO &amp; CISO"],
            ["Personal Trading Policy",
             "Pre-clearance required; 7-day minimum holding period; no trading in Fund universe "
             "securities in personal accounts"],
            ["Insurance",
             "E&amp;O; and D&amp;O; coverage to be obtained prior to Outside Capital"],
        ],
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # VIII. Track Record
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("VIII. Track Record", SECTION_TITLE))
    story.append(section_table(
        ["Question", "Answer"],
        [
            ["Track Record Type",
             "Hypothetical Systematic Backtest (January 2022 through May 2026; 53 months; "
             "1,103 trading days). Multi-strategy + MCE (Momentum Continuation Entry). "
             "Fund has not yet traded non-affiliated Limited Partner capital."],
            ["Total Trades (Wagyu tier)",
             "1,505 closed trades (1,371 BL + 134 SS)"],
            ["Gross CAGR",
             "+70.51% (Wagyu tier; post-transaction-costs, pre-fund-fees)"],
            ["Gross Sharpe Ratio",
             "1.79 (daily resolution, excess over US 3-month Treasury)"],
            ["Gross Sortino Ratio",
             "3.07 (daily resolution, MAR = 0)"],
            ["Gross Profit Factor",
             "2.79x"],
            ["Gross Max Drawdown (daily NAV)",
             "-23.45% (Wagyu tier, mark-to-market)"],
            ["Net CAGR (after all fund fees)",
             "Filet (100K): +49.90%; Porterhouse (500K): +50.97%; Wagyu (1M+): +55.65%"],
            ["Net Sharpe Ratio",
             "Filet: 1.33; Porterhouse: 1.37; Wagyu: 1.47"],
            ["Net Sortino Ratio",
             "Filet: 2.19; Porterhouse: 2.30; Wagyu: 2.49"],
            ["Net Max Drawdown (daily NAV)",
             "Filet: -27.57%; Porterhouse: -26.23%; Wagyu: -25.56%"],
            ["Benchmark (S&amp;P 500)",
             "CAGR: +7.75%; Sharpe: 0.31; Max Drawdown: -25.36%. Strategy net alpha: "
             "Filet +42.15 pts; Porterhouse +43.22 pts; Wagyu +47.90 pts (annualized)."],
            ["Data Integrity",
             "Backtest internally validated: PAI300 regime gate via proprietary PNTHR AI 300 Index "
             "(capped market-cap weighted, monthly rebalanced, base 2022-11-30 = 1000); "
             "AI sub-sector rotation engine with sector-specific optimized EMA periods; "
             "daily MCE entry triggers on TTM top-100 ranked names; "
             "quarterly non-cumulative fee engine per PPM sec. 4.1-4.3; mark-to-market "
             "daily-basis Max Drawdown computation. Not independently audited by a third-party "
             "accounting firm; Fund intends to engage Spicer Jeffries LLP as independent auditor "
             "upon Limited Partner admission."],
            ["Full Detail",
             "Refer to PNTHR AI Elite 300 Fund Intelligence Report v10.1 for complete per-class "
             "metrics, annual performance breakdowns, crisis alpha analysis, methodology, and "
             "anticipated due diligence questions."],
        ],
    ))

    story.append(spacer(16))

    # ── Disclaimers ───────────────────────────────────────────────────────────
    story.append(Paragraph(
        "HYPOTHETICAL PERFORMANCE RESULTS HAVE MANY INHERENT LIMITATIONS.",
        DISCLAIMER_BOLD))
    story.append(Paragraph(
        "No representation is being made that any "
        "account will or is likely to achieve profits or losses similar to those shown. "
        "Hypothetical results are prepared with hindsight, do not "
        "involve financial risk, and cannot fully account for market impact or the psychological "
        "pressure of actual trading. Live performance "
        "typically delivers a portion of backtested results due to execution slippage, strategy "
        "decay, and capacity constraints; investors "
        "should expect realized returns closer to top-tier industry averages (HFRI Equity Hedge "
        "long-run: 6-9% net CAGR, Sharpe 0.6-0.9) "
        "than to the backtest headline. This document contains hypothetical performance as defined "
        "in Rule 206(4)-1 under the Investment "
        "Advisers Act (the SEC Marketing Rule).",
        DISCLAIMER))

    story.append(Paragraph(
        "This DDQ is provided for informational purposes only and does not constitute an offer "
        "to sell or a solicitation of an offer to buy any "
        "interest in the Fund. Any such offer will be made solely by the Private Placement "
        "Memorandum, Limited Partnership Agreement, "
        "and Subscription Agreement; in the event of conflict between this DDQ and those governing "
        "documents, the governing documents "
        "shall control. The Fund is offered in reliance on Rule 506(c) of Regulation D, relies on "
        "Section 3(c)(1) (not Section 3(c)(7)) of the "
        "Investment Company Act, and is limited to 100 beneficial owners. Past hypothetical "
        "performance is not indicative of future results. "
        "Investors may lose some or all of their capital.",
        DISCLAIMER))

    # ── Build PDF ─────────────────────────────────────────────────────────────
    doc = make_doc_template(
        OUT_PATH,
        title_meta=f"{FUND} - Due Diligence Questionnaire {VERSION}",
        subject="Due Diligence Questionnaire",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Due Diligence Questionnaire",
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
