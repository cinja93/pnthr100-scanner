#!/usr/bin/env python3
"""
generateBCDRP.py
PNTHR Funds: Carnivore Quant Fund, LP
Business Continuity and Disaster Recovery Plan (BCDRP)

Branded version using pnthr_doc_style v4.
Source: Original BCDRP dated May 1, 2025, cross-referenced against PPM v5.2
for title/role alignment.

All officer titles corrected to match PPM v5.2:
  - Scott McBrien: Managing Member, Chief Investment Officer & Chief Compliance Officer
  - Cindy Eagar: Managing Member, Chief Operating Officer & Chief Information Security Officer

Usage:  cd server/backtest && python3 generateBCDRP.py
Output: client/public/PNTHR_BCDRP.pdf
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

# ── Brand Design System ──────────────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(__file__))
from pnthr_doc_style import (
    PNTHR_YELLOW, PNTHR_BLACK, PNTHR_INK, PNTHR_GREY_600, PNTHR_GREY_400,
    PNTHR_GREY_100, PNTHR_CREAM,
    FONT_REGULAR, FONT_BOLD, FONT_ITALIC, FONT_BOLD_ITALIC,
    PAGE_WIDTH, PAGE_HEIGHT, MARGIN_LEFT, MARGIN_RIGHT, MARGIN_TOP, MARGIN_BOTTOM,
    set_asset_paths, draw_cover_header, draw_cover_bottom_band,
    make_numbered_canvas, SectionHeading, CalloutBox, build_info_table,
    get_paragraph_styles, section_spacer, article_spacer, para,
)

# ── Paths ────────────────────────────────────────────────────────────────────
HERE   = os.path.dirname(__file__)
PUBLIC = os.path.join(HERE, '../../client/public')
LOGO   = os.path.join(PUBLIC, 'pnthr-funds-cqf-logo-white-bg.png')
OUT    = os.path.join(PUBLIC, 'PNTHR_BCDRP.pdf')

set_asset_paths(LOGO)

# ── Styles ───────────────────────────────────────────────────────────────────
_styles = get_paragraph_styles()
NORMAL     = _styles['body']
BOLD       = _styles['body_bold']
CENTER     = _styles['body_center']
BODY_W     = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT

BULLET = ParagraphStyle('bullet_bcdrp', parent=NORMAL, leftIndent=18,
                        firstLineIndent=-12, spaceAfter=4)
BULLET2 = ParagraphStyle('bullet2_bcdrp', parent=NORMAL, fontSize=8, leading=11,
                         leftIndent=32, firstLineIndent=-12, spaceAfter=3)
H2 = ParagraphStyle('h2_bcdrp', parent=NORMAL, fontName=FONT_BOLD, fontSize=11,
                     leading=14, spaceBefore=12, spaceAfter=4, textColor=PNTHR_BLACK)
H3 = ParagraphStyle('h3_bcdrp', parent=NORMAL, fontName=FONT_BOLD, fontSize=9.5,
                     leading=13, spaceBefore=8, spaceAfter=3, textColor=PNTHR_BLACK)
WARN_STYLE = ParagraphStyle('warn_bcdrp', parent=NORMAL, fontName=FONT_BOLD,
                            fontSize=8, leading=11, spaceAfter=4)
SIG_STYLE = ParagraphStyle('sig_bcdrp', parent=NORMAL, fontSize=9, leading=14,
                           spaceAfter=2)

def sp(h=6): return Spacer(1, h)
def p(text, style=None): return Paragraph(text, style or NORMAL)
def bl(text): return Paragraph(f'&#8226; {text}', BULLET)
def bl2(text): return Paragraph(f'- {text}', BULLET2)
def head(title, sub=None): return SectionHeading(title, sub_label=sub)

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


# ══════════════════════════════════════════════════════════════════════════════
#  CONTENT
# ══════════════════════════════════════════════════════════════════════════════

def build_cover(story):
    story.append(sp(3.8 * inch))
    info_rows = [
        ('Firm', 'STT Capital Advisors, LLC'),
        ('Fund', 'Carnivore Quant Fund, LP'),
        ('Effective Date', 'May 1, 2025'),
        ('Last Reviewed', 'April 2026'),
        ('Primary Contact', 'Cindy Eagar, Managing Member, COO & CISO'),
        ('Alternate Contact', 'Scott McBrien, Managing Member, CIO & CCO'),
        ('Principal Office', '15150 W Park Place, Suite 215, Goodyear, AZ 85395'),
    ]
    story.append(build_info_table(info_rows, header='DOCUMENT PARTICULARS'))
    story.append(sp(18))
    story.append(p(
        'This Business Continuity and Disaster Recovery Plan ("BCDRP") is designed to '
        'ensure the continued operation of STT Capital Advisors, LLC and Carnivore Quant '
        'Fund, LP in the event of a significant business disruption. It is reviewed and '
        'updated at least annually by the Chief Operating Officer & Chief Information '
        'Security Officer.',
        CENTER
    ))
    story.append(PageBreak())


def build_section_1(story):
    """1. Purpose and Objectives"""
    story.append(head('1. Purpose and Objectives', 'SECTION 1'))
    story.append(section_spacer())
    story.append(p(
        'The purpose of this Business Continuity and Disaster Recovery Plan is to '
        'establish procedures and protocols that will allow STT Capital Advisors, LLC '
        '(the "Firm") and Carnivore Quant Fund, LP (the "Fund") to continue critical '
        'business operations with minimal disruption in the event of a significant '
        'business interruption.'
    ))
    story.append(p('The objectives of this BCDRP are to:'))
    story.append(bl('Safeguard the interests of investors and stakeholders'))
    story.append(bl('Maintain access to critical systems, data, and communications'))
    story.append(bl('Ensure compliance with regulatory obligations during disruptions'))
    story.append(bl('Minimize financial and operational impact from unforeseen events'))
    story.append(bl('Provide clear protocols for personnel to follow during emergencies'))
    story.append(sp(6))


def build_section_2(story):
    """2. Scope"""
    story.append(head('2. Scope', 'SECTION 2'))
    story.append(section_spacer())
    story.append(p(
        'This plan applies to all operations of STT Capital Advisors, LLC and '
        'Carnivore Quant Fund, LP, including but not limited to:'
    ))
    story.append(bl('Investment management and trade execution'))
    story.append(bl('Portfolio monitoring and risk management'))
    story.append(bl('Investor communications and reporting'))
    story.append(bl('Regulatory compliance and recordkeeping'))
    story.append(bl('Technology systems and data infrastructure'))
    story.append(bl('Administrative and operational functions'))
    story.append(sp(6))


def build_section_3(story):
    """3. Types of Business Disruptions"""
    story.append(head('3. Types of Business Disruptions', 'SECTION 3'))
    story.append(section_spacer())
    story.append(p('This plan addresses the following categories of disruption:'))
    story.append(sp(4))

    story.append(Paragraph('<b>Natural Disasters</b>', BOLD))
    story.append(bl('Earthquakes, floods, wildfires, severe storms, pandemics'))

    story.append(Paragraph('<b>Technology Failures</b>', BOLD))
    story.append(bl('Server or cloud infrastructure outages'))
    story.append(bl('Internet or telecommunications failures'))
    story.append(bl('Cyberattacks, ransomware, data breaches'))

    story.append(Paragraph('<b>Facility Disruptions</b>', BOLD))
    story.append(bl('Loss of access to principal office'))
    story.append(bl('Power outages or utility failures'))

    story.append(Paragraph('<b>Personnel Disruptions</b>', BOLD))
    story.append(bl('Incapacitation of key personnel'))
    story.append(bl('Sudden departure of critical staff'))
    story.append(sp(6))


def build_section_4(story):
    """4. Key Personnel and Responsibilities"""
    story.append(head('4. Key Personnel and Responsibilities', 'SECTION 4'))
    story.append(section_spacer())

    rows = [
        ['Role', 'Name', 'Responsibilities'],
        ['Managing Member,\nCOO & CISO\n(Primary Contact)',
         'Cindy Eagar',
         'Overall BCP coordination, cybersecurity response,\n'
         'investor communications, regulatory notifications'],
        ['Managing Member,\nCIO & CCO\n(Alternate Contact)',
         'Scott McBrien',
         'Investment operations continuity, trade execution,\n'
         'compliance oversight, counterparty coordination'],
    ]

    styled_rows = []
    for i, row in enumerate(rows):
        cells = []
        for cell in row:
            style = WARN_STYLE if i == 0 else ParagraphStyle(
                f'tc_{i}', parent=NORMAL, fontSize=8, leading=11)
            cells.append(Paragraph(cell.replace('\n', '<br/>'), style))
        styled_rows.append(cells)

    tbl = Table(styled_rows, colWidths=[1.8*inch, 1.2*inch, BODY_W - 3.0*inch])
    tbl.setStyle(TableStyle([
        ('VALIGN',       (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING',  (0,0), (-1,-1), 10),
        ('RIGHTPADDING', (0,0), (-1,-1), 10),
        ('TOPPADDING',   (0,0), (-1,-1), 6),
        ('BOTTOMPADDING',(0,0), (-1,-1), 6),
        ('LINEBEFORE',   (0,0), (0,-1),  3, PNTHR_YELLOW),
        ('GRID',         (0,0), (-1,-1), 0.3, PNTHR_GREY_400),
        ('BACKGROUND',   (0,0), (-1,0),  PNTHR_BLACK),
        ('TEXTCOLOR',    (0,0), (-1,0),  white),
        ('FONT',         (0,0), (-1,0),  FONT_BOLD, 8),
        ('BACKGROUND',   (0,1), (-1,1),  PNTHR_GREY_100),
    ]))
    story.append(tbl)
    story.append(sp(8))

    story.append(warn_box([
        'Contact Priority: In the event of a disruption, Cindy Eagar (COO & CISO) '
        'should be contacted first as the designated Business Continuity Officer. '
        'If unavailable, contact Scott McBrien (CIO & CCO) as the alternate.'
    ]))
    story.append(sp(6))


def build_section_5(story):
    """5. Critical Systems and Infrastructure"""
    story.append(head('5. Critical Systems and Infrastructure', 'SECTION 5'))
    story.append(section_spacer())

    rows = [
        ['System', 'Provider', 'Recovery Priority'],
        ['Brokerage & Execution', 'Interactive Brokers LLC', 'Critical (< 4 hours)'],
        ['Fund Administration', 'NAV Consulting Inc.', 'High (< 24 hours)'],
        ['Cloud Infrastructure', 'MongoDB Atlas / Render / Vercel', 'Critical (< 4 hours)'],
        ['Market Data', 'Financial Modeling Prep (FMP)', 'High (< 24 hours)'],
        ['Email & Communications', 'Google Workspace', 'Critical (< 4 hours)'],
        ['Document Storage', 'Google Drive (encrypted)', 'High (< 24 hours)'],
        ['Signal Processing', 'PNTHR Scanner (proprietary)', 'Critical (< 4 hours)'],
    ]

    styled_rows = []
    for i, row in enumerate(rows):
        cells = []
        for cell in row:
            style = WARN_STYLE if i == 0 else ParagraphStyle(
                f'sys_{i}', parent=NORMAL, fontSize=8, leading=11)
            cells.append(Paragraph(cell, style))
        styled_rows.append(cells)

    tbl = Table(styled_rows, colWidths=[2.0*inch, 2.2*inch, BODY_W - 4.2*inch])
    style_cmds = [
        ('VALIGN',       (0,0), (-1,-1), 'MIDDLE'),
        ('LEFTPADDING',  (0,0), (-1,-1), 10),
        ('RIGHTPADDING', (0,0), (-1,-1), 10),
        ('TOPPADDING',   (0,0), (-1,-1), 5),
        ('BOTTOMPADDING',(0,0), (-1,-1), 5),
        ('LINEBEFORE',   (0,0), (0,-1),  3, PNTHR_YELLOW),
        ('GRID',         (0,0), (-1,-1), 0.3, PNTHR_GREY_400),
        ('BACKGROUND',   (0,0), (-1,0),  PNTHR_BLACK),
        ('TEXTCOLOR',    (0,0), (-1,0),  white),
        ('FONT',         (0,0), (-1,0),  FONT_BOLD, 8),
    ]
    for i in range(1, len(rows)):
        if (i - 1) % 2 == 0:
            style_cmds.append(('BACKGROUND', (0,i), (-1,i), PNTHR_GREY_100))
    tbl.setStyle(TableStyle(style_cmds))
    story.append(tbl)
    story.append(sp(6))


def build_section_6(story):
    """6. Communication Protocols"""
    story.append(head('6. Communication Protocols', 'SECTION 6'))
    story.append(section_spacer())
    story.append(p(
        'In the event of a significant business disruption, the following communication '
        'protocols will be activated:'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Internal Communications</b>', BOLD))
    story.append(bl(
        'Primary: Mobile phone contact between Managing Members'
    ))
    story.append(bl(
        'Secondary: Encrypted email via Google Workspace'
    ))
    story.append(bl(
        'Tertiary: Pre-designated secure messaging application'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Investor Communications</b>', BOLD))
    story.append(bl(
        'Investors will be notified via email within 24 hours of any material disruption '
        'affecting Fund operations'
    ))
    story.append(bl(
        'Updates will be provided at least daily until normal operations resume'
    ))
    story.append(bl(
        'The COO & CISO is responsible for drafting and distributing investor communications'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Regulatory Notifications</b>', BOLD))
    story.append(bl(
        'The CCO will assess whether any regulatory filings or notifications are required'
    ))
    story.append(bl(
        'Applicable regulators will be notified in accordance with their specific requirements'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Service Provider Coordination</b>', BOLD))
    story.append(bl(
        'Interactive Brokers, NAV Consulting, and legal counsel will be contacted '
        'as necessary to coordinate continuity of services'
    ))
    story.append(sp(6))


def build_section_7(story):
    """7. Data Backup and Recovery"""
    story.append(head('7. Data Backup and Recovery', 'SECTION 7'))
    story.append(section_spacer())

    story.append(Paragraph('<b>Data Backup Strategy</b>', BOLD))
    story.append(bl(
        '<b>Database:</b> MongoDB Atlas provides continuous replication across '
        'geographically distributed clusters with point-in-time recovery'
    ))
    story.append(bl(
        '<b>Application Code:</b> Version-controlled via Git with remote repositories; '
        'deployable from any authorized device'
    ))
    story.append(bl(
        '<b>Documents:</b> Critical compliance, investor, and legal documents stored '
        'in encrypted Google Drive with automatic versioning'
    ))
    story.append(bl(
        '<b>Trade Records:</b> Maintained in MongoDB Atlas and mirrored through '
        'Interactive Brokers account statements'
    ))
    story.append(sp(4))

    story.append(Paragraph('<b>Recovery Time Objectives</b>', BOLD))
    story.append(bl(
        '<b>Critical systems</b> (trading, communications): Target recovery within 4 hours'
    ))
    story.append(bl(
        '<b>High-priority systems</b> (administration, reporting): Target recovery within 24 hours'
    ))
    story.append(bl(
        '<b>Standard systems</b> (analytics, non-essential tools): Target recovery within 72 hours'
    ))
    story.append(sp(6))


def build_section_8(story):
    """8. Alternate Operations"""
    story.append(head('8. Alternate Operations', 'SECTION 8'))
    story.append(section_spacer())
    story.append(p(
        'In the event that the principal office at 15150 W Park Place, Suite 215, '
        'Goodyear, AZ 85395 becomes inaccessible, the Firm is prepared to operate '
        'remotely with full capability:'
    ))
    story.append(bl(
        '<b>Remote Trading:</b> Interactive Brokers Trader Workstation (TWS) can be '
        'accessed from any authorized device with internet connectivity'
    ))
    story.append(bl(
        '<b>Cloud Infrastructure:</b> All production systems (MongoDB Atlas, Render, '
        'Vercel) are cloud-hosted and accessible from any location'
    ))
    story.append(bl(
        '<b>Communications:</b> Google Workspace provides full email, document, and '
        'video conferencing capabilities from any device'
    ))
    story.append(bl(
        '<b>Signal Processing:</b> The PNTHR Scanner system is cloud-deployed and '
        'does not depend on physical office infrastructure'
    ))
    story.append(sp(4))
    story.append(warn_box([
        'The Firm maintains a fully remote-capable infrastructure by design. All critical '
        'systems are cloud-hosted, and both Managing Members maintain secure, dedicated '
        'home office environments with redundant internet connectivity.'
    ]))
    story.append(sp(6))


def build_section_9(story):
    """9. Testing and Review"""
    story.append(head('9. Testing and Review', 'SECTION 9'))
    story.append(section_spacer())
    story.append(p(
        'This BCDRP is subject to regular testing and review to ensure its effectiveness:'
    ))
    story.append(bl(
        '<b>Annual Review:</b> The COO & CISO will conduct a comprehensive review of '
        'this plan at least annually, updating contact information, systems inventory, '
        'and recovery procedures as necessary'
    ))
    story.append(bl(
        '<b>Tabletop Exercises:</b> Key personnel will participate in at least one '
        'tabletop exercise per year simulating various disruption scenarios'
    ))
    story.append(bl(
        '<b>Systems Testing:</b> Backup and recovery systems will be tested at least '
        'semi-annually to verify data integrity and recovery time objectives'
    ))
    story.append(bl(
        '<b>Post-Incident Review:</b> Following any actual business disruption, the '
        'plan will be reviewed and updated to incorporate lessons learned'
    ))
    story.append(sp(4))

    rows = [
        ['Activity', 'Frequency', 'Responsible Party'],
        ['Full Plan Review', 'Annually', 'COO & CISO'],
        ['Contact Info Update', 'Quarterly', 'COO & CISO'],
        ['Tabletop Exercise', 'Annually', 'Both Managing Members'],
        ['Backup Systems Test', 'Semi-Annually', 'CISO'],
        ['Recovery Drill', 'Annually', 'Both Managing Members'],
    ]

    styled_rows = []
    for i, row in enumerate(rows):
        cells = []
        for cell in row:
            style = WARN_STYLE if i == 0 else ParagraphStyle(
                f'test_{i}', parent=NORMAL, fontSize=8, leading=11)
            cells.append(Paragraph(cell, style))
        styled_rows.append(cells)

    tbl = Table(styled_rows, colWidths=[2.2*inch, 1.5*inch, BODY_W - 3.7*inch])
    style_cmds = [
        ('VALIGN',       (0,0), (-1,-1), 'MIDDLE'),
        ('LEFTPADDING',  (0,0), (-1,-1), 10),
        ('RIGHTPADDING', (0,0), (-1,-1), 10),
        ('TOPPADDING',   (0,0), (-1,-1), 5),
        ('BOTTOMPADDING',(0,0), (-1,-1), 5),
        ('LINEBEFORE',   (0,0), (0,-1),  3, PNTHR_YELLOW),
        ('GRID',         (0,0), (-1,-1), 0.3, PNTHR_GREY_400),
        ('BACKGROUND',   (0,0), (-1,0),  PNTHR_BLACK),
        ('TEXTCOLOR',    (0,0), (-1,0),  white),
        ('FONT',         (0,0), (-1,0),  FONT_BOLD, 8),
    ]
    for i in range(1, len(rows)):
        if (i - 1) % 2 == 0:
            style_cmds.append(('BACKGROUND', (0,i), (-1,i), PNTHR_GREY_100))
    tbl.setStyle(TableStyle(style_cmds))
    story.append(tbl)
    story.append(sp(6))


def build_section_10(story):
    """10. Investor Access During Disruptions"""
    story.append(head('10. Investor Access During Disruptions', 'SECTION 10'))
    story.append(section_spacer())
    story.append(p(
        'During a business disruption, investors may experience temporary limitations '
        'in their ability to process certain requests. The Firm will make every reasonable '
        'effort to maintain the following services:'
    ))
    story.append(bl(
        '<b>Account Information:</b> Investors will continue to have access to their '
        'most recent account statements and capital account information'
    ))
    story.append(bl(
        '<b>Withdrawal Requests:</b> The Firm will process withdrawal requests to the '
        'extent operationally feasible, subject to the terms of the Limited Partnership '
        'Agreement. During severe disruptions, processing times may be extended'
    ))
    story.append(bl(
        '<b>Communications:</b> Investors may contact the Managing Members directly '
        'via mobile phone or email for urgent matters'
    ))
    story.append(sp(8))

    story.append(warn_box([
        'In the event of a market-wide disruption affecting multiple service providers, '
        'the Firm will prioritize investor safety, regulatory compliance, and preservation '
        'of Fund assets above all other operational considerations.'
    ]))
    story.append(sp(12))


def build_authorization(story):
    """Authorization and signatures"""
    story.append(head('Authorization'))
    story.append(section_spacer())
    story.append(p(
        'This Business Continuity and Disaster Recovery Plan has been reviewed and '
        'approved by the undersigned Managing Members of STT Capital Advisors, LLC '
        'and PNTHR Funds, LLC, General Partner of Carnivore Quant Fund, LP.'
    ))
    story.append(sp(20))

    # Signature blocks
    story.append(p('_' * 50, SIG_STYLE))
    story.append(p('<b>Scott R. McBrien</b>', SIG_STYLE))
    story.append(p('Managing Member, Chief Investment Officer & Chief Compliance Officer', SIG_STYLE))
    story.append(p('STT Capital Advisors, LLC', SIG_STYLE))
    story.append(sp(4))
    story.append(p('Date: _________________________', SIG_STYLE))

    story.append(sp(24))

    story.append(p('_' * 50, SIG_STYLE))
    story.append(p('<b>Cindy Eagar</b>', SIG_STYLE))
    story.append(p('Managing Member, Chief Operating Officer & Chief Information Security Officer', SIG_STYLE))
    story.append(p('STT Capital Advisors, LLC', SIG_STYLE))
    story.append(sp(4))
    story.append(p('Date: _________________________', SIG_STYLE))


# ══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def _cover_page_callback(canvas, doc):
    canvas.saveState()
    draw_cover_header(canvas,
                      title='Business Continuity &\nDisaster Recovery Plan',
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
        title='Carnivore Quant Fund, LP - Business Continuity & Disaster Recovery Plan',
        author='PNTHR Funds, LLC',
        subject='Business Continuity and Disaster Recovery Plan',
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
    build_authorization(story)

    NumberedCanvas = make_numbered_canvas(
        doc_slug='BCDRP \xb7 STT CAPITAL ADVISORS, LLC \xb7 CONFIDENTIAL',
        doc_name='Business Continuity & Disaster Recovery Plan',
        confidentiality='Strictly Confidential',
        cover_pages=1,
    )
    doc.build(story, canvasmaker=NumberedCanvas)

    size_kb = os.path.getsize(OUT) // 1024
    print(f'\n[OK] PNTHR BCDRP generated: {OUT}')
    print(f'  Size: {size_kb} KB')


if __name__ == '__main__':
    main()
