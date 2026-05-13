"""Signal extraction activities for Steward Phase 6 (T6.0.1).

The signal-extraction layer turns raw stream events (Gmail messages,
Slack messages, OMI transcripts, openclaw chat sessions, Vexa
transcripts, Sure events, gcal events, plane events, vault edits) into
structured ``signal`` records that the Phase 6 Steward + autonomy
routers consume.

The flow this module participates in (RFC #842 §6):

    stream_event/<id>.md ──extract_signal_from_event──▶ signal proposal
        │                                                │
        │                                                ▼
        │                       T6.0.3 write_signal_record persists to vault
        │                                                │
        │                                                ▼
        ▼                       T6.3.x SignalRouterWorkflow ▶ mutation/action
    raw quote preserved
    on the signal record
    after stream-event purge
    (T6.6 PurgeWorkflow)

This module ships ONE activity in this dispatch:
``extract_signal_from_event``. The downstream sister activities
(``write_signal_record``, ``list_unprocessed_stream_events``) land in
T6.0.3 — keeping them out of this file means the signal-extraction
prompt + ranking changes can iterate without touching the
write/dispatch path.

All vault reads + writes go through ``VaultClient`` per the
alfred-learn hard rule (NEVER direct filesystem). All LLM calls go
through ``clerk._call_clerk(prompt, raw=False)`` (NEVER a new dispatch
path). The pre-filter is intentionally aggressive — every clerk call
costs tokens, and noise events (newsletters, system notifications,
empty bodies) make up the bulk of stream traffic — so we drop them
before the LLM sees them.

The prompt-builder ``build_signal_extraction_prompt`` lives in
``src.utils.signal_prompts`` (T6.0.2). Importing it before T6.0.2
lands will fail; that's expected for the dispatch sequence.
"""
from __future__ import annotations

import difflib
import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Pre-filter allowlist. Source types not in this set are rejected before
# any LLM call so a misclassified stream event (e.g. a never-categorized
# webhook) can't drive cost. Adding a new source type here is the
# explicit gate for putting it in front of the signal extractor.
PRE_FILTER_ALLOWLIST: set[str] = {
    "gmail",
    "slack",
    "omi",
    "openclaw-chat",
    "vexa",
    "sure",
    "gcal",
    "plane",
    "vault_edit",
}

# Sender domains that mass-mail and reliably produce zero
# matter-relevant signal. Refresh this from the
# noise.identify_blocklist_candidates run periodically; for v1 we seed
# with the largest ESP domains observed in david's gmail stream.
NEWSLETTER_BLOCKLIST: list[str] = [
    "mailchimp.com",
    "constantcontact.com",
    "sendgrid.net",
    "mailjet.com",
    "mailerlite.com",
]

# Below this body length the event is assumed to carry no semantic
# content (typical: empty Slack /reaction_added, Gmail "Trash" autofills,
# stub OMI transcripts that haven't been transcribed yet).
MIN_CONTENT_LENGTH: int = 20


# Source types that have proven to be 100% noise on this tenant.
# david's stream_event store contained 519 slack records and 340
# github records that were all stored Composio API errors
# (``{"action": "SLACK_LIST_MESSAGES", "error": ...}``) — never real
# slack messages or github events. Hard-blocking these source types
# at pre-filter eliminates ~860 LLM calls. Real slack DMs / github
# webhooks would arrive with a different stream_type from a fixed
# poller and can be re-allowed once that exists.
HARD_BLOCKED_SOURCE_TYPES: set[str] = {"slack", "github"}


# Slash-command openclaw-chat sessions carry zero signal — they're
# command artifacts, not conversations. ``/new``, ``/status``,
# ``/models``, ``/help``, etc. dropped before LLM. Match against
# the ``name`` frontmatter field.
_OPENCLAW_SLASH_PATTERN = re.compile(
    r"^\s*['\"]?Chat session — [01] turns:\s*/[a-zA-Z]+\b"
)


# Events older than this are skipped at the listing stage and
# bulk-marked into the sidecar. The signal pipeline distills
# stream events into actionable signals — by the time an event is
# 14 days old, any embedded signal has either been actioned or
# expired (delivery confirmations, calendar reminders, etc.). Keeping
# them in the backlog burns LLM cost for diminishing returns. Override
# via env ``STEWARD_SIGNAL_MAX_EVENT_AGE_DAYS``; set ``0`` to disable.
MAX_EVENT_AGE_DAYS_DEFAULT: int = 14


def _is_too_old(event_dict: dict[str, Any]) -> tuple[bool, str]:
    """Return ``(True, reason)`` for events past the age cutoff.

    Reads ``frontmatter.created`` (ISO date). Returns False when the
    event has no parseable date — better to LLM-process an undated
    event than to silently drop it. Returns False when the cutoff
    is disabled via env.
    """
    raw = __import__("os").environ.get(
        "STEWARD_SIGNAL_MAX_EVENT_AGE_DAYS",
        str(MAX_EVENT_AGE_DAYS_DEFAULT),
    )
    try:
        max_age_days = int(raw)
    except (TypeError, ValueError):
        max_age_days = MAX_EVENT_AGE_DAYS_DEFAULT
    if max_age_days <= 0:
        return False, ""

    created = _event_created_dt(event_dict)
    if created is None:
        return False, ""

    from datetime import timedelta
    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
    if created < cutoff:
        age_days = (datetime.now(timezone.utc) - created).days
        return True, f"event older than cutoff ({age_days}d > {max_age_days}d)"
    return False, ""


def _is_garbage_event(event_dict: dict[str, Any]) -> tuple[bool, str]:
    """Cheap structural check for stored API-errors / command artifacts.

    Returns ``(True, reason)`` for events that are unconditionally
    skipped at listing time AND bulk-marked in the sidecar so they
    never get re-listed. Distinct from ``_pre_filter`` (which is
    semantic: short body, stale gcal, etc.) — this catches events
    that should never have been stored in the first place.
    """
    fm = event_dict.get("frontmatter") or {}
    if not isinstance(fm, dict):
        return False, ""

    src_type = _infer_source_type(event_dict)
    if src_type in HARD_BLOCKED_SOURCE_TYPES:
        return True, f"hard-blocked source_type: {src_type}"

    name = str(fm.get("name") or "").strip()
    # Composio API errors stored as events (any source). The ingester
    # accidentally persisted error-shaped responses; ``name`` is the
    # raw JSON string starting with the action key.
    if name.startswith('{"action"') and '"error"' in name:
        return True, "composio API-error response stored as event"

    if _OPENCLAW_SLASH_PATTERN.match(name):
        return True, "openclaw slash-command session"

    return False, ""

# Width of the disambiguation band on top-1 vs top-2 target similarity.
# If the gap is below this, downstream router gets a target_path=None
# signal and treats it as needs-disambiguation. 0.05 was picked from
# the steward-source-confidence calibration window — anything tighter
# than 5 points of similarity is genuinely ambiguous.
TARGET_AMBIGUITY_BAND: float = 0.05

# Floor for the top match to be considered a real target. Below this we
# don't claim a target_path either (string similarity at <0.3 is barely
# better than chance for slug+name matching).
TARGET_MATCH_FLOOR: float = 0.30

# How many candidates we keep on the signal record for audit. Top-N
# ranked; the rest are discarded after ranking.
TARGET_CANDIDATE_LIMIT: int = 5

# Per-source-type max preview length we keep in raw_quote. The quote
# survives stream-event purge so it's the only ground truth a future
# Steward run sees — keep it tight enough to fit comfortably in an
# evaluate_state prompt, long enough to disambiguate intent.
RAW_QUOTE_MAX: int = 200


# ---------------------------------------------------------------------------
# Phase 6.7 (T6.7.4) — per-source-type confidence priors
# ---------------------------------------------------------------------------
#
# Different sources carry different baseline reliability. A direct
# openclaw-chat assertion from Sir to Alfred is much higher signal
# than an OMI ambient transcript that might be Sir narrating an
# article aloud. The LLM's effect_confidence captures intra-event
# certainty (was this assertion clearly an action?) but cannot know
# the prior probability that *this source type* even produces real
# signals.
#
# We multiply the LLM-reported ``effect_confidence`` by a per-source
# prior to produce the value persisted on the signal record, and
# stamp the original LLM number as ``effect_confidence_raw`` so the
# calibration loop (T6.7.5) can later recover what the LLM said vs
# what we used.
#
# Each prior is overridable via env
# ``STEWARD_SIGNAL_CONFIDENCE_PRIOR_<SOURCE>=<float>`` so a tenant
# can dial source weights without a code deploy.
#
# Special case: gmail. We split into two effective priors based on
# whether the sender is in the trusted-domain allowlist
# (``STEWARD_GMAIL_TRUSTED_DOMAINS=stripe.com,anthropic.com``).
# Trusted domains use the ``gmail`` prior; everything else falls
# back to ``gmail_unknown``.

SOURCE_TYPE_CONFIDENCE_PRIORS: dict[str, float] = {
    "gmail": 1.0,           # trusted-domain sender
    "gmail_unknown": 0.7,   # untrusted sender domain
    "slack": 0.95,          # all of david's slack is DM-equivalent today
    "slack_channel": 0.6,   # public channels (future-proof; not used yet)
    "omi": 0.7,             # ambient audio = lower trust
    "openclaw-chat": 1.0,   # direct Sir → Alfred = highest trust
    "vexa": 0.85,           # meeting transcript
    "sure": 0.9,            # only after pre-filter
    "gcal": 0.8,            # calendar metadata
    "plane": 0.9,           # project tracker, well-structured
    "vault_edit": 0.95,     # Sir's hand-edit = very high trust
}

# Overridable env-var prefix for per-source priors. Read once at
# call time so a tenant can hot-swap values without restarting.
_PRIOR_ENV_PREFIX = "STEWARD_SIGNAL_CONFIDENCE_PRIOR_"

# Comma-separated env var. Domains are matched case-insensitively
# against ``_gmail_sender_domain``'s output (which is already lower-cased).
_GMAIL_TRUSTED_DOMAINS_ENV = "STEWARD_GMAIL_TRUSTED_DOMAINS"


