#!/usr/bin/env python3
"""
PNTHR Dual-Fund — Complete Ticker Assignment PDF
Generates ~/Downloads/PNTHR_Overlap_Ticker_Assignment.pdf

Usage:
    cd <repo-root>
    python3 server/backtest/generateOverlapAssignment.py
"""

import csv
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak,
    KeepTogether,
)

# ── Paths ────────────────────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).resolve().parents[2]
CSV_PATH = Path.home() / "Downloads" / "PNTHR_Overlap_Comparison.csv"
AI_JSON = Path("/tmp/ai300_tickers.json")
C679_JSON = Path("/tmp/c679_tickers.json")
AI_BT_JSON = Path("/tmp/ai300_bt_agg.json")
C679_BT_JSON = Path("/tmp/c679_bt_agg.json")
OUTPUT_PDF = Path.home() / "Downloads" / "PNTHR_Overlap_Ticker_Assignment_v2.0_2026.pdf"

# ── Colours ──────────────────────────────────────────────────────────────────
PNTHR_YELLOW = colors.HexColor("#fcf000")
HDR_BG = colors.HexColor("#1a1a1a")
AI_GREEN = colors.HexColor("#e6ffe6")
C679_BLUE = colors.HexColor("#e6f0ff")
OVERLAP_GOLD = colors.HexColor("#fff8e0")
GRID_GREY = colors.HexColor("#cccccc")
WHITE = colors.white
BLACK = colors.black


# ═══════════════════════════════════════════════════════════════════════════════
# Step 1: Export universe data via Node.js
# ═══════════════════════════════════════════════════════════════════════════════

