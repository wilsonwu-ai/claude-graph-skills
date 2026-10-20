/**
 * What the slash commands need to know about dag.py's files, as pure functions: the gate request /dag-approve
 * reads, the manifest whose digest it checks, and the approval record it writes. The formats are dag.py's
 * (~/.claude/skills/dag/references/spec.md, "Gates and approvals"); dag.py stays the judge of every record.
 */

/** A gate request, `.dag/gates/<gate>.json`, as dag.py files it. */
export type GateRequest = {
  dag: string
  dag_dir: string
  node: string
  digest: string
  files: { path: string; sha256: string }[]
  effects: { node: string; fingerprint: string }[]
  spec?: string
  manifest?: string
  summary?: string
  requested_at?: string
  not_before?: string
  reason?: string
}

/** A registry entry, `~/.claude/dag-gate/registry/<id>.json`: where a dag's folder is. */
export type RegistryEntry = { dag: string; dag_dir: string; spec?: string }

/** Who typed a person-only command: the prompt, or the person's phone or web client. */
export type PersonOrigin = 'composer' | 'bridge'

/** Node and dag names, as dag.py allows them. */
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/
const HEX64_RE = /^[0-9a-f]{64}$/

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const optional = (v: Record<string, unknown>, key: string): Record<string, string> =>
  typeof v[key] === 'string' ? { [key]: v[key] as string } : {}

const fileList = (v: unknown): GateRequest['files'] | undefined => {
  if (!Array.isArray(v)) {
    return undefined
  }
  const out: GateRequest['files'] = []
  for (const f of v) {
    if (!isObj(f) || typeof f.path !== 'string' || f.path === '' || typeof f.sha256 !== 'string' || !HEX64_RE.test(f.sha256)) {
      return undefined
    }
    out.push({ path: f.path, sha256: f.sha256 })
  }

  return out
}

const effectList = (v: unknown): GateRequest['effects'] | undefined => {
  if (!Array.isArray(v)) {
    return undefined
  }
  const out: GateRequest['effects'] = []
  for (const x of v) {
    if (!isObj(x) || typeof x.node !== 'string' || typeof x.fingerprint !== 'string') {
      return undefined
    }
    out.push({ node: x.node, fingerprint: x.fingerprint })
  }

  return out
}

/** A request read from disk, or undefined when it is not one dag.py would have written. */
export const asRequest = (v: unknown): GateRequest | undefined => {
  if (!isObj(v)) {
    return undefined
  }
  const { dag, dag_dir, node, digest } = v
  const files = fileList(v.files)
  const effects = effectList(v.effects)
  if (typeof dag !== 'string' || typeof dag_dir !== 'string' || typeof node !== 'string' || typeof digest !== 'string') {
    return undefined
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(digest) || files === undefined || effects === undefined || !dag_dir.startsWith('/')) {
    return undefined
  }

  return {
    dag,
    dag_dir,
    node,
    digest,
    files,
    effects,
    ...optional(v, 'spec'),
    ...optional(v, 'manifest'),
    ...optional(v, 'summary'),
    ...optional(v, 'requested_at'),
    ...optional(v, 'not_before'),
    ...optional(v, 'reason'),
  }
}

export const asRegistry = (v: unknown): RegistryEntry | undefined =>
  isObj(v) && typeof v.dag === 'string' && typeof v.dag_dir === 'string' && v.dag_dir.startsWith('/')
    ? { dag: v.dag, dag_dir: v.dag_dir.replace(/\/+$/, ''), ...optional(v, 'spec') }
    : undefined

export type ApproveArgs = { gate: string; hex: string; sel?: string }

