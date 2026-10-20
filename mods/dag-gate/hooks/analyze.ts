/**
 * A small, fail-closed shell reader, forked from launchd-gate's (the tokenizer is the same code). Pure: no `$`,
 * so the hooks and the tests share it.
 *
 * It is not a shell. It reads a command string far enough to answer one question: could this command write a
 * dag runner's state, change the frozen dag files, or run a person-only dag.py command? A command that names
 * any of them and cannot be proven harmless is a finding.
 *
 * Findings, by area:
 *   person  dag.py approve or resume: the person's commands, never the model's
 *   state   a write into a `.dag` folder (approvals, the stop flag, state, gate requests, receipts) or the spent ledger,
 *           or moving the gate home that holds the ledger
 *   frozen  a write into the dag skill, this mod or the folder registry (the person can unlock these for a while)
 * `sure` is false when the reader could not tell for certain: a computed path, inline code, an unknown program.
 */

/** A `.dag` directory segment: a runner's state. Case-insensitive, as macOS is. */
export const STATE_RE = /(^|\/)\.dag(\/|$)/i
/** The rules a model under pressure would bend: the skill, this mod, and the registry /dag-approve reads. */
export const FROZEN_RE = /(^|\/)\.claude\/(skills\/dag|local-mods\/dag-gate|dag-gate)(\/|$)/i
/** The frozen places spelled relative to a directory the reader cannot name. */
const FROZEN_TAIL_RE = /(^|\/)(skills\/dag|local-mods\/dag-gate|dag-gate\/registry)(\/|$)/i
/** Runner files a relative path names when the shell may sit inside a `.dag` folder. */
const STATE_TAIL_RE = /^(\.\/)?((approvals|gates|receipts)(\/|$)|(stop|state\.json|events\.jsonl)$)/i
/** `.dag` as a word in text: `'.dag'`, `/.dag/`, `.dag/state.json`; not `x.dag` or `.dagger`. */
const STATE_TEXT_RE = /(^|[^a-z0-9_])\.dag([^a-z0-9_]|$)/i
/** The frozen places in text. */
const FROZEN_TEXT_RE = /skills\/dag(\/|\b)|local-mods\/dag-gate|dag-gate\/registry|\.claude\/dag-gate/i
/**
 * The spent-approval ledger, and the gate home that holds it: the runner's state kept outside the job folder, so a
 * restored backup cannot spend an approval twice. State, like a `.dag` folder: no unlock opens it.
 */
const LEDGER_RE = /(^|\/)\.claude\/dag-gate(\/spent(\/|$)|\/?$)/i
/** The ledger's place, for a delete or move aimed at a folder above it. */
const LEDGER_ROOT = '~/.claude/dag-gate/spent'
/** The ledger spelled relative to a directory the reader cannot name. */
const LEDGER_TAIL_RE = /^(\.\/)?(dag-gate\/)?spent(\/|$)/i
/** In text: the ledger, the gate home (not its registry), or the variable that moves both. */
const LEDGER_TEXT_RE = /dag-gate\W{0,4}spent|\.claude\W{0,4}dag-gate(?!\W{0,4}registry)|DAG_GATE_HOME/i
/** Setting or exporting DAG_GATE_HOME: the runner would keep its spent ledger somewhere else. */
const GATE_HOME_RE = /^DAG_GATE_HOME(=|$)/
/** DAG_GATE_HOME named as itself, not read as `$DAG_GATE_HOME`: `read`, `printf -v` and computed exports set it this way. */
const BARE_GATE_HOME_RE = /(^|[^$\w{])DAG_GATE_HOME(?!\w)/
/** Where Python finds the runner's own modules: moving it can change the ledger the runner reads. */
const RUNNER_ENV_RE = /^PYTHON(PATH|HOME|USERBASE|PLATLIBDIR|EXECUTABLE)=/
/** Program text that expands the globs it holds (Python's glob, fnmatch, a shell it starts). */
const CODE_GLOBBING_RE = /glob|fnmatch|shell\s*=\s*True|os\.system|popen|exec(Sync)?\s*\(|spawn/i
/** The runner, by file name. */
const DAGPY_RE = /(^|\/)dag\.py$/i
/** The runner in text: its name, its folder, or `python -m dag`. */
const DAGPY_TEXT_RE = /dag\.py|skills\/dag\/scripts|-m\s*dag\b/i
/** The runner's own path, which running it names without writing anything there. */
const RUNNER_PATH_RE = /\S*skills\/dag\/(scripts\/dag\.py|tests\b)/gi
/** The runner's commands that only a person may run. */
export const PERSON_SUBS: readonly string[] = ['approve', 'resume']
const PERSON_WORD_RE = /\b(approve|resume)\b/i

export type Area = 'person' | 'state' | 'frozen'

export type Finding = {
  area: Area
  /** False when the reader could not tell for certain: a computed path, inline code, an unknown program. */
  sure: boolean
  /** For `person`: the dag.py subcommand. */
  verb?: string
  /** One line for the deny message. */
  why: string
}

export type ScriptRef = {
  path: string
  kind: 'shell' | 'other'
  /** What this same command writes into that path (a heredoc, echo, printf, tee): the file does not exist yet when the gate runs. */
  inline?: string
}

export type Analysis = {
  findings: Finding[]
  scripts: ScriptRef[]
  /** Whether the text names a `.dag` folder, the frozen places or dag.py at all (after un-quoting). */
  mentions: boolean
  /** 0 known outside the protected places, 1 known (or likely) inside one, 2 not known. */
  endLevel: CwdLevel
  /** The area the shell sits in at level 1. */
  endArea: Area | undefined
  /** Where the shell ends up: a path, null when a computed `cd` made it unknown, undefined when no base was given and nothing changed it. */
  endCwd: string | null | undefined
}

/** How sure the reader is that the shell sits inside a protected place. */
export type CwdLevel = 0 | 1 | 2

type Word = {
  /** First brace-expansion (or the only text). */
  t: string
  alts: string[]
  /** Holds an expansion we could not resolve. */
  dyn: boolean
  glob: boolean
  /** An unquoted glob that could match a `.dag` folder, or a frozen place. */
  hitState: boolean
  hitFrozen: boolean
}

type Redir = { op: string; target?: Word }

type Cmd = { words: Word[]; redirs: Redir[]; heredoc?: string; subs: string[]; pipeIn?: Cmd }

type Ctx = {
  findings: Finding[]
  scripts: ScriptRef[]
  /** The text names a `.dag` folder, the frozen places, or dag.py. */
  mentions: boolean
  mentionsState: boolean
  /** Names the frozen places other than by running the runner or its tests from where they live. */
  mentionsFrozen: boolean
  /** Names dag.py and approve or resume. */
  mentionsPerson: boolean
  /** Names dag.py at all. */
  mentionsRunner: boolean
  /** Runs a program not known to be read-only, which could pass its environment on. */
  runsOther: boolean
  env: Map<string, string>
  cwd: CwdLevel
  /** The area the shell sits in at level 1, when the reader knows it. */
  cwdArea: Area | undefined
  cwdPath: string | null | undefined
  home: string | undefined
  /** Absolute frozen roots beyond the fixed ones (where this mod is installed). */
  frozen: string[]
  /** Files this command writes, and what it writes into them. */
  written: Map<string, string>
  /** `cp a b` / `mv a b`: b is a, for a script run afterwards. */
  aliases: Map<string, string>
  /** The command being read now, for the redirections and pipe that feed its program. */
  cur: Cmd | undefined
  depth: number
}

const own = <T,>(table: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined

/**
 * The text of an ANSI-C quoted body (`$'...'`): \n \t \xHH \NNN \uHHHH and friends decoded the way bash and zsh do.
 * A NUL ends the string, as in the shell. An escape it does not know stays as written.
 */
export const decodeAnsiC = (body: string): string => {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\' || i + 1 >= body.length) {
      out += c
      continue
    }
    const e = body[i + 1]
    i++
    const simple: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }
    if (Object.prototype.hasOwnProperty.call(simple, e)) {
      out += simple[e]
    } else if (e === 'x' || e === 'u' || e === 'U') {
      const max = e === 'x' ? 2 : e === 'u' ? 4 : 8
      let hex = ''
      while (hex.length < max && /[0-9a-fA-F]/.test(body[i + 1 + hex.length] ?? '')) {
        hex += body[i + 1 + hex.length]
      }
      if (hex === '') {
        out += `\\${e}`
      } else {
        const code = parseInt(hex, 16)
        if (code === 0) {
          return out
        }
        out += code <= 0x10ffff ? String.fromCodePoint(code) : ''
        i += hex.length
      }
    } else if (/[0-7]/.test(e)) {
      let oct = e
      while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) {
        oct += body[i + 1]
        i++
      }
      const code = parseInt(oct, 8) & 0xff
      if (code === 0) {
        return out
      }
      out += String.fromCharCode(code)
    } else if (e === 'c' && body[i + 1] !== undefined) {
      i++
    } else {
      out += `\\${e}`
    }
  }

  return out
}

/** `a/./b//c/../d` and friends, with a leading `/` or `~` kept. Not a symlink resolver. */
export const normalizePath = (p: string): string => {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') {
      continue
    }
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..' && out[out.length - 1] !== '~') {
        out.pop()
      } else if (!abs && out[0] !== '~') {
        out.push('..')
      }
      continue
    }
    out.push(seg)
  }

  return (abs ? '/' : '') + out.join('/')
}


