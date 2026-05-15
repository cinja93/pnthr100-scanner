"""
PNTHR Funds Legal Docs - Shared Design Template
===============================================

Phase 2 design language extracted from PPM v6.6 and applied to all 9 docs.
This module is the single source of truth for the PNTHR brand visual layer.

Visual language:
  - Typography: Helvetica family (matches PNTHR_Key_Personnel.pdf reference)
  - Cover: solid black background (#0a0a0a) with yellow top accent bar (#fcf000),
    PNTHR Funds logo upper-left, ghost panther watermark on right, white/yellow/
    gray text hierarchy, centered confidential block near bottom
  - Content pages: white background, yellow top accent bar, dim-gray middle-footer
    breadcrumb with thin light-gray rule above, black bottom footer band with
    yellow "PNTHR FUNDS:" brand + white doc breadcrumb + white page number
  - Color palette extracted from PNTHR_Key_Personnel.pdf via 200-DPI pixel sampling
  - Margins: 0.75" left/right, 1.0" top, 1.0" bottom (accommodates footer band)

Design reference: ~/pnthr100-scanner/client/public/dataroom/PNTHR_Key_Personnel.pdf
Approval history: PPM v6.2 -> v6.3 -> v6.4 -> v6.5 -> v6.6 (approved 2026-04-19)

USAGE
-----
Typical doc generator pattern:

    from pnthr_design import (
        PALETTE_YELLOW, PALETTE_BLACK, PALETTE_WHITE, PALETTE_DIM_GRAY,
        PALETTE_LIGHT_GRAY, PALETTE_TABLE_GRAY,
        TITLE_STYLE, SUBTITLE_STYLE, H1, H2, BODY, BODY_INDENT, BULLET,
        COVER_NOTICE, COVER_BODY, CAPS_BODY, FOOTNOTE,
        COVER_TITLE_WHITE, COVER_SUBTITLE_YELLOW, COVER_META_GRAY,
        COVER_CONFIDENTIAL_BLOCK, COVER_NOTICE_WHITE,
        make_doc_template, make_page_handlers, build_cover_header,
    )

    OUT_PATH = ".../final/PNTHR_SubAgmt_v2.4_2026.pdf"
    SHORT = "Subscription Agreement"   # Used in footer band breadcrumb
    DATE_DISPLAY = "June 2025"         # Used in middle-footer breadcrumb

    doc = make_doc_template(
        OUT_PATH,
        title_meta="PNTHR Funds, Carnivore Quant Fund, LP - Subscription Agreement v2.4",
        subject="Subscription Agreement",
    )
    on_cover, on_page = make_page_handlers(doc_short_title=SHORT, doc_date_display=DATE_DISPLAY)

    story = []
    story.extend(build_cover_header(
        title_line_1="PNTHR FUNDS,",
        title_line_2="Carnivore Quant Fund, LP",
        subtitle="a Delaware Limited Partnership",
        date_line="DATE:  June 1, 2025",
        revision_line="Document Revision:  v2.4 - April 2026",
        issuer_line="Issuer:  PNTHR Funds, LLC (General Partner)",
        confidential_title="CONFIDENTIAL SUBSCRIPTION AGREEMENT",
        confidential_body="THE OFFERING DESCRIBED HEREIN IS HIGHLY SPECULATIVE...",
    ))

    # doc-specific content flowables...

    doc.build(story, onFirstPage=on_cover, onLaterPages=on_page)
"""

import os
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Image as RLImage,
)
from reportlab.lib import colors
from reportlab.lib.colors import HexColor


# ============================================================================
# PALETTE (exact hex values extracted from PNTHR_Key_Personnel.pdf @ 200 DPI)
# ============================================================================
PALETTE_YELLOW      = HexColor("#fcf000")  # top accent bar, footer brand
PALETTE_BLACK       = HexColor("#0a0a0a")  # cover background, footer band
PALETTE_PURE_BLACK  = HexColor("#000000")  # body text on content pages
PALETTE_WHITE       = HexColor("#ffffff")  # content bg, cover title, footer text
PALETTE_DIM_GRAY    = HexColor("#4d4d4d")  # cover confidential, breadcrumb
PALETTE_LIGHT_GRAY  = HexColor("#dddddd")  # content thin separator rule
PALETTE_TABLE_GRAY  = HexColor("#e8e8e8")  # table header row shading


