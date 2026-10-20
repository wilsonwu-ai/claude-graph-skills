# Budget rules for a fan-out

A fan-out is a job where many agents work at once and one step combines what they return. These rules keep it from costing more than you priced or quietly returning something incomplete. Read this before you write or run a Workflow script.

## Run one scoped job before you save anything

Do not save a workflow script for reuse until it has run once, small, and you have seen what it cost. A saved script that never ran skips the calibration step and turns an unmeasured fleet into one keystroke. The first run buys information about cost, not the result.

## Rules every fan-out carries

1. **A named model on every agent call.** An omitted model falls to whatever default your setup has. That is a safety net, not a choice. Pick a tier per node class by asking what the node has to get right:

   | tier | the node's job | typical nodes |
   |---|---|---|
   | `haiku` / `low` | applies a rule you could have written in code | extract to a fixed schema, reformat, batch-summarize, count, yes/no match |
   | `sonnet` / `high` | real domain judgment, bounded scope, tight contract | read one file and return structured output, score one item against a rubric, draft one section, one skeptic verdict |
   | `opus` / `high` | weighs what the spec cannot list in advance | final synthesis, architecture decisions, anything irreversible, any node that already failed on a lower tier |

   Tier by the node, never by the stakes of the job. A high-stakes audit still has cheap extraction nodes. Escalate a node class only after a scoped run shows its output was wrong about judgment. If it was wrong about instructions, fix the prompt: a bigger model follows a bad spec more expensively.

2. **A total-agent budget across every axis.** Capping the outer fan-out is the classic undercount. Twenty sites with fifteen findings each and three skeptics per finding is 20 x 15 x 3 = 900 skeptic agents, plus one synthesis: 901 agents, not 20. Bound the product, and abort rather than truncate silently.

3. **A returned-versus-sent count at every fan-in.** Many harnesses return `null` for a skipped or errored agent, and a `.filter(Boolean)` swallows it. A dead node in a chain is obvious. A dead node in a fleet ships as a complete-looking report. Log any shortfall.

4. **Log whatever a cap dropped.** A capped run that does not say so misleads your future self.

5. **A layered fan-in whenever more than about 50 raw records reach one synthesis node.** Rules 2 to 4 bound the fan-out. Nothing in them bounds the fan-in, and that is where a wide run dies. Ninety sites at ten findings each is 900 records poured into one prompt. The node either overflows its context, or it silently reasons over a truncated middle and returns something that reads complete.

   Batch, summarize each batch, then combine the summaries. Never the raw pile.

   ```js
   // layered fan-in: the final node reads ~23 summaries, not 900 records
   const CHUNK = 40
   const batches = []
   for (let i = 0; i < findings.length; i += CHUNK) batches.push(findings.slice(i, i + CHUNK))
   log(`Fan-in: ${findings.length} records -> ${batches.length} batches of <=${CHUNK}`)

   const summaries = (await parallel(batches.map((b, i) => () =>
     agent(`Summarize this batch, keeping every distinct finding and its source:\n${JSON.stringify(b)}`,
           { label: `reduce:batch-${i}`, phase: 'Reduce', model: 'haiku', effort: 'low' }))))
     .filter(Boolean)
   if (summaries.length < batches.length) log(`WARNING: ${batches.length - summaries.length} batch summaries came back empty`)
   ```

   Batch summarizing is bounded and repetitive, so it runs on `haiku`. Only the final combine earns `opus`. The layer makes a wide run cheaper, not just safer.

   The threshold is a rule of thumb. Ten dense filings can be worse than two hundred one-line findings. If the records are long, layer earlier.

   Two shapes of layering exist, and picking the wrong one destroys the output. If the final node produces a summary, compress the batches. If it must produce one output per input record (an edit per finding, a fix per bug), you cannot compress, because you would be deleting the deliverable. Shard instead: identical instructions, disjoint slices, combined in plain code afterwards. Sometimes neither fits, for example when findings must be re-cited word for word. Then say so in a comment and log when the width is exceeded.

6. **Every worker prompt opens with the frozen context guard.** Rules 2 to 5 cap how many agents run and how much reaches synthesis. Nothing else caps how much one worker reads, and one unguarded lane can burn millions of tokens. Paste this verbatim as a `const GUARD` at the top of the script and put it in front of every worker prompt. It is frozen: no worker prompt may soften it.

   ```js
   const GUARD = `CONTEXT GUARD (frozen):
   - Never Read a file over ~400 lines whole. Grep or Glob first, then Read with offset/limit.
   - Skip vendored and generated paths: node_modules, vendor, dist, build, .git, lockfiles, *.min.*, maps.
   - Cap shell or grep output at ~200 lines (head/tail, -m, --max-count).
   - Past ~60 tool calls, stop. Return what you have with "incomplete": true and a notes field
     a fresh agent could continue from. A clean handoff beats a bloated finish.
   - Return the contract only. No narration, no transcript prose.
   - Do not consult an advisor.`
   ```

   Give worker schemas an optional `incomplete` boolean and a `notes` string so a stopped worker can hand off. The orchestrator re-spawns from `notes`, never from the transcript.

7. **Workflows learn across runs through a lessons file, and only the orchestrator writes it.** N workers appending to one file is a shared write target, which is a hidden edge (see the reverse fake edge test in the skill), so the write is centralized.
   - Location: `~/.claude/workflows/lessons/<job-type>.md`, at most about 40 bullets, newest first. Any path you keep consistently works.
   - **Before the run**, the orchestrator reads it and puts the bullet text into every worker prompt under `LESSONS FROM PRIOR RUNS:`. Paste the text, not just the path, because a worker may not open the file.
   - **Workers** return an optional `lessons: string[]` in their schema: what wasted time, what surprised them, what the next worker on this kind of job should know. One line each.
   - **After the run**, during the retro, the main session removes duplicates, keeps only lessons that generalize, appends them with the date, and prunes stale ones. A lesson that changes a frozen rule goes into the script or the spec, not only the lessons file.