def _run_node(script: str, label: str, timeout: int = 60, cwd=None):
    """Run a Node.js one-liner from the repo root (or specified dir)."""
    result = subprocess.run(
        ["node", "-e", script],
        cwd=str(cwd or REPO_ROOT),
        capture_output=True, text=True, timeout=timeout,
    )
    if result.returncode != 0:
        print(f"[ERROR] {label} failed:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)
    print(f"  {label}: {result.stdout.strip()}")


def export_universes():
    """Write AI 300 and 679 ticker data to /tmp JSON files."""
    print("Exporting universe data …")

    _run_node("""
const d = require('./server/scripts/aiUniverse/aiUniverseData.js');
const ai = [];
for (const s of d.SECTORS)
  for (const h of s.holdings)
    ai.push({ ticker: h.ticker, name: h.name, sector: s.name });
require('fs').writeFileSync('/tmp/ai300_tickers.json', JSON.stringify(ai));
console.log('AI 300 tickers: ' + ai.length);
""", "AI 300")

    _run_node("""
require('dotenv').config({ path: '.env' });
const { MongoClient } = require('mongodb');
(async () => {
  const c = new MongoClient(process.env.MONGODB_URI);
  await c.connect();
  const db = c.db('pnthr_den');
  const docs = await db.collection('pnthr_bt_scores').aggregate([
    { $group: { _id: '$ticker', name: { $first: '$companyName' }, sector: { $first: '$sector' } } },
    { $sort: { _id: 1 } }
  ]).toArray();
  const result = docs.map(d => ({ ticker: d._id, name: d.name || '', sector: d.sector || '' }));
  require('fs').writeFileSync('/tmp/c679_tickers.json', JSON.stringify(result));
  console.log('679 tickers: ' + result.length);
  await c.close();
})();
""", "679 Carnivore", cwd=REPO_ROOT / "server")


def export_backtest_aggregates():
    """Aggregate per-ticker P&L, trades, win rate from trade log collections."""
    print("Exporting backtest aggregates …")

    agg_script = """
    const agg = [
      { $group: {
        _id: '$ticker',
        grossPnl: { $sum: '$grossDollarPnl' },
        trades:   { $sum: 1 },
        wins:     { $sum: { $cond: ['$isWinner', 1, 0] } }
      }},
      { $sort: { _id: 1 } }
    ];
    """

    _run_node(f"""
require('dotenv').config({{ path: '.env' }});
const {{ MongoClient }} = require('mongodb');
(async () => {{
  const c = new MongoClient(process.env.MONGODB_URI);
  await c.connect();
  const db = c.db('pnthr_den');
  {agg_script}
  const docs = await db.collection('pnthr_ai_bt_pyramid_nav_1m_trade_log').aggregate(agg).toArray();
  const result = {{}};
  for (const d of docs) result[d._id] = {{ pnl: Math.round(d.grossPnl), trades: d.trades, wr: d.trades ? +(d.wins/d.trades*100).toFixed(1) : 0 }};
  require('fs').writeFileSync('/tmp/ai300_bt_agg.json', JSON.stringify(result));
  console.log('AI 300 backtest tickers: ' + Object.keys(result).length);
  await c.close();
}})();
""", "AI 300 backtest", timeout=120, cwd=REPO_ROOT / "server")

    _run_node(f"""
require('dotenv').config({{ path: '.env' }});
const {{ MongoClient }} = require('mongodb');
(async () => {{
  const c = new MongoClient(process.env.MONGODB_URI);
  await c.connect();
  const db = c.db('pnthr_den');
  {agg_script}
  const docs = await db.collection('pnthr_bt_pyramid_nav_1m_trade_log').aggregate(agg).toArray();
  const result = {{}};
  for (const d of docs) result[d._id] = {{ pnl: Math.round(d.grossPnl), trades: d.trades, wr: d.trades ? +(d.wins/d.trades*100).toFixed(1) : 0 }};
  require('fs').writeFileSync('/tmp/c679_bt_agg.json', JSON.stringify(result));
  console.log('679 backtest tickers: ' + Object.keys(result).length);
  await c.close();
}})();
""", "679 backtest", timeout=120, cwd=REPO_ROOT / "server")


# ═══════════════════════════════════════════════════════════════════════════════
# Step 2: Load and merge data
# ═══════════════════════════════════════════════════════════════════════════════

def _parse_money(s: str) -> int:
    """'+9524' / '-2396' / '$+2696884' → int"""
    s = s.replace("$", "").replace(",", "").replace(" ", "").strip()
    if not s or s == "0":
        return 0
    return int(s)


def _parse_pct(s: str) -> float:
    s = s.replace("%", "").strip()
    return float(s) if s else 0.0


def load_csv():
    """Return list of overlap dicts from the CSV, skipping the TOTAL row."""
    rows = []
    with open(CSV_PATH, newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            ticker = r["Ticker"].strip()
            if ticker.upper() == "TOTAL":
                continue
            rows.append({
                "ticker": ticker,
                "ai_pnl": _parse_money(r["AI 300 P&L"]),
                "ai_ret": _parse_pct(r["AI 300 Return %"]),
                "ai_trades": int(r["AI 300 Trades"]),
                "ai_wr": _parse_pct(r["AI 300 Win Rate %"]),
                "c679_pnl": _parse_money(r["679 P&L"]),
                "c679_ret": _parse_pct(r["679 Return %"]),
                "c679_trades": int(r["679 Trades"]),
                "c679_wr": _parse_pct(r["679 Win Rate %"]),
                "winner": r["WINNER"].strip(),
                "edge": _parse_money(r["Edge $"]),
                "action": r["Action"].strip(),
            })
    return rows


def load_universes():
    """Load AI 300 and 679 universe JSON files + backtest aggregates."""
    with open(AI_JSON) as f:
        ai_list = json.load(f)
    with open(C679_JSON) as f:
        c679_list = json.load(f)
    ai_map = {t["ticker"]: t for t in ai_list}
    c679_map = {t["ticker"]: t for t in c679_list}

    with open(AI_BT_JSON) as f:
        ai_bt = json.load(f)       # { ticker: { pnl, trades, wr } }
    with open(C679_BT_JSON) as f:
        c679_bt = json.load(f)

    return ai_map, c679_map, ai_bt, c679_bt


def build_master(overlap_rows, ai_map, c679_map, ai_bt, c679_bt):
    """
    Build the complete master ticker list with assignments.
    Returns (master_list, stats_dict).
    """
    overlap_tickers = {r["ticker"] for r in overlap_rows}
    overlap_assignment = {}  # ticker → "AI" or "679"
    for r in overlap_rows:
        overlap_assignment[r["ticker"]] = r["winner"]

    master = []
    seen = set()

    # 1. Overlap tickers
    for r in overlap_rows:
        t = r["ticker"]
        seen.add(t)
        assigned = r["winner"]  # "AI" or "679"
        name = ai_map.get(t, {}).get("name", "") or c679_map.get(t, {}).get("name", "")
        sector = ai_map.get(t, {}).get("sector", "") or c679_map.get(t, {}).get("sector", "")
        # Use the winning system's numbers
        if assigned == "AI":
            pnl, trades, wr = r["ai_pnl"], r["ai_trades"], r["ai_wr"]
        else:
            pnl, trades, wr = r["c679_pnl"], r["c679_trades"], r["c679_wr"]
        master.append({
            "ticker": t, "name": name, "sector": sector,
            "fund": "AI 300" if assigned == "AI" else "679",
            "source": f"OV→AI 300" if assigned == "AI" else "OV→679",
            "pnl": pnl, "trades": trades, "wr": wr,
            "is_overlap": True,
        })

    # 2. AI 300 exclusive — pull backtest data from trade log aggregates
    for t, info in ai_map.items():
        if t in seen:
            continue
        seen.add(t)
        bt = ai_bt.get(t, {})
        master.append({
            "ticker": t, "name": info["name"], "sector": info["sector"],
            "fund": "AI 300", "source": "AI 300 ONLY",
            "pnl": bt.get("pnl", 0), "trades": bt.get("trades", 0), "wr": bt.get("wr", 0),
            "is_overlap": False,
        })

    # 3. 679 exclusive — pull backtest data from trade log aggregates
    for t, info in c679_map.items():
        if t in seen:
            continue
        seen.add(t)
        bt = c679_bt.get(t, {})
        master.append({
            "ticker": t, "name": info["name"], "sector": info["sector"],
            "fund": "679", "source": "679 ONLY",
            "pnl": bt.get("pnl", 0), "trades": bt.get("trades", 0), "wr": bt.get("wr", 0),
            "is_overlap": False,
        })

    master.sort(key=lambda x: x["ticker"])

    # Stats
    ai_exclusive = sum(1 for m in master if m["source"] == "AI 300 ONLY")
    c679_exclusive = sum(1 for m in master if m["source"] == "679 ONLY")
    ov_to_ai = sum(1 for m in master if m["source"] == "OV→AI 300")
    ov_to_679 = sum(1 for m in master if m["source"] == "OV→679")
    ai_total = ai_exclusive + ov_to_ai
    c679_total = c679_exclusive + ov_to_679

    # Aggregate P&L for overlap tickers only
    overlap_ai_pnl = sum(r["ai_pnl"] for r in overlap_rows)
    overlap_679_pnl = sum(r["c679_pnl"] for r in overlap_rows)

    stats = {
        "total_unique": len(master),
        "overlap_count": len(overlap_rows),
        "ai_exclusive": ai_exclusive,
        "c679_exclusive": c679_exclusive,
        "ov_to_ai": ov_to_ai,
        "ov_to_679": ov_to_679,
        "ai_total": ai_total,
        "c679_total": c679_total,
        "overlap_ai_pnl": overlap_ai_pnl,
        "overlap_679_pnl": overlap_679_pnl,
    }
    return master, stats


# ═══════════════════════════════════════════════════════════════════════════════
# Step 3: PDF generation
# ═══════════════════════════════════════════════════════════════════════════════

def _fmt_money(v: int) -> str:
    """Format integer as $+12,345 / $-2,396"""
    sign = "+" if v >= 0 else ""
    return f"${sign}{v:,}"


def _fmt_pct(v: float) -> str:
    return f"{v:.1f}%"


def _base_table_style():
    """Shared grid + font defaults."""
    return [
        ("GRID", (0, 0), (-1, -1), 0.3, GRID_GREY),
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
    ]


def _header_style(ncols):
    """Dark header row with readable sizing."""
    return [
        ("BACKGROUND", (0, 0), (ncols - 1, 0), HDR_BG),
        ("TEXTCOLOR", (0, 0), (ncols - 1, 0), PNTHR_YELLOW),
        ("FONTNAME", (0, 0), (ncols - 1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (ncols - 1, 0), 8),
        ("TOPPADDING", (0, 0), (ncols - 1, 0), 5),
        ("BOTTOMPADDING", (0, 0), (ncols - 1, 0), 5),
        ("VALIGN", (0, 0), (ncols - 1, 0), "MIDDLE"),
        ("ALIGN", (0, 0), (ncols - 1, 0), "CENTER"),
    ]


def _section_title(text, styles):
    return Paragraph(text, styles["SectionTitle"])


def _hdr(labels, style):
    """Convert a list of header strings into centered Paragraph objects.
    Use <br/> for line breaks instead of \\n."""
    return [Paragraph(l.replace("&", "&amp;").replace("\n", "<br/>"), style) for l in labels]


def _yellow_rule():
    """A thin yellow horizontal rule via a 1-row table."""
    t = Table([[""]],
              colWidths=[7.1 * inch], rowHeights=[2])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), PNTHR_YELLOW),
        ("LINEBELOW", (0, 0), (0, 0), 0, WHITE),
    ]))
    return t


