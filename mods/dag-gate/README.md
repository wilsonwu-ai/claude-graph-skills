# dag-gate

The person's side of the `/dag` skill (`~/.claude/skills/dag`). A dag job stops at a gate until the person
approves exactly the files it names; this mod is how they approve from the prompt, and the guard that keeps the
model from approving for them.

## Commands

| Command | Who | What it does |
| --- | --- | --- |
| `/dag-approve <gate> <hex> [dag or folder]` | the person only | Finds the gate request with that hex, re-reads and re-hashes every reviewed file, rebuilds the manifest and checks it hashes to the request's digest, then writes `.dag/approvals/<gate>.json`. The approval covers exactly those file contents and the effects named, once. |
| `/dag-pending [dag or folder]` | anyone | Lists open gate requests with the exact `/dag-approve` line, and stopped dags. |
| `/dag-revoke <gate> [dag or folder]` | anyone | Withdraws an approval before its effect runs. Revoking only tightens. |
| `/dag-stop <dag or folder> [reason]` | anyone | Writes the stop flag: no new node starts. Stopping only tightens. |
| `/dag-resume <dag or folder>` | the person only | Clears the stop flag (one job, named exactly). |
| `/dag-gate-unlock [minutes or off]` | the person only | Lets the model edit the frozen files (below) for 1 to 240 minutes, default 30. |

"The person" is the engine's own stamp on the command: `composer` (typed at the prompt and sent with Enter) or
`bridge` (their phone or web client). A command the model gets run arrives with any other origin and is refused,
with a toast.

`dag.py approve` and `dag.py resume` in a real terminal stay the other way for the person; `dag.py` refuses them
when it runs inside Claude Code or without a TTY.

## The guard

On every tool call, from the main loop and every subagent, before the tool runs:

| Area | Refused | Allowed |
| --- | --- | --- |
| person | `dag.py approve` and `resume`, however spelled: `--spec` first, abbreviations, `python -m dag`, a variable for the path, `bash -c`, `xargs`, `env`, `timeout`, `uv run`, inline code, a script the command runs | every other `dag.py` command: `status`, `run`, `run --dry-run`, `why`, `done`, `stop`, `revoke`, `invalidate` |
| state | any write into a `.dag` folder (approvals, `STOP`, `state.json`, gate requests, receipts) or the spent ledger (`~/.claude/dag-gate/spent`, and removing or moving a folder above it) by redirect, `cp`, `mv`, `rm`, `sed -i`, `tee`, `touch`, `ln`, `find -delete`, globs, inline code, paths handed to code or scripts, Write/Edit/MultiEdit/NotebookEdit, a symlink that lands there, a relative path, a glob that reaches one from where the shell sits, or a Python/Node program while the shell sits inside one; and setting `DAG_GATE_HOME` (by assignment, `export`, `read` or `printf -v`), or `PYTHONPATH` and its kin for a command that runs dag.py, either of which could point the runner at another ledger | reading: `cat`, `ls`, `jq`, `grep`, and `sort -o` elsewhere |
| frozen | writes to `~/.claude/skills/dag`, this mod's folder, and the folder registry (`~/.claude/dag-gate/registry`), including removing a folder above them | reading them; running the runner and its tests |

The working directory is tracked per loop across calls, so `cd job/.dag` in one call and `echo x > STOP` in the
next is caught. A command the guard cannot read for certain (a computed path, inline code, an unknown program)
is refused only when it names the gate's files or `dag.py`. If the guard itself fails, it refuses only calls that
mention the gate, so a bug cannot take every Bash call down.

## How an approval binds

`dag.py` hashes a manifest for each gate:

```
dag-gate/1
dag <name>
node <gate>
file <sha256> <path>        one per reviewed file, sorted by code point
effect <node> <fingerprint> one per effect the gate releases, sorted
```

The digest of that text is the hex the person types. `/dag-approve` rebuilds it from the bytes on disk, so an
approval can only ever name what the person could read at that moment. An effect spends the approval once,
recorded in `state.json` `spent` and in a ledger outside the job folder (`~/.claude/dag-gate/spent/`), so a folder
restored from a backup taken before the effect ran cannot spend it again. The runner finds that ledger through the
account's home directory, not `$HOME`, and the guard treats it as state: no unlock opens it, and a command that
sets `DAG_GATE_HOME` is refused. Running the effect again takes a new approval. Changing any reviewed file makes
the old approval stale and files a new request with a new hex.

The record also names its folder (`dag_dir`), and `dag.py` refuses one written for another folder. A copied job
folder (`cp -R job job2`) carries the approval file, but not the approval: the copy files its own request, shows
in `/dag-pending`, and needs its own `/dag-approve`. A moved folder needs a new approval for the same reason. Two
spellings of one folder on a case-insensitive disk (`~/desktop` and `~/Desktop`) count as one folder.

## Limits

- **The guard reads the model's tool calls, and nothing else.** It does not see a write made by a process a call
  starts (a node command that `dag.py run` executes, a `sitecustomize.py` Python loads before dag.py's first
  line, a program whose text it does not read), by a plugin's own tool, or by an MCP tool through an argument
  other than `command`, `cmd` or `script`. Any of those can write `.dag/approvals`, and the digest is public, so a
  forged record would be accepted; they can also rewrite the spent ledger. For approvals the fix lives at the OS
  layer: a sandbox `denyWrite` rule for `.dag/approvals` folders, after which approvals are withdrawn with
  `/dag-revoke`, since `dag.py revoke` run by the model writes there too. That rule is recommended and this mod
  does not configure it. The ledger cannot take the same rule: `dag.py run` records every spend there from the
  model's own calls, so its guard is this mod alone.
- The guard protects the default gate home, `~/.claude/dag-gate`. If the person sets `DAG_GATE_HOME` in Claude
  Code's own environment, the registry and ledger there are not guarded.
- With the shell inside `~/.claude/dag-gate` itself, the guard treats it as sitting in the ledger's folder, so
  under an unlock, edit the registry by absolute path or from `~/.claude/dag-gate/registry`.
- Script and inline-code reading is a text heuristic. It undoes quoting, `+`, commas and spacing, but
  deliberately obfuscated code (`chr(46)`, base64) can evade it.
- After a `cd` to a computed path (`cd "$DIR"`), the guard no longer knows where the shell is, so it refuses
  relative writes to the runner's file names (`state.json`, `stop`, `events.jsonl`, anything under `approvals/`,
  `gates/` or `receipts/`) even in an unrelated folder. Write by absolute path, or `cd` to an absolute path first.
- It holds only in sessions that load the mod (`CLAUDE_CODE_PLUGIN_DIRS`).
- The unlock covers the whole session, main loop and subagents alike, and lives in memory: a restart locks the
  frozen files again.
- `/dag-approve` re-reads files of up to 4 MiB each and at most 500 per gate; past that, approve in a terminal.
- A job is found through the registry `dag.py` keeps in `~/.claude/dag-gate/registry` (or `$DAG_GATE_HOME`).
  A job whose folder moved needs a run to register again, and a new approval.

## Layout and tests

```
.claude-plugin/plugin.json   manifest
hooks/hooks.json             module list
hooks/register.ts            commands, guard, shell-place memory
hooks/analyze.ts             the shell reader (tokenizer and parser forked from launchd-gate)
hooks/approve.ts             pure helpers: request checks, manifest, approval record
types/index.d.ts             state contract (unlock, shell)
tests/*.test.ts              50 tests; the gate tests use a request dag.py actually filed as the anchor
```

`claude plugin validate <dir>`, `claude plugin test <dir>`, and `tsc -p <dir>`.
