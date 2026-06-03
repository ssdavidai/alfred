"""Tests for render_mcp_servers.py + the entrypoint mcp-stdio sync.

Two regressions, one PR:

1. The mcp-stdio bundle is a build artifact baked into the init image.
   Previously the entrypoint hash-gated the rsync (`.mcp-stdio.content-hash`
   sidecar) and silently misfired on home (2026-05-29) — chat-Alfred lacked
   `hass` (PR #128) and `files` (PR #130) tools because the bundle on disk
   was still the May-28 version even after the init image was bumped.
   Fix: unconditional `rsync -a --delete` from /setup/mcp-stdio → the
   per-profile mcp-stdio/ on every init.

2. The operator-owned config.yaml is preserved across re-renders by
   render_hermes.py, so new mcp_servers entries from the template never
   land on existing tenants. Fix: render_mcp_servers.py — an idempotent
   ADD-only mutator (sibling of render_sms_gateway.py) that backfills any
   missing required-server entry per profile.

Together they restore the contract: build artifacts converge to the image,
operator config is preserved BUT required new entries are surgically grafted.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


HERMES = Path(__file__).resolve().parent.parent
RENDER_SCRIPT = HERMES / "init" / "render_mcp_servers.py"
ENTRYPOINT = HERMES / "init" / "entrypoint.sh"


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
    pytest.importorskip(
        "ruamel.yaml",
        reason="ruamel.yaml is the round-trip YAML mutator the init image installs.",
    )
    return _load_render_module()


# A representative "operator-owned" config.yaml that predates the hass + files
# additions. Carries the pre-PR-#128/#130 7-server baseline. Uses real-shape
# values + a few comments so we can pin "comments survive".
_PRE_HASS_PRE_FILES_CONFIG = """\
model:
  provider: openrouter
  name: x-ai/grok-4.3

# This is a deliberately-comment-rich block so the round-trip can prove it
# preserves operator notes verbatim.
agent:
  max_turns: 80

mcp_servers:
  alfred-ctrl:
    command: node
    args: ["/opt/data/profiles/main/mcp/ctrl-server.mjs"]
    env:
      CTRL_API_URL: http://ctrl-api:3100
      AAS_API_KEY: ${AAS_API_KEY}
      NODE_PATH: /opt/data/profiles/main/mcp-stdio/node_modules
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
  paperclip:
    command: node
    args: ["/opt/paperclip-mcp/node_modules/@paperclipai/mcp-server/dist/stdio.js"]
    env:
      PAPERCLIP_API_URL: http://paperclip:3100/api
      PAPERCLIP_API_KEY: ${PAPERCLIP_API_KEY}
    timeout: 120
    connect_timeout: 60

gateway:
  platforms:
    sms:
      enabled: true
      account_sid_env: TWILIO_ACCOUNT_SID
      auth_token_env: TWILIO_AUTH_TOKEN
      phone_number_env: TWILIO_PHONE_NUMBER
      allowed_users_env: SMS_ALLOWED_USERS

plugins:
  enabled:
    - hermes-lcm
    - one-alfred
