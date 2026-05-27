#!/usr/bin/env python3
"""
PNTHR AI Elite 300 Fund, LP — Performance Summary v2.1
All numbers sourced from AI Elite IR v10.2 Multi-strategy + MCE
(Filet $100K, Porterhouse $500K, Wagyu $1M).
v2.1: SPY benchmark corrected to measure from first trade date (Jun 13, 2022).

Output: ~/Downloads/PNTHR_AI_Elite_300_Performance_Summary_v2.1_2026.pdf
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (
    Paragraph, Spacer, PageBreak, Table, TableStyle,
)
from reportlab.lib import colors

from pnthr_design import (
    PALETTE_YELLOW, PALETTE_BLACK, PALETTE_WHITE, PALETTE_DIM_GRAY,
    PALETTE_PURE_BLACK, PALETTE_TABLE_GRAY,
    H1, H2, BODY, BODY_LEFT,
    make_doc_template, make_page_handlers, build_cover_header,
)

FUND       = "PNTHR AI Elite 300 Fund, LP"
FUND_UPPER = "PNTHR AI ELITE 300 FUND"
VERSION    = "v2.1"
DATE_DISP  = "May 2026"

OUT_PATH = os.path.expanduser(
    f"~/Downloads/PNTHR_AI_Elite_300_Performance_Summary_{VERSION}_2026.pdf")

# ── Local styles ──────────────────────────────────────────────────────────────
CLASS_HDR = ParagraphStyle(
    name="class_hdr", fontName="Helvetica-Bold", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=14, spaceAfter=6,
)
SMALL = ParagraphStyle(
    name="small", fontName="Helvetica", fontSize=9, leading=11,
    alignment=TA_JUSTIFY, spaceBefore=2, spaceAfter=6,
    textColor=PALETTE_DIM_GRAY,
)
SMALL_ITAL = ParagraphStyle(
    name="small_ital", fontName="Helvetica-Oblique", fontSize=9, leading=11,
    alignment=TA_JUSTIFY, spaceBefore=2, spaceAfter=6,
    textColor=PALETTE_DIM_GRAY,
)
FAQ_Q = ParagraphStyle(
    name="faq_q", fontName="Helvetica-Bold", fontSize=11, leading=14,
    alignment=TA_LEFT, spaceBefore=10, spaceAfter=4,
)


def P(text, style=BODY):
    return Paragraph(text, style)


def spacer(h=8):
    return Spacer(1, h)


def metrics_table(rows):
    """4-column Metric / Gross / Net / Fee Drag table."""
    hdr_style = ParagraphStyle(
        name="th", fontName="Helvetica-Bold", fontSize=10, leading=13,
        alignment=TA_LEFT)
    cell_style = ParagraphStyle(
        name="td", fontName="Helvetica", fontSize=10, leading=13,
        alignment=TA_LEFT)

    data = [[
        Paragraph("<b>Metric</b>", hdr_style),
        Paragraph("<b>Gross</b>", hdr_style),
        Paragraph("<b>Net</b>", hdr_style),
        Paragraph("<b>Fee Drag</b>", hdr_style),
    ]]
    for row in rows:
        data.append([Paragraph(c, cell_style) for c in row])

    tbl = Table(data, colWidths=[2.2 * inch, 1.4 * inch, 1.4 * inch, 1.4 * inch])
    tbl.setStyle(TableStyle([
        ("BOX",           (0, 0), (-1, -1), 0.5, colors.black),
        ("INNERGRID",     (0, 0), (-1, -1), 0.3, colors.Color(0.85, 0.85, 0.85)),
        ("BACKGROUND",    (0, 0), (-1, 0),  colors.Color(0.12, 0.12, 0.12)),
        ("TEXTCOLOR",     (0, 0), (-1, 0),  PALETTE_WHITE),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
        ("TOPPADDING",    (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LINEABOVE",     (0, 0), (-1, 0),  1.5, PALETTE_YELLOW),
    ]))
    return tbl


def direction_table():
    """BL / SS / Combined trade activity table (from Wagyu $1M IR v10.2)."""
    hdr_style = ParagraphStyle(
        name="th2", fontName="Helvetica-Bold", fontSize=10, leading=13,
        alignment=TA_LEFT)
    cell_style = ParagraphStyle(
        name="td2", fontName="Helvetica", fontSize=10, leading=13,
        alignment=TA_LEFT)

    data = [
        [Paragraph(c, hdr_style) for c in
         ["Metric", "BL (Longs)", "SS (Shorts)", "Combined"]],
        [Paragraph(c, cell_style) for c in
         ["Profit Factor", "2.92x", "0.66x", "2.79x"]],
        [Paragraph(c, cell_style) for c in
         ["Win Rate", "34.5%", "24.6%", "33.6%"]],
        [Paragraph(c, cell_style) for c in
         ["Win/Loss Payoff", "5.5x", "2.0x", "5.5x"]],
        [Paragraph(c, cell_style) for c in
         ["Total Closed Trades", "1,371", "134", "1,505"]],
    ]

    tbl = Table(data, colWidths=[2.2 * inch, 1.4 * inch, 1.4 * inch, 1.4 * inch])
    tbl.setStyle(TableStyle([
        ("BOX",           (0, 0), (-1, -1), 0.5, colors.black),
        ("INNERGRID",     (0, 0), (-1, -1), 0.3, colors.Color(0.85, 0.85, 0.85)),
        ("BACKGROUND",    (0, 0), (-1, 0),  colors.Color(0.12, 0.12, 0.12)),
        ("TEXTCOLOR",     (0, 0), (-1, 0),  PALETTE_WHITE),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
        ("TOPPADDING",    (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LINEABOVE",     (0, 0), (-1, 0),  1.5, PALETTE_YELLOW),
    ]))
    return tbl


def crisis_table():
    """Crisis alpha table from Wagyu IR v10.2."""
    hdr_style = ParagraphStyle(
        name="th3", fontName="Helvetica-Bold", fontSize=10, leading=13,
        alignment=TA_LEFT)
    cell_style = ParagraphStyle(
        name="td3", fontName="Helvetica", fontSize=10, leading=13,
        alignment=TA_LEFT)

    data = [
        [Paragraph(c, hdr_style) for c in
         ["Market Event", "Period", "S&amp;P 500", "PNTHR Fund", "PNTHR Alpha"]],
        [Paragraph(c, cell_style) for c in
         ["2025 Liberation Day Correction", "2025-02-19 to 2025-04-08",
          "-19.0%", "-17.1%", "+1.9%"]],
        [Paragraph(c, cell_style) for c in
         ["2024 August Correction", "2024-07-16 to 2024-08-05",
          "-8.4%", "-14.3%", "-5.8%"]],
        [Paragraph(c, cell_style) for c in
         ["2023 Regional Bank Crisis", "2023-02-02 to 2023-03-13",
          "-7.5%", "-9.2%", "-1.7%"]],
        [Paragraph(c, cell_style) for c in
         ["2024 April Pullback", "2024-03-28 to 2024-04-19",
          "-5.3%", "-8.2%", "-2.9%"]],
    ]

    tbl = Table(data, colWidths=[1.8 * inch, 1.5 * inch, 0.9 * inch, 0.9 * inch, 1.0 * inch])
    tbl.setStyle(TableStyle([
        ("BOX",           (0, 0), (-1, -1), 0.5, colors.black),
        ("INNERGRID",     (0, 0), (-1, -1), 0.3, colors.Color(0.85, 0.85, 0.85)),
        ("BACKGROUND",    (0, 0), (-1, 0),  colors.Color(0.12, 0.12, 0.12)),
        ("TEXTCOLOR",     (0, 0), (-1, 0),  PALETTE_WHITE),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 6),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 6),
        ("TOPPADDING",    (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LINEABOVE",     (0, 0), (-1, 0),  1.5, PALETTE_YELLOW),
    ]))
    return tbl


def annual_table():
    """Annual performance from Wagyu IR v10.2 (Wagyu Net basis)."""
    hdr_style = ParagraphStyle(
        name="th4", fontName="Helvetica-Bold", fontSize=10, leading=13,
        alignment=TA_LEFT)
    cell_style = ParagraphStyle(
        name="td4", fontName="Helvetica", fontSize=10, leading=13,
        alignment=TA_LEFT)

    data = [
        [Paragraph(c, hdr_style) for c in
         ["Year", "Start Equity", "End Equity", "S&amp;P 500",
          "PNTHR AI Net", "Alpha"]],
        [Paragraph(c, cell_style) for c in
         ["2022", "$1.00M", "$1.01M", "+1.98%", "+0.73%", "-1.25%"]],
        [Paragraph(c, cell_style) for c in
         ["2023", "$1.01M", "$1.21M", "+24.81%", "+20.27%", "-4.54%"]],
        [Paragraph(c, cell_style) for c in
         ["2024", "$1.17M", "$2.36M", "+24.00%", "+101.17%", "+77.17%"]],
        [Paragraph(c, cell_style) for c in
         ["2025", "$2.47M", "$4.24M", "+16.64%", "+71.72%", "+55.08%"]],
        [Paragraph(c, cell_style) for c in
         ["2026", "$4.46M", "$6.93M", "-4.00%", "+55.34%", "+59.34%"]],
    ]

    tbl = Table(data, colWidths=[0.6 * inch, 1.0 * inch, 1.0 * inch, 1.0 * inch, 1.1 * inch, 1.0 * inch])
    tbl.setStyle(TableStyle([
        ("BOX",           (0, 0), (-1, -1), 0.5, colors.black),
        ("INNERGRID",     (0, 0), (-1, -1), 0.3, colors.Color(0.85, 0.85, 0.85)),
        ("BACKGROUND",    (0, 0), (-1, 0),  colors.Color(0.12, 0.12, 0.12)),
        ("TEXTCOLOR",     (0, 0), (-1, 0),  PALETTE_WHITE),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 6),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 6),
        ("TOPPADDING",    (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LINEABOVE",     (0, 0), (-1, 0),  1.5, PALETTE_YELLOW),
    ]))
    return tbl


# =========================================================================
# BUILD
# =========================================================================
def build():
    story = build_cover_header(
        title_line_1="Performance Summary",
        title_line_2=None,
        subtitle=FUND,
        date_line=f"{VERSION} - {DATE_DISP} - HYPOTHETICAL BACKTEST",
        revision_line=None,
        issuer_line="STT Capital Advisors, LLC",
        confidential_title="CONFIDENTIAL: FOR ACCREDITED INVESTOR / QUALIFIED CLIENT USE ONLY",
        confidential_body=(
            "This document is the property of STT Capital Advisors, LLC "
            "and may not be reproduced or distributed without prior written consent."
        ),
    )

    # ── Important Disclosures ─────────────────────────────────────────────
    story.append(Paragraph("Important Disclosures", H1))
    story.append(spacer(4))

    story.append(P(
        "<b>HYPOTHETICAL PERFORMANCE RESULTS HAVE MANY INHERENT LIMITATIONS.</b> "
        "No representation is being made that any account will or is likely to achieve "
        "profits or losses similar to those shown. In fact, there are frequently sharp "
        "differences between hypothetical performance results and the actual results "
        "subsequently achieved by any particular trading program."
    ))
    story.append(P(
        "One of the limitations of hypothetical performance results is that they are "
        "generally prepared with the benefit of hindsight. In addition, hypothetical "
        "trading does not involve financial risk, and no hypothetical trading record "
        "can completely account for the impact of financial risk in actual trading. "
        "The ability to withstand losses or to adhere to a particular trading program "
        "in spite of trading losses are material points which can adversely affect "
        "actual trading results."
    ))
    story.append(P(
        "This document presents performance on both <b>GROSS</b> and <b>NET</b> bases "
        "across all three investor classes. <b>GROSS</b> figures are post-transaction-costs "
        "(IBKR Pro Fixed commissions at $0.005/share, 5 basis points of slippage per leg, "
        "and sector-tiered short borrow costs of 1.0-2.0% annualized) but <b>before</b> "
        "fund-level fees. <b>NET</b> figures are <b>after</b> both the 2.0% per annum "
        "management fee (accrued monthly on NAV) and the class-tiered performance allocation "
        "(30% / 25% Filet, 25% / 20% Porterhouse, 20% / 15% Wagyu, stepping down to the "
        "loyalty rate after 36 consecutive months of investment) charged quarterly, "
        "non-cumulative, on net profits above a quarterly hurdle equal to the US 2-Year "
        "Treasury yield divided by four, subject to a running High-Water Mark with Loss "
        "Carryforward. Mechanics per PPM sec. 4.1-4.3. Past hypothetical performance is "
        "not indicative of future results."
    ))

    # ── Gross vs Net by Investor Class ────────────────────────────────────
    story.append(Paragraph("Gross vs Net Returns by Investor Class", H1))
    story.append(spacer(4))
    story.append(P(
        "Backtest period: January 2022 through May 2026 (53 months; first trade June 13, 2022). "
        "The three classes below apply their own PPM-specified performance allocation rates. "
        "Higher classes (larger capital commitments) receive materially lower fee burdens, "
        "producing meaningfully higher net returns. This is an intentional incentive for capital scale."
    ))

    # ── FILET ─────────────────────────────────────────────────────────────
    # From IR Filet $100K v10.2 (Multi-strategy + MCE)
    story.append(Paragraph(
        "<b>FILET CLASS ($100,000 - $499,999 : 30% / 25% after 36 months)</b>",
        CLASS_HDR))
    story.append(metrics_table([
        ["Total Return",              "+973.1%",  "+487.8%",  "-485.3 pts"],
        ["CAGR",                      "+72.01%",  "+49.90%",  "-22.11 pts"],
        ["Sharpe Ratio",              "1.82",     "1.33",     "-0.49"],
        ["Sortino Ratio",             "3.09",     "2.19",     "-0.90"],
        ["Calmar Ratio",              "3.27",     "1.81",     "-1.46"],
        ["Max Drawdown (daily NAV)",  "-21.99%",  "-27.57%",  "-5.58 pts"],
        ["Recovery Factor",           "44x",      "18x",      "-26"],
        ["Ending Equity ($100K start)", "$1.07M", "$588K",    "-$485K"],
    ]))
    story.append(spacer(6))

    # ── PORTERHOUSE ───────────────────────────────────────────────────────
    # From IR Porterhouse $500K v10.2 (Multi-strategy + MCE)
    story.append(Paragraph(
        "<b>PORTERHOUSE CLASS ($500,000 - $999,999 : 25% / 20% after 36 months)</b>",
        CLASS_HDR))
    story.append(metrics_table([
        ["Total Return",              "+891.1%",  "+506.3%",  "-384.8 pts"],
        ["CAGR",                      "+68.92%",  "+50.97%",  "-17.95 pts"],
        ["Sharpe Ratio",              "1.76",     "1.37",     "-0.39"],
        ["Sortino Ratio",             "3.00",     "2.30",     "-0.70"],
        ["Calmar Ratio",              "2.91",     "1.94",     "-0.97"],
        ["Max Drawdown (daily NAV)",  "-23.70%",  "-26.23%",  "-2.53 pts"],
        ["Recovery Factor",           "38x",      "19x",      "-19"],
        ["Ending Equity ($500K start)", "$4.96M", "$3.03M",   "-$1.92M"],
    ]))
    story.append(spacer(6))

    # ── WAGYU ─────────────────────────────────────────────────────────────
    # From IR Wagyu $1M v10.2 (Multi-strategy + MCE)
    story.append(Paragraph(
        "<b>WAGYU CLASS ($1,000,000+ : 20% / 15% after 36 months)</b>",
        CLASS_HDR))
    story.append(metrics_table([
        ["Total Return",              "+932.6%",  "+592.9%",  "-339.7 pts"],
        ["CAGR",                      "+70.51%",  "+55.65%",  "-14.86 pts"],
        ["Sharpe Ratio",              "1.79",     "1.47",     "-0.32"],
        ["Sortino Ratio",             "3.07",     "2.49",     "-0.58"],
        ["Calmar Ratio",              "3.01",     "2.18",     "-0.83"],
        ["Max Drawdown (daily NAV)",  "-23.45%",  "-25.56%",  "-2.11 pts"],
        ["Recovery Factor",           "40x",      "23x",      "-17"],
        ["Ending Equity ($1M start)", "$10.33M",  "$6.93M",   "-$3.40M"],
    ]))

    # ── Strategy Activity by Direction ────────────────────────────────────
    story.append(PageBreak())
    story.append(Paragraph("Strategy Activity by Direction (Wagyu $1M)", H1))
    story.append(spacer(4))
    story.append(P(
        "Trade-level attribution metrics at the Wagyu $1M tier. Profit Factor "
        "and Win Rate are signed at the individual trade level and are invariant "
        "to mark-to-market resolution. Portfolio-level CAGR, Sharpe, and Sortino "
        "for the fully combined strategy are reported on a mark-to-market basis "
        "in the Gross vs Net tables above."
    ))
    story.append(direction_table())
    story.append(spacer(4))
    story.append(P(
        "Backtest period: January 2022 through May 2026 (53 months; first trade June 13, 2022). "
        "1,505 closed trades across the PNTHR AI Universe (~300 names).",
        SMALL))

    # ── Crisis Alpha ──────────────────────────────────────────────────────
    story.append(Paragraph(
        "Crisis Alpha: Performance During Market Drawdowns", H1))
    story.append(spacer(4))
    story.append(P(
        "During market corrections, the AI Elite Fund preserved and grew capital "
        "through systematic short-side exposure and disciplined risk management. "
        "Values shown on a Gross Fund NAV basis during the periods listed "
        "(drawdown behavior is primarily a gross-level phenomenon; full-period "
        "fee drag is disclosed in the Gross vs Net tables above)."
    ))
    story.append(crisis_table())

    # ── Annual Performance ────────────────────────────────────────────────
    story.append(Paragraph("Annual Performance: PNTHR AI Elite vs S&amp;P 500", H1))
    story.append(spacer(4))
    story.append(P(
        "Annual breakdown shown on the <b>Wagyu Class Net</b> basis "
        "(20% / 15% performance allocation). Filet and Porterhouse classes "
        "achieve lower net returns per the Gross vs Net tables above."
    ))
    story.append(annual_table())

    # ── Key Takeaway ──────────────────────────────────────────────────────
    story.append(Paragraph("Key Takeaway", H1))
    story.append(spacer(4))
    story.append(P(
        "Over the 4.4-year backtest the AI Elite Fund's Multi-strategy + MCE approach "
        "delivered a +55.65% net CAGR at the Wagyu tier, transforming $1,000,000 into "
        "$6.93M while the S&amp;P 500 returned +74.9% (+15.83% CAGR) over the same period. "
        "The fund's maximum drawdown of -25.56% on a net basis is modestly deeper than "
        "the S&amp;P 500's -19.00%, while delivering 3.5x higher annualized returns. The "
        "1% vitality cap and 35% initial lot sizing ensure that no single adverse trade "
        "can materially impair investor capital."
    ))

    # ── Anticipated Investor Questions ────────────────────────────────────
    story.append(PageBreak())
    story.append(Paragraph("Anticipated Investor Questions", H1))
    story.append(spacer(4))

    story.append(Paragraph("Are these live returns or hypothetical?", FAQ_Q))
    story.append(P(
        "Entirely <b>hypothetical backtest results</b>. The Fund has not yet traded "
        "non-affiliated Limited Partner capital. The Strategy became operational for "
        "live trading on May 11, 2026."
    ))

    story.append(Paragraph(
        "What realistic live performance should I expect?", FAQ_Q))
    story.append(P(
        "Systematic strategies typically deliver a portion of backtested results in "
        "live trading due to execution slippage, strategy decay, and capacity effects. "
        "A reasonable expectation is live Net CAGR at roughly half to two-thirds of the "
        "backtest headline, with live Max Drawdown 2-to-4 times larger than backtested. "
        "No specific live outcome is guaranteed."
    ))

    story.append(Paragraph(
        "How do these numbers compare to industry benchmarks?", FAQ_Q))
    story.append(P(
        "Long-run industry benchmarks for long/short equity strategies — including the "
        "HFRI Equity Hedge Index and the Barclay Long/Short Equity Index — have "
        "historically produced Net CAGRs in the high single-digit range with Sharpe "
        "ratios under 1.0 over multi-decade observation periods. Backtested Net metrics "
        "for this Strategy materially exceed these benchmarks; investors should apply "
        "appropriate skepticism pending the establishment of a verified live track record. "
        "The HFRI and Barclay indices are unmanaged, are not investable directly, and "
        "have strategy and risk profiles that may differ materially from the Fund."
    ))

    story.append(Paragraph(
        "Was the strategy validated out-of-sample?", FAQ_Q))
    story.append(P(
        "Per-sector trend-filter periods are empirically calibrated across the "
        "January 2022 through May 2026 backtest window (first trade June 13, 2022). The calibration is supported "
        "by robustness checks: (i) no sector period was selected that caused regression "
        "versus the baseline trend reference within any individual calendar year; "
        "(ii) no individual sector regressed under its selected period on a full-pipeline "
        "basis; and (iii) a split-sample comparison shows consistent improvement in both "
        "sub-periods."
    ))
    story.append(P(
        "<b>Important limitation.</b> Parameters were selected with visibility to the "
        "full calibration window. Investors should interpret split-sample figures as "
        "robustness indicators, not as independent out-of-sample validation.",
    ))

    story.append(Paragraph(
        "Has the backtest been independently audited?", FAQ_Q))
    story.append(P(
        "Internally validated for gate compliance and data integrity; <b>not</b> "
        "independently audited by a third-party firm. The Fund intends to engage "
        "Spicer Jeffries LLP as auditor upon admission of Limited Partners; "
        "first-year live financial statements will be audited."
    ))

    # ── Methodology and Data Provenance ───────────────────────────────────
    story.append(PageBreak())
    story.append(Paragraph("Methodology and Data Provenance", H1))
    story.append(spacer(4))

    story.append(P(
        "Complete backtest methodology, monthly return heatmaps, per-class annual "
        "returns, drawdown analysis, and daily NAV logs are consolidated in the "
        "PNTHR AI Elite Fund Intelligence Report. Backtest dataset: per-tier pyramid "
        "trade logs and mark-to-market daily NAV curves as of May 20, 2026 "
        "(1,505 closed trades). Gate compliance verified: PAI300 proprietary AI index "
        "regime gate (36W EMA); AI sub-sector rotation ranking; sector-specific "
        "trend-filter periods (specific periods proprietary). Costs modeled at trade "
        "level (IBKR Pro Fixed $0.005/share, 5 basis points slippage per leg, "
        "sector-tiered 1.0 to 2.0% short borrow annualized). Fund-level fees applied "
        "per PPM Sections 4.1-4.3 (2% per annum management fee accrued monthly; "
        "tier-specific performance allocation 20%/25%/30% stepping to 15%/20%/25% "
        "after 36 continuous months, calculated quarterly and non-cumulative against "
        "US 2-Year Treasury hurdle; running High Water Mark; Loss Recovery Account "
        "per PPM Section 8.01(e))."
    ))
    story.append(P(
        "<b>Performance metric conventions.</b> Sharpe Ratio is computed from daily "
        "NAV returns using excess return over the US 3-month Treasury Bill, annualized "
        "by the square root of 252 trading days. Sortino Ratio is computed from daily "
        "NAV returns using Minimum Acceptable Return of zero, annualized by the square "
        "root of 252. Maximum Drawdown is peak-to-trough percentage decline measured on "
        "daily mark-to-market NAV. Profit Factor and Win Rate are signed at the "
        "individual trade level."
    ))
    story.append(P(
        "<b>Survivorship Bias Disclosure.</b> The backtest universe consists of "
        "approximately 300 AI-focused U.S. listed equities comprising the PNTHR AI "
        "Universe across 16 proprietary AI sub-sectors. Historical price data is sourced "
        "from Financial Modeling Prep. Tickers that were delisted, acquired, merged, or "
        "otherwise removed prior to May 2026 are not represented in the backtest, as "
        "historical price data for such tickers is not available in the current data source."
    ))

    # ── Final Disclosures ─────────────────────────────────────────────────
    story.append(Paragraph("Important Disclosures", H1))
    story.append(spacer(4))
    story.append(P(
        "<b>HYPOTHETICAL PERFORMANCE RESULTS HAVE MANY INHERENT LIMITATIONS. NO "
        "REPRESENTATION IS BEING MADE THAT ANY ACCOUNT WILL OR IS LIKELY TO ACHIEVE "
        "PROFITS OR LOSSES SIMILAR TO THOSE SHOWN.</b> Hypothetical results are prepared "
        "with hindsight, do not involve financial risk, and cannot fully account for "
        "market impact or the psychological pressure of actual trading. This document "
        "contains hypothetical performance as defined in Rule 206(4)-1 under the "
        "Investment Advisers Act (the SEC Marketing Rule)."
    ))
    story.append(P(
        "The Fund is offered in reliance on Rule 506(c) of Regulation D to investors "
        "verified as both Accredited Investors under Rule 501(a) and Qualified Clients "
        "under Rule 205-3 of the Investment Advisers Act of 1940. The Fund relies on "
        "Section 3(c)(1) of the Investment Company Act and is NOT relying on Section "
        "3(c)(7). The Fund is limited to 100 beneficial owners. The backtest has not "
        "been independently audited. This document is not an offer; any offer is made "
        "solely by the Private Placement Memorandum and Limited Partnership Agreement. "
        "In the event of conflict, the PPM and LPA govern. Past hypothetical performance "
        "is not indicative of future results. Investors may lose some or all of their "
        "capital."
    ))

    # ── Build ─────────────────────────────────────────────────────────────
    doc = make_doc_template(
        OUT_PATH,
        title_meta=f"{FUND} - Performance Summary {VERSION}",
        subject="Performance Summary",
    )
    on_cover, on_page = make_page_handlers(
        doc_short_title="Performance Summary",
        doc_date_display=DATE_DISP,
        fund_name="PNTHR AI Elite 300 Fund",
        fund_name_upper=FUND_UPPER,
    )
    doc.build(story, onFirstPage=on_cover, onLaterPages=on_page)
    sz = os.path.getsize(OUT_PATH)
    print(f"PDF generated: {OUT_PATH}")
    print(f"Size: {sz:,} bytes")


if __name__ == "__main__":
    build()
