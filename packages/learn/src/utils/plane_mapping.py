"""Bidirectional constants for vault ↔ Plane sync field mapping.

Central source of truth. All field translations go through here —
never inline-mapped in activities or workflows.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

# Vault task status (see alfred/src/alfred/vault/schema.py STATUS_BY_TYPE["task"])
# → Plane issue state group (backlog / unstarted / started / completed / cancelled)
VAULT_TASK_TO_PLANE_STATE_GROUP = {
    "queued":    "backlog",
    "todo":      "unstarted",
    "active":    "started",
    "blocked":   "unstarted",   # + "blocked" label
    "done":      "completed",
    "cancelled": "cancelled",
}
PLANE_STATE_GROUP_TO_VAULT_TASK = {
    "backlog":   "queued",
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


def vault_task_to_plane_update(task_fm: dict) -> dict:
    """Transform vault task frontmatter into Plane issue PATCH payload.

    Returns a dict with Plane field names — name, description, priority,
    state (by group — caller resolves to actual state UUID), labels.
    Does NOT include things that require Plane UUID lookup (project_id,
    assignees, cycle) — caller handles those.
    """
    name = str(task_fm.get("name", "")).strip()[:255] or "Untitled task"
    status = task_fm.get("status", "todo")
    priority = task_fm.get("priority")
    requires_approval = bool(task_fm.get("requires_approval", False))

    labels: set[str] = {"alfred:managed"}
    if requires_approval:
        labels.add("alfred:needs-approval")
    if status == "blocked":
        labels.add("blocked")

    return {
        "name": name,
        "priority": VAULT_PRIORITY_TO_PLANE.get(priority, "none"),
        "state_group": VAULT_TASK_TO_PLANE_STATE_GROUP.get(status, "backlog"),
        "labels": sorted(labels),
    }


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
