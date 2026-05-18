#!/usr/bin/env python3
"""migrate-audits-to-sql.py — STORE-P2-3 bulk migration.

Walks the typed audit dirs under /vault that STORE-P0-3 sorted out
(signal_action/, steward_action/, desk_action/, needs_attention_action/,
auto_task_created/, state_change/, steward_source_pruned/, daily_digest/,
daily_brief/) and copies each markdown audit record into the SQLite
`audit` table via the ctrl-api `/api/v1/audit` endpoint.

Three-phase COPY-VERIFY-MOVE design:

  --phase copy    POST every file. Deterministic UUIDv5 ids make this
                  idempotent — a re-run on top of a partial run skips
                  rows already in the DB (server returns 409).
  --phase verify  Sample 1% of the manifest, fetch each row back, and
                  byte-compare the payload against the source frontmatter
                  + body. Exits non-zero on any mismatch.
  --phase move    Only safe after verify passes. Move source files to
                  /vault/_migrated_audit/<date>/<original-relpath> so the
                  operation is fully reversible by an `mv` back.

Designed to run inside the per-tenant `compose-alfred-learn-1` container,
which has Python 3.12, httpx, and pyyaml. The ctrl-api is reachable at
`http://ctrl-api:3100` on the compose network.

Per-tenant invocation (raj313 first → miguel → rapali → david):

  docker exec compose-alfred-learn-1 python3 /vault/_migrate/migrate-audits-to-sql.py \\
      --tenant raj313 --phase copy
  docker exec compose-alfred-learn-1 python3 /vault/_migrate/migrate-audits-to-sql.py \\
      --tenant raj313 --phase verify
  docker exec compose-alfred-learn-1 python3 /vault/_migrate/migrate-audits-to-sql.py \\
      --tenant raj313 --phase move
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import random
import re
import shutil
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
import yaml

# --------------------------------------------------------------------------
# Constants and config
# --------------------------------------------------------------------------

# Typed audit dirs created by STORE-P0-3 rescue. Order is largest-first
# for david, but POSTs are streamed serially so order is cosmetic. We
# walk smallest-impact first so a bug surfaces on small dirs early.
AUDIT_DIRS = [
    "signal_action",
    "steward_action",
    "desk_action",
    "needs_attention_action",
    "auto_task_created",
    "state_change",
    "steward_source_pruned",
    "daily_digest",
    "daily_brief",
]

# Map dir name → (actor, action_type) defaults for rows whose frontmatter
# omits an `actor` field. action_type matches the schema enum exactly
# (underscore form, see migration 003_audit.sql).
DIR_DEFAULTS: dict[str, tuple[str, str]] = {
    "signal_action": ("signal_router", "signal_action"),
    "steward_action": ("steward", "steward_action"),
    "desk_action": ("desk", "desk_action"),
    "needs_attention_action": ("signal_router", "needs_attention_action"),
    "auto_task_created": ("task_creation", "auto_task_created"),
    "state_change": ("state_mutator", "state_change"),
    "steward_source_pruned": ("steward", "steward_source_pruned"),
    "daily_digest": ("brief", "daily_digest"),
    "daily_brief": ("brief", "daily_brief"),
}

# Filename pattern: <prefix>-<timestamp>-...md, where <timestamp> is
# either ISO-8601 with `T`/`Z` separators or yyyy-MM-dd.
TS_RE = re.compile(
    r"(?P<ts>\d{4}-\d{2}-\d{2}(?:T\d{2}-\d{2}-\d{2}Z)?)"
)
FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n?(.*)$", re.DOTALL)

# UUIDv5 namespace — keeps ids deterministic across re-runs.
NAMESPACE = uuid.NAMESPACE_DNS

VERIFY_SAMPLE_FRACTION = 0.01  # 1%
VERIFY_SAMPLE_MIN = 5  # but always check at least 5 rows


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Split a vault markdown record into (frontmatter dict, body str).

    Returns ({}, text) when the file has no `---` fence — keeps the
    migration tolerant of half-formed records.
    """
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    try:
        fm = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        fm = {}
    if not isinstance(fm, dict):
        fm = {"_raw_frontmatter": fm}
    return fm, m.group(2)


