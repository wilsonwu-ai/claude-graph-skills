---
name: bakeoff
description: Use for a large software build (about 15+ plan tasks, or a multi-hour job with several agents editing code) when you want evidence about which build method should be your default. Runs one frozen plan through two builders, scores both on anchors only, and logs the result. Subcommands: bakeoff log, bakeoff verdict.
---

# /bakeoff

A bakeoff is a **blind, paired champion/challenger test of build methods on one frozen plan.**

- The **champion** is your current default build method (Arm A).
- The **challenger** is any second builder (Arm B).
- Both build the same plan. A referee that never knows who built what scores them on checks you wrote before the run.
- If the challenger wins often enough, it becomes the new default. If not, the champion stays.

Why not other names: it is not an A/B test (that assigns live users to variants, so call the sides Arm A and Arm B). It is not best-of-N (that picks one output from many tries, it does not compare methods). It is not an arena (rankings from crowd votes). It is not N-version programming (several versions running side by side behind a voter). The mechanics are borrowed from shared-task "bake-offs" in language-technology research: shared data, enrolled competitors, a scoring referee.

The job: `$ARGUMENTS`

**Subcommands.**
- `bakeoff log` prints the log file and stops. Suggested path: `~/.claude/workflows/lessons/large-build-ab.md`. Row format: `references/scorecard.md`.
- `bakeoff verdict` reads the log and counts runs per arm (one row per arm per run, so a run count is a row count). Before every arm has 3 rows, it says how many runs remain. After that, it recommends a default, with the numbers behind it, using the verdict rule in `references/scorecard.md`, and states the statistics caveat below.
- Anything else is a new bakeoff.

## Step 0: Qualify (one line, then continue or stop)

A bakeoff is for **building software**: about 15 or more plan tasks, or a multi-hour job, with several agents editing code in parallel. Research, audits and one-file fixes do not qualify. Say "not a bakeoff, use the graph skill instead" and stop. (A run that falls below this bar can still be logged, but mark it "below size bar"; it counts as weak evidence.)

## Step 1: Preflight (report, change nothing)

Print one block and fix nothing yet:

```text
BAKEOFF PREFLIGHT
GIT         working tree clean? current commit hash
IDENTITY    git user.name / user.email, and the `gh api user --jq .login` account: is it the one you mean to push from?
ARM A       champion builder installed and runnable? (graph skill + your harness's workflow or subagent tool)
ARM B       challenger builder installed and runnable? (its runtime versions, build step, dev server)
WINDOW      usage window: rolling and weekly limits against roughly 2x one build
```

If anything is missing, list the exact install commands and **wait for the person's go**. Never install on your own. After any package-manager install, re-check that the tools you already depend on still print a version (a new runtime install can upgrade shared libraries under an older one).

## Step 2: One plan, written once

1. Run the graph skill's planning steps on the job, if you use it.
2. Write the shared plan to `docs/bakeoff/<date>-<slug>/PLAN.md` in the repo, in the shape in `references/plan-shape.md`: numbered tasks, each with Files, Interfaces, Depends on, and an exact Verify command.
3. Write the acceptance tests both arms must pass to `ACCEPTANCE.md` next to it (template in the same reference).
4. **Freeze both files.** Neither arm edits them.
5. Cut two branches from **one commit**: `ab/champion` and `ab/challenger`. Each arm works in its own worktree. Never a shared write target.
6. Print the bill line, required: `Arm A ~X tokens, Arm B ~X tokens, total ~2X, human steering time est. N min`.
7. Ask: **"Run both arms, or champion only?"** The person may veto Arm B for any job.

Fix the metric and the stopping rule now, before any arm starts (see the verdict rule in `references/scorecard.md`).

## Step 3: Run the arms

- **Arm A, the champion.** Default: the graph skill plus your harness's workflow or subagent tool, on `ab/champion`. Put the same guard rules and lessons in every worker prompt.
- **Arm B, the challenger.** Any second builder. Examples: another orchestration tool, another harness, a board-style multi-agent tool where the person steers live, or **a single steerable session as a control arm**. The single-session control is recommended: in a 260-configuration study every multi-agent architecture scored 2.1% to 14.9% below a single agent on SWE-bench Verified (arXiv 2512.08296), so a bakeoff without that control cannot tell you whether any orchestrator beats not orchestrating. Load the plan's tasks into the challenger however it takes work. Build on `ab/challenger`.
- Arms may run in parallel, in separate worktrees. Start each arm's wall clock at its first agent spawn.
- Log every human intervention, with a timestamp and one line on why, in `<plan dir>/arm-b-interventions.md` (and an `arm-a-interventions.md` if the champion also needed any).

## Step 4: Judge on anchors only

An anchor is ground truth that cannot argue back: a test that ran, a count, a diff. Another model's opinion alone is not an anchor.

1. **Acceptance.** Run `ACCEPTANCE.md` and your QA gate on each branch. Record pass and fail counts.
2. **Real API smoke call.** If the build calls an external API, `ACCEPTANCE.md` must include one real call (not a fake or stub) with the settings the plan prescribes. In run 1, both arms failed the live eval for one reason: the shared plan asked for 32,000 output tokens on a call that must stream, and the test fakes never reached the real API. A shared plan fails both arms together; only a real call catches it.
3. **Equal verify-and-repair budget.** Give both arms the same budget for fixing their own failures after the build (same number of repair rounds, same tool access). Otherwise you are scoring the budgets.
4. **Blind verifier, twice.** Before judging, write down a random order and save it. A read-only verifier agent gets both diffs labelled `X` and `Y` in that order, plus the plan and the acceptance file, never which arm built which. It returns defects per side. Then run it again with the labels swapped, to cancel position bias. Report both passes.
5. **Defects per 1,000 lines.** Divide each arm's defect count by its lines added, times 1,000. Raw defect counts reward the arm that wrote less.
6. **Tokens and wall clock** from each tool's own usage record, not from memory.
7. **Unblind.**

## Step 5: Log and close out

Append one row per arm to the log (format and worked example: `references/scorecard.md`). Fold any new lesson into your lessons files. Then print the close-out table from the same reference, with a one-line CALL: champion, challenger, or tie, and why.

**Human gate.** Merging the winning branch, pushing, or opening a PR needs the person's go in chat. A bakeoff never does these on its own.

After the third run per arm, run `bakeoff verdict` unprompted.

## Statistics caveat

If two arms are truly equal, one of them sweeps all of three runs with probability p = 0.25 (each of two arms wins three straight with chance 1/8). So **three runs show direction, not a winner.** State this whenever you report a verdict. Fewer than three runs per arm is not a verdict.

## Retire rule

Once a default is chosen, write it into your graph skill (the build-out guidance) and stop running bakeoffs. Run another only when something changes: a new builder, a new model generation, or a build type the earlier runs did not cover.
