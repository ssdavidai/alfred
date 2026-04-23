"""Backfill `related_matters` on every orphan vault task via a clerk LLM pass.

After this runs, the ``plane_sync`` forward workflow will route tasks
to their real matter-projects instead of dumping them all in Inbox.

The regular ``HourlyEnrichmentWorkflow`` (PR #395) takes hours to chew
through a big backlog — this script forces the pass for ALL pending
tasks in one shot.

USAGE
-----

Runs inside the ``alfred-learn`` container (needs gateway-token file,
``AAS_API_KEY`` env, access to openclaw via service DNS)::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.backfill_task_matter_linkage [flags]

Flags::

    --tenant-id <id>          Optional, for logging/summary only.
    --batch-size 20           Tasks per clerk call (default 20).
    --max-batches 200         Safety cap (default 200 → up to ~4000 tasks).
    --dry-run                 Simulate everything (clerk included); write nothing.
    --only-missing-matter     Only target tasks with no related_matters (default True).
    --include-all             Override --only-missing-matter (re-assign everything).
    --since YYYY-MM-DD        Skip tasks created before this date.
    --min-confidence 0.6      Confidence threshold for assignment (default 0.6).
    --sleep-between 1.0       Seconds to sleep between batches (default 1.0).
    --verbose                 Verbose logging.

FLOW
----

1. Fetch matter catalog via ctrl-api (``GET /api/v1/vault/list/matter``).
2. Fetch task catalog via ctrl-api (``GET /api/v1/vault/list/task``).
3. Filter to orphans (empty ``related_matters``) + optional date filter.
4. Sort tasks newest-first (freshest context to the model first).
5. For each batch:
    a. Read full body for each task (the listing only includes preview).
    b. Build the clerk prompt (matter catalog + task summaries).
    c. Dispatch one clerk call via the existing subagent pipeline.
    d. Parse ``{"assignments": [...]}``. For each assignment with
       ``confidence >= min_confidence`` AND non-null matter:
         - PATCH vault: append ``matter/<slug>.md`` to ``related_matters``
         - Set ``enrichment_status: enriched``
    e. Sleep ``--sleep-between``.
6. Print per-matter count table + run stats at the end.

Rate-limited: ``asyncio.sleep(1)`` between batches, exponential backoff
up to 3 attempts on gateway errors.

Writes only via ctrl-api PATCH. Never direct filesystem.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx

# The clerk helpers are activity defs, but `_call_clerk` is a plain async
# function we can invoke outside any Temporal worker context.
from src.activities.clerk import _call_clerk
from src.config import load_config

logger = logging.getLogger("backfill-task-matter")


# -----------------------------------------------------------------------------
# CLI parsing
# -----------------------------------------------------------------------------


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="backfill_task_matter_linkage",
        description="One-shot backfill of related_matters on orphan vault tasks.",
    )
    p.add_argument("--tenant-id", default=os.environ.get("TENANT_ID", ""),
                   help="Optional tenant identifier (logging only).")
    p.add_argument("--batch-size", type=int, default=20,
                   help="Tasks per clerk call (default 20).")
    p.add_argument("--max-batches", type=int, default=200,
                   help="Safety cap on total batches (default 200).")
    p.add_argument("--dry-run", action="store_true",
                   help="Simulate the full pipeline (clerk included) but write nothing.")
    p.add_argument("--include-all", action="store_true",
                   help="Include tasks that already have related_matters.")
    p.add_argument("--since", default="",
                   help="YYYY-MM-DD cutoff; skip tasks older than this.")
    p.add_argument("--min-confidence", type=float, default=0.6,
                   help="Confidence floor for accepting an assignment (default 0.6).")
    p.add_argument("--sleep-between", type=float, default=1.0,
                   help="Seconds to sleep between batches (default 1.0).")
    p.add_argument("--verbose", action="store_true", help="Verbose logging.")
    return p.parse_args(argv)


# -----------------------------------------------------------------------------
# ctrl-api helpers — thin wrapper so we can PATCH `append` (which VaultClient
# doesn't expose). All calls use the AAS_API_KEY bearer.
# -----------------------------------------------------------------------------


class CtrlClient:
    """Minimal async client for ctrl-api vault endpoints we need here."""

    def __init__(self) -> None:
        config = load_config()
        api_key = os.environ.get("AAS_API_KEY", "")
        if not api_key:
            raise RuntimeError(
                "AAS_API_KEY is not set — this script must run inside the "
                "alfred-learn container (or with env exported).",
            )
        self._client = httpx.AsyncClient(
            base_url=config.alfred_ctrl_url,
            timeout=30.0,
            headers={"Authorization": f"Bearer {api_key}"},
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def list_records(self, record_type: str) -> list[dict[str, Any]]:
        resp = await self._client.get(f"/api/v1/vault/list/{record_type}")
        resp.raise_for_status()
        return resp.json().get("results", [])

    async def read_record(self, path: str) -> dict[str, Any]:
        resp = await self._client.get(f"/api/v1/vault/records/{path}")
        resp.raise_for_status()
        return resp.json()

    async def patch_record(
        self,
        path: str,
        *,
        set_fields: dict[str, Any] | None = None,
        append_fields: dict[str, Any] | None = None,
    ) -> None:
        """Dispatches to ctrl-api's ``PATCH /api/v1/vault/records/*`` endpoint.

        ``set_fields`` → forwarded as ``{"set": {...}}`` (serialized as strings).
        ``append_fields`` → forwarded as ``{"append": {...}}`` (appends to
        list-valued frontmatter fields).
        """
        body: dict[str, Any] = {}
        if set_fields:
            body["set"] = {k: _stringify(v) for k, v in set_fields.items()}
        if append_fields:
            body["append"] = {k: _stringify(v) for k, v in append_fields.items()}
        if not body:
            return
        resp = await self._client.patch(f"/api/v1/vault/records/{path}", json=body)
        resp.raise_for_status()


def _stringify(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return ""
    return str(v)


# -----------------------------------------------------------------------------
# Prompt construction
# -----------------------------------------------------------------------------


# Per-task body cap — tasks with tens of kilobytes of body (rare, but
# auto-from-enrichment tasks sometimes inline long event excerpts) would
# blow the clerk's input budget. 800 chars is enough to capture the
# action plus any disambiguating text.
MAX_BODY_CHARS_PER_TASK = 800

# Per-matter preview cap — prompt stays tight even on tenants with 30+
# matter records. The matter title plus the first ~200 chars of the body
# is more than enough for disambiguation.
MAX_MATTER_PREVIEW_CHARS = 200


def _build_matter_block(matters: list[dict[str, Any]]) -> str:
    lines = ["Sir's active matters (pick the best-fit `slug` for each task, or null):"]
    for m in matters:
        line = f"- `{m['slug']}`: {m['title']}"
        preview = m.get("preview", "")
        if preview:
            line += f" — {preview}"
        lines.append(line)
    return "\n".join(lines)


def _build_task_block(tasks: list[dict[str, Any]]) -> str:
    lines = []
    for t in tasks:
        name = t.get("name") or t.get("slug") or "(unnamed)"
        desc = (t.get("body") or "").strip()
        if not desc:
            desc = "(no description)"
        desc = desc[:MAX_BODY_CHARS_PER_TASK]
        lines.append(f"- `{t['slug']}`: {name}")
        lines.append(f"  Description: {desc}")
    return "\n".join(lines)


def _build_prompt(matters: list[dict[str, Any]], tasks: list[dict[str, Any]]) -> str:
    matter_block = _build_matter_block(matters)
    task_block = _build_task_block(tasks)
    return f"""You are Alfred's clerk. Assign each task below to its most relevant matter from Sir's active matters, OR return null if no matter fits well.

