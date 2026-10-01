#!/usr/bin/env python3
"""Enforce >=80% statement coverage in every production Go file."""
import sys
from collections import defaultdict
counts = defaultdict(lambda: [0, 0])
for line in open(sys.argv[1]):
    if line.startswith('mode:'):
        continue
    block, statements, executions = line.split()
    name = block.split(':')[0]
    counts[name][1] += int(statements)
    if int(executions):
        counts[name][0] += int(statements)
failed = False
for name, (covered, total) in sorted(counts.items()):
    percent = covered / total * 100
    print('%s: %.2f%% (%s/%s statements)' % (name, percent, covered, total))
    failed |= percent < 80
sys.exit(1 if failed or not counts else 0)
