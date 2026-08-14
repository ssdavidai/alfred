"""Flywheel loop-health telemetry (#332).

Daily rollup of the learning loop's vital signs, stored as an audit row
(`action_type="flywheel_rollup"`, metrics in `changes`) — machine data
per the four-store contract, queryable via the existing
`GET /api/v1/state/audit?action_type=flywheel_rollup` with zero new
storage. Sundays additionally compose a weekly digest and deliver it via
the SANCTIONED notify path (VaultClient.notify — never cron announce,
per #288).

The point (from the issue): "it works" must be observed, not declared.
Every silent-loop failure class found in the 07/08 campaigns — dead
scorer, unprocessed observations, inert suppress arm — shows up here as
a flat zero within a day.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from temporalio import activity

from src.config import load_config
from src.utils.state_client import StateClient
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


def _day_bounds(day_iso: str | None) -> tuple[str, str, str]:
    if day_iso:
        day = datetime.fromisoformat(day_iso).date()
    else:
        day = (datetime.now(timezone.utc) - timedelta(days=1)).date()
    start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    return day.isoformat(), start.isoformat(), end.isoformat()


def _in_window(ts: Any, start: str, end: str) -> bool:
    s = str(ts or "")
    return bool(s) and start <= s.replace(" ", "T")[: len(start)] < end


@activity.defn
async def compute_flywheel_rollup(day_iso: str | None = None) -> dict[str, Any]:
    """Compute + persist yesterday's (or ``day_iso``'s) loop-health rollup."""
    day, start, end = _day_bounds(day_iso)
    config = load_config()
    metrics: dict[str, Any] = {"day": day}

    async with StateClient(config) as sc:
        obs = await sc.list_observations(since=start, limit=2000)
        by_kind: dict[str, int] = {}
        unprocessed = 0
        for o in obs:
            if not _in_window(o.get("ts") or o.get("created_at"), start, end):
                continue
            kind = str(o.get("kind") or "unknown")
            by_kind[kind] = by_kind.get(kind, 0) + 1
            if str(o.get("status") or "") != "processed":
                unprocessed += 1
        metrics["observations_by_kind"] = by_kind
        metrics["observations_total"] = sum(by_kind.values())
        metrics["observations_unprocessed_eod"] = unprocessed

        sigs = await sc.list_signals(since=start, limit=2000)
        routing: dict[str, int] = {}
        matched = 0
        for s in sigs:
            if not _in_window(s.get("ts") or s.get("created_at"), start, end):
                continue
            routing[str(s.get("status") or "unknown")] = (
                routing.get(str(s.get("status") or "unknown"), 0) + 1
            )
            payload = s.get("payload_json") or s.get("payload") or "{}"
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except json.JSONDecodeError:
                    payload = {}
            if isinstance(payload, dict) and payload.get("matched_instinct"):
                matched += 1
        metrics["signals_routing"] = routing
        metrics["signals_total"] = sum(routing.values())
        metrics["signals_matched_instinct"] = matched

        tier_resp = await sc.list_audit(
            action_type="instinct_tier_event", since=start, limit=200
        )
        tier_events = tier_resp.get("entries", []) if isinstance(tier_resp, dict) else tier_resp
        metrics["tier_events"] = len(
            [e for e in tier_events if _in_window(e.get("ts"), start, end)]
        )

    client = VaultClient(config)
    try:
        decisions = await client.list_decisions(since=start, limit=500)
        intents: dict[str, int] = {}
        reversals = 0
        for d in decisions:
            if not _in_window(d.get("created"), start, end):
                continue
            intents[str(d.get("intent") or "unknown")] = (
                intents.get(str(d.get("intent") or "unknown"), 0) + 1
            )
            if str(d.get("state") or "") == "reversed":
                reversals += 1
        metrics["decisions_by_intent"] = intents
        metrics["decisions_total"] = sum(intents.values())
        metrics["reversals"] = reversals

        # Surface hygiene: active-matter narrative freshness + orphan tasks.
        matters = await client.list_records("matter", status="active")
        fresh = stale = 0
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        for m in matters:
            fm = m.get("frontmatter") or {}
            as_of = str(fm.get("as_of") or "")
            if as_of and as_of >= cutoff:
                fresh += 1
            else:
                stale += 1
        metrics["matters_active"] = fresh + stale
        metrics["matters_narrative_fresh_24h"] = fresh

        tasks = await client.list_records("task", status="todo")
        orphans = 0
        for t in tasks:
            fm = t.get("frontmatter") or {}
            if not (fm.get("parent_matter") or fm.get("matter_ref") or fm.get("matter")):
                orphans += 1
        metrics["open_tasks_unlinked"] = orphans
    finally:
        await client.close()

    summary = (
        f"flywheel {day}: obs={metrics['observations_total']} "
        f"sig={metrics['signals_total']} (matched={matched}) "
        f"dec={metrics['decisions_total']} rev={reversals} "
        f"tier_events={metrics['tier_events']} "
        f"fresh_matters={metrics['matters_narrative_fresh_24h']}/{metrics['matters_active']} "
        f"orphan_tasks={orphans}"
    )
    async with StateClient(config) as sc:
        await sc.append_audit(
            action_type="flywheel_rollup",
            actor="alfred-learn",
            source="flywheel_telemetry",
            summary=summary,
            subject_ref=day,
            changes=metrics,
        )
    logger.info("flywheel_telemetry.rollup %s", summary)
    return metrics


@activity.defn
async def send_flywheel_digest() -> dict[str, Any]:
    """Weekly digest from the last 7 rollups, via the sanctioned notify path."""
    config = load_config()
    since = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
    async with StateClient(config) as sc:
        resp = await sc.list_audit(
            action_type="flywheel_rollup", since=since, limit=10
        )
    rows = resp.get("entries", []) if isinstance(resp, dict) else resp
    if not rows:
        return {"sent": False, "reason": "no rollups"}

    days: list[dict[str, Any]] = []
    for r in rows:
        ch = r.get("changes") or r.get("changes_json") or {}
        if isinstance(ch, str):
            try:
                ch = json.loads(ch)
            except json.JSONDecodeError:
                ch = {}
        if isinstance(ch, dict) and ch.get("day"):
            days.append(ch)
    days.sort(key=lambda d: d["day"])
    if not days:
        return {"sent": False, "reason": "no parseable rollups"}

    def tot(key: str) -> int:
        return sum(int(d.get(key) or 0) for d in days)

    flat_arms = []
    if tot("signals_matched_instinct") == 0 and tot("signals_total") > 0:
        flat_arms.append("instinct matching (0 matches)")
    if tot("observations_total") == 0 and tot("decisions_total") > 0:
        flat_arms.append("observation extraction (0 obs)")
    if tot("tier_events") == 0:
        flat_arms.append("tier promotion (0 events)")

    lines = [
        f"Weekly flywheel health ({days[0]['day']} → {days[-1]['day']}):",
        f"- observations: {tot('observations_total')} "
        f"(unprocessed at EOD: {tot('observations_unprocessed_eod')})",
        f"- signals: {tot('signals_total')}, instinct-matched: "
        f"{tot('signals_matched_instinct')}",
        f"- decisions: {tot('decisions_total')}, reversals: {tot('reversals')}",
        f"- tier events: {tot('tier_events')}",
        f"- orphan open tasks (latest): {days[-1].get('open_tasks_unlinked')}",
    ]
    if flat_arms:
        lines.append("⚠ FLAT ARMS (needs attention): " + "; ".join(flat_arms))
    text = "\n".join(lines)

    client = VaultClient(config)
    try:
        await client.notify("flywheel/weekly", text, solicited=0)
    finally:
        await client.close()
    return {"sent": True, "days": len(days), "flat_arms": flat_arms}
