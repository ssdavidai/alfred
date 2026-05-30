"""Tests for the Phase B disposition layer on render_mcp_servers.py.

ensure_mcp_servers now optionally reads state.db.tool_disposition and, for the
MAIN profile, applies `tools.include: []` to any server marked DELEGATED.

Pinned behaviours:
  * MAIN profile + state_db with `sure=delegated` → tools.include: [] lands
    on the sure block.
  * MAIN profile + state_db with all servers DIRECT (the migration-0014 seed)
    → no mutation. Result code stays "present" (nothing to do).
  * WORKERS profile is UNAFFECTED by dispositions even when sure=delegated.
    Focused subagents need the full catalogue.
  * Missing state.db → defaults to all-direct (fresh-tenant fallback).
  * Missing tool_disposition table on an old state.db → same fallback.
  * Disposition on an operator-disabled server (block is `null`) → respect
    the null; do not graft tools.include onto a null.
"""

from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path

import pytest


HERMES = Path(__file__).resolve().parent.parent
RENDER_SCRIPT = HERMES / "init" / "render_mcp_servers.py"


def _load_render_module():
    spec = importlib.util.spec_from_file_location(
        "render_mcp_servers", RENDER_SCRIPT
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def render_module():
    pytest.importorskip("ruamel.yaml")
    return _load_render_module()


def _seed_state_db(state_db_path: Path, dispositions: dict[str, str]) -> None:
    """Build a fresh state.db with migration 0014's table seeded with the
    given dispositions. Mirrors the live schema so the mutator reads it
    correctly via mode=ro URI."""
    conn = sqlite3.connect(state_db_path)
    try:
        conn.execute(
            "CREATE TABLE tool_disposition ("
            "  server TEXT PRIMARY KEY,"
            "  disposition TEXT NOT NULL DEFAULT 'direct',"
            "  updated_at TEXT NOT NULL,"
            "  updated_by TEXT"
            ")"
        )
        for server, disposition in dispositions.items():
            conn.execute(
                "INSERT INTO tool_disposition (server, disposition, updated_at, updated_by)"
                " VALUES (?, ?, '2026-05-30T00:00:00Z', 'test')",
                (server, disposition),
            )
        conn.commit()
    finally:
        conn.close()


_PRE_PHASE_B_CONFIG = """\
model:
  provider: openrouter
  name: x-ai/grok-4.3

mcp_servers:
  alfred-ctrl:
    command: node
    args: ["/opt/data/profiles/main/mcp/ctrl-server.mjs"]
    env:
      CTRL_API_URL: http://ctrl-api:3100
      AAS_API_KEY: ${AAS_API_KEY}
    timeout: 120
    connect_timeout: 60
  alfred:
    command: node
    args: ["/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js", "alfred"]
    env:
      CTRL_API_URL: http://ctrl-api:3100
      AAS_API_KEY: ${AAS_API_KEY}
    timeout: 120
    connect_timeout: 60
  sure:
    command: node
    args: ["/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js", "sure"]
    env:
      SURE_API_URL: http://sure:3000/api
      SURE_API_TOKEN: ${SURE_API_TOKEN}
    timeout: 120
    connect_timeout: 60
  paperclip:
    command: node
    args: ["/opt/paperclip-mcp/node_modules/@paperclipai/mcp-server/dist/stdio.js"]
    env:
      PAPERCLIP_API_URL: http://paperclip:3100/api
      PAPERCLIP_API_KEY: ${PAPERCLIP_API_KEY}
    timeout: 120
    connect_timeout: 60
  hass:
    command: node
    args: ["/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js", "hass"]
    env:
      CTRL_API_URL: http://ctrl-api:3100
      AAS_API_KEY: ${AAS_API_KEY}
    timeout: 120
    connect_timeout: 60
  files:
    command: node
    args: ["/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js", "files"]
    env:
      CTRL_API_URL: http://ctrl-api:3100
      AAS_API_KEY: ${AAS_API_KEY}
    timeout: 120
    connect_timeout: 60
"""


def test_main_profile_delegated_server_gets_tools_include_empty(
    tmp_path: Path, render_module
):
    """sure=delegated → main's sure block grows tools.include: []."""
    config = tmp_path / "config.yaml"
    config.write_text(_PRE_PHASE_B_CONFIG, encoding="utf-8")
    state_db = tmp_path / "alfred-state.db"
    _seed_state_db(state_db, {"sure": "delegated"})

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="main",
        mcp_stdio_dir="/opt/data/profiles/main/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
        state_db_path=state_db,
    )
    assert outcome == "added"

    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    sure = data["mcp_servers"]["sure"]
    assert "tools" in sure
    assert sure["tools"]["include"] == []
    # The other servers are untouched.
    assert "tools" not in data["mcp_servers"]["paperclip"] or \
           data["mcp_servers"]["paperclip"].get("tools", {}).get("include") != []
    assert "tools" not in data["mcp_servers"]["alfred-ctrl"] or \
           data["mcp_servers"]["alfred-ctrl"].get("tools", {}).get("include") != []


