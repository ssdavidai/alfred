"""Shared vault schema constants — record types, statuses, field definitions."""

from __future__ import annotations

# --- Known record types and their valid statuses ---

KNOWN_TYPES: set[str] = {
    "project", "task", "session", "input", "person", "org",
    "location", "note", "decision", "process", "run", "event",
    "account", "asset", "conversation", "assumption", "constraint",
    "contradiction", "synthesis",
}

LEARN_TYPES: set[str] = {
    "assumption", "decision", "constraint", "contradiction", "synthesis",
}

STATUS_BY_TYPE: dict[str, set[str]] = {
    "project": {"active", "paused", "completed", "abandoned", "proposed"},
    "task": {"todo", "active", "blocked", "done", "cancelled"},
    "session": {"active", "completed"},
    "input": {"unprocessed", "processed", "deferred"},
    "person": {"active", "inactive"},
    "org": {"active", "inactive"},
    "location": {"active", "inactive"},
    "note": {"draft", "active", "review", "final"},
    "decision": {"draft", "final", "superseded", "reversed"},
    "process": {"active", "proposed", "design", "deprecated"},
    "run": {"active", "completed", "blocked", "cancelled"},
    "event": set(),  # no status constraint
    "account": {"active", "suspended", "closed", "pending"},
    "asset": {"active", "retired", "maintenance", "disposed"},
    "conversation": {"active", "waiting", "resolved", "closed", "archived"},
    "assumption": {"active", "challenged", "invalidated", "confirmed"},
    "constraint": {"active", "expired", "waived", "superseded"},
    "contradiction": {"unresolved", "resolved", "accepted"},
    "synthesis": {"draft", "active", "superseded"},
}

# Type → expected top-level directory
TYPE_DIRECTORY: dict[str, str] = {
    "project": "project",
    "task": "task",
    "person": "person",
    "org": "org",
    "location": "location",
    "note": "note",
    "decision": "decision",
    "process": "process",
    "run": "run",
    "event": "event",
    "account": "account",
    "asset": "asset",
    "conversation": "conversation",
    "assumption": "assumption",
    "constraint": "constraint",
    "contradiction": "contradiction",
    "synthesis": "synthesis",
    # session, input have flexible placement
}

# Fields that should be lists
LIST_FIELDS: set[str] = {
    "tags", "aliases", "related", "relationships", "participants",
    "outputs", "depends_on", "blocked_by", "based_on", "supports",
    "challenged_by", "approved_by", "confirmed_by", "invalidated_by",
    "cluster_sources", "governed_by", "references", "project",
}

# Required fields for all records
REQUIRED_FIELDS: list[str] = ["type", "created"]

# Types that use "subject" instead of "name" as their title field
NAME_FIELD_BY_TYPE: dict[str, str] = {
    "conversation": "subject",
    "input": "subject",
}
