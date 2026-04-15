#!/usr/bin/env python3
"""
generateDataRoomDocs.py
PNTHR Funds - Carnivore Quant Fund, LP - Data Room Document Suite

Generates 10 branded data room documents:
  1. Risk Management Framework
  2. Fee Schedule Summary
  3. Investment Process Overview
  4. Performance Summary (Hypothetical Backtest)
  5. Due Diligence Questionnaire (DDQ)
  6. Compliance Manual & Code of Ethics
  7. AML/KYC Policy
  8. Business Continuity Plan (BCP)
  9. Key Personnel Bios
 10. Service Provider Summary

Usage:  python3 server/backtest/generateDataRoomDocs.py
Output: client/public/dataroom/  (10 PDFs)
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
PNTHR_YELLOW   = HexColor('#fcf000')
PNTHR_BLACK    = HexColor('#0a0a0a')
PNTHR_DARK     = HexColor('#111111')
PNTHR_DARKGRAY = HexColor('#1a1a1a')
PNTHR_GRAY     = HexColor('#444444')
PNTHR_LGRAY    = HexColor('#888888')
PNTHR_WHITE    = HexColor('#f5f5f5')
PNTHR_GREEN    = HexColor('#22c55e')
PNTHR_RED      = HexColor('#ef4444')
TABLE_HEADER   = HexColor('#1a1a1a')
TABLE_ROW_ALT  = HexColor('#f7f7f7')
TABLE_BORDER   = HexColor('#dddddd')
HEADER_BG      = HexColor('#0d0d0d')

# ── Paths ─────────────────────────────────────────────────────────────────────
HERE   = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, '../../client/public')
ASSETS = os.path.join(HERE, '../../client/src/assets')
OUT_DIR = os.path.join(PUBLIC, 'dataroom')
LOGO_BLACK_BG = os.path.join(PUBLIC, 'pnthr-logo-black-bg.png')
PANTHER_HEAD  = os.path.join(ASSETS, 'panther-head-sm.png')

os.makedirs(OUT_DIR, exist_ok=True)

# ── Page dimensions ───────────────────────────────────────────────────────────
PAGE_W, PAGE_H = letter
MARGIN         = 0.75 * inch
HEADER_H       = 0.55 * inch
CONTENT_W      = PAGE_W - 2 * MARGIN

# ── Styles ────────────────────────────────────────────────────────────────────
styles = getSampleStyleSheet()
_style_cache = {}

def S(name, **kwargs):
    key = name + str(sorted(kwargs.items()))
    if key not in _style_cache:
        base = styles.get(name, styles['Normal'])
        _style_cache[key] = ParagraphStyle(f'custom_{len(_style_cache)}', parent=base, **kwargs)
    return _style_cache[key]

SECTION_HEAD = S('Normal', fontSize=15, fontName='Helvetica-Bold', textColor=PNTHR_BLACK,
                 spaceBefore=8, spaceAfter=5, leading=19)
SECTION_SUB  = S('Normal', fontSize=11, fontName='Helvetica-Bold', textColor=PNTHR_GRAY,
                 spaceBefore=7, spaceAfter=3, leading=15)
BODY         = S('Normal', fontSize=9.5, fontName='Helvetica', textColor=PNTHR_BLACK,
                 leading=14.5, spaceAfter=5)
BODY_JUST    = S('Normal', fontSize=9.5, fontName='Helvetica', textColor=PNTHR_BLACK,
                 leading=14.5, spaceAfter=5, alignment=TA_JUSTIFY)
BULLET       = S('Normal', fontSize=9.5, fontName='Helvetica', textColor=PNTHR_BLACK,
                 leading=14.5, leftIndent=14, spaceAfter=3)
NOTE_STYLE   = S('Normal', fontSize=8.5, fontName='Helvetica-Oblique', textColor=PNTHR_LGRAY,
                 leading=12.5, spaceAfter=4)
DISCLAIMER   = S('Normal', fontSize=7.5, fontName='Helvetica', textColor=PNTHR_LGRAY,
                 alignment=TA_CENTER, leading=11)
BOLD_BODY    = S('Normal', fontSize=9.5, fontName='Helvetica-Bold', textColor=PNTHR_BLACK,
                 leading=14.5, spaceAfter=5)

# ── Reusable components ──────────────────────────────────────────────────────

def yellow_rule():
    return HRFlowable(width='100%', thickness=1.5, color=PNTHR_YELLOW,
                      spaceAfter=6, spaceBefore=2)

def section(text):
    return [yellow_rule(), Paragraph(text, SECTION_HEAD), Spacer(1, 3)]

def subsection(text):
    return [Paragraph(text, SECTION_SUB)]

def body(text):
    return Paragraph(text, BODY_JUST)

def bullet(text):
    return Paragraph(f'<bullet>&bull;</bullet> {text}', BULLET)

def note(text):
    return Paragraph(text, NOTE_STYLE)

def bold_table(headers, rows, col_widths=None, highlight_row=None):
    if col_widths is None:
        col_widths = [CONTENT_W / len(headers)] * len(headers)
    data = [[Paragraph(h, S('Normal', fontSize=9, fontName='Helvetica-Bold',
                            textColor=white, leading=13)) for h in headers]]
    for row in rows:
        data.append([Paragraph(str(c), S('Normal', fontSize=9, fontName='Helvetica',
                                         textColor=PNTHR_BLACK, leading=13)) for c in row])
    ts = TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), TABLE_HEADER),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [white, TABLE_ROW_ALT]),
        ('GRID', (0, 0), (-1, -1), 0.4, TABLE_BORDER),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 7),
        ('RIGHTPADDING', (0, 0), (-1, -1), 7),
    ])
    if highlight_row is not None:
        ts.add('BACKGROUND', (0, highlight_row), (-1, highlight_row), HexColor('#e8f5e9'))
        ts.add('FONTNAME', (0, highlight_row), (-1, highlight_row), 'Helvetica-Bold')
    t = Table(data, colWidths=col_widths, repeatRows=1)
    t.setStyle(ts)
    return t

# ── Page drawing callbacks ───────────────────────────────────────────────────

class DocState:
    def __init__(self, title, version):
        self.title = title
        self.version = version
        self.page = 0

def make_cover_callback(state):
    def draw_cover(canvas, doc):
        state.page += 1
        canvas.saveState()
        # Full black background
        canvas.setFillColor(PNTHR_BLACK)
        canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
        # Panther head watermark
        canvas.saveState()
        canvas.setFillAlpha(0.06)
        try:
            canvas.drawImage(PANTHER_HEAD, PAGE_W - 3.8 * inch, PAGE_H - 4.2 * inch,
                             width=3.5 * inch, height=3.5 * inch,
                             preserveAspectRatio=True, mask='auto')
        except Exception:
            pass
        canvas.restoreState()
        # Top yellow accent bar
        canvas.setFillColor(PNTHR_YELLOW)
        canvas.rect(0, PAGE_H - 0.12 * inch, PAGE_W, 0.12 * inch, fill=1, stroke=0)
        # Logo
        try:
            logo_w = 3.2 * inch
            logo_h = logo_w * (325 / 800)
            canvas.drawImage(LOGO_BLACK_BG, MARGIN, PAGE_H - 2.5 * inch,
                             width=logo_w, height=logo_h,
                             preserveAspectRatio=True, mask='auto')
        except Exception:
            pass
        # Title
        canvas.setFont('Helvetica-Bold', 22)
        canvas.setFillColor(white)
        canvas.drawString(MARGIN, PAGE_H - 3.6 * inch, state.title)
        # Subtitle
        canvas.setFont('Helvetica', 12)
        canvas.setFillColor(PNTHR_YELLOW)
        canvas.drawString(MARGIN, PAGE_H - 4.0 * inch,
                          'Carnivore Quant Fund, LP')
        # Version info
        canvas.setFont('Helvetica', 10)
        canvas.setFillColor(HexColor('#888888'))
        canvas.drawString(MARGIN, PAGE_H - 4.5 * inch, state.version)
        canvas.drawString(MARGIN, PAGE_H - 4.75 * inch,
                          'STT Capital Advisors, LLC')
        # Footer
        canvas.setStrokeColor(PNTHR_YELLOW)
        canvas.setLineWidth(1.5)
        canvas.line(MARGIN, 0.55 * inch, PAGE_W - MARGIN, 0.55 * inch)
        canvas.setFont('Helvetica', 7.5)
        canvas.setFillColor(HexColor('#666666'))
        canvas.drawCentredString(PAGE_W / 2, 0.38 * inch,
            'PNTHR FUNDS  ·  CARNIVORE QUANT FUND  ·  CONFIDENTIAL  ·  April 2026')
        # Confidential notice
        canvas.setFont('Helvetica', 8)
        canvas.setFillColor(HexColor('#555555'))
        y = 1.5 * inch
        for line in [
            'CONFIDENTIAL - FOR QUALIFIED INVESTOR USE ONLY',
            'This document is the property of STT Capital Advisors, LLC',
            'and may not be reproduced or distributed without prior written consent.',
        ]:
            canvas.drawCentredString(PAGE_W / 2, y, line)
            y -= 0.18 * inch
        canvas.restoreState()
    return draw_cover

def make_inner_callback(state):
    def inner_page(canvas, doc):
        state.page += 1
        canvas.saveState()
        # Dark header band
        canvas.setFillColor(HEADER_BG)
        canvas.rect(0, PAGE_H - HEADER_H, PAGE_W, HEADER_H, fill=1, stroke=0)
        # Yellow accent line
        canvas.setStrokeColor(PNTHR_YELLOW)
        canvas.setLineWidth(1.5)
        canvas.line(0, PAGE_H - HEADER_H, PAGE_W, PAGE_H - HEADER_H)
        # Header text
        canvas.setFont('Helvetica-Bold', 9)
        canvas.setFillColor(PNTHR_YELLOW)
        canvas.drawString(MARGIN, PAGE_H - HEADER_H + 0.18 * inch, 'PNTHR FUNDS')
        canvas.setFont('Helvetica', 8)
        canvas.setFillColor(HexColor('#999999'))
        canvas.drawString(MARGIN + 0.9 * inch, PAGE_H - HEADER_H + 0.185 * inch,
                          f'|  Carnivore Quant Fund  |  {state.title}')
        canvas.setFont('Helvetica', 8)
        canvas.setFillColor(HexColor('#888888'))
        canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - HEADER_H + 0.185 * inch,
                               f'Page {state.page}')
        # Footer
        canvas.setStrokeColor(TABLE_BORDER)
        canvas.setLineWidth(0.5)
        canvas.line(MARGIN, 0.55 * inch, PAGE_W - MARGIN, 0.55 * inch)
        canvas.setFont('Helvetica', 7.5)
        canvas.setFillColor(PNTHR_LGRAY)
        canvas.drawCentredString(PAGE_W / 2, 0.38 * inch,
            'PNTHR FUNDS  ·  CARNIVORE QUANT FUND  ·  CONFIDENTIAL  ·  April 2026  ·  pnthrfunds.com')
        canvas.restoreState()
    return inner_page

def build_doc(filename, title, version, story):
    """Build a branded PDF with cover page + inner pages."""
    outpath = os.path.join(OUT_DIR, filename)
    state = DocState(title, version)
    doc = SimpleDocTemplate(
        outpath,
        pagesize=letter,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN + HEADER_H + 0.1 * inch,
        bottomMargin=0.8 * inch,
    )
    # Story starts with a page break to skip cover (cover is drawn by onFirstPage)
    full_story = [PageBreak()] + story
    doc.build(full_story,
              onFirstPage=make_cover_callback(state),
              onLaterPages=make_inner_callback(state))
    print(f'  -> {outpath}')


# ═══════════════════════════════════════════════════════════════════════════════
# 1. RISK MANAGEMENT FRAMEWORK
# ═══════════════════════════════════════════════════════════════════════════════

def gen_risk_management():
    s = []
    s += section('Risk Management Philosophy')
    s.append(body(
        'The Carnivore Quant Fund is engineered for <b>capital preservation first, alpha generation '
        'second</b>. Every aspect of the system, from signal selection to position sizing to exit '
        'discipline, ensures the portfolio can absorb adverse conditions without meaningful drawdown. '
        'The Fund employs a multi-layered risk architecture spanning position sizing, portfolio-level '
        'controls, and automated alert systems, all enforced systematically with zero discretionary override.'
    ))

    s += section('Position Sizing: 1% Vitality Cap')
    s.append(body(
        'The Fund sizes full positions between <b>0.5% and 2.0% of NAV</b>, with <b>1.0% of NAV</b> '
        'as the standard allocation for individual equities and <b>0.5% of NAV</b> for ETFs. '
        'Because the initial entry (Lot 1) deploys only 35% of the full position, the actual '
        'capital at risk on any new trade is just <b>0.35% of NAV</b>, ensuring minimal impact '
        'from any single entry. Share count is calculated as floor(risk budget / risk per share). '
        'A wider stop produces fewer shares, never more risk.'
    ))
    s.append(bold_table(
        ['Asset Type', 'Max Position Size', 'Initial Entry (Lot 1)', 'Rationale'],
        [
            ['Individual Equities (Vitality)', '0.5%-2.0% of NAV (1.0% standard)', '0.35% of NAV (at 1.0%)', 'Core risk unit; full size earned through pyramid confirmation'],
            ['ETFs', '0.5% of NAV', '0.175% of NAV', 'Reduced allocation reflects lower alpha potential'],
        ],
        col_widths=[2.0*inch, 1.3*inch, 1.3*inch, CONTENT_W - 4.6*inch]
    ))

    s += section('5-Lot Pyramid System')
    s.append(body(
        'Initial entry deploys only <b>35% of the full position</b>. Subsequent lots at +3%, +6%, '
        '+10%, +14% are earned through sequential confirmation, each lot requiring the prior lot '
        'to be filled, a time gate to be cleared, and a price trigger to be reached. Maximum capital '
        'is only deployed when the market has confirmed the trade multiple times.'
    ))
    s.append(bold_table(
        ['Lot', 'Name', 'Alloc', 'Trigger', 'Gate', 'Purpose'],
        [
            ['Lot 1', 'The Scent', '35%', 'Signal entry', 'None', 'Initial position; market must confirm'],
            ['Lot 2', 'The Stalk', '25%', '+3% from entry', '5 trading days', 'Largest add; time + price required'],
            ['Lot 3', 'The Strike', '20%', '+6% from entry', 'Lot 2 filled', 'Momentum continuation confirmed'],
            ['Lot 4', 'The Jugular', '12%', '+10% from entry', 'Lot 3 filled', 'Trend extension'],
            ['Lot 5', 'The Kill', '8%', '+14% from entry', 'Lot 4 filled', 'Maximum conviction; full position'],
        ],
        col_widths=[0.6*inch, 0.85*inch, 0.55*inch, 1.05*inch, 1.0*inch, CONTENT_W - 4.05*inch]
    ))

    s += section('10% Max Portfolio Risk Exposure')
    s.append(body(
        'At no point does the Fund risk more than <b>10% of total portfolio NAV</b> across all open '
        'positions combined. This portfolio-level risk ceiling ensures that even in a worst-case '
        'scenario where every open position hits its stop simultaneously, the maximum drawdown is '
        'capped at 10%. Recycled positions (stop beyond entry) carry $0 risk and do not count '
        'toward this limit.'
    ))

    s += section('Portfolio Heat Caps')
    s.append(body(
        'Open risk (\"heat\") is further segmented by direction to prevent overweighting '
        'either side of the book:'
    ))
    s.append(bold_table(
        ['Control', 'Cap', 'Description'],
        [
            ['Long Heat', '10% of NAV', 'Total open risk across all long positions'],
            ['Short Heat', '5% of NAV', 'Total open risk across all short positions'],
            ['Combined', '15% of NAV', 'Theoretical max if both sides fully deployed'],
        ],
        col_widths=[1.8*inch, 1.5*inch, CONTENT_W - 3.3*inch]
    ))

    s += section('Sector Concentration Limit')
    s.append(body(
        'Net directional exposure is capped at <b>3 positions per sector</b>, calculated as the absolute '
        'difference between long and short positions within each sector. '
        'Prevents correlated drawdowns from sector-specific events. ETFs are exempt. When a sector '
        'breach is detected, the Risk Advisor provides two resolution options:'
    ))
    s.append(bullet('<b>Option A:</b> Close the weakest position in the over-concentrated sector'))
    s.append(bullet('<b>Option B:</b> Add an opposite-direction position using top Kill candidates'))

    s += section('Stop Loss System: Proprietary PNTHR Stop Loss System (PPSLC)')
    s.append(body(
        'All positions are protected by the <b>PPSLC</b>, a proprietary stop loss calculation that '
        'determines the most conservative of two variables and applies that price as the PNTHR Stop '
        'on all trades. The system allows price movement while remaining ready for counter-trend '
        'adverse directional risk. Stops never move against the trade:'
    ))
    s.append(bullet('<b>BL positions:</b> Stop ratchets UP only (never moves down)'))
    s.append(bullet('<b>SS positions:</b> Stop ratchets DOWN only (never moves up)'))
    s.append(Spacer(1, 4))
    s += subsection('Stop Ratchet on Each Lot Fill')
    s.append(bold_table(
        ['Lot Fill Event', 'Stop Moves To', 'Effect'],
        [
            ['Lot 2 fills', 'Initial stop (unchanged)', 'Time + price confirmed, position monitored'],
            ['Lot 3 fills', 'Average cost (breakeven)', 'Capital protected; initial investment covered'],
            ['Lot 4 fills', 'Lot 2 fill price', 'Lot 2 gain locked in as minimum exit'],
            ['Lot 5 fills', 'Lot 3 fill price', 'Full pyramid; aggressive ratcheted stop'],
        ],
        col_widths=[1.5*inch, 2.5*inch, CONTENT_W - 4.0*inch]
    ))

    s += section('Systematic Exit Discipline')
    s.append(body(
        'Every exit is categorized and scored for discipline. Manual overrides are tracked and '
        'penalized. The system rewards systematic behavior:'
    ))
    s.append(bold_table(
        ['Exit Type', 'Trigger', 'Discipline Score'],
        [
            ['PNTHR Signal', 'Proprietary PNTHR Exit Signal is generated', '12/12 (Perfect)'],
            ['FEAST', 'RSI > 85 momentum exhaustion, sell 50% immediately', '12/12 (Perfect)'],
            ['PNTHR PPSLC Stop Hit', 'Ratchet stop hit', '10/12'],
            ['RISK_ADVISOR', 'Sector/portfolio concentration breach', '10/12'],
            ['STALE_HUNT', '20-day position without development, mandatory closure', '10/12'],
            ['MANUAL', 'Discretionary exit', '4/12 (profit) or 0/12 (loss)'],
        ],
        col_widths=[1.5*inch, 3.2*inch, CONTENT_W - 4.7*inch]
    ))

    s += section('Automated Alert Systems')
    s += subsection('FEAST Alert (Momentum Exhaustion)')
    s.append(body(
        'When weekly RSI exceeds 85 on any long position, the system triggers a <b>FEAST Alert</b>, '
        'a high-urgency notification to sell 50% of the position immediately. RSI > 85 historically '
        'signals extreme momentum exhaustion with high reversal probability.'
    ))
    s += subsection('Stale Hunt Timer')
    s.append(body(
        'Positions that fail to develop are automatically flagged based on trading days since entry:'
    ))
    s.append(bold_table(
        ['Trading Days', 'Status', 'Action'],
        [
            ['15-17 days', 'STALE (Yellow)', 'Review position thesis'],
            ['18-19 days', 'STALE (Orange)', 'Prepare for liquidation'],
            ['20+ days', 'LIQUIDATE (Red)', 'Mandatory position closure'],
        ],
        col_widths=[1.8*inch, 1.8*inch, CONTENT_W - 3.6*inch]
    ))

    s += section('Wash Sale Compliance')
    s.append(body(
        '30-day re-entry lockout on losing trades, <b>automatically enforced by the pipeline</b>. '
        'Any attempt to re-enter a position within 30 calendar days of closing at a loss is blocked '
        'at the pre-trade scoring level (Analyze Score penalizes wash sale violations with 0/5 points).'
    ))

    s += section('Pre-Trade Risk Assessment (Analyze Score)')
    s.append(body(
        'Every potential trade is scored through the <b>Analyze system</b>, a 100-point pre-trade '
        'assessment where every point is evaluable at scan time. No estimation, no guesswork:'
    ))
    s.append(bold_table(
        ['Tier', 'Weight', 'Components'],
        [
            ['T1: Setup Quality', '40 points', 'Signal Quality (15), Kill Context (10), Index Trend (8), Sector Trend (7)'],
            ['T2: Risk Profile', '35 points', 'Freshness (12), Risk/Reward (8), Prey Presence (8), Conviction (7)'],
            ['T3: Entry Conditions', '25 points', 'Slope Strength (5), Sector Concentration (5), Wash Compliance (5), Volatility/RSI (5), Portfolio Fit (5)'],
        ],
        col_widths=[1.8*inch, 1.2*inch, CONTENT_W - 3.0*inch]
    ))
    s.append(Spacer(1, 4))
    s.append(body(
        'Score <font color="#22c55e">&gt;=75%</font> = green (optimal). '
        '<font color="#f59e0b">&gt;=55%</font> = yellow (proceed with awareness). '
        '<font color="#ef4444">&lt;55%</font> = red (reconsider). '
        'SIZE IT is blocked when Analyze detects errors in underlying data.'
    ))

    s += section('Macro & Sector Gates')
    s.append(body(
        'The orders pipeline applies additional gates before any position can be opened:'
    ))
    s.append(bullet('<b>Macro Gate:</b> SPY/QQQ regime assessment (21-week EMA direction and multiplier)'))
    s.append(bullet('<b>Sector Gate:</b> Sector EMA direction must align with trade direction'))
    s.append(bullet('<b>D2 Gate:</b> Kill scoring dimension 2 (sector direction) must not be negative'))
    s.append(bullet('<b>SS Crash Gate:</b> SPY/QQQ EMA falling for 2 consecutive weeks AND sector 5-day momentum below -3%'))

    s += section('Worst-Case Validation (MAE Analysis)')
    s.append(body(
        'The maximum adverse excursion (MAE) across all 2,520 closed pyramid trades was <b>-15.2%</b> '
        'on a single trade. At Lot 1 sizing (35% of the full position = $3,500 on a $10K position), '
        'this translated to approximately <b>0.5% of portfolio NAV</b>.'
    ))
    s.append(body(
        'Even during the months when worst-case MAE trades occurred, the portfolio remained profitable '
        'on a net basis. The 1% vitality cap and 35% initial lot sizing ensure that no single adverse '
        'trade can materially impair investor capital. No drawdown resulted in permanent capital loss.'
    ))

    build_doc('PNTHR_Risk_Management_Framework.pdf',
              'Risk Management Framework', 'v1.0 - April 2026', s)


# ═══════════════════════════════════════════════════════════════════════════════
# 2. FEE SCHEDULE SUMMARY
# ═══════════════════════════════════════════════════════════════════════════════

def gen_fee_schedule():
    s = []
    s += section('Interest Classes')
    s.append(body(
        'The Fund offers three classes of Limited Partner Interests, differentiated by minimum '
        'investment level and corresponding performance allocation rate. All classes are subject '
        'to the same management fee, redemption terms, and investment strategy.'
    ))
    s.append(bold_table(
        ['Feature', 'Wagyu Class', 'Porterhouse Class', 'Filet Class'],
        [
            ['Minimum Investment', '>= $1,000,000', '$500,000 - $999,999', '< $500,000 (min. $100,000)'],
            ['Performance Allocation', '20%', '25%', '30%'],
            ['3-Year Loyalty Rate', '15%', '20%', '25%'],
            ['Management Fee', '2.0% p.a.', '2.0% p.a.', '2.0% p.a.'],
            ['Hurdle Rate', 'US2Y', 'US2Y', 'US2Y'],
            ['High Water Mark', 'Yes', 'Yes', 'Yes'],
            ['Lock-Up', '1 year', '1 year', '1 year'],
        ],
        col_widths=[1.8*inch, (CONTENT_W - 1.8*inch)/3, (CONTENT_W - 1.8*inch)/3, (CONTENT_W - 1.8*inch)/3]
    ))

    s += section('Management Fee')
    s.append(body(
        '<b>2.0% per annum</b> on Net Asset Value, accrued monthly and paid quarterly in advance.'
    ))

    s += section('Performance Allocation')
    s.append(body(
        'The performance allocation is calculated <b>quarterly (non-cumulative)</b>, at the end of each '
        'fiscal quarter, based on the net appreciation of each Limited Partner\'s capital account above '
        'the High Water Mark and in excess of the quarterly Hurdle Rate (the annualized US2Y yield '
        'divided by four) for such quarter. Each quarter is evaluated independently.'
    ))
    s.append(Spacer(1, 4))
    s += subsection('Class Upgrade Path')
    s.append(body(
        'Limited Partners whose aggregate capital commitment increases to or above a higher tier '
        'threshold may request reclassification to the applicable higher class. Upgrades are effective '
        'at the beginning of the next full performance period following written request and confirmation '
        'by the General Partner. The performance allocation rate for the prior period will be calculated '
        'at the rate applicable to the investor\'s prior class. Downgrades (to a lower class due to '
        'partial withdrawal) are at the sole discretion of the General Partner.'
    ))

    s += section('Hurdle Rate')
    s.append(body(
        'The <b>US 2-Year Treasury Yield (US2Y)</b>, applied as a quarterly hurdle (the annualized '
        'yield divided by four). No performance allocation is earned on any quarter\'s net appreciation '
        'until the Fund\'s quarterly return exceeds this threshold.'
    ))

    s += section('High Water Mark with Loss Carryforward')
    s.append(body(
        'Performance allocations are calculated only on net profits above the <b>High Water Mark</b>. '
        'The High Water Mark is a running maximum of the Limited Partner\'s adjusted NAV per unit.'
    ))
    s.append(Spacer(1, 4))
    s.append(body(
        'If a Limited Partner\'s capital account has a net loss in any fiscal year, the '
        '<b>Loss Carryforward Provision</b> applies: the deficit must be fully recovered in '
        'subsequent periods before any performance allocation is charged. The Loss Carryforward '
        'is specific to each Limited Partner\'s account and is not aggregated across investors.'
    ))

    s += section('3-Year Loyalty Discount')
    s.append(body(
        'Limited Partners who maintain continuous investment for <b>36 consecutive months</b> '
        'are eligible for a permanent 5% reduction in performance allocation rate for all '
        'subsequent performance periods. The loyalty discount is applied prospectively beginning '
        'in the performance period following the 36-month anniversary.'
    ))
    s.append(bold_table(
        ['Class', 'Standard Rate', 'Loyalty Rate (36+ Months)', 'Savings'],
        [
            ['Wagyu', '20%', '15%', '5%'],
            ['Porterhouse', '25%', '20%', '5%'],
            ['Filet', '30%', '25%', '5%'],
        ],
        col_widths=[1.5*inch, 1.8*inch, 2.2*inch, CONTENT_W - 5.5*inch]
    ))

    s += section('Redemptions')
    s.append(body(
        'Quarterly, on the first Business Day of each calendar quarter, upon <b>sixty (60) days\' '
        'prior written notice</b>, subject to the lock-up provisions described herein. The General '
        'Partner reserves the right to impose gates, suspend redemptions, or satisfy redemptions '
        'in kind.'
    ))

    s += section('Lock-Up Period')
    s.append(body(
        '<b>One (1) year</b> from the date of initial investment, unless waived by the '
        'General Partner.'
    ))
    s.append(Spacer(1, 4))
    s += subsection('Early Withdrawal Penalty')
    s.append(body(
        'Redemptions made during the lock-up period (if permitted by the General Partner) are '
        'subject to a <b>25% early withdrawal penalty</b> applied to the redeemed amount.'
    ))

    s += section('Redemption Restrictions')
    s.append(bullet('<b>Minimum Withdrawal:</b> $25,000'))
    s.append(bullet('<b>Minimum Balance:</b> $50,000 must remain in the Limited Partner\'s capital '
                     'account following any redemption. If a redemption would reduce the balance '
                     'below $50,000, the General Partner may require a full redemption.'))
    s.append(bullet('<b>Gate Provision:</b> The General Partner may limit aggregate quarterly '
                     'redemptions to <b>25% of the Fund\'s NAV</b>. Redemption requests in excess '
                     'of the gate will be fulfilled pro rata and the unfulfilled portion carried '
                     'forward to the next quarter.'))

    s += section('Eligible Investors')
    s.append(body(
        'The Fund is offered exclusively under Regulation D, Rule 506(c). All investors must '
        'qualify as <b>both Accredited Investors and Qualified Clients</b> as defined under the '
        'Securities Act of 1933 and the Investment Advisers Act of 1940, respectively.'
    ))

    s += section('Subscription Periods')
    s.append(body(
        'Monthly, on the first Business Day of each calendar month, upon <b>thirty (30) days\' '
        'prior written notice</b> to the General Partner.'
    ))

    s += section('Fiscal Year')
    s.append(body('January 1 through December 31.'))

    s.append(Spacer(1, 12))
    s.append(note(
        'This summary is provided for convenience only and does not modify or supersede the '
        'terms of the Private Placement Memorandum or Limited Partnership Agreement. In the '
        'event of any conflict, the PPM and LPA govern.'
    ))

    build_doc('PNTHR_Fee_Schedule_Summary.pdf',
              'Fee Schedule Summary', 'v1.0 - April 2026', s)


# ═══════════════════════════════════════════════════════════════════════════════
# 3. INVESTMENT PROCESS OVERVIEW
# ═══════════════════════════════════════════════════════════════════════════════

def gen_investment_process():
    s = []
    s += section('Strategy Overview')
    s.append(body(
        'Carnivore Quant Fund employs a <b>proprietary systematic long/short equity strategy</b> '
        'built on the PNTHR Signal System. The Fund identifies high-conviction entry points '
        'using an 8-dimension scoring framework, enters positions through a disciplined '
        'pyramid structure, and manages risk via the Proprietary PNTHR Stop Loss System (PPSLC) '
        'and portfolio-level controls. The strategy is designed to generate alpha in all market '
        'regimes through both long (BL) and short (SS) signals.'
    ))

    s += section('The PNTHR 679 Universe')
    s.append(body(
        'Every week the system scans <b>679 premier U.S. equities</b>: the S&amp;P 500, Nasdaq 100, '
        'Dow 30, plus select large-cap and mid-cap securities. The universe was selected for '
        'liquidity, coverage across all 11 GICS sectors, and representation across all market '
        'caps from $2B to $4T+.'
    ))

    s += section('PNTHR Proprietary Buy Long Signal (BL)')
    s.append(body(
        'A BL signal is generated when the following conditions all prove true:'
    ))
    s.append(bullet('Weekly close above the sector-specific optimized EMA'))
    s.append(bullet('Sector-specific EMA is rising with a predetermined positive slope, proving the trend is genuine'))
    s.append(bullet('Weekly high at or above the previous 2-week high, confirming a structural breakout'))
    s.append(bullet('Weekly low above the sector-specific optimized EMA by minimum 1% daylight (stocks) or 0.3% (ETFs)'))

    s += section('PNTHR Proprietary Sell Short Signal (SS)')
    s.append(body(
        'An SS signal is generated when the following conditions all prove true:'
    ))
    s.append(bullet('Weekly close below the sector-specific optimized EMA'))
    s.append(bullet('Sector-specific EMA is declining with a predetermined negative slope, proving the downtrend is genuine'))
    s.append(bullet('Weekly low at or below the previous 2-week low, confirming a structural breakdown'))
    s.append(bullet('Weekly high below the sector-specific optimized EMA by minimum 1% daylight (stocks) or 0.3% (ETFs)'))
    s.append(Spacer(1, 4))
    s.append(body(
        'Additionally, SS signals require the <b>PNTHR SS Crash Gate</b> to be satisfied: '
        'SPY/QQQ EMA falling for 2 consecutive weeks AND sector 5-day momentum below -3%.'
    ))

    s += section('The PNTHR Kill Scoring Engine')
    s.append(body(
        'The PNTHR Kill Scoring Engine is the intellectual core of the strategy: seven years of '
        'research distilled into 8 dimensions that transform 679 stocks into a precision-ranked '
        'list where the top entries have a statistically validated 66-70% probability of success. '
        'The system does not guess. It measures, confirms, and ranks with mathematical precision.'
    ))
    s += subsection('Master Formula')
    s.append(body(
        '<b>PNTHR KILL SCORE = (D2 + D3 + D4 + D5 + D6 + D7 + D8) x D1</b>'
    ))
    s.append(bold_table(
        ['Dim', 'Name', 'Range', 'What It Measures'],
        [
            ['D1', 'Market Regime Multiplier', '0.70x-1.30x', 'Global amplifier. Bear: SS boosted, BL dampened. SPY + QQQ tracked independently'],
            ['D2', 'Sector Alignment', '+/-15 pts', 'Sector ETF 5-day returns (2x weight for new signals) + 1-month returns'],
            ['D3', 'Entry Quality', '0-85 pts', 'Close Conviction (0-40) + EMA Slope (0-30) + Separation Bell Curve (0-15). Dominant dimension'],
            ['D4', 'Signal Freshness', '-15 to +10', 'Age 0 CONFIRMED=+10. Smooth decay. Age 6-9: -3/wk. Floor -15 at wk 12+'],
            ['D5', 'Rank Rise', '+/-20 pts', 'Week-over-week ranking improvement. +1 per spot risen, -1 per spot fallen'],
            ['D6', 'Momentum', '-10 to +20', 'RSI (+/-5), OBV change (+/-5), ADX strength (0-5), Volume confirmation (0/+5)'],
            ['D7', 'Rank Velocity', '+/-10 pts', 'Acceleration of rank change. clip(round((curD5-prevD5)/6), -10, +10)'],
            ['D8', 'Multi-Strategy Convergence', '0-6 pts', 'SPRINT/HUNT +2 each, FEAST/ALPHA/SPRING/SNEAK +1 each. Independent confirmation'],
        ],
        col_widths=[0.5*inch, 1.3*inch, 1.0*inch, CONTENT_W - 2.8*inch]
    ))

    s += subsection('Tier Classification')
    s.append(bold_table(
        ['Score', 'Tier', 'Action'],
        [
            ['130+', 'ALPHA PNTHR KILL', 'Maximum conviction. All 8 dimensions aligned. Immediate action'],
            ['100+', 'STRIKING', 'High conviction. Strong entry quality + multiple dimensions'],
            ['80+', 'HUNTING', 'Active confirmed setup. Moderate multi-dimension support'],
            ['65+', 'POUNCING', 'Solid setup. Entry quality present, monitoring closely'],
            ['50+', 'COILING', 'Building. Signal present, dimensions accumulating'],
            ['<50', 'STALKING / LOWER', 'Early stage or nascent signal'],
            ['-99', 'OVEREXTENDED', '>20% separation from EMA. Excluded from ranking'],
        ],
        col_widths=[0.8*inch, 1.8*inch, CONTENT_W - 2.6*inch]
    ))

    s += section('PNTHR Analyze Pre-Trade Scoring')
    s.append(body(
        'The PNTHR Analyze system answers the question every trader must answer before entering: '
        'is this the right trade, right now? Every one of Analyze\'s 100 points can be evaluated '
        'at the exact moment the scan runs. No estimation, no guesswork.'
    ))
    s.append(bold_table(
        ['Tier', 'Points', 'Components'],
        [
            ['T1: Setup Quality', '40', 'Signal Quality (15), Kill Context (10), Index Trend (8), Sector Trend (7)'],
            ['T2: Risk Profile', '35', 'Freshness (12), Risk/Reward (8), Prey Presence (8), Conviction (7)'],
            ['T3: Entry Conditions', '25', 'Slope Strength (5), Sector Concentration (5), Wash Compliance (5), Volatility/RSI (5), Portfolio Fit (5)'],
        ],
        col_widths=[1.8*inch, 0.8*inch, CONTENT_W - 2.6*inch]
    ))
    s.append(Spacer(1, 4))
    s.append(body(
        'Score <font color="#22c55e">>=75%</font> = green (optimal). '
        '<font color="#f59e0b">>=55%</font> = yellow (proceed with awareness). '
        '<font color="#ef4444">&lt;55%</font> = red (reconsider). '
        'The Analyze score is preserved as the authoritative snapshot for all downstream journal '
        'and discipline scoring.'
    ))

    s += section('PNTHR Position Sizing and Pyramiding')
    s.append(body(
        'Position sizing is where discipline becomes quantifiable. The PNTHR pyramid model ensures '
        'maximum capital is only deployed when the market has confirmed the trade multiple times. '
        'A new entry receives only 35% of the intended position. Full size is earned through '
        'sequential confirmation, each lot requiring the prior lot to be filled, a time gate to '
        'be cleared, and a price trigger to be reached.'
    ))
    s.append(bold_table(
        ['Lot', 'Name', 'Alloc', 'Trigger', 'Gate', 'Purpose'],
        [
            ['Lot 1', 'The Scent', '35%', 'Signal entry', 'None', 'Initial position; market must confirm'],
            ['Lot 2', 'The Stalk', '25%', '+3% from entry', '5 trading days', 'Largest add; time + price required'],
            ['Lot 3', 'The Strike', '20%', '+6% from entry', 'Lot 2 filled', 'Momentum continuation confirmed'],
            ['Lot 4', 'The Jugular', '12%', '+10% from entry', 'Lot 3 filled', 'Trend extension'],
            ['Lot 5', 'The Kill', '8%', '+14% from entry', 'Lot 4 filled', 'Maximum conviction; full position'],
        ],
        col_widths=[0.6*inch, 0.85*inch, 0.55*inch, 1.05*inch, 1.0*inch, CONTENT_W - 4.05*inch]
    ))
    s.append(Spacer(1, 4))
    s += subsection('Stop Ratchet on Each Lot Fill')
    s.append(bold_table(
        ['Lot Fill Event', 'Stop Moves To', 'Effect'],
        [
            ['Lot 2 fills', 'Initial stop (unchanged)', 'Time + price confirmed, position monitored'],
            ['Lot 3 fills', 'Average cost (breakeven)', 'Capital protected; initial investment covered'],
            ['Lot 4 fills', 'Lot 2 fill price', 'Lot 2 gain locked in as minimum exit'],
            ['Lot 5 fills', 'Lot 3 fill price', 'Full pyramid; aggressive ratcheted stop'],
        ],
        col_widths=[1.5*inch, 2.5*inch, CONTENT_W - 4.0*inch]
    ))
    s.append(Spacer(1, 4))
    s.append(body(
        'Stops never move backwards. The ratchet is a one-way lock. SS positions: ratchets down only.'
    ))

    s += section('PNTHR Entry Workflow')
    s.append(bold_table(
        ['Step', 'Action', 'What Happens'],
        [
            ['1', 'SIZE IT', 'Analyze scoring (100 pts). Blocked when errors detected. Green >=75%. Yellow 55-74%. Red <55%'],
            ['2', 'QUEUE IT', 'Order queued: ticker, direction, lot size, target price, Analyze score. Per-user, persists across sessions'],
            ['3', 'SEND TO COMMAND', '4-source cascade: Analyze snapshot (authoritative) to queue entry to MongoDB pipeline to signal cache updated'],
        ],
        col_widths=[0.5*inch, 1.3*inch, CONTENT_W - 1.8*inch]
    ))

    s += section('Systematic Exit Discipline')
    s.append(body(
        'Every exit is categorized and scored for discipline. Manual overrides are tracked and '
        'penalized. The system rewards systematic behavior:'
    ))
    s.append(bold_table(
        ['Exit Type', 'Trigger', 'Discipline Score'],
        [
            ['PNTHR Signal', 'Proprietary PNTHR Exit Signal is generated', '12/12 (Perfect)'],
            ['FEAST', 'RSI > 85 momentum exhaustion, sell 50% immediately', '12/12 (Perfect)'],
            ['PNTHR PPSLC Stop Hit', 'Ratchet stop hit', '10/12'],
            ['RISK_ADVISOR', 'Sector/portfolio concentration breach', '10/12'],
            ['STALE_HUNT', '20-day position without development, mandatory closure', '10/12'],
            ['MANUAL', 'Discretionary exit', '4/12 (profit) or 0/12 (loss)'],
        ],
        col_widths=[1.5*inch, 3.2*inch, CONTENT_W - 4.7*inch]
    ))

    s += section('Friday Pipeline')
    s.append(body(
        'The Fund runs a weekly batch process every <b>Friday at 4:15 PM ET</b> that refreshes '
        'all Kill scores, updates the signal state machine, recalculates stops, and persists '
        'results to the database. This ensures all scoring data is current for the following '
        'week\'s trading decisions.'
    ))

    build_doc('PNTHR_Investment_Process_Overview.pdf',
              'Investment Process Overview', 'v1.0 - April 2026', s)


# ═══════════════════════════════════════════════════════════════════════════════
# 4. PERFORMANCE SUMMARY (HYPOTHETICAL BACKTEST)
# ═══════════════════════════════════════════════════════════════════════════════

def gen_performance_summary():
    s = []

    # Disclaimer box at top
    s += section('Important Disclosures')
    s.append(body(
        '<b>HYPOTHETICAL PERFORMANCE RESULTS HAVE MANY INHERENT LIMITATIONS.</b> '
        'No representation is being made that any account will or is likely to achieve profits '
        'or losses similar to those shown. In fact, there are frequently sharp differences between '
        'hypothetical performance results and the actual results subsequently achieved by any '
        'particular trading program.'
    ))
    s.append(body(
        'One of the limitations of hypothetical performance results is that they are generally '
        'prepared with the benefit of hindsight. In addition, hypothetical trading does not involve '
        'financial risk, and no hypothetical trading record can completely account for the impact '
        'of financial risk in actual trading. The ability to withstand losses or to adhere to a '
        'particular trading program in spite of trading losses are material points which can '
        'adversely affect actual trading results.'
    ))
    s.append(body(
        '"PNTHR NET" returns are fully burdened: all figures are net of IBKR Pro Fixed commissions '
        '($0.005/share), 5 basis points of slippage per leg, sector-tiered short borrow costs '
        '(1.0-2.0% annualized), a 2.0% per annum management fee on NAV, and a tiered performance '
        'allocation of 20%, 25%, 30% (by investor class) on net profits above a hurdle rate equal '
        'to the US 2-Year Treasury Yield, reset annually, subject to a high-water mark with loss '
        'carryforward provision. These are the returns an investor would have realized after every '
        'cost and fee. Past hypothetical performance is not indicative of future results.'
    ))

    s += section('Performance Comparison: PNTHR vs. S&P 500')
    s.append(body('Backtest Period: June 2019 through April 2026 (7 years)'))
    s.append(bold_table(
        ['Metric', 'Carnivore Quant Fund', 'S&P 500 (SPY)', 'Alpha'],
        [
            ['Total Return (7yr)', '+761%', '+128%', '+633%'],
            ['CAGR (Net)', '+37.0%', '+12.9%', '+24.1%'],
            ['Sharpe Ratio', '2.39', '~0.8', ''],
            ['Sortino Ratio', '34.0', '~1.0', ''],
            ['Max Monthly Drawdown', '-1.00%', '-34.1%', ''],
            ['Calmar Ratio', '37.0', '~0.4', ''],
            ['Positive Months', '76/82 (92.7%)', '~60%', ''],
            ['Win Rate', '49.7%', 'N/A', ''],
            ['Profit Factor', '9.1x', 'N/A', ''],
            ['Ending Equity ($100K start)', '$861.4K', '$228.0K', '$633.4K'],
        ],
        col_widths=[2.0*inch, 1.8*inch, 1.5*inch, CONTENT_W - 5.3*inch]
    ))

    s += section('Strategy Metrics by Direction')
    s.append(bold_table(
        ['Metric', 'BL (Longs)', 'SS (Shorts)', 'Combined'],
        [
            ['Net CAGR', '+39.0%', '+22.3%', '+37.0%'],
            ['Sharpe Ratio', '2.44', '1.61', '2.39'],
            ['Sortino Ratio', '32.80', '12.98', '34.02'],
            ['Max Drawdown', '-1.00%', '-0.45%', '-1.00%'],
            ['Calmar Ratio', '38.9', '49.4', '37.0'],
            ['Profit Factor', '9.33x', '6.14x', '9.10x'],
            ['Win Rate', '49.7%', '50.0%', '49.7%'],
            ['Avg Monthly Return', '+2.83%', '+1.73%', '+2.71%'],
            ['Best Month', '+19.3%', '+9.3%', '+19.3%'],
            ['Worst Month', '-1.00%', '-0.44%', '-1.00%'],
            ['Positive Months', '69/77', '12/18', '76/82'],
            ['Total Trades', '2,366', '154', '2,520'],
        ],
        col_widths=[1.8*inch, 1.5*inch, 1.5*inch, CONTENT_W - 4.8*inch]
    ))

    s += section('Crisis Alpha: Performance During Market Drawdowns')
    s.append(body(
        'The hallmark of a disciplined panther is composure under pressure. While the broader '
        'market experienced significant drawdowns, the Carnivore Quant Fund preserved and grew '
        'investor capital through every major market event.'
    ))
    s.append(bold_table(
        ['Market Event', 'Period', 'S&P 500', 'PNTHR Fund', 'PNTHR Alpha'],
        [
            ['COVID Crash', '2020-02-21 to 2020-03-23', '-34.1%', '-3.8%', '+30.3%'],
            ['2022 Bear Market', '2022-01-05 to 2022-10-12', '-25.4%', '+11.7%', '+37.1%'],
            ['2025 Liberation Day Correction', '2025-02-21 to 2025-04-08', '-19.0%', '+1.8%', '+20.8%'],
            ['Market Correction', '2020-09-03 to 2020-09-23', '-9.8%', '-4.3%', '+5.5%'],
            ['Market Correction', '2024-07-17 to 2024-08-05', '-8.4%', '-0.1%', '+8.3%'],
            ['Market Correction', '2019-07-31 to 2019-08-05', '-6.0%', '-3.5%', '+2.5%'],
        ],
        col_widths=[1.8*inch, 1.8*inch, 1.0*inch, 1.0*inch, CONTENT_W - 5.6*inch]
    ))

    s += section('Annual Performance: PNTHR vs S&P 500')
    s.append(bold_table(
        ['Year', 'SPY Equity', 'S&P 500', 'PNTHR Equity', 'PNTHR Net', 'PNTHR Alpha'],
        [
            ['2019', '$111,893', '+11.9%', '$155,678', '+55.7%', '+43.8%'],
            ['2020', '$129,977', '+16.2%', '$267,963', '+72.1%', '+56.0%'],
            ['2021', '$165,117', '+27.0%', '$384,153', '+43.4%', '+16.3%'],
            ['2022', '$132,950', '-19.5%', '$424,735', '+10.6%', '+30.0%'],
            ['2023', '$165,239', '+24.3%', '$522,245', '+23.0%', '-1.3%'],
            ['2024', '$203,748', '+23.3%', '$648,114', '+24.1%', '+0.8%'],
            ['2025', '$237,066', '+16.4%', '$813,796', '+25.6%', '+9.2%'],
            ['2026', '$227,996', '-3.8%', '$861,408', '+5.8%', '+9.7%'],
        ],
        col_widths=[0.6*inch, 1.0*inch, 1.0*inch, 1.2*inch, 1.0*inch, CONTENT_W - 4.8*inch]
    ))

    s += section('Key Takeaway')
    s.append(body(
        'At no point during the entire 7-year backtest did the account balance or investor equity '
        'decline below prior high-water marks for more than a single month. Even during the months '
        'when worst-case MAE trades occurred, the portfolio remained profitable on a net basis. '
        'The 1% vitality cap and 35% initial lot sizing ensure that no single adverse trade can '
        'materially impair investor capital.'
    ))

    s.append(Spacer(1, 12))
    s.append(note(
        'Complete backtest methodology, monthly return heatmaps, drawdown analysis, rolling '
        '12-month returns, and daily NAV logs are available in the Fund Intelligence Report. '
        'All backtest data has been internally validated for sector gate compliance and SS crash gate enforcement. Backtest has not been independently audited.'
    ))

    build_doc('PNTHR_Performance_Summary.pdf',
              'Performance Summary', 'v1.0 - April 2026 - HYPOTHETICAL BACKTEST', s)


# ═══════════════════════════════════════════════════════════════════════════════
# 5. DUE DILIGENCE QUESTIONNAIRE (DDQ)
# ═══════════════════════════════════════════════════════════════════════════════

def gen_ddq():
    s = []

    s += section('I. Organization & Structure')
    qa = [
        ('Fund Name', 'PNTHR Funds, Carnivore Quant Fund, LP'),
        ('General Partner', 'PNTHR Funds, LLC'),
        ('Investment Manager', 'STT Capital Advisors, LLC'),
        ('Domicile', 'Delaware Limited Partnership'),
        ('Fund Inception', 'Q3 2026 (targeting)'),
        ('Strategy', 'Systematic Long/Short U.S. Equity'),
        ('Offering Type', 'Regulation D, Rule 506(c) - Accredited Investors and Qualified Clients'),
        ('Auditor', 'Spicer Jeffries, LLP (intended, upon admission of Limited Partners)'),
        ('Fund Administrator', 'NAV Consulting, Inc. (engaged)'),
        ('Legal Counsel', 'David S. Hunt, P.C. (engaged)'),
        ('Prime Broker / Custodian', 'Interactive Brokers LLC'),
        ('Bank', 'Axos Bank'),
    ]
    s.append(bold_table(
        ['Item', 'Detail'],
        [[q, a] for q, a in qa],
        col_widths=[2.2*inch, CONTENT_W - 2.2*inch]
    ))

    s += section('II. Key Personnel')
    s.append(bold_table(
        ['Name', 'Title', 'Experience'],
        [
            ['Scott McBrien', 'Managing Member, CIO & CCO',
             'Decades of experience in equities, futures, and quantitative strategies; '
             'Series 7, 63, and 3 SEC/FINRA licenses; Head of Trading (Chicago); '
             'authored The Sigma Investor (Amazon #1 New Release); '
             'designed and built the entire PNTHR Signal System; '
             'featured in CNN, Business Insider, U.S. News & World Report, The Business Journals'],
            ['Cindy Eagar', 'COO & CISO',
             'Nearly 20 years in executive leadership and operations; '
             'helped scale Keap (Infusionsoft) from $10M to $100M in revenue; '
             'built all fund operational infrastructure, compliance framework, and investor data room; '
             'co-developed the PNTHR Signal System; '
             'featured in Business Insider, U.S. News & World Report, The Business Journals'],
        ],
        col_widths=[1.2*inch, 1.5*inch, CONTENT_W - 2.7*inch]
    ))

    s += section('III. Investment Strategy')
    qa = [
        ('Strategy Description',
         'Systematic long/short equity strategy using the proprietary PNTHR Signal System. '
         'Generates PNTHR Proprietary Buy Long (BL) and Sell Short (SS) signals based on '
         'sector-specific optimized EMA dynamics, then ranks opportunities through an 8-dimension '
         'scoring framework (Kill Score). Positions are entered via a 5-lot pyramid structure '
         'with the Proprietary PNTHR Stop Loss System (PPSLC).'),
        ('Investment Universe', 'PNTHR 679 - curated universe of 679 high-liquidity U.S. equities and sector ETFs'),
        ('Position Holding Period', 'Swing (typically 4-6 weeks; 20-day stale hunt limit)'),
        ('Long/Short Allocation', 'Dynamic based on regime and signal availability; historically ~94% BL / ~6% SS by trade count'),
        ('Use of Leverage', 'The Fund may employ leverage of up to 2:1 gross exposure.'),
        ('Use of Derivatives', 'None. The Fund trades common equity and ETFs only.'),
    ]
    s.append(bold_table(
        ['Question', 'Answer'],
        [[q, a] for q, a in qa],
        col_widths=[2.0*inch, CONTENT_W - 2.0*inch]
    ))

    s += section('IV. Risk Management')
    qa = [
        ('Position Sizing', '0.5%-2.0% of NAV per full position (1.0% standard for equities, 0.5% for ETFs)'),
        ('Stop Loss Methodology', 'Proprietary PNTHR Stop Loss System (PPSLC); stops never loosen; ratchet on pyramid lot fills'),
        ('Max Drawdown Controls', 'Portfolio heat caps: 10% long, 5% short, 15% total'),
        ('Sector Limits', '3 positions net directional exposure per sector'),
        ('Automated Alerts', 'FEAST (RSI > 85), Stale Hunt (20-day), Sector Concentration'),
        ('Pre-Trade Assessment', '100-point Analyze Score; minimum 55% required to proceed'),
    ]
    s.append(bold_table(
        ['Question', 'Answer'],
        [[q, a] for q, a in qa],
        col_widths=[2.0*inch, CONTENT_W - 2.0*inch]
    ))

    s += section('V. Fees & Terms')
    qa = [
        ('Management Fee', '2.0% per annum on NAV, accrued monthly, paid quarterly in advance'),
        ('Performance Allocation', '20-30% quarterly, non-cumulative (Wagyu 20%, Porterhouse 25%, Filet 30%)'),
        ('Hurdle Rate', 'US 2-Year Treasury yield, applied quarterly (annualized yield / 4)'),
        ('High Water Mark', 'Yes - running maximum of adjusted NAV per unit, with Loss Carryforward Provision'),
        ('Loyalty Discount', '5% reduction in performance allocation after 36 consecutive months'),
        ('Lock-Up Period', '1 year (25% early withdrawal penalty if redeemed during lock-up)'),
        ('Redemption', 'Quarterly with 60 days prior written notice; $25K minimum; $50K balance floor; 25% quarterly gate'),
        ('Minimum Investment', 'Filet: $100,000; Porterhouse: $500,000-$999,999; Wagyu: $1,000,000+'),
        ('Eligible Investors', 'Must be both Accredited Investors and Qualified Clients'),
    ]
    s.append(bold_table(
        ['Question', 'Answer'],
        [[q, a] for q, a in qa],
        col_widths=[2.0*inch, CONTENT_W - 2.0*inch]
    ))

    s += section('VI. Operations & Technology')
    qa = [
        ('Trading Platform', 'Interactive Brokers Trader Workstation (TWS) - automated sync via proprietary Python bridge'),
        ('Data Infrastructure', 'MongoDB Atlas (encrypted at rest, auto-replicated), Vercel (frontend), Render (backend)'),
        ('Market Data Provider', 'Financial Modeling Prep (FMP) API'),
        ('Security Controls', '2FA on all accounts, JWT authentication, role-based access control, encrypted data at rest'),
        ('Reporting Frequency', 'Monthly performance letters; quarterly detailed reports'),
        ('NAV Calculation', 'Real-time NAV from IBKR account sync; reconciled daily'),
    ]
    s.append(bold_table(
        ['Question', 'Answer'],
        [[q, a] for q, a in qa],
        col_widths=[2.0*inch, CONTENT_W - 2.0*inch]
    ))

    s += section('VII. Regulatory & Compliance')
    qa = [
        ('SEC Registration', 'Relying on private fund adviser exemption (sub-$150M AUM). '
         'Will file as Exempt Reporting Adviser (ERA) when required.'),
        ('Form D', 'To be filed upon acceptance of first LP capital'),
        ('Compliance Program', 'Written compliance manual, personal trading policy with pre-clearance, '
         'code of ethics, AML/KYC procedures'),
        ('Chief Compliance Officer', 'Scott McBrien, CIO & CCO'),
        ('Chief Information Security Officer', 'Cindy Eagar, COO & CISO'),
        ('Personal Trading Policy', 'Pre-clearance required; 7-day minimum holding period; '
         'no trading in Fund universe securities in personal accounts'),
        ('Insurance', 'E&O and D&O coverage to be obtained prior to Outside Capital'),
    ]
    s.append(bold_table(
        ['Question', 'Answer'],
        [[q, a] for q, a in qa],
        col_widths=[2.0*inch, CONTENT_W - 2.0*inch]
    ))

    s += section('VIII. Track Record')
    qa = [
        ('Track Record Type', 'Hypothetical - Systematic Backtest (January 2019 - April 2026)'),
        ('Total Trades', '2,507 pyramid entries (2,363 BL + 147 SS)'),
        ('Sharpe Ratio', '2.39'),
        ('Profit Factor', '9.10x'),
        ('CAGR (Net of Fees)', '37.0%'),
        ('Max Drawdown', '< 2%'),
        ('Data Integrity', 'Backtest internally validated v4.4.0: sector gate compliance enforced, '
         'SS crash gate added, all metrics recomputed from clean data. Not independently audited.'),
    ]
    s.append(bold_table(
        ['Question', 'Answer'],
        [[q, a] for q, a in qa],
        col_widths=[2.0*inch, CONTENT_W - 2.0*inch]
    ))
    s.append(Spacer(1, 8))
    s.append(note(
        'This DDQ is provided for informational purposes only. Please refer to the Private '
        'Placement Memorandum and Limited Partnership Agreement for complete terms. '
        'Hypothetical performance does not guarantee future results.'
    ))

    build_doc('PNTHR_Due_Diligence_Questionnaire.pdf',
              'Due Diligence Questionnaire', 'v1.0 - April 2026', s)


# ═══════════════════════════════════════════════════════════════════════════════
# 6. COMPLIANCE MANUAL & CODE OF ETHICS
# ═══════════════════════════════════════════════════════════════════════════════

def gen_compliance_manual():
    s = []

    s += section('I. Introduction & Purpose')
    s.append(body(
        'This Compliance Manual establishes the policies, procedures, and ethical standards '
        'governing the operations of STT Capital Advisors, LLC (the \"Manager\") and Carnivore '
        'Quant Fund, LP (the \"Fund\"). All supervised persons are required to read, understand, '
        'and comply with these policies. The Chief Compliance Officer (CCO) is responsible for '
        'administering and enforcing this manual.'
    ))
    s.append(body(
        '<b>Chief Compliance Officer:</b> Scott McBrien, CIO & CCO<br/>'
        '<b>CCO Designee / CISO:</b> Cindy Eagar, COO & CISO<br/>'
        '<b>Effective Date:</b> April 2026<br/>'
        '<b>Review Frequency:</b> Annually, or upon material regulatory changes'
    ))

    s += section('II. Code of Ethics')
    s += subsection('Fiduciary Duty')
    s.append(body(
        'All supervised persons owe a fiduciary duty to the Fund and its Limited Partners. '
        'This includes the duty of loyalty (placing Fund interests above personal interests) '
        'and the duty of care (acting with the skill, prudence, and diligence of a reasonable '
        'professional under the circumstances).'
    ))
    s += subsection('Standards of Conduct')
    s.append(bullet('Act with integrity, competence, and respect for Fund investors'))
    s.append(bullet('Place Fund interests ahead of personal interests'))
    s.append(bullet('Maintain independence and objectivity in investment decisions'))
    s.append(bullet('Preserve confidentiality of Fund and investor information'))
    s.append(bullet('Comply with all applicable securities laws and regulations'))
    s.append(bullet('Report any violations or suspected violations to the CCO immediately'))

    s += section('III. Personal Trading Policy')
    s += subsection('Pre-Clearance Requirement')
    s.append(body(
        'All personal securities trades by supervised persons must be <b>pre-cleared by the CCO</b> '
        'before execution. Pre-clearance requests must include the security name, direction '
        '(buy/sell), approximate quantity, and rationale.'
    ))
    s += subsection('Restrictions')
    s.append(bullet('<b>7-day minimum holding period</b> for all personal trades'))
    s.append(bullet('<b>No trading in Fund universe securities</b> (PNTHR 679) in personal accounts'))
    s.append(bullet('No front-running: personal trades may not precede anticipated Fund trades'))
    s.append(bullet('No short-term trading that conflicts with Fund positions'))
    s.append(bullet('All personal brokerage account statements must be provided to the CCO quarterly'))
    s += subsection('Reporting')
    s.append(body(
        'All supervised persons must submit:<br/>'
        '<b>Initial Holdings Report:</b> Within 10 days of becoming a supervised person<br/>'
        '<b>Annual Holdings Report:</b> Within 45 days of fiscal year end<br/>'
        '<b>Quarterly Transaction Report:</b> Within 30 days of quarter end'
    ))

    s += section('IV. Insider Trading Policy')
    s.append(body(
        'Trading on Material Non-Public Information (MNPI) is strictly prohibited. '
        'No supervised person may:'
    ))
    s.append(bullet('Trade securities while in possession of MNPI'))
    s.append(bullet('Communicate MNPI to any person who might trade on it (\"tipping\")'))
    s.append(bullet('Recommend securities transactions based on MNPI'))
    s.append(Spacer(1, 4))
    s.append(body(
        'If any supervised person becomes aware of potential MNPI, they must immediately '
        'notify the CCO and refrain from any related trading until the information is either '
        'publicly disclosed or determined not to be material.'
    ))

    s += section('V. Allocation & Best Execution')
    s.append(body(
        'The Fund currently manages a single portfolio. Should additional accounts or funds '
        'be managed in the future, a formal trade allocation policy will be adopted to ensure '
        'fair and equitable treatment of all client accounts. Best execution is pursued through '
        'Interactive Brokers\' SmartRouting technology.'
    ))

    s += section('VI. Gift & Entertainment Policy')
    s.append(body(
        'Supervised persons may not accept gifts or entertainment from any person or entity '
        'doing business with the Fund that exceeds <b>$250 in value per person per year</b>. '
        'All gifts or entertainment received must be reported to the CCO within 5 business days. '
        'Gifts that exceed the threshold must be returned or donated.'
    ))

    s += section('VII. Confidentiality')
    s.append(body(
        'All Fund-related information is confidential, including but not limited to: '
        'trading strategies, positions, investor identities, performance data, and proprietary '
        'algorithms (including the PNTHR Signal System). Disclosure of confidential information '
        'is permitted only with prior written authorization from the Managing Member or as '
        'required by law.'
    ))

    s += section('VIII. Record Retention')
    s.append(body(
        'The Manager will maintain books and records as required by applicable regulations. '
        'All compliance records, including personal trading reports, pre-clearance logs, and '
        'policy acknowledgments, will be retained for a minimum of <b>5 years</b>.'
    ))

    s += section('IX. Reporting Violations')
    s.append(body(
        'Any supervised person who becomes aware of a violation or potential violation of this '
        'manual, applicable laws, or Fund policies must report it to the CCO immediately. '
        'The Manager prohibits retaliation against any person who reports a violation in good faith.'
    ))

    s += section('X. Annual Acknowledgment')
    s.append(body(
        'All supervised persons must sign an acknowledgment confirming they have read, '
        'understood, and agree to comply with this Compliance Manual and Code of Ethics. '
        'Acknowledgments must be renewed annually.'
    ))

    build_doc('PNTHR_Compliance_Manual.pdf',
              'Compliance Manual & Code of Ethics', 'v1.0 - April 2026', s)


# ═══════════════════════════════════════════════════════════════════════════════
# 7. AML/KYC POLICY
# ═══════════════════════════════════════════════════════════════════════════════

def gen_aml_kyc():
    s = []

    s += section('I. Purpose & Scope')
    s.append(body(
        'This Anti-Money Laundering (AML) and Know Your Customer (KYC) Policy establishes '
        'the procedures STT Capital Advisors, LLC (the \"Manager\") employs to detect and '
        'prevent money laundering, terrorist financing, and other financial crimes. This policy '
        'applies to all investor onboarding, ongoing monitoring, and suspicious activity reporting.'
    ))

    s += section('II. AML Compliance Officer')
    s.append(body(
        '<b>AML Compliance Officer:</b> Scott McBrien, CIO & CCO<br/>'
        '<b>AML Designee / CISO:</b> Cindy Eagar, COO & CISO<br/>'
        '<b>Responsibilities:</b> Overseeing the AML program, reviewing KYC documentation, '
        'filing Suspicious Activity Reports (SARs) when required, conducting annual AML training, '
        'and maintaining AML records.'
    ))

    s += section('III. Customer Identification Program (CIP)')
    s.append(body('For each prospective Limited Partner, the Manager will collect and verify:'))
    s += subsection('Individual Investors')
    s.append(bullet('Full legal name'))
    s.append(bullet('Date of birth'))
    s.append(bullet('Current residential address'))
    s.append(bullet('Government-issued photo identification (passport or driver\'s license)'))
    s.append(bullet('Social Security Number or Tax Identification Number'))
    s += subsection('Entity Investors')
    s.append(bullet('Legal entity name and formation documents'))
    s.append(bullet('Principal place of business'))
    s.append(bullet('Taxpayer Identification Number (EIN)'))
    s.append(bullet('Identity of beneficial owners (25%+ ownership)'))
    s.append(bullet('Identity of authorized signatories'))
    s.append(bullet('Certificate of good standing or equivalent'))

    s += section('IV. Accredited Investor Verification')
    s.append(body(
        'As a Rule 506(c) offering, the Fund is required to take <b>reasonable steps to verify</b> '
        'that each investor qualifies as an accredited investor. Acceptable verification methods include:'
    ))
    s.append(bullet('Review of tax returns, W-2s, or other IRS filings (income-based)'))
    s.append(bullet('Review of bank, brokerage, or other asset statements (net worth-based)'))
    s.append(bullet('Written confirmation from a registered broker-dealer, SEC-registered investment '
                    'adviser, licensed attorney, or CPA'))
    s.append(bullet('Existing investor certification (for subsequent investments within 3 months)'))

    s += section('V. Source of Funds Documentation')
    s.append(body(
        'All investors must provide documentation evidencing the <b>source of funds</b> being '
        'invested. Acceptable documentation includes:'
    ))
    s.append(bullet('Bank statements showing available funds'))
    s.append(bullet('Brokerage account statements'))
    s.append(bullet('Documentation of asset sale or inheritance'))
    s.append(bullet('Employment income verification'))

    s += section('VI. Politically Exposed Persons (PEP) Screening')
    s.append(body(
        'All prospective investors will be screened against PEP databases and sanctions lists, '
        'including:'
    ))
    s.append(bullet('OFAC Specially Designated Nationals (SDN) List'))
    s.append(bullet('United Nations Security Council Sanctions List'))
    s.append(bullet('European Union sanctions lists'))
    s.append(bullet('PEP databases (current and former government officials, family members, '
                    'and close associates)'))
    s.append(Spacer(1, 4))
    s.append(body(
        'Enhanced due diligence will be conducted for any investor identified as a PEP, '
        'including additional documentation of source of wealth and senior management approval '
        'before acceptance.'
    ))

    s += section('VII. Ongoing Monitoring')
    s.append(body(
        'The Manager will conduct ongoing monitoring of investor activity and will investigate '
        'any unusual or suspicious transactions. Red flags include:'
    ))
    s.append(bullet('Unusual or unexplained large transactions'))
    s.append(bullet('Transactions inconsistent with the investor\'s stated financial profile'))
    s.append(bullet('Requests for unusual payment methods or third-party transfers'))
    s.append(bullet('Reluctance to provide required documentation'))
    s.append(bullet('Adverse media or sanctions list matches'))

    s += section('VIII. Suspicious Activity Reporting')
    s.append(body(
        'If suspicious activity is identified, the AML Compliance Officer will file a Suspicious '
        'Activity Report (SAR) with the Financial Crimes Enforcement Network (FinCEN) within '
        '30 calendar days. No supervised person may notify the investor that a SAR has been filed.'
    ))

    s += section('IX. Record Retention')
    s.append(body(
        'All KYC documentation, CIP records, and AML-related records will be maintained for '
        'a minimum of <b>5 years</b> from the date the investor\'s account is closed or the '
        'investor\'s relationship with the Fund terminates.'
    ))

    s += section('X. Training')
    s.append(body(
        'All supervised persons will receive AML training upon hire and annually thereafter. '
        'Training covers recognition of suspicious activity, reporting obligations, and updates '
        'to AML regulations.'
    ))

    s += section('XI. Third-Party Providers')
    s.append(body(
        'The Manager currently performs KYC procedures manually. As the Fund scales, the Manager '
        'intends to engage a third-party KYC/AML provider for automated identity verification, '
        'sanctions screening, and ongoing monitoring. Any third-party provider will be subject '
        'to due diligence and ongoing oversight by the AML Compliance Officer.'
    ))

    build_doc('PNTHR_AML_KYC_Policy.pdf',
              'Anti-Money Laundering & KYC Policy', 'v1.0 - April 2026', s)


# ═══════════════════════════════════════════════════════════════════════════════
# 8. BUSINESS CONTINUITY PLAN (BCP)
# ═══════════════════════════════════════════════════════════════════════════════

def gen_bcp():
    s = []

    s += section('I. Purpose')
    s.append(body(
        'This Business Continuity Plan (BCP) establishes the procedures STT Capital Advisors, LLC '
        'will follow to maintain critical business operations in the event of a significant '
        'disruption, including natural disasters, pandemics, technology failures, and key '
        'personnel incapacitation. The goal is to minimize disruption to Fund operations and '
        'protect investor capital at all times.'
    ))

    s += section('II. Key Personnel & Succession')
    s.append(bold_table(
        ['Role', 'Primary', 'Backup', 'Responsibility'],
        [
            ['CIO / CCO', 'Scott McBrien', 'Cindy Eagar (liquidation authority)',
             'Investment decisions, signal system management, trade execution, compliance oversight'],
            ['COO / CISO', 'Cindy Eagar', 'Scott McBrien',
             'Operations, information security, investor relations, fund administration'],
        ],
        col_widths=[1.3*inch, 1.3*inch, 1.6*inch, CONTENT_W - 4.2*inch]
    ))
    s.append(Spacer(1, 6))
    s += subsection('Key Person Contingency')
    s.append(body(
        'In the event that Scott McBrien is incapacitated and unable to manage the portfolio:'
    ))
    s.append(bullet('Cindy Eagar is authorized to execute the <b>Liquidation Protocol</b> - '
                    'an orderly unwinding of all open positions using the Proprietary PNTHR Stop Loss System (PPSLC)'))
    s.append(bullet('All pending orders will be cancelled immediately'))
    s.append(bullet('No new positions will be opened'))
    s.append(bullet('Investors will be notified within 24 hours'))
    s.append(bullet('If incapacitation exceeds 30 days, the Fund will initiate an orderly '
                    'wind-down as described in the Limited Partnership Agreement'))

    s += section('III. Technology Infrastructure')
    s += subsection('Data Backup & Recovery')
    s.append(bold_table(
        ['System', 'Provider', 'Backup Method', 'Recovery Time'],
        [
            ['Database', 'MongoDB Atlas', 'Auto-replicated across 3 nodes; continuous backup', '< 1 hour'],
            ['Application Code', 'GitHub', 'Full version history; all branches preserved', '< 30 minutes'],
            ['Frontend Hosting', 'Vercel', 'Auto-deployed from GitHub; CDN replicated globally', '< 5 minutes'],
            ['Backend Hosting', 'Render', 'Auto-deployed from GitHub; container-based', '< 15 minutes'],
            ['Market Data', 'FMP API', 'Candle cache in MongoDB (12-week age cap)', 'Immediate (cached)'],
        ],
        col_widths=[1.3*inch, 1.3*inch, 2.5*inch, CONTENT_W - 5.1*inch]
    ))
    s.append(Spacer(1, 6))
    s += subsection('Critical Vendor Dependencies')
    s.append(bold_table(
        ['Vendor', 'Function', 'Alternative / Mitigation'],
        [
            ['Interactive Brokers', 'Trade execution, custody, NAV sync',
             'Positions can be managed directly via TWS or IBKR mobile in emergency'],
            ['FMP API', 'Market data (price, EMA, RSI, volume)',
             'Candle cache provides 12 weeks of historical data; alternative data providers available'],
            ['MongoDB Atlas', 'All application data, signals, portfolio',
             'Triple-replicated; point-in-time recovery; local backup capability'],
            ['Vercel', 'Frontend hosting (React/Vite)',
             'Can be redeployed to any static host (Netlify, AWS S3) within 1 hour'],
            ['Render', 'Backend hosting (Node.js/Express)',
             'Can be redeployed to any Node.js host (Railway, Fly.io, AWS) within 1 hour'],
        ],
        col_widths=[1.3*inch, 1.8*inch, CONTENT_W - 3.1*inch]
    ))

    s += section('IV. Remote Operations')
    s.append(body(
        'STT Capital Advisors, LLC is a <b>fully remote-capable operation</b>. All critical '
        'systems are cloud-based and accessible from any location with internet connectivity. '
        'Both key personnel maintain:'
    ))
    s.append(bullet('Laptop with all necessary software pre-configured'))
    s.append(bullet('Mobile access to IBKR TWS for emergency trade management'))
    s.append(bullet('2FA-enabled access to all critical systems'))
    s.append(bullet('Encrypted communications (end-to-end) for sensitive discussions'))

    s += section('V. Communication Plan')
    s.append(body(
        'In the event of a significant disruption affecting Fund operations:'
    ))
    s.append(bold_table(
        ['Stakeholder', 'Notification Method', 'Timeline'],
        [
            ['Limited Partners', 'Email and phone', 'Within 24 hours'],
            ['Prime Broker (IBKR)', 'Platform notification + phone', 'Immediately'],
            ['Legal Counsel', 'Phone + email', 'Within 24 hours'],
            ['Regulators', 'As required by applicable regulation', 'Per regulatory requirement'],
        ],
        col_widths=[1.8*inch, 2.5*inch, CONTENT_W - 4.3*inch]
    ))

    s += section('VI. Cybersecurity')
    s.append(body('The Manager maintains the following security controls:'))
    s.append(bullet('<b>Two-Factor Authentication (2FA)</b> on all accounts (IBKR, MongoDB, GitHub, email)'))
    s.append(bullet('<b>Encryption at rest</b> for all database storage (MongoDB Atlas)'))
    s.append(bullet('<b>JWT-based authentication</b> with role-based access control for the PNTHR application'))
    s.append(bullet('<b>No shared passwords</b> - individual accounts for all systems'))
    s.append(bullet('<b>Regular security updates</b> applied to all hosting environments'))
    s.append(bullet('<b>API keys rotated</b> periodically and stored in environment variables (never in code)'))

    s += section('VII. Testing & Review')
    s.append(body(
        'This BCP will be reviewed and tested <b>annually</b> or upon any material change to '
        'the Manager\'s technology infrastructure, key personnel, or vendor relationships. '
        'Testing includes verification of backup recovery procedures, communication protocols, '
        'and emergency access to all critical systems.'
    ))

    build_doc('PNTHR_Business_Continuity_Plan.pdf',
              'Business Continuity Plan', 'v1.0 - April 2026', s)


# ═══════════════════════════════════════════════════════════════════════════════
# 9. KEY PERSONNEL BIOS
# ═══════════════════════════════════════════════════════════════════════════════

def gen_key_personnel():
    s = []

    s += section('Key Personnel')
    s.append(body(
        'STT Capital Advisors, LLC is led by a complementary team combining quantitative '
        'strategy development with institutional-grade operations. Together, they designed, '
        'built, and backtested the entire PNTHR Signal System and operational infrastructure.'
    ))

    s += section('Scott McBrien')
    s.append(Paragraph(
        '<b>Managing Member, Chief Investment Officer & Chief Compliance Officer</b>',
        S('Normal', fontSize=11, fontName='Helvetica-Bold', textColor=PNTHR_GRAY,
          spaceAfter=8, leading=15)
    ))

    # Try to include headshot
    scott_img = os.path.join(PUBLIC, 'Scott-PNTHR.jpg')
    if os.path.exists(scott_img):
        try:
            s.append(Image(scott_img, width=1.5*inch, height=1.5*inch))
            s.append(Spacer(1, 8))
        except Exception:
            pass

    s.append(body(
        'Scott McBrien is the Co-Founder and Managing Member of STT Capital Advisors, LLC, '
        'serving as Chief Investment Officer and Chief Compliance Officer for PNTHR Funds, '
        'Carnivore Quant Fund, LP. An accomplished investment professional with decades of '
        'experience in equities, futures, and quantitative investment strategies, Scott began '
        'his career in investment banking, holding Series 7, 63, and 3 SEC/FINRA licenses. '
        'He was offered a position as Head of Trading in Chicago, where he traded a range of '
        'futures contracts and developed a proprietary strategy that doubled the firm\u2019s '
        'account in profits within nine months.'
    ))
    s.append(body(
        'In 2025, Scott and his Co-Founder, Cindy Eagar, launched PNTHR FUNDS \u2014 The Carnivore '
        'Quant Fund, LP, a Regulation D, 506(c), 3(c)(1) long/short equity hedge fund open to '
        'Qualified Investors. Together they engineered the proprietary PNTHR Signal System from '
        'the ground up \u2014 including the signal detection algorithm, 8-dimension Kill scoring '
        'framework, pyramid entry system, Proprietary PNTHR Stop Loss System (PPSLC), and all '
        'risk management protocols. This technology now serves as the strategic engine behind '
        'the fund\u2019s performance.'
    ))
    s.append(body(
        'Scott authored <i>The Sigma Investor\u2122</i> (2024), which debuted as an Amazon #1 '
        'New Release. The book chronicles his contrarian investment philosophy and documents '
        'exceptional performance \u2014 even during the market downturn of 2022 \u2014 providing '
        'insights into navigating volatile environments.'
    ))
    s.append(body(
        'Scott\u2019s expertise has been recognized by major financial media outlets including '
        '<b>CNN</b>, <b>U.S. News &amp; World Report</b>, <b>The Business Journals</b>, and '
        '<b>Business Insider</b>. Business Insider, with over 200 million global readers, '
        'featured his timely short positions in banking stocks \u2014 executed weeks before the '
        'March 2023 collapse of Silicon Valley Bank \u2014 highlighting how his system helped '
        'protect investors from significant losses.'
    ))
    s.append(Spacer(1, 4))
    s.append(bold_table(
        ['', ''],
        [
            ['Licenses Held', 'Series 7, Series 63, Series 3 (SEC/FINRA)'],
            ['Career History', 'Stock & Futures Broker, Senior Technical Analyst, '
             'Head of Trading (Chicago), Futures Trader'],
            ['Published Work', 'The Sigma Investor\u2122 \u2014 Amazon #1 New Release (2024)'],
            ['Media & Press', 'CNN, U.S. News & World Report, The Business Journals, '
             'Business Insider, plus industry podcasts and publications'],
            ['Notable Achievement', 'Designed a system that backtested to a 2.39 Sharpe ratio and '
             '9.10x profit factor across 2,507 pyramid trades over 7+ years \u2014 encompassing both '
             'bull markets and major drawdowns (COVID crash, 2022 bear market)'],
        ],
        col_widths=[1.8*inch, CONTENT_W - 1.8*inch]
    ))

    s.append(PageBreak())

    s += section('Cindy Eagar')
    s.append(Paragraph(
        '<b>Chief Operating Officer & Chief Information Security Officer</b>',
        S('Normal', fontSize=11, fontName='Helvetica-Bold', textColor=PNTHR_GRAY,
          spaceAfter=8, leading=15)
    ))

    cindy_img = os.path.join(PUBLIC, 'cindy-pnthr-glow.png')
    if os.path.exists(cindy_img):
        try:
            s.append(Image(cindy_img, width=1.5*inch, height=1.5*inch))
            s.append(Spacer(1, 8))
        except Exception:
            pass

    s.append(body(
        'Cindy Eagar is the Co-Founder, Chief Operating Officer, and Chief Information Security '
        'Officer of STT Capital Advisors, LLC, and PNTHR FUNDS \u2014 a U.S.-based hedge fund '
        'serving family offices, high-net-worth, and ultra-high-net-worth investors seeking '
        'disciplined, asymmetric growth strategies. Drawing on nearly two decades in executive '
        'leadership and business growth, Cindy brings a unique perspective to capital management '
        'rooted in risk awareness, strategic positioning, and operational excellence.'
    ))
    s.append(body(
        'Before launching PNTHR FUNDS, Cindy played key executive roles in scaling '
        'venture-backed technology companies. Most notably, she helped SaaS leader '
        '<b>Keap</b> (formerly Infusionsoft) grow from $10M to $100M in revenue. She has also '
        'advised and built partnerships for numerous high-growth businesses, working closely '
        'with founders, operators, and investors to navigate complex growth stages.'
    ))
    s.append(body(
        'At PNTHR FUNDS, Cindy leads technology development, systems engineering, and data '
        'infrastructure. She co-developed the PNTHR Signal System and built all operational '
        'infrastructure for the Fund \u2014 including the investor data room, compliance framework, '
        'AML/KYC procedures, and investor relations processes. She and Co-Founder Scott McBrien '
        'focus on protecting the downside while positioning capital for significant upside through '
        'a disciplined, research-driven approach.'
    ))
    s.append(body(
        'Cindy\'s insights on investing, entrepreneurship, and business strategy have been '
        'featured in and quoted by <b>Business Insider</b>, <b>U.S. News &amp; World Report</b>, '
        '<b>The Business Journals</b>, and additional industry publications and podcasts.'
    ))
    s.append(Spacer(1, 4))
    s.append(bold_table(
        ['', ''],
        [
            ['Operations Experience', 'Nearly 20 years in executive leadership, project management, '
             'and operations across technology and financial services'],
            ['Key Prior Role', 'Executive at Keap (Infusionsoft) \u2014 helped scale from '
             '$10M to $100M in revenue'],
            ['Fund Operations', '3 years building fund operations, compliance infrastructure, '
             'and investor relations for Carnivore Quant Fund'],
            ['Media & Press', 'Business Insider, U.S. News & World Report, The Business Journals, '
             'plus industry podcasts and publications'],
            ['Responsibilities', 'Fund operations, information security, technology development, '
             'investor onboarding, data room management, reporting'],
            ['Notable Achievement', 'Built the complete operational and compliance framework '
             'for an emerging hedge fund \u2014 from partnership agreements to data room to '
             'investor communications \u2014 establishing institutional-grade infrastructure '
             'prior to accepting outside capital'],
        ],
        col_widths=[1.8*inch, CONTENT_W - 1.8*inch]
    ))

    build_doc('PNTHR_Key_Personnel.pdf',
              'Key Personnel', 'v1.0 - April 2026', s)


# ═══════════════════════════════════════════════════════════════════════════════
# 10. SERVICE PROVIDER SUMMARY
# ═══════════════════════════════════════════════════════════════════════════════

def gen_service_providers():
    s = []

    s += section('Service Provider Summary')
    s.append(body(
        'The following service providers support the operations of Carnivore Quant Fund, LP. '
        'As the Fund scales, additional providers will be engaged to meet institutional '
        'requirements. All service provider relationships are reviewed annually.'
    ))

    s += section('Current Service Providers')
    s.append(bold_table(
        ['Function', 'Provider', 'Status', 'Details'],
        [
            ['Prime Broker / Custodian', 'Interactive Brokers LLC', 'Active',
             'Trade execution, custody, real-time NAV sync via proprietary Python bridge (TWS API)'],
            ['Banking', 'Axos Bank', 'Active',
             'Fund operating account'],
            ['Database / Cloud', 'MongoDB Atlas', 'Active',
             'Primary data store; encrypted at rest; auto-replicated; continuous backup'],
            ['Frontend Hosting', 'Vercel', 'Active',
             'React/Vite application hosting with global CDN'],
            ['Backend Hosting', 'Render', 'Active',
             'Node.js/Express API server with auto-deploy from GitHub'],
            ['Market Data', 'Financial Modeling Prep (FMP)', 'Active',
             'Price data, fundamentals, technical indicators for PNTHR 679 universe'],
            ['Version Control', 'GitHub', 'Active',
             'Source code management, deployment pipeline integration'],
        ],
        col_widths=[1.3*inch, 1.5*inch, 0.8*inch, CONTENT_W - 3.6*inch]
    ))

    s += section('Engaged Service Providers')
    s.append(bold_table(
        ['Function', 'Provider', 'Status', 'Details'],
        [
            ['Legal Counsel', 'David S. Hunt, P.C.', 'Engaged',
             'Partnership, investment manager, and GP counsel; 66 Exchange Place, Suite 201, Salt Lake City, UT 84111'],
            ['Fund Administrator', 'NAV Consulting, Inc.', 'Engaged',
             'NAV calculation, accounting, subscriptions/redemptions, AML functions; 1 Trans Am Plaza Dr, Suite 400, Oakbrook Terrace, IL 60181'],
            ['Independent Auditor', 'Spicer Jeffries, LLP', 'Intended',
             'Annual financial statement audit per U.S. GAAP; upon admission of non-affiliated LPs; 4601 DTC Blvd, Suite 700, Denver, CO 80237'],
        ],
        col_widths=[1.3*inch, 1.5*inch, 0.8*inch, CONTENT_W - 3.6*inch]
    ))

    s += section('Planned Service Providers')
    s.append(bold_table(
        ['Function', 'Target Provider', 'Engagement Trigger', 'Purpose'],
        [
            ['Insurance (E&O / D&O)', 'TBD', 'Prior to Outside Capital',
             'Errors & omissions, directors & officers liability coverage'],
            ['Tax Advisers', 'TBD', 'Prior to Outside Capital',
             'Annual Schedule K-1 preparation, Fund-level tax compliance'],
            ['KYC/AML Provider', 'TBD', 'At scale',
             'Automated identity verification, sanctions screening, PEP monitoring'],
        ],
        col_widths=[1.3*inch, 1.5*inch, 1.3*inch, CONTENT_W - 4.1*inch]
    ))

    s += section('Technology Architecture')
    s.append(body(
        'The Fund\'s technology stack is designed for reliability, security, and rapid recovery:'
    ))
    s.append(bold_table(
        ['Layer', 'Technology', 'Provider', 'Security'],
        [
            ['Frontend', 'React + Vite', 'Vercel', 'HTTPS, CDN, auto-deploy'],
            ['Backend', 'Node.js + Express', 'Render', 'JWT auth, RBAC, 2FA'],
            ['Database', 'MongoDB', 'Atlas (AWS)', 'Encrypted at rest, 3-node replica'],
            ['Execution', 'TWS API', 'Interactive Brokers', 'Socket API, 2FA, account segregation'],
            ['Market Data', 'REST API', 'FMP', 'API key auth, rate limiting, candle cache'],
        ],
        col_widths=[1.2*inch, 1.5*inch, 1.3*inch, CONTENT_W - 4.0*inch]
    ))

    build_doc('PNTHR_Service_Provider_Summary.pdf',
              'Service Provider Summary', 'v1.0 - April 2026', s)


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    print('Generating PNTHR Data Room documents...\n')

    generators = [
        ('1/10  Risk Management Framework', gen_risk_management),
        ('2/10  Fee Schedule Summary', gen_fee_schedule),
        ('3/10  Investment Process Overview', gen_investment_process),
        ('4/10  Performance Summary', gen_performance_summary),
        ('5/10  Due Diligence Questionnaire', gen_ddq),
        ('6/10  Compliance Manual & Code of Ethics', gen_compliance_manual),
        ('7/10  AML/KYC Policy', gen_aml_kyc),
        ('8/10  Business Continuity Plan', gen_bcp),
        ('9/10  Key Personnel Bios', gen_key_personnel),
        ('10/10 Service Provider Summary', gen_service_providers),
    ]

    for label, fn in generators:
        print(f'{label}...')
        try:
            fn()
        except Exception as e:
            print(f'  !! ERROR: {e}')

    print(f'\nDone - {len(generators)} documents generated in {OUT_DIR}')
