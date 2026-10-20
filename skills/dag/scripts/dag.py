#!/usr/bin/env python3
"""dag.py: run a job as a directed acyclic graph.

Every node is one of three kinds:
  cmd   a command the runner executes
  task  work Claude does by hand, then reports with `dag.py done <node>`
  gate  a person reviews named files and approves with /dag-approve

The runner keeps its state in .dag/ next to the spec. It re-runs a node only
when the content it reads has changed (sha256, with early cutoff: an upstream
re-run that produces the same bytes stops there). Every approval is bound to
a digest of the files the person reviewed, so a changed file voids it. An
outside effect runs once per approval. Anyone can stop a job; only a person
can resume it or approve a gate. Each run appends a receipt to a hash chain.

Standard library only, Python 3.9 or newer.

    python3 dag.py [--spec dag.json] <command> [options]

Commands: init validate plan status run done why invalidate stop resume
approve revoke digest receipt verify mermaid. `<command> -h` for options.

Exit codes: 0 ok, 1 error or failed node, 2 blocked (a gate, a task, or a
node that needs a look), 3 stopped, 4 refused (a person-only command was run
by a program), 130 interrupted.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import difflib
import fcntl
import functools
import getpass
import glob as globmod
import graphlib
import hashlib
import heapq
import json
import os
import pwd
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import uuid

FORMAT = 1
MANIFEST_HEADER = "dag-gate/1"
APPROVE_VIA = ("dag-gate:/dag-approve", "dag.py approve (tty)")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
GLOB_RE = re.compile(r"[*?\[]")
TOP_KEYS = ("dag", "description", "nodes", "idempotent_targets")
NODE_KEYS = ("kind", "description", "run", "after", "order_only", "inputs", "outputs",
             "writes", "check", "idempotent", "retries", "timeout_s", "effect",
             "est_minutes", "env", "gate")
GATE_KEYS = ("review", "summary", "approver")
GATE_FORBIDS = ("run", "check", "inputs", "outputs", "writes", "effect", "retries",
                "idempotent", "env", "timeout_s")
KINDS = ("cmd", "task", "gate")
EFFECTS = ("irreversible", "external")
P_FLOOR = 0.7  # below this share of parallel work, a graph is mostly overhead

EXIT_OK, EXIT_FAIL, EXIT_BLOCKED, EXIT_STOPPED, EXIT_REFUSED = 0, 1, 2, 3, 4
EXIT_INTERRUPTED = 130

CURRENT, READY, STALE, FAILED = "current", "ready", "stale", "failed"
INTERRUPTED, WAITING, RUNNING, TASK = "interrupted", "waiting", "running", "task-ready"
AWAITING, NEEDS_APPROVAL, BLOCKED = "awaiting-approval", "needs-new-approval", "blocked"
RUNNABLE = (READY, STALE, FAILED)

HIDDEN_FILE = ("hidden edge: {a} and {b} both write {t} and nothing orders them. Give each "
               "its own path (or worktree), or add an edge so one runs after the other")
HIDDEN_TARGET = ("hidden edge: {a} and {b} both write {t} and nothing orders them. Fix it one "
                 "of three ways: give each its own target, add an edge so they run in order, "
                 "or, if a second apply is harmless, list {t} under idempotent_targets with "
                 "the reason")
PERSON_ONLY = ("{what} is for a person at an interactive terminal outside Claude Code.\n"
               "In Claude Code the person types: {slash}")

TEMPLATE = {
    "dag": "my-job",
    "description": "One line on what this job does.",
    "nodes": {
        "build": {"description": "Build the index from the inbox.",
                  "run": ["python3", "build_index.py"],
                  "inputs": ["inbox/*.md", "build_index.py"],
                  "outputs": ["out/index.json"], "idempotent": True, "retries": 1},
        "test": {"description": "Quality check on the index.", "after": ["build"],
                 "run": ["python3", "eval.py"], "inputs": ["out/index.json", "eval.py"]},
        "review": {"description": "A person reads the index before it ships.",
                   "after": ["test"],
                   "gate": {"review": ["out/index.json"],
                            "summary": "Approve the index that will go live.",
                            "approver": "Sam"}},
        "ship": {"description": "Copy the index live.", "after": ["review"],
                 "run": ["sh", "deploy.sh"], "inputs": ["out/index.json", "deploy.sh"],
                 "outputs": ["live/index.json"], "effect": "irreversible"},
    },
}


class DagError(Exception):
    """A problem the person or agent must fix; printed without a traceback."""


class Missing(Exception):
    """A declared file is not there."""


class Interrupted(Exception):
    """SIGTERM arrived while a run was in progress."""


# ---------------------------------------------------------------- helpers

def now_iso():
    t = dt.datetime.now(dt.timezone.utc)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(text):
    if not isinstance(text, str):
        return None
    t = text.strip()
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    try:
        d = dt.datetime.fromisoformat(t)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


def short_time(text):
    d = parse_iso(text)
    return d.astimezone().strftime("%Y-%m-%d %H:%M:%S") if d else "?"


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def read_json(path):
    """The parsed file, None when it is missing; ValueError when it is not JSON."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ValueError(f"{path} is not valid JSON ({e})") from None


def full_sync(fd):
    """fsync that reaches the disk on macOS too, where plain fsync stops at the drive cache."""
    if hasattr(fcntl, "F_FULLFSYNC"):
        try:
            fcntl.fcntl(fd, fcntl.F_FULLFSYNC)
            return
        except OSError:
            pass
    os.fsync(fd)


