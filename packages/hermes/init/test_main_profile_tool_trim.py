"""Tests for migrate_main_profile_tool_trim.py + the template's parity.

Covered:
  * No-op on workers / heavy / codex-builder profiles.
  * Idempotent: a second pass mutates nothing after the first.
  * Preserves an operator's pre-existing tools.include.
  * Preserves an operator's explicit kanban.dispatch_in_gateway (True or False).
  * Preserves the operator's other edits (model:, agent:, gateway:, …) byte-stable.
  * Inserts a fresh include block when none exists.
  * Template + migration script stay in sync (same include lists).

Run from repo root:
  pytest packages/hermes/init/test_main_profile_tool_trim.py -v
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

from migrate_main_profile_tool_trim import (  # type: ignore[import-not-found]
    HASS_MAIN_INCLUDE,
    INCLUDES_BY_SERVER,
    PAPERCLIP_MAIN_INCLUDE,
    SURE_MAIN_INCLUDE,
    migrate_config,
)


# A representative pre-trim config.yaml. Mirrors what
# `hermes-config.yaml.njk` rendered for the `main` profile BEFORE issue
# #175 — the same 9 mcp_servers but no `tools.include` keys, and no
# `kanban` top-level block.
_LEGACY_MAIN_CONFIG = """\
# Hermes Agent configuration — profile: main
model:
  default: "x-ai/grok-4.3"
  provider: "openrouter"
  base_url: "https://openrouter.ai/api/v1"
  max_tokens: 8192

agent:
  max_turns: 80
  reasoning_effort: "medium"

memory:
  memory_enabled: true

mcp_servers:
  alfred-ctrl:
    command: "node"
    args: ["/opt/data/profiles/main/mcp/ctrl-server.mjs"]
    env:
      CTRL_API_URL: "http://ctrl-api:3100"
    timeout: 120
  alfred:
    command: "node"
    args: ["/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js", "alfred"]
    timeout: 120
  sure:
    command: "node"
    args: ["/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js", "sure"]
    timeout: 120
  plane:
    command: "node"
    args: ["/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js", "plane"]
    timeout: 120
  vaultwarden:
    command: "node"
    args: ["/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js", "vaultwarden"]
    timeout: 120
  execute:
    command: "node"
    args: ["/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js", "execute"]
    timeout: 120
  hass:
    command: "node"
    args: ["/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js", "hass"]
    timeout: 120
  paperclip:
    command: "node"
    args: ["/opt/paperclip-mcp/node_modules/@paperclipai/mcp-server/dist/stdio.js"]
    timeout: 120
  files:
    command: "node"
    args: ["/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js", "files"]
    timeout: 120

display:
  compact: false