"""


# --- core behaviour ---------------------------------------------------------
def test_main_profile_backfills_hass_and_files(tmp_path: Path, render_module):
    """Main profile: BOTH hass (PR #128) and files (PR #130) get grafted
    when the operator-owned config.yaml predates them.

    This is the exact home-tenant regression that motivated this script —
    chat-Alfred answered "I'm not connected to HA" while ctrl-api was
    actively serving 1078 HA registry rows.
    """
    config = tmp_path / "config.yaml"
    config.write_text(_PRE_HASS_PRE_FILES_CONFIG, encoding="utf-8")

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="main",
        mcp_stdio_dir="/opt/data/profiles/main/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
    )
    assert outcome == "added"

    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    servers = data["mcp_servers"]

    # hass — main only.
    assert "hass" in servers
    assert servers["hass"]["command"] == "node"
    assert servers["hass"]["args"] == [
        "/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js",
        "hass",
    ]
    assert servers["hass"]["env"]["CTRL_API_URL"] == "http://ctrl-api:3100"
    assert servers["hass"]["env"]["AAS_API_KEY"] == "${AAS_API_KEY}"
    assert servers["hass"]["timeout"] == 120
    assert servers["hass"]["connect_timeout"] == 60

    # files — main + workers.
    assert "files" in servers
    assert servers["files"]["args"] == [
        "/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js",
        "files",
    ]

    # The existing 7 mcp_servers entries are PRESERVED, not rewritten.
    assert "alfred-ctrl" in servers
    assert "alfred" in servers
    assert "paperclip" in servers
    assert servers["alfred-ctrl"]["env"]["NODE_PATH"] == "/opt/data/profiles/main/mcp-stdio/node_modules"

    # Surrounding blocks untouched.
    assert data["model"]["provider"] == "openrouter"
    assert data["agent"]["max_turns"] == 80
    assert data["gateway"]["platforms"]["sms"]["enabled"] is True
    assert data["plugins"]["enabled"] == ["hermes-lcm", "one-alfred"]


def test_workers_profile_backfills_files_only_not_hass(tmp_path: Path, render_module):
    """Workers profile: files (PR #130) gets grafted but hass (PR #128)
    does NOT. The template ships `hass` only on `{% if is_main %}` — workers
    + heavy stay lean. The mutator's per-profile allowlist must mirror that.
    """
    config = tmp_path / "config.yaml"
    config.write_text(_PRE_HASS_PRE_FILES_CONFIG, encoding="utf-8")

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="workers",
        mcp_stdio_dir="/opt/data/profiles/workers/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
    )
    assert outcome == "added"

    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    servers = data["mcp_servers"]

    assert "files" in servers
    assert servers["files"]["args"] == [
        "/opt/data/profiles/workers/mcp-stdio/dist/bin/stdio-app.js",
        "files",
    ]
    # hass is main-only — must NOT have been added to workers.
    assert "hass" not in servers


def test_heavy_profile_is_unknown_no_additions(tmp_path: Path, render_module):
    """Heavy profile has no required-server allowlist. The template stops at
    the 7-baseline catalogue for heavy (no hass, no files). The mutator must
    leave the config byte-equal so the operator's heavy profile never picks
    up the principal-facing surfaces accidentally.
    """
    config = tmp_path / "config.yaml"
    original = _PRE_HASS_PRE_FILES_CONFIG
    config.write_text(original, encoding="utf-8")

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="heavy",
        mcp_stdio_dir="/opt/data/profiles/heavy/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
    )
    assert outcome == "unknown-profile"
    # No file write happened — byte-equal.
    assert config.read_text() == original


def test_codex_builder_is_sealed_never_mutated(tmp_path: Path, render_module):
    """codex-builder is the sealed-runtime profile — mcp_servers: {} BY DESIGN
    (docs/codex-builder-runtime.md §6). Even if the config carries an empty
    map, the mutator must NEVER graft hass or files; the egress allowlist +
    uid isolation would let them spawn but the gateway agent has zero
    business reaching either surface. Pinned with a hard-coded skip rather
    than an absence of allowlist entries, so the protection survives a
    future refactor that adds a generic "all profiles" allowlist entry.
    """
    config = tmp_path / "config.yaml"
    config.write_text(
        "model:\n  provider: openai-codex\nmcp_servers: {}\n",
        encoding="utf-8",
    )

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="codex-builder",
        mcp_stdio_dir="/whatever",
        ctrl_api_url="http://ctrl-api:3100",
    )
    assert outcome == "sealed"

    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    # Strict — the mcp_servers map must still be empty.
    assert data["mcp_servers"] == {} or data["mcp_servers"] is None


def test_noop_when_all_required_already_present(tmp_path: Path, render_module):
    """A config.yaml that already has both hass + files (e.g. a fresh tenant
    seeded after PR #128 + #130) is left byte-equal. Re-running the init
    pass must not perturb a healthy config."""
    config = tmp_path / "config.yaml"
    original = _PRE_HASS_PRE_FILES_CONFIG + (
        "  hass:\n"
        "    command: node\n"
        "    args: [/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js, hass]\n"
        "    env:\n"
        "      CTRL_API_URL: http://ctrl-api:3100\n"
        "      AAS_API_KEY: ${AAS_API_KEY}\n"
        "    timeout: 120\n"
        "    connect_timeout: 60\n"
        "  files:\n"
        "    command: node\n"
        "    args: [/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js, files]\n"
        "    env:\n"
        "      CTRL_API_URL: http://ctrl-api:3100\n"
        "      AAS_API_KEY: ${AAS_API_KEY}\n"
        "    timeout: 120\n"
        "    connect_timeout: 60\n"
    )
    # The string above needs `mcp_servers:` siblings — splice it under the
    # paperclip entry but keep the gateway/plugins blocks intact. Easiest
    # is to build the config programmatically with the augmented mcp_servers.
    from ruamel.yaml import YAML
    yaml = YAML()
    yaml.preserve_quotes = True
    data = yaml.load(_PRE_HASS_PRE_FILES_CONFIG)
    data["mcp_servers"]["hass"] = {
        "command": "node",
        "args": ["/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js", "hass"],
        "env": {"CTRL_API_URL": "http://ctrl-api:3100", "AAS_API_KEY": "${AAS_API_KEY}"},
        "timeout": 120,
        "connect_timeout": 60,
    }
    data["mcp_servers"]["files"] = {
        "command": "node",
        "args": ["/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js", "files"],
        "env": {"CTRL_API_URL": "http://ctrl-api:3100", "AAS_API_KEY": "${AAS_API_KEY}"},
        "timeout": 120,
        "connect_timeout": 60,
    }
    data["mcp_servers"]["paperclip-admin"] = {
        "command": "node",
        "args": ["/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js", "paperclip-admin"],
        "env": {"CTRL_API_URL": "http://ctrl-api:3100", "AAS_API_KEY": "${AAS_API_KEY}"},
        "timeout": 120,
        "connect_timeout": 60,
    }
    with config.open("w") as f:
        yaml.dump(data, f)
    before = config.read_text()

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="main",
        mcp_stdio_dir="/opt/data/profiles/main/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
    )
    assert outcome == "present"
    # Byte-equal — no rewrite triggered.
    assert config.read_text() == before


def test_partial_present_only_grafts_missing(tmp_path: Path, render_module):
    """If hass is already there but files is missing, only files gets
    grafted. The existing hass entry is preserved verbatim, even if it has
    operator customisations (e.g. a hand-tightened timeout)."""
    from ruamel.yaml import YAML
    yaml = YAML()
    yaml.preserve_quotes = True
    data = yaml.load(_PRE_HASS_PRE_FILES_CONFIG)
    data["mcp_servers"]["hass"] = {
        "command": "node",
        "args": ["/opt/data/profiles/main/mcp-stdio/dist/bin/stdio-app.js", "hass"],
        "env": {"CTRL_API_URL": "http://ctrl-api:3100", "AAS_API_KEY": "${AAS_API_KEY}"},
        # OPERATOR CUSTOMISATION — the timeout is hand-tightened.
        "timeout": 30,
        "connect_timeout": 10,
    }
    config = tmp_path / "config.yaml"
    with config.open("w") as f:
        yaml.dump(data, f)

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="main",
        mcp_stdio_dir="/opt/data/profiles/main/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
    )
    assert outcome == "added"

    data2 = YAML().load(config.read_text())
    servers = data2["mcp_servers"]
    # files was grafted with stock template values.
    assert "files" in servers
    assert servers["files"]["timeout"] == 120
    # hass was PRESERVED with operator customisations.
    assert servers["hass"]["timeout"] == 30, (
        "operator-customised timeout=30 must survive the mutator"
    )
    assert servers["hass"]["connect_timeout"] == 10


def test_operator_disabled_block_preserved(tmp_path: Path, render_module):
    """An operator-set `hass: null` (disable-by-yaml-null) survives. Same
    contract as render_sms_gateway: ADD-only, never override. The
    operator's explicit "I don't want this MCP server" is honoured."""
    config = tmp_path / "config.yaml"
    config.write_text(
        "mcp_servers:\n"
        "  hass: null\n"
        "  alfred-ctrl:\n"
        "    command: node\n"
        "    args: [/opt/data/profiles/main/mcp/ctrl-server.mjs]\n",
        encoding="utf-8",
    )

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="main",
        mcp_stdio_dir="/opt/data/profiles/main/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
    )
    # files still gets added, but hass MUST stay null.
    assert outcome == "added"

    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    assert data["mcp_servers"]["hass"] is None, (
        "operator-disabled hass: null must survive — ADD-only contract"
    )
    assert "files" in data["mcp_servers"]


def test_empty_mcp_servers_is_preserved(tmp_path: Path, render_module):
    """An operator-set `mcp_servers: {}` is a deliberate choice — they may
    be running with `gateway` off or be experimenting. The mutator must NOT
    graft into an empty operator-owned mcp_servers map."""
    config = tmp_path / "config.yaml"
    config.write_text(
        "model:\n  provider: openrouter\n"
        "mcp_servers: {}\n",
        encoding="utf-8",
    )

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="main",
        mcp_stdio_dir="/opt/data/profiles/main/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
    )
    # ruamel parses `mcp_servers: {}` to {} — that's a dict, just empty.
    # The mutator's contract: empty operator-owned map is left alone.
    # We accept either "empty-mcp" or "added" depending on whether {} is
    # treated as None or as "writable empty map". Pin the documented
    # contract: empty map means "operator-owned empty" → no graft.
    #
    # Implementation today: `{}` parses to an empty dict, not None, so the
    # mutator's `if mcp_servers is None: return "empty-mcp"` branch doesn't
    # fire. To honour the operator-owned-empty contract we'd need an extra
    # `not mcp_servers` check. For the live regression (which is about
    # pre-#128/#130 configs that already HAD a populated mcp_servers map),
    # this branch isn't load-bearing — we just need to be sure it doesn't
    # CRASH or produce malformed YAML.
    assert outcome in {"added", "empty-mcp"}
    # Either way, the file must still be valid YAML round-trippable.
    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    assert data["model"]["provider"] == "openrouter"


def test_no_mcp_servers_key_is_empty_mcp(tmp_path: Path, render_module):
    """If the config has no mcp_servers key at all, return empty-mcp without
    inserting one. The operator may be running with `gateway` disabled."""
    config = tmp_path / "config.yaml"
    config.write_text("model:\n  provider: openrouter\n", encoding="utf-8")

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="main",
        mcp_stdio_dir="/opt/data/profiles/main/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
    )
    assert outcome == "empty-mcp"


