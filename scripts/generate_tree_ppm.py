#!/usr/bin/env python3
"""
PNTHR Tree Fund, LP
Private Placement Memorandum v1.0
Effective Date of Memorandum: June 1, 2026

Adapted from the AI Elite 300 PPM design template (forked 2026-06-19).
Same legal structure (Delaware LP, Rule 506(c), Section 3(c)(1)), same
fee schedule, same service providers, same AI 300 universe. Strategy
rewritten to the Tree mandate: long/short authorized, current systematic
implementation long-only — new-42-week-high momentum breakout, single
2-week-low trailing stop with breakeven snap, full-size entry (no pyramid),
2% NAV risk / 10% NAV cap / ADV cap, 2.0x gross-exposure cap. No regime
gate, no sector rotation, no multi-factor scoring, no time-based exit.

Output: PNTHR_Tree_Fund_PPM_v1.1_2026.pdf
"""

import os
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak,
    Table, TableStyle, KeepTogether, NextPageTemplate, PageTemplate, Frame,
    Image as RLImage,
)
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.lib import colors
from reportlab.lib.colors import HexColor

OUT_DIR = os.path.expanduser("~/Downloads")
os.makedirs(OUT_DIR, exist_ok=True)
OUT_PATH = os.path.join(OUT_DIR, "PNTHR_Tree_Fund_PPM_v1.1_2026.pdf")

# ----- PNTHR brand palette (exact hex values extracted from Key Personnel PDF) --
PALETTE_YELLOW      = HexColor("#fcf000")  # top accent bar, footer brand
PALETTE_BLACK       = HexColor("#0a0a0a")  # cover background, footer band
PALETTE_PURE_BLACK  = HexColor("#000000")  # body text on content pages
PALETTE_WHITE       = HexColor("#ffffff")  # content background, cover title, footer text
PALETTE_DIM_GRAY    = HexColor("#4d4d4d")  # content-page breadcrumb (on white)
PALETTE_COVER_GRAY  = HexColor("#b0b0b0")  # cover text on black (readable)
PALETTE_LIGHT_GRAY  = HexColor("#dddddd")  # content thin separator rule
PALETTE_TABLE_GRAY  = HexColor("#e8e8e8")  # table header row shading

# ----- Brand image assets -------------------------------------------------------
_ASSET_DIR = os.path.expanduser("~/pnthr100-scanner/client/src/assets")
LOGO_BLACK_BG_PATH = os.path.join(_ASSET_DIR, "PNTHR FUNDS Logo black background 2 lines.png")
PANTHER_HEAD_PATH  = os.path.join(_ASSET_DIR, "panther head.png")

# ----- Layout constants --------------------------------------------------------
ACCENT_BAR_HEIGHT   = 6          # points (top yellow accent bar; v6.6 thickened from 4pt)
FOOTER_BAND_HEIGHT  = 0.30 * inch  # bottom black footer band
BREADCRUMB_Y        = 0.56 * inch  # centered middle-footer breadcrumb baseline
RULE_Y              = 0.70 * inch  # thin gray rule above breadcrumb
MIDDLE_FOOTER_TEXT  = ("PNTHR FUNDS  \u00b7  PNTHR TREE FUND  \u00b7  "
                       "CONFIDENTIAL  \u00b7  June 2026  \u00b7  pnthrfunds.com")
FOOTER_BRAND_LEFT   = "PNTHR FUNDS:"
FOOTER_DOC_BREADCRUMB = "PNTHR Tree Fund  |  Private Placement Memorandum"

# ── Styles ────────────────────────────────────────────────────────────────
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
    alignment=TA_JUSTIFY, spaceBefore=0, spaceAfter=8, firstLineIndent=0,
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
    alignment=TA_JUSTIFY, spaceBefore=2, spaceAfter=4, leftIndent=0,
)

# ----- Phase 2 cover-only text styles (dark cover background) ---------------
# Used ONLY on page 1 (black cover). Text color set explicitly for black bg.
COVER_TITLE_WHITE = ParagraphStyle(
    name="cover_title_white", fontName="Helvetica-Bold", fontSize=21, leading=25,
    alignment=TA_LEFT, textColor=PALETTE_WHITE, spaceBefore=0, spaceAfter=4,
)
COVER_SUBTITLE_YELLOW = ParagraphStyle(
    name="cover_subtitle_yellow", fontName="Helvetica-Bold", fontSize=14, leading=18,
    alignment=TA_LEFT, textColor=PALETTE_YELLOW, spaceBefore=2, spaceAfter=2,
)
COVER_META_GRAY = ParagraphStyle(
    name="cover_meta_gray", fontName="Helvetica", fontSize=11, leading=14,
    alignment=TA_LEFT, textColor=PALETTE_COVER_GRAY, spaceBefore=2, spaceAfter=2,
)
COVER_CONFIDENTIAL_BLOCK = ParagraphStyle(
    name="cover_confidential_block", fontName="Helvetica", fontSize=9, leading=12,
    alignment=TA_CENTER, textColor=PALETTE_COVER_GRAY, spaceBefore=6, spaceAfter=6,
)
COVER_NOTICE_WHITE = ParagraphStyle(
    name="cover_notice_white", fontName="Helvetica-Bold", fontSize=10, leading=13,
    alignment=TA_CENTER, textColor=PALETTE_WHITE, spaceBefore=6, spaceAfter=6,
)

# ── Header / Footer (Phase 2 design pass — Key Personnel template) ─────────
def _draw_content_chrome(canvas, doc):
    """
    Draws the shared chrome (top yellow accent + middle breadcrumb + bottom
    black footer band) used on every content page.
    """
    W, H = letter

    # Top yellow accent bar (full width)
    canvas.setFillColor(PALETTE_YELLOW)
    canvas.rect(0, H - ACCENT_BAR_HEIGHT, W, ACCENT_BAR_HEIGHT, stroke=0, fill=1)

    # Thin light-gray rule above middle-footer breadcrumb
    canvas.setStrokeColor(PALETTE_LIGHT_GRAY)
    canvas.setLineWidth(0.5)
    canvas.line(0.75 * inch, RULE_Y, W - 0.75 * inch, RULE_Y)

    # Middle footer breadcrumb (centered, dim gray, small Helvetica)
    canvas.setFillColor(PALETTE_DIM_GRAY)
    canvas.setFont("Helvetica", 8)
    canvas.drawCentredString(W / 2.0, BREADCRUMB_Y, MIDDLE_FOOTER_TEXT)

    # Bottom black footer band
    canvas.setFillColor(PALETTE_BLACK)
    canvas.rect(0, 0, W, FOOTER_BAND_HEIGHT, stroke=0, fill=1)

    # Footer band: yellow "PNTHR FUNDS:" brand (left)
    # v6.6: Text baseline lowered from -3 to -5 (moves text down ~2pt for more even
    # visual centering in the band) per user direction 2026-04-19 "words in the band
    # should be moved down slightly ... should be more centered up and down".
    band_text_y = FOOTER_BAND_HEIGHT / 2.0 - 5
    canvas.setFillColor(PALETTE_YELLOW)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(0.45 * inch, band_text_y, FOOTER_BRAND_LEFT)

    # Footer band: white doc breadcrumb (following the brand)
    brand_width = canvas.stringWidth(FOOTER_BRAND_LEFT, "Helvetica-Bold", 9)
    canvas.setFillColor(PALETTE_WHITE)
    canvas.setFont("Helvetica", 9)
    canvas.drawString(0.45 * inch + brand_width + 6, band_text_y,
                      FOOTER_DOC_BREADCRUMB)

    # Footer band: white page number (right)
    canvas.setFillColor(PALETTE_WHITE)
    canvas.setFont("Helvetica", 9)
    canvas.drawRightString(W - 0.45 * inch, band_text_y, f"Page {doc.page}")


def _draw_cover_chrome(canvas, doc):
    """
    Draws the cover page chrome: full-bleed black background + top yellow
    accent + ghost panther watermark (right) + middle yellow rule + breadcrumb
    strip + bottom black footer band matching content pages.
    """
    W, H = letter

    # Full-bleed black background
    canvas.setFillColor(PALETTE_BLACK)
    canvas.rect(0, 0, W, H, stroke=0, fill=1)

    # Top yellow accent bar
    canvas.setFillColor(PALETTE_YELLOW)
    canvas.rect(0, H - ACCENT_BAR_HEIGHT, W, ACCENT_BAR_HEIGHT, stroke=0, fill=1)

    # Ghost panther watermark on right side, very low alpha for "barely visible"
    # feel matching Key Personnel reference cover.
    if os.path.exists(PANTHER_HEAD_PATH):
        canvas.saveState()
        try:
            canvas.setFillAlpha(0.22)
            canvas.setStrokeAlpha(0.22)
        except Exception:
            pass
        # Watermark sized to 6.5" square, positioned right-of-center, vertically
        # centered in the upper half of the page (matches reference layout).
        wm_size = 6.5 * inch
        wm_x = W - wm_size + 0.8 * inch  # extends slightly off right edge
        wm_y = H / 2.0 - wm_size / 2.0 + 0.8 * inch
        try:
            canvas.drawImage(PANTHER_HEAD_PATH, wm_x, wm_y,
                             width=wm_size, height=wm_size,
                             mask="auto", preserveAspectRatio=True)
        except Exception:
            pass
        canvas.restoreState()

    # Middle yellow rule (thin horizontal bar spanning most of page width,
    # positioned above the breadcrumb strip)
    canvas.setStrokeColor(PALETTE_YELLOW)
    canvas.setLineWidth(0.75)
    rule_cover_y = 1.05 * inch
    canvas.line(0.75 * inch, rule_cover_y, W - 0.75 * inch, rule_cover_y)

    # Breadcrumb strip on cover (centered)
    canvas.setFillColor(PALETTE_COVER_GRAY)
    canvas.setFont("Helvetica", 8)
    canvas.drawCentredString(W / 2.0, 0.82 * inch, MIDDLE_FOOTER_TEXT)

    # Bottom black footer band (same as content pages)
    canvas.setFillColor(PALETTE_BLACK)
    canvas.rect(0, 0, W, FOOTER_BAND_HEIGHT, stroke=0, fill=1)

    # v6.6: Text baseline lowered from -3 to -5 (moves text down ~2pt for more even
    # visual centering in the band) per user direction 2026-04-19 "words in the band
    # should be moved down slightly ... should be more centered up and down".
    band_text_y = FOOTER_BAND_HEIGHT / 2.0 - 5
    canvas.setFillColor(PALETTE_YELLOW)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(0.45 * inch, band_text_y, FOOTER_BRAND_LEFT)

    brand_width = canvas.stringWidth(FOOTER_BRAND_LEFT, "Helvetica-Bold", 9)
    canvas.setFillColor(PALETTE_WHITE)
    canvas.setFont("Helvetica", 9)
    canvas.drawString(0.45 * inch + brand_width + 6, band_text_y,
                      FOOTER_DOC_BREADCRUMB)

    canvas.setFillColor(PALETTE_WHITE)
    canvas.setFont("Helvetica", 9)
    canvas.drawRightString(W - 0.45 * inch, band_text_y, f"Page {doc.page}")


def on_page(canvas, doc):
    canvas.saveState()
    _draw_content_chrome(canvas, doc)
    canvas.restoreState()


def on_cover(canvas, doc):
    canvas.saveState()
    _draw_cover_chrome(canvas, doc)
    canvas.restoreState()

# ── Helpers ───────────────────────────────────────────────────────────────
def P(text, style=BODY):
    return Paragraph(text, style)

def bullet(text):
    return Paragraph("● " + text, BULLET)

def spacer(h=10):
    return Spacer(1, h)

# ═══════════════════════════════════════════════════════════════════════════
# COVER PAGE (Phase 2 design — Key Personnel template)
# ═══════════════════════════════════════════════════════════════════════════
def build_cover():
    story = []

    # ----- PAGE 1: BLACK COVER (Key Personnel style) -----
    # All v6.1 cover text preserved verbatim; only visual layer + metadata additions.

    # Logo (top-left aligned). Original aspect 2500x1016 (≈2.46:1) -> target 3.5" wide
    # (v6.6: enlarged from 2.0" to 3.25"; v6.6: further enlarged to 3.5" per user direction
    # 2026-04-19 "logo should be a tiny bit bigger").
    if os.path.exists(LOGO_BLACK_BG_PATH):
        logo_w = 3.5 * inch
        logo_h = logo_w * 1016.0 / 2500.0
        logo = RLImage(LOGO_BLACK_BG_PATH, width=logo_w, height=logo_h)
        logo.hAlign = "LEFT"
        story.append(logo)

    # Push title block down into the middle-upper region of the cover.
    # (v6.6: reduced from 1.4" to 1.1" to compensate for larger logo and tighter title.)
    story.append(Spacer(1, 1.1 * inch))

    # Title (white) + subtitle (yellow) — v6.7: subtitle changed to "Private
    # Placement Memorandum" per user direction 2026-04-19 ("we don't say
    # Private Placement Memorandum (PPM) on the front cover as we do with the
    # other docs"). "a Delaware Limited Partnership" preserved as a gray
    # descriptor line below the subtitle so legal descriptor is still on cover.
    story.append(P("PNTHR Tree Fund, LP", COVER_TITLE_WHITE))
    story.append(Spacer(1, 0.14 * inch))
    story.append(P("Private Placement Memorandum", COVER_SUBTITLE_YELLOW))
    story.append(Spacer(1, 0.06 * inch))
    story.append(P("a Delaware Limited Partnership", COVER_META_GRAY))
    story.append(Spacer(1, 0.30 * inch))

    # Meta lines
    story.append(P("DATE:  June 1, 2026", COVER_META_GRAY))
    story.append(P("Document Revision:  v1.1 - June 2026",
                   COVER_META_GRAY))
    story.append(P("Issuer:  PNTHR Funds, LLC (General Partner)", COVER_META_GRAY))

    # v6.7: The "CONFIDENTIAL PRIVATE PLACEMENT MEMORANDUM" notice and
    # risk-of-loss disclosure that previously sat at the bottom of the cover
    # have been moved to page 2 top per user direction 2026-04-19 ("wording
    # at the bottom of the cover page that should instead start at the top
    # of page 2"). The cover now ends cleanly after the meta lines.

    story.append(PageBreak())

    # ----- PAGE 2 ONWARD: STANDARD CONTENT PAGES -----
    # Page 2 opens with the existing "CONFIDENTIAL PRIVATE PLACEMENT
    # MEMORANDUM" header, followed (v6.7) by the risk-of-loss disclosure
    # moved here from the cover, then the v6.1 marketing-style summary.
    story.append(Spacer(1, 0.4 * inch))
    story.append(P("CONFIDENTIAL PRIVATE PLACEMENT MEMORANDUM", COVER_NOTICE))
    # v6.7: risk-of-loss disclosure (from v6.1 cover) placed directly below
    # the CONFIDENTIAL header for natural reading flow.
    story.append(Spacer(1, 0.14 * inch))
    story.append(P(
        "THE INVESTMENT DESCRIBED HEREIN IS HIGHLY SPECULATIVE AND INVOLVES "
        "A HIGH DEGREE OF RISK OF LOSS OF AN INVESTOR'S ENTIRE INVESTMENT. "
        "SEE SECTION IX, &ldquo;RISK FACTORS AND CONFLICTS OF INTEREST.&rdquo;",
        CAPS_BODY))
    story.append(Spacer(1, 0.2 * inch))
    story.append(P("PNTHR FUNDS", TITLE_STYLE))
    story.append(P("PNTHR Tree Fund, LP", TITLE_STYLE))
    story.append(Spacer(1, 0.2 * inch))
    story.append(P("$25,000,000", TITLE_STYLE))
    story.append(P("of", SUBTITLE_STYLE))
    story.append(P("LIMITED PARTNERSHIP INTERESTS", SUBTITLE_STYLE))
    story.append(Spacer(1, 0.25 * inch))
    story.append(P(
        "This confidential private placement memorandum (as it may be amended, "
        "supplemented or modified from time to time, this &ldquo;Memorandum&rdquo;) "
        "is being furnished on a confidential basis by PNTHR Funds, LLC, a Delaware "
        "limited liability company (the &ldquo;General Partner&rdquo;), to a limited "
        "number of sophisticated prospective investors in connection with their "
        "evaluation of a proposed investment in PNTHR Tree Fund, LP, "
        "a Delaware limited partnership (the &ldquo;Partnership&rdquo; or the "
        "&ldquo;Fund&rdquo;).",
        COVER_BODY))
    story.append(P(
        "Each person or entity who invests in the Partnership will acquire limited "
        "partnership interests (&ldquo;Interests&rdquo;) in and will become a limited "
        "partner (a &ldquo;Limited Partner&rdquo;) of the Partnership. The Partnership "
        "seeks to achieve attractive risk-adjusted returns and to preserve investor "
        "capital by investing primarily in a portfolio of publicly traded U.S. equities "
        "and exchange-traded funds (&ldquo;ETFs&rdquo;) using a proprietary systematic "
        "signal engine. The Fund has discretion to take long or short positions in "
        "accordance with the Fund&rsquo;s stated investment strategy.",
        COVER_BODY))
    story.append(P(
        "The General Partner will make all investment decisions on behalf of the "
        "Partnership and has engaged STT Capital Advisors, LLC, a Delaware limited "
        "liability company (the &ldquo;Investment Manager&rdquo;), to serve as "
        "investment manager of the Partnership pursuant to a written Investment "
        "Management Agreement.",
        COVER_BODY))
    story.append(P(
        "Neither the U.S. Securities and Exchange Commission (the &ldquo;SEC&rdquo;) "
        "nor any other federal, state, or foreign securities commission or similar "
        "authority has determined whether this Memorandum is truthful or complete. "
        "Any representation to the contrary is a criminal offense.",
        COVER_BODY))
    story.append(P(
        "The Interests are being offered privately and have not been registered under "
        "the Securities Act of 1933, as amended (the &ldquo;Securities Act&rdquo;), or "
        "the securities laws of any state or country in reliance on exemptions from the "
        "registration requirements of such laws. There is no public market for the "
        "Interests, and the Interests are subject to significant restrictions on transfer. "
        "Each purchaser of the Interests offered hereunder must qualify as a "
        "&ldquo;qualified client&rdquo; as such term is defined in Rule 205-3 promulgated "
        "by the SEC under the U.S. Investment Advisers Act of 1940, as amended, and as "
        "an &ldquo;accredited investor&rdquo; as such term is defined in Rule 501(a) of "
        "Regulation D under the Securities Act.",
        COVER_BODY))
    story.append(P(
        "An investment in the Interests involves significant risk. Investors should "
        "have the financial ability and willingness to accept the risks and conflicts "
        "of interest which are characteristic of the investments described in this "
        "Memorandum.",
        COVER_BODY))
    story.append(Spacer(1, 0.2 * inch))
    story.append(P("Inquiries should be directed to:", SUBTITLE_STYLE))
    story.append(P("PNTHR Funds, LLC", SUBTITLE_STYLE))
    story.append(P("15150 W Park Place, Suite 215", SUBTITLE_STYLE))
    story.append(P("Goodyear, AZ 85395", SUBTITLE_STYLE))
    story.append(P("Email: info@PNTHRfunds.com", SUBTITLE_STYLE))
    story.append(P("Phone: 602-810-1940", SUBTITLE_STYLE))
    story.append(Spacer(1, 0.1 * inch))
    story.append(P("This Memorandum is dated June 1, 2026", SUBTITLE_STYLE))
    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# TABLE OF CONTENTS
# ═══════════════════════════════════════════════════════════════════════════
def build_toc():
    story = []
    story.append(P("TABLE OF CONTENTS", H1))
    story.append(spacer(6))
    # Static TOC — page numbers are approximate and will be validated before Phase 2.
    entries = [
        ("2.  Certain Notices to Investors", ""),
        ("I.  Executive Summary", ""),
        ("II.  Summary of Terms", ""),
        ("III.  Investment Opportunity and Market Environment", ""),
        ("IV.  Investment Strategy", ""),
        ("V.  Investment Process", ""),
        ("VI.  General Partner, Investment Manager, and Management", ""),
        ("VII.  Detailed Summary of Terms", ""),
        ("VIII.  Risk Factors and Conflicts of Interest", ""),
        ("IX.  Certain Tax and Regulatory Matters", ""),
        ("X.  Investor Suitability Standards", ""),
        ("XI.  Subscription Procedure", ""),
        ("XII.  Additional Information", ""),
        ("Exhibit A: Subscription Agreement", ""),
        ("Exhibit B: Limited Partnership Agreement", ""),
    ]
    tdata = [[e[0], e[1]] for e in entries]
    tbl = Table(tdata, colWidths=[5.5 * inch, 0.5 * inch])
    tbl.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, -1), "Helvetica", 11),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(tbl)
    story.append(spacer(18))
    story.append(P(
        "<i>Page numbers are populated in the final branded production of this "
        "Memorandum. In this legal-content version, sections are referenced by "
        "numeral and title only.</i>",
        FOOTNOTE))
    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# SECTION 2 — CERTAIN NOTICES TO INVESTORS