# ── Page 1: Title + Executive Summary ────────────────────────────────────────

def _build_page1(elements, overlap_rows, master, stats, styles):
    today = datetime.now().strftime("%B %d, %Y")

    # Title
    elements.append(Paragraph(
        "PNTHR Dual-Fund — Complete Ticker Assignment",
        styles["Title"],
    ))
    elements.append(Spacer(1, 4))
    elements.append(Paragraph(
        f"Generated {today} — {stats['total_unique']} unique tickers across AI 300 + 679 universes",
        styles["Subtitle"],
    ))
    elements.append(Spacer(1, 6))
    elements.append(_yellow_rule())
    elements.append(Spacer(1, 12))

    # Executive Summary
    elements.append(Paragraph("Executive Summary", styles["SectionTitle"]))
    elements.append(Spacer(1, 6))
    exec_text = (
        f"PNTHR operates two independent strategy universes: the <b>AI 300</b> ({len([m for m in master if m['fund']=='AI 300'])} tickers) "
        f"and <b>679 Carnivore</b> ({len([m for m in master if m['fund']=='679'])} tickers). "
        f"Of these, <b>{stats['overlap_count']}</b> tickers appear in both universes. "
        f"A head-to-head backtest (Nov 2022 — May 2026, 3.44 years) was run on each overlap ticker under both systems. "
        f"Each ticker was assigned to whichever system produced superior gross P&amp;L. "
        f"The result: <b>{stats['ov_to_ai']} overlap tickers</b> assigned to AI 300 and "
        f"<b>{stats['ov_to_679']}</b> to 679 Carnivore."
    )
    elements.append(Paragraph(exec_text, styles["Body"]))
    elements.append(Spacer(1, 12))

    # Summary table
    sum_data = [
        ["", "AI 300", "679 Carnivore"],
        ["Exclusive tickers", str(stats["ai_exclusive"]), str(stats["c679_exclusive"])],
        ["Won from overlap", str(stats["ov_to_ai"]), str(stats["ov_to_679"])],
        ["TOTAL", str(stats["ai_total"]), str(stats["c679_total"])],
    ]
    sum_table = Table(sum_data, colWidths=[2.0 * inch, 1.5 * inch, 1.5 * inch])
    sum_style = _base_table_style() + _header_style(3) + [
        ("BACKGROUND", (0, 3), (-1, 3), colors.HexColor("#f0f0f0")),
        ("FONTNAME", (0, 3), (-1, 3), "Helvetica-Bold"),
        ("ALIGN", (1, 0), (-1, -1), "CENTER"),
    ]
    sum_table.setStyle(TableStyle(sum_style))
    elements.append(sum_table)
    elements.append(Spacer(1, 8))

    # Aggregate P&L
    elements.append(Paragraph(
        f"Overlap aggregate P&amp;L — AI 300: <b>{_fmt_money(stats['overlap_ai_pnl'])}</b> | "
        f"679: <b>{_fmt_money(stats['overlap_679_pnl'])}</b> | "
        f"Delta: <b>{_fmt_money(stats['overlap_ai_pnl'] - stats['overlap_679_pnl'])}</b>",
        styles["Body"],
    ))
    elements.append(Spacer(1, 16))

    # Document Key
    elements.append(Paragraph("Document Key", styles["SectionTitle"]))
    elements.append(Spacer(1, 6))

    # Color legend
    legend_data = [
        ["Color", "Meaning"],
        ["Green", "Assigned to AI 300"],
        ["Blue", "Assigned to 679 Carnivore"],
        ["Gold", "Overlap ticker (appears in both universes)"],
    ]
    legend_table = Table(legend_data, colWidths=[1.2 * inch, 4.0 * inch])
    legend_style = _base_table_style() + _header_style(2) + [
        ("BACKGROUND", (0, 1), (0, 1), AI_GREEN),
        ("BACKGROUND", (0, 2), (0, 2), C679_BLUE),
        ("BACKGROUND", (0, 3), (0, 3), OVERLAP_GOLD),
    ]
    legend_table.setStyle(TableStyle(legend_style))
    elements.append(legend_table)
    elements.append(Spacer(1, 10))

    # Column definitions
    col_defs = [
        ["Column", "Definition"],
        ["Ticker", "Stock ticker symbol"],
        ["Fund", "Assigned fund (AI 300 or 679)"],
        ["Source", "AI 300 ONLY / 679 ONLY / OV→AI 300 / OV→679"],
        ["Gross P&L", "Backtest gross profit/loss (Nov 2022 — May 2026)"],
        ["Trades", "Total round-trip trades in backtest"],
        ["WR%", "Win rate percentage"],
        ["Edge", "P&L difference between systems (overlap only)"],
    ]
    col_table = Table(col_defs, colWidths=[1.2 * inch, 5.0 * inch])
    col_table.setStyle(TableStyle(_base_table_style() + _header_style(2)))
    elements.append(col_table)
    elements.append(Spacer(1, 10))

    # System descriptions
    sys_data = [
        ["", "AI 300", "679 Carnivore"],
        ["Strategy",
         "Weekly 5-lot pyramid with sector rotation.\n1.25x EMA gate.",
         "Kill-ranked 5-lot pyramid.\nSector-optimized EMA 18-26W."],
        ["Regime gate", "PAI300 index (proprietary)", "SPY / QQQ 21W EMA"],
        ["Period", "Nov 2022 — May 2026 (3.44 years)", "Nov 2022 — May 2026 (3.44 years)"],
    ]
    sys_table = Table(sys_data, colWidths=[1.2 * inch, 2.9 * inch, 2.9 * inch])
    sys_style = _base_table_style() + _header_style(3) + [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]
    sys_table.setStyle(TableStyle(sys_style))
    elements.append(sys_table)


