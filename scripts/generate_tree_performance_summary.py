#!/usr/bin/env python3
"""
PNTHR Tree Fund, LP — Performance Summary v2.2
All metrics reconciled to the PNTHR Tree Fund Intelligence Report (genTreeIrData.js ->
server/data/treeIr/{100k,500k,1m}.json; long-only 42wk-high momentum), built on the
same locked treeSim engine as the live dashboard baseline (frozen 2026-06-11). Per-tier
GROSS/NET via irLiveService.computeSide; long-trade stats, annual table (Wagyu net,
chained year-end) and SPY from the same source. Reproduce the numbers with
server/_tree_perfsummary_numbers.mjs. v2.2 (2026-06-23): regenerated after the baseline
drift fix (PSTG/PRO/BITF delisting + split re-syncs) corrected the Tree return.

Output: ~/Downloads/PNTHR_Tree_Fund_Performance_Summary_v2.3_2026.pdf
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
from tree_perf_data import T, SPY, ANNUAL  # numbers from the locked engine (no hardcoding)

FUND       = "PNTHR Tree Fund, LP"
FUND_UPPER = "PNTHR TREE FUND"
VERSION    = "v2.3"
DATE_DISP  = "June 2026"

OUT_PATH = os.path.expanduser(
    f"~/Downloads/PNTHR_Tree_Fund_Performance_Summary_{VERSION}_2026.pdf")

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
        alignment=TA_LEFT, textColor=PALETTE_WHITE)
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


def class_rows(tier):
    """4-col Metric / Gross / Net / Fee Drag rows for one fee class (from the engine JSON)."""
    g, n, d = tier["gross"], tier["net"], tier["drag"]
    return [
        ["Total Return",                              g["total"],    n["total"],    d["total"]],
        ["CAGR",                                      g["cagr"],     n["cagr"],     d["cagr"]],
        ["Sharpe Ratio",                              g["sharpe"],   n["sharpe"],   d["sharpe"]],
        ["Sortino Ratio",                             g["sortino"],  n["sortino"],  d["sortino"]],
        ["Calmar Ratio",                              g["calmar"],   n["calmar"],   d["calmar"]],
        ["Max Drawdown (daily NAV)",                  g["maxDD"],    n["maxDD"],    d["maxDD"]],
        ["Recovery Factor",                           g["recovery"], n["recovery"], d["recovery"]],
        [f"Ending Equity ({tier['seedDisp']} start)", g["end"],      n["end"],      d["end"]],
    ]


def direction_table():
    """Per-tier long-only trade activity (from PNTHR Tree IR treeIr/{tier}.json)."""
    hdr_style = ParagraphStyle(
        name="th2", fontName="Helvetica-Bold", fontSize=10, leading=13,
        alignment=TA_LEFT, textColor=PALETTE_WHITE)
    cell_style = ParagraphStyle(
        name="td2", fontName="Helvetica", fontSize=10, leading=13,
        alignment=TA_LEFT)

    tr = (T["filet"]["trades"], T["porterhouse"]["trades"], T["wagyu"]["trades"])
    data = [
        [Paragraph(c, hdr_style) for c in
         ["Metric (Long-Only)", "Filet $100K", "Porterhouse $500K", "Wagyu $1M"]],
        [Paragraph(c, cell_style) for c in
         ["Profit Factor", tr[0]["pf"], tr[1]["pf"], tr[2]["pf"]]],
        [Paragraph(c, cell_style) for c in
         ["Win Rate", tr[0]["winRate"], tr[1]["winRate"], tr[2]["winRate"]]],
        [Paragraph(c, cell_style) for c in
         ["Total Trades", tr[0]["count"], tr[1]["count"], tr[2]["count"]]],
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


def annual_table():
    """Annual performance, Wagyu Net basis, chained year-end (from PNTHR Tree IR)."""
    hdr_style = ParagraphStyle(
        name="th4", fontName="Helvetica-Bold", fontSize=10, leading=13,
        alignment=TA_LEFT, textColor=PALETTE_WHITE)
    cell_style = ParagraphStyle(
        name="td4", fontName="Helvetica", fontSize=10, leading=13,
        alignment=TA_LEFT)

    data = [
        [Paragraph(c, hdr_style) for c in
         ["Year", "Start Equity", "End Equity", "S&amp;P 500",
          "PNTHR Tree Net", "Alpha"]],
    ] + [
        [Paragraph(c, cell_style) for c in
         [a["year"], a["start"], a["end"], a["spy"], a["tree"], a["alpha"]]]
        for a in ANNUAL
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
        "Backtest period: January 2023 through June 2026 (~3.45 years; first trade January 3, 2023). "
        "The three classes below apply their own PPM-specified performance allocation rates. "
        "Higher classes (larger capital commitments) receive materially lower fee burdens, "
        "producing meaningfully higher net returns. This is an intentional incentive for capital scale."
    ))

    # ── FILET ─────────────────────────────────────────────────────────────
    # From PNTHR Tree IR (genTreeIrData.js -> treeIr/100k.json, 42wk baseline frozen
    # 2026-06-11); metrics via irLiveService.computeSide (see _tree_perfsummary_numbers.mjs).
    story.append(Paragraph(
        "<b>FILET CLASS ($100,000 - $499,999 : 30% / 25% after 36 months)</b>",
        CLASS_HDR))
    story.append(metrics_table(class_rows(T["filet"])))
    story.append(spacer(6))

    # ── PORTERHOUSE ───────────────────────────────────────────────────────
    # From PNTHR Tree IR (treeIr/500k.json, 42wk baseline)
    story.append(Paragraph(
        "<b>PORTERHOUSE CLASS ($500,000 - $999,999 : 25% / 20% after 36 months)</b>",
        CLASS_HDR))
    story.append(metrics_table(class_rows(T["porterhouse"])))
    story.append(spacer(6))

    # ── WAGYU ─────────────────────────────────────────────────────────────
    # From PNTHR Tree IR (treeIr/1m.json, 42wk baseline)
    story.append(Paragraph(
        "<b>WAGYU CLASS ($1,000,000+ : 20% / 15% after 36 months)</b>",
        CLASS_HDR))
    story.append(metrics_table(class_rows(T["wagyu"])))

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
        f"Backtest period: January 2023 through June 2026 (frozen at go-live; ~3.45 years). "
        f"{T['filet']['trades']['count']} to {T['wagyu']['trades']['count']} long trades by tier across the PNTHR AI 300 Universe (~300 names).",
        SMALL))

    # ── Annual Performance ────────────────────────────────────────────────
    story.append(Paragraph("Annual Performance: PNTHR Tree vs S&amp;P 500", H1))
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
        f"Over the ~3.45-year backtest the Tree Fund's long-only 42-week-high momentum "
        f"approach delivered a {T['wagyu']['net']['cagr']} net CAGR at the Wagyu tier (transforming $1,000,000 "
        f"into {T['wagyu']['net']['end']}) and a {T['filet']['net']['cagr']} net CAGR at the Filet tier, while the S&amp;P 500 "
        f"returned {SPY['cagr']} CAGR over the same period. These returns are accompanied by large "
        f"drawdowns: the net maximum drawdown reached {T['filet']['net']['maxDD']} on a "
        f"daily mark-to-market basis, materially deeper than the S&amp;P 500's {SPY['maxDD']}. This "
        "is a high-volatility momentum strategy; per-trade risk is capped at 2% of NAV and "
        "single-name exposure at 10%, but the Fund's overall drawdown is not capped and can "
        "be substantial."
    ))

    # ── Anticipated Investor Questions ────────────────────────────────────
    story.append(PageBreak())
    story.append(Paragraph("Anticipated Investor Questions", H1))
    story.append(spacer(4))

    story.append(Paragraph("Are these live returns or hypothetical?", FAQ_Q))
    story.append(P(
        "Entirely <b>hypothetical backtest results</b>. The Fund has not yet traded "
        "non-affiliated Limited Partner capital. The Strategy became operational for "
        "live trading on June 12, 2026."
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
        "The Strategy applies a single, uniform breakout rule (a new 42-week high) and one "
        "trailing-stop discipline to every name - there are no per-name or per-sector "
        "parameters to fit, which limits curve-fitting risk. The 42-week lookback was "
        "selected on the AI-300 window and also held up out-of-sample on a broader 679-name "
        "universe and across the 2020-2022 (COVID and bear-market) regime as a stable "
        "plateau rather than a curve-fit spike."
    ))
    story.append(P(
        "<b>Important limitation.</b> The backtest uses the current AI-300 index members "
        "(survivorship-flattered) and is frozen at go-live. Investors should treat all "
        "figures as hypothetical and not as a verified live track record.",
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
        "PNTHR Tree Fund Intelligence Report. Backtest dataset: per-tier trade logs and "
        "mark-to-market daily NAV curves, frozen at go-live (June 11, 2026). Universe: "
        "current PNTHR AI 300 index members only (survivorship-flattered). The Strategy "
        "applies no regime gate, sector rotation, or multi-factor scoring; entries are "
        "single-name 42-week-high breakouts. Costs modeled at trade level (IBKR Pro Fixed "
        "$0.005/share, 5 basis points slippage per leg). Fund-level fees applied "
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
        fund_name="PNTHR Tree Fund",
        fund_name_upper=FUND_UPPER,
    )
    doc.build(story, onFirstPage=on_cover, onLaterPages=on_page)
    sz = os.path.getsize(OUT_PATH)
    print(f"PDF generated: {OUT_PATH}")
    print(f"Size: {sz:,} bytes")


if __name__ == "__main__":
    build()
