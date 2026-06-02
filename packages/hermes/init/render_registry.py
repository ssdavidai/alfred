#!/usr/bin/env python3
"""render_registry.py — enumerate live profiles + emit the supervisor registry JSON.

#120 Lane II — replaces the previous hard-coded `PROFILES_RENDERED=(main
workers heavy codex-builder)` list in entrypoint.sh. Queries the agent_profile
table in ctrl-api's state.db (mounted read-only at /ctrl-data/alfred-state.db)
and:

  1. Prints (to stdout) a newline-separated list of `<slug>:<port>:<model>`
     for the init loop to render. The slug is what entrypoint.sh feeds into
     render_hermes.py; the port becomes HERMES_RENDER_PORT, the model
     HERMES_RENDER_MODEL.

  2. Writes a JSON manifest to /hermes-state/profiles/_registry.json the
     supervisor will read at boot. The shape matches ctrl-api's
     buildSupervisorRegistry (db/agentProfiles.ts) — one source of truth
     for the file shape.

  3. Falls back gracefully when state.db is missing OR the table is missing:
     prints the four reserved profiles + their canonical ports, so a fresh
     tenant still gets the existing 4-profile layout even if init runs
     before ctrl-api has applied the 0017 migration.

This script is a READ-ONLY consumer of state.db. ctrl-api remains the SOLE
writer of the registry rows.

Usage:
    render_registry.py [--out <registry_json_path>]

Environment:
    STATE_DB_PATH                 path to state.db (default /ctrl-data/alfred-state.db)
    HERMES_DATA_DIR               init container's view of hermes_data
                                  (default /hermes-data) — used as the
                                  default registry-JSON parent dir.
    HERMES_REGISTRY_PATH          full registry JSON override; takes
                                  precedence over --out and HERMES_DATA_DIR.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

# Same fallback layout the supervisor expected before this script existed —
# matches _RESERVED_PORT in render_hermes.py.
_FALLBACK_PROFILES = [
    {
        "slug": "main",
        "api_server_port": 18789,
        "model": "x-ai/grok-4.3",
        "status": "running",
        "is_reserved": True,
        "is_user_facing": True,
    },
    {
        "slug": "workers",
        "api_server_port": 18790,
        "model": "openai/gpt-4.1-nano",
        "status": "running",
        "is_reserved": True,
        "is_user_facing": False,
    },
    {
        "slug": "heavy",
        "api_server_port": 18791,
        "model": "anthropic/claude-opus-4-6",
        "status": "running",
        "is_reserved": True,
        "is_user_facing": False,
    },
    {
        "slug": "codex-builder",
        "api_server_port": 18793,
        "model": "gpt-5-codex",
        "status": "stopped",
        "is_reserved": True,
        "is_user_facing": False,
    },
]


def _read_profiles_from_state_db(state_db_path: Path) -> list[dict] | None:
    """Try to enumerate profiles from state.db. Returns None on any failure
    (file missing, table missing, sqlite locked, …) so the caller can fall
    back to the hard-coded reserved list."""
    if not state_db_path.exists():
        return None
    try:
        # mode=ro — open the file read-only but ALLOW the WAL to be
        # consulted. immutable=1 would tell SQLite "ignore the WAL", which
        # silently misses recently-committed rows (live-observed 2026-05-31
        # on home: a profile created via POST 30s before init ran was in
        # state.db but invisible to render_registry because the row was
        # still in the WAL when init's query ran). The mount is :ro so
        # write attempts EROFS regardless of this flag.
        uri = f"file:{state_db_path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        cur = conn.execute(
            """
            SELECT slug, api_server_port, model, status,
                   is_reserved, is_user_facing
            FROM agent_profile
            WHERE archived_at IS NULL
              AND status != 'archived'
            ORDER BY is_reserved DESC, api_server_port ASC
            """
        )
        rows = cur.fetchall()
        conn.close()
    except sqlite3.OperationalError as e:
        # Table missing (fresh tenant pre-migration) or DB locked. Caller
        # falls back to _FALLBACK_PROFILES.
        print(
            f"[render_registry] state.db query failed ({e}) — falling back to reserved set",
            file=sys.stderr,
        )
        return None
    if not rows:
        # Table exists but is empty — shouldn't happen after 0017 seeds the
        # four reserved profiles, but be defensive: fall back rather than
        # render a zero-profile container.
        return None
    return [
        {
            "slug": r["slug"],
            "api_server_port": int(r["api_server_port"]),
            "model": r["model"],
            "status": r["status"],
            "is_reserved": bool(r["is_reserved"]),
            "is_user_facing": bool(r["is_user_facing"]),
        }
        for r in rows
    ]


def _resolve_registry_path(cli_out: str | None) -> Path:
    explicit = os.environ.get("HERMES_REGISTRY_PATH", "").strip()
    if explicit:
        return Path(explicit)
    if cli_out:
        return Path(cli_out)
    hermes_data_dir = os.environ.get("HERMES_DATA_DIR", "/hermes-data").strip()
    return Path(hermes_data_dir) / "profiles" / "_registry.json"


def _atomic_write_json(path: Path, payload: dict) -> None:
    """Write `payload` JSON to `path` atomically (write-then-rename).
    Same semantics as ctrl-api's writeSupervisorRegistry — the supervisor
    either sees the previous valid JSON or the new one, never a torn file.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp.chmod(0o644)
    os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--out",
        default=None,
        help="explicit path for the registry JSON output",
    )
    ap.add_argument(
        "--print-only",
        action="store_true",
        help="print the slug:port:model list to stdout, do not write JSON",
    )
    args = ap.parse_args()

    state_db_path = Path(
        os.environ.get("STATE_DB_PATH", "/ctrl-data/alfred-state.db")
    )
    profiles = _read_profiles_from_state_db(state_db_path)
    source = "state.db"
    if profiles is None:
        profiles = list(_FALLBACK_PROFILES)
        source = "fallback (reserved profiles only)"

    print(
        f"[render_registry] resolved {len(profiles)} profile(s) from {source}",
        file=sys.stderr,
    )
    for p in profiles:
        print(
            f"[render_registry]   - {p['slug']} port={p['api_server_port']} "
            f"model={p['model']} status={p['status']} reserved={p['is_reserved']}",
            file=sys.stderr,
        )

    # stdout: one line per profile, format `slug:port:model`. entrypoint.sh
    # loops over this list. Model is the last column so a future colon-in-
    # slug (impossible per the regex) or colon-in-port (impossible per int)
    # cannot break the field split.
    for p in profiles:
        print(f"{p['slug']}:{p['api_server_port']}:{p['model']}")

    if args.print_only:
        return 0

    registry_path = _resolve_registry_path(args.out)
    payload = {
        "profiles": profiles,
        "generated_at": int(time.time() * 1000),
        "source": source,
    }
    _atomic_write_json(registry_path, payload)
    print(
        f"[render_registry] wrote {registry_path} ({len(profiles)} profiles)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
