"""Shared vault schema constants — record types, statuses, field definitions."""

from __future__ import annotations

# --- Known record types and their valid statuses ---

# The ONLY record types ctrl-api will accept on POST /api/v1/vault/records.
# MUST stay identical to the allowed list in
# packages/ctrl/src/db/promotionContract.ts — ctrl is the enforcing side, and a
# type that is in KNOWN_TYPES but not here fails at the network boundary with a
# 422, not locally.
CANONICAL_VAULT_TYPES: set[str] = {
    "matter", "task", "note", "person", "org", "place", "asset",
    "chore", "instinct", "decision", "briefing", "daybook", "commitment",
}

# Vault paths ctrl-api accepts that are NOT record-type directories. Mirrors
# CANONICAL_NON_RECORD_DIRS / CANONICAL_TOP_LEVEL_FILES in ctrl's
# promotionContract.ts — the seam test asserts they stay identical.
CANONICAL_NON_RECORD_DIRS: set[str] = {"_templates", "needs_attention"}
CANONICAL_TOP_LEVEL_FILES: set[str] = {"SOUL.md", "RULES.md"}


def is_writable_vault_path(rel_path: str) -> bool:
    """True if ctrl-api will accept a write to this vault path.

    Anything else is a permanent 422 — the pre-cutover directories the vault
    still holds (event/, assumption/, constraint/, synthesis/, ...). Callers
    that sweep the whole vault should consult this BEFORE attempting a write,
    rather than discovering it one rejected HTTP round-trip at a time: on the
    dev tenant the janitor was making 2,866 such calls per sweep against
    event/ alone.
    """
    rel = rel_path.strip("/")
    if not rel:
        return False
    head, _, tail = rel.partition("/")
    if not tail:
        return head in CANONICAL_TOP_LEVEL_FILES
    return head in CANONICAL_VAULT_TYPES or head in CANONICAL_NON_RECORD_DIRS


# Pre-cutover names and the canonical types that replaced them.
#
# This daemon's vocabulary predates the four-store cutover. `project` is what a
# `matter` used to be called and `location` is what a `place` used to be called;
# the curator's extraction skill still teaches the old names, so every extracted
# project was POSTed as type `project` and rejected. Applied in vault_create
# before anything downstream sees the type.
TYPE_ALIASES: dict[str, str] = {
    "project": "matter",
    "location": "place",
}

KNOWN_TYPES: set[str] = {
    "project", "task", "session", "input", "person", "org",
    "location", "note", "decision", "process", "run", "event",
    "account", "asset", "conversation", "assumption", "constraint",
    "contradiction", "synthesis",
    # Canonical progressive-autonomy record (Asking→Confirming→Acting). Was
    # absent, so the janitor stamped every instinct FM002 "Unknown type".
    "instinct",
    # A promise inside a matter — who asked, who is accountable, the evidence,
    # and where it is in its lifecycle. The unit the commitment register
    # reconciles against.
    "commitment",
    # Canonical types the pre-cutover vocabulary had no name for. Without these
    # the daemon cannot create the vault's central record at all: there was no
    # `matter` in KNOWN_TYPES, so nothing here could author one.
    "matter", "place", "chore", "briefing", "daybook",
}

LEARN_TYPES: set[str] = {
    "assumption", "decision", "constraint", "contradiction", "synthesis",
}

# Learn types the distiller is permitted to CREATE.
#
# `decision` is deliberately excluded (bug #12): TYPE_DIRECTORY maps `decision`
# into the principal's own `decision/` directory, so a distiller-authored
# decision record is indistinguishable from a decision the principal actually
# made. The distiller may still READ `decision` records as evidence (that is
# why `decision` stays in LEARN_TYPES), but it must never write one into the
# principal-facing surface. Other learn types live in machine-owned
# directories, so the distiller may author them.
DISTILLER_CREATABLE_TYPES: set[str] = LEARN_TYPES - {"decision"}

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
    "instinct": {"unconfirmed", "active", "deprecated"},
    # COARSE rollup only. The real lifecycle (captured → accepted →
    # in_progress → ready_to_deliver → delivered_awaiting_acceptance →
    # fulfilled, plus waiting_*/blocked and released/superseded) lives in
    # `commitment_state` and is validated in the intelligence layer. This
    # daemon has no business enforcing that state machine, so `status` stays
    # the same four-value rollup every other reader already understands.
    "commitment": {"todo", "active", "blocked", "done"},
    # Matter's principal-facing lifecycle. Deliberately NOT project's old set:
    # `paused`/`abandoned`/`proposed` are not states a matter can be in.
    "matter": {"active", "dormant", "completed", "archived"},
    "place": {"active", "inactive"},
    "chore": set(),      # schedule state lives in Temporal, not frontmatter
    "briefing": set(),
    "daybook": set(),
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
    "instinct": "instinct",
    "commitment": "commitment",
    "matter": "matter",
    "place": "place",
    "chore": "chore",
    "briefing": "briefing",
    "daybook": "daybook",
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
