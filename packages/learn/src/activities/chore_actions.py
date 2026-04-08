"""Activities used by chore template workflows.

Most of these are pure Python — they fetch data, diff it, filter it, save
snapshots. Only ask_alfred_to_judge_anomalies and write_matter_digest_via_llm
make LLM calls, and only when the calling workflow has decided LLM input is
warranted. This honors the project rule:
"Temporal=when, Python=structure, LLM=creative only".

LLM dispatch goes through the OpenClaw gateway via _call_clerk (the same path
the rest of alfred-learn uses) — never the Anthropic API directly.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from temporalio import activity

from src.activities.clerk import _call_clerk
from src.config import load_config
from src.utils.vault_client import VaultClient


SNAPSHOT_DIR = "/alfred-data/chore-snapshots"


# ---------------------------------------------------------------------------
# subscription_watcher activities
# ---------------------------------------------------------------------------

@activity.defn
async def fetch_financial_events(matter_domains: list[str], days: int) -> list[dict[str, Any]]:
    """Pull events from the last N days where matter is in the watched domain set.

    Pure Python — no LLM calls. Walks the vault event listing, reads each
    record's frontmatter, filters by matter and date.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        all_events = await client.list_records("event", limit=1000)
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        out: list[dict[str, Any]] = []
        for e in all_events:
            try:
                record = await client.read_record(e["path"])
            except Exception:
                continue
            fm = record.get("frontmatter", {}) or {}
            matter = (fm.get("matter") or "").lower()
            if not any(d.lower() in matter for d in matter_domains):
                continue
            try:
                event_date = datetime.fromisoformat(
                    str(fm.get("date", "")).replace("Z", "+00:00")
                )
                # Some events come without tz info — assume UTC
                if event_date.tzinfo is None:
                    event_date = event_date.replace(tzinfo=timezone.utc)
            except Exception:
                continue
            if event_date < cutoff:
                continue
            out.append({
                "path": e["path"],
                "matter": matter,
                "amount": fm.get("amount"),
                "service": fm.get("service") or fm.get("name"),
                "date": fm.get("date"),
                "summary": (record.get("body") or "")[:500],
            })
            activity.heartbeat(f"scanned {len(out)} events")
        return out
    finally:
        await client.close()