def write_text(path, text):
    """Write atomically: a temp file in the same folder, full sync, rename, sync the folder."""
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            full_sync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    try:
        dfd = os.open(folder, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(dfd)
    except OSError:
        pass
    finally:
        os.close(dfd)


def write_json(path, obj):
    write_text(path, json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n")


def is_glob(pattern):
    return GLOB_RE.search(pattern) is not None


def norm(base, pattern):
    """A spec path as a posix path relative to the spec's folder; a trailing / kept."""
    is_dir = pattern.endswith("/")
    full = pattern if os.path.isabs(pattern) else os.path.join(base, pattern)
    rel = os.path.relpath(os.path.normpath(full), base).replace(os.sep, "/")
    return rel + "/" if is_dir and not rel.endswith("/") else rel


@functools.lru_cache(maxsize=None)
def glob_regex(pattern):
    """Glob to regex: * and ? stay inside one folder, ** crosses folders."""
    out, i = [], 0
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
            continue
        if pattern.startswith("**", i):
            out.append(".*")
            i += 2
            continue
        if c == "*":
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        elif c == "[":
            j = pattern.find("]", i + 1)
            if j < 0:
                out.append(re.escape(c))
            else:
                body = pattern[i + 1:j].replace("\\", "\\\\")
                out.append("[" + ("^" + body[1:] if body.startswith("!") else body) + "]")
                i = j + 1
                continue
        else:
            out.append(re.escape(c))
        i += 1
    return re.compile("^" + "".join(out) + "$")


def literal_prefix(pattern):
    m = GLOB_RE.search(pattern)
    return pattern if m is None else pattern[:m.start()]


def path_overlaps(out, read):
    """Whether writing `out` (a file, or a folder ending in /) can change what a
    node reading `read` (a file, a folder or a glob) sees."""
    if out.endswith("/"):
        if read.endswith("/"):
            return read.startswith(out) or out.startswith(read)
        if is_glob(read):
            pre = literal_prefix(read)
            return pre.startswith(out) or out.startswith(pre)
        return read.startswith(out)
    if read.endswith("/"):
        return out.startswith(read)
    if is_glob(read):
        return glob_regex(read).match(out) is not None
    return out == read


def outputs_clash(a, b):
    return a == b or (a.endswith("/") and b.startswith(a)) or (b.endswith("/") and a.startswith(b))


def suggest(word, options):
    hit = difflib.get_close_matches(word, list(options), n=1)
    return f" (did you mean {hit[0]!r}?)" if hit else ""


def listing(items, limit=5):
    items = list(items)
    more = len(items) - limit
    return ", ".join(items[:limit]) + (f" and {more} more" if more > 0 else "")


def gate_manifest(dag, node, files, effects):
    """The text a gate digest hashes: the reviewed files, then the fingerprint of every
    outside effect the approval releases. The dag-gate mod builds the same text."""
    lines = [MANIFEST_HEADER, f"dag {dag}", f"node {node}"]
    lines += [f"file {sha} {path}" for path, sha in sorted(files.items())]
    lines += [f"effect {name} {fp}" for name, fp in sorted(effects.items())]
    return "\n".join(lines) + "\n"


def output_digest(outputs, fingerprint):
    return "sha256:" + sha256_text(canon(outputs)) if outputs else fingerprint


def file_diff(old, new):
    if isinstance(old, list):
        old = {f.get("path"): f.get("sha256") for f in old if isinstance(f, dict)}
    if not isinstance(old, dict):
        return ""
    parts = []
    changed = [p for p in new if p in old and old[p] != new[p]]
    added = [p for p in new if p not in old]
    gone = [p for p in old if p not in new]
    if changed:
        parts.append("changed " + listing(changed))
    if added:
        parts.append("new " + listing(added))
    if gone:
        parts.append("gone " + listing(gone))
    return "; ".join(parts)


def gate_home():
    # The account's home, not $HOME: a command that sets HOME must not find an empty spent ledger.
    return os.environ.get("DAG_GATE_HOME") or os.path.join(pwd.getpwuid(os.getuid()).pw_dir, ".claude", "dag-gate")


def fold(path):
    """A path as a case- and normalization-insensitive disk compares it."""
    return unicodedata.normalize("NFC", path).casefold()


def same_dir(a, b):
    """Whether absolute folder path `a` names folder `b`. realpath keeps the case a path was typed in, so on a
    case- or normalization-insensitive disk two spellings of one folder differ as strings but share an inode.
    Only such spellings count, never a link at another path, so an accepted approval shares the spent ledger."""
    if a == b:
        return True
    if not isinstance(a, str) or not os.path.isabs(a) or fold(a) != fold(b):
        return False
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def person_at_terminal():
    return not os.environ.get("CLAUDECODE") and sys.stdin.isatty() and sys.stdout.isatty()


def tilde(path):
    home = os.path.expanduser("~")
    if path == home or path.startswith(home + os.sep):
        rest = path[len(home) + 1:]
        return "~/" + shlex.quote(rest) if rest else "~"
    return shlex.quote(path)


def display(path):
    cwd = os.getcwd()
    if path.startswith(cwd + os.sep):
        return shlex.quote(os.path.relpath(path, cwd))
    return tilde(path)


# ---------------------------------------------------------------- the spec

class Node:
    def __init__(self, name):
        self.name = name
        self.kind = "task"
        self.description = ""
        self.run = None
        self.check = None
        self.after = []
        self.order_only = []
        self.inputs = []
        self.outputs = []
        self.writes = []
        self.idempotent = False
        self.retries = 0
        self.timeout_s = None
        self.effect = None
        self.est = 1.0
        self.env = {}
        self.gate = None

    @property
    def deps(self):
        return self.after + [d for d in self.order_only if d not in self.after]

    def exec_spec(self):
        """What changes the result; part of the fingerprint."""
        return {"kind": self.kind, "run": self.run, "check": self.check, "env": self.env,
                "inputs": self.inputs, "outputs": self.outputs, "writes": self.writes,
                "effect": self.effect}


class Spec:
    def __init__(self, path):
        self.path = os.path.realpath(path)
        self.base = os.path.dirname(self.path)
        try:
            with open(self.path, "rb") as f:
                raw = f.read()
        except FileNotFoundError:
            raise DagError(f"no spec at {path}: write one, or run dag.py init") from None
        self.sha256 = hashlib.sha256(raw).hexdigest()
        try:
            self.data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise DagError(f"{path} is not valid JSON ({e})") from None
        self.errors, self.warnings = [], []
        self.name, self.description, self.idempotent_targets = "dag", "", {}
        self.nodes, self.waves, self.order = {}, [], []
        self.anc, self.desc, self.kids, self.covers = {}, {}, {}, {}
        self._parse()
        if self.nodes:
            self._graph()

    def err(self, msg):
        self.errors.append(msg)

    def warn(self, msg):
        self.warnings.append(msg)

    # parsing

    def _parse(self):
        d = self.data
        if not isinstance(d, dict):
            self.err('the spec must be a JSON object with "dag" and "nodes"')
            return
        for k in d:
            if k not in TOP_KEYS:
                self.err(f"unknown top-level key {k!r}{suggest(k, TOP_KEYS)}")
        name = d.get("dag")
        if isinstance(name, str) and NAME_RE.match(name):
            self.name = name
        else:
            self.err('"dag" must be a short name: letters, digits, dot, dash, underscore')
        desc = d.get("description", "")
        self.description = desc if isinstance(desc, str) else ""
        targets = d.get("idempotent_targets", {})
        if isinstance(targets, dict) and all(
                isinstance(k, str) and isinstance(v, str) and v.strip() for k, v in targets.items()):
            self.idempotent_targets = targets
        else:
            self.err('"idempotent_targets" maps each shared write target to the reason a second apply is harmless')
        nodes = d.get("nodes")
        if not isinstance(nodes, dict) or not nodes:
            self.err('"nodes" must be an object with at least one node')
            return
        for name, raw in nodes.items():
            self._node(name, raw)

    def _list(self, raw, key, where):
        v = raw.get(key, [])
        if not isinstance(v, list) or not all(isinstance(x, str) and x for x in v):
            self.err(f"{where}: {key} must be a list of non-empty strings")
            return []
        if len(set(v)) != len(v):
            self.warn(f"{where}: {key} lists something twice")
        return list(dict.fromkeys(v))

    def _command(self, v, where):
        if isinstance(v, str) and v.strip():
            return v
        if isinstance(v, list) and v and all(isinstance(x, str) for x in v) and v[0]:
            return list(v)
        self.err(f"{where} must be a list of arguments or a shell string")
        return None

    def _number(self, raw, key, where, default, ok, msg):
        v = raw.get(key, default)
        if v is default:
            return v
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not ok(v):
            self.err(f"{where}: {msg}")
            return default
        return v

    def _node(self, name, raw):
        where = f"node {name}"
        if not isinstance(name, str) or not NAME_RE.match(name):
            self.err(f"{where}: names use letters, digits, dot, dash, underscore (64 at most)")
            return
        if not isinstance(raw, dict):
            self.err(f"{where}: must be an object")
            return
        for k in raw:
            if k not in NODE_KEYS:
                self.err(f"{where}: unknown key {k!r}{suggest(k, NODE_KEYS)}")
        n = Node(name)
        inferred = "gate" if "gate" in raw else "cmd" if "run" in raw else "task"
        kind = raw.get("kind", inferred)
        if kind not in KINDS:
            self.err(f"{where}: kind must be cmd, task or gate")
            kind = inferred
        elif kind != inferred:
            self.err(f"{where}: kind {kind} does not fit its keys (a cmd has run, a gate has gate, a task has neither)")
        n.kind = kind
        desc = raw.get("description", "")
        n.description = desc if isinstance(desc, str) else ""
        if "run" in raw:
            n.run = self._command(raw["run"], f"{where}: run")
        if "check" in raw:
            n.check = self._command(raw["check"], f"{where}: check")
        n.after = self._list(raw, "after", where)
        n.order_only = self._list(raw, "order_only", where)
        n.inputs = [norm(self.base, p) for p in self._list(raw, "inputs", where)]
        n.outputs = [norm(self.base, p) for p in self._list(raw, "outputs", where)]
        for o in n.outputs:
            if is_glob(o):
                self.err(f"{where}: output {o!r} is a glob; list each file, or a folder ending in /")
        n.writes = self._list(raw, "writes", where)
        idem = raw.get("idempotent", False)
        if not isinstance(idem, bool):
            self.err(f"{where}: idempotent must be true or false")
            idem = False
        n.idempotent = idem
        n.retries = self._number(raw, "retries", where, 0,
                                 lambda v: isinstance(v, int) and 0 <= v <= 10,
                                 "retries must be a whole number from 0 to 10")
        if n.retries and not n.idempotent:
            self.err(f'{where}: retries need "idempotent": true; only a step that is safe to repeat may be retried')
        n.timeout_s = self._number(raw, "timeout_s", where, None, lambda v: v > 0,
                                   "timeout_s must be a positive number of seconds")
        effect = raw.get("effect")
        if effect is not None and effect not in EFFECTS:
            self.err(f"{where}: effect must be irreversible or external")
            effect = None
        n.effect = effect
        n.est = float(self._number(raw, "est_minutes", where, 0 if kind == "gate" else 1,
                                   lambda v: v >= 0, "est_minutes must be 0 or more"))
        env = raw.get("env", {})
        if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
            self.err(f"{where}: env maps names to string values")
            env = {}
        n.env = env
        if kind == "cmd" and n.run is None and "run" not in raw:
            self.err(f"{where}: a cmd node needs run")
        if kind == "gate":
            for k in GATE_FORBIDS:
                if k in raw:
                    self.err(f"{where}: a gate takes no {k}; it only waits for a person")
            g = raw.get("gate")
            if not isinstance(g, dict):
                self.err(f"{where}: gate must be an object with review, summary and approver")
                g = {}
            for k in g:
                if k not in GATE_KEYS:
                    self.err(f"{where}: unknown gate key {k!r}{suggest(k, GATE_KEYS)}")
            review = g.get("review")
            if not isinstance(review, list) or not review or not all(isinstance(x, str) and x for x in review):
                self.err(f"{where}: gate.review must list the files the person reviews")
                review = []
            for x in review:
                if "\n" in x or "\r" in x:
                    self.err(f"{where}: review path {x!r} has a line break")
            summary, approver = g.get("summary", ""), g.get("approver", "the approver")
            n.gate = {"review": [norm(self.base, x) for x in review],
                      "summary": summary if isinstance(summary, str) else "",
                      "approver": approver if isinstance(approver, str) and approver else "the approver"}
        self.nodes[name] = n

    # graph

    def _graph(self):
        names = self.nodes
        ok = True
        for n in names.values():
            for d in n.after + n.order_only:
                if d == n.name:
                    self.err(f"node {n.name}: depends on itself")
                    ok = False
                elif d not in names:
                    self.err(f"node {n.name}: depends on unknown node {d!r}{suggest(d, names)}")
                    ok = False
            both = sorted(set(n.after) & set(n.order_only))
            if both:
                self.err(f"node {n.name}: {', '.join(both)} is in both after and order_only")
        if not ok:
            return
        ts = graphlib.TopologicalSorter()
        for n in names.values():
            ts.add(n.name, *n.deps)
        try:
            ts.prepare()
        except graphlib.CycleError as e:
            self.err("cycle: " + " -> ".join(e.args[1]) + " (read each arrow as: must finish before)")
            return
        pos = {name: i for i, name in enumerate(names)}
        while ts.is_active():
            wave = sorted(ts.get_ready(), key=pos.get)
            self.waves.append(wave)
            ts.done(*wave)
        self.order = [x for wave in self.waves for x in wave]
        for name in self.order:
            anc = set()
            for d in names[name].deps:
                anc |= {d} | self.anc[d]
            self.anc[name] = anc
        self.desc = {name: set() for name in self.order}
        self.kids = {name: [] for name in self.order}
        for name in self.order:
            for a in self.anc[name]:
                self.desc[a].add(name)
            for d in names[name].deps:
                self.kids[d].append(name)
        self._rules()

    def _rules(self):
        nodes = self.nodes
        ordered = lambda a, b: a in self.anc[b] or b in self.anc[a]
        for n in nodes.values():
            if n.effect and not any(nodes[a].kind == "gate" for a in self.anc[n.name]):
                self.err(f"node {n.name}: effect {n.effect} with no gate upstream. A human gate is "
                         f"topology: add a gate node and put {n.name} after it")
        # A gate's approval covers an effect when only gates sit between them, so the
        # effect's fingerprint is known when the person approves and goes into the digest.
        for g in self.order:
            if nodes[g].kind == "gate":
                self.covers[g] = [e for e in self.order if nodes[e].effect and g in self.anc[e]
                                  and all(nodes[x].kind == "gate" for x in self.anc[e] - self.anc[g] - {g})]
        for e in self.order:
            gates = self.gate_ancestors(e)
            if nodes[e].effect and gates and not any(e in self.covers[g] for g in gates):
                g = gates[-1]
                between = [x for x in self.order if x in self.anc[e] and x not in self.anc[g]
                           and x != g and nodes[x].kind != "gate"]
                self.warn(f"{e}: {listing(between)} run after gate {g}, so no approval covers what "
                          f"they produce. Add a gate right before {e} if a person should see it")
        reads = {n.name: n.inputs + (n.gate["review"] if n.gate else []) for n in nodes.values()}
        for a in nodes.values():
            for o in a.outputs:
                for r in reads[a.name]:
                    if path_overlaps(o, r):
                        self.err(f"node {a.name}: reads {r} and writes {o}; a node cannot read its own output (split it in two)")
            for b in nodes.values():
                if b.name == a.name:
                    continue
                for o in a.outputs:
                    for r in reads[b.name]:
                        if not path_overlaps(o, r) or a.name in self.anc[b.name]:
                            continue
                        if b.name in self.anc[a.name]:
                            self.err(f"file cycle: {b.name} reads {r}, which {a.name} writes after it. "
                                     f"Write to a new path, or reverse the order")
                        else:
                            self.err(f"race: {b.name} reads {r} and {a.name} writes {o}, but nothing "
                                     f"orders them. Add {a.name} to {b.name}'s after")
        names = list(nodes)
        for i, x in enumerate(names):
            for y in names[i + 1:]:
                a, b = nodes[x], nodes[y]
                for o in a.outputs:
                    for p in b.outputs:
                        if outputs_clash(o, p):
                            if ordered(x, y):
                                self.err(f"{x} and {y} both write {min(o, p, key=len)}; give each output one owner")
                            else:
                                self.err(HIDDEN_FILE.format(a=x, b=y, t=min(o, p, key=len)))
                if not ordered(x, y):
                    for t in sorted(set(a.writes) & set(b.writes)):
                        if t not in self.idempotent_targets:
                            self.err(HIDDEN_TARGET.format(a=x, b=y, t=t))
        for b in nodes.values():
            if b.kind == "gate":
                continue
            for x in b.after:
                a = nodes[x]
                if a.kind == "gate":
                    continue
                if not a.outputs:
                    self.warn(f"{b.name} waits for {x}, but {x} declares no outputs, so the edge "
                              f"cannot be checked. If {b.name} only needs {x} to finish first, "
                              f"move {x} to order_only")
                elif not any(path_overlaps(o, r) for o in a.outputs for r in b.inputs):
                    self.warn(f"fake edge? {b.name} waits for {x} but reads none of its outputs "
                              f"({listing(a.outputs)}). Drop the edge if {b.name} does not need "
                              f"{x}'s result; move it to order_only if the order is real")
        for n in nodes.values():
            if n.kind == "cmd" and not n.inputs:
                self.warn(f"{n.name} declares no inputs: it runs once, then again only when an "
                          f"upstream node changes or you invalidate it")

    def closure(self, names):
        out = set()
        for name in names:
            if name not in self.nodes:
                raise DagError(f"unknown node {name!r}{suggest(name, self.nodes)}")
            out |= {name} | self.anc[name]
        return out

    def gate_ancestors(self, name):
        return [g for g in self.order if g in self.anc[name] and self.nodes[g].kind == "gate"]

    # sizing

    def critical_path(self):
        best, prev = {}, {}
        for name in self.order:
            n = self.nodes[name]
            p = max(n.deps, key=lambda d: best[d], default=None)
            best[name] = n.est + (best[p] if p else 0.0)
            prev[name] = p
        if not best:
            return [], 0.0
        end = max(self.order, key=lambda x: best[x])
        span, path = best[end], []
        while end:
            path.append(end)
            end = prev[end]
        return path[::-1], span

    def makespan(self, workers):
        """Greedy list scheduling, longest remaining path first."""
        bottom = {}
        for name in reversed(self.order):
            bottom[name] = self.nodes[name].est + max((bottom[k] for k in self.kids[name]), default=0.0)
        pos = {name: i for i, name in enumerate(self.order)}
        indeg = {name: len(self.nodes[name].deps) for name in self.order}
        ready = [(-bottom[x], pos[x], x) for x in self.order if indeg[x] == 0]
        heapq.heapify(ready)
        running, t, seq = [], 0.0, 0
        while ready or running:
            while ready and len(running) < workers:
                _, _, x = heapq.heappop(ready)
                seq += 1
                heapq.heappush(running, (t + self.nodes[x].est, seq, x))
            t, _, x = heapq.heappop(running)
            for k in self.kids[x]:
                indeg[k] -= 1
                if indeg[k] == 0:
                    heapq.heappush(ready, (-bottom[k], pos[k], k))
        return t


# ---------------------------------------------------------------- locking

class Lock:
    """One writer per job folder: fcntl.flock on .dag/lock."""

    def __init__(self, folder):
        self.path = os.path.join(folder, "lock")
        self.fd = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            try:
                pid = os.pread(self.fd, 32, 0).decode().strip()
            except OSError:
                pid = ""
            os.close(self.fd)
            self.fd = None
            raise DagError("another dag.py holds the lock" + (f" (pid {pid})" if pid else "") +
                           "; wait for it to finish, or set a stop with dag.py stop") from None
        os.ftruncate(self.fd, 0)
        os.pwrite(self.fd, str(os.getpid()).encode(), 0)
        return self

    def __exit__(self, *exc):
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None


def lock_busy(folder):
    path = os.path.join(folder, "lock")
    if not os.path.exists(path):
        return False
    fd = os.open(path, os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    else:
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


# ---------------------------------------------------------------- execution

CHILDREN = set()
CHILDREN_LOCK = threading.Lock()


def run_argv(cmd, cwd, env, log, timeout):
    argv = ["/bin/sh", "-c", cmd] if isinstance(cmd, str) else list(cmd)
    try:
        p = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=log,
                             stderr=subprocess.STDOUT, start_new_session=True)
    except OSError as e:
        log.write(f"cannot start: {e}\n")
        return 127, f"cannot start ({e.strerror})"
    with CHILDREN_LOCK:
        CHILDREN.add(p.pid)
    try:
        rc = p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        p.wait()
        return 124, f"timed out after {timeout:g}s"
    finally:
        with CHILDREN_LOCK:
            CHILDREN.discard(p.pid)
    return rc, f"exit {rc}"


def kill_children():
    with CHILDREN_LOCK:
        pids = list(CHILDREN)
    for pid in pids:
        try:
            os.killpg(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass


def execute(base, node, env, log_path, backoff):
    """Runs in a worker thread: the command, its retries, its declared outputs, its check."""
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    t0, attempts = time.time(), 0
    with open(log_path, "a", encoding="utf-8") as log:
        while True:
            attempts += 1
            log.write(f"=== {node.name} attempt {attempts} at {now_iso()}\n")
            log.flush()
            rc, why = run_argv(node.run, base, env, log, node.timeout_s)
            if rc == 0:
                missing = []
                for o in node.outputs:
                    full = os.path.normpath(os.path.join(base, o))
                    if not (os.path.isdir(full) if o.endswith("/") else os.path.isfile(full)):
                        missing.append(o)
                if missing:
                    rc, why = 1, "declared outputs missing after the run: " + listing(missing)
                elif node.check is not None:
                    log.write("=== check\n")
                    log.flush()
                    crc, cwhy = run_argv(node.check, base, env, log, node.timeout_s)
                    if crc != 0:
                        rc, why = crc, f"check failed ({cwhy})"
            if rc == 0:
                return {"ok": True, "attempts": attempts, "seconds": time.time() - t0}
            log.write(f"=== {why}\n")
            log.flush()
            if attempts <= node.retries:
                time.sleep(backoff * 2 ** (attempts - 1))
                continue
            return {"ok": False, "attempts": attempts, "seconds": time.time() - t0,
                    "exit_code": rc, "error": why}


def log_tail(path, lines=12):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.readlines()[-lines:]
    except OSError:
        return []


# ---------------------------------------------------------------- the engine

class View:
    """What one node looks like right now, and why."""

    def __init__(self, status="", detail=""):
        self.status, self.detail = status, detail
        self.fp = self.exec_sha = self.digest = None
        self.inputs, self.deps = {}, {}
        self.approval = self.request = None


class Engine:
    def __init__(self, spec, invocation):
        self.spec = spec
        self.dir = os.path.join(spec.base, ".dag")
        self.inv = invocation
        self.live_run = False
        self._hashes = {}
        try:
            st = read_json(self.path("state.json"))
        except ValueError as e:
            raise DagError(f"{e}; move it aside to start the job over") from None
        st = st if isinstance(st, dict) else {}
        st.setdefault("format", FORMAT)
        st.setdefault("dag", spec.name)
        st.setdefault("nodes", {})
        st.setdefault("spent", [])
        self.state = st

    def path(self, *parts):
        return os.path.join(self.dir, *parts)

    def ensure_dir(self):
        if not os.path.isdir(self.dir):
            os.makedirs(self.dir, exist_ok=True)
            write_text(self.path(".gitignore"), "*\n")

    def save(self):
        self.ensure_dir()
        write_json(self.path("state.json"), self.state)

    def event(self, kind, node=None, **data):
        self.ensure_dir()
        rec = {"at": now_iso(), "event": kind}
        if node:
            rec["node"] = node
        rec.update({k: v for k, v in data.items() if v is not None})
        with open(self.path("events.jsonl"), "a", encoding="utf-8") as f:
            f.write(canon(rec) + "\n")

    # files

    def _inside_state(self, full):
        full = os.path.abspath(full)
        return full == self.dir or full.startswith(self.dir + os.sep)

    def expand(self, patterns):
        found = {}

        def add(full):
            found[os.path.relpath(full, self.spec.base).replace(os.sep, "/")] = full

        for p in patterns:
            full = os.path.normpath(os.path.join(self.spec.base, p))
            if p.endswith("/"):
                if not os.path.isdir(full):
                    raise Missing(p)
                for root, dirs, files in os.walk(full):
                    dirs[:] = sorted(d for d in dirs if not self._inside_state(os.path.join(root, d)))
                    for f in sorted(files):
                        add(os.path.join(root, f))
            elif is_glob(p):
                for f in sorted(globmod.glob(full, recursive=True)):
                    if os.path.isfile(f) and not self._inside_state(f):
                        add(f)
            else:
                if not os.path.isfile(full):
                    raise Missing(p)
                add(full)
        return dict(sorted(found.items()))

    def hash(self, full):
        s = os.stat(full)
        key = (full, s.st_size, s.st_mtime_ns, s.st_ino)
        if key not in self._hashes:
            self._hashes[key] = sha256_file(full)
        return self._hashes[key]

    def hashes(self, patterns):
        return {rel: self.hash(full) for rel, full in self.expand(patterns).items()}

    # stop

    def stop_state(self):
        path = self.path("STOP")
        if not os.path.exists(path):
            return None
        try:
            rec = read_json(path)
        except ValueError:
            rec = None
        if not isinstance(rec, dict):
            return {"active": True, "reason": "the STOP file is unreadable, so the job counts as stopped"}
        return rec if rec.get("active", True) else None

    # approvals

    def approval(self, node):
        try:
            rec = read_json(self.path("approvals", node + ".json"))
        except ValueError:
            return None, "the approval file is not valid JSON; ignored"
        if rec is None:
            return None, "no approval yet"
        if not isinstance(rec, dict):
            return None, "the approval file is not an object; ignored"
        if rec.get("revoked"):
            return None, f"approval revoked {short_time(rec.get('revoked_at'))}"
        via = rec.get("via")
        if not isinstance(via, str) or not via.startswith(APPROVE_VIA):
            return None, f"the approval came from {via!r}, not /dag-approve or a terminal; ignored"
        if rec.get("dag") != self.spec.name or rec.get("node") != node:
            return None, "the approval names another dag or node; ignored"
        if not same_dir(rec.get("dag_dir"), self.spec.base):
            # A copied job folder carries its approvals; each folder's effect needs its own.
            return None, "the approval was written for another folder (or names none); approve again here"
        if not isinstance(rec.get("digest"), str) or parse_iso(rec.get("approved_at")) is None:
            return None, "the approval has no digest or time; ignored"
        return rec, ""

    def ledger_path(self):
        # Keyed so that two spellings of one folder on a case-insensitive disk share a file.
        return os.path.join(gate_home(), "spent", sha256_text(fold(self.spec.base))[:16] + ".jsonl")

    def ledger(self):
        """Spent approvals recorded outside the job folder."""
        path = self.ledger_path()
        try:
            with open(path, encoding="utf-8") as f:
                lines = f.readlines()
        except FileNotFoundError:
            return []
        except OSError as e:
            raise DagError(f"cannot read the spent-approval ledger {display(path)} ({e}); "
                           "without it an effect could run twice on one approval") from None
        recs = []
        for line in lines:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if isinstance(rec, dict):
                recs.append(rec)
        return recs

    def spent_record(self, node, views):
        records = None
        for g in self.spec.gate_ancestors(node):
            appr = views[g].approval
            if appr is None:
                continue
            if records is None:
                records = self.state["spent"] + self.ledger()
            for s in records:
                if (s.get("gate"), s.get("by"), s.get("digest"), s.get("approved_at")) == \
                        (g, node, appr["digest"], appr["approved_at"]):
                    return g, s
        return None

    # evaluation

    def evaluate(self, running=frozenset()):
        views = {}
        for name in self.spec.order:
            views[name] = self._eval(self.spec.nodes[name], views, running)
        return views

    def _eval(self, n, views, running):
        if n.name in running:
            return View(RUNNING, "running now")
        st = self.state["nodes"].get(n.name, {})
        if st.get("status") == "running" and self.live_run:
            return View(RUNNING, "running in another dag.py process")
        for d in n.deps:
            if views[d].status != CURRENT:
                return View(WAITING, f"on {d} ({views[d].status})")
        if n.kind == "gate":
            return self._eval_gate(n, views)
        v = View()
        try:
            v.inputs, v.deps, v.exec_sha, v.fp = self.fingerprint(n, views)
        except Missing as e:
            return View(BLOCKED, f"input missing: {e}")
        status = st.get("status", "pending")
        if status == "done" and st.get("fingerprint") == v.fp:
            drift = self._drift(st)
            if not drift:
                v.status, v.digest = CURRENT, st.get("digest")
                v.detail = f"done {short_time(st.get('finished_at'))}"
                return v
            v.status, v.detail = STALE, "output changed on disk: " + listing(drift)
        elif status == "done":
            v.status, v.detail = STALE, self._changes(st, v)
        elif status == "failed":
            v.status, v.detail = FAILED, st.get("error") or "failed"
        elif status in ("running", "interrupted"):
            if n.idempotent:
                v.status, v.detail = READY, "cut off last time; idempotent, so it runs again"
            else:
                v.status = INTERRUPTED
                v.detail = "cut off mid-run and not idempotent: check what it did, then invalidate it"
        else:
            v.status = READY
            v.detail = ("invalidated " + short_time(st["invalidated_at"])) if st.get("invalidated_at") else "not run yet"
        if v.status in RUNNABLE and n.effect:
            hit = self.spent_record(n.name, views)
            if hit:
                g, s = hit
                v.status = NEEDS_APPROVAL
                v.detail = (f"{g}'s approval of {short_time(s['approved_at'])} was used when {n.name} "
                            f"ran at {short_time(s.get('at'))}; an outside effect runs once per approval")
        if v.status in RUNNABLE and n.kind == "task":
            v.status = TASK
        return v

    def fingerprint(self, n, views):
        """inputs, upstream digests, spec hash and fingerprint of a cmd or task node.
        Gates add no digest: a gate orders work, the files carry the content."""
        inputs = self.hashes(n.inputs)
        deps = {d: views[d].digest for d in n.after if self.spec.nodes[d].kind != "gate"}
        exec_sha = sha256_text(canon(n.exec_spec()))
        return inputs, deps, exec_sha, sha256_text(canon({"exec": exec_sha, "inputs": inputs, "deps": deps}))

    def effect_key(self, name, fp):
        """Stable for the same content, so an outside system can drop a repeat."""
        return sha256_text(f"{self.spec.name}\n{name}\n{fp}")[:32]

    def _eval_gate(self, n, views):
        try:
            files = self.hashes(n.gate["review"])
        except Missing as e:
            return View(BLOCKED, f"review file missing: {e}")
        if not files:
            return View(BLOCKED, "the review globs match no files")
        bad = [p for p in files if "\n" in p or "\r" in p]
        if bad:
            return View(BLOCKED, f"a review path has a line break: {bad[0]!r}")
        effects = {}
        for e in self.spec.covers.get(n.name, []):
            try:
                effects[e] = self.fingerprint(self.spec.nodes[e], views)[3]
            except Missing as m:
                return View(BLOCKED, f"{e}, which this gate releases, reads {m}, which does not exist")
        manifest = gate_manifest(self.spec.name, n.name, files, effects)
        v = View()
        v.digest = "sha256:" + sha256_text(manifest)
        v.request = {"manifest": manifest, "files": files, "effects": effects}
        appr, problem = self.approval(n.name)
        if appr is None:
            v.status, v.detail = AWAITING, problem
        elif appr["digest"] != v.digest:
            v.status = AWAITING
            v.detail = (f"the approval of {short_time(appr['approved_at'])} is stale: "
                        + (file_diff(appr.get("files"), files) or "the reviewed files changed"))
        else:
            v.status, v.approval = CURRENT, appr
            v.detail = f"approved {short_time(appr['approved_at'])} via {appr['via']}"
        return v

    def _drift(self, st):
        out = []
        for rel, sha in st.get("outputs", {}).items():
            full = os.path.normpath(os.path.join(self.spec.base, rel))
            try:
                if self.hash(full) != sha:
                    out.append(rel)
            except OSError:
                out.append(rel + " (missing)")
        return out

    def _changes(self, st, v):
        parts = []
        diff = file_diff(st.get("inputs", {}), v.inputs)
        if diff:
            parts.append("inputs " + diff)
        deps = [d for d in v.deps if st.get("deps", {}).get(d) != v.deps[d]]
        if deps:
            parts.append("upstream changed: " + listing(deps))
        if st.get("exec_sha") != v.exec_sha:
            parts.append("its spec changed")
        return "; ".join(parts) or "fingerprint changed"

    # side effects of a run

    def recover(self):
        changed = False
        for name, st in self.state["nodes"].items():
            if st.get("status") == "running":
                st["status"] = "interrupted"
                self.event("interrupted", name)
                changed = True
        if changed:
            self.save()

    def register(self):
        rec = {"format": FORMAT, "dag": self.spec.name, "dag_dir": self.spec.base, "spec": self.spec.path}
        path = os.path.join(gate_home(), "registry", sha256_text(self.spec.base)[:16] + ".json")
        try:
            old = read_json(path)
        except ValueError:
            old = None
        if isinstance(old, dict) and all(old.get(k) == v for k, v in rec.items()):
            return
        rec["registered_at"] = now_iso()
        try:
            write_json(path, rec)
        except OSError as e:
            print(f"note: could not register this dag for /dag-pending ({e})", file=sys.stderr)

    def file_request(self, name, v, not_before=None, reason=None):
        path = self.path("gates", name + ".json")
        try:
            old = read_json(path)
        except ValueError:
            old = None
        if isinstance(old, dict) and old.get("digest") == v.digest and old.get("not_before") == not_before \
                and same_dir(old.get("dag_dir"), self.spec.base):
            return old, False
        g = self.spec.nodes[name].gate
        req = {"format": FORMAT, "dag": self.spec.name, "dag_dir": self.spec.base,
               "spec": self.spec.path, "node": name, "digest": v.digest,
               "manifest": v.request["manifest"],
               "files": [{"path": p, "sha256": s} for p, s in v.request["files"].items()],
               "effects": [{"node": e, "fingerprint": fp} for e, fp in sorted(v.request["effects"].items())],
               "summary": g["summary"], "approver": g["approver"], "requested_at": now_iso(),
               "not_before": not_before, "reason": reason}
        write_json(path, req)
        self.event("gate-request", name, digest=v.digest, reason=reason)
        return req, True

    def sync_gates(self, views, run_id, passed):
        """Record gates that passed; file a request for each gate a person must answer."""
        filed = []
        for name in self.spec.order:
            n, v = self.spec.nodes[name], views[name]
            if n.kind != "gate":
                continue
            st = self.state["nodes"].get(name, {})
            if v.status == CURRENT:
                key = (v.approval["digest"], v.approval["approved_at"])
                if st.get("status") != "done" or (st.get("digest"), st.get("approved_at")) != key:
                    self.state["nodes"][name] = {"status": "done", "digest": v.digest,
                                                 "approved_at": v.approval["approved_at"],
                                                 "via": v.approval["via"], "finished_at": now_iso(),
                                                 "run_id": run_id}
                    self.save()
                    self.event("gate-pass", name, digest=v.digest, via=v.approval["via"])
                    passed.append({"node": name, "digest": v.digest,
                                   "approved_at": v.approval["approved_at"], "via": v.approval["via"]})
            elif v.status == AWAITING:
                if st.get("status") == "done":
                    self.state["nodes"][name] = {"status": "pending"}
                    self.save()
                _, new = self.file_request(name, v)
                if new:
                    filed.append(name)
        for name in self.spec.order:
            if views[name].status != NEEDS_APPROVAL:
                continue
            hit = self.spent_record(name, views)
            if hit:
                g, s = hit
                _, new = self.file_request(g, views[g], not_before=s["at"],
                                           reason=f"{name} already ran under the approval of "
                                                  f"{short_time(s['approved_at'])}; approve again to run it again")
                if new:
                    filed.append(g)
        return filed

    def spend(self, name, views, run_id):
        recs = []
        for g in self.spec.gate_ancestors(name):
            appr = views[g].approval
            recs.append({"gate": g, "by": name, "digest": appr["digest"], "approved_at": appr["approved_at"],
                         "via": appr["via"], "at": now_iso(), "run_id": run_id})
        if recs:
            # Recorded outside the folder first: a backup taken before this run, restored to the same path,
            # still holds the approval with an empty spent list, and must not run the effect on it again.
            path = self.ledger_path()
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "a", encoding="utf-8") as f:
                    for rec in recs:
                        f.write(json.dumps({"dag": self.spec.name, "dag_dir": self.spec.base, **rec},
                                           sort_keys=True) + "\n")
                    f.flush()
                    os.fsync(f.fileno())
            except OSError as e:
                raise DagError(f"could not record the spent approval in {display(path)} ({e}); "
                               f"{name} did not run") from None
        self.state["spent"].extend(recs)
        return recs

    def start(self, name, v, views, run_id):
        spent = self.spend(name, views, run_id) if self.spec.nodes[name].effect else []
        self.state["nodes"][name] = {"status": "running", "started_at": now_iso(), "run_id": run_id,
                                     "fingerprint": v.fp, "inputs": v.inputs, "deps": v.deps,
                                     "exec_sha": v.exec_sha}
        self.save()
        self.event("start", name, run_id=run_id)
        return spent

    def finish(self, name, res, run_id):
        n, st = self.spec.nodes[name], self.state["nodes"][name]
        st.update(finished_at=now_iso(), attempts=res["attempts"], seconds=round(res["seconds"], 3))
        if res["ok"]:
            try:
                outs = self.hashes(n.outputs)
            except Missing as e:
                res = dict(res, ok=False, exit_code=1, error=f"output missing after the run: {e}")
            else:
                st.update(status="done", outputs=outs, digest=output_digest(outs, st["fingerprint"]))
                st.pop("error", None)
                st.pop("exit_code", None)
        if not res["ok"]:
            st.update(status="failed", error=res.get("error"), exit_code=res.get("exit_code"))
        self.save()
        self.event("finish" if res["ok"] else "fail", name, run_id=run_id,
                   attempts=res["attempts"], error=res.get("error"))
        return res

    def env_for(self, name, run_id, v=None):
        env = dict(os.environ)
        env.update(self.spec.nodes[name].env)
        env.update({"DAG_NAME": self.spec.name, "DAG_NODE": name, "DAG_RUN_ID": run_id,
                    "DAG_DIR": self.spec.base})
        if self.spec.nodes[name].effect and v is not None and v.fp:
            env["DAG_EFFECT_KEY"] = self.effect_key(name, v.fp)
        return env

    # receipts

    def receipts(self):
        folder = self.path("receipts")
        if not os.path.isdir(folder):
            return []
        return sorted(f for f in os.listdir(folder) if f.endswith(".json"))

    def latest_receipt(self):
        try:
            with open(self.path("receipts", "LATEST"), encoding="utf-8") as f:
                name = f.read().strip()
        except OSError:
            return None
        return name or None

    def write_receipt(self, run_id, started, executed, reported, passed, spent, result, views):
        """executed: cmd nodes the runner started and watched exit. reported: task nodes
        Claude marked done; the runner saw their outputs and ran their check, not the work."""
        prev = self.latest_receipt()
        prev_sha = None
        if prev and os.path.exists(self.path("receipts", prev)):
            prev_sha = sha256_file(self.path("receipts", prev))
        finished = now_iso()
        keys = ("status", "attempts", "exit_code", "error", "started_at", "finished_at", "outputs", "note")
        approved = [p["node"] for p in passed]
        touched = set(executed) | set(reported) | set(approved)
        rec = {
            "format": FORMAT, "dag": self.spec.name, "run_id": run_id, "spec": self.spec.path,
            "spec_sha256": self.spec.sha256, "started_at": started, "finished_at": finished,
            "result": result, "prev_receipt_sha256": prev_sha,
            "coverage": {
                "executed": list(executed), "reported": list(reported), "approved": approved,
                "carried": [x for x in self.spec.order if views[x].status == CURRENT and x not in touched],
                "open": [x for x in self.spec.order if views[x].status != CURRENT],
            },
            "steps": [dict({"node": x, "observed": x in executed},
                           **{k: self.state["nodes"].get(x, {}).get(k)
                              for k in keys if k in self.state["nodes"].get(x, {})})
                      for x in list(executed) + list(reported)],
            "gates_passed": passed, "approvals_spent": spent,
            "nodes": {x: {"status": views[x].status, "digest": views[x].digest,
                          "outputs": self.state["nodes"].get(x, {}).get("outputs", {})
                          if views[x].status == CURRENT else {}}
                      for x in self.spec.order},
        }
        # A sequence and a time to the second, no random hex: output filters mask a hex run id
        # as a secret, and a masked path is one the next session cannot open. run_id is inside.
        seq = max([int(m.group(1)) for m in map(re.compile(r"^(\d{6})-").match, self.receipts()) if m] + [0]) + 1
        name = f"{seq:06d}-{re.sub(r'[^0-9T]', '', finished[:19])}Z.json"
        write_json(self.path("receipts", name), rec)
        write_text(self.path("receipts", "LATEST"), name + "\n")
        self.event("receipt", run_id=run_id, file=name)
        return name


# ---------------------------------------------------------------- reporting

def next_step(eng, views):
    spec, inv = eng.spec, eng.inv
    stop = eng.stop_state()
    if stop:
        return (f"stopped ({stop.get('reason') or 'no reason given'}). Only a person can resume: "
                f"/dag-resume {spec.name}")
    by = {}
    for x in spec.order:
        by.setdefault(views[x].status, []).append(x)
    if FAILED in by:
        x = by[FAILED][0]
        return f"fix {x} (log: {display(eng.path('logs', x + '.log'))}), then {inv} run"
    if BLOCKED in by:
        x = by[BLOCKED][0]
        return f"{x} is blocked: {views[x].detail}"
    if INTERRUPTED in by:
        x = by[INTERRUPTED][0]
        return f"check what {x} did before it was cut off, then {inv} invalidate {x} and {inv} run"
    if RUNNING in by:
        return f"a run is in progress; check again with {inv} status when it finishes"
    if READY in by or STALE in by:
        return f"{inv} run"
    gates = list(by.get(AWAITING, []))
    for x in by.get(NEEDS_APPROVAL, []):
        hit = eng.spent_record(x, views)
        if hit and hit[0] not in gates:
            gates.append(hit[0])
    if gates:
        g = gates[0]
        v, n = views[g], spec.nodes[g]
        files = listing(v.request["files"], 4) if v.request else listing(n.gate["review"], 4)
        try:
            req = read_json(eng.path("gates", g + ".json"))
        except ValueError:
            req = None
        filed = isinstance(req, dict) and req.get("digest") == v.digest
        again = " again" if g not in by.get(AWAITING, []) else ""
        tail = "" if filed else f" (run {inv} run first, so the request is on file)"
        return (f"ask {n.gate['approver']} to review {files}, then type{again}: "
                f"/dag-approve {g} {v.digest[7:13]}{tail}")
    if TASK in by:
        x = by[TASK][0]
        what = spec.nodes[x].description
        return f"do task {x}{': ' + what if what else ''} Then {inv} done {x}"
    if all(views[x].status == CURRENT for x in spec.order):
        return "nothing to do: every node is current"
    return f"{inv} status"


def print_table(eng, views):
    spec = eng.spec
    width = max(len(x) for x in spec.order)
    print(f"dag {spec.name}  {display(spec.path)}")
    effect = False
    for name in spec.order:
        n, v = spec.nodes[name], views[name]
        kind = n.kind + ("!" if n.effect else "")
        effect = effect or bool(n.effect)
        print(f"  {name:<{width}}  {kind:<5} {v.status:<18} {v.detail}")
    if effect:
        print("  (! = outside effect: runs once per approval)")
    print("NEXT  " + next_step(eng, views))


def print_stop(stop):
    print(f"stopped: {stop.get('reason') or 'no reason given'} (set {short_time(stop.get('at'))} by "
          f"{stop.get('by', '?')}). dag.py starts nothing while the stop is set; only a person can "
          f"resume it.")


def resolve_receipt(eng, name):
    names = eng.receipts()
    if not names:
        raise DagError("no receipts yet: a receipt is written when a run or a done changes something")
    if not name:
        latest = eng.latest_receipt()
        return latest if latest in names else names[-1]
    hits = [x for x in names if x == name or x.startswith(name) or name in x]
    if len(hits) != 1:
        raise DagError(f"{len(hits)} receipts match {name!r}")
    return hits[0]


# ---------------------------------------------------------------- commands

def cmd_init(args):
    path = os.path.abspath(args.spec)
    if os.path.exists(path) and not args.force:
        print(f"{display(path)} already exists; pass --force to overwrite it")
        return EXIT_FAIL
    spec = json.loads(json.dumps(TEMPLATE))
    if args.name:
        if not NAME_RE.match(args.name):
            raise DagError("--name uses letters, digits, dot, dash, underscore")
        spec["dag"] = args.name
    write_json(path, spec)
    print(f"wrote {display(path)}: a four-node example (build, test, review gate, ship). "
          f"Edit the nodes, then run validate and plan.")
    return EXIT_OK


def cmd_validate(spec, args):
    for e in spec.errors:
        print("ERROR  " + e)
    for w in spec.warnings:
        print("WARN   " + w)
    if spec.errors:
        print(f"{len(spec.errors)} error(s): fix the spec before running it")
        return EXIT_FAIL
    print(f"ok: {len(spec.nodes)} nodes in {len(spec.waves)} waves"
          + (f", {len(spec.warnings)} warning(s)" if spec.warnings else ""))
    return EXIT_OK


def cmd_plan(spec, args):
    widest = max(len(w) for w in spec.waves)
    print(f"dag {spec.name}: {len(spec.nodes)} nodes in {len(spec.waves)} waves (widest {widest})")
    for i, wave in enumerate(spec.waves, 1):
        print(f"  wave {i}  {', '.join(wave)}")
    path, span = spec.critical_path()
    work = sum(n.est for n in spec.nodes.values())
    print(f"critical path  {' -> '.join(path)}  ({span:g} of {work:g} min)")
    for w in spec.warnings:
        print("WARN   " + w)
    if work <= 0 or span <= 0:
        print("no estimates: set est_minutes on nodes to size the speedup")
        return EXIT_OK
    rows = []
    for workers in (2, 4, 8):
        ms = spec.makespan(workers)
        rows.append((workers, work / ms if ms else 1.0))
    s4 = dict(rows)[4]
    p = (1 - 1 / s4) / (1 - 1 / 4) if s4 > 1 else 0.0
    print(f"work {work:g} min, span {span:g} min, ceiling {work / span:.2f}x")
    print("simulated speedup  " + ", ".join(f"{w} workers {s:.2f}x" for w, s in rows))
    print(f"p = {p:.2f} (the Amdahl parallel share that gives the 4-worker speedup)")
    if p < P_FLOOR:
        print(f"VERDICT  p is under {P_FLOOR}: parallel runs buy little here. Run with -j 1 and keep "
              f"the graph for its state, gates and receipt.")
    else:
        best = max(rows, key=lambda r: (round(r[1], 2), -r[0]))
        print(f"VERDICT  parallel waves pay: run with -j {best[0]} ({best[1]:.2f}x).")
    return EXIT_OK


def cmd_status(eng, args):
    eng.live_run = lock_busy(eng.dir)
    views = eng.evaluate()
    if args.json:
        out = {"dag": eng.spec.name, "spec": eng.spec.path,
               "stopped": eng.stop_state() is not None,
               "nodes": {x: {"kind": eng.spec.nodes[x].kind, "effect": eng.spec.nodes[x].effect,
                             "status": views[x].status, "detail": views[x].detail}
                         for x in eng.spec.order},
               "next": next_step(eng, views)}
        print(json.dumps(out, indent=2))
        return EXIT_OK
    print_table(eng, views)
    return EXIT_OK


def cmd_run(eng, args):
    spec = eng.spec
    if args.jobs < 1:
        raise DagError("-j must be 1 or more")
    scope = spec.closure(args.only) if args.only else None
    if args.dry_run:
        return dry_run(eng, scope)
    with Lock(eng.dir):
        stop = eng.stop_state()
        if stop:
            print_stop(stop)
            return EXIT_STOPPED
        eng.ensure_dir()
        eng.recover()
        eng.register()
        run_id, started = uuid.uuid4().hex[:12], now_iso()
        attempted, executed, passed, spent = set(), [], [], []
        running, at_start = {}, {}
        backoff = float(os.environ.get("DAG_RETRY_BACKOFF", "2"))
        width = max(len(x) for x in spec.order)
        stopped = False
        old_term = signal.signal(signal.SIGTERM, _raise_interrupted)
        pool = cf.ThreadPoolExecutor(max_workers=args.jobs)
        try:
            while True:
                views = eng.evaluate(running=frozenset(running.values()))
                for g in eng.sync_gates(views, run_id, passed):
                    v = views[g]
                    print(f"? {g:<{width}} awaiting approval: /dag-approve {g} {v.digest[7:13]}")
                if not stopped and eng.stop_state():
                    stopped = True
                    print("■ stop set: no new node will start")
                runnable = [x for x in spec.order
                            if views[x].status in RUNNABLE and spec.nodes[x].kind == "cmd"
                            and x not in attempted and (scope is None or x in scope)]
                if not stopped:
                    for x in runnable:
                        if len(running) >= args.jobs:
                            break
                        attempted.add(x)
                        try:
                            spent += eng.start(x, views[x], views, run_id)
                        except DagError as e:
                            eng.state["nodes"][x] = {"status": "failed", "error": str(e),
                                                     "finished_at": now_iso(), "run_id": run_id}
                            eng.save()
                            eng.event("fail", x, run_id=run_id, error=str(e))
                            executed.append(x)
                            print(f"x {x:<{width}} not started: {e}")
                            continue
                        at_start[x] = views[x]
                        fut = pool.submit(execute, spec.base, spec.nodes[x], eng.env_for(x, run_id, views[x]),
                                          eng.path("logs", x + ".log"), backoff)
                        running[fut] = x
                        print(f"> {x:<{width}} start ({views[x].detail})")
                if not running:
                    break
                done, _ = cf.wait(list(running), return_when=cf.FIRST_COMPLETED)
                for fut in done:
                    x = running.pop(fut)
                    try:
                        res = fut.result()
                    except Exception as e:  # a bug in the runner, not in the node
                        res = {"ok": False, "attempts": 1, "seconds": 0.0, "exit_code": 1,
                               "error": f"runner error: {e!r}"}
                    res = eng.finish(x, res, run_id)
                    executed.append(x)
                    if res["ok"]:
                        outs = eng.state["nodes"][x].get("outputs", {})
                        shown = ", ".join(f"{p} {s[:12]}" for p, s in list(outs.items())[:3])
                        print(f"+ {x:<{width}} done {res['seconds']:.1f}s" + (f"  {shown}" if shown else ""))
                    else:
                        print(f"x {x:<{width}} failed: {res['error']} after {res['attempts']} attempt(s)")
                        for line in log_tail(eng.path("logs", x + ".log")):
                            print("    | " + line.rstrip("\n"))
        except (KeyboardInterrupt, Interrupted):
            kill_children()
            pool.shutdown(wait=True)
            for x in running.values():
                eng.state["nodes"][x]["status"] = "interrupted"
                eng.event("interrupted", x, run_id=run_id)
            eng.save()
            print("interrupted: nodes in flight are marked interrupted")
            return EXIT_INTERRUPTED
        finally:
            pool.shutdown(wait=True)
            signal.signal(signal.SIGTERM, old_term)
        views = eng.evaluate()
        failed = [x for x in executed if eng.state["nodes"][x]["status"] == "failed"]
        targets = scope if scope is not None else set(spec.order)
        if stopped:
            result, code = "stopped", EXIT_STOPPED
        elif failed:
            result, code = "failed", EXIT_FAIL
        elif all(views[x].status == CURRENT for x in targets):
            result, code = "complete", EXIT_OK
        else:
            result, code = "blocked", EXIT_BLOCKED
        if executed or passed or spent:
            name = eng.write_receipt(run_id, started, executed, [], passed, spent, result, views)
            print(f"receipt {display(eng.path('receipts', name))}")
        print_table(eng, views)
        return code


def dry_run(eng, scope):
    """What run would start, read from disk. No lock, no state, no request, no registry: nothing is written."""
    spec = eng.spec
    stop = eng.stop_state()
    if stop:
        print_stop(stop)
        return EXIT_STOPPED
    views = eng.evaluate()
    width = max(len(x) for x in spec.order)
    targets = scope if scope is not None else set(spec.order)
    for g in spec.order:
        if g in targets and views[g].status in (AWAITING, NEEDS_APPROVAL) and spec.nodes[g].kind == "gate":
            print(f"? {g:<{width}} would ask for approval (digest {views[g].digest[7:13]}); "
                  "a run without --dry-run files the request")
    runnable = [x for x in spec.order
                if views[x].status in RUNNABLE and spec.nodes[x].kind == "cmd" and x in targets]
    print("would start: " + (", ".join(runnable) or "nothing"))
    return EXIT_OK if all(views[x].status == CURRENT for x in targets) else EXIT_BLOCKED


def _raise_interrupted(signum, frame):
    raise Interrupted()


def cmd_done(eng, args):
    spec, name = eng.spec, args.node
    if name not in spec.nodes:
        raise DagError(f"unknown node {name!r}{suggest(name, spec.nodes)}")
    n = spec.nodes[name]
    if n.kind == "gate":
        print(f"{name} is a gate: a person approves it by typing /dag-approve {name} <first 6 hex of the digest>")
        return EXIT_FAIL
    if n.kind == "cmd":
        print(f"{name} is a cmd node: the runner runs it. Use {eng.inv} run")
        return EXIT_FAIL
    with Lock(eng.dir):
        stop = eng.stop_state()
        if stop:
            print_stop(stop)
            return EXIT_STOPPED
        eng.ensure_dir()
        eng.recover()
        views = eng.evaluate()
        v = views[name]
        if v.status == CURRENT:
            print(f"{name} is already current")
            return EXIT_OK
        if v.status == WAITING:
            closed = [g for g in spec.gate_ancestors(name) if views[g].status != CURRENT]
            if closed:
                g = closed[0]
                print(f"refused: {name} comes after gate {g}, which is not approved ({views[g].detail}). "
                      f"Work on {name} was not authorized yet: tell the person what was done.")
            else:
                print(f"refused: {name} is not ready: {v.detail}")
            return EXIT_BLOCKED
        if v.status != TASK:
            print(f"refused: {name} is {v.status}: {v.detail}")
            return EXIT_BLOCKED
        try:
            outs = eng.hashes(n.outputs)
        except Missing as e:
            print(f"not done: the declared output {e} does not exist")
            return EXIT_FAIL
        run_id = uuid.uuid4().hex[:12]
        started = now_iso()
        if n.check is not None:
            log_path = eng.path("logs", name + ".log")
            os.makedirs(os.path.dirname(log_path), exist_ok=True)
            with open(log_path, "a", encoding="utf-8") as log:
                log.write(f"=== {name} check at {now_iso()}\n")
                log.flush()
                rc, why = run_argv(n.check, spec.base, eng.env_for(name, run_id), log, n.timeout_s)
            if rc != 0:
                eng.state["nodes"][name] = {"status": "failed", "error": f"check failed ({why})",
                                            "finished_at": now_iso(), "run_id": run_id}
                eng.save()
                eng.event("fail", name, run_id=run_id, error=f"check failed ({why})")
                print(f"not done: the check failed ({why}); log {display(log_path)}")
                return EXIT_FAIL
        spent = eng.spend(name, views, run_id) if n.effect else []
        eng.state["nodes"][name] = {"status": "done", "fingerprint": v.fp, "inputs": v.inputs,
                                    "deps": v.deps, "exec_sha": v.exec_sha, "outputs": outs,
                                    "digest": output_digest(outs, v.fp), "started_at": started,
                                    "finished_at": now_iso(), "run_id": run_id, "attempts": 1}
        if args.note:
            eng.state["nodes"][name]["note"] = args.note
        eng.save()
        eng.event("done", name, run_id=run_id, note=args.note)
        views = eng.evaluate()
        eng.write_receipt(run_id, started, [], [name], [], spent, "done", views)
        print(f"+ {name} done" + (": " + ", ".join(f"{p} {s[:12]}" for p, s in outs.items()) if outs else ""))
        print("NEXT  " + next_step(eng, views))
        return EXIT_OK


def cmd_why(eng, args):
    spec, name = eng.spec, args.node
    if name not in spec.nodes:
        raise DagError(f"unknown node {name!r}{suggest(name, spec.nodes)}")
    eng.live_run = lock_busy(eng.dir)
    views = eng.evaluate()
    n, v = spec.nodes[name], views[name]
    st = eng.state["nodes"].get(name, {})
    print(f"{name}  {n.kind}" + (f", effect {n.effect}" if n.effect else "") + f"  {v.status}")
    if n.description:
        print(f"  what     {n.description}")
    print(f"  because  {v.detail}")
    for d in n.deps:
        print(f"  after    {d}: {views[d].status}" + ("  (order only)" if d in n.order_only else ""))
    for g in spec.gate_ancestors(name):
        print(f"  gate     {g}: {views[g].status}")
    if n.kind == "gate":
        if v.request:
            for p, s in v.request["files"].items():
                print(f"  reviews  {p}  {s[:12]}")
            print(f"  digest   {v.digest}")
        try:
            req = read_json(eng.path("gates", name + ".json"))
        except ValueError:
            req = None
        if isinstance(req, dict):
            print(f"  request  filed {short_time(req.get('requested_at'))}"
                  + ("" if req.get("digest") == v.digest else " for older content: run again to refresh it"))
    else:
        if v.inputs:
            print(f"  reads    {listing(v.inputs, 6)}")
        if st:
            print(f"  last     {st.get('status')} {short_time(st.get('finished_at') or st.get('started_at'))}"
                  + (f", {st['attempts']} attempt(s)" if st.get("attempts") else "")
                  + (f": {st['error']}" if st.get("error") else ""))
        if st.get("outputs"):
            print(f"  wrote    {listing(st['outputs'], 6)}")
        if st.get("note"):
            print(f"  note     {st['note']}")
    print("NEXT  " + next_step(eng, views))
    return EXIT_OK


def cmd_invalidate(eng, args):
    spec, name = eng.spec, args.node
    if name not in spec.nodes:
        raise DagError(f"unknown node {name!r}{suggest(name, spec.nodes)}")
    with Lock(eng.dir):
        names = [name] if args.only else [x for x in spec.order if x == name or x in spec.desc[name]]
        for x in names:
            eng.state["nodes"][x] = {"status": "pending", "invalidated_at": now_iso()}
        eng.save()
        eng.event("invalidate", name, nodes=names)
    print(f"reset to pending: {', '.join(names)}")
    print("A gate passes again only if its reviewed files are unchanged, and an outside effect "
          "never re-runs on an approval it already used.")
    return EXIT_OK


def cmd_stop(eng, args):
    eng.ensure_dir()
    write_json(eng.path("STOP"), {"active": True, "reason": args.reason or "", "by": "dag.py stop",
                                  "at": now_iso()})
    eng.event("stop", reason=args.reason)
    eng.register()
    busy = lock_busy(eng.dir)
    print("stop set: dag.py will not start another node"
          + (" (nodes already running finish first)" if busy else "")
          + f". Only a person can resume: /dag-resume {eng.spec.name}, or {eng.inv} resume in their own terminal.")
    return EXIT_OK


def cmd_resume(eng, args):
    if not person_at_terminal():
        print(PERSON_ONLY.format(what="resume", slash=f"/dag-resume {eng.spec.name}"))
        return EXIT_REFUSED
    stop = eng.stop_state()
    if not stop:
        print("not stopped")
        return EXIT_OK
    print_stop(stop)
    if input("Type resume to clear the stop: ").strip() != "resume":
        print("still stopped")
        return EXIT_FAIL
    write_json(eng.path("STOP"), {"active": False, "by": "dag.py resume (tty)", "user": getpass.getuser(),
                                  "at": now_iso(), "cleared": stop})
    eng.event("resume", by="dag.py resume (tty)")
    print("resumed")
    return EXIT_OK


def cmd_approve(eng, args):
    spec, name = eng.spec, args.node
    if not person_at_terminal():
        print(PERSON_ONLY.format(what="approve", slash=f"/dag-approve {name} <first 6 hex of the digest>"))
        return EXIT_REFUSED
    if name not in spec.nodes or spec.nodes[name].kind != "gate":
        raise DagError(f"{name!r} is not a gate in this dag")
    try:
        req = read_json(eng.path("gates", name + ".json"))
    except ValueError:
        req = None
    if not isinstance(req, dict):
        print(f"no request on file for {name}: run the job until it stops at the gate")
        return EXIT_FAIL
    views = eng.evaluate()
    v = views[name]
    if v.status == WAITING or v.digest is None:
        print(f"{name} is not at the gate yet: {v.detail}")
        return EXIT_BLOCKED
    if v.digest != req.get("digest"):
        print("the reviewed files changed since the request was filed; run the job again to refresh it")
        return EXIT_FAIL
    g = spec.nodes[name].gate
    print(f"{spec.name} / {name}: {g['summary'] or 'no summary'}")
    for p, s in v.request["files"].items():
        print(f"  {p}  {s[:12]}")
    print(f"digest {v.digest}")
    if req.get("reason"):
        print(f"note: {req['reason']}")
    typed = input("Type the first 6 characters of the digest to approve (anything else cancels): ").strip().lower()
    if len(typed) < 6 or not v.digest[7:].startswith(typed):
        print("cancelled")
        return EXIT_FAIL
    rec = {"format": FORMAT, "dag": spec.name, "dag_dir": spec.base, "node": name, "digest": v.digest,
           "files": req.get("files"), "approved_at": now_iso(), "via": "dag.py approve (tty)",
           "user": getpass.getuser(), "requested_at": req.get("requested_at")}
    write_json(eng.path("approvals", name + ".json"), rec)
    eng.event("approve", name, digest=v.digest, via=rec["via"])
    print(f"approved {name} ({v.digest[7:19]})")
    return EXIT_OK


def cmd_revoke(eng, args):
    spec, name = eng.spec, args.node
    if name not in spec.nodes or spec.nodes[name].kind != "gate":
        raise DagError(f"{name!r} is not a gate in this dag")
    write_json(eng.path("approvals", name + ".json"),
               {"format": FORMAT, "dag": spec.name, "node": name, "revoked": True,
                "revoked_at": now_iso(), "via": "dag.py revoke"})
    eng.event("revoke", name)
    print(f"revoked: nothing after {name} runs until a person approves it again")
    return EXIT_OK


def cmd_digest(eng, args):
    spec, name = eng.spec, args.node
    if name not in spec.nodes or spec.nodes[name].kind != "gate":
        raise DagError(f"{name!r} is not a gate in this dag")
    v = eng.evaluate()[name]
    if v.request is None:
        raise DagError(f"{name} has no digest yet: {v.detail}")
    sys.stdout.write(v.request["manifest"])
    print(v.digest)
    return EXIT_OK


def cmd_receipt(eng, args):
    name = resolve_receipt(eng, args.name)
    with open(eng.path("receipts", name), encoding="utf-8") as f:
        sys.stdout.write(f.read())
    return EXIT_OK


def cmd_verify(eng, args):
    names = eng.receipts()
    target = resolve_receipt(eng, args.name)
    problems, prev = [], None
    for name in names:
        try:
            rec = read_json(eng.path("receipts", name))
        except ValueError as e:
            problems.append(str(e))
            prev = name
            continue
        want = rec.get("prev_receipt_sha256") if isinstance(rec, dict) else None
        have = sha256_file(eng.path("receipts", prev)) if prev else None
        if want != have:
            problems.append(f"chain broken at {name}: it names previous receipt "
                            f"{(want or 'none')[:12]}, the file before it hashes to {(have or 'none')[:12]}")
        prev = name
    rec = read_json(eng.path("receipts", target))
    checked = 0
    for node, info in sorted(rec.get("nodes", {}).items()):
        for rel, sha in sorted((info.get("outputs") or {}).items()):
            checked += 1
            full = os.path.normpath(os.path.join(eng.spec.base, rel))
            if not os.path.isfile(full):
                problems.append(f"{rel} (from {node}) is missing")
            elif sha256_file(full) != sha:
                problems.append(f"{rel} (from {node}) changed since run {rec.get('run_id')}")
    for p in problems:
        print("FAIL  " + p)
    if problems:
        print(f"verify: {len(problems)} problem(s) against receipt {target}")
        return EXIT_FAIL
    print(f"verify: ok. {checked} output file(s) match receipt {target}; the chain of "
          f"{len(names)} receipt(s) is intact. This checks files on disk, not what an outside "
          f"system received.")
    return EXIT_OK


MERMAID_CLASS = {CURRENT: "current", READY: "ready", STALE: "ready", FAILED: "failed",
                 INTERRUPTED: "attention", WAITING: "waiting", RUNNING: "ready", TASK: "attention",
                 AWAITING: "attention", NEEDS_APPROVAL: "attention", BLOCKED: "failed"}


def cmd_mermaid(eng, args):
    spec = eng.spec
    views = eng.evaluate()
    ids = {name: f"n{i}" for i, name in enumerate(spec.order)}
    lines = ["flowchart TD"]
    for name in spec.order:
        n = spec.nodes[name]
        label = (name + (f"<br/>{n.effect}" if n.effect else "") + ("<br/>task" if n.kind == "task" else "")).replace('"', "'")
        if n.kind == "gate":
            shape = ('{{"', '"}}')
        elif n.effect:
            shape = ('[["', '"]]')
        elif n.kind == "task":
            shape = ('(["', '"])')
        else:
            shape = ('["', '"]')
        lines.append(f"  {ids[name]}{shape[0]}{label}{shape[1]}")
    for name in spec.order:
        n = spec.nodes[name]
        lines += [f"  {ids[d]} --> {ids[name]}" for d in n.after]
        lines += [f"  {ids[d]} -.-> {ids[name]}" for d in n.order_only]
    groups = {}
    for name in spec.order:
        groups.setdefault(MERMAID_CLASS.get(views[name].status, "waiting"), []).append(ids[name])
    for cls, members in sorted(groups.items()):
        lines.append(f"  class {','.join(members)} {cls}")
    lines += ["  classDef current fill:#dcfce7,stroke:#15803d,color:#14532d",
              "  classDef ready fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a",
              "  classDef attention fill:#fef3c7,stroke:#b45309,color:#78350f",
              "  classDef failed fill:#fee2e2,stroke:#b91c1c,color:#7f1d1d",
              "  classDef waiting fill:#f1f5f9,stroke:#64748b,color:#334155"]
    print("\n".join(lines))
    return EXIT_OK


# ---------------------------------------------------------------- main

def build_parser():
    ap = argparse.ArgumentParser(prog="dag.py", description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--spec", default="dag.json", help="the spec file (default ./dag.json)")
    sub = ap.add_subparsers(dest="cmd", metavar="command")
    sub.required = True
    p = sub.add_parser("init", help="write an example spec")
    p.add_argument("--name", help="the dag's name")
    p.add_argument("--force", action="store_true", help="overwrite an existing spec")
    sub.add_parser("validate", help="check the spec: cycles, races, hidden edges, fake edges, gates")
    sub.add_parser("plan", help="waves, critical path, simulated speedup, verdict")
    p = sub.add_parser("status", help="every node's state and the one next step")
    p.add_argument("--json", action="store_true", help="machine-readable")
    p = sub.add_parser("run", help="run every ready cmd node; stop at gates and tasks")
    p.add_argument("-j", "--jobs", type=int, default=4, help="nodes at once (default 4)")
    p.add_argument("--only", nargs="+", metavar="NODE", help="run only these nodes and what they need")
    p.add_argument("--dry-run", action="store_true", help="say what would start, run nothing")
    p = sub.add_parser("done", help="record a task node done, after its outputs exist and its check passes")
    p.add_argument("node")
    p.add_argument("--note", help="one line on what was done")
    p = sub.add_parser("why", help="explain one node's state")
    p.add_argument("node")
    p = sub.add_parser("invalidate", help="reset a node and everything after it to pending")
    p.add_argument("node")
    p.add_argument("--only", action="store_true", help="reset just this node")
    p = sub.add_parser("stop", help="set a stop: no node starts until a person resumes")
    p.add_argument("--reason")
    sub.add_parser("resume", help="person only, in their own terminal: clear a stop")
    p = sub.add_parser("approve", help="person only, in their own terminal: approve a gate")
    p.add_argument("node")
    p = sub.add_parser("revoke", help="withdraw a gate's approval")
    p.add_argument("node")
    p = sub.add_parser("digest", help="print a gate's manifest and digest")
    p.add_argument("node")
    p = sub.add_parser("receipt", help="print the latest receipt, or one by name")
    p.add_argument("name", nargs="?")
    p = sub.add_parser("verify", help="re-hash outputs against a receipt and check the chain")
    p.add_argument("name", nargs="?")
    sub.add_parser("mermaid", help="print the graph as a Mermaid flowchart")
    return ap


COMMANDS = {"status": cmd_status, "run": cmd_run, "done": cmd_done, "why": cmd_why,
            "invalidate": cmd_invalidate, "stop": cmd_stop, "resume": cmd_resume,
            "approve": cmd_approve, "revoke": cmd_revoke, "digest": cmd_digest,
            "receipt": cmd_receipt, "verify": cmd_verify, "mermaid": cmd_mermaid}


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        if args.cmd == "init":
            return cmd_init(args)
        spec = Spec(args.spec)
        if args.cmd == "validate":
            return cmd_validate(spec, args)
        if spec.errors:
            for e in spec.errors:
                print("ERROR  " + e)
            print("fix the spec first (dag.py validate lists every problem)")
            return EXIT_FAIL
        if args.cmd == "plan":
            return cmd_plan(spec, args)
        script = os.path.realpath(__file__)
        invocation = f"python3 {tilde(script)} --spec {display(spec.path)}"
        return COMMANDS[args.cmd](Engine(spec, invocation), args)
    except DagError as e:
        print(f"dag.py: {e}", file=sys.stderr)
        return EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main())
