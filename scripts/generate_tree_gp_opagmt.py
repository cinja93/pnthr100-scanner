#!/usr/bin/env python3
"""
PNTHR Funds, LLC
Operating Agreement v1.0 — Tree Fund
Effective: June 1, 2026

Adapted from generate_gp_opagmt_v25.py (Carnivore v2.5).

Changes from Carnivore v2.5:
  - Fund name: "Carnivore Quant Fund" -> "PNTHR Tree Fund" throughout
  - Fund effective/PPM/IMA dates: June 1, 2025 -> June 1, 2026
  - Version: v2.5 -> v1.0
  - Footer breadcrumbs: TREE FUND / June 2026
  - Cover issuer line: General Partner of PNTHR Tree Fund, LP
  - LLC formation date (January 30, 2025) unchanged (same entity)

Output: ~/Downloads/PNTHR_Tree_Fund_GP_OpAgmt_v1.0_2026.pdf
"""

import os
from reportlab.lib.pagesizes import letter
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import Paragraph, Spacer, PageBreak, Table, TableStyle
from reportlab.lib import colors

from pnthr_design import (
    TITLE_STYLE, SUBTITLE_STYLE, H2, BODY, BODY_INDENT, COVER_NOTICE,
    make_doc_template, make_page_handlers, build_cover_header,
)

OUT_PATH = os.path.expanduser("~/Downloads/PNTHR_Tree_Fund_GP_OpAgmt_v1.0_2026.pdf")

ARTICLE_HDR = ParagraphStyle(
    name="article_hdr", fontName="Helvetica-Bold", fontSize=13, leading=16,
    alignment=TA_LEFT, spaceBefore=18, spaceAfter=8,
)

def P(text, style=BODY):
    return Paragraph(text, style)

def spacer(h=10):
    return Spacer(1, h)

def article_hdr(roman, title_caps):
    return P(f"<b>{roman}.&nbsp;&nbsp;{title_caps}</b>", ARTICLE_HDR)

def section(num, title, *paragraphs):
    out = [P(f"<b>{num}.&nbsp;&nbsp;<u>{title}</u>.</b>", H2)]
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
        title_line_1="PNTHR FUNDS, LLC",
        title_line_2="OPERATING AGREEMENT",
        subtitle="A Delaware Limited Liability Company",
        date_line="Dated as of:  June 1, 2026",
        revision_line="Document Revision:  v1.0 - June 2026",
        issuer_line="Company:  PNTHR Funds, LLC (General Partner of PNTHR Tree Fund, LP)",
        confidential_title=None,
        confidential_body=None,
    )


def build_legend():
    from pnthr_design import COVER_NOTICE as TPL_COVER_NOTICE
    story = []
    story.append(P(
        "THIS OPERATING AGREEMENT CONTAINS CONFIDENTIAL INFORMATION RELATING TO "
        "PNTHR FUNDS, LLC (THE &ldquo;COMPANY&rdquo;), WHICH SERVES AS THE GENERAL "
        "PARTNER OF PNTHR Tree Fund, LP. THIS AGREEMENT MAY NOT "
        "BE REPRODUCED OR DISCLOSED TO ANY PERSON WITHOUT THE PRIOR WRITTEN "
        "CONSENT OF THE MEMBERS.",
        TPL_COVER_NOTICE))
    story.append(PageBreak())
    return story


# =========================================================================
# PREAMBLE + WITNESSETH
# =========================================================================
def build_preamble():
    story = []
    story.append(P("<b>OPERATING AGREEMENT</b>", TITLE_STYLE))
    story.append(P("PNTHR FUNDS, LLC", SUBTITLE_STYLE))
    story.append(P("A Delaware Limited Liability Company", SUBTITLE_STYLE))
    story.append(spacer(10))

    story.append(P(
        "THIS OPERATING AGREEMENT (this &ldquo;Operating Agreement&rdquo; or "
        "&ldquo;Agreement&rdquo;) is made and entered into as of June 1, 2026 by "
        "and among <b>PNTHR Funds, LLC</b>, a Delaware limited liability company "
        "(the &ldquo;Company&rdquo;), and the persons executing this Operating "
        "Agreement as Members of the Company and all of those who shall hereafter "
        "be admitted as Members (individually, a &ldquo;Member&rdquo; and "
        "collectively, the &ldquo;Members&rdquo;) whose names and signatures shall "
        "appear on <i>Exhibit A (Member Listing; Capital and Other Contributions)</i> "
        "below.",
        BODY))

    story.append(P("<b>WITNESSETH:</b>", H2))

    story.append(P(
        "<b>1.</b>&nbsp;&nbsp;WHEREAS, the Members desire to enter into this "
        "Operating Agreement for the purposes of governing the Company, which "
        "has been formed to act as the General Partner of <b>PNTHR FUNDS, "
        "PNTHR Tree Fund, LP</b>, a Delaware limited partnership (the "
        "&ldquo;Fund&rdquo;), pursuant to the Limited Partnership Agreement of "
        "the Fund effective as of June 1, 2026, as amended from time to time "
        "(the &ldquo;Limited Partnership Agreement&rdquo;). The Company shall "
        "not conduct any other business unless related to the foregoing or "
        "unless approved by unanimous consent of all Members.",
        BODY))

    story.append(P(
        "<b>2.</b>&nbsp;&nbsp;WHEREAS, the Members intend to operate the "
        "Company, serve in the capacity of managers of the Company (each, a "
        "&ldquo;Manager&rdquo;), and provide for the restriction on the "
        "transfers of ownership interests in the Company (&ldquo;Interests&rdquo;).",
        BODY))

    story.append(P(
        "NOW, THEREFORE, in consideration of the mutual premises below, and "
        "for other good and valuable consideration, the receipt and sufficiency "
        "of which are hereby acknowledged, it is agreed as follows:",
        BODY))

    return story


