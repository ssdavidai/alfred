"""One-shot migration: add Steward frontmatter fields to every matter + task.

For every ``matter/*.md`` and ``task/*.md`` in the vault, add the
Steward Phase 0 schema fields if they're absent. Idempotent and
resumable — re-running after a partial run skips already-migrated
records and resumes from a checkpoint.

USAGE
-----

Runs inside the alfred-learn container::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.migrate_steward_schema [--dry-run]

Flags::

    --dry-run                 Don't write anything; print what would happen.
    --batch-size 100          Records per progress log line (default 100).
    --reset-checkpoint        Ignore + delete any prior checkpoint.

Schema added (matter and task)::

    state:                  open | snoozed | done | archived
    surface_class:          high | normal | none
    last_steward_check_at:  null   (ISO timestamp once Steward starts ticking)
    last_steward_outcome:   null   (dict once Phase 1 starts deciding)
    next_check_after:       <now>  (so the first sweep picks up every record)
    signal_sources:         []
    pending_confirmation:   false  (set true between a Steward decision and
                                    human ack when confidence < 0.6)
    blocked_on:             null   (ref to another task/matter)
    staleness_score:        0      (0..1, computed; default 0 for fresh records)

Tasks additionally get::

    parent_matter:          null   (filled in by migrate_inbox_matter.py)

Migration of legacy ``status`` → ``state`` for tasks::

    status: completed       →  state: done
    status: cancelled       →  state: archived
    status: archived        →  state: archived
    everything else         →  state: open

For matters::

    status: resolved        →  state: done
    status: abandoned       →  state: archived
    everything else         →  state: open
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from src.config import load_config

logger = logging.getLogger("migrate-steward-schema")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Steward fields that get written via ctrl-api PATCH set when absent.
# Restricted to SCALAR fields — the underlying ``alfred vault edit
# --set k=v`` CLI parses values as plain strings, so attempting to
# write empty lists / dicts via this path produces the literal string
# ``"[]"`` / ``"{}"`` rather than the YAML structure we want.
#
# List- and dict-shaped Steward fields (``signal_sources``,
# ``last_steward_outcome``) are intentionally LEFT ABSENT by this
# migration. The Steward activity treats absent fields as empty/null
# and Phase 1 populates them with real values on the first
# evaluation that produces structured output. The
# ``matter/inbox.md`` record uses the raw-content create path
# (``migrate_inbox_matter.py``) which DOES write the YAML literal
# ``signal_sources: []`` — that's the only place we seed the
# concrete empty-list shape, and it's safe because the create-path
# embeds raw YAML rather than passing through the CLI parser.
STEWARD_FIELD_DEFAULTS_COMMON: dict[str, Any] = {
    "surface_class": "normal",
    "last_steward_check_at": None,
    "pending_confirmation": False,
    "blocked_on": None,
    "staleness_score": 0,
}

# Task-only fields. ``parent_matter`` is fixed up by
# ``migrate_inbox_matter.py`` afterwards; we still seed it as null
# here so the field exists in every task's frontmatter from day one.
STEWARD_FIELD_DEFAULTS_TASK: dict[str, Any] = {
    "parent_matter": None,
}

# Steward fields whose default is a structured value (list / dict).
# Tracked here so the idempotency check still recognises them as
# "Steward-known" but the patch generator skips them.
STEWARD_STRUCTURED_FIELDS: tuple[str, ...] = (
    "signal_sources",       # list
    "last_steward_outcome", # dict
)

# Default offset for the initial next_check_after stamp. 0 minutes →
# every record gets picked up by the first sweep on each matter's
# Schedule. Schedules are registered after this migration finishes.
INITIAL_NEXT_CHECK_OFFSET = timedelta(seconds=0)


def _checkpoint_path() -> Path:
    cfg = load_config()
    return Path(cfg.alfred_data_dir) / "state" / "steward" / "migrate-schema.checkpoint"


def _atomic_write(path: Path, payload: str) -> None:
    """Atomic write with parent-mkdir."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, path)


def _load_checkpoint() -> dict[str, Any]:
    p = _checkpoint_path()
    if not p.exists():
        return {"processed": [], "started_at": None, "finished_at": None}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        logger.warning(
            "checkpoint at %s unreadable (%s) — starting fresh", p, exc,
        )
        return {"processed": [], "started_at": None, "finished_at": None}


def _save_checkpoint(state: dict[str, Any]) -> None:
    _atomic_write(
        _checkpoint_path(),
        json.dumps(state, separators=(",", ":"), sort_keys=True),
    )


# ---------------------------------------------------------------------------
# ctrl-api client
# ---------------------------------------------------------------------------

