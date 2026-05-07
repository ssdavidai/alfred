"""Transcript intake activities for Steward Phase 4 (#840).

Backs the ``MeetingCaptureWorkflow`` and ``TranscriptIntakeWorkflow`` —
calendar-driven Vexa bot dispatch + post-meeting transcript ingestion +
LLM-extracted action-item proposals that flow back into Steward as
induced signals.

Architecture (per RFC #832 §8):

  1. Calendar stream (``composio-googlecalendar.jsonl`` or similar)
     emits gcal events to ctrl-api.
  2. ``MeetingCaptureWorkflow`` polls the stream every 60s, finds
     events where Sir is an attendee + a Meet URL is detected, and
     calls ``vexa_join_meeting`` to schedule the bot.
  3. Vexa bot joins as ``Alfred``, transcribes via Groq Whisper, and
     POSTs a ``meeting.completed`` webhook to ctrl-api at
     ``/api/v1/webhooks/vexa``. The webhook handler appends a record
     to ``streams/vexa-transcripts.jsonl``.
  4. ``TranscriptIntakeWorkflow`` polls the transcript stream every
     60s, calls ``vexa_get_transcript`` for any unprocessed transcript
     completion event, runs ``extract_actions_from_transcript``, and
     emits one Steward signal per candidate via
     ``apply_transcript_action``.

Hard rules (mirroring src/activities/steward.py):

  * All LLM calls go through OpenClaw via ``clerk._call_clerk``.
  * All vault writes go through ctrl-api via ``VaultClient``.
  * Filesystem writes are limited to ``/alfred-data/state/steward/`` —
    state files we own.
  * NO direct Plane writes from this module — every action becomes a
    Steward signal of kind ``transcript:action_candidate`` and lands
    via ``apply_transcript_action`` (which writes to the same
    ``streams/steward-signals.jsonl`` stream the Plane handler uses).
    Phase 3's ``apply_state_change`` gets a code path for those
    signals when it goes live.

Vexa API surface (verified against upstream tag ``vexa-0.10.6``):

  * ``POST /bots`` — start a bot. Body
    ``{"platform": "google_meet", "native_meeting_id": "<abc-defg-hij>",
      "bot_name": "Alfred", "language": "en", "task": "transcribe"}``.
    Idempotent: re-requesting an already-joined meeting returns the
    existing meeting record without spawning a duplicate bot.
  * ``GET /transcripts/{platform}/{native_meeting_id}`` — retrieve the
    full transcript for a meeting.
  * ``DELETE /bots/{platform}/{native_meeting_id}`` — stop a bot.

Auth: ``X-API-Key: <VEXA_API_KEY>`` header on every call.
Default base URL: ``http://vexa-api-gateway:8000`` inside the compose
network (or ``http://127.0.0.1:18056`` from outside via the published
host port). Configurable via ``VEXA_API_URL``.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.jsonl import append_jsonl

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Inside the compose network the Vexa stack exposes ``api-gateway`` on
# its container port 8000. We give it the host alias ``vexa-api-gateway``
# in our compose so the env can stay stable across deployments. Default
# resolves to the same path the docker-compose service block writes.
DEFAULT_VEXA_API_URL = "http://vexa-api-gateway:8000"
VEXA_TRANSCRIPTS_STREAM = "vexa-transcripts.jsonl"

# State file: meeting-schedule dedupe map. One record per (platform, meeting_id)
# pair that we've already asked Vexa to join. Idempotency is ALSO enforced
# by Vexa (re-requesting a meeting returns the existing record), but we
# track locally so the workflow's per-tick logging stays clean.
_MEETING_SCHEDULE_STATE_FILENAME = "meeting-schedules.json"


def _meeting_schedule_state_path(cfg) -> str:
    return os.path.join(
        cfg.alfred_data_dir, "state", "steward", _MEETING_SCHEDULE_STATE_FILENAME,
    )


def _read_meeting_schedule_state(cfg) -> dict[str, Any]:
    path = _meeting_schedule_state_path(cfg)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("transcript.meeting_state: read failed path=%s err=%s", path, exc)
        return {}


def _write_meeting_schedule_state(cfg, state: dict[str, Any]) -> None:
    path = _meeting_schedule_state_path(cfg)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, sort_keys=True, default=str)
        os.replace(tmp, path)
    except OSError as exc:
        logger.warning("transcript.meeting_state: write failed path=%s err=%s", path, exc)


def _vexa_api_url() -> str:
    return os.environ.get("VEXA_API_URL", DEFAULT_VEXA_API_URL).rstrip("/")


def _vexa_api_key() -> str:
    return os.environ.get("VEXA_API_KEY", "").strip()


def _vexa_headers() -> dict[str, str]:
    """Build the auth header set Vexa expects on every call.

    Vexa's api-gateway accepts ``X-API-Key`` for client operations; that
    is the only header we need for the endpoints we call. The token is
    provisioned by the operator and flows in via ``VEXA_API_KEY``.
    """
    api_key = _vexa_api_key()
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["X-API-Key"] = api_key
    return headers


def _now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Google Meet URL extraction
# ---------------------------------------------------------------------------

# Google Meet URLs in calendar events come in two surfaces:
#   * ``conferenceData.entryPoints[].uri`` (canonical, set when the
#     organiser added Meet via Calendar).
#   * Plain text inside ``location`` or ``description`` (when an external
#     Meet link was pasted in).
# Both round-trip through the gcal stream payload as raw JSON. The native
# Meet code is the trailing path component (e.g. ``abc-defg-hij``) — that's
# what Vexa wants as ``native_meeting_id``.

_MEET_URL_RE = re.compile(
    r"https?://meet\.google\.com/(?P<code>[a-z0-9\-]+)",
    re.IGNORECASE,
)


def extract_meet_native_id(gcal_event: dict[str, Any]) -> tuple[str, str]:
    """Return ``(meet_url, native_meeting_id)`` or ``("", "")`` if absent.

    Inspects:
      1. ``conferenceData.entryPoints[*].uri`` (and ``entryPointType=video``)
      2. ``hangoutLink`` (legacy field still emitted on some events)
      3. ``location``
      4. ``description``
    """
    cd = gcal_event.get("conferenceData") or {}
    entry_points = cd.get("entryPoints") if isinstance(cd, dict) else None
    if isinstance(entry_points, list):
        # Prefer the explicit "video" entry point.
        candidates_video = [
            ep for ep in entry_points
            if isinstance(ep, dict) and (ep.get("entryPointType") or "").lower() == "video"
        ]
        candidates_other = [
            ep for ep in entry_points
            if isinstance(ep, dict) and (ep.get("entryPointType") or "").lower() != "video"
        ]
        for ep in [*candidates_video, *candidates_other]:
            uri = ep.get("uri")
            if isinstance(uri, str):
                m = _MEET_URL_RE.search(uri)
                if m:
                    return uri, m.group("code")

    hangout = gcal_event.get("hangoutLink")
    if isinstance(hangout, str):
        m = _MEET_URL_RE.search(hangout)
        if m:
            return hangout, m.group("code")

    location = gcal_event.get("location")
    if isinstance(location, str):
        m = _MEET_URL_RE.search(location)
        if m:
            return f"https://meet.google.com/{m.group('code')}", m.group("code")

    description = gcal_event.get("description")
    if isinstance(description, str):
        m = _MEET_URL_RE.search(description)
        if m:
            return f"https://meet.google.com/{m.group('code')}", m.group("code")

    return "", ""


def is_sir_attendee(gcal_event: dict[str, Any], owner_email: str) -> bool:
    """True if ``owner_email`` appears in ``attendees[]`` (case-insensitive).

    Falls back to ``creator.email`` / ``organizer.email`` so a Sir-owned
    one-on-one with no explicit attendee list still qualifies. No-attendee
    events (one-attendee solo blocks Sir creates for himself) are still
    real meetings he might want transcribed.
    """
    if not owner_email:
        return True  # operator hasn't pinned ownership; assume yes
    target = owner_email.lower().strip()
    attendees = gcal_event.get("attendees")
    if isinstance(attendees, list):
        for a in attendees:
            if not isinstance(a, dict):
                continue
            email = a.get("email")
            if isinstance(email, str) and email.lower().strip() == target:
                return True
    # Solo events (no attendee list) — check creator/organizer.
    creator = gcal_event.get("creator")
    if isinstance(creator, dict):
        email = creator.get("email")
        if isinstance(email, str) and email.lower().strip() == target:
            return True
    organizer = gcal_event.get("organizer")
    if isinstance(organizer, dict):
        email = organizer.get("email")
        if isinstance(email, str) and email.lower().strip() == target:
            return True
    return False


# ---------------------------------------------------------------------------
# Activity: vexa_join_meeting
# ---------------------------------------------------------------------------

@activity.defn
async def vexa_join_meeting(
    meeting_id: str,
    meet_url: str,
    scheduled_start_iso: str,
) -> dict[str, Any]:
    """Schedule the Vexa bot to join a Google Meet at ``scheduled_start_iso``.

    Idempotent. Vexa's ``POST /bots`` endpoint short-circuits on a
    duplicate ``(platform, native_meeting_id)`` pair — re-requesting an
    already-active meeting returns the existing record. We additionally
    record successful schedules in
    ``/alfred-data/state/steward/meeting-schedules.json`` so the
    workflow's per-tick log stays clean.

    Args:
        meeting_id: Vexa's ``native_meeting_id`` (the Google Meet code,
            e.g. ``"abc-defg-hij"``). Extracted from the gcal event by
            ``extract_meet_native_id``.
        meet_url: Full ``https://meet.google.com/<code>`` URL — recorded
            in the state file for human-readable logs.
        scheduled_start_iso: ISO-8601 start time of the meeting. Vexa's
            current API joins immediately on POST and stays until the
            meeting ends — there is no separate "schedule for later"
            primitive in the public surface — so we treat this as
            advisory metadata. The workflow handles the timing by
            calling this activity at meeting start (we deliberately
            wait inside the workflow loop rather than inside Vexa).

    Returns::

        {
            "platform":          "google_meet",
            "native_meeting_id": "abc-defg-hij",
            "meet_url":          "https://meet.google.com/abc-defg-hij",
            "scheduled_start":   "2026-05-04T15:00:00+00:00",
            "vexa_meeting_id":   <int|str>,    # Vexa's internal id (DB pk)
            "vexa_status":       "requested" | "joining" | "active" | ...,
            "skipped":           bool,         # true when already scheduled
            "skipped_reason":    str,          # populated when skipped
        }

    Raises ``httpx.HTTPError`` on transport failure — Temporal's retry
    policy handles it.
    """
    if not meeting_id:
        return {"skipped": True, "skipped_reason": "empty_meeting_id"}

    cfg = load_config()
    state = _read_meeting_schedule_state(cfg)
    # Dedup must distinguish meeting INSTANCES, not just meet codes —
    # recurring/back-to-back meetings reuse the same Google Meet link
    # (native_meeting_id), so keying solely on the code makes the
    # second instance get skipped as "already dispatched".
    state_key = f"google_meet:{meeting_id}:{scheduled_start_iso}"

    # Local dedupe: if we've already POSTed this meeting and Vexa
    # accepted, skip the round-trip.
    existing = state.get(state_key)
    if isinstance(existing, dict) and existing.get("dispatched"):
        logger.info(
            "transcript.vexa_join_meeting: meeting=%s already dispatched at %s — skipping",
            meeting_id, existing.get("dispatched_at"),
        )
        return {
            "platform": "google_meet",
            "native_meeting_id": meeting_id,
            "meet_url": existing.get("meet_url") or meet_url,
            "scheduled_start": scheduled_start_iso,
            "vexa_meeting_id": existing.get("vexa_meeting_id") or "",
            "vexa_status": existing.get("vexa_status") or "",
            "skipped": True,
            "skipped_reason": "already_dispatched",
        }

    api_url = _vexa_api_url()
    headers = _vexa_headers()
    if not _vexa_api_key():
        logger.warning(
            "transcript.vexa_join_meeting: VEXA_API_KEY unset — bot dispatch will likely 401",
        )

    payload = {
        "platform": "google_meet",
        "native_meeting_id": meeting_id,
        "bot_name": os.environ.get("VEXA_BOT_DISPLAY_NAME", "Alfred"),
        "language": "en",
        "task": "transcribe",
    }

    async with httpx.AsyncClient(timeout=30.0, headers=headers) as client:
        resp = await client.post(f"{api_url}/bots", json=payload)
        if resp.status_code == 409:
            # Vexa returns 409 for "bot already running for this meeting"
            # in some builds — treat as success + cache.
            body: dict[str, Any] = {}
            try:
                body = resp.json()
            except (json.JSONDecodeError, ValueError):
                pass
            vexa_meeting_id = body.get("id") or body.get("meeting_id") or ""
            vexa_status = body.get("status") or "active"
            state[state_key] = {
                "dispatched": True,
                "dispatched_at": _now_utc_iso(),
                "scheduled_start": scheduled_start_iso,
                "meet_url": meet_url,
                "vexa_meeting_id": vexa_meeting_id,
                "vexa_status": vexa_status,
            }
            _write_meeting_schedule_state(cfg, state)
            logger.info(
                "transcript.vexa_join_meeting: meeting=%s already_running (409) — cached",
                meeting_id,
            )
            return {
                "platform": "google_meet",
                "native_meeting_id": meeting_id,
                "meet_url": meet_url,
                "scheduled_start": scheduled_start_iso,
                "vexa_meeting_id": vexa_meeting_id,
                "vexa_status": vexa_status,
                "skipped": True,
                "skipped_reason": "vexa_already_running",
            }
        resp.raise_for_status()
        body = resp.json() if resp.content else {}

    vexa_meeting_id = body.get("id") or body.get("meeting_id") or ""
    vexa_status = body.get("status") or "requested"

    state[state_key] = {
        "dispatched": True,
        "dispatched_at": _now_utc_iso(),
        "scheduled_start": scheduled_start_iso,
        "meet_url": meet_url,
        "vexa_meeting_id": vexa_meeting_id,
        "vexa_status": vexa_status,
    }
    _write_meeting_schedule_state(cfg, state)

    logger.info(
        "transcript.vexa_join_meeting: meeting=%s dispatched vexa_id=%s status=%s",
        meeting_id, vexa_meeting_id, vexa_status,
    )
    return {
        "platform": "google_meet",
        "native_meeting_id": meeting_id,
        "meet_url": meet_url,
        "scheduled_start": scheduled_start_iso,
        "vexa_meeting_id": vexa_meeting_id,
        "vexa_status": vexa_status,
        "skipped": False,
        "skipped_reason": "",
    }


# ---------------------------------------------------------------------------
# Activity: vexa_get_transcript
# ---------------------------------------------------------------------------

@activity.defn
async def vexa_get_transcript(
    platform: str,
    native_meeting_id: str,
) -> dict[str, Any]:
    """Fetch the final transcript for a completed Vexa meeting.

    Calls ``GET /transcripts/{platform}/{native_meeting_id}`` on Vexa's
    api-gateway. Returns the upstream response shape verbatim plus a
    convenience ``flat_text`` field — a newline-joined ``"<speaker>:
    <text>"`` rendering ready for LLM consumption.

    Returns::

        {
            "platform":          str,
            "native_meeting_id": str,
            "segments":          [{"speaker", "text", "start", "end", ...}, ...],
            "speakers":          [str, ...],
            "duration_seconds":  float,
            "flat_text":         str,
            "raw":               <full upstream JSON>,
        }

    Raises ``httpx.HTTPError`` on transport / 4xx / 5xx — Temporal
    retries.
    """
    if not platform or not native_meeting_id:
        raise ValueError(
            "vexa_get_transcript requires both platform and native_meeting_id",
        )

    api_url = _vexa_api_url()
    headers = _vexa_headers()

    async with httpx.AsyncClient(timeout=60.0, headers=headers) as client:
        resp = await client.get(
            f"{api_url}/transcripts/{platform}/{native_meeting_id}"
        )
        resp.raise_for_status()
        body = resp.json() if resp.content else {}

    # Vexa's TranscriptionResponse shape (from
    # services/meeting-api/meeting_api/schemas.py):
    #
    #   {
    #     "id": <meeting db id>,
    #     "platform": ...,
    #     "native_meeting_id": ...,
    #     "segments": [
    #       {"start_time": float, "end_time": float, "text": str,
    #        "speaker": str, "language": str, ...},
    #       ...
    #     ],
    #     ...
    #   }
    #
    # Older builds nest segments under "transcript.segments". We tolerate
    # both shapes.
    segments = body.get("segments")
    if not isinstance(segments, list):
        nested = body.get("transcript")
        if isinstance(nested, dict) and isinstance(nested.get("segments"), list):
            segments = nested["segments"]
        else:
            segments = []

    norm_segments: list[dict[str, Any]] = []
    speakers: set[str] = set()
    duration = 0.0
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        speaker = str(seg.get("speaker") or "").strip()
        if not speaker:
            speaker = "Unknown"
        text = str(seg.get("text") or "").strip()
        try:
            start = float(seg.get("start_time", seg.get("start") or 0.0) or 0.0)
        except (TypeError, ValueError):
            start = 0.0
        try:
            end = float(seg.get("end_time", seg.get("end") or 0.0) or 0.0)
        except (TypeError, ValueError):
            end = 0.0
        if end > duration:
            duration = end
        speakers.add(speaker)
        norm_segments.append({
            "speaker": speaker,
            "text": text,
            "start": start,
            "end": end,
        })

    flat_lines = []
    for seg in norm_segments:
        if seg["text"]:
            flat_lines.append(f'{seg["speaker"]}: {seg["text"]}')
    flat_text = "\n".join(flat_lines)

    logger.info(
        "transcript.vexa_get_transcript: platform=%s meeting=%s segments=%d speakers=%d duration=%.1fs",
        platform, native_meeting_id, len(norm_segments), len(speakers), duration,
    )

    return {
        "platform": platform,
        "native_meeting_id": native_meeting_id,
        "segments": norm_segments,
        "speakers": sorted(speakers),
        "duration_seconds": duration,
        "flat_text": flat_text,
        "raw": body,
    }


# ---------------------------------------------------------------------------
# Activity: extract_actions_from_transcript
# ---------------------------------------------------------------------------

# Allow-list of action types — any LLM hallucination outside this set is
# dropped on validate. Mirrors the strict-decision approach in
# steward._validate_evaluate_state_response.
_ALLOWED_ACTION_TYPES = ("create_task", "update_task", "comment_on_matter")

# Hard cap on candidates per transcript. Even a 90-min meeting touching
# 10 matters shouldn't yield more than this; truncation is preferable to
# a runaway audit pass.
_MAX_CANDIDATES_PER_TRANSCRIPT = 30


def _build_extract_actions_prompt(
    transcript_text: str,
    attendees: list[str],
    gcal_event: dict[str, Any],
    *,
    stricter: bool = False,
) -> str:
    """Build the action-extraction prompt for the Clerk.

    Mirrors the JSON-strict pattern in ``steward._build_evaluate_state_prompt``
    so the same dual-attempt validation harness applies (one normal
    attempt + one stricter retry on malformed first response).
    """
    title = gcal_event.get("summary") or gcal_event.get("title") or "(untitled meeting)"
    description = gcal_event.get("description") or ""
    if isinstance(description, str) and len(description) > 800:
        description = description[:800] + "…"

    start = gcal_event.get("start") or {}
    if isinstance(start, dict):
        start_disp = start.get("dateTime") or start.get("date") or ""
    else:
        start_disp = ""

    # Cap transcript text — typical 30-min meetings produce ~5K tokens of
    # plain text, well within Clerk envelope. We cap defensively at ~12K
    # chars so a runaway 4-hour standup doesn't bust the prompt budget.
    cap_chars = 60_000
    truncated = False
    if len(transcript_text) > cap_chars:
        transcript_text = transcript_text[:cap_chars] + "\n\n[…transcript truncated…]"
        truncated = True

    attendees_disp = ", ".join(attendees) if attendees else "(unknown)"

    header = ""
    if stricter:
        header = (
            "RETRY NOTICE: your previous response was not valid JSON or "
            "was missing required keys. Return ONLY a JSON object with a "
            "top-level ``actions`` array — no markdown, no prose, no "
            "commentary. Every key listed below is REQUIRED on each "
            "action.\n\n"
        )

    schema_hint = ""
    if stricter:
        schema_hint = (
            "\n\nFOR REFERENCE, a minimal valid response with zero actions "
            "looks like:\n"
            '{"actions": []}\n\n'
            "And with one action:\n"
            "{\n"
            '  "actions": [\n'
            "    {\n"
            '      "action_type": "create_task",\n'
            '      "parent_matter": "matter/inbox.md",\n'
            '      "title": "Follow up on pricing",\n'
            '      "body": "Decide pricing tier by Friday — Alex requested.",\n'
            '      "target_path": "",\n'
            '      "patch": {},\n'
            '      "confidence": 0.7,\n'
            '      "evidence_speaker": "Alex Chen",\n'
            '      "evidence_quote": "Can we lock in the pricing tier this week?"\n'
            "    }\n"
            "  ]\n"
            "}\n"
        )

    truncation_note = ""
    if truncated:
        truncation_note = (
            "\nNOTE: the transcript below was truncated to fit the prompt "
            "budget. Focus your extraction on what's present.\n"
        )

    prompt = f"""{header}You are Steward's transcript-action extractor. You read a meeting transcript and propose action items as candidate Steward signals.

