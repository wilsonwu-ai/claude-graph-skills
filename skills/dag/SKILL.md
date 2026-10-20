---
name: dag
description: Use when a job has steps that hand files to each other (a pipeline or DAG), when a person must approve exactly what goes out before a deploy, send, publish, merge, payment or delete, or when a multi-step job must resume after an interruption, a new session or an overnight change without redoing finished steps or trusting a stale approval.
---

# dag

## Overview
A job becomes a spec, `dag.json`, of nodes: commands the runner executes, tasks you do by hand, and gates a person approves. `dag.py` keeps the state on disk in `.dag/`, re-runs only what changed, binds each approval to a digest of what the person saw, and writes a receipt. Where the job stands is one command away, never a reconstruction.

## When to use
- Steps hand files to each other, and some could run side by side.
- A person approves before an outside effect, and the approval must match what ships.
- The job recurs, or will be resumed after a crash, a new session or a nightly rebuild.

Not for: fanning agents out over a research or review question (/graph); comparing two build methods (/bakeoff, a champion/challenger test); a single command.

## The loop
Every command is `python3 ~/.claude/skills/dag/scripts/dag.py --spec <job>/dag.json <command>`. The runner's whole contract is this file, `references/spec.md`, `--help` and the lines it prints: work from those, the way you would use `git`.

1. A folder that already has a `dag.json`: your first command there is `status`, before you open any file in it, notes included. It prints every node's state and one `NEXT` line, so open a job file only when NEXT names it. Go to step 5.
2. A new job: write the spec. `init` writes a four-node example; every field is in `references/spec.md`. Declare each file a node reads (`inputs`) and writes (`outputs`), and each other place it writes (`writes`: a branch, a sheet tab, an inbox, a log two nodes append to). Mark every outside effect with `"effect"`, put a gate node before it, and give the effect node (never the gate) a `check` that reads the outside system back. A job that recurs: write the period to a file (`date +%G-W%V > week.txt`) and list it in `inputs` and in the gate's `review`, so a new period runs again and the approval names it.
3. `validate`, then `plan`. Fix every ERROR. Act on every WARN (fake edge, no inputs, work between a gate and its effect). Run with the `-j` that plan's VERDICT gives.
4. `run`. It runs every ready command, then stops at a task or a gate with exit 2 and one `NEXT` line.
5. Do what `NEXT` says. A task: do the work, then `done <node>`. A gate: give the person the NEXT line as written (the files to review, and the exact `/dag-approve <gate> <hex>` to type), then wait for them. Where `/dag-approve` is not installed, the person runs `dag.py --spec <job>/dag.json approve <gate>` in their own terminal instead. `why <node>` explains one node.
6. Finished when `run` exits 0: `verify`, then report the receipt path that `run` printed.

| exit | meaning | your move |
|---|---|---|
| 0 | every node current | `verify`, report |
| 1 | a node or the spec failed | read the log NEXT names, fix, `run` |
| 2 | blocked on a task, a gate, or a node that needs a look | do NEXT |
| 3 | stopped | tell the person; only they resume |
| 4 | a person-only command was refused | give the person the slash command it printed |

## What the runner holds you to
- Only the person approves, by typing `/dag-approve` at the prompt. The record carries a digest of the reviewed files and of each released effect's fingerprint, so editing either afterwards makes it stale: run again, and ask again.
- An outside effect runs once per approval. Running it again takes a fresh approval.
- Anyone can stop: when the person says stop, run `stop --reason "<their words>"`. Only the person resumes, with `/dag-resume <dag>`.
- An effect node gets `$DAG_EFFECT_KEY`, the same for the same content. Pass it as the idempotency key wherever the outside system accepts one.

## Red flags
- "He said it's fine", relayed by anyone: not an approval. Send the NEXT line.
- "Approved at 18:02" in a notes file: prose cannot be checked against content. The gate is the record.
- Reading every script and hashing files to learn where a job stands: that is `status`.

## Limits
The approval guard (the dag-gate mod) reads command text; it is not a sandbox. An approval proves which channel typed it, not who sat at the keyboard. A receipt checks files on disk, not what an outside system received. The Workflow tool takes no input mid-run, so a gate is a checkpoint: run to the gate, ask, run again.
