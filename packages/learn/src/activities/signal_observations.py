"""Extract a passive observation from each new signal.

[OBS-2] Companion to OBS-1's deterministic decision→observation. The
forward arrow of Sir's Progressive Autonomy model:

  stream_event  →  signal  →  observation (passive)
                          \\
                           →  needs_attention (when no instinct matches)

For the intuition engine to learn, it needs facts about Sir's life
streaming in from the world, not only from his explicit clicks. Every
inbound signal carries texture: who sent it, what topic, what proposed
effect. We capture that as an ``observation/<ts>.md`` record with
``source_kind=signal`` and the same canonical shape as decision
observations, so the clusterer reads one unified pool.

Asymmetry vs. decisions:

* Decisions are intentional gestures — every one matters; observation
  is deterministic 1:1 (no gate).
* Signals are inbound — most are world events, but signal_extract
  has *already* done the LLM judgement and structured the signal.
  We don't run a second clerk pass; we lift the structured fields
  (source_type, effect, target_candidates, sender from the source
  event) deterministically.

Noise-suppressed events never reach this code — ``signal_extract``
short-circuits matching events before writing a signal record. So
every signal we observe was, by definition, not already filtered.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config

logger = logging.getLogger("signal-observations")


def _http() -> httpx.AsyncClient:
    cfg = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    return httpx.AsyncClient(
        base_url=cfg.alfred_ctrl_url, headers=headers, timeout=60.0
    )


def _normalise_source_type(raw: str) -> str:
    """Collapse Composio toolkit prefixes onto canonical buckets."""
    s = (raw or "").lower().strip()
    if s.startswith("composio-gmail") or s == "gmail":
        return "gmail"
    if s.startswith("composio-googlecalendar") or s in ("gcal", "googlecalendar"):
        return "gcal"
    if s.startswith("composio-slack") or s == "slack":
        return "slack"
    if s.startswith("composio-linear") or s == "linear":
        return "linear"
    if s.startswith("composio-notion") or s == "notion":
        return "notion"
    if s.startswith("composio-github") or s == "github":
        return "github"
    if s in ("openclaw-chat", "chat"):
        return "chat"
    if s == "vexa" or s.startswith("vexa-"):
        return "vexa"
    if s == "omi" or s.startswith("omi-"):
        return "omi"
    if s == "sms":
        return "sms"
    return s or "unknown"


def _authoritative_source_type(event_fm: dict[str, Any], signal_source_type: str) -> str:
    """Return the *real* source type for a stream event.

    There's a known upstream bug on david's vault: ~360 stream_event
    records carry ``source_type: gcal`` but ``source_ref: gmail:<id>``
    plus ``tags: [..., email]``. The curator/puller mislabels emails
    as calendar events for one specific ingestion path. ``source_ref``
    is set by the puller from the upstream API contract and is the
    authoritative signal of which API the record came from.

    Resolution order (highest priority first):
      1. ``source_ref`` prefix when it's a known toolkit (``gmail:`` →
         gmail, ``gcal:`` → gcal, etc.)
      2. ``tags`` list — ``email`` strongly implies gmail
      3. The event's own ``source_type`` field
      4. The signal's ``source_type`` field (fallback)
    """
    source_ref = str(event_fm.get("source_ref") or "").strip().lower()
    if source_ref.startswith("gmail:"):
        return "gmail"
    if source_ref.startswith("gcal:") or source_ref.startswith("googlecalendar:"):
        return "gcal"
    if source_ref.startswith("slack:"):
        return "slack"
    if source_ref.startswith("github:"):
        return "github"
    if source_ref.startswith("notion:"):
        return "notion"
    if source_ref.startswith("linear:"):
        return "linear"

    tags = event_fm.get("tags")
    if isinstance(tags, list):
        normalised_tags = {str(t).strip().lower() for t in tags if isinstance(t, str)}
        if "email" in normalised_tags:
            return "gmail"
        if "calendar" in normalised_tags or "gcal" in normalised_tags:
            return "gcal"

    event_st = str(event_fm.get("source_type") or "").strip()
    if event_st:
        return _normalise_source_type(event_st)
    return _normalise_source_type(signal_source_type or "")


def _extract_sender_from_event(event_fm: dict[str, Any]) -> str:
    """Best-effort sender extraction from a stream_event's frontmatter.

    The vault schema on david varies by event source:

    * gmail events store the sender inline in the ``name`` field as
      ``"<email-or-handle>: <subject>"`` — that's where the from address
      actually lives. Split on the first ``": "`` and take the left side.
    * gcal events use ``organizer`` (object with .email, or a plain
      string).
    * Some Composio payloads expose ``raw.from``/``raw.From`` or a
      ``payload.headers`` list of ``{name, value}`` — both supported as
      fallbacks for compatibility.
    * Last resort: walk the ``entities`` list for the first ``person/``
      or ``org/`` reference and lift the slug.

    Returns ``""`` if no anchor is identifiable. Empty sender is fine —
    the clusterer falls back to (subject, topic, source_type) when
    sender is missing.
    """
    # 1. gmail-style: ``name: "sender: subject"``
    name = event_fm.get("name")
    if isinstance(name, str) and ": " in name:
        candidate = name.split(": ", 1)[0].strip()
        # Heuristic: an email or domain-like handle. We don't require a
        # strict @ because some senders are normalised to handles
        # ("notifications@github.com" → "github" in some upstream
        # writers), but we do require it to look like a sender token
        # (no whitespace, ≤ 80 chars).
        if (
            candidate
            and len(candidate) <= 80
            and " " not in candidate
            and ("@" in candidate or "." in candidate)
        ):
            return candidate

    # 2. Explicit ``raw`` payload from Composio shapes.
    raw = event_fm.get("raw") or {}
    if isinstance(raw, dict):
        for k in ("from", "From", "sender", "from_email"):
            v = raw.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        for k in ("organizer", "organiser"):
            v = raw.get(k)
            if isinstance(v, dict):
                em = v.get("email") or v.get("emailAddress")
                if isinstance(em, str) and em.strip():
                    return em.strip()
            if isinstance(v, str) and v.strip():
                return v.strip()
        payload = raw.get("payload") or {}
        if isinstance(payload, dict):
            headers = payload.get("headers")
            if isinstance(headers, list):
                for h in headers:
                    if not isinstance(h, dict):
                        continue
                    nm = str(h.get("name") or "").lower()
                    if nm in ("from", "sender"):
                        val = h.get("value")
                        if isinstance(val, str) and val.strip():
                            return val.strip()

    # 3. Flat top-level fields (legacy shapes).
    for k in ("from", "sender", "organizer", "organiser"):
        v = event_fm.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
        if isinstance(v, dict):
            em = v.get("email") or v.get("emailAddress")
            if isinstance(em, str) and em.strip():
                return em.strip()

    # 4. ``entities`` list — fish out the first ``person/<x>`` or
    # ``org/<x>``. Useful for gcal/vexa where there's no inline sender
    # but the curator has tagged participants.
    entities = event_fm.get("entities")
    if isinstance(entities, list):
        for ent in entities:
            if not isinstance(ent, str):
                continue
            e = ent.strip()
            if e.startswith("person/") or e.startswith("org/"):
                return e
    return ""


def _derive_event_kind(source_type: str, effect: Any) -> str:
    """A coarse event_kind for clustering. Examples:
    ``gmail_message``, ``gcal_event``, ``chat_turn``, ``slack_message``."""
    norm = _normalise_source_type(source_type)
    effect_type = ""
    if isinstance(effect, dict):
        effect_type = str(effect.get("type") or "").lower().strip()
    if norm == "gmail":
        return "gmail_message"
    if norm == "gcal":
        return "gcal_event"
    if norm == "chat":
        return "chat_turn"
    if norm == "vexa":
        return "vexa_segment"
    if norm == "omi":
        return "omi_segment"
    if norm == "sms":
        return "sms_message"
    if effect_type:
        return f"{norm}_{effect_type}"
    return f"{norm}_event"


def _derive_topic(source_type: str, event_fm: dict[str, Any], signal_fm: dict[str, Any]) -> str:
    """Topic for clustering. Prefer the event's first alfred_tag /
    topic_tag if present; fall back to ``<source>-inbound``."""
    for k in ("alfred_tags", "topic_tags"):
        tags = event_fm.get(k)
        if isinstance(tags, list) and tags:
            first = str(tags[0]).strip().lower()
            if first:
                return first
        tags_sig = signal_fm.get(k)
        if isinstance(tags_sig, list) and tags_sig:
            first = str(tags_sig[0]).strip().lower()
            if first:
                return first
    norm = _normalise_source_type(source_type)
    return f"{norm}-inbound"


def _derive_matter_ref(signal_fm: dict[str, Any]) -> str:
    """Pull matter linkage from signal.target_path when target_kind == matter."""
    target_kind = str(signal_fm.get("target_kind") or "").lower()
    if target_kind == "matter":
        tp = str(signal_fm.get("target_path") or "").strip()
        if tp:
            return tp if tp.endswith(".md") else tp + ".md"
    # Fall back to first matter in target_candidates.
    candidates = signal_fm.get("target_candidates")
    if isinstance(candidates, list):
        for c in candidates:
            if not isinstance(c, dict):
                continue
            tp = str(c.get("path") or "").strip()
            if tp.startswith("matter/"):
                return tp if tp.endswith(".md") else tp + ".md"
    return ""


async def _read_record(client: httpx.AsyncClient, path: str) -> dict[str, Any]:
    try:
        resp = await client.get(f"/api/v1/vault/records/{path}")
        if resp.status_code >= 400:
            return {}
        return resp.json() or {}
    except Exception:  # noqa: BLE001
        return {}


@activity.defn
async def extract_observation_from_signal(signal_path: str) -> dict[str, Any]:
    """Write an ``observation`` row to ``state.db`` from a signal. Deterministic.

    Storage cutover (#26): both ``signal`` and ``observation`` are
    machine bookkeeping (PLAN.md Part I — the promotion contract), so
    they live in Store 2 (``state.db``), not the markdown vault. The
    ``signal_path`` argument is now the ``state.db`` signal id (a
    ULID), not a ``signal/*.md`` path; the observation is written
    through ctrl-api's ``/api/v1/state/observations`` endpoint.

    Reads the signal row from ``state.db``, follows
    ``source_event_path`` to the underlying stream event (still a vault
    record — stream events are not part of this cutover) for sender
    enrichment, derives sender/topic/event_kind/matter_ref, and writes
    the observation row with ``kind=signal``.

    Returns ``{"observation_path": <observation-ulid>, ...}`` on
    success or ``{"observation_path": None, "reason": ...}`` on
    read/write failure. No clerk gate — every signal that wasn't
    already noise-suppressed becomes an observation.
    """
    from src.utils.signal_state import (
        normalise_signal_ref,
        read_signal_record,
    )

    if not signal_path or not isinstance(signal_path, str):
        return {"observation_path": None, "reason": "no signal ref"}
    signal_ref = normalise_signal_ref(signal_path)
    if not signal_ref:
        return {"observation_path": None, "reason": "not a signal ref"}

    signal_rec = await read_signal_record(signal_ref)
    if not signal_rec:
        return {"observation_path": None, "reason": "signal not readable"}
    signal_fm = signal_rec.get("frontmatter") or {}
    if not isinstance(signal_fm, dict):
        signal_fm = {}

    async with _http() as client:
        source_event_path = str(signal_fm.get("source_event_path") or "").strip()
        event_fm: dict[str, Any] = {}
        if source_event_path:
            event_rec = await _read_record(client, source_event_path)
            event_fm = (event_rec.get("frontmatter") or {}) if isinstance(event_rec, dict) else {}
            if not isinstance(event_fm, dict):
                event_fm = {}

    raw_source_type = str(signal_fm.get("source_type") or event_fm.get("source_type") or "").strip()
    # Defensive: source_type on the stream_event is sometimes wrong
    # (mislabeled gmails as gcal on david — ~49% of "gcal" records).
    # ``_authoritative_source_type`` cross-references source_ref + tags
    # before trusting the field.
    source_type = _authoritative_source_type(event_fm, raw_source_type)
    sender = _extract_sender_from_event(event_fm) if event_fm else ""
    event_kind = _derive_event_kind(source_type, signal_fm.get("effect"))
    topic = _derive_topic(source_type, event_fm, signal_fm)
    matter_ref = _derive_matter_ref(signal_fm)

    # Build a deterministic, single-sentence fact. The shape mirrors
    # decision observations so the clusterer reads a uniform pool.
    headline = (
        str(signal_fm.get("display_headline") or "").strip()
        or str(event_fm.get("subject") or event_fm.get("title") or "").strip()
        or str(signal_fm.get("name") or "").strip()
    )
    norm_source = _normalise_source_type(source_type)
    fact_parts = [f"Received {norm_source} {event_kind.split('_', 1)[-1] or 'event'}"]
    if sender:
        fact_parts.append(f"from {sender}")
    if headline:
        # Quote the headline; truncate at 200 to keep fact under control.
        h = headline if len(headline) <= 200 else headline[:197] + "..."
        fact_parts.append(f"'{h}'")
    fact_clean = " ".join(fact_parts)

    created_iso = str(signal_fm.get("created") or "").strip()
    try:
        when_dt = datetime.fromisoformat(created_iso.replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        when_dt = datetime.now(timezone.utc)
    now_iso = when_dt.isoformat()
    name_label = fact_clean if len(fact_clean) <= 90 else fact_clean[:87] + "..."

    # Match observation → instinct so /instincts can list the
    # observations that taught each pattern. See _match_instinct_for_observation
    # in decision_observations.py; we reuse that helper through a thin
    # import to keep the matcher in one place.
    from src.activities.decision_observations import (
        _match_instinct_for_observation,
    )
    instinct_path = await _match_instinct_for_observation(
        fact_clean=fact_clean,
        sender=sender,
        topic=topic,
        name_label=name_label,
        source_kind="signal",
        source_type=norm_source,
        event_kind=event_kind,
        signal_fm=signal_fm,
        event_fm=event_fm,
    )

    # Storage cutover (#26): an observation is machine bookkeeping —
    # it goes to Store 2 (``state.db``), not ``vault/observation/``.
    # The full canonical observation shape (subject/fact/topic/
    # source_kind/sender/intent/...) that pattern detection clusters on
    # is carried in the ``payload`` JSON blob; the typed columns
    # (subject/kind/summary/instinct_ref/...) make it queryable.
    payload: dict[str, Any] = {
        "type": "observation",
        "name": name_label,
        "created": now_iso,
        "subject": "principal",
        "fact": fact_clean,
        "topic": topic,
        "source_kind": "signal",
        # ``source_path`` is the cross-record key back to the signal —
        # now a state.db ULID, not a markdown path.
        "source_path": signal_ref,
        "source_ref": signal_ref,
        "source_event_path": source_event_path or None,
        "matter_ref": matter_ref or None,
        "sender": sender or None,
        "event_kind": event_kind,
        "source_type": norm_source,
        "instinct": instinct_path or None,
        "confidence": 1.0,
        "status": "open",
        # signal observations carry no intent — pattern detection v1
        # only clusters decision observations (see pattern_detection).
        "intent": None,
    }

    from src.utils.signal_state import StateClient
    cfg = load_config()
    try:
        async with StateClient(cfg) as sc:
            observation_id = await sc.create_observation(
                subject="principal",
                kind="signal",
                summary=fact_clean,
                detail=f"Extracted from signal {signal_ref} at {now_iso}.",
                ts=now_iso,
                instinct_ref=instinct_path or None,
                confidence=1.0,
                status="open",
                payload=payload,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("extract_obs_from_signal: state.db write failed: %s", exc)
        return {"observation_path": None, "reason": f"write error: {exc}"}

    logger.info(
        "extract_obs_from_signal: %s -> observation %s (sender=%s topic=%s)",
        signal_ref, observation_id, sender or "-", topic,
    )
    return {
        "observation_path": observation_id,
        "fact": fact_clean,
        "topic": topic,
        "sender": sender,
        "event_kind": event_kind,
    }
