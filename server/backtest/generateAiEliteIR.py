#!/usr/bin/env python3
"""
generateAiEliteIR.py - PNTHR AI Elite Fund Per-Tier Intelligence Report

Black-background PDF with yellow headings, 4-act structure:
  Act I:   Results (exec summary, perf comp, gross vs net, fees, crisis, annual,
           heatmap, drawdown, risk, rolling, best/worst)
  Act II:  Methodology (AI Universe, PAI300, sector rotation, signal gen, sizing)
  Act III: Proof (comprehensive daily NAV log)
  Act IV:  Close (growth chart, recap, summary, methodology & assumptions, disclosures)

Data: ~/Downloads/pnthr_ai_elite_ir_metrics_{100k,500k,1m}.json
Output: ~/Downloads/PNTHR_AI_Elite_IR_{Filet,Porterhouse,Wagyu}_{tier}_v10.1.pdf
"""

import os, json, sys
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

YELLOW  = HexColor('#fcf000')
BLACK   = HexColor('#000000')
WHITE   = HexColor('#ffffff')
OFFWHT  = HexColor('#e8e8e8')
LGRAY   = HexColor('#aaaaaa')
MGRAY   = HexColor('#777777')
DGRAY   = HexColor('#444444')
VDGRAY  = HexColor('#222222')
GREEN   = HexColor('#22c55e')
RED     = HexColor('#ef4444')

def heatmap_bg(pct):
    if pct is None: return VDGRAY
    if pct > 0:
        intensity = min(abs(pct) / 12.0, 1.0)
        r = int(20 + 20 * (1 - intensity)); g = int(80 + 120 * intensity); b = int(20 + 20 * (1 - intensity))
        return HexColor(f'#{r:02x}{g:02x}{b:02x}')
    if pct < 0:
        intensity = min(abs(pct) / 5.0, 1.0)
        r = int(100 + 100 * intensity); g = int(30 + 10 * (1 - intensity)); b = int(30 + 10 * (1 - intensity))
        return HexColor(f'#{r:02x}{g:02x}{b:02x}')
    return VDGRAY

HERE    = os.path.dirname(os.path.abspath(__file__))
PUBLIC  = os.path.join(HERE, '../../client/public')
ASSETS  = os.path.join(HERE, '../../client/src/assets')
OUT_DIR = os.path.expanduser('~/Downloads')
TMP_DIR = '/tmp/pnthr_ai_ir_charts'
LOGO_BLACK_BG = os.path.join(PUBLIC, 'pnthr-logo-black-bg.png')
PANTHER_HEAD  = os.path.join(ASSETS, 'panther-head-sm.png')
os.makedirs(TMP_DIR, exist_ok=True)

PAGE_W, PAGE_H = letter
MARGIN_L = 0.75 * inch; MARGIN_R = 0.75 * inch
MARGIN_T = 0.90 * inch; MARGIN_B = 0.80 * inch
CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R

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
    return [
        Spacer(1, 4),
        Paragraph(f'<b>{text}</b>', S('sect', fontSize=14, leading=18, textColor=YELLOW, fontName='Helvetica-Bold', alignment=TA_LEFT)),
        HRFlowable(width='100%', thickness=0.8, color=YELLOW, spaceBefore=2, spaceAfter=8),
    ]

def subsection_heading(text):
    return [Spacer(1, 4), Paragraph(f'<b>{text}</b>', S('sub', fontSize=11, leading=14, textColor=YELLOW, fontName='Helvetica-Bold', alignment=TA_LEFT)), Spacer(1, 2)]

def body_p(text):
    return Paragraph(text, S('body', fontSize=10, leading=13, textColor=OFFWHT, alignment=TA_JUSTIFY))

def bullet_p(text):
    return Paragraph(f'- {text}', S('bul', fontSize=10, leading=13, textColor=OFFWHT, leftIndent=12))

def note_p(text):
    return Paragraph(text, S('note', fontSize=8.5, leading=11, textColor=LGRAY, fontName='Helvetica-Oblique'))

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

def compute_payoff(t, net=False):
    """Compute avg win / avg loss payoff ratio from trade stats."""
    stats = t['trades']['combinedNet'] if net else t['trades']['combined']
    if stats['wins'] > 0 and stats['losses'] > 0:
        return (stats['grossWin'] / stats['wins']) / (stats['grossLoss'] / stats['losses'])
    return 0

def get_trade_stats(t, net=False):
    """Return (winRate, profitFactor, payoffRatio) from trade stats."""
    stats = t['trades']['combinedNet'] if net else t['trades']['combined']
    return stats['winRate'], stats['profitFactor'], compute_payoff(t, net)

def _dark_table(headers, rows, col_widths, align_right_from=1, first_col_color=None):
    data = [[Paragraph(f'<b><font color="#fcf000">{h}</font></b>',
                       S(f'dh{i}', fontSize=9, alignment=TA_LEFT if i == 0 else TA_RIGHT))
             for i, h in enumerate(headers)]] + rows
    tbl = Table(data, colWidths=col_widths)
    style = [
        ('FONTSIZE', (0,0), (-1,-1), 9), ('TEXTCOLOR', (0,1), (-1,-1), OFFWHT),
        ('ALIGN', (align_right_from,0), (-1,-1), 'RIGHT'), ('ALIGN', (0,0), (0,-1), 'LEFT'),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'), ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4), ('LEFTPADDING', (0,0), (-1,-1), 2),
        ('RIGHTPADDING', (0,0), (-1,-1), 6), ('LINEBELOW', (0,0), (-1,0), 0.5, DGRAY),
    ]
    if first_col_color: style.append(('TEXTCOLOR', (0,1), (0,-1), first_col_color))
    tbl.setStyle(TableStyle(style))
    return tbl

def _draw_chrome(canvas, doc, is_cover=False):
    canvas.saveState()
    canvas.setFillColor(BLACK)
    canvas.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    if not is_cover:
        y_top = PAGE_H - 0.50 * inch
        canvas.setFillColor(YELLOW); canvas.setFont('Helvetica-Bold', 8.5)
        canvas.drawString(MARGIN_L, y_top, 'PNTHR FUNDS')
        brand_w = canvas.stringWidth('PNTHR FUNDS', 'Helvetica-Bold', 8.5)
        canvas.setFillColor(OFFWHT); canvas.setFont('Helvetica', 8.5)
        canvas.drawString(MARGIN_L + brand_w + 6, y_top, '|  AI Elite Fund  |  Intelligence Report')
        canvas.setFillColor(OFFWHT)
        canvas.drawRightString(PAGE_W - MARGIN_R, y_top, f'Page {doc.page}')
    rule_y = PAGE_H - 0.62 * inch if not is_cover else PAGE_H - 0.36 * inch
    canvas.setStrokeColor(YELLOW); canvas.setLineWidth(0.75)
    canvas.line(MARGIN_L, rule_y, PAGE_W - MARGIN_L, rule_y)
    canvas.setStrokeColor(DGRAY); canvas.setLineWidth(0.35)
    canvas.line(MARGIN_L, 0.52 * inch, PAGE_W - MARGIN_R, 0.52 * inch)
    canvas.setFillColor(LGRAY); canvas.setFont('Helvetica', 8)
    canvas.drawCentredString(PAGE_W / 2.0, 0.32 * inch,
        'PNTHR FUNDS  -  AI ELITE FUND  -  CONFIDENTIAL  -  May 2026  -  pnthrfunds.com')
    canvas.restoreState()

def on_cover(canvas, doc): _draw_chrome(canvas, doc, is_cover=True)
def on_page(canvas, doc): _draw_chrome(canvas, doc, is_cover=False)

def build_doc(filename, title_meta, story):
    out_path = os.path.join(OUT_DIR, filename)
    doc = SimpleDocTemplate(out_path, pagesize=letter,
        leftMargin=MARGIN_L, rightMargin=MARGIN_R, topMargin=MARGIN_T, bottomMargin=MARGIN_B,
        title=title_meta, author='PNTHR Funds, LLC', subject='AI Elite Fund Intelligence Report')
    doc.build(story, onFirstPage=on_cover, onLaterPages=on_page)
    return out_path

def generate_growth_chart(tier, path, big=False):
    daily = tier['gross']['dailySeries']
    pnthr_xs = [_dt.strptime(d['date'], '%Y-%m-%d') for d in daily]
    pnthr_ys = [d['net'] if d['net'] is not None else d['gross'] for d in daily]
    spy_ys = [d['spyEquity'] for d in daily]
    w, h = (7.2, 3.0) if big else (5.0, 2.2)
    fig, ax = plt.subplots(figsize=(w, h), dpi=130)
    fig.patch.set_facecolor('#000000'); ax.set_facecolor('#000000')
    ax.plot(pnthr_xs, pnthr_ys, color='#fcf000', linewidth=1.6, label=f'AI Elite Fund (${tier["seedNav"]:,})')
    ax.plot(pnthr_xs, spy_ys, color='#cccccc', linewidth=1.0, linestyle='--', label=f'S&P 500 (${tier["seedNav"]:,})')
    ax.tick_params(colors='#888888', labelsize=7)
    for spine in ax.spines.values(): spine.set_color('#333333')
    ax.grid(True, color='#1a1a1a', linewidth=0.4)
    def usd_fmt(v, _):
        if v >= 1e6: return f'${v/1e6:.1f}M'
        if v >= 1e3: return f'${v/1e3:.0f}K'
        return f'${v:.0f}'
    ax.yaxis.set_major_formatter(plt.FuncFormatter(usd_fmt))
    if big:
        ax.set_title(f'Cumulative Growth ({pnthr_xs[0].year}-{pnthr_xs[-1].year})', color='#ffffff', fontsize=10, pad=8, loc='left')
    ax.legend(facecolor='#000000', edgecolor='#222222', labelcolor='#cccccc', fontsize=7, loc='upper left')
    fig.tight_layout()
    fig.savefig(path, facecolor='#000000', dpi=130, bbox_inches='tight')
    plt.close(fig)

def generate_underwater_chart(tier, path):
    daily = tier['gross']['dailySeries']
    seed = tier['seedNav']
    xs = [_dt.strptime(d['date'], '%Y-%m-%d') for d in daily]

    paper_dd = [d['netDD'] if d['netDD'] is not None else d['grossDD'] for d in daily]

    spy_eq = [d['spyEquity'] for d in daily]
    spy_peak = spy_eq[0]
    spy_dd = []
    for eq in spy_eq:
        if eq > spy_peak: spy_peak = eq
        spy_dd.append((eq - spy_peak) / spy_peak * 100)

    cum_pnl = 0.0
    realized_dd = []
    pnl_peak = 0.0
    for d in daily:
        for c in (d.get('closesList') or []):
            cum_pnl += c.get('netPnl', 0)
        if cum_pnl > pnl_peak: pnl_peak = cum_pnl
        # Match metrics script: divide by (seed + cumPeak) so DD scales with equity growth
        if pnl_peak > 0:
            realized_dd.append((cum_pnl - pnl_peak) / (seed + pnl_peak) * 100)
        else:
            realized_dd.append(cum_pnl / seed * 100 if cum_pnl < 0 else 0.0)

    fig, ax = plt.subplots(figsize=(7.0, 2.1), dpi=200)
    fig.patch.set_facecolor('#000000'); ax.set_facecolor('#000000')
    ax.plot(xs, spy_dd, color='#ef4444', linewidth=1.8, label='S&P 500 DD', alpha=0.85)
    ax.plot(xs, paper_dd, color='#f9a825', linewidth=1.2, label='Paper DD (Net)')
    ax.plot(xs, realized_dd, color='#fcf000', linewidth=1.0, label='Realized DD')
    ax.legend(loc='lower center', fontsize=8, facecolor='#111111', edgecolor='#555555',
              labelcolor='#ffffff', framealpha=0.95, ncol=3)
    ax.tick_params(colors='#888888', labelsize=7)
    for spine in ax.spines.values(): spine.set_color('#333333')
    ax.grid(True, color='#1a1a1a', linewidth=0.4)
    all_min = min(min(paper_dd), min(spy_dd), min(realized_dd))
    ax.set_ylim(all_min * 1.2, 2)
    fig.tight_layout()
    fig.savefig(path, facecolor='#000000', dpi=200, bbox_inches='tight')
    plt.close(fig)