MEETING: {title}
START: {start_disp}
ATTENDEES: {attendees_disp}

DESCRIPTION:
{description}
{truncation_note}
TRANSCRIPT:
{transcript_text}

Your job: extract concrete, actionable items from the transcript. Each action proposes ONE of three things:

  - "create_task": a brand-new task should be created (something Sir or another attendee committed to do).
  - "update_task": an existing task in vault should be modified (state change, due-date update, body addendum).
  - "comment_on_matter": a non-task observation should be appended to a matter's record (e.g. "Alex mentioned competitor X is dropping prices — context for matter/competitive-positioning").

Multi-matter spanning is supported: one transcript can produce N actions across N matters. Propose them all in the ``actions`` array.

For EACH action emit:
  - ``action_type``:        one of "create_task" | "update_task" | "comment_on_matter".
  - ``parent_matter``:      best-guess matter slug as ``"matter/<slug>.md"``. Use ``"matter/inbox.md"`` if unsure.
  - ``title``:              required for create_task; concise imperative phrasing.
  - ``body``:               required for create_task and comment_on_matter; brief one-paragraph context.
  - ``target_path``:        required for update_task; e.g. ``"task/foo.md"``.
  - ``patch``:              required for update_task; dict of frontmatter keys → new values, e.g. ``{{"state": "done"}}``.
  - ``confidence``:         0.0..1.0. 1.0 = explicit verbal commitment ("I'll send the invoice today"); 0.5 = implied ("we should figure that out"); <0.3 = speculative — still emit, but Phase 3 will land it as ``pending_confirmation``.
  - ``evidence_speaker``:   the attendee who said the load-bearing line.
  - ``evidence_quote``:     one direct sentence from the transcript that anchors the proposal.

