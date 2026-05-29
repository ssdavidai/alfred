"""files_cold_archive — activities for the daily cold-promotion sweep.

Background
----------

Issue #114 PR 5 ships a cold-storage tier for Store 5 (files): a
separate ``files_cold_data`` named volume on the tenant host with
ZSTD-compressed copies of any blob that hasn't been touched in 90+
days. Live ``files_data`` keeps the recent hot path tight; the cold
tier preserves the bytes at a fraction of the disk cost.

The promotion + restore steps themselves live in ctrl-api (Lane III
of the PR plan); ctrl-api owns the filesystem and the
``alfred-state.db`` writes. This module is the alfred-learn glue:
two thin activities that the daily ``FilesColdArchiveWorkflow``
chains together to drive the sweep.

Activities
----------

* ``find_cold_candidates(older_than_ms)`` — GET
  ``/api/v1/files/cold-candidates?older_than_ms=…`` on ctrl-api,
  return the list of (file_id, sha256, size_bytes, …) rows that are
  eligible for promotion. ctrl-api applies the threshold + ordering
  for us; the activity is a pure pass-through.

* ``promote_to_cold(file_id)`` — POST
  ``/api/v1/files/cold-promote/:file_id`` on ctrl-api. Returns the
  per-row promotion summary (live + cold bytes, ratio). Failures
  bubble out so the workflow per-entry try/except can isolate them.

We deliberately do NOT have the workflow read the
``state.db`` directly. ctrl-api is the sole writer of the
files/file_blobs schema; learn writes through HTTP, exactly the
discipline ``StateClient`` / ``VaultClient`` already follow.

Environment
-----------

* ``ALFRED_CTRL_URL`` — the tenant ctrl-api base URL (the same
  variable ``StateClient`` consumes). Defaults to ``http://alfred-ctrl:3100``.
* ``AAS_API_KEY`` — the operator bearer token. Required.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from temporalio import activity

logger = logging.getLogger("alfred-learn")


# Same env knob StateClient / VaultClient honour.
_DEFAULT_CTRL_URL = "http://alfred-ctrl:3100"


def _ctrl_base_url() -> str:
    return os.environ.get("ALFRED_CTRL_URL", _DEFAULT_CTRL_URL)


def _auth_headers() -> dict[str, str]:
    key = os.environ.get("AAS_API_KEY", "")
    return {"Authorization": f"Bearer {key}"} if key else {}


@activity.defn
async def find_cold_candidates(older_than_ms: int) -> list[dict[str, Any]]:
    """Pull the eligible-for-cold-promotion list from ctrl-api.

    ``older_than_ms`` is the threshold: files whose
    ``COALESCE(last_accessed_at, uploaded_at) < now - older_than_ms``
    are returned. The default workflow tick passes 90 days; tests
    and one-off sweeps can override.

    The response shape from ctrl-api is::

        {
          "cutoff_ms": <int>,
          "older_than_ms": <int>,
          "total": <int>,
          "items": [ { ...full FileRow row... }, ... ]
        }

    We hand the workflow the ``items`` list directly.
    """
    url = f"{_ctrl_base_url()}/api/v1/files/cold-candidates"
    params = {"older_than_ms": int(older_than_ms)}
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, params=params, headers=_auth_headers())
        resp.raise_for_status()
        payload = resp.json()
    items = payload.get("items", []) or []
    logger.info(
        "files_cold_archive: %d candidates (older_than_ms=%d, cutoff_ms=%s)",
        len(items),
        older_than_ms,
        payload.get("cutoff_ms"),
    )
    return list(items)


@activity.defn
async def promote_to_cold(file_id: str) -> dict[str, Any]:
    """Move one file from live storage to the cold archive.

    Returns the ctrl-api response payload so the workflow can roll up
    aggregate stats (bytes saved, ratio, etc.). 4xx/5xx bubble out as
    HTTPStatusError — the workflow's per-entry try/except will
    catch + log; one bad file mustn't strand the rest of the run.

    The promote endpoint is idempotent: if the file is already cold,
    ctrl-api returns the same 200 + ``already_cold=True``. We do not
    treat that as a failure.
    """
    url = f"{_ctrl_base_url()}/api/v1/files/cold-promote/{file_id}"
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, headers=_auth_headers())
        resp.raise_for_status()
        return resp.json()
