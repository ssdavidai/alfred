"""Activities backing the PlaneReverseSyncWorkflow — Plane → vault sync (#536 B7).

Consumes ``stream_type: "plane"`` events emitted by
``POST /api/v1/plane/webhook`` in ctrl-api (see ``packages/ctrl/src/api/routes/plane.ts``).
Translates Plane project/issue/comment events into vault matter/task/comment
patches and applies them via the ctrl-api vault endpoints.

**Loop guards** (all three required so the pair of
``PlaneSyncWorkflow`` + ``PlaneReverseSyncWorkflow`` doesn't oscillate):

1. **Origin stamp + hash match** — issues created by forward-sync carry
   ``external_id == "alfred:<slug>"``. When the inbound event's
   ``external_id`` points at a vault record we already own AND the
   content hash matches the last outbound signature, skip.

2. **Suppression window** — for every outbound PUT forward-sync records a
   ``(plane_id → {hash, ts})`` entry in
   ``/alfred-data/state/plane_outbound_signatures.json``. An inbound
   event within 30 seconds of such a record with the same hash is
   treated as the PUT's own echo → skip.

3. **Field-level idempotency** — before writing any vault record,
   compute the loop-guard hash of the existing frontmatter. If the
   inbound patch wouldn't change that hash, do NOT write the file.
   Skipping the write means no mtime bump, so forward-sync won't try
   to push back, and the loop dies.

None of these guards is sufficient on its own — the three together
cover the three race windows (webhook fires after write completes,
webhook arrives before we record the signature, patch is a true no-op
after the forward sync normalised it).
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

import httpx
from temporalio import activity

from src.config import Config, load_config
from src.utils.plane_mapping import (
    compute_loop_guard_hash,
    plane_issue_to_vault_patch,
    plane_project_to_matter_patch,
)
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_REVERSE_CURSOR_RELATIVE = "state/plane_reverse_sync_cursor.json"
_OUTBOUND_SIGS_RELATIVE = "state/plane_outbound_signatures.json"
_FORWARD_CURSOR_RELATIVE = "state/plane_sync_cursor.json"

# 30s race window for guard #2 — wide enough to cover Plane webhook
# latency (seen ~1-5s p99) plus our own batched write flush.
_SUPPRESSION_WINDOW_MS = 30_000

# Guard against runaway event pulls per workflow tick. Pair with the
# workflow's own inner loop limit.
DEFAULT_EVENT_FETCH_LIMIT = 200


def _alfred_data() -> Path:
    cfg = load_config()
    return Path(cfg.alfred_data_dir)


def _reverse_cursor_path() -> Path:
    return _alfred_data() / _REVERSE_CURSOR_RELATIVE


def _outbound_sigs_path() -> Path:
    return _alfred_data() / _OUTBOUND_SIGS_RELATIVE


def _forward_cursor_path() -> Path:
    return _alfred_data() / _FORWARD_CURSOR_RELATIVE


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
# Cursor + signature I/O
# ---------------------------------------------------------------------------

def _load_reverse_cursor(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"last_event_id": "", "last_event_ts": 0.0}
    try:
        with path.open("r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            raise ValueError("cursor is not a JSON object")
        return {
            "last_event_id": str(raw.get("last_event_id", "") or ""),
            "last_event_ts": float(raw.get("last_event_ts", 0.0) or 0.0),
        }
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        logger.warning(
            "plane_reverse_sync: cursor at %s unreadable (%s) — starting fresh",
            path, exc,
        )
        return {"last_event_id": "", "last_event_ts": 0.0}


def _save_reverse_cursor(path: Path, cursor: dict[str, Any]) -> None:
    payload = json.dumps({
        "last_event_id": str(cursor.get("last_event_id", "") or ""),
        "last_event_ts": float(cursor.get("last_event_ts", 0.0) or 0.0),
    }, sort_keys=True, separators=(",", ":"))
    _atomic_write(path, payload)


def _load_outbound_sigs(path: Path) -> dict[str, dict[str, Any]]:
    """Read the shared outbound-signature store. Empty dict on missing/corrupt."""
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            return {}
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
            "plane_reverse_sync: outbound signatures unreadable (%s) — empty",
            exc,
        )
        return {}


def _load_forward_cursor(path: Path) -> dict[str, Any]:
    """Load forward-sync cursor, needed for the project_map/issue_map lookups."""
    if not path.exists():
        return {"project_map": {}, "issue_map": {}}
    try:
        with path.open("r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            return {"project_map": {}, "issue_map": {}}
        return {
            "project_map": dict(raw.get("project_map") or {}),
            "issue_map": dict(raw.get("issue_map") or {}),
        }
    except (OSError, ValueError, json.JSONDecodeError):
        return {"project_map": {}, "issue_map": {}}


# ---------------------------------------------------------------------------
# Activity: feature flag
# ---------------------------------------------------------------------------

@activity.defn
async def plane_reverse_sync_is_enabled() -> bool:
    """Return True iff ``PLANE_SYNC_ENABLED=true`` in env.

    Same flag as forward sync — the two sides share an on/off switch.
    """
    return os.environ.get("PLANE_SYNC_ENABLED", "").lower() == "true"


# ---------------------------------------------------------------------------
# Activity: fetch Plane events from ctrl-api streams endpoint
# ---------------------------------------------------------------------------

@activity.defn
async def fetch_plane_events(since_id: str) -> list[dict[str, Any]]:
    """Pull recent ``stream_type: "plane"`` events from ctrl-api.

    Uses ``GET /api/v1/streams/events?status=unprocessed&limit=N`` and
    filters client-side to the ``plane`` stream. The workflow does the
    ``since_id`` cursor check — Plane webhooks don't guarantee strict
    ordering, so we always look at the tail and use the cursor as a
    "don't re-deliver this id" guard rather than a monotonic marker.
    """
    cfg = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    params = {"status": "unprocessed", "limit": DEFAULT_EVENT_FETCH_LIMIT}

    async with httpx.AsyncClient(
        base_url=cfg.alfred_ctrl_url, timeout=30.0, headers=headers
    ) as client:
        r = await client.get("/api/v1/streams/events", params=params)
        r.raise_for_status()
        data = r.json()

    events = data.get("events") or []
    plane_events: list[dict[str, Any]] = []
    for ev in events:
        if ev.get("stream_type") != "plane":
            continue
        plane_events.append(ev)

    # Sort oldest → newest so the cursor advances monotonically.
    plane_events.sort(key=lambda e: e.get("received_at") or "")

    # Cursor dedupe — drop events at or before ``since_id``. We find the
    # position of the cursor in the sorted list; anything at or before
    # it is already processed.
    if since_id:
        dropped = 0
        for i, ev in enumerate(plane_events):
            if ev.get("id") == since_id:
                plane_events = plane_events[i + 1:]
                dropped = i + 1
                break
        if dropped:
            logger.info(
                "plane_reverse_sync: dropped %d events at/before cursor %s",
                dropped, since_id,
            )

    logger.info(
        "plane_reverse_sync: fetched %d plane events (since_id=%s)",
        len(plane_events), since_id or "<none>",
    )
    return plane_events


# ---------------------------------------------------------------------------
# Activity: compute payload hash — thin wrapper so workflow tests can
# stub it, and so callers never reach into plane_mapping directly.
# ---------------------------------------------------------------------------

@activity.defn
async def compute_plane_payload_hash(payload: dict[str, Any]) -> str:
    """Return SHA-256 hex digest over the loop-guard fields of ``payload``."""
    return compute_loop_guard_hash(payload or {})


# ---------------------------------------------------------------------------
# Activity: load / save outbound signatures (workflow-safe shims)
# ---------------------------------------------------------------------------

@activity.defn
async def load_outbound_signatures() -> dict[str, dict[str, Any]]:
    return _load_outbound_sigs(_outbound_sigs_path())


@activity.defn
async def save_outbound_signatures(sigs: dict[str, dict[str, Any]]) -> None:
    """Persist the outbound-signature store with FIFO eviction above cap."""
    # Same cap as the forward-sync-side writer so the two writers agree.
    from src.activities.plane_sync import _OUTBOUND_SIGS_CAP  # local import to avoid circular

    clean: dict[str, dict[str, Any]] = {}
    for k, v in (sigs or {}).items():
        if not isinstance(v, dict):
            continue
        if "hash" not in v or "ts" not in v:
            continue
        clean[str(k)] = {"hash": str(v["hash"]), "ts": int(v["ts"])}

    if len(clean) > _OUTBOUND_SIGS_CAP:
        ordered = sorted(clean.items(), key=lambda kv: int(kv[1].get("ts", 0)))
        ordered = ordered[-_OUTBOUND_SIGS_CAP:]
        clean = {k: v for k, v in ordered}

    payload = json.dumps(clean, sort_keys=True, separators=(",", ":"))
    _atomic_write(_outbound_sigs_path(), payload)


# ---------------------------------------------------------------------------
# Activity: load reverse cursor + project_map from forward cursor
# ---------------------------------------------------------------------------

@activity.defn
async def load_reverse_sync_state() -> dict[str, Any]:
    """Bundle reverse-sync cursor + forward-sync maps into one fetch.

    Workflow gets everything it needs to route inbound events without
    a second activity round-trip.
    """
    cursor = _load_reverse_cursor(_reverse_cursor_path())
    forward = _load_forward_cursor(_forward_cursor_path())
    sigs = _load_outbound_sigs(_outbound_sigs_path())
    return {
        "cursor": cursor,
        "project_map": forward.get("project_map") or {},
        "issue_map": forward.get("issue_map") or {},
        "outbound_signatures": sigs,
    }


@activity.defn
async def save_reverse_sync_cursor(cursor: dict[str, Any]) -> None:
    _save_reverse_cursor(_reverse_cursor_path(), cursor)


# ---------------------------------------------------------------------------
# Vault record lookup helpers
# ---------------------------------------------------------------------------

def _matter_path_for_slug(slug: str) -> str:
    """Vault-relative path of a matter by slug."""
    return f"matter/{slug}.md"


def _parse_alfred_external_id(value: Any) -> Optional[str]:
    """Extract the slug from an ``alfred:<slug>`` external_id.

    Returns None if the value is absent, not a string, or doesn't use
    the ``alfred:`` prefix (i.e. it's a human-created Plane record).
    """
    if not isinstance(value, str):
        return None
    if not value.startswith("alfred:"):
        return None
    rest = value[len("alfred:"):]
    return rest or None


async def _find_matter_by_plane_id(
    client: VaultClient, plane_project_id: str
) -> Optional[str]:
    """Scan matters for one whose frontmatter ``plane_project_id`` matches.

    Used when reverse-sync receives an event with no ``external_id``
    pointer back to a vault slug. O(n) in matter count — fine for
    tenants with <1000 matters which is the whole fleet today.
    """
    if not plane_project_id:
        return None
    matters = await client.list_records("matter", limit=10_000)
    for rec in matters:
        fm = rec.get("frontmatter") or {}
        if str(fm.get("plane_project_id") or "") == plane_project_id:
            path = rec.get("path") or ""
            if path:
                return path
    return None


async def _find_task_by_plane_id(
    client: VaultClient, plane_issue_id: str
) -> Optional[str]:
    if not plane_issue_id:
        return None
    tasks = await client.list_records("task", limit=10_000)
    for rec in tasks:
        fm = rec.get("frontmatter") or {}
        if str(fm.get("plane_issue_id") or "") == plane_issue_id:
            path = rec.get("path") or ""
            if path:
                return path
    return None


async def _read_frontmatter(client: VaultClient, path: str) -> Optional[dict[str, Any]]:
    """Return just the frontmatter of a vault record, or None on 404."""
    try:
        rec = await client.read_record(path)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            return None
        raise
    return rec.get("frontmatter") or {}


# ---------------------------------------------------------------------------
# Activity: apply patch to vault with field-hash idempotency (guard #3)
# ---------------------------------------------------------------------------

@activity.defn
async def apply_plane_patch_to_vault(
    record_type: str,
    path: str,
    patch: dict[str, Any],
    inbound_hash: str,
) -> dict[str, Any]:
    """Apply ``patch`` to the vault record at ``path``.

    Returns a dict: ``{"applied": bool, "action": str, "reason": str}``.

    ``applied=False`` means the field hash of the existing record already
    matches the inbound hash — no vault write happens. This is the
    third loop guard: without it, every reverse-sync write bumps mtime
    and forward-sync pushes right back, oscillating forever.

    ``record_type`` is purely advisory for logging today (``matter`` or
    ``task``). The write goes through ``patch_frontmatter`` either way.
    """
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        current = await _read_frontmatter(client, path)
        if current is None:
            logger.warning(
                "plane_reverse_sync: record %s not found — skipping patch",
                path,
            )
            return {"applied": False, "action": "missing", "reason": "record_not_found"}

        # Compose a synthetic "what would it look like after the patch"
        # frontmatter and hash it. If identical to the current hash, skip.
        merged: dict[str, Any] = dict(current)
        for k, v in (patch or {}).items():
            merged[k] = v

        # Build inbound-shaped canonical payloads for both sides so the
        # hash compares apples to apples (vault frontmatter uses vault
        # field names; the loop-guard hash uses Plane field names).
        def _fm_to_guard_payload(fm: dict[str, Any]) -> dict[str, Any]:
            """Translate vault frontmatter → Plane-shaped guard payload.

            The loop-guard hash is computed over Plane field names so
            the outbound signature (computed pre-write) and the reverse
            check (computed post-merge) share one coordinate system.
            """
            from src.utils.plane_mapping import (
                VAULT_PRIORITY_TO_PLANE,
                VAULT_TASK_TO_PLANE_STATE_GROUP,
            )

            status = fm.get("status")
            state_group = VAULT_TASK_TO_PLANE_STATE_GROUP.get(
                str(status) if status else "", ""
            )
            return {
                "name": fm.get("name") or "",
                "description": fm.get("description") or "",
                "state_group": state_group,
                "priority": VAULT_PRIORITY_TO_PLANE.get(
                    fm.get("priority"), "none",
                ),
                "due_date": fm.get("due_date") or "",
                "assignees": fm.get("assignees") or [],
            }

        before_hash = compute_loop_guard_hash(_fm_to_guard_payload(current))
        after_hash = compute_loop_guard_hash(_fm_to_guard_payload(merged))

        if before_hash == after_hash:
            logger.info(
                "plane_reverse_sync: field hash unchanged for %s — skipping write "
                "(before=%s after=%s)",
                path, before_hash[:8], after_hash[:8],
            )
            return {
                "applied": False,
                "action": "noop_hash_match",
                "reason": "field_hash_unchanged",
            }

        # Write only the fields that actually differ from current — the
        # alfred vault edit CLI logs every set, so a narrow write keeps
        # history clean.
        changed: dict[str, Any] = {}
        for k, v in (patch or {}).items():
            if current.get(k) != v:
                changed[k] = v

        if not changed:
            # Belt-and-suspenders: the hash-level check already caught
            # this, but a dict-level comparison catches shape mismatches
            # the guard-payload extractor might smooth over.
            return {
                "applied": False,
                "action": "noop_no_diff",
                "reason": "no_field_actually_changed",
            }

        await client.patch_frontmatter(path, changed)
        logger.info(
            "plane_reverse_sync: applied patch to %s fields=%s",
            path, sorted(changed.keys()),
        )
        return {
            "applied": True,
            "action": "patched",
            "reason": "",
            "changed_fields": sorted(changed.keys()),
        }
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Activity: create new vault task from human-created Plane issue
# ---------------------------------------------------------------------------

@activity.defn
async def create_vault_task_from_plane_issue(
    issue: dict[str, Any],
    matter_slug: Optional[str],
) -> dict[str, Any]:
    """Create a vault task mirroring a Plane issue that has no
    ``alfred:<slug>`` external_id.

    ``matter_slug`` is resolved by the workflow via the forward-sync
    ``project_map`` (``plane_project_id`` → matter slug). When it's
    None we still create the task, just without a matter link —
    surveyor will eventually attach one.
    """
    plane_issue_id = str(issue.get("id") or "")
    if not plane_issue_id:
        raise ValueError("plane issue has no id — cannot create vault task")

    patch = plane_issue_to_vault_patch(issue)
    name = str(patch.get("name") or "").strip() or f"plane-issue-{plane_issue_id[:8]}"
    # Sanitize a slug from the name — lowercase, alnum + dashes, trunc.
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]
    if not slug:
        slug = f"plane-{plane_issue_id[:8]}"

    # Build full YAML frontmatter body via the generic content writer.
    # We go through VaultClient.write_record with the raw content shape
    # so the record gets the standard ``plane_issue_id`` back-pointer
    # and ``external_id`` stamp for future reverse-sync lookups.
    fm_lines = [
        "---",
        "type: task",
        f"name: {json.dumps(name)}",
        f"status: {patch.get('status') or 'todo'}",
        f"plane_issue_id: {plane_issue_id}",
        f"external_id: plane:{plane_issue_id}",
        f"external_source: plane",
    ]
    priority = patch.get("priority")
    if priority:
        fm_lines.append(f"priority: {priority}")
    if matter_slug:
        fm_lines.append(f"matter: matter/{matter_slug}")
    fm_lines.append("---")
    fm_lines.append("")
    description = str(issue.get("description_html") or issue.get("description") or "")
    if description:
        fm_lines.append(description)
    content = "\n".join(fm_lines) + "\n"

    cfg = load_config()
    client = VaultClient(cfg)
    try:
        path = await client.write_record("task", slug, content)
        logger.info(
            "plane_reverse_sync: created vault task %s for plane issue %s "
            "(matter=%s)",
            path, plane_issue_id, matter_slug or "<none>",
        )
        return {"path": path, "slug": slug, "plane_issue_id": plane_issue_id}
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Activity: append comment to matter/task frontmatter
# ---------------------------------------------------------------------------

@activity.defn
async def append_plane_comment_to_vault(
    path: str,
    comment: dict[str, Any],
) -> dict[str, Any]:
    """Append a comment entry to a vault record's ``comments:`` list.

    The frontmatter already may or may not have a ``comments`` field.
    Under the ``alfred vault edit`` CLI, we can't directly mutate a
    list-valued frontmatter field; instead we append a pipe-delimited
    entry to a string-valued ``last_plane_comment`` field and a
    running counter to ``plane_comments_count``. B8 will build the
    proper list-append via a new CLI flag; B7 gives the audit trail.
    """
    author = str(comment.get("actor_display_name") or comment.get("actor_email") or "unknown")
    text = str(comment.get("comment_stripped") or comment.get("comment_html") or "")
    # Compact single-line encoding so it round-trips through YAML without
    # multiline-block complications. Newlines → \n, pipes escaped.
    compact = text.replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ").strip()[:500]

    updates: dict[str, Any] = {
        "last_plane_comment": f"{author}|{compact}",
        "last_plane_comment_at": str(comment.get("created_at") or ""),
    }

    cfg = load_config()
    client = VaultClient(cfg)
    try:
        # Best-effort bump of a comment counter — read current value if present.
        current = await _read_frontmatter(client, path)
        if current is None:
            return {"applied": False, "reason": "record_not_found"}
        try:
            count = int(current.get("plane_comments_count") or 0)
        except (TypeError, ValueError):
            count = 0
        updates["plane_comments_count"] = count + 1

        await client.patch_frontmatter(path, updates)
        return {"applied": True, "count": count + 1}
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Activity: archive matter/task by flipping frontmatter
# ---------------------------------------------------------------------------

@activity.defn
async def archive_vault_record(
    path: str,
    record_type: str,
) -> dict[str, Any]:
    """Set ``archived: true`` on a vault record without deleting the file.

    Task-type records additionally get ``status: cancelled`` so they
    disappear from the open-task views. Matter-type records get
    ``status: archived``.
    """
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        current = await _read_frontmatter(client, path)
        if current is None:
            return {"applied": False, "reason": "record_not_found"}

        updates: dict[str, Any] = {"archived": True}
        if record_type == "task":
            updates["status"] = "cancelled"
        elif record_type == "matter":
            updates["status"] = "archived"

        # Guard against a second archive write being a no-op write.
        if current.get("archived") is True and current.get("status") == updates.get("status"):
            return {"applied": False, "reason": "already_archived"}

        await client.patch_frontmatter(path, updates)
        logger.info("plane_reverse_sync: archived %s (%s)", path, record_type)
        return {"applied": True}
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Activity: vault task lookup by plane_issue_id — covers the reverse-sync
# rename case (#594). When a human renames a Plane issue whose mirror
# vault task was created by reverse-sync (``external_id=plane:<id>``,
# not ``alfred:<slug>``), the forward-sync ``issue_map`` won't yet
# contain the pair, so the workflow-side ``plane_issue_to_slug`` lookup
# misses. Without this activity as a fallback we'd fall through to
# ``create_vault_task_from_plane_issue`` and end up with a second vault
# task at a new slug derived from the renamed ``name`` — permanent
# duplication. Scanning vault tasks by ``plane_issue_id`` frontmatter is
# O(n) but cached by ctrl-api; fine for the fleet's ≤2000-task vaults.
# ---------------------------------------------------------------------------

@activity.defn
async def find_vault_task_path_by_plane_id(plane_issue_id: str) -> Optional[str]:
    """Return vault path of the task whose frontmatter matches ``plane_issue_id``.

    Returns ``None`` when no such task exists (i.e. this really is a new
    Plane issue we haven't seen before and the workflow should fall
    through to the create path).

    The one-activity-per-event overhead is acceptable because:
      * ``issue.updated`` events only reach this activity when the
        workflow's in-memory ``plane_issue_to_slug`` lookup already
        missed — so this is the failover path, not the hot path.
      * ctrl-api ``list_records("task")`` is a single in-memory scan of
        an already-loaded index; no filesystem walk per-call.
    """
    if not plane_issue_id:
        return None
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        return await _find_task_by_plane_id(client, plane_issue_id)
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Activity: loop-guard #1 + #2 combined check
# ---------------------------------------------------------------------------

@activity.defn
async def check_loop_guards(
    plane_id: str,
    external_id: Optional[str],
    payload: dict[str, Any],
    outbound_sigs: dict[str, dict[str, Any]],
    now_ms: Optional[int] = None,
) -> dict[str, Any]:
    """Run loop guards #1 + #2 against the inbound payload.

    Returns ``{"skip": bool, "reason": str, "hash": str}``.

    * Guard #1 fires when the inbound payload carries an
      ``external_id`` shaped ``alfred:<slug>`` AND the hash of the
      inbound matches the outbound signature for the same Plane id.
    * Guard #2 fires when the Plane id has a recent outbound signature
      (within ``_SUPPRESSION_WINDOW_MS``) whose hash equals the inbound
      hash — even without an external_id this catches the race where
      we wrote something before the webhook-side signature finished
      persisting.

    Guard #3 (field-hash idempotency) is enforced by
    ``apply_plane_patch_to_vault``. Keeping it there avoids a
    double-read of the vault record for records that guard #1 or #2
    already filtered.
    """
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    inbound_hash = compute_loop_guard_hash(payload or {})

    slug = _parse_alfred_external_id(external_id)
    sig = outbound_sigs.get(str(plane_id)) if plane_id else None

    # Guard #1: the inbound event is stamped as ours AND the outbound
    # signature we recorded matches the inbound hash.
    if slug and sig and str(sig.get("hash")) == inbound_hash:
        return {
            "skip": True,
            "reason": "guard1_origin_stamp_hash_match",
            "hash": inbound_hash,
        }

    # Guard #2: recent outbound signature (regardless of external_id).
    if sig and str(sig.get("hash")) == inbound_hash:
        ts = int(sig.get("ts") or 0)
        if now - ts <= _SUPPRESSION_WINDOW_MS:
            return {
                "skip": True,
                "reason": "guard2_suppression_window",
                "hash": inbound_hash,
            }

    return {"skip": False, "reason": "", "hash": inbound_hash}


# ---------------------------------------------------------------------------
# Activity: mark a stream event processed (so it doesn't come back)
# ---------------------------------------------------------------------------

@activity.defn
async def mark_plane_event_processed(
    event_id: str,
    vault_path: str,
    classification: str,
) -> None:
    """Delegate to VaultClient.mark_event_processed.

    Kept as a dedicated activity so tests of the reverse-sync workflow
    don't need to import every activity from streams.py.
    """
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        await client.mark_event_processed(event_id, vault_path, classification)
    finally:
        await client.close()
