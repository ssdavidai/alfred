"""Briefing cache helpers (#841 Phase 5).

The daily morning briefing chore renders Sir's morning summary. Phase 5
makes that chore Steward-aware:

* Tasks where ``last_steward_outcome.decision == "likely_done"`` AND
  ``state == "done"`` (Steward auto-resolved) are filtered out — Sir's
  briefing should not surface tasks Steward already closed.
* A "Closed since last brief" pre-section lists every Steward live-mode
  action whose timestamp is newer than the cutoff stored in
  ``/alfred-data/state/steward/last-brief.json``.
* The cutoff is updated AFTER the briefing context payload is built,
  so a partial failure mid-brief doesn't lose entries — the next brief
  will still catch them.

The chore SHOULD NOT trigger fresh LLM evaluation. This activity reads
ONLY cached state (vault frontmatter + audit records).
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# State path: last-brief cutoff
# ---------------------------------------------------------------------------

def _last_brief_state_path(cfg) -> str:
    return os.path.join(cfg.alfred_data_dir, "state", "steward", "last-brief.json")


def _read_last_brief_at(cfg) -> Optional[str]:
    """Return the ISO timestamp of the last brief, or None if missing."""
    path = _last_brief_state_path(cfg)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("briefing_cache: read failed path=%s err=%s", path, exc)
        return None
    if not isinstance(data, dict):
        return None
    last_at = data.get("last_brief_at")
    if isinstance(last_at, str) and last_at.strip():
        return last_at.strip()
    return None


def _write_last_brief_at(cfg, ts_iso: str, *, count_closed: int = 0) -> None:
    path = _last_brief_state_path(cfg)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "last_brief_at": ts_iso,
                    "closed_since_count": count_closed,
                },
                f,
                indent=2,
                sort_keys=True,
                default=str,
            )
        os.replace(tmp, path)
    except OSError as exc:
        logger.warning("briefing_cache: write failed path=%s err=%s", path, exc)


def _parse_iso(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Filtering helpers
# ---------------------------------------------------------------------------

@dataclass
class TaskBriefingEntry:
    path: str
    title: str
    state: str
    parent_matter: str
    last_steward_decision: str
    last_steward_confidence: float
    surface_class: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "title": self.title,
            "state": self.state,
            "parent_matter": self.parent_matter,
            "last_steward_decision": self.last_steward_decision,
            "last_steward_confidence": self.last_steward_confidence,
            "surface_class": self.surface_class,
        }


def _task_should_be_briefed(fm: dict[str, Any]) -> bool:
    """Return True if the task should appear in the briefing.

    Filter rule (RFC §5 + #841): skip tasks where
    ``last_steward_outcome.decision == "likely_done"`` AND
    ``state == "done"`` — Steward auto-resolved them, no need to surface.

    Open / snoozed / pending_confirmation tasks always surface.
    Tasks already in ``state == "archived"`` are always skipped (terminal).
    """
    state = str(fm.get("state") or "open").strip().lower()
    if state == "archived":
        return False

    last_outcome = fm.get("last_steward_outcome")
    if not isinstance(last_outcome, dict):
        # No Steward outcome — surface it (this is a fresh / un-evaluated
        # task; Sir should know about it).
        return state != "done"

    decision = str(last_outcome.get("decision") or "").strip().lower()
    if state == "done" and decision == "likely_done":
        # Steward auto-resolved — hide from briefing.
        return False
    return True


def _extract_title(fm: dict[str, Any], path: str) -> str:
    for key in ("title", "name", "summary"):
        v = fm.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    # Fall back to slug from path.
    s = path
    if s.endswith(".md"):
        s = s[:-3]
    if s.startswith("task/"):
        s = s[len("task/"):]
    return s


def _extract_parent_matter(fm: dict[str, Any]) -> str:
    for key in ("parent_matter", "matter"):
        v = fm.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


# ---------------------------------------------------------------------------
# Activity: compute_briefing_context
# ---------------------------------------------------------------------------

@activity.defn
async def compute_briefing_context() -> dict[str, Any]:
    """Build the Steward-aware context payload for the morning briefing.

    Returns a dict with three top-level keys::

        {
          "open_tasks":              [TaskBriefingEntry.as_dict, ...],
          "closed_since_last_brief": [
              {"path": "task/foo.md", "title": "...", "decision": "likely_done",
               "confidence": 0.9, "audit_path": "event/steward-action-...md",
               "timestamp": "..."},
              ...
          ],
          "last_brief_at":           "<previous cutoff ISO or empty>",
          "this_brief_at":           "<now ISO>",
          "filter_summary": {
              "total_open_in_vault":     int,
              "filtered_likely_done":    int,
              "surfaced":                int,
          },
        }

    The chore workflow forwards the JSON-serialised payload to Sir's main
    agent as part of the briefing prompt so the skill has it pre-baked
    and doesn't need to re-query.

    No LLM calls. Pure read of vault state + steward audit records.
    """
    cfg = load_config()
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cutoff_iso = _read_last_brief_at(cfg) or ""
    cutoff_dt = _parse_iso(cutoff_iso)

    client = VaultClient(cfg)

    open_entries: list[dict[str, Any]] = []
    total_open = 0
    filtered_likely_done = 0
    try:
        # 1) Pull every task — preview=0 because we only need frontmatter.
        try:
            resp = await client._client.get(
                "/api/v1/vault/list/task", params={"preview": 0}
            )
            resp.raise_for_status()
            task_records = resp.json().get("results", [])
        except httpx.HTTPError as exc:
            logger.warning("briefing_cache: list/task failed err=%s", exc)
            task_records = []

        for rec in task_records:
            path = rec.get("path") or ""
            if not path.startswith("task/"):
                continue
            fm = rec.get("frontmatter") or {}
            if not isinstance(fm, dict):
                fm = {}
            state = str(fm.get("state") or "open").strip().lower()
            if state in ("archived",):
                continue
            total_open += 1
            if not _task_should_be_briefed(fm):
                filtered_likely_done += 1
                continue
            outcome = fm.get("last_steward_outcome")
            decision = ""
            confidence = 0.0
            if isinstance(outcome, dict):
                decision = str(outcome.get("decision") or "")
                try:
                    confidence = float(outcome.get("confidence") or 0.0)
                except (TypeError, ValueError):
                    confidence = 0.0
            entry = TaskBriefingEntry(
                path=path,
                title=_extract_title(fm, path),
                state=state,
                parent_matter=_extract_parent_matter(fm),
                last_steward_decision=decision,
                last_steward_confidence=confidence,
                surface_class=str(fm.get("surface_class") or "normal"),
            )
            open_entries.append(entry.as_dict())

        # 2) Closed since last brief — walk steward-action audit records
        # via the dashboard endpoint. We use ctrl-api's /api/v1/steward/
        # recent-actions which already filters by the ``since`` query
        # param and returns shadow + live mixed; we only want live mode.
        closed_entries: list[dict[str, Any]] = []
        # since parameter: cutoff if we have one, else 24h ago — same
        # default the dashboard uses.
        params: dict[str, Any] = {"limit": 200}
        if cutoff_iso:
            params["since"] = cutoff_iso
        try:
            r = await client._client.get(
                "/api/v1/steward/recent-actions", params=params,
            )
            r.raise_for_status()
            recent = r.json() if r.content else {}
        except httpx.HTTPError as exc:
            logger.warning("briefing_cache: recent-actions failed err=%s", exc)
            recent = {}
        actions = recent.get("actions") if isinstance(recent, dict) else []
        if not isinstance(actions, list):
            actions = []

        for action in actions:
            if not isinstance(action, dict):
                continue
            mode = str(action.get("mode") or "").strip().lower()
            if mode != "live":
                continue
            decision = str(action.get("decision") or "").strip().lower()
            if decision not in ("likely_done", "stale_archive_candidate"):
                # We only care about closures (done / archived) for the
                # "Closed since last brief" prefix.
                continue
            ts = str(action.get("timestamp") or "")
            ts_dt = _parse_iso(ts)
            if cutoff_dt and ts_dt and ts_dt <= cutoff_dt:
                continue
            target = str(action.get("target") or "")
            audit_path = str(action.get("path") or "")
            closed_entries.append({
                "path": target,
                "title": _slug_to_title(target),
                "decision": decision,
                "confidence": float(action.get("confidence") or 0.0),
                "audit_path": audit_path,
                "timestamp": ts,
            })

        return {
            "open_tasks": open_entries,
            "closed_since_last_brief": closed_entries,
            "last_brief_at": cutoff_iso,
            "this_brief_at": now_iso,
            "filter_summary": {
                "total_open_in_vault": total_open,
                "filtered_likely_done": filtered_likely_done,
                "surfaced": len(open_entries),
            },
        }
    finally:
        await client.close()


def _slug_to_title(path: str) -> str:
    s = (path or "").strip()
    if s.endswith(".md"):
        s = s[:-3]
    if s.startswith("task/"):
        s = s[len("task/"):]
    if s.startswith("matter/"):
        s = s[len("matter/"):]
    return s.replace("-", " ").replace("_", " ").strip() or path


# ---------------------------------------------------------------------------
# Activity: stamp_brief_completed
# ---------------------------------------------------------------------------

@activity.defn
async def stamp_brief_completed(closed_since_count: int = 0) -> str:
    """Stamp ``last_brief_at`` to ``now``. Returns the ISO timestamp.

    Called by the briefing chore AFTER it has handed the context payload
    to Sir's main agent. Doing the stamp at the END of the chore means
    a partial failure mid-brief doesn't lose entries — the next brief
    will use the previous cutoff and surface them again.

    ``closed_since_count`` is recorded purely for the dashboard's
    "X tasks closed yesterday" widget; not load-bearing.
    """
    cfg = load_config()
    ts_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    _write_last_brief_at(cfg, ts_iso, count_closed=int(closed_since_count or 0))
    logger.info(
        "briefing_cache: stamped last_brief_at=%s closed_since=%d",
        ts_iso, int(closed_since_count or 0),
    )
    return ts_iso