def _resolve_source_prior_key(
    source_type: str, event_dict: dict[str, Any] | None
) -> str:
    """Pick the prior-table key for a given event.

    Single special-case: gmail splits into ``gmail`` (trusted sender
    domain in ``STEWARD_GMAIL_TRUSTED_DOMAINS``) vs ``gmail_unknown``
    (everything else). All other source types map 1:1.

    Falls through to the raw source_type if it's not in the table —
    callers then receive the table-default of 1.0 from
    ``_get_source_prior``, which is the correct conservative behaviour
    for an unrecognized source (don't penalize what we don't model).
    """
    src = (source_type or "").strip().lower()
    if src != "gmail":
        return src
    trusted_raw = (
        __import__("os").environ.get(_GMAIL_TRUSTED_DOMAINS_ENV, "")
    )
    trusted = {
        d.strip().lower()
        for d in trusted_raw.split(",")
        if d and d.strip()
    }
    if not trusted:
        # No allowlist configured → treat all gmail as the higher-prior
        # ``gmail`` bucket. This preserves the v0 behaviour where every
        # gmail event got the full LLM confidence; tenants opt into the
        # split by setting STEWARD_GMAIL_TRUSTED_DOMAINS.
        return "gmail"
    domain = ""
    if event_dict is not None:
        domain = _gmail_sender_domain(event_dict)
    if not domain:
        return "gmail_unknown"
    if any(domain == d or domain.endswith("." + d) for d in trusted):
        return "gmail"
    return "gmail_unknown"


def _get_source_prior(prior_key: str) -> float:
    """Resolve the multiplier for ``prior_key``.

    Lookup order:
      1. Env override: ``STEWARD_SIGNAL_CONFIDENCE_PRIOR_<KEY>`` —
         uppercase, dashes/underscores normalized. Parsed as float;
         out-of-range values clamped to [0.0, 1.5] (we allow >1.0 so
         a tenant can boost a source above the LLM's reported number,
         e.g. an air-tight vault-edit).
      2. Default in ``SOURCE_TYPE_CONFIDENCE_PRIORS``.
      3. Final fallback: 1.0 (no penalty for unmodeled sources).
    """
    env_name = (
        _PRIOR_ENV_PREFIX
        + prior_key.replace("-", "_").upper()
    )
    raw = (__import__("os").environ.get(env_name) or "").strip()
    if raw:
        try:
            value = float(raw)
        except (TypeError, ValueError):
            value = None
        if value is not None and value == value:  # NaN guard
            if value < 0.0:
                return 0.0
            if value > 1.5:
                return 1.5
            return value
    return SOURCE_TYPE_CONFIDENCE_PRIORS.get(prior_key, 1.0)


def _apply_source_prior(
    source_type: str,
    event_dict: dict[str, Any] | None,
    raw_confidence: float,
) -> tuple[float, float, str]:
    """Multiply the LLM-reported confidence by the source-type prior.

    Returns ``(adjusted, raw, prior_key)``:
      * ``adjusted`` — the value to stamp as ``effect_confidence``,
        clamped to [0.0, 1.0].
      * ``raw`` — the unmodified LLM-reported value; stamped as
        ``effect_confidence_raw`` for calibration audit.
      * ``prior_key`` — which row of the priors table fired (e.g.
        ``"gmail"`` vs ``"gmail_unknown"``); recorded as
        ``effect_confidence_prior_key`` for audit.
    """
    prior_key = _resolve_source_prior_key(source_type, event_dict)
    multiplier = _get_source_prior(prior_key)
    raw = float(raw_confidence)
    adjusted = raw * multiplier
    if adjusted < 0.0:
        adjusted = 0.0
    if adjusted > 1.0:
        adjusted = 1.0
    return adjusted, raw, prior_key


# ---------------------------------------------------------------------------
# Helpers — pre-filter / source inference / quote extraction
# ---------------------------------------------------------------------------

def _now_utc_iso() -> str:
    """Current UTC timestamp as second-precision ISO-8601.

    Matches the format used elsewhere in alfred-learn so the resulting
    signal record's ``created_at`` round-trips cleanly through the
    YAML frontmatter the writer (T6.0.3) will produce.
    """
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _infer_source_type(event_dict: dict[str, Any]) -> str:
    """Derive a normalized source type from a stream-event vault record.

    Inspects (in order):
      0. ``frontmatter.source_type`` — Phase 6.6 explicit field
         stamped by ``stream_vault._build_vault_content`` and the
         T6.6.1 migrator. When present and in the allowlist, used
         directly without further inspection.
      1. ``frontmatter.stream_type`` — the canonical pre-6.6 field.
      2. ``frontmatter.source`` — older records pre-#705 used this
         instead of stream_type.
      3. ``frontmatter.channel`` — Slack-specific fallback when
         stream_type was lost in a re-materialization.
      4. ``frontmatter.tags`` — last-resort tag scan; "slack",
         "gmail", "omi" tags are stamped on every record by their
         template so even a hand-written stream event can be
         classified.

    Returns one of the values in PRE_FILTER_ALLOWLIST OR the literal
    string ``"unknown"`` (which the pre-filter will then reject).
    """
    fm = event_dict.get("frontmatter") or {}
    if not isinstance(fm, dict):
        fm = {}

    # 0. source_type — explicit Phase 6.6 field, highest priority.
    explicit_source_type = str(fm.get("source_type") or "").strip().lower()
    if explicit_source_type:
        normalized = _normalize_source_type(explicit_source_type)
        if normalized != "unknown":
            return normalized

    # 1. stream_type — canonical
    stream_type = str(fm.get("stream_type") or "").strip().lower()
    if stream_type:
        normalized = _normalize_source_type(stream_type)
        if normalized != "unknown":
            return normalized

    # 2. source — legacy
    source = str(fm.get("source") or "").strip().lower()
    if source:
        normalized = _normalize_source_type(source)
        if normalized != "unknown":
            return normalized

    # 3. channel — Slack-specific
    channel = str(fm.get("channel") or "").strip().lower()
    if channel:
        # Channel-only metadata almost certainly means Slack.
        return "slack"

    # 4. tags — broadest fallback
    tags = fm.get("tags") or []
    if isinstance(tags, list):
        tag_set = {str(t).strip().lower() for t in tags if t}
        for src_type in PRE_FILTER_ALLOWLIST:
            if src_type in tag_set:
                return src_type
        # Some tags use the un-normalized form.
        if "email" in tag_set:
            return "gmail"
        if "calendar" in tag_set:
            return "gcal"
        if "voice-call" in tag_set or "omi-audio" in tag_set:
            return "omi"

    return "unknown"


def _normalize_source_type(raw: str) -> str:
    """Map raw stream_type / source values to PRE_FILTER_ALLOWLIST entries.

    The stream_vault.py templates use slightly different identifiers
    than the allowlist (e.g. ``omi-audio`` vs ``omi``,
    ``gmail`` vs ``email`` vs ``agentmail``). This normalizer
    collapses them so the allowlist stays stable even if a new
    template alias is added upstream.
    """
    raw = raw.strip().lower()
    if not raw:
        return "unknown"

    # Direct hits.
    if raw in PRE_FILTER_ALLOWLIST:
        return raw

    # Aliases.
    if raw in ("email", "agentmail", "gmail-event"):
        return "gmail"
    if raw.startswith("slack"):
        return "slack"
    if raw in ("omi-audio", "voice-call"):
        return "omi"
    if raw in ("openclaw_chat", "openclaw", "openclaw-session"):
        return "openclaw-chat"
    if raw in ("vexa-transcript", "vexa-meeting"):
        return "vexa"
    if raw in ("calendar", "google-calendar", "google_calendar"):
        return "gcal"
    if raw in ("plane-issue", "plane_issue", "plane-comment"):
        return "plane"
    if raw in ("vault-edit", "vault-record-edit"):
        return "vault_edit"
    if raw.startswith("sure"):
        return "sure"

    return "unknown"


def _gmail_sender_domain(event_dict: dict[str, Any]) -> str:
    """Extract the sender domain from a gmail stream-event record.

    Looks at frontmatter ``from`` first (set by the email template),
    then falls back to scanning the body for an ``**From**: ...`` line
    written by ``stream_vault._template_email``. Returns ``""`` when no
    domain can be located — caller treats that as "not a newsletter".
    """
    fm = event_dict.get("frontmatter") or {}
    if not isinstance(fm, dict):
        fm = {}

    sender_field = str(fm.get("from") or fm.get("sender") or "").strip()
    if not sender_field:
        # Body-scrape fallback for the "**From**: ..." line the email
        # template writes when frontmatter doesn't carry the sender.
        body = event_dict.get("content") or event_dict.get("body") or ""
        if isinstance(body, str):
            match = re.search(
                r"\*\*From\*\*:\s*(.+)", body, flags=re.IGNORECASE
            )
            if match:
                sender_field = match.group(1).strip()

    if not sender_field:
        return ""

    # Email may be `"Name" <addr@domain>` or just `addr@domain`.
    addr_match = re.search(r"<([^>]+)>", sender_field)
    addr = addr_match.group(1) if addr_match else sender_field
    if "@" not in addr:
        return ""
    return addr.rsplit("@", 1)[-1].strip().lower()


def _event_body(event_dict: dict[str, Any]) -> str:
    """Return the event's body text — preferring ``content`` over ``body``.

    ctrl-api's ``GET /api/v1/vault/records/<path>`` returns
    ``content`` (the rendered markdown body) and ``frontmatter``
    (the parsed YAML). Older callers used ``body`` so we fall through
    to that for compatibility.
    """
    body = event_dict.get("content")
    if not isinstance(body, str) or not body:
        body = event_dict.get("body")
    if not isinstance(body, str):
        return ""
    return body


def _event_created_dt(event_dict: dict[str, Any]) -> "datetime | None":
    """Parse the event's ``created`` frontmatter into a tz-aware datetime.

    Returns None when the field is missing or unparseable — callers
    should treat that as "no age signal available" and not block on it.
    """
    fm = event_dict.get("frontmatter") or {}
    if not isinstance(fm, dict):
        return None
    raw = fm.get("created")
    if raw is None:
        return None
    return _parse_iso_or_none(str(raw))


