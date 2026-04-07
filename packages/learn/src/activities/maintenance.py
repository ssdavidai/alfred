"""Nightly maintenance activities — one-shot janitor/distiller via ctrl-api.

These call the existing ctrl-api endpoints that exec alfred CLI commands
inside the alfred container. Bounded execution, no continuous daemons.
"""

from __future__ import annotations

from typing import Any

import httpx
from temporalio import activity

from src.config import load_config


@activity.defn
async def run_janitor_scan_and_fix() -> dict[str, Any]:
    """Run janitor scan + fix via ctrl-api. Returns summary stats."""
    config = load_config()
    base = config.alfred_ctrl_url
    api_key = __import__("os").environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"}

    async with httpx.AsyncClient(base_url=base, timeout=300.0, headers=headers) as client:
        # 1. Scan for issues
        scan_resp = await client.post("/api/v1/workers/janitor/scan")
        scan_resp.raise_for_status()
        scan_data = scan_resp.json()

        issues_found = 0
        if isinstance(scan_data, dict):
            issues_found = scan_data.get("issues", scan_data.get("count", 0))

        # 2. Fix issues (the janitor respects max_stubs_per_sweep cap)
        fix_resp = await client.post("/api/v1/workers/janitor/fix")
        fix_resp.raise_for_status()
        fix_data = fix_resp.json()

        issues_fixed = 0
        if isinstance(fix_data, dict):
            issues_fixed = fix_data.get("fixed", fix_data.get("count", 0))

    activity.logger.info(
        "janitor complete: found=%d fixed=%d", issues_found, issues_fixed
    )
    return {"issues_found": issues_found, "issues_fixed": issues_fixed}


@activity.defn
async def run_distiller_batch() -> dict[str, Any]:
    """Run distiller extraction via ctrl-api. Returns summary stats."""
    config = load_config()
    base = config.alfred_ctrl_url
    api_key = __import__("os").environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"}

    async with httpx.AsyncClient(base_url=base, timeout=300.0, headers=headers) as client:
        resp = await client.post("/api/v1/workers/distiller/run")
        resp.raise_for_status()
        data = resp.json()

    learnings = 0
    if isinstance(data, dict):
        learnings = data.get("created", data.get("learnings", 0))

    activity.logger.info("distiller complete: learnings=%d", learnings)
    return {"learnings_created": learnings}
