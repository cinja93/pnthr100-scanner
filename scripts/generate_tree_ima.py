#!/usr/bin/env python3
"""
PNTHR Tree Fund, LP
Investment Management Agreement v1.0
Effective: June 1, 2026

Adapted from Carnivore Quant Fund IMA v3.5 (generate_ima_v34.py).

Changes from Carnivore v3.5:
  - Fund name: "Carnivore Quant Fund" -> "PNTHR Tree Fund" throughout
  - All dates: June 1, 2025 -> June 1, 2026
  - Version: v3.5 -> v1.0
  - Footer/header breadcrumbs updated
  - Cover title updated (no "PNTHR FUNDS," prefix per PPM convention)
  - No substantive legal content changes (IMA is fund-generic)

Output: ~/Downloads/PNTHR_Tree_Fund_IMA_v1.0_2026.pdf
"""

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import Paragraph, Spacer, PageBreak

from pnthr_design import (
    TITLE_STYLE, SUBTITLE_STYLE, H2, BODY, BODY_INDENT, COVER_NOTICE,
    make_doc_template, make_page_handlers, build_cover_header,
)

OUT_PATH = os.path.expanduser("~/Downloads/PNTHR_Tree_Fund_IMA_v1.0_2026.pdf")

# ----- IMA-specific local style (not covered by template) -------------------
SECTION_HDR = ParagraphStyle(
    name="section_hdr", fontName="Helvetica-Bold", fontSize=13, leading=16,
    alignment=TA_CENTER, spaceBefore=18, spaceAfter=8,
)

# ----- Helpers -----------------------------------------------------------
def P(text, style=BODY):
    return Paragraph(text, style)

def spacer(h=10):
    return Spacer(1, h)

def section(num, title, *paragraphs):
    out = [P(f"<b>{num}.&nbsp;&nbsp;{title}.</b>", H2)]
    for para in paragraphs:
        out.append(P(para, BODY))
    return out

def subsection(num, *paragraphs):
    out = []
    for i, para in enumerate(paragraphs):
        prefix = f"<b>{num}</b>&nbsp;&nbsp;" if i == 0 else ""
        out.append(P(prefix + para, BODY_INDENT))
    return out


# =========================================================================
# COVER
# =========================================================================
def build_cover():
    return build_cover_header(
        title_line_1="",
        title_line_2="PNTHR TREE FUND, LP",
        subtitle="INVESTMENT MANAGEMENT AGREEMENT",
        date_line="Dated as of:  June 1, 2026",
        revision_line="Document Revision:  v1.0 - June 2026",
        issuer_line="Issuer:  PNTHR Funds, LLC (General Partner)",
        confidential_title=None,
        confidential_body=None,
    )


def build_legend():
    """Confidentiality notice on page 2 top."""
    story = []
    story.append(P(
        "THIS INVESTMENT MANAGEMENT AGREEMENT CONTAINS CONFIDENTIAL INFORMATION "
        "RELATING TO PNTHR Tree Fund, LP (the &ldquo;FUND&rdquo;) "
        "AND STT CAPITAL ADVISORS LLC (THE &ldquo;INVESTMENT MANAGER&rdquo;). THIS "
        "AGREEMENT SUPPLEMENTS THE LIMITED PARTNERSHIP AGREEMENT OF THE FUND AND "
        "THE PRIVATE PLACEMENT MEMORANDUM OF THE FUND AND MUST BE READ IN "
        "CONJUNCTION THEREWITH. THIS AGREEMENT MAY NOT BE REPRODUCED OR "
        "DISCLOSED TO ANY PERSON WITHOUT THE PRIOR WRITTEN CONSENT OF THE "
        "GENERAL PARTNER.",
        COVER_NOTICE))
    story.append(PageBreak())
    return story


