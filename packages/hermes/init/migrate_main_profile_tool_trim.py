"""migrate_main_profile_tool_trim.py — trim main-profile MCP catalogue.

Issue #175 (2026-05-30) found Hermes-main's `/v1/responses` carrying
~67 k input tokens per turn — the JSON-Schema for every tool inlines into
the system prompt, and the main profile was exposing 321 MCP tools (95
sure, 85 hass, 40 paperclip + the smaller servers). Every Hermes turn paid
3-5 s of LLM TTFT just to digest the catalogue, and multi-turn tool
cascades (the calendar query alone took 8 turns × 16 tool calls) blew
past the voice-bridge's 90 s budget.

The fix lives in `hermes-config.yaml.njk` as
`mcp_servers.{sure,hass,paperclip}.tools.include` whitelists. But
`config.yaml` is OPERATOR-OWNED (`render_hermes.py` only SEEDS it when
absent), so the template change doesn't take effect on EXISTING tenants
until someone surgically patches the on-disk file. This script is that
patch, modelled on `render_mcp_servers.py`:

  * idempotent — safe to re-run on every init boot
  * ADD-only — never deletes or rewrites the operator's other edits
  * preserves an existing `tools.include` block (the operator's choice
    trumps ours; we only seed when absent)
  * preserves an existing `kanban.dispatch_in_gateway` setting (an
    operator may explicitly opt back in)

Uses `ruamel.yaml` (same as render_mcp_servers.py) so comments + key
ordering survive the round-trip.

CLI:
  migrate_main_profile_tool_trim.py <profile>
  env: PROFILE_DIR

Returns one of {applied, present, empty-mcp, not-main} as a one-line
status to stderr.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Include lists — these are the MAIN-profile-only whitelists. Workers /
# heavy / codex-builder keep their template-default catalogues (workers
# already runs a different, narrower use case; heavy doesn't carry hass
# or files; codex-builder is sealed with mcp_servers: {}).
#
# Keep IN SYNC with hermes-config.yaml.njk — the template seeds the same
# list on fresh tenants. Adding a tool to one without the other is a
# stale divergence; the test suite enforces parity.
# ---------------------------------------------------------------------------

SURE_MAIN_INCLUDE = [
    "get_balance_sheet",
    "list_accounts",
    "create_manual_account",
    "update_account",
    "list_transactions",
    "get_transaction",
    "bulk_update_transactions",
    "bulk_delete_transactions",
    "list_categories",
    "list_merchants",
    "list_tags",
    "list_rules",
    "update_budget_category",
    "find_or_bootstrap_budget",
    "list_holdings",
    "get_holding",
    "list_trades",
    "get_trade",
    "list_imports",
    "create_export",
    "trigger_sync",
    "cluster_transactions",
    "identify_recurring_patterns",
]

HASS_MAIN_INCLUDE = [
    "ha__connection_status",
    "ha__list_entities",
    "ha__get_state",
    "ha__get_history",
    "ha__get_logbook",
    "ha__list_areas",
    "ha__list_devices",
    "ha__list_automations",
    "ha__list_scripts",
    "ha__get_calendars",
    "ha__resolve_entity",
    "ha__call_service",
    "ha__propose_automation",
    "ha__apply_proposal",
    "ha__rollback_snapshot",
    "ha__subscribe_events",
    "ha__list_automations_full",
    "ha__create_automation",
    "ha__update_automation",
    "ha__delete_automation",
    "ha__create_scene",
    "ha__update_scene",
    "ha__delete_scene",
    "ha__create_script",
    "ha__update_script",
    "ha__delete_script",
    "ha__core_version",
    "ha__core_check_config",
]

PAPERCLIP_MAIN_INCLUDE = [
    "paperclipMe",
    "paperclipInboxLite",
    "paperclipListIssues",
    "paperclipGetIssue",
    "paperclipGetHeartbeatContext",
    "paperclipCreateIssue",
    "paperclipUpdateIssue",
    "paperclipListComments",
    "paperclipAddComment",
    "paperclipListApprovals",
    "paperclipCreateApproval",
    "paperclipGetApproval",
    "paperclipApprovalDecision",
    "paperclipListProjects",
    "paperclipGetProject",
    "paperclipListAgents",
    "paperclipGetAgent",
    "paperclipListGoals",
]

INCLUDES_BY_SERVER = {
    "sure": SURE_MAIN_INCLUDE,
    "hass": HASS_MAIN_INCLUDE,
    "paperclip": PAPERCLIP_MAIN_INCLUDE,
}


def _ensure_include(server_cfg, include_list) -> bool:
    """Mutate `server_cfg` (a ruamel CommentedMap) to add tools.include.

    Returns True if a change was made. Idempotent: an existing include list
    is preserved verbatim.
    """
    tools_cfg = server_cfg.get("tools")
    if tools_cfg is not None and tools_cfg.get("include"):
        return False
    if tools_cfg is None:
        # Use ruamel's CommentedMap so we preserve YAML style downstream.
        from ruamel.yaml.comments import CommentedMap, CommentedSeq

        tools_cfg = CommentedMap()
        server_cfg["tools"] = tools_cfg
    from ruamel.yaml.comments import CommentedSeq

    seq = CommentedSeq(include_list)
    tools_cfg["include"] = seq
    return True


def _ensure_kanban_disabled(data) -> bool:
    """Add `kanban.dispatch_in_gateway: false` IFF the operator hasn't chosen.

    Preserves an explicit operator setting (True or False).
    """
    kanban = data.get("kanban")
    if kanban is not None and "dispatch_in_gateway" in kanban:
        return False
    if kanban is None:
        from ruamel.yaml.comments import CommentedMap

        kanban = CommentedMap()
        data["kanban"] = kanban
    kanban["dispatch_in_gateway"] = False
    return True


def migrate_config(config_path: Path, profile: str) -> str:
    """Apply the trim to `config_path`.

    Returns a status string: {not-main, missing, applied, present, empty-mcp}.
    """
    if profile != "main":
        return "not-main"
    if not config_path.exists():
        return "missing"

    from ruamel.yaml import YAML

    yaml = YAML()
    yaml.preserve_quotes = True

    text = config_path.read_text(encoding="utf-8")
    data = yaml.load(text)
    if not isinstance(data, dict):
        return "empty-mcp"

    mcp_servers = data.get("mcp_servers")
    if not isinstance(mcp_servers, dict) or not mcp_servers:
        return "empty-mcp"

    changed_servers = []
    for server_name, include_list in INCLUDES_BY_SERVER.items():
        server_cfg = mcp_servers.get(server_name)
        if not isinstance(server_cfg, dict):
            continue
        if _ensure_include(server_cfg, include_list):
            changed_servers.append(f"{server_name}({len(include_list)})")

    kanban_changed = _ensure_kanban_disabled(data)

    if not changed_servers and not kanban_changed:
        return "present"

    with config_path.open("w", encoding="utf-8") as f:
        yaml.dump(data, f)

    bits = []
    if changed_servers:
        bits.append("include: " + ", ".join(changed_servers))
    if kanban_changed:
        bits.append("kanban.dispatch_in_gateway=false")
    return "applied " + "; ".join(bits)


def main() -> int:
    profile = (sys.argv[1] if len(sys.argv) > 1 else "").strip().lower()
    if not profile:
        print(
            "usage: migrate_main_profile_tool_trim.py <profile>\n"
            "  env: PROFILE_DIR",
            file=sys.stderr,
        )
        return 2

    profile_dir = Path(
        os.environ.get("PROFILE_DIR", f"/hermes-state/profiles/{profile}")
    )
    config = profile_dir / "config.yaml"

    try:
        outcome = migrate_config(config, profile)
    except Exception as exc:
        # Best-effort step; never abort init.
        print(f"[main-tool-trim] WARN {config}: {exc}", file=sys.stderr)
        return 0
    print(f"[main-tool-trim] {config} ({profile}): {outcome}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
