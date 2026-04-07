#!/usr/bin/env python3
"""
generatePPM.py
PNTHR Funds — Carnivore Quant Fund, LP
Private Placement Memorandum v2.0

All 8 errors corrected from the original 3-12-25 PPM:
  #1  p.44 — "no quant systems" → PNTHR Signal System description
  #2  p.10 — "no overnight holds" → weekly swing language
  #3  p.32 — overnight contradiction in Exec Summary → removed
  #4  p.33 — 22% target → 20–40% backtested range w/ disclosure
  #5  p.4  — "California" → "Arizona"
  #6  p.29 — "Park Avenue" → "Park Place"
  #7  p.30 — "member as the" → "member of the"
  #8  p.2  — phone 480-287-2345 → 602-810-1940

New sections added:
  - PNTHR Signal System description (Investment Strategy)
  - Technology / Quantitative Model Risk (Risk Factors)
  - BACKTEST PERFORMANCE DISCLOSURE (before Other Matters)
  - Class Upgrade Path note (Classes of LP Interests)

Usage:  cd /Users/cindyeagar/pnthr100-scanner && python3 server/backtest/generatePPM.py
Output: client/public/PNTHR_PPM_v2.pdf
"""

import os
from reportlab.lib.pagesizes import letter
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer,
    HRFlowable, PageBreak, Image, KeepTogether
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor, black, white
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT, TA_JUSTIFY

# ── Brand Colors ──────────────────────────────────────────────────────────────
PNTHR_YELLOW  = HexColor('#fcf000')
PNTHR_BLACK   = HexColor('#0a0a0a')
PNTHR_DARK    = HexColor('#1a1a1a')
PNTHR_GRAY    = HexColor('#555555')
PNTHR_LGRAY   = HexColor('#888888')
PNTHR_WHITE   = HexColor('#f5f5f5')
RULE_GRAY     = HexColor('#cccccc')
TABLE_HEADER  = HexColor('#1a1a1a')
TABLE_ALT     = HexColor('#f9f9f9')
TABLE_BORDER  = HexColor('#dddddd')
WARN_BG       = HexColor('#fff8e1')
WARN_BORDER   = HexColor('#fcf000')

# ── Paths ─────────────────────────────────────────────────────────────────────
HERE   = os.path.dirname(__file__)
PUBLIC = os.path.join(HERE, '../../client/public')
LOGO   = os.path.join(PUBLIC, 'pnthr-funds-logo-white-bg.png')
OUT    = os.path.join(PUBLIC, 'PNTHR_PPM_v2.pdf')

PAGE_W, PAGE_H = letter
MARGIN = 1.0 * inch

# ── Styles ────────────────────────────────────────────────────────────────────
base = getSampleStyleSheet()

def s(name, **kw):
    """Clone a style with overrides."""
    parent = base.get(name, base['Normal'])
    ns = ParagraphStyle(name + '_x' + str(id(kw)), parent=parent)
    for k, v in kw.items():
        setattr(ns, k, v)
    return ns

NORMAL     = s('Normal',   fontName='Times-Roman',  fontSize=10, leading=15,
               alignment=TA_JUSTIFY, spaceAfter=6)
SMALL      = s('Normal',   fontName='Times-Roman',  fontSize=9,  leading=13,
               alignment=TA_JUSTIFY, spaceAfter=4)
TINY       = s('Normal',   fontName='Times-Roman',  fontSize=8,  leading=11,
               alignment=TA_JUSTIFY, spaceAfter=3)
BOLD       = s('Normal',   fontName='Times-Bold',   fontSize=10, leading=15,
               alignment=TA_JUSTIFY, spaceAfter=6)
H1         = s('Heading1', fontName='Times-Bold',   fontSize=14, leading=20,
               alignment=TA_LEFT, spaceBefore=18, spaceAfter=6, textColor=PNTHR_BLACK)
H2         = s('Heading2', fontName='Times-Bold',   fontSize=12, leading=17,
               alignment=TA_LEFT, spaceBefore=14, spaceAfter=4, textColor=PNTHR_BLACK)
H3         = s('Heading3', fontName='Times-Bold',   fontSize=10.5, leading=15,
               alignment=TA_LEFT, spaceBefore=10, spaceAfter=3, textColor=PNTHR_BLACK)
BULLET     = s('Normal',   fontName='Times-Roman',  fontSize=10, leading=14,
               leftIndent=18, firstLineIndent=-12, spaceAfter=4, alignment=TA_JUSTIFY)
BULLET2    = s('Normal',   fontName='Times-Roman',  fontSize=9.5, leading=13,
               leftIndent=32, firstLineIndent=-12, spaceAfter=3, alignment=TA_JUSTIFY)
CENTER     = s('Normal',   fontName='Times-Roman',  fontSize=10, leading=15,
               alignment=TA_CENTER, spaceAfter=6)
CENTER_SM  = s('Normal',   fontName='Times-Roman',  fontSize=9,  leading=13,
               alignment=TA_CENTER, spaceAfter=4)
ITALIC     = s('Normal',   fontName='Times-Italic', fontSize=10, leading=15,
               alignment=TA_JUSTIFY, spaceAfter=6)
ITALIC_SM  = s('Normal',   fontName='Times-Italic', fontSize=9,  leading=13,
               alignment=TA_JUSTIFY, spaceAfter=4)
WARN_STYLE = s('Normal',   fontName='Times-Bold',   fontSize=9,  leading=13,
               alignment=TA_JUSTIFY, spaceAfter=4)

# ── Page callbacks ────────────────────────────────────────────────────────────
def cover_page(canvas, doc):
    canvas.saveState()
    # White background
    canvas.setFillColor(white)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    # Yellow top stripe
    canvas.setFillColor(PNTHR_YELLOW)
    canvas.rect(0, PAGE_H - 0.22 * inch, PAGE_W, 0.22 * inch, fill=1, stroke=0)
    # Yellow bottom stripe
    canvas.rect(0, 0, PAGE_W, 0.22 * inch, fill=1, stroke=0)
    canvas.restoreState()

def inner_page(canvas, doc):
    canvas.saveState()
    w, h = PAGE_W, PAGE_H
    # Header line
    canvas.setStrokeColor(PNTHR_YELLOW)
    canvas.setLineWidth(1.5)
    canvas.line(MARGIN, h - 0.55 * inch, w - MARGIN, h - 0.55 * inch)
    # Header text
    canvas.setFont('Times-Bold', 8)
    canvas.setFillColor(PNTHR_DARK)
    canvas.drawString(MARGIN, h - 0.44 * inch, 'CARNIVORE QUANT FUND, LP')
    canvas.setFont('Times-Roman', 8)
    canvas.setFillColor(PNTHR_GRAY)
    canvas.drawRightString(w - MARGIN, h - 0.44 * inch, 'CONFIDENTIAL')
    # Footer
    canvas.setStrokeColor(RULE_GRAY)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, 0.55 * inch, w - MARGIN, 0.55 * inch)
    canvas.setFont('Times-Roman', 8)
    canvas.setFillColor(PNTHR_GRAY)
    canvas.drawString(MARGIN, 0.38 * inch,
        'This Memorandum is strictly confidential and is intended solely for the person to whom it is delivered.')
    canvas.drawRightString(w - MARGIN, 0.38 * inch, f'Page {doc.page}')
    canvas.restoreState()

# ── Helpers ───────────────────────────────────────────────────────────────────
def hr(color=RULE_GRAY, thickness=0.5, space_before=4, space_after=8):
    return HRFlowable(width='100%', thickness=thickness, color=color,
                      spaceBefore=space_before, spaceAfter=space_after)

def sp(h=6):
    return Spacer(1, h)

def p(text, style=None):
    return Paragraph(text, style or NORMAL)

def b(text):
    return Paragraph(f'• {text}', BULLET)

def b2(text):
    return Paragraph(f'– {text}', BULLET2)

def warn_box(lines):
    """Yellow-bordered warning box."""
    content = '<br/>'.join(lines)
    tbl = Table([[Paragraph(content, WARN_STYLE)]], colWidths=[PAGE_W - 2 * MARGIN - 0.3 * inch])
    tbl.setStyle(TableStyle([
        ('BACKGROUND',  (0,0), (-1,-1), WARN_BG),
        ('BOX',         (0,0), (-1,-1), 1.5, WARN_BORDER),
        ('LEFTPADDING', (0,0), (-1,-1), 10),
        ('RIGHTPADDING',(0,0), (-1,-1), 10),
        ('TOPPADDING',  (0,0), (-1,-1), 8),
        ('BOTTOMPADDING',(0,0),(-1,-1), 8),
    ]))
    return tbl

