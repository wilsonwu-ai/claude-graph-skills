import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const NOW = 1_800_000_000_000
const MIN = 60_000
const HOME = '/Users/someone'
const PROJ = '/Users/someone/proj'
const RUNNER = 'python3 ~/.claude/skills/dag/scripts/dag.py'
const PRESENTATION = { isFullscreen: false, columns: 100 } as const

/**
 * The anchor: a gate request exactly as dag.py filed it for the dag-gate-fixture job, and the bytes of the two
 * files it names. /dag-approve must re-hash these bytes and rebuild this manifest to the same digest, or refuse.
 */
const REQUEST = {
  approver: 'Sam',
  dag: 'promo',
  dag_dir: '/tmp/dag-gate-fixture/job',
  digest: 'sha256:f94adb7d0ca3742705bf1adea91e4fd55c56179a64bb91bb21a1fc2a01f0ac0e',
  effects: [{ fingerprint: 'ecc801a99fa40ed595d947d7038ee17fac95f4fccdb7c392d1cb027f2c0c457f', node: 'deploy' }],
  files: [
    { path: 'deploy.sh', sha256: '432e6e546534e434dfa8b9c008a3d66594ab33dda8aedaec1c8c0b16dcaa70a0' },
    { path: 'out/index.json', sha256: '7f8ff6801195b30307ce2a315d1255e26824cb0ba001da13c5b5d3b5d3da30a2' },
  ],
  format: 1,
  manifest:
    'dag-gate/1\ndag promo\nnode review\nfile 432e6e546534e434dfa8b9c008a3d66594ab33dda8aedaec1c8c0b16dcaa70a0 deploy.sh\n' +
    'file 7f8ff6801195b30307ce2a315d1255e26824cb0ba001da13c5b5d3b5d3da30a2 out/index.json\n' +
    'effect deploy ecc801a99fa40ed595d947d7038ee17fac95f4fccdb7c392d1cb027f2c0c457f\n',
  node: 'review',
  not_before: null,
  reason: null,
  requested_at: '2026-10-20T12:30:21.269Z',
  spec: '/tmp/dag-gate-fixture/job/dag.json',
  summary: 'The index that goes live.',
}
const FILES: Record<string, string> = {
  'deploy.sh': '#!/bin/sh\nmkdir -p live && cp out/index.json live/index.json\n',
  'out/index.json': '[{"file": "a.md", "title": "Alpha"}, {"file": "b.md", "title": "Beta"}]\n',
}
const DIR = REQUEST.dag_dir
const REGISTRY = `${HOME}/.claude/dag-gate/registry`
const APPROVAL = `${DIR}/.dag/approvals/review.json`

type World = {
  /** Every tool call that got through the guard to the tool. */
  reached: string[]
  toasts: string[]
  registered: string[]
  /** The disk, by absolute path; writes land here too. */
  files: Record<string, string>
  writes: { path: string; text: string }[]
  /** `realPath` answers by path, for the symlink case. */
  real: Record<string, string>
  clock: ReturnType<typeof mock.clock>
}

/** Lay a job down as dag.py leaves it: the registry entry, the gate request, and the files the request names. */
const job = (files: Record<string, string>, dir: string, id: string): void => {
  files[`${REGISTRY}/${id}.json`] = JSON.stringify({ dag: REQUEST.dag, dag_dir: dir, format: 1, spec: `${dir}/dag.json` })
  files[`${dir}/.dag/gates/review.json`] = JSON.stringify({ ...REQUEST, dag_dir: dir, spec: `${dir}/dag.json` })
  files[`${dir}/.dag/events.jsonl`] = ''
  for (const [p, text] of Object.entries(FILES)) {
    files[`${dir}/${p}`] = text
  }
}

