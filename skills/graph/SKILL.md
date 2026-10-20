---
name: graph
description: Use when planning a multi-step or multi-agent job, deciding whether to fan out (split work across parallel agents), or pricing a fan-out before spawning anything. Runs the fake edge test, gates whether a graph is worth it, then writes a costed spec. Also audits a workflow that already exists.
---

You are planning a job as a graph: a set of steps, with arrows only where one step really needs another step's output. The goal is to find out whether parallel agents will help, what they will cost, and how the result gets checked, before anything is spawned.

The job is in the user's request (or `$ARGUMENTS` if run as a command). If it is empty, ask what the job is in one line, then proceed.

**Where this fits.** This skill plans and prices a job inside one session. Hand anything that must survive a session, or that ends in an outside effect (send, deploy, publish, pay), to the `dag` skill.

**Input shape.** The person writes `task 0 = <context>` (a URL means read it), `task 1 ... n-1 = <info, constraints, sub-tasks>`, and the **last task = the deliverable**. The last task doubles as the definition of done that QA checks in Step 5b. The execution contract in Step 5b is always on; if the person also types "plan, strategize, deploy agents, QA and update me", that is redundant, not a new instruction.

**Do not spawn anything in this skill** unless the request begins with `go` followed by `task` or a line break (see Step 5). Otherwise the output is a plan the person approves or edits, and spawning happens on the next turn, after they say go.

**Two modes.** If the request starts with `audit` **and** what follows points at a workflow that already exists (a script path, a saved workflow name, a pasted transcript, or a description of something already running), run Audit mode below and stop. Otherwise skip to Step 1 and plan a new job. "Audit every route for missing auth" is a new job that happens to be an audit, so plan it. If it is ambiguous, ask in one line.

## Audit mode: `audit <workflow file, transcript, or description>`

Audit mode reads a workflow that already exists, which is where most of the damage already is. **Change nothing. The output is a table and a redrawn graph. Edits wait for an explicit go.**

Read the workflow literally: the script if there is one, otherwise the transcript or the steps as described. Then:

1. **Edge audit.** One row per step: `Step | Reads prior output? | Writes to | Verdict (real edge / FAKE / HIDDEN: shared write target)`. These are the two tests from Step 1, run against what was built.
2. **Self-grading audit.** Find every verify, score or judge step and ask: does it start from nothing, or does it already know the answer it is supposed to approve? Flag it **NOT VERIFICATION** if any of these hold:
   - the same agent call that did the work also checks it ("do X, then double-check your answer")
   - the verifier's prompt includes the worker's reasoning, transcript, or full result rather than the finding alone
   - the verifier reads no anchor (no test output, filing, spec sheet, ledger) and is judging prose against prose
3. **Fan-in audit.** For every synthesis node (the step that combines results), multiply out how many raw records reach it. Roughly 40 to 50 or more from one unbatched prompt is **SILENT DEGRADATION**. It will not error. It will skim the middle and return something that reads complete.
4. **Loop audit.** For every cycle, find where dedupe happens. It must run the moment a finding is produced, against everything seen, before any verifier is paid to judge it. Dedupe after judging, or against confirmed findings only, is **NEVER CONVERGES**: a rejected duplicate looks fresh every round, gets paid for again, and the loop never runs dry.
5. **Done audit.** What does the workflow treat as finished? A test that actually ran, or a model saying it should pass? The second is a flag.
6. **Rule-fix audit.** When this workflow has failed before, was the fix a patch to one output, or a change to the prompt, schema or frozen rule that produced it? A per-file patch means the same bug regenerates on the next item. Note which.

Report in this order, and stop:

```text
GRAPH AUDIT: <workflow>
EDGES          real n · fake n · hidden n
SELF-GRADING   <steps flagged, one line each, with the field or line that leaks>
FAN-IN         <widest synthesis node: records in, batched or raw>
LOOPS          <dedupe point: at find / after judge / none>
DONE MEANS     <anchor, or "a model said so">
RULE FIXES     <generator-level / per-output / n/a>
```

Then the redrawn graph as a table (`Node | Inputs | Writes to | Model tier | Verified by`), then the edits you would make, ranked. **No edits until the person says go.**