Active matters:
{matter_block}

Tasks to assign:
{task_block}

Respond with JSON only, no preamble. Schema:
{{
  "assignments": [
    {{"slug": "<task-slug>", "matter": "<matter-slug>" | null, "reason": "<1-sentence rationale>", "confidence": 0.0-1.0}}
  ]
}}

Guidelines:
- Only assign a matter when the task is clearly about that matter. Err on the side of null for ambiguous cases.
- Match by topic/entity overlap: "Family Life" if the task is about Hanna or family logistics; "Household Cash Flow" if it's about a specific bill or payment; "Kondorosi Apartment Sale" if it mentions the apartment.
- Use the EXACT slug from the matter list — not a description, not an invented slug.
- One matter per task (the single best fit). Return null if no matter fits confidently.
"""


# -----------------------------------------------------------------------------
# Core backfill loop
# -----------------------------------------------------------------------------


@dataclass
class BackfillStats:
    tasks_examined: int = 0
    tasks_batched: int = 0
    clerk_calls: int = 0
    clerk_failures: int = 0
    assigned: int = 0
    skipped_low_confidence: int = 0
    skipped_no_match: int = 0
    skipped_unknown_matter: int = 0
    skipped_parse_failure: int = 0
    write_errors: int = 0
    per_matter_counts: Counter = field(default_factory=Counter)
    started_at: float = 0.0
    finished_at: float = 0.0


async def _call_clerk_with_retries(prompt: str, stats: BackfillStats) -> dict[str, Any] | list | None:
    """Call clerk with exponential backoff on gateway errors. Returns None on
    final failure (caller logs + moves on to the next batch)."""
    backoff = 2.0
    for attempt in range(3):
        try:
            stats.clerk_calls += 1
            return await _call_clerk(prompt)
        except (httpx.HTTPError, TimeoutError, RuntimeError, ValueError) as exc:
            msg = str(exc)[:160]
            logger.warning("backfill: clerk attempt %d/3 failed: %s", attempt + 1, msg)
            if attempt == 2:
                stats.clerk_failures += 1
                return None
            await asyncio.sleep(backoff)
            backoff *= 2
    return None


def _parse_assignments(raw: Any) -> list[dict[str, Any]]:
    """Tolerant parsing of the clerk's assignments array."""
    if isinstance(raw, dict):
        items = raw.get("assignments")
        if isinstance(items, list):
            return [i for i in items if isinstance(i, dict)]
        # Some models return the array at the top level without the wrapper
        for key in ("results", "data", "items"):
            alt = raw.get(key)
            if isinstance(alt, list):
                return [i for i in alt if isinstance(i, dict)]
        return []
    if isinstance(raw, list):
        return [i for i in raw if isinstance(i, dict)]
    return []


