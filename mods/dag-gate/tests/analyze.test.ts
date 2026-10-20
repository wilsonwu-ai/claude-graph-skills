import { expect, test } from 'claude-code/testing'
import { analyze, analyzeScript, mentionsGate, pathArea } from '../hooks/analyze'
import { answers, approvalRecord, asRequest, byCodePoint, manifestOf, parseApprove, selects, spent } from '../hooks/approve'

const HOME = '/Users/me'
const CWD = '/Users/me/proj'
const RUNNER = '~/.claude/skills/dag/scripts/dag.py'

type Options = Parameters<typeof analyze>[1]
const areas = (command: string, options: Options = { cwd: CWD, home: HOME }): string[] =>
  [...new Set(analyze(command, options).findings.map(f => f.area))].sort()

/** A gate request exactly as dag.py filed it (the dag-gate-fixture job): the anchor for the manifest and digest. */
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

// ---------------------------------------------------------------------------
// person: dag.py approve and resume, in every spelling
// ---------------------------------------------------------------------------

test('dag.py approve and resume are the person\'s, however they are spelled or wrapped', () => {
  const cmds = [
    `python3 ${RUNNER} approve review`,
    `python3 ${RUNNER} --spec job/dag.json approve review`,
    `${RUNNER} --spec=job/dag.json resume`,
    'python3 dag.py appr review',
    `D=${RUNNER}; python3 $D approve review`,
    'python3 "$D" approve review',
    `bash -c "python3 ${RUNNER} approve review"`,
    "echo 'python3 dag.py approve review' | sh",
    'python3 -c "import subprocess; subprocess.run([\'python3\',\'dag.py\',\'approve\',\'review\'])"',
    'env FOO=1 python3 dag.py approve review',
    'nohup python3 dag.py approve review &',
    'timeout 5 python3 dag.py resume',
    'echo review | xargs python3 dag.py approve',
    'uv run dag.py approve review',
    'python3 dag.py $SUB review',
    'python3 -m dag approve review',
  ]
  for (const c of cmds) {
    expect(areas(c)).toContain('person')
  }
})

test('a sure person finding names the verb; a computed one is unsure', () => {
  const sure = analyze(`python3 ${RUNNER} approve review`, { cwd: CWD, home: HOME }).findings
  expect(sure.some(f => f.area === 'person' && f.sure)).toBe(true)
  const computed = analyze('python3 dag.py $SUB review', { cwd: CWD, home: HOME }).findings
  expect(computed.every(f => !f.sure)).toBe(true)
})

// ---------------------------------------------------------------------------
// state: any write into a .dag folder
// ---------------------------------------------------------------------------

test('every way of writing into a .dag folder is a state finding', () => {
  const cmds = [
    "echo '{}' > job/.dag/approvals/review.json",
    'cp /tmp/x.json job/.dag/approvals/review.json',
    'rm -rf job/.dag',
    'mv job/.dag /tmp/old',
    "sed -i '' s/a/b/ job/.dag/state.json",
    'cd job/.dag && echo x > STOP',
    'tee job/.dag/STOP < /dev/null',
    'touch job/.dag/approvals/review.json',
    'ln -sf /tmp/a job/.dag/approvals/review.json',
    'python3 -c "open(\'job/.dag/approvals/r.json\',\'w\').write(\'{}\')"',
    'find job/.dag -name "*.json" -delete',
    'rm job/.d*/approvals/*',
    'echo x > job/.DAG/STOP',
    'cat x | python3 -c "import sys; open(sys.argv[1],\'w\')" job/.dag/approvals/r.json',
    'cat x | python3 - job/.dag/approvals/r.json',
    'bash -c \'echo x > "$1"\' _ job/.dag/STOP',
    'bash script.sh job/.dag/STOP',
    'bash -s job/.dag/STOP < script.sh',
    'sort -o job/.dag/x in.txt',
    'echo x > /Users/me/proj/job/.dag/approvals/review.json',
  ]
  for (const c of cmds) {
    expect(areas(c)).toContain('state')
  }
})

// ---------------------------------------------------------------------------
// frozen: the dag skill, this mod, the registry
// ---------------------------------------------------------------------------

