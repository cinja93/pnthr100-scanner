"""
PNTHR Funds — Document Branding Style Module (v4)
===================================================

Reusable ReportLab style system for PNTHR Funds legal and investor documents.
Brand system locked April 2026 through v4 iteration.

Single source of truth for:
  - cover headers (with/without portrait)
  - interior page mastheads (white zone, mini logo left, doc slug right)
  - interior page footers (3-column)
  - section headings (yellow accent bar)
  - callout boxes (cream with yellow left edge)
  - info tables (alternating grey rows, yellow left edge)
  - tagline / confidentiality bands (black with yellow text)

CRITICAL: This module ONLY controls presentation. Body text content passes
through byte-for-byte from source. No content transformations happen here.

Colors sampled from actual PNTHR logo pixels — #FCF000 is true logo yellow
(not CSS gold #FFD700, which drifts amber, nor #FFED00, which drifts warm).

Font: Helvetica family (ReportLab built-in, no embedding required).
"""

import os
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (
    Paragraph, Spacer, Table, TableStyle, Flowable, KeepTogether
)
from reportlab.pdfbase.pdfmetrics import stringWidth


# ============================================================================
# BRAND CONSTANTS — locked v4, do not modify
# ============================================================================

PNTHR_YELLOW   = HexColor('#FCF000')   # True logo yellow (sampled from logo pixels: 252,240,0)
PNTHR_BLACK    = HexColor('#0A0A0A')   # Title bands, tagline bands
PNTHR_INK      = HexColor('#1A1A1A')   # Primary body text
PNTHR_GREY_600 = HexColor('#5C5C5C')   # Secondary text, sub-labels
PNTHR_GREY_400 = HexColor('#9A9A9A')   # Thin separators
PNTHR_GREY_100 = HexColor('#F4F4F4')   # Alternating table row fills
PNTHR_CREAM    = HexColor('#FFF8E1')   # Callout box background

FONT_REGULAR     = 'Helvetica'
FONT_BOLD        = 'Helvetica-Bold'
FONT_ITALIC      = 'Helvetica-Oblique'
FONT_BOLD_ITALIC = 'Helvetica-BoldOblique'

# Uniform cover title size — calibrated to fit the longest title in the
# family ("INVESTMENT MANAGEMENT AGREEMENT" / "LIMITED PARTNERSHIP AGREEMENT").
# All covers render at this single size regardless of their own title length.
COVER_TITLE_SIZE = 20

# Page geometry
PAGE_WIDTH, PAGE_HEIGHT = letter
MARGIN_LEFT   = 0.75 * inch
MARGIN_RIGHT  = 0.75 * inch
MARGIN_TOP    = 1.00 * inch    # leaves room for masthead
MARGIN_BOTTOM = 0.85 * inch    # leaves room for footer

MASTHEAD_HEIGHT = 0.55 * inch
FOOTER_HEIGHT   = 0.35 * inch

# Asset paths — set by renderer via set_asset_paths()
_LOGO_PATH = None
_PORTRAIT_PATH = None


def set_asset_paths(logo_path, portrait_path=None):
    """Point the module at asset files. Call before rendering."""
    global _LOGO_PATH, _PORTRAIT_PATH
    _LOGO_PATH = logo_path
    _PORTRAIT_PATH = portrait_path


# ============================================================================
# PARAGRAPH STYLES
# ============================================================================