# =========================================================================
# ARTICLE I - ORGANIZATION
# =========================================================================
def build_article_i():
    story = []
    story.append(article_hdr("I", "ORGANIZATION"))

    story.extend(section("1", "Formation",
        "The Company was organized as a limited liability company in the State "
        "of Delaware on January 30, 2025 by the filing of a Certificate of "
        "Formation (the &ldquo;Certificate of Formation&rdquo;) with the "
        "Secretary of State of the State of Delaware pursuant to the Delaware "
        "Limited Liability Company Act, as amended (the &ldquo;Delaware Act&rdquo;)."))

    story.extend(section("2", "Name",
        "The name of the Company shall be &ldquo;PNTHR Funds, LLC.&rdquo; The "
        "Company may also conduct its business under one or more assumed names."))

    story.extend(section("3", "Purpose",
        "The primary purpose of the Company is to serve as the sole General "
        "Partner of the Fund pursuant to the Limited Partnership Agreement and "
        "the Private Placement Memorandum of the Fund dated June 1, 2026, as "
        "amended and supplemented from time to time (the &ldquo;PPM&rdquo;). In "
        "furtherance of this purpose, the Company may (a) enter into, execute, "
        "deliver and perform any agreements, instruments and documents related "
        "to its service as General Partner; (b) delegate portfolio management "
        "authority to STT Capital Advisors LLC (the &ldquo;Investment "
        "Manager&rdquo;) pursuant to the Investment Management Agreement between "
        "the Fund and the Investment Manager dated June 1, 2026, as amended from "
        "time to time (the &ldquo;Investment Management Agreement&rdquo;); "
        "(c) receive Management Fees and Performance Allocations as and when "
        "payable under the Limited Partnership Agreement; and (d) engage in any "
        "other lawful activity for which a Delaware limited liability company "
        "may be formed under the Delaware Act, provided such activity is "
        "reasonably incident to, or in furtherance of, the foregoing primary "
        "purpose. The Company shall have all the powers necessary or convenient "
        "to effect any purpose for which it is formed, including all powers "
        "granted by the Delaware Act."))

    story.extend(section("4", "Duration",
        "The Company shall continue in existence in perpetuity until dissolved "
        "and wound up in accordance with the provisions of this Operating "
        "Agreement or the Delaware Act."))

    story.extend(section("5", "Registered Office and Resident Agent",
        "The principal office of the Company shall be 15150 W Park Place, "
        "Suite 215, Goodyear, Arizona 85395, or such other location as the "
        "Managers may designate from time to time. The Registered Office of the "
        "Company in the State of Delaware, and the Resident Agent of the "
        "Company at such Registered Office, shall be Harvard Business Services, "
        "Inc., 16192 Coastal Highway, Lewes, Delaware 19958, telephone "
        "1-800-345-2677, or such other Registered Office and Resident Agent as "
        "the Managers may designate from time to time in accordance with the "
        "Delaware Act. If the Resident Agent shall ever resign, the Members "
        "shall designate a successor Resident Agent by unanimous vote."))

    story.extend(section("6", "Intention for Company",
        "The Members have organized the Company as a limited liability company "
        "under and pursuant to the Delaware Act. The Members specifically intend "
        "and agree that the Company shall not be, for any legal purposes, a "
        "partnership (including a limited partnership) or any other venture, but "
        "shall be a limited liability company under and pursuant to the Delaware "
        "Act, desiring partnership tax treatment for U.S. federal income tax "
        "purposes. No Member or Manager shall be construed to be a partner in "
        "the Company or a partner of any other Member, Manager, or person; and "
        "the Certificate of Formation, this Operating Agreement, and the "
        "relationships created thereby and arising therefrom shall not be "
        "construed to suggest otherwise."))

    return story


# =========================================================================
# ARTICLE II - BOOKS, RECORDS AND ACCOUNTING
# =========================================================================
def build_article_ii():
    story = []
    story.append(article_hdr("II", "BOOKS, RECORDS AND ACCOUNTING"))

    story.extend(section("1", "Books and Records",
        "The Company shall maintain complete and accurate books and records of "
        "the Company&rsquo;s business and affairs as required by the Delaware "
        "Act, and such books and records shall be kept at the Company&rsquo;s "
        "principal office. Members shall have the right to examine such books "
        "and records, in person or through an authorized representative, upon "
        "ten (10) days&rsquo; prior written notice during normal business hours."))

    story.extend(section("2", "Fiscal Year; Accounting",
        "The Company&rsquo;s fiscal year shall be the calendar year. The "
        "particular accounting methods and principles to be followed by the "
        "Company shall be selected by the accountant for the Company (the "
        "&ldquo;Accountant&rdquo;). The Accountant may be designated and "
        "subsequently changed by written notice of the then-serving Manager, "
        "consented to in writing by the unanimous consent of the Members."))

    story.extend(section("3", "Audit",
        "The Company&rsquo;s annual financial statements for each prior year "
        "may be audited by a certified public accounting firm at the election "
        "of the Members."))

    story.extend(section("4", "Reports",
        "The Managers shall provide reports concerning the financial condition "
        "and results of operations of the Company not less frequently than "
        "once per calendar quarter. Such reports shall include a statement of "
        "each Member&rsquo;s share of profits and other items of income, gain, "
        "loss, deduction and credit."))

    return story


