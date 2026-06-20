#!/usr/bin/env python3
"""
PNTHR Tree Fund, LP — Compliance Manual & Code of Ethics v1.0
Converted from Carnivore Quant Fund Compliance Manual v1.1.

Changes from Carnivore v1.1:
  - Fund name: "Carnivore Quant Fund, LP" -> "PNTHR Tree Fund, LP"
  - All headers/footers/breadcrumbs updated
  - Version: v1.1 -> v1.0, Date: April 2026 -> May 2026
  - Effective Date: April 2026 -> May 2026
  - Personal trading restriction: "PNTHR 679" -> "PNTHR AI 300"
  - Allocation section: notes Manager operates multiple fund products

Output: ~/Downloads/PNTHR_Tree_Fund_Compliance_Manual_v1.0_2026.pdf
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
    f"~/Downloads/PNTHR_Tree_Fund_Compliance_Manual_{VERSION}_2026.pdf")

# ── Local styles ──────────────────────────────────────────────────────────────
SECTION_TITLE = ParagraphStyle(
    name="section_title", fontName="Helvetica-Bold", fontSize=18, leading=22,
    alignment=TA_LEFT, spaceBefore=16, spaceAfter=6,
)
SUB2_TITLE = ParagraphStyle(
    name="sub2_title", fontName="Helvetica-Oblique", fontSize=12, leading=15,
    alignment=TA_LEFT, spaceBefore=10, spaceAfter=4,
)
BODY_BOLD = ParagraphStyle(
    name="body_bold", fontName="Helvetica-Bold", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=4, spaceAfter=2,
)
BULLET = ParagraphStyle(
    name="bullet", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=2, spaceAfter=2,
    leftIndent=18, firstLineIndent=-14,
)
REPORT_LINE = ParagraphStyle(
    name="report_line", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=1, spaceAfter=1,
    leftIndent=18,
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


def build():
    # ── Cover ─────────────────────────────────────────────────────────────────
    story = build_cover_header(
        title_line_1="Compliance Manual &amp;",
        title_line_2="Code of Ethics",
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
    # I. Introduction & Purpose
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("I. Introduction &amp; Purpose", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "This Compliance Manual establishes the policies, procedures, and ethical standards "
        f'governing the operations of STT Capital Advisors, LLC (the "Manager") and {FUND} '
        f'(the "Fund"). All supervised persons are required to read, understand, and comply '
        "with these policies. The Chief Compliance Officer (CCO) is responsible for "
        "administering and enforcing this manual."
    ))

    story.append(spacer(6))
    story.append(P("<b>Chief Compliance Officer:</b> Scott McBrien, CIO &amp; CCO"))
    story.append(P("<b>CCO Designee / CISO:</b> Cindy Eagar, COO &amp; CISO"))
    story.append(P(f"<b>Effective Date:</b> {DATE_DISP}"))
    story.append(P("<b>Review Frequency:</b> Annually, or upon material regulatory changes"))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # II. Code of Ethics
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("II. Code of Ethics", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(Paragraph("Fiduciary Duty", SUB2_TITLE))
    story.append(P(
        "All supervised persons owe a fiduciary duty to the Fund and its Limited Partners. "
        "This includes the duty of loyalty (placing Fund interests above personal interests) "
        "and the duty of care (acting with the skill, prudence, and diligence of a reasonable "
        "professional under the circumstances)."
    ))

    story.append(spacer(6))
    story.append(Paragraph("Standards of Conduct", SUB2_TITLE))
    story.append(Paragraph(
        "•  Act with integrity, competence, and respect for Fund investors", BULLET))
    story.append(Paragraph(
        "•  Place Fund interests ahead of personal interests", BULLET))
    story.append(Paragraph(
        "•  Maintain independence and objectivity in investment decisions", BULLET))
    story.append(Paragraph(
        "•  Preserve confidentiality of Fund and investor information", BULLET))
    story.append(Paragraph(
        "•  Comply with all applicable securities laws and regulations", BULLET))
    story.append(Paragraph(
        "•  Report any violations or suspected violations to the CCO immediately", BULLET))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # III. Personal Trading Policy
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("III. Personal Trading Policy", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(Paragraph("Pre-Clearance Requirement", SUB2_TITLE))
    story.append(P(
        "All personal securities trades by supervised persons must be pre-cleared by the CCO "
        "before execution. Pre-clearance requests must include the security name, direction "
        "(buy/sell), approximate quantity, and rationale."
    ))

    story.append(spacer(6))
    story.append(Paragraph("Restrictions", SUB2_TITLE))
    story.append(Paragraph(
        "•  7-day minimum holding period for all personal trades", BULLET))
    story.append(Paragraph(
        "•  No trading in Fund universe securities (PNTHR AI 300) in personal accounts", BULLET))
    story.append(Paragraph(
        "•  No front-running: personal trades may not precede anticipated Fund trades", BULLET))
    story.append(Paragraph(
        "•  No short-term trading that conflicts with Fund positions", BULLET))
    story.append(Paragraph(
        "•  All personal brokerage account statements must be provided to the CCO quarterly",
        BULLET))

    story.append(spacer(6))
    story.append(Paragraph("Reporting", SUB2_TITLE))
    story.append(P("All supervised persons must submit:"))
    story.append(Paragraph(
        "Initial Holdings Report: Within 10 days of becoming a supervised person", REPORT_LINE))
    story.append(Paragraph(
        "Annual Holdings Report: Within 45 days of fiscal year end", REPORT_LINE))
    story.append(Paragraph(
        "Quarterly Transaction Report: Within 30 days of quarter end", REPORT_LINE))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # IV. Insider Trading Policy
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("IV. Insider Trading Policy", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Trading on Material Non-Public Information (MNPI) is strictly prohibited. No "
        "supervised person may:"
    ))

    story.append(Paragraph(
        "•  Trade securities while in possession of MNPI", BULLET))
    story.append(Paragraph(
        '•  Communicate MNPI to any person who might trade on it ("tipping")', BULLET))
    story.append(Paragraph(
        "•  Recommend securities transactions based on MNPI", BULLET))

    story.append(spacer(6))
    story.append(P(
        "If any supervised person becomes aware of potential MNPI, they must immediately notify "
        "the CCO and refrain from any related trading until the information is either publicly "
        "disclosed or determined not to be material."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # V. Allocation & Best Execution
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("V. Allocation &amp; Best Execution", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "The Manager operates multiple fund products under the PNTHR FUNDS umbrella. Should "
        "overlapping trade opportunities arise across funds, a formal trade allocation policy "
        "will ensure fair and equitable treatment of all client accounts. Best execution is "
        "pursued through Interactive Brokers' SmartRouting technology."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # VI. Gift & Entertainment Policy
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("VI. Gift &amp; Entertainment Policy", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Supervised persons may not accept gifts or entertainment from any person or entity "
        "doing business with the Fund that exceeds $250 in value per person per year. All gifts "
        "or entertainment received must be reported to the CCO within 5 business days. Gifts "
        "that exceed the threshold must be returned or donated."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # VII. Confidentiality
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("VII. Confidentiality", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "All Fund-related information is confidential, including but not limited to: trading "
        "strategies, positions, investor identities, performance data, and proprietary "
        "algorithms (including the PNTHR Signal System). Disclosure of confidential information "
        "is permitted only with prior written authorization from the General Partner or the "
        "Chief Compliance Officer, or as required by law."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # VIII. Record Retention
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("VIII. Record Retention", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "The Manager will maintain books and records as required by applicable regulations. All "
        "compliance records, including personal trading reports, pre-clearance logs, and policy "
        "acknowledgments, will be retained for a minimum of 5 years."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # IX. Reporting Violations
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("IX. Reporting Violations", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "Any supervised person who becomes aware of a violation or potential violation of this "
        "manual, applicable laws, or Fund policies must report it to the CCO immediately. The "
        "Manager prohibits retaliation against any person who reports a violation in good faith."
    ))

    story.append(spacer(10))

    # ══════════════════════════════════════════════════════════════════════════
    # X. Annual Acknowledgment
    # ══════════════════════════════════════════════════════════════════════════
    story.append(Paragraph("X. Annual Acknowledgment", SECTION_TITLE))
    story.append(yellow_rule())
    story.append(spacer(4))

    story.append(P(
        "All supervised persons must sign an acknowledgment confirming they have read, "
        "understood, and agree to comply with this Compliance Manual and Code of Ethics. "
        "Acknowledgments must be renewed annually."
    ))

    # ── Build PDF ─────────────────────────────────────────────────────────────
    doc = make_doc_template(
        OUT_PATH,
        title_meta=f"{FUND} - Compliance Manual & Code of Ethics {VERSION}",
        subject="Compliance Manual & Code of Ethics",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Compliance Manual & Code of Ethics",
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