def deterministic_id(rel_path: str) -> str:
    """UUIDv5 of the vault-relative path. Idempotent across re-runs."""
    return str(uuid.uuid5(NAMESPACE, f"vault-audit:{rel_path}"))


def filename_to_ns(filename: str, frontmatter: dict[str, Any]) -> int:
    """Best-effort unix-ns timestamp.

    Priority: frontmatter.timestamp → frontmatter.created → filename ISO →
    file mtime (caller passes via fallback). For the daily-brief/daily-digest
    records the filename is just `daily-brief-YYYY-MM-DD`, so we treat
    that as midnight UTC.
    """
    raw = frontmatter.get("timestamp") or frontmatter.get("generated_at")
    if isinstance(raw, str):
        try:
            return _iso_to_ns(raw)
        except ValueError:
            pass
    m = re.search(
        r"(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)", filename
    )
    if m:
        # canonical-form-with-dashes → replace with `:` for fromisoformat
        s = m.group(1)
        iso = f"{s[0:10]}T{s[11:13]}:{s[14:16]}:{s[17:19]}+00:00"
        try:
            return _iso_to_ns(iso)
        except ValueError:
            pass
    m = re.search(r"(\d{4}-\d{2}-\d{2})", filename)
    if m:
        try:
            return _iso_to_ns(f"{m.group(1)}T00:00:00+00:00")
        except ValueError:
            pass
    # last-ditch: epoch zero. Caller can detect and substitute mtime.
    return 0


def _iso_to_ns(iso: str) -> int:
    if iso.endswith("Z"):
        iso = iso[:-1] + "+00:00"
    d = dt.datetime.fromisoformat(iso)
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return int(d.timestamp() * 1_000_000_000)


def infer_target(
    frontmatter: dict[str, Any], dir_name: str
) -> tuple[str, str]:
    """Pull (target_type, target_id) out of frontmatter.

    Priority order is most-specific first. Falls back to dir-derived
    placeholders if nothing matches — keeps the POST schema-valid even
    on malformed source records.
    """
    fm = frontmatter
    # explicit fields, in priority order
    candidates: list[tuple[str | None, Any]] = [
        (fm.get("target_kind"), fm.get("target_path")),
        (None, fm.get("target")),
        (None, fm.get("needs_attention_path")),
    ]
    prior_fm = fm.get("prior_frontmatter")
    if isinstance(prior_fm, dict):
        candidates.append((None, prior_fm.get("parent_matter")))
    candidates.append((None, fm.get("parent_matter")))
    candidates.append((None, fm.get("matter_path")))
    candidates.append((None, fm.get("morning_brief_path")))
    candidates.append((None, fm.get("signal_path")))

    for kind, value in candidates:
        if value and isinstance(value, str):
            target_id = value
            if kind:
                return kind, target_id
            # Infer kind from the first path segment, e.g.
            # "matter/foo.md" → "matter".
            head = target_id.split("/", 1)[0]
            return head or "unknown", target_id

    # final fallback: tie the record to its dir
    return dir_name, dir_name


def build_post_body(
    rel_path: str, src_path: Path, dir_name: str
) -> dict[str, Any] | None:
    """Read one source file and produce the POST body. Returns None if
    the file is unreadable or fundamentally malformed.
    """
    try:
        text = src_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None

    fm, body = parse_frontmatter(text)
    default_actor, default_action = DIR_DEFAULTS.get(
        dir_name, ("unknown", dir_name)
    )

    actor = (
        fm.get("actor")
        or fm.get("source")
        or default_actor
    )
    if not isinstance(actor, str) or not actor:
        actor = default_actor

    action_type = default_action
    target_type, target_id = infer_target(fm, dir_name)

    decision_origin = fm.get("decision_reason") or fm.get(
        "source_event_path"
    )
    if not isinstance(decision_origin, str):
        decision_origin = None

    reasoning = fm.get("reasoning")
    if isinstance(reasoning, dict):
        reasoning = json.dumps(reasoning, sort_keys=True, default=str)
    elif not isinstance(reasoning, str):
        reasoning = None

    ns = filename_to_ns(src_path.name, fm)
    if ns == 0:
        try:
            ns = int(src_path.stat().st_mtime * 1_000_000_000)
        except OSError:
            ns = int(time.time() * 1_000_000_000)

    # Payload preserves the whole record so a round-trip can rebuild
    # the original markdown if needed. yaml safe_load can leave us with
    # date/datetime objects; default=str keeps json.dumps happy.
    payload = {
        "_source_rel_path": rel_path,
        "frontmatter": fm,
        "body": body,
    }

    return {
        "id": deterministic_id(rel_path),
        "ts": str(ns),
        "actor": actor,
        "action_type": action_type,
        "target_type": target_type,
        "target_id": target_id,
        "decision_origin": decision_origin,
        "reasoning": reasoning,
        "payload": json.dumps(payload, sort_keys=True, default=str),
        "reversible": 0,
    }