test('every write to the frozen dag files is a frozen finding, including removing a folder above them', () => {
  const cmds = [
    'echo x >> ~/.claude/skills/dag/SKILL.md',
    "sed -i '' 's/a/b/' ~/.claude/skills/dag/scripts/dag.py",
    'rm -rf ~/.claude/skills',
    'mv ~/.claude/local-mods/dag-gate /tmp',
    'rm ~/.claude/dag-gate/registry/*.json',
    'git -C ~/.claude/skills/dag checkout .',
    'cp /tmp/evil.py /Users/me/.claude/skills/dag/scripts/dag.py',
    'node -e "require(\'fs\').writeFileSync(process.argv[1],\'{}\')" ~/.claude/skills/dag/SKILL.md',
  ]
  for (const c of cmds) {
    expect(areas(c)).toContain('frozen')
  }
})

test('the installed mod folder is frozen too when the gate passes it in', () => {
  const options = { cwd: CWD, home: HOME, frozen: ['/opt/mods/dag-gate-copy'] }
  expect(areas('echo x > /opt/mods/dag-gate-copy/hooks/register.ts', options)).toEqual(['frozen'])
  expect(areas('cat /opt/mods/dag-gate-copy/hooks/register.ts', options)).toEqual([])
})

// ---------------------------------------------------------------------------
// the spent ledger: runner state kept outside the job folder, so an unlock never opens it
// ---------------------------------------------------------------------------

test('a write to the spent ledger, or removing a folder that holds it, is a state finding', () => {
  const cmds = [
    'rm ~/.claude/dag-gate/spent/x.jsonl',
    'echo {} >> /Users/me/.claude/dag-gate/spent/0123456789abcdef.jsonl',
    'rm -rf ~/.claude/dag-gate',
    'mv ~/.claude/dag-gate /tmp/old',
    'rm -rf ~/.claude',
    'rm -rf /Users/me',
    'cd ~/.claude/dag-gate && rm -rf spent',
    'cd ~/.claude/dag-gate && python3 tidy.py',
    'rm ~/.claude/dag-gate/*/x.jsonl',
    'rm -rf ~/.claude/dag-*',
    'find ~/.claude/dag-gate -name "*.jsonl" -delete',
    'git -C ~/.claude/dag-gate clean -fdx',
    'python3 -c "import os; os.remove(\'/Users/me/.claude/dag-gate/spent/x.jsonl\')"',
    'python3 -c "import os,shutil; shutil.rmtree(os.path.join(os.environ[\'HOME\'], \'.claude\', \'dag-gate\', \'spent\'))"',
  ]
  for (const c of cmds) {
    expect(areas(c)).toContain('state')
  }
  // A computed path in a command that names the ledger may be the ledger.
  for (const c of ['rm -rf "$(echo ~/.claude/dag-gate/spent)"', 'cd "$(dirname ~/.claude/dag-gate/spent/x)" && rm *.jsonl', 'L=$(ls -d ~/.claude/dag-gate/sp*); rm -rf "$L"']) {
    expect(areas(c)).toContain('state')
  }
  expect(areas('rm ~/.claude/dag-gate/registry/x.json')).toEqual(['frozen'])
  expect(areas('cat ~/.claude/dag-gate/spent/x.jsonl')).toEqual([])
  // The home folder holds the ledger, but a clone from there writes only its new folder.
  expect(areas('git clone https://github.com/x/y.git', { cwd: HOME, home: HOME })).toEqual([])
  expect(areas('git clone https://github.com/x/y.git ~/.claude/skills/dag', { cwd: HOME, home: HOME })).toEqual(['frozen'])
  expect(areas('git clean -fdx', { cwd: `${HOME}/.claude`, home: HOME })).toEqual(['state'])
  expect(areas('ls ~/.claude/dag-gate/spent')).toEqual([])
  expect(pathArea('/Users/me/.claude/dag-gate/spent/x.jsonl')).toBe('state')
  expect(pathArea('~/.claude/DAG-GATE/Spent')).toBe('state')
  expect(analyzeScript("import os\nos.remove(os.path.expanduser('~/.claude/dag-gate/spent/x.jsonl'))\n", 'other', 'x.py', { cwd: CWD, home: HOME }).map(f => f.area)).toContain('state')
})

