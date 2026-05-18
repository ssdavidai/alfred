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


# ---------------------------------------------------------------------------
# Generic chore primitives — the three activities Alfred composes chores from.
#
# A generated chore's workflow is limited (by the dynamic-loader allowlist) to
# calling activities imported from this module. Instead of adding a new
# bespoke activity for every "fetch X / format Y / write Z" recipe, we expose
# three generic passthroughs that mirror the primitives the main agent already
# has: the ctrl-api surface, the Composio gateway, and LLM reasoning via a
# subagent spawn. A chore workflow then becomes plain Python plus calls to
# these three.
#
#   call_self(endpoint, method, body?, query?) -> dict
#       Same shape as the `self` MCP tool. HTTP to tenant ctrl-api :3100
#       with the AAS bearer already attached.
#
#   call_composio(action, arguments?) -> dict
#       Dispatch any Composio action (Gmail, Calendar, Notion, GitHub,
#       Stripe, Slack, ...). Credentials + user_id routing are handled by
#       ctrl-api; caller just names the action.
#
#   spawn_subagent(prompt, agent_id?, timeout_s?) -> str
#       Fire-and-wait an openclaw-workers subagent with the given prompt.
#       Returns the assistant's final text. Use only when the step genuinely
#       needs reasoning — filtering / formatting / aggregation should stay
#       in the workflow's Python body. Default agent is `learn-clerk`
#       (pre-registered with self + composio tools).
# ---------------------------------------------------------------------------