# =========================================================================
# ARTICLE III - CAPITAL AND OTHER CONTRIBUTIONS
# =========================================================================
def build_article_iii():
    story = []
    story.append(article_hdr("III", "CAPITAL AND OTHER CONTRIBUTIONS"))

    story.extend(section("1", "Initial Commitments and Contributions",
        "By the execution of this Operating Agreement, the initial Members "
        "hereby agree to make the capital and other contributions set forth on "
        "Exhibit A attached hereto. The interests of the respective Members in "
        "the total capital of the Company (their respective &ldquo;Sharing "
        "Ratios,&rdquo; as adjusted from time to time to reflect additional "
        "Members and changes in the total capital of the Company) are also set "
        "forth on Exhibit A. Any additional Member (other than an assignee of a "
        "Membership Interest who has been admitted as a Member) will result in "
        "the modification of the Sharing Ratios pursuant to the unanimous "
        "agreement of the Members."))

    return story


# =========================================================================
# ARTICLE IV - ALLOCATIONS AND DISTRIBUTIONS
# =========================================================================
def build_article_iv():
    story = []
    story.append(article_hdr("IV", "ALLOCATIONS AND DISTRIBUTIONS"))

    story.extend(section("1", "Allocations",
        "Except as may be required by the Internal Revenue Code, as amended "
        "(the &ldquo;Code&rdquo;), or this Operating Agreement, net profits, "
        "net losses, and other items of income, gain, loss, deduction and "
        "credit of the Company shall be allocated among the Members in "
        "accordance with their Sharing Ratios. Members shall not be entitled "
        "to wages."))

    story.extend(section("2", "Distributions",
        "The Managers may make distributions to the Members from time to time. "
        "Distributions may be made only after the Managers determine in their "
        "reasonable judgment that the Company has sufficient cash on hand "
        "which exceeds the current and anticipated needs of the Company to "
        "fulfill its business purposes for, at minimum, three (3) months "
        "(including needs for operating expenses, debt service, acquisitions, "
        "reserves, and mandatory distributions, if any). All distributions "
        "shall be made to the Members in accordance with their Sharing Ratios. "
        "Distributions shall be in cash or property or partly in both, as "
        "determined by the Managers. No distribution shall be declared or made "
        "if, after giving it effect, the Company would not be able to pay its "
        "debts as they become due in the usual course of business, or the "
        "Company&rsquo;s total assets would be less than the sum of its total "
        "liabilities plus the amount that would be needed, if the Company were "
        "to be dissolved at the time of the distribution, to satisfy the "
        "preferential rights of other Members upon dissolution that are "
        "superior to the rights of the Members receiving the distribution."))

    return story


# =========================================================================
# ARTICLE V - DISPOSITION OF MEMBERSHIP INTERESTS
# =========================================================================
def build_article_v():
    story = []
    story.append(article_hdr("V", "DISPOSITION OF MEMBERSHIP INTERESTS"))

    story.extend(section("1", "General",
        "Every sale, assignment, transfer, exchange, mortgage, pledge, grant, "
        "hypothecation or other disposition of any Membership Interest shall "
        "be made only upon compliance with this Article. No Membership "
        "Interest shall be disposed of if the disposition would cause a "
        "termination of the Company under Section 708 of the Code; without "
        "compliance with any and all applicable state and federal securities "
        "laws and regulations; and unless the assignee of the Membership "
        "Interest provides the Company with the information and agreements "
        "that the Managers may require in connection with such disposition, "
        "including but not limited to an executed counterpart of this "
        "Agreement.",
        "No Member shall be entitled to assign, convey, sell, encumber, or in "
        "any way alienate all or any part of its Membership Interest in the "
        "Company as a Member except with the prior written consent of a "
        "majority in interest of the non-transferring Members, which consent "
        "may be given or withheld, conditioned, or delayed (as allowed by this "
        "Agreement or the Delaware Act), as the non-transferring Members may "
        "determine in their sole discretion. Transfers in violation of this "
        "provision shall only be effective to the extent of an assignment of "
        "such interest with only rights set forth in the following provision "
        "&ldquo;Permitted Dispositions.&rdquo;"))

    story.extend(section("2", "Permitted Dispositions",
        "Subject to the provisions of this Article, a Member may assign such "
        "Member&rsquo;s Membership Interest in the Company in whole or in "
        "part. The assignment of a Membership Interest does not in itself "
        "entitle the assignee to participate in the management and affairs of "
        "the Company or to become a Member. Such assignee is only entitled to "
        "receive, to the extent assigned, the distributions the assigning "
        "Member would otherwise be entitled to, and such assignee shall only "
        "become an assignee of a Membership Interest and not a substitute "
        "Member."))

    story.extend(section("3", "Right of First Refusal",
        "Members shall have the right to purchase an assigning Member&rsquo;s "
        "interest in the Company at a price approved by the unanimous consent "
        "of the Members, including the assigning Member&rsquo;s consent, or, "
        "in the alternative, the Members or a Member shall have the first "
        "right to purchase an assigning Member&rsquo;s interest at a price "
        "equal to the assigning Member&rsquo;s pro rata share of two times the "
        "prior calendar year&rsquo;s profits, less thirty-five percent (35%)."))

    story.extend(section("4", "Admission of Substitute Members",
        "An assignee of a Membership Interest shall be admitted as a substitute "
        "Member and shall be entitled to all the rights and powers of the "
        "assignee only if the other Members unanimously consent. If admitted, "
        "the substitute Member has, to the extent assigned, all of the rights "
        "and powers, and is subject to all of the restrictions and liabilities, "
        "of a Member."))

    return story