# ═══════════════════════════════════════════════════════════════════════════
NOTICES_PARAS = [
    "THIS CONFIDENTIAL PRIVATE PLACEMENT MEMORANDUM (THE &ldquo;MEMORANDUM&rdquo;) IS BEING "
    "FURNISHED TO A LIMITED NUMBER OF SOPHISTICATED INVESTORS ON A CONFIDENTIAL BASIS FOR THE "
    "SOLE PURPOSE OF EVALUATING AN INVESTMENT IN LIMITED PARTNERSHIP INTERESTS (THE "
    "&ldquo;INTERESTS&rdquo;) IN PNTHR TREE FUND, LP (THE &ldquo;FUND&rdquo;) "
    "AND MAY NOT BE USED FOR ANY OTHER PURPOSE. THE MEMORANDUM MAY NOT BE REPRODUCED OR PROVIDED "
    "TO ANY OTHER PERSON WITHOUT THE PRIOR WRITTEN CONSENT OF THE GENERAL PARTNER.",

    "THE INTERESTS OFFERED HEREUNDER ARE BEING OFFERED PURSUANT TO RULE 506(c) OF REGULATION D "
    "UNDER SECTION 4(a)(2) OF THE SECURITIES ACT OF 1933, AS AMENDED (THE &ldquo;SECURITIES "
    "ACT&rdquo;). THE FUND RELIES ON THE EXEMPTION FROM REGISTRATION AS AN INVESTMENT COMPANY "
    "PROVIDED BY SECTION 3(c)(1) OF THE INVESTMENT COMPANY ACT OF 1940, AS AMENDED (THE "
    "&ldquo;INVESTMENT COMPANY ACT&rdquo;).",

    "THE INTERESTS HAVE NOT BEEN APPROVED OR DISAPPROVED BY THE U.S. SECURITIES AND EXCHANGE "
    "COMMISSION (THE &ldquo;SEC&rdquo;) OR BY ANY STATE SECURITIES COMMISSION, NOR HAS ANY "
    "AUTHORITY PASSED UPON THE ACCURACY OR ADEQUACY OF THIS MEMORANDUM. ANY REPRESENTATION TO "
    "THE CONTRARY IS A CRIMINAL OFFENSE.",

    "THE INTERESTS HAVE NOT BEEN REGISTERED UNDER THE SECURITIES ACT, THE SECURITIES LAWS OF "
    "ANY STATE, OR THE SECURITIES LAWS OF ANY OTHER JURISDICTION, AND ARE BEING OFFERED AND "
    "SOLD IN RELIANCE ON EXEMPTIONS FROM THE REGISTRATION REQUIREMENTS OF SUCH LAWS. THE "
    "INTERESTS ARE NOT TRANSFERABLE EXCEPT AS PERMITTED UNDER THE PARTNERSHIP AGREEMENT AND "
    "APPLICABLE SECURITIES LAWS. INVESTORS MUST BE PREPARED TO BEAR THE ECONOMIC RISK OF THE "
    "INVESTMENT FOR AN INDEFINITE PERIOD.",

    "EACH PROSPECTIVE INVESTOR MUST QUALIFY AS AN &ldquo;ACCREDITED INVESTOR&rdquo; AS "
    "DEFINED IN RULE 501(a) OF REGULATION D UNDER THE SECURITIES ACT AND AS A "
    "&ldquo;QUALIFIED CLIENT&rdquo; AS DEFINED IN RULE 205-3 UNDER THE INVESTMENT ADVISERS ACT "
    "OF 1940, AS AMENDED (THE &ldquo;ADVISERS ACT&rdquo;). BECAUSE THE FUND RELIES ON RULE "
    "506(c), THE GENERAL PARTNER IS REQUIRED TO TAKE REASONABLE STEPS TO VERIFY EACH "
    "PROSPECTIVE INVESTOR&rsquo;S ACCREDITED INVESTOR STATUS. SELF-CERTIFICATION ALONE IS NOT "
    "SUFFICIENT.",

    "THE FUND IS STRUCTURED AS A SECTION 3(c)(1) FUND AND IS LIMITED TO NO MORE THAN 100 "
    "BENEFICIAL OWNERS. ADMISSION AS A LIMITED PARTNER IS SUBJECT TO, AMONG OTHER THINGS, "
    "ACCEPTANCE BY THE GENERAL PARTNER IN ITS SOLE AND ABSOLUTE DISCRETION AND COMPLIANCE WITH "
    "APPLICABLE SECURITIES AND ANTI-MONEY LAUNDERING LAWS.",

    "THE INFORMATION CONTAINED HEREIN IS PROVIDED AS OF THE DATE SET FORTH ON THE COVER AND "
    "IS SUBJECT TO UPDATE, MODIFICATION, OR AMENDMENT WITHOUT NOTICE. THIS MEMORANDUM "
    "SUPERSEDES ALL PRIOR PRIVATE PLACEMENT MEMORANDA AND SUMMARIES PREVIOUSLY PROVIDED TO "
    "PROSPECTIVE INVESTORS.",

    "THIS MEMORANDUM DOES NOT CONSTITUTE AN OFFER OR SOLICITATION IN ANY JURISDICTION IN "
    "WHICH SUCH OFFER OR SOLICITATION IS UNAUTHORIZED OR TO ANY PERSON TO WHOM IT IS UNLAWFUL "
    "TO MAKE SUCH OFFER OR SOLICITATION. THE GENERAL PARTNER MAY REJECT ANY SUBSCRIPTION IN "
    "WHOLE OR IN PART IN ITS SOLE AND ABSOLUTE DISCRETION.",

    "FORWARD-LOOKING STATEMENTS. THIS MEMORANDUM MAY CONTAIN FORWARD-LOOKING STATEMENTS, "
    "PROJECTIONS, OR ESTIMATES. ALL SUCH STATEMENTS ARE SUBJECT TO MATERIAL RISKS AND "
    "UNCERTAINTIES THAT MAY CAUSE ACTUAL RESULTS TO DIFFER MATERIALLY. WORDS SUCH AS "
    "&ldquo;EXPECT,&rdquo; &ldquo;TARGET,&rdquo; &ldquo;ANTICIPATE,&rdquo; AND "
    "&ldquo;PROJECT&rdquo; IDENTIFY FORWARD-LOOKING STATEMENTS. PAST PERFORMANCE OR "
    "BACKTESTED RESULTS ARE NOT A GUARANTEE OF FUTURE RESULTS.",

    "NO RELIANCE. PROSPECTIVE INVESTORS MAY NOT RELY ON THIS MEMORANDUM IN MAKING AN "
    "INVESTMENT DECISION. RELIANCE SHOULD BE PLACED ONLY ON THE FUND&rsquo;S FINAL OFFERING "
    "DOCUMENTS, INCLUDING THE SUBSCRIPTION AGREEMENT, THE AMENDED AND RESTATED LIMITED "
    "PARTNERSHIP AGREEMENT, AND ANY EXHIBITS ATTACHED HERETO, AS SUPPLEMENTED BY THE ADVICE "
    "OF EACH INVESTOR&rsquo;S OWN QUALIFIED LEGAL, TAX, AND FINANCIAL ADVISORS.",

    "ARIZONA NOTICE FILING. THE FUND HAS MADE, OR WILL MAKE, A NOTICE FILING IN THE STATE OF "
    "ARIZONA IN CONNECTION WITH THE OFFERING OF INTERESTS.",

    "CONFIDENTIALITY. THIS MEMORANDUM IS CONFIDENTIAL. THE RECIPIENT MAY NOT REPRODUCE, "
    "DISTRIBUTE, OR DISCLOSE THIS MEMORANDUM OR ITS CONTENTS TO ANY OTHER PERSON WITHOUT THE "
    "PRIOR WRITTEN CONSENT OF THE GENERAL PARTNER. UNAUTHORIZED DISCLOSURE MAY EXPOSE THE "
    "DISCLOSER TO LEGAL ACTION.",
]


def build_notices():
    story = []
    story.append(P("2.  CERTAIN NOTICES TO INVESTORS", H1))
    for para in NOTICES_PARAS:
        story.append(P(para, CAPS_BODY))
    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# SECTION I — EXECUTIVE SUMMARY
# ═══════════════════════════════════════════════════════════════════════════
def build_executive_summary():
    story = []
    story.append(P("I.  EXECUTIVE SUMMARY", H1))

    story.append(P(
        "PNTHR Tree Fund, LP (the &ldquo;Partnership&rdquo; or the "
        "&ldquo;Fund&rdquo;), launched by PNTHR Funds, LLC (the &ldquo;General Partner&rdquo;), "
        "is a private investment vehicle organized as a Delaware limited partnership. The "
        "Fund is focused on achieving attractive risk-adjusted returns and preserving "
        "investor capital through the systematic application of an internally developed "
        "long/short U.S. equity strategy.",
        BODY))

    story.append(P(
        "The Partnership seeks capital from qualified investors for the purchase of "
        "limited partnership interests (the &ldquo;Interests&rdquo;) in the Partnership. "
        "Each person or entity who invests in the Partnership will become a limited "
        "partner (each a &ldquo;Limited Partner&rdquo;).",
        BODY))

    story.append(P(
        "The Fund is a thematic long/short equity strategy designed to capture the "
        "secular growth and periodic dislocations within the artificial-intelligence "
        "value chain. The Fund invests exclusively in a proprietary universe of "
        "approximately 303 liquid U.S.-listed equities whose core revenue, product "
        "roadmap, or infrastructure function is materially leveraged to the AI "
        "super-cycle (the &ldquo;PNTHR AI 300 Universe&rdquo;). The Universe spans "
        "sixteen (16) proprietary AI sub-sectors -from semiconductors and chip "
        "design through cloud infrastructure, autonomous systems, cybersecurity, "
        "enterprise software, and quantum computing -and is benchmarked against "
        "the PNTHR AI 300 Index (&ldquo;PAI300&rdquo;), a capped market-capitalization-"
        "weighted proprietary index maintained by the Investment Manager.",
        BODY))

    story.append(P(
        "The Fund employs the PNTHR Signal System, a proprietary systematic signal "
        "engine that initiates a position when a security in the Universe trades to a new "
        "multi-month price high, confirming a momentum breakout, and thereafter manages "
        "that position under a single ratcheting trailing stop. Entries are taken at the "
        "breakout level as a resting buy-stop order and established at full size, with no "
        "scaling or pyramiding, each sized to a fixed risk budget per position. The "
        "Strategy does not apply a market-wide or sector regime gate. The Fund is "
        "authorized as a long/short strategy; its current systematic implementation is "
        "long-only. The specific parameters, formulas, and thresholds that constitute the "
        "PNTHR Signal System are proprietary and are not disclosed in this Memorandum. The "
        "Fund&rsquo;s investment strategy is described in greater detail in Section IV "
        "(Investment Strategy) and Section V (Investment Process).",
        BODY))

    story.append(P(
        "The Fund is offered exclusively to investors who qualify as "
        "&ldquo;accredited investors&rdquo; as defined in Rule 501(a) of Regulation D "
        "under the Securities Act and as &ldquo;qualified clients&rdquo; as defined in "
        "Rule 205-3 under the Investment Advisers Act of 1940. A &ldquo;qualified "
        "client&rdquo; generally includes a natural person whose net worth (together with "
        "the net worth of that person&rsquo;s spouse or spousal equivalent, and excluding "
        "the value of the primary residence) exceeds $2,700,000 immediately prior to "
        "entering into an advisory contract, or who has at least $1,400,000 under the "
        "management of the Investment Manager.",
        BODY))

    story.append(P(
        "The Fund is structured to benefit from nimble execution unavailable to larger "
        "pools of capital. By maintaining a smaller, operationally focused fund the "
        "Investment Manager seeks to enter and exit positions at the pace that signal "
        "generation dictates, without the market impact that constrains multi-billion-"
        "dollar strategies.",
        BODY))

    story.append(P(
        "Capital preservation is a core pillar. The Fund risks no more than 2% of Net "
        "Asset Value per position, constrains total single-name exposure to 10% of Net "
        "Asset Value at entry, and operates under a single disciplined trailing stop that "
        "ratchets only in the direction of the trade, supplemented by a break-even "
        "protection rule. Aggregate gross exposure is subject to a hard cap of two times "
        "(2.0x) Net Asset Value, suspending new entries when that limit is reached. Each "
        "entry is further capped at a fraction of the security&rsquo;s recent average "
        "daily trading volume to preserve executability as Fund assets grow.",
        BODY))

    story.append(P(
        "The General Partner, PNTHR Funds, LLC, is a Delaware limited liability company. "
        "Its Managers are Scott R. McBrien and Cindy Eagar. The General Partner has "
        "engaged STT Capital Advisors, LLC, a Delaware limited liability company (the "
        "&ldquo;Investment Manager&rdquo;), to serve as investment manager of the "
        "Partnership pursuant to a written Investment Management Agreement.",
        BODY))

    story.append(P("INVESTMENT OBJECTIVE HIGHLIGHTS", H2))

    story.append(P(
        "The Partnership&rsquo;s objectives with respect to capital deployed from this "
        "Offering are expected to:",
        BODY))

    story.append(bullet(
        "Preserve and protect each Limited Partner&rsquo;s contributed capital through "
        "disciplined risk-based position sizing, a single ratcheting trailing stop with "
        "break-even protection, and a hard 2.0x gross-exposure cap;"))

    story.append(bullet(
        "Generate returns in excess of the annualized U.S. 2-Year Treasury yield (the "
        "&ldquo;Hurdle Rate&rdquo;), as determined at the close of the first trading day "
        "of each Fiscal Year, subject to a high-water mark and a loss-recovery account as "
        "described in Section VII (Detailed Summary of Terms);"))

    story.append(bullet(
        "Reinvest, at the Investment Manager&rsquo;s sole discretion, net cash flows, "
        "realized gains, and exit proceeds into subsequent trading opportunities to "
        "compound returns for Limited Partners, subject to redemption activity;"))

    story.append(bullet(
        "Ultimately provide Limited Partners with a full return of their capital "
        "contributions and any Net Profits allocated to their Capital Accounts, net of "
        "Management Fees, Performance Allocations, fund expenses, and withdrawals. No "
        "assurance can be given that these objectives will be attained or that a Limited "
        "Partner&rsquo;s capital will not decrease."))

    story.append(P("INVESTMENT OPPORTUNITY HIGHLIGHTS", H2))

    story.append(P(
        "The General Partner believes that the convergence of a secular AI growth theme "
        "with a disciplined systematic execution framework provides the Partnership "
        "a durable competitive advantage. The Investment presents a differentiated "
        "opportunity because:",
        BODY))

    story.append(bullet(
        "<b>The Fund captures the full AI value chain.</b> Rather than concentrating in "
        "a handful of mega-cap hyperscalers, the Fund&rsquo;s 303-name universe spans "
        "the entire AI technology stack -from semiconductor fabrication and chip "
        "design through data-center infrastructure, networking, autonomous systems, "
        "enterprise software, cybersecurity, and quantum computing -providing "
        "diversified exposure to AI adoption regardless of which layer of the stack "
        "leads in any given cycle;"))

    story.append(bullet(
        "<b>The Fund is benchmarked to its own universe, not to broad indices.</b> The "
        "proprietary PNTHR AI 300 Index (PAI300) serves as the Fund&rsquo;s performance "
        "benchmark, situating results against the AI sector itself rather than the broader "
        "equity market;"))

    story.append(bullet(
        "<b>A single, uniform breakout rule across the universe.</b> The Signal System "
        "applies one consistent new-high breakout test and one trailing-stop discipline to "
        "every name in the Universe, avoiding the curve-fitting risk of per-name or "
        "per-sector parameter tuning;"))

    story.append(bullet(
        "<b>The signal engine has been developed through multiple years of research and "
        "out-of-sample refinement,</b> applying single-name momentum-breakout analysis to "
        "surface opportunities across all sixteen AI sub-sectors of the Universe;"))

    story.append(bullet(
        "<b>Rigorous risk discipline governs every position.</b> Full-size entry at a "
        "fixed per-position risk budget, a 10% single-name concentration limit, a single "
        "ratcheting trailing stop with break-even protection, and a hard 2.0x "
        "gross-exposure cap are designed to preserve capital and limit drawdowns "
        "regardless of market conditions."))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# SECTION II — SUMMARY OF TERMS
# ═══════════════════════════════════════════════════════════════════════════
def build_summary_of_terms():
    story = []
    story.append(P("II.  SUMMARY OF TERMS", H1))

    story.append(P(
        "The following is a summary of the key terms on which the General Partner will "
        "offer and sell the Interests of the Partnership. Capitalized terms not defined "
        "below shall have the meanings set forth in Section VII, &ldquo;DETAILED "
        "SUMMARY OF TERMS.&rdquo; This summary is qualified in its entirety by reference "
        "to the more detailed description in Section VII and to the Limited "
        "Partnership Agreement of the Fund (the &ldquo;Partnership Agreement&rdquo;).",
        BODY))

    # Summary-of-Terms table: label | value
    rows = [
        ("Partnership",
         "PNTHR Tree Fund, LP, a Delaware limited partnership."),
        ("General Partner",
         "PNTHR Funds, LLC, a Delaware limited liability company."),
        ("Investment Manager",
         "STT Capital Advisors, LLC, a Delaware limited liability company, engaged "
         "pursuant to a written Investment Management Agreement."),
        ("Offering",
         "Limited Partnership Interests are offered in accordance with Section 4(a)(2) "
         "of the Securities Act and Rule 506(c) of Regulation D thereunder."),
        ("Offering Size",
         "$25,000,000 aggregate Limited Partnership Interests. The General Partner may, "
         "in its sole and absolute discretion, increase the Offering Size by filing an "
         "amended Form D and updating this Memorandum."),
        ("Investment Company Act",
         "The Fund relies on the exemption from registration provided by Section 3(c)(1) "
         "of the Investment Company Act of 1940, and is limited to no more than 100 "
         "beneficial owners."),
        ("Investor Qualifications",
         "Each prospective investor must qualify as an &ldquo;accredited investor&rdquo; "
         "(Rule 501(a), Regulation D) AND a &ldquo;qualified client&rdquo; (Rule 205-3, "
         "Advisers Act). Verification under Rule 506(c) is required prior to admission."),
        ("Minimum Investment",
         "$100,000, subject to the General Partner&rsquo;s sole and absolute discretion "
         "to accept a lesser amount."),
        ("Investor Classes",
         "Three classes of Limited Partnership Interests are offered: "
         "<b>Wagyu Interests</b> (Capital Commitment at or above $1,000,000); "
         "<b>Porterhouse Interests</b> ($500,000 to $999,999); and "
         "<b>Filet Interests</b> ($100,000 to $499,999)."),
        ("Management Fee",
         "2.00% per annum on Net Asset Value, accrued monthly and paid quarterly in "
         "advance, payable to the Investment Manager."),
        ("Performance Allocation",
         "Tiered by investor class and subject to the Hurdle Rate and the High Water Mark: "
         "Wagyu Interests 20%; Porterhouse Interests 25%; Filet Interests 30%. A permanent "
         "5-percentage-point reduction in the Performance Allocation rate applies to any "
         "Limited Partner&rsquo;s Capital Account that has remained invested in the Fund "
         "continuously for thirty-six (36) consecutive months (Wagyu 15%, Porterhouse 20%, "
         "Filet 25%)."),
        ("Hurdle Rate",
         "The annualized yield on the U.S. 2-Year Treasury Note (&ldquo;US2Y&rdquo;), "
         "determined as of the close of the first trading day of each Fiscal Year. The "
         "quarterly Hurdle is equal to the annualized US2Y yield divided by four, applied "
         "at the end of each calendar quarter, and is <i>not</i> cumulative across "
         "calendar quarters or Fiscal Years."),
        ("High Water Mark &amp; Loss Recovery",
         "The Performance Allocation is subject to a High Water Mark. In addition, each "
         "Limited Partner&rsquo;s Capital Account maintains a Loss Recovery Account: "
         "losses allocated to a Limited Partner&rsquo;s Capital Account in any calendar "
         "quarter must be recovered in full through subsequent Net Profits before any "
         "Performance Allocation accrues in subsequent calendar quarters."),
        ("Term",
         "Perpetual, open-ended Fund, unless earlier dissolved pursuant to the "
         "Partnership Agreement."),
        ("Lock-Up Period",
         "One (1) year from the date of a Limited Partner&rsquo;s initial admission "
         "(or additional Capital Contribution, as applicable)."),
        ("Liquidity / Withdrawals",
         "Quarterly, as of the last day of each calendar quarter, upon at least sixty (60) "
         "days&rsquo; prior written notice, subject to the Lock-Up Period, the Withdrawal "
         "Gate, and the Audit Holdback described below."),
        ("Early-Withdrawal Penalty",
         "25% of the amount withdrawn, applicable if a withdrawal is approved by the "
         "General Partner during a Limited Partner&rsquo;s Lock-Up Period."),
        ("Minimum Withdrawal",
         "$25,000. A Limited Partner may not reduce its Capital Account balance below "
         "$50,000 through partial withdrawals."),
        ("Withdrawal Gate",
         "If total withdrawal requests on any Withdrawal Date exceed 25% of the "
         "Fund&rsquo;s Net Asset Value, all requesting Limited Partners will receive a "
         "prorated withdrawal amount. Deferred amounts are processed over a maximum of "
         "three (3) subsequent Withdrawal Dates."),
        ("Audit Holdback",
         "A Limited Partner withdrawing 90% or more of its Capital Account will be paid "
         "90% of the estimated withdrawal amount within thirty (30) days. The remaining "
         "10% will be held back pending completion of the annual audit and released "
         "within thirty (30) days of completion of such audit."),
        ("Leverage",
         "The Investment Manager may use leverage of up to 2:1 gross exposure in pursuit "
         "of the Fund&rsquo;s investment strategy."),
        ("Distributions",
         "The General Partner expects to reinvest net profits of the Fund. Cash "
         "distributions may be made at certain intervals in the General Partner&rsquo;s "
         "sole discretion."),
        ("Prime Broker / Custodian",
         "Interactive Brokers LLC. The Fund&rsquo;s assets are held in custody with "
         "Interactive Brokers in a segregated account."),
        ("Administrator",
         "NAV Consulting, Inc."),
        ("Independent Auditor",
         "The Fund intends to engage Spicer Jeffries LLP as its independent auditor prior "
         "to the admission of any non-affiliated Limited Partner. As of the date of this "
         "Memorandum, no audit engagement has been finalized."),
        ("Legal Counsel",
         "David S. Hunt, P.C. (Salt Lake City, Utah)."),
        ("General Partner Commitment",
         "$100,000 initial capital commitment. The General Partner may contribute "
         "additional capital in any amount in its sole and absolute discretion."),
        ("Governing Law",
         "State of Delaware."),
        ("Dispute Resolution",
         "Binding arbitration administered by the American Arbitration Association "
         "(AAA) under its Commercial Arbitration Rules, held in the State of Delaware, "
         "before a single arbitrator selected from the AAA&rsquo;s roster. The prevailing "
         "party shall be awarded its reasonable costs and attorneys&rsquo; fees."),
    ]

    label_style = ParagraphStyle(
        name="tbl_label", fontName="Helvetica-Bold", fontSize=11, leading=14,
        alignment=TA_LEFT, spaceBefore=0, spaceAfter=0,
    )
    value_style = ParagraphStyle(
        name="tbl_value", fontName="Helvetica", fontSize=11, leading=14,
        alignment=TA_LEFT, spaceBefore=0, spaceAfter=0,
    )
    for label, value in rows:
        tbl = Table(
            [[Paragraph(label, label_style), Paragraph(value, value_style)]],
            colWidths=[2.2 * inch, 3.8 * inch],
        )
        tbl.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.append(tbl)
    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# SECTION III — INVESTMENT OPPORTUNITY AND MARKET ENVIRONMENT
# ═══════════════════════════════════════════════════════════════════════════
def build_investment_opportunity():
    story = []
    story.append(P("III.  INVESTMENT OPPORTUNITY AND MARKET ENVIRONMENT", H1))

    story.append(P(
        "The following section sets forth the General Partner&rsquo;s view of the "
        "current market environment and the opportunities it believes the Fund is "
        "positioned to capture. All opinions expressed herein are those of the General "
        "Partner except where attributed to an external source. No assurance can be "
        "given as to the availability of any opportunity or the realization of any "
        "particular outcome. Prospective investors are encouraged to rely on their own "
        "examination of the underlying market and economic conditions, the merits and "
        "risks involved with an investment in the Partnership, and the terms of the "
        "offering as described in this Memorandum prior to investing in the Interests.",
        BODY))

    story.append(P(
        "The General Partner believes that the artificial-intelligence sector represents "
        "the most significant structural investment opportunity since the advent of cloud "
        "computing, and that current market conditions, characterized by rapid capital "
        "deployment, AI infrastructure buildout, and widening dispersion among AI-related "
        "equities, present favorable conditions for a systematic long/short strategy "
        "focused exclusively on the AI value chain.",
        BODY))

    story.append(P(
        "<b>The AI super-cycle is early and accelerating.</b> Global enterprise spending "
        "on AI infrastructure, software, and services has expanded rapidly, driven by "
        "hyperscaler capital expenditure on GPU clusters, data-center construction, and "
        "foundation-model training. This capital deployment is cascading through the "
        "technology stack, from semiconductor fabrication and chip design to networking "
        "equipment, power infrastructure, cooling systems, enterprise software platforms, "
        "and end-market applications in cybersecurity, autonomous systems, biotechnology, "
        "and financial technology. The General Partner believes this multi-year buildout "
        "cycle will generate sustained investment opportunities across all sixteen of the "
        "Fund&rsquo;s AI sub-sectors.",
        BODY))

    story.append(P(
        "<b>Dispersion within AI equities favors active, systematic selection.</b> While "
        "broad AI exposure through passive thematic ETFs captures headline sector returns, "
        "the performance dispersion among individual AI-related equities is substantial. "
        "In any given quarter, top-performing AI names may appreciate significantly while "
        "lagging names decline, even within the same sub-sector. The Fund&rsquo;s "
        "systematic breakout engine is designed to identify which names are "
        "exhibiting confirmed upside momentum and to own those names while avoiding "
        "those exhibiting structural deterioration, an advantage unavailable to "
        "passive, market-cap-weighted AI exposure.",
        BODY))

    story.append(P(
        "<b>Existing AI investment vehicles are narrow and rigid.</b> The largest publicly "
        "available AI-themed ETFs typically hold between 45 and 110 names and concentrate "
        "heavily in mega-cap hyperscalers. The Fund&rsquo;s universe of approximately 300 "
        "names is roughly three to seven times broader than any single AI ETF and spans "
        "the full technology stack from silicon to software. Rather than passively holding "
        "a fixed, market-cap-weighted basket, the Fund actively buys names breaking out to "
        "new highs and exits names that break down, a discipline the General Partner "
        "believes is not available through any existing public AI vehicle.",
        BODY))

    story.append(P(
        "<b>Macro and geopolitical factors amplify AI-sector volatility.</b> Federal "
        "Reserve interest rate policy, inflation regimes, U.S.-China semiconductor export "
        "controls, and evolving AI regulation create persistent sources of volatility "
        "within AI equities specifically. These factors can cause rapid rotation among AI "
        "sub-sectors; for example, tightening export controls may benefit domestic chip "
        "fabricators while pressuring companies reliant on Chinese revenue. The "
        "Fund&rsquo;s systematic, rules-based breakout framework is designed to "
        "participate in the strongest-trending AI names as these rotations unfold, more "
        "consistently than discretionary approaches.",
        BODY))

    story.append(P(
        "The Investment Manager will make Portfolio Investments primarily in publicly "
        "traded U.S. equities within the PNTHR AI 300 Universe. When certain market "
        "conditions warrant, the Investment Manager may also hold cash and cash "
        "equivalents, U.S. Treasury instruments, or short-term fixed-income positions, "
        "in each case at the Investment Manager&rsquo;s discretion and consistent with "
        "the Fund&rsquo;s stated investment strategy.",
        BODY))

    story.append(P(
        "The primary objective of the Fund is to deliver superior risk-adjusted returns "
        "by applying the PNTHR Signal System to the PNTHR AI 300 Universe. The Fund "
        "seeks to outperform broad AI-sector benchmarks on a net-of-fees basis while "
        "maintaining disciplined position-level risk controls. The Fund pursues these "
        "objectives through a systematic, signal-driven approach rather than "
        "discretionary stock-picking.",
        BODY))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# SECTION IV — INVESTMENT STRATEGY (PNTHR Signal System full description)
