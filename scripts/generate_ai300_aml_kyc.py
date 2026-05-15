#!/usr/bin/env python3
"""
PNTHR AI Elite 300 Fund, LP — Anti-Money Laundering & KYC Policy v1.0
Converted from Carnivore Quant Fund AML/KYC Policy v1.1.

Changes from Carnivore v1.1:
  - Fund name: "Carnivore Quant Fund, LP" -> "PNTHR AI Elite 300 Fund, LP"
  - All headers/footers/breadcrumbs updated
  - Version: v1.1 -> v1.0, Date: April 2026 -> May 2026
  - AML/KYC content is operationally identical

Output: ~/Downloads/PNTHR_AI_Elite_300_AML_KYC_Policy_v1.0_2026.pdf
"""

import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_JUSTIFY
from reportlab.platypus import Paragraph, Spacer, Table, TableStyle
from reportlab.lib import colors

from pnthr_design import (
    PALETTE_YELLOW, PALETTE_WHITE, PALETTE_DIM_GRAY, PALETTE_PURE_BLACK,
    H1, H2, BODY, BODY_LEFT,
    make_doc_template, make_page_handlers, build_cover_header,
)

FUND       = "PNTHR AI Elite 300 Fund, LP"
FUND_UPPER = "PNTHR AI ELITE 300 FUND"
VERSION    = "v1.0"
DATE_DISP  = "May 2026"

OUT_PATH = os.path.expanduser(
    f"~/Downloads/PNTHR_AI_Elite_300_AML_KYC_Policy_{VERSION}_2026.pdf")

SECTION_TITLE = ParagraphStyle(
    name="section_title", fontName="Helvetica-Bold", fontSize=18, leading=22,
    alignment=TA_LEFT, spaceBefore=16, spaceAfter=6)
SUB2_TITLE = ParagraphStyle(
    name="sub2_title", fontName="Helvetica-Oblique", fontSize=12, leading=15,
    alignment=TA_LEFT, spaceBefore=10, spaceAfter=4)
BULLET = ParagraphStyle(
    name="bullet", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=2, spaceAfter=2, leftIndent=18, firstLineIndent=-14)
SMALL_NOTE = ParagraphStyle(
    name="small_note", fontName="Helvetica", fontSize=10, leading=13,
    alignment=TA_JUSTIFY, spaceBefore=6, spaceAfter=6)

def P(text, style=BODY):
    return Paragraph(text, style)

def spacer(h=8):
    return Spacer(1, h)

def yellow_rule():
    return Paragraph(
        '<font color="#fcf000">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</font>',
        ParagraphStyle(name="rule", fontSize=6, leading=8, alignment=TA_LEFT,
                       spaceBefore=4, spaceAfter=4))