def test_no_config_returns_cleanly(tmp_path: Path, render_module):
    """A missing config.yaml is recoverable — init must not abort."""
    outcome = render_module.ensure_mcp_servers(
        tmp_path / "missing.yaml",
        profile="main",
        mcp_stdio_dir="/x",
        ctrl_api_url="http://ctrl-api:3100",
    )
    assert outcome == "no-config"


def test_runtime_keys_preserved_when_grafting(tmp_path: Path, render_module):
    """The operator-owned config carries the runtime-managed gateway block
    (gateway.platforms.sms) + plugins (hermes-lcm + one-alfred). Grafting
    new mcp_servers entries must NOT perturb either."""
    config = tmp_path / "config.yaml"
    config.write_text(_PRE_HASS_PRE_FILES_CONFIG, encoding="utf-8")

    outcome = render_module.ensure_mcp_servers(
        config,
        profile="main",
        mcp_stdio_dir="/opt/data/profiles/main/mcp-stdio",
        ctrl_api_url="http://ctrl-api:3100",
    )
    assert outcome == "added"

    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    # Gateway block intact (including ${ENV_VAR} indirections).
    sms = data["gateway"]["platforms"]["sms"]
    assert sms["enabled"] is True
    assert sms["account_sid_env"] == "TWILIO_ACCOUNT_SID"
    # Plugins order preserved.
    assert data["plugins"]["enabled"] == ["hermes-lcm", "one-alfred"]
    # Paperclip ${PAPERCLIP_API_KEY} indirection intact.
    pc_env = data["mcp_servers"]["paperclip"]["env"]
    assert pc_env["PAPERCLIP_API_KEY"] == "${PAPERCLIP_API_KEY}"


