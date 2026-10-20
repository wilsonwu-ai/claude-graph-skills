# Scorecard

## Log row format

One row per arm per run, appended to the log (suggested path `~/.claude/workflows/lessons/large-build-ab.md`). A two-arm run adds two rows. An arm's run count is its row count.

```text
| date | job | arm | tests p/n | blind defects | defects per 1k lines | wall clock | tokens | human steps |
```

- **date**: day the run finished.
- **job**: short name, plus "below size bar" if it had fewer than about 15 tasks.
- **arm**: `champion`, or the challenger's name (say if it is a single-session control).
- **tests p/n**: acceptance checks passed over total, from `ACCEPTANCE.md`.
- **blind defects**: defects the blind verifier found on that arm. Give both label-swapped passes if they differ (for example `9 / 11`).
- **defects per 1k lines**: blind defects divided by lines added, times 1,000.
- **wall clock**: first agent spawn to last, `hh:mm`.
- **tokens**: from the tool's own usage record.
- **human steps**: number of logged interventions, and minutes if known.

## Close-out table (print after every run)

```text
BAKEOFF  <job>  <date>  run k of 3
              CHAMPION            CHALLENGER (<name>)
TESTS         p/n                 p/n
DEFECTS       n (blind)           n (blind)
PER 1K LINES  x                   x
WALL CLOCK    hh:mm               hh:mm
TOKENS        n                   n
HUMAN STEPS   n                   n  (~m min)
CALL          <champion / challenger / tie, one line why>
```

`run k` is each arm's row count after this append.

## Verdict rule (fix it before run 1)

Write down, before any run, the metric and the stopping rule. Suggested default:

1. **Primary metric**: acceptance tests passed, then blind defects per 1,000 lines as the tie-breaker.
2. **Constraint**: a frozen-rule failure on one arm counts as a loss for that run on that rule, whatever the other numbers say.
3. **Wall clock, tokens and human steps** are reported, not scored. They decide only between arms that tie on 1 and 2.
4. **A run is "won"** by the arm ahead on the primary metric. If equal, it is a tie.
5. **Stopping rule**: no verdict until every arm has 3 or more rows. Then recommend the arm that won more runs, and show the counts.
6. **Always add the caveat**: if two arms are truly equal, one of them sweeps three runs with probability p = 0.25. Three runs show direction, not a winner. A 3-0 result is a reason to adopt a default and keep watching, not proof.

After a default is chosen, write it into your graph skill and stop running bakeoffs until something changes.

## Worked example: run 1 (one run, below the size bar, not a verdict)

Source: the author's first bakeoff run (one run, not published separately). One frozen 11-task plan, built twice. Champion: the graph skill with a Workflow run. Challenger: a board-style multi-agent tool where the person steers live.

| Measure | Champion (graph + Workflow) | Challenger (board) |
|---|---|---|
| Acceptance checks passed | 6 of 7 | 4 of 7 |
| Blind-verifier defect score (lower is better) | 9 | 25 |
| Frozen safety rules | all 8 pass | 3 fail |
| Live eval | fail | fail |
| Wall clock | 25:21 | 8:57 |
| Lines added | 10,064 | 4,916 |

What to take from it, and what not to:

- Both arms failed the live eval for one reason: the shared plan asked for 32,000 output tokens on a call that must stream, and the fakes in the tests never reached the real API. That is why the skill now requires one real API call in `ACCEPTANCE.md`.
- The run was below the size bar (11 tasks, against the bar of about 15). Live steering, the board's main case, came to one action.
- The run used raw defect scores, unequal repair budgets and one judging pass. The metrics in this skill (defects per 1,000 lines, equal repair budget, two label-swapped passes, a single-session control arm) were added afterward for that reason, so this row is not comparable to later rows.
- One run is one row per arm. It says nothing about which method should be your default.