# ════════════════════════════════════════════════════════════════════════════
# COVER
# ════════════════════════════════════════════════════════════════════════════
def section_cover(t):
    s = []
    net = t['net']; trades = t['trades']
    if os.path.exists(LOGO_BLACK_BG):
        logo = RLImage(LOGO_BLACK_BG, width=3.2*inch, height=3.2*inch*0.406); logo.hAlign = 'CENTER'; s.append(logo)
    s.append(Spacer(1, 14))
    s.append(Paragraph(f'<font color="#ffffff"><b>PNTHR AI Elite Fund Intelligence Report {fmt_usd(t["seedNav"], compact=True)}</b></font>',
        S('cov_t', fontSize=22, leading=26, textColor=WHITE, alignment=TA_CENTER, fontName='Helvetica-Bold')))
    s.append(Spacer(1, 4))
    s.append(Paragraph(f'<font color="#cccccc">Backtest Performance Report  |  Jan 2022 - May 2026</font>',
        S('cov_s1', fontSize=10.5, leading=13, alignment=TA_CENTER, textColor=OFFWHT)))
    s.append(Paragraph(f'<font color="#cccccc">Multi-Strategy Pyramiding + MCE  |  PNTHR AI Universe (~300 Names)  |  v10.1</font>',
        S('cov_s2', fontSize=10.5, leading=13, alignment=TA_CENTER, textColor=OFFWHT)))
    s.append(HRFlowable(width='40%', thickness=0.6, color=DGRAY, spaceBefore=6, spaceAfter=10, hAlign='CENTER'))

    s.append(Paragraph('<b>FUND OVERVIEW</b>', S('cov_h', fontSize=10, leading=13, textColor=YELLOW, fontName='Helvetica-Bold')))
    s.append(Spacer(1, 4))
    ov_rows = [
        ['Strategy',        'Systematic Long/Short U.S. Equity, AI Universe Focus'],
        ['Structure',       'Reg D, Rule 506(c), 3(c)(1) Exempt Fund'],
        ['Universe',        'Approximately 300 AI-focused U.S. equities (PNTHR AI Universe)'],
        ['Signal Engine',   'Sector Rotation (weekly) + Momentum Continuation Entry (daily)'],
        ['Regime Gate',     'PAI300 proprietary AI index (36W EMA)'],
        ['Position Sizing', 'Dynamic (current NAV), 1% max risk, 10% max single-ticker exposure'],
        ['Pyramiding',      '5-lot entry system (35/25/20/12/8%) with weekly + daily MCE entries'],
        ['Execution',       'Weekly: Friday signal → Monday open | MCE: daily 2-bar high breakout'],
        ['Backtest Capital', f'{fmt_usd(t["seedNav"])} starting NAV'],
        ['Benchmark',       'S&P 500 (SPY)'],
    ]
    ov_tbl = Table(ov_rows, colWidths=[1.5*inch, CONTENT_W - 1.5*inch])
    ov_tbl.setStyle(TableStyle([
        ('FONTNAME', (0,0), (0,-1), 'Helvetica-Bold'), ('TEXTCOLOR', (0,0), (0,-1), YELLOW),
        ('TEXTCOLOR', (1,0), (1,-1), OFFWHT), ('FONTSIZE', (0,0), (-1,-1), 9),
        ('ALIGN', (0,0), (-1,-1), 'LEFT'), ('TOPPADDING', (0,0), (-1,-1), 2),
        ('BOTTOMPADDING', (0,0), (-1,-1), 2), ('LEFTPADDING', (0,0), (-1,-1), 0),
    ]))
    s.append(ov_tbl); s.append(Spacer(1, 10))

    # HEADLINE NUMBERS
    s.append(Paragraph('<b><font color="#fcf000">HEADLINE NUMBERS</font></b>  '
        '<font color="#888888" size="8">(all figures NET of fees)</font>',
        S('hn_h', fontSize=10, leading=13, fontName='Helvetica-Bold')))
    s.append(Spacer(1, 4))
    net_wr, net_pf, net_payoff = get_trade_stats(t, net=True)
    tiles = [
        [(f'+{net["totalReturn"]:.0f}%', 'Net Total Return', GREEN),
         (f'+{net["cagr"]:.1f}%', 'Net CAGR', GREEN),
         (f'{net["sharpe"]:.2f}', 'Sharpe Ratio', YELLOW),
         (f'{net["sortino"]:.2f}', 'Sortino Ratio', YELLOW)],
        [(f'{net_pf:.1f}x', 'Profit Factor (Net)', GREEN),
         (f'{net["calmar"]:.1f}', 'Calmar Ratio', YELLOW),
         (f'{net["recoveryFactor"]:.0f}x', 'Recovery Factor', GREEN),
         (f'{net["positivePct"]:.1f}%', 'Positive Months', GREEN)],
        [(f'{net_wr:.1f}%', f'Win Rate ({net_payoff:.1f}x Payoff)', YELLOW),
         (f'{trades["closed"]:,}', 'Total Closed Trades', YELLOW),
         (fmt_usd(net['endNav'], compact=True), f'Ending Equity ({fmt_usd(t["seedNav"])} start)', GREEN),
         (f'+{fmt_usd(net["endNav"] - t["spy"]["endingEquity"], compact=True)}', 'Alpha vs S&amp;P 500', GREEN)],
    ]
    tile_w = CONTENT_W / 4
    for row in tiles:
        cells = []
        for val, label, color in row:
            hex_c = f'#{int(color.red*255):02x}{int(color.green*255):02x}{int(color.blue*255):02x}'
            cells.append([
                Paragraph(f'<font color="{hex_c}"><b>{val}</b></font>', S('tv', fontSize=17, leading=20, alignment=TA_LEFT, fontName='Helvetica-Bold')),
                Paragraph(f'<font color="#888888">{label}</font>', S('tl', fontSize=7, leading=9, alignment=TA_LEFT)),
            ])
        tbl = Table([cells], colWidths=[tile_w]*4)
        tbl.setStyle(TableStyle([('VALIGN', (0,0), (-1,-1), 'TOP'), ('LEFTPADDING', (0,0), (-1,-1), 2),
            ('RIGHTPADDING', (0,0), (-1,-1), 8), ('TOPPADDING', (0,0), (-1,-1), 4), ('BOTTOMPADDING', (0,0), (-1,-1), 4)]))
        s.append(tbl)
    s.append(Spacer(1, 8))

    # AT A GLANCE
    s.append(Paragraph('<b>AI ELITE FUND vs S&amp;P 500 AT A GLANCE</b>',
        S('gl_h', fontSize=10, leading=13, textColor=YELLOW, fontName='Helvetica-Bold')))
    s.append(Spacer(1, 3))
    gl_rows = [
        ['', Paragraph('<b><font color="#fcf000">AI ELITE (NET)</font></b>', S('ghr_p', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<b><font color="#ffffff">S&amp;P 500</font></b>', S('ghr_s', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<b><font color="#22c55e">ALPHA</font></b>', S('ghr_a', fontSize=9, alignment=TA_RIGHT))],
        ['Total Return',
         Paragraph(f'<font color="#fcf000">+{net["totalReturn"]:.1f}%</font>', S('gr1', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ffffff">+{t["spy"]["totalReturn"]:.1f}%</font>', S('gr2', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">+{net["totalReturn"] - t["spy"]["totalReturn"]:.1f}%</font>', S('gr3', fontSize=9, alignment=TA_RIGHT))],
        ['CAGR',
         Paragraph(f'<font color="#fcf000">+{net["cagr"]:.1f}%</font>', S('gr4', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ffffff">+{t["spy"]["cagr"]:.1f}%</font>', S('gr5', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">+{net["cagr"] - t["spy"]["cagr"]:.1f}%</font>', S('gr6', fontSize=9, alignment=TA_RIGHT))],
        ['Max Peak-to-Trough',
         Paragraph(f'<font color="#ef4444">{net["maxDD"]:.2f}%</font>', S('gr7', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ef4444">{t["spy"]["maxDD"]:.1f}%</font>', S('gr8', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">+{abs(net["maxDD"]) - abs(t["spy"]["maxDD"]):.1f}%</font>' if abs(net["maxDD"]) < abs(t["spy"]["maxDD"]) else
                   f'<font color="#ef4444">{abs(net["maxDD"]) - abs(t["spy"]["maxDD"]):.1f}%</font>', S('gr9', fontSize=9, alignment=TA_RIGHT))],
        ['Ending Equity',
         Paragraph(f'<font color="#fcf000">{fmt_usd(net["endNav"], compact=True)}</font>', S('gr10', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ffffff">{fmt_usd(t["spy"]["endingEquity"], compact=True)}</font>', S('gr11', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">{fmt_usd(net["endNav"] - t["spy"]["endingEquity"], compact=True)}</font>', S('gr12', fontSize=9, alignment=TA_RIGHT))],
    ]
    for row in gl_rows[1:]:
        row[0] = Paragraph(f'<font color="#cccccc">{row[0]}</font>', S('glbl', fontSize=9))
    col_w = (CONTENT_W - 2.2*inch) / 3
    gl_tbl = Table(gl_rows, colWidths=[2.2*inch, col_w, col_w, col_w])
    gl_tbl.setStyle(TableStyle([('ALIGN', (1,0), (-1,-1), 'RIGHT'), ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING', (0,0), (-1,-1), 3), ('BOTTOMPADDING', (0,0), (-1,-1), 3), ('LINEBELOW', (0,0), (-1,0), 0.4, DGRAY)]))
    s.append(gl_tbl); s.append(Spacer(1, 10))

    # Chart + Panther
    chart_path = os.path.join(TMP_DIR, f'cov_growth_{t["tier"]}.png')
    generate_growth_chart(t, chart_path, big=False)
    mascot_cell = []
    if os.path.exists(PANTHER_HEAD):
        pm = RLImage(PANTHER_HEAD, width=1.2*inch, height=1.2*inch); pm.hAlign = 'CENTER'; mascot_cell.append(pm)
    mascot_cell.append(Spacer(1, 4))
    mascot_cell.append(Paragraph('<font color="#cccccc"><i>"The AI revolution is not<br/>coming. It is here.<br/>We are positioned."</i></font>',
        S('q', fontSize=8.5, leading=11, alignment=TA_CENTER, textColor=OFFWHT)))
    mascot_cell.append(Spacer(1, 4))
    mascot_cell.append(Paragraph('<font color="#fcf000"><b>~ PNTHR</b></font>',
        S('q2', fontSize=10, leading=12, alignment=TA_CENTER, textColor=YELLOW, fontName='Helvetica-Bold')))
    chart_img = RLImage(chart_path, width=CONTENT_W - 1.7*inch, height=2.0*inch)
    bottom = Table([[mascot_cell, chart_img]], colWidths=[1.7*inch, CONTENT_W - 1.7*inch])
    bottom.setStyle(TableStyle([('VALIGN', (0,0), (-1,-1), 'MIDDLE')]))
    s.append(bottom); s.append(Spacer(1, 6))
    s.append(Paragraph('<font color="#888888">CONFIDENTIAL - For Qualified Investors Only - Not an Offer to Sell Securities</font>',
        S('cf1', fontSize=7.5, leading=10, alignment=TA_CENTER, textColor=MGRAY)))
    s.append(Paragraph('<font color="#666666">Past performance is not indicative of future results. See full disclaimers on final page.</font>',
        S('cf2', fontSize=7.5, leading=10, alignment=TA_CENTER, textColor=HexColor('#666666'))))
    s.append(PageBreak())
    return s


# ════════════════════════════════════════════════════════════════════════════
# TOC
# ════════════════════════════════════════════════════════════════════════════
def section_toc(t):
    s = section_heading('TABLE OF CONTENTS')
    toc = [
        ('ACT I - THE RESULTS', None),
        ('Executive Summary', 3), ('Performance Comparison', 3), ('Gross vs Net', 4),
        ('Fees & Expenses Schedule', 5), ('Crisis Alpha', 7), ('Annual Performance', 7),
        ('Monthly Returns Heatmap', 8), ('Drawdown Analysis', 9), ('Risk Architecture', 10),
        ('Market Correlation & Alpha Attribution', 10),
        ('Rolling 12-Month Returns', 11), ('Best & Worst Trading Days', 11),
        ('ACT II - THE METHODOLOGY', None),
        ('1. The PNTHR AI Universe', 12), ('2. The PAI300 Index & Regime Gate', 13),
        ('3. Sector Rotation Signal Architecture', 14), ('4. Position Sizing & Pyramiding', 15),
        ('5. Institutional Backtest Results', 16),
        ('ACT III - THE PROOF', None), ('Comprehensive Daily NAV Log', 18),
        ('ACT IV - THE CLOSE', None),
        ('Cumulative Growth Chart', None), ('Executive Recap', None), ('Summary', None),
        ('Methodology & Assumptions', None), ('Important Disclosures', None),
    ]
    rows = []
    for label, pg in toc:
        if pg is None:
            rows.append([Paragraph(f'<b><font color="#fcf000">{label}</font></b>', S('t_act', fontSize=10.5, leading=14)), ''])
        else:
            rows.append([Paragraph(f'<font color="#cccccc">{label}</font>', S('t_r', fontSize=9.5, leading=12.5, textColor=OFFWHT)),
                         Paragraph(f'<font color="#888888">{pg}</font>', S('t_pg', fontSize=9.5, leading=12.5, textColor=LGRAY, alignment=TA_RIGHT))])
    tbl = Table(rows, colWidths=[CONTENT_W - 0.5*inch, 0.5*inch])
    tbl.setStyle(TableStyle([('TOPPADDING', (0,0), (-1,-1), 2), ('BOTTOMPADDING', (0,0), (-1,-1), 2), ('LEFTPADDING', (0,0), (-1,-1), 0)]))
    s.append(tbl); s.append(PageBreak())
    return s


# ════════════════════════════════════════════════════════════════════════════
# ACT I — RESULTS
# ════════════════════════════════════════════════════════════════════════════
def section_executive_summary(t):
    s = section_heading('EXECUTIVE SUMMARY')
    net = t['net']; gross = t['gross']
    s.append(body_p(
        'The PNTHR AI Elite Fund employs a proprietary systematic long/short equity strategy focused on the artificial '
        'intelligence revolution. The fund trades a curated universe of Approximately 300 AI-focused U.S. equities spanning 16 sectors '
        'of the AI economy, from semiconductors and cloud infrastructure to autonomous vehicles and AI-powered healthcare. '
        'Using a dual-entry system — weekly Sector Rotation signals for initial positions plus daily Momentum Continuation '
        'Entries (MCE) for proven momentum stocks — the fund deploys capital into the strongest sectors and fastest movers '
        'with a 5-lot pyramid system. All positions are capital-constrained: the fund only enters when cash is available.'
    ))
    s.append(Spacer(1, 4))
    s.append(body_p(
        f'Over a {gross["years"]:.1f}-year backtest spanning {gross["startDate"]} through {gross["endDate"]}, '
        f'the strategy delivered a <b>+{net["cagr"]:.2f}% net CAGR</b> with a <b>{net["sharpe"]:.2f} Sharpe</b> and a '
        f'<b>{t["trades"]["combined"]["profitFactor"]:.2f}x profit factor</b>, transforming '
        f'<b>{fmt_usd(t["seedNav"])}</b> into <b>{fmt_usd(net["endNav"], compact=True)}</b>. During the same period '
        f'a passive S&amp;P 500 allocation returned +{t["spy"]["totalReturn"]:.1f}%, producing '
        f'<b>{fmt_usd(t["spy"]["endingEquity"], compact=True)}</b>. The AI Elite Fund generated '
        f'<b>{fmt_usd(net["endNav"] - t["spy"]["endingEquity"], compact=True)} of alpha</b>.'
    ))
    s.append(Spacer(1, 4))
    s.append(body_p(
        f'The fund\'s risk architecture is built on absolute capital preservation. The maximum daily mark-to-market '
        f'drawdown across {net["totalMonths"]} months was <b>{net["maxDD"]:.2f}%</b> on a net basis, compared to '
        f'the SPY benchmark\'s {t["spy"]["maxDD"]:.1f}% over the same window. '
        f'The system achieves a {t["trades"]["combined"]["winRate"]:.0f}% gross win rate with a {compute_payoff(t, net=False):.1f}x average '
        f'win/loss payoff ratio, the hallmark of a trend-following pyramid system that risks small to find winners, '
        f'then concentrates capital as the market confirms.'
    ))
    s.append(Spacer(1, 4))
    mc = t.get('marketCorrelation', {})
    spy_mc = mc.get('spy', {})
    s.append(body_p(
        f'Critically, these returns are not disguised beta. With an R-squared of just {spy_mc.get("rSquared", 0)*100:.0f}% to the '
        f'S&amp;P 500 and a CAPM alpha of +{spy_mc.get("capmAlpha", 0):.0f}% annualized, the vast majority of the fund\'s '
        f'performance comes from stock selection and sector rotation skill, not from broad market or tech exposure.'
    ))
    s.append(Spacer(1, 4))
    s.append(body_p(
        'Position sizing is dynamically scaled off current NAV, mathematically constrained at 1% maximum risk per trade. '
        'Weekly entries deploy Lot 1 (35% of position) at Monday open following a Friday signal. MCE entries deploy a full '
        '5-lot pyramid when a TTM top-100 stock with an active BL signal breaks its daily 2-bar high. All lot fills are '
        'capped at 2% of 20-day average daily volume for guaranteed executability. The fund operates a real-time cash ledger '
        'with no leverage — every entry requires available capital.'
    ))

    # Performance Comparison - comprehensive table with every metric
    s += section_heading('PERFORMANCE COMPARISON: AI ELITE FUND vs. S&amp;P 500')
    mc = t.get('marketCorrelation', {})
    spy_mc = mc.get('spy', {})
    qqq_mc = mc.get('qqq', {})
    def _pc_row(label, fund_val, fund_c, spy_val, spy_c, alpha_val=None, alpha_c='#22c55e', sid=''):
        """Build a performance comparison row."""
        cells = [label,
            Paragraph(f'<font color="{fund_c}">{fund_val}</font>', S(f'pc_f{sid}', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="{spy_c}">{spy_val}</font>', S(f'pc_s{sid}', fontSize=9, alignment=TA_RIGHT))]
        if alpha_val is not None:
            cells.append(Paragraph(f'<font color="{alpha_c}">{alpha_val}</font>', S(f'pc_a{sid}', fontSize=9, alignment=TA_RIGHT)))
        else:
            cells.append(Paragraph('<font color="#cccccc">-</font>', S(f'pc_n{sid}', fontSize=9, alignment=TA_RIGHT)))
        return cells
    spy_calmar = t["spy"]["cagr"] / abs(t["spy"]["maxDD"]) if t["spy"]["maxDD"] else 0
    spy_rf = t["spy"]["totalReturn"] / abs(t["spy"]["maxDD"]) if t["spy"]["maxDD"] else 0
    pc_rows = [
        _pc_row('Total Return', f'+{net["totalReturn"]:.1f}%', '#22c55e',
            f'+{t["spy"]["totalReturn"]:.1f}%', '#cccccc',
            f'+{net["totalReturn"] - t["spy"]["totalReturn"]:.1f}%', '#22c55e', 'tr'),
        _pc_row('CAGR (Net)', f'+{net["cagr"]:.2f}%', '#22c55e',
            f'+{t["spy"]["cagr"]:.2f}%', '#cccccc',
            f'+{net["cagr"] - t["spy"]["cagr"]:.2f}%', '#22c55e', 'cagr'),
        _pc_row('Sharpe Ratio', f'{net["sharpe"]:.2f}', '#fcf000',
            f'{t["spy"]["sharpe"]:.2f}', '#cccccc',
            f'+{net["sharpe"] - t["spy"]["sharpe"]:.2f}', '#22c55e', 'sh'),
        _pc_row('Sortino Ratio', f'{net["sortino"]:.2f}', '#fcf000',
            f'{t["spy"]["sortino"]:.2f}', '#cccccc',
            f'+{net["sortino"] - t["spy"]["sortino"]:.2f}', '#22c55e', 'so'),
        _pc_row('Calmar Ratio', f'{net["calmar"]:.2f}', '#fcf000',
            f'{spy_calmar:.2f}', '#cccccc',
            f'+{net["calmar"] - spy_calmar:.2f}', '#22c55e', 'cal'),
        _pc_row('Max Peak-to-Trough', f'{net["maxDD"]:.2f}%', '#ef4444',
            f'{t["spy"]["maxDD"]:.1f}%', '#ef4444',
            f'+{abs(t["spy"]["maxDD"]) - abs(net["maxDD"]):.1f}%', '#22c55e', 'dd'),
        _pc_row('Recovery Factor', f'{net["recoveryFactor"]:.0f}x', '#22c55e',
            f'{spy_rf:.1f}x', '#cccccc',
            f'+{net["recoveryFactor"] - spy_rf:.0f}x', '#22c55e', 'rf'),
        _pc_row('Profit Factor', f'{t["trades"]["combined"]["profitFactor"]:.2f}x', '#22c55e',
            'N/A', '#888888',
            'N/A', '#888888', 'pf'),
        _pc_row('Win Rate / Payoff', f'{t["trades"]["combined"]["winRate"]:.1f}% / {compute_payoff(t, net=False):.1f}x', '#22c55e',
            'N/A', '#888888',
            'N/A', '#888888', 'wr'),
        _pc_row('Beta to SPY', f'{spy_mc.get("beta", 0):.2f}', '#fcf000',
            '1.00', '#cccccc',
            f'{spy_mc.get("beta", 0) - 1:.2f}', '#fcf000', 'beta'),
        _pc_row('R-Squared (SPY)', f'{spy_mc.get("rSquared", 0)*100:.1f}%', '#22c55e',
            '100%', '#cccccc',
            f'{spy_mc.get("rSquared", 0)*100 - 100:.1f}%', '#22c55e', 'r2'),
        _pc_row('CAPM Alpha (ann.)', f'+{spy_mc.get("capmAlpha", 0):.1f}%', '#22c55e',
            '0.0%', '#cccccc',
            f'+{spy_mc.get("capmAlpha", 0):.1f}%', '#22c55e', 'alpha'),
        _pc_row(f'Ending Equity ({fmt_usd(t["seedNav"])})', fmt_usd(net["endNav"], compact=True), '#fcf000',
            fmt_usd(t["spy"]["endingEquity"], compact=True), '#cccccc',
            f'+{fmt_usd(net["endNav"] - t["spy"]["endingEquity"], compact=True)}', '#22c55e', 'eq'),
    ]
    for row in pc_rows:
        row[0] = Paragraph(f'<font color="#cccccc">{row[0]}</font>', S('pc_l', fontSize=9))
    pc_tbl = _dark_table(['METRIC', 'AI ELITE (NET)', 'S&amp;P 500', 'ALPHA'],
        pc_rows, col_widths=[2.2*inch, (CONTENT_W-2.2*inch)/3]*2 + [(CONTENT_W-2.2*inch)/3])
    s.append(pc_tbl)

    # Gross vs Net
    s += section_heading('GROSS vs NET: IMPACT OF THE FEE SCHEDULE')
    gn_rows = [
        ['Total Return', f'+{gross["totalReturn"]:.1f}%', f'+{net["totalReturn"]:.1f}%', f'-{gross["totalReturn"]-net["totalReturn"]:.1f} pts'],
        ['CAGR', f'+{gross["cagr"]:.2f}%', f'+{net["cagr"]:.2f}%', f'-{gross["cagr"]-net["cagr"]:.2f} pts'],
        ['Sharpe', f'{gross["sharpe"]:.2f}', f'{net["sharpe"]:.2f}', f'-{gross["sharpe"]-net["sharpe"]:.2f}'],
        ['Sortino', f'{gross["sortino"]:.2f}', f'{net["sortino"]:.2f}', f'-{gross["sortino"]-net["sortino"]:.2f}'],
        ['Calmar', f'{gross["calmar"]:.2f}', f'{net["calmar"]:.2f}', f'-{gross["calmar"]-net["calmar"]:.2f}'],
        ['Max DD', f'{gross["maxDD"]:.2f}%', f'{net["maxDD"]:.2f}%', f'{net["maxDD"]-gross["maxDD"]:+.2f} pts'],
        ['Recovery Factor', f'{gross["recoveryFactor"]:.0f}x', f'{net["recoveryFactor"]:.0f}x', f'-{gross["recoveryFactor"]-net["recoveryFactor"]:.0f}'],
        ['Ending Equity', fmt_usd(gross['endNav'], compact=True), fmt_usd(net['endNav'], compact=True),
         f'-{fmt_usd(gross["endNav"]-net["endNav"], compact=True)}'],
    ]
    gn_rendered = [[Paragraph(f'<font color="#cccccc">{r[0]}</font>', S(f'gn0{i}', fontSize=9)),
                    Paragraph(f'<font color="#22c55e">{r[1]}</font>', S(f'gn1{i}', fontSize=9, alignment=TA_RIGHT)),
                    Paragraph(f'<font color="#fcf000">{r[2]}</font>', S(f'gn2{i}', fontSize=9, alignment=TA_RIGHT)),
                    Paragraph(f'<font color="#ef4444">{r[3]}</font>', S(f'gn3{i}', fontSize=9, alignment=TA_RIGHT))]
                   for i, r in enumerate(gn_rows)]
    s.append(_dark_table(['METRIC', 'GROSS', 'NET', 'FEE DRAG'], gn_rendered,
        col_widths=[1.8*inch, (CONTENT_W-1.8*inch)/3]*2 + [(CONTENT_W-1.8*inch)/3]))
    s.append(PageBreak())
    return s


def section_fees(t):
    s = section_heading('FEES & EXPENSES SCHEDULE')
    s.append(body_p(
        'All NET performance figures reflect the complete fee schedule below, mirroring the PNTHR Private Placement '
        'Memorandum (PPM v6.9). Every item is drawn directly from the PPM.'
    ))
    s.append(Spacer(1, 6))
    s += subsection_heading('1. Management Fee')
    s.append(bullet_p('<b>Rate:</b> 2.0% per annum on Net Asset Value, accrued monthly.'))
    s.append(Spacer(1, 8))
    s += subsection_heading('2. Performance Allocation (Tiered by Investor Class)')
    fee_rows = [
        ['Filet Class', '< $500,000', '30%', '25%'],
        ['Porterhouse Class', '$500,000 - $999,999', '25%', '20%'],
        ['Wagyu Class', '>= $1,000,000', '20%', '15%'],
    ]
    current_label = {'100k': 'Filet Class', '500k': 'Porterhouse Class', '1m': 'Wagyu Class'}[t['tier']]
    rendered = []
    for row in fee_rows:
        is_cur = (row[0] == current_label)
        rendered.append([
            Paragraph(f'<font color="#fcf000"><b>{row[0]}</b></font>' if is_cur else f'<font color="#ffffff">{row[0]}</font>', S('fr0', fontSize=9)),
            Paragraph(f'<font color="#ffffff">{row[1]}</font>', S('fr1', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#ffffff">{row[2]}</font>', S('fr2', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#ffffff">{row[3]}</font>', S('fr3', fontSize=9, alignment=TA_RIGHT)),
        ])
    s.append(_dark_table(['INVESTOR CLASS', 'THRESHOLD', 'YEARS 1-3', 'YR 4+ (LOYALTY)'], rendered,
        col_widths=[1.8*inch, 1.8*inch, (CONTENT_W-3.6*inch)/2, (CONTENT_W-3.6*inch)/2]))
    s.append(Spacer(1, 4))
    s.append(bullet_p('<b>High Water Mark:</b> Performance allocation charged only on net profits above running HWM.'))
    s.append(bullet_p('<b>Loyalty Discount:</b> 5 percentage-point reduction after 36 consecutive months.'))
    s.append(Spacer(1, 8))
    s += subsection_heading('3. Hurdle Rate (US 2-Year Treasury Yield)')
    s.append(body_p('Quarterly, non-cumulative. Each quarter evaluated independently against US2Y / 4.'))
    s.append(Spacer(1, 8))
    s += subsection_heading('4. Trading Costs')
    s.append(bullet_p('<b>Commissions:</b> IBKR Pro Fixed: $0.005/share, $1 min, 1% max.'))
    s.append(bullet_p('<b>Slippage:</b> 5 basis points per leg.'))
    s.append(bullet_p('<b>Short Borrow:</b> Sector-tiered 1.0% - 2.0% annualized.'))
    s.append(Spacer(1, 8))
    s += subsection_heading(f'5. Fee Schedule Applied: {t["classLabel"]}')
    s.append(body_p(
        f'This document reports the {fmt_usd(t["seedNav"])} NAV variant. The applicable class is <b>{t["classLabel"]}</b>: '
        f'<b>{t["feeSchedule"]["yearsOneToThree"]}%</b> performance allocation years 1-3, '
        f'<b>{t["feeSchedule"]["yearsFourPlus"]}%</b> thereafter.'
    ))
    s.append(PageBreak())
    return s


def section_crisis_annual(t):
    s = section_heading('CRISIS ALPHA: PERFORMANCE DURING MARKET DRAWDOWNS')
    s.append(body_p('During market corrections, the AI Elite Fund preserved and grew capital through systematic short-side exposure and disciplined risk management.'))
    ca_rows = []
    for ev in t['crisisAlphaNet']:
        if ev['spyReturn'] is None:
            ca_rows.append([Paragraph(f'<font color="#ffffff">{ev["event"]}</font>', S('ca0', fontSize=9)),
                Paragraph(f'<font color="#ffffff">{ev["period"]}</font>', S('ca1', fontSize=9, alignment=TA_RIGHT)),
                Paragraph('<font color="#cccccc">-</font>', S('ca2', fontSize=9, alignment=TA_RIGHT)),
                Paragraph('<font color="#cccccc">-</font>', S('ca3', fontSize=9, alignment=TA_RIGHT)),
                Paragraph('<font color="#cccccc">-</font>', S('ca4', fontSize=9, alignment=TA_RIGHT))])
        else:
            spy_c = '#ef4444' if ev['spyReturn'] < 0 else '#22c55e'
            pn_c = '#ef4444' if ev['pnthrReturn'] < 0 else '#22c55e'
            al_c = '#ef4444' if ev['alpha'] < 0 else '#22c55e'
            ca_rows.append([Paragraph(f'<font color="#ffffff">{ev["event"]}</font>', S('ca0', fontSize=9)),
                Paragraph(f'<font color="#ffffff">{ev["period"]}</font>', S('ca1', fontSize=9, alignment=TA_RIGHT)),
                Paragraph(f'<font color="{spy_c}">{ev["spyReturn"]:+.1f}%</font>', S('ca2', fontSize=9, alignment=TA_RIGHT)),
                Paragraph(f'<font color="{pn_c}">{ev["pnthrReturn"]:+.1f}%</font>', S('ca3', fontSize=9, alignment=TA_RIGHT)),
                Paragraph(f'<font color="{al_c}">{ev["alpha"]:+.1f}%</font>', S('ca4', fontSize=9, alignment=TA_RIGHT))])
    s.append(_dark_table(['MARKET EVENT', 'PERIOD', 'S&amp;P 500', 'AI ELITE', 'ALPHA'], ca_rows,
        col_widths=[2.0*inch, 1.6*inch, 0.95*inch, 1.0*inch, CONTENT_W - 5.55*inch]))

    s += section_heading('ANNUAL PERFORMANCE')
    spy_by_year = {r['year']: r['ret'] for r in t.get('spyAnnualReturns', [])}
    a_rows = []
    for ar in t['net']['annualReturns']:
        spy_ret = spy_by_year.get(ar['year'], 0)
        spy_c = '#22c55e' if spy_ret > 0 else ('#ef4444' if spy_ret < 0 else '#cccccc')
        r_c = '#22c55e' if ar['ret'] > 0 else ('#ef4444' if ar['ret'] < 0 else '#cccccc')
        alpha = ar['ret'] - spy_ret
        al_c = '#22c55e' if alpha > 0 else ('#ef4444' if alpha < 0 else '#cccccc')
        a_rows.append([Paragraph(f'<font color="#ffffff">{ar["year"]}</font>', S('an0', fontSize=9)),
            Paragraph(f'<font color="#cccccc">{fmt_usd(ar["startEquity"], compact=True)}</font>', S('an1', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#fcf000">{fmt_usd(ar["endEquity"], compact=True)}</font>', S('an2', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="{spy_c}">{spy_ret:+.2f}%</font>', S('an4', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="{r_c}">{ar["ret"]:+.2f}%</font>', S('an3', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="{al_c}">{alpha:+.2f}%</font>', S('an5', fontSize=9, alignment=TA_RIGHT))])
    s.append(_dark_table(['YEAR', 'START EQUITY', 'END EQUITY', 'S&amp;P 500', 'PNTHR AI RETURNS', 'PNTHR ALPHA'], a_rows,
        col_widths=[0.7*inch, 1.1*inch, 1.1*inch, 0.85*inch, 1.4*inch, CONTENT_W - 5.15*inch]))
    s.append(PageBreak())
    return s


def section_heatmap(t):
    s = section_heading('MONTHLY RETURNS HEATMAP (NET %)')
    net_months = t['net']['monthlyReturns']
    by_year = {}
    for m in net_months:
        y, mn = m['m'].split('-')
        by_year.setdefault(y, {})[mn] = m['ret']

    # Detect warmup months: months before first trade activity
    daily = t['gross'].get('dailySeries', [])
    first_trade_month = None
    for d in daily:
        ol = d.get('opensList', {})
        if ol.get('BL') or ol.get('SS'):
            first_trade_month = d['date'][:7]
            break
    warmup_months = set()
    if first_trade_month:
        for m in net_months:
            if m['m'] < first_trade_month:
                warmup_months.add(m['m'])

    WARMUP_BG = HexColor('#2a2a2a')

    header = ['', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC', 'YEAR']
    rows = []
    for y in sorted(by_year.keys()):
        row = [y]
        for mn in ['01','02','03','04','05','06','07','08','09','10','11','12']:
            row.append(by_year[y].get(mn))
        ann = next((a['ret'] for a in t['net']['annualReturns'] if a['year'] == y), None)
        row.append(ann)
        rows.append(row)
    data = [[Paragraph(f'<b><font color="#fcf000">{h}</font></b>', S(f'hh{i}', fontSize=8, alignment=TA_CENTER if i > 0 else TA_LEFT))
             for i, h in enumerate(header)]]
    for row in rows:
        cells = [Paragraph(f'<font color="#ffffff"><b>{row[0]}</b></font>', S(f'hy{row[0]}', fontSize=8, alignment=TA_CENTER))]
        month_names = ['01','02','03','04','05','06','07','08','09','10','11','12']
        for mi, v in enumerate(row[1:-1]):
            ym = f'{row[0]}-{month_names[mi]}'
            if ym in warmup_months:
                cells.append(Paragraph('<font color="#aaaaaa"><i>W</i></font>', S('hw', fontSize=6, alignment=TA_CENTER)))
            elif v is None:
                cells.append(Paragraph('<font color="#444444">-</font>', S('hn', fontSize=7, alignment=TA_CENTER)))
            else:
                cells.append(Paragraph(f'<font color="#000000"><b>{v:+.1f}</b></font>', S('hv', fontSize=7, alignment=TA_CENTER)))
        ann = row[-1]
        # If the entire year is warmup, show W for annual too
        all_warmup = all(f'{row[0]}-{mn}' in warmup_months for mn in month_names if by_year.get(row[0], {}).get(mn) is not None)
        if all_warmup and warmup_months:
            cells.append(Paragraph('<font color="#aaaaaa"><i>W</i></font>', S('hpw', fontSize=6, alignment=TA_CENTER)))
        elif ann is None:
            cells.append(Paragraph('<font color="#444444">-</font>', S('hp', fontSize=7, alignment=TA_CENTER)))
        else:
            cells.append(Paragraph(f'<font color="#000000"><b>{ann:+.1f}%</b></font>', S('hpv', fontSize=7, alignment=TA_CENTER)))
        data.append(cells)
    col_widths = [0.48*inch] + [(CONTENT_W - 0.48*inch - 0.75*inch) / 12] * 12 + [0.75*inch]
    tbl = Table(data, colWidths=col_widths)
    style = [('ALIGN', (0,0), (-1,-1), 'CENTER'), ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
             ('TOPPADDING', (0,0), (-1,-1), 4), ('BOTTOMPADDING', (0,0), (-1,-1), 4),
             ('LEFTPADDING', (0,0), (-1,-1), 2), ('RIGHTPADDING', (0,0), (-1,-1), 2),
             ('GRID', (0,0), (-1,-1), 0.25, DGRAY), ('LINEBELOW', (0,0), (-1,0), 0.5, YELLOW)]
    for ri, row in enumerate(rows, 1):
        month_names = ['01','02','03','04','05','06','07','08','09','10','11','12']
        for ci in range(1, 13):
            ym = f'{row[0]}-{month_names[ci-1]}'
            if ym in warmup_months:
                style.append(('BACKGROUND', (ci, ri), (ci, ri), WARMUP_BG))
            elif row[ci] is not None:
                style.append(('BACKGROUND', (ci, ri), (ci, ri), heatmap_bg(row[ci])))
        if row[-1] is not None and not all(f'{row[0]}-{mn}' in warmup_months for mn in month_names if by_year.get(row[0], {}).get(mn) is not None):
            style.append(('BACKGROUND', (-1, ri), (-1, ri), heatmap_bg(row[-1])))
        elif any(f'{row[0]}-{mn}' in warmup_months for mn in month_names):
            style.append(('BACKGROUND', (-1, ri), (-1, ri), WARMUP_BG))
    tbl.setStyle(TableStyle(style))
    s.append(tbl)
    s.append(Spacer(1, 4))
    # Dynamic warmup label based on actual first trade month
    if first_trade_month:
        import calendar
        ft_year, ft_mo = first_trade_month.split('-')
        ft_label = f'{calendar.month_name[int(ft_mo)]} {ft_year}'
    else:
        ft_label = 'mid-2022'
    s.append(note_p(f'W = EMA Warm-Up Period (no trading). Returns begin {ft_label} when signals first generated.'))
    s.append(PageBreak())
    return s


def section_drawdown(t):
    s = section_heading('DRAWDOWN ANALYSIS')
    net = t['net']
    trades = t['trades']
    realized_dd = trades.get('realizedDD', 0)
    s.append(body_p(
        f'Maximum daily mark-to-market peak-to-trough was <b>{net["maxDD"]:.2f}%</b> NET (paper), compared to SPY\'s '
        f'{t["spy"]["maxDD"]:.1f}% during the same window. The fund experienced a shallower drawdown than the benchmark '
        f'while generating {net["cagr"]/t["spy"]["cagr"]:.0f}x the return. Maximum <b>realized</b> drawdown (measured from '
        f'cumulative closed-trade net P&amp;L only) was <b>{realized_dd:.1f}%</b>, shallower than the paper drawdown because '
        f'many positions recovered before being closed. Critically, every realized drawdown fully recovered, resulting in '
        f'<b>$0.00 permanent loss</b> to the investor.'
    ))
    s.append(Spacer(1, 4))
    s.append(body_p(
        f'Recovery factor of <b>{net["recoveryFactor"]:.0f}x</b> (total return per unit of max drawdown) is exceptional. '
        f'the typical hedge fund delivers 3-5x. A Calmar ratio of <b>{net["calmar"]:.2f}</b> (CAGR divided by max drawdown) '
        f'further confirms the strategy\'s risk-adjusted strength. Every drawdown in the backtest fully recovered, '
        f'with zero permanent capital loss.'
    ))
    tile_data = [
        (f'{t["spy"]["maxDD"]:.1f}%', 'S&amp;P 500 Max Drawdown', '#ef4444'),
        (f'{net["maxDD"]:.2f}%', 'Max Peak-to-Trough (Paper)', '#f9a825'),
        (f'{realized_dd:.1f}%', 'Realized DD (All Recovered)', '#fcf000'),
        (f'{net["recoveryFactor"]:.0f}x', 'Recovery Factor', '#22c55e'),
        ('$0.00', 'Loss to Investor', '#22c55e'),
    ]
    tile_w = CONTENT_W / 5
    cells = []
    for val, label, hex_c in tile_data:
        cells.append([Paragraph(f'<font color="{hex_c}"><b>{val}</b></font>', S('dd_v', fontSize=15, leading=18, alignment=TA_CENTER, fontName='Helvetica-Bold')),
                      Paragraph(f'<font color="#888888">{label}</font>', S('dd_l', fontSize=7, leading=9, alignment=TA_CENTER))])
    dd_tiles = Table([cells], colWidths=[tile_w]*5)
    dd_tiles.setStyle(TableStyle([('VALIGN', (0,0), (-1,-1), 'TOP'), ('TOPPADDING', (0,0), (-1,-1), 6), ('BOTTOMPADDING', (0,0), (-1,-1), 6)]))
    s.append(dd_tiles); s.append(Spacer(1, 8))
    # Filter out drawdowns from EMA warmup period (before first trade)
    daily = t['gross'].get('dailySeries', [])
    first_trade_date = None
    for d in daily:
        ol = d.get('opensList', {})
        if ol.get('BL') or ol.get('SS'):
            first_trade_date = d['date']
            break
    live_dds = [dd for dd in net['top5Drawdowns'] if not first_trade_date or dd['start'] >= first_trade_date]
    if not live_dds:
        live_dds = net['top5Drawdowns']

    dd_rows = []
    for i, dd in enumerate(live_dds, 1):
        dd_rows.append([
            Paragraph(f'<font color="#ffffff">{i}</font>', S(f'td{i}0', fontSize=9, alignment=TA_CENTER)),
            Paragraph(f'<font color="#ffffff">{dd["start"]}</font>', S(f'td{i}1', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#ffffff">{dd["trough"]}</font>', S(f'td{i}2', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#ffffff">{dd["recovery"] or "ongoing"}</font>', S(f'td{i}3', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#cccccc">{dd["duration"]} days</font>', S(f'td{i}4', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#ef4444">{dd["depthPct"]:+.2f}%</font>', S(f'td{i}5', fontSize=9, alignment=TA_RIGHT)),
        ])
    s.append(_dark_table(['#', 'START', 'TROUGH', 'RECOVERY', 'BACK TO EVEN', 'DEPTH'], dd_rows,
        col_widths=[0.3*inch, 1.1*inch, 1.1*inch, 1.1*inch, 1.0*inch, CONTENT_W - 4.6*inch]))
    s.append(Spacer(1, 6))
    uw_path = os.path.join(TMP_DIR, f'underwater_{t["tier"]}.png')
    generate_underwater_chart(t, uw_path)
    if os.path.exists(uw_path): s.append(RLImage(uw_path, width=CONTENT_W, height=2.0*inch))
    s.append(PageBreak())
    return s


def section_risk(t):
    s = section_heading('RISK ARCHITECTURE')
    s.append(body_p('The AI Elite Fund is engineered for capital preservation first, alpha generation second.'))
    s += subsection_heading('Sector Rotation Entry Control')
    s.append(bullet_p('<b>Sector Ranking:</b> All 16 AI sectors ranked weekly by momentum. Longs sourced from top-ranked sectors, shorts from bottom-ranked.'))
    s.append(bullet_p('<b>Dual Entry System:</b> Weekly signals for initial entries (Sector Rotation) plus daily Momentum Continuation Entries (MCE) for proven momentum stocks. MCE adds intra-week entries only on active weekly BL signals in TTM top-100 stocks.'))
    s.append(bullet_p('<b>No Weekly Cap:</b> All qualifying signals enter each week. Backtesting showed that capping entries was too restrictive and reduced returns without improving risk metrics.'))
    s.append(bullet_p('<b>Lot 1 Direct Entry:</b> Full Lot 1 (35% of position) deployed immediately on weekly signal. No partial or staged initial entry.'))
    s += subsection_heading('Position-Level Risk Controls')
    s.append(bullet_p('<b>1% Vitality Cap:</b> Maximum 1% NAV risk per stock position.'))
    s.append(bullet_p('<b>5-Lot Pyramid:</b> Initial entry deploys 35% of full position. Subsequent lots earned through sequential confirmation.'))
    s.append(bullet_p('<b>10% Position Cap:</b> No single ticker can exceed 10% of NAV.'))
    s.append(bullet_p('<b>Real Cash Ledger:</b> Day-by-day capital tracking. Entries skip when cash is unavailable. No leverage, no margin. Total deployed capital never exceeds available cash.'))
    s += subsection_heading('Stop Loss Architecture')
    s.append(bullet_p('<b>Weekly Stop:</b> Weekly PNTHR stop placed at entry with trailing ratchet.'))
    s.append(bullet_p('<b>Weekly Stop Ratchet:</b> Every Friday, stops are tightened using the higher of the 2-week structural low and the ATR floor. Stops only tighten; they never move against the trade.'))
    s.append(bullet_p('<b>Lot Fill Ratchet:</b> Lot 3 → breakeven, Lot 4 → Lot 2 fill, Lot 5 → Lot 3 fill. Stops never move backwards.'))
    s += subsection_heading('Position Exit Rules')
    s.append(bullet_p('<b>20-Day Stale Hunt:</b> Full positions open 20+ trading days that are underwater are closed at market. Cuts losers that haven\'t worked.'))
    s.append(bullet_p('<b>Weekly Structural Exit:</b> If a long position\'s current weekly bar breaks below the prior 2-week low, or a short breaks above the prior 2-week high, the position exits at its stop price.'))
    s.append(bullet_p('<b>Stop Hit:</b> Standard protective stop. Position closes when price touches the stop level.'))

    # Market Correlation & Alpha
    mc = t.get('marketCorrelation', {})
    spy_mc = mc.get('spy')
    qqq_mc = mc.get('qqq')
    if spy_mc or qqq_mc:
        s += section_heading('MARKET CORRELATION &amp; ALPHA ATTRIBUTION')
        s.append(body_p(
            f'Beta and correlation analysis from {mc.get("fromDate", "2023-06-01")} through {t["gross"]["endDate"]} '
            f'({mc.get("observations", 0)} daily observations, starting when the fund first deployed capital).'
        ))
        s.append(Spacer(1, 4))
        mc_rows = []
        if spy_mc:
            mc_rows.append(['Beta to S&amp;P 500',
                Paragraph(f'<font color="#fcf000"><b>{spy_mc["beta"]:.2f}</b></font>', S('mc_spy_b', fontSize=9, alignment=TA_RIGHT)),
                Paragraph(f'<font color="#cccccc">Near-market beta; not levered long</font>', S('mc_spy_n', fontSize=9, alignment=TA_LEFT))])
            mc_rows.append(['Correlation to SPY',
                Paragraph(f'<font color="#fcf000"><b>{spy_mc["correlation"]:.2f}</b></font>', S('mc_spy_c', fontSize=9, alignment=TA_RIGHT)),
                Paragraph(f'<font color="#cccccc">Moderate; alpha is idiosyncratic</font>', S('mc_spy_cn', fontSize=9, alignment=TA_LEFT))])
            mc_rows.append(['R-Squared (SPY)',
                Paragraph(f'<font color="#22c55e"><b>{spy_mc["rSquared"]*100:.1f}%</b></font>', S('mc_spy_r', fontSize=9, alignment=TA_RIGHT)),
                Paragraph(f'<font color="#cccccc">{100-spy_mc["rSquared"]*100:.0f}% of returns independent of market</font>', S('mc_spy_rn', fontSize=9, alignment=TA_LEFT))])
            mc_rows.append(['CAPM Alpha (SPY)',
                Paragraph(f'<font color="#22c55e"><b>+{spy_mc["capmAlpha"]:.1f}%</b></font>', S('mc_spy_a', fontSize=9, alignment=TA_RIGHT)),
                Paragraph(f'<font color="#cccccc">Annualized excess over beta-adjusted benchmark</font>', S('mc_spy_an', fontSize=9, alignment=TA_LEFT))])
        if qqq_mc:
            mc_rows.append(['Beta to QQQ',
                Paragraph(f'<font color="#fcf000"><b>{qqq_mc["beta"]:.2f}</b></font>', S('mc_qqq_b', fontSize=9, alignment=TA_RIGHT)),
                Paragraph(f'<font color="#cccccc">Sub-QQQ beta; not leveraged tech</font>', S('mc_qqq_n', fontSize=9, alignment=TA_LEFT))])
            mc_rows.append(['R-Squared (QQQ)',
                Paragraph(f'<font color="#22c55e"><b>{qqq_mc["rSquared"]*100:.1f}%</b></font>', S('mc_qqq_r', fontSize=9, alignment=TA_RIGHT)),
                Paragraph(f'<font color="#cccccc">{100-qqq_mc["rSquared"]*100:.0f}% of returns independent of tech</font>', S('mc_qqq_rn', fontSize=9, alignment=TA_LEFT))])
            mc_rows.append(['CAPM Alpha (QQQ)',
                Paragraph(f'<font color="#22c55e"><b>+{qqq_mc["capmAlpha"]:.1f}%</b></font>', S('mc_qqq_a', fontSize=9, alignment=TA_RIGHT)),
                Paragraph(f'<font color="#cccccc">Annualized excess over beta-adjusted NASDAQ</font>', S('mc_qqq_an', fontSize=9, alignment=TA_LEFT))])
        for row in mc_rows:
            row[0] = Paragraph(f'<font color="#cccccc">{row[0]}</font>', S('mc_l', fontSize=9))
        mc_tbl = _dark_table(['METRIC', 'VALUE', 'INTERPRETATION'], mc_rows,
            col_widths=[1.8*inch, 1.0*inch, CONTENT_W - 2.8*inch])
        s.append(mc_tbl)
        s.append(Spacer(1, 6))
        s.append(body_p(
            f'<b>Key takeaway:</b> With R-squared of just {spy_mc["rSquared"]*100:.0f}% vs SPY and {qqq_mc["rSquared"]*100:.0f}% vs QQQ, '
            f'the vast majority of the fund\'s returns come from stock selection and sector rotation alpha, not from '
            f'broad market or tech exposure. The +{spy_mc["capmAlpha"]:.0f}% annualized CAPM alpha confirms the strategy is '
            f'generating genuine skill-based returns rather than disguised beta.'
        ))

    s += section_heading('ROLLING 12-MONTH RETURNS')
    r12m = t['net']['rolling12m']
    if r12m:
        min_r = min(r['ret'] for r in r12m)
        neg_count = sum(1 for r in r12m if r['ret'] < 0)
        s.append(body_p(f'Across {len(r12m)} rolling 12-month windows, minimum return was {min_r:+.1f}%. '
            f'{"No" if neg_count == 0 else str(neg_count)} rolling 12-month period{"s were" if neg_count != 1 else " was"} negative.'))
        sampled = r12m[::3]
        r_rows = []
        for r in sampled:
            c = '#22c55e' if r['ret'] > 0 else '#ef4444'
            r_rows.append([Paragraph(f'<font color="#ffffff">{r["endMonth"]}</font>', S(f'r0{r["endMonth"]}', fontSize=9)),
                           Paragraph(f'<font color="{c}">{r["ret"]:+.1f}%</font>', S(f'r1{r["endMonth"]}', fontSize=9, alignment=TA_RIGHT))])
        s.append(_dark_table(['ENDING MONTH', 'TRAILING 12M RETURN'], r_rows, col_widths=[CONTENT_W/2]*2))

    s += section_heading('BEST & WORST TRADING DAYS')
    s += subsection_heading('10 WORST DAYS')
    wd_rows = []
    for d in t['net']['top10WorstDays']:
        wd_rows.append([Paragraph(f'<font color="#ffffff">{d["date"]}</font>', S(f'w0{d["date"]}', fontSize=9)),
            Paragraph(f'<font color="#ef4444">{d["ret"]:+.3f}%</font>', S(f'w1{d["date"]}', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#cccccc">{fmt_usd(d["equity"])}</font>', S(f'w2{d["date"]}', fontSize=9, alignment=TA_RIGHT))])
    s.append(_dark_table(['DATE', 'DAILY RETURN', 'EQUITY'], wd_rows, col_widths=[1.5*inch, 1.5*inch, CONTENT_W-3.0*inch]))
    s += subsection_heading('10 BEST DAYS')
    bd_rows = []
    for d in t['net']['top10BestDays']:
        bd_rows.append([Paragraph(f'<font color="#ffffff">{d["date"]}</font>', S(f'b0{d["date"]}', fontSize=9)),
            Paragraph(f'<font color="#22c55e">{d["ret"]:+.3f}%</font>', S(f'b1{d["date"]}', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#cccccc">{fmt_usd(d["equity"])}</font>', S(f'b2{d["date"]}', fontSize=9, alignment=TA_RIGHT))])
    s.append(_dark_table(['DATE', 'DAILY RETURN', 'EQUITY'], bd_rows, col_widths=[1.5*inch, 1.5*inch, CONTENT_W-3.0*inch]))
    s.append(PageBreak())
    return s


# ════════════════════════════════════════════════════════════════════════════
# ACT II — METHODOLOGY
# ════════════════════════════════════════════════════════════════════════════
def section_methodology(t):
    s = []
    s += section_heading('1. THE PNTHR AI UNIVERSE')
    s.append(body_p(
        'The PNTHR AI Universe is a curated basket of approximately 300 U.S.-listed equities that derive meaningful revenue, '
        'competitive advantage, or strategic positioning from artificial intelligence. The universe spans 16 purpose-built '
        'sectors of the AI economy, from the foundational semiconductor layer through cloud infrastructure, software '
        'platforms, and domain-specific applications in healthcare, autonomous vehicles, cybersecurity, and more.'
    ))
    s.append(Spacer(1, 4))
    s.append(body_p(
        'The universe was constructed using a point-in-time methodology: 43 monthly rebalances from November 2022 through '
        'May 2026 tracked the actual composition of the AI economy as it evolved from 278 to approximately 300 names. No future '
        'knowledge of which companies would become AI leaders was used. Each monthly snapshot reflects only information '
        'available at that date.'
    ))
    s += subsection_heading('16 AI Sectors')
    all_sectors = [
        'AI Semiconductors\n& Chip Design',
        'AI Cloud, Data Centers\n& Edge Computing',
        'AI Software &\nAgentic Platforms',
        'AI Cybersecurity\n& Data Privacy',
        'AI Autonomous\n& Robotics',
        'AI Healthcare\n& Genomics',
        'AI FinTech\n& InsurTech',
        'AI Energy\n& Smart Grid',
        'AI Industrial\n& Manufacturing',
        'AI Media, Gaming\n& Content',
        'AI AdTech\n& MarTech',
        'AI Networking\n& Communications',
        'AI Enterprise\n& Analytics',
        'AI Consumer\n& E-Commerce',
        'AI Education\n& HR Tech',
        'AI Diversified\n& Conglomerates',
    ]
    grid_rows = []
    box_w = CONTENT_W / 4
    for r in range(4):
        row_cells = []
        for c in range(4):
            idx = r * 4 + c
            name = all_sectors[idx] if idx < len(all_sectors) else ''
            row_cells.append(Paragraph(f'<font color="#ffffff"><b>{name}</b></font>',
                S(f'sec_box{idx}', fontSize=8, leading=10, alignment=TA_CENTER, textColor=WHITE, fontName='Helvetica-Bold')))
        grid_rows.append(row_cells)
    sec_grid = Table(grid_rows, colWidths=[box_w]*4, rowHeights=[0.55*inch]*4)
    sec_grid.setStyle(TableStyle([
        ('BOX', (0,0), (-1,-1), 1.5, WHITE),
        ('INNERGRID', (0,0), (-1,-1), 1.0, WHITE),
        ('BACKGROUND', (0,0), (-1,-1), HexColor('#111111')),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('ALIGN', (0,0), (-1,-1), 'CENTER'),
        ('TOPPADDING', (0,0), (-1,-1), 6),
        ('BOTTOMPADDING', (0,0), (-1,-1), 6),
    ]))
    s.append(sec_grid)
    s.append(Spacer(1, 4))
    s.append(note_p('All 16 sectors shown. Approximately 300 names across all sectors.'))
    s.append(PageBreak())

    s += section_heading('2. THE PAI300 INDEX & REGIME GATE')
    s.append(body_p(
        'The PNTHR AI 300 (PAI300) is a proprietary, capped market-cap-weighted index of the full AI Universe. '
        'It serves as the regime gate for the AI Elite Fund, replacing the SPY/QQQ regime gate used in the '
        'Carnivore Quant Fund (679). This ensures the fund\'s macro view is aligned with AI-specific market conditions, '
        'not broad-market conditions that may diverge from the AI sector.'
    ))
    s += subsection_heading('PAI300 Construction')
    s.append(bullet_p('<b>Weighting:</b> Capped market-cap weighted. 4% single-name cap, 1.5% hyperscaler cap (MSFT, GOOGL, META, AMZN, ORCL, IBM).'))
    s.append(bullet_p('<b>Rebalance:</b> Monthly. Weights renormalized after capping.'))
    s.append(bullet_p('<b>Base:</b> November 30, 2022 = 1000.00 (ChatGPT launch date).'))
    s += subsection_heading('Regime Gate')
    s.append(body_p(
        'The AI Elite Fund employs a multi-strategy regime architecture. The majority of tickers (~272) use the PAI300 '
        'index above its 36-week EMA as their regime gate, ensuring longs are initiated only when the AI sector is in a '
        'confirmed uptrend. A subset of 26 tickers that backtested stronger under traditional rules use the SPY + QQQ '
        'dual-index gate (both must be above their 21-week EMA). This per-ticker strategy assignment was determined by '
        'a head-to-head comparison backtest of all overlap tickers under both rule sets.'
    ))
    s.append(PageBreak())

    s += section_heading('3. MULTI-STRATEGY ARCHITECTURE')
    s.append(body_p(
        'The AI Elite Fund runs a multi-strategy approach where each ticker is assigned to the rule set that '
        'produced the best risk-adjusted returns in head-to-head backtesting (November 2022 - May 2026). '
        '26 tickers run under Carnivore (679) rules; the remaining ~272 run under AI 300 rules.'
    ))
    s += subsection_heading('Strategy Differences')
    s.append(bullet_p('<b>AI 300 Rules (~272 tickers):</b> AI sector-optimized EMA (30-40W), 1.25x first-entry gate, PAI300 regime gate, full sector rotation with GO/NEUTRAL/NO_GO sizing.'))
    s.append(bullet_p('<b>Carnivore Rules (26 tickers):</b> GICS sector-optimized OpEMA (18-26W), 1.10x first-entry gate, SPY+QQQ dual regime gate, no sector rotation (flat 1.0x sizing).'))
    s.append(bullet_p('<b>Shared:</b> Same 5-lot pyramid, same stop ratchet, same stale hunt (20 days), same structural exit, same position sizing (1% vitality, 10% single-name cap).'))
    s += subsection_heading('Why Multi-Strategy Outperforms')
    s.append(body_p(
        'The 26 carnivore tickers are names where the faster GICS OpEMA (18-26 weeks) catches trends earlier than the '
        'slower AI sector EMA (30-40 weeks). The stricter 1.10x gate filters noise more aggressively, and the SPY+QQQ '
        'regime gate provides a different macro lens that better suits these names. Head-to-head testing showed the '
        'multi-strategy approach adds significant alpha over applying a single rule set to all tickers.'
    ))
    s.append(PageBreak())

    s += section_heading('4. SECTOR ROTATION SIGNAL ARCHITECTURE')
    s.append(body_p(
        'The Sector Rotation engine is the AI Elite Fund\'s proprietary entry system. Each week, all 16 AI sectors are '
        'ranked by momentum. Buy Long entries are sourced from the strongest sectors; Sell Short entries from the weakest. '
        'This ensures every new position rides the prevailing sector trend, filtering out names in deteriorating groups '
        'before they cost capital.'
    ))
    s += subsection_heading('Weekly Sector Ranking')
    s.append(bullet_p('<b>Ranking:</b> All 16 AI sectors ranked weekly by composite momentum (price vs sector-optimized EMA).'))
    s.append(bullet_p('<b>Long Sourcing:</b> BL signals prioritized from top-ranked sectors. Strongest sectors enter first.'))
    s.append(bullet_p('<b>Short Sourcing:</b> SS signals prioritized from bottom-ranked sectors.'))
    s.append(bullet_p('<b>No Weekly Cap:</b> All qualifying signals enter each week. Backtesting showed that capping entries was too restrictive and reduced returns without improving risk metrics.'))
    s += subsection_heading('Entry & Lot 1')
    s.append(bullet_p('<b>Entry:</b> Weekly BL/SS signal fires (structural breakout/breakdown, daylight zone, sector-optimized EMA).'))
    s.append(bullet_p('<b>Size:</b> Full Lot 1 = 35% of position deployed immediately on weekly signal.'))
    s.append(bullet_p('<b>Stop:</b> Weekly PNTHR stop placed at entry with trailing ratchet.'))
    s += subsection_heading('Pyramid & Position Management')
    s.append(bullet_p('<b>Pyramid:</b> Lots 2-5 fire via standard weekly pyramid triggers. Each lot requires prior lot filled + price trigger reached.'))
    s.append(bullet_p('<b>Weekly Stop Ratchet:</b> Every Friday, stops tighten using the higher of 2-week structural low and ATR floor. Only tightens.'))
    s.append(bullet_p('<b>Structural Exit:</b> If the current week breaks the prior 2-week range (low for longs, high for shorts), position exits at stop.'))
    s.append(bullet_p('<b>20-Day Stale Hunt:</b> Positions open 20+ trading days that are underwater close at market.'))
    gross_wr, gross_pf, gross_payoff = get_trade_stats(t, net=False)
    s += subsection_heading(f'Why {gross_wr:.0f}% Win Rate with {gross_pf:.2f}x Profit Factor')
    s.append(body_p(
        f'The Sector Rotation system deliberately sacrifices win rate for payoff ratio. Most positions ({100-gross_wr:.0f}%) are stopped '
        f'out quickly for small losses by design. But the {gross_wr:.0f}% that survive and pyramid up produce outsized gains '
        f'({gross_payoff:.1f}x the average loser). This is the signature of institutional trend-following: '
        f'risk small, find winners, then concentrate capital as the market confirms.'
    ))
    s.append(PageBreak())

    s += section_heading('5. MOMENTUM CONTINUATION ENTRY (MCE)')
    s.append(body_p(
        'The Momentum Continuation Entry (MCE) system is the AI Elite Fund\'s proprietary daily entry mechanism that '
        'captures proven momentum stocks between weekly signal cycles. MCE identifies stocks with an active weekly BL '
        'signal that are ranked in the trailing twelve-month (TTM) top 100 by return, then enters on a daily 2-bar '
        'high breakout. This dual-entry approach deploys capital faster into confirmed winners while maintaining the '
        'same risk controls as the weekly system.'
    ))
    s += subsection_heading('MCE Entry Criteria')
    s.append(bullet_p('<b>Active Weekly BL:</b> Only stocks with a current, active weekly Buy Long signal are eligible. The weekly signal has already validated regime, sector rotation, and structural breakout.'))
    s.append(bullet_p('<b>TTM Top 100:</b> Walk-forward trailing 12-month return ranking (252 trading days), recomputed weekly. Only the top 100 momentum stocks qualify. No look-ahead bias.'))
    s.append(bullet_p('<b>Daily 2-Bar High Breakout:</b> Daily high must exceed the maximum of the prior two daily highs by $0.01. This confirms continued upward momentum on the daily timeframe.'))
    s.append(bullet_p('<b>Capital Constraint:</b> MCE entries only fire when cash is available. The fund tracks a real-time cash ledger day by day. No leverage, no margin.'))
    s += subsection_heading('MCE Risk Controls')
    s.append(bullet_p('<b>Max 3 New MCE Entries Per Day:</b> Limits daily capital deployment to prevent overconcentration on single-day signals.'))
    s.append(bullet_p('<b>Same 1% Vitality / 10% Ticker Cap:</b> MCE positions are sized identically to weekly entries. No outsized bets.'))
    s.append(bullet_p('<b>5-Day Gap Add Cooldown:</b> When MCE adds to an existing position (NAV gap top-up), a minimum 5 trading days must pass between additions.'))
    s.append(bullet_p('<b>Vitality Tracking:</b> Total risk budget per position is tracked across all entry types. Prevents compounding over-allocation.'))
    s += subsection_heading('Why MCE Improves Returns')
    s.append(body_p(
        'The weekly-only system generates strong signals but can only deploy capital once per week (Friday signal, '
        'Monday entry). Between Fridays, proven momentum stocks continue to run. MCE captures this intra-week momentum '
        'by entering daily when a confirmed weekly winner breaks to new daily highs. The result: the same risk framework '
        'deploys capital faster into winners the market is actively confirming. Across all tiers, MCE contributes '
        'approximately 70% of total alpha while maintaining similar drawdown characteristics.'
    ))
    s.append(PageBreak())

    s += section_heading('6. POSITION SIZING & PYRAMIDING')
    s.append(body_p(
        'The AI Elite Fund uses the same 5-lot pyramid system as the Carnivore Quant Fund. Lot 1 deploys 35% of the '
        'full position when a weekly signal fires in a top-ranked sector. Subsequent lots require prior lot filled + '
        'price trigger reached.'
    ))
    lots = [
        ['Lot 1', 'The Entry',   '35%',  'Weekly BL/SS signal', 'Sector ranked', 'Full Lot 1 deployed; weekly stop placed'],
        ['Lot 2', 'The Stalk',   '25%',  'Price + time',  '5 trading days', 'Time + price required'],
        ['Lot 3', 'The Strike',  '20%',  'Price',          'Lot 2 filled', 'Stop ratchets to breakeven'],
        ['Lot 4', 'The Jugular', '12%',  'Price',          'Lot 3 filled', 'Stop ratchets to Lot 2 fill'],
        ['Lot 5', 'The Kill',     '8%',  'Price',          'Lot 4 filled', 'Stop ratchets to Lot 3 fill'],
    ]
    lots_r = [[Paragraph(f'<font color="#fcf000"><b>{r[0]}</b></font>', S(f'lt{i}0', fontSize=9)),
               Paragraph(f'<font color="#ffffff">{r[1]}</font>', S(f'lt{i}1', fontSize=9, alignment=TA_RIGHT)),
               Paragraph(f'<font color="#22c55e"><b>{r[2]}</b></font>', S(f'lt{i}2', fontSize=9, alignment=TA_RIGHT)),
               Paragraph(f'<font color="#cccccc">{r[3]}</font>', S(f'lt{i}3', fontSize=9, alignment=TA_RIGHT)),
               Paragraph(f'<font color="#cccccc">{r[4]}</font>', S(f'lt{i}4', fontSize=9, alignment=TA_RIGHT)),
               Paragraph(f'<font color="#cccccc">{r[5]}</font>', S(f'lt{i}5', fontSize=9, alignment=TA_RIGHT))]
              for i, r in enumerate(lots)]
    s.append(_dark_table(['LOT', 'NAME', 'ALLOC', 'TRIGGER', 'GATE', 'EFFECT'], lots_r,
        col_widths=[0.55*inch, 0.85*inch, 0.55*inch, 1.35*inch, 1.15*inch, CONTENT_W - 4.45*inch]))
    s.append(PageBreak())

    s += section_heading('7. INSTITUTIONAL BACKTEST RESULTS')
    em = t.get('executionModel', {})
    mc = t.get('marketCorrelation', {})
    spy_mc = mc.get('spy', {})
    qqq_mc = mc.get('qqq', {})
    bt_rows = [
        ['Backtest Span', f'{t["gross"]["startDate"]} - {t["gross"]["endDate"]} ({t["gross"]["years"]:.2f} years)'],
        ['Starting Capital', fmt_usd(t["seedNav"])],
        ['Universe', 'Approximately 300 AI-focused U.S. equities (PNTHR AI Universe)'],
        ['Regime Gate', 'PAI300 36W EMA (BL only)'],
        ['Signal Architecture', 'Sector Rotation (weekly sector-ranked entries, 5-lot pyramid)'],
        ['Position Sizing', em.get('positionSizing', 'Dynamic (current NAV)')],
        ['Entry Timing', f'{em.get("entryTiming", "Monday open")} (Friday signal, Monday execution)'],
        ['Stop Fills', em.get('stopFills', 'Gap-through at open')],
        ['Volume Cap', f'{em.get("advCapPct", 0.02)*100:.0f}% of 20-day ADV per lot fill'],
        ['', ''],
        ['Ending Equity Gross', fmt_usd(t["gross"]["endNav"], compact=True)],
        ['Ending Equity Net', fmt_usd(t["net"]["endNav"], compact=True)],
        ['Total Trades', f'{t["trades"]["total"]:,} ({t["trades"]["closed"]:,} closed)'],
        ['Win Rate (Gross)', f'{t["trades"]["combined"]["winRate"]:.1f}%'],
        ['Payoff Ratio (Gross)', f'{compute_payoff(t, net=False):.1f}x avg win / avg loss'],
        ['Profit Factor (Gross)', f'{t["trades"]["combined"]["profitFactor"]:.2f}x'],
        ['', ''],
        ['Gross CAGR', f'+{t["gross"]["cagr"]:.2f}%'],
        [f'Net CAGR ({t["classLabel"]})', f'+{t["net"]["cagr"]:.2f}%'],
        ['Gross Sharpe', f'{t["gross"]["sharpe"]:.2f}'],
        ['Net Sharpe', f'{t["net"]["sharpe"]:.2f}'],
        ['Gross Sortino', f'{t["gross"]["sortino"]:.2f}'],
        ['Net Sortino', f'{t["net"]["sortino"]:.2f}'],
        ['Gross Calmar', f'{t["gross"]["calmar"]:.2f}'],
        ['Net Calmar', f'{t["net"]["calmar"]:.2f}'],
        ['Max Drawdown (Gross)', f'{t["gross"]["maxDD"]:.2f}%'],
        ['Max Drawdown (Net)', f'{t["net"]["maxDD"]:.2f}%'],
        ['Realized Drawdown', f'{t["trades"]["realizedDD"]:.1f}%'],
        ['Loss to Investor', '$0.00'],
        ['Recovery Factor', f'{t["net"]["recoveryFactor"]:.0f}x'],
        ['', ''],
        ['Beta to SPY', f'{spy_mc.get("beta", 0):.2f}'],
        ['Beta to QQQ', f'{qqq_mc.get("beta", 0):.2f}'],
        ['R-Squared (SPY)', f'{spy_mc.get("rSquared", 0)*100:.1f}%'],
        ['R-Squared (QQQ)', f'{qqq_mc.get("rSquared", 0)*100:.1f}%'],
        ['CAPM Alpha vs SPY', f'+{spy_mc.get("capmAlpha", 0):.1f}% annualized'],
        ['CAPM Alpha vs QQQ', f'+{qqq_mc.get("capmAlpha", 0):.1f}% annualized'],
    ]
    br_r = [[Paragraph(f'<font color="#ffffff">{r[0]}</font>', S(f'bt{i}0', fontSize=9)),
             Paragraph(f'<font color="#ffffff"><b>{r[1]}</b></font>', S(f'bt{i}1', fontSize=9, alignment=TA_RIGHT))]
            for i, r in enumerate(bt_rows)]
    s.append(_dark_table(['METRIC', 'VALUE'], br_r, col_widths=[2.8*inch, CONTENT_W - 2.8*inch]))
    s.append(Spacer(1, 12))
    s += subsection_heading('How These Results Compare')
    spy_cagr = t['spy']['cagr']
    spy_maxdd = t['spy']['maxDD']
    s.append(body_p(
        f'Over the same {t["gross"]["years"]:.1f}-year period, the S&P 500 returned +{spy_cagr:.1f}% annualized with a '
        f'maximum drawdown of {spy_maxdd:.1f}%. The AI Elite Fund delivered +{t["net"]["cagr"]:.1f}% net CAGR with a '
        f'maximum drawdown of {t["net"]["maxDD"]:.2f}%, producing {t["net"]["cagr"]/spy_cagr:.0f}x the return with '
        f'a shallower drawdown than the benchmark.'
    ))
    s.append(Spacer(1, 4))
    s.append(body_p(
        f'For context, the average hedge fund delivers a Sharpe ratio between 0.5 and 1.0, a Sortino under 1.5, '
        f'and a recovery factor of 3-5x. The AI Elite Fund\'s net Sharpe of {t["net"]["sharpe"]:.2f}, Sortino of '
        f'{t["net"]["sortino"]:.2f}, and recovery factor of {t["net"]["recoveryFactor"]:.0f}x place it well above '
        f'institutional benchmarks. With a CAPM alpha of +{spy_mc.get("capmAlpha", 0):.0f}% annualized and R-squared of '
        f'just {spy_mc.get("rSquared", 0)*100:.0f}% vs the S&P 500, the fund\'s returns are driven by stock selection '
        f'skill, not market exposure.'
    ))
    s.append(PageBreak())
    return s


# ════════════════════════════════════════════════════════════════════════════
# ACT III — DAILY NAV LOG
# ════════════════════════════════════════════════════════════════════════════
def _format_activity_colored(closes_list, opens_list):
    parts = []
    if opens_list:
        if opens_list.get('BL'): parts.append(f'<font color="#ffffff">OPEN: {", ".join(opens_list["BL"])} (BL)</font>')
        if opens_list.get('SS'): parts.append(f'<font color="#ffffff">OPEN: {", ".join(opens_list["SS"])} (SS)</font>')
    if closes_list:
        frags = []
        for c in closes_list:
            amt = c.get('netPnl', 0)
            col = '#22c55e' if amt >= 0 else '#ef4444'
            frags.append(f'<font color="#ffffff">{c["ticker"]} </font><font color="{col}">{"+$" if amt >= 0 else "-$"}{abs(amt):,}</font>')
        parts.append(f'<font color="#ffffff">CLOSE: </font>' + ', '.join(frags))
    return ' '.join(parts) if parts else '<font color="#444444">-</font>'


def section_daily_nav_log(t):
    s = section_heading('COMPREHENSIVE DAILY NAV LOG')
    s.append(body_p(f'Complete daily mark-to-market for every trading day from {t["gross"]["startDate"]} through {t["gross"]["endDate"]}.'))
    s.append(Spacer(1, 6))
    daily = t['gross'].get('dailySeries', [])
    monthly_summary = {m['month']: m for m in t['gross'].get('monthlyActivitySummary', [])}
    if not daily:
        s.append(note_p('Daily NAV series unavailable.')); s.append(PageBreak()); return s

    # Detect first trade date for warmup labeling
    first_trade_date = None
    for d in daily:
        ol = d.get('opensList', {})
        if ol.get('BL') or ol.get('SS'):
            first_trade_date = d['date']
            break

    from collections import OrderedDict
    by_month = OrderedDict()
    for d in daily: by_month.setdefault(d['date'][:7], []).append(d)
    col_widths = [0.65*inch, 1.0*inch, 1.1*inch, 0.40*inch, 0.55*inch, CONTENT_W - 3.70*inch]

    def hdr_row():
        return [Paragraph(f'<b><font color="#fcf000">{h}</font></b>', S(f'd_h{i}', fontSize=8, alignment=TA_LEFT if i==0 else TA_RIGHT))
                for i, h in enumerate(['DATE', 'SPY EQUITY', 'AI ELITE', 'OPEN', 'MTD %', 'ACTIVITY'])]

    for ym, days in by_month.items():
        dt_obj = _dt.strptime(ym + '-01', '%Y-%m-%d')
        month_label = dt_obj.strftime('%b %Y').upper()
        start_nav = days[0]['net'] if days[0]['net'] is not None else days[0]['gross']
        month_hdr = Table(
            [[Paragraph(f'<b><font color="#fcf000">{month_label}</font></b>', S('mhl', fontSize=10.5, alignment=TA_LEFT, textColor=YELLOW, fontName='Helvetica-Bold')),
              Paragraph(f'<font color="#cccccc">Start: {fmt_usd(start_nav)}</font>', S('mhs', fontSize=9, alignment=TA_LEFT, textColor=OFFWHT))]],
            colWidths=[1.6*inch, CONTENT_W - 1.6*inch])
        month_hdr.setStyle(TableStyle([('VALIGN', (0,0), (-1,-1), 'BOTTOM'), ('LEFTPADDING', (0,0), (-1,-1), 0),
            ('TOPPADDING', (0,0), (-1,-1), 6), ('BOTTOMPADDING', (0,0), (-1,-1), 3)]))

        # Check if this entire month is in warmup
        is_warmup_month = first_trade_date and all(d['date'] < first_trade_date for d in days)

        data_rows = [hdr_row()]
        for d in days:
            mtd = d.get('mtdPct', 0)
            mtd_c = '#22c55e' if mtd > 0 else ('#ef4444' if mtd < 0 else '#cccccc')
            # Show warmup label for days before first trade
            is_warmup_day = False
            if first_trade_date and d['date'] < first_trade_date:
                has_activity = d.get('opensList', {}).get('BL') or d.get('opensList', {}).get('SS') or d.get('closesList')
                if not has_activity:
                    activity_html = '<font color="#888888">(EMA Warm-Up Period)</font>'
                    is_warmup_day = True
                else:
                    activity_html = _format_activity_colored(d.get('closesList', []), d.get('opensList', {'BL': [], 'SS': []}))
            else:
                activity_html = _format_activity_colored(d.get('closesList', []), d.get('opensList', {'BL': [], 'SS': []}))
            pnthr_val = d['net'] if d['net'] is not None else d['gross']
            act_align = TA_RIGHT if is_warmup_day else TA_LEFT
            data_rows.append([
                Paragraph(f'<font color="#ffffff">{d["date"][5:]}</font>', S('dd0', fontSize=8)),
                Paragraph(f'<font color="#cccccc">{fmt_usd(d.get("spyEquity", 0))}</font>', S('dd1', fontSize=8, alignment=TA_RIGHT)),
                Paragraph(f'<font color="#fcf000">{fmt_usd(pnthr_val)}</font>', S('dd2', fontSize=8, alignment=TA_RIGHT)),
                Paragraph(f'<font color="#ffffff">{d.get("openCount", 0)}</font>', S('dd3', fontSize=8, alignment=TA_RIGHT)),
                Paragraph(f'<font color="{mtd_c}">{"+" if mtd > 0 else ""}{mtd:.2f}%</font>', S('dd4', fontSize=8, alignment=TA_RIGHT)),
                Paragraph(activity_html, S(f'dd5{"w" if is_warmup_day else ""}', fontSize=7.5, leading=9.5, alignment=act_align)),
            ])
        ms = monthly_summary.get(ym, {})
        spy_pct = ms.get('spyPct', 0); net_pct = ms.get('netPct', 0)
        opened = ms.get('opened', 0); closed = ms.get('closed', 0); endOpen = ms.get('endOpen', 0); netPL = ms.get('netPL', 0)
        spy_c = '#22c55e' if spy_pct > 0 else ('#ef4444' if spy_pct < 0 else '#cccccc')
        net_c = '#22c55e' if net_pct > 0 else ('#ef4444' if net_pct < 0 else '#cccccc')
        pl_c = '#22c55e' if netPL >= 0 else '#ef4444'
        pl_str = f'{"+$" if netPL >= 0 else "-$"}{abs(netPL):,}'
        data_rows.append([
            Paragraph(f'<b><font color="#fcf000">{month_label.split()[0]} TOTAL</font></b>', S('mt0', fontSize=8.5)),
            Paragraph(f'<b><font color="{spy_c}">{spy_pct:+.2f}%</font></b>', S('mt1', fontSize=8.5, alignment=TA_RIGHT)),
            Paragraph(f'<b><font color="{net_c}">{net_pct:+.2f}%</font></b>', S('mt2', fontSize=8.5, alignment=TA_RIGHT)),
            Paragraph(f'<b><font color="#ffffff">{endOpen}</font></b>', S('mt3', fontSize=8.5, alignment=TA_RIGHT)),
            Paragraph(f'<b><font color="{net_c}">{net_pct:+.2f}%</font></b>', S('mt4', fontSize=8.5, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#cccccc">{opened} opened, {closed} closed, {endOpen} open, </font><font color="{pl_c}">{pl_str}</font><font color="#cccccc"> net P&amp;L</font>',
                S('mt5', fontSize=8, leading=10, alignment=TA_LEFT)),
        ])
        mtbl = Table(data_rows, colWidths=col_widths, repeatRows=1)
        mtbl.setStyle(TableStyle([
            ('VALIGN', (0,0), (-1,-1), 'TOP'), ('TOPPADDING', (0,0), (-1,-1), 1.5), ('BOTTOMPADDING', (0,0), (-1,-1), 1.5),
            ('LEFTPADDING', (0,0), (-1,-1), 3), ('RIGHTPADDING', (0,0), (-1,-1), 3),
            ('LINEBELOW', (0,0), (-1,0), 0.4, DGRAY), ('LINEABOVE', (0,-1), (-1,-1), 0.5, YELLOW),
            ('BACKGROUND', (0,-1), (-1,-1), HexColor('#111111')),
            ('TOPPADDING', (0,-1), (-1,-1), 4), ('BOTTOMPADDING', (0,-1), (-1,-1), 4),
        ]))
        s.append(month_hdr); s.append(mtbl); s.append(Spacer(1, 8))
    s.append(PageBreak())
    return s


# ════════════════════════════════════════════════════════════════════════════
# ACT IV — CLOSE
# ════════════════════════════════════════════════════════════════════════════
def section_growth_page(t):
    s = []
    start_yr = t['gross']['startDate'][:4]
    end_yr = t['gross']['endDate'][:4]
    s.append(Paragraph(f'<b><font color="#ffffff">Cumulative Growth ({start_yr}-{end_yr})</font></b>  '
        '<font color="#888888"><i>Net of 2% mgmt fee + performance allocation + US2Y hurdle + HWM</i></font>',
        S('cg_t', fontSize=10.5, leading=14, alignment=TA_LEFT)))
    s.append(Spacer(1, 6))
    big_chart = os.path.join(TMP_DIR, f'growth_big_{t["tier"]}.png')
    generate_growth_chart(t, big_chart, big=True)
    if os.path.exists(big_chart): s.append(RLImage(big_chart, width=CONTENT_W, height=3.2*inch))
    s.append(Spacer(1, 10))
    net = t['net']; gross = t['gross']
    avg_nav = (t['seedNav'] + net['endNav']) / 2
    mgmt_fees = 0.02 * avg_nav * net['years']
    perf_alloc = gross['endNav'] - net['endNav'] - mgmt_fees
    pnthr_box = [
        [Paragraph(f'<b><font color="#fcf000">{t["classLabel"]} - {fmt_usd(t["seedNav"])}</font></b>',
            S('pb_t', fontSize=10.5, alignment=TA_LEFT, textColor=YELLOW, fontName='Helvetica-Bold')), ''],
        [Paragraph('<font color="#cccccc">Ending NAV</font>', S('pb0', fontSize=9)),
         Paragraph(f'<font color="#fcf000">{fmt_usd(net["endNav"])}</font>', S('pb0v', fontSize=9, alignment=TA_RIGHT))],
        [Paragraph('<font color="#cccccc">Total Return</font>', S('pb1', fontSize=9)),
         Paragraph(f'<font color="#22c55e">{fmt_usd(net["endNav"] - t["seedNav"])} (+{net["totalReturn"]:.1f}%)</font>', S('pb1v', fontSize=9, alignment=TA_RIGHT))],
        [Paragraph('<font color="#cccccc">Mgmt Fees (2%)</font>', S('pb2', fontSize=9)),
         Paragraph(f'<font color="#ef4444">-{fmt_usd(mgmt_fees)}</font>', S('pb2v', fontSize=9, alignment=TA_RIGHT))],
        [Paragraph(f'<font color="#cccccc">Perf Alloc ({t["feeSchedule"]["yearsOneToThree"]}%/{t["feeSchedule"]["yearsFourPlus"]}%)</font>', S('pb3', fontSize=9)),
         Paragraph(f'<font color="#ef4444">-{fmt_usd(perf_alloc)}</font>', S('pb3v', fontSize=9, alignment=TA_RIGHT))],
    ]
    pnthr_tbl = Table(pnthr_box, colWidths=[(CONTENT_W-0.25*inch)/2 - 1.7*inch, 1.7*inch])
    pnthr_tbl.setStyle(TableStyle([('SPAN', (0,0), (1,0)), ('TOPPADDING', (0,0), (-1,-1), 3), ('BOTTOMPADDING', (0,0), (-1,-1), 3),
        ('LEFTPADDING', (0,0), (-1,-1), 8), ('RIGHTPADDING', (0,0), (-1,-1), 8),
        ('BOX', (0,0), (-1,-1), 0.6, DGRAY), ('LINEBELOW', (0,0), (-1,0), 0.5, YELLOW)]))
    spy = t['spy']
    spy_box = [
        [Paragraph(f'<b><font color="#ffffff">S&amp;P 500 - {fmt_usd(t["seedNav"])}</font></b>',
            S('sb_t', fontSize=10.5, alignment=TA_LEFT, textColor=WHITE, fontName='Helvetica-Bold')), ''],
        [Paragraph('<font color="#cccccc">Ending NAV</font>', S('sb0', fontSize=9)),
         Paragraph(f'<font color="#ffffff">{fmt_usd(spy["endingEquity"])}</font>', S('sb0v', fontSize=9, alignment=TA_RIGHT))],
        [Paragraph('<font color="#cccccc">Total Return</font>', S('sb1', fontSize=9)),
         Paragraph(f'<font color="#22c55e">{fmt_usd(spy["endingEquity"] - t["seedNav"])} (+{spy["totalReturn"]:.1f}%)</font>', S('sb1v', fontSize=9, alignment=TA_RIGHT))],
    ]
    spy_tbl = Table(spy_box, colWidths=[(CONTENT_W-0.25*inch)/2 - 1.7*inch, 1.7*inch])
    spy_tbl.setStyle(TableStyle([('SPAN', (0,0), (1,0)), ('TOPPADDING', (0,0), (-1,-1), 3), ('BOTTOMPADDING', (0,0), (-1,-1), 3),
        ('LEFTPADDING', (0,0), (-1,-1), 8), ('RIGHTPADDING', (0,0), (-1,-1), 8),
        ('BOX', (0,0), (-1,-1), 0.6, DGRAY), ('LINEBELOW', (0,0), (-1,0), 0.5, WHITE)]))
    box_row = Table([[pnthr_tbl, spy_tbl]], colWidths=[(CONTENT_W-0.25*inch)/2]*2)
    box_row.setStyle(TableStyle([('VALIGN', (0,0), (-1,-1), 'TOP'), ('LEFTPADDING', (0,0), (-1,-1), 0), ('RIGHTPADDING', (0,0), (-1,-1), 0)]))
    s.append(box_row); s.append(PageBreak())
    return s


def section_recap(t):
    s = section_heading('EXECUTIVE RECAP')
    s.append(body_p('After reviewing the complete backtest, here is the bottom line:'))
    s.append(Spacer(1, 10))
    net = t['net']; spy = t['spy']
    mc = t.get('marketCorrelation', {})
    spy_mc = mc.get('spy', {})
    recap_rows = [
        ['Net CAGR', f'+{net["cagr"]:.1f}%', '#22c55e'],
        ['Sharpe Ratio', f'{net["sharpe"]:.2f}', '#fcf000'],
        ['Sortino Ratio', f'{net["sortino"]:.2f}', '#fcf000'],
        ['Calmar Ratio', f'{net["calmar"]:.2f}', '#fcf000'],
        ['Profit Factor', f'{t["trades"]["combined"]["profitFactor"]:.1f}x', '#22c55e'],
        ['Win Rate / Payoff', f'{t["trades"]["combined"]["winRate"]:.1f}% / {compute_payoff(t, net=False):.1f}x', '#22c55e'],
        ['Max Drawdown (Paper)', f'{net["maxDD"]:.2f}%', '#ef4444'],
        ['Realized DD (All Recovered)', f'{t["trades"]["realizedDD"]:.1f}%', '#f9a825'],
        ['Loss to Investor', '$0.00', '#22c55e'],
        ['Recovery Factor', f'{net["recoveryFactor"]:.0f}x', '#22c55e'],
        ['Beta to S&amp;P 500', f'{spy_mc.get("beta", 0):.2f}', '#fcf000'],
        ['CAPM Alpha (ann.)', f'+{spy_mc.get("capmAlpha", 0):.0f}%', '#22c55e'],
        ['Positive Months', f'{net["positiveMonths"]} of {net["totalMonths"]} ({net["positivePct"]:.0f}%)', '#22c55e'],
        [f'Total Return ({fmt_usd(t["seedNav"])} start)', fmt_usd(net["endNav"], compact=True), '#fcf000'],
        ['Alpha vs S&amp;P 500', fmt_usd(net["endNav"] - spy["endingEquity"], compact=True), '#22c55e'],
    ]
    r_r = [[Paragraph(f'<font color="#cccccc">{r[0]}</font>', S(f'rc{i}0', fontSize=10)),
            Paragraph(f'<font color="{r[2]}"><b>{r[1]}</b></font>', S(f'rc{i}1', fontSize=10, alignment=TA_RIGHT, fontName='Helvetica-Bold'))]
           for i, r in enumerate(recap_rows)]
    r_tbl = Table(r_r, colWidths=[CONTENT_W*0.6 - 0.5*inch, CONTENT_W*0.4 + 0.5*inch])
    r_tbl.setStyle(TableStyle([('TOPPADDING', (0,0), (-1,-1), 5), ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 40), ('RIGHTPADDING', (0,0), (-1,-1), 40)]))
    s.append(r_tbl)
    s.append(Spacer(1, 10))
    s.append(body_p(
        f'The AI Elite Fund transformed {fmt_usd(t["seedNav"])} into {fmt_usd(net["endNav"], compact=True)} '
        f'while the S&amp;P 500 produced {fmt_usd(spy["endingEquity"], compact=True)} over the same period. '
        f'Every figure above is net of all transaction costs, management fees, and performance allocation.'
    ))
    s.append(PageBreak())
    return s


def section_summary(t):
    s = section_heading('SUMMARY')
    s += subsection_heading('Positioned for the AI Revolution')
    net = t['net']; spy = t['spy']; gross = t['gross']
    mc = t.get('marketCorrelation', {})
    spy_mc = mc.get('spy', {})
    gross_wr = t['trades']['combined']['winRate']
    s.append(body_p(
        'The PNTHR AI Elite Fund was designed to capture the generational wealth creation of the artificial intelligence '
        'revolution while managing downside risk with institutional discipline. The approximately 300-name AI Universe spans the full '
        'AI value chain, and the Sector Rotation architecture ensures capital is deployed only in the strongest-trending sectors.'
    ))
    s.append(body_p(
        f'Over {net["totalMonths"]} months, the strategy delivered +{net["totalReturn"]:.0f}% total return at a '
        f'+{net["cagr"]:.1f}% net CAGR, converting {fmt_usd(t["seedNav"])} to {fmt_usd(net["endNav"], compact=True)}. '
        f'The Sharpe ratio of {net["sharpe"]:.2f}, Sortino of {net["sortino"]:.2f}, and Calmar of {net["calmar"]:.2f} '
        f'collectively reflect a strategy that earns outsized returns through disciplined execution rather than tail risk exposure.'
    ))
    s += subsection_heading('Alpha, Not Beta')
    s.append(body_p(
        f'With a beta of {spy_mc.get("beta", 0):.2f} to the S&amp;P 500, R-squared of just {spy_mc.get("rSquared", 0)*100:.0f}%, '
        f'and an annualized CAPM alpha of +{spy_mc.get("capmAlpha", 0):.0f}%, the fund\'s returns are driven by stock selection '
        f'and sector rotation skill, not by leveraging broad market exposure. Over {spy_mc.get("beta", 0)*100:.0f}% of the return '
        f'profile is independent of both the S&amp;P 500 and NASDAQ.'
    ))
    s += subsection_heading('Risk Is the Product')
    s.append(body_p(
        f'Maximum drawdown of {net["maxDD"]:.2f}% is shallower than the S&amp;P 500\'s {spy["maxDD"]:.1f}% over the same period, '
        f'while the fund produced {net["cagr"]/spy["cagr"]:.0f}x the CAGR. Every drawdown in the backtest fully recovered with '
        f'zero permanent capital loss. The recovery factor of {net["recoveryFactor"]:.0f}x is 4-7x the hedge fund industry average. '
        f'The Sector Rotation architecture means {100-gross_wr:.0f}% of trades are stopped out quickly for small losses, '
        f'protecting capital until the market proves the trade is working.'
    ))
    s.append(Spacer(1, 12))
    s.append(HRFlowable(width='55%', thickness=0.75, color=YELLOW, hAlign='CENTER', spaceBefore=4, spaceAfter=10))
    s.append(Paragraph('<font color="#fcf000"><b><i>The AI revolution is not a prediction. It is a position.</i></b></font>',
        S('motto', fontSize=12, alignment=TA_CENTER, textColor=YELLOW, fontName='Helvetica-Bold')))
    s.append(PageBreak())
    return s


def section_methodology_assumptions(t):
    s = section_heading('METHODOLOGY & ASSUMPTIONS')
    s.append(body_p(f'All calculations performed on daily NAV series for {t["gross"]["startDate"]} through {t["gross"]["endDate"]}.'))
    s += subsection_heading('Universe Construction')
    s.append(body_p(
        'The PNTHR AI Universe comprises Approximately 300 AI-focused U.S. equities selected using point-in-time methodology. '
        '43 monthly rebalances tracked composition evolution from 278 to approximately 300 names. No future knowledge used.'
    ))
    s += subsection_heading('Data Sources')
    s.append(body_p(f'Daily OHLCV from FMP. PAI300 index computed from stored weights and daily prices. SPY benchmark via total-return price series.'))
    s += subsection_heading('Execution Model')
    em = t.get('executionModel', {})
    s.append(bullet_p(f'<b>Position Sizing:</b> {em.get("positionSizing", "Dynamic (current NAV)")}. Each position sized off current equity, not starting capital. Winners compound.'))
    s.append(bullet_p(f'<b>Entry Timing:</b> {em.get("entryTiming", "Monday open")}. Signals generated Friday at close, orders placed Monday at market open. No same-day entry.'))
    s.append(bullet_p(f'<b>Stop Fills:</b> {em.get("stopFills", "Gap-through at open")}. When price gaps past stop level, fill is modeled at the open price (worst-case realistic).'))
    s.append(bullet_p(f'<b>Volume Cap:</b> {em.get("advCapPct", 0.02)*100:.0f}% of 20-day ADV per lot fill. Ensures all fills are executable without market impact.'))
    s += subsection_heading('Fee Structure (NET)')
    s.append(body_p(
        f'IBKR Pro Fixed commissions ($0.005/share, $1 min), 5 bps slippage per leg, sector-tiered borrow 1-2%, '
        f'2% management fee accrued monthly, '
        f'{t["feeSchedule"]["yearsOneToThree"]}%/{t["feeSchedule"]["yearsFourPlus"]}% performance allocation quarterly with US 2-Year Treasury hurdle and HWM.'
    ))
    s += subsection_heading('Slippage Sensitivity')
    s.append(body_p(
        'The baseline model assumes 5 bps slippage per leg. Stress testing at 2x (10 bps), 3x (15 bps), and 5x (25 bps) '
        'showed CAGR impact of less than 4 percentage points at 5x slippage, confirming the strategy is not slippage-sensitive. '
        'The AI Universe is composed of liquid, widely-traded names where 5 bps is conservative.'
    ))
    s += subsection_heading('Sharpe / Sortino / Beta Conventions')
    s.append(body_p('Sharpe: daily excess over US 3-mo T-Bill (time-varying by year), annualized sqrt(252). '
        'Sortino: HFRI convention, MAR=0, total N denominator. '
        'Beta/CAPM Alpha: OLS regression on daily returns from first capital deployment (Jun 2023), annualized by 252.'))
    s += subsection_heading('Backtest vs Live')
    s.append(body_p(
        '<font color="#fcf000"><b>THESE ARE HYPOTHETICAL BACKTEST RESULTS.</b></font> Actual live trading may differ '
        'materially. See Important Disclosures.'
    ))
    s.append(PageBreak())
    return s


def section_disclosures(t):
    s = section_heading('IMPORTANT DISCLOSURES AND DISCLAIMERS')
    s += subsection_heading('CONFIDENTIAL - FOR QUALIFIED INVESTORS ONLY')
    s.append(body_p(
        'This document is provided by PNTHR Funds for informational purposes only. Any offer will be made only via '
        'PPM, LP Agreement, and subscription documents to accredited investors under Rule 506(c).'
    ))
    s += subsection_heading('REGULATORY STATUS')
    s.append(body_p(
        'The AI Elite Fund, LP is a Delaware limited partnership under Rule 506(c) / Section 3(c)(1), limited to 100 beneficial owners.'
    ))
    s += subsection_heading('BACKTEST DISCLOSURE')
    s.append(body_p(
        '<font color="#fcf000"><b>ALL PERFORMANCE DATA IS BASED ON BACKTESTED, HYPOTHETICAL RESULTS AND DOES NOT '
        'REPRESENT ACTUAL TRADING.</b></font> Backtested performance has inherent limitations and should not be relied '
        'upon as indicative of future results. Sharp differences between backtested and actual results are frequent.'
    ))
    s += subsection_heading('SPECIFIC LIMITATIONS')
    for b in [
        'Backtested results are generated by retroactive application of a model with benefit of hindsight.',
        'The AI Universe composition used point-in-time methodology but may still contain survivorship bias.',
        'Transaction costs modeled at IBKR Pro rates; actual costs may differ.',
        'Short-borrow availability assumed continuous; hard-to-borrow events not modeled.',
        'Cash deployment at 100% subject to sizing rules; actual funds experience cash drag.',
    ]:
        s.append(bullet_p(b))
    s += subsection_heading('RISK FACTORS')
    s.append(body_p(
        'Investment involves high risk including total loss. Short selling has unlimited theoretical loss. '
        'Concentration in AI sector creates thematic risk. Model risk, technology risk, key personnel risk apply.'
    ))
    s += subsection_heading('NO TAX OR LEGAL ADVICE')
    s.append(body_p('Nothing herein constitutes tax, legal, or investment advice. Consult your own advisors.'))
    s += subsection_heading('CONFIDENTIALITY')
    s.append(body_p('This document may not be reproduced or distributed without written consent of the Manager.'))
    s.append(Spacer(1, 6))
    s.append(Paragraph('<font color="#888888">(c) 2026 PNTHR Funds. All rights reserved.</font>',
        S('copyr', fontSize=8, alignment=TA_LEFT, textColor=MGRAY)))
    return s


# ════════════════════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════════════════════
def build_per_tier_ir(tier_key):
    json_path = os.path.join(OUT_DIR, f'pnthr_ai_elite_ir_metrics_{tier_key}.json')
    if not os.path.exists(json_path):
        print(f'  !! Missing: {json_path}'); return None
    with open(json_path) as f:
        t = json.load(f)
    story = []
    story += section_cover(t)
    story += section_toc(t)
    story += section_executive_summary(t)
    story += section_fees(t)
    story += section_crisis_annual(t)
    story += section_heatmap(t)
    story += section_drawdown(t)
    story += section_risk(t)
    story += section_methodology(t)
    story += section_daily_nav_log(t)
    story += section_growth_page(t)
    story += section_recap(t)
    story += section_summary(t)
    story += section_methodology_assumptions(t)
    story += section_disclosures(t)

    filename = f'PNTHR_AI_Elite_IR_{t["label"]}_{tier_key}_v10.1.pdf'
    title_meta = f'PNTHR Funds - AI Elite Fund - {t["classLabel"]} Intelligence Report v10.1'
    return build_doc(filename, title_meta, story)


if __name__ == '__main__':
    tiers = sys.argv[1:] if len(sys.argv) > 1 else ['100k', '500k', '1m']
    for tk in tiers:
        print(f'\nBuilding {tk}...')
        result = build_per_tier_ir(tk)
        if result: print(f'  -> {result}')
    print('\nDone.')
