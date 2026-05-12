#!/usr/bin/env python3
"""
Export PNTHR AI Elite Fund backtest source code to a single PDF.
Includes: Phase 4 Simulator, Fee Overlay, IR Metrics Computation.
Output: ~/Downloads/PNTHR_AI_Elite_Fund_Backtest_Source_Code_v1.pdf
"""

import os
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER

OUTPUT = os.path.expanduser("~/Downloads/PNTHR_AI_Elite_Fund_Backtest_Source_Code_v1.pdf")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

FILES = [
    ("ai300Phase4Simulator.js",  "Phase 4 Backtest Simulator (Weekly + Daily Cascade)"),
    ("ai300FeeOverlay.js",       "PPM v6.9 Fee Overlay (Gross-to-Net per Tier)"),
    ("ai300IrMetrics.js",        "Intelligence Report Metrics Computation"),
]

BLACK  = HexColor("#000000")
YELLOW = HexColor("#FFD700")
WHITE  = HexColor("#FFFFFF")
GRAY   = HexColor("#999999")
DARK   = HexColor("#1a1a1a")

def build_pdf():
    doc = SimpleDocTemplate(
        OUTPUT,
        pagesize=letter,
        topMargin=0.6*inch,
        bottomMargin=0.6*inch,
        leftMargin=0.6*inch,
        rightMargin=0.6*inch,
    )

    title_style = ParagraphStyle(
        "Title", fontName="Helvetica-Bold", fontSize=18,
        textColor=BLACK, alignment=TA_CENTER, spaceAfter=6,
    )
    subtitle_style = ParagraphStyle(
        "Subtitle", fontName="Helvetica", fontSize=11,
        textColor=GRAY, alignment=TA_CENTER, spaceAfter=20,
    )
    section_style = ParagraphStyle(
        "Section", fontName="Helvetica-Bold", fontSize=13,
        textColor=BLACK, spaceBefore=16, spaceAfter=8,
        borderWidth=0, borderPadding=4,
    )
    file_label_style = ParagraphStyle(
        "FileLabel", fontName="Courier", fontSize=8,
        textColor=GRAY, alignment=TA_LEFT, spaceAfter=4,
    )
    code_style = ParagraphStyle(
        "Code", fontName="Courier", fontSize=6.5,
        textColor=BLACK, alignment=TA_LEFT,
        leading=8.5, spaceAfter=0, spaceBefore=0,
        leftIndent=4, rightIndent=4,
    )

    story = []

    # Cover
    story.append(Spacer(1, 1.5*inch))
    story.append(Paragraph("PNTHR AI ELITE FUND", title_style))
    story.append(Spacer(1, 6))
    story.append(Paragraph("Backtest Source Code Reference", ParagraphStyle(
        "Sub2", fontName="Helvetica-Bold", fontSize=14,
        textColor=BLACK, alignment=TA_CENTER, spaceAfter=12,
    )))
    story.append(Paragraph(
        "Phase 4 Simulator &bull; PPM v6.9 Fee Engine &bull; IR Metrics",
        subtitle_style,
    ))
    story.append(Spacer(1, 0.3*inch))
    story.append(Paragraph(
        "297-Name PNTHR AI Universe &bull; PAI300 Regime Gate &bull; Daily Cascade Architecture",
        ParagraphStyle("Sub3", fontName="Helvetica", fontSize=9, textColor=GRAY, alignment=TA_CENTER, spaceAfter=6),
    ))
    story.append(Paragraph(
        "Inception: 2022-11-30 (ChatGPT Launch Date)",
        ParagraphStyle("Sub4", fontName="Helvetica", fontSize=9, textColor=GRAY, alignment=TA_CENTER, spaceAfter=30),
    ))

    # TOC
    story.append(Paragraph("CONTENTS", ParagraphStyle(
        "TOC", fontName="Helvetica-Bold", fontSize=11, textColor=BLACK,
        alignment=TA_CENTER, spaceBefore=20, spaceAfter=12,
    )))
    for i, (fname, desc) in enumerate(FILES, 1):
        story.append(Paragraph(
            f"{i}. {desc}<br/><font color='#999999' size='8'>     {fname}</font>",
            ParagraphStyle("TOCItem", fontName="Helvetica", fontSize=10, textColor=BLACK,
                          alignment=TA_CENTER, spaceAfter=6),
        ))

    story.append(PageBreak())

    # Each file
    for fname, desc in FILES:
        story.append(Paragraph(desc, section_style))
        story.append(Paragraph(f"server/backtest/{fname}", file_label_style))
        story.append(Spacer(1, 4))

        fpath = os.path.join(SCRIPT_DIR, fname)
        with open(fpath, "r") as f:
            lines = f.readlines()

        for line_num, raw_line in enumerate(lines, 1):
            display = raw_line.rstrip("\n")
            # Escape XML entities
            display = display.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            # Replace tabs with spaces
            display = display.replace("\t", "    ")
            # Preserve leading spaces with non-breaking spaces
            stripped = display.lstrip(" ")
            leading = len(display) - len(stripped)
            display = "&nbsp;" * leading + stripped

            num_str = f"<font color='#999999'>{line_num:4d}</font>  "
            story.append(Paragraph(num_str + display, code_style))

        story.append(PageBreak())

    doc.build(story)
    print(f"  -> {OUTPUT}")

if __name__ == "__main__":
    print("Building backtest source code PDF...")
    build_pdf()
    print("Done.")