Skip noise: small-talk, scheduling, "let me find that document" — only items with a clear "someone will do something" or "this changed" signal.

Return ONLY valid JSON matching this schema:
{{
  "actions": [
    {{
      "action_type": "create_task" | "update_task" | "comment_on_matter",
      "parent_matter": "matter/<slug>.md",
      "title": "<for create_task only>",
      "body": "<for create_task and comment_on_matter>",
      "target_path": "<for update_task only>",
      "patch": {{ "<key>": "<value>" }},
      "confidence": 0.0..1.0,
      "evidence_speaker": "<speaker name>",
      "evidence_quote": "<one sentence>"
    }}
  ]
}}{schema_hint}

If the transcript contains no actionable items, return ``{{"actions": []}}``.

Return JSON only. No prose."""
    return prompt


def _validate_extracted_actions(raw: Any) -> list[dict[str, Any]]:
    """Validate + normalise a clerk response against the action-extract schema.

    Returns a list of cleaned action dicts (possibly empty). Drops
    individual malformed entries instead of failing the whole batch — a
    single hallucinated action shouldn't block the rest from flowing
    into Steward.
    """
    if not isinstance(raw, dict):
        return []
    actions_raw = raw.get("actions")
    if not isinstance(actions_raw, list):
        return []
    out: list[dict[str, Any]] = []
    for a in actions_raw[:_MAX_CANDIDATES_PER_TRANSCRIPT]:
        if not isinstance(a, dict):
            continue
        action_type = a.get("action_type")
        if not isinstance(action_type, str) or action_type not in _ALLOWED_ACTION_TYPES:
            continue
        parent_matter = str(a.get("parent_matter") or "matter/inbox.md").strip()
        if not parent_matter.startswith("matter/"):
            parent_matter = f"matter/{parent_matter}"
        if not parent_matter.endswith(".md"):
            parent_matter = f"{parent_matter}.md"
        title = str(a.get("title") or "").strip()
        body = str(a.get("body") or "").strip()
        target_path = str(a.get("target_path") or "").strip()
        if target_path and not target_path.endswith(".md"):
            target_path = f"{target_path}.md"
        patch_raw = a.get("patch")
        patch: dict[str, Any] = {}
        if isinstance(patch_raw, dict):
            for k, v in patch_raw.items():
                if isinstance(k, str) and k:
                    patch[k] = v

        # Per-type required-field gates. Drop entries that don't meet
        # the contract — an LLM that emits ``create_task`` with no title
        # is producing garbage.
        if action_type == "create_task":
            if not title or not body:
                continue
        elif action_type == "update_task":
            if not target_path or not patch:
                continue
        elif action_type == "comment_on_matter":
            if not body:
                continue

        try:
            confidence = float(a.get("confidence", 0.0))
        except (TypeError, ValueError):
            confidence = 0.0
        if confidence < 0.0:
            confidence = 0.0
        elif confidence > 1.0:
            confidence = 1.0

        evidence_speaker = str(a.get("evidence_speaker") or "").strip()
        evidence_quote = str(a.get("evidence_quote") or "").strip()
        if len(evidence_quote) > 500:
            evidence_quote = evidence_quote[:500] + "…"

        out.append({
            "action_type": action_type,
            "parent_matter": parent_matter,
            "title": title,
            "body": body,
            "target_path": target_path,
            "patch": patch,
            "confidence": round(confidence, 4),
            "evidence_speaker": evidence_speaker,
            "evidence_quote": evidence_quote,
        })
    return out


# Fallback confidence when the clerk fails on both attempts — same
# sentinel as steward.evaluate_state's LLM_FALLBACK_CONFIDENCE. Phase 3's
# action-applier checks for ``confidence >= 0.6`` before auto-acting, so
# 0.3 means "land as pending_confirmation only".
LLM_FALLBACK_CONFIDENCE = 0.3


@activity.defn
async def extract_actions_from_transcript(
    transcript_text: str,
    attendees: list[str],
    gcal_event: dict[str, Any],
) -> list[dict[str, Any]]:
    """Run the Clerk to extract candidate action items from a transcript.

    Two-attempt JSON-strict harness (matches ``steward.evaluate_state``):

      1. First attempt with the canonical prompt.
      2. On a malformed first response, retry once with a stricter prompt.
      3. On a second malformed response, return ``[]`` — better an empty
         action list than a polluted Steward signal stream.

    Returns the validated list of action candidates (see
    ``_validate_extracted_actions`` for the schema). Empty list is a
    valid outcome — many meetings produce no actionable items.
    """
    # Lazy import — clerk is activity-only, never imported by a workflow.
    from src.activities.clerk import _call_clerk

    if not transcript_text or not transcript_text.strip():
        return []

    prompt = _build_extract_actions_prompt(
        transcript_text, attendees, gcal_event, stricter=False,
    )
    try:
        raw_first = await _call_clerk(prompt)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "transcript.extract_actions: clerk call failed err=%s — returning empty list",
            exc,
        )
        return []

    cleaned = _validate_extracted_actions(raw_first)
    if cleaned or _looks_like_empty_actions_envelope(raw_first):
        # Either we got real actions, or we got a well-formed empty
        # envelope ({"actions": []}). Both are valid — don't retry.
        return cleaned

    logger.warning(
        "transcript.extract_actions: malformed clerk response on first attempt — retrying with stricter prompt",
    )

    prompt2 = _build_extract_actions_prompt(
        transcript_text, attendees, gcal_event, stricter=True,
    )
    try:
        raw_second = await _call_clerk(prompt2)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "transcript.extract_actions: stricter retry failed err=%s — returning empty list",
            exc,
        )
        return []
    return _validate_extracted_actions(raw_second)


def _looks_like_empty_actions_envelope(raw: Any) -> bool:
    """True when ``raw`` is a well-formed ``{"actions": []}`` shape.

    Distinguishes "LLM correctly said no actions" from "LLM emitted
    something we couldn't parse" — the former should not trigger a
    retry, the latter should.
    """
    if not isinstance(raw, dict):
        return False
    actions = raw.get("actions")
    return isinstance(actions, list) and len(actions) == 0


# ---------------------------------------------------------------------------
# Activity: apply_transcript_action
# ---------------------------------------------------------------------------

# Steward signals stream — must match the path used by
# packages/ctrl/src/api/routes/webhooks/plane.ts so Phase 3's
# apply_state_change consumer reads from the same place.
STEWARD_SIGNALS_FILENAME = "steward-signals.jsonl"


def _steward_signals_path(cfg) -> str:
    return os.path.join(cfg.alfred_data_dir, "streams", STEWARD_SIGNALS_FILENAME)


def _resolve_action_target_path(action: dict[str, Any]) -> str:
    """Return the canonical Steward signal target path for an action.

    For ``update_task`` we attach the signal to the target task. For
    ``create_task`` and ``comment_on_matter`` the action itself isn't
    bound to an existing task — Steward's signal-consumer expects every
    signal to carry a ``task_path``, but the Phase 3 code path that
    handles ``transcript:action_candidate`` interprets it as the
    *parent_matter* path for create / comment actions. Either way the
    field is always populated to a real vault path.
    """
    action_type = action.get("action_type") or ""
    if action_type == "update_task":
        target = str(action.get("target_path") or "").strip()
        if target:
            return target
    parent_matter = str(action.get("parent_matter") or "").strip()
    return parent_matter or "matter/inbox.md"


@activity.defn
async def apply_transcript_action(
    action: dict[str, Any],
    meeting_metadata: dict[str, Any],
) -> dict[str, Any]:
    """Emit one ``transcript:action_candidate`` Steward signal.

    Phase 4 deliberately stops at signal emission. The action does NOT
    mutate vault state, does NOT post to Plane, does NOT create or
    update tasks here. Phase 3's ``apply_state_change`` handles the
    application path when it goes live; until then the signal sits in
    ``streams/steward-signals.jsonl`` for the next Steward tick on the
    relevant matter / task to pick up.

    Args:
        action: one entry from ``extract_actions_from_transcript``.
        meeting_metadata: ``{platform, native_meeting_id, gcal_event_id,
            scheduled_start, attendees, vexa_meeting_id}`` — provenance
            stamped onto the signal so Steward + the dashboard can
            display "from meeting X with attendees Y, Z".

    Returns the persisted signal record so the workflow can log /
    audit. Best-effort — disk write failures raise (Temporal retries).
    """
    if not isinstance(action, dict):
        raise ValueError("apply_transcript_action: action must be a dict")
    action_type = action.get("action_type")
    if action_type not in _ALLOWED_ACTION_TYPES:
        raise ValueError(
            f"apply_transcript_action: unknown action_type {action_type!r}",
        )

    cfg = load_config()
    target_path = _resolve_action_target_path(action)
    parent_matter = str(action.get("parent_matter") or "").strip()
    if not parent_matter:
        parent_matter = "matter/inbox.md"

    meeting_id = str(meeting_metadata.get("native_meeting_id") or "").strip()
    platform = str(meeting_metadata.get("platform") or "google_meet").strip()
    gcal_id = str(meeting_metadata.get("gcal_event_id") or "").strip()
    attendees = meeting_metadata.get("attendees") or []
    if not isinstance(attendees, list):
        attendees = []
    vexa_meeting_id = meeting_metadata.get("vexa_meeting_id") or ""

    note_parts = [f"transcript-action({action_type})"]
    if action_type == "create_task":
        title = str(action.get("title") or "").strip()
        if title:
            note_parts.append(f"new: {title}")
    elif action_type == "update_task":
        target = str(action.get("target_path") or "").strip()
        patch = action.get("patch") or {}
        if target:
            note_parts.append(f"target={target}")
        if isinstance(patch, dict) and patch:
            note_parts.append(f"patch={','.join(patch.keys())}")
    elif action_type == "comment_on_matter":
        if parent_matter:
            note_parts.append(f"matter={parent_matter}")
    note = "; ".join(note_parts)
    speaker = str(action.get("evidence_speaker") or "").strip()
    quote = str(action.get("evidence_quote") or "").strip()
    if speaker and quote:
        note = f"{note} — {speaker}: \"{quote}\""

    signal_id = f"transcript_{meeting_id or 'unknown'}_{platform}"
    if action_type == "update_task":
        signal_id += f"_update_{(action.get('target_path') or '').strip().replace('/', '_')}"
    elif action_type == "create_task":
        # Disambiguate two create_tasks for the same meeting using a
        # short hash of the body — keeps the JSONL stream's natural
        # uniqueness without depending on monotonic clocks.
        import hashlib
        body = str(action.get("body") or "")
        digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:10]
        signal_id += f"_create_{digest}"
    else:  # comment_on_matter
        import hashlib
        body = str(action.get("body") or "")
        digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:10]
        signal_id += f"_comment_{digest}"

    record = {
        "id": f"evt_{signal_id}",
        "ts": _now_utc_iso(),
        "kind": "transcript:action_candidate",
        "task_path": target_path,
        "ref": (
            f"meeting:{platform}:{meeting_id}"
            if meeting_id
            else "meeting:unknown"
        ),
        "note": note,
        # Carry the full action + meeting metadata so Phase 3's
        # apply_state_change has everything it needs without re-fetching.
        # The Plane handler attaches the raw webhook payload under "raw"
        # for the same reason (auditability + late-binding of new
        # decoders).
        "raw": {
            "action": action,
            "meeting": {
                "platform": platform,
                "native_meeting_id": meeting_id,
                "gcal_event_id": gcal_id,
                "scheduled_start": meeting_metadata.get("scheduled_start") or "",
                "attendees": attendees,
                "vexa_meeting_id": vexa_meeting_id,
            },
            "parent_matter": parent_matter,
        },
    }

    path = _steward_signals_path(cfg)
    append_jsonl(path, record)
    logger.info(
        "transcript.apply_transcript_action: kind=%s action=%s target=%s meeting=%s",
        record["kind"], action_type, target_path, meeting_id,
    )
    return record


# ---------------------------------------------------------------------------
# Activity helpers — gcal stream poller + transcript stream poller
# ---------------------------------------------------------------------------

# Stream IDs we'll try in order when looking for gcal events. Tenants can
# override the primary one via VEXA_GCAL_STREAM_ID. The defaults match
# the canonical slugs in packages/ctrl/src/api/routes/streams.ts and the
# composio integration auto-config.
def _gcal_stream_candidates() -> list[str]:
    override = os.environ.get("VEXA_GCAL_STREAM_ID", "").strip()
    if override:
        return [override]
    # Canonical slug first (matches the stream Composio's connector
    # auto-creates: ``composio-{toolkit}-{action_lowercased}``). The
    # short fallbacks are kept for older tenants that pre-date the
    # auto-naming convention; new fleet tenants always land on the
    # canonical slug, so this list shouldn't grow.
    return [
        "composio-googlecalendar-googlecalendar-events-list",
        "composio-googlecalendar",
        "googlecalendar",
        "composio-calendar",
    ]


def _safe_stream_filename(stream_id: str) -> str:
    """Mirror ctrl-api's getStreamEventsPath sanitiser."""
    return re.sub(r"[^a-zA-Z0-9_-]", "_", stream_id) + ".jsonl"


