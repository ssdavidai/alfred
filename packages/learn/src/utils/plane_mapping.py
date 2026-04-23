"""Bidirectional constants for vault ↔ Plane sync field mapping.

Central source of truth. All field translations go through here —
never inline-mapped in activities or workflows.
"""
from __future__ import annotations

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