# ═══════════════════════════════════════════════════════════════════════════
def build_investment_strategy():
    story = []
    story.append(P("IV.  INVESTMENT STRATEGY", H1))

    story.append(P(
        "The Fund&rsquo;s investment strategy (the &ldquo;Strategy&rdquo;) is a "
        "systematic momentum-breakout equity approach built on the PNTHR Tree Signal "
        "System (the &ldquo;Signal System&rdquo;), a proprietary signal-generation and "
        "execution framework developed by the Investment Manager for the "
        "artificial-intelligence equity ecosystem. The Strategy is authorized as a "
        "long/short equity strategy; its current systematic implementation is long-only "
        "and initiates positions when a security in the PNTHR AI 300 Universe trades to a "
        "new multi-month price high, managing each position thereafter under a rules-based "
        "trailing-stop discipline. The Strategy applies rules-based price-breakout entry "
        "criteria, a single ratcheting trailing-stop exit framework, and disciplined "
        "risk-based position sizing to the PNTHR AI 300 Universe. The Strategy was "
        "developed and confirmed through multiple years of historical backtesting and "
        "ongoing out-of-sample research across AI-sector market cycles, including the "
        "2022-2023 AI drawdown and the subsequent AI infrastructure buildout, and is the "
        "exclusive investment strategy of the Fund.",
        BODY))

    story.append(P("CONFIDENTIAL PROPRIETARY METHODOLOGY", H2))

    story.append(P(
        "The Investment Manager does not disclose, and expressly reserves, the specific "
        "parameters, formulas, thresholds, weights, and timeframe specifications that "
        "constitute the Signal System. The descriptions that follow are intended to "
        "give prospective investors a sufficient understanding of the Strategy&rsquo;s "
        "architecture and risk framework to make an informed investment decision without "
        "compromising the Investment Manager&rsquo;s proprietary research and "
        "intellectual property. Investors relying on this Memorandum should consider "
        "the Signal System a confidential systematic model whose internal construction "
        "is not disclosed.",
        BODY))

    story.append(P("THE PNTHR AI 300 UNIVERSE", H2))

    story.append(P(
        "The Strategy draws from a curated universe of approximately 303 liquid U.S.-"
        "listed equities concentrated in the artificial-intelligence value chain (the "
        "&ldquo;PNTHR AI 300 Universe&rdquo; or the &ldquo;Universe&rdquo;). The Universe "
        "is organized into sixteen (16) proprietary AI sub-sectors that span the full AI "
        "technology stack:",
        BODY))

    story.append(bullet("AI Semiconductors &amp; Chip Design;"))
    story.append(bullet("Semiconductor Equipment &amp; EDA;"))
    story.append(bullet("Data Infrastructure (data centers, GPU hosting, Bitcoin miners);"))
    story.append(bullet("AI Infrastructure &amp; Power (nuclear, utilities, grid);"))
    story.append(bullet("Networking &amp; Connectivity;"))
    story.append(bullet("Autonomous Systems &amp; Robotics;"))
    story.append(bullet("Cloud &amp; Hyperscale;"))
    story.append(bullet("Cybersecurity;"))
    story.append(bullet("AdTech &amp; Digital Media;"))
    story.append(bullet("Enterprise SaaS;"))
    story.append(bullet("AI Fintech &amp; Platforms;"))
    story.append(bullet("Space &amp; Satellite AI;"))
    story.append(bullet("Defense &amp; Government AI;"))
    story.append(bullet("AI Biotech;"))
    story.append(bullet("Global AI Leaders; and"))
    story.append(bullet("Quantum Computing."))

    story.append(P(
        "By constructing the Universe around the AI value chain, the Fund invests in "
        "companies that are building, enabling, or deploying artificial-intelligence "
        "technologies. All securities in the Universe meet established listing, "
        "liquidity, and financial-reporting standards. Securities in the Universe are "
        "further filtered and maintained by the Investment Manager on the basis of "
        "liquidity, trading volume, market capitalization, and data integrity. The "
        "Investment Manager periodically reviews the composition of the Universe and "
        "may, in its sole discretion, add, remove, or temporarily suspend securities "
        "from the Universe based on corporate actions, changes "
        "in fundamental characteristics, or data quality. In addition, the Investment "
        "Manager may, in its sole discretion and on an extraordinary basis, add "
        "additional liquid U.S.-listed securities to the Universe to capture unique "
        "investment opportunities, subject to all applicable Strategy-level rules and "
        "risk limits described in this Memorandum.",
        BODY))

    story.append(P("THE NEW-HIGH BREAKOUT ENTRY SIGNAL", H2))

    story.append(P(
        "The Strategy&rsquo;s core entry signal is a price breakout to a new multi-month "
        "high. Each trading day, the Investment Manager evaluates every security in the "
        "Universe against its own prior trading range. A long entry signal (a &ldquo;Buy "
        "Long&rdquo; or &ldquo;BL&rdquo; Signal) is generated when a security trades above "
        "the highest intraday high it recorded over a proprietary multi-month lookback "
        "window (excluding the current trading day), confirming a breakout to a new high. "
        "Entry is modeled and executed as a resting buy-stop order at the breakout level, "
        "filled at that level or, in the event of an opening gap above it, at the opening "
        "price. The Strategy uses only price information available at or before the moment "
        "of entry and does not rely on forward-looking data. The Strategy does not employ "
        "a market-wide or sector regime gate; qualifying breakouts are eligible in any "
        "market environment, subject to the portfolio-level risk controls described below.",
        BODY))

    story.append(P("DIRECTIONAL MANDATE (LONG/SHORT AUTHORIZATION)", H2))

    story.append(P(
        "The Fund is authorized to take both long and short positions in the Universe at "
        "the Investment Manager&rsquo;s discretion. The Strategy&rsquo;s current systematic "
        "implementation is LONG-ONLY: it initiates long positions on confirmed new-high "
        "breakouts and does not at present initiate short positions. Consistent with the "
        "Fund&rsquo;s long/short mandate, the Investment Manager reserves the right, in its "
        "sole discretion, to implement a short component (a &ldquo;Sell Short&rdquo; or "
        "&ldquo;SS&rdquo; Signal generated on a confirmed breakdown to a new multi-month "
        "low). Any material change to the directional implementation of the Strategy would "
        "be effected consistent with this Memorandum and applicable law. Performance "
        "information presented in connection with the Fund reflects the long-only "
        "implementation actually tested; no short-side performance is presented or implied.",
        BODY))

    story.append(P("THE TRAILING-STOP EXIT FRAMEWORK", H2))

    story.append(P(
        "Every open position is managed under a single, rules-based protective stop that "
        "moves only in the direction of the trade (upward for a long position) and never "
        "against it. The governing stop is anchored to the security&rsquo;s recent trading "
        "range &mdash; a proprietary short-lookback low &mdash; and is ratcheted upward as "
        "the trade works. A position is exited when the market trades through the prevailing "
        "stop; stop fills are modeled conservatively, including gap-through pricing where an "
        "opening gap carries price beyond the stop level.",
        BODY))

    story.append(P(
        "The Strategy additionally applies a break-even protection rule: once an open "
        "position has accrued a threshold amount of unrealized profit and has confirmed "
        "favorable short-interval price action, the governing stop is raised to the "
        "position&rsquo;s entry price (break-even) on a raise-only basis, after which the "
        "trailing-range stop continues to ratchet upward as the trade extends. The Strategy "
        "does not employ a fixed time-based or &lsquo;stale-position&rsquo; exit; a position "
        "is held until its trailing stop is met. The specific lookback periods, profit "
        "thresholds, and confirmation rules are proprietary to the Investment Manager and "
        "are not disclosed in this Memorandum.",
        BODY))

    story.append(P("FULL-SIZE ENTRY AND POSITION SIZING", H2))

    story.append(P(
        "The Strategy establishes each position at its full intended size at the moment of "
        "the breakout; it does not scale, pyramid, or average into positions. Position size "
        "is calibrated on a per-position basis by reference to the distance between the "
        "entry price and the initial stop (&ldquo;risk per share&rdquo;). Each position is "
        "sized to the smaller of (i) a share count such that the product of share count and "
        "risk per share does not exceed 2.00% of the Fund&rsquo;s Net Asset Value, and "
        "(ii) a share count whose aggregate entry value does not exceed 10.00% of Net Asset "
        "Value. No single security, regardless of direction, may represent more than 10.00% "
        "of Net Asset Value at entry. Each entry is further capped at a proprietary fraction "
        "of the security&rsquo;s recent average daily trading volume to preserve "
        "executability as Fund assets grow.",
        BODY))

    story.append(P("PORTFOLIO LEVERAGE LIMIT (2x GROSS CAP)", H2))

    story.append(P(
        "Aggregate gross exposure is subject to a hard cap of two times (2.0x) the "
        "Fund&rsquo;s Net Asset Value. When the per-position sizing rules would cause "
        "aggregate gross exposure to exceed this limit, additional entries are suspended "
        "until exposure returns within the cap. This leverage governor is a mandatory, "
        "Strategy-level risk control intended to bound the Fund&rsquo;s total market "
        "exposure during broad market advances, when many breakout signals may occur "
        "simultaneously. The Fund may borrow for investment purposes within this 2.0x gross "
        "limit; see &ldquo;Leverage&rdquo; in the Summary of Terms and the related risk "
        "factor.",
        BODY))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# SECTION V — INVESTMENT PROCESS
# ═══════════════════════════════════════════════════════════════════════════
def build_investment_process():
    story = []
    story.append(P("V.  INVESTMENT PROCESS", H1))

    story.append(P(
        "The Fund&rsquo;s investment process operates on a daily cycle anchored to each "
        "U.S. equity trading session. On each trading day, the Investment Manager executes "
        "the following sequence:",
        BODY))

    story.append(P("1. SIGNAL GENERATION", H2))

    story.append(P(
        "Each trading day, the Signal System evaluates each of the approximately 303 "
        "securities in the PNTHR AI 300 Universe against the Strategy&rsquo;s proprietary "
        "new-high breakout criteria. A Buy Long (&ldquo;BL&rdquo;) signal is identified for "
        "any security trading to a new multi-month high relative to its own prior trading "
        "range. The Strategy does not rank candidates by a composite score and does not "
        "apply a market or sector regime gate; every qualifying breakout is eligible for "
        "entry, subject to the portfolio-level risk controls described below. The output "
        "of this step is the set of securities with a confirmed or pending breakout for "
        "the session.",
        BODY))

    story.append(P("2. PRE-TRADE RISK AND PORTFOLIO REVIEW", H2))

    story.append(P(
        "Each qualifying breakout is validated against the Strategy&rsquo;s risk "
        "framework: per-position risk sizing, the 10% single-name concentration limit, "
        "the 2.0x aggregate gross-exposure cap, the average-daily-volume participation "
        "cap, and wash-sale compliance. Breakouts that would cause aggregate gross "
        "exposure to exceed the 2.0x cap are deferred until exposure returns within the "
        "limit.",
        BODY))

    story.append(P("3. ENTRY CONFIRMATION AND SIZING", H2))

    story.append(P(
        "For each eligible breakout, the Investment Manager establishes a resting "
        "buy-stop order at the breakout level. Position size is calculated as the smaller "
        "of (i) a 2.00% per-position risk budget measured to the initial stop and (ii) a "
        "10.00% single-name value cap, further limited by the average-daily-volume "
        "participation cap. The full position is established at the breakout; the Strategy "
        "does not scale or pyramid into positions. The Investment Manager confirms each "
        "order prior to transmission to the Fund&rsquo;s prime broker.",
        BODY))

    story.append(P("4. EXECUTION VIA PNTHR&rsquo;S DEN PLATFORM", H2))

    story.append(P(
        "The Fund utilizes an internal technology platform (&ldquo;PNTHR&rsquo;s "
        "Den&rdquo; or the &ldquo;Platform&rdquo;) for portfolio monitoring, signal "
        "generation, trade planning, risk management, and related operational functions. "
        "The Platform may be used by the Investment Manager to transmit trade "
        "instructions to the Fund&rsquo;s prime broker, including via automated, "
        "semi-automated, or manual methods, at the Investment Manager&rsquo;s sole "
        "discretion. Platform-facilitated trading, whether manual or automated, is "
        "subject to the Investment Manager&rsquo;s oversight and is conducted consistent "
        "with the Strategy described in this Memorandum. The Platform&rsquo;s "
        "functionality, including any automated execution capabilities, may evolve "
        "over time, and the Investment Manager reserves the right to modify "
        "Platform-enabled workflows without further investor consent, provided such "
        "modifications remain consistent with the Strategy.",
        BODY))

    story.append(P("5. POSITION MANAGEMENT", H2))

    story.append(P(
        "Each open position is managed under a single ratcheting trailing stop anchored "
        "to a proprietary short-lookback low, raised only in the direction of the trade, "
        "supplemented by a break-even protection rule that lifts the stop to the entry "
        "price once the position has accrued threshold open profit with favorable "
        "short-interval confirmation. A position is closed when the market trades through "
        "its prevailing stop. The Strategy does not employ a fixed time-based or "
        "stale-position exit.",
        BODY))

    story.append(P("6. REPORTING AND RECONCILIATION", H2))

    story.append(P(
        "All trade activity is reconciled with the Fund&rsquo;s prime broker at the "
        "close of each trading day. Position-level performance, portfolio-level risk, "
        "and NAV metrics are updated on the Platform daily and transmitted to the "
        "Fund&rsquo;s third-party administrator on the schedule established in the "
        "administrator services agreement.",
        BODY))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# SECTION VI — GENERAL PARTNER, INVESTMENT MANAGER, AND MANAGEMENT
# ═══════════════════════════════════════════════════════════════════════════
def build_management():
    story = []
    story.append(P("VI.  GENERAL PARTNER, INVESTMENT MANAGER, AND MANAGEMENT", H1))

    story.append(P("THE GENERAL PARTNER", H2))

    story.append(P(
        "The General Partner of the Partnership is PNTHR Funds, LLC, a Delaware "
        "limited liability company. The General Partner is the sole manager of the "
        "Partnership and has the exclusive right and authority to manage and control "
        "the Partnership&rsquo;s business and affairs, subject to the terms of the "
        "Partnership Agreement. The General Partner has engaged STT Capital Advisors, "
        "LLC (the &ldquo;Investment Manager&rdquo;) pursuant to a written Investment "
        "Management Agreement to provide investment management services to the "
        "Partnership, including implementation of the Strategy described in Section IV. "
        "All operational decisions on behalf of the Partnership are retained by the "
        "General Partner.",
        BODY))

    story.append(P("THE INVESTMENT MANAGER", H2))

    story.append(P(
        "The Investment Manager, STT Capital Advisors, LLC, is a Delaware limited "
        "liability company. The Investment Manager manages exclusively private funds "
        "and currently has less than $150 million of assets under management in the "
        "United States; accordingly, the Investment Manager is exempt from SEC "
        "registration under the Private Fund Adviser Exemption of Section 203(m) of "
        "the Investment Advisers Act of 1940. In carrying out its duties, the "
        "Investment Manager will:",
        BODY))

    story.append(bullet(
        "<b>Research and Analysis.</b> Conduct quantitative and technical research to "
        "identify investment opportunities consistent with the Strategy and maintain "
        "the integrity of the PNTHR Signal System."))
    story.append(bullet(
        "<b>Investment Selection.</b> Select trades from the breakout signals generated "
        "by the PNTHR Signal System, subject to pre-trade risk review and the "
        "Fund&rsquo;s position and gross-exposure limits."))
    story.append(bullet(
        "<b>Risk Management.</b> Implement per-position risk sizing, the 10% single-name "
        "limit, the 2.0x aggregate gross-exposure cap, the trailing-stop and break-even "
        "discipline, and wash-sale compliance."))
    story.append(bullet(
        "<b>Trade Execution.</b> Transmit trade instructions to the Fund&rsquo;s prime "
        "broker via the PNTHR&rsquo;s Den Platform, in each case consistent with the "
        "Strategy and applicable law."))
    story.append(bullet(
        "<b>Monitoring and Review.</b> Continuously monitor open positions, "
        "trailing-stop levels, and aggregate gross exposure, and adjust portfolio "
        "exposure accordingly."))
    story.append(bullet(
        "<b>Compliance and Reporting.</b> Ensure all investment activities comply with "
        "applicable laws, regulations, and the Fund&rsquo;s governing documents; and "
        "provide required reports to the General Partner, the Administrator, and "
        "Limited Partners."))

    story.append(P("RELATED-PARTY DISCLOSURE", H2))

    story.append(P(
        "Scott R. McBrien is the sole owner and manager of the Investment Manager and "
        "simultaneously serves as a Manager and Co-Founder of the General Partner. The "
        "relationship between the General Partner and the Investment Manager is "
        "accordingly a related-party relationship. The Investment Management Agreement "
        "between the Fund and the Investment Manager provides that the terms of the "
        "engagement are fair and reasonable and consistent with those that would be "
        "agreed upon by parties dealing at arm&rsquo;s length, consistent with the "
        "Partnership Agreement. Prospective investors should review the conflicts of "
        "interest discussion set forth in Section VIII (Risk Factors and Conflicts of "
        "Interest).",
        BODY))

    story.append(P("PRINCIPALS", H2))

    story.append(P("<b>Scott R. McBrien, Chief Investment Officer and Chief Compliance Officer.</b>", BODY))
    story.append(P(
        "Scott R. McBrien is a Manager and Co-Founder of the General Partner and the "
        "sole owner of the Investment Manager. He serves as Chief Investment Officer "
        "(&ldquo;CIO&rdquo;) and Chief Compliance Officer (&ldquo;CCO&rdquo;) of the "
        "Fund. Mr. McBrien previously held Series 7, Series 3, and Series 63 licenses "
        "with FINRA and the SEC as a stock broker, senior technical analyst, and "
        "futures-market trader. He is the founder of Stock Timing Tech Education and "
        "the architect of the PNTHR Signal System, the Fund&rsquo;s proprietary "
        "signal-generation and position-management framework. Mr. McBrien is the "
        "author of &ldquo;The Sigma Investor,&rdquo; an Amazon #1 New Release. His "
        "market commentary has been featured in outlets including CNN, U.S. News and "
        "World Report, The Business Journals, and Business Insider.",
        BODY))

    story.append(P("<b>Cindy Eagar, Chief Operating Officer and Chief Information Security Officer.</b>", BODY))
    story.append(P(
        "Cindy Eagar is a Manager and Co-Founder of the General Partner. She serves "
        "as Chief Operating Officer (&ldquo;COO&rdquo;) and Chief Information Security "
        "Officer (&ldquo;CISO&rdquo;) of the Fund. Ms. Eagar is co-founder and former "
        "Chief Executive Officer of Stock Timing Tech Education. Prior to Stock "
        "Timing Tech, Ms. Eagar held senior leadership roles at venture-backed, "
        "high-growth software-as-a-service companies, most notably at Keap (formerly "
        "Infusionsoft), where she was instrumental in scaling the company from $10 "
        "million to $100 million in annual revenue. She has consulted numerous "
        "technology companies on partner-channel strategy and operational scale. Her "
        "operational and technology expertise underlies the PNTHR&rsquo;s Den platform "
        "and the Fund&rsquo;s information-security posture.",
        BODY))

    story.append(P("KEY PERSON PROVISION", H2))

    story.append(P(
        "Scott R. McBrien and Cindy Eagar are each &ldquo;Key Persons&rdquo; of the "
        "Fund. If at any time both Key Persons cease to devote substantially all of "
        "their business time to the affairs of the General Partner and the Investment "
        "Manager for a continuous period of sixty (60) days (a &ldquo;Key Person "
        "Event&rdquo;), a 90-day suspension period (the &ldquo;Suspension Period&rdquo;) "
        "will automatically commence. During the Suspension Period, no new investments "
        "will be made on behalf of the Fund, and Limited Partners may withdraw from "
        "the Fund without regard to the Lock-Up Period and without the Early-Withdrawal "
        "Penalty, subject to the Withdrawal Gate and the Audit Holdback. If no "
        "successor general partner is approved by the Limited Partners within the "
        "Suspension Period, the Fund will dissolve in accordance with the Partnership "
        "Agreement.",
        BODY))

    story.append(P("PRIME BROKER / CUSTODIAN", H2))

    story.append(P(
        "The Fund&rsquo;s prime broker and custodian is Interactive Brokers LLC "
        "(&ldquo;Interactive Brokers&rdquo; or &ldquo;IBKR&rdquo;). All Fund assets are "
        "held in custody with Interactive Brokers in a segregated account. The "
        "Investment Manager may change the Fund&rsquo;s prime broker or custodian at "
        "any time, in its discretion, consistent with the Partnership Agreement and "
        "applicable law.",
        BODY))

    story.append(P("INDEPENDENT AUDITOR", H2))

    story.append(P(
        "The Fund intends to engage Spicer Jeffries LLP as its independent auditor "
        "prior to the admission of any non-affiliated Limited Partner. As of the date "
        "of this Memorandum, no audit engagement has been finalized.",
        BODY))

    story.append(P("LEGAL COUNSEL", H2))

    story.append(P(
        "The Fund has engaged David S. Hunt, P.C. (&ldquo;Partnership Counsel&rdquo;) "
        "as legal counsel to the Partnership. Partnership Counsel may also represent "
        "the General Partner and its affiliates in connection with matters related to "
        "the Partnership. Each Limited Partner should consult its own legal counsel "
        "regarding its investment in the Fund.",
        BODY))

    story.append(P("THIRD-PARTY FUND ADMINISTRATOR", H2))

    story.append(P(
        "NAV Consulting, Inc. (the &ldquo;Administrator&rdquo; or &ldquo;NAV&rdquo;) "
        "has been engaged as the administrator of the Fund pursuant to a Service "
        "Agreement (the &ldquo;NAV Agreement&rdquo;). The Administrator is responsible "
        "for, among other things, calculating the Fund&rsquo;s Net Asset Value, "
        "performing certain other accounting, back-office, and data-processing "
        "functions, processing subscriptions, withdrawals, and transfer activities "
        "of Limited Partners, performing certain anti-money-laundering functions, and "
        "providing related administrative services.",
        BODY))

    story.append(P(
        "The NAV Agreement provides that the Administrator shall not be liable to the "
        "Fund, any Limited Partner, or any other person absent a finding of willful "
        "misconduct, gross negligence, or fraud on the part of NAV. The Fund shall "
        "indemnify and hold harmless the Administrator and its affiliates, officers, "
        "directors, shareholders, employees, agents, and representatives (collectively, "
        "the &ldquo;NAV Parties&rdquo;) from and against any liability, damages, claims, "
        "loss, cost, or expense arising from, related to, or in connection with the "
        "services provided to the Fund pursuant to the NAV Agreement, unless such "
        "Losses are the direct result of the willful misconduct, gross negligence, or "
        "fraud of NAV. In no event shall NAV have liability to the Fund, any Limited "
        "Partner, or any other person seeking damages or losses in excess of the fees "
        "paid to NAV by the Fund in the one year preceding the occurrence of any loss, "
        "nor shall NAV be liable for any indirect, incidental, consequential, "
        "collateral, exemplary, or punitive damages, including lost profits, revenue, "
        "or data.",
        BODY))

    story.append(P(
        "The services provided by NAV are purely administrative. NAV does not assume "
        "fiduciary duties to the Fund or to any Limited Partner, does not provide tax, "
        "legal, investment, or accounting advice, does not have custody of the "
        "Fund&rsquo;s assets, and does not verify the existence of, or perform any "
        "due diligence on, the Fund&rsquo;s underlying investments. NAV is entitled "
        "to rely on information received from the Fund, the Fund&rsquo;s management, "
        "broker-dealers, and data vendors without independent verification. It is the "
        "responsibility of the General Partner, and not NAV, to ensure compliance with "
        "the Fund&rsquo;s investment policies, restrictions, and applicable law.",
        BODY))

    story.append(P(
        "The Fund pays NAV fees out of the Fund&rsquo;s assets, generally based on the "
        "size of the Fund and in accordance with NAV&rsquo;s standard fee schedule, "
        "subject to a monthly minimum. Either party may terminate the NAV Agreement "
        "on 180 days&rsquo; prior written notice as well as on the occurrence of "
        "certain events specified in the NAV Agreement. Limited Partners may review "
        "the NAV Agreement upon request to the General Partner, provided that NAV "
        "reserves the right not to disclose the specific fees payable thereunder. NAV "
        "is not responsible for the preparation of this Memorandum or for the "
        "activities of the Fund and accepts no responsibility for any information "
        "contained in this Memorandum.",
        BODY))

    story.append(P("<b>Administrator Contact Information</b>", BODY))
    story.append(P("NAV Consulting, Inc.<br/>1 Trans Am Plaza Drive, Suite 400<br/>Oakbrook Terrace, Illinois 60181<br/>Telephone: +1 630.954.1919<br/>Email: main@navconsulting.net", BODY_INDENT))

    story.append(P("<b>Where to Send Subscriptions and Withdrawals</b>", BODY))
    story.append(P("NAV Consulting, Inc.<br/>Attention: Transfer Agency Services<br/>1 Trans Am Plaza Drive, Suite 400<br/>Oakbrook Terrace, Illinois 60181, United States<br/>Telephone: +1 630.954.1919<br/>Email: transfer.agency@navconsulting.net", BODY_INDENT))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# SECTION VII — DETAILED SUMMARY OF TERMS
