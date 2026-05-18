"""openclaw-workers session leak reaper.

OpenClaw worker agents (``learn-clerk``, ``vault-curator``, ephemeral
exec/spawn agents) keep a per-agent ``sessions/`` directory under
``/home/node/.openclaw/agents/<agent>/sessions/``. On session
rollover OpenClaw renames the closed session file with a
``.bak-<N>-<epoch_ms>`` suffix instead of deleting it. Over time these
files accumulate — david's tenant has hit 493 of them on ``learn-clerk``
alone in <30 days — and because OpenClaw's session manager does an
O(N) ``readdir`` on every new session create, the clerk container
CPU-pegs at >100% and every LLM call times out. This is the same
class of leak documented in the Sir openclaw degradation incident.

Durable fix
-----------

A scheduled Temporal workflow (``OpenclawSessionSweepWorkflow``, hourly)
calls this activity. The reaper:

  * Walks every agent under ``/openclaw-workers-state/agents/`` — the
    same host directory the openclaw-workers container sees as its
    ``$HOME/.openclaw``, mounted into alfred-learn at
    ``/openclaw-workers-state`` per ``docker-compose.yaml.njk``.
  * Deletes ``*.bak-*`` session files whose mtime is older than
    ``MAX_AGE_HOURS`` (default 24h, env-overridable).
  * Never touches the live ``sessions.json`` cursor or any active
    (non-``.bak``) ``.jsonl`` files — those are operational state.
  * Returns per-agent counts so the workflow can surface a tidy
    summary in Temporal history without log spelunking.

Why an activity rather than a workflow-side loop: filesystem walks
are non-deterministic, ``stat()`` results vary per run, and the count
of files purged shouldn't drive replay decisions. Keeping the side
effects inside an activity is the standard Temporal pattern.

Env overrides
-------------

  * ``OPENCLAW_SWEEP_ROOT`` — root path (default
    ``/openclaw-workers-state/agents``). Set ``""`` to disable the
    sweep (returns an empty result instead of touching anything).
  * ``OPENCLAW_SWEEP_MAX_AGE_HOURS`` — minimum age before a ``.bak-*``
    file is eligible for deletion (default ``24``). Lower values are
    safe; OpenClaw never reads a session after it's been rolled to
    ``.bak``. 24h is the conservative default so any in-flight
    debugging session has a window to inspect.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field

from temporalio import activity

logger = logging.getLogger("alfred-learn")

_DEFAULT_ROOT = "/openclaw-workers-state/agents"
_DEFAULT_MAX_AGE_HOURS = 24


@dataclass
class SweepResult:
    """Counts surfaced back to the workflow + Temporal history."""

    root: str = ""
    agents_scanned: int = 0
    files_scanned: int = 0
    files_deleted: int = 0
    bytes_freed: int = 0
    errors: int = 0
    per_agent: dict[str, int] = field(default_factory=dict)
    error_messages: list[str] = field(default_factory=list)


def _resolve_root() -> str:
    raw = os.environ.get("OPENCLAW_SWEEP_ROOT", _DEFAULT_ROOT)
    return raw.strip()


def _resolve_max_age_seconds() -> int:
    raw = os.environ.get("OPENCLAW_SWEEP_MAX_AGE_HOURS", str(_DEFAULT_MAX_AGE_HOURS))
    try:
        hours = float(raw)
    except (TypeError, ValueError):
        hours = _DEFAULT_MAX_AGE_HOURS
    if hours < 0:
        hours = _DEFAULT_MAX_AGE_HOURS
    return int(hours * 3600)


@activity.defn
async def sweep_openclaw_bak_sessions() -> dict:
    """Delete stale ``.bak-*`` session files under each openclaw agent.

    Returns a dict-shaped ``SweepResult`` (Temporal serializes
    dataclasses fine but a dict round-trips cleaner across the
    activity boundary).
    """
    root = _resolve_root()
    result = SweepResult(root=root)
    if not root:
        logger.info("openclaw_sessions: OPENCLAW_SWEEP_ROOT empty — sweep disabled")
        return result.__dict__

    if not os.path.isdir(root):
        logger.warning(
            "openclaw_sessions: root not found root=%s — sweep skipped (alfred-learn "
            "mount missing? See compose template)", root,
        )
        return result.__dict__

    max_age_seconds = _resolve_max_age_seconds()
    cutoff = time.time() - max_age_seconds

    try:
        agent_names = sorted(os.listdir(root))
    except OSError as exc:
        result.errors += 1
        result.error_messages.append(f"listdir({root}): {exc}"[:300])
        logger.warning("openclaw_sessions: listdir failed root=%s err=%s", root, exc)
        return result.__dict__

    for agent_name in agent_names:
        sessions_dir = os.path.join(root, agent_name, "sessions")
        if not os.path.isdir(sessions_dir):
            continue
        result.agents_scanned += 1
        per_agent_deleted = 0
        try:
            entries = os.listdir(sessions_dir)
        except OSError as exc:
            result.errors += 1
            result.error_messages.append(
                f"listdir({sessions_dir}): {exc}"[:300]
            )
            continue

        for entry in entries:
            # ``.bak-N-<epoch_ms>`` is the rolled-session suffix; we
            # also match ``.bak-*`` more permissively in case OpenClaw
            # ever changes the inner naming. Live ``.jsonl`` files
            # (without a ``.bak`` segment) are untouched, as is
            # ``sessions.json`` (the cursor).
            if ".bak-" not in entry:
                continue
            full = os.path.join(sessions_dir, entry)
            try:
                stat = os.stat(full)
            except OSError as exc:
                result.errors += 1
                result.error_messages.append(
                    f"stat({full}): {exc}"[:300]
                )
                continue
            result.files_scanned += 1
            if stat.st_mtime > cutoff:
                # Younger than the retention window — keep.
                continue
            try:
                os.unlink(full)
                result.files_deleted += 1
                result.bytes_freed += int(stat.st_size)
                per_agent_deleted += 1
            except OSError as exc:
                result.errors += 1
                result.error_messages.append(
                    f"unlink({full}): {exc}"[:300]
                )
                continue

        if per_agent_deleted:
            result.per_agent[agent_name] = per_agent_deleted

    logger.info(
        "openclaw_sessions: sweep done root=%s agents=%d files_scanned=%d "
        "deleted=%d bytes_freed=%d errors=%d",
        root, result.agents_scanned, result.files_scanned,
        result.files_deleted, result.bytes_freed, result.errors,
    )
    return result.__dict__