def _normalize_matter_slug(value: str, known_slugs: set[str]) -> str | None:
    """Map whatever the clerk returned onto a real ``matter/<slug>.md`` path.

    The clerk is instructed to return a bare slug but models sometimes
    return the full path, a wikilink, or drop the ``.md`` suffix. Handle
    all cases; return None if we can't match to a known matter.
    """
    if not value or not isinstance(value, str):
        return None
    s = value.strip().strip("[").strip("]").strip("`")
    # Strip wikilink form
    if s.startswith("matter/"):
        s = s[len("matter/"):]
    s = s.removesuffix(".md")
    if s in known_slugs:
        return f"matter/{s}.md"
    # Case-insensitive fallback
    lower_map = {k.lower(): k for k in known_slugs}
    if s.lower() in lower_map:
        return f"matter/{lower_map[s.lower()]}.md"
    return None


async def _load_matter_catalog(ctrl: CtrlClient) -> list[dict[str, Any]]:
    """Read the tenant's active matters, return [{slug, title, preview}, ...]."""
    records = await ctrl.list_records("matter")
    catalog: list[dict[str, Any]] = []
    for r in records:
        path = r.get("path", "")
        if not path.startswith("matter/") or not path.endswith(".md"):
            continue
        fm = r.get("frontmatter") or {}
        status = fm.get("status")
        if status and status not in ("active", None):
            continue
        slug = path.removeprefix("matter/").removesuffix(".md")
        title = fm.get("name") or r.get("name") or slug
        body = r.get("body_preview") or r.get("body") or ""
        # Keep the first non-empty line as a disambiguator.
        preview_line = ""
        for line in body.splitlines():
            stripped = line.strip()
            if stripped:
                preview_line = stripped
                break
        catalog.append({
            "path": path,
            "slug": slug,
            "title": str(title)[:80],
            "preview": preview_line[:MAX_MATTER_PREVIEW_CHARS],
        })
    catalog.sort(key=lambda m: m["slug"])
    return catalog


