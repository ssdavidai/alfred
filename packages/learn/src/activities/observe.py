"""Observation queue and alfred_instructions activities."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from temporalio import activity

from src.config import load_config
from src.utils.jsonl import read_jsonl, truncate_jsonl
from src.utils.vault_client import VaultClient
from src.validators.observation import validate_observation_record

logger = logging.getLogger("alfred-learn")

# F.2: paths used by the chore-run-history seeder. Lives in the same
# /alfred-data dir as the rest of the learn state.
_CHORE_RUN_HISTORY_PATH = Path("/alfred-data/chore-run-history.jsonl")
_OBS_SEED_CURSOR_PATH = Path("/alfred-data/observation-seed-cursor.json")


@activity.defn
async def read_observation_queue() -> list[dict[str, Any]]:
    """Read pending items from the observation queue JSONL."""
    config = load_config()
    return read_jsonl(config.observation_queue_path)


@activity.defn
async def clear_observation_queue(count: int) -> None:
    """Remove the first `count` processed items from the queue."""
    config = load_config()
    truncate_jsonl(config.observation_queue_path, count)


@activity.defn
async def scan_alfred_instructions() -> list[dict[str, Any]]:
    """Scan recently modified vault files for alfred_instructions frontmatter."""
    config = load_config()
    client = VaultClient(config)
    try:
        results = await client.search_records("alfred_instructions", record_type="input")
        hints = []
        for r in results:
            content = r.get("content", "")
            if "alfred_instructions:" in content:
                from src.validators.frontmatter import parse_frontmatter

                fm, _ = parse_frontmatter(content)
                if fm.get("alfred_instructions"):
                    hints.append({
                        "path": r.get("path", ""),
                        "name": fm.get("name", ""),
                        "type": fm.get("type", "input"),
                        "alfred_instructions": fm["alfred_instructions"],
                        "content": content,
                    })
        return hints
    finally:
        await client.close()


# Legacy alias for backward compatibility
scan_routing_hints = scan_alfred_instructions


@activity.defn
async def validate_observation(observation: dict[str, Any]) -> bool:
    """Validate an observation record. Returns True if valid."""
    result = validate_observation_record(observation)
    return result.valid


@activity.defn
async def execute_alfred_instructions(hint: dict[str, Any]) -> None:
    """Execute alfred_instructions — interpret and apply via Clerk."""
    from src.activities.clerk import clerk_execute_instructions

    config = load_config()
    client = VaultClient(config)
    try:
        plan = await clerk_execute_instructions(hint)

        if not plan.get("understood", False):
            return

        for action in plan.get("actions", []):
            action_type = action.get("type", "")
            target = action.get("target", "")
            details = action.get("details", "")

            if not target:
                continue

            if action_type == "update":
                existing = await client.read_record(target)
                raw = existing.get("content", "")
                if raw and details:
                    from src.activities.vault import _apply_frontmatter_updates
                    updated = _apply_frontmatter_updates(raw, {"alfred_instructions_applied": details})
                    await client.update_record(target, updated)

            elif action_type == "assign":
                existing = await client.read_record(target)
                raw = existing.get("content", "")
                if raw:
                    from src.activities.vault import _apply_frontmatter_updates
                    updated = _apply_frontmatter_updates(raw, {"assigned_to": details})
                    await client.update_record(target, updated)

            elif action_type in ("route", "move"):
                destination = action.get("details", action.get("target", ""))
                if destination and target:
                    await client._client.post(
                        "/api/v1/learning/route",
                        json={"input_id": target, "destination": destination},
                    )

            elif action_type == "notify":
                await client.notify(target, details)

        # Mark instructions as processed
        path = hint.get("path", "")
        if path:
            existing = await client.read_record(path)
            raw = existing.get("content", "")
            lines = raw.split("\n")
            new_lines = [ln for ln in lines if not ln.strip().startswith("alfred_instructions:")]
            updated = "\n".join(new_lines)
            await client.update_record(path, updated)
    finally:
        await client.close()


@activity.defn
async def execute_routing_hint(hint: dict[str, Any]) -> None:
    """Execute a routing hint — legacy compat, delegates to execute_alfred_instructions."""
    await execute_alfred_instructions(hint)


# ---------------------------------------------------------------------------
# F.2: chore-run observation seeder
# ---------------------------------------------------------------------------

def _read_seed_cursor() -> dict[str, Any]:
    """Read the high-water-mark cursor for the chore-run seeder."""
    try:
        if _OBS_SEED_CURSOR_PATH.exists():
            return json.loads(_OBS_SEED_CURSOR_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        pass
    return {"chore_run_history_max_ts": 0.0}


def _write_seed_cursor(cursor: dict[str, Any]) -> None:
    """Persist the high-water-mark cursor."""
    try:
        _OBS_SEED_CURSOR_PATH.parent.mkdir(parents=True, exist_ok=True)
        _OBS_SEED_CURSOR_PATH.write_text(json.dumps(cursor, default=str, indent=2))
    except OSError as exc:
        logger.warning("seed_observations: cursor write failed: %s", exc)


def _build_observation_from_chore_run(entry: dict[str, Any]) -> dict[str, Any]:
    """Convert a chore-run-history.jsonl entry into a valid observation dict.

    Schema produced matches the validate_observation_record contract:
    required fields (input_type, reasoning, input_source, routing_decision,
    confidence, routed_by, signals) all populated.
    """
    chore_slug = str(entry.get("chore_slug", "unknown"))
    summary = str(entry.get("result_summary", ""))
    was_dry_run = bool(entry.get("was_dry_run", False))
    timestamp = entry.get("timestamp", 0)

    reasoning = (
        f"Chore '{chore_slug}' completed at epoch {timestamp}. "
        f"Result: {summary}. "
        f"This run was {'a quarantine dry-run (no side effects)' if was_dry_run else 'live'}."
    )

    return {
        "input_type": "chore_run",
        "input_source": f"chore/{chore_slug}",
        "input_ref": f"chore-run-history.jsonl#{timestamp}",
        "routing_decision": {
            "destination": "log",
            "process": "chore-history",
            "assigned_to": "alfred",
        },
        "reasoning": reasoning,
        "confidence": "machine",
        "routed_by": "alfred",
        "source": "chore_run",
        "source_session": "",
        "created_by": "seed_observations_from_chore_runs",
        "tags": ["chore", "auto-seeded", chore_slug, "dry-run" if was_dry_run else "live"],
        "signals": {
            "domain_patterns": [],
            "keyword_patterns": [chore_slug],
            "input_types": ["chore_run"],
            "attachment_patterns": [],
        },
    }


@activity.defn
async def seed_observations_from_chore_runs(max_per_tick: int = 50) -> dict[str, Any]:
    """Read chore-run-history.jsonl and write observation vault records for new entries.

    Tracks a high-water-mark cursor at /alfred-data/observation-seed-cursor.json
    so each tick only processes new entries. Caps the number of records
    written per tick to keep the activity bounded.

    Returns:
        {
            "ok": bool,
            "scanned": int,        # entries inspected
            "seeded": int,         # observations written
            "skipped": int,        # already-processed (cursor) skips
            "max_ts": float,       # new high-water mark
        }

    Bypasses the observation_queue + clerk path because the clerk extract
    activity needs Opus calls per item, which is too expensive for the
    LearningWorkflow's every-15-min cadence. The chore_run observations
    are pre-structured so they don't need an LLM to extract them.

    Failures are logged and returned as ok=False so the LearningWorkflow
    can continue to its other entry points (queue + alfred_instructions)
    without aborting.
    """
    activity.heartbeat("seed_observations: reading chore-run-history.jsonl")

    if not _CHORE_RUN_HISTORY_PATH.exists():
        return {
            "ok": True,
            "scanned": 0,
            "seeded": 0,
            "skipped": 0,
            "max_ts": 0.0,
            "note": "no chore-run-history.jsonl yet",
        }

    cursor = _read_seed_cursor()
    last_ts = float(cursor.get("chore_run_history_max_ts", 0.0))

    new_entries: list[dict[str, Any]] = []
    scanned = 0
    skipped = 0

    try:
        with _CHORE_RUN_HISTORY_PATH.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                scanned += 1
                try:
                    entry = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                if not isinstance(entry, dict):
                    continue
                ts = entry.get("timestamp")
                if not isinstance(ts, (int, float)):
                    continue
                if ts <= last_ts:
                    skipped += 1
                    continue
                new_entries.append(entry)
                if len(new_entries) >= max_per_tick:
                    break
    except OSError as exc:
        return {
            "ok": False,
            "scanned": scanned,
            "seeded": 0,
            "skipped": skipped,
            "max_ts": last_ts,
            "error": f"read failed: {exc}",
        }

    if not new_entries:
        return {
            "ok": True,
            "scanned": scanned,
            "seeded": 0,
            "skipped": skipped,
            "max_ts": last_ts,
        }

    # Sort by timestamp ascending so we process in chronological order
    new_entries.sort(key=lambda e: float(e.get("timestamp", 0)))

    # Import write here to avoid circular import
    from src.activities.vault import write_observation_record

    seeded = 0
    new_max_ts = last_ts
    for entry in new_entries:
        obs = _build_observation_from_chore_run(entry)
        result = validate_observation_record(obs)
        if not result.valid:
            logger.warning(
                "seed_observations: observation failed validation: %s",
                result.errors,
            )
            continue
        try:
            await write_observation_record(obs)
            seeded += 1
            new_max_ts = max(new_max_ts, float(entry.get("timestamp", 0)))
            if seeded % 10 == 0:
                activity.heartbeat(f"seed_observations: wrote {seeded} so far")
        except Exception as exc:
            logger.warning("seed_observations: write_observation_record failed: %s", exc)

    if seeded > 0:
        cursor["chore_run_history_max_ts"] = new_max_ts
        _write_seed_cursor(cursor)

    logger.info(
        "seed_observations: scanned=%d skipped=%d seeded=%d max_ts=%s",
        scanned, skipped, seeded, new_max_ts,
    )
    return {
        "ok": True,
        "scanned": scanned,
        "seeded": seeded,
        "skipped": skipped,
        "max_ts": new_max_ts,
    }
