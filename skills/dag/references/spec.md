# dag.json reference

Paths in a spec are relative to the spec's folder. The runner's state lives in `.dag/` beside it (it writes its own `.gitignore`, so the folder never reaches git).

## Top level

| key | required | meaning |
|---|---|---|
| `dag` | yes | short name: letters, digits, `.`, `-`, `_` (64 at most). Slash commands use it. |
| `description` | no | one line |
| `nodes` | yes | object of node name to node |
| `idempotent_targets` | no | `{target: reason}` for a `writes` target two unordered nodes may share because a second apply is harmless |

Unknown keys are errors, with a "did you mean" hint.

## Nodes

The kind comes from the keys: `gate` makes a gate, `run` makes a cmd, neither makes a task.

| key | kinds | meaning |
|---|---|---|
| `description` | all | what it does; shown in NEXT for tasks |
| `run` | cmd | argv list (`["python3", "build.py"]`, preferred) or a shell string (`/bin/sh -c`). Runs in the spec's folder. |
| `after` | all | data edges: this node uses those nodes' results. Their output digests enter its fingerprint. |
| `order_only` | all | ordering edges: wait for them, ignore their content |
| `inputs` | cmd, task | files read: literal paths, globs (`*`, `?`, `[..]`, `**`), or folders ending in `/` |
| `outputs` | cmd, task | files written: literal paths or folders ending in `/` (no globs). Checked to exist after the run, hashed, and owned by this node alone. |
| `writes` | cmd, task | other places it writes: `git:branch/x`, `sheet:BD!A1`, `api:crm`, `launchd:com.x`, or `file:logs/run.log` for a file several nodes append to (`outputs` belong to one node). Two unordered nodes may not share one (unless `idempotent_targets`). |
| `check` | cmd, task | anchor command (argv or string), run in the spec's folder with the node's environment: must exit 0 after the run, or after `done`, or the node fails |
| `idempotent` | cmd, task | safe to repeat. Needed for `retries`; an interrupted idempotent node re-runs by itself. |
| `retries` | cmd | 0 to 10 extra attempts, idempotent nodes only. Backoff 2 s, doubling (`DAG_RETRY_BACKOFF` sets the base). |
| `timeout_s` | cmd | kill the node's process group after this many seconds |
| `effect` | cmd, task | `irreversible` or `external`: it changes something outside the folder. Needs a gate upstream. |
| `est_minutes` | all | for `plan` (default 1, gates 0) |
| `env` | cmd | extra environment variables, strings |
| `gate` | gate | `{"review": [paths or globs], "summary": "...", "approver": "Sam"}` |

## What validate enforces

Errors (the job will not run):
- a cycle, printed as `cycle: a -> b -> a`
- an unknown or self dependency
- an effect node with no gate upstream ("a human gate is topology")
- a race: a node reads a file that an unordered node writes
- a file cycle: a node reads a file that one of its descendants writes
- a node that reads its own output
- two nodes writing the same output, or two unordered nodes sharing a `writes` target (the hidden edge). The three fixes: a separate target, an edge, or `idempotent_targets` with the reason.
- `retries` without `idempotent`; a glob in `outputs`; a gate with a command

Warnings (the job runs; read them):
- fake edge: B is `after` A but reads none of A's outputs. Drop the edge, or move it to `order_only`.
- a cmd with no inputs runs once, then only when something upstream changes
- work between a gate and its effect: no approval covers what that work produces

## Run semantics

- A node is current when its fingerprint matches and its recorded outputs are unchanged on disk. Fingerprint = sha256 of its spec, the contents of its inputs, and the output digests of its `after` nodes (gates contribute nothing: they order work, the files carry the content).
- Early cutoff: a node that re-runs and writes the same bytes leaves everything downstream current.
- Failed nodes re-run on the next `run`. Independent branches keep going.
- A node cut off mid-run (crash, kill) is re-run if `idempotent`, else it waits for `invalidate`.
- One runner per folder (`fcntl.flock` on `.dag/lock`).
- Each `run` and `done` that changes something appends a receipt; each receipt holds the sha256 of the one before it.

## Recurring jobs

The runner has no clock: a cmd with no inputs is current after one run, forever. For a job that runs each week (or day, or month), the trigger writes the period to a file first, and the spec lists that file as an input of the first nodes, of the gate's `review`, and of the effect:

```text
date +%G-W%V > week.txt    then    dag.py --spec <job>/dag.json run
```

A new week re-runs the job and asks for a new approval that names the week. The same week twice runs nothing.

## Gates and approvals

When a gate's upstream is current, `run` files a request at `.dag/gates/<gate>.json` and registers the folder in `~/.claude/dag-gate/registry/` (`DAG_GATE_HOME` moves it). The digest is sha256 of this manifest, UTF-8, every line ending in `\n`:

```text
dag-gate/1
dag <dag name>
node <gate name>
file <sha256 hex> <path>          one per reviewed file, sorted by path
effect <node> <fingerprint hex>   one per effect the gate releases, sorted by node
```

A gate releases an effect when only gates sit between them; then the effect's fingerprint is known at approval time and goes into the digest. `dag.py digest <gate>` prints the manifest and the digest.

An approval is `.dag/approvals/<gate>.json`:

```json
{"format": 1, "dag": "promo", "dag_dir": "/Users/you/jobs/promo", "node": "review", "digest": "sha256:...",
 "files": [{"path": "out/index.json", "sha256": "..."}],
 "approved_at": "2026-10-20T15:02:11.000Z", "via": "dag-gate:/dag-approve (composer)"}
```

Only two writers are accepted (`via`): the dag-gate mod's `/dag-approve`, typed by the person at the prompt or through Remote Control, and `dag.py approve` run by the person in their own terminal (it refuses without a TTY or inside Claude Code). A record with `"revoked": true` counts as none, and so does one whose `dag_dir` is another folder: a copied job folder files its own request and needs its own approval. Two spellings of one folder on a case-insensitive disk count as one folder.

Each start of an effect node spends the current approval of every gate above it, in `state.json` `spent` and in a ledger outside the job folder (`~/.claude/dag-gate/spent/`). The same approval never releases that effect again, even in a folder restored from a backup taken before the effect ran; `run` re-files the request with `not_before` set, and the person approves again. If the ledger cannot be written, the effect node fails without starting. The ledger sits under the account's home directory even when `HOME` says otherwise; only `DAG_GATE_HOME` moves it, and dag-gate refuses any command of the model's that sets that variable or touches the ledger, with or without an unlock.

## Stop

`.dag/STOP` with `"active": true` stops `run` and `done` from starting anything; a run in flight finishes the nodes it already started. `dag.py stop` sets it (anyone). `/dag-resume <dag>` or `dag.py resume` in the person's terminal clears it.

## Environment a node sees

`DAG_NAME`, `DAG_NODE`, `DAG_RUN_ID`, `DAG_DIR`, and for effect nodes `DAG_EFFECT_KEY` (32 hex, the same while the effect's content is the same).

## Exit codes

0 ok, 1 error or failed node, 2 blocked, 3 stopped, 4 refused (person-only), 130 interrupted.

## Files

```text
.dag/state.json        node states, fingerprints, spent approvals
.dag/events.jsonl      append-only event log
.dag/logs/<node>.log   each node's output, all attempts
.dag/gates/<gate>.json approval requests
.dag/approvals/        approval records (person only)
.dag/STOP              stop flag
.dag/receipts/         hash-chained receipts (000001-20261020T120428Z.json, ...), LATEST names the newest
```
