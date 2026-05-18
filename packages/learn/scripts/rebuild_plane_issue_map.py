"""Rebuild the Plane sync cursor ``issue_map`` from live Plane state.

Background
----------

The forward-sync cursor at ``/alfred-data/state/plane_sync_cursor.json``
maps vault task slugs → Plane issue UUIDs so the archive cascade in
``plane_sync.sync_task_to_plane`` can find and DELETE the Plane issue
when a vault task flips to ``archived: true``.

On Sir's fleet the cursor's ``issue_map`` has drifted: many entries
are keyed on stale slugs that no longer match what ``_slug_from_path``
returns for the corresponding vault task (filenames shifted across
renames, curator mergers, etc.). The cascade's ``issue_map.get(slug)``
look-up misses, so the DELETE never fires — leaving 1353 archived vault
tasks' Plane issues lingering in Inbox.

Plane is the ONLY place where the full ``external_id`` → ``plane_id``
mapping is authoritative: every issue we ever created was stamped with
``external_id = "alfred:<slug>"`` + ``external_source = "alfred"``. So
we can page through every issue in every project the cursor knows
about, pull out the ``external_id``, and rebuild ``issue_map`` as
``{slug: plane_id}``.

This script is **read-only on Plane** (LIST endpoints only — no
writes). It does ONE write: the cursor file, atomically, preserving
``project_map`` and ``last_vault_mtime`` unchanged.

Usage
-----

Runs inside the ``alfred-learn`` container (reads ``PLANE_API_*`` +
``AAS_API_KEY`` from the tenant env)::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.rebuild_plane_issue_map [--dry-run] [--verbose]

Flags::

    --dry-run     Print summary + sample entries without writing the
                  cursor file. Still hits Plane for the LIST.
    --verbose     DEBUG-level logging (per-issue detail).
    --tenant-id   Optional — for summary output only.

Logic
-----

1. Read cursor → extract ``project_map`` (and preserve the rest).
2. For each ``project_id`` in ``project_map.values()``, paginate
   ``GET /api/v1/workspaces/<slug>/projects/<proj-id>/issues/``.
3. For each issue, read ``external_id``. If it starts with ``alfred:``,
   the suffix is the slug we want.
4. Build a fresh ``{slug: plane_id}`` dict from Plane.
5. MERGE into the existing ``issue_map`` (don't blindly replace —
   entries we can't re-verify stay put).
6. Write cursor back atomically.

Safety rules
------------

- Read-only on Plane side. No creates, no updates, no deletes.
- Atomic cursor write (tmpfile + os.replace).
- ``project_map`` + ``last_vault_mtime`` untouched.
- Preserves any existing ``issue_map`` entry we didn't re-observe
  (defensive — we might just be missing a project-id in project_map).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import httpx

from src.config import load_config
from src.utils.plane_client import PlaneClient

logger = logging.getLogger("rebuild-plane-issue-map")


# ---------------------------------------------------------------------------
# Constants (mirror plane_sync.py so we hit the same paths)
# ---------------------------------------------------------------------------

_CURSOR_RELATIVE = "state/plane_sync_cursor.json"

# Plane 1.3.0's issues LIST is paginated. Use a generous page size so we
# minimise round-trips but stay under any server-side cap. 100 is the
# common Plane default that's been observed to work.
_PAGE_SIZE = 100

# Upper bound on pages per project. With 100 issues/page × 200 pages we
# cover 20k issues before giving up, which is well beyond any sane
# per-project count on the fleet.
_MAX_PAGES = 200

# Plane's self-hosted proxy aggressively rate-limits per-IP (~1 req/s).
# Back off proactively between project scans AND honour 429 Retry-After
# headers. 1.0s idle between requests keeps us well under the limit.
_THROTTLE_SECONDS = 1.0
_MAX_429_RETRIES = 5


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="rebuild_plane_issue_map",
        description=(
            "Rebuild the Plane sync cursor `issue_map` from live Plane "
            "issues (read-only on Plane side)."
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
        help="Print summary + sample entries without writing the cursor.",
    )
    p.add_argument(
        "--verbose",
        action="store_true",
        help="DEBUG-level logging (per-issue detail).",
    )
    return p.parse_args(argv)


# ---------------------------------------------------------------------------
# Cursor I/O helpers — duplicated (rather than imported from plane_sync)
# so this script is decoupled from the activity module and its Temporal
# side-effects. Keep in lockstep with plane_sync._load_cursor_from_disk /
# _atomic_write if either side changes.
# ---------------------------------------------------------------------------


def _cursor_path() -> Path:
    cfg = load_config()
    return Path(cfg.alfred_data_dir) / _CURSOR_RELATIVE


def _load_cursor_from_disk(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"last_vault_mtime": 0.0, "project_map": {}, "issue_map": {}}
    try:
        with path.open("r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            raise ValueError("cursor is not a JSON object")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            f"rebuild_plane_issue_map: cursor at {path} unreadable ({exc}). "
            "Refusing to continue — fix the file first.",
        ) from exc

    return {
        "last_vault_mtime": float(raw.get("last_vault_mtime", 0.0) or 0.0),
        "project_map": dict(raw.get("project_map") or {}),
        "issue_map": dict(raw.get("issue_map") or {}),
    }


def _atomic_write(path: Path, payload: str) -> None:
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
# Plane pagination
# ---------------------------------------------------------------------------


async def _list_project_issues(
    client: PlaneClient,
    project_id: str,
) -> list[dict[str, Any]]:
    """Paginate through every issue in a project.

    Handles three pagination shapes Plane has shipped in the wild:

    1. Flat JSON list (oldest) — just return it.
    2. ``{"results": [...]}`` with no page hints — treat as single page.
    3. ``{"results": [...], "next_cursor": "...", "total_pages": N}`` —
       walk ``cursor`` until either ``next_cursor`` is empty/None or
       we've consumed ``total_pages`` pages.

    We also fall back to offset-style ``?per_page=N&cursor=<offset>``
    if no cursor hint comes back — Plane's paginator is documented as
    accepting ``cursor`` for both token and offset styles.
    """
    issues: list[dict[str, Any]] = []
    http = await client._get_client()  # type: ignore[attr-defined]
    path = f"/api/v1/workspaces/{client.workspace_slug}/projects/{project_id}/issues/"

    next_cursor: Optional[str] = None
    for page in range(_MAX_PAGES):
        params: dict[str, Any] = {"per_page": _PAGE_SIZE}
        if next_cursor:
            params["cursor"] = next_cursor

        # 429-aware GET with Retry-After backoff. Plane's self-hosted
        # proxy has been observed to throttle aggressively when we
        # request every project back-to-back.
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
            # Cap the per-retry wait so a pathological Retry-After
            # header (e.g. 300s) doesn't stall the whole script.
            backoff = min(max(backoff, 1.0), 60.0)
            logger.info(
                "rebuild_plane_issue_map: project=%s page=%d 429 received "
                "attempt=%d/%d Retry-After=%s — sleeping %.1fs",
                project_id, page, attempt + 1, _MAX_429_RETRIES,
                retry_after or "(none)", backoff,
            )
            await asyncio.sleep(backoff)
        assert resp is not None  # noqa: S101 — loop always assigns
        resp.raise_for_status()
        data = resp.json()

        # Throttle between pages within a project too.
        await asyncio.sleep(_THROTTLE_SECONDS)

        page_issues: list[dict[str, Any]] = []
        if isinstance(data, list):
            page_issues = data
        elif isinstance(data, dict):
            page_issues = data.get("results") or []
        else:
            logger.warning(
                "rebuild_plane_issue_map: unexpected payload shape for "
                "project=%s page=%d: %r",
                project_id, page, type(data).__name__,
            )
            break

        issues.extend(page_issues)
        logger.debug(
            "rebuild_plane_issue_map: project=%s page=%d got=%d running=%d",
            project_id, page, len(page_issues), len(issues),
        )

        # Decide whether to continue paginating.
        #
        # Case A: bare list → no pagination hints → stop.
        if isinstance(data, list):
            break

        # Case B: dict — Plane 1.3.0 returns a rich envelope:
        #   {"results": [...], "next_cursor": "100:N:0",
        #    "next_page_results": true/false, "total_pages": N, ...}
        #
        # Critical: Plane keeps returning `next_cursor` even AFTER the
        # last page. The only reliable "stop" signal is
        # `next_page_results: False`. Don't chase the cursor past it,
        # or we'll hit MAX_PAGES with a trickle of empty pages.
        if data.get("next_page_results") is False:
            break

        # Empty page with no explicit "done" hint → stop.
        if not page_issues:
            break

        new_cursor = (
            data.get("next_cursor")
            or data.get("next_page_cursor")
            or data.get("next")  # some Plane versions return a URL here
        )
        if isinstance(new_cursor, str) and new_cursor:
            # If `next` is a full URL, extract just the cursor query param.
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

        # No explicit cursor — stop if the page was short (last page).
        if len(page_issues) < _PAGE_SIZE:
            break

        # No cursor + full page → ambiguous. Be conservative and stop to
        # avoid an infinite loop. Log so we notice if Plane returns a
        # new pagination shape we don't handle.
        logger.warning(
            "rebuild_plane_issue_map: project=%s page=%d full page but no "
            "cursor — stopping pagination (may miss entries).",
            project_id, page,
        )
        break
    else:
        logger.warning(
            "rebuild_plane_issue_map: project=%s hit MAX_PAGES=%d, "
            "some issues may be missing",
            project_id, _MAX_PAGES,
        )

    return issues


# ---------------------------------------------------------------------------
# Plane client lifecycle — mirror plane_sync._plane_client_from_env so we
# honour PLANE_API_BASE_URL → PLANE_API_URL precedence.
# ---------------------------------------------------------------------------


def _plane_client_from_env() -> PlaneClient:
    return PlaneClient(
        base_url=os.environ.get("PLANE_API_BASE_URL") or os.environ.get("PLANE_API_URL"),
        token=os.environ.get("PLANE_API_TOKEN"),
        workspace_slug=os.environ.get("PLANE_WORKSPACE_SLUG"),
    )


# ---------------------------------------------------------------------------
# Slug extraction
# ---------------------------------------------------------------------------


_ALFRED_PREFIX = "alfred:"


def _slug_from_external_id(external_id: Any) -> Optional[str]:
    """Return the vault slug encoded in an issue's ``external_id``, or
    ``None`` if the field is missing / not an Alfred-stamped value.
    """
    if not isinstance(external_id, str):
        return None
    external_id = external_id.strip()
    if not external_id.startswith(_ALFRED_PREFIX):
        return None
    slug = external_id[len(_ALFRED_PREFIX):].strip()
    return slug or None


# ---------------------------------------------------------------------------
# Stats / summary
# ---------------------------------------------------------------------------


@dataclass
class RebuildStats:
    projects_total: int = 0
    projects_scanned: int = 0
    projects_errored: int = 0
    issues_scanned: int = 0
    alfred_stamped: int = 0
    unstamped: int = 0
    duplicates_collapsed: int = 0
    map_size_before: int = 0
    map_size_after: int = 0
    new_entries: int = 0
    updated_entries: int = 0
    unchanged_entries: int = 0
    preserved_entries: int = 0
    started_at: float = 0.0
    finished_at: float = 0.0
    error_messages: list[str] = field(default_factory=list)
    samples: list[dict[str, str]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------


async def _run(args: argparse.Namespace) -> RebuildStats:
    stats = RebuildStats()
    stats.started_at = time.time()

    path = _cursor_path()
    cursor = _load_cursor_from_disk(path)

    project_map: dict[str, str] = dict(cursor.get("project_map") or {})
    existing_issue_map: dict[str, str] = dict(cursor.get("issue_map") or {})
    last_vault_mtime = float(cursor.get("last_vault_mtime", 0.0) or 0.0)

    stats.map_size_before = len(existing_issue_map)
    stats.projects_total = len(project_map)

    logger.info(
        "rebuild_plane_issue_map: cursor_path=%s project_map=%d issue_map_before=%d last_vault_mtime=%s",
        path, len(project_map), len(existing_issue_map), last_vault_mtime,
    )

    if not project_map:
        logger.warning("rebuild_plane_issue_map: project_map is empty — nothing to do.")
        stats.finished_at = time.time()
        _print_summary(args, stats, dry_run=args.dry_run)
        return stats

    # Walk every project. Collate issues into a flat list so we can
    # post-process slug extraction + dedupe in one pass.
    fresh_map: dict[str, str] = {}
    client = _plane_client_from_env()
    try:
        # Sort for deterministic log order. Inbox sentinel lands before
        # UUID-like project_ids alphabetically; that's fine.
        for slug_or_sentinel, proj_id in sorted(project_map.items()):
            proj_id_str = str(proj_id or "")
            if not proj_id_str:
                logger.warning(
                    "rebuild_plane_issue_map: project_map[%s] is empty — skipping",
                    slug_or_sentinel,
                )
                continue
            try:
                issues = await _list_project_issues(client, proj_id_str)
            except httpx.HTTPStatusError as exc:
                stats.projects_errored += 1
                msg = (
                    f"list issues project={proj_id_str} "
                    f"({slug_or_sentinel}): HTTP {exc.response.status_code}"
                )[:500]
                stats.error_messages.append(msg)
                logger.warning("rebuild_plane_issue_map: %s", msg)
                continue
            except Exception as exc:  # noqa: BLE001 — surface + continue
                stats.projects_errored += 1
                msg = f"list issues project={proj_id_str} ({slug_or_sentinel}): {exc}"[:500]
                stats.error_messages.append(msg)
                logger.warning("rebuild_plane_issue_map: %s", msg)
                continue

            stats.projects_scanned += 1
            logger.info(
                "rebuild_plane_issue_map: project=%s (%s) issues=%d",
                proj_id_str, slug_or_sentinel, len(issues),
            )

            # Breathe between projects too — otherwise the
            # twelve-project walk on Sir saturates the proxy
            # immediately and the rest of the walk gets throttled.
            await asyncio.sleep(_THROTTLE_SECONDS)

            for issue in issues:
                stats.issues_scanned += 1
                plane_id = str(issue.get("id") or "")
                if not plane_id:
                    continue
                slug = _slug_from_external_id(issue.get("external_id"))
                if slug is None:
                    stats.unstamped += 1
                    continue
                stats.alfred_stamped += 1

                prior = fresh_map.get(slug)
                if prior and prior != plane_id:
                    # Same slug mapped to two different Plane IDs. Keep
                    # the first (chronologically Plane returns oldest
                    # first, but we don't strictly rely on that) — log
                    # so operator can investigate duplicates manually.
                    stats.duplicates_collapsed += 1
                    logger.warning(
                        "rebuild_plane_issue_map: duplicate slug=%s plane_ids=[%s, %s] — keeping first",
                        slug, prior, plane_id,
                    )
                    continue
                fresh_map[slug] = plane_id
    finally:
        await client.close()

    # Merge fresh_map into existing. Categorise each slug so the summary
    # tells the operator what changed.
    merged: dict[str, str] = dict(existing_issue_map)  # start from existing
    for slug, plane_id in fresh_map.items():
        old = existing_issue_map.get(slug)
        if old is None:
            stats.new_entries += 1
            merged[slug] = plane_id
        elif old != plane_id:
            stats.updated_entries += 1
            merged[slug] = plane_id
        else:
            stats.unchanged_entries += 1

    stats.preserved_entries = sum(
        1 for s in existing_issue_map if s not in fresh_map
    )
    stats.map_size_after = len(merged)

    # Build a sample of NEW entries for the summary (up to 5). The
    # operator compares these to current vault filenames to spot drift.
    sample_slugs = [s for s in fresh_map if s not in existing_issue_map][:5]
    stats.samples = [{"slug": s, "plane_id": fresh_map[s]} for s in sample_slugs]

    if args.dry_run:
        logger.info(
            "rebuild_plane_issue_map: DRY-RUN — cursor NOT written. "
            "Would grow issue_map from %d → %d (+%d new, ~%d updated).",
            stats.map_size_before,
            stats.map_size_after,
            stats.new_entries,
            stats.updated_entries,
        )
    else:
        # Write cursor atomically, preserving every other field.
        out = {
            "last_vault_mtime": last_vault_mtime,
            "project_map": project_map,
            "issue_map": merged,
        }
        payload = json.dumps(out, indent=2, sort_keys=True)
        _atomic_write(path, payload)
        logger.info(
            "rebuild_plane_issue_map: cursor written path=%s issue_map=%d (+%d new, %d updated, %d preserved)",
            path, stats.map_size_after, stats.new_entries,
            stats.updated_entries, stats.preserved_entries,
        )

    stats.finished_at = time.time()
    _print_summary(args, stats, dry_run=args.dry_run)
    return stats


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------


def _print_summary(
    args: argparse.Namespace,
    stats: RebuildStats,
    *,
    dry_run: bool,
) -> None:
    runtime = stats.finished_at - stats.started_at
    print("\n" + "=" * 72)
    print("REBUILD PLANE ISSUE MAP — SUMMARY")
    print("=" * 72)
    print(f"tenant:                 {args.tenant_id or '(unspecified)'}")
    print(f"mode:                   {'DRY-RUN' if dry_run else 'LIVE'}")
    print(f"projects in map:        {stats.projects_total}")
    print(f"projects scanned:       {stats.projects_scanned}")
    print(f"projects errored:       {stats.projects_errored}")
    print(f"issues scanned:         {stats.issues_scanned}")
    print(f"alfred-stamped issues:  {stats.alfred_stamped}")
    print(f"unstamped issues:       {stats.unstamped}")
    print(f"duplicates collapsed:   {stats.duplicates_collapsed}")
    print(f"issue_map size before:  {stats.map_size_before}")
    print(f"issue_map size after:   {stats.map_size_after}")
    print(f"  new entries added:    {stats.new_entries}")
    print(f"  existing updated:     {stats.updated_entries}")
    print(f"  existing unchanged:   {stats.unchanged_entries}")
    print(f"  preserved (no match): {stats.preserved_entries}")
    print(f"runtime:                {runtime:0.1f}s")
    if stats.samples:
        print("\nsample of new entries (up to 5):")
        for s in stats.samples:
            print(f"  {s['slug']} -> {s['plane_id']}")
    if stats.error_messages:
        print("\nfirst 5 errors:")
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
        print("\nrebuild_plane_issue_map: interrupted", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001 — top-level, non-zero exit
        logger.exception("rebuild_plane_issue_map: failed: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