def _read_jsonl_records(path: str) -> list[dict[str, Any]]:
    """Read a JSONL file. Tolerates partial / corrupt lines."""
    if not os.path.exists(path):
        return []
    out: list[dict[str, Any]] = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                    if isinstance(parsed, dict):
                        out.append(parsed)
                except json.JSONDecodeError:
                    continue
    except OSError as exc:
        logger.warning("transcript._read_jsonl_records: read failed path=%s err=%s", path, exc)
    return out


def _parse_gcal_start(raw: dict[str, Any]) -> Optional[datetime]:
    """Parse the ``start`` field on a gcal event into a UTC datetime.

    Google emits either ``{"dateTime": "...", "timeZone": "..."}`` or
    ``{"date": "YYYY-MM-DD"}``. We honor both. Returns None on any
    parse failure — callers MUST treat that as "unknown" (we never
    silently dispatch a bot for a meeting we can't time).
    """
    start = raw.get("start") or {}
    if not isinstance(start, dict):
        return None
    dt_str = start.get("dateTime")
    if isinstance(dt_str, str) and dt_str.strip():
        try:
            # fromisoformat handles trailing 'Z' from 3.11+; we
            # normalise just in case the runtime is older.
            normalised = dt_str.replace("Z", "+00:00")
            parsed = datetime.fromisoformat(normalised)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except (ValueError, TypeError):
            return None
    date_str = start.get("date")
    if isinstance(date_str, str) and date_str.strip():
        try:
            parsed = datetime.fromisoformat(date_str + "T00:00:00+00:00")
            return parsed
        except (ValueError, TypeError):
            return None
    return None


