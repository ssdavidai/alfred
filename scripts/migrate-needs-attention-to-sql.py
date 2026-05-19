#!/usr/bin/env python3
"""migrate-needs-attention-to-sql.py — STORE-P6-1f-C bulk migration.

Walks ``/vault/needs_attention/*.md`` and copies each markdown record
into the SQLite ``needs_attention`` table via the ctrl-api endpoint
shipped in STORE-P6-1f Round 1:

  * ``POST /api/v1/needs-attention`` (one row per file)

Mirrors the COPY-VERIFY-MOVE pattern from ``migrate-audits-to-sql.py``
(STORE-P2-3) and ``migrate-trace-to-sql.py`` (STORE-P3-4):
deterministic UUIDv5 ids keep re-runs idempotent (the server returns
409 on duplicates which the script treats as "already migrated"), the
manifest captures every row written, and the MOVE phase only runs
after VERIFY passes byte-for-byte on a 1% sample.

Three-phase invocation, executed serially across tenants
(raj313 → miguel → rapali → david — never in parallel):

  --phase copy    POST every file. Idempotent on re-run.
  --phase verify  Sample 1% of the manifest, fetch each row back, and
                  byte-compare the rebuilt payload against the source.
  --phase move    Only safe after verify passes. Move source files to
                  ``/vault/_migrated_needs_attention/<date>/<original-relpath>``.

Designed to run inside the per-tenant ``compose-alfred-learn-1``
container, which has Python 3.12, httpx, and pyyaml. The ctrl-api is
reachable at ``http://ctrl-api:3100`` on the compose network.

Per-tenant invocation:

  docker exec compose-alfred-learn-1 python3 \\
      /vault/_migrate/migrate-needs-attention-to-sql.py \\
      --tenant raj313 --phase copy
  docker exec compose-alfred-learn-1 python3 \\
      /vault/_migrate/migrate-needs-attention-to-sql.py \\
      --tenant raj313 --phase verify
  docker exec compose-alfred-learn-1 python3 \\
      /vault/_migrate/migrate-needs-attention-to-sql.py \\
      --tenant raj313 --phase move

This script CANNOT be run until the SQL endpoint (Round 1 Agent A) has
shipped to tenants AND alfred-learn (Round 1 Agent B) is
shadow-writing. It runs in Round 1.5 / post-deploy. See issue #478.
"""

from __future__ import annotations

import argparse
import datetime as dt
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

NEEDS_ATTENTION_DIR = "needs_attention"

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n?(.*)$", re.DOTALL)

# UUIDv5 namespace — keeps ids deterministic across re-runs. Distinct
# prefix per record kind so a basename reused across audit / signal /
# observation / pattern_proposal / needs_attention can never collide.
NAMESPACE = uuid.NAMESPACE_DNS
NS_PREFIX = "vault-needs-attention:"

VERIFY_SAMPLE_FRACTION = 0.01  # 1%
VERIFY_SAMPLE_MIN = 5  # but always check at least 5 rows

# Frontmatter fields that describe the resolution (when status !=
# pending). We bundle these into a `resolution` JSON blob so a future
# row reader has a stable shape regardless of which legacy writer
# stamped the markdown.
RESOLUTION_FIELDS = (
    "resolution",
    "resolution_note",
    "resolution_verb",
    "resolution_target",
    "resolution_intent",
    "verb",
    "intent",
    "decision_id",
    "decision_path",
)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Split a vault markdown record into (frontmatter dict, body str)."""
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
    return str(uuid.uuid5(NAMESPACE, f"{NS_PREFIX}{rel_path}"))


def _iso_to_ns(iso: str) -> int:
    if iso.endswith("Z"):
        iso = iso[:-1] + "+00:00"
    d = dt.datetime.fromisoformat(iso)
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return int(d.timestamp() * 1_000_000_000)


def _opt_iso_to_ns(value: Any) -> int | None:
    """Coerce a frontmatter value into unix-ns. Returns None when
    missing/empty/unparseable rather than raising.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        if v >= 1e15:
            return int(v)
        return int(v * 1_000_000_000)
    if isinstance(value, dt.datetime):
        d = value
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return int(d.timestamp() * 1_000_000_000)
    if isinstance(value, dt.date):
        d = dt.datetime(
            value.year, value.month, value.day, tzinfo=dt.timezone.utc
        )
        return int(d.timestamp() * 1_000_000_000)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        try:
            return _iso_to_ns(s)
        except ValueError:
            return None
    return None


