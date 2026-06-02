"""Tests for the #120 Lane II changes to render_hermes.py.

Pins:
  1. _KNOWN_PROFILES allowlist is gone — any slug matching the regex
     ^[a-z][a-z0-9-]{1,30}$ is accepted.
  2. HERMES_RENDER_PORT overrides the canonical port for ANY slug;
     required for user-facing slugs (those not in _RESERVED_PORT).
  3. A non-reserved slug WITHOUT HERMES_RENDER_PORT errors out — never
     silently defaults to a reserved port.
  4. The four reserved slugs still work without HERMES_RENDER_PORT
     (back-compat with every existing caller).
  5. Bad-shape slugs are rejected with a clear error.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

HERMES = Path(__file__).resolve().parent.parent
SCRIPT = HERMES / "init" / "render_hermes.py"


def _run(args: list[str], env_overrides: dict[str, str] | None = None):
    env = dict(os.environ)
    # Provide the bare-minimum env so the templates render. Tests do not
    # need real keys; just non-empty placeholders for the env-block render.
    env.setdefault("OPENROUTER_API_KEY", "test-or-key")
    env.setdefault("AAS_API_KEY", "test-aas")
    if env_overrides:
        env.update(env_overrides)
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        env=env,
        capture_output=True,
        text=True,
    )


def test_reserved_main_still_works_without_port_override(tmp_path: Path):
    """Back-compat: every existing caller passes no HERMES_RENDER_PORT for
    the reserved profiles. The script must still resolve main → 18789."""
    out = _run(["main", str(tmp_path), str(HERMES), "test-token"])
    assert out.returncode == 0, out.stderr
    env_text = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "API_SERVER_PORT=18789" in env_text


def test_user_facing_slug_with_port_override_renders(tmp_path: Path):
    """A user-facing profile slug (not in the reserved set) + an explicit
    HERMES_RENDER_PORT must render successfully."""
    out = _run(
        ["cratchit", str(tmp_path), str(HERMES), "test-token"],
        env_overrides={"HERMES_RENDER_PORT": "18794"},
    )
    assert out.returncode == 0, out.stderr
    env_text = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "API_SERVER_PORT=18794" in env_text
    # Conversational profile gets main-like config (provider: openrouter).
    cfg_text = (tmp_path / "config.yaml").read_text(encoding="utf-8")
    assert "provider:" in cfg_text


def test_user_facing_slug_without_port_override_errors(tmp_path: Path):
    """A non-reserved slug without HERMES_RENDER_PORT must error with a
    clear message, not silently default to a reserved port."""
    out = _run(
        ["sentinel", str(tmp_path), str(HERMES), "test-token"],
    )
    assert out.returncode != 0
    assert "HERMES_RENDER_PORT" in out.stderr
    assert "sentinel" in out.stderr


def test_invalid_slug_shape_rejected(tmp_path: Path):
    """A slug not matching ^[a-z][a-z0-9-]{1,30}$ must error fast."""
    out = _run(
        ["1bad", str(tmp_path), str(HERMES), "test-token"],
        env_overrides={"HERMES_RENDER_PORT": "18794"},
    )
    assert out.returncode != 0
    assert "1bad" in out.stderr


def test_model_override_lands_in_config(tmp_path: Path):
    """HERMES_RENDER_MODEL must be the model in the rendered config.yaml
    for a user-facing profile."""
    out = _run(
        ["sentinel", str(tmp_path), str(HERMES), "test-token"],
        env_overrides={
            "HERMES_RENDER_PORT": "18795",
            "HERMES_RENDER_MODEL": "anthropic/claude-opus-4-6",
        },
    )
    assert out.returncode == 0, out.stderr
    cfg_text = (tmp_path / "config.yaml").read_text(encoding="utf-8")
    assert "anthropic/claude-opus-4-6" in cfg_text


def test_codex_builder_still_renders_with_fallback_port(tmp_path: Path):
    """codex-builder is reserved at 18793 — back-compat path must keep
    working without HERMES_RENDER_PORT."""
    out = _run(["codex-builder", str(tmp_path), str(HERMES), "test-token"])
    assert out.returncode == 0, out.stderr
    env_text = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "API_SERVER_PORT=18793" in env_text