# =========================================================================
# ARTICLE VI - MEETINGS OF MEMBERS
# =========================================================================
def build_article_vi():
    story = []
    story.append(article_hdr("VI", "MEETINGS OF MEMBERS"))

    story.extend(section("1", "Voting",
        "Except to the extent provided to the contrary in this Agreement, all "
        "Members shall be entitled to vote on any matter submitted to a vote "
        "of the Members."))

    story.extend(section("2", "Required Vote",
        "Unless a greater vote is required by the Delaware Act, the "
        "Certificate of Formation, or this Operating Agreement, the "
        "affirmative vote or consent of a majority of the Sharing Ratios of "
        "all Members entitled to vote or consent on such matter shall be "
        "required."))

    story.extend(section("3", "Meetings",
        "No annual meeting of Members shall be required. Special meetings of "
        "Members for any proper purpose or purposes may be called at any time "
        "by any Manager or by the holders of at least fifty percent (50%) of "
        "the Sharing Ratios of all Members. The Company shall deliver or mail "
        "written Notice stating the date, time, place, and purposes of any "
        "meeting to each Member entitled to vote at the meeting. Such Notice "
        "shall be given not less than ten (10) and no more than sixty (60) "
        "days before the date of the meeting. All meetings of Members shall "
        "be presided over by a Chairperson who shall be a Manager. A Member "
        "may participate and vote at such meeting via telephone, video "
        "conference, or other electronic means permitting simultaneous audio "
        "communication."))

    story.extend(section("4", "Consent",
        "Any action required or permitted to be taken at an annual or special "
        "meeting of the Members may be taken without a meeting, without prior "
        "Notice, and without a vote, if consents in writing, setting forth "
        "the action so taken, are signed by the Members having not less than "
        "the minimum number of votes that would be necessary to authorize or "
        "take action were present and voted. Every written consent shall bear "
        "the date and signature of each Member who signs the consent. Prompt "
        "Notice of the taking of action without a meeting by less than "
        "unanimous written consent shall be given to all Members who have not "
        "consented in writing to such action."))

    return story