# ============================================================================
# IMAGE ASSETS (sourced from scanner project)
# ============================================================================
_ASSET_DIR = os.path.expanduser("~/pnthr100-scanner/client/src/assets")
LOGO_BLACK_BG_PATH = os.path.join(_ASSET_DIR, "PNTHR FUNDS Logo black background 2 lines.png")
PANTHER_HEAD_PATH  = os.path.join(_ASSET_DIR, "panther head.png")

# Logo aspect ratio (for preserving proportions when sizing)
_LOGO_NATIVE_W, _LOGO_NATIVE_H = 2500, 1016


# ============================================================================
# LAYOUT CONSTANTS
# ============================================================================
ACCENT_BAR_HEIGHT     = 6            # points (top yellow accent bar; v6.4 tuned)
FOOTER_BAND_HEIGHT    = 0.30 * inch  # bottom black footer band height
BREADCRUMB_Y          = 0.56 * inch  # centered middle-footer breadcrumb baseline
RULE_Y                = 0.70 * inch  # thin gray rule above breadcrumb
COVER_BREADCRUMB_Y    = 0.82 * inch  # cover breadcrumb (above footer band)
COVER_RULE_Y          = 1.05 * inch  # cover middle yellow rule (above breadcrumb)
FOOTER_BAND_TEXT_OFFSET = 5          # v6.6 tuned: baseline = BAND_HEIGHT/2 - 5 for
                                     # vertical centering in the band

# Page margins (v6.5 tuned for Key Personnel left-justification)
MARGIN_LEFT   = 0.75 * inch
MARGIN_RIGHT  = 0.75 * inch
MARGIN_TOP    = 1.0 * inch
MARGIN_BOTTOM = 1.0 * inch


# ============================================================================
# PARAGRAPH STYLES
# ============================================================================

# ----- Content-page styles (black on white) ---------------------------------
TITLE_STYLE = ParagraphStyle(
    name="title", fontName="Helvetica-Bold", fontSize=16, leading=20,
    alignment=TA_CENTER, spaceBefore=0, spaceAfter=18,
)
SUBTITLE_STYLE = ParagraphStyle(
    name="subtitle", fontName="Helvetica", fontSize=12, leading=16,
    alignment=TA_CENTER, spaceBefore=0, spaceAfter=10,
)
H1 = ParagraphStyle(
    name="h1", fontName="Helvetica-Bold", fontSize=13, leading=16,
    alignment=TA_LEFT, spaceBefore=18, spaceAfter=10,
)
H2 = ParagraphStyle(
    name="h2", fontName="Helvetica-Bold", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=12, spaceAfter=6,
)
BODY = ParagraphStyle(
    name="body", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=8,
)
BODY_LEFT = ParagraphStyle(
    name="body_left", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=0, spaceAfter=8,
)
BODY_INDENT = ParagraphStyle(
    name="body_indent", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=8, leftIndent=24,
)
BULLET = ParagraphStyle(
    name="bullet", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=0, spaceAfter=6, leftIndent=36, bulletIndent=20,
)
COVER_NOTICE = ParagraphStyle(
    name="cover_notice", fontName="Helvetica-Bold", fontSize=11, leading=14,
    alignment=TA_CENTER, spaceBefore=12, spaceAfter=12,
)
COVER_BODY = ParagraphStyle(
    name="cover_body", fontName="Helvetica", fontSize=10, leading=13,
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=8,
)
CAPS_BODY = ParagraphStyle(
    name="caps_body", fontName="Helvetica", fontSize=10, leading=13,
    alignment=TA_JUSTIFY, spaceBefore=6, spaceAfter=8,
)
FOOTNOTE = ParagraphStyle(
    name="footnote", fontName="Helvetica", fontSize=9, leading=11,
    alignment=TA_JUSTIFY, spaceBefore=2, spaceAfter=4,
)