@activity.defn
async def find_upcoming_meet_events(
    lookahead_seconds: int = 600,
    owner_email: str = "",
    lateness_seconds: int = 300,
) -> list[dict[str, Any]]:
    """Return upcoming Google Meet events in the next ``lookahead_seconds``.

    Reads from the gcal stream JSONL (``composio-googlecalendar.jsonl``
    or its overrides), filters for events where:

      * Sir is an attendee (or creator/organizer) per ``is_sir_attendee``.
      * A Google Meet URL is detected via ``extract_meet_native_id``.
      * ``start`` is within ``[now, now + lookahead_seconds]``.
      * ``status`` is not ``"cancelled"``.

    Each returned record has:

        {
            "gcal_event_id":     <id>,
            "summary":           <title>,
            "platform":          "google_meet",
            "native_meeting_id": <code>,
            "meet_url":          <full url>,
            "scheduled_start":   <ISO 8601>,
            "attendees":         [<email>, ...],
            "raw":               <full gcal event>,
        }

    Used by ``MeetingCaptureWorkflow`` to decide which meetings need a
    Vexa bot dispatched.
    """
    cfg = load_config()
    streams_dir = cfg.streams_dir
    candidates = _gcal_stream_candidates()
    owner = (owner_email or os.environ.get("ALFRED_OWNER_EMAIL", "")).strip().lower()

    raw_events: list[dict[str, Any]] = []
    for stream_id in candidates:
        path = os.path.join(streams_dir, _safe_stream_filename(stream_id))
        if not os.path.exists(path):
            continue
        records = _read_jsonl_records(path)
        if records:
            raw_events.extend(records)
            logger.info(
                "transcript.find_upcoming_meet_events: stream=%s loaded=%d",
                stream_id, len(records),
            )
            # Don't keep scanning if we found data in the first match —
            # avoids double-counting events when an operator mirrors
            # the same gcal feed under multiple slugs.
            break

    if not raw_events:
        logger.info(
            "transcript.find_upcoming_meet_events: no gcal stream found in %s — looked for %s",
            streams_dir, candidates,
        )
        return []

    now = datetime.now(timezone.utc)
    horizon = now.timestamp() + max(0, lookahead_seconds)
    out: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for evt in raw_events:
        # ctrl-api stream events nest the original gcal payload under
        # ``raw`` (see streams.ts ingest pattern). Tolerate both shapes
        # so a tenant whose gcal events arrived via a different ingest
        # path still works.
        raw_gcal = evt.get("raw")
        if not isinstance(raw_gcal, dict):
            raw_gcal = evt
        # Some integrations wrap once more in `data` (composio shape).
        inner = raw_gcal.get("data")
        if isinstance(inner, dict) and inner.get("kind") == "calendar#event":
            raw_gcal = inner

        gcal_id = (
            raw_gcal.get("id")
            or raw_gcal.get("eventId")
            or evt.get("source_ref")
            or ""
        )
        gcal_id = str(gcal_id)

        status = str(raw_gcal.get("status") or "").lower()
        if status == "cancelled":
            continue

        meet_url, native_id = extract_meet_native_id(raw_gcal)
        if not native_id:
            continue

        if not is_sir_attendee(raw_gcal, owner):
            continue

        start_dt = _parse_gcal_start(raw_gcal)
        if start_dt is None:
            continue
        start_ts = start_dt.timestamp()
        if start_ts < now.timestamp() - max(60, lateness_seconds):
            # Already-past events are skipped — Vexa joining 5 minutes
            # late is fine, but joining 2 hours after the fact is just
            # wasted bot lifetime.
            continue
        if start_ts > horizon:
            continue

        # Dedupe by gcal id within the same lookahead window — a
        # recurring-event ingest can emit the same instance several
        # times across stream entries.
        if gcal_id and gcal_id in seen_ids:
            continue
        if gcal_id:
            seen_ids.add(gcal_id)

        attendees: list[str] = []
        for a in raw_gcal.get("attendees") or []:
            if isinstance(a, dict) and isinstance(a.get("email"), str):
                attendees.append(a["email"])

        out.append({
            "gcal_event_id": gcal_id,
            "summary": str(raw_gcal.get("summary") or ""),
            "platform": "google_meet",
            "native_meeting_id": native_id,
            "meet_url": meet_url or f"https://meet.google.com/{native_id}",
            "scheduled_start": start_dt.isoformat(timespec="seconds"),
            "attendees": attendees,
            "raw": raw_gcal,
        })

    logger.info(
        "transcript.find_upcoming_meet_events: lookahead=%ds found=%d",
        lookahead_seconds, len(out),
    )
    return out


