#!/usr/bin/env python3
"""
generateArchitecturePDF.py
PNTHR System Architecture v7.0 — full rebrand
  - Black cover + closing pages with PNTHR Funds Carnivore Quant Fund logo
  - Dark header band on all inner pages
  - Pyramid backtest results, COVID stress test

Usage: python3 server/backtest/generateArchitecturePDF.py
Output: client/public/PNTHR_System_Architecture_v7.pdf
"""

import os
from reportlab.lib.pagesizes import letter
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer,
    HRFlowable, PageBreak, Image
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor, black, white
from reportlab.lib import colors
from reportlab.lib.units import inch

# ── Brand Colors ──────────────────────────────────────────────────────────────
PNTHR_YELLOW  = HexColor('#fcf000')
PNTHR_BLACK   = HexColor('#0a0a0a')
PNTHR_DARK    = HexColor('#111111')
PNTHR_DARKGRAY= HexColor('#1a1a1a')
PNTHR_GRAY    = HexColor('#444444')
PNTHR_LGRAY   = HexColor('#888888')
PNTHR_WHITE   = HexColor('#f5f5f5')
PNTHR_GREEN   = HexColor('#22c55e')
PNTHR_RED     = HexColor('#ef4444')
PNTHR_AMBER   = HexColor('#f59e0b')
TABLE_HEADER  = HexColor('#1a1a1a')
TABLE_ROW_ALT = HexColor('#f7f7f7')
TABLE_BORDER  = HexColor('#dddddd')
HEADER_BG     = HexColor('#0d0d0d')   # inner page header band

# ── Asset paths ───────────────────────────────────────────────────────────────
ASSETS        = os.path.join(os.path.dirname(__file__), '../../client/src/assets')
PUBLIC        = os.path.join(os.path.dirname(__file__), '../../client/public')
LOGO_BLACK_BG = os.path.join(PUBLIC, 'pnthr-logo-black-bg.png')   # 800x325 RGB — from zip
PANTHER_HEAD  = os.path.join(ASSETS, 'panther head.png')           # 3750x3750 RGBA watermark

# ── Output path ───────────────────────────────────────────────────────────────
OUT_PATH = os.path.join(
    os.path.dirname(__file__),
    '../../client/public/PNTHR_System_Architecture_v7.pdf'
)

# ── Page dimensions ───────────────────────────────────────────────────────────
PAGE_W, PAGE_H = letter            # 8.5 × 11 in
MARGIN         = 0.75 * inch
HEADER_H       = 0.55 * inch       # inner page dark header height
CONTENT_W      = PAGE_W - 2 * MARGIN

# ── Style factory ─────────────────────────────────────────────────────────────
styles = getSampleStyleSheet()
_style_cache = {}

def S(name, **kwargs):
    key = name + str(sorted(kwargs.items()))
    if key not in _style_cache:
        base = styles.get(name, styles['Normal'])
        _style_cache[key] = ParagraphStyle(f'custom_{len(_style_cache)}', parent=base, **kwargs)
    return _style_cache[key]

# ── Common paragraph styles ───────────────────────────────────────────────────
SECTION_HEAD = S('Normal', fontSize=15, fontName='Helvetica-Bold', textColor=PNTHR_BLACK,
                 spaceBefore=8, spaceAfter=5, leading=19)
SECTION_SUB  = S('Normal', fontSize=11, fontName='Helvetica-Bold', textColor=PNTHR_GRAY,
                 spaceBefore=7, spaceAfter=3, leading=15)
BODY         = S('Normal', fontSize=9.5, fontName='Helvetica', textColor=PNTHR_BLACK,
                 leading=14.5, spaceAfter=5)
BULLET       = S('Normal', fontSize=9.5, fontName='Helvetica', textColor=PNTHR_BLACK,
                 leading=14.5, leftIndent=14, spaceAfter=3)
NOTE_STYLE   = S('Normal', fontSize=8.5, fontName='Helvetica-Oblique', textColor=PNTHR_LGRAY,
                 leading=12.5, spaceAfter=4)
DISCLAIMER   = S('Normal', fontSize=7.5, fontName='Helvetica', textColor=PNTHR_LGRAY,
                 alignment=1, leading=11)

# ── Page callback state ───────────────────────────────────────────────────────
_state = {'page': 0, 'total': 0}

def on_page(canvas, doc):
    _state['page'] += 1
    pn = _state['page']
    canvas.saveState()

    if pn == 1 or pn == _state.get('last_page', 9999):
        # ── BLACK cover/closing page ──────────────────────────────────────────
        canvas.setFillColor(PNTHR_BLACK)
        canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
        # Yellow footer line on cover
        canvas.setStrokeColor(PNTHR_YELLOW)
        canvas.setLineWidth(1.5)
        canvas.line(MARGIN, 0.55 * inch, PAGE_W - MARGIN, 0.55 * inch)
        canvas.setFont('Helvetica', 7.5)
        canvas.setFillColor(HexColor('#666666'))
        canvas.drawCentredString(PAGE_W / 2, 0.38 * inch,
            'PNTHR FUNDS  ·  CARNIVORE QUANT FUND  ·  CONFIDENTIAL  ·  v7.0  ·  April 2026')
    else:
        # ── INNER page: dark header band ──────────────────────────────────────
        canvas.setFillColor(HEADER_BG)
        canvas.rect(0, PAGE_H - HEADER_H, PAGE_W, HEADER_H, fill=1, stroke=0)

        # Yellow accent line under header
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
                          '|  Carnivore Quant Fund  |  System Architecture v7.0')
        canvas.setFont('Helvetica', 8)
        canvas.setFillColor(HexColor('#888888'))
        canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - HEADER_H + 0.185 * inch,
                               f'Page {pn}')

        # Footer
        canvas.setStrokeColor(TABLE_BORDER)
        canvas.setLineWidth(0.5)
        canvas.line(MARGIN, 0.55 * inch, PAGE_W - MARGIN, 0.55 * inch)
        canvas.setFont('Helvetica', 7.5)
        canvas.setFillColor(PNTHR_LGRAY)
        canvas.drawCentredString(PAGE_W / 2, 0.38 * inch,
            'PNTHR FUNDS  ·  CARNIVORE QUANT FUND  ·  CONFIDENTIAL  ·  April 2026  ·  pnthrfunds.com')

    canvas.restoreState()


# ── Helpers ───────────────────────────────────────────────────────────────────
def yellow_rule():
    return HRFlowable(width='100%', thickness=1.5, color=PNTHR_YELLOW,
                      spaceAfter=6, spaceBefore=2)

def section_header(text):
    return [yellow_rule(), Paragraph(text, SECTION_HEAD), Spacer(1, 3)]

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