# --------------------------------------------------------------------------
# Phases
# --------------------------------------------------------------------------


def phase_copy(args: argparse.Namespace) -> int:
    vault = Path(args.vault)
    manifest_path = manifest_for(args)
    err_path = manifest_path.with_suffix(".err.log")

    client = httpx.Client(
        base_url=args.ctrl_url,
        headers={"Authorization": f"Bearer {args.api_key}"},
        timeout=args.timeout,
    )
    counters = {"posted": 0, "duplicate": 0, "error": 0, "skipped": 0}
    t0 = time.time()

    with manifest_path.open("a", encoding="utf-8") as manifest, err_path.open(
        "a", encoding="utf-8"
    ) as errf:
        for dir_name in AUDIT_DIRS:
            d = vault / dir_name
            if not d.is_dir():
                continue
            files = sorted(d.glob("*.md"))
            print(
                f"[copy] {dir_name}: {len(files)} files",
                flush=True,
            )
            for src in files:
                rel_path = str(src.relative_to(vault))
                body = build_post_body(rel_path, src, dir_name)
                if body is None:
                    counters["skipped"] += 1
                    errf.write(f"unreadable\t{rel_path}\n")
                    continue
                try:
                    r = client.post("/api/v1/audit", json=body)
                except httpx.HTTPError as e:
                    counters["error"] += 1
                    errf.write(f"http-error\t{rel_path}\t{e!r}\n")
                    continue
                if r.status_code == 201:
                    counters["posted"] += 1
                    manifest.write(f"{rel_path}\t{body['id']}\tposted\n")
                elif r.status_code == 409:
                    counters["duplicate"] += 1
                    manifest.write(
                        f"{rel_path}\t{body['id']}\tduplicate\n"
                    )
                else:
                    counters["error"] += 1
                    errf.write(
                        f"status-{r.status_code}\t{rel_path}"
                        f"\t{r.text[:200]}\n"
                    )
                if (
                    counters["posted"] + counters["duplicate"]
                ) % 500 == 0:
                    elapsed = time.time() - t0
                    print(
                        f"  ... {counters}, {elapsed:.1f}s",
                        flush=True,
                    )

    dt_s = time.time() - t0
    print(f"[copy] done: {counters} ({dt_s:.1f}s)")
    print(f"[copy] manifest: {manifest_path}")
    print(f"[copy] errors:   {err_path}")
    return 0 if counters["error"] == 0 else 2


