#!/usr/bin/env python3
"""
PNTHR Tree Fund, LP — Due Diligence Questionnaire v2.1
All numbers sourced from the PNTHR Tree Fund Intelligence Report v1.0
(long-only 42-week-high momentum on the AI-300 universe).
SPY benchmark measured from the first trade date (Jan 3, 2023).

Output: ~/Downloads/PNTHR_Tree_Fund_DDQ_v2.1_2026.pdf
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
VERSION    = "v2.2"
DATE_DISP  = "June 2026"

OUT_PATH = os.path.expanduser(
    f"~/Downloads/PNTHR_Tree_Fund_DDQ_{VERSION}_2026.pdf")

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
             "PNTHR Tree Fund, LP"],
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
             "Systematic momentum-breakout equity strategy using the proprietary PNTHR Signal "
             "System. The Fund is authorized long/short; its current systematic implementation is "
             "LONG-ONLY. Each trading day, every name in the PNTHR AI 300 Universe is evaluated for "
             "a breakout to a new multi-month (42-week) high; a Buy Long (BL) signal is taken when a "
             "name trades above the highest high of its prior ~210 trading days, entered at full size "
             "via a resting buy-stop at the breakout level (no pyramiding, no scaling). The Strategy "
             "applies NO market or sector regime gate, NO sector rotation, and NO multi-factor "
             "scoring - every qualifying breakout is eligible, subject to the position and "
             "gross-exposure limits. Each position is managed by a single ratcheting trailing stop "
             "(prior 2-week low, raised only) plus a break-even snap. The long/short mandate reserves "
             "a Sell Short (SS) component (breakdown to a new low) at the Manager's discretion; it is "
             "not currently active, and no short performance is presented or implied."],
            ["Investment Universe",
             "PNTHR AI 300 - curated universe of approximately 300 AI-focused U.S. equities "
             "spanning AI infrastructure, semiconductors, cloud/SaaS, cybersecurity, robotics, "
             "autonomous vehicles, quantum computing, and related sectors"],
            ["Position Holding Period",
             "Position/swing - held until the trailing stop is met (average winner hold approximately "
             "26 trading days; no fixed time-based or stale-position exit)"],
            ["Long/Short Allocation",
             "Long/short authorized; current systematic implementation is LONG-ONLY (100% long). No "
             "short positions were taken in the backtest (1,333 long trades). A short component is "
             "reserved at the Manager's discretion and would be disclosed if activated"],
            ["Use of Leverage",
             "The Fund may employ leverage of up to 2:1 gross exposure (a hard 2.0x NAV gross cap)."],
            ["Use of Derivatives",
             "None. The Fund trades common equity only."],
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
             "Each position is sized to the smaller of 2.0% of NAV risked to the initial stop and "
             "10% of NAV in position value; further capped at a fraction of the name's 20-day average "
             "daily volume; NAV-scaled so sizing compounds with the Fund"],
            ["Stop Loss Methodology",
             "A single ratcheting trailing stop anchored to the prior 2-week (10 trading day) low, "
             "raised only in the direction of the trade, plus a break-even snap that lifts the stop to "
             "the entry price once threshold open profit is reached with green confirmation. No "
             "pyramid lots"],
            ["Portfolio Heat Caps",
             "Hard 2.0x NAV gross-exposure cap; new entries are suspended when aggregate gross "
             "exposure would exceed the cap"],
            ["Sector Concentration",
             "No fixed sector concentration cap and no sector rotation or sector gating. Entries are "
             "driven solely by single-name new-high breakouts, subject to the 10% single-name limit "
             "and the 2.0x gross-exposure cap"],
            ["Automated Alerts",
             "Exits are governed by the trailing stop and break-even snap; the Fund does not use a "
             "separate overbought-reduction or stale-position alert"],
            ["Pre-Trade Assessment",
             "None - every qualifying new-high breakout is eligible, subject to the position and "
             "gross-exposure limits"],
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
             "Hypothetical systematic backtest (January 3, 2023 through June 11, 2026; ~3.45 years; "
             "863 trading sessions; frozen at go-live). Long-only momentum-breakout on new 42-week "
             "highs in the PNTHR AI 300 Universe. The Fund has not yet traded non-affiliated Limited "
             "Partner capital."],
            ["Total Trades (by tier)",
             "Filet (100K): 1,333; Porterhouse (500K): 1,698; Wagyu (1M+): 1,807 - all long. Counts "
             "rise at larger tiers as the average-daily-volume participation cap admits more, smaller "
             "positions"],
            ["Gross CAGR (post-costs, pre-fund-fees)",
             "Filet (100K): +87.9%; Porterhouse (500K): +75.5%; Wagyu (1M+): +56.1%. CAGR declines "
             "with size as the ADV participation cap binds (capacity)"],
            ["Gross Sharpe / Sortino",
             "Filet: 1.34 / 2.14; Porterhouse: 1.21 / 1.90; Wagyu: 0.99 / 1.57 (daily resolution, "
             "excess over US 3-month Treasury)"],
            ["Profit Factor (trade-level, net of trading costs)",
             "Filet: 1.77x; Porterhouse: 1.69x; Wagyu: 1.48x"],
            ["Gross Max Drawdown (daily NAV, MTM)",
             "Filet: -47.6%; Porterhouse: -48.3%; Wagyu: -48.3%"],
            ["Net CAGR (after all fund fees)",
             "Filet (100K): +60.4%; Porterhouse (500K): +56.4%; Wagyu (1M+): +44.7%"],
            ["Net Sharpe / Sortino",
             "Filet: 1.05 / 1.66; Porterhouse: 1.00 / 1.57; Wagyu: 0.86 / 1.35"],
            ["Net Max Drawdown (daily NAV, MTM)",
             "Filet: -52.4%; Porterhouse: -52.2%; Wagyu: -51.9% (net drawdowns are deepened by "
             "quarterly performance-fee crystallization timing)"],
            ["Benchmark (S&amp;P 500)",
             "CAGR: +21.2%; Sharpe: 1.04; Max Drawdown: -19.0% (measured from the first trade date). "
             "Net alpha vs SPY: Filet +49.5 pts; Porterhouse +34.6 pts; Wagyu +27.1 pts (annualized)."],
            ["Data Integrity",
             "Backtest run on the CURRENT PNTHR AI 300 index members only (SURVIVORSHIP-FLATTERED); "
             "executable with no look-ahead; resting buy-stop entries with gap-through fills; IBKR "
             "commission and slippage on every leg; 2% average-daily-volume participation cap; "
             "quarterly non-cumulative fee engine per PPM; mark-to-market daily-basis Max Drawdown. "
             "Frozen at go-live (June 11, 2026); live tracking begins June 12, 2026. Not independently "
             "audited by a third-party accounting firm; Fund intends to engage Spicer Jeffries LLP as "
             "independent auditor upon Limited Partner admission."],
            ["Full Detail",
             "Refer to the PNTHR Tree Fund Intelligence Report (v1.0) for complete per-class "
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
        fund_name="PNTHR Tree Fund",
        fund_name_upper=FUND_UPPER,
    )
    doc.build(story, onFirstPage=on_cover, onLaterPages=on_page)
    sz = os.path.getsize(OUT_PATH)
    print(f"PDF generated: {OUT_PATH}")
    print(f"Size: {sz:,} bytes")


if __name__ == "__main__":
    build()
