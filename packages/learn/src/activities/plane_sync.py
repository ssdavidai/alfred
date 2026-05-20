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
from datetime import datetime, timezone
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


# ── Staleness check (forward-sync conflict resolution) ─────────────────────
#
# Forward sync (vault → Plane) was previously a blind PATCH: every field in
# `issue_body` was sent regardless of whether Plane held a more recent value.
# That's the right shape when WE'RE the only writer, but Plane is also a
# user-facing surface — Sir closing a task in Plane's UI mints an
# `updated_at` that's newer than the vault's mtime. If reverse-sync hasn't
# yet mirrored that close into the vault (queue lag, worker restart, the
# 1h wedge Sir hit), forward-sync sees vault.status="todo" and pushes
# "todo" to Plane, silently overwriting Sir's close.
#
# The fix here is a per-field staleness check that runs BEFORE the PATCH:
#   1. Fetch the current Plane issue once, get its updated_at + current
#      values of every field we'd push.
#   2. Look up the most recent outbound signature for this plane_id. If
#      we wrote it within the tolerance window (2s) of plane.updated_at,
#      Plane's last update WAS our own write → safe to push everything.
#   3. Otherwise, build the PATCH body field-by-field:
#        - vault[f] == plane[f]: drop (no diff to send).
#        - vault[f] != plane[f] AND we own the most recent write: include.
#        - vault[f] != plane[f] AND Plane is newer: drop, log warning.
#          Reverse-sync will land Plane's value into the vault on its
#          next tick; the next forward-sync tick then sees vault==plane
#          and stays out of the way.
#   4. If the resulting body is empty, skip the HTTP PATCH entirely.
#
# Cost: one Plane GET per forward-sync update. Bounded by Sir's edit rate
# (forward-sync only runs when vault has changes since the cursor).

# Tolerance for clock skew between this worker (docker host time) and
# Plane's API (running in the same compose stack — usually identical, but
# leave headroom for NTP drift / suspend-resume).
_PLANE_TS_TOLERANCE_MS = 2_000


def _parse_plane_updated_at_ms(raw: Any) -> Optional[int]:
    """Convert Plane's ISO-8601 updated_at (e.g. '2026-05-04T07:57:44.461769Z')
    to epoch ms. Returns None on parse failure."""
    if not isinstance(raw, str) or not raw:
        return None
    try:
        # Plane uses 'Z' suffix; datetime.fromisoformat needs '+00:00'
        # in 3.10. From 3.11 onward 'Z' works directly. Be defensive.
        s = raw.replace("Z", "+00:00") if raw.endswith("Z") else raw
        dt = datetime.fromisoformat(s)
        return int(dt.timestamp() * 1000)
    except (ValueError, OverflowError):
        return None


def _our_signature_is_authoritative(
    plane_id: str,
    plane_updated_at_ms: Optional[int],
) -> bool:
    """Return True if our most recent outbound signature for `plane_id`
    was recorded within tolerance of Plane's `updated_at` — meaning
    Plane's last update was OUR own write echoing back, so we own the
    state and a fresh push is safe.

    Returns False if either we have no signature for this plane_id, the
    signature is older than plane.updated_at, or plane.updated_at is
    unparseable (defensive default — assume Plane was touched
    externally).
    """
    if plane_updated_at_ms is None:
        return False
    try:
        sigs = _load_outbound_sigs_from_disk(_outbound_sigs_path())
    except Exception:  # noqa: BLE001
        return False
    sig = sigs.get(str(plane_id))
    if not isinstance(sig, dict):
        return False
    sig_ts = sig.get("ts")
    if not isinstance(sig_ts, int):
        return False
    # Our signature must be at least as recent as Plane's updated_at,
    # within the clock-skew tolerance.
    return sig_ts >= plane_updated_at_ms - _PLANE_TS_TOLERANCE_MS