/** `/dag-approve review f94adb`, optionally followed by a dag name or a folder. */
export const parseApprove = (raw: string): ApproveArgs | { error: string } => {
  const words = raw
    .trim()
    .split(/\s+/)
    .filter(w => w !== '')
    .map(w => w.replace(/^(['"])(.*)\1$/, '$2'))
  if (words.length < 2) {
    return { error: 'Type the gate and the hex from the NEXT line: /dag-approve <gate> <hex>, for example /dag-approve review f94adb.' }
  }
  if (words.length > 3) {
    return { error: 'Too many words. The form is /dag-approve <gate> <hex>, and a dag name or folder when two jobs share both.' }
  }
  const [gate, typed, sel] = words as [string, string, string | undefined]
  if (!NAME_RE.test(gate)) {
    return { error: `"${gate}" is not a gate name.` }
  }
  const hex = typed.toLowerCase().replace(/^sha256:/, '')
  if (!/^[0-9a-f]{6,64}$/.test(hex)) {
    return { error: `"${typed}" is not the hex from the NEXT line (6 or more of 0-9 and a-f).` }
  }

  return sel === undefined ? { gate, hex } : { gate, hex, sel }
}

/** Python sorts strings by code point; JavaScript's default sort compares UTF-16 units, which differ above U+FFFF. */
export const byCodePoint = (a: string, b: string): number => {
  const x = Array.from(a)
  const y = Array.from(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0)
    if (d !== 0) {
      return d
    }
  }

  return x.length - y.length
}

/** The manifest dag.py hashes for a gate, rebuilt from the request: every line ends in a newline. */
export const manifestOf = (req: GateRequest): string => {
  const lines = ['dag-gate/1', `dag ${req.dag}`, `node ${req.node}`]
  for (const f of [...req.files].sort((a, b) => byCodePoint(a.path, b.path))) {
    lines.push(`file ${f.sha256} ${f.path}`)
  }
  for (const x of [...req.effects].sort((a, b) => byCodePoint(a.node, b.node))) {
    lines.push(`effect ${x.node} ${x.fingerprint}`)
  }

  return `${lines.join('\n')}\n`
}

/** Lowercase hex of a digest. */
export const hex = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')

/** Bytes from standard base64, through `atob`, which every engine has. */
export const fromBase64 = (b64: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i)
  }

  return out
}

/** dag.py's time format: ISO 8601 to the millisecond, in UTC, with a Z. */
export const isoMs = (ms: number): string => new Date(ms).toISOString()

/** The approval record dag.py reads (`Engine.approval`): `via` says this mod wrote it and which channel typed it. */
export const approvalRecord = (req: GateRequest, approvedAt: string, origin: PersonOrigin): Record<string, unknown> => ({
  format: 1,
  dag: req.dag,
  node: req.node,
  digest: req.digest,
  files: req.files,
  effects: req.effects,
  approved_at: approvedAt,
  via: `dag-gate:/dag-approve (${origin})`,
  requested_at: req.requested_at ?? null,
  dag_dir: req.dag_dir,
})

/**
 * Whether an approval on file answers this request: the same digest, from an accepted writer, and newer than
 * `not_before` (set when dag.py re-files a request because an effect already used the approval before).
 */
export const answers = (existing: unknown, req: GateRequest): boolean => {
  if (!isObj(existing) || existing.revoked === true || existing.digest !== req.digest || existing.node !== req.node) {
    return false
  }
  // dag.py refuses an approval written for another job or folder (a copied job folder carries its approvals).
  if (existing.dag !== req.dag || existing.dag_dir !== req.dag_dir) {
    return false
  }
  const via = existing.via
  if (typeof via !== 'string' || !(via.startsWith('dag-gate:/dag-approve') || via.startsWith('dag.py approve (tty)'))) {
    return false
  }
  const at = typeof existing.approved_at === 'string' ? Date.parse(existing.approved_at) : NaN
  if (Number.isNaN(at)) {
    return false
  }

  return req.not_before === undefined || at > Date.parse(req.not_before)
}

/** Whether an effect already ran under this approval (`state.json` `spent`): then it releases nothing more. */
export const spent = (existing: unknown, req: GateRequest, state: unknown): boolean => {
  if (!isObj(existing) || !isObj(state) || !Array.isArray(state.spent)) {
    return false
  }

  return state.spent.some(s => isObj(s) && s.gate === req.node && s.digest === req.digest && s.approved_at === existing.approved_at)
}

/** Whether a registry entry is the one a selector names: its dag name, its folder, or the last part of its folder's path. */
export const selects = (r: RegistryEntry, sel: string, real?: string): boolean => {
  const s = sel.replace(/\/+$/, '')
  const tail = s.replace(/^\.\//, '')

  return r.dag === s || r.dag_dir === s || (real !== undefined && r.dag_dir === real.replace(/\/+$/, '')) || (tail !== '' && !tail.startsWith('/') && r.dag_dir.endsWith(`/${tail}`))
}