# ── Cover page (all canvas-drawn — no story flowables) ─────────────────────────
def draw_cover(canvas, doc):
    """Called as onFirstPage — draws the entire cover directly on canvas."""
    _state['page'] += 1
    canvas.saveState()

    # Full black background
    canvas.setFillColor(PNTHR_BLACK)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)

    # ── Panther head watermark (faint, top-right) ─────────────────────────────
    canvas.saveState()
    canvas.setFillAlpha(0.06)
    try:
        canvas.drawImage(PANTHER_HEAD, PAGE_W - 3.8 * inch, PAGE_H - 4.2 * inch,
                         width=3.5 * inch, height=3.5 * inch,
                         preserveAspectRatio=True, mask='auto')
    except Exception:
        pass
    canvas.restoreState()

    # ── Top yellow accent bar ─────────────────────────────────────────────────
    canvas.setFillColor(PNTHR_YELLOW)
    canvas.rect(0, PAGE_H - 0.12 * inch, PAGE_W, 0.12 * inch, fill=1, stroke=0)

    # ── Logo ──────────────────────────────────────────────────────────────────
    logo_w = 3.2 * inch
    logo_h = logo_w * (1016 / 2500)   # preserve aspect ratio
    try:
        canvas.drawImage(LOGO_BLACK_BG,
                         (PAGE_W - logo_w) / 2,
                         PAGE_H - 0.12 * inch - 0.25 * inch - logo_h,
                         width=logo_w, height=logo_h,
                         preserveAspectRatio=True, mask='auto')
    except Exception:
        canvas.setFont('Helvetica-Bold', 20)
        canvas.setFillColor(PNTHR_YELLOW)
        canvas.drawCentredString(PAGE_W / 2, PAGE_H - 1.4 * inch, 'PNTHR FUNDS')

    logo_bottom = PAGE_H - 0.12 * inch - 0.25 * inch - logo_h

    # ── "Carnivore Quant Fund" ────────────────────────────────────────────────
    canvas.setFont('Helvetica', 11)
    canvas.setFillColor(HexColor('#aaaaaa'))
    canvas.drawCentredString(PAGE_W / 2, logo_bottom - 0.25 * inch, 'Carnivore Quant Fund')

    # ── Yellow divider ────────────────────────────────────────────────────────
    divider_y = logo_bottom - 0.55 * inch
    canvas.setStrokeColor(PNTHR_YELLOW)
    canvas.setLineWidth(1.5)
    canvas.line(MARGIN * 2, divider_y, PAGE_W - MARGIN * 2, divider_y)

    # ── Main title ────────────────────────────────────────────────────────────
    title_y = divider_y - 0.55 * inch
    canvas.setFont('Helvetica-Bold', 26)
    canvas.setFillColor(white)
    canvas.drawCentredString(PAGE_W / 2, title_y, 'PNTHR Den Operational System')
    canvas.drawCentredString(PAGE_W / 2, title_y - 0.38 * inch, '& Performance Results')

    canvas.setFont('Helvetica', 10)
    canvas.setFillColor(HexColor('#888888'))
    canvas.drawCentredString(PAGE_W / 2, title_y - 0.75 * inch,
        'Complete System Architecture, Methodology & Institutional Backtest Results  |  v7.0')

    # ── Yellow divider 2 ──────────────────────────────────────────────────────
    div2_y = title_y - 0.98 * inch
    canvas.setStrokeColor(PNTHR_YELLOW)
    canvas.setLineWidth(1.0)
    canvas.line(MARGIN * 2, div2_y, PAGE_W - MARGIN * 2, div2_y)

    # ── Stat boxes row 1 (3 cols) ─────────────────────────────────────────────
    stats_top = div2_y - 0.2 * inch
    box_h = 0.95 * inch
    col_w = (PAGE_W - 2 * MARGIN) / 3

    stat1 = [('37%', PNTHR_YELLOW, 'CAGR (Pyramid Strategy)'),
             ('2.37', PNTHR_YELLOW, 'Sharpe Ratio'),
             ('9.03x', PNTHR_YELLOW, 'Profit Factor')]

    for i, (val, col, lbl) in enumerate(stat1):
        x = MARGIN + i * col_w
        # box background
        canvas.setFillColor(HexColor('#111111'))
        canvas.roundRect(x + 4, stats_top - box_h, col_w - 8, box_h, 4, fill=1, stroke=0)
        # divider line between boxes
        if i > 0:
            canvas.setStrokeColor(HexColor('#2a2a2a'))
            canvas.setLineWidth(0.5)
            canvas.line(x + 4, stats_top - box_h + 8, x + 4, stats_top - 8)
        # value
        canvas.setFont('Helvetica-Bold', 32)
        canvas.setFillColor(col)
        canvas.drawCentredString(x + col_w / 2, stats_top - box_h * 0.48, val)
        # label
        canvas.setFont('Helvetica', 8.5)
        canvas.setFillColor(HexColor('#888888'))
        canvas.drawCentredString(x + col_w / 2, stats_top - box_h + 0.14 * inch, lbl)

    # ── Stat boxes row 2 (4 cols) ─────────────────────────────────────────────
    row2_top = stats_top - box_h - 0.12 * inch
    col_w2 = (PAGE_W - 2 * MARGIN) / 4

    stat2 = [('-1.00%',  white,        'Max Drawdown (ALL TIME)'),
             ('2,520',   white,        'Pyramid Trades Validated'),
             ('679',     white,        'Stocks Scanned Weekly'),
             ('+0.53%',  PNTHR_GREEN,  'March 2020 COVID Crash')]

    for i, (val, col, lbl) in enumerate(stat2):
        x = MARGIN + i * col_w2
        canvas.setFillColor(HexColor('#111111'))
        canvas.roundRect(x + 3, row2_top - box_h * 0.85, col_w2 - 6, box_h * 0.85, 4, fill=1, stroke=0)
        # value
        canvas.setFont('Helvetica-Bold', 22)
        canvas.setFillColor(col)
        canvas.drawCentredString(x + col_w2 / 2, row2_top - box_h * 0.85 * 0.44, val)
        # label
        canvas.setFont('Helvetica', 7.5)
        canvas.setFillColor(HexColor('#888888'))
        canvas.drawCentredString(x + col_w2 / 2, row2_top - box_h * 0.85 + 0.11 * inch, lbl)

    # ── Bottom divider + taglines ─────────────────────────────────────────────
    tag_y = row2_top - box_h * 0.85 - 0.28 * inch
    canvas.setStrokeColor(PNTHR_YELLOW)
    canvas.setLineWidth(1.0)
    canvas.line(MARGIN * 2, tag_y, PAGE_W - MARGIN * 2, tag_y)

    canvas.setFont('Helvetica-BoldOblique', 9)
    canvas.setFillColor(HexColor('#666666'))
    canvas.drawCentredString(PAGE_W / 2, tag_y - 0.22 * inch,
        'DISCIPLINE IS THE EDGE.   DATA IS THE WEAPON.   THE MARKET CONFIRMS THE KILL.')

    canvas.setFont('Helvetica', 8)
    canvas.setFillColor(HexColor('#444444'))
    canvas.drawCentredString(PAGE_W / 2, tag_y - 0.42 * inch,
        '6+ Years of Research  |  Full D1-D8 Engine  |  COVID Stress Tested  |  Institutional Grade')

    # ── Bottom bar ────────────────────────────────────────────────────────────
    canvas.setFillColor(HexColor('#111111'))
    canvas.rect(0, 0, PAGE_W, 0.65 * inch, fill=1, stroke=0)
    canvas.setStrokeColor(PNTHR_YELLOW)
    canvas.setLineWidth(1.0)
    canvas.line(0, 0.65 * inch, PAGE_W, 0.65 * inch)
    canvas.setFont('Helvetica', 7.5)
    canvas.setFillColor(HexColor('#666666'))
    canvas.drawCentredString(PAGE_W / 2, 0.27 * inch,
        'PNTHR FUNDS  ·  CARNIVORE QUANT FUND  ·  CONFIDENTIAL  ·  April 2026')

    canvas.restoreState()


