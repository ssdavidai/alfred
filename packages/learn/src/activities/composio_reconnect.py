"""Composio reconnect cleanup activities — safety-net reaper for #645.

Background
----------

PR #646 shipped ``POST /api/v1/integrations/:id/reconnect`` on the
ctrl-api side. When Sir asks Alfred to refresh an expired Composio
OAuth, ctrl-api creates a NEW connected_account for the same toolkit
while the OLD one is still alive, then schedules a cleanup that runs
``RECONNECT_GRACE_MS`` (1 hour) later. The cleanup verifies the new
connection actually reached ``ACTIVE`` and only then deletes the old
one — if Sir abandoned the OAuth handshake we keep the old connection
so his apps keep working.

ctrl-api today handles cleanup via:

  1. **In-process ``setTimeout``** scheduled at the moment the ledger
     entry is written. Fast path — works when ctrl-api stays up for
     >1h after the reconnect call.
  2. **Lazy reaper** that scans the ledger on every reconnect call and
     on the manual ``POST /api/v1/integrations/reconnect-cleanup``
     endpoint. Survives restarts but only fires when something else
     prods it.

Gap (#645): if no new reconnects fire and ctrl-api restarts within the
grace window, the ledger entry sits forever — neither the in-process
timer nor the lazy reaper has reason to wake up.

This module is the safety net. A Temporal-scheduled workflow runs every
15 minutes against the same persistent ledger file (mounted at the same
host path under ``/alfred-data/`` from alfred-learn's perspective) and
applies the exact same verify-then-delete-then-purge semantics. The
ledger has idempotent semantics, so the in-process ctrl-api fast path
and this Temporal safety net coexist cleanly — whichever wins, wins.

Scope
-----

* Reads + writes the ledger JSON file. Atomic write via temp+rename so
  a torn write can never corrupt the ledger.
* Talks to Composio via the official Python SDK (already wired through
  ``src/integrations/composio_client.py`` for the rest of the package).
* Per-entry error isolation — a single Composio API blip cannot crash
  the workflow or strand other entries.
* Never modifies ledger entries whose ``cleanup_after_ms`` is still in
  the future. The workflow filters those out before calling activities,
  but the activities are also defensive in case the workflow is invoked
  manually with a custom entry.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
from typing import Any

from temporalio import activity

logger = logging.getLogger("alfred-learn")


# Same host path as ctrl-api uses (``/mnt/encrypted/alfred/...``) — alfred-learn
# mounts that host directory at ``/alfred-data/`` per docker-compose.yaml.njk.
# Override via env for tests + alternate deployments.
DEFAULT_LEDGER_PATH = "/alfred-data/.composio-reconnect-ledger.json"


def _ledger_path() -> str:
    return os.environ.get(
        "COMPOSIO_RECONNECT_LEDGER_PATH", DEFAULT_LEDGER_PATH,
    )


def _normalize_entry(raw: Any) -> dict[str, Any] | None:
    """Coerce a raw ledger entry into a stable shape.

    The ctrl-api writes ``cleanup_after`` (ms-since-epoch). Older
    debugging/manual writes may use ``cleanup_after_ms`` — accept both
    so we can't be tripped up by a sloppy ops poke at the ledger.
    Returns ``None`` if the entry is missing the fields we need to
    reason about it.
    """
    if not isinstance(raw, dict):
        return None
    old_id = raw.get("old_connection_id")
    new_id = raw.get("new_connection_id")
    if not isinstance(old_id, str) or not old_id:
        return None
    if not isinstance(new_id, str) or not new_id:
        return None
    cleanup = raw.get("cleanup_after_ms")
    if cleanup is None:
        cleanup = raw.get("cleanup_after")
    try:
        cleanup_ms = int(cleanup) if cleanup is not None else 0
    except (TypeError, ValueError):
        cleanup_ms = 0
    return {
        "old_connection_id": old_id,
        "new_connection_id": new_id,
        "toolkit": str(raw.get("toolkit") or ""),
        "user_id": str(raw.get("user_id") or ""),
        "scheduled_at": int(raw.get("scheduled_at") or 0),
        "cleanup_after_ms": cleanup_ms,
    }


def _atomic_write_json(path: str, payload: Any) -> None:
    """Write JSON via temp file + rename so a torn write never corrupts the ledger.

    The ctrl-api side does an in-place ``writeFileSync`` with no atomic
    guarantees, but it tolerates a missing/empty file by treating it as
    "no entries". That's fine for the read side; on the write side we
    play it safer because the Temporal workflow may run mid-handshake
    with the ctrl-api pickup.
    """
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        dir=os.path.dirname(path) or ".", prefix=".reconnect-ledger.", suffix=".tmp",
    )
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(payload, fh, indent=2)
        os.replace(tmp_path, path)
    except Exception:
        # Best-effort cleanup of the temp file on failure.
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Activities
# ---------------------------------------------------------------------------


@activity.defn
async def read_reconnect_ledger() -> list[dict[str, Any]]:
    """Read + normalize the reconnect ledger from disk.

    Returns ``[]`` if the file doesn't exist or is malformed — both are
    valid "nothing to clean up" states. Bad entries (missing required
    fields) are logged + skipped rather than crashing the workflow.
    """
    path = _ledger_path()
    try:
        with open(path) as fh:
            raw = json.load(fh)
    except FileNotFoundError:
        return []
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "composio_reconnect: ledger %s unreadable (%s) — treating as empty",
            path, exc,
        )
        return []

    if not isinstance(raw, list):
        logger.warning(
            "composio_reconnect: ledger %s is not a JSON array — treating as empty",
            path,
        )
        return []

    entries: list[dict[str, Any]] = []
    for item in raw:
        normalized = _normalize_entry(item)
        if normalized is None:
            logger.warning(
                "composio_reconnect: dropping malformed ledger entry %r",
                item,
            )
            continue
        entries.append(normalized)
    return entries


@activity.defn
async def verify_new_connection_active(new_connection_id: str) -> dict[str, Any]:
    """Look up the new connected_account in Composio and report its status.

    Returns ``{"status": "<UPPERCASE>", "exists": bool}``:

      * ``status`` — Composio status string upper-cased (``ACTIVE``,
        ``INITIATED``, ``FAILED``, ``EXPIRED``, ``""``).
      * ``exists`` — ``False`` only if Composio returns 404, in which case
        the new connection itself has vanished and the ledger entry is
        purgable.

    Network/SDK errors propagate as exceptions — the workflow's per-entry
    try/except catches them and leaves the ledger entry alone for next
    tick, matching the ctrl-api ``"kept"`` outcome.
    """
    # Late import so the temporalio sandbox never sees the SDK at workflow
    # import time. (Matches the pattern used by composio_tools.py.)
    from src.integrations.composio_client import _get_client

    client = _get_client()
    try:
        from composio import exceptions as composio_exc  # type: ignore
    except ImportError:  # pragma: no cover — SDK is required at runtime
        composio_exc = None  # type: ignore[assignment]

    try:
        resp = client.connected_accounts.get(new_connection_id)
    except Exception as exc:  # noqa: BLE001
        # Treat a NotFoundError as "vanished"; everything else propagates.
        if composio_exc is not None and isinstance(
            exc,
            (
                getattr(composio_exc, "NotFoundError", Exception),
                getattr(composio_exc, "ConnectedAccountNotFoundError", Exception),
            ),
        ):
            logger.info(
                "composio_reconnect: new_connection_id=%s not found (404)",
                new_connection_id,
            )
            return {"status": "", "exists": False}
        # Last-ditch: some SDK error shapes carry a status attribute.
        status_attr = getattr(exc, "status_code", None) or getattr(exc, "status", None)
        if status_attr == 404:
            return {"status": "", "exists": False}
        raise

    raw_status = ""
    if hasattr(resp, "status"):
        raw_status = str(getattr(resp, "status") or "")
    elif isinstance(resp, dict):
        raw_status = str(resp.get("status") or "")
    return {"status": raw_status.upper(), "exists": True}


@activity.defn
async def delete_old_connection(old_connection_id: str) -> bool:
    """Delete the stale Composio connected_account.

    Returns ``True`` if Composio confirmed the deletion or the connection
    is already gone (404). Raises on any other error — the workflow's
    per-entry try/except will keep the ledger entry around for next tick.
    """
    from src.integrations.composio_client import _get_client

    client = _get_client()
    try:
        from composio import exceptions as composio_exc  # type: ignore
    except ImportError:  # pragma: no cover — SDK is required at runtime
        composio_exc = None  # type: ignore[assignment]

    try:
        client.connected_accounts.delete(old_connection_id)
        logger.info(
            "composio_reconnect: deleted old_connection_id=%s",
            old_connection_id,
        )
        return True
    except Exception as exc:  # noqa: BLE001
        if composio_exc is not None and isinstance(
            exc,
            (
                getattr(composio_exc, "NotFoundError", Exception),
                getattr(composio_exc, "ConnectedAccountNotFoundError", Exception),
            ),
        ):
            logger.info(
                "composio_reconnect: old_connection_id=%s already gone (404)",
                old_connection_id,
            )
            return True
        status_attr = getattr(exc, "status_code", None) or getattr(exc, "status", None)
        if status_attr == 404:
            logger.info(
                "composio_reconnect: old_connection_id=%s already gone (404 via attr)",
                old_connection_id,
            )
            return True
        raise


@activity.defn
async def remove_ledger_entry(old_connection_id: str) -> bool:
    """Atomically remove a single ledger entry by ``old_connection_id``.

    Returns ``True`` if an entry was found + removed, ``False`` if no such
    entry existed (already pruned by the ctrl-api fast path, e.g.).

    Read-modify-write on the ledger file is the only way the ctrl-api
    in-process reaper and this Temporal safety-net stay in sync. Atomic
    rename keeps the file readable to any concurrent ctrl-api request.
    """
    path = _ledger_path()
    try:
        with open(path) as fh:
            raw = json.load(fh)
    except FileNotFoundError:
        return False
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "composio_reconnect: ledger %s unreadable during remove (%s) — no-op",
            path, exc,
        )
        return False

    if not isinstance(raw, list):
        return False

    remaining: list[Any] = []
    found = False
    for item in raw:
        if isinstance(item, dict) and item.get("old_connection_id") == old_connection_id:
            found = True
            continue
        remaining.append(item)

    if not found:
        return False

    _atomic_write_json(path, remaining)
    logger.info(
        "composio_reconnect: removed ledger entry old_connection_id=%s "
        "(remaining=%d)",
        old_connection_id, len(remaining),
    )
    return True
