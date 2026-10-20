import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DagGateShellPlace } from '../types'
import { analyze, analyzeScript, mentionsGate, pathArea } from './analyze'
import type { Area, Finding } from './analyze'
import { answers, approvalRecord, asRegistry, asRequest, fromBase64, hex, isObj, isoMs, manifestOf, parseApprove, selects, spent } from './approve'
import type { GateRequest, PersonOrigin, RegistryEntry } from './approve'

const NAME = 'dag-gate'

/**
 * Until when (clock ms) the person let the frozen dag files be edited; 0 when locked. Held by the host in memory,
 * so a restart locks them again, which is the safe direction.
 */
const unlock = atom({ plugin: 'dag-gate', key: 'unlock' } as const, 0)

/**
 * Where each loop's shell was last left, as far as the guard could read (the launchd-gate pattern). A working
 * directory outlives a Bash call, so `cd job/.dag` in one call and `echo x > approvals/review.json` in the next
 * would otherwise name no protected place at all. `path` is where the shell is when the guard could follow it
 * (null: a computed `cd` made it unknown; absent: never moved, so the session directory).
 */
const shellPlaces = atom({ plugin: 'dag-gate', key: 'shell' } as const, {} as Record<string, DagGateShellPlace>)

/** Tools whose file path is the thing written. MultiEdit is not in every build, so tools are compared by name. */
const PATH_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** Tools whose `command` runs in a shell. */
const SHELL_TOOLS = new Set(['Bash', 'Monitor', 'PowerShell'])
/** How many script files one command may make the guard read. */
const MAX_SCRIPTS = 5
const MAX_SCRIPT_CHARS = 400_000
/** The most reviewed files /dag-approve re-hashes; past that, approving is the terminal's job. */
const MAX_FILES = 500
/** The most registry entries the commands read. */
const MAX_REGISTRY = 400
const UNLOCK_DEFAULT_MIN = 30
const UNLOCK_MAX_MIN = 240
const RUNNER = 'python3 ~/.claude/skills/dag/scripts/dag.py'

const HOUSE_RULE =
  'House rule: a dag job ships only what the person approved. Only the person approves (/dag-approve) or resumes (/dag-resume); ' +
  'a .dag folder is written by dag.py and the dag-gate commands alone, and the spent ledger (~/.claude/dag-gate/spent) by dag.py alone; ' +
  'the dag skill, this mod and the folder registry are frozen. ' +
  'A human gate is topology, not prompt wording.'

const ADVICE: Record<Area, string> = {
  person:
    'dag.py approve and resume are the person\'s commands: they type /dag-approve <gate> <hex> or /dag-resume <dag> at the prompt, ' +
    `or run dag.py in their own terminal. Run ${RUNNER} --spec <job>/dag.json status and give the person its NEXT line as written: ` +
    'the files to review and the exact /dag-approve line. Then wait for them.',
  state:
    'A .dag folder is the runner\'s record: approvals, the stop flag, spent approvals, gate requests, receipts. The spent ledger ' +
    '(~/.claude/dag-gate/spent) keeps every spend outside the job folder too, so it is never edited, removed or moved, and DAG_GATE_HOME ' +
    'is never set to point the runner at another one. Change a job\'s record only through dag.py (run, done, stop, revoke, invalidate); ' +
    'read it with status, status --json or why. A plain cat of a file there is fine.',
  frozen:
    'The dag skill (~/.claude/skills/dag), this mod and the folder registry (~/.claude/dag-gate/registry) are frozen: they hold the rules a model ' +
    'under pressure would bend. If one needs a change, tell the person what and why; they can type /dag-gate-unlock 30 to allow edits for 30 minutes.',
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

const toast = ($: EngineInterface, text: string): void => {
  try {
    $.ui.toast(text, { timeoutMs: 9000 })
  } catch {
    // A toast that cannot draw must never change the verdict.
  }
}

/** The text a shell tool will run, else undefined. MCP tools that take a `command` are read as a shell too. */
const commandOf = (tool: string, input: Record<string, unknown>): string | undefined => {
  if (SHELL_TOOLS.has(tool)) {
    return str(input.command)
  }
  if (tool.startsWith('mcp__')) {
    return str(input.command) ?? str(input.cmd) ?? str(input.script)
  }

  return undefined
}

const pathOf = (tool: string, input: Record<string, unknown>): string | undefined =>
  PATH_TOOLS.has(tool) ? str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? str(input.filePath) : undefined

const attempt = async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await work()
  } catch {
    return undefined
  }
}

