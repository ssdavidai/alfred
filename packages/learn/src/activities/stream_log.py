"""Stream log activity — appends one-line entries to the daily stream log."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


_STREAM_LOG_HEADER = """\
---
type: note
name: Stream Log — {date}
status: active
tags: [stream-log, daily]
---

# Stream Log — {date}

"""


@activity.defn
async def append_to_stream_log(stream_type: str, log_line: str) -> str:
    """Append a one-line entry to today's stream log in the vault.

    Writes to memory/stream-log-YYYY-MM-DD.md via ctrl-api.
    Creates the file with a header if it doesn't exist.
    Returns the log file path.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        now = datetime.now(timezone.utc)
        date_str = now.strftime("%Y-%m-%d")
        time_str = now.strftime("%H:%M")
        log_path = f"memory/stream-log-{date_str}.md"

        entry = f"- **{time_str}** [{stream_type}] {log_line}\n"

        # NOTE (#78): ``memory/`` is NOT a canonical vault type, so ctrl-api's
        # promotion contract 422s every write here. This activity is no longer
        # called on the hot path (EventProcessor stopped invoking it), but it
        # is kept tolerant: a contract rejection (422) or any other write
        # failure is downgraded to a warning + early return so a stray caller
        # can never wedge a workflow on infinite retries again (the original
        # bug — observed at attempt #219). The stream log is an audit-class
        # convenience, never load-bearing.
        try:
            try:
                await client.read_record(log_path)
                await client.update_record(log_path, entry)
            except httpx.HTTPStatusError as exc:
                # 404 → file doesn't exist yet, create it. Any other status
                # (incl. 422 contract rejection) falls through to the outer
                # handler below.
                if exc.response is not None and exc.response.status_code == 404:
                    header = _STREAM_LOG_HEADER.format(date=date_str)
                    await client.write_record(
                        "memory", f"stream-log-{date_str}", header + entry
                    )
                else:
                    raise
        except Exception as exc:  # noqa: BLE001 — advisory, never fatal
            logger.warning(
                "stream_log.append_to_stream_log: write skipped (%s) — "
                "non-fatal, stream log is audit-class",
                str(exc)[:120],
            )

        return log_path
    finally:
        await client.close()
