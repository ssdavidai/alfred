"""Shared helpers for chore template workflows.

Templates call these as Temporal activities so they can do I/O (vault reads,
vault appends). The workflow itself stays deterministic; the activities do
the side effects.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient


@activity.defn
async def load_chore_context(chore_slug: str) -> dict[str, Any]:
    """Read the chore vault record and return its frontmatter as a dict.

    Returns a flat dict with the keys the templates need:
        chore_slug: the slug we were asked to load
        template:   template id (e.g. "subscription_watcher")
        params:     dict of template-specific params
        last_run:   ISO timestamp of last run, or None
        status:     "active" | "paused" | "completed"

    If the chore record cannot be found, returns status="completed" so
    callers fail-safe (silently exit) instead of crashing.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        try:
            record = await client.read_record(f"chore/{chore_slug}.md")
        except Exception:
            return {
                "chore_slug": chore_slug,
                "template": "",
                "params": {},
                "last_run": None,
                "status": "completed",
            }
        fm = record.get("frontmatter", {}) or {}
        return {
            "chore_slug": chore_slug,
            "template": fm.get("template", ""),
            "params": fm.get("params", {}) or {},
            "last_run": fm.get("last_run"),
            "status": fm.get("status", "active"),
        }
    finally:
        await client.close()


@activity.defn
async def record_chore_run(chore_slug: str, result_summary: str) -> None:
    """Append a one-line run-log entry to the chore record body.

    Best-effort: if the append fails (vault offline, record gone, etc.) we
    swallow the error so the chore workflow as a whole still reports success.
    Updating frontmatter fields like last_run/last_result requires a separate
    endpoint we don't have yet — for now the body log is the audit trail.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        ts = datetime.now(timezone.utc).isoformat()
        try:
            await client.update_record(
                f"chore/{chore_slug}.md",
                f"\n- {ts}: {result_summary}",
            )
        except Exception:
            # Best-effort logging — never fail a chore run because of this.
            pass
    finally:
        await client.close()