const homeOf = async ($: EngineInterface): Promise<string | undefined> => str(await attempt(() => $.env.get('HOME')))?.replace(/\/+$/, '')

/** Where this mod lives, frozen like the skill; a copy in a dev-mods folder is being worked on and stays open. */
const frozenRoots = ($: EngineInterface): string[] => {
  const root = str($.plugin.root)

  return root === undefined || root.includes('/dev-mods/') ? [] : [root.replace(/\/+$/, '')]
}

/** `~/x` the way the person reads it. */
const shown = (path: string, home: string | undefined): string =>
  home !== undefined && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path

/** A script the command would run, as text; undefined when it cannot be read. */
const readScript = async ($: EngineInterface, path: string, home: string | undefined): Promise<string | undefined> => {
  let p = path
  if (p === '~' || p.startsWith('~/')) {
    if (home === undefined) {
      return undefined
    }
    p = `${home}${p.slice(1)}`
  }
  const text = await attempt(() => $.fs.read(p))

  return typeof text === 'string' ? text.slice(0, MAX_SCRIPT_CHARS) : undefined
}

const describe = (findings: readonly Finding[]): string => {
  const seen: string[] = []
  for (const f of findings) {
    if (!seen.includes(f.why)) {
      seen.push(f.why)
    }
  }
  const head = seen.slice(0, 3).join('; ')

  return seen.length > 3 ? `${head}; and ${seen.length - 3} more` : head
}

const denyText = (tool: string, findings: readonly Finding[], isShellInside = false): string => {
  const areas = (['person', 'state', 'frozen'] as const).filter(a => findings.some(f => f.area === a))
  const parts = [`${NAME}: BLOCKED ${tool}. ${HOUSE_RULE}`, `What tripped it: ${describe(findings)}.`, ...areas.map(a => ADVICE[a])]
  if (findings.some(f => !f.sure)) {
    parts.push(
      'Part of this command could not be read for certain (a computed path, inline code, a script, or a program not known to be read-only), ' +
        'and the guard refuses what it cannot read. Use plain commands with literal paths, and dag.py for anything in a .dag folder.',
    )
  }
  if (isShellInside || findings.some(f => f.why.includes('the shell'))) {
    parts.push('The shell sits (or may sit) inside a protected folder, and a working directory outlives a Bash call. Leave it first with an absolute cd, for example cd /tmp.')
  }
  parts.push('STOP. Do not retry, rephrase, split the command into steps, or reach the same place with another tool or a script; none of that is allowed either.')

  return parts.join('\n')
}

const toastFor = (who: string, findings: readonly Finding[]): string => {
  const hint = findings.some(f => f.area === 'person')
    ? 'Approving or resuming is yours: type /dag-approve <gate> <hex> or /dag-resume <dag> if you mean it.'
    : findings.every(f => f.area === 'frozen')
      ? 'If you want those files changed, /dag-gate-unlock 30 opens them for 30 minutes.'
      : 'A .dag folder and the spent ledger are written by dag.py alone.'

  return `${NAME} blocked ${who}: ${describe(findings)}. ${hint}`
}

/** The findings that still block: frozen ones lift while the person's unlock lasts. */
const blocking = async ($: EngineInterface, findings: readonly Finding[]): Promise<Finding[]> => {
  if (!findings.some(f => f.area === 'frozen')) {
    return [...findings]
  }
  const until = await read($, unlock)
  const now = await $.clock.now()

  return until > now ? findings.filter(f => f.area !== 'frozen') : [...findings]
}