# =========================================================================
# PREAMBLE + RECITALS
# =========================================================================
def build_preamble():
    story = []
    story.append(P("<b>INVESTMENT MANAGEMENT AGREEMENT</b>", TITLE_STYLE))
    story.append(spacer(4))

    story.append(P(
        "THIS INVESTMENT MANAGEMENT AGREEMENT (this &ldquo;Agreement&rdquo;) is "
        "made as of June 1, 2026, by and between <b>STT Capital Advisors LLC</b>, "
        "a Delaware limited liability company (the &ldquo;Investment Manager&rdquo; "
        "or &ldquo;Manager&rdquo;), and <b>PNTHR Tree Fund, LP</b>, "
        "a Delaware limited partnership (the &ldquo;Fund&rdquo;).",
        BODY))

    story.append(P("<b>R E C I T A L S</b>", SECTION_HDR))

    # Recital A
    story.append(P(
        "<b>A.</b>&nbsp;&nbsp;The Fund has been formed for the purpose of investing "
        "principally in long positions in publicly traded United States equity "
        "securities drawn from the Fund&rsquo;s AI-300 universe, applying the PNTHR "
        "Signal System (a proprietary quantitative new-high breakout strategy). The "
        "Fund is authorized to take both long and short positions; its current "
        "systematic implementation is long-only. The strategy is more fully "
        "described in the Private Placement Memorandum prepared by the Fund dated "
        "June 1, 2026, as amended and supplemented from time to time (the "
        "&ldquo;PPM&rdquo;).",
        BODY))

    # Recital B
    story.append(P(
        "<b>B.</b>&nbsp;&nbsp;The Fund has adopted a Limited Partnership Agreement "
        "effective as of June 1, 2026, as amended from time to time (the "
        "&ldquo;Limited Partnership Agreement&rdquo; or &ldquo;LPA&rdquo;), pursuant "
        "to which the Investment Manager has been appointed to serve as the "
        "investment manager of the Fund, and which contemplates that an investment "
        "management agreement will be entered into between the Fund and the "
        "Investment Manager. All capitalized terms used in this Agreement and not "
        "otherwise defined herein shall have the meanings ascribed to them in the "
        "Limited Partnership Agreement. The parties agree that the relationship "
        "between the Fund and the Investment Manager shall be governed by the "
        "Limited Partnership Agreement in all respects, as supplemented by this "
        "Agreement. In the event of any conflict between this Agreement and the "
        "Limited Partnership Agreement, the Limited Partnership Agreement shall "
        "control.",
        BODY))

    # Recital C
    story.append(P(
        "<b>C.</b>&nbsp;&nbsp;The Fund desires to engage the Investment Manager to "
        "provide the services described in this Agreement, and the Investment "
        "Manager desires to accept such engagement, on the terms and conditions "
        "set forth in this Agreement.",
        BODY))

    # Recital D - Related-Party Disclosure
    story.append(P(
        "<b>D.</b>&nbsp;&nbsp;<b>Related-Party Disclosure and General Partner "
        "Approval.</b>&nbsp;&nbsp;The parties acknowledge that the Investment "
        "Manager, STT Capital Advisors LLC, is wholly owned by Scott R. McBrien, "
        "who also serves as a Manager and Co-Founder of the General Partner, "
        "PNTHR Funds, LLC. Cindy Eagar serves as the other Manager and Co-Founder "
        "of the General Partner and has no ownership or management role in the "
        "Investment Manager. The engagement of the Investment Manager by the Fund "
        "therefore constitutes a transaction between the Fund and an affiliate of "
        "the General Partner. The General Partner, acting on behalf of the Fund, "
        "has reviewed and approved this Agreement, including the Management Fee "
        "and the Performance Allocation described in the Limited Partnership "
        "Agreement, and has determined that the terms are fair and reasonable to "
        "the Fund and on terms no less favorable to the Fund than could reasonably "
        "be obtained from an unaffiliated third party providing comparable "
        "services. This related-party relationship is disclosed in Section VI "
        "(Management) and elsewhere in the PPM, and each Limited Partner is deemed "
        "to have notice of this relationship as a condition of admission to the "
        "Fund. This Agreement is entered into pursuant to, and is consistent with, "
        "Section 4.02 (Transactions with Affiliates) of the Limited Partnership "
        "Agreement.",
        BODY))

    # Agreement header
    story.append(P("<b>A G R E E M E N T</b>", SECTION_HDR))

    story.append(P(
        "NOW, THEREFORE, in consideration of the mutual covenants, terms and "
        "conditions contained in this Agreement, and for other good and valuable "
        "consideration, the receipt and sufficiency of which are hereby "
        "acknowledged, the parties, intending to be legally bound, agree as follows:",
        BODY))

    return story