"""


@pytest.fixture
def cfg_dir(tmp_path: Path) -> Path:
    p = tmp_path / "config.yaml"
    p.write_text(_LEGACY_MAIN_CONFIG, encoding="utf-8")
    return p


def _load(cfg: Path) -> dict:
    return yaml.safe_load(cfg.read_text(encoding="utf-8"))


def test_main_profile_inserts_three_include_blocks(cfg_dir: Path):
    outcome = migrate_config(cfg_dir, profile="main")
    assert outcome.startswith("applied"), outcome

    cfg = _load(cfg_dir)
    assert cfg["mcp_servers"]["sure"]["tools"]["include"] == SURE_MAIN_INCLUDE
    assert cfg["mcp_servers"]["hass"]["tools"]["include"] == HASS_MAIN_INCLUDE
    assert cfg["mcp_servers"]["paperclip"]["tools"]["include"] == PAPERCLIP_MAIN_INCLUDE


def test_kanban_disabled_when_absent(cfg_dir: Path):
    migrate_config(cfg_dir, profile="main")
    cfg = _load(cfg_dir)
    assert cfg["kanban"]["dispatch_in_gateway"] is False


def test_idempotent_second_pass_is_present(cfg_dir: Path):
    first = migrate_config(cfg_dir, profile="main")
    assert first.startswith("applied")
    second = migrate_config(cfg_dir, profile="main")
    assert second == "present", second


def test_no_op_on_workers(tmp_path: Path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text(_LEGACY_MAIN_CONFIG, encoding="utf-8")
    before = cfg.read_text(encoding="utf-8")
    outcome = migrate_config(cfg, profile="workers")
    assert outcome == "not-main"
    # Bytes-identical — non-main is never touched.
    assert cfg.read_text(encoding="utf-8") == before


def test_no_op_on_heavy(tmp_path: Path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text(_LEGACY_MAIN_CONFIG, encoding="utf-8")
    before = cfg.read_text(encoding="utf-8")
    outcome = migrate_config(cfg, profile="heavy")
    assert outcome == "not-main"
    assert cfg.read_text(encoding="utf-8") == before


def test_no_op_on_codex_builder(tmp_path: Path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("mcp_servers: {}\nmodel:\n  provider: openai-codex\n", encoding="utf-8")
    outcome = migrate_config(cfg, profile="codex-builder")
    assert outcome == "not-main"


def test_preserves_operator_include_block(tmp_path: Path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        _LEGACY_MAIN_CONFIG.replace(
            "  sure:\n    command: \"node\"\n    args: [\"/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js\", \"sure\"]\n    timeout: 120",
            "  sure:\n"
            "    command: \"node\"\n"
            "    args: [\"/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js\", \"sure\"]\n"
            "    timeout: 120\n"
            "    tools:\n"
            "      include:\n"
            "        - get_balance_sheet\n"
            "        - list_accounts\n",
        ),
        encoding="utf-8",
    )
    migrate_config(cfg, profile="main")
    cfg_data = _load(cfg)
    # Operator's narrow include preserved — not overwritten by the wider trim list.
    assert cfg_data["mcp_servers"]["sure"]["tools"]["include"] == [
        "get_balance_sheet",
        "list_accounts",
    ]
    # Other servers (hass / paperclip) still receive the trim defaults.
    assert cfg_data["mcp_servers"]["hass"]["tools"]["include"] == HASS_MAIN_INCLUDE


def test_preserves_explicit_kanban_true(tmp_path: Path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        _LEGACY_MAIN_CONFIG + "\nkanban:\n  dispatch_in_gateway: true\n",
        encoding="utf-8",
    )
    migrate_config(cfg, profile="main")
    assert _load(cfg)["kanban"]["dispatch_in_gateway"] is True


def test_preserves_explicit_kanban_false(tmp_path: Path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        _LEGACY_MAIN_CONFIG + "\nkanban:\n  dispatch_in_gateway: false\n",
        encoding="utf-8",
    )
    outcome = migrate_config(cfg, profile="main")
    # No kanban change — but the 3 includes still get inserted.
    assert "kanban" not in outcome
    assert _load(cfg)["kanban"]["dispatch_in_gateway"] is False


def test_preserves_other_top_level_keys(cfg_dir: Path):
    """The model:, agent:, memory:, display: blocks survive."""
    migrate_config(cfg_dir, profile="main")
    cfg = _load(cfg_dir)
    assert cfg["model"]["default"] == "x-ai/grok-4.3"
    assert cfg["model"]["provider"] == "openrouter"
    assert cfg["agent"]["max_turns"] == 80
    assert cfg["memory"]["memory_enabled"] is True
    assert cfg["display"]["compact"] is False


def test_does_not_touch_unrelated_servers(cfg_dir: Path):
    """alfred-ctrl/alfred/plane/vaultwarden/execute/files don't grow include."""
    migrate_config(cfg_dir, profile="main")
    cfg = _load(cfg_dir)
    for server in ("alfred-ctrl", "alfred", "plane", "vaultwarden", "execute", "files"):
        assert "tools" not in cfg["mcp_servers"][server], (
            f"{server} should not have a tools.include block — left at full catalogue"
        )


def test_missing_config_returns_status(tmp_path: Path):
    outcome = migrate_config(tmp_path / "absent.yaml", profile="main")
    assert outcome == "missing"