@activity.defn
async def list_unprocessed_transcript_events() -> list[dict[str, Any]]:
    """Return Vexa transcript-stream entries that haven't been processed yet.

    The webhook receiver writes one record per Vexa event to
    ``streams/vexa-transcripts.jsonl`` with ``processed: false``. This
    activity reads the file and returns any entry whose
    ``event_type`` is ``meeting.completed`` AND whose record hasn't yet
    been marked processed (tracked in
    ``state/steward/transcript-cursor.json``).
    """
    cfg = load_config()
    path = os.path.join(cfg.alfred_data_dir, "streams", VEXA_TRANSCRIPTS_STREAM)
    cursor_path = os.path.join(
        cfg.alfred_data_dir, "state", "steward", "transcript-cursor.json"
    )
    processed: set[str] = set()
    try:
        with open(cursor_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            ids = data.get("processed_ids")
            if isinstance(ids, list):
                processed = {str(i) for i in ids if isinstance(i, str)}
    except FileNotFoundError:
        pass
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "transcript.list_unprocessed: cursor read failed path=%s err=%s",
            cursor_path, exc,
        )

    records = _read_jsonl_records(path)
    out: list[dict[str, Any]] = []
    for rec in records:
        event_id = str(rec.get("id") or "")
        if not event_id or event_id in processed:
            continue
        event_type = str(rec.get("event_type") or "")
        # Only meeting.completed (and a few synonyms used by older Vexa
        # builds) are worth processing — bot.failed and meeting.started
        # don't yield transcripts.
        if event_type not in (
            "meeting.completed",
            "transcript.complete",
            "transcript.completed",
        ):
            continue
        out.append(rec)
    logger.info(
        "transcript.list_unprocessed_transcript_events: found=%d (already_processed=%d)",
        len(out), len(processed),
    )
    return out