test('a glob reaches the ledger by where the shell is, and a removal glob above it counts', () => {
  const inClaude = { cwd: `${HOME}/.claude`, home: HOME }
  const inGate = { cwd: `${HOME}/.claude/dag-gate`, home: HOME }
  expect(areas('rm -rf dag-gate/sp*', inClaude)).toContain('state')
  expect(areas('find s* -delete', inGate)).toContain('state')
  expect(areas('cp /dev/null s*/0123456789abcdef.jsonl', inGate)).toContain('state')
  expect(areas(': > s*/0123456789abcdef.jsonl', inGate)).toContain('state')
  expect(areas('tee s*/0123456789abcdef.jsonl < /dev/null', inGate)).toContain('state')
  expect(areas('rm -rf ~/.cl*')).toContain('state')
  expect(areas('rm -rf /*')).toContain('state')
  expect(areas('cp /tmp/evil.py skills/d*/scripts/dag.py', inClaude)).toContain('frozen')
  expect(areas('rm -rf build/*')).toEqual([])
  expect(areas('rm -rf ~/Downloads/*.tmp')).toEqual([])
})

test('a glob path in program text is read like one in the shell', () => {
  const opts = { cwd: CWD, home: HOME }
  expect(areas(`python3 -c "import glob,os; [os.remove(f) for f in glob.glob(os.path.expanduser('~/.claude/dag-g*/sp*/*.jsonl'))]"`)).toContain('state')
  expect(areas(`python3 -c "import glob; [open(f,'w') for f in glob.glob('job/.d*/approvals/*')]"`)).toContain('state')
  expect(areas(`python3 -c "import glob,os; print(glob.glob(os.path.expanduser('~/.claude/projects/*/memory/*.md')))"`)).toEqual([])
  expect(areas(`python3 -c "import re,sys; print(re.sub(r'x/.*', '', sys.argv[1]))" a/b`)).toEqual([])
  expect(analyzeScript("import glob, os\nfor f in glob.glob(os.path.expanduser('~/.claude/dag-g*/sp*/*')):\n    os.remove(f)\n", 'other', 'x.py', opts).map(f => f.area)).toContain('state')
})

test('mv takes its sources away, not its destination', () => {
  expect(areas('mv report.pdf ~/')).toEqual([])
  expect(areas('mv report.pdf ~/.claude/')).toEqual([])
  expect(areas('gmv -t ~/ a.txt b.txt')).toEqual([])
  expect(areas('mv ~/.claude /tmp/old-claude')).toContain('state')
})

test('with the shell\'s place unknown, a relative write to the ledger is a state finding', () => {
  const unknown = { cwd: null, level: 2 as const, home: HOME }
  expect(areas('rm -rf spent', unknown)).toEqual(['state'])
  expect(areas('rm dag-gate/spent/x.jsonl', unknown)).toEqual(['state'])
  expect(areas('cd dag-gate/spent && rm x.jsonl', unknown)).toEqual(['state'])
})

test('moving the gate home is a state finding: DAG_GATE_HOME set for a command, exported, or set in program text', () => {
  const cmds = [
    `DAG_GATE_HOME=/tmp/z python3 ${RUNNER} --spec job/dag.json run`,
    `env DAG_GATE_HOME=/tmp/z python3 ${RUNNER} run`,
    `export DAG_GATE_HOME=/tmp/z; python3 ${RUNNER} run`,
    `DAG_GATE_HOME=/tmp/z; export DAG_GATE_HOME; bash run.sh`,
    `DAG_GATE_HOME=$(mktemp -d) python3 ${RUNNER} run`,
    `if DAG_GATE_HOME=/tmp/z python3 ${RUNNER} run; then echo ok; fi`,
    `nohup env -i DAG_GATE_HOME=/tmp/z python3 ${RUNNER} run`,
    'python3 -c "import os,subprocess; os.environ[\'DAG_GATE_HOME\']=\'/tmp/z\'; subprocess.run([\'python3\',\'dag.py\',\'run\'])"',
  ]
  for (const c of cmds) {
    expect(areas(c)).toContain('state')
  }
  // A literal assignment, however it is wrapped, is read for certain.
  for (const c of cmds.slice(0, 7)) {
    expect(analyze(c, { cwd: CWD, home: HOME }).findings.some(f => f.area === 'state' && f.sure)).toBe(true)
  }
  // Set without an assignment word, and the runner's import path moved.
  const spelled = [
    `set -a; read DAG_GATE_HOME <<< /tmp/z; python3 ${RUNNER} --spec job/dag.json run`,
    'printf -v DAG_GATE_HOME /tmp/z; export DAG_GATE_HOME; bash run.sh',
    `export "$(echo DAG_GATE_HOME)=/tmp/z"; python3 ${RUNNER} run`,
    `PYTHONPATH=/tmp/fake python3 ${RUNNER} --spec job/dag.json run`,
    `env PYTHONHOME=/tmp/fake python3 ${RUNNER} run`,
  ]
  for (const c of spelled) {
    expect(areas(c)).toContain('state')
  }
  expect(areas(`PYTHONUNBUFFERED=1 python3 ${RUNNER} --spec job/dag.json run`)).toEqual([])
  expect(areas('PYTHONPATH=src python3 -m pytest')).toEqual([])
  expect(areas(`echo "$DAG_GATE_HOME"; python3 ${RUNNER} --spec job/dag.json status`)).toEqual([])
  expect(areas('cd ~/.claude/skills/dag && grep -rn DAG_GATE_HOME .')).toEqual([])
  expect(areas('echo $DAG_GATE_HOME')).toEqual([])
  expect(areas('grep -rn DAG_GATE_HOME ~/.claude/skills/dag')).toEqual([])
  expect(mentionsGate('DAG_GATE_HOME=/tmp/z bash run.sh')).toBe(true)
  expect(analyzeScript('import os\nos.environ["DAG_GATE_HOME"] = "/tmp/z"\n', 'other', 'x.py', { cwd: CWD, home: HOME }).map(f => f.area)).toEqual(['state'])
  expect(analyzeScript('export DAG_GATE_HOME=/tmp/z\n', 'shell', 'x.sh', { cwd: CWD, home: HOME }).map(f => f.area)).toEqual(['state'])
})

