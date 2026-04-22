#!/usr/bin/env python3
"""
generatePerTierIR.py — PNTHR Per-Tier Pyramid Intelligence Report v2

Rebuilt to mirror the approved v6 Intelligence Report design EXACTLY:
  - Black background on every page
  - Yellow section headings with yellow underline rules
  - White body text
  - Top header: "PNTHR FUNDS" yellow + breadcrumb + page number, with yellow rule
  - Bottom footer: gray rule + centered confidential line
  - Cover = dashboard (logo + title + Fund Overview + Headline Tiles + Glance
    + Cumulative Growth chart + Panther mascot quote)
  - Table of Contents (Act I / II / III / IV)
  - Act I:  Exec Summary, Perf Comp, Gross vs Net, Fees, Crisis Alpha, Annual,
            By Direction, Heatmap, Drawdown, Risk, MAE, Rolling 12M, Best/Worst
  - Act II: 14 Methodology sections (Philosophy, Signal Gen, Kill Engine,
            Analyze, Sizing, Command Center, Entry Workflow, Scoring Health,
            Archive, Kill History, IBKR Bridge, Backtest Results, Empirical
            Evidence, Summary)
  - Act III: Comprehensive Daily NAV Log — every trading day with activity
             (OPEN: TICKER1, TICKER2 (all BL/SS) | CLOSE: TICKER +/-$X) plus
             monthly TOTAL rows with opened/closed counts + net P&L
  - Act IV: Cumulative Growth chart, Executive Recap, Summary ("A System Built
            to Win in Every Market"), Methodology & Assumptions, Important
            Disclosures

Data sources:
  ~/Downloads/pnthr_ir_metrics_{100k,500k,1m}_2026_04_21.json
  (produced by server/scripts_den/compute_per_tier_ir_metrics.js which reads
  the canonical v22-MTM + PPM-fee corrected collections)

Output:
  ~/Downloads/PNTHR_Pyramid_IR_{Filet,Porterhouse,Wagyu}_v1.pdf
"""

import os
import json
import sys
from datetime import datetime

from reportlab.lib.pagesizes import letter
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer,
    HRFlowable, PageBreak, Image as RLImage, KeepTogether
)
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT, TA_JUSTIFY

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from datetime import datetime as _dt

# ── Brand palette (matches approved v6 IR design) ────────────────────────────
YELLOW  = HexColor('#fcf000')
BLACK   = HexColor('#000000')
DARK    = HexColor('#0a0a0a')
WHITE   = HexColor('#ffffff')
OFFWHT  = HexColor('#e8e8e8')
LGRAY   = HexColor('#aaaaaa')
MGRAY   = HexColor('#777777')
DGRAY   = HexColor('#444444')
VDGRAY  = HexColor('#222222')
GREEN   = HexColor('#22c55e')
RED     = HexColor('#ef4444')
DIM_G   = HexColor('#16a34a')   # deeper green for large positives on black
DIM_R   = HexColor('#dc2626')

# Heatmap colors
def heatmap_bg(pct):
    if pct is None:
        return VDGRAY
    if pct > 0:
        intensity = min(abs(pct) / 12.0, 1.0)
        r = int(20 + 20 * (1 - intensity))
        g = int(80 + 120 * intensity)
        b = int(20 + 20 * (1 - intensity))
        return HexColor(f'#{r:02x}{g:02x}{b:02x}')
    if pct < 0:
        intensity = min(abs(pct) / 5.0, 1.0)
        r = int(100 + 100 * intensity)
        g = int(30 + 10 * (1 - intensity))
        b = int(30 + 10 * (1 - intensity))
        return HexColor(f'#{r:02x}{g:02x}{b:02x}')
    return VDGRAY

# ── Paths ────────────────────────────────────────────────────────────────────
HERE    = os.path.dirname(os.path.abspath(__file__))
PUBLIC  = os.path.join(HERE, '../../client/public')
ASSETS  = os.path.join(HERE, '../../client/src/assets')
OUT_DIR = os.path.expanduser('~/Downloads')
TMP_DIR = '/tmp/pnthr_ir_charts'
LOGO_BLACK_BG = os.path.join(PUBLIC, 'pnthr-logo-black-bg.png')
PANTHER_HEAD  = os.path.join(ASSETS, 'panther-head-sm.png')

os.makedirs(TMP_DIR, exist_ok=True)

# ── Page geometry ────────────────────────────────────────────────────────────
PAGE_W, PAGE_H = letter
MARGIN_L = 0.75 * inch
MARGIN_R = 0.75 * inch
MARGIN_T = 0.90 * inch  # room for top header + yellow rule
MARGIN_B = 0.80 * inch  # room for bottom rule + footer
CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R

# ── Paragraph styles (all tuned for black-page readability) ──────────────────
_style_cache = {}
def S(name, **kwargs):
    key = name + repr(sorted(kwargs.items()))
    if key in _style_cache: return _style_cache[key]
    defaults = {'fontName': 'Helvetica', 'fontSize': 9.5, 'leading': 12.5, 'textColor': WHITE}
    defaults.update(kwargs)
    st = ParagraphStyle(name + str(id(kwargs)), **defaults)
    _style_cache[key] = st
    return st

def section_heading(text):
    """Yellow uppercase heading + full-width yellow rule underneath (v6 style)."""
    return [
        Spacer(1, 4),
        Paragraph(f'<b>{text}</b>', S('sect', fontSize=14, leading=18, textColor=YELLOW, fontName='Helvetica-Bold', alignment=TA_LEFT)),
        HRFlowable(width='100%', thickness=0.8, color=YELLOW, spaceBefore=2, spaceAfter=8),
    ]

def subsection_heading(text):
    """Yellow subsection heading, no rule (v6 style)."""
    return [
        Spacer(1, 4),
        Paragraph(f'<b>{text}</b>', S('sub', fontSize=11, leading=14, textColor=YELLOW, fontName='Helvetica-Bold', alignment=TA_LEFT)),
        Spacer(1, 2),
    ]

def body_p(text):
    return Paragraph(text, S('body', fontSize=10, leading=13, textColor=OFFWHT, alignment=TA_JUSTIFY))

def bullet_p(text):
    return Paragraph(f'- {text}', S('bul', fontSize=10, leading=13, textColor=OFFWHT, leftIndent=12))

def note_p(text):
    return Paragraph(text, S('note', fontSize=8.5, leading=11, textColor=LGRAY, fontName='Helvetica-Oblique'))

# ── Formatters ───────────────────────────────────────────────────────────────
def fmt_pct(v, plus_on_pos=True, decimals=1):
    if v is None: return '-'
    sign = '+' if (plus_on_pos and v > 0) else ''
    return f'{sign}{v:.{decimals}f}%'

def fmt_usd(v, compact=False):
    if v is None: return '-'
    if compact:
        if abs(v) >= 1e6: return f'${v/1e6:.2f}M'
        if abs(v) >= 1e3: return f'${v/1e3:.0f}K'
    return f'${v:,.0f}'

def fmt_usd_precise(v):
    if v is None: return '-'
    return f'${v:,.0f}'

def fmt_pnl_color(amt):
    """Return an HTML fragment coloring a dollar P&L (+green / -red)."""
    if amt is None: return ''
    if amt >= 0:
        return f'<font color="#22c55e">+${amt:,}</font>'
    return f'<font color="#ef4444">-${abs(amt):,}</font>'

def fmt_pct_color(v, decimals=2):
    """Color a percent: green if positive, red if negative."""
    if v is None: return '-'
    sign = '+' if v > 0 else ''
    color = '#22c55e' if v > 0 else ('#ef4444' if v < 0 else '#ffffff')
    return f'<font color="{color}">{sign}{v:.{decimals}f}%</font>'

# ── Chrome (full black page + top header + yellow rule + bottom footer) ──────
def _draw_chrome(canvas, doc, is_cover=False):
    canvas.saveState()
    # Full-bleed black background
    canvas.setFillColor(BLACK)
    canvas.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)

    # Top header (breadcrumb + page number) — skipped on the cover which owns
    # its own logo treatment.
    if not is_cover:
        y_top = PAGE_H - 0.50 * inch
        canvas.setFillColor(YELLOW)
        canvas.setFont('Helvetica-Bold', 8.5)
        canvas.drawString(MARGIN_L, y_top, 'PNTHR FUNDS')
        brand_w = canvas.stringWidth('PNTHR FUNDS', 'Helvetica-Bold', 8.5)
        canvas.setFillColor(OFFWHT)
        canvas.setFont('Helvetica', 8.5)
        canvas.drawString(MARGIN_L + brand_w + 6, y_top,
                          '|  Carnivore Quant Fund  |  Institutional Tear Sheet')
        canvas.setFillColor(OFFWHT)
        canvas.drawRightString(PAGE_W - MARGIN_R, y_top, f'Page {doc.page}')

    # Yellow thin rule under top header (also on cover, just lower)
    rule_y = PAGE_H - 0.62 * inch if not is_cover else PAGE_H - 0.36 * inch
    canvas.setStrokeColor(YELLOW)
    canvas.setLineWidth(0.75)
    canvas.line(MARGIN_L, rule_y, PAGE_W - MARGIN_L, rule_y)

    # Bottom: thin gray rule + centered confidential footer line
    canvas.setStrokeColor(DGRAY)
    canvas.setLineWidth(0.35)
    canvas.line(MARGIN_L, 0.52 * inch, PAGE_W - MARGIN_R, 0.52 * inch)
    canvas.setFillColor(LGRAY)
    canvas.setFont('Helvetica', 8)
    canvas.drawCentredString(
        PAGE_W / 2.0, 0.32 * inch,
        'PNTHR FUNDS  -  CARNIVORE QUANT FUND  -  CONFIDENTIAL  -  April 2026  -  pnthrfunds.com'
    )
    canvas.restoreState()

def on_cover(canvas, doc):
    _draw_chrome(canvas, doc, is_cover=True)

def on_page(canvas, doc):
    _draw_chrome(canvas, doc, is_cover=False)

# ── Document factory ─────────────────────────────────────────────────────────
def build_doc(filename, title_meta, story):
    out_path = os.path.join(OUT_DIR, filename)
    doc = SimpleDocTemplate(
        out_path, pagesize=letter,
        leftMargin=MARGIN_L, rightMargin=MARGIN_R,
        topMargin=MARGIN_T, bottomMargin=MARGIN_B,
        title=title_meta, author='PNTHR Funds, LLC',
        subject='Pyramid Intelligence Report',
    )
    doc.build(story, onFirstPage=on_cover, onLaterPages=on_page)
    return out_path

# ── Chart helpers (dark theme) ───────────────────────────────────────────────
def generate_growth_chart(tier, path, big=False):
    """Yellow PNTHR equity line vs white dashed SPY, on black bg."""
    daily = tier['gross']['dailySeries']
    pnthr_xs = [_dt.strptime(d['date'], '%Y-%m-%d') for d in daily]
    pnthr_ys = [d['net'] if d['net'] is not None else d['gross'] for d in daily]
    spy_ys   = [d['spyEquity'] for d in daily]

    w, h = (7.2, 3.0) if big else (5.0, 2.2)
    fig, ax = plt.subplots(figsize=(w, h), dpi=130)
    fig.patch.set_facecolor('#000000')
    ax.set_facecolor('#000000')

    ax.plot(pnthr_xs, pnthr_ys, color='#fcf000', linewidth=1.6, label=f'PNTHR Fund (${tier["seedNav"]:,})')
    ax.plot(pnthr_xs, spy_ys, color='#cccccc', linewidth=1.0, linestyle='--', label=f'S&P 500 (${tier["seedNav"]:,})')

    ax.tick_params(colors='#888888', labelsize=7)
    for spine in ax.spines.values():
        spine.set_color('#333333')
    ax.grid(True, color='#1a1a1a', linewidth=0.4)
    def usd_fmt(v, _):
        if v >= 1e6: return f'${v/1e6:.1f}M'
        if v >= 1e3: return f'${v/1e3:.0f}K'
        return f'${v:.0f}'
    ax.yaxis.set_major_formatter(plt.FuncFormatter(usd_fmt))
    if big:
        ax.set_title(f'Cumulative Growth ({pnthr_xs[0].year}-{pnthr_xs[-1].year})',
                     color='#ffffff', fontsize=10, pad=8, loc='left')
    ax.legend(facecolor='#000000', edgecolor='#222222', labelcolor='#cccccc',
              fontsize=7, loc='upper left')
    fig.tight_layout()
    fig.savefig(path, facecolor='#000000', dpi=130, bbox_inches='tight')
    plt.close(fig)

def generate_underwater_chart(tier, path):
    daily = tier['gross']['dailySeries']
    xs = [_dt.strptime(d['date'], '%Y-%m-%d') for d in daily]
    dd = [d['netDD'] if d['netDD'] is not None else d['grossDD'] for d in daily]

    fig, ax = plt.subplots(figsize=(7.0, 2.1), dpi=130)
    fig.patch.set_facecolor('#000000')
    ax.set_facecolor('#000000')
    ax.fill_between(xs, dd, 0, color='#fcf000', alpha=0.30)
    ax.plot(xs, dd, color='#fcf000', linewidth=1.0, label='PNTHR Fund')
    ax.axhline(y=-34.1, color='#888888', linestyle='--', linewidth=0.6, alpha=0.6)
    ax.text(xs[2], -33, 'S&P 500 max DD reference: -34.1%', color='#888888', fontsize=6)
    ax.tick_params(colors='#888888', labelsize=7)
    for spine in ax.spines.values():
        spine.set_color('#333333')
    ax.grid(True, color='#1a1a1a', linewidth=0.4)
    ax.set_ylim(min(dd) * 1.2, 2)
    fig.tight_layout()
    fig.savefig(path, facecolor='#000000', dpi=130, bbox_inches='tight')
    plt.close(fig)

# ════════════════════════════════════════════════════════════════════════════
# SECTION BUILDERS
# ════════════════════════════════════════════════════════════════════════════

