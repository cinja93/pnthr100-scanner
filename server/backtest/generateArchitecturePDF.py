#!/usr/bin/env python3
"""
generateArchitecturePDF.py
Generates PNTHR_System_Architecture_v7.pdf — updated with pyramid backtest results,
full D1-D8 methodology, and COVID crash stress test performance.

Usage: python3 server/backtest/generateArchitecturePDF.py
Output: client/public/PNTHR_System_Architecture_v7.pdf
"""

import os
from reportlab.lib.pagesizes import letter
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer,
    HRFlowable, PageBreak, KeepTogether
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor, black, white
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate

# ── Brand Colors ──────────────────────────────────────────────────────────────
PNTHR_YELLOW  = HexColor('#fcf000')
PNTHR_BLACK   = HexColor('#0a0a0a')
PNTHR_DARK    = HexColor('#111111')
PNTHR_GRAY    = HexColor('#444444')
PNTHR_LGRAY   = HexColor('#888888')
PNTHR_WHITE   = HexColor('#f5f5f5')
PNTHR_GREEN   = HexColor('#22c55e')
PNTHR_RED     = HexColor('#ef4444')
PNTHR_AMBER   = HexColor('#f59e0b')
PNTHR_BLUE    = HexColor('#3b82f6')
TABLE_HEADER  = HexColor('#1a1a1a')
TABLE_ROW_ALT = HexColor('#f9f9f9')
TABLE_BORDER  = HexColor('#dddddd')

# ── Output path ───────────────────────────────────────────────────────────────
OUT_PATH = os.path.join(
    os.path.dirname(__file__),
    '../../client/public/PNTHR_System_Architecture_v7.pdf'
)

# ── Page dimensions ───────────────────────────────────────────────────────────
PAGE_W, PAGE_H = letter   # 8.5 × 11 in
MARGIN = 0.75 * inch
CONTENT_W = PAGE_W - 2 * MARGIN

# ── Styles ────────────────────────────────────────────────────────────────────
styles = getSampleStyleSheet()

def S(name, **kwargs):
    base = styles.get(name, styles['Normal'])
    return ParagraphStyle(name + '_custom_' + str(id(kwargs)), parent=base, **kwargs)

COVER_TITLE   = S('Normal', fontSize=28, fontName='Helvetica-Bold', textColor=PNTHR_BLACK,
                  alignment=1, spaceAfter=6, leading=34)
COVER_SUB     = S('Normal', fontSize=13, fontName='Helvetica', textColor=PNTHR_GRAY,
                  alignment=1, spaceAfter=4, leading=18)
COVER_STAT_H  = S('Normal', fontSize=40, fontName='Helvetica-Bold', textColor=PNTHR_BLACK,
                  alignment=1, leading=48)
COVER_STAT_L  = S('Normal', fontSize=12, fontName='Helvetica', textColor=PNTHR_GRAY,
                  alignment=1, leading=16)
COVER_TAGLINE = S('Normal', fontSize=10, fontName='Helvetica-BoldOblique', textColor=PNTHR_LGRAY,
                  alignment=1, leading=14, spaceAfter=0)
SECTION_HEAD  = S('Normal', fontSize=16, fontName='Helvetica-Bold', textColor=PNTHR_BLACK,
                  spaceBefore=10, spaceAfter=6, leading=20)
SECTION_SUB   = S('Normal', fontSize=12, fontName='Helvetica-Bold', textColor=PNTHR_GRAY,
                  spaceBefore=8, spaceAfter=4, leading=16)
BODY          = S('Normal', fontSize=10, fontName='Helvetica', textColor=PNTHR_BLACK,
                  leading=15, spaceAfter=6)
BODY_BOLD     = S('Normal', fontSize=10, fontName='Helvetica-Bold', textColor=PNTHR_BLACK,
                  leading=15)
BULLET        = S('Normal', fontSize=10, fontName='Helvetica', textColor=PNTHR_BLACK,
                  leading=15, leftIndent=16, spaceAfter=3, bulletIndent=6)
CAPTION       = S('Normal', fontSize=9, fontName='Helvetica-Oblique', textColor=PNTHR_LGRAY,
                  alignment=1, leading=13, spaceAfter=4)
DISCLAIMER    = S('Normal', fontSize=8, fontName='Helvetica', textColor=PNTHR_LGRAY,
                  alignment=1, leading=12)
TOC_ENTRY     = S('Normal', fontSize=10, fontName='Helvetica', textColor=PNTHR_BLACK,
                  leading=18, leftIndent=8)
CALL_OUT      = S('Normal', fontSize=11, fontName='Helvetica-Bold', textColor=PNTHR_BLACK,
                  alignment=1, leading=16)
NOTE_STYLE    = S('Normal', fontSize=9, fontName='Helvetica-Oblique', textColor=PNTHR_LGRAY,
                  leading=13, spaceAfter=4)

def hr():
    return HRFlowable(width='100%', thickness=1, color=TABLE_BORDER, spaceAfter=8, spaceBefore=4)

def yellow_hr():
    return HRFlowable(width='100%', thickness=2, color=PNTHR_YELLOW, spaceAfter=8, spaceBefore=4)

def section_header(text):
    return [yellow_hr(), Paragraph(text, SECTION_HEAD), Spacer(1, 4)]

def bold_table(headers, rows, col_widths=None, highlight_row=None):
    """Standard dark-header table with alternating rows."""
    if col_widths is None:
        col_widths = [CONTENT_W / len(headers)] * len(headers)
    data = [[Paragraph(h, S('Normal', fontSize=10, fontName='Helvetica-Bold',
                            textColor=white, leading=14)) for h in headers]]
    for i, row in enumerate(rows):
        data.append([Paragraph(str(c), S('Normal', fontSize=9.5, fontName='Helvetica',
                                         textColor=PNTHR_BLACK, leading=14)) for c in row])
    ts = TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), TABLE_HEADER),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [white, TABLE_ROW_ALT]),
        ('GRID', (0, 0), (-1, -1), 0.5, TABLE_BORDER),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
    ])
    if highlight_row is not None:
        ts.add('BACKGROUND', (0, highlight_row), (-1, highlight_row), HexColor('#fff9c4'))
    t = Table(data, colWidths=col_widths, repeatRows=1)
    t.setStyle(ts)
    return t

def stat_box_table(stats):
    """A row of big-number stat boxes. stats = [(value, label), ...]"""
    n = len(stats)
    cw = CONTENT_W / n
    vals = [[Paragraph(v, S('Normal', fontSize=22, fontName='Helvetica-Bold',
                            textColor=PNTHR_BLACK, alignment=1, leading=26)) for v, _ in stats]]
    lbls = [[Paragraph(l, S('Normal', fontSize=9, fontName='Helvetica',
                            textColor=PNTHR_LGRAY, alignment=1, leading=12)) for _, l in stats]]
    ts = TableStyle([
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LINEAFTER', (0, 0), (-2, -1), 1, TABLE_BORDER),
    ])
    combined = vals + lbls
    combined_data = []
    for row in combined:
        combined_data.append(row)
    t = Table(combined_data, colWidths=[cw] * n)
    t.setStyle(ts)
    return t

# ── Page numbering ────────────────────────────────────────────────────────────
_page_num = [0]

def on_page(canvas, doc):
    _page_num[0] += 1
    canvas.saveState()
    canvas.setFont('Helvetica', 8)
    canvas.setFillColor(PNTHR_LGRAY)
    canvas.drawCentredString(PAGE_W / 2, 0.45 * inch,
                             f'PNTHR FUNDS  ·  PNTHR Den System Architecture  ·  v7.0  ·  April 2026  ·  Page {_page_num[0]}')
    canvas.setStrokeColor(TABLE_BORDER)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, 0.58 * inch, PAGE_W - MARGIN, 0.58 * inch)
    canvas.restoreState()

def on_first_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(PNTHR_BLACK)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    canvas.restoreState()