def _filter_stale_fields(
    issue_body: dict[str, Any],
    plane_issue: dict[str, Any],
    plane_id: str,
    slug: str,
) -> tuple[dict[str, Any], list[str]]:
    """Field-level staleness filter. Drops fields from `issue_body` whose
    Plane value is newer than ours.

    Returns (filtered_body, deferred_field_names). Caller decides what
    to do with an empty body (typically: skip the HTTP PATCH).

    Comparison rules per field:
      - If Plane's current value matches what we're about to send: drop
        (no diff — sending it is a no-op that wastes a webhook round
        trip).
      - If our outbound signature is authoritative (most recent author
        was us): keep all fields. We own the state; the diff IS our
        latest intent.
      - If Plane is the most recent author and the values differ: this
        is per-FIELD, not whole-issue. A newer ``plane.updated_at`` means
        SOMETHING was touched externally, but typically only one field.
        Defer ONLY the fields where Plane already holds a real competing
        value (pushing ours would stomp an external edit reverse-sync
        hasn't yet mirrored). Fields where Plane holds no competing value
        (null / empty / absent) are still pushed — our write cannot stomp
        an edit that isn't there, so suppressing them just loses
        legitimate vault changes.
    """
    plane_updated_ms = _parse_plane_updated_at_ms(plane_issue.get("updated_at"))
    we_authored_last = _our_signature_is_authoritative(plane_id, plane_updated_ms)

    if we_authored_last:
        # Strip only true no-op fields. Authoring matches → push everything
        # else as today. (Strictly speaking we could skip identical-value
        # fields too; the pre-existing code didn't, so neither do we — keeps
        # behaviour identical when our writes are the most recent.)
        return issue_body, []

    # Plane was touched by an external actor since our last write — but
    # only ever for the field(s) Plane now holds a real competing value
    # for. Push the rest.
    filtered: dict[str, Any] = {}
    deferred: list[str] = []
    for field, our_value in issue_body.items():
        plane_value = _normalise_plane_field(field, plane_issue)
        our_norm = _normalise_our_field(field, our_value)
        if plane_value == our_norm:
            # Identical — no diff to send. Drop.
            continue
        if _plane_holds_competing_value(plane_value):
            # Plane has a real diverging value → defer to reverse-sync so
            # it lands Plane's value into the vault first.
            deferred.append(field)
            logger.info(
                "plane_sync.deferred_by_staleness slug=%s plane_id=%s field=%s "
                "(plane.updated_at newer than our last outbound signature; "
                "letting reverse-sync land Plane's value first)",
                slug, plane_id, field,
            )
            continue
        # Plane holds nothing competing here (null / empty / absent) — our
        # write can't stomp an external edit, so push the fresh vault value.
        filtered[field] = our_value
    return filtered, deferred


def _normalise_plane_field(field: str, plane_issue: dict[str, Any]) -> Any:
    """Pull the comparable value of `field` out of a Plane issue payload.

    Plane's REST returns shapes that don't always match what we PATCH:
      - `state` is a UUID string (we send a UUID — direct compare).
      - `labels` is a list of label-id UUIDs (matches our payload shape
        as `label_ids`).
      - `assignees` is a list of user UUIDs.
      - `target_date` / `name` / `priority` / `description_html` are
        scalars.
    """
    if field == "labels":
        return list(plane_issue.get("labels") or [])
    if field == "assignees":
        return list(plane_issue.get("assignees") or [])
    return plane_issue.get(field)


def _normalise_our_field(field: str, value: Any) -> Any:
    """Mirror of _normalise_plane_field for our outbound payload — keeps
    the comparison apples-to-apples."""
    if field in ("labels", "assignees"):
        return list(value or [])
    return value