// ---------------------------------------------------------------------------
// allowed: reading the gate's files, running the runner, and ordinary work
// ---------------------------------------------------------------------------

test('reading .dag folders, running the runner\'s other commands, and ordinary commands all pass', () => {
  const cmds = [
    'cat job/.dag/state.json',
    'ls -la job/.dag',
    'jq . job/.dag/gates/review.json',
    `python3 ${RUNNER} --spec job/dag.json status`,
    `python3 ${RUNNER} --spec job/dag.json run`,
    `python3 ${RUNNER} --spec job/dag.json run --dry-run`,
    `python3 ${RUNNER} --spec job/dag.json why deploy`,
    `python3 ${RUNNER} --spec job/dag.json revoke review`,
    `python3 ${RUNNER} --spec job/dag.json stop`,
    'python3 ~/.claude/skills/dag/tests/test_dag.py',
    'grep -r approve job/.dag',
    'cat ~/.claude/skills/dag/SKILL.md',
    'cp ~/.claude/skills/dag/SKILL.md /tmp/x',
    'sort -o out.txt job/.dag/events.jsonl',
    'git status',
    'npm test',
    'rm -rf node_modules',
    "sed -i '' s/a/b/ README.md",
    'mkdir -p build && cd build && cmake ..',
    "find . -name '*.pyc' -delete",
    'curl -s https://example.com | jq .',
    'python3 -c "print(1)"',
    'python3 -c "print(1)" README.md',
    'node -e "console.log(1)"',
    'bash -c "echo hi"',
    'bash -c "echo hi" _ notes.txt',
    'bash build.sh --out dist',
    'echo "print(1)" | python3 -',
    'tmux ls',
    'ssh host uptime',
    'echo approve the PR',
    'git commit -m "resume work on dag skill"',
    'python3 script.py --resume',
    'cd /tmp && echo x > STOP',
    'echo hi > approvals/x.json',
  ]
  for (const c of cmds) {
    expect(analyze(c, { cwd: CWD, home: HOME }).findings).toEqual([])
  }
})

// ---------------------------------------------------------------------------
// where the shell sits
// ---------------------------------------------------------------------------

test('a cd into a .dag folder is allowed, and the analysis says where the shell ends up', () => {
  const a = analyze('cd job/.dag', { cwd: CWD, home: HOME })
  expect(a.findings).toEqual([])
  expect(a.endLevel).toBe(1)
  expect(a.endArea).toBe('state')
  expect(a.endCwd).toBe('/Users/me/proj/job/.dag')
})

test('relative writes from inside a .dag folder are state findings; leaving it clears that', () => {
  const inside = { cwd: '/Users/me/proj/job/.dag', home: HOME }
  expect(areas('echo x > STOP', inside)).toEqual(['state'])
  expect(areas('cp /tmp/a approvals/review.json', inside)).toEqual(['state'])
  expect(areas('cat state.json', inside)).toEqual([])
  const out = analyze('cd /tmp', inside)
  expect(out.endLevel).toBe(0)
  expect(areas('cd /tmp && echo x > STOP', inside)).toEqual([])
})