@activity.defn
async def call_self(
    endpoint: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    query: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """HTTP → tenant ctrl-api :3100. Same surface as the `self` MCP tool.

    `endpoint` is the path (e.g. `/api/v1/vault/list/matter`). `method`
    defaults to GET; use POST/PATCH/DELETE for writes. `body` is the JSON
    payload (ignored for GET). `query` is the query-string dict.

    Returns the parsed JSON response. Raises on non-2xx (Temporal will
    retry per the workflow's retry policy).
    """
    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    url = f"{config.alfred_ctrl_url}{endpoint}"
    method_upper = method.upper()
    async with httpx.AsyncClient(timeout=60.0) as http:
        resp = await http.request(
            method_upper,
            url,
            headers=headers,
            params=query or None,
            json=body if method_upper not in {"GET", "DELETE"} else None,
        )
        resp.raise_for_status()
        if not resp.content:
            return {}
        try:
            return resp.json()
        except ValueError:
            return {"raw": resp.text}


@activity.defn
async def call_composio(
    action: str,
    arguments: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Execute any Composio action via ctrl-api's composio dispatcher.

    `action` is the Composio action name (e.g. `GMAIL_SEND_EMAIL`,
    `GOOGLECALENDAR_CREATE_EVENT`, `NOTION_CREATE_PAGE`). `arguments` is
    the per-action payload — check the per-app SKILL.md or the Composio
    docs for schemas.

    Returns the action result as a dict. Delegates to `call_self` since
    the composio dispatcher is just a ctrl-api endpoint.
    """
    return await call_self(
        endpoint="/api/v1/integrations/execute",
        method="POST",
        body={"action": action, "arguments": arguments or {}},
    )


@activity.defn
async def spawn_subagent(
    prompt: str,
    agent_id: str = "learn-clerk",
    timeout_s: int = 300,
) -> str:
    """Run a prompt through an openclaw-workers subagent, return its text.

    Default `agent_id` is `learn-clerk` which is pre-registered with the
    self + composio tool surface. For specialized personas use
    `alfred-vault-curator` (curator prose) or `alfred-voice` (voice-tuned).
    Custom tool sets require a follow-up PR to register a new agent in
    the workers openclaw.json.

    The subagent runs with maxConcurrent=1 on workers — two chores firing
    at the same minute will serialise. Keep `timeout_s` tight enough that
    one slow subagent doesn't block the next chore's tick.
    """
    return await _workers_spawn_subagent(
        agent_id=agent_id,
        prompt=prompt,
        run_timeout_s=min(timeout_s, 600),
        poll_timeout_s=timeout_s,
    )


# ---------------------------------------------------------------------------
# daily_morning_briefing v2 — matter-structured, multi-subagent architecture.
#
# One orchestrating activity because the chore dynamic-loader allowlist (see
# src.workflows.chores._dynamic_loader.ALLOWED_IMPORTS) restricts chore
# template imports to src.activities.chore_actions. Adding per-stage
# activities would require loosening that allowlist; keeping the whole
# v2 pipeline inside a single activity preserves the safety boundary
# without sacrificing the multi-subagent design.
#
# The activity:
#   1. Gathers last-24h signal bundle (Gmail + Composio streams + tasks +
#      observations + inbound phone).
#   2. Loads active matters, detects which lack routing metadata, spawns
#      a vault-curator subagent on openclaw-workers to enrich each bare
#      matter (PATCH its frontmatter with domains / related_persons /
#      related_orgs / keywords / parent_matter).
#   3. Spawns a learn-clerk subagent on workers with all events + matters
#      + calendar context, asks for a structured JSON digest: per-matter
#      attention items + fyi counts + calendar summary + headline.
#   4. Spawns a SECOND learn-clerk subagent to format the structured JSON
#      into a 2-3 paragraph Slack-ready briefing with butler tone.
#   5. Delivers via send_chore_notification OR writes to a preview path
#      (params.preview_only=true) so the operator can review before
#      signing off on Slack delivery.
#
# All LLM calls go through openclaw-workers (port 18790) via
# sessions_spawn. Workers use grok-4.1-fast as their default model and
# enforce maxConcurrent=1, so the subagent calls serialize naturally.
# ---------------------------------------------------------------------------

_BRIEFING_ACTIVITY_TIMEOUT_S = 1800  # 30 minutes — accommodates workers serialization

# Frontmatter fields that signal a matter already has routing metadata.
_MATTER_METADATA_FIELDS = ("domains", "related_persons", "related_orgs", "keywords")

# Where preview output lands when params.preview_only is true. SSH-readable
# from the operator's machine without going through the notification stack.
_PREVIEW_OUTPUT_DIR = "/alfred-data/briefing-previews"


async def _workers_spawn_subagent(
    *,
    agent_id: str,
    prompt: str,
    run_timeout_s: int = 240,
    poll_timeout_s: int = 300,
) -> str:
    """Spawn an openclaw-workers subagent and return the assistant's final text.

    Hits config.execution_gateway_url (workers, :18790) — NOT the main openclaw
    gateway — because chore LLM calls are pinned to workers per project
    policy. Uses the existing sessions_spawn → sessions_history polling
    pattern from _call_clerk, adapted for the workers endpoint.

    Returns the assistant's most recent text message, empty string on
    timeout or failure. Caller is responsible for JSON-parsing if needed.
    """
    import asyncio

    config = load_config()
    token = config.gateway_token()
    base = config.execution_gateway_url.rstrip("/")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    session_key: str | None = None
    async with httpx.AsyncClient(timeout=60.0) as client:
        spawn_resp = await client.post(
            f"{base}/tools/invoke",
            headers=headers,
            json={
                "tool": "sessions_spawn",
                "args": {
                    "task": prompt,
                    "agentId": agent_id,
                    "mode": "run",
                    "cleanup": "auto",
                    "sandbox": "inherit",
                    "runTimeoutSeconds": run_timeout_s,
                    "expectsCompletionMessage": False,
                },
            },
        )
        spawn_resp.raise_for_status()
        spawn_data = spawn_resp.json()

        for item in spawn_data.get("result", {}).get("content", []):
            if isinstance(item, dict) and item.get("type") == "text":
                try:
                    session_key = json.loads(item["text"]).get("childSessionKey")
                except (json.JSONDecodeError, KeyError):
                    pass

    if not session_key:
        activity.logger.warning(
            "_workers_spawn_subagent: no childSessionKey from spawn (agent=%s)", agent_id
        )
        return ""

    # Poll sessions_history for the assistant reply.
    deadline = asyncio.get_event_loop().time() + poll_timeout_s
    async with httpx.AsyncClient(timeout=30.0) as client:
        while asyncio.get_event_loop().time() < deadline:
            activity.heartbeat(f"polling {agent_id} session {session_key[:8]}")
            await asyncio.sleep(8)
            try:
                hist_resp = await client.post(
                    f"{base}/tools/invoke",
                    headers=headers,
                    json={
                        "tool": "sessions_history",
                        "args": {"sessionKey": session_key, "limit": 6},
                    },
                )
                if hist_resp.status_code != 200:
                    continue
                hist = hist_resp.json()
            except Exception:
                continue

            messages: list[dict[str, Any]] = []
            for item in hist.get("result", {}).get("content", []):
                if isinstance(item, dict) and item.get("type") == "text":
                    try:
                        parsed = json.loads(item["text"])
                        messages = parsed.get("messages", [])
                    except (json.JSONDecodeError, TypeError):
                        pass

            # Latest assistant message wins. Skip user/system turns.
            for msg in reversed(messages):
                if msg.get("role") != "assistant":
                    continue
                content = msg.get("content", "")
                if isinstance(content, str) and content.strip():
                    return content
                if isinstance(content, list):
                    parts = [
                        p.get("text", "")
                        for p in content
                        if isinstance(p, dict) and p.get("type") == "text"
                    ]
                    joined = "\n".join(t for t in parts if t).strip()
                    if joined:
                        return joined
                break  # only look at the most recent assistant msg

    activity.logger.warning(
        "_workers_spawn_subagent: timed out after %ds (agent=%s)", poll_timeout_s, agent_id
    )
    return ""


def _strip_code_fence(text: str) -> str:
    """Best-effort extraction of a JSON object from a subagent reply.

    Subagents often wrap JSON in ```json …``` fences or prefix it with
    preamble. We look for the first '{' and last '}' and slice between.
    """
    if not text:
        return text
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return text
    return text[start : end + 1]


async def _ctrl_get(path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    url = f"{config.alfred_ctrl_url}{path}"
    async with httpx.AsyncClient(timeout=30.0) as http:
        resp = await http.get(url, headers=headers, params=params or {})
        resp.raise_for_status()
        return resp.json()


async def _ctrl_post(path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    url = f"{config.alfred_ctrl_url}{path}"
    async with httpx.AsyncClient(timeout=60.0) as http:
        resp = await http.post(url, headers=headers, json=body or {})
        # ctrl-api returns {error: "..."} at 200 for some dispatchers; keep
        # non-2xx as raises so real failures surface.
        if resp.status_code >= 500:
            resp.raise_for_status()
        try:
            return resp.json()
        except ValueError:
            return {"error": f"non-JSON response (status {resp.status_code})"}


async def _gather_signal_bundle() -> dict[str, Any]:
    """Pull last-24h signals from all tenant-side sources. Pure I/O, no LLM.

    Returns a dict with:
      events: list of stream events (normalised)
      tasks_open: list of vault tasks with status active/overdue
      tasks_due_today: subset of tasks_open with due within 24h
      observations_new: list of observations created recently
      phone_inbound: SMS + voice-call events in the window
      calendar: {
        integration_available: bool,
        events_today: list[{title, start, attendees}],
        events_tomorrow: list[...],
      }

    Window: 72 hours. We look back 3 days rather than 24 because if the
    briefing missed a day (weekend, outage, dormant user), a pure 24-hour
    cutoff drops anything from that gap. 72h gives a soft catch-up.
    Attention classification in the triage LLM decides what's fresh enough
    to surface.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=72)
    bundle: dict[str, Any] = {
        "events": [],
        "tasks_open": [],
        "tasks_due_today": [],
        "observations_new": [],
        "phone_inbound": [],
        "calendar": {
            "integration_available": False,
            "events_today": [],
            "events_tomorrow": [],
        },
    }

    # Streams — one aggregate call, filter client-side.
    try:
        events_resp = await _ctrl_get("/api/v1/streams/events", params={"limit": "500"})
        raw_events = events_resp.get("events") if isinstance(events_resp, dict) else events_resp
        for ev in raw_events or []:
            try:
                received = datetime.fromisoformat(
                    str(ev.get("received_at", "")).replace("Z", "+00:00")
                )
                if received.tzinfo is None:
                    received = received.replace(tzinfo=timezone.utc)
                if received < cutoff:
                    continue
            except (ValueError, TypeError):
                continue
            stream_type = str(ev.get("stream_type") or "")
            # Drop Sir's own chat turns with Alfred — those are part of his
            # active conversation, not signals to surface back at him.
            # Openclaw session events come in as stream_type=conversation;
            # they're already visible in his session history and resurfacing
            # them as "attention items" is both noisy and self-referential.
            if stream_type == "conversation":
                continue
            if stream_type in ("sms", "voice-call"):
                bundle["phone_inbound"].append(ev)
            else:
                bundle["events"].append(ev)
    except Exception as exc:
        activity.logger.warning("signal_bundle: streams/events failed: %s", exc)

    # Vault tasks.
    try:
        tasks_resp = await _ctrl_get("/api/v1/vault/list/task")
        for t in (tasks_resp.get("results") or []):
            status = (t.get("status") or "").lower()
            if status not in ("active", "overdue", "in-progress"):
                continue
            bundle["tasks_open"].append(t)
            due = t.get("due") or t.get("due_date")
            if due:
                try:
                    due_dt = datetime.fromisoformat(str(due).replace("Z", "+00:00"))
                    if due_dt.tzinfo is None:
                        due_dt = due_dt.replace(tzinfo=timezone.utc)
                    if due_dt <= datetime.now(timezone.utc) + timedelta(hours=24):
                        bundle["tasks_due_today"].append(t)
                except (ValueError, TypeError):
                    pass
    except Exception as exc:
        activity.logger.warning("signal_bundle: tasks list failed: %s", exc)

    # Recent observations.
    try:
        obs_resp = await _ctrl_get("/api/v1/vault/list/observation")
        for o in (obs_resp.get("results") or []):
            created = o.get("created") or o.get("created_at")
            if not created:
                continue
            try:
                c_dt = datetime.fromisoformat(str(created).replace("Z", "+00:00"))
                if c_dt.tzinfo is None:
                    c_dt = c_dt.replace(tzinfo=timezone.utc)
                if c_dt >= cutoff:
                    bundle["observations_new"].append(o)
            except (ValueError, TypeError):
                continue
    except Exception as exc:
        activity.logger.warning("signal_bundle: observations list failed: %s", exc)

    # Calendar — fetch fresh from the Composio googlecalendar integration at
    # bundle-build time. The stream-puller's periodic pulls store the full
    # envelope (metadata + items[]) as one event per pull and the `items` list
    # is often empty; relying on those stream events misses everything. A
    # direct call to GOOGLECALENDAR_EVENTS_LIST with a tight time window
    # returns the real event list every time, and surfaces disconnection
    # explicitly so the briefing can tell Sir to reconnect.
    now = datetime.now(timezone.utc)
    today = now.date()
    time_min = datetime(today.year, today.month, today.day, tzinfo=timezone.utc).isoformat()
    time_max = (
        datetime(today.year, today.month, today.day, tzinfo=timezone.utc)
        + timedelta(days=2)
    ).isoformat()
    try:
        cal_result = await _ctrl_post(
            "/api/v1/integrations/execute",
            body={
                "action": "GOOGLECALENDAR_EVENTS_LIST",
                "arguments": {
                    "calendar_id": "primary",
                    "time_min": time_min,
                    "time_max": time_max,
                    "max_results": 50,
                    "single_events": True,
                    "order_by": "startTime",
                },
            },
        )
        # Disconnection signal: ctrl-api returns {"error": "No active ..."}
        # when the tenant has no live Composio connection. Keep
        # integration_available=False so the briefing prompt nudges a reconnect.
        err = cal_result.get("error") if isinstance(cal_result, dict) else None
        data = cal_result.get("data") if isinstance(cal_result, dict) else None
        items = (data or {}).get("items") or (data or {}).get("event_list") or []
        if err or not data:
            bundle["calendar"]["integration_available"] = False
            activity.logger.warning(
                "signal_bundle: calendar fetch returned no data (err=%s)", str(err)[:200]
            )
        else:
            bundle["calendar"]["integration_available"] = True
            for item in items:
                start = item.get("start") or {}
                start_str = start.get("dateTime") or start.get("date") or ""
                try:
                    start_dt = datetime.fromisoformat(str(start_str).replace("Z", "+00:00"))
                    if start_dt.tzinfo is None:
                        start_dt = start_dt.replace(tzinfo=timezone.utc)
                except (ValueError, TypeError):
                    continue
                summary = {
                    "title": item.get("summary") or "(no title)",
                    "start": start_str,
                    "attendees": [
                        a.get("email") or a.get("displayName", "")
                        for a in (item.get("attendees") or [])[:5]
                    ],
                }
                if start_dt.date() == today:
                    bundle["calendar"]["events_today"].append(summary)
                elif start_dt.date() == today + timedelta(days=1):
                    bundle["calendar"]["events_tomorrow"].append(summary)
    except Exception as exc:
        activity.logger.warning("signal_bundle: calendar fetch failed: %s", exc)
        bundle["calendar"]["integration_available"] = False

    return bundle


async def _load_active_matters() -> list[dict[str, Any]]:
    """Fetch active matter records with their frontmatter metadata."""
    try:
        resp = await _ctrl_get("/api/v1/vault/list/matter")
    except Exception as exc:
        activity.logger.warning("load_active_matters: failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    for m in (resp.get("results") or []):
        if (m.get("status") or "").lower() != "active":
            continue
        out.append(m)
    return out


def _matter_is_bare(matter: dict[str, Any]) -> bool:
    """A matter is bare when none of the routing-metadata fields are populated."""
    for f in _MATTER_METADATA_FIELDS:
        v = matter.get(f)
        if isinstance(v, list) and v:
            return False
        if isinstance(v, str) and v.strip():
            return False
    return True


async def _enrich_bare_matter(matter: dict[str, Any]) -> None:
    """Spawn vault-curator on workers to populate routing metadata for one matter.

    The curator reads the matter body + scans related vault records, then
    PATCHes the matter frontmatter with domains / related_persons /
    related_orgs / keywords / parent_matter.

    No-ops on subagent timeout — the matter stays bare and fast-path
    routing will fall through to LLM classification during the main
    digest step. Better to degrade gracefully than block the briefing.
    """
    name = matter.get("name") or matter.get("slug") or "(unknown)"
    path = matter.get("path") or f"matter/{matter.get('slug') or ''}.md"
    prompt = f"""You are the vault-curator. Enrich a matter with routing metadata so future chores can classify incoming events against it.

## Matter to enrich
name: {name}
path: {path}

## Your task

The tool for vault I/O is `alfred-ctrl__self` (MCP-namespaced — NOT plain `self`). All three steps MUST use that exact tool name.

1. Read the matter record:
   `alfred-ctrl__self({{"endpoint": "/api/v1/vault/records/{path}"}})`
2. Scan related records:
   `alfred-ctrl__self({{"endpoint": "/api/v1/vault/search", "query": {{"q": "{name}"}}}})` — look at recent events, persons, orgs.
3. Synthesise these fields (best effort — empty lists are fine if nothing found):
   - `domains`: list of email/website domains associated with this matter (e.g. ["bakerynext.hu", "szamlazz.hu"])
   - `related_persons`: list of person names OR emails that appear in events about this matter
   - `related_orgs`: list of organisation names referenced
   - `keywords`: 3-5 short tags (single words or hyphenated) that a router could match against email subjects
   - `parent_matter`: if this matter is a sub-project of a larger business (e.g. "B9 Penthouse" belongs to a property-development parent), set the parent matter's slug. Leave null if this IS a top-level matter.
4. PATCH the matter:
   `alfred-ctrl__self({{"endpoint": "/api/v1/vault/records/{path}", "method": "PATCH", "body": {{"set": {{"domains": […], "related_persons": […], "related_orgs": […], "keywords": […], "parent_matter": "…" or null}}}}}})`

5. Your FINAL message must be a single line: "enriched {name} with D domains, P persons, O orgs, K keywords, parent=<parent-or-none>". Nothing else.

CRITICAL: If you report success without having actually called `alfred-ctrl__self` at least twice (read + PATCH), the enrichment has NOT happened — do not hallucinate. When the tool doesn't exist or args are wrong, say so explicitly instead of fabricating a success line.
"""
    reply = await _workers_spawn_subagent(
        agent_id="vault-curator",
        prompt=prompt,
        run_timeout_s=180,
        poll_timeout_s=240,
    )
    activity.logger.info("enrich_bare_matter: %s -> %s", name, reply[:200])


def _compact_events_for_prompt(
    events: list[dict[str, Any]], max_events: int = 80
) -> list[dict[str, Any]]:
    """Reduce events to minimal routing-relevant fields to keep prompt small.

    Keeps: from, to, subject, summary, stream_type, source_ref, received_at,
    channel (for phone). Drops raw full-body HTML.
    """
    out: list[dict[str, Any]] = []
    for e in events[:max_events]:
        raw = e.get("raw") or {}
        compact = {
            "ts": e.get("received_at"),
            "stream_type": e.get("stream_type"),
            "source": e.get("source") or e.get("stream_id"),
            "source_ref": e.get("source_ref"),
            "summary": (e.get("summary") or "")[:200],
            "from": raw.get("from") or raw.get("sender") or raw.get("author"),
            "to": raw.get("to") or raw.get("recipient"),
            "subject": (raw.get("subject") or raw.get("title") or "")[:160],
        }
        # Gmail auto-headers: keep signal of what's auto-generated vs human.
        labels = raw.get("labelIds") or raw.get("labels")
        if labels:
            compact["labels"] = labels[:5] if isinstance(labels, list) else labels
        out.append(compact)
    return out


def _compact_matter_for_prompt(m: dict[str, Any]) -> dict[str, Any]:
    # body_preview gives the LLM enough semantic context to route even when
    # routing metadata (domains/persons/orgs/keywords) is bare. Trim to keep
    # the prompt small when there are lots of matters.
    body = str(m.get("body_preview") or "").strip()
    if body.startswith("#"):
        # Drop the leading heading line — redundant with `name`.
        body = "\n".join(body.split("\n")[1:]).strip()
    return {
        "slug": m.get("slug") or (m.get("path", "").split("/")[-1].replace(".md", "")),
        "name": m.get("name", ""),
        "body_preview": body[:400],
        "domains": m.get("domains") or [],
        "related_persons": m.get("related_persons") or [],
        "related_orgs": m.get("related_orgs") or [],
        "keywords": m.get("keywords") or [],
        "parent_matter": m.get("parent_matter") or None,
    }


async def _route_and_triage(
    *, bundle: dict[str, Any], matters: list[dict[str, Any]]
) -> dict[str, Any]:
    """Ask a learn-clerk subagent on workers to route events to matters and
    split attention vs FYI per matter.

    Returns: {
      headline: "one-line most important thing or empty",
      buckets: [
        {
          matter_slug: str or "other",
          matter_name: str,
          attention: list of {subject, from, why_it_needs_attention},
          fyi_count: int
        }
      ],
      calendar_summary: str or null,
      has_any_attention: bool
    }
    """
    compact_events = _compact_events_for_prompt(bundle["events"], max_events=80)
    compact_matters = [_compact_matter_for_prompt(m) for m in matters]
    tasks_due = [
        {
            "name": t.get("name"),
            "due": t.get("due") or t.get("due_date"),
            "matter": t.get("matter") or "",
        }
        for t in bundle["tasks_due_today"][:20]
    ]
    cal = bundle["calendar"]

    prompt = f"""You are Alfred's routing clerk. Produce a structured triage JSON for a daily morning briefing.

## What's in Sir's last 24h
- Stream events: {len(compact_events)} (compact list below)
- Open tasks due within 24h: {len(tasks_due)}
- New observations: {len(bundle['observations_new'])}
- Inbound SMS/voice last 24h: {len(bundle['phone_inbound'])}

## Active matters to route against
{json.dumps(compact_matters, indent=2, default=str)[:4000]}

## Events (compact)
{json.dumps(compact_events, indent=2, default=str)[:8000]}

## Tasks due today
{json.dumps(tasks_due, indent=2, default=str)[:2000]}

## Calendar integration
- Integration available: {cal['integration_available']}
- Events today: {len(cal['events_today'])}
- Events tomorrow: {len(cal['events_tomorrow'])}
{(json.dumps(cal['events_today'][:8], default=str) if cal['events_today'] else "")[:1500]}

## Your task

For each event, decide:
  (a) Which matter it belongs to. Route by SEMANTIC MATCH against the matter's `name` + `body_preview`. If routing metadata (domains / related_persons / related_orgs / keywords) is populated, use it as a fast-path; otherwise use your judgment against the body preview. When nothing convincingly matches, assign "other" — do NOT force a weak match.
  (b) Whether it needs attention. Reason from the SENDER and SUBJECT (plus any summary). Gmail's `labels` field is UNRELIABLE — Gmail often buckets personal human mail under CATEGORY_PROMOTIONS or CATEGORY_UPDATES. Ignore those labels for classification; they are provided for context only.
      ATTENTION = sent by someone OTHER than Sir (not a no-reply/do-not-reply/newsletter/bulk list address, not Sir's own address/sessions/audio, not his own phone transcripts) AND routes to a specific matter bucket (not "other").
        - Human: recognizable first-name + personal-domain or small-business-domain sender. Short personal subject. Conversational tone.
        - NOT human: sender contains `noreply`, `do-not-reply`, `notifications@`, `newsletter@`, `marketing@`, `bounce+`, `hello@`+generic SaaS brand, or is a no-reply-style mass mailing. Subjects like "You have X new notifications", "Your receipt", "We're live in N hours".
        - NEVER an attention item: events originated by Sir himself — his own Slack/Telegram/webchat messages, his own Omi audio transcripts, his own dictations. These are context, not signals. Drop them to FYI bucket "other" silently.
      Borderline but still attention: a personally-addressed message from a human even if Gmail labeled it promotional, even if it's a mass newsletter BUT the sender is someone Sir personally knows and the subject is specific (e.g. "I'm closing my gym in one week" from his actual coach).
      FYI = auto-generated, receipt, billing, marketing, newsletter-broadcast, Sir's own content, or anything routed to "other".
      When in doubt between attention and fyi for a human-sent item on a specific matter: classify as attention. Over-surfacing costs Sir 5 seconds to skim; under-surfacing costs him a missed message.
  (c) One 8-12 word "why_it_needs_attention" note (ONLY for attention items).
      Describe what the item IS and what makes it relevant, not what Sir
      should do about it. E.g. "BakeryNext Q3 packaging reply from Laszlo"
      or "Sean Fagan announces gym closure in one week".

Also produce:
  - `headline`: ONE sentence — the single most important thing Sir should know if he only reads one line. Empty string if nothing urgent.
  - `calendar_summary`: short string describing today's calendar density and notable meetings. Null if integration_available=false.
  - `has_any_attention`: bool

Be brutally honest about silence. It's OK for most matters to have zero attention items. Quiet is fine.

## Output format — RETURN ONLY THIS JSON, NO PREAMBLE

```json
{{
  "headline": "string or empty",
  "calendar_summary": "string or null",
  "has_any_attention": true/false,
  "buckets": [
    {{
      "matter_slug": "avenir-solutions-kft",
      "matter_name": "Avenir Solutions Kft",
      "attention": [
        {{ "subject": "Re: Q3 packaging update", "from": "laszlo@retconline.hu", "why_it_needs_attention": "awaiting yes/no decision by noon" }}
      ],
      "fyi_count": 3
    }},
    {{
      "matter_slug": "other",
      "matter_name": "Other",
      "attention": [],
      "fyi_count": 12
    }}
  ]
}}
```

Only include matter buckets that have content (attention OR fyi_count >= 1). Silent matters are omitted entirely.
"""

    reply = await _workers_spawn_subagent(
        agent_id="learn-clerk",
        prompt=prompt,
        run_timeout_s=360,
        poll_timeout_s=420,
    )
    cleaned = _strip_code_fence(reply)
    try:
        parsed = json.loads(cleaned)
        if not isinstance(parsed, dict):
            raise ValueError("routing output was not a JSON object")
        return parsed
    except Exception as exc:
        activity.logger.warning("route_and_triage: parse failed (%s); raw: %s", exc, reply[:500])
        return {
            "headline": "",
            "calendar_summary": None,
            "has_any_attention": False,
            "buckets": [],
            "_parse_error": str(exc),
            "_raw": reply[:1500],
        }


async def _write_and_deliver_briefing(
    *,
    chore_slug: str,
    session_id: str,
    triage: dict[str, Any],
    bundle: dict[str, Any],
    preview_only: bool,
) -> dict[str, Any]:
    """Ask the main Alfred session to write the briefing and deliver it itself.

    Previous design had a subagent pre-render the briefing and then POST it
    into the main session via sessions_send — which treats the text as a
    USER TURN, so Alfred sees it as a user message and replies "Noted, sir"
    (which is the message that actually lands in Slack). The briefing
    itself never rendered.

    Correct shape: send the structured triage to the main Alfred session as
    an instructional prompt. His response IS the briefing, in his voice,
    on his channel (Slack). No double roundtrip, no reversed role.

    For preview mode we still route through the main session but write the
    reply to a file instead of returning normally — the session_id is set to
    a throwaway preview key so nothing posts to Slack.
    """
    cal_missing_note = ""
    if not bundle["calendar"]["integration_available"]:
        cal_missing_note = (
            "\n\n(Calendar integration is NOT connected — weave ONE short "
            "sentence about reconnecting Google Calendar into the briefing.)"
        )

    prompt = f"""You are Alfred. Write Sir's morning briefing. Your output is posted verbatim to Sir's Slack DM — no preamble, no headers, no meta.

## Voice — butler, not reporter

You are NOT transcribing a newsfeed. You are ALFRED speaking TO Sir, synthesising overnight signals into a handful of observations worth his attention. The difference:

- Wrong (reporter): "Boardy Boardman emails: 'David, putting an ex-Violette CGO on your radar,' introducing the contact for Alfred Product Development."
- Right (butler): "Boardy has an ex-Violette CGO he'd like to put in front of you — worth a quick reply on Alfred Product Development."

Never quote inbound email/chat content verbatim. Never narrate "<person> emails/messages/reports" — that's newsfeed voice. Tell Sir what he should KNOW and why it matters.

## Never do these (anti-patterns from past briefings)

- Do NOT refer to Sir as "Zsolt" or any other name — always "Sir", never a specific first name.
- Do NOT echo Sir's own chat turns, voice notes, or dictations back at him as briefing items. His own content is context, not signal. If the triage JSON somehow includes items originated by Sir himself, drop them silently.
- Do NOT invent items that aren't in the triage JSON. If triage.buckets is empty, say "Nothing overnight, sir. You're clear." and stop.
- Do NOT speak to yourself ("Alfred, reconnect Google Calendar" is wrong — Sir reads this, speak to him: "Worth reconnecting Google Calendar when you get a moment, sir.").
- Do NOT pad. 2-3 tight paragraphs. No lists, no headers, no code fences.

## Structure

Paragraph 1 — headline. One sentence, the single most important thing. If nothing overnight is urgent, say so plainly.

Paragraph 2 (optional, only if there are real attention items) — matter-grouped synthesis. For each matter with attention items, one sentence of "what needs your eyes and why". Group by matter in the same paragraph; don't split.

Paragraph 3 — closing line. Format: "Plus {{N}} FYI items across the board — all safe to archive." Then calendar: "{{events_today_count}} meeting(s) today, {{events_tomorrow_count}} tomorrow." If calendar is disconnected, replace with: "Worth reconnecting Google Calendar when you get a moment, sir." Open tasks due within 24h also go here if any.

## Silence rule

If triage.has_any_attention is false AND tasks_due_today=0 AND events_today=0: reply with EXACTLY "Nothing overnight, sir. You're clear." Nothing else.

## Triage JSON (your only source of truth — do not invent items outside this)

```json
{json.dumps(triage, indent=2, default=str)[:6000]}
```

## Context counts (for the closing line)

- Open tasks due within 24h: {len(bundle['tasks_due_today'])}
- Inbound phone activity last 24h: {len(bundle['phone_inbound'])}
- Calendar integration: {"connected" if bundle["calendar"]["integration_available"] else "DISCONNECTED"}
- Events today: {len(bundle['calendar']['events_today'])}
- Events tomorrow: {len(bundle['calendar']['events_tomorrow'])}
{cal_missing_note}

Write the briefing now. Plain prose. Your output is the message Sir sees."""

    if preview_only:
        # Preview path: re-use the workers subagent so we don't touch the main
        # Slack-connected session. Falls back to a minimal briefing if the
        # subagent flakes.
        briefing = await _workers_spawn_subagent(
            agent_id="learn-clerk",
            prompt=prompt,
            run_timeout_s=180,
            poll_timeout_s=240,
        )
        briefing = (briefing or "").strip() or (
            f"{triage.get('headline', '').strip()}\n\nTriage produced "
            f"{len(triage.get('buckets') or [])} matter buckets."
        )
        os.makedirs(_PREVIEW_OUTPUT_DIR, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
        path = os.path.join(_PREVIEW_OUTPUT_DIR, f"{chore_slug}-{ts}.md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(briefing)
        activity.logger.info("preview written to %s (%d bytes)", path, len(briefing))
        return {"mode": "preview", "path": path, "delivered": False, "briefing": briefing}

    # Live delivery: first render the briefing text via a workers subagent
    # (same as preview mode), then POST the rendered text to ctrl-api's
    # /api/v1/notifications, which pushes it outbound via openclaw's
    # `message.send` tool → Slack/Telegram/etc. The notifications route
    # handles channel + recipient resolution from the tenant's config.
    briefing = await _workers_spawn_subagent(
        agent_id="learn-clerk",
        prompt=prompt,
        run_timeout_s=180,
        poll_timeout_s=240,
    )
    briefing = (briefing or "").strip() or (
        f"{triage.get('headline', '').strip()}\n\nTriage produced "
        f"{len(triage.get('buckets') or [])} matter buckets."
    )
    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    url = f"{config.alfred_ctrl_url}/api/v1/notifications"
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    async with httpx.AsyncClient(timeout=60.0) as http:
        resp = await http.post(
            url,
            json={
                "message": briefing,
                "urgency": "normal",
                "session_id": session_id,
                # agent_id defaults to "main" server-side
            },
            headers=headers,
        )
        status = resp.status_code
    return {"mode": "slack", "path": None, "delivered": status < 400, "http_status": status}


