"""Background profiles must have no channel authority (#288).

The vault-janitor's repair pipeline reached for `spawn_alfred_task` — a tool
that schedules a one-shot cron whose reply is delivered to the principal's
most-recent channel. 13 raw failure dumps landed in Sir's Slack in one day,
and because the repairs could never succeed the next sweep re-spawned them.

Prompt-level "[SILENT] if nothing to report" cannot prevent that: a failure
always looks report-worthy, so failures always delivered. The guarantee has to
be structural — the capability is removed from the profiles that run
unattended agents, so a background agent cannot reach a channel even if it
decides to.

These tests render the real template, so they fail if the guard is ever
dropped or the tool list drifts.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

HERMES = Path(__file__).resolve().parent.parent
SCRIPT = HERMES / "init" / "render_hermes.py"

# Tools that can put text in front of the principal without them asking.
CHANNEL_TOOLS = ("spawn_alfred_task", "notify_principal")

# Profiles that run unattended agents. main is the principal's own chat.
BACKGROUND_PROFILES = ("workers", "heavy")


def _render(profile: str, out_dir: Path, port: str | None = None) -> dict:
    env = dict(os.environ)
    env.setdefault("OPENROUTER_API_KEY", "test-or-key")
    env.setdefault("AAS_API_KEY", "test-aas")
    if port:
        env["HERMES_RENDER_PORT"] = port
    result = subprocess.run(
        [sys.executable, str(SCRIPT), profile, str(out_dir), str(HERMES), "test-token"],
        env=env, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    return yaml.safe_load((out_dir / "config.yaml").read_text(encoding="utf-8"))


@pytest.mark.parametrize("profile", BACKGROUND_PROFILES)
def test_background_profiles_exclude_channel_tools(profile: str, tmp_path: Path):
    cfg = _render(profile, tmp_path)
    alfred = (cfg.get("mcp_servers") or {}).get("alfred")
    assert alfred, f"{profile} should still register the alfred MCP server"
    excluded = ((alfred.get("tools") or {}).get("exclude")) or []
    for tool in CHANNEL_TOOLS:
        assert tool in excluded, (
            f"{profile} can still call {tool} — a background agent must not be "
            f"able to reach the principal's channel (#288)"
        )


@pytest.mark.parametrize("profile", BACKGROUND_PROFILES)
def test_background_profiles_keep_the_vault_surface(profile: str, tmp_path: Path):
    """Removing channel authority must not remove the ability to do the work."""
    cfg = _render(profile, tmp_path)
    alfred = (cfg.get("mcp_servers") or {})["alfred"]
    excluded = ((alfred.get("tools") or {}).get("exclude")) or []
    for tool in (
        "get_vault_record",
        "update_vault_record",
        "create_vault_record",
        "search_vault",
    ):
        assert tool not in excluded, f"{profile} lost {tool} — it cannot do its job"


def test_main_keeps_channel_tools(tmp_path: Path):
    """main IS the principal-facing chat. "Tell Alfred to post X to Slack" has
    to keep working — this fix must not silence the surface Sir talks to."""
    cfg = _render("main", tmp_path)
    alfred = (cfg.get("mcp_servers") or {})["alfred"]
    excluded = ((alfred.get("tools") or {}).get("exclude")) or []
    for tool in CHANNEL_TOOLS:
        assert tool not in excluded, f"main must retain {tool}"


def test_user_facing_profiles_are_main_like(tmp_path: Path):
    """A user-facing profile (cratchit et al.) is a conversational Alfred, so
    it keeps channel tools — the exclusion targets unattended agents only."""
    cfg = _render("cratchit", tmp_path, port="18794")
    alfred = (cfg.get("mcp_servers") or {})["alfred"]
    excluded = ((alfred.get("tools") or {}).get("exclude")) or []
    for tool in CHANNEL_TOOLS:
        assert tool not in excluded, f"user-facing profile must retain {tool}"