def test_main_profile_all_direct_no_mutation(tmp_path: Path, render_module):
    """The default seed (all 9 servers DIRECT) yields no mutation: outcome
    'present' and the config is byte-equal to before."""
    config = tmp_path / "config.yaml"
    config.write_text(_PRE_PHASE_B_CONFIG, encoding="utf-8")
    state_db = tmp_path / "alfred-state.db"
    _seed_state_db(
        state_db,
        {
            "alfred-ctrl": "direct", "alfred": "direct", "sure": "direct",
            "plane": "direct", "vaultwarden": "direct", "execute": "direct",
            "paperclip": "direct", "hass": "direct", "files": "direct",
        },
    )

    before = config.read_text()
    outcome = render_module.ensure_mcp_servers(
        config,
        profile="main",
        mcp_stdio_dir="/opt/data/profiles/main/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
        state_db_path=state_db,
    )
    # 'present' because the required-server allowlist is also already
    # satisfied (hass + files are in the config), and no disposition mutation
    # was needed.
    assert outcome == "present"
    assert config.read_text() == before


def test_workers_profile_ignores_dispositions(tmp_path: Path, render_module):
    """sure=delegated must NOT affect the workers profile. Focused subagents
    need the full catalogue."""
    config = tmp_path / "config.yaml"
    config.write_text(_PRE_PHASE_B_CONFIG, encoding="utf-8")
    state_db = tmp_path / "alfred-state.db"
    _seed_state_db(state_db, {"sure": "delegated"})

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="workers",
        mcp_stdio_dir="/opt/data/profiles/workers/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
        state_db_path=state_db,
    )
    # `files` is required for workers; it's already in this config so
    # outcome is "present" — no disposition mutation should have happened.
    assert outcome == "present"

    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    sure = data["mcp_servers"]["sure"]
    # Critical: sure on workers MUST NOT have tools.include: [] — workers
    # is the focused-subagent target.
    if "tools" in sure:
        assert sure["tools"].get("include") != []


def test_missing_state_db_falls_back_to_direct(tmp_path: Path, render_module):
    """No state.db file → every server stays DIRECT (fresh-tenant fallback)."""
    config = tmp_path / "config.yaml"
    config.write_text(_PRE_PHASE_B_CONFIG, encoding="utf-8")

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="main",
        mcp_stdio_dir="/opt/data/profiles/main/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
        state_db_path=tmp_path / "does-not-exist.db",
    )
    assert outcome == "present"
    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    # No tools.include: [] anywhere — all servers stayed DIRECT.
    for name, block in data["mcp_servers"].items():
        if isinstance(block, dict) and "tools" in block:
            assert block["tools"].get("include") != [], (
                f"server {name} should NOT have tools.include: [] when state.db is missing"
            )


def test_missing_disposition_table_falls_back_to_direct(
    tmp_path: Path, render_module
):
    """state.db exists but tool_disposition table doesn't — same fallback."""
    state_db = tmp_path / "alfred-state.db"
    conn = sqlite3.connect(state_db)
    try:
        conn.execute("CREATE TABLE some_other_table (id INTEGER)")
        conn.commit()
    finally:
        conn.close()

    config = tmp_path / "config.yaml"
    config.write_text(_PRE_PHASE_B_CONFIG, encoding="utf-8")

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="main",
        mcp_stdio_dir="/opt/data/profiles/main/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
        state_db_path=state_db,
    )
    assert outcome == "present"


def test_state_db_path_none_is_a_clean_skip(tmp_path: Path, render_module):
    """Explicit state_db_path=None — caller signals 'no disposition data
    available' (fresh tenant). Same as missing file."""
    config = tmp_path / "config.yaml"
    config.write_text(_PRE_PHASE_B_CONFIG, encoding="utf-8")

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="main",
        mcp_stdio_dir="/opt/data/profiles/main/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
        state_db_path=None,
    )
    assert outcome == "present"


def test_disposition_on_operator_disabled_block_is_skipped(
    tmp_path: Path, render_module
):
    """If operator set `sure: null` (disabled), a sure=delegated disposition
    must NOT mutate the null into a dict. ADD-only contract."""
    config = tmp_path / "config.yaml"
    config.write_text(
        "mcp_servers:\n"
        "  sure: null\n"
        "  hass:\n"
        "    command: node\n"
        "    args: [/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js, hass]\n"
        "  files:\n"
        "    command: node\n"
        "    args: [/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js, files]\n",
        encoding="utf-8",
    )
    state_db = tmp_path / "alfred-state.db"
    _seed_state_db(state_db, {"sure": "delegated"})

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="main",
        mcp_stdio_dir="/opt/data/profiles/main/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
        state_db_path=state_db,
    )
    # No graft, no disposition mutation — operator's null wins.
    assert outcome == "present"
    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    assert data["mcp_servers"]["sure"] is None


