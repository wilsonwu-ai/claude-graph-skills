#!/usr/bin/env python3
"""
speedup.py: what fanning out actually buys you, before you pay for it.

Amdahl's law. Sixty years old, still the thing that decides whether your graph
was worth building.

    S = 1 / ((1 - p) + p/N)        ceiling = 1 / (1 - p)

    p = the fraction of the work that is genuinely independent
    N = how many agents you run at once

The number people expect is N. The number they get is S. The gap between them is
the serial tail: the planning, the merge, the verify, the final write-up. None of
that gets faster no matter how many agents you add.

Getting p is not guesswork. It falls straight out of the fake edge test:

    p = (steps that can run at the same time) / (total steps)

Usage:
    python3 speedup.py 0.95 16          # one case
    python3 speedup.py 0.95             # the curve, across agent counts
    python3 speedup.py                  # the whole table

No dependencies. Python 3.9+ (standard library).
"""

import sys

AGENT_COUNTS = [2, 4, 8, 16, 32, 64, 256]
P_VALUES = [0.50, 0.70, 0.80, 0.90, 0.95, 0.99]


def speedup(p, n):
    """Amdahl. Returns the realistic multiple, not the agent count."""
    if not 0.0 <= p <= 1.0:
        raise ValueError("p must be between 0 and 1")
    if n < 1:
        raise ValueError("N must be at least 1")
    return 1.0 / ((1.0 - p) + (p / n))


def ceiling(p):
    """The most you could ever get, with infinite agents. Usually the real answer."""
    return float("inf") if p >= 1.0 else 1.0 / (1.0 - p)


def agents_for(p, target):
    """How many agents to reach a target speedup. None if the ceiling forbids it."""
    if target >= ceiling(p):
        return None
    return p / ((1.0 / target) - (1.0 - p))


def verdict(p, n):
    """The one sentence that should decide whether you spawn anything."""
    s, c = speedup(p, n), ceiling(p)
    if p < 0.7:
        return ("SKIP THE GRAPH: the serial tail dominates. At p=%.2f the ceiling is %.1fx "
                "no matter how wide you go. Use a plain loop." % (p, c))
    if s >= 0.8 * c:
        return ("STOP WIDENING: %d agents already buys %.1fx of a %.1fx ceiling. More agents "
                "buy latency you cannot use and cost money you can." % (n, s, c))
    return ("WIDENING STILL PAYS: %.1fx now, %.1fx available. Next doubling is worth pricing."
            % (s, c))


def bar(value, scale, width=34):
    filled = min(width, int(round(width * value / scale)))
    return "#" * filled + "." * (width - filled)


def one_case(p, n):
    s, c = speedup(p, n), ceiling(p)
    print()
    print("  independent fraction p   %.2f   (%.0f%% of the work can run at once)" % (p, p * 100))
    print("  agents in parallel  N    %d" % n)
    print()
    print("  naive expectation        %.1fx   <- what people assume" % n)
    print("  REALISTIC SPEEDUP        %.1fx   <- what you actually get" % s)
    print("  ceiling (infinite N)     %s" % ("unbounded" if c == float("inf") else "%.1fx" % c))
    print("  wasted expectation       %.1fx" % (n - s))
    print()
    print("  " + verdict(p, n))
    print()
    for t in (2, 5, 10, 20):
        if t < c:
            need = agents_for(p, t)
            if need and need <= 1000:
                print("    %5.1fx needs %6.1f agents" % (t, need))
    print()


def curve(p):
    c = ceiling(p)
    print()
    print("  p = %.2f     ceiling = %s" % (p, "unbounded" if c == float("inf") else "%.1fx" % c))
    print()
    print("   agents |  speedup | efficiency | ")
    print("  --------+----------+------------+" + "-" * 36)
    scale = min(c, 64) if c != float("inf") else 64
    for n in AGENT_COUNTS:
        s = speedup(p, n)
        print("   %6d |  %6.2fx |     %4.0f%%   | %s" % (n, s, 100 * s / n, bar(s, scale)))
    print()
    print("  Efficiency is the honest column: the share of each agent you actually used.")
    print("  When it falls below ~50%, you are paying for coordination, not throughput.")
    print()


def table():
    print()
    print("  REALISTIC SPEEDUP  S = 1 / ((1-p) + p/N)")
    print()
    header = "     p    ceiling |" + "".join("%8d" % n for n in AGENT_COUNTS)
    print(header)
    print("  " + "-" * (len(header) - 2))
    for p in P_VALUES:
        c = ceiling(p)
        row = "  %5.2f   %6.1fx |" % (p, c)
        row += "".join("%7.1fx" % speedup(p, n) for n in AGENT_COUNTS)
        print(row)
    print()
    print("  Read the ceiling column first. It is the whole story: at p=0.70 you cannot")
    print("  beat 3.3x with a thousand agents, and at p=0.95 sixteen agents already")
    print("  captures 9.1x of an available 20x.")
    print()
    print("  Get p from the fake edge test:  p = independent steps / total steps")
    print()


def main():
    args = sys.argv[1:]
    try:
        if len(args) >= 2:
            one_case(float(args[0]), int(args[1]))
        elif len(args) == 1:
            curve(float(args[0]))
        else:
            table()
    except ValueError as e:
        print("error: %s" % e, file=sys.stderr)
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