## Step 1: Fake edge test, out loud

List the job as the steps the person would naturally type. For each "then", state whether the next step actually READS the previous step's output.

Render it as a table: `Step | Reads prior output? | Verdict (real edge / FAKE)`.

Then state the arithmetic plainly: N steps in a row become the longest independent group plus the real edges. Name the wall-clock time saved.

**Then run the reverse test.** The fake edge test finds arrows that should not exist. This one finds arrows that should. For every pair of steps you just marked independent, name **where each one writes**: file path, branch, sheet tab, API endpoint, inbox. If two names collide, that is a hidden edge even though no data crosses it. Two agents with no data dependency and the same write target will race. Resolve it one of three ways and say which: give each its own workspace (for code, a separate git worktree), turn the pair back into a real edge by running them in order, or make the write idempotent (safe to repeat) so a retry cannot apply twice.

## Step 2: The gate. Does this even need a graph?

A graph buys **breadth, not judgment**. Say plainly which of these applies:

- **No two steps are independent** → no graph. Say so, recommend a plain loop, and stop. This is a correct and common outcome. Do not manufacture a graph to look useful.
- **Small or isolated** (one function, one bug, one email) → a single agent. Coordination is pure overhead. Stop.
- **The person wants to approve every step** → a fleet works against them. Stop.
- **They do not yet know what they are looking for** → one steerable agent, not a fleet locked into a plan drawn before the problem was understood. Stop.
- **Genuinely wide and independent** → continue to Step 3.

Large software build where you want to compare build methods → see the bakeoff skill.

If you stopped, you are done. That is the deliverable. On go, Step 5b rule 4 runs it (one agent).

## Step 3: The spec

```text
GRAPH SPEC
GOAL:        <one sentence>
FAN OUT:     <what splits, how many, why they're independent>
CONTRACT:    <the exact field shape every node returns>
ANCHOR:      <the ground truth the verifier reads: a test that ran, a filing, cash that
              landed, a spec sheet. If you cannot name one, say so explicitly: the verify
              step is then an echo, and the finding ships labelled unverified.>
VERIFY:      <independent skeptic(s); distinct lenses if it can be wrong in more than one way.
              Verifier sees the FINDING only, never the worker's reasoning.>
REDUCE:      <flatten / dedupe key / rank, in plain code, no agent>
CAP:         <every axis>
REPORT:      <shape, plus the returned-vs-sent count check>
HUMAN GATE:  <what it must not do without asking, expressed as TOPOLOGY, not wording.
              The unsafe node must be UNREACHABLE, not merely instructed to pause.
              "The script returns the report and writes no file unless a report path
              argument is supplied" is a gate. "The agent was told to ask first" is not one.
              Name the irreversible action (send, deploy, publish, install, pay,
              delete, email a customer) and the structural reason it cannot fire.>
FROZEN:      <the rules no node may tune, because they are exactly the ones an optimizer
              would weaken to win. Example set: never git stash, never git reset,
              no git command except committing one named file. Yours will differ per job.
              If nothing here can be gamed, write NONE and move on.>
```

## Step 4: The bill, before anyone pays it

Non-negotiable. Show:

- **The realistic speedup, not the agent count.** `p` falls straight out of the Step 1 table: independent steps divided by total steps. Then

  ```text
  S = 1 / ((1 - p) + p/N)          ceiling = 1 / (1 - p)
  p=0.95, N=16 -> 9.1x   (not 16x)   ceiling 20x
  p=0.70, N=16 -> 2.9x               ceiling 3.3x
  ```

  This is Amdahl's law: the serial part (planning, merging, verifying, writing up) does not get faster however many agents you add. Compute it with `python3 ~/.claude/skills/graph/scripts/speedup.py <p> <N>`. It prints S, the ceiling, and how many agents each further step up would cost.

  Print `p`, `N`, `S` and the ceiling. The number that matters is the **ceiling**: it says how much widening is still worth buying. If `S` is already near it, more agents buy latency you cannot use and cost money you can. If `p < 0.7`, say plainly that the merge-and-verify tail dominates and the graph is mostly overhead.

