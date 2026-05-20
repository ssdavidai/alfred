"""Activities for ``PlaneReconciliationWorkflow`` — hourly sweep that detects
Plane issues deleted out-of-band and mirrors the deletion into the vault.

Background
----------

Plane 1.3.0 only emits ``issue.deleted`` webhooks when deletion happens via
the UI. Programmatic DELETEs via the REST API return 204 with no webhook,
so the reverse-sync workflow never learns about them. Forward-sync catches
the stragglers when a vault task change triggers an update (see the
404-on-update archive handler in ``sync_task_to_plane``), but tasks whose
mtime never advances past the cursor stay stuck pointing at a gone Plane
issue indefinitely.

This activity does the other half: it scans every project's live issue
list, cross-references against the forward-sync ``issue_map``, and archives
any vault task whose mapped ``plane_id`` is no longer present in Plane.

Scale
-----

Runs once an hour. Paginates up to ``_MAX_PAGES`` per project with a light
throttle between pages (matches the tuning in
``scripts.rebuild_plane_issue_map``). A hard cap on total issues observed
across the run guards against a pathological workspace — we early-exit with
a warning if we see more than ``_MAX_TOTAL_ISSUES``.

Idempotency
-----------

The activity's effect is limited to (a) patching `archived=true` on vault
tasks and (b) clearing entries from the cursor's ``issue_map``. Both are
idempotent — running it twice back-to-back is a no-op on the second run.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Optional

import httpx
from temporalio import activity

from src.activities.plane_sync import (
    INBOX_SLUG_SENTINEL,
    _archive_vault_task_from_plane_delete,
    _cursor_path,
    _load_cursor_from_disk,
    _plane_client_from_env,
    _atomic_write,
)
from src.config import load_config
from src.utils.plane_client import PlaneClient
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


# Tuning — match the rebuild_plane_issue_map script so reconciliation and
# the one-shot repair tool behave identically against Plane's pagination.
_PAGE_SIZE = 100
_MAX_PAGES = 200
_THROTTLE_SECONDS = 1.0
_MAX_429_RETRIES = 5

# Safety cap across the whole run. Plane workspaces on the fleet top out
# around 3-4k issues; 10k is where something's clearly wrong and a full
# sweep would be unreasonable. Early-exit with a warning so the reconciler
# never wedges the worker on a misconfigured tenant.
_MAX_TOTAL_ISSUES = 10_000


# ---------------------------------------------------------------------------
# Feature flag (same env as forward + reverse sync so flipping flips all three)
# ---------------------------------------------------------------------------

@activity.defn
async def plane_reconciliation_is_enabled() -> bool:
    """Same gate as ``plane_sync_is_enabled`` — reconciliation runs iff
    ``PLANE_SYNC_ENABLED=true``.
    """
    return os.environ.get("PLANE_SYNC_ENABLED", "").lower() == "true"


# ---------------------------------------------------------------------------
# Pagination helper — paginate every issue in one project.
# Mirrors scripts.rebuild_plane_issue_map._list_project_issues so both
# paths cope with the same pagination shapes Plane has shipped.
# ---------------------------------------------------------------------------

async def _list_project_issues(
    client: PlaneClient, project_id: str,
) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    http = await client._get_client()  # type: ignore[attr-defined]
    path = (
        f"/api/v1/workspaces/{client.workspace_slug}"
        f"/projects/{project_id}/issues/"
    )

    next_cursor: Optional[str] = None
    for page in range(_MAX_PAGES):
        params: dict[str, Any] = {"per_page": _PAGE_SIZE}
        if next_cursor:
            params["cursor"] = next_cursor

        # 429-aware GET with Retry-After backoff. Copy of the pattern in
        # scripts.rebuild_plane_issue_map — Plane's self-hosted proxy
        # sometimes throttles when back-to-back projects get paged.
        resp: Optional[httpx.Response] = None
        for attempt in range(_MAX_429_RETRIES):
            resp = await http.get(path, params=params)
            if resp.status_code != 429:
                break
            retry_after = resp.headers.get("Retry-After") or ""
            try:
                backoff = float(retry_after) if retry_after else 5.0
            except ValueError:
                backoff = 5.0
            backoff = min(max(backoff, 1.0), 60.0)
            logger.info(
                "plane_reconciliation: project=%s page=%d 429 attempt=%d/%d "
                "Retry-After=%s sleeping=%.1fs",
                project_id, page, attempt + 1, _MAX_429_RETRIES,
                retry_after or "(none)", backoff,
            )
            await asyncio.sleep(backoff)
        assert resp is not None  # noqa: S101 — loop always assigns
        resp.raise_for_status()
        data = resp.json()

        await asyncio.sleep(_THROTTLE_SECONDS)

        page_issues: list[dict[str, Any]] = []
        if isinstance(data, list):
            page_issues = data
        elif isinstance(data, dict):
            page_issues = data.get("results") or []
        else:
            logger.warning(
                "plane_reconciliation: unexpected payload shape for "
                "project=%s page=%d: %r",
                project_id, page, type(data).__name__,
            )
            break

        issues.extend(page_issues)

        if isinstance(data, list):
            break
        if data.get("next_page_results") is False:
            break
        if not page_issues:
            break

        new_cursor = (
            data.get("next_cursor")
            or data.get("next_page_cursor")
            or data.get("next")
        )
        if isinstance(new_cursor, str) and new_cursor:
            if new_cursor.startswith("http"):
                try:
                    from urllib.parse import parse_qs, urlparse
                    qs = parse_qs(urlparse(new_cursor).query)
                    cur_vals = qs.get("cursor") or []
                    new_cursor = cur_vals[0] if cur_vals else None
                except Exception:
                    new_cursor = None
            if new_cursor:
                next_cursor = new_cursor
                continue

        if len(page_issues) < _PAGE_SIZE:
            break

        logger.warning(
            "plane_reconciliation: project=%s page=%d full page but no "
            "cursor — stopping pagination",
            project_id, page,
        )
        break
    else:
        logger.warning(
            "plane_reconciliation: project=%s hit MAX_PAGES=%d",
            project_id, _MAX_PAGES,
        )
    return issues


# ---------------------------------------------------------------------------
# Main reconciliation activity
# ---------------------------------------------------------------------------

@activity.defn
async def reconcile_plane_deletes() -> dict[str, Any]:
    """Detect Plane issues deleted out-of-band and archive the mirrored
    vault tasks. Returns counters for the workflow to surface.

    Steps:
      1. Load forward-sync cursor → extract ``project_map`` and ``issue_map``.
      2. For each Plane project in ``project_map``, paginate all issues.
      3. Build a set of live Plane issue UUIDs across the workspace.
      4. For each ``{slug: plane_id}`` in ``issue_map``, check whether
         ``plane_id`` is still live. If not, archive the vault task (via
         the shared helper) and drop the slug from ``issue_map``.
      5. Atomic-write the cursor back. Preserve ``project_map`` and
         ``last_vault_mtime`` untouched.

    The caller (workflow) supplies no arguments — this activity is a
    self-contained sweep. Returning a dict of counters lets the workflow
    emit a single log line + persist result metadata in Temporal history.
    """
    counters: dict[str, Any] = {
        "projects_scanned": 0,
        "plane_issues_found": 0,
        "map_entries_checked": 0,
        "stale_map_entries": 0,
        "vault_archived": 0,
        "errors": 0,
        "early_exit": False,
    }

    cursor_path = _cursor_path()
    state = _load_cursor_from_disk(cursor_path)
    project_map: dict[str, str] = dict(state.get("project_map") or {})
    issue_map: dict[str, str] = dict(state.get("issue_map") or {})

    if not project_map:
        logger.info("plane_reconciliation: project_map empty — nothing to do")
        return counters

    # Collect live issue UUIDs across every project the cursor knows about.
    live_plane_ids: set[str] = set()
    plane_client = _plane_client_from_env()
    try:
        # Preserve insertion order for a deterministic log stream.
        unique_projects = list({
            pid for pid in project_map.values() if pid
        })
        for project_id in unique_projects:
            try:
                issues = await _list_project_issues(plane_client, project_id)
            except Exception as exc:  # noqa: BLE001
                # A single project failing shouldn't poison the sweep —
                # record error, skip this project. The vault tasks whose
                # plane_ids belong to the failed project will get re-checked
                # on the next hour's run. Err on the side of NOT archiving
                # when we don't have authoritative "it's gone" signal.
                logger.warning(
                    "plane_reconciliation: list_project_issues failed "
                    "project=%s error=%s", project_id, exc,
                )
                counters["errors"] = int(counters["errors"]) + 1
                # Mark this project as "unknown" — any issue_map entries
                # pointing into it will be skipped for this run.
                counters.setdefault("unknown_projects", []).append(project_id)
                continue
            counters["projects_scanned"] = int(counters["projects_scanned"]) + 1
            for issue in issues:
                uid = str(issue.get("id") or "")
                if uid:
                    live_plane_ids.add(uid)
            counters["plane_issues_found"] = len(live_plane_ids)
            if len(live_plane_ids) > _MAX_TOTAL_ISSUES:
                logger.warning(
                    "plane_reconciliation: observed %d issues (> %d cap) — "
                    "early exit to protect worker",
                    len(live_plane_ids), _MAX_TOTAL_ISSUES,
                )
                counters["early_exit"] = True
                break
    finally:
        await plane_client.close()

    # Issue_map entries whose plane_id isn't in the live set AND whose
    # destination project succeeded — those are the real deletes.
    unknown_projects: set[str] = set(counters.get("unknown_projects") or [])

    # Reverse-lookup helper: which project is this issue_map entry pointing
    # into? We don't store that mapping, but project_map.values() is the
    # set of all projects we scanned. If a plane_id isn't in live_plane_ids
    # AND all projects we tried succeeded (no unknown_projects), we know
    # the plane_id is genuinely gone. If any project failed, we can still
    # archive entries that are clearly live in the SUCCEEDED projects —
    # but we must NOT archive an entry whose destination project failed.
    #
    # Simplification: treat "the entry's plane_id was not observed in any
    # successful project scan" as "unknown" when at least one project
    # failed — don't archive on ambiguity. This means a single failed
    # project defers ALL deletes for this run, but reconciliation is
    # hourly + rare, so the conservative approach costs ~an hour of
    # detection latency in the failure path.
    if unknown_projects and counters["early_exit"] is False:
        logger.warning(
            "plane_reconciliation: %d project(s) failed to scan — deferring "
            "ALL deletes this run to avoid false-positive archives",
            len(unknown_projects),
        )
        # Early-exit path keeps the cursor untouched, which is what we want.
        # But we still report the counters accumulated so far.
        counters["map_entries_checked"] = 0
        counters["stale_map_entries"] = 0
        return counters

    # Scan issue_map.
    stale_slugs: list[tuple[str, str]] = []
    for slug, plane_id in issue_map.items():
        counters["map_entries_checked"] = (
            int(counters["map_entries_checked"]) + 1
        )
        if not plane_id:
            continue
        # Inbox sentinel isn't a real slug — skip defensively though it
        # shouldn't appear in issue_map (it lives in project_map).
        if slug == INBOX_SLUG_SENTINEL:
            continue
        if plane_id not in live_plane_ids:
            stale_slugs.append((slug, plane_id))

    counters["stale_map_entries"] = len(stale_slugs)

    # Archive + prune each stale entry.
    #
    # IMPORTANT: do NOT mutate the stale ``issue_map`` snapshot and write it
    # back — the 15s forward-sync (``plane_sync.save_plane_sync_state``) may
    # have persisted new ``issue_map`` entries / a bumped ``last_vault_mtime``
    # during our minutes-long scan. Blindly overwriting the whole cursor from
    # this snapshot would clobber those (lost-update race). Instead we only
    # OWN the delete outcomes: record ``{slug: plane_id}`` we confirmed gone,
    # then re-read + merge at write time.
    pruned: dict[str, str] = {}
    vault_cfg = load_config()
    vault_client = VaultClient(vault_cfg)
    try:
        for slug, plane_id in stale_slugs:
            task_path = f"task/{slug}.md"
            # Read to decide whether an archive is needed.
            try:
                rec = await vault_client.read_record(task_path)
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code == 404:
                    # Vault task already gone (curator merge / explicit
                    # delete). Nothing to archive — just drop the map entry.
                    logger.info(
                        "plane_reconciliation: vault task missing for stale "
                        "slug=%s plane_id=%s — pruning map entry",
                        slug, plane_id,
                    )
                    pruned[slug] = plane_id
                    continue
                logger.warning(
                    "plane_reconciliation: read_record failed slug=%s "
                    "plane_id=%s error=%s",
                    slug, plane_id, exc,
                )
                counters["errors"] = int(counters["errors"]) + 1
                continue
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "plane_reconciliation: read_record failed slug=%s "
                    "plane_id=%s error=%s",
                    slug, plane_id, exc,
                )
                counters["errors"] = int(counters["errors"]) + 1
                continue

            fm = (rec or {}).get("frontmatter") or {}
            if fm.get("archived") is True:
                # Already archived (forward-sync beat us to it, or another
                # run). Just prune the map entry.
                pruned[slug] = plane_id
                continue

            try:
                await _archive_vault_task_from_plane_delete(slug, task_path)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "plane_reconciliation: archive failed slug=%s "
                    "plane_id=%s error=%s",
                    slug, plane_id, exc,
                )
                counters["errors"] = int(counters["errors"]) + 1
                continue

            counters["vault_archived"] = (
                int(counters["vault_archived"]) + 1
            )
            pruned[slug] = plane_id
    finally:
        await vault_client.close()

    # Atomic cursor write — re-read the CURRENT cursor immediately before
    # writing and merge only the fields we own (the delete outcomes). This
    # preserves any forward-sync update that landed during our scan.
    import json
    current = _load_cursor_from_disk(cursor_path)
    merged_issue_map: dict[str, str] = dict(current.get("issue_map") or {})
    for slug, gone_plane_id in pruned.items():
        # Only drop the entry if it STILL points at the plane_id we
        # confirmed gone. If forward-sync recreated the slug with a fresh
        # plane_id, leave it — that's a live mapping, not our delete.
        if merged_issue_map.get(slug) == gone_plane_id:
            merged_issue_map.pop(slug, None)
    state_out = {
        "last_vault_mtime": float(current.get("last_vault_mtime", 0.0) or 0.0),
        "project_map": dict(current.get("project_map") or {}),
        "issue_map": merged_issue_map,
    }
    payload = json.dumps(state_out, indent=2, sort_keys=True)
    _atomic_write(cursor_path, payload)

    logger.info(
        "plane_reconciliation.done projects_scanned=%s plane_issues_found=%s "
        "map_entries_checked=%s stale_map_entries=%s vault_archived=%s "
        "errors=%s early_exit=%s",
        counters["projects_scanned"],
        counters["plane_issues_found"],
        counters["map_entries_checked"],
        counters["stale_map_entries"],
        counters["vault_archived"],
        counters["errors"],
        counters["early_exit"],
    )

    # Strip internal list before returning (don't expose the debug key).
    counters.pop("unknown_projects", None)
    return counters
