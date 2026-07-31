"""Session state machine activities — rolling 5-minute window."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from temporalio import activity

import httpx

from src.config import load_config
from src.utils.retry_policy import raise_if_permanent
from src.utils.vault_client import VaultClient


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@activity.defn
async def read_session_state() -> dict[str, Any]:
    """Read the current session state file."""
    config = load_config()
    state_path = f"{config.alfred_data_dir}/session-state.json"
    try:
        with open(state_path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


@activity.defn
async def write_session_state(state: dict[str, Any]) -> None:
    """Write the session state file."""
    config = load_config()
    state_path = f"{config.alfred_data_dir}/session-state.json"
    with open(state_path, "w") as f:
        json.dump(state, f, indent=2)


@activity.defn
async def fetch_recent_records(minutes: int) -> list[dict[str, Any]]:
    """Fetch vault records created in the last N minutes."""
    config = load_config()
    client = VaultClient(config)
    try:
        records = []
        for rtype in ("task", "event", "note", "conversation"):
            found = await client.list_records(rtype, limit=50)
            for r in found:
                created = r.get("created", r.get("received_at", ""))
                if created:
                    try:
                        ts = datetime.fromisoformat(created.replace("Z", "+00:00"))
                        now = datetime.now(timezone.utc)
                        if (now - ts).total_seconds() <= minutes * 60:
                            if not r.get("session_id"):  # Only unassigned records
                                records.append(r)
                    except (ValueError, TypeError):
                        pass
        return records
    finally:
        await client.close()


@activity.defn
async def create_session(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Create a new session from a set of records."""
    config = load_config()
    client = VaultClient(config)
    try:
        now = _now_iso()
        record_paths = [r.get("path", "") for r in records if r.get("path")]

        session = {
            "id": "",
            "started": now,
            "last_activity": now,
            "topic_summary": "",
            "records": record_paths,
            "record_count": len(record_paths),
            "idle_minutes": 0,
        }

        # Write initial session record to vault
        from src.activities.vault import vault_record_path

        slug = f"session-{now[:10]}-{now[11:16].replace(':', '')}"
        name = vault_record_path("session", slug)

        content = f"""---
type: session
name: Session {now[:10]}
status: active
started: {now}
last_activity: {now}
record_count: {len(record_paths)}
idle_minutes: 0
---

## Records
"""
        for p in record_paths:
            content += f"- [[{p}]]\n"

        try:
            path = await client.write_record("session", name, content)
        except httpx.HTTPStatusError as exc:
            # A 4xx here means the session payload itself is rejected — most
            # often 422 from the promotion contract. Retrying an invalid
            # payload cannot make it valid: on home this activity reached
            # attempt 7208 against the same 422, burning worker capacity and
            # burying every other failure in the log (#296).
            raise_if_permanent(exc, context="create_session write_record")
            raise
        session["id"] = path

        # Assign records to session
        for record in records:
            rpath = record.get("path", "")
            if rpath:
                try:
                    existing = await client.read_record(rpath)
                    raw = existing.get("content", "")
                    if "---" in raw:
                        from src.activities.vault import _apply_frontmatter_updates
                        updated = _apply_frontmatter_updates(raw, {"session_id": path})
                        await client.update_record(rpath, updated)
                except Exception:
                    pass

        return session
    finally:
        await client.close()


@activity.defn
async def append_to_session(
    session: dict[str, Any],
    new_records: list[dict[str, Any]],
    updated_summary: str,
) -> dict[str, Any]:
    """Append new records to an existing session."""
    config = load_config()
    client = VaultClient(config)
    try:
        now = _now_iso()
        new_paths = [r.get("path", "") for r in new_records if r.get("path")]

        session["records"].extend(new_paths)
        session["record_count"] = len(session["records"])
        session["last_activity"] = now
        session["idle_minutes"] = 0
        if updated_summary:
            session["topic_summary"] = updated_summary

        # Update the session vault record
        session_path = session.get("id", "")
        if session_path:
            try:
                existing = await client.read_record(session_path)
                raw = existing.get("content", "")
                from src.activities.vault import _apply_frontmatter_updates
                updated = _apply_frontmatter_updates(raw, {
                    "last_activity": now,
                    "record_count": str(session["record_count"]),
                })
                # Append new record wikilinks
                for p in new_paths:
                    updated += f"- [[{p}]]\n"
                await client.update_record(session_path, updated)
            except Exception:
                pass

        # Assign new records to session
        for record in new_records:
            rpath = record.get("path", "")
            if rpath:
                try:
                    existing = await client.read_record(rpath)
                    raw = existing.get("content", "")
                    if "---" in raw:
                        from src.activities.vault import _apply_frontmatter_updates
                        updated = _apply_frontmatter_updates(raw, {"session_id": session_path})
                        await client.update_record(rpath, updated)
                except Exception:
                    pass

        return session
    finally:
        await client.close()


@activity.defn
async def close_session(session: dict[str, Any], status: str) -> dict[str, Any]:
    """Close a session — Clerk matches to vault context, writes summary."""
    from src.activities.clerk import clerk_match_session_context

    config = load_config()
    client = VaultClient(config)
    try:
        now = _now_iso()
        started = session.get("started", now)

        # Ask Clerk to match session to vault context
        try:
            context = await clerk_match_session_context(session)
            if not isinstance(context, dict):
                context = {}
        except Exception:
            context = {}

        project = context.get("project", "")
        participants = context.get("participants", [])
        entities = context.get("entities", [])
        summary = context.get("summary", "")
        tags = context.get("tags", [])

        # Calculate duration
        try:
            start_dt = datetime.fromisoformat(started.replace("Z", "+00:00"))
            end_dt = datetime.now(timezone.utc)
            duration = int((end_dt - start_dt).total_seconds() / 60)
        except (ValueError, TypeError):
            duration = 0

        # Build session close content
        records = session.get("records", [])
        participants_yaml = "\n".join(f'  - "{p}"' for p in participants) if participants else "  []"
        entities_yaml = "\n".join(f'  - "{e}"' for e in entities) if entities else "  []"

        content = f"""---
type: session
name: Session {started[:10]}
status: {status}
started: {started}
ended: {now}
last_activity: {session.get("last_activity", now)}
duration_minutes: {duration}
record_count: {len(records)}
project: "{project}"
participants:
{participants_yaml}
entities:
{entities_yaml}
tags: {tags}
---

## Summary
{summary}

## Records
"""
        for p in records:
            content += f"- [[{p}]]\n"

        session_path = session.get("id", "")
        if session_path:
            await client.update_record(session_path, content)

        return {"path": session_path, "status": status}
    finally:
        await client.close()


# Legacy compatibility
@activity.defn
async def detect_session_boundaries(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Legacy: Group records by time proximity. Kept for backward compat."""
    return {"finalized": [], "ambiguous": []}
