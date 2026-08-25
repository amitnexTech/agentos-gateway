#!/usr/bin/env python3
"""Summarise a baseline log: median tok/s, spread, and how often requests stall.

    python3 scripts/baseline-summary.py [data/baseline-<provider>.log]

Median rather than mean, because a handful of 35-second stalls drag an average
somewhere that describes no actual request.
"""
import re
import statistics as st
import sys
from collections import defaultdict

path = sys.argv[1] if len(sys.argv) > 1 else "data/baseline-provider.log"
STALL_MS = 10_000

samples = defaultdict(list)
errors = defaultdict(lambda: defaultdict(int))

for line in open(path):
    if line.startswith("#"):
        continue
    hit = re.search(r"(\S+)\s+([\d.]+) tok/s\s+(\d+)ms", line)
    if hit:
        samples[hit.group(1)].append((float(hit.group(2)), int(hit.group(3))))
        continue
    bad = re.search(r"\S+\s+(\S+)\s+ERROR\s+(\d+|\S+)", line)
    if bad:
        errors[bad.group(1)][bad.group(2)] += 1

if not samples and not errors:
    sys.exit(f"no samples in {path}")

print(f"{'model':18} {'n':>4} {'median':>7} {'min':>6} {'max':>6}   stalls >{STALL_MS//1000}s")
for model, rows in samples.items():
    tps = [r[0] for r in rows]
    stalled = sum(1 for r in rows if r[1] > STALL_MS)
    print(
        f"{model:18} {len(rows):4d} {st.median(tps):7.1f} {min(tps):6.1f} {max(tps):6.1f}"
        f"   {stalled}/{len(rows)} ({100 * stalled / len(rows):.0f}%)"
    )

if errors:
    print("\nerrors:")
    for model, kinds in errors.items():
        detail = ", ".join(f"{code}×{n}" for code, n in kinds.items())
        print(f"  {model:18} {detail}")
