"""Tests for the telegram-gateway init step.

Hermes' built-in Telegram platform (`gateway/platforms/telegram.py`) is
enabled iff config.yaml has a `gateway.platforms.telegram` block, with
the bot token picked up natively from `TELEGRAM_BOT_TOKEN` (see
`gateway/config.py:1194,1243`). `render_hermes.py` is seed-only —
config.yaml is operator-owned and never re-rendered — so an idempotent
mutator (`render_telegram_gateway.py`) backfills the block on every
init boot and preserves any operator-set values inside it.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

HERMES = Path(__file__).resolve().parent.parent
ENTRYPOINT = HERMES / "init" / "entrypoint.sh"
RENDER_SCRIPT = HERMES / "init" / "render_telegram_gateway.py"
REPO_ROOT = HERMES.parent.parent


# --- entrypoint.sh static-text pins ------------------------------------------
def test_entrypoint_invokes_telegram_gateway_step():
    src = ENTRYPOINT.read_text()
    assert "render_telegram_gateway.py" in src
    assert 'MAIN_PROFILE_DIR="$HERMES_DATA_DIR/profiles/main"' in src, (
        "Step must target the main profile only (workers/heavy run no channels)."
    )
    assert 'if [[ -f "$MAIN_PROFILE_DIR/config.yaml" ]]; then' in src, (
        "Step must guard for missing config.yaml so init never aborts on fresh boot."
    )


def test_entrypoint_telegram_step_ordering():
    """Runs AFTER render_hermes (which seeds config.yaml) and BEFORE the
    recursive chown (so the mutated file lands with hermes uid)."""
    src = ENTRYPOINT.read_text()
    render_idx = src.find("python3 /setup/render_hermes.py")
    telegram_idx = src.find("python3 /setup/render_telegram_gateway.py")
    chown_idx = src.find('chown -R 10000:10000 "$HERMES_DATA_DIR"')
    assert 0 < render_idx < telegram_idx < chown_idx


# --- mutator behaviour -------------------------------------------------------
def _load_render_module():
    spec = importlib.util.spec_from_file_location(
        "render_telegram_gateway", RENDER_SCRIPT
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def render_module():
    pytest.importorskip(
        "ruamel.yaml",
        reason="ruamel.yaml is the round-trip mutator the init image installs.",
    )
    return _load_render_module()


def test_added_when_block_absent(tmp_path: Path, render_module):
    config = tmp_path / "config.yaml"
    config.write_text(
        'model:\n  default: "x-ai/grok-4.3"\nagent:\n  max_turns: 80\n',
        encoding="utf-8",
    )

    assert render_module.ensure_telegram_gateway_block(config) == "added"

    from ruamel.yaml import YAML

    data = YAML().load(config.read_text())
    assert data["gateway"]["platforms"]["telegram"]["enabled"] is True
    assert data["gateway"]["platforms"]["telegram"]["token_env"] == "TELEGRAM_BOT_TOKEN"
    # Other keys preserved.
    assert data["model"]["default"] == "x-ai/grok-4.3"
    assert data["agent"]["max_turns"] == 80


def test_noop_when_block_already_present(tmp_path: Path, render_module):
    original = (
        "model:\n  default: x\n"
        "gateway:\n  platforms:\n    telegram:\n"
        "      enabled: true\n      token_env: TELEGRAM_BOT_TOKEN\n"
    )
    config = tmp_path / "config.yaml"
    config.write_text(original, encoding="utf-8")

    assert render_module.ensure_telegram_gateway_block(config) == "present"
    assert config.read_text() == original  # byte-identical


def test_operator_disabled_block_preserved(tmp_path: Path, render_module):
    """An operator-disabled block (enabled: false) MUST survive — the
    mutator is ADD-only, never an enforce-on-true overwrite."""
    config = tmp_path / "config.yaml"
    config.write_text(
        "gateway:\n  platforms:\n    telegram:\n      enabled: false\n",
        encoding="utf-8",
    )

    assert render_module.ensure_telegram_gateway_block(config) == "present"

    from ruamel.yaml import YAML

    data = YAML().load(config.read_text())
    assert data["gateway"]["platforms"]["telegram"]["enabled"] is False
    # Did NOT inject token_env on top of the operator's block.
    assert "token_env" not in data["gateway"]["platforms"]["telegram"]


def test_no_config_returns_cleanly(tmp_path: Path, render_module):
    """When config.yaml is absent, the mutator MUST return cleanly — the
    entrypoint step is best-effort and must never abort init."""
    assert (
        render_module.ensure_telegram_gateway_block(tmp_path / "missing.yaml")
        == "no-config"
    )


# --- docker-compose passthrough ---------------------------------------------
def test_docker_compose_passes_telegram_bot_token_to_hermes():
    compose = (REPO_ROOT / "docker-compose.yaml").read_text()
    assert "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}" in compose, (
        "docker-compose must forward TELEGRAM_BOT_TOKEN to hermes with a "
        "`:-` default so an unset token does not crash boot."
    )
