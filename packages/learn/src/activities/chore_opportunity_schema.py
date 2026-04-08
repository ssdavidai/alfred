"""ChoreOpportunity schema — structured output from the brief+opportunities Opus call.

A chore opportunity is Opus's proposal for something Alfred should do recurring
for the user. The onboarding pipeline generates a list of opportunities alongside
the welcome brief in a single Opus call, then Step 3 matches each opportunity to
an existing template (with bespoke params) and Step 4 generates new templates for
anything the library can't serve.

The ChoreOpportunity dataclass is the wire format between:
  - write_brief_and_opportunities_opus (Stage 6 activity)
  - assign_initial_chores (Stage 7.5 activity)

Stored in onboard.json["opportunities"] as a list of dicts matching this schema.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


# ---------------------------------------------------------------------------
# Validation constants
# ---------------------------------------------------------------------------

_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$")

_MAX_NAME_LEN = 120
# description is Opus's natural-language summary of the opportunity — cap it
# generously and TRUNCATE rather than reject so we don't lose opportunities
# just because Opus was verbose. Same approach for goal.
_MAX_DESCRIPTION_LEN = 800
_MAX_GOAL_LEN = 800
_MAX_HINT_LEN = 200
_MAX_TAG_LEN = 40
_MAX_TAGS = 10
_MAX_DATA_SOURCES = 10

# Trigger kinds Opus is allowed to request
_VALID_TRIGGER_KINDS = {"cron", "event", "on-demand"}

# Frequency hints we accept — normalized on ingest. Liberal because Opus will
# produce natural language; we map it to a canonical set later.
_VALID_FREQUENCY_HINTS = {
    "hourly", "daily", "weekly", "biweekly", "monthly",
    "quarterly", "on-demand", "continuous",
}


# ---------------------------------------------------------------------------
# Dataclass
# ---------------------------------------------------------------------------

@dataclass
class ChoreOpportunity:
    """A proposed recurring task Alfred could do for the user.

    The brief generator Opus call emits a list of these alongside the welcome
    letter. Each entry is a specific, testable intent — not a vague promise.

    Fields:
        id:             stable slug (lowercase, hyphens only, 1-64 chars)
        name:           human-readable chore name, referenced in the brief
        description:    one-sentence summary that matches a phrase in the brief
        goal:           what problem this solves for the user
        trigger:        {kind: "cron"|"event"|"on-demand", hint: str}
        data_sources:   list of vault record types or stream names this reads
        frequency_hint: canonical cadence ("weekly", "daily", "on-demand", etc.)
        notify_when:    condition for notifying the user
        tags:           frontmatter tags for the eventual chore vault record
    """

    id: str
    name: str
    description: str
    goal: str
    trigger: dict[str, Any]
    data_sources: list[str] = field(default_factory=list)
    frequency_hint: str = "weekly"
    notify_when: str = ""
    tags: list[str] = field(default_factory=list)

    # ------------------------------------------------------------------
    # Dict interop
    # ------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a plain dict suitable for onboard.json storage."""
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "goal": self.goal,
            "trigger": dict(self.trigger),
            "data_sources": list(self.data_sources),
            "frequency_hint": self.frequency_hint,
            "notify_when": self.notify_when,
            "tags": list(self.tags),
        }

    @classmethod
    def from_dict(cls, raw: Any) -> "ChoreOpportunity":
        """Parse a dict (typically from Opus JSON output) into a validated opportunity.

        Raises ChoreOpportunityValidationError with a descriptive message if the
        input does not satisfy the schema. The caller is expected to catch and
        either drop the offending entry or surface a structured error to the
        retry loop.
        """
        if not isinstance(raw, dict):
            raise ChoreOpportunityValidationError(
                f"opportunity must be a dict, got {type(raw).__name__}"
            )

        id_value = _require_str(raw, "id", _ID_PATTERN.pattern)
        if not _ID_PATTERN.match(id_value):
            raise ChoreOpportunityValidationError(
                f"id {id_value!r} is not a valid slug (lowercase, digits, hyphens, 1-64 chars)"
            )

        # `name` is a short human label — reject if it overflows, because
        # truncating a name produces garbled UI text.
        name = _require_nonempty_str(raw, "name", _MAX_NAME_LEN)
        # `description` and `goal` are prose — Opus sometimes writes verbose
        # versions. We truncate to the cap rather than rejecting so we don't
        # lose otherwise-valid opportunities over a length technicality.
        description = _require_truncated_str(raw, "description", _MAX_DESCRIPTION_LEN)
        goal = _require_truncated_str(raw, "goal", _MAX_GOAL_LEN)

        trigger_raw = raw.get("trigger")
        trigger = _validate_trigger(trigger_raw)

        data_sources = _validate_string_list(
            raw.get("data_sources"), "data_sources", _MAX_DATA_SOURCES, _MAX_TAG_LEN
        )

        frequency_hint = raw.get("frequency_hint", "weekly")
        if not isinstance(frequency_hint, str) or not frequency_hint:
            frequency_hint = "weekly"
        frequency_hint = frequency_hint.strip().lower()
        if frequency_hint not in _VALID_FREQUENCY_HINTS:
            # Don't reject — normalize to "weekly" and let the caller decide
            frequency_hint = "weekly"

        notify_when = raw.get("notify_when", "")
        if not isinstance(notify_when, str):
            notify_when = ""
        notify_when = notify_when.strip()[:_MAX_HINT_LEN]

        tags = _validate_string_list(raw.get("tags"), "tags", _MAX_TAGS, _MAX_TAG_LEN)

        return cls(
            id=id_value,
            name=name,
            description=description,
            goal=goal,
            trigger=trigger,
            data_sources=data_sources,
            frequency_hint=frequency_hint,
            notify_when=notify_when,
            tags=tags,
        )