def build():
    story = build_cover_header(
        title_line_1="Anti-Money Laundering &amp;",
        title_line_2="KYC Policy",
        subtitle=FUND,
        date_line=f"{VERSION} - {DATE_DISP}",
        revision_line=None,
        issuer_line="STT Capital Advisors, LLC",
        confidential_title="CONFIDENTIAL: FOR ACCREDITED INVESTOR / QUALIFIED CLIENT USE ONLY",
        confidential_body=(
            "This document is the property of STT Capital Advisors, LLC "
            "and may not be reproduced or distributed without prior written consent."),
    )

    # I. Purpose & Scope
    story.append(Paragraph("I. Purpose &amp; Scope", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "This Anti-Money Laundering (AML) and Know Your Customer (KYC) Policy establishes the "
        'procedures STT Capital Advisors, LLC (the "Manager") employs to detect and prevent '
        "money laundering, terrorist financing, and other financial crimes. This policy applies "
        "to all investor onboarding, ongoing monitoring, and suspicious activity reporting."))

    story.append(spacer(10))

    # II. AML Compliance Officer
    story.append(Paragraph("II. AML Compliance Officer", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P("<b>AML Compliance Officer:</b> Scott McBrien, CIO &amp; CCO"))
    story.append(P("<b>AML Designee / CISO:</b> Cindy Eagar, COO &amp; CISO"))
    story.append(P(
        "<b>Responsibilities:</b> Overseeing the AML program, reviewing KYC documentation, "
        "filing Suspicious Activity Reports (SARs) when required, conducting annual AML "
        "training, and maintaining AML records."))

    story.append(spacer(10))

    # III. Customer Identification Program (CIP)
    story.append(Paragraph("III. Customer Identification Program (CIP)", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P("For each prospective Limited Partner, the Manager will collect and verify:"))

    story.append(spacer(4))
    story.append(Paragraph("Individual Investors", SUB2_TITLE))
    story.append(Paragraph("•  Full legal name", BULLET))
    story.append(Paragraph("•  Date of birth", BULLET))
    story.append(Paragraph("•  Current residential address", BULLET))
    story.append(Paragraph(
        "•  Government-issued photo identification (passport or driver's license)", BULLET))
    story.append(Paragraph(
        "•  Social Security Number or Tax Identification Number", BULLET))

    story.append(spacer(4))
    story.append(Paragraph("Entity Investors", SUB2_TITLE))
    story.append(Paragraph("•  Legal entity name and formation documents", BULLET))
    story.append(Paragraph("•  Principal place of business", BULLET))
    story.append(Paragraph("•  Taxpayer Identification Number (EIN)", BULLET))
    story.append(Paragraph(
        "•  Identity of beneficial owners (25%+ ownership)", BULLET))
    story.append(Paragraph("•  Identity of authorized signatories", BULLET))
    story.append(Paragraph("•  Certificate of good standing or equivalent", BULLET))

    story.append(spacer(10))

    # IV. Accredited Investor and Qualified Client Verification
    story.append(Paragraph(
        "IV. Accredited Investor and Qualified Client Verification", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "As a Rule 506(c) offering exempt under Section 3(c)(1) of the Investment Company Act, "
        "the Fund is required to take reasonable steps to verify that each investor qualifies as "
        "both an Accredited Investor (Rule 501(a) of Regulation D) and a Qualified Client "
        "(Rule 205-3 of the Investment Advisers Act of 1940), as required by the Fund's offering "
        "documents. Acceptable verification methods include:"))

    story.append(Paragraph(
        "•  Review of tax returns, W-2s, or other IRS filings (income-based verification)",
        BULLET))
    story.append(Paragraph(
        "•  Review of bank, brokerage, or other asset statements (net worth-based verification)",
        BULLET))
    story.append(Paragraph(
        "•  Written confirmation from a FINRA-registered broker-dealer, SEC-registered "
        "investment adviser, licensed attorney, or CPA", BULLET))
    story.append(Paragraph(
        "•  Existing investor certification (for subsequent investments within 90 days)",
        BULLET))

    story.append(spacer(6))
    story.append(P(
        "Note: State-registered investment advisers are not acceptable verifiers under the "
        "Rule 506(c)(2)(ii)(C) safe harbor. Only SEC-registered investment advisers satisfy "
        "the safe-harbor requirement. Verification is valid for 90 days from the date of "
        "verification.", SMALL_NOTE))

    story.append(spacer(10))

    # V. Source of Funds Documentation
    story.append(Paragraph("V. Source of Funds Documentation", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "All investors must provide documentation evidencing the source of funds being invested. "
        "Acceptable documentation includes:"))
    story.append(Paragraph("•  Bank statements showing available funds", BULLET))
    story.append(Paragraph("•  Brokerage account statements", BULLET))
    story.append(Paragraph("•  Documentation of asset sale or inheritance", BULLET))
    story.append(Paragraph("•  Employment income verification", BULLET))

    story.append(spacer(10))

    # VI. Politically Exposed Persons (PEP) Screening
    story.append(Paragraph(
        "VI. Politically Exposed Persons (PEP) Screening", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "All prospective investors will be screened against PEP databases and sanctions lists, "
        "including:"))
    story.append(Paragraph(
        "•  OFAC Specially Designated Nationals (SDN) List", BULLET))
    story.append(Paragraph(
        "•  United Nations Security Council Sanctions List", BULLET))
    story.append(Paragraph("•  European Union sanctions lists", BULLET))
    story.append(Paragraph(
        "•  PEP databases (current and former government officials, family members, and "
        "close associates)", BULLET))

    story.append(spacer(6))
    story.append(P(
        "Enhanced due diligence will be conducted for any investor identified as a PEP, "
        "including additional documentation of source of wealth and senior management approval "
        "before acceptance."))

    story.append(spacer(10))

    # VII. Ongoing Monitoring
    story.append(Paragraph("VII. Ongoing Monitoring", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "The Manager will conduct ongoing monitoring of investor activity and will investigate "
        "any unusual or suspicious transactions. Red flags include:"))
    story.append(Paragraph(
        "•  Unusual or unexplained large transactions", BULLET))
    story.append(Paragraph(
        "•  Transactions inconsistent with the investor's stated financial profile", BULLET))
    story.append(Paragraph(
        "•  Requests for unusual payment methods or third-party transfers", BULLET))
    story.append(Paragraph(
        "•  Reluctance to provide required documentation", BULLET))
    story.append(Paragraph(
        "•  Adverse media or sanctions list matches", BULLET))

    story.append(spacer(10))

    # VIII. Suspicious Activity Reporting
    story.append(Paragraph("VIII. Suspicious Activity Reporting", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "If suspicious activity is identified, the AML Compliance Officer will file a Suspicious "
        "Activity Report (SAR) with the Financial Crimes Enforcement Network (FinCEN) within "
        "30 calendar days. No supervised person may notify the investor that a SAR has been "
        "filed."))

    story.append(spacer(10))

    # IX. Record Retention
    story.append(Paragraph("IX. Record Retention", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "All KYC documentation, CIP records, and AML-related records will be maintained for a "
        "minimum of 5 years from the date the investor's account is closed or the investor's "
        "relationship with the Fund terminates."))

    story.append(spacer(10))

    # X. Training
    story.append(Paragraph("X. Training", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "All supervised persons will receive AML training upon hire and annually thereafter. "
        "Training covers recognition of suspicious activity, reporting obligations, and updates "
        "to AML regulations."))

    story.append(spacer(10))

    # XI. Third-Party Providers
    story.append(Paragraph("XI. Third-Party Providers", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))
    story.append(P(
        "The Manager currently performs KYC procedures manually. As the Fund scales, the Manager "
        "intends to engage a third-party KYC/AML provider for automated identity verification, "
        "sanctions screening, and ongoing monitoring. Any third-party provider will be subject "
        "to due diligence and ongoing oversight by the AML Compliance Officer."))

    # ── Build PDF ─────────────────────────────────────────────────────────────
    doc = make_doc_template(
        OUT_PATH,
        title_meta=f"{FUND} - Anti-Money Laundering & KYC Policy {VERSION}",
        subject="Anti-Money Laundering & KYC Policy",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Anti-Money Laundering & KYC Policy",
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