def get_paragraph_styles():
    """Dict of ParagraphStyle objects for body content flowing through Platypus."""
    base = getSampleStyleSheet()['Normal']

    return {
        'body': ParagraphStyle(
            'body', parent=base,
            fontName=FONT_REGULAR, fontSize=9, leading=12,
            textColor=PNTHR_INK, alignment=TA_JUSTIFY, spaceAfter=6,
        ),
        'body_left': ParagraphStyle(
            'body_left', parent=base,
            fontName=FONT_REGULAR, fontSize=9, leading=12,
            textColor=PNTHR_INK, alignment=TA_LEFT, spaceAfter=6,
        ),
        'body_center': ParagraphStyle(
            'body_center', parent=base,
            fontName=FONT_REGULAR, fontSize=9, leading=12,
            textColor=PNTHR_INK, alignment=TA_CENTER, spaceAfter=6,
        ),
        'body_bold': ParagraphStyle(
            'body_bold', parent=base,
            fontName=FONT_BOLD, fontSize=9, leading=12,
            textColor=PNTHR_INK, alignment=TA_LEFT, spaceAfter=6,
        ),
        'body_indent': ParagraphStyle(
            'body_indent', parent=base,
            fontName=FONT_REGULAR, fontSize=9, leading=12,
            textColor=PNTHR_INK, alignment=TA_JUSTIFY, spaceAfter=6,
            leftIndent=24,
        ),
        'section_heading': ParagraphStyle(
            'section_heading', parent=base,
            fontName=FONT_BOLD, fontSize=11, leading=14,
            textColor=PNTHR_BLACK, alignment=TA_LEFT,
            spaceBefore=10, spaceAfter=4, leftIndent=10,
        ),
        'article_heading': ParagraphStyle(
            'article_heading', parent=base,
            fontName=FONT_BOLD, fontSize=13, leading=16,
            textColor=PNTHR_BLACK, alignment=TA_LEFT,
            spaceBefore=16, spaceAfter=6, leftIndent=10,
        ),
        'sub_label': ParagraphStyle(
            'sub_label', parent=base,
            fontName=FONT_BOLD, fontSize=6, leading=8,
            textColor=PNTHR_YELLOW, alignment=TA_LEFT,
            spaceAfter=6, leftIndent=10,
        ),
        'callout_body': ParagraphStyle(
            'callout_body', parent=base,
            fontName=FONT_REGULAR, fontSize=8, leading=11,
            textColor=PNTHR_INK, alignment=TA_LEFT,
        ),
        'callout_label': ParagraphStyle(
            'callout_label', parent=base,
            fontName=FONT_BOLD, fontSize=6, leading=8,
            textColor=PNTHR_GREY_600, alignment=TA_LEFT, spaceAfter=2,
        ),
        'toc_entry': ParagraphStyle(
            'toc_entry', parent=base,
            fontName=FONT_REGULAR, fontSize=9, leading=13,
            textColor=PNTHR_INK, alignment=TA_LEFT, leftIndent=12,
        ),
        'toc_article': ParagraphStyle(
            'toc_article', parent=base,
            fontName=FONT_BOLD, fontSize=10, leading=14,
            textColor=PNTHR_BLACK, alignment=TA_LEFT,
            spaceBefore=6, spaceAfter=2,
        ),
        'signature': ParagraphStyle(
            'signature', parent=base,
            fontName=FONT_REGULAR, fontSize=9, leading=13,
            textColor=PNTHR_INK, alignment=TA_LEFT, spaceAfter=4,
        ),
        'small_caps_heading': ParagraphStyle(
            'small_caps_heading', parent=base,
            fontName=FONT_BOLD, fontSize=10, leading=13,
            textColor=PNTHR_BLACK, alignment=TA_CENTER,
            spaceBefore=12, spaceAfter=6,
        ),
    }


# ============================================================================
# COVER HEADER
# ============================================================================

