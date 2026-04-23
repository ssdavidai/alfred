"""Activities backing the PlaneSyncWorkflow — vault→Plane one-way sync (#536 B4).

All I/O (vault reads, Plane HTTP calls, cursor file read/write) lives here
so the workflow stays pure + deterministic. Activities are registered in
``worker.py`` and invoked via ``workflow.execute_activity``.

Sync direction is strictly vault → Plane here. Plane → vault ingress is
B7 territory. We stamp ``external_id=alfred:<slug>`` + ``external_source=alfred``
on every project/issue we create so the webhook receiver in B7 can detect
loop-backs and drop them.

Cursor layout at ``/alfred-data/state/plane_sync_cursor.json``::

    {
        "last_vault_mtime": 0.0,
        "project_map": {"matter-slug": "plane-project-uuid", ...},
        "issue_map": {"task-slug": "plane-issue-uuid", ...}
    }
"""
from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

from temporalio import activity

from src.config import load_config
from src.utils.plane_client import PlaneClient
from src.utils.plane_mapping import (
    compute_loop_guard_hash,
    vault_task_to_plane_update,
)
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Cursor file helpers
# ---------------------------------------------------------------------------

_CURSOR_RELATIVE = "state/plane_sync_cursor.json"

# Outbound-signature store (shared with B7 reverse-sync guard #2). Path
# is duplicated in ``src.activities.plane_reverse_sync`` so tests can
# patch either module without cross-coupling; both resolve against
# ``Config.alfred_data_dir`` so they stay in lockstep on disk.
_OUTBOUND_SIGS_RELATIVE = "state/plane_outbound_signatures.json"

# Cap on how many outbound signatures we keep. Larger → longer tail for
# the race-condition guard, but more disk churn. 1000 ≈ half a day at
# peak forward-sync rates.
_OUTBOUND_SIGS_CAP = 1000


def _outbound_sigs_path() -> Path:
    cfg = load_config()
    return Path(cfg.alfred_data_dir) / _OUTBOUND_SIGS_RELATIVE


def _load_outbound_sigs_from_disk(path: Path) -> dict[str, dict[str, Any]]:
    """Read the outbound-signature file. Empty dict on missing/corrupt."""
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            return {}
        # Coerce values to the expected shape defensively — older files
        # from a partial deploy shouldn't crash the activity.
        out: dict[str, dict[str, Any]] = {}
        for k, v in raw.items():
            if not isinstance(v, dict):
                continue
            if "hash" not in v or "ts" not in v:
                continue
            out[str(k)] = {"hash": str(v["hash"]), "ts": int(v["ts"])}
        return out
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        logger.warning(
            "plane_sync: outbound signatures at %s unreadable (%s) — starting fresh",
            path, exc,
        )
        return {}


def _save_outbound_sigs_to_disk(path: Path, sigs: dict[str, dict[str, Any]]) -> None:
    """FIFO-evict above cap, then atomically write."""
    if len(sigs) > _OUTBOUND_SIGS_CAP:
        # Sort by ts ascending, drop the oldest overflow. Python dicts
        # preserve insertion order so we rebuild in chronological order.
        ordered = sorted(sigs.items(), key=lambda kv: int(kv[1].get("ts", 0)))
        ordered = ordered[-_OUTBOUND_SIGS_CAP:]
        sigs = {k: v for k, v in ordered}
    payload = json.dumps(sigs, sort_keys=True, separators=(",", ":"))
    _atomic_write(path, payload)


def _record_outbound_signature(plane_id: str, payload: dict[str, Any]) -> None:
    """Record the hash of an outbound Plane write. Best-effort — logs and
    continues on any I/O failure.

    Called from ``sync_matter_to_plane`` / ``sync_task_to_plane`` AFTER
    a successful PUT/POST so reverse-sync can recognise the echo that
    Plane's webhook will fire milliseconds later.
    """
    if not plane_id:
        return
    try:
        path = _outbound_sigs_path()
        sigs = _load_outbound_sigs_from_disk(path)
        sigs[str(plane_id)] = {
            "hash": compute_loop_guard_hash(payload),
            "ts": int(time.time() * 1000),
        }
        _save_outbound_sigs_to_disk(path, sigs)
    except Exception as exc:  # noqa: BLE001 — signature write must never break sync
        logger.warning(
            "plane_sync: failed to record outbound signature plane_id=%s: %s",
            plane_id, exc,
        )


