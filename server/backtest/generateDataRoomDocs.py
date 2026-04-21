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
            'CONFIDENTIAL: FOR ACCREDITED INVESTOR / QUALIFIED CLIENT USE ONLY',
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
        'Initial entry deploys only <b>35% of the full position</b>. Subsequent lots are earned '
        'through sequential confirmation, each lot requiring the prior lot to be filled, a time '
        'gate to be cleared, and a price trigger to be reached. Maximum capital is only deployed '
        'when the market has confirmed the trade multiple times.'
    ))
    s.append(bold_table(
        ['Lot', 'Name', 'Alloc', 'Trigger', 'Gate', 'Purpose'],
        [
            ['Lot 1', 'The Scent',   '35%', 'Signal entry',                 'None',           'Initial position; market must confirm'],
            ['Lot 2', 'The Stalk',   '25%', 'Price confirmation + time',    '5 trading days', 'Largest add; time + price both required'],
            ['Lot 3', 'The Strike',  '20%', 'Price confirmation',           'Lot 2 filled',   'Momentum continuation confirmed'],
            ['Lot 4', 'The Jugular', '12%', 'Price confirmation',           'Lot 3 filled',   'Trend extension'],
            ['Lot 5', 'The Kill',    '8%',  'Price confirmation',           'Lot 4 filled',   'Maximum conviction; full position'],
        ],
        col_widths=[0.6*inch, 0.85*inch, 0.55*inch, 1.2*inch, 1.0*inch, CONTENT_W - 4.2*inch]
    ))
    s.append(note(
        'Specific price thresholds at which Lots 2 through 5 trigger are proprietary and are '
        'not disclosed.'
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

    s += section('Sector Concentration: Advisory Framework')
    s.append(body(
        'The Fund does <b>not</b> enforce a fixed sector concentration cap. The Strategy may '
        'concentrate in a single sector when trend and macro conditions favor it. Prior backtesting '
        'demonstrated that eliminating a hard position cap produced superior risk-adjusted returns. '
        'Primary capital protection is provided by: the 1% vitality cap per position, portfolio heat '
        'caps (10% long / 5% short / 15% total), the PNTHR Proprietary Stop Loss System (PPSLS), '
        'the 20-day stale-position exit, and the FEAST momentum-exhaustion alert.'
    ))
    s.append(body(
        'The Risk Advisor emits an <b>advisory warning</b> at elevated net directional exposure '
        '(3 or more positions same direction in a sector). The warning is informational only and '
        'does <b>not</b> block trade entry. Two optional rebalancing paths are suggested:'
    ))
    s.append(bullet('<b>Option A:</b> Close the weakest position (by Kill score) in the concentrated sector'))
    s.append(bullet('<b>Option B:</b> Add an opposite-direction position using top Kill candidates to balance exposure'))
    s.append(body(
        'ETFs are exempt from the concentration calculation (they are diversification instruments).'
    ))

    s += section('Stop Loss System: PNTHR Proprietary Stop Loss System (PPSLS)')
    s.append(body(
        'All positions are protected by the <b>PPSLS</b>, a proprietary stop loss calculation that '
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
            ['PNTHR PPSLS Stop Hit', 'Ratchet stop hit', '10/12'],
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

    s += section('Macro &amp; Sector Gates')
    s.append(body(
        'The orders pipeline applies four sequential gates before any position can be opened. '
        'A candidate must pass all gates or the trade is rejected for that week.'
    ))
    s.append(bullet('<b>Direction Index Gate:</b> the stock&rsquo;s applicable index is determined by '
        'its actual historical membership (S&amp;P 500 member uses SPY; Nasdaq-100-only member uses QQQ; '
        'S&amp;P MidCap 400 member uses MDY; fallback SPY). The index&rsquo;s close must align with the '
        'trade direction relative to its weekly trend-filter.'))
    s.append(bullet('<b>Sector ETF Gate:</b> the stock&rsquo;s sector ETF (XLK, XLE, XLV, XLF, XLY, '
        'XLC, XLI, XLB, XLRE, XLU, XLP) is evaluated against a sector-specific trend-filter period, '
        'empirically optimized per sector. Specific periods are proprietary. BL candidate passes if '
        'the sector ETF is above its filter; SS candidate passes if below.'))
    s.append(bullet('<b>D2 Gate:</b> the stock&rsquo;s multi-dimensional Kill score D2 component '
        '(sector directional return) must be non-negative.'))
    s.append(bullet('<b>SS Crash Gate:</b> short candidates only. Requires dual confirmation of '
        'sustained bearish direction-index momentum and pronounced recent sector weakness. Specific '
        'thresholds are proprietary. Gate intentionally restrictive to limit short exposure to '
        'market-stress regimes.'))

    s += section('Worst-Case Validation (MAE Analysis)')
    s.append(body(
        'The maximum adverse excursion (MAE) across all <b>2,614 closed pyramid trades</b> (Wagyu '
        'tier) was <b>-15.2%</b> on a single trade (ON, March 2021). Average MAE across all closed '
        'trades was <b>-1.07%</b>. At Lot 1 NAV-scaled sizing (35% of 1% vitality), the worst-case '
        'single-trade loss translated to approximately <b>0.5% of portfolio NAV</b>.'
    ))
    s.append(body(
        'Even during the months when worst-case MAE trades occurred, the portfolio remained profitable '
        'on a net basis. The 1% vitality cap and 35% initial lot sizing ensure that no single adverse '
        'trade can materially impair investor capital. No historical backtest period resulted in '
        'permanent capital loss on a full-position basis.'
    ))

    build_doc('PNTHR_Risk_Management_Framework.pdf',
              'Risk Management Framework', 'v1.3 - April 2026', s)


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
        'If a Limited Partner\'s capital account has a net loss in any calendar quarter, the '
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
        'Quarterly, as of the last day of each calendar quarter, upon at least <b>sixty (60) days\' '
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
              'Fee Schedule Summary', 'v1.1 - April 2026', s)


# ═══════════════════════════════════════════════════════════════════════════════
# 3. INVESTMENT PROCESS OVERVIEW
# ═══════════════════════════════════════════════════════════════════════════════

def gen_investment_process():
    s = []
    s += section('Strategy Overview')
    s.append(body(
        'Carnivore Quant Fund employs a <b>proprietary systematic long/short equity strategy</b> '
        'built on the PNTHR Signal System. The Fund identifies high-conviction entry points '
        'using a multi-dimensional scoring framework, enters positions through a disciplined '
        'five-lot pyramid structure, and manages risk via the PNTHR Proprietary Stop Loss System '
        '(PPSLS) and portfolio-level controls. The strategy is designed to generate alpha through '
        'both long (BL) and short (SS) signals, with a structural long bias reflecting the '
        'long-term upward drift of U.S. equity markets.'
    ))

    s += section('The PNTHR 679 Universe')
    s.append(body(
        'Every week the system scans approximately <b>679 premier U.S. equities</b> drawn from '
        'the S&amp;P 500, Nasdaq 100, Dow 30, and select high-liquidity S&amp;P MidCap 400 '
        'constituents. The universe was selected for liquidity, coverage across all 11 GICS sectors, '
        'and representation across large-cap and mid-cap market cap ranges. ETFs (sector SPDRs and '
        'major index funds) are included for macro and sector exposure.'
    ))

    s += section('PNTHR Proprietary Buy Long Signal (BL)')
    s.append(body(
        'A BL signal is generated when the following conditions are simultaneously true. Specific '
        'thresholds, lookback periods, and parameter values are proprietary and not disclosed:'
    ))
    s.append(bullet('Weekly close above the stock&rsquo;s sector-specific optimized exponential moving average (EMA)'))
    s.append(bullet('Sector EMA slope is positive, confirming the underlying trend is genuine'))
    s.append(bullet('Structural breakout confirmation on the weekly bar'))
    s.append(bullet('Sufficient separation ("daylight") between weekly bar and EMA to filter false breakouts'))

    s += section('PNTHR Proprietary Sell Short Signal (SS)')
    s.append(body(
        'An SS signal is generated when the following conditions are simultaneously true:'
    ))
    s.append(bullet('Weekly close below the stock&rsquo;s sector-specific optimized EMA'))
    s.append(bullet('Sector EMA slope is negative, confirming the underlying downtrend is genuine'))
    s.append(bullet('Structural breakdown confirmation on the weekly bar'))
    s.append(bullet('Sufficient separation between weekly bar and EMA to filter false breakdowns'))
    s.append(Spacer(1, 4))
    s.append(body(
        'Additionally, SS signals require the <b>PNTHR SS Crash Gate</b> to be satisfied: the '
        'applicable macro index must show confirmed downward slope persistence AND the stock&rsquo;s '
        'sector must show pronounced short-term weakness. This gate is deliberately restrictive '
        'to limit short exposure to market-stress regimes. Exact slope and sector-weakness '
        'thresholds are proprietary.'
    ))

    s += section('Orders Pipeline Gates')
    s.append(body(
        'Before any BL or SS candidate becomes a trade, it must pass four sequential gates. '
        'The orders pipeline applies these gates in order and rejects any candidate failing '
        'any gate.'
    ))
    s.append(bullet(
        '<b>Direction Index Gate:</b> the stock&rsquo;s applicable index is determined by its '
        'actual historical membership (S&amp;P 500 member uses SPY; Nasdaq-100-only member uses '
        'QQQ; S&amp;P MidCap 400 member uses MDY; non-index fallback uses SPY). The index&rsquo;s '
        'weekly close vs its 21-week EMA must align with the candidate&rsquo;s direction (index '
        'above EMA for BL; index below EMA for SS).'
    ))
    s.append(bullet(
        '<b>Sector ETF Gate:</b> the stock&rsquo;s sector ETF (XLK, XLE, XLV, XLF, XLY, XLC, '
        'XLI, XLB, XLRE, XLU, XLP) must be positioned correctly against its sector-specific '
        'trend-filter period. Specific periods are empirically optimized per sector and are '
        'proprietary.'
    ))
    s.append(bullet(
        '<b>Sector Return Gate (D2):</b> the stock&rsquo;s sector directional return component '
        'of the Kill score must be non-negative.'
    ))
    s.append(bullet(
        '<b>SS Crash Gate:</b> (SS candidates only) the restrictive short-entry gate described '
        'above.'
    ))
    s.append(Spacer(1, 4))
    s.append(body(
        'Candidates surviving the gates are ranked by Kill score. The top 10 BL and top 5 SS '
        'candidates by score are selected each week.'
    ))

    s += section('The PNTHR Kill Scoring Engine')
    s.append(body(
        'The PNTHR Kill Scoring Engine is the intellectual core of the strategy: <b>approximately '
        'seven years of historical research and out-of-sample validation</b> distilled into a '
        'multi-dimensional scoring framework that transforms the PNTHR 679 universe into a '
        'precision-ranked list each week. The system does not guess; it measures, confirms, and '
        'ranks systematically.'
    ))
    s.append(body(
        'The Kill score integrates the following categories of measurement (exact weights, '
        'formulas, and parameter values are proprietary):'
    ))
    s.append(bullet('<b>Market regime:</b> index-level direction and slope, with bear-regime amplification of short signals and bull-regime amplification of long signals'))
    s.append(bullet('<b>Sector alignment:</b> short-term and medium-term directional returns of the stock&rsquo;s sector ETF'))
    s.append(bullet('<b>Entry quality:</b> technical characteristics of the signal-week weekly bar (close conviction, slope, separation)'))
    s.append(bullet('<b>Signal freshness:</b> how recently the signal was generated, with decay for aging signals'))
    s.append(bullet('<b>Rank dynamics:</b> week-over-week ranking improvement and rate of acceleration'))
    s.append(bullet('<b>Momentum confirmation:</b> multi-oscillator technical momentum (RSI, OBV, ADX, volume)'))
    s.append(bullet('<b>Multi-strategy convergence:</b> independent confirmation from the PNTHR Prey strategy overlay'))
    s.append(Spacer(1, 4))
    s.append(body(
        'The Kill score produces tiered categorization (ALPHA PNTHR KILL, STRIKING, HUNTING, '
        'POUNCING, COILING, STALKING, TRACKING, PROWLING, STIRRING, DORMANT, OVEREXTENDED) '
        'used by the Analyze pre-trade scoring system and the orders pipeline. Tier thresholds '
        'and scoring ranges are proprietary.'
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
            ['Lot 1', 'The Scent',   '35%', 'Signal entry',              'None',           'Initial position; market must confirm'],
            ['Lot 2', 'The Stalk',   '25%', 'Price confirmation + time', '5 trading days', 'Largest add; time + price both required'],
            ['Lot 3', 'The Strike',  '20%', 'Price confirmation',        'Lot 2 filled',   'Momentum continuation confirmed'],
            ['Lot 4', 'The Jugular', '12%', 'Price confirmation',        'Lot 3 filled',   'Trend extension'],
            ['Lot 5', 'The Kill',    '8%',  'Price confirmation',        'Lot 4 filled',   'Maximum conviction; full position'],
        ],
        col_widths=[0.6*inch, 0.85*inch, 0.55*inch, 1.2*inch, 1.0*inch, CONTENT_W - 4.2*inch]
    ))
    s.append(note(
        'Specific price thresholds at which Lots 2 through 5 trigger are proprietary and are '
        'not disclosed.'
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
            ['PNTHR PPSLS Stop Hit', 'Ratchet stop hit', '10/12'],
            ['RISK_ADVISOR', 'Proactive exit on elevated sector or portfolio exposure advisory', '10/12'],
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
              'Investment Process Overview', 'v1.2 - April 2026', s)


# ═══════════════════════════════════════════════════════════════════════════════
# 4. PERFORMANCE SUMMARY (HYPOTHETICAL BACKTEST)
# ═══════════════════════════════════════════════════════════════════════════════

def gen_performance_summary():
    s = []

    # ── 1. Important Disclosures ─────────────────────────────────────────────
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
        'This document presents performance on both <b>GROSS</b> and <b>NET</b> bases across all '
        'three investor classes. <b>GROSS</b> figures are post-transaction-costs (IBKR Pro Fixed '
        'commissions at $0.005/share, 5 basis points of slippage per leg, and sector-tiered '
        'short borrow costs of 1.0-2.0% annualized) but <b>before</b> fund-level fees. '
        '<b>NET</b> figures are <b>after</b> both the 2.0% per annum management fee (accrued '
        'monthly on NAV) and the class-tiered performance allocation (30% / 25% Filet, '
        '25% / 20% Porterhouse, 20% / 15% Wagyu, stepping down to the loyalty rate after '
        '36 consecutive months of investment) charged quarterly, non-cumulative, on net '
        'profits above a quarterly hurdle equal to the US 2-Year Treasury yield divided by '
        'four, subject to a running High-Water Mark with Loss Carryforward. Mechanics per '
        'PPM sec. 4.1-4.3. Past hypothetical performance is not indicative of future results.'
    ))

    # ── 2. Gross vs Net Returns by Investor Class ────────────────────────────
    s += section('Gross vs Net Returns by Investor Class')
    s.append(body(
        'Backtest period: June 2019 through April 2026 (82 months). The three classes below '
        'apply their own PPM-specified performance allocation rates. Higher classes '
        '(larger capital commitments) receive materially lower fee burdens, producing '
        'meaningfully higher net returns. This is an intentional incentive for capital scale.'
    ))

    s.append(Spacer(1, 4))
    s += subsection('FILET CLASS ($100,000 - $499,999 : 30% / 25% after 36 months)')
    s.append(bold_table(
        ['Metric', 'Gross', 'Net', 'Fee Drag'],
        [
            ['Total Return',              '+823.05%', '+375.69%', '-447.36 pts'],
            ['CAGR',                      '+38.48%',  '+25.81%',  '-12.67 pts'],
            ['Sharpe Ratio',              '2.54',     '1.64',     '-0.90'],
            ['Sortino Ratio',             '4.59',     '2.71',     '-1.88'],
            ['Calmar Ratio',              '4.46',     '2.58',     '-1.88'],
            ['Max Drawdown (daily NAV)',  '-8.63%',   '-9.99%',   '-1.36 pts'],
            ['Best Month',                '+24.73%',  '+24.52%',  '-0.21 pts'],
            ['Worst Month',               '-3.22%',   '-7.11%',   '-3.89 pts'],
            ['Ending Equity ($100K start)','$923,054', '$475,690','-$447,364'],
        ],
        col_widths=[2.4*inch, 1.3*inch, 1.3*inch, CONTENT_W - 5.0*inch]
    ))

    s.append(Spacer(1, 6))
    s += subsection('PORTERHOUSE CLASS ($500,000 - $999,999 : 25% / 20% after 36 months)')
    s.append(bold_table(
        ['Metric', 'Gross', 'Net', 'Fee Drag'],
        [
            ['Total Return',              '+836.49%', '+427.28%', '-409.21 pts'],
            ['CAGR',                      '+38.77%',  '+27.73%',  '-11.04 pts'],
            ['Sharpe Ratio',              '2.59',     '1.81',     '-0.78'],
            ['Sortino Ratio',             '4.71',     '3.07',     '-1.64'],
            ['Calmar Ratio',              '4.55',     '2.96',     '-1.59'],
            ['Max Drawdown (daily NAV)',  '-8.52%',   '-9.36%',   '-0.84 pts'],
            ['Best Month',                '+24.78%',  '+24.58%',  '-0.20 pts'],
            ['Worst Month',               '-3.13%',   '-6.07%',   '-2.94 pts'],
            ['Ending Equity ($500K start)','$4.68M',  '$2.64M',   '-$2.05M'],
        ],
        col_widths=[2.4*inch, 1.3*inch, 1.3*inch, CONTENT_W - 5.0*inch]
    ))

    s.append(Spacer(1, 6))
    s += subsection('WAGYU CLASS ($1,000,000+ : 20% / 15% after 36 months)')
    s.append(bold_table(
        ['Metric', 'Gross', 'Net', 'Fee Drag'],
        [
            ['Total Return',              '+837.05%', '+478.42%', '-358.63 pts'],
            ['CAGR',                      '+38.78%',  '+29.48%',  '-9.30 pts'],
            ['Sharpe Ratio',              '2.59',     '1.95',     '-0.64'],
            ['Sortino Ratio',             '4.72',     '3.39',     '-1.33'],
            ['Calmar Ratio',              '4.56',     '3.34',     '-1.22'],
            ['Max Drawdown (daily NAV)',  '-8.51%',   '-8.82%',   '-0.31 pts'],
            ['Best Month',                '+24.80%',  '+24.59%',  '-0.21 pts'],
            ['Worst Month',               '-3.13%',   '-5.51%',   '-2.38 pts'],
            ['Ending Equity ($1M start)', '$9.37M',   '$5.78M',   '-$3.59M'],
        ],
        col_widths=[2.4*inch, 1.3*inch, 1.3*inch, CONTENT_W - 5.0*inch]
    ))

    # ── 3. Strategy Activity by Direction (trade-level, Wagyu $1M) ──────────
    s += section('Strategy Activity by Direction (Wagyu $1M)')
    s.append(body(
        'Trade-level attribution metrics at the Wagyu $1M tier. Profit Factor and Win Rate '
        'are signed at the individual trade level and are invariant to mark-to-market '
        'resolution. Portfolio-level CAGR, Sharpe, and Sortino for the fully combined strategy '
        'are reported on a mark-to-market basis in the Gross vs Net tables above.'
    ))
    s.append(bold_table(
        ['Metric', 'BL (Longs)', 'SS (Shorts)', 'Combined'],
        [
            ['Profit Factor',      '11.38x',  '6.22x',   '11.22x'],
            ['Win Rate',           '60.4%',   '50.9%',   '60.4%'],
            ['Total Trades',       '2,460',   '163',     '2,623'],
            ['Closed Trades',      '2,451',   '163',     '2,614'],
        ],
        col_widths=[1.8*inch, 1.5*inch, 1.5*inch, CONTENT_W - 4.8*inch]
    ))
    s.append(note(
        'Per-tier trade counts (virtually identical across classes): Filet 2,625 / 2,616 '
        'closed / 9 open; Porterhouse 2,623 / 2,614 / 9; Wagyu 2,623 / 2,614 / 9. Backtest '
        'period: June 2019 through April 2026 (82 months, 1,713 trading days).'
    ))

    # ── 4. Crisis Alpha ──────────────────────────────────────────────────────
    s += section('Crisis Alpha: Performance During Market Drawdowns')
    s.append(body(
        'The hallmark of a disciplined panther is composure under pressure. While the broader '
        'market experienced significant drawdowns, the Fund preserved and grew investor '
        'capital through every major market event. Values shown on a Gross Fund NAV basis '
        'during the periods listed (drawdown behavior is primarily a gross-level phenomenon; '
        'full-period fee drag is disclosed in the Gross vs Net tables above).'
    ))
    s.append(bold_table(
        ['Market Event', 'Period', 'S&amp;P 500', 'PNTHR Fund', 'PNTHR Alpha'],
        [
            ['COVID Crash',                   '2020-02-21 to 2020-03-23', '-34.1%', '-3.8%',  '+30.3%'],
            ['2022 Bear Market',              '2022-01-05 to 2022-10-12', '-25.4%', '+11.7%', '+37.1%'],
            ['2025 Liberation Day Correction','2025-02-21 to 2025-04-08', '-19.0%', '+1.8%',  '+20.8%'],
            ['Market Correction',             '2020-09-03 to 2020-09-23', '-9.8%',  '-4.3%',  '+5.5%'],
            ['Market Correction',             '2024-07-17 to 2024-08-05', '-8.4%',  '-0.1%',  '+8.3%'],
            ['Market Correction',             '2019-07-31 to 2019-08-05', '-6.0%',  '-3.5%',  '+2.5%'],
        ],
        col_widths=[1.8*inch, 1.8*inch, 1.0*inch, 1.0*inch, CONTENT_W - 5.6*inch]
    ))

    # ── 5. Annual Performance (Filet Net, conservative) ──────────────────────
    s += section('Annual Performance: PNTHR vs S&amp;P 500')
    s.append(body(
        'Annual breakdown shown on the <b>Filet Class Net</b> basis (conservative presentation, '
        '30% / 25% performance allocation). Porterhouse and Wagyu classes achieve higher net '
        'returns per the Gross vs Net tables above.'
    ))
    s.append(bold_table(
        ['Year', 'SPY Equity', 'S&amp;P 500', 'PNTHR Equity', 'Filet Net', 'Alpha'],
        [
            ['2019', '$111,893', '+11.9%', '$155,678', '+55.7%', '+43.8%'],
            ['2020', '$129,977', '+16.2%', '$267,963', '+72.1%', '+56.0%'],
            ['2021', '$165,117', '+27.0%', '$384,153', '+43.4%', '+16.3%'],
            ['2022', '$132,950', '-19.5%', '$424,735', '+10.6%', '+30.0%'],
            ['2023', '$165,239', '+24.3%', '$522,245', '+23.0%', '-1.3%'],
            ['2024', '$203,748', '+23.3%', '$648,114', '+24.1%', '+0.8%'],
            ['2025', '$237,066', '+16.4%', '$813,796', '+25.6%', '+9.2%'],
            ['2026', '$227,996', '-3.8%',  '$861,408', '+5.8%',  '+9.7%'],
        ],
        col_widths=[0.6*inch, 1.0*inch, 1.0*inch, 1.2*inch, 1.0*inch, CONTENT_W - 4.8*inch]
    ))

    # ── 6. Key Takeaway ──────────────────────────────────────────────────────
    s += section('Key Takeaway')
    s.append(body(
        'At no point during the entire 7-year backtest did the account balance or investor '
        'equity decline below prior high-water marks for more than a single month. Even '
        'during the months when worst-case MAE trades occurred, the portfolio remained '
        'profitable on a net basis across all three investor classes. The 1% vitality cap '
        'and 35% initial lot sizing ensure that no single adverse trade can materially '
        'impair investor capital.'
    ))

    # ── 7. Anticipated Questions ─────────────────────────────────────────────
    s += section('Anticipated Investor Questions')

    s += subsection('Are these live returns or hypothetical?')
    s.append(body(
        'Entirely <b>hypothetical backtest results</b>. The Fund has not yet traded '
        'non-affiliated Limited Partner capital. The Strategy becomes operational for live '
        'trading on April 17, 2026.'
    ))

    s += subsection('What realistic live performance should I expect?')
    s.append(body(
        'Systematic strategies typically deliver a portion of backtested results in live '
        'trading due to execution slippage, strategy decay, and capacity effects. A '
        'reasonable expectation is live Net CAGR at roughly half to two-thirds of the '
        'backtest headline, with live Max Drawdown 2-to-4 times larger than backtested. No '
        'specific live outcome is guaranteed.'
    ))

    s += subsection('How do these numbers compare to industry benchmarks?')
    s.append(body(
        'HFRI Equity Hedge and Barclay Long/Short Equity indices have produced long-run Net '
        'CAGRs in the 6-9% range with Sharpe 0.6-0.9. Top-tier multi-strategy and equity '
        'hedge funds (Citadel Wellington, Millennium, D.E. Shaw) have produced Net CAGRs in '
        'the 10-20% range with Sharpe 1.0-2.5. Backtested Net metrics for this Strategy '
        'materially exceed these benchmarks; investors should apply appropriate skepticism '
        'pending live track record.'
    ))

    s += subsection('Was the strategy validated out-of-sample?')
    s.append(body(
        'Per-sector trend-filter periods are empirically calibrated across the January 2020 '
        'through April 2026 sub-window of the full backtest. The calibration is supported by '
        'three robustness checks: (i) no sector period was selected that caused regression '
        'versus the 21-week baseline within any individual calendar year of the calibration '
        'window; (ii) no individual sector regressed under its selected period on a full-pipeline '
        'basis; and (iii) a split-sample comparison between 2020-2023 and 2024-2026 shows '
        'consistent improvement in both sub-periods, with cumulative outperformance over the '
        '21-week baseline of approximately +131 percentage points in 2020-2023 and approximately '
        '+73 percentage points in 2024-2026.'
    ))
    s.append(body(
        'The backtest reporting window extends from June 16, 2019 through April 16, 2026. The '
        'June 2019 through December 2019 portion (approximately seven months; 30 weekly signal '
        'cycles; 144 trading days of daily NAV) was added to the historical data set after the '
        'per-sector trend-filter calibration was completed and was not used in the calibration. '
        'Performance during this period therefore reflects a true held-out out-of-sample period '
        'under the selected per-sector parameters.'
    ))
    s.append(body(
        '<b>Important limitation.</b> The 2020-2023 versus 2024-2026 split-sample comparison '
        'above is not a traditional held-out out-of-sample validation. Parameters were selected '
        'with visibility to the full 2020-2026 calibration window. Investors should interpret '
        'those split-sample figures as robustness indicators, not as independent out-of-sample '
        'validation.'
    ))

    s += subsection('Why is the short side proportionally thin (~6% of trade count)?')
    s.append(body(
        'The SS Crash Gate restricts short entries to market-stress regimes through dual '
        'confirmation of sustained bearish direction-index momentum and pronounced recent '
        'sector weakness. Specific thresholds are proprietary. In bull markets, short signals '
        'are rare by design. The asymmetric weekly cap (top 10 BL + top 5 SS) reflects the '
        'Strategy\'s structural long bias.'
    ))

    s += subsection('Has the backtest been independently audited?')
    s.append(body(
        'Internally validated for gate compliance and data integrity; <b>not</b> '
        'independently audited by a third-party firm. The Fund intends to engage Spicer '
        'Jeffries LLP as auditor upon admission of Limited Partners; first-year live '
        'financial statements will be audited.'
    ))

    # ── 8. Methodology / Provenance / Disclosures ────────────────────────────
    s += section('Methodology and Data Provenance')
    s.append(body(
        'Complete backtest methodology, monthly return heatmaps, per-class annual returns, '
        'drawdown analysis, and daily NAV logs are consolidated in the PNTHR Fund '
        'Intelligence Report. Backtest dataset: per-tier pyramid trade logs and mark-to-market '
        'daily NAV curves as of April 20, 2026 (trade counts: 2,623-2,625 initiated per class; '
        '2,614-2,616 closed; 9 still open excluded from metrics). Gate compliance verified: '
        'historical SP500/NDX100 index membership reconstruction via point-in-time event '
        'reconstruction; SP400 via MDY ETF holdings proxy; sector ETF evaluated against '
        'sector-specific trend-filter periods (specific periods proprietary); D2 gate; SS '
        'crash gate. Costs modeled at trade level (IBKR Pro Fixed $0.005/share, 5 basis points '
        'slippage per leg, sector-tiered 1.0 to 2.0% short borrow annualized). Fund-level '
        'fees applied per PPM Sections 4.1-4.3 (2% per annum management fee accrued monthly; '
        'tier-specific performance allocation 20%/25%/30% stepping to 15%/20%/25% after 36 '
        'continuous months, calculated quarterly and non-cumulative against US 2-Year Treasury '
        'hurdle; running High Water Mark; Loss Recovery Account per PPM Section 8.01(e)).'
    ))
    s.append(body(
        '<b>Performance metric conventions.</b> Sharpe Ratio is computed from daily NAV returns '
        'using excess return over the US 3-month Treasury Bill, annualized by the square root of '
        '252 trading days. Sortino Ratio is computed from daily NAV returns using Minimum '
        'Acceptable Return of zero, annualized by the square root of 252. Maximum Drawdown is '
        'peak-to-trough percentage decline measured on daily mark-to-market NAV. Profit Factor '
        'and Win Rate are signed at the individual trade level.'
    ))
    s.append(body(
        '<b>Survivorship Bias Disclosure.</b> The backtest universe consists of approximately '
        '679 U.S. listed equities representing the current (April 2026) composition of the '
        'S&amp;P 500, Nasdaq-100, Dow Jones Industrial Average, and S&amp;P MidCap 400 indices. '
        'Historical price data is sourced from Financial Modeling Prep. Tickers that were '
        'delisted, acquired, merged, or otherwise removed from their parent index prior to '
        'April 2026 are not represented in the backtest, as historical price data for such '
        'tickers is not available in the current data source.'
    ))

    s += section('Important Disclosures')
    s.append(body(
        '<b>HYPOTHETICAL PERFORMANCE RESULTS HAVE MANY INHERENT LIMITATIONS. NO '
        'REPRESENTATION IS BEING MADE THAT ANY ACCOUNT WILL OR IS LIKELY TO ACHIEVE PROFITS '
        'OR LOSSES SIMILAR TO THOSE SHOWN.</b> Hypothetical results are prepared with '
        'hindsight, do not involve financial risk, and cannot fully account for market '
        'impact or the psychological pressure of actual trading. This document contains '
        'hypothetical performance as defined in Rule 206(4)-1 under the Investment Advisers '
        'Act (the SEC Marketing Rule).'
    ))
    s.append(body(
        'The Fund is offered in reliance on Rule 506(c) of Regulation D to investors '
        'verified as both Accredited Investors under Rule 501(a) and Qualified Clients '
        'under Rule 205-3 of the Investment Advisers Act of 1940. The Fund relies on '
        'Section 3(c)(1) of the Investment Company Act and is NOT relying on Section '
        '3(c)(7). The Fund is limited to 100 beneficial owners. The backtest has not been '
        'independently audited. This document is not an offer; any offer is made solely by '
        'the Private Placement Memorandum and Limited Partnership Agreement. In the event '
        'of conflict, the PPM and LPA govern. Past hypothetical performance is not '
        'indicative of future results. Investors may lose some or all of their capital.'
    ))

    build_doc('PNTHR_Performance_Summary.pdf',
              'Performance Summary', 'v1.3 - April 2026 - HYPOTHETICAL BACKTEST', s)


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
        ('Fund Inception', 'Strategy operational April 17, 2026; first Limited Partner admission targeted Q3 2026'),
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
         'sector-specific trend-filter dynamics, then ranks opportunities through a multi-dimensional '
         'scoring framework (Kill Score). Candidates pass through a direction-index gate '
         '(SPY 21-week EMA for S&amp;P 500 members, QQQ 21-week EMA for Nasdaq-100-only members, '
         'MDY 21-week EMA for S&amp;P MidCap 400 members), a sector ETF gate (sector-specific '
         'trend-filter periods, empirically optimized per sector; specific periods proprietary), '
         'a D2 sector-return gate, and an SS Crash Gate (dual confirmation of sustained bearish '
         'direction-index momentum and pronounced recent sector weakness; specific thresholds '
         'proprietary) for short entries. Positions are entered via a 5-lot pyramid structure '
         '(35% / 25% / 20% / 12% / 8%) with the PNTHR Proprietary Stop Loss System (PPSLS).'),
        ('Investment Universe', 'PNTHR 679 - curated universe of approximately 679 high-liquidity U.S. equities drawn from the S&amp;P 500, Nasdaq-100, Dow 30, and high-liquidity S&amp;P MidCap 400 constituents, plus sector ETFs'),
        ('Position Holding Period', 'Swing (typically 4-6 weeks; 20-day stale position exit if price fails to progress)'),
        ('Long/Short Allocation', 'Dynamic based on regime and signal availability; structural long bias (top 10 BL + top 5 SS per week maximum). Per backtest: 2,460 BL / 163 SS trades = 93.8% / 6.2% by trade count'),
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
        ('Position Sizing', '1.0% vitality cap per equity (0.5% per ETF); 10% per-ticker cap; '
         'NAV-scaled (vitality = NAV x 1.0%, tickerCap = NAV x 10%)'),
        ('Stop Loss Methodology', 'PNTHR Proprietary Stop Loss System (PPSLS); stops never loosen; ratchet on pyramid lot fills (Lot 3 to breakeven, Lot 4 to Lot 2 fill, Lot 5 to Lot 3 fill)'),
        ('Portfolio Heat Caps', '10% gross long, 5% gross short, 15% total portfolio heat'),
        ('Sector Concentration', 'No fixed sector concentration cap. The Fund may concentrate in a single sector when trend and macro conditions favor it. Sector allocation is governed by the sector ETF gate (each sector ETF must be above/below its per-sector optimized EMA for BL/SS respectively)'),
        ('Automated Alerts', 'FEAST (RSI &gt; 85, 50% reduction signal), Stale Hunt (20 trading days without progress)'),
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
        ('Track Record Type', 'Hypothetical Systematic Backtest (June 2019 through April 2026; 82 months; 1,713 trading days). Fund has not yet traded non-affiliated Limited Partner capital.'),
        ('Total Trades (Wagyu tier)', '2,623 initiated (2,460 BL + 163 SS); 2,614 closed; 9 still open at backtest cutoff'),
        ('Gross CAGR', '+38.78% (Wagyu tier; post-transaction-costs, pre-fund-fees)'),
        ('Gross Sharpe Ratio', '2.59 (daily resolution, excess over US 3-month Treasury)'),
        ('Gross Sortino Ratio', '4.72 (daily resolution, MAR = 0)'),
        ('Gross Profit Factor', '11.22x'),
        ('Gross Max Drawdown (daily NAV)', '-8.51% (Wagyu tier, mark-to-market)'),
        ('Net CAGR (after all fund fees)', 'Filet (100K): +25.81%; Porterhouse (500K): +27.73%; Wagyu (1M+): +29.48%'),
        ('Net Sharpe Ratio', 'Filet: 1.64; Porterhouse: 1.81; Wagyu: 1.95'),
        ('Net Sortino Ratio', 'Filet: 2.71; Porterhouse: 3.07; Wagyu: 3.39'),
        ('Net Max Drawdown (daily NAV)', 'Filet: -9.99%; Porterhouse: -9.36%; Wagyu: -8.82%'),
        ('Benchmark (S&amp;P 500)', 'CAGR: +12.8%; Max Drawdown: -34.1%. Strategy alpha: Filet +13.0 pts; Porterhouse +14.9 pts; Wagyu +16.7 pts (annualized, net).'),
        ('Data Integrity', 'Backtest internally validated: direction-index gate via historical SP500/NDX100 membership reconstruction (FMP events); SP400 membership via MDY ETF holdings proxy; sector ETF gate at sector-specific trend-filter periods (specific periods proprietary); quarterly non-cumulative fee engine per PPM sec. 4.1-4.3; mark-to-market daily-basis Max Drawdown computation. Not independently audited by a third-party accounting firm; Fund intends to engage Spicer Jeffries LLP as independent auditor upon Limited Partner admission.'),
        ('Full Detail', 'Refer to PNTHR Fund Intelligence Report v23 for complete per-class metrics, annual performance breakdowns, crisis alpha analysis, methodology, and anticipated due diligence questions.'),
    ]
    s.append(bold_table(
        ['Question', 'Answer'],
        [[q, a] for q, a in qa],
        col_widths=[2.0*inch, CONTENT_W - 2.0*inch]
    ))
    s.append(Spacer(1, 8))
    s.append(note(
        '<b>HYPOTHETICAL PERFORMANCE RESULTS HAVE MANY INHERENT LIMITATIONS.</b> No representation '
        'is being made that any account will or is likely to achieve profits or losses similar '
        'to those shown. Hypothetical results are prepared with hindsight, do not involve '
        'financial risk, and cannot fully account for market impact or the psychological '
        'pressure of actual trading. Live performance typically delivers a portion of '
        'backtested results due to execution slippage, strategy decay, and capacity '
        'constraints; investors should expect realized results closer to top-tier industry '
        'averages (HFRI Equity Hedge long-run: 6-9% net CAGR, Sharpe 0.6-0.9) than to the '
        'backtest headline. This document contains hypothetical performance as defined in '
        'Rule 206(4)-1 under the Investment Advisers Act (the SEC Marketing Rule).'
    ))
    s.append(Spacer(1, 6))
    s.append(note(
        'This DDQ is provided for informational purposes only and does not constitute an offer '
        'to sell or a solicitation of an offer to buy any interest in the Fund. Any such offer '
        'will be made solely by the Private Placement Memorandum, Limited Partnership Agreement, '
        'and Subscription Agreement; in the event of conflict between this DDQ and those '
        'governing documents, the governing documents shall control. The Fund is offered in '
        'reliance on Rule 506(c) of Regulation D, relies on Section 3(c)(1) (not Section '
        '3(c)(7)) of the Investment Company Act, and is limited to 100 beneficial owners. '
        'Past hypothetical performance is not indicative of future results. Investors may '
        'lose some or all of their capital.'
    ))

    build_doc('PNTHR_Due_Diligence_Questionnaire.pdf',
              'Due Diligence Questionnaire', 'v1.3 - April 2026', s)


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
              'Compliance Manual & Code of Ethics', 'v1.1 - April 2026', s)


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

    s += section('IV. Accredited Investor and Qualified Client Verification')
    s.append(body(
        'As a Rule 506(c) offering exempt under Section 3(c)(1) of the Investment Company Act, the '
        'Fund is required to take <b>reasonable steps to verify</b> that each investor qualifies as '
        'both an <b>Accredited Investor</b> (Rule 501(a) of Regulation D) <b>and a Qualified '
        'Client</b> (Rule 205-3 of the Investment Advisers Act of 1940), as required by the Fund&rsquo;s '
        'offering documents. Acceptable verification methods include:'
    ))
    s.append(bullet('Review of tax returns, W-2s, or other IRS filings (income-based verification)'))
    s.append(bullet('Review of bank, brokerage, or other asset statements (net worth-based verification)'))
    s.append(bullet('Written confirmation from a FINRA-registered broker-dealer, <b>SEC-registered</b> '
                    'investment adviser, licensed attorney, or CPA'))
    s.append(bullet('Existing investor certification (for subsequent investments within 90 days)'))
    s.append(Spacer(1, 4))
    s.append(body(
        '<b>Note:</b> State-registered investment advisers are <b>not</b> acceptable verifiers '
        'under the Rule 506(c)(2)(ii)(C) safe harbor. Only SEC-registered investment advisers '
        'satisfy the safe-harbor requirement. Verification is valid for 90 days from the date '
        'of verification.'
    ))

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
              'Anti-Money Laundering & KYC Policy', 'v1.1 - April 2026', s)


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
                    'an orderly unwinding of all open positions using the PNTHR Proprietary Stop Loss System (PPSLS)'))
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
              'Business Continuity & Disaster Recovery Plan', 'v1.1 - April 2026', s)


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
        'Scott McBrien is the Founder and Managing Member of STT Capital Advisors, LLC '
        '(the Investment Manager) and Co-Founder of PNTHR Funds, LLC (the General Partner), '
        'serving as Chief Investment Officer and Chief Compliance Officer for PNTHR FUNDS, '
        'Carnivore Quant Fund, LP. An accomplished investment professional with decades of '
        'experience in equities, futures, and quantitative investment strategies, Scott began '
        'his career in investment banking, holding Series 7, 63, and 3 SEC/FINRA licenses. '
        'He was offered a position as Head of Trading in Chicago, where he traded a range of '
        'futures contracts and developed a proprietary strategy that doubled the firm\u2019s '
        'account in profits within nine months.'
    ))
    s.append(body(
        'In 2025, Scott and his Co-Founder, Cindy Eagar, launched PNTHR FUNDS, Carnivore '
        'Quant Fund, LP, a Regulation D, Rule 506(c), Section 3(c)(1) long/short equity hedge fund '
        'open to Accredited Investors who are also Qualified Clients. Together they engineered the '
        'proprietary PNTHR Signal System from the ground up, including the signal detection '
        'algorithm, multi-dimensional Kill scoring framework, pyramid entry system, PNTHR '
        'Proprietary Stop Loss System (PPSLS), and all risk management protocols. This technology '
        'now serves as the strategic engine behind the fund\u2019s performance.'
    ))
    s.append(body(
        'Scott authored <i>The Sigma Investor\u2122</i> (2024), which debuted as an Amazon #1 '
        'New Release. The book chronicles his contrarian investment philosophy and documents '
        'exceptional performance, including during the market downturn of 2022, providing '
        'insights into navigating volatile environments.'
    ))
    s.append(body(
        'Scott\u2019s expertise has been recognized by major financial media outlets including '
        '<b>CNN</b>, <b>U.S. News &amp; World Report</b>, <b>The Business Journals</b>, and '
        '<b>Business Insider</b>. Business Insider, with over 200 million global readers, '
        'featured his timely short positions in banking stocks (executed weeks before the '
        'March 2023 collapse of Silicon Valley Bank), highlighting how his system helped '
        'protect investors from significant losses.'
    ))
    s.append(Spacer(1, 4))
    s.append(bold_table(
        ['', ''],
        [
            ['Licenses Held', 'Series 7, Series 63, Series 3 (SEC/FINRA)'],
            ['Career History', 'Stock & Futures Broker, Senior Technical Analyst, '
             'Head of Trading (Chicago), Futures Trader'],
            ['Published Work', 'The Sigma Investor\u2122: Amazon #1 New Release (2024)'],
            ['Media & Press', 'CNN, U.S. News & World Report, The Business Journals, '
             'Business Insider, plus industry podcasts and publications'],
            ['Notable Achievement', 'Designed a system that backtested to a 2.59 Gross Sharpe ratio '
             '(daily resolution, excess over US 3-month Treasury) and 11.22x profit factor across '
             '2,614 closed pyramid trades (2,623 initiated) over 7+ years, encompassing both bull '
             'markets and major drawdowns (COVID crash, 2022 bear market, 2025 Liberation Day correction)'],
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
        'Cindy Eagar is the Co-Founder of PNTHR Funds, LLC (the General Partner) and serves as '
        'Chief Operating Officer and Chief Information Security Officer of STT Capital Advisors, '
        'LLC (the Investment Manager) and of PNTHR FUNDS, Carnivore Quant Fund, LP, a U.S.-based '
        'hedge fund serving family offices, high-net-worth, and ultra-high-net-worth investors '
        'seeking disciplined, asymmetric growth strategies. Drawing on nearly two decades in '
        'executive leadership and business growth, Cindy brings a unique perspective to capital '
        'management rooted in risk awareness, strategic positioning, and operational excellence.'
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
        'infrastructure for the Fund, including the investor data room, compliance framework, '
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
            ['Key Prior Role', 'Executive at Keap (Infusionsoft): helped scale from '
             '$10M to $100M in revenue'],
            ['Fund Operations', '3 years building fund operations, compliance infrastructure, '
             'and investor relations for Carnivore Quant Fund'],
            ['Media & Press', 'Business Insider, U.S. News & World Report, The Business Journals, '
             'plus industry podcasts and publications'],
            ['Responsibilities', 'Fund operations, information security, technology development, '
             'investor onboarding, data room management, reporting'],
            ['Notable Achievement', 'Built the complete operational and compliance framework '
             'for an emerging hedge fund, from partnership agreements to data room to '
             'investor communications, establishing institutional-grade infrastructure '
             'prior to accepting outside capital'],
        ],
        col_widths=[1.8*inch, CONTENT_W - 1.8*inch]
    ))

    build_doc('PNTHR_Key_Personnel.pdf',
              'Key Personnel', 'v1.3 - April 2026', s)


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