def draw_cover_header(c, title, subtitle, portrait=False):
    """
    Draws v4 cover header: white zone → logo (+portrait) → yellow rule
    → black title band → yellow title + white subtitle → yellow accent rule.

    Returns y-coordinate where body content may begin.
    """
    page_w = PAGE_WIDTH
    page_h = PAGE_HEIGHT

    # ---- White zone with logo lockup ----
    logo_top = page_h - 0.5 * inch

    if _LOGO_PATH and os.path.exists(_LOGO_PATH):
        if portrait and _PORTRAIT_PATH and os.path.exists(_PORTRAIT_PATH):
            # Two-image layout: logo left, portrait right
            logo_w = 2.0 * inch
            logo_h = logo_w * (325.0 / 800.0)
            logo_x = (page_w / 2.0) - logo_w - 0.25 * inch
            logo_y = logo_top - logo_h - 0.2 * inch
            c.drawImage(_LOGO_PATH, logo_x, logo_y, width=logo_w, height=logo_h,
                        mask='auto', preserveAspectRatio=True)

            portrait_h = 1.3 * inch
            portrait_w = portrait_h * (640.0 / 427.0)  # approx portrait aspect
            portrait_x = (page_w / 2.0) + 0.25 * inch
            portrait_y = logo_top - portrait_h - 0.15 * inch
            c.drawImage(_PORTRAIT_PATH, portrait_x, portrait_y,
                        width=portrait_w, height=portrait_h,
                        mask='auto', preserveAspectRatio=True)

            # Tiny caption under portrait
            c.setFillColor(PNTHR_GREY_600)
            c.setFont(FONT_REGULAR, 6)
            caption = "Cindy Eagar            Scott McBrien"
            cap_w = stringWidth(caption, FONT_REGULAR, 6)
            c.drawString(portrait_x + (portrait_w - cap_w) / 2.0,
                         portrait_y - 0.1 * inch, caption)
        else:
            # Logo only, centered
            logo_w = 2.4 * inch
            logo_h = logo_w * (325.0 / 800.0)
            logo_x = (page_w - logo_w) / 2.0
            logo_y = logo_top - logo_h - 0.2 * inch
            c.drawImage(_LOGO_PATH, logo_x, logo_y, width=logo_w, height=logo_h,
                        mask='auto', preserveAspectRatio=True)

    # ---- Yellow rule divider ----
    rule_y = page_h - 2.6 * inch
    c.setStrokeColor(PNTHR_YELLOW)
    c.setLineWidth(2)
    c.line(MARGIN_LEFT, rule_y, page_w - MARGIN_RIGHT, rule_y)

    # ---- Black title band ----
    band_height = 0.95 * inch
    band_top = rule_y - 0.12 * inch
    band_bottom = band_top - band_height
    c.setFillColor(PNTHR_BLACK)
    c.rect(MARGIN_LEFT, band_bottom, page_w - MARGIN_LEFT - MARGIN_RIGHT,
           band_height, stroke=0, fill=1)

    # Title: yellow, pinned size, uppercase, centered
    c.setFillColor(PNTHR_YELLOW)
    c.setFont(FONT_BOLD, COVER_TITLE_SIZE)
    title_upper = title.upper()
    title_w = stringWidth(title_upper, FONT_BOLD, COVER_TITLE_SIZE)
    title_x = (page_w - title_w) / 2.0
    title_y = band_bottom + band_height - 0.4 * inch
    c.drawString(title_x, title_y, title_upper)

    # Subtitle: white, centered below title
    c.setFillColor(white)
    c.setFont(FONT_REGULAR, 9)
    sub_w = stringWidth(subtitle, FONT_REGULAR, 9)
    sub_x = (page_w - sub_w) / 2.0
    sub_y = band_bottom + 0.22 * inch
    c.drawString(sub_x, sub_y, subtitle)

    # Short yellow accent rule under subtitle
    accent_w = 0.75 * inch
    accent_x = (page_w - accent_w) / 2.0
    accent_y = sub_y - 0.08 * inch
    c.setStrokeColor(PNTHR_YELLOW)
    c.setLineWidth(1)
    c.line(accent_x, accent_y, accent_x + accent_w, accent_y)

    return band_bottom - 0.35 * inch


# ============================================================================
# COVER BOTTOM BAND
# ============================================================================

def draw_cover_bottom_band(c, text):
    """Black bottom band with yellow centered text. NO logo inside."""
    page_w = PAGE_WIDTH
    band_height = 0.38 * inch
    band_y = 0.45 * inch

    c.setFillColor(PNTHR_BLACK)
    c.rect(MARGIN_LEFT, band_y, page_w - MARGIN_LEFT - MARGIN_RIGHT,
           band_height, stroke=0, fill=1)

    c.setFillColor(PNTHR_YELLOW)
    c.setFont(FONT_BOLD, 8)
    text_w = stringWidth(text, FONT_BOLD, 8)
    c.drawString((page_w - text_w) / 2.0, band_y + 0.14 * inch, text)


# ============================================================================
# INTERIOR MASTHEAD (every non-cover page)
# ============================================================================

def draw_interior_masthead(c, doc_slug):
    """
    White zone → mini logo on white (never black) → doc slug in black right
    → yellow underline rule.
    """
    page_w = PAGE_WIDTH
    page_h = PAGE_HEIGHT

    # Mini logo, left aligned, on white background
    if _LOGO_PATH and os.path.exists(_LOGO_PATH):
        logo_h = 0.30 * inch
        logo_w = logo_h * (800.0 / 325.0)
        logo_x = MARGIN_LEFT
        logo_y = page_h - 0.55 * inch
        c.drawImage(_LOGO_PATH, logo_x, logo_y, width=logo_w, height=logo_h,
                    mask='auto', preserveAspectRatio=True)

    # Doc slug right-aligned, black text
    c.setFillColor(PNTHR_BLACK)
    c.setFont(FONT_BOLD, 7.5)
    slug_w = stringWidth(doc_slug, FONT_BOLD, 7.5)
    slug_x = page_w - MARGIN_RIGHT - slug_w
    slug_y = page_h - 0.42 * inch
    c.drawString(slug_x, slug_y, doc_slug)

    # Yellow underline rule
    underline_y = page_h - 0.72 * inch
    c.setStrokeColor(PNTHR_YELLOW)
    c.setLineWidth(1.5)
    c.line(MARGIN_LEFT, underline_y, page_w - MARGIN_RIGHT, underline_y)