# ═══════════════════════════════════════════════════════════════════════════
def build_detailed_summary_of_terms():
    story = []
    story.append(P("VII.  DETAILED SUMMARY OF TERMS", H1))

    story.append(P(
        "The following summary is qualified in its entirety by the detailed information "
        "appearing elsewhere in this Memorandum, by the terms and conditions of the "
        "Limited Partnership Agreement of the Fund, as amended from time to time "
        "(individually and collectively, as the context requires, the "
        "&ldquo;Partnership Agreement&rdquo;), which is incorporated by reference "
        "herein, and by the Subscription Agreement of the Fund, which is also "
        "incorporated by reference herein (together, the &ldquo;Subscription "
        "Documents&rdquo;). Each of the Partnership Agreement and the Subscription "
        "Documents should be read carefully by any prospective investor prior to "
        "subscribing for Interests. To the extent this summary conflicts with the "
        "Partnership Agreement, the Partnership Agreement will control.",
        BODY))

    story.append(spacer(6))

    label_style = ParagraphStyle(
        name="dt_label", fontName="Helvetica-Bold", fontSize=11, leading=14,
        alignment=TA_LEFT, spaceBefore=0, spaceAfter=0,
    )
    value_style = ParagraphStyle(
        name="dt_value", fontName="Helvetica", fontSize=11, leading=14,
        alignment=TA_LEFT, spaceBefore=0, spaceAfter=0,
    )

    def row(label, value):
        tbl = Table(
            [[Paragraph(label, label_style), Paragraph(value, value_style)]],
            colWidths=[1.9 * inch, 4.1 * inch],
        )
        tbl.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        return tbl

    story.append(row("Partnership",
        "PNTHR Tree Fund, LP, a Delaware limited partnership (the "
        "&ldquo;Partnership&rdquo; or the &ldquo;Fund&rdquo;)."))

    story.append(row("General Partner",
        "PNTHR Funds, LLC, a Delaware limited liability company (the &ldquo;General "
        "Partner&rdquo;). The General Partner has complete discretion to acquire, "
        "finance, operate, and dispose of Portfolio Investments on behalf of the "
        "Partnership, subject to the limitations described in this Memorandum and in "
        "the Partnership Agreement."))

    story.append(row("Investment Manager",
        "STT Capital Advisors, LLC, a Delaware limited liability company (the "
        "&ldquo;Investment Manager&rdquo;), has been engaged by the Fund pursuant to a "
        "written Investment Management Agreement (the &ldquo;Investment Management "
        "Agreement&rdquo;) to identify, evaluate, structure, and recommend investment "
        "opportunities for the Partnership, and to provide investment management "
        "services to the Partnership in connection with the implementation of the "
        "Strategy described in Section IV. The General Partner may retain the services "
        "of one or more sub-advisers and may remit part of the Investment Management "
        "Fee and/or Performance Allocation to such sub-adviser(s) in its sole "
        "discretion."))

    story.append(row("Offering of Interests",
        "The Fund is privately offering limited partnership interests (the &ldquo;Interests&rdquo;) "
        "to prospective investors who satisfy the eligibility standards described in "
        "this Memorandum. Persons whose subscriptions are accepted by the General "
        "Partner will be admitted as Limited Partners (each a &ldquo;Limited Partner&rdquo; "
        "and, together with the General Partner, the &ldquo;Partners&rdquo;). Each "
        "Interest includes the right of the holder to all benefits to which a Limited "
        "Partner may be entitled pursuant to the Partnership Agreement and applicable "
        "law, together with all obligations of the Limited Partner to comply with the "
        "terms and provisions of the Partnership Agreement and applicable law."))

    story.append(row("Offering Exemption",
        "Interests are offered in accordance with Section 4(a)(2) of the Securities "
        "Act of 1933, as amended (the &ldquo;Securities Act&rdquo;), and Rule 506(c) "
        "of Regulation D thereunder. The Fund relies on the exemption from registration "
        "as an investment company provided by Section 3(c)(1) of the Investment "
        "Company Act of 1940, as amended (the &ldquo;Investment Company Act&rdquo;), "
        "and is limited to no more than 100 beneficial owners."))

    story.append(row("Offering Size",
        "$25,000,000 aggregate Limited Partnership Interests. The General Partner may, "
        "in its sole and absolute discretion, increase the Offering Size by filing an "
        "amended Form D with the SEC and updating this Memorandum."))

    story.append(row("Minimum Investment",
        "$100,000 initial capital contribution, subject to the General Partner&rsquo;s "
        "sole and absolute discretion to accept a lesser amount. Existing Limited "
        "Partners may make additional capital contributions on a quarterly basis (or "
        "more frequently, at the General Partner&rsquo;s sole discretion) in amounts "
        "of not less than $10,000."))

    story.append(row("Investor Qualifications",
        "Each prospective investor must qualify both as an &ldquo;accredited "
        "investor&rdquo; as defined in Rule 501(a) of Regulation D under the "
        "Securities Act, and as a &ldquo;qualified client&rdquo; as defined in Rule "
        "205-3 under the Investment Advisers Act of 1940, as amended (the "
        "&ldquo;Advisers Act&rdquo;). Because the Fund relies on Rule 506(c), the "
        "General Partner is required to take reasonable steps to verify each prospective "
        "investor&rsquo;s accredited investor status prior to acceptance of a "
        "subscription. Self-certification is not sufficient."))

    # Investor Classes — tier structure rows
    story.append(row("Investor Classes",
        "Three classes of Limited Partner Interests are offered, differentiated by "
        "Capital Commitment and Performance Allocation rate. A Limited Partner&rsquo;s "
        "Interest class is determined as of the date of each capital contribution and "
        "may be re-determined upon subsequent contributions. Subject to the "
        "Partnership Agreement, each class ranks pari passu with respect to all other "
        "rights and preferences."))

    story.append(row("(A) Wagyu Interests",
        "Capital Commitment of $1,000,000 or more, or an account balance that grows "
        "to exceed $1,000,000. Wagyu Interests are subject to a 20% Performance "
        "Allocation on Net Profits in excess of the Hurdle Rate. For any Limited "
        "Partner whose account balance remains at or above the initial capital "
        "contribution, Wagyu Interests held continuously for at least thirty-six (36) "
        "consecutive months shall thereafter be subject to a permanently "
        "reduced 15% Performance Allocation rate."))

    story.append(row("(B) Porterhouse Interests",
        "Capital Commitment of at least $500,000 but less than $1,000,000, or an "
        "account balance that grows to exceed $500,000 but remains less than "
        "$1,000,000. Porterhouse Interests are subject to a 25% Performance Allocation "
        "on Net Profits in excess of the Hurdle Rate. Porterhouse Interests held "
        "continuously for at least thirty-six (36) consecutive months by a Limited "
        "Partner whose account balance remains at or above the initial capital "
        "contribution shall thereafter be subject to a permanently reduced 20% "
        "Performance Allocation rate."))

    story.append(row("(C) Filet Interests",
        "Capital Commitment of at least $100,000 but less than $500,000. Filet "
        "Interests are subject to a 30% Performance Allocation on Net Profits in "
        "excess of the Hurdle Rate. Filet Interests held continuously for at least "
        "thirty-six (36) consecutive months by a Limited Partner whose account "
        "balance remains at or above the initial capital contribution shall thereafter "
        "be subject to a permanently reduced 25% Performance Allocation rate."))

    story.append(row("Class Upgrade",
        "A Limited Partner whose aggregate Capital Account balance increases to or "
        "above a higher class threshold (by reason of additional capital contributions, "
        "appreciation, or both) may request reclassification to the higher class. "
        "Downgrade of class by reason of partial withdrawal is at the sole discretion "
        "of the General Partner."))

    story.append(row("Investment Management Fee",
        "The Investment Manager shall receive a Management Fee equal to 2.00% per "
        "annum of the Fund&rsquo;s Net Asset Value, accrued monthly and payable "
        "quarterly in advance. The Management Fee is calculated on the Net Asset "
        "Value as of the first Business Day of each fiscal quarter. The Management Fee "
        "is payable to the Investment Manager (which may, in its sole discretion, "
        "remit a portion of the Management Fee to one or more sub-advisers)."))

    story.append(row("Hurdle Rate",
        "The Hurdle Rate for each Fiscal Year shall be equal to the annualized yield "
        "on the U.S. 2-Year Treasury Note (the &ldquo;US2Y&rdquo;), determined as of "
        "the close of the first trading day of each Fiscal Year. For purposes of the "
        "Performance Allocation, the annual Hurdle Rate is converted to a quarterly "
        "Hurdle equal to the annual rate divided by four, applied at the end of each "
        "calendar quarter. The quarterly Hurdle is <i>not</i> cumulative across "
        "calendar quarters or Fiscal Years. No Performance Allocation accrues in "
        "respect of any calendar quarter unless the Fund&rsquo;s Net Profits "
        "allocated to the Limited Partner for that calendar quarter exceed both "
        "(i) the quarterly Hurdle and (ii) the High Water Mark."))

    story.append(row("High Water Mark",
        "The Performance Allocation is subject to a High Water Mark. The High Water "
        "Mark with respect to each Limited Partner&rsquo;s Capital Account is defined "
        "as the highest Capital Account balance (adjusted for capital contributions "
        "and withdrawals) achieved as of the end of any prior calendar quarter in "
        "which a Performance Allocation was accrued. No Performance Allocation will "
        "be accrued in respect of any Limited Partner&rsquo;s Capital Account until "
        "the Capital Account balance exceeds the applicable High Water Mark."))

    story.append(row("Loss Recovery Account",
        "For each Limited Partner, the Fund maintains a memorandum &ldquo;Loss "
        "Recovery Account&rdquo; that tracks cumulative net losses allocated to such "
        "Limited Partner&rsquo;s Capital Account. Quarterly Net Profits allocated "
        "to a Limited Partner are first applied to restore any negative balance in the "
        "Loss Recovery Account. The Performance Allocation accrues only on Net "
        "Profits in excess of both (i) the quarterly Hurdle and (ii) the amount required "
        "to restore the Loss Recovery Account to zero."))

    story.append(row("Performance Allocation",
        "Subject to the quarterly Hurdle, the High Water Mark, and the Loss Recovery "
        "Account described above, the Performance Allocation is determined at the "
        "end of each calendar quarter (March 31, June 30, September 30, and "
        "December 31) by reallocating from each Limited Partner&rsquo;s Capital "
        "Account to the General Partner&rsquo;s Capital Account an amount equal to "
        "the applicable Performance Allocation rate (20%, 25%, or 30%, or the "
        "reduced 15%, 20%, or 25% rate after three consecutive Fiscal Years) "
        "multiplied by the Net Profits for such calendar quarter in excess of both "
        "the quarterly Hurdle and any unrecovered balance in the Loss Recovery Account."))

    story.append(row("Term",
        "The Fund is an open-ended, evergreen fund with no set end date. The "
        "General Partner may, in its sole and absolute discretion, dissolve and "
        "terminate the Partnership pursuant to the Partnership Agreement (the "
        "&ldquo;Term&rdquo;)."))

    story.append(row("Lock-Up Period",
        "One (1) year from the date of a Limited Partner&rsquo;s initial admission "
        "(and, with respect to additional capital contributions, one year from the "
        "date of such contribution)."))

    story.append(row("Withdrawals",
        "Following expiration of the Lock-Up Period, a Limited Partner may withdraw "
        "all or part of its Capital Account quarterly, as of the last day of each "
        "calendar quarter (each a &ldquo;Withdrawal Date&rdquo;), upon at least sixty "
        "(60) days&rsquo; prior written notice to the General Partner in a form "
        "provided by the General Partner (a &ldquo;Withdrawal Request&rdquo;). "
        "Withdrawals are subject to the Withdrawal Gate and the Audit Holdback "
        "described below. Withdrawal amounts are determined based on the Limited "
        "Partner&rsquo;s pro rata share of the Fund&rsquo;s Net Asset Value as of the "
        "Withdrawal Date, less any fees, expenses, and accrued allocations. Any "
        "withdrawal granted by the General Partner in its sole discretion prior to the "
        "expiration of the Lock-Up Period shall be subject to the Early-Withdrawal "
        "Penalty described below."))

    story.append(row("Early-Withdrawal Penalty",
        "25% of the amount withdrawn, applicable to any withdrawal approved by the "
        "General Partner, in its sole discretion, during a Limited Partner&rsquo;s "
        "Lock-Up Period. Amounts withheld by reason of the Early-Withdrawal Penalty "
        "are retained by the Fund for the benefit of the non-withdrawing Limited "
        "Partners."))

    story.append(row("Minimum Withdrawal",
        "$25,000. A Limited Partner may not reduce its Capital Account balance below "
        "$50,000 by reason of a partial withdrawal. A Limited Partner whose Capital "
        "Account would fall below $50,000 after a partial withdrawal may be required "
        "by the General Partner to withdraw in full."))

    story.append(row("Withdrawal Gate",
        "If aggregate Withdrawal Requests on any Withdrawal Date exceed 25% of the "
        "Fund&rsquo;s Net Asset Value as of that date, the General Partner will "
        "process each Withdrawal Request on a pro rata basis up to the 25% "
        "aggregate limit, and the balance of unsatisfied Withdrawal Requests will "
        "be deferred to subsequent Withdrawal Dates over a period not to exceed "
        "three (3) Withdrawal Dates from the original Withdrawal Date."))

    story.append(row("Audit Holdback",
        "A Limited Partner withdrawing 90% or more of its Capital Account balance "
        "shall be paid 90% of the estimated withdrawal amount within thirty (30) days "
        "after the applicable Withdrawal Date. The remaining 10% shall be held back "
        "pending completion of the Fund&rsquo;s annual audit and shall be released "
        "to the withdrawing Limited Partner within thirty (30) days after completion "
        "of such audit."))

    story.append(row("Suspension of Withdrawals",
        "The General Partner may, in its sole and absolute discretion, suspend or "
        "postpone the payment of withdrawals during any period in which the General "
        "Partner determines such suspension is in the best interests of the Fund and "
        "its Limited Partners, including during periods of market disruption, "
        "illiquidity, or regulatory uncertainty."))

    story.append(row("Distributions",
        "The General Partner intends to reinvest net cash proceeds of the Fund to "
        "compound Limited Partners&rsquo; Capital Accounts. The General Partner may, "
        "at its sole discretion, make cash distributions to Limited Partners from "
        "time to time, generally within sixty (60) days after the end of each fiscal "
        "quarter. Any such distributions will be reflected in the applicable Limited "
        "Partner&rsquo;s Capital Account. Limited Partners should not expect "
        "distributions on a regular or guaranteed schedule."))

    story.append(row("Distributions in Kind",
        "Distributions prior to the termination of the Partnership may take the form "
        "of cash or marketable securities. Upon termination of the Partnership, "
        "distributions may also include restricted securities and other assets of the "
        "Partnership. The General Partner may, in its sole discretion, offer each "
        "Limited Partner the option to receive its pro rata share of securities in "
        "lieu of cash."))

    story.append(row("Tax Distributions",
        "The General Partner may cause the Partnership to make tax distributions to "
        "the General Partner from time to time in amounts sufficient to permit the "
        "payment of federal, state, and local income tax obligations of the General "
        "Partner and its direct and indirect owners in respect of allocations of "
        "income related to the Performance Allocation, calculated using an Assumed "
        "Tax Rate. Any such tax distributions will be considered in making subsequent "
        "distributions. Taxes paid by the Partnership, tax credits received by the "
        "Partnership, and amounts withheld for taxes shall be treated as distributions "
        "for purposes of the allocations described in this Memorandum."))

    story.append(row("Capital Accounts",
        "The Partnership shall establish and maintain a separate Capital Account for "
        "each Limited Partner and for the General Partner. Each Capital Account shall "
        "be credited with the holder&rsquo;s capital contributions and allocable share "
        "of Net Profits, and shall be debited for withdrawals, distributions, and "
        "allocable share of Net Losses, all in accordance with the Partnership "
        "Agreement and applicable tax rules."))

    story.append(row("Allocation of Profits and Losses",
        "All items of income, gain, loss, and deduction of the Partnership for each "
        "Fiscal Year shall be allocated among the Partners&rsquo; Capital Accounts "
        "in accordance with the Partnership Agreement, which is designed to cause "
        "the balances of the Capital Accounts, after giving effect to such allocations, "
        "to equal the amounts that would be distributed to the Partners if the "
        "Partnership were liquidated on the last day of such Fiscal Year consistent "
        "with the distribution provisions of the Partnership Agreement."))

    story.append(row("Side Pockets",
        "The General Partner may, in its sole and absolute discretion, designate a "
        "Portfolio Investment as a &ldquo;Side Pocket Investment&rdquo; if the "
        "General Partner determines that such investment is illiquid or otherwise not "
        "appropriate for inclusion in the Fund&rsquo;s regular Net Asset Value "
        "determination. Upon such designation, the Fair Value of the Side Pocket "
        "Investment shall be segregated from the Capital Accounts of the Limited "
        "Partners, and withdrawals attributable to the Side Pocket portion shall be "
        "suspended until the Side Pocket Investment is realized. The General Partner "
        "does not intend to use Side Pockets in the ordinary course of the Fund&rsquo;s "
        "operations."))

    story.append(row("Leverage",
        "The Investment Manager may use leverage of up to 2:1 gross exposure in "
        "pursuit of the Fund&rsquo;s investment strategy. Leverage may be obtained "
        "through margin financing arrangements with the Fund&rsquo;s prime broker "
        "or through other customary means."))

    story.append(row("Key Person Event",
        "Scott R. McBrien and Cindy Eagar are each &ldquo;Key Persons&rdquo; of the "
        "Fund. A &ldquo;Key Person Event&rdquo; shall occur if, at any time, both "
        "Key Persons cease to devote substantially all of their business time to the "
        "affairs of the General Partner and the Investment Manager for a continuous "
        "period of sixty (60) days. Upon a Key Person Event, a ninety (90)-day "
        "&ldquo;Suspension Period&rdquo; shall automatically commence, during which "
        "(i) no new investments shall be made on behalf of the Fund, and (ii) Limited "
        "Partners may withdraw from the Fund without regard to the Lock-Up Period "
        "and without the Early-Withdrawal Penalty, subject to the Withdrawal Gate "
        "and the Audit Holdback. If no successor general partner is approved by the "
        "Limited Partners within the Suspension Period, the Fund shall dissolve in "
        "accordance with the Partnership Agreement."))

    story.append(row("Removal of General Partner",
        "The Limited Partners may remove the General Partner for Cause upon the "
        "affirmative vote of Limited Partners holding, in the aggregate, not less than "
        "seventy-five percent (75%) of the Partnership Percentages of the Limited "
        "Partners. &ldquo;Cause&rdquo; includes: (i) a final, non-appealable judgment "
        "of a court of competent jurisdiction finding that the General Partner or its "
        "principals have engaged in fraud, gross negligence, or willful misconduct "
        "directly and materially harmful to the Fund; (ii) a felony conviction "
        "involving moral turpitude of a principal of the General Partner; (iii) a Rule "
        "506(d) disqualifying event applicable to the General Partner or its "
        "principals; or (iv) a final determination by a court or arbitrator that the "
        "General Partner has engaged in an intentional material breach of its "
        "fiduciary duty. For any Cause event that is reasonably capable of being "
        "cured, the General Partner shall have a thirty (30)-day cure period following "
        "written notice. Any successor general partner proposed by the Limited "
        "Partners must be approved in writing by Scott R. McBrien and Cindy Eagar "
        "(or the survivor of either of them) prior to such successor&rsquo;s "
        "appointment becoming effective. This approval right is personal to Scott R. "
        "McBrien and Cindy Eagar and shall not be transferable. If a removal of the "
        "General Partner becomes effective and no successor general partner has been "
        "approved by Scott R. McBrien and Cindy Eagar within ninety (90) days "
        "thereafter, the Partnership shall dissolve."))

    story.append(row("Transfers",
        "Interests may not be transferred, sold, assigned, pledged, encumbered, "
        "charged, exchanged, or hypothecated, in whole or in part, directly or "
        "indirectly, without the prior written consent of the General Partner, which "
        "consent may be granted, withheld, conditioned, or delayed in the General "
        "Partner&rsquo;s sole and absolute discretion. Any purported transferee must "
        "meet all investor suitability standards, complete Subscription Documents, "
        "and comply with applicable anti-money-laundering requirements. Any attempted "
        "transfer not made in accordance with the Partnership Agreement shall be "
        "null and void <i>ab initio</i>."))

    story.append(row("Indemnification and Exculpation",
        "The Partnership shall indemnify the General Partner, the Investment Manager, "
        "their affiliates, and each of their respective officers, members, directors, "
        "agents, stockholders, partners, employees, and other representatives (each "
        "an &ldquo;Indemnitee&rdquo;) from and against any loss, damage, or expense "
        "incurred by such Indemnitee by reason of its activities on behalf of the "
        "Partnership or in furtherance of the interests of the Partnership. "
        "Indemnification shall be available only to the extent that the Indemnitee&rsquo;s "
        "conduct did not constitute fraud, willful misconduct, gross negligence, bad "
        "faith, a material breach of the Partnership Agreement or the Investment "
        "Management Agreement, or a material violation of applicable securities laws. "
        "Limited Partners may be obligated to return amounts distributed to them to "
        "fund the Partnership&rsquo;s indemnification obligations and other "
        "liabilities, subject to the limitations set forth in the Partnership "
        "Agreement."))

    story.append(row("Reports",
        "The Partnership will furnish to each Limited Partner (i) audited annual "
        "financial statements, commencing with the period beginning on the date of "
        "the Partnership&rsquo;s initial closing and ending on December 31, 2026, no "
        "later than one hundred twenty (120) days after each Fiscal Year-end (or as "
        "soon as practicable thereafter); (ii) tax information necessary for the "
        "completion of income tax returns within one hundred twenty (120) days after "
        "each Fiscal Year-end (or as soon as practicable thereafter); and (iii) "
        "unaudited quarterly financial statements of the Partnership no later than "
        "sixty (60) days after the end of each fiscal quarter."))

    story.append(row("Operating Expenses",
        "The Partnership shall pay all expenses (other than the routine general and "
        "administrative expenses of the General Partner and the Investment Manager, "
        "such as staff salaries, office rent, and overhead) attributable to "
        "maintaining the ordinary and extraordinary activities of the Partnership "
        "(collectively, &ldquo;Partnership Expenses&rdquo;), including without "
        "limitation: third-party costs of buying, selling, maintaining, financing, "
        "hedging, and disposing of Portfolio Investments; taxes, fees, and other "
        "governmental charges; insurance; administrative and research fees; expenses "
        "of custodians, outside advisors, counsel (including Partnership Counsel), "
        "accountants, auditors, administrators, and other consultants and "
        "professionals; technological expenses; brokerage commissions; custodial "
        "expenses; interest and fees on financings; litigation expenses; expenses "
        "incurred in connection with any tax audit, investigation, or review; and "
        "any extraordinary expenses, in each case to the extent not reimbursed or "
        "paid by insurance. Partnership Expenses specifically exclude the Management "
        "Fee and Organizational Expenses."))

    story.append(row("Organizational Expenses",
        "The Partnership shall bear all legal, accounting, filing, and other "
        "organizational costs, fees, and expenses, including without limitation all "
        "out-of-pocket expenses incurred in connection with the organization and "
        "formation of the General Partner, the Partnership, and any related entities "
        "organized by the General Partner or its affiliates, and the offering of "
        "Interests, including without limitation legal and accounting fees, printing "
        "costs, filing fees, and travel and lodging expenses of the personnel of the "
        "General Partner and the Investment Manager."))

    story.append(row("Valuation",
        "The Fund&rsquo;s Net Asset Value shall be determined monthly by the "
        "Administrator, in accordance with U.S. generally accepted accounting "
        "principles (&ldquo;GAAP&rdquo;) and the Fund&rsquo;s valuation policy, "
        "based on information provided by the General Partner. Exchange-listed "
        "securities shall be valued at their closing price on the applicable "
        "exchange. Cash shall be valued at face amount. In the event of a dispute "
        "or ambiguity regarding the valuation of any asset, the General "
        "Partner&rsquo;s determination shall be final and binding."))

    story.append(row("ERISA",
        "The General Partner will use reasonable efforts to (a) limit equity "
        "participation by &ldquo;benefit plan investors&rdquo; to less than 25% of "
        "the total value of each class of equity interests in the Partnership, or "
        "(b) structure Portfolio Investments and operate the Partnership in a manner "
        "that qualifies the Partnership as a &ldquo;venture capital operating "
        "company&rdquo; or &ldquo;real estate operating company&rdquo; under the "
        "U.S. Employee Retirement Income Security Act of 1974, as amended "
        "(&ldquo;ERISA&rdquo;), so that the underlying assets of the Partnership "
        "should not constitute &ldquo;plan assets&rdquo; of any benefit plan investor. "
        "Prospective investors should review the ERISA discussion in Section IX "
        "(Certain Tax and Regulatory Matters) and consult their own advisors."))

    story.append(row("Amendments",
        "The Partnership Agreement may be amended by the General Partner in its sole "
        "discretion, without Limited Partner consent, to (i) cure any ambiguity, "
        "correct or supplement any inconsistent provision, or conform the Partnership "
        "Agreement to applicable law or regulation; (ii) make changes that do not "
        "adversely affect the rights or obligations of any Limited Partner; and "
        "(iii) accommodate subsequent closings of Interests. Material amendments to "
        "the Partnership Agreement require the affirmative consent of Limited "
        "Partners holding, in the aggregate, at least sixty-six and two-thirds "
        "percent (66-2/3%) of the Partnership Percentages. Notwithstanding the "
        "foregoing, no amendment shall (w) increase the capital contribution "
        "obligations of any Limited Partner, (x) reduce the economic rights of any "
        "Limited Partner, (y) affect the tax classification of the Partnership, or "
        "(z) reduce the limited liability protections afforded to any Limited "
        "Partner, in each case without the individual written consent of the Limited "
        "Partner(s) so affected."))

    story.append(row("Side Letters",
        "The General Partner, acting on behalf of the Partnership, may enter into "
        "side letters or other writings with individual Limited Partners that "
        "establish rights under, or alter or supplement, the terms of the Partnership "
        "Agreement. Any such side letter shall not adversely affect the rights of any "
        "other Limited Partner under the Partnership Agreement. Side letters may "
        "address, among other things, certain economic rights, information rights, "
        "co-investment rights, and excuse rights. Additional benefits granted in a "
        "side letter will not necessarily be made available to other Limited Partners."))

    story.append(row("No Voting Rights",
        "Limited Partners have no management rights with respect to the Partnership. "
        "Limited Partners have no voting rights except under the limited "
        "circumstances expressly provided in the Partnership Agreement. Subscribers "
        "are encouraged to review the voting-rights provisions of the Partnership "
        "Agreement carefully."))

    story.append(row("Confidentiality",
        "Subject to customary exceptions, each Limited Partner will agree to hold "
        "in confidence, and not to disclose to any third party without the prior "
        "written consent of the General Partner, this Memorandum, the Partnership "
        "Agreement, and any information disseminated by the Fund or the General "
        "Partner to the Limited Partners. Each Limited Partner shall apply the same "
        "degree of care to the Fund&rsquo;s confidential information as such Limited "
        "Partner uses to protect its own confidential information."))

    story.append(row("Partnership Counsel",
        "David S. Hunt, P.C. (&ldquo;Partnership Counsel&rdquo; or &ldquo;DSHPC&rdquo;), "
        "or another law firm selected by the General Partner. To the fullest extent "
        "permitted by law, Partnership Counsel does not represent or owe any duty to "
        "any Limited Partner or to the Limited Partners as a group in connection with "
        "the Partnership. Partnership Counsel&rsquo;s representation is limited to "
        "specific matters as to which Partnership Counsel has been consulted by the "
        "General Partner and its affiliates. Partnership Counsel does not "
        "independently investigate or verify the accuracy and completeness of "
        "information set forth in this Memorandum or in any other disclosures "
        "concerning the Partnership or its affiliates. Partnership Counsel does not "
        "monitor the compliance of the General Partner or its affiliates with the "
        "investment program, valuation procedures, or other guidelines set forth in "
        "this Memorandum, and does not monitor compliance with applicable laws. Each "
        "prospective investor acknowledges and gives its informed consent that: (i) "
        "Partnership Counsel represents the General Partner and the Investment "
        "Manager; (ii) Partnership Counsel does not represent any Limited Partner or "
        "prospective investor in that capacity, and owes no duties to any Limited "
        "Partner or prospective investor in that capacity; (iii) each Limited Partner "
        "and prospective investor waives any actual or potential conflict arising "
        "therefrom; (iv) Partnership Counsel is not obligated to share with any "
        "Limited Partner any confidential information obtained from the General "
        "Partner, the Investment Manager, or any other person; and (v) in the event "
        "of any dispute or litigation, Partnership Counsel may continue to represent "
        "the General Partner, the Investment Manager, and their affiliates. "
        "Partnership Counsel has not undertaken an evaluation of the merits of an "
        "investment in the Partnership."))

    story.append(row("Governing Law",
        "The Partnership Agreement and all related Fund documents shall be governed "
        "by, and construed in accordance with, the laws of the State of Delaware."))

    story.append(row("Dispute Resolution",
        "Any dispute, controversy, or claim arising out of or relating to the "
        "Partnership Agreement, this Memorandum, or the Interests shall be submitted "
        "to binding arbitration administered by the American Arbitration Association "
        "(&ldquo;AAA&rdquo;) under its Commercial Arbitration Rules, held in the "
        "State of Delaware, before a single arbitrator selected from the AAA&rsquo;s "
        "roster. The prevailing party shall be awarded its reasonable costs and "
        "attorneys&rsquo; fees. The arbitrator&rsquo;s award shall be final and "
        "binding, and judgment on the award may be entered in any court of competent "
        "jurisdiction."))

    story.append(row("Partnership Administrator",
        "NAV Consulting, Inc., located at 1 Trans Am Plaza Drive, Suite 400, Oakbrook "
        "Terrace, Illinois 60181. Please refer to Section VI (General Partner, "
        "Investment Manager, and Management) for the full scope of the "
        "Administrator&rsquo;s engagement and associated limitations."))

    story.append(row("General Partner Contact",
        "PNTHR Funds, LLC<br/>15150 W Park Place, Suite 215<br/>Goodyear, AZ 85395<br/>"
        "Email: info@PNTHRfunds.com<br/>Telephone: 602-810-1940"))

    story.append(row("Additional Information",
        "Prospective investors are invited and strongly encouraged to contact the "
        "General Partner for further explanation of the terms and conditions of this "
        "offering and to obtain additional information necessary to verify the "
        "information contained in this Memorandum, to the extent the General Partner "
        "possesses such information or can acquire it without unreasonable effort or "
        "expense."))

    story.append(spacer(10))
    story.append(P(
        "The terms and conditions of this offering of Interests, including the "
        "rights, preferences, privileges, and restrictions with respect to the "
        "Interests and the rights and liabilities of the Partnership, the General "
        "Partner, and the Limited Partners, are governed by the Partnership Agreement "
        "and the Subscription Documents. The descriptions in this Memorandum are "
        "qualified in their entirety by reference to the Partnership Agreement and "
        "the Subscription Documents.",
        BODY))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# SECTION VIII — RISK FACTORS AND CONFLICTS OF INTEREST
