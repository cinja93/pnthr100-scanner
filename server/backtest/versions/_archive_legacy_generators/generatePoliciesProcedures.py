#!/usr/bin/env python3
"""
generatePoliciesProcedures.py
PNTHR Funds: Carnivore Quant Fund, LP
Policies and Procedures Manual

Branded version using pnthr_doc_style v4.
Source: Original P&P Manual (55 pages), cross-referenced against PPM v5.2
for title/role alignment.

All officer titles corrected to match PPM v5.2:
  - Scott McBrien: Managing Member, Chief Investment Officer & Chief Compliance Officer
  - Cindy Eagar: Managing Member, Chief Operating Officer & Chief Information Security Officer

Key changes from source:
  - "Data Security Coordinator" -> corrected to COO & CISO title
  - "Chief Executive Officer" in whistleblower section -> "Managing Member"
  - Section 12 (Code of Ethics) replaced with incorporation-by-reference
    to the standalone PNTHR Code of Ethics Manual
  - Exhibits B-F retained; Exhibit F (Whistleblower Complaint Form) is unique
    to this manual

Usage:  cd server/backtest && python3 generatePoliciesProcedures.py
Output: client/public/PNTHR_Policies_Procedures.pdf
"""

import os, sys
from reportlab.lib.pagesizes import letter
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Table, TableStyle,
    Spacer, PageBreak, KeepTogether, NextPageTemplate
)
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor, white
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY

sys.path.insert(0, os.path.dirname(__file__))
from pnthr_doc_style import (
    PNTHR_YELLOW, PNTHR_BLACK, PNTHR_INK, PNTHR_GREY_600, PNTHR_GREY_400,
    PNTHR_GREY_100, PNTHR_CREAM,
    FONT_REGULAR, FONT_BOLD, FONT_ITALIC, FONT_BOLD_ITALIC,
    PAGE_WIDTH, PAGE_HEIGHT, MARGIN_LEFT, MARGIN_RIGHT, MARGIN_TOP, MARGIN_BOTTOM,
    set_asset_paths, draw_cover_header, draw_cover_bottom_band,
    make_numbered_canvas, SectionHeading, build_info_table,
    get_paragraph_styles, section_spacer,
)

HERE   = os.path.dirname(__file__)
PUBLIC = os.path.join(HERE, '../../client/public')
LOGO   = os.path.join(PUBLIC, 'pnthr-funds-cqf-logo-white-bg.png')
OUT    = os.path.join(PUBLIC, 'PNTHR_Policies_Procedures.pdf')

set_asset_paths(LOGO)

# -- Styles -------------------------------------------------------------------
_styles = get_paragraph_styles()
NORMAL     = _styles['body']
BOLD       = _styles['body_bold']
CENTER     = _styles['body_center']
BODY_W     = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT

BULLET = ParagraphStyle('bullet_pp', parent=NORMAL, leftIndent=18,
                        firstLineIndent=-12, spaceAfter=4)
BULLET2 = ParagraphStyle('bullet2_pp', parent=NORMAL, fontSize=8, leading=11,
                         leftIndent=32, firstLineIndent=-12, spaceAfter=3)
H2 = ParagraphStyle('h2_pp', parent=NORMAL, fontName=FONT_BOLD, fontSize=11,
                     leading=14, spaceBefore=12, spaceAfter=4, textColor=PNTHR_BLACK)
H3 = ParagraphStyle('h3_pp', parent=NORMAL, fontName=FONT_BOLD, fontSize=9.5,
                     leading=13, spaceBefore=8, spaceAfter=3, textColor=PNTHR_BLACK)
WARN_STYLE = ParagraphStyle('warn_pp', parent=NORMAL, fontName=FONT_BOLD,
                            fontSize=8, leading=11, spaceAfter=4)
SIG_STYLE = ParagraphStyle('sig_pp', parent=NORMAL, fontSize=9, leading=14,
                           spaceAfter=2)
INDENT = ParagraphStyle('indent_pp', parent=NORMAL, leftIndent=24, spaceAfter=4)
ITALIC_STYLE = ParagraphStyle('italic_pp', parent=NORMAL, fontName=FONT_ITALIC)
SMALL = ParagraphStyle('small_pp', parent=NORMAL, fontSize=8, leading=11, spaceAfter=4)
FORM_LABEL = ParagraphStyle('form_label_pp', parent=NORMAL, fontName=FONT_BOLD,
                            fontSize=9, leading=13, spaceAfter=2)
FORM_FIELD = ParagraphStyle('form_field_pp', parent=NORMAL, fontSize=9, leading=16,
                            spaceAfter=8)

def sp(h=6): return Spacer(1, h)
def p(text, style=None): return Paragraph(text, style or NORMAL)
def bl(text): return Paragraph(f'&#8226; {text}', BULLET)
def bl2(text): return Paragraph(f'&#8211; {text}', BULLET2)
def head(title, sub=None, is_article=False):
    return SectionHeading(title, sub_label=sub, is_article=is_article)

def warn_box(lines):
    content = '<br/>'.join(lines)
    tbl = Table([[Paragraph(content, WARN_STYLE)]],
                colWidths=[BODY_W - 0.3 * inch])
    tbl.setStyle(TableStyle([
        ('BACKGROUND',    (0,0), (-1,-1), PNTHR_CREAM),
        ('LINEBEFORE',    (0,0), (0,-1),  3, PNTHR_YELLOW),
        ('LEFTPADDING',   (0,0), (-1,-1), 14),
        ('RIGHTPADDING',  (0,0), (-1,-1), 10),
        ('TOPPADDING',    (0,0), (-1,-1), 8),
        ('BOTTOMPADDING', (0,0), (-1,-1), 8),
    ]))
    return tbl