@activity.defn
async def mark_transcript_event_processed(event_id: str) -> None:
    """Append ``event_id`` to the transcript-cursor's processed set."""
    if not event_id:
        return
    cfg = load_config()
    path = os.path.join(
        cfg.alfred_data_dir, "state", "steward", "transcript-cursor.json"
    )
    state: dict[str, Any] = {"processed_ids": []}
    try:
        with open(path, "r", encoding="utf-8") as f:
            loaded = json.load(f)
            if isinstance(loaded, dict):
                state = loaded
    except FileNotFoundError:
        pass
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "transcript.mark_processed: cursor read failed path=%s err=%s — rewriting",
            path, exc,
        )
    ids = state.get("processed_ids")
    if not isinstance(ids, list):
        ids = []
    if event_id not in ids:
        ids.append(event_id)
    # Cap the cursor to the last 5000 entries — the workflow only needs
    # to dedupe within a reasonable lookback, and an unbounded list
    # would slowly consume memory across thousands of meetings.
    if len(ids) > 5000:
        ids = ids[-5000:]
    state["processed_ids"] = ids
    state["last_marked_at"] = _now_utc_iso()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, sort_keys=True, default=str)
        os.replace(tmp, path)
    except OSError as exc:
        logger.warning(
            "transcript.mark_processed: cursor write failed path=%s err=%s",
            path, exc,
        )