test('with the shell\'s place unknown, only names the runner writes are caught', () => {
  const unknown = { cwd: null, level: 2 as const, home: HOME }
  expect(areas('echo x > approvals/review.json', unknown)).toEqual(['state'])
  expect(areas('echo x > STOP', unknown)).toEqual(['state'])
  expect(areas('echo x > notes.txt', unknown)).toEqual([])
})

// ---------------------------------------------------------------------------
// scripts
// ---------------------------------------------------------------------------

test('a script a command runs is queued for the gate to read, and a script this command writes comes inline', () => {
  const a = analyze('bash deploy.sh', { cwd: CWD, home: HOME })
  expect(a.scripts).toEqual([{ path: '/Users/me/proj/deploy.sh', kind: 'shell' }])
  const b = analyze("cat > /tmp/x.sh <<'EOF'\npython3 dag.py approve review\nEOF\nbash /tmp/x.sh", { cwd: CWD, home: HOME })
  expect(b.scripts[0]?.inline).toContain('approve review')
})

test('the runner and its tests are never queued: they live in the frozen skill', () => {
  expect(analyze(`python3 ${RUNNER} status`, { cwd: CWD, home: HOME }).scripts).toEqual([])
  expect(analyze('python3 ~/.claude/skills/dag/tests/test_dag.py', { cwd: CWD, home: HOME }).scripts).toEqual([])
})

test('script text is read for approve, .dag writes and frozen writes', () => {
  const opts = { cwd: CWD, home: HOME }
  expect(analyzeScript('echo {} > job/.dag/approvals/review.json\n', 'shell', 'x.sh', opts).map(f => f.area)).toEqual(['state'])
  expect(analyzeScript('import subprocess\nsubprocess.run(["python3", "dag.py", "approve", "review"])\n', 'other', 'x.py', opts).map(f => f.area)).toEqual(['person'])
  expect(analyzeScript("p = '.' + 'dag'\nopen(p + '/STOP', 'w')\n", 'other', 'x.py', opts).map(f => f.area)).toEqual(['state'])
  expect(analyzeScript('print("hello")\n', 'other', 'x.py', opts)).toEqual([])
  expect(analyzeScript('python3 dag.py status\n', 'shell', 'x.sh', opts)).toEqual([])
  expect(analyzeScript('x\n', 'shell', 'x.sh', opts).every(f => !f.sure)).toBe(true)
})

// ---------------------------------------------------------------------------
// path tools and the cheap check
// ---------------------------------------------------------------------------

test('a Write-class path is judged by its spelling, case-insensitively', () => {
  expect(pathArea('/Users/me/proj/job/.dag/approvals/review.json')).toBe('state')
  expect(pathArea('/Users/me/proj/JOB/.DAG/STOP')).toBe('state')
  expect(pathArea('~/.claude/skills/dag/SKILL.md')).toBe('frozen')
  expect(pathArea('/Users/me/.claude/dag-gate/registry/x.json')).toBe('frozen')
  expect(pathArea('/Users/me/.claude/local-mods/dag-gate/hooks/register.ts')).toBe('frozen')
  expect(pathArea('/opt/mods/x/hooks/register.ts', ['/opt/mods/x'])).toBe('frozen')
  expect(pathArea('/Users/me/proj/notes/dag.md')).toBeUndefined()
  expect(pathArea('/Users/me/proj/x.dagger/y')).toBeUndefined()
  expect(pathArea('/Users/me/.claude/skills/dagger/SKILL.md')).toBeUndefined()
})

test('mentionsGate is true only for text about the gate', () => {
  expect(mentionsGate('cat job/.dag/state.json')).toBe(true)
  expect(mentionsGate(`python3 ${RUNNER} status`)).toBe(true)
  expect(mentionsGate('ls ~/.claude/skills/dag')).toBe(true)
  expect(mentionsGate('git status')).toBe(false)
})

// ---------------------------------------------------------------------------
// approve.ts: the pure half of /dag-approve
// ---------------------------------------------------------------------------