const MAX_DEPTH = 8
const MAX_BRACE = 64

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Ch = { c: string; q: boolean }

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Index of the `)` matching the `(` just before `from`, honouring quotes; -1 when unbalanced. */
const matchParen = (s: string, from: number): number => {
  let depth = 1
  let i = from
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === "'") {
      const j = s.indexOf("'", i + 1)
      i = j === -1 ? s.length : j + 1
      continue
    }
    if (c === '"') {
      i++
      while (i < s.length && s[i] !== '"') {
        i += s[i] === '\\' ? 2 : 1
      }
      i++
      continue
    }
    if (c === '(') {
      depth++
    } else if (c === ')') {
      depth--
      if (depth === 0) {
        return i
      }
    }
    i++
  }

  return -1
}

/** `$( ... )` and backtick bodies in a block of text (a heredoc body). */
const findSubs = (text: string): string[] => {
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
      const j = matchParen(text, i + 2)
      if (j === -1) {
        out.push(text.slice(i + 2))
        break
      }
      out.push(text.slice(i + 2, j))
      i = j
    } else if (text[i] === '`') {
      const j = text.indexOf('`', i + 1)
      out.push(text.slice(i + 1, j === -1 ? text.length : j))
      if (j === -1) {
        break
      }
      i = j
    }
  }

  return out
}

/** Brace expansion over unquoted `{a,b}` groups. Over the cap, the first alternative stands and `capped` is set. */
const braceExpand = (chars: Ch[]): { list: string[]; capped: boolean } => {
  let capped = false
  const go = (cs: Ch[]): string[] => {
    for (let a = 0; a < cs.length; a++) {
      if (cs[a].c !== '{' || cs[a].q) {
        continue
      }
      let depth = 0
      const commas: number[] = []
      let b = -1
      for (let k = a; k < cs.length; k++) {
        const { c, q } = cs[k]
        if (q) {
          continue
        }
        if (c === '{') {
          depth++
        } else if (c === '}') {
          depth--
          if (depth === 0) {
            b = k
            break
          }
        } else if (c === ',' && depth === 1) {
          commas.push(k)
        }
      }
      if (b === -1 || commas.length === 0) {
        continue
      }
      const cuts = [a, ...commas, b]
      const prefix = cs.slice(0, a)
      const suffix = cs.slice(b + 1)
      const out: string[] = []
      for (let n = 0; n + 1 < cuts.length; n++) {
        const alt = cs.slice(cuts[n] + 1, cuts[n + 1])
        for (const one of go([...prefix, ...alt, ...suffix])) {
          out.push(one)
          if (out.length > MAX_BRACE) {
            capped = true

            return out.slice(0, MAX_BRACE)
          }
        }
      }

      return out
    }

    return [cs.map(x => x.c).join('')]
  }
  const list = go(chars)

  return { list: list.length === 0 ? [''] : list, capped }
}