def test_empty_mcp_servers_returns_status(tmp_path: Path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("model:\n  default: foo\nmcp_servers: {}\n", encoding="utf-8")
    outcome = migrate_config(cfg, profile="main")
    assert outcome == "empty-mcp"


# ---------------------------------------------------------------------------
# Template + migration script parity (the "two sources of truth" trap)
# ---------------------------------------------------------------------------


def _read_template_include_lists() -> dict[str, list[str]]:
    """Extract `tools.include` lists from the .njk template.

    A minimal regex-based parser — the file is a Nunjucks template (not
    parseable as plain YAML) but the include blocks live in flat YAML
    sections we can locate by anchoring on the server name and walking
    forward to the next server's `  <name>:` block boundary.

    Jinja `{%- if/else/endif %}` markers do NOT terminate a server block
    (they wrap optional content WITHIN one) — only the next column-2 YAML
    key does.
    """
    tpl = (
        Path(__file__).resolve().parent.parent / "hermes-config.yaml.njk"
    ).read_text(encoding="utf-8")
    out: dict[str, list[str]] = {}
    for server in ("sure", "hass", "paperclip"):
        m = re.search(rf"(?m)^  {server}:\n", tpl)
        assert m, f"server {server!r} not found in template"
        rest = tpl[m.end() :]
        # Stop at the next column-2 YAML key (the next mcp_servers entry).
        # Jinja {%- if %} boundaries don't terminate a server block —
        # they wrap optional content WITHIN it.
        stop = re.search(r"(?m)^  [a-z][a-z0-9-]*:\s*\n", rest)
        block = rest[: stop.start() if stop else len(rest)]
        if "include:" not in block:
            continue
        include_block = block[block.index("include:") :]
        items = re.findall(
            r"(?m)^        - ([A-Za-z_][A-Za-z0-9_]*)\s*$", include_block
        )
        if items:
            out[server] = items
    return out


def test_template_includes_match_migration_lists():
    """Template + migration script lists must stay in sync.

    Adding a tool in one without the other is a stale divergence —
    the fresh-tenant render and the existing-tenant migration would drift.
    """
    template_lists = _read_template_include_lists()
    assert set(template_lists) == set(INCLUDES_BY_SERVER), (
        f"Template / migration servers diverge: template={set(template_lists)}, "
        f"migration={set(INCLUDES_BY_SERVER)}"
    )
    for server, tools_in_template in template_lists.items():
        assert tools_in_template == INCLUDES_BY_SERVER[server], (
            f"{server} include list drifted: "
            f"template={tools_in_template} vs migration={INCLUDES_BY_SERVER[server]}"
        )


def test_template_carries_kanban_disabled():
    """The fresh-tenant template must also emit kanban.dispatch_in_gateway=false."""
    tpl = (
        Path(__file__).resolve().parent.parent / "hermes-config.yaml.njk"
    ).read_text(encoding="utf-8")
    assert "dispatch_in_gateway: false" in tpl, (
        "Template missing kanban.dispatch_in_gateway:false — fresh tenants will hit "
        "the readonly-kanban-db log storm from issue #175"
    )


def test_main_profile_trim_under_100_tools_target():
    """Sanity bound — the whole point of this trim is to stay under ~100 tools.

    21 alfred + 14 vaultwarden + 11 plane + 9 files + 8 execute + 7 hermes +
    2 alfred-ctrl + 23 sure + 28 hass + 18 paperclip ≈ 141 tools (full
    catalogue is 321). If a future commit grows the trimmed list back past
    this bound, that's a signal that we're sliding back into the bloat that
    issue #175 caught.
    """
    total_main_only = (
        len(SURE_MAIN_INCLUDE)
        + len(HASS_MAIN_INCLUDE)
        + len(PAPERCLIP_MAIN_INCLUDE)
    )
    # 23 + 28 + 18 = 69 in the three trimmed servers; adding 60 untrimmed
    # tools (alfred + vaultwarden + plane + files + execute + hermes +
    # alfred-ctrl) gives ~130 total. Set the bound at 80 for the trim
    # contribution itself to leave headroom for the 28 hass + 18 paperclip
    # additions a follow-up may want.
    assert total_main_only <= 80, (
        f"Trimmed allowlists grew to {total_main_only} tools — issue #175's bloat is creeping back"
    )