def _opt_str(fm: dict[str, Any], *keys: str) -> str | None:
    """Return the first non-empty string value among ``keys``."""
    for k in keys:
        v = fm.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _frontmatter_ts_ns(fm: dict[str, Any], src_path: Path) -> int:
    """Best-effort unix-ns timestamp for a needs_attention record.

    Priority:
      1. frontmatter.created (ISO — canonical, stamped by
         signal_actions.write_needs_attention_record)
      2. frontmatter.origin_at (when the underlying event happened —
         used as fallback so /desk's clock still makes sense)
      3. filename ISO timestamp (yyyy-MM-ddTHH-mm-ssZ-<hash>.md)
      4. file mtime
      5. wall clock now (last-ditch)
    """
    for key in ("created", "origin_at", "ts"):
        raw = fm.get(key)
        ns = _opt_iso_to_ns(raw)
        if ns is not None:
            return ns

    m = re.search(r"(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)", src_path.name)
    if m:
        s = m.group(1)
        iso = f"{s[0:10]}T{s[11:13]}:{s[14:16]}:{s[17:19]}+00:00"
        try:
            return _iso_to_ns(iso)
        except ValueError:
            pass

    try:
        return int(src_path.stat().st_mtime * 1_000_000_000)
    except OSError:
        return int(time.time() * 1_000_000_000)


def _headline_from_body(body: str) -> str | None:
    """First non-empty, non-heading line of the body, trimmed.

    Used as a last-resort fallback when frontmatter omits
    ``display_headline``. Strips leading ``#`` so a heading like
    ``# Foo`` becomes ``Foo``.
    """
    for line in body.splitlines():
        s = line.strip()
        if not s:
            continue
        s = s.lstrip("#").strip()
        if s:
            return s[:200]
    return None


def _collect_resolution(fm: dict[str, Any]) -> dict[str, Any] | None:
    """Bundle any present resolution-related fields into one dict.

    Returns None if no resolution fields are populated — caller skips
    the column in that case (status will still be ``pending`` or the
    pre-resolution state from frontmatter).
    """
    out: dict[str, Any] = {}
    for k in RESOLUTION_FIELDS:
        v = fm.get(k)
        if v is None:
            continue
        if isinstance(v, str) and not v.strip():
            continue
        out[k] = v
    return out or None


# --------------------------------------------------------------------------
# Per-record builder
# --------------------------------------------------------------------------


