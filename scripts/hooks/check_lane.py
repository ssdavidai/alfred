#!/usr/bin/env python3
"""Lane-enforcement pre-commit gate for the Alfred fix fan-out.

Rejects a commit BEFORE it reaches the orchestrator if it:
  1. touches a file outside the current lane's ALLOWED globs (lane-jumping),
  2. touches anything in the global FORBIDDEN_ZONE (Phase-0-owned shared surface),
  3. exceeds the lane SCOPE_LIMIT (net changed LOC — the ~200-LOC discipline),
  4. fails the lane VERIFY command (the regression gate).

The lane is read from `.lane` (JSON, repo top-level, git-ignored) or $ALFRED_LANE.
A *linked worktree* with no `.lane` is rejected (fail-safe — a lane agent must
declare its lane). The *main* checkout with no `.lane` is the `phase0`
orchestrator lane (allow-all), so this never blocks normal work on main.

`.lane` format:  {"lane": "II"}            # required: I|II|III|IV|V
                 {"lane": "II", "verify": "cd packages/learn && python -m pytest tests/test_signals.py -q"}
                 {"lane": "II", "scope_limit": 350}   # only for a justified larger task

Escape hatch:    ALFRED_SKIP_VERIFY=1 git commit ...   # skips ONLY the regression gate (boundary + scope still enforced)
"""
import fnmatch
import json
import os
import subprocess
import sys

RED, GREEN, YELLOW, RESET = "\033[31m", "\033[32m", "\033[33m", "\033[0m"


def run(*args):
    return subprocess.run(args, capture_output=True, text=True).stdout.strip()


def die(msg):
    sys.stderr.write(f"\n{RED}✗ commit blocked by the lane gate{RESET}\n\n{msg}\n\n")
    sys.exit(1)


def match(pattern, path):
    """a/b/** -> prefix; **/x -> suffix; exact -> equality; else fnmatch."""
    if pattern == path:
        return True
    if pattern.endswith("/**"):
        pre = pattern[:-3]
        return path == pre or path.startswith(pre + "/")
    if pattern.startswith("**/"):
        suf = pattern[3:]
        return path == suf or path.endswith("/" + suf)
    return fnmatch.fnmatch(path, pattern)


HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "lanes.json")) as fh:
    CFG = json.load(fh)

top = run("git", "rev-parse", "--show-toplevel")

# ---- resolve the lane ------------------------------------------------------
lane_id = None
verify_override = None
scope_override = None
lane_file = os.path.join(top, ".lane")
if os.path.exists(lane_file):
    try:
        data = json.load(open(lane_file))
    except (json.JSONDecodeError, OSError) as exc:
        die(f"`.lane` is present but unreadable: {exc}")
    lane_id = data.get("lane")
    verify_override = data.get("verify")
    scope_override = data.get("scope_limit")
lane_id = lane_id or os.environ.get("ALFRED_LANE")

git_dir = os.path.abspath(run("git", "rev-parse", "--git-dir"))
common_dir = os.path.abspath(run("git", "rev-parse", "--git-common-dir"))
is_linked_worktree = git_dir != common_dir

if lane_id is None:
    if is_linked_worktree:
        die("This is a linked worktree but has no `.lane` manifest.\n"
            "A lane agent must declare its lane before committing, e.g.:\n"
            "    echo '{\"lane\": \"II\"}' > .lane")
    lane_id = "phase0"  # main checkout, orchestrator — allow-all

if lane_id not in CFG["lanes"]:
    die(f"Unknown lane '{lane_id}'. Valid lanes: {', '.join(CFG['lanes'])}")

lane = CFG["lanes"][lane_id]
allowed = lane["allowed"]
forbidden = CFG["forbidden_zone"]
scope_limit = scope_override if scope_override is not None else lane.get("scope_limit", 200)
verify = verify_override or lane.get("verify", "true")

staged = [p for p in run("git", "diff", "--cached", "--name-only", "--diff-filter=ACMR").splitlines() if p]
if not staged:
    sys.exit(0)

# ---- 1 + 2: lane boundary + forbidden zone ---------------------------------
if lane_id != "phase0":
    violations = []
    for p in staged:
        if any(match(g, p) for g in forbidden):
            violations.append(f"  FORBIDDEN ZONE   {p}\n                   → Phase-0-owned shared surface. Coordinate centrally; do not edit in a lane.")
        elif not any(match(g, p) for g in allowed):
            violations.append(f"  OUT OF LANE      {p}\n                   → lane {lane_id} ({lane['name']}) owns only: {', '.join(allowed)}")
    if violations:
        die("Lane-jumping detected — these staged files are not in your lane:\n\n" + "\n".join(violations))

# ---- 3: scope limit (net changed LOC) --------------------------------------
loc = 0
for line in run("git", "diff", "--cached", "--numstat").splitlines():
    parts = line.split("\t")
    if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
        loc += int(parts[0]) + int(parts[1])
if loc > scope_limit:
    die(f"Scope limit exceeded: {loc} LOC changed > {scope_limit} cap for lane {lane_id}.\n"
        f"A task this big should be split. Per your brief: STOP and report.\n"
        f"(If this single task legitimately needs more, set \"scope_limit\" in .lane and say so in the PR.)")

# ---- 4: verify (regression gate) -------------------------------------------
if os.environ.get("ALFRED_SKIP_VERIFY") == "1":
    sys.stderr.write(f"{YELLOW}⚠ ALFRED_SKIP_VERIFY=1 — regression gate skipped (boundary + scope still enforced).{RESET}\n")
else:
    sys.stderr.write(f"▶ lane {lane_id} verify: {verify}\n")
    if subprocess.run(verify, shell=True, cwd=top).returncode != 0:
        die(f"VERIFY failed: {verify}\n"
            f"A test/typecheck regressed. Fix it before committing, or scope the change down.\n"
            f"(Emergency-only override: ALFRED_SKIP_VERIFY=1 git commit …)")

sys.stderr.write(f"{GREEN}✓ lane {lane_id} ({lane['name']}) gate passed — {loc} LOC, {len(staged)} files, verify ok{RESET}\n")
sys.exit(0)
