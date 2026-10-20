"""Tests for dag.py. Standard library only.

    python3 -m unittest discover -s ~/.claude/skills/dag/tests -v

Each test builds a small job in a temporary folder and drives dag.py through
its command line, the way an agent does.
"""
import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DAG = os.path.join(os.path.dirname(HERE), "scripts", "dag.py")
PY = sys.executable

BUILD = """
import glob, json, os
entries = []
for path in sorted(glob.glob("inbox/*.md")):
    with open(path) as f:
        title = f.readline().lstrip("# ").strip()
    entries.append({"file": os.path.basename(path), "title": title})
os.makedirs("out", exist_ok=True)
with open("out/index.json", "w") as f:
    json.dump(entries, f, sort_keys=True)
os.makedirs("counts", exist_ok=True)
with open("counts/build", "a") as f:
    f.write("x")
"""

EVAL = """
import json, os, sys
entries = json.load(open("out/index.json"))
os.makedirs("counts", exist_ok=True)
with open("counts/eval", "a") as f:
    f.write("x")
sys.exit(0 if len(entries) >= 3 else 1)
"""

DEPLOY = """set -e
mkdir -p live counts
cp out/index.json live/index.json
printf x >> counts/deploy
"""


def pipeline():
    return {
        "dag": "promo",
        "description": "Promote the corpus index.",
        "nodes": {
            "build": {"run": [PY, "build.py"], "inputs": ["inbox/*.md", "build.py"],
                      "outputs": ["out/index.json"], "idempotent": True},
            "eval": {"after": ["build"], "run": [PY, "eval.py"],
                     "inputs": ["out/index.json", "eval.py"]},
            "approve": {"after": ["eval"], "gate": {"review": ["out/index.json"],
                                                    "summary": "Ship this index?",
                                                    "approver": "Sam"}},
            "deploy": {"after": ["approve"], "run": ["sh", "deploy.sh"],
                       "inputs": ["out/index.json", "deploy.sh"],
                       "outputs": ["live/index.json"], "effect": "irreversible"},
        },
    }