/** A glob segment as a regex over one path segment. */
const segmentRe = (seg: string): RegExp | undefined => {
  try {
    const body = seg
      .replace(/[.+^${}()|\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')

    return new RegExp(`^${body}$`, 'i')
  } catch {
    return undefined
  }
}

/** Names a glob segment is tried against, to see whether it can reach a frozen place or the ledger. */
const FROZEN_SEGMENTS = ['.claude', 'skills', 'dag', 'local-mods', 'dag-gate', 'registry', 'spent']

/**
 * Could this path-with-globs name a `.dag` folder, the ledger, or a frozen place? A glob does not match a leading dot unless
 * the pattern spells one, so only a segment that starts with a literal `.` can reach `.dag`.
 */
const globHits = (token: string): { state: boolean; frozen: boolean } => {
  let state = false
  const choices: string[][] = []
  for (const seg of token.split('/')) {
    if (!/[*?[]/.test(seg)) {
      choices.push([seg])
      continue
    }
    const re = segmentRe(seg)
    if (re === undefined) {
      return { state: true, frozen: true }
    }
    if (seg.startsWith('.') && re.test('.dag')) {
      state = true
    }
    const named = FROZEN_SEGMENTS.filter(x => re.test(x))
    choices.push(named.length > 0 ? named : [seg])
  }
  // Every spelling the frozen names make, capped: does one of them land in a frozen place?
  let paths: string[] = []
  for (const options of choices) {
    paths = (paths.length === 0 ? options : paths.flatMap(p => options.map(o => `${p}/${o}`))).slice(0, 256)
  }

  return { state: state || paths.some(p => LEDGER_RE.test(p)), frozen: paths.some(p => FROZEN_RE.test(p)) }
}

/** Whether a glob path could name `root` or a folder above it, matched segment by segment as the shell would. */
const globAbove = (glob: string, root: string): boolean => {
  const g = glob.split('/')
  const r = root.split('/')

  return g.length <= r.length && g.every((seg, i) => (/[*?[]/.test(seg) ? segmentRe(seg)?.test(r[i]) ?? true : seg.toLowerCase() === r[i].toLowerCase()))
}

/** Glob paths in program text that expands them (a glob.glob call on the gate home), tried as the shell reader tries a glob word. */
const codeGlobs = (texts: readonly string[]): { state?: string; frozen?: string } => {
  const out: { state?: string; frozen?: string } = {}
  if (!texts.some(t => CODE_GLOBBING_RE.test(t))) {
    return out
  }
  for (const text of texts) {
    for (const piece of text.split(/[\s'"`,()[\]{}<>;=]+/)) {
      if (!piece.includes('/') || !/[*?]/.test(piece)) {
        continue
      }
      const hit = globHits(piece)
      out.state = out.state ?? (hit.state ? piece : undefined)
      out.frozen = out.frozen ?? (hit.frozen ? piece : undefined)
    }
  }

  return out
}

const mkWord = (chars: Ch[], dyn: boolean): Word => {
  const { list, capped } = braceExpand(chars)
  const glob = chars.some(x => !x.q && (x.c === '*' || x.c === '?' || x.c === '['))
  let hitState = false
  let hitFrozen = false
  if (glob) {
    for (const alt of list) {
      const h = globHits(alt)
      hitState = hitState || h.state
      hitFrozen = hitFrozen || h.frozen
    }
  }

  return { t: list[0], alts: list, dyn: dyn || capped, glob, hitState, hitFrozen }
}

const DECLARERS = ['export', 'declare', 'local', 'readonly', 'typeset']

/** The assignment words of a command that is nothing but assignments (`A=1 B=2`, `export A=1`), else none. */
const assignmentsOf = (words: Word[]): Word[] => {
  const rest = words.length > 0 && DECLARERS.includes(words[0].t) ? words.slice(1) : words

  return rest.length > 0 && rest.every(w => ASSIGN.test(w.t)) ? rest : []
}

const learnAssignments = (words: Word[], env: Map<string, string>): void => {
  for (const w of assignmentsOf(words)) {
    const eq = w.t.indexOf('=')
    const name = w.t.slice(0, eq)
    if (w.dyn) {
      env.delete(name)
    } else {
      env.set(name, w.t.slice(eq + 1))
    }
  }
}

const parse = (src: string, env: Map<string, string>): Cmd[] => {
  const cmds: Cmd[] = []
  const fresh = (): Cmd => ({ words: [], redirs: [], subs: [] })
  let cur = fresh()
  let chars: Ch[] = []
  let inWord = false
  let dyn = false
  let pending: Redir | undefined
  const heredocs: { delim: string; strip: boolean; quoted: boolean; cmd: Cmd }[] = []
  let i = 0

  const flushWord = (): void => {
    if (!inWord) {
      return
    }
    const w = mkWord(chars, dyn)
    if (pending !== undefined) {
      pending.target = w
      pending = undefined
    } else {
      cur.words.push(w)
    }
    chars = []
    inWord = false
    dyn = false
  }
  const endCmd = (): void => {
    flushWord()
    pending = undefined
    if (cur.words.length > 0 || cur.redirs.length > 0) {
      cmds.push(cur)
      learnAssignments(cur.words, env)
    }
    cur = fresh()
  }
  const add = (text: string, q: boolean): void => {
    for (const c of text) {
      chars.push({ c, q })
    }
    inWord = true
  }
  const readHeredocBodies = (): void => {
    for (const h of heredocs) {
      const lines: string[] = []
      while (i < src.length) {
        let nl = src.indexOf('\n', i)
        if (nl === -1) {
          nl = src.length
        }
        const line = src.slice(i, nl)
        i = Math.min(nl + 1, src.length)
        const cmp = h.strip ? line.replace(/^\t+/, '') : line
        if (cmp === h.delim) {
          break
        }
        lines.push(line)
      }
      h.cmd.heredoc = (h.cmd.heredoc ?? '') + lines.join('\n') + '\n'
      if (!h.quoted) {
        h.cmd.subs.push(...findSubs(lines.join('\n')))
      }
    }
    heredocs.length = 0
  }
  /** A `$...` expansion at `i` (src[i] === '$'). Returns the new index. */
  const dollar = (inDq: boolean): void => {
    const n = src[i + 1]
    if (!inDq && n === "'") {
      // $'...' (ANSI-C quoting): the shell decodes the escapes, so the word is what they spell.
      let j = i + 2
      let body = ''
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < src.length) {
          body += src[j] + src[j + 1]
          j += 2
        } else {
          body += src[j]
          j++
        }
      }
      i = j < src.length ? j + 1 : j
      add(decodeAnsiC(body), true)

      return
    }
    if (!inDq && n === '"') {
      // $"..." (locale translation) is a double-quoted string; drop the `$` and let the quote be read.
      i++

      return
    }
    if (n === '(') {
      if (src[i + 2] === '(') {
        const j = matchParen(src, i + 3)
        add('$((…))', true)
        dyn = true
        i = j === -1 ? src.length : j + 1
        if (src[i] === ')') {
          i++
        }

        return
      }
      const j = matchParen(src, i + 2)
      cur.subs.push(src.slice(i + 2, j === -1 ? src.length : j))
      add('$(…)', true)
      dyn = true
      i = j === -1 ? src.length : j + 1

      return
    }
    if (n === '{') {
      const j = src.indexOf('}', i + 2)
      const inner = src.slice(i + 2, j === -1 ? src.length : j)
      i = j === -1 ? src.length : j + 1
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner) && env.has(inner)) {
        add(env.get(inner) as string, inDq)
      } else {
        add('${' + inner + '}', true)
        dyn = true
      }

      return
    }
    if (n !== undefined && /[A-Za-z_]/.test(n)) {
      let j = i + 1
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) {
        j++
      }
      const name = src.slice(i + 1, j)
      i = j
      if (env.has(name)) {
        add(env.get(name) as string, inDq)
      } else {
        add('$' + name, true)
        dyn = true
      }

      return
    }
    if (n !== undefined && /[0-9?!#*@$-]/.test(n)) {
      add('$' + n, true)
      dyn = true
      i += 2

      return
    }
    add('$', true)
    i++
  }
  const backtick = (): void => {
    const j = src.indexOf('`', i + 1)
    cur.subs.push(src.slice(i + 1, j === -1 ? src.length : j))
    add('`…`', true)
    dyn = true
    i = j === -1 ? src.length : j + 1
  }

  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (ch === '\\') {
      if (next === '\n') {
        i += 2
      } else if (next === undefined) {
        i++
      } else {
        add(next, true)
        i += 2
      }
      continue
    }
    if (ch === "'") {
      const j = src.indexOf("'", i + 1)
      add(src.slice(i + 1, j === -1 ? src.length : j), true)
      inWord = true
      i = j === -1 ? src.length : j + 1
      continue
    }
    if (ch === '"') {
      inWord = true
      i++
      while (i < src.length && src[i] !== '"') {
        const c = src[i]
        if (c === '\\' && i + 1 < src.length) {
          const e = src[i + 1]
          if (e === '"' || e === '\\' || e === '$' || e === '`') {
            add(e, true)
          } else if (e !== '\n') {
            add('\\' + e, true)
          }
          i += 2
        } else if (c === '$') {
          dollar(true)
        } else if (c === '`') {
          backtick()
        } else {
          add(c, true)
          i++
        }
      }
      i++
      continue
    }
    if (ch === '$') {
      dollar(false)
      continue
    }
    if (ch === '`') {
      backtick()
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flushWord()
      i++
      continue
    }
    if (ch === '\n') {
      endCmd()
      i++
      if (heredocs.length > 0) {
        readHeredocBodies()
      }
      continue
    }
    if (ch === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') {
        i++
      }
      continue
    }
    if (ch === ';') {
      endCmd()
      i++
      continue
    }
    if (ch === '&' && next !== '>') {
      endCmd()
      i += next === '&' ? 2 : 1
      continue
    }
    if (ch === '|') {
      const before = cur
      endCmd()
      if (next !== '|' && (before.words.length > 0 || before.redirs.length > 0)) {
        cur.pipeIn = before
      }
      i += next === '|' || next === '&' ? 2 : 1
      continue
    }
    if ((ch === '(' || ch === ')') ) {
      endCmd()
      i++
      continue
    }
    if (ch === '<' || ch === '>' || (ch === '&' && next === '>')) {
      // Process substitution is a word, not a redirection.
      if ((ch === '<' || ch === '>') && next === '(') {
        const j = matchParen(src, i + 2)
        cur.subs.push(src.slice(i + 2, j === -1 ? src.length : j))
        add('<(…)', true)
        dyn = true
        i = j === -1 ? src.length : j + 1
        continue
      }
      // `2>` and friends: a word of only digits right before the operator is the fd.
      if (inWord && !dyn && chars.length > 0 && chars.every(x => !x.q && /[0-9]/.test(x.c))) {
        chars = []
        inWord = false
      } else {
        flushWord()
      }
      let op = ch
      if (ch === '&') {
        op = src.startsWith('&>>', i) ? '&>>' : '&>'
      } else if (src.startsWith('<<<', i)) {
        op = '<<<'
      } else if (src.startsWith('<<-', i)) {
        op = '<<-'
      } else if (src.startsWith('<<', i)) {
        op = '<<'
      } else if (src.startsWith('>>', i)) {
        op = '>>'
      } else if (src.startsWith('>|', i)) {
        op = '>|'
      } else if (src.startsWith('>&', i)) {
        op = '>&'
      } else if (src.startsWith('<&', i)) {
        op = '<&'
      } else if (src.startsWith('<>', i)) {
        op = '<>'
      }
      i += op.length
      if (op === '<<' || op === '<<-') {
        while (src[i] === ' ' || src[i] === '\t') {
          i++
        }
        let delim = ''
        let quoted = false
        while (i < src.length && !/[\s;&|()<>]/.test(src[i])) {
          const c = src[i]
          if (c === "'" || c === '"') {
            quoted = true
            const j = src.indexOf(c, i + 1)
            delim += src.slice(i + 1, j === -1 ? src.length : j)
            i = j === -1 ? src.length : j + 1
          } else if (c === '\\') {
            quoted = true
            delim += src[i + 1] ?? ''
            i += 2
          } else {
            delim += c
            i++
          }
        }
        heredocs.push({ delim, strip: op === '<<-', quoted, cmd: cur })
        continue
      }
      const r: Redir = { op }
      cur.redirs.push(r)
      pending = r
      continue
    }
    add(ch, false)
    i++
  }
  endCmd()
  if (heredocs.length > 0) {
    readHeredocBodies()
  }

  return cmds
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const lowerBase = (p: string): string => {
  const slash = p.lastIndexOf('/')

  return (slash === -1 ? p : p.slice(slash + 1)).toLowerCase()
}

const isFlag = (w: Word): boolean => w.t.startsWith('-') && w.t.length > 1
const isRelative = (t: string): boolean => !t.startsWith('/') && !t.startsWith('~') && !t.startsWith('$')
const short = (t: string): string => (t.length > 90 ? `${t.slice(0, 87)}...` : t)
const placeName = (area: Area): string => (area === 'state' ? 'a .dag folder or the spent ledger' : 'the frozen dag files')

const push = (ctx: Ctx, f: Finding): void => {
  ctx.findings.push(f)
}

/** An assignment or export of DAG_GATE_HOME, or of Python's module path for dag.py: the runner could read another ledger. */
const movesGateHome = (ctx: Ctx, w: Word): void => {
  if (GATE_HOME_RE.test(w.t)) {
    push(ctx, { area: 'state', sure: true, why: 'it sets DAG_GATE_HOME, which moves the spent-approval ledger' })
  } else if (ctx.mentionsRunner && RUNNER_ENV_RE.test(w.t)) {
    push(ctx, { area: 'state', sure: true, why: `it sets ${w.t.slice(0, w.t.indexOf('='))} for dag.py, which can change the spent ledger it reads` })
  }
}

/** The areas a command names, for a finding the reader cannot pin to one place. */
const namedAreas = (ctx: Ctx, writesOnly = false): Area[] => {
  const areas: Area[] = []
  if (ctx.mentionsPerson && !writesOnly) {
    areas.push('person')
  }
  if (ctx.mentionsState) {
    areas.push('state')
  }
  if (ctx.mentionsFrozen) {
    areas.push('frozen')
  }

  return areas
}

/** A finding the reader could not pin down: one per area the command names, so each gets its own answer. */
const unsure = (ctx: Ctx, why: string, areas: readonly Area[] = namedAreas(ctx)): void => {
  for (const area of areas) {
    push(ctx, { area, sure: false, why })
  }
}

const SYSTEM_BIN = /^(\/usr\/local\/bin|\/usr\/bin|\/bin|\/usr\/sbin|\/sbin|\/opt\/homebrew\/bin|\/opt\/homebrew\/sbin|\/usr\/local\/sbin|\/usr\/libexec)\//

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash', 'mksh'])
const INTERP_CODE_FLAGS: Record<string, string[]> = {
  perl: ['-e', '-E'],
  ruby: ['-e'],
  node: ['-e', '--eval', '-p', '--print'],
  nodejs: ['-e', '--eval', '-p', '--print'],
  deno: ['eval'],
  bun: ['-e', '--eval'],
  php: ['-r'],
  lua: ['-e'],
  osascript: ['-e'],
  expect: ['-c'],
  tclsh: [],
  swift: [],
  rscript: ['-e'],
  julia: ['-e'],
}
/** Python options whose value is the next word, so that word is not the script. */
const PY_VALUE_FLAGS = new Set(['-W', '-X', '--check-hash-based-pycs'])

const WRAPPERS: Record<string, { val: string[]; assign?: boolean; pos?: number }> = {
  sudo: { val: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-r', '-t', '-U', '--user', '--group', '--host', '--prompt', '--chdir'] },
  doas: { val: ['-u', '-C'] },
  env: { val: ['-u', '-C', '-P'], assign: true },
  command: { val: [] },
  builtin: { val: [] },
  exec: { val: ['-a'] },
  nohup: { val: [] },
  time: { val: ['-f', '-o'] },
  nice: { val: ['-n'] },
  ionice: { val: ['-c', '-n', '-p'] },
  timeout: { val: ['-s', '-k', '--signal', '--kill-after'], pos: 1 },
  stdbuf: { val: ['-i', '-o', '-e'] },
  caffeinate: { val: ['-t', '-w'] },
  arch: { val: ['-arch'] },
  setsid: { val: [] },
  unbuffer: { val: [] },
}

/** Copies whose sources are only read: the destination is the write. */
const COPY_DEST = new Set(['cp', 'install', 'ditto', 'gcp', 'ginstall', 'scp', 'rsync'])
/** Deletes and moves: one aimed at a folder above a frozen place takes that place along. */
const REMOVAL = new Set(['rm', 'unlink', 'rmdir', 'grm', 'trash', 'srm', 'shred', 'mv', 'gmv'])
const READONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'file', 'stat', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'echo',
  'printf', 'test', '[', '[[', 'diff', 'cmp', 'sort', 'cut', 'tr', 'basename', 'dirname', 'realpath',
  'readlink', 'pwd', 'du', 'df', 'which', 'type', 'whereis', 'man', 'whatis', 'md5', 'md5sum', 'shasum', 'sha256sum',
  'sha1sum', 'hexdump', 'od', 'strings', 'true', 'false', 'ps', 'pgrep', 'id', 'whoami', 'date', 'tree', 'eza',
  'bat', 'lsof', 'mdfind', 'mdls', 'jq', 'column', 'nl', 'fold', 'fmt', 'rev', 'tac', 'comm', 'join', 'paste',
  'printenv', 'hostname', 'uname', 'sw_vers', 'uptime', 'sleep', 'wait', 'read', 'export', 'declare', 'local',
  'readonly', 'typeset', 'unset', 'set', 'alias', 'unalias', ':', 'for', 'select', 'case', 'dirs', 'jobs',
  'glob', 'ggrep', 'gsort', 'gcat', 'ghead', 'gtail', 'gls', 'env',
])
/** Read-only programs that still write the file named by `-o` or `--output`. */
const OUTPUT_FLAG = new Set(['sort', 'gsort', 'tree'])
const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done', 'esac', '{', '}', '!', 'function'])
/** `python -m` modules that only read what they are given: test runners, linters, bytecode compilers. */
const SAFE_MODULES = new Set([
  'unittest', 'pytest', 'doctest', 'py_compile', 'compileall', 'tabnanny', 'pyclbr', 'pydoc', 'timeit', 'platform',
  'site', 'sysconfig', 'dis', 'ast', 'tokenize', 'inspect', 'json.tool', 'mypy', 'pyflakes', 'flake8', 'pylint',
])
/** `uv run <cmd>` and friends run <cmd>. */
const RUNNERS = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye', 'pixi'])
/** Programs that run a command line given as text, often in a terminal of their own. */
const RUNS_TEXT = new Set(['tmux', 'screen', 'ssh', 'su', 'at', 'batch', 'xterm', 'watch', 'parallel', 'socat', 'runuser', 'zellij', 'wezterm', 'kitty', 'alacritty'])
/** git subcommands that write the work tree. */
const GIT_WRITERS = new Set([
  'checkout', 'restore', 'reset', 'stash', 'clean', 'apply', 'am', 'merge', 'rebase', 'pull', 'switch', 'cherry-pick',
  'revert', 'mv', 'rm', 'read-tree', 'checkout-index', 'worktree', 'clone', 'init', 'submodule', 'sparse-checkout',
])
/** The frozen roots, for a delete or move aimed at a folder above them. */
const FROZEN_ROOTS = ['~/.claude/skills/dag', '~/.claude/local-mods/dag-gate', '~/.claude/dag-gate']

