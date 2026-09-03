#!/usr/bin/env python3
"""Unit tests for the lane gate (scripts/hooks/check_lane.py).

Pure-logic tests (glob matching, boundary classification, config shape) plus
end-to-end tests that build throwaway git repos in a tempdir and run the gate
as a subprocess — covering the 2026-07-15 hardening:

  * deletions + rename-sources are caught (the old ACMR blindness),
  * phase0 is rejected from a linked worktree,
  * lanes.json is read from HEAD, so a local widening edit doesn't apply,
  * invented lane names die,
  * CI mode enforces boundary + forbidden zone + 3x scope on a branch diff.

Run:  python3 scripts/hooks/test_check_lane.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(HERE, "check_lane.py")
sys.path.insert(0, HERE)

check_lane = __import__("check_lane")


class TestMatch(unittest.TestCase):
    def test_prefix_glob(self):
        self.assertTrue(check_lane.match("packages/ctrl/**", "packages/ctrl/src/api/routes/vault.ts"))
        self.assertFalse(check_lane.match("packages/ctrl/**", "packages/ctrl-extra/x.ts"))

    def test_suffix_glob(self):
        self.assertTrue(check_lane.match("**/CONTRACT.md", "packages/learn/CONTRACT.md"))
        self.assertFalse(check_lane.match("**/CONTRACT.md", "packages/learn/CONTRACT.md.bak"))

    def test_exact(self):
        self.assertTrue(check_lane.match("docker-compose.yaml", "docker-compose.yaml"))
        self.assertFalse(check_lane.match("docker-compose.yaml", "deploy/docker-compose.yaml"))


class TestConfigShape(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(HERE, "lanes.json")) as fh:
            self.cfg = json.load(fh)

    def test_all_eight_lanes_plus_phase0(self):
        self.assertEqual(
            set(self.cfg["lanes"].keys()),
            {"I", "II", "III", "IV", "V", "VI", "VII", "VIII", "phase0"})

    def test_every_package_has_exactly_one_owning_lane(self):
        packages = ["alfred-vault", "ctrl", "hermes", "learn", "mcp-server",
                    "paperclip", "setup", "vault-init", "voice-bridge", "web"]
        for pkg in packages:
            probe = f"packages/{pkg}/some/file.ts"
            owners = [lid for lid, lane in self.cfg["lanes"].items()
                      if lid != "phase0"
                      and any(check_lane.match(g, probe) for g in lane["allowed"])]
            self.assertEqual(len(owners), 1, f"packages/{pkg} owned by {owners}")

    def test_forbidden_zone_covers_the_audit_set(self):
        fz = self.cfg["forbidden_zone"]
        for probe in [
            "packages/ctrl/src/db/migrations/0042_x.sql",
            "packages/ctrl/src/db/schema.sql",
            "packages/ctrl/src/api/server.ts",
            "packages/learn/CONTRACT.md",
            "docs/FIX-CONTRACTS.md",
            "docs/lane-protocol.md",
            "scripts/hooks/lanes.json",
            ".github/workflows/lane-gate.yml",
            "CLAUDE.md",
        ]:
            self.assertTrue(any(check_lane.match(g, probe) for g in fz),
                            f"{probe} not covered by forbidden zone")


class TestBoundary(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(HERE, "lanes.json")) as fh:
            self.cfg = json.load(fh)

    def check(self, lane_id, paths):
        return check_lane.boundary_violations(
            paths, lane_id, self.cfg["lanes"][lane_id], self.cfg["forbidden_zone"])

    def test_in_lane_ok(self):
        self.assertEqual(self.check("II", ["packages/learn/src/activities/x.py"]), [])

    def test_out_of_lane(self):
        v = self.check("II", ["packages/ctrl/src/api/routes/x.ts"])
        self.assertEqual(len(v), 1)
        self.assertIn("OUT OF LANE", v[0])

    def test_forbidden_zone_beats_allowed(self):
        # migrations are inside lane I's package glob but forbidden-zone wins
        v = self.check("I", ["packages/ctrl/src/db/migrations/0099_x.sql"])
        self.assertEqual(len(v), 1)
        self.assertIn("FORBIDDEN ZONE", v[0])

    def test_voice_bridge_now_owned(self):
        self.assertEqual(self.check("VI", ["packages/voice-bridge/src/server.ts"]), [])
        v = self.check("V", ["packages/voice-bridge/src/server.ts"])
        self.assertEqual(len(v), 1)  # the historic "voice under lane V" is now out-of-lane


def sh(cwd, *args, env=None):
    e = dict(os.environ)
    e.update(env or {})
    return subprocess.run(args, cwd=cwd, env=e, capture_output=True, text=True)


class TestEndToEnd(unittest.TestCase):
    """Throwaway-repo tests exercising the gate binary itself."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="lane-gate-test-")
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(os.path.join(self.repo, "scripts/hooks"))
        for f in ("check_lane.py", "lanes.json"):
            shutil.copy(os.path.join(HERE, f), os.path.join(self.repo, "scripts/hooks", f))
        sh(self.repo, "git", "init", "-q", "-b", "main")
        sh(self.repo, "git", "config", "user.email", "t@t")
        sh(self.repo, "git", "config", "user.name", "t")
        os.makedirs(os.path.join(self.repo, "packages/learn/src"))
        os.makedirs(os.path.join(self.repo, "packages/ctrl/src/db/migrations"))
        self.write("packages/learn/src/a.py", "x = 1\n")
        self.write("packages/ctrl/src/db/migrations/0001_init.sql", "-- init\n")
        sh(self.repo, "git", "add", "-A")
        sh(self.repo, "git", "commit", "-qm", "seed")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, rel, content):
        p = os.path.join(self.repo, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as fh:
            fh.write(content)

    def gate(self, cwd=None, env=None, *extra):
        return sh(cwd or self.repo, sys.executable, GATE, *extra,
                  env={"ALFRED_SKIP_VERIFY": "1", **(env or {})})

    def test_in_lane_commit_passes(self):
        self.write("packages/learn/src/b.py", "y = 2\n")
        sh(self.repo, "git", "add", "packages/learn/src/b.py")
        r = self.gate(env={"ALFRED_LANE": "II"})
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_deletion_of_forbidden_file_is_caught(self):
        sh(self.repo, "git", "rm", "-q", "packages/ctrl/src/db/migrations/0001_init.sql")
        r = self.gate(env={"ALFRED_LANE": "I"})
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("FORBIDDEN ZONE", r.stderr)

    def test_invented_lane_dies(self):
        self.write("packages/learn/src/b.py", "y = 2\n")
        sh(self.repo, "git", "add", "packages/learn/src/b.py")
        r = self.gate(env={"ALFRED_LANE": "CTRL"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("Unknown lane", r.stderr)

    def test_phase0_rejected_in_linked_worktree(self):
        wt = os.path.join(self.tmp, "wt")
        sh(self.repo, "git", "worktree", "add", "-q", wt, "-b", "wt-branch")
        with open(os.path.join(wt, ".lane"), "w") as fh:
            fh.write('{"lane": "phase0"}')
        self.write("packages/learn/src/b.py", "y = 2\n")  # noise in main repo
        p = os.path.join(wt, "packages/learn/src/c.py")
        with open(p, "w") as fh:
            fh.write("z = 3\n")
        sh(wt, "git", "add", "packages/learn/src/c.py")
        r = self.gate(cwd=wt)
        self.assertEqual(r.returncode, 1)
        self.assertIn("not self-declarable", r.stderr)

    def test_local_lanes_json_widening_is_ignored(self):
        # widen the on-disk lanes.json to allow lane II everywhere — the gate
        # must still use the HEAD copy and reject the out-of-lane file
        cfg_path = os.path.join(self.repo, "scripts/hooks/lanes.json")
        with open(cfg_path) as fh:
            cfg = json.load(fh)
        cfg["lanes"]["II"]["allowed"] = ["**"]
        with open(cfg_path, "w") as fh:
            json.dump(cfg, fh)
        self.write("packages/ctrl/src/api/routes/x.ts", "// out of lane\n")
        sh(self.repo, "git", "add", "packages/ctrl/src/api/routes/x.ts")
        r = self.gate(env={"ALFRED_LANE": "II"})
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("OUT OF LANE", r.stderr)

    def test_ci_mode_boundary_and_scope(self):
        sh(self.repo, "git", "checkout", "-qb", "lane-2/99-x")
        self.write("packages/learn/src/b.py", "y = 2\n")
        sh(self.repo, "git", "add", "-A")
        sh(self.repo, "git", "commit", "-qm", "lane II work")
        r = self.gate(None, {}, "--ci", "--lane", "II", "--base", "main")
        self.assertEqual(r.returncode, 0, r.stderr)
        # now cross the boundary
        self.write("packages/ctrl/src/api/routes/x.ts", "// oops\n")
        sh(self.repo, "git", "add", "-A")
        sh(self.repo, "git", "commit", "-qm", "cross-lane")
        r = self.gate(None, {}, "--ci", "--lane", "II", "--base", "main")
        self.assertEqual(r.returncode, 1)
        self.assertIn("OUT OF LANE", r.stderr)

    def test_ci_mode_phase0_allows_all(self):
        sh(self.repo, "git", "checkout", "-qb", "fix/operator-branch")
        self.write("CLAUDE.md", "# operator edit\n")
        sh(self.repo, "git", "add", "-A")
        sh(self.repo, "git", "commit", "-qm", "operator work")
        r = self.gate(None, {}, "--ci", "--lane", "phase0", "--base", "main")
        self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