- **Total agent budget across every axis.** `outer x per-item findings x verifiers + synthesis`. Not the outer fan-out alone, which is the classic undercount (20 sites x 15 findings x 3 skeptics = 901, not 20).

- **The fan-in width.** Multiply it out: how many raw records reach the synthesis node? Over about 50, the run needs a layered fan-in (batch, summarize each batch, then combine; rule 5 in `~/.claude/skills/graph/references/budget.md`), not one giant prompt. Capping the fan-out while leaving the fan-in unbounded is the same undercount in a different form.

- **Model tier per node class. Name a tier for EVERY class, and show the split.** An omitted model falls to a default, which is a safety net, not a tier decision. Ask what each node has to get right:
  - `haiku`/`low`: applies a rule you could have written in code (extract to a fixed schema, reformat, batch-summarize, count, yes/no match).
  - `sonnet`/`high`: real domain judgment, bounded scope, tight contract (read one file and return structured output, score one item, draft one section, one skeptic verdict). **The usual default for fan-out, and the tier most often skipped.**
  - `opus`/`high`: weighs what the spec cannot list in advance (final synthesis, architecture, anything irreversible, anything that already failed on a lower tier).

  Print it as `N x haiku + M x sonnet + K x opus`, so the bill shows where the money goes. Tier by the node, never by the stakes of the job. A high-stakes audit still has haiku-tier extraction nodes.

- **Routing, if the items are uneven.** When most items are easy and a few are hard, add a router: every item starts on the cheap tier, and only items that trip a signal escalate. Name the signal, and prefer a deterministic one (a test failed, the diff touches more than one file, the schema returned `uncertain`) over a model's self-reported confidence, which is not calibrated. The router decides **where** an item goes. It never decides whether the item is **true**. That stays with the verifier and its anchor.

- **The first-run cap**, deliberately scoped small. The first run buys information about cost, not the result.

- **Usage-window check.** If your plan has a rolling usage limit and this job is wide, say so before it starts.

## Step 5: Hand off

End with the launch line and stop:

- One-off → `go` is enough. Step 5b runs it with the Workflow tool, and invoking this skill is the opt-in.
- Already-installed named workflow → run it by name with its arguments.
- Saved but never run → say so, and say it needs one scoped run first (see `~/.claude/skills/graph/references/budget.md`).

Do not spawn. Wait for approval, then run Step 5b.

**Pre-approval: `go ...`.** If the request begins with `go` followed by `task` or a line break, the person approved in advance ("go through the calls..." is a job, not an approval). Strip the `go`, print the plan as usual, then run Step 5b in the same turn, **unless** the plan has an irreversible node (send, deploy, publish, install, pay, delete, push, email a customer) or more than 10 agents in total. Either one → stop at the launch line and wait, exactly as without `go`.

## Step 5b: On go, execute (standing contract, always on)

Apply this on every go without being asked.