# ============================================================================
# INTERIOR FOOTER (every non-cover page)
# ============================================================================

def draw_interior_footer(c, doc_name, confidentiality, page_num, page_total):
    """Thin yellow rule + 3-column footer (doc name | confidential | page X of Y)."""
    page_w = PAGE_WIDTH
    footer_top = 0.6 * inch

    c.setStrokeColor(PNTHR_YELLOW)
    c.setLineWidth(0.75)
    c.line(MARGIN_LEFT, footer_top, page_w - MARGIN_RIGHT, footer_top)

    c.setFillColor(PNTHR_GREY_600)
    c.setFont(FONT_REGULAR, 7)
    text_y = footer_top - 0.18 * inch

    c.drawString(MARGIN_LEFT, text_y, doc_name)

    conf_w = stringWidth(confidentiality, FONT_REGULAR, 7)
    c.drawString((page_w - conf_w) / 2.0, text_y, confidentiality)

    page_str = f"Page {page_num} of {page_total}"
    page_w_str = stringWidth(page_str, FONT_REGULAR, 7)
    c.drawString(page_w - MARGIN_RIGHT - page_w_str, text_y, page_str)


# ============================================================================
# SECTION HEADING FLOWABLE — yellow accent bar + heading + optional sub-label
# ============================================================================

class SectionHeading(Flowable):
    """
    Platypus flowable: 3pt yellow accent bar + bold black heading + optional
    yellow sub-label. Used for Section and Article starts.
    
    Long headings wrap across multiple lines; the yellow bar extends the
    full height of the wrapped text so it always aligns with the title.
    """

    def __init__(self, heading, sub_label=None, size=11, is_article=False):
        Flowable.__init__(self)
        self.heading = heading
        self.sub_label = sub_label
        self.size = size + (2 if is_article else 0)
        self.is_article = is_article
        self._width = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT
        # Wrap width for the heading text (accounts for the bar + gap)
        self._text_indent = 11  # bar width + gap
        self._wrap_width = self._width - self._text_indent
        self._wrapped_lines = None  # computed in wrap()

    def wrap(self, avail_w, avail_h):
        # Measure how many lines the heading will take at our font
        words = self.heading.split()
        lines = []
        current = ''
        for word in words:
            trial = (current + ' ' + word).strip() if current else word
            if stringWidth(trial, FONT_BOLD, self.size) <= self._wrap_width:
                current = trial
            else:
                if current:
                    lines.append(current)
                current = word
        if current:
            lines.append(current)
        self._wrapped_lines = lines or ['']
        
        # Compute total height
        line_height = self.size + 2
        text_height = len(self._wrapped_lines) * line_height
        pad_top = 2
        pad_bottom = 2
        sub_label_h = 10 if self.sub_label else 0
        self.height = pad_top + text_height + pad_bottom + sub_label_h
        self.width = min(avail_w, self._width)
        return self.width, self.height

    def draw(self):
        c = self.canv
        bar_x = 0
        bar_w = 3

        # Yellow accent bar — full height of heading
        c.setFillColor(PNTHR_YELLOW)
        c.rect(bar_x, 0, bar_w, self.height, stroke=0, fill=1)

        # Heading text — draw each wrapped line
        c.setFillColor(PNTHR_BLACK)
        c.setFont(FONT_BOLD, self.size)
        line_height = self.size + 2
        top = self.height - (10 if self.sub_label else 0)
        for i, line in enumerate(self._wrapped_lines or [self.heading]):
            y = top - (i + 1) * line_height + 2
            c.drawString(self._text_indent, y, line)

        # Sub-label (yellow) at bottom
        if self.sub_label:
            c.setFillColor(PNTHR_YELLOW)
            c.setFont(FONT_BOLD, 6)
            c.drawString(self._text_indent, 2, self.sub_label.upper())


# ============================================================================
# CALLOUT BOX — cream fill with yellow left edge
# ============================================================================