# =========================================================================
# ARTICLE VII - MANAGEMENT
# =========================================================================
def build_article_vii():
    story = []
    story.append(article_hdr("VII", "MANAGEMENT"))

    story.extend(section("1", "Management of Business",
        "The Company shall be managed by <b>Scott R. McBrien</b> and <b>Cindy "
        "Eagar</b>, each of whom shall serve as a Manager and together shall "
        "be the &ldquo;Co-Managers,&rdquo; so long as they are able and "
        "willing to serve. In the event Scott R. McBrien and Cindy Eagar "
        "deem, in their sole discretion, a conflict of interest to occur in a "
        "specific transaction, the majority of the Members shall be empowered "
        "to appoint a new Manager or a person to act as Manager for the "
        "limited purposes of that action.",
        "If either Scott R. McBrien or Cindy Eagar shall ever resign, become "
        "incapacitated, die, or be unable or unwilling to serve as Manager, "
        "the remaining Manager (or, if none, the Members) shall designate a "
        "new Manager by unanimous consent. The parties acknowledge that any "
        "such change in Manager may also trigger consequences under the "
        "Limited Partnership Agreement, including (without limitation) the "
        "Principal successor-approval mechanics set forth in Sections 2.13A(c) "
        "and 4.09(c) of the Limited Partnership Agreement, and the Key Person "
        "Event provisions set forth in Section 4.04 of the Limited "
        "Partnership Agreement. The terms, duties, compensation, and benefits, "
        "if any, of the Managers and Members shall be as set forth in this "
        "Article VII.",
        "<b>(a) <u>Managers</u>.</b>&nbsp;&nbsp;The duties of the Managers "
        "shall be those duties reasonably necessary to conduct the business "
        "of the Company, and shall include, but not be limited to, managing "
        "the Company&rsquo;s role as General Partner of the Fund, overseeing "
        "the Investment Management Agreement, managing relationships with "
        "Fund service providers (including the prime broker, administrator, "
        "and auditor), maintaining good supplier and Limited Partner "
        "relations, and conducting the Company&rsquo;s ordinary operations. "
        "The Managers shall be entitled to profits subject to their Sharing "
        "Ratios."))

    story.extend(section("2", "Removal of Manager",
        "Any Manager or employee may be removed at any time, with or without "
        "cause, by the unanimous vote of all Members. Any removal of a "
        "Manager that also causes a removal or withdrawal of the Company as "
        "General Partner of the Fund shall be subject to, and governed by, "
        "Section 4.09 of the Limited Partnership Agreement."))

    story.append(P("<b>3.&nbsp;&nbsp;<u>General Powers of Managers</u>.</b>", H2))
    story.append(P(
        "Except as may otherwise be provided in this Operating Agreement, the "
        "ordinary and usual decisions concerning the business and affairs of "
        "the Company shall be made by the Managers, including:",
        BODY))
    for (letter_label, text) in [
        ("a", "Purchase or lease equipment reasonably necessary to operate and expand the business;"),
        ("b", "Open one or more depository accounts and make deposits into, "
              "and checks and withdrawals against, such accounts;"),
        ("c", "Borrow money, incur liabilities, and other obligations, subject "
              "to the Limitations set forth in Section 4 below;"),
        ("d", "Enter into any and all agreements and execute any and all "
              "contracts, documents, and instruments relating to the business "
              "of the Company, including the Limited Partnership Agreement, "
              "the Investment Management Agreement, and agreements with Fund "
              "service providers;"),
        ("e", "Hire employees and engage consultants and agents, define their "
              "respective duties and establish their compensation or "
              "remuneration;"),
        ("f", "Obtain insurance covering the business and affairs of the "
              "Company and its name, including directors&rsquo; and "
              "officers&rsquo; liability coverage and professional liability "
              "coverage;"),
        ("g", "Participate with others in partnerships, joint ventures, and "
              "other associations and strategic alliances only where same are "
              "directly in pursuit of the business of the Company; and"),
        ("h", "Cause the Company, in its capacity as General Partner of the "
              "Fund, to exercise all rights, powers, privileges and "
              "obligations granted to it under the Limited Partnership "
              "Agreement."),
    ]:
        story.append(P(f"<b>({letter_label})</b>&nbsp;&nbsp;{text}", BODY_INDENT))

    story.append(P("<b>4.&nbsp;&nbsp;<u>Limitations</u>.</b>", H2))
    story.append(P(
        "Notwithstanding the foregoing and any other provision contained in "
        "this Operating Agreement to the contrary, no act shall be taken, sum "
        "expended, decision made, obligation incurred, or power exercised by "
        "any Manager on behalf of the Company except by the unanimous consent "
        "of all Membership Interests with respect to:",
        BODY))
    for (letter_label, text) in [
        ("a", "Any significant and material purchase (over $25,000), receipt, "
              "lease, exchange, or other acquisition of any real or personal "
              "property or business other than acts enabled by Section 3 of "
              "this Article VII;"),
        ("b", "The sale of all or substantially all of the assets and property "
              "of the Company; any mortgage, grant of security interest, "
              "pledge, or encumbrance upon all or substantially all of the "
              "assets and property of the Company;"),
        ("c", "Any merger, consolidation, conversion, division, or similar "
              "fundamental corporate transaction involving the Company;"),
        ("d", "Any amendment or restatement of the Certificate of Formation "
              "or of this Operating Agreement;"),
        ("e", "Any matter which could result in a change in the amount or "
              "character of the Company&rsquo;s capital or outstanding units;"),
        ("f", "Any change in the character of the business and affairs of the "
              "Company;"),
        ("g", "The commission of any act which would make it impossible for "
              "the Company to carry on its ordinary business and affairs;"),
        ("h", "Any act that would contravene any provision of the Certificate "
              "of Formation or of this Operating Agreement or the Delaware "
              "Act;"),
        ("i", "Issuance of additional member units beyond the 25,000 units at "
              "a par value of $1,000 per unit issued in conjunction with this "
              "Operating Agreement; and"),
        ("j", "Any voluntary withdrawal, resignation, or removal of the "
              "Company as General Partner of the Fund, or any amendment of "
              "the Limited Partnership Agreement or Investment Management "
              "Agreement that would materially and adversely affect the "
              "Company or its Members."),
    ]:
        story.append(P(f"<b>({letter_label})</b>&nbsp;&nbsp;{text}", BODY_INDENT))

    story.extend(section("5", "Standard of Care",
        "Every Manager shall discharge its duties as a Manager in good faith, "
        "with the care an ordinary prudent person in a like position would "
        "exercise under similar circumstances, and in a manner the Manager "
        "reasonably believes to be in the best interests of the Company. A "
        "Manager shall not be liable for any monetary damages to the Company "
        "for any breach of such duties except for: (a) receipt of a financial "
        "benefit to which the Manager is not entitled; (b) voting for or "
        "assenting to a distribution to Members in violation of this "
        "Operating Agreement or the Delaware Act; or (c) a knowing violation "
        "of law."))

    return story


