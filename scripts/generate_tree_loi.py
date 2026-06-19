#!/usr/bin/env python3
"""
PNTHR Tree Fund, LP
Letter of Intent v1.0
Effective: June 1, 2026

Converted from Carnivore Quant Fund LOI v4.2 generator.
All "Carnivore Quant Fund" references replaced with "PNTHR Tree Fund".
Formation/effective date: June 1, 2025 -> June 1, 2026.
Fund terms table values preserved (identical fee/structure to Carnivore).

Output: ~/Downloads/PNTHR_Tree_Fund_LOI_v1.0_2026.pdf
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import Paragraph, Spacer, PageBreak, Table, TableStyle

from reportlab.lib import colors
from pnthr_design import (
    PALETTE_DIM_GRAY, PALETTE_PURE_BLACK,
    BODY,
    make_doc_template, make_page_handlers, build_cover_header,
)

FUND       = "PNTHR Tree Fund, LP"
FUND_UPPER = "PNTHR TREE FUND, LP"
VERSION    = "v1.0"

OUT_PATH = os.path.expanduser(f"~/Downloads/PNTHR_Tree_Fund_LOI_{VERSION}_2026.pdf")

# ----- LOI-specific local styles -------------------------------------------
BLOCK = ParagraphStyle(
    name="block", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=0, spaceAfter=0,
)
SECTION_HDR = ParagraphStyle(
    name="section_hdr", fontName="Helvetica-Bold", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=10, spaceAfter=4,
)
REP_PARA = ParagraphStyle(
    name="rep_para", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=6, leftIndent=22,
)
BOLD_NOTE = ParagraphStyle(
    name="bold_note", fontName="Helvetica-Bold", fontSize=11, leading=14,
    alignment=TA_JUSTIFY, spaceBefore=6, spaceAfter=8,
)
SIG_LINE = ParagraphStyle(
    name="sig_line", fontName="Helvetica", fontSize=10.5, leading=18,
    alignment=TA_LEFT, spaceBefore=0, spaceAfter=0,
)
SIG_DESC = ParagraphStyle(
    name="sig_desc", fontName="Helvetica-Oblique", fontSize=10, leading=13,
    alignment=TA_LEFT, spaceBefore=0, spaceAfter=6,
)
FOOTER_NOTE = ParagraphStyle(
    name="footer_note", fontName="Helvetica-Oblique", fontSize=9, leading=11,
    alignment=TA_CENTER, spaceBefore=14, spaceAfter=0, textColor=PALETTE_DIM_GRAY,
)

# ----- Helpers --------------------------------------------------------------
def P(text, style=BODY):
    return Paragraph(text, style)

def spacer(h=8):
    return Spacer(1, h)

def sig_field_row(label_html):
    return [
        P("_________________________________________", SIG_LINE),
        P(label_html, SIG_DESC),
        spacer(6),
    ]

def fund_terms_table():
    """At-a-glance summary of key terms. Values match PPM v1.0 / LPA v1.0 exactly."""
    label_style = ParagraphStyle(
        name="tbl_label", fontName="Helvetica-Bold", fontSize=10, leading=13,
        alignment=TA_LEFT, spaceAfter=0,
    )
    value_style = ParagraphStyle(
        name="tbl_value", fontName="Helvetica", fontSize=10, leading=13,
        alignment=TA_LEFT, spaceAfter=0,
    )
    rows = [
        ("Minimum Capital Commitment", "$100,000"),
        ("Offering Size",
         "Up to $25,000,000 in aggregate Capital Commitments"),
        ("Investor Classes",
         "Wagyu (Capital Commitment &ge; $1,000,000); Porterhouse "
         "($500,000 to $999,999); Filet ($100,000 to $499,999)"),
        ("Management Fee",
         "2.00% per annum, accrued monthly, paid quarterly in advance"),
        ("Performance Allocation",
         "Wagyu 20% (reduced to 15% after 3 continuous years); "
         "Porterhouse 25% (reduced to 20%); Filet 30% (reduced to 25%), "
         "in each case subject to Capital Account balance remaining at or "
         "above initial Capital Contribution"),
        ("Hurdle Rate",
         "Annualized U.S. 2-Year Treasury yield as of the close of the first "
         "trading day of each Fiscal Year, divided by four (quarterly Hurdle); "
         "not cumulative across calendar quarters or Fiscal Years"),
        ("High Water Mark", "Yes (LPA Section 1.01, Section 8.01(c))"),
        ("Loss Recovery Account",
         "Yes; Performance Allocation accrues only after prior-quarter losses "
         "are recovered via the Loss Recovery Account (LPA Section 8.01(e))"),
        ("Lock-Up Period", "1 year from initial Capital Contribution"),
        ("Early-Withdrawal Penalty",
         "25% of the amount withdrawn during the Lock-Up Period"),
        ("Withdrawal Notice", "60 days prior written notice"),
        ("Withdrawal Gate",
         "25% of aggregate net asset value of the Fund per quarter"),
        ("Audit Holdback",
         "10% of withdrawal proceeds, released within 30 days of annual "
         "audit completion"),
        ("Minimum Withdrawal / Capital Account Floor",
         "$25,000 minimum withdrawal; $50,000 Capital Account floor"),
        ("Investor Qualification",
         "Accredited Investor (Rule 501(a)) AND Qualified Client (Rule "
         "205-3); Qualified Purchaser status is NOT required"),
        ("Verification",
         "Third-party verification required under Rule 506(c)(2)(ii); "
         "self-certification not sufficient; 90-day validity window"),
        ("Exemption Reliance",
         "Rule 506(c) under the Securities Act; Section 3(c)(1) under "
         "the Investment Company Act (100 beneficial owner limit)"),
        ("Governing Law / Dispute Resolution",
         "Delaware; AAA Commercial Rules arbitration, Delaware venue, "
         "single arbitrator from AAA roster; prevailing-party attorneys' "
         "fees"),
    ]
    data = [
        [P("<b>Term</b>", label_style), P("<b>Value</b>", value_style)]
    ] + [
        [P(label, label_style), P(value, value_style)]
        for (label, value) in rows
    ]
    tbl = Table(data, colWidths=[2.2 * inch, 4.3 * inch])
    tbl.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.75, colors.black),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.black),
        ("BACKGROUND", (0, 0), (-1, 0), colors.Color(0.90, 0.90, 0.90)),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return tbl


# =========================================================================
# BUILD CONTENT
# =========================================================================
def build():
    story = build_cover_header(
        title_line_1="PNTHR TREE FUND, LP",
        title_line_2=None,
        subtitle="LETTER OF INTENT",
        date_line="Effective:  June 1, 2026",
        revision_line=f"Document Revision:  {VERSION} - May 2026",
        issuer_line="Issuer:  PNTHR Funds, LLC (General Partner)",
        confidential_title=None,
        confidential_body=None,
    )

    # ----- Investor Info Block -----
    story.append(P("[Investor&rsquo;s Name]", BLOCK))
    story.append(P("[Investor&rsquo;s Company Name (if applicable)]", BLOCK))
    story.append(P("[Investor&rsquo;s Address]", BLOCK))
    story.append(P("[City, State, Zip Code]", BLOCK))
    story.append(spacer(12))
    story.append(P("[Date]", BLOCK))
    story.append(spacer(14))

    # ----- Recipient Block -----
    story.append(P("PNTHR Funds, LLC", BLOCK))
    story.append(P("15150 W Park Place, Suite 215", BLOCK))
    story.append(P("Goodyear, Arizona 85395", BLOCK))
    story.append(P("Attn:  Scott R. McBrien and Cindy Eagar, Co-Managers", BLOCK))
    story.append(P("Email:  info@PNTHRfunds.com", BLOCK))
    story.append(P("Phone:  602-810-1940", BLOCK))
    story.append(spacer(14))

    # ----- Greeting -----
    story.append(P("Dear Scott and Cindy,", BLOCK))
    story.append(spacer(8))

    # ----- Opening Paragraph -----
    story.append(P(
        f"I am writing to express my preliminary interest in making an "
        f"investment in <b>{FUND_UPPER}</b> (the "
        f"&ldquo;<b>Fund</b>&rdquo;). Based on the information provided to "
        f"date and my understanding of the Fund&rsquo;s investment strategy, "
        f"I believe the Fund presents a compelling opportunity, and I am "
        f"considering an initial Capital Commitment of approximately $"
        f"___________________________ (which I understand must be not less "
        f"than $100,000), subject to final due diligence and the execution "
        f"of the Fund&rsquo;s Subscription Agreement and related Subscription "
        f"Documents.",
        BODY))

    # ----- Fund Terms Summary Table -----
    story.append(P("<b>Summary of Fund Terms.</b>", SECTION_HDR))
    story.append(P(
        "I acknowledge having been provided a preliminary summary of the "
        "Fund&rsquo;s key economic and structural terms, which I understand "
        "to be as follows (and which I understand are set forth in full in "
        "the Fund&rsquo;s Private Placement Memorandum (the "
        "&ldquo;<b>PPM</b>&rdquo;) and Limited Partnership Agreement (the "
        "&ldquo;<b>LPA</b>&rdquo;)):",
        BODY))
    story.append(fund_terms_table())
    story.append(spacer(8))
    story.append(P(
        "<b>In the event of any conflict between this summary and the PPM "
        "or the LPA, the PPM and the LPA shall control.</b>",
        BOLD_NOTE))

    # ----- Reliance Representations -----
    story.append(P("<b>Preliminary Reliance Representations.</b>", SECTION_HDR))
    story.append(P(
        "Subject to the non-binding nature of this letter as set forth "
        "below, I preliminarily represent and acknowledge the following:",
        BODY))
    story.append(P(
        "<b>(a) Rule 506(c).</b>&nbsp;&nbsp;I understand that the Fund is "
        "relying on Rule 506(c) under Regulation D under the Securities "
        "Act of 1933, as amended (the &ldquo;<b>Securities Act</b>&rdquo;); "
        "that I will be required to complete a verification of my "
        "accredited-investor status by a qualifying third-party verifier "
        "(a FINRA-registered broker-dealer, SEC-registered investment "
        "adviser, licensed attorney, or certified public accountant; "
        "state-registered investment advisers are not acceptable); and "
        "that self-certification of my accredited-investor status is not "
        "sufficient.",
        REP_PARA))
    story.append(P(
        "<b>(b) Section 3(c)(1).</b>&nbsp;&nbsp;I understand that the Fund "
        "is relying on the exclusion from investment-company registration "
        "provided by Section 3(c)(1) of the Investment Company Act of 1940, "
        "which limits the Fund to no more than one hundred (100) beneficial "
        "owners. I understand that the Fund is <b>not</b> relying on "
        "Section 3(c)(7) of the Investment Company Act and that I am not "
        "required to be a &ldquo;qualified purchaser&rdquo; within the "
        "meaning of Section 2(a)(51) of the Investment Company Act.",
        REP_PARA))
    story.append(P(
        "<b>(c) Rule 205-3 and Rule 501(a).</b>&nbsp;&nbsp;Subject to "
        "confirmation through the Fund&rsquo;s Subscription Documents and "
        "third-party verification process, I preliminarily represent that "
        "I am, or reasonably expect to qualify as, both (i) an "
        "&ldquo;accredited investor&rdquo; as defined in Rule 501(a) under "
        "Regulation D of the Securities Act, and (ii) a &ldquo;qualified "
        "client&rdquo; as defined in Rule 205-3 under the Investment "
        "Advisers Act of 1940, as amended.",
        REP_PARA))

    # ----- Non-Binding Paragraph -----
    story.append(P("<b>Non-Binding Nature of this Letter.</b>", SECTION_HDR))
    story.append(P(
        "Please note that this letter is not intended to create a binding "
        "obligation on either party. Rather, it is intended to facilitate "
        "further discussions between myself and PNTHR Funds, LLC regarding "
        "a potential investment. Any formal commitment would be contingent "
        "upon, among other things, the completion of due diligence, a "
        "review of the Fund&rsquo;s Private Placement Memorandum and "
        "related documents, and mutually agreeable terms.",
        BODY))

    # ----- 90-Day Auto-Expiration -----
    story.append(P("<b>90-Day Auto-Expiration.</b>", SECTION_HDR))
    story.append(P(
        "This Letter of Intent automatically expires on the date that is "
        "ninety (90) days after the date first written above (the "
        "&ldquo;<b>Expiration Date</b>&rdquo;), unless (i) extended by "
        "mutual written agreement of the Investor and the General Partner, "
        "or (ii) superseded by the Investor&rsquo;s execution of the "
        "Fund&rsquo;s Subscription Agreement and related Subscription "
        "Documents prior to the Expiration Date. Upon expiration, this "
        "Letter shall be of no further force or effect, provided that the "
        "Confidentiality covenant set forth below shall survive expiration "
        "in accordance with its terms.",
        BODY))

    # ----- Confidentiality -----
    story.append(P("<b>Confidentiality.</b>", SECTION_HDR))
    story.append(P(
        "The Investor agrees to maintain the confidentiality of all "
        "non-public information concerning the Fund, the General Partner, "
        "the Investment Manager, the Fund&rsquo;s proprietary strategy "
        "(including, without limitation, the PNTHR Signal System and the "
        "PNTHR Den Platform), the PPM, the LPA, and any other information "
        "disclosed to the Investor in connection with this Letter of Intent "
        "(collectively, &ldquo;<b>Non-Public Information</b>&rdquo;). The "
        "Investor shall not disclose Non-Public Information to any third "
        "party other than the Investor&rsquo;s legal, tax, and financial "
        "advisors, each of whom is bound by similar confidentiality "
        "obligations. Non-Public Information does not include information "
        "that (i) was publicly known when received by the Investor, "
        "(ii) subsequently becomes publicly known through no act or "
        "omission by the Investor, or (iii) is disclosed to the Investor "
        "by a third party not known to the Investor to be bound by any "
        "confidentiality obligation. This Confidentiality covenant shall "
        "survive any termination or expiration of this Letter of Intent.",
        BODY))

    # ----- Closing -----
    story.append(P(
        "I look forward to working closely with you and your team as we "
        "move forward in the process. Please feel free to contact me at "
        "your convenience to discuss the next steps.",
        BODY))
    story.append(P(
        "Thank you for the opportunity to explore this investment, and I "
        "look forward to the possibility of collaborating with you.",
        BODY))

    # ----- Signature Block -----
    story.append(spacer(10))
    story.append(P("Sincerely,", BLOCK))
    story.append(spacer(30))
    story.extend(sig_field_row("(<i>Signature of Investor</i>)"))
    story.extend(sig_field_row("(<i>Printed name of Investor</i>)"))
    story.extend(sig_field_row("(<i>Title (if applicable)</i>)"))
    story.extend(sig_field_row("(<i>Date</i>)"))
    story.append(spacer(6))
    story.append(P(
        "<i>Contact information for the Investor is set forth in the "
        "heading of this Letter of Intent.</i>",
        BLOCK))

    story.append(P(
        f"{FUND_UPPER} - Letter of Intent - {VERSION} "
        f"(Effective Document Version: June 1, 2026)",
        FOOTER_NOTE))

    doc = make_doc_template(
        OUT_PATH,
        title_meta=f"{FUND} - Letter of Intent {VERSION}",
        subject="Letter of Intent",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Letter of Intent",
        doc_date_display="June 2026",
        fund_name="PNTHR Tree Fund",
        fund_name_upper="PNTHR TREE FUND",
    )
    doc.build(story, onFirstPage=on_cover, onLaterPages=on_page)
    print(f"PDF generated: {OUT_PATH}")
    print(f"Size: {os.path.getsize(OUT_PATH):,} bytes")


if __name__ == "__main__":
    build()