# ── Section 1: Overlap Resolution ────────────────────────────────────────────

def _build_section1(elements, overlap_rows, ai_map, c679_map, styles):
    elements.append(PageBreak())
    elements.append(Paragraph(
        f"Section 1: Overlap Resolution — {len(overlap_rows)} Contested Tickers",
        styles["SectionTitle"],
    ))
    elements.append(Spacer(1, 4))
    elements.append(Paragraph(
        "Each ticker was backtested under both systems. The winner (higher gross P&amp;L) "
        "receives the ticker. Green = assigned AI 300, Blue = assigned 679.",
        styles["Body"],
    ))
    elements.append(Spacer(1, 8))

    header_labels = ["Ticker", "Company", "Assigned\nTo", "AI 300\nP&L", "AI 300\nTrades", "AI 300\nWin %",
                     "679\nP&L", "679\nTrades", "679\nWin %", "Edge"]
    col_widths = [0.55*inch, 1.35*inch, 0.65*inch, 0.7*inch, 0.5*inch, 0.5*inch,
                  0.7*inch, 0.5*inch, 0.5*inch, 0.7*inch]

    ROWS_PER_PAGE = 50
    pages = [overlap_rows[i:i+ROWS_PER_PAGE] for i in range(0, len(overlap_rows), ROWS_PER_PAGE)]

    for page_idx, page_rows in enumerate(pages):
        if page_idx > 0:
            elements.append(PageBreak())
        header = _hdr(header_labels, styles["TableHeader"])
        data = [header]
        row_colors = []
        for r in page_rows:
            name = ai_map.get(r["ticker"], {}).get("name", "") or c679_map.get(r["ticker"], {}).get("name", "")
            # Truncate long names
            if len(name) > 30:
                name = name[:28] + "…"
            assigned = "AI 300" if r["winner"] == "AI" else "679"
            data.append([
                r["ticker"], name, assigned,
                _fmt_money(r["ai_pnl"]), str(r["ai_trades"]), _fmt_pct(r["ai_wr"]),
                _fmt_money(r["c679_pnl"]), str(r["c679_trades"]), _fmt_pct(r["c679_wr"]),
                _fmt_money(r["edge"]),
            ])
            row_colors.append(AI_GREEN if r["winner"] == "AI" else C679_BLUE)

        table = Table(data, colWidths=col_widths, repeatRows=1)
        style = _base_table_style() + _header_style(len(header_labels))
        for i, c in enumerate(row_colors):
            style.append(("BACKGROUND", (0, i + 1), (-1, i + 1), c))
        # Right-align numeric columns (data rows only, not header)
        for col in [3, 4, 5, 6, 7, 8, 9]:
            style.append(("ALIGN", (col, 1), (col, -1), "RIGHT"))
        table.setStyle(TableStyle(style))
        elements.append(table)