def _pre_filter(event_dict: dict[str, Any]) -> tuple[bool, str]:
    """Decide whether to send this event to the LLM.

    Returns ``(True, "")`` when accepted, ``(False, reason)`` when
    rejected. ``reason`` is the human-readable why-skipped, logged at
    INFO so we can audit drop rates without DEBUG noise.

    Rejection criteria:
      * source_type NOT in PRE_FILTER_ALLOWLIST (incl. "unknown")
      * body length < MIN_CONTENT_LENGTH characters
      * gmail event whose sender domain is in NEWSLETTER_BLOCKLIST

    The order matters — source-type check first because a malformed
    or misclassified record is the cheapest to reject.
    """
    is_garbage, garbage_reason = _is_garbage_event(event_dict)
    if is_garbage:
        return False, garbage_reason

    is_old, age_reason = _is_too_old(event_dict)
    if is_old:
        return False, age_reason

    src_type = _infer_source_type(event_dict)
    if src_type not in PRE_FILTER_ALLOWLIST:
        return False, f"source_type not in allowlist: {src_type!r}"

    body = _event_body(event_dict)
    if len(body.strip()) < MIN_CONTENT_LENGTH:
        return False, (
            f"body too short ({len(body.strip())} < {MIN_CONTENT_LENGTH})"
        )

    if src_type == "gmail":
        domain = _gmail_sender_domain(event_dict)
        if domain and any(
            domain == blocked or domain.endswith("." + blocked)
            for blocked in NEWSLETTER_BLOCKLIST
        ):
            return False, f"newsletter blocklist hit: {domain}"

    # gcal staleness: a calendar event from 6 months ago is a meeting
    # that already happened — there's nothing to action retroactively.
    # We drop these at pre-filter so the backfill doesn't burn LLM
    # cycles classifying historical attendance as noise. Threshold is
    # env-overridable for tenants who want a different horizon.
    if src_type == "gcal":
        max_age_days_raw = __import__("os").environ.get(
            "STEWARD_SIGNAL_GCAL_MAX_AGE_DAYS", "30"
        )
        try:
            max_age_days = int(max_age_days_raw)
        except (TypeError, ValueError):
            max_age_days = 30
        if max_age_days > 0:
            created = _event_created_dt(event_dict)
            if created is not None:
                from datetime import timedelta
                cutoff = datetime.now(timezone.utc) - timedelta(
                    days=max_age_days
                )
                if created < cutoff:
                    age_days = (
                        datetime.now(timezone.utc) - created
                    ).days
                    return False, (
                        f"stale gcal event ({age_days}d old, "
                        f"cutoff {max_age_days}d)"
                    )

    return True, ""


def _extract_raw_quote(event_dict: dict[str, Any]) -> str:
    """Build the 200-char ground-truth excerpt preserved on the signal.

    This quote is what survives after the stream-event record itself
    is purged by T6.6's StreamEventPurgeWorkflow. The router (T6.3+)
    and any future re-evaluation only sees this quote — so the
    extractor has to pick the most semantically dense slice of the
    event body.

    Per-source-type strategy:
      * gmail — subject (from frontmatter) + first 150 chars of body
        snippet. The subject is load-bearing for email signal so we
        include it verbatim even if the budget gets tight.
      * slack — message text only; the "**Channel**: / **From**:"
        prefix is metadata, not signal.
      * omi / vexa / openclaw-chat — first 200 chars of the
        transcript body verbatim. Truncation at a word boundary if
        possible to avoid a mid-word slice.
      * everything else — first 200 chars of the body, word-boundary
        trimmed.

    Whitespace is collapsed to single spaces because frontmatter
    YAML doesn't round-trip newline-heavy quoted strings reliably
    (the ctrl-api PATCH path stringifies values).
    """
    src_type = _infer_source_type(event_dict)
    fm = event_dict.get("frontmatter") or {}
    if not isinstance(fm, dict):
        fm = {}
    body = _event_body(event_dict)

    if src_type == "gmail":
        subject = str(fm.get("subject") or "").strip()
        # The email template writes the snippet into the body after a
        # `**To**: ...` line; pull whatever's after that "blank line"
        # marker which the template uses to delimit headers from body.
        snippet = _strip_gmail_headers(body)
        chunks: list[str] = []
        if subject:
            chunks.append(subject)
        if snippet:
            chunks.append(snippet[:150])
        quote = " — ".join(chunks) if chunks else body[:RAW_QUOTE_MAX]
    elif src_type == "slack":
        # Slack template writes "**Channel**: / **From**: / \\n / text".
        # Anything after the first blank line within the rendered body
        # is the actual message text.
        quote = _after_first_blank_line(body) or body
    elif src_type in ("omi", "vexa", "openclaw-chat"):
        quote = body
    else:
        quote = body

    # Collapse whitespace for YAML-friendliness.
    quote = re.sub(r"\s+", " ", quote).strip()
    if len(quote) <= RAW_QUOTE_MAX:
        return quote

    # Word-boundary truncation. Prefer the last space within budget;
    # fall back to a hard slice if there's no space (e.g. a long URL).
    cut = quote[: RAW_QUOTE_MAX]
    last_space = cut.rfind(" ")
    if last_space > RAW_QUOTE_MAX - 40:
        cut = cut[:last_space]
    return cut.rstrip() + "…"


def _strip_gmail_headers(body: str) -> str:
    """Drop the rendered ``**From**: ... / **To**: ...`` header block.

    The email template emits a fixed prefix block followed by a blank
    line and then the snippet. Strip everything up to and including
    the first blank line.
    """
    if not body:
        return ""
    parts = re.split(r"\n\s*\n", body, maxsplit=1)
    return parts[1].strip() if len(parts) == 2 else body.strip()


def _after_first_blank_line(body: str) -> str:
    """Return the substring after the first blank line in ``body``.

    Used by Slack quote extraction; the slack template writes channel
    + sender headers, then a blank line, then the message text.
    """
    if not body:
        return ""
    parts = re.split(r"\n\s*\n", body, maxsplit=1)
    if len(parts) == 2:
        return parts[1].strip()
    return ""


# ---------------------------------------------------------------------------
# Helpers — target resolution
# ---------------------------------------------------------------------------

def _candidate_haystack(record: dict[str, Any]) -> str:
    """Build the ranking string for a single matter/task candidate.

    We rank against the union of (slug, name, title) so a target_hint
    of "shopify orders" can match either a task whose name is "Investigate
    Shopify duplicate orders" or whose slug is "shopify-orders-2026-04".
    Tags are NOT included — they're too generic to discriminate between
    candidates and inflate similarity scores spuriously.
    """
    parts: list[str] = []
    fm = record.get("frontmatter") or {}
    if not isinstance(fm, dict):
        fm = {}

    name = str(fm.get("name") or fm.get("title") or "").strip()
    if name:
        parts.append(name)

    path = str(record.get("path") or "").strip()
    if path:
        # Strip leading dir + trailing extension so the slug is what
        # contributes to the ranker.
        slug = path.rsplit("/", 1)[-1]
        if slug.endswith(".md"):
            slug = slug[:-3]
        # Slugs are kebab-case — turn dashes into spaces so the
        # SequenceMatcher sees them as word tokens.
        parts.append(slug.replace("-", " "))

    return " ".join(parts).lower()


