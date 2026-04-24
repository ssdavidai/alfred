"""Backfill rich, context-aware ``description`` on every vault task via clerk.

Today most tasks land in the vault with no ``description`` frontmatter — or
with a one-line summary that's just the task name restated. When ``plane_sync``
renders the task as a Plane issue it falls back to ``body``, and most tasks
have no body, so Plane shows ``<p></p>``. A human opening the issue sees
nothing beyond the task name.

This script sweeps every candidate task, assembles the full context around it
(the matter it belongs to, the people + orgs involved, the source email /
calendar event that spawned it), and asks the clerk to write a 2-5 sentence
description that actually explains the task. The ``description`` frontmatter
is then PATCHed onto the record, which — via the plane_sync forward cursor —
propagates to Plane on the next tick.

USAGE
-----

Runs inside the ``alfred-learn`` container (needs gateway-token file,
``AAS_API_KEY`` env, access to openclaw via service DNS)::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.backfill_task_descriptions [flags]

Flags::

    --tenant-id <id>          Optional, for logging/summary only.
    --batch-size 10           Heartbeat cadence (tasks processed sequentially
                              between log flushes). NOT an LLM batch size —
                              each task is a dedicated clerk call.
    --max-batches 200         Safety cap on total batches (default 200).
    --dry-run                 Simulate everything; write nothing to the vault.
    --min-existing-chars 80   Skip tasks whose description already has ≥ N chars.
    --skip-archived           Skip archived tasks (default True).
    --only-linked             Only process tasks with related_matters[0]
                              (default True — tasks without a matter get
                              routed to Inbox anyway and aren't the
                              load-bearing case).
    --include-all             Negates --only-linked (process every task).
    --verbose                 Verbose logging.

FLOW
----

1. Fetch matter catalog via ctrl-api (``GET /api/v1/vault/list/matter``).
2. Fetch task catalog via ctrl-api (``GET /api/v1/vault/list/task``).
3. Apply filters (archived / agent-managed / only-linked /
   min-existing-chars) — see ``_filter_candidates``.
4. Sort newest-first so fresh tasks land in Plane first.
5. For each task:
    a. Read full body + frontmatter via ctrl-api.
    b. If linked to a matter, read matter record for title + body preview.
    c. If a ``source_event`` is present, read that event record for
       name + body preview.
    d. Build a per-task prompt + dispatch one clerk call.
    e. Parse ``{"description": "..."}``. If the clerk declined to write
       one (e.g. not enough context), skip quietly.
    f. PATCH vault: ``{"set": {"description": "...", "updated": "<now>"}}``.
       The ``updated`` bump is deliberate — it advances the task past the
       plane_sync cursor so forward-sync picks it up on the next tick.
6. Print a summary table at the end.

Rate-limited: ``asyncio.sleep(1)`` between tasks, exponential backoff up
to 3 attempts on gateway errors.

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

logger = logging.getLogger("backfill-task-desc")


# -----------------------------------------------------------------------------
# CLI parsing
# -----------------------------------------------------------------------------


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="backfill_task_descriptions",
        description="Enrich vault task descriptions with context-aware clerk output.",
    )
    p.add_argument("--tenant-id", default=os.environ.get("TENANT_ID", ""),
                   help="Optional tenant identifier (logging only).")
    p.add_argument("--batch-size", type=int, default=10,
                   help="Heartbeat cadence in tasks-per-log (default 10). "
                        "Tasks are processed one clerk call at a time; this "
                        "only controls when the script emits a progress log.")
    p.add_argument("--max-batches", type=int, default=200,
                   help="Safety cap on total batches (default 200).")
    p.add_argument("--dry-run", action="store_true",
                   help="Simulate the full pipeline (clerk included) but write nothing.")
    p.add_argument("--min-existing-chars", type=int, default=80,
                   help="Skip tasks with existing description ≥ N chars (default 80).")
    p.add_argument("--skip-archived", dest="skip_archived", action="store_true", default=True,
                   help="Skip archived tasks (default True).")
    p.add_argument("--include-archived", dest="skip_archived", action="store_false",
                   help="Include archived tasks (default: skip).")
    p.add_argument("--only-linked", dest="only_linked", action="store_true", default=True,
                   help="Only process tasks with related_matters[0] (default True).")
    p.add_argument("--include-all", dest="only_linked", action="store_false",
                   help="Include tasks with no matter link.")
    p.add_argument("--sleep-between", type=float, default=1.0,
                   help="Seconds to sleep between clerk calls (default 1.0).")
    p.add_argument("--verbose", action="store_true", help="Verbose logging.")
    return p.parse_args(argv)


# -----------------------------------------------------------------------------
# ctrl-api thin client — mirrors the one in backfill_task_matter_linkage.py
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

    async def read_record(self, path: str) -> dict[str, Any] | None:
        """Read a single record. Returns None on 404 so callers can no-op
        gracefully when a related matter/event has since been archived."""
        try:
            resp = await self._client.get(f"/api/v1/vault/records/{path}")
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return None
            raise

    async def patch_record(
        self,
        path: str,
        *,
        set_fields: dict[str, Any] | None = None,
    ) -> None:
        """Dispatches to ctrl-api's ``PATCH /api/v1/vault/records/*`` endpoint.

        ``set_fields`` → forwarded as ``{"set": {...}}`` (serialized as strings).
        """
        body: dict[str, Any] = {}
        if set_fields:
            body["set"] = {k: _stringify(v) for k, v in set_fields.items()}
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


# Per-source-event body cap — most emails are under 500 chars of readable
# text once the quoted history is stripped, but calendar events can carry
# long descriptions. Cap at 400 to keep the prompt tight.
MAX_SOURCE_EVENT_BODY = 400

# Per-matter body cap — matter descriptions average ~2 KB; 500 chars is
# enough to convey what the matter is about without bloating the prompt.
MAX_MATTER_BODY = 500

# Per-task existing body cap — tasks rarely carry long bodies but a handful
# of auto-generated ones inline full event excerpts.
MAX_TASK_BODY = 500

# Description length guardrails for the clerk's output.
DESC_MIN_CHARS = 40
DESC_MAX_CHARS = 500

# Task statuses the vault schema REJECTS on edit. Legacy tasks (curator
# output from pre-schema-tightening) commonly carry `status: pending`,
# which ANY edit would bounce with `_validate_status`. We coerce such
# tasks to `todo` inside the same PATCH so our description can land.
# Same pattern as backfill_task_matter_linkage.py.
_VALID_TASK_STATUSES = frozenset({"active", "blocked", "cancelled", "done", "todo"})


def _safe_body_preview(record: dict[str, Any] | None, cap: int) -> str:
    """Return a trimmed body preview for a record, or empty string."""
    if not record:
        return ""
    body = record.get("body") or record.get("body_preview") or ""
    if not isinstance(body, str):
        return ""
    # Drop a leading markdown heading the curator often emits.
    body = re.sub(r"^\s*#\s+.+?\n+", "", body, count=1)
    # Collapse whitespace for prompt compactness.
    body = re.sub(r"\s+", " ", body).strip()
    return body[:cap]


def _format_list(items: Any, cap: int = 3) -> str:
    if not isinstance(items, list):
        return ""
    cleaned: list[str] = []
    for x in items[:cap]:
        if not isinstance(x, str):
            continue
        # Strip person/*, org/* path prefixes + .md suffix for readability.
        slug = x.strip()
        for prefix in ("person/", "org/", "matter/", "event/"):
            if slug.startswith(prefix):
                slug = slug[len(prefix):]
        slug = slug.removesuffix(".md")
        slug = slug.replace("-", " ").replace("_", " ").strip()
        if slug:
            cleaned.append(slug)
    return ", ".join(cleaned)


def _build_prompt(ctx: dict[str, Any]) -> str:
    """Build the per-task clerk prompt.

    ``ctx`` is the hydrated context bundle assembled by ``_hydrate_task``.
    """
    name = ctx["name"] or "(unnamed)"
    matter_slug = ctx.get("matter_slug") or ""
    matter_title = ctx.get("matter_title") or ""
    matter_body = ctx.get("matter_body") or ""
    persons = ctx.get("related_persons_str") or ""
    orgs = ctx.get("related_orgs_str") or ""
    source_event_name = ctx.get("source_event_name") or ""
    source_event_body = ctx.get("source_event_body") or ""
    priority = ctx.get("priority") or ""
    due_date = ctx.get("due_date") or ""
    body = ctx.get("task_body") or ""

    return f"""You are Alfred's clerk. Write a short description (2-5 sentences, 80-400 characters) for the task below, written as if explaining it to a colleague who just opened the task in a project management tool and wants to know what it is + why it matters.