def build_post_body(
    rel_path: str, src_path: Path
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """Read one source file and produce the POST body.

    Returns ``(post_body, parsed_frontmatter)`` on success, ``None`` if
    the file is unreadable. Caller uses the frontmatter for verify
    re-build.
    """
    try:
        text = src_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None

    fm, body = parse_frontmatter(text)

    source_signal_id = _opt_str(
        fm, "source_signal_path", "signal_path", "source_signal", "source_path"
    )

    # target_matter: prefer the explicit field; fall back to target_path
    # only when it points at a matter (mirrors the live writers in
    # signals.py / signal_actions.py).
    target_matter = _opt_str(fm, "target_matter_path", "target_matter")
    if not target_matter:
        tp = _opt_str(fm, "target_path")
        if tp and tp.startswith("matter/"):
            target_matter = tp

    target_kind = _opt_str(fm, "target_kind")

    headline = _opt_str(fm, "display_headline", "headline")
    if not headline:
        headline = _headline_from_body(body) or "(no headline)"

    status = _opt_str(fm, "status") or "pending"
    resolved_at_ns = _opt_iso_to_ns(fm.get("resolved_at"))
    resolved_by = _opt_str(fm, "resolved_by")
    resolution = _collect_resolution(fm)

    ts_ns = _frontmatter_ts_ns(fm, src_path)

    payload = {
        "_source_rel_path": rel_path,
        "frontmatter": fm,
        "body": body,
    }

    post: dict[str, Any] = {
        "id": deterministic_id(rel_path),
        "ts": str(ts_ns),
        "headline": headline,
        "body": body if body else "(empty)",
        "status": status,
        "payload": json.dumps(payload, sort_keys=True, default=str),
    }
    if source_signal_id is not None:
        post["source_signal_id"] = source_signal_id
    if target_matter is not None:
        post["target_matter"] = target_matter
    if target_kind is not None:
        post["target_kind"] = target_kind
    if resolved_at_ns is not None:
        post["resolved_at"] = str(resolved_at_ns)
    if resolved_by is not None:
        post["resolved_by"] = resolved_by
    if resolution is not None:
        post["resolution"] = json.dumps(
            resolution, sort_keys=True, default=str
        )

    return post, fm


# --------------------------------------------------------------------------
# Phases
# --------------------------------------------------------------------------


def _open_client(args: argparse.Namespace) -> httpx.Client:
    return httpx.Client(
        base_url=args.ctrl_url,
        headers={"Authorization": f"Bearer {args.api_key}"},
        timeout=args.timeout,
    )


def phase_copy(args: argparse.Namespace) -> int:
    vault = Path(args.vault)
    manifest_path = manifest_for(args)
    err_path = manifest_path.with_suffix(".err.log")

    client = _open_client(args)
    counters = {
        "posted": 0,
        "duplicate": 0,
        "error": 0,
        "unreadable": 0,
    }
    t0 = time.time()

    src_root = vault / NEEDS_ATTENTION_DIR
    files = sorted(src_root.rglob("*.md")) if src_root.is_dir() else []
    print(
        f"[copy] {NEEDS_ATTENTION_DIR}: {len(files)} files", flush=True
    )

    with manifest_path.open("a", encoding="utf-8") as manifest, err_path.open(
        "a", encoding="utf-8"
    ) as errf:
        for src in files:
            rel_path = str(src.relative_to(vault))
            built = build_post_body(rel_path, src)
            if built is None:
                counters["unreadable"] += 1
                errf.write(f"unreadable\t{rel_path}\n")
                continue
            body, _fm = built
            try:
                r = client.post("/api/v1/needs-attention", json=body)
            except httpx.HTTPError as e:
                counters["error"] += 1
                errf.write(f"http-error\t{rel_path}\t{e!r}\n")
                continue
            if r.status_code == 201:
                counters["posted"] += 1
                manifest.write(f"{rel_path}\t{body['id']}\tposted\n")
            elif r.status_code == 409:
                counters["duplicate"] += 1
                manifest.write(f"{rel_path}\t{body['id']}\tduplicate\n")
            else:
                counters["error"] += 1
                errf.write(
                    f"status-{r.status_code}\t{rel_path}"
                    f"\t{r.text[:200]}\n"
                )
            total = counters["posted"] + counters["duplicate"]
            if total and total % 250 == 0:
                elapsed = time.time() - t0
                print(f"  ... {counters}, {elapsed:.1f}s", flush=True)

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

    entries: list[tuple[str, str]] = []
    for line in manifest_path.read_text(encoding="utf-8").splitlines():
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 2:
            continue
        entries.append((parts[0], parts[1]))

    if not entries:
        print("[verify] manifest is empty", file=sys.stderr)
        return 3

    sample_n = max(
        VERIFY_SAMPLE_MIN, int(len(entries) * VERIFY_SAMPLE_FRACTION)
    )
    sample_n = min(sample_n, len(entries))
    rng = random.Random(0x5707)  # deterministic — same sample on re-run
    sample = rng.sample(entries, sample_n)

    client = _open_client(args)
    mismatches: list[tuple[str, str]] = []
    print(
        f"[verify] sampling {sample_n} of {len(entries)} rows", flush=True
    )

    for rel_path, row_id in sample:
        src = vault / rel_path
        if not src.exists():
            mismatches.append((rel_path, "source-missing"))
            continue
        built = build_post_body(rel_path, src)
        if built is None:
            mismatches.append((rel_path, "rebuild-failed"))
            continue
        expected, _fm = built
        try:
            r = client.get(f"/api/v1/needs-attention/{row_id}")
        except httpx.HTTPError as e:
            mismatches.append((rel_path, f"http-error:{e!r}"))
            continue
        if r.status_code != 200:
            mismatches.append((rel_path, f"http-{r.status_code}"))
            continue
        got = r.json()
        if got.get("id") != expected["id"]:
            mismatches.append((rel_path, "id-mismatch"))
            continue
        if got.get("payload") != expected["payload"]:
            mismatches.append((rel_path, "payload-mismatch"))
            continue
        if got.get("body") != expected["body"]:
            mismatches.append((rel_path, "body-mismatch"))
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
    dest_root = vault / "_migrated_needs_attention" / date_tag
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
        / f"migrate-needs-attention-{args.tenant}-{args.date}.log"
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--tenant", required=True, help="raj313/miguel/rapali/david"
    )
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
        default=os.environ.get(
            "CTRL_API_URL",
            os.environ.get("ALFRED_CTRL_URL", "http://ctrl-api:3100"),
        ),
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
