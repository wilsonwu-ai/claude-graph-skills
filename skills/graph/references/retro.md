# Run retro: five lines, every fleet

A fleet that is never measured gets tuned on feel. Worse, a decorative verifier (one that approves everything) looks exactly like a working one from the outside. Both return a report. Only one ever killed a finding. The kill rate is the cheapest way to tell them apart, and the numbers already exist in the run.

## The template

```text
RUN RETRO: <workflow> · <date> · <run id>
VERIFIER KILL RATE   k/n (__%)
FAN-OUT EFFICIENCY   u/N (__%)
COMPRESSION RATIO    <raw> -> <kept>
RETURNED vs SENT     r/s   [+ shortfall note]
COST                 est <agents/tokens> -> act <agents/tokens>
HEAVIEST AGENT       <label> = __% of context   (only if your harness reports per-agent tokens)
VERDICT              widen | narrow | leave it: <one sentence why>
```

## How to read each line

**Verifier kill rate:** findings killed divided by findings judged.
Zero is the alarm, not the win. It means one of three things: the verifier has no anchor (ground truth it can open, like a test result or a filing) and is just echoing, the schema lets anything pass, or the workers were so constrained they could not produce a wrong answer. Check which. Above about 70% the verifier is fine and the workers are mis-scoped: they generate output the fleet then pays skeptics to reject. A healthy band is roughly 15% to 50%. These bands are a rule of thumb from the author's own runs, not a measured standard.

**Fan-out efficiency:** unique useful findings divided by workers spawned.
This is the signal-to-width ratio. Low means the lanes overlap. Five researchers on five different angles is coverage. Fifty on reworded prompts is noise billed by the token. It tells you whether widening is buying anything.

**Compression ratio:** raw records in, records that survived the reduce step.
It shows how much work plain code removed before an expensive model saw it. Near 1:1 means you are paying judgment prices for plumbing. See rules 4 and 5 in `budget.md`.

**Returned versus sent:** count at every fan-in, not only the last.
A skipped or errored agent often returns `null`, and a filter hides it. A dead node in a fleet ships as a complete-looking report. Any shortfall gets a sentence, not a shrug.

**Cost:** predicted versus actual, in agents and tokens.
This is the only line that improves the next estimate. Underestimates usually trace to an unbounded inner axis (rule 2 in `budget.md`) or an unlayered fan-in (rule 5).

**Heaviest agent:** the one lane with the largest share of its context window.
Only fill this in if your harness reports per-agent tokens. The idea: if one lane of a fan-out uses far more than its siblings (a share over roughly a third of its context is a fair flag), scope that lane tighter. The threshold is a rule of thumb.

**Verdict:** the point of the whole exercise. One sentence, one of three words: widen, narrow, or leave it. A retro that ends without one was bookkeeping, not a decision.

## After the retro

Fold the run's worker `lessons` into your lessons file (rule 7 in `budget.md`). Keep a short log of past retros, one row per run: date, workflow, kill rate, efficiency, compression, returned/sent, cost estimate to actual, verdict. Over a few runs the cost column calibrates your estimates, which is the real payoff.
