"""Bidirectional constants for vault ↔ Plane sync field mapping.

Central source of truth. All field translations go through here —
never inline-mapped in activities or workflows.
"""
from __future__ import annotations

import hashlib
import html
import json
import logging
import re
from datetime import date, datetime
from typing import Any, Iterable, Optional

logger = logging.getLogger("alfred-learn")

# Vault task status (see alfred/src/alfred/vault/schema.py STATUS_BY_TYPE["task"])
# → Plane issue state group (backlog / unstarted / started / completed / cancelled)
VAULT_TASK_TO_PLANE_STATE_GROUP = {
    "queued":    "backlog",
    "todo":      "unstarted",
    "active":    "started",
    "blocked":   "unstarted",   # + "blocked" label
    "done":      "completed",
    "cancelled": "cancelled",
    # Fleet-drift value seen on David's mature vault (1212 records on
    # 2026-04-23). Not in the canonical schema but we round-trip it as
    # backlog so these records don't silently fall off forward sync.
    "pending":   "backlog",
}
PLANE_STATE_GROUP_TO_VAULT_TASK = {
    # ``backlog`` collapses to ``todo`` on the reverse trip: the
    # canonical vault task schema (see alfred/src/alfred/vault/schema.py)
    # only accepts ``active|blocked|cancelled|done|todo``. Historically
    # some fleet drift produced ``queued`` but ctrl-api's ``vault edit``
    # rejects it with 500, breaking every reverse-sync write for issues
    # Plane considers backlog. Mapping to ``todo`` keeps the round-trip
    # consistent for tenants following the canonical schema; forward
    # sync still sends ``backlog`` for any task whose status happens to
    # be ``queued`` on disk via the other-side mapping above.
    "backlog":   "todo",
    "unstarted": "todo",
    "started":   "active",
    "completed": "done",
    "cancelled": "cancelled",
}

# Priority: 1:1
VAULT_PRIORITY_TO_PLANE = {
    "low":    "low",
    "medium": "medium",
    "high":   "high",
    "urgent": "urgent",
    # Fleet-drift: the curator occasionally emits "critical" even though
    # Alfred's vault schema doesn't define it. Treat as the strongest
    # Plane priority so these records don't collapse to "none".
    "critical": "urgent",
    None:     "none",
}
PLANE_PRIORITY_TO_VAULT = {
    "none":   None,
    "low":    "low",
    "medium": "medium",
    "high":   "high",
    "urgent": "urgent",
}

# Matter status → Plane project archive state
VAULT_MATTER_ACTIVE_STATES = {"active"}  # anything else → archived in Plane

# Labels that Alfred emits onto Plane issues (in addition to user labels)
ALFRED_LABELS = {
    "alfred:managed",              # always present on Alfred-owned issues
    "alfred:needs-approval",       # on tasks where requires_approval=true
    "blocked",                     # status:blocked surrogate
}

# Upper bound on how many labels we attach to a single issue. Plane has no
# hard limit but unbounded growth on richly-tagged tasks produces noisy
# Plane UI + slow label lookups. 10 keeps the card legible while leaving
# room for 'alfred:managed' + state surrogate + a handful of topic tags.
MAX_LABELS_PER_ISSUE = 10

# Allow-list for user-provided label names. Matches lowercase alphanumeric
# with hyphens, starting with an alphanumeric char, up to 32 chars — a
# conservative subset that Plane renders cleanly and that can't sneak
# through whitespace / punctuation / casing surprises.
_LABEL_NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")


def _sanitize_label_name(name: Any) -> Optional[str]:
    """Return ``name`` if it passes the allow-list, else None.

    No normalisation — case + trimming is the caller's responsibility;
    that way we don't mutate a user's free-form tag silently. The
    regex is anchored via ``fullmatch`` so embedded whitespace / dots
    are rejected rather than pruned.
    """
    if not isinstance(name, str):
        return None
    if _LABEL_NAME_RE.fullmatch(name):
        return name
    return None