# ═══════════════════════════════════════════════════════════════════════════════
# 11. FUND INTELLIGENCE REPORT v21 — CONSOLIDATED 3-CLASS (AUTHORITATIVE)
# ═══════════════════════════════════════════════════════════════════════════════
# Sources every number from the authoritative archive generated by
# server/backtest/computeV21FromDailyNav.js (corrected gate + NAV-scaled
# pyramiding + quarterly fee engine + daily-basis Max DD).

def gen_fund_intelligence_v21():
    s = []

    # ── Section 1: Executive Summary ─────────────────────────────────────────
    s += section('Executive Summary')
    s.append(body(
        'This Fund Intelligence Report v23 consolidates performance data for all three investor '
        'classes of PNTHR FUNDS, Carnivore Quant Fund, LP into a single authoritative document. '
        'All figures are derived from a full historical backtest of the proprietary PNTHR Signal '
        'System across the PNTHR 679 U.S. equity universe from June 2019 through April 2026 '
        '(82 months, 1,713 trading days).'
    ))
    s.append(body(
        'The Fund employs a systematic long/short equity strategy using NAV-scaled pyramiding '
        '(five-lot entry structure, 35%/25%/20%/12%/8%), 1% vitality cap per equity (0.5% per ETF), '
        '10% per-ticker cap, with entry gated by: (1) the investor\'s applicable index 21-week EMA '
        '(SPY for S&amp;P 500 members, QQQ for Nasdaq-100-only members, MDY for S&amp;P MidCap 400 '
        'members), (2) the sector ETF\'s per-sector-optimized weekly EMA, (3) D2 sector return '
        'alignment, and (4) the SS Crash Gate for short positions. Multi-dimensional Kill scoring '
        'ranks candidates; top 10 BL and top 5 SS selected per week.'
    ))

    # Alpha summary
    s.append(Spacer(1, 6))
    s += subsection('Performance Summary vs S&amp;P 500 (7-Year Backtest, Net of All Fees)')
    s.append(bold_table(
        ['Investor Class', 'Perf Allocation', 'Net CAGR', 'Net Sharpe', 'S&amp;P 500 CAGR', 'Alpha'],
        [
            ['Filet ($100K - $499K)',        '30% / 25%',  '+25.81%', '1.64', '+12.8%', '+13.01%'],
            ['Porterhouse ($500K - $999K)',  '25% / 20%',  '+27.73%', '1.81', '+12.8%', '+14.93%'],
            ['Wagyu ($1M+)',                 '20% / 15%',  '+29.48%', '1.95', '+12.8%', '+16.68%'],
        ],
        col_widths=[1.8*inch, 1.1*inch, 0.9*inch, 0.9*inch, 1.1*inch, CONTENT_W - 5.8*inch]
    ))

    # ── Section 2: Gross vs Net by Class ─────────────────────────────────────
    s += section('Gross vs Net Returns by Investor Class')
    s.append(body(
        'Returns are presented both before fund-level fees (<b>GROSS</b>, post-transaction-costs) '
        'and after all fees (<b>NET</b>). Gross figures include IBKR Pro Fixed commissions '
        '($0.005/share), 5 basis points of slippage per leg, and sector-tiered short borrow costs '
        '(1.0-2.0% annualized). Net figures further include the 2.0% per annum management fee '
        '(accrued monthly on NAV) and the class-tiered performance allocation charged quarterly '
        '(non-cumulative) on profits above a quarterly hurdle equal to the US 2-Year Treasury '
        'yield divided by four, subject to a running High-Water Mark with Loss Carryforward and '
        'the 36-month loyalty step-down. Mechanics per PPM sec. 4.1-4.3.'
    ))

    s.append(Spacer(1, 4))
    s += subsection('FILET CLASS ($100,000 - $499,999 : 30% / 25% after 36 months)')
    s.append(bold_table(
        ['Metric', 'Gross', 'Net', 'Fee Drag'],
        [
            ['Total Return',              '+823.05%', '+375.69%', '-447.36 pts'],
            ['CAGR',                      '+38.48%',  '+25.81%',  '-12.67 pts'],
            ['Sharpe Ratio',              '2.54',     '1.64',     '-0.90'],
            ['Sortino Ratio',             '4.59',     '2.71',     '-1.88'],
            ['Calmar Ratio',              '4.46',     '2.58',     '-1.88'],
            ['Max Drawdown (daily NAV)',  '-8.63%',   '-9.99%',   '-1.36 pts'],
            ['Best Month',                '+24.73%',  '+24.52%',  '-0.21 pts'],
            ['Worst Month',               '-3.22%',   '-7.11%',   '-3.89 pts'],
            ['Profit Factor',             '11.25x',   '9.70x',    '-1.55x'],
            ['Win Rate',                  '60.77%',   '50.63%',   '-10.14 pts'],
            ['Positive Months (of 83)',   '69',       '60',       '-9'],
            ['Ending Equity ($100K start)','$923,054', '$475,690', '-$447,364'],
            ['Cumulative Mgmt Fees',      '-',        '$39,812',  ''],
            ['Cumulative Perf Allocation','-',        '$121,720', ''],
        ],
        col_widths=[2.4*inch, 1.3*inch, 1.3*inch, CONTENT_W - 5.0*inch]
    ))

    s.append(Spacer(1, 6))
    s += subsection('PORTERHOUSE CLASS ($500,000 - $999,999 : 25% / 20% after 36 months)')
    s.append(bold_table(
        ['Metric', 'Gross', 'Net', 'Fee Drag'],
        [
            ['Total Return',              '+836.49%', '+427.28%', '-409.21 pts'],
            ['CAGR',                      '+38.77%',  '+27.73%',  '-11.04 pts'],
            ['Sharpe Ratio',              '2.59',     '1.81',     '-0.78'],
            ['Sortino Ratio',             '4.71',     '3.07',     '-1.64'],
            ['Calmar Ratio',              '4.55',     '2.96',     '-1.59'],
            ['Max Drawdown (daily NAV)',  '-8.52%',   '-9.36%',   '-0.84 pts'],
            ['Best Month',                '+24.78%',  '+24.58%',  '-0.20 pts'],
            ['Worst Month',               '-3.13%',   '-6.07%',   '-2.94 pts'],
            ['Profit Factor',             '11.24x',   '10.12x',   '-1.12x'],
            ['Win Rate',                  '60.67%',   '50.96%',   '-9.71 pts'],
            ['Positive Months (of 83)',   '68',       '62',       '-6'],
            ['Ending Equity ($500K start)','$4.68M',  '$2.64M',   '-$2.05M'],
            ['Cumulative Mgmt Fees',      '-',        '$214,989', ''],
            ['Cumulative Perf Allocation','-',        '$532,096', ''],
        ],
        col_widths=[2.4*inch, 1.3*inch, 1.3*inch, CONTENT_W - 5.0*inch]
    ))

    s.append(Spacer(1, 6))
    s += subsection('WAGYU CLASS ($1,000,000+ : 20% / 15% after 36 months)')
    s.append(bold_table(
        ['Metric', 'Gross', 'Net', 'Fee Drag'],
        [
            ['Total Return',              '+837.05%', '+478.42%', '-358.63 pts'],
            ['CAGR',                      '+38.78%',  '+29.48%',  '-9.30 pts'],
            ['Sharpe Ratio',              '2.59',     '1.95',     '-0.64'],
            ['Sortino Ratio',             '4.72',     '3.39',     '-1.33'],
            ['Calmar Ratio',              '4.56',     '3.34',     '-1.22'],
            ['Max Drawdown (daily NAV)',  '-8.51%',   '-8.82%',   '-0.31 pts'],
            ['Best Month',                '+24.80%',  '+24.59%',  '-0.21 pts'],
            ['Worst Month',               '-3.13%',   '-5.51%',   '-2.38 pts'],
            ['Profit Factor',             '11.22x',   '10.14x',   '-1.08x'],
            ['Win Rate',                  '60.42%',   '50.99%',   '-9.43 pts'],
            ['Positive Months (of 83)',   '68',       '62',       '-6'],
            ['Ending Equity ($1M start)', '$9.37M',   '$5.78M',   '-$3.59M'],
            ['Cumulative Mgmt Fees',      '-',        '$460,404', ''],
            ['Cumulative Perf Allocation','-',        '$871,688', ''],
        ],
        col_widths=[2.4*inch, 1.3*inch, 1.3*inch, CONTENT_W - 5.0*inch]
    ))

    # ── Section 3: Strategy Activity by Direction (trade-level) ──────────────
    s += section('Strategy Activity by Direction')
    s.append(body(
        'BL (Buy Long) and SS (Sell Short) pools generate signals independently, with asymmetric '
        'selection (top 10 BL + top 5 SS per week) reflecting the Strategy\'s structural long bias. '
        'Trade-level attribution metrics shown below are invariant to mark-to-market resolution. '
        'Portfolio-level CAGR, Sharpe, Sortino, and Max Drawdown for the fully combined strategy '
        'are reported on a mark-to-market basis in the Gross vs Net tables above. Based on '
        'Wagyu-tier trade log (2,623 initiated / 2,614 closed / 9 still open at backtest cutoff).'
    ))
    s.append(bold_table(
        ['Metric', 'BL (Longs)', 'SS (Shorts)', 'Combined'],
        [
            ['Total Trades',                  '2,460',    '163',     '2,623'],
            ['Closed Trades',                 '2,451',    '163',     '2,614'],
            ['Win Rate',                      '60.4%',    '50.9%',   '60.4%'],
            ['Profit Factor',                 '11.38x',   '6.22x',   '11.22x'],
        ],
        col_widths=[2.6*inch, 1.3*inch, 1.3*inch, CONTENT_W - 5.2*inch]
    ))

    # ── Section 4: Crisis Alpha ──────────────────────────────────────────────
    s += section('Crisis Alpha: Performance During Market Drawdowns')
    s.append(body(
        'While broader market indices experienced significant drawdowns during major crisis '
        'events, the Fund preserved and grew capital through the SS Crash Gate short-exposure '
        'mechanism combined with strict stop-loss discipline. Values shown on a Gross Fund NAV '
        'basis for the periods listed (full-period fee drag is captured in the Gross vs Net '
        'tables above). Periods identified from SPY drawdown events exceeding 5% peak-to-trough.'
    ))
    s.append(bold_table(
        ['Market Event', 'Period', 'S&amp;P 500', 'PNTHR Fund', 'PNTHR Alpha'],
        [
            ['COVID Crash',                    '2020-02-21 to 2020-03-23', '-34.1%', '-3.8%',  '+30.3%'],
            ['2022 Bear Market',               '2022-01-05 to 2022-10-12', '-25.4%', '+11.7%', '+37.1%'],
            ['2025 Liberation Day Correction', '2025-02-21 to 2025-04-08', '-19.0%', '+1.8%',  '+20.8%'],
            ['Market Correction',              '2020-09-03 to 2020-09-23', '-9.8%',  '-4.3%',  '+5.5%'],
            ['Market Correction',              '2024-07-17 to 2024-08-05', '-8.4%',  '-0.1%',  '+8.3%'],
            ['Market Correction',              '2019-07-31 to 2019-08-05', '-6.0%',  '-3.5%',  '+2.5%'],
        ],
        col_widths=[1.9*inch, 1.8*inch, 0.9*inch, 0.9*inch, CONTENT_W - 5.5*inch]
    ))

    # ── Section 5: Methodology ───────────────────────────────────────────────
    s += section('Methodology')
    s += subsection('Data Sources')
    s.append(body(
        'Daily OHLCV bars for 14 index / sector ETFs (SPY, QQQ, MDY, XLK, XLE, XLV, XLF, XLY, '
        'XLC, XLI, XLB, XLRE, XLU, XLP) and the PNTHR 679 equity universe sourced from Financial '
        'Modeling Prep. Historical S&amp;P 500 and Nasdaq-100 constituent membership reconstructed '
        'from FMP\'s historical-constituent endpoints (1,518 S&amp;P 500 events + 436 Nasdaq-100 '
        'events). S&amp;P MidCap 400 membership uses MDY ETF current holdings as proxy; '
        'historical MidCap 400 membership is not separately reconstructed. Index and sector ETF '
        'weekly closes generated via Monday-keyed weekly aggregation of daily bars.'
    ))

    s += subsection('Gate Policy')
    s.append(body(
        '<b>1. Direction Index Selection</b> (historical membership as of trade entry week): '
        'S&amp;P 500 members use SPY; Nasdaq-100-only members use QQQ; S&amp;P MidCap 400-only '
        'members use MDY; non-index fallback uses SPY. <b>2. Index Gate:</b> BL passes if index '
        'close above its 21-week EMA; SS passes if index close below its 21-week EMA. '
        '<b>3. Sector ETF Gate:</b> each sector ETF is evaluated against a sector-specific '
        'trend-filter period. Specific periods are empirically optimized per sector and are '
        'proprietary. BL passes if sector ETF close above its filter; SS passes if below. '
        '<b>4. D2 Gate:</b> stock\'s sector return score must be non-negative. '
        '<b>5. SS Crash Gate:</b> for SS only, requires dual confirmation of sustained bearish '
        'direction-index momentum and pronounced recent sector weakness. Specific thresholds '
        'are proprietary. Top 10 BL and top 5 SS ranked by multi-dimensional Kill score '
        'selected per week.'
    ))

    s += subsection('Position Sizing and Pyramiding')
    s.append(body(
        'NAV-scaled position sizing matches the live Command Center exactly: total shares = '
        'floor(min(vitality / risk-per-share, tickerCap / entry-price)) where vitality = NAV x '
        '1.0% (equities) or 0.5% (ETFs), tickerCap = NAV x 10%, risk-per-share = absolute '
        'difference between entry price and initial stop. The 5-lot pyramid allocates '
        '35% / 25% / 20% / 12% / 8% of total shares across Lot 1 "The Scent" through Lot 5 '
        '"The Kill", with sequential price-based confirmation thresholds for each subsequent '
        'lot (specific thresholds proprietary) and a 5-trading-day time gate between Lot 1 '
        'and Lot 2.'
    ))

    s += subsection('Fee Engine (PPM sec. 4.1-4.3)')
    s.append(body(
        '<b>Management Fee:</b> 2.00% per annum accrued monthly on NAV (1/12 of 2% per month). '
        '<b>Performance Allocation:</b> charged quarterly on March 31 / June 30 / September 30 / '
        'December 31, non-cumulative. Applied to the portion of quarter-end NAV exceeding BOTH '
        '(a) the running High-Water Mark, and (b) the quarterly hurdle equal to the US 2-Year '
        'Treasury yield as of the first trading day of the Fiscal Year divided by four. Class '
        'rates: Filet 30% (25% after 36 continuous months of investment), Porterhouse 25% '
        '(20% after 36 months), Wagyu 20% (15% after 36 months). Loss Carryforward: if NAV '
        'falls below HWM in any period, future allocations are suspended until NAV fully '
        'recovers to HWM. Annual hurdle rates used: 2019 = 2.50%, 2020 = 1.58%, 2021 = 0.11%, '
        '2022 = 0.78%, 2023 = 4.40%, 2024 = 4.33%, 2025 = 4.25%, 2026 = 3.47%.'
    ))

    s += subsection('Drawdown Computation')
    s.append(body(
        'Max Drawdown reported on a daily NAV basis (peak-to-trough over the full 1,713-day '
        'backtest window), reflecting institutional best practice and how an investor would '
        'experience NAV on daily statements. Monthly Peak-to-Trough (monthly NAV basis) is '
        'typically smaller due to aggregation smoothing.'
    ))

    # ── Section 6: Anticipated Due Diligence Questions ───────────────────────
    s += section('Anticipated Due Diligence Questions')
    s.append(body(
        'The following addresses questions institutional allocators, family offices, and '
        'sophisticated individuals typically raise when reviewing hypothetical backtest '
        'performance. These responses represent the Fund\'s current position and will be '
        'supplemented as live track record accumulates.'
    ))

    s += subsection('1. Are these figures hypothetical or from actual live trading?')
    s.append(body(
        'These figures are entirely <b>hypothetical backtest results</b>. The Fund has not '
        'yet traded non-affiliated Limited Partner capital. From June 16, 2025 through '
        'April 16, 2026 (the Pre-Launch Live Testing Period), the General Partner and principals '
        'used their own capital to live-test a <i>Short-Term Complementary Strategy</i>, '
        'distinct from the Strategy described herein. The Short-Term Complementary Strategy '
        'produced cumulative losses of 44.92% borne exclusively by the General Partner; no '
        'non-affiliated Limited Partner was exposed. The Strategy presented in this report is '
        'operational as of April 17, 2026. All backtest performance is simulated against '
        'historical data.'
    ))

    s += subsection('2. What realistic live performance should an investor expect?')
    s.append(body(
        'Industry convention is that live performance of systematic strategies typically '
        'delivers a meaningful haircut versus backtested results due to: (a) execution '
        'slippage beyond modeled assumptions; (b) strategy decay as market microstructure '
        'evolves; (c) capacity constraints as assets grow; (d) regime change. A reasonable '
        'expectation is that live Net CAGR may deliver <b>roughly half to two-thirds</b> of '
        'the backtest, and live Max Drawdown may be <b>2-to-4 times larger</b> than '
        'backtested. The Fund makes no guarantee of any specific live-performance outcome. '
        'Past hypothetical performance is not indicative of future results.'
    ))

    s += subsection('3. Was the strategy validated out-of-sample?')
    s.append(body(
        'Per-sector trend-filter periods are empirically calibrated across the January 2020 '
        'through April 2026 sub-window of the full backtest. The calibration is supported by '
        'three robustness checks: (i) no sector period was selected that caused regression '
        'versus the 21-week baseline within any individual calendar year of the calibration '
        'window; (ii) no individual sector regressed under its selected period on a full-pipeline '
        'basis; and (iii) a split-sample performance comparison between 2020-2023 and 2024-2026 '
        'shows consistent improvement in both sub-periods, with cumulative outperformance over '
        'the 21-week baseline of approximately +131 percentage points in 2020-2023 and '
        'approximately +73 percentage points in 2024-2026.'
    ))
    s.append(body(
        'The backtest reporting window extends from June 16, 2019 through April 16, 2026. The '
        'June 2019 through December 2019 portion (approximately seven months; 30 weekly signal '
        'cycles; 144 trading days of daily NAV) was added to the historical data set after the '
        'per-sector trend-filter calibration was completed and was not used in the calibration. '
        'Performance during this period therefore reflects a true held-out out-of-sample period '
        'under the selected per-sector parameters.'
    ))
    s.append(body(
        '<b>Important limitation.</b> The 2020-2023 versus 2024-2026 split-sample comparison '
        'described above is not a traditional held-out out-of-sample validation. Parameters '
        'were selected with visibility to the full 2020-2026 calibration window. Investors '
        'should interpret those split-sample figures as robustness indicators, not as '
        'independent out-of-sample validation. The multi-dimensional Kill scoring model, '
        'pyramid structure, and stop-loss system were developed through iterative backtesting '
        'over approximately 7 years of historical data.'
    ))

    s += subsection('4. Is the sample period representative of different market regimes?')
    s.append(body(
        'The June 2019 through April 2026 sample period (82 months) includes: (a) the '
        'COVID-19 pandemic crash of February-March 2020 (SPY -34.1%); (b) the 2022 bear '
        'market and inflation regime (SPY -25.4% peak-to-trough); (c) the 2025 Liberation '
        'Day tariff correction (SPY -19.0%); (d) bull market periods in 2019, 2021, 2023, '
        'and 2024. The period does not include a prolonged range-bound market, a stagflation '
        'period, or a credit-driven crisis (as in 2008-2009). Investors should understand '
        'that the Strategy\'s live performance in future regimes, particularly extended '
        'range-bound or commodity-supply-shock environments, may differ from backtested '
        'results.'
    ))

    s += subsection('5. How are transaction costs modeled?')
    s.append(body(
        'Costs are applied at the trade level: (a) commissions at Interactive Brokers Pro '
        'Fixed pricing ($0.005 per share, $1 minimum per order, 1% of trade value maximum); '
        '(b) slippage at 5 basis points per leg as a market-impact proxy; (c) short borrow '
        'at sector-tiered annualized rates of 1.0% to 2.0% accrued daily on notional short '
        'position value. These costs are reflected in both Gross and Net figures. Ongoing '
        'operating expenses (legal, audit, administrative) are borne by the Fund as ordinary '
        'expenses and are estimated at 0.1% to 0.3% of NAV per annum; investors should '
        'adjust expected Net returns by this amount.'
    ))

    s += subsection('6. Why is the short side proportionally thin (163 of 2,623 trades)?')
    s.append(body(
        'The SS Crash Gate is deliberately restrictive: short positions are only eligible when '
        'the applicable direction-index exhibits sustained bearish momentum AND the stock\'s '
        'sector shows pronounced recent weakness. Specific thresholds are proprietary. This '
        'gate is designed to prevent shorting during normal corrections and to concentrate '
        'short exposure in genuine market-stress regimes. In prolonged bull markets, short '
        'signals are rare by design. In bear markets (e.g., 2022), short signals expand '
        'significantly. The asymmetry (top 10 BL + top 5 SS per week maximum) reflects the '
        'Strategy\'s structural long bias, consistent with the long-term upward drift of '
        'the U.S. equity market.'
    ))

    s += subsection('7. How does the strategy address capacity constraints?')
    s.append(body(
        'The Fund targets a maximum of $25,000,000 in aggregate Capital Commitments at this '
        'stage, and is limited to 100 beneficial owners under the Section 3(c)(1) exemption. '
        'At target capacity and the 1% vitality sizing rule, a full position is approximately '
        '$250,000 — well within the liquidity of every ticker in the PNTHR 679 universe '
        '(filtered to S&amp;P 500, Nasdaq-100, and S&amp;P MidCap 400 constituents). Future '
        'capacity expansion beyond $25M would require review of individual-ticker capacity '
        'constraints and may necessitate strategy adjustments.'
    ))

    s += subsection('8. Has the backtest been independently audited?')
    s.append(body(
        'The backtest has been <b>internally validated</b> for gate compliance (historical '
        'index membership reconstruction, sector ETF alignment, D2 gate, SS crash gate) and '
        'data quality (trade count reconciliation, sector backfill, still-open trade '
        'exclusion from metrics). The backtest has <b>NOT been independently audited by a '
        'third-party accounting firm</b>. The Fund intends to engage Spicer Jeffries LLP as '
        'independent auditor upon admission of Limited Partners, and first-year live financial '
        'statements will be audited. Investors requiring independent verification prior to '
        'subscription should discuss their requirements with the General Partner.'
    ))

    s += subsection('9. How do these numbers compare to industry benchmarks?')
    s.append(body(
        'Industry long/short equity hedge fund indices (HFRI Equity Hedge, Barclay Long/Short '
        'Equity) have produced long-run Net CAGRs in the 6% to 9% range with Sharpe ratios '
        'typically between 0.6 and 0.9. Top-tier long-running multi-strategy and equity-focused '
        'funds (Citadel Wellington, Millennium, D.E. Shaw) have reported Net CAGRs in the 10% '
        'to 20% range with Sharpe ratios in the 1.0 to 2.5 range. The Strategy\'s backtested '
        'Net metrics exceed these benchmarks materially; investors should apply appropriate '
        'skepticism given the absence of live track record and should anticipate realized '
        'results closer to top-tier industry averages than to the backtest headline.'
    ))

    s += subsection('10. What are the risk controls?')
    s.append(body(
        '(a) <b>Position sizing</b>: 1% of NAV maximum risk per equity position, 0.5% per '
        'ETF; (b) <b>Portfolio heat caps</b>: 10% gross long exposure, 5% gross short '
        'exposure, 15% total; (c) <b>Per-ticker cap</b>: 10% of NAV notional; (d) <b>Stop '
        'loss</b>: Proprietary PNTHR Stop Loss System (PPSLS) with volatility-based ratchet '
        'plus structural range stop; stops never loosen; ratchets advance on pyramid lot '
        'fills; (e) <b>Stale position exit</b>: any position held for 20 trading days '
        'without progress is exited regardless of P&amp;L; (f) <b>Leverage cap</b>: 2:1 '
        'gross exposure maximum; (g) <b>Material Strategy Change Notice</b>: any substantive '
        'change to the Strategy requires prior written notice to Limited Partners per LPA '
        'Section 6.05.'
    ))

    # ── Section 7: Important Disclosures ─────────────────────────────────────
    s += section('Important Disclosures')

    s.append(body(
        '<b>HYPOTHETICAL PERFORMANCE RESULTS HAVE MANY INHERENT LIMITATIONS, SOME OF WHICH '
        'ARE DESCRIBED BELOW. NO REPRESENTATION IS BEING MADE THAT ANY ACCOUNT WILL OR IS '
        'LIKELY TO ACHIEVE PROFITS OR LOSSES SIMILAR TO THOSE SHOWN. IN FACT, THERE ARE '
        'FREQUENTLY SHARP DIFFERENCES BETWEEN HYPOTHETICAL PERFORMANCE RESULTS AND THE ACTUAL '
        'RESULTS SUBSEQUENTLY ACHIEVED BY ANY PARTICULAR TRADING PROGRAM.</b>'
    ))
    s.append(body(
        'One of the limitations of hypothetical performance results is that they are '
        'generally prepared with the benefit of hindsight. In addition, hypothetical trading '
        'does not involve financial risk, and no hypothetical trading record can completely '
        'account for the impact of financial risk in actual trading. For example, the ability '
        'to withstand losses or to adhere to a particular trading program in spite of trading '
        'losses are material points which can also adversely affect actual trading results. '
        'There are numerous other factors related to the markets in general or to the '
        'implementation of any specific trading program which cannot be fully accounted for '
        'in the preparation of hypothetical performance results and all of which can '
        'adversely affect actual trading results.'
    ))
    s.append(body(
        '<b>SEC Marketing Rule Notice</b>: This document contains hypothetical performance as '
        'defined in Rule 206(4)-1 under the Investment Advisers Act. Hypothetical performance '
        'is subject to additional risks and limitations. The fee assumptions, transaction '
        'costs, regulatory environment, and data sources used to produce the backtest are '
        'described fully in the Methodology section above and in the Private Placement '
        'Memorandum.'
    ))
    s.append(body(
        '<b>Regulatory Status</b>: The Fund is offered in reliance on Rule 506(c) of '
        'Regulation D; subscriptions are accepted only from investors verified as both '
        'Accredited Investors under Rule 501(a) and Qualified Clients under Rule 205-3 of '
        'the Investment Advisers Act of 1940. The Fund is exempt from registration under '
        'the Investment Company Act of 1940 in reliance on Section 3(c)(1), and is NOT '
        'relying on Section 3(c)(7); accordingly, the Fund does not require investors to '
        'be Qualified Purchasers. The Fund is limited to 100 beneficial owners.'
    ))
    s.append(body(
        '<b>Not an Offer; Governing Documents</b>: This document is confidential and the '
        'property of STT Capital Advisors, LLC. It is provided for informational purposes '
        'only and does not constitute an offer to sell or a solicitation of an offer to buy '
        'any interest in the Fund. Any such offer or solicitation will be made solely by '
        'means of the Private Placement Memorandum (PPM), the Limited Partnership Agreement '
        '(LPA), the Subscription Agreement, and related offering documents, each of which '
        'contains additional risk factors, fee disclosures, and terms. In the event of any '
        'conflict between this document and the PPM or LPA, the PPM and LPA shall govern. '
        'Prospective investors must review the complete offering documents prior to any '
        'investment decision.'
    ))
    s.append(body(
        '<b>Past Performance</b>: Past hypothetical performance is not indicative of future '
        'results. Actual live results may differ materially from backtested results, and '
        'such differences may be substantial. Investors may lose some or all of their '
        'invested capital.'
    ))
    s.append(body(
        '<b>Risk Factors</b>: An investment in the Fund involves substantial risk, including '
        'the risk of total loss of invested capital. Risks include but are not limited to: '
        'market risk, liquidity risk, strategy-decay risk, operational risk, key-person risk, '
        'tax risk, regulatory risk, cybersecurity risk, and counterparty risk. A complete '
        'discussion of risk factors is contained in the PPM Section VIII (Risk Factors). '
        'Investors should consult their own legal, tax, and financial advisors before '
        'investing.'
    ))
    s.append(body(
        '<b>Data Provenance</b>: All backtest figures are derived from: (a) Financial '
        'Modeling Prep historical OHLCV daily bars for 14 index / sector ETFs and the '
        'PNTHR 679 equity universe; (b) FMP historical S&amp;P 500 and Nasdaq 100 '
        'constituent membership events (1,518 + 436 events respectively); (c) MDY ETF '
        'current holdings as proxy for S&amp;P MidCap 400 current membership (historical '
        'MidCap 400 membership is not reconstructed); (d) weekly EMA computation at '
        'sector-specific trend-filter periods applied to sector ETFs, 21 weeks applied to '
        'index ETFs; (e) 1,713 daily NAV observations per class with mark-to-market of '
        'open positions. The backtest has not been independently audited.'
    ))
    s.append(body(
        '<b>Performance Metric Conventions.</b> Sharpe Ratio is computed from daily NAV '
        'returns using excess return over the US 3-month Treasury Bill, annualized by the '
        'square root of 252 trading days. Sortino Ratio is computed from daily NAV returns '
        'using Minimum Acceptable Return of zero, annualized by the square root of 252. '
        'Maximum Drawdown is peak-to-trough percentage decline measured on daily mark-to-'
        'market NAV. Profit Factor and Win Rate are signed at the individual trade level '
        'and are invariant to mark-to-market resolution.'
    ))
    s.append(body(
        '<b>Survivorship Bias Disclosure.</b> The backtest universe consists of approximately '
        '679 U.S. listed equities representing the current (April 2026) composition of the '
        'S&amp;P 500, Nasdaq-100, Dow Jones Industrial Average, and S&amp;P MidCap 400 indices. '
        'Historical price data is sourced from Financial Modeling Prep. Tickers that were '
        'delisted, acquired, merged, or otherwise removed from their parent index prior to '
        'April 2026 are not represented in the backtest, as historical price data for such '
        'tickers is not available in the current data source.'
    ))

    build_doc('PNTHR_Fund_Intelligence_Report_v23.pdf',
              'Fund Intelligence Report', 'v23 - April 2026 - HYPOTHETICAL BACKTEST (CONSOLIDATED 3-CLASS)', s)


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