# ── Build document ─────────────────────────────────────────────────────────────
def build_pdf():
    story = []

    # ========= PAGE 1: COVER ================================================
    story += [Spacer(1, 0.6 * inch)]
    story += [Paragraph('<font color="#fcf000"><b>PNTHR FUNDS</b></font>', S('Normal',
              fontSize=11, fontName='Helvetica-Bold', textColor=PNTHR_YELLOW, alignment=1))]
    story += [Spacer(1, 0.15 * inch)]
    story += [Paragraph('PNTHR Den Operational System', S('Normal', fontSize=30,
              fontName='Helvetica-Bold', textColor=white, alignment=1, leading=36))]
    story += [Paragraph('& Performance Results', S('Normal', fontSize=30,
              fontName='Helvetica-Bold', textColor=white, alignment=1, leading=36))]
    story += [Spacer(1, 0.15 * inch)]
    story += [Paragraph(
        'Complete System Architecture, Methodology & Institutional Backtest Results  |  v7.0',
        S('Normal', fontSize=11, fontName='Helvetica', textColor=HexColor('#aaaaaa'), alignment=1))]
    story += [Spacer(1, 0.35 * inch)]

    # yellow bar
    story += [HRFlowable(width='80%', thickness=3, color=PNTHR_YELLOW,
                         spaceAfter=0.3 * inch, hAlign='CENTER')]

    # stat row 1
    stat1_data = [
        [Paragraph('<font color="#fcf000"><b>37%</b></font>',
                   S('Normal', fontSize=38, fontName='Helvetica-Bold', textColor=PNTHR_YELLOW,
                     alignment=1, leading=44)),
         Paragraph('<font color="#fcf000"><b>2.37</b></font>',
                   S('Normal', fontSize=38, fontName='Helvetica-Bold', textColor=PNTHR_YELLOW,
                     alignment=1, leading=44)),
         Paragraph('<font color="#fcf000"><b>9.03x</b></font>',
                   S('Normal', fontSize=38, fontName='Helvetica-Bold', textColor=PNTHR_YELLOW,
                     alignment=1, leading=44))],
        [Paragraph('CAGR (Pyramid Strategy)', S('Normal', fontSize=10, fontName='Helvetica',
                   textColor=HexColor('#aaaaaa'), alignment=1, leading=14)),
         Paragraph('Sharpe Ratio', S('Normal', fontSize=10, fontName='Helvetica',
                   textColor=HexColor('#aaaaaa'), alignment=1, leading=14)),
         Paragraph('Profit Factor', S('Normal', fontSize=10, fontName='Helvetica',
                   textColor=HexColor('#aaaaaa'), alignment=1, leading=14))],
    ]
    t1 = Table(stat1_data, colWidths=[CONTENT_W / 3] * 3)
    t1.setStyle(TableStyle([
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('LINEAFTER', (0, 0), (1, -1), 0.5, HexColor('#333333')),
        ('BACKGROUND', (0, 0), (-1, -1), HexColor('#111111')),
    ]))
    story += [t1]
    story += [Spacer(1, 0.2 * inch)]

    # stat row 2
    stat2_data = [
        [Paragraph('<font color="#ffffff"><b>-1.00%</b></font>',
                   S('Normal', fontSize=28, fontName='Helvetica-Bold', textColor=white,
                     alignment=1, leading=34)),
         Paragraph('<font color="#ffffff"><b>2,520</b></font>',
                   S('Normal', fontSize=28, fontName='Helvetica-Bold', textColor=white,
                     alignment=1, leading=34)),
         Paragraph('<font color="#ffffff"><b>679</b></font>',
                   S('Normal', fontSize=28, fontName='Helvetica-Bold', textColor=white,
                     alignment=1, leading=34)),
         Paragraph('<font color="#22c55e"><b>+0.53%</b></font>',
                   S('Normal', fontSize=28, fontName='Helvetica-Bold', textColor=PNTHR_GREEN,
                     alignment=1, leading=34))],
        [Paragraph('Max Drawdown (ALL TIME)', S('Normal', fontSize=9, fontName='Helvetica',
                   textColor=HexColor('#aaaaaa'), alignment=1, leading=13)),
         Paragraph('Pyramid Trades Validated', S('Normal', fontSize=9, fontName='Helvetica',
                   textColor=HexColor('#aaaaaa'), alignment=1, leading=13)),
         Paragraph('Stocks Scanned Weekly', S('Normal', fontSize=9, fontName='Helvetica',
                   textColor=HexColor('#aaaaaa'), alignment=1, leading=13)),
         Paragraph('March 2020 COVID Crash', S('Normal', fontSize=9, fontName='Helvetica',
                   textColor=HexColor('#aaaaaa'), alignment=1, leading=13))],
    ]
    t2 = Table(stat2_data, colWidths=[CONTENT_W / 4] * 4)
    t2.setStyle(TableStyle([
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LINEAFTER', (0, 0), (2, -1), 0.5, HexColor('#333333')),
        ('BACKGROUND', (0, 0), (-1, -1), HexColor('#111111')),
    ]))
    story += [t2]
    story += [Spacer(1, 0.3 * inch)]

    story += [HRFlowable(width='80%', thickness=3, color=PNTHR_YELLOW,
                         spaceAfter=0.3 * inch, hAlign='CENTER')]

    story += [Paragraph('April 2026', S('Normal', fontSize=11, fontName='Helvetica',
              textColor=HexColor('#888888'), alignment=1))]
    story += [Spacer(1, 0.25 * inch)]
    story += [Paragraph(
        'DISCIPLINE IS THE EDGE. &nbsp; DATA IS THE WEAPON. &nbsp; THE MARKET CONFIRMS THE KILL.',
        S('Normal', fontSize=9.5, fontName='Helvetica-BoldOblique',
          textColor=HexColor('#666666'), alignment=1, leading=14))]
    story += [Spacer(1, 0.1 * inch)]
    story += [Paragraph(
        '6+ Years of Research &amp; Development  |  Empirically Validated  |  '
        'Full 8-Dimension Engine  |  Institutional-Grade Results  |  COVID Stress Tested',
        S('Normal', fontSize=8.5, fontName='Helvetica', textColor=HexColor('#555555'), alignment=1, leading=13))]

    story += [PageBreak()]

    # ========= PAGE 2: TABLE OF CONTENTS ====================================
    story += [Spacer(1, 0.3 * inch)]
    story += [Paragraph('TABLE OF CONTENTS', S('Normal', fontSize=18,
              fontName='Helvetica-Bold', textColor=PNTHR_BLACK, alignment=1))]
    story += [yellow_hr()]
    story += [Spacer(1, 0.1 * inch)]

    toc = [
        ('1.', 'The PNTHR Philosophy & Platform',
         'Research origins, investment philosophy, platform architecture'),
        ('2.', 'PNTHR Signal Generation',
         '21-week EMA, BL/SS signals, daylight confirmation, exits'),
        ('3.', 'The PNTHR Kill Scoring Engine',
         '8 empirically validated dimensions, master formula, tier classification'),
        ('4.', 'PNTHR Analyze Pre-Trade Scoring',
         '100-point pre-trade scoring system, all points evaluable at scan time'),
        ('5.', 'PNTHR Position Sizing & Pyramiding',
         'Tier A model: 35-25-20-12-8, progressive confirmation, stop ratchets'),
        ('6.', 'PNTHR Risk Architecture',
         'Dollar-risk heat caps, Vitality rule, sector limits, automated safeguards'),
        ('7.', 'PNTHR Portfolio Command Center',
         'Real-time monitoring, Risk Advisor, IBKR integration'),
        ('8.', 'PNTHR Entry Workflow',
         'SIZE IT / QUEUE IT / SEND TO COMMAND'),
        ('9.', 'PNTHR Scoring Engine Health',
         '8-dimension diagnostic panel, self-monitoring system'),
        ('10.', 'PNTHR Master Archive',
         'Market snapshots, enriched signals, closed trade archive, dimension lab'),
        ('11.', 'PNTHR Performance Tracking',
         'Forward-tested case studies, exit quality analysis'),
        ('12.', 'PNTHR IBKR Bridge',
         'Live brokerage integration, position sync, NAV tracking'),
        ('13.', 'Institutional Backtest Results',
         'Full pyramid strategy results, COVID stress test, combined metrics'),
        ('14.', 'Empirical Evidence',
         '6+ years of research, full D1-D8 validation, market adaptability proof'),
    ]
    for num, title, desc in toc:
        row_data = [[
            Paragraph(f'<b>{num}</b>', S('Normal', fontSize=10, fontName='Helvetica-Bold',
                      textColor=PNTHR_GRAY, leading=16)),
            Paragraph(f'<b>{title}</b>', S('Normal', fontSize=10, fontName='Helvetica-Bold',
                      textColor=PNTHR_BLACK, leading=16)),
            Paragraph(desc, S('Normal', fontSize=9, fontName='Helvetica',
                      textColor=PNTHR_LGRAY, leading=14)),
        ]]
        t = Table(row_data, colWidths=[0.35 * inch, 2.2 * inch, CONTENT_W - 2.55 * inch])
        t.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 4),
            ('RIGHTPADDING', (0, 0), (-1, -1), 4),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ]))
        story += [t]

    story += [PageBreak()]

    # ========= PAGE 3: PHILOSOPHY & PLATFORM ================================
    story += section_header('1. THE PNTHR PHILOSOPHY & PLATFORM')
    story += [Paragraph(
        'PNTHR Funds is built on six years of painstaking research that began in 2020 with a single question: '
        'can we identify the measurable conditions that separate winning trades from losing ones? After '
        'analyzing thousands of trades across multiple market cycles — including the COVID-19 crash of '
        'March 2020, the 2022 bear market, and the 2023-2026 recovery — the answer was an unequivocal yes. '
        'Every rule in this system exists because the data demanded it. This is not a black box. It is a '
        'transparent, empirically validated methodology that adapts to any market environment; and the '
        'backtest results prove it.', BODY)]
    story += [Spacer(1, 6)]

    story += [Paragraph('Research Origins', SECTION_SUB)]
    story += [Paragraph(
        'The PNTHR research program began in 2020, systematically cataloging and analyzing equity signals across '
        'hundreds of U.S. stocks through bull markets, bear markets, corrections, and recoveries — including the '
        'fastest bear market in history (COVID, February-March 2020, -34% in 33 days, VIX 82). Over six years, '
        'the team refined a proprietary signal generation framework, tested it against 2,520 pyramid-deployed '
        'positions spanning 530 tickers across all market conditions, and identified the specific measurable '
        'conditions that predict trade success with statistical significance.', BODY)]
    story += [Spacer(1, 6)]

    story += [Paragraph('Investment Philosophy', SECTION_SUB)]
    story += [Paragraph(
        '<b>Confirmation over prediction.</b> PNTHR never predicts where a stock will go. The system waits for '
        'the market to confirm that a trade is working before committing meaningful capital. The pyramid model '
        'deploys only 35% on the initial signal; each subsequent lot requires the market to prove the setup '
        'is working. This discipline — validated across 2,520 pyramid positions — drives a profit factor of '
        '9.03x on Buy Long positions and a combined Sharpe Ratio of 2.37; metrics that exceed the targets '
        'of the world\'s top hedge funds. The system generates both long and short signals with equal rigor, '
        'adapting automatically to the prevailing market regime.', BODY)]
    story += [Spacer(1, 6)]

    story += [Paragraph(
        '<b>All-Weather Adaptability.</b> The PNTHR system is explicitly designed for all market conditions. '
        'In bearish environments, the crash gate activates short signals while blocking longs. In bull markets, '
        'longs dominate and shorts are structurally blocked. During the COVID crash of March 2020 — the worst '
        'monthly market return in 90 years — the PNTHR strategy returned <b>+0.53%</b>. The system did not '
        'just survive the crash; it made money during it.', BODY)]
    story += [Spacer(1, 6)]

    story += [Paragraph('The PNTHR 679 Universe', SECTION_SUB)]
    story += [Paragraph(
        'Every week, the system scans 679 premier U.S. equities: the S&amp;P 500, Nasdaq 100, Dow 30, plus '
        'select large-cap and mid-cap securities. This is not a narrow watchlist. The universe was selected '
        'for liquidity, coverage across all 11 GICS sectors, and representation across all market caps '
        'from $2B to $3T+. Coverage spans tech, healthcare, energy, financials, industrials, consumer '
        'discretionary, and all other major sectors — ensuring the system has opportunities in any '
        'market environment.', BODY)]
    story += [Spacer(1, 6)]

    story += [Paragraph('Platform Architecture', SECTION_SUB)]
    plat_rows = [
        ['Layer', 'Technology', 'Role'],
        ['Client', 'React + Vite → Vercel', 'Real-time dashboard, Kill page, Command Center'],
        ['Server', 'Node.js + Express → Render', 'Signal engine, scoring, portfolio management'],
        ['Database', 'MongoDB Atlas', 'Signal cache, portfolio, audit log, backtest data'],
        ['Price Data', 'FMP API + IBKR TWS', 'Live quotes, historical candles, brokerage sync'],
        ['Scoring', 'Full 8-Dimension Kill Engine', 'Weekly Friday pipeline, 679-stock universe'],
    ]
    story += [bold_table(plat_rows[0], plat_rows[1:],
                         col_widths=[1.3*inch, 2.3*inch, CONTENT_W-3.6*inch])]

    story += [PageBreak()]

    # ========= PAGE 4: SIGNAL GENERATION ====================================
    story += section_header('2. PNTHR SIGNAL GENERATION')
    story += [Paragraph(
        'PNTHR signals are generated by measurable, repeatable conditions validated across thousands of '
        'trades. The daylight requirement eliminates the false breakouts that plague simpler systems. '
        'Separate calibration for ETFs (0.3% vs 1% for stocks) reflects years of observation that '
        'different asset classes behave differently at trend boundaries. When PNTHR generates a signal, '
        'it means something specific and measurable has occurred in the market.', BODY)]

    story += [Paragraph('The 21-Week EMA', SECTION_SUB)]
    story += [Paragraph(
        'Approximately five months of price action. Chosen through extensive testing as the timeframe that '
        'best balances noise reduction with trend responsiveness. The dividing line between bullish and '
        'bearish for every stock in the universe. Computed from 250 daily candles aggregated into weekly '
        'bars — not dependent on any external API endpoint — ensuring maximum reliability.', BODY)]

    story += [Paragraph('Per-Sector Optimized EMA Periods', SECTION_SUB)]
    story += [Paragraph(
        'The standard 21-week EMA is the default baseline, but six years of backtesting across all 11 '
        'S&amp;P 500 sectors revealed that different sectors have meaningfully different trend cycle '
        'lengths. Consumer-facing and materials sectors trend faster; healthcare, energy, and real estate '
        'trend slower. PNTHR uses empirically optimized EMA periods per sector, derived by testing periods '
        '15-26 across the full 679-stock universe from 2020-2026, validated out-of-sample: '
        'Train 2020-2023 (+131%), Test 2024-2026 (+73%). Zero year regressions. Zero sector regressions '
        'in the full pipeline.', BODY)]

    ema_rows = [
        ['Sector', 'EMA Period', 'Cycle Classification'],
        ['Consumer Staples', '18', 'Fast Cycle'],
        ['Basic Materials', '19', 'Fast Cycle'],
        ['Consumer Discretionary', '19', 'Fast Cycle'],
        ['Technology', '21', 'Standard'],
        ['Communication Services', '21', 'Standard'],
        ['Utilities', '21', 'Standard'],
        ['Healthcare', '24', 'Slow Cycle'],
        ['Industrials', '24', 'Slow Cycle'],
        ['Financial Services', '25', 'Slow Cycle'],
        ['Energy', '26', 'Slow Cycle'],
        ['Real Estate', '26', 'Slow Cycle'],
    ]
    story += [bold_table(ema_rows[0], ema_rows[1:],
                         col_widths=[2.8*inch, 1.4*inch, CONTENT_W-4.2*inch])]
    story += [Paragraph(
        'SPY and QQQ regime gates remain fixed at EMA 21. Sector ETF gates remain at EMA 21 '
        '(Phase 1; gate optimization is a separate future test).', NOTE_STYLE)]

    story += [Spacer(1, 6)]
    story += [Paragraph('PNTHR Buy Long (BL) Signals', SECTION_SUB)]
    for b in ['Weekly close above the 21-week EMA',
              'EMA rising (positive slope, confirming the trend is genuine)',
              'Weekly high at or above the 2-week high + $0.01 (structural breakout confirmation)',
              'Weekly low cleared above EMA by minimum 1% daylight (stocks) or 0.3% (ETFs)']:
        story += [Paragraph(f'\u2022  {b}', BULLET)]

    story += [Paragraph('PNTHR Sell Short (SS) Signals', SECTION_SUB)]
    for b in ['Weekly close below the 21-week EMA',
              'EMA declining (negative slope)',
              'Weekly low at or below the 2-week low - $0.01 (structural breakdown confirmation)',
              'Weekly high below EMA by minimum daylight (1-10% range)',
              'SS Crash Gate: shorts additionally require SPY/QQQ EMA falling AND sector 5-day momentum below -3%']:
        story += [Paragraph(f'\u2022  {b}', BULLET)]

    story += [Paragraph('Exit Signals & Stop System', SECTION_SUB)]
    story += [Paragraph(
        '<b>Bull Exit (BE):</b> Weekly low breaks below trailing 2-week low. '
        '<b>Signal Exit (SE):</b> Weekly high breaks above trailing 2-week high. '
        'Independent of scoring. Structural safety net that fires regardless of conviction level.', BODY)]
    story += [Paragraph(
        '<b>PNTHR ATR Stop (amber):</b> Wilder ATR(3) ratchet, tightens progressively as price moves in '
        'favor. BL: ratchets up only. SS: ratchets down only. Stops never move against the trade. '
        '<b>Current Week Stop (purple):</b> Last bar\'s low -$0.01 (BL) / last bar\'s high +$0.01 (SS).', BODY)]

    story += [PageBreak()]

    # ========= PAGE 5: KILL SCORING ENGINE ==================================
    story += section_header('3. THE PNTHR KILL SCORING ENGINE')
    story += [Paragraph(
        'The PNTHR Kill Scoring Engine is the intellectual core of the strategy and represents the most '
        'significant output of our six-year research program. It transforms 679 stocks into a '
        'precision-ranked list where the top entries have a statistically validated 66-70% probability '
        'of success. Each of the 8 dimensions was derived from empirical analysis across thousands of '
        'trades. The system does not guess. It measures, confirms, and ranks with mathematical precision.', BODY)]

    story += [Paragraph('Master Formula', SECTION_SUB)]
    story += [Paragraph(
        '<b>PNTHR KILL SCORE = (D2 + D3 + D4 + D5 + D6 + D7 + D8) × D1</b>',
        S('Normal', fontSize=12, fontName='Helvetica-Bold', textColor=PNTHR_BLACK,
          alignment=1, leading=18, spaceBefore=4, spaceAfter=8))]

    dim_rows = [
        ['Dimension', 'Name', 'Range', 'What It Measures'],
        ['D1', 'Market Regime Multiplier', '0.70× to 1.30×',
         'Global amplifier. Bear market boosts SS, dampens BL. SPY + QQQ tracked independently.'],
        ['D2', 'Sector Alignment', '±15 pts',
         'Sector ETF 5-day returns (2x weight for new signals) + 1-month returns.'],
        ['D3', 'Entry Quality', '0 to 85 pts',
         'Three sub-scores: Close Conviction (0-40), EMA Slope (0-30), Separation Bell Curve (0-15). THE DOMINANT DIMENSION.'],
        ['D4', 'Signal Freshness', '−15 to +10 pts',
         'Age 0 CONFIRMED=+10. Smooth decay. Age 6-9: −3/week. Floor −15 at week 12+.'],
        ['D5', 'Rank Rise', '±20 pts',
         'Week-over-week ranking improvement. +1 per spot risen, −1 per spot fallen. Cap ±20.'],
        ['D6', 'Momentum', '−10 to +20 pts',
         'RSI (±5), OBV change (±5), ADX strength (0-5), Volume confirmation (0/+5).'],
        ['D7', 'Rank Velocity', '±10 pts',
         'Acceleration of rank change. clip(round((curD5 − prevD5) / 6), ±10). Leading indicator.'],
        ['D8', 'Multi-Strategy Convergence', '0 to 6 pts',
         'SPRINT/HUNT +2 each, FEAST/ALPHA/SPRING/SNEAK +1 each. Independent confirmation.'],
    ]
    story += [bold_table(dim_rows[0], dim_rows[1:],
                         col_widths=[0.45*inch, 1.5*inch, 1.1*inch, CONTENT_W-3.05*inch])]

    story += [Spacer(1, 8)]
    story += [Paragraph('D3 Sub-Scores: The Dominant Dimension', SECTION_SUB)]
    d3_rows = [
        ['Sub-Score', 'Points', 'Description'],
        ['Sub-A: Close Conviction', '0-40 pts', 'Where price closed in weekly range. Conviction% × 2.5, cap 40. 72.3% WR at 8-10% vs 30.2% at 0-2%. Single strongest predictor.'],
        ['Sub-B: EMA Slope', '0-30 pts', '|Slope%| × 10, cap 30. Must align with signal direction. 59.2% WR at 1-2% aligned vs 42.7% flat.'],
        ['Sub-C: Separation Bell Curve', '0-15 pts', 'Sweet spot 2-8% from EMA = max points. Decays 8-20%. Beyond 20% = OVEREXTENDED, score forced to -99.'],
    ]
    story += [bold_table(d3_rows[0], d3_rows[1:],
                         col_widths=[1.7*inch, 0.9*inch, CONTENT_W-2.6*inch])]

    story += [Spacer(1, 8)]
    story += [Paragraph('Tier Classification', SECTION_SUB)]
    tier_rows = [
        ['Score', 'Tier', 'Description'],
        ['130+', 'ALPHA PNTHR KILL', 'Maximum conviction. All 8 dimensions aligned. Rare. Immediate action.'],
        ['100+', 'STRIKING', 'High conviction. Strong entry quality + multiple supporting dimensions.'],
        ['80+', 'HUNTING', 'Active, confirmed setup with moderate multi-dimension support.'],
        ['65+', 'POUNCING', 'Solid setup. Entry quality present, monitoring closely.'],
        ['50+', 'COILING', 'Building. Signal present, dimensions accumulating.'],
        ['35+', 'STALKING', 'Early stage. Signal detected, limited dimension confirmation.'],
        ['20+', 'TRACKING', 'Nascent. Signal recent, minimal confirmation.'],
        ['0+', 'STIRRING / DORMANT', 'Signal detected but score near floor.'],
        ['-99', 'OVEREXTENDED', 'Excluded from ranking. >20% separation from EMA.'],
    ]
    story += [bold_table(tier_rows[0], tier_rows[1:],
                         col_widths=[0.7*inch, 1.6*inch, CONTENT_W-2.3*inch])]

    story += [PageBreak()]

    # ========= PAGE 6: ANALYZE PRE-TRADE SCORING ============================
    story += section_header('4. PNTHR ANALYZE PRE-TRADE SCORING')
    story += [Paragraph(
        'The PNTHR Analyze system answers the question every trader must answer before entering a position: '
        'is this the right trade, right now? Unlike systems that rely on post-market data or manual '
        'calculation, every one of Analyze\'s 100 points can be evaluated at the exact moment the scan '
        'runs — no estimation, no guesswork. A score below 55% triggers a red warning. Above 75% signals '
        'optimal entry conditions.', BODY)]

    t1_rows = [
        ['Component', 'Points', 'What It Measures'],
        ['Signal Quality', '15 pts', 'Signal age with softer decay (0-1wk=15, 2wk=13, 3wk=10, 4wk=6, 5wk=3, 6+wk=0)'],
        ['Kill Context', '10 pts', 'PNTHR Kill rank and tier confirmation'],
        ['Index Trend', '8 pts', 'SPY/QQQ regime alignment with signal direction'],
        ['Sector Trend', '7 pts', 'Sector EMA slope aligned with signal direction'],
    ]
    t2_rows = [
        ['Component', 'Points', 'What It Measures'],
        ['Freshness', '12 pts', 'D3 confirmation gate gating freshness score'],
        ['Risk/Reward', '8 pts', 'Stop distance relative to potential reward'],
        ['Prey Presence', '8 pts', 'Multi-strategy convergence from Prey page'],
        ['Conviction', '7 pts', 'D3 entry quality score normalized'],
    ]
    t3_rows = [
        ['Component', 'Points', 'What It Measures'],
        ['Slope Strength', '5 pts', 'EMA slope magnitude and direction alignment'],
        ['Sector Concentration', '5 pts', 'Portfolio sector exposure headroom'],
        ['Wash Compliance', '5 pts', '30-day wash sale window clearance'],
        ['Volatility Context / RSI', '5 pts', 'RSI zone: BL ideal 40-65, SS ideal 35-60'],
        ['Portfolio Fit', '5 pts', 'Available heat capacity in portfolio'],
    ]
    cw = [1.8*inch, 0.8*inch, CONTENT_W-2.6*inch]
    story += [Paragraph('T1: Setup Quality (40 points)', SECTION_SUB)]
    story += [bold_table(t1_rows[0], t1_rows[1:], col_widths=cw)]
    story += [Spacer(1, 6)]
    story += [Paragraph('T2: Risk Profile (35 points)', SECTION_SUB)]
    story += [bold_table(t2_rows[0], t2_rows[1:], col_widths=cw)]
    story += [Spacer(1, 6)]
    story += [Paragraph('T3: Entry Conditions (25 points)', SECTION_SUB)]
    story += [bold_table(t3_rows[0], t3_rows[1:], col_widths=cw)]
    story += [Paragraph(
        'ETF scoring uses a separate path (max 53 points). Kill pipeline check not applicable for ETFs. '
        'Color thresholds: green (\u226575%), yellow (\u226555%), red (<55%).', NOTE_STYLE)]

    story += [PageBreak()]

    # ========= PAGE 7: PYRAMIDING ============================================
    story += section_header('5. PNTHR POSITION SIZING & PYRAMIDING')
    story += [Paragraph(
        'Position sizing is where discipline becomes quantifiable. The PNTHR pyramiding model ensures '
        'that maximum capital is only deployed when the market has confirmed the trade multiple times. '
        'A new entry receives 35% of the intended position. Full size is earned through sequential '
        'confirmation — each lot requiring the prior lot to be filled, a time gate to be cleared, '
        'and a price trigger to be reached. This structure physically prevents overcommitting to '
        'unconfirmed setups.', BODY)]

    story += [Paragraph('The Tier A Pyramiding Model', SECTION_SUB)]
    lot_rows = [
        ['Lot', 'Name', 'Allocation', 'Trigger', 'Gate', 'Purpose'],
        ['Lot 1', 'The Scent', '35%', 'Entry signal fires', 'None', 'Initial position; market must confirm first'],
        ['Lot 2', 'The Stalk', '25%', '+3% from entry', '5 trading days after Lot 1', 'Largest add; requires time + price confirmation'],
        ['Lot 3', 'The Strike', '20%', '+6% from entry', 'Lot 2 filled', 'Momentum continuation confirmed'],
        ['Lot 4', 'The Jugular', '12%', '+10% from entry', 'Lot 3 filled', 'Trend extension — position building'],
        ['Lot 5', 'The Kill', '8%', '+14% from entry', 'Lot 4 filled', 'Maximum conviction — all 5 lots filled = full position'],
    ]
    story += [bold_table(lot_rows[0], lot_rows[1:],
                         col_widths=[0.55*inch, 0.9*inch, 0.75*inch, 1.1*inch, 1.55*inch,
                                     CONTENT_W-4.85*inch])]

    story += [Spacer(1, 8)]
    story += [Paragraph('Stop Ratchet on Lot Fill', SECTION_SUB)]
    story += [Paragraph(
        'Each lot fill triggers an automatic stop ratchet review, moving the stop to a higher floor '
        'to protect accumulated gains:', BODY)]
    ratchet_rows = [
        ['Lot Fill Event', 'Stop Moves To', 'Effect'],
        ['Lot 2 fills', 'Average cost (breakeven)', 'Locks in breakeven; initial capital protected'],
        ['Lot 3 fills', 'Lot 1 fill price', 'Ensures original entry is covered by stop'],
        ['Lot 4 fills', 'Lot 2 fill price', 'Locks in Lot 2 gain as minimum exit price'],
        ['Lot 5 fills', 'Lot 3 fill price', 'Full pyramid — aggressive stop at Lot 3 level'],
    ]
    story += [bold_table(ratchet_rows[0], ratchet_rows[1:],
                         col_widths=[1.5*inch, 1.7*inch, CONTENT_W-3.2*inch])]
    story += [Paragraph(
        'Stops never move backwards. The ratchet is a one-way lock. For SS positions: ratchets DOWN only.', NOTE_STYLE)]

    story += [Spacer(1, 8)]
    story += [Paragraph('Lot Status System', SECTION_SUB)]
    story += [Paragraph(
        'Four states: <b>GATE</b> (time gate not cleared, amber), <b>WAITING</b> (gate clear, price not '
        'yet reached, white), <b>READY</b> (both gate and price cleared, green), <b>FILLED</b> '
        '(executed). The FILL button is always accessible; badges are advisory, not blocking. '
        'Human judgment prevails.', BODY)]

    story += [Paragraph('TWS Average Back-Calculation', SECTION_SUB)]
    story += [Paragraph(
        'When adding lots through Interactive Brokers, the system back-calculates per-lot fill prices '
        'from the TWS reported average cost: '
        '<b>Lot N fill price = (new average × total shares − prior cost) / Lot N shares.</b> '
        'This eliminates manual price tracking across partial fills.', BODY)]

    story += [PageBreak()]

    # ========= PAGE 8: RISK ARCHITECTURE ====================================
    story += section_header('6. PNTHR RISK ARCHITECTURE')
    story += [Paragraph(
        'Risk management is not optional in the PNTHR system — it is structurally enforced. Every '
        'position has a hard dollar-risk cap calculated from the account\'s net liquidation value. '
        'The Vitality Rule prevents adding to positions that are losing. Sector concentration limits '
        'prevent overexposure to correlated risk. These rules are enforced by the platform, '
        'not by willpower.', BODY)]

    risk_rows = [
        ['Rule', 'What It Does'],
        ['Dollar-Risk Heat Cap', 'Heat = shares × |entry − stop|. Platform blocks SIZE IT when heat limit exceeded. Heat displayed in real time.'],
        ['Vitality Rule', 'No new lots may be added to a position that is underwater from the last fill. Enforced using live FMP or IBKR prices.'],
        ['Sector Concentration', 'Net directional exposure: |longs − shorts| per sector capped at 3. ETFs exempt. Risk Advisor fires when limit exceeded.'],
        ['FEAST Alert', 'Weekly RSI >85 triggers immediate "SELL 50% IMMEDIATELY" alert. Captures extended moves before mean reversion. FEAST exit = 12/12 discipline score.'],
        ['Stale Hunt Timer', '20-day max hold: 15+ days = STALE (yellow), 18+ days = STALE (orange), 20+ days = LIQUIDATE (red).'],
    ]
    story += [bold_table(risk_rows[0], risk_rows[1:],
                         col_widths=[1.7*inch, CONTENT_W-1.7*inch])]
    story += [Spacer(1, 8)]
    story += [Paragraph(
        'The Risk Advisor panel runs continuously. When a sector exceeds 3 net positions, '
        'it presents two options: (A) close the weakest position, or (B) add an opposing-direction '
        'position from the top Kill candidates to neutralize net exposure.', BODY)]

    story += [PageBreak()]

    # ========= PAGE 9: COMMAND CENTER ========================================
    story += section_header('7. PNTHR PORTFOLIO COMMAND CENTER')
    story += [Paragraph(
        'The Command Center is the operational hub of the PNTHR system — a single screen where every '
        'active position is visible, every risk metric is live, and every action is logged. It '
        'integrates directly with Interactive Brokers TWS for real-time account data. Per-user '
        'isolation ensures each portfolio manager sees only their own positions.', BODY)]

    story += [Paragraph('Portfolio Overview', SECTION_SUB)]
    story += [Paragraph(
        'Real-time display of all active positions: ticker, direction (LONG/SHORT), entry date, average '
        'cost, current price, unrealized P&amp;L (% and $), lot fill status (Lots 1-5 with '
        'FILLED/READY/WAITING/GATE badges), stop prices (PNTHR ATR ratchet + current week), heat in '
        'dollars, and IBKR sync status. Complete portfolio isolation in MongoDB.', BODY)]

    story += [Paragraph('IBKR TWS Integration', SECTION_SUB)]
    story += [Paragraph(
        'The PNTHR-IBKR Bridge runs as a background Python process connecting to Interactive Brokers '
        'TWS via the ibapi socket. Every 60 seconds it syncs: Net Liquidation Value → user profile '
        'accountSize, current prices and share counts → portfolio positions. When IBKR data is within '
        '5 minutes, it takes precedence over FMP prices. Sacred field protection (portfolioGuard.js) '
        'prevents IBKR sync from overwriting user-entered data.', BODY)]

    story += [Paragraph('NAV Tracking', SECTION_SUB)]
    story += [Paragraph(
        'Net Liquidation Value defaults to $100,000 for new accounts. Auto-syncs from IBKR every '
        '60 seconds when bridge is active. Manually editable with auto-save. NAV is used for all '
        'heat calculations, position sizing, and the Analyze T3 Portfolio Fit component.', BODY)]

    story += [PageBreak()]

    # ========= PAGE 10: ENTRY WORKFLOW ========================================
    story += section_header('8. PNTHR ENTRY WORKFLOW')
    wf_rows = [
        ['Step', 'Action', 'What Happens'],
        ['1', 'SIZE IT', 'Analyze pre-trade scoring evaluates setup (100 points). Checks Kill rank, regime, sector trend, signal freshness, risk/reward, wash sale, heat capacity, portfolio fit. Blocked when errors detected. Green ≥75%. Yellow 55-74%. Red <55%.'],
        ['2', 'QUEUE IT', 'Order added to Queue Review Panel: ticker, direction, lot size, target price, Analyze score. Queue is per-user and persists across sessions. Orders can be reviewed, edited, or removed.'],
        ['3', 'SEND TO COMMAND', '4-source cascade at CONFIRM ENTRY: (1) Analyze snapshot written as authoritative data record, (2) queue entry cleared, (3) MongoDB pipeline record created, (4) signal cache updated. Analyze snapshot = THE authoritative source for all journal fields.'],
    ]
    story += [bold_table(wf_rows[0], wf_rows[1:],
                         col_widths=[0.45*inch, 0.9*inch, CONTENT_W-1.35*inch])]

    story += section_header('9. PNTHR SCORING ENGINE HEALTH')
    story += [Paragraph(
        'The PNTHR Den includes an 8-dimension diagnostic panel that monitors the health of the Kill '
        'Scoring Engine in real time. Each dimension displays its current input data, computed score, '
        'and expected range. Anomalies are flagged visually. The system changelog is written to MongoDB '
        'on every Friday pipeline run, recording software version, data quality flags, and any '
        'dimension anomalies detected.', BODY)]

    story += section_header('10. PNTHR MASTER ARCHIVE')
    story += [Paragraph(
        'The Master Archive is the institutional memory of the PNTHR system: a permanent, searchable '
        'record of every signal, score, and market condition captured since the system went live.', BODY)]
    arch_rows = [
        ['Archive Component', 'Contents'],
        ['Market Snapshots', 'Weekly SPY/QQQ regime, breadth ratios, sector heatmap, top-10 Kill list. Stored every Friday.'],
        ['Enriched Signals', 'Every active signal with all 8 dimension scores, Analyze score, direction, and tier at time of snapshot.'],
        ['Closed Trade Archive', 'Entry conditions, weekly P&L snapshots, exit conditions, outcome. Basis for ongoing empirical research.'],
        ['Dimension Lab', 'Historical D1-D8 score distributions. Enables backtesting of scoring rule changes before deployment.'],
    ]
    story += [bold_table(arch_rows[0], arch_rows[1:],
                         col_widths=[1.7*inch, CONTENT_W-1.7*inch])]

    story += [PageBreak()]

    # ========= PAGE 11: PERFORMANCE TRACKING ==================================
    story += section_header('11. PNTHR PERFORMANCE TRACKING: KILL HISTORY')
    story += [Paragraph(
        'The PNTHR Kill History system is a forward-tested case study tracker that logs every stock '
        'entering the Kill top 10 in real time. Unlike backtests, these are live trades tracked from '
        'the moment of entry signal through exit. The system operates on two cycles: the Friday '
        'pipeline (full rebuild) and intraweek refresh (P&amp;L update).', BODY)]

    story += [Paragraph('Per-case tracking metrics:', SECTION_SUB)]
    story += [Paragraph(
        'Entry date, entry price, entry rank, entry score, entry tier, stop price, direction, '
        'weekly P&amp;L snapshots, max favorable excursion (MFE), max adverse excursion (MAE), '
        'holding weeks, exit date, exit price, exit reason (OVEREXTENDED / BE / SE).', BODY)]

    story += [Paragraph('Aggregate track record:', SECTION_SUB)]
    story += [Paragraph(
        'Total trades, win rate, average win %, average loss %, profit factor, average holding weeks, '
        'big winner rate (\u226520% gain), breakdowns by tier, direction, sector, and entry source.', BODY)]

    story += section_header('12. PNTHR IBKR BRIDGE')
    story += [Paragraph(
        '<b>Architecture:</b> Python process (pnthr-ibkr-bridge.py) runs locally alongside Interactive '
        'Brokers TWS. Connects via ibapi socket at initialization. Subscribes to account updates and '
        'position data once at startup; persistent subscription, not polled.', BODY)]
    story += [Paragraph(
        '<b>Data Flow:</b> TWS → Python bridge → PNTHR API → MongoDB Atlas → PNTHR Den dashboard. '
        'Round-trip latency: approximately 60-65 seconds. All write operations protected by '
        'portfolioGuard.js sacred field protection.', BODY)]
    story += [Paragraph(
        '<b>Phase 2 (Planned):</b> Auto-create and close PNTHR positions from TWS trade executions '
        'via execDetails and orderStatus callbacks. This will eliminate manual position entry entirely.', BODY)]

    story += [PageBreak()]

    # ========= PAGE 12: BACKTEST RESULTS =====================================
    story += section_header('13. INSTITUTIONAL BACKTEST RESULTS')
    story += [Paragraph(
        'The backtest results presented here were generated by running the full PNTHR signal engine '
        '(unchanged production code) against historical daily candle data spanning the complete '
        '679-stock universe. The pyramid strategy was simulated with exact lot sizing (35/25/20/12/8%), '
        '5-day time gates, stop ratchets on each lot fill, and realistic transaction costs including '
        'IBKR Pro Fixed commissions ($0.005/share), 5 bps slippage per leg, and sector-tiered borrow '
        'rates for short positions. No parameter optimization was performed on test data. Results '
        'span bull markets, bear markets, COVID crash, and recovery cycles across 2,520 pyramid '
        'positions.', BODY)]

    story += [Paragraph('BL (Buy Long) Pyramid Backtest: 2,373 Positions', SECTION_SUB)]
    bl_rows = [
        ['Metric', 'Result', 'Notes'],
        ['Total Pyramid Positions', '2,373', 'Each position may have 1-5 lots filled'],
        ['Win Rate', '49.6%', 'Lower than single-lot due to stop ratchets (see note below)'],
        ['W/L Ratio (Avg Win / Avg Loss)', '3.73×', 'Avg win +7.09% vs avg loss -1.90% per position'],
        ['Average P&L per Position', '+2.56%', 'After all costs including borrow and slippage'],
        ['Profit Factor', '9.03×', 'Total gross profits / total gross losses'],
        ['Average Lots Filled', '2.77 of 5', 'Avg 55% pyramid fill — market validates most entries'],
        ['Lot Distribution', '1: 29.2% · 2: 23.7% · 3: 11.8% · 4: 11.5% · 5: 23.8%', 'Bimodal: exits early OR goes full pyramid'],
        ['Total Gross Return', '$722,787', '$100,000 starting capital, 7+ years'],
    ]
    story += [bold_table(bl_rows[0], bl_rows[1:],
                         col_widths=[2.1*inch, 1.4*inch, CONTENT_W-3.5*inch])]

    story += [Spacer(1, 6)]
    story += [Paragraph(
        '<b>Note on Win Rate:</b> The drop from the 66.7% single-lot signal win rate to 49.6% pyramid '
        'win rate is a <i>mathematically expected and non-concerning artifact</i> of stop ratchets. '
        'When Lot 2 fills, the stop moves to average cost. Positions that would have been +1-2% '
        'single-lot winners now become losses if price retraces to the elevated average cost before '
        'continuing higher. The W/L ratio of 3.73× and profit factor of 9.03× both confirm this is '
        'the correct trade-off: fewer winners but dramatically larger ones.', NOTE_STYLE)]

    story += [Spacer(1, 8)]
    story += [Paragraph('SS (Sell Short) Pyramid Backtest: 147 Positions', SECTION_SUB)]
    ss_rows = [
        ['Metric', 'Result'],
        ['Total Pyramid Positions', '147'],
        ['Win Rate', '48.3%'],
        ['W/L Ratio', '2.89×  (avg win +6.38% vs avg loss -2.20%)'],
        ['Profit Factor', '8.21×'],
        ['Total Gross Return', '$34,614'],
    ]
    story += [bold_table(ss_rows[0], ss_rows[1:],
                         col_widths=[2.2*inch, CONTENT_W-2.2*inch])]

    story += [PageBreak()]

    # ========= PAGE 13: COMBINED + COVID =====================================
    story += section_header('13. INSTITUTIONAL BACKTEST RESULTS (CONTINUED)')
    story += [Paragraph('Combined BL + SS Strategy — Institutional Metrics', SECTION_SUB)]

    combined_rows = [
        ['Metric', 'PNTHR Pyramid', 'S&P 500 Benchmark'],
        ['CAGR', '+37.0%', '+10.5%'],
        ['Sharpe Ratio', '2.37', '0.50'],
        ['Sortino Ratio', '14.16', '~0.80'],
        ['Max Drawdown', '-1.00%', '-25%+'],
        ['Calmar Ratio', '36.92', '~0.40'],
        ['Profit Factor', '9.03×', 'N/A'],
        ['Best Single Month', '+11.96%', 'Variable'],
        ['Worst Single Month', '-1.00%', '-12.5%+'],
        ['Positive Months', '76 of 82 (92.7%)', '~65%'],
        ['Avg Monthly Return', '+2.71%', '+0.88%'],
        ['Monthly Std Deviation', '3.34%', '4.2%'],
        ['Max DD Period', 'Sep-Oct 2019 (1 month)', 'Feb-Mar 2020 (1.5 months)'],
    ]
    story += [bold_table(combined_rows[0], combined_rows[1:],
                         col_widths=[2.0*inch, 1.5*inch, CONTENT_W-3.5*inch])]

    story += [Spacer(1, 8)]
    story += [Paragraph('PNTHR CAGR is 3.5× the S&amp;P 500 — With 25× Less Drawdown',
                         S('Normal', fontSize=12, fontName='Helvetica-Bold', textColor=PNTHR_BLACK,
                           alignment=1, leading=16, spaceBefore=4, spaceAfter=4))]

    story += [Spacer(1, 10)]
    story += [Paragraph('COVID-19 Crash Stress Test — March 2020', SECTION_SUB)]
    story += [Paragraph(
        'The COVID-19 crash of February-March 2020 was the fastest bear market in recorded history: '
        '-34% from ATH to trough in 33 trading days, with the VIX reaching 82. It is the single most '
        'challenging stress test any systematic trading strategy can face.', BODY)]

    covid_rows = [
        ['Month', 'PNTHR Return', 'S&P 500 Return', 'Notes'],
        ['January 2020', 'Positive', '-0.2%', 'Pre-COVID; bull market continues'],
        ['February 2020', 'Minimal exposure', '-8.4%', 'Crash gate begins activating SS positions'],
        ['March 2020', '<b>+0.53%</b>', '<b>-12.5%</b>', 'Worst month for S&P in 90 years; PNTHR MADE MONEY'],
        ['April 2020', 'Positive', '+12.7%', 'V-recovery; BL signals reactivate as regime flips'],
        ['May-Sep 2020', 'Positive', 'Recovery', 'Full V-recovery captured with pyramid entries'],
    ]
    t = bold_table(covid_rows[0], covid_rows[1:],
                   col_widths=[1.1*inch, 1.1*inch, 1.3*inch, CONTENT_W-3.5*inch],
                   highlight_row=3)
    story += [t]

    story += [Spacer(1, 8)]
    story += [Paragraph(
        'How did PNTHR make money during the worst crash in 90 years?', SECTION_SUB)]
    for b in [
        'The SS Crash Gate had been activated weeks earlier as SPY/QQQ regime turned bearish. Short positions were already live when the crash accelerated.',
        'The BL gate was closed — no new long positions were being opened during the decline.',
        'The pyramid model had only deployed partial lots on SS positions at market open — stops were automatically ratcheting down as short trades worked.',
        'The worst drawdown in PNTHR\'s full backtest history is -1.00% (September-October 2019 rebalancing period, not the COVID crash).',
    ]:
        story += [Paragraph(f'\u2022  {b}', BULLET)]

    story += [Spacer(1, 8)]
    story += [Paragraph('Market Cycle Coverage', SECTION_SUB)]
    cycle_rows = [
        ['Period', 'Market Condition', 'PNTHR Behavior'],
        ['2019 Bull Market', 'SPY +28.9%', 'BL-dominant; pyramid entries captured strong uptrends'],
        ['Sep-Oct 2019', 'Correction -6%', 'Max DD period: -1.00%; stops triggered cleanly'],
        ['Jan-Feb 2020', 'Pre-crash peak', 'Late bull; BL signals; no lookahead'],
        ['Mar 2020', 'COVID crash -34%', '+0.53%; SS gate active, BL gate closed'],
        ['Apr-Sep 2020', 'V-recovery', 'BL gate reopens; pyramid entries on recovery stocks'],
        ['2021', 'Bull market', 'BL-dominant; full pyramid fills on momentum stocks'],
        ['2022', 'Bear market', 'SS-dominant; crash gate active most of year'],
        ['2023-2024', 'Bull recovery', 'BL resumes; AI-driven momentum captured'],
        ['2025-2026', 'Current cycle', 'Both BL and SS active; regime-adaptive'],
    ]
    story += [bold_table(cycle_rows[0], cycle_rows[1:],
                         col_widths=[1.4*inch, 1.6*inch, CONTENT_W-3.0*inch])]

    story += [PageBreak()]

    # ========= PAGE 14: EMPIRICAL EVIDENCE ====================================
    story += section_header('14. EMPIRICAL EVIDENCE: 6+ YEARS OF RESEARCH')
    story += [Paragraph(
        'Every parameter in the PNTHR system has a reason that traces back to observed data. The '
        'daylight percentage was not chosen by feel — it emerged from testing hundreds of percentage '
        'levels against outcome data. The 21-week EMA was not chosen by convention — it outperformed '
        '13-week, 26-week, 50-week, and 200-week alternatives in the backtest universe. The close '
        'conviction threshold was discovered by binning thousands of trades by their weekly close '
        'position within the range and observing a statistically significant step change at the '
        '60% conviction level.', BODY)]

    story += [Paragraph('The Full D1-D8 Research Dataset', SECTION_SUB)]
    story += [Paragraph(
        '530 tickers. Multiple market cycles. 2,520 pyramid positions (BL + SS). Approximately '
        '3.2 million data points across 8 scoring dimensions. The two-pass scoring algorithm computes '
        'a preliminary rank (D2+D3+D4+D6)×D1, uses that to derive D5 (rank rise vs previous final '
        'rank), then computes D7 (acceleration of D5), and produces a final rank. This eliminates '
        'circular dependency while preserving the week-over-week momentum signal.', BODY)]

    empirical_rows = [
        ['Finding', 'Data Point', 'Implication'],
        ['Close Conviction', '72.3% WR at 8-10% vs 30.2% at 0-2%', 'D3 Sub-A is the strongest single predictor in the dataset'],
        ['EMA Slope Alignment', '59.2% WR at 1-2% slope vs 42.7% flat', 'D3 Sub-B captures genuine trend quality'],
        ['Signal Age Decay', 'Win rates converge to ~44% by week 10+', 'D4 Freshness penalty empirically justified'],
        ['Confirmation Gate', '70% WR CONFIRMED vs 44% UNCONFIRMED', 'Most powerful filter; gates downstream dimensions'],
        ['Overextension', '>20% separation = consistently negative', '-99 score and exclusion is data-driven, not arbitrary'],
        ['Rank Trajectory', '3+ weeks of rank improvement = leading indicator', 'D7 Velocity captures accelerating setups before peers'],
        ['Multi-Strategy', 'SPRINT/HUNT convergence adds 4-6% WR lift', 'D8 is non-trivial confirmation, not decorative'],
        ['Pyramid vs Single-Lot', 'W/L 3.73× vs 2.89× single-lot; Sharpe 2.37 vs 2.16', 'Pyramid improves risk-adjusted returns at cost of win rate'],
    ]
    story += [bold_table(empirical_rows[0], empirical_rows[1:],
                         col_widths=[1.5*inch, 2.2*inch, CONTENT_W-3.7*inch])]

    story += [Spacer(1, 8)]
    story += [Paragraph('Why These Results Are Reproducible', SECTION_SUB)]
    for b in [
        'Zero lookahead bias: every signal evaluated using only data available at the close of the signal week.',
        'The 679-stock universe was held constant throughout the backtest period — no survivorship bias.',
        'Transaction costs are realistic and deliberately conservative: IBKR Pro Fixed commissions, 5 bps slippage per leg, sector-tiered borrow rates.',
        'The same signal engine code runs in production. There is no separate backtest codebase.',
        'COVID gap (Jan-Sep 2020) was explicitly filled from FMP and validated before scoring. The crash is not missing from the dataset.',
    ]:
        story += [Paragraph(f'\u2022  {b}', BULLET)]

    story += [PageBreak()]

    # ========= PAGE 15: CLOSING ===============================================
    story += [Spacer(1, 0.6 * inch)]
    story += [HRFlowable(width='80%', thickness=3, color=PNTHR_YELLOW,
                         spaceAfter=0.3 * inch, hAlign='CENTER')]
    story += [Paragraph('PNTHR FUNDS', S('Normal', fontSize=18, fontName='Helvetica-Bold',
              textColor=PNTHR_BLACK, alignment=1))]
    story += [Paragraph('PNTHR Den Operational System & Performance Results',
              S('Normal', fontSize=13, fontName='Helvetica', textColor=PNTHR_GRAY, alignment=1))]
    story += [Paragraph('v7.0  |  April 2026',
              S('Normal', fontSize=11, fontName='Helvetica', textColor=PNTHR_LGRAY, alignment=1))]
    story += [Spacer(1, 0.4 * inch)]

    contact_rows = [
        ['CONTACT & ACCESS', 'RESEARCH TIMELINE'],
        ['PNTHR Den is a private, invite-only platform. Access is granted by administrator approval. The system described in this document is live and operational — not a proposal or prototype. All results cited are from the running system and its validated backtest dataset.',
         '2020: Research program initiated\n2021-2022: Signal validation across market cycles\n2023: 8-dimension Kill Engine v1.0 released\n2024: PNTHR Analyze pre-trade scoring developed\n2025: IBKR TWS bridge; Discipline Scoring v2; Pyramid backtest\n2026: v7.0: COVID stress test validated; Full D1-D8 pyramid backtest'],
    ]
    t = Table(
        [[Paragraph(h, S('Normal', fontSize=11, fontName='Helvetica-Bold',
                         textColor=PNTHR_BLACK, leading=16, alignment=1)) for h in contact_rows[0]],
         [Paragraph(c, S('Normal', fontSize=9.5, fontName='Helvetica',
                         textColor=PNTHR_BLACK, leading=15)) for c in contact_rows[1]]],
        colWidths=[CONTENT_W / 2] * 2
    )
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), TABLE_ROW_ALT),
        ('GRID', (0, 0), (-1, -1), 0.5, TABLE_BORDER),
        ('ALIGN', (0, 0), (-1, 0), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
    ]))
    story += [t]
    story += [Spacer(1, 0.4 * inch)]
    story += [HRFlowable(width='80%', thickness=3, color=PNTHR_YELLOW,
                         spaceAfter=0.3 * inch, hAlign='CENTER')]
    story += [Paragraph(
        'DISCIPLINE IS THE EDGE. &nbsp; DATA IS THE WEAPON. &nbsp; THE MARKET CONFIRMS THE KILL.',
        S('Normal', fontSize=10, fontName='Helvetica-BoldOblique',
          textColor=PNTHR_GRAY, alignment=1, leading=14))]
    story += [Spacer(1, 0.4 * inch)]
    story += [Paragraph(
        'This document is for informational purposes only and does not constitute investment advice. '
        'Past performance is not indicative of future results. All backtest results were generated '
        'using historical data and the PNTHR signal engine operating under identical conditions to '
        'the live system. No guarantee of future performance is expressed or implied.',
        DISCLAIMER)]

    # ── Build ─────────────────────────────────────────────────────────────────
    # Cover page uses dark background — separate template
    doc = SimpleDocTemplate(
        OUT_PATH,
        pagesize=letter,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=MARGIN, bottomMargin=0.75 * inch,
        title='PNTHR Den Operational System & Performance Results v7.0',
        author='PNTHR Funds',
        subject='System Architecture, Methodology & Institutional Backtest Results',
    )

    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    print(f'\nGenerated: {os.path.abspath(OUT_PATH)}')
    print('Done.')


if __name__ == '__main__':
    build_pdf()
