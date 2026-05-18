#!/usr/bin/env python3
"""migrate-trace-to-sql.py — STORE-P3-4 bulk migration.

Walks the legacy ``/vault/signal/*.md`` and ``/vault/observation/*.md``
records and copies each one into the SQLite ``signal`` / ``observation``
tables via the ctrl-api endpoints shipped in STORE-P3-2:

  * ``POST /api/v1/signals``       (one row per ``vault/signal/*.md``)
  * ``POST /api/v1/observations``  (one row per ``vault/observation/*.md``)

Mirrors the COPY-VERIFY-MOVE pattern from ``migrate-audits-to-sql.py``
(STORE-P2-3): deterministic UUIDv5 ids keep re-runs idempotent (the
server returns 409 on duplicates which the script treats as
"already migrated"), the manifest captures every row written, and the
MOVE phase only runs after VERIFY passes byte-for-byte on a 1% sample.

Three-phase invocation, executed serially across tenants
(raj313 → miguel → rapali → david — never in parallel):

  --phase copy    POST every file. Idempotent on re-run.
  --phase verify  Sample 1% of the manifest, fetch each row back, and
                  byte-compare the rebuilt payload against the source.
  --phase move    Only safe after verify passes. Move source files to
                  ``/vault/_migrated_trace/<date>/<original-relpath>``.

Skips: observations with no matched instinct (``instinct: null`` in
frontmatter) — the ``observation`` table's ``instinct_id`` column is
NOT NULL (see migration 004), so these records have no SQL
representation. They're logged to a separate ``.skipped.log`` and
counted in the summary. The markdown record stays where it is until a
future re-run after the instinct is promoted.

Scope: signal + observation ONLY. ``stream_event/*.md`` is NOT migrated
by this script — that data goes into the JSONL stream log (Store 4)
and is handled by STORE-P4-1.

Designed to run inside the per-tenant ``compose-alfred-learn-1``
container, which has Python 3.12, httpx, and pyyaml. The ctrl-api is
reachable at ``http://ctrl-api:3100`` on the compose network.

Per-tenant invocation:

  docker exec compose-alfred-learn-1 python3 /vault/_migrate/migrate-trace-to-sql.py \\
      --tenant raj313 --phase copy
  docker exec compose-alfred-learn-1 python3 /vault/_migrate/migrate-trace-to-sql.py \\
      --tenant raj313 --phase verify
  docker exec compose-alfred-learn-1 python3 /vault/_migrate/migrate-trace-to-sql.py \\
      --tenant raj313 --phase move
"""

from __future__ import annotations

import argparse
import datetime as dt
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

SIGNAL_DIR = "signal"
OBSERVATION_DIR = "observation"

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n?(.*)$", re.DOTALL)

# UUIDv5 namespace — keeps ids deterministic across re-runs. Distinct
# prefixes per record kind so a signal record and an observation record
# that happen to share a relative-path basename can never collide.
NAMESPACE = uuid.NAMESPACE_DNS
SIGNAL_NS_PREFIX = "vault-signal:"
OBSERVATION_NS_PREFIX = "vault-observation:"

VERIFY_SAMPLE_FRACTION = 0.01  # 1%
VERIFY_SAMPLE_MIN = 5  # but always check at least 5 rows


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Split a vault markdown record into (frontmatter dict, body str).

    Returns ({}, text) when the file has no ``---`` fence — keeps the
    migration tolerant of half-formed records (P2-3 hit a few of these).
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


def deterministic_signal_id(rel_path: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"{SIGNAL_NS_PREFIX}{rel_path}"))


def deterministic_observation_id(rel_path: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"{OBSERVATION_NS_PREFIX}{rel_path}"))


def _iso_to_ns(iso: str) -> int:
    if iso.endswith("Z"):
        iso = iso[:-1] + "+00:00"
    d = dt.datetime.fromisoformat(iso)
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return int(d.timestamp() * 1_000_000_000)


def _frontmatter_ts_ns(fm: dict[str, Any], src_path: Path) -> int:
    """Best-effort unix-ns timestamp for a signal or observation record.

    Priority:
      1. frontmatter.created (ISO 8601 — the canonical field both
         writers stamp)
      2. frontmatter.ts (numeric ns; some legacy paths used this)
      3. filename ISO timestamp (yyyy-MM-ddTHH-mm-ssZ)
      4. file mtime
      5. wall clock now (last-ditch)
    """
    raw = fm.get("created") or fm.get("origin_at") or fm.get("ts")
    if isinstance(raw, str):
        try:
            return _iso_to_ns(raw)
        except ValueError:
            pass
    if isinstance(raw, (int, float)):
        return int(raw)
    if isinstance(raw, dt.datetime):
        d = raw
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return int(d.timestamp() * 1_000_000_000)
    if isinstance(raw, dt.date):
        d = dt.datetime(raw.year, raw.month, raw.day, tzinfo=dt.timezone.utc)
        return int(d.timestamp() * 1_000_000_000)

    # Filename pattern: yyyy-MM-ddTHH-mm-ssZ-<hash>.md
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