# =========================================================================
# ARTICLE VIII - EXCULPATION; INDEMNIFICATION
# =========================================================================
def build_article_viii():
    story = []
    story.append(article_hdr("VIII", "EXCULPATION OF LIABILITY; INDEMNIFICATION"))

    story.extend(section("1", "Exculpation of Liability",
        "Unless otherwise provided by law or expressly assumed, a person who "
        "is a Member or Manager, or both, shall not be liable for the acts, "
        "debts or liabilities of the Company."))

    story.extend(section("2", "Indemnification",
        "Except as otherwise provided in this Article, the Company shall "
        "indemnify any Manager and may indemnify any employee or agent of the "
        "Company who was or is a party or is threatened to be made a party to "
        "a threatened, pending or completed action, suit or proceeding, "
        "whether civil, criminal, administrative, or investigative, and "
        "whether formal or informal, other than an action by or in the right "
        "of the Company, by reason of the fact that such person is or was a "
        "Manager, employee, or agent of the Company, against expenses "
        "(including attorneys&rsquo; fees), judgments, penalties, fines, and "
        "amounts paid in settlement actually and reasonably incurred by such "
        "person in connection with the action, suit or proceeding, if the "
        "person acted in good faith, with the care an ordinary prudent person "
        "in a like position would exercise under similar circumstances, in a "
        "manner that such person reasonably believed to be in the best "
        "interests of the Company, and with respect to a criminal action or "
        "proceeding, if such person had no reasonable cause to believe such "
        "person&rsquo;s conduct was unlawful.",
        "To the extent that a Member, Manager, employee, or agent of the "
        "Company has been successful on the merits or otherwise in defense of "
        "an action, suit, or proceeding or in the defense of any claim, "
        "issue, or other matter in the action, suit, or proceeding, such "
        "person shall be indemnified against actual and reasonable expenses, "
        "including attorneys&rsquo; fees, incurred by such person in "
        "connection with the action, suit, or proceeding and any action, suit "
        "or proceeding brought to enforce the mandatory indemnification "
        "provided herein. Any indemnification permitted under this Article, "
        "unless ordered by a court, shall be made by the Company only as "
        "authorized in the specific case upon a determination that the "
        "indemnification is proper under the circumstances because the person "
        "to be indemnified has met the applicable standard of conduct and "
        "upon an evaluation shall be made by a majority vote of the Members "
        "who are not parties or threatened to be made parties to the action, "
        "suit, or proceeding. Notwithstanding the foregoing, no "
        "indemnification shall be provided to any Manager, employee, or agent "
        "of the Company for or in connection with the receipt of a financial "
        "benefit to which such person is not entitled, voting for or "
        "assenting to a distribution to Members in violation of this "
        "Operating Agreement or the Delaware Act, or a knowing violation of "
        "law."))

    story.extend(section("3", "Advancement of Expenses",
        "The Company shall pay or reimburse expenses (including reasonable "
        "attorneys&rsquo; fees) incurred by a Manager who is a party to a "
        "proceeding in advance of final disposition of the proceeding, "
        "provided that (a) the Manager furnishes the Company with a written "
        "affirmation of such Manager&rsquo;s good faith belief that he or "
        "she has met the applicable standard of conduct set forth in Section "
        "2 above, and (b) the Manager furnishes the Company with a written "
        "undertaking, executed personally or on such Manager&rsquo;s behalf, "
        "to repay the advance if it is ultimately determined that such "
        "Manager did not meet the applicable standard of conduct. The "
        "undertaking required by clause (b) must be an unlimited general "
        "obligation of the Manager but need not be secured and may be "
        "accepted without reference to the Manager&rsquo;s financial ability "
        "to make repayment. The Company may, in the discretion of the "
        "non-party Members, pay or reimburse expenses incurred by any "
        "employee or agent of the Company in advance of final disposition of "
        "a proceeding on the same terms and conditions as apply to a Manager."))

    story.extend(section("4", "Non-Exclusivity",
        "The indemnification and advancement of expenses provided by, or "
        "granted pursuant to, this Article shall not be deemed exclusive of "
        "any other rights to which those seeking indemnification or "
        "advancement of expenses may be entitled under any agreement, vote "
        "of Members, or otherwise. The Company may maintain insurance, at "
        "its expense, to protect itself and any Manager, Member, employee, "
        "or agent of the Company against any expense, liability, or loss, "
        "whether or not the Company would have the power to indemnify such "
        "person against such expense, liability, or loss under the Delaware "
        "Act."))

    return story


# =========================================================================
# ARTICLE IX - OTHER ACTIVITIES
# =========================================================================
def build_article_ix():
    story = []
    story.append(article_hdr("IX", "OTHER ACTIVITIES"))

    story.append(P(
        "Any Member and the Manager may engage in other business ventures of "
        "every nature, except the ownership of another business similar to "
        "that operated by the Company. Neither the Company nor any of the "
        "other Members shall have any right or interest in any such "
        "independent venture or to the income and profits derived therefrom.",
        BODY))

    return story


# =========================================================================
# ARTICLE X - DISSOLUTION AND WINDING UP
# =========================================================================
def build_article_x():
    story = []
    story.append(article_hdr("X", "DISSOLUTION AND WINDING UP"))

    story.append(P("<b>1.&nbsp;&nbsp;<u>Dissolution</u>.</b>", H2))
    story.append(P(
        "The Company shall dissolve and its affairs shall be wound up on the "
        "first to occur of the following events:",
        BODY))
    for (letter_label, text) in [
        ("a", "At any time specified in the Certificate of Formation or this "
              "Operating Agreement;"),
        ("b", "Upon the happening of any event specified in the Certificate of "
              "Formation or this Operating Agreement; upon the unanimous "
              "consent of all Members;"),
        ("c", "Upon the death, withdrawal, expulsion, bankruptcy, or "
              "dissolution of a Member or the occurrence of any other event "
              "that terminates the continued membership of a Member in the "
              "Company, unless within ninety (90) days after the disassociation "
              "of membership, a majority in interest of the remaining Members "
              "consent to continue the business of the Company and to the "
              "admission of one or more Members as necessary; and"),
        ("d", "The entry of a decree of judicial dissolution under the "
              "Delaware Act."),
    ]:
        story.append(P(f"<b>({letter_label})</b>&nbsp;&nbsp;{text}", BODY_INDENT))

    story.extend(section("2", "Winding Up",
        "Upon dissolution, the Company shall cease carrying on its business "
        "and affairs and shall commence the winding up of the Company&rsquo;s "
        "business and affairs and complete the winding up as soon as "
        "practicable. Upon the winding up of the Company, the assets of the "
        "Company shall be distributed first to creditors to the extent "
        "permitted by law, in satisfaction of Company debts, liabilities, "
        "obligations, and then to Members and former Members first, in "
        "satisfaction of liabilities for distributions, and then, in "
        "accordance with their Sharing Ratios. Such proceeds shall be paid to "
        "such Members within one hundred twenty (120) days after the date of "
        "winding up."))

    return story