/** Judge a shell command: allow it, or deny it with the reason. */
const guardCommand = async <E extends { tool: unknown }, R>(
  $: EngineInterface,
  e: E,
  next: (e: E) => Promise<R>,
  tool: string,
  command: string,
  agentId: string | undefined,
): Promise<R | { deny: string }> => {
  const loop = agentId ?? 'main'
  const isBash = tool === 'Bash'
  const place = isBash ? (await read($, shellPlaces))[loop] : undefined
  const sessionCwd = place?.path === undefined ? await attempt(() => $.session.cwd()) : undefined
  const base = place?.path === undefined ? sessionCwd : place.path
  const home = await homeOf($)
  const frozen = frozenRoots($)
  const options = { cwd: base, home, frozen }
  const analysis = analyze(command, { ...options, level: place?.level, area: place?.area })
  const findings: Finding[] = [...analysis.findings]
  const readable = analysis.scripts.slice(0, MAX_SCRIPTS)
  for (const script of readable) {
    const text = await readScript($, script.path, home)
    if (text === undefined && script.inline === undefined) {
      // Missing, unreadable, or about to be created by this very command: nothing to judge it by. Fine for a
      // command that has nothing to do with the gate; for one that does, it is the hole the guard must not leave.
      if (analysis.mentions) {
        findings.push({ area: 'state', sure: false, why: `script ${script.path} cannot be read (it is missing, or this command creates it) in a command that names the dag gate's files or dag.py` })
      }
      continue
    }
    for (const body of [text, script.inline]) {
      if (body !== undefined) {
        findings.push(...analyzeScript(body, script.kind, script.path, options))
      }
    }
  }
  if (analysis.scripts.length > readable.length && analysis.mentions) {
    findings.push({ area: 'state', sure: false, why: `${analysis.scripts.length} scripts run in a command that names the dag gate's files; only ${MAX_SCRIPTS} can be read` })
  }
  // Remember where this loop's shell ends up, so the next call's relative paths are read in that directory.
  const remember = async (): Promise<void> => {
    if (!isBash) {
      return
    }
    const endPath = analysis.endCwd === sessionCwd && place?.path === undefined ? undefined : analysis.endCwd
    const nextPlace: DagGateShellPlace | undefined =
      analysis.endLevel === 0 && endPath === undefined
        ? undefined
        : {
            level: analysis.endLevel,
            ...(endPath === undefined ? {} : { path: endPath }),
            ...(analysis.endArea === undefined ? {} : { area: analysis.endArea }),
          }
    if (JSON.stringify(nextPlace) === JSON.stringify(place)) {
      return
    }
    await update($, shellPlaces, current => {
      const { [loop]: _gone, ...rest } = current

      return nextPlace === undefined ? rest : { ...rest, [loop]: nextPlace }
    })
  }
  const left = await blocking($, findings)
  if (left.length === 0) {
    await remember()

    return next(e)
  }
  toast($, toastFor(agentId === undefined ? 'the model' : 'a subagent', left))

  return { deny: denyText(tool, left, place !== undefined && place.level !== 0) }
}

const dirOf = (p: string): string => {
  const cut = p.replace(/\/+$/, '').lastIndexOf('/')

  return cut <= 0 ? '/' : p.slice(0, cut)
}