# =========================================================================
# OPERATIVE SECTIONS 1 - 24
# =========================================================================
def build_operative():
    story = []

    # 1. Recitals
    story.extend(section("1", "Recitals",
        "The Recitals set forth above are true, complete and correct, accurately "
        "reflect the intentions of the parties, and are incorporated into and form "
        "a part of this Agreement by this reference."))

    # 2. Term
    story.extend(section("2", "Term",
        "The initial term of this Agreement shall commence on the date first "
        "written above and shall continue for a period of five (5) years (the "
        "&ldquo;Initial Term&rdquo;). Upon expiration of the Initial Term, this "
        "Agreement shall automatically renew for successive one (1) year periods "
        "(each, a &ldquo;Renewal Term&rdquo; and, together with the Initial Term, "
        "the &ldquo;Term&rdquo;), unless (a) either party delivers written notice "
        "of non-renewal to the other party not less than ninety (90) days prior to "
        "the expiration of the then-current Initial Term or Renewal Term, or "
        "(b) this Agreement is earlier terminated in accordance with Section 8. "
        "The Term shall be coterminous with the duration of the Partnership unless "
        "sooner terminated as provided herein."))

    # 3. Investment Manager's Duties
    story.append(P("<b>3.&nbsp;&nbsp;Investment Manager&rsquo;s Duties.</b>", H2))
    story.extend(subsection("3.1",
        "Subject to the oversight of the General Partner and to the terms of the "
        "Limited Partnership Agreement and the PPM, the business and affairs of "
        "the Fund shall be managed by the Investment Manager. The Investment "
        "Manager shall direct, manage and control the investment activities of "
        "the Fund and shall have full and complete authority, power and "
        "discretion to make any and all investment decisions and to take any and "
        "all actions that the Investment Manager, in its professional judgment, "
        "deems reasonably necessary or advisable to accomplish the investment "
        "objectives of the Fund described in the PPM, including (without "
        "limitation) selecting, acquiring, holding, disposing of and voting "
        "portfolio securities, placing orders for the execution of transactions "
        "with or through broker-dealers, and exercising all rights, powers, "
        "privileges and other incidents of ownership with respect to portfolio "
        "investments."))
    story.extend(subsection("3.2",
        "Without limiting the generality of Section 3.1, the Investment Manager "
        "shall have the powers and authority specified in Article IV of the "
        "Limited Partnership Agreement, or elsewhere in the Limited Partnership "
        "Agreement, in each case to the extent delegated to the Investment "
        "Manager by the General Partner."))
    story.extend(subsection("3.3",
        "The Investment Manager shall perform its duties in accordance with the "
        "investment strategy, investment restrictions and other parameters "
        "described in the PPM and the Limited Partnership Agreement, as the same "
        "may be amended or supplemented from time to time."))

    # 4. Management Fee and Performance Allocation
    story.extend(section("4", "Management Fee and Performance Allocation",
        "<b>(a) Management Fee.</b>&nbsp;&nbsp;In consideration of the services "
        "rendered by the Investment Manager under this Agreement, the Fund shall "
        "pay the Investment Manager a management fee (the &ldquo;Management "
        "Fee&rdquo;) equal to two percent (2.00%) per annum of the aggregate net "
        "asset value of the Capital Accounts of the Limited Partners as of the "
        "first day of each calendar quarter (after taking into account "
        "subscriptions and withdrawals effective as of such date, and before "
        "reduction for the Management Fee being calculated). The Management Fee "
        "shall be accrued monthly and shall be paid quarterly in advance on the "
        "first Business Day of each calendar quarter. For any partial calendar "
        "quarter (including the initial quarter in which a Limited Partner is "
        "admitted or the quarter in which a withdrawal occurs), the Management "
        "Fee shall be prorated based on the number of days in such quarter that "
        "the applicable capital was invested in the Fund. Any Management Fee "
        "paid in advance with respect to a Limited Partner that withdraws "
        "capital during a quarter shall be refunded to the Fund on a pro rata "
        "basis for the portion of the quarter following the effective date of "
        "such withdrawal. The Management Fee shall be further calculated, "
        "allocated and paid in the manner described in the Limited Partnership "
        "Agreement and the PPM, and the provisions of the Limited Partnership "
        "Agreement shall control in the event of any conflict.",
        "<b>(b) Fund Operating Expenses.</b>&nbsp;&nbsp;The Management Fee is "
        "intended to compensate the Investment Manager for its services and to "
        "fund the Investment Manager&rsquo;s ordinary and recurring operating "
        "expenses, including office and personnel expenses, hardware and "
        "software expenses attributable to signal generation and trade planning, "
        "and general overhead of the Investment Manager. The Fund shall bear "
        "only those expenses identified as Partnership expenses in the Limited "
        "Partnership Agreement and the PPM (including, without limitation, "
        "brokerage and execution costs, custodial and administrator fees, audit "
        "and tax preparation fees, legal fees, regulatory filing fees, and "
        "similar third-party expenses).",
        "<b>(c) Performance Allocation.</b>&nbsp;&nbsp;In addition to the "
        "Management Fee, the General Partner shall receive a special allocation "
        "of the net profits of the Fund (the &ldquo;Performance Allocation&rdquo;) "
        "at the times, in the amounts, and in the manner specified in Section "
        "8.01 of the Limited Partnership Agreement, subject to the quarterly "
        "Hurdle, the High Water Mark, and the Loss Recovery Account described "
        "therein. The Performance Allocation is received by the General Partner "
        "(and not by the Investment Manager) under the Limited Partnership "
        "Agreement.",
        "<b>(d) No Other Compensation.</b>&nbsp;&nbsp;Except as expressly "
        "provided in this Agreement, the Limited Partnership Agreement or the "
        "PPM, the Investment Manager shall not be entitled to receive any fee, "
        "commission, rebate or other compensation from the Fund or any Limited "
        "Partner in connection with the services rendered hereunder."))

    # 5. No Exclusive Duty
    story.extend(section("5", "Non-Exclusive Services; Other Activities",
        "The Investment Manager is not required to devote its services to the "
        "Fund on an exclusive basis and may have other clients, business "
        "interests and activities, including activities that are, or may be, "
        "competitive with the Fund, subject to the terms of the Limited "
        "Partnership Agreement (including Section 4.02 thereof regarding "
        "transactions with Affiliates) and subject to the Investment "
        "Manager&rsquo;s overall obligation to devote such time to the "
        "Fund&rsquo;s affairs as is reasonably necessary for the proper conduct "
        "of the Fund&rsquo;s business. Neither the Fund nor any Limited Partner "
        "shall, solely by reason of this Agreement, have any right to share or "
        "participate in any investments, income or proceeds derived from any "
        "such other activities of the Investment Manager. The Investment "
        "Manager shall allocate investment opportunities among the Fund and any "
        "other clients or accounts in a manner the Investment Manager believes, "
        "in good faith, to be fair and equitable over time and consistent with "
        "applicable law and its internal allocation policies."))

    # 6. Indemnity
    story.extend(section("6", "Indemnification",
        "The Investment Manager and its officers, managers, members, employees "
        "and agents shall be indemnified by the Fund as, and to the extent, "
        "provided in Section 4.03 of the Limited Partnership Agreement and to "
        "the fullest extent permitted by applicable law. The indemnification "
        "provisions of the Limited Partnership Agreement are incorporated by "
        "reference into this Agreement as if fully set forth herein."))

    # 7. Standard of Care; Limitation on Liability
    story.extend(section("7", "Standard of Care; Limitation on Liability",
        "<b>(a) Standard of Care.</b>&nbsp;&nbsp;The Investment Manager shall "
        "discharge its duties under this Agreement with the care, skill, "
        "prudence and diligence under the circumstances then prevailing that a "
        "prudent professional investment manager acting in a like capacity and "
        "familiar with matters of a similar nature would use.",
        "<b>(b) Limitation on Liability.</b>&nbsp;&nbsp;To the fullest extent "
        "permitted by applicable law, none of the Investment Manager or any of "
        "its members, managers, officers, employees or agents shall be liable "
        "to the Fund or to any Limited Partner for any loss or damage arising "
        "out of or in connection with the performance of services under this "
        "Agreement, except for loss or damage resulting from acts or omissions "
        "that constitute willful misconduct, fraud, gross negligence, or a "
        "knowing violation of law, in each case as finally determined by a "
        "court or arbitrator of competent jurisdiction. The Investment Manager "
        "has not guaranteed, and shall have no obligation with respect to, the "
        "return of any Limited Partner&rsquo;s Capital Contribution or the "
        "receipt of any distribution or profit from the Fund."))

    # 8. Termination
    story.append(P("<b>8.&nbsp;&nbsp;Termination.</b>", H2))
    story.extend(subsection("8.1",
        "<b>Termination by the Investment Manager.</b>&nbsp;&nbsp;The "
        "Investment Manager may terminate its obligation to perform services "
        "hereunder by resignation in accordance with the Limited Partnership "
        "Agreement upon not less than ninety (90) days&rsquo; prior written "
        "notice to the Fund and the General Partner."))
    story.extend(subsection("8.2",
        "<b>Termination by the Fund.</b>&nbsp;&nbsp;The Fund may terminate the "
        "engagement of the Investment Manager upon the removal of the Investment "
        "Manager in accordance with the Limited Partnership Agreement."))
    story.extend(subsection("8.3",
        "<b>Termination for Cause.</b>&nbsp;&nbsp;Either party may terminate "
        "this Agreement for Cause upon thirty (30) days&rsquo; prior written "
        "notice to the other party, provided that the terminating party shall "
        "give the other party a reasonable opportunity, not less than thirty "
        "(30) days from receipt of such notice, to cure the event or condition "
        "constituting Cause to the extent such event or condition is capable of "
        "being cured. &ldquo;Cause&rdquo; shall have the meaning ascribed to "
        "that term in the Limited Partnership Agreement, and where the term is "
        "not so defined shall mean: (i) a material breach of this Agreement or "
        "the Limited Partnership Agreement by the other party that remains "
        "uncured after the cure period; (ii) fraud, willful misconduct, gross "
        "negligence, or a knowing violation of law by the other party in "
        "connection with the Fund; (iii) a final, non-appealable judicial or "
        "regulatory determination that the other party has committed a material "
        "violation of applicable securities, commodities or investment adviser "
        "laws; or (iv) the bankruptcy, insolvency, dissolution or liquidation of "
        "the other party."))
    story.extend(subsection("8.4",
        "<b>Automatic Termination.</b>&nbsp;&nbsp;This Agreement shall "
        "terminate automatically, without further action by either party, upon "
        "the earliest to occur of: (a) the dissolution or liquidation of the "
        "Fund; (b) the removal, withdrawal, resignation, bankruptcy or "
        "dissolution of the General Partner without an approved successor in "
        "accordance with the Limited Partnership Agreement; or (c) the "
        "bankruptcy, dissolution or liquidation of the Investment Manager."))
    story.extend(subsection("8.5",
        "<b>Effect of Termination; Survival.</b>&nbsp;&nbsp;Upon termination of "
        "this Agreement, the Investment Manager shall be entitled to receive "
        "(i) any Management Fee accrued but unpaid through the effective date "
        "of termination, and (ii) any amounts due to it under Section 6 "
        "(Indemnification). Any Management Fee paid in advance for periods "
        "following the effective date of termination shall be refunded to the "
        "Fund on a pro rata basis. The provisions of Sections 1 (Recitals), "
        "4(d) (No Other Compensation, with respect to amounts earned before "
        "termination), 6 (Indemnification), 7 (Standard of Care; Limitation on "
        "Liability), 8.5 (Effect of Termination; Survival), 14 (Confidentiality), "
        "16 (Attorneys&rsquo; Fees and Dispute Resolution), 19 (Heirs, "
        "Successors and Assigns), 22 (Severability and Waiver), and 24 "
        "(Governing Law) shall survive any termination of this Agreement in "
        "accordance with their respective terms."))

    # 9. Assignment
    story.extend(section("9", "Assignment",
        "This Agreement is not assignable by either party, in whole or in "
        "part, without the prior written consent of the other party. Any "
        "purported assignment in violation of this Section 9 shall be void and "
        "of no force or effect. For purposes of this Section 9, "
        "&ldquo;assignment&rdquo; has the meaning ascribed to that term under "
        "the Investment Advisers Act of 1940, as amended, to the extent "
        "applicable, and otherwise has its ordinary meaning."))

    # 10. Fund's Covenants
    story.extend(section("10", "Fund&rsquo;s Covenants",
        "Without the prior written consent of the Investment Manager, which "
        "consent shall not be unreasonably withheld, conditioned or delayed, "
        "the Fund shall not amend the Limited Partnership Agreement in any "
        "manner that materially and adversely affects the rights, duties or "
        "compensation of the Investment Manager under this Agreement, or take "
        "any other action inconsistent with the terms and conditions of this "
        "Agreement."))

    # 11. Notices
    story.extend(section("11", "Notices",
        "Any notice, demand or other communication required or permitted to be "
        "given under this Agreement shall be in writing and shall be deemed "
        "duly given (a) when delivered personally to the party or to an "
        "executive officer of the party to whom the same is directed, "
        "(b) three (3) Business Days after being deposited in the United "
        "States mail, registered or certified, postage prepaid and return "
        "receipt requested, to the party&rsquo;s address set forth on the "
        "signature page of this Agreement (or to such other address as such "
        "party may designate by written notice to the other party), or "
        "(c) on the date of transmission by electronic mail to the last known "
        "email address of the party, provided that the sender does not receive "
        "a delivery-failure notification.",
        "Notices to the Investment Manager and to the Fund shall, in each "
        "case, be delivered to the address set forth in the signature page "
        "hereto or to <i>info@PNTHRfunds.com</i>, or to such other address or "
        "email address as the party may designate from time to time by written "
        "notice to the other party."))

    # 12. Regulatory Compliance
    story.extend(section("12", "Regulatory Compliance",
        "The Investment Manager shall perform its duties under this Agreement "
        "in compliance, in all material respects, with all applicable United "
        "States federal and state laws and regulations, including (without "
        "limitation) the Securities Act of 1933, the Securities Exchange Act "
        "of 1934, the Investment Company Act of 1940 (and available exemptions "
        "thereunder), the Investment Advisers Act of 1940 (to the extent "
        "applicable to the Investment Manager), applicable state investment "
        "adviser registration and exemption provisions, applicable rules of "
        "the Financial Industry Regulatory Authority (to the extent "
        "applicable), and applicable anti-money-laundering laws and "
        "regulations, including the Bank Secrecy Act, the USA PATRIOT Act, and "
        "the sanctions programs administered by the Office of Foreign Assets "
        "Control. The Investment Manager shall adopt and maintain a written "
        "compliance program reasonably designed to achieve compliance with "
        "such laws and regulations, and shall cooperate with the Fund, the "
        "General Partner, the Fund&rsquo;s administrator, and the Fund&rsquo;s "
        "auditor in connection with any regulatory examination, inquiry or "
        "filing relating to the Fund."))

    # 13. Books and Records
    story.extend(section("13", "Books and Records; Access",
        "The Investment Manager shall maintain books, records and accounts "
        "relating to the investment activities of the Fund and shall make "
        "them available to the Fund, the General Partner, the Fund&rsquo;s "
        "administrator, and the Fund&rsquo;s independent auditor upon "
        "reasonable notice during normal business hours for inspection and "
        "copying. All books and records relating to the Fund that are created "
        "or maintained by the Investment Manager shall be the property of the "
        "Fund and shall be retained by the Investment Manager in accordance "
        "with applicable law and the Investment Manager&rsquo;s record "
        "retention policy."))

    # 14. Confidentiality
    story.extend(section("14", "Confidentiality",
        "<b>(a) Investment Manager Confidential Information.</b>&nbsp;&nbsp;"
        "The Fund acknowledges that the Investment Manager&rsquo;s proprietary "
        "signal methodology, parameters, formulas, thresholds, weights, "
        "timeframes, code and related intellectual property (collectively, "
        "the &ldquo;Investment Manager IP&rdquo;) constitute confidential and "
        "proprietary information of the Investment Manager. Neither the Fund "
        "nor the General Partner shall have any right to receive, access, "
        "reverse-engineer, decompile, disassemble, copy or disclose the "
        "Investment Manager IP, and nothing in this Agreement or the Limited "
        "Partnership Agreement shall be construed to grant any such right.",
        "<b>(b) Fund Confidential Information.</b>&nbsp;&nbsp;The Investment "
        "Manager shall maintain the confidentiality of Non-Public Information "
        "(as defined in the Limited Partnership Agreement) of the Fund, the "
        "General Partner and the Limited Partners in accordance with Section "
        "16.13 (or such other numbered section) of the Limited Partnership "
        "Agreement relating to confidentiality.",
        "<b>(c) Permitted Disclosures.</b>&nbsp;&nbsp;Notwithstanding the "
        "foregoing, either party may disclose the existence of this Agreement, "
        "the identity of the other party, and the general nature of the "
        "services rendered hereunder (i) to its own professional advisors, "
        "(ii) in response to a subpoena, court order or regulatory or "
        "governmental request, (iii) as required by applicable law, and "
        "(iv) in the case of the Investment Manager, in connection with "
        "marketing the Fund consistent with the PPM and the Limited "
        "Partnership Agreement."))

    # 15. Force Majeure
    story.extend(section("15", "Force Majeure",
        "Neither party shall be liable to the other for any delay in, or "
        "failure of performance of, its obligations under this Agreement to "
        "the extent such delay or failure arises out of or results from "
        "events beyond its reasonable control, including (without limitation) "
        "acts of God, fire, flood, earthquake, pandemic, epidemic, war, "
        "terrorism, civil unrest, strike, labor dispute, governmental or "
        "regulatory action (including restrictions on trading or the closure "
        "of exchanges), failure or disruption of any securities exchange, "
        "clearing agency, prime broker, custodian, administrator or other "
        "service provider, failure of utilities, failure of internet or "
        "telecommunications service, and cyberattack or other information "
        "security incident (each, a &ldquo;Force Majeure Event&rdquo;), "
        "provided that the party affected by the Force Majeure Event takes "
        "commercially reasonable steps to mitigate the effects of such event "
        "and to resume performance of its obligations as soon as reasonably "
        "practicable."))

    # 16. Attorneys' Fees and Dispute Resolution
    story.extend(section("16", "Attorneys&rsquo; Fees and Dispute Resolution",
        "<b>(a) Arbitration.</b>&nbsp;&nbsp;Any dispute, claim or controversy "
        "arising out of or relating to this Agreement, or the breach, "
        "termination, enforcement, interpretation or validity thereof, shall "
        "be determined by binding arbitration administered by the American "
        "Arbitration Association (the &ldquo;AAA&rdquo;) in accordance with "
        "its Commercial Arbitration Rules then in effect. The arbitration "
        "shall be conducted by a single arbitrator selected from the AAA&rsquo;s "
        "roster of arbitrators in accordance with the AAA&rsquo;s rules. The "
        "place of arbitration shall be Wilmington, Delaware (or such other "
        "Delaware venue as the parties may agree in writing). The arbitrator "
        "shall apply the substantive law of the State of Delaware, without "
        "regard to its conflict-of-laws principles. The arbitrator shall have "
        "no authority to award punitive, exemplary, consequential, special or "
        "indirect damages. Judgment on the award rendered by the arbitrator "
        "may be entered in any court having jurisdiction thereof. The "
        "existence and content of the arbitration (including any award) shall "
        "be kept confidential by the parties and the arbitrator, except to "
        "the extent disclosure is required by applicable law or to enforce "
        "the award.",
        "<b>(b) Prevailing-Party Attorneys&rsquo; Fees.</b>&nbsp;&nbsp;In any "
        "arbitration or judicial proceeding commenced under or in connection "
        "with this Agreement, the prevailing party shall be entitled to "
        "recover from the non-prevailing party, in addition to all other "
        "relief to which the prevailing party may be entitled, all reasonable "
        "costs and expenses incurred in connection with the proceeding, "
        "including reasonable attorneys&rsquo; fees, expert-witness fees, and "
        "arbitration costs. If the arbitrator or court awards relief to both "
        "parties, such costs and fees shall be apportioned between the "
        "parties as the arbitrator or court determines in its discretion.",
        "<b>(c) Waiver of Jury Trial.</b>&nbsp;&nbsp;Each party hereby "
        "irrevocably waives any right to trial by jury in any action, "
        "proceeding or counterclaim arising out of or relating to this "
        "Agreement."))

    # 17. Entire Agreement
    story.extend(section("17", "Entire Agreement",
        "This Agreement, together with the Limited Partnership Agreement and "
        "the PPM, constitutes the entire agreement of the parties with "
        "respect to the subject matter hereof and supersedes all prior "
        "discussions, negotiations, understandings and agreements, whether "
        "oral or written, between the parties relating to such subject "
        "matter. No amendment, modification or waiver of this Agreement shall "
        "be effective unless in a writing signed by both parties."))

    # 18. Electronic Signatures
    story.extend(section("18", "Counterparts; Electronic Signatures",
        "This Agreement may be executed in any number of counterparts, each "
        "of which shall be deemed an original and all of which together shall "
        "constitute one and the same instrument. Signatures delivered by "
        "electronic transmission (including by PDF or a recognized electronic "
        "signature service) shall be deemed to have the same legal effect as "
        "original handwritten signatures and shall be effective under the "
        "federal Electronic Signatures in Global and National Commerce Act "
        "(E-SIGN) and the Delaware Uniform Electronic Transactions Act "
        "(UETA)."))

    # 19. Heirs, Successors and Assigns
    story.extend(section("19", "Heirs, Successors and Assigns",
        "Subject to Section 9 (Assignment), each and all of the covenants, "
        "terms, provisions and agreements contained in this Agreement shall "
        "be binding upon, and shall inure to the benefit of, the parties "
        "and, to the extent permitted by this Agreement, their respective "
        "heirs, legal representatives, successors and permitted assigns."))

    # 20. Construction
    story.extend(section("20", "Construction",
        "The parties acknowledge that each of them has reviewed this "
        "Agreement, and any rule of construction to the effect that "
        "ambiguities are to be resolved against the drafting party shall not "
        "apply to the interpretation of this Agreement. The rights and "
        "remedies described in this Agreement shall be in addition to, and "
        "not in lieu of, all other rights and remedies at law and in equity."))

    # 21. Severability and Waiver
    story.extend(section("21", "Severability and Waiver",
        "The invalidity or unenforceability of any provision of this "
        "Agreement shall in no way affect the validity or enforceability of "
        "any other provision hereof. Any waiver of any provision of this "
        "Agreement must be in writing and signed by the party against whom "
        "the waiver is sought to be enforced. The waiver by any party of a "
        "right provided in this Agreement shall not be deemed to be a "
        "continuing waiver of that right or a waiver of any other right, and "
        "no failure by any party to act on a default shall be deemed a "
        "waiver of such default."))

    # 22. Headings
    story.extend(section("22", "Headings",
        "The section captions and headings contained in this Agreement are "
        "inserted only for convenience of reference and shall not be used to "
        "interpret, expand, modify or limit the scope of the sections to "
        "which they refer."))

    # 23. Independent Contractor
    story.extend(section("23", "Independent Contractor",
        "The Investment Manager shall at all times be an independent "
        "contractor with respect to the Fund and shall not be considered an "
        "employee, joint venturer or partner of the Fund by reason of this "
        "Agreement."))

    # 24. Governing Law
    story.extend(section("24", "Governing Law",
        "This Agreement and its application, interpretation, validity, "
        "construction, performance and enforcement shall be governed "
        "exclusively by its terms and by the laws of the State of Delaware, "
        "without regard to its conflict-of-laws principles."))

    return story


