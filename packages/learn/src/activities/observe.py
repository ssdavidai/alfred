"""Observation queue and alfred_instructions activities."""

from __future__ import annotations

from typing import Any

from temporalio import activity

from src.config import load_config
from src.utils.jsonl import read_jsonl, truncate_jsonl
from src.utils.vault_client import VaultClient
from src.validators.observation import validate_observation_record


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