def section_cover(t):
    """v6 dashboard cover: logo + title + Fund Overview + Headline tiles +
    Glance table + Cumulative Growth chart + Panther mascot quote."""
    s = []
    net = t['net']
    trades = t['trades']

    # Logo centered at top
    if os.path.exists(LOGO_BLACK_BG):
        logo_w = 3.2 * inch
        logo = RLImage(LOGO_BLACK_BG, width=logo_w, height=logo_w * 0.406)
        logo.hAlign = 'CENTER'
        s.append(logo)

    s.append(Spacer(1, 14))

    # Title + subtitle
    s.append(Paragraph(
        f'<font color="#ffffff"><b>PNTHR FUND Intelligence Report {fmt_usd(t["seedNav"], compact=True)}</b></font>',
        S('cov_t', fontSize=22, leading=26, textColor=WHITE, alignment=TA_CENTER, fontName='Helvetica-Bold')))
    s.append(Spacer(1, 4))
    start_year = t['gross']['startDate'][:4]
    end_year = t['gross']['endDate'][:4]
    s.append(Paragraph(
        f'<font color="#cccccc">7-Year Backtest Performance Report  |  June {start_year} - April {end_year}</font>',
        S('cov_s1', fontSize=10.5, leading=13, alignment=TA_CENTER, textColor=OFFWHT)))
    s.append(Paragraph(
        '<font color="#cccccc">Pyramiding 5 Lot Strategy</font>',
        S('cov_s2', fontSize=10.5, leading=13, alignment=TA_CENTER, textColor=OFFWHT)))
    s.append(HRFlowable(width='40%', thickness=0.6, color=HexColor('#444444'),
                        spaceBefore=6, spaceAfter=10, hAlign='CENTER'))

    # FUND OVERVIEW
    s.append(Paragraph('<b>FUND OVERVIEW</b>',
                       S('cov_h', fontSize=10, leading=13, textColor=YELLOW, fontName='Helvetica-Bold')))
    s.append(Spacer(1, 4))
    ov_rows = [
        ['Strategy',        'Systematic Long/Short U.S. Equity'],
        ['Structure',       'Reg D, Rule 506(c), 3(c)(1) Exempt Fund'],
        ['Universe',        '679 liquid U.S. equities (PNTHR 679)'],
        ['Signal Engine',   'Proprietary 21-week EMA crossover + 8-dimension scoring'],
        ['Position Sizing', '1% max risk per trade, 10% max portfolio risk exposure'],
        ['Pyramiding',      '5-lot entry system (35/25/20/12/8%)'],
        ['Backtest Capital', f'{fmt_usd(t["seedNav"])} starting NAV (Pyramid sizing)'],
        ['Benchmark',       'S&P 500 (SPY)'],
    ]
    ov_tbl = Table(ov_rows, colWidths=[1.5*inch, CONTENT_W - 1.5*inch])
    ov_tbl.setStyle(TableStyle([
        ('FONTNAME',   (0,0), (0,-1), 'Helvetica-Bold'),
        ('TEXTCOLOR',  (0,0), (0,-1), YELLOW),
        ('TEXTCOLOR',  (1,0), (1,-1), OFFWHT),
        ('FONTSIZE',   (0,0), (-1,-1), 9),
        ('ALIGN',      (0,0), (-1,-1), 'LEFT'),
        ('TOPPADDING', (0,0), (-1,-1), 2),
        ('BOTTOMPADDING', (0,0), (-1,-1), 2),
        ('LEFTPADDING',(0,0), (-1,-1), 0),
    ]))
    s.append(ov_tbl)
    s.append(Spacer(1, 10))

    # HEADLINE NUMBERS — 12 tiles (3 rows × 4 cols) on black page.
    s.append(Paragraph(
        '<b><font color="#fcf000">HEADLINE NUMBERS</font></b>  '
        '<font color="#888888" size="8">(all figures NET of fees - see page 3 for full Gross vs Net breakdown)</font>',
        S('hn_h', fontSize=10, leading=13, fontName='Helvetica-Bold')))
    s.append(Spacer(1, 4))

    tiles = [
        [(f'+{net["totalReturn"]:.0f}%', 'Net Total Return', GREEN),
         (f'+{net["cagr"]:.1f}%', 'Net Compound Annual Growth Rate (CAGR)', GREEN),
         (f'{net["sharpe"]:.2f}', 'Sharpe Ratio', YELLOW),
         (f'{net["sortino"]:.2f}', 'Sortino Ratio', YELLOW)],
        [(f'{trades["combined"]["profitFactor"]:.1f}x', 'Profit Factor', GREEN),
         (f'{net["calmar"]:.1f}', 'Calmar Ratio', YELLOW),
         (f'{net["maxDD"]:.2f}%', 'Max Peak-to-Trough (MTM)', RED),
         (f'{net["positivePct"]:.1f}%', 'Positive Months', GREEN)],
        [(f'+{net["bestMonth"]["ret"]:.1f}%', 'Best Month', GREEN),
         (f'{trades["closed"]:,}', 'Total Closed Trades', YELLOW),
         (fmt_usd(net['endNav'], compact=True), f'Ending Equity ({fmt_usd(t["seedNav"])} start)', GREEN),
         (f'+{fmt_usd(net["endNav"] - t["spy"]["endingEquity"], compact=True)}', 'PNTHR Alpha vs S&P 500', GREEN)],
    ]
    tile_w = CONTENT_W / 4
    for row in tiles:
        cells = []
        for val, label, color in row:
            hex_color = f'#{int(color.red*255):02x}{int(color.green*255):02x}{int(color.blue*255):02x}'
            cells.append([
                Paragraph(f'<font color="{hex_color}"><b>{val}</b></font>',
                          S('tv', fontSize=17, leading=20, alignment=TA_LEFT, fontName='Helvetica-Bold')),
                Paragraph(f'<font color="#888888">{label}</font>',
                          S('tl', fontSize=7, leading=9, alignment=TA_LEFT)),
            ])
        tbl = Table([cells], colWidths=[tile_w]*4)
        tbl.setStyle(TableStyle([
            ('VALIGN',    (0,0), (-1,-1), 'TOP'),
            ('LEFTPADDING',(0,0), (-1,-1), 2),
            ('RIGHTPADDING',(0,0), (-1,-1), 8),
            ('TOPPADDING',(0,0), (-1,-1), 4),
            ('BOTTOMPADDING',(0,0), (-1,-1), 4),
        ]))
        s.append(tbl)

    s.append(Spacer(1, 8))

    # PNTHR vs S&P 500 AT A GLANCE
    s.append(Paragraph('<b>PNTHR vs S&amp;P 500 AT A GLANCE</b>',
                       S('gl_h', fontSize=10, leading=13, textColor=YELLOW, fontName='Helvetica-Bold')))
    s.append(Spacer(1, 3))
    gl_rows = [
        ['',
         Paragraph('<b><font color="#fcf000">PNTHR (NET)</font></b>', S('ghr_p', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<b><font color="#ffffff">S&amp;P 500</font></b>',   S('ghr_s', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<b><font color="#22c55e">ALPHA</font></b>',          S('ghr_a', fontSize=9, alignment=TA_RIGHT))],
        ['Total Return',
         Paragraph(f'<font color="#fcf000">+{net["totalReturn"]:.1f}%</font>',                      S('gr1', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ffffff">+{t["spy"]["totalReturn"]:.1f}%</font>',                 S('gr2', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">+{net["totalReturn"] - t["spy"]["totalReturn"]:.1f}%</font>', S('gr3', fontSize=9, alignment=TA_RIGHT))],
        ['CAGR',
         Paragraph(f'<font color="#fcf000">+{net["cagr"]:.1f}%</font>',                             S('gr4', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ffffff">+{t["spy"]["cagr"]:.1f}%</font>',                        S('gr5', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">+{net["cagr"] - t["spy"]["cagr"]:.1f}%</font>',          S('gr6', fontSize=9, alignment=TA_RIGHT))],
        ['Max Monthly Peak-to-Trough',
         Paragraph(f'<font color="#ef4444">{net["maxDD"]:.2f}%</font>',                             S('gr7', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ef4444">{t["spy"]["maxDD"]:.1f}%</font>',                        S('gr8', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#ffffff">-</font>',                                                S('gr9', fontSize=9, alignment=TA_RIGHT))],
        ['Ending Equity',
         Paragraph(f'<font color="#fcf000">{fmt_usd(net["endNav"], compact=True)}</font>',          S('gr10', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ffffff">{fmt_usd(t["spy"]["endingEquity"], compact=True)}</font>',S('gr11', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">{fmt_usd(net["endNav"] - t["spy"]["endingEquity"], compact=True)}</font>', S('gr12', fontSize=9, alignment=TA_RIGHT))],
    ]
    # Wrap first-col row labels
    for row in gl_rows[1:]:
        row[0] = Paragraph(f'<font color="#cccccc">{row[0]}</font>', S('glbl', fontSize=9))
    col_w = (CONTENT_W - 2.2*inch) / 3
    gl_tbl = Table(gl_rows, colWidths=[2.2*inch, col_w, col_w, col_w])
    gl_tbl.setStyle(TableStyle([
        ('ALIGN',   (1,0), (-1,-1), 'RIGHT'),
        ('VALIGN',  (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING',(0,0), (-1,-1), 3),
        ('BOTTOMPADDING',(0,0), (-1,-1), 3),
        ('LINEBELOW', (0,0), (-1,0), 0.4, DGRAY),
    ]))
    s.append(gl_tbl)
    s.append(Spacer(1, 10))

    # Panther mascot + Cumulative growth chart side-by-side
    chart_path = os.path.join(TMP_DIR, f'cov_growth_{t["tier"]}.png')
    generate_growth_chart(t, chart_path, big=False)
    mascot_cell = []
    if os.path.exists(PANTHER_HEAD):
        pm = RLImage(PANTHER_HEAD, width=1.2*inch, height=1.2*inch)
        pm.hAlign = 'CENTER'
        mascot_cell.append(pm)
    mascot_cell.append(Spacer(1, 4))
    mascot_cell.append(Paragraph(
        '<font color="#cccccc"><i>"Now I\'m going to show you<br/>how we got these<br/>world class returns"</i></font>',
        S('q', fontSize=8.5, leading=11, alignment=TA_CENTER, textColor=OFFWHT)))
    mascot_cell.append(Spacer(1, 4))
    mascot_cell.append(Paragraph(
        '<font color="#fcf000"><b>~ PNTHR</b></font>',
        S('q2', fontSize=10, leading=12, alignment=TA_CENTER, textColor=YELLOW, fontName='Helvetica-Bold')))
    chart_img = RLImage(chart_path, width=CONTENT_W - 1.7*inch, height=2.0*inch)
    bottom = Table([[mascot_cell, chart_img]], colWidths=[1.7*inch, CONTENT_W - 1.7*inch])
    bottom.setStyle(TableStyle([('VALIGN', (0,0), (-1,-1), 'MIDDLE')]))
    s.append(bottom)
    s.append(Spacer(1, 6))

    # Confidential footer (cover only — repeats essentials above the standard bottom footer)
    s.append(Paragraph(
        '<font color="#888888">CONFIDENTIAL - For Qualified Investors Only - Not an Offer to Sell Securities</font>',
        S('cf1', fontSize=7.5, leading=10, alignment=TA_CENTER, textColor=MGRAY)))
    s.append(Paragraph(
        '<font color="#666666">Past performance is not indicative of future results. See full disclaimers on final page.</font>',
        S('cf2', fontSize=7.5, leading=10, alignment=TA_CENTER, textColor=HexColor('#666666'))))

    s.append(PageBreak())
    return s


def section_fees(t):
    s = section_heading('FEES & EXPENSES SCHEDULE')
    s.append(body_p(
        'All NET performance figures in this document reflect the complete fee and cost schedule below, which mirrors '
        'the PNTHR Private Placement Memorandum (PPM v6.9). Every item is drawn directly from the PPM; nothing in this '
        'section is illustrative. Investors should read this section in conjunction with the full PPM, which controls '
        'in any case of conflict.'
    ))
    s += subsection_heading('1. Management Fee')
    s.append(bullet_p('<b>Rate:</b> 2.0% per annum on Net Asset Value.'))
    s.append(bullet_p('<b>Accrual:</b> Monthly, at a rate of 2.0% / 12 = 0.1667% per month.'))
    s.append(bullet_p('<b>Payment:</b> Quarterly, in advance (per PPM). The backtest applies the fee monthly for simulation; the economic impact is substantively equivalent.'))

    s += subsection_heading('2. Performance Allocation (Tiered by Investor Class)')
    fee_rows = [
        ['Filet Class',       '< $500,000',           '30%', '25%'],
        ['Porterhouse Class', '$500,000 - $999,999',  '25%', '20%'],
        ['Wagyu Class',       '>= $1,000,000',        '20%', '15%'],
    ]
    current_label = {'100k': 'Filet Class', '500k': 'Porterhouse Class', '1m': 'Wagyu Class'}[t['tier']]
    rendered = []
    for row in fee_rows:
        is_cur = (row[0] == current_label)
        row_cells = [
            Paragraph(f'<font color="#fcf000"><b>{row[0]}</b></font>' if is_cur else f'<font color="#ffffff">{row[0]}</font>',
                      S('fr0', fontSize=9)),
            Paragraph(f'<font color="#ffffff">{row[1]}</font>', S('fr1', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#ffffff">{row[2]}</font>', S('fr2', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#ffffff">{row[3]}</font>', S('fr3', fontSize=9, alignment=TA_RIGHT)),
        ]
        rendered.append(row_cells)
    s.append(_dark_table(
        ['INVESTOR CLASS', 'THRESHOLD', 'YEARS 1-3', 'YR 4+ (LOYALTY)'],
        rendered,
        col_widths=[1.8*inch, 1.8*inch, (CONTENT_W-3.6*inch)/2, (CONTENT_W-3.6*inch)/2],
    ))
    s.append(Spacer(1, 4))
    s.append(bullet_p('<b>Loyalty Discount:</b> A 5 percentage-point reduction applies after 36 consecutive months of investment.'))
    s.append(bullet_p('<b>High Water Mark:</b> Performance allocation is charged only on net profits above the running HWM.'))
    s.append(bullet_p('<b>Calculation Frequency:</b> Quarterly, non-cumulative. Each quarter evaluated independently.'))

    s += subsection_heading('3. Hurdle Rate (US 2-Year Treasury Yield)')
    s.append(body_p(
        'The performance allocation hurdle is the US 2-Year Treasury constant-maturity yield on the first trading day '
        'of each calendar year, divided by four for quarterly application. The hurdle is non-cumulative: each quarter '
        'is evaluated independently.'
    ))
    hurdles = [
        ['2019', '2.50%',  '0.625%',  fmt_usd(t['seedNav']*0.025)],
        ['2020', '1.58%',  '0.395%',  fmt_usd(t['seedNav']*0.0158)],
        ['2021', '0.11%',  '0.0275%', fmt_usd(t['seedNav']*0.0011)],
        ['2022', '0.78%',  '0.195%',  fmt_usd(t['seedNav']*0.0078)],
        ['2023', '4.40%',  '1.10%',   fmt_usd(t['seedNav']*0.044)],
        ['2024', '4.33%',  '1.0825%', fmt_usd(t['seedNav']*0.0433)],
        ['2025', '4.25%',  '1.0625%', fmt_usd(t['seedNav']*0.0425)],
        ['2026', '3.47%',  '0.8675%', fmt_usd(t['seedNav']*0.0347)],
    ]
    h_rows = [[
        Paragraph(f'<font color="#ffffff">{r[0]}</font>', S(f'h0{i}', fontSize=9)),
        Paragraph(f'<font color="#ffffff">{r[1]}</font>', S(f'h1{i}', fontSize=9, alignment=TA_RIGHT)),
        Paragraph(f'<font color="#ffffff">{r[2]}</font>', S(f'h2{i}', fontSize=9, alignment=TA_RIGHT)),
        Paragraph(f'<font color="#fcf000">{r[3]}</font>', S(f'h3{i}', fontSize=9, alignment=TA_RIGHT)),
    ] for i, r in enumerate(hurdles)]
    s.append(_dark_table(
        ['YEAR', 'US2Y YIELD', 'QUARTERLY HURDLE', f'ANNUAL HURDLE ON {fmt_usd(t["seedNav"], compact=True)}'],
        h_rows,
        col_widths=[0.8*inch, 1.4*inch, 1.6*inch, CONTENT_W - 3.8*inch],
    ))

    s += subsection_heading('4. Trading Costs (Fund-Level Operating Expenses)')
    s.append(bullet_p('<b>Brokerage Commissions:</b> IBKR Pro Fixed: $0.005 per share, $1 min, 1% of trade value max. Modeled in GROSS and NET.'))
    s.append(bullet_p('<b>Slippage:</b> 5 basis points per leg as a market-impact proxy. Modeled in GROSS and NET.'))
    s.append(bullet_p('<b>Short Borrow Costs:</b> Sector-tiered annualized rates of 1.0% - 2.0% on notional. Modeled in GROSS and NET.'))
    s.append(bullet_p('<b>Ongoing Operating Expenses:</b> Estimated at 0.1-0.3% of NAV p.a. NOT separately modeled; investors should adjust expected NET returns accordingly.'))

    s += subsection_heading('5. Fee Schedule Applied in this Document')
    s.append(body_p(
        f'This document reports the {fmt_usd(t["seedNav"])} NAV variant. Per PPM v6.9 sec. 4.2, the investor class '
        f'applicable at this starting capital is <b>{t["classLabel"]}</b>, and the backtest applies the {t["classLabel"]} '
        f'fee schedule exactly: <b>{t["feeSchedule"]["yearsOneToThree"]}%</b> performance allocation years 1-3 and '
        f'<b>{t["feeSchedule"]["yearsFourPlus"]}%</b> thereafter (36-month loyalty discount).'
    ))
    s.append(PageBreak())

    # Fee drag summary
    s.append(body_p(
        f'Every NET figure in this document is computed from a daily equity curve produced by the PPM fee engine. '
        f'That engine applies the 2.0%/12 management fee monthly on then-current NAV and the performance allocation '
        f'QUARTERLY (March/June/September/December), non-cumulative, on the portion of quarter-end NAV that exceeds '
        f'BOTH the running High Water Mark AND the quarterly hurdle (US2Y / 4). HWM carries forward; hurdle does not.'
    ))
    s += subsection_heading(f'6. Total Fee Drag Over the {t["net"]["totalMonths"]}-Month Backtest')
    gross = t['gross']; net = t['net']
    avg_nav = (t['seedNav'] + net['endNav']) / 2
    mgmt = 0.02 * avg_nav * net['years']
    perf = gross['endNav'] - net['endNav'] - mgmt
    s.append(bullet_p(f'<b>Starting NAV:</b> {fmt_usd(t["seedNav"])} (PPM tier: {t["classLabel"]})'))
    s.append(bullet_p(
        f'<b>Ending Equity:</b> {fmt_usd(gross["endNav"], compact=True)} GROSS vs '
        f'{fmt_usd(net["endNav"], compact=True)} NET, a total fund-fee drag of '
        f'{fmt_usd(gross["endNav"] - net["endNav"], compact=True)}.'))
    s.append(bullet_p(f'<b>Management Fee:</b> ~{fmt_usd(mgmt, compact=True)} cumulative (2.0% p.a.).'))
    s.append(bullet_p(f'<b>Performance Allocation:</b> ~{fmt_usd(perf, compact=True)} cumulative at the {t["classLabel"]} rate.'))
    s.append(bullet_p(f'<b>Return Drag:</b> -{gross["totalReturn"] - net["totalReturn"]:.1f} pts on Total Return; -{gross["cagr"] - net["cagr"]:.2f} pts on CAGR.'))
    s.append(PageBreak())
    return s


# ────────────────────────────────────────────────────────────────────────────
# ACT II — THE METHODOLOGY
# ────────────────────────────────────────────────────────────────────────────
def section_methodology(t):
    s = []
    # 1. Philosophy & Platform
    s += section_heading('1. THE PNTHR PHILOSOPHY & PLATFORM')
    s += subsection_heading('Research Origins')
    s.append(body_p(
        'PNTHR Funds is built on seven years of painstaking research and testing that began in 2019 with a single '
        'question: can we identify the measurable conditions that separate winning trades from losing ones? After '
        'analyzing thousands of trades across multiple market cycles, including the COVID-19 crash of March 2020, '
        'the 2022 bear market, and the 2023-2026 recovery, the answer was an unequivocal yes. Every rule in this '
        'system exists because the data demanded it. This is a transparent, empirically validated methodology that '
        'adapts to any market environment; and the backtest results prove it.'
    ))
    s += subsection_heading('Investment Philosophy')
    s.append(body_p(
        'Confirmation over prediction. PNTHR never predicts where a stock will go. The system waits for the market '
        'to confirm that a trade is working before committing meaningful capital. The pyramid model deploys only '
        '35% of a maximum risk of only 1% on the initial signal; each subsequent lot requires the market to prove '
        f'the setup is working. This discipline, validated across {t["trades"]["closed"]:,} pyramid positions, drives '
        f'a profit factor of {t["trades"]["combined"]["profitFactor"]:.2f}x and a combined Sharpe Ratio of {t["net"]["sharpe"]:.2f}; '
        f'metrics that exceed the targets of the world\'s top hedge funds.'
    ))
    s.append(body_p(
        'All-Weather Adaptability. The PNTHR system is explicitly designed for all market conditions. In bearish '
        'environments, the crash gate activates short signals while blocking longs. In bull markets, longs dominate '
        'and shorts are structurally blocked. During the COVID crash of March 2020, the worst monthly market return '
        'in 90 years, the PNTHR strategy returned positive. The system did not just survive the crash; it made money during it.'
    ))
    s += subsection_heading('The PNTHR 679 Universe')
    s.append(body_p(
        'Every week the system scans 679 premier U.S. equities: the S&P 500, Nasdaq 100, Dow 30, plus select large-cap '
        'and mid-cap securities. The universe was selected for liquidity, coverage across all 11 GICS sectors, and '
        'representation across all market caps from $2B to $3T+.'
    ))
    s += subsection_heading('Platform Architecture')
    arch_rows = [
        ['Client',    'React + Vite (Vercel)',       'Real-time dashboard, Kill page, Command Center'],
        ['Server',    'Node.js + Express (Render)',  'Signal engine, scoring, portfolio management'],
        ['Database',  'MongoDB Atlas',                'Signal cache, portfolio, audit log, backtest data'],
        ['Price Data','FMP API + IBKR TWS',          'Live quotes, historical candles, brokerage sync'],
        ['Scoring',   'Full 8-Dimension Kill Engine','Weekly Friday pipeline, 679-stock universe'],
    ]
    ar_rendered = [[Paragraph(f'<font color="#ffffff">{r[0]}</font>', S(f'ar0{i}', fontSize=9)),
                    Paragraph(f'<font color="#cccccc">{r[1]}</font>', S(f'ar1{i}', fontSize=9, alignment=TA_RIGHT)),
                    Paragraph(f'<font color="#cccccc">{r[2]}</font>', S(f'ar2{i}', fontSize=9, alignment=TA_RIGHT))]
                   for i, r in enumerate(arch_rows)]
    s.append(_dark_table(
        ['LAYER', 'TECHNOLOGY', 'ROLE'],
        ar_rendered,
        col_widths=[1.0*inch, 2.3*inch, CONTENT_W - 3.3*inch],
    ))
    s.append(PageBreak())

    # 2. Signal Generation
    s += section_heading('2. PNTHR SIGNAL GENERATION')
    s.append(body_p(
        'PNTHR signals are generated by measurable, repeatable conditions validated across thousands of trades. '
        'The daylight requirement eliminates false breakouts. Separate calibration for ETFs (0.3% vs 1% for stocks) '
        'reflects years of observation that different asset classes behave differently at trend boundaries.'
    ))
    s += subsection_heading('The 21-Week EMA')
    s.append(body_p(
        'Approximately five months of price action. Chosen through extensive testing as the timeframe that best '
        'balances noise reduction with trend responsiveness. Computed from 250 daily candles aggregated into weekly '
        'bars, not dependent on any external API endpoint.'
    ))
    s += subsection_heading('Per-Sector Optimized EMA Periods')
    s.append(body_p(
        'Seven years of backtesting revealed that different sectors have meaningfully different trend cycle lengths. '
        'PNTHR uses empirically optimized EMA periods per sector (periods 15-26 tested), validated out-of-sample: '
        'Train 2020-2023 (+131%), Test 2024-2026 (+73%). Zero year regressions.'
    ))
    sec_rows = [
        ['Consumer Staples / Basic Materials / Consumer Discretionary', '18-19', 'Fast Cycle'],
        ['Technology / Communication Services / Utilities',             '21',    'Standard'],
        ['Healthcare / Industrials',                                    '24',    'Slow Cycle'],
        ['Financial Services',                                          '25',    'Slow Cycle'],
        ['Energy / Real Estate',                                        '26',    'Slow Cycle'],
    ]
    sr_rendered = [[Paragraph(f'<font color="#ffffff">{r[0]}</font>', S(f'sr0{i}', fontSize=9)),
                    Paragraph(f'<font color="#fcf000">{r[1]}</font>', S(f'sr1{i}', fontSize=9, alignment=TA_RIGHT)),
                    Paragraph(f'<font color="#cccccc">{r[2]}</font>', S(f'sr2{i}', fontSize=9, alignment=TA_RIGHT))]
                   for i, r in enumerate(sec_rows)]
    s.append(_dark_table(
        ['SECTOR', 'EMA PERIOD', 'CYCLE'],
        sr_rendered,
        col_widths=[CONTENT_W - 2.5*inch, 1.0*inch, 1.5*inch],
    ))
    s += subsection_heading('BL (Buy Long) Signal Requirements')
    s.append(bullet_p('Weekly close above the 21-week EMA'))
    s.append(bullet_p('EMA rising (positive slope; trend is genuine)'))
    s.append(bullet_p('Weekly high at or above the 2-week high + $0.01 (structural breakout)'))
    s.append(bullet_p('Weekly low above EMA by minimum 1% daylight (stocks) or 0.3% (ETFs)'))
    s += subsection_heading('SS (Sell Short) Signal Requirements')
    s.append(bullet_p('Weekly close below the 21-week EMA'))
    s.append(bullet_p('EMA declining (negative slope)'))
    s.append(bullet_p('Weekly low at or below the 2-week low minus $0.01 (structural breakdown)'))
    s.append(bullet_p('SS Crash Gate: additionally requires SPY/QQQ EMA falling for 2 consecutive weeks AND sector 5-day momentum below -3%'))
    s += subsection_heading('The PNTHR Proprietary Stop Loss System (PPSLS)')
    s.append(bullet_p('Takes two different sets of criteria and, based on current market conditions, chooses the most conservative Stop Loss.'))
    s.append(bullet_p('Buy Long signals only ratchet up and Sell Short signals only ratchet down.'))
    s.append(bullet_p('Stops never move against the trade, locking in profits sooner.'))
    s.append(PageBreak())

    # 3. Kill Scoring Engine
    s += section_heading('3. THE PNTHR KILL SCORING ENGINE')
    s.append(body_p(
        'The PNTHR Kill Scoring Engine is the intellectual core of the strategy: seven years of research distilled '
        'into 8 dimensions that transform 679 stocks into a precision-ranked list where the top entries have a '
        'statistically validated 66-70% probability of success. The system does not guess. It measures, confirms, '
        'and ranks with mathematical precision.'
    ))
    s += subsection_heading('Master Formula')
    s.append(Paragraph(
        '<b><font color="#ffffff">PNTHR KILL SCORE = (D2 + D3 + D4 + D5 + D6 + D7 + D8) x D1</font></b>',
        S('formula', fontSize=11, alignment=TA_CENTER, textColor=WHITE, fontName='Helvetica-Bold')))
    s.append(Spacer(1, 6))
    dims = [
        ['D1', 'Market Regime Multiplier',   '0.70x-1.30x', 'Global amplifier. Bear: SS boosted, BL dampened.'],
        ['D2', 'Sector Alignment',            '+/-15 pts',   'Sector ETF 5-day + 1-month returns.'],
        ['D3', 'Entry Quality',               '0-85 pts',    'Close Conviction + EMA Slope + Separation Bell Curve.'],
        ['D4', 'Signal Freshness',            '-15 to +10',  'Age 0 CONFIRMED=+10. Floor -15 at wk 12+.'],
        ['D5', 'Rank Rise',                   '+/-20 pts',   'Week-over-week ranking improvement.'],
        ['D6', 'Momentum',                    '-10 to +20',  'RSI + OBV change + ADX strength + Volume confirmation.'],
        ['D7', 'Rank Velocity',               '+/-10 pts',   'Acceleration of rank change. Leading indicator.'],
        ['D8', 'Multi-Strategy Convergence',  '0-6 pts',     'SPRINT/HUNT +2 each, FEAST/ALPHA/SPRING/SNEAK +1 each.'],
    ]
    dim_rendered = [[Paragraph(f'<font color="#fcf000"><b>{r[0]}</b></font>', S(f'dim{i}0', fontSize=9)),
                     Paragraph(f'<font color="#ffffff">{r[1]}</font>',        S(f'dim{i}1', fontSize=9, alignment=TA_RIGHT)),
                     Paragraph(f'<font color="#cccccc">{r[2]}</font>',        S(f'dim{i}2', fontSize=9, alignment=TA_RIGHT)),
                     Paragraph(f'<font color="#cccccc">{r[3]}</font>',        S(f'dim{i}3', fontSize=9, alignment=TA_RIGHT))]
                    for i, r in enumerate(dims)]
    s.append(_dark_table(
        ['DIM', 'NAME', 'RANGE', 'WHAT IT MEASURES'],
        dim_rendered,
        col_widths=[0.45*inch, 1.7*inch, 1.1*inch, CONTENT_W - 3.25*inch],
    ))
    s += subsection_heading('Tier Classification')
    tiers_row = [
        ['130+', 'ALPHA PNTHR KILL', 'Maximum conviction. All 8 dimensions aligned. Immediate action.'],
        ['100+', 'STRIKING',         'High conviction. Strong entry quality + multiple dimensions.'],
        ['80+',  'HUNTING',          'Active confirmed setup. Moderate multi-dimension support.'],
        ['65+',  'POUNCING',         'Solid setup. Entry quality present, monitoring closely.'],
        ['50+',  'COILING',          'Building. Signal present, dimensions accumulating.'],
        ['<50',  'STALKING / LOWER', 'Early stage or nascent signal.'],
        ['-99',  'OVEREXTENDED',     '>20% separation from EMA. Excluded from ranking.'],
    ]
    tr_rendered = [[Paragraph(f'<font color="#fcf000"><b>{r[0]}</b></font>', S(f'tc{i}0', fontSize=9)),
                    Paragraph(f'<font color="#ffffff"><b>{r[1]}</b></font>', S(f'tc{i}1', fontSize=9, alignment=TA_RIGHT)),
                    Paragraph(f'<font color="#cccccc">{r[2]}</font>',        S(f'tc{i}2', fontSize=9, alignment=TA_RIGHT))]
                   for i, r in enumerate(tiers_row)]
    s.append(_dark_table(
        ['SCORE', 'TIER', 'ACTION'],
        tr_rendered,
        col_widths=[0.8*inch, 1.6*inch, CONTENT_W - 2.4*inch],
    ))
    s.append(PageBreak())

    # 4. Analyze
    s += section_heading('4. PNTHR ANALYZE PRE-TRADE SCORING')
    s.append(body_p(
        'The PNTHR Analyze system answers the question every trader must answer before entering: is this the right '
        'trade, right now? Every one of Analyze\'s 100 points can be evaluated at the exact moment the scan runs: '
        'no estimation, no guesswork. Score >=75% = green (optimal). >=55% = yellow (proceed with awareness). <55% = red (reconsider).'
    ))
    s += subsection_heading('T1: Setup Quality (40 points)')
    for r in [['Signal Quality', '15', 'Signal age: 0-1wk=15, 2wk=13, 3wk=10, 4wk=6, 5wk=3, 6+wk=0'],
              ['Kill Context',   '10', 'PNTHR Kill rank and tier confirmation'],
              ['Index Trend',    '8',  'SPY/QQQ regime alignment with signal direction'],
              ['Sector Trend',   '7',  'Sector EMA slope aligned with signal direction']]:
        s.append(bullet_p(f'<b>{r[0]} ({r[1]} pts):</b> {r[2]}'))
    s += subsection_heading('T2: Risk Profile (35 points)')
    for r in [['Freshness',     '12', 'D3 confirmation gate gating freshness score'],
              ['Risk/Reward',   '8',  'Stop distance relative to potential reward'],
              ['Prey Presence', '8',  'Multi-strategy convergence from Prey page'],
              ['Conviction',    '7',  'D3 entry quality score normalized']]:
        s.append(bullet_p(f'<b>{r[0]} ({r[1]} pts):</b> {r[2]}'))
    s += subsection_heading('T3: Entry Conditions (25 points)')
    for r in [['Slope Strength',       '5', 'EMA slope magnitude and direction alignment'],
              ['Sector Concentration', '5', 'Portfolio sector exposure headroom (advisory)'],
              ['Wash Compliance',      '5', '30-day wash sale window clearance'],
              ['Volatility / RSI',     '5', 'RSI zone: BL ideal 40-65, SS ideal 35-60'],
              ['Portfolio Fit',        '5', 'Available heat capacity in portfolio']]:
        s.append(bullet_p(f'<b>{r[0]} ({r[1]} pts):</b> {r[2]}'))
    s.append(PageBreak())

    # 5. Position Sizing
    s += section_heading('5. PNTHR POSITION SIZING & PYRAMIDING')
    s.append(body_p(
        'Position sizing is where discipline becomes quantifiable. The PNTHR pyramid model ensures maximum capital '
        'is only deployed when the market has confirmed the trade multiple times. A new entry receives 35% of the '
        'intended position. Full size is earned through sequential confirmation, each lot requiring the prior lot to '
        'be filled, a time gate to be cleared, and a price trigger to be reached.'
    ))
    s += subsection_heading('Tier A Pyramiding Model')
    lots = [
        ['Lot 1', 'The Scent',   '35%', 'Signal entry',   'None',           'Initial position; market must confirm'],
        ['Lot 2', 'The Stalk',   '25%', 'Price + time',   '5 trading days', 'Largest add; time + price required'],
        ['Lot 3', 'The Strike',  '20%', 'Price',          'Lot 2 filled',   'Momentum continuation confirmed'],
        ['Lot 4', 'The Jugular', '12%', 'Price',          'Lot 3 filled',   'Trend extension'],
        ['Lot 5', 'The Kill',     '8%', 'Price',          'Lot 4 filled',   'Maximum conviction; full position'],
    ]
    lots_rendered = [[Paragraph(f'<font color="#fcf000"><b>{r[0]}</b></font>', S(f'lt{i}0', fontSize=9)),
                      Paragraph(f'<font color="#ffffff">{r[1]}</font>',        S(f'lt{i}1', fontSize=9, alignment=TA_RIGHT)),
                      Paragraph(f'<font color="#22c55e"><b>{r[2]}</b></font>', S(f'lt{i}2', fontSize=9, alignment=TA_RIGHT)),
                      Paragraph(f'<font color="#cccccc">{r[3]}</font>',        S(f'lt{i}3', fontSize=9, alignment=TA_RIGHT)),
                      Paragraph(f'<font color="#cccccc">{r[4]}</font>',        S(f'lt{i}4', fontSize=9, alignment=TA_RIGHT)),
                      Paragraph(f'<font color="#cccccc">{r[5]}</font>',        S(f'lt{i}5', fontSize=9, alignment=TA_RIGHT))]
                     for i, r in enumerate(lots)]
    s.append(_dark_table(
        ['LOT', 'NAME', 'ALLOC', 'TRIGGER', 'GATE', 'PURPOSE'],
        lots_rendered,
        col_widths=[0.55*inch, 0.95*inch, 0.65*inch, 1.25*inch, 1.15*inch, CONTENT_W - 4.55*inch],
    ))
    s.append(Spacer(1, 4))
    s.append(note_p('Specific price thresholds at which Lots 2 through 5 trigger are proprietary and are not disclosed.'))

    s += subsection_heading('Stop Ratchet on Each Lot Fill')
    ratchet = [
        ['Lot 2 fills', 'Initial stop (unchanged)', 'Time + price confirmed, position monitored'],
        ['Lot 3 fills', 'Average cost (breakeven)', 'Capital protected; initial investment covered'],
        ['Lot 4 fills', 'Lot 2 fill price',         'Lot 2 gain locked in as minimum exit'],
        ['Lot 5 fills', 'Lot 3 fill price',         'Full pyramid; aggressive ratcheted stop'],
    ]
    rat_rendered = [[Paragraph(f'<font color="#ffffff">{r[0]}</font>', S(f'rat{i}0', fontSize=9)),
                     Paragraph(f'<font color="#fcf000">{r[1]}</font>', S(f'rat{i}1', fontSize=9, alignment=TA_RIGHT)),
                     Paragraph(f'<font color="#cccccc">{r[2]}</font>', S(f'rat{i}2', fontSize=9, alignment=TA_RIGHT))]
                    for i, r in enumerate(ratchet)]
    s.append(_dark_table(
        ['LOT FILL EVENT', 'STOP MOVES TO', 'EFFECT'],
        rat_rendered,
        col_widths=[1.5*inch, 2.5*inch, CONTENT_W - 4.0*inch],
    ))
    s.append(Spacer(1, 4))
    s.append(body_p('Stops never move backwards. The ratchet is a one-way lock. SS positions: ratchets down only.'))
    s.append(PageBreak())

    # 6. Portfolio Command Center + 7. Entry Workflow
    s += section_heading('6. PNTHR PORTFOLIO COMMAND CENTER')
    s.append(body_p(
        'The Command Center is the operational hub: a single screen where every active position is visible, every '
        'risk metric is live, and every action is logged. It integrates directly with Interactive Brokers TWS for '
        'real-time account data. Per-user isolation ensures each portfolio manager sees only their own positions.'
    ))
    cc = [
        ['Portfolio Overview',     'Ticker, direction, avg cost, price, unrealized P&L, lot badges (FILLED/READY/WAITING/GATE), stop, heat'],
        ['IBKR TWS Sync',          'Every 60s: NAV updates accountSize, prices and shares sync to portfolio. Sacred field protection prevents IBKR overwriting user data.'],
        ['IBKR Mismatch Detection','diff <$0.01 = checkmark (commissions), <0.1% = informational, >=0.1% = investigate'],
        ['Risk Advisor',           'Continuous sector concentration monitoring. One-click CLOSE or add opposing-direction position.'],
    ]
    cc_r = [[Paragraph(f'<font color="#fcf000"><b>{r[0]}</b></font>', S(f'cc{i}0', fontSize=9)),
             Paragraph(f'<font color="#cccccc">{r[1]}</font>', S(f'cc{i}1', fontSize=9, alignment=TA_RIGHT))]
            for i, r in enumerate(cc)]
    s.append(_dark_table(
        ['FEATURE', 'DESCRIPTION'],
        cc_r,
        col_widths=[1.7*inch, CONTENT_W - 1.7*inch],
    ))

    s += section_heading('7. PNTHR ENTRY WORKFLOW')
    wf = [
        ['1', 'SIZE IT',         'Analyze scoring (100 pts). Blocked when errors detected. Green >=75%. Yellow 55-74%. Red <55%.'],
        ['2', 'QUEUE IT',        'Order queued: ticker, direction, lot size, target price, Analyze score. Per-user, persists across sessions.'],
        ['3', 'SEND TO COMMAND', '4-source cascade: Analyze snapshot (authoritative) to queue entry to MongoDB record to signal cache updated.'],
    ]
    wf_r = [[Paragraph(f'<font color="#fcf000"><b>{r[0]}</b></font>', S(f'wf{i}0', fontSize=9, alignment=TA_CENTER)),
             Paragraph(f'<font color="#ffffff"><b>{r[1]}</b></font>', S(f'wf{i}1', fontSize=9, alignment=TA_RIGHT)),
             Paragraph(f'<font color="#cccccc">{r[2]}</font>',        S(f'wf{i}2', fontSize=9, alignment=TA_RIGHT))]
            for i, r in enumerate(wf)]
    s.append(_dark_table(
        ['STEP', 'ACTION', 'WHAT HAPPENS'],
        wf_r,
        col_widths=[0.5*inch, 1.7*inch, CONTENT_W - 2.2*inch],
    ))

    s += section_heading('8. PNTHR SCORING ENGINE HEALTH')
    s.append(body_p(
        'The PNTHR Den includes an 8-dimension diagnostic panel monitoring the health of the Kill Scoring Engine in '
        'real time. Each dimension displays its current input data, computed score, and expected range. The system '
        'changelog is written to MongoDB on every Friday pipeline run.'
    ))
    s += section_heading('9. PNTHR MASTER ARCHIVE')
    arch = [
        ['Market Snapshots',   'Weekly SPY/QQQ regime, breadth ratios, sector heatmap, top-10 Kill list.'],
        ['Enriched Signals',   'Every active signal with all 8 dimension scores, Analyze score, direction, tier.'],
        ['Closed Trade Archive','Entry conditions, weekly P&L; snapshots, exit conditions, outcome.'],
        ['Dimension Lab',      'Historical D1-D8 score distributions. Enables pre-deployment rule change testing.'],
    ]
    arch_r = [[Paragraph(f'<font color="#fcf000"><b>{r[0]}</b></font>', S(f'ar{i}0', fontSize=9)),
               Paragraph(f'<font color="#cccccc">{r[1]}</font>', S(f'ar{i}1', fontSize=9, alignment=TA_RIGHT))]
              for i, r in enumerate(arch)]
    s.append(_dark_table(
        ['COMPONENT', 'CONTENTS'],
        arch_r,
        col_widths=[1.8*inch, CONTENT_W - 1.8*inch],
    ))
    s.append(PageBreak())

    # 10 & 11. Kill History + IBKR Bridge + 12. Backtest Results
    s += section_heading('10. PNTHR PERFORMANCE TRACKING: KILL HISTORY')
    s.append(body_p(
        'Forward-tested case study tracker logging every stock entering the Kill top 10 in real time. Tracks: entry '
        'date/price/rank/score/tier, stop, direction, weekly P&L, snapshots, MFE, MAE, holding weeks, exit date/price/reason; '
        'breakdowns by tier, direction, sector.'
    ))
    s += section_heading('11. PNTHR IBKR BRIDGE')
    s.append(body_p(
        'Architecture: Python process (pnthr-ibkr-bridge.py) connects to TWS via ibapi socket. Persistent subscription '
        'at startup. Main loop every 60s: NAV updates accountSize, prices/shares sync to portfolio. portfolioGuard.js '
        'prevents IBKR from overwriting user-entered data.'
    ))
    s.append(body_p(
        'Phase 2 (Planned): Auto-create/close positions from TWS trade executions via execDetails and orderStatus. '
        'Eliminates manual position entry entirely.'
    ))

    s += section_heading('12. INSTITUTIONAL BACKTEST RESULTS')
    bt_rows = [
        ['Backtest Span',            f'{t["gross"]["startDate"]} - {t["gross"]["endDate"]} ({t["gross"]["years"]:.2f} years)'],
        ['Starting Capital',         fmt_usd(t["seedNav"])],
        ['Ending Equity Gross',      fmt_usd(t["gross"]["endNav"], compact=True)],
        ['Ending Equity Net',        fmt_usd(t["net"]["endNav"], compact=True)],
        ['Total Pyramid Positions',  f'{t["trades"]["total"]:,}'],
        ['Total Closed Positions',   f'{t["trades"]["closed"]:,}'],
        ['Win Rate (Combined)',      f'{t["trades"]["combined"]["winRate"]:.1f}%'],
        ['Profit Factor (Combined)', f'{t["trades"]["combined"]["profitFactor"]:.2f}x'],
        ['Gross CAGR',               f'+{t["gross"]["cagr"]:.2f}%'],
        [f'Net CAGR ({t["classLabel"]})', f'+{t["net"]["cagr"]:.2f}%'],
        ['Gross Sharpe',             f'{t["gross"]["sharpe"]:.2f}'],
        ['Net Sharpe',               f'{t["net"]["sharpe"]:.2f}'],
        ['Gross Sortino',            f'{t["gross"]["sortino"]:.2f}'],
        ['Net Sortino',              f'{t["net"]["sortino"]:.2f}'],
        ['Max Drawdown (Gross MTM)', f'{t["gross"]["maxDD"]:.2f}%'],
        ['Max Drawdown (Net MTM)',   f'{t["net"]["maxDD"]:.2f}%'],
    ]
    br_r = [[Paragraph(f'<font color="#ffffff">{r[0]}</font>', S(f'bt{i}0', fontSize=9)),
             Paragraph(f'<font color="#fcf000"><b>{r[1]}</b></font>', S(f'bt{i}1', fontSize=9, alignment=TA_RIGHT))]
            for i, r in enumerate(bt_rows)]
    s.append(_dark_table(
        ['METRIC', 'VALUE'],
        br_r,
        col_widths=[2.8*inch, CONTENT_W - 2.8*inch],
    ))
    s.append(PageBreak())

    # 13. Combined Strategy Results, 14. Empirical Evidence
    s += section_heading('13. COMBINED BL + SS STRATEGY: INSTITUTIONAL METRICS')
    combo = [
        ['CAGR',              f'+{t["net"]["cagr"]:.1f}%',                         '+10.5%'],
        ['Sharpe Ratio',      f'{t["net"]["sharpe"]:.2f}',                         '0.50'],
        ['Sortino Ratio',     f'{t["net"]["sortino"]:.2f}',                        '~0.80'],
        ['Max Drawdown',      f'{t["net"]["maxDD"]:.2f}%',                         '-25%+'],
        ['Calmar Ratio',      f'{t["net"]["calmar"]:.2f}',                         '~0.40'],
        ['Profit Factor',     f'{t["trades"]["combined"]["profitFactor"]:.2f}x',    'N/A'],
        ['Best Single Month', f'+{t["net"]["bestMonth"]["ret"]:.1f}%',              'Variable'],
        ['Worst Single Month',f'{t["net"]["worstMonth"]["ret"]:.2f}%',              '-12.5%+'],
        ['Positive Months',   f'{t["net"]["positiveMonths"]} of {t["net"]["totalMonths"]} ({t["net"]["positivePct"]:.0f}%)', '~65%'],
        ['Avg Monthly Return',f'+{t["net"]["avgMonthlyReturn"]:.2f}%',              '+0.88%'],
        ['Monthly Std Dev',   f'{t["net"]["monthlyStdDev"]:.2f}%',                  '4.2%'],
    ]
    cb_r = [[Paragraph(f'<font color="#ffffff">{r[0]}</font>', S(f'co{i}0', fontSize=9)),
             Paragraph(f'<font color="#fcf000"><b>{r[1]}</b></font>', S(f'co{i}1', fontSize=9, alignment=TA_RIGHT)),
             Paragraph(f'<font color="#cccccc">{r[2]}</font>', S(f'co{i}2', fontSize=9, alignment=TA_RIGHT))]
            for i, r in enumerate(combo)]
    s.append(_dark_table(
        ['METRIC', 'PNTHR PYRAMID', 'S&P 500'],
        cb_r,
        col_widths=[2.5*inch, (CONTENT_W-2.5*inch)/2, (CONTENT_W-2.5*inch)/2],
    ))
    s.append(Spacer(1, 8))
    s += subsection_heading('COVID-19 Crash Stress Test: March 2020')
    s.append(body_p(
        'The COVID-19 crash was the fastest bear market in recorded history: -34% from ATH to trough in 33 trading '
        'days, VIX reaching 82. The single most challenging stress test any systematic strategy can face.'
    ))
    covid_rows = [
        ['February 2020', 'Minimal exposure', '-8.4%',       'Crash gate begins activating SS positions'],
        ['March 2020',    '+0.53%',            '-12.5%',     'Worst S&P month in 90 years. PNTHR MADE MONEY'],
        ['April 2020',    'Positive',          '+12.7%',     'V-recovery; BL signals reactivate as regime flips'],
        ['May-Sep 2020',  'Positive',          'Recovery',   'Full V-recovery captured with pyramid entries'],
    ]
    cv_r = [[Paragraph(f'<font color="#ffffff">{r[0]}</font>', S(f'cv{i}0', fontSize=9)),
             Paragraph(f'<font color="#22c55e">{r[1]}</font>', S(f'cv{i}1', fontSize=9, alignment=TA_RIGHT)),
             Paragraph(f'<font color="#ef4444">{r[2]}</font>', S(f'cv{i}2', fontSize=9, alignment=TA_RIGHT)),
             Paragraph(f'<font color="#cccccc">{r[3]}</font>', S(f'cv{i}3', fontSize=9, alignment=TA_RIGHT))]
            for i, r in enumerate(covid_rows)]
    s.append(_dark_table(
        ['MONTH', 'PNTHR', 'S&P 500', 'NOTES'],
        cv_r,
        col_widths=[1.3*inch, 1.3*inch, 1.1*inch, CONTENT_W - 3.7*inch],
    ))
    s.append(PageBreak())

    # 14. Empirical Evidence
    s += section_heading('14. EMPIRICAL EVIDENCE: 7+ YEARS OF RESEARCH')
    s.append(body_p(
        'Every parameter in the PNTHR system traces back to observed data. The daylight percentage emerged from '
        'testing hundreds of levels. The 21-week EMA outperformed 13-, 26-, 50-, and 200-week alternatives. The '
        'close conviction threshold was discovered by binning thousands of trades and observing a statistically '
        'significant step change at the 60% level.'
    ))
    s += subsection_heading('The Full D1-D8 Research Dataset')
    s.append(body_p(
        f'530 tickers. Multiple market cycles. {t["trades"]["total"]:,} pyramid positions (BL + SS). Approximately 3.2 '
        f'million data points across 8 scoring dimensions. Two-pass scoring algorithm: Pass 1 computes preliminary '
        f'rank (D2+D3+D4+D6)xD1 to derive D5 from prevFinalRank vs prelimRank to get D7 from acceleration of D5 to '
        f'final score. Eliminates circular dependency while preserving week-over-week momentum signal.'
    ))
    findings = [
        ['Close Conviction',  '72.3% WR at 8-10% vs 30.2% at 0-2%',      'D3 Sub-A is the strongest single predictor'],
        ['EMA Slope',          '59.2% WR at 1-2% slope vs 42.7% flat',    'D3 Sub-B captures genuine trend quality'],
        ['Signal Age Decay',   'Win rates converge to ~44% by week 10+',  'D4 Freshness penalty empirically justified'],
        ['Confirmation Gate',  '70% WR confirmed vs 44% unconfirmed',     'Most powerful filter in the system'],
        ['Overextension',      '>20% separation = negative outcomes',     '-99 score and exclusion is data-driven'],
        ['Rank Velocity',      '3+ weeks improvement = leading indicator','D7 captures accelerating setups early'],
        ['Multi-Strategy',     'SPRINT/HUNT convergence adds 4-6% WR',    'D8 is non-trivial confirmation'],
        ['Pyramid vs Single',  f'Sharpe {t["net"]["sharpe"]:.2f}; PF {t["trades"]["combined"]["profitFactor"]:.2f}x',
                                                                          'Pyramid improves risk-adjusted returns'],
    ]
    f_r = [[Paragraph(f'<font color="#fcf000"><b>{r[0]}</b></font>', S(f'fn{i}0', fontSize=9)),
            Paragraph(f'<font color="#ffffff">{r[1]}</font>',         S(f'fn{i}1', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#cccccc">{r[2]}</font>',         S(f'fn{i}2', fontSize=9, alignment=TA_RIGHT))]
           for i, r in enumerate(findings)]
    s.append(_dark_table(
        ['FINDING', 'DATA POINT', 'IMPLICATION'],
        f_r,
        col_widths=[1.8*inch, 2.4*inch, CONTENT_W - 4.2*inch],
    ))
    s += subsection_heading('Why These Results Are Reproducible')
    s.append(bullet_p('Zero lookahead bias: every signal evaluated using only data available at the close of the signal week.'))
    s.append(bullet_p('The 679-stock universe held constant throughout, eliminating survivorship bias.'))
    s.append(bullet_p('Transaction costs are realistic and conservative: IBKR Pro Fixed commissions, 5 bps slippage, sector-tiered borrow rates.'))
    s.append(bullet_p('The same signal engine code runs in production. There is no separate backtest codebase.'))
    s.append(bullet_p('COVID gap (Jan-Sep 2020) explicitly filled from FMP and validated before scoring. The crash is not missing from the dataset.'))
    s.append(Spacer(1, 8))
    s.append(HRFlowable(width='60%', thickness=0.75, color=YELLOW, spaceBefore=6, spaceAfter=10, hAlign='CENTER'))
    s.append(Paragraph('<font color="#ffffff">v18.0  |  April 2026</font>',
                       S('vrev', fontSize=9, alignment=TA_CENTER, textColor=WHITE)))
    s.append(Paragraph('<font color="#fcf000"><b>DISCIPLINE IS THE EDGE.    DATA IS THE WEAPON.    THE MARKET CONFIRMS THE KILL.</b></font>',
                       S('vmot', fontSize=9, alignment=TA_CENTER, textColor=YELLOW, fontName='Helvetica-Bold')))
    s.append(PageBreak())
    return s


# ────────────────────────────────────────────────────────────────────────────
# ACT III — THE PROOF: COMPREHENSIVE DAILY NAV LOG
# ────────────────────────────────────────────────────────────────────────────
def _format_activity_colored(activity_str, closes_list, opens_list):
    """Build a colored activity Paragraph from the parsed lists, matching v6:
       OPEN: AAPL, MSFT (all BL)  — white plain text
       CLOSE: AAPL +$123, MSFT -$45 — P&L fragments colored green/red."""
    parts = []
    if opens_list:
        if opens_list.get('BL'):
            parts.append(f'<font color="#ffffff">OPEN: {", ".join(opens_list["BL"])} (all BL)</font>')
        if opens_list.get('SS'):
            parts.append(f'<font color="#ffffff">OPEN: {", ".join(opens_list["SS"])} (all SS)</font>')
    if closes_list:
        frags = []
        for c in closes_list:
            amt = c.get('netPnl', 0)
            col = '#22c55e' if amt >= 0 else '#ef4444'
            frags.append(
                f'<font color="#ffffff">{c["ticker"]} </font>'
                f'<font color="{col}">{"+$" if amt >= 0 else "-$"}{abs(amt):,}</font>'
            )
        parts.append(f'<font color="#ffffff">CLOSE: </font>' + ', '.join(frags))
    return ' '.join(parts) if parts else '<font color="#444444">-</font>'


def section_daily_nav_log(t):
    """Per-day NAV log grouped by month. Each month: yellow header + column
    headers + daily rows + monthly TOTAL row (summarizing opens/closes/P&L)."""
    s = section_heading('COMPREHENSIVE DAILY NAV LOG')
    s.append(body_p(
        'Complete daily mark-to-market portfolio balance for every trading day from '
        f'{t["gross"]["startDate"]} through {t["gross"]["endDate"]}. Each entry includes equity, open positions, '
        'month-to-date return, SPY comparison, and all trade activity (opens and closes with P&L).'
    ))
    s.append(Spacer(1, 6))

    daily = t['gross'].get('dailySeries', [])
    monthly_summary = {m['month']: m for m in t['gross'].get('monthlyActivitySummary', [])}
    if not daily:
        s.append(note_p('Daily NAV series unavailable; regenerate metrics JSON.'))
        s.append(PageBreak())
        return s

    from collections import OrderedDict
    by_month = OrderedDict()
    for d in daily:
        ym = d['date'][:7]
        by_month.setdefault(ym, []).append(d)

    col_widths = [0.65*inch, 1.0*inch, 1.1*inch, 0.40*inch, 0.55*inch, CONTENT_W - 3.70*inch]

    def month_header_row():
        return [
            Paragraph('<b><font color="#fcf000">DATE</font></b>',        S('d_h0', fontSize=8, alignment=TA_LEFT)),
            Paragraph('<b><font color="#fcf000">SPY EQUITY</font></b>',  S('d_h1', fontSize=8, alignment=TA_RIGHT)),
            Paragraph('<b><font color="#fcf000">PNTHR EQUITY</font></b>',S('d_h2', fontSize=8, alignment=TA_RIGHT)),
            Paragraph('<b><font color="#fcf000">OPEN</font></b>',        S('d_h3', fontSize=8, alignment=TA_RIGHT)),
            Paragraph('<b><font color="#fcf000">MTD %</font></b>',       S('d_h4', fontSize=8, alignment=TA_RIGHT)),
            Paragraph('<b><font color="#fcf000">ACTIVITY</font></b>',    S('d_h5', fontSize=8, alignment=TA_LEFT)),
        ]

    for ym, days in by_month.items():
        dt_obj = _dt.strptime(ym + '-01', '%Y-%m-%d')
        month_label = dt_obj.strftime('%b %Y').upper()
        start_nav = days[0]['net'] if days[0]['net'] is not None else days[0]['gross']
        month_hdr = Table(
            [[Paragraph(f'<b><font color="#fcf000">{month_label}</font></b>',
                         S('mhl', fontSize=10.5, alignment=TA_LEFT, textColor=YELLOW, fontName='Helvetica-Bold')),
              Paragraph(f'<font color="#cccccc">Start: {fmt_usd(start_nav)}</font>',
                        S('mhs', fontSize=9, alignment=TA_LEFT, textColor=OFFWHT))]],
            colWidths=[1.6*inch, CONTENT_W - 1.6*inch]
        )
        month_hdr.setStyle(TableStyle([
            ('VALIGN',       (0,0), (-1,-1), 'BOTTOM'),
            ('LEFTPADDING',  (0,0), (-1,-1), 0),
            ('TOPPADDING',   (0,0), (-1,-1), 6),
            ('BOTTOMPADDING',(0,0), (-1,-1), 3),
        ]))

        data_rows = [month_header_row()]
        for d in days:
            mtd = d.get('mtdPct', 0)
            mtd_c = '#22c55e' if mtd > 0 else ('#ef4444' if mtd < 0 else '#cccccc')
            activity_html = _format_activity_colored(
                d.get('activity', ''),
                d.get('closesList', []),
                d.get('opensList', {'BL': [], 'SS': []}),
            )
            pnthr_val = d['net'] if d['net'] is not None else d['gross']
            data_rows.append([
                Paragraph(f'<font color="#ffffff">{d["date"][5:]}</font>',                     S('dd0', fontSize=8)),
                Paragraph(f'<font color="#cccccc">{fmt_usd(d.get("spyEquity", 0))}</font>',    S('dd1', fontSize=8, alignment=TA_RIGHT)),
                Paragraph(f'<font color="#fcf000">{fmt_usd(pnthr_val)}</font>',                S('dd2', fontSize=8, alignment=TA_RIGHT)),
                Paragraph(f'<font color="#ffffff">{d.get("openCount", 0)}</font>',             S('dd3', fontSize=8, alignment=TA_RIGHT)),
                Paragraph(f'<font color="{mtd_c}">{"+" if mtd > 0 else ""}{mtd:.2f}%</font>',  S('dd4', fontSize=8, alignment=TA_RIGHT)),
                Paragraph(activity_html, S('dd5', fontSize=7.5, leading=9.5, alignment=TA_LEFT)),
            ])

        ms = monthly_summary.get(ym, {})
        spy_pct = ms.get('spyPct', 0); net_pct = ms.get('netPct', 0)
        opened  = ms.get('opened', 0); closed  = ms.get('closed', 0)
        endOpen = ms.get('endOpen', 0); netPL  = ms.get('netPL', 0)
        spy_c = '#22c55e' if spy_pct > 0 else ('#ef4444' if spy_pct < 0 else '#cccccc')
        net_c = '#22c55e' if net_pct > 0 else ('#ef4444' if net_pct < 0 else '#cccccc')
        pl_c  = '#22c55e' if netPL  >= 0 else '#ef4444'
        pl_str = f'{"+$" if netPL >= 0 else "-$"}{abs(netPL):,}'

        data_rows.append([
            Paragraph(f'<b><font color="#fcf000">{month_label.split()[0]} TOTAL</font></b>', S('mt0', fontSize=8.5)),
            Paragraph(f'<b><font color="{spy_c}">{spy_pct:+.2f}%</font></b>',               S('mt1', fontSize=8.5, alignment=TA_RIGHT)),
            Paragraph(f'<b><font color="{net_c}">{net_pct:+.2f}%</font></b>',               S('mt2', fontSize=8.5, alignment=TA_RIGHT)),
            Paragraph(f'<b><font color="#ffffff">{endOpen}</font></b>',                      S('mt3', fontSize=8.5, alignment=TA_RIGHT)),
            Paragraph(f'<b><font color="{net_c}">{net_pct:+.2f}%</font></b>',               S('mt4', fontSize=8.5, alignment=TA_RIGHT)),
            Paragraph(
                f'<font color="#cccccc">{opened} opened, {closed} closed, {endOpen} open, </font>'
                f'<font color="{pl_c}">{pl_str}</font><font color="#cccccc"> net P&amp;L</font>',
                S('mt5', fontSize=8, leading=10, alignment=TA_LEFT)),
        ])

        mtbl = Table(data_rows, colWidths=col_widths, repeatRows=1)
        mtbl.setStyle(TableStyle([
            ('VALIGN',       (0,0), (-1,-1), 'TOP'),
            ('TOPPADDING',   (0,0), (-1,-1), 1.5),
            ('BOTTOMPADDING',(0,0), (-1,-1), 1.5),
            ('LEFTPADDING',  (0,0), (-1,-1), 3),
            ('RIGHTPADDING', (0,0), (-1,-1), 3),
            ('LINEBELOW',    (0,0), (-1,0), 0.4, DGRAY),
            ('LINEABOVE',    (0,-1), (-1,-1), 0.5, YELLOW),
            ('BACKGROUND',   (0,-1), (-1,-1), HexColor('#111111')),
            ('TOPPADDING',   (0,-1), (-1,-1), 4),
            ('BOTTOMPADDING',(0,-1), (-1,-1), 4),
        ]))

        s.append(month_hdr)
        s.append(mtbl)
        s.append(Spacer(1, 8))

    s.append(PageBreak())
    return s


# ────────────────────────────────────────────────────────────────────────────
# ACT IV — THE CLOSE
# ────────────────────────────────────────────────────────────────────────────
def section_cumulative_growth_page(t):
    """ACT IV page: big cumulative growth chart + two summary boxes (PNTHR / S&P)."""
    s = []
    # Title
    s.append(Paragraph('<b><font color="#ffffff">Cumulative Growth (2019-2026)</font></b>  '
                       '<font color="#888888"><i>Net of 2% mgmt fee + performance allocation + US2Y hurdle + HWM</i></font>',
                       S('cg_t', fontSize=10.5, leading=14, alignment=TA_LEFT)))
    s.append(Spacer(1, 6))

    big_chart = os.path.join(TMP_DIR, f'growth_big_{t["tier"]}.png')
    generate_growth_chart(t, big_chart, big=True)
    if os.path.exists(big_chart):
        s.append(RLImage(big_chart, width=CONTENT_W, height=3.2*inch))
    s.append(Spacer(1, 10))

    # Two summary boxes side by side
    net = t['net']; gross = t['gross']
    # Approximate fee breakdown
    avg_nav = (t['seedNav'] + net['endNav']) / 2
    mgmt_fees = 0.02 * avg_nav * net['years']
    perf_alloc = gross['endNav'] - net['endNav'] - mgmt_fees
    total_fees = mgmt_fees + perf_alloc
    hwm_final = net['endNav']

    pnthr_box = [
        [Paragraph(f'<b><font color="#fcf000">{t["classLabel"].split()[0]} - {fmt_usd(t["seedNav"])}</font></b>',
                   S('pb_t', fontSize=10.5, alignment=TA_LEFT, textColor=YELLOW, fontName='Helvetica-Bold')),
         ''],
        [Paragraph('<font color="#cccccc">Ending NAV</font>', S('pb0', fontSize=9)),
         Paragraph(f'<font color="#fcf000">{fmt_usd(net["endNav"])}</font>', S('pb0v', fontSize=9, alignment=TA_RIGHT))],
        [Paragraph('<font color="#cccccc">Total Return</font>', S('pb1', fontSize=9)),
         Paragraph(f'<font color="#22c55e">{fmt_usd(net["endNav"] - t["seedNav"])} (+{net["totalReturn"]:.1f}%)</font>', S('pb1v', fontSize=9, alignment=TA_RIGHT))],
        [Paragraph('<font color="#cccccc">Mgmt Fees (2%)</font>', S('pb2', fontSize=9)),
         Paragraph(f'<font color="#ef4444">-{fmt_usd(mgmt_fees)}</font>', S('pb2v', fontSize=9, alignment=TA_RIGHT))],
        [Paragraph(f'<font color="#cccccc">Perf Alloc ({t["feeSchedule"]["yearsOneToThree"]}%/{t["feeSchedule"]["yearsFourPlus"]}%)</font>',
                   S('pb3', fontSize=9)),
         Paragraph(f'<font color="#ef4444">-{fmt_usd(perf_alloc)}</font>', S('pb3v', fontSize=9, alignment=TA_RIGHT))],
        [Paragraph('<font color="#cccccc">Total Fees</font>', S('pb4', fontSize=9)),
         Paragraph(f'<font color="#ef4444">-{fmt_usd(total_fees)}</font>', S('pb4v', fontSize=9, alignment=TA_RIGHT))],
        [Paragraph('<font color="#cccccc">US2Y Hurdle (range)</font>', S('pb5', fontSize=9)),
         Paragraph('<font color="#ffffff">0.11% - 4.40%</font>', S('pb5v', fontSize=9, alignment=TA_RIGHT))],
        [Paragraph('<font color="#cccccc">HWM</font>', S('pb6', fontSize=9)),
         Paragraph(f'<font color="#fcf000">{fmt_usd(hwm_final)}</font>', S('pb6v', fontSize=9, alignment=TA_RIGHT))],
    ]
    pnthr_tbl = Table(pnthr_box, colWidths=[(CONTENT_W-0.25*inch)/2 - 1.7*inch, 1.7*inch])
    pnthr_tbl.setStyle(TableStyle([
        ('SPAN', (0,0), (1,0)),
        ('TOPPADDING', (0,0), (-1,-1), 3),
        ('BOTTOMPADDING', (0,0), (-1,-1), 3),
        ('LEFTPADDING', (0,0), (-1,-1), 8),
        ('RIGHTPADDING', (0,0), (-1,-1), 8),
        ('BOX', (0,0), (-1,-1), 0.6, DGRAY),
        ('LINEBELOW', (0,0), (-1,0), 0.5, YELLOW),
    ]))

    spy = t['spy']
    spy_box = [
        [Paragraph(f'<b><font color="#ffffff">S&amp;P 500 - {fmt_usd(t["seedNav"])}</font></b>',
                   S('sb_t', fontSize=10.5, alignment=TA_LEFT, textColor=WHITE, fontName='Helvetica-Bold')),
         ''],
        [Paragraph('<font color="#cccccc">Ending NAV</font>', S('sb0', fontSize=9)),
         Paragraph(f'<font color="#ffffff">{fmt_usd(spy["endingEquity"])}</font>', S('sb0v', fontSize=9, alignment=TA_RIGHT))],
        [Paragraph('<font color="#cccccc">Total Return</font>', S('sb1', fontSize=9)),
         Paragraph(f'<font color="#22c55e">{fmt_usd(spy["endingEquity"] - t["seedNav"])} (+{spy["totalReturn"]:.1f}%)</font>', S('sb1v', fontSize=9, alignment=TA_RIGHT))],
        [Paragraph('<font color="#cccccc">Expense Ratio</font>', S('sb2', fontSize=9)),
         Paragraph('<font color="#ffffff">0.03% (VOO)</font>', S('sb2v', fontSize=9, alignment=TA_RIGHT))],
        [Paragraph('<font color="#cccccc">Perf Allocation</font>', S('sb3', fontSize=9)),
         Paragraph('<font color="#ffffff">None</font>', S('sb3v', fontSize=9, alignment=TA_RIGHT))],
    ]
    spy_tbl = Table(spy_box, colWidths=[(CONTENT_W-0.25*inch)/2 - 1.7*inch, 1.7*inch])
    spy_tbl.setStyle(TableStyle([
        ('SPAN', (0,0), (1,0)),
        ('TOPPADDING', (0,0), (-1,-1), 3),
        ('BOTTOMPADDING', (0,0), (-1,-1), 3),
        ('LEFTPADDING', (0,0), (-1,-1), 8),
        ('RIGHTPADDING', (0,0), (-1,-1), 8),
        ('BOX', (0,0), (-1,-1), 0.6, DGRAY),
        ('LINEBELOW', (0,0), (-1,0), 0.5, WHITE),
    ]))

    box_row = Table(
        [[pnthr_tbl, spy_tbl]],
        colWidths=[(CONTENT_W-0.25*inch)/2, (CONTENT_W-0.25*inch)/2],
    )
    box_row.setStyle(TableStyle([
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING', (0,0), (-1,-1), 0),
        ('RIGHTPADDING', (0,0), (-1,-1), 0),
    ]))
    s.append(box_row)
    s.append(PageBreak())
    return s


def section_executive_recap(t):
    s = section_heading('EXECUTIVE RECAP')
    s.append(body_p('After reviewing 7 years of daily performance data, here is the bottom line:'))
    s.append(Spacer(1, 10))
    net = t['net']; spy = t['spy']
    recap_rows = [
        ['Net Compound Annual Growth Rate (CAGR)', f'+{net["cagr"]:.1f}%',                '#22c55e'],
        ['Sharpe Ratio',                            f'{net["sharpe"]:.2f}',                '#fcf000'],
        ['Sortino Ratio',                           f'{net["sortino"]:.2f}',               '#fcf000'],
        ['Profit Factor',                           f'{t["trades"]["combined"]["profitFactor"]:.1f}x', '#22c55e'],
        ['Win Rate',                                f'{t["trades"]["combined"]["winRate"]:.1f}%', '#22c55e'],
        ['Max Monthly Drawdown',                    f'{net["maxDD"]:.2f}%',                '#ef4444'],
        ['Positive Months',                         f'{net["positiveMonths"]} of {net["totalMonths"]} ({net["positivePct"]:.0f}%)', '#22c55e'],
        [f'Total Return ({fmt_usd(t["seedNav"])} start)', fmt_usd(net["endNav"], compact=True), '#fcf000'],
        ['Alpha vs S&P 500',                        fmt_usd(net["endNav"] - spy["endingEquity"], compact=True), '#22c55e'],
    ]
    r_rendered = [[Paragraph(f'<font color="#cccccc">{r[0]}</font>', S(f'rc{i}0', fontSize=10)),
                   Paragraph(f'<font color="{r[2]}"><b>{r[1]}</b></font>', S(f'rc{i}1', fontSize=10, alignment=TA_RIGHT, fontName='Helvetica-Bold'))]
                  for i, r in enumerate(recap_rows)]
    r_tbl = Table(r_rendered, colWidths=[CONTENT_W*0.6 - 0.5*inch, CONTENT_W*0.4 + 0.5*inch])
    r_tbl.setStyle(TableStyle([
        ('TOPPADDING',    (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING',   (0,0), (-1,-1), 40),
        ('RIGHTPADDING',  (0,0), (-1,-1), 40),
    ]))
    s.append(r_tbl)
    s.append(Spacer(1, 10))
    s.append(HRFlowable(width='50%', thickness=0.5, color=DGRAY, hAlign='CENTER', spaceBefore=6, spaceAfter=10))
    s.append(body_p(
        f'The Carnivore Quant Fund transformed {fmt_usd(t["seedNav"])} into {fmt_usd(net["endNav"], compact=True)} '
        f'while the S&amp;P 500 produced {fmt_usd(spy["endingEquity"], compact=True)} over the same period. '
        f'Every dollar figure above is net of all transaction costs, management fees, and performance allocation.'
    ))
    s.append(PageBreak())
    return s


def section_summary(t):
    s = section_heading('SUMMARY')
    s += subsection_heading('A System Built to Win in Every Market')
    s.append(body_p(
        'The PNTHR Funds, Carnivore Quant Fund (PNTHR) Strategy was designed from first principles to do what most '
        'systematic strategies cannot: generate consistent, compounding returns across the full range of market '
        'conditions, bull, bear, crash, and recovery, without relying on leverage, complex derivatives, or opaque '
        'machine learning.'
    ))
    s.append(body_p('The results speak for themselves.'))
    net = t['net']; spy = t['spy']
    s.append(body_p(
        f'Over a {net["totalMonths"]}-month live-equivalent backtest period, the strategy delivered +{net["totalReturn"]:.0f}% '
        f'total return at a +{net["cagr"]:.1f}% CAGR, converting a {fmt_usd(t["seedNav"])} portfolio to '
        f'{fmt_usd(net["endNav"], compact=True)}, against the S&amp;P 500\'s {fmt_usd(spy["endingEquity"], compact=True)} '
        f'over the same period. That is {fmt_usd(net["endNav"] - spy["endingEquity"], compact=True)} in pure alpha. '
        f'The Sharpe ratio of {net["sharpe"]:.2f} and Sortino ratio of {net["sortino"]:.2f} are not statistical artifacts; '
        f'they reflect a strategy that earns its returns through disciplined, rules-based execution rather than tail risk exposure.'
    ))

    s += subsection_heading('Risk Is Not a Byproduct. It Is the Product.')
    s.append(body_p(
        'What distinguishes PNTHR Funds, Carnivore Quant Fund (PNTHR) from passive and most active strategies is not '
        'the upside. It is the downside discipline.'
    ))
    s.append(body_p(
        f'The maximum monthly drawdown across the entire {net["totalMonths"]}-month period was {net["maxDD"]:.2f}%. '
        f'Not a single rolling 12-month window (across all {len(t["net"]["rolling12m"])} tested) ended negative. '
        f'Every drawdown fully recovered. No permanent capital loss, ever.'
    ))
    s.append(body_p('When markets collapsed, the PNTHR did not simply "hold on." It thrived:'))
    for ev in t['crisisAlphaNet'][:3]:
        if ev['pnthrReturn'] is None: continue
        s.append(bullet_p(
            f'{ev["event"]} ({ev["period"]}): <font color="#22c55e">{ev["pnthrReturn"]:+.2f}%</font> vs. '
            f'S&amp;P <font color="#ef4444">{ev["spyReturn"]:+.1f}%</font>'
        ))
    s.append(body_p(
        'This is not luck. It is architecture. The system\'s dual long/short capability, eight-dimensional kill scoring, '
        'and real-time regime detection allow it to rotate direction before damage accumulates. The strategy earns in '
        'downtrends; it does not simply survive them.'
    ))

    s += subsection_heading('Empirical Credibility at Scale')
    s.append(body_p(
        f'With {t["trades"]["closed"]:,} closed trades across seven years, the PNTHR strategy has a statistical foundation '
        f'that virtually no discretionary fund can match. The edge has been validated not in a handful of marquee calls, '
        f'but across thousands of independent, rules-identical trades, each entered and exited according to the same '
        f'systematic criteria.'
    ))
    s.append(body_p(
        f'A {t["trades"]["combined"]["profitFactor"]:.1f}x profit factor (for every dollar lost, ${t["trades"]["combined"]["profitFactor"]:.2f} was made), '
        f'achieved at a {t["trades"]["combined"]["winRate"]:.1f}% win rate, is a signature characteristic of high-quality '
        f'systematic momentum strategies. The strategy does not depend on being right most of the time. It depends on '
        f'cutting losers fast and letting winners compound. That discipline is embedded at the signal level, enforced '
        f'at the scoring level, and auditable at the trade level.'
    ))

    s += subsection_heading('Built for Institutions. Ready to Scale.')
    s.append(body_p(
        'The PNTHR Command Center, Kill Scoring Engine, and real-time Analyze workflow are not prototype tools; they are '
        'production infrastructure. The IBKR bridge provides live NAV synchronization. The Friday pipeline scores the '
        'full 679-stock universe automatically. Every trade decision is supported by an eight-dimension score, a '
        'pre-trade Analyze rating, and a discipline scoring system that audits each exit in real time.'
    ))
    s.append(body_p(
        'The fund is positioned to accept institutional capital with the operational rigor, audit trail, and compliance '
        'infrastructure that sophisticated allocators require.'
    ))

    s += subsection_heading('The Opportunity')
    s.append(body_p(
        'Investors today face a choice: accept 7-10% annual returns from passive indexing and absorb 30-40% drawdowns '
        'when markets break, or allocate to a strategy that has demonstrated the ability to compound capital at 28%+ '
        'annually while protecting it when it matters most.'
    ))
    s.append(body_p(
        'The PNTHR Funds Strategy is that alternative. Every return number in this report is auditable, every trade '
        'is logged, and every methodology decision is documented. We invite you to pressure-test it.'
    ))
    s.append(Spacer(1, 12))
    s.append(HRFlowable(width='55%', thickness=0.75, color=YELLOW, hAlign='CENTER', spaceBefore=4, spaceAfter=10))
    s.append(Paragraph(
        '<font color="#fcf000"><b><i>The PNTHR does not chase. It positions, waits, and strikes with precision.</i></b></font>',
        S('motto', fontSize=12, alignment=TA_CENTER, textColor=YELLOW, fontName='Helvetica-Bold')))
    s.append(Spacer(1, 6))
    s.append(note_p(
        'This summary reflects backtest results on the PNTHR 679 universe. Past performance is not a guarantee of '
        'future results. See full methodology and disclosures within this report.'
    ))
    s.append(PageBreak())
    return s


def section_methodology_assumptions(t):
    s = section_heading('METHODOLOGY & ASSUMPTIONS')
    s.append(body_p(
        f'Every headline figure in this document is derived from the methodology disclosed below. All calculations '
        f'were performed on the full daily NAV series of the PNTHR pyramid backtest for the period '
        f'{t["gross"]["startDate"]} through {t["gross"]["endDate"]} '
        f'({len(t["gross"]["dailySeries"]):,} trading days; {t["net"]["totalMonths"]} full calendar months).'
    ))
    s += subsection_heading('Universe Construction (PNTHR 679)')
    s.append(body_p(
        'The backtest universe comprises 679 liquid U.S. equities selected for sufficient price history and average '
        'daily volume. The universe composition is static across the backtest period; inclusion of delisted or merged '
        'securities is not modeled. This introduces a potential survivorship bias - the Manager believes the effect is '
        'immaterial given the liquidity threshold applied, but investors should understand that the PNTHR 679 as tested '
        'is not identical to the real-time investable universe at every historical date.'
    ))
    s += subsection_heading('Data Sources & Period')
    s.append(body_p(
        f'Daily OHLCV data sourced from Financial Modeling Prep (FMP). Period covered: {t["gross"]["startDate"]} '
        f'through {t["gross"]["endDate"]}. S&amp;P 500 benchmark modeled via SPDR S&amp;P 500 ETF (SPY) equity curve '
        f'with no separate dividend add-back (SPY total-return is captured in the price series). 21-week EMA and '
        f'8-dimension Kill scoring use only trailing data at each decision point; no future bars are referenced '
        f'(no look-ahead bias).'
    ))
    s += subsection_heading('Fee Structure (NET results)')
    s.append(body_p(
        f'NET figures are burdened by: (1) IBKR Pro Fixed commissions at $0.005 per share (min $1 per order); (2) 5 '
        f'basis points of slippage per leg (market impact proxy); (3) sector-tiered short borrow costs of 1.0-2.0% '
        f'annualized on the notional of short positions; (4) a 2.0% per annum management fee, accrued monthly; (5) a '
        f'tiered performance allocation of 20%/25%/30% (depending on investor class; reports use the '
        f'{t["feeSchedule"]["yearsOneToThree"]}% "{t["label"]}" tier dropping to {t["feeSchedule"]["yearsFourPlus"]}% after '
        f'36 months); (6) an annual hurdle rate equal to the US 2-Year Treasury constant-maturity yield at the start '
        f'of each calendar year, reset annually; (7) a high-water mark with implicit loss carryforward. Performance '
        f'allocation is charged only on profits above both the high-water mark and the hurdle amount.'
    ))
    s += subsection_heading('Sharpe Ratio Convention')
    s.append(body_p(
        'Sharpe Ratio is calculated from daily excess returns over the US 3-month Treasury Bill (first trading day '
        'of each year), annualized by sqrt(252) trading days. Sample standard deviation (n-1 denominator) is used.'
    ))
    s += subsection_heading('Sortino Ratio Convention')
    s.append(body_p(
        'Sortino Ratio follows HFRI convention: MAR = 0, downside deviation computed using sum of squared-negative-'
        'returns divided by TOTAL sample size (not the count of downside months), annualized by sqrt(252). This '
        'convention is methodologically standard and produces values in the 2-5 range for high-quality momentum '
        'strategies.'
    ))
    s += subsection_heading('Drawdown Metrics')
    s.append(body_p(
        '"Max Peak-to-Trough (MTM)" uses the full daily mark-to-market NAV series (includes unrealized P&L on open '
        'positions) and is the worst percentage retracement from any prior daily peak.'
    ))
    s += subsection_heading('Profit Factor & Win Rate')
    s.append(body_p(
        'Win Rate is the percentage of CLOSED trades with a net-positive dollar P&L (net of commissions and slippage). '
        'A trade is defined at the position level: multiple lots of the same ticker opened and closed under a single '
        'signal constitute one trade. Profit Factor = (sum of winning trade P&amp;L) / (absolute value of sum of '
        'losing trade P&amp;L), using NET P&amp;L.'
    ))
    s += subsection_heading('Cash Deployment & Leverage Assumption')
    s.append(body_p(
        'The backtest assumes 100% of net asset value is available for deployment subject to the system\'s own '
        'position-sizing rules (1% vitality cap per stock position, 10% maximum portfolio risk exposure, sector '
        'and macro regime gates). No investor subscriptions, redemptions, or cash-drag effects are modeled. Short '
        'positions are assumed to have continuous borrow availability at the disclosed borrow rates; hard-to-borrow '
        'or locate-failure situations are not modeled. The Fund uses no derivative leverage, no options, and no '
        'margin beyond standard Regulation T short-selling margin.'
    ))
    s += subsection_heading('Alpha Calculation')
    s.append(body_p(
        'Alpha is reported as simple arithmetic difference: (PNTHR Total Return) - (SPY Total Return) over the '
        'identical calendar window, both in percentage and dollar terms (the latter scaled to the stated starting '
        'capital). Alpha is NOT risk-adjusted (no beta regression).'
    ))
    s += subsection_heading('NAV Scaling Across the Three Variants')
    s.append(body_p(
        'This document is one of three NAV-scaled variants ($100,000 / $500,000 / $1,000,000 starting capital). '
        'Percentage metrics are SUBSTANTIALLY SIMILAR but NOT bit-for-bit identical across the three variants. '
        'Small variations - typically within approximately 0.5 percentage points on total return and CAGR, 0.02 on '
        'Sharpe, a few points on Sortino, 0.04-0.15 percentage points on max drawdown - arise from share-level '
        'rounding effects in the backtest. Dollar figures (ending equity, alpha, total trades, etc.) scale '
        'approximately but not exactly linearly with starting capital for the same reason. The current document '
        f'reports the {fmt_usd(t["seedNav"])} variant.'
    ))
    s += subsection_heading('Backtest vs Live Performance')
    s.append(body_p(
        '<font color="#fcf000"><b>THESE ARE HYPOTHETICAL BACKTEST RESULTS.</b></font> Actual live trading of this '
        'strategy has not produced a verified track record of the length reported here. Actual live returns may '
        'differ materially from backtested returns due to execution differences, cash management, fill prices, '
        'borrow availability, subscription/redemption flows, tax-driven execution constraints, corporate actions, '
        'and events the historical model could not anticipate. See the Important Disclosures section for the full '
        'backtest-performance disclaimer.'
    ))
    s.append(PageBreak())
    return s


def section_disclosures(t):
    s = section_heading('IMPORTANT DISCLOSURES AND DISCLAIMERS')
    s += subsection_heading('CONFIDENTIAL DOCUMENT - FOR QUALIFIED INVESTORS ONLY')
    s.append(body_p(
        'This document is provided by PNTHR Funds ("the Manager") for informational purposes only and constitutes '
        'neither an offer to sell nor a solicitation of an offer to buy any securities. Any such offer or '
        'solicitation will be made only by means of a confidential Private Placement Memorandum ("PPM"), the Fund\'s '
        'Limited Partnership Agreement, and related subscription documents, and only to investors who qualify as '
        '"accredited investors" as defined in Rule 501(a) of Regulation D under the Securities Act of 1933, as '
        'amended, and who the Manager reasonably believes meet such standards through verification as required by '
        'Rule 506(c).'
    ))
    s += subsection_heading('REGULATORY STATUS')
    s.append(body_p(
        'The Carnivore Quant Fund, LP ("the Fund") is a Delaware limited partnership structured as a private '
        'investment vehicle relying on the exemption from registration provided by Rule 506(c) of Regulation D, '
        'and relying on the exemption from registration as an investment company provided by Section 3(c)(1) of '
        'the Investment Company Act of 1940. As a Section 3(c)(1) fund, the Fund is limited to no more than 100 '
        'beneficial owners. The Fund\'s securities have not been registered under the Securities Act of 1933, as '
        'amended, or the securities laws of any state, and are being offered and sold in reliance on exemptions '
        'from the registration requirements of such laws.'
    ))
    s += subsection_heading('ACCREDITED INVESTOR REQUIREMENT')
    s.append(body_p(
        'Investment in the Fund is limited to accredited investors as defined in Rule 501(a) of Regulation D. For '
        'natural persons, this generally requires (i) individual net worth (or joint net worth with a spouse) '
        'exceeding $1,000,000, excluding the primary residence; OR (ii) individual annual income exceeding $200,000 '
        '(or joint income with a spouse exceeding $300,000) in each of the two most recent years and a reasonable '
        'expectation of the same in the current year; OR (iii) qualification based on professional certifications '
        'as defined by the SEC. Entities have separate qualification criteria. Because the Fund relies on Rule '
        '506(c), the Manager is required to take reasonable steps to VERIFY accredited investor status; '
        'self-certification alone is not sufficient.'
    ))
    s += subsection_heading('BACKTEST DISCLOSURE - HYPOTHETICAL PERFORMANCE (SEC BACKTESTING RULES)')
    s.append(body_p(
        '<font color="#fcf000"><b>ALL PERFORMANCE DATA PRESENTED IN THIS DOCUMENT IS BASED ON BACKTESTED, HYPOTHETICAL '
        'RESULTS AND DOES NOT REPRESENT ACTUAL TRADING OR AN ACTUAL FUND THAT HAS TRADED OVER THE PERIOD SHOWN.</b></font> '
        'Backtested performance is hypothetical, was compiled retroactively, and may not reflect the realities of '
        'live trading. Hypothetical performance has many inherent limitations and SHOULD NOT be relied upon as '
        'indicative of future results. This document does not represent that any account did in fact achieve the '
        'profits and losses shown. There are frequent and sharp differences between backtested performance and '
        'subsequent actual results. One of many factors that cannot be fully replicated in a backtest is the ability '
        'of an investor, manager, or trading system to withstand losses or adhere to a particular trading program in '
        'spite of trading losses; such decisions materially impact actual returns.'
    ))
    s += subsection_heading('SPECIFIC BACKTEST LIMITATIONS')
    for b in [
        'Backtested results are generated by retroactive application of a model developed with the benefit of hindsight of the market data used.',
        'The universe of securities tested is static and does not include delisted securities; this may introduce survivorship bias.',
        'No representation is made that any account will or is likely to achieve profits or losses similar to those shown.',
        'Backtested performance does not reflect the impact of sudden regulatory changes, material economic events, or liquidity events that were not modeled.',
        'Transaction costs, slippage, and short-borrow costs have been modeled using specific assumptions (IBKR Pro Fixed commissions at $0.005/share, 5 bps slippage per leg, sector-tiered short-borrow rates of 1.0-2.0% annualized); actual trading costs may differ materially.',
        'Short-borrow availability is assumed continuous as modeled; in live trading, hard-to-borrow, locate failures, and borrow recall events would reduce returns.',
        'Cash deployment is assumed at 100% subject to the system\'s sizing rules; actual funds experience cash drag, subscription/redemption timing, and tax-driven execution timing.',
    ]:
        s.append(bullet_p(b))
    s += subsection_heading('BENCHMARK COMPARISON')
    s.append(body_p(
        'The S&amp;P 500 (SPY) benchmark is provided solely for general comparison purposes. The Fund is not managed '
        'to track or replicate the S&amp;P 500 and the strategies and risk profiles are not comparable in all respects. '
        'Unlike the Fund, the S&amp;P 500 is an unmanaged index that does not incur management or performance fees, '
        'and cannot be invested in directly.'
    ))
    s += subsection_heading('RISK FACTORS')
    s.append(body_p(
        'Investment in the Fund involves a high degree of risk, including but not limited to: the risk of loss of the '
        'entire investment; the use of short selling and unlimited theoretical loss exposure on short positions; '
        'concentration in a limited number of securities; dependence on key personnel and proprietary models; model '
        'risk and technology risk (including the risk of system failures, data errors, or erroneous signals); '
        'counterparty risk (including broker-dealer and custodian risk); liquidity risk; and market, economic, '
        'geopolitical, and regulatory risks. Past performance, whether actual or backtested, is not indicative of '
        'future results. Investors may lose some or all of their invested capital.'
    ))
    s += subsection_heading('CONFLICTS OF INTEREST')
    s.append(body_p(
        'The Manager and its affiliates may have interests that conflict with those of the Fund and its investors, '
        'including but not limited to: allocation of investment opportunities, fee arrangements, and personal '
        'trading. A complete discussion of material conflicts of interest is set forth in the PPM.'
    ))
    s += subsection_heading('FORWARD-LOOKING STATEMENTS')
    s.append(body_p(
        'This document may contain forward-looking statements, projections, or estimates. Such statements are based '
        'on the Manager\'s current expectations and assumptions and are subject to material risks and uncertainties '
        'that could cause actual results to differ materially. Words such as "expect," "anticipate," "project," '
        '"target," and similar expressions are used to identify forward-looking statements, which speak only as of '
        'the date of this document.'
    ))
    s += subsection_heading('NO TAX OR LEGAL ADVICE')
    s.append(body_p(
        'Nothing in this document constitutes tax, legal, accounting, or investment advice. Prospective investors '
        'should consult their own advisors regarding the tax, legal, regulatory, and financial implications of an '
        'investment in the Fund. Tax treatment of Fund investments is complex and depends on the investor\'s '
        'individual circumstances.'
    ))
    s += subsection_heading('FEE IMPACT NOTICE')
    s.append(body_p(
        'The compounded effect of management and performance fees, even at the rates disclosed, is material over '
        'multi-year periods. A 2% management fee alone compounded over 7 years reduces ending equity by approximately '
        f'13%. All NET performance figures in this document already reflect these fees; GROSS figures, where shown '
        f'separately, do not. Investors are cautioned to rely on NET figures when evaluating their expected outcome.'
    ))
    s += subsection_heading('CONFIDENTIALITY')
    s.append(body_p(
        'This document is confidential and is intended solely for the recipient. It may not be reproduced, '
        'distributed, or disclosed to any other person without the prior written consent of the Manager. '
        'Unauthorized disclosure may subject the discloser to legal action.'
    ))
    s.append(Spacer(1, 6))
    s.append(Paragraph(
        f'<font color="#888888">(c) 2026 PNTHR Funds. All rights reserved. The Fund, the Manager, and their '
        f'respective logos are property of PNTHR Funds.</font>',
        S('copyr', fontSize=8, alignment=TA_LEFT, textColor=MGRAY)))
    return s


# ════════════════════════════════════════════════════════════════════════════
# MAIN BUILD
# ════════════════════════════════════════════════════════════════════════════
def build_per_tier_ir(tier_key):
    json_path = os.path.join(OUT_DIR, f'pnthr_ir_metrics_{tier_key}_2026_04_21.json')
    if not os.path.exists(json_path):
        print(f'  !! Missing metrics JSON: {json_path}')
        return None
    with open(json_path) as f:
        t = json.load(f)

    story = []
    story += section_cover(t)
    story += section_toc(t)
    story += section_executive_summary(t)
    story += section_fees(t)
    story += section_crisis_annual_direction(t)
    story += section_heatmap(t)
    story += section_drawdown(t)
    story += section_risk_mae(t)
    story += section_rolling_bestworst(t)
    story += section_methodology(t)
    story += section_daily_nav_log(t)
    story += section_cumulative_growth_page(t)
    story += section_executive_recap(t)
    story += section_summary(t)
    story += section_methodology_assumptions(t)
    story += section_disclosures(t)

    filename = f'PNTHR_Pyramid_IR_{t["label"]}_{tier_key}_v1.pdf'
    title_meta = f'PNTHR Funds - Carnivore Quant Fund, LP - {t["classLabel"]} Pyramid Intelligence Report v1'
    return build_doc(filename, title_meta, story)


def section_heatmap(t):
    """Per-day NAV log grouped by month. Each month: yellow header + column
    headers + daily rows + monthly TOTAL row (summarizing opens/closes/P&L).
    Rows per page tuned so months don't awkwardly span page breaks."""
    s = section_heading('COMPREHENSIVE DAILY NAV LOG')
    s.append(body_p(
        'Complete daily mark-to-market portfolio balance for every trading day from '
        f'{t["gross"]["startDate"]} through {t["gross"]["endDate"]}. Each entry includes equity, open positions, '
        'month-to-date return, SPY comparison, and all trade activity (opens and closes with P&L).'
    ))
    s.append(Spacer(1, 6))

    daily = t['gross'].get('dailySeries', [])
    monthly_summary = {m['month']: m for m in t['gross'].get('monthlyActivitySummary', [])}
    if not daily:
        s.append(note_p('Daily NAV series unavailable; regenerate metrics JSON.'))
        s.append(PageBreak())
        return s

    # Group by month
    from collections import OrderedDict
    by_month = OrderedDict()
    for d in daily:
        ym = d['date'][:7]
        by_month.setdefault(ym, []).append(d)

    col_widths = [0.65*inch, 1.0*inch, 1.1*inch, 0.40*inch, 0.55*inch, CONTENT_W - 3.70*inch]

    # Helper to build the column-header row used at the start of every month
    def month_header_row():
        hdr = [
            Paragraph('<b><font color="#fcf000">DATE</font></b>',        S('d_h0', fontSize=8, alignment=TA_LEFT)),
            Paragraph('<b><font color="#fcf000">SPY EQUITY</font></b>',  S('d_h1', fontSize=8, alignment=TA_RIGHT)),
            Paragraph('<b><font color="#fcf000">PNTHR EQUITY</font></b>',S('d_h2', fontSize=8, alignment=TA_RIGHT)),
            Paragraph('<b><font color="#fcf000">OPEN</font></b>',        S('d_h3', fontSize=8, alignment=TA_RIGHT)),
            Paragraph('<b><font color="#fcf000">MTD %</font></b>',       S('d_h4', fontSize=8, alignment=TA_RIGHT)),
            Paragraph('<b><font color="#fcf000">ACTIVITY</font></b>',    S('d_h5', fontSize=8, alignment=TA_LEFT)),
        ]
        return hdr

    for ym, days in by_month.items():
        # Month section header: "JUN 2019  Start: $1,000,000"
        dt_obj = _dt.strptime(ym + '-01', '%Y-%m-%d')
        month_label = dt_obj.strftime('%b %Y').upper()
        start_nav = days[0]['net'] if days[0]['net'] is not None else days[0]['gross']
        month_hdr = Table(
            [[Paragraph(f'<b><font color="#fcf000">{month_label}</font></b>',
                         S('mhl', fontSize=10.5, alignment=TA_LEFT, textColor=YELLOW, fontName='Helvetica-Bold')),
              Paragraph(f'<font color="#cccccc">Start: {fmt_usd(start_nav)}</font>',
                        S('mhs', fontSize=9, alignment=TA_LEFT, textColor=OFFWHT))]],
            colWidths=[1.6*inch, CONTENT_W - 1.6*inch]
        )
        month_hdr.setStyle(TableStyle([
            ('VALIGN',       (0,0), (-1,-1), 'BOTTOM'),
            ('LEFTPADDING',  (0,0), (-1,-1), 0),
            ('TOPPADDING',   (0,0), (-1,-1), 6),
            ('BOTTOMPADDING',(0,0), (-1,-1), 3),
        ]))

        # Build all rows for this month (header + daily + TOTAL)
        data_rows = [month_header_row()]
        for d in days:
            pn_c = '#fcf000'  # yellow consistent for PNTHR equity
            mtd = d.get('mtdPct', 0)
            mtd_c = '#22c55e' if mtd > 0 else ('#ef4444' if mtd < 0 else '#cccccc')
            activity_html = _format_activity_colored(
                d.get('activity', ''),
                d.get('closesList', []),
                d.get('opensList', {'BL': [], 'SS': []}),
            )
            data_rows.append([
                Paragraph(f'<font color="#ffffff">{d["date"][5:]}</font>',                       S('dd0', fontSize=8)),
                Paragraph(f'<font color="#cccccc">{fmt_usd(d.get("spyEquity", 0))}</font>',      S('dd1', fontSize=8, alignment=TA_RIGHT)),
                Paragraph(f'<font color="{pn_c}">{fmt_usd(d["net"] if d["net"] is not None else d["gross"])}</font>', S('dd2', fontSize=8, alignment=TA_RIGHT)),
                Paragraph(f'<font color="#ffffff">{d.get("openCount", 0)}</font>',               S('dd3', fontSize=8, alignment=TA_RIGHT)),
                Paragraph(f'<font color="{mtd_c}">{"+" if mtd > 0 else ""}{mtd:.2f}%</font>',    S('dd4', fontSize=8, alignment=TA_RIGHT)),
                Paragraph(activity_html, S('dd5', fontSize=7.5, leading=9.5, alignment=TA_LEFT)),
            ])

        # Month TOTAL row
        ms = monthly_summary.get(ym, {})
        spy_pct = ms.get('spyPct', 0)
        net_pct = ms.get('netPct', 0)
        opened  = ms.get('opened', 0)
        closed  = ms.get('closed', 0)
        endOpen = ms.get('endOpen', 0)
        netPL   = ms.get('netPL', 0)
        spy_c = '#22c55e' if spy_pct > 0 else ('#ef4444' if spy_pct < 0 else '#cccccc')
        net_c = '#22c55e' if net_pct > 0 else ('#ef4444' if net_pct < 0 else '#cccccc')
        pl_c  = '#22c55e' if netPL  >= 0 else '#ef4444'
        pl_str = f'{"+$" if netPL >= 0 else "-$"}{abs(netPL):,}'

        data_rows.append([
            Paragraph(f'<b><font color="#fcf000">{month_label.split()[0]} TOTAL</font></b>', S('mt0', fontSize=8.5)),
            Paragraph(f'<b><font color="{spy_c}">{spy_pct:+.2f}%</font></b>',               S('mt1', fontSize=8.5, alignment=TA_RIGHT)),
            Paragraph(f'<b><font color="{net_c}">{net_pct:+.2f}%</font></b>',               S('mt2', fontSize=8.5, alignment=TA_RIGHT)),
            Paragraph(f'<b><font color="#ffffff">{endOpen}</font></b>',                      S('mt3', fontSize=8.5, alignment=TA_RIGHT)),
            Paragraph(f'<b><font color="{net_c}">{net_pct:+.2f}%</font></b>',               S('mt4', fontSize=8.5, alignment=TA_RIGHT)),
            Paragraph(
                f'<font color="#cccccc">{opened} opened, {closed} closed, {endOpen} open, </font>'
                f'<font color="{pl_c}">{pl_str}</font><font color="#cccccc"> net P&amp;L</font>',
                S('mt5', fontSize=8, leading=10, alignment=TA_LEFT)),
        ])

        # Build the month Table
        mtbl = Table(data_rows, colWidths=col_widths, repeatRows=1)
        # Row styling
        style = [
            ('VALIGN',       (0,0), (-1,-1), 'TOP'),
            ('TOPPADDING',   (0,0), (-1,-1), 1.5),
            ('BOTTOMPADDING',(0,0), (-1,-1), 1.5),
            ('LEFTPADDING',  (0,0), (-1,-1), 3),
            ('RIGHTPADDING', (0,0), (-1,-1), 3),
            # Header underline
            ('LINEBELOW',    (0,0), (-1,0), 0.4, DGRAY),
            # TOTAL row: yellow underline + slightly darker bg
            ('LINEABOVE',    (0,-1), (-1,-1), 0.5, YELLOW),
            ('BACKGROUND',   (0,-1), (-1,-1), HexColor('#111111')),
            ('TOPPADDING',   (0,-1), (-1,-1), 4),
            ('BOTTOMPADDING',(0,-1), (-1,-1), 4),
        ]
        mtbl.setStyle(TableStyle(style))

        # Keep the month header + first ~6 rows together so they don't orphan; use
        # KeepTogether only for the header + first few rows (not the whole month,
        # which often exceeds one page)
        s.append(month_hdr)
        s.append(mtbl)
        s.append(Spacer(1, 8))

    s.append(PageBreak())
    return s

    s = section_heading('MONTHLY RETURNS HEATMAP (NET %)')
    net_months = t['net']['monthlyReturns']
    by_year = {}
    for m in net_months:
        y, mn = m['m'].split('-')
        by_year.setdefault(y, {})[mn] = m['ret']
    header = ['', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC', 'YEAR']
    rows = []
    for y in sorted(by_year.keys()):
        row = [y]
        for mn in ['01','02','03','04','05','06','07','08','09','10','11','12']:
            v = by_year[y].get(mn)
            row.append(v)
        ann = next((a['ret'] for a in t['net']['annualReturns'] if a['year'] == y), None)
        row.append(ann)
        rows.append(row)

    # Render
    data = [[Paragraph(f'<b><font color="#fcf000">{h}</font></b>',
                       S(f'hh{i}', fontSize=8, alignment=TA_CENTER if i > 0 else TA_LEFT))
             for i, h in enumerate(header)]]
    for row in rows:
        cells = [Paragraph(f'<font color="#ffffff"><b>{row[0]}</b></font>', S(f'hy{row[0]}', fontSize=8, alignment=TA_CENTER))]
        for v in row[1:-1]:
            if v is None:
                cells.append(Paragraph('<font color="#444444">-</font>', S('hn', fontSize=7, alignment=TA_CENTER)))
            else:
                cells.append(Paragraph(f'<font color="#000000"><b>{v:+.1f}</b></font>', S('hv', fontSize=7, alignment=TA_CENTER)))
        # year col
        ann = row[-1]
        if ann is None:
            cells.append(Paragraph('<font color="#444444">-</font>', S('hp', fontSize=7, alignment=TA_CENTER)))
        else:
            cells.append(Paragraph(f'<font color="#000000"><b>{ann:+.1f}%</b></font>', S('hpv', fontSize=7, alignment=TA_CENTER)))
        data.append(cells)

    col_widths = [0.48*inch] + [(CONTENT_W - 0.48*inch - 0.75*inch) / 12] * 12 + [0.75*inch]
    tbl = Table(data, colWidths=col_widths)
    style = [
        ('ALIGN',         (0,0), (-1,-1), 'CENTER'),
        ('VALIGN',        (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING',    (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
        ('LEFTPADDING',   (0,0), (-1,-1), 2),
        ('RIGHTPADDING',  (0,0), (-1,-1), 2),
        ('GRID',          (0,0), (-1,-1), 0.25, DGRAY),
        ('LINEBELOW',     (0,0), (-1,0), 0.5, YELLOW),
    ]
    # Color each month cell background
    for ri, row in enumerate(rows, 1):
        for ci in range(1, 13):
            v = row[ci]
            if v is not None:
                style.append(('BACKGROUND', (ci, ri), (ci, ri), heatmap_bg(v)))
        if row[-1] is not None:
            style.append(('BACKGROUND', (-1, ri), (-1, ri), heatmap_bg(row[-1])))
    tbl.setStyle(TableStyle(style))
    s.append(tbl)
    s.append(Spacer(1, 6))
    pos = t['net']['positiveMonths']; tot = t['net']['totalMonths']; neg = tot - pos
    s.append(note_p(
        f'{pos} of {tot} months profitable ({(pos/tot*100):.1f}%)  |  Only {neg} negative months in 7 years  '
        f'|  Worst: {t["net"]["worstMonth"]["ret"]:.2f}%  |  Best: +{t["net"]["bestMonth"]["ret"]:.1f}%'
    ))
    s.append(PageBreak())
    return s


def section_drawdown(t):
    s = section_heading('DRAWDOWN ANALYSIS')
    net = t['net']
    s.append(body_p(
        f'The Fund operates with zero tolerance for capital impairment. The deepest daily peak-to-trough was '
        f'<b>{net["maxDD"]:.2f}%</b> on a NET basis - compared to SPY\'s {t["spy"]["maxDD"]:.1f}% during the same '
        f'seven-year window. Every drawdown fully recovered; at no point did investor capital sustain a permanent loss.'
    ))
    # 4 tiles
    tile_data = [
        (f'{net["maxDD"]:.2f}%',            'Max Peak-to-Trough (daily)',      '#ef4444'),
        (f'{net["timeUnderWater"]:.1f}%',   'Time Under Water',                '#f9a825'),
        (f'{net["recoveryFactor"]:.0f}',    'Recovery Factor',                  '#22c55e'),
        (f'{net["ulcerIndex"]:.2f}',        'Ulcer Index',                      '#fcf000'),
    ]
    tile_w = CONTENT_W / 4
    cells = []
    for val, label, hex_c in tile_data:
        cells.append([
            Paragraph(f'<font color="{hex_c}"><b>{val}</b></font>', S('dd_v', fontSize=17, leading=20, alignment=TA_LEFT, fontName='Helvetica-Bold')),
            Paragraph(f'<font color="#888888">{label}</font>',      S('dd_l', fontSize=7, leading=9, alignment=TA_LEFT)),
        ])
    dd_tiles = Table([cells], colWidths=[tile_w]*4)
    dd_tiles.setStyle(TableStyle([
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('TOPPADDING', (0,0), (-1,-1), 6),
        ('BOTTOMPADDING', (0,0), (-1,-1), 6),
    ]))
    s.append(dd_tiles)
    s.append(Spacer(1, 8))

    # Top 5 DDs
    dd_rows = []
    for i, dd in enumerate(net['top5Drawdowns'], 1):
        dd_rows.append([
            Paragraph(f'<font color="#ffffff">{i}</font>', S(f'td{i}0', fontSize=9, alignment=TA_CENTER)),
            Paragraph(f'<font color="#ffffff">{dd["start"]}</font>',     S(f'td{i}1', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#ffffff">{dd["trough"]}</font>',    S(f'td{i}2', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#ffffff">{dd["recovery"] or "ongoing"}</font>', S(f'td{i}3', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#cccccc">{dd["duration"]} days</font>', S(f'td{i}4', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#ef4444">{dd["depthPct"]:+.2f}%</font>', S(f'td{i}5', fontSize=9, alignment=TA_RIGHT)),
        ])
    s.append(_dark_table(
        ['#', 'START', 'TROUGH', 'RECOVERY', 'DURATION', 'MTM TROUGH'],
        dd_rows,
        col_widths=[0.3*inch, 1.1*inch, 1.1*inch, 1.1*inch, 1.0*inch, CONTENT_W - 4.6*inch],
    ))
    s.append(Spacer(1, 6))

    # Underwater chart
    uw_path = os.path.join(TMP_DIR, f'underwater_{t["tier"]}.png')
    generate_underwater_chart(t, uw_path)
    if os.path.exists(uw_path):
        s.append(RLImage(uw_path, width=CONTENT_W, height=2.0*inch))
    s.append(PageBreak())
    return s


def section_risk_mae(t):
    s = section_heading('RISK ARCHITECTURE')
    s.append(body_p(
        'The Carnivore Quant Fund is engineered for capital preservation first, alpha generation second. Every aspect '
        'of the system - from signal selection to position sizing to exit discipline - ensures the portfolio can '
        'absorb adverse conditions without meaningful drawdown.'
    ))
    s += subsection_heading('1% Vitality Cap')
    s.append(body_p('Each stock position risks a maximum of 1% of NAV. ETFs 0.5%. Share count = floor(risk budget / risk per share).'))
    s += subsection_heading('5-Lot Pyramid System')
    s.append(body_p('Initial entry deploys only 35% of the full position. Subsequent lots earned through sequential confirmation, each requiring prior lot filled + time gate + price trigger.'))
    s += subsection_heading('10% Position Cap')
    s.append(body_p('No single ticker can exceed 10% of NAV in total exposure.'))
    s += subsection_heading('Sector Concentration (Advisory)')
    s.append(body_p('Net directional exposure surfaced as an advisory notification at 3+ positions per sector. No hard cap; the Strategy may concentrate when trend and macro conditions favor a sector.'))
    s += subsection_heading('Portfolio Heat Caps')
    s.append(body_p('Total open risk capped at 10% stocks / 5% ETFs / 15% combined. Recycled positions carry $0 risk.'))
    s += subsection_heading('Systematic Exit Discipline')
    s.append(body_p('Exits: EMA crossover reversal, RSI > 85 FEAST alert, ATR stop hit, 20-day stale hunt, risk advisor triggers.'))
    s += subsection_heading('Wash Sale Compliance')
    s.append(body_p('30-day re-entry lockout on losing trades, automatically enforced.'))

    s += section_heading('WORST-CASE TRADE ANALYSIS (MAX ADVERSE EXCURSION)')
    s.append(body_p(
        f'The maximum adverse excursion (MAE) measures the worst intra-trade price move against a position before exit. '
        f'The table below shows the 10 most extreme adverse moves across {t["trades"]["closed"]:,} closed pyramid trades. '
        f'Despite these drawdowns, the portfolio never experienced a negative month-end decline below prior highs.'
    ))
    mae_rows = []
    for m in t['mae10']:
        pnl_c = '#22c55e' if m['netPnl'] >= 0 else '#ef4444'
        mae_rows.append([
            Paragraph(f'<font color="#fcf000"><b>{m["ticker"]}</b></font>', S(f'm0{m["ticker"]}', fontSize=9)),
            Paragraph(f'<font color="#ffffff">{m["signal"]}</font>',        S(f'm1{m["ticker"]}', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#cccccc">{m["entryDate"]}</font>',     S(f'm2{m["ticker"]}', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#cccccc">{m["exitDate"]}</font>',      S(f'm3{m["ticker"]}', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#ef4444">{m["maePct"]:.1f}%</font>',   S(f'm4{m["ticker"]}', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="{pnl_c}">{"$" if m["netPnl"] >= 0 else "-$"}{abs(m["netPnl"]):,.0f}</font>', S(f'm5{m["ticker"]}', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#cccccc">{m["exitReason"]}</font>',    S(f'm6{m["ticker"]}', fontSize=9, alignment=TA_RIGHT)),
        ])
    s.append(_dark_table(
        ['TICKER', 'SIGNAL', 'ENTRY', 'EXIT', 'MAE %', 'NET P&L', 'EXIT REASON'],
        mae_rows,
        col_widths=[0.7*inch, 0.7*inch, 0.95*inch, 0.95*inch, 0.7*inch, 0.95*inch, CONTENT_W - 4.9*inch],
    ))
    s.append(PageBreak())
    return s


def section_rolling_bestworst(t):
    s = section_heading('ROLLING 12-MONTH RETURNS')
    r12m = t['net']['rolling12m']
    if r12m:
        min_r = min(r['ret'] for r in r12m)
        neg_count = sum(1 for r in r12m if r['ret'] < 0)
        min_end = next((r['endMonth'] for r in r12m if r['ret'] == min_r), 'n/a')
        s.append(body_p(
            f'Across {len(r12m)} rolling 12-month windows, the minimum return was {min_r:+.1f}% (ending {min_end}). '
            f'{"No" if neg_count == 0 else str(neg_count)} rolling 12-month period'
            f'{"s were" if neg_count != 1 else " was"} negative. The Fund has generated positive absolute returns '
            f'over every trailing year of the backtest.'
        ))
        sampled = r12m[::6]
        r_rows = []
        for r in sampled:
            c = '#22c55e' if r['ret'] > 0 else '#ef4444'
            r_rows.append([
                Paragraph(f'<font color="#ffffff">{r["endMonth"]}</font>', S(f'r0{r["endMonth"]}', fontSize=9)),
                Paragraph(f'<font color="{c}">{r["ret"]:+.1f}%</font>',    S(f'r1{r["endMonth"]}', fontSize=9, alignment=TA_RIGHT)),
            ])
        s.append(_dark_table(
            ['ENDING MONTH', 'TRAILING 12M RETURN'],
            r_rows,
            col_widths=[CONTENT_W/2]*2,
        ))

    s += section_heading('BEST & WORST TRADING DAYS')
    s.append(body_p('Data is sorted by Daily Return.'))
    s += subsection_heading('10 WORST DAYS')
    wd_rows = []
    for d in t['net']['top10WorstDays']:
        wd_rows.append([
            Paragraph(f'<font color="#ffffff">{d["date"]}</font>',          S(f'w0{d["date"]}', fontSize=9)),
            Paragraph(f'<font color="#ef4444">{d["ret"]:+.3f}%</font>',     S(f'w1{d["date"]}', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#cccccc">{fmt_usd(d["equity"])}</font>', S(f'w2{d["date"]}', fontSize=9, alignment=TA_RIGHT)),
        ])
    s.append(_dark_table(
        ['DATE', 'DAILY RETURN', 'PNTHR EQUITY'],
        wd_rows,
        col_widths=[1.5*inch, 1.5*inch, CONTENT_W - 3.0*inch],
    ))
    s += subsection_heading('10 BEST DAYS')
    bd_rows = []
    for d in t['net']['top10BestDays']:
        bd_rows.append([
            Paragraph(f'<font color="#ffffff">{d["date"]}</font>',          S(f'b0{d["date"]}', fontSize=9)),
            Paragraph(f'<font color="#22c55e">{d["ret"]:+.3f}%</font>',     S(f'b1{d["date"]}', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#cccccc">{fmt_usd(d["equity"])}</font>', S(f'b2{d["date"]}', fontSize=9, alignment=TA_RIGHT)),
        ])
    s.append(_dark_table(
        ['DATE', 'DAILY RETURN', 'PNTHR EQUITY'],
        bd_rows,
        col_widths=[1.5*inch, 1.5*inch, CONTENT_W - 3.0*inch],
    ))
    s.append(PageBreak())
    return s


def section_crisis_annual_direction(t):
    s = section_heading('CRISIS ALPHA: PERFORMANCE DURING MARKET DRAWDOWNS')
    s.append(body_p(
        'The hallmark of a disciplined panther is composure under pressure. While the broader market experienced '
        'significant drawdowns, the Carnivore Quant Fund preserved and grew investor capital through every major event.'
    ))
    ca_rows = []
    for ev in t['crisisAlphaNet']:
        if ev['spyReturn'] is None:
            ca_rows.append([
                Paragraph(f'<font color="#ffffff">{ev["event"]}</font>',     S('ca0', fontSize=9)),
                Paragraph(f'<font color="#ffffff">{ev["period"]}</font>',    S('ca1', fontSize=9, alignment=TA_RIGHT)),
                Paragraph('<font color="#cccccc">-</font>',                   S('ca2', fontSize=9, alignment=TA_RIGHT)),
                Paragraph('<font color="#cccccc">-</font>',                   S('ca3', fontSize=9, alignment=TA_RIGHT)),
                Paragraph('<font color="#cccccc">-</font>',                   S('ca4', fontSize=9, alignment=TA_RIGHT)),
            ])
        else:
            spy_c = '#ef4444' if ev['spyReturn'] < 0 else '#22c55e'
            pn_c  = '#ef4444' if ev['pnthrReturn'] < 0 else '#22c55e'
            al_c  = '#ef4444' if ev['alpha'] < 0 else '#22c55e'
            ca_rows.append([
                Paragraph(f'<font color="#ffffff">{ev["event"]}</font>',     S('ca0', fontSize=9)),
                Paragraph(f'<font color="#ffffff">{ev["period"]}</font>',    S('ca1', fontSize=9, alignment=TA_RIGHT)),
                Paragraph(f'<font color="{spy_c}">{ev["spyReturn"]:+.1f}%</font>',  S('ca2', fontSize=9, alignment=TA_RIGHT)),
                Paragraph(f'<font color="{pn_c}">{ev["pnthrReturn"]:+.1f}%</font>', S('ca3', fontSize=9, alignment=TA_RIGHT)),
                Paragraph(f'<font color="{al_c}">{ev["alpha"]:+.1f}%</font>',       S('ca4', fontSize=9, alignment=TA_RIGHT)),
            ])
    s.append(_dark_table(
        ['MARKET EVENT', 'PERIOD', 'S&P 500', 'PNTHR FUND', 'PNTHR ALPHA'],
        ca_rows,
        col_widths=[2.0*inch, 1.6*inch, 0.95*inch, 1.0*inch, CONTENT_W - 5.55*inch],
    ))

    s += section_heading('ANNUAL PERFORMANCE: PNTHR vs S&P 500')
    a_rows = []
    for ar in t['net']['annualReturns']:
        r_c = '#22c55e' if ar['ret'] > 0 else ('#ef4444' if ar['ret'] < 0 else '#cccccc')
        a_rows.append([
            Paragraph(f'<font color="#ffffff">{ar["year"]}</font>', S('an0', fontSize=9)),
            Paragraph(f'<font color="#cccccc">{fmt_usd(ar["startEquity"], compact=True)}</font>', S('an1', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#fcf000">{fmt_usd(ar["endEquity"], compact=True)}</font>',   S('an2', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="{r_c}">{ar["ret"]:+.2f}%</font>', S('an3', fontSize=9, alignment=TA_RIGHT)),
        ])
    s.append(_dark_table(
        ['YEAR', 'START EQUITY', 'END EQUITY', 'RETURN'],
        a_rows,
        col_widths=[0.9*inch, 1.4*inch, 1.4*inch, CONTENT_W - 3.7*inch],
    ))

    s += section_heading('STRATEGY METRICS BY DIRECTION (Pre-Fund-Fees)')
    bd = t['byDirection']
    d_rows = [
        ['CAGR (pre-fund-fees)',
         Paragraph(f'<font color="#22c55e">+{bd["bl"]["cagr"]:.1f}%</font>',        S('d0', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">+{bd["ss"]["cagr"]:.1f}%</font>',        S('d1', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">+{bd["combined"]["cagr"]:.1f}%</font>',  S('d2', fontSize=9, alignment=TA_RIGHT))],
        ['Sharpe Ratio',
         Paragraph(f'<font color="#fcf000">{bd["bl"]["sharpe"]:.2f}</font>',        S('d3', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#fcf000">{bd["ss"]["sharpe"]:.2f}</font>',        S('d4', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#fcf000">{bd["combined"]["sharpe"]:.2f}</font>',  S('d5', fontSize=9, alignment=TA_RIGHT))],
        ['Sortino Ratio',
         Paragraph(f'<font color="#fcf000">{bd["bl"]["sortino"]:.2f}</font>',       S('d6', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#fcf000">{bd["ss"]["sortino"]:.2f}</font>',       S('d7', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#fcf000">{bd["combined"]["sortino"]:.2f}</font>', S('d8', fontSize=9, alignment=TA_RIGHT))],
        ['Max Drawdown',
         Paragraph(f'<font color="#ef4444">{bd["bl"]["maxDD"]:.2f}%</font>',        S('d9', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ef4444">{bd["ss"]["maxDD"]:.2f}%</font>',        S('d10', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ef4444">{bd["combined"]["maxDD"]:.2f}%</font>',  S('d11', fontSize=9, alignment=TA_RIGHT))],
        ['Calmar Ratio',
         Paragraph(f'<font color="#fcf000">{bd["bl"]["calmar"]:.1f}</font>',        S('d12', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#fcf000">{bd["ss"]["calmar"]:.1f}</font>',        S('d13', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#fcf000">{bd["combined"]["calmar"]:.1f}</font>',  S('d14', fontSize=9, alignment=TA_RIGHT))],
        ['Profit Factor',
         Paragraph(f'<font color="#22c55e">{t["trades"]["bl"]["profitFactor"]:.2f}x</font>',       S('d15', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">{t["trades"]["ss"]["profitFactor"]:.2f}x</font>',       S('d16', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">{t["trades"]["combined"]["profitFactor"]:.2f}x</font>', S('d17', fontSize=9, alignment=TA_RIGHT))],
        ['Win Rate',
         Paragraph(f'<font color="#22c55e">{t["trades"]["bl"]["winRate"]:.1f}%</font>',            S('d18', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">{t["trades"]["ss"]["winRate"]:.1f}%</font>',            S('d19', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">{t["trades"]["combined"]["winRate"]:.1f}%</font>',      S('d20', fontSize=9, alignment=TA_RIGHT))],
        ['Best Month',
         Paragraph(f'<font color="#22c55e">+{bd["bl"]["bestMonth"]["ret"]:.1f}%</font>',           S('d21', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">+{bd["ss"]["bestMonth"]["ret"]:.1f}%</font>',           S('d22', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">+{bd["combined"]["bestMonth"]["ret"]:.1f}%</font>',     S('d23', fontSize=9, alignment=TA_RIGHT))],
        ['Total Trades',
         Paragraph(f'<font color="#ffffff">{bd["bl"]["count"]:,}</font>',           S('d24', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ffffff">{bd["ss"]["count"]:,}</font>',           S('d25', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ffffff">{bd["combined"]["count"]:,}</font>',     S('d26', fontSize=9, alignment=TA_RIGHT))],
    ]
    s.append(_dark_table(
        ['METRIC', 'BL (LONGS)', 'SS (SHORTS)', 'COMBINED'],
        d_rows,
        col_widths=[2.2*inch, (CONTENT_W-2.2*inch)/3, (CONTENT_W-2.2*inch)/3, (CONTENT_W-2.2*inch)/3],
    ))
    s.append(PageBreak())
    return s

def section_toc(t):
    s = section_heading('TABLE OF CONTENTS')
    toc = [
        ('ACT I - THE RESULTS', None),
        ('Executive Summary', 3),
        ('Performance Comparison: PNTHR vs. S&P 500', 3),
        ('Gross vs Net: Impact of the Fee Schedule', 3),
        ('Fees & Expenses Schedule (PPM Reconciliation)', 4),
        ('Crisis Alpha: Performance During Market Drawdowns', 6),
        ('Annual Performance: PNTHR vs S&P 500', 6),
        ('Strategy Metrics by Direction', 6),
        ('Monthly Returns Heatmap', 7),
        ('Drawdown Analysis', 8),
        ('Risk Architecture', 9),
        ('Worst-Case Trade Analysis (MAE)', 9),
        ('Rolling 12-Month Returns', 10),
        ('Best & Worst Trading Days', 10),
        ('ACT II - THE METHODOLOGY', None),
        ('1. The PNTHR Philosophy & Platform', 11),
        ('2. PNTHR Signal Generation', 12),
        ('3. The PNTHR Kill Scoring Engine', 13),
        ('4. PNTHR Analyze Pre-Trade Scoring', 14),
        ('5. PNTHR Position Sizing & Pyramiding', 15),
        ('6. Portfolio Command Center & Entry Workflow', 16),
        ('7. Scoring Health / Archive / History / IBKR Bridge', 17),
        ('8. Institutional Backtest Results', 17),
        ('9. Empirical Evidence', 19),
        ('ACT III - THE PROOF', None),
        ('Comprehensive Daily NAV Log', 20),
        ('ACT IV - THE CLOSE', None),
        ('Cumulative Growth Chart', 58),
        ('Executive Recap', 59),
        ('Summary', 60),
        ('Methodology & Assumptions', 62),
        ('Important Disclosures', 64),
    ]
    rows = []
    for label, pg in toc:
        if pg is None:
            rows.append([
                Paragraph(f'<b><font color="#fcf000">{label}</font></b>',
                          S('t_act', fontSize=10.5, leading=14)),
                ''
            ])
        else:
            rows.append([
                Paragraph(f'<font color="#cccccc">{label}</font>',
                          S('t_r', fontSize=9.5, leading=12.5, textColor=OFFWHT)),
                Paragraph(f'<font color="#888888">{pg}</font>',
                          S('t_pg', fontSize=9.5, leading=12.5, textColor=LGRAY, alignment=TA_RIGHT)),
            ])
    tbl = Table(rows, colWidths=[CONTENT_W - 0.5*inch, 0.5*inch])
    tbl.setStyle(TableStyle([
        ('TOPPADDING',    (0,0), (-1,-1), 2),
        ('BOTTOMPADDING', (0,0), (-1,-1), 2),
        ('LEFTPADDING',   (0,0), (-1,-1), 0),
    ]))
    s.append(tbl)
    s.append(PageBreak())
    return s


# ────────────────────────────────────────────────────────────────────────────
# ACT I — THE RESULTS
# ────────────────────────────────────────────────────────────────────────────
def _dark_table(headers, rows, col_widths, align_right_from=1, first_col_color=None):
    """Standard dark-page table: yellow column header row, light rows below."""
    data = [[Paragraph(f'<b><font color="#fcf000">{h}</font></b>',
                       S(f'dh{i}', fontSize=9, alignment=TA_LEFT if i == 0 else TA_RIGHT))
             for i, h in enumerate(headers)]] + rows
    tbl = Table(data, colWidths=col_widths)
    style = [
        ('FONTSIZE',     (0,0), (-1,-1), 9),
        ('TEXTCOLOR',    (0,1), (-1,-1), OFFWHT),
        ('ALIGN',        (align_right_from,0), (-1,-1), 'RIGHT'),
        ('ALIGN',        (0,0), (0,-1), 'LEFT'),
        ('VALIGN',       (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING',   (0,0), (-1,-1), 4),
        ('BOTTOMPADDING',(0,0), (-1,-1), 4),
        ('LEFTPADDING',  (0,0), (-1,-1), 2),
        ('RIGHTPADDING', (0,0), (-1,-1), 6),
        ('LINEBELOW',    (0,0), (-1,0), 0.5, DGRAY),
    ]
    if first_col_color:
        style.append(('TEXTCOLOR', (0,1), (0,-1), first_col_color))
    tbl.setStyle(TableStyle(style))
    return tbl

def section_executive_summary(t):
    s = section_heading('EXECUTIVE SUMMARY')
    net = t['net']; gross = t['gross']
    s.append(body_p(
        'The Carnivore Quant Fund employs a proprietary systematic long/short equity strategy that identifies '
        'high-conviction entry points through an 8-dimensional scoring engine applied to the PNTHR 679 universe, '
        'a curated selection of liquid U.S. equities. Like its namesake, the system stalks opportunity with '
        'discipline, strikes with precision, and manages risk with the instinct of a panther that never overextends.'
    ))
    s.append(Spacer(1, 4))
    s.append(body_p(
        f'Over a rigorous {gross["years"]:.1f}-year backtest spanning {gross["startDate"]} through {gross["endDate"]}, '
        f'the strategy delivered a <b>+{net["cagr"]:.2f}% net CAGR</b> with a <b>{net["sharpe"]:.2f} Sharpe</b> and a '
        f'<b>{t["trades"]["combined"]["profitFactor"]:.2f}x profit factor</b>, transforming '
        f'<b>{fmt_usd(t["seedNav"])}</b> into <b>{fmt_usd(net["endNav"], compact=True)}</b>. During the same period '
        f'a passive S&amp;P 500 allocation returned +{t["spy"]["totalReturn"]:.1f}%, producing '
        f'<b>{fmt_usd(t["spy"]["endingEquity"], compact=True)}</b>. The Fund generated '
        f'<b>{fmt_usd(net["endNav"] - t["spy"]["endingEquity"], compact=True)} of alpha</b>.'
    ))
    s.append(Spacer(1, 4))
    s.append(body_p(
        f'The Fund\'s risk architecture is built on absolute capital preservation. The maximum daily mark-to-market '
        f'drawdown across {net["totalMonths"]} months was <b>{net["maxDD"]:.2f}%</b> on a net basis, compared to '
        f'the SPY benchmark\'s {t["spy"]["maxDD"]:.1f}% over the same window. '
        f'<b>{net["positiveMonths"]} of {net["totalMonths"]} months ({net["positivePct"]:.1f}%) were profitable</b> on a net basis.'
    ))
    s.append(Spacer(1, 4))
    s.append(body_p(
        'Position sizing is mathematically constrained: each trade risks a maximum of 1% of net asset value, with a '
        '5-lot pyramid system that deploys just 35% of the full position at initial entry. Subsequent lot triggers '
        'are proprietary. Even the worst single-trade adverse excursion translated to approximately 0.5% of portfolio '
        'NAV at the initial entry risk level.'
    ))

    # Performance Comparison
    s += section_heading('PERFORMANCE COMPARISON: PNTHR vs. S&P 500')
    pc_rows = [
        ['Total Return (7yr)',
         Paragraph(f'<font color="#22c55e">+{net["totalReturn"]:.1f}%</font>',    S('p1', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#cccccc">+{t["spy"]["totalReturn"]:.1f}%</font>',S('p2', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">+{net["totalReturn"] - t["spy"]["totalReturn"]:.1f}%</font>', S('p3', fontSize=9, alignment=TA_RIGHT))],
        ['CAGR (Net)',
         Paragraph(f'<font color="#22c55e">+{net["cagr"]:.2f}%</font>',           S('p4', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#cccccc">+{t["spy"]["cagr"]:.2f}%</font>',      S('p5', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">+{net["cagr"] - t["spy"]["cagr"]:.2f}%</font>', S('p6', fontSize=9, alignment=TA_RIGHT))],
        ['Sharpe Ratio',
         Paragraph(f'<font color="#fcf000">{net["sharpe"]:.2f}</font>',           S('p7', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#cccccc">{t["spy"]["sharpe"]:.2f}</font>',      S('p8', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">-</font>',                               S('p9', fontSize=9, alignment=TA_RIGHT))],
        ['Sortino Ratio',
         Paragraph(f'<font color="#fcf000">{net["sortino"]:.2f}</font>',          S('p10', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#cccccc">{t["spy"]["sortino"]:.2f}</font>',     S('p11', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">-</font>',                               S('p12', fontSize=9, alignment=TA_RIGHT))],
        ['Max Monthly Peak-to-Trough',
         Paragraph(f'<font color="#ef4444">{net["maxDD"]:.2f}%</font>',           S('p13', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ef4444">{t["spy"]["maxDD"]:.1f}%</font>',      S('p14', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">-</font>',                               S('p15', fontSize=9, alignment=TA_RIGHT))],
        ['Calmar Ratio',
         Paragraph(f'<font color="#fcf000">{net["calmar"]:.1f}</font>',           S('p16', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">-</font>',                               S('p17', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">-</font>',                               S('p18', fontSize=9, alignment=TA_RIGHT))],
        ['Positive Months',
         Paragraph(f'<font color="#22c55e">{net["positiveMonths"]}/{net["totalMonths"]} ({net["positivePct"]:.1f}%)</font>', S('p19', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">~60%</font>',                            S('p20', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">-</font>',                               S('p21', fontSize=9, alignment=TA_RIGHT))],
        ['Win Rate',
         Paragraph(f'<font color="#22c55e">{t["trades"]["combined"]["winRate"]:.1f}%</font>', S('p22', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">N/A</font>',                             S('p23', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">-</font>',                               S('p24', fontSize=9, alignment=TA_RIGHT))],
        ['Profit Factor',
         Paragraph(f'<font color="#22c55e">{t["trades"]["combined"]["profitFactor"]:.2f}x</font>', S('p25', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">N/A</font>',                             S('p26', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">-</font>',                               S('p27', fontSize=9, alignment=TA_RIGHT))],
        [f'Ending Equity ({fmt_usd(t["seedNav"])})',
         Paragraph(f'<font color="#fcf000">{fmt_usd(net["endNav"], compact=True)}</font>', S('p28', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#cccccc">{fmt_usd(t["spy"]["endingEquity"], compact=True)}</font>', S('p29', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">{fmt_usd(net["endNav"] - t["spy"]["endingEquity"], compact=True)}</font>', S('p30', fontSize=9, alignment=TA_RIGHT))],
    ]
    pc_tbl = _dark_table(
        ['METRIC', 'CARNIVORE QUANT FUND', 'S&P 500 (SPY)', 'ALPHA'],
        pc_rows,
        col_widths=[2.2*inch, (CONTENT_W - 2.2*inch)/3, (CONTENT_W - 2.2*inch)/3, (CONTENT_W - 2.2*inch)/3],
    )
    s.append(pc_tbl)

    # Gross vs Net
    s += section_heading('GROSS vs NET: IMPACT OF THE FEE SCHEDULE')
    s.append(body_p(
        f'All headline figures in this document are reported on a NET basis ({t["classLabel"]} fee schedule per PPM v6.9) '
        f'unless explicitly labeled "Gross." The table below shows both side-by-side so the cumulative impact of the full '
        f'fee schedule (2% annual management fee + {t["feeSchedule"]["yearsOneToThree"]}% / {t["feeSchedule"]["yearsFourPlus"]}% '
        f'quarterly performance allocation above the US 2-Year Treasury hurdle, subject to the HWM) is fully transparent.'
    ))
    gross = t['gross']
    gn_rows = [
        ['Total Return',
         Paragraph(f'<font color="#22c55e">+{gross["totalReturn"]:.1f}%</font>', S('gn1', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">+{net["totalReturn"]:.1f}%</font>',   S('gn2', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ef4444">-{gross["totalReturn"] - net["totalReturn"]:.1f} pts</font>', S('gn3', fontSize=9, alignment=TA_RIGHT))],
        ['CAGR',
         Paragraph(f'<font color="#22c55e">+{gross["cagr"]:.2f}%</font>',        S('gn4', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">+{net["cagr"]:.2f}%</font>',          S('gn5', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ef4444">-{gross["cagr"] - net["cagr"]:.2f} pts</font>', S('gn6', fontSize=9, alignment=TA_RIGHT))],
        ['Sharpe Ratio',
         Paragraph(f'<font color="#fcf000">{gross["sharpe"]:.2f}</font>',        S('gn7', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#fcf000">{net["sharpe"]:.2f}</font>',          S('gn8', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ef4444">-{gross["sharpe"] - net["sharpe"]:.2f}</font>', S('gn9', fontSize=9, alignment=TA_RIGHT))],
        ['Sortino Ratio',
         Paragraph(f'<font color="#fcf000">{gross["sortino"]:.2f}</font>',       S('gn10', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#fcf000">{net["sortino"]:.2f}</font>',         S('gn11', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ef4444">-{gross["sortino"] - net["sortino"]:.2f}</font>', S('gn12', fontSize=9, alignment=TA_RIGHT))],
        ['Calmar Ratio',
         Paragraph(f'<font color="#fcf000">{gross["calmar"]:.1f}</font>',        S('gn13', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#fcf000">{net["calmar"]:.1f}</font>',          S('gn14', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ef4444">-{gross["calmar"] - net["calmar"]:.1f}</font>', S('gn15', fontSize=9, alignment=TA_RIGHT))],
        ['Max Monthly Peak-to-Trough',
         Paragraph(f'<font color="#ef4444">{gross["maxDD"]:.2f}%</font>',        S('gn16', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ef4444">{net["maxDD"]:.2f}%</font>',          S('gn17', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#cccccc">{gross["maxDD"] - net["maxDD"]:+.2f} pts</font>', S('gn18', fontSize=9, alignment=TA_RIGHT))],
        ['Best Month',
         Paragraph(f'<font color="#22c55e">+{gross["bestMonth"]["ret"]:.2f}%</font>', S('gn19', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">+{net["bestMonth"]["ret"]:.2f}%</font>',   S('gn20', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">-</font>',                                 S('gn21', fontSize=9, alignment=TA_RIGHT))],
        ['Worst Month',
         Paragraph(f'<font color="#ef4444">{gross["worstMonth"]["ret"]:.2f}%</font>', S('gn22', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ef4444">{net["worstMonth"]["ret"]:.2f}%</font>',   S('gn23', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">-</font>',                                 S('gn24', fontSize=9, alignment=TA_RIGHT))],
        [f'Ending Equity ({fmt_usd(t["seedNav"])})',
         Paragraph(f'<font color="#fcf000">{fmt_usd(gross["endNav"], compact=True)}</font>', S('gn25', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#fcf000">{fmt_usd(net["endNav"], compact=True)}</font>',   S('gn26', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ef4444">-{fmt_usd(gross["endNav"] - net["endNav"], compact=True)}</font>', S('gn27', fontSize=9, alignment=TA_RIGHT))],
    ]
    gn_tbl = _dark_table(
        ['METRIC', 'GROSS', 'NET', 'FEE DRAG'],
        gn_rows,
        col_widths=[2.2*inch, (CONTENT_W - 2.2*inch)/3, (CONTENT_W - 2.2*inch)/3, (CONTENT_W - 2.2*inch)/3],
    )
    s.append(gn_tbl)
    s.append(Spacer(1, 4))
    s.append(note_p(
        f'Gross figures are post-transaction-costs (commissions, slippage, borrow) but BEFORE the 2.0% p.a. management fee '
        f'and before the {t["classLabel"]} performance allocation. Net figures are AFTER both fund-level fees, applied per '
        f'PPM sec. 4.1-4.3 mechanics: management fee accrued monthly on NAV, performance allocation charged QUARTERLY '
        f'(non-cumulative) on the portion of quarter-end NAV above the running HWM and above a quarterly hurdle equal to '
        f'US2Y / 4, with the loyalty discount applying after the 36-month anniversary.'
    ))
    s.append(PageBreak())
    return s



if __name__ == '__main__':
    print('Generating PNTHR per-tier Pyramid Intelligence Reports (v6-aligned)...\n')
    for tier_key in ['100k', '500k', '1m']:
        print(f'{tier_key}...')
        try:
            path = build_per_tier_ir(tier_key)
            if path:
                print(f'  -> {path}')
        except Exception as e:
            print(f'  !! ERROR: {e}')
            import traceback; traceback.print_exc()
    print('\nDone.')
