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

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.plane_client import PlaneClient
from src.utils.plane_mapping import (
    compute_loop_guard_hash,
    vault_matter_to_plane_update,
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

# Cap on how many bytes of vault body we include on sync. The curator
# itself caps body at ~30 KB per record, so matching that here means the
# forward-sync faithfully reproduces what the vault holds without
# risking a multi-megabyte payload on a pathological record.
_BODY_BYTES_CAP = 30_000


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


# Plane 1.3.0 rejects project/issue names containing many ASCII punctuation
# characters with 400 "Project name cannot contain special characters." The
# exact reject list is not documented, but empirical probing against the
# running instance identified these as rejected:
#   -  &  ( )  ,  .  :  ;  @  %  #  *  +  |  !  ?  =  <  >  {  }
# and accepted: letters, digits, whitespace, en-dash (–), em-dash (—),
# underscore (_), forward slash (/), square brackets ([ ]), tilde (~), and
# single/double quotes (though we strip quotes anyway to keep names quoting
# cleanly in YAML frontmatter round-trips).
#
# Rather than an ever-growing blocklist, use an allowlist: permit letters,
# digits, whitespace, the accepted punctuation above, and the Unicode
# dashes we actually want to preserve. Replace everything else with a
# space, collapse whitespace, fall back to a safe default.
_PLANE_NAME_ALLOW_RE = re.compile(r"[^\w\s/\[\]~–—]", re.UNICODE)


def _sanitize_plane_name(raw: str) -> str:
    if not raw:
        return "Untitled"
    # Strip quote characters outright (they're valid ASCII \w would miss
    # quotes anyway, but keep the explicit strip for clarity).
    cleaned = raw.replace("'", "").replace('"', "")
    cleaned = _PLANE_NAME_ALLOW_RE.sub(" ", cleaned)
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


def _clamp_body(body: Any) -> str:
    """Clamp a body to the sync size cap, preserving word boundaries.

    Returns an empty string for non-strings. When the body exceeds the
    cap we truncate at the last whitespace before the cap + append an
    ellipsis so the Plane UI visibly signals truncation. This matches
    the curator's own 30KB cap so forward-sync never smuggles more
    content into Plane than the vault itself holds.
    """
    if not isinstance(body, str) or not body:
        return ""
    if len(body.encode("utf-8")) <= _BODY_BYTES_CAP:
        return body
    encoded = body.encode("utf-8")[: _BODY_BYTES_CAP]
    truncated = encoded.decode("utf-8", errors="ignore")
    # Walk back to the last whitespace so we don't cut mid-word.
    idx = truncated.rfind("\n")
    if idx < _BODY_BYTES_CAP * 0.8:
        idx = truncated.rfind(" ")
    if idx > 0:
        truncated = truncated[:idx]
    return truncated + "\n\n…"


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

        {"slug": str, "path": str, "frontmatter": dict, "body": str, "mtime": float}

    ``body`` carries the full vault body truncated to ``_BODY_BYTES_CAP``
    so Plane projects can render the long-form matter narrative — the
    scalar ``description`` frontmatter is typically a one-line summary
    and isn't enough for a useful project card. The list endpoint's
    ``preview=2000`` param gives us 2 KB of body which covers > 95% of
    matter records on the fleet without requiring a per-record GET.
    """
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        # Bumped preview window from the list endpoint's 500 default → 2000
        # so the matter body reaches forward-sync with enough content to
        # be worth rendering. Full body (no truncation) would require a
        # per-record GET, which isn't worth the round-trip for matters
        # that trend under a couple KB.
        resp = await client._client.get(
            "/api/v1/vault/list/matter", params={"preview": 2000}
        )
        resp.raise_for_status()
        records = resp.json().get("results", [])
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
        # Carry body_preview as description_preview too, so callers that
        # only have the frontmatter map (reverse-sync helper, tests) can
        # still see some body content.
        fm = dict(fm)
        body_preview = rec.get("body_preview", "") or ""
        fm.setdefault("description_preview", body_preview)
        changed.append({
            "slug": slug,
            "path": path,
            "frontmatter": fm,
            "body": _clamp_body(body_preview),
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
    """Return task records whose derived mtime is strictly greater than ``since_mtime``.

    Returned record shape::

        {
            "slug": str, "path": str, "frontmatter": dict,
            "matter_slug": Optional[str], "body": str, "mtime": float,
        }

    ``body`` carries the full vault body (truncated to
    ``_BODY_BYTES_CAP`` for safety) so the Plane issue's description
    captures the actual task content — not just the frontmatter
    summary. Tasks average <100 chars of body but can reach ~1.5 KB for
    Alfred-generated chores + curated items.
    """
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        resp = await client._client.get(
            "/api/v1/vault/list/task", params={"preview": 2000}
        )
        resp.raise_for_status()
        records = resp.json().get("results", [])
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
        body_preview = rec.get("body_preview", "") or ""
        changed.append({
            "slug": slug,
            "path": path,
            "frontmatter": fm,
            "matter_slug": matter_ref,
            "body": _clamp_body(body_preview),
            "mtime": mtime,
        })

    # Temporal activities have a ~2MB payload ceiling. On mature tenants
    # (david: 2500+ tasks, each ~2KB frontmatter+body) the uncapped return
    # value blows that ceiling and every plane_sync run fails with
    # "Complete result exceeds size limit". Sort by mtime ascending and
    # cap the return to a window slightly larger than
    # MAX_RECORDS_PER_RUN so the workflow has headroom but the payload
    # stays bounded. Records past the cap are picked up on a later tick
    # once the cursor advances past the current batch.
    changed.sort(key=lambda r: float(r.get("mtime") or 0.0))
    _FETCH_RETURN_CAP = 300
    total_found = len(changed)
    if total_found > _FETCH_RETURN_CAP:
        changed = changed[:_FETCH_RETURN_CAP]

    logger.info(
        "plane_sync: fetch_changed_tasks since=%s found=%d returned=%d",
        since_mtime,
        total_found,
        len(changed),
    )
    return changed


# ---------------------------------------------------------------------------
# Activity: upsert matter → Plane project
# ---------------------------------------------------------------------------

def _project_identifier_for_slug(slug: str) -> str:
    """Build a Plane project identifier (uppercase, ≤ 5 chars).

    Must be stable per slug and unique across distinct slugs. Two different
    slugs that happen to share a 5-char prefix (e.g.
    ``alfred-black-ai-butler-product`` vs
    ``alfred-black-ai-butler-product-build``) both produce ``ALFRE`` under
    a naive ``cleaned[:5]`` scheme, which collides inside a workspace. We
    keep the first 3 alpha chars for human-readability then append 2 chars
    derived from a deterministic hash of the full cleaned slug; base-36
    alphabet keeps the identifier uppercase-alphanumeric which is what
    Plane requires.
    """
    import hashlib

    cleaned = re.sub(r"[^A-Za-z0-9]", "", slug).upper()
    if not cleaned:
        cleaned = "ALFRD"
    prefix = cleaned[:3].ljust(3, "X")
    # 2-char base-36 suffix from sha1(slug) → 1296 possible suffixes.
    # Collision risk across a fleet of <100 matters per tenant is trivial.
    digest = hashlib.sha1(cleaned.encode("ascii")).digest()
    n = int.from_bytes(digest[:2], "big") % (36 * 36)
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    suffix = alphabet[n // 36] + alphabet[n % 36]
    return prefix + suffix


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
    body = matter.get("body") or ""

    # Render the rich project payload via the central mapping helper so
    # forward + reverse stay on the same field set. ``vault_matter_to_plane_update``
    # emits name / description_text / description_html / is_archived /
    # optional emoji; we then apply the Plane-specific name sanitizer
    # (the helper leaves that to the activity layer since it's a
    # Plane-version-specific quirk).
    rich = vault_matter_to_plane_update(fm, body=body)
    raw_name = rich.pop("name", "") or slug
    name = _sanitize_plane_name(raw_name)

    client = _plane_client_from_env()
    try:
        existing_id = project_map.get(slug)
        if existing_id:
            patch_body: dict[str, Any] = {"name": name}
            patch_body.update(rich)
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
        # can be detected as loop-back in B7. Plane's create_project
        # signature is narrow (name / identifier / description); for
        # archived-flag and emoji we issue a follow-up PATCH so the
        # project lands in the right shape on first sync.
        description_text = str(rich.get("description_text") or "")
        created = await client.create_project(
            name=name,
            identifier=_project_identifier_for_slug(slug),
            description=description_text,
        )
        plane_id = str(created.get("id") or "")
        if not plane_id:
            raise RuntimeError(
                f"plane_sync: create_project({slug}) returned no id: {created!r}"
            )
        # Second-pass PATCH for the fields the create endpoint doesn't
        # accept (description_html, is_archived, emoji). Skip the patch
        # entirely when there's nothing extra to set — avoids a useless
        # HTTP call on stub matters.
        followup = {
            k: v for k, v in rich.items()
            if k in ("description_html", "is_archived", "emoji")
            and v not in (None, "", False)
        }
        if followup:
            try:
                await client.update_project(plane_id, patch=followup)
            except Exception as exc:  # noqa: BLE001 — followup is best-effort
                logger.warning(
                    "plane_sync.project_followup_failed slug=%s plane_id=%s error=%s",
                    slug, plane_id, exc,
                )
        action = "create"
        logger.info(
            "plane_sync.project_upsert slug=%s plane_id=%s action=%s",
            slug, plane_id, action,
        )
        create_body_for_sig = {"name": name, **rich}
        _record_outbound_signature(plane_id, create_body_for_sig)
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
async def preload_project_labels(
    project_ids: list[str],
) -> dict[str, dict[str, str]]:
    """Preload label-name → label-id maps for every project in one pass.

    Returns ``{project_id: {label_name: label_id, ...}, ...}``.

    Motivation: ``sync_task_to_plane`` used to call ``client.ensure_labels``
    per task, which issues ``GET /projects/<id>/labels/`` on EVERY call —
    even when the labels we need already exist. On a mature fleet tenant
    that means N task-syncs × one label fetch = 200+ round-trips per
    workflow run. This activity does ONE fetch per unique project_id up
    front so the task loop can resolve labels from an in-memory cache.

    Failures on any single project are swallowed — we return an empty
    map for that project and ``sync_task_to_plane`` falls back to a
    per-task ``ensure_labels`` call. That keeps the fast path fast
    without making the preload a hard dependency.
    """
    unique = list({p for p in project_ids if p})
    if not unique:
        return {}
    client = _plane_client_from_env()
    result: dict[str, dict[str, str]] = {}
    try:
        for pid in unique:
            try:
                labels = await client.list_labels(pid)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "plane_sync.preload_labels_failed project=%s error=%s",
                    pid, exc,
                )
                result[pid] = {}
                continue
            result[pid] = {
                str(lb.get("name", "")): str(lb.get("id", ""))
                for lb in labels
                if lb.get("name") and lb.get("id")
            }
    finally:
        await client.close()
    logger.info(
        "plane_sync.preload_labels projects=%d cached_total=%d",
        len(unique),
        sum(len(v) for v in result.values()),
    )
    return result


async def _resolve_labels_with_cache(
    client: PlaneClient,
    project_id: str,
    names: list[str],
    cache: Optional[dict[str, dict[str, str]]],
) -> list[str]:
    """Resolve label names → IDs using the preload cache, creating
    missing labels and patching the cache in place.

    When ``cache`` is None we fall back to ``client.ensure_labels`` — same
    semantics, one fetch + N creates. This keeps back-compat with callers
    that haven't wired the cache through yet.
    """
    if cache is None:
        return await client.ensure_labels(project_id, names)
    proj_cache = cache.setdefault(project_id, {})
    ids: list[str] = []
    for name in names:
        existing = proj_cache.get(name)
        if existing:
            ids.append(existing)
            continue
        # Label missing from cache — create it. A concurrent creator
        # (e.g. someone manually adding the label in Plane) would make
        # ``POST /labels/`` 400; we just log + skip on that path so a
        # race never breaks the whole sync.
        try:
            result = await client._post(  # type: ignore[attr-defined]
                f"{client._proj(project_id)}/labels/",  # type: ignore[attr-defined]
                json={"name": name},
            )
            new_id = str(result.get("id", ""))
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "plane_sync.label_create_failed project=%s name=%s error=%s",
                project_id, name, exc,
            )
            continue
        if new_id:
            proj_cache[name] = new_id
            ids.append(new_id)
    return ids


@activity.defn
async def sync_task_to_plane(
    task: dict[str, Any],
    project_map: dict[str, str],
    issue_map: dict[str, str],
    label_cache: Optional[dict[str, dict[str, str]]] = None,
) -> dict[str, str]:
    """Create or update the Plane issue mirroring this task record.

    Resolution order for the destination project:
    1. ``matter_slug`` resolves to a known Plane project → that project
    2. Otherwise → the Inbox project (``project_map[INBOX_SLUG_SENTINEL]``)
    3. If the Inbox isn't in the map yet (first-run race) → skip for
       this run; next run will have the Inbox after ``ensure_inbox_project``

    ``label_cache``
        Optional ``{project_id: {label_name: label_id}}`` produced by
        ``preload_project_labels``. When provided, label resolution
        skips the per-task ``GET /labels/`` round-trip and only issues
        ``POST`` requests for labels that aren't in the cache yet
        (mutations patch the cache in place). When ``None``, falls
        back to the legacy ``client.ensure_labels`` path.

    Archived-task cascade
    ---------------------
    When ``frontmatter.archived`` is truthy, the vault record has been
    tombstoned and the mirrored Plane issue should follow. We call
    ``client.delete_issue`` (Plane 1.3.0 does not expose a working issue
    archive endpoint — ``PATCH is_archived`` returns 200 but doesn't
    persist ``archived_at``; ``POST /archive/`` 404s) and return
    ``action="archived"`` so the workflow can drop the slug from
    ``issue_map``. Vault remains the source of truth; the delete is
    reversible by clearing ``archived`` on the vault record (the next
    sync tick will re-create the Plane issue fresh).

    If the task is archived but has no existing Plane mapping, we skip
    silently rather than creating the issue just to delete it.
    """
    slug = task["slug"]
    matter_slug = task.get("matter_slug")
    fm = task.get("frontmatter") or {}
    body = task.get("body") or ""

    # Archive cascade: short-circuit before any Plane create/update work.
    # See the docstring above for why we delete rather than archive.
    if fm.get("archived"):
        existing_id = issue_map.get(slug)
        if not existing_id:
            logger.info(
                "plane_sync.issue_upsert slug=%s action=archived reason=never_synced",
                slug,
            )
            return {"slug": slug, "plane_id": "", "action": "archived"}
        # Find the project the existing issue lives in. Matter-slug first,
        # fall back to Inbox (which is where orphan tasks were routed).
        delete_project_id: Optional[str] = None
        if matter_slug:
            delete_project_id = project_map.get(matter_slug)
        if not delete_project_id:
            delete_project_id = project_map.get(INBOX_SLUG_SENTINEL)
        if not delete_project_id:
            # Very unusual: we have a plane_id but no project to address
            # it through. Log and treat as archived so the cursor can
            # move on — next run will re-evaluate once the Inbox lands.
            logger.warning(
                "plane_sync.issue_upsert slug=%s action=archived reason=no_project_for_delete plane_id=%s",
                slug, existing_id,
            )
            return {"slug": slug, "plane_id": "", "action": "archived"}
        client = _plane_client_from_env()
        try:
            try:
                await client.delete_issue(delete_project_id, existing_id)
            except httpx.HTTPStatusError as exc:
                # 404 on delete means the issue is already gone in Plane
                # — treat as success so we clear the stale mapping.
                if exc.response.status_code != 404:
                    raise
                logger.info(
                    "plane_sync.issue_upsert slug=%s plane_id=%s project=%s action=archived note=already_gone",
                    slug, existing_id, delete_project_id,
                )
            else:
                logger.info(
                    "plane_sync.issue_upsert slug=%s plane_id=%s project=%s action=archived",
                    slug, existing_id, delete_project_id,
                )
        finally:
            await client.close()
        return {"slug": slug, "plane_id": "", "action": "archived"}

    project_id: Optional[str] = None
    if matter_slug:
        project_id = project_map.get(matter_slug)
        if not project_id:
            logger.warning(
                "plane_sync.issue_upsert slug=%s matter=%s unresolved — routing to Inbox",
                slug, matter_slug,
            )
            project_id = project_map.get(INBOX_SLUG_SENTINEL)

    if not project_id:
        project_id = project_map.get(INBOX_SLUG_SENTINEL)

    if not project_id:
        logger.info(
            "plane_sync.issue_upsert slug=%s action=skip reason=no_inbox",
            slug,
        )
        return {"slug": slug, "plane_id": "", "action": "skip"}

    update = vault_task_to_plane_update(fm, body=body)
    state_group = update.pop("state_group", None)
    labels = update.pop("labels", []) or []
    description_html = update.pop("description_html", "") or ""
    target_date = update.pop("target_date", None)
    assignees = update.pop("assignees", []) or []

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

        # Cache-aware label resolution. Falls through to the legacy
        # per-task fetch when the workflow didn't preload (e.g. very
        # first run with no projects to preload yet).
        label_ids: list[str] = await _resolve_labels_with_cache(
            client, project_id, label_names, label_cache,
        )

        existing_id = issue_map.get(slug)
        issue_body: dict[str, Any] = {
            "name": _sanitize_plane_name(str(update.get("name") or slug)),
            "priority": update.get("priority") or "none",
            "labels": label_ids,
        }
        if description_html:
            issue_body["description_html"] = description_html
        if state_id:
            issue_body["state"] = state_id
        if target_date:
            issue_body["target_date"] = target_date
        if assignees:
            issue_body["assignees"] = assignees

        if existing_id:
            try:
                await client.update_issue(project_id, existing_id, issue_body)
                action = "update"
                plane_id = existing_id
            except httpx.HTTPStatusError as exc:
                # 404 on update = the Plane issue we had mapped was
                # deleted (manually, or via an earlier archive cascade,
                # or by Plane's retention policy). The issue_map entry
                # is stale. Drop through to the create path — the 409
                # self-heal in create_issue will recover if the slug's
                # external_id was reclaimed by a newly-created issue.
                if exc.response.status_code != 404:
                    raise
                logger.warning(
                    "plane_sync.stale_issue_map slug=%s plane_id=%s — "
                    "issue 404'd on update, falling through to create",
                    slug, existing_id,
                )
                existing_id = None  # noqa: F841 — sentinel reset
                # Don't fall into the `else` branch here — we need to
                # actually exit this `if` and hit the `else` below. Use
                # a flag to cascade.
                _needs_create = True
            else:
                _needs_create = False
        else:
            _needs_create = True

        if _needs_create:
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
            # PATCH-in the rich fields the create endpoint doesn't accept
            # (target_date, assignees) so first-sync issues don't lose the
            # due date / assignee round-trip we care about.
            followup_body: dict[str, Any] = {}
            if target_date:
                followup_body["target_date"] = target_date
            if assignees:
                followup_body["assignees"] = assignees
            if followup_body:
                try:
                    await client.update_issue(project_id, plane_id, followup_body)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "plane_sync.issue_followup_failed slug=%s plane_id=%s error=%s",
                        slug, plane_id, exc,
                    )
            action = "create"

        logger.info(
            "plane_sync.issue_upsert slug=%s plane_id=%s project=%s action=%s",
            slug, plane_id, project_id, action,
        )
        # Record the outbound signature so reverse-sync can recognise the
        # webhook echo that Plane fires immediately after this write.
        # Build a guard-compatible payload — the hash only uses logical
        # (not UUID-bound) fields so labels/state_id are omitted.
        outbound_for_hash: dict[str, Any] = {
            "name": issue_body["name"],
            "description": description_html,
            "priority": issue_body["priority"],
            "state": state_group or "",
            "due_date": target_date or "",
            "assignees": assignees,
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