def _plane_holds_competing_value(plane_value: Any) -> bool:
    """True iff Plane currently holds a real value for this field that our
    push would overwrite.

    The staleness filter only defers a field when there is something on
    Plane to protect. A field Plane left null / empty / absent (or, for
    the ``priority`` enum, Plane's ``"none"`` default) cannot hold an
    external edit, so pushing our fresh vault value into it is safe.
    """
    if plane_value is None:
        return False
    if isinstance(plane_value, str) and plane_value.strip() in ("", "none"):
        return False
    if isinstance(plane_value, (list, dict)) and not plane_value:
        return False
    return True


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
# Plane REST-delete workaround helper — archive vault task on 404 update
# ---------------------------------------------------------------------------
#
# Plane 1.3.0 does NOT emit ``issue.deleted`` webhooks for deletions made via
# the REST API; only UI-driven deletes trigger the webhook. That means the
# reverse-sync workflow never learns about programmatic DELETEs, and the
# vault task keeps its ``plane_issue_id`` pointing at a now-gone issue.
# The first signal we have is a 404 on the next forward-sync PATCH.
#
# History of the 404 handling:
#   Pre-PR #584:  errors++, cursor pinned (bad — blocks backfill).
#   PR #584:      clear ``existing_id``, fall through to create path
#                 (heals the map, but re-creates the Plane issue for
#                 a task Sir deliberately deleted — wrong intent).
#   Pre-tenant-a-cascade: archive the vault task to mirror Sir's delete intent,
#                 return action="archived_by_plane". WRONG when the real
#                 cause is a cross-project move (related_matters changed),
#                 because the issue is alive in another project — we just
#                 pointed PATCH at the wrong one. Vault is the source of
#                 truth; Plane is a projection. A 404 from Plane must
#                 never cause an autonomous vault archive.
#   Current (tenant-a hotfix made permanent):
#                 1. Cross-project search: probe every OTHER project in
#                    project_map for the issue_id. If found, DELETE it
#                    from the stale project + return action="stale_dropped"
#                    so the workflow drops the slug from issue_map and
#                    the next tick re-creates fresh in the correct project.
#                 2. If not found anywhere, or the cross-project search
#                    itself fails, still return "stale_dropped" — never
#                    auto-archive from a 404. The hourly reconciliation
#                    workflow retains the archive pathway for the case
#                    where the issue is genuinely gone AND Sir intended
#                    the delete (it confirms via the vault record rather
#                    than blind-trusting a 404).
#
# The helper below is kept because plane_reconciliation.py still uses it,
# but it is NO LONGER called from sync_task_to_plane's 404 branch.

async def _find_issue_in_other_projects(
    client: PlaneClient,
    issue_id: str,
    current_project_id: str,
    project_map: dict[str, str],
) -> Optional[str]:
    """Probe every project in ``project_map.values()`` other than
    ``current_project_id`` for ``issue_id``. Returns the project_id
    where the issue lives, or ``None`` if not found in any project.

    Used by ``sync_task_to_plane``'s 404-on-update branch to detect the
    cross-project-move case: a task whose ``related_matters`` changed so
    forward-sync now thinks the issue belongs to project B, but Plane
    still holds it under project A. Without this probe we'd treat that
    as a deletion and (pre-hotfix) auto-archive the vault task.

    Every single 4xx/5xx from ``get_issue`` is swallowed — this helper
    must NEVER propagate a failure back into the sync path, because the
    caller falls back to the safe "stale_dropped" action on None. A
    network outage during the probe should not cause the 404-on-update
    to become an archive. Non-HTTP exceptions (e.g. asyncio cancel)
    still propagate.
    """
    candidates = [
        pid for pid in project_map.values()
        if pid and pid != current_project_id
    ]
    # Deduplicate while preserving order — project_map CAN contain
    # duplicate plane_ids in pathological cases (two slugs aliased
    # onto the same project, e.g. cleanup mid-flight).
    seen: set[str] = set()
    unique: list[str] = []
    for pid in candidates:
        if pid in seen:
            continue
        seen.add(pid)
        unique.append(pid)

    for other_pid in unique:
        try:
            issue = await client.get_issue(other_pid, issue_id)
        except httpx.HTTPStatusError as exc:
            # 404 here just means "not in this project" — keep looking.
            # Other 4xx/5xx shouldn't abort the search either; the caller
            # falls back to stale_dropped on None which is still safe.
            if exc.response.status_code != 404:
                logger.warning(
                    "plane_sync.cross_project_probe_http_error "
                    "project=%s issue=%s status=%s",
                    other_pid, issue_id, exc.response.status_code,
                )
            continue
        except (httpx.HTTPError, httpx.TimeoutException) as exc:
            logger.warning(
                "plane_sync.cross_project_probe_transport_error "
                "project=%s issue=%s error=%s",
                other_pid, issue_id, exc,
            )
            continue
        if issue and issue.get("id"):
            logger.info(
                "plane_sync.cross_project_found issue=%s in_project=%s "
                "(was expected in %s)",
                issue_id, other_pid, current_project_id,
            )
            return other_pid
    return None