# ═══════════════════════════════════════════════════════════════════════════
def build_risk_factors():
    story = []
    story.append(P("VIII.  RISK FACTORS AND CONFLICTS OF INTEREST", H1))

    H3 = ParagraphStyle(
        name="rf_h3", fontName="Helvetica-Bold", fontSize=10.5, leading=13,
        alignment=TA_LEFT, spaceBefore=10, spaceAfter=4,
    )

    def rf(heading, *paragraphs):
        """Risk factor: heading + one or more body paragraphs."""
        story.append(P(heading, H3))
        for para in paragraphs:
            story.append(P(para, BODY))

    def rf_bullet(text):
        story.append(bullet(text))

    story.append(P("A.  CERTAIN RISKS", H2))

    story.append(P(
        "Prospective investors should be aware that an investment in the Fund involves "
        "a high degree of risk. There can be no assurance that the Fund&rsquo;s "
        "investment objectives will be achieved or that an investor will receive a "
        "return of its capital. In addition, occasions will arise when the General "
        "Partner, the Investment Manager, and their affiliates may encounter actual or "
        "potential conflicts of interest in connection with the Fund. The following "
        "considerations, among others, should be carefully evaluated before making an "
        "investment in the Fund. The list of risk factors below is not exhaustive, and "
        "prospective investors must read this Memorandum in its entirety, together "
        "with the Partnership Agreement and Subscription Documents, before making an "
        "investment decision.",
        BODY))

    rf("Disease, Epidemics, and Pandemics",
        "Pandemics, such as the COVID-19 pandemic, can cause significant disruptions to "
        "global economies, financial markets, and individual businesses, including "
        "those in which the Fund may invest. Pandemic-related risks include, without "
        "limitation, substantial market volatility, economic disruption from quarantines "
        "or social-distancing measures, operational challenges affecting the Fund and "
        "its service providers, increased credit and liquidity risk, unforeseen "
        "regulatory or policy responses, and risks to the health and safety of the "
        "Fund&rsquo;s personnel and the personnel of the Fund&rsquo;s service "
        "providers. Pandemics and their associated effects are unpredictable and may "
        "have long-lasting effects on the global economy and financial markets.")

    rf("Early-Stage Fund and Limited Operating History",
        "The Fund is a recently formed investment vehicle with limited operating "
        "history. The Fund&rsquo;s investment program should be evaluated on the basis "
        "that there can be no assurance that the General Partner&rsquo;s or the "
        "Investment Manager&rsquo;s assessment of the prospects of any investment will "
        "prove accurate, or that the Fund will achieve its investment objective. Past "
        "performance of the investment professionals of the General Partner or the "
        "Investment Manager is not necessarily indicative of future results.")

    rf("AI Sector Concentration Risk",
        "The Fund invests exclusively in securities within the artificial-intelligence "
        "value chain. Concentration in a single thematic sector exposes the Fund to "
        "risks specific to that sector, including but not limited to regulatory changes "
        "targeting AI technologies, shifts in government policy regarding AI development "
        "or deployment, technological obsolescence, competitive disruption, and "
        "sector-wide valuation contractions. A broad decline in AI-related equities "
        "could materially and adversely affect the Fund&rsquo;s performance regardless "
        "of the quality of individual security selection.")

    rf("Forward-Looking Statements",
        "To the extent that this Memorandum contains forward-looking statements, "
        "including observations about investment performance, markets, industry, and "
        "regulatory trends, such statements are made as of the date of this Memorandum. "
        "Forward-looking statements may be identified by the use of words such as "
        "&ldquo;may,&rdquo; &ldquo;will,&rdquo; &ldquo;could,&rdquo; &ldquo;should,&rdquo; "
        "&ldquo;plan,&rdquo; &ldquo;predict,&rdquo; &ldquo;project,&rdquo; "
        "&ldquo;target,&rdquo; &ldquo;continue,&rdquo; &ldquo;intends,&rdquo; "
        "&ldquo;expects,&rdquo; &ldquo;anticipates,&rdquo; &ldquo;believes,&rdquo; "
        "&ldquo;seeks,&rdquo; or &ldquo;estimates,&rdquo; or the negatives thereof, and "
        "similar expressions. Actual results could differ materially from those in the "
        "forward-looking statements as a result of factors beyond the control of the "
        "Partnership, the General Partner, or the Investment Manager. Prospective "
        "investors are cautioned not to place undue reliance on such statements. "
        "Neither the General Partner nor its affiliates has any obligation to update "
        "any forward-looking statements in this Memorandum.")

    rf("Investment Hypothesis",
        "The Fund&rsquo;s investment hypothesis may not prove correct. The Strategy "
        "depends upon the Investment Manager&rsquo;s ability to identify and capture "
        "profitable trend regimes in U.S. equities and ETFs. Market conditions and "
        "participant behavior may evolve in ways that reduce the effectiveness of the "
        "Strategy, and the Investment Manager may not be able to adapt the Strategy "
        "successfully to new conditions.")

    rf("Regulation and Compliance",
        "There are numerous state and federal regulations and government agencies that "
        "regulate the trading of securities and the operation of investment funds. If "
        "the Investment Manager fails to successfully navigate these regulations, the "
        "Fund could suffer losses, including a loss of all capital contributed by "
        "Limited Partners. Applicable statutes and regulators include, without "
        "limitation:")

    rf_bullet("<b>Securities Act of 1933</b>, which regulates the offering and sale of securities;")
    rf_bullet("<b>Securities Exchange Act of 1934</b>, which governs the secondary trading of securities, including reporting requirements such as Schedule 13D and 13G filings for beneficial ownership exceeding 5%, Regulation SHO for short selling, and insider-trading prohibitions;")
    rf_bullet("<b>Investment Company Act of 1940</b>, from which the Fund relies on the Section 3(c)(1) exemption (limiting the Fund to 100 beneficial owners);")
    rf_bullet("<b>Investment Advisers Act of 1940</b>, under which the Investment Manager currently relies on the Private Fund Adviser Exemption from SEC registration (available to advisers managing less than $150 million in private-fund assets in the United States);")
    rf_bullet("<b>Sarbanes-Oxley Act of 2002</b>, imposing governance and reporting standards on public company issuers in which the Fund may invest;")
    rf_bullet("<b>Dodd-Frank Wall Street Reform and Consumer Protection Act of 2010</b>, which imposes requirements on private fund managers, including mandatory registration thresholds, Form PF systemic-risk reporting, and the Volcker Rule;")
    rf_bullet("<b>Commodity Futures Trading Commission (CFTC)</b> and <b>National Futures Association (NFA)</b> regulations, which may apply if the Fund trades in futures, swaps, or certain options;")
    rf_bullet("<b>Regulation Best Interest (Reg BI)</b>, which governs broker-dealer conduct in connection with securities recommendations;")
    rf_bullet("<b>Foreign Account Tax Compliance Act (FATCA)</b>, which imposes reporting obligations in connection with foreign investors and foreign accounts;")
    rf_bullet("<b>USA PATRIOT Act</b> and related <b>Anti-Money Laundering (AML)</b> and <b>Know Your Customer (KYC)</b> requirements administered by the U.S. Department of the Treasury and the Financial Crimes Enforcement Network;")
    rf_bullet("<b>General Data Protection Regulation (GDPR)</b>, to the extent the Fund has European investors or handles personal data of EU residents;")
    rf_bullet("<b>Cybersecurity and data-privacy regulations</b> issued by the SEC and other regulators.")

    rf("Stock-Related Risks",
        "The Fund invests primarily in publicly traded U.S. equities. Equity investments "
        "are subject to, among other risks: <b>Market Risk</b> (prices fluctuate due to "
        "market conditions, economic factors, and company-specific events); <b>Liquidity "
        "Risk</b> (some equities may have low trading volumes, making it difficult to "
        "trade without impacting price); <b>Volatility Risk</b> (equity prices can be "
        "highly volatile, especially for smaller or less-established issuers); and "
        "<b>Dividend Risk</b> (companies may reduce or eliminate dividend payments).")

    rf("ETF-Related Risks",
        "The Fund may invest in exchange-traded funds (&ldquo;ETFs&rdquo;), which are "
        "subject to, among other risks: <b>Market Risk</b> (ETFs are subject to the same "
        "market risks as the underlying assets they track); <b>Tracking Error</b> (an "
        "ETF&rsquo;s performance may not perfectly match the performance of its "
        "underlying index); <b>Liquidity Risk</b> (some specialized or niche ETFs may "
        "have lower trading volumes); and <b>Counterparty Risk</b> (ETFs that use "
        "derivatives or engage in securities lending may expose the Fund to "
        "counterparty-related risks).")

    rf("Short Selling Risk",
        "The Fund is authorized to take short positions, although its current systematic "
        "implementation is long-only and the Fund does not presently engage in short "
        "selling. If and when the Fund implements short positions, short selling carries "
        "unique risks. Short positions may theoretically incur unlimited losses if the "
        "market price of the security being shorted rises instead of falls. In cases of "
        "market rallies or specific stock-price surges, the Fund may be forced to cover "
        "short positions at a loss, potentially resulting in significant financial "
        "exposure. The Fund&rsquo;s prime broker may also recall borrowed securities, "
        "forcing the Fund to close a short position at an inopportune time. The Fund "
        "does not engage in naked short selling.")

    rf("Sector Concentration Risk",
        "The Strategy does not impose a fixed numerical cap on the number of positions "
        "the Fund may hold within any single industry sector. In periods when the "
        "Strategy&rsquo;s signal-generation framework identifies a strong sector-wide "
        "trend, the Fund may hold a meaningful concentration of positions (long or "
        "short, or both) within a single sector. Such concentration can amplify "
        "exposure to sector-specific risks, including but not limited to adverse "
        "economic, regulatory, political, or company-specific developments affecting "
        "that sector disproportionately. A Limited Partner could experience a "
        "material decline in Fund performance as a result of events affecting a single "
        "sector. Limited Partners who are unwilling to accept this degree of "
        "single-sector exposure should not invest in the Fund.")

    rf("Concentrated Position Risk",
        "The Strategy may result in concentrated positions in specific securities "
        "based on the breakout signals generated by the PNTHR Signal System. Although the Fund "
        "applies a per-ticker position cap of 10% of Net Asset Value at entry, "
        "concentration can still increase exposure to company-specific or "
        "security-specific events, which may result in larger-than-expected losses if "
        "such assets perform poorly.")

    rf("Dependence on Proprietary Software and Systems",
        "The Fund relies heavily on proprietary software and systems to generate "
        "breakout signals, manage position size, transmit trade "
        "instructions, and monitor open positions. There is an inherent risk associated "
        "with the performance and reliability of this technology. If algorithms fail to "
        "function as expected, encounter bugs, or are exposed to external cybersecurity "
        "threats, the Fund could make incorrect investment decisions that negatively "
        "affect returns. The software&rsquo;s ability to generate accurate signals may "
        "also be challenged by market anomalies, regime changes, or unprecedented "
        "conditions.")

    rf("Quantitative Model Risk",
        "The investment process depends on proprietary quantitative models that may "
        "not always predict market behavior accurately. Market conditions can change "
        "rapidly, rendering models less effective. Models may fail to account for "
        "extraordinary market events or &ldquo;black swan&rdquo; events, leading to "
        "unexpected losses. Over-reliance on historical data and trends may limit the "
        "model&rsquo;s ability to adapt to new or unique market conditions. Models may "
        "also be susceptible to <i>overfitting</i>, in which historical calibration "
        "fails to generalize to out-of-sample periods, and to <i>model decay</i>, in "
        "which previously successful strategies lose edge as market participants adapt. "
        "The Investment Manager may at any time modify, supplement, or replace any "
        "component of the Strategy in its sole discretion.")

    rf("Risk of Signal Delays or Misinterpretation",
        "The proprietary software generates signals on a scheduled cadence, but there "
        "is a risk of delays in signal processing, data-feed interruptions, or "
        "misinterpretation of signals by the Investment Manager. Any lag in executing "
        "trades based on signals can lead to missed profit opportunities or higher "
        "losses, especially in fast-moving markets.")

    rf("Technology Platform and Automated Execution Risk",
        "The Fund utilizes an internal technology platform (PNTHR&rsquo;s Den) that may "
        "transmit trade instructions to the Fund&rsquo;s prime broker via manual, "
        "semi-automated, or automated methods. Automated trading involves additional "
        "risks, including risks of erroneous order generation, system outages, "
        "execution latency, connectivity failures with the prime broker, faulty risk "
        "limits, and the possibility of software bugs producing unintended trading "
        "behavior. A malfunction of the platform&rsquo;s automated execution "
        "capabilities could cause the Fund to enter or exit positions at unfavorable "
        "prices, fail to execute intended trades, or execute unintended trades. The "
        "Investment Manager retains oversight of Platform-facilitated trading, but no "
        "oversight process can fully eliminate these risks.")

    rf("Directional Exposure, High Beta and Large Drawdowns",
        "The Fund is a directional, long-only strategy and is not market-neutral or "
        "hedged. It is therefore highly correlated to the broad equity market and "
        "amplifies market moves: in its hypothetical backtest the Fund exhibited a beta "
        "to the S&amp;P 500 of approximately 1.8, meaning it tended to rise and fall "
        "roughly 1.8 times as much as the index. As a high-conviction momentum strategy, "
        "the Fund will experience high volatility and large drawdowns. In the hypothetical, "
        "survivorship-flattered backtest, the Fund&rsquo;s net maximum drawdown was on the "
        "order of 50% to 58% (deeper than the broad market over the same period), and "
        "future drawdowns may be larger and may not recover. The Fund is not a "
        "diversifier and should be sized as a higher-volatility, higher-return position. "
        "Investors must be financially able and willing to bear declines of this "
        "magnitude.")

    rf("Leverage Risk",
        "The Investment Manager may use leverage of up to 2:1 gross exposure. While "
        "leverage can magnify gains, it also amplifies losses, especially in periods "
        "of heightened volatility. The risk of margin calls is present, which could "
        "force the Fund to liquidate positions at a loss to meet margin requirements. "
        "The Fund&rsquo;s interest expense and other financing costs will reduce the "
        "net returns available for allocation to Limited Partners.")

    rf("Operational Risk",
        "Operational risks arise from failures in internal processes, systems, and "
        "personnel of the Fund. Risks include failures in technology infrastructure, "
        "human error, inadequate internal controls, and fraud. Given the Fund&rsquo;s "
        "reliance on proprietary software and complex trading systems, operational "
        "risks could have a direct and material impact on the Fund&rsquo;s performance.")

    rf("Changing Economic Conditions",
        "The success of any investment activity depends in part on general economic "
        "conditions. The availability, unavailability, or hindered operation of "
        "external credit markets, equity markets, and other economic systems upon "
        "which the Fund may depend could have a significant negative impact on the "
        "Fund&rsquo;s operations and profitability. The stability and sustainability "
        "of growth in global economies may be affected by terrorism or acts of war. "
        "There can be no assurance that such markets and systems will be available "
        "as anticipated or needed for the Fund to operate successfully.")

    rf("No Assurance of Investment Return",
        "Neither the General Partner nor the Investment Manager can provide assurance "
        "that they will be able to identify, make, and realize investments consistent "
        "with the Fund&rsquo;s investment objective. There can be no assurance that the "
        "Partnership will generate returns for Limited Partners, that returns will be "
        "commensurate with the risks of investing in the type of assets described "
        "herein, or that any Limited Partner will receive any distribution from the "
        "Partnership. An investment in the Fund should only be considered by persons "
        "who can afford a loss of their entire investment.")

    rf("Future and Past Performance",
        "The past performance of the principals of the General Partner or the "
        "Investment Manager is not necessarily indicative of the Fund&rsquo;s future "
        "results. While the General Partner intends for the Fund to make investments "
        "consistent with the Strategy, there can be no assurance that targeted results "
        "will be achieved. Backtested, simulated, or hypothetical performance results "
        "have inherent limitations and may not reflect actual trading, investor "
        "behavior, fees, and expenses that would affect actual performance. Loss of "
        "principal is possible on any investment.")

    rf("Reliance on General Partner and Key Management Personnel",
        "The General Partner has sole discretion over the investment of capital "
        "committed to the Fund and over the ultimate realization of any profits. "
        "Limited Partners will not receive detailed financial information for potential "
        "Portfolio Investments. The success of the Partnership will depend in large "
        "part upon the skill and expertise of the Investment Manager and other key "
        "personnel. The loss of the services of any such key personnel could have a "
        "significant adverse impact on the Fund. There can be no assurance that key "
        "personnel will continue to be affiliated with the Partnership throughout the "
        "Term, or that replacements will be able to duplicate prior levels of "
        "performance. The principals will not be required to devote substantially all "
        "of their business time to the Fund and may engage in other businesses and "
        "activities unrelated to the Fund.")

    rf("Compensation Arrangement with the General Partner",
        "The Performance Allocation made to the General Partner may create an incentive "
        "for the General Partner or the Investment Manager to make investments that "
        "are riskier or more speculative than the investments that would otherwise be "
        "recommended in the absence of such performance-based arrangements.")

    rf("Competitive Marketplace",
        "The marketplace has become increasingly competitive. Participation by "
        "financial intermediaries has increased, substantial amounts of capital have "
        "been dedicated to systematic and quantitative strategies, and competition for "
        "investment opportunities is high. Some of the Fund&rsquo;s potential "
        "competitors may have greater financial and personnel resources than the "
        "General Partner or the Investment Manager. There can be no assurance that the "
        "General Partner will locate an adequate number of attractive investment "
        "opportunities, and returns to Limited Partners may vary.")

    rf("Phantom Income",
        "Limited Partners will be required to take into account, for U.S. federal "
        "income tax purposes, their allocable shares of the Partnership&rsquo;s income "
        "without regard to the amount, if any, of distributions received from the "
        "Partnership. Certain of the Partnership&rsquo;s investments may be structured "
        "so as to cause the Partnership to recognize taxable income in excess of its "
        "economic income (&ldquo;phantom income&rdquo;). Accordingly, to the extent "
        "the Partnership recognizes phantom income, or is not otherwise in a position "
        "to distribute its income, investors may be required to pay federal income tax "
        "(and any other applicable income taxes) on amounts of income substantially in "
        "excess of cash distributions. See Section IX (Certain Tax and Regulatory "
        "Matters) for additional discussion.")

    rf("Lack of Information for Monitoring and Valuing Fund Assets",
        "Despite the General Partner&rsquo;s efforts, the General Partner may only be "
        "able to obtain limited information at certain times and may not be aware on a "
        "timely basis of material adverse changes with respect to certain investments. "
        "The value of Fund assets could be significantly affected by any such event. "
        "Prospective investors should be aware that any valuation made by the General "
        "Partner may not represent the fair market value of the securities held by the "
        "Fund.")

    rf("Partnership Borrowing",
        "The Partnership may borrow on a secured or unsecured basis for any purpose, "
        "including to make investments, increase investment capacity, pay fees and "
        "expenses, or make distributions. Although the Partnership does not intend to "
        "employ significant leverage at the partnership level beyond the 2:1 gross "
        "exposure limit, leverage may fluctuate depending on market conditions. "
        "Interest expense and other costs incurred in connection with such borrowings "
        "may not be recovered by appreciation in the investments purchased. If "
        "investment results fail to cover the cost of borrowings, the Partnership&rsquo;s "
        "returns could decrease faster than if there had been no borrowings. "
        "Borrowings also increase exposure to adverse economic factors such as rising "
        "interest rates and economic downturns, and in the event of a default on "
        "secured indebtedness the lender may foreclose on the Partnership&rsquo;s "
        "assets.")

    rf("Limitations on Ability to Exit Investments",
        "The General Partner expects to exit from investments primarily through "
        "open-market sales. At any particular time, this avenue may not be open to the "
        "Fund on favorable terms, and the timing of exit mechanisms may be inopportune. "
        "The ability to exit from and liquidate portfolio holdings may be constrained "
        "at any particular time.")

    rf("Potential Liabilities",
        "The Fund, the General Partner, the Investment Manager, their affiliates, "
        "members, officers, and directors may be subject to litigation, regulatory "
        "investigations, or other disputes in connection with the Fund&rsquo;s "
        "activities, and may be named as defendants. Typically, the Partnership will "
        "maintain insurance to protect directors and officers, but this insurance may "
        "be inadequate. The Partnership will indemnify the General Partner and other "
        "indemnitees for liabilities incurred in connection with the Fund&rsquo;s "
        "operations; such indemnification obligations could be substantial and, if the "
        "Fund&rsquo;s assets are insufficient, the General Partner may require the "
        "return of prior distributions.")

    rf("Contingent Liabilities on Disposition of Investments",
        "In connection with the disposition of an investment, the Fund may be required "
        "to make representations about the financial affairs of the investment and to "
        "indemnify purchasers for inaccuracies. Such arrangements may result in the "
        "incurrence of contingent liabilities for which the General Partner may "
        "establish reserves and escrows, which may delay or reduce distributions.")

    rf("Reserves",
        "The General Partner may, in its sole and absolute discretion, establish "
        "reserves for fund expenses (including the Management Fee), Fund liabilities, "
        "and other matters. Estimating the appropriate amount of reserves is "
        "inherently difficult. Inadequate reserves could impair returns to Limited "
        "Partners; excessive reserves could cause the Fund to hold unnecessary "
        "amounts of capital in low-yield accounts.")

    rf("No Market; Illiquidity of Fund Interests",
        "An investment in the Fund will be illiquid and involves a high degree of "
        "risk. There is no public market for the Interests, and it is not expected "
        "that a public market will develop. Limited Partners will bear the economic "
        "risks of their investment for the Term of the Fund. Prospective investors "
        "will be required to represent and agree that they are purchasing Interests "
        "for their own account for investment only and not with a view to resale or "
        "distribution.")

    rf("Restrictions on Transfer and Withdrawal",
        "Interests have not been registered under the Securities Act, the securities "
        "laws of any U.S. state, or the securities laws of any other jurisdiction, and "
        "cannot be sold unless subsequently registered or an exemption from "
        "registration is available. It is not expected that such registration will be "
        "effected. Interests may only be offered, sold, or transferred to investors "
        "who are qualified under applicable securities laws. A Limited Partner may not "
        "assign, sell, exchange, or transfer any of its interest without the prior "
        "written consent of the General Partner, which consent may be withheld in the "
        "General Partner&rsquo;s sole and absolute discretion. Withdrawals are subject "
        "to the Lock-Up Period, the Withdrawal Gate, the Audit Holdback, and other "
        "restrictions described in Section VII.")

    rf("Limited Portfolio Diversification",
        "To the extent the Investment Manager concentrates the Partnership&rsquo;s "
        "investments in a particular market or sector, the Partnership&rsquo;s "
        "portfolio may become more susceptible to fluctuations in value resulting from "
        "adverse conditions affecting that market or sector. Reduced diversification "
        "may increase the volatility of the Partnership&rsquo;s returns relative to "
        "more diversified funds. In the early stages of the Term or following large "
        "Limited Partner admissions or withdrawals, the Partnership may hold more "
        "concentrated positions than it otherwise would.")

    rf("Legal and Regulatory Risks",
        "The Fund is not and does not expect to be registered as an &ldquo;investment "
        "company&rdquo; under the Investment Company Act, relying on the exemption "
        "provided by Section 3(c)(1) of the Investment Company Act. There is no "
        "assurance that such exemption will continue to be available. If the Fund "
        "becomes subject to registration under the Investment Company Act, the "
        "performance of the Fund&rsquo;s portfolio could be materially adversely "
        "affected and the Fund&rsquo;s operations could be substantially constrained. "
        "The Investment Manager currently relies on the Private Fund Adviser "
        "Exemption from registration under the Advisers Act; there can be no assurance "
        "that this exemption will continue to be available, and any requirement to "
        "register could impose substantial compliance costs and operational "
        "restrictions on the Investment Manager and the Fund.")

    rf("AIFMD",
        "The European Union Alternative Investment Fund Managers Directive "
        "(&ldquo;AIFMD&rdquo;) regulates the activities of private fund managers "
        "undertaking fund-management activities or marketing fund interests to "
        "investors within the European Union. If the Fund is marketed to EU-based "
        "investors, the Fund will be subject to certain reporting, disclosure, and "
        "other compliance obligations under AIFMD, which may result in the Fund "
        "incurring additional costs and expenses.")

    rf("Cybersecurity Risks",
        "With the Fund&rsquo;s reliance on technology and complex information-"
        "technology systems, the Partnership and its service providers are prone to "
        "operational and information-security risks resulting from cyber-attacks. "
        "Cyber-attacks include, among other things, stealing or corrupting data, "
        "denial-of-service attacks, unauthorized release of confidential information, "
        "and operational disruption. Successful cyber-attacks against the Partnership, "
        "the General Partner, or third-party service providers may interfere with "
        "Limited Partner transactions, affect the Fund&rsquo;s ability to value assets, "
        "release private Limited Partner information, impede trading, cause "
        "reputational damage, and subject the Partnership to regulatory fines, "
        "reimbursement costs, or additional compliance costs. The Partnership may "
        "also incur substantial costs for cyber-risk management.")

    rf("Dodd-Frank Act",
        "The Dodd-Frank Wall Street Reform and Consumer Protection Act (&ldquo;Dodd-"
        "Frank Act&rdquo;) has resulted in extensive rulemaking and regulatory changes "
        "affecting private fund managers and the funds they manage. The SEC has "
        "mandated recordkeeping and reporting requirements for investment advisers "
        "that add costs to legal, operational, and compliance obligations. The "
        "Dodd-Frank Act affects a broad range of market participants with whom the "
        "Partnership interacts, including banks, non-bank financial institutions, "
        "credit unions, insurance companies, and broker-dealers. Parts of the "
        "Dodd-Frank Act, including the Volcker Rule, continue to reshape the financial "
        "industry. Future legislative or regulatory changes, including potential "
        "rollbacks of prior regulations, could affect the Fund&rsquo;s operations in "
        "ways that cannot presently be predicted.")

    rf("Investment Manager Subject to Extensive Regulation",
        "The Investment Manager is subject to extensive regulation, including periodic "
        "examinations, by governmental agencies and self-regulatory organizations. "
        "Regulators have the authority to grant and cancel permissions to carry on "
        "particular activities, conduct investigations and administrative proceedings, "
        "and impose fines, suspensions, changes in policies, censures, cease-and-"
        "desist orders, and other sanctions. Even if an investigation does not result "
        "in material sanctions, adverse publicity relating to the investigation or "
        "proceeding could harm the Investment Manager&rsquo;s reputation and adversely "
        "affect its ability to serve as investment manager of the Partnership.")

    rf("Natural Disasters, Terrorist Acts, and Similar Dislocations",
        "Natural disasters, incidents of war, riot or civil unrest, and terrorist acts "
        "could have a material adverse effect on the Partnership&rsquo;s investments "
        "and on the economies of the countries or regions affected. Effects of future "
        "such events on economies and securities markets cannot be predicted, and "
        "could affect interest rates, credit conditions, inflation, and the "
        "availability of borrowing, among other factors affecting the Fund.")

    rf("Tax Risks",
        "Certain tax risks relating to an investment in the Fund are discussed in "
        "Section IX (Certain Tax and Regulatory Matters), which prospective investors "
        "should read carefully. No assurance can be given that current tax laws, "
        "rulings, and regulations will not change during the life of the Fund. "
        "Prospective investors should consult their own tax advisors.")

    rf("Withholding and Other Taxes",
        "The General Partner intends to structure the Fund&rsquo;s investments "
        "consistent with the Fund&rsquo;s investment objectives, but there can be no "
        "assurance that the structure of any investment will be tax-efficient for any "
        "particular investor or that any particular tax result will be achieved. In "
        "addition, tax reporting requirements may be imposed on investors under the "
        "laws of jurisdictions in which investors are liable for taxation or in which "
        "the Fund makes portfolio investments. The Fund&rsquo;s returns may be "
        "reduced by withholding or other taxes imposed by jurisdictions in which the "
        "Fund&rsquo;s investments are located.")

    rf("Diverse Investors",
        "The Limited Partners may have conflicting investment, tax, and other interests "
        "with respect to their investments in the Fund. Conflicts may arise in "
        "connection with decisions made by the General Partner with respect to the "
        "nature or structuring of investments that may be more beneficial for some "
        "Limited Partners than for others, particularly with respect to "
        "investors&rsquo; individual tax situations. In selecting and structuring "
        "investments, the General Partner will consider the investment and tax "
        "objectives of the Fund and of the Partners as a whole, and not the "
        "investment, tax, or other objectives of any individual Limited Partner.")

    rf("Risk of Dilution",
        "Limited Partners subscribing for Interests at subsequent closings will "
        "participate in existing investments of the Fund, which may dilute the "
        "interests of existing Limited Partners. There can be no assurance that the "
        "contribution amount paid at subsequent closing will reflect the fair value of "
        "the Fund&rsquo;s existing investments at the time of such additional "
        "subscription.")

    rf("Lack of Limited Partner Control",
        "Subject to the limitations described in this Memorandum and in the Partnership "
        "Agreement, the General Partner has complete discretion in managing the "
        "Fund&rsquo;s portfolio. The Limited Partners will not make decisions with "
        "respect to the management, disposition, or realization of any investment "
        "made by the Fund, or other decisions regarding the Fund&rsquo;s business and "
        "affairs.")

    rf("Foreign Investments",
        "Although the Fund invests primarily in U.S.-listed securities, the Fund may "
        "from time to time hold securities of companies with significant operations "
        "outside the United States. Foreign investments carry risks not typically "
        "found in the domestic securities market, including economic and financial "
        "instability, adverse political developments, currency fluctuations, "
        "restrictions on the repatriation of investment income, differences in "
        "accounting and disclosure standards, differences in legal systems and "
        "investor protections, and country-specific tax risks. The Fund does not "
        "presently intend to reduce currency risks through hedging.")

    rf("OFAC and FCPA Considerations",
        "Economic sanction laws administered by the U.S. Department of the "
        "Treasury&rsquo;s Office of Foreign Assets Control (&ldquo;OFAC&rdquo;) and "
        "similar laws in other jurisdictions prohibit the General Partner, the "
        "principals, and the Fund from transacting with certain countries, entities, "
        "and individuals. Such sanctions may restrict the Fund&rsquo;s investment "
        "activities. The General Partner, the principals, and the Fund are also "
        "committed to complying with the U.S. Foreign Corrupt Practices Act "
        "(&ldquo;FCPA&rdquo;) and other applicable anti-corruption and anti-bribery "
        "laws. Any determination that the Fund or the General Partner has violated "
        "such laws could subject the Fund or the General Partner to civil and "
        "criminal penalties, material fines, profit disgorgement, injunctions, "
        "securities litigation, and a general loss of investor confidence.")

    rf("Confidential Information",
        "The Partnership Agreement contains confidentiality provisions intended to "
        "protect proprietary and other information relating to the Fund. To the "
        "extent that such information is publicly disclosed, competitors of the Fund "
        "and others may benefit, thereby adversely affecting the Fund, the General "
        "Partner, and the economic interests of the Limited Partners.")

    # CONFLICTS OF INTEREST

    story.append(P("B.  CONFLICTS OF INTEREST", H2))

    story.append(P(
        "The Partnership may be subject to a number of actual and potential conflicts "
        "of interest. The General Partner and the Investment Manager will devote to "
        "the Partnership as much time as is necessary or appropriate, in their "
        "judgment, to manage the Partnership&rsquo;s activities. The following "
        "summarizes some of the conflicts to which the Partnership is subject but is "
        "not an exclusive list of all such conflicts. References in this Section VIII.B "
        "to the General Partner and the Investment Manager include their respective "
        "affiliates, partners, members, shareholders, officers, directors, and "
        "employees.",
        BODY))

    rf("Related-Party Relationship Between General Partner and Investment Manager",
        "Scott R. McBrien is the sole owner and manager of the Investment Manager (STT "
        "Capital Advisors, LLC) and simultaneously serves as a Manager and Co-Founder "
        "of the General Partner (PNTHR Funds, LLC). The fee arrangements between the "
        "Partnership and the Investment Manager are therefore between affiliated "
        "entities controlled, directly or indirectly, by Mr. McBrien. Although the "
        "Investment Management Agreement provides that its terms are fair and "
        "reasonable, and consistent with those that would be agreed upon by parties "
        "dealing at arm&rsquo;s length, the terms were not the product of arm&rsquo;s-"
        "length negotiation. Prospective investors should consider this related-party "
        "relationship carefully.")

    rf("Investment Opportunities",
        "Instances may arise where the interests of the General Partner (or its members "
        "or affiliates) or the Investment Manager conflict with the interests of the "
        "Fund and the Limited Partners. The existence of the Performance Allocation "
        "may create an incentive for the General Partner to make riskier or more "
        "speculative investments than it would otherwise make in the absence of "
        "performance-based compensation. Conflicts may also arise because affiliated "
        "persons may hold investments in issuers that are also held by the Fund, and "
        "the General Partner or the Investment Manager may form other investment "
        "funds that co-invest with the Partnership, invest in opportunities the "
        "Partnership declined, or otherwise make investments. By subscribing for an "
        "Interest, each Limited Partner consents to the foregoing conflicts.")

    rf("Related-Party Transactions",
        "The General Partner may have conflicts of interest in connection with "
        "transactions between the Partnership and its affiliates. If the General "
        "Partner or any affiliate engages in any related-party transaction in which "
        "compensation is paid, the General Partner will evaluate the terms of such "
        "transactions in good faith to ensure they are fair to the Partnership and "
        "consistent with market rates. Because such compensation is not determined "
        "through arm&rsquo;s-length negotiation, conflicts may arise, and the General "
        "Partner will not guarantee the performance by its affiliates of services "
        "provided to the Partnership.")

    rf("Other Potential Funds",
        "The General Partner reserves the right to raise additional funds "
        "(&ldquo;Other Related Funds&rdquo;), including a fund formed to make "
        "investments that would be precluded or materially limited by the "
        "Partnership&rsquo;s investment limitations or applicable law. The formation "
        "of an Other Related Fund could result in the reallocation of personnel from "
        "the Partnership. Potential investments suitable for the Partnership may also "
        "be directed toward or shared with an Other Related Fund.")

    rf("Diverse Limited Partner Group",
        "The General Partner manages the Partnership based on its overall objectives, "
        "not the objectives of any individual Limited Partner. Limited Partners may "
        "have conflicting investment, tax, and other interests with respect to their "
        "investments in the Partnership and with respect to the interests of investors "
        "in other investment vehicles managed or advised by the General Partner or the "
        "Investment Manager. In selecting and structuring investments, the General "
        "Partner will consider the investment and tax objectives of the Partnership "
        "and its Partners as a whole, not the investment, tax, or other objectives of "
        "any individual Limited Partner.")

    rf("General Partner Counsel",
        "Legal counsel for the General Partner, the Partnership, and the Investment "
        "Manager (&ldquo;Counsel&rdquo;), currently David S. Hunt, P.C., may be "
        "retained in connection with the formation and operation of the Partnership. "
        "Counsel represents the General Partner, the Partnership, and the Investment "
        "Manager. Counsel does not represent the interests of any Limited Partner. "
        "Prospective investors should seek their own legal, tax, and financial advice "
        "before investing. Counsel may be removed by the General Partner at any time "
        "without the consent of, or notice to, the Limited Partners. Counsel does not "
        "monitor compliance of the Partnership, the General Partner, or the Investment "
        "Manager with the investment program, valuation procedures, or applicable "
        "laws, and has not independently investigated or verified the accuracy and "
        "completeness of information set forth in this Memorandum.")

    rf("Use of Placement Agents",
        "The Partnership or the General Partner on behalf of the Partnership may "
        "engage placement agents with respect to the offering of Interests to "
        "prospective investors. Any such placement agent acts for the Partnership "
        "and/or the General Partner, and not as an investment adviser to prospective "
        "investors. Placement agents would generally be paid a fee based on the "
        "amount of Capital Commitments introduced to the Partnership. Any placement "
        "agent fees and expenses will be borne by the Partnership, and the amount of "
        "any placement agent fees (but not expenses) will be applied to reduce current "
        "or future payments of the Management Fee (but not below zero). Placement "
        "agents may act for other fund sponsors on different fee terms, which may "
        "influence their decisions to introduce prospective investors to the "
        "Partnership. Affiliates or employees of a placement agent could invest in the "
        "Partnership on their own behalf or on behalf of their clients.")

    # Closing warning
    story.append(spacer(8))
    story.append(P(
        "<b>NO ASSURANCE CAN BE GIVEN THAT THIS OFFERING OR THE FUND&rsquo;S "
        "INVESTMENT OBJECTIVES CAN BE ACHIEVED.</b>",
        BODY))

    story.append(P(
        "THE FOREGOING LISTS OF RISK FACTORS AND CONFLICTS OF INTEREST DO NOT PURPORT "
        "TO BE A COMPLETE EXPLANATION OF THE ACTUAL OR POTENTIAL RISKS AND CONFLICTS "
        "INVOLVED IN THIS OFFERING. POTENTIAL INVESTORS MUST READ THE ENTIRE "
        "MEMORANDUM, THE PARTNERSHIP AGREEMENT, AND THE SUBSCRIPTION DOCUMENTS BEFORE "
        "DETERMINING WHETHER TO INVEST IN THE FUND. ALL POTENTIAL INVESTORS SHOULD "
        "OBTAIN PROFESSIONAL GUIDANCE FROM THEIR TAX AND LEGAL ADVISORS IN EVALUATING "
        "ALL OF THE RISKS AND TAX IMPLICATIONS OF INVESTING IN THE FUND.",
        CAPS_BODY))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# SECTION IX — CERTAIN TAX AND REGULATORY MATTERS