class ChoreOpportunityValidationError(ValueError):
    """Raised when a raw dict cannot be parsed into a ChoreOpportunity."""


# ---------------------------------------------------------------------------
# Internal validation helpers
# ---------------------------------------------------------------------------

def _require_str(raw: dict[str, Any], key: str, pattern_hint: str = "") -> str:
    """Pull a string field from the dict. Raises if missing or wrong type."""
    value = raw.get(key)
    if not isinstance(value, str):
        msg = f"{key!r} must be a string"
        if pattern_hint:
            msg += f" matching {pattern_hint}"
        raise ChoreOpportunityValidationError(msg)
    return value.strip()


def _require_nonempty_str(raw: dict[str, Any], key: str, max_len: int) -> str:
    """Pull and validate a non-empty string with a length cap (rejects on overflow)."""
    value = _require_str(raw, key)
    if not value:
        raise ChoreOpportunityValidationError(f"{key!r} must be non-empty")
    if len(value) > max_len:
        raise ChoreOpportunityValidationError(
            f"{key!r} length {len(value)} exceeds max {max_len}"
        )
    return value


def _require_truncated_str(raw: dict[str, Any], key: str, max_len: int) -> str:
    """Pull a non-empty string and truncate on overflow rather than rejecting.

    Used for prose fields (description, goal) where the content is still
    meaningful after truncation. Truncation adds an ellipsis marker so the
    downstream consumer can tell the text was cut.
    """
    value = _require_str(raw, key)
    if not value:
        raise ChoreOpportunityValidationError(f"{key!r} must be non-empty")
    if len(value) > max_len:
        return value[: max_len - 1].rstrip() + "…"
    return value


def _validate_trigger(raw: Any) -> dict[str, Any]:
    """Validate a trigger block: {kind: ..., hint: ...}."""
    if not isinstance(raw, dict):
        raise ChoreOpportunityValidationError(
            f"trigger must be a dict, got {type(raw).__name__}"
        )
    kind = raw.get("kind")
    if not isinstance(kind, str) or kind not in _VALID_TRIGGER_KINDS:
        raise ChoreOpportunityValidationError(
            f"trigger.kind must be one of {sorted(_VALID_TRIGGER_KINDS)}, got {kind!r}"
        )
    hint = raw.get("hint", "")
    if not isinstance(hint, str):
        hint = ""
    hint = hint.strip()[:_MAX_HINT_LEN]
    return {"kind": kind, "hint": hint}


def _validate_string_list(
    raw: Any,
    field_name: str,
    max_items: int,
    max_item_len: int,
) -> list[str]:
    """Validate a list-of-strings field with caps on length + item count.

    Non-list inputs become []; non-string items are dropped. This is forgiving
    on purpose because Opus sometimes wraps lists in extra dicts or returns
    None — we don't want to reject the whole opportunity for a minor quirk.
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw[:max_items]:
        if not isinstance(item, str):
            continue
        cleaned = item.strip()[:max_item_len]
        if cleaned:
            out.append(cleaned)
    return out