async def _archive_vault_task_from_plane_delete(slug: str, path: str) -> None:
    """PATCH the vault task to mirror a Plane-side delete.

    Called from the 404-on-update branch of ``sync_task_to_plane`` and from
    the hourly reconciliation workflow when a mapped ``plane_issue_id``
    is no longer in the Plane project's issue list. Uses the existing
    ``VaultClient.patch_frontmatter`` helper — does NOT add a new vault
    write path, as required by the hard rules.
    """
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        updates: dict[str, Any] = {
            "archived": True,
            "status": "cancelled",
            "archived_at": datetime.now(timezone.utc).isoformat(),
            "archived_reason": "plane_delete_detected_via_404",
        }
        await client.patch_frontmatter(path, updates)
        logger.info(
            "plane_sync.plane_deleted_archived slug=%s path=%s", slug, path,
        )
    finally:
        await client.close()


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
# Activity: list changed task paths (since mtime) — STAGE 1 of the
# paginated fetch (#592). Returns lightweight ``{path, slug,
# matter_slug, mtime}`` refs only, never the full frontmatter/body. The
# workflow slices these into chunks and feeds each chunk to
# ``fetch_task_records_batch`` to materialise the full TaskRecord shape
# on demand. Two-stage design replaces the old single-shot
# ``fetch_changed_tasks`` activity, which on mature tenants (example-owner:
# ~2545 tasks) blew Temporal's 2 MB activity-result ceiling and froze
# the cursor permanently. PR #591 capped the return at 300 records as a
# stop-gap; this is the proper fix.
# ---------------------------------------------------------------------------

@activity.defn
async def list_changed_task_paths(since_mtime: float) -> list[dict[str, Any]]:
    """Return lightweight references for every task whose derived
    mtime is strictly greater than ``since_mtime``.

    Returned record shape::

        {"path": str, "slug": str, "matter_slug": Optional[str], "mtime": float}

    Cheap by design — no frontmatter, no body, no description preview.
    A 10k-task vault produces ≈ 10 000 × ~120 bytes = ~1.2 MB of result,
    well under the Temporal 2 MB activity-result ceiling. Internally we
    still need the frontmatter to compute ``mtime`` + resolve the matter
    ref, so we hit the list endpoint with ``preview=0`` (no body
    preview) and discard everything except the four fields above before
    returning.

    Sort order: ascending by mtime, so the workflow processes the oldest
    pending change first and the cursor advances monotonically.
    """
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        resp = await client._client.get(
            "/api/v1/vault/list/task", params={"preview": 0}
        )
        resp.raise_for_status()
        records = resp.json().get("results", [])
    except Exception as exc:
        logger.error("plane_sync: list_records(task) failed: %s", exc)
        raise
    finally:
        await client.close()

    refs: list[dict[str, Any]] = []
    for rec in records:
        mtime = _record_mtime(rec)
        if mtime <= since_mtime:
            continue
        path = rec.get("path", "")
        slug = _slug_from_path(path)
        if not slug:
            continue
        fm = rec.get("frontmatter") or {}
        matter_ref = _resolve_task_matter(fm)
        refs.append({
            "path": path,
            "slug": slug,
            "matter_slug": matter_ref,
            "mtime": mtime,
        })

    refs.sort(key=lambda r: float(r.get("mtime") or 0.0))
    logger.info(
        "plane_sync: list_changed_task_paths since=%s found=%d",
        since_mtime,
        len(refs),
    )
    return refs