# ═══════════════════════════════════════════════════════════════════════════
def build_tax_regulatory():
    story = []
    story.append(P("IX.  CERTAIN TAX AND REGULATORY MATTERS", H1))

    H3 = ParagraphStyle(
        name="tx_h3", fontName="Helvetica-Bold", fontSize=10.5, leading=13,
        alignment=TA_LEFT, spaceBefore=10, spaceAfter=4,
    )

    def sub(heading, *paragraphs):
        story.append(P(heading, H3))
        for para in paragraphs:
            story.append(P(para, BODY))

    # ─────────── A. Federal Income Tax ───────────────────────────────
    story.append(P("A.  CERTAIN FEDERAL INCOME TAX CONSIDERATIONS", H2))

    story.append(P(
        "The following is a summary of certain United States federal income tax "
        "consequences relating to an investment in the Fund. This summary does not "
        "attempt to present all aspects of the United States federal income tax laws "
        "or any state, local, or foreign laws that may affect an investment in the "
        "Fund. Foreign investors, financial institutions, insurance companies, "
        "tax-exempt entities, and other investors of special status must consult "
        "with their own professional tax advisors. No ruling has been or will be "
        "requested from the United States Internal Revenue Service (the &ldquo;IRS&rdquo;), "
        "and no assurance can be given that the IRS will agree with the tax "
        "consequences described in this summary. Each prospective Limited Partner "
        "should consult with its own tax adviser to fully understand the United "
        "States federal, state, local, and foreign income tax consequences of an "
        "investment in the Fund.",
        BODY))

    story.append(P(
        "Except as otherwise indicated below, references in this discussion to "
        "Partners or Limited Partners refer to &ldquo;U.S. persons,&rdquo; which "
        "include an individual who is a citizen of the United States or is treated "
        "as a resident of the United States for United States federal income tax "
        "purposes; a corporation (or any other entity treated as a corporation for "
        "United States federal income tax purposes) created or organized in or "
        "under the laws of the United States, any state thereof, or the District "
        "of Columbia; an estate the income of which is subject to United States "
        "federal income taxation regardless of its source; or a trust that (i) is "
        "subject to the supervision of a court within the United States and the "
        "control of one or more United States persons as described in Section "
        "7701(a)(30) of the United States Internal Revenue Code of 1986, as amended "
        "(the &ldquo;Code&rdquo;), or (ii) has a valid election in effect under "
        "applicable Treasury regulations to be treated as a United States person. "
        "If a partnership holds Interests, the tax treatment of a partner will "
        "generally depend upon the status of the partner and the activities of the "
        "partnership. Persons that are partners in a partnership investing in the "
        "Fund should consult their own tax advisors. A &ldquo;Non-U.S. Limited "
        "Partner&rdquo; is a person (other than a partnership for United States "
        "federal income tax purposes) that is not a U.S. person as defined above.",
        BODY))

    sub("Fund Status",
        "The Fund will be classified and reported as a partnership for United States "
        "federal income tax purposes.")

    sub("Taxation of Partners",
        "Each constituent Partner will report on its federal income tax return its "
        "distributive share of the Fund&rsquo;s items of income, gain, loss, deduction, "
        "and credit for the taxable year. The character of such items, determined at "
        "the Fund level, will pass through to the Partners (for example, Partners "
        "will treat as interest, dividends, or capital gain their distributive "
        "shares of such items recognized by the Fund).",
        "Each Partner will be required to report on its federal income tax return its "
        "distributive share of any income or gain recognized by the Fund, whether or "
        "not amounts representing such distributive share have been distributed to it.")

    sub("Distributions",
        "Distributions from the Fund, whether made currently or upon liquidation, "
        "generally may be received by a Partner without further United States federal "
        "income tax. The general rules may be summarized as follows:")
    story.append(bullet(
        "<b>Cash distributions</b> will not be taxable to a Partner except to the extent "
        "they exceed the Partner&rsquo;s tax basis for its Interest. The excess would "
        "generally be taxable as long-term or short-term capital gain, depending on the "
        "Partner&rsquo;s holding period."))
    story.append(bullet(
        "<b>In-kind distributions</b> of portfolio securities or other Fund assets "
        "generally will not be taxable to the recipient Partner or the Fund. A partner "
        "that receives a distribution of marketable securities from a partnership "
        "generally is required to recognize taxable gain to the extent that the fair "
        "market value of the distributed securities exceeds the partner&rsquo;s tax "
        "basis in its partnership interest. There are a number of exceptions, including "
        "an exception for distributions by qualified &ldquo;investment partnerships.&rdquo; "
        "It is expected that the Fund will qualify as an investment partnership and "
        "that accordingly distributions of marketable securities by the Fund generally "
        "will not give rise to the current recognition of taxable gain."))
    story.append(bullet(
        "<b>Basis on subsequent sale of in-kind distributed assets</b>: the "
        "Partner&rsquo;s tax basis for such assets will be equal to the Fund&rsquo;s "
        "adjusted basis for the assets or, if less, the Partner&rsquo;s tax basis for "
        "its Fund interest immediately before the distribution. A Partner&rsquo;s tax "
        "basis for assets distributed in liquidation will equal the Partner&rsquo;s "
        "tax basis in its Fund interest. The capital-gain holding period for assets "
        "distributed without recognition of gain will include the period during which "
        "the assets were held by the Fund."))
    story.append(bullet(
        "<b>No loss recognition on distribution</b> except where the distribution is a "
        "liquidating distribution consisting solely of cash and the amount of cash is "
        "less than the Partner&rsquo;s tax basis in its Fund interest."))

    sub("Deductions and Limitations",
        "A Partner will be entitled to deduct on its U.S. federal income tax return "
        "its distributive share of Fund loss, but not in excess of its tax basis in "
        "its Fund interest. If a Partner&rsquo;s distributive share of Fund loss "
        "exceeds tax basis, such excess may not be deducted but may be carried over "
        "to later years to the extent tax basis becomes available. The &ldquo;at "
        "risk&rdquo; provisions of Section 465 of the Code impose additional "
        "limitations on deductibility of partnership losses. Section 469 of the Code "
        "limits deductibility of losses from passive activities for individuals, "
        "estates, trusts, personal service corporations, and closely held corporations. "
        "The General Partner believes the Fund&rsquo;s activities will not constitute "
        "a trade or business for federal income tax purposes; accordingly, expenses of "
        "producing income (including Management Fees) allocated to individual Partners "
        "may be subject to the 2% adjusted-gross-income floor on miscellaneous "
        "itemized deductions and other deduction limitations.")

    sub("Phantom Income",
        "Investors in the Partnership will be required to take into account for U.S. "
        "federal income tax purposes their allocable shares of the Partnership&rsquo;s "
        "income without regard to the amount, if any, of distributions they have "
        "received. Certain of the Partnership&rsquo;s Investments may be structured "
        "such that the Partnership recognizes taxable income in excess of its economic "
        "income (&ldquo;phantom income&rdquo;). Accordingly, to the extent the "
        "Partnership recognizes phantom income or is not otherwise in a position to "
        "distribute its income, Limited Partners may be required to pay federal income "
        "tax (and any other applicable income taxes) on amounts of income substantially "
        "in excess of cash distributions.")

    sub("Capital Gain and Dividend Tax Rates",
        "The Fund expects that its gains and losses from securities transactions "
        "typically will be short-term capital gains and losses. Securities held for "
        "more than one year generally will be eligible for long-term capital gain or "
        "loss treatment. Under current United States federal income tax law, the "
        "maximum ordinary income tax rate for individuals is 37%, and in general the "
        "maximum individual income tax rate for long-term capital gains is 20% "
        "(actual rates may be higher due to the phase-out of certain tax deductions, "
        "exemptions, and credits). The excess of capital losses over capital gains may "
        "be offset against the ordinary income of an individual taxpayer, subject to "
        "an annual deduction limitation of $3,000; unused capital losses may be "
        "carried forward indefinitely. For corporate taxpayers, the maximum income "
        "tax rate is currently 21%; capital losses of a corporate taxpayer may be "
        "offset only against capital gains, with limited carryback and carryforward. "
        "A 3.8% Medicare tax is generally imposed on the net investment income of "
        "individuals, estates, and trusts. Fund capital gain income recognized by a "
        "Partner will generally be subject to the 3.8% Medicare tax.")

    sub("Qualified Small Business Stock (Section 1202)",
        "In general, non-corporate investors that, directly or via a pass-through "
        "entity such as the Fund, hold &ldquo;qualified small business stock&rdquo; "
        "(&ldquo;QSBS&rdquo;) for more than five (5) years are permitted to exclude "
        "from taxable income 50% of any gain subsequently recognized upon a sale or "
        "exchange of such stock. The amount of gain eligible for the QSBS exclusion "
        "generally is limited to the greater of: (i) 10 times the investor&rsquo;s "
        "basis in the stock, or (ii) a total of $10 million with regard to stock in "
        "the issuing corporation. The remaining gain is subject to tax at a maximum "
        "capital-gains rate of 28%. For federal alternative minimum tax purposes, 7% "
        "of the QSBS exclusion is treated as a preference item. Because several "
        "requirements must continue to be satisfied after issuance, it is possible "
        "that stock may cease to qualify as small business stock due to events "
        "occurring after the issue date. No assurance can be given that any stock "
        "acquired by the Fund would qualify for the QSBS exclusion.")

    sub("Section 1045 Rollover",
        "Under Section 1045 of the Code, if an individual (i) realizes gain on a sale "
        "of QSBS held for more than six months and (ii) within 60 days after such sale "
        "purchases new QSBS, the individual generally is required to recognize (and "
        "pay tax on) such gain only to the extent that the net proceeds from the "
        "original stock exceed the cost of the newly purchased stock. Any remaining "
        "gain is carried over to the newly purchased stock and will generally be "
        "recognized upon a subsequent disposition. The benefits of Section 1045 are "
        "generally available to individuals who purchase, hold, and sell QSBS "
        "indirectly through a pass-through entity such as the Fund, subject to "
        "limitations.")

    sub("Investment by the Fund in Controlled Foreign Corporations",
        "A non-United States corporation in which the Fund invests may be classified "
        "as a controlled foreign corporation (&ldquo;CFC&rdquo;) in one or more taxable "
        "years while the corporation&rsquo;s stock is held by the Fund. In general, a "
        "foreign corporation will be classified as a CFC if five or fewer 10% United "
        "States shareholders own in the aggregate more than 50% of the voting power or "
        "value of the corporation&rsquo;s stock. Each 10% United States shareholder "
        "who owns shares in a CFC on the last day of the corporation&rsquo;s taxable "
        "year will be required to include in gross income, as ordinary income, its "
        "pro rata share of the corporation&rsquo;s Subpart F income. In general, "
        "Subpart F income includes passive income and certain related-party income. "
        "In addition, a 10% United States shareholder may recognize ordinary income "
        "on all or a portion of the gain from the sale of stock of a CFC.")

    sub("Investment by the Fund in Passive Foreign Investment Companies",
        "A non-United States corporation in which the Fund invests may be classified "
        "as a passive foreign investment company (&ldquo;PFIC&rdquo;) in one or more "
        "taxable years while the corporation&rsquo;s stock is held by the Fund. In "
        "general, a foreign corporation will be classified as a PFIC if (i) at least "
        "75% of its gross income for the tax year is passive, or (ii) at least 50% of "
        "the assets held by the corporation during the year produces passive income. "
        "A direct or indirect United States shareholder of stock in a PFIC may defer "
        "United States tax until the stock is disposed of or until a distribution is "
        "received from the corporation. Certain excess distributions by the PFIC will "
        "be taxed as ordinary income and will cause a United States shareholder to pay "
        "interest on the tax deferral obtained by reason of holding stock in the PFIC. "
        "United States shareholders may avoid such interest charges by making a "
        "qualified electing fund (&ldquo;QEF&rdquo;) election in the first taxable "
        "year in which the corporation becomes a PFIC. A QEF election would result in "
        "an annual inclusion in gross income of such United States shareholder&rsquo;s "
        "pro rata share of the corporation&rsquo;s ordinary earnings and net capital "
        "gains, irrespective of whether such income is actually distributed.")

    sub("Tax-Exempt Limited Partners (UBTI)",
        "Income recognized by United States tax-exempt entities, including qualified "
        "retirement plans (stock, bonus, pension, or profit-sharing plans described in "
        "Section 401(a) of the Code) and individual retirement accounts, is generally "
        "exempt from United States federal income tax. Section 511 of the Code, "
        "however, imposes a tax on such an entity&rsquo;s &ldquo;unrelated business "
        "taxable income&rdquo; (&ldquo;UBTI&rdquo;). UBTI is income from an unrelated "
        "trade or business regularly carried on. Most types of passive investment "
        "income, including dividends, interest, royalties, and gains from the sale of "
        "securities, are excluded from UBTI. Certain income generated with debt "
        "financing (&ldquo;unrelated debt-financed income&rdquo;) may also constitute "
        "UBTI. The General Partner will use reasonable efforts to minimize the "
        "incurrence of UBTI by tax-exempt Limited Partners, although no assurance can "
        "be given.")

    sub("Non-U.S. Limited Partners",
        "The United States federal income tax treatment of Non-U.S. Limited Partners "
        "will vary depending on whether the Fund is treated as being engaged in a "
        "trade or business in the United States. If, as is expected, the Fund is "
        "treated as not engaged in a United States trade or business, Non-U.S. Limited "
        "Partners will be subject to United States taxation only in limited instances. "
        "For Non-U.S. Limited Partners not engaged in a U.S. trade or business, "
        "United States source investment income, including dividends, royalties, "
        "certain interest, and similar income (but not capital gains except as noted "
        "below) paid to the Fund and allocable to such Non-U.S. Limited Partners will "
        "be subject to a 30% U.S. withholding tax, other than qualifying portfolio "
        "interest. The withholding tax may be reduced or eliminated in some "
        "circumstances for residents of countries with which the United States has "
        "income tax treaties. Each prospective Non-U.S. Limited Partner must consult "
        "with and rely upon its own tax advisors with respect to the United States "
        "and foreign tax treatment of an investment in the Fund.")

    sub("FATCA",
        "Pursuant to Code Sections 1471 through 1474 and the related Treasury "
        "regulations (&ldquo;FATCA&rdquo;), the Fund will be required to deduct a 30% "
        "withholding tax from payments of certain United States source income, "
        "including capital gains, made to its foreign Partners unless the foreign "
        "Partners are individuals or establish an exemption. The FATCA withholding "
        "tax cannot be reduced under a tax treaty. Each Partner will be required to "
        "provide the Fund any and all information required for the Fund to meet its "
        "obligations under FATCA. The purpose of FATCA is to ensure that foreign "
        "entities receiving payments from United States sources disclose all of their "
        "direct or indirect United States owners.")

    sub("Reporting and Partnership Representative",
        "The General Partner will furnish each Partner with an annual statement "
        "(typically IRS Schedule K-1) setting forth information relating to the "
        "operations of the Fund, including information regarding such Partner&rsquo;s "
        "distributive share of partnership income, gains, losses, deductions, and "
        "credits, as is reasonably required to enable the Partner to report to the "
        "IRS. The United States federal information tax returns filed by the Fund may "
        "be subject to audit by the IRS, and the audit of the Fund&rsquo;s returns "
        "could result in an audit of the Partners&rsquo; own returns. Any "
        "administrative or judicial proceedings involving the United States federal "
        "income tax treatment of Fund items will generally be conducted on a unified "
        "basis under the Bipartisan Budget Act of 2015 partnership audit rules, with "
        "binding effect on all Partners. The General Partner will serve as the "
        "Fund&rsquo;s &ldquo;Partnership Representative&rdquo; for purposes of "
        "coordinating any such proceedings.")

    sub("Reportable Transactions",
        "Treasury regulations impose special reporting rules for &ldquo;reportable "
        "transactions.&rdquo; The General Partner intends to take the position that "
        "an investment in the Fund does not constitute a reportable transaction. If "
        "it were determined that an investment in the Fund does constitute a "
        "reportable transaction, each Partner would be required to complete and file "
        "IRS Form 8886 with such Partner&rsquo;s tax return. A significant penalty is "
        "imposed on taxpayers who participate in a reportable transaction and fail to "
        "make required disclosure. Certain states have similar reporting requirements.")

    sub("Tax Basis Adjustments",
        "The Code provides for optional, and in certain cases mandatory, adjustments "
        "to the basis of partnership property upon distributions of partnership "
        "property to a partner and transfers of partnership interests. The General "
        "Partner may elect to adjust the basis of Fund property in its sole discretion. "
        "Limited Partners permitted to transfer Interests will be required to provide "
        "certain information regarding such transfer to the General Partner and any "
        "transferee.")

    sub("General",
        "The foregoing discussion is for general information purposes and is intended "
        "only as a general summary of some of the principal United States federal "
        "income tax aspects of participation in the Fund. The tax rules applicable "
        "with respect to the Partners, the Fund, and the transactions in which the "
        "Fund may engage are highly complex, and their effect in certain instances "
        "may not be free from doubt. The tax rules presently applicable are subject "
        "to change at any time, and any such changes may or may not be made with "
        "retroactive effect.")

    sub("Circular 230 Disclaimer",
        "This summary was not intended or written to be used, and it cannot be used "
        "by any taxpayer, for the purpose of avoiding penalties that may be imposed "
        "on the taxpayer. This summary was written to support the promotion or "
        "marketing of Interests in the Fund. Each prospective investor should seek "
        "advice based on the taxpayer&rsquo;s particular circumstances from an "
        "independent tax advisor.")

    # ─────────── B. Securities Law & AML ────────────────────────────
    story.append(P("B.  CERTAIN SECURITIES LAW AND ANTI-MONEY LAUNDERING CONSIDERATIONS", H2))

    sub("Investment Company Act of 1940",
        "The Fund will not be subject to the provisions of the Investment Company Act "
        "of 1940 in reliance upon Section 3(c)(1) of the Investment Company Act, which "
        "excludes from the definition of &ldquo;investment company&rdquo; any issuer "
        "whose outstanding securities are beneficially owned by not more than one "
        "hundred (100) persons and that does not engage in a public offering of "
        "securities. The Fund&rsquo;s Subscription Agreement and the Partnership "
        "Agreement contain representations and restrictions on transfer designed to "
        "ensure that the conditions of Section 3(c)(1) will be met.")

    sub("Investment Advisers Act of 1940",
        "Neither the General Partner nor the Investment Manager is currently "
        "registered under the Investment Advisers Act of 1940 (the &ldquo;Advisers "
        "Act&rdquo;). The Investment Manager relies on the Private Fund Adviser "
        "Exemption of Section 203(m) of the Advisers Act, which is available to "
        "advisers managing less than $150 million in private-fund assets in the "
        "United States. As a consequence of the amendments to the Advisers Act under "
        "the Dodd-Frank Act, the General Partner and/or the Investment Manager may in "
        "the future be required to become registered under the Advisers Act. In such "
        "event, the General Partner and/or the Investment Manager could become subject "
        "to additional regulatory and compliance requirements. Even while the "
        "Investment Manager remains exempt, it will be required to comply with "
        "reporting, recordkeeping, and other compliance requirements applicable to "
        "exempt reporting advisers. While the General Partner and the Investment "
        "Manager remain exempt, investors in the Fund will not be afforded the full "
        "protections of the Advisers Act that would apply if either were registered "
        "with the SEC.")

    sub("Securities Act of 1933",
        "The Interests described herein are not being registered under the Securities "
        "Act, in reliance upon the exemptions provided by Section 4(a)(2) of the "
        "Securities Act and Rule 506(c) of Regulation D thereunder for transactions "
        "not involving a public offering. Each prospective investor will be required "
        "to execute certain agreements in connection with its subscription and in so "
        "doing will make certain representations to the General Partner, including "
        "that: (i) it is an &ldquo;accredited investor&rdquo; as defined in Rule "
        "501(a) of Regulation D and a &ldquo;qualified client&rdquo; as defined in "
        "Rule 205-3 of the Advisers Act; (ii) it is acquiring its Interest for its "
        "own account, for investment purposes only, and not with a view to "
        "distribution; (iii) it has received or had access to all information it "
        "deems relevant to evaluate the merits and risks of the prospective "
        "investment and has reviewed and understood all such information; (iv) it has "
        "the ability to bear the economic risk of an investment in the Fund for an "
        "indefinite period of time; and (v) it has such knowledge and experience of "
        "financial and business matters that it is capable of evaluating the merits "
        "of an investment in the Fund.")

    sub("Rule 506(c) Verification",
        "Because the Fund is offering Interests under Rule 506(c) of Regulation D, "
        "the General Partner is required to take reasonable steps to verify each "
        "prospective investor&rsquo;s accredited investor status. Self-certification "
        "alone is not sufficient. Prospective investors will be required to provide "
        "documentation (including, without limitation, tax returns, account "
        "statements, or a verification letter from a qualified third party) or such "
        "other evidence as the General Partner may reasonably request.")

    sub("Anti-Money Laundering and Know Your Customer",
        "All subscriptions for the Interests are subject to applicable anti-money-"
        "laundering regulations. Investors will be required to comply with anti-money-"
        "laundering procedures required by the Uniting and Strengthening America by "
        "Providing Appropriate Tools Required to Intercept and Obstruct Terrorism "
        "(USA PATRIOT Act) Act of 2001, the Bank Secrecy Act, and related regulations. "
        "As part of the Fund&rsquo;s obligations to comply with regulations aimed at "
        "the prevention of money laundering, the Fund may require verification of "
        "identity from all prospective investors, and may seek to (i) verify the "
        "identity of a prospective investor; (ii) ensure that the prospective "
        "investor is not named on a prohibited list maintained by the U.S. Treasury "
        "Department (including OFAC-administered lists); (iii) verify the source of "
        "a prospective investor&rsquo;s funds; (iv) monitor communications, capital "
        "contributions and withdrawals, and other payments involving the Limited "
        "Partner; and (v) report suspicious activity to appropriate authorities. The "
        "Fund may exercise special scrutiny when prospective investors are "
        "politically-exposed persons, are located in certain high-risk jurisdictions, "
        "or otherwise present elevated money-laundering risk.")

    sub("OFAC",
        "Economic sanctions laws administered by the U.S. Department of the "
        "Treasury&rsquo;s Office of Foreign Assets Control (&ldquo;OFAC&rdquo;) may "
        "prohibit the General Partner, the Investment Manager, the principals, and "
        "the Fund from transacting with or providing services to certain countries, "
        "territories, entities, and individuals. The lists of OFAC-prohibited "
        "countries, territories, persons, and entities (including the List of "
        "Specially Designated Nationals and Blocked Persons) are available on the "
        "OFAC website. The Fund reserves the right to refuse to accept any "
        "subscription or to cease any further dealings with any Limited Partner that "
        "is or becomes a Sanctions Subject, and to take such other actions as are "
        "required by applicable sanctions laws.")

    sub("Right to Refuse Distributions or Subscriptions",
        "The Fund reserves the right to request such information as is necessary to "
        "verify the identity of a prospective investor or a transferee of Interests. "
        "In the event of delay or failure to produce such information, the Fund may "
        "refuse to accept the subscription or transfer and may return any funds "
        "received without interest to the account from which the monies were "
        "originally debited. The Fund also reserves the right to refuse to make any "
        "distribution to a Limited Partner if the General Partner suspects or is "
        "advised that payment might result in a breach of applicable anti-money-"
        "laundering or other laws.")

    # ─────────── C. ERISA ────────────────────────────────────────────
    story.append(P("C.  CERTAIN ERISA CONSIDERATIONS", H2))

    story.append(P(
        "Each prospective investor that is an employee benefit plan subject to the "
        "Employee Retirement Income Security Act of 1974, as amended (an &ldquo;ERISA "
        "Plan&rdquo;), or a plan subject to Section 4975 of the Code, such as an "
        "individual retirement account (each, a &ldquo;Code Plan&rdquo;), and each "
        "prospective investor that is an entity whose underlying assets include plan "
        "assets of an ERISA Plan or a Code Plan (collectively, &ldquo;benefit plan "
        "investors&rdquo; or &ldquo;Plans&rdquo;) should consider the matters described "
        "in this section in determining whether to invest in the Fund. The provisions "
        "of ERISA are complex and their application to an investment in the Fund "
        "should be reviewed by the appropriate representatives of any prospective "
        "investor that is a Plan. The following is a summary only and is not a "
        "substitute for careful planning with a professional adviser.",
        BODY))

    sub("Fiduciary Matters and Prohibited Transactions Generally",
        "In considering an investment in the Fund of a portion of the assets of any "
        "Plan, a fiduciary should consider, among other factors: (i) whether the "
        "investment is in accordance with the documents and instruments governing the "
        "Plan; (ii) whether the investment satisfies the diversification requirements "
        "of Section 404(a)(1)(C) of ERISA, if applicable; (iii) whether the "
        "investment provides sufficient liquidity to permit benefit payments to be "
        "made as they become due; (iv) the fiduciary&rsquo;s requirement to annually "
        "value the assets of the Plan; (v) whether the investment is prudent, given "
        "the high degree of risk and the absence of a public market for the Interests; "
        "and (vi) whether the investment is for the exclusive purpose of providing "
        "benefits to Plan participants and their beneficiaries.",
        "ERISA and the Code prohibit Plan fiduciaries from engaging in various "
        "transactions (&ldquo;Prohibited Transactions&rdquo;) involving Plan assets "
        "with persons who have certain relationships with respect to the Plan (a "
        "&ldquo;party in interest&rdquo;). Absent an exemption, Plan fiduciaries "
        "should not purchase Interests with Plan assets if the General Partner or any "
        "affiliate has investment discretion with respect to those assets or provides "
        "individualized investment advice where there is an understanding that it "
        "will serve as the primary basis for the Plan&rsquo;s investment decisions.")

    sub("Plan Assets",
        "If the underlying assets of the Fund (as opposed to interests in the Fund "
        "alone) were deemed to be &ldquo;plan assets&rdquo; under ERISA, (i) the "
        "prudence and other fiduciary-responsibility standards of Title I of ERISA "
        "would extend to investments made by the Fund; and (ii) certain transactions "
        "in which the Fund might seek to engage could constitute Prohibited "
        "Transactions.",
        "Under a regulation (the &ldquo;Plan Assets Regulation&rdquo;) issued by the "
        "U.S. Department of Labor (&ldquo;DOL&rdquo;), the assets of certain entities "
        "in which a Plan makes an equity investment (other than an investment in a "
        "publicly offered security or a security issued by an investment company "
        "registered under the Investment Company Act) would be deemed to be assets "
        "of the investing Plan unless (i) the entity is an &ldquo;operating "
        "company&rdquo; (including a &ldquo;venture capital operating company&rdquo; "
        "or &ldquo;real estate operating company&rdquo;), or (ii) equity "
        "participation by benefit plan investors is less than 25% of any class of "
        "equity of the entity. Interests in the Fund will be neither publicly offered "
        "nor securities issued by a registered investment company within the meaning "
        "of the Plan Assets Regulation.",
        "The General Partner will use reasonable efforts either to (a) limit equity "
        "participation by benefit plan investors to less than 25% of the total value "
        "of each class of equity interests in the Partnership, or (b) structure "
        "Portfolio Investments and operate the Partnership in a manner that qualifies "
        "the Partnership as a venture capital operating company or real estate "
        "operating company under ERISA. The Fund cannot give any assurance that it "
        "will be able to satisfy either condition in all circumstances.")

    sub("Plan Asset Consequences of Prohibited Transactions",
        "If the Fund&rsquo;s assets were deemed to constitute plan assets subject to "
        "Title I of ERISA or Section 4975 of the Code and a non-exempt Prohibited "
        "Transaction were to occur, then the General Partner, as a fiduciary and "
        "party in interest, and any other party in interest engaged in the Prohibited "
        "Transaction could be required (i) to restore to the Plan any profit realized "
        "on the transaction and (ii) to reimburse the Plan for any losses suffered "
        "by the Plan as a result of the investment. In addition, each party in "
        "interest involved could be subject to an excise tax under Section 4975 of "
        "the Code, and Plan fiduciaries who made the decision to invest could, under "
        "certain circumstances, be liable as co-fiduciaries for actions taken by the "
        "Fund or the General Partner. Unless appropriate administrative exemptions "
        "were available, the Fund could be restricted from acquiring an otherwise "
        "desirable investment or from entering into an otherwise favorable "
        "transaction if such acquisition or transaction would constitute a Prohibited "
        "Transaction.")

    sub("Form 5500 and Alternative Reporting Option",
        "Most Plans must annually prepare and file with the Internal Revenue Service "
        "a Form 5500, Annual Return/Report of Employee Benefit Plan. Schedule C of "
        "Form 5500 requires expanded reporting of &ldquo;indirect compensation&rdquo; "
        "received by service providers to a Plan. The disclosure and description of "
        "the Fund&rsquo;s compensation arrangements contained in this Memorandum and "
        "the Partnership Agreement are intended to satisfy the requirements for the "
        "alternative reporting option for &ldquo;eligible indirect compensation&rdquo; "
        "under the instructions to Schedule C of Form 5500.")

    story.append(spacer(8))
    story.append(P(
        "EACH PLAN FIDUCIARY SHOULD CONSULT ITS LEGAL ADVISER CONCERNING THE "
        "POTENTIAL CONSEQUENCES UNDER ERISA, SECTION 4975 OF THE CODE, OR SIMILAR "
        "STATE LAW BEFORE MAKING AN INVESTMENT IN THE FUND.",
        CAPS_BODY))

    story.append(P(
        "ANY POTENTIAL INVESTOR CONSIDERING AN INVESTMENT IN INTERESTS THAT IS, OR "
        "IS ACTING ON BEHALF OF, A PLAN (OR A GOVERNMENTAL PLAN SUBJECT TO LAWS "
        "SIMILAR TO ERISA AND/OR SECTION 4975 OF THE CODE) IS STRONGLY URGED TO "
        "CONSULT ITS OWN LEGAL, TAX, AND ERISA ADVISERS REGARDING THE CONSEQUENCES "
        "OF SUCH AN INVESTMENT AND THE ABILITY TO MAKE THE REPRESENTATIONS "
        "DESCRIBED ABOVE.",
        CAPS_BODY))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# SECTION X — INVESTOR SUITABILITY STANDARDS