class CalloutBox(Flowable):
    """Cream box with yellow left edge for defined terms and key disclosures."""

    def __init__(self, label, body_text, width=None, height=None):
        Flowable.__init__(self)
        self.label = label
        self.body_text = body_text
        self.width = width or (PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT)
        self.height = height or 0.7 * inch

    def draw(self):
        c = self.canv
        c.setFillColor(PNTHR_CREAM)
        c.rect(0, 0, self.width, self.height, stroke=0, fill=1)

        c.setFillColor(PNTHR_YELLOW)
        c.rect(0, 0, 4, self.height, stroke=0, fill=1)

        c.setFillColor(PNTHR_GREY_600)
        c.setFont(FONT_BOLD, 6)
        c.drawString(14, self.height - 14, self.label.upper())

        c.setFillColor(PNTHR_INK)
        c.setFont(FONT_REGULAR, 8)
        c.drawString(14, self.height - 30, self.body_text)


# ============================================================================
# INFO TABLE — alternating grey rows with yellow left edge
# ============================================================================

def build_info_table(rows, col_widths=None, header=None):
    """
    Styled Platypus Table for cover info tables.
    Alternating Grey 100 fills, yellow left edge, bold labels.
    `rows` is a list of (label, value) tuples.
    If `header` is provided, drawn as a black header row with white text.
    """
    data = []
    if header:
        data.append([header, ''])
    data.extend(rows)

    if col_widths is None:
        total_w = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT - 0.8 * inch
        col_widths = [total_w * 0.38, total_w * 0.62]

    table = Table(data, colWidths=col_widths, hAlign='CENTER')

    style_commands = [
        ('FONT', (0, 0), (-1, -1), FONT_REGULAR, 9),
        ('TEXTCOLOR', (0, 0), (-1, -1), PNTHR_INK),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('TOPPADDING', (0, 0), (-1, -1), 7),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
        ('LINEBEFORE', (0, 0), (0, -1), 3, PNTHR_YELLOW),
    ]

    start_row = 0
    if header:
        # Black header row spanning both columns
        style_commands.extend([
            ('SPAN', (0, 0), (1, 0)),
            ('BACKGROUND', (0, 0), (-1, 0), PNTHR_BLACK),
            ('TEXTCOLOR', (0, 0), (-1, 0), white),
            ('FONT', (0, 0), (-1, 0), FONT_BOLD, 9),
            ('TOPPADDING', (0, 0), (-1, 0), 8),
            ('BOTTOMPADDING', (0, 0), (-1, 0), 8),
        ])
        start_row = 1

    # Label column: bold
    style_commands.append(('FONT', (0, start_row), (0, -1), FONT_BOLD, 9))

    # Alternating row fills
    for i in range(start_row, len(data)):
        if (i - start_row) % 2 == 0:
            style_commands.append(('BACKGROUND', (0, i), (-1, i), PNTHR_GREY_100))

    table.setStyle(TableStyle(style_commands))
    return table


# ============================================================================
# PAGE DECORATION CALLBACK — for use with BaseDocTemplate
# ============================================================================

def make_numbered_canvas(doc_slug, doc_name, confidentiality, cover_pages=1):
    """
    Returns a Canvas subclass that knows how to stamp masthead + footer on
    every non-cover page, with accurate 'Page X of Y' numbering via two-pass
    rendering. Wire into BaseDocTemplate's build() via canvasmaker=.

    cover_pages: number of leading pages to treat as covers (no masthead/footer).
    """
    from reportlab.pdfgen.canvas import Canvas

    class NumberedCanvas(Canvas):
        def __init__(self, *args, **kwargs):
            Canvas.__init__(self, *args, **kwargs)
            self._saved_page_states = []

        def showPage(self):
            self._saved_page_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._saved_page_states)
            for i, state in enumerate(self._saved_page_states):
                self.__dict__.update(state)
                page_num = i + 1
                if page_num > cover_pages:
                    self.saveState()
                    draw_interior_masthead(self, doc_slug)
                    draw_interior_footer(self, doc_name, confidentiality,
                                         page_num, total)
                    self.restoreState()
                Canvas.showPage(self)
            Canvas.save(self)

    return NumberedCanvas


# ============================================================================
# CONVENIENCE: standard flowable builders
# ============================================================================

def section_spacer():
    return Spacer(1, 0.08 * inch)


def article_spacer():
    return Spacer(1, 0.18 * inch)


def para(text, style_name='body'):
    """Quick paragraph builder."""
    styles = get_paragraph_styles()
    return Paragraph(text, styles[style_name])
