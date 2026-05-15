#!/usr/bin/env python3
"""
PNTHR FUNDS, PNTHR AI Elite 300 Fund, LP
Limited Partnership Agreement v3.1
Effective: June 1, 2026

Baseline: attorney-prepared "6. Amended Limited Partner Agreement - PNTHR FINAL CE copy 2.pdf"
Revisions applied per user-approved Phase 1 edit plan (April 2026).

PHASE 1 — LEGAL CONTENT ONLY. No PNTHR branding/design. Clean professional formatting.

Output: PNTHR_LPA_v3.1_2026.pdf
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

from pnthr_design import (
    make_doc_template, make_page_handlers, build_cover_header,
    COVER_NOTICE as TPL_COVER_NOTICE,
)

OUT_DIR = os.path.expanduser("~/Downloads")
os.makedirs(OUT_DIR, exist_ok=True)
OUT_PATH = os.path.join(OUT_DIR, "PNTHR_AI_Elite_300_LPA_v1.0_2026.pdf")

# ── Styles (match PPM v6.0 conventions) ─────────────────────────────────
TITLE_STYLE = ParagraphStyle(
    name="title", fontName="Helvetica-Bold", fontSize=16, leading=20,
    alignment=TA_CENTER, spaceBefore=0, spaceAfter=18,
)
SUBTITLE_STYLE = ParagraphStyle(
    name="subtitle", fontName="Helvetica", fontSize=12, leading=16,
    alignment=TA_CENTER, spaceBefore=0, spaceAfter=10,
)
ARTICLE_HDR = ParagraphStyle(
    name="article_hdr", fontName="Helvetica-Bold", fontSize=13, leading=16,
    alignment=TA_CENTER, spaceBefore=18, spaceAfter=4,
)
ARTICLE_NAME = ParagraphStyle(
    name="article_name", fontName="Helvetica-Bold", fontSize=13, leading=16,
    alignment=TA_CENTER, spaceBefore=0, spaceAfter=12,
)
H2 = ParagraphStyle(
    name="h2", fontName="Helvetica-Bold", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=10, spaceAfter=4,
)
BODY = ParagraphStyle(
    name="body", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=8,
)
BODY_INDENT = ParagraphStyle(
    name="body_indent", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=8, leftIndent=24,
)
BULLET_STYLE = ParagraphStyle(
    name="bullet", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=6, leftIndent=36, bulletIndent=20,
)
DEFN = ParagraphStyle(
    name="defn", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=8, leftIndent=24,
)
SECTION_PARA = ParagraphStyle(
    name="section_para", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=8,
)
COVER_NOTICE = ParagraphStyle(
    name="cover_notice", fontName="Helvetica", fontSize=10, leading=13,
    alignment=TA_JUSTIFY, spaceBefore=12, spaceAfter=8,
)

# ── Header / Footer provided by pnthr_design.make_page_handlers ────────

# ── Helpers ─────────────────────────────────────────────────────────────
def P(text, style=BODY):
    return Paragraph(text, style)

def section(num, title, *paragraphs):
    """Returns a list of flowables for a Section (e.g., Section 1.01 Definitions)."""
    out = [P(f"<b>Section {num}&nbsp;&nbsp;{title}.</b>", H2)]
    for para in paragraphs:
        out.append(P(para, BODY))
    return out

def subpara(text):
    return P(text, BODY_INDENT)

def defn(term, body):
    """Defined term in Article I."""
    return P(f'&ldquo;<b>{term}</b>&rdquo;  {body}', DEFN)

def article(num_roman, title_caps):
    return [
        Spacer(1, 4),
        P(f"<b>Article {num_roman}.</b>", ARTICLE_HDR),
        P(f"<b>{title_caps}</b>", ARTICLE_NAME),
    ]

def spacer(h=10):
    return Spacer(1, h)


# ═══════════════════════════════════════════════════════════════════════════
# COVER
# ═══════════════════════════════════════════════════════════════════════════
def build_cover():
    # v3.3 design pass: original cover text preserved verbatim. The long
    # Securities Act legend was in v3.2's cover confidential_body but crowded
    # the bottom of the cover; per user direction 2026-04-19 it has been moved
    # to page 2 top (see build_legend() below). The cover now carries only the
    # title, subtitle, and gray meta lines.
    return build_cover_header(
        title_line_1="PNTHR AI Elite 300 Fund, LP",
        title_line_2=None,
        subtitle="LIMITED PARTNERSHIP AGREEMENT",
        date_line="Dated as of:  June 1, 2026",
        revision_line="Document Revision:  v1.0 - June 2026",
        issuer_line="Issuer:  PNTHR Funds, LLC (General Partner)",
        confidential_title=None,
        confidential_body=None,
    )


def build_legend():
    """
    Securities Act legend (previously on cover; moved to page 2 top in v3.3).
    Text preserved verbatim from v3.1 / v3.2; only position changed.
    """
    story = []
    story.append(P(
        "THE LIMITED PARTNERSHIP INTERESTS (THE &ldquo;INTERESTS&rdquo;) OF PNTHR FUNDS, "
        "PNTHR AI Elite 300 Fund, LP (the &ldquo;PARTNERSHIP&rdquo;) HAVE NOT BEEN REGISTERED "
        "UNDER THE SECURITIES ACT OF 1933, AS AMENDED (THE &ldquo;SECURITIES ACT&rdquo;), "
        "THE SECURITIES LAWS OF ANY STATE OR ANY OTHER APPLICABLE SECURITIES LAWS IN "
        "RELIANCE UPON EXEMPTIONS FROM THE REGISTRATION REQUIREMENTS OF THE SECURITIES "
        "ACT AND SUCH LAWS. SUCH INTERESTS MUST BE ACQUIRED FOR INVESTMENT ONLY AND MAY "
        "NOT BE OFFERED FOR SALE, PLEDGED, HYPOTHECATED, SOLD, ASSIGNED OR TRANSFERRED AT "
        "ANY TIME EXCEPT IN COMPLIANCE WITH (I) THE SECURITIES ACT, ANY APPLICABLE STATE "
        "SECURITIES LAWS, AND ANY OTHER APPLICABLE SECURITIES LAWS; AND (II) THE TERMS "
        "AND CONDITIONS OF THIS LIMITED PARTNERSHIP AGREEMENT AS MAY BE AMENDED OR "
        "SUPPLEMENTED FROM TIME TO TIME. THE INTERESTS MAY NOT BE TRANSFERRED OF RECORD "
        "EXCEPT IN COMPLIANCE WITH SUCH LAWS AND THIS LIMITED PARTNERSHIP AGREEMENT. "
        "THEREFORE, PURCHASERS OF THE INTERESTS WILL BE REQUIRED TO BEAR THE RISK OF "
        "THEIR INVESTMENT FOR AN INDEFINITE PERIOD OF TIME.",
        COVER_NOTICE))
    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# PREAMBLE + RECITALS
# ═══════════════════════════════════════════════════════════════════════════
def build_preamble():
    story = []
    story.append(P("<b>LIMITED PARTNERSHIP AGREEMENT</b>", TITLE_STYLE))
    story.append(spacer(4))

    story.append(P(
        "This Limited Partnership Agreement (this &ldquo;Agreement&rdquo;) of PNTHR "
        "FUNDS, PNTHR AI Elite 300 Fund, LP, a Delaware limited partnership (the "
        "&ldquo;Partnership&rdquo;), is entered into as of June 1, 2026 by and among "
        "PNTHR Funds, LLC, a Delaware limited liability company, as general partner "
        "(the &ldquo;General Partner&rdquo;) and those additional parties listed in "
        "the books and records of the Partnership that have been or shall be admitted "
        "as limited partners in accordance with the terms of this Agreement (the "
        "&ldquo;Limited Partners&rdquo;), and Scott R. McBrien and Cindy Eagar, as the "
        "Withdrawing Limited Partner (the &ldquo;Withdrawing Limited Partner&rdquo;).",
        BODY))

    story.append(P("<b>RECITALS</b>", ARTICLE_HDR))

    story.append(P(
        "WHEREAS, PNTHR Funds, LLC formed the Partnership by filing the Certificate "
        "of Limited Partnership of the Partnership (the &ldquo;Certificate of "
        "Limited Partnership&rdquo;) with the Secretary of State of the State of "
        "Delaware on June 1, 2026; and",
        BODY))

    story.append(P(
        "WHEREAS, the parties hereto wish to (a) enter into this Agreement to "
        "govern the affairs of the Partnership; (b) admit the parties listed in "
        "the books and records of the Partnership as Limited Partners of the "
        "Partnership; and (c) effect the withdrawal of the Withdrawing Limited "
        "Partner from the Partnership.",
        BODY))

    story.append(P(
        "NOW, THEREFORE, in consideration of the mutual covenants herein contained "
        "and of other good and valuable consideration, the receipt and sufficiency "
        "of which are hereby acknowledged, the parties hereto, intending to be "
        "legally bound hereby, agree as follows:",
        BODY))

    return story


# ═══════════════════════════════════════════════════════════════════════════
# ARTICLE I — DEFINITIONS
# ═══════════════════════════════════════════════════════════════════════════
def build_article_i():
    story = []
    story.extend(article("I", "DEFINITIONS"))

    story.append(P(
        "<b>Section 1.01&nbsp;&nbsp;Definitions.</b>  Capitalized terms used herein "
        "and not otherwise defined shall have the meanings set forth in this Section "
        "1.01:",
        BODY))

    story.append(defn("Advisers Act",
        "means the Investment Advisers Act of 1940, as amended from time to time."))

    story.append(defn("Affiliate",
        "means, with respect to any Person, any other Person that, directly or "
        "indirectly (including through one or more intermediaries), controls, is "
        "controlled by, or is under common control with such Person. The term "
        "&ldquo;control&rdquo; means (a) the legal or beneficial ownership of "
        "securities representing a majority of the voting power of any Person, or "
        "(b) the possession, directly or indirectly, of the power to direct or "
        "cause the direction of the management and policies of any Person, whether "
        "through ownership of voting securities or partnership or other ownership "
        "interests, by contract, or otherwise; and the terms &ldquo;controlling&rdquo; "
        "and &ldquo;controlled&rdquo; shall have correlative meanings."))

    story.append(defn("After-Tax Amount",
        "means an amount equal to (a) the amount of Performance Allocation "
        "Distributions to the General Partner with respect to a Limited Partner "
        "minus (b) the amount of income tax imposed on the General Partner and its "
        "direct and indirect members with respect to (i) allocations of taxable "
        "income related to such Performance Allocation or (ii) Performance Allocation "
        "Distributions (including taxes borne by the General Partner and its direct "
        "and indirect members for the sale of securities initially received in kind "
        "pursuant to Section 8.04 assuming such securities were sold immediately "
        "after such distributions in kind), in each case based on the Assumed Tax "
        "Rate."))

    story.append(defn("Agreement",
        "means this Limited Partnership Agreement, as it may be amended, modified, "
        "supplemented, or restated from time to time, as provided herein."))

    story.append(defn("AML Laws",
        "means the Uniting and Strengthening America by Providing Appropriate Tools "
        "Required to Intercept and Obstruct Terrorism (USA PATRIOT Act) Act of 2001, "
        "the Bank Secrecy Act of 1970, the International Money Laundering Abatement "
        "and Anti-Terrorist Financing Act of 2001, economic sanctions administered "
        "by the Office of Foreign Assets Control, and any other applicable "
        "anti-money-laundering, anti-terrorism, or economic-sanctions laws or "
        "regulations, in each case as the same may be amended from time to time."))

    story.append(defn("Assumed Tax Rate",
        "means the highest effective marginal combined federal, state, and local "
        "income tax rate for a Fiscal Year prescribed for an individual residing in "
        "New York, New York, taking into account the character (for example, long-"
        "term or short-term capital gain, ordinary, or exempt) of the applicable "
        "income."))

    story.append(defn("Available Assets",
        "means, for any period, the excess of (a) Distributable Cash and other "
        "property to be distributed pursuant to Section 8.01 and Temporary Investments "
        "over (b) the sum of (i) Investment Expenses, (ii) amounts paid or payable in "
        "respect of any loan or other Indebtedness of the Partnership, and (iii) the "
        "amount of reserves established by the General Partner as contemplated by "
        "Section 3.02(n)."))

    story.append(defn("Bad Actor Event",
        "means the occurrence of any of the disqualifying events set forth in Rule "
        "506(d)(1)(i)-(viii) of Regulation D under the Securities Act with respect "
        "to the General Partner, any of its Affiliates, or any officer, director, or "
        "general partner thereof."))

    story.append(defn("Bankruptcy",
        "means, with respect to any Person, the occurrence of any of the following: "
        "(a) the filing of an application by such Person for, or consent to, the "
        "appointment of a trustee of such Person&rsquo;s assets; (b) the filing by "
        "such Person of a voluntary petition in bankruptcy or the filing of a "
        "pleading in any court of record admitting in writing such Person&rsquo;s "
        "inability to pay its debts as they come due; (c) the making by such Person "
        "of a general assignment for the benefit of such Person&rsquo;s creditors; "
        "(d) the filing by such Person of an answer admitting the material "
        "allegations of, or such Person&rsquo;s consenting to, or defaulting in "
        "answering a bankruptcy petition filed against, such Person in any "
        "bankruptcy proceeding; or (e) the expiration of sixty (60) days following "
        "the entry of an order, judgment, or decree by any court of competent "
        "jurisdiction adjudicating such Person a bankrupt or appointing a trustee of "
        "such Person&rsquo;s assets."))

    story.append(defn("BBA",
        "means the Bipartisan Budget Act of 2015."))

    story.append(defn("Benefit Plan Investor",
        "means a limited partner that is any of the following:"))
    story.append(subpara("(a)  an &ldquo;employee benefit plan&rdquo; within the meaning of Section 3(3) of ERISA that is subject to Title I of ERISA;"))
    story.append(subpara("(b)  a &ldquo;plan&rdquo; within the meaning of, and subject to, Section 4975 of the Code; or"))
    story.append(subpara("(c)  any person or entity whose assets are deemed to include the assets of any such &ldquo;employee benefit plan&rdquo; or &ldquo;plan&rdquo; under the Plan Asset Rules or otherwise for purposes of Section 406 of ERISA or Section 4975 of the Code."))

    story.append(defn("BHC Limited Partner",
        "means a Limited Partner that is a bank holding company, a subsidiary of a "
        "bank holding company, or an entity otherwise subject to the restrictions of "
        "Section 4 of the U.S. Bank Holding Company Act of 1956, as amended, or "
        "Section 13 of the Bank Holding Company Act (the &ldquo;Volcker Rule&rdquo;)."))

    story.append(defn("Book Depreciation",
        "means, with respect to any Partnership asset for each Fiscal Year, the "
        "Partnership&rsquo;s depreciation, amortization, or other cost-recovery "
        "deductions determined for federal income tax purposes, except that if the "
        "Book Value of an asset differs from its adjusted tax basis at the beginning "
        "of such Fiscal Year, Book Depreciation shall be an amount which bears the "
        "same ratio to such beginning Book Value as the federal income tax "
        "depreciation, amortization, or other cost-recovery deduction for such "
        "Fiscal Year bears to such beginning adjusted tax basis; <i>provided</i>, "
        "that if the adjusted basis for federal income tax purposes of an asset at "
        "the beginning of such Fiscal Year is zero and the Book Value of the asset "
        "is positive, Book Depreciation shall be determined with reference to such "
        "beginning Book Value using any permitted method selected by the General "
        "Partner in accordance with Treasury Regulation Section 1.704-1(b)(2)(iv)(g)(3)."))

    story.append(defn("Book Value",
        "means, with respect to any Partnership asset, the adjusted basis of such "
        "asset for federal income tax purposes, subject to the customary Treasury "
        "Regulation adjustments described in the Partnership&rsquo;s tax policies, "
        "including adjustments upon (i) the acquisition of an additional Interest in "
        "the Partnership by a new or existing Partner in consideration of a Capital "
        "Contribution of more than a <i>de minimis</i> amount; (ii) the distribution "
        "by the Partnership to a Partner of more than a <i>de minimis</i> amount of "
        "property (other than cash); and (iii) the liquidation of the Partnership "
        "within the meaning of Treasury Regulation Section 1.704-1(b)(2)(ii)(g)."))

    story.append(defn("Business Day",
        "means any day other than a Saturday, Sunday, or other day on which "
        "commercial banks in New York, New York are authorized or required to close."))

    story.append(defn("Capital Account",
        "has the meaning set forth in Section 6.04."))

    story.append(defn("Capital Commitment",
        "means, with respect to each Partner, the amount set forth in such "
        "Partner&rsquo;s accepted Subscription Agreement and reflected in the books "
        "and records of the Partnership (or, for the General Partner, the amount "
        "otherwise committed to the Partnership) to be contributed by such Partner "
        "to the Partnership pursuant to and in accordance with this Agreement, as "
        "such amount may be amended from time to time pursuant to the terms of this "
        "Agreement."))

    story.append(defn("Capital Contribution",
        "means, with respect to any Partner at any time, unless otherwise provided "
        "in this Agreement, the aggregate amount of capital contributed by such "
        "Partner to the Partnership pursuant to the terms of this Agreement."))

    story.append(defn("Cause",
        "means the occurrence of any of the following with respect to the General "
        "Partner or any of its Affiliates or principals: (i) a final, non-appealable "
        "judgment by a court of competent jurisdiction (or a final, non-appealable "
        "arbitral award) finding the General Partner or any of its Affiliates to "
        "have committed an act constituting fraud, willful misconduct, or gross "
        "negligence directly and materially harmful to the Partnership; (ii) a "
        "conviction (or a plea of nolo contendere) of a principal of the General "
        "Partner to a felony involving moral turpitude; (iii) a Bad Actor Event "
        "applicable to the General Partner or any of its Affiliates or principals; "
        "or (iv) a final determination by a court or arbitrator that the General "
        "Partner has engaged in an intentional material breach of its fiduciary duty "
        "to the Partnership. For the avoidance of doubt, poor investment performance, "
        "a decline in Net Asset Value, disagreement with investment strategy, or any "
        "other business or market-related outcome shall not constitute Cause. Any "
        "Cause event that is reasonably capable of being cured shall be subject to "
        "a thirty (30) day cure period following written notice thereof to the "
        "General Partner."))

    story.append(defn("Certificate of Cancellation",
        "has the meaning set forth in Section 12.02(d)."))

    story.append(defn("Certificate of Limited Partnership",
        "has the meaning set forth in the Recitals."))

    # Tier class definitions
    story.append(defn("Wagyu Interests",
        "means Limited Partner Interests where the purchasing Limited Partner "
        "invested at least $1,000,000 into the Partnership, or the Limited "
        "Partner&rsquo;s Capital Account balance has grown to exceed $1,000,000. "
        "The Wagyu Interests shall be subject to a 20% Performance Allocation "
        "payable to the General Partner (or, at the General Partner&rsquo;s "
        "discretion, to the Investment Manager) in respect of Net Profits in "
        "excess of the Hurdle Rate. For any Limited Partner whose Capital Account "
        "balance remains at or above the initial Capital Contribution, Wagyu "
        "Interests held continuously for at least three (3) consecutive Fiscal "
        "Years shall thereafter be subject to a permanently reduced 15% Performance "
        "Allocation rate."))

    story.append(defn("Porterhouse Interests",
        "means Limited Partner Interests where the purchasing Limited Partner "
        "invested at least $500,000 but less than $1,000,000 into the Partnership, "
        "or the Limited Partner&rsquo;s Capital Account balance has grown to exceed "
        "$500,000 but is less than $1,000,000. The Porterhouse Interests shall be "
        "subject to a 25% Performance Allocation in respect of Net Profits in excess "
        "of the Hurdle Rate. For any Limited Partner whose Capital Account balance "
        "remains at or above the initial Capital Contribution, Porterhouse Interests "
        "held continuously for at least three (3) consecutive Fiscal Years shall "
        "thereafter be subject to a permanently reduced 20% Performance Allocation "
        "rate."))

    story.append(defn("Filet Interests",
        "means Limited Partner Interests where the purchasing Limited Partner "
        "invested at least $100,000 but less than $500,000 into the Partnership. "
        "The Filet Interests shall be subject to a 30% Performance Allocation in "
        "respect of Net Profits in excess of the Hurdle Rate. For any Limited "
        "Partner whose Capital Account balance remains at or above the initial "
        "Capital Contribution, Filet Interests held continuously for at least three "
        "(3) consecutive Fiscal Years shall thereafter be subject to a permanently "
        "reduced 25% Performance Allocation rate."))

    story.append(defn("Closing",
        "means the Initial Closing or any Subsequent Closing, as the case may be."))

    story.append(defn("Code",
        "means the U.S. Internal Revenue Code of 1986, as amended."))

    story.append(defn("Controlling Person",
        "means any person or entity (other than a Benefit Plan Investor), or any "
        "affiliates (within the meaning of 29 C.F.R. Section 2510.3-101(f)(3)) of "
        "such person or entity, who exercises control over the assets of the "
        "Partnership or provides investment advice with respect to such assets for "
        "a fee, directly or indirectly."))

    story.append(defn("Covered Person",
        "means the General Partner (including the General Partner in its role as "
        "Partnership Representative and, if applicable, in its capacity as a "
        "Special Limited Partner or a former general partner), each of its "
        "Affiliates, any officers, directors, managers, employees, shareholders, "
        "partners, members, agents, and consultants of any of the foregoing, the "
        "members of the Investment Manager, and any director, officer, or manager "
        "of any entity in which the Partnership invests serving in such capacity "
        "at the request of the General Partner."))

    story.append(defn("Current Income",
        "means income from the Portfolio Investments other than Disposition "
        "Proceeds, net of Partnership Expenses and reserves therefor which are "
        "allocated to such income or otherwise as provided for under this Agreement."))

    story.append(defn("Delaware Act",
        "means the Delaware Revised Uniform Limited Partnership Act (6 Del. C. § 17) "
        "and any successor statute, as amended from time to time."))

    story.append(defn("Disposition",
        "means, with respect to any Portfolio Investment, (a) the sale, exchange, "
        "or other disposition by the Partnership of all or any portion of that "
        "Portfolio Investment for cash or in exchange for Marketable Securities "
        "that are distributed to the Partners pursuant to Article VIII (including "
        "receipt by the Partnership of a liquidating dividend, distribution upon a "
        "sale of all or substantially all of the assets of a Portfolio Company, or "
        "other like distribution for cash or for Marketable Securities of a Portfolio "
        "Investment or any portion thereof which can be distributed to the Partners "
        "pursuant to Article VIII), (b) distributions in kind of all or any portion "
        "of that Portfolio Investment as permitted hereby, or (c) a Write-off of "
        "such Portfolio Investment."))

    story.append(defn("Disposition Proceeds",
        "means all amounts received by the Partnership upon the Disposition of a "
        "Portfolio Investment, net of Partnership Expenses and reserves for "
        "Partnership Expenses."))

    story.append(defn("Distributable Cash",
        "means all cash received by the Partnership relating to the Portfolio "
        "Investments or Temporary Investments other than Capital Contributions, "
        "including, without limitation, income, dividends, distributions, interest "
        "and proceeds from the Disposition of a Portfolio Investment, Current "
        "Income, and any other miscellaneous receipts or revenues of the Partnership "
        "related directly to Portfolio Investments held by the Partnership, to the "
        "extent such cash constitutes Available Assets."))

    story.append(defn("ECI",
        "means &ldquo;effectively connected income&rdquo; as defined in Section 864 "
        "of the Code or income treated as &ldquo;effectively connected&rdquo; under "
        "Section 897 of the Code."))

    story.append(defn("ERISA",
        "means the Employee Retirement Income Security Act of 1974, as amended from "
        "time to time."))

    story.append(defn("ERISA Partner",
        "means any Limited Partner that is a Benefit Plan Investor and any other "
        "Limited Partner to the extent that the General Partner has agreed to treat "
        "such Limited Partner as an ERISA Partner."))

    story.append(defn("Fair Market Value",
        "of any asset as of any date means the purchase price that a willing buyer "
        "having all relevant knowledge would pay a willing seller for such asset in "
        "an arm&rsquo;s length transaction, as determined in good faith by the "
        "General Partner based on such factors as the General Partner, in the "
        "exercise of its reasonable business judgment, considers relevant."))

    story.append(defn("Fair Value",
        "means the fair value of any Interest or Portfolio Investment, as determined "
        "in good faith by the General Partner using generally accepted valuation "
        "methods. All valuations shall be made taking into account all relevant "
        "factors that might reasonably affect the sales price of the Interest or "
        "Portfolio Investment in question. For all purposes of this Agreement, all "
        "valuations made in accordance with the foregoing shall be final and "
        "conclusive on the Partnership, the Fund Investors, the General Partner, "
        "and their successors and assigns, absent manifest error."))

    story.append(defn("Fiscal Year",
        "means the calendar year, unless the Partnership is required to have a "
        "taxable year other than the calendar year, in which case the Fiscal Year "
        "shall be the period that conforms to its taxable year."))

    story.append(defn("Fund",
        "means the Partnership."))

    story.append(defn("Fund Investors",
        "means the Limited Partners, collectively."))

    story.append(defn("General Partner",
        "means PNTHR Funds, LLC, a Delaware limited liability company, or any other "
        "Person who becomes a successor general partner pursuant to the terms of "
        "this Agreement."))

    story.append(defn("General Partner Commitment",
        "has the meaning set forth in Section 6.01(b)."))

    story.append(defn("Governmental Authority",
        "means any federal, state, local, or foreign government or political "
        "subdivision thereof, or any agency or instrumentality of such government "
        "or political subdivision, or any self-regulated organization or other "
        "non-governmental regulatory authority or quasi-governmental authority (to "
        "the extent that the rules, regulations, or orders of such organization or "
        "authority have the force of law), or any arbitrator, court, or tribunal of "
        "competent jurisdiction."))

    story.append(defn("High Water Mark",
        "means, with respect to each Limited Partner&rsquo;s Capital Account, the "
        "highest Capital Account balance (adjusted for Capital Contributions and "
        "withdrawals) achieved as of the end of any prior calendar quarter in which "
        "a Performance Allocation was accrued with respect to such Capital Account."))

    story.append(defn("Hurdle Rate",
        "means, for each calendar quarter, the annualized yield on the U.S. 2-Year "
        "Treasury Note (&ldquo;US2Y&rdquo;) as of the close of the first trading "
        "day of the Fiscal Year, divided by four (expressed as a quarterly rate). "
        "The Hurdle Rate is applied quarterly and is <i>not</i> cumulative across "
        "calendar quarters or Fiscal Years."))

    story.append(defn("Indebtedness",
        "means, with respect to any Person, (a)(i) all indebtedness of such Person "
        "for borrowed money or for the deferred purchase price of property, goods, "
        "or services; (ii) all other obligations, contingent or otherwise, of such "
        "Person for the repayment of borrowed money in the form of surety bonds, "
        "letters of credit, and bankers&rsquo; acceptances whether or not matured; "
        "and (iii) all net payment obligations under hedges and other derivative "
        "contracts and similar financial instruments; (b) all obligations of such "
        "Person evidenced by notes, bonds, debentures, or similar instruments; (c) "
        "all capital lease obligations of such Person; and (d) all indebtedness "
        "referred to in clause (a), (b), or (c) above secured by any lien upon or "
        "in property owned by such Person."))

    story.append(defn("Initial Closing",
        "means the initial closing of the Partnership, at which time the first "
        "Capital Commitments will be accepted. The Initial Closing will occur as "
        "soon as practicable at such time as the General Partner determines that "
        "sufficient Capital Commitments have been obtained in order for the "
        "Partnership to commence operations."))

    story.append(defn("Interest",
        "means the partnership interest of a Partner in the Partnership at any "
        "particular time, including the right of such Partner to any and all "
        "benefits to which such Partner may be entitled as provided in this "
        "Agreement or under the Delaware Act, together with the obligations of "
        "such Partner to comply with all the terms and provisions of this Agreement "
        "and of the Delaware Act."))

    story.append(defn("Investment Company Act",
        "means the Investment Company Act of 1940, as amended."))

    story.append(defn("Investment Expenses",
        "means the sum of (a) Organizational Expenses and (b) Operating Expenses."))

    story.append(defn("Investment Management Agreement",
        "has the meaning set forth in Section 9.01."))

    story.append(defn("Investment Management Fee",
        "means the annual management fee equal to 2.00% per annum of the Fund&rsquo;s "
        "Net Asset Value, accrued monthly and payable quarterly in advance to the "
        "Investment Manager (or, as the General Partner may direct, to the General "
        "Partner). The Investment Management Fee shall be calculated on the Net "
        "Asset Value as of the first Business Day of each fiscal quarter. The "
        "General Partner may retain the services of one or more sub-advisers and "
        "may remit part of the Investment Management Fee and/or Performance "
        "Allocation to such sub-adviser(s) in its sole discretion."))

    story.append(defn("Investment Manager",
        "has the meaning set forth in Section 9.01."))

    story.append(defn("Key Person",
        "means each of Scott R. McBrien and Cindy Eagar, and any replacement for "
        "any such person admitted in accordance with this Agreement."))

    story.append(defn("Key Person Event",
        "has the meaning set forth in Section 4.04(b)."))

    story.append(defn("Legal Violation",
        "has the meaning set forth in Section 11.05(a)."))

    story.append(defn("Limited Partner",
        "means any limited partner admitted to the Partnership in accordance with "
        "the terms of this Agreement."))

    story.append(defn("Liquidator",
        "has the meaning set forth in Section 12.02(a)."))

    story.append(defn("Loss Recovery Account",
        "means, for each Limited Partner, a memorandum account maintained by the "
        "Partnership that is debited by cumulative Net Losses allocated to such "
        "Limited Partner&rsquo;s Capital Account and credited by Net Profits "
        "subsequently allocated to such Capital Account. No Performance Allocation "
        "shall accrue in respect of any Limited Partner&rsquo;s Capital Account for "
        "any Fiscal Year unless and until the balance of such Limited Partner&rsquo;s "
        "Loss Recovery Account has been restored to zero."))

    story.append(defn("Majority in Interest",
        "means Limited Partners whose Capital Commitments represent greater than "
        "50% of the aggregate Capital Commitments of all Limited Partners. Except "
        "as otherwise specifically provided herein, the Limited Partners shall be "
        "considered to constitute a single class or group, the vote of which shall "
        "be counted together for purposes of granting any consent of a Majority in "
        "Interest pursuant to this Agreement or the Delaware Act."))

    story.append(defn("Marketable Securities",
        "means Securities that (a) are tradable on an established national U.S. or "
        "non-U.S. stock exchange or reported through NASDAQ or a comparable "
        "established non-U.S. over-the-counter trading system and (b) are not "
        "subject to restrictions on transfer under the Securities Act or contractual "
        "restrictions on transfer."))

    story.append(defn("NASDAQ",
        "means The Nasdaq Stock Market LLC."))

    story.append(defn("Net Adjusted Capital Contribution",
        "means, with respect to each Partner, as of any time, the aggregate Capital "
        "Contributions of such Partner as of such time, less the sum of any "
        "distributions in return of such Capital Contributions previously made to "
        "such Partner pursuant to Section 8.01."))

    story.append(defn("Net Asset Value",
        "means the total value of all of the Partnership&rsquo;s assets, minus all "
        "liabilities, determined in accordance with the Partnership&rsquo;s valuation "
        "policy and applicable law."))

    story.append(defn("Net Income or Net Loss",
        "means, for each Fiscal Year or other period specified in this Agreement, "
        "an amount equal to the Partnership&rsquo;s taxable income or taxable loss, "
        "or particular items thereof, determined in accordance with Section 703(a) "
        "of the Code (where, for this purpose, all items of income, gain, loss, or "
        "deduction required to be stated separately pursuant to Section 703(a)(1) "
        "of the Code shall be included in taxable income or taxable loss), with the "
        "customary adjustments for partnership book-tax differences and Treasury "
        "Regulation Section 1.704-1 Capital Account conventions."))

    story.append(defn("Net Profits",
        "means, for any calendar quarter, Net Income for such calendar quarter "
        "(if positive), and for any Fiscal Year, the aggregate of Net Profits for "
        "each calendar quarter in such Fiscal Year."))

    story.append(defn("New Issues",
        "has the meaning set forth in FINRA Rule 5130 (as amended and as "
        "supplemented by FINRA Rule 5131)."))

    story.append(defn("Non-Public Information",
        "has the meaning set forth in Section 16.13(b)."))

    story.append(defn("Non-United States Limited Partner",
        "means a Limited Partner that is not a &ldquo;United States person&rdquo; "
        "as that term is defined in Section 7701(a)(30) of the Code."))

    story.append(defn("Nonrecourse Deductions",
        "means nonrecourse deductions as described in Treasury Regulation Section "
        "1.704-2(c)."))

    story.append(defn("Nonrecourse Liability",
        "has the meaning set forth in Treasury Regulation Section 1.704-2(b)(3)."))

    story.append(defn("Operating Expenses",
        "means, except as otherwise specifically provided in this Agreement, all "
        "third-party costs and expenses of maintaining the operations of the Fund "
        "and appraising and valuing, acquiring, maintaining, financing, hedging, "
        "and disposing of Portfolio Investments, including broken deal expenses "
        "(to the extent not paid for or reimbursed by Portfolio Investments), "
        "including, without limitation, taxes, fees, and other governmental charges "
        "levied against the Fund; insurance; administrative and research fees; "
        "expenses of custodians, outside advisors, counsel (including Partnership "
        "Counsel), accountants, auditors, administrators, and other consultants and "
        "professionals; technological expenses; interest on and fees, costs, and "
        "expenses arising out of all financings entered into by the Fund; travel "
        "expenses; brokerage commissions; custodial expenses; litigation expenses; "
        "winding up and liquidation expenses; expenses incurred in connection with "
        "any tax audit, investigation, settlement, or review; indemnification and "
        "other unreimbursed expenses; and any extraordinary expenses to the extent "
        "not reimbursed or paid by insurance, but specifically excluding the "
        "Investment Management Fee and Organizational Expenses."))

    story.append(defn("Organizational Expenses",
        "means all out-of-pocket expenses incurred in connection with the "
        "organization and formation of the General Partner and the Partnership, "
        "and the offering of the Interests, including, without limitation, legal "
        "and accounting fees and expenses, printing costs, filing fees, and the "
        "transportation, meal, and lodging expenses of the personnel of the General "
        "Partner and the Investment Manager."))

    story.append(defn("Partner(s)",
        "means, as the context may require, some or all of the General Partner and "
        "the Limited Partners."))

    story.append(defn("Partnership",
        "means the limited partnership referred to in this Agreement, as it may "
        "from time to time be constituted."))

    story.append(defn("Partnership Counsel",
        "has the meaning set forth in Section 16.12."))

    story.append(defn("Partnership Expenses",
        "means the sum of the Operating Expenses."))

    story.append(defn("Partnership Interest Rate",
        "has the meaning set forth in Section 8.03(b)."))

    story.append(defn("Partnership Minimum Gain",
        "means the &ldquo;partnership minimum gain&rdquo; determined in accordance "
        "with Treasury Regulation Section 1.704-2(b)(2) and Section 1.704-2(d)."))

    story.append(defn("Partnership Representative",
        "has the meaning set forth in Section 10.02."))

    story.append(defn("Percentage Interest",
        "means, as to any Partner, a fraction, expressed as a percentage, equal to "
        "the Capital Account of such Partner divided by the total Capital Accounts "
        "of all Partners, as may be adjusted from time to time in accordance with "
        "the provisions of this Agreement."))

    story.append(defn("Performance Allocation",
        "has the meaning set forth in Section 8.01(c)."))

    story.append(defn("Performance Allocation Distributions",
        "means all amounts distributed to the General Partner pursuant to Section "
        "8.01 and Section 12.02 in respect of the Performance Allocation and "
        "advances to the General Partner pursuant to Section 8.02 to the extent "
        "not repaid from subsequent distributions."))

    story.append(defn("Person",
        "means any individual, corporation, partnership, joint venture, limited "
        "liability company, Governmental Authority, unincorporated organization, "
        "trust, association, or other entity."))

    story.append(defn("Placement Agent",
        "means any placement agent, financial advisor, or finder retained by the "
        "General Partner in connection with the offering and sale of the Interests."))

    story.append(defn("Plan Asset Rules",
        "means the Department of Labor regulation 29 CFR § 2510.3-101, as modified "
        "by Section 3(42) of ERISA, as modified or amended from time to time."))

    story.append(defn("Portfolio Company",
        "means, with respect to any Investment, a Person whose Securities have been "
        "acquired, directly or indirectly, in whole or in part, by the Partnership "
        "in relation to such Investment, other than through a Temporary Investment."))

    story.append(defn("Portfolio Investment",
        "has the meaning set forth in Section 3.01(b). Multiple assets acquired in a "
        "single transaction or series of related transactions, to the extent such "
        "assets are intended to be aggregated and managed collectively or by a "
        "single Portfolio Company, shall be treated as a single Portfolio Investment."))

    story.append(defn("Private Placement Memorandum",
        "means the Confidential Private Placement Memorandum of the Fund dated "
        "June 1, 2026, as amended and supplemented from time to time."))

    story.append(defn("Qualified Client",
        "means a &ldquo;qualified client&rdquo; within the meaning of Rule 205-3 "
        "promulgated under the Advisers Act."))

    story.append(defn("Realized Investment",
        "means, as of any date, a Portfolio Investment or portion thereof that has "
        "been the subject of a Disposition."))

    story.append(defn("Redemption Request",
        "has the meaning set forth in Section 8.06."))

    story.append(defn("Regulations",
        "mean the final or temporary regulations of the United States Department "
        "of Treasury promulgated under the Code, and any successor regulations."))

    story.append(defn("Revised Partnership Audit Rules",
        "has the meaning set forth in Section 10.02(a)."))

    story.append(defn("Securities",
        "means shares of capital stock, partnership interests, limited liability "
        "company interests, warrants, options, bonds, notes, debentures, and other "
        "equity and debt instruments of any kind of any Person."))

    story.append(defn("Securities Act",
        "means the Securities Act of 1933, as amended, or any successor federal "
        "statute, and the rules and regulations thereunder, which shall be in "
        "effect at the time."))

    story.append(defn("Service",
        "means the U.S. Internal Revenue Service, a branch of the U.S. Treasury "
        "Department."))

    story.append(defn("Side Pocket Investment",
        "has the meaning set forth in Section 8.07."))

    story.append(defn("Similar Law",
        "means any federal, state, local, or foreign law or regulation that would "
        "cause the underlying assets of the Partnership to be treated similar to "
        "&ldquo;plan assets&rdquo; under the Plan Asset Rules and impose on the "
        "General Partner (or other Persons responsible for the operation and "
        "management of the Partnership and investment of the Partnership&rsquo;s "
        "assets) responsibilities similar to those of a &ldquo;fiduciary&rdquo; "
        "within the meaning of ERISA."))

    story.append(defn("Special Limited Partner",
        "has the meaning set forth in Section 4.08(a)."))

    story.append(defn("Subscription Agreement",
        "means the agreement executed and delivered by a Limited Partner pursuant "
        "to which it makes a Capital Commitment to the Partnership and agrees to "
        "be bound by the terms of this Agreement."))

    story.append(defn("Subsequent Closing",
        "means a Closing of Capital Commitments to the Partnership that occurs "
        "after the Initial Closing."))

    story.append(defn("Substitute Limited Partner",
        "has the meaning set forth in Section 11.03."))

    story.append(defn("Super Majority in Interest",
        "means Limited Partners whose Capital Commitments represent greater than "
        "75.0% of the aggregate Capital Commitments of all Limited Partners. Except "
        "as otherwise specifically provided herein, the Limited Partners shall be "
        "considered to constitute a single class or group, the vote of which shall "
        "be counted together for purposes of granting any consent of a Super "
        "Majority in Interest pursuant to this Agreement or the Delaware Act."))

    story.append(defn("Tax Exempt Limited Partner",
        "means a Limited Partner that is exempt from United States federal income "
        "taxation, including a partner that is exempt under Section 501 of the Code."))

    story.append(defn("Taxing Authority",
        "means any federal, state, local, or foreign taxing authority."))

    story.append(defn("Temporary Investments",
        "has the meaning set forth in Section 3.02(k)."))

    story.append(defn("Transfer",
        "means to directly or indirectly sell, transfer, assign, pledge, encumber, "
        "hypothecate, or similarly dispose of, either voluntarily or involuntarily, "
        "by operation of law or otherwise, or to enter into any contract, option, "
        "or other arrangement or understanding with respect to the sale, transfer, "
        "assignment, pledge, encumbrance, hypothecation, or similar disposition of, "
        "all or a portion of an Interest or beneficial ownership thereof. "
        "&ldquo;Transfer&rdquo; when used as a noun shall have a correlative "
        "meaning."))

    story.append(defn("UBTI",
        "means &ldquo;unrelated business taxable income&rdquo; within the meaning "
        "of Section 512 of the Code, determined without regard to the special rules "
        "contained in Section 512(a)(3) of the Code that are applicable solely to "
        "organizations described in paragraphs (7), (9), (17), or (20) of Section "
        "501(c) of the Code."))

    story.append(defn("US2Y",
        "has the meaning set forth in the definition of Hurdle Rate."))

    story.append(defn("Withdrawal Date",
        "has the meaning set forth in Section 11.05(a)."))

    story.append(defn("Withdrawal Gate",
        "has the meaning set forth in Section 8.06(c)."))

    story.append(defn("Withdrawing Limited Partner",
        "has the meaning set forth in the Recitals."))

    story.append(defn("Withholding Advances",
        "has the meaning set forth in Section 8.03(b)."))

    story.append(defn("Write-off",
        "means a Portfolio Investment that has ceased to be actively managed on "
        "behalf of the Partnership with a determination by the General Partner, in "
        "its sole discretion, that the Portfolio Investment has a <i>de minimis</i> "
        "or no value."))

    story.append(spacer(8))

    story.extend(section("1.02", "Interpretation",
        "For purposes of this Agreement, (a) the words &ldquo;include,&rdquo; "
        "&ldquo;includes,&rdquo; and &ldquo;including&rdquo; shall be deemed to be "
        "followed by the words &ldquo;without limitation&rdquo;; (b) the word "
        "&ldquo;or&rdquo; is not exclusive; and (c) the words &ldquo;herein,&rdquo; "
        "&ldquo;hereof,&rdquo; &ldquo;hereby,&rdquo; &ldquo;hereto,&rdquo; and "
        "&ldquo;hereunder&rdquo; refer to this Agreement as a whole. The "
        "definitions given for any defined terms in this Agreement shall apply "
        "equally to both the singular and plural forms of the terms defined. "
        "Whenever the context may require, any pronoun shall include the "
        "corresponding masculine, feminine, and neuter forms. Unless the context "
        "otherwise requires, references herein to (x) Articles, Sections, Exhibits, "
        "and Schedules mean the Articles, Sections, Exhibits, and Schedules of, "
        "and attached to, this Agreement; (y) an agreement, instrument, or other "
        "document means such agreement, instrument, or other document as amended, "
        "supplemented, and modified from time to time to the extent permitted by "
        "the provisions thereof; and (z) a statute means such statute as amended "
        "from time to time and includes any successor legislation thereto and any "
        "regulations promulgated thereunder. This Agreement shall be construed "
        "without regard to any presumption or rule requiring construction or "
        "interpretation against the party drafting an instrument or causing any "
        "instrument to be drafted."))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# ARTICLE II — GENERAL PROVISIONS
# ═══════════════════════════════════════════════════════════════════════════
def build_article_ii():
    story = []
    story.extend(article("II", "GENERAL PROVISIONS"))

    story.extend(section("2.01", "Formation and Continuation",
        "The Partnership was formed as a limited partnership under the laws of the "
        "State of Delaware by the filing of the Certificate of Limited Partnership "
        "with the Secretary of State of the State of Delaware on June 1, 2026, "
        "as required by the Delaware Act. The parties agree to continue the "
        "Partnership as a limited partnership pursuant to the Delaware Act on the "
        "terms set forth in this Agreement. The General Partner is authorized to "
        "take all action necessary or appropriate to comply with all applicable "
        "requirements for the operation of the Partnership as a limited partnership "
        "in the State of Delaware and in all other jurisdictions in which the "
        "Partnership may elect to conduct business."))

    story.extend(section("2.02", "Name",
        "The name of the Partnership is &ldquo;PNTHR FUNDS, PNTHR AI Elite 300 Fund, "
        "LP.&rdquo; The General Partner is authorized to make any variations in the "
        "Partnership&rsquo;s name that the General Partner may deem necessary or "
        "advisable to comply with the laws of any jurisdiction in which the "
        "Partnership may elect to conduct business; <i>provided</i>, that such name "
        "as varied shall be a name permitted for a limited partnership under the "
        "Delaware Act and the General Partner shall promptly give notice of any "
        "such variation to the Limited Partners."))

    story.extend(section("2.03", "Principal Office",
        "The principal place of business and office of the Partnership is located "
        "at 15150 W Park Place, Suite 215, Goodyear, AZ 85395, or at such other "
        "place or places as the General Partner may from time to time designate. "
        "The General Partner may establish such additional places of business of "
        "the Partnership in such other jurisdictions as it may from time to time "
        "determine. The General Partner shall provide notice to the Limited "
        "Partners of any change in the Partnership&rsquo;s principal place of "
        "business."))

    story.extend(section("2.04", "Registered Office; Registered Agent",
        "The registered office of the Partnership shall be the office of the "
        "initial registered agent named in the Certificate of Limited Partnership, "
        "or such other office (which need not be a place of business of the "
        "Partnership) as the General Partner may designate from time to time in the "
        "manner provided by the Delaware Act. The registered agent for service of "
        "process on the Partnership in the State of Delaware shall be the initial "
        "registered agent named in the Certificate of Limited Partnership, or such "
        "other Person or Persons as the General Partner may designate from time to "
        "time in the manner provided by the Delaware Act."))

    story.extend(section("2.05", "Term",
        "The Partnership is an open-ended, evergreen fund with no set end date. "
        "The General Partner expects to originate and acquire assets on a frequent "
        "and ongoing basis and will continue to do so indefinitely until the "
        "General Partner believes market conditions do not justify doing so. The "
        "General Partner intends generally to utilize the return of capital from "
        "the Disposition of assets to originate and acquire new assets rather than "
        "return capital to the Limited Partners; however, the General Partner "
        "expects to manage the Partnership&rsquo;s investments and capital "
        "structure in such a manner as to attempt to provide a reasonable level of "
        "capability for the Partnership to accommodate withdrawal requests. The "
        "term of the Partnership commenced on the date the Partnership&rsquo;s "
        "Certificate of Limited Partnership was filed with the Secretary of State "
        "of the State of Delaware and shall, unless earlier dissolved and "
        "terminated pursuant to this Agreement in the General Partner&rsquo;s sole "
        "discretion, be a perpetual, open-ended Partnership. At such time as the "
        "Partnership is terminated, the General Partner, or if a different Person, "
        "the Liquidator, shall file a Certificate of Cancellation as required by "
        "the Delaware Act."))

    story.extend(section("2.06", "Withdrawing Limited Partner",
        "Upon the admission of one or more Limited Partners to the Partnership on "
        "the Initial Closing Date, the Withdrawing Limited Partner shall (a) "
        "receive a return of any amounts contributed by the Withdrawing Limited "
        "Partner to the Partnership, (b) withdraw from the Partnership, and (c) "
        "cease to be and have no further right, interest, liability, or obligation "
        "of any kind whatsoever as a Partner in the Partnership."))

    story.extend(section("2.07", "Conflict between Agreement and Statute",
        "This Agreement shall constitute the &ldquo;limited partnership "
        "agreement&rdquo; (as that term is used in the Delaware Act) of the "
        "Partnership. The rights, powers, duties, obligations, and liabilities of "
        "the Partners shall be determined pursuant to the Delaware Act and this "
        "Agreement. To the extent that the rights, powers, duties, obligations, "
        "and liabilities of any Partner are different by reason of any provision "
        "of this Agreement than they would be under the Delaware Act in the "
        "absence of such provision, this Agreement shall, to the extent permitted "
        "by the Delaware Act, control."))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# ARTICLE III — PURPOSE AND BUSINESS
# ═══════════════════════════════════════════════════════════════════════════
def build_article_iii():
    story = []
    story.extend(article("III", "PURPOSE AND BUSINESS"))

    story.extend(section("3.01", "Purpose",
        "The purpose of the Partnership is to make investments in accordance with "
        "this Agreement, and to engage in such other activities as are permitted "
        "hereby or are incidental or ancillary thereto as the General Partner "
        "shall deem necessary or advisable, all upon the terms and conditions set "
        "forth in this Agreement and in any other acts or activities permitted by "
        "law. The Partnership, and the General Partner on behalf of the Partnership, "
        "may enter into and perform each Subscription Agreement, any documents "
        "contemplated thereby or related thereto, and any amendments thereto, "
        "without any further act, vote, or approval of any Person, including any "
        "Partner, notwithstanding any other provision of this Agreement. The "
        "General Partner is hereby authorized to enter into the documents described "
        "in the preceding sentence on behalf of the Partnership, but such "
        "authorization shall not be deemed a restriction on the power of the "
        "General Partner to enter into other documents on behalf of the Partnership. "
        "The Partnership:"))

    story.append(subpara(
        "(a)  seeks to invest in a manner intended to achieve attractive "
        "risk-adjusted returns and preserve investor capital by investing primarily "
        "in publicly traded U.S. equities and exchange-traded funds guided by the "
        "proprietary PNTHR Signal System (as described in the Private Placement "
        "Memorandum); and"))
    story.append(subpara(
        "(b)  will seek to accomplish the investment objectives outlined in "
        "clause (a) above by investing, directly or indirectly, primarily in "
        "publicly traded U.S. equities and exchange-traded funds "
        "(&ldquo;<b>Portfolio Investments</b>&rdquo;)."))

    story.extend(section("3.02", "Authorized Activities",
        "In carrying out the purposes of this Agreement, the Partnership and the "
        "General Partner, acting on behalf of the Partnership, shall have all "
        "powers necessary, suitable, or convenient thereto, including, without "
        "limitation, the power and authority to do or cause to be done, or not to "
        "do, any and all acts deemed by the General Partner in good faith to be "
        "necessary or appropriate in furtherance of the purposes of the Partnership "
        "including, without limitation, the power and authority to:"))

    story.append(subpara("(a)  acquire, invest in, hold, pledge, manage, sell, transfer, operate, or otherwise deal in or with the Portfolio Investments;"))
    story.append(subpara("(b)  open, maintain, and close bank, brokerage, and money market accounts and draw checks and other orders for the payment of moneys;"))
    story.append(subpara("(c)  borrow money or otherwise incur Indebtedness for any Partnership purpose, enter into credit facilities, issue evidence of Indebtedness and guarantees, and secure any such evidences of Indebtedness and guarantees by pledges or other liens on assets of the Partnership;"))
    story.append(subpara("(d)  hire consultants, advisors, custodians, attorneys, accountants, placement agents, and such other agents and employees of the Partnership, and authorize each such Person to act for and on behalf of the Partnership;"))
    story.append(subpara("(e)  enter into, perform, and carry out contracts and agreements of any kind necessary, advisable, or incidental to the accomplishment of the purposes of the Partnership;"))
    story.append(subpara("(f)  bring, sue, prosecute, defend, settle, or compromise actions and proceedings at law or in equity or before any Governmental Authority;"))
    story.append(subpara("(g)  have and maintain one or more offices and in connection therewith to rent or acquire office space and to engage personnel;"))
    story.append(subpara("(h)  execute, deliver, and perform all agreements in connection with the sale of Interests, including but not limited to the Subscription Agreements and any side letters with one or more Limited Partners;"))
    story.append(subpara("(i)  form one or more subsidiary corporations or partnerships or other entities;"))
    story.append(subpara("(j)  incur all expenditures and pay the fees described in Section 3.08;"))
    story.append(subpara(
        "(k)  (i) make investments in (A) marketable direct obligations issued or "
        "unconditionally guaranteed by the United States or issued by any agency "
        "thereof, maturing within one year from the date of acquisition; (B) money "
        "market instruments, commercial paper, or other short-term debt obligations "
        "rated Aa or P-1 (or the equivalent thereof) or better by Moody&rsquo;s "
        "Investors Service Inc. or A-1 (or its equivalent) or better by Standard "
        "&amp; Poor&rsquo;s Corporation; (C) certificates of deposit maturing within "
        "one year from the date of acquisition, money market accounts, savings "
        "accounts, checking accounts, or any combination thereof in banks; and (D) "
        "any other Securities that the General Partner reasonably determines are "
        "appropriate for short-term investments (collectively, &ldquo;<b>Temporary "
        "Investments</b>&rdquo;); and (ii) in connection with its Portfolio "
        "Investments, enter into derivative contracts and other financial "
        "instruments for the purpose of hedging such Portfolio Investments;"))
    story.append(subpara(
        "(l)  make any and all elections under the Code or any state or local tax "
        "law (except as otherwise provided herein), including pursuant to Sections "
        "734(b), 743(b), and 754 of the Code; <i>provided</i>, that the General "
        "Partner shall not cause the Partnership to make an election to be treated "
        "as other than a partnership for United States federal income tax purposes;"))
    story.append(subpara("(m)  take all actions it deems necessary or appropriate so that the assets of the Partnership do not constitute &ldquo;plan assets&rdquo; for purposes of ERISA and the Plan Asset Rules;"))
    story.append(subpara("(n)  maintain cash reserves for anticipated Investment Expenses, liabilities, and obligations of the Partnership, whether actual or contingent, in such amounts as the General Partner in its reasonable discretion deems necessary or advisable; and"))
    story.append(subpara("(o)  carry on any other activities necessary to, in connection with, or incidental to, any of the foregoing or the Partnership&rsquo;s investment and other activities."))

    story.extend(section("3.03", "Investment Restrictions",
        "The General Partner shall cause the Partnership to invest only in "
        "Portfolio Investments consistent with the Fund&rsquo;s stated investment "
        "strategy, as described in the Private Placement Memorandum, which strategy "
        "shall be a long/short U.S. equity approach executed through the PNTHR "
        "Signal System applied to publicly traded U.S. equities and exchange-traded "
        "funds. The General Partner shall not cause the Partnership to invest in "
        "any asset class that does not reasonably relate to the Partnership&rsquo;s "
        "intended portfolio without first updating the Private Placement Memorandum "
        "and providing written notice to the Limited Partners."))

    story.extend(section("3.04", "Reserved", ""))

    story.extend(section("3.05", "Operating and Organizational Expenses",
        "The Partnership will pay all Operating Expenses, and will reimburse the "
        "General Partner or any of its Affiliates, as applicable, for its payment "
        "of Operating Expenses. Except as otherwise provided in this Agreement, the "
        "Partnership will pay all amounts payable to a Placement Agent by or on "
        "behalf of the Fund in connection with the offering and sale of Interests "
        "in the Fund and any related expenses (the &ldquo;<b>Placement "
        "Fees</b>&rdquo;) and Organizational Expenses, and will reimburse the "
        "General Partner or any of its Affiliates, as applicable, for its payment "
        "of Placement Fees and Organizational Expenses on the Fund&rsquo;s behalf."))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# ARTICLE IV — THE GENERAL PARTNER
# ═══════════════════════════════════════════════════════════════════════════
def build_article_iv():
    story = []
    story.extend(article("IV", "THE GENERAL PARTNER"))

    story.extend(section("4.01", "Management and Authority",
        "Subject to the provisions of this Agreement, the General Partner shall "
        "have the absolute, exclusive, and complete right, power, authority, "
        "obligation, and responsibility vested in or assumed by a general partner "
        "of a limited partnership under the Delaware Act and as otherwise provided "
        "by law, including those necessary to make all decisions regarding the "
        "business of the Partnership, the Portfolio Investments, and to take the "
        "actions specified in Section 3.02, and is hereby vested with absolute, "
        "exclusive, and complete right, power, and authority to operate, manage, "
        "and control the affairs of the Partnership and carry out the business of "
        "the Partnership. The General Partner shall have the authority to bind the "
        "Partnership to any obligation consistent with the provisions of this "
        "Agreement. The General Partner may contract with any Person for the "
        "transaction of the business of the Partnership, and the General Partner "
        "shall use reasonable care in the selection and retention of such Persons. "
        "The General Partner may, in its sole and absolute discretion, delegate the "
        "management, operation, and control of the Partnership to an investment "
        "manager to the fullest extent permitted by law; <i>provided</i>, that any "
        "such delegation shall not relieve the General Partner of its obligations "
        "to the Limited Partners under this Agreement. The General Partner may rely "
        "in good faith on and shall be protected in acting or refraining from "
        "acting upon any resolution, certificate, statement, instrument, opinion, "
        "report, notice, request, consent, order, bond, debenture, or other paper "
        "or document reasonably believed by it to be genuine. The General Partner "
        "may consult with legal counsel (including Partnership Counsel), "
        "accountants, appraisers, management consultants, investment bankers, and "
        "other consultants and advisers selected by it with reasonable care, and "
        "shall not have any liability to the Partnership or any other Partner for "
        "any act taken or omitted to be taken in good faith reliance upon the "
        "opinion or advice of such Persons. The General Partner will use reasonable "
        "efforts to minimize the incurrence of income that is treated as UBTI for "
        "Tax Exempt Limited Partners or ECI for Non-United States Limited Partners "
        "to the extent consistent with its goal of maximizing pre-tax income."))

    story.extend(section("4.02", "Transactions with Affiliates",
        "The General Partner shall not cause the Partnership or any of its "
        "subsidiaries to enter into any transaction with the General Partner or "
        "its Affiliates (including acquiring all or a portion of a Portfolio "
        "Investment from or selling a Portfolio Investment to the General Partner "
        "or its Affiliates) or any transaction pursuant to which the General "
        "Partner or its Affiliates will receive compensation, unless the terms of "
        "such transaction are fair and reasonable to the Partnership and are "
        "substantially no less favorable to the Partnership than those which would "
        "be available from, or would be agreed upon by, an unrelated third party "
        "in an arm&rsquo;s-length transaction. Notwithstanding the foregoing, the "
        "General Partner may: (i) cause the Partnership to enter into and perform "
        "the Investment Management Agreement, as provided in Section 9.01, and any "
        "documents contemplated thereby or related thereto and any amendments "
        "thereto, without any further act, vote, or approval of any Person; (ii) "
        "cause the Partnership to enter into and perform each Subscription "
        "Agreement and any documents contemplated thereby or related thereto and "
        "any amendments thereto, without any further act, vote, or approval of any "
        "Person; (iii) receive the amounts described in Section 3.05; and (iv) "
        "cause the Partnership to engage in transactions with the General Partner "
        "or its Affiliates for the purchase and/or sale of Partnership assets so "
        "long as such purchase is at Fair Market Value established by an "
        "independent third party and such investments satisfy the investment "
        "criteria of the Partnership."))

    story.extend(section("4.03", "Liability for Acts and Omissions",
        "To the fullest extent permitted by applicable law, no Covered Person "
        "shall be liable, in damages or otherwise, to the Partnership, the Limited "
        "Partners, or any of their Affiliates for any act or omission in connection "
        "with or in any way relating to the Partnership&rsquo;s business or affairs "
        "and matters related to Portfolio Investments (including any act or "
        "omission performed or omitted by such Covered Person in accordance with "
        "the provisions of this Agreement or in good faith reliance upon the "
        "opinion or advice of experts selected with reasonable care by the General "
        "Partner), except in the case of any act or omission with respect to which "
        "a court of competent jurisdiction (or other similar tribunal) has issued "
        "a final and non-appealable decision, judgment, or order that such act or "
        "omission resulted from such Covered Person&rsquo;s bad faith, gross "
        "negligence, willful misconduct, fraud, or a material breach of this "
        "Agreement. The provisions of this Agreement, to the extent that such "
        "provisions expressly restrict or eliminate the duties (including fiduciary "
        "duties) and liabilities of a Covered Person otherwise existing at law or "
        "in equity, are agreed by the Partners to replace such other duties and "
        "liabilities of such Covered Person.",
        "To the fullest extent permitted by applicable law, the Partnership shall "
        "and does hereby agree to indemnify and hold harmless each Covered Person "
        "from and against any damages, costs, losses, claims, liabilities, actions, "
        "and expenses (including reasonable legal and other professional fees and "
        "disbursements and all expenses reasonably incurred investigating, "
        "preparing, or defending against any claim whatsoever, judgment, fines, and "
        "settlements (collectively, &ldquo;<b>Indemnification Obligations</b>&rdquo;)) "
        "incurred by such Covered Person arising out of or relating to this "
        "Agreement or any entity in which the Partnership invests (including, "
        "without limitation, any act or omission as a director, officer, manager, "
        "or member of an Affiliate of the Partnership), except in the case of any "
        "act or omission with respect to which a court of competent jurisdiction "
        "(or other similar tribunal) has issued a final and non-appealable decision, "
        "judgment, or order that such act or omission resulted from such Covered "
        "Person&rsquo;s bad faith, gross negligence, willful misconduct, fraud, or "
        "a material breach of this Agreement. The indemnity set forth herein shall "
        "not apply to an internal dispute among the Covered Persons to which the "
        "Partnership is not a party.",
        "The satisfaction of any indemnification pursuant to this Section 4.03 "
        "shall be from and limited to Partnership assets. The liability of each "
        "Limited Partner to make Capital Contributions to fund its share of any "
        "indemnification obligations under this Section 4.03 shall be limited to "
        "such Limited Partner&rsquo;s Remaining Capital Commitment.",
        "Expenses reasonably incurred by a Covered Person in defense or settlement "
        "of any claim that may be subject to a right of indemnification hereunder "
        "shall be advanced by the Partnership prior to the final disposition thereof "
        "upon receipt of a written undertaking by or on behalf of such Covered "
        "Person to repay such amount to the extent that it is ultimately determined "
        "that such Covered Person is not entitled to be indemnified hereunder. The "
        "termination of a proceeding or claim against a Covered Person by "
        "settlement or by a plea of nolo contendere or its equivalent shall not, "
        "of itself, create a presumption that any Covered Person&rsquo;s conduct "
        "constituted bad faith, gross negligence, willful misconduct, fraud, or a "
        "material breach of this Agreement.",
        "The right of any Covered Person to the indemnification provided herein "
        "shall be cumulative of, and in addition to, any and all rights to which "
        "such Covered Person may otherwise be entitled by contract or as a matter "
        "of law or equity and shall extend to such Covered Person&rsquo;s heirs, "
        "successors, and assigns.",
        "The General Partner may, but shall not be required to, cause the "
        "Partnership to purchase and maintain insurance coverage reasonably "
        "satisfactory to the General Partner that provides the Partnership with "
        "coverage with respect to losses, claims, damages, liabilities, and "
        "expenses that would otherwise be Indemnification Obligations. The fees "
        "and expenses incurred in connection with obtaining and maintaining any "
        "such insurance policy or policies, including any commissions and premiums, "
        "shall be Operating Expenses."))

    story.extend(section("4.04", "Key Person Event; Suspension Period",
        "So long as PNTHR Funds, LLC or any of its Affiliates is the General "
        "Partner, the General Partner shall cause the Key Persons to devote a "
        "reasonable amount of their business time and attention to the investment "
        "and other activities of the Fund.",
        "So long as PNTHR Funds, LLC or any of its Affiliates is the General "
        "Partner, if both Key Persons cease to devote a reasonable amount of their "
        "business time to the affairs of the General Partner and the Partnership "
        "(including as a result of termination of employment, death, disability, "
        "or removal) for a continuous period of sixty (60) days (such event, a "
        "&ldquo;<b>Key Person Event</b>&rdquo;), the General Partner shall promptly "
        "provide notice thereof to the Limited Partners. Upon the occurrence of a "
        "Key Person Event, a ninety (90) day period (the &ldquo;<b>Suspension "
        "Period</b>&rdquo;) shall automatically commence. During the Suspension "
        "Period: (i) no new Portfolio Investments shall be made on behalf of the "
        "Partnership; and (ii) any Limited Partner may withdraw all or any portion "
        "of its Capital Account from the Partnership without regard to the "
        "Lock-Up Period (if then in effect) and without the Early-Withdrawal "
        "Penalty set forth in Section 8.06, subject to the Withdrawal Gate and the "
        "Audit Holdback provisions of Section 8.06. If no successor general partner "
        "has been approved by the Limited Partners pursuant to Section 4.12 within "
        "the Suspension Period, the Partnership shall dissolve in accordance with "
        "Article XII."))

    story.extend(section("4.05", "Other Activities",
        "The General Partner and its Affiliates (subject to Section 4.04) and the "
        "Fund Investors and their respective Affiliates may engage in or possess "
        "an interest in other business ventures of every nature and description "
        "for their own account, independently or with others, whether or not such "
        "other enterprises shall be in competition with any activities of the "
        "Partnership. None of the Partnership, the Fund Investors, the General "
        "Partner, or the Investment Manager shall have any right by virtue of this "
        "Agreement in and to such independent ventures or to the income or profits "
        "derived therefrom."))

    story.extend(section("4.06", "Miscellaneous Revenues",
        "Except for any fees authorized, acknowledged, or approved in accordance "
        "with this Agreement, the General Partner shall apply any fees (including "
        "director fees (including the value of any options, warrants, and other "
        "non-cash compensation), break-up fees, and fees for advisory, consulting, "
        "monitoring, or similar services) paid by third parties to the General "
        "Partner or its Affiliates arising from the Partnership&rsquo;s Portfolio "
        "Investments or potential Portfolio Investments to offset, pay, or reserve "
        "for the payment of Investment Expenses."))

    story.extend(section("4.07", "Transfer or Withdrawal by the General Partner",
        "The General Partner shall not have the right to Transfer its Interest as "
        "the general partner of the Partnership and shall not have the right to "
        "withdraw from the Partnership; <i>provided</i>, that, without the consent "
        "of any Limited Partner, the General Partner may, at its own expense, (a) "
        "be reconstituted as or converted into a corporation or other form of "
        "entity (any such reconstituted or converted entity being deemed to be the "
        "General Partner for all purposes hereof) by merger, consolidation, "
        "conversion, or otherwise, or (b) Transfer all of its Interest as the "
        "general partner of the Partnership to one of its Affiliates so long as, "
        "in either case, such reconstitution or Transfer does not have material "
        "adverse tax or legal consequences for the Fund Investors. In the event "
        "of a Transfer of all of its Interest as a general partner of the "
        "Partnership in accordance with this Section 4.07, its transferee shall "
        "be substituted in its place as general partner of the Partnership and "
        "immediately thereafter the General Partner shall withdraw as the general "
        "partner of the Partnership and the business of the Partnership shall be "
        "continued without dissolution."))

    story.extend(section("4.08", "Bankruptcy or Dissolution of the General Partner",
        "Upon the Bankruptcy or dissolution of the General Partner, (i) the "
        "General Partner or its legal representative shall give notice to the "
        "Fund Investors of such event and shall automatically, with or without "
        "delivery of such notice, become a Special Limited Partner with no power, "
        "authority, or responsibility to bind the Partnership or to make decisions "
        "concerning, or manage or control, the affairs of the Partnership, and the "
        "Partnership&rsquo;s certificate of limited partnership shall be amended "
        "to reflect such fact; and (ii) such Person as may be selected and "
        "approved by consent of a Majority in Interest of the Limited Partners "
        "within ninety (90) days of the date of the Bankruptcy or dissolution of "
        "the General Partner shall be admitted to the Partnership as a successor "
        "to the General Partner (effective as of the date of the Bankruptcy or "
        "dissolution) and such successor shall continue the business of the "
        "Partnership without dissolution. If a successor to the General Partner "
        "is not approved to be admitted to the Partnership by consent of a "
        "Majority in Interest of the Limited Partners within such ninety (90) day "
        "period, the Partnership shall dissolve in accordance with Article XII."))

    story.extend(section("4.09", "Removal of the General Partner",
        "(a) <i>Grounds and Threshold.</i> The Limited Partners may remove the "
        "General Partner as the general partner of the Partnership only for Cause, "
        "and only upon the affirmative consent of Limited Partners holding, in "
        "the aggregate, a Super Majority in Interest (that is, not less than 75% "
        "of the aggregate Capital Commitments of all Limited Partners). The "
        "Limited Partners shall provide the General Partner with written notice "
        "of any proposed removal for Cause, together with a reasonably detailed "
        "description of the Cause event alleged. For any Cause event that is "
        "reasonably capable of being cured, the General Partner shall have thirty "
        "(30) days following the receipt of such written notice in which to cure "
        "such Cause event. If the General Partner cures the Cause event within "
        "the cure period, no removal shall be effective.",
        "(b) <i>Poor Performance Excluded.</i> For the avoidance of doubt, poor "
        "investment performance, a decline in Net Asset Value, disagreement with "
        "investment strategy, or any other business or market-related outcome "
        "shall not constitute Cause.",
        "(c) <i>Principal Successor Approval.</i> Any successor general partner "
        "proposed by the Limited Partners in connection with a removal of the "
        "General Partner pursuant to this Section 4.09 must be approved in writing "
        "by each of Scott R. McBrien and Cindy Eagar (or the survivor of either "
        "of them) prior to such successor&rsquo;s admission as general partner "
        "becoming effective. This approval right is personal to Scott R. McBrien "
        "and Cindy Eagar and shall not be transferable.",
        "(d) <i>Dissolution if No Approved Successor.</i> If a removal of the "
        "General Partner becomes effective pursuant to this Section 4.09 and no "
        "successor general partner has been approved in writing by Scott R. "
        "McBrien and Cindy Eagar within ninety (90) days thereafter, the "
        "Partnership shall dissolve in accordance with Article XII.",
        "(e) <i>Effect of Removal.</i> Promptly upon the effectiveness of any "
        "removal of the General Partner pursuant to this Section 4.09, the "
        "removed General Partner&rsquo;s Interest shall be converted to that of "
        "a Special Limited Partner. Following such conversion, the Special "
        "Limited Partner shall not be entitled to vote with the Limited Partners "
        "upon any matter that requires the consent of the Limited Partners under "
        "this Agreement or the Delaware Act."))

    story.extend(section("4.10", "Obligations of a Former General Partner",
        "In the event that the General Partner withdraws from the Partnership or "
        "Transfers its Interest in accordance with Section 4.07 or has its "
        "Interest redeemed in accordance with Section 4.08 or 4.09, it shall have "
        "no further obligation or liability as a general partner to the "
        "Partnership pursuant to this Agreement in connection with any obligations "
        "or liabilities arising from and after such withdrawal, Transfer, "
        "redemption, or conversion, and all such future obligations and "
        "liabilities shall automatically cease and terminate and be of no further "
        "force or effect; <i>provided</i>, that nothing contained herein shall be "
        "deemed to relieve the General Partner of any obligations or liabilities "
        "(a) arising prior to such withdrawal, Transfer, redemption, or conversion "
        "or (b) resulting from a dissolution of the Partnership caused by an act "
        "of the General Partner where liability is imposed upon the General "
        "Partner by law or by the provisions of this Agreement; <i>provided, "
        "further</i>, that the General Partner shall continue to be indemnified "
        "in accordance with Section 4.03 with respect to the activities of the "
        "Partnership prior to such Transfer."))

    story.extend(section("4.11", "Successor to the General Partner",
        "(a) Following the proposed withdrawal or removal of the General Partner, "
        "any Fund Investor may propose for admission a successor General Partner. "
        "If a successor General Partner proposed pursuant to this Section 4.11 "
        "satisfies the terms and conditions set forth in Section 4.11(b), then "
        "such proposed successor General Partner shall become the successor "
        "General Partner as of the date of withdrawal or removal of the General "
        "Partner and shall thereupon continue the Partnership&rsquo;s business.",
        "(b) A Person shall be admitted as a successor General Partner only if "
        "the following terms and conditions are satisfied: (i) except as permitted "
        "by Section 4.07, the admission of such Person shall have been approved "
        "by consent of a Super Majority in Interest of the Limited Partners and "
        "by the written approval of each of Scott R. McBrien and Cindy Eagar (or "
        "the survivor of either of them) as provided in Section 4.09(c); (ii) the "
        "Person shall have accepted and agreed to be bound by all the terms and "
        "provisions of this Agreement by executing a counterpart hereof and such "
        "other documents or instruments as may be required or appropriate in "
        "order to effect the admission of such Person as a general partner of the "
        "Partnership; and (iii) the Partnership&rsquo;s Certificate of Limited "
        "Partnership shall be amended to reflect the admission of such Person as "
        "a general partner.",
        "(c) If, within ninety (90) calendar days of the date of the General "
        "Partner&rsquo;s withdrawal or removal, a successor General Partner has "
        "not been approved by consent of a Super Majority in Interest of the "
        "Limited Partners and by the written approval of each of Scott R. McBrien "
        "and Cindy Eagar, then the Partnership shall thereupon terminate and "
        "dissolve in accordance with Article XII."))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# ARTICLE V — LIMITED PARTNERS
# ═══════════════════════════════════════════════════════════════════════════
def build_article_v():
    story = []
    story.extend(article("V", "LIMITED PARTNERS"))

    story.extend(section("5.01", "No Participation in Management of the Partnership",
        "No Limited Partner shall participate in the management or control of the "
        "business and affairs of the Partnership or have any authority or right to "
        "act on behalf of the Partnership in connection with any matter or the "
        "transaction of any business. No Limited Partner shall have any rights and "
        "powers with respect to the Partnership, except as provided in the "
        "Delaware Act or by this Agreement."))

    story.extend(section("5.02", "Liability of the Limited Partners",
        "(a) <i>Limitation on Liability.</i> No Limited Partner shall have any "
        "obligation to contribute any amounts to the Partnership except to the "
        "extent of its Remaining Capital Commitment and as otherwise provided in "
        "this Agreement and the Delaware Act, and the liability of each Limited "
        "Partner shall be limited to such amounts. No Limited Partner shall be "
        "obligated to repay to the Partnership, any Partner, or any creditor of "
        "the Partnership all or any portion of the amounts distributed to such "
        "Limited Partner except with respect to distributions that increase its "
        "Remaining Capital Commitment as provided in the definition of such term.",
        "(b) <i>Limited Partner Giveback.</i> Except as required by the Delaware "
        "Act or other applicable law or as otherwise expressly set forth herein, "
        "no Limited Partner shall be required to repay to the Partnership, any "
        "Partner, or any creditor of the Partnership all or any part of the "
        "distributions made to such Limited Partner hereunder; <i>provided</i>, "
        "that the General Partner may require a Limited Partner (including any "
        "former Limited Partner) to return distributions made to such Limited "
        "Partner or former Limited Partner for the purpose of meeting such "
        "Limited Partner&rsquo;s pro rata share of the Partnership&rsquo;s "
        "indemnity obligations under Section 4.03 and Section 8.03(c), or any "
        "liabilities or obligations of the Partnership relating to or arising "
        "out of the investment or other activities of the Partnership, in an "
        "amount up to, but in no event in excess of, the aggregate amount of "
        "distributions actually received by such Limited Partner from the "
        "Partnership; <i>provided, further</i>, that a Partner shall be required "
        "to return any distribution that was made to such Partner in error within "
        "thirty (30) days of the completion of the audit for the year in which "
        "such distribution was made."))

    story.extend(section("5.03", "Power of Attorney",
        "(a) Each Limited Partner hereby irrevocably constitutes and appoints the "
        "General Partner, with full power of substitution, as its true and lawful "
        "attorney-in-fact (which appointment shall be deemed to be coupled with "
        "an interest) and agent, to execute, acknowledge, verify, swear to, "
        "deliver, record, and file, in its or its assignee&rsquo;s name, place, "
        "and stead, all in accordance with the terms of this Agreement:"))
    story.append(subpara("(i)  all certificates and other instruments, including any amendments to this Agreement or the Certificate, and amendments thereto, which the General Partner deems necessary or desirable to form, qualify, or continue the Partnership as a limited partnership (or a partnership in which the Limited Partners have limited liability) in all jurisdictions in which the Partnership conducts or plans to conduct its affairs;"))
    story.append(subpara("(ii)  any agreement or instrument which the General Partner deems necessary or desirable to effect (a) the complete or partial Transfer, addition, substitution, withdrawal, or removal (voluntary or involuntary) of any Limited Partner or the General Partner pursuant to this Agreement; (b) the dissolution and liquidation of the Partnership in accordance with the provisions of Article XII; or (c) any amendment or modification to this Agreement adopted in accordance with Section 15.01;"))
    story.append(subpara("(iii)  all conveyances and other instruments which the General Partner deems necessary or desirable to reflect the dissolution and termination of the Partnership pursuant to Article XII, including the requirements of the Delaware Act;"))
    story.append(subpara("(iv)  certificates of assumed name or fictitious name certificates and such other certificates and instruments as may be necessary under the fictitious or assumed name statutes from time to time in effect in all jurisdictions in which the Partnership conducts or plans to conduct its affairs;"))
    story.append(subpara("(v)  all certificates or other instruments necessary or desirable to accomplish the business, purposes, and objectives of the Partnership or required by any applicable law; and"))
    story.append(subpara("(vi)  all other documents or instruments that may reasonably be considered necessary by the General Partner to carry out the foregoing."))
    story.append(P(
        "(b) Such attorney-in-fact and agent shall not, however, have the right, "
        "power, or authority to amend or modify this Agreement when acting in "
        "such capacities, except to the extent expressly authorized herein. Each "
        "Limited Partner hereby agrees not to revoke this power of attorney. This "
        "power of attorney shall terminate upon (i) with respect to such Limited "
        "Partner, a Transfer of the Limited Partner&rsquo;s entire Interest in "
        "accordance with the terms of this Agreement, and (ii) the removal, "
        "Bankruptcy, dissolution, or withdrawal of the General Partner, except "
        "that such power of attorney shall remain in effect with respect to any "
        "successor General Partner. The power of attorney granted herein shall be "
        "irrevocable, shall survive and not be affected by the death, incapacity, "
        "designations, dissolution, Bankruptcy, or legal disability of the Limited "
        "Partner, shall extend to its successors and assigns, and may be "
        "exercisable by the General Partner by executing any instrument on behalf "
        "of the Limited Partner as its attorney-in-fact with or without listing "
        "all of the Limited Partners executing an instrument. To the fullest "
        "extent permitted by applicable law, this power of attorney may be "
        "exercised by such attorney-in-fact and agent for all Limited Partners "
        "(or any of them) by a single signature of the General Partner acting as "
        "attorney-in-fact with or without listing all of the Limited Partners "
        "executing an instrument. Any Person dealing with the Partnership may "
        "conclusively presume and rely upon the fact that any instrument referred "
        "to above, executed by the General Partner as attorney-in-fact, is "
        "authorized, regular, and binding, without further inquiry. If required, "
        "each Limited Partner shall execute and deliver to the General Partner, "
        "within five (5) Business Days after receipt of a request from the "
        "General Partner, such further designations, powers of attorney, or other "
        "instruments as the General Partner shall determine to be necessary for "
        "the purposes hereof consistent with the provisions of this Agreement, "
        "including as required by any applicable state statute or other similar "
        "legal requirement. Each Limited Partner hereby waives any and all "
        "defenses which may be available to contest, negate, or disaffirm the "
        "actions of the General Partner taken in good faith under such power of "
        "attorney.",
        BODY))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# ARTICLE VI — INTERESTS; CAPITAL CONTRIBUTIONS; CAPITAL ACCOUNTS
# ═══════════════════════════════════════════════════════════════════════════
def build_article_vi():
    story = []
    story.extend(article("VI", "INTERESTS; CAPITAL CONTRIBUTIONS; CAPITAL ACCOUNTS"))

    story.extend(section("6.01", "General Partner",
        "(a) The name and address of the General Partner is PNTHR Funds, LLC, a "
        "Delaware limited liability company, having an address at 15150 W Park "
        "Place, Suite 215, Goodyear, AZ 85395.",
        "(b) The General Partner and/or its Affiliates, at its sole and absolute "
        "discretion, may make a Capital Commitment in an amount of its choosing "
        "(the &ldquo;<b>General Partner Commitment</b>&rdquo;). Notwithstanding "
        "anything in this Agreement to the contrary, the General Partner "
        "Commitment shall be treated in the same way as the Capital Commitment of "
        "any other Limited Partner that is not an Affiliate of the General "
        "Partner, except that the General Partner and/or its Affiliates will not "
        "bear Investment Management Fees or be subject to Performance Allocation "
        "and their Interests will be non-voting regarding matters presented to "
        "the Limited Partners. The General Partner&rsquo;s initial Capital "
        "Commitment to the Partnership is $100,000. The timing and amount of this "
        "commitment may vary at the sole discretion of the General Partner.",
        "(c) The General Partner and/or its Affiliates shall also be a Limited "
        "Partner to the extent that it subscribes for or becomes a transferee of "
        "all or any part of the Interest of a Limited Partner, and to such extent "
        "shall be treated as a Limited Partner in all respects, except as "
        "otherwise provided in this Agreement."))

    story.extend(section("6.02", "Limited Partners",
        "Except as provided in Article XI, a Person shall be admitted as a "
        "Limited Partner only after such Person&rsquo;s Subscription Agreement is "
        "accepted by the General Partner and when the General Partner holds a "
        "Closing with respect to such Person. The General Partner shall maintain "
        "a record of the name, address, and Capital Commitment of each Limited "
        "Partner."))

    story.extend(section("6.03", "Capital Contributions",
        "(a) Each Limited Partner shall make its initial Capital Contribution to "
        "the Partnership in the amount of its Capital Commitment upon its "
        "admission to the Partnership. All Capital Contributions shall be made in "
        "immediately available funds in U.S. dollars, unless otherwise approved "
        "by the General Partner at its sole discretion.",
        "(b) <i>GP Discretion on Capital Contributions.</i> The General Partner "
        "may in its sole discretion exclude a particular Limited Partner from "
        "participating in all or any part of a Portfolio Investment if the "
        "General Partner determines that (i) participation by such Limited "
        "Partner in all or any part of such Portfolio Investment would have a "
        "reasonable likelihood of a violation of applicable law or (ii) such "
        "participation would result in a significant delay, extraordinary expense, "
        "or material adverse effect with respect to such Portfolio Investment or "
        "the Fund, would materially increase the risk that such Portfolio "
        "Investment will not be consummated, or would impose any material filing, "
        "tax, regulatory, or other burden to which the Fund, the General Partner, "
        "the Portfolio Company, or any Partner or any of their respective "
        "Affiliates would not otherwise be subject."))

    story.extend(section("6.04", "Maintenance of Capital Accounts",
        "The Partnership shall establish and maintain for each Partner a separate "
        "capital account (a &ldquo;<b>Capital Account</b>&rdquo;) on its books "
        "and records in accordance with this Section 6.04. Each Capital Account "
        "shall be established and maintained in accordance with the following "
        "provisions:",
        "(a) Each Partner&rsquo;s Capital Account shall be increased by: (i) the "
        "cash amount of all Capital Contributions made by such Partner to the "
        "Partnership; (ii) the amount of any Net Income or other item of income "
        "or gain allocated to such Partner pursuant to Article VII; and (iii) any "
        "liabilities of the Partnership that are assumed by such Partner or "
        "secured by any property distributed to such Partner.",
        "(b) Each Partner&rsquo;s Capital Account shall be decreased by: (i) the "
        "cash amount or Book Value of any property distributed to such Partner; "
        "(ii) the amount of any Net Loss or other item of loss or deduction "
        "allocated to such Partner pursuant to Article VII; and (iii) the amount "
        "of any liabilities of such Partner assumed by the Partnership or which "
        "are secured by any property contributed by such Partner to the "
        "Partnership."))

    story.extend(section("6.05", "Interest",
        "Interest, if any, earned on Partnership funds shall inure to the benefit "
        "of the Partnership. The Partners shall not receive interest on their "
        "Capital Contributions or Capital Accounts. The General Partner shall "
        "have no obligation to keep Partnership funds in an interest-bearing "
        "account."))

    story.extend(section("6.06", "Withdrawal of Capital Contributions",
        "Except as otherwise provided in this Agreement (including Article VIII) "
        "or by law, (a) no Partner shall have the right to withdraw or reduce its "
        "Capital Contributions or its Capital Commitment, or to demand and "
        "receive property other than property distributed by the Partnership in "
        "accordance with the terms hereof in return for its Capital Contributions, "
        "and (b) any return of Capital Contributions to the Limited Partners "
        "shall be solely from Partnership assets, and the General Partner shall "
        "not be personally liable for any such return."))

    story.extend(section("6.07", "Succession Upon Transfer",
        "In the event that an Interest is transferred in accordance with the "
        "terms of this Agreement, the transferee shall succeed to the Capital "
        "Account of the transferor to the extent that it relates to the "
        "transferred Interest and shall receive allocations and distributions "
        "pursuant to Article VII and Article VIII in respect of such Interest."))

    story.extend(section("6.08", "Restoration of Negative Capital Accounts",
        "Subject to Sections 4.03 and 5.02, neither the General Partner nor any "
        "other Partner shall be obligated to restore any deficit balance in a "
        "Partner&rsquo;s Capital Account. A deficit in a Partner&rsquo;s Capital "
        "Account shall not constitute a Partnership asset."))

    story.extend(section("6.09", "Admission of Limited Partners After Initial Closing",
        "(a) The Limited Partners agree that the General Partner shall have the "
        "right to admit additional Limited Partners to the Partnership on an "
        "ongoing basis. The Limited Partners hereby consent to such admission of "
        "any additional Limited Partners and agree to take all actions reasonably "
        "requested by the General Partner to give effect to the foregoing. Each "
        "additional Limited Partner admitted shall contribute an amount to the "
        "Partnership as determined by the General Partner based on the Net Asset "
        "Value per share or unit as of the date of their admission, adjusted for "
        "any applicable fees or expenses.",
        "(b) In connection with withdrawals, the General Partner shall ensure "
        "that remaining Limited Partners&rsquo; interests are adjusted "
        "proportionally based on Net Asset Value, so as not to impact the "
        "economic standing of continuing partners. The admission of new Limited "
        "Partners and processing of withdrawals will be conducted in a manner "
        "that seeks to maintain fair treatment and valuation for all partners, "
        "based on their respective interests in the Partnership at any given "
        "time."))

    story.extend(section("6.10", "Qualified Client and Accredited Investor Representations",
        "Each Limited Partner represents, warrants, and covenants to the "
        "Partnership as of the date of such Limited Partner&rsquo;s admission and "
        "at all times thereafter during which such Limited Partner holds an "
        "Interest, that such Limited Partner: (a) qualifies as an &ldquo;accredited "
        "investor&rdquo; as defined in Rule 501(a) of Regulation D under the "
        "Securities Act; and (b) qualifies as a Qualified Client within the "
        "meaning of Rule 205-3 under the Advisers Act (that is, the Limited "
        "Partner is a natural person or company that (i) has a net worth, "
        "excluding the value of the primary residence, of at least $2,200,000 "
        "immediately prior to admission; or (ii) has at least $1,100,000 under "
        "the management of the Investment Manager). Each Limited Partner shall "
        "promptly notify the General Partner if at any time any of the foregoing "
        "representations ceases to be true, and the General Partner may require "
        "the withdrawal of any Limited Partner that ceases to satisfy these "
        "qualifications."))

    story.extend(section("6.11", "Bank Holding Company Limited Partners",
        "Notwithstanding any other provision of this Agreement, in the event "
        "that a Limited Partner is a BHC Limited Partner, such BHC Limited "
        "Partner&rsquo;s Interest in excess of 4.99% of the aggregate Capital "
        "Commitments of the Partnership shall automatically be non-voting with "
        "respect to all matters presented to the Limited Partners under this "
        "Agreement. The General Partner may, in its sole discretion, impose "
        "additional restrictions on BHC Limited Partners as the General Partner "
        "determines are necessary or advisable to comply with applicable banking "
        "laws or regulations (including the Bank Holding Company Act of 1956, as "
        "amended, and the Volcker Rule)."))

    story.extend(section("6.12", "Bad Actor Representation",
        "Each Limited Partner represents and warrants to the Partnership that "
        "neither such Limited Partner nor any of its directors, officers, or "
        "general partners (as applicable) is subject to any of the disqualifying "
        "events set forth in Rule 506(d)(1)(i)-(viii) of Regulation D under the "
        "Securities Act (a &ldquo;Bad Actor Event&rdquo;). Each Limited Partner "
        "shall promptly notify the General Partner in writing if such Limited "
        "Partner becomes subject to a Bad Actor Event. The General Partner may, "
        "in its sole discretion, require the withdrawal of any Limited Partner "
        "that becomes subject to a Bad Actor Event if the General Partner "
        "determines that such withdrawal is necessary or advisable to preserve "
        "the Fund&rsquo;s reliance on Rule 506(c) of Regulation D."))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# ARTICLE VII — ALLOCATIONS
# ═══════════════════════════════════════════════════════════════════════════
def build_article_vii():
    story = []
    story.extend(article("VII", "ALLOCATIONS"))

    story.extend(section("7.01", "Allocations of Net Income and Net Loss",
        "(a) <i>Net Income and Net Loss.</i> Except as otherwise provided in this "
        "Agreement, for each Fiscal Year (or portion thereof), Net Income and Net "
        "Loss (and, to the extent necessary, individual items of income, gain, "
        "loss, or deduction) of the Partnership shall be allocated among the "
        "Partners in a manner such that, after giving effect to the special "
        "allocations set forth in Section 7.02, the Capital Account balance of "
        "each Partner, immediately after making such allocations, is, as nearly as "
        "possible, equal to the Distributions that would be made to such Partner "
        "pursuant to Sections 8.01 and 12.02(c) if the Partnership were dissolved, "
        "its affairs wound up, and its assets sold for cash equal to their Book "
        "Value, all Partnership liabilities were satisfied, and the net assets of "
        "the Partnership were distributed in accordance with Sections 8.01 and "
        "12.02(c) to the Partners immediately after making such allocations. "
        "Notwithstanding the foregoing, the General Partner may make such "
        "allocations as it deems reasonably necessary to give economic effect to "
        "the provisions of this Agreement taking into account such facts and "
        "circumstances as the General Partner deems reasonably necessary for this "
        "purpose.",
        "(b) <i>Withholding and Income Taxes.</i> Any withholding or income taxes "
        "imposed by any non-United States jurisdiction (&ldquo;<b>Foreign "
        "Taxes</b>&rdquo;) (and related tax credits) on items of income, gain, "
        "loss, or deduction of the Partnership or incurred directly or indirectly "
        "by the Partnership with respect to any investment shall be allocated to "
        "each Partner in accordance with each such Partner&rsquo;s respective "
        "share of the Capital Contributions attributable to the investment giving "
        "rise to income or gains subject to Foreign Taxes. Notwithstanding the "
        "foregoing, any increase or decrease in such Foreign Taxes (and related "
        "tax credits) resulting from the identity, nationality, residence, or "
        "status of a Partner, or from the failure of a Partner or its direct or "
        "indirect members to provide information as requested pursuant to Section "
        "8.03(a), will be specially allocated to such Partner."))

    story.extend(section("7.02", "Regulatory Allocations",
        "Notwithstanding the provisions of Section 7.01:",
        "(a) <i>Minimum Gain Chargeback.</i> If there is a net decrease in "
        "Partnership Minimum Gain during any Fiscal Year, each Partner shall be "
        "specially allocated Net Income for such Fiscal Year (and, if necessary, "
        "subsequent Fiscal Years) in an amount equal to such Partner&rsquo;s "
        "share of the net decrease in Partnership Minimum Gain, determined in "
        "accordance with Treasury Regulation Section 1.704-2(g). This Section "
        "7.02(a) is intended to comply with the minimum gain chargeback "
        "requirement in Treasury Regulation Section 1.704-2(f) and shall be "
        "interpreted consistently therewith.",
        "(b) <i>Partner Minimum Gain Chargeback.</i> If there is a net decrease "
        "in Partner Nonrecourse Debt Minimum Gain attributable to a Partner "
        "Nonrecourse Debt during any Fiscal Year, each Partner with a share of "
        "such Partner Nonrecourse Debt Minimum Gain shall be specially allocated "
        "Net Income for such Fiscal Year (and, if necessary, subsequent Fiscal "
        "Years) in an amount equal to such Partner&rsquo;s share of the net "
        "decrease in Partner Nonrecourse Debt Minimum Gain, determined in "
        "accordance with Treasury Regulation Section 1.704-2(i)(5).",
        "(c) <i>Nonrecourse Deductions.</i> Nonrecourse Deductions for any Fiscal "
        "Year shall be allocated to the Partners in accordance with their "
        "respective Percentage Interests.",
        "(d) <i>Partner Nonrecourse Deductions.</i> Partner Nonrecourse "
        "Deductions for any Fiscal Year shall be allocated to the Partner or "
        "Partners that bear the economic risk of loss with respect to the Partner "
        "Nonrecourse Debt to which such Partner Nonrecourse Deductions are "
        "attributable in the manner required by Treasury Regulation Section "
        "1.704-2(i).",
        "(e) <i>Qualified Income Offset.</i> In the event any Partner unexpectedly "
        "receives any adjustments, allocations, or distributions described in "
        "Treasury Regulation Section 1.704-1(b)(2)(ii)(d)(4), (5), or (6), Net "
        "Income shall be specially allocated to such Partner in an amount and "
        "manner sufficient to eliminate the deficit balance in its Capital "
        "Account created by such adjustments, allocations, or distributions as "
        "quickly as possible. This Section 7.02(e) is intended to comply with the "
        "qualified income offset requirement in Treasury Regulation Section "
        "1.704-1(b)(2)(ii)(d) and shall be interpreted consistently therewith."))

    story.extend(section("7.03", "Tax Allocations",
        "(a) Subject to Sections 7.03(b), 7.03(c), and 7.03(d), all income, "
        "gains, losses, and deductions of the Partnership shall be allocated, for "
        "federal, state, and local income tax purposes, among the Partners in "
        "accordance with the allocation of such income, gains, losses, and "
        "deductions among the Partners for computing their Capital Accounts, "
        "except that if any such allocation for tax purposes is not permitted by "
        "the Code or other applicable law, the Partnership&rsquo;s subsequent "
        "income, gains, losses, and deductions shall be allocated among the "
        "Partners for tax purposes, to the extent permitted by the Code and other "
        "applicable law, so as to reflect as nearly as possible the allocation "
        "set forth herein in computing their Capital Accounts.",
        "(b) Items of Partnership taxable income, gain, loss, and deduction with "
        "respect to any property contributed to the capital of the Partnership "
        "shall be allocated in accordance with Section 704(c) of the Code and any "
        "reasonable method selected by the General Partner.",
        "(c) If the Book Value of any Partnership asset is adjusted pursuant to "
        "Treasury Regulation Section 1.704-1(b)(2)(iv)(f), subsequent allocations "
        "of items of taxable income, gain, loss, and deduction with respect to "
        "such asset shall take account of any variation between the adjusted "
        "basis of such asset for federal income tax purposes and its Book Value "
        "in the same manner as under Section 704(c) of the Code.",
        "(d) Allocations of tax credit, tax credit recapture, and any items "
        "related thereto shall be allocated to the Partners according to their "
        "interests in such items as determined by the General Partner taking into "
        "account the principles of Treasury Regulations Section 1.704-1(b)(4)(ii).",
        "(e) Allocations pursuant to this Section 7.03 are solely for purposes of "
        "federal, state, and local taxes and shall not affect, or in any way be "
        "taken into account in computing, any Partner&rsquo;s Capital Account or "
        "share of Net Income, Net Losses, Distributions, or other items pursuant "
        "to any provisions of this Agreement."))

    story.extend(section("7.04", "Allocations to Transferred Interests",
        "In the event an Interest is assigned during a Fiscal Year in compliance "
        "with the provisions of Article XI, Net Income, Net Losses, and other "
        "items of income, gain, loss, and deduction of the Partnership "
        "attributable to such Interest for such Fiscal Year shall be determined "
        "using the interim closing of the books method."))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# ARTICLE VIII — DISTRIBUTIONS, WITHDRAWALS, AND PERFORMANCE ALLOCATION
# ═══════════════════════════════════════════════════════════════════════════
def build_article_viii():
    story = []
    story.extend(article("VIII", "DISTRIBUTIONS, WITHDRAWALS, AND PERFORMANCE ALLOCATION"))

    story.extend(section("8.01", "Distributions and Performance Allocation",
        "(a) <i>General.</i> It is the intent of the General Partner to reinvest "
        "net cash proceeds from the operations of the Partnership into additional "
        "Portfolio Investments in accordance with the Fund&rsquo;s investment "
        "strategy. The General Partner may, at its sole discretion, cause the "
        "Partnership to make cash distributions of Distributable Cash to the "
        "Limited Partners from time to time, generally within sixty (60) days "
        "after the end of each fiscal quarter. Limited Partners should not expect "
        "distributions on a regular or guaranteed schedule.",
        "(b) <i>Quarterly Hurdle.</i> For each calendar quarter, the &ldquo;<b>Hurdle "
        "Rate</b>&rdquo; shall be the annualized yield on the U.S. 2-Year Treasury "
        "Note (&ldquo;<b>US2Y</b>&rdquo;), determined as of the close of the first "
        "trading day of the Fiscal Year, divided by four (expressed as a quarterly "
        "rate). The Hurdle Rate is applied quarterly and is <i>not</i> cumulative "
        "across calendar quarters or Fiscal Years. Any shortfall of the "
        "Partnership&rsquo;s performance below the Hurdle Rate in a given calendar "
        "quarter shall not carry forward to subsequent calendar quarters.",
        "(c) <i>Performance Allocation.</i> Subject to the quarterly Hurdle, the "
        "High Water Mark, and the Loss Recovery Account described below, the "
        "Performance Allocation shall be determined at the end of each calendar "
        "quarter (March 31, June 30, September 30, and December 31 of each Fiscal "
        "Year) by reallocating from each Limited Partner&rsquo;s Capital Account "
        "to the General Partner&rsquo;s Capital Account an amount equal to the "
        "applicable Performance Allocation rate multiplied by the Net Profits "
        "allocated to such Limited Partner&rsquo;s Capital Account for such "
        "calendar quarter in excess of the quarterly Hurdle and any unrecovered "
        "balance in the Loss Recovery Account. The Performance Allocation rate "
        "applicable to each Limited Partner depends on the class of Limited "
        "Partner Interests held as follows:"))
    story.append(subpara("(i)  Wagyu Interests:  20% (reduced to 15% after three (3) consecutive Fiscal Years as described in the definition of Wagyu Interests);"))
    story.append(subpara("(ii)  Porterhouse Interests:  25% (reduced to 20% after three (3) consecutive Fiscal Years as described in the definition of Porterhouse Interests); and"))
    story.append(subpara("(iii)  Filet Interests:  30% (reduced to 25% after three (3) consecutive Fiscal Years as described in the definition of Filet Interests)."))
    story.append(P(
        "(d) <i>High Water Mark.</i> No Performance Allocation shall be accrued "
        "in respect of any Limited Partner&rsquo;s Capital Account until the "
        "Capital Account balance (adjusted for Capital Contributions and "
        "withdrawals) exceeds the applicable High Water Mark.",
        BODY))
    story.append(P(
        "(e) <i>Loss Recovery Account.</i> The Partnership shall maintain for "
        "each Limited Partner a memorandum account (the &ldquo;<b>Loss Recovery "
        "Account</b>&rdquo;) that is debited by cumulative Net Losses allocated "
        "to such Limited Partner&rsquo;s Capital Account and credited by Net "
        "Profits subsequently allocated to such Capital Account. No Performance "
        "Allocation shall accrue in respect of any Limited Partner&rsquo;s "
        "Capital Account for any calendar quarter unless and until the balance of "
        "such Limited Partner&rsquo;s Loss Recovery Account has been restored to zero. "
        "The Loss Recovery Account shall be maintained solely for the purpose of "
        "computing the Performance Allocation and shall not affect the Limited "
        "Partner&rsquo;s Capital Account balance or distribution rights.",
        BODY))
    story.append(P(
        "(f) <i>Mechanics.</i> Distributions pursuant to this Section 8.01 shall "
        "be made at such times and in such amounts as determined by the General "
        "Partner, in its sole discretion, consistent with the principles set "
        "forth in this Agreement.",
        BODY))

    story.extend(section("8.02", "Tax Distributions",
        "Notwithstanding any provision in Section 8.01 to the contrary, the "
        "General Partner may cause the Partnership to advance to the General "
        "Partner from time to time amounts sufficient to permit the payment of "
        "cumulative federal, state, and local income tax obligations (including "
        "estimated taxes) of the General Partner and its direct and indirect "
        "members in respect of allocations of income and gain from the "
        "Partnership to the General Partner in respect of Performance Allocation "
        "Distributions, calculated using the Assumed Tax Rate. Future "
        "distributions otherwise to be made to the General Partner pursuant to "
        "Section 8.01 shall be reduced by the amount of any prior advances made "
        "to the General Partner pursuant to this Section 8.02. If such "
        "distributions are not sufficient to offset advances made pursuant to "
        "this Section 8.02, the proceeds of liquidation otherwise payable to the "
        "General Partner shall be so reduced."))

    story.extend(section("8.03", "Withholding and Income Taxes",
        "(a) <i>Tax Withholding Information.</i> Each Partner agrees to: (i) "
        "provide any information, certification, representation, form, or other "
        "document reasonably requested by and acceptable to the General Partner "
        "for the purpose of (A) obtaining any exemption, reduction, or refund of "
        "any withholding or other taxes imposed by any Taxing Authority "
        "(including withholding taxes imposed pursuant to Sections 1471 through "
        "1474 of the Code and the Treasury Regulations thereunder), or (B) "
        "satisfying reporting or other obligations under the Code and the Treasury "
        "Regulations thereunder; (ii) update or replace such information in "
        "accordance with its terms or subsequent amendments; and (iii) otherwise "
        "comply with any reporting obligations or information disclosure "
        "requirements imposed by the United States or any other jurisdiction and "
        "any reporting obligations that may be imposed by future legislation.",
        "(b) <i>Withholding Advances.</i> The Partnership is hereby authorized "
        "at all times to make payments (&ldquo;<b>Withholding Advances</b>&rdquo;) "
        "with respect to each Partner in amounts required to discharge any "
        "obligation of the Partnership to withhold or make payments to any Taxing "
        "Authority. Any funds withheld from a distribution by reason of this "
        "Section 8.03(b) shall nonetheless be deemed distributed to the Partner "
        "in question for all purposes under this Agreement and, at the option of "
        "the General Partner, shall be charged against the Partner&rsquo;s "
        "Capital Account.",
        "(c) <i>Repayment of Withholding Advances.</i> Any Withholding Advance "
        "made by the Partnership to a Taxing Authority on behalf of a Partner and "
        "not simultaneously withheld from a distribution to that Partner shall, "
        "with interest thereon accruing from the date of payment at a rate equal "
        "to annual interest rate of eight percent (8%) (the &ldquo;<b>Partnership "
        "Interest Rate</b>&rdquo;): (i) be promptly repaid to the Partnership by "
        "the Partner on whose behalf the Withholding Advance was made; or (ii) "
        "with the consent of the General Partner, be repaid by reducing the "
        "amount of the next succeeding distribution or distributions to be made "
        "to such Partner.",
        "(d) <i>Indemnification.</i> Each Partner hereby agrees to indemnify and "
        "hold harmless the Partnership and the other Partners from and against "
        "any liability with respect to taxes, interest, or penalties which may be "
        "asserted by reason of the Partnership&rsquo;s failure to deduct and "
        "withhold tax on amounts distributable or allocable to such Partner."))

    story.extend(section("8.04", "Form of Distributions",
        "Distributions of Distributable Cash made prior to the dissolution and "
        "liquidation of the Fund and upon liquidation and termination of the "
        "Fund, the Fund may distribute cash, Marketable Securities, non-Marketable "
        "Securities, restricted securities, or other assets, in the sole "
        "discretion of the General Partner (or Liquidator, if different). In the "
        "event that the General Partner (or Liquidator, if different) intends to "
        "make a distribution of assets in kind, the General Partner (or "
        "Liquidator, if different) shall deliver a notice to the Limited Partners "
        "not less than fifteen (15) Business Days prior to making such distribution. "
        "Notwithstanding the foregoing, any retained Marketable Securities, "
        "non-Marketable Securities, restricted securities, or other assets shall "
        "be deemed for all purposes to have been distributed to such Limited "
        "Partner at their Fair Value regardless of ultimate sales proceeds. "
        "Distributions of assets in kind shall be allocated in accordance with "
        "Section 8.01 as if such assets (valued at their Fair Value) were "
        "Distributable Cash."))

    story.extend(section("8.05", "Retention of Distributable Cash",
        "The Partnership shall be permitted, in the sole discretion of the "
        "General Partner, to retain and not distribute some or all of the "
        "Distributable Cash from one or more of the Portfolio Investments for "
        "purposes of (a) completing transactions in progress or (b) other "
        "reasonable activities in the discretion of the General Partner."))

    story.extend(section("8.06", "Withdrawals",
        "(a) <i>Lock-Up Period.</i> Each Limited Partner&rsquo;s Interest shall "
        "be subject to a lock-up period of one (1) year commencing on the date of "
        "such Limited Partner&rsquo;s initial admission to the Partnership (and, "
        "with respect to additional Capital Contributions, one (1) year from the "
        "date of such additional contribution) (the &ldquo;<b>Lock-Up "
        "Period</b>&rdquo;). During the Lock-Up Period, no withdrawals may be "
        "made without the consent of the General Partner, which consent may be "
        "granted or withheld in the General Partner&rsquo;s sole and absolute "
        "discretion. Any withdrawal granted by the General Partner during the "
        "Lock-Up Period shall be subject to the Early-Withdrawal Penalty set "
        "forth in Section 8.06(f).",
        "(b) <i>Withdrawal Mechanics.</i> Following the expiration of the Lock-Up "
        "Period, a Limited Partner may withdraw all or part of its Capital "
        "Account as of the last day of each calendar quarter (each a "
        "&ldquo;<b>Withdrawal Date</b>&rdquo;), upon at least sixty (60) days&rsquo; "
        "prior written notice to the General Partner in a form provided by the "
        "General Partner (a &ldquo;<b>Redemption Request</b>&rdquo;). The amount "
        "of the withdrawal shall be determined based on the Limited Partner&rsquo;s "
        "pro rata share of the Fund&rsquo;s Net Asset Value as of the applicable "
        "Withdrawal Date, less any fees, expenses, and accrued allocations.",
        "(c) <i>Withdrawal Gate.</i> If aggregate Redemption Requests on any "
        "Withdrawal Date exceed 25% of the Partnership&rsquo;s Net Asset Value as "
        "of that date (the &ldquo;<b>Withdrawal Gate</b>&rdquo;), the General "
        "Partner will process each Redemption Request on a pro rata basis up to "
        "the 25% aggregate limit, and the balance of unsatisfied Redemption "
        "Requests shall be deferred to subsequent Withdrawal Dates over a period "
        "not to exceed three (3) Withdrawal Dates from the original Withdrawal "
        "Date.",
        "(d) <i>Audit Holdback.</i> A Limited Partner withdrawing ninety percent "
        "(90%) or more of its Capital Account balance shall be paid ninety "
        "percent (90%) of the estimated withdrawal amount within thirty (30) "
        "days after the applicable Withdrawal Date. The remaining ten percent "
        "(10%) shall be held back pending completion of the Partnership&rsquo;s "
        "annual audit and shall be released to the withdrawing Limited Partner "
        "within thirty (30) days after completion of such audit.",
        "(e) <i>Minimum Withdrawal.</i> The minimum withdrawal amount shall be "
        "$25,000. A Limited Partner may not reduce its Capital Account balance "
        "below $50,000 by reason of a partial withdrawal. A Limited Partner whose "
        "Capital Account would fall below $50,000 after a partial withdrawal may "
        "be required by the General Partner to withdraw in full.",
        "(f) <i>Early-Withdrawal Penalty.</i> Any withdrawal granted by the "
        "General Partner during a Limited Partner&rsquo;s Lock-Up Period shall be "
        "subject to a penalty equal to twenty-five percent (25%) of the amount "
        "withdrawn. Amounts withheld by reason of the Early-Withdrawal Penalty "
        "shall be retained by the Partnership for the benefit of the "
        "non-withdrawing Limited Partners.",
        "(g) <i>Suspension of Withdrawals.</i> The General Partner may, in its "
        "sole and absolute discretion, suspend or postpone the payment of "
        "withdrawals during any period in which the General Partner determines "
        "such suspension is in the best interests of the Partnership and its "
        "Limited Partners, including during periods of market disruption, "
        "illiquidity, or regulatory uncertainty."))

    story.extend(section("8.07", "Side Pocket Investments",
        "The General Partner may, in its sole and absolute discretion, designate "
        "a Portfolio Investment as a &ldquo;<b>Side Pocket Investment</b>&rdquo; "
        "if the General Partner determines that such investment is illiquid or "
        "otherwise not appropriate for inclusion in the Partnership&rsquo;s "
        "regular Net Asset Value determination. Upon such designation: (a) the "
        "Fair Value of the Side Pocket Investment shall be segregated from the "
        "Capital Accounts of the Limited Partners on the books of the Partnership; "
        "(b) Management Fees shall not accrue with respect to the Side Pocket "
        "Investment; (c) no Performance Allocation shall accrue with respect to "
        "the Side Pocket Investment until it is realized; and (d) any Limited "
        "Partner withdrawal request with respect to the portion of its Capital "
        "Account attributable to the Side Pocket Investment shall be suspended "
        "until the Side Pocket Investment is realized. The General Partner does "
        "not intend to utilize Side Pockets in the ordinary course of the "
        "Partnership&rsquo;s operations."))

    story.extend(section("8.08", "New Issues",
        "The General Partner shall comply with FINRA Rules 5130 and 5131 "
        "regarding the allocation of New Issues. The General Partner shall "
        "obtain from each Limited Partner such information as necessary to "
        "determine whether such Limited Partner is a &ldquo;restricted person&rdquo; "
        "within the meaning of FINRA Rule 5130, and shall allocate gains and "
        "losses attributable to New Issues among Limited Partners consistent "
        "with the requirements of FINRA Rule 5130, subject to the <i>de minimis</i> "
        "exemption thereunder."))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# ARTICLE IX — THE INVESTMENT MANAGER
# ═══════════════════════════════════════════════════════════════════════════
def build_article_ix():
    story = []
    story.extend(article("IX", "THE INVESTMENT MANAGER"))

    story.extend(section("9.01", "Investment Manager",
        "The General Partner has engaged STT Capital Advisors, LLC, a Delaware "
        "limited liability company (the &ldquo;<b>Investment Manager</b>&rdquo;), "
        "to serve as investment manager of the Partnership. The General Partner "
        "and the Partnership have entered into a written agreement with the "
        "Investment Manager (the &ldquo;<b>Investment Management Agreement</b>&rdquo;), "
        "pursuant to which the Investment Manager provides investment management "
        "services to the Partnership and is paid the Investment Management Fee; "
        "<i>provided</i>, that the Investment Management Agreement shall provide "
        "that it may be terminated by the Partnership without penalty upon the "
        "removal or withdrawal of the General Partner. The General Partner may "
        "engage or appoint a replacement or successor investment manager in its "
        "sole and absolute discretion."))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# ARTICLE X — ACCOUNTING AND REPORTS
# ═══════════════════════════════════════════════════════════════════════════
def build_article_x():
    story = []
    story.extend(article("X", "ACCOUNTING AND REPORTS"))

    story.extend(section("10.01", "Books and Records",
        "(a) The General Partner shall maintain at the office of the Partnership "
        "full and accurate books of the Partnership (which at all times shall "
        "remain the property of the Partnership), in the name of the Partnership "
        "and separate and apart from the books of the General Partner and its "
        "Affiliates, including a list of the names, addresses, and interests of "
        "all Limited Partners and all other books, records, and information "
        "required by the Delaware Act. The Partnership&rsquo;s books and records "
        "shall be maintained in U.S. dollars and in accordance with U.S. generally "
        "accepted accounting principles. The General Partner may cause the "
        "Partnership to retain any other nationally recognized accounting firm as "
        "its independent certified public accounting firm as it may from time to "
        "time determine and shall provide notice of such retention to the Limited "
        "Partners.",
        "(b) Subject to Section 16.13, each Limited Partner shall be allowed full "
        "and complete access to review all records and books of account of the "
        "Partnership for a purpose reasonably related to such Limited "
        "Partner&rsquo;s Interest as a limited partner at the offices of the "
        "General Partner during regular business hours, at its expense and upon "
        "two (2) Business Days&rsquo; notice to the General Partner. The General "
        "Partner shall retain all records and books relating to the Partnership "
        "for a period of at least five (5) years after the termination of the "
        "Partnership."))

    story.extend(section("10.02", "Partnership Representative",
        "(a) <i>Designation.</i> The General Partner shall be designated as the "
        "&ldquo;partnership representative&rdquo; (the &ldquo;<b>Partnership "
        "Representative</b>&rdquo;) as provided in Section 6223(a) of the Code "
        "(or under any applicable state or local law providing for an analogous "
        "capacity). The Partnership Representative shall appoint an individual "
        "meeting the requirements of Treasury Regulation Section 301.6223-1(c)(3) "
        "as the sole person authorized to represent the Partnership Representative "
        "in audits and other proceedings governed by the partnership audit "
        "procedures set forth in Subchapter C of Chapter 63 of the Code as "
        "amended by the BBA (the &ldquo;<b>Revised Partnership Audit Rules</b>&rdquo;).",
        "(b) <i>Tax Examinations and Audits.</i> The Partnership Representative "
        "is authorized and required to represent the Partnership in connection "
        "with all examinations of the affairs of the Partnership by any Taxing "
        "Authority, including any resulting administrative and judicial "
        "proceedings, and to expend funds of the Partnership for professional "
        "services and costs associated therewith. Each Partner agrees that any "
        "action taken by the Partnership Representative in connection with audits "
        "of the Partnership shall be binding upon such Partners.",
        "(c) <i>Revised Partnership Audit Rules.</i> In the event of an audit "
        "subject to the Revised Partnership Audit Rules, the Partnership "
        "Representative, in its sole discretion, shall have the right to make "
        "any and all elections and take any actions available under the Revised "
        "Partnership Audit Rules or analogous state or local law."))

    story.extend(section("10.03", "Reports to Partners",
        "(a) The General Partner shall cause to be prepared and furnished to each "
        "Limited Partner at the Partnership&rsquo;s expense with respect to each "
        "Fiscal Year of the Partnership within one hundred twenty (120) days "
        "after the close of such Fiscal Year (subject to reasonable delays due to "
        "late receipt of necessary information):"))
    story.append(subpara("(i)  audited financial statements of the Partnership, including an income statement, balance sheet, statement of cash flows, and statement of partners&rsquo; capital, prepared in accordance with U.S. generally accepted accounting principles;"))
    story.append(subpara("(ii)  a summary description of (A) each Portfolio Investment, (B) any material event regarding the business of the Partnership, and (C) each Disposition of a Portfolio Investment during such Fiscal Year; and"))
    story.append(subpara("(iii)  a statement of such Limited Partner&rsquo;s share in the Partnership&rsquo;s taxable income or loss for such Fiscal Year and information relating to the nature thereof, including copies of IRS Schedule K-1."))
    story.append(P(
        "(b) The General Partner shall cause to be prepared and furnished to each "
        "Limited Partner with respect to each fiscal quarter (other than the "
        "Partnership&rsquo;s last fiscal quarter of each Fiscal Year) within "
        "sixty (60) days after the close of such fiscal quarter: (i) unaudited "
        "financial statements of the Partnership; and (ii) a summary description "
        "of each Portfolio Investment, any material event regarding the business "
        "of the Partnership, and each Disposition of a Portfolio Investment "
        "during such quarterly period.",
        BODY))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# ARTICLE XI — TRANSFERS OF LIMITED PARTNERSHIP INTERESTS
# ═══════════════════════════════════════════════════════════════════════════
def build_article_xi():
    story = []
    story.extend(article("XI", "TRANSFERS OF LIMITED PARTNERSHIP INTERESTS"))

    story.extend(section("11.01", "Transfers",
        "A Limited Partner may not Transfer its Interest in the Partnership or "
        "any part thereof except as permitted in this Article XI. Any Transfer in "
        "violation of this Article XI shall be null and void and of no force or "
        "effect."))

    story.extend(section("11.02", "Transfer by Limited Partners",
        "(a) A Limited Partner may Transfer all or a portion of its Interest in "
        "the Partnership only if the General Partner consents in writing to the "
        "Transfer, which consent may be granted or withheld in its sole "
        "discretion, and all of the following conditions are satisfied:"))
    story.append(subpara("(i)  the transferring Limited Partner and proposed transferee file a notice, signed and certified by the transferring Limited Partner, with the General Partner at least thirty (30) Business Days in advance of the proposed Transfer;"))
    story.append(subpara("(ii)  the Transfer does not cause the Partnership to be treated as a &ldquo;publicly traded partnership&rdquo; within the meaning of Section 7704 of the Code;"))
    story.append(subpara("(iii)  all costs and expenses incurred by the Partnership in connection with the Transfer are paid by the transferring Limited Partner to the Partnership (including attorneys&rsquo; fees), and in any event subject to a minimum of $2,500 per Transfer;"))
    story.append(subpara("(iv)  a fully executed and acknowledged written transfer agreement between the transferring Limited Partner and the transferee has been filed with the Partnership;"))
    story.append(subpara("(v)  the transferee has executed a copy of this Agreement; and"))
    story.append(subpara("(vi)  the General Partner determines, and such determination is confirmed by an opinion of counsel satisfactory to the General Partner stating, that (A) the Transfer does not violate the Securities Act or applicable state securities laws; (B) the Transfer will not require the Partnership or the General Partner to register as an investment company under the Investment Company Act; (C) the Transfer will not require the General Partner or any Affiliate that is not registered under the Advisers Act to register as an investment adviser under the Advisers Act; (D) notwithstanding such Transfer, the Partnership shall continue to be treated as a partnership under the Code; and (E) the Transfer will not violate the applicable laws of any state or the applicable rules and regulations of any Governmental Authority."))

    story.extend(section("11.03", "Substitute Limited Partners",
        "A transferee of all or a portion of an Interest in the Partnership "
        "pursuant to Section 11.02 shall have the right to become a substitute "
        "limited partner (a &ldquo;<b>Substitute Limited Partner</b>&rdquo;) in "
        "place of its transferor, effective as of the last day of a fiscal "
        "quarter, only if all of the following conditions are satisfied: (a) the "
        "fully executed and acknowledged written instrument of Transfer has been "
        "filed with the Partnership; (b) the transferee executes, adopts, and "
        "acknowledges this Agreement and is listed in the books and records of "
        "the Partnership as a Limited Partner; (c) any costs and expenses of "
        "Transfer incurred by the Partnership are paid to the Partnership; and "
        "(d) the General Partner has provided its consent in writing to the "
        "substitution, which consent may be granted or withheld in its sole "
        "discretion."))

    story.extend(section("11.04", "Involuntary Withdrawal by Limited Partners",
        "(a) Upon the death, Bankruptcy, dissolution, or other cessation of "
        "existence of a Limited Partner, the authorized representative of such "
        "Limited Partner shall have all the rights of a Limited Partner for the "
        "purpose of settling or managing the estate or effecting the orderly "
        "winding up and disposition of the business of such Limited Partner. "
        "Such Limited Partner shall not be entitled to receive the Fair Value of "
        "its Interest in the Partnership.",
        "(b) The death, Bankruptcy, dissolution, disability, or legal incapacity "
        "of a Limited Partner shall not dissolve or terminate the Partnership."))

    story.extend(section("11.05", "Required Withdrawals",
        "(a) If the General Partner determines, in good faith, that the continued "
        "participation of a Limited Partner in the Partnership would be "
        "reasonably likely to result in a violation of any law or regulation "
        "applicable to the Partnership (including the AML Laws) or subject the "
        "Partnership to any unintended law or regulatory scheme (including "
        "ERISA) (a &ldquo;<b>Legal Violation</b>&rdquo;), then the General Partner "
        "shall notify such Limited Partner of such Legal Violation and such "
        "Limited Partner shall be required to withdraw from the Partnership "
        "immediately following such notification (the &ldquo;<b>Withdrawal "
        "Date</b>&rdquo;).",
        "(b) A withdrawing Limited Partner under Section 11.05(a) shall be "
        "entitled to receive a distribution equal to any amounts it would have "
        "been entitled to if the Partnership, in accordance with the provisions "
        "hereof, dissolved, liquidated, and distributed all the proceeds thereof "
        "as of the date of withdrawal of such Limited Partner."))

    story.extend(section("11.06", "Limited Partner Expulsion",
        "The General Partner shall have the authority, at its sole discretion, "
        "to expel any Limited Partner from the Partnership. Upon expulsion, the "
        "General Partner shall provide written notice to the expelled Limited "
        "Partner, and the expelled Limited Partner shall be entitled to receive "
        "the Fair Value of its Interest, calculated as of the effective date of "
        "expulsion, payable within thirty (30) days. The decision of the General "
        "Partner to expel a Limited Partner shall be final, binding, and not "
        "subject to appeal or review."))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# ARTICLE XII — DISSOLUTION AND LIQUIDATION
# ═══════════════════════════════════════════════════════════════════════════
def build_article_xii():
    story = []
    story.extend(article("XII", "DISSOLUTION AND LIQUIDATION"))

    story.extend(section("12.01", "Dissolution",
        "The Partnership shall be dissolved upon the first to occur of the "
        "following:"))
    story.append(subpara("(a)  an election to dissolve the Partnership is made by the General Partner in its good faith judgment;"))
    story.append(subpara("(b)  an election to dissolve the Partnership is made by the General Partner with the consent of a Majority in Interest of the Limited Partners;"))
    story.append(subpara("(c)  the reduction to cash of all of the Portfolio Investments of the Partnership;"))
    story.append(subpara("(d)  subject to the provisions of Section 4.07 through 4.11, the Bankruptcy, dissolution, removal, or other withdrawal of the General Partner or the Transfer of the General Partner&rsquo;s Interest in the Partnership;"))
    story.append(subpara("(e)  the death, resignation, disability, or legal incapacity of both Scott R. McBrien and Cindy Eagar if, within ninety (90) days thereafter, no successor general partner has been admitted to the Partnership in accordance with Section 4.08 or Section 4.11;"))
    story.append(subpara("(f)  as provided in Section 14.04(b);"))
    story.append(subpara("(g)  the entry of a decree of judicial dissolution pursuant to the Delaware Act; or"))
    story.append(subpara("(h)  any other event causing dissolution of the Partnership under the Delaware Act."))

    story.extend(section("12.02", "Liquidation",
        "(a) Upon dissolution of the Partnership and subject to Section 12.02(b), "
        "the General Partner, or if the General Partner&rsquo;s withdrawal, "
        "removal, or Bankruptcy caused the dissolution of the Partnership, such "
        "other Person who may be appointed by consent of a Majority in Interest "
        "of the Limited Partners, who shall be responsible for taking all action "
        "necessary or appropriate to wind up the affairs and distribute the "
        "assets of the Partnership following its dissolution (the "
        "&ldquo;<b>Liquidator</b>&rdquo;) shall wind up the affairs of the "
        "Partnership and proceed within a reasonable period of time to sell or "
        "otherwise liquidate the assets of the Partnership, subject to obtaining "
        "fair value for such assets and any tax or other legal considerations, "
        "and, after paying or making due provision by the setting up of reserves "
        "for all liabilities to creditors of the Partnership who are not "
        "Partners, distribute the proceeds therefrom among the Partners in "
        "accordance with Section 12.02(c).",
        "(b) No Partner shall be liable for the return of the Capital "
        "Contributions of any other Partner; <i>provided</i>, that this provision "
        "shall not relieve any Partner of any other duty or liability it may have "
        "under this Agreement.",
        "(c) Upon liquidation of the Partnership, all of the assets of the "
        "Partnership, and any proceeds therefrom, shall be applied in the "
        "following order of priority: (i) first, in discharge of (1) all claims "
        "of creditors of the Partnership who are not Partners and (2) all "
        "expenses of liquidation; (ii) second, to establish any reserves which "
        "the Liquidator may deem reasonably necessary for any contingent or "
        "unforeseen liabilities or obligations of the Partnership; and (iii) "
        "third, to the Partners in the same manner as distributions are made "
        "under Section 8.01.",
        "(d) When the Liquidator has complied with the foregoing liquidation "
        "plan, the termination of the Partnership shall be effective on the "
        "filing of, and the General Partner or Liquidator shall file, a "
        "certificate of cancellation of the Certificate of Limited Partnership "
        "(the &ldquo;<b>Certificate of Cancellation</b>&rdquo;) with the Office "
        "of the Secretary of State of the State of Delaware in accordance with "
        "Section 17-203 of the Delaware Act."))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# ARTICLE XIII — REPRESENTATIONS AND WARRANTIES OF THE GENERAL PARTNER
# ═══════════════════════════════════════════════════════════════════════════
def build_article_xiii():
    story = []
    story.extend(article("XIII", "REPRESENTATIONS AND WARRANTIES OF THE GENERAL PARTNER"))

    story.extend(section("13.01", "Representations and Warranties of the General Partner",
        "The General Partner represents, warrants, and covenants to each Limited "
        "Partner that as of the date of the Initial Closing:"))
    story.append(subpara("(a)  The Partnership has been duly formed and is a validly existing limited partnership under the laws of the State of Delaware with full power and authority to conduct its business as described in this Agreement."))
    story.append(subpara("(b)  The General Partner has been duly formed and is a validly existing limited liability company under the laws of the State of Delaware, with full power and authority to perform its obligations herein."))
    story.append(subpara("(c)  All action required to be taken by the General Partner and the Partnership, as a condition to the issuance and sale of the Interests being purchased by the Limited Partners, has been taken."))
    story.append(subpara("(d)  The Interest of each Limited Partner represents a duly and validly issued limited partnership interest in the Partnership and each Limited Partner is entitled to all the benefits of a Limited Partner under this Agreement and the Delaware Act."))
    story.append(subpara("(e)  This Agreement has been duly authorized, executed, and delivered by the General Partner and, assuming due authorization, execution, and delivery by each Limited Partner, constitutes a valid and binding agreement of the General Partner enforceable in accordance with its terms against the General Partner, except as may be limited by bankruptcy, insolvency, reorganization, moratorium, and other similar laws of general applicability relating to or affecting creditors&rsquo; rights or general equity principles."))
    story.append(subpara("(f)  The Private Placement Memorandum for the Fund did not contain any untrue statement of a material fact and did not omit to state a material fact necessary to make the statements made therein, in light of the circumstances in which they were made, not misleading, except that the description therein of this Agreement and the provisions hereof is superseded in its entirety by this Agreement."))
    story.append(subpara("(g)  Assuming the accuracy of the representations and warranties made by each Limited Partner pursuant to the relevant Subscription Agreement, the Partnership is not required to register as an investment company under the Investment Company Act."))
    story.append(subpara("(h)  Assuming the accuracy of the representations and warranties made by each Limited Partner pursuant to the relevant Subscription Agreement, the offer and sale of the Interests in accordance with the terms of the relevant Subscription Agreement does not require registration of the Interests under the Securities Act."))
    story.append(subpara("(i)  The only fees payable to the General Partner by the Partnership or the Limited Partners are those contemplated or specified by this Agreement."))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# ARTICLE XIV — ERISA CONSIDERATIONS
# ═══════════════════════════════════════════════════════════════════════════
def build_article_xiv():
    story = []
    story.extend(article("XIV", "ERISA CONSIDERATIONS"))

    story.extend(section("14.01", "Status Under ERISA Plan Asset Rules",
        "The General Partner shall use its reasonable best efforts to (a) limit "
        "equity participation by &ldquo;benefit plan investors&rdquo; to less "
        "than 25% of the total value of each class of equity interests in the "
        "Partnership, or (b) structure Portfolio Investments of the Partnership "
        "and operate the Partnership in such a manner so as to qualify the "
        "Partnership as a &ldquo;venture capital operating company&rdquo; "
        "(&ldquo;<b>VCOC</b>&rdquo;) or &ldquo;real estate operating company&rdquo; "
        "(&ldquo;<b>REOC</b>&rdquo;) under ERISA so that the underlying assets of "
        "the Partnership should not constitute &ldquo;plan assets&rdquo; of any "
        "&ldquo;benefit plan investor&rdquo; that invests in the Partnership, or "
        "(c) comply with such other exception as may be available under the Plan "
        "Asset Rules to prevent the assets of the Partnership from being treated "
        "as the assets of any ERISA Partner. The General Partner will promptly "
        "notify each ERISA Partner of any such election to limit participation "
        "by Benefit Plan Investors pursuant to Section 14.04(a)."))

    story.extend(section("14.02", "VCOC/REOC Procedures",
        "If the General Partner conducts the affairs of the Partnership as a "
        "VCOC/REOC pursuant to Section 14.01(b), the General Partner shall "
        "deliver to each ERISA Partner an opinion of Partnership Counsel (or such "
        "other counsel as shall be reasonably acceptable to at least 65% of the "
        "Percentage Interests of the ERISA Partners) to the effect that the "
        "Partnership should qualify as a VCOC/REOC on the date of the "
        "Partnership&rsquo;s &ldquo;first Investment.&rdquo; Thereafter, the "
        "General Partner shall deliver to each ERISA Partner a certificate with "
        "respect to each &ldquo;annual valuation period&rdquo; stating whether "
        "the Partnership should qualify as a VCOC/REOC on at least one day during "
        "such &ldquo;annual valuation period.&rdquo; The General Partner shall "
        "deliver such certificate within 60 days following the last day of each "
        "such annual valuation period."))

    story.extend(section("14.03", "Significant Participation and Plan Asset Procedures",
        "If the General Partner exercises its discretion to limit the "
        "participation of Benefit Plan Investors in the Partnership pursuant to "
        "Section 14.01(a), or if the General Partner determines in good faith "
        "that there is a reasonable likelihood that any or all of the assets of "
        "the Partnership would be deemed to be &ldquo;plan assets&rdquo; under "
        "the Plan Asset Rules:",
        "(a) no transaction affecting the Interests shall be effective if the "
        "General Partner determines such transaction would cause or would present "
        "a material risk of causing the interests of Benefit Plan Investors to "
        "be &ldquo;significant&rdquo; under the Plan Asset Rules; and",
        "(b) the General Partner may take any actions it deems appropriate in "
        "connection with assuring compliance with such exception."))

    story.extend(section("14.04", "Consequences of ERISA Plan Asset Status",
        "If the General Partner determines that participation by Benefit Plan "
        "Investors in the Partnership is &ldquo;significant&rdquo; for purposes "
        "of the Plan Asset Rules or that no other exception from treatment as "
        "&ldquo;plan assets&rdquo; under the Plan Asset Rules applies, then the "
        "General Partner shall notify the ERISA Partners in writing within 15 "
        "business days of such determination. The General Partner is hereby "
        "authorized and empowered to take such actions as it determines in its "
        "discretion are appropriate to mitigate, prevent, or cure any adverse "
        "consequences of such determination, which may include, without "
        "limitation: (a) renegotiating the terms of any Portfolio Investment or "
        "otherwise modifying the manner in which the Partnership conducts its "
        "business; (b) permitting or requiring the Transfer of all or a portion "
        "of the Interests of any or all of the ERISA Partners; and (c) requiring "
        "each ERISA Partner that is a Benefit Plan Investor (on a pro rata basis "
        "unless otherwise consented to by an ERISA Partner) to transfer all or "
        "a portion of its Interest at a price not less than the Fair Value "
        "thereof."))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# ARTICLE XV — AMENDMENTS AND MEETINGS
# ═══════════════════════════════════════════════════════════════════════════
def build_article_xv():
    story = []
    story.extend(article("XV", "AMENDMENTS AND MEETINGS"))

    story.extend(section("15.01", "Amendment Procedure",
        "This Agreement may be amended or modified only as follows:",
        "(a) Amendments to this Agreement shall be proposed by the General Partner.",
        "(b) Except as otherwise provided in Section 15.01(c) and Section 15.02, "
        "a proposed amendment shall be adopted and effective only if it receives "
        "the consent of the General Partner, which consent it may grant or "
        "withhold in its sole discretion, and the consent of Limited Partners "
        "whose Capital Commitments represent at least sixty-six and two-thirds "
        "percent (66-2/3%) of the aggregate Capital Commitments of all Limited "
        "Partners.",
        "(c) <i>GP Unilateral Amendments.</i> Notwithstanding anything to the "
        "contrary herein, the General Partner may amend this Agreement, in its "
        "sole discretion and without consent of any Limited Partner, to: (i) "
        "effect changes of an administrative or ministerial nature; (ii) cure "
        "any ambiguity or correct or supplement any provision hereof which is "
        "incomplete or inconsistent with any other provision hereof; (iii) make "
        "changes that do not adversely affect the rights or obligations of any "
        "Limited Partner; (iv) admit additional Limited Partners pursuant to "
        "Subsequent Closings; (v) make any changes necessary or advisable to "
        "comply with the Advisers Act, the Investment Company Act, the Securities "
        "Act, or any other applicable law or regulation; or (vi) change the name "
        "of the Partnership.",
        "(d) The General Partner shall furnish each Limited Partner with a copy "
        "of each amendment to this Agreement promptly after its adoption."))

    story.extend(section("15.02", "Exceptions: Individual Limited Partner Consent Required",
        "Notwithstanding the provisions of Section 15.01, no amendment shall be "
        "effective as to any Limited Partner without the individual consent of "
        "such Limited Partner that:",
        "(a) increases the aggregate Capital Contributions required from such "
        "Limited Partner;",
        "(b) decreases the interest of such Limited Partner in the Net Income, "
        "Net Loss, fees, or Distributable Cash of the Partnership (other than "
        "pursuant to the Performance Allocation and class structure set forth in "
        "Article VIII);",
        "(c) adversely affects the limited liability of such Limited Partner "
        "under this Agreement or the Delaware Act; or",
        "(d) directly or indirectly affects or jeopardizes the status of the "
        "Partnership as a partnership for federal income tax purposes."))

    story.extend(section("15.03", "Side Letters",
        "The Partnership or the General Partner may, without any further act, "
        "approval, or vote of any Partner, enter into side letters or other "
        "agreements with one or more Limited Partners that have the effect of "
        "establishing rights under, or altering or supplementing, the terms of "
        "this Agreement, and any rights established or any terms of this "
        "Agreement altered or supplemented in a side letter with a Limited "
        "Partner shall govern solely with respect to such Limited Partner "
        "notwithstanding any other provision of this Agreement; <i>provided</i>, "
        "that no such side letter or other agreement shall adversely affect the "
        "rights of any other Limited Partner hereunder."))

    story.extend(section("15.04", "Meetings and Voting",
        "(a) Meetings of the Partners may be called by the General Partner for "
        "any purpose permitted by this Agreement or the Delaware Act at a time "
        "and place reasonably selected by the General Partner. Except as "
        "otherwise specified herein, the General Partner shall give all Limited "
        "Partners not less than 15 nor more than 60 days&rsquo; notice of the "
        "purpose of such proposed meeting and any votes to be conducted at such "
        "meeting. Partners may participate in a meeting by telephone or similar "
        "communications by means of which all Persons participating in the "
        "meeting can hear and be heard. The General Partner shall call a meeting "
        "of the Partners for informational purposes at least once every Fiscal "
        "Year with at least 60 days&rsquo; notice to discuss the Fund&rsquo;s "
        "investment activities.",
        "(b) The General Partner shall, where feasible, solicit required consents "
        "of the Limited Partners under this Agreement by written ballot with at "
        "least 15 days&rsquo; notice or, if a written ballot is not feasible, at "
        "a meeting held pursuant to Section 15.04(a)."))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# ARTICLE XVI — MISCELLANEOUS
# ═══════════════════════════════════════════════════════════════════════════
def build_article_xvi():
    story = []
    story.extend(article("XVI", "MISCELLANEOUS"))

    story.extend(section("16.01", "Severability",
        "Each provision of this Agreement shall be considered separable and if "
        "for any reason any provision or provisions herein are determined to be "
        "invalid, unenforceable, or illegal under any existing or future law in "
        "any jurisdiction, such invalidity, unenforceability, or illegality "
        "shall not impair the operation of or affect those portions of this "
        "Agreement which are valid, enforceable, and legal."))

    story.extend(section("16.02", "Governing Law",
        "All issues and questions concerning the application, construction, "
        "validity, interpretation, and enforcement of this Agreement shall be "
        "governed by and construed in accordance with the internal laws of the "
        "State of Delaware, without giving effect to any choice of law or "
        "conflict of law provision or rule (whether of the State of Delaware or "
        "any other jurisdiction) that would cause the application of laws of any "
        "jurisdiction other than those of the State of Delaware."))

    story.extend(section("16.03", "Dispute Resolution",
        "Any dispute, controversy, or claim arising out of or relating to this "
        "Agreement, or the transactions contemplated hereby, shall be submitted "
        "to binding arbitration administered by the American Arbitration "
        "Association (&ldquo;<b>AAA</b>&rdquo;) under its Commercial Arbitration "
        "Rules, held in the State of Delaware, before a single arbitrator "
        "selected from the AAA&rsquo;s roster. The prevailing party shall be "
        "awarded its reasonable costs and attorneys&rsquo; fees. The "
        "arbitrator&rsquo;s award shall be final and binding, and judgment on the "
        "award may be entered in any court of competent jurisdiction."))

    story.extend(section("16.04", "Successors and Assigns",
        "Subject to the restrictions on Transfers set forth herein, this "
        "Agreement shall be binding upon and shall inure to the benefit of the "
        "parties hereto and their respective heirs, executors, administrators, "
        "successors, and assigns."))

    story.extend(section("16.05", "Waiver of Jury Trial",
        "Each party hereto acknowledges and agrees that any controversy which "
        "may arise under this Agreement is likely to involve complicated and "
        "difficult issues and, therefore, each such party irrevocably and "
        "unconditionally waives any right it may have to a trial by jury in "
        "respect of any legal action arising out of or relating to this "
        "Agreement or the transactions contemplated hereby."))

    story.extend(section("16.06", "Waiver of Action for Partition",
        "Each of the parties hereto irrevocably waives during the term of the "
        "Partnership any right that it may have to maintain any action for "
        "partition with respect to any property of the Partnership."))

    story.extend(section("16.07", "Record of Limited Partners",
        "The General Partner shall maintain at the office of the Partnership a "
        "record showing the names and addresses of all the Limited Partners. All "
        "Limited Partners and their duly authorized representatives shall have "
        "the right to inspect such record for a purpose reasonably related to "
        "such Limited Partner&rsquo;s Interest."))

    story.extend(section("16.08", "Headings",
        "The headings in this Agreement are inserted for convenience or reference "
        "only and are in no way intended to describe, interpret, define, or "
        "limit the scope, extent, or intent of this Agreement or any provision "
        "of this Agreement."))

    story.extend(section("16.09", "Counterparts",
        "This Agreement may be executed in counterparts, each of which shall be "
        "deemed an original, but all of which together shall be deemed to be one "
        "and the same agreement. A signed copy of this Agreement delivered by "
        "e-mail or other means of electronic transmission shall be deemed to "
        "have the same legal effect as delivery of an original signed copy of "
        "this Agreement."))

    story.extend(section("16.10", "Notices",
        "All notices, requests, consents, claims, demands, waivers, and other "
        "communications hereunder shall be in writing and shall be deemed to "
        "have been given: (a) when delivered by hand (with written confirmation "
        "of receipt); (b) when received by the addressee if sent by a nationally "
        "recognized overnight courier (receipt requested); (c) on the date sent "
        "by e-mail of a PDF document (with confirmation of transmission) if sent "
        "during normal business hours of the recipient, and on the next Business "
        "Day if sent after normal business hours of the recipient; or (d) on the "
        "third day after the date mailed, by certified or registered mail, "
        "return receipt requested, postage prepaid. Such communications must be "
        "sent to the respective parties at the following addresses (or at such "
        "other address for a party as shall be specified in a notice given in "
        "accordance with this Section 16.10):"))
    story.append(P(
        "<b>If to the General Partner:</b><br/>"
        "PNTHR Funds, LLC<br/>"
        "15150 W Park Place, Suite 215<br/>"
        "Goodyear, AZ 85395<br/>"
        "Email: info@PNTHRfunds.com",
        BODY_INDENT))
    story.append(P(
        "<b>If to the Partnership:</b><br/>"
        "PNTHR FUNDS, PNTHR AI Elite 300 Fund, LP<br/>"
        "c/o PNTHR Funds, LLC<br/>"
        "15150 W Park Place, Suite 215<br/>"
        "Goodyear, AZ 85395<br/>"
        "Email: info@PNTHRfunds.com",
        BODY_INDENT))

    story.extend(section("16.11", "Entire Agreement",
        "This Agreement (including any Schedules and Exhibits), the Subscription "
        "Agreements, and any other written agreements between the General "
        "Partner or the Partnership and the Limited Partners executed in "
        "connection with the subscription by the Limited Partners for the "
        "Interests, constitute the sole and entire agreement of the parties to "
        "this Agreement."))

    story.extend(section("16.12", "No Third-Party Beneficiaries; Counsel",
        "(a) <i>No Third-Party Beneficiaries.</i> Except as expressly provided "
        "to the contrary in this Agreement (including those provisions which are "
        "expressly for the benefit of the Covered Persons), this Agreement is "
        "for the sole benefit of the parties hereto (and their respective heirs, "
        "executors, administrators, successors, and assigns) and nothing herein, "
        "express or implied, is intended to or shall confer upon any other "
        "Person any legal or equitable right, benefit, or remedy of any nature "
        "whatsoever under or by reason of this Agreement.",
        "(b) <i>Counsel.</i> The General Partner, acting on behalf of the "
        "Partnership, has initially selected David S. Hunt, P.C. "
        "(&ldquo;<b>Partnership Counsel</b>&rdquo;) as legal counsel to the "
        "General Partner when acting on behalf of the Partnership. Each Limited "
        "Partner acknowledges that Partnership Counsel does not represent any "
        "Limited Partner (in its capacity as such) and shall owe no duties "
        "directly to any Limited Partner (in its capacity as such). Counsel to "
        "the Partnership may also be counsel to the General Partner and its "
        "Affiliates. The General Partner may execute on behalf of the Partnership "
        "and the Partners any consent to the representation of the General "
        "Partner when acting on behalf of the Partnership or the General Partner "
        "that counsel may request pursuant to the applicable rules of "
        "professional conduct. In the event any dispute or controversy arises "
        "between any Limited Partner and the General Partner when acting on "
        "behalf of the Partnership, each Limited Partner agrees that Partnership "
        "Counsel may represent either the Partnership or the General Partner (or "
        "its Affiliate), or both, in any such dispute to the extent permitted by "
        "the applicable rules of professional conduct in any jurisdiction, and "
        "each Limited Partner hereby consents to such representation."))

    story.extend(section("16.13", "Confidentiality",
        "(a) Each Limited Partner shall maintain the confidentiality of (i) "
        "Non-Public Information, (ii) any information subject to a confidentiality "
        "agreement binding upon the General Partner or the Partnership of which "
        "such Limited Partner has been provided written notice, and (iii) the "
        "identity of other Limited Partners and their Affiliates, so long as "
        "such information has not become otherwise publicly available unless, "
        "after reasonable notice to the Partnership by the Limited Partner, "
        "otherwise compelled by court order or other legal process.",
        "(b) As used in this Section 16.13, &ldquo;<b>Non-Public Information</b>&rdquo; "
        "means information regarding the Fund, the Partnership, the General "
        "Partner, their respective Affiliates, any Portfolio Investment or "
        "potential investment, any existing or potential Portfolio Company, or "
        "any existing or potential counterparty of the Partnership or source of "
        "existing or potential Portfolio Investments received by such Limited "
        "Partner pursuant to this Agreement, but does not include information "
        "that was publicly known when received by such Limited Partner, "
        "subsequently becomes publicly known through no act or omission by such "
        "Limited Partner, or is disclosed to such Limited Partner by a third "
        "party not known to such Limited Partner to be bound by any "
        "confidentiality obligation."))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# SIGNATURE PAGES
# ═══════════════════════════════════════════════════════════════════════════
def build_signatures():
    story = []
    story.append(P("<b>SIGNATURE PAGES</b>", ARTICLE_HDR))
    story.append(spacer(8))

    story.append(P(
        "IN WITNESS WHEREOF, the parties hereto have caused this Agreement to be "
        "executed as of the date first written above by their respective officers "
        "thereunto duly authorized.",
        BODY))

    story.append(spacer(20))

    story.append(P("<b>GENERAL PARTNER:</b>", BODY))
    story.append(P("PNTHR Funds, LLC", BODY))
    story.append(spacer(30))
    story.append(P("By: _________________________________________", BODY))
    story.append(P("Name:  Scott R. McBrien", BODY))
    story.append(P("Title:  Manager", BODY))
    story.append(spacer(30))

    story.append(P("<b>WITHDRAWING LIMITED PARTNER:</b>", BODY))
    story.append(P(
        "Solely to reflect the withdrawal from the Partnership as set forth in "
        "Section 2.06.",
        BODY))
    story.append(spacer(20))
    story.append(P("By: _________________________________________", BODY))
    story.append(P("Name:  Scott R. McBrien", BODY))
    story.append(spacer(20))
    story.append(P("By: _________________________________________", BODY))
    story.append(P("Name:  Cindy Eagar", BODY))
    story.append(spacer(30))

    story.append(P("<b>LIMITED PARTNERS:</b>", BODY))
    story.append(P(
        "All Limited Partners now and hereafter admitted pursuant to powers of "
        "attorney now and hereafter granted to the General Partner.",
        BODY))
    story.append(spacer(10))
    story.append(P("PNTHR Funds, LLC, as Attorney-in-Fact for the Limited Partners", BODY))
    story.append(spacer(30))
    story.append(P("By: _________________________________________", BODY))
    story.append(P("Name:  Scott R. McBrien", BODY))
    story.append(P("Title:  Manager", BODY))

    story.append(PageBreak())

    # Partnership Agreement Signature Page (for subscribers)
    story.append(P("<b>PARTNERSHIP AGREEMENT SIGNATURE PAGE</b>", ARTICLE_HDR))
    story.append(spacer(8))
    story.append(P(
        "This page constitutes the Subscriber&rsquo;s signature page for the "
        "Limited Partnership Agreement.",
        BODY))
    story.append(spacer(4))
    story.append(P(
        "IN WITNESS WHEREOF, the Subscriber has executed this Signature Page on "
        "________________, 20___.",
        BODY))
    story.append(spacer(20))

    story.append(P("<b>FOR INDIVIDUALS:</b>", BODY))
    story.append(spacer(10))
    story.append(P("_________________________________________  (Signature)", BODY))
    story.append(P("_________________________________________  (Printed Name of Individual Subscriber)", BODY))
    story.append(spacer(20))
    story.append(P("_________________________________________  (Signature of Joint Subscriber, if any)", BODY))
    story.append(P("_________________________________________  (Printed Name of Joint Subscriber)", BODY))
    story.append(spacer(30))

    story.append(P("<b>FOR ENTITIES:</b>", BODY))
    story.append(spacer(10))
    story.append(P("_________________________________________  (Printed Name of Entity Subscriber)", BODY))
    story.append(P("a ________________________________________", BODY))
    story.append(spacer(10))
    story.append(P("By:  _____________________________________  (Signature)", BODY))
    story.append(P("Name:  ___________________________________  (Printed Name of Authorized Signatory)", BODY))
    story.append(P("Title:  ____________________________________  (Title of Authorized Signatory)", BODY))

    return story


# ═══════════════════════════════════════════════════════════════════════════
# STUBS FOR REMAINING ARTICLES
# ═══════════════════════════════════════════════════════════════════════════
def build_stub(article_num, title, description):
    story = []
    story.extend(article(article_num, title))
    story.append(P(
        f"<i>[This article is in draft. Content to be populated from the attorney "
        f"baseline plus the user-approved revisions. Intended scope: {description}]</i>",
        BODY))
    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════
def build():
    doc = make_doc_template(
        OUT_PATH,
        title_meta="PNTHR Funds, PNTHR AI Elite 300 Fund, LP - Limited Partnership Agreement v1.0",
        subject="Limited Partnership Agreement",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Limited Partnership Agreement",
        doc_date_display="June 2026",
        fund_name="PNTHR AI Elite 300 Fund",
        fund_name_upper="PNTHR AI ELITE 300 FUND",
    )
    story = []
    story.extend(build_cover())
    story.extend(build_legend())
    story.extend(build_preamble())
    story.extend(build_article_i())

    # Articles II–XVI (fully drafted)
    story.extend(build_article_ii())
    story.extend(build_article_iii())
    story.extend(build_article_iv())
    story.extend(build_article_v())
    story.extend(build_article_vi())
    story.extend(build_article_vii())
    story.extend(build_article_viii())
    story.extend(build_article_ix())
    story.extend(build_article_x())
    story.extend(build_article_xi())
    story.extend(build_article_xii())
    story.extend(build_article_xiii())
    story.extend(build_article_xiv())
    story.extend(build_article_xv())
    story.extend(build_article_xvi())
    story.extend(build_signatures())

    doc.build(story, onFirstPage=on_cover, onLaterPages=on_page)
    print(f"PDF generated: {OUT_PATH}")


if __name__ == "__main__":
    build()
