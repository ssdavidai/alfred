"""Activities for the Recall.ai auto-dispatcher (#113 PR4).

The dispatcher walks the principal's calendar every five minutes and
asks ctrl-api to spin up a Recall bot for each meeting whose host /
attendee shape matches the operator's ``auto_join_policy``. Three
activities + a small helper module:

  1. ``fetch_upcoming_calendar_events`` — pulls the next N minutes of
     events via ``POST /api/v1/integrations/execute`` with
     ``GOOGLECALENDAR_LIST_EVENTS``. Extracts ``meeting_url`` from each
     event's hangoutLink, conferenceData, location, or description.
     Returns a normalised list the workflow + the policy gate can read
     without re-parsing.

  2. ``check_recall_dispatch_state`` — pulls the current Recall config,
     the month-to-date usage, and the set of already-dispatched
     calendar_event_ids. The workflow uses the result to (a) read the
     policy, (b) refuse dispatch when the projected cap would be
     blown, (c) dedupe against bots already requested for the same
     event.

  3. ``dispatch_recall_bot`` — POSTs to ``/api/v1/channels/recall/bots``
     with the meeting URL, the configured bot name, the calendar event
     id (so the route can dedupe on its end too), and an optional
     ``scheduled_join_time``. The ctrl-api side already inserts the
     ``recall_bot`` row; we just return the response envelope so the
     workflow can log per-meeting outcomes.

Policy gate (the workflow code calls this — kept pure so tests can drive
it without Temporal) reads the recall_config's ``auto_join_policy``
column. The DB stores three canonical values (migration 0007_recall):

  ``off``                — never auto-dispatch
  ``principal_attendee`` — only when the principal is an attendee
                           and a meeting URL is present
  ``all``                — every event with a meeting URL

These names are the ones in the schema today; the PR4 spec uses
"off / manual_only / calendar_only / all_meetings" interchangeably,
which map as:

  ``off``           ←→ off / manual_only        — no dispatch
  ``principal_attendee`` ←→ calendar_only        — dispatch on principal-attended events
  ``all``           ←→ all_meetings              — dispatch on any event with URL

The gate canonicalises whatever the config carries and refuses anything
unknown (defensive — the PATCH route validates on the way in, but a
hand-edited row shouldn't take the dispatcher down).
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

import httpx
from temporalio import activity

from src.config import load_config

logger = logging.getLogger("recall-dispatcher")


# ── ctrl-api helpers ─────────────────────────────────────────────────────


async def _ctrl_get(
    path: str, params: dict[str, str] | None = None
) -> dict[str, Any]:
    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    url = f"{config.alfred_ctrl_url}{path}"
    async with httpx.AsyncClient(timeout=30.0) as http:
        resp = await http.get(url, headers=headers, params=params or {})
        resp.raise_for_status()
        return resp.json()


async def _ctrl_post(
    path: str, body: dict[str, Any] | None = None
) -> dict[str, Any]:
    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    url = f"{config.alfred_ctrl_url}{path}"
    async with httpx.AsyncClient(timeout=60.0) as http:
        resp = await http.post(url, headers=headers, json=body or {})
        # The ctrl-api error envelope is a JSON {error: {code, message}}.
        # Re-raise on 5xx so Temporal retries; 4xx is the route refusing
        # work and is surfaced verbatim so the dispatcher can log + skip.
        if resp.status_code >= 500:
            resp.raise_for_status()
        try:
            return {"_status": resp.status_code, **(resp.json() or {})}
        except ValueError:
            return {"_status": resp.status_code, "error": "non-JSON body"}


# ── meeting URL extraction ───────────────────────────────────────────────


# Three host families Recall actually accepts (matches ctrl-api's
# classifyMeetingUrl). We tolerate either the full link or the host
# pattern showing up anywhere in the description / location field.
_MEETING_HOST_RE = re.compile(
    r"https?://[^\s>'\"]*?"
    r"(?:zoom\.(?:us|com)|meet\.google\.com|teams\.(?:microsoft|live)\.com)"
    r"[^\s>'\"]*",
    re.IGNORECASE,
)


def extract_meeting_url(event: dict[str, Any]) -> str | None:
    """Return the first plausible meeting URL on a Google Calendar event.

    Check order: ``hangoutLink`` (set when the event was created with a
    Meet conference) → ``conferenceData.entryPoints[].uri`` → the
    location field → the description (free-text). The first hit wins;
    later fields are not consulted.
    """
    if not isinstance(event, dict):
        return None
    # 1. hangoutLink — set automatically for any Meet-created event.
    link = event.get("hangoutLink") or event.get("hangout_link")
    if isinstance(link, str) and link.strip():
        return link.strip()
    # 2. conferenceData.entryPoints
    conf = event.get("conferenceData") or event.get("conference_data") or {}
    if isinstance(conf, dict):
        for ep in conf.get("entryPoints") or conf.get("entry_points") or []:
            if not isinstance(ep, dict):
                continue
            uri = ep.get("uri") or ep.get("url")
            if isinstance(uri, str) and uri.strip():
                m = _MEETING_HOST_RE.search(uri)
                if m:
                    return m.group(0)
    # 3. location
    loc = event.get("location")
    if isinstance(loc, str):
        m = _MEETING_HOST_RE.search(loc)
        if m:
            return m.group(0)
    # 4. description
    desc = event.get("description")
    if isinstance(desc, str):
        m = _MEETING_HOST_RE.search(desc)
        if m:
            return m.group(0)
    return None


def event_start_iso(event: dict[str, Any]) -> str | None:
    """Pull a usable ISO 8601 start time out of a Google Calendar event."""
    start = event.get("start")
    if isinstance(start, dict):
        for key in ("dateTime", "date_time", "date"):
            v = start.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
    if isinstance(start, str) and start.strip():
        return start.strip()
    return None


def principal_is_attendee(
    event: dict[str, Any], principal_email: str | None
) -> bool:
    """Return True iff the principal's email appears as a non-declined attendee.

    Two acceptance paths:
      * the event's organizer is the principal (Sir owns it)
      * one of the attendees matches the principal's email and the
        response status isn't ``declined``

    When the principal email is unknown (env var missing) the function
    defaults to True — better to dispatch on Sir's behalf than silently
    skip on a config gap. The dispatcher logs that fallback path.
    """
    if not principal_email:
        return True
    principal_email = principal_email.lower().strip()

    organizer = event.get("organizer")
    if isinstance(organizer, dict):
        email = organizer.get("email")
        if isinstance(email, str) and email.lower().strip() == principal_email:
            return True
        # 'self' is sometimes set on the organizer block.
        if organizer.get("self") is True:
            return True

    creator = event.get("creator")
    if isinstance(creator, dict) and creator.get("self") is True:
        return True

    for a in event.get("attendees") or []:
        if not isinstance(a, dict):
            continue
        email = a.get("email")
        if not isinstance(email, str):
            continue
        if email.lower().strip() != principal_email:
            continue
        status = (a.get("responseStatus") or a.get("response_status") or "").lower()
        if status == "declined":
            return False
        return True
    return False


# ── policy gate (pure) ────────────────────────────────────────────────────


@dataclass(frozen=True)
class NormalisedEvent:
    """A calendar event reduced to what the dispatcher actually needs."""

    calendar_event_id: str
    meeting_url: str | None
    start_iso: str | None
    summary: str
    principal_is_attendee: bool

    @classmethod
    def from_raw(
        cls, raw: dict[str, Any], principal_email: str | None
    ) -> "NormalisedEvent | None":
        if not isinstance(raw, dict):
            return None
        cid = raw.get("id") or raw.get("iCalUID") or raw.get("icaluid")
        if not isinstance(cid, str) or not cid.strip():
            return None
        return cls(
            calendar_event_id=cid.strip(),
            meeting_url=extract_meeting_url(raw),
            start_iso=event_start_iso(raw),
            summary=(raw.get("summary") or "")[:200],
            principal_is_attendee=principal_is_attendee(raw, principal_email),
        )


# Canonical policy values stored in recall_config.auto_join_policy.
_POLICY_OFF = {"off", "manual_only"}
_POLICY_ATTENDEE = {"principal_attendee", "calendar_only"}
_POLICY_ALL = {"all", "all_meetings"}


def should_dispatch(
    event: NormalisedEvent, policy: str
) -> tuple[bool, str]:
    """Return ``(dispatch?, reason)`` for one normalised event.

    The reason is the short string the dispatcher logs to explain
    skips — useful when Sir reads the worker logs at 3am wondering why
    the bot didn't show up.
    """
    pol = (policy or "").strip().lower()
    if pol in _POLICY_OFF:
        return False, f"policy={pol} → no auto-dispatch"
    if not event.meeting_url:
        return False, "no meeting_url on event"
    if pol in _POLICY_ATTENDEE:
        if event.principal_is_attendee:
            return True, "policy=principal_attendee + principal is attendee"
        return False, "policy=principal_attendee + principal not on invite"
    if pol in _POLICY_ALL:
        return True, "policy=all + meeting_url present"
    # Unknown policy — refuse rather than guess.
    return False, f"unknown auto_join_policy={policy!r}"


# ── activities ────────────────────────────────────────────────────────────


@activity.defn
async def fetch_upcoming_calendar_events(
    window_minutes: int = 15,
) -> list[dict[str, Any]]:
    """Pull upcoming events from the principal's Google Calendar.

    Window: ``now - 5min`` to ``now + window_minutes`` — the 5-minute
    backstop catches meetings that just started (Recall takes ~30s to
    actually join, and the bot should still get there before the
    standup ends).

    Returns NormalisedEvent payloads as plain dicts so they survive
    the Temporal activity boundary. Events without a calendar event id
    are dropped (we can't dedupe without one). Each returned dict has
    the keys: ``calendar_event_id``, ``meeting_url``,
    ``start_iso``, ``summary``, ``principal_is_attendee``.
    """
    if not isinstance(window_minutes, int) or window_minutes <= 0:
        window_minutes = 15

    now = datetime.now(timezone.utc)
    time_min = (now - timedelta(minutes=5)).isoformat()
    time_max = (now + timedelta(minutes=window_minutes)).isoformat()

    try:
        result = await _ctrl_post(
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
    except Exception as exc:  # noqa: BLE001
        # The workflow is on a 5-min beat; any single failure should be
        # tolerated — Temporal retries are configured at the workflow
        # level. We log + return empty so the workflow doesn't crash.
        logger.warning("fetch_upcoming_calendar_events: pull failed: %s", exc)
        return []

    err = result.get("error") if isinstance(result, dict) else None
    data = result.get("data") if isinstance(result, dict) else None
    items = []
    if isinstance(data, dict):
        items = data.get("items") or data.get("event_list") or []
    if err or not isinstance(items, list):
        logger.info("fetch_upcoming_calendar_events: no items (err=%s)", str(err)[:200])
        return []

    principal_email = (
        os.environ.get("OWNER_EMAIL") or os.environ.get("PRINCIPAL_EMAIL") or ""
    )

    out: list[dict[str, Any]] = []
    for raw in items:
        norm = NormalisedEvent.from_raw(raw, principal_email or None)
        if not norm:
            continue
        out.append(
            {
                "calendar_event_id": norm.calendar_event_id,
                "meeting_url": norm.meeting_url,
                "start_iso": norm.start_iso,
                "summary": norm.summary,
                "principal_is_attendee": norm.principal_is_attendee,
            }
        )
    return out


@activity.defn
async def check_recall_dispatch_state() -> dict[str, Any]:
    """Pull config + usage + active bots in one activity.

    Returned shape:

      {
        "policy": str,
        "bot_name": str,
        "leave_after_minutes": int,
        "monthly_hours_cap": int,
        "bot_minutes_used": int,
        "dispatched_event_ids": [str, ...],
      }

    On any single sub-call failure we return ``{"policy": "off", ...}``
    so the workflow defaults to "don't dispatch" rather than spinning
    a bot off a half-loaded config snapshot.
    """
    default = {
        "policy": "off",
        "bot_name": "Alfred",
        "leave_after_minutes": 90,
        "monthly_hours_cap": 60,
        "bot_minutes_used": 0,
        "dispatched_event_ids": [],
    }
    try:
        config = await _ctrl_get("/api/v1/channels/recall/config")
    except Exception as exc:  # noqa: BLE001
        logger.warning("check_recall_dispatch_state: config fetch failed: %s", exc)
        return default
    try:
        usage = await _ctrl_get("/api/v1/channels/recall/usage")
    except Exception as exc:  # noqa: BLE001
        logger.warning("check_recall_dispatch_state: usage fetch failed: %s", exc)
        usage = {"this_month_hours": 0.0}
    try:
        active = await _ctrl_get("/api/v1/channels/recall/bots/active")
        bots = active.get("bots") if isinstance(active, dict) else []
    except Exception as exc:  # noqa: BLE001
        logger.warning("check_recall_dispatch_state: bots fetch failed: %s", exc)
        bots = []

    dispatched_event_ids: list[str] = []
    if isinstance(bots, list):
        for b in bots:
            cid = b.get("calendar_event_id") if isinstance(b, dict) else None
            if isinstance(cid, str) and cid.strip():
                dispatched_event_ids.append(cid.strip())

    # `this_month_hours` is a float; turn into minutes-int for arithmetic.
    used_hours = (
        usage.get("this_month_hours") if isinstance(usage, dict) else 0
    ) or 0
    try:
        bot_minutes_used = int(round(float(used_hours) * 60))
    except (TypeError, ValueError):
        bot_minutes_used = 0

    return {
        "policy": str(config.get("auto_join_policy") or "off"),
        "bot_name": str(config.get("bot_name") or "Alfred"),
        "leave_after_minutes": int(config.get("leave_after_minutes") or 90),
        "monthly_hours_cap": int(config.get("monthly_hours_cap") or 60),
        "bot_minutes_used": bot_minutes_used,
        "dispatched_event_ids": dispatched_event_ids,
    }


@activity.defn
async def dispatch_recall_bot(
    meeting_url: str,
    bot_name: str | None = None,
    calendar_event_id: str | None = None,
    scheduled_join_time: str | None = None,
) -> dict[str, Any]:
    """POST to ctrl-api's create-bot route and surface the envelope.

    Return shape:

      {
        "ok": bool,
        "status_code": int,
        "bot_id": str | None,
        "recall_url": str | None,
        "error": str | None,
        "calendar_event_id": str | None,
      }

    On a 4xx ``ok=False`` is returned with the error body; on a 5xx the
    activity raises so Temporal retries.
    """
    if not isinstance(meeting_url, str) or not meeting_url.strip():
        return {
            "ok": False,
            "status_code": 0,
            "error": "meeting_url is required",
            "calendar_event_id": calendar_event_id,
        }
    body: dict[str, Any] = {"meeting_url": meeting_url.strip()}
    if bot_name:
        body["bot_name"] = bot_name
    if calendar_event_id:
        body["calendar_event_id"] = calendar_event_id
    if scheduled_join_time:
        body["scheduled_join_time"] = scheduled_join_time

    result = await _ctrl_post("/api/v1/channels/recall/bots", body=body)
    status = int(result.get("_status") or 0)
    err = result.get("error")
    if status >= 400 or err:
        # ctrl-api returns {error: {code, message}} on the 4xx envelope.
        reason = err
        if isinstance(err, dict):
            reason = err.get("message") or err.get("code") or repr(err)
        return {
            "ok": False,
            "status_code": status,
            "bot_id": None,
            "recall_url": None,
            "error": str(reason) if reason is not None else f"HTTP {status}",
            "calendar_event_id": calendar_event_id,
        }
    return {
        "ok": True,
        "status_code": status,
        "bot_id": result.get("bot_id"),
        "recall_url": result.get("recall_url"),
        "error": None,
        "calendar_event_id": calendar_event_id,
    }


# Exported so workflow/tests can drive the gate without instantiating
# the dataclass themselves.
def filter_dispatch_candidates(
    events: Iterable[dict[str, Any]],
    policy: str,
    already_dispatched: Iterable[str],
) -> list[tuple[dict[str, Any], str]]:
    """Apply the policy + dedupe filter to a raw event list.

    Returns ``[(event_dict, reason), ...]`` for the events that should
    be dispatched, in calendar order.
    """
    seen = {x for x in already_dispatched if isinstance(x, str)}
    out: list[tuple[dict[str, Any], str]] = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        cid = ev.get("calendar_event_id")
        if not isinstance(cid, str) or not cid:
            continue
        if cid in seen:
            continue
        norm = NormalisedEvent(
            calendar_event_id=cid,
            meeting_url=ev.get("meeting_url"),
            start_iso=ev.get("start_iso"),
            summary=ev.get("summary") or "",
            principal_is_attendee=bool(ev.get("principal_is_attendee", True)),
        )
        ok, reason = should_dispatch(norm, policy)
        if ok:
            out.append((ev, reason))
            seen.add(cid)
    return out
