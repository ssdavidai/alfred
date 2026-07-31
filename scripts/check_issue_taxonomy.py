#!/usr/bin/env python3
"""Validate the prioritization taxonomy on open GitHub issues (#309).

Every open issue must carry **exactly one** label from each single-value
dimension and **at least one** `area:*` ownership label. This is what makes a
Now/Next/Later portfolio filterable without reading every issue.

Usage:
    python3 scripts/check_issue_taxonomy.py                # report only
    python3 scripts/check_issue_taxonomy.py --strict       # exit 1 if any gap
    python3 scripts/check_issue_taxonomy.py --issue 123    # one issue

Reads the repo from GITHUB_REPOSITORY (owner/name) or --repo; talks to the API
through `gh`, so it needs no extra dependency in CI.

Deliberately generic: it discovers the allowed values from the repository's
own label set rather than hard-coding them, so adding a `kind:` value is a
label change, not a code change, and no tenant-specific preference is baked in.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

# Single-value dimensions: exactly one label each.
SINGLE = ("kind", "impact", "effort", "priority", "horizon", "customer", "theme")
# Multi-value dimensions: at least one label.
MULTI = ("area",)


def gh_json(path: str) -> list[dict]:
    """Call the GitHub API via gh and return a flat list of JSON objects."""
    out = subprocess.run(
        ["gh", "api", "--paginate", path],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    decoder, items, i = json.JSONDecoder(), [], 0
    while i < len(out):
        while i < len(out) and out[i] in " \n\r\t":
            i += 1
        if i >= len(out):
            break
        obj, i = decoder.raw_decode(out, i)
        items.extend(obj) if isinstance(obj, list) else items.append(obj)
    return items


def classify(names: list[str]) -> tuple[list[str], list[str]]:
    """Return (missing, conflicting) dimension names for one issue."""
    missing, conflicting = [], []
    for dim in SINGLE:
        hits = [n for n in names if n.startswith(f"{dim}:")]
        if not hits:
            missing.append(dim)
        elif len(hits) > 1:
            conflicting.append(f"{dim} ({', '.join(sorted(hits))})")
    for dim in MULTI:
        if not any(n.startswith(f"{dim}:") for n in names):
            missing.append(dim)
    return missing, conflicting


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""))
    ap.add_argument("--issue", type=int, default=0)
    ap.add_argument("--strict", action="store_true",
                    help="exit non-zero when any open issue is unclassified")
    args = ap.parse_args()

    if not args.repo:
        print("error: pass --repo owner/name or set GITHUB_REPOSITORY", file=sys.stderr)
        return 2

    if args.issue:
        issues = [gh_json(f"/repos/{args.repo}/issues/{args.issue}")[0]]
    else:
        issues = gh_json(f"/repos/{args.repo}/issues?state=open&per_page=100")
    # Pull requests share the issues endpoint; they are not portfolio items.
    issues = [i for i in issues if "pull_request" not in i]

    bad = 0
    for issue in sorted(issues, key=lambda i: i["number"]):
        names = [lbl["name"] for lbl in issue.get("labels", [])]
        missing, conflicting = classify(names)
        if not missing and not conflicting:
            continue
        bad += 1
        print(f"#{issue['number']} {issue['title'][:66]}")
        if missing:
            print(f"    missing:     {', '.join(missing)}")
        if conflicting:
            print(f"    conflicting: {'; '.join(conflicting)}")

    total = len(issues)
    print(f"\n{total - bad}/{total} open issues fully classified.")
    if bad and args.strict:
        print("FAIL: every open issue must carry one value per dimension "
              "(see docs/ISSUE-TAXONOMY.md).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
