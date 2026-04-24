"""One-shot cleanup for Plane issues whose backing vault task is archived
or missing.

Background
----------

The forward-sync worker's archive cascade (see
``plane_sync.sync_task_to_plane``) only fires when the workflow FETCHES the
task record for sync. But ctrl-api's ``/api/v1/vault/list/task`` endpoint
filters out ``archived: true`` records by default, so once a task flips to
archived the cascade never fires — the Plane issue lingers in Inbox
indefinitely. The companion change in ``archive_orphan_tasks.py`` (PR #591)
closes that gap going forward, but existing tenants have a pool of
Plane-Inbox issues whose vault counterparts were archived before the fix
shipped. This script mops them up.

On David's vault the pool is ~432 Inbox issues.

Strategy
--------

1. Read the Plane sync cursor to get ``project_map``.
2. For every project in the map, paginate ``GET /issues/`` and collect:
   ``(plane_id, project_id, external_id, name)``.
3. For each Plane issue whose ``external_id`` starts with ``alfred:``,
   extract the vault slug. GET ``/api/v1/vault/records/task/<slug>.md``
   via ctrl-api:

   - ``frontmatter.archived == True`` → DELETE the Plane issue (stale).
   - ctrl-api returns 404 → the vault record doesn't exist (orphan with
     no vault backing) → DELETE the Plane issue.
   - Record exists and is NOT archived → leave alone.

4. Issues without the ``alfred:`` external_id prefix are skipped
   regardless — those were created directly in Plane by a human, not by
   forward-sync.

Hard rules
----------

- Idempotent — re-runnable. A slug we delete this run will 404 next run,
  which we treat as "already gone" and skip.
- Never deletes a Plane issue backed by an active (unarchived) vault task.
- Skips tasks with ``agent_id`` or ``skill_entry`` frontmatter (agent-
  managed chores, out of orphan/archive scope).
- Does NOT write the cursor back. Forward-sync re-heals the map naturally
  once the deletions land.

Usage
-----

::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.cleanup_plane_stragglers \\
            [--dry-run] [--tenant-id <id>] [--verbose]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import httpx

from src.config import load_config
from src.utils.plane_client import PlaneClient

logger = logging.getLogger("cleanup-plane-stragglers")


# ---------------------------------------------------------------------------
# Constants (mirrored from plane_sync.py + rebuild_plane_issue_map.py)
# ---------------------------------------------------------------------------

_CURSOR_RELATIVE = "state/plane_sync_cursor.json"
_ALFRED_EXTERNAL_PREFIX = "alfred:"

# Pagination — mirror rebuild_plane_issue_map defaults so we stay within
# Plane's observed rate-limit envelope.
_PAGE_SIZE = 100
_MAX_PAGES = 200
_THROTTLE_SECONDS = 1.0
_MAX_429_RETRIES = 5


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="cleanup_plane_stragglers",
        description=(
            "Delete Plane issues whose backing vault task is archived "
            "or missing. One-shot cleanup for the pre-cascade pool."
        ),
    )
    p.add_argument(
        "--tenant-id",
        default=os.environ.get("TENANT_ID", ""),
        help="Optional tenant identifier (logging/summary only).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would happen without DELETEing.",
    )
    p.add_argument(
        "--verbose",
        action="store_true",
        help="DEBUG-level logging (per-issue decision).",
    )
    return p.parse_args(argv)


# ---------------------------------------------------------------------------
# Cursor I/O — read-only.
# ---------------------------------------------------------------------------


def _cursor_path() -> Path:
    cfg = load_config()
    return Path(cfg.alfred_data_dir) / _CURSOR_RELATIVE


def _load_cursor() -> dict[str, Any]:
    path = _cursor_path()
    if not path.exists():
        raise RuntimeError(
            f"cleanup_plane_stragglers: cursor file not found at {path}. "
            "Run forward-sync at least once to initialise the cursor."
        )
    try:
        with path.open("r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            raise ValueError("cursor is not a JSON object")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            f"cleanup_plane_stragglers: cursor at {path} unreadable ({exc})"
        ) from exc
    return {
        "project_map": dict(raw.get("project_map") or {}),
        "issue_map": dict(raw.get("issue_map") or {}),
    }


# ---------------------------------------------------------------------------
# ctrl-api client
# ---------------------------------------------------------------------------


class CtrlClient:
    """Minimal async client — just the vault record GET endpoint."""

    def __init__(self) -> None:
        cfg = load_config()
        api_key = os.environ.get("AAS_API_KEY", "")
        if not api_key:
            raise RuntimeError(
                "AAS_API_KEY is not set — this script must run inside the "
                "alfred-learn container (or with the env exported).",
            )
        self._client = httpx.AsyncClient(
            base_url=cfg.alfred_ctrl_url,
            timeout=30.0,
            headers={"Authorization": f"Bearer {api_key}"},
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def read_task(
        self, slug: str
    ) -> tuple[Optional[dict[str, Any]], int]:
        """Return ``(record, status_code)``.

        ``record`` is ``None`` on 404 (missing vault backing), a dict on
        success. Any other non-2xx status raises.
        """
        path = f"/api/v1/vault/records/task/{slug}.md"
        resp = await self._client.get(path)
        if resp.status_code == 404:
            return None, 404
        resp.raise_for_status()
        return resp.json(), resp.status_code


# ---------------------------------------------------------------------------
# Plane client + pagination (mirrored from rebuild_plane_issue_map.py)
# ---------------------------------------------------------------------------


def _plane_client_from_env() -> PlaneClient:
    return PlaneClient(
        base_url=(
            os.environ.get("PLANE_API_BASE_URL")
            or os.environ.get("PLANE_API_URL")
        ),
        token=os.environ.get("PLANE_API_TOKEN"),
        workspace_slug=os.environ.get("PLANE_WORKSPACE_SLUG"),
    )


async def _list_project_issues(
    client: PlaneClient,
    project_id: str,
) -> list[dict[str, Any]]:
    """Paginate through every issue in a project.

    Copied verbatim (shape-wise) from rebuild_plane_issue_map so the two
    scripts stay in lockstep. Handles the Plane 1.3.0 envelope —
    ``next_page_results: false`` is the only reliable stop signal.
    """
    issues: list[dict[str, Any]] = []
    http = await client._get_client()  # type: ignore[attr-defined]
    path = (
        f"/api/v1/workspaces/{client.workspace_slug}/projects/"
        f"{project_id}/issues/"
    )

    next_cursor: Optional[str] = None
    for page in range(_MAX_PAGES):
        params: dict[str, Any] = {"per_page": _PAGE_SIZE}
        if next_cursor:
            params["cursor"] = next_cursor

        # 429-aware GET with Retry-After backoff.
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
                "cleanup_plane_stragglers: project=%s page=%d 429 "
                "attempt=%d/%d Retry-After=%s — sleeping %.1fs",
                project_id, page, attempt + 1, _MAX_429_RETRIES,
                retry_after or "(none)", backoff,
            )
            await asyncio.sleep(backoff)
        assert resp is not None  # noqa: S101
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
                "cleanup_plane_stragglers: unexpected payload shape for "
                "project=%s page=%d: %r",
                project_id, page, type(data).__name__,
            )
            break

        issues.extend(page_issues)
        logger.debug(
            "cleanup_plane_stragglers: project=%s page=%d got=%d running=%d",
            project_id, page, len(page_issues), len(issues),
        )

        if isinstance(data, list):
            break

        # Plane 1.3.0's only reliable stop signal.
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
            "cleanup_plane_stragglers: project=%s page=%d full page but no "
            "cursor — stopping pagination (may miss entries).",
            project_id, page,
        )
        break
    else:
        logger.warning(
            "cleanup_plane_stragglers: project=%s hit MAX_PAGES=%d",
            project_id, _MAX_PAGES,
        )

    return issues


# ---------------------------------------------------------------------------
# Slug extraction + vault predicates
# ---------------------------------------------------------------------------


def _slug_from_external_id(external_id: Any) -> Optional[str]:
    if not isinstance(external_id, str):
        return None
    s = external_id.strip()
    if not s.startswith(_ALFRED_EXTERNAL_PREFIX):
        return None
    slug = s[len(_ALFRED_EXTERNAL_PREFIX):].strip()
    return slug or None


def _is_archived(fm: dict[str, Any]) -> bool:
    val = fm.get("archived")
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.strip().lower() == "true"
    return False


def _is_agent_managed(fm: dict[str, Any]) -> bool:
    return bool(fm.get("agent_id") or fm.get("skill_entry"))


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------


@dataclass
class CleanupStats:
    projects_total: int = 0
    projects_scanned: int = 0
    projects_errored: int = 0
    issues_scanned: int = 0
    alfred_stamped: int = 0
    unstamped_skipped: int = 0
    vault_active_kept: int = 0
    vault_agent_managed_kept: int = 0
    vault_archived_deleted: int = 0
    vault_missing_deleted: int = 0
    delete_errors: int = 0
    vault_read_errors: int = 0
    error_messages: list[str] = field(default_factory=list)
    per_project_counts: dict[str, int] = field(default_factory=dict)
    started_at: float = 0.0
    finished_at: float = 0.0


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------


async def _run(args: argparse.Namespace) -> CleanupStats:
    stats = CleanupStats()
    stats.started_at = time.time()

    cursor = _load_cursor()
    project_map: dict[str, str] = dict(cursor.get("project_map") or {})

    stats.projects_total = len(project_map)

    logger.info(
        "cleanup_plane_stragglers: tenant=%s dry_run=%s projects=%d",
        args.tenant_id or "(unspecified)",
        args.dry_run,
        stats.projects_total,
    )

    if not project_map:
        logger.warning(
            "cleanup_plane_stragglers: project_map empty — nothing to scan."
        )
        stats.finished_at = time.time()
        _print_summary(args, stats)
        return stats

    ctrl = CtrlClient()
    plane = _plane_client_from_env()
    try:
        for slug_or_sentinel, proj_id in sorted(project_map.items()):
            proj_id_str = str(proj_id or "")
            if not proj_id_str:
                continue
            try:
                issues = await _list_project_issues(plane, proj_id_str)
            except httpx.HTTPStatusError as exc:
                stats.projects_errored += 1
                msg = (
                    f"list project={proj_id_str} ({slug_or_sentinel}): "
                    f"HTTP {exc.response.status_code}"
                )[:500]
                stats.error_messages.append(msg)
                logger.warning("cleanup_plane_stragglers: %s", msg)
                continue
            except Exception as exc:  # noqa: BLE001
                stats.projects_errored += 1
                msg = (
                    f"list project={proj_id_str} ({slug_or_sentinel}): {exc}"
                )[:500]
                stats.error_messages.append(msg)
                logger.warning("cleanup_plane_stragglers: %s", msg)
                continue

            stats.projects_scanned += 1
            stats.per_project_counts[slug_or_sentinel] = 0
            logger.info(
                "cleanup_plane_stragglers: project=%s (%s) issues=%d",
                proj_id_str, slug_or_sentinel, len(issues),
            )

            await asyncio.sleep(_THROTTLE_SECONDS)

            for issue in issues:
                stats.issues_scanned += 1
                plane_id = str(issue.get("id") or "")
                name = str(issue.get("name") or "")[:120]
                if not plane_id:
                    continue
                slug = _slug_from_external_id(issue.get("external_id"))
                if slug is None:
                    stats.unstamped_skipped += 1
                    continue
                stats.alfred_stamped += 1

                # Fetch the vault record for this slug.
                try:
                    record, status = await ctrl.read_task(slug)
                except httpx.HTTPError as exc:
                    stats.vault_read_errors += 1
                    msg = f"vault read {slug}: {exc}"[:500]
                    stats.error_messages.append(msg)
                    logger.warning("cleanup_plane_stragglers: %s", msg)
                    continue

                if status == 404 or record is None:
                    # Vault has no backing — orphan on Plane side. Delete.
                    decision = "delete stale {} ({}) — vault missing".format(
                        plane_id, name
                    )
                    deletion_kind = "missing"
                else:
                    fm = record.get("frontmatter") or {}
                    if _is_agent_managed(fm):
                        stats.vault_agent_managed_kept += 1
                        logger.debug(
                            "cleanup_plane_stragglers: keep %s (%s) "
                            "— vault agent-managed",
                            plane_id, slug,
                        )
                        continue
                    if _is_archived(fm):
                        decision = (
                            "delete stale {} ({}) — vault archived".format(
                                plane_id, name
                            )
                        )
                        deletion_kind = "archived"
                    else:
                        stats.vault_active_kept += 1
                        if args.verbose:
                            logger.debug(
                                "cleanup_plane_stragglers: keep %s (%s) "
                                "— vault active",
                                plane_id, slug,
                            )
                        continue

                logger.info("cleanup_plane_stragglers: %s", decision)

                if args.dry_run:
                    if deletion_kind == "archived":
                        stats.vault_archived_deleted += 1
                    else:
                        stats.vault_missing_deleted += 1
                    stats.per_project_counts[slug_or_sentinel] += 1
                    continue

                try:
                    await plane.delete_issue(proj_id_str, plane_id)
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code == 404:
                        # Already gone — treat as success for counters.
                        pass
                    else:
                        stats.delete_errors += 1
                        msg = (
                            f"delete {plane_id} in {proj_id_str}: "
                            f"HTTP {exc.response.status_code}"
                        )[:500]
                        stats.error_messages.append(msg)
                        logger.warning(
                            "cleanup_plane_stragglers: %s", msg
                        )
                        continue
                except Exception as exc:  # noqa: BLE001
                    stats.delete_errors += 1
                    msg = f"delete {plane_id}: {exc!r}"[:500]
                    stats.error_messages.append(msg)
                    logger.warning("cleanup_plane_stragglers: %s", msg)
                    continue

                if deletion_kind == "archived":
                    stats.vault_archived_deleted += 1
                else:
                    stats.vault_missing_deleted += 1
                stats.per_project_counts[slug_or_sentinel] += 1
    finally:
        await ctrl.close()
        await plane.close()

    stats.finished_at = time.time()
    _print_summary(args, stats)
    return stats


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------


def _print_summary(args: argparse.Namespace, stats: CleanupStats) -> None:
    runtime = stats.finished_at - stats.started_at
    print("\n" + "=" * 72)
    print("CLEANUP PLANE STRAGGLERS — SUMMARY")
    print("=" * 72)
    print(f"tenant:                       {args.tenant_id or '(unspecified)'}")
    print(f"mode:                         {'DRY-RUN' if args.dry_run else 'LIVE'}")
    print(f"projects in map:              {stats.projects_total}")
    print(f"projects scanned:             {stats.projects_scanned}")
    print(f"projects errored:             {stats.projects_errored}")
    print(f"issues scanned:               {stats.issues_scanned}")
    print(f"alfred-stamped issues:        {stats.alfred_stamped}")
    print(f"unstamped skipped:            {stats.unstamped_skipped}")
    print(f"vault active (kept):          {stats.vault_active_kept}")
    print(f"vault agent-managed (kept):   {stats.vault_agent_managed_kept}")
    print(f"vault archived -> deleted:    {stats.vault_archived_deleted}")
    print(f"vault missing -> deleted:     {stats.vault_missing_deleted}")
    print(f"delete errors:                {stats.delete_errors}")
    print(f"vault read errors:            {stats.vault_read_errors}")
    print(f"runtime:                      {runtime:0.1f}s")
    if stats.per_project_counts:
        print("\nper-project deletions:")
        for name, count in sorted(
            stats.per_project_counts.items(), key=lambda kv: -kv[1]
        )[:20]:
            if count:
                print(f"  {name:40s} {count}")
    if stats.error_messages:
        print("\nfirst 5 error messages:")
        for msg in stats.error_messages[:5]:
            print(f"  - {msg}")
    print("=" * 72)


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        asyncio.run(_run(args))
    except KeyboardInterrupt:
        print("\ncleanup_plane_stragglers: interrupted", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001
        logger.exception("cleanup_plane_stragglers: failed: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