def test_disposition_already_applied_no_rewrite(tmp_path: Path, render_module):
    """If tools.include is ALREADY [] on a DELEGATED server, the mutator is
    a no-op (no rewrite, outcome 'present'). Idempotency check."""
    config = tmp_path / "config.yaml"
    config.write_text(
        _PRE_PHASE_B_CONFIG.replace(
            "  sure:\n"
            "    command: node\n"
            "    args: [\"/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js\", \"sure\"]\n"
            "    env:\n"
            "      SURE_API_URL: http://sure:3000/api\n"
            "      SURE_API_TOKEN: ${SURE_API_TOKEN}\n"
            "    timeout: 120\n"
            "    connect_timeout: 60\n",
            "  sure:\n"
            "    command: node\n"
            "    args: [\"/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js\", \"sure\"]\n"
            "    env:\n"
            "      SURE_API_URL: http://sure:3000/api\n"
            "      SURE_API_TOKEN: ${SURE_API_TOKEN}\n"
            "    timeout: 120\n"
            "    connect_timeout: 60\n"
            "    tools:\n"
            "      include: []\n",
        ),
        encoding="utf-8",
    )
    state_db = tmp_path / "alfred-state.db"
    _seed_state_db(state_db, {"sure": "delegated"})

    before = config.read_text()
    outcome = render_module.ensure_mcp_servers(
        config,
        profile="main",
        mcp_stdio_dir="/opt/data/profiles/main/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
        state_db_path=state_db,
    )
    assert outcome == "present"
    assert config.read_text() == before


# --- entrypoint + docker-compose plumbing pins ------------------------------
def test_entrypoint_passes_state_db_path_to_render_mcp_servers():
    """The init entrypoint must export STATE_DB_PATH (defaulting to
    /ctrl-data/alfred-state.db) when invoking render_mcp_servers.py. Without
    it the mutator hits the no-data fallback on every boot — every server
    stays DIRECT regardless of the dashboard toggle."""
    src = (HERMES / "init" / "entrypoint.sh").read_text()
    assert 'STATE_DB_PATH="${STATE_DB_PATH:-/ctrl-data/alfred-state.db}"' in src, (
        "entrypoint.sh must export STATE_DB_PATH when calling "
        "render_mcp_servers.py — the mutator otherwise can't see the "
        "tool_disposition table."
    )


def test_docker_compose_mounts_state_data_ro_into_init():
    """The init service in docker-compose.yaml must mount state_data at
    /ctrl-data:ro so render_mcp_servers can read tool_disposition. Read-only
    because ctrl-api is the sole writer on this volume (per
    STORAGE-ARCHITECTURE.md's single-writer discipline)."""
    compose = (HERMES.parent.parent / "docker-compose.yaml").read_text()
    # The mount appears under the init service. Pin the literal so a future
    # refactor that drops the :ro qualifier (which would break the
    # single-writer discipline) lights this up.
    assert "state_data:/ctrl-data:ro" in compose, (
        "init service must mount state_data at /ctrl-data:ro so "
        "render_mcp_servers.py can read tool_disposition."
    )
    # Pin the matching STATE_DB_PATH env var on the init service too.
    assert "STATE_DB_PATH=/ctrl-data/alfred-state.db" in compose, (
        "init service must set STATE_DB_PATH=/ctrl-data/alfred-state.db "
        "matching the mount above."
    )


def test_multiple_servers_delegated_at_once(tmp_path: Path, render_module):
    """sure + paperclip + hass all DELEGATED — three blocks get tools.include: []
    in one render pass."""
    config = tmp_path / "config.yaml"
    config.write_text(_PRE_PHASE_B_CONFIG, encoding="utf-8")
    state_db = tmp_path / "alfred-state.db"
    _seed_state_db(
        state_db,
        {"sure": "delegated", "paperclip": "delegated", "hass": "delegated"},
    )

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="main",
        mcp_stdio_dir="/opt/data/profiles/main/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
        state_db_path=state_db,
    )
    assert outcome == "added"

    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    for s in ("sure", "paperclip", "hass"):
        assert data["mcp_servers"][s]["tools"]["include"] == [], (
            f"{s} should have tools.include: [] after the disposition pass"
        )
    # alfred + alfred-ctrl + files stayed DIRECT.
    for s in ("alfred", "alfred-ctrl", "files"):
        block = data["mcp_servers"][s]
        if "tools" in block:
            assert block["tools"].get("include") != []