/** The engine beneath the plugin: a disk, a clock, a home, and a record of what reached the tool. */
const world = (on: On, options: { isClockMocked?: boolean } = {}): World => {
  const seen: World = {
    reached: [],
    toasts: [],
    registered: [],
    files: {},
    writes: [],
    real: {},
    clock: (options.isClockMocked === false ? undefined : mock.clock(on, { now: NOW })) as ReturnType<typeof mock.clock>,
  }
  job(seen.files, DIR, '42ef4456e66db8d5')
  mock.env(on, { HOME })
  on('session.cwd', () => ({ value: PROJ }) as never)
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    seen.reached.push(`${String(e.tool)}:${String(input.command ?? input.file_path ?? input.notebook_path ?? '')}`)

    return { result: 'ok', text: 'ok' } as never
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('command.register', (_$, e) => {
    seen.registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('fs.read', (_$, e) => {
    const text = seen.files[e.path]
    if (text === undefined) {
      return { deny: `ENOENT ${e.path}` }
    }

    return { value: e.as === 'bytes' ? { base64: btoa(text) } : text }
  })
  on('fs.write', (_$, e) => {
    seen.writes.push({ path: e.path, text: e.text })
    seen.files[e.path] = e.text

    return { value: undefined }
  })
  on('fs.list', (_$, e) => {
    const prefix = `${e.path.replace(/\/+$/, '')}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of Object.keys(seen.files)) {
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length)
        const cut = rest.indexOf('/')
        names.set(cut === -1 ? rest : rest.slice(0, cut), cut === -1 ? 'file' : 'dir')
      }
    }
    if (names.size === 0) {
      return { deny: `ENOENT ${e.path}` }
    }

    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('fs.exists', (_$, e) => ({ value: Object.keys(seen.files).some(p => p === e.path || p.startsWith(`${e.path}/`)) }))
  on('fs.stat', (_$, e) => {
    const real = seen.real[e.path]
    if (real === undefined) {
      return { deny: `ENOENT ${e.path}` }
    }

    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: true, realPath: real } }
  })

  return seen
}

type Out = { deny?: string; result?: unknown }

const bash = ($: Engine, command: string, agentId?: string): Promise<Out> =>
  $.tool.call({ tool: 'Bash', command, ...(agentId === undefined ? {} : { agentId }) } as never) as never
const tool = ($: Engine, name: string, input: Record<string, unknown>): Promise<Out> => $.tool.call({ tool: name, ...input } as never) as never

type Origin = { kind: string }
const slash = ($: Engine, command: string, args: string, origin: Origin = { kind: 'composer' }): Promise<{ text?: string }> =>
  $.command.run({ command, args, origin, presentation: PRESENTATION } as never) as never

const denied = (out: Out): boolean => typeof out.deny === 'string'
const approvalIn = (seen: World, dir = DIR): Record<string, unknown> => JSON.parse(seen.files[`${dir}/.dag/approvals/review.json`] ?? 'null') as Record<string, unknown>
const editSkill = ($: Engine, agentId?: string): Promise<Out> =>
  tool($, 'Edit', { file_path: `${HOME}/.claude/skills/dag/SKILL.md`, old_string: 'a', new_string: 'b', ...(agentId === undefined ? {} : { agentId }) })

// ---------------------------------------------------------------------------
// The guard: person-only commands, .dag folders, frozen files
// ---------------------------------------------------------------------------

test('dag.py approve never reaches the tool, and the model is told the rule, the person\'s command, and to stop', async ($, on) => {
  const seen = world(on)
  const out = await bash($, `${RUNNER} --spec job/dag.json approve review`)
  expect(denied(out)).toBe(true)
  expect(seen.reached).toHaveLength(0)
  const msg = out.deny as string
  expect(msg).toContain('House rule')
  expect(msg).toContain('/dag-approve <gate> <hex>')
  expect(msg).toContain('NEXT line')
  expect(msg).toContain('STOP')
  expect(msg).toContain('Do not retry')
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toContain('dag-gate blocked the model')
})

test('the runner\'s other commands, reading a .dag folder and ordinary work pass untouched, with no toast', async ($, on) => {
  const seen = world(on)
  const cmds = [`${RUNNER} --spec job/dag.json status`, `${RUNNER} --spec job/dag.json run`, 'cat job/.dag/state.json', 'git status']
  for (const c of cmds) {
    expect(denied(await bash($, c))).toBe(false)
  }
  expect(seen.reached).toEqual(cmds.map(c => `Bash:${c}`))
  expect(seen.toasts).toHaveLength(0)
})

test('Write and Edit into a .dag folder, the skill or the registry are refused; elsewhere they pass', async ($, on) => {
  const seen = world(on)
  expect(denied(await tool($, 'Write', { file_path: APPROVAL, content: '{}' }))).toBe(true)
  const frozen = await editSkill($)
  expect(frozen.deny).toContain('/dag-gate-unlock')
  expect(denied(await tool($, 'Write', { file_path: `${REGISTRY}/x.json`, content: '{}' }))).toBe(true)
  expect(denied(await tool($, 'MultiEdit', { file_path: `${DIR}/.dag/STOP`, edits: [] }))).toBe(true)
  expect(denied(await tool($, 'Write', { file_path: `${PROJ}/notes.md`, content: 'x' }))).toBe(false)
  expect(seen.reached).toEqual([`Write:${PROJ}/notes.md`])
  expect(seen.toasts).toHaveLength(4)
})

test('a path that lands in a .dag folder only through a link is refused, and the message says where it lands', async ($, on) => {
  const seen = world(on)
  seen.real[`${PROJ}/link.json`] = APPROVAL
  const out = await tool($, 'Write', { file_path: `${PROJ}/link.json`, content: '{}' })
  expect(out.deny).toContain(`it lands in ${APPROVAL}`)
  seen.real[`${PROJ}/linkdir`] = `${DIR}/.dag/approvals`
  expect(denied(await tool($, 'Write', { file_path: `${PROJ}/linkdir/review.json`, content: '{}' }))).toBe(true)
  expect(seen.reached).toHaveLength(0)
})

test('a cd into a .dag folder is remembered: the next call\'s relative write is refused until the shell leaves', async ($, on) => {
  const seen = world(on)
  expect(denied(await bash($, 'cd job/.dag'))).toBe(false)
  const out = await bash($, 'echo x > STOP')
  expect(denied(out)).toBe(true)
  expect(out.deny).toContain('cd /tmp')
  expect(denied(await bash($, 'cat state.json'))).toBe(false)
  expect(denied(await bash($, 'cd /tmp'))).toBe(false)
  expect(denied(await bash($, 'echo x > STOP'))).toBe(false)
  expect(seen.reached).toEqual(['Bash:cd job/.dag', 'Bash:cat state.json', 'Bash:cd /tmp', 'Bash:echo x > STOP'])
})

test('each loop keeps its own shell place, and a subagent is guarded like the main loop', async ($, on) => {
  const seen = world(on)
  await bash($, 'cd job/.dag')
  expect(denied(await bash($, 'echo x > STOP', 'agent-1'))).toBe(false)
  expect(denied(await bash($, 'echo x > STOP'))).toBe(true)
  expect(denied(await bash($, `${RUNNER} approve review`, 'agent-1'))).toBe(true)
  expect(seen.toasts.some(t => t.includes('blocked a subagent'))).toBe(true)
})

test('a script the command runs is read: one that runs dag.py approve is refused, a harmless one runs', async ($, on) => {
  const seen = world(on)
  seen.files[`${PROJ}/go.sh`] = '#!/bin/sh\npython3 ~/.claude/skills/dag/scripts/dag.py approve review\n'
  seen.files[`${PROJ}/ok.sh`] = '#!/bin/sh\necho hello\n'
  expect(denied(await bash($, 'bash go.sh'))).toBe(true)
  expect(denied(await bash($, "printf 'python3 dag.py approve review' > /tmp/x.sh && sh /tmp/x.sh"))).toBe(true)
  expect(denied(await bash($, 'bash ok.sh'))).toBe(false)
  expect(seen.reached).toEqual(['Bash:bash ok.sh'])
})

test('if the guard itself fails, a command about the gate is refused and an ordinary one still runs', async ($, on) => {
  const seen = world(on, { isClockMocked: false })
  // A clock that throws makes the verdict impossible once a frozen finding needs the unlock time.
  on('clock.now', () => {
    throw new Error('clock down')
  })
  const out = await bash($, 'echo x >> ~/.claude/skills/dag/SKILL.md')
  expect(out.deny).toContain('the guard failed')
  expect(denied(await bash($, 'git status'))).toBe(false)
  expect(denied(await tool($, 'Write', { file_path: '/tmp/x', content: 'x' }))).toBe(false)
  expect(seen.reached).toEqual(['Bash:git status', 'Write:/tmp/x'])
})

// ---------------------------------------------------------------------------
// /dag-approve: the person's side of the gate
// ---------------------------------------------------------------------------

test('/dag-approve typed by the person writes the approval dag.py reads: this digest, these files, this effect, now', async ($, on) => {
  const seen = world(on)
  const out = await slash($, 'dag-approve', 'review f94adb')
  expect(out.text).toContain('approved promo / review')
  expect(out.text).toContain(`${RUNNER} --spec ${REQUEST.spec} run`)
  expect(seen.writes.map(w => w.path)).toEqual([APPROVAL])
  expect(approvalIn(seen)).toEqual({
    format: 1,
    dag: 'promo',
    node: 'review',
    digest: REQUEST.digest,
    files: REQUEST.files,
    effects: REQUEST.effects,
    approved_at: new Date(NOW).toISOString(),
    via: 'dag-gate:/dag-approve (composer)',
    requested_at: REQUEST.requested_at,
    dag_dir: DIR,
  })
  expect(seen.toasts.some(t => t.includes('approved promo / review'))).toBe(true)
})

test('the person\'s phone or web client counts as the person', async ($, on) => {
  const seen = world(on)
  await slash($, 'dag-approve', 'review F94ADB')
  await slash($, 'dag-revoke', 'review')
  await slash($, 'dag-approve', 'review f94adb', { kind: 'bridge' })
  expect(approvalIn(seen).via).toBe('dag-gate:/dag-approve (bridge)')
})

test('approve, resume and unlock run by anything but the person are refused, change nothing, and raise a toast', async ($, on) => {
  const seen = world(on)
  for (const kind of ['plugin', 'unclassified']) {
    for (const [command, args] of [['dag-approve', 'review f94adb'], ['dag-resume', 'promo'], ['dag-gate-unlock', '30']] as const) {
      expect((await slash($, command, args, { kind })).text).toContain('refused')
    }
  }
  expect(seen.writes).toHaveLength(0)
  expect(seen.toasts).toHaveLength(6)
  expect(denied(await editSkill($))).toBe(true)
})

test('a reviewed file that changed, or went missing, after the request was filed is not approved', async ($, on) => {
  const seen = world(on)
  seen.files[`${DIR}/out/index.json`] = '[]\n'
  const changed = await slash($, 'dag-approve', 'review f94adb')
  expect(changed.text).toContain('changed after the request was filed')
  expect(changed.text).toContain('Nothing approved')
  delete seen.files[`${DIR}/out/index.json`]
  expect((await slash($, 'dag-approve', 'review f94adb')).text).toContain('cannot be read')
  expect(seen.writes).toHaveLength(0)
})

test('a hex that matches no request, or a gate with none, approves nothing and says what is on file', async ($, on) => {
  const seen = world(on)
  const wrong = await slash($, 'dag-approve', 'review abcdef')
  expect(wrong.text).toContain('f94adb')
  expect(wrong.text).toContain('Nothing approved')
  expect((await slash($, 'dag-approve', 'publish f94adb')).text).toContain('no job has a request at gate "publish"')
  expect((await slash($, 'dag-approve', 'review')).text).toContain('/dag-approve <gate> <hex>')
  expect(seen.writes).toHaveLength(0)
})

test('a request edited after dag.py filed it fails its own digest and is not approved', async ($, on) => {
  const seen = world(on)
  const gate = `${DIR}/.dag/gates/review.json`
  seen.files[gate] = JSON.stringify({ ...REQUEST, effects: [{ node: 'deploy', fingerprint: '0'.repeat(64) }] })
  expect((await slash($, 'dag-approve', 'review f94adb')).text).toContain('does not match its own manifest')
  seen.files[gate] = JSON.stringify({ ...REQUEST, manifest: 'dag-gate/1\n' })
  expect((await slash($, 'dag-approve', 'review f94adb')).text).toContain('does not match its own manifest')
  seen.files[gate] = JSON.stringify({ ...REQUEST, dag: 'other' })
  expect((await slash($, 'dag-approve', 'review f94adb')).text).toContain('no job has a request')
  expect(seen.writes).toHaveLength(0)
})

test('approving twice writes once: the second answer says the approval stands, unused', async ($, on) => {
  const seen = world(on)
  await slash($, 'dag-approve', 'review f94adb')
  const again = await slash($, 'dag-approve', 'review f94adb')
  expect(again.text).toContain('already approved')
  expect(seen.writes).toHaveLength(1)
})

test('once an effect spent the approval, approving again writes a newer one, even when the clock has not moved', async ($, on) => {
  const seen = world(on)
  await slash($, 'dag-approve', 'review f94adb')
  const first = approvalIn(seen)
  seen.files[`${DIR}/.dag/state.json`] = JSON.stringify({
    spent: [{ gate: 'review', by: 'deploy', digest: REQUEST.digest, approved_at: first.approved_at, at: first.approved_at }],
  })
  expect((await slash($, 'dag-approve', 'review f94adb')).text).toContain('approved promo / review')
  expect(Date.parse(approvalIn(seen).approved_at as string)).toBe(NOW + 1)
  expect(seen.writes).toHaveLength(2)
})

test('two jobs with the same gate and hex: the person names one, and only that one is approved', async ($, on) => {
  const seen = world(on)
  const other = `${HOME}/jobs/promo-copy`
  job(seen.files, other, 'r2')
  const both = await slash($, 'dag-approve', 'review f94adb')
  expect(both.text).toContain('Name the one you mean')
  expect(seen.writes).toHaveLength(0)
  expect((await slash($, 'dag-approve', 'review f94adb promo-copy')).text).toContain('in ~/jobs/promo-copy')
  expect(seen.writes.map(w => w.path)).toEqual([`${other}/.dag/approvals/review.json`])
})

test('an approval copied in with its folder does not count there: the copy stays pending until approved on its own', async ($, on) => {
  const seen = world(on)
  await slash($, 'dag-approve', 'review f94adb')
  // `cp -R job promo-copy`: the approval rides along and still names the first folder, which dag.py refuses.
  const copy = `${HOME}/jobs/promo-copy`
  job(seen.files, copy, 'r2')
  seen.files[`${copy}/.dag/approvals/review.json`] = seen.files[APPROVAL] as string
  expect((await slash($, 'dag-pending', 'promo-copy')).text).toContain('/dag-approve review f94adb')
  const out = await slash($, 'dag-approve', 'review f94adb promo-copy')
  expect(out.text).toContain('approved promo / review')
  expect(approvalIn(seen, copy).dag_dir).toBe(copy)
  expect(approvalIn(seen).dag_dir).toBe(DIR)
  expect(seen.writes.map(w => w.path)).toEqual([APPROVAL, `${copy}/.dag/approvals/review.json`])
})

// ---------------------------------------------------------------------------
// /dag-pending, /dag-revoke, /dag-stop, /dag-resume, /dag-gate-unlock
// ---------------------------------------------------------------------------

test('/dag-pending lists the open request with the exact line to type, skips folders that are gone, and clears once approved', async ($, on) => {
  const seen = world(on)
  seen.files[`${REGISTRY}/gone.json`] = JSON.stringify({ dag: 'old', dag_dir: `${HOME}/gone` })
  const out = await slash($, 'dag-pending', '', { kind: 'plugin' })
  expect(out.text).toContain('/dag-approve review f94adb')
  expect(out.text).toContain('review: deploy.sh, out/index.json')
  expect(out.text).not.toContain('old')
  await slash($, 'dag-approve', 'review f94adb')
  expect((await slash($, 'dag-pending', '')).text).toContain('nothing is waiting')
})

test('/dag-revoke from any origin withdraws the approval, and the request is pending again', async ($, on) => {
  const seen = world(on)
  await slash($, 'dag-approve', 'review f94adb')
  expect((await slash($, 'dag-revoke', 'review', { kind: 'plugin' })).text).toContain('revoked review')
  expect(approvalIn(seen).revoked).toBe(true)
  expect((await slash($, 'dag-pending', '')).text).toContain('/dag-approve review f94adb')
  expect((await slash($, 'dag-revoke', 'review')).text).toContain('Nothing changed')
})

test('/dag-stop from any origin stops the job; only the person resumes it', async ($, on) => {
  const seen = world(on)
  const stop = await slash($, 'dag-stop', 'promo deploy looks wrong', { kind: 'plugin' })
  expect(stop.text).toContain('stopped promo')
  expect(JSON.parse(seen.files[`${DIR}/.dag/STOP`] as string)).toMatchObject({ active: true, reason: 'deploy looks wrong' })
  expect((await slash($, 'dag-pending', '')).text).toContain('STOPPED: deploy looks wrong')
  expect((await slash($, 'dag-resume', 'promo', { kind: 'plugin' })).text).toContain('refused')
  expect((await slash($, 'dag-resume', 'promo')).text).toContain('resumed promo')
  expect(JSON.parse(seen.files[`${DIR}/.dag/STOP`] as string).active).toBe(false)
  expect((await slash($, 'dag-resume', 'promo')).text).toContain('is not stopped')
  expect((await slash($, 'dag-stop', 'nosuchjob')).text).toContain('Nothing stopped')
})

test('/dag-gate-unlock opens the frozen files for the minutes given, to subagents too, never .dag folders or approve, and locks on time', async ($, on) => {
  const seen = world(on)
  expect(denied(await editSkill($))).toBe(true)
  expect(denied(await editSkill($, 'agent-1'))).toBe(true)
  const opened = (await slash($, 'dag-gate-unlock', '30')).text
  expect(opened).toContain('unlocked for 30 minutes')
  expect(opened).toContain('the spent ledger')
  expect(denied(await editSkill($))).toBe(false)
  expect(denied(await editSkill($, 'agent-1'))).toBe(false)
  expect(denied(await bash($, 'echo x >> ~/.claude/skills/dag/SKILL.md'))).toBe(false)
  expect(denied(await tool($, 'Write', { file_path: APPROVAL, content: '{}' }))).toBe(true)
  expect(denied(await bash($, `${RUNNER} approve review`))).toBe(true)
  expect(denied(await bash($, `${RUNNER} approve review`, 'agent-1'))).toBe(true)
  // The spent ledger is the runner's state, as a .dag folder is: no unlock opens it, and none moves the gate home.
  expect(denied(await bash($, 'rm ~/.claude/dag-gate/spent/x.jsonl'))).toBe(true)
  expect(denied(await bash($, 'rm -rf ~/.claude/dag-gate', 'agent-1'))).toBe(true)
  expect(denied(await tool($, 'Write', { file_path: `${HOME}/.claude/dag-gate/spent/x.jsonl`, content: '' }))).toBe(true)
  expect(denied(await bash($, `DAG_GATE_HOME=/tmp/z ${RUNNER} --spec job/dag.json run`))).toBe(true)
  expect(denied(await tool($, 'Write', { file_path: `${REGISTRY}/x.json`, content: '{}' }))).toBe(false)
  // The shell's place carries across calls: a glob there that reaches the ledger is refused too.
  expect(denied(await bash($, 'cd ~/.claude'))).toBe(false)
  expect(denied(await bash($, 'rm -rf dag-gate/sp*'))).toBe(true)
  expect(denied(await bash($, 'cd /tmp'))).toBe(false)
  await seen.clock.advance(31 * MIN)
  expect(denied(await editSkill($))).toBe(true)
  expect(denied(await editSkill($, 'agent-1'))).toBe(true)
  await slash($, 'dag-gate-unlock', '')
  expect(denied(await editSkill($))).toBe(false)
  expect((await slash($, 'dag-gate-unlock', 'off')).text).toContain('locked')
  expect(denied(await editSkill($))).toBe(true)
  expect((await slash($, 'dag-gate-unlock', '999')).text).toContain('whole minutes from 1 to 240')
})

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('the six commands are registered at session start', async ($, on) => {
  const seen = world(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  expect([...seen.registered].sort()).toEqual(['dag-approve', 'dag-gate-unlock', 'dag-pending', 'dag-resume', 'dag-revoke', 'dag-stop'])
})