# =========================================================================
# ARTICLE XI - MISCELLANEOUS PROVISIONS
# =========================================================================
def build_article_xi():
    story = []
    story.append(article_hdr("XI", "MISCELLANEOUS PROVISIONS"))

    story.extend(section("1", "Terms",
        "Nouns and pronouns will be deemed to refer to the masculine, "
        "feminine, neuter, singular, and plural, as the identity of the "
        "person or persons, firm, or corporation may in the context require. "
        "The term &ldquo;Code&rdquo; shall refer to the Internal Revenue "
        "Code, as amended."))

    story.extend(section("2", "Article Headings",
        "The article headings and numbers contained in this Operating "
        "Agreement have been inserted only as a matter of convenience and "
        "for reference, and in no way shall be construed to define, limit, "
        "or describe the scope or intent of any provision of this Operating "
        "Agreement."))

    story.extend(section("3", "Counterparts; Electronic Signatures",
        "This Operating Agreement may be executed in any number of "
        "counterparts, each of which shall be deemed an original and all of "
        "which together shall constitute one and the same instrument. "
        "Signatures delivered by electronic transmission (including by PDF "
        "or a recognized electronic signature service) shall be deemed to "
        "have the same legal effect as original handwritten signatures and "
        "shall be effective under the federal Electronic Signatures in "
        "Global and National Commerce Act (E-SIGN) and the Delaware Uniform "
        "Electronic Transactions Act (UETA)."))

    story.extend(section("4", "Entire Agreement",
        "This Operating Agreement constitutes the entire agreement among the "
        "parties hereto and contains all the agreements among said parties "
        "with respect to the subject matter hereof. This Operating Agreement "
        "supersedes all other agreements, either oral or written, between "
        "said parties with respect to the subject matter hereof."))

    story.extend(section("5", "Severability",
        "The invalidity or unenforceability of any particular provision of "
        "this Operating Agreement shall not affect the other provisions "
        "hereof, and this Operating Agreement shall be construed in all "
        "respects as if such invalid or unenforceable provisions were "
        "omitted."))

    story.extend(section("6", "Amendment",
        "This Operating Agreement may be amended or revoked at any time by "
        "a written agreement executed by all the parties to this Operating "
        "Agreement, except where a lesser percentage of Membership Interests "
        "is permitted elsewhere in this Operating Agreement. No change or "
        "modification to this Operating Agreement shall be valid unless in "
        "writing and signed by all the parties to this Operating Agreement."))

    story.extend(section("7", "Notices",
        "Any Notice permitted or required under this Operating Agreement "
        "shall be conveyed to the party at the address reflected in this "
        "Operating Agreement and will be deemed to have been given when "
        "deposited in the United States mail, postage paid, or when "
        "delivered in person, or by a national overnight courier, or by "
        "email transmission to the last known email address of the "
        "recipient."))

    story.extend(section("8", "Binding Effect",
        "Subject to the provisions of this Operating Agreement relating to "
        "transferability, this Operating Agreement will be binding upon and "
        "shall inure to the benefit of the parties, and their respective "
        "distributees, heirs, successors and assigns."))

    story.extend(section("9", "Governing Law",
        "This Operating Agreement is being executed and delivered in the "
        "State of Delaware and shall be governed by, construed, and enforced "
        "in accordance with the laws of the State of Delaware, without "
        "regard to its conflict-of-laws principles."))

    story.extend(section("10", "Force Majeure",
        "No party shall be liable to the other for any delay in, or failure "
        "of performance of, its obligations under this Operating Agreement "
        "to the extent such delay or failure arises out of or results from "
        "events beyond its reasonable control, including (without "
        "limitation) acts of God, fire, flood, earthquake, pandemic, "
        "epidemic, war, terrorism, civil unrest, strike, labor dispute, "
        "governmental or regulatory action (including restrictions on "
        "trading or the closure of exchanges), failure or disruption of any "
        "securities exchange, clearing agency, prime broker, custodian, "
        "administrator or other service provider, failure of utilities, "
        "failure of internet or telecommunications service, and cyberattack "
        "or other information security incident, provided that the party "
        "affected takes commercially reasonable steps to mitigate the "
        "effects of such event and to resume performance as soon as "
        "reasonably practicable."))

    story.extend(section("11", "Tax Matters; Partnership Representative",
        "<b>(a) Partnership Representative.</b>&nbsp;&nbsp;For each taxable "
        "year of the Company in which the Company is subject to the "
        "centralized partnership audit rules of subchapter C of chapter 63 "
        "of the Code (as amended by the Bipartisan Budget Act of 2015, and "
        "as further amended from time to time, the &ldquo;BBA Rules&rdquo;), "
        "<b>Cindy Eagar</b> is hereby designated as the &ldquo;partnership "
        "representative&rdquo; of the Company within the meaning of Code "
        "Section 6223(a) (the &ldquo;Partnership Representative&rdquo;). "
        "<b>Scott R. McBrien</b> is hereby designated as the "
        "&ldquo;designated individual&rdquo; through whom the Partnership "
        "Representative may act, to the extent required by applicable "
        "Treasury Regulations or otherwise useful to administer this "
        "Agreement.",
        "<b>(b) Authority; Consultation.</b>&nbsp;&nbsp;The Partnership "
        "Representative shall have the authority to represent the Company "
        "before the Internal Revenue Service and other taxing authorities "
        "in connection with any audit, examination, or proceeding relating "
        "to the Company. The Partnership Representative shall keep the "
        "other Member reasonably informed of any material communications, "
        "proposed adjustments, or elections contemplated under the BBA "
        "Rules, and shall consult with the other Member in good faith "
        "before taking material action that could disproportionately "
        "affect such other Member.",
        "<b>(c) Election Out of BBA Rules.</b>&nbsp;&nbsp;To the extent "
        "the Company qualifies as an &ldquo;eligible partnership&rdquo; "
        "within the meaning of Code Section 6221(b) and applicable Treasury "
        "Regulations, the Members may, by unanimous written consent, direct "
        "the Partnership Representative to make, or refrain from making, an "
        "election under Code Section 6221(b) to have the BBA Rules not "
        "apply for any given taxable year of the Company. Absent such "
        "unanimous direction, the Partnership Representative may make or "
        "refrain from making such election in the Partnership "
        "Representative&rsquo;s reasonable discretion, after consultation "
        "with the other Member.",
        "<b>(d) Indemnification for Service.</b>&nbsp;&nbsp;The Company "
        "shall indemnify the Partnership Representative and the Designated "
        "Individual for any actions taken or omitted to be taken in such "
        "capacity in accordance with this Operating Agreement, to the "
        "fullest extent provided under Article VIII hereof."))

    return story