# ── Section 2: Complete Master List ──────────────────────────────────────────

def _build_section2(elements, master, styles):
    elements.append(PageBreak())
    elements.append(Paragraph(
        f"Section 2: Complete Master List — {len(master)} Tickers (Alphabetical)",
        styles["SectionTitle"],
    ))
    elements.append(Spacer(1, 4))
    elements.append(Paragraph(
        "Green = AI 300, Blue = 679 Carnivore, Gold = overlap ticker.",
        styles["Body"],
    ))
    elements.append(Spacer(1, 8))

    header_labels = ["#", "Ticker", "Fund", "Source", "Gross P&L", "Trades", "WR%", "Sector"]
    col_widths = [0.3*inch, 0.5*inch, 0.55*inch, 0.75*inch, 0.7*inch, 0.45*inch, 0.45*inch, 2.4*inch]

    ROWS_PER_PAGE = 55
    pages = [master[i:i+ROWS_PER_PAGE] for i in range(0, len(master), ROWS_PER_PAGE)]

    for page_idx, page_rows in enumerate(pages):
        if page_idx > 0:
            elements.append(PageBreak())
        data = [_hdr(header_labels, styles["TableHeader"])]
        row_colors = []
        base_num = page_idx * ROWS_PER_PAGE + 1
        for i, m in enumerate(page_rows):
            sector = m["sector"]
            if len(sector) > 35:
                sector = sector[:33] + "…"
            data.append([
                str(base_num + i), m["ticker"], m["fund"], m["source"],
                _fmt_money(m["pnl"]) if m["pnl"] != 0 or m["trades"] != 0 else "—",
                str(m["trades"]) if m["trades"] != 0 else "—",
                _fmt_pct(m["wr"]) if m["trades"] != 0 else "—",
                sector,
            ])
            if m["is_overlap"]:
                row_colors.append(OVERLAP_GOLD)
            elif m["fund"] == "AI 300":
                row_colors.append(AI_GREEN)
            else:
                row_colors.append(C679_BLUE)

        table = Table(data, colWidths=col_widths, repeatRows=1)
        style = _base_table_style() + _header_style(len(header_labels))
        for i, c in enumerate(row_colors):
            style.append(("BACKGROUND", (0, i + 1), (-1, i + 1), c))
        for col in [0, 4, 5, 6]:
            style.append(("ALIGN", (col, 1), (col, -1), "RIGHT"))
        table.setStyle(TableStyle(style))
        elements.append(table)


