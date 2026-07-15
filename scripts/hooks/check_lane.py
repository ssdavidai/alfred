#!/usr/bin/env python3
"""Lane-enforcement gate for the Alfred fix fan-out.

Two modes:

  pre-commit (default, no args)
      Runs against the STAGED diff. Rejects a commit BEFORE it reaches the
      orchestrator if it:
        1. touches a file outside the current lane's ALLOWED globs (lane-jumping),
        2. touches anything in the global FORBIDDEN_ZONE (Phase-0-owned),
        3. exceeds the lane SCOPE_LIMIT (net changed LOC — the ~200-LOC discipline),
        4. fails the lane VERIFY command (the regression gate).
      The lane is read from `.lane` (JSON, worktree top-level, git-ignored)
      or $ALFRED_LANE.

  --ci --lane <ID> --base <ref>   (server-side replay; .github/workflows/lane-gate.yml)
      Runs rules 1-3 against the merge-base diff `<ref>...HEAD` of a PR.
      VERIFY is skipped in CI (ci-check.yml runs the builds/tests). Scope is
      soft up to 3x the cap (warn), hard-fail above — a PR may bundle a few
      <=200-LOC commits. Local hook removal does NOT bypass this mode.

Hardening (2026-07-15, post-audit):
  * Deletions and rename-sources now count — `--name-status` parsing includes
    D entries and both sides of R/C entries (the old `--diff-filter=ACMR
    --name-only` was blind to a lane deleting forbidden-zone files).
  * `phase0` is NOT self-declarable from a linked worktree — the main
    checkout is the only phase0 context. A `.lane` (or $ALFRED_LANE) that
    claims phase0 inside a linked worktree is rejected.
  * lanes.json is loaded from HEAD (`git show HEAD:scripts/hooks/lanes.json`)
    when available, so an uncommitted local edit to lanes.json cannot widen
    the rules for the same commit. Falls back to the on-disk copy only when
    HEAD has no copy (fresh repo).

`.lane` format:  {"lane": "II"}            # required: I|II|III|IV|V|VI|VII
                 {"lane": "II", "verify": "cd packages/learn && python -m pytest tests/test_signals.py -q"}
                 {"lane": "II", "scope_limit": 350}   # only for a justified larger task

Escape hatch:    ALFRED_SKIP_VERIFY=1 git commit ...   # skips ONLY the regression gate (boundary + scope still enforced)
"""
import argparse
import fnmatch
import json
import os
import subprocess
import sys

RED, GREEN, YELLOW, RESET = "\033[31m", "\033[32m", "\033[33m", "\033[0m"

ROMAN_LANES = ("I", "II", "III", "IV", "V", "VI", "VII")


def run(*args):
    return subprocess.run(args, capture_output=True, text=True).stdout.strip()


def die(msg):
    sys.stderr.write(f"\n{RED}✗ blocked by the lane gate{RESET}\n\n{msg}\n\n")
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


def load_config():
    """lanes.json from HEAD (tamper-resistant); fall back to the local file."""
    head_copy = run("git", "show", "HEAD:scripts/hooks/lanes.json")
    if head_copy:
        try:
            return json.loads(head_copy)
        except json.JSONDecodeError:
            pass  # corrupted HEAD copy — fall through to on-disk
    here = os.path.dirname(os.path.abspath(os.path.realpath(__file__)))
    with open(os.path.join(here, "lanes.json")) as fh:
        return json.load(fh)


def changed_paths(diff_args):
    """All paths touched by the diff, including deletions and BOTH sides of
    renames/copies. Returns (paths, net_loc)."""
    paths = set()
    for line in run("git", "diff", *diff_args, "--name-status", "-M", "-C").splitlines():
        parts = line.split("\t")
        if not parts or not parts[0]:
            continue
        status = parts[0][0]
        if status in ("A", "M", "D", "T") and len(parts) >= 2:
            paths.add(parts[1])
        elif status in ("R", "C") and len(parts) >= 3:
            paths.add(parts[1])  # source — moving a file OUT of a zone counts
            paths.add(parts[2])  # destination
    loc = 0
    for line in run("git", "diff", *diff_args, "--numstat").splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            loc += int(parts[0]) + int(parts[1])
    return sorted(paths), loc


def boundary_violations(paths, lane_id, lane, forbidden):
    violations = []
    for p in paths:
        if any(match(g, p) for g in forbidden):
            violations.append(
                f"  FORBIDDEN ZONE   {p}\n"
                f"                   → Phase-0-owned shared surface. Coordinate centrally; do not edit in a lane.")
        elif not any(match(g, p) for g in lane["allowed"]):
            violations.append(
                f"  OUT OF LANE      {p}\n"
                f"                   → lane {lane_id} ({lane['name']}) owns only: {', '.join(lane['allowed'])}")
    return violations