/** A path the way the shell would see it: relative names resolved against where the shell is, when that is known. */
const resolveIn = (ctx: Ctx, t: string): string => {
  if (isRelative(t) && typeof ctx.cwdPath === 'string') {
    return normalizePath(`${ctx.cwdPath}/${t}`)
  }

  return t
}

/** Key for comparing two spellings of one file inside a single command. */
const fileKey = (ctx: Ctx, t: string): string => {
  const p = normalizePath(resolveIn(ctx, t))

  return ctx.home !== undefined && (p === '~' || p.startsWith('~/')) ? normalizePath(`${ctx.home}${p.slice(1)}`) : p
}

const under = (p: string, root: string): boolean => {
  const a = p.toLowerCase()
  const b = root.toLowerCase()

  return a === b || a.startsWith(`${b}/`)
}

/** The protected area a path lands in, by its spelling and by where the shell is; undefined when it is neither. */
const areaOf = (ctx: Ctx, t: string): Area | undefined => {
  const p = fileKey(ctx, t)
  if (STATE_RE.test(t) || STATE_RE.test(p) || LEDGER_RE.test(t) || LEDGER_RE.test(p)) {
    return 'state'
  }
  if (isRelative(t) && ctx.cwdPath === null && /(^|\/)dag-gate\/spent(\/|$)/i.test(t)) {
    return 'state'
  }
  if (FROZEN_RE.test(t) || FROZEN_RE.test(p) || ctx.frozen.some(r => under(p, r))) {
    return 'frozen'
  }
  if (isRelative(t) && ctx.cwdPath === null && FROZEN_TAIL_RE.test(t)) {
    return 'frozen'
  }

  return undefined
}