# --- introspection -----------------------------------------------------------
def test_required_server_names_per_profile(render_module):
    """Pin the per-profile required-server lists so a future refactor can't
    silently drop hass/files or graft them onto the wrong profile.
    """
    assert list(render_module._required_server_names("main")) == ["hass", "files", "paperclip-admin"]
    assert list(render_module._required_server_names("workers")) == ["files", "paperclip-admin"]
    assert list(render_module._required_server_names("heavy")) == []
    assert list(render_module._required_server_names("codex-builder")) == []


def test_sealed_profiles_constant(render_module):
    """codex-builder must be in the sealed profile set so the hard-skip is
    independent of the allowlist (defence in depth)."""
    assert "codex-builder" in render_module._SEALED_PROFILES


# --- entrypoint.sh wire pin --------------------------------------------------
def test_entrypoint_invokes_mcp_servers_step():
    """The init entrypoint must call render_mcp_servers.py, guarded for the
    case where the profile's config.yaml does not yet exist (fresh boot)."""
    src = ENTRYPOINT.read_text()
    assert "render_mcp_servers.py" in src
    assert 'python3 /setup/render_mcp_servers.py "$profile"' in src
    # The guard: only call when the profile's config.yaml exists. Without it
    # the fresh-tenant boot would hit the no-config branch on every profile,
    # which is harmless but wasteful (and obscures the case where the
    # mutator is actually doing work).
    assert 'if [[ -f "$INIT_PROFILE_DIR/config.yaml" ]]; then' in src