# ---------------------------------------------------------------------------
# Activity: fetch a batch of full task records by path — STAGE 2 of the
# paginated fetch (#592). Caller (the workflow) slices the
# ``list_changed_task_paths`` output into chunks of N (today: 100) and
# invokes this activity per chunk. Each batch produces a payload bounded
# by N × per-record-size which stays well under the 2 MB ceiling for
# any plausible N.
# ---------------------------------------------------------------------------

# Per-batch chunk size used by the workflow when slicing the path list
# into ``fetch_task_records_batch`` calls. 100 keeps each activity-result
# payload safely below 2 MB even at the upper end of vault record sizes
# (frontmatter + 30 KB body cap = ~32 KB per record → ~3.2 MB at 100;
# typical records are far smaller, ~2 KB each → ~200 KB per batch).
TASK_FETCH_BATCH_SIZE = 100


@activity.defn
async def fetch_task_records_batch(paths: list[str]) -> list[dict[str, Any]]:
    """Fetch the full TaskRecord shape for each path in ``paths``.

    Returned record shape (matches the legacy
    ``fetch_changed_tasks`` output so the downstream
    ``sync_task_to_plane`` consumer is unchanged)::

        {
            "slug": str, "path": str, "frontmatter": dict,
            "matter_slug": Optional[str], "body": str, "mtime": float,
        }

    A path that 404s (race condition: the task was deleted between the
    list call and this batch) is silently dropped from the returned
    list — the next tick will simply skip it.
    """
    if not paths:
        return []

    cfg = load_config()
    client = VaultClient(cfg)
    out: list[dict[str, Any]] = []
    try:
        for path in paths:
            try:
                resp = await client._client.get(
                    f"/api/v1/vault/records/{path}"
                )
                if resp.status_code == 404:
                    logger.info(
                        "plane_sync: fetch_task_records_batch path=%s 404 — dropping",
                        path,
                    )
                    continue
                resp.raise_for_status()
                raw = resp.json()
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code == 404:
                    logger.info(
                        "plane_sync: fetch_task_records_batch path=%s 404 — dropping",
                        path,
                    )
                    continue
                logger.error(
                    "plane_sync: fetch_task_records_batch path=%s failed: %s",
                    path, exc,
                )
                raise

            slug = _slug_from_path(path)
            if not slug:
                continue
            fm = dict(raw.get("frontmatter") or {})
            body = str(raw.get("body") or "")
            matter_ref = _resolve_task_matter(fm)
            mtime = _record_mtime({"frontmatter": fm})
            out.append({
                "slug": slug,
                "path": path,
                "frontmatter": fm,
                "matter_slug": matter_ref,
                "body": _clamp_body(body),
                "mtime": mtime,
            })
    finally:
        await client.close()

    logger.info(
        "plane_sync: fetch_task_records_batch requested=%d returned=%d",
        len(paths),
        len(out),
    )
    return out


# ---------------------------------------------------------------------------
# Activity: fetch a single record by type + slug for event-triggered
# nudge sync (#574). Unlike ``fetch_changed_matters`` / ``fetch_changed_tasks``
# this returns exactly one record — shaped identically so the nudge
# workflow can hand it to ``sync_matter_to_plane`` / ``sync_task_to_plane``
# without reshuffling fields. Returns ``None`` when the record doesn't
# exist (e.g. nudge fired on a record that's since been deleted).
# ---------------------------------------------------------------------------