# ═══════════════════════════════════════════════════════════════════════════
def build_suitability():
    story = []
    story.append(P("X.  INVESTOR SUITABILITY STANDARDS", H1))

    story.append(P(
        "Prospective investors should satisfy themselves that an investment in the "
        "Fund is suitable for them, should examine this Memorandum, the Partnership "
        "Agreement, and the Subscription Documents, and should avail themselves of "
        "access to such additional information about this offering, the Fund, the "
        "General Partner, and its affiliates as they consider necessary to make an "
        "informed investment decision.",
        BODY))

    story.append(P(
        "Interests in the Fund may be purchased only by sophisticated investors who: "
        "(i) qualify as &ldquo;accredited investors&rdquo; as defined in Rule 501(a) "
        "of Regulation D under the Securities Act; (ii) qualify as &ldquo;qualified "
        "clients&rdquo; as defined in Rule 205-3 under the Advisers Act; and (iii) "
        "satisfy the Fund&rsquo;s suitability criteria set forth in greater detail in "
        "the Subscription Documents. The General Partner may require certain "
        "subscribers (but not others) to meet heightened net worth requirements and/or "
        "to demonstrate specific knowledge of or experience with hedge-fund investments.",
        BODY))

    story.append(P(
        "In addition to net-worth and income standards, each subscriber must have "
        "funds adequate to meet personal needs and contingencies, must have no need "
        "for prompt liquidity from the investment, and must purchase Interests for "
        "investment only and not with a view to their sale or distribution.",
        BODY))

    story.append(P(
        "Each subscriber must also have sufficient knowledge and experience in "
        "financial and business matters generally, and in securities investment in "
        "particular, to be capable of evaluating the merits and risks of investing "
        "in the Fund. Because of the restrictions on withdrawal from the Fund and the "
        "risks of the Fund&rsquo;s investment program (some of which are described in "
        "Section VIII, &ldquo;Risk Factors and Conflicts of Interest&rdquo;), a "
        "purchase of Interests would not be suitable for any subscriber who does not "
        "meet the suitability standards discussed in this Memorandum.",
        BODY))

    story.append(P(
        "The General Partner reserves the right to accept or reject any "
        "subscriber&rsquo;s subscription to purchase Interests, in whole or in part, "
        "in its sole and absolute discretion. A prospective subscriber may not rely "
        "on the General Partner to determine the suitability of an investment in the "
        "Interests for such prospective subscriber. The General Partner assumes no "
        "liability for a subscriber&rsquo;s decision to invest in the Fund.",
        BODY))

    story.append(P("Reliance on Subscriber Information", H2))

    story.append(P(
        "The Fund requests certain information regarding the satisfaction of "
        "subscriber suitability standards in the Investor Questionnaire and "
        "Accredited Investor Verification form that each prospective subscriber must "
        "complete. Each Limited Partner will make representations to the Fund in the "
        "Subscription Documents that the Fund will rely upon in accepting the "
        "subscription. Because the Fund is offering Interests under Rule 506(c) of "
        "Regulation D, the General Partner is required to take reasonable steps to "
        "verify each subscriber&rsquo;s accredited investor status through "
        "documentation or a written verification from a qualified third party. "
        "Self-certification is not sufficient. Each prospective subscriber must "
        "provide whatever additional evidence is deemed necessary by the General "
        "Partner to substantiate the information or representations contained in its "
        "Subscription Documents.",
        BODY))

    story.append(P(
        "The General Partner may reject any subscription for any reason, regardless "
        "of whether a prospective subscriber meets the suitability standards. The "
        "General Partner may waive minimum suitability standards not imposed by law. "
        "The standards set forth above are only minimum standards.",
        BODY))

    story.append(P("Investment Company Act Limitations", H2))

    story.append(P(
        "As a result of the Fund&rsquo;s reliance on the Section 3(c)(1) exemption "
        "under the Investment Company Act, no corporation, limited liability company, "
        "partnership, trust, association, or other entity that is registered as an "
        "investment company under the Investment Company Act, or that relies on the "
        "exclusions from the definition of investment company contained in Section "
        "3(c)(1) or 3(c)(7) of the Investment Company Act, may own 10% or more of the "
        "outstanding equity Interests of the Fund.",
        BODY))

    story.append(P("Transfers of Interests", H2))

    story.append(P(
        "Transfers of Interests without the prior written consent of the General "
        "Partner, which may be granted, withheld, conditioned, or delayed in the "
        "General Partner&rsquo;s sole and absolute discretion, are not permitted. "
        "Any transferee of Interests must meet all investor suitability standards, "
        "complete Subscription Documents, and comply with applicable anti-money-"
        "laundering requirements. Any attempted transfer that is not made in "
        "accordance with the Partnership Agreement will be null and void <i>ab "
        "initio</i>.",
        BODY))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# SECTION XI — SUBSCRIPTION PROCEDURE
