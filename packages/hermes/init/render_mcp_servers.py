"""render_mcp_servers.py — ensure required `mcp_servers` blocks in config.yaml.

`render_hermes.py` seeds the per-profile config.yaml ONCE; on subsequent boots
the file is operator-owned and never re-rendered. That's correct for sections
the operator might tune (`model:`, `gateway:`, `agent:`), but it means a
template-only addition of a new REQUIRED MCP server — one that ships in the
mcp-stdio bundle baked into the Hermes image — is invisible to any tenant
whose config.yaml was seeded before the template change. The MCP server's
node binary is there, the skill files are there, the runtime path is there;
the operator-owned config.yaml just lacks the `mcp_servers:` entry that tells
Hermes to spawn it.

This is the same shape as `render_sms_gateway.py` (idempotent ADD-only
mutator), but applied to the mcp_servers section instead of gateway.platforms,
and per-profile rather than main-only.

Live regression that motivated this script (2026-05-29, home tenant):

  - PR #128 added the `hass` MCP server (16 tools: HA registry / state /
    history / logbook / calendars / fuzzy entity resolution + 5 PR3 write
    surface placeholders). Wired on `main` only — `hass` is a user-facing
    surface.
  - PR #130 added the `files` MCP server (9 tools: list / stat / read_text
    / read_base64 / search / delete / create / usage / describe over
    ctrl-api's Store-5 blob endpoints). Wired on `main` + `workers`.
  - The mcp-stdio bundle on home was synced (build artifact, see entrypoint
    step 2e), but the operator-owned config.yaml at
    /hermes-state/profiles/main/config.yaml had been seeded pre-PR-#128 and
    carried only the 5 original mcp_servers (alfred-ctrl + alfred + sure +
    plane + vaultwarden + execute + paperclip — 7 servers).
  - Chat-Alfred answered "I'm not connected to Home Assistant" while
    ctrl-api was actively serving 1078 HA registry rows: the round-trip
    tools the principal asked Alfred to call simply weren't in main's
    catalogue, because the operator-owned config.yaml hadn't grown the
    `hass:` and `files:` entries.

The fix is to backfill the missing required-server entries on every init
boot. The mutator is ADD-only: an operator-disabled / customised entry is
preserved verbatim — both states (`alfred-ctrl: ...customised...` and
`alfred-ctrl: null  # disabled`) are legitimate operator decisions.

The required-server allowlist is keyed by profile so a future MCP server
addition is a one-line edit to `_REQUIRED_MCP_SERVERS` below. Mirrors the
template's `{% if is_main %}` / `{% if is_main or profile == "workers" %}`
gating in hermes-config.yaml.njk so the disk shape converges with the
template shape no matter when the tenant was provisioned.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterable, Literal


# -----------------------------------------------------------------------------
# Per-profile required MCP servers.
#
# The shape of each entry mirrors what hermes-config.yaml.njk renders into a
# freshly-seeded config.yaml. Anything that varies by profile (the
# mcp_stdio_dir path baked into args, the ${PAPERCLIP_API_KEY} indirections,
# etc.) is rendered using the templating helpers below at backfill time.
#
# Keep this list in sync with the template — when a new MCP server is added
# upstream, add it to BOTH the .njk template (so new-tenant first-seeds get
# it) AND this dict (so existing-tenant re-renders backfill it). Removing
# an entry here makes the mutator a no-op for that server — it does NOT
# delete an existing block (this is an ADD-only mutator by design).
# -----------------------------------------------------------------------------
#
# `hass` — Home Assistant operator surface (PR #128).
# Main profile only. The skill the principal-facing Alfred uses to talk
# about the home; workers/heavy don't need it.
_HASS_BLOCK = {
    "command": "node",
    "args_template": ["{mcp_stdio_dir}/dist/bin/stdio-app.js", "hass"],
    "env": {
        "CTRL_API_URL": "{ctrl_api_url}",
        "AAS_API_KEY": "${AAS_API_KEY}",
    },
    "timeout": 120,
    "connect_timeout": 60,
}

# `files` — Store-5 blob surface (PR #130, issue #114).
# main + workers. main reads files the principal asks about; workers'
# vault-curator / vault-janitor / vault-distiller correlate stored files
# with vault records. NOT wired on heavy or codex-builder.
_FILES_BLOCK = {
    "command": "node",
    "args_template": ["{mcp_stdio_dir}/dist/bin/stdio-app.js", "files"],
    "env": {
        "CTRL_API_URL": "{ctrl_api_url}",
        "AAS_API_KEY": "${AAS_API_KEY}",
    },
    "timeout": 120,
    "connect_timeout": 60,
}

# Profile → ordered list of (name, block-template) pairs that MUST exist
# in the operator-owned config.yaml's `mcp_servers:` map. The mutator
# walks the list, checks each name against the live config, and inserts
# missing ones verbatim (with templating applied to the args + env paths).
# `paperclip-admin` — agent-driven Paperclip company bootstrap (epic #242).
# DISTINCT from the upstream `paperclip` ops server (@paperclipai/mcp-server,
# board-key, ~40 camelCase tools) already seeded in hermes-config.yaml.njk —
# this is the alfred bundle's admin surface (AAS-key) exposing the 5
# paperclip_* tools that proxy to ctrl-api /api/v1/paperclip/admin/*. The
# `alfred-paperclip-bootstrap` skill drives them (confirm-first). main +
# workers, where hermes_local agents run; NOT heavy/codex-builder.
_PAPERCLIP_ADMIN_BLOCK = {
    "command": "node",
    "args_template": ["{mcp_stdio_dir}/dist/bin/stdio-app.js", "paperclip-admin"],
    "env": {
        "CTRL_API_URL": "{ctrl_api_url}",
        "AAS_API_KEY": "${AAS_API_KEY}",
    },
    "timeout": 120,
    "connect_timeout": 60,
}

_REQUIRED_MCP_SERVERS: dict[str, list[tuple[str, dict]]] = {
    "main":    [("hass", _HASS_BLOCK), ("files", _FILES_BLOCK), ("paperclip-admin", _PAPERCLIP_ADMIN_BLOCK)],
    "workers": [("files", _FILES_BLOCK), ("paperclip-admin", _PAPERCLIP_ADMIN_BLOCK)],
    # heavy:        — no required additions (sticks with the 7 baseline servers).
    # codex-builder — sealed runtime, mcp_servers: {} by design; the mutator
    #                 skips this profile entirely (see profile guard below).
}

# #120 Lane II — known reserved profile names. User-facing profiles (not in
# this set) get the same MCP-server allowlist as `main` (they're
# conversational Alfred variants). Heavy stays unaffected via the explicit
# "unknown-profile" return path below.
_RESERVED_PROFILES: frozenset[str] = frozenset({"main", "workers", "heavy", "codex-builder"})

# codex-builder's whole identity is "no MCP catalogue". We must NEVER
# graft `hass` or `files` into its sealed-runtime config — the egress
# allowlist + UID isolation would let them spawn but the gateway agent
# has no business reaching either surface. The mutator hard-skips this
# profile name.
_SEALED_PROFILES: frozenset[str] = frozenset({"codex-builder"})

# Retired capabilities. Every name here is DELETED from each non-sealed
# profile's `mcp_servers` on every init boot.
#
# `config.yaml` is operator-owned, so removing a capability from the template
# does NOT remove it from tenants that were provisioned earlier. Plane was
# retired fleet-wide in #279, but its stdio registration survived in every
# deployed config.yaml — so Hermes kept spawning and retrying a server whose
# backend no longer exists, paying startup latency and log noise on every
# session (#314).
_RETIRED_MCP_SERVERS: tuple[str, ...] = ("plane",)


# -----------------------------------------------------------------------------
# Phase B: runtime-flippable DIRECT vs DELEGATED disposition per MCP server.
#
# Source of truth is state.db.tool_disposition (migration 0014). The dispositions
# only affect the MAIN profile's `tools.include` block:
#
#   * disposition='direct'      → leave tools.include alone (operator-owned
#                                  whitelists from PR #176 are preserved).
#   * disposition='delegated'   → set tools.include: [] for that server. The
#                                  server stays spawned (the LLM can still
#                                  reach it via delegate_to_focused_agent on
#                                  the workers profile), but its tools are
#                                  invisible to main's catalogue.
#
# Workers + heavy + codex-builder are unaffected — the disposition flag is a
# main-only knob. -------------------------------------------------------------
def _read_dispositions(state_db_path: Path) -> dict[str, str]:
    """Read tool_disposition rows from state.db. Returns {server: disposition}.
    Missing file / missing table → empty dict (fresh-tenant fallback: every
    server is treated as 'direct', matching the migration seed)."""
    if not state_db_path.exists():
        return {}
    # READ-ONLY connection (`mode=ro`) so the init container never accidentally
    # writes to ctrl-api's single-writer DB. The mutator is a renderer, not an
    # updater.
    try:
        uri = f"file:{state_db_path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=2.0)
        try:
            cur = conn.execute(
                "SELECT server, disposition FROM tool_disposition"
            )
            return {row[0]: row[1] for row in cur.fetchall()}
        finally:
            conn.close()
    except sqlite3.OperationalError:
        # Table doesn't exist yet (state.db predates migration 0014) — same
        # fallback as "no file": every server defaults to direct.
        return {}
    except Exception:
        # Any other SQLite hiccup: treat as no data; init must not abort.
        return {}


def _apply_dispositions_to_main(
    mcp_servers: dict,
    dispositions: dict[str, str],
) -> bool:
    """For each server in `dispositions` with disposition='delegated', set
    `tools.include: []` on its config block (main profile only — callers gate
    this). Returns True if any block was mutated.

    Preserves operator-owned blocks: if a server is set to `null` (disabled
    by operator) we skip it. If a server is a customised dict, we set
    `tools.include: []` on it (the delegate flag wins over whitelist-based
    customisation — the operator can always promote-to-direct via the
    dashboard if they want their custom whitelist back).
    """
    mutated = False
    for server, disposition in dispositions.items():
        if server not in mcp_servers:
            continue
        block = mcp_servers[server]
        if block is None:
            # Operator-disabled — respect it.
            continue
        if not isinstance(block, dict):
            continue

        if disposition == "delegated":
            tools = block.get("tools") if isinstance(block.get("tools"), dict) else {}
            # Round-trip-friendly: only mutate if the current state isn't
            # already `tools.include: []`. Avoids needless writes.
            current_include = tools.get("include") if tools else None
            if current_include == [] or (isinstance(current_include, list) and len(current_include) == 0):
                continue
            if not isinstance(block.get("tools"), dict):
                block["tools"] = {}
            block["tools"]["include"] = []
            mutated = True
        # disposition='direct' → no mutation. The operator-owned tools.include
        # whitelist (or absence thereof) wins.
    return mutated


def _substitute(value: str, *, mcp_stdio_dir: str, ctrl_api_url: str) -> str:
    """Substitute the two whitelisted placeholders in a template string.

    We use plain `str.replace` instead of `str.format` because the env-var
    indirections inside the template (``${AAS_API_KEY}``, ``${PAPERCLIP_API_KEY}``)
    contain literal ``{`` characters that `str.format` would interpret as
    format fields — KeyError-on-AAS_API_KEY on first call. Whitelist-only
    substitution is also easier to audit (the operator-owned config gets
    exactly two values plugged in, nothing else).
    """
    return (
        value
        .replace("{mcp_stdio_dir}", mcp_stdio_dir)
        .replace("{ctrl_api_url}", ctrl_api_url)
    )


def _render_block(
    block_template: dict,
    *,
    mcp_stdio_dir: str,
    ctrl_api_url: str,
) -> dict:
    """Materialise the args + env templates into a concrete block.

    The args field uses {mcp_stdio_dir} so the path inside the rendered
    block matches whatever the runtime view of the profile dir is (which
    differs from the init container's view — see render_hermes.py for the
    HERMES_RUNTIME_PROFILE_DIR plumbing).
    """
    rendered: dict = {"command": block_template["command"]}
    rendered["args"] = [
        _substitute(arg, mcp_stdio_dir=mcp_stdio_dir, ctrl_api_url=ctrl_api_url)
        for arg in block_template["args_template"]
    ]
    if "env" in block_template:
        rendered["env"] = {
            k: _substitute(v, mcp_stdio_dir=mcp_stdio_dir, ctrl_api_url=ctrl_api_url)
            for k, v in block_template["env"].items()
        }
    for k in ("timeout", "connect_timeout"):
        if k in block_template:
            rendered[k] = block_template[k]
    return rendered


def _required_server_names(profile: str) -> Iterable[str]:
    """Names of MCP servers required for ``profile`` (test introspection)."""
    return [name for name, _ in _REQUIRED_MCP_SERVERS.get(profile, [])]


def ensure_mcp_servers(
    config_path: Path,
    *,
    profile: str,
    mcp_stdio_dir: str,
    ctrl_api_url: str,
    state_db_path: Path | None = None,
) -> Literal[
    "added", "removed", "present", "no-config", "sealed", "unknown-profile",
    "empty-mcp",
]:
    """Idempotently add required `mcp_servers` entries to ``config_path``.

    Returns:
      "no-config"       — file doesn't exist (init must not abort)
      "sealed"          — codex-builder; mcp_servers stays {} (no-op)
      "unknown-profile" — profile has no required-server allowlist
      "empty-mcp"       — operator set `mcp_servers: {}` deliberately; preserved
      "present"         — all required servers already in the config (incl.
                          disposition-derived `tools.include: []` already
                          where it should be)
      "added"           — at least one missing entry was inserted OR a
                          disposition flip required mutating an existing
                          server's tools.include block
      "removed"         — the only mutation was deleting a retired server
                          (see _RETIRED_MCP_SERVERS)

    ADD-only for the server set: an existing entry under any of the required
    names is preserved verbatim (operator-owned, may be a hand-customised
    block or even an explicit `null` to disable). The mutator never deletes.

    Phase B: disposition-driven `tools.include` mutation runs on the MAIN
    profile only — when state_db_path is provided and the disposition table
    is populated. A server with disposition='delegated' gets `tools.include:
    []` lands on its block (whether the block was just-grafted or was
    already operator-owned). Workers/heavy/codex-builder profiles are
    untouched by this layer.
    """
    if not config_path.exists():
        return "no-config"

    if profile in _SEALED_PROFILES:
        return "sealed"

    from ruamel.yaml import YAML

    yaml = YAML()
    yaml.preserve_quotes = True

    text = config_path.read_text(encoding="utf-8")
    data = yaml.load(text)
    if data is None:
        data = {}

    if "mcp_servers" not in data:
        # The template renders an explicit `mcp_servers: ...` key for every
        # non-sealed profile; absence here means the operator deleted the
        # whole key. Don't second-guess — they may have a deliberate reason
        # (e.g. running with `gateway` disabled entirely).
        return "empty-mcp"

    mcp_servers = data["mcp_servers"]
    if mcp_servers is None:
        # `mcp_servers:` (no value) parses to None — same intent as `{}`.
        # Operator-owned empty → leave it.
        return "empty-mcp"
    if not isinstance(mcp_servers, dict):
        # Anything else is operator surgery we shouldn't second-guess.
        return "present"

    # REMOVE pass (#314) — runs BEFORE the required-server resolution below,
    # because `heavy` has no allowlist and returns early, yet still carries a
    # retired `plane` registration on every deployed tenant.
    removed_any = False
    for retired in _RETIRED_MCP_SERVERS:
        if retired in mcp_servers:
            del mcp_servers[retired]
            removed_any = True

    def _flush() -> None:
        with config_path.open("w", encoding="utf-8") as f:
            yaml.dump(data, f)

    required = _REQUIRED_MCP_SERVERS.get(profile)
    if required is None:
        # Heavy (a reserved profile with no allowlist entries) keeps the
        # historical "unknown-profile" return — the test pins this exact
        # outcome so heavy never picks up the principal-facing surfaces. It
        # still gets the retired-key removal above.
        if profile in _RESERVED_PROFILES:
            if removed_any:
                _flush()
                return "removed"
            return "unknown-profile"
        # #120 Lane II — user-facing profiles (created via ctrl-api's
        # /api/v1/agent-profiles POST) fall here. Treat them like `main`:
        # they're conversational Alfred variants and need the same baseline
        # MCP catalogue.
        required = _REQUIRED_MCP_SERVERS["main"]

    added_any = False
    for name, block_template in required:
        if name in mcp_servers:
            # Operator-owned. Could be a customised block, a `null` (disable),
            # or the template-default — all three states are legitimate.
            continue
        mcp_servers[name] = _render_block(
            block_template,
            mcp_stdio_dir=mcp_stdio_dir,
            ctrl_api_url=ctrl_api_url,
        )
        added_any = True

    # Phase B: apply DELEGATED disposition to main-like profiles' mcp_servers.
    # Workers/heavy stay full-catalogue — the focused-subagent path needs
    # them. codex-builder was sealed above so never lands here.
    # #120 Lane II — user-facing profiles (anything not in the reserved
    # workers/heavy/codex-builder set) inherit main's disposition behaviour.
    disposition_mutated = False
    main_like = profile == "main" or profile not in {
        "workers",
        "heavy",
        "codex-builder",
    }
    if main_like and state_db_path is not None:
        dispositions = _read_dispositions(state_db_path)
        if dispositions:
            disposition_mutated = _apply_dispositions_to_main(mcp_servers, dispositions)

    if not added_any and not disposition_mutated and not removed_any:
        return "present"

    _flush()
    return "added" if (added_any or disposition_mutated) else "removed"


if __name__ == "__main__":
    import os
    import sys

    profile = (sys.argv[1] if len(sys.argv) > 1 else "").strip().lower()
    if not profile:
        print(
            "usage: render_mcp_servers.py <profile>\n"
            "  env: PROFILE_DIR, HERMES_RUNTIME_PROFILE_DIR, CTRL_API_URL",
            file=sys.stderr,
        )
        sys.exit(2)

    profile_dir = Path(os.environ.get("PROFILE_DIR", f"/hermes-state/profiles/{profile}"))
    config = profile_dir / "config.yaml"

    # The mcp-stdio dir baked into args must match the runtime view (the same
    # plumbing render_hermes.py does — see its HERMES_RUNTIME_PROFILE_DIR /
    # HERMES_RUNTIME_HOME resolution).
    runtime_override = os.environ.get("HERMES_RUNTIME_PROFILE_DIR", "").strip()
    runtime_home = os.environ.get("HERMES_RUNTIME_HOME", "").strip()
    if runtime_override:
        mcp_stdio_dir = str(Path(runtime_override) / "mcp-stdio")
    elif runtime_home:
        mcp_stdio_dir = str(Path(runtime_home) / "profiles" / profile / "mcp-stdio")
    else:
        mcp_stdio_dir = str(profile_dir / "mcp-stdio")

    ctrl_api_url = os.environ.get("CTRL_API_URL", "http://ctrl-api:3100")

    # Phase B: state.db lives in ctrl-api's data volume. The init container
    # mounts it read-only at /ctrl-data (compose-template setting). Fresh
    # tenants don't have the file yet — _read_dispositions handles missing
    # file + missing table gracefully, so every server defaults to direct.
    state_db_env = os.environ.get("STATE_DB_PATH", "").strip()
    if state_db_env:
        state_db_path: Path | None = Path(state_db_env)
    else:
        candidate = Path("/ctrl-data/alfred-state.db")
        state_db_path = candidate if candidate.exists() else None

    try:
        outcome = ensure_mcp_servers(
            config,
            profile=profile,
            mcp_stdio_dir=mcp_stdio_dir,
            ctrl_api_url=ctrl_api_url,
            state_db_path=state_db_path,
        )
    except Exception as exc:
        # Best-effort step; never abort init on a render hiccup.
        print(f"[render-mcp-servers] WARN {config}: {exc}", file=sys.stderr)
        sys.exit(0)
    print(f"[render-mcp-servers] {config} ({profile}): {outcome}")