@activity.defn
async def fetch_single_plane_record(
    record_type: str,
    slug: str,
) -> Optional[dict[str, Any]]:
    """Fetch a single matter or task record, shaped for forward-sync.

    Returns the same dict shape as one entry from
    ``fetch_changed_matters`` / ``fetch_changed_tasks``. Returns ``None``
    when the record is missing — the nudge workflow treats that as a
    soft no-op (cron will catch up / confirm the delete on its own
    archive cascade).
    """
    if record_type not in ("matter", "task"):
        raise ValueError(
            f"record_type must be 'matter' or 'task', got: {record_type!r}"
        )
    if not slug or "/" in slug or ".." in slug:
        # Defensive: reject path-traversal-ish input. Slugs are the
        # filename stem (e.g. 'client-x') not a full path.
        raise ValueError(f"invalid slug: {slug!r}")

    path = f"{record_type}/{slug}.md"
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        resp = await client._client.get(f"/api/v1/vault/records/{path}")
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        raw = resp.json()
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            return None
        logger.error(
            "plane_nudge: read_record(%s) failed: %s", path, exc,
        )
        raise
    except Exception as exc:
        logger.error(
            "plane_nudge: read_record(%s) failed: %s", path, exc,
        )
        raise
    finally:
        await client.close()

    fm = dict(raw.get("frontmatter") or {})
    body = str(raw.get("body") or "")
    # Compute mtime the same way batch activities do, so downstream
    # logic (cursor comparison if reused) stays consistent.
    mtime = _record_mtime({"frontmatter": fm})
    if record_type == "matter":
        # Carry a preview just like the list endpoint would, so
        # description-preview-based callers behave identically.
        fm.setdefault("description_preview", body[:2000])
        return {
            "slug": slug,
            "path": path,
            "frontmatter": fm,
            "body": _clamp_body(body),
            "mtime": mtime,
        }
    # task
    matter_ref = _resolve_task_matter(fm)
    return {
        "slug": slug,
        "path": path,
        "frontmatter": fm,
        "matter_slug": matter_ref,
        "body": _clamp_body(body),
        "mtime": mtime,
    }


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
) -> dict[str, Any]:
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
) -> dict[str, Any]:
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
        # Stable copies of the logical intent — the staleness filter may
        # drop these from ``issue_body`` (deferred fields), but the outbound
        # signature hash below must always reflect what we LOGICALLY intend
        # so reverse-sync can recognise the echo.
        issue_name = _sanitize_plane_name(str(update.get("name") or slug))
        issue_priority = update.get("priority") or "none"
        issue_body: dict[str, Any] = {
            "name": issue_name,
            "priority": issue_priority,
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

        deferred_fields: list[str] = []
        if existing_id:
            # ── Staleness check (per-field conflict resolution) ──────────
            #
            # Fetch Plane's current state once before issuing any PATCH so
            # we can:
            #   * Drop fields where Plane already matches (no-op savings).
            #   * Drop fields where Plane was touched more recently than
            #     us (prevents stomping a Sir-edit-in-Plane that
            #     reverse-sync hasn't yet mirrored to vault).
            # On 404 the existing 404-handler below takes over (cross-
            # project move / stale_dropped path) — we only do the
            # staleness filter when the issue actually exists in the
            # expected project.
            plane_current: Optional[dict[str, Any]] = None
            try:
                plane_current = await client.get_issue(project_id, existing_id)
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code != 404:
                    # On non-404 GET errors, log + fall through. Better
                    # to risk one stomp than block forward-sync on a
                    # transient Plane outage.
                    logger.warning(
                        "plane_sync.staleness_get_failed slug=%s plane_id=%s "
                        "status=%s — proceeding with blind PATCH",
                        slug, existing_id, exc.response.status_code,
                    )
            except Exception as exc:  # noqa: BLE001
                # Network glitch, test-double without get_issue, anything
                # unexpected — fall through to the original blind-PATCH
                # path. Staleness filtering is a safety enhancement, not
                # a prerequisite for the activity to function.
                logger.warning(
                    "plane_sync.staleness_get_unexpected slug=%s plane_id=%s "
                    "err=%s — proceeding with blind PATCH",
                    slug, existing_id, exc,
                )
            if isinstance(plane_current, dict):
                filtered_body, deferred_fields = _filter_stale_fields(
                    issue_body, plane_current, existing_id, slug,
                )
                if not filtered_body:
                    # Either Plane already matches us on every field, or
                    # every divergent field was deferred to reverse-sync.
                    # Either way — no PATCH is correct.
                    logger.info(
                        "plane_sync.skipped_no_diff slug=%s plane_id=%s "
                        "deferred=%s",
                        slug, existing_id, deferred_fields,
                    )
                    return {
                        "slug": slug,
                        "plane_id": existing_id,
                        "action": "skipped_no_diff" if not deferred_fields else "deferred_by_staleness",
                        "project_id": project_id,
                        "deferred_fields": deferred_fields,
                    }
                # Update the body for the PATCH — only fields that
                # actually need to change.
                issue_body = filtered_body
            try:
                await client.update_issue(project_id, existing_id, issue_body)
                action = "update"
                plane_id = existing_id
            except httpx.HTTPStatusError as exc:
                # 404 on update: the issue isn't in the project we're
                # PATCHing. That could be a genuine deletion OR — the
                # common case that motivated the tenant-a hotfix — a
                # cross-project move where forward-sync re-resolved the
                # destination project (e.g. ``related_matters`` changed)
                # but Plane still holds the issue under the OLD project.
                #
                # Never auto-archive from a 404. Vault is the source of
                # truth; Plane is a projection. We:
                #   1. Search every OTHER known project for the issue.
                #   2. If found: delete the stale issue so the next tick
                #      creates a fresh one in the correct project.
                #      Return action="stale_dropped".
                #   3. If not found (or the search itself fails): also
                #      return "stale_dropped". Genuine deletion is
                #      handled by the hourly reconciliation workflow,
                #      which confirms against the vault record.
                #
                # Only 404 triggers this path — other HTTP errors (500,
                # 503, 403) still propagate so the workflow's retry
                # policy handles genuine outages.
                if exc.response.status_code != 404:
                    raise
                logger.info(
                    "plane_sync.update_404 slug=%s plane_id=%s "
                    "project=%s — searching other projects",
                    slug, existing_id, project_id,
                )
                other_project_id: Optional[str] = None
                try:
                    other_project_id = await _find_issue_in_other_projects(
                        client, existing_id, project_id, project_map,
                    )
                except Exception as search_exc:  # noqa: BLE001
                    # Defensive: cross-project search must never escalate
                    # into an archive or a raise. Log and fall through to
                    # the stale_dropped path.
                    logger.warning(
                        "plane_sync.cross_project_search_failed slug=%s "
                        "plane_id=%s error=%s — treating as stale_dropped",
                        slug, existing_id, search_exc,
                    )
                    other_project_id = None

                if other_project_id:
                    # Cross-project move confirmed: delete the stale
                    # issue from the project Plane still holds it in.
                    # Next forward-sync tick creates a fresh issue in
                    # the correct project. Swallow any error from the
                    # delete — worst case we leave an orphan which the
                    # hourly reconciliation will pick up; we still
                    # want to clear the slug from issue_map.
                    try:
                        await client.delete_issue(
                            other_project_id, existing_id,
                        )
                        logger.info(
                            "plane_sync.stale_issue_deleted slug=%s "
                            "plane_id=%s from_project=%s",
                            slug, existing_id, other_project_id,
                        )
                    except Exception as del_exc:  # noqa: BLE001
                        logger.warning(
                            "plane_sync.stale_issue_delete_failed "
                            "slug=%s plane_id=%s from_project=%s "
                            "error=%s — dropping slug anyway",
                            slug, existing_id, other_project_id, del_exc,
                        )
                else:
                    logger.warning(
                        "plane_sync.stale_issue_map slug=%s plane_id=%s "
                        "— not found in any known project; dropping "
                        "slug, next tick will re-create",
                        slug, existing_id,
                    )

                return {
                    "slug": slug,
                    "plane_id": "",
                    "action": "stale_dropped",
                }
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
            "name": issue_name,
            "description": description_html,
            "priority": issue_priority,
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
            "deferred_fields": deferred_fields,
        }
    finally:
        await client.close()