class CtrlClient:
    """Minimal httpx wrapper for the vault list/read/patch endpoints."""

    def __init__(self) -> None:
        cfg = load_config()
        api_key = os.environ.get("AAS_API_KEY", "")
        if not api_key:
            raise RuntimeError(
                "AAS_API_KEY is not set — this script must run inside the "
                "alfred-learn container (or with env exported)."
            )
        self._client = httpx.AsyncClient(
            base_url=cfg.alfred_ctrl_url,
            timeout=30.0,
            headers={"Authorization": f"Bearer {api_key}"},
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def list_records(self, record_type: str) -> list[dict[str, Any]]:
        # preview=0 — we don't need body content for the schema migration.
        resp = await self._client.get(
            f"/api/v1/vault/list/{record_type}", params={"preview": 0}
        )
        resp.raise_for_status()
        return resp.json().get("results", [])

    async def patch_set(self, path: str, set_fields: dict[str, Any]) -> None:
        body = {"set": {k: _stringify(v) for k, v in set_fields.items()}}
        resp = await self._client.patch(
            f"/api/v1/vault/records/{path}", json=body
        )
        resp.raise_for_status()


def _stringify(v: Any) -> str:
    """Coerce a Python value to the string form ctrl-api PATCH /set expects.

    The underlying ``alfred vault edit --set k=v`` CLI accepts only
    scalar string values per field. ``None`` becomes the empty string
    (the YAML-load layer in ctrl-api maps that back to ``None`` on
    reads).

    This helper deliberately does NOT handle lists / dicts —
    structured Steward fields are excluded from the migration
    payload (see ``STEWARD_STRUCTURED_FIELDS``). If a list slips
    through, ``str(v)`` produces ``"[]"`` which is wrong; we surface
    that as a defensive ValueError so a future refactor doesn't
    silently regress.
    """
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return ""
    if isinstance(v, (list, dict)):
        raise ValueError(
            f"_stringify: structured value {type(v).__name__} is not "
            f"supported via PATCH set — use raw-content create instead",
        )
    return str(v)


# ---------------------------------------------------------------------------
# Per-record migration
# ---------------------------------------------------------------------------

def _has_all_steward_fields(fm: dict[str, Any], record_type: str) -> bool:
    """Idempotency check: does this record already carry every Steward
    field this migration is responsible for?

    Returns True iff every scalar Steward field (state, next_check_after,
    surface_class, ...) is present. The structured fields
    (``signal_sources``, ``last_steward_outcome``) are intentionally
    NOT checked — the migration doesn't write them; Steward populates
    them on first run. Value contents are NOT inspected once a field
    is present.
    """
    if "state" not in fm:
        return False
    if "next_check_after" not in fm:
        return False
    for key in STEWARD_FIELD_DEFAULTS_COMMON:
        if key not in fm:
            return False
    if record_type == "task":
        for key in STEWARD_FIELD_DEFAULTS_TASK:
            if key not in fm:
                return False
    return True


def _derive_state(fm: dict[str, Any], record_type: str) -> str:
    """Translate the legacy ``status`` field + ``archived`` flag onto
    the Steward state machine.

    For tasks::
        status: done / completed   → state: done
        status: cancelled          → state: archived
        archived: true             → state: archived
        otherwise                  → state: open

    For matters::
        status: resolved           → state: done
        status: abandoned          → state: archived
        archived: true             → state: archived
        otherwise                  → state: open
    """
    archived_val = fm.get("archived")
    archived = False
    if isinstance(archived_val, bool):
        archived = archived_val
    elif isinstance(archived_val, str):
        archived = archived_val.strip().lower() == "true"
    if archived:
        return "archived"

    status = ""
    raw = fm.get("status")
    if isinstance(raw, str):
        status = raw.strip().lower()

    if record_type == "task":
        if status in ("done", "completed"):
            return "done"
        if status in ("cancelled", "canceled"):
            return "archived"
        if status == "archived":
            return "archived"
        return "open"

    # matter
    if status == "resolved":
        return "done"
    if status == "abandoned":
        return "archived"
    if status == "archived":
        return "archived"
    return "open"


def _next_check_iso() -> str:
    return (datetime.now(timezone.utc) + INITIAL_NEXT_CHECK_OFFSET).isoformat(
        timespec="seconds",
    )


def _build_set_payload(
    fm: dict[str, Any], record_type: str
) -> dict[str, Any]:
    """Compute ONLY the fields that need writing for this record.

    Idempotency: if a key already exists in frontmatter we skip it
    (Steward owns the updates after migration). Returns an empty dict
    when nothing needs to change — caller can short-circuit the PATCH.
    """
    payload: dict[str, Any] = {}

    if "state" not in fm:
        payload["state"] = _derive_state(fm, record_type)

    if "next_check_after" not in fm:
        payload["next_check_after"] = _next_check_iso()

    for key, default in STEWARD_FIELD_DEFAULTS_COMMON.items():
        if key not in fm:
            payload[key] = default

    if record_type == "task":
        for key, default in STEWARD_FIELD_DEFAULTS_TASK.items():
            if key not in fm:
                payload[key] = default

    return payload


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------

async def _migrate_type(
    ctrl: CtrlClient,
    record_type: str,
    *,
    dry_run: bool,
    processed: set[str],
    batch_size: int,
) -> tuple[int, int, int]:
    """Migrate one record type. Returns ``(examined, written, skipped)``."""
    examined = 0
    written = 0
    skipped = 0

    try:
        records = await ctrl.list_records(record_type)
    except httpx.HTTPError as exc:
        logger.error(
            "list_records(%s) failed: %s — aborting migration of this type",
            record_type, exc,
        )
        return (0, 0, 0)

    logger.info(
        "migrate(%s): %d records found", record_type, len(records),
    )

    for rec in records:
        examined += 1
        path = rec.get("path") or ""
        if not path or not path.endswith(".md"):
            skipped += 1
            continue
        if path in processed:
            skipped += 1
            continue

        fm = rec.get("frontmatter") or {}
        if _has_all_steward_fields(fm, record_type):
            processed.add(path)
            skipped += 1
            if examined % batch_size == 0:
                logger.info(
                    "migrate(%s): progress examined=%d written=%d skipped=%d",
                    record_type, examined, written, skipped,
                )
                _save_checkpoint({"processed": sorted(processed)})
            continue

        payload = _build_set_payload(fm, record_type)
        if not payload:
            processed.add(path)
            skipped += 1
            continue

        if dry_run:
            logger.info(
                "DRY-RUN migrate(%s) %s ← %s",
                record_type, path,
                {k: payload[k] for k in sorted(payload)},
            )
            processed.add(path)
            written += 1
            continue

        try:
            await ctrl.patch_set(path, payload)
        except httpx.HTTPError as exc:
            logger.warning(
                "PATCH %s failed: %s — leaving for next run", path, exc,
            )
            continue

        written += 1
        processed.add(path)

        if examined % batch_size == 0:
            logger.info(
                "migrate(%s): progress examined=%d written=%d skipped=%d",
                record_type, examined, written, skipped,
            )
            _save_checkpoint({"processed": sorted(processed)})

    _save_checkpoint({"processed": sorted(processed)})
    logger.info(
        "migrate(%s): done examined=%d written=%d skipped=%d",
        record_type, examined, written, skipped,
    )
    return (examined, written, skipped)


async def _run(args: argparse.Namespace) -> int:
    if args.reset_checkpoint:
        p = _checkpoint_path()
        if p.exists():
            p.unlink()
            logger.info("checkpoint removed: %s", p)

    state = _load_checkpoint()
    processed = set(state.get("processed") or [])
    if state.get("started_at") is None:
        state["started_at"] = datetime.now(timezone.utc).isoformat(
            timespec="seconds"
        )

    logger.info(
        "migrate_steward_schema: dry_run=%s, resuming with %d already-processed paths",
        args.dry_run, len(processed),
    )

    ctrl = CtrlClient()
    totals = {"examined": 0, "written": 0, "skipped": 0}
    try:
        for record_type in ("matter", "task"):
            ex, wr, sk = await _migrate_type(
                ctrl,
                record_type,
                dry_run=args.dry_run,
                processed=processed,
                batch_size=args.batch_size,
            )
            totals["examined"] += ex
            totals["written"] += wr
            totals["skipped"] += sk
    finally:
        await ctrl.close()

    state["processed"] = sorted(processed)
    state["finished_at"] = datetime.now(timezone.utc).isoformat(
        timespec="seconds"
    )
    _save_checkpoint(state)

    print("\n" + "=" * 60)
    print("STEWARD SCHEMA MIGRATION SUMMARY")
    print("=" * 60)
    print(f"  mode:       {'DRY-RUN' if args.dry_run else 'LIVE'}")
    print(f"  examined:   {totals['examined']}")
    print(f"  written:    {totals['written']}")
    print(f"  skipped:    {totals['skipped']}")
    print(f"  checkpoint: {_checkpoint_path()}")
    print("=" * 60)
    return 0


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="migrate_steward_schema",
        description=(
            "Add Steward Phase 0 frontmatter fields to every matter/* and "
            "task/* record in the vault. Idempotent + resumable."
        ),
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Compute every PATCH but write nothing.",
    )
    p.add_argument(
        "--batch-size", type=int, default=100,
        help="Records between progress log + checkpoint flushes (default 100).",
    )
    p.add_argument(
        "--reset-checkpoint", action="store_true",
        help="Delete any existing checkpoint before starting.",
    )
    p.add_argument(
        "--verbose", action="store_true",
        help="DEBUG-level logging.",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    started = time.time()
    try:
        rc = asyncio.run(_run(args))
    except KeyboardInterrupt:
        print("\nmigrate_steward_schema: interrupted", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001 — top-level, want a non-zero exit
        logger.exception("migrate_steward_schema: failed: %s", exc)
        return 1
    logger.info("migrate_steward_schema: total runtime %.1fs", time.time() - started)
    return rc


if __name__ == "__main__":
    sys.exit(main())
