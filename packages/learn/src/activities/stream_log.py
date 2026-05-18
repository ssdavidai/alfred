"""Stream log activity — appends one-line entries to the daily stream log."""

from __future__ import annotations

from datetime import datetime, timezone

from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient


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

        # Try to append to existing log file
        try:
            existing = await client.read_record(log_path)
            # File exists — append the entry
            await client.update_record(log_path, entry)
        except Exception:
            # File doesn't exist — create with header + first entry
            header = _STREAM_LOG_HEADER.format(date=date_str)
            content = header + entry
            await client.write_record("memory", f"stream-log-{date_str}", content)

        return log_path
    finally:
        await client.close()