# ── Section 3: AI 300 Final Roster ───────────────────────────────────────────

def _build_section3(elements, master, styles):
    ai_tickers = [m for m in master if m["fund"] == "AI 300"]
    ai_tickers.sort(key=lambda x: x["ticker"])

    elements.append(PageBreak())
    elements.append(Paragraph(
        f"Section 3: AI 300 Final Roster — {len(ai_tickers)} Tickers",
        styles["SectionTitle"],
    ))
    elements.append(Spacer(1, 4))
    elements.append(Paragraph(
        "All tickers assigned to the AI 300 fund after overlap resolution.",
        styles["Body"],
    ))
    elements.append(Spacer(1, 8))

    header_labels = ["#", "Ticker", "Company", "Source", "Gross P&L", "Trades", "WR%"]
    col_widths = [0.35*inch, 0.55*inch, 2.2*inch, 0.8*inch, 0.75*inch, 0.5*inch, 0.5*inch]

    ROWS_PER_PAGE = 55
    pages = [ai_tickers[i:i+ROWS_PER_PAGE] for i in range(0, len(ai_tickers), ROWS_PER_PAGE)]

    for page_idx, page_rows in enumerate(pages):
        if page_idx > 0:
            elements.append(PageBreak())
        data = [_hdr(header_labels, styles["TableHeader"])]
        row_colors = []
        base_num = page_idx * ROWS_PER_PAGE + 1
        for i, m in enumerate(page_rows):
            name = m["name"]
            if len(name) > 35:
                name = name[:33] + "…"
            data.append([
                str(base_num + i), m["ticker"], name, m["source"],
                _fmt_money(m["pnl"]) if m["pnl"] != 0 or m["trades"] != 0 else "—",
                str(m["trades"]) if m["trades"] != 0 else "—",
                _fmt_pct(m["wr"]) if m["trades"] != 0 else "—",
            ])
            row_colors.append(OVERLAP_GOLD if m["is_overlap"] else AI_GREEN)

        table = Table(data, colWidths=col_widths, repeatRows=1)
        style = _base_table_style() + _header_style(len(header_labels))
        for i, c in enumerate(row_colors):
            style.append(("BACKGROUND", (0, i + 1), (-1, i + 1), c))
        for col in [0, 4, 5, 6]:
            style.append(("ALIGN", (col, 1), (col, -1), "RIGHT"))
        table.setStyle(TableStyle(style))
        elements.append(table)