# ----- Cover-page styles (text on black background) --------------------------
COVER_TITLE_WHITE = ParagraphStyle(
    name="cover_title_white", fontName="Helvetica-Bold", fontSize=21, leading=25,
    alignment=TA_LEFT, textColor=PALETTE_WHITE, spaceBefore=0, spaceAfter=4,
)
COVER_SUBTITLE_YELLOW = ParagraphStyle(
    name="cover_subtitle_yellow", fontName="Helvetica-Bold", fontSize=14, leading=18,
    alignment=TA_LEFT, textColor=PALETTE_YELLOW, spaceBefore=2, spaceAfter=2,
)
COVER_META_GRAY = ParagraphStyle(
    name="cover_meta_gray", fontName="Helvetica", fontSize=10, leading=13,
    alignment=TA_LEFT, textColor=PALETTE_DIM_GRAY, spaceBefore=1, spaceAfter=1,
)
COVER_CONFIDENTIAL_BLOCK = ParagraphStyle(
    name="cover_confidential_block", fontName="Helvetica", fontSize=9, leading=12,
    alignment=TA_CENTER, textColor=PALETTE_DIM_GRAY, spaceBefore=6, spaceAfter=6,
)
COVER_NOTICE_WHITE = ParagraphStyle(
    name="cover_notice_white", fontName="Helvetica-Bold", fontSize=10, leading=13,
    alignment=TA_CENTER, textColor=PALETTE_WHITE, spaceBefore=6, spaceAfter=6,
)


# ============================================================================
# CHROME DRAWING (canvas) — parameterized by doc-specific metadata
# ============================================================================
def _draw_content_chrome(canvas, doc, middle_footer_text, footer_doc_breadcrumb):
    """Top accent + middle breadcrumb + bottom black footer band."""
    W, H = letter

    # Top yellow accent bar
    canvas.setFillColor(PALETTE_YELLOW)
    canvas.rect(0, H - ACCENT_BAR_HEIGHT, W, ACCENT_BAR_HEIGHT, stroke=0, fill=1)

    # Thin light-gray rule above middle-footer breadcrumb
    canvas.setStrokeColor(PALETTE_LIGHT_GRAY)
    canvas.setLineWidth(0.5)
    canvas.line(0.75 * inch, RULE_Y, W - 0.75 * inch, RULE_Y)

    # Middle footer breadcrumb (centered, dim gray)
    canvas.setFillColor(PALETTE_DIM_GRAY)
    canvas.setFont("Helvetica", 8)
    canvas.drawCentredString(W / 2.0, BREADCRUMB_Y, middle_footer_text)

    # Bottom black footer band
    canvas.setFillColor(PALETTE_BLACK)
    canvas.rect(0, 0, W, FOOTER_BAND_HEIGHT, stroke=0, fill=1)

    band_text_y = FOOTER_BAND_HEIGHT / 2.0 - FOOTER_BAND_TEXT_OFFSET

    # Footer band: yellow "PNTHR FUNDS:" brand (left)
    canvas.setFillColor(PALETTE_YELLOW)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(0.45 * inch, band_text_y, "PNTHR FUNDS:")

    # Footer band: white doc breadcrumb (following the brand)
    brand_width = canvas.stringWidth("PNTHR FUNDS:", "Helvetica-Bold", 9)
    canvas.setFillColor(PALETTE_WHITE)
    canvas.setFont("Helvetica", 9)
    canvas.drawString(0.45 * inch + brand_width + 6, band_text_y, footer_doc_breadcrumb)

    # Footer band: white page number (right)
    canvas.setFillColor(PALETTE_WHITE)
    canvas.setFont("Helvetica", 9)
    canvas.drawRightString(W - 0.45 * inch, band_text_y, f"Page {doc.page}")