def _rank_candidates(
    target_hint: str,
    records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Score and sort candidates by similarity to ``target_hint``.

    Uses ``difflib.SequenceMatcher`` ratio — 0.0..1.0. We use the
    "real_quick_ratio + ratio" two-stage trick implicitly via
    SequenceMatcher's default behaviour: it computes the ratio in one
    pass which is fast enough for the ≤500 candidates a single tenant
    usually has.

    Returns a list of ``{"path": ..., "score": float}`` sorted
    descending by score. Records with empty haystacks (no name, no
    slug) are dropped — they can't contribute to a meaningful match.
    """
    hint = target_hint.strip().lower()
    if not hint:
        return []

    scored: list[dict[str, Any]] = []
    for rec in records:
        haystack = _candidate_haystack(rec)
        if not haystack:
            continue
        score = difflib.SequenceMatcher(None, hint, haystack).ratio()
        path = str(rec.get("path") or "").strip()
        if not path:
            continue
        scored.append({"path": path, "score": round(score, 4)})

    scored.sort(key=lambda c: c["score"], reverse=True)
    return scored


async def _list_targets_of_kind(
    client: VaultClient, kind: str
) -> list[dict[str, Any]]:
    """List vault records of ``kind`` (one of ``"task"`` or ``"matter"``).

    Wraps ``VaultClient.list_records`` with a 500-record cap (matches
    the steward.load_matter_tasks pattern and the ctrl-api default
    page size). Errors propagate to the caller — a transient
    ctrl-api outage should retry rather than silently produce
    target_path=None which would force a human-disambiguation queue.
    """
    if kind not in ("task", "matter"):
        raise ValueError(f"_list_targets_of_kind: unsupported kind {kind!r}")
    # 500 cap — large enough for david's current task count (~80)
    # with headroom for a 5x growth before we need pagination.
    return await client.list_records(kind, limit=500)


async def _resolve_target(
    target_hint: str,
    target_kind_hint: str,
    *,
    client: VaultClient,
) -> dict[str, Any]:
    """Vault retrieval + ranking for the proposed target.

    Inputs come from the LLM's classification pass:
      * ``target_hint`` — free text the LLM thinks names the target
        (e.g. "shopify duplicate orders investigation").
      * ``target_kind_hint`` — the LLM's guess: "task" | "matter" |
        "" (unknown).

    Strategy:
      * If the kind is known, list only that kind.
      * Otherwise list both, score each side, pick the global winner.
      * Disambiguation: if top-2 are within TARGET_AMBIGUITY_BAND of
        each other, return target_path=None (router treats as
        needs-disambiguation).
      * Floor: if the top score is below TARGET_MATCH_FLOOR, also
        return target_path=None — there's no plausible match.

    Return shape::

        {
          "target_path": "task/<slug>.md" | "matter/<slug>.md" | None,
          "target_kind": "task" | "matter" | None,
          "target_confidence": 0.0..1.0,
          "candidates": [{"path": ..., "score": ...}, ...],
          "ambiguous": bool,
        }
    """
    hint = (target_hint or "").strip()
    kind_hint = (target_kind_hint or "").strip().lower()

    if not hint:
        return {
            "target_path": None,
            "target_kind": None,
            "target_confidence": 0.0,
            "candidates": [],
            "ambiguous": False,
        }

    if kind_hint in ("task", "matter"):
        records = await _list_targets_of_kind(client, kind_hint)
        ranked = _rank_candidates(hint, records)
        ranked_kinds: list[tuple[dict[str, Any], str]] = [
            (r, kind_hint) for r in ranked
        ]
    else:
        # No kind hint — score across both pools and let the global
        # winner decide. We track the kind alongside each candidate so
        # we can return it on the final shape.
        try:
            tasks = await _list_targets_of_kind(client, "task")
        except httpx.HTTPError as exc:
            logger.warning(
                "signals._resolve_target: list task failed: %s — continuing with matter only",
                exc,
            )
            tasks = []
        try:
            matters = await _list_targets_of_kind(client, "matter")
        except httpx.HTTPError as exc:
            logger.warning(
                "signals._resolve_target: list matter failed: %s — continuing with task only",
                exc,
            )
            matters = []

        scored_tasks = _rank_candidates(hint, tasks)
        scored_matters = _rank_candidates(hint, matters)
        ranked_kinds = [(r, "task") for r in scored_tasks] + [
            (r, "matter") for r in scored_matters
        ]
        ranked_kinds.sort(key=lambda rk: rk[0]["score"], reverse=True)
        ranked = [r for r, _ in ranked_kinds]

    if not ranked_kinds:
        return {
            "target_path": None,
            "target_kind": None,
            "target_confidence": 0.0,
            "candidates": [],
            "ambiguous": False,
        }

    # Build the candidate audit list — top-N including the kind so
    # downstream debugging can see why a particular target won.
    candidates_audit: list[dict[str, Any]] = []
    for rec, kind in ranked_kinds[:TARGET_CANDIDATE_LIMIT]:
        candidates_audit.append(
            {"path": rec["path"], "score": rec["score"], "kind": kind}
        )

    top_rec, top_kind = ranked_kinds[0]
    top_score: float = float(top_rec["score"])

    # Floor check — top match too weak to claim.
    if top_score < TARGET_MATCH_FLOOR:
        return {
            "target_path": None,
            "target_kind": None,
            "target_confidence": 0.0,
            "candidates": candidates_audit,
            "ambiguous": False,
        }

    # Ambiguity check — top-2 within the band.
    ambiguous = False
    if len(ranked_kinds) >= 2:
        runner_score = float(ranked_kinds[1][0]["score"])
        if (top_score - runner_score) < TARGET_AMBIGUITY_BAND:
            ambiguous = True

    if ambiguous:
        return {
            "target_path": None,
            "target_kind": None,
            "target_confidence": 0.0,
            "candidates": candidates_audit,
            "ambiguous": True,
        }

    return {
        "target_path": top_rec["path"],
        "target_kind": top_kind,
        "target_confidence": top_score,
        "candidates": candidates_audit,
        "ambiguous": False,
    }


# ---------------------------------------------------------------------------
# Helpers — LLM response validation
# ---------------------------------------------------------------------------

def _coerce_float(value: Any, default: float = 0.0) -> float:
    """Best-effort float coercion for LLM-returned confidence fields.

    LLMs sometimes return confidence as a string ("0.8") or as a
    percentage ("80"). Clamp the result to [0.0, 1.0] so a bad
    response can't poison downstream gates.
    """
    if value is None:
        return default
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    if f != f:  # NaN check
        return default
    if f > 1.0 and f <= 100.0:
        # LLM emitted a 0-100 percentage; rescale.
        f = f / 100.0
    if f < 0.0:
        return 0.0
    if f > 1.0:
        return 1.0
    return f


def _validate_llm_classification(
    raw: dict[str, Any] | str | None,
) -> dict[str, Any] | None:
    """Validate the LLM extraction response into a typed dict.

    The clerk path (``_call_clerk(prompt, raw=False)``) already runs
    JSON extraction so we typically receive a dict. We still defend
    against the malformed-response case (``str`` returned, fields
    missing, ``effect`` outside the enum) — it costs nothing and
    means a bad LLM run produces ``None`` (signal dropped) instead
    of a downstream ``KeyError``.

    Returns ``None`` when the response is unusable. Caller treats
    that as "extraction failed; drop signal".
    """
    if raw is None:
        return None
    if isinstance(raw, str):
        # _call_clerk(raw=False) shouldn't produce this but guard
        # against it — a malformed JSON path can return the raw text.
        try:
            raw = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
    if not isinstance(raw, dict):
        return None

    effect = str(raw.get("effect") or "").strip().lower()
    if effect not in ("mutation", "action", "none"):
        return None

    # Noise classification → caller drops the signal entirely.
    if effect == "none":
        return {
            "effect": "none",
            "effect_confidence": _coerce_float(
                raw.get("effect_confidence"), default=0.0
            ),
            "reasoning": str(raw.get("reasoning") or "")[:1000],
            "target_kind_hint": "",
            "target_hint": "",
            "mutation_proposal": None,
            "action_proposal": None,
            "display_headline": None,
            "display_body": None,
        }

    target_hint = str(raw.get("target_hint") or "").strip()
    # Phase 6.7 — the prompt schema names this field ``target_kind``.
    # Older versions of the validator looked at ``target_kind_hint``
    # which the LLM never emits, so the kind hint was always lost and
    # ``_resolve_target`` had to guess across both pools. We read
    # ``target_kind`` first (matching the documented schema) and fall
    # through to ``target_kind_hint`` for backwards compat.
    target_kind_hint = (
        str(raw.get("target_kind") or raw.get("target_kind_hint") or "")
        .strip()
        .lower()
    )
    if target_kind_hint not in ("task", "matter", ""):
        target_kind_hint = ""

    mutation_proposal = raw.get("mutation_proposal")
    if not isinstance(mutation_proposal, dict):
        mutation_proposal = None
    action_proposal = raw.get("action_proposal")
    if not isinstance(action_proposal, dict):
        action_proposal = None

    if effect == "mutation" and mutation_proposal is None:
        # An effect=mutation with no proposal is structurally invalid.
        return None
    if effect == "action" and action_proposal is None:
        return None

    # Surface-voice fields — added to the prompt schema so signals
    # carry display_headline + display_body that read like Alfred,
    # not like a router. Optional + bounded for safety:
    # - None when the LLM omits them (e.g. older replay paths)
    # - Trimmed strings up to a hard cap so a verbose LLM run can't
    #   blow up the YAML frontmatter on a needs-attention card.
    def _coerce_voice(value: Any, cap: int) -> str | None:
        if not isinstance(value, str):
            return None
        s = value.strip()
        return s[:cap] if s else None

    return {
        "effect": effect,
        "effect_confidence": _coerce_float(
            raw.get("effect_confidence"), default=0.5
        ),
        "reasoning": str(raw.get("reasoning") or "")[:1000],
        "target_kind_hint": target_kind_hint,
        "target_hint": target_hint,
        "mutation_proposal": mutation_proposal,
        "action_proposal": action_proposal,
        "display_headline": _coerce_voice(raw.get("display_headline"), 200),
        "display_body": _coerce_voice(raw.get("display_body"), 600),
    }


# ---------------------------------------------------------------------------
# Activity: extract_signal_from_event
# ---------------------------------------------------------------------------

@activity.defn
async def extract_signal_from_event(
    stream_event_path: str,
) -> dict[str, Any] | None:
    """Convert one stream event vault record into a signal proposal.

    Returns a signal dict (NOT yet written to vault — that's
    ``write_signal_record``'s job in T6.0.3) or ``None`` if the event
    is pre-filtered as noise OR the LLM classifies it as
    ``effect="none"``.

    Pipeline:
      1. Read the stream event via ``VaultClient.read_record``.
      2. Pre-filter: source allowlist + min content length +
         newsletter sender blocklist. Return ``None`` on reject.
      3. Build the prompt by combining
         ``src.utils.signal_prompts.build_signal_extraction_prompt``'s
         system + user sections (lands in T6.0.2).
      4. Call ``_call_clerk(prompt, raw=False)``.
      5. Validate the LLM JSON. If ``effect="none"`` or malformed,
         return ``None``.
      6. Resolve the target via ``_resolve_target`` — string-similarity
         ranking against ``task/`` + ``matter/`` records listed via
         ctrl-api. Surveyor-embedding refinement is T6.0.7.
      7. Assemble + return the signal dict.

    Errors:
      * stream event missing or 404 → log warning, return ``None``.
      * LLM call failure → log warning, return ``None``. The workflow
        (T6.0.5) processes events one-at-a-time so one bad event
        shouldn't poison the batch.
      * Target resolution http error → propagate. A persistent
        ctrl-api outage should bubble up to Temporal's retry
        mechanism rather than silently emit signals with
        target_path=None (which the router would queue for human
        review and clutter Sir's inbox).
    """
    # Lazy import — keeps the prompts module's optional imports out
    # of the activity-registration path so a missing dep in
    # signal_prompts can't break worker startup. T6.0.2 ships the
    # module; until then ImportError surfaces here cleanly.
    from src.utils.signal_prompts import build_signal_extraction_prompt
    from src.activities.clerk import _call_clerk

    if not stream_event_path or not isinstance(stream_event_path, str):
        logger.warning(
            "signals.extract_signal_from_event: empty/invalid path %r",
            stream_event_path,
        )
        return None

    cfg = load_config()
    client = VaultClient(cfg)
    try:
        # 1. Read the stream event.
        try:
            event = await client.read_record(stream_event_path)
        except httpx.HTTPStatusError as exc:
            if exc.response is not None and exc.response.status_code == 404:
                logger.warning(
                    "signals.extract_signal_from_event: 404 on path=%s — record vanished",
                    stream_event_path,
                )
                return None
            logger.warning(
                "signals.extract_signal_from_event: read failed path=%s err=%s",
                stream_event_path, exc,
            )
            return None
        except httpx.HTTPError as exc:
            logger.warning(
                "signals.extract_signal_from_event: read failed path=%s err=%s",
                stream_event_path, exc,
            )
            return None

        if not isinstance(event, dict):
            logger.warning(
                "signals.extract_signal_from_event: unexpected record shape path=%s type=%s",
                stream_event_path, type(event).__name__,
            )
            return None

        # 2. Pre-filter.
        accepted, reason = _pre_filter(event)
        if not accepted:
            logger.info(
                "signals.extract_signal_from_event: pre-filtered path=%s reason=%s",
                stream_event_path, reason,
            )
            return None

        # 2b. Noise-pattern filter — upstream of the LLM call. If the
        # principal has flagged a previous event with this signature
        # as noise, suppress the signal entirely. The mark_processed
        # call downstream still runs (in the workflow) so we don't
        # re-LLM next tick. Cost of this filter: cached vault read +
        # one signature derive per event. The pattern cache is shared
        # across all events in a tick (TTL 60s).
        try:
            from src.activities.noise_patterns import (
                load_active_noise_patterns,
                event_matches_noise,
                # OBS-8 — new noise pre-filter path via instincts. Reads
                # active instincts where intent_key=noise (OBS-5's
                # acceptor output) and uses their sender_domains globs
                # to suppress matching events. Runs alongside the
                # legacy signal_noise_pattern filter until those age
                # out.
                load_noise_instincts,
                event_matches_noise_instinct,
            )
            event_fm_for_match = event.get("frontmatter") or {}
            if not isinstance(event_fm_for_match, dict):
                event_fm_for_match = {}

            # Legacy filter — signal_noise_pattern records that pre-
            # date OBS-8. New Noise clicks no longer write these
            # (see decision_router.py); existing records keep filtering
            # until Sir disables them or they age out.
            patterns = await load_active_noise_patterns()
            if patterns and event_fm_for_match:
                matched = event_matches_noise(event_fm_for_match, patterns)
                if matched is not None:
                    logger.info(
                        "signals.extract_signal_from_event: NOISE-FILTERED "
                        "(legacy pattern) path=%s sig=%s/%s pattern=%s",
                        stream_event_path,
                        matched.get("kind"),
                        matched.get("value"),
                        matched.get("path"),
                    )
                    return None

            # OBS-8 path — active noise instincts.
            noise_instincts = await load_noise_instincts()
            if noise_instincts and event_fm_for_match:
                matched = event_matches_noise_instinct(
                    event_fm_for_match, noise_instincts,
                )
                if matched is not None:
                    logger.info(
                        "signals.extract_signal_from_event: NOISE-FILTERED "
                        "(instinct) path=%s sig=%s/%s glob=%s instinct=%s",
                        stream_event_path,
                        matched.get("kind"),
                        matched.get("value"),
                        matched.get("matched_glob"),
                        matched.get("path"),
                    )
                    return None
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "signals.extract_signal_from_event: noise check failed "
                "(continuing to extract) path=%s err=%s",
                stream_event_path, exc,
            )

        source_type = _infer_source_type(event)
        raw_quote = _extract_raw_quote(event)

        # 3. Build the prompt (T6.0.2 module).
        prompt = build_signal_extraction_prompt(
            source_type=source_type,
            event_frontmatter=event.get("frontmatter") or {},
            event_body=_event_body(event),
            raw_quote=raw_quote,
        )

        # 4. Clerk call. Phase 6.7 — retry transient session-limit
        # errors ("max active children" / "Could not get session key")
        # with bounded exponential backoff. These errors fire when many
        # extractions run concurrently against an openclaw with a
        # 5-active-children session cap; without retry every burst
        # produced a dropped signal. We retry up to 3 times with
        # 5s/15s/45s sleeps — long enough for in-flight clerk
        # subagents to finish and free a slot, short enough to fit
        # comfortably in the 600s activity timeout.
        import asyncio as _asyncio
        retry_delays = (3.0, 8.0, 20.0)
        llm_raw: Any = None
        last_exc: Exception | None = None
        for attempt, delay in enumerate([0.0] + list(retry_delays)):
            if delay:
                await _asyncio.sleep(delay)
            try:
                llm_raw = await _call_clerk(prompt, raw=False)
                last_exc = None
                break
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                err_text = str(exc)
                # Retry only the rate-limit / session-spawn classes;
                # everything else (timeout, billing, malformed JSON)
                # is unlikely to recover from a wait.
                if not any(
                    needle in err_text for needle in (
                        "max active children",
                        "Could not get session key",
                        "sessions_spawn has reached",
                    )
                ):
                    break
                logger.info(
                    "signals.extract_signal_from_event: clerk rate-limited "
                    "path=%s attempt=%d delay_next=%.1fs",
                    stream_event_path,
                    attempt + 1,
                    retry_delays[attempt] if attempt < len(retry_delays) else 0,
                )

        if last_exc is not None:
            # CRITICAL: raise instead of returning None. Returning None
            # is the workflow's signal for "LLM classified as noise" —
            # which would mark the event permanently processed. When the
            # LLM provider is down (OpenRouter timeout, MiniMax outage,
            # rate-limit) we want Temporal to retry the activity on the
            # next chunk OR the next tick, NOT bury the event as noise.
            # The workflow's per-event try/except catches this as
            # ``extract_failed`` and (correctly) does NOT mark the event,
            # so the next tick re-tries it cleanly.
            logger.warning(
                "signals.extract_signal_from_event: clerk call failed path=%s err=%s",
                stream_event_path, last_exc,
            )
            raise RuntimeError(
                f"clerk call failed for {stream_event_path}: {last_exc}"
            )

        # 5. Validate response.
        classification = _validate_llm_classification(llm_raw)
        if classification is None:
            logger.error(
                "signals.extract_signal_from_event: malformed clerk response path=%s raw_type=%s",
                stream_event_path, type(llm_raw).__name__,
            )
            return None

        if classification["effect"] == "none":
            logger.info(
                "signals.extract_signal_from_event: classified as noise path=%s",
                stream_event_path,
            )
            return None

        # 6. Target resolution.
        try:
            resolved = await _resolve_target(
                classification["target_hint"],
                classification["target_kind_hint"],
                client=client,
            )
        except httpx.HTTPError:
            # Re-raise — the activity's retry policy should handle
            # transient ctrl-api outages. If we silently produced a
            # target_path=None signal Sir would see a flood of
            # needs-disambiguation entries during a ctrl-api blip.
            raise

        # 6b. Phase 6.5 (T6.5.2) — auto-create a task when target
        # resolution found no match AND the signal carries an
        # actionable / mutating effect. We only invoke this for
        # effect ∈ {"action", "mutation"} (NOT "none"); the
        # ``create_task_from_signal`` activity itself layers the env
        # gate (STEWARD_SIGNAL_AUTOCREATE_TASKS) and the idempotency
        # cache so a disabled tenant or a previously-seen event is a
        # cheap no-op.
        if (
            resolved.get("target_kind") is None
            and resolved.get("target_path") is None
            and classification["effect"] in ("action", "mutation")
        ):
            # Lazy import — keeps task_creation's heavy deps out of
            # the activity-registration path so a future change there
            # can't break worker startup.
            from src.activities.task_creation import create_task_from_signal

            try:
                provisional_signal: dict[str, Any] = {
                    "source_event_path": stream_event_path,
                    "source_type": source_type,
                    "raw_quote": raw_quote,
                    "effect": classification["effect"],
                    "mutation_proposal": classification["mutation_proposal"],
                    "action_proposal": classification["action_proposal"],
                    "effect_confidence": classification["effect_confidence"],
                    "reasoning": classification["reasoning"],
                }
                new_task_path = await create_task_from_signal(
                    provisional_signal
                )
            except Exception as exc:  # noqa: BLE001
                # Auto-creation must NEVER block the signal pipeline.
                # Log + drop so the signal still gets written with
                # target_path=None; Sir's signal isn't lost.
                logger.warning(
                    "signals.extract_signal_from_event: auto-create raised "
                    "path=%s err=%s — falling through to no-target signal",
                    stream_event_path, exc,
                )
                new_task_path = None

            if new_task_path:
                # Newly created (or idempotency-cached) task → stamp it
                # as the signal's target. target_confidence=1.0 since
                # the target was MATERIALIZED from this exact signal —
                # there's no ambiguity; the resolution is exact by
                # construction.
                resolved = {
                    "target_path": new_task_path,
                    "target_kind": "task",
                    "target_confidence": 1.0,
                    "candidates": resolved.get("candidates") or [],
                    "ambiguous": False,
                }
                logger.info(
                    "signals.extract_signal_from_event: auto-created task "
                    "path=%s -> task=%s",
                    stream_event_path, new_task_path,
                )

        # 7. Phase 6.7 (T6.7.4) — apply per-source-type confidence prior.
        # The LLM's reported confidence is stamped as ``effect_confidence_raw``
        # and the prior-adjusted value goes on ``effect_confidence``. The
        # downstream router thresholds (T6.3) consume the adjusted value;
        # the calibration loop (T6.7.5) uses the raw value to recover what
        # the LLM said vs what we used.
        adjusted_conf, raw_conf, prior_key = _apply_source_prior(
            source_type, event, classification["effect_confidence"]
        )

        # 8. Assemble signal dict.
        # origin_at = when the underlying real-world thing happened
        # (email arrival, calendar event time, voice note recorded).
        # NOT when Alfred extracted it. The principal cares about the
        # event's date, not Alfred's processing time — a card surfaced
        # today about an email from May 1st should display May 1st.
        # Falls through: event.created → event.enriched_at → now.
        event_fm = (event.get("frontmatter") if isinstance(event, dict) else {}) or {}
        if not isinstance(event_fm, dict):
            event_fm = {}
        origin_raw = (
            event_fm.get("created")
            or event_fm.get("enriched_at")
            or _now_utc_iso()
        )
        # Coerce to string, then to a canonical ISO if possible.
        try:
            from datetime import datetime as _dt
            origin_dt = _dt.fromisoformat(
                str(origin_raw).strip().replace("Z", "+00:00")
            )
            origin_at = origin_dt.isoformat()
        except (ValueError, TypeError):
            # gcal events use RFC-822 strings like "Wed, 8 Apr 2026 11:36:55 +0200".
            try:
                from email.utils import parsedate_to_datetime
                origin_at = parsedate_to_datetime(str(origin_raw)).isoformat()
            except Exception:  # noqa: BLE001
                # Unparseable — keep the raw string; consumer can still
                # surface it even if it can't sort.
                origin_at = str(origin_raw) if origin_raw else _now_utc_iso()

        signal: dict[str, Any] = {
            "source_event_path": stream_event_path,
            "source_type": source_type,
            "raw_quote": raw_quote,
            "origin_at": origin_at,
            "target_kind": resolved["target_kind"],
            "target_path": resolved["target_path"],
            "target_confidence": resolved["target_confidence"],
            "target_candidates": resolved["candidates"],
            "target_ambiguous": resolved["ambiguous"],
            "effect": classification["effect"],
            "mutation_proposal": classification["mutation_proposal"],
            "action_proposal": classification["action_proposal"],
            "effect_confidence": adjusted_conf,
            "effect_confidence_raw": raw_conf,
            "effect_confidence_prior_key": prior_key,
            "reasoning": classification["reasoning"],
            # Voiced surface fields — surfaced on /desk when this
            # signal becomes a needs-attention card. Optional; older
            # signals from before the prompt extension just have None.
            "display_headline": classification.get("display_headline"),
            "display_body": classification.get("display_body"),
            "created_at": _now_utc_iso(),
        }

        logger.info(
            "signals.extract_signal_from_event: extracted path=%s "
            "source_type=%s effect=%s target=%s "
            "confidence=%.2f raw=%.2f prior_key=%s ambiguous=%s",
            stream_event_path,
            source_type,
            signal["effect"],
            signal["target_path"],
            signal["effect_confidence"],
            signal["effect_confidence_raw"],
            signal["effect_confidence_prior_key"],
            signal["target_ambiguous"],
        )
        return signal
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Helpers — write_signal_record support
# ---------------------------------------------------------------------------

# Fallback used when a signal proposal arrives without created_at (defensive
# only — extract_signal_from_event always stamps the field). The slug must
# still be deterministic in that pathological case so retries don't double
# write, so we hash the source_event_path + raw_quote alone.
_DEFAULT_FALLBACK_TS = "1970-01-01T00-00-00Z"


def _slug_timestamp(created_at: str) -> str:
    """Convert an ISO8601 ``created_at`` to a filename-safe timestamp slice.

    The ``extract_signal_from_event`` activity stamps ``created_at`` via
    ``_now_utc_iso`` which produces e.g. ``"2026-05-06T12:30:15+00:00"``.
    Filenames can't contain ``:`` on macOS/Windows checkouts and the
    ``+00:00`` UTC suffix is just visual noise, so we collapse:

      ``2026-05-06T12:30:15+00:00`` → ``2026-05-06T12-30-15Z``

    The rule is: ``:`` → ``-`` and ``+00:00`` → ``Z``. Anything we don't
    recognize falls through unchanged after a final pass that strips
    characters outside the safe filename charset (alnum + ``T``, ``-``,
    ``Z``). The output is always non-empty so the slug builder can rely
    on it.
    """
    ts = (created_at or "").strip()
    if not ts:
        return _DEFAULT_FALLBACK_TS
    ts = ts.replace("+00:00", "Z").replace(":", "-")
    # Final scrub — keep only filesystem-safe characters. Anything else
    # collapses to ``-`` so the slug stays parseable on every platform.
    ts = re.sub(r"[^A-Za-z0-9TZ\-]", "-", ts)
    return ts or _DEFAULT_FALLBACK_TS


def _signal_short_hash(source_event_path: str, raw_quote: str) -> str:
    """Stable 8-char content hash for signal slug uniqueness.

    Combines ``source_event_path`` + ``raw_quote`` so two distinct
    signals extracted from the same event (theoretically possible if a
    future LLM run finds two distinct quotes) get distinct slugs. The
    same ``(path, quote)`` pair always hashes identically, which is the
    property that makes write_signal_record idempotent under Temporal
    activity retry.
    """
    digest_input = f"{source_event_path or ''}\x00{raw_quote or ''}".encode(
        "utf-8", errors="replace"
    )
    return hashlib.sha256(digest_input).hexdigest()[:8]


def _build_signal_slug(signal: dict[str, Any]) -> str:
    """Compose ``<ts_filename>-<short_hash>`` for the signal vault record.

    Deterministic from signal content — required for idempotent retries.
    Returns just the basename (no ``signal/`` prefix, no ``.md`` suffix);
    VaultClient.write_record adds those.
    """
    ts_part = _slug_timestamp(str(signal.get("created_at") or ""))
    short_hash = _signal_short_hash(
        str(signal.get("source_event_path") or ""),
        str(signal.get("raw_quote") or ""),
    )
    return f"{ts_part}-{short_hash}"


def _yaml_block_scalar(value: str, indent: int = 2) -> str:
    """Render ``value`` as a YAML literal block scalar (``|``).

    Used for fields like ``raw_quote`` and ``reasoning`` where the
    string can contain colons, quotes, or other YAML metacharacters
    that would force fragile escaping in inline form. The block scalar
    is the simplest unambiguous YAML representation and round-trips
    losslessly through the ctrl-api YAML parser.

    Returns just the lines after the ``|`` indicator, indented by
    ``indent`` spaces. The caller writes the leading ``key: |\n``.
    """
    pad = " " * indent
    if not value:
        # Empty literal block — write a single empty line so YAML parses
        # the value as ``""`` rather than null.
        return f"{pad}"
    lines = value.splitlines() or [value]
    return "\n".join(f"{pad}{line}" for line in lines)


def _yaml_inline_str(value: str) -> str:
    """Render ``value`` as a single-quoted YAML scalar.

    Single quotes are the safest YAML inline form: only ``'`` itself
    needs escaping (doubled), everything else passes through verbatim.
    Used for short scalar frontmatter values where a block scalar would
    be over-engineered (e.g. ``source_type: 'gmail'``).
    """
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def _yaml_target_candidates(
    candidates: list[dict[str, Any]] | None,
) -> str:
    """Render the ``target_candidates`` list as a YAML flow-style array.

    Each candidate is a ``{path, score, kind}`` dict; we emit them as
    a YAML block sequence so a human reading the signal record can
    eyeball the ranking at a glance. Empty list renders as ``[]``.
    """
    if not candidates:
        return "[]"
    lines: list[str] = []
    for cand in candidates:
        path = str(cand.get("path") or "")
        try:
            score = float(cand.get("score") or 0.0)
        except (TypeError, ValueError):
            score = 0.0
        kind = str(cand.get("kind") or "")
        lines.append(
            f"  - path: {_yaml_inline_str(path)}\n"
            f"    score: {score:.4f}\n"
            f"    kind: {_yaml_inline_str(kind)}"
        )
    # Leading newline so the caller writes ``key:\n<entries>`` cleanly.
    return "\n" + "\n".join(lines)


def _yaml_proposal(value: dict[str, Any] | None) -> str:
    """Render an LLM-supplied proposal dict as YAML flow JSON.

    ``mutation_proposal`` and ``action_proposal`` are open-ended dicts
    whose keys depend on the effect type (router-defined). To keep the
    signal record schema stable without hand-writing a recursive YAML
    encoder, we emit them as JSON inline — every YAML parser accepts
    JSON as a subset, and ctrl-api's parser preserves the structure
    end-to-end through ``patch_frontmatter_structured`` for downstream
    routing.
    """
    if value is None:
        return "null"
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        # Worst case: stringify so the YAML still parses, even if the
        # router can't reconstitute structure. The router will log + skip.
        return _yaml_inline_str(repr(value))


def _build_signal_frontmatter(signal: dict[str, Any]) -> str:
    """Construct the YAML frontmatter block for a signal vault record.

    Output is the full ``---\\n...\\n---`` block with a trailing newline,
    ready to be concatenated with the body. Field order matches the
    SPEC: type / created / source_* / target_* / effect_* / reasoning /
    status fields. The status fields are stamped as ``unrouted`` /
    ``null`` so the SignalRouterWorkflow (T6.3.x) can locate them via
    ``frontmatter.status == "unrouted"``.
    """
    target_kind = signal.get("target_kind")
    target_path = signal.get("target_path")
    target_kind_yaml = (
        _yaml_inline_str(str(target_kind)) if target_kind else "null"
    )
    target_path_yaml = (
        _yaml_inline_str(str(target_path)) if target_path else "null"
    )
    target_confidence = float(signal.get("target_confidence") or 0.0)
    target_ambiguous = bool(signal.get("target_ambiguous"))
    effect_confidence = float(signal.get("effect_confidence") or 0.0)
    # Phase 6.7 (T6.7.4) — preserve the LLM's pre-prior reading and the
    # prior-table key on the vault record so the calibration loop can
    # later compare LLM output against what we actually used.
    effect_confidence_raw = signal.get("effect_confidence_raw")
    effect_confidence_prior_key = signal.get("effect_confidence_prior_key") or ""
    raw_quote = str(signal.get("raw_quote") or "")
    reasoning = str(signal.get("reasoning") or "")

    lines: list[str] = ["---"]
    lines.append("type: signal")
    lines.append(
        f"created: {_yaml_inline_str(str(signal.get('created_at') or ''))}"
    )
    lines.append(
        "source_event_path: "
        f"{_yaml_inline_str(str(signal.get('source_event_path') or ''))}"
    )
    # origin_at: when the underlying real-world thing happened (email
    # arrival, calendar event, voice note). Distinct from `created`
    # (= signal extraction time, i.e. Alfred's clock). Cards and audit
    # surfaces should show origin_at for "arrived" — the principal
    # cares about the source's date, not Alfred's processing latency.
    origin_at_v = signal.get("origin_at")
    if isinstance(origin_at_v, str) and origin_at_v.strip():
        lines.append(f"origin_at: {_yaml_inline_str(origin_at_v.strip())}")
    lines.append(
        "source_type: "
        f"{_yaml_inline_str(str(signal.get('source_type') or ''))}"
    )
    lines.append("raw_quote: |")
    lines.append(_yaml_block_scalar(raw_quote, indent=2))
    lines.append(f"target_kind: {target_kind_yaml}")
    lines.append(f"target_path: {target_path_yaml}")
    lines.append(f"target_confidence: {target_confidence:.4f}")
    candidates_yaml = _yaml_target_candidates(
        signal.get("target_candidates") or []
    )
    if candidates_yaml == "[]":
        lines.append("target_candidates: []")
    else:
        lines.append("target_candidates:" + candidates_yaml)
    lines.append(
        "target_ambiguous: " + ("true" if target_ambiguous else "false")
    )
    lines.append(
        "effect: "
        f"{_yaml_inline_str(str(signal.get('effect') or ''))}"
    )
    lines.append(
        "mutation_proposal: "
        f"{_yaml_proposal(signal.get('mutation_proposal'))}"
    )
    lines.append(
        "action_proposal: "
        f"{_yaml_proposal(signal.get('action_proposal'))}"
    )
    lines.append(f"effect_confidence: {effect_confidence:.4f}")
    # T6.7.4 — calibration audit fields. Defensive against legacy
    # signals (older callers pre-T6.7.4 won't have these set on the
    # dict). When raw is missing we omit the line entirely so YAML
    # round-tripping doesn't drift on existing records.
    if effect_confidence_raw is not None:
        try:
            raw_f = float(effect_confidence_raw)
        except (TypeError, ValueError):
            raw_f = 0.0
        lines.append(f"effect_confidence_raw: {raw_f:.4f}")
    if effect_confidence_prior_key:
        lines.append(
            "effect_confidence_prior_key: "
            f"{_yaml_inline_str(effect_confidence_prior_key)}"
        )
    lines.append("reasoning: |")
    lines.append(_yaml_block_scalar(reasoning, indent=2))
    # Voiced surface fields — only emitted when the LLM actually
    # produced them (skipped silently on legacy / replay paths so
    # old signal YAMLs don't drift).
    display_headline = signal.get("display_headline")
    display_body = signal.get("display_body")
    if isinstance(display_headline, str) and display_headline.strip():
        lines.append("display_headline: |")
        lines.append(_yaml_block_scalar(display_headline, indent=2))
    if isinstance(display_body, str) and display_body.strip():
        lines.append("display_body: |")
        lines.append(_yaml_block_scalar(display_body, indent=2))
    # Router-managed status fields, stamped to known initial state so
    # ``signal_router`` can locate them via a frontmatter filter.
    lines.append("status: unrouted")
    lines.append("applied_at: null")
    lines.append("audit_record_path: null")
    lines.append("---")
    lines.append("")
    return "\n".join(lines)


def _build_signal_body(signal: dict[str, Any]) -> str:
    """Compose the human-readable body of a signal vault record.

    The body is what Sir reads when a signal record surfaces in a
    review queue or audit thread. Three short paragraphs:

      1. Source — where the signal came from (path + source_type).
      2. Effect — the proposed effect + LLM reasoning.
      3. Raw quote — preserved post stream-event purge.

    Kept terse and non-redundant with the frontmatter (which carries
    the same data structurally for machine consumption). The body's
    job is to make the record skimmable in the vault file browser.
    """
    source_event_path = str(signal.get("source_event_path") or "")
    source_type = str(signal.get("source_type") or "")
    effect = str(signal.get("effect") or "")
    reasoning = str(signal.get("reasoning") or "")
    raw_quote = str(signal.get("raw_quote") or "")
    target_path = signal.get("target_path")

    paragraphs: list[str] = []

    # 1. Source.
    if source_event_path:
        paragraphs.append(
            f"Source: {source_type or 'unknown'} stream event at "
            f"`{source_event_path}`."
        )
    else:
        paragraphs.append(
            f"Source: {source_type or 'unknown'} stream event."
        )

    # 2. Effect + target.
    target_clause = (
        f" against target `{target_path}`" if target_path else " (no target resolved)"
    )
    if reasoning:
        paragraphs.append(
            f"Effect: **{effect}**{target_clause}. {reasoning}"
        )
    else:
        paragraphs.append(f"Effect: **{effect}**{target_clause}.")

    # 3. Raw quote — quoted with markdown blockquote so the body
    # renders cleanly in the dashboard's markdown preview.
    if raw_quote:
        paragraphs.append(f"Raw quote:\n\n> {raw_quote}")

    return "\n\n".join(paragraphs) + "\n"


# ---------------------------------------------------------------------------
# Activity: write_signal_record
# ---------------------------------------------------------------------------

@activity.defn
async def write_signal_record(
    signal: dict[str, Any] | None,
) -> str:
    """Persist a signal proposal as a vault ``signal/`` record.

    Input: the dict returned by ``extract_signal_from_event`` (or
    ``None`` — the workflow should never call us with None, but be
    defensive: a None signal means "noise, drop", and we return the
    empty string so the workflow can detect it without raising).

    Returns the relative vault path written (e.g.,
    ``"signal/2026-05-06T12-30-15Z-abc12345.md"``). Idempotent: the
    slug derives deterministically from ``source_event_path`` +
    ``raw_quote`` + ``created_at`` so a Temporal retry that re-runs
    this activity overwrites the same path with the same content
    rather than producing a duplicate record.
    """
    # Defensive — the SignalExtractWorkflow (T6.0.5) skips activity
    # invocation when the upstream extract returned None, but if a
    # future caller forgets that guard we want a clean empty-string
    # return rather than an AttributeError on .get().
    if signal is None:
        logger.info(
            "signals.write_signal_record: called with None signal — no-op"
        )
        return ""
    if not isinstance(signal, dict):
        logger.warning(
            "signals.write_signal_record: unexpected input type=%s — no-op",
            type(signal).__name__,
        )
        return ""

    slug = _build_signal_slug(signal)
    frontmatter = _build_signal_frontmatter(signal)
    body = _build_signal_body(signal)
    content = frontmatter + body

    cfg = load_config()
    client = VaultClient(cfg)
    try:
        try:
            path = await client.write_record(
                record_type="signal",
                name=slug,
                content=content,
            )
        except httpx.HTTPError as exc:
            # Re-raise so Temporal's activity retry policy handles a
            # transient ctrl-api outage. Idempotency is guaranteed by
            # the deterministic slug — a retried call writes the same
            # path with the same body.
            logger.warning(
                "signals.write_signal_record: write failed slug=%s err=%s",
                slug, exc,
            )
            raise

        logger.info(
            "signals.write_signal_record: wrote path=%s effect=%s "
            "target_path=%s effect_confidence=%.2f",
            path,
            signal.get("effect"),
            signal.get("target_path"),
            float(signal.get("effect_confidence") or 0.0),
        )
        return path
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Helpers — list_unprocessed_stream_events support
# ---------------------------------------------------------------------------

# Default record types scanned by list_unprocessed_stream_events.
# Phase 6.6 adds ``stream_event`` as the post-migration target. The
# legacy ``event`` and ``conversation`` types are kept in the default
# scan list during the transition window so events still landing
# under the old paths (e.g. on tenants where the migrator hasn't run
# yet, or workflows that wrote a stream event between the deploy and
# the migration) continue to surface to the signal extractor. Once
# the migrator runs and the stream_vault writer is fully cut over to
# ``stream_event/``, the legacy paths just return zero results — the
# union still works correctly.
_DEFAULT_STREAM_EVENT_TYPES: list[str] = [
    "stream_event", "event", "conversation",
]


# Filename prefixes that mark a record under ``event/`` as a
# steward-audit artefact rather than a stream event. These records
# write to ``event/`` from steward.py / signal_actions.py /
# task_creation.py and must NEVER be treated as stream events for
# signal extraction. The migrator (#842 T6.6.1) uses the same list
# to decide which event/ records to leave in place.
_EVENT_STEWARD_AUDIT_PREFIXES: tuple[str, ...] = (
    "steward-action-",
    "signal-action-",
    "auto-task-created-",
    "needs_attention_action-",
    "signal-mutation-",
    "daily-digest-",
)


def _is_steward_audit_event(path: str) -> bool:
    """True if ``path`` is an ``event/`` steward-audit record.

    The check runs on the BARENAME after the last slash so nested
    layouts (``event/2026/04/17/daily-digest-...``) are also matched.
    """
    if not path:
        return False
    name = path.rsplit("/", 1)[-1]
    return any(name.startswith(p) for p in _EVENT_STEWARD_AUDIT_PREFIXES)


def _parse_iso_or_none(ts: str | None) -> datetime | None:
    """Parse an ISO8601 timestamp string into a UTC-aware datetime.

    Accepts the ``Z`` suffix by translating to ``+00:00`` (the form
    ``datetime.fromisoformat`` accepts pre-3.11 reliably). Returns
    ``None`` on parse failure so callers can treat a malformed
    ``created`` field as "doesn't pass the since filter" without
    raising.
    """
    if not ts:
        return None
    s = ts.strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        # Treat naive timestamps as UTC — alfred's stream_vault writes
        # are all UTC by convention, so a missing tzinfo is a stamping
        # bug rather than a localized timestamp.
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ---------------------------------------------------------------------------
# Activity: list_unprocessed_stream_events
# ---------------------------------------------------------------------------

@activity.defn
async def list_unprocessed_stream_events(
    since: str | None = None,
    limit: int = 100,
    types: list[str] | None = None,
) -> list[str]:
    """Return vault paths of stream events not yet signal-extracted.

    Args:
      since: ISO8601 timestamp. Only events whose
        ``frontmatter.created`` is >= ``since`` are returned. ``None``
        means no lower bound.
      limit: max paths to return; oldest-first by created.
      types: vault record types to scan. Defaults to
        ``["event", "conversation"]`` for the pre-6.6 layout. After
        T6.6 ships and stream_vault.py writes to ``stream_event``,
        T6.0.5's workflow will pass ``types=["stream_event"]`` and
        this activity needs no modification.

    Filtering rules (per record):
      * ``frontmatter.signal_extracted_at`` is missing or null
        — already-extracted records are skipped.
      * ``frontmatter.created >= since`` (when since is provided).
      * The inferred source_type is in ``PRE_FILTER_ALLOWLIST`` — no
        point listing a record the extractor would just drop.

    Errors: a ctrl-api connection failure is logged and treated as
    "no records this tick" (returns ``[]``). The 5-min workflow
    cadence retries naturally — raising would mark the activity
    failed and trigger Temporal exponential backoff which we don't
    want for transient blips.

    Implementation:
      1. For each type in ``types`` issue
         ``GET /api/v1/vault/list/<type>?preview=0``. ``preview=0``
         skips the body excerpt (we only need frontmatter to make
         the unprocessed/allowlist decision).
      2. Filter results client-side per the rules above.
      3. Sort ascending by ``frontmatter.created`` so the oldest
         backlog is processed first under load.
      4. Slice to ``limit``.
    """
    cfg = load_config()
    scan_types = list(types) if types else list(_DEFAULT_STREAM_EVENT_TYPES)
    if not scan_types:
        return []

    since_dt = _parse_iso_or_none(since)

    # Sidecar lookup. The processed-set is consulted instead of
    # ``signal_extracted_at`` in frontmatter — the YAML field is
    # unreliable on records with malformed Unicode (vault edit fails
    # to write it, leaving the cursor stuck). See
    # ``utils/extraction_index`` for the rationale.
    from src.utils import extraction_index

    bootstrap_records: list[dict] = []
    do_bootstrap = not await extraction_index.is_bootstrapped()

    processed_paths = await extraction_index.get_processed_set()

    # Paths that match the garbage-shape filter (Composio API errors
    # stored as events, openclaw slash commands, hard-blocked source
    # types). Collected during the listing pass and bulk-marked in
    # the sidecar at the end so they never appear in a subsequent
    # listing.
    garbage_paths_to_mark: list[str] = []

    # We use a direct httpx client rather than VaultClient because
    # listing-with-preview-control isn't a method on VaultClient
    # (intentionally — keeping that surface minimal). The
    # ``preview=0`` query string keeps the response payload small for
    # large vaults (10K+ events on david's tenant).
    api_key = __import__("os").environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    all_filtered: list[tuple[str, "datetime | None", str]] = []
    try:
        # 120s timeout: ctrl-api list takes 30s+ on a 6,500-event vault
        # because it parses every record's frontmatter. The previous
        # 30s timeout caused silent ReadTimeouts ("list stream_event
        # failed err=" with empty error string) → activity continued
        # with 0 results from event/conversation → workflow listed=0
        # while 5,000+ events sat unprocessed.
        async with httpx.AsyncClient(
            base_url=cfg.alfred_ctrl_url,
            timeout=120.0,
            headers=headers,
        ) as client:
            for record_type in scan_types:
                try:
                    resp = await client.get(
                        f"/api/v1/vault/list/{record_type}",
                        params={"preview": "0"},
                    )
                    resp.raise_for_status()
                except httpx.HTTPError as exc:
                    # Per-type failure: log and continue. A 4xx on an
                    # unknown record type (e.g. T6.6 "stream_event"
                    # passed before the migration runs) shouldn't poison
                    # the other type's results. Some httpx exceptions
                    # (ReadTimeout, ConnectError) have empty str() —
                    # use repr() to surface the type.
                    logger.warning(
                        "signals.list_unprocessed_stream_events: list %s "
                        "failed err=%r (%s)",
                        record_type, exc, type(exc).__name__,
                    )
                    continue

                try:
                    payload = resp.json()
                except (ValueError, json.JSONDecodeError) as exc:
                    logger.warning(
                        "signals.list_unprocessed_stream_events: bad JSON for %s err=%s",
                        record_type, exc,
                    )
                    continue

                results = payload.get("results") if isinstance(payload, dict) else None
                if not isinstance(results, list):
                    continue

                for rec in results:
                    if not isinstance(rec, dict):
                        continue
                    fm = rec.get("frontmatter") or {}
                    if not isinstance(fm, dict):
                        continue

                    path = str(rec.get("path") or "").strip()
                    if not path:
                        continue

                    # T6.6 transition: ``event/`` houses BOTH legacy
                    # stream events (pre-migration) AND steward-audit
                    # records (auto-task-created-*, steward-action-*,
                    # daily-digest-*, etc.). The audit records must
                    # never be treated as stream events. Filter them
                    # out early so they don't burn an LLM call.
                    if record_type == "event" and _is_steward_audit_event(path):
                        continue

                    # Bootstrap path: on the first run after the
                    # sidecar is introduced, capture every record's
                    # frontmatter so we can import existing
                    # ``signal_extracted_at`` values into the index.
                    # Skipped on subsequent runs (sidecar holds the
                    # truth thereafter).
                    if do_bootstrap:
                        bootstrap_records.append({"path": path, "frontmatter": fm})

                    # Already-extracted? skip. The sidecar is the
                    # source of truth; the YAML field is read only
                    # by the bootstrap path above.
                    if path in processed_paths:
                        continue

                    # Hard-blocked garbage: stored API errors, openclaw
                    # slash commands, hard-blocked source types. These
                    # get bulk-marked in the sidecar so they're never
                    # listed again, no LLM call ever fires.
                    is_garbage, _ = _is_garbage_event({"frontmatter": fm})
                    if is_garbage:
                        garbage_paths_to_mark.append(path)
                        continue

                    # Age cutoff: events older than 14 days (configurable)
                    # have low actionable value — any signal in them has
                    # either been actioned or expired (delivery confirms,
                    # calendar reminders, etc.). Same bulk-mark treatment.
                    is_old, _ = _is_too_old({"frontmatter": fm})
                    if is_old:
                        garbage_paths_to_mark.append(path)
                        continue

                    # ``since`` lower bound.
                    created_raw = rec.get("created") or fm.get("created") or ""
                    created_dt = _parse_iso_or_none(str(created_raw))
                    if since_dt is not None:
                        if created_dt is None or created_dt < since_dt:
                            continue

                    # Allowlist pre-filter — the extractor will drop
                    # non-allowlisted source types anyway, so listing
                    # them just burns N pointless workflow reads.
                    src_type = _infer_source_type({"frontmatter": fm})
                    if src_type not in PRE_FILTER_ALLOWLIST:
                        continue

                    # Body-content check: composio gmail ingestion has
                    # been writing header-only stream events (no body),
                    # ~312 records on david. The LLM has nothing to
                    # classify on — bulk-mark and skip. The list endpoint
                    # returns ``preview`` (first ~200 chars of body)
                    # only when ``preview>0`` is set; we passed
                    # ``preview=0`` for speed, so use ``length`` field
                    # if present, else look for ``body`` truthiness.
                    body_len = rec.get("length")
                    if isinstance(body_len, int) and body_len < MIN_CONTENT_LENGTH:
                        garbage_paths_to_mark.append(path)
                        continue

                    all_filtered.append((src_type, created_dt, path))
    except httpx.HTTPError as exc:
        # Top-level connection failure (e.g. ctrl-api unreachable).
        # Treat as "nothing to process this tick"; the 5-min schedule
        # retries naturally. Raising would force Temporal backoff.
        logger.warning(
            "signals.list_unprocessed_stream_events: ctrl-api connect failed err=%s",
            exc,
        )
        return []
    except Exception as exc:  # noqa: BLE001
        # Last-resort guard — any unexpected error returns []
        # (same rationale as the connect-failure path).
        logger.warning(
            "signals.list_unprocessed_stream_events: unexpected error err=%s",
            exc,
        )
        return []

    # Bulk-mark structurally-garbage records (Composio API errors,
    # openclaw slash commands, hard-blocked source types) so they
    # never appear in a subsequent listing — and never burn an LLM
    # call. Idempotent on path; safe to repeat across ticks.
    if garbage_paths_to_mark:
        try:
            marked = await extraction_index.mark_processed_bulk(
                garbage_paths_to_mark
            )
            logger.info(
                "signals.list_unprocessed_stream_events: bulk-marked "
                "garbage paths=%d (zero LLM cost)",
                marked,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "signals.list_unprocessed_stream_events: bulk-mark "
                "garbage failed err=%s",
                exc,
            )

    # Bootstrap (one-shot): import any existing
    # ``signal_extracted_at`` values from the records we just listed.
    # After this completes the sidecar is the source of truth and
    # ``do_bootstrap`` is False on every subsequent tick.
    if do_bootstrap and bootstrap_records:
        try:
            imported = await extraction_index.bootstrap_from_records(
                bootstrap_records
            )
            logger.info(
                "signals.list_unprocessed_stream_events: sidecar bootstrap "
                "imported=%d (now treated as already-processed)",
                imported,
            )
            # Re-fetch and re-filter; events imported in this pass
            # should NOT be returned as unprocessed.
            processed_paths = await extraction_index.get_processed_set()
            all_filtered = [
                (dt, p) for (dt, p) in all_filtered if p not in processed_paths
            ]
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "signals.list_unprocessed_stream_events: bootstrap failed "
                "err=%s (continuing with empty sidecar)",
                exc,
            )

    # Source-priority sort: high-value sources first, then NEWEST
    # within each priority bucket. The previous oldest-first ordering
    # made the backlog drain through low-value sources (github
    # notifications, generic chat artifacts) before reaching real
    # gmail / plane / openclaw-chat signals — meaning Sir would wait
    # hours before seeing his actual matters surface. Newest-first
    # within a bucket means recent activity gets processed quickly,
    # which matters more than calendar order for a 14-day window.
    SOURCE_PRIORITY: dict[str, int] = {
        "gmail": 0,           # invoices, deliveries, real correspondence
        "plane": 1,           # project tracker, structured + actionable
        "openclaw-chat": 2,   # direct conversations with Sir
        "vexa": 3,            # meeting transcripts
        "sure": 4,            # financial transactions
        "vault_edit": 5,      # Sir's hand-edits
        "omi": 6,             # ambient audio
        "gcal": 7,            # calendar events
        "slack": 8,           # mostly noise on this tenant
    }
    UNKNOWN_PRIORITY = 99
    # Within a source-type bucket: sort OLDEST-first. The newest gmail
    # events on this tenant lack body content (composio ingestion only
    # captured headers — known bug, ~312 records). The richer
    # backlog from previous weeks DOES have bodies, so process the
    # older ones first to surface real signals.
    sentinel_max = datetime.max.replace(tzinfo=timezone.utc)
    all_filtered.sort(
        key=lambda triple: (
            SOURCE_PRIORITY.get(triple[0], UNKNOWN_PRIORITY),
            triple[1] or sentinel_max,
        )
    )

    safe_limit = max(0, int(limit) if limit is not None else 100)
    return [path for _, _, path in all_filtered[:safe_limit]]


# ---------------------------------------------------------------------------
# Activity: mark_stream_event_processed (T6.0.5 — workflow cursor)
# ---------------------------------------------------------------------------

@activity.defn
async def mark_stream_event_processed(
    stream_event_path: str,
    signal_path: str | None = None,
) -> None:
    """Mark a stream event as extracted in the sidecar SQLite index.

    Originally this activity PATCHed ``signal_extracted_at`` into the
    vault record's frontmatter via ``alfred vault edit``. That path
    parses the entire YAML before writing — so ANY existing YAML
    defect (malformed Unicode escapes, unclosed quotes, half-quoted
    multi-line names) returns 500 from ctrl-api. The activity then
    retried 3× and surfaced as ``mark_failed`` in the workflow,
    leaving ``signal_extracted_at: null`` on the record. Next tick
    re-extracted the same event (LLM cost burned), failed to mark
    again, and the loop continued indefinitely. We hit this hard on
    david's gcal backlog where many events have a malformed
    ``description`` field.

    The sidecar (``utils/extraction_index``) replaces the YAML mark
    with a single SQL INSERT. No YAML parse, no docker exec, no PATCH.
    Idempotent on path; survives any vault-record defect.

    The vault frontmatter ``signal_extracted_at`` field is preserved
    for compatibility (still written as ``null`` by ``stream_vault``
    on ingest) but no longer maintained by this activity. Reads
    consult the sidecar.
    """
    if not stream_event_path or not isinstance(stream_event_path, str):
        logger.warning(
            "signals.mark_stream_event_processed: empty/invalid path %r",
            stream_event_path,
        )
        return

    from src.utils import extraction_index

    try:
        await extraction_index.mark_processed(stream_event_path, signal_path)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "signals.mark_stream_event_processed: sidecar write failed "
            "path=%s err=%s",
            stream_event_path, exc,
        )
        raise

    logger.info(
        "signals.mark_stream_event_processed: marked path=%s signal_path=%s",
        stream_event_path, signal_path or "(none)",
    )