# ── Section 4: 679 Carnivore Final Roster ────────────────────────────────────

def _build_section4(elements, master, styles):
    c679_tickers = [m for m in master if m["fund"] == "679"]
    c679_tickers.sort(key=lambda x: x["ticker"])

    elements.append(PageBreak())
    elements.append(Paragraph(
        f"Section 4: 679 Carnivore Final Roster — {len(c679_tickers)} Tickers",
        styles["SectionTitle"],
    ))
    elements.append(Spacer(1, 4))
    elements.append(Paragraph(
        "All tickers assigned to the 679 Carnivore fund after overlap resolution.",
        styles["Body"],
    ))
    elements.append(Spacer(1, 8))

    header_labels = ["#", "Ticker", "Source", "Sector", "Gross P&L", "Trades", "WR%"]
    col_widths = [0.35*inch, 0.55*inch, 0.8*inch, 2.0*inch, 0.75*inch, 0.5*inch, 0.5*inch]

    ROWS_PER_PAGE = 55
    pages = [c679_tickers[i:i+ROWS_PER_PAGE] for i in range(0, len(c679_tickers), ROWS_PER_PAGE)]

    for page_idx, page_rows in enumerate(pages):
        if page_idx > 0:
            elements.append(PageBreak())
        data = [_hdr(header_labels, styles["TableHeader"])]
        row_colors = []
        base_num = page_idx * ROWS_PER_PAGE + 1
        for i, m in enumerate(page_rows):
            sector = m["sector"]
            if len(sector) > 30:
                sector = sector[:28] + "…"
            data.append([
                str(base_num + i), m["ticker"], m["source"], sector,
                _fmt_money(m["pnl"]) if m["pnl"] != 0 or m["trades"] != 0 else "—",
                str(m["trades"]) if m["trades"] != 0 else "—",
                _fmt_pct(m["wr"]) if m["trades"] != 0 else "—",
            ])
            row_colors.append(OVERLAP_GOLD if m["is_overlap"] else C679_BLUE)

        table = Table(data, colWidths=col_widths, repeatRows=1)
        style = _base_table_style() + _header_style(len(header_labels))
        for i, c in enumerate(row_colors):
            style.append(("BACKGROUND", (0, i + 1), (-1, i + 1), c))
        for col in [0, 4, 5, 6]:
            style.append(("ALIGN", (col, 1), (col, -1), "RIGHT"))
        table.setStyle(TableStyle(style))
        elements.append(table)