# =========================================================================
# SIGNATURE PAGE
# =========================================================================
def build_signatures():
    story = []
    story.append(PageBreak())
    story.append(P("<b>SIGNATURE PAGE</b>", ARTICLE_HDR))
    story.append(spacer(8))

    story.append(P(
        "IN WITNESS WHEREOF, the parties hereto make and execute this "
        "Operating Agreement on the dates set below their names, to be "
        "effective on the date first above written.",
        BODY))
    story.append(spacer(16))

    story.append(P("<b>WITNESSETH:</b>", BODY))
    story.append(spacer(10))

    story.append(P("<b>COMPANY:</b>", BODY))
    story.append(P("PNTHR Funds, LLC", BODY))
    story.append(P("a Delaware limited liability company", BODY))
    story.append(spacer(24))
    story.append(P("By: _________________________________________", BODY))
    story.append(P("Name:  Scott R. McBrien", BODY))
    story.append(P("Title:  Manager", BODY))
    story.append(P("Date:  ____________________________________", BODY))
    story.append(spacer(28))

    story.append(P("<b>MEMBERS:</b>", BODY))
    story.append(spacer(20))
    story.append(P("_________________________________________", BODY))
    story.append(P("Scott R. McBrien, individually", BODY))
    story.append(P("Date:  ____________________________________", BODY))
    story.append(spacer(24))
    story.append(P("_________________________________________", BODY))
    story.append(P("Cindy Eagar, individually", BODY))
    story.append(P("Date:  ____________________________________", BODY))

    return story


# =========================================================================
# EXHIBIT A
# =========================================================================
def build_exhibit_a():
    story = []
    story.append(PageBreak())
    story.append(P("<b>EXHIBIT A</b>", ARTICLE_HDR))
    story.append(P("<b>MEMBER LISTING</b>", SUBTITLE_STYLE))
    story.append(P("<b>CAPITAL AND OTHER CONTRIBUTIONS</b>", SUBTITLE_STYLE))
    story.append(spacer(18))

    story.append(P(
        "The Company has authorized 25,000 membership units, each with a par "
        "value of $1,000, issued as set forth below in conjunction with this "
        "Operating Agreement. The total number of authorized units scales "
        "with the $25,000,000 offering of the Fund described in the PPM and "
        "the Limited Partnership Agreement. Issuance of additional units "
        "beyond the 25,000 authorized units requires the unanimous consent "
        "of the Members pursuant to Article VII, Section 4(i).",
        BODY))
    story.append(spacer(10))

    data = [
        [P("<b>Member Name</b>", BODY),
         P("<b>Units</b>", BODY),
         P("<b>Ownership<br/>Interest</b>", BODY),
         P("<b>Sharing<br/>Ratio</b>", BODY),
         P("<b>Contribution</b>", BODY)],
        [P("Scott R. McBrien", BODY),
         P("12,500", BODY),
         P("50%", BODY),
         P("50%", BODY),
         P("Cash and services", BODY)],
        [P("Cindy Eagar", BODY),
         P("12,500", BODY),
         P("50%", BODY),
         P("50%", BODY),
         P("Cash and services", BODY)],
        [P("<b>Total</b>", BODY),
         P("<b>25,000</b>", BODY),
         P("<b>100%</b>", BODY),
         P("<b>100%</b>", BODY),
         P("", BODY)],
    ]
    tbl = Table(
        data,
        colWidths=[1.7 * inch, 0.8 * inch, 1.0 * inch, 0.9 * inch, 1.7 * inch],
    )
    tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOX", (0, 0), (-1, -1), 0.75, colors.black),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, colors.black),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.black),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(tbl)

    story.append(spacer(18))
    story.append(P(
        "The Members have each made capital and service contributions to "
        "the Company sufficient to fund initial formation, regulatory, and "
        "organizational expenses and to support the Company&rsquo;s service "
        "as General Partner of the Fund, including the General Partner&rsquo;s "
        "initial capital commitment of $100,000 to the Fund required by the "
        "Limited Partnership Agreement.",
        BODY))

    return story


# =========================================================================
# MAIN
# =========================================================================
def build():
    doc = make_doc_template(
        OUT_PATH,
        title_meta="PNTHR Funds, LLC - Operating Agreement v1.0 (Tree)",
        subject="Operating Agreement",
    )
    on_cover, on_page = make_page_handlers(
        fund_name="PNTHR Tree Fund",
        fund_name_upper="PNTHR TREE FUND",
        doc_short_title="Operating Agreement",
        doc_date_display="June 2026",
    )
    story = []
    story.extend(build_cover())
    story.extend(build_legend())
    story.extend(build_preamble())
    story.extend(build_article_i())
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
    story.extend(build_signatures())
    story.extend(build_exhibit_a())

    doc.build(story, onFirstPage=on_cover, onLaterPages=on_page)
    print(f"PDF generated: {OUT_PATH}")


if __name__ == "__main__":
    build()