# =========================================================================
# SIGNATURE PAGE
# =========================================================================
def build_signatures():
    story = []
    story.append(PageBreak())
    story.append(P("<b>SIGNATURE PAGE</b>", SECTION_HDR))
    story.append(spacer(8))

    story.append(P(
        "IN WITNESS WHEREOF, the parties have caused this Investment "
        "Management Agreement to be executed as of the date first written "
        "above by their respective officers or managers thereunto duly "
        "authorized.",
        BODY))

    story.append(spacer(24))

    # INVESTMENT MANAGER
    story.append(P("<b>INVESTMENT MANAGER:</b>", BODY))
    story.append(P("STT Capital Advisors LLC", BODY))
    story.append(P("a Delaware limited liability company", BODY))
    story.append(spacer(28))
    story.append(P("By: _________________________________________", BODY))
    story.append(P("Name:  Scott R. McBrien", BODY))
    story.append(P("Title:  Manager", BODY))
    story.append(spacer(6))
    story.append(P("Address:  15150 W Park Place, Suite 215", BODY))
    story.append(P("&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
                   "Goodyear, Arizona 85395", BODY))
    story.append(P("Email:  info@PNTHRfunds.com", BODY))
    story.append(P("Phone:  602-810-1940", BODY))

    story.append(spacer(36))

    # FUND
    story.append(P("<b>FUND:</b>", BODY))
    story.append(P("PNTHR Tree Fund, LP", BODY))
    story.append(P("a Delaware limited partnership", BODY))
    story.append(spacer(10))
    story.append(P("By:  PNTHR Funds, LLC, its General Partner", BODY))
    story.append(spacer(24))
    story.append(P("By: _________________________________________", BODY))
    story.append(P("Name:  Scott R. McBrien", BODY))
    story.append(P("Title:  Manager", BODY))
    story.append(spacer(18))
    story.append(P("By: _________________________________________", BODY))
    story.append(P("Name:  Cindy Eagar", BODY))
    story.append(P("Title:  Manager", BODY))
    story.append(spacer(6))
    story.append(P("Address:  15150 W Park Place, Suite 215", BODY))
    story.append(P("&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"
                   "Goodyear, Arizona 85395", BODY))
    story.append(P("Email:  info@PNTHRfunds.com", BODY))
    story.append(P("Phone:  602-810-1940", BODY))

    return story


# =========================================================================
# MAIN
# =========================================================================
def build():
    doc = make_doc_template(
        OUT_PATH,
        title_meta="PNTHR Tree Fund, LP - Investment Management Agreement v1.0",
        subject="Investment Management Agreement",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Investment Management Agreement",
        doc_date_display="June 2026",
        fund_name="PNTHR Tree Fund",
        fund_name_upper="PNTHR TREE FUND",
    )
    story = []
    story.extend(build_cover())
    story.extend(build_legend())
    story.extend(build_preamble())
    story.extend(build_operative())
    story.extend(build_signatures())

    doc.build(story, onFirstPage=on_cover, onLaterPages=on_page)
    print(f"PDF generated: {OUT_PATH}")


if __name__ == "__main__":
    build()