@activity.defn
async def load_subscription_snapshot(chore_slug: str) -> dict[str, Any]:
    """Load the previous run's snapshot from disk. Returns {} on first run."""
    path = os.path.join(SNAPSHOT_DIR, f"{chore_slug}.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


@activity.defn
async def save_subscription_snapshot(chore_slug: str, events: list[dict[str, Any]]) -> None:
    """Persist this run's events as the new baseline snapshot for next week."""
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    path = os.path.join(SNAPSHOT_DIR, f"{chore_slug}.json")
    with open(path, "w") as f:
        json.dump(
            {"saved_at": datetime.now(timezone.utc).isoformat(), "events": events},
            f,
            indent=2,
            default=str,
        )


@activity.defn
async def diff_subscriptions(
    events: list[dict[str, Any]],
    snapshot: dict[str, Any],
) -> list[dict[str, Any]]:
    """Compute new charges, removed charges, and amount changes vs the snapshot.

    Pure Python. Each diff has a confidence score so the threshold filter
    downstream can decide which ones are worth surfacing.
    """
    prev_events = {e.get("path"): e for e in snapshot.get("events", [])}
    diffs: list[dict[str, Any]] = []

    for e in events:
        path = e.get("path")
        prev = prev_events.get(path)
        if prev is None:
            diffs.append({"kind": "new_charge", "event": e, "confidence": 0.5})
            continue
        if (
            e.get("amount") != prev.get("amount")
            and e.get("amount") is not None
            and prev.get("amount") is not None
        ):
            diffs.append({
                "kind": "amount_change",
                "event": e,
                "previous_amount": prev.get("amount"),
                "confidence": 0.7,
            })

    seen_now = {e.get("path") for e in events}
    for path, prev in prev_events.items():
        if path not in seen_now:
            diffs.append({"kind": "missing_charge", "event": prev, "confidence": 0.4})

    return diffs


@activity.defn
async def filter_anomalies_by_threshold(
    diffs: list[dict[str, Any]],
    threshold: float,
) -> list[dict[str, Any]]:
    """Drop any diff with confidence < threshold."""
    return [d for d in diffs if float(d.get("confidence", 0)) >= threshold]


@activity.defn
async def ask_alfred_to_judge_anomalies(
    chore_slug: str,
    anomalies: list[dict[str, Any]],
) -> dict[str, Any]:
    """LLM gate. Returns {should_notify: bool, message: str}.

    This is the ONLY LLM call in the subscription_watcher workflow. Most
    weeks (no anomalies above threshold) it never runs.
    """
    prompt = (
        "You are Alfred, watching the master's subscriptions. The following "
        "anomalies were detected in the last 7 days:\n\n"
        f"{json.dumps(anomalies, indent=2, default=str)}\n\n"
        "Decide whether ANY of these is worth bothering the master about. "
        "Bias toward silence — only notify if there is a clear actionable "
        "concern (failed payment, unexpected price increase > 10%, suspicious "
        "new charge). Return JSON: "
        '{"should_notify": true|false, "message": "<short butler-tone message>"}'
    )
    result = await _call_clerk(prompt)
    if isinstance(result, dict):
        return {
            "should_notify": bool(result.get("should_notify", False)),
            "message": str(result.get("message", "")),
        }
    return {"should_notify": False, "message": ""}


# ---------------------------------------------------------------------------
# weekly_matter_digest activities
# ---------------------------------------------------------------------------

@activity.defn
async def fetch_matter_events_last_week(matter_slug: str) -> list[dict[str, Any]]:
    """Pull all events from the last 7 days that reference the given matter.

    Pure Python — no LLM calls.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        all_events = await client.list_records("event", limit=500)
        cutoff = datetime.now(timezone.utc) - timedelta(days=7)
        out: list[dict[str, Any]] = []
        for e in all_events:
            try:
                record = await client.read_record(e["path"])
            except Exception:
                continue
            fm = record.get("frontmatter", {}) or {}
            if (fm.get("matter") or "").lower() != matter_slug.lower():
                continue
            try:
                event_date = datetime.fromisoformat(
                    str(fm.get("date", "")).replace("Z", "+00:00")
                )
                if event_date.tzinfo is None:
                    event_date = event_date.replace(tzinfo=timezone.utc)
            except Exception:
                continue
            if event_date < cutoff:
                continue
            out.append({
                "path": e["path"],
                "name": fm.get("name", ""),
                "date": fm.get("date"),
                "summary": (record.get("body") or "")[:500],
            })
            activity.heartbeat(f"matched {len(out)} events")
        return out
    finally:
        await client.close()


@activity.defn
async def write_matter_digest_via_llm(matter_slug: str, events: list[dict[str, Any]]) -> str:
    """LLM-written digest paragraph. The only LLM call in this template.

    Calls _call_clerk with raw=True to get plain text back (the digest is
    prose, not JSON).
    """
    prompt = (
        f"You are Alfred. Write a SHORT (3-5 sentence) weekly digest of "
        f"activity on the {matter_slug!r} matter. Here are the events from "
        f"the last 7 days:\n\n"
        f"{json.dumps(events[:50], indent=2, default=str)}\n\n"
        "Tone: butler. Highlight what changed, what needs attention, what to "
        "expect next week. No fluff, no preamble."
    )
    result = await _call_clerk(prompt, raw=True)
    return str(result) if result else ""


@activity.defn
async def save_digest_to_vault(matter_slug: str, digest: str) -> None:
    """Save the digest as a note in the vault for posterity / future audit."""
    config = load_config()
    client = VaultClient(config)
    try:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        slug = f"digest-{matter_slug}-{ts}"
        content = (
            f"---\n"
            f"type: note\n"
            f"name: Weekly digest — {matter_slug} — {ts}\n"
            f"matter: {matter_slug}\n"
            f"created: {ts}\n"
            f"tags: [chore, digest, weekly]\n"
            f"---\n\n"
            f"# Weekly digest — {matter_slug}\n\n"
            f"{digest}\n"
        )
        await client.write_record("note", slug, content)
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Shared notification helper
# ---------------------------------------------------------------------------

@activity.defn
async def send_chore_notification(chore_slug: str, session_id: str, message: str) -> None:
    """Send a notification via the existing tenant notification route.

    POSTs to ctrl-api /api/v1/notifications, which forwards to the OpenClaw
    gateway via the sessions_send tool. The session_id determines which
    Alfred session (and therefore which delivery channel) receives the
    message.
    """
    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    url = f"{config.alfred_ctrl_url}/api/v1/notifications"
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    async with httpx.AsyncClient(timeout=30.0) as http:
        try:
            await http.post(
                url,
                json={
                    "message": f"[Chore: {chore_slug}]\n\n{message}",
                    "urgency": "normal",
                    "session_id": session_id,
                },
                headers=headers,
            )
        except Exception:
            # Best-effort: don't fail the whole chore run because notification
            # delivery flaked.
            pass