test('parseApprove reads gate, hex and an optional selector, and refuses anything else', () => {
  expect(parseApprove('review f94adb')).toEqual({ gate: 'review', hex: 'f94adb' })
  expect(parseApprove(' review  F94ADB  promo ')).toEqual({ gate: 'review', hex: 'f94adb', sel: 'promo' })
  expect(parseApprove('review sha256:f94adb7d')).toEqual({ gate: 'review', hex: 'f94adb7d' })
  expect(parseApprove("'review' 'f94adb'")).toEqual({ gate: 'review', hex: 'f94adb' })
  for (const bad of ['', 'review', 'review f94adb a b', 'rev/iew f94adb', 'review f94a', 'review zz94adb']) {
    expect('error' in parseApprove(bad)).toBe(true)
  }
})

test('the manifest rebuilt from the request is byte for byte what dag.py hashed', () => {
  const req = asRequest(REQUEST)
  expect(req).toBeDefined()
  expect(manifestOf(req as NonNullable<typeof req>)).toBe(REQUEST.manifest)
})

test('the manifest sorts paths by code point, as Python does, not by UTF-16 unit', () => {
  const names = ['b', 'a', '\u{1F600}', '￿']
  expect([...names].sort(byCodePoint)).toEqual(['a', 'b', '￿', '\u{1F600}'])
  expect([...names].sort()).not.toEqual(['a', 'b', '￿', '\u{1F600}'])
})

test('asRequest keeps only what dag.py would have written', () => {
  const req = asRequest(REQUEST)
  expect(req?.not_before).toBeUndefined()
  expect(asRequest({ ...REQUEST, dag_dir: 'relative/job' })).toBeUndefined()
  expect(asRequest({ ...REQUEST, digest: 'sha256:abc' })).toBeUndefined()
  expect(asRequest({ ...REQUEST, files: [{ path: 'x', sha256: 'nothex' }] })).toBeUndefined()
  expect(asRequest({ ...REQUEST, effects: 'deploy' })).toBeUndefined()
  expect(asRequest(null)).toBeUndefined()
})

test('an approval answers its request only from an accepted writer, unrevoked, for the same digest, after not_before', () => {
  const req = asRequest(REQUEST) as NonNullable<ReturnType<typeof asRequest>>
  const rec = approvalRecord(req, '2026-10-20T13:00:00.000Z', 'composer')
  expect(rec.via).toBe('dag-gate:/dag-approve (composer)')
  expect(answers(rec, req)).toBe(true)
  expect(answers({ ...rec, via: 'dag.py approve (tty)' }, req)).toBe(true)
  expect(answers({ ...rec, via: 'model' }, req)).toBe(false)
  expect(answers({ ...rec, revoked: true }, req)).toBe(false)
  expect(answers({ ...rec, digest: `sha256:${'0'.repeat(64)}` }, req)).toBe(false)
  expect(answers({ ...rec, approved_at: 'yesterday' }, req)).toBe(false)
  expect(answers(rec, { ...req, not_before: '2026-10-20T14:00:00.000Z' })).toBe(false)
  expect(answers(rec, { ...req, not_before: '2026-10-20T12:00:00.000Z' })).toBe(true)
})

test('an approval is spent once state.json records an effect that used it', () => {
  const req = asRequest(REQUEST) as NonNullable<ReturnType<typeof asRequest>>
  const rec = approvalRecord(req, '2026-10-20T13:00:00.000Z', 'bridge')
  const used = { spent: [{ gate: 'review', by: 'deploy', digest: req.digest, approved_at: '2026-10-20T13:00:00.000Z', at: '2026-10-20T13:01:00.000Z' }] }
  expect(spent(rec, req, used)).toBe(true)
  expect(spent(rec, req, { spent: [] })).toBe(false)
  expect(spent({ ...rec, approved_at: '2026-10-20T13:05:00.000Z' }, req, used)).toBe(false)
})

test('a selector names a job by dag, folder, folder tail or real path', () => {
  const r = { dag: 'promo', dag_dir: '/Users/me/jobs/promo-job' }
  expect(selects(r, 'promo')).toBe(true)
  expect(selects(r, '/Users/me/jobs/promo-job/')).toBe(true)
  expect(selects(r, 'promo-job')).toBe(true)
  expect(selects(r, './jobs/promo-job')).toBe(true)
  expect(selects(r, '/private/link', '/Users/me/jobs/promo-job')).toBe(true)
  expect(selects(r, 'other')).toBe(false)
  expect(selects(r, 'job')).toBe(false)
})
