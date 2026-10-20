# Shared plan shape

Both arms read the same two files, written once and then frozen: `PLAN.md` and `ACCEPTANCE.md`. They live in `docs/bakeoff/<date>-<slug>/`.

The shape is built so that each task can be handed to a separate worker with no other context, and so that a machine can check it.

## PLAN.md

Start with three short lines: the goal in one sentence, the stack, and the frozen rules (constraints no worker may relax, such as "never edit tests", "no new dependencies", "only touch files listed in your task").

Then the tasks, numbered. Each task uses exactly this block:

```text
## Task N: <short name>

Files
  create: <path>, <path>
  modify: <path>

Interfaces
  exports: <name(signature) or endpoint or file format>
  consumes: <name from Task M, with the same signature>

Depends on: <task numbers, or "none">

Verify: <one exact command that exits 0 on success>
```

Rules for the blocks:

- **Files.** List every file the task may create or change. Two tasks that run at the same time must not list the same file. If they do, they are not independent: serialize them or split the file.
- **Interfaces.** Say what the task exports and what it consumes, with names and signatures spelled out. A consumer reads the exporter's interface from the plan, not from the exporter's code, so tasks can be built at the same time.
- **Depends on.** List a dependency only if the task reads that task's output. A dependency listed for tidiness is a false edge and costs wall clock.
- **Verify.** An exact command, copy-pasteable, that fails if the task is wrong. Not "check that it works". If the task calls an external API, at least one task's Verify must make a real call.
- Keep a task small enough for one worker to finish in one sitting. If it needs more than a handful of files, split it.

End `PLAN.md` with a one-line list of task groups that can run together, such as "Tasks 2, 3 and 4 after Task 1".

## ACCEPTANCE.md template

```text
# Acceptance (frozen)

Run from the repo root on each branch. Record pass or fail per check.

## Checks
1. <name>: `<exact command>`  expect: <exit 0 / output contains ...>
2. <name>: `<exact command>`  expect: ...
...

## Real call (required if the build uses an external API)
N. Live smoke: `<command that makes one real call with the plan's real settings>`
   expect: <a response, not a stub>

## Frozen rules (checked by command or by count, not by opinion)
R1. <rule>: `<command>`  expect: ...
R2. ...

## Out of scope
<what neither arm is scored on>
```

Notes:

- Write every check before either arm starts. Do not add, loosen or remove a check after seeing results.
- Prefer checks that run end to end over checks that run against fakes. A fake that never reaches the real service can pass while the build is broken.
- Keep the total small (a handful of checks plus the frozen rules), so pass counts stay readable as p/n.