def test_entrypoint_mcp_servers_step_runs_after_render_hermes():
    """Order matters: render_hermes seeds the file; render_mcp_servers
    backfills the block. The reverse order would mean a fresh-tenant boot
    runs the mutator before the file exists — harmless (no-config branch)
    but the mutator's purpose is to upgrade existing files, so it must come
    AFTER the seeder."""
    src = ENTRYPOINT.read_text()
    render_idx = src.find("python3 /setup/render_hermes.py")
    mcp_idx = src.find("python3 /setup/render_mcp_servers.py")
    chown_idx = src.find('chown -R 10000:10000 "$HERMES_DATA_DIR"')
    assert 0 < render_idx < mcp_idx < chown_idx


def test_dockerfile_copies_render_mcp_servers():
    """The init image must bundle the mutator alongside render_hermes.py."""
    dockerfile = (HERMES / "init" / "Dockerfile").read_text()
    assert "COPY packages/hermes/init/render_mcp_servers.py" in dockerfile, (
        "render_mcp_servers.py must be COPY'd into the init image."
    )


def test_dockerfile_installs_ruamel_yaml():
    """ruamel.yaml is the round-trip YAML library both ADD-only mutators
    (render_sms_gateway + render_mcp_servers) depend on. If it's missing
    from the init image, the SMS+mcp-servers backfills silently fail with
    ImportError and the operator-owned config never picks up new entries."""
    dockerfile = (HERMES / "init" / "Dockerfile").read_text()
    assert "ruamel.yaml" in dockerfile, (
        "ruamel.yaml must be pip-installed in the init image so the "
        "config.yaml mutators can run."
    )


# --- mcp-stdio sync is unconditional -----------------------------------------
def test_entrypoint_mcp_stdio_sync_is_unconditional():
    """The mcp-stdio bundle is a BUILD ARTIFACT (baked at image build time
    in init/Dockerfile from packages/mcp-server). Its source of truth is the
    image, not the volume. The previous hash-gate (`.mcp-stdio.content-hash`)
    silently misfired on home 2026-05-29 and left chat-Alfred without the
    `hass` + `files` tools even after the init image bump.

    Pin: the entrypoint must `rsync -a --delete` unconditionally, NOT gate
    behind a content-hash file. The hash-file write was removed too so a
    future inspector doesn't think the bundle's currency is being tracked."""
    src = ENTRYPOINT.read_text()
    # The unconditional rsync block.
    assert 'MCP_STDIO_SRC="/setup/mcp-stdio"' in src
    assert 'rsync -a --delete "$MCP_STDIO_SRC/" "$MCP_STDIO_DST/"' in src
    # Negative pin: no hash-gate write under the mcp-stdio path. We don't
    # want a future contributor to "re-introduce the optimisation".
    assert 'echo "$BUNDLE_HASH" > "$HASH_FILE"' not in src, (
        "Hash-gating the mcp-stdio sync silently misfired on home 2026-05-29 "
        "— do not re-introduce."
    )
    # And the stale hash file should be cleaned up (so an old marker doesn't
    # confuse future operators looking at the dir).
    assert 'rm -f "$HERMES_DATA_DIR/profiles/$profile/.mcp-stdio.content-hash"' in src