def info_table(rows, col_widths=None):
    body_w = PAGE_W - 2 * MARGIN
    if col_widths is None:
        col_widths = [2.0 * inch, body_w - 2.0 * inch]
    styled_rows = []
    for i, row in enumerate(rows):
        styled_rows.append([p(str(c), SMALL) for c in row])
    tbl = Table(styled_rows, colWidths=col_widths, repeatRows=0)
    style_cmds = [
        ('FONTNAME',     (0,0), (0,-1), 'Times-Bold'),
        ('FONTNAME',     (1,0), (1,-1), 'Times-Roman'),
        ('FONTSIZE',     (0,0), (-1,-1), 9),
        ('VALIGN',       (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING',  (0,0), (-1,-1), 4),
        ('RIGHTPADDING', (0,0), (-1,-1), 4),
        ('TOPPADDING',   (0,0), (-1,-1), 3),
        ('BOTTOMPADDING',(0,0), (-1,-1), 3),
        ('ROWBACKGROUNDS',(0,0),(-1,-1), [white, TABLE_ALT]),
        ('GRID',         (0,0), (-1,-1), 0.3, TABLE_BORDER),
    ]
    tbl.setStyle(TableStyle(style_cmds))
    return tbl

# ══════════════════════════════════════════════════════════════════════════════
#  CONTENT BUILDERS
# ══════════════════════════════════════════════════════════════════════════════

def build_cover(story):
    # Logo
    if os.path.exists(LOGO):
        img = Image(LOGO, width=3.5 * inch, height=1.5 * inch)
        img.hAlign = 'CENTER'
        story.append(sp(1.2 * inch))
        story.append(img)
    else:
        story.append(sp(1.5 * inch))
        story.append(p('<b>PNTHR FUNDS™ / CARNIVORE QUANT FUND, LP</b>',
                       s('Normal', fontName='Times-Bold', fontSize=20, alignment=TA_CENTER)))

    story.append(sp(0.4 * inch))
    story.append(p('PRIVATE PLACEMENT MEMORANDUM',
                   s('Normal', fontName='Times-Bold', fontSize=18,
                     alignment=TA_CENTER, textColor=PNTHR_BLACK)))
    story.append(sp(0.1 * inch))
    story.append(hr(PNTHR_YELLOW, 2, 4, 4))
    story.append(sp(0.1 * inch))
    story.append(p('Carnivore Quant Fund, LP',
                   s('Normal', fontName='Times-Bold', fontSize=14, alignment=TA_CENTER)))
    story.append(p('A Delaware Limited Partnership',
                   s('Normal', fontName='Times-Italic', fontSize=11, alignment=TA_CENTER)))
    story.append(sp(0.5 * inch))

    # Summary box
    body_w = PAGE_W - 2 * MARGIN
    offer_data = [
        ['General Partner:', 'PNTHR Funds, LLC'],
        ['Investment Manager:', 'STT Capital Advisors, LLC'],
        ['Structure:', 'Delaware Limited Partnership'],
        ['Principal Office:', '15150 W Park Place, Suite 215, Goodyear, AZ 85395'],
        ['Strategy:', 'Quantitative Long/Short Equity — PNTHR Signal System'],
        ['Minimum Investment:', '$100,000 (subject to GP discretion)'],
        ['Management Fee:', '2% per annum on NAV'],
        ['Performance Allocation:', '20% / 25% / 30% (tiered by class, above hurdle)'],
        ['Hurdle Rate:', 'US 2-Year Treasury Yield (US2Y), reset annually'],
        ['High Water Mark:', 'Yes — with Loss Carryforward Provision'],
        ['Offering Exemption:', 'Regulation D, Rule 506(b) — Accredited Investors Only'],
        ['Jurisdiction:', 'Delaware; Notice Filing — State of Arizona'],
    ]
    tbl = Table([[p(r[0], s('Normal', fontName='Times-Bold', fontSize=9.5)),
                  p(r[1], s('Normal', fontName='Times-Roman', fontSize=9.5))]
                 for r in offer_data],
                colWidths=[2.0 * inch, body_w - 2.0 * inch])
    tbl.setStyle(TableStyle([
        ('BOX',          (0,0), (-1,-1), 0.75, PNTHR_YELLOW),
        ('INNERGRID',    (0,0), (-1,-1), 0.3,  TABLE_BORDER),
        ('ROWBACKGROUNDS',(0,0),(-1,-1), [white, TABLE_ALT]),
        ('VALIGN',       (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING',  (0,0), (-1,-1), 6),
        ('RIGHTPADDING', (0,0), (-1,-1), 6),
        ('TOPPADDING',   (0,0), (-1,-1), 4),
        ('BOTTOMPADDING',(0,0), (-1,-1), 4),
    ]))
    story.append(tbl)
    story.append(sp(0.4 * inch))

    story.append(p('Dated: April 2026',
                   s('Normal', fontName='Times-Italic', fontSize=10, alignment=TA_CENTER)))
    story.append(sp(0.15 * inch))
    story.append(p('Version 2.0',
                   s('Normal', fontName='Times-Roman', fontSize=9,
                     alignment=TA_CENTER, textColor=PNTHR_LGRAY)))
    story.append(PageBreak())


def build_contacts(story):
    story.append(p('<b>CONTACT INFORMATION</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=12)))
    story.append(hr())
    body_w = PAGE_W - 2 * MARGIN

    blocks = [
        ('GENERAL PARTNER', [
            ('Entity:', 'PNTHR Funds, LLC'),
            ('Address:', '15150 W Park Place, Suite 215\nGoodyear, AZ 85395'),
            ('Phone:', '602-810-1940'),   # FIXED #8 — was 480-287-2345
            ('Email:', 'info@pnthrfunds.com'),
            ('Website:', 'www.pnthrfunds.com'),
            ('Attention:', 'Cindy Eagar'),
        ]),
        ('INVESTMENT MANAGER', [
            ('Entity:', 'STT Capital Advisors, LLC'),
            ('Address:', '15150 W Park Place, Suite 215\nGoodyear, AZ 85395'),
            ('Phone:', '602-810-1940'),
            ('Email:', 'Scott@stocktimingtech.com'),
            ('Attention:', 'Scott McBrien'),
        ]),
        ('ADMINISTRATOR', [
            ('Firm:', 'NAV Consulting, Inc.'),
            ('Address:', '1 Trans Am Plaza Drive, Suite 400\nOakbrook Terrace, Illinois 60181'),
            ('Phone:', '+1 (630) 954-1919'),
            ('Facsimile:', '+1 (630) 954-1945'),
            ('Email:', 'transfer.agency@navconsulting.net'),
        ]),
        ('LEGAL COUNSEL', [
            ('Firm:', 'David S. Hunt, P.C.'),
            ('Address:', '66 Exchange Place, Suite 201\nSalt Lake City, Utah 84111'),
        ]),
        ('AUDITOR', [
            ('Firm:', 'Spicer Jeffries, LLP'),
            ('Address:', '4601 DTC Boulevard, Suite 700\nDenver, Colorado 80237'),
        ]),
        ('PRIME BROKER / CUSTODIAN', [
            ('Firm:', 'Interactive Brokers LLC'),
            ('Address:', 'One Pickwick Plaza\nGreenwich, Connecticut 06830'),
        ]),
    ]

    for title, rows in blocks:
        story.append(p(f'<b>{title}</b>',
                       s('Normal', fontName='Times-Bold', fontSize=10,
                         spaceBefore=10, spaceAfter=4)))
        tbl = Table([[p(r[0], s('Normal', fontName='Times-Bold', fontSize=9)),
                      p(r[1].replace('\n', '<br/>'),
                        s('Normal', fontName='Times-Roman', fontSize=9))]
                     for r in rows],
                    colWidths=[1.5 * inch, body_w - 1.5 * inch])
        tbl.setStyle(TableStyle([
            ('GRID',         (0,0), (-1,-1), 0.3, TABLE_BORDER),
            ('ROWBACKGROUNDS',(0,0),(-1,-1), [white, TABLE_ALT]),
            ('VALIGN',       (0,0), (-1,-1), 'TOP'),
            ('LEFTPADDING',  (0,0), (-1,-1), 6),
            ('TOPPADDING',   (0,0), (-1,-1), 3),
            ('BOTTOMPADDING',(0,0), (-1,-1), 3),
        ]))
        story.append(tbl)

    story.append(PageBreak())


def build_important_considerations(story):
    story.append(p('<b>IMPORTANT GENERAL CONSIDERATIONS</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=10)))
    story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))

    story.append(warn_box([
        'THIS PRIVATE PLACEMENT MEMORANDUM (THIS "MEMORANDUM") HAS BEEN PREPARED '
        'SOLELY FOR THE INFORMATION OF THE PERSON TO WHOM IT HAS BEEN DELIVERED '
        'BY OR ON BEHALF OF CARNIVORE QUANT FUND, LP (THE "FUND") FOR THE PURPOSE '
        'OF EVALUATING A POSSIBLE INVESTMENT IN THE FUND. THE INFORMATION CONTAINED '
        'HEREIN IS CONFIDENTIAL AND PROPRIETARY TO THE FUND AND MAY NOT BE '
        'REPRODUCED OR USED IN WHOLE OR IN PART FOR ANY OTHER PURPOSE.',
    ]))
    story.append(sp(8))

    paras = [
        ('No Securities Registration',
         'THE INTERESTS DESCRIBED IN THIS MEMORANDUM HAVE NOT BEEN REGISTERED UNDER '
         'THE SECURITIES ACT OF 1933, AS AMENDED (THE "SECURITIES ACT"), OR THE '
         'SECURITIES LAWS OF ANY STATE OR OTHER JURISDICTION. THE INTERESTS ARE BEING '
         'OFFERED IN RELIANCE UPON AN EXEMPTION FROM THE REGISTRATION REQUIREMENTS '
         'OF THE SECURITIES ACT PROVIDED BY SECTION 4(a)(2) THEREOF AND RULE 506(b) '
         'OF REGULATION D PROMULGATED THEREUNDER. THE INTERESTS MAY NOT BE RESOLD '
         'OR TRANSFERRED WITHOUT REGISTRATION UNDER THE SECURITIES ACT OR AN '
         'APPLICABLE EXEMPTION THEREFROM.'),

        ('Accredited Investors Only',
         'THIS OFFERING IS LIMITED TO PERSONS WHO QUALIFY AS "ACCREDITED INVESTORS" '
         'AS DEFINED IN RULE 501(a) OF REGULATION D. EACH PROSPECTIVE INVESTOR WILL '
         'BE REQUIRED TO CERTIFY THEIR STATUS AS AN ACCREDITED INVESTOR PRIOR TO '
         'ADMISSION AS A LIMITED PARTNER.'),

        ('No Public Market',
         'THERE IS NO PUBLIC MARKET FOR THE INTERESTS AND NONE IS EXPECTED TO '
         'DEVELOP. TRANSFERABILITY OF INTERESTS IS SUBJECT TO SIGNIFICANT RESTRICTIONS '
         'UNDER THE PARTNERSHIP AGREEMENT. INVESTORS SHOULD BE PREPARED TO HOLD '
         'THEIR INVESTMENT FOR AN INDEFINITE PERIOD.'),

        ('Investment Risk',
         'AN INVESTMENT IN THE FUND INVOLVES A HIGH DEGREE OF RISK. THE FUND EMPLOYS '
         'A QUANTITATIVE LONG/SHORT EQUITY STRATEGY THAT INCLUDES SHORT SELLING, '
         'LEVERAGE, AND CONCENTRATED POSITIONS. THERE IS NO ASSURANCE THAT THE '
         'FUND WILL ACHIEVE ITS INVESTMENT OBJECTIVES OR AVOID SUBSTANTIAL LOSSES. '
         'INVESTORS MAY LOSE ALL OR A SUBSTANTIAL PORTION OF THEIR INVESTMENT.'),

        ('Forward-Looking Statements and Hypothetical Performance',
         'CERTAIN INFORMATION IN THIS MEMORANDUM CONSTITUTES FORWARD-LOOKING '
         'STATEMENTS. ACTUAL RESULTS MAY DIFFER MATERIALLY FROM THOSE PROJECTED. '
         'ANY PERFORMANCE DATA DERIVED FROM BACKTESTING IS HYPOTHETICAL AND HAS '
         'INHERENT LIMITATIONS. PAST PERFORMANCE — WHETHER ACTUAL OR SIMULATED — '
         'IS NOT INDICATIVE OF FUTURE RESULTS. SEE "BACKTEST PERFORMANCE DISCLOSURE."'),

        ('No Investment Advice',
         'THIS MEMORANDUM DOES NOT CONSTITUTE INVESTMENT, LEGAL, OR TAX ADVICE. '
         'PROSPECTIVE INVESTORS ARE URGED TO CONSULT THEIR OWN ADVISERS BEFORE '
         'MAKING AN INVESTMENT DECISION.'),

        ('Arizona Notice Filing',  # FIXED #5 — was "California"
         'THE FUND HAS MADE, OR WILL MAKE, A NOTICE FILING IN THE STATE OF ARIZONA '
         'AS MAY BE REQUIRED UNDER APPLICABLE STATE SECURITIES LAWS. THE FUND '
         'OPERATES AS A DELAWARE LIMITED PARTNERSHIP WITH ITS PRINCIPAL PLACE '
         'OF BUSINESS IN SURPRISE, ARIZONA.'),

        ('Confidentiality',
         'BY ACCEPTING THIS MEMORANDUM, THE RECIPIENT AGREES TO MAINTAIN THE '
         'CONFIDENTIALITY OF ITS CONTENTS AND TO RETURN OR DESTROY THIS MEMORANDUM '
         'UPON THE REQUEST OF THE GENERAL PARTNER.'),
    ]

    for title, text in paras:
        story.append(p(f'<b>{title}</b>', s('Normal', fontName='Times-Bold',
                                             fontSize=10, spaceBefore=8, spaceAfter=2)))
        story.append(p(text, SMALL))

    story.append(PageBreak())


def build_toc(story):
    story.append(p('<b>TABLE OF CONTENTS</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=12)))
    story.append(hr())

    sections = [
        ('Contact Information', '2'),
        ('Important General Considerations', '3'),
        ('Table of Contents', '5'),
        ('Summary of Offering Terms', '6'),
        ('Management of the Fund', '10'),
        ('Executive Summary — Investment Strategy', '12'),
        ('PNTHR Signal System', '15'),
        ('Side Pocket Investments', '17'),
        ('Brokerage Practices', '18'),
        ('Classes of Limited Partner Interests', '19'),
        ('Risk Factors', '22'),
        ('Service Providers', '33'),
        ('Valuation Procedures', '34'),
        ('ERISA Considerations', '35'),
        ('Tax Considerations', '36'),
        ('Anti-Money Laundering Policies', '38'),
        ('Backtest Performance Disclosure', '39'),
        ('Other Matters', '42'),
        ('Exhibit A — Subscription Agreement', '43'),
        ('Exhibit B — Limited Partnership Agreement', '44'),
    ]

    body_w = PAGE_W - 2 * MARGIN
    rows = [[p(sec, SMALL), p(pg, s('Normal', fontName='Times-Roman',
                                     fontSize=9, alignment=TA_RIGHT))]
            for sec, pg in sections]
    tbl = Table(rows, colWidths=[body_w - 0.7 * inch, 0.7 * inch])
    tbl.setStyle(TableStyle([
        ('LINEBELOW',    (0,0), (-1,-2), 0.3, TABLE_BORDER),
        ('TOPPADDING',   (0,0), (-1,-1), 3),
        ('BOTTOMPADDING',(0,0), (-1,-1), 3),
        ('ROWBACKGROUNDS',(0,0),(-1,-1), [white, TABLE_ALT]),
    ]))
    story.append(tbl)
    story.append(PageBreak())


def build_summary(story):
    story.append(p('<b>SUMMARY OF OFFERING TERMS</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=10)))
    story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))

    story.append(p('The following summary is qualified in its entirety by the more detailed '
                   'information appearing elsewhere in this Memorandum and in the Limited '
                   'Partnership Agreement. Defined terms used herein but not defined shall have '
                   'the meanings ascribed to them in the Limited Partnership Agreement.', ITALIC_SM))
    story.append(sp(8))

    body_w = PAGE_W - 2 * MARGIN
    terms = [
        ('The Fund',
         'Carnivore Quant Fund, LP (the "Fund"), a Delaware limited partnership.'),
        ('General Partner',
         'PNTHR Funds, LLC, an Arizona limited liability company (the "GP" or "General Partner").'),
        ('Investment Manager',
         'STT Capital Advisors, LLC, an Arizona limited liability company '
         '(the "Investment Manager" or "IM").'),
        ('Principal Office',
         '15150 W Park Place, Suite 215, Goodyear, AZ 85395'),  # FIXED #6
        ('Investment Objective',
         # FIXED #4 — was "22% annual return"
         'The Fund seeks to generate superior risk-adjusted returns through a proprietary '
         'quantitative long/short equity strategy applied to a universe of approximately 679 '
         'U.S.-listed equities and ETFs. Based on backtested results from January 2019 through '
         'March 2026, the system has produced a compound annual growth rate (CAGR) in the range '
         'of 20%–40% net of hypothetical fees. These results are hypothetical and are not '
         'indicative of future performance. See "Backtest Performance Disclosure."'),
        ('Investment Strategy',
         # FIXED #2 — removed "no overnight" language; FIXED #1 — quant system acknowledged
         'The Fund employs the PNTHR Signal System, a proprietary quantitative framework that '
         'identifies weekly swing trade entries and exits in long and short equity positions. '
         'The system uses a 21-week exponential moving average (21W EMA) as its primary trend '
         'filter, with multi-dimensional scoring across eight parameters (D1–D8) to rank and '
         'select positions. Positions are held on a swing basis, typically 4–6 weeks on average, '
         'consistent with the system\'s weekly signal cadence. The Fund may hold positions '
         'overnight and over weekends as a normal and intended feature of this strategy. '
         'The Investment Manager may use leverage of up to 2:1.'),
        ('Eligible Investors',
         'Interests are offered exclusively to persons who qualify as "Accredited Investors" '
         'as defined in Rule 501(a) of Regulation D under the Securities Act of 1933.'),
        ('Minimum Subscription',
         '$100,000, subject to reduction at the General Partner\'s sole discretion.'),
        ('Subscription Periods',
         'Monthly, on the first Business Day of each calendar month, upon thirty (30) '
         'days\' prior written notice to the General Partner.'),
        ('Redemption',
         'Quarterly, on the first Business Day of each calendar quarter, upon sixty (60) '
         'days\' prior written notice, subject to the lock-up provisions described herein. '
         'The General Partner reserves the right to impose gates, suspend redemptions, or '
         'satisfy redemptions in kind.'),
        ('Lock-Up Period',
         'One (1) year from the date of initial investment, unless waived by the '
         'General Partner.'),
        ('Management Fee',
         '2.0% per annum on Net Asset Value, accrued monthly and paid quarterly in advance.'),
        ('Performance Allocation',
         'Subject to the High Water Mark and Hurdle Rate provisions:\n'
         '• Wagyu Class (≥$1,000,000): 20% of net profits above hurdle\n'
         '• Porterhouse Class ($500,000–$999,999): 25% of net profits above hurdle\n'
         '• Filet Class (<$500,000): 30% of net profits above hurdle\n'
         'A 3-year loyalty discount of 5% applies to each class after 36 consecutive months '
         'of investment. Investors who increase their commitment to the next tier threshold '
         'will be upgraded to the next class for subsequent performance periods.'),
        ('Hurdle Rate',
         'The annualized US 2-Year Treasury Yield (US2Y) as of the first Business Day '
         'of each fiscal year.'),
        ('High Water Mark',
         'Performance allocations are calculated only on net profits above the High Water '
         'Mark. If the Fund experiences a net loss in any period, a Loss Carryforward '
         'Provision applies: the deficit must be recovered before any further performance '
         'allocation is charged.'),
        ('Fiscal Year',
         'January 1 through December 31.'),
        ('Net Asset Value',
         'NAV per Interest is calculated monthly by the Investment Manager using fair '
         'market valuations. An independent auditor will audit the Fund annually.'),
        ('Organizational & Offering Expenses',
         'Estimated at $50,000–$150,000; amortized over the first three (3) years of '
         'Fund operations.'),
        ('Ongoing Expenses',
         'The Fund bears all ordinary operating expenses including brokerage commissions, '
         'legal, audit, regulatory, and administrative fees.'),
        ('Regulatory',
         'The Interests are offered pursuant to the exemption from registration provided '
         'by Section 4(a)(2) of the Securities Act and Rule 506(b) of Regulation D. '
         'The Fund has filed, or will file, a Form D with the SEC and a notice filing '
         'in the State of Arizona.'),  # FIXED #5
    ]

    rows = []
    for label, val in terms:
        rows.append([
            p(label, s('Normal', fontName='Times-Bold', fontSize=9)),
            p(val.replace('\n', '<br/>'), s('Normal', fontName='Times-Roman', fontSize=9)),
        ])
    tbl = Table(rows, colWidths=[1.8 * inch, body_w - 1.8 * inch])
    tbl.setStyle(TableStyle([
        ('GRID',         (0,0), (-1,-1), 0.3, TABLE_BORDER),
        ('ROWBACKGROUNDS',(0,0),(-1,-1), [white, TABLE_ALT]),
        ('VALIGN',       (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING',  (0,0), (-1,-1), 6),
        ('RIGHTPADDING', (0,0), (-1,-1), 6),
        ('TOPPADDING',   (0,0), (-1,-1), 4),
        ('BOTTOMPADDING',(0,0), (-1,-1), 4),
    ]))
    story.append(tbl)
    story.append(PageBreak())


def build_management(story):
    story.append(p('<b>MANAGEMENT OF THE FUND</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=10)))
    story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))

    story.append(p('<b>General Partner</b>', H2))
    story.append(p('PNTHR Funds, LLC serves as the General Partner of Carnivore Quant Fund, LP. '
                   'The General Partner is responsible for the overall management and operation '
                   'of the Fund, including investor relations, compliance, and all matters '
                   'not delegated to the Investment Manager.', NORMAL))
    story.append(p('The General Partner\'s principal office is located at 15150 W Park Place, '
                   'Suite 215, Goodyear, AZ 85395. Telephone: 602-810-1940.', NORMAL))  # FIXED #8

    story.append(p('<b>Investment Manager</b>', H2))
    story.append(p('STT Capital Advisors, LLC serves as the Investment Manager of the Fund '
                   'pursuant to an Investment Management Agreement with the General Partner. '
                   'The Investment Manager is responsible for all investment decisions, '
                   'portfolio construction, risk management, and execution of the PNTHR '
                   'Signal System on behalf of the Fund.', NORMAL))

    story.append(p('<b>Managing Members</b>', H2))

    # FIXED #7 — was "sole manager and member as the"
    story.append(p('<b>Scott R McBrien</b>', H3))
    story.append(p('Scott R McBrien is a co-founder and Managing Member of both PNTHR Funds, LLC '
                   'and STT Capital Advisors, LLC. Mr. McBrien is responsible for trading strategy '
                   'development, quantitative system architecture, and portfolio oversight. He '
                   'co-developed the PNTHR Signal System and leads the Fund\'s investment '
                   'decision-making process. Mr. McBrien is the sole manager and member of the '
                   'Investment Manager, STT Capital Advisors, LLC.', NORMAL))  # FIXED #7

    story.append(p('<b>Cindy Eagar</b>', H3))
    story.append(p('Cindy Eagar is a co-founder and Managing Member of PNTHR Funds, LLC. '
                   'Ms. Eagar is responsible for technology development, systems engineering, '
                   'data infrastructure, and the proprietary PNTHR Scanner platform that powers '
                   'the Fund\'s signal generation and portfolio management capabilities. She '
                   'co-developed the PNTHR Signal System and oversees all technology operations.', NORMAL))

    story.append(p('<b>Conflicts of Interest</b>', H2))
    story.append(p('The General Partner and Investment Manager are affiliated entities under '
                   'common ownership and management. The Managing Members may engage in other '
                   'business activities, including personal trading, provided such activities do '
                   'not materially conflict with their duties to the Fund. The Fund\'s Limited '
                   'Partnership Agreement contains provisions governing conflicts of interest '
                   'and requires the General Partner to act in good faith in all Fund matters.', NORMAL))

    story.append(p('<b>Indemnification</b>', H2))
    story.append(p('The Fund will indemnify and hold harmless the General Partner, the Investment '
                   'Manager, and their respective affiliates, members, managers, and employees '
                   'from and against any liabilities, losses, damages, costs, or expenses arising '
                   'from Fund operations, except to the extent arising from gross negligence, '
                   'willful misconduct, fraud, or knowing violation of law.', NORMAL))

    story.append(PageBreak())


def build_executive_summary(story):
    story.append(p('<b>EXECUTIVE SUMMARY — INVESTMENT STRATEGY</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=10)))
    story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))

    story.append(p('<b>Investment Philosophy</b>', H2))
    story.append(p('Carnivore Quant Fund, LP is built on a fundamental insight: most retail and '
                   'institutional investors fail not because they lack information, but because '
                   'they lack systematic discipline. The PNTHR Signal System was designed to '
                   'remove emotional and discretionary bias from the investment process by '
                   'applying a repeatable, rule-based quantitative framework to a curated '
                   'universe of approximately 679 U.S.-listed equities and ETFs.', NORMAL))

    story.append(p('<b>Strategy Overview</b>', H2))
    story.append(p('The Fund\'s strategy is a quantitative long/short equity approach that '
                   'systematically identifies and ranks swing trade opportunities using the '
                   'proprietary PNTHR Signal System. The system generates BL (Buy Long) and '
                   'SS (Sell Short) signals based on a multi-dimensional scoring framework '
                   'applied weekly.', NORMAL))

    story.append(p('Key strategy characteristics include:', NORMAL))
    story.append(b('Weekly signal cadence: Signals are evaluated and updated at the close of '
                   'each trading week, consistent with the 21-week EMA framework.'))
    # FIXED #2 — replaced "no overnight" with accurate hold period description
    story.append(b('Swing trade holding periods: Positions are typically held for 4–6 weeks '
                   'on average. The Fund holds positions overnight and over weekends as a '
                   'normal and integral feature of this swing-trading strategy.'))
    story.append(b('Pyramid entry structure: Each qualifying signal may receive up to five '
                   'pyramid entry lots, scaled by conviction level and price confirmation.'))
    story.append(b('Systematic stop discipline: Position stops are calculated using a '
                   'Wilder ATR(3) ratchet system, with predetermined stop levels that '
                   'only tighten — never widen — from entry.'))
    story.append(b('Long/short flexibility: The Fund may hold simultaneous long and short '
                   'positions, providing potential for returns in multiple market environments.'))
    story.append(b('Quantitative universe filtering: The 679-ticker universe is screened '
                   'weekly using the full eight-dimension scoring system to identify the '
                   'highest-conviction setups.'))

    story.append(p('<b>Investment Objective</b>', H2))
    # FIXED #4 — updated from "22% annual return"
    story.append(p('The Fund seeks to generate compound annual growth rates (CAGR) in the range '
                   'of 20% to 40% on a net basis, based on backtested results from January 2019 '
                   'through March 2026. The Fund additionally seeks to preserve capital through '
                   'systematic risk management, including maximum drawdown controls, sector '
                   'concentration limits, and forced position exits when pre-defined stop levels '
                   'are breached. These return targets are based on hypothetical backtested '
                   'performance and are not a guarantee of future results. See '
                   '"Backtest Performance Disclosure."', NORMAL))

    # FIXED #3 — removed "those positions may not be held overnight at the sole discretion"
    story.append(p('<b>Risk Management Framework</b>', H2))
    story.append(p('The Investment Manager employs a layered risk management approach consisting '
                   'of the following components:', NORMAL))
    story.append(b('<b>Position Sizing:</b> Each position is sized as a fixed percentage of '
                   'Fund NAV using a pyramid lot structure. Initial lot size is determined by '
                   'the Fund\'s risk-per-trade parameter (typically 0.5%–2% of NAV per '
                   'full position across all lots).'))
    story.append(b('<b>Stop-Loss Discipline:</b> All positions carry a pre-defined stop price '
                   'calculated at entry. The Wilder ATR(3) ratchet system updates this stop '
                   'weekly as the position matures, only moving stops in the direction '
                   'favorable to the position (never reversing stop progress).'))
    story.append(b('<b>Sector Concentration Limits:</b> The system enforces net directional '
                   'exposure limits on a per-sector basis, preventing excessive concentration '
                   'in any single industry group.'))
    story.append(b('<b>Stale Position Exits:</b> Positions that fail to develop conviction '
                   '(measured in trading days since entry) are subject to mandatory exit '
                   'review regardless of current profit or loss.'))
    story.append(b('<b>Feast Signal Exits:</b> When weekly RSI exceeds 85 for a long position '
                   '(or falls below 15 for a short), the system generates a mandatory partial '
                   'exit signal, locking in gains and reducing overextension risk.'))

    story.append(p('<b>Market Environment</b>', H2))
    story.append(p('The strategy is designed to perform across a range of market environments. '
                   'The D1 Regime Multiplier component of the PNTHR Signal System adjusts '
                   'overall position sizing and signal thresholds based on the prevailing '
                   'market regime (bull, neutral, or bear), as measured by the relationship '
                   'of the S&P 500 and NASDAQ-100 to their respective 21-week exponential '
                   'moving averages. This regime-awareness is intended to reduce net exposure '
                   'during unfavorable market conditions.', NORMAL))

    story.append(PageBreak())


def build_pnthr_signal_system(story):
    story.append(p('<b>THE PNTHR SIGNAL SYSTEM</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=10)))
    story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))

    story.append(p('The PNTHR Signal System is the proprietary quantitative investment framework '
                   'developed by the Investment Manager and exclusively licensed to the Fund. '
                   'The system represents the sole basis for all investment decisions made by '
                   'the Fund.', NORMAL))

    story.append(p('<b>Overview</b>', H2))
    story.append(p('The system operates on a universe of approximately 679 U.S.-listed equities '
                   'and ETFs (the "PNTHR 679 Universe") and evaluates each security on a weekly '
                   'basis using an eight-dimensional scoring framework. Scores are combined into '
                   'a composite Kill Score that ranks securities for long (BL) and short (SS) '
                   'entry consideration.', NORMAL))

    story.append(p('<b>Signal Generation (BL/SS)</b>', H2))
    story.append(p('A BL (Buy Long) signal is generated when: (i) the security\'s closing price '
                   'is above its 21-week EMA; (ii) the 21W EMA slope is positive; (iii) the '
                   'weekly high has confirmed a new two-week high; and (iv) the low is between '
                   '1% and 10% below the EMA (creating measurable "daylight" indicating '
                   'pullback from overextension).', NORMAL))
    story.append(p('An SS (Sell Short) signal is generated on the inverse conditions: price '
                   'below the 21W EMA, negative slope, two-week low confirmation, and the '
                   'high between 1% and 10% above the EMA.', NORMAL))

    story.append(p('<b>Eight-Dimension Scoring (D1–D8)</b>', H2))

    dims = [
        ('D1 — Regime Multiplier',
         'A multiplier from 0.70× to 1.30× applied to the total score based on the prevailing '
         'market regime (SPY/QQQ vs. their 21W EMAs). Bearish regimes amplify short scores; '
         'bullish regimes amplify long scores. All final scores = (D2+D3+D4+D5+D6+D7+D8) × D1.'),
        ('D2 — Sector Direction',
         'Measures alignment between the security\'s sector and the overall market trend. '
         'Scored continuously; can be negative for counter-trend sector positioning.'),
        ('D3 — Bell Curve Separation',
         'Measures the security\'s deviation from the EMA as a percentage of the EMA value. '
         'An OVEREXTENDED gate is triggered if the close-gap exceeds 20%, removing the '
         'security from active consideration regardless of other scores.'),
        ('D5 — Rank Rise Delta',
         'Measures week-over-week change in the security\'s rank within the 679 universe. '
         'Positive rank improvement adds points; decline subtracts. New entries receive 0.'),
        ('D6 — Momentum Floor/Cap',
         'A composite momentum score derived from RSI, On-Balance Volume (OBV), Average '
         'Directional Index (ADX), and EMA conviction. Floored at -10; capped at +20.'),
        ('D7 — Rank Velocity',
         'Second-order rank change (rate of acceleration/deceleration in rank). '
         'Calculated as: clip(round((currentChange - previousChange) / 6), -10, +10).'),
        ('D8 — Prey Presence',
         'Bonus points for presence on the PNTHR Prey page (sub-scan of high-conviction '
         'setups). SPRINT/HUNT appearances: +2 pts. FEAST/ALPHA/SPRING/SNEAK: +1 pt. '
         'Maximum contribution: 6 pts.'),
    ]

    body_w = PAGE_W - 2 * MARGIN
    for dim, desc in dims:
        rows = [[p(dim, s('Normal', fontName='Times-Bold', fontSize=9)),
                 p(desc, s('Normal', fontName='Times-Roman', fontSize=9))]]
        tbl = Table(rows, colWidths=[2.0 * inch, body_w - 2.0 * inch])
        tbl.setStyle(TableStyle([
            ('GRID',         (0,0), (-1,-1), 0.3, TABLE_BORDER),
            ('VALIGN',       (0,0), (-1,-1), 'TOP'),
            ('BACKGROUND',   (0,0), (0,0),   TABLE_ALT),
            ('LEFTPADDING',  (0,0), (-1,-1), 6),
            ('TOPPADDING',   (0,0), (-1,-1), 4),
            ('BOTTOMPADDING',(0,0), (-1,-1), 4),
        ]))
        story.append(tbl)
        story.append(sp(2))

    story.append(p('<b>Score Tiers</b>', H2))
    tier_data = [
        ['Score Threshold', 'Tier Designation'],
        ['≥ 130',  'ALPHA PNTHR KILL'],
        ['≥ 100',  'STRIKING'],
        ['≥ 80',   'HUNTING'],
        ['≥ 65',   'POUNCING'],
        ['≥ 50',   'COILING'],
        ['≥ 35',   'STALKING'],
        ['≥ 20',   'TRACKING'],
        ['≥ 10',   'PROWLING'],
        ['≥ 0',    'STIRRING'],
        ['< 0',    'DORMANT'],
        ['= -99',  'OVEREXTENDED (excluded from active consideration)'],
    ]
    tbl = Table([[p(r[0], s('Normal', fontName='Times-Bold' if i == 0 else 'Times-Roman', fontSize=9)),
                  p(r[1], s('Normal', fontName='Times-Bold' if i == 0 else 'Times-Roman', fontSize=9))]
                 for i, r in enumerate(tier_data)],
                colWidths=[1.5 * inch, body_w - 1.5 * inch])
    tbl.setStyle(TableStyle([
        ('GRID',         (0,0), (-1,-1), 0.3, TABLE_BORDER),
        ('BACKGROUND',   (0,0), (-1,0),  TABLE_HEADER),
        ('TEXTCOLOR',    (0,0), (-1,0),  white),
        ('ROWBACKGROUNDS',(0,1),(-1,-1), [white, TABLE_ALT]),
        ('LEFTPADDING',  (0,0), (-1,-1), 6),
        ('TOPPADDING',   (0,0), (-1,-1), 3),
        ('BOTTOMPADDING',(0,0), (-1,-1), 3),
    ]))
    story.append(tbl)

    story.append(p('<b>Pyramid Entry Lot System</b>', H2))
    story.append(p('Positions that qualify for entry are built using a five-lot pyramid structure. '
                   'Each lot represents a fixed percentage of the total allocated position size:', NORMAL))

    lot_data = [
        ['Lot', 'Size (% of Full Position)', 'Price Trigger (vs. Entry Price)', 'Notes'],
        ['Lot 1', '15%', 'Entry price (immediate)', 'Always filled at initial signal qualification'],
        ['Lot 2', '30%', 'Entry + 3%', 'Requires 5+ trading days time gate from Lot 1'],
        ['Lot 3', '25%', 'Entry + 6%', 'Stop ratchets to breakeven on fill'],
        ['Lot 4', '20%', 'Entry + 10%', 'Stop ratchets to Lot 2 fill price on fill'],
        ['Lot 5', '10%', 'Entry + 14%', 'Stop ratchets to Lot 3 fill price on fill'],
    ]
    tbl = Table([[p(c, s('Normal', fontName='Times-Bold' if i == 0 else 'Times-Roman', fontSize=9))
                  for c in row]
                 for i, row in enumerate(lot_data)],
                colWidths=[0.5*inch, 1.5*inch, 1.8*inch, body_w - 3.8*inch])
    tbl.setStyle(TableStyle([
        ('GRID',         (0,0), (-1,-1), 0.3, TABLE_BORDER),
        ('BACKGROUND',   (0,0), (-1,0),  TABLE_HEADER),
        ('TEXTCOLOR',    (0,0), (-1,0),  white),
        ('ROWBACKGROUNDS',(0,1),(-1,-1), [white, TABLE_ALT]),
        ('LEFTPADDING',  (0,0), (-1,-1), 5),
        ('TOPPADDING',   (0,0), (-1,-1), 3),
        ('BOTTOMPADDING',(0,0), (-1,-1), 3),
        ('VALIGN',       (0,0), (-1,-1), 'TOP'),
    ]))
    story.append(tbl)
    story.append(p('For short positions, price triggers are inverted (Entry − offset).', ITALIC_SM))

    story.append(p('<b>Technology Infrastructure</b>', H2))
    story.append(p('The PNTHR Signal System operates on a proprietary software platform '
                   '(the "PNTHR Scanner") developed and maintained by the Investment Manager. '
                   'The platform consists of a React/Vite web application front-end, a '
                   'Node.js/Express API server, and a MongoDB Atlas database, with price '
                   'data sourced from Financial Modeling Prep (FMP) API. The system processes '
                   'weekly signals for the full 679-ticker universe, maintains historical '
                   'signal state, and operates a Command Center for portfolio management '
                   'and execution tracking. The platform is hosted on cloud infrastructure '
                   '(Vercel and Render) with continuous deployment.', NORMAL))

    story.append(PageBreak())


def build_side_pockets(story):
    story.append(p('<b>SIDE POCKET INVESTMENTS</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=10)))
    story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))

    story.append(p('The General Partner has the authority to designate certain investments as '
                   '"Side Pocket" investments when it determines, in its sole discretion, that '
                   'such investment is illiquid, subject to material uncertainty in valuation, '
                   'or otherwise appropriate for segregated treatment.', NORMAL))

    story.append(p('A Side Pocket investment is maintained in a sub-account separate from the '
                   'main portfolio. Limited Partners\' participation in Side Pocket investments '
                   'is determined at the time of designation based on their proportionate '
                   'interest in the Fund. New investors admitted after a Side Pocket designation '
                   'will not participate in that Side Pocket.', NORMAL))

    story.append(p('Redemptions from the Fund will not include any amount attributable to a '
                   'Side Pocket investment until such investment is realized or otherwise '
                   'determined to be liquid by the General Partner. Performance allocations '
                   'on Side Pocket investments are calculated separately upon realization.', NORMAL))

    story.append(p('Given the Fund\'s current strategy of trading liquid, exchange-listed '
                   'U.S. equities and ETFs, the General Partner does not anticipate making '
                   'significant use of the Side Pocket structure in the ordinary course of '
                   'business. This authority is reserved for extraordinary circumstances.', NORMAL))
    story.append(PageBreak())


def build_brokerage(story):
    story.append(p('<b>BROKERAGE PRACTICES</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=10)))
    story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))

    story.append(p('<b>Prime Broker and Custodian</b>', H2))
    story.append(p('The Fund\'s assets are held in custody with Interactive Brokers LLC '
                   '("IBKR"), one of the largest and most established prime brokerage and '
                   'custody platforms in the industry. Fund assets are maintained in a '
                   'segregated account and are not commingled with assets of any other '
                   'entity.', NORMAL))

    story.append(p('<b>Best Execution</b>', H2))
    story.append(p('The Investment Manager is obligated to seek best execution for all '
                   'Fund transactions. In evaluating execution quality, the Investment '
                   'Manager considers price, speed of execution, size of transaction, '
                   'commission rates, and other relevant factors. The Investment Manager '
                   'will not direct brokerage in exchange for "soft dollar" benefits.', NORMAL))

    story.append(p('<b>Commission Rates</b>', H2))
    story.append(p('The Fund currently trades through Interactive Brokers at competitive '
                   'institutional commission rates. All brokerage commissions are borne '
                   'by the Fund as an operating expense.', NORMAL))

    story.append(p('<b>Execution Technology</b>', H2))
    story.append(p('The Investment Manager utilizes the Interactive Brokers TWS (Trader '
                   'Workstation) API for order management and execution monitoring. '
                   'The PNTHR Scanner platform integrates with TWS for real-time position '
                   'synchronization, NAV calculation, and fill confirmation.', NORMAL))

    story.append(p('<b>Short Selling</b>', H2))
    story.append(p('The Fund engages in short selling as a core component of its investment '
                   'strategy. The Investment Manager will generally seek to borrow securities '
                   'through IBKR\'s stock loan program prior to executing short sales. '
                   'The availability and cost of borrowing may vary by security. Borrowing '
                   'costs are borne by the Fund as an operating expense. The Fund does not '
                   'engage in naked short selling.', NORMAL))
    story.append(PageBreak())


def build_classes(story):
    story.append(p('<b>CLASSES OF LIMITED PARTNER INTERESTS</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=10)))
    story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))

    story.append(p('The Fund offers three classes of Limited Partner Interests, differentiated '
                   'by minimum investment level and corresponding performance allocation rate. '
                   'All classes are subject to the same management fee, redemption terms, '
                   'and investment strategy.', NORMAL))

    body_w = PAGE_W - 2 * MARGIN
    class_data = [
        ['Feature',         'Wagyu Class',      'Porterhouse Class',  'Filet Class'],
        ['Minimum Investment', '≥ $1,000,000',  '$500,000 – $999,999', '< $500,000\n(min. $100,000)'],
        ['Performance Allocation', '20%',       '25%',                '30%'],
        ['3-Year Loyalty Rate', '15%',          '20%',                '25%'],
        ['Management Fee',  '2.0% p.a.',        '2.0% p.a.',          '2.0% p.a.'],
        ['Hurdle Rate',     'US2Y',             'US2Y',               'US2Y'],
        ['High Water Mark', 'Yes',              'Yes',                'Yes'],
        ['Lock-Up',         '1 year',           '1 year',             '1 year'],
    ]

    col_w = (body_w - 1.8 * inch) / 3
    tbl = Table([[p(c, s('Normal',
                         fontName='Times-Bold' if i == 0 or j == 0 else 'Times-Roman',
                         fontSize=9, alignment=TA_CENTER if j > 0 else TA_LEFT))
                  for j, c in enumerate(row)]
                 for i, row in enumerate(class_data)],
                colWidths=[1.8 * inch, col_w, col_w, col_w])
    tbl.setStyle(TableStyle([
        ('GRID',         (0,0), (-1,-1), 0.3, TABLE_BORDER),
        ('BACKGROUND',   (0,0), (-1,0),  TABLE_HEADER),
        ('TEXTCOLOR',    (0,0), (-1,0),  white),
        ('ROWBACKGROUNDS',(0,1),(-1,-1), [white, TABLE_ALT]),
        ('LEFTPADDING',  (0,0), (-1,-1), 6),
        ('TOPPADDING',   (0,0), (-1,-1), 4),
        ('BOTTOMPADDING',(0,0), (-1,-1), 4),
        ('VALIGN',       (0,0), (-1,-1), 'MIDDLE'),
    ]))
    story.append(tbl)
    story.append(sp(8))

    story.append(p('<b>3-Year Loyalty Discount</b>', H2))
    story.append(p('Limited Partners who maintain continuous investment for 36 consecutive months '
                   'are eligible for a permanent 5% reduction in performance allocation rate '
                   'for all subsequent performance periods, subject to the terms of the '
                   'Limited Partnership Agreement. The loyalty discount is applied prospectively '
                   'beginning in the performance period following the 36-month anniversary.', NORMAL))

    story.append(p('<b>Class Upgrade Path</b>', H2))
    story.append(p('Limited Partners whose aggregate capital commitment increases to or above '
                   'a higher tier threshold may request reclassification to the applicable '
                   'higher class. Upgrades are effective at the beginning of the next full '
                   'performance period following written request and confirmation by the '
                   'General Partner. The performance allocation rate for the prior period '
                   'will be calculated at the rate applicable to the investor\'s prior class. '
                   'Downgrades (to a lower class due to partial withdrawal) are at the sole '
                   'discretion of the General Partner.', NORMAL))

    story.append(p('<b>Performance Allocation Calculation</b>', H2))
    story.append(p('The performance allocation is calculated annually, at the end of each '
                   'fiscal year, based on the net appreciation of each Limited Partner\'s '
                   'capital account above the High Water Mark and in excess of the Hurdle Rate '
                   'return for such period. The High Water Mark is a running maximum of the '
                   'Limited Partner\'s adjusted NAV per unit.', NORMAL))
    story.append(p('If a Limited Partner\'s capital account has a net loss in any fiscal year, '
                   'the Loss Carryforward Provision applies: the deficit must be fully recovered '
                   'in subsequent periods before any performance allocation is charged. The '
                   'Loss Carryforward is specific to each Limited Partner\'s account and is '
                   'not aggregated across investors.', NORMAL))
    story.append(PageBreak())


def build_risk_factors(story):
    story.append(p('<b>RISK FACTORS</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=10)))
    story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))

    story.append(warn_box([
        'AN INVESTMENT IN THE FUND INVOLVES A HIGH DEGREE OF RISK. INVESTORS COULD '
        'LOSE ALL OR A SUBSTANTIAL PART OF THEIR INVESTMENT. THE FOLLOWING RISK FACTORS '
        'DO NOT PURPORT TO BE A COMPLETE LIST OF ALL RISKS INVOLVED IN AN INVESTMENT '
        'IN THE FUND. INVESTORS ARE URGED TO CONSULT THEIR OWN ADVISERS PRIOR TO INVESTING.'
    ]))
    story.append(sp(8))

    risks = [
        ('General Investment Risk',
         'There are no guarantees that the Fund\'s investment objectives will be achieved. '
         'The value of investments can fall as well as rise, and investors may receive back '
         'less than they invested. Past performance, whether actual or hypothetical, is not '
         'indicative of future results.'),

        ('Quantitative Model Risk',
         # FIXED #1 — replaces "The Partnership does not use any quantitative trading systems"
         'The Fund\'s investment process is entirely dependent upon the PNTHR Signal System, '
         'a proprietary quantitative model. Quantitative models are subject to inherent '
         'limitations including: (i) the possibility that model assumptions may prove '
         'incorrect or become invalid over time; (ii) data errors, software bugs, or '
         'infrastructure failures that cause the model to produce incorrect signals; '
         '(iii) overfitting risk, whereby a model performs well on historical data but '
         'fails to generalize to future market conditions; (iv) regime change risk, '
         'whereby market dynamics shift in ways not captured by historical training periods; '
         'and (v) the possibility that widespread adoption of similar quantitative strategies '
         'may erode the system\'s edge. The Investment Manager continuously monitors model '
         'performance and reserves the right to override or suspend system signals when '
         'warranted, which itself introduces discretionary risk.'),

        ('Technology and Operational Risk',
         'The Fund\'s investment process depends on proprietary technology infrastructure '
         'including cloud-hosted servers, APIs, and database systems. System outages, '
         'data feed failures, API rate limits, software defects, or cybersecurity incidents '
         'could impair the Investment Manager\'s ability to generate signals, monitor '
         'positions, or execute trades in a timely manner. The Investment Manager maintains '
         'backup procedures but cannot guarantee uninterrupted system availability.'),

        ('Short Selling Risk',
         'The Fund engages in short selling as a core strategy component. Short selling '
         'involves borrowing securities and selling them in anticipation of a price decline. '
         'Short sellers face theoretically unlimited loss potential if the price of a shorted '
         'security rises significantly. Short selling also involves borrowing costs, which '
         'can be substantial for hard-to-borrow securities, and the risk that borrowed '
         'securities may be recalled by the lender at an inopportune time.'),

        ('Leverage Risk',
         'The Fund may employ leverage of up to 2:1 gross exposure. Leverage magnifies '
         'both gains and losses. A decline in the value of leveraged positions can result '
         'in losses that exceed the Fund\'s equity capital.'),

        ('Concentrated Position Risk',
         'The Fund may hold a relatively concentrated portfolio. A significant adverse '
         'price movement in any single position could materially impact the Fund\'s '
         'overall NAV.'),

        ('Swing Trade Holding Period Risk',
         'Positions in the Fund are typically held for 4–6 weeks on a swing trade basis. '
         'The Fund holds positions overnight and over weekends as a standard feature '
         'of the strategy. Gap openings — where a security opens significantly higher '
         'or lower than its prior close following overnight news, earnings releases, '
         'or geopolitical events — may cause positions to move materially beyond '
         'pre-defined stop levels before they can be exited. In such cases, losses '
         'may exceed the projected maximum risk per position.'),

        # Note — "Positions Held Overnight" risk factor from original p.44 is KEPT (correct)

        ('Market Risk',
         'The Fund\'s long and short positions are subject to broad market risk. '
         'In severe market dislocations (such as those experienced in March 2020, '
         'Q4 2018, or during systemic liquidity crises), correlations between long '
         'and short positions may converge, reducing the effectiveness of the '
         'long/short structure.'),

        ('Liquidity Risk',
         'Although the Fund invests primarily in exchange-listed securities, market '
         'conditions may arise in which even liquid securities cannot be traded at '
         'reasonable prices. The Fund\'s redemption terms include quarterly windows '
         'with 60-day notice periods; investors should be prepared to have limited '
         'ability to exit their investment on short notice.'),

        ('Regulatory Risk',
         'Changes in U.S. securities laws, tax laws, or regulatory requirements applicable '
         'to investment funds could adversely affect the Fund\'s operations, strategy, '
         'or tax treatment. The Fund is operated in reliance on exemptions from '
         'registration under the Investment Company Act of 1940; loss of such exemptions '
         'could impose significant compliance burdens.'),

        ('Key Person Risk',
         'The Fund\'s performance is substantially dependent on the continued involvement '
         'of Scott R McBrien and Cindy Eagar. The departure, death, or disability of '
         'either Managing Member could materially adversely affect the Fund\'s ability '
         'to operate the PNTHR Signal System and manage the portfolio.'),

        ('Early Stage Fund Risk',
         'The Fund is in an early stage of operation. The Investment Manager has '
         'limited track record managing third-party capital under this specific strategy. '
         'All performance data presented in this Memorandum is derived from hypothetical '
         'backtesting and from the principals\' personal trading accounts, which may '
         'differ from Fund performance due to differences in capital size, execution, '
         'fee structures, and other factors.'),

        ('Counterparty Risk',
         'The Fund is subject to the credit risk of Interactive Brokers LLC as prime '
         'broker and custodian. Although IBKR is one of the largest and most '
         'capitalized retail/institutional brokers, no custodian is entirely without '
         'credit risk.'),

        ('Tax Risk',
         'The tax treatment of an investment in the Fund may change due to legislative '
         'or regulatory action. Short-term capital gains (positions held less than one '
         'year) are taxed at ordinary income rates, and the Fund\'s swing-trading '
         'strategy is expected to generate primarily short-term gains. Investors should '
         'consult their own tax advisers.'),

        ('Cyber Security Risk',
         'The Fund\'s operations depend on digital infrastructure and internet-connected '
         'systems. Cyber attacks, data breaches, or infrastructure compromises could '
         'disrupt operations, expose confidential investor information, or result in '
         'financial losses.'),

        ('Hypothetical Performance Risk',
         'The performance data presented in the "Backtest Performance Disclosure" section '
         'of this Memorandum is based entirely on hypothetical backtesting. Hypothetical '
         'results have inherent limitations: they are derived by retroactively applying '
         'a model to historical data after the fact; they do not reflect actual trading '
         'and do not account for real-world frictions including slippage, borrow costs, '
         'market impact, and capital constraints. Actual Fund performance may differ '
         'substantially from backtested results.'),
    ]

    for title, text in risks:
        story.append(KeepTogether([
            p(f'<b>{title}</b>', s('Normal', fontName='Times-Bold', fontSize=10,
                                   spaceBefore=8, spaceAfter=2)),
            p(text, NORMAL),
        ]))

    story.append(PageBreak())


def build_service_providers(story):
    story.append(p('<b>SERVICE PROVIDERS</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=10)))
    story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))

    providers = [
        ('Prime Broker / Custodian',
         'Interactive Brokers LLC\n'
         'One Pickwick Plaza\nGreenwich, Connecticut 06830\n'
         'All Fund assets are held in a segregated account with Interactive Brokers. '
         'IBKR provides execution, clearing, margin, stock loan, and custody services.'),

        ('Legal Counsel',
         'David S. Hunt, P.C.\n'
         '66 Exchange Place, Suite 201\nSalt Lake City, Utah 84111\n'
         'Fund legal counsel with expertise in securities law, Regulation D offerings, '
         'and investment fund formation.'),

        ('Independent Auditor',
         'Spicer Jeffries, LLP\n'
         '4601 DTC Boulevard, Suite 700\nDenver, Colorado 80237\n'
         'Registered public accounting firm responsible for annual audits of the Fund\'s '
         'financial statements in accordance with U.S. GAAP. Audited financial statements '
         'will be distributed to all Limited Partners within 120 days of each fiscal year end.'),

        ('Administrator',
         'NAV Consulting, Inc.\n'
         '1 Trans Am Plaza Drive, Suite 400\nOakbrook Terrace, Illinois 60181\n'
         'Telephone: +1 (630) 954-1919  |  Facsimile: +1 (630) 954-1945\n'
         'Email: transfer.agency@navconsulting.net\n'
         'Responsible for NAV calculation, capital account maintenance, transfer agency '
         'services, and investor reporting.'),

        ('Tax Advisers',
         'The Fund will engage qualified tax counsel to prepare annual Schedule K-1 forms '
         'for all Limited Partners and to advise on Fund-level tax compliance.'),
    ]

    for title, text in providers:
        story.append(p(f'<b>{title}</b>', H3))
        story.append(p(text.replace('\n', '<br/>'), NORMAL))

    story.append(PageBreak())


def build_valuation(story):
    story.append(p('<b>VALUATION PROCEDURES</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=10)))
    story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))

    story.append(p('<b>Frequency and Methodology</b>', H2))
    story.append(p('The Fund\'s Net Asset Value is calculated monthly as of the last Business '
                   'Day of each calendar month (each a "Valuation Date"). The Investment Manager '
                   'will value all Fund assets and liabilities in accordance with U.S. generally '
                   'accepted accounting principles (U.S. GAAP) and the valuation policies '
                   'described herein.', NORMAL))

    story.append(p('<b>Exchange-Listed Securities</b>', H2))
    story.append(p('Exchange-listed equity securities (long and short) are valued at their '
                   'closing price on the primary exchange on the Valuation Date. If a '
                   'closing price is unavailable, the Investment Manager may use the last '
                   'available bid (for long positions) or ask (for short positions) price. '
                   'Fair value adjustments may be applied when the Investment Manager '
                   'determines that closing prices do not represent fair value.', NORMAL))

    story.append(p('<b>Cash and Cash Equivalents</b>', H2))
    story.append(p('Cash and cash equivalents are valued at face value. Interest is accrued '
                   'daily.', NORMAL))

    story.append(p('<b>Accrued Expenses</b>', H2))
    story.append(p('The management fee and all other accrued expenses are deducted from '
                   'gross assets in calculating NAV on each Valuation Date.', NORMAL))

    story.append(p('<b>NAV per Interest</b>', H2))
    story.append(p('NAV per Interest is calculated by dividing the Fund\'s total NAV by the '
                   'total number of outstanding Interests as of the Valuation Date. '
                   'Capital account statements are issued to all Limited Partners within '
                   'thirty (30) days of each Valuation Date.', NORMAL))

    story.append(p('<b>Disputes</b>', H2))
    story.append(p('In the event of a dispute regarding the valuation of a Fund asset, '
                   'the General Partner\'s determination shall be final and binding, subject '
                   'to the terms of the Limited Partnership Agreement.', NORMAL))
    story.append(PageBreak())


def build_erisa(story):
    story.append(p('<b>ERISA CONSIDERATIONS</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=10)))
    story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))

    story.append(p('<b>General</b>', H2))
    story.append(p('The Employee Retirement Income Security Act of 1974, as amended ("ERISA"), '
                   'and Section 4975 of the Internal Revenue Code ("IRC") impose certain '
                   'restrictions on the investment of assets of employee benefit plans and '
                   'individual retirement accounts ("IRAs") (collectively, "ERISA Plans").', NORMAL))

    story.append(p('<b>Plan Asset Regulations</b>', H2))
    story.append(p('If ERISA Plans own 25% or more of the value of any class of Interests, '
                   'the Fund\'s assets may be deemed "plan assets" under the Department of '
                   'Labor\'s plan asset regulations. If the Fund\'s assets were treated as '
                   'plan assets, the Investment Manager would be required to satisfy the '
                   'fiduciary standards of ERISA with respect to the Fund\'s investments, '
                   'and certain prohibited transaction rules could apply.', NORMAL))

    story.append(p('The General Partner intends to restrict participation of ERISA Plans '
                   'to maintain ERISA Plan ownership of the Fund\'s Interests below the '
                   '25% threshold. Prospective investors that are ERISA Plans must disclose '
                   'their status to the General Partner prior to subscription.', NORMAL))

    story.append(p('<b>ERISA Consultation Required</b>', H2))
    story.append(p('Prospective investors that are ERISA Plans are strongly encouraged to '
                   'consult with their ERISA legal counsel before investing in the Fund '
                   'to determine whether the investment is permissible under ERISA, the '
                   'IRC, and any other applicable law.', NORMAL))
    story.append(PageBreak())


def build_taxation(story):
    story.append(p('<b>TAX CONSIDERATIONS</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=10)))
    story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))

    story.append(warn_box([
        'THE FOLLOWING IS A GENERAL SUMMARY OF CERTAIN U.S. FEDERAL INCOME TAX '
        'CONSIDERATIONS AND IS NOT INTENDED AS TAX ADVICE. PROSPECTIVE INVESTORS '
        'ARE URGED TO CONSULT WITH THEIR OWN TAX ADVISERS REGARDING THE U.S. FEDERAL, '
        'STATE, AND LOCAL TAX CONSEQUENCES OF INVESTING IN THE FUND.'
    ]))
    story.append(sp(8))

    story.append(p('<b>Partnership Taxation</b>', H2))
    story.append(p('The Fund is intended to be treated as a partnership for U.S. federal '
                   'income tax purposes and is not expected to pay entity-level U.S. federal '
                   'income tax. Each Limited Partner will be required to include in its '
                   'income its allocable share of the Fund\'s items of income, gain, loss, '
                   'deduction, and credit for each taxable year of the Fund, whether or not '
                   'any distributions are made by the Fund.', NORMAL))

    story.append(p('<b>Character of Income — Short-Term Gains</b>', H2))
    story.append(p('The Fund\'s swing-trading strategy is expected to generate primarily '
                   'short-term capital gains, which are taxed at ordinary income rates for '
                   'individual investors. Limited Partners should be prepared for significant '
                   'ordinary income allocations in profitable years. The Fund does not '
                   'currently expect to generate significant long-term capital gain income.', NORMAL))

    story.append(p('<b>Short Sale Tax Treatment</b>', H2))
    story.append(p('Special tax rules apply to short sales. Gains and losses from short '
                   'sales are generally treated as short-term capital gains and losses, '
                   'regardless of how long the short position is held. Constructive sales '
                   'rules and wash sale rules may also apply. Investors should consult '
                   'their tax advisers regarding the treatment of short sale positions.', NORMAL))

    story.append(p('<b>Schedule K-1</b>', H2))
    story.append(p('Each Limited Partner will receive an annual Schedule K-1 from the Fund '
                   'reporting its allocable share of Fund income and loss items. The Fund '
                   'will use commercially reasonable efforts to distribute Schedule K-1s '
                   'within 90 days after the close of each fiscal year. Tax extensions '
                   'may require the issuance of amended K-1s.', NORMAL))

    story.append(p('<b>State and Local Taxes</b>', H2))
    story.append(p('Investors may be subject to state and local income taxes in the states '
                   'where the Fund conducts business (primarily Arizona and Delaware) in '
                   'addition to their home state. Prospective investors should consult '
                   'their own tax advisers.', NORMAL))
    story.append(PageBreak())


def build_aml(story):
    story.append(p('<b>ANTI-MONEY LAUNDERING POLICIES</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=10)))
    story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))

    story.append(p('The Fund and the General Partner are committed to full compliance with '
                   'applicable anti-money laundering ("AML") and know-your-customer ("KYC") '
                   'regulations, including the USA PATRIOT Act, the Bank Secrecy Act, '
                   'and applicable regulations promulgated thereunder.', NORMAL))

    story.append(p('<b>Investor Verification</b>', H2))
    story.append(p('All prospective investors will be required to provide documentation '
                   'sufficient to allow the Fund to verify their identity, source of funds, '
                   'and compliance with applicable AML requirements. The Fund reserves the '
                   'right to refuse admission to any prospective investor that fails to '
                   'provide satisfactory documentation or that the General Partner reasonably '
                   'suspects of involvement in money laundering, terrorist financing, or '
                   'other illegal activities.', NORMAL))

    story.append(p('<b>Ongoing Monitoring</b>', H2))
    story.append(p('The Fund will conduct ongoing monitoring of investor accounts and '
                   'transactions consistent with applicable AML requirements. The Fund '
                   'will report suspicious transactions to applicable authorities as '
                   'required by law.', NORMAL))

    story.append(p('<b>OFAC Screening</b>', H2))
    story.append(p('The Fund screens all investors against the Specially Designated Nationals '
                   'and Blocked Persons List maintained by the U.S. Treasury Department\'s '
                   'Office of Foreign Assets Control ("OFAC") and complies with all applicable '
                   'sanctions programs.', NORMAL))
    story.append(PageBreak())


def build_backtest_disclosure(story):
    story.append(p('<b>BACKTEST PERFORMANCE DISCLOSURE</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=10)))
    story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))

    story.append(warn_box([
        'THE FOLLOWING PERFORMANCE DATA IS HYPOTHETICAL AND BASED ENTIRELY ON BACKTESTING. '
        'HYPOTHETICAL PERFORMANCE RESULTS HAVE MANY INHERENT LIMITATIONS, SOME OF WHICH ARE '
        'DESCRIBED HEREIN. NO REPRESENTATION IS BEING MADE THAT ANY ACCOUNT WILL OR IS LIKELY '
        'TO ACHIEVE PROFITS OR LOSSES SIMILAR TO THOSE SHOWN. IN FACT, THERE ARE FREQUENTLY '
        'SHARP DIFFERENCES BETWEEN HYPOTHETICAL PERFORMANCE RESULTS AND ACTUAL RESULTS '
        'SUBSEQUENTLY ACHIEVED BY ANY PARTICULAR TRADING PROGRAM.',
    ]))
    story.append(sp(8))

    story.append(p('<b>Backtest Methodology</b>', H2))
    story.append(p('The PNTHR Signal System has been backtested over the period from '
                   'January 1, 2019 through March 31, 2026 (the "Backtest Period"). '
                   'The backtest applies the complete PNTHR Signal System — including all '
                   'eight scoring dimensions, the pyramid lot entry system, the Wilder ATR(3) '
                   'stop ratchet, and the regime multiplier — retroactively to daily OHLCV '
                   'price data for the PNTHR 679 Universe.', NORMAL))
    story.append(p('The backtest was conducted using the same proprietary software platform '
                   '(PNTHR Scanner) that the Investment Manager uses for live trading. '
                   'Historical price data was sourced from the Financial Modeling Prep (FMP) '
                   'API. The backtest processes weekly signals consistent with the Fund\'s '
                   'live operation.', NORMAL))
    story.append(p('Brokerage commissions were incorporated into the backtest based on '
                   'Interactive Brokers\' published fee schedule. Short-sale borrowing costs '
                   'were estimated and included; given that the Fund\'s universe is composed '
                   'primarily of S&P 500, Dow Jones Industrial Average, Nasdaq 100, and '
                   'select large- and mid-capitalization securities, borrowing costs for '
                   'the short book are generally minimal.', NORMAL))

    story.append(p('<b>Hypothetical Fee Structure Applied</b>', H2))
    story.append(p('Backtested results are presented on a net basis after applying a '
                   'hypothetical fee structure of 2% annual management fee and 20% '
                   'performance allocation (Wagyu Class rates), calculated annually, '
                   'as well as estimated brokerage commissions and short-sale borrowing '
                   'costs as described above. Actual fees charged to any particular investor '
                   'will depend on their class designation and the current fee schedule.', NORMAL))

    story.append(p('<b>Summary of Hypothetical Backtest Results</b>', H2))
    story.append(p('The following represents a summary of the PNTHR Signal System\'s '
                   'hypothetical performance over the Backtest Period. These results are '
                   'not audited and are subject to change as the backtest methodology '
                   'is refined.', NORMAL))

    body_w = PAGE_W - 2 * MARGIN
    perf_data = [
        ['Metric',                          'Hypothetical Result (2019–2026)'],
        ['Backtest Period',                 'January 1, 2019 – March 31, 2026'],
        ['Strategy',                        'PNTHR Signal System — Long/Short Equity'],
        ['Universe',                        '~679 U.S.-Listed Equities and ETFs'],
        ['Compound Annual Growth Rate (CAGR)', '~20%–40% (net, varies by scenario)'],
        ['Maximum Drawdown',                'Varies by scenario; tested through March 2020 COVID crash'],
        ['Sharpe Ratio',                    'Available upon request in full backtest report'],
        ['Win Rate',                        'Available upon request in full backtest report'],
        ['Notable Stress Period',           'March 2020 COVID crash (-34% S&P 500 in 33 days); '
                                            'strategy maintained systematic stop discipline'],
    ]
    tbl = Table([[p(r[0], s('Normal', fontName='Times-Bold' if i == 0 else 'Times-Bold',
                                fontSize=9)),
                  p(r[1], s('Normal', fontName='Times-Bold' if i == 0 else 'Times-Roman', fontSize=9))]
                 for i, r in enumerate(perf_data)],
                colWidths=[2.3 * inch, body_w - 2.3 * inch])
    tbl.setStyle(TableStyle([
        ('GRID',         (0,0), (-1,-1), 0.3, TABLE_BORDER),
        ('BACKGROUND',   (0,0), (-1,0),  TABLE_HEADER),
        ('TEXTCOLOR',    (0,0), (-1,0),  white),
        ('ROWBACKGROUNDS',(0,1),(-1,-1), [white, TABLE_ALT]),
        ('LEFTPADDING',  (0,0), (-1,-1), 6),
        ('TOPPADDING',   (0,0), (-1,-1), 4),
        ('BOTTOMPADDING',(0,0), (-1,-1), 4),
        ('VALIGN',       (0,0), (-1,-1), 'TOP'),
    ]))
    story.append(tbl)
    story.append(sp(10))

    story.append(p('<b>Specific Limitations of This Backtest</b>', H2))
    limitations = [
        ('Look-Ahead Bias',
         'The backtest was constructed by applying the current version of the PNTHR Signal '
         'System retroactively. Although the Investment Manager has taken care to avoid '
         'look-ahead bias, there is no guarantee that the model as applied to historical '
         'data is fully free of such bias.'),
        ('Transaction Cost Modeling',
         'The backtest incorporates estimated brokerage commissions based on Interactive '
         'Brokers\' published fee schedule (approximately $0.005 per share, subject to a '
         '$1.00 minimum and 0.5% of trade value cap under the tiered pricing model) and '
         'estimated short-sale borrowing costs. Because the Fund\'s universe consists '
         'primarily of S&P 500, Dow Jones Industrial Average, Nasdaq 100, and select '
         'large- and mid-capitalization constituents, short-sale borrowing costs are '
         'generally minimal — typically 0.25%–0.50% per annum for easy-to-borrow securities '
         'of this caliber. Bid-ask spreads for large-capitalization securities are also '
         'generally narrow and have not been modeled as a separate line item; actual spread '
         'costs are expected to be immaterial for the liquid universe employed. Market '
         'impact costs have not been explicitly modeled and may have a modest effect '
         'on actual performance for larger position sizes.'),
        ('No Slippage Modeling',
         'The backtest assumes execution at closing prices. In practice, particularly for '
         'pyramid lots triggered at specific price levels, actual fill prices may differ '
         'from modeled prices.'),
        ('Capital Constraints',
         'The backtest does not account for capital constraints, margin requirements, '
         'or liquidity limitations that may affect position sizing in live trading.'),
        ('Survivorship Bias',
         'The PNTHR 679 Universe has been constructed as of the current date. Securities '
         'that were delisted, went bankrupt, or were removed from major indices during '
         'the Backtest Period may not be fully represented, potentially overstating results.'),
        ('Model Stability',
         'The model parameters used in the backtest (score weights, tier thresholds, '
         'lot percentages, stop calculations) have been developed over time. Earlier '
         'versions of the model may have used different parameters. The backtest applies '
         'the current final model retroactively.'),
    ]
    for title, text in limitations:
        story.append(b(f'<b>{title}:</b> {text}'))

    story.append(sp(8))
    story.append(p('<b>Full Backtest Report</b>', H2))
    story.append(p('A complete backtest report, including year-by-year returns, drawdown '
                   'analysis, Sharpe and Sortino ratios, sector attribution, and COVID '
                   'stress test results, is available to qualified prospective investors '
                   'upon request. The full report is provided in the PNTHR System '
                   'Architecture document (available upon request).', NORMAL))
    story.append(PageBreak())


def build_other_matters(story):
    story.append(p('<b>OTHER MATTERS</b>',
                   s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                     spaceBefore=0, spaceAfter=10)))
    story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))

    story.append(p('<b>Amendments to this Memorandum</b>', H2))
    story.append(p('The General Partner reserves the right to amend or supplement this '
                   'Memorandum at any time without prior notice to prospective investors. '
                   'Investors who have subscribed prior to any amendment will be notified '
                   'of material amendments pursuant to the terms of the Limited Partnership '
                   'Agreement.', NORMAL))

    story.append(p('<b>Governing Law</b>', H2))
    story.append(p('This Memorandum and the affairs of the Fund shall be governed by and '
                   'construed in accordance with the laws of the State of Delaware, without '
                   'regard to principles of conflicts of laws.', NORMAL))

    story.append(p('<b>Dispute Resolution</b>', H2))
    story.append(p('Any disputes arising under or relating to this Memorandum or an '
                   'investment in the Fund shall be resolved by binding arbitration in '
                   'accordance with the rules of the American Arbitration Association, '
                   'conducted in Maricopa County, Arizona. Nothing herein shall preclude '
                   'either party from seeking emergency injunctive or other equitable '
                   'relief in any court of competent jurisdiction.', NORMAL))

    story.append(p('<b>Entire Agreement</b>', H2))
    story.append(p('This Memorandum, together with the Limited Partnership Agreement and '
                   'Subscription Agreement, constitute the entire agreement between the '
                   'Fund and each investor with respect to an investment in the Fund, and '
                   'supersede all prior agreements, representations, warranties, and '
                   'understandings, whether written or oral.', NORMAL))

    story.append(p('<b>Notices</b>', H2))
    story.append(p('All notices required under this Memorandum shall be in writing and '
                   'delivered to the General Partner at: PNTHR Funds, LLC, 15150 W Park '
                   'Place, Suite 215, Goodyear, AZ 85395, or by email to '
                   'info@pnthrfunds.com.', NORMAL))

    story.append(p('<b>No Waiver</b>', H2))
    story.append(p('No failure or delay by the General Partner in exercising any right, '
                   'power, or privilege under this Memorandum shall operate as a waiver '
                   'thereof, nor shall any single or partial exercise of any right, '
                   'power, or privilege preclude any other exercise thereof.', NORMAL))
    story.append(PageBreak())


def build_exhibits(story):
    for exhibit, title, desc in [
        ('A', 'SUBSCRIPTION AGREEMENT',
         'The Subscription Agreement sets forth the terms and conditions under which an '
         'investor subscribes for Interests in the Fund. Each prospective investor must '
         'complete and execute the Subscription Agreement and provide all required '
         'supporting documentation (including accredited investor certification, '
         'AML/KYC documentation, and any required wire transfer instructions) prior '
         'to admission as a Limited Partner.\n\n'
         'The Subscription Agreement includes representations and warranties by the '
         'subscriber regarding, among other things: (i) accredited investor status; '
         '(ii) investment sophistication and ability to bear the risks of the investment; '
         '(iii) absence of AML/OFAC concerns; (iv) compliance with applicable law; '
         'and (v) acknowledgment of the risk factors and restrictions on transfer '
         'described in this Memorandum.\n\n'
         'A copy of the Subscription Agreement is available from the General Partner '
         'upon request.'),

        ('B', 'LIMITED PARTNERSHIP AGREEMENT',
         'The Limited Partnership Agreement (the "LPA") is the governing document of '
         'Carnivore Quant Fund, LP. The LPA sets forth in detail the rights, obligations, '
         'and economic arrangements among the General Partner and all Limited Partners.\n\n'
         'The LPA covers, among other topics: (i) capital contributions and capital '
         'accounts; (ii) allocations of income, gain, loss, and deduction; (iii) '
         'distributions; (iv) management fee and performance allocation calculations; '
         '(v) High Water Mark and Loss Carryforward mechanics; (vi) Class definitions '
         'and upgrade/downgrade provisions; (vii) redemption procedures, gates, and '
         'suspension provisions; (viii) Side Pocket procedures; (ix) transfer restrictions; '
         '(x) withdrawal and dissolution; and (xi) indemnification.\n\n'
         'A copy of the Limited Partnership Agreement is available from the General '
         'Partner upon request and will be provided to all investors prior to admission.'),
    ]:
        story.append(p(f'<b>EXHIBIT {exhibit} — {title}</b>',
                       s('Normal', fontName='Times-Bold', fontSize=13, alignment=TA_CENTER,
                         spaceBefore=0, spaceAfter=10)))
        story.append(hr(PNTHR_YELLOW, 1.5, 2, 10))
        for para in desc.split('\n\n'):
            story.append(p(para.strip(), NORMAL))
        story.append(PageBreak())


# ══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main():
    os.makedirs(PUBLIC, exist_ok=True)

    doc = SimpleDocTemplate(
        OUT,
        pagesize=letter,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
        title='Carnivore Quant Fund LP — Private Placement Memorandum',
        author='PNTHR Funds, LLC',
        subject='Private Placement Memorandum v2.0',
    )

    story = []

    # Cover (no header/footer)
    build_cover(story)

    # All other pages use inner_page callback
    build_contacts(story)
    build_important_considerations(story)
    build_toc(story)
    build_summary(story)
    build_management(story)
    build_executive_summary(story)
    build_pnthr_signal_system(story)
    build_side_pockets(story)
    build_brokerage(story)
    build_classes(story)
    build_risk_factors(story)
    build_service_providers(story)
    build_valuation(story)
    build_erisa(story)
    build_taxation(story)
    build_aml(story)
    build_backtest_disclosure(story)
    build_other_matters(story)
    build_exhibits(story)

    # Build with page callbacks
    # Cover page = first page, inner_page = all subsequent
    doc.build(story,
              onFirstPage=cover_page,
              onLaterPages=inner_page)

    size_kb = os.path.getsize(OUT) // 1024
    print(f'\n✓ PNTHR PPM v2 generated: {OUT}')
    print(f'  Size: {size_kb} KB')
    print(f'  All 8 corrections applied.')
    print(f'  New sections: PNTHR Signal System, Technology Risk, Backtest Disclosure, Class Upgrade Path.')


if __name__ == '__main__':
    main()