/** Judge a file write: a .dag folder or a frozen place is refused, by its spelling and by where it really lands. */
const guardPath = async <E extends { tool: unknown }, R>(
  $: EngineInterface,
  e: E,
  next: (e: E) => Promise<R>,
  tool: string,
  path: string,
  agentId: string | undefined,
): Promise<R | { deny: string }> => {
  const home = await homeOf($)
  const frozen = frozenRoots($)
  let area = pathArea(path, frozen, home)
  let landed = path
  if (area === undefined) {
    // A symlink can put an innocent-looking path inside a protected folder: ask where it really lands (best effort).
    const name = path.replace(/\/+$/, '').slice(path.replace(/\/+$/, '').lastIndexOf('/') + 1)
    for (const [p, tail] of [[path, ''], [dirOf(path), `/${name}`]] as const) {
      const stat = await attempt(() => $.fs.stat(p, { resolve: true }))
      if (stat?.realPath !== undefined) {
        const real = `${stat.realPath.replace(/\/+$/, '')}${tail}`
        area = pathArea(real, frozen, home)
        if (area !== undefined) {
          landed = real
          break
        }
      }
    }
  }
  if (area === undefined) {
    return next(e)
  }
  const finding: Finding = { area, sure: true, why: `${tool} on ${landed}` }
  if ((await blocking($, [finding])).length === 0) {
    return next(e)
  }
  toast($, toastFor(agentId === undefined ? 'the model' : 'a subagent', [finding]))

  return {
    deny:
      `${NAME}: BLOCKED ${tool} on ${path}${landed === path ? '' : ` (it lands in ${landed})`}. ${HOUSE_RULE}\n${ADVICE[area]}\n` +
      'STOP. Do not reach the same file with another tool or a script.',
  }
}

// --- the commands' reading of dag.py's files -----------------------------------