def _coerce_label_list(raw: Any) -> list[str]:
    """Coerce a frontmatter tag field into a list of allow-listed strings.

    Accepts either a list of scalars or a comma/whitespace-separated
    string. Drops empty / invalid entries silently with a debug log
    (the full set is logged together in the caller so we don't spam
    once per item).
    """
    if raw is None:
        return []
    if isinstance(raw, str):
        parts: Iterable[str] = (p.strip() for p in re.split(r"[,\s]+", raw))
    elif isinstance(raw, (list, tuple)):
        parts = (str(p).strip() for p in raw if p is not None)
    else:
        return []

    out: list[str] = []
    dropped: list[str] = []
    for p in parts:
        if not p:
            continue
        ok = _sanitize_label_name(p)
        if ok is not None:
            out.append(ok)
        else:
            dropped.append(p)
    if dropped:
        logger.debug(
            "plane_mapping: dropped %d non-conforming label(s): %s",
            len(dropped), dropped,
        )
    return out


def _iso_date_string(value: Any) -> Optional[str]:
    """Return an ISO ``YYYY-MM-DD`` date string for ``target_date`` use,
    or None if the input can't be parsed.

    Plane's ``target_date`` / ``start_date`` fields accept either a full
    ISO datetime or a bare date. We normalise to the bare date so the
    loop-guard hash (which compares strings) stays stable across round
    trips where Plane might echo a timestamp while vault held a date.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    # Fast path for bare dates which are the common case in vault frontmatter.
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return s
    # Otherwise try ISO-8601 datetime; drop Z → +00:00 for fromisoformat.
    normalised = s.replace(" ", "T")
    if normalised.endswith("Z"):
        normalised = normalised[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(normalised)
    except (ValueError, TypeError):
        return None
    return dt.date().isoformat()


def _body_to_description_html(body: Any, description_scalar: Any) -> str:
    """Render a vault body (or fallback scalar) into Plane-safe HTML.

    Strategy is deliberately simple — one ``<p>`` per blank-line-
    separated paragraph, ``<br>`` for intra-paragraph newlines, with
    ``html.escape`` applied BEFORE we inject any tags so user text
    can never introduce live HTML. Markdown is intentionally NOT
    parsed here: the vault body is the source of truth and we want
    whatever got written there to render as plain prose in Plane, not
    as a half-rendered markdown tree.

    Returns an empty string when neither ``body`` nor
    ``description_scalar`` yields printable text.
    """
    text = ""
    if isinstance(body, str) and body.strip():
        text = body
    elif isinstance(description_scalar, str) and description_scalar.strip():
        text = description_scalar
    if not text:
        return ""

    # Strip a leading '# …' heading the curator commonly emits — it
    # duplicates the task/matter name and clutters the Plane card.
    # Conservative: only first line, only if it looks like a single
    # '# Name' heading.
    lines = text.splitlines()
    if lines and re.match(r"^\s*#\s+\S", lines[0]):
        lines = lines[1:]
        # Drop a trailing blank line left behind by the heading strip.
        while lines and not lines[0].strip():
            lines = lines[1:]
    text = "\n".join(lines)
    if not text.strip():
        return ""

    paragraphs = [p for p in re.split(r"\n{2,}", text) if p.strip()]
    html_parts: list[str] = []
    for p in paragraphs:
        # Escape first so any stray '<', '>', '&' in the user's body
        # becomes inert text — no HTML injection possible.
        escaped = html.escape(p, quote=False)
        escaped = escaped.replace("\n", "<br>")
        html_parts.append(f"<p>{escaped}</p>")
    return "".join(html_parts)


def vault_task_to_plane_update(task_fm: dict, body: Optional[str] = None) -> dict:
    """Transform vault task frontmatter into Plane issue PATCH payload.

    Returns a dict with Plane field names — ``name``, ``description_html``
    (only if the task has prose), ``priority``, ``state_group`` (caller
    resolves to actual state UUID), ``labels`` (set of label-name
    strings), ``target_date`` (only when a due date is set), and
    ``assignees`` (always present as a list; may be empty).

    ``body``
        Optional full task body text. When supplied, it's converted to
        HTML via ``_body_to_description_html``. When omitted, we fall
        back to the scalar ``description`` frontmatter field (shorter
        summary form that the curator writes for every task).

    Does NOT include things that require Plane UUID lookup (project_id,
    cycle, resolved assignee UUIDs) — caller handles those.
    """
    name = str(task_fm.get("name") or task_fm.get("title") or "").strip()[:255] or "Untitled task"
    status = task_fm.get("status", "todo")
    priority = task_fm.get("priority")
    requires_approval = bool(task_fm.get("requires_approval", False))

    description_html = _body_to_description_html(
        body, task_fm.get("description")
    )

    # --- Labels -------------------------------------------------------------
    # Start with the always-present managed marker; add surrogates for
    # states Plane can't represent natively (blocked, needs-approval);
    # then layer user-provided tags through the allow-list.
    labels: list[str] = ["alfred:managed"]
    if requires_approval:
        labels.append("alfred:needs-approval")
    if status == "blocked":
        labels.append("blocked")

    # User-provided tag sources — both the alfred-curated set and the
    # topic-tagger output. Filter each through the allow-list. Sanitize
    # once here so downstream (label resolution on the Plane side) is a
    # pure lookup.
    for source_key in ("alfred_tags", "topic_tags"):
        labels.extend(_coerce_label_list(task_fm.get(source_key)))

    # Dedupe preserving insertion order (so alfred:managed always wins
    # when the user-provided set happens to contain it), then cap.
    seen: set[str] = set()
    unique: list[str] = []
    for lb in labels:
        if lb and lb not in seen:
            seen.add(lb)
            unique.append(lb)
    if len(unique) > MAX_LABELS_PER_ISSUE:
        logger.debug(
            "plane_mapping: label set oversized (%d > %d), truncating",
            len(unique), MAX_LABELS_PER_ISSUE,
        )
        unique = unique[:MAX_LABELS_PER_ISSUE]

    # --- Due date -----------------------------------------------------------
    target_date = _iso_date_string(
        task_fm.get("due_date") or task_fm.get("due")
    )

    payload: dict[str, Any] = {
        "name": name,
        "priority": VAULT_PRIORITY_TO_PLANE.get(priority, "none"),
        "state_group": VAULT_TASK_TO_PLANE_STATE_GROUP.get(status, "backlog"),
        "labels": sorted(unique),
        # assignees always present as a list. Vault `owner` / `assignee`
        # values today are either 'alfred' or 'human' strings — NOT
        # Plane member UUIDs — so we hand off an empty list and let the
        # activity layer map known tokens to UUIDs when/if it has them.
        "assignees": [],
    }
    if description_html:
        payload["description_html"] = description_html
    if target_date:
        payload["target_date"] = target_date
    return payload


def vault_matter_to_plane_update(
    matter_fm: dict, body: Optional[str] = None
) -> dict:
    """Transform vault matter frontmatter into Plane project PATCH payload.

    Matters map to Plane projects. Only a narrow slice of frontmatter is
    meaningful on the Plane side (Plane projects don't have tags, due
    dates, or assignees at the project level), so the payload is small:

    * ``name``               — sanitized title
    * ``description_text``   — body fallback chain
    * ``description_html``   — rendered full body when one was passed in
    * ``is_archived``        — derived from vault ``status`` (anything
                               other than "active" is considered archived
                               on the Plane side)
    * ``emoji``              — optional single-character emoji hint from
                               frontmatter; only emitted when the
                               frontmatter value is exactly one
                               non-alphanumeric character (conservative
                               to avoid leaking prose into the emoji slot)

    The activity layer applies additional name-sanitisation for Plane's
    "no special characters" rule.
    """
    name = str(matter_fm.get("name") or matter_fm.get("title") or "").strip()[:255]
    if not name:
        name = "Untitled matter"

    # description_text is plain-text form; description_html is the rich
    # form. Plane displays whichever is set; we populate both so the
    # card reads well in every Plane UI context (mobile / email digest /
    # integration).
    description_text = str(
        (body.strip() if isinstance(body, str) and body.strip() else None)
        or matter_fm.get("description")
        or matter_fm.get("description_preview")
        or ""
    )
    description_html = _body_to_description_html(
        body, matter_fm.get("description") or matter_fm.get("description_preview")
    )

    status = str(matter_fm.get("status") or "").strip().lower()
    is_archived = bool(status) and status not in VAULT_MATTER_ACTIVE_STATES

    payload: dict[str, Any] = {
        "name": name,
        "description_text": description_text,
        "is_archived": is_archived,
    }
    if description_html:
        payload["description_html"] = description_html

    # Optional emoji — accept either ``emoji`` or ``icon`` frontmatter.
    # Single-char short-path guard keeps us from pushing a whole phrase
    # into Plane's emoji slot when the user wrote a word.
    emoji_raw = matter_fm.get("emoji") or matter_fm.get("icon")
    if isinstance(emoji_raw, str):
        emoji = emoji_raw.strip()
        # Plane emoji is a unicode code point; short + non-alnum guard
        # keeps it safe without pulling in a regex library.
        if emoji and len(emoji) <= 4 and not emoji.isalnum():
            payload["emoji"] = emoji
    return payload


def plane_issue_to_vault_patch(plane_issue: dict) -> dict:
    """Transform a Plane issue webhook/API payload into a vault task
    frontmatter patch. Returns only the fields safe to overwrite —
    never touches related_matters / related_persons / source_event
    (those are Alfred-managed).
    """
    labels: set[str]
    raw_labels = plane_issue.get("labels", [])
    if isinstance(raw_labels, list):
        labels = {lb["name"] for lb in raw_labels if isinstance(lb, dict) and "name" in lb}
    else:
        labels = set()

    state_group = (
        plane_issue.get("state_detail", {}).get("group")
        or plane_issue.get("state_group")
    )

    status = PLANE_STATE_GROUP_TO_VAULT_TASK.get(state_group or "backlog", "todo")
    # Blocked label wins over state group
    if "blocked" in labels:
        status = "blocked"

    priority = PLANE_PRIORITY_TO_VAULT.get(plane_issue.get("priority", "none"))

    return {
        "name": plane_issue.get("name", ""),
        "status": status,
        "priority": priority,
    }


def plane_project_to_matter_patch(project: dict) -> dict:
    """Transform a Plane project webhook/API payload into a vault matter
    frontmatter patch.

    Bidirectional counterpart of the matter-side of ``sync_matter_to_plane``.
    Same protection rule: NEVER touches ``related_matters`` / ``related_persons``
    / ``related_orgs`` / ``related_projects`` / ``source_event`` — those are
    surveyor-owned and not part of the Plane↔vault exchange.

    Field mapping:

    * ``name``               ← Plane project ``name`` (truncated to 255 chars;
                               empty falls back to ``"Untitled matter"`` so
                               matters never end up with a blank title)
    * ``description``        ← ``description_text`` preferred, then
                               ``description_html`` (Plane emits either)
    * ``status``             ← derived from Plane's ``is_archived`` /
                               ``archived_at`` flags: truthy → ``"archived"``,
                               otherwise ``"active"``
    * ``plane_project_id``   ← Plane's own ``id`` UUID, so reverse-sync can
                               find the matter without scanning every record

    Unknown fields on the Plane side are ignored — the return dict is
    the closed set of vault-frontmatter keys this helper manages.
    """
    name = str(project.get("name") or "").strip()[:255]
    if not name:
        name = "Untitled matter"

    description = (
        project.get("description_text")
        or project.get("description_html")
        or project.get("description")
        or ""
    )
    description = "" if description is None else str(description)

    archived_flag = project.get("is_archived")
    archived_at = project.get("archived_at")
    is_archived = bool(archived_flag) or bool(archived_at)
    status = "archived" if is_archived else "active"

    patch: dict[str, Any] = {
        "name": name,
        "description": description,
        "status": status,
    }
    plane_id = project.get("id")
    if plane_id:
        patch["plane_project_id"] = str(plane_id)
    return patch


# ---------------------------------------------------------------------------
# Stable hashing — used by all three loop guards in B7 reverse-sync and
# by forward-sync when recording outbound signatures. Forward + reverse
# MUST produce byte-identical digests over the same logical payload or
# guard #2 (suppression window) is a no-op.
#
# Discipline: serialize with ``json.dumps(obj, sort_keys=True,
# separators=(",", ":"))``. Always. Never hash a raw string someone
# else produced.
# ---------------------------------------------------------------------------

# Canonical field set for loop guards #1 and #3. Keep this list tight —
# every extra field widens the chance of a spurious mismatch (e.g. an
# updated_at timestamp changes but nothing the user cares about did).
LOOP_GUARD_FIELDS = (
    "name",
    "description",
    "state",
    "priority",
    "due_date",
    "assignees",
)


def _first_non_empty(src: dict, *keys: str) -> Any:
    """Return the first value under ``keys`` that is not None/empty."""
    for k in keys:
        v = src.get(k)
        if v is None:
            continue
        if isinstance(v, (str, list, tuple)) and len(v) == 0:
            continue
        return v
    return None


def _canonical_field_map(payload: dict) -> dict[str, Any]:
    """Extract the loop-guard fields from a Plane-shaped payload.

    Accepts either a raw Plane webhook/API object OR an update body we
    sent outbound (``vault_task_to_plane_update`` output). Both shapes
    use the same top-level keys for the guard fields, so a single
    extractor handles both directions.

    ``state`` is normalised to the Plane *state group* rather than the
    per-project state UUID, because UUIDs differ across projects but
    the logical status doesn't. Accept any of:

      * ``state_detail.group``   (Plane webhook shape)
      * ``state_group``          (flat shape)
      * ``state``                (outbound update body we built)
    """
    name = payload.get("name") or ""
    description = _first_non_empty(
        payload, "description_text", "description_html", "description"
    ) or ""

    state: Any = None
    sd = payload.get("state_detail")
    if isinstance(sd, dict):
        state = sd.get("group")
    if not state:
        state = payload.get("state_group") or payload.get("state")

    priority = payload.get("priority")
    due_date = (
        payload.get("target_date")
        or payload.get("due_date")
        or payload.get("due_at")
    )

    assignees_raw = payload.get("assignees") or payload.get("assignee_ids") or []
    if isinstance(assignees_raw, list):
        # Sort to absorb ordering differences — Plane sometimes echoes in
        # a different order than we sent.
        assignees = sorted(str(a) for a in assignees_raw if a is not None)
    else:
        assignees = []

    return {
        "name": str(name or ""),
        "description": str(description or ""),
        "state": str(state or ""),
        "priority": str(priority or "none"),
        "due_date": str(due_date or ""),
        "assignees": assignees,
    }


def compute_loop_guard_hash(payload: dict) -> str:
    """Stable SHA-256 hex digest over the loop-guard fields of ``payload``.

    Used by all three guards in PlaneReverseSyncWorkflow as well as the
    outbound-signature write in ``sync_matter_to_plane`` /
    ``sync_task_to_plane``. Forward + reverse MUST agree byte-for-byte
    or guard #2 is a no-op.
    """
    canonical = _canonical_field_map(payload or {})
    serialised = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialised.encode("utf-8")).hexdigest()
