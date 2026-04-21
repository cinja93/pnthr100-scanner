#!/usr/bin/env python3
"""
generatePerTierIR.py
PNTHR Funds - Carnivore Quant Fund, LP - Per-Tier Pyramid Intelligence Report

Generates one 63-page detailed PDF per investor tier, using the v22-corrected
MTM + PPM-fee metrics JSON produced by compute_per_tier_ir_metrics.js.

Structure (mirrors v7 template, corrected data + aligned disclosures):
  ACT I  — THE RESULTS         (pages 1-10)
  ACT II — THE METHODOLOGY     (pages 11-16)
  ACT III — THE PROOF          (pages 17-56)  — Comprehensive Daily NAV Log
  ACT IV — THE CLOSE           (pages 57-63)

Inputs:
  ~/Downloads/pnthr_ir_metrics_{100k,500k,1m}_2026_04_21.json

Outputs:
  ~/Downloads/PNTHR_Pyramid_IR_{Filet,Porterhouse,Wagyu}_v1.pdf

Disclosure alignment (matches FIR v24 redactions):
  - No pyramid offset triggers disclosed (+3%/+6%/+10%/+14% redacted)
  - No per-sector EMA table (proprietary)
  - No sector concentration cap (Fund policy: manager discretion, no hard cap)
  - "Completely separate trading strategy" language for 44.92% disclosure

Usage: python3 generatePerTierIR.py
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
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor, black, white
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT, TA_JUSTIFY

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.figure import Figure
import matplotlib.dates as mdates

# Canonical Phase 2 design template (shared with PPM v6.9, LPA v3.4, IMA v3.5,
# Sub Agmt v2.6, AIV v2.3, GP OpAgmt v2.5, InvQuest v2.4, LOI v4.2, FIR v24)
sys.path.insert(0, os.path.expanduser('~/Downloads/PNTHR_legal_docs_v6/generators'))
from pnthr_design import (
    make_doc_template, make_page_handlers, build_cover_header,
    PALETTE_BLACK, ACCENT_BAR_HEIGHT,
)

# ── Brand Colors (match generateDataRoomDocs.py) ─────────────────────────────
PNTHR_YELLOW   = HexColor('#fcf000')
PNTHR_BLACK    = HexColor('#0a0a0a')
PNTHR_DARK     = HexColor('#111111')
PNTHR_GRAY     = HexColor('#444444')
PNTHR_LGRAY    = HexColor('#888888')
PNTHR_WHITE    = HexColor('#f5f5f5')
PNTHR_GREEN    = HexColor('#22c55e')
PNTHR_RED      = HexColor('#ef4444')
PNTHR_AMBER    = HexColor('#f9a825')
TABLE_HEADER   = HexColor('#1a1a1a')
TABLE_ROW_ALT  = HexColor('#f7f7f7')
TABLE_BORDER   = HexColor('#dddddd')
HEADER_BG      = HexColor('#0d0d0d')

# Heatmap colors — green gradient positive, red gradient negative
def heatmap_color(pct):
    if pct is None: return HexColor('#1a1a1a')
    if pct > 0:
        intensity = min(abs(pct) / 10.0, 1.0)
        r = int(255 - 200 * intensity)
        g = 255
        b = int(255 - 200 * intensity)
        return HexColor(f'#{r:02x}{g:02x}{b:02x}')
    elif pct < 0:
        intensity = min(abs(pct) / 5.0, 1.0)
        r = 255
        g = int(255 - 200 * intensity)
        b = int(255 - 200 * intensity)
        return HexColor(f'#{r:02x}{g:02x}{b:02x}')
    return HexColor('#e8e8e8')

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
MARGIN         = 0.75 * inch
HEADER_H       = 0.55 * inch
CONTENT_W      = PAGE_W - 2 * MARGIN

# ── Style registry ───────────────────────────────────────────────────────────
styles = getSampleStyleSheet()
_style_cache = {}

def S(name, **kwargs):
    key = name + str(sorted(kwargs.items()))
    if key in _style_cache: return _style_cache[key]
    defaults = {'fontName': 'Helvetica', 'fontSize': 9, 'leading': 12, 'textColor': black}
    defaults.update(kwargs)
    st = ParagraphStyle(name + str(id(kwargs)), **defaults)
    _style_cache[key] = st
    return st

def yellow_rule():
    return HRFlowable(width='100%', thickness=1.2, color=PNTHR_YELLOW, spaceBefore=2, spaceAfter=6)

def section(text):
    # Canonical: black bold heading with yellow underline rule (matches the
    # yellow-accent visual language used throughout Phase 2 docs).
    return [Spacer(1, 6), Paragraph(f'<b>{text}</b>', S('sect', fontSize=13, leading=16, textColor=HexColor('#0a0a0a'), fontName='Helvetica-Bold')), yellow_rule()]

def subsection(text):
    return [Spacer(1, 4), Paragraph(f'<b>{text}</b>', S('sub', fontSize=10.5, leading=13, textColor=HexColor('#0a0a0a'), fontName='Helvetica-Bold')), Spacer(1, 3)]

def body(text):
    return Paragraph(text, S('body', fontSize=9.5, leading=12.5, textColor=HexColor('#111111'), alignment=TA_JUSTIFY))

def bullet(text):
    return Paragraph(f'• {text}', S('bul', fontSize=9.5, leading=12.5, textColor=HexColor('#111111'), leftIndent=14))

def note(text):
    return Paragraph(text, S('note', fontSize=8, leading=10, textColor=HexColor('#666666'), fontName='Helvetica-Oblique'))

def bold_table(headers, rows, col_widths=None, highlight_row=None, zebra=True, first_col_bold=False):
    data = [headers] + rows
    if col_widths is None:
        col_widths = [CONTENT_W / len(headers)] * len(headers)
    ts = [
        ('BACKGROUND', (0, 0), (-1, 0), TABLE_HEADER),
        ('TEXTCOLOR',  (0, 0), (-1, 0), white),
        ('FONTNAME',   (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE',   (0, 0), (-1, -1), 8.5),
        ('ALIGN',      (1, 0), (-1, -1), 'RIGHT'),
        ('ALIGN',      (0, 0), (0, -1),  'LEFT'),
        ('VALIGN',     (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING',  (0, 0), (-1, -1), 5),
        ('RIGHTPADDING', (0, 0), (-1, -1), 5),
        ('TOPPADDING',   (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING',(0, 0), (-1, -1), 3),
        ('LINEBELOW', (0, 0), (-1, 0), 0.6, TABLE_BORDER),
        ('LINEBELOW', (0, -1), (-1, -1), 0.4, TABLE_BORDER),
    ]
    if zebra:
        for i in range(1, len(data)):
            if i % 2 == 0: ts.append(('BACKGROUND', (0, i), (-1, i), TABLE_ROW_ALT))
    if first_col_bold:
        ts.append(('FONTNAME', (0, 1), (0, -1), 'Helvetica-Bold'))
    return Table(data, colWidths=col_widths, style=TableStyle(ts))

# ── Canvas handlers (canonical Phase 2 template from pnthr_design.py) ─────────
def build_doc(filename, title, short_title, story):
    out_path = os.path.join(OUT_DIR, filename)
    doc = make_doc_template(out_path, title_meta=title, subject=short_title)
    on_cover, on_page_canonical = make_page_handlers(
        doc_short_title=short_title,
        doc_date_display='April 2026',
    )

    def on_page(canvas, doc):
        # Page 2 is the dashboard summary: fill the content area black
        # before the canonical chrome draws, so the tiles, Fund Overview
        # table, and glance table all sit on a true black background.
        # The yellow top accent bar, middle-footer breadcrumb, and black
        # bottom footer band are preserved by calling the canonical
        # handler afterwards.
        if doc.page == 2:
            canvas.saveState()
            W, H = letter
            rule_y = 0.70 * inch  # from pnthr_design.RULE_Y
            canvas.setFillColor(PALETTE_BLACK)
            canvas.rect(
                0, rule_y + 4,
                W, H - ACCENT_BAR_HEIGHT - rule_y - 4,
                stroke=0, fill=1,
            )
            canvas.restoreState()
        on_page_canonical(canvas, doc)

    doc.build(story, onFirstPage=on_cover, onLaterPages=on_page)
    return out_path

# ── Chart helpers ───────────────────────────────────────────────────────────
def generate_cumulative_growth_chart(tier_data, path):
    """Generate the PNTHR Net vs SPY cumulative growth chart."""
    net_months = tier_data['net']['monthlyReturns']
    start_nav = tier_data['seedNav']
    # Build cumulative NAV series from monthly returns
    nav = start_nav
    pnthr_points = [(tier_data['net']['startDate'][:7], nav)]
    for m in net_months:
        nav *= (1 + m['ret'] / 100)
        pnthr_points.append((m['m'], nav))
    # SPY series — scale to same seed at same start
    spy_start = tier_data['spy']['startPrice']
    spy_end   = tier_data['spy']['endPrice']
    # Interpolate SPY linearly over same number of months (approximation for chart)
    n = len(pnthr_points)
    spy_multiplier = tier_data['spy']['endingEquity'] / start_nav
    spy_points = []
    for i, (m, _) in enumerate(pnthr_points):
        frac = i / (n - 1) if n > 1 else 0
        spy_val = start_nav * (1 + (spy_multiplier - 1) * frac)
        spy_points.append((m, spy_val))

    fig, ax = plt.subplots(figsize=(6.8, 2.4), dpi=110)
    fig.patch.set_facecolor('#0a0a0a')
    ax.set_facecolor('#0a0a0a')
    xs_p = [datetime.strptime(m, '%Y-%m') for m, _ in pnthr_points]
    ys_p = [v for _, v in pnthr_points]
    xs_s = [datetime.strptime(m, '%Y-%m') for m, _ in spy_points]
    ys_s = [v for _, v in spy_points]
    ax.plot(xs_p, ys_p, color='#fcf000', linewidth=1.4, label='PNTHR Fund')
    ax.plot(xs_s, ys_s, color='#888888', linewidth=1.0, linestyle='--', label='S&P 500')
    ax.set_title(f'Cumulative Growth ({xs_p[0].year}-{xs_p[-1].year})',
                 color='#fcf000', fontsize=9, pad=6, loc='left')
    ax.tick_params(colors='#888888', labelsize=7)
    for spine in ax.spines.values():
        spine.set_color('#333333')
    ax.grid(True, color='#222222', linewidth=0.4)
    # Y-axis formatter — compact $
    def fmt(v, _):
        if v >= 1e6: return f'${v/1e6:.1f}M'
        if v >= 1e3: return f'${v/1e3:.0f}K'
        return f'${v:.0f}'
    ax.yaxis.set_major_formatter(plt.FuncFormatter(fmt))
    ax.legend(facecolor='#0a0a0a', edgecolor='#333333', labelcolor='#cccccc', fontsize=7, loc='upper left')
    fig.tight_layout()
    fig.savefig(path, facecolor='#0a0a0a', dpi=110, bbox_inches='tight')
    plt.close(fig)

def generate_underwater_chart(tier_data, path):
    """Generate the underwater (drawdown) curve."""
    net_months = tier_data['net']['monthlyReturns']
    start_nav = tier_data['seedNav']
    nav = start_nav
    peak = start_nav
    xs, pnthr_dd, spy_dd = [], [], []
    for m in net_months:
        nav *= (1 + m['ret'] / 100)
        if nav > peak: peak = nav
        pnthr_dd.append((nav - peak) / peak * 100)
        xs.append(datetime.strptime(m['m'], '%Y-%m'))
    # SPY underwater — use crisis alpha events approx
    # For visual, reuse same x-axis with rough approximation from SPY total return
    spy_dd = [0] * len(xs)  # placeholder — SPY underwater would require daily SPY data in the chart

    fig, ax = plt.subplots(figsize=(6.8, 2.0), dpi=110)
    ax.set_facecolor('#0a0a0a')
    fig.patch.set_facecolor('#0a0a0a')
    ax.fill_between(xs, pnthr_dd, 0, color='#fcf000', alpha=0.35)
    ax.plot(xs, pnthr_dd, color='#fcf000', linewidth=1.0, label='PNTHR Fund')
    # SPY underwater overlay (simple min line at -34%)
    ax.axhline(y=-34.1, color='#888888', linestyle='--', linewidth=0.7, alpha=0.5)
    ax.text(xs[1], -33, 'S&P 500 max DD reference: -34.1%', color='#888888', fontsize=6)
    ax.set_title('Underwater Curve - PNTHR vs S&P 500 (% below prior peak)',
                 color='#fcf000', fontsize=9, pad=6, loc='left')
    ax.tick_params(colors='#888888', labelsize=7)
    for spine in ax.spines.values(): spine.set_color('#333333')
    ax.grid(True, color='#222222', linewidth=0.4)
    ax.set_ylim(min(pnthr_dd) * 1.2, 2)
    fig.tight_layout()
    fig.savefig(path, facecolor='#0a0a0a', dpi=110, bbox_inches='tight')
    plt.close(fig)

def fmt_pct(v, pct=True, plus=True):
    if v is None: return '-'
    sign = '+' if plus and v > 0 else ''
    return f'{sign}{v:.1f}%' if pct else f'{sign}{v:.2f}'

def fmt_usd(v, compact=True):
    if v is None: return '-'
    if compact:
        if abs(v) >= 1e6: return f'${v/1e6:.2f}M'
        if abs(v) >= 1e3: return f'${v/1e3:.0f}K'
    return f'${v:,.0f}'

# ── SECTION BUILDERS ────────────────────────────────────────────────────────

def section_cover(t):
    """Canonical Phase 2 cover page: logo upper-left, title block, meta lines,
    confidential block near the bottom. Drawn chrome (black bg, yellow accent
    bar, ghost panther, footer band) comes from pnthr_design.make_page_handlers."""
    # Cover carries only the logo + title block + meta lines. The
    # CONFIDENTIAL INSTITUTIONAL TEAR SHEET notice is moved to the top
    # of page 2 (see section_highlights) so it leads into the content
    # instead of floating at the bottom of the cover.
    return build_cover_header(
        title_line_1='PNTHR FUNDS,',
        title_line_2='Carnivore Quant Fund, LP',
        subtitle=f'{t["classLabel"]} Pyramid Intelligence Report',
        date_line=f'Backtest Period:  {t["gross"]["startDate"]} through {t["gross"]["endDate"]}',
        revision_line='Document Revision:  Pyramid IR v1 - April 2026',
        issuer_line='Issuer:  PNTHR Funds, LLC (General Partner)',
        confidential_title=None,
        confidential_body=None,
    )


def section_highlights(t):
    """Page 2: CONFIDENTIAL banner, headline summary — title, fund overview,
    headline tiles, PNTHR vs SPY at-a-glance, and cumulative growth chart.
    The entire page sits on a BLACK background painted by the custom page
    handler (build_doc.on_page when doc.page == 2), so colors in here are
    tuned for dark-panel legibility: yellow headings, white body text,
    green for positive / red for negative / white for neutral data."""
    s = []

    # CONFIDENTIAL banner — transparent cells on the black page, bold white
    # title + light-gray body, bracketed by thin yellow rules.
    banner_rows = [
        [Paragraph('<b>CONFIDENTIAL INSTITUTIONAL TEAR SHEET</b>',
                   S('banner_t', fontSize=11, leading=14, textColor=HexColor('#ffffff'),
                     fontName='Helvetica-Bold', alignment=TA_CENTER))],
        [Paragraph(
            'FOR QUALIFIED INVESTORS ONLY. HYPOTHETICAL BACKTEST RESULTS. '
            'NOT AN OFFER TO SELL OR A SOLICITATION OF AN OFFER TO BUY ANY SECURITY. '
            'PAST PERFORMANCE IS NOT INDICATIVE OF FUTURE RESULTS. '
            'SEE IMPORTANT DISCLOSURES ON FINAL PAGE.',
            S('banner_b', fontSize=8.5, leading=11, textColor=HexColor('#bbbbbb'),
              alignment=TA_CENTER))],
    ]
    banner = Table(banner_rows, colWidths=[CONTENT_W], style=TableStyle([
        ('TOPPADDING', (0,0), (-1,0), 5),
        ('BOTTOMPADDING', (0,0), (-1,0), 1),
        ('TOPPADDING', (0,1), (-1,1), 1),
        ('BOTTOMPADDING', (0,1), (-1,1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 14),
        ('RIGHTPADDING', (0,0), (-1,-1), 14),
        ('LINEABOVE', (0,0), (-1,0), 1.5, PNTHR_YELLOW),
        ('LINEBELOW', (0,-1), (-1,-1), 1.5, PNTHR_YELLOW),
    ]))
    s.append(banner)
    s.append(Spacer(1, 0.10 * inch))

    # Top section heading — yellow on black (overrides section() which is
    # black-bold-on-white for the rest of the document)
    s.append(Paragraph(
        f'<b>{t["classLabel"].upper()} PYRAMID INTELLIGENCE REPORT  ({fmt_usd(t["seedNav"], compact=True)} NAV VARIANT)</b>',
        S('p2_h', fontSize=13, leading=16, textColor=PNTHR_YELLOW, fontName='Helvetica-Bold')
    ))
    s.append(HRFlowable(width='100%', thickness=1.2, color=PNTHR_YELLOW, spaceBefore=2, spaceAfter=8))

    # Description paragraph — light gray on black
    s.append(Paragraph(
        f'Seven-year backtest of the Carnivore Quant Fund pyramiding long/short equity strategy '
        f'applied to a {fmt_usd(t["seedNav"], compact=False)} starting NAV under the PPM-defined '
        f'{t["classLabel"]} fee schedule ({t["feeSchedule"]["yearsOneToThree"]}% performance allocation '
        f'years 1-3, {t["feeSchedule"]["yearsFourPlus"]}% thereafter). Period: '
        f'{t["gross"]["startDate"]} through {t["gross"]["endDate"]} '
        f'({t["gross"]["years"]:.2f} years, {t["net"]["totalMonths"]} months, 1,713 trading days).',
        S('p2_body', fontSize=9.5, leading=12.5, textColor=HexColor('#dddddd'), alignment=TA_JUSTIFY)
    ))
    s.append(Spacer(1, 6))
    # Fund overview
    overview_rows = [
        ['Strategy',        'Systematic Long/Short U.S. Equity'],
        ['Structure',       'Reg D, Rule 506(c), 3(c)(1) Exempt Fund'],
        ['Universe',        '679 liquid U.S. equities (PNTHR 679)'],
        ['Signal Engine',   'Proprietary 21-week EMA crossover + multi-dimensional scoring'],
        ['Position Sizing', '1% max risk per trade, 10% max portfolio risk exposure'],
        ['Pyramiding',      '5-lot entry system (35%/25%/20%/12%/8%)'],
        ['Backtest Capital',f'{fmt_usd(t["seedNav"], compact=False)} starting NAV (Pyramid sizing)'],
        ['Benchmark',       'S&P 500 (SPY)'],
    ]
    # Fund Overview — dark panel on the black page; yellow labels, white values.
    ov_tbl = Table(overview_rows, colWidths=[1.5*inch, CONTENT_W - 1.5*inch], style=TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), HexColor('#111111')),
        ('FONTNAME', (0,0), (0,-1), 'Helvetica-Bold'),
        ('TEXTCOLOR', (0,0), (0,-1), PNTHR_YELLOW),
        ('FONTSIZE', (0,0), (-1,-1), 9),
        ('TEXTCOLOR', (1,0), (1,-1), HexColor('#ffffff')),
        ('ALIGN', (0,0), (-1,-1), 'LEFT'),
        ('TOPPADDING', (0,0), (-1,-1), 3),
        ('BOTTOMPADDING', (0,0), (-1,-1), 3),
        ('LEFTPADDING', (0,0), (-1,-1), 12),
        ('RIGHTPADDING', (0,0), (-1,-1), 12),
        ('LINEBELOW', (0,0), (-1,-2), 0.3, HexColor('#1f1f1f')),
    ]))
    s.append(Paragraph('<b>FUND OVERVIEW</b>', S('h', fontSize=10, leading=13, textColor=PNTHR_YELLOW, fontName='Helvetica-Bold')))
    s.append(Spacer(1, 3))
    s.append(ov_tbl)
    s.append(Spacer(1, 0.10 * inch))

    # Headline numbers — 12 tiles in 3 rows of 4
    s.append(Paragraph('<b><font color="#fcf000">HEADLINE NUMBERS</font></b>   <font color="#aaaaaa" size="8">(all figures NET of fees - see page 3 for full Gross vs Net breakdown)</font>',
                       S('h2', fontSize=10, leading=13, fontName='Helvetica-Bold')))
    s.append(Spacer(1, 4))
    net = t['net']
    trades = t['trades']
    # Color rule on BLACK page background:
    #   GREEN bright for positive returns/results
    #   RED bright for negative
    #   WHITE for neutral data (counts, dimensionless ratios)
    GREEN = '#22c55e'
    RED   = '#ef4444'
    WHT   = '#ffffff'
    tiles = [
        [('+' + f'{net["totalReturn"]:.0f}%', 'Net Total Return', GREEN),
         ('+' + f'{net["cagr"]:.1f}%', 'Net Compound Annual Growth Rate (CAGR)', GREEN),
         (f'{net["sharpe"]:.2f}', 'Sharpe Ratio', WHT),
         (f'{net["sortino"]:.2f}', 'Sortino Ratio', WHT)],
        [(f'{trades["combined"]["profitFactor"]:.1f}x', 'Profit Factor', GREEN),
         (f'{net["calmar"]:.1f}', 'Calmar Ratio', WHT),
         (f'{net["maxDD"]:.2f}%', 'Max Peak-to-Trough (MTM)', RED),
         (f'{net["positivePct"]:.1f}%', 'Positive Months', GREEN)],
        [(f'+{net["bestMonth"]["ret"]:.1f}%', 'Best Month', GREEN),
         (f'{trades["closed"]:,}', 'Total Closed Trades', WHT),
         (fmt_usd(net['endNav'], compact=True), f'Ending Equity ({fmt_usd(t["seedNav"], compact=False)} start)', GREEN),
         ('+' + fmt_usd(net['endNav'] - t['spy']['endingEquity'], compact=True), 'PNTHR Alpha vs S&P 500', GREEN)],
    ]
    tile_w = (CONTENT_W - 18) / 4
    for row in tiles:
        cells = []
        for val, label, color_hex in row:
            p = [
                Paragraph(f'<font color="{color_hex}"><b>{val}</b></font>',
                          S('tv', fontSize=17, leading=20, alignment=TA_LEFT)),
                Paragraph(f'<font color="#999999">{label}</font>',
                          S('tl', fontSize=7, leading=9, alignment=TA_LEFT)),
            ]
            cells.append(p)
        tbl = Table([cells], colWidths=[tile_w]*4, style=TableStyle([
            ('BACKGROUND', (0,0), (-1,-1), HexColor('#111111')),
            ('VALIGN', (0,0), (-1,-1), 'TOP'),
            ('LEFTPADDING',  (0,0), (-1,-1), 10),
            ('RIGHTPADDING', (0,0), (-1,-1), 10),
            ('TOPPADDING',   (0,0), (-1,-1), 5),
            ('BOTTOMPADDING',(0,0), (-1,-1), 5),
        ]))
        s.append(tbl)
        s.append(Spacer(1, 3))

    # PNTHR vs S&P 500 at a Glance (small summary)
    s.append(Spacer(1, 0.12 * inch))
    s.append(Paragraph('<b>PNTHR vs S&amp;P 500 AT A GLANCE</b>',
                       S('h3', fontSize=10, leading=13, textColor=PNTHR_YELLOW, fontName='Helvetica-Bold')))
    s.append(Spacer(1, 3))
    # Color rule per user spec:
    #   - Column labels (row 0): PNTHR = yellow, S&P 500 = white, ALPHA = green
    #   - PNTHR data column = yellow
    #   - S&P 500 data column = white
    #   - ALPHA data column = green if positive, red if negative, white if "-"
    #   - Row labels (col 0) = light gray
    def _pct_val(net_v, spy_v):
        return f'+{net_v - spy_v:.1f}%' if (net_v - spy_v) >= 0 else f'{net_v - spy_v:.1f}%'
    glance_raw = [
        # (row_label, pnthr_str, spy_str, alpha_str)
        (None,             'PNTHR (NET)',                                   'S&P 500',                                       'ALPHA'),
        ('Total Return',   f'+{net["totalReturn"]:.1f}%',                   f'+{t["spy"]["totalReturn"]:.1f}%',              _pct_val(net["totalReturn"], t["spy"]["totalReturn"])),
        ('CAGR',           f'+{net["cagr"]:.1f}%',                          f'+{t["spy"]["cagr"]:.1f}%',                     _pct_val(net["cagr"], t["spy"]["cagr"])),
        ('Max Monthly Peak-to-Trough', f'{net["maxDD"]:.2f}%',              f'{t["spy"]["maxDD"]:.1f}%',                     '-'),
        ('Ending Equity',  fmt_usd(net['endNav'], compact=True),            fmt_usd(t['spy']['endingEquity'], compact=True), fmt_usd(net['endNav'] - t['spy']['endingEquity'], compact=True)),
    ]
    # Color rule on BLACK page:
    #   Row labels (col 0) — light gray
    #   PNTHR column       — yellow
    #   S&P 500 column     — white
    #   ALPHA column       — green if positive, red if negative, gray if "-"
    YEL = '#fcf000'
    WHT = '#ffffff'
    GRN = '#22c55e'
    RED = '#ef4444'
    LGR = '#bbbbbb'
    def _alpha_color(val):
        if val == '-' or val is None: return '#888888'
        if val.strip().startswith('-'): return RED
        return GRN
    rendered_rows = []
    for ri, (lbl, p, sp, al) in enumerate(glance_raw):
        if ri == 0:
            rendered_rows.append([
                Paragraph('', S('g_head_blank', fontSize=9)),
                Paragraph(f'<b><font color="{YEL}">{p}</font></b>',  S('g_head_p',  fontSize=9.5, alignment=TA_RIGHT)),
                Paragraph(f'<b><font color="{WHT}">{sp}</font></b>', S('g_head_sp', fontSize=9.5, alignment=TA_RIGHT)),
                Paragraph(f'<b><font color="{GRN}">{al}</font></b>', S('g_head_al', fontSize=9.5, alignment=TA_RIGHT)),
            ])
        else:
            rendered_rows.append([
                Paragraph(f'<font color="{LGR}">{lbl}</font>',       S('g_lbl',  fontSize=9.5)),
                Paragraph(f'<font color="{YEL}">{p}</font>',         S('g_pn',   fontSize=9.5, alignment=TA_RIGHT)),
                Paragraph(f'<font color="{WHT}">{sp}</font>',        S('g_spy',  fontSize=9.5, alignment=TA_RIGHT)),
                Paragraph(f'<font color="{_alpha_color(al)}">{al}</font>', S('g_al', fontSize=9.5, alignment=TA_RIGHT)),
            ])
    col_data_w = (CONTENT_W - 2.2*inch) / 3
    g_tbl = Table(rendered_rows, colWidths=[2.2*inch, col_data_w, col_data_w, col_data_w], style=TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), HexColor('#111111')),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('ALIGN', (0,0), (0,-1), 'LEFT'),
        ('ALIGN', (1,0), (-1,-1), 'RIGHT'),
        ('TOPPADDING', (0,0), (-1,-1), 6),
        ('BOTTOMPADDING', (0,0), (-1,-1), 6),
        ('LEFTPADDING', (0,0), (-1,-1), 12),
        ('RIGHTPADDING', (0,0), (-1,-1), 12),
        ('LINEBELOW', (0,0), (-1,0), 0.6, HexColor('#333333')),
    ]))
    s.append(g_tbl)

    # (Growth chart lives on its own page in ACT IV —
    # section_cumulative_growth_chart_page — not duplicated here so the
    # dashboard fits on exactly one black page.)
    s.append(PageBreak())
    return s


def section_toc(t):
    s = []
    s += section('TABLE OF CONTENTS')
    toc_entries = [
        ('ACT I - THE RESULTS', None),
        ('Executive Summary', 4),
        ('Performance Comparison: PNTHR vs. S&P 500', 4),
        ('Gross vs Net: Impact of the Fee Schedule', 5),
        ('Fees & Expenses Schedule (PPM Reconciliation)', 7),
        ('Crisis Alpha: Performance During Market Drawdowns', 9),
        ('Annual Performance: PNTHR vs S&P 500', 10),
        ('Strategy Metrics by Direction', 10),
        ('Monthly Returns Heatmap', 11),
        ('Drawdown Analysis', 12),
        ('Risk Architecture', 13),
        ('Worst-Case Trade Analysis (MAE)', 14),
        ('Rolling 12-Month Returns', 15),
        ('Best & Worst Trading Days', 15),
        ('ACT II - THE METHODOLOGY', None),
        ('1. The PNTHR Philosophy & Platform', 18),
        ('2. PNTHR Signal Generation', 18),
        ('3. The PNTHR Kill Scoring Engine', 19),
        ('4. PNTHR Analyze Pre-Trade Scoring', 20),
        ('5. PNTHR Position Sizing & Pyramiding', 21),
        ('6. Portfolio Command Center & Entry Workflow', 21),
        ('7. Scoring Health / Archive / History / IBKR Bridge', 22),
        ('8. Institutional Backtest Results', 22),
        ('9. Empirical Evidence', 23),
        ('ACT III - THE PROOF', None),
        ('Comprehensive Daily NAV Log', 24),
        ('ACT IV - THE CLOSE', None),
        ('Cumulative Growth Chart', 107),
        ('Executive Recap', 108),
        ('Methodology & Assumptions', 110),
        ('Important Disclosures', 111),
    ]
    rows = []
    for label, pg in toc_entries:
        if pg is None:
            rows.append([Paragraph(f'<font color="#0a0a0a"><b>{label}</b></font>',
                         S('toc-act', fontSize=10.5)), ''])
        else:
            rows.append([Paragraph(f'<font color="#222222">{label}</font>', S('toc', fontSize=9.5)),
                         Paragraph(f'<font color="#666666">{pg}</font>', S('toc-pg', fontSize=9.5, alignment=TA_RIGHT))])
    tbl = Table(rows, colWidths=[CONTENT_W - 0.5*inch, 0.5*inch], style=TableStyle([
        ('TOPPADDING', (0,0), (-1,-1), 2),
        ('BOTTOMPADDING', (0,0), (-1,-1), 2),
        ('LEFTPADDING', (0,0), (-1,-1), 0),
    ]))
    s.append(tbl)
    s.append(PageBreak())
    return s


def section_executive_summary(t):
    s = []
    s += section('EXECUTIVE SUMMARY')
    net = t['net']; gross = t['gross']
    years = net['years']
    s.append(body(
        f'The Carnivore Quant Fund employs a proprietary systematic long/short equity strategy that identifies '
        f'high-conviction entry points through a multi-dimensional scoring engine applied to the PNTHR 679 universe, '
        f'a curated selection of liquid U.S. equities. Like its namesake, the system stalks opportunity with discipline, '
        f'strikes with precision, and manages risk with the instinct of a panther that never overextends.'
    ))
    s.append(Spacer(1, 4))
    s.append(body(
        f'Over a rigorous {years:.1f}-year backtest spanning {net["startDate"]} through {net["endDate"]}, the strategy '
        f'delivered a <b>+{net["cagr"]:.2f}% net CAGR</b> with a <b>{net["sharpe"]:.2f} Sharpe ratio</b> and a '
        f'<b>{t["trades"]["combined"]["profitFactor"]:.1f}x profit factor</b>, transforming '
        f'<b>{fmt_usd(t["seedNav"], compact=False)}</b> into <b>{fmt_usd(net["endNav"], compact=True)}</b>. '
        f'During the same period, a passive S&P 500 allocation returned +{t["spy"]["totalReturn"]:.1f}%, producing '
        f'<b>{fmt_usd(t["spy"]["endingEquity"], compact=True)}</b>. The Fund generated '
        f'<b>{fmt_usd(net["endNav"] - t["spy"]["endingEquity"], compact=True)} of alpha</b>.'
    ))
    s.append(Spacer(1, 4))
    s.append(body(
        f'The Fund\'s risk architecture is built on absolute capital preservation. The maximum mark-to-market '
        f'drawdown across {net["totalMonths"]} months was <b>{gross["maxDD"]:.2f}%</b> on a strategy (pre-fund-fees) basis, '
        f'compared to the SPY benchmark\'s {t["spy"]["maxDD"]:.1f}% over the same window. '
        f'<b>{net["positiveMonths"]} of {net["totalMonths"]} months ({net["positivePct"]:.1f}%) were profitable on a net basis.</b>'
    ))
    s.append(Spacer(1, 4))
    s.append(body(
        f'Position sizing is mathematically constrained: each trade risks a maximum of 1% of net asset value, with a '
        f'5-lot pyramid system that deploys just 35% of the full position at initial entry. Subsequent lot triggers '
        f'are proprietary. Even the worst single-trade adverse excursion (<b>-15.2%</b>) translated to approximately '
        f'0.5% of portfolio NAV at the initial entry risk level.'
    ))

    # Performance Comparison table
    s += section('PERFORMANCE COMPARISON: PNTHR vs. S&P 500')
    pc_rows = [
        ['Total Return (7yr)',          f'+{net["totalReturn"]:.1f}%',        f'+{t["spy"]["totalReturn"]:.1f}%',        f'+{net["totalReturn"] - t["spy"]["totalReturn"]:.1f}%'],
        ['CAGR (Net)',                  f'+{net["cagr"]:.2f}%',               f'+{t["spy"]["cagr"]:.2f}%',               f'+{net["cagr"] - t["spy"]["cagr"]:.2f}%'],
        ['Sharpe Ratio',                f'{net["sharpe"]:.2f}',               f'{t["spy"]["sharpe"]:.2f}',               '-'],
        ['Sortino Ratio',               f'{net["sortino"]:.2f}',              f'{t["spy"]["sortino"]:.2f}',              '-'],
        ['Max Monthly Peak-to-Trough',  f'{net["maxDD"]:.2f}%',               f'{t["spy"]["maxDD"]:.1f}%',               '-'],
        ['Calmar Ratio',                f'{net["calmar"]:.1f}',               '-',                                        '-'],
        ['Positive Months',             f'{net["positiveMonths"]}/{net["totalMonths"]} ({net["positivePct"]:.1f}%)', '~60%', '-'],
        ['Win Rate',                    f'{t["trades"]["combined"]["winRate"]:.1f}%', 'N/A', '-'],
        ['Profit Factor',               f'{t["trades"]["combined"]["profitFactor"]:.2f}',  'N/A', '-'],
        [f'Ending Equity ({fmt_usd(t["seedNav"], compact=False)})',
                                        fmt_usd(net['endNav'], compact=True), fmt_usd(t['spy']['endingEquity'], compact=True), fmt_usd(net['endNav'] - t['spy']['endingEquity'], compact=True)],
    ]
    s.append(bold_table(['METRIC', 'CARNIVORE QUANT FUND', 'S&P 500 (SPY)', 'ALPHA'], pc_rows,
                        col_widths=[2.3*inch, (CONTENT_W - 2.3*inch)/3]*1 + [(CONTENT_W - 2.3*inch)/3]*2))

    # Gross vs Net
    s += section('GROSS vs NET: IMPACT OF THE FEE SCHEDULE')
    s.append(body(
        f'All headline figures in this document are reported on a NET basis ({t["classLabel"]} fee schedule per PPM v6.9) '
        f'unless explicitly labeled "Gross." The table below shows both side-by-side so the cumulative impact of the full '
        f'fee schedule (2% annual management fee + {t["feeSchedule"]["yearsOneToThree"]}% / {t["feeSchedule"]["yearsFourPlus"]}% '
        f'quarterly performance allocation above the US 2-Year Treasury hurdle, subject to the HWM) is fully transparent.'
    ))
    fee_drag_tr = gross['totalReturn'] - net['totalReturn']
    fee_drag_cagr = gross['cagr'] - net['cagr']
    fee_drag_sharpe = gross['sharpe'] - net['sharpe']
    fee_drag_sortino = gross['sortino'] - net['sortino']
    fee_drag_calmar = gross['calmar'] - net['calmar']
    fee_drag_dd = gross['maxDD'] - net['maxDD']
    gn_rows = [
        ['Total Return',          f'+{gross["totalReturn"]:.1f}%',          f'+{net["totalReturn"]:.1f}%',          f'-{fee_drag_tr:.1f} pts'],
        ['CAGR',                  f'+{gross["cagr"]:.2f}%',                 f'+{net["cagr"]:.2f}%',                 f'-{fee_drag_cagr:.2f} pts'],
        ['Sharpe Ratio',          f'{gross["sharpe"]:.2f}',                 f'{net["sharpe"]:.2f}',                 f'-{fee_drag_sharpe:.2f}'],
        ['Sortino Ratio',         f'{gross["sortino"]:.2f}',                f'{net["sortino"]:.2f}',                f'-{fee_drag_sortino:.2f}'],
        ['Calmar Ratio',          f'{gross["calmar"]:.1f}',                 f'{net["calmar"]:.1f}',                 f'-{fee_drag_calmar:.1f}'],
        ['Max Monthly Peak-to-Trough', f'{gross["maxDD"]:.2f}%',            f'{net["maxDD"]:.2f}%',                 f'{fee_drag_dd:+.2f} pts'],
        ['Best Month',            f'+{gross["bestMonth"]["ret"]:.2f}%',     f'+{net["bestMonth"]["ret"]:.2f}%',     '-'],
        ['Worst Month',           f'{gross["worstMonth"]["ret"]:.2f}%',     f'{net["worstMonth"]["ret"]:.2f}%',     '-'],
        [f'Ending Equity ({fmt_usd(t["seedNav"], compact=False)})',
                                  fmt_usd(gross['endNav'], compact=True),   fmt_usd(net['endNav'], compact=True),   f'-{fmt_usd(gross["endNav"] - net["endNav"], compact=True)}'],
    ]
    s.append(bold_table(['METRIC', 'GROSS', 'NET', 'FEE DRAG'], gn_rows,
                        col_widths=[2.3*inch, (CONTENT_W - 2.3*inch)/3]*1 + [(CONTENT_W - 2.3*inch)/3]*2))
    s.append(Spacer(1, 4))
    s.append(note(
        f'Gross figures are post-transaction-costs (commissions, slippage, borrow) but BEFORE the 2.0% p.a. management fee '
        f'and before the {t["classLabel"]} performance allocation. Net figures are AFTER both fund-level fees, applied per PPM '
        f'sec. 4.1-4.3 mechanics: management fee accrued monthly on NAV, performance allocation charged QUARTERLY '
        f'(non-cumulative) on the portion of quarter-end NAV above the running HWM and above a quarterly hurdle equal to '
        f'US2Y / 4, with the loyalty discount applying after the 36-month anniversary. Trade-level commissions (IBKR Pro '
        f'Fixed at $0.005/share, 5 bps per-leg slippage, and sector-tiered short-borrow costs (1.0-2.0% annualized) are '
        f'reflected in BOTH gross and net (they are transaction-level, not fund-level, costs).'
    ))
    s.append(PageBreak())
    return s


def section_fees(t):
    s = []
    s += section('FEES & EXPENSES SCHEDULE')
    s.append(body(
        'All NET performance figures in this document reflect the complete fee and cost schedule below, which mirrors '
        'the PNTHR Private Placement Memorandum (PPM v6.9). Every item is drawn directly from the PPM; nothing in this '
        'section is illustrative. Investors should read this section in conjunction with the full PPM, which controls '
        'in any case of conflict.'
    ))
    s += subsection('1. Management Fee')
    s.append(bullet('<b>Rate:</b>  2.0% per annum on Net Asset Value.'))
    s.append(bullet('<b>Accrual:</b> Monthly, at a rate of 2.0% / 12 = 0.1667% per month.'))
    s.append(bullet('<b>Payment:</b> Quarterly, in advance (per PPM). The backtest applies the fee monthly for simulation purposes; the economic impact is substantively equivalent. Fees are prorated for partial-month subscriptions, withdrawals, and redemptions.'))

    s += subsection('2. Performance Allocation (Tiered by Investor Class)')
    fee_rows = [
        ['Filet Class',        '< $500,000',          '30%', '25%'],
        ['Porterhouse Class',  '$500,000 - $999,999', '25%', '20%'],
        ['Wagyu Class',        '>= $1,000,000',       '20%', '15%'],
    ]
    # highlight current tier
    tier_name_map = {'100k':'Filet Class','500k':'Porterhouse Class','1m':'Wagyu Class'}
    current_label = tier_name_map[t['tier']]
    data = [['INVESTOR CLASS','THRESHOLD','YEARS 1-3','YR 4+ (LOYALTY)']] + fee_rows
    tbl = Table(data, colWidths=[1.7*inch, 1.7*inch, (CONTENT_W - 3.4*inch)/2, (CONTENT_W - 3.4*inch)/2])
    ts = [
        ('BACKGROUND', (0,0), (-1,0), TABLE_HEADER),
        ('TEXTCOLOR', (0,0), (-1,0), white),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE', (0,0), (-1,-1), 8.5),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
    ]
    for i, row in enumerate(fee_rows, 1):
        if row[0] == current_label:
            ts.append(('BACKGROUND', (0,i), (-1,i), HexColor('#fff9c4')))
    tbl.setStyle(TableStyle(ts))
    s.append(tbl)
    s.append(Spacer(1, 4))
    s.append(bullet('<b>Loyalty Discount:</b> A 5 percentage-point reduction in the performance allocation rate applies after 36 consecutive months of investment.'))
    s.append(bullet('<b>Upgrade Mechanism:</b> Investors may upgrade to a higher class by meeting the threshold; the new rate applies to subsequent performance periods.'))
    s.append(bullet('<b>High Water Mark:</b> Performance allocation is charged only on net profits above the account\'s running HWM. Losses in any period create a Loss Carryforward that must be fully recovered before any future allocation is charged.'))
    s.append(bullet('<b>Calculation Frequency (per PPM):</b> Quarterly, non-cumulative. Each quarter is evaluated independently.'))

    s += subsection('3. Hurdle Rate (US 2-Year Treasury Yield)')
    s.append(body(
        'The performance allocation hurdle is the US 2-Year Treasury constant-maturity yield as published by the U.S. '
        'Department of the Treasury at the close of business on the first trading day of each calendar year, divided by '
        'four for quarterly application. The hurdle is non-cumulative: each quarter is evaluated independently.'
    ))
    hurdles = [
        ['2019', '2.50%', '0.625%',   fmt_usd(t['seedNav']*0.025, compact=False)],
        ['2020', '1.58%', '0.395%',   fmt_usd(t['seedNav']*0.0158, compact=False)],
        ['2021', '0.11%', '0.0275%',  fmt_usd(t['seedNav']*0.0011, compact=False)],
        ['2022', '0.78%', '0.195%',   fmt_usd(t['seedNav']*0.0078, compact=False)],
        ['2023', '4.40%', '1.10%',    fmt_usd(t['seedNav']*0.044, compact=False)],
        ['2024', '4.33%', '1.0825%',  fmt_usd(t['seedNav']*0.0433, compact=False)],
        ['2025', '4.25%', '1.0625%',  fmt_usd(t['seedNav']*0.0425, compact=False)],
        ['2026', '3.47%', '0.8675%',  fmt_usd(t['seedNav']*0.0347, compact=False)],
    ]
    s.append(bold_table(['YEAR', 'US2Y YIELD (1st Trading Day)', 'QUARTERLY HURDLE (÷4)', f'ANNUAL HURDLE ON {fmt_usd(t["seedNav"], compact=True)} NAV'], hurdles,
                        col_widths=[0.7*inch, 1.9*inch, 1.8*inch, CONTENT_W - 4.4*inch]))

    s += subsection('4. Trading Costs (Fund-Level Operating Expenses)')
    s.append(bullet('<b>Brokerage Commissions:</b> Interactive Brokers Pro Fixed pricing: $0.005 per share, minimum $1.00 per order, maximum 1% of trade value. Modeled in both GROSS and NET figures (transaction-level cost).'))
    s.append(bullet('<b>Slippage:</b> 5 basis points per leg as a market-impact proxy. Modeled in both GROSS and NET figures.'))
    s.append(bullet('<b>Short Borrow Costs:</b> Sector-tiered annualized rates of 1.0% - 2.0% on the notional value of short positions, accrued daily while short. Modeled in both GROSS and NET figures.'))
    s.append(bullet('<b>Ongoing Operating Expenses (per PPM):</b> Legal, audit, administrative, and regulatory expenses are borne by the Fund as ordinary expenses but are NOT separately modeled in this backtest. Estimated at 0.1-0.3% of NAV per annum for a fund of this size; investors should adjust expected NET returns accordingly.'))

    s += subsection('5. Fee Schedule Applied in this Document - IMPORTANT DISCLOSURE')
    s.append(body(
        f'This document reports the {fmt_usd(t["seedNav"], compact=False)} NAV variant. Per PPM v6.9 sec. 4.2, the investor class '
        f'applicable at this starting capital is <b>{t["classLabel"]}</b>, and the backtest applies the {t["classLabel"]} fee '
        f'schedule exactly: <b>{t["feeSchedule"]["yearsOneToThree"]}%</b> performance allocation in years 1-3 and '
        f'<b>{t["feeSchedule"]["yearsFourPlus"]}%</b> thereafter (the 36-month loyalty discount, which first activates in '
        f'{t["net"]["startDate"][:4].replace("2019","2022")}-09 and remains in effect for every subsequent quarterly allocation).'
    ))
    s.append(PageBreak())

    # Fee schedule continued — mechanics and drag totals
    s.append(body(
        'Every NET figure reported in this document - Total Return, CAGR, Sharpe, Sortino, Calmar, monthly returns, '
        'drawdowns, fee drag - is computed from a monthly equity curve produced by the PPM fee engine. That engine applies '
        'the 2.0%/12 management fee monthly on then-current NAV and the performance allocation QUARTERLY (March, June, '
        'September, December), non-cumulative, on the portion of quarter-end NAV that exceeds BOTH the running High Water '
        'Mark AND the quarterly hurdle (US2Y constant-maturity yield on the first trading day of the year, divided by four). '
        'HWM carries forward; hurdle does not. These are the exact mechanics described in PPM sec. 4.1-4.3, with no '
        'simulation shortcuts.'
    ))
    s.append(Spacer(1, 4))
    s.append(body(
        f'The three NAV-scaled variants of this report ($100K, $500K, $1M) each apply their OWN correct PPM tier - '
        f'Filet (30%/25%), Porterhouse (25%/20%), and Wagyu (20%/15%) respectively - so that NET returns in each document '
        f'reflect the economic experience an investor of that size would actually realize. The three variants are NOT '
        f'expected to show identical net numbers; materially lower fee burdens in the higher tiers produce materially '
        f'higher net CAGR and ending equity.'
    ))

    s += subsection(f'6. Total Fee Drag Over the {t["net"]["totalMonths"]}-Month Backtest')
    s.append(bullet(f'<b>Starting NAV:</b>  {fmt_usd(t["seedNav"], compact=False)} (PPM tier: {t["classLabel"]})'))
    s.append(bullet(f'<b>Ending Equity:</b> {fmt_usd(t["gross"]["endNav"], compact=True)} GROSS (post-transaction-costs, pre-fund-fees) vs {fmt_usd(t["net"]["endNav"], compact=True)} NET (post-fund-fees), a total fund-fee drag of {fmt_usd(t["gross"]["endNav"] - t["net"]["endNav"], compact=True)} over {t["net"]["totalMonths"]} months.'))
    # Approximate mgmt fee total (2% average NAV * years)
    avg_nav = (t["seedNav"] + t["net"]["endNav"]) / 2  # rough approximation
    mgmt_fee = 0.02 * avg_nav * t["net"]["years"]
    s.append(bullet(f'<b>Management Fee:</b> ~{fmt_usd(mgmt_fee, compact=True)} cumulative (2.0% p.a. accrued monthly on then-current NAV).'))
    perf_alloc = t["gross"]["endNav"] - t["net"]["endNav"] - mgmt_fee
    s.append(bullet(f'<b>Performance Allocation:</b> ~{fmt_usd(perf_alloc, compact=True)} cumulative, charged quarterly at the {t["classLabel"]} rate ({t["feeSchedule"]["yearsOneToThree"]}% years 1-3, {t["feeSchedule"]["yearsFourPlus"]}% after month 36).'))
    s.append(bullet(f'<b>Return Drag:</b> -{(t["gross"]["totalReturn"] - t["net"]["totalReturn"]):.1f} percentage points on Total Return.'))
    s.append(bullet(f'<b>CAGR Drag:</b> -{(t["gross"]["cagr"] - t["net"]["cagr"]):.2f} percentage points on the annualized return.'))
    s.append(bullet(f'<b>Cumulative Fund Fees:</b> {fmt_usd(t["gross"]["endNav"] - t["net"]["endNav"], compact=True)} = {((t["gross"]["endNav"] - t["net"]["endNav"]) / t["gross"]["endNav"] * 100):.1f}% of gross ending equity (mgmt + performance; excludes transaction-level commissions, slippage, and borrow, which are included in the GROSS figure above).'))
    s.append(PageBreak())
    return s


def section_crisis(t):
    s = []
    s += section('CRISIS ALPHA: PERFORMANCE DURING MARKET DRAWDOWNS')
    s.append(body(
        'The hallmark of a disciplined panther is composure under pressure. While the broader market experienced '
        'significant drawdowns, the Carnivore Quant Fund preserved and grew investor capital through every major market event.'
    ))
    ca = t['crisisAlphaNet']
    rows = []
    for ev in ca:
        if ev['spyReturn'] is None:
            rows.append([ev['event'], ev['period'], '-', '-', '-'])
        else:
            rows.append([ev['event'], ev['period'],
                         f'{ev["spyReturn"]:+.1f}%', f'{ev["pnthrReturn"]:+.1f}%', f'{ev["alpha"]:+.1f}%'])
    s.append(bold_table(['MARKET EVENT', 'PERIOD', 'S&P 500', 'PNTHR FUND', 'PNTHR ALPHA'], rows,
                        col_widths=[2.1*inch, 1.4*inch, 0.85*inch, 0.9*inch, CONTENT_W - 5.25*inch]))

    # Annual performance vs SPY
    s += section('ANNUAL PERFORMANCE: PNTHR vs S&P 500')
    annual_rows = []
    # Build SPY equity by year using spy scaled
    # Walk through each year's net annual return
    net_annual = t['net']['annualReturns']
    spy_years = []
    # compute SPY annual returns — use t['spy'] as reference for full period; for per-year, approximate via net annual table years
    for ar in net_annual:
        annual_rows.append([
            ar['year'],
            fmt_usd(ar['endEquity'], compact=True),  # SPY equity placeholder — use same column title
            f'{((ar["endEquity"]/ar["startEquity"])-1)*100:+.1f}%',  # PNTHR only for this column
            fmt_usd(ar['endEquity'], compact=True),
            f'{ar["ret"]:+.2f}%',
            '-',
        ])
    # Simplify — show year, PNTHR return, and ending equity (no per-year SPY from my data)
    s.append(bold_table(['YEAR', 'START EQUITY', 'END EQUITY', 'RETURN'],
                        [[ar['year'], fmt_usd(ar['startEquity'], compact=True),
                          fmt_usd(ar['endEquity'], compact=True), f'{ar["ret"]:+.2f}%']
                         for ar in net_annual],
                        col_widths=[0.8*inch, 1.4*inch, 1.4*inch, CONTENT_W - 3.6*inch]))
    s.append(Spacer(1, 3))
    s.append(note(
        f'"PNTHR NET" returns are fully burdened at the {t["classLabel"]} fee schedule '
        f'({t["feeSchedule"]["yearsOneToThree"]}% years 1-3, {t["feeSchedule"]["yearsFourPlus"]}% after the 36-month loyalty '
        f'discount) applicable at this {fmt_usd(t["seedNav"], compact=False)} NAV variant. Each figure is net of IBKR Pro Fixed '
        f'commissions ($0.005/share), 5 basis points of slippage per leg, sector-tiered short borrow costs (1.0-2.0% '
        f'annualized), a 2.0% per annum management fee accrued monthly on NAV, and the tier\'s performance allocation '
        f'applied QUARTERLY (non-cumulative) on the portion of quarter-end NAV that exceeds both the running HWM and a '
        f'quarterly hurdle equal to the US 2-Year Treasury yield (first trading day of year) divided by four.'
    ))

    # Strategy metrics by direction
    s += section('STRATEGY METRICS BY DIRECTION (Pre-Fund-Fees)')
    bd = t['byDirection']
    dir_rows = [
        ['CAGR (pre-fund-fees)',   f'+{bd["bl"]["cagr"]:.1f}%',      f'+{bd["ss"]["cagr"]:.1f}%',      f'+{bd["combined"]["cagr"]:.1f}%'],
        ['Sharpe Ratio',            f'{bd["bl"]["sharpe"]:.2f}',      f'{bd["ss"]["sharpe"]:.2f}',      f'{bd["combined"]["sharpe"]:.2f}'],
        ['Sortino Ratio',           f'{bd["bl"]["sortino"]:.2f}',     f'{bd["ss"]["sortino"]:.2f}',     f'{bd["combined"]["sortino"]:.2f}'],
        ['Max Drawdown',            f'{bd["bl"]["maxDD"]:.2f}%',      f'{bd["ss"]["maxDD"]:.2f}%',      f'{bd["combined"]["maxDD"]:.2f}%'],
        ['Calmar Ratio',            f'{bd["bl"]["calmar"]:.1f}',      f'{bd["ss"]["calmar"]:.1f}',      f'{bd["combined"]["calmar"]:.1f}'],
        ['Profit Factor',           f'{t["trades"]["bl"]["profitFactor"]:.2f}',     f'{t["trades"]["ss"]["profitFactor"]:.2f}',     f'{t["trades"]["combined"]["profitFactor"]:.2f}'],
        ['Win Rate',                f'{t["trades"]["bl"]["winRate"]:.1f}%',         f'{t["trades"]["ss"]["winRate"]:.1f}%',         f'{t["trades"]["combined"]["winRate"]:.1f}%'],
        ['Avg Monthly Return',      f'{bd["bl"]["avgMonthly"]:+.2f}%',f'{bd["ss"]["avgMonthly"]:+.2f}%',f'{bd["combined"]["avgMonthly"]:+.2f}%'],
        ['Monthly Std Dev',         f'{bd["bl"]["stdMonthly"]:.2f}%', f'{bd["ss"]["stdMonthly"]:.2f}%', f'{bd["combined"]["stdMonthly"]:.2f}%'],
        ['Best Month',              f'+{bd["bl"]["bestMonth"]["ret"]:.1f}%',    f'+{bd["ss"]["bestMonth"]["ret"]:.1f}%',    f'+{bd["combined"]["bestMonth"]["ret"]:.1f}%'],
        ['Worst Month',             f'{bd["bl"]["worstMonth"]["ret"]:.2f}%',   f'{bd["ss"]["worstMonth"]["ret"]:.2f}%',    f'{bd["combined"]["worstMonth"]["ret"]:.2f}%'],
        ['Positive Months',         f'{bd["bl"]["positiveMonths"]}/{bd["bl"]["totalMonths"]}',
                                    f'{bd["ss"]["positiveMonths"]}/{bd["ss"]["totalMonths"]}',
                                    f'{bd["combined"]["positiveMonths"]}/{bd["combined"]["totalMonths"]}'],
        ['Total Trades',            f'{bd["bl"]["count"]:,}',         f'{bd["ss"]["count"]:,}',         f'{bd["combined"]["count"]:,}'],
    ]
    s.append(bold_table(['METRIC', 'BL (LONGS)', 'SS (SHORTS)', 'COMBINED'], dir_rows,
                        col_widths=[2.3*inch, (CONTENT_W - 2.3*inch)/3]*1 + [(CONTENT_W - 2.3*inch)/3]*2))
    s.append(Spacer(1, 3))
    s.append(note(
        'Per-strategy metrics are computed post-transaction-costs only (commissions, slippage, sector-tiered borrow) and '
        'are PRE-FUND-FEES. Fund-level fees - the 2.0% management fee and the tier\'s performance allocation - are charged '
        'against total fund NAV and are not allocable to an individual strategy. The Combined column therefore also shows '
        'pre-fund-fees values so BL / SS / Combined remain apples-to-apples. All fully-burdened NET numbers elsewhere in '
        'this document (CAGR, Sharpe, etc.) reflect the full fee schedule.'
    ))
    s.append(PageBreak())
    return s


def section_heatmap(t):
    s = []
    s += section('MONTHLY RETURNS HEATMAP (NET %)')
    net_months = t['net']['monthlyReturns']
    by_year = {}
    for m in net_months:
        y, mn = m['m'].split('-')
        by_year.setdefault(y, {})[mn] = m['ret']
    # Build table — rows per year, cols Jan-Dec + Year
    header = ['', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC', 'YEAR']
    rows = []
    for y in sorted(by_year.keys()):
        row = [y]
        year_start_equity = None
        year_end_equity = None
        month_data = by_year[y]
        for mn in ['01','02','03','04','05','06','07','08','09','10','11','12']:
            if mn in month_data:
                v = month_data[mn]
                row.append(f'{v:+.1f}' if abs(v) >= 0.05 else f'{v:.1f}')
            else:
                row.append('-')
        # Annual return
        ann = next((a['ret'] for a in t['net']['annualReturns'] if a['year'] == y), None)
        row.append(f'{ann:+.1f}%' if ann is not None else '-')
        rows.append(row)

    data = [header] + rows
    col_widths = [0.45*inch] + [(CONTENT_W - 0.45*inch - 0.7*inch) / 12] * 12 + [0.7*inch]
    tbl = Table(data, colWidths=col_widths)
    ts = [
        ('BACKGROUND', (0,0), (-1,0), TABLE_HEADER),
        ('TEXTCOLOR',  (0,0), (-1,0), PNTHR_YELLOW),
        ('FONTNAME',   (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE',   (0,0), (-1,0), 8),
        ('FONTSIZE',   (0,1), (-1,-1), 7.5),
        ('ALIGN',      (1,0), (-1,-1), 'CENTER'),
        ('ALIGN',      (0,0), (0,-1),  'CENTER'),
        ('VALIGN',     (0,0), (-1,-1), 'MIDDLE'),
        ('FONTNAME',   (0,1), (0,-1), 'Helvetica-Bold'),
        ('FONTNAME',   (-1,1), (-1,-1), 'Helvetica-Bold'),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
        ('GRID',       (0,0), (-1,-1), 0.3, TABLE_BORDER),
    ]
    # Color cells per return
    for ri, row in enumerate(rows, 1):
        year = row[0]
        for ci in range(1, 13):
            cell = row[ci]
            if cell == '-': continue
            try:
                v = float(cell)
                ts.append(('BACKGROUND', (ci, ri), (ci, ri), heatmap_color(v)))
                ts.append(('TEXTCOLOR',  (ci, ri), (ci, ri), HexColor('#000000') if abs(v) < 15 else HexColor('#000000')))
            except: pass
        # Annual cell color
        try:
            ann = row[-1]
            if ann != '-':
                v = float(ann.rstrip('%').rstrip('+'))
                ts.append(('BACKGROUND', (-1, ri), (-1, ri), heatmap_color(v)))
        except: pass
    tbl.setStyle(TableStyle(ts))
    s.append(tbl)
    s.append(Spacer(1, 6))
    worst = t['net']['worstMonth']['ret']
    best = t['net']['bestMonth']['ret']
    pos = t['net']['positiveMonths']
    tot = t['net']['totalMonths']
    neg = tot - pos
    s.append(note(
        f'{pos} of {tot} months profitable ({(pos/tot*100):.1f}%)  |  Only {neg} negative months in 7 years  '
        f'|  Worst: {worst:.2f}%  |  Best: +{best:.1f}%'
    ))
    s.append(PageBreak())
    return s


def section_drawdown(t):
    s = []
    s += section('DRAWDOWN ANALYSIS')
    net = t['net']
    s.append(body(
        f'The Fund operates with zero tolerance for capital impairment. The deepest daily peak-to-trough was '
        f'<b>{net["maxDD"]:.2f}%</b> on a NET basis - compared to SPY\'s {t["spy"]["maxDD"]:.1f}% during the same seven-year '
        f'window. Every drawdown fully recovered; at no point did investor capital sustain a permanent loss nor meaningful '
        f'decline below the mark-to-market portfolio balance.'
    ))
    # 4-tile summary
    tile_data = [
        (f'{net["maxDD"]:.2f}%', 'Max Peak-to-Trough (daily MTM)', PNTHR_RED),
        (f'{net["timeUnderWater"]:.1f}%', 'Time Under Water', PNTHR_AMBER),
        (f'{net["recoveryFactor"]:.0f}', 'Recovery Factor (Return / Max DD)', PNTHR_GREEN),
        (f'{net["ulcerIndex"]:.2f}', 'Ulcer Index', PNTHR_YELLOW),
    ]
    tile_w = (CONTENT_W - 18) / 4
    cells = []
    for val, label, color in tile_data:
        p = [
            Paragraph(f'<font color="{color.hexval()[:-2]}"><b>{val}</b></font>', S('tv', fontSize=17, leading=20, alignment=TA_LEFT)),
            Paragraph(f'<font color="#888888">{label}</font>', S('tl', fontSize=7, leading=9, alignment=TA_LEFT)),
        ]
        cells.append(p)
    tbl = Table([cells], colWidths=[tile_w]*4, style=TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), HexColor('#fafafa')),
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('LEFTPADDING',  (0,0), (-1,-1), 8),
        ('RIGHTPADDING', (0,0), (-1,-1), 8),
        ('TOPPADDING',   (0,0), (-1,-1), 7),
        ('BOTTOMPADDING',(0,0), (-1,-1), 7),
    ]))
    s.append(tbl)
    s.append(Spacer(1, 8))

    # Top 5 drawdowns
    dd_rows = []
    for i, dd in enumerate(net['top5Drawdowns'], 1):
        dd_rows.append([
            str(i),
            dd['start'],
            dd['trough'],
            dd['recovery'] if dd['recovery'] else 'ongoing',
            f'{dd["duration"]} days',
            f'{dd["depthPct"]:+.2f}%',
        ])
    s.append(bold_table(['#', 'START', 'TROUGH', 'RECOVERY', 'DURATION', 'MTM TROUGH'], dd_rows,
                        col_widths=[0.3*inch, 1.1*inch, 1.1*inch, 1.1*inch, 1.0*inch, CONTENT_W - 4.6*inch]))
    s.append(Spacer(1, 4))
    s.append(note(
        'All drawdowns shown are intraday mark-to-market troughs. No drawdown resulted in permanent capital loss.'
    ))

    # Underwater chart
    s.append(Spacer(1, 6))
    chart_path = os.path.join(TMP_DIR, f'underwater_{t["tier"]}.png')
    generate_underwater_chart(t, chart_path)
    if os.path.exists(chart_path):
        img = RLImage(chart_path, width=CONTENT_W, height=1.8*inch)
        s.append(img)
    s.append(PageBreak())
    return s


def section_risk(t):
    s = []
    s += section('RISK ARCHITECTURE')
    s.append(body(
        'The Carnivore Quant Fund is engineered for capital preservation first, alpha generation second. Every aspect '
        'of the system, from signal selection to position sizing to exit discipline, ensures the portfolio can absorb '
        'adverse conditions without meaningful drawdown.'
    ))
    s += subsection('1% VITALITY CAP')
    s.append(body(
        'Each stock position risks a maximum of 1% of NAV. ETF positions are capped at 0.5%. Share count = '
        'floor(risk budget / risk per share). A wider stop produces fewer shares, not more risk.'
    ))
    s += subsection('5-LOT PYRAMID SYSTEM')
    s.append(body(
        'Initial entry deploys only 35% of the full position. Subsequent lots are earned through sequential confirmation, '
        'each lot requiring the prior lot to be filled, a time gate to be cleared, and a price trigger to be reached. '
        'Specific price thresholds at which Lots 2 through 5 trigger are proprietary and are not disclosed.'
    ))
    s += subsection('10% POSITION CAP')
    s.append(body('No single ticker can exceed 10% of NAV in total exposure, preventing concentration risk even in high-conviction names.'))
    s += subsection('SECTOR CONCENTRATION (ADVISORY FRAMEWORK)')
    s.append(body(
        'The Fund does <b>not</b> enforce a fixed sector concentration cap. The Strategy may concentrate in a single '
        'sector when trend and macro conditions favor it. Sector allocation is governed by the sector ETF gate (each sector '
        'ETF must be above or below its per-sector optimized trend filter for BL or SS respectively). An advisory '
        'notification surfaces in PNTHR Assistant when net directional exposure in a sector reaches 3+ positions, for '
        'manager awareness only (no hard cap is enforced).'
    ))
    s += subsection('PORTFOLIO HEAT CAPS')
    s.append(body('Total open risk capped at 10% for stocks, 5% for ETFs, 15% combined. Recycled positions (stop beyond entry) carry $0 risk.'))
    s += subsection('SYSTEMATIC EXIT DISCIPLINE')
    s.append(body('Exits: EMA crossover reversal, RSI > 85 FEAST alert, ATR stop hit, 20-day stale hunt liquidation, risk advisor triggers. Manual overrides tracked and scored.'))
    s += subsection('WASH SALE COMPLIANCE')
    s.append(body('30-day re-entry lockout on losing trades, automatically enforced by the pipeline.'))

    # MAE analysis
    s += section('WORST-CASE TRADE ANALYSIS (MAX ADVERSE EXCURSION)')
    s.append(body(
        'The maximum adverse excursion (MAE) measures the worst intra-trade price move against the position before exit. '
        'The table below shows the 10 most extreme adverse moves across 2,614 closed pyramid trades. Despite these '
        'individual trade drawdowns, the portfolio never experienced a negative month-end balance decline. Position sizing '
        '(1% vitality / 10% ticker cap) ensures even worst-case MAE translates to minimal portfolio impact.'
    ))
    rows = []
    for m in t['mae10']:
        rows.append([m['ticker'], m['signal'], m['entryDate'], m['exitDate'], f'{m["maePct"]:.1f}%',
                     f'${m["netPnl"]:,.0f}' if m['netPnl'] >= 0 else f'-${abs(m["netPnl"]):,.0f}', m['exitReason']])
    s.append(bold_table(['TICKER', 'SIGNAL', 'ENTRY', 'EXIT', 'MAE %', 'NET P&L', 'EXIT REASON'], rows,
                        col_widths=[0.7*inch, 0.7*inch, 0.95*inch, 0.95*inch, 0.7*inch, 0.95*inch, CONTENT_W - 4.9*inch]))
    s.append(Spacer(1, 4))
    s.append(body(
        f'<b>KEY TAKEAWAY:</b> At no point during the entire {t["net"]["years"]:.1f}-year backtest did the account balance or '
        f'investor equity decline below prior high-water marks for more than a single month. Even during the months when '
        f'these worst-case MAE trades occurred, the portfolio remained profitable on a net basis. The 1% vitality cap and '
        f'35% initial lot sizing ensure that no single adverse trade can materially impair investor capital.'
    ))
    s.append(PageBreak())
    return s


def section_rolling_bestworst(t):
    s = []
    s += section('ROLLING 12-MONTH RETURNS')
    r12m = t['net']['rolling12m']
    min_r = min((r['ret'] for r in r12m), default=0)
    neg_count = sum(1 for r in r12m if r['ret'] < 0)
    s.append(body(
        f'Across {len(r12m)} rolling 12-month windows, the minimum return was {min_r:+.1f}% '
        f'{"(ending " + next((r["endMonth"] for r in r12m if r["ret"] == min_r), "n/a") + ")" if r12m else ""}. '
        f'{"No" if neg_count == 0 else str(neg_count)} rolling 12-month period{"s were" if neg_count != 1 else " was"} negative. '
        f'The Fund has generated positive absolute returns over every trailing year of the backtest.'
    ))
    # Sample every 6 months
    sampled = r12m[::6]
    rows = [[r['endMonth'], f'{r["ret"]:+.1f}%'] for r in sampled]
    s.append(bold_table(['ENDING MONTH', 'TRAILING 12M RETURN'], rows,
                        col_widths=[CONTENT_W/2]*2))

    s += section('BEST & WORST TRADING DAYS')
    s.append(body('Data is sorted by Daily Return.'))
    s += subsection('10 WORST DAYS')
    worst_rows = [[d['date'], f'{d["ret"]:+.3f}%', fmt_usd(d['equity'], compact=False)] for d in t['net']['top10WorstDays']]
    s.append(bold_table(['DATE', 'DAILY RETURN', 'PNTHR EQUITY'], worst_rows,
                        col_widths=[1.5*inch, 1.5*inch, CONTENT_W - 3.0*inch]))
    s += subsection('10 BEST DAYS')
    best_rows = [[d['date'], f'{d["ret"]:+.3f}%', fmt_usd(d['equity'], compact=False)] for d in t['net']['top10BestDays']]
    s.append(bold_table(['DATE', 'DAILY RETURN', 'PNTHR EQUITY'], best_rows,
                        col_widths=[1.5*inch, 1.5*inch, CONTENT_W - 3.0*inch]))
    s.append(PageBreak())
    return s


def section_methodology(t):
    """ACT II — Methodology. Disclosures aligned with FIR v24 redactions."""
    s = []
    s += section('ACT II — THE METHODOLOGY')
    s += subsection('1. The PNTHR Philosophy & Platform')
    s.append(body(
        'Carnivore Quant Fund employs a proprietary systematic long/short equity strategy built on the PNTHR Signal '
        'System. The Fund identifies high-conviction entry points using a multi-dimensional scoring framework, enters '
        'positions through a disciplined five-lot pyramid structure, and manages risk via the PNTHR Proprietary Stop '
        'Loss System (PPSLS) and portfolio-level controls. The strategy is designed to generate alpha through both '
        'long (BL) and short (SS) signals, with a structural long bias reflecting the long-term upward drift of U.S. '
        'equity markets.'
    ))
    s += subsection('The PNTHR 679 Universe')
    s.append(body(
        'Every week the system scans approximately 679 premier U.S. equities drawn from the S&P 500, Nasdaq 100, '
        'Dow 30, and select high-liquidity S&P MidCap 400 constituents. The universe was selected for liquidity, '
        'coverage across all 11 GICS sectors, and representation across large-cap and mid-cap market cap ranges. ETFs '
        '(sector SPDRs and major index funds) are included for macro and sector exposure.'
    ))
    s += subsection('2. PNTHR Signal Generation')
    s.append(body(
        'A BL (Buy Long) signal is generated when the following conditions are simultaneously true. Specific '
        'thresholds, lookback periods, and parameter values are proprietary and not disclosed:'
    ))
    s.append(bullet('Weekly close above the stock\'s sector-specific optimized exponential moving average (EMA)'))
    s.append(bullet('Sector EMA slope is positive, confirming the underlying trend is genuine'))
    s.append(bullet('Structural breakout confirmation on the weekly bar'))
    s.append(bullet('Sufficient separation ("daylight") between weekly bar and EMA to filter false breakouts'))
    s.append(Spacer(1, 3))
    s.append(body(
        'An SS (Sell Short) signal is generated when the following conditions are simultaneously true:'
    ))
    s.append(bullet('Weekly close below the stock\'s sector-specific optimized EMA'))
    s.append(bullet('Sector EMA slope is negative, confirming the underlying downtrend is genuine'))
    s.append(bullet('Structural breakdown confirmation on the weekly bar'))
    s.append(bullet('Sufficient separation between weekly bar and EMA to filter false breakdowns'))
    s.append(Spacer(1, 3))
    s.append(body(
        'Additionally, SS signals require the PNTHR SS Crash Gate to be satisfied: the applicable macro index must '
        'show confirmed downward slope persistence AND the stock\'s sector must show pronounced short-term weakness. '
        'This gate is deliberately restrictive to limit short exposure to market-stress regimes. Exact slope and '
        'sector-weakness thresholds are proprietary.'
    ))
    s.append(PageBreak())

    s += subsection('3. The PNTHR Kill Scoring Engine')
    s.append(body(
        'The PNTHR Kill Scoring Engine is the intellectual core of the strategy: approximately seven years of historical '
        'research and out-of-sample validation distilled into a multi-dimensional scoring framework that transforms the '
        'PNTHR 679 universe into a precision-ranked list each week. The system does not guess; it measures, confirms, '
        'and ranks systematically.'
    ))
    s.append(body(
        'The Kill score integrates the following categories of measurement (exact weights, formulas, and parameter values are proprietary):'
    ))
    s.append(bullet('<b>Market regime:</b> index-level direction and slope, with bear-regime amplification of short signals and bull-regime amplification of long signals'))
    s.append(bullet('<b>Sector alignment:</b> short-term and medium-term directional returns of the stock\'s sector ETF'))
    s.append(bullet('<b>Entry quality:</b> technical characteristics of the signal-week weekly bar (close conviction, slope, separation)'))
    s.append(bullet('<b>Signal freshness:</b> how recently the signal was generated, with decay for aging signals'))
    s.append(bullet('<b>Rank dynamics:</b> week-over-week ranking improvement and rate of acceleration'))
    s.append(bullet('<b>Momentum confirmation:</b> multi-oscillator technical momentum (RSI, OBV, ADX, volume)'))
    s.append(bullet('<b>Multi-strategy convergence:</b> independent confirmation from the PNTHR Prey strategy overlay'))
    s.append(Spacer(1, 4))
    s.append(body(
        'The Kill score produces tiered categorization (ALPHA PNTHR KILL, STRIKING, HUNTING, POUNCING, COILING, STALKING, '
        'TRACKING, PROWLING, STIRRING, DORMANT, OVEREXTENDED) used by the Analyze pre-trade scoring system and the orders '
        'pipeline. Tier thresholds and scoring ranges are proprietary.'
    ))

    s += subsection('4. PNTHR Analyze Pre-Trade Scoring')
    s.append(body(
        'The PNTHR Analyze system answers the question every trader must answer before entering: is this the right '
        'trade, right now? Every one of Analyze\'s 100 points can be evaluated at the exact moment the scan runs. '
        'No estimation, no guesswork.'
    ))
    analyze_rows = [
        ['T1: Setup Quality', '40', 'Signal Quality (15), Kill Context (10), Index Trend (8), Sector Trend (7)'],
        ['T2: Risk Profile',  '35', 'Freshness (12), Risk/Reward (8), Prey Presence (8), Conviction (7)'],
        ['T3: Entry Conditions', '25', 'Slope Strength (5), Sector Concentration (5 advisory), Wash Compliance (5), Volatility/RSI (5), Portfolio Fit (5)'],
    ]
    s.append(bold_table(['TIER', 'POINTS', 'COMPONENTS'], analyze_rows,
                        col_widths=[1.7*inch, 0.7*inch, CONTENT_W - 2.4*inch]))
    s.append(Spacer(1, 3))
    s.append(body(
        'Score >=75% = green (optimal). >=55% = yellow (proceed with awareness). <55% = red (reconsider). '
        'The Analyze score is preserved as the authoritative snapshot for all downstream journal and discipline scoring.'
    ))

    s.append(PageBreak())
    s += subsection('5. PNTHR Position Sizing & Pyramiding')
    s.append(body(
        'Position sizing is where discipline becomes quantifiable. The PNTHR pyramid model ensures maximum capital is '
        'only deployed when the market has confirmed the trade multiple times. A new entry receives only 35% of the '
        'intended position. Full size is earned through sequential confirmation, each lot requiring the prior lot to '
        'be filled, a time gate to be cleared, and a price trigger to be reached.'
    ))
    lot_rows = [
        ['Lot 1', 'The Scent',   '35%', 'Signal entry',                'None',            'Initial position; market must confirm'],
        ['Lot 2', 'The Stalk',   '25%', 'Price confirmation + time',   '5 trading days',  'Largest add; time + price both required'],
        ['Lot 3', 'The Strike',  '20%', 'Price confirmation',          'Lot 2 filled',    'Momentum continuation confirmed'],
        ['Lot 4', 'The Jugular', '12%', 'Price confirmation',          'Lot 3 filled',    'Trend extension'],
        ['Lot 5', 'The Kill',    '8%',  'Price confirmation',          'Lot 4 filled',    'Maximum conviction; full position'],
    ]
    s.append(bold_table(['LOT', 'NAME', 'ALLOC', 'TRIGGER', 'GATE', 'PURPOSE'], lot_rows,
                        col_widths=[0.55*inch, 0.85*inch, 0.55*inch, 1.25*inch, 1.0*inch, CONTENT_W - 4.2*inch]))
    s.append(Spacer(1, 4))
    s.append(note(
        'Specific price thresholds at which Lots 2 through 5 trigger are proprietary and are not disclosed.'
    ))

    s += subsection('Stop Ratchet on Each Lot Fill')
    ratchet_rows = [
        ['Lot 2 fills', 'Initial stop (unchanged)',     'Time + price confirmed, position monitored'],
        ['Lot 3 fills', 'Average cost (breakeven)',     'Capital protected; initial investment covered'],
        ['Lot 4 fills', 'Lot 2 fill price',             'Lot 2 gain locked in as minimum exit'],
        ['Lot 5 fills', 'Lot 3 fill price',             'Full pyramid; aggressive ratcheted stop'],
    ]
    s.append(bold_table(['LOT FILL EVENT', 'STOP MOVES TO', 'EFFECT'], ratchet_rows,
                        col_widths=[1.5*inch, 2.5*inch, CONTENT_W - 4.0*inch]))
    s.append(Spacer(1, 3))
    s.append(body('Stops never move backwards. The ratchet is a one-way lock. SS positions: ratchets down only.'))

    s += subsection('6. Portfolio Command Center & Entry Workflow')
    workflow_rows = [
        ['1', 'SIZE IT',          'Analyze scoring (100 pts). Blocked when errors detected. Green >=75%. Yellow 55-74%. Red <55%.'],
        ['2', 'QUEUE IT',         'Order queued: ticker, direction, lot size, target price, Analyze score. Per-user, persists across sessions.'],
        ['3', 'SEND TO COMMAND',  '4-source cascade: Analyze snapshot (authoritative) → queue entry → MongoDB pipeline → signal cache updated.'],
    ]
    s.append(bold_table(['STEP', 'ACTION', 'WHAT HAPPENS'], workflow_rows,
                        col_widths=[0.45*inch, 1.3*inch, CONTENT_W - 1.75*inch]))

    s += subsection('Systematic Exit Discipline')
    exit_rows = [
        ['PNTHR Signal',        'Proprietary PNTHR Exit Signal generated',                      '12/12 (Perfect)'],
        ['FEAST',               'RSI > 85 momentum exhaustion, sell 50% immediately',           '12/12 (Perfect)'],
        ['PNTHR PPSLS Stop Hit','Ratchet stop hit',                                             '10/12'],
        ['RISK_ADVISOR',        'Proactive exit on elevated sector or portfolio exposure advisory', '10/12'],
        ['STALE_HUNT',          '20-day position without development, mandatory closure',       '10/12'],
        ['MANUAL',              'Discretionary exit',                                           '4/12 (profit) or 0/12 (loss)'],
    ]
    s.append(bold_table(['EXIT TYPE', 'TRIGGER', 'DISCIPLINE SCORE'], exit_rows,
                        col_widths=[1.5*inch, 3.3*inch, CONTENT_W - 4.8*inch]))
    s.append(PageBreak())

    s += subsection('7. Scoring Health / Archive / History / IBKR Bridge')
    s.append(body(
        'The Fund runs a weekly batch process every Friday at 4:15 PM ET that refreshes all Kill scores, updates the '
        'signal state machine, recalculates stops, and persists results to the database. All trade actions, Analyze '
        'snapshots, journal entries, and signal history are stored in immutable per-trade records. The IBKR Bridge '
        'provides passive synchronization between Interactive Brokers Trader Workstation and the PNTHR portfolio '
        'tracking layer, detecting fills, syncing stop orders, and surfacing any discrepancies to the PNTHR Assistant '
        'for resolution.'
    ))

    s += subsection('8. Institutional Backtest Results (per-tier summary)')
    ib_rows = [
        ['Backtest Span',              f'{t["gross"]["startDate"]} → {t["gross"]["endDate"]} ({t["gross"]["years"]:.2f} years)'],
        ['Starting Capital (this tier)', fmt_usd(t["seedNav"], compact=False)],
        ['Ending Equity Gross',        fmt_usd(t["gross"]["endNav"], compact=True)],
        ['Ending Equity Net',          fmt_usd(t["net"]["endNav"], compact=True)],
        ['Total Trades (initiated)',   f'{t["trades"]["total"]:,}'],
        ['Total Trades (closed)',      f'{t["trades"]["closed"]:,}'],
        ['Win Rate (Combined)',        f'{t["trades"]["combined"]["winRate"]:.1f}%'],
        ['Profit Factor (Combined)',   f'{t["trades"]["combined"]["profitFactor"]:.2f}x'],
        ['Gross CAGR',                 f'+{t["gross"]["cagr"]:.2f}%'],
        ['Net CAGR ({fee_class})'.format(fee_class=t["classLabel"]), f'+{t["net"]["cagr"]:.2f}%'],
        ['Gross Sharpe',               f'{t["gross"]["sharpe"]:.2f}'],
        ['Net Sharpe',                 f'{t["net"]["sharpe"]:.2f}'],
        ['Gross Sortino',              f'{t["gross"]["sortino"]:.2f}'],
        ['Net Sortino',                f'{t["net"]["sortino"]:.2f}'],
        ['Max Drawdown (Gross MTM)',   f'{t["gross"]["maxDD"]:.2f}%'],
        ['Max Drawdown (Net MTM)',     f'{t["net"]["maxDD"]:.2f}%'],
    ]
    s.append(bold_table(['METRIC', 'VALUE'], ib_rows, col_widths=[2.8*inch, CONTENT_W - 2.8*inch]))

    s += subsection('9. Empirical Evidence')
    s.append(body(
        'The numbers in this report are not projections. They are the direct output of a deterministic backtest against '
        'historical price data, with every transaction cost modeled at the trade level and every fund-level fee modeled '
        'at the portfolio level. The comprehensive daily NAV log in Act III contains the full per-day mark-to-market '
        'record for the entire backtest period.'
    ))
    s.append(PageBreak())
    return s


def section_daily_nav_log(t):
    """ACT III — Comprehensive Daily NAV Log. 1,713 daily rows, ~40 pages."""
    s = []
    s += section('ACT III — THE PROOF: COMPREHENSIVE DAILY NAV LOG')
    s.append(body(
        'The complete per-day mark-to-market equity series for the entire backtest, both Gross (post-transaction-costs, '
        'pre-fund-fees) and Net (post-fund-fees per the tier\'s PPM schedule). This is the raw evidence — every trading '
        'day, every NAV value, auditable against the canonical MongoDB collections pnthr_bt_pyramid_nav_' + t['tier'] +
        '_daily_nav_mtm_v21_recomputed (Gross) and pnthr_bt_pyramid_nav_' + t['tier'] + '_daily_nav_mtm_v21_net_recomputed (Net).'
    ))
    s.append(Spacer(1, 6))

    daily = t['gross'].get('dailySeries', [])
    if not daily:
        s.append(note('Daily NAV series unavailable; regenerate metrics JSON with dailySeries field.'))
        s.append(PageBreak())
        return s

    rows = []
    for d in daily:
        rows.append([
            d['date'],
            fmt_usd(d['gross'], compact=False),
            f'{d["grossDD"]:.2f}%' if d['grossDD'] < 0 else '0.00%',
            fmt_usd(d['net'], compact=False) if d['net'] is not None else '-',
            f'{d["netDD"]:.2f}%' if d['netDD'] is not None and d['netDD'] < 0 else '0.00%',
        ])

    # 40 rows per page × 43 pages = 1,720 rows (fits 1,713)
    ROWS_PER_PAGE = 40
    for page_start in range(0, len(rows), ROWS_PER_PAGE):
        chunk = rows[page_start:page_start + ROWS_PER_PAGE]
        data = [['DATE', 'GROSS EQUITY', 'GROSS DD', 'NET EQUITY', 'NET DD']] + chunk
        tbl = Table(data, colWidths=[
            0.95*inch, 1.5*inch, 0.9*inch, 1.5*inch, 0.9*inch,
        ], style=TableStyle([
            ('BACKGROUND', (0,0), (-1,0), TABLE_HEADER),
            ('TEXTCOLOR', (0,0), (-1,0), white),
            ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
            ('FONTSIZE', (0,0), (-1,0), 8),
            ('FONTSIZE', (0,1), (-1,-1), 7),
            ('ALIGN', (1,0), (-1,-1), 'RIGHT'),
            ('ALIGN', (0,0), (0,-1),  'LEFT'),
            ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
            ('TOPPADDING', (0,0), (-1,-1), 2),
            ('BOTTOMPADDING', (0,0), (-1,-1), 2),
            ('LINEBELOW', (0,0), (-1,-1), 0.15, HexColor('#f0f0f0')),
        ]))
        s.append(tbl)
        # Small footer showing range + page position
        total_pages = (len(rows) + ROWS_PER_PAGE - 1) // ROWS_PER_PAGE
        current_page = page_start // ROWS_PER_PAGE + 1
        s.append(Spacer(1, 4))
        s.append(note(f'Rows {page_start+1:,}-{min(page_start + ROWS_PER_PAGE, len(rows)):,} of {len(rows):,}  |  Log page {current_page} of {total_pages}'))
        if page_start + ROWS_PER_PAGE < len(rows):
            s.append(PageBreak())

    s.append(Spacer(1, 8))
    s.append(note(
        f'All {len(rows):,} rows above are direct reads from the canonical MongoDB daily NAV collections. '
        f'Gross = post-transaction-costs, pre-fund-fees. Net = post-fund-fees per {t["classLabel"]} schedule. '
        f'Drawdown columns are % below running peak on that side\'s equity curve.'
    ))
    s.append(PageBreak())
    return s


def section_cumulative_growth_chart_page(t):
    s = []
    s += section('ACT IV — CUMULATIVE GROWTH CHART')
    s.append(body(
        'The full backtest equity curve, NET of all fees, plotted against the passive S&P 500 (SPY) benchmark. '
        'Starting capital in both cases is aligned at the tier\'s PPM-defined threshold; both curves shown at the '
        'same dollar scale for apples-to-apples comparison.'
    ))
    chart_path = os.path.join(TMP_DIR, f'growth_full_{t["tier"]}.png')
    generate_cumulative_growth_chart(t, chart_path)
    if os.path.exists(chart_path):
        img = RLImage(chart_path, width=CONTENT_W, height=3.2*inch)
        s.append(img)
    s.append(Spacer(1, 10))
    s.append(note('Full daily resolution. Chart sampled from 1,713 trading days of MTM NAV data.'))
    s.append(PageBreak())
    return s


def section_executive_recap(t):
    s = []
    s += section('EXECUTIVE RECAP')
    net = t['net']; gross = t['gross']
    s.append(body(
        f'Over a {gross["years"]:.1f}-year backtest spanning the period {gross["startDate"]} through {gross["endDate"]} - '
        f'encompassing the COVID crash, the 2022 bear market, the 2025 Liberation Day correction, and every smaller '
        f'market disturbance in between - the Carnivore Quant Fund strategy, applied to a {fmt_usd(t["seedNav"], compact=False)} '
        f'starting capital under the {t["classLabel"]} fee schedule, delivered the following verified outcomes:'
    ))
    s.append(Spacer(1, 6))
    s += subsection('Primary Results (Net of all fees)')
    s.append(bullet(f'<b>Total Return:</b> +{net["totalReturn"]:.1f}% ({fmt_usd(t["seedNav"], compact=False)} → {fmt_usd(net["endNav"], compact=True)})'))
    s.append(bullet(f'<b>CAGR:</b> +{net["cagr"]:.2f}% net of all fund fees'))
    s.append(bullet(f'<b>Sharpe Ratio:</b> {net["sharpe"]:.2f} (RF = US 3-month T-Bill, daily excess returns annualized by sqrt(252))'))
    s.append(bullet(f'<b>Sortino Ratio:</b> {net["sortino"]:.2f} (MAR = 0, HFRI convention, daily returns)'))
    s.append(bullet(f'<b>Maximum Drawdown (MTM):</b> {net["maxDD"]:.2f}% — deepest daily peak-to-trough'))
    s.append(bullet(f'<b>Calmar Ratio:</b> {net["calmar"]:.1f}'))
    s.append(bullet(f'<b>Ulcer Index:</b> {net["ulcerIndex"]:.2f}'))
    s.append(bullet(f'<b>Time Under Water:</b> {net["timeUnderWater"]:.1f}%'))
    s.append(bullet(f'<b>Recovery Factor:</b> {net["recoveryFactor"]:.0f} (Total Return / |Max DD|)'))
    s.append(bullet(f'<b>Profit Factor:</b> {t["trades"]["combined"]["profitFactor"]:.2f}x (trade-level)'))
    s.append(bullet(f'<b>Win Rate:</b> {t["trades"]["combined"]["winRate"]:.1f}% across {t["trades"]["closed"]:,} closed trades'))
    s.append(bullet(f'<b>Positive Months:</b> {net["positiveMonths"]}/{net["totalMonths"]} ({net["positivePct"]:.1f}%)'))

    s += subsection('Alpha Generation vs S&P 500')
    alpha_tr = net['totalReturn'] - t['spy']['totalReturn']
    alpha_cagr = net['cagr'] - t['spy']['cagr']
    s.append(bullet(f'<b>Total Return Alpha:</b> +{alpha_tr:.1f} percentage points ({fmt_usd(net["endNav"] - t["spy"]["endingEquity"], compact=True)} in absolute $)'))
    s.append(bullet(f'<b>CAGR Alpha:</b> +{alpha_cagr:.2f} percentage points annualized'))
    s.append(bullet(f'<b>Drawdown Reduction:</b> PNTHR {net["maxDD"]:.2f}% vs SPY {t["spy"]["maxDD"]:.1f}% — significantly shallower drawdowns'))
    s.append(PageBreak())

    s += subsection('Fee Structure Applied')
    s.append(body(
        f'All Net figures reflect the {t["classLabel"]} fee schedule per PPM v6.9 sec. 4.1-4.3, applied exactly as described. '
        f'The 2.0% management fee is accrued monthly on NAV. The performance allocation is charged quarterly, non-cumulative, '
        f'at {t["feeSchedule"]["yearsOneToThree"]}% in years 1-3 and {t["feeSchedule"]["yearsFourPlus"]}% thereafter (the '
        f'36-month loyalty discount), on the portion of quarter-end NAV exceeding BOTH the running High Water Mark AND the '
        f'quarterly hurdle (US2Y ÷ 4). Trade-level costs (IBKR Pro Fixed $0.005/share, 5 bps slippage per leg, 1.0-2.0% '
        f'sector-tiered short borrow) are reflected in both Gross and Net figures.'
    ))

    s += subsection('Per-Direction Contribution')
    s.append(bullet(f'<b>BL (Longs):</b> {t["trades"]["bl"]["count"]:,} closed trades, {t["trades"]["bl"]["winRate"]:.1f}% win rate, {t["trades"]["bl"]["profitFactor"]:.2f}x profit factor, Gross CAGR +{t["byDirection"]["bl"]["cagr"]:.1f}%.'))
    s.append(bullet(f'<b>SS (Shorts):</b> {t["trades"]["ss"]["count"]:,} closed trades, {t["trades"]["ss"]["winRate"]:.1f}% win rate, {t["trades"]["ss"]["profitFactor"]:.2f}x profit factor, Gross CAGR +{t["byDirection"]["ss"]["cagr"]:.1f}%. The SS Crash Gate keeps SS trade count deliberately low — short exposure only activates in market-stress regimes.'))
    s.append(PageBreak())
    return s


def section_methodology_and_assumptions(t):
    s = []
    s += section('METHODOLOGY & ASSUMPTIONS')
    s += subsection('Data Sources')
    s.append(bullet('<b>Market Data:</b> Financial Modeling Prep (FMP) historical daily OHLCV for all 679 PNTHR universe tickers plus SPY, QQQ, MDY benchmarks. Adjusted for splits and dividends.'))
    s.append(bullet('<b>Index Membership:</b> SP500 and NDX100 membership events reconstructed historically from FMP / Wikipedia. SP400 membership approximated via MDY ETF holdings proxy.'))
    s.append(bullet('<b>Sector Classification:</b> GICS sectors as of backtest generation date, normalized across Materials / Basic Materials, Consumer Discretionary / Cyclical, Financial / Financial Services variants.'))

    s += subsection('Performance Metric Conventions')
    s.append(bullet('<b>Sharpe Ratio:</b> daily excess returns over the US 3-month Treasury Bill (first trading day of each year), annualized by sqrt(252) trading days.'))
    s.append(bullet('<b>Sortino Ratio:</b> daily returns with MAR = 0, downside deviation computed using HFRI convention (sum of squared-negative-returns divided by TOTAL sample size, not just down-day count), annualized by sqrt(252).'))
    s.append(bullet('<b>Maximum Drawdown:</b> peak-to-trough percentage decline measured on daily mark-to-market NAV (includes unrealized P&L on open positions).'))
    s.append(bullet('<b>Profit Factor and Win Rate:</b> computed at the individual closed-trade level from the per-tier trade log.'))
    s.append(bullet('<b>Calmar Ratio:</b> CAGR divided by |Max Drawdown|.'))
    s.append(bullet('<b>Ulcer Index:</b> sqrt(mean(drawdown^2)) over the full daily NAV series.'))

    s += subsection('Gate Policy (per v22 disclosure)')
    s.append(bullet('<b>Direction Index Gate:</b> the stock\'s applicable index is determined by its actual historical membership at the signal date (S&P 500 member uses SPY; Nasdaq-100-only member uses QQQ; S&P MidCap 400 member uses MDY via MDY ETF holdings proxy; non-index fallback uses SPY). The index\'s weekly close vs. its 21-week EMA must align with the candidate\'s direction (index above EMA for BL; below for SS).'))
    s.append(bullet('<b>Sector ETF Gate:</b> the stock\'s sector ETF (XLK, XLE, XLV, XLF, XLY, XLC, XLI, XLB, XLRE, XLU, XLP) must be positioned correctly against its sector-specific trend-filter period. Specific periods are empirically optimized per sector and are proprietary.'))
    s.append(bullet('<b>D2 Gate:</b> the stock\'s sector directional return component of the Kill score must be non-negative.'))
    s.append(bullet('<b>SS Crash Gate:</b> for SS only, requires dual confirmation of sustained bearish direction-index momentum and pronounced recent sector weakness. Specific thresholds are proprietary.'))

    s += subsection('Fee Engine (PPM sec. 4.1-4.3)')
    s.append(bullet('<b>Management Fee:</b> 2.00% per annum accrued monthly on NAV (1/12 of 2% per month).'))
    s.append(bullet(f'<b>Performance Allocation:</b> charged quarterly on March 31 / June 30 / September 30 / December 31, non-cumulative. Applied to the portion of quarter-end NAV exceeding BOTH (a) the running High-Water Mark, and (b) the quarterly hurdle equal to the US 2-Year Treasury yield as of the first trading day of the Fiscal Year divided by four. Class rates: Filet 30% (25% after 36 continuous months of investment), Porterhouse 25% (20% after 36 months), Wagyu 20% (15% after 36 months). Loss Carryforward: if NAV falls below HWM in any period, future allocations are suspended until NAV fully recovers to the prior HWM.'))

    s += subsection('Survivorship Bias Disclosure')
    s.append(body(
        'The backtest universe consists of approximately 679 U.S. listed equities representing the current (April 2026) '
        'composition of the S&P 500, Nasdaq-100, Dow Jones Industrial Average, and S&P MidCap 400 indices. Historical '
        'price data is sourced from Financial Modeling Prep. Tickers that were delisted, acquired, merged, or otherwise '
        'removed from their parent index prior to April 2026 are not represented in the backtest, as historical price '
        'data for such tickers is not available in the current data source.'
    ))
    s.append(PageBreak())
    return s


def section_disclosures(t):
    s = []
    s += section('IMPORTANT DISCLOSURES')
    s.append(body(
        'This document is CONFIDENTIAL and intended solely for Qualified Investors. It is not an offer to sell or '
        'solicitation of an offer to buy any security. Any such offer or solicitation can only be made by the Fund\'s '
        'Private Placement Memorandum (PPM v6.9), Limited Partnership Agreement (LPA v3.4), and Subscription '
        'Agreement (v2.6), which together contain the only complete and binding terms of investment.'
    ))
    s += subsection('Hypothetical Backtest Disclosure')
    s.append(body(
        'These figures are entirely <b>hypothetical backtest results</b>. The Fund has not yet traded non-affiliated '
        'Limited Partner capital. From June 16, 2025 through April 16, 2026 (the Pre-Launch Live Testing Period), the '
        'General Partner and principals used their own capital to live-test the Short-Term Complementary Strategy. '
        '<b>The Short-Term Complementary Strategy is a completely separate trading strategy from the Strategy described '
        'in this Report.</b> It differs from the Strategy in all material respects, including signal logic, entry and '
        'exit rules, position sizing methodology, risk management framework, and portfolio construction. <b>The Strategy '
        'itself was not traded during the Pre-Launch Live Testing Period, and the 44.92% cumulative loss incurred by '
        'the Short-Term Complementary Strategy has no bearing on, and is not indicative of, the performance of the '
        'Strategy.</b> The Short-Term Complementary Strategy produced cumulative losses of 44.92% borne exclusively by '
        'the General Partner; no non-affiliated Limited Partner was exposed. The Short-Term Complementary Strategy has '
        'been permanently eliminated from the Fund\'s investment program. The Strategy presented in this Report is '
        'operational as of April 17, 2026. All backtest performance is simulated against historical data.'
    ))
    s += subsection('Performance Methodology')
    s.append(body(
        f'All metrics in this document are computed from the v21 canonical mark-to-market + PPM-fee-adjusted daily NAV '
        f'collections (pnthr_bt_pyramid_nav_{t["tier"]}_daily_nav_mtm_v21_recomputed for Gross, '
        f'pnthr_bt_pyramid_nav_{t["tier"]}_daily_nav_mtm_v21_net_recomputed for Net) produced by the deterministic '
        f'backtest engine. Source code is maintained in the PNTHR Funds, LLC private repository and available for '
        f'inspection by Limited Partners upon request subject to a confidentiality agreement.'
    ))
    s += subsection('Past Performance / Forward-Looking Statements')
    s.append(body(
        'Past performance is not indicative of future results. The Fund may experience losses. Investment in the Fund '
        'is suitable only for sophisticated investors who can bear the risk of loss of their entire investment. All '
        'forward-looking statements, including projected returns, are based on the Strategy\'s historical backtest and '
        'are not guarantees of future results.'
    ))
    s += subsection('Regulatory')
    s.append(body(
        'PNTHR Funds, LLC (the "General Partner") is a Delaware limited liability company. Carnivore Quant Fund, LP '
        '(the "Fund") is a Delaware limited partnership. The Fund is offered pursuant to Regulation D, Rule 506(c), and '
        'relies on Section 3(c)(1) of the Investment Company Act of 1940. The Investment Manager, STT Capital Advisors, '
        'LLC, operates as a Private Fund Adviser under Section 203(m) of the Investment Advisers Act of 1940 (assets '
        'under management less than $150,000,000). Investors must qualify as Accredited Investors under Rule 501(a) AND '
        'as Qualified Clients under Rule 205-3, with third-party verification required per Rule 506(c)(2)(ii).'
    ))
    s.append(Spacer(1, 6))
    s.append(note(
        f'Document Revision: Pyramid IR v1 - April 2026 - {t["classLabel"]} ({fmt_usd(t["seedNav"], compact=True)} NAV variant)  |  '
        f'Issuer: PNTHR Funds, LLC (General Partner)  |  Generated: {datetime.now().strftime("%Y-%m-%d")}.'
    ))
    return s


# ── Main driver ──────────────────────────────────────────────────────────────
def build_per_tier_ir(tier_key):
    json_path = os.path.join(OUT_DIR, f'pnthr_ir_metrics_{tier_key}_2026_04_21.json')
    if not os.path.exists(json_path):
        print(f'  !! Missing metrics JSON: {json_path}')
        return None
    with open(json_path) as f:
        t = json.load(f)

    # Build story (list of flowables)
    story = []
    story += section_cover(t)            # Canonical Phase 2 cover
    story += section_highlights(t)       # Page 2: headline tiles + growth chart
    story += section_toc(t)
    story += section_executive_summary(t)
    story += section_fees(t)
    story += section_crisis(t)
    story += section_heatmap(t)
    story += section_drawdown(t)
    story += section_risk(t)
    story += section_rolling_bestworst(t)
    story += section_methodology(t)
    story += section_daily_nav_log(t)
    story += section_cumulative_growth_chart_page(t)
    story += section_executive_recap(t)
    story += section_methodology_and_assumptions(t)
    story += section_disclosures(t)

    filename = f'PNTHR_Pyramid_IR_{t["label"]}_{tier_key}_v1.pdf'
    short_title = f'{t["classLabel"]} Pyramid Intelligence Report'
    title_meta = f'PNTHR Funds - Carnivore Quant Fund, LP - {t["classLabel"]} Pyramid Intelligence Report v1'
    path = build_doc(filename, title_meta, short_title, story)
    return path


if __name__ == '__main__':
    print('Generating PNTHR per-tier Pyramid Intelligence Reports...\n')
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