const readJson = async ($: EngineInterface, path: string): Promise<unknown> => {
  const text = await attempt(() => $.fs.read(path))
  if (typeof text !== 'string') {
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** `new Uint8Array(bytes)` copies onto a plain ArrayBuffer, the only kind `digest` takes. */
const sha256 = async (bytes: Uint8Array): Promise<string> => hex(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))

/** Where dag.py registers job folders: `$DAG_GATE_HOME`, else ~/.claude/dag-gate (the runner's own rule). */
const gateHome = async ($: EngineInterface): Promise<string | undefined> => {
  const custom = str(await attempt(() => $.env.get('DAG_GATE_HOME')))
  if (custom !== undefined) {
    return custom.replace(/\/+$/, '')
  }
  const home = await homeOf($)

  return home === undefined ? undefined : `${home}/.claude/dag-gate`
}

/** Every registered job whose folder still holds a `.dag` record. */
const registry = async ($: EngineInterface): Promise<RegistryEntry[]> => {
  const home = await gateHome($)
  const dir = home === undefined ? undefined : `${home}/registry`
  const listed = dir === undefined ? undefined : await attempt(() => $.fs.list(dir))
  const out: RegistryEntry[] = []
  for (const ent of (listed ?? []).filter(x => x.kind === 'file' && x.name.endsWith('.json')).slice(0, MAX_REGISTRY)) {
    const rec = asRegistry(await readJson($, `${dir}/${ent.name}`))
    if (rec !== undefined && !out.some(o => o.dag_dir === rec.dag_dir) && (await attempt(() => $.fs.exists(`${rec.dag_dir}/.dag`))) === true) {
      out.push(rec)
    }
  }

  return out
}

/** The registered jobs a selector (a dag name or a folder) names; all of them without one. */
const scoped = async ($: EngineInterface, entries: RegistryEntry[], sel: string | undefined): Promise<RegistryEntry[]> => {
  if (sel === undefined) {
    return entries
  }
  const home = await homeOf($)
  const typed = home !== undefined && (sel === '~' || sel.startsWith('~/')) ? `${home}${sel.slice(1)}` : sel
  const real = typed.startsWith('/') ? (await attempt(() => $.fs.stat(typed, { resolve: true })))?.realPath : undefined

  return entries.filter(r => selects(r, typed, real))
}

const listJobs = (entries: readonly RegistryEntry[], home: string | undefined): string =>
  entries.map(r => `${r.dag} (${shown(r.dag_dir, home)})`).join('; ')

const personOrigin = (kind: string): PersonOrigin | undefined => (kind === 'composer' || kind === 'bridge' ? kind : undefined)

const refusal = ($: EngineInterface, command: string, kind: string): { text: string } => {
  toast($, `${NAME}: something other than you tried /${command} (origin: ${kind}). Refused. Type it yourself at the prompt.`)

  return {
    text:
      `refused. /${command} only counts when the person types it at the prompt or through Remote Control ` +
      `(this run came from "${kind}"). Stop and ask the person to type it.`,
  }
}

/** Every reviewed file, re-read and re-hashed: what the person read must still be what the request names. */
const filesProblem = async ($: EngineInterface, req: GateRequest): Promise<string | undefined> => {
  if (req.files.length > MAX_FILES) {
    return `${req.node} reviews ${req.files.length} files, more than the ${MAX_FILES} /dag-approve re-reads. Approve it with dag.py approve in your own terminal.`
  }
  for (const f of req.files) {
    const got = await attempt(() => $.fs.read(f.path.startsWith('/') ? f.path : `${req.dag_dir}/${f.path}`, { as: 'bytes' }))
    if (got === undefined) {
      return `${f.path} cannot be read (missing, or over 4 MiB, the most a mod reads at once). Approve it with dag.py approve in your own terminal, or run the job again if the file moved.`
    }
    if ((await sha256(fromBase64(got.base64))) !== f.sha256) {
      return `${f.path} changed after the request was filed, so what you reviewed is not what would ship. Run the job again: it files a new request with a new hex. Review that, then approve it.`
    }
  }

  return undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const spec of [
      { name: 'dag-approve', description: 'Approve one dag gate: exactly the files you reviewed, for the effect it releases, once', argumentHint: '<gate> <hex> [dag|folder]', immediate: true },
      { name: 'dag-pending', description: 'List dag gates waiting for your approval, and stopped dags', argumentHint: '[dag|folder]', immediate: true },
      { name: 'dag-revoke', description: 'Revoke a dag gate approval before its effect runs', argumentHint: '<gate> [dag|folder]', immediate: true },
      { name: 'dag-stop', description: 'Stop a dag: nothing new starts until you resume it', argumentHint: '<dag|folder> [reason]', immediate: true },
      { name: 'dag-resume', description: 'Clear a stop you or anyone set on a dag', argumentHint: '<dag|folder>', immediate: true },
      { name: 'dag-gate-unlock', description: 'Let the model edit the frozen dag skill and dag-gate mod for N minutes (default 30); "off" locks', argumentHint: '[minutes|off]', immediate: true },
    ] as const) {
      try {
        await $.command.register(spec)
      } catch {
        // A reloaded module registering again must not cost the session its guard.
      }
    }

    return next(e)
  })

  // --- the guard ----------------------------------------------------------
  // tool.call fires for subagents' and workflow agents' calls too (the event carries their `agentId`), so one
  // hook guards the main loop and every agent beneath it. It judges BEFORE it calls next: a refused call never
  // reaches the tool.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const command = commandOf(tool, input)
    if (command !== undefined) {
      return guardCommand($, e, next, tool, command, e.agentId)
    }
    const path = pathOf(tool, input)
    if (path !== undefined) {
      return guardPath($, e, next, tool, path, e.agentId)
    }

    return next(e)
  }).catch(($, e, next) => {
    // A guard that fails refuses what it cannot judge, but only what touches the gate's files: a bug here must
    // not take every Bash and Write call in the session down with it.
    if (next.called) {
      return next(e)
    }
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const command = commandOf(tool, input)
    const path = pathOf(tool, input)
    const isRisky = command !== undefined ? mentionsGate(command) : path !== undefined ? pathArea(path) !== undefined : false

    return isRisky
      ? { deny: `${NAME}: the guard failed while checking this ${tool} call, which touches the dag gate's files, so it is refused. ${HOUSE_RULE} Stop and tell the person.` }
      : next(e)
  })

  // --- /dag-approve --------------------------------------------------------
  on('command.run', { command: 'dag-approve' }, async ($, e) => {
    // The engine stamps `origin`: `composer` is the person's own Enter at the prompt, `bridge` their phone or
    // web client. A command the model got run arrives as anything else and is refused: a model cannot approve itself.
    const origin = personOrigin(e.origin.kind)
    if (origin === undefined) {
      return refusal($, 'dag-approve', e.origin.kind)
    }
    const parsed = parseApprove(e.args)
    if ('error' in parsed) {
      return { text: `${parsed.error} Nothing approved.` }
    }
    const home = await homeOf($)
    const found: { r: RegistryEntry; req: GateRequest }[] = []
    for (const r of await scoped($, await registry($), parsed.sel)) {
      const req = asRequest(await readJson($, `${r.dag_dir}/.dag/gates/${parsed.gate}.json`))
      if (req !== undefined && req.node === parsed.gate && req.dag === r.dag && req.dag_dir === r.dag_dir) {
        found.push({ r, req })
      }
    }
    const hits = found.filter(x => x.req.digest.slice(7).startsWith(parsed.hex))
    if (hits.length === 0) {
      return {
        text:
          found.length === 0
            ? `no job has a request at gate "${parsed.gate}"${parsed.sel === undefined ? '' : ` matching "${parsed.sel}"`}. ` +
              'A request is filed when the job runs up to its gate: run it, then type the NEXT line it prints. /dag-pending lists every open request. Nothing approved.'
            : `no request at gate "${parsed.gate}" has the hex ${parsed.hex}. On file: ` +
              `${found.map(x => `${x.req.dag} ${x.req.digest.slice(7, 13)} (${shown(x.r.dag_dir, home)})`).join('; ')}. ` +
              'The reviewed files may have changed since you read NEXT: run status in the job folder and use the NEXT line it prints now. Nothing approved.',
      }
    }
    if (hits.length > 1) {
      return {
        text:
          `${hits.length} jobs have gate "${parsed.gate}" with hex ${parsed.hex}: ${listJobs(hits.map(x => x.r), home)}. ` +
          `Name the one you mean: /dag-approve ${parsed.gate} ${parsed.hex} <dag name or folder>. Nothing approved.`,
      }
    }
    const { req } = hits[0] as { r: RegistryEntry; req: GateRequest }
    const problem = await filesProblem($, req)
    if (problem !== undefined) {
      return { text: `${problem} Nothing approved.` }
    }
    const manifest = manifestOf(req)
    if (`sha256:${await sha256(new TextEncoder().encode(manifest))}` !== req.digest || (req.manifest !== undefined && req.manifest !== manifest)) {
      return { text: `the request for ${req.node} in ${shown(req.dag_dir, home)} does not match its own manifest, so it is not as dag.py wrote it. Run the job again to file a fresh one. Nothing approved.` }
    }
    const approvalPath = `${req.dag_dir}/.dag/approvals/${req.node}.json`
    const existing = await readJson($, approvalPath)
    const runLine = `${RUNNER} --spec ${shown(req.spec ?? `${req.dag_dir}/dag.json`, home)} run`
    if (answers(existing, req) && !spent(existing, req, await readJson($, `${req.dag_dir}/.dag/state.json`))) {
      return { text: `${req.dag} / ${req.node} is already approved for ${req.digest.slice(7, 19)}, and nothing has used that approval yet. Next, anyone can run: ${runLine}` }
    }
    let at = await $.clock.now()
    const before = isObj(existing) && typeof existing.approved_at === 'string' ? Date.parse(existing.approved_at) : NaN
    if (!Number.isNaN(before) && at <= before) {
      // A new approval must differ from the one an effect already spent, or the runner would count it spent too.
      at = before + 1
    }
    await $.fs.write(approvalPath, `${JSON.stringify(approvalRecord(req, isoMs(at), origin), null, 2)}\n`)
    toast($, `${NAME}: approved ${req.dag} / ${req.node} (${req.digest.slice(7, 19)})`)

    return {
      text:
        `approved ${req.dag} / ${req.node}, digest ${req.digest.slice(7, 19)}, in ${shown(req.dag_dir, home)}. ` +
        `It covers exactly the ${req.files.length} reviewed file${req.files.length === 1 ? '' : 's'}` +
        `${req.effects.length === 0 ? '' : ` and ${req.effects.map(x => x.node).join(', ')}, once`}. /dag-revoke ${req.node} withdraws it before it is used. ` +
        `Next, anyone can run: ${runLine}`,
    }
  }).catch(() => ({ text: `/dag-approve failed before it wrote anything. Try again, or approve with dag.py approve in your own terminal.` }))

  // --- /dag-pending --------------------------------------------------------
  // Reading only, so any origin may ask.
  on('command.run', { command: 'dag-pending' }, async ($, e) => {
    const home = await homeOf($)
    const sel = str(e.args.trim())
    const lines: string[] = []
    for (const r of await scoped($, await registry($), sel)) {
      const stop = await readJson($, `${r.dag_dir}/.dag/STOP`)
      if (isObj(stop) && stop.active !== false) {
        const reason = str(stop.reason)
        lines.push(`  ${r.dag}  STOPPED${reason === undefined ? '' : `: ${reason}`}  /dag-resume ${r.dag}  (${shown(r.dag_dir, home)})`)
      }
      const gates = await attempt(() => $.fs.list(`${r.dag_dir}/.dag/gates`))
      for (const g of (gates ?? []).filter(x => x.kind === 'file' && x.name.endsWith('.json'))) {
        const req = asRequest(await readJson($, `${r.dag_dir}/.dag/gates/${g.name}`))
        if (req === undefined || req.dag !== r.dag || answers(await readJson($, `${r.dag_dir}/.dag/approvals/${req.node}.json`), req)) {
          continue
        }
        lines.push(
          `  ${r.dag}  /dag-approve ${req.node} ${req.digest.slice(7, 13)}  review: ${req.files.map(f => f.path).join(', ')}  (${shown(r.dag_dir, home)})` +
            `${req.reason === undefined ? '' : `  note: ${req.reason}`}`,
        )
      }
    }

    return {
      text:
        lines.length === 0
          ? `nothing is waiting for you${sel === undefined ? '' : ` in "${sel}"`}: no open gate request and no stop.`
          : `waiting for you\n${lines.join('\n')}\nRead the files a request lists before you type its line; /dag-approve checks they still match what was filed.`,
    }
  }).catch(() => ({ text: `/dag-pending failed to read the registry. Run dag.py status in a job folder instead.` }))

  // --- /dag-revoke ---------------------------------------------------------
  // Revoking only tightens, so any origin may do it.
  on('command.run', { command: 'dag-revoke' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(w => w !== '')
    const gate = words[0]
    if (gate === undefined || words.length > 2) {
      return { text: `the form is /dag-revoke <gate> [dag or folder]. Nothing revoked.` }
    }
    const home = await homeOf($)
    const now = await $.clock.now()
    const done: string[] = []
    for (const r of await scoped($, await registry($), words[1])) {
      const path = `${r.dag_dir}/.dag/approvals/${gate}.json`
      const existing = await readJson($, path)
      if (!isObj(existing) || existing.revoked === true) {
        continue
      }
      await $.fs.write(
        path,
        `${JSON.stringify({ format: 1, dag: r.dag, node: gate, revoked: true, revoked_at: isoMs(now), via: `dag-gate:/dag-revoke (${e.origin.kind})`, was: existing.digest ?? null }, null, 2)}\n`,
      )
      done.push(`${r.dag} (${shown(r.dag_dir, home)})`)
    }

    return {
      text:
        done.length === 0
          ? `no live approval for "${gate}"${words[1] === undefined ? '' : ` in "${words[1]}"`}. Nothing changed.`
          : `revoked ${gate} in ${done.join('; ')}. Nothing after it runs until the person approves again.`,
    }
  }).catch(() => ({ text: `/dag-revoke failed partway. Run /dag-pending to see what stands, or dag.py revoke <gate> in the job folder.` }))

  // --- /dag-stop -----------------------------------------------------------
  // Anyone may stop; stopping more than one match is the safe direction.
  on('command.run', { command: 'dag-stop' }, async ($, e) => {
    const m = /^(\S+)\s*([\s\S]*)$/.exec(e.args.trim())
    if (m === null || m[1] === undefined) {
      return { text: `the form is /dag-stop <dag or folder> [reason]. Nothing stopped.` }
    }
    const home = await homeOf($)
    const targets = await scoped($, await registry($), m[1])
    if (targets.length === 0) {
      return { text: `no registered dag matches "${m[1]}". dag.py stop in the job folder stops any job. Nothing stopped.` }
    }
    const at = isoMs(await $.clock.now())
    for (const r of targets) {
      await $.fs.write(`${r.dag_dir}/.dag/STOP`, `${JSON.stringify({ active: true, reason: (m[2] ?? '').trim(), by: `dag-gate:/dag-stop (${e.origin.kind})`, at }, null, 2)}\n`)
    }

    return { text: `stopped ${listJobs(targets, home)}. No new node starts (a node already running finishes). Only the person resumes: /dag-resume <dag>.` }
  }).catch(() => ({ text: `/dag-stop failed partway. Run dag.py stop in the job folder to be sure.` }))

  // --- /dag-resume ---------------------------------------------------------
  on('command.run', { command: 'dag-resume' }, async ($, e) => {
    const origin = personOrigin(e.origin.kind)
    if (origin === undefined) {
      return refusal($, 'dag-resume', e.origin.kind)
    }
    const sel = str(e.args.trim())
    if (sel === undefined) {
      return { text: `the form is /dag-resume <dag or folder>. Nothing resumed.` }
    }
    const home = await homeOf($)
    const targets = await scoped($, await registry($), sel)
    if (targets.length !== 1) {
      return {
        text:
          targets.length === 0
            ? `no registered dag matches "${sel}". Nothing resumed.`
            : `"${sel}" matches ${targets.length} dags: ${listJobs(targets, home)}. Name one by its folder. Nothing resumed.`,
      }
    }
    const r = targets[0] as RegistryEntry
    const path = `${r.dag_dir}/.dag/STOP`
    const stop = await readJson($, path)
    if (!isObj(stop) || stop.active === false) {
      return { text: `${r.dag} is not stopped. Nothing changed.` }
    }
    await $.fs.write(path, `${JSON.stringify({ active: false, by: `dag-gate:/dag-resume (${origin})`, at: isoMs(await $.clock.now()), cleared: stop }, null, 2)}\n`)

    return { text: `resumed ${r.dag} (${shown(r.dag_dir, home)}). The next run starts what is ready: ${RUNNER} --spec ${shown(r.spec ?? `${r.dag_dir}/dag.json`, home)} run` }
  }).catch(() => ({ text: `/dag-resume failed, so the stop stands. Try again, or run dag.py resume in your own terminal.` }))

  // --- /dag-gate-unlock ----------------------------------------------------
  on('command.run', { command: 'dag-gate-unlock' }, async ($, e) => {
    const origin = personOrigin(e.origin.kind)
    if (origin === undefined) {
      return refusal($, 'dag-gate-unlock', e.origin.kind)
    }
    const typed = e.args.trim().toLowerCase()
    if (typed === 'off' || typed === 'lock' || typed === '0') {
      await update($, unlock, () => 0)

      return { text: `locked. The dag skill, this mod and the registry are frozen again.` }
    }
    const minutes = typed === '' ? UNLOCK_DEFAULT_MIN : Number(typed)
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > UNLOCK_MAX_MIN) {
      return { text: `give whole minutes from 1 to ${UNLOCK_MAX_MIN}, or "off". Still locked.` }
    }
    const until = (await $.clock.now()) + minutes * 60_000
    await update($, unlock, () => until)

    return {
      text:
        `unlocked for ${minutes} minutes (until ${isoMs(until).slice(11, 16)} UTC). The model may edit ~/.claude/skills/dag, ` +
        'this mod and the registry in ~/.claude/dag-gate until then. .dag folders, the spent ledger, and approve and resume stay yours. ' +
        '/dag-gate-unlock off locks them now.',
    }
  }).catch(() => ({ text: `/dag-gate-unlock failed. The frozen files stay locked.` }))
}