def phase_verify(args: argparse.Namespace) -> int:
    vault = Path(args.vault)
    manifest_path = manifest_for(args)
    if not manifest_path.exists():
        print(f"[verify] no manifest at {manifest_path}", file=sys.stderr)
        return 3
    entries = [
        line.rstrip("\n").split("\t")
        for line in manifest_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    entries = [e for e in entries if len(e) >= 2]
    if not entries:
        print("[verify] manifest is empty", file=sys.stderr)
        return 3

    sample_n = max(VERIFY_SAMPLE_MIN, int(len(entries) * VERIFY_SAMPLE_FRACTION))
    sample_n = min(sample_n, len(entries))
    rng = random.Random(0x5701)  # deterministic — same sample on re-run
    sample = rng.sample(entries, sample_n)

    client = httpx.Client(
        base_url=args.ctrl_url,
        headers={"Authorization": f"Bearer {args.api_key}"},
        timeout=args.timeout,
    )

    mismatches: list[tuple[str, str]] = []
    print(
        f"[verify] sampling {sample_n} of {len(entries)} rows", flush=True
    )
    for rel_path, audit_id, *_ in sample:
        src = vault / rel_path
        if not src.exists():
            # file may have been moved already; that's an OK skip
            # during a re-verify but a violation on first verify. Treat
            # it as a violation; the operator can re-run after fixing.
            mismatches.append((rel_path, "source-missing"))
            continue
        expected = build_post_body(rel_path, src, src.parent.name)
        if expected is None:
            mismatches.append((rel_path, "rebuild-failed"))
            continue
        try:
            r = client.get(f"/api/v1/audit/{audit_id}")
        except httpx.HTTPError as e:
            mismatches.append((rel_path, f"http-error:{e!r}"))
            continue
        if r.status_code != 200:
            mismatches.append((rel_path, f"http-{r.status_code}"))
            continue
        got = r.json()
        # Compare canonical-form payload byte-strings. Other fields can
        # drift (ts is stringified, but should match exactly because we
        # POSTed the same value).
        if got["payload"] != expected["payload"]:
            mismatches.append((rel_path, "payload-mismatch"))
            continue
        if got["id"] != expected["id"]:
            mismatches.append((rel_path, "id-mismatch"))
            continue

    if mismatches:
        print(f"[verify] FAIL {len(mismatches)} mismatches:")
        for path, why in mismatches[:20]:
            print(f"  {path}\t{why}")
        return 4
    print(f"[verify] OK {sample_n} / {sample_n} rows matched")
    return 0


def phase_move(args: argparse.Namespace) -> int:
    vault = Path(args.vault)
    manifest_path = manifest_for(args)
    if not manifest_path.exists():
        print(f"[move] no manifest at {manifest_path}", file=sys.stderr)
        return 3
    date_tag = args.date
    dest_root = vault / "_migrated_audit" / date_tag
    dest_root.mkdir(parents=True, exist_ok=True)

    moved = 0
    missing = 0
    collision = 0
    with manifest_path.open("r", encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            rel_path = parts[0]
            src = vault / rel_path
            if not src.exists():
                missing += 1
                continue
            dest = dest_root / rel_path
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                collision += 1
                continue
            shutil.move(str(src), str(dest))
            moved += 1
    print(
        f"[move] done: moved={moved} missing={missing} collision={collision}"
    )
    print(f"[move] dest: {dest_root}")
    return 0


# --------------------------------------------------------------------------
# Plumbing
# --------------------------------------------------------------------------


def manifest_for(args: argparse.Namespace) -> Path:
    Path(args.manifest_dir).mkdir(parents=True, exist_ok=True)
    return (
        Path(args.manifest_dir)
        / f"migrate-audits-{args.tenant}-{args.date}.log"
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tenant", required=True, help="raj313/miguel/rapali/david")
    ap.add_argument(
        "--phase",
        required=True,
        choices=("copy", "verify", "move"),
    )
    ap.add_argument(
        "--vault",
        default=os.environ.get("VAULT_PATH", "/vault"),
    )
    ap.add_argument(
        "--ctrl-url",
        default=os.environ.get("CTRL_API_URL", "http://ctrl-api:3100"),
    )
    ap.add_argument(
        "--api-key",
        default=os.environ.get("AAS_API_KEY"),
        help="ctrl-api Bearer token; defaults to AAS_API_KEY env",
    )
    ap.add_argument(
        "--manifest-dir",
        default=os.environ.get(
            "MIGRATE_MANIFEST_DIR", "/vault/_migrate"
        ),
    )
    ap.add_argument(
        "--date",
        default=dt.date.today().isoformat(),
        help="Date tag for manifest + move destination",
    )
    ap.add_argument(
        "--timeout",
        type=float,
        default=float(os.environ.get("MIGRATE_HTTP_TIMEOUT", "30")),
    )
    args = ap.parse_args(argv)

    if not args.api_key:
        print(
            "error: --api-key or AAS_API_KEY env required",
            file=sys.stderr,
        )
        return 2

    if args.phase == "copy":
        return phase_copy(args)
    if args.phase == "verify":
        return phase_verify(args)
    if args.phase == "move":
        return phase_move(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