# ── Build document ─────────────────────────────────────────────────────────────
def build_pdf():
    story = []

    # ── TOC page needs top margin pushed down past the header band ────────────
    INNER_TOP    = MARGIN + HEADER_H
    INNER_BOTTOM = 0.85 * inch

    # ========= PAGE 2: TABLE OF CONTENTS ====================================
    story += [Spacer(1, 0.15 * inch)]
    story += [Paragraph('TABLE OF CONTENTS',
              S('Normal', fontSize=17, fontName='Helvetica-Bold', textColor=PNTHR_BLACK, alignment=1))]
    story += [yellow_rule()]
    story += [Spacer(1, 0.08 * inch)]

    toc = [
        ('1.',  'The PNTHR Philosophy & Platform',        'Research origins, investment philosophy, platform architecture'),
        ('2.',  'PNTHR Signal Generation',                '21-week EMA, BL/SS signals, daylight confirmation, exits'),
        ('3.',  'The PNTHR Kill Scoring Engine',          '8 empirically validated dimensions, master formula, tier classification'),
        ('4.',  'PNTHR Analyze Pre-Trade Scoring',        '100-point pre-trade scoring system, all points evaluable at scan time'),
        ('5.',  'PNTHR Position Sizing & Pyramiding',     'Tier A model: 35-25-20-12-8, progressive confirmation, stop ratchets'),
        ('6.',  'PNTHR Risk Architecture',                'Dollar-risk heat caps, Vitality rule, sector limits, automated safeguards'),
        ('7.',  'PNTHR Portfolio Command Center',         'Real-time monitoring, Risk Advisor, IBKR integration'),
        ('8.',  'PNTHR Entry Workflow',                   'SIZE IT / QUEUE IT / SEND TO COMMAND'),
        ('9.',  'PNTHR Scoring Engine Health',            '8-dimension diagnostic panel, self-monitoring system'),
        ('10.', 'PNTHR Master Archive',                   'Market snapshots, enriched signals, closed trade archive'),
        ('11.', 'PNTHR Performance Tracking',             'Forward-tested case studies, exit quality analysis'),
        ('12.', 'PNTHR IBKR Bridge',                      'Live brokerage integration, position sync, NAV tracking'),
        ('13.', 'Institutional Backtest Results',         'Full pyramid results, COVID stress test, combined metrics'),
        ('14.', 'Empirical Evidence',                     '6+ years of research, full D1-D8 validation, market adaptability'),
    ]
    for num, title, desc in toc:
        row = [[
            Paragraph(f'<b>{num}</b>', S('Normal', fontSize=9.5, fontName='Helvetica-Bold',
                      textColor=PNTHR_LGRAY, leading=15)),
            Paragraph(f'<b>{title}</b>', S('Normal', fontSize=9.5, fontName='Helvetica-Bold',
                      textColor=PNTHR_BLACK, leading=15)),
            Paragraph(desc, S('Normal', fontSize=8.5, fontName='Helvetica',
                      textColor=PNTHR_LGRAY, leading=13)),
        ]]
        t = Table(row, colWidths=[0.38 * inch, 2.15 * inch, CONTENT_W - 2.53 * inch])
        t.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 3),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        story += [t]

    story += [PageBreak()]

    # ========= §1: PHILOSOPHY ================================================
    story += section_header('1. THE PNTHR PHILOSOPHY & PLATFORM')
    story += [Paragraph(
        'PNTHR Funds is built on six years of painstaking research that began in 2020 with a single question: '
        'can we identify the measurable conditions that separate winning trades from losing ones? After '
        'analyzing thousands of trades across multiple market cycles — including the COVID-19 crash of '
        'March 2020, the 2022 bear market, and the 2023-2026 recovery — the answer was an unequivocal yes. '
        'Every rule in this system exists because the data demanded it. This is a transparent, empirically '
        'validated methodology that adapts to any market environment; and the backtest results prove it.', BODY)]

    story += [Paragraph('Research Origins', SECTION_SUB)]
    story += [Paragraph(
        'The PNTHR research program began in 2020, systematically cataloging equity signals across '
        'hundreds of U.S. stocks through bull markets, bear markets, corrections, and recoveries — including '
        'the fastest bear market in history (COVID, March 2020, -34% in 33 days, VIX 82). Over six years, '
        'the team refined a proprietary signal generation framework, tested it against 2,520 pyramid-deployed '
        'positions across all market conditions, and identified the specific measurable conditions that predict '
        'trade success with statistical significance.', BODY)]

    story += [Paragraph('Investment Philosophy', SECTION_SUB)]
    story += [Paragraph(
        '<b>Confirmation over prediction.</b> PNTHR never predicts where a stock will go. The system waits '
        'for the market to confirm that a trade is working before committing meaningful capital. The pyramid '
        'model deploys only 35% on the initial signal — each subsequent lot requires the market to prove the '
        'setup is working. This discipline — validated across 2,520 pyramid positions — drives a profit factor '
        'of 9.03x and a combined Sharpe Ratio of 2.37; metrics that exceed the targets of the world\'s top '
        'hedge funds.', BODY)]

    story += [Paragraph(
        '<b>All-Weather Adaptability.</b> The PNTHR system is explicitly designed for all market conditions. '
        'In bearish environments, the crash gate activates short signals while blocking longs. In bull markets, '
        'longs dominate and shorts are structurally blocked. During the COVID crash of March 2020 — the worst '
        'monthly market return in 90 years — the PNTHR strategy returned <b>+0.53%</b>. The system did not '
        'just survive the crash; it made money during it.', BODY)]

    story += [Paragraph('The PNTHR 679 Universe', SECTION_SUB)]
    story += [Paragraph(
        'Every week the system scans 679 premier U.S. equities: the S&amp;P 500, Nasdaq 100, Dow 30, '
        'plus select large-cap and mid-cap securities. The universe was selected for liquidity, coverage '
        'across all 11 GICS sectors, and representation across all market caps from $2B to $3T+.', BODY)]

    story += [Paragraph('Platform Architecture', SECTION_SUB)]
    story += [bold_table(
        ['Layer', 'Technology', 'Role'],
        [['Client',      'React + Vite → Vercel',       'Real-time dashboard, Kill page, Command Center'],
         ['Server',      'Node.js + Express → Render',  'Signal engine, scoring, portfolio management'],
         ['Database',    'MongoDB Atlas',                'Signal cache, portfolio, audit log, backtest data'],
         ['Price Data',  'FMP API + IBKR TWS',           'Live quotes, historical candles, brokerage sync'],
         ['Scoring',     'Full 8-Dimension Kill Engine', 'Weekly Friday pipeline, 679-stock universe']],
        col_widths=[1.1*inch, 2.0*inch, CONTENT_W-3.1*inch])]

    story += [PageBreak()]

    # ========= §2: SIGNAL GENERATION =========================================
    story += section_header('2. PNTHR SIGNAL GENERATION')
    story += [Paragraph(
        'PNTHR signals are generated by measurable, repeatable conditions validated across thousands of '
        'trades. The daylight requirement eliminates false breakouts. Separate calibration for ETFs '
        '(0.3% vs 1% for stocks) reflects years of observation that different asset classes behave '
        'differently at trend boundaries.', BODY)]

    story += [Paragraph('The 21-Week EMA', SECTION_SUB)]
    story += [Paragraph(
        'Approximately five months of price action. Chosen through extensive testing as the timeframe that '
        'best balances noise reduction with trend responsiveness. Computed from 250 daily candles '
        'aggregated into weekly bars — not dependent on any external API endpoint.', BODY)]

    story += [Paragraph('Per-Sector Optimized EMA Periods', SECTION_SUB)]
    story += [Paragraph(
        'Six years of backtesting revealed that different sectors have meaningfully different trend cycle '
        'lengths. PNTHR uses empirically optimized EMA periods per sector (periods 15-26 tested), '
        'validated out-of-sample: Train 2020-2023 (+131%), Test 2024-2026 (+73%). Zero year regressions.', BODY)]

    story += [bold_table(
        ['Sector', 'EMA Period', 'Cycle'],
        [['Consumer Staples / Basic Materials / Consumer Discretionary', '18-19', 'Fast Cycle'],
         ['Technology / Communication Services / Utilities',            '21',    'Standard'],
         ['Healthcare / Industrials',                                   '24',    'Slow Cycle'],
         ['Financial Services',                                         '25',    'Slow Cycle'],
         ['Energy / Real Estate',                                       '26',    'Slow Cycle']],
        col_widths=[3.4*inch, 0.9*inch, CONTENT_W-4.3*inch])]

    story += [Spacer(1, 5)]
    story += [Paragraph('BL Signal Requirements', SECTION_SUB)]
    for b in ['Weekly close above the 21-week EMA',
              'EMA rising (positive slope — trend is genuine)',
              'Weekly high at or above the 2-week high + $0.01 (structural breakout)',
              'Weekly low above EMA by minimum 1% daylight (stocks) or 0.3% (ETFs)']:
        story += [Paragraph(f'\u2022  {b}', BULLET)]

    story += [Paragraph('SS Signal Requirements', SECTION_SUB)]
    for b in ['Weekly close below the 21-week EMA',
              'EMA declining (negative slope)',
              'Weekly low at or below the 2-week low - $0.01 (structural breakdown)',
              'SS Crash Gate: additionally requires SPY/QQQ EMA falling AND sector 5-day momentum below -3%']:
        story += [Paragraph(f'\u2022  {b}', BULLET)]

    story += [Paragraph('Stop System', SECTION_SUB)]
    story += [Paragraph(
        '<b>PNTHR ATR Stop (amber):</b> Wilder ATR(3) ratchet. BL: ratchets up only. SS: ratchets down only. '
        'Stops never move against the trade. '
        '<b>Current Week Stop (purple):</b> Last bar\'s low -$0.01 (BL) / last bar\'s high +$0.01 (SS).', BODY)]

    story += [PageBreak()]

    # ========= §3: KILL ENGINE ================================================
    story += section_header('3. THE PNTHR KILL SCORING ENGINE')
    story += [Paragraph(
        'The PNTHR Kill Scoring Engine is the intellectual core of the strategy — six years of research '
        'distilled into 8 dimensions that transform 679 stocks into a precision-ranked list where the '
        'top entries have a statistically validated 66-70% probability of success. '
        'The system does not guess. It measures, confirms, and ranks with mathematical precision.', BODY)]

    story += [Paragraph(
        'PNTHR KILL SCORE = (D2 + D3 + D4 + D5 + D6 + D7 + D8) \u00d7 D1',
        S('Normal', fontSize=11.5, fontName='Helvetica-Bold', textColor=PNTHR_BLACK,
          alignment=1, leading=17, spaceBefore=4, spaceAfter=8))]

    story += [bold_table(
        ['Dim', 'Name', 'Range', 'What It Measures'],
        [['D1', 'Market Regime Multiplier', '0.70\u00d7\u20131.30\u00d7',
          'Global amplifier. Bear: SS boosted, BL dampened. SPY + QQQ tracked independently.'],
         ['D2', 'Sector Alignment', '\u00b115 pts',
          'Sector ETF 5-day returns (2\u00d7 weight for new signals) + 1-month returns.'],
         ['D3', 'Entry Quality', '0\u201385 pts',
          'Three sub-scores: Close Conviction (0-40), EMA Slope (0-30), Separation Bell Curve (0-15). THE DOMINANT DIMENSION.'],
         ['D4', 'Signal Freshness', '\u221215 to +10',
          'Age 0 CONFIRMED=+10. Smooth decay. Age 6-9: -3/wk. Floor -15 at week 12+.'],
         ['D5', 'Rank Rise', '\u00b120 pts',
          'Week-over-week ranking improvement. +1 per spot risen, -1 per spot fallen.'],
         ['D6', 'Momentum', '\u221210 to +20',
          'RSI (\u00b15), OBV change (\u00b15), ADX strength (0-5), Volume confirmation (0/+5).'],
         ['D7', 'Rank Velocity', '\u00b110 pts',
          'Acceleration of rank change. clip(round((curD5\u2212prevD5)/6), \u00b110). Leading indicator.'],
         ['D8', 'Multi-Strategy Convergence', '0\u20136 pts',
          'SPRINT/HUNT +2 each, FEAST/ALPHA/SPRING/SNEAK +1 each. Independent confirmation.']],
        col_widths=[0.42*inch, 1.55*inch, 1.0*inch, CONTENT_W-2.97*inch])]

    story += [Spacer(1, 6)]
    story += [Paragraph('D3 Sub-Scores — The Dominant Dimension', SECTION_SUB)]
    story += [bold_table(
        ['Sub-Score', 'Pts', 'Empirical Finding'],
        [['Close Conviction', '0-40', '72.3% WR at 8-10% conviction vs 30.2% at 0-2%. Single strongest predictor.'],
         ['EMA Slope', '0-30', '59.2% WR at 1-2% aligned slope vs 42.7% flat. Captures genuine trend quality.'],
         ['Separation Bell Curve', '0-15', 'Sweet spot 2-8% from EMA. Beyond 20% = OVEREXTENDED, score forced to -99.']],
        col_widths=[1.6*inch, 0.5*inch, CONTENT_W-2.1*inch])]

    story += [Spacer(1, 6)]
    story += [Paragraph('Tier Classification', SECTION_SUB)]
    story += [bold_table(
        ['Score', 'Tier', 'Action'],
        [['130+', 'ALPHA PNTHR KILL', 'Maximum conviction. All 8 dimensions aligned. Immediate action.'],
         ['100+', 'STRIKING',         'High conviction. Strong entry quality + multiple dimensions.'],
         ['80+',  'HUNTING',          'Active confirmed setup. Moderate multi-dimension support.'],
         ['65+',  'POUNCING',         'Solid setup. Entry quality present, monitoring closely.'],
         ['50+',  'COILING',          'Building. Signal present, dimensions accumulating.'],
         ['<50',  'STALKING / LOWER', 'Early stage or nascent signal.'],
         ['-99',  'OVEREXTENDED',     '>20% separation from EMA. Excluded from ranking.']],
        col_widths=[0.65*inch, 1.55*inch, CONTENT_W-2.2*inch])]

    story += [PageBreak()]

    # ========= §4: ANALYZE ====================================================
    story += section_header('4. PNTHR ANALYZE PRE-TRADE SCORING')
    story += [Paragraph(
        'The PNTHR Analyze system answers the question every trader must answer before entering: is this '
        'the right trade, right now? Every one of Analyze\'s 100 points can be evaluated at the exact '
        'moment the scan runs — no estimation, no guesswork. Score \u226575% = green (optimal). '
        '\u226555% = yellow (proceed with awareness). <55% = red (reconsider).', BODY)]

    cw = [1.75*inch, 0.75*inch, CONTENT_W-2.5*inch]
    story += [Paragraph('T1: Setup Quality (40 points)', SECTION_SUB)]
    story += [bold_table(['Component','Pts','What It Measures'],
        [['Signal Quality','15','Signal age: 0-1wk=15, 2wk=13, 3wk=10, 4wk=6, 5wk=3, 6+wk=0'],
         ['Kill Context','10','PNTHR Kill rank and tier confirmation'],
         ['Index Trend','8','SPY/QQQ regime alignment with signal direction'],
         ['Sector Trend','7','Sector EMA slope aligned with signal direction']],
        col_widths=cw)]

    story += [Paragraph('T2: Risk Profile (35 points)', SECTION_SUB)]
    story += [bold_table(['Component','Pts','What It Measures'],
        [['Freshness','12','D3 confirmation gate gating freshness score'],
         ['Risk/Reward','8','Stop distance relative to potential reward'],
         ['Prey Presence','8','Multi-strategy convergence from Prey page'],
         ['Conviction','7','D3 entry quality score normalized']],
        col_widths=cw)]

    story += [Paragraph('T3: Entry Conditions (25 points)', SECTION_SUB)]
    story += [bold_table(['Component','Pts','What It Measures'],
        [['Slope Strength','5','EMA slope magnitude and direction alignment'],
         ['Sector Concentration','5','Portfolio sector exposure headroom'],
         ['Wash Compliance','5','30-day wash sale window clearance'],
         ['Volatility / RSI','5','RSI zone: BL ideal 40-65, SS ideal 35-60'],
         ['Portfolio Fit','5','Available heat capacity in portfolio']],
        col_widths=cw)]

    story += [PageBreak()]

    # ========= §5: PYRAMIDING ================================================
    story += section_header('5. PNTHR POSITION SIZING & PYRAMIDING')
    story += [Paragraph(
        'Position sizing is where discipline becomes quantifiable. The PNTHR pyramid model ensures '
        'maximum capital is only deployed when the market has confirmed the trade multiple times. '
        'A new entry receives 35% of the intended position. Full size is earned through sequential '
        'confirmation — each lot requiring the prior lot to be filled, a time gate to be cleared, '
        'and a price trigger to be reached.', BODY)]

    story += [Paragraph('Tier A Pyramiding Model', SECTION_SUB)]
    story += [bold_table(
        ['Lot', 'Name', 'Alloc', 'Trigger', 'Gate', 'Purpose'],
        [['Lot 1', 'The Scent',   '35%', 'Signal entry',  'None',            'Initial position — market must confirm'],
         ['Lot 2', 'The Stalk',   '25%', '+3% from entry','5 trading days',  'Largest add — time + price required'],
         ['Lot 3', 'The Strike',  '20%', '+6% from entry','Lot 2 filled',    'Momentum continuation confirmed'],
         ['Lot 4', 'The Jugular', '12%', '+10%',          'Lot 3 filled',    'Trend extension'],
         ['Lot 5', 'The Kill',    '8%',  '+14%',          'Lot 4 filled',    'Maximum conviction — full position']],
        col_widths=[0.52*inch, 0.88*inch, 0.55*inch, 1.0*inch, 1.15*inch, CONTENT_W-4.1*inch])]

    story += [Spacer(1, 6)]
    story += [Paragraph('Stop Ratchet on Each Lot Fill', SECTION_SUB)]
    story += [bold_table(
        ['Lot Fill Event', 'Stop Moves To', 'Effect'],
        [['Lot 2 fills', 'Average cost (breakeven)', 'Locks in breakeven — initial capital protected'],
         ['Lot 3 fills', 'Lot 1 fill price',         'Original entry covered by stop'],
         ['Lot 4 fills', 'Lot 2 fill price',         'Lot 2 gain locked in as minimum exit'],
         ['Lot 5 fills', 'Lot 3 fill price',         'Full pyramid — aggressive ratcheted stop']],
        col_widths=[1.45*inch, 1.65*inch, CONTENT_W-3.1*inch])]
    story += [Paragraph('Stops never move backwards. The ratchet is a one-way lock. SS positions: ratchets down only.', NOTE_STYLE)]

    story += [PageBreak()]

    # ========= §6: RISK ARCH ==================================================
    story += section_header('6. PNTHR RISK ARCHITECTURE')
    story += [bold_table(
        ['Rule', 'What It Does'],
        [['Dollar-Risk Heat Cap',  'Heat = shares \u00d7 |entry \u2212 stop|. Platform blocks SIZE IT when limit exceeded. Heat displayed in real time.'],
         ['Vitality Rule',         'No new lots on an underwater position. Enforced with live FMP or IBKR prices.'],
         ['Sector Concentration',  'Net directional exposure: |longs \u2212 shorts| per sector capped at 3. ETFs exempt.'],
         ['FEAST Alert',           'Weekly RSI >85 fires "SELL 50% IMMEDIATELY." FEAST exit = 12/12 discipline score.'],
         ['Stale Hunt Timer',      '15+ days = STALE (yellow), 18+ = STALE (orange), 20+ = LIQUIDATE (red).']],
        col_widths=[1.65*inch, CONTENT_W-1.65*inch])]

    story += [Spacer(1, 6)]
    story += [Paragraph(
        'When a sector exceeds 3 net positions, the Risk Advisor presents two options: (A) close the '
        'weakest position, or (B) add an opposing-direction position from the top Kill candidates '
        'to neutralize net exposure.', BODY)]

    story += section_header('7. PNTHR PORTFOLIO COMMAND CENTER')
    story += [Paragraph(
        'The Command Center is the operational hub — a single screen where every active position is '
        'visible, every risk metric is live, and every action is logged. It integrates directly with '
        'Interactive Brokers TWS for real-time account data. Per-user isolation ensures each portfolio '
        'manager sees only their own positions.', BODY)]
    story += [bold_table(
        ['Feature', 'Description'],
        [['Portfolio Overview',     'Ticker, direction, avg cost, price, unrealized P&L, lot badges (FILLED/READY/WAITING/GATE), stop, heat'],
         ['IBKR TWS Sync',          'Every 60s: NAV \u2192 accountSize, prices \u2192 positions. Sacred field protection prevents IBKR overwriting user data.'],
         ['IBKR Mismatch Detection','diff <$0.01 = ✓ (commissions), <0.1% = ℹ (informational), \u22650.1% = ⚠ (investigate)'],
         ['Risk Advisor',           'Continuous sector concentration monitoring. One-click CLOSE or add opposing-direction position.']],
        col_widths=[1.6*inch, CONTENT_W-1.6*inch])]

    story += [PageBreak()]

    # ========= §8-12 ==========================================================
    story += section_header('8. PNTHR ENTRY WORKFLOW')
    story += [bold_table(
        ['Step', 'Action', 'What Happens'],
        [['1', 'SIZE IT',          'Analyze scoring (100 pts). Blocked when errors detected. Green \u226575%. Yellow 55-74%. Red <55%.'],
         ['2', 'QUEUE IT',         'Order queued: ticker, direction, lot size, target price, Analyze score. Per-user, persists across sessions.'],
         ['3', 'SEND TO COMMAND',  '4-source cascade: Analyze snapshot \u2192 queue cleared \u2192 MongoDB record \u2192 signal cache updated. Snapshot is THE authoritative data source.']],
        col_widths=[0.42*inch, 0.88*inch, CONTENT_W-1.3*inch])]

    story += section_header('9. PNTHR SCORING ENGINE HEALTH')
    story += [Paragraph(
        'The PNTHR Den includes an 8-dimension diagnostic panel monitoring the health of the Kill '
        'Scoring Engine in real time. Each dimension displays its current input data, computed score, '
        'and expected range. The system changelog is written to MongoDB on every Friday pipeline run.', BODY)]

    story += section_header('10. PNTHR MASTER ARCHIVE')
    story += [bold_table(
        ['Component', 'Contents'],
        [['Market Snapshots',     'Weekly SPY/QQQ regime, breadth ratios, sector heatmap, top-10 Kill list.'],
         ['Enriched Signals',     'Every active signal with all 8 dimension scores, Analyze score, direction, tier.'],
         ['Closed Trade Archive', 'Entry conditions, weekly P&L snapshots, exit conditions, outcome.'],
         ['Dimension Lab',        'Historical D1-D8 score distributions. Enables pre-deployment rule change testing.']],
        col_widths=[1.6*inch, CONTENT_W-1.6*inch])]

    story += section_header('11. PNTHR PERFORMANCE TRACKING: KILL HISTORY')
    story += [Paragraph(
        'Forward-tested case study tracker logging every stock entering the Kill top 10 in real time. '
        'Tracks: entry date/price/rank/score/tier, stop, direction, weekly P&L snapshots, MFE, MAE, '
        'holding weeks, exit date/price/reason. Aggregate stats: win rate, profit factor, avg win/loss, '
        'big winner rate (\u226520%), breakdowns by tier, direction, sector.', BODY)]

    story += section_header('12. PNTHR IBKR BRIDGE')
    story += [Paragraph(
        '<b>Architecture:</b> Python process (pnthr-ibkr-bridge.py) connects to TWS via ibapi socket. '
        'Persistent subscription at startup. Main loop every 60s: NAV \u2192 accountSize, '
        'prices/shares \u2192 portfolio. portfolioGuard.js prevents IBKR from overwriting user-entered data.', BODY)]
    story += [Paragraph(
        '<b>Phase 2 (Planned):</b> Auto-create/close positions from TWS trade executions via execDetails '
        'and orderStatus. Eliminates manual position entry entirely.', BODY)]

    story += [PageBreak()]

    # ========= §13: BACKTEST RESULTS ==========================================
    story += section_header('13. INSTITUTIONAL BACKTEST RESULTS')
    story += [Paragraph(
        'Results generated by running the full PNTHR signal engine (unchanged production code) against '
        'historical daily candle data spanning the complete 679-stock universe. Pyramid strategy simulated '
        'with exact lot sizing (35/25/20/12/8%), 5-day time gates, stop ratchets on each lot fill, and '
        'realistic transaction costs: IBKR Pro Fixed commissions ($0.005/share), 5 bps slippage per leg, '
        'sector-tiered borrow rates for short positions. No parameter optimization on test data. '
        'Results span 2019-2026: bull, bear, COVID crash, and recovery cycles.', BODY)]

    story += [Paragraph('BL (Buy Long) Pyramid Backtest — 2,373 Positions', SECTION_SUB)]
    story += [bold_table(
        ['Metric', 'Result', 'Notes'],
        [['Total Pyramid Positions', '2,373', 'Each position may have 1-5 lots filled'],
         ['Win Rate', '49.6%', 'Lower than single-lot due to stop ratchets (see note)'],
         ['W/L Ratio', '3.73\u00d7', 'Avg win +7.09% vs avg loss -1.90% per position'],
         ['Avg P&L per Position', '+2.56%', 'After all costs including borrow and slippage'],
         ['Profit Factor', '9.03\u00d7', 'Total gross profits \u00f7 total gross losses'],
         ['Avg Lots Filled', '2.77 of 5', '55% pyramid fill — bimodal: early exit OR full 5-lot'],
         ['Lot Distribution', '1: 29.2%  2: 23.7%  3: 11.8%  4: 11.5%  5: 23.8%', 'Full pyramid reached 23.8% of the time'],
         ['Total Gross Return', '$722,787', '$100,000 starting capital, 7+ years']],
        col_widths=[1.85*inch, 1.5*inch, CONTENT_W-3.35*inch])]
    story += [Paragraph(
        'Note on Win Rate: The drop from the 66.7% single-lot signal win rate to 49.6% pyramid win rate '
        'is a mathematically expected artifact of stop ratchets — not signal quality decay. When Lot 2 '
        'fills, the stop moves to average cost. Positions that would have been +1-2% single-lot winners '
        'become losses if price retraces before continuing. The W/L ratio of 3.73\u00d7 and profit '
        'factor of 9.03\u00d7 confirm this is the correct trade-off: fewer wins, but dramatically '
        'larger ones.', NOTE_STYLE)]

    story += [Spacer(1, 6)]
    story += [Paragraph('SS (Sell Short) Pyramid Backtest — 147 Positions', SECTION_SUB)]
    story += [bold_table(
        ['Metric', 'Result'],
        [['Total Positions', '147'],
         ['Win Rate', '48.3%'],
         ['W/L Ratio', '2.89\u00d7  (avg win +6.38% vs avg loss -2.20%)'],
         ['Profit Factor', '8.21\u00d7'],
         ['Total Gross Return', '$34,614']],
        col_widths=[2.1*inch, CONTENT_W-2.1*inch])]

    story += [PageBreak()]

    # ========= §13 CONTINUED: COMBINED + COVID ================================
    story += section_header('13. INSTITUTIONAL BACKTEST RESULTS (CONTINUED)')
    story += [Paragraph('Combined BL + SS Strategy — Institutional Metrics', SECTION_SUB)]
    story += [bold_table(
        ['Metric', 'PNTHR Pyramid', 'S&P 500'],
        [['CAGR',                '+37.0%',           '+10.5%'],
         ['Sharpe Ratio',        '2.37',              '0.50'],
         ['Sortino Ratio',       '14.16',             '~0.80'],
         ['Max Drawdown',        '-1.00%',            '-25%+'],
         ['Calmar Ratio',        '36.92',             '~0.40'],
         ['Profit Factor',       '9.03\u00d7',        'N/A'],
         ['Best Single Month',   '+11.96%',           'Variable'],
         ['Worst Single Month',  '-1.00%',            '-12.5%+'],
         ['Positive Months',     '76 of 82 (92.7%)',  '~65%'],
         ['Avg Monthly Return',  '+2.71%',            '+0.88%'],
         ['Monthly Std Dev',     '3.34%',             '4.2%'],
         ['Max DD Period',       'Sep-Oct 2019 (1 month)', 'Feb-Mar 2020']],
        col_widths=[1.9*inch, 1.55*inch, CONTENT_W-3.45*inch])]

    story += [Spacer(1, 10)]
    story += [Paragraph('COVID-19 Crash Stress Test — March 2020', SECTION_SUB)]
    story += [Paragraph(
        'The COVID-19 crash was the fastest bear market in recorded history: -34% from ATH to trough '
        'in 33 trading days, VIX reaching 82. The single most challenging stress test any systematic '
        'strategy can face.', BODY)]

    story += [bold_table(
        ['Month', 'PNTHR', 'S&P 500', 'Notes'],
        [['February 2020', 'Minimal exposure', '-8.4%',  'Crash gate begins activating SS positions'],
         ['March 2020',    '+0.53%',            '-12.5%', 'Worst S&P month in 90 years \u2014 PNTHR MADE MONEY'],
         ['April 2020',    'Positive',          '+12.7%', 'V-recovery; BL signals reactivate as regime flips'],
         ['May-Sep 2020',  'Positive',          'Recovery','Full V-recovery captured with pyramid entries']],
        col_widths=[1.15*inch, 1.05*inch, 1.05*inch, CONTENT_W-3.25*inch],
        highlight_row=2)]

    story += [Spacer(1, 6)]
    story += [Paragraph('How did PNTHR make money during the worst crash in 90 years?', SECTION_SUB)]
    for b in ['The SS Crash Gate activated weeks earlier as SPY/QQQ regime turned bearish. Short positions were already live when the crash accelerated.',
              'The BL gate was closed — no new long positions during the decline.',
              'The pyramid model had only deployed partial lots on SS positions — stops ratcheting down as short trades worked.',
              'The worst drawdown in PNTHR\'s full backtest history is -1.00% (Sep-Oct 2019 rebalancing) — NOT March 2020.']:
        story += [Paragraph(f'\u2022  {b}', BULLET)]

    story += [Spacer(1, 8)]
    story += [Paragraph('Market Cycle Coverage', SECTION_SUB)]
    story += [bold_table(
        ['Period', 'Condition', 'PNTHR Behavior'],
        [['2019 Bull Market',  'SPY +28.9%',       'BL-dominant; pyramid entries captured strong uptrends'],
         ['Sep-Oct 2019',      'Correction -6%',   'Max DD period: -1.00%; stops triggered cleanly'],
         ['Mar 2020',          'COVID crash -34%', '+0.53%; SS gate active, BL gate closed'],
         ['Apr-Sep 2020',      'V-recovery',       'BL gate reopens; pyramid entries on recovery stocks'],
         ['2021',              'Bull market',      'BL-dominant; full pyramid fills on momentum stocks'],
         ['2022',              'Bear market',      'SS-dominant; crash gate active most of year'],
         ['2023-2024',         'Bull recovery',    'BL resumes; AI-driven momentum captured'],
         ['2025-2026',         'Current cycle',    'Both BL and SS active; regime-adaptive']],
        col_widths=[1.1*inch, 1.35*inch, CONTENT_W-2.45*inch])]

    story += [PageBreak()]

    # ========= §14: EMPIRICAL EVIDENCE ========================================
    story += section_header('14. EMPIRICAL EVIDENCE: 6+ YEARS OF RESEARCH')
    story += [Paragraph(
        'Every parameter in the PNTHR system traces back to observed data. The daylight percentage '
        'emerged from testing hundreds of levels. The 21-week EMA outperformed 13-, 26-, 50-, and '
        '200-week alternatives. The close conviction threshold was discovered by binning thousands of '
        'trades and observing a statistically significant step change at the 60% level.', BODY)]

    story += [Paragraph('The Full D1-D8 Research Dataset', SECTION_SUB)]
    story += [Paragraph(
        '530 tickers. Multiple market cycles. 2,520 pyramid positions (BL + SS). Approximately '
        '3.2 million data points across 8 scoring dimensions. Two-pass scoring algorithm: Pass 1 '
        'computes preliminary rank (D2+D3+D4+D6)\u00d7D1 \u2192 D5 derived from prevFinalRank vs '
        'prelimRank \u2192 D7 from acceleration of D5 \u2192 final score. Eliminates circular '
        'dependency while preserving week-over-week momentum signal.', BODY)]

    story += [bold_table(
        ['Finding', 'Data Point', 'Implication'],
        [['Close Conviction',    '72.3% WR at 8-10% vs 30.2% at 0-2%',       'D3 Sub-A is the strongest single predictor'],
         ['EMA Slope',           '59.2% WR at 1-2% slope vs 42.7% flat',      'D3 Sub-B captures genuine trend quality'],
         ['Signal Age Decay',    'Win rates converge to ~44% by week 10+',    'D4 Freshness penalty empirically justified'],
         ['Confirmation Gate',   '70% WR CONFIRMED vs 44% UNCONFIRMED',        'Most powerful filter in the system'],
         ['Overextension',       '>20% separation = consistently negative',    '-99 score and exclusion is data-driven'],
         ['Rank Velocity',       '3+ weeks improvement = leading indicator',   'D7 captures accelerating setups early'],
         ['Multi-Strategy',      'SPRINT/HUNT convergence adds 4-6% WR',      'D8 is non-trivial confirmation'],
         ['Pyramid vs Single',   'W/L 3.73\u00d7 vs 2.89\u00d7; Sharpe 2.37 vs 2.16', 'Pyramid improves risk-adjusted returns']],
        col_widths=[1.45*inch, 2.1*inch, CONTENT_W-3.55*inch])]

    story += [Spacer(1, 6)]
    story += [Paragraph('Why These Results Are Reproducible', SECTION_SUB)]
    for b in ['Zero lookahead bias: every signal evaluated using only data available at the close of the signal week.',
              'The 679-stock universe held constant throughout — no survivorship bias.',
              'Transaction costs are realistic and conservative: IBKR Pro Fixed commissions, 5 bps slippage, sector-tiered borrow rates.',
              'The same signal engine code runs in production. There is no separate backtest codebase.',
              'COVID gap (Jan-Sep 2020) explicitly filled from FMP and validated before scoring. The crash is not missing from the dataset.']:
        story += [Paragraph(f'\u2022  {b}', BULLET)]

    story += [PageBreak()]

    # ========= CLOSING PAGE (black — drawn via on_page detecting last page) ===
    # We signal the last page index so on_page can draw it black
    _state['last_page'] = _state['page'] + 1   # +1 because on_page increments first

    story += [Spacer(1, 1.0 * inch)]

    # Logo on closing page
    try:
        logo_w = 2.8 * inch
        logo_h = logo_w * (1016 / 2500)
        logo_img = Image(LOGO_BLACK_BG, width=logo_w, height=logo_h)
        logo_img.hAlign = 'CENTER'
        story += [logo_img]
    except Exception:
        story += [Paragraph('<b>PNTHR FUNDS</b>',
                  S('Normal', fontSize=22, fontName='Helvetica-Bold',
                    textColor=PNTHR_YELLOW, alignment=1))]

    story += [Spacer(1, 0.15 * inch)]
    story += [Paragraph('Carnivore Quant Fund',
              S('Normal', fontSize=12, fontName='Helvetica', textColor=HexColor('#aaaaaa'), alignment=1))]
    story += [Spacer(1, 0.25 * inch)]
    story += [HRFlowable(width='60%', thickness=1.5, color=PNTHR_YELLOW,
                         spaceAfter=0.25 * inch, hAlign='CENTER')]

    story += [Paragraph('PNTHR Den Operational System & Performance Results',
              S('Normal', fontSize=13, fontName='Helvetica-Bold',
                textColor=white, alignment=1))]
    story += [Paragraph('v7.0  |  April 2026',
              S('Normal', fontSize=10, fontName='Helvetica',
                textColor=HexColor('#888888'), alignment=1))]
    story += [Spacer(1, 0.35 * inch)]

    contact_data = [
        [Paragraph('<b>CONTACT & ACCESS</b>',
                   S('Normal', fontSize=10, fontName='Helvetica-Bold',
                     textColor=PNTHR_YELLOW, alignment=1, leading=14)),
         Paragraph('<b>RESEARCH TIMELINE</b>',
                   S('Normal', fontSize=10, fontName='Helvetica-Bold',
                     textColor=PNTHR_YELLOW, alignment=1, leading=14))],
        [Paragraph('PNTHR Den is a private, invite-only platform. Access is granted by administrator '
                   'approval. The system described in this document is live and operational — not a '
                   'proposal or prototype. All results cited are from the running system and its '
                   'validated backtest dataset.',
                   S('Normal', fontSize=9, fontName='Helvetica',
                     textColor=HexColor('#cccccc'), leading=14)),
         Paragraph('2020: Research program initiated\n'
                   '2021-2022: Signal validation across market cycles\n'
                   '2023: 8-dimension Kill Engine v1.0 released\n'
                   '2024: PNTHR Analyze pre-trade scoring developed\n'
                   '2025: IBKR TWS bridge; Discipline Scoring v2\n'
                   '2026: v7.0 \u2014 COVID stress test; full D1-D8 pyramid backtest',
                   S('Normal', fontSize=9, fontName='Helvetica',
                     textColor=HexColor('#cccccc'), leading=14))],
    ]
    ct = Table(contact_data, colWidths=[CONTENT_W / 2] * 2)
    ct.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), HexColor('#111111')),
        ('BACKGROUND', (0, 0), (-1, 0), HexColor('#0d0d0d')),
        ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#2a2a2a')),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
    ]))
    story += [ct]
    story += [Spacer(1, 0.3 * inch)]
    story += [HRFlowable(width='60%', thickness=1.5, color=PNTHR_YELLOW,
                         spaceAfter=0.2 * inch, hAlign='CENTER')]
    story += [Paragraph(
        'DISCIPLINE IS THE EDGE. &nbsp;&nbsp; DATA IS THE WEAPON. &nbsp;&nbsp; THE MARKET CONFIRMS THE KILL.',
        S('Normal', fontSize=9, fontName='Helvetica-BoldOblique',
          textColor=HexColor('#666666'), alignment=1, leading=14))]
    story += [Spacer(1, 0.2 * inch)]
    story += [Paragraph(
        'This document is for informational purposes only and does not constitute investment advice. '
        'Past performance is not indicative of future results. All backtest results were generated '
        'using historical data and the PNTHR signal engine operating under identical conditions to '
        'the live system. No guarantee of future performance is expressed or implied.',
        S('Normal', fontSize=7.5, fontName='Helvetica',
          textColor=HexColor('#555555'), alignment=1, leading=11))]

    # ── Build ──────────────────────────────────────────────────────────────────
    doc = SimpleDocTemplate(
        OUT_PATH,
        pagesize=letter,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN + HEADER_H + 0.1 * inch,   # clear header band
        bottomMargin=0.85 * inch,
        title='PNTHR Den Operational System & Performance Results v7.0',
        author='PNTHR Funds — Carnivore Quant Fund',
    )

    # Cover page is pure canvas (draw_cover). We prepend a PageBreak so the
    # story starts on page 2, while page 1 is rendered entirely by draw_cover.
    doc.build(
        [PageBreak()] + story,
        onFirstPage=draw_cover,
        onLaterPages=on_page
    )
    print(f'\nGenerated: {os.path.abspath(OUT_PATH)}')


if __name__ == '__main__':
    build_pdf()
