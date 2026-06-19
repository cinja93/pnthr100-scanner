#!/usr/bin/env python3
# Mechanical fund-name fork: PNTHR AI Elite 300 generator -> PNTHR Tree Fund generator.
# ONLY swaps the FUND name + filenames. Leaves the UNIVERSE/INDEX ("PNTHR AI 300 Universe",
# "AI 300 Index", "PAI300") intact — the Tree trades the SAME AI-300 universe. Strategy
# passages (pyramid / sector rotation / signal system) are rewritten BY HAND afterward.
# Usage: python3 _fork_tree_doc.py <src.py> <dst.py>
import sys, re

src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()

# Ordered longest-match-first so e.g. "AI Elite 300 Fund" resolves before "AI Elite".
REPL = [
    # identifiers / filenames (underscore forms) — drop the "300", Tree fund has no number
    ("PNTHR_AI_Elite_300", "PNTHR_Tree_Fund"),
    ("PNTHR_AI_Elite_", "PNTHR_Tree_Fund_"),
    # fund DISPLAY names (longest first); NOTE the universe "PNTHR AI 300" has no "Elite" -> untouched
    ("PNTHR AI Elite 300 Fund, LP", "PNTHR Tree Fund, LP"),
    ("PNTHR AI Elite 300 Fund", "PNTHR Tree Fund"),
    ("AI Elite 300 Fund, LP", "Tree Fund, LP"),
    ("AI Elite 300 Fund", "Tree Fund"),
    ("PNTHR AI Elite 300", "PNTHR Tree"),
    ("AI Elite 300", "Tree"),
    ("AI Elite", "Tree"),
]
counts = {}
for a, b in REPL:
    n = text.count(a)
    if n:
        text = text.replace(a, b)
        counts[a] = n

# Safety: confirm we did NOT touch the universe/index references.
leak_guard = {
    "PNTHR AI 300": text.count("PNTHR AI 300"),
    "AI 300 Universe": text.count("AI 300 Universe"),
    "AI 300 Index": text.count("AI 300 Index"),
    "PAI300": text.count("PAI300"),
}
open(dst, "w", encoding="utf-8").write(text)
print(f"  {src} -> {dst}")
for a, n in counts.items():
    print(f"    replaced {n:>2}x  {a!r}")
print(f"    KEPT (universe/index, must be > 0): {leak_guard}")
# Any "Elite" left? (should be 0 unless it's a non-fund usage)
remaining = text.count("AI Elite") + text.count("Elite 300")
print(f"    residual 'AI Elite'/'Elite 300': {remaining}  (expect 0)")