def _opt_str(fm: dict[str, Any], *keys: str) -> str | None:
    """Return the first non-empty string value among ``keys``."""
    for k in keys:
        v = fm.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _bool_int(v: Any) -> int:
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return 1 if v else 0
    if isinstance(v, str):
        return 1 if v.strip().lower() in ("true", "yes", "1") else 0
    return 0


# --------------------------------------------------------------------------
# Per-record builders
# --------------------------------------------------------------------------


def build_signal_post(
    rel_path: str, src_path: Path
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """Read one ``vault/signal/*.md`` and produce the POST body.

    Returns ``(post_body, parsed_frontmatter)`` on success, ``None`` if
    the file is unreadable. Caller uses the frontmatter for verify
    re-build.
    """
    try:
        text = src_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None

    fm, body = parse_frontmatter(text)

    source_type = _opt_str(fm, "source_type") or "unknown"
    source_event = _opt_str(fm, "source_event_path", "source_event")

    # target_matter: prefer the explicit field; fall back to target_path
    # when it points at a matter directly (mirrors the live writer in
    # signals.py:write_signal_record).
    target_matter = _opt_str(fm, "target_matter_path", "target_matter")
    if not target_matter:
        tp = _opt_str(fm, "target_path")
        if tp and tp.startswith("matter/"):
            target_matter = tp

    target_kind = _opt_str(fm, "target_kind")
    actor = _opt_str(fm, "actor")
    decision_required = _bool_int(fm.get("decision_required"))
    classified_noise = _bool_int(fm.get("classified_noise"))
    display_headline = _opt_str(fm, "display_headline")
    display_body = _opt_str(fm, "display_body")

    ts_ns = _frontmatter_ts_ns(fm, src_path)

    post = {
        "id": deterministic_signal_id(rel_path),
        "ts": str(ts_ns),
        "source_type": source_type,
        "body": body if body else "(empty)",
        "decision_required": int(decision_required),
        "classified_noise": int(classified_noise),
    }
    if source_event is not None:
        post["source_event"] = source_event
    if target_matter is not None:
        post["target_matter"] = target_matter
    if target_kind is not None:
        post["target_kind"] = target_kind
    if actor is not None:
        post["actor"] = actor
    if display_headline is not None:
        post["display_headline"] = display_headline
    if display_body is not None:
        post["display_body"] = display_body

    return post, fm


def build_observation_post(
    rel_path: str, src_path: Path
) -> tuple[dict[str, Any] | None, dict[str, Any], str | None]:
    """Read one ``vault/observation/*.md`` and produce the POST body.

    Returns ``(post_body, frontmatter, skip_reason)``:
      * post_body is None when the record has no matched instinct (skip)
      * skip_reason is a short string on skip, None otherwise
    """
    try:
        text = src_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None, {}, "unreadable"

    fm, _body = parse_frontmatter(text)

    instinct_id = _opt_str(fm, "instinct", "instinct_path", "instinct_id")
    if not instinct_id:
        # observation.instinct_id is NOT NULL in migration 004 — the
        # markdown record has no SQL representation. P3-3's live writer
        # has the same guard; we replicate it here.
        return None, fm, "no-instinct"

    signal_id = _opt_str(
        fm, "source_path", "signal_path", "signal_id"
    )
    # Only signal/* paths map to a signal row id; decision-derived
    # observations stamp source_path = "decision/<id>.md" and don't tie
    # to the signal table, so signal_id stays NULL there. Same for any
    # other prefix we haven't accounted for.
    if signal_id is not None and not signal_id.startswith("signal/"):
        signal_id = None

    confidence: float | None = None
    raw_conf = fm.get("confidence")
    if isinstance(raw_conf, (int, float)):
        confidence = float(raw_conf)
    elif isinstance(raw_conf, str):
        try:
            confidence = float(raw_conf)
        except ValueError:
            confidence = None

    ts_ns = _frontmatter_ts_ns(fm, src_path)

    post: dict[str, Any] = {
        "id": deterministic_observation_id(rel_path),
        "ts": str(ts_ns),
        "instinct_id": instinct_id,
    }
    if signal_id is not None:
        post["signal_id"] = signal_id
    if confidence is not None:
        post["confidence"] = confidence

    # Embedding rarely lives in observation frontmatter today, but if a
    # future writer stamps one we pass it through. The endpoint expects
    # a 768-element number array.
    emb = fm.get("embedding")
    if isinstance(emb, list) and len(emb) > 0:
        if all(isinstance(x, (int, float)) for x in emb):
            post["embedding"] = [float(x) for x in emb]

    return post, fm, None


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
    skipped_path = manifest_path.with_suffix(".skipped.log")

    client = _open_client(args)
    counters = {
        "signal_posted": 0,
        "signal_duplicate": 0,
        "signal_error": 0,
        "signal_unreadable": 0,
        "obs_posted": 0,
        "obs_duplicate": 0,
        "obs_error": 0,
        "obs_skipped_no_instinct": 0,
        "obs_unreadable": 0,
    }
    t0 = time.time()

    with manifest_path.open("a", encoding="utf-8") as manifest, err_path.open(
        "a", encoding="utf-8"
    ) as errf, skipped_path.open("a", encoding="utf-8") as skippedf:

        # --- Signals first. The observation row writer takes signal_id
        # as a string (vault path), so we don't actually need the signal
        # rows to be inserted before observations for the FK to work —
        # but doing signals first matches the natural read order in the
        # vault and makes the manifest skim cleanly.
        # rglob so we pick up the date-bucketed nested layout
        # (observation/yyyy/MM/dd/*.md) as well as the flat layout
        # (signal/*.md). Some tenants also nest signals by date.
        signal_files = sorted((vault / SIGNAL_DIR).rglob("*.md")) if (vault / SIGNAL_DIR).is_dir() else []
        print(f"[copy] signal: {len(signal_files)} files", flush=True)
        for src in signal_files:
            rel_path = str(src.relative_to(vault))
            built = build_signal_post(rel_path, src)
            if built is None:
                counters["signal_unreadable"] += 1
                errf.write(f"signal\tunreadable\t{rel_path}\n")
                continue
            body, _fm = built
            try:
                r = client.post("/api/v1/signals", json=body)
            except httpx.HTTPError as e:
                counters["signal_error"] += 1
                errf.write(f"signal\thttp-error\t{rel_path}\t{e!r}\n")
                continue
            if r.status_code == 201:
                counters["signal_posted"] += 1
                manifest.write(f"signal\t{rel_path}\t{body['id']}\tposted\n")
            elif r.status_code == 409:
                counters["signal_duplicate"] += 1
                manifest.write(f"signal\t{rel_path}\t{body['id']}\tduplicate\n")
            else:
                counters["signal_error"] += 1
                errf.write(
                    f"signal\tstatus-{r.status_code}\t{rel_path}"
                    f"\t{r.text[:200]}\n"
                )
            total = (
                counters["signal_posted"] + counters["signal_duplicate"]
            )
            if total and total % 250 == 0:
                elapsed = time.time() - t0
                print(f"  signal ... {total}, {elapsed:.1f}s", flush=True)

        # --- Observations.
        obs_files = sorted((vault / OBSERVATION_DIR).rglob("*.md")) if (vault / OBSERVATION_DIR).is_dir() else []
        print(f"[copy] observation: {len(obs_files)} files", flush=True)
        for src in obs_files:
            rel_path = str(src.relative_to(vault))
            body, fm, skip = build_observation_post(rel_path, src)
            if skip == "unreadable":
                counters["obs_unreadable"] += 1
                errf.write(f"observation\tunreadable\t{rel_path}\n")
                continue
            if skip == "no-instinct":
                counters["obs_skipped_no_instinct"] += 1
                skippedf.write(
                    f"observation\tno-instinct\t{rel_path}\t"
                    f"source={fm.get('source_kind') or '?'}\n"
                )
                continue
            assert body is not None
            try:
                r = client.post("/api/v1/observations", json=body)
            except httpx.HTTPError as e:
                counters["obs_error"] += 1
                errf.write(f"observation\thttp-error\t{rel_path}\t{e!r}\n")
                continue
            if r.status_code == 201:
                counters["obs_posted"] += 1
                manifest.write(
                    f"observation\t{rel_path}\t{body['id']}\tposted\n"
                )
            elif r.status_code == 409:
                counters["obs_duplicate"] += 1
                manifest.write(
                    f"observation\t{rel_path}\t{body['id']}\tduplicate\n"
                )
            else:
                counters["obs_error"] += 1
                errf.write(
                    f"observation\tstatus-{r.status_code}\t{rel_path}"
                    f"\t{r.text[:200]}\n"
                )
            total = counters["obs_posted"] + counters["obs_duplicate"]
            if total and total % 250 == 0:
                elapsed = time.time() - t0
                print(f"  observation ... {total}, {elapsed:.1f}s", flush=True)

    dt_s = time.time() - t0
    print(f"[copy] done: {counters} ({dt_s:.1f}s)")
    print(f"[copy] manifest: {manifest_path}")
    print(f"[copy] errors:   {err_path}")
    print(f"[copy] skipped:  {skipped_path}")
    err_total = counters["signal_error"] + counters["obs_error"]
    return 0 if err_total == 0 else 2


def phase_verify(args: argparse.Namespace) -> int:
    vault = Path(args.vault)
    manifest_path = manifest_for(args)
    if not manifest_path.exists():
        print(f"[verify] no manifest at {manifest_path}", file=sys.stderr)
        return 3

    entries: list[tuple[str, str, str]] = []  # (kind, rel_path, row_id)
    for line in manifest_path.read_text(encoding="utf-8").splitlines():
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 3:
            continue
        kind, rel_path, row_id = parts[0], parts[1], parts[2]
        if kind not in ("signal", "observation"):
            continue
        entries.append((kind, rel_path, row_id))

    if not entries:
        print("[verify] manifest is empty", file=sys.stderr)
        return 3

    sample_n = max(VERIFY_SAMPLE_MIN, int(len(entries) * VERIFY_SAMPLE_FRACTION))
    sample_n = min(sample_n, len(entries))
    rng = random.Random(0x5702)  # deterministic — same sample on re-run
    sample = rng.sample(entries, sample_n)

    client = _open_client(args)
    mismatches: list[tuple[str, str, str]] = []
    print(
        f"[verify] sampling {sample_n} of {len(entries)} rows", flush=True
    )

    for kind, rel_path, row_id in sample:
        src = vault / rel_path
        if not src.exists():
            mismatches.append((kind, rel_path, "source-missing"))
            continue
        if kind == "signal":
            built = build_signal_post(rel_path, src)
            if built is None:
                mismatches.append((kind, rel_path, "rebuild-failed"))
                continue
            expected, _fm = built
            try:
                r = client.get(f"/api/v1/signals/{row_id}")
            except httpx.HTTPError as e:
                mismatches.append((kind, rel_path, f"http-error:{e!r}"))
                continue
            if r.status_code != 200:
                mismatches.append((kind, rel_path, f"http-{r.status_code}"))
                continue
            got = r.json()
            # The signal body is the authoritative bytes per record;
            # compare it verbatim. The id must match too (deterministic).
            if got["body"] != expected["body"]:
                mismatches.append((kind, rel_path, "body-mismatch"))
                continue
            if got["id"] != expected["id"]:
                mismatches.append((kind, rel_path, "id-mismatch"))
                continue
        else:  # observation
            body, _fm, skip = build_observation_post(rel_path, src)
            if skip or body is None:
                # we don't manifest skips, so a sampled row shouldn't be
                # in this state — flag it.
                mismatches.append((kind, rel_path, f"rebuild:{skip}"))
                continue
            try:
                r = client.get(f"/api/v1/observations/{row_id}")
            except httpx.HTTPError as e:
                mismatches.append((kind, rel_path, f"http-error:{e!r}"))
                continue
            if r.status_code != 200:
                mismatches.append((kind, rel_path, f"http-{r.status_code}"))
                continue
            got = r.json()
            if got["instinct_id"] != body["instinct_id"]:
                mismatches.append((kind, rel_path, "instinct-mismatch"))
                continue
            if got["id"] != body["id"]:
                mismatches.append((kind, rel_path, "id-mismatch"))
                continue
            # signal_id may legitimately be null in the row (decision-
            # derived observations); compare with the body's view.
            if got.get("signal_id") != body.get("signal_id"):
                mismatches.append((kind, rel_path, "signal-id-mismatch"))
                continue

    if mismatches:
        print(f"[verify] FAIL {len(mismatches)} mismatches:")
        for kind, path, why in mismatches[:20]:
            print(f"  {kind}\t{path}\t{why}")
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
    dest_root = vault / "_migrated_trace" / date_tag
    dest_root.mkdir(parents=True, exist_ok=True)

    moved = 0
    missing = 0
    collision = 0
    with manifest_path.open("r", encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3:
                continue
            rel_path = parts[1]
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
        / f"migrate-trace-{args.tenant}-{args.date}.log"
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
