#!/usr/bin/env python3
"""
generateCodeOfEthics.py
PNTHR Funds: Carnivore Quant Fund, LP
Code of Ethics Manual

Branded version using pnthr_doc_style v4.
Source: Original Code of Ethics Manual (53 pages), cross-referenced against
PPM v5.2 for title/role alignment.

All officer titles corrected to match PPM v5.2:
  - Scott McBrien: Managing Member, Chief Investment Officer & Chief Compliance Officer
  - Cindy Eagar: Managing Member, Chief Operating Officer & Chief Information Security Officer

Usage:  cd server/backtest && python3 generateCodeOfEthics.py
Output: client/public/PNTHR_Code_of_Ethics.pdf
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
OUT    = os.path.join(PUBLIC, 'PNTHR_Code_of_Ethics.pdf')

set_asset_paths(LOGO)

# ── Styles ───────────────────────────────────────────────────────────────────
_styles = get_paragraph_styles()
NORMAL     = _styles['body']
BOLD       = _styles['body_bold']
CENTER     = _styles['body_center']
BODY_W     = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT

BULLET = ParagraphStyle('bullet_coe', parent=NORMAL, leftIndent=18,
                        firstLineIndent=-12, spaceAfter=4)
BULLET2 = ParagraphStyle('bullet2_coe', parent=NORMAL, fontSize=8, leading=11,
                         leftIndent=32, firstLineIndent=-12, spaceAfter=3)
BULLET3 = ParagraphStyle('bullet3_coe', parent=NORMAL, fontSize=8, leading=11,
                         leftIndent=46, firstLineIndent=-12, spaceAfter=3)
H2 = ParagraphStyle('h2_coe', parent=NORMAL, fontName=FONT_BOLD, fontSize=11,
                     leading=14, spaceBefore=12, spaceAfter=4, textColor=PNTHR_BLACK)
H3 = ParagraphStyle('h3_coe', parent=NORMAL, fontName=FONT_BOLD, fontSize=9.5,
                     leading=13, spaceBefore=8, spaceAfter=3, textColor=PNTHR_BLACK)
WARN_STYLE = ParagraphStyle('warn_coe', parent=NORMAL, fontName=FONT_BOLD,
                            fontSize=8, leading=11, spaceAfter=4)
SIG_STYLE = ParagraphStyle('sig_coe', parent=NORMAL, fontSize=9, leading=14,
                           spaceAfter=2)
INDENT = ParagraphStyle('indent_coe', parent=NORMAL, leftIndent=24, spaceAfter=4)
ITALIC_STYLE = ParagraphStyle('italic_coe', parent=NORMAL, fontName=FONT_ITALIC)
SMALL = ParagraphStyle('small_coe', parent=NORMAL, fontSize=8, leading=11, spaceAfter=4)

# Exhibit form field style
FORM_LABEL = ParagraphStyle('form_label', parent=NORMAL, fontName=FONT_BOLD,
                            fontSize=9, leading=13, spaceAfter=2)
FORM_FIELD = ParagraphStyle('form_field', parent=NORMAL, fontSize=9, leading=16,
                            spaceAfter=8)

def sp(h=6): return Spacer(1, h)
def p(text, style=None): return Paragraph(text, style or NORMAL)
def bl(text): return Paragraph(f'&#8226; {text}', BULLET)
def bl2(text): return Paragraph(f'&#8211; {text}', BULLET2)
def bl3(text): return Paragraph(f'&#8211; {text}', BULLET3)
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
                f'tcell_coe_{i}_{j}', parent=NORMAL,
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
    style_cmds.append(('FONT', (0,start), (0,-1), FONT_BOLD, 8))
    for i in range(start, len(rows)):
        if (i - start) % 2 == 0:
            style_cmds.append(('BACKGROUND', (0,i), (-1,i), PNTHR_GREY_100))
    tbl.setStyle(TableStyle(style_cmds))
    return tbl


# ══════════════════════════════════════════════════════════════════════════════
#  COVER
# ══════════════════════════════════════════════════════════════════════════════

def build_cover(story):
    story.append(sp(3.8 * inch))
    info_rows = [
        ('Firm', 'STT Capital Advisors, LLC'),
        ('Fund', 'Carnivore Quant Fund, LP'),
        ('Effective Date', 'May 1, 2025'),
        ('Last Reviewed', 'April 2026'),
        ('Chief Compliance Officer', 'Scott McBrien, Managing Member, CIO & CCO'),
        ('CCO Designee', 'Cindy Eagar, Managing Member, COO & CISO'),
        ('Regulatory Status', 'Exempt Reporting Adviser (ERA)'),
    ]
    story.append(build_info_table(info_rows, header='DOCUMENT PARTICULARS'))
    story.append(sp(18))
    story.append(p(
        'This Code of Ethics (the "Code") has been adopted by STT Capital Advisors, LLC '
        '(the "Firm") in compliance with Rule 204A-1 under the Investment Advisers Act of '
        '1940. It establishes standards of conduct, personal trading policies, and '
        'compliance procedures applicable to all supervised persons of the Firm.',
        CENTER
    ))
    story.append(PageBreak())


# ══════════════════════════════════════════════════════════════════════════════
#  TABLE OF CONTENTS
# ══════════════════════════════════════════════════════════════════════════════

def build_toc(story):
    story.append(head('Table of Contents', is_article=True))
    story.append(section_spacer())

    toc_entries = [
        '1. Statement of General Policy',
        '2. Definitions',
        '3. Standards of Business Conduct',
        '4. Access Persons',
        '5. Custodial Account Reporting',
        '6. Confidentiality and Privacy Policy',
        '7. Social Media Policy',
        '8. Prohibition Against Insider Trading',
        '9. Preclearance of Personal Trading',
        '10. Personal Securities Transactions',
        '11. Personal Securities Trading Limitations',
        '12. Margin Transactions',
        '13. Limit Orders',
        '14. Pre-Approval for Affiliated Private Fund Investments',
        '15. Interested Transactions',
        '16. Outside Business Activities',
        '17. Service as an Officer or Director',
        '18. Gifts and Entertainment Policy',
        '19. Blackout Periods',
        '20. Rumor Mongering Policy',
        '21. Compliance Procedures',
        '22. Whistleblower Policy',
        '23. Reporting Violations and Sanctions',
        '24. Records Retention Policy',
        '',
        'Exhibit A: Record Retention Table',
        'Exhibit B: Certification and Acknowledgement of Receipt',
        'Exhibit C: Gift and Entertainment Form',
        'Exhibit D: Personal Account Trading Authorization Form',
        'Exhibit E: Employee Disclosure Form',
    ]

    toc_style = ParagraphStyle('toc_coe', parent=NORMAL, fontSize=9, leading=14,
                               leftIndent=12, spaceAfter=2)
    toc_bold = ParagraphStyle('toc_coe_b', parent=toc_style, fontName=FONT_BOLD,
                              spaceBefore=4)
    for entry in toc_entries:
        if not entry:
            story.append(sp(6))
        elif entry.startswith('Exhibit'):
            story.append(p(entry, toc_bold))
        else:
            story.append(p(entry, toc_style))

    story.append(PageBreak())


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 1: STATEMENT OF GENERAL POLICY
# ══════════════════════════════════════════════════════════════════════════════

def build_section_1(story):
    story.append(head('1. Statement of General Policy', 'SECTION 1'))
    story.append(section_spacer())

    story.append(p(
        'STT Capital Advisors, LLC (the "Firm") is a Delaware limited liability company '
        'registered as an Exempt Reporting Adviser (ERA) under the Investment Advisers Act '
        'of 1940. The Firm serves as the investment manager for Carnivore Quant Fund, LP '
        '(the "Fund"), a Delaware limited partnership.'
    ))
    story.append(p(
        'The Firm has adopted this Code of Ethics (the "Code") in compliance with '
        'Rule 204A-1 under the Investment Advisers Act of 1940. This Code establishes '
        'standards of ethical conduct and fiduciary responsibility for all supervised '
        'persons of the Firm.'
    ))
    story.append(p(
        'All supervised persons are expected to adhere to the highest standards of '
        'professional conduct and to place the interests of the Firm\'s clients and '
        'investors above their own personal interests at all times. The Code is designed to:'
    ))
    story.append(bl('Establish clear ethical standards for all supervised persons'))
    story.append(bl('Prevent conflicts of interest between personal and client interests'))
    story.append(bl('Ensure compliance with applicable federal and state securities laws'))
    story.append(bl('Promote a culture of integrity, transparency, and accountability'))
    story.append(bl('Protect the interests of Fund investors'))

    story.append(sp(6))
    story.append(warn_box([
        'Fiduciary Duty: As a fiduciary, the Firm and its supervised persons owe a duty '
        'of care and loyalty to the Fund and its investors. This duty requires that all '
        'decisions and actions be taken in the best interests of investors, and that '
        'conflicts of interest be identified, disclosed, and managed appropriately.'
    ]))
    story.append(sp(6))
    story.append(p(
        'The Chief Compliance Officer (CCO), Scott McBrien, is responsible for the '
        'administration and enforcement of this Code. The CCO Designee, Cindy Eagar '
        '(COO & CISO), assists in compliance monitoring and may act on behalf of the '
        'CCO in matters related to this Code.'
    ))
    story.append(sp(8))


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 2: DEFINITIONS
# ══════════════════════════════════════════════════════════════════════════════

def build_section_2(story):
    story.append(head('2. Definitions', 'SECTION 2'))
    story.append(section_spacer())

    defs = [
        ('"Access Person"',
         'Any supervised person who has access to nonpublic information regarding any '
         'clients\' purchase or sale of securities, or nonpublic information regarding '
         'the portfolio holdings of any reportable fund, or who is involved in making '
         'securities recommendations to clients.'),
        ('"Beneficial Ownership"',
         'A person is considered to have beneficial ownership of securities if they have '
         'or share a direct or indirect pecuniary interest in the securities, including '
         'any securities held by members of the person\'s immediate household.'),
        ('"CCO"',
         'Chief Compliance Officer. Scott McBrien serves as the CCO of STT Capital '
         'Advisors, LLC.'),
        ('"CCO Designee"',
         'Cindy Eagar, Managing Member, COO & CISO, who assists the CCO in compliance '
         'monitoring and may act on behalf of the CCO.'),
        ('"Initial Public Offering" (IPO)',
         'An offering of securities registered under the Securities Act of 1933, the '
         'issuer of which, immediately before the registration, was not subject to the '
         'reporting requirements of sections 13 or 15(d) of the Securities Exchange Act '
         'of 1934.'),
        ('"Limited Offering"',
         'An offering that is exempt from registration under the Securities Act of 1933 '
         'pursuant to section 4(a)(2) or section 4(a)(5), or pursuant to Rule 504 or '
         'Rule 506 of Regulation D.'),
        ('"Reportable Fund"',
         'Any fund for which STT Capital Advisors, LLC serves as investment adviser or '
         'sub-adviser, or any fund whose investment adviser or principal underwriter '
         'controls, is controlled by, or is under common control with STT Capital '
         'Advisors, LLC.'),
        ('"Reportable Security"',
         'Any security as defined in Section 202(a)(18) of the Investment Advisers Act '
         'of 1940, except: direct obligations of the U.S. government; bankers\' '
         'acceptances, bank CDs, commercial paper, and high-quality short-term debt; '
         'shares of money market funds; shares of open-end mutual funds that are not '
         'reportable funds; and shares of unit investment trusts invested exclusively in '
         'unaffiliated mutual funds.'),
        ('"Supervised Person"',
         'Any partner, officer, director, or employee of STT Capital Advisors, LLC, or '
         'other person who provides investment advice on behalf of the Firm and is subject '
         'to the supervision and control of the Firm.'),
    ]

    for term, definition in defs:
        story.append(p(f'<b>{term}</b>: {definition}'))
    story.append(sp(8))


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 3: STANDARDS OF BUSINESS CONDUCT
# ══════════════════════════════════════════════════════════════════════════════

def build_section_3(story):
    story.append(head('3. Standards of Business Conduct', 'SECTION 3'))
    story.append(section_spacer())

    story.append(p(
        'All supervised persons of STT Capital Advisors, LLC are required to comply with '
        'the following standards of business conduct:'
    ))
    story.append(bl(
        'Act with <b>integrity, competence, dignity, and in an ethical manner</b> when '
        'dealing with clients, prospects, and the public'
    ))
    story.append(bl(
        'Place the <b>interests of clients above personal interests</b> at all times'
    ))
    story.append(bl(
        'Exercise <b>reasonable care</b> and <b>independent professional judgment</b>'
    ))
    story.append(bl(
        'Not engage in any practice that is <b>deceptive, manipulative, or fraudulent</b>'
    ))
    story.append(bl(
        'Comply with all applicable <b>federal and state securities laws</b> and regulations'
    ))
    story.append(bl(
        'Maintain <b>confidentiality</b> of client information and proprietary strategies'
    ))
    story.append(bl(
        'Report any violations of this Code <b>promptly</b> to the CCO'
    ))
    story.append(bl(
        'Cooperate fully with any <b>compliance review or investigation</b>'
    ))
    story.append(sp(6))
    story.append(p(
        'Supervised persons are prohibited from engaging in any act, practice, or course '
        'of business that would constitute a violation of Section 206 of the Investment '
        'Advisers Act of 1940, which prohibits fraud, deceit, and manipulative practices '
        'by investment advisers.'
    ))
    story.append(sp(8))


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 4: ACCESS PERSONS
# ══════════════════════════════════════════════════════════════════════════════

def build_section_4(story):
    story.append(head('4. Access Persons', 'SECTION 4'))
    story.append(section_spacer())

    story.append(p(
        'All employees and supervised persons of STT Capital Advisors, LLC are designated '
        'as "Access Persons" due to the size and nature of the Firm\'s operations. As '
        'Access Persons, they are subject to the personal trading reporting requirements '
        'set forth in this Code.'
    ))
    story.append(sp(4))
    story.append(p('<b>Current Access Persons:</b>', BOLD))
    story.append(sp(4))

    rows = [
        ['Name', 'Title', 'Role'],
        ['Scott McBrien', 'Managing Member, CIO & CCO',
         'Chief Compliance Officer; investment decisions,\ntrade execution, compliance oversight'],
        ['Cindy Eagar', 'Managing Member, COO & CISO',
         'CCO Designee; operations, cybersecurity,\ncompliance monitoring, investor relations'],
    ]
    story.append(styled_table(rows, col_widths=[1.6*inch, 2.0*inch, BODY_W - 3.6*inch]))
    story.append(sp(6))

    story.append(p(
        'Access Persons must comply with the personal securities reporting requirements '
        'outlined in Sections 9 and 10 of this Code, including:'
    ))
    story.append(bl('Initial holdings report within 10 days of becoming an Access Person'))
    story.append(bl('Annual holdings reports'))
    story.append(bl('Quarterly transaction reports'))
    story.append(sp(8))


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 5: CUSTODIAL ACCOUNT REPORTING
# ══════════════════════════════════════════════════════════════════════════════

def build_section_5(story):
    story.append(head('5. Custodial Account Reporting', 'SECTION 5'))
    story.append(section_spacer())

    story.append(p(
        'All Access Persons must report their brokerage and custodial accounts to the '
        'Chief Compliance Officer. This includes:'
    ))
    story.append(bl(
        '<b>Initial Disclosure:</b> Within 10 days of becoming an Access Person, a '
        'complete list of all brokerage accounts in which the Access Person has beneficial '
        'ownership or trading authority'
    ))
    story.append(bl(
        '<b>New Account Notification:</b> Prompt notification to the CCO upon opening any '
        'new brokerage account'
    ))
    story.append(bl(
        '<b>Duplicate Confirmations:</b> The Firm may direct brokers to send duplicate '
        'trade confirmations and account statements to the CCO or their designee'
    ))
    story.append(sp(4))
    story.append(p(
        'The CCO will maintain a current list of all Access Person brokerage accounts and '
        'review account activity for potential conflicts of interest on at least a '
        'quarterly basis.'
    ))
    story.append(sp(8))


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 6: CONFIDENTIALITY AND PRIVACY POLICY
# ══════════════════════════════════════════════════════════════════════════════

def build_section_6(story):
    story.append(head('6. Confidentiality and Privacy Policy', 'SECTION 6'))
    story.append(section_spacer())

    story.append(p(
        'STT Capital Advisors, LLC is committed to protecting the confidentiality of '
        'client and investor information. All supervised persons must adhere to the '
        'following confidentiality standards:'
    ))
    story.append(sp(4))

    story.append(p('<b>Confidential Information Includes:</b>', BOLD))
    story.append(bl('Investor identity, account balances, and transaction history'))
    story.append(bl('Fund portfolio holdings and trading strategies'))
    story.append(bl('Proprietary investment methodologies and algorithms'))
    story.append(bl('Internal financial information of the Firm'))
    story.append(bl('Personnel records and compensation information'))
    story.append(sp(4))

    story.append(p('<b>Prohibited Disclosures:</b>', BOLD))
    story.append(bl(
        'Supervised persons may not disclose confidential information to any person '
        'outside the Firm unless authorized by the CCO or required by law'
    ))
    story.append(bl(
        'Confidential information must not be used for personal benefit or the benefit '
        'of any third party'
    ))
    story.append(bl(
        'Discussions of confidential matters should be conducted in private settings '
        'and never in public areas'
    ))
    story.append(sp(4))

    story.append(p('<b>Data Protection:</b>', BOLD))
    story.append(bl(
        'All electronic confidential information must be stored on encrypted, '
        'access-controlled systems'
    ))
    story.append(bl(
        'Physical documents containing confidential information must be secured in '
        'locked storage when not in use'
    ))
    story.append(bl(
        'Disposal of confidential documents must be by shredding or secure deletion'
    ))
    story.append(sp(4))
    story.append(p(
        'The Chief Information Security Officer (CISO), Cindy Eagar, is responsible for '
        'overseeing the Firm\'s data protection and cybersecurity policies. Any suspected '
        'data breach or unauthorized disclosure must be reported to the CISO and CCO '
        'immediately.'
    ))
    story.append(sp(8))


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 7: SOCIAL MEDIA POLICY
# ══════════════════════════════════════════════════════════════════════════════

def build_section_7(story):
    story.append(head('7. Social Media Policy', 'SECTION 7'))
    story.append(section_spacer())

    story.append(p(
        'STT Capital Advisors, LLC recognizes that social media and online communications '
        'are an integral part of modern business. However, the use of social media by '
        'supervised persons must be conducted in a manner consistent with the Firm\'s '
        'regulatory obligations and professional standards.'
    ))
    story.append(sp(4))

    story.append(p('<b>General Principles:</b>', BOLD))
    story.append(bl(
        'All social media communications are subject to the same compliance standards as '
        'any other form of business communication'
    ))
    story.append(bl(
        'Supervised persons must not post or share any confidential or proprietary '
        'information on social media platforms'
    ))
    story.append(bl(
        'Any social media communication that could be construed as investment advice or '
        'a solicitation must receive prior approval from the CCO'
    ))
    story.append(sp(4))

    story.append(p('<b>Prohibited Activities:</b>', BOLD))
    story.append(bl('Disclosing Fund performance, holdings, or trading strategies'))
    story.append(bl('Making investment recommendations or predictions'))
    story.append(bl('Discussing specific securities in a manner that could be misleading'))
    story.append(bl('Posting false or exaggerated claims about the Firm or its services'))
    story.append(sp(4))

    story.append(p('<b>Monitoring:</b>', BOLD))
    story.append(p(
        'The CCO may periodically review social media activity of supervised persons to '
        'ensure compliance with this policy. Violations may result in disciplinary action, '
        'including restrictions on social media use.'
    ))
    story.append(sp(8))


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 8: PROHIBITION AGAINST INSIDER TRADING
# ══════════════════════════════════════════════════════════════════════════════

def build_section_8(story):
    story.append(head('8. Prohibition Against Insider Trading', 'SECTION 8'))
    story.append(section_spacer())

    story.append(p(
        'Federal securities laws strictly prohibit the use of material, nonpublic '
        'information ("MNPI") in connection with the purchase or sale of securities. '
        'All supervised persons of STT Capital Advisors, LLC are prohibited from:'
    ))
    story.append(bl(
        '<b>Trading</b> on the basis of MNPI, whether for personal accounts, client '
        'accounts, or any other accounts'
    ))
    story.append(bl(
        '<b>Tipping</b> or communicating MNPI to any person who may trade on such '
        'information'
    ))
    story.append(bl(
        '<b>Recommending</b> the purchase or sale of any security while in possession '
        'of MNPI concerning that security or its issuer'
    ))
    story.append(sp(4))

    story.append(warn_box([
        'Material Information: Information is "material" if there is a substantial '
        'likelihood that a reasonable investor would consider it important in making an '
        'investment decision. Information is "nonpublic" if it has not been broadly '
        'disseminated to the general public through established channels.'
    ]))
    story.append(sp(4))

    story.append(p('<b>Procedures:</b>', BOLD))
    story.append(bl(
        'Any supervised person who believes they may be in possession of MNPI must '
        'immediately contact the CCO before taking any action'
    ))
    story.append(bl(
        'The CCO will assess the situation and determine appropriate restrictions, '
        'which may include placing the security on a restricted list'
    ))
    story.append(bl(
        'Information barriers ("Chinese Walls") will be implemented as necessary to '
        'prevent the misuse of MNPI'
    ))
    story.append(sp(4))
    story.append(p(
        'Violations of insider trading laws can result in severe criminal and civil '
        'penalties, including imprisonment, fines, and disgorgement of profits. The '
        'Firm will cooperate fully with any regulatory investigation into potential '
        'insider trading violations.'
    ))
    story.append(sp(8))


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 9: PRECLEARANCE OF PERSONAL TRADING
# ══════════════════════════════════════════════════════════════════════════════

def build_section_9(story):
    story.append(head('9. Preclearance of Personal Trading', 'SECTION 9'))
    story.append(section_spacer())

    story.append(p(
        'All Access Persons must obtain prior approval from the Chief Compliance Officer '
        '(CCO), Scott McBrien, or his designee before engaging in any personal securities '
        'transaction involving a reportable security.'
    ))
    story.append(sp(4))

    story.append(p('<b>Preclearance Requirements:</b>', BOLD))
    story.append(bl(
        'A Preclearance Request Form (Exhibit D) must be submitted to the CCO prior to '
        'any trade in a reportable security'
    ))
    story.append(bl(
        'Preclearance approval is valid for <b>one (1) business day</b> only; if the '
        'trade is not executed within that period, a new request must be submitted'
    ))
    story.append(bl(
        'The CCO will review each request and may approve, deny, or impose conditions '
        'on the proposed transaction'
    ))
    story.append(sp(4))

    story.append(p('<b>Transactions Requiring Preclearance:</b>', BOLD))
    story.append(bl('Purchases and sales of individual stocks and bonds'))
    story.append(bl('Options and derivative transactions'))
    story.append(bl('Initial Public Offerings (IPOs)'))
    story.append(bl('Limited or private offerings'))
    story.append(bl('Transactions in reportable funds'))
    story.append(sp(4))

    story.append(p('<b>Exempt Transactions (No Preclearance Required):</b>', BOLD))
    story.append(bl('Purchases of U.S. government securities'))
    story.append(bl('Purchases of money market instruments'))
    story.append(bl('Purchases of shares in open-end mutual funds (non-reportable)'))
    story.append(bl('Automatic investment plan transactions'))
    story.append(bl('Transactions in accounts over which the Access Person has no '
                    'direct or indirect influence or control'))
    story.append(sp(8))


# ══════════════════════════════════════════════════════════════════════════════
#  SECTION 10: PERSONAL SECURITIES TRANSACTIONS
# ══════════════════════════════════════════════════════════════════════════════

def build_section_10(story):
    story.append(head('10. Personal Securities Transactions', 'SECTION 10'))
    story.append(section_spacer())

    story.append(p(
        'All Access Persons are required to submit the following reports to the CCO:'
    ))
    story.append(sp(4))

    story.append(p('<b>Initial Holdings Report:</b>', BOLD))
    story.append(bl(
        'Due within <b>10 days</b> of becoming an Access Person'
    ))
    story.append(bl(
        'Must include: title and type of security, ticker symbol or CUSIP, number of '
        'shares, and principal amount of each reportable security'
    ))
    story.append(bl(
        'Must list all brokerage accounts in which the Access Person has beneficial '
        'ownership'
    ))
    story.append(bl(
        'Information must be current as of a date no more than 45 days prior to the '
        'report date'
    ))
    story.append(sp(4))

    story.append(p('<b>Quarterly Transaction Reports:</b>', BOLD))
    story.append(bl(
        'Due within <b>30 days</b> after the end of each calendar quarter'
    ))
    story.append(bl(
        'Must include: date of transaction, title and ticker, number of shares, '
        'principal amount, nature of transaction (buy, sell, other), price, and broker'
    ))
    story.append(bl(
        'Must report any new brokerage accounts established during the quarter'
    ))
    story.append(sp(4))

    story.append(p('<b>Annual Holdings Reports:</b>', BOLD))
    story.append(bl(
        'Due within <b>45 days</b> after the end of each calendar year'
    ))
    story.append(bl(
        'Must include the same information as the initial holdings report'
    ))
    story.append(bl(
        'Information must be current as of a date no more than 45 days prior'
    ))
    story.append(sp(4))

    story.append(warn_box([
        'Alternative Reporting: Brokerage confirmations and account statements may be '
        'submitted in lieu of quarterly transaction reports, provided they contain all '
        'required information and are submitted within the required timeframe.'
    ]))
    story.append(sp(8))


# ══════════════════════════════════════════════════════════════════════════════
#  SECTIONS 11-24: REMAINING CONTENT
# ══════════════════════════════════════════════════════════════════════════════

def build_section_11(story):
    story.append(head('11. Personal Securities Trading Limitations', 'SECTION 11'))
    story.append(section_spacer())

    story.append(p(
        'As fiduciaries, all supervised persons of STT Capital Advisors, LLC are expected '
        'to prioritize the interests of the Firm\'s clients at all times. Personal trading '
        'must never interfere with professional responsibilities or present a conflict of '
        'interest, actual or perceived.'
    ))
    story.append(p(
        'While the Firm does not impose a strict cap on the number of personal securities '
        'transactions an access person may execute within a given timeframe, all such '
        'activity is subject to <b>periodic review</b>.'
    ))
    story.append(sp(4))

    story.append(p('<b>Policy Summary:</b>', BOLD))
    story.append(bl(
        'Supervised persons are expected to <b>exercise good judgment</b> in the frequency '
        'and volume of personal trades'
    ))
    story.append(bl(
        'Excessive trading that appears to interfere with an individual\'s <b>duties, '
        'focus, or availability</b> to clients may be subject to restriction'
    ))
    story.append(bl(
        'STT Capital Advisors, LLC reserves the right to impose <b>temporary or permanent '
        'trading limitations</b>, including:'
    ))
    story.append(bl2('Heightened preclearance requirements'))
    story.append(bl2('Caps on transaction frequency'))
    story.append(bl2('Trading bans in specific securities or periods'))
    story.append(sp(4))
    story.append(p(
        'These restrictions may be imposed at the sole discretion of the <b>Chief '
        'Compliance Officer (CCO)</b> or a designated compliance representative, '
        'especially if patterns suggest:'
    ))
    story.append(bl('Potential conflicts with client trading'))
    story.append(bl('A negative impact on job performance'))
    story.append(bl('Behavior inconsistent with the spirit of this Code'))
    story.append(sp(4))

    story.append(p('<b>Oversight and Escalation:</b>', BOLD))
    story.append(p(
        'All access persons\' trading activity is subject to <b>ongoing compliance '
        'monitoring</b>. If concerns arise, the CCO will notify the access person and '
        'work to resolve the issue in a way that balances individual flexibility with '
        'fiduciary obligations.'
    ))
    story.append(p('Questions or requests for clarification should be directed to:'))
    story.append(bl('<b>Scott McBrien, Chief Compliance Officer</b>, or'))
    story.append(bl('The supervised person\'s designated compliance reviewer'))
    story.append(sp(8))


def build_section_12(story):
    story.append(head('12. Margin Transactions', 'SECTION 12'))
    story.append(section_spacer())

    story.append(p(
        'STT Capital Advisors, LLC does not prohibit supervised persons from purchasing '
        'securities on margin. However, the use of margin accounts introduces unique '
        'risks, including the potential for automatic liquidation of positions without '
        'the account holder\'s consent. Such forced sales, especially if made while in '
        'possession of <b>material, nonpublic information (MNPI)</b>, may inadvertently '
        'lead to violations of insider trading laws.'
    ))
    story.append(sp(4))

    story.append(p('<b>Policy on Margin Trading:</b>', BOLD))
    story.append(bl(
        'Supervised persons must obtain <b>preclearance</b> before executing any '
        '<b>margin transaction</b> involving a <b>reportable security</b>'
    ))
    story.append(bl(
        'All margin-related preclearance requests will be <b>manually reviewed</b> by '
        'the <b>Chief Compliance Officer (CCO), Scott McBrien</b>, or a designated '
        'compliance reviewer'
    ))
    story.append(bl(
        'Approval or denial of such transactions is made <b>at the Firm\'s sole '
        'discretion</b>, based on risk factors, timing, and potential conflicts of interest'
    ))
    story.append(sp(4))

    story.append(p('<b>Oversight and Discretionary Controls:</b>', BOLD))
    story.append(bl(
        'The Firm may impose <b>heightened supervision</b> or <b>additional trading '
        'restrictions</b> on any supervised person engaging in margin activity, especially '
        'if such activity appears inconsistent with fiduciary duties or regulatory standards'
    ))
    story.append(bl(
        'The Firm retains the right to <b>limit or revoke margin trading privileges</b> '
        'for any supervised person, particularly if such trading could impact client '
        'interests or compliance obligations'
    ))
    story.append(sp(4))
    story.append(p(
        'Supervised persons are responsible for understanding how margin accounts work and '
        'for taking appropriate steps to avoid situations that could result in unintended '
        'or problematic trading activity.'
    ))
    story.append(sp(8))


def build_section_13(story):
    story.append(head('13. Limit Orders', 'SECTION 13'))
    story.append(section_spacer())

    story.append(p(
        'STT Capital Advisors, LLC permits supervised persons to place <b>limit orders</b> '
        'for personal securities transactions. However, due to the nature of limit '
        'orders, which may execute at an uncertain time in the future, additional review '
        'is required to ensure such activity does not conflict with client fund trading '
        'or present regulatory risk.'
    ))
    story.append(sp(4))

    story.append(p('<b>Policy on Limit Orders:</b>', BOLD))
    story.append(bl(
        'All <b>limit orders involving reportable securities</b> require <b>preclearance</b> '
        'by the <b>Chief Compliance Officer (CCO)</b> or their designee'
    ))
    story.append(bl(
        'Each request will be reviewed <b>manually on a trade-by-trade basis</b>'
    ))
    story.append(bl(
        'The Firm reserves the right to <b>deny or delay approval</b> of any limit order '
        'based on:'
    ))
    story.append(bl2('Overlap with fund holdings or trading activity'))
    story.append(bl2('Timing or risk of perceived front-running'))
    story.append(bl2('Market context or regulatory concerns'))
    story.append(sp(4))
    story.append(p(
        'Pre-approval of a limit order does not waive the obligation to comply with other '
        'provisions of the Firm\'s Code of Ethics or insider trading policies.'
    ))
    story.append(sp(8))


def build_section_14(story):
    story.append(head('14. Pre-Approval for Affiliated Private Fund Investments', 'SECTION 14'))
    story.append(section_spacer())

    story.append(p(
        'STT Capital Advisors, LLC currently <b>sponsors and manages private investment '
        'funds</b> under Regulation D, Rule 506(c), and Section 3(c)(1) of the Investment '
        'Company Act. The Firm supports the alignment of interests when access persons '
        'choose to invest personally in the same funds and strategies as our clients.'
    ))
    story.append(sp(4))

    story.append(p('<b>Policy on Employee Investments in STT-Affiliated Funds:</b>', BOLD))
    story.append(bl(
        '<b>Access persons are permitted</b> to invest in Firm-sponsored funds, provided '
        'the investment is made <b>on the same terms and conditions</b> as those offered '
        'to other investors, unless modified via an approved side letter'
    ))
    story.append(bl('Prior to making any investment, the access person must:'))
    story.append(bl2(
        '<b>Complete all applicable subscription documents</b> for the fund; and'
    ))
    story.append(bl2(
        '<b>Submit a Preclearance Request Form</b> to the Chief Compliance Officer (CCO), '
        'Scott McBrien, or an authorized designee'
    ))
    story.append(sp(4))

    story.append(p('<b>Satisfaction of Preclearance Requirements:</b>', BOLD))
    story.append(bl(
        'Once the access person\'s subscription documents are received and accepted by '
        'the Firm (or the fund administrator, <b>NAV Consulting Inc.</b>, if applicable), '
        'and the Preclearance Request Form has been submitted, this process will be deemed '
        'to satisfy the Firm\'s <b>pre-approval requirement</b> for the investment'
    ))
    story.append(bl(
        'Any subsequent contributions or redemptions must also be submitted for '
        'preclearance if they involve reportable securities or fall within other restricted '
        'periods'
    ))
    story.append(sp(8))


def build_section_15(story):
    story.append(head('15. Interested Transactions', 'SECTION 15'))
    story.append(section_spacer())

    story.append(p(
        'To uphold the fiduciary duty of loyalty to our clients and avoid conflicts of '
        'interest, supervised persons must disclose any <b>personal interest</b> in a '
        'security or issuer prior to recommending or participating in a transaction '
        'involving that security for any STT Capital Advisors, LLC fund or client account.'
    ))
    story.append(sp(4))

    story.append(p('<b>Disclosure Requirements:</b>', BOLD))
    story.append(p(
        'Before recommending, discussing, or trading any security on behalf of a client '
        'or fund, a supervised person must <b>fully disclose</b> to the <b>Chief '
        'Compliance Officer (CCO)</b> any of the following:'
    ))
    story.append(bl(
        '<b>Direct or indirect beneficial ownership</b> of securities issued by the company'
    ))
    story.append(bl(
        'Any <b>planned personal transactions</b> in the same security'
    ))
    story.append(bl(
        'Any <b>current or prior employment, board, or advisory role</b> with the issuer '
        'or its affiliates'
    ))
    story.append(bl(
        'Any <b>existing or proposed business relationship</b> with the issuer or any '
        'related entity, either personally or through a party in which the supervised '
        'person has a material financial interest'
    ))
    story.append(sp(4))

    story.append(p('<b>Oversight:</b>', BOLD))
    story.append(p(
        'All disclosures must be made in writing and submitted to <b>Scott McBrien, CCO</b>, '
        'who will determine whether the interest requires:'
    ))
    story.append(bl('Additional restrictions on trading activity'))
    story.append(bl('Documentation of waiver or clearance'))
    story.append(bl('Disclosure to fund investors or clients'))
    story.append(sp(4))
    story.append(p(
        'Failure to disclose a material interest before recommending or executing a '
        'transaction may result in disciplinary action, including restrictions on future '
        'trading, reassignment of responsibilities, or termination.'
    ))
    story.append(sp(8))


def build_section_16(story):
    story.append(head('16. Outside Business Activities', 'SECTION 16'))
    story.append(section_spacer())

    story.append(p(
        'STT Capital Advisors, LLC recognizes that supervised persons may be involved in '
        'professional or business activities outside of their roles with the Firm. While '
        'outside business interests are not strictly prohibited, they must not compromise '
        'the Firm\'s <b>fiduciary obligations</b>, <b>reputation</b>, or <b>regulatory '
        'responsibilities</b>.'
    ))
    story.append(sp(4))

    story.append(p('<b>Core Principles:</b>', BOLD))
    story.append(bl('Place <b>client and fund interests above personal business interests</b>'))
    story.append(bl('Avoid any <b>real or potential conflicts of interest</b>'))
    story.append(bl(
        'Never use their position at STT Capital Advisors, LLC to gain an unfair '
        'advantage in an outside venture'
    ))
    story.append(sp(4))

    story.append(p('<b>Prior Disclosure and Approval Required:</b>', BOLD))
    story.append(p(
        'Supervised persons must <b>submit written notice</b> and receive <b>written '
        'approval</b> from the <b>Chief Compliance Officer (CCO), Scott McBrien</b>, '
        'before engaging in any outside business activity that meets any of the following '
        'criteria:'
    ))
    story.append(bl(
        'The activity <b>involves or may result in compensation</b> (including '
        'commissions, equity, or referral fees)'
    ))
    story.append(bl(
        'The activity <b>involves a client or investor</b> of STT Capital Advisors, LLC, '
        'regardless of compensation'
    ))
    story.append(bl(
        'The activity <b>could result in access to material, nonpublic information</b> '
        'about a publicly traded company'
    ))
    story.append(sp(4))
    story.append(p(
        'This includes (but is not limited to) employment, consulting, board positions, '
        'entrepreneurial ventures, speaking engagements, or advisory work with outside firms.'
    ))
    story.append(sp(4))

    story.append(p('<b>Monitoring and Oversight:</b>', BOLD))
    story.append(p('The CCO will review all submissions and assess whether the activity:'))
    story.append(bl('Interferes with job responsibilities at STT Capital Advisors, LLC'))
    story.append(bl('Presents a regulatory, reputational, or compliance risk'))
    story.append(bl('Requires any special restrictions or disclosures'))
    story.append(sp(4))
    story.append(p(
        'The Firm may deny or conditionally approve any proposed activity and may revisit '
        'prior approvals as circumstances change.'
    ))
    story.append(sp(8))


def build_section_17(story):
    story.append(head('17. Service as an Officer or Director', 'SECTION 17'))
    story.append(section_spacer())

    story.append(p(
        'Supervised persons may not serve as an <b>officer, director, or similar leadership '
        'role</b> of any <b>public or private company</b> without <b>prior written '
        'authorization</b> from the <b>Chief Compliance Officer (CCO), Scott McBrien</b>, '
        'or a designated supervisory person.'
    ))
    story.append(sp(4))

    story.append(p('<b>Approval Criteria:</b>', BOLD))
    story.append(p(
        'Authorization will only be granted if the Firm determines that:'
    ))
    story.append(bl(
        'The position does <b>not present a conflict of interest</b> with client accounts'
    ))
    story.append(bl(
        'The role will not interfere with the supervised person\'s responsibilities at '
        'the Firm'
    ))
    story.append(bl(
        'The proposed service is <b>consistent with the best interests of STT Capital '
        'Advisors, LLC\'s clients</b> and its fiduciary obligations'
    ))
    story.append(sp(4))

    story.append(p('<b>Mitigation Procedures:</b>', BOLD))
    story.append(p(
        'If board or officer service is approved, the Firm will implement appropriate '
        '<b>information barriers</b>, including but not limited to:'
    ))
    story.append(bl(
        'A <b>"Chinese Wall"</b> to prevent the supervised person from accessing or '
        'sharing material nonpublic information'
    ))
    story.append(bl(
        'Restricting the supervised person from participating in investment decisions '
        'related to the company\'s securities'
    ))
    story.append(bl(
        'Ongoing <b>monitoring and documentation</b> of any involvement or potential '
        'conflicts'
    ))
    story.append(sp(4))

    story.append(p('<b>Ongoing Disclosure and Oversight:</b>', BOLD))
    story.append(p(
        'Approved roles must be disclosed in the supervised person\'s <b>annual compliance '
        'certification</b>, and the CCO may require the supervised person to provide '
        'periodic updates.'
    ))
    story.append(p(
        'Any material change in the nature of the outside position, the company\'s '
        'status, or the supervised person\'s relationship with the company must be '
        'promptly reported to the CCO.'
    ))
    story.append(sp(8))


def build_section_18(story):
    story.append(head('18. Gifts and Entertainment Policy', 'SECTION 18'))
    story.append(section_spacer())

    story.append(p(
        'Giving or receiving gifts or entertainment in a business context can create '
        'real or perceived conflicts of interest. STT Capital Advisors, LLC has adopted '
        'this policy to ensure that all supervised persons avoid inappropriate influence '
        'or the appearance of impropriety when interacting with clients, vendors, or other '
        'business partners.'
    ))
    story.append(sp(4))

    story.append(p('<b>General Guidelines:</b>', BOLD))
    story.append(bl(
        '<b>Cash gifts or cash equivalents</b> (e.g., gift cards) may not be given to or '
        'accepted from any <b>client, prospective client, vendor, or service provider</b> '
        'under any circumstances'
    ))
    story.append(bl(
        'Gifts, entertainment, or favors must <b>never be given or accepted</b> if doing '
        'so could reasonably be viewed as:'
    ))
    story.append(bl2('Influencing a business decision'))
    story.append(bl2('Impairing objective judgment'))
    story.append(bl2('Creating a sense of obligation or favoritism'))
    story.append(bl(
        '<b>Modest, occasional gifts or business entertainment</b> (e.g., meals, event '
        'tickets) are permitted <b>only if they are reasonable, infrequent, and customary</b> '
        'under accepted business practices'
    ))
    story.append(bl(
        'If local, state, or federal law imposes stricter limits, those standards take '
        'precedence'
    ))
    story.append(sp(4))

    story.append(p('<b>Pre-Approval and Reporting Requirements:</b>', BOLD))
    story.append(p('<i>Receiving Gifts or Entertainment:</i>', ITALIC_STYLE))
    story.append(bl(
        'If a supervised person is offered or receives anything of value <b>exceeding '
        '$250 annually</b> from any one person or organization doing business with '
        'STT Capital Advisors, LLC:'
    ))
    story.append(bl2(
        '<b>Pre-approval must be obtained</b> from the Chief Compliance Officer (CCO), '
        'Scott McBrien, or their designee'
    ))
    story.append(bl2(
        'If pre-approval is not possible in advance (e.g., unexpected gift or invitation), '
        'the gift must be reported <b>as soon as reasonably possible</b>'
    ))
    story.append(sp(4))
    story.append(p('<i>Giving Gifts or Entertainment:</i>', ITALIC_STYLE))
    story.append(bl(
        '<b>No supervised person may offer or provide</b> a gift or other item of value '
        'to a client, prospect, or business partner <b>without prior written approval</b> '
        'from the CCO or designee'
    ))
    story.append(sp(4))
    story.append(warn_box([
        'Note: These pre-approval and reporting rules do not apply to bona fide business '
        'entertainment, such as meals or sporting events, when the recipient is present '
        'and the expense is consistent with reasonable and customary business practices.'
    ]))
    story.append(sp(4))
    story.append(p(
        'If you are unsure whether a gift, invitation, or entertainment is appropriate, '
        'always consult the <b>CCO</b> before proceeding. Gift and Entertainment Forms '
        '(Exhibit C) should be used to document all reportable gifts.'
    ))
    story.append(sp(8))


def build_section_19(story):
    story.append(head('19. Blackout Periods', 'SECTION 19'))
    story.append(section_spacer())

    story.append(p(
        'STT Capital Advisors, LLC may impose blackout periods during which all or '
        'certain personal trading is restricted. Blackout periods may be triggered by:'
    ))
    story.append(bl(
        'Pending or anticipated trades by the Fund in the same or related securities'
    ))
    story.append(bl(
        'Periods when supervised persons may have access to material, nonpublic information'
    ))
    story.append(bl(
        'Other circumstances as determined by the CCO to be necessary for the protection '
        'of client interests'
    ))
    story.append(sp(4))
    story.append(p(
        'During a blackout period, no Access Person may execute personal transactions in '
        'the affected securities without express written approval from the CCO. Blackout '
        'periods will be communicated to affected personnel promptly, and violations will '
        'be treated as violations of this Code.'
    ))
    story.append(sp(8))


def build_section_20(story):
    story.append(head('20. Rumor Mongering Policy', 'SECTION 20'))
    story.append(section_spacer())

    story.append(p(
        'Spreading false or unsubstantiated market rumors is considered a serious form of '
        'market abuse under U.S. securities laws. It may also expose STT Capital Advisors, '
        'LLC and its supervised persons to regulatory action, civil liability, or '
        'reputational harm. This policy establishes the Firm\'s position on the generation '
        'and dissemination of rumors, both internally and externally, and the controls in '
        'place to monitor such activity.'
    ))
    story.append(sp(4))

    story.append(p('<b>General Policy:</b>', BOLD))
    story.append(p(
        'Supervised persons of STT Capital Advisors, LLC may <b>not originate, disseminate, '
        'or promote</b> false, misleading, or unsubstantiated information about any '
        'security, issuer, or market condition if such communication could impact the '
        'market or investment decisions.'
    ))
    story.append(p('This includes verbal or written statements made via:'))
    story.append(bl('Email, text, chat, or instant messaging (e.g., Bloomberg, Slack)'))
    story.append(bl('Published reports, research notes, newsletters'))
    story.append(bl('Blogs, social media, or informal forums'))
    story.append(bl('Verbal comments to clients, brokers, or peers'))
    story.append(sp(4))
    story.append(p(
        'All communications issued from or on behalf of the Firm must be <b>professional, '
        'factual, and avoid sensationalism</b>.'
    ))
    story.append(sp(4))

    story.append(p('<b>Definition of a Rumor:</b>', BOLD))
    story.append(p('For the purposes of this policy, a "rumor" includes:'))
    story.append(bl('Any <b>false or deliberately misleading</b> statement'))
    story.append(bl('Any <b>unverified or unsubstantiated claim</b> presented as fact'))
    story.append(bl(
        'Market chatter that lacks confirmation from a <b>credible, identified source</b>'
    ))
    story.append(sp(4))
    story.append(p('A statement <b>is not considered a rumor</b> if it is:'))
    story.append(bl(
        'Clearly presented as a <b>personal opinion</b> or analysis'
    ))
    story.append(bl(
        'Publicly reported by a <b>widely circulated media outlet</b> and attributed to '
        'a legitimate source'
    ))
    story.append(sp(4))

    story.append(p('<b>Trading Based on Rumors:</b>', BOLD))
    story.append(p(
        'No supervised person may place a trade on behalf of a client fund <b>based '
        'primarily on a rumor</b> without first obtaining approval from <b>Scott McBrien</b>, '
        'Chief Compliance Officer, or a member of senior management.'
    ))
    story.append(sp(4))

    story.append(p('<b>Monitoring and Enforcement:</b>', BOLD))
    story.append(p(
        'The Firm may conduct periodic reviews of employee communications and trading '
        'activity to detect:'
    ))
    story.append(bl('Patterns of potential rumor dissemination'))
    story.append(bl('Trading activity tied to suspicious or unexplained market movements'))
    story.append(sp(4))

    story.append(p('<b>Reporting Obligations:</b>', BOLD))
    story.append(p(
        'Supervised persons must <b>promptly report</b> any suspected rumor mongering or '
        'unsubstantiated information being shared, intentionally or recklessly, by any '
        'individual associated with the Firm. Reports should be made to the <b>Chief '
        'Compliance Officer</b> or a member of senior management.'
    ))
    story.append(sp(8))


def build_section_21(story):
    story.append(head('21. Compliance Procedures', 'SECTION 21'))
    story.append(section_spacer())

    story.append(p(
        'The Chief Compliance Officer (CCO), Scott McBrien, is responsible for '
        'administering and enforcing this Code. Compliance procedures include:'
    ))
    story.append(sp(4))

    story.append(p('<b>Annual Certification:</b>', BOLD))
    story.append(bl(
        'By July 30 of each year, each supervised person must certify that they have read '
        'and understand this Code, that they recognize it applies to them, and that they '
        'have complied with all of its rules and requirements'
    ))
    story.append(bl(
        'Attestations may be delivered directly to the CCO using Exhibit B'
    ))
    story.append(sp(4))

    story.append(p('<b>Exceptions:</b>', BOLD))
    story.append(p(
        'Where the CCO determines that strict compliance with certain of the specific rules '
        'prescribed above would be detrimental to Clients\' interests or the limitations '
        'on an Employee\'s legitimate interests that would result would not be justified, '
        'the CCO may approve particular transactions or types of transactions that do not '
        'comply with all particulars of such rules. The CCO will specify the limits and '
        'basis for each such exception.'
    ))
    story.append(sp(4))

    story.append(p('<b>Retention of Reports and Records:</b>', BOLD))
    story.append(p(
        'The CCO will maintain at STT Capital Advisors, LLC principal office for at least '
        'five years a confidential (subject to inspection by regulatory authorities) record '
        'of each reported violation of this Code and of any action taken as a result of '
        'such violation. The CCO will also cause to be maintained in appropriate places all '
        'other records relating to this Code that are required to be maintained by '
        'Rule 204-2 under the Investment Advisers Act of 1940.'
    ))
    story.append(sp(4))

    story.append(p('<b>Reports of Violations:</b>', BOLD))
    story.append(p(
        'Any supervised person who learns of any violation, apparent violation, or '
        'potential violation of this Code is required to advise the CCO as soon as '
        'practicable. The CCO will then take such action as may be appropriate under '
        'the circumstances.'
    ))
    story.append(sp(4))

    story.append(p('<b>Sanctions:</b>', BOLD))
    story.append(p(
        'Upon discovering that any supervised person has failed to comply with the '
        'requirements of this Code, STT Capital Advisors, LLC may impose whatever '
        'sanctions management considers appropriate under the circumstances, including '
        'censure, suspension, limitations on permitted activities, or termination of '
        'employment.'
    ))
    story.append(sp(8))


def build_section_22(story):
    story.append(head('22. Whistleblower Policy', 'SECTION 22'))
    story.append(section_spacer())

    story.append(p(
        'STT Capital Advisors, LLC is committed to maintaining a culture of integrity, '
        'transparency, and accountability. As part of this commitment, all supervised '
        'persons are expected to report any <b>suspected misconduct</b>, <b>violations of '
        'policy</b>, or <b>unethical behavior</b> that could harm the Firm, its clients, '
        'or its reputation.'
    ))
    story.append(p(
        'This policy ensures that all concerns can be reported <b>confidentially, without '
        'fear of retaliation</b>, and in a manner that allows for proper investigation and '
        'resolution.'
    ))
    story.append(sp(4))

    story.append(p('<b>Reporting Misconduct:</b>', BOLD))
    story.append(p('Supervised persons are required to report any concerns related to:'))
    story.append(bl('Violations of the Firm\'s <b>Code of Ethics</b> or <b>Compliance Manual</b>'))
    story.append(bl('Suspected <b>fraud, insider trading, market abuse</b>, or <b>breach of fiduciary duty</b>'))
    story.append(bl('<b>Improper conduct</b> by employees, management, or vendors'))
    story.append(bl('Concerns about <b>accounting, audit irregularities</b>, or <b>client harm</b>'))
    story.append(sp(4))
    story.append(p(
        'Reports may be submitted using the "Report a Violation" form available via the '
        'Firm\'s internal portal. Reports may be submitted <b>anonymously</b>, unless the '
        'individual opts to include their identity.'
    ))
    story.append(p(
        'All reports will be directed to the <b>Chief Compliance Officer (CCO), Scott '
        'McBrien</b>, or to other designated senior management, especially if the report '
        'involves the CCO.'
    ))
    story.append(sp(4))

    story.append(p('<b>Good Faith Requirement:</b>', BOLD))
    story.append(p(
        'Whistleblowers must act in <b>good faith</b> and have <b>reasonable grounds</b> '
        'to believe the information reported reflects actual or potential misconduct. '
        'Knowingly submitting <b>false or malicious allegations</b> is a serious offense '
        'and may result in disciplinary action, including termination.'
    ))
    story.append(sp(4))

    story.append(p('<b>Confidentiality:</b>', BOLD))
    story.append(p(
        'All reports will be handled <b>confidentially and discreetly</b>. Information '
        'will be shared only with those necessary to investigate and resolve the issue. '
        'The Firm will not disclose the identity of the reporting person unless legally '
        'required to do so.'
    ))
    story.append(sp(4))

    story.append(p('<b>No Retaliation Policy:</b>', BOLD))
    story.append(p(
        'STT Capital Advisors, LLC strictly prohibits retaliation against any supervised '
        'person who, in good faith, reports a concern or participates in an investigation. '
        'This includes protection from:'
    ))
    story.append(bl('Termination or demotion'))
    story.append(bl('Harassment or intimidation'))
    story.append(bl('Adverse changes in duties or working conditions'))
    story.append(sp(4))
    story.append(p(
        'Anyone who retaliates against a whistleblower will face disciplinary action, up '
        'to and including termination.'
    ))
    story.append(sp(4))

    story.append(p('<b>SEC Whistleblower Program:</b>', BOLD))
    story.append(p(
        'The Dodd-Frank Wall Street Reform and Consumer Protection Act provided the SEC '
        'with the authority to pay financial rewards to whistleblowers who provide new and '
        'timely information about any securities law violation. STT Capital Advisors, LLC '
        'employees can report a concern directly to the SEC and STT Capital Advisors, LLC '
        'will not interfere with a whistleblower\'s efforts to communicate with the SEC. '
        'The Firm will comply with the anti-retaliation provisions under the SEC '
        'whistleblower rules.'
    ))
    story.append(sp(8))


def build_section_23(story):
    story.append(head('23. Reporting Violations and Sanctions', 'SECTION 23'))
    story.append(section_spacer())

    story.append(p('<b>Reporting Violations:</b>', BOLD))
    story.append(p(
        'All supervised persons have a responsibility to <b>promptly report</b> any '
        'actual, suspected, or potential violations of the <b>Code of Ethics</b> or '
        'related compliance policies. Reports should be made directly to the <b>Chief '
        'Compliance Officer (CCO), Scott McBrien</b>, or to an alternate designee if '
        'necessary, with the CCO also receiving a copy.'
    ))
    story.append(sp(4))
    story.append(warn_box([
        'Retaliation for reporting violations is strictly prohibited and will itself be '
        'treated as a violation of this Code.'
    ]))
    story.append(sp(4))

    story.append(p('<b>CCO Responsibilities:</b>', BOLD))
    story.append(p(
        'Upon receiving a report, the CCO will promptly evaluate the issue and:'
    ))
    story.append(bl('Determine whether it constitutes a <b>material violation</b> of the Code'))
    story.append(bl('<b>Report material violations to senior management</b> for further review'))
    story.append(bl(
        'If the matter is determined <b>not to involve fraud, deceit, or manipulative '
        'practices</b> under Section 206 of the Advisers Act, the CCO may instead document '
        'the findings in a written memo retained in the Firm\'s compliance records'
    ))
    story.append(sp(4))

    story.append(p('<b>Senior Management Oversight:</b>', BOLD))
    story.append(p(
        'Senior management will review any material violations brought to their attention '
        'and determine:'
    ))
    story.append(bl('Whether a <b>violation of the Code</b> has occurred'))
    story.append(bl('What <b>corrective or disciplinary action</b> should be taken, if any'))
    story.append(sp(4))

    story.append(p('<b>Possible Sanctions:</b>', BOLD))
    story.append(bl('Verbal or written reprimand'))
    story.append(bl('Compliance training or remedial action'))
    story.append(bl('Monetary fines or restitution'))
    story.append(bl('Suspension of trading privileges'))
    story.append(bl('Termination of employment'))
    story.append(sp(4))
    story.append(p(
        'Each case will be assessed individually, with consideration for the nature of '
        'the violation, intent, prior conduct, and potential client impact.'
    ))
    story.append(sp(8))


def build_section_24(story):
    story.append(head('24. Records Retention Policy', 'SECTION 24'))
    story.append(section_spacer())

    story.append(p(
        'To support regulatory compliance and internal accountability, STT Capital '
        'Advisors, LLC maintains key records related to its <b>Code of Ethics</b> and '
        'supervised persons, as required under <b>Advisers Act Rule 204A-1</b> and '
        'applicable SEC guidelines.'
    ))
    story.append(sp(4))

    story.append(p('<b>Chief Compliance Officer Responsibilities:</b>', BOLD))
    story.append(p(
        'The <b>Chief Compliance Officer (CCO), Scott McBrien</b>, is responsible for '
        'ensuring that the following records are maintained in a <b>readily accessible '
        'location</b> and retained according to the required timelines:'
    ))
    story.append(sp(4))

    story.append(p('<b>Required Records:</b>', BOLD))

    records = [
        ('Code of Ethics', 'A copy of each version of the Firm\'s Code of Ethics that '
         'is or has been in effect during the past five (5) years'),
        ('Violations and\nDisciplinary Actions',
         'A record of any violation of the Code, including the nature of the violation, '
         'actions taken in response, and the date and outcome of the resolution. '
         'Records must be kept for five years from the end of the fiscal year in which '
         'the violation occurred.'),
        ('Acknowledgement\nof the Code',
         'A record of all written acknowledgements of receipt of the Code and any '
         'amendments by each current or former supervised person. Retention: Five years '
         'after the person ceases to be a supervised person of the Firm.'),
        ('Personal Securities\nReports',
         'A copy of each initial, annual, and quarterly transaction report submitted '
         'under the Code. This includes any brokerage confirmations or account statements '
         'submitted in lieu of formal reports.'),
        ('Access Persons List',
         'A list of all persons who are, or have been within the past five years, '
         'designated as access persons.'),
        ('IPO and Private\nPlacement Approvals',
         'A record of decisions to approve an access person\'s participation in any '
         'Initial Public Offering (IPO) or private placement/limited offering. '
         'The record must include the reasons for approval and be retained for five '
         'years from the end of the fiscal year in which the approval was granted.'),
    ]

    for label, desc in records:
        story.append(KeepTogether([
            p(f'<b>{label.replace(chr(10), " ")}:</b>'),
            p(desc, INDENT),
            sp(4),
        ]))

    story.append(sp(8))


# ══════════════════════════════════════════════════════════════════════════════
#  EXHIBITS
# ══════════════════════════════════════════════════════════════════════════════

def build_exhibit_a(story):
    story.append(PageBreak())
    story.append(head('Exhibit A: Record Retention Table', 'EXHIBIT A'))
    story.append(section_spacer())
    story.append(p(
        'This Record Retention Policy outlines the documents that STT Capital Advisors, '
        'LLC (the "Firm") must maintain in accordance with regulatory obligations under '
        'the Investment Advisers Act of 1940, as an Exempt Reporting Adviser (ERA), and '
        'applicable best practices.'
    ))
    story.append(sp(6))

    rows = [
        ['#', 'Document Category', 'Retention Period', 'Maintained By'],
        ['1', 'Corporate Records', 'Life of entity + 3 years', 'Compliance Officer'],
        ['2', 'Organizational Records', '5 years', 'Compliance Officer'],
        ['3', 'Policies & Procedures', '5 years', 'Compliance Officer'],
        ['4', 'Employee Trading Records', '5 years', 'Compliance Officer'],
        ['5', 'Registration Records', 'Life of entity + 3 years', 'Compliance Officer'],
        ['6', 'Form ADV', 'Life of entity + 3 years', 'Compliance Officer'],
        ['7', 'State Filings', 'Life of entity + 3 years', 'Compliance Officer'],
        ['8', 'Disclosure Delivery', '5 years', 'Compliance Officer'],
        ['9', 'Client Agreements', '5 years', 'Compliance Officer'],
        ['10', 'Marketing Materials', '5 years', 'Compliance Officer'],
        ['11', 'Performance Records', '5 years from publication', 'Compliance Officer'],
        ['12', 'Solicitor Records', '5 years', 'Compliance Officer'],
        ['13', 'Financial Records', '5 years', 'Accounting'],
        ['14', 'Trading Records', '5 years', 'Compliance Officer'],
        ['15', 'Discretionary Authority', '5 years', 'Compliance Officer'],
        ['16', 'Client Complaints', '5 years', 'Compliance Officer'],
        ['17', 'Custody Records', '5 years', 'Compliance Officer'],
        ['18', 'SEC Ownership Reports', 'Life of entity + 3 years', 'N/A'],
        ['19', 'Privacy Notices', '5 years', 'Compliance Officer'],
        ['20', 'Compliance Program', '5 years', 'Compliance Officer'],
        ['21', 'Code of Ethics', '5 years', 'Compliance Officer'],
        ['22', 'Proxy Voting', '5 years', 'Compliance Officer'],
        ['23', 'Internal Compliance', '5 years', 'Compliance Officer'],
    ]
    story.append(styled_table(rows, col_widths=[0.35*inch, 1.8*inch, 1.8*inch, BODY_W - 3.95*inch]))
    story.append(sp(6))
    story.append(p(
        'This schedule shall be reviewed and updated by the CCO annually or as needed in '
        'response to regulatory changes or firm-specific developments.',
        SMALL
    ))
    story.append(sp(8))


def build_exhibit_b(story):
    story.append(PageBreak())
    story.append(head('Exhibit B: Certification and Acknowledgement of Receipt', 'EXHIBIT B'))
    story.append(section_spacer())

    story.append(p(
        'I acknowledge and certify that I have received a copy of STT Capital Advisors\' '
        'Policies and Procedures Manual and Code of Ethics. I understand and agree that it '
        'is my responsibility to read and familiarize myself with the policies and '
        'procedures contained in the Policies and Procedures Manual and Code of Ethics '
        'and to abide by those policies and procedures.'
    ))
    story.append(sp(30))

    # Signature lines
    sig_data = [
        ['_' * 40, '_' * 40],
        ['Employee Name (Please Print)', 'Employee Signature'],
    ]
    tbl = Table(sig_data, colWidths=[3.2*inch, 3.2*inch])
    tbl.setStyle(TableStyle([
        ('ALIGN', (0,0), (-1,-1), 'LEFT'),
        ('FONT', (0,1), (-1,1), FONT_REGULAR, 8),
        ('TEXTCOLOR', (0,1), (-1,1), PNTHR_GREY_600),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
    ]))
    story.append(tbl)
    story.append(sp(20))
    story.append(p('Date: _________________________', SIG_STYLE))
    story.append(sp(8))


def build_exhibit_c(story):
    story.append(PageBreak())
    story.append(head('Exhibit C: Gift and Entertainment Form', 'EXHIBIT C'))
    story.append(section_spacer())
    story.append(p('STT Capital Advisors, LLC', BOLD))
    story.append(sp(6))

    story.append(p('<b>Employee Information</b>', H2))
    story.append(sp(4))
    story.append(p('Employee Name: _____________________________________________', FORM_FIELD))
    story.append(p('Date Submitted: _____________________________________________', FORM_FIELD))

    story.append(sp(8))
    story.append(p('<b>Vendor Details</b>', H2))
    story.append(sp(4))
    story.append(p('Vendor Name: _____________________________________________', FORM_FIELD))
    story.append(p('Vendor Representative Name: _____________________________________________', FORM_FIELD))
    story.append(sp(4))
    story.append(p('Was the Vendor Present During the Event or Meal?  [ ] Yes  [ ] No', FORM_FIELD))

    story.append(sp(8))
    story.append(p('<b>Event/Meal Description</b>', H2))
    story.append(p('<i>Provide a brief description of the event, entertainment, or meal:</i>', ITALIC_STYLE))
    story.append(sp(4))
    for _ in range(4):
        story.append(p('_' * 80, FORM_FIELD))

    story.append(sp(8))
    story.append(p('<b>Gift or Entertainment Value</b>', H2))
    story.append(p('(If vendor was not present at the time of receipt)', SMALL))
    story.append(p('Estimated Value: $_______________', FORM_FIELD))
    story.append(sp(4))
    story.append(p('Description of Gift:', FORM_LABEL))
    for _ in range(3):
        story.append(p('_' * 80, FORM_FIELD))

    story.append(sp(12))
    story.append(p('Employee Signature: _____________________________________________', FORM_FIELD))
    story.append(p('Date: _______________', FORM_FIELD))
    story.append(sp(8))
    story.append(p('CCO Approval (if required): _____________________________________________', FORM_FIELD))
    story.append(p('Date Approved: _______________', FORM_FIELD))
    story.append(sp(8))


def build_exhibit_d(story):
    story.append(PageBreak())
    story.append(head('Exhibit D: Personal Account Trading Authorization Form', 'EXHIBIT D'))
    story.append(section_spacer())
    story.append(p('STT Capital Advisors, LLC', BOLD))
    story.append(sp(6))

    story.append(p('<b>Employee Information</b>', H2))
    story.append(sp(4))
    story.append(p('Employee Name: _____________________________________________', FORM_FIELD))
    story.append(p('Date of Request: _____________________________________________', FORM_FIELD))

    story.append(sp(8))
    story.append(p('<b>Trade Details</b>', H2))
    story.append(sp(4))
    story.append(p('Type of Trade:  [ ] Buy  [ ] Sell', FORM_FIELD))
    story.append(p('Number of Shares: _____________________________________________', FORM_FIELD))
    story.append(p('Security Name / Ticker Symbol: _________________________________ / _____________', FORM_FIELD))
    story.append(p('Broker: _____________________________________________', FORM_FIELD))

    story.append(sp(8))
    story.append(p('<b>Additional Information</b>', H2))
    story.append(p('<i>(e.g., private placement details, rationale, restrictions, etc.)</i>', ITALIC_STYLE))
    for _ in range(4):
        story.append(p('_' * 80, FORM_FIELD))

    story.append(sp(12))
    story.append(p('<b>Authorization Section (To Be Completed by CCO)</b>', H2))
    story.append(sp(4))
    story.append(p('Approved:  [ ] Yes  [ ] No', FORM_FIELD))
    story.append(p('CCO Signature: _____________________________________________', FORM_FIELD))
    story.append(p('Date: _______________', FORM_FIELD))
    story.append(sp(4))
    story.append(p('Notes / Conditions (if any):', FORM_LABEL))
    for _ in range(3):
        story.append(p('_' * 80, FORM_FIELD))
    story.append(sp(8))


def build_exhibit_e(story):
    story.append(PageBreak())
    story.append(head('Exhibit E: Employee Disclosure Form', 'EXHIBIT E'))
    story.append(section_spacer())

    story.append(p(
        'As part of the Firm\'s affiliation with the U.S. Securities and Exchange '
        'Commission (SEC) all Employees will be required to answer the following '
        'questions, then sign and date on page two.'
    ))
    story.append(p(
        'In this Item, we ask for information about your disciplinary history. The SEC '
        'uses this information to determine whether to grant our Firm\'s application for '
        'registration, to decide whether to revoke our registration or to place '
        'limitations on our activities as an investment adviser, and to identify potential '
        'problem areas to focus on during on-site examinations.'
    ))
    story.append(sp(4))
    story.append(p(
        'Please note that one event may result in "yes" answers to more than one of the '
        'questions below.',
        ITALIC_STYLE
    ))
    story.append(sp(6))

    # Section A
    story.append(p('<b>A. In the past ten years, have you:</b>', BOLD))
    story.append(bl(
        '(1) been convicted of or pled guilty or nolo contendere ("no contest") in a '
        'domestic, foreign, or military court to any <i>felony</i>?  [ ] Yes  [ ] No'
    ))
    story.append(bl(
        '(2) been <i>charged</i> with any <i>felony</i>?  [ ] Yes  [ ] No'
    ))
    story.append(sp(4))

    # Section B
    story.append(p('<b>B. In the past ten years, have you:</b>', BOLD))
    story.append(bl(
        '(1) been convicted of or pled guilty or nolo contendere ("no contest") in a '
        'domestic, foreign, or military court to a <i>misdemeanor</i> involving: '
        'investments or an <i>investment-related</i> business, or any fraud, false '
        'statements, wrongful taking of property, bribery, perjury, forgery, '
        'counterfeiting, extortion, or a conspiracy to commit any of these offenses?  '
        '[ ] Yes  [ ] No'
    ))
    story.append(bl(
        '(2) been <i>charged</i> with a <i>misdemeanor</i> listed in Item B(1)?  '
        '[ ] Yes  [ ] No'
    ))
    story.append(sp(4))

    # Section C
    story.append(p('<b>C. Has the SEC or the Commodity Futures Trading Commission (CFTC) ever:</b>', BOLD))
    story.append(bl('(1) <i>found</i> you to have made a false statement or omission?  [ ] Yes  [ ] No'))
    story.append(bl('(2) <i>found</i> you to have been <i>involved</i> in a violation of SEC or CFTC regulations or statutes?  [ ] Yes  [ ] No'))
    story.append(bl('(3) <i>found</i> you to have been a cause of an <i>investment-related</i> business having its authorization to do business denied, suspended, revoked, or restricted?  [ ] Yes  [ ] No'))
    story.append(bl('(4) entered an <i>order</i> against you in connection with <i>investment-related</i> activity?  [ ] Yes  [ ] No'))
    story.append(bl('(5) imposed a civil money penalty on you, or <i>ordered</i> you to cease and desist from any activity?  [ ] Yes  [ ] No'))
    story.append(sp(4))

    # Section D
    story.append(p('<b>D. Has any other federal regulatory agency, any state regulatory agency, or any <i>foreign financial regulatory authority</i>:</b>', BOLD))
    story.append(bl('(1) ever <i>found</i> you to have made a false statement or omission, or been dishonest, unfair, or unethical?  [ ] Yes  [ ] No'))
    story.append(bl('(2) ever <i>found</i> you to have been <i>involved</i> in a violation of <i>investment-related</i> regulations or statutes?  [ ] Yes  [ ] No'))
    story.append(bl('(3) ever <i>found</i> you to have been a cause of an <i>investment-related</i> business having its authorization to do business denied, suspended, revoked, or restricted?  [ ] Yes  [ ] No'))
    story.append(bl('(4) in the past ten years, entered an <i>order</i> against you in connection with an <i>investment-related</i> activity?  [ ] Yes  [ ] No'))
    story.append(bl('(5) ever denied, suspended, or revoked your registration or license, or otherwise prevented you, by <i>order</i>, from associating with an <i>investment-related</i> business or restricted your activity?  [ ] Yes  [ ] No'))

    story.append(sp(20))
    story.append(p('Employee Signature: _____________________________________________', FORM_FIELD))
    story.append(p('Date: _______________', FORM_FIELD))
    story.append(sp(8))


# ══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def _cover_page_callback(canvas, doc):
    canvas.saveState()
    draw_cover_header(canvas,
                      title='Code of Ethics Manual',
                      subtitle='STT Capital Advisors, LLC  |  Carnivore Quant Fund, LP  |  May 2025')
    draw_cover_bottom_band(canvas,
                           'STRICTLY CONFIDENTIAL - FOR AUTHORIZED PARTIES ONLY')
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
        title='Carnivore Quant Fund, LP - Code of Ethics Manual',
        author='PNTHR Funds, LLC',
        subject='Code of Ethics Manual',
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
    build_cover(story)
    story.insert(len(story) - 1, NextPageTemplate('interior'))

    build_toc(story)
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
    build_section_13(story)
    build_section_14(story)
    build_section_15(story)
    build_section_16(story)
    build_section_17(story)
    build_section_18(story)
    build_section_19(story)
    build_section_20(story)
    build_section_21(story)
    build_section_22(story)
    build_section_23(story)
    build_section_24(story)

    # Exhibits
    build_exhibit_a(story)
    build_exhibit_b(story)
    build_exhibit_c(story)
    build_exhibit_d(story)
    build_exhibit_e(story)

    NumberedCanvas = make_numbered_canvas(
        doc_slug='CODE OF ETHICS \xb7 STT CAPITAL ADVISORS, LLC \xb7 CONFIDENTIAL',
        doc_name='Code of Ethics Manual',
        confidentiality='Strictly Confidential',
        cover_pages=1,
    )
    doc.build(story, canvasmaker=NumberedCanvas)

    size_kb = os.path.getsize(OUT) // 1024
    print(f'\n[OK] PNTHR Code of Ethics generated: {OUT}')
    print(f'  Size: {size_kb} KB')


if __name__ == '__main__':
    main()
