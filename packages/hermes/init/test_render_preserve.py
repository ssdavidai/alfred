"""Tests for the runtime-key preservation logic in render_hermes.py.

The 2026-05-25 Sir-incident: `docker compose up -d --no-deps init` wiped
Sir's manually-set TELEGRAM_BOT_TOKEN from $HERMES_HOME/profiles/main/.env,
causing the delegate-completion message to fail with "no TELEGRAM_BOT_TOKEN".
These tests pin the merge-preserve behaviour so it can't regress.

Covered:
  1. When the existing .env has TELEGRAM_* keys (set by the /channels UI)
     and the rendered template does NOT, the keys are appended to the
     output verbatim.
  2. When the rendered template DOES set a key (e.g. OPENROUTER_API_KEY),
     the existing value is NOT carried over — the template wins.
  3. When the existing file is missing, the function returns the rendered
     output unchanged (no errors).
  4. The preserved-key allowlist is enforced — a key like
     `MY_RANDOM_EDIT=foo` in the existing file is NOT preserved.
  5. CRLF tolerance + quote stripping in the parser.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make the module importable without installing.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from render_hermes import (  # type: ignore
    _RUNTIME_KEY_PREFIXES,
    _merge_preserve_runtime_keys,
    _parse_env_keys,
)


def test_parse_env_keys_basic(tmp_path: Path) -> None:
    text = "FOO=bar\nBAZ=qux\n# comment\nEMPTY=\n"
    assert _parse_env_keys(text) == {"FOO": "bar", "BAZ": "qux", "EMPTY": ""}


def test_parse_env_keys_strips_quotes() -> None:
    text = 'FOO="quoted"\nBAR=\'single\'\nBAZ=unquoted\n'
    p = _parse_env_keys(text)
    assert p["FOO"] == "quoted"
    assert p["BAR"] == "single"
    assert p["BAZ"] == "unquoted"


def test_parse_env_keys_tolerates_crlf_and_export() -> None:
    text = "export FOO=bar\r\nBAZ=qux\r\n"
    p = _parse_env_keys(text)
    assert p["FOO"] == "bar"
    assert p["BAZ"] == "qux"


def test_merge_preserves_telegram_keys_from_existing_env(tmp_path: Path) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text(
        "OPENROUTER_API_KEY=oldkey\n"
        "TELEGRAM_BOT_TOKEN=12345:abcdef\n"
        "TELEGRAM_ALLOWED_USERS=432094090\n"
        "TELEGRAM_HOME_CHANNEL=432094090\n"
    )
    rendered = (
        "API_SERVER_PORT=18789\n"
        "OPENROUTER_API_KEY=newkey\n"  # template overrides
    )
    out = _merge_preserve_runtime_keys(rendered, env_path)

    # Template's value for OPENROUTER_API_KEY wins.
    parsed = _parse_env_keys(out)
    assert parsed["OPENROUTER_API_KEY"] == "newkey"
    # All three TELEGRAM_ keys preserved.
    assert parsed["TELEGRAM_BOT_TOKEN"] == "12345:abcdef"
    assert parsed["TELEGRAM_ALLOWED_USERS"] == "432094090"
    assert parsed["TELEGRAM_HOME_CHANNEL"] == "432094090"
    # The preservation block is appended with a clear header comment.
    assert "preserved across init re-renders" in out


def test_no_existing_env_returns_rendered_unchanged(tmp_path: Path) -> None:
    env_path = tmp_path / ".env"  # does not exist
    rendered = "API_SERVER_PORT=18789\n"
    assert _merge_preserve_runtime_keys(rendered, env_path) == rendered


def test_non_allowlisted_keys_are_not_preserved(tmp_path: Path) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text("MY_RANDOM_EDIT=foo\nSOME_LEGACY=bar\n")
    rendered = "API_SERVER_PORT=18789\n"
    out = _merge_preserve_runtime_keys(rendered, env_path)
    parsed = _parse_env_keys(out)
    assert "MY_RANDOM_EDIT" not in parsed
    assert "SOME_LEGACY" not in parsed


def test_all_runtime_prefixes_are_picked_up(tmp_path: Path) -> None:
    """Sanity: at least one key per runtime prefix preserved when present."""
    env_path = tmp_path / ".env"
    lines = []
    for prefix in _RUNTIME_KEY_PREFIXES:
        lines.append(f"{prefix}SAMPLE=value-for-{prefix.lower()}")
    env_path.write_text("\n".join(lines) + "\n")
    rendered = "API_SERVER_PORT=18789\n"
    out = _merge_preserve_runtime_keys(rendered, env_path)
    parsed = _parse_env_keys(out)
    for prefix in _RUNTIME_KEY_PREFIXES:
        key = f"{prefix}SAMPLE"
        assert key in parsed, f"{key} should be preserved (prefix={prefix})"


def test_template_takes_precedence_for_allowlisted_keys(tmp_path: Path) -> None:
    """Even within the allowlist, the template ALWAYS wins if it sets the key.
    Prevents stale runtime values from outranking new template defaults.
    """
    env_path = tmp_path / ".env"
    env_path.write_text("TELEGRAM_BOT_TOKEN=stale-token\n")
    rendered = "TELEGRAM_BOT_TOKEN=template-set\n"
    out = _merge_preserve_runtime_keys(rendered, env_path)
    parsed = _parse_env_keys(out)
    assert parsed["TELEGRAM_BOT_TOKEN"] == "template-set"
