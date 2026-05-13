#!/usr/bin/env python3
"""
generateAiEliteIR.py — PNTHR AI Elite Fund Per-Tier Intelligence Report

Black-background PDF with yellow headings, 4-act structure:
  Act I:   Results (exec summary, perf comp, gross vs net, fees, crisis, annual,
           heatmap, drawdown, risk, rolling, best/worst)
  Act II:  Methodology (AI Universe, PAI300, Daily Cascade, signal gen, sizing)
  Act III: Proof (comprehensive daily NAV log)
  Act IV:  Close (growth chart, recap, summary, methodology & assumptions, disclosures)

Data: ~/Downloads/pnthr_ai_elite_ir_metrics_{100k,500k,1m}.json
Output: ~/Downloads/PNTHR_AI_Elite_IR_{Filet,Porterhouse,Wagyu}_{tier}_v2.pdf
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
    xs = [_dt.strptime(d['date'], '%Y-%m-%d') for d in daily]
    dd = [d['netDD'] if d['netDD'] is not None else d['grossDD'] for d in daily]
    fig, ax = plt.subplots(figsize=(7.0, 2.1), dpi=130)
    fig.patch.set_facecolor('#000000'); ax.set_facecolor('#000000')
    ax.fill_between(xs, dd, 0, color='#fcf000', alpha=0.30)
    ax.plot(xs, dd, color='#fcf000', linewidth=1.0)
    ax.tick_params(colors='#888888', labelsize=7)
    for spine in ax.spines.values(): spine.set_color('#333333')
    ax.grid(True, color='#1a1a1a', linewidth=0.4)
    ax.set_ylim(min(dd) * 1.2, 2)
    fig.tight_layout()
    fig.savefig(path, facecolor='#000000', dpi=130, bbox_inches='tight')
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
    s.append(Paragraph(f'<font color="#cccccc">Backtest Performance Report  |  Nov 2022 - May 2026</font>',
        S('cov_s1', fontSize=10.5, leading=13, alignment=TA_CENTER, textColor=OFFWHT)))
    s.append(Paragraph('<font color="#cccccc">Daily Cascade Pyramiding Strategy  |  PNTHR AI Universe (297 Names)</font>',
        S('cov_s2', fontSize=10.5, leading=13, alignment=TA_CENTER, textColor=OFFWHT)))
    s.append(HRFlowable(width='40%', thickness=0.6, color=DGRAY, spaceBefore=6, spaceAfter=10, hAlign='CENTER'))

    s.append(Paragraph('<b>FUND OVERVIEW</b>', S('cov_h', fontSize=10, leading=13, textColor=YELLOW, fontName='Helvetica-Bold')))
    s.append(Spacer(1, 4))
    ov_rows = [
        ['Strategy',        'Systematic Long/Short U.S. Equity — AI Universe Focus'],
        ['Structure',       'Reg D, Rule 506(c), 3(c)(1) Exempt Fund'],
        ['Universe',        '297 AI-focused U.S. equities (PNTHR AI Universe)'],
        ['Signal Engine',   'Daily Cascade: daily scout → weekly confirmation → 5-lot pyramid'],
        ['Regime Gate',     'PAI300 proprietary AI index (36W EMA)'],
        ['Position Sizing', '1% max risk per trade, 10% max portfolio risk exposure'],
        ['Pyramiding',      '5-lot entry system (35/25/20/12/8%) with daily scout overlay'],
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
    tiles = [
        [(f'+{net["totalReturn"]:.0f}%', 'Net Total Return', GREEN),
         (f'+{net["cagr"]:.1f}%', 'Net CAGR', GREEN),
         (f'{net["sharpe"]:.2f}', 'Sharpe Ratio', YELLOW),
         (f'{net["sortino"]:.2f}', 'Sortino Ratio', YELLOW)],
        [(f'{trades["combined"]["profitFactor"]:.1f}x', 'Profit Factor', GREEN),
         (f'{net["calmar"]:.1f}', 'Calmar Ratio', YELLOW),
         (f'{net["maxDD"]:.2f}%', 'Max Peak-to-Trough', RED),
         (f'{net["positivePct"]:.1f}%', 'Positive Months', GREEN)],
        [(f'25.0%', 'Win Rate (9.5x Payoff)', YELLOW),
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
         Paragraph('<font color="#ffffff">-</font>', S('gr9', fontSize=9, alignment=TA_RIGHT))],
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
        ('Executive Summary', 3), ('Performance Comparison', 3), ('Gross vs Net', 3),
        ('Fees & Expenses Schedule', 4), ('Crisis Alpha', 6), ('Annual Performance', 6),
        ('Monthly Returns Heatmap', 7), ('Drawdown Analysis', 8), ('Risk Architecture', 9),
        ('Rolling 12-Month Returns', 10), ('Best & Worst Trading Days', 10),
        ('ACT II - THE METHODOLOGY', None),
        ('1. The PNTHR AI Universe', 11), ('2. The PAI300 Index & Regime Gate', 12),
        ('3. Daily Cascade Signal Architecture', 13), ('4. Position Sizing & Pyramiding', 14),
        ('5. Institutional Backtest Results', 15),
        ('ACT III - THE PROOF', None), ('Comprehensive Daily NAV Log', 17),
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
        'intelligence revolution. The fund trades a curated universe of 297 AI-focused U.S. equities spanning 16 sectors '
        'of the AI economy, from semiconductors and cloud infrastructure to autonomous vehicles and AI-powered healthcare. '
        'Using the Daily Cascade signal architecture, the system identifies high-conviction entries through daily scout '
        'signals, confirms them with weekly breakout triggers, and pyramids into winners with a 5-lot position system.'
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
        f'The system achieves a 25% win rate with a 9.5x average win/loss payoff ratio — the hallmark of a '
        f'trend-following pyramid system that risks small to find winners, then concentrates capital as the market confirms.'
    ))
    s.append(Spacer(1, 4))
    s.append(body_p(
        'Position sizing is mathematically constrained: each trade risks a maximum of 1% of net asset value. The Daily '
        'Cascade starts with a scout position at just 50% of Lot 1 (0.175% NAV risk). Only when the weekly signal '
        'confirms does the position scale to full Lot 1 and begin the 5-lot pyramid.'
    ))

    # Performance Comparison
    s += section_heading('PERFORMANCE COMPARISON: AI ELITE FUND vs. S&amp;P 500')
    pc_rows = [
        ['Total Return',
         Paragraph(f'<font color="#22c55e">+{net["totalReturn"]:.1f}%</font>', S('p1', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#cccccc">+{t["spy"]["totalReturn"]:.1f}%</font>', S('p2', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">+{net["totalReturn"] - t["spy"]["totalReturn"]:.1f}%</font>', S('p3', fontSize=9, alignment=TA_RIGHT))],
        ['CAGR (Net)',
         Paragraph(f'<font color="#22c55e">+{net["cagr"]:.2f}%</font>', S('p4', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#cccccc">+{t["spy"]["cagr"]:.2f}%</font>', S('p5', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">+{net["cagr"] - t["spy"]["cagr"]:.2f}%</font>', S('p6', fontSize=9, alignment=TA_RIGHT))],
        ['Sharpe Ratio',
         Paragraph(f'<font color="#fcf000">{net["sharpe"]:.2f}</font>', S('p7', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#cccccc">{t["spy"]["sharpe"]:.2f}</font>', S('p8', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">-</font>', S('p9', fontSize=9, alignment=TA_RIGHT))],
        ['Sortino Ratio',
         Paragraph(f'<font color="#fcf000">{net["sortino"]:.2f}</font>', S('p10', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#cccccc">{t["spy"]["sortino"]:.2f}</font>', S('p11', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">-</font>', S('p12', fontSize=9, alignment=TA_RIGHT))],
        ['Max Peak-to-Trough',
         Paragraph(f'<font color="#ef4444">{net["maxDD"]:.2f}%</font>', S('p13', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#ef4444">{t["spy"]["maxDD"]:.1f}%</font>', S('p14', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">-</font>', S('p15', fontSize=9, alignment=TA_RIGHT))],
        ['Profit Factor',
         Paragraph(f'<font color="#22c55e">{t["trades"]["combined"]["profitFactor"]:.2f}x</font>', S('p25', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">N/A</font>', S('p26', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">-</font>', S('p27', fontSize=9, alignment=TA_RIGHT))],
        ['Win Rate / Payoff',
         Paragraph(f'<font color="#22c55e">{t["trades"]["combined"]["winRate"]:.1f}% / 9.5x</font>', S('p22', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">N/A</font>', S('p23', fontSize=9, alignment=TA_RIGHT)),
         Paragraph('<font color="#cccccc">-</font>', S('p24', fontSize=9, alignment=TA_RIGHT))],
        [f'Ending Equity ({fmt_usd(t["seedNav"])})',
         Paragraph(f'<font color="#fcf000">{fmt_usd(net["endNav"], compact=True)}</font>', S('p28', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#cccccc">{fmt_usd(t["spy"]["endingEquity"], compact=True)}</font>', S('p29', fontSize=9, alignment=TA_RIGHT)),
         Paragraph(f'<font color="#22c55e">{fmt_usd(net["endNav"] - t["spy"]["endingEquity"], compact=True)}</font>', S('p30', fontSize=9, alignment=TA_RIGHT))],
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
        ['Max DD', f'{gross["maxDD"]:.2f}%', f'{net["maxDD"]:.2f}%', f'{net["maxDD"]-gross["maxDD"]:+.2f} pts'],
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
    s += subsection_heading('1. Management Fee')
    s.append(bullet_p('<b>Rate:</b> 2.0% per annum on Net Asset Value, accrued monthly.'))
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
    s += subsection_heading('3. Hurdle Rate (US 2-Year Treasury Yield)')
    s.append(body_p('Quarterly, non-cumulative. Each quarter evaluated independently against US2Y / 4.'))
    s += subsection_heading('4. Trading Costs')
    s.append(bullet_p('<b>Commissions:</b> IBKR Pro Fixed: $0.005/share, $1 min, 1% max.'))
    s.append(bullet_p('<b>Slippage:</b> 5 basis points per leg.'))
    s.append(bullet_p('<b>Short Borrow:</b> Sector-tiered 1.0% - 2.0% annualized.'))
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
        for v in row[1:-1]:
            if v is None: cells.append(Paragraph('<font color="#444444">-</font>', S('hn', fontSize=7, alignment=TA_CENTER)))
            else: cells.append(Paragraph(f'<font color="#000000"><b>{v:+.1f}</b></font>', S('hv', fontSize=7, alignment=TA_CENTER)))
        ann = row[-1]
        if ann is None: cells.append(Paragraph('<font color="#444444">-</font>', S('hp', fontSize=7, alignment=TA_CENTER)))
        else: cells.append(Paragraph(f'<font color="#000000"><b>{ann:+.1f}%</b></font>', S('hpv', fontSize=7, alignment=TA_CENTER)))
        data.append(cells)
    col_widths = [0.48*inch] + [(CONTENT_W - 0.48*inch - 0.75*inch) / 12] * 12 + [0.75*inch]
    tbl = Table(data, colWidths=col_widths)
    style = [('ALIGN', (0,0), (-1,-1), 'CENTER'), ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
             ('TOPPADDING', (0,0), (-1,-1), 4), ('BOTTOMPADDING', (0,0), (-1,-1), 4),
             ('LEFTPADDING', (0,0), (-1,-1), 2), ('RIGHTPADDING', (0,0), (-1,-1), 2),
             ('GRID', (0,0), (-1,-1), 0.25, DGRAY), ('LINEBELOW', (0,0), (-1,0), 0.5, YELLOW)]
    for ri, row in enumerate(rows, 1):
        for ci in range(1, 13):
            v = row[ci]
            if v is not None: style.append(('BACKGROUND', (ci, ri), (ci, ri), heatmap_bg(v)))
        if row[-1] is not None: style.append(('BACKGROUND', (-1, ri), (-1, ri), heatmap_bg(row[-1])))
    tbl.setStyle(TableStyle(style))
    s.append(tbl)
    s.append(PageBreak())
    return s


def section_drawdown(t):
    s = section_heading('DRAWDOWN ANALYSIS')
    net = t['net']
    s.append(body_p(f'Maximum daily peak-to-trough was <b>{net["maxDD"]:.2f}%</b> NET — compared to SPY\'s {t["spy"]["maxDD"]:.1f}% during the same window.'))
    tile_data = [
        (f'{net["maxDD"]:.2f}%', 'Max Peak-to-Trough', '#ef4444'),
        (f'{net["timeUnderWater"]:.1f}%', 'Time Under Water', '#f9a825'),
        (f'{net["recoveryFactor"]:.0f}', 'Recovery Factor', '#22c55e'),
        (f'{net["ulcerIndex"]:.2f}', 'Ulcer Index', '#fcf000'),
    ]
    tile_w = CONTENT_W / 4
    cells = []
    for val, label, hex_c in tile_data:
        cells.append([Paragraph(f'<font color="{hex_c}"><b>{val}</b></font>', S('dd_v', fontSize=17, leading=20, alignment=TA_LEFT, fontName='Helvetica-Bold')),
                      Paragraph(f'<font color="#888888">{label}</font>', S('dd_l', fontSize=7, leading=9, alignment=TA_LEFT))])
    dd_tiles = Table([cells], colWidths=[tile_w]*4)
    dd_tiles.setStyle(TableStyle([('VALIGN', (0,0), (-1,-1), 'TOP'), ('TOPPADDING', (0,0), (-1,-1), 6), ('BOTTOMPADDING', (0,0), (-1,-1), 6)]))
    s.append(dd_tiles); s.append(Spacer(1, 8))
    dd_rows = []
    for i, dd in enumerate(net['top5Drawdowns'], 1):
        dd_rows.append([
            Paragraph(f'<font color="#ffffff">{i}</font>', S(f'td{i}0', fontSize=9, alignment=TA_CENTER)),
            Paragraph(f'<font color="#ffffff">{dd["start"]}</font>', S(f'td{i}1', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#ffffff">{dd["trough"]}</font>', S(f'td{i}2', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#ffffff">{dd["recovery"] or "ongoing"}</font>', S(f'td{i}3', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#cccccc">{dd["duration"]} days</font>', S(f'td{i}4', fontSize=9, alignment=TA_RIGHT)),
            Paragraph(f'<font color="#ef4444">{dd["depthPct"]:+.2f}%</font>', S(f'td{i}5', fontSize=9, alignment=TA_RIGHT)),
        ])
    s.append(_dark_table(['#', 'START', 'TROUGH', 'RECOVERY', 'DURATION', 'DEPTH'], dd_rows,
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
    s += subsection_heading('Daily Cascade Risk Control')
    s.append(bullet_p('<b>Scout Entry:</b> 50% of Lot 1 = 0.175% NAV risk per scout. Minimal capital at risk until weekly confirmation.'))
    s.append(bullet_p('<b>Max 3 Scouts Per Day:</b> No more than 3 new scouts can fire on any single trading day.'))
    s.append(bullet_p('<b>28-Day Timeout:</b> Scouts that fail to convert within 28 trading days are automatically closed.'))
    s.append(bullet_p('<b>Same-Week Conversion:</b> Scouts can convert to full positions as soon as a weekly signal confirms — no forced waiting period beyond the signal date.'))
    s.append(bullet_p('<b>Daily Exit Monitoring:</b> Active scouts are closed immediately if a daily reversal signal (BE for longs, SE for shorts) fires.'))
    s += subsection_heading('Position-Level Risk Controls')
    s.append(bullet_p('<b>1% Vitality Cap:</b> Maximum 1% NAV risk per stock position.'))
    s.append(bullet_p('<b>5-Lot Pyramid:</b> Initial entry deploys only 35% of full position. Subsequent lots earned through sequential confirmation.'))
    s.append(bullet_p('<b>10% Position Cap:</b> No single ticker can exceed 10% of NAV.'))
    s.append(bullet_p('<b>Weekly Order Cap:</b> Maximum 10 long entries + 5 short entries per week, ranked by sector strength.'))
    s.append(bullet_p('<b>No-Margin Constraint:</b> Total deployed notional must stay at or below NAV.'))
    s += subsection_heading('Stop Loss Architecture')
    s.append(bullet_p('<b>Scout Stop:</b> Daily PNTHR stop (fixed, no trailing ratchet) — tight risk on unconfirmed positions.'))
    s.append(bullet_p('<b>Weekly Stop:</b> After conversion, switches to weekly PNTHR stop with trailing ratchet.'))
    s.append(bullet_p('<b>Weekly Stop Ratchet:</b> Every Friday, stops are tightened using the higher of the 2-week structural low and the ATR floor. Stops only tighten — they never move against the trade.'))
    s.append(bullet_p('<b>Lot Fill Ratchet:</b> Lot 3 → breakeven, Lot 4 → Lot 2 fill, Lot 5 → Lot 3 fill. Stops never move backwards.'))
    s += subsection_heading('Position Exit Rules')
    s.append(bullet_p('<b>20-Day Stale Hunt:</b> Full positions open 20+ trading days that are underwater are closed at market. Cuts losers that haven\'t worked.'))
    s.append(bullet_p('<b>Weekly Structural Exit:</b> If a long position\'s current weekly bar breaks below the prior 2-week low, or a short breaks above the prior 2-week high, the position exits at its stop price.'))
    s.append(bullet_p('<b>Stop Hit:</b> Standard protective stop — position closes when price touches the stop level.'))

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
        'The PNTHR AI Universe is a curated basket of 297 U.S.-listed equities that derive meaningful revenue, '
        'competitive advantage, or strategic positioning from artificial intelligence. The universe spans 16 purpose-built '
        'sectors of the AI economy, from the foundational semiconductor layer through cloud infrastructure, software '
        'platforms, and domain-specific applications in healthcare, autonomous vehicles, cybersecurity, and more.'
    ))
    s.append(Spacer(1, 4))
    s.append(body_p(
        'The universe was constructed using a point-in-time methodology: 43 monthly rebalances from November 2022 through '
        'May 2026 tracked the actual composition of the AI economy as it evolved from 278 to 297 names. No future '
        'knowledge of which companies would become AI leaders was used — each monthly snapshot reflects only information '
        'available at that date.'
    ))
    s += subsection_heading('16 AI Sectors')
    sectors = [
        ['AI Semiconductors & Chip Design', 'NVDA, AMD, AVGO, MRVL, QCOM...'],
        ['AI Cloud, Data Centers & Edge', 'AMZN, MSFT, GOOGL, EQIX, DLR...'],
        ['AI Software & Agentic Platforms', 'CRM, NOW, PLTR, SNOW, AI...'],
        ['AI Cybersecurity & Data Privacy', 'CRWD, PANW, ZS, FTNT, S...'],
        ['AI Autonomous & Robotics', 'TSLA, ISRG, TER, NXPI...'],
        ['AI Healthcare & Genomics', 'VEEV, DXCM, ILMN, EXAS...'],
        ['AI FinTech & InsurTech', 'SQ, COIN, AFRM, HOOD...'],
        ['AI Energy & Smart Grid', 'ENPH, FSLR, VST, CEG...'],
    ]
    sec_rendered = [[Paragraph(f'<font color="#fcf000">{r[0]}</font>', S(f'sec0{i}', fontSize=9)),
                     Paragraph(f'<font color="#cccccc">{r[1]}</font>', S(f'sec1{i}', fontSize=9, alignment=TA_RIGHT))]
                    for i, r in enumerate(sectors)]
    s.append(_dark_table(['SECTOR', 'REPRESENTATIVE HOLDINGS'], sec_rendered,
        col_widths=[2.8*inch, CONTENT_W - 2.8*inch]))
    s.append(note_p('8 of 16 sectors shown. Full list: 297 names across all 16 sectors.'))
    s.append(PageBreak())

    s += section_heading('2. THE PAI300 INDEX & REGIME GATE')
    s.append(body_p(
        'The PNTHR AI 300 (PAI300) is a proprietary, capped market-cap-weighted index of the full AI Universe. '
        'It serves as the regime gate for the AI Elite Fund — replacing the SPY/QQQ regime gate used in the '
        'Carnivore Quant Fund (679). This ensures the fund\'s macro view is aligned with AI-specific market conditions, '
        'not broad-market conditions that may diverge from the AI sector.'
    ))
    s += subsection_heading('PAI300 Construction')
    s.append(bullet_p('<b>Weighting:</b> Capped market-cap weighted. 4% single-name cap, 1.5% hyperscaler cap (MSFT, GOOGL, META, AMZN, ORCL, IBM).'))
    s.append(bullet_p('<b>Rebalance:</b> Monthly. Weights renormalized after capping.'))
    s.append(bullet_p('<b>Base:</b> November 30, 2022 = 1000.00 (ChatGPT launch date).'))
    s += subsection_heading('Regime Gate')
    s.append(body_p(
        'BL (Buy Long) signals require the PAI300 index to be above its 36-week EMA. This ensures longs are only '
        'initiated when the AI sector is in a confirmed uptrend. SS (Sell Short) signals have NO macro gate in the '
        'AI Elite Fund — the PAI300 was below its 36W EMA only 5.5% of the time (8 out of 145 weeks), making any '
        'SS gate based on it too restrictive.'
    ))
    s.append(PageBreak())

    s += section_heading('3. DAILY CASCADE SIGNAL ARCHITECTURE')
    s.append(body_p(
        'The Daily Cascade is the AI Elite Fund\'s proprietary two-phase entry system. It uses tighter daily signals '
        'as scouts to identify potential setups, then waits for weekly confirmation before committing full capital. '
        'This architecture dramatically reduces drawdown by filtering out false breakouts before they cost meaningful capital.'
    ))
    s += subsection_heading('Phase 1: Daily Scout')
    s.append(bullet_p('<b>Size:</b> 50% of Lot 1 = 17.5% of full position = 0.175% NAV risk.'))
    s.append(bullet_p('<b>Entry:</b> Daily BL/SS signal fires (structural breakout/breakdown, daylight zone, combo filter: 5-15% gap from weekly EMA + 0-50% annualized slope).'))
    s.append(bullet_p('<b>Stop:</b> Daily PNTHR stop (fixed at entry, no trailing ratchet). Tight risk.'))
    s.append(bullet_p('<b>Max Per Day:</b> No more than 3 new scouts per trading day.'))
    s.append(bullet_p('<b>Daily Exit:</b> Active scouts are closed immediately on a daily reversal signal (BE for longs, SE for shorts).'))
    s.append(bullet_p('<b>Timeout:</b> If no weekly signal fires within 28 trading days, scout is closed automatically.'))
    s.append(bullet_p('<b>Conversion:</b> Weekly signal can confirm the scout as early as the same week, as long as the signal date is after the scout entry date.'))
    s += subsection_heading('Phase 2: Weekly Confirmation & Pyramid')
    s.append(bullet_p('<b>Conversion:</b> When weekly BL/SS confirms, scout tops up to full Lot 1 (35% of position).'))
    s.append(bullet_p('<b>Stop Switch:</b> Daily stop replaced by weekly PNTHR stop with trailing ratchet.'))
    s.append(bullet_p('<b>Pyramid:</b> Lots 2-5 can now fire via standard weekly pyramid triggers.'))
    s.append(bullet_p('<b>Entry Price:</b> Weighted average of scout fill + conversion fill. Lot triggers based on original Lot 1 fill.'))
    s += subsection_heading('Phase 3: Position Management')
    s.append(bullet_p('<b>Weekly Stop Ratchet:</b> Every Friday, stops tighten using the higher of 2-week structural low and ATR floor. Only tightens.'))
    s.append(bullet_p('<b>Structural Exit:</b> If the current week breaks the prior 2-week range (low for longs, high for shorts), position exits at stop.'))
    s.append(bullet_p('<b>20-Day Stale Hunt:</b> Positions open 20+ trading days that are underwater close at market.'))
    s += subsection_heading('Why 25% Win Rate with 3.15x Profit Factor')
    s.append(body_p(
        'The Daily Cascade deliberately sacrifices win rate for payoff ratio. Most scouts (75%) are stopped out quickly '
        'for small losses (~$2,000 average). But the 25% that survive and pyramid up produce outsized gains '
        '(~$19,700 average winner = 9.5x the average loser). This is the signature of institutional trend-following: '
        'risk small, find winners, then concentrate capital as the market confirms.'
    ))
    s.append(PageBreak())

    s += section_heading('4. POSITION SIZING & PYRAMIDING')
    s.append(body_p(
        'The AI Elite Fund uses the same 5-lot pyramid system as the Carnivore Quant Fund, adapted for the Daily '
        'Cascade entry. Initial scout entry deploys just 17.5% of the full position. Full Lot 1 is earned through '
        'weekly confirmation. Subsequent lots require prior lot filled + price trigger reached.'
    ))
    lots = [
        ['Scout', 'Daily Entry', '~18%', 'Daily BL signal', 'None', 'Minimal risk; market must prove'],
        ['Lot 1', 'Full Entry',  '35%',  'Weekly BL confirms', 'Scout active', 'Scout tops up; weekly stop replaces daily'],
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

    s += section_heading('5. INSTITUTIONAL BACKTEST RESULTS')
    bt_rows = [
        ['Backtest Span', f'{t["gross"]["startDate"]} - {t["gross"]["endDate"]} ({t["gross"]["years"]:.2f} years)'],
        ['Starting Capital', fmt_usd(t["seedNav"])],
        ['Universe', '297 AI-focused U.S. equities (PNTHR AI Universe)'],
        ['Regime Gate', 'PAI300 36W EMA (BL only)'],
        ['Signal Architecture', 'Daily Cascade (scout → weekly confirmation → pyramid)'],
        ['Ending Equity Gross', fmt_usd(t["gross"]["endNav"], compact=True)],
        ['Ending Equity Net', fmt_usd(t["net"]["endNav"], compact=True)],
        ['Total Trades', f'{t["trades"]["total"]:,} (690 weekly + 784 scouts)'],
        ['Win Rate / Payoff', f'{t["trades"]["combined"]["winRate"]:.1f}% / 9.5x avg win/loss'],
        ['Profit Factor', f'{t["trades"]["combined"]["profitFactor"]:.2f}x'],
        ['Gross CAGR', f'+{t["gross"]["cagr"]:.2f}%'],
        [f'Net CAGR ({t["classLabel"]})', f'+{t["net"]["cagr"]:.2f}%'],
        ['Gross Sharpe', f'{t["gross"]["sharpe"]:.2f}'],
        ['Net Sharpe', f'{t["net"]["sharpe"]:.2f}'],
        ['Gross Sortino', f'{t["gross"]["sortino"]:.2f}'],
        ['Net Sortino', f'{t["net"]["sortino"]:.2f}'],
        ['Max Drawdown (Gross)', f'{t["gross"]["maxDD"]:.2f}%'],
        ['Max Drawdown (Net)', f'{t["net"]["maxDD"]:.2f}%'],
    ]
    br_r = [[Paragraph(f'<font color="#ffffff">{r[0]}</font>', S(f'bt{i}0', fontSize=9)),
             Paragraph(f'<font color="#fcf000"><b>{r[1]}</b></font>', S(f'bt{i}1', fontSize=9, alignment=TA_RIGHT))]
            for i, r in enumerate(bt_rows)]
    s.append(_dark_table(['METRIC', 'VALUE'], br_r, col_widths=[2.8*inch, CONTENT_W - 2.8*inch]))
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

        data_rows = [hdr_row()]
        for d in days:
            mtd = d.get('mtdPct', 0)
            mtd_c = '#22c55e' if mtd > 0 else ('#ef4444' if mtd < 0 else '#cccccc')
            activity_html = _format_activity_colored(d.get('closesList', []), d.get('opensList', {'BL': [], 'SS': []}))
            pnthr_val = d['net'] if d['net'] is not None else d['gross']
            data_rows.append([
                Paragraph(f'<font color="#ffffff">{d["date"][5:]}</font>', S('dd0', fontSize=8)),
                Paragraph(f'<font color="#cccccc">{fmt_usd(d.get("spyEquity", 0))}</font>', S('dd1', fontSize=8, alignment=TA_RIGHT)),
                Paragraph(f'<font color="#fcf000">{fmt_usd(pnthr_val)}</font>', S('dd2', fontSize=8, alignment=TA_RIGHT)),
                Paragraph(f'<font color="#ffffff">{d.get("openCount", 0)}</font>', S('dd3', fontSize=8, alignment=TA_RIGHT)),
                Paragraph(f'<font color="{mtd_c}">{"+" if mtd > 0 else ""}{mtd:.2f}%</font>', S('dd4', fontSize=8, alignment=TA_RIGHT)),
                Paragraph(activity_html, S('dd5', fontSize=7.5, leading=9.5, alignment=TA_LEFT)),
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
    s.append(Paragraph('<b><font color="#ffffff">Cumulative Growth (2022-2026)</font></b>  '
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
    recap_rows = [
        ['Net CAGR', f'+{net["cagr"]:.1f}%', '#22c55e'],
        ['Sharpe Ratio', f'{net["sharpe"]:.2f}', '#fcf000'],
        ['Sortino Ratio', f'{net["sortino"]:.2f}', '#fcf000'],
        ['Profit Factor', f'{t["trades"]["combined"]["profitFactor"]:.1f}x', '#22c55e'],
        ['Win Rate / Payoff', f'{t["trades"]["combined"]["winRate"]:.1f}% / 9.5x', '#22c55e'],
        ['Max Drawdown', f'{net["maxDD"]:.2f}%', '#ef4444'],
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
    net = t['net']; spy = t['spy']
    s.append(body_p(
        'The PNTHR AI Elite Fund was designed to capture the generational wealth creation of the artificial intelligence '
        'revolution while managing downside risk with institutional discipline. The 297-name AI Universe spans the full '
        'AI value chain, and the Daily Cascade architecture ensures capital is deployed only when the market confirms.'
    ))
    s.append(body_p(
        f'Over {net["totalMonths"]} months, the strategy delivered +{net["totalReturn"]:.0f}% total return at a '
        f'+{net["cagr"]:.1f}% CAGR, converting {fmt_usd(t["seedNav"])} to {fmt_usd(net["endNav"], compact=True)}. '
        f'The Sharpe ratio of {net["sharpe"]:.2f} and Sortino of {net["sortino"]:.2f} reflect a strategy that earns '
        f'returns through disciplined execution rather than tail risk exposure.'
    ))
    s += subsection_heading('Risk Is the Product')
    s.append(body_p(
        f'Maximum drawdown: {net["maxDD"]:.2f}%. Every drawdown fully recovered. The Daily Cascade\'s scout-first '
        f'architecture means 75% of trades are stopped out quickly for small losses, protecting capital until the '
        f'market proves the trade is working.'
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
        'The PNTHR AI Universe comprises 297 AI-focused U.S. equities selected using point-in-time methodology. '
        '43 monthly rebalances tracked composition evolution from 278 to 297 names. No future knowledge used.'
    ))
    s += subsection_heading('Data Sources')
    s.append(body_p(f'Daily OHLCV from FMP. PAI300 index computed from stored weights and daily prices. SPY benchmark via total-return price series.'))
    s += subsection_heading('Fee Structure (NET)')
    s.append(body_p(
        f'IBKR Pro Fixed commissions, 5 bps slippage, sector-tiered borrow 1-2%, 2% mgmt fee monthly, '
        f'{t["feeSchedule"]["yearsOneToThree"]}%/{t["feeSchedule"]["yearsFourPlus"]}% perf alloc quarterly with US2Y hurdle and HWM.'
    ))
    s += subsection_heading('Sharpe / Sortino Conventions')
    s.append(body_p('Sharpe: daily excess over US 3-mo T-Bill, annualized sqrt(252). Sortino: HFRI convention, MAR=0, total N denominator.'))
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

    filename = f'PNTHR_AI_Elite_IR_{t["label"]}_{tier_key}_v2.pdf'
    title_meta = f'PNTHR Funds - AI Elite Fund - {t["classLabel"]} Intelligence Report v2'
    return build_doc(filename, title_meta, story)


if __name__ == '__main__':
    tiers = sys.argv[1:] if len(sys.argv) > 1 else ['100k', '500k', '1m']
    for tk in tiers:
        print(f'\nBuilding {tk}...')
        result = build_per_tier_ir(tk)
        if result: print(f'  -> {result}')
    print('\nDone.')