def iso(offset_s=0.0):
    t = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=offset_s)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Box:
    """A temporary job folder plus helpers to drive dag.py in it."""

    def __init__(self, test, spec=None):
        self.dir = tempfile.mkdtemp(prefix="dagtest-")
        test.addCleanup(shutil.rmtree, self.dir, True)
        self.home = os.path.join(self.dir, "_gatehome")
        if spec is not None:
            self.spec(spec)

    def path(self, rel):
        return os.path.join(self.dir, rel)

    def write(self, rel, text):
        full = self.path(rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write(text)

    def read(self, rel):
        with open(self.path(rel)) as f:
            return f.read()

    def exists(self, rel):
        return os.path.exists(self.path(rel))

    def spec(self, obj):
        self.write("dag.json", json.dumps(obj, indent=2))

    def env(self, **extra):
        e = dict(os.environ)
        e.pop("CLAUDECODE", None)
        e.update({"DAG_GATE_HOME": self.home, "DAG_RETRY_BACKOFF": "0"})
        e.update(extra)
        return e

    def dag(self, *args, **env):
        p = subprocess.run([PY, DAG, "--spec", self.path("dag.json"), *args],
                           cwd=self.dir, env=self.env(**env), capture_output=True,
                           text=True, timeout=120, stdin=subprocess.DEVNULL)
        return p.returncode, p.stdout + p.stderr

    def state(self):
        with open(self.path(".dag/state.json")) as f:
            return json.load(f)

    def count(self, name):
        return len(self.read("counts/" + name)) if self.exists("counts/" + name) else 0

    def digest(self, node):
        code, out = self.dag("digest", node)
        assert code == 0, out
        return out.strip().splitlines()[-1]

    def approve(self, node, via="dag-gate:/dag-approve (composer)", at=None, digest=None):
        """Write the approval record the dag-gate mod writes."""
        rec = {"format": 1, "dag": json.loads(self.read("dag.json"))["dag"], "node": node,
               "digest": digest or self.digest(node), "approved_at": at or iso(),
               "via": via, "dag_dir": os.path.realpath(self.dir)}
        self.write(f".dag/approvals/{node}.json", json.dumps(rec))
        return rec

    def terminal(self, *args, typed=""):
        """Run dag.py on a pseudo-terminal, the way a person does, typing `typed` at its prompt."""
        import pty
        import select
        master, slave = pty.openpty()
        p = subprocess.Popen([PY, DAG, "--spec", self.path("dag.json"), *args], cwd=self.dir,
                             env=self.env(), stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        out, deadline = b"", time.time() + 60
        try:
            os.write(master, (typed + "\n").encode())
            while time.time() < deadline:
                ready, _, _ = select.select([master], [], [], 0.2)
                if not ready:
                    if p.poll() is not None:
                        break
                    continue
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                out += chunk
            code = p.wait(timeout=10)
        finally:
            if p.poll() is None:
                p.kill()
                p.wait()
            os.close(master)
        return code, out.decode(errors="replace")

    def pipeline(self, docs=("Alpha", "Beta", "Gamma")):
        self.spec(pipeline())
        self.write("build.py", BUILD)
        self.write("eval.py", EVAL)
        self.write("deploy.sh", DEPLOY)
        for i, title in enumerate(docs):
            self.write(f"inbox/{chr(97 + i)}.md", f"# {title}\nbody\n")


class ValidateTest(unittest.TestCase):
    def check(self, spec, *needles, code=1):
        box = Box(self, spec)
        got, out = box.dag("validate")
        self.assertEqual(got, code, out)
        for needle in needles:
            self.assertIn(needle, out)
        return out

    def test_cycle_prints_the_path(self):
        out = self.check({"dag": "c", "nodes": {
            "a": {"after": ["c"]}, "b": {"after": ["a"]}, "c": {"after": ["b"]}}}, "cycle:")
        line = [x for x in out.splitlines() if "cycle:" in x][0]
        for name in "abc":
            self.assertIn(name, line)

    def test_unknown_dependency_suggests_a_name(self):
        self.check({"dag": "c", "nodes": {"build": {}, "test": {"after": ["buidl"]}}},
                   "unknown node 'buidl'", "did you mean 'build'")

    def test_unknown_key_is_an_error(self):
        self.check({"dag": "c", "nodes": {"a": {}, "b": {"aftr": ["a"]}}},
                   "unknown key 'aftr'", "did you mean 'after'")

    def test_retries_need_idempotent(self):
        self.check({"dag": "c", "nodes": {"a": {"run": "true", "retries": 2}}},
                   "retries need")

    def test_effect_needs_a_gate_upstream(self):
        self.check({"dag": "c", "nodes": {
            "send": {"run": "true", "inputs": ["x"], "effect": "external"}}},
            "no gate upstream", "topology")

    def test_hidden_edge_on_shared_output(self):
        self.check({"dag": "c", "nodes": {
            "a": {"run": "true", "inputs": ["x"], "outputs": ["out/r.json"]},
            "b": {"run": "true", "inputs": ["y"], "outputs": ["out/r.json"]}}},
            "hidden edge", "out/r.json")

    def test_hidden_edge_on_shared_write_target_and_the_idempotent_escape(self):
        nodes = {"a": {"run": "true", "inputs": ["x"], "writes": ["git:branch/main"]},
                 "b": {"run": "true", "inputs": ["y"], "writes": ["git:branch/main"]}}
        self.check({"dag": "c", "nodes": nodes}, "hidden edge", "git:branch/main",
                   "idempotent_targets")
        self.check({"dag": "c", "nodes": nodes, "idempotent_targets": {
            "git:branch/main": "both push the same commit"}}, code=0)

    def test_race_between_unordered_writer_and_reader(self):
        self.check({"dag": "c", "nodes": {
            "a": {"run": "true", "inputs": ["x"], "outputs": ["out/r.json"]},
            "b": {"run": "true", "inputs": ["out/*.json"]}}}, "race", "out/r.json")

    def test_file_cycle(self):
        self.check({"dag": "c", "nodes": {
            "a": {"run": "true", "inputs": ["notes.txt"], "outputs": ["a.txt"]},
            "b": {"after": ["a"], "run": "true", "inputs": ["a.txt"],
                  "outputs": ["notes.txt"]}}}, "file cycle")

    def test_node_cannot_read_its_own_output(self):
        self.check({"dag": "c", "nodes": {
            "a": {"run": "true", "inputs": ["f.txt"], "outputs": ["f.txt"]}}},
            "its own output")

    def test_fake_edge_warning_and_order_only(self):
        spec = {"dag": "c", "nodes": {
            "a": {"run": "true", "inputs": ["x"], "outputs": ["a.txt"]},
            "b": {"after": ["a"], "run": "true", "inputs": ["other.txt"]}}}
        out = self.check(spec, "fake edge?", code=0)
        self.assertIn("order_only", out)
        spec["nodes"]["b"] = {"order_only": ["a"], "run": "true", "inputs": ["other.txt"]}
        out = self.check(spec, code=0)
        self.assertNotIn("fake edge", out)

    def test_glob_output_is_an_error(self):
        self.check({"dag": "c", "nodes": {
            "a": {"run": "true", "inputs": ["x"], "outputs": ["out/*.json"]}}}, "is a glob")

    def test_work_between_the_gate_and_the_effect_is_flagged(self):
        out = self.check({"dag": "c", "nodes": {
            "ok": {"gate": {"review": ["brief.md"]}},
            "draft": {"after": ["ok"], "outputs": ["draft.md"]},
            "send": {"after": ["draft"], "inputs": ["draft.md"], "effect": "external"}}}, code=0)
        self.assertIn("no approval covers", out)

    def test_gate_takes_no_command(self):
        self.check({"dag": "c", "nodes": {
            "g": {"run": "true", "gate": {"review": ["x"]}}}}, "a gate takes no")

    def test_template_from_init_validates(self):
        box = Box(self)
        code, out = box.dag("init", "--name", "starter")
        self.assertEqual(code, 0, out)
        code, out = box.dag("validate")
        self.assertEqual(code, 0, out)


class PlanTest(unittest.TestCase):
    def test_diamond_is_mostly_serial(self):
        box = Box(self, {"dag": "d", "nodes": {
            "a": {"inputs": [], "est_minutes": 1},
            "b": {"order_only": ["a"], "est_minutes": 1},
            "c": {"order_only": ["a"], "est_minutes": 1},
            "d": {"order_only": ["b", "c"], "est_minutes": 1}}})
        code, out = box.dag("plan")
        self.assertEqual(code, 0, out)
        self.assertIn("wave 1  a", out)
        self.assertIn("wave 2  b, c", out)
        self.assertIn("critical path  a -> b -> d", out)
        self.assertIn("-j 1", out)

    def test_wide_graph_pays(self):
        nodes = {f"n{i}": {"est_minutes": 1} for i in range(10)}
        nodes["join"] = {"order_only": list(nodes), "est_minutes": 1}
        box = Box(self, {"dag": "w", "nodes": nodes})
        code, out = box.dag("plan")
        self.assertEqual(code, 0, out)
        self.assertIn("parallel waves pay", out)


class RunTest(unittest.TestCase):
    def test_runs_to_the_gate_and_files_a_request(self):
        box = Box(self)
        box.pipeline()
        code, out = box.dag("run")
        self.assertEqual(code, 2, out)
        self.assertEqual((box.count("build"), box.count("eval"), box.count("deploy")), (1, 1, 0))
        req = json.loads(box.read(".dag/gates/approve.json"))
        self.assertEqual(req["digest"], box.digest("approve"))
        self.assertEqual(req["dag_dir"], os.path.realpath(box.dir))
        self.assertIn("/dag-approve approve " + req["digest"][7:13], out)
        reg = os.listdir(os.path.join(box.home, "registry"))
        self.assertEqual(len(reg), 1)

    def test_dry_run_writes_nothing(self):
        box = Box(self)
        box.pipeline()
        code, out = box.dag("run", "--dry-run")
        self.assertIn("would start: build", out)
        self.assertFalse(box.exists(".dag"), out)
        self.assertFalse(os.path.exists(box.home), out)
        code, out = box.dag("run")
        self.assertEqual(code, 2, out)
        os.remove(box.path(".dag/gates/approve.json"))
        shutil.rmtree(box.home)
        before = {p: box.read(".dag/" + p) for p in ("state.json", "events.jsonl")}
        code, out = box.dag("run", "--dry-run")
        self.assertEqual(code, 2, out)
        self.assertIn("would ask for approval", out)
        self.assertIn("would start: nothing", out)
        self.assertFalse(box.exists(".dag/gates/approve.json"), out)
        self.assertFalse(os.path.exists(box.home), out)
        self.assertEqual({p: box.read(".dag/" + p) for p in before}, before)

    def test_approval_lets_the_effect_run_once_and_writes_a_receipt(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        box.approve("approve")
        code, out = box.dag("run")
        self.assertEqual(code, 0, out)
        self.assertEqual(box.count("deploy"), 1)
        self.assertEqual(box.read("live/index.json"), box.read("out/index.json"))
        st = box.state()
        self.assertEqual(st["spent"][0]["gate"], "approve")
        self.assertEqual(st["spent"][0]["by"], "deploy")
        code, out = box.dag("run")
        self.assertEqual(code, 0, out)
        self.assertEqual(box.count("deploy"), 1, "a current effect must not run again")
        latest = box.read(".dag/receipts/LATEST").strip()
        rec = json.loads(box.read(".dag/receipts/" + latest))
        self.assertEqual(rec["steps"][0]["node"], "deploy")
        self.assertTrue(rec["steps"][0]["observed"])
        self.assertEqual(rec["gates_passed"][0]["node"], "approve")

    def test_second_run_skips_everything(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        box.dag("run")
        self.assertEqual((box.count("build"), box.count("eval")), (1, 1))

    def test_early_cutoff_same_output_does_not_rerun_downstream(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        box.approve("approve")
        box.dag("run")
        box.write("build.py", BUILD + "\n# a comment changes the input, not the output\n")
        code, out = box.dag("run")
        self.assertEqual(code, 0, out)
        self.assertEqual(box.count("build"), 2)
        self.assertEqual(box.count("eval"), 1)
        self.assertEqual(box.count("deploy"), 1)

    def test_new_input_makes_the_approval_stale(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        box.approve("approve")
        box.write("inbox/d.md", "# Delta\nbody\n")
        code, out = box.dag("run")
        self.assertEqual(code, 2, out)
        self.assertIn("stale", out)
        self.assertEqual(box.count("deploy"), 0)
        self.assertEqual(json.loads(box.read("out/index.json"))[-1]["title"], "Delta")

    def test_output_drift_reruns_the_node(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        box.write("out/index.json", "[]")
        code, out = box.dag("status")
        self.assertIn("output changed on disk", out)
        box.dag("run")
        self.assertEqual(box.count("build"), 2)

    def test_failure_stops_the_branch_and_reruns_after_a_fix(self):
        box = Box(self)
        box.pipeline(docs=("Alpha", "Beta"))
        code, out = box.dag("run")
        self.assertEqual(code, 1, out)
        self.assertIn("eval", out)
        self.assertEqual(box.state()["nodes"]["eval"]["status"], "failed")
        self.assertFalse(box.exists(".dag/gates/approve.json"))
        box.write("inbox/c.md", "# Gamma\nbody\n")
        code, out = box.dag("run")
        self.assertEqual(code, 2, out)
        self.assertTrue(box.exists(".dag/gates/approve.json"))

    def test_check_is_an_anchor(self):
        box = Box(self, {"dag": "k", "nodes": {
            "a": {"run": "true", "inputs": ["x"], "check": "false"}}})
        box.write("x", "1")
        code, out = box.dag("run")
        self.assertEqual(code, 1, out)
        self.assertIn("check failed", out)

    def test_missing_declared_output_fails(self):
        box = Box(self, {"dag": "k", "nodes": {
            "a": {"run": "true", "inputs": ["x"], "outputs": ["made.txt"]}}})
        box.write("x", "1")
        code, out = box.dag("run")
        self.assertEqual(code, 1, out)
        self.assertIn("made.txt", out)

    def test_retry_only_for_idempotent(self):
        flaky = "if [ -f tried ]; then echo ok > out.txt; else touch tried; exit 1; fi"
        box = Box(self, {"dag": "k", "nodes": {
            "a": {"run": flaky, "inputs": ["x"], "outputs": ["out.txt"],
                  "idempotent": True, "retries": 2}}})
        box.write("x", "1")
        code, out = box.dag("run")
        self.assertEqual(code, 0, out)
        self.assertEqual(box.state()["nodes"]["a"]["attempts"], 2)

    def test_timeout(self):
        box = Box(self, {"dag": "k", "nodes": {
            "a": {"run": "sleep 5", "inputs": ["x"], "timeout_s": 0.5}}})
        box.write("x", "1")
        t0 = time.time()
        code, out = box.dag("run")
        self.assertEqual(code, 1, out)
        self.assertIn("timed out", out)
        self.assertLess(time.time() - t0, 4)

    def test_parallel_waves(self):
        nodes = {"a": {"run": "sleep 0.8", "inputs": ["x"]},
                 "b": {"run": "sleep 0.8", "inputs": ["x"]}}
        box = Box(self, {"dag": "p", "nodes": nodes})
        box.write("x", "1")
        t0 = time.time()
        code, out = box.dag("run", "-j", "2")
        self.assertEqual(code, 0, out)
        self.assertLess(time.time() - t0, 1.5)

    def test_only_runs_the_named_node_and_its_ancestors(self):
        box = Box(self, {"dag": "o", "nodes": {
            "a": {"run": "echo a > a.txt", "inputs": ["x"], "outputs": ["a.txt"]},
            "b": {"after": ["a"], "run": "cat a.txt > b.txt", "inputs": ["a.txt"],
                  "outputs": ["b.txt"]},
            "c": {"run": "echo c > c.txt", "inputs": ["x"], "outputs": ["c.txt"]}}})
        box.write("x", "1")
        code, out = box.dag("run", "--only", "b")
        self.assertEqual(code, 0, out)
        self.assertTrue(box.exists("b.txt"))
        self.assertFalse(box.exists("c.txt"))


class GateTest(unittest.TestCase):
    def test_digest_matches_the_documented_manifest(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        code, out = box.dag("digest", "approve")
        self.assertEqual(code, 0, out)
        lines = out.strip().splitlines()
        manifest = "\n".join(lines[:-1]) + "\n"
        sha = hashlib.sha256(open(box.path("out/index.json"), "rb").read()).hexdigest()
        self.assertEqual(lines[:4], ["dag-gate/1", "dag promo", "node approve",
                                     f"file {sha} out/index.json"])
        self.assertRegex(lines[4], r"^effect deploy [0-9a-f]{64}$")
        self.assertEqual(lines[-1], "sha256:" + hashlib.sha256(manifest.encode()).hexdigest())
        req = json.loads(box.read(".dag/gates/approve.json"))
        self.assertEqual(req["manifest"], manifest)
        self.assertEqual(req["effects"], [{"node": "deploy", "fingerprint": lines[4].split()[-1]}])

    def test_editing_the_effect_script_after_approval_voids_it(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        box.approve("approve")
        box.write("deploy.sh", DEPLOY + "echo one more step\n")
        code, out = box.dag("run")
        self.assertEqual(code, 2, out)
        self.assertIn("stale", out)
        self.assertEqual(box.count("deploy"), 0)

    def test_effect_key_is_stable_for_the_same_content(self):
        box = Box(self)
        spec = pipeline()
        spec["nodes"]["deploy"]["outputs"] = ["live/index.json", "live/key.txt"]
        box.pipeline()
        box.spec(spec)
        box.write("deploy.sh", DEPLOY + 'printf %s "$DAG_EFFECT_KEY" > live/key.txt\n')
        box.dag("run")
        box.approve("approve")
        box.dag("run")
        first = box.read("live/key.txt")
        self.assertRegex(first, r"^[0-9a-f]{32}$")
        box.dag("invalidate", "deploy")
        box.approve("approve", at=iso(1))
        code, out = box.dag("run")
        self.assertEqual(code, 0, out)
        self.assertEqual(box.read("live/key.txt"), first)

    def test_forged_origin_is_ignored(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        box.approve("approve", via="claude")
        code, out = box.dag("run")
        self.assertEqual(code, 2, out)
        self.assertEqual(box.count("deploy"), 0)
        self.assertIn("not /dag-approve", out)

    def test_revoked_approval_blocks(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        box.approve("approve")
        code, out = box.dag("revoke", "approve")
        self.assertEqual(code, 0, out)
        code, out = box.dag("run")
        self.assertEqual(code, 2, out)
        self.assertIn("revoked", out)
        self.assertEqual(box.count("deploy"), 0)

    def test_an_approval_stays_with_its_folder(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        box.approve("approve")
        twin = Box(self)
        shutil.copytree(box.dir, twin.dir, dirs_exist_ok=True)
        code, out = twin.dag("run")
        self.assertEqual(code, 2, "a copied approval must not release the copy's effect\n" + out)
        self.assertIn("another folder", out)
        self.assertEqual(twin.count("deploy"), 0)
        req = json.loads(twin.read(".dag/gates/approve.json"))
        self.assertEqual(req["dag_dir"], os.path.realpath(twin.dir), "the copy files its own request")
        code, out = box.dag("run")
        self.assertEqual(code, 0, out)
        self.assertEqual(box.count("deploy"), 1)
        twin.approve("approve")
        code, out = twin.dag("run")
        self.assertEqual(code, 0, out)
        self.assertEqual(twin.count("deploy"), 1)

    def test_approval_without_its_folder_is_ignored(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        rec = box.approve("approve")
        del rec["dag_dir"]
        box.write(".dag/approvals/approve.json", json.dumps(rec))
        code, out = box.dag("run")
        self.assertEqual(code, 2, out)
        self.assertEqual(box.count("deploy"), 0)

    def test_a_folder_restored_from_backup_cannot_spend_the_approval_again(self):
        home = tempfile.mkdtemp(prefix="daghome-")
        self.addCleanup(shutil.rmtree, home, True)
        backup = tempfile.mkdtemp(prefix="dagbackup-")
        self.addCleanup(shutil.rmtree, backup, True)
        box = Box(self)
        box.pipeline()
        box.dag("run", DAG_GATE_HOME=home)
        box.approve("approve")
        shutil.copytree(box.dir, backup, dirs_exist_ok=True)
        code, out = box.dag("run", DAG_GATE_HOME=home)
        self.assertEqual(code, 0, out)
        self.assertEqual(box.count("deploy"), 1)
        # Restore the backup taken before the deploy: same path, approval unused in its state.json.
        shutil.rmtree(box.dir)
        shutil.copytree(backup, box.dir)
        code, out = box.dag("run", DAG_GATE_HOME=home)
        self.assertEqual(code, 2, "a restored folder must not spend the same approval again\n" + out)
        self.assertIn("needs-new-approval", out)
        self.assertEqual(box.count("deploy"), 0)
        box.approve("approve", at=iso(1))
        code, out = box.dag("run", DAG_GATE_HOME=home)
        self.assertEqual(code, 0, out)
        self.assertEqual(box.count("deploy"), 1)

    def test_a_symlink_left_at_the_old_path_does_not_carry_the_approval(self):
        home = tempfile.mkdtemp(prefix="daghome-")
        self.addCleanup(shutil.rmtree, home, True)
        root = tempfile.mkdtemp(prefix="dagroot-")
        self.addCleanup(shutil.rmtree, root, True)
        box = Box(self)
        job = box.dir
        self.addCleanup(lambda: os.path.islink(job) and os.unlink(job))
        box.pipeline()
        box.dag("run", DAG_GATE_HOME=home)
        box.approve("approve")
        backup, moved = os.path.join(root, "backup"), os.path.join(root, "moved")
        shutil.copytree(job, backup)
        code, out = box.dag("run", DAG_GATE_HOME=home)
        self.assertEqual(code, 0, out)
        # Restore the pre-run backup under a new name and leave a link at the old path pointing to it.
        shutil.rmtree(job)
        os.rename(backup, moved)
        os.symlink(moved, job)
        p = subprocess.run([PY, DAG, "--spec", os.path.join(moved, "dag.json"), "run"], cwd=moved,
                           env=box.env(DAG_GATE_HOME=home), capture_output=True, text=True, timeout=120,
                           stdin=subprocess.DEVNULL)
        out = p.stdout + p.stderr
        self.assertEqual(p.returncode, 2, "a link at the old path must not carry the approval\n" + out)
        self.assertIn("another folder", out)
        self.assertFalse(os.path.exists(os.path.join(moved, "counts", "deploy")))

    def test_an_effect_that_cannot_record_its_spend_does_not_run(self):
        home = tempfile.mkdtemp(prefix="daghome-")
        self.addCleanup(shutil.rmtree, home, True)
        ledger_dir = os.path.join(home, "spent")
        os.makedirs(ledger_dir)
        os.chmod(ledger_dir, 0o555)
        self.addCleanup(os.chmod, ledger_dir, 0o755)
        if os.access(ledger_dir, os.W_OK):
            self.skipTest("running with rights that ignore folder permissions")
        box = Box(self)
        box.pipeline()
        box.dag("run", DAG_GATE_HOME=home)
        box.approve("approve")
        code, out = box.dag("run", DAG_GATE_HOME=home)
        self.assertEqual(code, 1, out)
        self.assertIn("did not run", out)
        self.assertEqual(box.count("deploy"), 0)
        self.assertEqual(box.state()["spent"], [])
        os.chmod(ledger_dir, 0o755)
        code, out = box.dag("run", DAG_GATE_HOME=home)
        self.assertEqual(code, 0, out)
        self.assertEqual(box.count("deploy"), 1)

    def test_setting_home_does_not_move_the_ledger(self):
        # A command run with HOME pointed elsewhere would otherwise check an empty ledger and spend again.
        import pwd
        env = {k: v for k, v in os.environ.items() if k != "DAG_GATE_HOME"}
        env["HOME"] = tempfile.mkdtemp(prefix="dagfakehome-")
        self.addCleanup(shutil.rmtree, env["HOME"], True)
        load = ("import importlib.util, sys; s = importlib.util.spec_from_file_location('dag', sys.argv[1]); "
                "m = importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.gate_home())")
        p = subprocess.run([PY, "-c", load, DAG], env=env, capture_output=True, text=True, timeout=60,
                           stdin=subprocess.DEVNULL)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.strip(), os.path.join(pwd.getpwuid(os.getuid()).pw_dir, ".claude", "dag-gate"))

    def test_a_differently_cased_path_to_the_same_folder_keeps_its_approval(self):
        box = Box(self)
        upper = os.path.join(os.path.dirname(box.dir), os.path.basename(box.dir).upper())
        if not os.path.exists(upper) or os.path.realpath(upper) == os.path.realpath(box.dir):
            self.skipTest("needs a case-insensitive disk whose realpath keeps the typed case")
        box.pipeline()
        box.dag("run")
        box.approve("approve")
        p = subprocess.run([PY, DAG, "--spec", os.path.join(upper, "dag.json"), "run"], cwd=box.dir,
                           env=box.env(), capture_output=True, text=True, timeout=120,
                           stdin=subprocess.DEVNULL)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(box.count("deploy"), 1)

    def test_terminal_approval_names_its_folder(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        hexes = box.digest("approve")[7:13]
        code, out = box.terminal("approve", "approve", typed=hexes)
        self.assertEqual(code, 0, out)
        rec = json.loads(box.read(".dag/approvals/approve.json"))
        self.assertEqual(rec["via"], "dag.py approve (tty)")
        self.assertEqual(rec["dag_dir"], os.path.realpath(box.dir))
        code, out = box.dag("run")
        self.assertEqual(code, 0, out)
        self.assertEqual(box.count("deploy"), 1)

    def test_effect_needs_a_fresh_approval_to_run_again(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        first = box.approve("approve")
        box.dag("run")
        self.assertEqual(box.count("deploy"), 1)
        box.dag("invalidate", "deploy")
        code, out = box.dag("run")
        self.assertEqual(code, 2, out)
        self.assertIn("needs-new-approval", out)
        self.assertEqual(box.count("deploy"), 1)
        req = json.loads(box.read(".dag/gates/approve.json"))
        self.assertIsNotNone(req["not_before"])
        box.approve("approve", at=first["approved_at"])
        code, out = box.dag("run")
        self.assertEqual(code, 2, "re-writing the spent approval must not unlock it\n" + out)
        box.approve("approve", at=iso(1))
        code, out = box.dag("run")
        self.assertEqual(code, 0, out)
        self.assertEqual(box.count("deploy"), 2)

    def test_approve_and_resume_refuse_a_program(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        code, out = box.dag("approve", "approve", CLAUDECODE="1")
        self.assertEqual(code, 4, out)
        self.assertIn("/dag-approve", out)
        box.dag("stop")
        code, out = box.dag("resume")
        self.assertEqual(code, 4, out)
        self.assertIn("/dag-resume", out)


class TaskTest(unittest.TestCase):
    def spec(self):
        return {"dag": "t", "nodes": {
            "draft": {"description": "Write the draft.", "outputs": ["draft.md"]},
            "ok": {"after": ["draft"], "gate": {"review": ["draft.md"], "approver": "Sam"}},
            "send": {"after": ["ok"], "description": "Send it.", "inputs": ["draft.md"],
                     "effect": "external"}}}

    def test_task_flow(self):
        box = Box(self, self.spec())
        code, out = box.dag("run")
        self.assertEqual(code, 2, out)
        self.assertIn("do task draft", out)
        code, out = box.dag("done", "draft")
        self.assertEqual(code, 1, out)
        self.assertIn("draft.md", out)
        box.write("draft.md", "hello\n")
        code, out = box.dag("done", "draft", "--note", "wrote it")
        self.assertEqual(code, 0, out)
        code, out = box.dag("run")
        self.assertEqual(code, 2, out)
        self.assertIn("/dag-approve ok", out)
        code, out = box.dag("done", "send")
        self.assertEqual(code, 2, out)
        self.assertIn("not approved", out)
        box.approve("ok")
        code, out = box.dag("done", "send")
        self.assertEqual(code, 0, out)
        box.dag("invalidate", "send")
        code, out = box.dag("done", "send")
        self.assertEqual(code, 2, out)
        self.assertIn("once per approval", out)

    def test_done_refuses_cmd_and_gate_nodes(self):
        box = Box(self)
        box.pipeline()
        code, out = box.dag("done", "build")
        self.assertEqual(code, 1, out)
        code, out = box.dag("done", "approve")
        self.assertEqual(code, 1, out)
        self.assertIn("/dag-approve", out)


class StopTest(unittest.TestCase):
    def test_stop_blocks_until_a_person_resumes(self):
        box = Box(self)
        box.pipeline()
        code, out = box.dag("stop", "--reason", "Sam said wait")
        self.assertEqual(code, 0, out)
        code, out = box.dag("run")
        self.assertEqual(code, 3, out)
        self.assertIn("Sam said wait", out)
        self.assertEqual(box.count("build"), 0)
        box.write(".dag/STOP", json.dumps({"active": False, "by": "dag-gate:/dag-resume (composer)"}))
        code, out = box.dag("run")
        self.assertEqual(code, 2, out)
        self.assertEqual(box.count("build"), 1)

    def test_stop_mid_run_starts_nothing_new(self):
        box = Box(self, {"dag": "s", "nodes": {
            "a": {"run": "printf '{\"active\": true, \"reason\": \"mid\"}' > .dag/STOP; echo a > a.txt",
                  "inputs": ["x"], "outputs": ["a.txt"]},
            "b": {"after": ["a"], "run": "echo b > b.txt", "inputs": ["a.txt"],
                  "outputs": ["b.txt"]}}})
        box.write("x", "1")
        code, out = box.dag("run", "-j", "1")
        self.assertEqual(code, 3, out)
        self.assertTrue(box.exists("a.txt"))
        self.assertFalse(box.exists("b.txt"))


class DurabilityTest(unittest.TestCase):
    def test_interrupted_idempotent_node_reruns(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        st = box.state()
        st["nodes"]["build"]["status"] = "running"
        with open(box.path(".dag/state.json"), "w") as f:
            json.dump(st, f)
        code, out = box.dag("run")
        self.assertEqual(code, 2, out)
        self.assertEqual(box.count("build"), 2)

    def test_interrupted_non_idempotent_node_needs_a_look(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        st = box.state()
        st["nodes"]["eval"]["status"] = "running"
        with open(box.path(".dag/state.json"), "w") as f:
            json.dump(st, f)
        code, out = box.dag("run")
        self.assertEqual(code, 2, out)
        self.assertIn("interrupted", out)
        self.assertIn("invalidate eval", out)
        box.dag("invalidate", "eval")
        code, out = box.dag("run")
        self.assertEqual(box.count("eval"), 2)

    def test_a_second_runner_is_refused(self):
        box = Box(self, {"dag": "l", "nodes": {"a": {"run": "sleep 2", "inputs": ["x"]}}})
        box.write("x", "1")
        first = subprocess.Popen([PY, DAG, "--spec", box.path("dag.json"), "run"],
                                 cwd=box.dir, env=box.env(), stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
        try:
            deadline = time.time() + 5
            while time.time() < deadline:
                if box.exists(".dag/state.json") and box.state()["nodes"].get("a", {}).get("status") == "running":
                    break
                time.sleep(0.05)
            code, out = box.dag("run")
            self.assertEqual(code, 1, out)
            self.assertIn("lock", out)
            code, out = box.dag("status")
            self.assertIn("running", out)
        finally:
            first.wait(timeout=10)


class ReportTest(unittest.TestCase):
    def test_verify_catches_a_changed_output_and_the_chain_holds(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        box.approve("approve")
        box.dag("run")
        names = sorted(f for f in os.listdir(box.path(".dag/receipts")) if f.endswith(".json"))
        self.assertEqual(len(names), 2)
        # A sequence and a time to the second: no random hex, which output filters mask as a secret.
        self.assertRegex(names[0], r"^000001-\d{8}T\d{6}Z\.json$")
        self.assertRegex(names[1], r"^000002-\d{8}T\d{6}Z\.json$")
        second = json.loads(box.read(".dag/receipts/" + names[1]))
        first_sha = hashlib.sha256(open(box.path(".dag/receipts/" + names[0]), "rb").read()).hexdigest()
        self.assertEqual(second["prev_receipt_sha256"], first_sha)
        code, out = box.dag("verify")
        self.assertEqual(code, 0, out)
        box.write("live/index.json", "[]")
        code, out = box.dag("verify")
        self.assertEqual(code, 1, out)
        self.assertIn("live/index.json", out)

    def test_receipt_says_what_was_observed_and_what_was_reported(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        box.approve("approve")
        box.dag("run")
        rec = json.loads(box.read(".dag/receipts/" + box.read(".dag/receipts/LATEST").strip()))
        cov = rec["coverage"]
        self.assertEqual(cov["executed"], ["deploy"])
        self.assertEqual(cov["approved"], ["approve"])
        self.assertEqual(cov["reported"], [])
        self.assertEqual(cov["carried"], ["build", "eval"])
        task = Box(self, TaskTest().spec())
        task.write("draft.md", "hello\n")
        task.dag("done", "draft")
        rec = json.loads(task.read(".dag/receipts/" + task.read(".dag/receipts/LATEST").strip()))
        self.assertEqual(rec["coverage"]["reported"], ["draft"])
        self.assertEqual(rec["coverage"]["executed"], [])

    def test_why_names_the_changed_file(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        box.write("inbox/d.md", "# Delta\nbody\n")
        code, out = box.dag("why", "build")
        self.assertEqual(code, 0, out)
        self.assertIn("inbox/d.md", out)

    def test_status_json_and_mermaid(self):
        box = Box(self)
        box.pipeline()
        box.dag("run")
        code, out = box.dag("status", "--json")
        self.assertEqual(code, 0, out)
        data = json.loads(out)
        self.assertEqual(data["nodes"]["approve"]["status"], "awaiting-approval")
        self.assertIn("/dag-approve", data["next"])
        code, out = box.dag("mermaid")
        self.assertEqual(code, 0, out)
        self.assertIn("flowchart TD", out)
        self.assertIn("{{", out)


if __name__ == "__main__":
    unittest.main()