# ── Assemble PDF ─────────────────────────────────────────────────────────────

def generate_pdf(overlap_rows, master, stats, ai_map, c679_map):
    print(f"Generating PDF → {OUTPUT_PDF}")

    doc = SimpleDocTemplate(
        str(OUTPUT_PDF),
        pagesize=letter,
        leftMargin=0.45 * inch, rightMargin=0.45 * inch,
        topMargin=0.45 * inch, bottomMargin=0.45 * inch,
    )

    # Custom paragraph styles
    base_styles = getSampleStyleSheet()
    styles = {
        "Title": ParagraphStyle(
            "CustomTitle", parent=base_styles["Title"],
            fontName="Helvetica-Bold", fontSize=18, leading=22,
            textColor=BLACK,
        ),
        "Subtitle": ParagraphStyle(
            "CustomSubtitle", parent=base_styles["Normal"],
            fontName="Helvetica", fontSize=10, leading=14,
            textColor=colors.HexColor("#666666"),
        ),
        "SectionTitle": ParagraphStyle(
            "CustomSection", parent=base_styles["Heading2"],
            fontName="Helvetica-Bold", fontSize=13, leading=16,
            textColor=BLACK, spaceAfter=4,
        ),
        "Body": ParagraphStyle(
            "CustomBody", parent=base_styles["Normal"],
            fontName="Helvetica", fontSize=9, leading=13,
        ),
        "TableHeader": ParagraphStyle(
            "TableHeader", parent=base_styles["Normal"],
            fontName="Helvetica-Bold", fontSize=8, leading=10,
            textColor=PNTHR_YELLOW, alignment=1,  # 1 = CENTER
        ),
    }

    elements = []
    _build_page1(elements, overlap_rows, master, stats, styles)
    _build_section1(elements, overlap_rows, ai_map, c679_map, styles)
    _build_section2(elements, master, styles)
    _build_section3(elements, master, styles)
    _build_section4(elements, master, styles)

    doc.build(elements)
    print(f"Done. PDF saved to {OUTPUT_PDF}")


# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    export_universes()
    export_backtest_aggregates()
    overlap_rows = load_csv()
    ai_map, c679_map, ai_bt, c679_bt = load_universes()
    master, stats = build_master(overlap_rows, ai_map, c679_map, ai_bt, c679_bt)

    print(f"\nStats:")
    print(f"  Overlap tickers: {stats['overlap_count']}")
    print(f"  AI 300 total: {stats['ai_total']} ({stats['ai_exclusive']} exclusive + {stats['ov_to_ai']} overlap)")
    print(f"  679 total: {stats['c679_total']} ({stats['c679_exclusive']} exclusive + {stats['ov_to_679']} overlap)")
    print(f"  Total unique: {stats['total_unique']}")
    print()

    generate_pdf(overlap_rows, master, stats, ai_map, c679_map)


if __name__ == "__main__":
    main()