def main():
    ap = argparse.ArgumentParser(description="Alfred lane gate")
    ap.add_argument("--ci", action="store_true", help="CI replay mode (diff vs --base, no VERIFY)")
    ap.add_argument("--lane", help="lane id (CI mode; hook mode reads .lane/$ALFRED_LANE)")
    ap.add_argument("--base", help="base ref for the PR diff (CI mode)")
    args = ap.parse_args()

    cfg = load_config()
    forbidden = cfg["forbidden_zone"]

    if args.ci:
        lane_id = args.lane or "phase0"
        if lane_id not in cfg["lanes"]:
            die(f"Unknown lane '{lane_id}'. Valid lanes: {', '.join(cfg['lanes'])}")
        if lane_id == "phase0":
            sys.stderr.write(f"{YELLOW}◦ phase0 (operator) branch — lane gate allows all; "
                             f"forbidden-zone and scope rules do not apply.{RESET}\n")
            sys.exit(0)
        if not args.base:
            die("--ci requires --base <ref>")
        merge_base = run("git", "merge-base", args.base, "HEAD")
        if not merge_base:
            die(f"cannot resolve merge-base of {args.base} and HEAD")
        paths, loc = changed_paths([merge_base, "HEAD"])
        lane = cfg["lanes"][lane_id]
        violations = boundary_violations(paths, lane_id, lane, forbidden)
        if violations:
            die(f"PR violates lane {lane_id} boundaries:\n\n" + "\n".join(violations))
        cap = lane.get("scope_limit", 200)
        if loc > cap * 3:
            die(f"PR scope {loc} LOC exceeds 3x the lane {lane_id} cap ({cap}). "
                f"Split the work — the protocol is ~{cap} net LOC per task.")
        if loc > cap:
            sys.stderr.write(f"{YELLOW}⚠ PR scope {loc} LOC exceeds the lane {lane_id} cap ({cap}) "
                             f"— acceptable only if the PR bundles several <=cap commits; "
                             f"reviewer should check.{RESET}\n")
        sys.stderr.write(f"{GREEN}✓ lane {lane_id} ({lane['name']}) CI gate passed — "
                         f"{loc} LOC, {len(paths)} files{RESET}\n")
        sys.exit(0)

    # ---- pre-commit mode -----------------------------------------------------
    top = run("git", "rev-parse", "--show-toplevel")

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
                "    echo '{\"lane\": \"II\"}' > .lane\n"
                f"Valid lanes: {', '.join(ROMAN_LANES)}")
        lane_id = "phase0"  # main checkout, orchestrator — allow-all

    if lane_id == "phase0" and is_linked_worktree:
        die("phase0 (orchestrator, allow-all) is not self-declarable from a linked worktree.\n"
            "Orchestrator work happens in the MAIN checkout. Declare a real lane here:\n"
            f"    valid lanes: {', '.join(ROMAN_LANES)}")

    if lane_id not in cfg["lanes"]:
        die(f"Unknown lane '{lane_id}'. Valid lanes: {', '.join(cfg['lanes'])}")

    lane = cfg["lanes"][lane_id]
    scope_limit = scope_override if scope_override is not None else lane.get("scope_limit", 200)
    verify = verify_override or lane.get("verify", "true")

    paths, loc = changed_paths(["--cached"])
    if not paths:
        sys.exit(0)

    # ---- 1 + 2: lane boundary + forbidden zone (deletions + renames included)
    if lane_id != "phase0":
        violations = boundary_violations(paths, lane_id, lane, forbidden)
        if violations:
            die("Lane-jumping detected — these staged files are not in your lane:\n\n"
                + "\n".join(violations))

    # ---- 3: scope limit (net changed LOC) ------------------------------------
    if loc > scope_limit:
        die(f"Scope limit exceeded: {loc} LOC changed > {scope_limit} cap for lane {lane_id}.\n"
            f"A task this big should be split. Per your brief: STOP and report.\n"
            f"(If this single task legitimately needs more, set \"scope_limit\" in .lane and say so in the PR.)")

    # ---- 4: verify (regression gate) ------------------------------------------
    if os.environ.get("ALFRED_SKIP_VERIFY") == "1":
        sys.stderr.write(f"{YELLOW}⚠ ALFRED_SKIP_VERIFY=1 — regression gate skipped "
                         f"(boundary + scope still enforced).{RESET}\n")
    else:
        sys.stderr.write(f"▶ lane {lane_id} verify: {verify}\n")
        if subprocess.run(verify, shell=True, cwd=top).returncode != 0:
            die(f"VERIFY failed: {verify}\n"
                f"A test/typecheck regressed. Fix it before committing, or scope the change down.\n"
                f"(Emergency-only override: ALFRED_SKIP_VERIFY=1 git commit …)")

    sys.stderr.write(f"{GREEN}✓ lane {lane_id} ({lane['name']}) gate passed — "
                     f"{loc} LOC, {len(paths)} files, verify ok{RESET}\n")
    sys.exit(0)


if __name__ == "__main__":
    main()