def _draw_cover_chrome(canvas, doc, middle_footer_text, footer_doc_breadcrumb):
    """Full-bleed black cover + top accent + ghost panther + breadcrumb + footer band."""
    W, H = letter

    # Full-bleed black background
    canvas.setFillColor(PALETTE_BLACK)
    canvas.rect(0, 0, W, H, stroke=0, fill=1)

    # Top yellow accent bar
    canvas.setFillColor(PALETTE_YELLOW)
    canvas.rect(0, H - ACCENT_BAR_HEIGHT, W, ACCENT_BAR_HEIGHT, stroke=0, fill=1)

    # Ghost panther watermark (right side, low alpha)
    if os.path.exists(PANTHER_HEAD_PATH):
        canvas.saveState()
        try:
            canvas.setFillAlpha(0.08)
            canvas.setStrokeAlpha(0.08)
        except Exception:
            pass
        wm_size = 6.5 * inch
        wm_x = W - wm_size + 0.8 * inch
        wm_y = H / 2.0 - wm_size / 2.0 + 0.8 * inch
        try:
            canvas.drawImage(PANTHER_HEAD_PATH, wm_x, wm_y,
                             width=wm_size, height=wm_size,
                             mask="auto", preserveAspectRatio=True)
        except Exception:
            pass
        canvas.restoreState()

    # Middle yellow rule (thin horizontal bar above breadcrumb strip)
    canvas.setStrokeColor(PALETTE_YELLOW)
    canvas.setLineWidth(0.75)
    canvas.line(0.75 * inch, COVER_RULE_Y, W - 0.75 * inch, COVER_RULE_Y)

    # Breadcrumb strip (dim gray, centered)
    canvas.setFillColor(PALETTE_DIM_GRAY)
    canvas.setFont("Helvetica", 8)
    canvas.drawCentredString(W / 2.0, COVER_BREADCRUMB_Y, middle_footer_text)

    # Bottom black footer band (identical to content pages)
    canvas.setFillColor(PALETTE_BLACK)
    canvas.rect(0, 0, W, FOOTER_BAND_HEIGHT, stroke=0, fill=1)

    band_text_y = FOOTER_BAND_HEIGHT / 2.0 - FOOTER_BAND_TEXT_OFFSET

    canvas.setFillColor(PALETTE_YELLOW)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(0.45 * inch, band_text_y, "PNTHR FUNDS:")

    brand_width = canvas.stringWidth("PNTHR FUNDS:", "Helvetica-Bold", 9)
    canvas.setFillColor(PALETTE_WHITE)
    canvas.setFont("Helvetica", 9)
    canvas.drawString(0.45 * inch + brand_width + 6, band_text_y, footer_doc_breadcrumb)

    canvas.setFillColor(PALETTE_WHITE)
    canvas.setFont("Helvetica", 9)
    canvas.drawRightString(W - 0.45 * inch, band_text_y, f"Page {doc.page}")


# ============================================================================
# PUBLIC FACTORY FUNCTIONS
# ============================================================================
def make_doc_template(out_path, title_meta, subject, author="PNTHR Funds, LLC"):
    """Returns a SimpleDocTemplate configured with the PNTHR design margins."""
    return SimpleDocTemplate(
        out_path,
        pagesize=letter,
        leftMargin=MARGIN_LEFT, rightMargin=MARGIN_RIGHT,
        topMargin=MARGIN_TOP, bottomMargin=MARGIN_BOTTOM,
        title=title_meta, author=author, subject=subject,
    )


