#!/usr/bin/env python3
"""migrate-stream-events-to-jsonl.py — STORE-P4-1 bulk migration.

Walks /vault/stream_event/*.md (the legacy per-event markdown files;
~7k on david at steady state, the heaviest hot-path source) and folds
them into date-partitioned JSONL at /vault/_raw/YYYY-MM-DD.jsonl, one
event per line.

Three-phase COPY-VERIFY-MOVE design (mirrors migrate-audits-to-sql.py
from STORE-P2-3):

  --phase copy    Read each .md, parse frontmatter + payload, append a
                  StreamLogEntry line to /vault/_raw/<date>.jsonl. Tracks
                  written ids in a manifest so a re-run is idempotent.
  --phase verify  Sample 1% of the manifest, re-read the source file,
                  rebuild the entry, byte-compare against the JSONL line.
                  Exits non-zero on any mismatch.
  --phase move    Only safe after verify passes. Move source files to
                  /vault/_migrated_stream/<date>/<filename> so the op is
                  fully reversible by an mv back.

Designed to run inside the per-tenant compose-alfred-learn-1 container.
The vault is bind-mounted at /vault. Pure-Python (json + pyyaml +
pathlib); no network calls — the JSONL append happens locally because
ctrl-api's POST /streams/events would double the I/O and break the
idempotency property (server adds a different id when one isn't
provided).

Per-tenant invocation (raj313 first → miguel → rapali → david):

  docker exec compose-alfred-learn-1 python3 /vault/_migrate/migrate-stream-events-to-jsonl.py \\
      --tenant raj313 --phase copy
  docker exec compose-alfred-learn-1 python3 /vault/_migrate/migrate-stream-events-to-jsonl.py \\
      --tenant raj313 --phase verify
  docker exec compose-alfred-learn-1 python3 /vault/_migrate/migrate-stream-events-to-jsonl.py \\
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
from pathlib import Path
from typing import Any

import yaml

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

# stream_event filenames typically look like:
#   webhook-<token12>-2026-05-18T14-37-22-501Z-<uuid8>.md
#   gmail-<msgid>.md
#   omi-<ts>.md
# We parse the date out of the frontmatter `received_at` first, then fall
# back to a YYYY-MM-DD regex match on the filename, and finally to the
# file mtime.
ISO_DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")
FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n?(.*)$", re.DOTALL)

VERIFY_SAMPLE_FRACTION = 0.01
VERIFY_SAMPLE_MIN = 5


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
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


def _iso_to_date(iso: str) -> str | None:
    """Extract a YYYY-MM-DD date from an ISO-8601 string."""
    try:
        if iso.endswith("Z"):
            iso = iso[:-1] + "+00:00"
        d = dt.datetime.fromisoformat(iso)
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return d.astimezone(dt.timezone.utc).date().isoformat()
    except (ValueError, TypeError):
        return None


def _iso_to_ns(iso: str) -> int | None:
    try:
        if iso.endswith("Z"):
            iso = iso[:-1] + "+00:00"
        d = dt.datetime.fromisoformat(iso)
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return int(d.timestamp() * 1_000_000_000)
    except (ValueError, TypeError):
        return None


def derive_date(fm: dict[str, Any], src: Path) -> str:
    """Best-effort partition date: frontmatter.received_at → filename →
    file mtime, in that order. Always returns a valid YYYY-MM-DD."""
    raw = fm.get("received_at") or fm.get("created") or fm.get("timestamp")
    if isinstance(raw, str):
        d = _iso_to_date(raw)
        if d:
            return d
    elif isinstance(raw, dt.datetime):
        return raw.astimezone(dt.timezone.utc).date().isoformat()
    elif isinstance(raw, dt.date):
        return raw.isoformat()
    m = ISO_DATE_RE.search(src.name)
    if m:
        return m.group(1)
    try:
        mtime = src.stat().st_mtime
        return dt.datetime.fromtimestamp(mtime, dt.timezone.utc).date().isoformat()
    except OSError:
        return dt.date.today().isoformat()


def derive_ts_ns(fm: dict[str, Any], src: Path) -> int:
    raw = fm.get("received_at") or fm.get("created") or fm.get("timestamp")
    if isinstance(raw, str):
        ns = _iso_to_ns(raw)
        if ns:
            return ns
    elif isinstance(raw, dt.datetime):
        return int(raw.timestamp() * 1_000_000_000)
    try:
        return int(src.stat().st_mtime * 1_000_000_000)
    except OSError:
        return int(time.time() * 1_000_000_000)


def derive_event_id(fm: dict[str, Any], src: Path) -> str:
    """Stable id for idempotency. Use frontmatter source_ref / source_id /
    id, otherwise hash the filename (post-extension)."""
    for key in ("source_ref", "source_id", "id", "event_id"):
        v = fm.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    stem = src.stem
    return f"migrated:{stem}"


def build_entry(src: Path, fm: dict[str, Any], body: str) -> dict[str, Any]:
    """Construct a StreamLogEntry dict from a stream_event markdown record."""
    received_at = fm.get("received_at")
    if isinstance(received_at, dt.datetime):
        received_at = received_at.astimezone(dt.timezone.utc).isoformat()
    if not isinstance(received_at, str):
        received_at = (
            dt.datetime.fromtimestamp(src.stat().st_mtime, dt.timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )

    source_type = fm.get("source_type") or "migrated:stream_event"
    if not isinstance(source_type, str):
        source_type = "migrated:stream_event"

    eid = derive_event_id(fm, src)
    payload: dict[str, Any] = {
        "_migrated_from": str(src.name),
        "frontmatter": _yaml_safe(fm),
        "body": body,
    }
    return {
        "id": eid,
        "ts_ns": str(derive_ts_ns(fm, src)),
        "source_type": source_type,
        "source_id": eid,
        "received_at": received_at,
        "payload": payload,
    }


def _yaml_safe(value: Any) -> Any:
    """Recursively replace datetime/date with iso strings for json.dumps."""
    if isinstance(value, dict):
        return {k: _yaml_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_yaml_safe(v) for v in value]
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    return value


# --------------------------------------------------------------------------
# Phases
# --------------------------------------------------------------------------


def phase_copy(args: argparse.Namespace) -> int:
    vault = Path(args.vault)
    src_dir = vault / "stream_event"
    raw_dir = vault / "_raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = manifest_for(args)
    err_path = manifest_path.with_suffix(".err.log")

    if not src_dir.is_dir():
        print(f"[copy] no source dir at {src_dir}; nothing to do")
        return 0

    files = sorted(src_dir.glob("*.md"))
    print(f"[copy] {len(files)} files in {src_dir}", flush=True)

    # Load any prior manifest so a re-run is idempotent on the rel_path key.
    prior: set[str] = set()
    if manifest_path.exists():
        with manifest_path.open("r", encoding="utf-8") as f:
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if parts:
                    prior.add(parts[0])

    counters = {"written": 0, "skipped_prior": 0, "skipped_bad": 0, "errors": 0}
    by_date: dict[str, int] = {}
    t0 = time.time()

    # We append in batches keyed by date to amortise open()s.
    file_handles: dict[str, Any] = {}
    try:
        with manifest_path.open("a", encoding="utf-8") as manifest, err_path.open(
            "a", encoding="utf-8"
        ) as errf:
            for src in files:
                rel = src.name
                if rel in prior:
                    counters["skipped_prior"] += 1
                    continue
                try:
                    text = src.read_text(encoding="utf-8", errors="replace")
                except OSError as e:
                    counters["errors"] += 1
                    errf.write(f"unreadable\t{rel}\t{e!r}\n")
                    continue
                fm, body = parse_frontmatter(text)
                try:
                    entry = build_entry(src, fm, body)
                except (TypeError, ValueError) as e:
                    counters["skipped_bad"] += 1
                    errf.write(f"build-failed\t{rel}\t{e!r}\n")
                    continue
                date = derive_date(fm, src)
                target = raw_dir / f"{date}.jsonl"
                fh = file_handles.get(date)
                if fh is None:
                    fh = target.open("a", encoding="utf-8")
                    file_handles[date] = fh
                try:
                    fh.write(json.dumps(entry, sort_keys=True, default=str) + "\n")
                except (OSError, TypeError) as e:
                    counters["errors"] += 1
                    errf.write(f"write-failed\t{rel}\t{e!r}\n")
                    continue
                counters["written"] += 1
                by_date[date] = by_date.get(date, 0) + 1
                manifest.write(f"{rel}\t{entry['id']}\t{date}\twritten\n")
                if counters["written"] % 500 == 0:
                    elapsed = time.time() - t0
                    print(f"  ... {counters} ({elapsed:.1f}s)", flush=True)
    finally:
        for fh in file_handles.values():
            try:
                fh.close()
            except OSError:
                pass

    dt_s = time.time() - t0
    print(f"[copy] done: {counters} ({dt_s:.1f}s)")
    print(f"[copy] by date:")
    for date in sorted(by_date):
        print(f"  {date}\t{by_date[date]}")
    print(f"[copy] manifest: {manifest_path}")
    print(f"[copy] errors:   {err_path}")
    return 0 if counters["errors"] == 0 else 2


def phase_verify(args: argparse.Namespace) -> int:
    vault = Path(args.vault)
    raw_dir = vault / "_raw"
    manifest_path = manifest_for(args)
    if not manifest_path.exists():
        print(f"[verify] no manifest at {manifest_path}", file=sys.stderr)
        return 3
    entries = [
        line.rstrip("\n").split("\t")
        for line in manifest_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    entries = [e for e in entries if len(e) >= 3]
    if not entries:
        print("[verify] manifest is empty", file=sys.stderr)
        return 3

    sample_n = max(VERIFY_SAMPLE_MIN, int(len(entries) * VERIFY_SAMPLE_FRACTION))
    sample_n = min(sample_n, len(entries))
    rng = random.Random(0x5704)
    sample = rng.sample(entries, sample_n)

    # Build an in-memory index of (date → set of ids) by reading each
    # touched partition once. Mismatches are reported by rel + reason.
    touched_dates: set[str] = {row[2] for row in sample}
    date_to_ids: dict[str, set[str]] = {}
    for date in touched_dates:
        ids: set[str] = set()
        path = raw_dir / f"{date}.jsonl"
        try:
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ids.add(json.loads(line)["id"])
                    except (json.JSONDecodeError, KeyError):
                        pass
        except OSError:
            pass
        date_to_ids[date] = ids

    mismatches: list[tuple[str, str]] = []
    for rel, eid, date, *_ in sample:
        if eid not in date_to_ids.get(date, set()):
            mismatches.append((rel, f"missing-in-{date}.jsonl"))
            continue
        src = vault / "stream_event" / rel
        if not src.exists():
            # source removed (presumably by an earlier --phase move). OK
            # at re-verify time.
            continue
        text = src.read_text(encoding="utf-8", errors="replace")
        fm, body = parse_frontmatter(text)
        expected = build_entry(src, fm, body)
        if expected["id"] != eid:
            mismatches.append((rel, "id-mismatch"))

    if mismatches:
        print(f"[verify] FAIL {len(mismatches)} mismatches:")
        for path, why in mismatches[:20]:
            print(f"  {path}\t{why}")
        return 4
    print(f"[verify] OK {sample_n} / {sample_n} rows matched")
    return 0


def phase_move(args: argparse.Namespace) -> int:
    vault = Path(args.vault)
    src_dir = vault / "stream_event"
    manifest_path = manifest_for(args)
    if not manifest_path.exists():
        print(f"[move] no manifest at {manifest_path}", file=sys.stderr)
        return 3
    date_tag = args.date
    dest_root = vault / "_migrated_stream" / date_tag
    dest_root.mkdir(parents=True, exist_ok=True)

    moved = 0
    missing = 0
    collision = 0
    with manifest_path.open("r", encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 1:
                continue
            rel = parts[0]
            src = src_dir / rel
            if not src.exists():
                missing += 1
                continue
            # Group destination files by event date for human navigation.
            event_date = parts[2] if len(parts) >= 3 else date_tag
            dest_dir = dest_root / event_date
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / rel
            if dest.exists():
                collision += 1
                continue
            shutil.move(str(src), str(dest))
            moved += 1
    print(f"[move] done: moved={moved} missing={missing} collision={collision}")
    print(f"[move] dest: {dest_root}")
    return 0


# --------------------------------------------------------------------------
# Plumbing
# --------------------------------------------------------------------------


def manifest_for(args: argparse.Namespace) -> Path:
    Path(args.manifest_dir).mkdir(parents=True, exist_ok=True)
    return (
        Path(args.manifest_dir)
        / f"migrate-stream-events-{args.tenant}-{args.date}.log"
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
    args = ap.parse_args(argv)

    if args.phase == "copy":
        return phase_copy(args)
    if args.phase == "verify":
        return phase_verify(args)
    if args.phase == "move":
        return phase_move(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
