"""Retired-MCP-server removal + deployment conformance (#314).

Plane was retired fleet-wide in #279, but `config.yaml` is operator-owned:
removing the server from the template never removed it from tenants that were
already provisioned. Hermes therefore kept spawning a stdio server whose
backend no longer exists —

    WARNING tools.mcp_tool: MCP server 'plane' failed initial connection
    after 3 attempts, giving up

— on every profile, on every startup. The mutator gains a REMOVE pass so a
retired capability actually leaves the deployed fleet.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest

HERMES = Path(__file__).resolve().parent.parent
RENDER_SCRIPT = HERMES / "init" / "render_mcp_servers.py"
TEMPLATE = HERMES / "hermes-config.yaml.njk"
COMPOSE = HERMES.parent.parent / "docker-compose.yaml"


@pytest.fixture
def render_module():
    pytest.importorskip("ruamel.yaml")
    spec = importlib.util.spec_from_file_location("render_mcp_servers", RENDER_SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _config_with_plane() -> str:
    """An operator-owned config as it actually exists on deployed tenants."""
    return (
        "model:\n"
        "  provider: openrouter\n"
        "mcp_servers:\n"
        "  alfred-ctrl:\n"
        "    type: http\n"
        "    url: http://ctrl-api:3100/mcp\n"
        "  alfred:\n"
        "    command: node\n"
        "    args: ['/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js', 'alfred']\n"
        "  plane:\n"
        "    command: node\n"
        "    args: ['/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js', 'plane']\n"
        "  vaultwarden:\n"
        "    command: node\n"
        "    args: ['/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js', 'vaultwarden']\n"
    )


def _run(mod, config: Path, profile: str) -> str:
    return mod.ensure_mcp_servers(
        config,
        profile=profile,
        mcp_stdio_dir=f"/opt/data/profiles/{profile}/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
    )


@pytest.mark.parametrize("profile", ["main", "workers", "heavy"])
def test_retired_plane_is_removed_from_every_profile(tmp_path, render_module, profile):
    """The bug: `heavy` has no required-server allowlist and returned before
    any mutation, so it would have kept `plane` forever."""
    config = tmp_path / "config.yaml"
    config.write_text(_config_with_plane(), encoding="utf-8")

    _run(render_module, config, profile)

    text = config.read_text()
    assert "plane:" not in text, f"{profile} still registers the retired plane server"
    # Everything else the operator owns must survive untouched.
    assert "alfred-ctrl:" in text
    assert "vaultwarden:" in text


def test_removal_is_idempotent(tmp_path, render_module):
    """Second boot must be a no-op, not a rewrite loop."""
    config = tmp_path / "config.yaml"
    config.write_text(_config_with_plane(), encoding="utf-8")

    _run(render_module, config, "heavy")
    after_first = config.read_text()
    outcome = _run(render_module, config, "heavy")
    assert config.read_text() == after_first, "second run rewrote the file"
    assert outcome == "unknown-profile", "nothing left to remove → historical outcome"


def test_sealed_profile_is_never_touched(tmp_path, render_module):
    """codex-builder is sealed (mcp_servers: {}) — the REMOVE pass must not
    reach it, even though it runs on 'every non-sealed profile'."""
    config = tmp_path / "config.yaml"
    original = "mcp_servers: {}\n"
    config.write_text(original, encoding="utf-8")

    assert _run(render_module, config, "codex-builder") == "sealed"
    assert config.read_text() == original


def test_config_without_retired_server_is_byte_equal(tmp_path, render_module):
    """No retired key present → the REMOVE pass writes nothing.

    Uses `main`: it has no retired server here, and unlike heavy/workers it is
    not subject to the #288 channel-tool exclusion, so byte-equality isolates
    exactly the behaviour under test. (main's required servers are already in
    the fixture, so no ADD fires either.)
    """
    config = tmp_path / "config.yaml"
    original = _config_with_plane().replace(
        "  plane:\n"
        "    command: node\n"
        "    args: ['/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js', 'plane']\n",
        "",
    )
    config.write_text(original, encoding="utf-8")

    before = config.read_text()
    _run(render_module, config, "main")
    after = config.read_text()
    # main may gain required servers (hass/files/paperclip-admin) but must
    # never lose or rewrite anything on account of the retired-key pass.
    assert "plane:" not in after
    assert "alfred-ctrl:" in after and "vaultwarden:" in after
    assert before.count("alfred:") == after.count("alfred:")


def test_template_does_not_reintroduce_a_retired_server(render_module):
    """Deployment conformance: the template must not render a retired server,
    or init would remove it and the next render would add it straight back."""
    template = TEMPLATE.read_text(encoding="utf-8")
    # Only look at real registration keys, not prose in comments.
    registrations = re.findall(r"^\s{2}([a-z][a-z0-9-]*):\s*$", template, re.MULTILINE)
    for retired in render_module._RETIRED_MCP_SERVERS:
        assert retired not in registrations, (
            f"hermes-config.yaml.njk still renders a '{retired}' block that "
            f"render_mcp_servers.py would immediately delete"
        )


def test_retired_server_has_no_backing_compose_service(render_module):
    """The other half of conformance: a retired capability must not still have
    a deployed service (that would mean it was retired by mistake)."""
    compose = COMPOSE.read_text(encoding="utf-8")
    services = re.findall(r"^  ([a-z][a-z0-9-]*):\s*$", compose, re.MULTILINE)
    for retired in render_module._RETIRED_MCP_SERVERS:
        assert retired not in services, (
            f"'{retired}' is marked retired but docker-compose.yaml still "
            f"declares the service"
        )