def make_page_handlers(doc_short_title, doc_date_display="June 2025",
                       fund_name="Carnivore Quant Fund",
                       fund_name_upper="CARNIVORE QUANT FUND"):
    """
    Returns (on_cover, on_page) canvas callbacks bound to this doc's
    specific footer-band title and breadcrumb date.

    Args:
        doc_short_title: Short title shown after fund name in the bottom
            footer band (e.g. "Private Placement Memorandum",
            "Limited Partnership Agreement", "Subscription Agreement").
        doc_date_display: Date string shown in the centered middle-footer
            breadcrumb.
        fund_name: Fund name for footer breadcrumb (e.g. "PNTHR AI Elite 300 Fund").
        fund_name_upper: Fund name in uppercase for middle footer.
    """
    middle_footer_text = (
        f"PNTHR FUNDS  \u00b7  {fund_name_upper}  \u00b7  "
        f"CONFIDENTIAL  \u00b7  {doc_date_display}  \u00b7  pnthrfunds.com"
    )
    footer_doc_breadcrumb = f"{fund_name}  |  {doc_short_title}"

    def on_cover(canvas, doc):
        canvas.saveState()
        _draw_cover_chrome(canvas, doc, middle_footer_text, footer_doc_breadcrumb)
        canvas.restoreState()

    def on_page(canvas, doc):
        canvas.saveState()
        _draw_content_chrome(canvas, doc, middle_footer_text, footer_doc_breadcrumb)
        canvas.restoreState()

    return on_cover, on_page


def build_cover_header(
    title_line_1="PNTHR FUNDS,",
    title_line_2="Carnivore Quant Fund, LP",
    subtitle="a Delaware Limited Partnership",
    date_line="DATE:  June 1, 2025",
    revision_line=None,
    issuer_line="Issuer:  PNTHR Funds, LLC (General Partner)",
    confidential_title=None,
    confidential_body=None,
    logo_width_inches=3.5,
    pre_title_spacer_inches=1.1,
    pre_confidential_spacer_inches=2.9,
):
    """
    Returns a list of flowables for the Key-Personnel-style cover page.

    All tuned spacing from PPM v6.6 (user-approved 2026-04-19):
      - Logo: 3.5" wide (left-aligned, top)
      - Title block: 22pt bold white, left-aligned, below logo after 1.1" spacer
      - Subtitle: 14pt bold yellow, left-aligned
      - Meta: three lines (date, revision, issuer) in 10pt dim gray
      - Confidential block: centered near the bottom of the page after 2.9" spacer,
        with both the white bold title line and a dim-gray body paragraph
      - Cover is followed by a PageBreak; subsequent pages use content chrome

    Typically each doc calls this, then appends doc-specific content flowables.
    """
    story = []

    # Logo (top-left; preserves aspect ratio from 2500x1016 native)
    if os.path.exists(LOGO_BLACK_BG_PATH):
        logo_w = logo_width_inches * inch
        logo_h = logo_w * _LOGO_NATIVE_H / _LOGO_NATIVE_W
        logo = RLImage(LOGO_BLACK_BG_PATH, width=logo_w, height=logo_h)
        logo.hAlign = "LEFT"
        story.append(logo)

    # Title block
    story.append(Spacer(1, pre_title_spacer_inches * inch))
    if title_line_1:
        story.append(Paragraph(title_line_1, COVER_TITLE_WHITE))
    if title_line_2:
        story.append(Paragraph(title_line_2, COVER_TITLE_WHITE))
    story.append(Spacer(1, 0.14 * inch))

    # Yellow subtitle (single line, left-aligned)
    if subtitle:
        story.append(Paragraph(subtitle, COVER_SUBTITLE_YELLOW))
    story.append(Spacer(1, 0.35 * inch))

    # Meta lines (gray, left-aligned)
    if date_line:
        story.append(Paragraph(date_line, COVER_META_GRAY))
    if revision_line:
        story.append(Paragraph(revision_line, COVER_META_GRAY))
    if issuer_line:
        story.append(Paragraph(issuer_line, COVER_META_GRAY))

    # Confidential block (centered, lower)
    story.append(Spacer(1, pre_confidential_spacer_inches * inch))
    if confidential_title:
        story.append(Paragraph(confidential_title, COVER_NOTICE_WHITE))
        story.append(Spacer(1, 0.12 * inch))
    if confidential_body:
        story.append(Paragraph(confidential_body, COVER_CONFIDENTIAL_BLOCK))

    story.append(PageBreak())
    return story