# ═══════════════════════════════════════════════════════════════════════════
def build_subscription_procedure():
    story = []
    story.append(P("XI.  SUBSCRIPTION PROCEDURE", H1))

    story.append(P(
        "Each prospective investor must complete and execute the following documents "
        "(collectively, the &ldquo;Subscription Documents&rdquo;) prior to admission "
        "as a Limited Partner of the Fund:",
        BODY))

    story.append(bullet(
        "the Fund&rsquo;s <b>Subscription Agreement</b> (attached hereto as Exhibit A);"))
    story.append(bullet(
        "the Fund&rsquo;s <b>Limited Partnership Agreement</b>, "
        "including the signature page and any required counterparts (attached hereto "
        "as Exhibit B);"))
    story.append(bullet(
        "the Fund&rsquo;s <b>Investor Questionnaire</b>, including completed "
        "accredited-investor, qualified-client, and suitability certifications;"))
    story.append(bullet(
        "the Fund&rsquo;s <b>Accredited Investor Verification</b>, signed either by "
        "the prospective investor&rsquo;s qualified third-party verifier (a licensed "
        "attorney, certified public accountant, registered broker-dealer, or "
        "SEC-registered investment adviser) or accompanied by documentary evidence "
        "reviewed and accepted by the General Partner;"))
    story.append(bullet(
        "a completed and executed <b>IRS Form W-9</b> (for U.S. persons) or the "
        "appropriate IRS Form W-8 series (for non-U.S. persons);"))
    story.append(bullet(
        "such other <b>anti-money-laundering and know-your-customer documentation</b> "
        "as the General Partner or the Administrator may reasonably request."))

    story.append(P(
        "No later than twenty-four (24) hours prior to the applicable closing (unless "
        "the General Partner waives such deadline in its sole discretion), the "
        "prospective investor must deliver all executed Subscription Documents and "
        "supporting documentation to the General Partner or the Administrator, by "
        "mail or electronically as instructed. Once delivered, subscriptions are "
        "irrevocable by the prospective investor. Capital contributions must be made "
        "by wire transfer in U.S. dollars to the Fund&rsquo;s designated account, "
        "pursuant to wiring instructions provided by the Administrator, or in such "
        "other form as the General Partner may approve in its sole and absolute "
        "discretion.",
        BODY))

    story.append(P(
        "By executing the Subscription Documents (including by electronic signature "
        "pursuant to the Electronic Signatures in Global and National Commerce Act "
        "and the Uniform Electronic Transactions Act, as adopted in Delaware), the "
        "prospective investor agrees to all relevant terms and makes all necessary "
        "representations set forth in the Partnership Agreement and the Subscription "
        "Agreement. Each prospective investor is responsible for reading and "
        "understanding each provision of the Subscription Documents and this "
        "Memorandum before executing. The General Partner may accept or reject, in "
        "whole or in part, any subscription in its sole and absolute discretion and "
        "may allocate Interests among subscribers in any manner it determines.",
        BODY))

    story.append(P(
        "Upon acceptance of a subscription, the General Partner will provide written "
        "notice of admission to the accepted subscriber, after which the subscriber "
        "will be a Limited Partner of the Fund.",
        BODY))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# SECTION XII — ADDITIONAL INFORMATION
# ═══════════════════════════════════════════════════════════════════════════
def build_additional_information():
    story = []
    story.append(P("XII.  ADDITIONAL INFORMATION", H1))

    story.append(P(
        "Prospective subscribers are invited and strongly encouraged to contact the "
        "General Partner for further explanation of the terms and conditions of this "
        "offering and to obtain any additional information necessary to verify the "
        "information contained in this Memorandum, to the extent the General Partner "
        "possesses such information or can acquire it without unreasonable effort or "
        "expense. Requests for such information should be directed to the General "
        "Partner at the address and contact details set forth on the cover of this "
        "Memorandum.",
        BODY))

    story.append(P(
        "The Partnership Agreement, the Subscription Agreement, the Investor "
        "Questionnaire, the Accredited Investor Verification, the Investment "
        "Management Agreement between the Fund and the Investment Manager, and the "
        "administrator services agreement between the Fund and NAV Consulting, Inc., "
        "together with related instruments, are available for review by prospective "
        "subscribers and their professional advisors upon written request to the "
        "General Partner. Certain service-provider agreements (including the "
        "administrator services agreement) contain confidential fee information that "
        "the applicable service provider may elect not to disclose.",
        BODY))

    story.append(P("No Reliance Without Final Offering Documents", H2))

    story.append(P(
        "Prospective investors may not rely on this Memorandum alone in making an "
        "investment decision. Reliance should be placed only on the Fund&rsquo;s "
        "final offering documents, including the Partnership Agreement, the "
        "Subscription Agreement, the exhibits hereto, and any supplements or "
        "amendments delivered in writing by the General Partner, in each case as "
        "supplemented by the advice of the prospective investor&rsquo;s own "
        "qualified legal, tax, and financial advisors.",
        BODY))

    story.append(P("Supersession of Prior Offering Materials", H2))

    story.append(P(
        "This Memorandum supersedes all prior private placement memoranda, term "
        "sheets, summaries, and marketing materials previously provided to "
        "prospective investors in connection with the Fund. Any statement inconsistent "
        "with this Memorandum, the Partnership Agreement, or the Subscription "
        "Documents that appears in any prior material should be disregarded in favor "
        "of this Memorandum and the Fund&rsquo;s current offering documents.",
        BODY))

    story.append(P("Closing Acknowledgment", H2))

    story.append(P(
        "The terms and conditions of this offering of Interests, including the "
        "rights, preferences, privileges, and restrictions with respect to the "
        "Interests and the rights and liabilities of the Partnership, the General "
        "Partner, and the Limited Partners, are governed by the Partnership "
        "Agreement and the Subscription Documents. The descriptions of any such "
        "matters in this Memorandum are subject to and qualified in their entirety "
        "by reference to the Partnership Agreement and the Subscription Documents.",
        BODY))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# EXHIBIT A — SUBSCRIPTION AGREEMENT (placeholder/reference)
# ═══════════════════════════════════════════════════════════════════════════
def build_exhibit_a():
    story = []
    story.append(P("EXHIBIT A", H1))
    story.append(P("SUBSCRIPTION AGREEMENT", TITLE_STYLE))
    story.append(Spacer(1, 0.3 * inch))

    story.append(P(
        "The Fund&rsquo;s Subscription Agreement is delivered to prospective investors "
        "as a separate document in connection with the offering of Interests. A copy "
        "of the Subscription Agreement is available from the General Partner upon "
        "written request. The Subscription Agreement sets forth, among other things, "
        "the representations, warranties, and covenants required of each prospective "
        "investor, the accredited-investor and qualified-client certifications, the "
        "anti-money-laundering and sanctions representations, the FATCA-related "
        "covenants, the power of attorney granted to the General Partner, and the "
        "mechanics of subscription acceptance.",
        BODY))

    story.append(P(
        "<i>[The full text of the Subscription Agreement is delivered to each "
        "prospective investor as part of the Fund&rsquo;s Subscription Documents "
        "package and is made a part of the Fund&rsquo;s offering materials by this "
        "reference.]</i>",
        BODY))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# EXHIBIT B — AMENDED AND RESTATED LIMITED PARTNERSHIP AGREEMENT (placeholder)
# ═══════════════════════════════════════════════════════════════════════════
def build_exhibit_b():
    story = []
    story.append(P("EXHIBIT B", H1))
    story.append(P("LIMITED PARTNERSHIP AGREEMENT", TITLE_STYLE))
    story.append(Spacer(1, 0.3 * inch))

    story.append(P(
        "The Fund&rsquo;s Limited Partnership Agreement is "
        "delivered to prospective investors as a separate document in connection with "
        "the offering of Interests. A copy of the Partnership Agreement is available "
        "from the General Partner upon written request. The Partnership Agreement "
        "sets forth the legal relationship between the General Partner and the "
        "Limited Partners, and governs all matters relating to the Partnership, "
        "including capital contributions, Capital Accounts, allocations of profits "
        "and losses, the Management Fee and Performance Allocation, the Hurdle Rate "
        "and High Water Mark, the Loss Recovery Account, withdrawal mechanics, "
        "indemnification, transfer restrictions, amendment provisions, governance "
        "matters (including removal of the General Partner and Key Person provisions), "
        "and dissolution.",
        BODY))

    story.append(P(
        "<i>[The full text of the Limited Partnership Agreement "
        "is delivered to each prospective investor as part of the Fund&rsquo;s "
        "Subscription Documents package and is made a part of the Fund&rsquo;s "
        "offering materials by this reference.]</i>",
        BODY))

    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# PLACEHOLDER STUBS FOR REMAINING SECTIONS (to be fleshed out in next iteration)
# ═══════════════════════════════════════════════════════════════════════════
def build_stub(section_num_title, description):
    story = []
    story.append(P(section_num_title, H1))
    story.append(P(
        f"<i>[This section is in draft. Content to be populated from the attorney "
        f"baseline plus the user-approved revisions per the Phase 1 edit plan. "
        f"Intended scope: {description}]</i>",
        BODY))
    story.append(PageBreak())
    return story


# ═══════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════
def build():
    doc = SimpleDocTemplate(
        OUT_PATH,
        pagesize=letter,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        topMargin=1.0 * inch,
        bottomMargin=1.0 * inch,
        title="PNTHR Tree Fund, LP - Private Placement Memorandum v1.0",
        author="PNTHR Funds, LLC",
        subject="Private Placement Memorandum",
    )
    story = []
    # Cover (no header/footer on page 1)
    story.extend(build_cover())
    story.extend(build_toc())
    story.extend(build_notices())
    story.extend(build_executive_summary())
    story.extend(build_summary_of_terms())

    # Sections III, IV, V, VI (fully drafted)
    story.extend(build_investment_opportunity())
    story.extend(build_investment_strategy())
    story.extend(build_investment_process())
    story.extend(build_management())

    # Stubs for the rest (fleshed out in follow-up iterations)
    story.extend(build_detailed_summary_of_terms())
    story.extend(build_risk_factors())
    story.extend(build_tax_regulatory())
    story.extend(build_suitability())
    story.extend(build_subscription_procedure())
    story.extend(build_additional_information())
    story.extend(build_exhibit_a())
    story.extend(build_exhibit_b())

    # Build with header/footer on every page
    doc.build(story, onFirstPage=on_cover, onLaterPages=on_page)
    print(f"PDF generated: {OUT_PATH}")


if __name__ == "__main__":
    build()
