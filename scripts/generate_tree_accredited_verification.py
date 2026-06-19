#!/usr/bin/env python3
"""Generate PNTHR Tree Fund Accredited Investor & Qualified Client Verification Certificate v1.0"""

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Image,
    Table, TableStyle, HRFlowable, Flowable
)
from reportlab.lib import colors
import os

FUND       = "PNTHR Tree Fund, LP"
FUND_UPPER = "PNTHR AI ELITE 300 FUND, LP"
VERSION    = "v1.0"

OUTPUT = os.path.expanduser(f"~/Downloads/PNTHR_Tree_Fund_Accredited_Investor_Verification_{VERSION}_2026.pdf")
LOGO   = os.path.expanduser("~/Downloads/PNTHR FUNDS Logo white background 2 lines (3).png")

_CB_IMG_PATH = os.path.expanduser("~/Downloads/_checkbox_empty.png")
def _make_checkbox_image():
    from PIL import Image as PILImage, ImageDraw
    size = 24
    img = PILImage.new('RGBA', (size, size), (255, 255, 255, 0))
    draw = ImageDraw.Draw(img)
    draw.rectangle([1, 1, size-2, size-2], outline='black', width=2, fill='white')
    img.save(_CB_IMG_PATH)
_make_checkbox_image()

CB = f'<img src="{_CB_IMG_PATH}" width="9" height="9" valign="-1"/>'


class CheckBox(Flowable):
    def __init__(self, size=8):
        Flowable.__init__(self)
        self.size = size
        self.width = size
        self.height = size

    def draw(self):
        self.canv.setStrokeColor(colors.black)
        self.canv.setLineWidth(0.75)
        self.canv.rect(0, 1, self.size, self.size, stroke=1, fill=0)

def cb():
    return CheckBox(8)


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont('Times-Roman', 8)
    canvas.drawCentredString(
        letter[0] / 2, 0.4 * inch,
        FUND_UPPER)
    canvas.drawCentredString(
        letter[0] / 2, 0.27 * inch,
        'ACCREDITED INVESTOR AND QUALIFIED CLIENT VERIFICATION CERTIFICATE')
    canvas.restoreState()


doc = SimpleDocTemplate(
    OUTPUT, pagesize=letter,
    topMargin=0.6 * inch, bottomMargin=0.7 * inch,
    leftMargin=0.85 * inch, rightMargin=0.85 * inch,
)

styles = getSampleStyleSheet()

styles.add(ParagraphStyle('DocTitle', fontSize=13, leading=16, fontName='Times-Bold', alignment=TA_CENTER, spaceAfter=3))
styles.add(ParagraphStyle('DocSub', fontSize=11, leading=14, fontName='Times-Bold', alignment=TA_CENTER, spaceAfter=3))
styles.add(ParagraphStyle('SmallCaps', fontSize=10.5, leading=13, fontName='Times-Bold', alignment=TA_CENTER, spaceAfter=8))
styles.add(ParagraphStyle('Center', fontSize=10, leading=13, fontName='Times-Roman', alignment=TA_CENTER, spaceAfter=6))
styles.add(ParagraphStyle('CenterI', fontSize=10, leading=13, fontName='Times-Italic', alignment=TA_CENTER, spaceAfter=8))
styles.add(ParagraphStyle('B', fontSize=10, leading=13, fontName='Times-Roman', alignment=TA_JUSTIFY, spaceAfter=8))
styles.add(ParagraphStyle('BB', fontSize=10, leading=13, fontName='Times-Bold', alignment=TA_JUSTIFY, spaceAfter=8))
styles.add(ParagraphStyle('BI', fontSize=10, leading=13, fontName='Times-Roman', alignment=TA_JUSTIFY, spaceAfter=6, leftIndent=36))
styles.add(ParagraphStyle('Check', fontSize=10, leading=13, fontName='Times-Roman', spaceAfter=5, leftIndent=54, firstLineIndent=-18))
styles.add(ParagraphStyle('FormLabel', fontSize=9, leading=12, fontName='Times-Roman', spaceAfter=2))
styles.add(ParagraphStyle('Small', fontSize=9, leading=11, fontName='Times-Roman', alignment=TA_JUSTIFY, spaceAfter=6))
styles.add(ParagraphStyle('SmallI', fontSize=9, leading=11, fontName='Times-Italic', alignment=TA_JUSTIFY, spaceAfter=6))
styles.add(ParagraphStyle('BL', fontSize=10, leading=13, fontName='Times-Roman', alignment=TA_LEFT, spaceAfter=8))

story = []

# ============================================================
# HEADER
# ============================================================
if os.path.exists(LOGO):
    logo = Image(LOGO, width=3.5 * inch, height=1.4 * inch)
    logo.hAlign = 'CENTER'
    story.append(logo)
    story.append(Spacer(1, 10))

story.append(Paragraph("PNTHR AI ELITE 300 FUND, LP", styles['DocTitle']))
story.append(Spacer(1, 4))
story.append(Paragraph(
    '<u>A<font size="9">CCREDITED</font> I<font size="9">NVESTOR AND</font> '
    'Q<font size="9">UALIFIED</font> C<font size="9">LIENT</font> '
    'V<font size="9">ERIFICATION</font> C<font size="9">ERTIFICATE</font></u>',
    styles['SmallCaps']))

story.append(Spacer(1, 10))

story.append(Paragraph('Date _________________, 2026', styles['Center']))
story.append(Spacer(1, 8))

story.append(Paragraph(
    '(<b><i>The Investor\'s broker, investment adviser, CPA or attorney</i></b> needs to date, fill in, complete, '
    'and sign this accredited investor certification letter)', styles['CenterI']))