/** What deleting or moving `t` takes with it: the ledger (state) or a frozen place, when `t` is one or a folder above one. */
const holds = (ctx: Ctx, t: string): Area | undefined => {
  const p = fileKey(ctx, t).replace(/\/+$/, '')
  if (p === '' || isRelative(p)) {
    return undefined
  }
  const expand = (r: string): string => (ctx.home === undefined ? r : normalizePath(`${ctx.home}${r.slice(1)}`))
  const isGlob = /[*?[]/.test(p)
  const above = (r: string): boolean => (isGlob ? globAbove(p, r) : under(r, p))
  if (p === '/' || above(expand(LEDGER_ROOT))) {
    return 'state'
  }

  return [...FROZEN_ROOTS.map(expand), ...ctx.frozen].some(above) ? 'frozen' : undefined
}

const heldBy = (area: Area): string => (area === 'state' ? 'the spent-approval ledger' : 'the frozen dag files')

/** A relative `t` that lands in a protected place because of where the shell may be, when the reader cannot name that place. */
const cwdCatches = (ctx: Ctx, t: string): boolean => {
  if (typeof ctx.cwdPath === 'string' || !(isRelative(t) || t === '.')) {
    return false
  }
  if (ctx.cwd === 1) {
    return true
  }

  return ctx.cwd === 2 && (STATE_TAIL_RE.test(t) || FROZEN_TAIL_RE.test(t) || LEDGER_TAIL_RE.test(t))
}

const writeTarget = (ctx: Ctx, w: Word, how: string): void => {
  for (const t of w.alts) {
    // A glob is also tried where it lands: from ~/.claude, `dag-gate/sp*` is the ledger.
    const here = w.glob ? globHits(fileKey(ctx, t)) : { state: false, frozen: false }
    const hitState = w.hitState || here.state
    const hitFrozen = w.hitFrozen || here.frozen
    const area = areaOf(ctx, t)
    if (area !== undefined) {
      push(ctx, { area, sure: !w.dyn && !w.glob, why: `${how} to ${short(t)}` })
      if (area === 'frozen' && hitState) {
        push(ctx, { area: 'state', sure: false, why: `${how} to a glob (${short(t)}) that could reach the spent ledger` })
      }
      continue
    }
    if (hitState) {
      push(ctx, { area: 'state', sure: false, why: `${how} to a glob (${short(t)}) that could reach a .dag folder or the spent ledger` })
    }
    if (hitFrozen) {
      push(ctx, { area: 'frozen', sure: false, why: `${how} to a glob (${short(t)}) that could reach the frozen dag files` })
    }
    if (hitState || hitFrozen) {
      continue
    }
    if (cwdCatches(ctx, t)) {
      const place = LEDGER_TAIL_RE.test(t) ? 'state' : ctx.cwdArea ?? (STATE_TAIL_RE.test(t) ? 'state' : 'frozen')
      push(ctx, { area: place, sure: false, why: `${how} to ${short(t)} while the shell ${ctx.cwd === 1 ? 'sits' : 'may sit'} inside ${placeName(place)}` })
    } else if ((w.dyn || w.glob) && (ctx.mentionsState || ctx.mentionsFrozen)) {
      unsure(ctx, `${how} to a path I cannot resolve (${short(t)}) in a command that names a .dag folder, the spent ledger or the frozen dag files`, namedAreas(ctx, true))
    }
  }
}

/** The value inside an option word: `--output=x` gives x, `-ox` gives x; undefined for a bare flag. */
const flagValue = (w: Word): Word | undefined => {
  if (w.t.startsWith('--')) {
    if (!w.t.includes('=')) {
      return undefined
    }
    const cut = (s: string): string => s.slice(s.indexOf('=') + 1)

    return { ...w, t: cut(w.t), alts: w.alts.map(cut) }
  }

  return w.t.length > 2 ? { ...w, t: w.t.slice(2), alts: w.alts.map(a => a.slice(2)) } : undefined
}

/** A program not known to be read-only: any path it is given may be written. */
const anyArgWrite = (ctx: Ctx, name: string, args: Word[], fed = false): void => {
  for (const a of args) {
    const target = isFlag(a) ? flagValue(a) : a
    if (target !== undefined) {
      writeTarget(ctx, target, name)
    }
  }
  if (REMOVAL.has(name)) {
    let gone = args.filter(x => !isFlag(x))
    if (name === 'mv' || name === 'gmv') {
      // The destination receives; only the sources leave their place.
      const at = args.findIndex(a => a.t === '-t' || a.t === '--target-directory')
      const dest = at !== -1 ? args[at + 1] : args.find(a => a.t.startsWith('--target-directory='))
      gone = dest !== undefined ? gone.filter(a => a !== dest) : gone.slice(0, -1)
    }
    for (const a of gone) {
      for (const t of a.alts) {
        const area = holds(ctx, t)
        if (area !== undefined) {
          push(ctx, { area, sure: !a.dyn, why: `${name} ${short(t)}, which holds ${heldBy(area)}` })
          break
        }
      }
    }
  }
  if (fed && (ctx.mentionsState || ctx.mentionsFrozen)) {
    unsure(ctx, `${name} given paths by a pipe or find in a command that names a .dag folder, the spent ledger or the frozen dag files`, namedAreas(ctx, true))
  }
}

const scriptKind = (name: string, path: string): 'shell' | 'other' =>
  SHELLS.has(name) || /\.(sh|bash|zsh|command)$/i.test(path) || !/\.[A-Za-z0-9]+$/.test(path) ? 'shell' : 'other'

const queueScript = (ctx: Ctx, w: Word, kind: 'shell' | 'other', isStrict = true): void => {
  if (w.dyn) {
    if (ctx.mentions && isStrict) {
      unsure(ctx, `a script path I cannot resolve (${short(w.t)}) in a command that names the dag gate's files or dag.py`)
    }

    return
  }
  const path = resolveIn(ctx, w.t)
  // The runner and its tests are frozen: nothing a model wrote is in them to read for.
  if (areaOf(ctx, w.t) === 'frozen' || ctx.scripts.some(s => s.path === path)) {
    return
  }
  ctx.scripts.push({ path, kind })
  // `cp real.sh /tmp/run.sh && bash /tmp/run.sh`: the copy is the thing that runs, so read what it was copied from.
  const from = ctx.aliases.get(fileKey(ctx, w.t))
  if (from !== undefined && !ctx.scripts.some(s => s.path === from)) {
    ctx.scripts.push({ path: from, kind })
  }
}

const WRITE_OPS = new Set(['>', '>>', '>|', '&>', '&>>'])

/** What a command upstream of a pipe says on stdout, for echo, printf and cat of a heredoc; unknown otherwise. */
const pipeText = (c: Cmd | undefined): string => {
  if (c === undefined) {
    return ''
  }
  const words = c.words.filter((w, n) => !(n === 0 && ASSIGN.test(w.t)))
  const name = words.length > 0 ? lowerBase(words[0].t) : ''
  const said = name === 'echo' || name === 'printf' ? decodeAnsiC(words.slice(1).filter(a => !isFlag(a)).map(a => a.t).join(' ')) : ''

  return pipeText(c.pipeIn) + (c.heredoc ?? '') + said
}

const addWritten = (ctx: Ctx, path: string, body: string): void => {
  const key = fileKey(ctx, path)
  ctx.written.set(key, (ctx.written.get(key) ?? '') + body)
}

/** Remembers what this command puts into files, so a script it writes and then runs can be read without existing yet. */
const captureWrites = (ctx: Ctx, name: string, args: Word[], stdinText: string | undefined, piped: string): void => {
  const cmd = ctx.cur
  if (cmd === undefined) {
    return
  }
  const body = (stdinText ?? '') + piped + (name === 'echo' || name === 'printf' ? decodeAnsiC(args.filter(a => !isFlag(a)).map(a => a.t).join(' ')) : '')
  for (const r of cmd.redirs) {
    if (WRITE_OPS.has(r.op) && r.target !== undefined && !r.target.dyn && !r.target.glob) {
      addWritten(ctx, r.target.t, body)
    }
  }
  if (name === 'tee') {
    for (const a of args.filter(x => !isFlag(x))) {
      if (!a.dyn && !a.glob) {
        addWritten(ctx, a.t, body)
      }
    }
  }
}

const run = (src: string, ctx: Ctx): void => {
  if (ctx.depth > MAX_DEPTH) {
    if (ctx.mentions) {
      unsure(ctx, 'commands nested too deeply to read')
    }

    return
  }
  const cmds = parse(src, ctx.env)
  for (const c of cmds) {
    for (const s of c.subs) {
      ctx.depth++
      run(s, ctx)
      ctx.depth--
    }
    simple(c, ctx)
  }
}

const runNested = (code: string, ctx: Ctx): void => {
  ctx.depth++
  run(code, ctx)
  ctx.depth--
}

const simple = (cmd: Cmd, ctx: Ctx): void => {
  ctx.cur = cmd
  let stdinText = cmd.heredoc
  for (const r of cmd.redirs) {
    const t = r.target
    if (t === undefined) {
      continue
    }
    if (r.op === '<<<') {
      stdinText = (stdinText ?? '') + t.t
      continue
    }
    if (r.op === '<' || r.op === '<&') {
      continue
    }
    if (r.op === '>&' && /^(\d+|-)$/.test(t.t)) {
      continue
    }
    writeTarget(ctx, t, 'redirection')
  }
  let words = cmd.words
  while (words.length > 0 && ASSIGN.test(words[0].t)) {
    movesGateHome(ctx, words[0])
    words = words.slice(1)
  }
  while (words.length > 0 && RESERVED.has(words[0].t)) {
    words = words.slice(1)
  }
  if (words.length === 0) {
    return
  }
  peel(ctx, words, stdinText, false, pipeText(cmd.pipeIn))
}

const peel = (ctx: Ctx, input: Word[], stdinText: string | undefined, fed: boolean, piped = ''): void => {
  let words = input
  // Strip wrappers (sudo, env, nohup, ...) until a real program is at the front.
  for (let guard = 0; guard < 12 && words.length > 0; guard++) {
    const name = lowerBase(words[0].t)
    const spec = own(WRAPPERS, name)
    if (spec === undefined || (words[0].t.includes('/') && !SYSTEM_BIN.test(words[0].t))) {
      break
    }
    let i = 1
    let pos = spec.pos ?? 0
    while (i < words.length) {
      const tok = words[i].t
      if (tok === '--') {
        i++
        break
      }
      if (name === 'command' && (tok === '-v' || tok === '-V')) {
        return
      }
      if (name === 'env' && tok === '-S' && words[i + 1] !== undefined) {
        runNested(words[i + 1].t, ctx)

        return
      }
      if (tok.startsWith('-') && tok.length > 1) {
        i += spec.val.includes(tok) ? 2 : 1
        continue
      }
      if (spec.assign === true && ASSIGN.test(tok)) {
        movesGateHome(ctx, words[i])
        i++
        continue
      }
      if (pos > 0) {
        pos--
        i++
        continue
      }
      break
    }
    words = words.slice(i)
  }
  while (words.length > 0 && ASSIGN.test(words[0].t)) {
    movesGateHome(ctx, words[0])
    words = words.slice(1)
  }
  if (words.length === 0) {
    return
  }

  const head = words[0]
  if (head.alts.length > 1 && new Set(head.alts.map(lowerBase)).size > 1) {
    // `{echo,rm} x`: every spelling the braces make is a command that may run.
    for (const alt of head.alts) {
      peel(ctx, [{ ...head, t: alt, alts: [alt] }, ...words.slice(1)], stdinText, fed, piped)
    }

    return
  }
  if (!head.dyn && /\s/.test(head.t)) {
    // `$D approve x` with D="python3 dag.py --spec j": bash splits an unquoted expansion into words, so read it that way.
    runNested([head.t, ...words.slice(1).map(w => w.t)].join(' '), ctx)

    return
  }
  const name = lowerBase(head.t)
  const args = words.slice(1)
  if (DECLARERS.includes(name)) {
    args.forEach(a => movesGateHome(ctx, a))
  }
  if (!READONLY.has(name) && !['cd', 'pushd', 'popd', 'chdir'].includes(name)) {
    ctx.runsOther = true
  }
  const isSystem = !head.t.includes('/') || SYSTEM_BIN.test(head.t)
  captureWrites(ctx, name, args, stdinText, piped)

  if (head.dyn) {
    if (args.some(a => PERSON_SUBS.includes(a.t.toLowerCase()))) {
      push(ctx, { area: 'person', sure: false, why: `a command I cannot resolve (${short(head.t)}) run with ${args.find(a => PERSON_SUBS.includes(a.t.toLowerCase()))?.t}` })
    }
    if (ctx.mentions) {
      unsure(ctx, `a command name I cannot resolve (${short(head.t)}) in a command that names the dag gate's files or dag.py`)
    }

    return
  }
  if (DAGPY_RE.test(head.t)) {
    // ./dag.py, ~/.claude/skills/dag/scripts/dag.py run as a program.
    dagpy(ctx, args)
    queueScript(ctx, head, 'other')

    return
  }
  if (!isSystem) {
    // ./install.sh, ~/bin/thing: a program whose contents we can only read, not run.
    queueScript(ctx, head, scriptKind(name, head.t))
    anyArgWrite(ctx, name, args, fed)

    return
  }

  if (SHELLS.has(name)) {
    shell(ctx, name, args, stdinText)

    return
  }
  if (name === 'eval') {
    runNested(args.map(a => a.t).join(' '), ctx)
    if (args.some(a => a.dyn) && ctx.mentions) {
      unsure(ctx, "eval of a string I cannot fully resolve in a command that names the dag gate's files or dag.py")
    }

    return
  }
  if (name === 'source' || name === '.') {
    if (args[0] !== undefined) {
      // Sourcing a computed path is mostly an env file; it is not read, and not refused for being computed.
      queueScript(ctx, args[0], 'shell', false)
    }

    return
  }
  if (/^python[0-9.]*$/.test(name) || own(INTERP_CODE_FLAGS, name) !== undefined) {
    if (ctx.cwd === 1 && (ctx.cwdArea ?? 'state') === 'state') {
      // A program's relative paths land in the runner's state, and the reader cannot follow them through its code.
      push(ctx, { area: 'state', sure: false, why: `${name} runs while the shell sits inside ${placeName('state')}` })
    }
    interpreter(ctx, name, args, stdinText, piped)

    return
  }
  if (RUNNERS.has(name)) {
    // `uv run python dag.py ...`: what follows `run` (and its options) is the command.
    const at = args.findIndex(a => a.t === 'run')
    if (at !== -1) {
      let i = at + 1
      while (i < args.length && args[i].t.startsWith('-')) {
        i++
      }
      peel(ctx, args.slice(i), stdinText, fed, piped)
    }

    return
  }
  if (name === 'script') {
    scriptCmd(ctx, args, stdinText)

    return
  }
  if (RUNS_TEXT.has(name)) {
    codeFindings(ctx, `${name} command text`, args.map(a => a.t).join(' '))
    if (stdinText !== undefined) {
      codeFindings(ctx, `${name} fed commands`, stdinText)
    }

    return
  }
  if (name === 'sed' || name === 'gsed' || name === 'awk' || name === 'gawk' || name === 'mawk' || name === 'nawk') {
    sedAwk(ctx, name, args)

    return
  }
  if (name === 'xargs') {
    xargs(ctx, args)

    return
  }
  if (name === 'find' || name === 'gfind') {
    find(ctx, args)

    return
  }
  if (name === 'cd' || name === 'pushd' || name === 'chdir' || name === 'popd') {
    changeDir(ctx, name, args.find(a => !isFlag(a)) ?? args.find(a => a.t === '-'))

    return
  }
  if (COPY_DEST.has(name)) {
    copyDest(ctx, name, args)

    return
  }
  if (name === 'tee') {
    for (const a of args.filter(x => !isFlag(x))) {
      writeTarget(ctx, a, 'tee')
    }

    return
  }
  if (name === 'dd') {
    for (const a of args) {
      if (a.t.startsWith('of=')) {
        writeTarget(ctx, { ...a, t: a.t.slice(3), alts: a.alts.map(x => x.slice(3)) }, 'dd of=')
      }
    }

    return
  }
  if (name === 'git') {
    git(ctx, args)

    return
  }
  if (name === 'open') {
    openCmd(ctx, args)

    return
  }
  if (READONLY.has(name)) {
    if (OUTPUT_FLAG.has(name)) {
      args.forEach((a, n) => {
        if ((a.t === '-o' || a.t === '--output') && args[n + 1] !== undefined) {
          writeTarget(ctx, args[n + 1], `${name} ${a.t}`)
        } else if (a.t.startsWith('--output=') || (a.t.startsWith('-o') && a.t.length > 2)) {
          const v = flagValue(a)
          if (v !== undefined) {
            writeTarget(ctx, v, `${name} -o`)
          }
        }
      })
    }

    return
  }

  // Anything else may write any path it is given.
  anyArgWrite(ctx, name, args, fed)
  if (ctx.cwd === 1) {
    const place = ctx.cwdArea ?? 'state'
    push(ctx, { area: place, sure: false, why: `${name} runs while the shell sits inside ${placeName(place)}, and is not known to be read-only` })
  }
}

/** cd, pushd, popd, chdir: where the shell is afterwards, as far as this reader can tell. */
const changeDir = (ctx: Ctx, name: string, target: Word | undefined): void => {
  if (name === 'popd' || (name === 'pushd' && target === undefined)) {
    // Back to a directory this command never named.
    ctx.cwdPath = null
    ctx.cwd = ctx.cwd === 0 ? 2 : ctx.cwd

    return
  }
  if (target === undefined) {
    ctx.cwd = 0
    ctx.cwdArea = undefined
    ctx.cwdPath = '~'

    return
  }
  const literal = !target.dyn && target.t !== '-'
  let where: string | null = null
  if (literal) {
    if (!isRelative(target.t)) {
      where = normalizePath(target.t)
    } else if (typeof ctx.cwdPath === 'string') {
      where = normalizePath(`${ctx.cwdPath}/${target.t}`)
    }
  }
  const area = where !== null ? areaOf(ctx, where) : target.alts.map(t => areaOf(ctx, t)).find(a => a !== undefined)
  if (area !== undefined || target.hitState || target.hitFrozen) {
    ctx.cwd = 1
    ctx.cwdArea = area ?? (target.hitState ? 'state' : 'frozen')
  } else if (where !== null) {
    ctx.cwd = 0
    ctx.cwdArea = undefined
  } else if (target.dyn && (ctx.mentionsState || ctx.mentionsFrozen)) {
    // `cd "$JOB/.dag"`-like: a computed place in a command that names the protected ones.
    ctx.cwd = 1
    ctx.cwdArea = ctx.mentionsState ? 'state' : 'frozen'
  } else {
    // `cd "$(...)"`, `cd -`, `cd sub` from an unknown place: somewhere this reader cannot name.
    ctx.cwd = 2
    ctx.cwdArea = undefined
  }
  ctx.cwdPath = where
}

/** dag.py itself: the subcommand decides. approve and resume are the person's. */
const dagpy = (ctx: Ctx, args: Word[]): void => {
  let i = 0
  while (i < args.length) {
    const t = args[i].t
    if (t === '--') {
      i++
      break
    }
    if (t.startsWith('-') && t.length > 1) {
      // --spec takes a value; argparse also takes it shortened (--sp) or attached (--spec=x).
      i += !t.includes('=') && t.length >= 3 && '--spec'.startsWith(t) ? 2 : 1
      continue
    }
    break
  }
  const sub = args[i]
  if (sub === undefined) {
    return
  }
  if (sub.dyn) {
    push(ctx, { area: 'person', sure: false, why: `dag.py with a subcommand I cannot resolve (${short(sub.t)})` })

    return
  }
  for (const word of sub.alts.map(a => a.toLowerCase())) {
    const verb = PERSON_SUBS.find(p => p === word || (word.length >= 3 && p.startsWith(word)))
    if (verb !== undefined) {
      push(ctx, { area: 'person', sure: true, verb, why: `dag.py ${verb}` })

      return
    }
  }
}

const shell = (ctx: Ctx, name: string, args: Word[], stdinText: string | undefined): void => {
  let i = 0
  let code: Word | undefined
  let script: Word | undefined
  /** The program's own arguments ($0, $1, ...): what `"$1"` inside it turns into, which no reading of it can name. */
  let positional: Word[] = []
  while (i < args.length) {
    const t = args[i].t
    if (t === '--') {
      i++
      if (args[i] !== undefined && code === undefined) {
        script = args[i]
        positional = args.slice(i + 1)
      }
      break
    }
    if (t === '-o' || t === '+o' || t === '-O' || t === '+O' || t === '--rcfile' || t === '--init-file') {
      i += 2
      continue
    }
    if (/^-[A-Za-z]+$/.test(t) && t.slice(1).includes('c')) {
      code = args[i + 1]
      positional = args.slice(i + 2)
      break
    }
    if (/^-[A-Za-z]+$/.test(t) && t.slice(1).includes('s')) {
      // `-s`: the program comes from stdin and every word after this one is an argument.
      positional = args.slice(i + 1)
      break
    }
    if (t.startsWith('-') || t.startsWith('+')) {
      i++
      continue
    }
    script = args[i]
    positional = args.slice(i + 1)
    break
  }
  anyArgWrite(ctx, name, positional)
  if (code !== undefined) {
    runNested(code.t, ctx)
    if (code.dyn && ctx.mentions) {
      unsure(ctx, `${name} -c with a string I cannot fully resolve in a command that names the dag gate's files or dag.py`)
    }

    return
  }
  if (script !== undefined) {
    queueScript(ctx, script, 'shell')

    return
  }
  if (stdinText !== undefined) {
    runNested(stdinText, ctx)

    return
  }
  if (ctx.mentions) {
    unsure(ctx, `${name} reading commands from stdin in a command that names the dag gate's files or dag.py`)
  }
}

/**
 * Program text (an inline -c, a heredoc, a piped or read script, a line handed to tmux or ssh): what it names once
 * the language's own string-gluing is undone: quotes, `+`, commas, whitespace, or the words simply set apart.
 */
const codeFindings = (ctx: Ctx, what: string, code: string): void => {
  const flat = code.replace(/['"\\+,\s]/g, '')
  // Glued line by line too: gluing across lines runs `'.' + 'dag'` into the next statement.
  const lines = code.replace(/['"\\+,\t ]/g, '')
  const texts = [code, flat, lines, decodeAnsiC(flat)]
  if (texts.some(t => DAGPY_TEXT_RE.test(t)) && texts.some(t => /approve|resume/i.test(t))) {
    push(ctx, { area: 'person', sure: false, why: `${what} that names dag.py and approve or resume` })
  }
  if (texts.some(t => STATE_TEXT_RE.test(t))) {
    push(ctx, { area: 'state', sure: false, why: `${what} that names a .dag folder (cannot be proven read-only)` })
  }
  if (texts.some(t => LEDGER_TEXT_RE.test(t))) {
    push(ctx, { area: 'state', sure: false, why: `${what} that names the spent ledger or DAG_GATE_HOME (cannot be proven read-only)` })
  }
  const globbed = codeGlobs(texts)
  if (globbed.state !== undefined) {
    push(ctx, { area: 'state', sure: false, why: `${what} with a glob (${short(globbed.state)}) that could reach a .dag folder or the spent ledger` })
  }
  if (globbed.frozen !== undefined) {
    push(ctx, { area: 'frozen', sure: false, why: `${what} with a glob (${short(globbed.frozen)}) that could reach the frozen dag files` })
  }
  const named = code.replace(RUNNER_PATH_RE, 'dag.py')
  if (FROZEN_TEXT_RE.test(named) || FROZEN_TEXT_RE.test(named.replace(/['"\\+,\s]/g, '')) || (/\bskills\b/i.test(named) && /['"/]dag['"/]/i.test(named)) || /dag-gate/i.test(named)) {
    push(ctx, { area: 'frozen', sure: false, why: `${what} that names the frozen dag files (cannot be proven read-only)` })
  }
}

const interpreter = (ctx: Ctx, name: string, args: Word[], stdinText: string | undefined, piped = ''): void => {
  const isPython = /^python/.test(name)
  const flags = isPython ? ['-c'] : own(INTERP_CODE_FLAGS, name) ?? []
  const inPlace = (name === 'perl' || name === 'ruby') && args.some(a => /^-[A-Za-z]*i/.test(a.t))
  const codes: string[] = []
  const used = new Set<number>()
  let script: Word | undefined
  let module: Word | undefined
  let rest: Word[] = []
  /** After a lone `-` (the program comes from stdin): the program's own arguments. */
  let stdinArgs: Word[] | undefined
  for (let i = 0; i < args.length; i++) {
    const t = args[i].t
    if (flags.includes(t)) {
      if (args[i + 1] !== undefined) {
        codes.push(args[i + 1].t)
        used.add(i + 1)
      }
      i++
      continue
    }
    const attached = flags.find(f => f.length === 2 && t.startsWith(f) && t.length > 2 && f !== '-p')
    if (attached !== undefined) {
      codes.push(t.slice(2))
      used.add(i)
      continue
    }
    if (t === '-m' && isPython) {
      module = args[i + 1]
      rest = args.slice(i + 2)
      break
    }
    if (isPython && PY_VALUE_FLAGS.has(t)) {
      i++
      continue
    }
    if (t === '-' && codes.length === 0) {
      stdinArgs = args.slice(i + 1)
      break
    }
    if (t.startsWith('-')) {
      continue
    }
    if (codes.length === 0) {
      script = args[i]
      rest = args.slice(i + 1)
    }
    break
  }
  for (const code of codes) {
    codeFindings(ctx, `inline ${name} code`, code)
  }
  if (inPlace) {
    args.forEach((a, n) => {
      if (!used.has(n) && !isFlag(a)) {
        writeTarget(ctx, a, `${name} -i`)
      }
    })
  }
  if (codes.length > 0) {
    // What follows the code is its argv: a path handed to code nobody can read may be written.
    anyArgWrite(ctx, `inline ${name} code`, args.filter((a, n) => !used.has(n) && !flags.includes(a.t)))

    return
  }
  if (stdinArgs !== undefined) {
    anyArgWrite(ctx, `${name} reading a program from stdin`, stdinArgs)
  }
  if (module !== undefined) {
    moduleRun(ctx, name, module, rest)

    return
  }
  if (script !== undefined) {
    if (script.dyn) {
      queueScript(ctx, script, 'other')
      const word = rest.find(a => PERSON_SUBS.includes(a.t.toLowerCase()))
      if (word !== undefined) {
        push(ctx, { area: 'person', sure: false, why: `${name} runs a script I cannot resolve (${short(script.t)}) with ${word.t}` })
      }

      return
    }
    if (DAGPY_RE.test(script.t)) {
      dagpy(ctx, rest)
    }
    if (areaOf(ctx, script.t) !== 'frozen') {
      queueScript(ctx, script, 'other')
      anyArgWrite(ctx, lowerBase(script.t), rest)
    }

    return
  }
  const fedText = (stdinText ?? '') + piped
  if (stdinText !== undefined || piped !== '') {
    codeFindings(ctx, `${name} fed a program`, fedText)

    return
  }
  if (ctx.mentions) {
    unsure(ctx, `${name} reading a program from stdin in a command that names the dag gate's files or dag.py`)
  }
}

/** `python -m <module>`: `-m dag` is the runner; test runners and linters only read; anything else may write its arguments. */
const moduleRun = (ctx: Ctx, name: string, module: Word, rest: Word[]): void => {
  if (module.dyn) {
    if (ctx.mentions) {
      unsure(ctx, `${name} -m with a module I cannot resolve (${short(module.t)}) in a command that names the dag gate's files or dag.py`)
    }

    return
  }
  const m = module.t.toLowerCase()
  if (m === 'dag') {
    dagpy(ctx, rest)

    return
  }
  if (!SAFE_MODULES.has(m)) {
    anyArgWrite(ctx, `${name} -m ${m}`, rest)
  }
}

const sedAwk = (ctx: Ctx, name: string, args: Word[]): void => {
  const inPlace = name.endsWith('sed') && args.some(a => /^-[A-Za-z]*i/.test(a.t) || a.t === '--in-place' || a.t.startsWith('--in-place='))
  if (inPlace) {
    anyArgWrite(ctx, `${name} -i`, args)

    return
  }
  // A sed `w` command or an awk `print >` writes from inside the program text.
  for (const a of args) {
    if (!isFlag(a) && /[\s;{}]/.test(a.t)) {
      codeFindings(ctx, `${name} program text`, a.t)
    }
  }
}

const xargs = (ctx: Ctx, args: Word[]): void => {
  const VAL = new Set(['-I', '-n', '-L', '-l', '-P', '-s', '-E', '-e', '-d', '-a', '-J', '-R', '-S'])
  let i = 0
  while (i < args.length) {
    const t = args[i].t
    if (t === '--') {
      i++
      break
    }
    if (t.startsWith('-') && t.length > 1) {
      i += VAL.has(t) ? 2 : 1
      continue
    }
    break
  }
  const rest = args.slice(i)
  if (rest.length > 0) {
    peel(ctx, rest, undefined, true)
  }
}

const FIND_NAMES = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex'])

const find = (ctx: Ctx, args: Word[]): void => {
  const starts: Word[] = []
  let i = 0
  while (i < args.length) {
    const t = args[i].t
    if (/^-[HLPEXdsx]+$/.test(t)) {
      i++
      continue
    }
    if (t === '-f' && args[i + 1] !== undefined) {
      starts.push(args[i + 1])
      i += 2
      continue
    }
    if (t.startsWith('-') || t === '(' || t === '!' || t === ')') {
      break
    }
    starts.push(args[i])
    i++
  }
  const exprs = args.slice(i)
  let changes = false
  for (let j = 0; j < exprs.length; j++) {
    const t = exprs[j].t
    if (t === '-exec' || t === '-execdir' || t === '-ok' || t === '-okdir') {
      let k = j + 1
      const inner: Word[] = []
      while (k < exprs.length && exprs[k].t !== ';' && exprs[k].t !== '+') {
        inner.push(exprs[k])
        k++
      }
      if (inner.length > 0) {
        peel(ctx, inner, undefined, true)
      }
      changes = true
      j = k
    } else if (t === '-fprint' || t === '-fprint0' || t === '-fprintf' || t === '-fls') {
      if (exprs[j + 1] !== undefined) {
        writeTarget(ctx, exprs[j + 1], `find ${t}`)
      }
    } else if (t === '-delete') {
      changes = true
    }
  }
  if (!changes) {
    return
  }
  for (const s of starts) {
    writeTarget(ctx, s, 'find -delete or -exec under')
    for (const t of s.alts) {
      const area = holds(ctx, t)
      if (area !== undefined) {
        push(ctx, { area, sure: false, why: `find -delete or -exec under ${short(t)}, which holds ${heldBy(area)}` })
        break
      }
    }
  }
  const named = exprs.filter((_w, n) => n > 0 && FIND_NAMES.has(exprs[n - 1].t))
  if (named.some(w => STATE_TEXT_RE.test(w.t) || /^(state\.json|stop|events\.jsonl|approvals|gates|receipts)$/i.test(w.t))) {
    push(ctx, { area: 'state', sure: false, why: "find that deletes or runs a command on a dag runner's files" })
  }
}

const copyDest = (ctx: Ctx, name: string, args: Word[]): void => {
  if (name === 'rsync' && args.some(a => a.t === '--remove-source-files')) {
    anyArgWrite(ctx, name, args)

    return
  }
  const nonFlag: Word[] = []
  let target: Word | undefined
  for (let i = 0; i < args.length; i++) {
    const t = args[i].t
    if (t === '-t' || t === '--target-directory') {
      target = args[i + 1]
      i++
      continue
    }
    if (t.startsWith('--target-directory=')) {
      target = { ...args[i], t: t.slice(19), alts: args[i].alts.map(x => x.slice(19)) }
      continue
    }
    if (isFlag(args[i])) {
      continue
    }
    nonFlag.push(args[i])
  }
  const dest = target ?? nonFlag[nonFlag.length - 1]
  if (dest === undefined) {
    return
  }
  if (target === undefined && nonFlag.length === 2 && !nonFlag[0].dyn && !nonFlag[0].glob && !dest.dyn && !dest.glob) {
    ctx.aliases.set(fileKey(ctx, dest.t), resolveIn(ctx, nonFlag[0].t))
  }
  writeTarget(ctx, dest, `${name} into`)
}

/** git: only the subcommands that rewrite the work tree write, and they write the paths named or the whole tree. */
const git = (ctx: Ctx, args: Word[]): void => {
  let dir: Word | undefined
  let i = 0
  while (i < args.length) {
    const t = args[i].t
    if (t === '-C' || t === '--work-tree') {
      dir = args[i + 1]
      i += 2
      continue
    }
    if (t.startsWith('--work-tree=')) {
      dir = { ...args[i], t: t.slice(12), alts: args[i].alts.map(x => x.slice(12)) }
      i++
      continue
    }
    if (t === '-c' || t === '--git-dir' || t === '--namespace' || t === '--exec-path' || t === '--config-env') {
      i += 2
      continue
    }
    if (t.startsWith('-')) {
      i++
      continue
    }
    break
  }
  const sub = args[i]
  if (sub === undefined) {
    return
  }
  if (sub.dyn) {
    if (ctx.mentionsState || ctx.mentionsFrozen) {
      unsure(ctx, `git with a subcommand I cannot resolve (${short(sub.t)})`, namedAreas(ctx, true))
    }

    return
  }
  const verb = sub.t.toLowerCase()
  if (!GIT_WRITERS.has(verb)) {
    return
  }
  for (const a of args.slice(i + 1)) {
    if (!isFlag(a)) {
      writeTarget(ctx, a, `git ${verb}`)
    }
  }
  if (verb === 'clone') {
    // A clone writes only its new folder, judged above; the tree it starts in is untouched.
    return
  }
  const where = dir === undefined ? ctx.cwdPath : dir.dyn ? null : resolveIn(ctx, dir.t)
  if (typeof where === 'string') {
    const found = [areaOf(ctx, where), holds(ctx, where)]
    const area = found.includes('state') ? 'state' : found.find(a => a !== undefined)
    if (area !== undefined) {
      push(ctx, { area, sure: false, why: `git ${verb} in ${short(where)}, a tree that holds protected dag files` })
    }
  } else if (ctx.cwd === 1) {
    const place = ctx.cwdArea ?? 'state'
    push(ctx, { area: place, sure: false, why: `git ${verb} while the shell sits inside ${placeName(place)}` })
  }
}

/** open(1) runs a `.command` or `.sh` file in a new Terminal, a real terminal: read the file like any script. */
const openCmd = (ctx: Ctx, args: Word[]): void => {
  for (const a of args) {
    if (!isFlag(a) && /\.(command|sh|bash|zsh|tool|scpt|applescript)$/i.test(a.t)) {
      queueScript(ctx, a, /\.(scpt|applescript)$/i.test(a.t) ? 'other' : 'shell')
    }
  }
  codeFindings(ctx, 'open arguments', args.map(a => a.t).join(' '))
}

/**
 * script(1) wraps a command in a pseudo-terminal: the classic way to fake the terminal dag.py approve wants.
 * macOS: script [-adkpqr] [-F pipe] [-t time] [file [command ...]]; util-linux: script [-c command] [file].
 */
const scriptCmd = (ctx: Ctx, args: Word[], stdinText: string | undefined): void => {
  let i = 0
  while (i < args.length) {
    const t = args[i].t
    if ((t === '-c' || t === '--command') && args[i + 1] !== undefined) {
      runNested(args[i + 1].t, ctx)
      i += 2
      continue
    }
    if (t === '-F' || t === '-t' || t === '-T' || t === '-I' || t === '-O' || t === '-B' || t === '-E' || t === '-m') {
      i += 2
      continue
    }
    if (t.startsWith('-')) {
      i++
      continue
    }
    break
  }
  const file = args[i]
  if (file === undefined) {
    return
  }
  writeTarget(ctx, file, 'script transcript')
  const inner = args.slice(i + 1)
  if (inner.length > 0) {
    peel(ctx, inner, undefined, false)
  } else if (stdinText !== undefined) {
    runNested(stdinText, ctx)
  }
}

/** Quotes, backslashes and expansions removed: what a command says once the shell has glued it together. */
const deobfuscate = (command: string): string =>
  command
    .replace(/\$'((?:[^'\\]|\\[\s\S])*)'/g, (_m, body: string) => decodeAnsiC(body))
    .replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, '')
    .replace(/['"\\`]/g, '')

/** Reads a command string. `scripts` lists files it would run, for the caller to read and pass to {@link analyzeScript}. */
export const analyze = (
  command: string,
  options: {
    /** Where the shell is, absolute, when known; relative paths and `cd`s resolve against it. null: unknown. */
    cwd?: string | null
    /** How sure an earlier call left the gate that the shell sits in a protected place, when `cwd` cannot say. */
    level?: CwdLevel
    /** Which place, at level 1. */
    area?: Area
    /** The person's home directory, for comparing `~/x` with `/Users/me/x`. */
    home?: string
    /** Absolute frozen roots beyond the fixed ones: where this mod is installed. */
    frozen?: readonly string[]
  } = {},
): Analysis => {
  const plain = command
  const bare = deobfuscate(command)
  const texts = [plain, bare]
  const named = texts.map(t => t.replace(RUNNER_PATH_RE, 'dag.py'))
  const frozen = (options.frozen ?? []).map(r => normalizePath(r))
  const ctx: Ctx = {
    findings: [],
    scripts: [],
    mentions: texts.some(t => STATE_TEXT_RE.test(t) || FROZEN_TEXT_RE.test(t) || DAGPY_TEXT_RE.test(t) || /dag-gate|DAG_GATE_HOME/i.test(t)) || frozen.some(r => plain.includes(r)),
    mentionsState: texts.some(t => STATE_TEXT_RE.test(t) || LEDGER_TEXT_RE.test(t)),
    mentionsFrozen: named.some(t => FROZEN_TEXT_RE.test(t) || FROZEN_RE.test(t)) || frozen.some(r => plain.includes(r)),
    mentionsPerson: texts.some(t => DAGPY_TEXT_RE.test(t)) && texts.some(t => PERSON_WORD_RE.test(t)),
    mentionsRunner: texts.some(t => DAGPY_TEXT_RE.test(t)),
    runsOther: false,
    env: new Map([['HOME', '~']]),
    cwd: 0,
    cwdArea: undefined,
    cwdPath: options.cwd,
    home: options.home,
    frozen,
    written: new Map(),
    aliases: new Map(),
    cur: undefined,
    depth: 0,
  }
  if (typeof options.cwd === 'string') {
    ctx.cwdArea = areaOf(ctx, options.cwd)
    ctx.cwd = ctx.cwdArea === undefined ? 0 : 1
  } else {
    ctx.cwd = options.level ?? (options.cwd === null ? 2 : 0)
    ctx.cwdArea = ctx.cwd === 1 ? options.area : undefined
  }
  run(command, ctx)
  if (ctx.runsOther && texts.some(t => BARE_GATE_HOME_RE.test(t))) {
    push(ctx, { area: 'state', sure: false, why: 'it names DAG_GATE_HOME, and a program it runs could inherit the variable' })
  }
  for (const script of ctx.scripts) {
    const body = ctx.written.get(fileKey(ctx, script.path))
    if (body !== undefined) {
      script.inline = body
    }
  }

  return {
    findings: ctx.findings,
    scripts: ctx.scripts,
    mentions: ctx.mentions,
    endLevel: ctx.cwd,
    endArea: ctx.cwdArea,
    endCwd: ctx.cwdPath,
  }
}

/** Words that, next to a `.dag` folder or a frozen path in a script, mean it may write there. */
const SCRIPT_WRITES = /(shutil|copy|copyfile|move|rename|replace|unlink|remove|rmtree|symlink|write|open\s*\(|touch|mkdir|\bcp\s|\bmv\s|\brm\s|\btee\s|>\s*\S)/i

/** Text of a script a command runs. Shell scripts get the full reader; others get a name-and-verb heuristic. */
export const analyzeScript = (
  text: string,
  kind: 'shell' | 'other',
  path: string,
  options: { cwd?: string | null; home?: string; frozen?: readonly string[] } = {},
): Finding[] => {
  const tag = (f: Finding): Finding => ({ ...f, sure: false, why: `script ${short(path)}: ${f.why}` })
  if (kind === 'shell' && !/^#!.*\b(python|perl|ruby|node|osascript)/.test(text)) {
    return analyze(text, options).findings.map(tag)
  }
  const out: Finding[] = []
  const flat = text.replace(/['"\\+,\s]/g, '')
  const lines = text.replace(/['"\\+,\t ]/g, '')
  if (/dag\.py[\s\S]{0,300}?\b(approve|resume)\b|\b(approve|resume)\b[\s\S]{0,300}?dag\.py/i.test(text) || /dag\.py[^\n]{0,160}?(approve|resume)/i.test(flat)) {
    out.push(tag({ area: 'person', sure: false, why: 'it runs dag.py approve or resume' }))
  }
  if ((STATE_TEXT_RE.test(text) || STATE_TEXT_RE.test(flat) || STATE_TEXT_RE.test(lines)) && SCRIPT_WRITES.test(text)) {
    out.push(tag({ area: 'state', sure: false, why: 'it names a .dag folder next to a write' }))
  }
  if (/DAG_GATE_HOME/.test(text) || ([text, flat, lines].some(t => LEDGER_TEXT_RE.test(t)) && SCRIPT_WRITES.test(text))) {
    out.push(tag({ area: 'state', sure: false, why: 'it names DAG_GATE_HOME, or the spent ledger next to a write' }))
  }
  const globbed = SCRIPT_WRITES.test(text) ? codeGlobs([text, flat]) : {}
  if (globbed.state !== undefined) {
    out.push(tag({ area: 'state', sure: false, why: `it globs ${short(globbed.state)}, which could reach a .dag folder or the spent ledger, next to a write` }))
  }
  if (globbed.frozen !== undefined) {
    out.push(tag({ area: 'frozen', sure: false, why: `it globs ${short(globbed.frozen)}, which could reach the frozen dag files, next to a write` }))
  }
  const named = text.replace(RUNNER_PATH_RE, 'dag.py')
  if (FROZEN_TEXT_RE.test(named) && SCRIPT_WRITES.test(text)) {
    out.push(tag({ area: 'frozen', sure: false, why: 'it names the frozen dag files next to a write' }))
  }

  return out
}

/** Whether a command's text is, after un-quoting, about the gate at all. Cheap, for the `.catch` handler. */
export const mentionsGate = (command: string): boolean =>
  [command, deobfuscate(command)].some(t => STATE_TEXT_RE.test(t) || FROZEN_TEXT_RE.test(t) || DAGPY_TEXT_RE.test(t) || /dag-gate|DAG_GATE_HOME/i.test(t))

/** The protected area a Write-class tool's path lands in, by its spelling; undefined when it is neither. */
export const pathArea = (path: string, frozen: readonly string[] = [], home?: string): Area | undefined => {
  const norm = normalizePath(path.replace(/\\/g, '/'))
  const expanded = home !== undefined && (norm === '~' || norm.startsWith('~/')) ? normalizePath(`${home}${norm.slice(1)}`) : norm
  if (STATE_RE.test(norm) || LEDGER_RE.test(norm)) {
    return 'state'
  }
  if (FROZEN_RE.test(norm) || frozen.some(r => under(expanded, normalizePath(r)))) {
    return 'frozen'
  }

  return undefined
}