def _cursor_path() -> Path:
    """Absolute path of the plane-sync cursor file under alfred-data.

    Isolated into a function so tests can monkeypatch
    ``load_config().alfred_data_dir`` without having to reach into the
    activity module.
    """
    cfg = load_config()
    return Path(cfg.alfred_data_dir) / _CURSOR_RELATIVE


def _load_cursor_from_disk(path: Path) -> dict[str, Any]:
    """Read the cursor file. Returns a fresh empty state when missing."""
    if not path.exists():
        return {"last_vault_mtime": 0.0, "project_map": {}, "issue_map": {}}
    try:
        with path.open("r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            raise ValueError("cursor is not a JSON object")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        logger.warning(
            "plane_sync: cursor at %s unreadable (%s) — starting fresh", path, exc
        )
        return {"last_vault_mtime": 0.0, "project_map": {}, "issue_map": {}}

    state = {
        "last_vault_mtime": float(raw.get("last_vault_mtime", 0.0) or 0.0),
        "project_map": dict(raw.get("project_map") or {}),
        "issue_map": dict(raw.get("issue_map") or {}),
    }
    return state


def _atomic_write(path: Path, payload: str) -> None:
    """Write ``payload`` to ``path`` atomically (temp file + rename)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_str = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    tmp = Path(tmp_str)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
        os.replace(tmp, path)
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Record mtime extraction — vault frontmatter doesn't expose file mtime
# (the ctrl-api list endpoint returns only {path, name, status, frontmatter,
# body_preview, created}). We derive a best-effort timestamp:
#
#   max(frontmatter.updated, frontmatter.modified, frontmatter.created)
#
# All parsed as ISO-8601 → float epoch seconds. If no field parses we fall
# back to 0.0 so the record always gets picked up on the next run rather
# than silently dropped.
# ---------------------------------------------------------------------------

# Accept full ISO datetime OR date-only (e.g. '2026-04-08'). Vault frontmatter
# commonly has `created: 2026-04-08` with no time component — before this relax,
# every such record had mtime 0.0 and the sync filter `mtime > cursor` excluded
# them permanently (matters never synced).
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2})?)?")


def _iso_to_epoch(value: Any) -> float:
    if not value or not isinstance(value, str):
        return 0.0
    value = value.strip()
    if not _ISO_RE.match(value):
        return 0.0
    # Normalize: space → T, drop trailing 'Z'
    s = value.replace(" ", "T")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        from datetime import datetime
        return datetime.fromisoformat(s).timestamp()
    except (ValueError, TypeError):
        return 0.0


# Plane 1.3.0 rejects project/issue names containing `-`, `&`, `'`, `"` and
# similar "special" characters with 400 "Project name cannot contain special
# characters." Matter titles frequently include hyphens (slug-style) or
# ampersands (e.g. "Family Life & Hanna's First Year"), so we sanitize before
# sending. Keep it minimal: replace rejected chars with spaces, drop quotes,
# collapse whitespace, fall back to a safe default.
_PLANE_NAME_REJECT_RE = re.compile(r"[-&]+")


def _sanitize_plane_name(raw: str) -> str:
    if not raw:
        return "Untitled"
    cleaned = _PLANE_NAME_REJECT_RE.sub(" ", raw).replace("'", "").replace('"', "")
    cleaned = " ".join(cleaned.split()).strip()
    return cleaned or "Untitled"


def _record_mtime(record: dict[str, Any]) -> float:
    fm = record.get("frontmatter") or {}
    best = 0.0
    for key in ("updated", "modified", "created"):
        ts = _iso_to_epoch(fm.get(key))
        if ts > best:
            best = ts
    # Fallback: top-level 'created' field on the list endpoint envelope
    top_created = _iso_to_epoch(record.get("created"))
    if top_created > best:
        best = top_created
    return best


def _slug_from_path(path: str) -> str:
    """Convert 'matter/client-x.md' → 'client-x'. Tolerates missing prefix/suffix."""
    base = path.rsplit("/", 1)[-1]
    if base.endswith(".md"):
        base = base[:-3]
    return base


def _normalize_matter_ref(value: Any) -> Optional[str]:
    """Extract a matter slug from a task's ``matter`` frontmatter field.

    Accepts: ``'matter/foo.md'``, ``'matter/foo'``, ``'foo'``, ``'[[matter/foo]]'``.
    Returns None when the field is empty.
    """
    if not value:
        return None
    if not isinstance(value, str):
        return None
    s = value.strip().strip('"').strip("'")
    if not s:
        return None
    # Obsidian-style wikilink: [[matter/foo]] or [[foo]]
    if s.startswith("[[") and s.endswith("]]"):
        s = s[2:-2]
    if s.startswith("matter/"):
        s = s[len("matter/"):]
    if s.endswith(".md"):
        s = s[:-3]
    return s or None


def _resolve_task_matter(fm: dict[str, Any]) -> Optional[str]:
    """Resolve a task's matter slug from frontmatter, honoring several
    field conventions that co-exist on the fleet today:

    1. Scalar ``matter`` — legacy / generator-emitted / manually set
    2. Scalar ``related_matter`` — older singular name
    3. Array ``related_matters`` — what the hourly enrichment pipeline
       (#395) writes; head of list is the primary match

    Returns ``None`` if none of the three resolve to a slug.
    """
    direct = _normalize_matter_ref(fm.get("matter"))
    if direct:
        return direct
    legacy = _normalize_matter_ref(fm.get("related_matter"))
    if legacy:
        return legacy
    arr = fm.get("related_matters")
    if isinstance(arr, list) and arr:
        return _normalize_matter_ref(arr[0])
    return None


# Sentinel key used in ``project_map`` to refer to the Inbox project —
# a catch-all destination for tasks that have no matter link yet.
# Declared here + in plane_mapping so both forward and reverse sync can
# recognise it without importing across sibling activity modules.
INBOX_SLUG_SENTINEL = "__inbox__"


# ---------------------------------------------------------------------------
# Plane client lifecycle
# ---------------------------------------------------------------------------

def _plane_client_from_env() -> PlaneClient:
    return PlaneClient(
        base_url=os.environ.get("PLANE_API_BASE_URL") or os.environ.get("PLANE_API_URL"),
        token=os.environ.get("PLANE_API_TOKEN"),
        workspace_slug=os.environ.get("PLANE_WORKSPACE_SLUG"),
    )


# ---------------------------------------------------------------------------
# Activity: feature flag check (env var reads are not workflow-safe, so
# this tiny activity wraps them)
# ---------------------------------------------------------------------------

@activity.defn
async def plane_sync_is_enabled() -> bool:
    """Return True iff ``PLANE_SYNC_ENABLED=true`` in the environment."""
    return os.environ.get("PLANE_SYNC_ENABLED", "").lower() == "true"


# ---------------------------------------------------------------------------
# Activity: load cursor
# ---------------------------------------------------------------------------

@activity.defn
async def load_plane_sync_state() -> dict[str, Any]:
    """Load the cursor file. Always returns a well-shaped dict."""
    path = _cursor_path()
    state = _load_cursor_from_disk(path)
    logger.info(
        "plane_sync: cursor loaded last_vault_mtime=%s projects=%d issues=%d",
        state["last_vault_mtime"],
        len(state["project_map"]),
        len(state["issue_map"]),
    )
    return state


# ---------------------------------------------------------------------------
# Activity: save cursor
# ---------------------------------------------------------------------------

@activity.defn
async def save_plane_sync_state(state: dict[str, Any]) -> None:
    """Persist the cursor atomically. Called at end of workflow run."""
    path = _cursor_path()
    payload = json.dumps({
        "last_vault_mtime": float(state.get("last_vault_mtime", 0.0) or 0.0),
        "project_map": dict(state.get("project_map") or {}),
        "issue_map": dict(state.get("issue_map") or {}),
    }, indent=2, sort_keys=True)
    _atomic_write(path, payload)
    logger.info(
        "plane_sync: cursor saved last_vault_mtime=%s projects=%d issues=%d path=%s",
        state.get("last_vault_mtime"),
        len(state.get("project_map") or {}),
        len(state.get("issue_map") or {}),
        path,
    )


# ---------------------------------------------------------------------------
# Activity: fetch changed matters (since mtime)
# ---------------------------------------------------------------------------

@activity.defn
async def fetch_changed_matters(since_mtime: float) -> list[dict[str, Any]]:
    """Return matter records whose derived mtime is strictly greater than ``since_mtime``.

    Each returned record is shaped as::

        {"slug": str, "path": str, "frontmatter": dict, "mtime": float}

    Body is NOT included — the workflow stays small and the Plane project
    upsert only needs frontmatter (title, description).
    """
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        records = await client.list_records("matter", limit=10_000)
    except Exception as exc:
        logger.error("plane_sync: list_records(matter) failed: %s", exc)
        raise
    finally:
        await client.close()

    changed: list[dict[str, Any]] = []
    for rec in records:
        mtime = _record_mtime(rec)
        if mtime <= since_mtime:
            continue
        path = rec.get("path", "")
        slug = _slug_from_path(path)
        if not slug:
            continue
        fm = rec.get("frontmatter") or {}
        # Carry body_preview so the project description has *something*
        # meaningful on first sync. Full body fetch is unnecessary noise.
        fm = dict(fm)
        fm.setdefault("description_preview", rec.get("body_preview", ""))
        changed.append({
            "slug": slug,
            "path": path,
            "frontmatter": fm,
            "mtime": mtime,
        })
    logger.info(
        "plane_sync: fetch_changed_matters since=%s found=%d",
        since_mtime,
        len(changed),
    )
    return changed


# ---------------------------------------------------------------------------
# Activity: fetch changed tasks (since mtime)
# ---------------------------------------------------------------------------

@activity.defn
async def fetch_changed_tasks(since_mtime: float) -> list[dict[str, Any]]:
    """Return task records whose derived mtime is strictly greater than ``since_mtime``."""
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        records = await client.list_records("task", limit=10_000)
    except Exception as exc:
        logger.error("plane_sync: list_records(task) failed: %s", exc)
        raise
    finally:
        await client.close()

    changed: list[dict[str, Any]] = []
    for rec in records:
        mtime = _record_mtime(rec)
        if mtime <= since_mtime:
            continue
        path = rec.get("path", "")
        slug = _slug_from_path(path)
        if not slug:
            continue
        fm = dict(rec.get("frontmatter") or {})
        # Normalize matter ref so the workflow doesn't have to branch.
        # Accepts scalar `matter` / `related_matter` AND the enrichment-
        # pipeline's `related_matters[0]` (the common case on mature
        # tenants where surveyor has already linked tasks to matters).
        matter_ref = _resolve_task_matter(fm)
        changed.append({
            "slug": slug,
            "path": path,
            "frontmatter": fm,
            "matter_slug": matter_ref,
            "mtime": mtime,
        })
    logger.info(
        "plane_sync: fetch_changed_tasks since=%s found=%d",
        since_mtime,
        len(changed),
    )
    return changed


# ---------------------------------------------------------------------------
# Activity: upsert matter → Plane project
# ---------------------------------------------------------------------------

def _project_identifier_for_slug(slug: str) -> str:
    """Build a Plane project identifier (uppercase, ≤ 5 chars)."""
    cleaned = re.sub(r"[^A-Za-z0-9]", "", slug).upper()
    if not cleaned:
        cleaned = "ALFRD"
    return cleaned[:5]


@activity.defn
async def sync_matter_to_plane(
    matter: dict[str, Any],
    project_map: dict[str, str],
) -> dict[str, str]:
    """Create or update the Plane project mirroring this matter record.

    Returns ``{"slug", "plane_id", "action"}`` where action is ``"create"``
    or ``"update"``. On permanent failure we raise — Temporal's retry
    policy on the workflow side decides whether to retry or surface the
    error without advancing the cursor.
    """
    slug = matter["slug"]
    fm = matter.get("frontmatter") or {}
    raw_name = str(fm.get("name") or fm.get("title") or slug).strip() or slug
    name = _sanitize_plane_name(raw_name)
    description = str(fm.get("description") or fm.get("description_preview") or "").strip()

    client = _plane_client_from_env()
    try:
        existing_id = project_map.get(slug)
        if existing_id:
            patch_body = {"name": name, "description_text": description}
            await client.update_project(existing_id, patch=patch_body)
            action = "update"
            plane_id = existing_id
            logger.info(
                "plane_sync.project_upsert slug=%s plane_id=%s action=%s",
                slug, plane_id, action,
            )
            _record_outbound_signature(plane_id, patch_body)
            return {"slug": slug, "plane_id": plane_id, "action": action}

        # Create path — include origin stamp so webhook-back events
        # can be detected as loop-back in B7.
        create_body = {"name": name, "description_text": description}
        created = await client.create_project(
            name=name,
            identifier=_project_identifier_for_slug(slug),
            description=description,
        )
        plane_id = str(created.get("id") or "")
        if not plane_id:
            raise RuntimeError(
                f"plane_sync: create_project({slug}) returned no id: {created!r}"
            )
        action = "create"
        logger.info(
            "plane_sync.project_upsert slug=%s plane_id=%s action=%s",
            slug, plane_id, action,
        )
        _record_outbound_signature(plane_id, create_body)
        return {"slug": slug, "plane_id": plane_id, "action": action}
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Activity: upsert task → Plane issue
# ---------------------------------------------------------------------------

@activity.defn
async def ensure_inbox_project(project_map: dict[str, str]) -> dict[str, str]:
    """Ensure an "Inbox" project exists in the Plane workspace.

    Returns ``{"plane_id": "...", "action": "existing"|"created"}``.
    Idempotent — safe to call every workflow run.

    The Inbox is the catch-all destination for vault tasks whose matter
    cannot be resolved at sync time. Tasks that do have a matter still
    go to their real project. When a human moves an issue from Inbox
    into a real project inside Plane, the reverse-sync workflow catches
    the ``issue.updated`` event with a changed ``project`` field and
    writes ``related_matters=[<new-slug>]`` back onto the vault task.
    """
    existing_id = project_map.get(INBOX_SLUG_SENTINEL)
    if existing_id:
        return {"plane_id": existing_id, "action": "existing"}

    client = _plane_client_from_env()
    try:
        created = await client.create_project(
            name="Inbox",
            identifier="INBOX",
            description=(
                "Unsorted tasks without a matter link. Drag an issue into "
                "a matter project to reassign — the change propagates to "
                "the vault on the next reverse-sync tick."
            ),
        )
        plane_id = str(created.get("id") or "")
        if not plane_id:
            raise RuntimeError(
                f"ensure_inbox_project: no id returned: {created!r}"
            )
        logger.info(
            "plane_sync.inbox_project_created plane_id=%s",
            plane_id,
        )
        return {"plane_id": plane_id, "action": "created"}
    finally:
        await client.close()


@activity.defn
async def sync_task_to_plane(
    task: dict[str, Any],
    project_map: dict[str, str],
    issue_map: dict[str, str],
) -> dict[str, str]:
    """Create or update the Plane issue mirroring this task record.

    Resolution order for the destination project:
    1. ``matter_slug`` resolves to a known Plane project → that project
    2. Otherwise → the Inbox project (``project_map[INBOX_SLUG_SENTINEL]``)
    3. If the Inbox isn't in the map yet (first-run race) → skip for
       this run; next run will have the Inbox after ``ensure_inbox_project``
    """
    slug = task["slug"]
    matter_slug = task.get("matter_slug")
    fm = task.get("frontmatter") or {}

    project_id: Optional[str] = None
    if matter_slug:
        project_id = project_map.get(matter_slug)
        if not project_id:
            # matter_slug is set but not in project_map — either a
            # bogus/free-text value ("Manus AI billing" rather than a
            # real slug) or a matter that legitimately hasn't synced
            # yet. Either way, routing to Inbox is strictly better
            # than skipping forever: we don't lose the task, and a
            # later reverse-sync project-move can still relocate it.
            # Without this fallback, a handful of garbage-valued
            # matter refs permanently hold the cursor at zero.
            logger.warning(
                "plane_sync.issue_upsert slug=%s matter=%s unresolved — routing to Inbox",
                slug, matter_slug,
            )
            project_id = project_map.get(INBOX_SLUG_SENTINEL)

    if not project_id:
        project_id = project_map.get(INBOX_SLUG_SENTINEL)

    if not project_id:
        # Inbox hasn't synced yet — defer. ensure_inbox_project runs
        # before the task loop so this should only happen on the first
        # workflow run after Plane provisioning, or if ensure failed.
        logger.info(
            "plane_sync.issue_upsert slug=%s action=skip reason=no_inbox",
            slug,
        )
        return {"slug": slug, "plane_id": "", "action": "skip"}

    update = vault_task_to_plane_update(fm)
    state_group = update.pop("state_group", None)
    labels = update.pop("labels", []) or []
    client = _plane_client_from_env()
    try:
        # Resolve state_group → state UUID for this project
        state_id: Optional[str] = None
        if state_group:
            state_id = await client.resolve_state_id(project_id, state_group)

        # Always include 'alfred-managed' in Plane labels, regardless of
        # what mapping returned. Label names are case-sensitive; we use
        # 'alfred-managed' on the Plane side for B4 (the colon-prefixed
        # 'alfred:managed' constant in plane_mapping is the canonical
        # vault tag — convert to hyphenated for Plane display).
        label_names: list[str] = []
        seen: set[str] = set()
        for lb in list(labels) + ["alfred-managed"]:
            # Map 'alfred:managed' → 'alfred-managed' for Plane UI friendliness
            name = str(lb).replace(":", "-")
            if name and name not in seen:
                seen.add(name)
                label_names.append(name)

        label_ids: list[str] = await client.ensure_labels(project_id, label_names)

        existing_id = issue_map.get(slug)
        # description_html: Plane 1.3.0 rejects empty string with
        # "Invalid HTML passed" — omit the key entirely when the task
        # has no description rather than sending "".
        description_html = str(fm.get("description") or "")
        issue_body: dict[str, Any] = {
            "name": _sanitize_plane_name(str(update.get("name") or slug)),
            "priority": update.get("priority") or "none",
            "labels": label_ids,
        }
        if description_html:
            issue_body["description_html"] = description_html
        if state_id:
            issue_body["state"] = state_id

        if existing_id:
            await client.update_issue(project_id, existing_id, issue_body)
            action = "update"
            plane_id = existing_id
        else:
            # On create we also stamp external_id for loop-back detection.
            created = await client.create_issue(
                project_id,
                name=issue_body["name"],
                description=issue_body.get("description_html", ""),
                priority=issue_body["priority"],
                state_id=state_id,
                label_ids=label_ids,
                external_id=f"alfred:{slug}",
            )
            plane_id = str(created.get("id") or "")
            if not plane_id:
                raise RuntimeError(
                    f"plane_sync: create_issue({slug}) returned no id: {created!r}"
                )
            action = "create"

        logger.info(
            "plane_sync.issue_upsert slug=%s plane_id=%s project=%s action=%s",
            slug, plane_id, project_id, action,
        )
        # Record the outbound signature so reverse-sync can recognise the
        # webhook echo that Plane fires immediately after this write.
        # Build a guard-compatible payload: merge what we sent with the
        # hashed ``state`` group name (labels/state_id are per-project
        # UUIDs that don't travel cross-direction).
        outbound_for_hash: dict[str, Any] = {
            "name": issue_body["name"],
            "description": issue_body["description_html"],
            "priority": issue_body["priority"],
            "state": update.get("state_group") or "",
        }
        _record_outbound_signature(plane_id, outbound_for_hash)
        return {
            "slug": slug,
            "plane_id": plane_id,
            "action": action,
            "project_id": project_id,
        }
    finally:
        await client.close()