def _extract_task_slug(path: str) -> str:
    return path.removeprefix("task/").removesuffix(".md")


def _has_related_matters(fm: dict[str, Any]) -> bool:
    rm = fm.get("related_matters")
    if isinstance(rm, list):
        return any(isinstance(x, str) and x.strip() for x in rm)
    if isinstance(rm, str):
        return bool(rm.strip())
    return False


async def _load_candidate_tasks(
    ctrl: CtrlClient,
    *,
    include_all: bool,
    since: str,
) -> list[dict[str, Any]]:
    """Fetch task list, filter orphans + --since, sort newest-first."""
    records = await ctrl.list_records("task")
    since_dt: datetime | None = None
    if since:
        try:
            since_dt = datetime.strptime(since, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            logger.warning("backfill: --since %r is not YYYY-MM-DD, ignoring", since)

    candidates: list[dict[str, Any]] = []
    for r in records:
        path = r.get("path", "")
        if not path.startswith("task/") or not path.endswith(".md"):
            continue
        fm = r.get("frontmatter") or {}
        if not include_all and _has_related_matters(fm):
            continue
        created_str = fm.get("created") or r.get("created") or ""
        created_dt = _parse_iso_ts(created_str)
        if since_dt and created_dt and created_dt < since_dt:
            continue
        candidates.append({
            "path": path,
            "slug": _extract_task_slug(path),
            "name": fm.get("name") or r.get("name") or "",
            "created": created_str,
            "_created_dt": created_dt,
            "current_related_matters": fm.get("related_matters") or [],
            "current_enrichment_status": fm.get("enrichment_status") or "",
        })
    # Newest first
    candidates.sort(key=lambda t: t["_created_dt"] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    for t in candidates:
        t.pop("_created_dt", None)
    return candidates


def _parse_iso_ts(s: str) -> datetime | None:
    if not s:
        return None
    # Python <3.11 can't handle spaces between date and time; be tolerant.
    t = s.strip().replace(" ", "T", 1)
    # Trim fractional precision > 6 digits (Python limit)
    m = re.match(r"^(?P<base>.*?\.\d{1,6})\d*(?P<tz>[+\-Z].*)?$", t)
    if m:
        t = m.group("base") + (m.group("tz") or "")
    try:
        dt = datetime.fromisoformat(t.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


async def _hydrate_bodies(ctrl: CtrlClient, tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Re-fetch body content for a batch of tasks (listing only gives preview)."""
    hydrated: list[dict[str, Any]] = []
    for t in tasks:
        try:
            raw = await ctrl.read_record(t["path"])
        except Exception as exc:
            logger.warning("backfill: read %s failed: %s", t["path"], exc)
            continue
        body = raw.get("body", "") or ""
        hydrated.append({**t, "body": body})
    return hydrated


async def _get_clerk_model(ctrl: CtrlClient) -> str:
    """Best-effort fetch of the model the clerk subagent runs on.

    Hits the ctrl-api agents route if it exists, otherwise returns "unknown".
    Used for the summary printout — never load-bearing.
    """
    try:
        resp = await ctrl._client.get("/api/v1/agents")
        if resp.status_code == 200:
            data = resp.json()
            agents = data if isinstance(data, list) else data.get("agents", [])
            for a in agents:
                # Look at the subagents default — that's where clerk calls go.
                if a.get("id") == "learn-clerk":
                    model = a.get("model", {})
                    if isinstance(model, dict):
                        return model.get("primary", "unknown")
                    if isinstance(model, str):
                        return model
            # Fall through — try defaults
    except Exception:
        pass
    try:
        resp = await ctrl._client.get("/api/v1/agents/defaults")
        if resp.status_code == 200:
            data = resp.json()
            return (data.get("subagents") or {}).get("model", "unknown") or "unknown"
    except Exception:
        pass
    return "unknown"


async def _process_batch(
    ctrl: CtrlClient,
    matters: list[dict[str, Any]],
    batch: list[dict[str, Any]],
    *,
    dry_run: bool,
    min_confidence: float,
    known_slugs: set[str],
    stats: BackfillStats,
    batch_num: int,
    total_batches: int,
) -> None:
    # 1. Hydrate bodies
    hydrated = await _hydrate_bodies(ctrl, batch)
    if not hydrated:
        return

    # 2. Build prompt + call clerk
    prompt = _build_prompt(matters, hydrated)
    logger.info(
        "backfill: batch %d/%d → %d tasks (prompt ~%d chars)",
        batch_num, total_batches, len(hydrated), len(prompt),
    )
    raw = await _call_clerk_with_retries(prompt, stats)
    if raw is None:
        stats.skipped_parse_failure += len(hydrated)
        return

    assignments = _parse_assignments(raw)
    if not assignments:
        logger.warning(
            "backfill: batch %d — clerk returned no parseable assignments (keys=%s)",
            batch_num,
            list(raw.keys()) if isinstance(raw, dict) else type(raw).__name__,
        )
        stats.skipped_parse_failure += len(hydrated)
        return

    # 3. Index slugs in the batch so we can map assignment → path
    slug_to_task = {t["slug"]: t for t in hydrated}

    batch_assigned = 0
    batch_skipped = 0
    for assn in assignments:
        task_slug = assn.get("slug")
        if not isinstance(task_slug, str) or task_slug not in slug_to_task:
            continue
        matter_raw = assn.get("matter")
        try:
            conf = float(assn.get("confidence", 0.0))
        except (TypeError, ValueError):
            conf = 0.0
        reason = (assn.get("reason") or "").strip()[:120]
        t = slug_to_task[task_slug]

        if matter_raw is None:
            stats.skipped_no_match += 1
            batch_skipped += 1
            logger.debug("backfill: %s → no_match (%s)", task_slug, reason)
            continue

        if conf < min_confidence:
            stats.skipped_low_confidence += 1
            batch_skipped += 1
            logger.debug("backfill: %s → low_confidence=%.2f (%s)", task_slug, conf, reason)
            continue

        matter_path = _normalize_matter_slug(str(matter_raw), known_slugs)
        if matter_path is None:
            stats.skipped_unknown_matter += 1
            batch_skipped += 1
            logger.warning(
                "backfill: %s → unknown_matter=%r (%s)", task_slug, matter_raw, reason,
            )
            continue

        stats.assigned += 1
        stats.per_matter_counts[matter_path] += 1
        batch_assigned += 1

        if dry_run:
            logger.info(
                "DRY-RUN: would assign task %s → %s (conf=%.2f) :: %s",
                task_slug, matter_path, conf, reason,
            )
            continue

        # 4. Write: append to related_matters + mark enriched.
        set_map: dict[str, Any] = {}
        if t["current_enrichment_status"] == "pending":
            set_map["enrichment_status"] = "enriched"

        try:
            await ctrl.patch_record(
                t["path"],
                set_fields=set_map or None,
                append_fields={"related_matters": matter_path},
            )
        except Exception as exc:
            stats.write_errors += 1
            logger.warning("backfill: PATCH %s failed: %s", t["path"], exc)

    logger.info(
        "backfill: batch %d/%d — assigned=%d, skipped=%d",
        batch_num, total_batches, batch_assigned, batch_skipped,
    )


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------


async def _run(args: argparse.Namespace) -> BackfillStats:
    stats = BackfillStats()
    stats.started_at = time.time()

    ctrl = CtrlClient()
    try:
        # 1. Load matter catalog
        matters = await _load_matter_catalog(ctrl)
        if not matters:
            logger.error("backfill: no active matters found — aborting")
            return stats
        known_slugs = {m["slug"] for m in matters}
        logger.info(
            "backfill: tenant=%s, matters=%d, dry_run=%s, batch_size=%d",
            args.tenant_id or "(unspecified)",
            len(matters), args.dry_run, args.batch_size,
        )
        for m in matters:
            logger.info("  matter: %s — %s", m["slug"], m["title"])

        clerk_model = await _get_clerk_model(ctrl)
        logger.info("backfill: clerk model = %s", clerk_model)

        # 2. Load candidate tasks
        tasks = await _load_candidate_tasks(
            ctrl,
            include_all=args.include_all,
            since=args.since,
        )
        stats.tasks_examined = len(tasks)
        if not tasks:
            logger.info("backfill: no candidate tasks — nothing to do.")
            return stats

        batch_size = max(1, args.batch_size)
        total_batches = (len(tasks) + batch_size - 1) // batch_size
        total_batches = min(total_batches, args.max_batches)
        logger.info(
            "backfill: %d candidate tasks → %d batches of %d",
            len(tasks), total_batches, batch_size,
        )

        # 3. Process batches
        for batch_num in range(1, total_batches + 1):
            start = (batch_num - 1) * batch_size
            batch = tasks[start : start + batch_size]
            if not batch:
                break
            stats.tasks_batched += len(batch)
            await _process_batch(
                ctrl, matters, batch,
                dry_run=args.dry_run,
                min_confidence=args.min_confidence,
                known_slugs=known_slugs,
                stats=stats,
                batch_num=batch_num,
                total_batches=total_batches,
            )
            if batch_num < total_batches:
                await asyncio.sleep(args.sleep_between)
    finally:
        await ctrl.close()

    stats.finished_at = time.time()
    _print_summary(args, stats, clerk_model=clerk_model)
    return stats


def _print_summary(
    args: argparse.Namespace,
    stats: BackfillStats,
    *,
    clerk_model: str,
) -> None:
    runtime = stats.finished_at - stats.started_at
    print("\n" + "=" * 72)
    print("BACKFILL SUMMARY")
    print("=" * 72)
    print(f"tenant:               {args.tenant_id or '(unspecified)'}")
    print(f"mode:                 {'DRY-RUN' if args.dry_run else 'LIVE'}")
    print(f"clerk model:          {clerk_model}")
    print(f"min confidence:       {args.min_confidence}")
    print(f"batch size:           {args.batch_size}")
    print(f"max batches:          {args.max_batches}")
    print(f"tasks examined:       {stats.tasks_examined}")
    print(f"tasks sent to clerk:  {stats.tasks_batched}")
    print(f"clerk calls:          {stats.clerk_calls}")
    print(f"clerk failures:       {stats.clerk_failures}")
    print(f"assignments made:     {stats.assigned}")
    print(f"  skipped low_conf:   {stats.skipped_low_confidence}")
    print(f"  skipped no_match:   {stats.skipped_no_match}")
    print(f"  skipped unknown:    {stats.skipped_unknown_matter}")
    print(f"  skipped parse_err:  {stats.skipped_parse_failure}")
    print(f"write errors:         {stats.write_errors}")
    print(f"runtime:              {runtime:0.1f}s")

    if stats.per_matter_counts:
        print("\nper-matter assignment counts:")
        for matter_path, count in stats.per_matter_counts.most_common():
            print(f"  {count:4d}  {matter_path}")
    print("=" * 72)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        asyncio.run(_run(args))
    except KeyboardInterrupt:
        print("\nbackfill: interrupted", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001 — top-level, we want a non-zero exit
        logger.exception("backfill: failed: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
