#!/usr/bin/env python3
"""
PNTHR Tree Fund, LP
Subscription Agreement v2.3
Effective: June 1, 2026

Baseline: attorney-prepared "5. Rev-Subscription Agreement - PNTHR FINAL.pdf" (15 pages)
Revisions applied per user-approved Phase 1 edit plan (April 2026).

Key revisions (all 7 approved recommendations locked in 2026-04-19):
  - Date: March 1, 2025 -> June 1, 2026
  - Legal name: "PNTHR Funds, LLC" / "PNTHR FUNDS, LLC" (Certificate-accurate, comma preserved)
  - LPA title: "Limited Partnership Agreement" (not "Amended and Restated")
  - Para (8) Qualified Client fix: combined Rule 501(a) Reg D + Rule 205-3 Advisers Act
    citations + 506(c) third-party verification acknowledgment in single paragraph
  - Para (22)(s) typo fix: "clauses (a)-(h)" -> "clauses (k)-(r)"
  - "Management Company" -> "Investment Manager" throughout (defined as STT Capital
    Advisors, LLC; matches PPM/LPA/IMA terminology)
  - Purchaser Representative Questionnaire: DROPPED (not applicable to 506(c))
  - 506(c) + 3(c)(1) prominent recital added
  - Technology Platform + Electronic Delivery + AI Tools + Brokerage Integration
    acknowledgments added
  - Appendix D Supplemental Risk Factors (genuine 2-3 page summary, 7 risk factors)
  - Signature Page: $100K minimum pre-populated + Class Selection checkboxes
    (Wagyu / Porterhouse / Filet) with Performance Allocation tiers shown
  - POA (para 35) preserved broad + cross-ref to LPA Section 5.03
  - All attorney AML/OFAC/PEP/POA/FATCA language preserved
  - Pre-signed Scott + Cindy acceptance replaced with blank fields for per-investor execution

PHASE 1 - LEGAL CONTENT ONLY. No PNTHR branding/design.

v2.2 -> v2.3: Replaced ZapfDingbats "q" (rendered as filled square by most PDF
viewers) with a registered Unicode TrueType font rendering U+2610 BALLOT BOX (true
open/unfilled checkbox glyph) so subscribers can apply clearly visible check marks.

Output: PNTHR_SubAgmt_v2.3_2026.pdf
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

OUT_DIR = os.path.expanduser("~/Downloads")
os.makedirs(OUT_DIR, exist_ok=True)
OUT_PATH = os.path.join(OUT_DIR, "PNTHR_Tree_Fund_SubAgmt_v1.0_2026.pdf")

# Register a Unicode-capable TrueType font so U+2610 BALLOT BOX renders as
# a CLEAN OPEN/UNFILLED CHECKBOX (not a filled square). Standard PDF fonts
# (Times-Roman, Helvetica, ZapfDingbats) do not contain U+2610 in their
# encoding, which is why the prior ZapfDingbats "q" glyph rendered as a
# filled/shadowed square instead of an open box.
_CHECKBOX_FONT = None
for _candidate_path in [
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",  # macOS full Unicode
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",       # Linux DejaVu
    "/System/Library/Fonts/Helvetica.ttc",                   # macOS Helvetica (TTC)
    "C:/Windows/Fonts/arial.ttf",                            # Windows Arial
]:
    if os.path.exists(_candidate_path):
        try:
            pdfmetrics.registerFont(TTFont("UnicodeBox", _candidate_path))
            _CHECKBOX_FONT = "UnicodeBox"
            break
        except Exception:
            continue

if _CHECKBOX_FONT:
    # U+2610 BALLOT BOX (☐) - proper open/unfilled checkbox, renders hollow
    # so that a handwritten or digital check mark is clearly visible.
    BOX = f'<font name="{_CHECKBOX_FONT}" size="13">&#9744;</font>'
else:
    # Last-resort ASCII fallback if no Unicode font is available.
    BOX = "[&nbsp;&nbsp;&nbsp;]"

# ----- Styles -----------------------------------------------------------
TITLE_STYLE = ParagraphStyle(
    name="title", fontName="Helvetica-Bold", fontSize=14, leading=18,
    alignment=TA_CENTER, spaceBefore=0, spaceAfter=14,
)
SUBTITLE_STYLE = ParagraphStyle(
    name="subtitle", fontName="Helvetica-Bold", fontSize=12, leading=16,
    alignment=TA_CENTER, spaceBefore=0, spaceAfter=10,
)
SECTION_HDR = ParagraphStyle(
    name="section_hdr", fontName="Helvetica-Bold", fontSize=12, leading=15,
    alignment=TA_LEFT, spaceBefore=14, spaceAfter=6,
)
SECTION_HDR_CTR = ParagraphStyle(
    name="section_hdr_ctr", fontName="Helvetica-Bold", fontSize=12, leading=15,
    alignment=TA_CENTER, spaceBefore=14, spaceAfter=6,
)
BODY = ParagraphStyle(
    name="body", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=8,
)
BODY_LEFT = ParagraphStyle(
    name="body_left", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=0, spaceAfter=8,
)
REP_PARA = ParagraphStyle(
    name="rep_para", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=8, leftIndent=22,
)
REP_SUB = ParagraphStyle(
    name="rep_sub", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=6, leftIndent=50,
)
BULLET = ParagraphStyle(
    name="bullet", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=4, leftIndent=36, bulletIndent=20,
)
COVER_NOTICE = ParagraphStyle(
    name="cover_notice", fontName="Helvetica", fontSize=10, leading=13,
    alignment=TA_JUSTIFY, spaceBefore=12, spaceAfter=8,
)
CAPS_BODY = ParagraphStyle(
    name="caps_body", fontName="Helvetica-Bold", fontSize=9, leading=12,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=8,
)

# ----- Header / Footer are provided by pnthr_design.make_page_handlers -----

# ----- Helpers ----------------------------------------------------------
def P(text, style=BODY):
    return Paragraph(text, style)

def spacer(h=10):
    return Spacer(1, h)

def rep(num, text):
    return P(f"<b>({num})</b>&nbsp;&nbsp;{text}", REP_PARA)

def rep_sub(letter_label, text):
    return P(f"<b>({letter_label})</b>&nbsp;&nbsp;{text}", REP_SUB)


# =========================================================================
# SUBSCRIPTION INSTRUCTIONS (pages 1-2)
# =========================================================================
def build_instructions():
    story = []
    story.append(P("<b>PNTHR FUNDS</b>", TITLE_STYLE))
    story.append(P("<b>PNTHR Tree Fund, LP</b>", TITLE_STYLE))
    story.append(spacer(4))
    story.append(P("<b>Subscription Instructions</b>", SUBTITLE_STYLE))
    story.append(spacer(6))

    story.append(P(
        "A subscription to invest in PNTHR Tree Fund, LP "
        "(the &ldquo;<b>Fund</b>&rdquo;) may be made only by means of the "
        "completion, delivery, and acceptance of the subscription documents "
        "in this package. Completion of the following documents is required:",
        BODY))

    # Package list (NO Purchaser Rep Questionnaire per recommendation #3)
    story.append(P(
        f"{BOX}&nbsp;&nbsp;<b>Subscription Agreement and Investor Questionnaire</b>: "
        "Complete all requested information in this Subscription Agreement "
        "and the Investor Questionnaire (collectively, the &ldquo;<b>Agreement</b>&rdquo;) "
        "and date and sign the signature page.",
        BULLET))

    story.append(P(
        f"{BOX}&nbsp;&nbsp;<b>Accredited Investor Verification</b>: "
        "Complete the Accredited Investor Verification form and arrange for "
        "the accompanying third-party verification required by Rule 506(c) "
        "under the Securities Act of 1933, as amended. Acceptable verifiers are "
        "(i) a FINRA-registered broker-dealer, (ii) an SEC-registered "
        "investment adviser, (iii) a licensed attorney in good standing, or "
        "(iv) a certified public accountant in good standing. State-registered "
        "investment advisers are not acceptable verifiers under Rule "
        "506(c)(2)(ii)(C). Self-certification is not sufficient.",
        BULLET))

    story.append(P(
        f"{BOX}&nbsp;&nbsp;<b>IRS Form W-9 or W-8</b>: "
        "Complete and sign IRS Form W-9 (U.S. persons) or the applicable "
        "Form W-8 (non-U.S. persons) to certify your tax identification "
        "number or status. Attach as <b>Exhibit B</b>.",
        BULLET))

    story.append(P(
        f"{BOX}&nbsp;&nbsp;<b>Limited Partnership Agreement Signature Page</b>: "
        "Execute the Partnership Agreement Signature Page of the Limited "
        "Partnership Agreement of the Fund dated as of June 1, 2026, as amended "
        "from time to time (the &ldquo;<b>Limited Partnership Agreement</b>&rdquo; "
        "or &ldquo;<b>Fund Agreement</b>&rdquo;), attached as <b>Exhibit A</b>.",
        BULLET))

    story.append(spacer(4))
    story.append(P(
        "If you will be investing through multiple entities, please make "
        "additional copies of these documents as necessary, ensuring that "
        "all documents are completed for each entity investing in the Fund.",
        BODY))

    # U.S. Identification Rules
    story.append(P("<b>U.S. Identification Rules.</b>", SECTION_HDR))
    story.append(P(
        "<b>Individual Investors</b> are required to provide a photocopy of a valid "
        "U.S. Driver&rsquo;s License or State ID, or a copy of a valid U.S. Passport.",
        BODY))
    story.append(P(
        "<b>Partnerships</b> are required to provide a copy of the state "
        "registration of the Partnership along with a copy of the signed "
        "partnership agreement identifying the General Partner and/or the "
        "designee empowered to sign the subscription documents. We also request "
        "a list of individuals or entities that own over 25% of the Partnership, "
        "with their names and countries of citizenship.",
        BODY))
    story.append(P(
        "<b>Trusts</b> are required to provide a full copy of the trust agreement "
        "or relevant portions thereof, including the grantor declaration page and "
        "signature pages, and any other portions showing appointment and authority "
        "of trustee(s). A photocopy of a valid U.S. Driver&rsquo;s License or State "
        "ID, or a copy of a valid U.S. Passport will also be required for the "
        "individual trustees. We also request a list of individuals or entities "
        "whose beneficial ownership is over 25% of the Trust, with their names "
        "and countries of citizenship.",
        BODY))
    story.append(P(
        "<b>Corporations</b> are required to provide a copy of the state "
        "registration of the corporation along with a copy of its articles of "
        "incorporation. A list of officer signatures or signed, certified corporate "
        "resolutions identifying the corporate officer(s) empowered to sign the "
        "subscription documents will also be required. We also request a list of "
        "individuals or entities who own over 25% of the Corporation, with their "
        "names and countries of citizenship.",
        BODY))
    story.append(P(
        "<b>LLC Investors</b> are required to provide a copy of the state "
        "registration of the LLC along with a copy of the signed operating "
        "agreement identifying the Managing Member(s) empowered to sign the "
        "subscription documents. We also request a list of individuals or "
        "entities who own over 25% of the LLC, with their names and countries "
        "of citizenship.",
        BODY))

    # Delivery Instructions
    story.append(P("<b>Delivery Instructions.</b>", SECTION_HDR))
    story.append(P("Investors must submit:", BODY))
    for item in [
        "A completed copy of this Agreement;",
        "An executed copy of the signature page to this Agreement;",
        "A completed Accredited Investor Verification form with accompanying third-party verification letter;",
        "A photocopy of a valid U.S. Driver&rsquo;s License or State ID, or a copy of a valid U.S. Passport;",
        "An original, executed IRS Form W-9 or Form W-8, as applicable; and",
        "An executed copy of the Partnership Agreement Signature Page of the Limited Partnership Agreement.",
    ]:
        story.append(P(f"{BOX}&nbsp;&nbsp;{item}", BULLET))

    story.append(spacer(4))
    story.append(P(
        "<i>Prospective investors who are U.S. persons can access Form W-9 at "
        "www.irs.gov/forms-pubs/about-form-w-9. Non-U.S. persons can access "
        "Form W-8BEN, W-8BEN-E, or W-8IMY as applicable at www.irs.gov.</i>",
        BODY))

    story.append(P(
        "These subscription documents should be delivered to the following "
        "address by overnight mail for delivery by the date specified in the "
        "correspondence accompanying this document. Documents may be delivered "
        "by email as a PDF file or via originals to follow by overnight mail:",
        BODY))

    story.append(P(
        "<b>PNTHR Tree Fund, LP</b><br/>"
        "c/o NAV Fund Administration Group<br/>"
        "NAV Consulting &nbsp;|&nbsp; NAV Cayman &nbsp;|&nbsp; NAV Backoffice<br/>"
        "1 Trans Am Plaza Drive, Suite 400<br/>"
        "Oakbrook Terrace, IL 60181<br/>"
        "Phone: 1.630.954.1919 &nbsp;|&nbsp; Fax: 1.630.596.8555<br/>"
        "Email: Transfer.agency@navconsulting.net<br/>"
        "Web: www.navconsulting.net",
        BODY_LEFT))

    # Additional Required Documents
    story.append(P("<b>Additional Required Documents.</b>", SECTION_HDR))
    story.append(P(
        "PNTHR Funds, LLC (the &ldquo;<b>General Partner</b>&rdquo;) reserves "
        "the right to request any additional documentation necessary to verify "
        "the identity of a prospective investor in the Fund. Please be aware "
        "that your failure to provide such documentation may delay your "
        "acceptance by the General Partner or cause your subscription request "
        "to be rejected entirely. The Fund and the General Partner shall be held "
        "harmless by any such prospective investor against any loss arising as "
        "a result of a failure to provide any requested documentation.",
        BODY))

    # Acceptance of Subscriptions
    story.append(P("<b>Acceptance of Subscriptions.</b>", SECTION_HDR))
    story.append(P(
        "The acceptance of subscriptions is within the absolute discretion of "
        "the General Partner, which may require additional information prior "
        "to making a determination. The General Partner will seek to notify the "
        "Subscriber of its acceptance or rejection of the subscription prior to "
        "the date of subscription. The General Partner, in its sole discretion, "
        "may reduce a Subscriber&rsquo;s subscription. The General Partner may "
        "decline to accept a Subscriber&rsquo;s subscription if all requested "
        "anti-money laundering materials are not timely submitted or if the "
        "Subscriber&rsquo;s Subscription Agreement and accompanying documentation "
        "are incomplete.",
        BODY))

    # Privacy
    story.append(P("<b>Privacy.</b>", SECTION_HDR))
    story.append(P(
        "The Fund takes precautions to maintain the privacy of personal "
        "information concerning the Fund&rsquo;s current and prospective "
        "individual investors. The Fund&rsquo;s privacy notice is attached "
        "as <b>Appendix B</b> hereto.",
        BODY))

    # Additional Information
    story.append(P("<b>Additional Information.</b>", SECTION_HDR))
    story.append(P(
        "For additional information concerning subscriptions, or questions "
        "regarding the completion of these subscription documents, please "
        "contact <b>Cindy Eagar</b> at info@PNTHRfunds.com or 602-810-1940.",
        BODY))

    # Bottom legend
    story.append(spacer(14))
    story.append(P(
        "THE OFFERING OF SECURITIES DESCRIBED HEREIN HAS NOT BEEN REGISTERED "
        "UNDER THE UNITED STATES SECURITIES ACT OF 1933, AS AMENDED (THE "
        "&ldquo;SECURITIES ACT&rdquo;), OR UNDER ANY SECURITIES LAWS OF ANY "
        "STATE OF THE UNITED STATES OR ANY OTHER JURISDICTION. THIS OFFERING "
        "IS MADE PURSUANT TO RULE 506(c) OF REGULATION D AND SECTION 4(a)(2) "
        "OF THE SECURITIES ACT, WHICH EXEMPT FROM SUCH REGISTRATION "
        "TRANSACTIONS NOT INVOLVING A PUBLIC OFFERING. ALL PROSPECTIVE "
        "INVESTORS MUST BE ACCREDITED INVESTORS AND QUALIFIED CLIENTS, AND "
        "THEIR ACCREDITED-INVESTOR STATUS MUST BE VERIFIED BY A THIRD-PARTY "
        "VERIFIER ACCEPTABLE TO THE GENERAL PARTNER. A PROSPECTIVE INVESTOR "
        "SHOULD BE PREPARED TO BEAR THE ECONOMIC RISK OF AN INVESTMENT IN THE "
        "FUND FOR AN INDEFINITE PERIOD OF TIME BECAUSE THE LIMITED PARTNERSHIP "
        "INTERESTS HAVE NOT BEEN REGISTERED UNDER THE SECURITIES ACT OR THE "
        "LAWS OF ANY OTHER JURISDICTION AND, THEREFORE, CANNOT BE SOLD UNLESS "
        "THEY ARE SUBSEQUENTLY REGISTERED OR AN EXEMPTION FROM REGISTRATION "
        "IS AVAILABLE. THERE IS NO OBLIGATION OF THE ISSUER TO REGISTER THE "
        "LIMITED PARTNERSHIP INTERESTS UNDER THE SECURITIES ACT OR THE LAWS "
        "OF ANY OTHER JURISDICTION. TRANSFER OF THE LIMITED PARTNERSHIP "
        "INTERESTS IS ALSO RESTRICTED BY THE TERMS OF THE LIMITED PARTNERSHIP "
        "AGREEMENT RELATING THERETO.",
        CAPS_BODY))

    story.append(PageBreak())
    return story


# =========================================================================
# SIGNATURE PAGE (immediately after Instructions)
# =========================================================================
def build_signature_page():
    story = []
    story.append(P("<b>SIGNATURE PAGE</b>", SUBTITLE_STYLE))
    story.append(spacer(8))

    story.append(P(
        "By signing below, the Subscriber (1) confirms that the information "
        "contained in the Subscription Agreement and the Investor Questionnaire "
        "is accurate and complete, (2) agrees to the terms of the Subscription "
        "Agreement and the Limited Partnership Agreement, and (3) requests that "
        "the records of the Fund reflect the Subscriber&rsquo;s acquisition of "
        "limited partnership interests of PNTHR Tree Fund, "
        "LP.",
        BODY))

    story.append(spacer(10))

    # Capital Commitment (pre-populated minimum + class selection)
    story.append(P("<b>CAPITAL COMMITMENT</b> (not less than $100,000):", BODY_LEFT))
    story.append(spacer(4))
    story.append(P("$ _________________________________________", BODY_LEFT))
    story.append(spacer(12))

    story.append(P(
        "<b>CLASS SELECTION</b> (check the box corresponding to the Capital "
        "Commitment amount above):",
        BODY_LEFT))
    story.append(spacer(4))
    story.append(P(
        f"{BOX}&nbsp;&nbsp;<b>Wagyu Class</b> (Capital Commitment &ge; $1,000,000) "
        "&mdash; 20% Performance Allocation (reduced to 15% after 3 continuous "
        "years provided the Capital Account balance remains at or above the "
        "initial Capital Contribution).".replace("&mdash;", "-"),
        BULLET))
    story.append(P(
        f"{BOX}&nbsp;&nbsp;<b>Porterhouse Class</b> (Capital Commitment "
        "$500,000 to $999,999) - 25% Performance Allocation (reduced to 20% "
        "after 3 continuous years on the same basis).",
        BULLET))
    story.append(P(
        f"{BOX}&nbsp;&nbsp;<b>Filet Class</b> (Capital Commitment "
        "$100,000 to $499,999) - 30% Performance Allocation (reduced to 25% "
        "after 3 continuous years on the same basis).",
        BULLET))

    story.append(spacer(12))
    story.append(P("Dated:  _______________________, 2026", BODY_LEFT))
    story.append(spacer(20))

    # Natural Persons block
    story.append(P("<b>FOR COMPLETION BY SUBSCRIBERS WHO ARE NATURAL PERSONS "
                   "(i.e., individuals):</b>", BODY_LEFT))
    story.append(spacer(10))
    story.append(P("_________________________________________", BODY_LEFT))
    story.append(P("Name of Subscriber (printed)", BODY_LEFT))
    story.append(spacer(14))
    story.append(P("_________________________________________", BODY_LEFT))
    story.append(P("Signature", BODY_LEFT))
    story.append(spacer(14))
    story.append(P("_________________________________________", BODY_LEFT))
    story.append(P("Spouse&rsquo;s Signature (only required if subscription is being "
                   "made by husband and wife as joint tenants)", BODY_LEFT))
    story.append(spacer(16))

    # Non-Natural Persons block
    story.append(P("<b>FOR COMPLETION BY SUBSCRIBERS WHO ARE NOT NATURAL PERSONS "
                   "(i.e., corporations, partnerships, LLCs, trusts):</b>",
                   BODY_LEFT))
    story.append(spacer(10))
    story.append(P("_________________________________________", BODY_LEFT))
    story.append(P("Name of Subscriber (entity)", BODY_LEFT))
    story.append(spacer(10))
    story.append(P("By:  _________________________________________", BODY_LEFT))
    story.append(P("&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;(Signature of authorized person)", BODY_LEFT))
    story.append(spacer(8))
    story.append(P("Name:  _______________________________________", BODY_LEFT))
    story.append(P("&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;(Print or type name of authorized person)", BODY_LEFT))
    story.append(spacer(8))
    story.append(P("Title:  _______________________________________", BODY_LEFT))
    story.append(P("&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;(Print or type title of authorized person)", BODY_LEFT))

    story.append(spacer(20))

    # GP acceptance
    story.append(P(
        "The Subscriber&rsquo;s subscription to acquire a limited partnership "
        "Interest of PNTHR Tree Fund, LP is accepted on the "
        "date specified below, subject to the provisions of the Subscription "
        "Agreement and the Limited Partnership Agreement.",
        BODY))

    story.append(spacer(8))
    story.append(P("<b>PNTHR Tree Fund, LP</b>", BODY_LEFT))
    story.append(P("By:  PNTHR Funds, LLC, its General Partner", BODY_LEFT))
    story.append(spacer(18))
    story.append(P("Name:  Scott R. McBrien", BODY_LEFT))
    story.append(P("Signature:  _________________________________________", BODY_LEFT))
    story.append(spacer(12))
    story.append(P("Name:  Cindy Eagar", BODY_LEFT))
    story.append(P("Signature:  _________________________________________", BODY_LEFT))
    story.append(spacer(10))
    story.append(P("Dated:  _______________________, 2026", BODY_LEFT))

    story.append(PageBreak())
    return story


# =========================================================================
# SUBSCRIPTION AGREEMENT BODY (with 506(c)/3(c)(1) recital + Tech acks)
# =========================================================================
def build_subscription_agreement():
    story = []

    # Title
    story.append(P("<b>PNTHR FUNDS</b>", TITLE_STYLE))
    story.append(P("<b>PNTHR Tree Fund, LP</b>", TITLE_STYLE))
    story.append(spacer(2))
    story.append(P("<b>Subscription Agreement</b>", SUBTITLE_STYLE))
    story.append(spacer(8))

    # Address block
    story.append(P(
        "PNTHR Tree Fund, LP<br/>"
        "c/o PNTHR Funds, LLC<br/>"
        "15150 W Park Place, Suite 215<br/>"
        "Goodyear, Arizona 85395",
        BODY_LEFT))
    story.append(spacer(6))
    story.append(P("Ladies and Gentlemen:", BODY_LEFT))
    story.append(spacer(4))

    # Opening paragraph with LPA reference (FIXED: no "Amended and Restated")
    story.append(P(
        "The undersigned (the &ldquo;<b>Subscriber</b>&rdquo;) hereby "
        "acknowledges having (i) received and read a copy of the Limited "
        "Partnership Agreement of <b>PNTHR Tree Fund, "
        "LP</b>, a limited partnership organized under the laws of the State "
        "of Delaware (the &ldquo;<b>Fund</b>&rdquo;), dated as of June 1, 2026, "
        "as amended from time to time (the &ldquo;<b>Fund Agreement</b>&rdquo;); "
        "(ii) received and read a copy of the Private Placement Memorandum of "
        "the Fund dated as of June 1, 2026, as amended and supplemented from "
        "time to time (the &ldquo;<b>PPM</b>&rdquo;); and (iii) been given the "
        "opportunity to (A) ask questions of, and receive answers from, "
        "<b>PNTHR Funds, LLC</b> (the &ldquo;<b>General Partner</b>&rdquo;) "
        "and <b>STT Capital Advisors, LLC</b> (the &ldquo;<b>Investment "
        "Manager</b>&rdquo;) or one of their Affiliates concerning the terms "
        "and conditions of the offering of limited partnership Interests and "
        "other matters pertaining to an investment in the Fund, and (B) obtain "
        "any additional information which the General Partner can acquire "
        "without unreasonable effort or expense that is necessary to evaluate "
        "the merits and risks of an investment in the Fund. Capitalized terms "
        "not otherwise defined herein have the meaning set forth in the Fund "
        "Agreement.",
        BODY))

    story.append(P(
        "The Subscriber hereby irrevocably subscribes for a limited "
        "partnership Interest as a limited partner in the Fund and agrees to "
        "contribute in cash, in the amount set forth in the Signature Page to "
        "this Subscription Agreement. Such amount shall be payable in full in "
        "readily available funds by check or wire transfer to the bank account "
        "of the Fund upon acceptance of this Subscription Agreement by the "
        "General Partner. The Subscriber acknowledges that the Fund does not "
        "require capital calls; Capital Commitments are contributed in full "
        "at or prior to admission.",
        BODY))

    story.append(P(
        "The Subscriber understands that this subscription is not binding on "
        "the Fund until accepted by the General Partner, and may be rejected, "
        "in whole or in part, by the General Partner in its absolute "
        "discretion. If and to the extent rejected, the Fund shall return to "
        "the Subscriber, without interest or deduction, any payment tendered "
        "by the Subscriber, and the Fund and the Subscriber shall have no "
        "further obligation to each other hereunder.",
        BODY))

    # =========================================================================
    # 506(c) + 3(c)(1) PROMINENT RECITAL (NEW)
    # =========================================================================
    story.append(P("<b>Reliance on Rule 506(c) and Section 3(c)(1).</b>",
                   SECTION_HDR))
    story.append(P(
        "The Fund is conducting its offering of limited partnership Interests "
        "in reliance on <b>Rule 506(c)</b> under Regulation D promulgated "
        "under the Securities Act, which permits general solicitation and "
        "general advertising provided that all purchasers are accredited "
        "investors and the Fund takes reasonable steps to verify the "
        "accredited-investor status of each purchaser. The Subscriber "
        "acknowledges that the Fund will require verification of the "
        "Subscriber&rsquo;s accredited-investor status by an acceptable "
        "third-party verifier pursuant to Rule 506(c)(2)(ii), and that "
        "self-certification is not sufficient. The Fund is relying on the "
        "exclusion from registration as an investment company provided by "
        "<b>Section 3(c)(1)</b> of the Investment Company Act of 1940, as "
        "amended (the &ldquo;<b>Investment Company Act</b>&rdquo;), which "
        "limits the Fund to 100 beneficial owners. The Fund is <b>not</b> "
        "relying on Section 3(c)(7) of the Investment Company Act, and the "
        "Subscriber is not required to be a &ldquo;qualified purchaser&rdquo; "
        "as defined in Section 2(a)(51) of the Investment Company Act. The "
        "Fund has authorized an offering of up to $25,000,000 in aggregate "
        "Capital Commitments.",
        BODY))

    # =========================================================================
    # TECHNOLOGY AND OPERATIONAL ACKNOWLEDGMENTS (NEW)
    # =========================================================================
    story.append(P("<b>Technology, Platform, and Service Provider "
                   "Acknowledgments.</b>", SECTION_HDR))

    story.append(P(
        "<b>(a) Proprietary Signal System and Den Platform.</b>&nbsp;&nbsp;"
        "The Subscriber acknowledges that the Fund&rsquo;s strategy is "
        "implemented through a proprietary quantitative signal framework "
        "designated the &ldquo;<b>PNTHR Signal System</b>&rdquo; and "
        "executed through an internal technology platform designated the "
        "&ldquo;<b>PNTHR Den Platform</b>&rdquo; (collectively, the "
        "&ldquo;<b>Investment Manager&rsquo;s Technology</b>&rdquo;). The "
        "Investment Manager&rsquo;s Technology, including all parameters, "
        "formulas, thresholds, weights, timeframes, models, code, and related "
        "intellectual property, is confidential and proprietary to the "
        "Investment Manager and is not disclosed to the Subscriber or to "
        "any Limited Partner. The Subscriber acknowledges that it cannot "
        "independently verify the methodology of the Investment "
        "Manager&rsquo;s Technology.",
        BODY))

    story.append(P(
        "<b>(b) Manual, Semi-Automated, and Automated Execution.</b>&nbsp;&nbsp;"
        "The Subscriber acknowledges that the Investment Manager, in its "
        "sole discretion, may execute trades manually, semi-automatically, or "
        "fully automatically through the Investment Manager&rsquo;s "
        "Technology, and may change the mix between such execution modes "
        "from time to time without notice to Limited Partners.",
        BODY))

    story.append(P(
        "<b>(c) Artificial Intelligence and Machine Learning Tools.</b>&nbsp;"
        "&nbsp;The Subscriber acknowledges that the Investment Manager "
        "may use artificial intelligence and machine learning tools as "
        "components of its research and trading processes, that such tools "
        "are not a substitute for human investment judgment, and that "
        "their outputs are subject to the same risks as any other component "
        "of the Fund&rsquo;s strategy, including the risk of software "
        "defects, data errors, model drift, and adverse market events.",
        BODY))

    story.append(P(
        "<b>(d) Electronic Delivery and Electronic Signatures.</b>&nbsp;&nbsp;"
        "The Subscriber consents to electronic delivery of all Fund "
        "communications, including the PPM, the Fund Agreement, Schedule "
        "K-1s, quarterly and annual financial reports, capital account "
        "statements, notices, privacy notices, subscription and redemption "
        "confirmations, and any other materials required or permitted to be "
        "delivered to the Subscriber, via email or through a secure "
        "investor portal made available by the Fund or its administrator. "
        "The Subscriber also consents to the use of electronic signatures "
        "under the federal Electronic Signatures in Global and National "
        "Commerce Act (E-SIGN) and the Delaware Uniform Electronic "
        "Transactions Act (UETA). The Subscriber may withdraw its consent "
        "to electronic delivery upon written notice to the Fund, and paper "
        "delivery may be resumed subject to reasonable administrative "
        "processing.",
        BODY))

    story.append(P(
        "<b>(e) Service Providers; Counterparty Risk.</b>&nbsp;&nbsp;"
        "The Subscriber acknowledges that: (i) the Fund uses <b>Interactive "
        "Brokers LLC</b> as prime broker and custodian; (ii) the Fund uses "
        "<b>NAV Consulting, Inc.</b> as administrator; (iii) the Fund "
        "intends to engage <b>Spicer Jeffries LLP</b> as independent "
        "auditor, no such engagement being finalized as of the date of the "
        "PPM; and (iv) execution, clearing, custody, counterparty, "
        "operational, and fraud risks associated with such service "
        "providers flow through to the Fund, and the Subscriber bears its "
        "proportionate share of such risks.",
        BODY))

    # =========================================================================
    # REPRESENTATIONS, WARRANTIES AND COVENANTS
    # =========================================================================
    story.append(P("<b>Representations, Warranties and Covenants.</b>",
                   SECTION_HDR))

    story.append(P(
        "The Subscriber hereby makes the following representations, "
        "warranties and covenants to the Fund&rsquo;s general and limited "
        "partners:",
        BODY))

    # (1) Natural person authority
    story.append(rep("1",
        "If the Subscriber is a natural person, or if beneficial ownership "
        "of the Subscriber is held by an individual through a revocable "
        "grantor trust or an individual retirement account, the Subscriber "
        "or the Subscriber&rsquo;s beneficial owner is at least twenty-one "
        "(21) years old and has the Subscriber&rsquo;s right, power and "
        "capacity to execute this Subscription Agreement, the power of "
        "attorney contained herein (the &ldquo;<b>Power of Attorney</b>"
        "&rdquo;) and the Investor Questionnaire, to purchase limited "
        "partnership Interests in the Fund and to fund the Subscriber&rsquo;s "
        "Capital Commitment and any other required expenses or fees as "
        "contemplated by, and in accordance with, this Subscription Agreement "
        "and the Fund Agreement. If the Subscriber lives in a community "
        "property state in the United States, either (A) the source of the "
        "Subscriber&rsquo;s capital contributions will be the Subscriber&rsquo;s "
        "separate property and the Subscriber will hold the limited "
        "partnership Interests as separate property, or (B) the Subscriber "
        "alone has the authority to bind the community with respect to this "
        "Subscription Agreement, the Power of Attorney, the Investor "
        "Questionnaire and all agreements contemplated hereby and thereby."))

    # (2) Entity authority
    story.append(rep("2",
        "If the Subscriber is a corporation, limited liability company, "
        "partnership, trust, retirement system or other entity, the Subscriber "
        "is duly organized, formed or incorporated, as the case may be, and "
        "the Subscriber is authorized, empowered and qualified to execute "
        "this Subscription Agreement, the Power of Attorney and the Investor "
        "Questionnaire, and to invest in the Fund and to subscribe for the "
        "limited partnership Interests as contemplated by, and in accordance "
        "with, this Subscription Agreement and the Fund Agreement. The "
        "individual signing this Subscription Agreement, the Power of "
        "Attorney and the Investor Questionnaire and all agreements "
        "contemplated hereby and thereby on the Subscriber&rsquo;s behalf "
        "has been duly authorized to do so."))

    # (3) Binding
    story.append(rep("3",
        "The Fund Agreement shall become binding upon the Subscriber on the "
        "later of (i) the date of the Fund Agreement and (ii) the date, if "
        "any, that the General Partner accepts this subscription in whole or "
        "in part. Each of this Subscription Agreement, the Fund Agreement, "
        "the Investor Questionnaire and the Power of Attorney is a valid "
        "and binding agreement or instrument, as applicable, enforceable "
        "against the Subscriber in accordance with its terms. The Subscriber "
        "understands that, upon acceptance by the General Partner and except "
        "as explicitly provided for by law in certain jurisdictions outside "
        "the United States, the Subscriber is not entitled to cancel, "
        "terminate or revoke this Subscription Agreement or any of the "
        "powers conferred herein. The Subscriber represents and warrants "
        "that the Power of Attorney granted by the Subscriber in connection "
        "with this Subscription Agreement has been executed by it in "
        "compliance with the laws of the state or jurisdiction in which this "
        "Subscription Agreement was executed and to which the Subscriber is "
        "subject. The Subscriber hereby covenants and agrees on behalf of "
        "itself and its successors and assigns, without further "
        "consideration, to prepare, execute, acknowledge, file, record, "
        "publish and deliver such other instruments, documents and "
        "statements and to take such other actions as the General Partner "
        "may determine to be necessary or appropriate to effectuate and "
        "carry out the purposes of this Subscription Agreement, the "
        "Investor Questionnaire and the Fund Agreement."))

    # (4) No conflict
    story.append(rep("4",
        "The execution and delivery of, and/or adherence to, as applicable, "
        "this Subscription Agreement, the Investor Questionnaire, the Power "
        "of Attorney and the Fund Agreement by or on behalf of the "
        "Subscriber, the consummation of the transactions contemplated "
        "hereby and the performance of the Subscriber&rsquo;s obligations "
        "under this Subscription Agreement, the Power of Attorney and the "
        "Fund Agreement will not conflict with, or result in any violation "
        "of or default under, any provision of any governing instrument "
        "applicable to the Subscriber, or any agreement or other instrument "
        "to which the Subscriber is a party or by which the Subscriber or "
        "any of its properties are bound, or any United States or non-United "
        "States permit, franchise, judgment, decree, statute, order, rule "
        "or regulation applicable to the Subscriber or the Subscriber&rsquo;s "
        "business or properties."))

    # (5) Risk Factors
    story.append(rep("5",
        "The Subscriber (or its authorized representative) has examined the "
        "materials it has received from the General Partner, including the "
        "PPM and the Risk Factors Summary attached as <b>Appendix D</b> "
        "hereto, and recognizes that the Fund has very little material or "
        "operating history and that an investment in the Fund involves a "
        "high degree of risk."))

    # (6) Continuing
    story.append(rep("6",
        "The Subscriber agrees that the Subscriber&rsquo;s representations, "
        "agreements, acknowledgments and understandings are all continuing "
        "and that all further subscriptions for an additional limited "
        "partnership Interest will be governed by them, and the act of "
        "making any subscriptions for an additional limited partnership "
        "Interest will be evidence of the Subscriber&rsquo;s reaffirmation "
        "of such representations, agreements, acknowledgments and "
        "understandings."))

    # (7) No registration / no recommendation
    story.append(rep("7",
        "The Subscriber (or its authorized representative) recognizes that "
        "(a) the Fund Agreement prohibits the sale, pledge, assignment, or "
        "other transfer of a limited partnership Interest without the prior "
        "written consent of the General Partner (which consent may be "
        "withheld in its sole discretion); (b) the limited partnership "
        "Interest has not been registered under the Securities Act; (c) the "
        "Fund has not been registered under the Investment Company Act, "
        "(d) neither will be so registered, and (e) no U.S. federal or "
        "state agency has passed upon or made any recommendation or "
        "endorsement of an investment in the Fund."))

    # (8) QUALIFIED CLIENT + ACCREDITED INVESTOR (FIXED per Recommendation #1)
    story.append(rep("8",
        "The Subscriber is an &ldquo;<b>accredited investor</b>&rdquo; as "
        "that term is defined in Rule 501(a) of Regulation D promulgated "
        "under the Securities Act, and is also a &ldquo;<b>qualified "
        "client</b>&rdquo; as that term is defined in Rule 205-3 under the "
        "Investment Advisers Act of 1940, as amended (the &ldquo;<b>Advisers "
        "Act</b>&rdquo;). The Subscriber acknowledges that the Subscriber&rsquo;s "
        "accredited-investor status will be verified by a third-party verifier "
        "acceptable to the General Partner (a FINRA-registered "
        "broker-dealer, an SEC-registered investment adviser, a licensed "
        "attorney in good standing, or a certified public accountant in "
        "good standing) pursuant to Rule 506(c)(2)(ii) under the Securities "
        "Act, and that self-certification is not sufficient. State-registered "
        "investment advisers are not acceptable verifiers under Rule "
        "506(c)(2)(ii)(C). Documentary verification will consist of (i) a "
        "review of two most recent years of U.S. federal income tax returns "
        "and a written representation concerning expected current-year "
        "income (for the income test), or (ii) account statements dated "
        "within the prior three months plus consumer credit reports or "
        "similar evidence of liabilities (for the net worth test), or "
        "(iii) written confirmation from a qualifying third-party verifier "
        "dated within 90 days prior to admission."))

    # (9) Flow-through 70% attribution
    story.append(rep("9",
        "If the Subscriber is a partnership, a limited liability company "
        "treated as a partnership for United States federal income tax "
        "purposes, a grantor trust (within the meaning of Sections 671-679 "
        "of the Code), or an S-corporation (within the meaning of Code "
        "Section 1361) (each, a &ldquo;<b>flow-through entity</b>&rdquo;), "
        "the Subscriber represents and warrants that either:"))
    story.append(rep_sub("a",
        "no person or entity will own, directly or indirectly through one or "
        "more flow-through entities, an interest in the Subscriber such that "
        "more than seventy percent (70%) of the value of such person&rsquo;s "
        "or entity&rsquo;s interest in the Subscriber is attributable to "
        "the Subscriber&rsquo;s investment in the Fund; or"))
    story.append(rep_sub("b",
        "if one or more persons or entities will own, directly or indirectly "
        "through one or more flow-through entities, an interest in the "
        "Subscriber such that more than seventy percent (70%) of the value "
        "of such person&rsquo;s or entity&rsquo;s interest in the Subscriber "
        "is attributable to the Subscriber&rsquo;s investment in the Fund, "
        "neither the Subscriber nor any such person or entity has or had "
        "any intent or purpose to cause such person (or persons) or entity "
        "(or entities) to invest in the Fund indirectly through the "
        "Subscriber in order to enable the Fund to qualify for the 100-partner "
        "safe harbor under U.S. Department of Treasury Regulation "
        "&sect;1.7704-1(h)."))

    # (10) ERISA Plan Asset reps
    story.append(rep("10",
        "The Subscriber represents and warrants that, except as disclosed "
        "by the Subscriber to the General Partner in the Investor "
        "Questionnaire, the Subscriber is not (i) an &ldquo;employee "
        "benefit plan&rdquo; that is subject to Title I of the United "
        "States Employee Retirement Income Security Act of 1974, as amended "
        "(&ldquo;<b>ERISA</b>&rdquo;), (ii) an individual retirement account "
        "or annuity or other &ldquo;plan&rdquo; that is subject to Code "
        "&sect;4975, or (iii) a fund of funds, an insurance company "
        "separate account or an insurance company general account or "
        "another entity or account (such as a group trust), in each case "
        "whose underlying assets are deemed under the U.S. Department of "
        "Labor regulation codified at 29 C.F.R. &sect; 2510.3-101, as "
        "modified by Section 3(42) of ERISA (the &ldquo;<b>Plan Asset "
        "Regulation</b>&rdquo;), to include &ldquo;plan assets&rdquo; of "
        "any &ldquo;employee benefit plan&rdquo; subject to ERISA or "
        "&ldquo;plan&rdquo; subject to Code &sect;4975 (each of (i) through "
        "(iii), a &ldquo;<b>Benefit Plan Investor</b>&rdquo;). If the "
        "Subscriber has indicated in the Investor Questionnaire that it is "
        "not a Benefit Plan Investor, it represents, warrants and covenants "
        "that it shall not become a Benefit Plan Investor for so long as it "
        "holds Interests. If the Subscriber is (x) a Benefit Plan Investor "
        "or (y) a governmental plan or other retirement arrangement "
        "(collectively with Benefit Plan Investors, &ldquo;<b>Plans</b>"
        "&rdquo;), the Subscriber makes the following additional "
        "representations, warranties and covenants:"))

    story.append(rep_sub("a",
        "The Plan&rsquo;s decision to invest in the Fund was made by duly "
        "authorized fiduciaries in accordance with the Plan&rsquo;s "
        "governing documents, which fiduciaries are independent of the "
        "Fund, the General Partner, the Investment Manager, and their "
        "Affiliates. No advice or recommendations of the Fund, the General "
        "Partner, the Investment Manager, or any of their Affiliates was "
        "relied upon by such fiduciaries in deciding to invest in the Fund. "
        "Such fiduciaries have considered any fiduciary duties or other "
        "obligations arising under ERISA, Code &sect;4975 and any other "
        "non-U.S., federal, state or local law substantially similar to "
        "ERISA or Code &sect;4975 (&ldquo;<b>Similar Law</b>&rdquo;), "
        "including any regulations, rules and procedures issued thereunder "
        "and related judicial interpretations, in determining to invest in "
        "the Fund, and such fiduciaries have determined that an investment "
        "in the Fund is consistent with such fiduciary duties and other "
        "obligations."))
    story.append(rep_sub("b",
        "No discretionary authority or control was exercised by the Fund, "
        "the General Partner, the Investment Manager, or any of their "
        "Affiliates in connection with the Plan&rsquo;s investment in the "
        "Fund. No individualized investment advice was provided to the "
        "Plan by the Fund, the General Partner, the Investment Manager or "
        "their Affiliates based upon the Plan&rsquo;s investment policies "
        "or strategies, overall portfolio composition or diversification "
        "with respect to its investment in the Fund."))
    story.append(rep_sub("c",
        "The Subscriber acknowledges and agrees that the Fund does not "
        "intend to hold plan assets of the Plan and that none of the Fund, "
        "the General Partner, the Investment Manager, or any of their "
        "Affiliates will act as a fiduciary to the Plan under ERISA, the "
        "Code or any Similar Law with respect to the Subscriber&rsquo;s "
        "purchase or retention of an Interest in the Fund or the management "
        "or operation of the Fund."))
    story.append(rep_sub("d",
        "Assuming the assets of the Fund are not &ldquo;plan assets&rdquo; "
        "within the meaning of Section 3(42) of ERISA, the Subscriber&rsquo;s "
        "acquisition and holding of Interests will not constitute or result "
        "in a non-exempt &ldquo;prohibited transaction&rdquo; under ERISA "
        "or Code &sect;4975 or a violation of any Similar Law."))
    story.append(rep_sub("e",
        "The information provided in the Investor Questionnaire is true "
        "and accurate as of the date hereof; such information will remain "
        "true and accurate for so long as the Subscriber holds an Interest "
        "in the Fund; and the Subscriber agrees to notify the Fund "
        "immediately if it has any reason to believe that it is or may be "
        "in breach of the foregoing representation and covenant."))

    # (11) GP power to restrict / remove
    story.append(rep("11",
        "The Subscriber acknowledges that the General Partner has the power "
        "to restrict or prevent the ownership of Interests in the Fund by "
        "any person for any reason. The Subscriber further acknowledges "
        "that the General Partner, in its sole discretion, may deem an "
        "investor to have withdrawn if (a) such investor fails to make "
        "timely capital contributions, (b) the General Partner determines "
        "in its sole discretion that continued undiminished participation "
        "of such investor in the Fund would (i) constitute or give rise to "
        "a violation of applicable law, (ii) otherwise subject the Fund or "
        "the General Partner to additional legal, tax or other regulatory "
        "requirements that cannot reasonably be avoided, or (iii) cause the "
        "Fund or any investor to fail to qualify for the &ldquo;private "
        "placement&rdquo; safe harbor from publicly traded partnership "
        "status set forth in Treasury Regulation Section 1.7704-1(h), or "
        "(c) any litigation is commenced or threatened against the Fund or "
        "any of its investors arising out of, or relating to, such "
        "investor&rsquo;s participation in the Fund."))

    # (12) ERISA Transaction Parties
    story.append(rep("12",
        "The General Partner, the Investment Manager and their respective "
        "Affiliates and agents (the &ldquo;<b>ERISA Transaction Parties</b>"
        "&rdquo;) hereby inform the Subscriber that none of the ERISA "
        "Transaction Parties is undertaking to provide impartial investment "
        "advice, or to give advice in a fiduciary capacity, in connection "
        "with the acquisition of any of the Interests in the Fund by any "
        "Plan or IRA (each, a &ldquo;<b>Plan Investor</b>&rdquo; and "
        "collectively, &ldquo;<b>Plan Investors</b>&rdquo;). Any Person "
        "purchasing Interests on behalf of a Plan Investor (the &ldquo;"
        "<b>Plan Investor Fiduciary</b>&rdquo;) hereby represents, in its "
        "corporate and its fiduciary capacity, by its purchase and holding "
        "of the Interests (the &ldquo;<b>Transaction</b>&rdquo;) that:"))
    story.append(rep_sub("f",
        "none of the ERISA Transaction Parties has provided or will provide "
        "advice with respect to the acquisition of the Interests by the "
        "Plan Investor, other than to the Plan Investor Fiduciary which is "
        "independent of the ERISA Transaction Parties, and the Plan "
        "Investor Fiduciary either: (A) is a bank as defined in Section 202 "
        "of the Advisers Act, or similar institution that is regulated and "
        "supervised and subject to periodic examination by a State or "
        "Federal agency; (B) is an insurance carrier which is qualified "
        "under the laws of more than one state to perform the services of "
        "managing, acquiring or disposing of assets of a Plan Investor; "
        "(C) is an investment adviser registered under the Advisers Act, "
        "or, if not registered as an investment adviser under the Advisers "
        "Act by reason of paragraph (1) of Section 203A of the Advisers "
        "Act, is registered as an investment adviser under the laws of "
        "the state in which it maintains its principal office and place of "
        "business; (D) is a broker-dealer registered under the Securities "
        "Exchange Act of 1934 (the &ldquo;<b>Exchange Act</b>&rdquo;); or "
        "(E) has, and at all times that the Plan Investor is invested in "
        "the Interests will have, total assets of at least U.S. $50,000,000 "
        "under its management or control (provided that this clause (E) "
        "shall not be satisfied if the Plan Investor Fiduciary is either "
        "(i) the owner or a relative of the owner of an investing IRA or "
        "(ii) a participant or beneficiary of the Plan Investor investing "
        "in the Interests in such capacity);"))
    story.append(rep_sub("g",
        "the Plan Investor Fiduciary is capable of evaluating investment "
        "risks independently, both in general and with respect to "
        "particular transactions and investment strategies, including the "
        "acquisition by the Plan Investor of the limited partnership "
        "Interests;"))
    story.append(rep_sub("h",
        "the Plan Investor Fiduciary is a &ldquo;fiduciary&rdquo; with "
        "respect to the Plan Investor within the meaning of Section 3(21) "
        "of ERISA, Section 4975 of the Code, or both, and is responsible "
        "for exercising independent judgment in evaluating the Plan "
        "Investor&rsquo;s acquisition of the limited partnership Interests;"))
    story.append(rep_sub("i",
        "none of the ERISA Transaction Parties has exercised any authority "
        "to cause the Plan Investor to invest in the limited partnership "
        "Interests or to negotiate the terms of the Plan Investor&rsquo;s "
        "investment in the limited partnership Interests; and"))
    story.append(rep_sub("j",
        "the Plan Investor Fiduciary has been informed by the ERISA "
        "Transaction Parties: (A) that none of the ERISA Transaction "
        "Parties is undertaking to provide impartial investment advice or "
        "to give advice in a fiduciary capacity, and that no such entity "
        "has given investment advice or otherwise made a recommendation, "
        "in connection with the Plan Investor&rsquo;s acquisition of the "
        "limited partnership Interests; and (B) of the existence and "
        "nature of the ERISA Transaction Parties&rsquo; financial interests "
        "in the Plan Investor&rsquo;s acquisition of the limited "
        "partnership Interests."))

    # (13) Withdrawals / transfers subject to GP approval
    story.append(rep("13",
        "The Subscriber acknowledges that under the terms of the Fund "
        "Agreement, withdrawals and transfers are subject to the approval "
        "of the General Partner in its sole discretion, and subject to the "
        "Lock-Up Period, Withdrawal Gate, Audit Holdback, Early-Withdrawal "
        "Penalty, and other restrictions set forth in Section 8.06 of the "
        "Fund Agreement. Minimum withdrawal amount is $25,000, and a "
        "Capital Account floor of $50,000 applies."))

    # (14) GP right to reject / redeem
    story.append(rep("14",
        "The Subscriber acknowledges that the General Partner has the "
        "right, in its absolute discretion, to reject the admission to the "
        "Fund of any prospective investor, or redeem the Interest of any "
        "investor, for any reason or for no reason, including, without "
        "limitation, the admission or continuation of a person who would "
        "cause (i) the Fund to be required to register as an investment "
        "company under the Investment Company Act, (ii) any Interests to "
        "be required to be registered under the Securities Act, or (iii) "
        "the Fund&rsquo;s assets to be deemed to be &ldquo;plan assets&rdquo; "
        "for purposes of ERISA. Moreover, the Fund has the right, which it "
        "may exercise in its sole discretion, to compulsorily redeem any "
        "Interests of any investor, the continued ownership of which by "
        "such investor could result in adverse tax or regulatory "
        "consequences to the Fund or its other investors."))

    # (15) Transfer restrictions
    story.append(rep("15",
        "The Subscriber will not permit any other person to have any "
        "beneficial interest in its limited partnership Interest. The "
        "Subscriber agrees not to transfer all or any portion of its "
        "limited partnership Interest except with the prior written consent "
        "of the General Partner. The Subscriber will not transfer, directly "
        "or indirectly, any of a limited partnership Interest or any "
        "interest therein (including without limitation any right to "
        "receive distributions) to any person or entity unless (a) the "
        "proposed transferee has made representations and warranties "
        "similar to those contained herein (including without limitation "
        "those relating to the Securities Act and the Investment Company "
        "Act) and such representations and warranties have been approved by "
        "the General Partner, (b) such limited partnership Interest is "
        "registered pursuant to the provisions of the Securities Act, or "
        "an exemption from registration is available, and (c) the General "
        "Partner has provided its prior written consent to such transfer, "
        "which consent may be granted or withheld in the General "
        "Partner&rsquo;s sole discretion. If the limited partnership "
        "Interest purchased under this Subscription Agreement is being "
        "acquired by the Subscriber as nominee or custodian for another "
        "person or entity, the Subscriber will not permit the beneficial "
        "owners of such limited partnership Interest to transfer any "
        "beneficial interest in the limited partnership Interest, directly "
        "or indirectly, to any person or entity unless the representations "
        "made by the Subscriber in this Subscription Agreement will continue "
        "to be true. The Subscriber also agrees to notify the General "
        "Partner at its address given above if the Subscriber changes its "
        "citizenship or residence, and the Subscriber understands that the "
        "General Partner may cause the Subscriber to be retired from the "
        "Fund for any reason, including if the Subscriber is no longer an "
        "eligible investor or to avoid adverse tax or regulatory "
        "consequences to the Fund or its other Partners. The Subscriber "
        "will supply the General Partner with such other facts as the "
        "General Partner shall from time to time decide shall be necessary "
        "or desirable in order to avoid the loss of a contemplated tax "
        "benefit to the Fund or any of its Partners and in order to "
        "ascertain that no violation by the Fund shall occur of any "
        "securities laws of the United States or any other relevant "
        "jurisdiction, including the Securities Act, the Investment "
        "Company Act and the Advisers Act."))

    # (16) No offering literature
    story.append(rep("16",
        "The Subscriber (or its authorized representative) understands "
        "that the limited partnership Interest is being purchased without "
        "the furnishing of any offering literature or prospectus other "
        "than the PPM."))

    # (17) Management fees acknowledgment (UPDATED: Investment Manager, not Management Company)
    story.append(rep("17",
        "The Subscriber (or its authorized representative) recognizes that "
        "the General Partner, the Investment Manager and any of their "
        "Affiliates and agents may receive certain management fees and "
        "Performance Allocations paid from the assets of the Fund. The "
        "Subscriber (or its authorized representative) understands that "
        "the General Partner, the Investment Manager and any of their "
        "Affiliates or agents are not precluded from exercising investment "
        "responsibility, from engaging directly or indirectly in any other "
        "business, or from directly or indirectly purchasing, selling, "
        "holding or otherwise dealing in any securities for the account of "
        "any such other business, for their own account, for any of their "
        "family members or for other clients, and that no Partner, by "
        "reason of being a Partner in the Fund, shall have any right to "
        "participate in any manner in any profits or income earned or "
        "derived by or accruing to either the General Partner, the "
        "Investment Manager or any of their Affiliates or agents from the "
        "conduct of any business other than the business of the Fund or "
        "from any transaction in securities effected by the General "
        "Partner, the Investment Manager or any of their Affiliates or "
        "agents for any account other than that of the Fund."))

    # (18) Sole reliance
    story.append(rep("18",
        "The Subscriber is entering into this Subscription Agreement "
        "relying solely on the facts and terms set forth in this "
        "Subscription Agreement, the Fund Agreement and any of the "
        "respective Exhibits thereto; the Subscriber first learned of the "
        "Fund in the state listed as the residence address on the signature "
        "page hereto, and intends that the securities laws of that state "
        "alone govern this transaction; none of the Fund, the General "
        "Partner or the Investment Manager have made any representations "
        "or warranties of any kind or nature to induce the Subscriber to "
        "enter into this Subscription Agreement except as specifically set "
        "forth therein; the Subscriber is not relying upon the Fund, the "
        "General Partner or the Investment Manager for guidance with "
        "respect to tax or other law or economic considerations; and the "
        "Subscriber has been afforded an opportunity to ask questions of, "
        "and receive answers from, the General Partner and/or persons "
        "authorized to act on its behalf, concerning the terms and "
        "conditions of the purchase of the limited partnership Interest "
        "and has been afforded the opportunity to obtain any additional "
        "information (to the extent the General Partner has such "
        "information or could acquire it without unreasonable effort or "
        "expense) necessary to verify the accuracy of information "
        "otherwise furnished by the General Partner."))

    # (19) Entity not formed to acquire
    story.append(rep("19",
        "If the Subscriber is a partnership, corporation, trust or other "
        "entity, the Subscriber further represents and warrants that "
        "(i) the Subscriber was not specifically formed to acquire the "
        "limited partnership Interest subscribed for herein, (ii) the "
        "equity owners of the Subscriber share in the profits and losses "
        "of all investments of the Subscriber in the same way on the basis "
        "of their proportional ownership, and have <i>pro rata</i> "
        "interests in specified investments of the Subscriber, and "
        "(iii) neither the Subscriber nor any person owning an interest in "
        "the Subscriber owns an Interest in the Fund or any other Partner "
        "of the Fund except through its Interests in the Fund."))

    # (20) No distribution of Fund Agreement
    story.append(rep("20",
        "The Subscriber has not distributed the Fund Agreement to any "
        "person and no person other than the Subscriber has used the "
        "materials received by the Subscriber."))

    # (21) Individual US citizen or permanent resident
    story.append(rep("21",
        "The Subscriber, if an individual, is a citizen or permanent "
        "resident alien of the United States of America, is at least 21 "
        "years of age, and has the legal capacity to execute, deliver and "
        "perform this Agreement."))

    # (22) Bad Actor (Rule 506(d))
    story.append(rep("22",
        "The Subscriber has not been subject to any Regulation D Rule "
        "506(d) disqualifying event as defined below and is not subject to "
        "any proceeding or event that could result in any such disqualifying "
        "event (a &ldquo;<b>Disqualifying Event</b>&rdquo;). The following "
        "representations as well as each direct or indirect beneficial "
        "owner of the Subscriber that would own twenty percent (20%) or "
        "more of the Fund&rsquo;s Interests if such owner were a direct "
        "limited partner in the Fund (each a &ldquo;<b>Significant "
        "Owner</b>&rdquo;). By way of example only, if the Subscriber "
        "owns 40% of the Fund&rsquo;s Interests, the Subscriber would have "
        "a Significant Owner if one of the Subscriber&rsquo;s beneficial "
        "owners owns 50% or more of the outstanding equity of the "
        "Subscriber. Each of the enumerated instances below is a "
        "&ldquo;<b>Disqualifying Event</b>&rdquo;. The Subscriber has been "
        "subject to a Disqualifying Event if the Subscriber:"))

    for (letter_label, text) in [
        ("k", "Has been convicted within ten years of the date hereof of "
              "any felony or misdemeanor (i) in connection with the purchase "
              "or sale of any security, (ii) involving the making of any "
              "false filing with the U.S. Securities and Exchange Commission "
              "(the &ldquo;<b>SEC</b>&rdquo;) or (iii) arising out of the "
              "conduct of the business of an underwriter, broker, dealer, "
              "municipal securities dealer, investment adviser or paid "
              "solicitor of purchasers of securities;"),
        ("l", "Is subject to any order, judgment or decree of any court of "
              "competent jurisdiction entered within five years of the date "
              "hereof that presently restrains or enjoins the Subscriber "
              "from engaging or continuing to engage in any conduct or "
              "practice (i) in connection with the purchase or sale of any "
              "security, (ii) involving the making of any false filing with "
              "the SEC or (iii) arising out of the conduct of the business "
              "of an underwriter, broker, dealer, municipal securities "
              "dealer, investment adviser or paid solicitor of purchasers "
              "of securities;"),
        ("m", "Is subject to a final order of a state securities commission "
              "(or an agency or officer of a state performing like "
              "functions); a state authority that supervises or examines "
              "banks, savings associations or credit unions; a state "
              "insurance commission (or an agency or officer of a state "
              "performing like functions); an appropriate federal banking "
              "agency; the U.S. Commodity Futures Trading Commission; or "
              "the National Credit Union Administration that (i) as of the "
              "date hereof, bars the Subscriber from (A) association with "
              "an entity regulated by such commission, authority, agency or "
              "officer, (B) engaging in the business of securities, "
              "insurance or banking or (C) engaging in savings association "
              "or credit union activities or (ii) constitutes a final order "
              "based on a violation of any law or regulation that prohibits "
              "fraudulent, manipulative or deceptive conduct entered within "
              "ten years of the date hereof;"),
        ("n", "Is subject to any order of the SEC pursuant to Section 15(b) "
              "or 15B(c) of the Exchange Act or Section 203(e) or (f) of "
              "the Advisers Act that as of the date hereof (i) suspends or "
              "revokes the Subscriber&rsquo;s registration as a broker, "
              "dealer, municipal securities dealer or investment adviser, "
              "(ii) places limitations on the activities, functions or "
              "operations of the Subscriber or (iii) bars the Subscriber "
              "from being associated with any entity or from participating "
              "in the offering of any penny stock;"),
        ("o", "Is subject to any order of the SEC entered within five "
              "years of the date hereof that presently orders the "
              "Subscriber to cease and desist from committing or causing a "
              "violation or future violation of (i) any scienter-based "
              "anti-fraud provision of the federal securities laws or "
              "(ii) Section 5 of the Securities Act;"),
        ("p", "Is, as of the date hereof, suspended or expelled from "
              "membership in, or suspended or barred from association with "
              "a member of, a registered national securities exchange or a "
              "registered national or affiliated securities association for "
              "any act or omission to act constituting conduct inconsistent "
              "with just and equitable principles of trade;"),
        ("q", "Has filed (as a registrant or issuer), or was or was named "
              "as an underwriter in, any registration statement or "
              "Regulation A offering statement filed with the SEC that, "
              "within five years of the date hereof, was the subject of a "
              "refusal order, stop order or order suspending the Regulation "
              "A exemption, or is presently the subject of an investigation "
              "or proceeding to determine whether a stop order or "
              "suspension order should be issued; or"),
        ("r", "Is subject to a United States Postal Service false "
              "representation order entered within five years of the date "
              "hereof or is presently subject to a temporary restraining "
              "order or preliminary injunction with respect to conduct "
              "alleged by the United States Postal Service to constitute a "
              "scheme or device for obtaining money or property through the "
              "mail by means of false representations."),
        # (s) FIXED: clauses (a)-(h) -> clauses (k)-(r)
        ("s", "To the best of Subscriber&rsquo;s knowledge, neither "
              "Subscriber nor any Significant Owner is currently the "
              "subject of any threatened or pending investigation, "
              "proceeding, action or other event that, if adversely "
              "determined, would give rise to any of the events described "
              "in clauses <b>(k)-(r)</b> above."),
    ]:
        story.append(rep_sub(letter_label, text))

    # (23) Notify on Disqualifying Event
    story.append(rep("23",
        "Subscriber will immediately notify the General Partner in writing "
        "if Subscriber becomes subject to a Disqualifying Event at any "
        "date after the date hereof. In the event that Subscriber becomes "
        "subject to a Disqualifying Event at any date after the date "
        "hereof, Subscriber agrees and covenants to use its best efforts "
        "to coordinate with the General Partner (i) to provide "
        "documentation as reasonably requested by the General Partner "
        "related to any such Disqualifying Event and (ii) to implement a "
        "remedy to address Subscriber&rsquo;s changed circumstances such "
        "that the changed circumstances will not affect in any way the "
        "Fund&rsquo;s or its affiliates&rsquo; ongoing and/or future "
        "reliance on the Rule 506 exemption under the Securities Act. "
        "Subscriber acknowledges that, at the discretion of the General "
        "Partner, such remedies may include, without limitation, the "
        "waiver of all or a portion of the Subscriber&rsquo;s voting "
        "power in the Fund, the Subscriber&rsquo;s removal from the Fund, "
        "and/or the Subscriber&rsquo;s withdrawal from the Fund through "
        "the transfer or sale of its limited partnership Interest in the "
        "Fund. Subscriber also acknowledges that the General Partner may "
        "periodically request assurance that Subscriber has not become "
        "subject to a Disqualifying Event at any date after the date "
        "hereof, and Subscriber further acknowledges and agrees that the "
        "General Partner shall understand and deem the failure by "
        "Subscriber to respond in writing to such requests to be an "
        "affirmation and restatement of the representations, warranties "
        "and covenants in this paragraph and the preceding paragraph 22."))

    # (24) Beneficial ownership 13d-3/5
    story.append(rep("24",
        "Except as otherwise disclosed in writing to the General Partner, "
        "the Subscriber and any Beneficial Owner of the Subscriber (as "
        "defined below) do not and will not &ldquo;beneficially own&rdquo; "
        "(within the meaning of Rule 13d-3 of the Exchange Act) any other "
        "limited partner interest in the Fund except for the limited "
        "partnership Interest subscribed to by the Subscriber in this "
        "Agreement, and the Subscriber and any Beneficial Owner of the "
        "Subscriber has not agreed with one or more other Limited Partners "
        "(or the &ldquo;beneficial owners&rdquo; of such Limited Partner(s)) "
        "to act together for the purpose of acquiring, holding, voting or "
        "disposing of limited partner interests in the Fund (within the "
        "meaning of Rule 13d-5 of the Exchange Act). &ldquo;<b>Beneficial "
        "Owner of the Subscriber</b>&rdquo; means an individual or entity "
        "who, directly or indirectly, through any contract, arrangement, "
        "understanding, relationship or otherwise has or shares, or is "
        "deemed to have or share with respect to any Interest: (1) voting "
        "power, which includes the power to vote, or to direct the voting "
        "of, such Interest; and/or (2) investment power, which includes "
        "the power to dispose, or to direct the disposition of, such "
        "Interest, as determined consistent with Rule 13d-3 of the "
        "Exchange Act."))

    # (25) PEP / OFAC / AML
    story.append(rep("25",
        "The Subscriber represents that (except as otherwise disclosed to "
        "the General Partner in writing):"))
    for (letter_label, text) in [
        ("t", "Neither it, any Beneficial Interest Holder nor any Related "
              "Person (in the case of a Subscriber that is an entity) is a "
              "Senior Foreign Political Figure, any member of a Senior "
              "Foreign Political Figure&rsquo;s Immediate Family or any "
              "Close Associate of a Senior Foreign Political Figure;"),
        ("u", "It is not and, to the best of its knowledge or belief, none "
              "of its beneficial owners, controllers or authorized persons "
              "(if any) is, a Politically Exposed Person, or a Family "
              "Member or Close Associate of a Politically Exposed Person, "
              "or is acting on behalf of a Politically Exposed Person. "
              "Further, the Subscriber understands that enhanced due "
              "diligence may need to be undertaken, and the Subscriber "
              "reserves the right to decline the subscription, where the "
              "Subscriber or any of its beneficial owners, controllers or "
              "authorized persons is a Politically Exposed Person, or a "
              "Family Member or Close Associate of a Politically Exposed "
              "Person, or is acting on behalf of a Politically Exposed "
              "Person;"),
        ("v", "Neither it, any Beneficial Interest Holder nor any Related "
              "Person (in the case of a Subscriber that is an entity) is "
              "resident in, or organized or chartered under the laws of, a "
              "jurisdiction that has been designated by the Secretary of "
              "the Treasury under the USA PATRIOT Act as warranting "
              "special measures due to money laundering concerns;"),
        ("w", "Its subscription funds do not originate from, nor will they "
              "be routed through, an account maintained at a Foreign "
              "Shell Bank, an &ldquo;offshore bank,&rdquo; or a bank "
              "organized or chartered under the laws of a Non-Cooperative "
              "Jurisdiction;"),
        ("x", "None of the Subscriber&rsquo;s capital contributions to the "
              "Fund (whether payable in cash or otherwise) (i) have been "
              "or shall be derived from money laundering or similar "
              "activities deemed illegal under such laws and regulations; "
              "(ii) will cause the Fund, the General Partner, the "
              "Investment Manager or any of their personnel to be in "
              "violation of U.S. anti-money laundering laws, including "
              "without limitation the United States Bank Secrecy Act (31 "
              "U.S.C. &sect; 5311 et seq.), the United States Money "
              "Laundering Control Act of 1986, the International Money "
              "Laundering Abatement and Anti-Terrorist Financing Act of "
              "2001, and any regulations promulgated thereunder; including "
              "any other applicable laws, regulations or administrative "
              "pronouncements concerning money laundering, criminal "
              "activities or government sanctions;"),
        ("y", "To the best of the Subscriber&rsquo;s knowledge or belief, "
              "none of its beneficial owners, controllers or authorized "
              "persons (if any) is (i) named on any list of sanctioned "
              "entities or individuals maintained by the US Treasury "
              "Department&rsquo;s Office of Foreign Assets Control "
              "(&ldquo;<b>OFAC</b>&rdquo;) or pursuant to European Union "
              "(&ldquo;<b>EU</b>&rdquo;) and/or United Kingdom "
              "(&ldquo;<b>UK</b>&rdquo;) Regulations, (ii) operationally "
              "based or domiciled in a country or territory in relation "
              "to which sanctions imposed by the United Nations, OFAC, "
              "the EU and/or the UK apply, or (iii) otherwise subject to "
              "sanctions imposed by the United Nations, OFAC, the EU or "
              "the UK (collectively, a &ldquo;<b>Sanctions Subject</b>"
              "&rdquo;). The Subscriber acknowledges and agrees that "
              "(i) should the Subscriber or one of its beneficial owners, "
              "controllers or authorized persons be, or become at any "
              "time during its investment in the Fund, a Sanctions "
              "Subject, the Fund or its duly authorized delegates may "
              "immediately and without notice to the Subscriber cease any "
              "further dealings with the Subscriber and/or the "
              "Subscriber&rsquo;s interest in the Fund until the "
              "Subscriber ceases to be a Sanctions Subject or a license "
              "is obtained under applicable law to continue such dealings "
              "(a &ldquo;<b>Sanctioned Persons Event</b>&rdquo;), and "
              "(ii) the Fund shall have no liability whatsoever for any "
              "liabilities, costs, expenses, damages and/or losses "
              "(including but not limited to any direct, indirect or "
              "consequential losses, loss of profit, loss of revenue, "
              "loss of reputation and all interest, penalties and legal "
              "costs and all other professional costs and expenses) "
              "incurred by the Investor as a result of a Sanctioned "
              "Persons Event."),
    ]:
        story.append(rep_sub(letter_label, text))

    # (25)(z) Definitions
    story.append(P("<b>(z)</b>&nbsp;&nbsp;<b>Definitions.</b>",
                   REP_SUB))
    defs = [
        ("i. Beneficial Interest Holder",
         "Holder of any beneficial interest in the Subscriber&rsquo;s equity securities."),
        ("ii. Close Associate",
         "With respect to a Senior Foreign Political Figure, a person "
         "who is widely and publicly known internationally to maintain "
         "an unusually close relationship with the Senior Foreign "
         "Political Figure, and includes a person who is in a position to "
         "conduct substantial domestic and international financial "
         "transactions on behalf of the Senior Foreign Political Figure. "
         "With respect to a Politically Exposed Person, for the purposes "
         "of 25(u) above, Close Associate means any natural person who "
         "is known to hold the ownership or control of a legal instrument "
         "or person jointly with a Politically Exposed Person, or who "
         "maintains some other kind of close business or personal "
         "relationship with a Politically Exposed Person, or who holds "
         "the ownership or control of a legal instrument or person which "
         "is known to have been established to the benefit of a "
         "Politically Exposed Person."),
        ("iii. Family Member",
         "Means the spouse, parent, sibling or child of a politically exposed person."),
        ("iv. FATF",
         "The Financial Action Task Force on Money Laundering."),
        ("v. Foreign Bank",
         "An organization which (i) is organized under the laws of a "
         "country outside the United States; (ii) engages in the "
         "business of banking; (iii) is recognized as a bank by the bank "
         "supervisory or monetary authority of the country of its "
         "organization or principal banking operations; (iv) receives "
         "deposits to a substantial extent in the regular course of its "
         "business; and (v) has the power to accept demand deposits, but "
         "does not include the U.S. branches or agencies of a foreign "
         "bank."),
        ("vi. Foreign Shell Bank",
         "A Foreign Bank that accepts currency for deposit and that "
         "(a) has no physical presence in the jurisdiction in which it "
         "is incorporated or in which it is operating, as the case may "
         "be, and (b) is unaffiliated with a regulated financial group "
         "that is subject to consolidated supervision, but does not "
         "include a Regulated Affiliate."),
        ("vii. Immediate Family",
         "With respect to a Senior Foreign Political Figure, typically "
         "includes the political figure&rsquo;s parents, siblings, "
         "spouse, children and in-laws."),
        ("viii. Non-Cooperative Jurisdiction",
         "Any foreign country or territory that has been designated as "
         "non-cooperative with international anti-money laundering "
         "principles or procedures by an intergovernmental group or "
         "organization, such as FATF, of which the United States is a "
         "member and with which designation the United States "
         "representative to the group or organization continues to "
         "concur."),
        ("ix. PATRIOT Act",
         "The Uniting and Strengthening America by Providing "
         "Appropriate Tools Required to Intercept and Obstruct Terrorism "
         "(USA PATRIOT Act) Act of 2001 (Pub. L. No. 107-56)."),
        ("x. Politically Exposed Person",
         "Means (a) a person who is or has been entrusted with prominent "
         "public functions by a foreign country, for example a Head of "
         "State or of government, senior politician, senior government, "
         "judicial or military official, senior executive of a state "
         "owned corporation, and important political party official; "
         "(b) a person who is or has been entrusted domestically with "
         "prominent public functions, for example a Head of State or of "
         "government, senior politician, senior government, judicial or "
         "military official, senior executives of a state owned "
         "corporation and important political party official; and (c) a "
         "person who is or has been entrusted with a prominent function "
         "by an international organization like a member of senior "
         "management, such as a director, a deputy director and a "
         "member of the board or equivalent functions."),
        ("xi. Physical Presence",
         "A place of business maintained by a Foreign Bank and is "
         "located at a fixed address, other than solely a post office "
         "box or an electronic address, in a country in which the "
         "Foreign Bank is authorized to conduct banking activities, at "
         "which location the Foreign Bank: (a) employs one or more "
         "individuals on a full-time basis; (b) maintains operating "
         "records related to its banking activities; and (c) is subject "
         "to inspection by the banking authority that licensed the "
         "Foreign Bank to conduct banking activities."),
        ("xii. Publicly Traded Company",
         "An entity whose securities are listed on a recognized "
         "securities exchange or quoted on an automated quotation system "
         "in the U.S. or a country other than a Non-Cooperative "
         "Jurisdiction, or a wholly-owned subsidiary of such an entity."),
        ("xiii. Qualified Plan",
         "A tax qualified pension or retirement plan in which at least "
         "100 employees participate that is maintained by an employer "
         "organized in the U.S. or is a U.S. Government Entity."),
        ("xiv. Regulated Affiliate",
         "A Foreign Shell Bank that: (a) is an affiliate of a depository "
         "institution, credit union or Foreign Bank that maintains a "
         "Physical Presence in the U.S. or a foreign country, as "
         "applicable; and (b) is subject to supervision by a banking "
         "authority in the country regulating such affiliated depository "
         "institution, credit union or Foreign Bank."),
        ("xv. Related Person",
         "With respect to any entity, any interest holder, director, "
         "senior officer, trustee, beneficiary or grantor of such "
         "entity; provided that in the case of an entity that is a "
         "Publicly Traded Company or a Qualified Plan, the term "
         "&ldquo;<b>Related Person</b>&rdquo; shall exclude any interest "
         "holder holding less than 5% of any class of securities of such "
         "Publicly Traded Company and beneficiaries of such Qualified "
         "Plan."),
        ("xvi. Senior Foreign Political Figure",
         "A senior official in the executive, legislative, administrative, "
         "military or judicial branches of a non-U.S. government "
         "(whether elected or not), a senior official of a major non-U.S. "
         "political party, or a senior executive of a non-U.S. "
         "government-owned corporation. In addition, a Senior Foreign "
         "Political Figure includes any corporation, business or other "
         "entity that has been formed by, or for the benefit of, a "
         "Senior Foreign Political Figure."),
    ]
    for label, text in defs:
        story.append(P(f"<b>{label}.</b>&nbsp;&nbsp;{text}", REP_SUB))

    # (26) AML Policies
    story.append(rep("26",
        "If the Subscriber is purchasing the limited partnership Interest "
        "as agent, representative, intermediary/nominee or in any similar "
        "capacity for any other person, or is otherwise requested to do so "
        "by the General Partner, it shall provide a copy of its anti-money "
        "laundering policies (&ldquo;<b>AML Policies</b>&rdquo;) to the "
        "General Partner. The Subscriber represents that it is in "
        "compliance with its AML Policies, its AML Policies have been "
        "approved by counsel or internal compliance personnel reasonably "
        "informed of anti-money laundering policies and their "
        "implementation, and has not received a deficiency letter, "
        "negative report or any similar determination regarding its AML "
        "Policies from independent accountants, internal auditors or some "
        "other person responsible for reviewing compliance with its AML "
        "Policies."))

    # (27) OFAC acknowledgment
    story.append(rep("27",
        "The Subscriber acknowledges that United States Federal law, "
        "regulations and Executive Orders administered by OFAC prohibit "
        "the Fund from, among other things, engaging in transactions "
        "with, and the provision of services to, certain non-U.S. "
        "countries, territories, entities and individuals identified on "
        "the list of Specially Designated Nationals and Blocked Persons "
        "created by OFAC (the &ldquo;<b>OFAC List</b>&rdquo;), and "
        "published on its website at www.treasury.gov/ofac."))

    # (28) No sanctions / shell bank
    story.append(rep("28",
        "The Subscriber represents and warrants that neither the "
        "Subscriber nor any person controlling, controlled by, or under "
        "common control with the Subscriber, nor, to the best of the "
        "Subscriber&rsquo;s knowledge, any person having a beneficial "
        "interest in the Subscriber, or for whom the Subscriber is "
        "acting as agent or nominee in connection with this investment, "
        "(a) is a country, territory, person or entity named on an OFAC "
        "list or (b) is a foreign shell bank as that term is defined by "
        "the U.S. Treasury Department."))

    # (29) PATRIOT Act AML program
    story.append(rep("29",
        "If the Subscriber is an entity designated as a &ldquo;financial "
        "institution&rdquo; in the USA PATRIOT Act of 2001 (generally "
        "including banks, trust companies, thrift institutions, agencies "
        "or branches of non-U.S. banks, investment bankers, broker-"
        "dealers, investment companies, insurance companies, futures "
        "commission merchants, commodity trading advisors, and commodity "
        "pool operators), the Subscriber confirms and warrants that it "
        "has implemented and enforces an anti-money laundering program "
        "that is compliant with the USA PATRIOT Act."))

    # (30) Freeze account
    story.append(rep("30",
        "The Subscriber acknowledges and agrees that the General Partner "
        "may &ldquo;freeze the account&rdquo; of the Subscriber, "
        "including, but not limited to, prohibiting additional "
        "contributions, declining any withdrawal requests and/or "
        "segregating the assets in the account, in compliance with "
        "governmental regulations."))

    # (31) SARs
    story.append(rep("31",
        "The Subscriber acknowledges and agrees that the General Partner, "
        "in advancing compliance with anti-money laundering statutes, "
        "regulations and orders, may file voluntarily or as required by "
        "law suspicious activity reports (&ldquo;<b>SARs</b>&rdquo;) or "
        "any other information with governmental and law enforcement "
        "agencies that identify transactions and activities that the "
        "General Partner reasonably determines to be suspicious, or is "
        "otherwise required by law."))

    # (32) SAR confidentiality
    story.append(rep("32",
        "The Subscriber acknowledges that the Fund is prohibited by law "
        "from disclosing to third parties, including the Subscriber, any "
        "filing or the substance of any SAR."))

    # (33) POA for distributed securities
    story.append(rep("33",
        "The Subscriber acknowledges that the General Partner may, in "
        "its sole discretion, require that a Subscriber receiving a "
        "distribution in kind of any Portfolio Company Securities, as a "
        "condition of such distribution, provide the General Partner "
        "with a power of attorney irrevocably constituting and "
        "appointing the General Partner as such Subscriber&rsquo;s true "
        "and lawful representative and attorney-in-fact, in the "
        "Subscriber&rsquo;s place and stead to exercise the Fund&rsquo;s "
        "rights under such investment agreement with respect to the "
        "securities so distributed. The foregoing power of attorney "
        "shall be in such form as the General Partner may determine in "
        "its discretion and shall be coupled with an interest and shall "
        "continue in full force and effect and not be affected by the "
        "subsequent death, disability, incapacity, bankruptcy, "
        "dissolution or termination of any Subscriber."))

    # (34) Info accuracy
    story.append(rep("34",
        "The Subscriber confirms that all information and documentation "
        "provided to the Fund, including, but not limited to, all "
        "information regarding the Subscriber&rsquo;s identity, "
        "business, investment objectives, and source of the funds to be "
        "invested in the Fund, is true and correct."))

    # (35) POA to GP (PRESERVED BROAD + LPA Section 5.03 cross-ref)
    story.append(rep("35",
        "Subscriber hereby grants to the General Partner a power of "
        "attorney, making, constituting and appointing the General "
        "Partner as the Subscriber&rsquo;s agent and attorney-in-fact, "
        "with power and authority to act in the Subscriber&rsquo;s behalf "
        "to execute, acknowledge and swear to the execution, "
        "acknowledgement and filing of the Fund Agreement (including "
        "the Partnership Agreement Signature Page) as well as any other "
        "documents as shall be necessary to create, operate, dissolve or "
        "liquidate the Fund in accordance with the terms of the Fund "
        "Agreement and this Agreement. In the event of conflict between "
        "the Fund Agreement and any other document executed, acknowledged "
        "or filed pursuant to this power of attorney, the Fund Agreement "
        "shall control. Notwithstanding the foregoing, the General "
        "Partner shall exercise this power of attorney consistent with "
        "the scope and limitations of the power of attorney set forth in "
        "Section 5.03 of the Fund Agreement where applicable. To the "
        "fullest extent permitted by law, this power of attorney is "
        "given to secure a proprietary interest of the General Partner "
        "and for the performance of obligations under this Agreement "
        "owed to the General Partner, is irrevocable and shall survive, "
        "and shall not be affected by, the subsequent death, disability, "
        "incapacity, incompetency, termination, bankruptcy, insolvency "
        "or dissolution of the Subscriber."))

    # (36) Personal data
    story.append(rep("36",
        "The Subscriber represents and warrants that all personal data "
        "provided to the Fund or its delegates by or on behalf of the "
        "Subscriber has been and will be provided in accordance with "
        "applicable laws and regulations, including, without limitation, "
        "those relating to privacy or the use of personal data. The "
        "Subscriber shall ensure that any personal data that the "
        "Subscriber provides to the Fund or its delegates is accurate "
        "and up to date, and the Subscriber shall promptly notify the "
        "Fund if the Subscriber becomes aware that any such data is no "
        "longer accurate or up to date. The Subscriber acknowledges that "
        "the Fund and/or its delegates may transfer and/or process "
        "personal data provided by the Subscriber outside of the United "
        "States and the Subscriber hereby consents to such transfer "
        "and/or processing and further represents that it is duly "
        "authorized to provide this consent on behalf of any individual "
        "whose personal data is provided by the Subscriber."))

    # (37) Privacy Policy
    story.append(rep("37",
        "The Subscriber acknowledges receipt of the Fund&rsquo;s privacy "
        "notice attached as <b>Appendix B</b> hereto (the &ldquo;<b>"
        "Privacy Policy</b>&rdquo;). The Subscriber shall promptly "
        "provide the Privacy Policy to (i) each individual whose "
        "personal data the Subscriber has provided or will provide to "
        "the Fund or any of its delegates in connection with the "
        "Subscriber&rsquo;s investment in the Fund (such as directors, "
        "trustees, employees, representatives, shareholders, investors, "
        "clients, beneficial owners or agents) and (ii) any other "
        "individual connected to the Subscriber as may be requested by "
        "the Fund or any of its delegates. The Subscriber shall also "
        "promptly provide to any such individual, on request by the "
        "Fund or any of its delegates, any updated versions of the "
        "Privacy Policy and the privacy notice (or other data protection "
        "disclosures) of any third party to which the Fund or any of "
        "its delegates has directly or indirectly provided that "
        "individual&rsquo;s personal data."))

    # (38) Non-US domicile -> Appendix C
    story.append(rep("38",
        "If the Subscriber is not domiciled in the United States, the "
        "Subscriber hereby makes those additional representations "
        "applicable to the Subscriber&rsquo;s domicile as specified in "
        "<b>Appendix C</b> hereto."))

    return story


# =========================================================================
# FATCA COVENANTS
# =========================================================================
def build_fatca():
    story = []
    story.append(P("<b>Covenants Regarding the U.S. Foreign Account Tax "
                   "Compliance Act.</b>", SECTION_HDR))

    story.append(P(
        "The U.S. Foreign Account Tax Compliance Act, Code Sections 1471 "
        "through 1474, and the regulations (whether proposed, temporary or "
        "final), including any subsequent amendments, and administrative "
        "guidance promulgated thereunder (or which may be promulgated in "
        "the future) (&ldquo;<b>FATCA</b>&rdquo;) impose or may impose a "
        "number of obligations on the Fund. In this regard:",
        BODY))

    fatca_paras = [
        "<b>(1)</b>&nbsp;&nbsp;The Subscriber acknowledges that, in order "
        "to comply with the provisions of FATCA and avoid the imposition "
        "of U.S. federal withholding tax, the General Partner may, from "
        "time to time and to the extent provided under FATCA, (A) require "
        "further information and/or documentation from the Subscriber, "
        "which information and/or documentation may (i) include, but is "
        "not limited to, information and/or documentation relating to or "
        "concerning the Subscriber, the Subscriber&rsquo;s direct and "
        "indirect beneficial owners (if any), any such person&rsquo;s "
        "identity, residence (or jurisdiction of formation) and income "
        "tax status, and (ii) need to be certified by the Subscriber "
        "under penalties of perjury, and (B) provide or disclose any such "
        "information and documentation to the IRS or other governmental "
        "agencies of the United States.",

        "<b>(2)</b>&nbsp;&nbsp;The Subscriber agrees that it shall provide "
        "such information and/or documentation concerning itself and its "
        "direct and indirect beneficial owners (if any), as and when "
        "requested by the General Partner, as General Partner, in its sole "
        "discretion, determines is necessary or advisable for the Fund to "
        "comply with its obligations under FATCA, including, but not "
        "limited to, in connection with the Fund or any of its Affiliates "
        "entering into or amending or modifying an &ldquo;FFI "
        "Agreement&rdquo; (as defined under FATCA) with the IRS and "
        "maintaining ongoing compliance with such agreement. The Subscriber "
        "should consult its tax advisors as to the type of information that "
        "may be required from the Subscriber.",

        "<b>(3)</b>&nbsp;&nbsp;Consistent with FATCA, the Subscriber agrees "
        "to waive any provision of law of any non-U.S. jurisdiction that "
        "would, absent a waiver, prevent the Fund&rsquo;s compliance with "
        "any FFI Agreement, including, but not limited to, the "
        "Subscriber&rsquo;s provision of any requested information and/or "
        "documentation.",

        "<b>(4)</b>&nbsp;&nbsp;The Subscriber acknowledges that if the "
        "Subscriber does not timely provide and/or update the requested "
        "information and/or documentation or waiver, as applicable (a "
        "&ldquo;<b>FATCA Compliance Failure</b>&rdquo;), the General "
        "Partner may, in its sole and absolute discretion and in addition "
        "to all other remedies available at law, in equity or under the "
        "Fund Agreement, (a) exclude in whole or part the Subscriber from "
        "participating in Fund Investments or (b) cause the Subscriber to "
        "withdraw from the Fund in whole or in part.",

        "<b>(5)</b>&nbsp;&nbsp;To the extent that the Fund or any "
        "Indemnified Person suffers any withholding taxes, interest, "
        "penalties and other expenses and costs on account of the "
        "Subscriber&rsquo;s FATCA Compliance Failure, unless otherwise "
        "agreed by the General Partner, (a) the Subscriber shall promptly "
        "pay upon demand by the General Partner to the Fund or, at the "
        "General Partner&rsquo;s direction, to the relevant Indemnified "
        "Person or Parties, an amount equal to such withholding taxes, "
        "interest, penalties and other expenses and costs, or (b) the "
        "General Partner may reduce the amount of the next distribution "
        "or distributions that would otherwise have been made to the "
        "Subscriber or, if such distributions are not sufficient for that "
        "purpose, reduce the proceeds of liquidation otherwise payable to "
        "the Subscriber by an amount equal to such withholding taxes, "
        "interest, penalties and other expenses and costs; provided that "
        "(i) if the amount of the next succeeding distribution or "
        "distributions or proceeds of liquidation is reduced, such amount "
        "shall include an amount to cover interest on the amount of such "
        "withholding taxes, interest, penalties and other expenses and "
        "costs at the lesser of (A) the rate of the Prime Rate, plus 2% "
        "per annum, and (B) the maximum rate permitted by applicable law, "
        "and (ii) should the General Partner elect to reduce distributions "
        "or proceeds, the General Partner shall use commercially "
        "reasonable efforts to notify the Subscriber of its intention to "
        "do so. Whenever the General Partner makes any such reduction of "
        "the proceeds payable to the Subscriber pursuant to paragraph "
        "5(b), for all other purposes of the Fund Agreement the Subscriber "
        "may be treated as having received all distributions (whether "
        "before or upon liquidation) payable to the Subscriber by the "
        "amount of such reduction. Unless otherwise agreed to by the "
        "General Partner in writing, the Subscriber shall indemnify and "
        "hold harmless the Fund and the Indemnified Persons from and "
        "against any withholding taxes, interest, penalties and other "
        "expenses and costs with respect to the Subscriber&rsquo;s FATCA "
        "Compliance Failure.",

        "<b>(6)</b>&nbsp;&nbsp;The Subscriber acknowledges that the "
        "General Partner will determine in its sole discretion when and "
        "how to comply with FATCA.",

        "<b>(7)</b>&nbsp;&nbsp;The Subscriber acknowledges and agrees that "
        "it shall have no claim against any Indemnified Person for any "
        "damages or liabilities attributable to any actions or "
        "determinations of the General Partner pursuant to paragraph (3) "
        "of this section describing FATCA.",
    ]
    for para in fatca_paras:
        story.append(P(para, BODY))

    return story


# =========================================================================
# CLOSING PROVISIONS
# =========================================================================
def build_closing_provisions():
    story = []

    # Effectiveness
    story.append(P("<b>Effectiveness of Subscription.</b>", SECTION_HDR))
    story.append(P(
        "The Subscriber (or its authorized representative) understands "
        "that it may cancel this subscription by means of a written notice "
        "received by the General Partner at any time before the General "
        "Partner has accepted the subscription. Upon acceptance by the "
        "General Partner the subscription of the Subscriber will become "
        "irrevocable unless the law of the state of residence of the "
        "Subscriber provides otherwise.",
        BODY))
    story.append(P(
        "The Subscriber (or its authorized representative) understands "
        "that neither the Fund nor the General Partner is required to "
        "accept this subscription, that the subscription payment of the "
        "Subscriber may be returned at any time prior to the admission "
        "of the Subscriber to the Fund as a Partner, that new "
        "subscriptions will only be accepted as of the beginning of a "
        "calendar month, and that the Fund reserves the right to suspend "
        "or terminate this offering at any time.",
        BODY))

    # Indemnification
    story.append(P("<b>Indemnification.</b>", SECTION_HDR))
    story.append(P(
        "The Subscriber hereby agrees to indemnify the General Partner, "
        "the Investment Manager, and their respective Affiliates from "
        "liability to the Fund and agrees to indemnify and hold harmless "
        "the Fund, its Affiliates and each Partner in respect of all "
        "claims, actions, demands, losses, costs, expenses (including "
        "attorneys&rsquo; fees) and damages resulting from any inaccuracy "
        "in any of its representations or breach of any to its warranties "
        "contained in this Subscription Agreement or in any other "
        "document delivered by the Subscriber to the Fund, the General "
        "Partner or the Investment Manager. The foregoing indemnification "
        "obligation shall survive the date of this Subscription Agreement.",
        BODY))

    # Expenses
    story.append(P("<b>Expenses.</b>", SECTION_HDR))
    story.append(P(
        "Each party hereto shall pay its own separate expenses relating "
        "to this Subscription Agreement and the purchase and sale of the "
        "limited partnership Interest in the Fund.",
        BODY))

    # Continuing Representations
    story.append(P("<b>Continuing Representations.</b>", SECTION_HDR))
    story.append(P(
        "The Subscriber&rsquo;s representations and warranties made herein "
        "shall survive the date of this Agreement and shall be deemed to "
        "be reaffirmed by the Subscriber at any time a purchase of an "
        "additional Interest in the Fund is made by the Subscriber and the "
        "act of purchasing any such additional Interest shall be evidence "
        "of such reaffirmation. Notwithstanding the foregoing, the "
        "Subscriber agrees to execute any necessary re-affirmation or "
        "re-certifications of any of the representations contained herein "
        "that the General Partner may request.",
        BODY))

    # Conditions
    story.append(P("<b>Conditions.</b>", SECTION_HDR))
    story.append(P(
        "The Fund&rsquo;s obligation to issue an Interest to the "
        "Subscriber is subject to the fulfillment of the following "
        "conditions to the General Partner&rsquo;s satisfaction:",
        BODY))
    story.append(P(
        "<b>a.</b>&nbsp;&nbsp;The representations and warranties made by "
        "the Subscriber herein are complete and accurate in all respects.",
        REP_PARA))
    story.append(P(
        "<b>b.</b>&nbsp;&nbsp;The Subscriber has furnished such other "
        "information and executed such certifications or other documents "
        "in connection with the transactions contemplated hereby as the "
        "General Partner reasonably shall have requested, including any "
        "relating to the Fund&rsquo;s compliance with applicable federal "
        "and state securities laws in connection with the Subscriber&rsquo;s "
        "purchase of an Interest in the Fund.",
        REP_PARA))
    story.append(P(
        "<b>c.</b>&nbsp;&nbsp;The Subscriber&rsquo;s accredited-investor "
        "status has been verified by a third-party verifier acceptable to "
        "the General Partner pursuant to Rule 506(c)(2)(ii) under the "
        "Securities Act, and such verification is dated within 90 days "
        "prior to the Subscriber&rsquo;s admission to the Fund.",
        REP_PARA))

    # Binding Effect
    story.append(P("<b>Binding Effect.</b>", SECTION_HDR))
    story.append(P(
        "This Subscription Agreement shall be binding upon and inure to "
        "the benefit of the parties hereto and their respective heirs, "
        "executors, administrators, successors, legal representatives "
        "and assigns. If the Subscriber is more than one person, the "
        "obligations of the Subscriber shall be joint and several and the "
        "agreements, representations, warranties and acknowledgments "
        "herein contained shall be deemed to be made by and be binding "
        "upon each such person and his respective heirs, executors, "
        "administrators, successors, legal representatives and assigns.",
        BODY))

    # Assignability
    story.append(P("<b>Assignability.</b>", SECTION_HDR))
    story.append(P(
        "The Subscriber agrees not to transfer or assign this "
        "Subscription Agreement, or any of the Subscriber&rsquo;s "
        "interest herein.",
        BODY))

    # Registered Address
    story.append(P("<b>Registered Address.</b>", SECTION_HDR))
    story.append(P(
        "The Subscriber understands that any checks sent to the "
        "Subscriber&rsquo;s registered address or Address for Notices, "
        "or any wire transfers of any distribution proceeds sent to the "
        "account indicated above, will constitute payment to the "
        "Subscriber and relieve the Fund of any further obligation to "
        "the Subscriber with respect to the amounts so paid and an "
        "Interest thereby sold, and the Subscriber, for themselves and "
        "any of their estate, heirs, assigns or successors of any kind, "
        "release the Fund from any further obligation with respect "
        "thereto. The Subscriber also understands that the Fund may "
        "impose such procedures as it deems appropriate before it will "
        "accept any change in the Subscriber&rsquo;s registered address, "
        "the Subscriber&rsquo;s Address for Notices or the account "
        "designated above.",
        BODY))

    # Titles
    story.append(P("<b>Titles.</b>", SECTION_HDR))
    story.append(P(
        "The titles set forth in this Subscription Agreement are for "
        "convenience only and shall not be considered as part of this "
        "Subscription Agreement in any respect, nor shall they in any way "
        "affect the substance of any provisions contained in this "
        "Subscription Agreement.",
        BODY))

    # Applicable Law
    story.append(P("<b>Applicable Law.</b>", SECTION_HDR))
    story.append(P(
        "This Agreement shall be governed by and construed in accordance "
        "with the laws of the State of Delaware without giving effect to "
        "the principles thereof concerning the conflict of laws.",
        BODY))

    # Administration
    story.append(P("<b>Administration.</b>", SECTION_HDR))
    story.append(P(
        "The General Partner is hereby authorized and instructed to "
        "accept and execute any instructions in respect of the Interests "
        "to which this Subscription Agreement relates given by the "
        "Subscriber in written form. The General Partner may rely "
        "conclusively upon and shall incur no liability in respect of any "
        "action taken upon any notice, consent, request, instructions or "
        "other instrument believed in good faith to be genuine or to be "
        "signed by properly authorized persons.",
        BODY))

    story.append(spacer(10))
    story.append(P("* * *", SUBTITLE_STYLE))
    story.append(spacer(10))

    story.append(P(
        "<b>SUBSCRIBERS SHOULD CONSULT WITH THEIR FINANCIAL, LEGAL AND "
        "TAX ADVISORS AND REVIEW THE SUBSCRIPTION AGREEMENT, THE LIMITED "
        "PARTNERSHIP AGREEMENT, AND THE PRIVATE PLACEMENT MEMORANDUM IN "
        "THEIR ENTIRETY BEFORE DECIDING WHETHER TO INVEST IN THE FUND.</b>",
        CAPS_BODY))

    return story


# =========================================================================
# APPENDIX D - SUPPLEMENTAL RISK FACTORS (NEW)
# =========================================================================
def build_appendix_d():
    story = []
    story.append(PageBreak())
    story.append(P("<b>APPENDIX D</b>", SUBTITLE_STYLE))
    story.append(P("<b>Supplemental Risk Factors</b>", SUBTITLE_STYLE))
    story.append(spacer(10))

    story.append(P(
        "This Appendix D summarizes certain risk factors relating to an "
        "investment in PNTHR Tree Fund, LP (the "
        "&ldquo;<b>Fund</b>&rdquo;). This summary is not exhaustive and "
        "does not include all risks to which an investment in the Fund "
        "may be subject. This Appendix D is a summary only and is not a "
        "substitute for the complete Risk Factors set forth in Section "
        "VIII of the Private Placement Memorandum (the &ldquo;<b>PPM</b>"
        "&rdquo;), which the Subscriber acknowledges having received and "
        "read in its entirety. In the event of any conflict between this "
        "Appendix D and the PPM, the PPM shall control.",
        BODY))

    risks = [
        ("1. AI Sector Concentration Risk",
         "The Fund invests exclusively in securities within the "
         "artificial-intelligence value chain. Concentration in a single "
         "thematic sector exposes the Fund to risks specific to that "
         "sector, including but not limited to regulatory changes "
         "targeting AI technologies, shifts in government policy "
         "regarding AI development or deployment, technological "
         "obsolescence, competitive disruption, and sector-wide "
         "valuation contractions. A broad decline in AI-related equities "
         "could materially and adversely affect the Fund&rsquo;s "
         "performance regardless of the quality of individual security "
         "selection."),

        ("2. AI Sub-Sector Concentration Risk",
         "The Fund does not impose a sub-sector concentration cap. When "
         "trend conditions favor a particular AI sub-sector, the Fund "
         "may concentrate in a single sub-sector, which may increase "
         "volatility and the risk of loss relative to a diversified "
         "portfolio. Sub-sector concentration is a deliberate feature "
         "of the Strategy and not a risk of deviation from design."),

        ("3. Confidential Proprietary Methodology",
         "The Strategy is implemented through the PNTHR Signal System "
         "and the PNTHR Den Platform. All parameters, formulas, "
         "thresholds, weights, timeframes, signal logic, code, and "
         "related intellectual property are confidential proprietary "
         "information of the Investment Manager and are not disclosed to "
         "Limited Partners. The Subscriber cannot independently verify "
         "the methodology of the Strategy. The Subscriber must rely on "
         "the Investment Manager&rsquo;s implementation and oversight "
         "of the Strategy."),

        ("4. Key Person Risk",
         "The Fund&rsquo;s success depends substantially on the "
         "continued service of Scott R. McBrien, as Chief Investment "
         "Officer and Chief Compliance Officer, and on Cindy Eagar, as "
         "Chief Operating Officer and Chief Information Security "
         "Officer, together with their respective roles as Managers and "
         "Co-Founders of the General Partner. The loss of either key "
         "person could materially and adversely affect the Fund. "
         "Section 4.04 of the Limited Partnership Agreement provides a "
         "90-day Key Person Suspension Period during which no new "
         "investments may be made and Limited Partners may withdraw "
         "without penalty and without Lock-Up Period restrictions. If "
         "no successor is approved within the specified period, the "
         "Fund may be dissolved."),

        ("5. Verification Risk under Rule 506(c)",
         "The Fund is conducting its offering in reliance on Rule 506(c) "
         "under the Securities Act of 1933, as amended. Rule 506(c) "
         "requires the Fund to take reasonable steps to verify the "
         "accredited-investor status of each purchaser through a "
         "third-party verifier. The Subscriber&rsquo;s status is not "
         "self-certifiable. If verification is not successfully "
         "completed, the Subscriber cannot be admitted to the Fund, "
         "regardless of the Subscriber&rsquo;s actual accredited-investor "
         "status."),

        ("6. Liquidity, Lock-Up, and Withdrawal Gate Restrictions",
         "Limited Partnership Interests in the Fund are highly illiquid. "
         "Interests are subject to a one-year Lock-Up Period during "
         "which early withdrawals are subject to a 25% Early-Withdrawal "
         "Penalty. After the Lock-Up Period, withdrawals require 60 "
         "days&rsquo; prior written notice and are effective only as of "
         "the end of each calendar quarter. Withdrawals in any quarter "
         "are subject to a 25% quarterly Withdrawal Gate based on the "
         "aggregate net asset value of the Fund. A 10% Audit Holdback "
         "applies to each withdrawal and is released within 30 days of "
         "completion of the Fund&rsquo;s annual audit. The minimum "
         "withdrawal is $25,000 and a $50,000 Capital Account floor "
         "must be maintained. The General Partner may suspend "
         "withdrawals under specified circumstances described in the "
         "Limited Partnership Agreement."),

        ("7. General Market Risk and Loss of Capital",
         "An investment in the Fund involves a high degree of risk, "
         "including the risk of loss of all invested capital. The Fund "
         "is a directional, long-only strategy (authorized, but not "
         "currently implementing, short positions) in publicly traded "
         "U.S. equity securities and may use leverage up to a gross "
         "exposure of 2:1; it is high-beta, highly correlated to the "
         "equity market, and has experienced large drawdowns in its "
         "hypothetical backtest. Market, liquidity, "
         "counterparty, execution, and technology risks apply. Past "
         "performance is not a guarantee or predictor of future "
         "results, and no assurance can be given that the Fund&rsquo;s "
         "objectives will be achieved or that the Subscriber will not "
         "lose all or a portion of the Subscriber&rsquo;s Capital "
         "Commitment."),
    ]

    for title, text in risks:
        story.append(P(f"<b>{title}.</b>", SECTION_HDR))
        story.append(P(text, BODY))

    story.append(spacer(8))
    story.append(P(
        "This Appendix D is a summary only. The complete set of risk "
        "factors is set forth in Section VIII of the PPM, which the "
        "Subscriber acknowledges having received and read.",
        BODY))

    return story


# =========================================================================
# MAIN
# =========================================================================
def build():
    doc = make_doc_template(
        OUT_PATH,
        title_meta="PNTHR Tree Fund, LP - Subscription Agreement v1.0",
        subject="Subscription Agreement",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Subscription Agreement",
        doc_date_display="June 2026",
        fund_name="PNTHR Tree Fund",
        fund_name_upper="PNTHR TREE FUND",
    )
    story = build_cover_header(
        title_line_1="PNTHR Tree Fund, LP",
        title_line_2=None,
        subtitle="Subscription Agreement",
        date_line="Effective:  June 1, 2026",
        revision_line="Document Revision:  v1.0 - June 2026",
        issuer_line="Issuer:  PNTHR Funds, LLC (General Partner)",
        confidential_title=None,
        confidential_body=None,
    )
    story.extend(build_instructions())
    story.extend(build_signature_page())
    story.extend(build_subscription_agreement())
    story.extend(build_fatca())
    story.extend(build_closing_provisions())
    story.extend(build_appendix_d())

    doc.build(story, onFirstPage=on_cover, onLaterPages=on_page)
    print(f"PDF generated: {OUT_PATH}")


if __name__ == "__main__":
    build()