1. **A progress indicator first, if your setup has one.** Create it from the spec's nodes before the first spawn, and move it at every node boundary. It is the running "update me".
2. **Every spawn names its model and effort.** Tier per Step 4: lookup and extraction → `haiku`/`low`; building and bounded judgment → `sonnet`/`high`; synthesis, architecture, final review → `opus`/`high`.
3. **Thin orchestrator.** The main session plans, routes, integrates and judges. Bulk reading (files, logs, pages) goes to a scout that returns a compact summary. Worker returns are structured and short. A worker's transcript never enters the main context.
4. **A single-agent verdict delegates the typing only when it pays.** If the main session runs on an expensive tier, hand the work to one cheaper worker with a full handoff packet (objective, files in scope, out of scope, the verify command, stop conditions). If the main session is already on the cheaper tier, do it in place unless the reading would bloat the transcript. A few edits on context already loaded are always done in place.
5. **A fan-out runs as a Workflow.** Past the gate, run the spec with the Workflow tool. Invoking this skill is the opt-in, so `go` is enough.
6. **QA reads an anchor, not an opinion.** Done means the test ran and passed, the file opened and rendered, the number ties to its source, and the last task's definition of done is met. A fresh verifier sees the deliverable and the anchor only, never the worker's reasoning. No anchor → it ships labelled **UNVERIFIED**.
7. **Advisor checkpoints, orchestrator only.** If you use an advisor model, consult it before the spec locks, after the same error hits twice, and before declaring done. Subagents can inherit the advisor, and each call re-reads a whole transcript at the advisor's rates, so every worker prompt says not to consult it unless the spec names that worker. Skip all three checkpoints on a short run.
8. **Irreversible actions never ride this path.** Send, deploy, publish, install, pay, delete, push, email a customer: workers are read-only or write-scoped agent types, and the main session asks in chat first.
9. **Every worker prompt opens with the frozen context guard** (rule 6 in `~/.claude/skills/graph/references/budget.md`: no whole reads of big files, skip vendored paths, cap shell output, stop at about 60 tool calls and hand off through `notes`). Paste it as `const GUARD` and put it in front of every worker prompt. No worker prompt softens it.
10. **Lessons in, lessons out** (rule 7 in `budget.md`). Before spawning, read `~/.claude/workflows/lessons/<job-type>.md` if one exists (any path you keep consistently works) and put its bullets into every worker prompt. Worker schemas carry an optional `lessons: string[]`. After the run, the main session removes duplicates, appends the ones that generalize, and creates the file if this is a new job type. Workers never write the file.
11. **DAG discipline on any build-out that commits code** (frozen; no worker prompt softens these):
    - **a. Workers never mark themselves done.** A worker returns its branch, head commit and verify output. Only the main session moves a task to `succeeded`, and only after it re-runs the task's verify command itself on that commit. The worker's "pass" and a verifier's "pass" are inputs, not the state.
    - **b. Every result is bound to the input it was built from.** Each task records the base commit it was cut from and the head commit it returned. Before a merge, the main session checks the base is still an ancestor of the integration branch's head and that every upstream task it depends on is still at the commit it consumed. A result built on a stale base is rejected and re-run, never hand-merged.
    - **c. A repair invalidates its descendants.** When a task is repaired or re-run after its dependents started, every task that depends on it (transitively, per the plan's dependency list) drops to `invalidated` and re-runs its verify on the new base. Passing tasks are not assumed to still pass.
    - **d. Waves of at most 4 parallel builders** in one integration branch. More parallel writers widen the merge-conflict and stale-base surface faster than they save wall-clock time.
    - **e. One retry against the same immutable input.** A timed-out or crashed worker gets exactly one retry with the same prompt and the same base commit. A second failure is a `failed` task the main session reports, not a third attempt with a reworded prompt.

    Keep the task states in a file next to the plan (`<plan dir>/run-state.json`: task, state, base commit, head commit, attempt, last error), written only by the main session.
12. **Close out**, then Step 6 if a fleet ran:

```text
DONE: <deliverable>
SHIPPED      <what exists now, with paths or links>
VERIFIED BY  <the anchor, per item> · or UNVERIFIED: <why>
NOT DONE     <skipped, failed or deferred, with the reason>
COST         <n haiku + m sonnet + k opus agents · estimated -> actual>
NEXT         <the one move that matters now>
```

## Step 6: After the run, the retro (five lines, every time)

This is not part of the plan. It is what you do when the run comes back. Fill in the template in `~/.claude/skills/graph/references/retro.md` and print it. Without these numbers the fleet is tuned on feel, and a decorative verifier looks identical to a working one.

```text
RUN RETRO: <workflow> · <date>
VERIFIER KILL RATE   k/n (__%)   0% = decorative, check the anchor. >70% = workers mis-scoped.
FAN-OUT EFFICIENCY   u/N (__%)   unique useful findings / workers spawned. Low = redundant lanes.
COMPRESSION RATIO    raw -> kept  how much the reduce step removed before synthesis.
RETURNED vs SENT     r/s         any shortfall is a silently dead node. Always check it.
COST                 est -> act  agents and tokens, predicted vs real. This is the calibration.
```

If your harness reports per-agent tokens, add a heaviest-agent line (see `retro.md`). Then one sentence: **widen, narrow, or leave it.** That sentence is the whole point of the retro. Then fold the run's worker `lessons` into the lessons file (Step 5b rule 10).