Guidelines:
- Start with what the task IS in plain language (not "do X" — describe the situation and what Sir needs to act on).
- If it traces back to a specific email/calendar event, paraphrase the source in one sentence.
- If it ties to a matter (project), mention the matter's role in Sir's life (from the matter description).
- Mention the key person(s) or org(s) involved if present.
- Tone: factual, concise, butler-grade. No "As an AI...", no filler.
- DO NOT restate the task name verbatim in the first sentence.
- If the task is obviously auto-generated with no useful context (e.g. "Confirm 2FA code" with no other info), return a terse 1-sentence description — don't invent context.

Input:
- Task name: {name}
- Matter: {matter_slug} — {matter_title}
- Matter context: {matter_body}
- Related persons: {persons}
- Related orgs: {orgs}
- Source event: {source_event_name} — {source_event_body}
- Priority: {priority}, due: {due_date}
- Existing body: {body}

Respond with JSON only, no preamble:
{{"description": "<2-5 sentence description here>"}}
"""


# -----------------------------------------------------------------------------
# Filtering + hydration
# -----------------------------------------------------------------------------


def _extract_task_slug(path: str) -> str:
    return path.removeprefix("task/").removesuffix(".md")


def _parse_iso_ts(s: str) -> datetime | None:
    if not s:
        return None
    t = s.strip().replace(" ", "T", 1)
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


def _fm_as_str(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _first_matter_ref(fm: dict[str, Any]) -> str:
    """Return the first related_matters ref (matter/<slug>.md) or empty."""
    rm = fm.get("related_matters")
    if isinstance(rm, list):
        for x in rm:
            if isinstance(x, str) and x.strip():
                return x.strip()
    if isinstance(rm, str) and rm.strip():
        return rm.strip()
    return ""


def _first_source_event(fm: dict[str, Any]) -> str:
    """Return source_event ref if any (can live under several keys)."""
    for key in ("source_event", "source", "related_event"):
        v = fm.get(key)
        if isinstance(v, str) and v.strip():
            s = v.strip()
            # Normalize to path form if it's just a slug
            if not s.startswith("event/") and not s.endswith(".md"):
                s = f"event/{s}.md"
            return s
        if isinstance(v, list):
            for x in v:
                if isinstance(x, str) and x.strip():
                    s = x.strip()
                    if not s.startswith("event/") and not s.endswith(".md"):
                        s = f"event/{s}.md"
                    return s
    return ""


def _filter_candidates(
    records: list[dict[str, Any]],
    *,
    skip_archived: bool,
    only_linked: bool,
    min_existing_chars: int,
) -> list[dict[str, Any]]:
    """Apply the spec's filter chain, newest-first."""
    candidates: list[dict[str, Any]] = []
    for r in records:
        path = r.get("path", "")
        if not path.startswith("task/") or not path.endswith(".md"):
            continue
        fm = r.get("frontmatter") or {}

        # 1. Skip archived
        if skip_archived:
            archived = fm.get("archived")
            if archived in (True, "true", "True", 1, "1"):
                continue

        # 2. Skip agent-managed (has agent_id OR skill_entry)
        if _fm_as_str(fm.get("agent_id")).strip():
            continue
        if _fm_as_str(fm.get("skill_entry")).strip():
            continue

        # 3. Only-linked (default): must have at least one related matter
        if only_linked and not _first_matter_ref(fm):
            continue

        # 4. Min-existing-chars: skip tasks with already-rich descriptions
        existing_desc = _fm_as_str(fm.get("description")).strip()
        if len(existing_desc) >= min_existing_chars:
            continue

        created_str = _fm_as_str(fm.get("created")) or _fm_as_str(r.get("created"))
        created_dt = _parse_iso_ts(created_str)
        candidates.append({
            "path": path,
            "slug": _extract_task_slug(path),
            "name": _fm_as_str(fm.get("name") or r.get("name") or "").strip(),
            "created": created_str,
            "_created_dt": created_dt,
            "frontmatter": fm,
            "existing_description": existing_desc,
            "current_status": _fm_as_str(fm.get("status")).strip(),
            "body_preview": r.get("body_preview") or "",
        })

    candidates.sort(
        key=lambda t: t["_created_dt"] or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    for t in candidates:
        t.pop("_created_dt", None)
    return candidates


async def _hydrate_task(
    ctrl: CtrlClient,
    task: dict[str, Any],
    matter_cache: dict[str, dict[str, Any] | None],
    event_cache: dict[str, dict[str, Any] | None],
) -> dict[str, Any]:
    """Assemble the full per-task context bundle the prompt builder needs.

    Caches matter + event lookups — a single matter backs ~50 tasks on
    average so the cache avoids re-fetching the same record N times.
    """
    fm = task["frontmatter"]
    # Re-fetch the task for full body content (listing only carries preview)
    full = await ctrl.read_record(task["path"])
    body = ""
    if full:
        body = full.get("body", "") or ""
    body_clean = _safe_body_preview(
        {"body": body} if body else {"body": task.get("body_preview") or ""},
        MAX_TASK_BODY,
    )

    # --- Matter ---------------------------------------------------------------
    matter_ref = _first_matter_ref(fm)
    matter_slug = ""
    matter_title = ""
    matter_body = ""
    if matter_ref:
        # Normalize to full path
        matter_path = matter_ref
        if not matter_path.startswith("matter/"):
            matter_path = f"matter/{matter_path}"
        if not matter_path.endswith(".md"):
            matter_path = f"{matter_path}.md"
        matter_slug = matter_path.removeprefix("matter/").removesuffix(".md")
        if matter_path not in matter_cache:
            try:
                matter_cache[matter_path] = await ctrl.read_record(matter_path)
            except Exception as exc:
                logger.warning("hydrate: matter %s fetch failed: %s", matter_path, exc)
                matter_cache[matter_path] = None
        m = matter_cache.get(matter_path)
        if m:
            mfm = m.get("frontmatter") or {}
            matter_title = _fm_as_str(
                mfm.get("name") or mfm.get("title") or matter_slug
            )[:120]
            matter_body = _safe_body_preview(m, MAX_MATTER_BODY)

    # --- Source event ---------------------------------------------------------
    event_ref = _first_source_event(fm)
    event_name = ""
    event_body = ""
    if event_ref:
        if event_ref not in event_cache:
            try:
                event_cache[event_ref] = await ctrl.read_record(event_ref)
            except Exception as exc:
                logger.warning("hydrate: event %s fetch failed: %s", event_ref, exc)
                event_cache[event_ref] = None
        e = event_cache.get(event_ref)
        if e:
            efm = e.get("frontmatter") or {}
            event_name = _fm_as_str(
                efm.get("name") or efm.get("title") or e.get("name") or ""
            )[:120]
            event_body = _safe_body_preview(e, MAX_SOURCE_EVENT_BODY)

    # --- Persons / orgs -------------------------------------------------------
    persons_str = _format_list(fm.get("related_persons"), cap=3)
    orgs_str = _format_list(fm.get("related_orgs"), cap=3)

    # --- Priority / due -------------------------------------------------------
    priority = _fm_as_str(fm.get("priority")).strip()
    due_date = _fm_as_str(fm.get("due_date") or fm.get("due")).strip()

    return {
        "path": task["path"],
        "slug": task["slug"],
        "name": task["name"],
        "matter_slug": matter_slug,
        "matter_title": matter_title,
        "matter_body": matter_body,
        "related_persons_str": persons_str,
        "related_orgs_str": orgs_str,
        "source_event_name": event_name,
        "source_event_body": event_body,
        "priority": priority,
        "due_date": due_date,
        "task_body": body_clean,
    }


# -----------------------------------------------------------------------------
# Clerk call + output parsing
# -----------------------------------------------------------------------------


@dataclass
class BackfillStats:
    tasks_examined: int = 0
    tasks_attempted: int = 0
    clerk_calls: int = 0
    clerk_failures: int = 0
    enriched: int = 0
    skipped_existing: int = 0  # pre-filter: already rich
    skipped_archived: int = 0
    skipped_agent_managed: int = 0
    skipped_unlinked: int = 0
    skipped_parse_failure: int = 0
    skipped_empty_desc: int = 0  # clerk returned empty / too-short
    write_errors: int = 0
    samples: list[dict[str, str]] = field(default_factory=list)
    matter_counts: Counter = field(default_factory=Counter)
    started_at: float = 0.0
    finished_at: float = 0.0


async def _call_clerk_with_retries(prompt: str, stats: BackfillStats) -> Any | None:
    """Call clerk with exponential backoff on gateway errors. Returns None on
    final failure (caller logs + moves on to the next task)."""
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


def _parse_description(raw: Any) -> str:
    """Tolerant parsing of ``{"description": "..."}`` from the clerk."""
    if isinstance(raw, dict):
        for key in ("description", "desc", "summary", "content"):
            v = raw.get(key)
            if isinstance(v, str):
                return v.strip()
        return ""
    if isinstance(raw, str):
        return raw.strip()
    return ""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# -----------------------------------------------------------------------------
# Main backfill loop
# -----------------------------------------------------------------------------


async def _process_one(
    ctrl: CtrlClient,
    task: dict[str, Any],
    matter_cache: dict[str, dict[str, Any] | None],
    event_cache: dict[str, dict[str, Any] | None],
    *,
    dry_run: bool,
    stats: BackfillStats,
) -> None:
    stats.tasks_attempted += 1
    ctx = await _hydrate_task(ctrl, task, matter_cache, event_cache)
    prompt = _build_prompt(ctx)

    raw = await _call_clerk_with_retries(prompt, stats)
    if raw is None:
        stats.skipped_parse_failure += 1
        logger.info(
            "backfill: %s action=skip reason=clerk_error", task["slug"],
        )
        return

    desc = _parse_description(raw)
    if not desc:
        stats.skipped_parse_failure += 1
        logger.warning(
            "backfill: %s action=skip reason=no_description_in_response", task["slug"],
        )
        return

    # Clerk sometimes wraps prose in quotes / backticks; strip defensively.
    desc = desc.strip().strip('"').strip("'").strip("`").strip()
    # Collapse any stray newlines inside the description so it renders
    # cleanly in Plane's description_html (which maps \n → <br>).
    desc = re.sub(r"\n{3,}", "\n\n", desc).strip()

    if len(desc) < DESC_MIN_CHARS:
        # A terse single-sentence output is acceptable per the spec
        # ("intentionally terse"); only reject truly empty / 1-word replies.
        if len(desc) < 15:
            stats.skipped_empty_desc += 1
            logger.info(
                "backfill: %s action=skip reason=desc_too_short desc=%r",
                task["slug"], desc,
            )
            return

    # Hard-cap length so we don't blow up Plane's description field.
    if len(desc) > DESC_MAX_CHARS:
        desc = desc[:DESC_MAX_CHARS].rstrip() + "…"

    stats.enriched += 1
    if ctx.get("matter_slug"):
        stats.matter_counts[ctx["matter_slug"]] += 1

    # Keep a few samples for the summary printout.
    if len(stats.samples) < 20:
        stats.samples.append({
            "slug": task["slug"],
            "name": task["name"],
            "before": task.get("existing_description") or "(empty)",
            "after": desc,
            "matter": ctx.get("matter_slug") or "(unlinked)",
            "source_event": ctx.get("source_event_name") or "",
        })

    if dry_run:
        logger.info(
            "DRY-RUN: %s → desc (%d chars): %s",
            task["slug"], len(desc), desc[:120],
        )
        return

    # Atomic PATCH: {description, updated, [status]}
    # The `updated` bump is deliberate — plane_sync's forward cursor uses
    # max(updated, modified, created) as the task's mtime, so bumping it
    # guarantees the next forward-sync tick picks this task up and pushes
    # the new description_html to Plane.
    #
    # If the task carries a `status` value outside the vault schema's
    # allowed set (active/blocked/cancelled/done/todo) — the common
    # legacy case is `status: pending` — ANY edit would be rejected by
    # `_validate_status` on the vault side, so we coerce to `todo` in
    # the same PATCH. Matches the pattern in backfill_task_matter_linkage.py.
    set_map: dict[str, Any] = {
        "description": desc,
        "updated": _now_iso(),
    }
    current_status = (task.get("current_status") or "").strip()
    if current_status and current_status not in _VALID_TASK_STATUSES:
        set_map["status"] = "todo"
    try:
        await ctrl.patch_record(task["path"], set_fields=set_map)
    except Exception as exc:
        stats.write_errors += 1
        logger.warning("backfill: PATCH %s failed: %s", task["path"], exc)


async def _run(args: argparse.Namespace) -> BackfillStats:
    stats = BackfillStats()
    stats.started_at = time.time()

    ctrl = CtrlClient()
    matter_cache: dict[str, dict[str, Any] | None] = {}
    event_cache: dict[str, dict[str, Any] | None] = {}

    try:
        # Load the raw task list for filtering; we also count pre-filter
        # exclusions so the summary reflects what was actually in the vault.
        records = await ctrl.list_records("task")
        total_records = sum(
            1 for r in records
            if (r.get("path", "")).startswith("task/")
            and (r.get("path", "")).endswith(".md")
        )

        candidates = _filter_candidates(
            records,
            skip_archived=args.skip_archived,
            only_linked=args.only_linked,
            min_existing_chars=args.min_existing_chars,
        )
        stats.tasks_examined = total_records
        # The filter chain is inclusive; compute category counts for the
        # summary by replaying each stage independently.
        stats.skipped_existing = sum(
            1 for r in records
            if (r.get("path", "")).startswith("task/")
            and (r.get("path", "")).endswith(".md")
            and len(_fm_as_str((r.get("frontmatter") or {}).get("description"))) >= args.min_existing_chars
        )
        if args.skip_archived:
            stats.skipped_archived = sum(
                1 for r in records
                if (r.get("path", "")).startswith("task/")
                and (r.get("path", "")).endswith(".md")
                and (r.get("frontmatter") or {}).get("archived") in (True, "true", "True", 1, "1")
            )
        stats.skipped_agent_managed = sum(
            1 for r in records
            if (r.get("path", "")).startswith("task/")
            and (r.get("path", "")).endswith(".md")
            and (
                _fm_as_str((r.get("frontmatter") or {}).get("agent_id")).strip()
                or _fm_as_str((r.get("frontmatter") or {}).get("skill_entry")).strip()
            )
        )
        if args.only_linked:
            stats.skipped_unlinked = sum(
                1 for r in records
                if (r.get("path", "")).startswith("task/")
                and (r.get("path", "")).endswith(".md")
                and not _first_matter_ref(r.get("frontmatter") or {})
            )

        logger.info(
            "backfill: tenant=%s, total_tasks=%d, candidates=%d, "
            "dry_run=%s, min_existing_chars=%d, only_linked=%s, skip_archived=%s",
            args.tenant_id or "(unspecified)",
            total_records, len(candidates),
            args.dry_run, args.min_existing_chars,
            args.only_linked, args.skip_archived,
        )

        if not candidates:
            logger.info("backfill: no candidate tasks — nothing to do.")
            return stats

        batch_size = max(1, args.batch_size)
        max_tasks = args.max_batches * batch_size
        to_process = candidates[:max_tasks]
        logger.info(
            "backfill: processing %d/%d candidates (cap: %d batches × %d = %d)",
            len(to_process), len(candidates),
            args.max_batches, batch_size, max_tasks,
        )

        # Sequential per-task clerk calls with heartbeat every batch_size
        for idx, task in enumerate(to_process, start=1):
            await _process_one(
                ctrl, task, matter_cache, event_cache,
                dry_run=args.dry_run, stats=stats,
            )
            if idx % batch_size == 0:
                elapsed = time.time() - stats.started_at
                logger.info(
                    "backfill: heartbeat %d/%d tasks processed "
                    "(enriched=%d, failed=%d, elapsed=%ds)",
                    idx, len(to_process),
                    stats.enriched, stats.clerk_failures, int(elapsed),
                )
            if idx < len(to_process):
                await asyncio.sleep(args.sleep_between)

    finally:
        await ctrl.close()

    stats.finished_at = time.time()
    _print_summary(args, stats)
    return stats


def _print_summary(args: argparse.Namespace, stats: BackfillStats) -> None:
    runtime = stats.finished_at - stats.started_at
    print("\n" + "=" * 72)
    print("BACKFILL SUMMARY")
    print("=" * 72)
    print(f"tenant:                   {args.tenant_id or '(unspecified)'}")
    print(f"mode:                     {'DRY-RUN' if args.dry_run else 'LIVE'}")
    print(f"min_existing_chars:       {args.min_existing_chars}")
    print(f"batch_size (heartbeat):   {args.batch_size}")
    print(f"max_batches:              {args.max_batches}")
    print(f"only_linked:              {args.only_linked}")
    print(f"skip_archived:            {args.skip_archived}")
    print()
    print(f"tasks in vault:           {stats.tasks_examined}")
    print(f"  already-rich skip:      {stats.skipped_existing}")
    print(f"  archived skip:          {stats.skipped_archived}")
    print(f"  agent-managed skip:     {stats.skipped_agent_managed}")
    print(f"  unlinked skip:          {stats.skipped_unlinked}")
    print(f"tasks attempted:          {stats.tasks_attempted}")
    print(f"clerk calls:              {stats.clerk_calls}")
    print(f"clerk failures:           {stats.clerk_failures}")
    print(f"descriptions enriched:    {stats.enriched}")
    print(f"  parse failures:         {stats.skipped_parse_failure}")
    print(f"  empty-desc skip:        {stats.skipped_empty_desc}")
    print(f"  write errors:           {stats.write_errors}")
    print(f"runtime:                  {runtime:0.1f}s")

    if stats.matter_counts:
        print("\nper-matter enrichment counts (top 20):")
        for slug, count in stats.matter_counts.most_common(20):
            print(f"  {count:4d}  {slug}")

    if stats.samples:
        print("\nsample enrichments (first 5):")
        for s in stats.samples[:5]:
            print("-" * 72)
            print(f"  slug:   {s['slug']}")
            print(f"  name:   {s['name']}")
            print(f"  matter: {s['matter']}")
            if s.get("source_event"):
                print(f"  source: {s['source_event']}")
            print(f"  before: {s['before'][:120]}")
            print(f"  after:  {s['after']}")
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