story.append(Spacer(1, 6))

story.append(Paragraph(
    f'To {FUND}, its affiliates and clients:', styles['B']))

story.append(Paragraph(
    'Please be advised that with regard to _______________________________________, (the "Investor") '
    'this is to certify that:', styles['B']))

# ============================================================
# Section 1
# ============================================================
story.append(Paragraph(
    '<b>1.</b>&nbsp;&nbsp;&nbsp;&nbsp;I am a (check all that apply):', styles['B']))

verifier_items = [
    'FINRA registered broker-dealer.',
    'Investment Adviser registered with the SEC.',
    'State-registered investment adviser.',
    'Licensed Attorney in good standing in the jurisdiction(s) in which I am admitted.',
    'Licensed Certified Public Accountant in good standing under the laws of my residence or principal place of business.',
]

for item in verifier_items:
    row = Table([[cb(), Paragraph(item, styles['B'])]], colWidths=[0.3 * inch, 5.0 * inch])
    row.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('LEFTPADDING', (0, 0), (0, 0), 4),
        ('LEFTPADDING', (1, 0), (1, 0), 6),
    ]))
    row.hAlign = 'CENTER'
    story.append(row)

story.append(Spacer(1, 4))

# ============================================================
# Section 2
# ============================================================
story.append(Paragraph(
    '<b>2.</b>&nbsp;&nbsp;&nbsp;&nbsp;I have taken reasonable steps to verify that the Investor is an "Accredited Investor" '
    'within the meaning of Rule 501(a) of SEC Regulation D as of _________________________________ '
    '(applicable date within 60 days of this letter).', styles['B']))

# ============================================================
# Section 3
# ============================================================
story.append(Paragraph(
    '<b>3.</b>&nbsp;&nbsp;&nbsp;&nbsp;I have determined that the Investor also meets the qualifications of a "Qualified Client" '
    'as per Section 205-3 of the Investment Advisers Act of 1940 as of such date.', styles['B']))

# ============================================================
# Section 4
# ============================================================
story.append(Paragraph(
    '<b>4.</b>&nbsp;&nbsp;&nbsp;&nbsp;This letter is provided to satisfy the "reasonable steps" verification requirement under '
    'Rule 506(c) of Regulation D promulgated under the Securities Act of 1933, as amended.', styles['B']))

# ============================================================
# Section 5
# ============================================================
story.append(Paragraph(
    '<b>5.</b>&nbsp;&nbsp;&nbsp;&nbsp;In making the above determinations, I reviewed the following documentation '
    '(check all that apply):', styles['B']))

method_items = [
    'Tax returns (IRS Forms W-2, 1040, K-1, or equivalent) for the two most recent years.',
    'Bank, brokerage, or other financial account statements.',
    'Credit report from a nationally recognized credit reporting agency.',
    'Written confirmation from a registered broker-dealer, SEC-registered investment adviser, '
    'licensed attorney, or certified public accountant that has taken reasonable steps to verify '
    'the Investor\'s accredited status within the prior three months.',
    'Third-party verification letter or certification.',
    'Other documentation (describe): ____________________________________________',
]

for item in method_items:
    st = styles['BL'] if item.startswith('Other') else styles['B']
    row = Table([[cb(), Paragraph(item, st)]], colWidths=[0.3 * inch, 5.0 * inch])
    row.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('LEFTPADDING', (0, 0), (0, 0), 4),
        ('LEFTPADDING', (1, 0), (1, 0), 6),
    ]))
    row.hAlign = 'CENTER'
    story.append(row)

story.append(Spacer(1, 4))

# ============================================================
# Section 6
# ============================================================
story.append(Paragraph(
    f'<b>6.</b>&nbsp;&nbsp;&nbsp;&nbsp;This letter may be relied upon by {FUND}, its '
    'affiliates and clients.', styles['B']))

# ============================================================
# Section 7
# ============================================================
story.append(Paragraph(
    '<b>7.</b>&nbsp;&nbsp;&nbsp;&nbsp;I understand that re-verification may be required for subsequent subscriptions or '
    'additional capital contributions to the Fund, and that this certification is valid for a period not to exceed '
    '90 days from the date set forth in Section 2 above.', styles['B']))

story.append(Spacer(1, 14))

# ============================================================
# SIGNATURE BLOCK
# ============================================================
story.append(Paragraph('Sincerely,', styles['B']))
story.append(Spacer(1, 12))

sig_rows = [
    ['_________________________________', '(Name of broker, investment adviser, CPA or attorney)'],
    ['_________________________________', '(Firm Name of broker, investment adviser, CPA or attorney)'],
    ['_________________________________', '(Address of broker, investment adviser, CPA or attorney)'],
    ['_________________________________', '(Address line 2)'],
    ['', ''],
    ['_________________________________', '(Signature)'],
    ['_________________________________', '(Title)'],
]

sig_table = Table(sig_rows, colWidths=[2.5 * inch, 3.5 * inch])
sig_table.setStyle(TableStyle([
    ('FONTNAME', (0, 0), (-1, -1), 'Times-Roman'),
    ('FONTSIZE', (0, 0), (-1, -1), 10),
    ('TOPPADDING', (0, 0), (-1, -1), 4),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ('LEFTPADDING', (0, 0), (-1, -1), 0),
    ('VALIGN', (0, 0), (-1, -1), 'BOTTOM'),
]))
story.append(sig_table)

doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(f"PDF generated: {OUTPUT}")
print(f"Size: {os.path.getsize(OUTPUT):,} bytes")