def styled_table(rows, col_widths=None, header_row=True):
    if col_widths is None:
        col_widths = [2.0 * inch, BODY_W - 2.0 * inch]
    styled_rows = []
    for i, row in enumerate(rows):
        styled_rows.append([
            Paragraph(str(c), ParagraphStyle(
                f'tcell_pp_{i}_{j}', parent=NORMAL,
                fontName=FONT_BOLD if i == 0 and header_row else FONT_REGULAR,
                fontSize=8, leading=11))
            for j, c in enumerate(row)
        ])
    tbl = Table(styled_rows, colWidths=col_widths, repeatRows=1 if header_row else 0)
    style_cmds = [
        ('VALIGN',       (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING',  (0,0), (-1,-1), 10),
        ('RIGHTPADDING', (0,0), (-1,-1), 10),
        ('TOPPADDING',   (0,0), (-1,-1), 5),
        ('BOTTOMPADDING',(0,0), (-1,-1), 5),
        ('LINEBEFORE',   (0,0), (0,-1),  3, PNTHR_YELLOW),
        ('GRID',         (0,0), (-1,-1), 0.3, PNTHR_GREY_400),
    ]
    if header_row and len(rows) > 0:
        style_cmds.extend([
            ('BACKGROUND', (0,0), (-1,0), PNTHR_BLACK),
            ('TEXTCOLOR',  (0,0), (-1,0), white),
            ('FONT',       (0,0), (-1,0), FONT_BOLD, 8),
        ])
    start = 1 if header_row else 0
    for i in range(start, len(rows)):
        if (i - start) % 2 == 0:
            style_cmds.append(('BACKGROUND', (0,i), (-1,i), PNTHR_GREY_100))
    tbl.setStyle(TableStyle(style_cmds))
    return tbl


# =============================================================================
#  COVER
# =============================================================================

def build_cover(story):
    story.append(sp(3.8 * inch))
    info_rows = [
        ('Firm', 'STT Capital Advisors, LLC'),
        ('Fund', 'Carnivore Quant Fund, LP'),
        ('Regulatory Status', 'Exempt Reporting Adviser (ERA)'),
        ('Effective Date', 'May 1, 2025'),
        ('Last Reviewed', 'April 2026'),
        ('Chief Compliance Officer', 'Scott McBrien, Managing Member, CIO & CCO'),
        ('CCO Designee', 'Cindy Eagar, Managing Member, COO & CISO'),
        ('Principal Office', '15150 W Park Place, Suite 215, Goodyear, AZ 85395'),
    ]
    story.append(build_info_table(info_rows, header='DOCUMENT PARTICULARS'))
    story.append(sp(18))
    story.append(p(
        'This Policies and Procedures Manual outlines the compliance framework adopted '
        'by STT Capital Advisors, LLC in connection with its operations as an investment '
        'adviser to private pooled investment vehicles. This document incorporates '
        'the PNTHR Code of Ethics Manual by reference.',
        CENTER
    ))
    story.append(PageBreak())


# =============================================================================
#  TABLE OF CONTENTS
# =============================================================================

def build_toc(story):
    story.append(head('Table of Contents', is_article=True))
    story.append(section_spacer())

    toc_entries = [
        '1. Introduction',
        '    1.1 Compliance Program',
        '    1.2 Business Continuity and Disaster Recovery Plan',
        '2. Client Relationships',
        '    2.1 Calculation and Collection of Fees',
        '    2.2 Anti-Money Laundering (AML) and OFAC Compliance',
        '3. Portfolio Management',
        '    3.1 Allocation of Investments',
        '    3.2 ERISA',
        '    3.3 Adherence to Investment Mandates',
        '4. Trading Practices',
        '    4.1 Best Execution',
        '    4.2 Soft Dollars',
        '    4.3 Principal Transactions',
        '    4.4 Cross Transactions',
        '    4.5 Trade Errors',
        '    4.6 Post-Trade Review',
        '5. Valuation',
        '6. Privacy \u2014 Protection of Non-Public Information',
        '    6.1 Insider Trading',
        '    6.2 Protection of Nonpublic Personal Information',
        '7. Marketing and Communications',
        '    7.1 Advertising and Marketing Materials',
        '    7.2 Email Communication',
        '    7.3 Social Media Policy',
        '    7.4 Media Interview Procedures',
        '8. Books and Records',
        '9. Regulatory Compliance \u2014 Form ADV',
        '10. Regulatory Compliance \u2014 Form D and Blue Sky',
        '11. Cybersecurity',
        '12. Code of Ethics (Incorporated by Reference)',
        '',
        'Exhibit A: Record Retention Table',
        'Exhibit B: Certification and Acknowledgement of Receipt',
        'Exhibit C: Gift and Entertainment Form',
        'Exhibit D: Personal Account Trading Authorization Form',
        'Exhibit E: Employee Disclosure Form',
        'Exhibit F: Whistleblower Complaint Form',
    ]

    toc_style = ParagraphStyle('toc_pp', parent=NORMAL, fontSize=9, leading=13)
    toc_bold = ParagraphStyle('toc_pp_b', parent=NORMAL, fontName=FONT_BOLD,
                              fontSize=9, leading=15, spaceBefore=4)
    for entry in toc_entries:
        if not entry:
            story.append(sp(6))
        elif entry.startswith('    '):
            story.append(Paragraph(entry.strip(), toc_style))
        elif entry.startswith('Exhibit'):
            story.append(Paragraph(f'<b>{entry}</b>', toc_style))
        else:
            story.append(Paragraph(entry, toc_bold))

    story.append(PageBreak())


# =============================================================================
#  SECTION 1 \u2014 INTRODUCTION
# =============================================================================

def build_section_1(story):
    story.append(head('1. Introduction', 'SECTION 1', is_article=True))
    story.append(section_spacer())

    # 1.1 Compliance Program
    story.append(Paragraph('1.1 Compliance Program', H2))
    story.append(p(
        'This Policies and Procedures Manual outlines the compliance framework adopted by STT '
        'Capital Advisors, LLC (\u201cSTT Capital Advisors,\u201d the \u201cAdviser,\u201d or '
        'the \u201cFirm\u201d) in connection with its operations as an investment adviser to '
        'private pooled investment vehicles. STT Capital Advisors is a fiduciary to its clients '
        'and is committed to fulfilling its obligations with the highest duty of care and '
        'loyalty, consistent with industry best practices and applicable regulatory expectations '
        'for Exempt Reporting Advisers.'
    ))
    story.append(p(
        'As a fiduciary, STT Capital Advisors expects all officers, directors, employees, and '
        'contractors (collectively, \u201cEmployees\u201d) to maintain strict ethical standards '
        'and uphold this Manual\u2019s policies at all times. Each Employee is responsible for '
        'understanding and complying with this Manual and for reporting any actual or suspected '
        'violations to the Chief Compliance Officer (\u201cCCO\u201d).'
    ))
    story.append(p(
        'This Manual reflects the Firm\u2019s responsibilities under the Investment Advisers '
        'Act of 1940, as applicable to Exempt Reporting Advisers under Rule 204-4, and '
        'incorporates principles of effective compliance oversight, operational integrity, '
        'and investor protection.'
    ))
    story.append(p(
        'The Firm\u2019s clients are pooled investment vehicles structured as hedge funds. '
        'These Clients include but are not limited to high-net-worth individuals, corporate '
        'entities, trusts, Self-Directed IRA\u2019s and other institutional Investors. The '
        'Firm provides discretionary investment management to these Clients under Regulation D, '
        'Rule 506(c) of the Securities Act and Sections 3(c)(1) or 3(c)(7) of the Investment '
        'Company Act.'
    ))
    story.append(p(
        'STT Capital Advisors has appointed a Chief Compliance Officer who is empowered with '
        'full responsibility and authority to design, implement, and enforce the Firm\u2019s '
        'compliance program. The CCO may delegate responsibilities to qualified personnel or '
        'third-party providers and has discretion to interpret and apply the policies of this '
        'Manual on a case-by-case basis.'
    ))
    story.append(p(
        'STT Capital Advisors, LLC maintains operational and compliance policies proportional '
        'to its size, complexity, and business model. This document outlines core procedures '
        'designed to ensure ethical operation and investor protection, consistent with the '
        'fiduciary duty owed to its private fund clients.'
    ))
    story.append(p(
        'This Manual is the confidential property of STT Capital Advisors, LLC. Each Employee '
        'is provided a hard copy at the start of employment and must return it to the CCO upon '
        'departure from the Firm. Unauthorized distribution of this Manual is strictly prohibited.'
    ))
    story.append(sp(6))

    # 1.2 Business Continuity and Disaster Recovery Plan
    story.append(Paragraph('1.2 Business Continuity and Disaster Recovery Plan', H2))
    story.append(p(
        'STT Capital Advisors, LLC maintains a Business Continuity and Disaster Recovery Plan '
        '(separate from this document) that the Firm tests annually and updates as necessary. '
        'See the standalone PNTHR BCDRP for complete details.'
    ))
    story.append(sp(6))


# =============================================================================
#  SECTION 2 \u2014 CLIENT RELATIONSHIPS
# =============================================================================

def build_section_2(story):
    story.append(head('2. Client Relationships', 'SECTION 2', is_article=True))
    story.append(section_spacer())

    # 2.1 Calculation and Collection of Fees
    story.append(Paragraph('2.1 Calculation and Collection of Fees', H2))
    story.append(p(
        '<b>Policy:</b> STT Capital Advisors, LLC provides investment advisory services to '
        'its private hedge fund clients and charges a management fee of 2% annually (paid '
        'monthly in arrears as 1/12 of 2.0%) for its services.'
    ))
    story.append(p(
        'A client of STT Capital Advisors, PNTHR FUNDS LLC, charges performance allocations '
        '(commonly referred to as performance \u201cfees\u201d) are charged to PNTHR FUNDS, '
        'Carnivore Quant Fund, LP pursuant to the fund\'s offering documents and vary by '
        'investment class.'
    ))
    story.append(p(
        'Performance allocations for PNTHR FUNDS LLC, based on the performance of PNTHR FUNDS, '
        'Carnivore Quant Fund, LP, are based on net new profits that exceed the applicable '
        'hurdle rate (the U.S. 2-Year Treasury Yield). High water mark provisions apply to '
        'ensure fees are only paid on net gains above previous peaks.'
    ))
    story.append(p(
        'PNTHR FUNDS, Carnivore Quant Fund, LP Investor classes are structured as follows:'
    ))

    # Fee class table
    rows = [
        ['Investor Class', 'Investment Range', 'Performance Allocation', 'Loyalty Reduction'],
        ['Wagyu Interests', '\u2265 $1,000,000', '20%',
         'Reduced to 15% after 3 years at or above initial investment'],
        ['Porterhouse Interests', '$500,000 \u2013 $999,999', '25%',
         'Reduced to 20% after 3 years at or above initial investment'],
        ['Filet Interests', '< $500,000 (min $100,000)', '30%',
         'Reduced to 25% after 3 years at or above initial investment'],
    ]
    story.append(styled_table(rows, col_widths=[1.3*inch, 1.4*inch, 1.3*inch, BODY_W - 4.0*inch]))
    story.append(sp(6))

    story.append(p(
        'The GP may reclassify investor interests based on capital account balances. STT '
        'Capital Advisors, LLC, the Investment Manager, receives management fees from the '
        'fund monthly.'
    ))
    story.append(p(
        'Performance fees are allocated to PNTHR FUNDS, LLC, the GP. Fees are disclosed in '
        'PNTHR FUNDS, Carnivore Quant Fund, LP (the Fund) offering documents (e.g., PPM and '
        'LPA), not Form ADV Part 2A, as STT Capital Advisors, LLC is an ERA and not required '
        'to file or deliver the brochure.'
    ))
    story.append(sp(4))
    story.append(Paragraph('<b>Procedures:</b>', BOLD))
    story.append(bl(
        'NAV Fund Services calculates and debits management and performance fees based on '
        'the fund\'s governing documents.'
    ))
    story.append(bl(
        'The CCO verifies calculations and documentation quarterly for accuracy and '
        'consistency with the fund\u2019s offering documents.'
    ))
    story.append(bl(
        'Side letters altering fees require prior written approval by the Managing Member '
        'and must be documented.'
    ))
    story.append(sp(6))

    # 2.2 AML and OFAC
    story.append(Paragraph('2.2 Anti-Money Laundering (AML) and OFAC Compliance', H2))
    story.append(p(
        '<b>Background:</b> While SEC-registered advisers are not subject to Bank Secrecy Act '
        'AML rules, private fund advisers often adopt AML procedures voluntarily due to '
        'institutional investor expectations and requirements from custodians, administrators, '
        'and counterparties. STT Capital Advisors, LLC operates under a best-practice AML '
        'framework, supported by NAV Fund Services (the fund administrator), which performs '
        'investor AML checks.'
    ))
    story.append(p(
        '<b>Policy:</b> NAV Fund Services is responsible for performing AML reviews for each '
        'prospective investor prior to acceptance into any fund advised by STT Capital '
        'Advisors, LLC. This includes:'
    ))
    story.append(bl('Verification against OFAC\'s Specially Designated Nationals (SDN) list'))
    story.append(bl(
        'Collection of documentation appropriate to entity type (individual, trust, corporate, ERISA)'
    ))
    story.append(bl('Confirmation of source of funds and beneficial ownership'))
    story.append(bl(
        'Approval by the Chief Compliance Officer (CCO) following reputational risk assessment'
    ))
    story.append(p(
        'Investments are not accepted unless all AML requirements are satisfied. The firm does '
        'not accept cash or directly hold client assets.'
    ))
    story.append(sp(4))
    story.append(Paragraph('<b>Procedures:</b>', BOLD))
    story.append(bl(
        'NAV Fund Services collects and maintains all required AML/KYC documentation. '
        'AML is conducted by NAV.'
    ))
    story.append(bl(
        'The CCO reviews investor profiles and documentation prior to capital acceptance. '
        'CCO reviews only for reputational risk or red flags.'
    ))
    story.append(bl('Investors are provided a privacy notice upon onboarding.'))
    story.append(bl(
        'If any employee receives cash, the CCO must be notified immediately.'
    ))
    story.append(sp(6))


# =============================================================================
#  SECTION 3 \u2014 PORTFOLIO MANAGEMENT
# =============================================================================

def build_section_3(story):
    story.append(head('3. Portfolio Management', 'SECTION 3', is_article=True))
    story.append(section_spacer())

    # 3.1 Allocation of Investments
    story.append(Paragraph('3.1 Allocation of Investments', H2))
    story.append(p(
        '<b>Policy:</b> STT Capital Advisors, LLC allocates investment opportunities among '
        'Fund Clients in a fair and equitable manner. The firm does not favor or disadvantage '
        'any investor, and allocates trades based on client mandates, investment guidelines, '
        'and strategy suitability. As an ERA, the firm does not manage ERISA plan accounts '
        'directly, nor does it act as a fiduciary to individual investors.'
    ))
    story.append(p(
        'STT Capital Advisors, LLC does <b>not</b> maintain a proprietary trading account '
        'and does <b>not</b> engage in soft dollar arrangements. Employees may be permitted '
        'to invest in the Fund Client(s) on the same terms as other limited partners, subject '
        'to conflicts oversight.'
    ))
    story.append(p(
        'The Firm does not trade for its own proprietary account. Firm Employees may invest '
        'in Clients.'
    ))
    story.append(sp(4))
    story.append(Paragraph('<b>Procedure:</b>', BOLD))
    story.append(bl(
        'Investment allocations are based on investment suitability, strategy mandate, and timing.'
    ))
    story.append(bl(
        'The Portfolio Manager determines allocations and documents rationale as appropriate.'
    ))
    story.append(bl(
        'The CCO reviews trade allocations quarterly against brokerage data to ensure '
        'compliance with this policy and to detect any pattern of favoritism.'
    ))
    story.append(sp(6))

    # 3.2 ERISA
    story.append(Paragraph('3.2 ERISA', H2))
    story.append(p(
        '<b>Background:</b> Although STT Capital Advisors, LLC does not currently market to or '
        'manage assets for ERISA plans, the firm monitors for potential Benefit Plan Investor '
        '(BPI) participation in Fund Clients to maintain compliance with Section 3(42) of '
        'ERISA and associated Department of Labor (DOL) regulations.'
    ))
    story.append(p(
        'Where applicable, STT Capital Advisors, LLC may rely on the Qualified Professional '
        'Asset Manager (QPAM) Exemption, provided it continues to meet financial eligibility '
        'and compliance conditions, including net equity thresholds and AUM requirements.'
    ))
    story.append(p(
        'STT Capital Advisors does not currently rely on the QPAM exemption but monitors '
        'ERISA thresholds to ensure Benefit Plan Investor participation remains below the '
        '25% threshold.'
    ))
    story.append(sp(4))
    story.append(Paragraph('<b>Policy:</b> STT Capital Advisors, LLC:', BOLD))
    story.append(bl('Does not engage in principal or cross transactions.'))
    story.append(bl('Has no affiliated counterparties.'))
    story.append(bl(
        'Does not engage in transactions that would disqualify use of the QPAM exemption.'
    ))
    story.append(bl(
        'Monitors Fund Client participation levels by Benefit Plan Investors to ensure that '
        'ERISA \u201csignificant participation\u201d thresholds are not exceeded (i.e., the '
        '25% rule).'
    ))
    story.append(sp(4))
    story.append(Paragraph('<b>Procedures:</b>', BOLD))
    story.append(bl(
        'The CCO monitors investor onboarding to ensure that Benefit Plan Investors do not '
        'exceed 25% of the value of any class of equity in the Fund.'
    ))
    story.append(bl(
        'Ongoing diligence is performed if Fund assets approach the 20% threshold noted in '
        'QPAM requirements.'
    ))
    story.append(bl(
        'Should any new transaction type or investor profile raise a potential ERISA concern, '
        'the CCO will escalate to legal counsel for a formal exemption review.'
    ))
    story.append(sp(6))

    # 3.3 Adherence to Investment Mandates
    story.append(Paragraph('3.3 Adherence to Investment Mandates', H2))
    story.append(p(
        '<b>Policy:</b> Each Fund Client is managed in accordance with the stated investment '
        'strategy, objectives, and restrictions outlined in its offering documents (e.g., PPM, '
        'LPA). STT Capital Advisors, LLC does not tailor strategies for individual investors '
        'but applies uniform portfolio management consistent with the fund\u2019s mandate.'
    ))
    story.append(sp(4))
    story.append(Paragraph('<b>Procedures:</b>', BOLD))
    story.append(bl(
        'The Portfolio Manager and CCO maintain copies of fund strategy documents and track '
        'compliance with investment parameters.'
    ))
    story.append(bl(
        'No investment in illiquid or restricted securities (e.g., private placements under '
        'Regulation D) is permitted without pre-approval from the CCO.'
    ))
    story.append(bl(
        'Fund activity is reviewed quarterly for consistency with stated guidelines, including '
        'diversification, leverage limits, and sector exposure.'
    ))
    story.append(sp(6))


# =============================================================================
#  SECTION 4 \u2014 TRADING PRACTICES
# =============================================================================

def build_section_4(story):
    story.append(head('4. Trading Practices', 'SECTION 4', is_article=True))
    story.append(section_spacer())

    # 4.1 Best Execution
    story.append(Paragraph('4.1 Best Execution', H2))
    story.append(p(
        '<b>Policy:</b> STT Capital Advisors, LLC seeks best execution from the brokers with '
        'whom it places trades for execution on behalf of its Clients. As an Exempt Reporting '
        'Adviser (ERA), STT Capital Advisors, LLC prioritizes execution quality, including '
        'confidentiality, timeliness, price competitiveness, and responsiveness over pure '
        'commission cost.'
    ))
    story.append(sp(4))
    story.append(p(
        '<b>Procedures:</b> No less than quarterly, the Managing Member conducts a broker '
        'evaluation based on execution and service quality. Evaluation criteria include:'
    ))
    story.append(sp(4))
    story.append(Paragraph('<b>Research Factors:</b>', BOLD))
    story.append(bl('Sales/Analyst Calls'))
    story.append(bl('Analyst Quality'))
    story.append(bl('Responsiveness'))
    story.append(bl('Company Conference Calls'))
    story.append(bl('Trip Help'))
    story.append(bl('Conferences'))
    story.append(sp(4))
    story.append(Paragraph('<b>Execution Factors:</b>', BOLD))
    story.append(bl('Trading Effectiveness'))
    story.append(bl('Confirmation Quality'))
    story.append(bl('Settlement Help'))
    story.append(bl('Trading Average'))
    story.append(bl('Research Average'))
    story.append(p(
        'The CCO reviews the broker evaluation each quarter for adherence to best execution '
        'policies. Any material variance in actual commissions versus expected benchmarks is '
        'documented and addressed.'
    ))
    story.append(sp(6))

    # 4.2 Soft Dollars
    story.append(Paragraph('4.2 Soft Dollars', H2))
    story.append(p(
        '<b>Policy:</b> STT Capital Advisors, LLC does not use soft dollars and does not '
        'maintain any arrangements under Section 28(e) of the Exchange Act. All research '
        'and trading-related costs are paid in hard dollars.'
    ))
    story.append(p(
        '<b>Procedures:</b> The Portfolio Manager and CCO confirm quarterly that no soft '
        'dollar arrangements exist and that all third-party research, if any, is acquired '
        'on a hard dollar basis or produced internally. STT Capital Advisors does not plan '
        'to use soft dollars and will notify investors of any change.'
    ))
    story.append(sp(6))

    # 4.3 Principal Transactions
    story.append(Paragraph('4.3 Principal Transactions', H2))
    story.append(p(
        '<b>Policy:</b> The Firm does not maintain a proprietary trading account, does not '
        'engage in principal transactions, and will not engage in principal transactions '
        'without approval by the CCO and a stated Principal Transaction procedure.'
    ))
    story.append(sp(6))

    # 4.4 Cross Transactions
    story.append(Paragraph('4.4 Cross Transactions', H2))
    story.append(p(
        '<b>Policy:</b> STT Capital Advisors LLC does not conduct cross transactions during '
        'the ordinary course of business. However, in rare cases the Firm may seek to adjust '
        'or rebalance the portfolios of Fund Clients and Subadvised Account Clients under '
        'management by effecting cross trades between or among such accounts or funds. In '
        'such cases, the Firm will effect the transaction in accordance with applicable '
        'regulatory requirements, including those relating to ERISA.'
    ))
    story.append(p(
        'All such cross transactions will be consistent with the investment objectives and '
        'policies of each Client account involved in the trades and will be effected at a '
        'current independent market price of the securities involved in the trades determined '
        'by the Firm. Clients involved in any cross trades will not pay any brokerage '
        'commissions or mark ups in connection with such trades, but may pay customary '
        'transfer fees that are assessed through any unaffiliated broker dealers through '
        'which the trades are effected.'
    ))
    story.append(p(
        '<b>Procedures:</b> All cross transactions must be pre-approved by the CCO prior to '
        'execution. Following a cross transaction, the CCO will confirm the absence of a '
        'commission or mark up and any additional fees charged to the purchasing Client '
        'account to ensure accuracy of the fee calculation and adherence to each Client\u2019s '
        'portfolio management policy.'
    ))
    story.append(sp(6))

    # 4.5 Trade Errors
    story.append(Paragraph('4.5 Trade Errors', H2))
    story.append(p(
        '<b>Policy:</b> In the course of normal business STT Capital Advisors LLC or one of '
        'its brokers may cause a Client account to incur an occasional trade error. Trade '
        'Errors may occur in either the investment decision-making or the trading process. '
        'Such trade errors include:'
    ))
    story.append(bl(
        'Purchases or sales of securities that the Firm knows or should have known were not '
        'legally authorized for a Client\u2019s account;'
    ))
    story.append(bl(
        'Purchases or sales of securities not authorized by the Client\u2019s investment '
        'advisory contract; or'
    ))
    story.append(bl(
        'Failure to place a portfolio manager\u2019s order to purchase or sell securities as '
        'intended, such as by transacting in the wrong securities or for the wrong amount, '
        'or effecting a buy instead of a sell.'
    ))
    story.append(p(
        'Clerical mistakes that have an impact solely on recordkeeping (\u201ctrade breaks\u201d) '
        'are not treated as trade errors.'
    ))
    story.append(warn_box([
        'All trade errors will be corrected promptly upon their discovery and STT Capital '
        'Advisors LLC will be responsible for any Client loss or gain resulting from the '
        'inaccurate or erroneous order.'
    ]))
    story.append(sp(4))
    story.append(p(
        'Errors must be corrected on the same day the error occurred, absent extenuating '
        'circumstances. Errors discovered after the market has closed must be corrected on '
        'the next business day. If an error is not detected until a later date, the error '
        'must be corrected within 24 hours of discovery, or at the earliest date reasonably '
        'practicable.'
    ))
    story.append(sp(4))

    # Trade error sub-sections
    story.append(Paragraph('<i>Correction of Trade Errors Before Settlement</i>', ITALIC_STYLE))
    story.append(p(
        'A trader shall make every effort to rescind erroneous trades prior to settlement, '
        'if possible. If the trade can be reversed or corrected before settlement, the '
        'following procedure must be used:'
    ))
    story.append(bl(
        'Immediately notify the Portfolio Manager orally that a trade error has occurred '
        'and that the trade has been rescinded.'
    ))
    story.append(bl(
        'Document the nature of the error and its resolution. The trader must sign the report.'
    ))
    story.append(bl(
        'Copies of the report must be given to the Portfolio Manager who must sign to '
        'confirm the facts contained in the report.'
    ))
    story.append(bl(
        'The report signed by the Portfolio Manager must promptly be sent to the CCO who '
        'will review the report to determine that the error correction process has been '
        'followed and sign the report.'
    ))
    story.append(bl(
        'A copy of the report signed by the trader and initialed by the Portfolio Manager '
        'and the CCO must be filed in the Trade Error Correction File.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<i>Correction of Trade Errors After Settlement</i>', ITALIC_STYLE))
    story.append(p(
        'If the trade cannot be rescinded prior to settlement, the error must be corrected '
        'promptly as follows:'
    ))
    story.append(bl(
        'Notify Portfolio Manager orally of error as soon as it has been determined that '
        'the erroneous trade cannot be rescinded prior to settlement or as soon as an '
        'erroneous post-settlement trade is discovered.'
    ))
    story.append(bl(
        'Document the nature of the error, how the error occurred and whether the error '
        'had a negative or positive impact on any client accounts. The trader must sign '
        'the report.'
    ))
    story.append(bl('The report must describe the steps required to correct the error.'))
    story.append(bl(
        'The Portfolio Manager must review and determine whether the method of correcting '
        'the trade error is consistent with STT Capital Advisors LLC\u2019s policy and sign '
        'the report to confirm the facts contained in the report and to approve the resolution '
        'of the trade error.'
    ))
    story.append(bl(
        'The CCO must promptly review and approve the error correction method and sign '
        'the report.'
    ))
    story.append(bl(
        'All trade error reports shall be maintained in the Trade Error Correction File '
        'along with any other supporting documentation. <i>The CCO is responsible for '
        'maintaining the Trade Error Correction File.</i>'
    ))
    story.append(sp(4))

    story.append(Paragraph('<i>Prohibited Error Correction Practices</i>', ITALIC_STYLE))
    story.append(bl(
        'Correction of errors by instituting trades between Client accounts (\u201ccross trades\u201d);'
    ))
    story.append(bl(
        'Using \u201csoft dollars\u201d to rectify trade errors, which includes allowing a '
        'broker to pay or reimburse STT Capital Advisors for losses due to any trade error '
        'caused by STT Capital Advisors; and'
    ))
    story.append(bl(
        'Failure to act promptly to cure a trade error, even if the amount of the error '
        'appears to be insignificant.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<i>Prevention of Trade Errors</i>', ITALIC_STYLE))
    story.append(p(
        'The trading staff must use extreme care in the execution of trades. The following '
        'steps must be taken to reduce the risk of trade errors:'
    ))
    story.append(bl(
        'Each trader must carefully review the trading order given to him or her. Prior to '
        'actually executing the trade, the trader must confirm the particulars of the trading '
        'order against the pending trade.'
    ))
    story.append(bl(
        'The traders must fully complete each Trade Ticket and review the Trade Ticket '
        'against the trading order prior to settlement.'
    ))
    story.append(bl(
        'All account trading and investment restrictions must be entered into the trading '
        'system to ensure that restricted trades will be blocked for specific accounts.'
    ))
    story.append(bl(
        'Each trader must reconcile all of his or her trades before leaving for the day.'
    ))
    story.append(bl(
        'The Portfolio Manager will review all trades prior to settlement for new traders '
        'within their first 30 days of employment. Any trader who has committed more than '
        'one trade error within any 90-day period shall have his or her trades closely '
        'monitored for as long as the Portfolio Manager deems it necessary.'
    ))
    story.append(bl(
        'The Portfolio Manager will periodically \u201cspot check\u201d the trades of all '
        'traders to ensure the continued high quality of their work.'
    ))
    story.append(bl(
        'Each new trader must be trained in STT Capital Advisors trading systems and '
        'procedures prior to executing trades.'
    ))
    story.append(bl(
        'The CCO must review the trade error tracking systems and initiate a compliance '
        'review of trade errors with the Portfolio Manager if problems are recurrent.'
    ))
    story.append(sp(6))

    # 4.6 Post-trade Review
    story.append(Paragraph('4.6 Post-Trade Review', H2))
    story.append(p(
        '<b>Policy:</b> The CCO reviews the Firm\u2019s trade blotter no less than monthly '
        'for adherence to the Clients\u2019 investment objectives and to mitigate the risk '
        'of insider trading.'
    ))
    story.append(p(
        '<b>Procedure:</b> Once a month, the CCO will review the trade blotter provided by '
        'the Managing Member to evaluate trades made on behalf of Clients during that period. '
        'Any discrepancies observed by the CCO will be documented and corrective action may '
        'be taken if a trade was made erroneously.'
    ))
    story.append(sp(6))


# =============================================================================
#  SECTION 5 \u2014 VALUATION
# =============================================================================

def build_section_5(story):
    story.append(head('5. Valuation', 'SECTION 5', is_article=True))
    story.append(section_spacer())
    story.append(p(
        '<b>Policy:</b> STT Capital Advisors, LLC values client investments in accordance '
        'with the fund\u2019s governing documents and applicable GAAP principles. Valuations '
        'are primarily conducted by the fund\u2019s independent third-party administrator, '
        'NAV Fund Services, based on prevailing market data and pricing vendor inputs. In '
        'cases where market quotations are not readily available, fair value is determined '
        'in good faith and reviewed for consistency with GAAP. All valuations of the assets '
        'and appraisals of assets and liabilities made in good faith by the Firm will be '
        'binding and conclusive on all Clients and other interested persons absent manifest '
        'error.'
    ))
    story.append(sp(4))
    story.append(Paragraph('<b>Procedures:</b>', BOLD))
    story.append(bl(
        'Daily valuations are conducted by NAV Fund Services using pricing feeds, market '
        'quotes, and external sources.'
    ))
    story.append(bl(
        'Securities listed on national exchanges are valued using closing prices or bid/ask '
        'spreads as applicable.'
    ))
    story.append(bl(
        'For fixed income and short-term instruments, NAV Fund Services uses independent '
        'pricing services to determine market value.'
    ))
    story.append(bl(
        'Illiquid assets, if any, are valued in accordance with fair value policies outlined '
        'in the offering documents and confirmed by the administrator.'
    ))
    story.append(bl(
        'STT Capital Advisors, LLC conducts a quarterly oversight review of the valuations '
        'to ensure alignment with the fund\u2019s stated policies and procedures.'
    ))
    story.append(bl(
        'All valuations are subject to verification through annual fund audits performed by '
        'an independent PCAOB-registered accounting firm.'
    ))
    story.append(sp(4))
    story.append(warn_box([
        'Note: STT Capital Advisors, LLC does not independently calculate daily NAVs, nor '
        'does it hold discretionary authority over pricing overrides. The firm relies on '
        'NAV Fund Services to maintain accurate, independent valuation processes.'
    ]))
    story.append(sp(6))


# =============================================================================
#  SECTION 6 \u2014 PRIVACY \u2014 PROTECTION OF NON-PUBLIC INFORMATION
# =============================================================================

def build_section_6(story):
    story.append(head('6. Privacy \u2014 Protection of Non-Public Information',
                       'SECTION 6', is_article=True))
    story.append(section_spacer())

    # 6.1 Insider Trading
    story.append(Paragraph('6.1 Insider Trading', H2))
    story.append(p(
        '<b>Background:</b> In order to protect an employee against liability, the Firm '
        'maintains a written insider trading policy in accordance with the \u201cInsider '
        'Trading &amp; Securities Fraud Enforcement Act of 1988\u201d (\u201cITSFEA\u201d). '
        'ITSFEA requires Investment Advisers to adopt and enforce written policies and '
        'procedures that are reasonably designed to prevent such abuses by less than honest '
        'employees. ITSFEA is required to prevent employees from engaging in insider '
        'information or misusing non-public material or information.'
    ))
    story.append(p(
        '<b>Policy:</b> Employees of the Firm may have access to material nonpublic '
        'information (\u201cMNPI\u201d). It is both unlawful and improper for any person to '
        'trade securities for themselves or Clients while in possession of material nonpublic '
        'information or selectively to disclose such information to others who may trade. '
        'Violation of these provisions may result in civil and criminal penalties, including '
        'fines and jail sentences, as well as sanctions or termination from the Firm.'
    ))
    story.append(p(
        'Nonpublic information consists of any information that has not been disclosed '
        'generally to the marketplace. Information received about the company that is not '
        'yet in general circulation should be considered nonpublic. As a general rule, one '
        'should be able to point to some fact to show that the information is widely '
        'available; for example, its publication in The Wall Street Journal or in other '
        'major news publications. Even if a company has released information to the press, '
        'at least 24 hours must be allowed for the general marketplace to learn of and '
        'evaluate that information before you are allowed to trade in the company\u2019s '
        'securities.'
    ))
    story.append(p(
        'Material information is any information about a company or the market for the '
        'company\'s securities that is likely to be considered important by reasonable '
        'investors, including reasonable speculative investors, in determining whether to '
        'trade. Information that affects the price of the company\'s securities is likely '
        'to be deemed material.'
    ))
    story.append(sp(4))
    story.append(Paragraph('<b>Procedures:</b>', BOLD))
    story.append(p(
        'Whenever an Employee receives information about a company, he or she should '
        'refrain from trading while in possession of that information unless he or she '
        'first determines that the information is either public, non-material, or both. '
        'Employees must refrain from disclosing the information to others, such as family, '
        'relatives, colleagues, or social acquaintances who do not need to know it for '
        'legitimate business reasons. If an Employee believes he or she is in receipt of '
        'material nonpublic information, or if there is any question as to the material or '
        'nonpublic status of the information, he or she must immediately contact the Chief '
        'Compliance Officer and <u>only the Chief Compliance Officer</u>.'
    ))
    story.append(p(
        'The Firm requires that all Employees must document any meetings they may have with '
        'company management of a publicly traded company. Each Employee must evaluate '
        'whether any materials received during the meeting constitute MNPI and, if so, '
        'contact the CCO immediately.'
    ))
    story.append(p(
        'Any securities in which the CCO believes employees, including part-time employees '
        'and independent contractors, have material non-public information will be placed on '
        'a restricted securities list. The restricted list will be provided to the investment '
        'team who will be instructed not to trade in such securities.'
    ))
    story.append(sp(6))

    # 6.2 Protection of Nonpublic Personal Information
    story.append(Paragraph('6.2 Protection of Nonpublic Personal Information', H2))
    story.append(p(
        '<b>Background:</b> As an Exempt Reporting Adviser (ERA), STT Capital Advisors, LLC '
        'is not directly subject to Regulation S-P, but the firm voluntarily aligns with its '
        'principles to protect investor privacy and data integrity. Although the firm does '
        'not engage with retail clients, it treats investor and fund-level information with '
        'institutional-grade confidentiality.'
    ))
    story.append(p(
        '<b>Policy:</b> The Firm does not share any nonpublic personal information with any '
        'nonaffiliated third parties, except in the following circumstances:'
    ))
    story.append(bl(
        'As necessary to provide the service that the client has requested or authorized, '
        'or to maintain and service the client\u2019s account;'
    ))
    story.append(bl(
        'As required by regulatory authorities or law enforcement officials who have '
        'jurisdiction over the Firm or as otherwise required by any applicable law; or'
    ))
    story.append(bl(
        'To the extent reasonably necessary to prevent fraud and unauthorized transactions.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Security of Client Information:</b>', BOLD))
    story.append(p(
        'The Firm restricts access to nonpublic personal information to Employees who need '
        'to know such information to provide services to Investors and Clients. Any Employee '
        'who is authorized to have access to nonpublic personal information is required to '
        'keep such information in a secure, locked compartment on a daily basis as of the '
        'close of business each day. All electronic or computer files containing such '
        'information must be password secured and firewall protected from access by '
        'unauthorized persons.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Privacy Policy:</b>', BOLD))
    story.append(p(
        'STT Capital Advisors (\u201cSTT\u201d) may collect nonpublic information to process '
        'and administer clients\u2019 business and to ensure that we are satisfying their '
        'financial needs. This includes:'
    ))
    story.append(bl(
        'Information provided to STT Capital Advisors, LLC, such as on applications, '
        'questionnaires, contracts, or other forms.'
    ))
    story.append(bl(
        'Transactions, account balances, account history, and transactions with us, '
        'affiliates or third parties.'
    ))
    story.append(bl('Information provided by clients and their representatives.'))
    story.append(sp(4))

    story.append(Paragraph('<b>Security Measures:</b>', BOLD))
    story.append(bl(
        'Physical safeguards including restricted elevator access to its offices and '
        'full-time staffed reception desk to check people who arrive at the office.'
    ))
    story.append(bl(
        'Electronic safeguards including firewalls for server database protection, '
        'passwords for computer login for on-site computers, and limited access to the '
        'off-site computer room.'
    ))
    story.append(bl(
        'Restricting access to client information to those required to have access in '
        'order to service client needs.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Disposal of Nonpublic Personal Information:</b>', BOLD))
    story.append(bl(
        'Hard copy materials are shredded or securely destroyed when no longer needed.'
    ))
    story.append(bl('Digital media are encrypted and wiped to prevent restoration.'))
    story.append(bl(
        'The CCO verifies that no backup or residential data remains on local or cloud systems.'
    ))
    story.append(bl(
        'Third-party vendors with access to NPI must follow comparable data destruction '
        'procedures.'
    ))
    story.append(sp(4))

    story.append(Paragraph(
        '<b>Additional Procedures for Massachusetts Residents:</b>', BOLD
    ))
    story.append(p(
        'For the purposes of the procedures in this sub-section, \u201cpersonal '
        'information\u201d includes a Massachusetts resident\u2019s first and last name '
        'and any of the following: a) social security number; b) driver\u2019s license '
        'number; or c) financial account number (e.g., bank, credit card, etc.). To the '
        'extent that a client or investor is a Massachusetts resident, the Firm will '
        'implement the following procedures:'
    ))
    story.append(bl(
        'Any personal information maintained or stored on a mobile device (e.g., laptop or '
        'smart phone) will be stored in an encrypted format.'
    ))
    story.append(bl(
        'To the extent technically feasible, any personal information transmitted wirelessly '
        'or across a public network will be transmitted in an encrypted format.'
    ))
    story.append(bl(
        'The Firm will take reasonable steps to ensure that its service providers who have '
        'access to the personal information of the Firm\u2019s Clients or Investors will '
        'implement and maintain appropriate security measures for the information.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Privacy Notices:</b>', BOLD))
    story.append(p(
        'STT Capital Advisors, LLC provides a privacy policy to investors at the time of '
        'subscription and as otherwise required under applicable fund subscription and '
        'offering documents, including in connection with the delivery of audited financial '
        'statements.'
    ))
    story.append(bl(
        'Material changes in policy are communicated to investors without delay.'
    ))
    story.append(sp(6))


# =============================================================================
#  SECTION 7 \u2014 MARKETING AND COMMUNICATIONS
# =============================================================================

def build_section_7(story):
    story.append(head('7. Marketing and Communications', 'SECTION 7', is_article=True))
    story.append(section_spacer())

    # 7.1 Advertising and Marketing Materials
    story.append(Paragraph('7.1 Advertising and Marketing Materials', H2))
    story.append(p(
        '<b>Background:</b> STT Capital Advisors, LLC, while operating as an Exempt Reporting '
        'Adviser (\u201cERA\u201d), voluntarily adheres to the principles of Rule 206(4)-1 '
        '(the \u201cMarketing Rule\u201d) under the Investment Advisers Act of 1940 to align '
        'with institutional expectations, industry best practices, and due diligence standards '
        'applicable to private fund advisers.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>The definition of \u201cadvertisement\u201d includes:</b>', BOLD))
    story.append(bl(
        'Communications offering advisory services to prospective investors in private '
        'funds managed by STT Capital Advisors, LLC;'
    ))
    story.append(bl('Offers of new advisory services to current investors;'))
    story.append(bl(
        'Compensated testimonials and endorsements, including one-on-one solicitations '
        '(unless specifically excluded).'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Exclusions from \u201cadvertisement\u201d include:</b>', BOLD))
    story.append(bl('One-on-one communications not involving hypothetical performance;'))
    story.append(bl('Live, oral, and extemporaneous communications;'))
    story.append(bl(
        'Statutorily required filings or investor notices reasonably designed to satisfy '
        'legal obligations.'
    ))
    story.append(sp(4))

    story.append(p(
        '<b>Policy:</b> All marketing materials, presentations, digital content, and '
        'performance communications must be pre-approved in writing by the Chief Compliance '
        'Officer (CCO) prior to distribution. STT Capital Advisors, LLC prohibits the use '
        'of advertisements that are materially misleading, include unsubstantiated claims, '
        'or omit key facts.'
    ))
    story.append(sp(4))

    story.append(Paragraph(
        '<b>General Prohibitions and Compliance Requirements:</b>', BOLD
    ))
    story.append(p('Advertisements disseminated by STT Capital Advisors, LLC shall not:'))
    story.append(bl('Include untrue statements of material fact;'))
    story.append(bl('Omit material facts necessary to avoid misleading inferences;'))
    story.append(bl(
        'Include performance data or benefit statements without fair, balanced disclosures '
        'of associated risks;'
    ))
    story.append(bl('Cherry-pick performance or highlight only favorable results;'))
    story.append(bl(
        'Reference investment advice without equal prominence of risk disclosures;'
    ))
    story.append(bl(
        'Present hypothetical or predecessor results without meeting SEC-prescribed criteria.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Testimonial and Endorsements:</b>', BOLD))
    story.append(p(
        'STT Capital Advisors, LLC may use testimonials or endorsements only if:'
    ))
    story.append(bl(
        'The source is clearly identified as a current or former client, or unrelated '
        'third party;'
    ))
    story.append(bl(
        'Material conflicts of interest and compensation terms are prominently disclosed;'
    ))
    story.append(bl(
        'A written agreement exists with any compensated promoter, unless compensation is '
        '$1,000 or less (de minimis);'
    ))
    story.append(bl(
        'Due diligence is performed to confirm the promoter is not ineligible under '
        'disqualification rules;'
    ))
    story.append(bl(
        'Oversight of disclosures and periodic monitoring is conducted by the CCO, '
        'including spot checks.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Third Party Ratings:</b>', BOLD))
    story.append(p('Third-party ratings may be used in advertising if:'))
    story.append(bl(
        'The ratings are developed in the ordinary course of the rater\u2019s business, '
        'and not tailored for STT Capital Advisors, LLC;'
    ))
    story.append(bl(
        'STT Capital Advisors, LLC has a reasonable basis to believe the rating methodology '
        'is fair and balanced;'
    ))
    story.append(bl(
        'Disclosures are made regarding the rating date, period covered, provider identity, '
        'and any compensation provided in connection with the rating.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Performance Advertising:</b>', BOLD))
    story.append(p(
        'STT Capital Advisors, LLC may only present performance advertising if:'
    ))
    story.append(bl('Net returns are shown alongside any gross return figures;'))
    story.append(bl('All relevant time periods are stated clearly and consistently;'))
    story.append(bl(
        'Disclosures include the limits of back-tested or hypothetical returns, including '
        'assumptions and model limitations;'
    ))
    story.append(bl('All data is supported by documentation available upon regulator request;'))
    story.append(bl(
        'Disclosures clarify that past performance is not indicative of future results.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Backtested Models:</b>', BOLD))
    story.append(bl(
        'Disclosure that the performance obtained through hypothetical or back-tested '
        'strategies does not result from actual trading and there is no market risk involved '
        'in the results;'
    ))
    story.append(bl(
        'Disclosure that the \u201cresults\u201d are hypothetical and often created with the '
        'benefit of hindsight and that it may be difficult, if not impossible, to account for '
        'all of the factors that might have affected a manager\u2019s decision making process;'
    ))
    story.append(bl(
        'Disclosure that hypothetical or back-tested performance often involves certain '
        'material assumptions in applying investment decisions that might have been made, '
        'based on the investment theory espoused, during the relevant historical period and '
        'the data set chosen may not be indicative of present or future market conditions;'
    ))
    story.append(bl(
        'Disclosure that there are often sharp differences between hypothetical performance '
        'results and actual returns subsequently achieved;'
    ))
    story.append(bl(
        'Disclosure that past results are not indicative of future performance; and'
    ))
    story.append(bl(
        'Disclosure that results are net of management and transaction fees.'
    ))
    story.append(sp(6))

    # 7.2 Email Communication
    story.append(Paragraph('7.2 Email Communication', H2))
    story.append(p(
        '<b>Policy:</b> All email communications are considered business records and are '
        'archived accordingly. The CCO will conduct quarterly reviews of electronic '
        'communications for compliance with policies and procedures.'
    ))
    story.append(p(
        'STT Capital Advisors, LLC prohibits employees from using personal or unapproved '
        'communication channels for investor interaction or business activity. Social media '
        'use for business purposes is not permitted without prior approval, archiving, and '
        'oversight.'
    ))
    story.append(sp(6))

    # 7.3 Social Media Policy
    story.append(Paragraph('7.3 Social Media Policy', H2))
    story.append(p(
        'STT Capital Advisors, LLC (\u201cthe Firm\u201d) prohibits the use of social media '
        'for business purposes unless explicitly pre-approved in writing by the Chief '
        'Compliance Officer (CCO). As a smaller sized firm as an Exempt Reporting Adviser '
        '(ERA) managing a private hedge fund under Regulation D, Rule 506(c), Section '
        '3(c)(1), the Firm does not currently maintain or monitor business social media '
        'accounts.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Business Use of Social Media:</b>', BOLD))
    story.append(p(
        'The Firm does not permit the use of social media platforms (e.g., LinkedIn, '
        'Facebook, Twitter, Instagram) for any business-related communications, marketing, '
        'or solicitation unless the CCO has explicitly granted written approval. No employee '
        'may open or post to a business-related social media account on behalf of the Firm '
        'without prior written consent.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Personal Use of Social Media:</b>', BOLD))
    story.append(p(
        'Firm personnel may use social media for personal purposes during non-work hours '
        'using personal devices. However, employees must refrain from discussing the Firm\u2019s '
        'business activities, Clients, strategies, or proprietary information on any social '
        'platform. Any reference to the Firm must be limited to factual information such as '
        'job title, employer name, and years of service.'
    ))
    story.append(p('Employees must not:'))
    story.append(bl('Present themselves as speaking on behalf of the Firm.'))
    story.append(bl('Provide or imply investment advice or recommendations.'))
    story.append(bl('Disclose any confidential or nonpublic information.'))
    story.append(bl('Interact with investors or prospects regarding Firm-related content.'))
    story.append(sp(4))

    story.append(Paragraph('<b>Ongoing Monitoring:</b>', BOLD))
    story.append(p(
        'The Firm does not conduct routine monitoring of personal social media activity. '
        'However, if a violation of this policy is discovered or reported, it will be '
        'reviewed by the CCO and appropriate action will be taken.'
    ))
    story.append(sp(6))

    # 7.4 Media Interview Procedures
    story.append(Paragraph('7.4 Media Interview Procedures', H2))
    story.append(p(
        '<b>Policy:</b> These procedures apply to interviews of STT Capital Advisors LLC '
        'Employees by unaffiliated news organizations where the interview will be broadcast '
        'or disseminated by the news organization and where the Firm does not pay for the '
        'interview to be conducted. STT Capital Advisors LLC will not itself broadcast, '
        'disseminate, or pay for any interviews and will not conduct interviews except '
        'through an unaffiliated news organization.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Pre-Interview Preparation:</b>', BOLD))
    story.append(bl(
        'Employees should obtain from the interviewer a list of proposed topics or questions '
        'to be asked during the interview. The Employee and CCO, or his designee, must review '
        'this list and discuss how the Employee should address these topics or questions.'
    ))
    story.append(bl(
        'The interviewer must be apprised of the restrictions that are placed on the '
        'Employee with respect to the interview including, but not limited to, an absolute '
        'prohibition on questions regarding the Fund Clients. A commitment must be obtained '
        'from the interviewer to respect those restrictions.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>The Interview:</b>', BOLD))
    story.append(bl(
        'Employees may discuss their views as to expectations for the economy, or expected '
        'performance of individual sectors or industries.'
    ))
    story.append(bl(
        'Employees may not discuss future or potential purchases or sales of securities by '
        'any of the Firm\u2019s Clients. Employees should refrain from discussing all '
        'securities that are under active consideration for purchase or sale by any Clients.'
    ))
    story.append(bl('Employees may not discuss the past performance of Clients.'))
    story.append(bl(
        'If an Employee discusses a particular security, the Employee may not disclose '
        'whether the Clients own the security. Employees must limit their discussions as to '
        'specific securities to publicly available information already disclosed to the '
        'public by the issuer of the security.'
    ))
    story.append(bl(
        'Employees may discuss the past performance of securities in Clients\u2019 portfolios '
        'and reasons why the Firm continues to hold the security. Employees may not discuss '
        'expected future performance or price targets of specific securities held by Clients '
        'but may provide general views as to the business prospects of the issuer of the '
        'security.'
    ))
    story.append(bl(
        'Employees may not discuss any security in an attempt to manipulate the market '
        'price of the security.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Helpful Reminders:</b>', BOLD))
    story.append(bl(
        'Employees should keep in mind that the press generally does not appreciate your '
        'regulatory requirements regarding what you can/cannot say.'
    ))
    story.append(bl(
        'Be careful not to disclose any confidential information.'
    ))
    story.append(bl(
        'Refrain from any exaggerated or misleading statements or claims, or forecasts of '
        'future trends which are not supported by a basis in fact, or which are not clearly '
        'labeled as forecasts.'
    ))
    story.append(sp(6))


# =============================================================================
#  SECTION 8 \u2014 BOOKS AND RECORDS
# =============================================================================

def build_section_8(story):
    story.append(head('8. Books and Records', 'SECTION 8', is_article=True))
    story.append(section_spacer())
    story.append(p(
        '<b>Background:</b> Although STT Capital Advisors, LLC is not a registered investment '
        'adviser, as an Exempt Reporting Adviser (\u201cERA\u201d), the Firm voluntarily '
        'complies with the relevant books and records requirements under Rule 204-2 of the '
        'Investment Advisers Act of 1940 to the extent applicable. These records support '
        'internal controls, investor reporting, and audit preparedness, and ensure adherence '
        'to fiduciary best practices and industry standards.'
    ))
    story.append(p(
        '<b>Policy:</b> The Firm maintains and preserves records related to its advisory '
        'business in an easily accessible and secure location for a minimum of five (5) '
        'years, consistent with industry expectations. These include:'
    ))
    story.append(bl('Fund offering and investor documentation'))
    story.append(bl('Trade records and reconciliations'))
    story.append(bl('Subscription agreements and investor correspondence'))
    story.append(bl('Compliance policies, logs, and checklists'))
    story.append(bl('Regulatory filings and audit materials'))
    story.append(bl('Email and electronic communications (as required)'))
    story.append(p(
        'For the first two years, records will be maintained at the Firm\u2019s primary '
        'place of business or on secure, access-controlled cloud servers that are directly '
        'accessible by the Firm.'
    ))
    story.append(p(
        'Where the Firm is contractually required (e.g., for ERISA plan investors or QPAM '
        'documentation), records will be maintained for six (6) years to comply with relevant '
        'exemptions or contractual provisions.'
    ))
    story.append(p(
        'Electronic records are considered compliant with Rule 204-2 if they are immediately '
        'accessible through secure local or cloud-based systems under the Firm\u2019s direct '
        'control.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Email and Electronic Communication Policy:</b>', BOLD))
    story.append(bl('The Firm retains all business-related email and instant messages.'))
    story.append(bl(
        'Spam, personal messages, and non-business communications may be deleted or excluded '
        'from archive protocols.'
    ))
    story.append(bl(
        'Employees are prohibited from using personal or external messaging accounts for '
        'business purposes unless such usage is explicitly approved and archived.'
    ))
    story.append(bl(
        'Any business-related communication sent from a personal account must be immediately '
        'forwarded to the employee\u2019s Firm email account.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Procedures:</b>', BOLD))
    story.append(p(
        'The Chief Compliance Officer (CCO) is responsible for maintaining the Firm\u2019s '
        'books and records and ensuring required records are current and complete.'
    ))
    story.append(bl(
        'The CCO will perform a quarterly review and a more comprehensive annual review of '
        'the Firm\u2019s cloud-based and physical file systems to confirm:'
    ))
    story.append(bl2('Completeness of investor documentation'))
    story.append(bl2('Accuracy of fund-level trade and valuation records'))
    story.append(bl2('Retention of compliance, fee, and regulatory materials'))
    story.append(bl(
        'This review may be performed in conjunction with a mock audit or broader compliance '
        'review.'
    ))
    story.append(bl(
        'Exhibit A of this manual outlines the types of records maintained, retention '
        'periods, and the employees responsible for their maintenance.'
    ))
    story.append(sp(6))


# =============================================================================
#  SECTION 9 \u2014 REGULATORY COMPLIANCE \u2014 FORM ADV
# =============================================================================

def build_section_9(story):
    story.append(head('9. Regulatory Compliance \u2014 Form ADV', 'SECTION 9',
                       is_article=True))
    story.append(section_spacer())
    story.append(p(
        '<b>Form ADV and Amendment Procedures (ERA Status):</b> STT Capital Advisors, LLC '
        '(\u201cthe Firm\u201d) is registered with the Securities and Exchange Commission '
        '(\u201cSEC\u201d) as an Exempt Reporting Adviser (\u201cERA\u201d) under Rule 204-4 '
        'of the Investment Advisers Act of 1940. As an ERA, the Firm is required to file '
        'Form ADV Part 1A electronically through the Investment Adviser Registration '
        'Depository (IARD) system.'
    ))
    story.append(warn_box([
        'Note: As an ERA, the Firm is not required to file or deliver Form ADV Part 2A '
        '(Brochure), though it may elect to prepare and maintain a Part 2A for internal use '
        'or voluntary disclosure to investors.'
    ]))
    story.append(sp(4))
    story.append(p('The Firm will ensure that its Form ADV Part 1A is updated as follows:'))
    story.append(bl(
        '<b>Annually</b> \u2014 within 90 days after the end of each fiscal year, and'
    ))
    story.append(bl(
        '<b>Promptly</b> \u2014 within 30 days, for material updates to information '
        'specified in the Form ADV instructions.'
    ))
    story.append(p(
        'Although not required to file Form ADV Part 2A, the Firm will ensure that any '
        'material change to the Firm\u2019s structure, fees, control persons, investment '
        'strategy, or other disclosures is documented internally and appropriately reflected '
        'in the fund\u2019s Private Placement Memorandum (PPM) or Limited Partnership '
        'Agreement (LPA), as applicable.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Amendment Categories for ERAs:</b>', BOLD))
    story.append(Paragraph('<b>Prompt Amendments Are Required If:</b>', BOLD))
    story.append(bl('The Firm\u2019s name, principal place of business, or contact information changes'))
    story.append(bl('There is a change in books and records location or responsible contact'))
    story.append(bl('The organization\u2019s legal form or control structure changes'))
    story.append(bl(
        'The status of disciplinary events involving the Firm or control persons changes'
    ))
    story.append(bl(
        'The Firm updates its policy on custody or affiliated service arrangements'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Internal Procedures:</b>', BOLD))
    story.append(bl('The Chief Compliance Officer (CCO) is responsible for:'))
    story.append(bl2('Monitoring whether Form ADV amendments are required'))
    story.append(bl2('Reviewing material developments that may impact Form ADV disclosures'))
    story.append(bl2('Timely preparation and submission of filings via IARD'))
    story.append(bl('Employees must notify the CCO of:'))
    story.append(bl2(
        'Any information they believe to be inaccurate, outdated, or omitted in the '
        'Firm\u2019s Form ADV Part 1A'
    ))
    story.append(bl2(
        'Any operational, structural, or organizational changes that may trigger an '
        'amendment filing'
    ))
    story.append(sp(6))


# =============================================================================
#  SECTION 10 \u2014 REGULATORY COMPLIANCE \u2014 FORM D AND BLUE SKY
# =============================================================================

def build_section_10(story):
    story.append(head('10. Regulatory Compliance \u2014 Form D and Blue Sky',
                       'SECTION 10', is_article=True))
    story.append(section_spacer())
    story.append(p(
        '<b>Policy:</b> STT Capital Advisors, LLC offers and sells interests in its hedge '
        'fund through exemptions provided under Regulation D, Rule 506(c) of the Securities '
        'Act of 1933. As such, the Firm is required to file a Form D with the Securities '
        'and Exchange Commission (SEC) within 15 calendar days of the first sale of '
        'securities in each exempt offering. Form D is a notice filing and not a registration, '
        'and it contains basic information about the offering, the issuer, and certain '
        'related persons.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Ongoing Requirements:</b>', BOLD))
    story.append(p('The Chief Compliance Officer (CCO) is responsible for:'))
    story.append(bl(
        'Preparing and filing the initial Form D for each fund\u2019s exempt offering '
        'within 15 days of the first sale.'
    ))
    story.append(bl(
        'Filing amendments to Form D as required by Rule 503 of Regulation D in the '
        'following cases:'
    ))
    story.append(bl2(
        'To correct any material mistake or factual error, as soon as practicable upon discovery.'
    ))
    story.append(bl2(
        'To reflect material changes to the offering, unless exempted (see list below).'
    ))
    story.append(bl(
        'Filing an annual amendment on or before the one-year anniversary of the last filed '
        'Form D if the offering is still ongoing.'
    ))
    story.append(sp(4))

    story.append(Paragraph(
        '<b>Amended Form D is <i>not</i> required for changes solely related to:</b>', BOLD
    ))
    story.append(bl('Updates to addresses or relationships of related persons.'))
    story.append(bl('Net asset value or revenue of the issuer.'))
    story.append(bl(
        'Minimum investment amounts (if increase or \u226410% decrease).'
    ))
    story.append(bl(
        'Total offering amount (if decrease or \u226410% increase).'
    ))
    story.append(bl(
        'Number of non-accredited investors (as long as it does not exceed 35).'
    ))
    story.append(bl('Total number of investors.'))
    story.append(bl(
        'Decrease in use of proceeds or commissions paid to executives/promoters.'
    ))
    story.append(sp(4))

    story.append(Paragraph(
        '<b>Blue Sky Filings (State Notice Filings):</b>', BOLD
    ))
    story.append(p(
        'In addition to SEC Form D filings, state \u201cBlue Sky\u201d laws require notice '
        'filings in each U.S. state where securities are offered or sold. These filings '
        'typically include:'
    ))
    story.append(bl('A copy of the SEC-filed Form D;'))
    story.append(bl('A state-specific notice filing form (if required); and'))
    story.append(bl('A filing fee.'))
    story.append(p(
        'The Firm relies on its internal tracking of investor domicile to determine '
        'applicable state-level requirements. The CCO is responsible for:'
    ))
    story.append(bl('Monitoring the state of residence of each new investor;'))
    story.append(bl(
        'Ensuring timely Blue Sky filings are submitted as required by each state; and'
    ))
    story.append(bl(
        'Maintaining documentation and evidence of filings for compliance and audit readiness.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Procedures:</b>', BOLD))
    story.append(p(
        '1. The CCO files Form D within 15 calendar days of the first sale of securities.'
    ))
    story.append(p(
        '2. The CCO ensures ongoing monitoring of offering activity, including tracking '
        'investor states of residence.'
    ))
    story.append(p(
        '3. The CCO is responsible for making state-level Blue Sky filings in each '
        'jurisdiction where required, based on investor participation.'
    ))
    story.append(p(
        '4. All filings are maintained as part of the Firm\u2019s regulatory records.'
    ))
    story.append(sp(6))


# =============================================================================
#  SECTION 11 \u2014 CYBERSECURITY
# =============================================================================

def build_section_11(story):
    story.append(head('11. Cybersecurity', 'SECTION 11', is_article=True))
    story.append(section_spacer())

    # 11.1 Overview
    story.append(Paragraph('11.1 Overview', H2))
    story.append(p(
        'STT Capital Advisors, LLC (\u201cSTT Capital Advisors\u201d or the \u201cFirm\u201d) '
        'has developed and implemented a written Cybersecurity Program (\u201cWCP\u201d) to '
        'safeguard the Firm\u2019s technology systems and protect the personal and confidential '
        'information of its Clients, Investors, and Employees. The objective of the WCP is '
        'to ensure that the Firm maintains effective administrative, technical, and physical '
        'security controls to mitigate cybersecurity risks in a manner that is reasonable '
        'given the Firm\u2019s size, complexity, and business operations. This WCP evaluates '
        'how the Firm accesses, stores, transmits, and protects electronic and physical '
        'information. All Employees share responsibility in maintaining cybersecurity and '
        'must comply with the policies and procedures described herein.'
    ))
    story.append(sp(6))

    # 11.2 Program Details
    story.append(Paragraph('11.2 Program Details', H2))
    story.append(p(
        'Cindy Eagar of STT Capital Advisors LLC is designated as the Managing Member, '
        'Chief Operating Officer &amp; Chief Information Security Officer and is responsible '
        'for the implementation, supervision, and maintenance of the WCP. Responsibilities '
        'include:'
    ))
    story.append(bl('Implementing the WCP and maintaining documentation;'))
    story.append(bl(
        'Conducting cybersecurity training for Employees at hire and annually;'
    ))
    story.append(bl(
        'Coordinating regular vulnerability testing and reviews in partnership with the '
        'Firm\u2019s designated IT service provider;'
    ))
    story.append(bl(
        'Conducting annual reviews of third-party service providers who access sensitive '
        'data to ensure appropriate security controls;'
    ))
    story.append(bl(
        'Reviewing and updating the WCP at least annually and after any material changes '
        'to the Firm\u2019s technology or data usage;'
    ))
    story.append(bl(
        'Maintaining signed certifications of training from all individuals with system '
        'access.'
    ))
    story.append(sp(6))

    # 11.3 Risk Assessment and Governance
    story.append(Paragraph('11.3 Risk Assessment and Governance', H2))
    story.append(p(
        'To combat internal risks to the security, confidentiality, and/or integrity of '
        'any electronic records containing personal information, and evaluating and '
        'improving, where necessary, the effectiveness of the current safeguards for '
        'limiting such risks, the following measures are mandatory and are effective '
        'immediately. The Firm has identified the following risks that are present to its '
        'business as well as procedures to help mitigate those risks:'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>11.3.1 Internal Threats</b>', H3))
    story.append(p('The Firm has adopted the following controls to address internal risks '
                    'to Client or Investor data:'))
    story.append(bl('Distribution of the current WCP to all Employees;'))
    story.append(bl('Annual mandatory cybersecurity training;'))
    story.append(bl(
        'Limiting access to personal information to personnel with legitimate business needs;'
    ))
    story.append(bl('Prohibiting use of personal devices unless explicitly approved;'))
    story.append(bl(
        'Immediate removal of system access and recovery of Firm materials from terminated '
        'personnel;'
    ))
    story.append(bl('Changing employee passwords at least annually;'))
    story.append(bl(
        'Reporting of suspected security incidents or unauthorized activity to the CCO;'
    ))
    story.append(bl('Prohibiting screen exposure of sensitive data when unattended;'))
    story.append(bl(
        'Restricting sharing of login credentials and maintaining password confidentiality;'
    ))
    story.append(bl(
        'CCO oversight to ensure secure hardware placement and system access controls.'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>11.3.2 External Threats</b>', H3))
    story.append(p(
        'The Firm\u2019s external threat protection is managed by Cindy Eagar, Managing '
        'Member, COO &amp; CISO, who is responsible for:'
    ))
    story.append(bl('Maintaining updated firewall protection and OS security patches;'))
    story.append(bl(
        'Installing and monitoring system security software (e.g., malware and antivirus '
        'tools);'
    ))
    story.append(bl(
        'Encrypting sensitive data on laptops and transmitted over public networks;'
    ))
    story.append(bl(
        'Monitoring the Firm\u2019s IT environment for intrusion or irregular activity;'
    ))
    story.append(bl(
        'Documenting and reporting cybersecurity risk evaluations annually.'
    ))
    story.append(sp(6))

    # 11.4 Vendor and Third-Party Risks
    story.append(Paragraph('11.4 Vendor and Third-Party Risks', H2))
    story.append(p(
        'STT Capital Advisors LLC conducts periodic due diligence on all third-party vendors '
        'with access to the Firm\u2019s systems, client records, or sensitive data. The CCO '
        'or designee is responsible for assessing the adequacy of vendor cybersecurity '
        'measures and documenting findings in the Firm\u2019s compliance records.'
    ))
    story.append(sp(6))

    # 11.5 Detection of Unauthorized Activity
    story.append(Paragraph('11.5 Detection of Unauthorized Activity', H2))
    story.append(p(
        'The Firm defines \u201cunauthorized activity\u201d as any event that may compromise '
        'the confidentiality, integrity, or availability of systems or data. Examples include:'
    ))
    story.append(bl('Unauthorized access or hacking;'))
    story.append(bl('Malware, viruses, or ransomware attacks;'))
    story.append(bl('Denial of service (DoS) incidents;'))
    story.append(bl('Misuse of Firm systems to target third-party networks.'))
    story.append(p(
        '<b>Employee Procedure:</b> Any Employee who suspects unauthorized access must '
        'immediately notify the CCO. The affected device should remain powered on and '
        'unchanged to preserve forensic evidence. Disciplinary action, up to and including '
        'termination, may be taken for negligent or intentional violations of the WCP.'
    ))
    story.append(p(
        'If a non-Employee is suspected, the matter will be escalated to the CCO and may '
        'be referred to law enforcement or regulators as appropriate.'
    ))
    story.append(sp(6))

    # 11.6 Updates to the Cybersecurity Program
    story.append(Paragraph('11.6 Updates to the Cybersecurity Program', H2))
    story.append(p(
        'The WCP is reviewed at least annually by the CCO. Updates are made based on '
        'operational changes, threat intelligence, and control testing. All material updates '
        'or identified vulnerabilities are reported to senior management, along with '
        'recommendations for remediation. In the event of a security breach or attempted '
        'breach, the CCO will conduct a post-incident review and determine if adjustments '
        'to the WCP are necessary to enhance protections and prevent recurrence.'
    ))
    story.append(sp(6))


# =============================================================================
#  SECTION 12 \u2014 CODE OF ETHICS (INCORPORATION BY REFERENCE)
# =============================================================================

def build_section_12(story):
    story.append(head('12. Code of Ethics', 'SECTION 12 \u2014 INCORPORATED BY REFERENCE',
                       is_article=True))
    story.append(section_spacer())

    story.append(warn_box([
        'INCORPORATION BY REFERENCE: The Firm maintains a separate, standalone Code of '
        'Ethics Manual adopted pursuant to Rule 204A-1 under the Investment Advisers Act '
        'of 1940. That document is incorporated herein by reference in its entirety and '
        'forms an integral part of this Policies and Procedures Manual.'
    ]))
    story.append(sp(6))

    story.append(p(
        'As a fiduciary, STT Capital Advisors, LLC owes its Clients the highest duty of '
        'loyalty and relies on each Employee to avoid conduct that is or may be inconsistent '
        'with that duty. It is also important for Employees to avoid actions that, while they '
        'may not actually involve a conflict of interest or an abuse of a Client\u2019s '
        'trust, may have the appearance of impropriety.'
    ))
    story.append(p(
        'The standalone PNTHR Code of Ethics Manual covers the following topics in full '
        'detail:'
    ))

    topics = [
        'Statement of General Policy',
        'Definitions (Covered Accounts, Beneficial Ownership, Excepted Securities)',
        'Standards of Business Conduct',
        'Access Persons',
        'Custodial Account Reporting',
        'Confidentiality and Privacy Policy',
        'Social Media Policy',
        'Prohibition Against Insider Trading',
        'Preclearance of Personal Trading',
        'Personal Securities Transactions',
        'Personal Securities Trading Limitations',
        'Margin Transactions and Limit Orders',
        'Pre-Approval for Affiliated Private Fund Investments',
        'Interested Transactions',
        'Outside Business Activities',
        'Service as an Officer or Director',
        'Gifts and Entertainment Policy',
        'Blackout Periods',
        'Rumor Mongering Policy',
        'Compliance Procedures and Sanctions',
        'Whistleblower Policy',
        'Records Retention Policy',
    ]
    for topic in topics:
        story.append(bl(topic))

    story.append(sp(6))
    story.append(p(
        'All Employees are required to read, acknowledge, and certify their understanding '
        'of the Code of Ethics on an annual basis using the Certification and Acknowledgement '
        'of Receipt form (Exhibit B of this Manual, and also included as Exhibit B of the '
        'Code of Ethics Manual).'
    ))
    story.append(p(
        'The Code of Ethics Manual is available from the Chief Compliance Officer upon '
        'request and is distributed to all Employees at the time of hire.'
    ))
    story.append(sp(6))


# =============================================================================
#  EXHIBIT A \u2014 RECORD RETENTION TABLE
# =============================================================================

def build_exhibit_a(story):
    story.append(PageBreak())
    story.append(head('Exhibit A: Record Retention Table', is_article=True))
    story.append(section_spacer())
    story.append(p(
        'This Record Retention Policy outlines the documents that STT Capital Advisors, LLC '
        '(the \u201cFirm\u201d) must maintain in accordance with regulatory obligations '
        'under the Investment Advisers Act of 1940, as an Exempt Reporting Adviser (ERA), '
        'and applicable best practices.'
    ))
    story.append(sp(6))

    rows = [
        ['#', 'Document Category', 'Required Documents', 'Retention Period',
         'Created By', 'Maintained By'],
        ['1', 'Corporate Records',
         'Articles of Incorporation, Bylaws, Minute Books, Stock Certificate Books',
         'Life of entity + 3 years', 'CCO', 'Compliance Officer'],
        ['2', 'Organizational Records',
         'Org chart, personnel directory, staff function descriptions',
         '5 years', 'CCO', 'Compliance Officer'],
        ['3', 'Policies & Procedures',
         'Compliance manual, insider trading, privacy, proxy voting policies (current and past)',
         '5 years', 'Compliance Officer', 'Compliance Officer'],
        ['4', 'Employee Trading Records',
         'Personal trading reports, IPO/Private Placement approvals, Access Person list',
         '5 years', 'Compliance Officer', 'Compliance Officer'],
        ['5', 'Registration Records',
         'SEC registration evidence',
         'Life of entity + 3 years', 'Compliance Officer', 'Compliance Officer'],
        ['6', 'Form ADV',
         'Initial and amendments',
         'Life of entity + 3 years', 'Compliance Officer', 'Compliance Officer'],
        ['7', 'State Filings',
         'Notices to states',
         'Life of entity + 3 years', 'Compliance Officer', 'Compliance Officer'],
        ['8', 'Disclosure Delivery',
         'ADV Part 2 brochures, delivery records, client requests',
         '5 years', 'CCO', 'Compliance Officer'],
        ['9', 'Client Agreements',
         'Investment advisory contracts, POAs, solicitation agreements',
         '5 years', 'CCO', 'Compliance Officer'],
        ['10', 'Marketing Materials',
         'Ads, newsletters, materials to 10+ persons',
         '5 years', 'Marketing / Compliance', 'Compliance Officer'],
        ['11', 'Performance Records',
         'Supporting records for performance data',
         '5 years from publication year-end', 'CCO', 'Compliance Officer'],
        ['12', 'Solicitor Records',
         'Agreements, disclosures, receipts, solicitor account lists',
         '5 years', 'CCO', 'Compliance Officer'],
        ['13', 'Financial Records',
         'Journals, ledgers, bank statements, bills, audit work papers',
         '5 years', 'Accounting', 'Accounting'],
        ['14', 'Trading Records',
         'Trade tickets, order memos, execution detail, client reports',
         '5 years', 'CCO', 'Compliance Officer'],
        ['15', 'Discretionary Authority',
         'Account list with discretion',
         '5 years', 'Compliance Officer', 'Compliance Officer'],
        ['16', 'Client Complaints',
         'Complaint files',
         '5 years', 'Compliance Officer', 'Compliance Officer'],
        ['17', 'Custody Records',
         'Custody agreements, transaction records, ledgers',
         '5 years', 'CCO', 'Compliance Officer'],
        ['18', 'SEC Ownership Reports',
         '13F, 13D/G, Forms 3, 4, 5',
         'Life of entity + 3 years', 'N/A', 'N/A'],
        ['19', 'Privacy Notices',
         'Annual privacy delivery record',
         '5 years', 'CCO', 'Compliance Officer'],
        ['20', 'Compliance Program',
         'Policy copies, annual reviews',
         '5 years', 'Compliance Officer', 'Compliance Officer'],
        ['21', 'Code of Ethics',
         'Current/past Code, violation records, acknowledgements',
         '5 years', 'Compliance Officer', 'Compliance Officer'],
        ['22', 'Proxy Voting',
         'Policies, vote records, client requests, responses',
         '5 years', 'Compliance Officer', 'Compliance Officer'],
        ['23', 'Internal Compliance',
         'Insider trading reviews, IPO approvals, ethics reviews',
         '5 years', 'Compliance Officer', 'Compliance Officer'],
    ]

    col_w = [0.3*inch, 1.0*inch, 1.8*inch, 1.0*inch, 0.9*inch, 0.9*inch]
    story.append(styled_table(rows, col_widths=col_w))
    story.append(sp(6))
    story.append(p(
        'This schedule shall be reviewed and updated by the CCO annually or as needed in '
        'response to regulatory changes or firm-specific developments.',
        SMALL
    ))
    story.append(sp(6))


# =============================================================================
#  EXHIBIT B \u2014 CERTIFICATION AND ACKNOWLEDGEMENT OF RECEIPT
# =============================================================================

def build_exhibit_b(story):
    story.append(PageBreak())
    story.append(head('Exhibit B: Certification and Acknowledgement of Receipt',
                       is_article=True))
    story.append(section_spacer())
    story.append(p(
        'I acknowledge and certify that I have received a copy of STT Capital Advisors\u2019 '
        'Policies and Procedures Manual and Code of Ethics. I understand and agree that it is '
        'my responsibility to read and familiarize myself with the policies and procedures '
        'contained in the Policies and Procedures Manual and Code of Ethics and to abide by '
        'those policies and procedures.'
    ))
    story.append(sp(30))

    sig_data = [
        ['Employee Name (Please Print)', 'Employee Signature'],
        ['_' * 40, '_' * 40],
    ]
    sig_tbl = Table(sig_data, colWidths=[BODY_W * 0.5, BODY_W * 0.5])
    sig_tbl.setStyle(TableStyle([
        ('FONT',        (0,0), (-1,0), FONT_BOLD, 9),
        ('FONT',        (0,1), (-1,1), FONT_REGULAR, 9),
        ('TOPPADDING',  (0,0), (-1,-1), 6),
        ('BOTTOMPADDING',(0,0), (-1,-1), 6),
        ('ALIGN',       (0,0), (-1,-1), 'LEFT'),
    ]))
    story.append(sig_tbl)
    story.append(sp(20))
    story.append(p('Date: _________________________', SIG_STYLE))
    story.append(sp(6))


# =============================================================================
#  EXHIBIT C \u2014 GIFT AND ENTERTAINMENT FORM
# =============================================================================

def build_exhibit_c(story):
    story.append(PageBreak())
    story.append(head('Exhibit C: Gift and Entertainment Form', is_article=True))
    story.append(section_spacer())
    story.append(p('STT Capital Advisors, LLC', BOLD))
    story.append(sp(6))

    story.append(Paragraph('<b>Employee Information</b>', H2))
    story.append(p('Employee Name: _____________________________________________', FORM_FIELD))
    story.append(p('Date Submitted: ____________________________________________', FORM_FIELD))
    story.append(sp(4))

    story.append(Paragraph('<b>Vendor Details</b>', H2))
    story.append(p('Vendor Name: _______________________________________________', FORM_FIELD))
    story.append(p('Vendor Representative Name: ________________________________', FORM_FIELD))
    story.append(sp(4))

    chk = '\u2610'
    story.append(p(
        f'<b>Was the Vendor Present During the Event or Meal?</b>  {chk} Yes    {chk} No',
        FORM_LABEL
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Event/Meal Description</b>', H2))
    story.append(p(
        '<i>Provide a brief description of the event, entertainment, or meal:</i>',
        ITALIC_STYLE
    ))
    story.append(p('_' * 80, FORM_FIELD))
    story.append(p('_' * 80, FORM_FIELD))
    story.append(p('_' * 80, FORM_FIELD))
    story.append(sp(4))

    story.append(Paragraph('<b>Gift or Entertainment Value</b>', H2))
    story.append(p(
        '(If vendor was <b>not</b> present at the time of receipt)'
    ))
    story.append(p('Estimated Value: $__________________________________________', FORM_FIELD))
    story.append(sp(4))

    story.append(Paragraph('<b>Description of Gift:</b>', BOLD))
    story.append(p('_' * 80, FORM_FIELD))
    story.append(p('_' * 80, FORM_FIELD))
    story.append(sp(10))

    story.append(p('Employee Signature: ________________________________________', FORM_FIELD))
    story.append(p('Date: ______________________', FORM_FIELD))
    story.append(sp(10))
    story.append(p('CCO Approval (if required): _________________________________', FORM_FIELD))
    story.append(p('Date Approved: ______________________', FORM_FIELD))
    story.append(sp(6))


# =============================================================================
#  EXHIBIT D \u2014 PERSONAL ACCOUNT TRADING AUTHORIZATION FORM
# =============================================================================

def build_exhibit_d(story):
    story.append(PageBreak())
    story.append(head('Exhibit D: Personal Account Trading Authorization Form',
                       is_article=True))
    story.append(section_spacer())
    story.append(p('STT Capital Advisors, LLC', BOLD))
    story.append(sp(6))

    story.append(Paragraph('<b>Employee Information</b>', H2))
    story.append(p('Employee Name: _____________________________________________', FORM_FIELD))
    story.append(p('Date of Request: ___________________________________________', FORM_FIELD))
    story.append(sp(4))

    story.append(Paragraph('<b>Trade Details</b>', H2))
    chk = '\u2610'
    story.append(p(f'Type of Trade:  {chk} Buy    {chk} Sell', FORM_LABEL))
    story.append(p('Number of Shares: _________________________________________', FORM_FIELD))
    story.append(p('Security Name / Ticker Symbol: _____________________________', FORM_FIELD))
    story.append(p('Broker: ____________________________________________________', FORM_FIELD))
    story.append(sp(4))

    story.append(Paragraph('<b>Additional Information:</b>', BOLD))
    story.append(p(
        '<i>(e.g., private placement details, rationale, restrictions, etc.)</i>',
        ITALIC_STYLE
    ))
    story.append(p('_' * 80, FORM_FIELD))
    story.append(p('_' * 80, FORM_FIELD))
    story.append(p('_' * 80, FORM_FIELD))
    story.append(sp(10))

    story.append(Paragraph('<b>Authorization Section (To Be Completed by CCO)</b>', H2))
    story.append(p(f'Approved:  {chk} Yes    {chk} No', FORM_LABEL))
    story.append(p('CCO Signature: _____________________________________________', FORM_FIELD))
    story.append(p('Date: ______________________', FORM_FIELD))
    story.append(sp(4))
    story.append(Paragraph('<b>Notes / Conditions (if any):</b>', BOLD))
    story.append(p('_' * 80, FORM_FIELD))
    story.append(p('_' * 80, FORM_FIELD))
    story.append(sp(6))


# =============================================================================
#  EXHIBIT E \u2014 EMPLOYEE DISCLOSURE FORM
# =============================================================================

def build_exhibit_e(story):
    story.append(PageBreak())
    story.append(head('Exhibit E: Employee Disclosure Form', is_article=True))
    story.append(section_spacer())
    story.append(p(
        'As part of the Firm\u2019s affiliation with the U.S. Securities and Exchange '
        'Commission (SEC) all Employees will be required to answer the following questions, '
        'then sign and date on page two.'
    ))
    story.append(p(
        'In this Item, we ask for information about your disciplinary history. The SEC uses '
        'this information to determine whether to grant our Firm\u2019s application for '
        'registration, to decide whether to revoke our registration or to place limitations '
        'on our activities as an investment adviser, and to identify potential problem areas '
        'to focus on during on-site examinations.',
        SMALL
    ))
    story.append(p(
        'Please note that one event may result in \u201cyes\u201d answers to more than one '
        'of the questions below.',
        SMALL
    ))
    story.append(sp(4))

    # Build the disclosure question tables
    chk = '\u2610'

    # Section A
    sec_a = [
        ['A. In the past ten years, have you:', 'Yes', 'No'],
        [f'(1) been convicted of or pled guilty or nolo contendere (\u201cno contest\u201d) '
         f'in a domestic, foreign, or military court to any felony?', chk, chk],
        [f'(2) been charged with any felony?', chk, chk],
    ]
    story.append(styled_table(sec_a, col_widths=[BODY_W - 1.0*inch, 0.5*inch, 0.5*inch]))
    story.append(p(
        '<i>You may limit your response to Item A(2) to charges that are currently pending.</i>',
        SMALL
    ))
    story.append(sp(6))

    # Section B
    sec_b = [
        ['B. In the past ten years, have you:', 'Yes', 'No'],
        ['(1) been convicted of or pled guilty or nolo contendere in a domestic, foreign, '
         'or military court to a misdemeanor involving: investments or an investment-related '
         'business, or any fraud, false statements, or omissions, wrongful taking of '
         'property, bribery, perjury, forgery, counterfeiting, extortion, or a conspiracy '
         'to commit any of these offenses?', chk, chk],
        ['(2) been charged with a misdemeanor listed in Item B(1)?', chk, chk],
    ]
    story.append(styled_table(sec_b, col_widths=[BODY_W - 1.0*inch, 0.5*inch, 0.5*inch]))
    story.append(p(
        '<i>You may limit your response to Item B(2) to charges that are currently pending.</i>',
        SMALL
    ))
    story.append(sp(6))

    # Section C
    sec_c = [
        ['C. Has the SEC or the Commodity Futures Trading Commission (CFTC) ever:', 'Yes', 'No'],
        ['(1) found you to have made a false statement or omission?', chk, chk],
        ['(2) found you to have been involved in a violation of SEC or CFTC regulations '
         'or statutes?', chk, chk],
        ['(3) found you to have been a cause of an investment-related business having its '
         'authorization to do business denied, suspended, revoked, or restricted?', chk, chk],
        ['(4) entered an order against you in connection with investment-related activity?',
         chk, chk],
        ['(5) imposed a civil money penalty on you, or ordered you to cease and desist '
         'from any activity?', chk, chk],
    ]
    story.append(styled_table(sec_c, col_widths=[BODY_W - 1.0*inch, 0.5*inch, 0.5*inch]))
    story.append(sp(6))

    # Section D
    sec_d = [
        ['D. Has any other federal regulatory agency, any state regulatory agency, '
         'or any foreign financial regulatory authority:', 'Yes', 'No'],
        ['(1) ever found you to have made a false statement or omission, or been '
         'dishonest, unfair, or unethical?', chk, chk],
        ['(2) ever found you to have been involved in a violation of investment-related '
         'regulations or statutes?', chk, chk],
        ['(3) ever found you to have been a cause of an investment-related business having '
         'its authorization to do business denied, suspended, revoked, or restricted?',
         chk, chk],
        ['(4) in the past ten years, entered an order against you in connection with an '
         'investment-related activity?', chk, chk],
        ['(5) ever denied, suspended, or revoked your registration or license, or otherwise '
         'prevented you, by order, from associating with an investment-related business or '
         'restricted your activity?', chk, chk],
    ]
    story.append(styled_table(sec_d, col_widths=[BODY_W - 1.0*inch, 0.5*inch, 0.5*inch]))
    story.append(sp(12))

    story.append(p('Employee Signature: ________________________________________', FORM_FIELD))
    story.append(p('Date: ______________________', FORM_FIELD))
    story.append(sp(6))


# =============================================================================
#  EXHIBIT F \u2014 WHISTLEBLOWER COMPLAINT FORM
# =============================================================================

def build_exhibit_f(story):
    story.append(PageBreak())
    story.append(head('Exhibit F: Whistleblower Complaint Form', is_article=True))
    story.append(section_spacer())
    story.append(p('STT Capital Advisors, LLC', BOLD))
    story.append(sp(4))

    story.append(warn_box([
        'This form may be used by any Employee, officer, agent, consultant, or investor to '
        'report suspected violations of law, regulation, or Firm policy. Complaints may be '
        'submitted anonymously. The Firm strictly prohibits retaliation against any person '
        'who reports in good faith.'
    ]))
    story.append(sp(8))

    story.append(Paragraph('<b>Complainant Information (Optional)</b>', H2))
    story.append(p('Name: ______________________________________________________', FORM_FIELD))
    story.append(p('Title/Position: ____________________________________________', FORM_FIELD))
    story.append(p('Phone: _____________________________________________________', FORM_FIELD))
    story.append(p('Email: _____________________________________________________', FORM_FIELD))
    story.append(sp(4))

    chk = '\u2610'
    story.append(p(
        f'<b>Reporting Status:</b>  {chk} Inside Reporting Person    '
        f'{chk} Outside Reporting Person    {chk} Anonymous',
        FORM_LABEL
    ))
    story.append(sp(6))

    story.append(Paragraph('<b>Nature of Complaint</b>', H2))
    story.append(p(f'{chk} Fraud or deliberate error in financial statements', FORM_LABEL))
    story.append(p(f'{chk} Fraud or deliberate error in communications with regulators/public', FORM_LABEL))
    story.append(p(f'{chk} Deficiencies in or noncompliance with internal controls', FORM_LABEL))
    story.append(p(f'{chk} Misrepresentation or false statement by a senior officer', FORM_LABEL))
    story.append(p(f'{chk} Deviation from full and fair reporting of financial condition', FORM_LABEL))
    story.append(p(f'{chk} Other (describe below)', FORM_LABEL))
    story.append(sp(6))

    story.append(Paragraph('<b>Description of Complaint:</b>', BOLD))
    story.append(p(
        '<i>Please provide as much detail as possible, including dates, individuals involved, '
        'documents or evidence, and any other relevant information:</i>',
        ITALIC_STYLE
    ))
    story.append(p('_' * 80, FORM_FIELD))
    story.append(p('_' * 80, FORM_FIELD))
    story.append(p('_' * 80, FORM_FIELD))
    story.append(p('_' * 80, FORM_FIELD))
    story.append(p('_' * 80, FORM_FIELD))
    story.append(sp(10))

    story.append(p('Signature (if not anonymous): ______________________________', FORM_FIELD))
    story.append(p('Date: ______________________', FORM_FIELD))
    story.append(sp(8))

    story.append(warn_box([
        'Submit this form in a sealed envelope addressed to: CCO, Confidential \u2014 To be '
        'Opened Only by the CCO. Complaints may also be submitted by email to the CCO. '
        'All complaints will be investigated promptly and handled in accordance with the '
        'Firm\u2019s Whistleblower Policy.'
    ]))
    story.append(sp(6))


# =============================================================================
#  MAIN
# =============================================================================

def _cover_page_callback(canvas, doc):
    canvas.saveState()
    draw_cover_header(canvas,
                      title='Policies and Procedures Manual',
                      subtitle='STT Capital Advisors, LLC  |  Carnivore Quant Fund, LP  |  May 2025')
    draw_cover_bottom_band(canvas,
                           'PROPRIETARY AND CONFIDENTIAL')
    canvas.restoreState()


def main():
    os.makedirs(PUBLIC, exist_ok=True)

    doc = BaseDocTemplate(
        OUT,
        pagesize=letter,
        leftMargin=MARGIN_LEFT,
        rightMargin=MARGIN_RIGHT,
        topMargin=MARGIN_TOP,
        bottomMargin=MARGIN_BOTTOM,
        title='STT Capital Advisors, LLC - Policies and Procedures Manual',
        author='PNTHR Funds, LLC',
        subject='Policies and Procedures Manual',
    )

    cover_frame = Frame(MARGIN_LEFT, MARGIN_BOTTOM,
                        PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT,
                        PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM,
                        id='cover')
    interior_frame = Frame(MARGIN_LEFT, MARGIN_BOTTOM,
                           PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT,
                           PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM,
                           id='interior')

    doc.addPageTemplates([
        PageTemplate(id='cover', frames=[cover_frame],
                     onPage=_cover_page_callback),
        PageTemplate(id='interior', frames=[interior_frame]),
    ])

    story = []

    # Cover
    build_cover(story)
    story.insert(len(story) - 1, NextPageTemplate('interior'))

    # Table of Contents
    build_toc(story)

    # Sections 1-12
    build_section_1(story)
    build_section_2(story)
    build_section_3(story)
    build_section_4(story)
    build_section_5(story)
    build_section_6(story)
    build_section_7(story)
    build_section_8(story)
    build_section_9(story)
    build_section_10(story)
    build_section_11(story)
    build_section_12(story)

    # Exhibits
    build_exhibit_a(story)
    build_exhibit_b(story)
    build_exhibit_c(story)
    build_exhibit_d(story)
    build_exhibit_e(story)
    build_exhibit_f(story)

    NumberedCanvas = make_numbered_canvas(
        doc_slug='POLICIES & PROCEDURES \xb7 STT CAPITAL ADVISORS, LLC \xb7 CONFIDENTIAL',
        doc_name='Policies and Procedures Manual',
        confidentiality='Proprietary and Confidential',
        cover_pages=1,
    )
    doc.build(story, canvasmaker=NumberedCanvas)

    size_kb = os.path.getsize(OUT) // 1024
    print(f'\n[OK] PNTHR Policies & Procedures Manual generated: {OUT}')
    print(f'  Size: {size_kb} KB')


if __name__ == '__main__':
    main()
