#!/usr/bin/env python3
"""
PNTHR Tree Fund, LP
Subscriber Information Form and Investor Questionnaire v1.0
Effective: June 1, 2026

Baseline: attorney-prepared "3. Rev- Investor Questionnaire - PNTHR FINAL.pdf" (14 pages)
Revisions applied per user-approved Phase 1 edit plan + user approval of all
7 recommendations on 2026-04-19.

v2.2 -> v2.3 change: Fixed misalignment of "C" Corporation / "S" Corporation
sub-checkboxes. Previously they were rendered via nbsp-padding outside the
two-column table, producing visual misalignment. Now they appear as proper
indented sub-rows in the right column of the beneficial-owner table,
directly below "Corporation" and above "Business entity (other)", matching
the attorney baseline layout.

Key revisions (v2.1 -> v2.2):
  - "Member Unit Interest" -> "Limited Partnership Interest" (Fund is LP, not LLC)
  - "Advisor" / "advisory" -> "Adviser" / "adviser" (Advisers Act legal spelling)
  - "Manager" disambiguated to "General Partner" or "Investment Manager"
  - Fax fields dropped (modernization)
  - QP Status qualifier sections dropped in Part II and Part III (Fund is 3(c)(1) only)
  - Part III §2(a)(51)(C) QP consent sub-question (c) RESTORED per HANDOFF
  - NEW AI categories for natural persons: 501(a)(4) Director/Officer of Issuer,
    501(a)(10) Knowledgeable Employee of Private Fund, 501(a)(13) Spousal Equivalent
  - NEW Rule 506(c) Verification Acknowledgement (end of Part I)
  - NEW OFAC/PEP/AML Self-Certification block (Part I)
  - NEW FATCA/CRS Self-Certification block (Part I)
  - NEW IRA routing note (Part II IRA section)
  - QC language for natural persons rewritten to match Rule 205-3(d)(1)(iii) precisely
  - Checkbox rendering: U+2610 BALLOT BOX via registered Arial Unicode MS font
    (matches Sub Agmt v2.3 approach, renders as clean open/unfilled boxes)
  - Legal name: "PNTHR Funds, LLC" / "PNTHR FUNDS, LLC" per DE SoS Certificate

PHASE 1 - LEGAL CONTENT ONLY. No PNTHR branding/design.

Output: PNTHR_Tree_Fund_InvQuest_v1.0_2026.pdf
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (
    Paragraph, Spacer, PageBreak, Table, TableStyle, KeepTogether,
)
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

from pnthr_design import (
    make_doc_template, make_page_handlers, build_cover_header,
)

OUT_PATH = os.path.expanduser("~/Downloads/PNTHR_Tree_Fund_InvQuest_v1.0_2026.pdf")

# Register Unicode-capable TrueType font for open checkbox rendering.
_CHECKBOX_FONT = None
for _candidate_path in [
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "C:/Windows/Fonts/arial.ttf",
]:
    if os.path.exists(_candidate_path):
        try:
            pdfmetrics.registerFont(TTFont("UnicodeBox", _candidate_path))
            _CHECKBOX_FONT = "UnicodeBox"
            break
        except Exception:
            continue

if _CHECKBOX_FONT:
    BOX = f'<font name="{_CHECKBOX_FONT}" size="13">&#9744;</font>'  # U+2610
else:
    BOX = "[&nbsp;&nbsp;&nbsp;]"

# ----- Styles -----------------------------------------------------------
TITLE_STYLE = ParagraphStyle(
    name="title", fontName="Helvetica-Bold", fontSize=13, leading=17,
    alignment=TA_CENTER, spaceBefore=0, spaceAfter=8,
)
SUBTITLE_STYLE = ParagraphStyle(
    name="subtitle", fontName="Helvetica-Oblique", fontSize=12, leading=15,
    alignment=TA_CENTER, spaceBefore=0, spaceAfter=6,
)
PART_HDR = ParagraphStyle(
    name="part_hdr", fontName="Helvetica-Bold", fontSize=12, leading=15,
    alignment=TA_CENTER, spaceBefore=14, spaceAfter=6,
)
SECTION_HDR = ParagraphStyle(
    name="section_hdr", fontName="Helvetica-Bold", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=12, spaceAfter=4,
)
SECTION_HDR_UL = ParagraphStyle(
    name="section_hdr_ul", fontName="Helvetica-Bold", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=12, spaceAfter=4,
)
BODY = ParagraphStyle(
    name="body", fontName="Helvetica", fontSize=10.5, leading=13.5,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=6,
)
BODY_LEFT = ParagraphStyle(
    name="body_left", fontName="Helvetica", fontSize=10.5, leading=13.5,
    alignment=TA_LEFT, spaceBefore=0, spaceAfter=6,
)
BODY_ITAL = ParagraphStyle(
    name="body_ital", fontName="Helvetica-Oblique", fontSize=10.5, leading=13.5,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=6,
)
CHECKBOX_ROW = ParagraphStyle(
    name="checkbox_row", fontName="Helvetica", fontSize=10.5, leading=15,
    alignment=TA_LEFT, spaceBefore=0, spaceAfter=3, leftIndent=18,
)
SUB_CHECKBOX = ParagraphStyle(
    name="sub_checkbox", fontName="Helvetica", fontSize=10.5, leading=15,
    alignment=TA_LEFT, spaceBefore=0, spaceAfter=3, leftIndent=48,
)
LABELED_QUESTION = ParagraphStyle(
    name="labeled_question", fontName="Helvetica", fontSize=10.5, leading=14,
    alignment=TA_JUSTIFY, spaceBefore=4, spaceAfter=4, leftIndent=18,
)
RED_ALERT = ParagraphStyle(
    name="red_alert", fontName="Helvetica", fontSize=10.5, leading=14,
    alignment=TA_LEFT, spaceBefore=0, spaceAfter=6, textColor=colors.red,
)

# ----- Header / Footer are provided by pnthr_design.make_page_handlers ------

# ----- Helpers ----------------------------------------------------------
def P(text, style=BODY):
    return Paragraph(text, style)

def spacer(h=8):
    return Spacer(1, h)

def cb(label, style=CHECKBOX_ROW):
    """Single checkbox + label on one line."""
    return P(f"{BOX}&nbsp;&nbsp;{label}", style)

def part_banner(label):
    """Shaded gray banner like PART I / PART II / PART III."""
    tbl = Table([[P(f"<b>{label}</b>", PART_HDR)]], colWidths=[6.5 * inch])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.Color(0.88, 0.88, 0.88)),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.black),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return tbl

def subscriber_qual_banner():
    tbl = Table([[P("<b>SUBSCRIBER QUALIFICATION</b>", PART_HDR)]], colWidths=[6.5 * inch])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.Color(0.88, 0.88, 0.88)),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.black),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return tbl

def ai_qc_banner(label):
    tbl = Table([[P(f"<b>{label}</b>", PART_HDR)]], colWidths=[6.5 * inch])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.Color(0.88, 0.88, 0.88)),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.black),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return tbl

def labeled_field_row(label, width_label=1.8, width_value=4.6):
    """Single row: label in left column, blank fill area in right column."""
    tbl = Table(
        [[P(label, BODY_LEFT), ""]],
        colWidths=[width_label * inch, width_value * inch],
    )
    tbl.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.5, colors.black),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.black),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return tbl

def yes_no_row(question_text):
    """Question line + Yes/No checkboxes."""
    return [
        P(question_text, BODY_LEFT),
        P(f"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
          f"{BOX}&nbsp;&nbsp;Yes&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
          f"{BOX}&nbsp;&nbsp;No", BODY_LEFT),
        spacer(4),
    ]


# =========================================================================
# TITLE / INTRODUCTION
# =========================================================================
def build_title():
    # v2.4 design pass: the original title + subtitle + dated-line move to the
    # black cover page (via pnthr_design.build_cover_header). The red alert
    # paragraph "THIS SUBSCRIBER INFORMATION FORM..." is preserved verbatim
    # and appears on content page 2 immediately before Part I, per original v2.3.
    story = build_cover_header(
        title_line_1="",
        title_line_2="PNTHR TREE FUND, LP",
        subtitle="Subscriber Information Form & Investor Questionnaire",
        date_line="Dated as of:  June 1, 2026",
        revision_line="Document Revision:  v1.0 - June 2026",
        issuer_line="Issuer:  PNTHR Funds, LLC (General Partner)",
        confidential_title=None,
        confidential_body=None,
    )

    story.append(P(
        "<b>THIS SUBSCRIBER INFORMATION FORM AND INVESTOR QUESTIONNAIRE IS "
        "DIVIDED INTO THREE PARTS. ALL SUBSCRIBERS ARE REQUIRED TO COMPLETE "
        "PART I. SUBSCRIBERS WHO ARE NATURAL PERSONS, INDIVIDUAL RETIREMENT "
        "ACCOUNTS, OR GRANTOR TRUSTS MUST COMPLETE PART II. ALL OTHER "
        "SUBSCRIBERS (ENTITIES AND NON-GRANTOR TRUSTS) MUST COMPLETE PART "
        "III.</b>",
        RED_ALERT))
    return story


# =========================================================================
# PART I - SUBSCRIBER INFORMATION
# =========================================================================
def build_part_i():
    story = []
    story.append(part_banner("PART I &nbsp;&nbsp; SUBSCRIBER INFORMATION"))
    story.append(spacer(4))
    story.append(part_banner("TO BE COMPLETED BY ALL SUBSCRIBERS"))
    story.append(spacer(10))

    # ----- Identity of Subscriber -----
    story.append(P("<b>Identity of Subscriber</b>", SECTION_HDR_UL))
    identity_rows = [
        "Name(s):",
        "Address:",
        "(continued)",
        "(continued)",
        "Date of Birth:",
        "Country of Birth:",
        "If entity, Date of Formation:",
        "If entity, Country of Formation:",
        "E-mail:",
        "Tax ID Number / SSN:",
        "Jurisdiction under the laws of which State the Subscriber is organized "
        "and existing:",
    ]
    identity_data = [[P(lbl, BODY_LEFT), ""] for lbl in identity_rows]
    tbl = Table(identity_data, colWidths=[2.4 * inch, 4.0 * inch])
    tbl.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.75, colors.black),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.black),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(tbl)
    story.append(spacer(10))

    # ----- Beneficial Owner Type Checkboxes -----
    story.append(P(
        "<b>Please check all of the boxes that describe the beneficial "
        "owner(s) for whose account the Limited Partnership Interest is "
        "being acquired:</b>",
        BODY))
    story.append(spacer(4))

    # Build two-column layout. Right column has an extra pair of sub-rows
    # directly under "Corporation" for the C / S sub-options (matches the
    # attorney baseline layout), with matching empty cells in the left column.
    def _cb(label):
        return P(f"{BOX}&nbsp;&nbsp;{label}", BODY_LEFT)

    def _sub_cb(label):
        # Sub-checkbox indented under "Corporation" in the right column.
        return P(f"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{BOX}&nbsp;&nbsp;{label}",
                 BODY_LEFT)

    cb_data = [
        [_cb("Individual"),
         _cb("Tax-exempt endowment")],
        [_cb("Joint (spouses)"),
         _cb("Other tax-exempt organization")],
        [_cb("Joint (other)"),
         _cb("Employee benefit plan (self-directed)")],
        [_cb("Personal trust (taxable to grantor)"),
         _cb("Employee benefit plan (trustee-directed)")],
        [_cb("Personal trust (other)"),
         _cb("Fund of funds")],
        [_cb("Individual retirement account"),
         _cb("Family partnership, partnership, or LLC")],
        [_cb("Charitable trust"),
         _cb("Corporation")],
        [_cb("Private tax-exempt foundation"),
         _sub_cb("&ldquo;C&rdquo; Corporation")],
        ["",
         _sub_cb("&ldquo;S&rdquo; Corporation")],
        ["",
         _cb("Business entity (other)")],
    ]
    cb_tbl = Table(cb_data, colWidths=[3.1 * inch, 3.4 * inch])
    cb_tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    story.append(cb_tbl)
    story.append(spacer(12))

    # ----- Authorization and Contact Information -----
    story.append(P("<b>Authorization and Contact Information</b>", SECTION_HDR_UL))
    story.append(P(
        "<i>Authorized Persons:</i> Please provide the titles and names of "
        "the individuals who are authorized to give orders and instructions "
        "with respect to the investment.",
        BODY))
    for label in ["Name:", "Title:", "Mailing Address:", "(continued)", "Telephone:", "E-mail:"]:
        story.append(labeled_field_row(label))
    story.append(spacer(8))

    story.append(P(
        "<i>Primary Contact</i> for Notices, Communications and Capital "
        "Account Transaction Confirmations.",
        BODY))
    for label in ["Name:", "Mailing Address:", "(continued)", "Telephone:", "E-mail:"]:
        story.append(labeled_field_row(label))
    story.append(spacer(8))

    story.append(P(
        "<i>Secondary Contact</i> for Notices and Communications (optional).",
        BODY))
    for label in ["Name:", "Mailing Address:", "(continued)", "Telephone:", "E-mail:"]:
        story.append(labeled_field_row(label))
    story.append(spacer(8))

    story.append(P(
        "<i>Send copy of Financial Statements and Tax Information Returns "
        "to</i> (optional).",
        BODY))
    for label in ["Name:", "Mailing Address:", "(continued)", "Telephone:", "E-mail:"]:
        story.append(labeled_field_row(label))
    story.append(spacer(10))

    # ----- Remitting Bank -----
    story.append(P("<b>Remitting Bank or Financial Institution</b>", SECTION_HDR_UL))
    story.append(P(
        "If you are wiring funds, please identify the bank or other "
        "financial institution (the &ldquo;<b>Wiring Institution</b>&rdquo;) "
        "from which the Subscriber&rsquo;s funds will be wired. Please note "
        "that any amounts paid to the Subscriber will be paid to the same "
        "account from which its subscription funds were originally remitted, "
        "unless the General Partner agrees otherwise.",
        BODY))
    for label in ["Name of Wiring Institution:", "Address:", "(continued)",
                  "Account Representative:", "Telephone:"]:
        story.append(labeled_field_row(label))
    story.extend(yes_no_row(
        "Is the Subscriber a customer of the Wiring Institution?"))
    story.append(P(
        "<b>If you responded &ldquo;No,&rdquo; please contact the General "
        "Partner for additional information that may be required.</b>",
        BODY))
    story.append(spacer(10))

    # ----- Distribution Bank -----
    story.append(P("<b>Bank or Financial Institution for Distributions and "
                   "Withdrawals</b>", SECTION_HDR_UL))
    for label in [
        "Name of Wiring Institution:",
        "SWIFT or ABA#:",
        "Name on Subscriber&rsquo;s Account:",
        "Subscriber&rsquo;s Account #:",
        "Further Credit Instructions:",
        "Address:",
        "(continued)",
        "Account Representative:",
        "Telephone:",
    ]:
        story.append(labeled_field_row(label))
    story.append(spacer(6))

    story.append(P("<b>Wiring Instructions of Record.</b>", SECTION_HDR_UL))
    story.append(P(
        "Please note that redemption payments, in accordance with both the "
        "current anti-money-laundering regulatory environment and industry "
        "best practice, will be paid only to the bank account used for the "
        "subscription payment which should be noted above and certified as "
        "the bank account of record for the Subscriber. The titling of the "
        "bank account must match the titling of this subscription. If not, "
        "the Registrar and Transfer Agent and the General Partner must be "
        "notified now regarding the discrepancy and its reason. The "
        "Registrar and Transfer Agent and/or the General Partner may reject "
        "any subscription at any time where payment is sourced from a "
        "different bank account than the bank account of record or a bank "
        "account with different titling than the subscription.",
        BODY))
    story.append(spacer(8))

    # ----- Electronic Delivery Consent -----
    story.append(P("<b>Electronic Delivery of Reports and Other "
                   "Communications</b>", SECTION_HDR_UL))
    story.append(P(
        "With your consent, the Fund may make reports and other "
        "communications, including Schedule K-1s, available in an "
        "electronic format, such as by email or by posting on a secure "
        "website (with notification of the posting by email). Any email "
        "notification regarding posting on a website will indicate "
        "instructions for accessing the website and the duration for which "
        "the materials will remain available. You will need an email "
        "service, a web browser, a PDF document viewer and internet "
        "connection to access your electronically delivered Schedule K-1.",
        BODY))
    story.extend(yes_no_row(
        "Subject to the additional required disclosure below, do you "
        "consent to receive deliveries of reports and other communications, "
        "including Schedule K-1s, from the Fund (including annual and "
        "other updates of our consumer privacy policies and procedures) "
        "exclusively in electronic form without separate mailing of paper "
        "copies?"))
    story.append(P(
        "<b>Required Disclosure for Electronic Distribution of Schedule K-1:</b> "
        "The Schedule K-1 will be furnished on paper if you do not consent "
        "to receive it electronically. If you do so elect, your above "
        "consent will apply to each Schedule K-1 required to be furnished "
        "after your consent is given until it is withdrawn. You may still "
        "request a paper copy of your Schedule K-1 by contacting the "
        "General Partner. Requesting a paper copy will not constitute a "
        "withdrawal of your consent to receive reports or other "
        "communications, including Schedule K-1, electronically. You may "
        "withdraw your consent for electronic delivery or change your "
        "contact preferences for such delivery by writing to the General "
        "Partner at any time either at the email address above or at the "
        "mailing address indicated in the Subscription Instructions "
        "hereto. Such withdrawal will take effect immediately, unless "
        "otherwise agreed upon. Upon receipt of a withdrawal request, the "
        "Fund will confirm the withdrawal and the date on which it takes "
        "effect in writing (either electronically or on paper). A "
        "withdrawal of consent does not apply to a statement that was "
        "furnished electronically before the date on which the withdrawal "
        "of consent takes effect. The Fund will cease providing information "
        "electronically upon termination of the Fund or your withdrawal "
        "from the Fund. Notwithstanding your consent to receive materials "
        "electronically, you still may be required to print and attach "
        "your Schedule K-1 to a federal, state or local tax return.",
        BODY))
    story.append(spacer(8))

    # ----- Actual Ownership -----
    story.append(P("<b>Information Regarding Actual Ownership of the Limited "
                   "Partnership Interest</b>", SECTION_HDR_UL))
    story.extend(yes_no_row(
        "Is the Subscriber subscribing for a Limited Partnership Interest "
        "in the Fund with the intent to sell, distribute or transfer the "
        "Limited Partnership Interest to any other person or persons?"))
    story.extend(yes_no_row(
        "Is the Subscriber subscribing for a Limited Partnership Interest "
        "as agent, nominee, trustee, partner or otherwise on behalf of, "
        "for the account of or jointly with any other person or entity?"))
    story.extend(yes_no_row(
        "Will any other person or persons have a beneficial interest in "
        "the Limited Partnership Interest acquired (other than as a "
        "shareholder, partner or other beneficial owner of equity "
        "interests in the Subscriber)?"))
    story.extend(yes_no_row(
        "Does the Subscriber control, or is the Subscriber controlled by "
        "or under common control with, any existing or prospective "
        "investor in the Fund?"))
    story.append(P(
        "<b>Note:</b> If any of the above questions were answered "
        "&ldquo;Yes,&rdquo; please provide identifying information or "
        "contact the General Partner:",
        BODY))
    story.append(labeled_field_row(" ", width_label=0.3, width_value=6.2))
    story.append(spacer(8))

    # ----- Private Investment Fund Experience -----
    story.append(P("<b>Private Investment Fund Experience</b>", SECTION_HDR_UL))
    story.extend(yes_no_row(
        "Has the Subscriber previously made an investment in a private "
        "investment fund in which the investment adviser is entitled to "
        "compensation based on the fund&rsquo;s investment performance?"))
    story.append(spacer(6))

    # ----- Net Worth (screen) -----
    story.append(P("<b>Net Worth</b>", SECTION_HDR_UL))
    story.extend(yes_no_row(
        "Is the Subscriber&rsquo;s net worth more than 10 times the amount "
        "of the Capital Commitment?"))
    story.append(spacer(6))

    # ----- Qualified Client (screen) -----
    story.append(P("<b>Qualified Client (Screening)</b>", SECTION_HDR_UL))
    story.append(P(
        "The Subscriber (or the grantor, in the case of a grantor trust) "
        "is a natural person or an entity who, at the time of subscription, "
        "either (a) has a net worth (together, in the case of a natural "
        "person, with assets held jointly with that person&rsquo;s spouse, "
        "but excluding the value of the Subscriber&rsquo;s primary "
        "residence) in excess of $2,200,000, or (b) has no less than "
        "$1,100,000 in aggregate under management in the Fund or other "
        "investment funds managed by the Investment Manager.",
        BODY))
    story.extend(yes_no_row("Does the Subscriber satisfy one of the above tests?"))
    story.append(spacer(10))

    # ----- NEW: Rule 506(c) Verification Acknowledgement -----
    story.append(P("<b>Rule 506(c) Verification Acknowledgement</b>",
                   SECTION_HDR_UL))
    story.append(P(
        "The Subscriber acknowledges that (i) the Fund is conducting its "
        "offering in reliance on Rule 506(c) under Regulation D under the "
        "Securities Act of 1933, as amended (the &ldquo;<b>Securities "
        "Act</b>&rdquo;); (ii) the Subscriber&rsquo;s accredited-investor "
        "status must be verified by an acceptable third-party verifier "
        "pursuant to Rule 506(c)(2)(ii) (a FINRA-registered broker-dealer, "
        "an SEC-registered investment adviser, a licensed attorney in "
        "good standing, or a certified public accountant in good "
        "standing); (iii) state-registered investment advisers are NOT "
        "acceptable verifiers under Rule 506(c)(2)(ii)(C); (iv) "
        "self-certification is not sufficient; and (v) verification "
        "documentation must be dated within 90 days prior to the "
        "Subscriber&rsquo;s admission to the Fund.",
        BODY))
    story.extend(yes_no_row(
        "The Subscriber acknowledges and agrees to the foregoing Rule "
        "506(c) verification requirement."))
    story.append(spacer(8))

    # ----- NEW: OFAC / PEP / AML Self-Certification -----
    story.append(P("<b>OFAC / PEP / Anti-Money-Laundering Self-Certification</b>",
                   SECTION_HDR_UL))
    story.append(P(
        "The Subscriber self-certifies the following (please answer each "
        "question):",
        BODY))
    story.extend(yes_no_row(
        "Is the Subscriber, any beneficial owner of the Subscriber, or "
        "any authorized person of the Subscriber a &ldquo;Politically "
        "Exposed Person&rdquo; (as defined in the Subscription Agreement) "
        "or a Family Member or Close Associate of a Politically Exposed "
        "Person?"))
    story.extend(yes_no_row(
        "Is the Subscriber, any beneficial owner, or any authorized person "
        "named on any list of sanctioned entities or individuals "
        "maintained by the U.S. Treasury Department&rsquo;s Office of "
        "Foreign Assets Control (OFAC), or pursuant to European Union "
        "or United Kingdom sanctions regulations, or operationally based "
        "or domiciled in a country or territory subject to United "
        "Nations, OFAC, EU, or UK sanctions?"))
    story.extend(yes_no_row(
        "Are the Subscriber&rsquo;s subscription funds originating from "
        "an account at, or routed through, a Foreign Shell Bank, an "
        "&ldquo;offshore bank,&rdquo; or a bank organized or chartered "
        "under the laws of a jurisdiction designated as non-cooperative "
        "by the Financial Action Task Force on Money Laundering (FATF)?"))
    story.extend(yes_no_row(
        "Is the Subscriber, any beneficial owner, or any Related Person "
        "a &ldquo;Senior Foreign Political Figure&rdquo; (as defined in "
        "the Subscription Agreement), a member of a Senior Foreign "
        "Political Figure&rsquo;s Immediate Family, or a Close Associate "
        "of a Senior Foreign Political Figure?"))
    story.append(P(
        "<b>If any of the above was answered &ldquo;Yes,&rdquo; please "
        "attach additional information or contact the General Partner "
        "directly for enhanced due diligence.</b>",
        BODY))
    story.append(spacer(8))

    # ----- NEW: FATCA / CRS Self-Certification -----
    story.append(P("<b>FATCA / CRS Self-Certification</b>", SECTION_HDR_UL))
    story.append(P(
        "The Subscriber is required to provide an IRS Form W-9 (U.S. "
        "persons) or the applicable Form W-8 (non-U.S. persons) as part "
        "of the subscription package. In addition, for compliance with "
        "the OECD Common Reporting Standard (CRS), please provide the "
        "following:",
        BODY))
    for label in [
        "Country(ies) of tax residence:",
        "Foreign Tax Identification Number(s), if non-U.S.:",
        "CRS classification (Reportable Person / Active NFE / Passive "
        "NFE / Financial Institution):",
    ]:
        story.append(labeled_field_row(label, width_label=2.6, width_value=3.8))
    story.append(spacer(6))

    story.append(P("<b>[End of Part I]</b>", SUBTITLE_STYLE))
    story.append(PageBreak())
    return story


# =========================================================================
# PART II - NATURAL PERSONS / IRA / GRANTOR TRUSTS
# =========================================================================
def build_part_ii():
    story = []
    story.append(part_banner(
        "PART II &nbsp;&nbsp; ADDITIONAL QUESTIONS FOR NATURAL PERSONS, "
        "IRA INVESTORS, OR GRANTOR TRUSTS"))
    story.append(spacer(8))

    # Ownership type
    story.append(P("<b>Please indicate desired type of ownership interest:</b>",
                   SECTION_HDR_UL))
    ownership_tbl = Table([
        [P(f"{BOX}&nbsp;&nbsp;Individual", BODY_LEFT),
         P(f"{BOX}&nbsp;&nbsp;Individual Retirement Account", BODY_LEFT)],
        [P(f"{BOX}&nbsp;&nbsp;Joint", BODY_LEFT),
         P(f"{BOX}&nbsp;&nbsp;Grantor Trust", BODY_LEFT)],
    ], colWidths=[3.1 * inch, 3.4 * inch])
    ownership_tbl.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.5, colors.black),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.black),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(ownership_tbl)
    story.append(spacer(10))

    # For natural persons
    story.append(P("<b>For natural persons:</b>", SECTION_HDR_UL))
    for label in [
        "Source of the money/wealth/income used for this investment:",
        "Occupation of the Investor:",
        "Purpose of the Investment:",
        "Expected frequency of transactions:",
        "Date of Birth:",
        "Country of Birth:",
        "Country of Citizenship:",
    ]:
        story.append(labeled_field_row(label, width_label=2.8, width_value=3.6))
    story.append(spacer(6))

    # State of Residence
    story.append(P("<b>State of Residence</b>", SECTION_HDR_UL))
    story.append(labeled_field_row(
        "Indicate the state where the Subscriber has his or her principal "
        "residence:", width_label=3.5, width_value=2.9))
    story.append(P(
        "<b>Note:</b> If you are married and live in a community property "
        "state, both you and your spouse must sign the Signature Page of "
        "the Subscription Agreement. Community property states are Arizona, "
        "California, Idaho, Louisiana, Nevada, New Mexico, Puerto Rico, "
        "Texas, Washington, and Wisconsin.",
        BODY))
    story.append(spacer(6))

    # Tax Information
    story.append(P("<b>Tax Information</b>", SECTION_HDR_UL))
    story.extend(yes_no_row(
        "Is the Subscriber or trust grantor a United States citizen or "
        "permanent resident of the United States?"))
    story.append(labeled_field_row("Social Security Number:", width_label=2.0,
                                    width_value=4.4))
    story.append(spacer(6))

    # Joint Subscriptions
    story.append(P("<b>Joint Subscriptions</b>", SECTION_HDR_UL))
    story.append(P(
        "If you are subscribing with another person, please answer the "
        "following questions:",
        BODY))
    story.append(P("<b>Please indicate type of ownership interest:</b>", BODY))
    joint_tbl = Table([
        [P(f"{BOX}&nbsp;&nbsp;Joint Tenants (rights of survivorship)", BODY_LEFT)],
        [P(f"{BOX}&nbsp;&nbsp;Tenants in Common (no rights of survivorship)", BODY_LEFT)],
    ], colWidths=[6.5 * inch])
    joint_tbl.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.5, colors.black),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.black),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(joint_tbl)
    story.append(spacer(6))

    story.append(P(
        "If you are purchasing a Limited Partnership Interest with your "
        "spouse:",
        BODY))
    story.extend(yes_no_row(
        "(i) &nbsp;Is your spouse a United States citizen or permanent "
        "resident of the United States?"))
    story.append(labeled_field_row("(ii) Please provide your spouse&rsquo;s "
                                    "U.S. Social Security number:",
                                    width_label=3.8, width_value=2.6))
    story.append(spacer(8))

    # Individual Retirement Account Investors
    story.append(P("<b>Individual Retirement Account Investors</b>", SECTION_HDR_UL))
    story.extend(yes_no_row(
        "(a) If the Subscriber is subscribing as a trustee or custodian "
        "for an individual retirement account, is the Subscriber a "
        "qualified IRA custodian or trustee?"))
    story.append(labeled_field_row("Name of qualified IRA trustee or "
                                    "custodian:", width_label=2.9, width_value=3.5))
    story.append(labeled_field_row("Address of trustee or custodian:",
                                    width_label=2.9, width_value=3.5))
    story.append(spacer(4))
    # IRA routing note (NEW)
    story.append(P(
        "<b>IRA Subscription Routing Note.</b>&nbsp;&nbsp;If the "
        "Subscriber is subscribing through an IRA, the Capital Commitment "
        "must be funded by wire transfer directly from the qualified IRA "
        "custodian to the Fund&rsquo;s designated bank account. Personal "
        "checks or wires from accounts other than the IRA custodian will "
        "not be accepted. The Subscriber is responsible for confirming "
        "that the IRA custodian is willing to hold limited partnership "
        "Interests as IRA assets and that such holding does not give rise "
        "to prohibited-transaction concerns under Code &sect;4975 or "
        "unrelated business taxable income concerns with respect to the "
        "Subscriber&rsquo;s particular IRA.",
        BODY))
    story.append(spacer(10))

    # Subscriber Qualification banner
    story.append(subscriber_qual_banner())
    story.append(P(
        "Subscriptions will be accepted only from persons who qualify as "
        "eligible investors within the meaning of applicable federal and "
        "state securities regulations. Unless otherwise indicated, "
        "responses should be given by reference to the specific person "
        "for whose account the Limited Partnership Interest is being "
        "acquired. The Subscriber may be required to provide such further "
        "information and execute and deliver such documents as the "
        "General Partner may reasonably request to verify that the "
        "Subscriber qualifies as an eligible investor.",
        BODY))
    story.append(spacer(8))

    # ACCREDITED INVESTOR STATUS - Natural Persons
    story.append(ai_qc_banner("ACCREDITED INVESTOR STATUS (NATURAL PERSONS)"))
    story.append(P(
        "Each Subscriber must indicate whether the intended beneficial "
        "owner of the Limited Partnership Interest qualifies as an "
        "&ldquo;accredited investor&rdquo; pursuant to at least one of "
        "the following tests under Rule 501(a) of Regulation D. (Please "
        "check all that apply, or, if none applies, consult the General "
        "Partner.)",
        BODY))

    ai_np = [
        ("<b>Rule 501(a)(5).</b>&nbsp;&nbsp;The Subscriber is a natural "
         "person whose individual net worth, or joint net worth with that "
         "person&rsquo;s spouse or spousal equivalent, exceeds $1,000,000 "
         "at the time of purchase, excluding the value of the primary "
         "residence of such natural person, calculated by subtracting "
         "from the estimated fair market value of the property the amount "
         "of debt secured by the property, up to the estimated fair "
         "market value of the property."),
        ("<b>Rule 501(a)(6).</b>&nbsp;&nbsp;The Subscriber is a natural "
         "person with individual income (without including any income of "
         "the Subscriber&rsquo;s spouse or spousal equivalent) in excess "
         "of $200,000 or joint income with that person&rsquo;s spouse or "
         "spousal equivalent of $300,000 in each of the two most recent "
         "years and who reasonably expects to reach the same income level "
         "in the current year."),
        ("<b>Rule 501(a)(9).</b>&nbsp;&nbsp;The Subscriber is a natural "
         "person holding a professional certification in good standing of "
         "the Series 7, Series 65, or Series 82 licenses."),
        ("<b>Rule 501(a)(4) (NEW).</b>&nbsp;&nbsp;The Subscriber is a "
         "director, executive officer, or general partner of the issuer "
         "of the securities being offered or sold (i.e., "
         "PNTHR Tree Fund, LP or PNTHR Funds, LLC), or a director, "
         "executive officer, or general partner of a general partner of "
         "that issuer."),
        ("<b>Rule 501(a)(10) (NEW).</b>&nbsp;&nbsp;The Subscriber is a "
         "&ldquo;knowledgeable employee,&rdquo; as defined in Rule "
         "3c-5(a)(4) under the Investment Company Act of 1940, of the "
         "Fund or of an affiliated management entity of the Fund."),
        ("<b>Rule 501(a)(13) (NEW).</b>&nbsp;&nbsp;The Subscriber is "
         "the spousal equivalent of a natural person who qualifies as an "
         "accredited investor under any of the categories above, and the "
         "natural person and spousal equivalent are jointly subscribing "
         "for a Limited Partnership Interest."),
    ]
    for text in ai_np:
        story.append(P(f"{BOX}&nbsp;&nbsp;{text}", SUB_CHECKBOX))
    story.append(spacer(10))

    # QUALIFIED CLIENT INVESTOR STATUS - Natural Persons (Rule 205-3)
    story.append(ai_qc_banner("QUALIFIED CLIENT STATUS (NATURAL PERSONS)"))
    story.append(P(
        "Each Subscriber must also indicate whether the intended "
        "beneficial owner of the Limited Partnership Interest qualifies "
        "as a &ldquo;qualified client&rdquo; pursuant to at least one of "
        "the following tests under Rule 205-3 under the Investment "
        "Advisers Act of 1940, as amended (the &ldquo;<b>Advisers "
        "Act</b>&rdquo;). (Please check all that apply, or, if none "
        "applies, consult the General Partner.)",
        BODY))

    qc_np = [
        ("<b>Rule 205-3(d)(1)(i) &mdash; Net Worth.</b>&nbsp;&nbsp;The "
         "Subscriber is a natural person whose individual net worth, or "
         "joint net worth with that person&rsquo;s spouse or spousal "
         "equivalent, exceeds $2,200,000 at the time of the investment "
         "management contract, excluding the value of the "
         "Subscriber&rsquo;s primary residence, calculated by subtracting "
         "from the estimated fair market value of the property the amount "
         "of debt secured by the property, up to the estimated fair "
         "market value of the property. Joint net worth with a spouse or "
         "spousal equivalent may be included, but the primary "
         "residence&rsquo;s value must be excluded.").replace("&mdash;", "-"),
        ("<b>Rule 205-3(d)(1)(ii) - Assets Under Management.</b>&nbsp;&nbsp;"
         "The Subscriber has at least $1,100,000 in assets under "
         "management with the Investment Manager immediately after "
         "entering into the investment advisory relationship with the "
         "Investment Manager."),
        ("<b>Rule 205-3(d)(1)(iii) - Knowledgeable Employee or Principal."
         "</b>&nbsp;&nbsp;The Subscriber is (A) an executive officer, "
         "director, trustee, general partner, or person serving in a "
         "similar capacity, of the Investment Manager; or (B) an employee "
         "of the Investment Manager (other than an employee performing "
         "solely clerical, secretarial, or administrative functions with "
         "regard to such person) who, in connection with his or her "
         "regular functions or duties, participates in the investment "
         "activities of the Investment Manager, and has been performing "
         "such functions and duties for or on behalf of the Investment "
         "Manager, or substantially similar functions or duties for or "
         "on behalf of another company, for at least 12 months."),
    ]
    for text in qc_np:
        story.append(P(f"{BOX}&nbsp;&nbsp;{text}", SUB_CHECKBOX))
    story.append(spacer(8))

    story.append(P("<b>[End of Part II]</b>", SUBTITLE_STYLE))
    story.append(PageBreak())
    return story


# =========================================================================
# PART III - ENTITIES AND NON-GRANTOR TRUSTS
# =========================================================================
def build_part_iii():
    story = []
    story.append(part_banner(
        "PART III &nbsp;&nbsp; ADDITIONAL QUESTIONS FOR ENTITIES AND "
        "NON-GRANTOR TRUSTS"))
    story.append(spacer(8))

    # Organizational Data
    story.append(P("<b>Organizational Data</b>", SECTION_HDR_UL))
    for lbl in [
        "(a) &nbsp;Legal form of entity:",
        "(b) &nbsp;Jurisdiction of organization:",
        "(c) &nbsp;Date of organization:",
        "(d) &nbsp;Briefly identify the Subscriber&rsquo;s primary business:",
        "(e) &nbsp;Source of the money/wealth/income used for this investment:",
        "(f) &nbsp;Purpose of investment:",
        "(g) &nbsp;Expected frequency of transactions:",
        "(h) &nbsp;Total number of shareholders, partners, or other holders "
        "of equity or beneficial interests or other securities of the "
        "Subscriber (if more than 100, respond &ldquo;more than 100&rdquo;):",
    ]:
        story.append(labeled_field_row(lbl, width_label=3.6, width_value=2.8))
    story.append(spacer(4))

    story.extend(yes_no_row(
        "(i) Is the Subscriber a wholly-owned or majority-owned subsidiary "
        "of another entity?"))
    story.extend(yes_no_row(
        "(j) Is the direct parent of the Subscriber a wholly-owned or "
        "majority-owned subsidiary of another entity?"))
    story.extend(yes_no_row(
        "(k) Was the Subscriber organized for the specific purpose of "
        "acquiring a Limited Partnership Interest?"))
    story.extend(yes_no_row(
        "(l) Is the Subscriber an entity engaged primarily in investing "
        "or trading securities?"))
    story.append(P(
        "<b>If the answer to (l) is &ldquo;Yes,&rdquo; please answer the "
        "following questions. If the answer is &ldquo;No,&rdquo; skip to "
        "the Benefit Plan Accounts section below.</b>",
        BODY))
    story.extend(yes_no_row(
        "(1) Have shareholders, partners, or other holders of equity or "
        "beneficial interests in the Subscriber been provided the "
        "opportunity to decide individually whether or not to "
        "participate, or the extent of their participation, in the "
        "Subscriber&rsquo;s investment in the Fund (i.e., have investors "
        "in the Subscriber been permitted to determine whether their "
        "capital will form part of the specific capital invested by the "
        "Subscriber in the Fund)?"))
    story.extend(yes_no_row(
        "(2) Does the amount of the Subscriber&rsquo;s subscription to "
        "the Fund exceed 40 percent of the value of the Subscriber&rsquo;s "
        "total assets?"))
    story.append(P(
        "(3) State whether each of the shareholders, partners, or other "
        "holders of equity or beneficial interests in the Subscriber "
        "(please answer both (A) and (B)):",
        BODY))
    story.extend(yes_no_row("(A) has a net worth of at least $2,200,000"))
    story.extend(yes_no_row(
        "(B) is either an entity which is not engaged primarily in "
        "investing or trading in securities or a natural person"))
    story.append(spacer(6))

    # Benefit Plan Accounts
    story.append(P("<b>Benefit Plan Accounts</b>", SECTION_HDR_UL))
    story.extend(yes_no_row(
        "(a) Is the Subscriber a pension, profit sharing, annuity, or "
        "employee benefit plan (a &ldquo;<b>Plan</b>&rdquo;) described "
        "in the Employee Retirement Income Security Act of 1974, as "
        "amended (&ldquo;<b>ERISA</b>&rdquo;), or Section 4975 of the "
        "Internal Revenue Code of 1986, as amended (the "
        "&ldquo;<b>Code</b>&rdquo;), whether or not subject to ERISA, "
        "or is the Subscriber an entity whose underlying assets include "
        "&ldquo;plan assets&rdquo; for purposes of ERISA by reason of a "
        "Plan&rsquo;s investment in the Subscriber?"))
    story.extend(yes_no_row(
        "(b) Is the Subscriber a Plan that is both voluntary and "
        "contributory?"))
    story.extend(yes_no_row(
        "(c) Have beneficiaries of the Plan been provided the opportunity "
        "to decide individually whether or not to participate, or the "
        "extent of their participation, in the Plan&rsquo;s investment "
        "in the Fund?"))
    story.extend(yes_no_row(
        "(d) Is the Subscriber an insurance company general account the "
        "underlying assets of which include &ldquo;plan assets&rdquo; "
        "for purposes of ERISA?"))
    story.append(spacer(4))

    # Regulated Institutions
    story.append(P("<b>Regulated Institutions</b>", SECTION_HDR_UL))
    story.extend(yes_no_row(
        "Is the Subscriber a regulated institution that is subject to "
        "legal or regulatory restrictions or limitations on the nature "
        "of its investments (such as a bank or an insurance company)?"))
    story.extend(yes_no_row(
        "If the answer is &ldquo;Yes,&rdquo; has the Subscriber verified "
        "that the proposed subscription is in compliance with applicable "
        "laws and regulations?"))
    story.append(spacer(4))

    # Tax Information
    story.append(P("<b>Tax Information</b>", SECTION_HDR_UL))
    for lbl in [
        "(a) Employer identification number (for entities, trustees, and "
        "custodians, including for IRAs):",
        "(b) Annual date on which the Subscriber&rsquo;s taxable year "
        "ends for purposes of reporting federal income tax or filing "
        "information returns:",
    ]:
        story.append(labeled_field_row(lbl, width_label=4.6, width_value=1.8))
    story.extend(yes_no_row(
        "(c) Is the Subscriber exempt from federal income tax (e.g., a "
        "qualified employee benefit plan or trust, retirement account, "
        "charitable remainder trust, or a charitable foundation or other "
        "tax-exempt organization described in Section 501(c)(3) of the "
        "Code)?"))
    story.append(spacer(4))

    # Public Disclosure / FOIA / Pay-to-Play
    story.append(P("<b>Public Disclosure and Pay-to-Play Information</b>",
                   SECTION_HDR_UL))
    story.extend(yes_no_row(
        "Is the Subscriber (or its beneficial owner) subject to the U.S. "
        "Freedom of Information Act, 5 U.S.C. &sect; 552 "
        "(&ldquo;<b>FOIA</b>&rdquo;), any state public records access "
        "laws, any state or other jurisdiction&rsquo;s laws with similar "
        "intent or effect to FOIA, or any other similar statutory or "
        "legal right that might result in the disclosure of confidential "
        "information relating to the Fund?"))
    story.append(P(
        "If Yes, please indicate the relevant laws to which the "
        "Subscriber is subject (specify name of statute, rules, "
        "regulations or policies and the applicable jurisdiction) and "
        "include a brief summary of the Subscriber&rsquo;s applicable "
        "procedures for the release of information due to a FOIA or "
        "similar request in the space below:",
        BODY))
    story.append(labeled_field_row(" ", width_label=0.3, width_value=6.2))
    story.append(P(
        "Other than as set forth above, the Subscriber represents and "
        "warrants that it is not subject to any laws, regulations, or "
        "policies that might require the Subscriber to disclose "
        "information about its investment in the Fund, or information "
        "provided to the Subscriber by the General Partner or the Fund "
        "about the Fund&rsquo;s investments or performance, to any third "
        "party.",
        BODY))
    story.extend(yes_no_row(
        "If the Subscriber is (i) a government entity, (ii) acting as "
        "trustee, custodian, or nominee for a beneficial owner that is "
        "a government entity, or (iii) an entity substantially owned by "
        "a government entity, are there &ldquo;pay-to-play&rdquo; or "
        "other similar compliance obligations (other than Rule 206(4)-5 "
        "promulgated under the Advisers Act) that would be imposed on "
        "the Fund, the General Partner, the Investment Manager, or their "
        "Affiliates in connection with the Subscriber&rsquo;s acquisition "
        "of a Limited Partnership Interest in the Fund?"))
    story.append(P(
        "If Yes, please indicate in the space below all other "
        "&ldquo;pay-to-play&rdquo; laws, rules or guidelines, or lobbyist "
        "disclosure laws or rules that the Fund, the General Partner, "
        "the Investment Manager, or any of their Affiliates, employees, "
        "or third-party placement agents (if any) would be subject to in "
        "connection with the Subscriber&rsquo;s acquisition of a Limited "
        "Partnership Interest in the Fund:",
        BODY))
    story.append(labeled_field_row(" ", width_label=0.3, width_value=6.2))
    story.append(spacer(8))

    # Subscriber Qualification banner (entity)
    story.append(subscriber_qual_banner())
    story.append(P(
        "Subscriptions will be accepted only from persons who qualify as "
        "eligible investors within the meaning of applicable federal and "
        "state securities regulations. Unless otherwise indicated, "
        "responses should be given by reference to the specific person "
        "for whose account the Limited Partnership Interest is being "
        "acquired. The Subscriber may be required to provide such further "
        "information and execute and deliver such documents as the "
        "General Partner may reasonably request to verify that the "
        "Subscriber qualifies as an eligible investor.",
        BODY))
    story.append(spacer(6))

    # ACCREDITED INVESTOR STATUS - Entities
    story.append(ai_qc_banner("ACCREDITED INVESTOR STATUS (ENTITIES)"))
    story.append(P(
        "Each Subscriber must indicate whether the intended beneficial "
        "owner of the Limited Partnership Interest qualifies as an "
        "&ldquo;accredited investor&rdquo; pursuant to at least one of "
        "the following tests under Rule 501(a) of Regulation D. (Please "
        "check all that apply, or, if none applies, consult the General "
        "Partner.)",
        BODY))

    ai_entity = [
        ("<b>Rule 501(a)(3) &ndash; $5M Entity.</b>&nbsp;&nbsp;The "
         "Subscriber is an entity with total assets in excess of "
         "$5,000,000 which was not formed for the specific purpose of "
         "investing in the Fund and which is one of the following:").replace("&ndash;", "-"),
    ]
    for text in ai_entity:
        story.append(P(f"{BOX}&nbsp;&nbsp;{text}", SUB_CHECKBOX))
    # Sub-checkboxes for (3) categories
    for sub in [
        "a corporation; or",
        "a partnership; or",
        "a limited liability company; or",
        "a business trust; or",
        "a tax-exempt organization described in Section 501(c)(3) of the "
        "Internal Revenue Code of 1986, as amended.",
    ]:
        story.append(P(f"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
                       f"{BOX}&nbsp;&nbsp;{sub}",
                       SUB_CHECKBOX))

    ai_entity2 = [
        ("<b>Rule 2a51-1(b) Investments Entity.</b>&nbsp;&nbsp;The "
         "Subscriber is an entity that owns &ldquo;investments,&rdquo; "
         "as defined in Rule 2a51-1(b) under the Investment Company Act, "
         "in excess of $5,000,000 and was not formed for the specific "
         "purpose of investing in the Fund and which is one of the "
         "following:"),
    ]
    for text in ai_entity2:
        story.append(P(f"{BOX}&nbsp;&nbsp;{text}", SUB_CHECKBOX))
    for sub in [
        "a corporation; or",
        "a partnership; or",
        "a limited liability company.",
    ]:
        story.append(P(f"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
                       f"{BOX}&nbsp;&nbsp;{sub}",
                       SUB_CHECKBOX))

    ai_entity3 = [
        ("<b>Rule 501(a)(7) &ndash; $5M Personal Trust.</b>&nbsp;&nbsp;"
         "The Subscriber is a personal (non-business) trust, other than "
         "an employee benefit trust, with total assets in excess of "
         "$5,000,000, which was not formed for the purpose of investing "
         "in the Fund, and whose decision to invest in the Fund has been "
         "directed by a person who has such knowledge and experience in "
         "financial and business matters that he or she is capable of "
         "evaluating the merits and risks of the investment.").replace("&ndash;", "-"),
        ("<b>Rule 501(a)(1) &ndash; ERISA Plan.</b>&nbsp;&nbsp;The "
         "Subscriber is an employee benefit plan within the meaning of "
         "Title I of the Employee Retirement Income Security Act of "
         "1974, as amended (&ldquo;ERISA&rdquo;) (including an "
         "individual retirement account) which satisfies at least one of "
         "the following conditions:").replace("&ndash;", "-"),
    ]
    for text in ai_entity3:
        story.append(P(f"{BOX}&nbsp;&nbsp;{text}", SUB_CHECKBOX))
    for sub in [
        "it has total assets in excess of $5,000,000; or",
        "the investment decision is being made by a plan fiduciary which "
        "is a bank, savings and loan association, insurance company, or "
        "registered investment adviser; or",
        "it is a self-directed plan (i.e., a tax-qualified defined "
        "contribution plan in which a participant may exercise control "
        "over the investment of assets credited to his or her account) "
        "and the decision to invest is made by those participants "
        "investing, and each such participant qualifies as an accredited "
        "investor.",
    ]:
        story.append(P(f"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
                       f"{BOX}&nbsp;&nbsp;{sub}",
                       SUB_CHECKBOX))

    ai_entity4 = [
        ("<b>Rule 501(a)(1) &ndash; Government Plan $5M.</b>&nbsp;&nbsp;"
         "The Subscriber is an employee benefit plan established and "
         "maintained by a state, its political subdivisions, or any "
         "agency or instrumentality of a state or its political "
         "subdivisions, which has total assets in excess of $5,000,000.").replace("&ndash;", "-"),
        ("<b>Rule 501(a)(1) &ndash; Bank / S&amp;L / Insurance / SBIC.</b>"
         "&nbsp;&nbsp;The Subscriber is licensed, or subject to "
         "supervision, by federal or state examining authorities as a "
         "&ldquo;bank,&rdquo; &ldquo;savings and loan association,&rdquo; "
         "&ldquo;insurance company,&rdquo; or &ldquo;small business "
         "investment company&rdquo; (as such terms are used and defined "
         "in 17 CFR &sect; 230.501(a)), or is an account for which a "
         "bank or savings and loan association is subscribing in a "
         "fiduciary capacity.").replace("&ndash;", "-"),
        ("<b>Rule 501(a)(2) &ndash; Registered Broker-Dealer / "
         "Investment Company / BDC.</b>&nbsp;&nbsp;The Subscriber is "
         "registered with the Securities and Exchange Commission as a "
         "broker or dealer or an investment company; or has elected to "
         "be treated or qualifies as a &ldquo;business development "
         "company&rdquo; (within the meaning of Section 2(a)(48) of the "
         "Investment Company Act of 1940, as amended, or Section "
         "202(a)(22) of the Advisers Act).").replace("&ndash;", "-"),
        ("<b>Rule 501(a)(8) / (9) / (11) &ndash; Registered Investment "
         "Adviser.</b>&nbsp;&nbsp;The Subscriber is registered with the "
         "Securities and Exchange Commission as a registered investment "
         "adviser (RIA), is a state-registered investment adviser, "
         "exempt reporting adviser, or is a rural business investment "
         "company (RBIC).").replace("&ndash;", "-"),
        ("<b>Rule 501(a)(12) &ndash; Family Office.</b>&nbsp;&nbsp;The "
         "Subscriber is a &ldquo;family office&rdquo; with at least "
         "$5,000,000 in assets under management or their &ldquo;family "
         "clients,&rdquo; as each term is defined under the Advisers "
         "Act.").replace("&ndash;", "-"),
        ("<b>Rule 501(a)(8) &ndash; All-Accredited Entity.</b>&nbsp;&nbsp;"
         "The Subscriber is an entity in which all of the equity owners "
         "are accredited investors.").replace("&ndash;", "-"),
    ]
    for text in ai_entity4:
        story.append(P(f"{BOX}&nbsp;&nbsp;{text}", SUB_CHECKBOX))
    story.append(spacer(8))

    # QUALIFIED CLIENT STATUS - Entities
    story.append(ai_qc_banner("QUALIFIED CLIENT STATUS (ENTITIES)"))
    story.append(P(
        "Each Subscriber must also indicate whether the intended "
        "beneficial owner qualifies as a &ldquo;qualified client&rdquo; "
        "pursuant to at least one of the following tests under Rule "
        "205-3 of the Advisers Act. (Please check all that apply, or, "
        "if none applies, consult the General Partner.)",
        BODY))
    qc_entity = [
        ("<b>Rule 205-3(d)(1)(i) &ndash; $2.2M Net Worth.</b>&nbsp;&nbsp;"
         "The entity Subscriber has a net worth in excess of $2,200,000 "
         "at the time of the investment management contract.").replace("&ndash;", "-"),
        ("<b>Rule 205-3(d)(1)(ii) &ndash; $1.1M AUM.</b>&nbsp;&nbsp;The "
         "entity Subscriber has at least $1,100,000 in assets under "
         "management with the Investment Manager immediately after "
         "entering into the investment advisory relationship with the "
         "Investment Manager.").replace("&ndash;", "-"),
        ("<b>Rule 205-3(d)(1)(iii) &ndash; Knowledgeable Employee / "
         "Principal of Adviser.</b>&nbsp;&nbsp;The Subscriber is or is "
         "controlled by an executive officer, director, trustee, general "
         "partner, or person serving in a similar capacity, of the "
         "Investment Manager; or an employee of the Investment Manager "
         "who regularly participates in the investment activities of "
         "the Investment Manager and has been performing such functions "
         "or substantially similar functions for at least 12 months.").replace("&ndash;", "-"),
    ]
    for text in qc_entity:
        story.append(P(f"{BOX}&nbsp;&nbsp;{text}", SUB_CHECKBOX))
    story.append(spacer(8))

    # Pre-1996 Private Fund Disclosure (RESTORED sub-question (c))
    story.append(ai_qc_banner("SECTION 3(c)(1) / 3(c)(7) PRIVATE FUND DISCLOSURE"))
    story.append(P(
        "The following questions must be answered by any Subscriber that "
        "is itself a private investment company not registered under the "
        "Investment Company Act of 1940. Answers are used by the General "
        "Partner to calculate beneficial ownership for purposes of "
        "Section 3(c)(1) of the Investment Company Act, which limits "
        "the Fund to 100 beneficial owners.",
        BODY))
    story.extend(yes_no_row(
        "<b>(a)</b> Is the Subscriber a private investment company which "
        "is not registered under the Investment Company Act in reliance "
        "on Sections 3(c)(1) or 3(c)(7) thereof?"))
    story.extend(yes_no_row(
        "<b>(b)</b> If Question (a) was answered &ldquo;Yes,&rdquo; "
        "please indicate whether or not the Subscriber was formed on or "
        "before April 30, 1996."))
    # RESTORED sub-question (c) per HANDOFF
    story.extend(yes_no_row(
        "<b>(c) [RESTORED v2.2]</b> If Question (b) was answered "
        "&ldquo;Yes,&rdquo; please indicate whether or not the Subscriber "
        "has obtained the consent of its direct and indirect beneficial "
        "owners to be treated as a &ldquo;qualified purchaser&rdquo; as "
        "provided in Section 2(a)(51)(C) of the Investment Company Act "
        "and the rules and regulations thereunder."))
    story.append(P(
        "<b>If the answer to (c) is &ldquo;No,&rdquo; please contact the "
        "General Partner for additional information that will be required.</b>",
        BODY))
    story.append(spacer(10))

    story.append(P("<b>[End of Part III]</b>", SUBTITLE_STYLE))
    return story


# =========================================================================
# MAIN
# =========================================================================
def build():
    doc = make_doc_template(
        OUT_PATH,
        title_meta="PNTHR Tree Fund, LP - Investor Questionnaire v1.0",
        subject="Subscriber Information Form and Investor Questionnaire",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Investor Questionnaire",
        fund_name="PNTHR Tree Fund",
        fund_name_upper="PNTHR TREE FUND",
        doc_date_display="June 2026",
    )
    story = []
    story.extend(build_title())
    story.extend(build_part_i())
    story.extend(build_part_ii())
    story.extend(build_part_iii())

    doc.build(story, onFirstPage=on_cover, onLaterPages=on_page)
    print(f"PDF generated: {OUT_PATH}")


if __name__ == "__main__":
    build()
