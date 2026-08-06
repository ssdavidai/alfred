#!/usr/bin/env python3
"""render_hermes.py — render the per-profile Hermes config.yaml + .env.

Called by the init container's entrypoint.sh once per profile. Renders:

    hermes-config.yaml.njk  →  <profile_dir>/config.yaml
    hermes-profile.env.njk  →  <profile_dir>/.env

Nunjucks `.njk` syntax — `{{ }}`, `{% if %}`, `| default(...)` — is a
strict subset of Jinja2 for the constructs these two templates use, so we
render them with Jinja2 directly. No Node/Nunjucks runtime needed in the
init container.

Usage:
    render_hermes.py <profile> <profile_dir> <template_dir> <gateway_token>

Environment (read for template variables):
    ANTHROPIC_API_KEY, OPENAI_API_KEY
    COMPOSIO_API_KEY, COMPOSIO_USER_ID
    AAS_API_KEY
    ALFRED_PRIME, CROSS_TENANT_PEERS
    HERMES_VAULT_PATH        (default /vault)
    CTRL_API_URL             (default http://ctrl-api:3100)
    HERMES_API_CORS_ORIGINS  (optional CORS allowlist)
    HERMES_RENDER_PORT       (#120 Lane II) override the port for ANY profile;
                             required for user-facing profiles whose port is
                             allocated dynamically by ctrl-api's agent_profile
                             registry (18794..18799).
    HERMES_RENDER_MODEL      (#120 Lane II) override the model for a user-
                             facing profile; falls back to the reserved-
                             profile defaults when absent.

Positional:
    <profile>       any slug matching ^[a-z][a-z0-9-]{1,30}$ — the four
                    reserved infra profiles (main / workers / heavy /
                    codex-builder) plus any user-facing profile created
                    via ctrl-api's /api/v1/agent-profiles POST.
    <profile_dir>   absolute path where this process WRITES config.yaml +
                    .env (the init container's view of the volume,
                    e.g. /hermes-data/profiles/main)
    <template_dir>  directory holding the two .njk templates
    <gateway_token> the value of /alfred-data/.gateway-token — becomes
                    API_SERVER_KEY in the profile .env

#120 Lane II — the legacy `_KNOWN_PROFILES` allowlist is gone. Any slug that
matches the registry regex is accepted; the port is sourced from
HERMES_RENDER_PORT (the supervisor / entrypoint.sh passes the registry's
api_server_port). For back-compat with the existing 4 reserved profiles,
their canonical ports are still hard-coded as a fallback when
HERMES_RENDER_PORT is unset.

The Hermes API server binds the canonical ports 18789 (main) / 18790
(workers) / 18791 (heavy) / 18793 (codex-builder) directly — the
hermes-shim that used to front it was retired in issue #40. User-facing
profiles use 18794..18799 (allocated by ctrl-api).

Path-baking: the absolute paths baked INTO the rendered config.yaml
(mcp-stdio dir, ctrl-server.mjs, NODE_PATH) must be valid in the HERMES
RUNTIME container, which mounts the same volume at a different path
(HERMES_HOME, default /opt/data). Set HERMES_RUNTIME_PROFILE_DIR to that
runtime view (e.g. /opt/data/profiles/main); the script writes the files
through <profile_dir> but bakes paths from HERMES_RUNTIME_PROFILE_DIR.
When unset, it falls back to <profile_dir> (single-view setups).

The script is idempotent. config.yaml is OPERATOR-OWNED: init only SEEDS it
when absent and never overwrites an existing file (the operator / `hermes
config` owns it once written). The .env file IS re-rendered on every run so
deployment-managed values (ports/keys) always propagate. It never touches
sessions, memory, skills, or auth.json.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined

# Hermes API server ports — the canonical ports for the four reserved
# infra profiles. The hermes-shim was retired (issue #40); the Hermes API
# server now binds these ports directly. Must match docker/supervisor.sh
# and the EXPOSE in the Dockerfile.
#
# codex-builder (:18793) is the sealed-runtime builder profile (PR 2 of the
# codex-builder build, docs/codex-builder-runtime.md). It is rendered on
# every tenant for fleet-uniform port layout, but the supervisor only
# LAUNCHES it when ENABLE_CODEX_BUILDER=true in the per-tenant compose env.
# So home gets the running gateway; rj/joe/zsolt/miguel get an idle profile
# dir but no listening process on :18793.
#
# #120 Lane II — these are FALLBACK ports used when HERMES_RENDER_PORT is
# unset. Any user-facing profile created via ctrl-api's POST
# /api/v1/agent-profiles passes its allocated port (18794..18799) via
# HERMES_RENDER_PORT.
_RESERVED_PORT = {
    "main": 18789,
    "workers": 18790,
    "heavy": 18791,
    "codex-builder": 18793,
}

# Slug regex — same as the registry's `agent_profile.slug` constraint
# (packages/ctrl/src/db/agentProfiles.ts: _SLUG_RE).
_SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{1,30}$")

# Codex-only (Sir, 2026-08-05): the template renders `provider: openai-codex`
# for every profile. OpenRouter is permanently banned. On re-render we keep an
# existing `model:` block ONLY when it is already openai-codex (so a hand-tuned
# Codex model tier survives a reseed); any legacy non-codex block is forced
# back to the template's Codex render.
_DEFAULT_PROVIDER = "openai-codex"


def _model_block_span(text: str):
    """Line span [start, end) of the top-level `model:` block in `text`.

    The block runs from the `model:` line through the last line before the
    next column-0 (non-indented, non-blank) line — the next top-level key or
    comment divider. Returns None when there is no top-level `model:` key.
    """
    lines = text.splitlines(keepends=True)
    start = next((i for i, ln in enumerate(lines) if ln.startswith("model:")), None)
    if start is None:
        return None
    end = len(lines)
    for j in range(start + 1, len(lines)):
        ln = lines[j]
        if ln.strip() and not ln[0].isspace():
            end = j
            break
    return start, end


def _block_provider(block: str):
    """The `provider:` value inside a rendered `model:` block, or None."""
    for ln in block.splitlines():
        s = ln.strip()
        if s.startswith("provider:"):
            return s.split(":", 1)[1].strip().strip("\"'")
    return None


def _preserve_switched_model_block(rendered: str, config_path: Path) -> str:
    """Keep a user-switched `model:` block across a re-render.

    If config.yaml already exists and its `model:` block has been pointed at
    a non-default provider (via `hermes model`), splice that block into the
    freshly-rendered config so init does not clobber the principal's choice.
    While still on the default provider, the block re-renders normally so
    HERMES_MAIN_MODEL / HERMES_WORKERS_MODEL edits in .env keep taking effect.
    """
    if not config_path.exists():
        return rendered
    try:
        old_text = config_path.read_text(encoding="utf-8")
    except OSError:
        return rendered
    old_span = _model_block_span(old_text)
    new_span = _model_block_span(rendered)
    if not old_span or not new_span:
        return rendered
    old_lines = old_text.splitlines(keepends=True)
    old_block = "".join(old_lines[old_span[0]:old_span[1]])
    provider = _block_provider(old_block)
    # Codex-only: preserve ONLY an existing openai-codex block (keeps a
    # hand-tuned Codex model tier across reseed). A legacy non-codex block
    # (e.g. openrouter) is NOT preserved — it re-renders to the Codex template.
    if not provider or provider != _DEFAULT_PROVIDER:
        return rendered
    new_lines = rendered.splitlines(keepends=True)
    print(f"[render] preserving codex model: block (provider={provider})")
    return (
        "".join(new_lines[: new_span[0]])
        + old_block
        + "".join(new_lines[new_span[1] :])
    )


# ---------------------------------------------------------------------------
# Runtime-key preservation — the "merge-preserve" path for .env.
# ---------------------------------------------------------------------------
#
# Some env keys are SET AT RUNTIME by ctrl-api UI surfaces, not at init time:
#   • TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USERS / TELEGRAM_HOME_CHANNEL —
#     written by /channels → Save Token (telegram.ts: writeProfileEnvKeys).
#     2026-05-25: a `docker compose up -d --no-deps init` cycle silently
#     wiped Sir's manually-set token because the .env was re-rendered from
#     scratch — Sir clicked Delegate, the workers agent composed butler-voice
#     text, called notify_principal, ctrl-api journalled pending, then the
#     Telegram bot API send failed with "no TELEGRAM_BOT_TOKEN".
#   • Future: SLACK_BOT_TOKEN, DISCORD_BOT_TOKEN, MATRIX_ACCESS_TOKEN, etc.
#
# Each prefix listed below is read from the EXISTING .env (if any) and
# re-emitted into the freshly-rendered output IF the rendered output does
# not already set the same key. The template still wins for ANY key it
# explicitly renders — so an operator can't accidentally pin a stale
# provider key by hand-editing the file.

_RUNTIME_KEY_PREFIXES: tuple[str, ...] = (
    "TELEGRAM_",
    # SLACK_* covers the runtime-managed slack triplet
    # (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_ALLOWED_USERS) plus the
    # optional SLACK_HOME_CHANNEL / SLACK_ALLOWED_CHANNELS Phase-2 keys.
    # 2026-05-25: broadened from SLACK_BOT_ to SLACK_ when /channels Slack
    # card landed — without it init would wipe SLACK_APP_TOKEN on every
    # re-render, identical to the Telegram regression that prompted this
    # whole preservation mechanism.
    "SLACK_",
    "DISCORD_BOT_",
    "WHATSAPP_",
    "SIGNAL_",
    "MATRIX_",
    "MATTERMOST_",
    "BLUEBUBBLES_",
    # TWILIO_* covers the SMS adapter credential triplet — TWILIO_ACCOUNT_SID,
    # TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER — written into the per-profile
    # .env by ctrl-api's /channels SMS card.
    "TWILIO_",
    # SMS_* covers the SMS adapter's user-allowlist + optional knobs
    # (SMS_ALLOWED_USERS, SMS_HOME_CHANNEL, SMS_ALLOW_ALL_USERS,
    # SMS_INSECURE_NO_SIGNATURE). Same wipe-on-re-render regression as the
    # TELEGRAM_/SLACK_ triplets if it were omitted.
    "SMS_",
    # PAPERCLIP_* covers three keys with different lifecycles, all of
    # which must survive re-renders:
    #   - PAPERCLIP_API_KEY: issued by Paperclip's better-auth UI on first
    #     signup; user-supplied (NOT auto-generated by bootstrap.sh) —
    #     wiping it on every init would force the principal to regenerate
    #     after every container restart, which is exactly what this
    #     preservation mechanism was built to prevent.
    #   - PAPERCLIP_BETTER_AUTH_SECRET: auto-gen by bootstrap.sh; rotating
    #     it would log every Paperclip session out across restart.
    #   - PAPERCLIP_HEARTBEAT_SECRET: auto-gen by bootstrap.sh; rotating
    #     it would silently break every inbound Paperclip → Alfred heartbeat
    #     until the operator re-pastes the new value into Paperclip's UI.
    # Same wipe-on-re-render regression class as the messaging adapters
    # above. Added 2026-05-26 (P1 — Paperclip integration).
    "PAPERCLIP_",
)


def _parse_env_keys(text: str) -> dict[str, str]:
    """Lightweight .env parser — KEY=VALUE lines, comments ignored.

    Mirrors python-dotenv enough for our purposes: strips surrounding
    quotes, tolerates CRLF, ignores blank/comment lines, and is forgiving
    about whitespace around `=`. We deliberately do NOT support shell
    interpolation, multiline values, or `export ` prefixes — Hermes' own
    reader is the source of truth at runtime; this parse is only used to
    detect "is this key already set in the rendered output?"
    """
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        eq = line.find("=")
        if eq <= 0:
            continue
        key = line[:eq].strip()
        val = line[eq + 1 :]
        if val.endswith("\r"):
            val = val[:-1]
        if (val.startswith('"') and val.endswith('"')) or (
            val.startswith("'") and val.endswith("'")
        ):
            val = val[1:-1]
        out[key] = val
    return out


def _merge_preserve_runtime_keys(
    rendered: str, env_path: Path, profile: str
) -> str:
    """Append runtime-managed keys (TELEGRAM_*, SLACK_*, …) from the
    existing .env to the freshly-rendered output, if they aren't already
    present in the render.

    codex-builder is the explicit exception: its .env is a STRICT
    positive allowlist (no provider keys, no MCP keys, no channel keys),
    and any preservation step would be a leak vector — a stray
    TELEGRAM_BOT_TOKEN written by ctrl-api into the wrong profile would
    survive across re-renders here without preservation being skipped.
    The sealed runtime exists exactly to keep secret surfaces small;
    treat the per-profile .env as the surface authority.
    """
    if profile == "codex-builder":
        return rendered
    if not env_path.exists():
        return rendered
    try:
        existing_text = env_path.read_text(encoding="utf-8")
    except OSError:
        return rendered
    existing = _parse_env_keys(existing_text)
    rendered_keys = set(_parse_env_keys(rendered).keys())

    preserved: list[tuple[str, str]] = []
    for key, val in existing.items():
        if key in rendered_keys:
            continue
        if not any(key.startswith(p) for p in _RUNTIME_KEY_PREFIXES):
            continue
        preserved.append((key, val))

    if not preserved:
        return rendered

    keys_summary = ", ".join(k for k, _ in preserved)
    print(f"[render] preserving runtime-managed keys from existing .env: {keys_summary}")
    footer_lines = [
        "",
        "# -----------------------------------------------------------------------------",
        "# Runtime-managed keys (preserved across init re-renders).",
        "# Set by ctrl-api UI surfaces (e.g. /channels → Save Token). Do not edit by",
        "# hand here — re-paste via the corresponding UI to keep Vaultwarden in sync.",
        "# -----------------------------------------------------------------------------",
    ]
    for key, val in preserved:
        footer_lines.append(f"{key}={val}")
    suffix = "\n".join(footer_lines) + "\n"
    if not rendered.endswith("\n"):
        rendered = rendered + "\n"
    return rendered + suffix


def main() -> int:
    if len(sys.argv) != 5:
        print(
            "usage: render_hermes.py <profile> <profile_dir> "
            "<template_dir> <gateway_token>",
            file=sys.stderr,
        )
        return 2

    profile = sys.argv[1].strip().lower()
    profile_dir = Path(sys.argv[2])
    template_dir = Path(sys.argv[3])
    gateway_token = sys.argv[4].strip()

    # #120 Lane II — accept any slug matching the registry regex. The four
    # reserved profiles still resolve to their canonical port via
    # _RESERVED_PORT below; any other slug requires HERMES_RENDER_PORT to
    # be set (the supervisor passes the registry's api_server_port).
    if not _SLUG_RE.match(profile):
        print(
            f"error: profile slug {profile!r} does not match "
            f"^[a-z][a-z0-9-]{{1,30}}$",
            file=sys.stderr,
        )
        return 2
    if not gateway_token:
        print("error: gateway token is empty", file=sys.stderr)
        return 2

    # Resolve the API server port.
    #   1. HERMES_RENDER_PORT env override — required for any non-reserved
    #      slug; the supervisor passes the registry's allocated port here.
    #   2. _RESERVED_PORT fallback — used by the existing 4 reserved
    #      profiles when called without an explicit port (back-compat with
    #      every pre-Lane-II caller).
    #   3. Hard error — non-reserved slug with no port is a programmer
    #      mistake we want to surface loud, not silently default to 18789.
    port_override = os.environ.get("HERMES_RENDER_PORT", "").strip()
    if port_override:
        try:
            api_server_port = int(port_override)
        except ValueError:
            print(
                f"error: HERMES_RENDER_PORT={port_override!r} is not an integer",
                file=sys.stderr,
            )
            return 2
    elif profile in _RESERVED_PORT:
        api_server_port = _RESERVED_PORT[profile]
    else:
        print(
            f"error: profile {profile!r} is not a reserved infra profile and "
            "HERMES_RENDER_PORT is unset (the user-facing profile's port from "
            "the agent_profile registry must be passed via HERMES_RENDER_PORT)",
            file=sys.stderr,
        )
        return 2

    profile_dir.mkdir(parents=True, exist_ok=True)

    vault_path = os.environ.get("HERMES_VAULT_PATH", "/vault")
    ctrl_api_url = os.environ.get("CTRL_API_URL", "http://ctrl-api:3100")
    alfred_prime = os.environ.get("ALFRED_PRIME", "").strip()
    cross_tenant_peers = os.environ.get("CROSS_TENANT_PEERS", "").strip()

    # Paths baked into config.yaml must be valid in the Hermes RUNTIME
    # container, whose HERMES_HOME can differ from the init container's write
    # path (e.g. the runtime mounts the volume at /hermes-state while the init
    # image's Dockerfile default is /opt/data). Resolution order: an explicit
    # per-profile override; else derive from the runtime HERMES_HOME; else the
    # write dir. Without this the terminal.cwd / mcp paths bake a dead
    # /opt/data path on a box whose runtime HERMES_HOME diverges (F44).
    runtime_profile_override = os.environ.get(
        "HERMES_RUNTIME_PROFILE_DIR", ""
    ).strip()
    runtime_home = os.environ.get("HERMES_RUNTIME_HOME", "").strip()
    if runtime_profile_override:
        runtime_dir = Path(runtime_profile_override)
    elif runtime_home:
        runtime_dir = Path(runtime_home) / "profiles" / profile
    else:
        runtime_dir = Path(profile_dir)
    mcp_stdio_dir = str(runtime_dir / "mcp-stdio")
    mcp_ctrl_script = str(runtime_dir / "mcp" / "ctrl-server.mjs")
    node_modules = str(runtime_dir / "mcp-stdio" / "node_modules")
    # The profile dir in the runtime view — used for terminal.cwd so it never
    # bakes a dead /opt/data path on a box whose HERMES_HOME diverges (F44).
    runtime_profile_dir = str(runtime_dir)

    env = Environment(
        loader=FileSystemLoader(str(template_dir)),
        undefined=StrictUndefined,
        keep_trailing_newline=True,
    )

    # --- config.yaml ---------------------------------------------------------
    # #120 Lane II — user-facing profiles (anything NOT in the reserved set)
    # render through the same template branch as main: a capable
    # conversational model via openai-codex, with the standard agent posture.
    # The HERMES_RENDER_MODEL env var (set by entrypoint.sh from the registry
    # row) overrides the template's main_model default — so a profile created
    # with model="anthropic/claude-opus-4-6" gets that model in its config.
    is_reserved = profile in _RESERVED_PORT
    is_main_like = profile == "main" or not is_reserved
    model_override = os.environ.get("HERMES_RENDER_MODEL", "").strip()
    main_model_value = (
        model_override
        if (is_main_like and model_override)
        else os.environ.get("HERMES_MAIN_MODEL", "gpt-5.6-terra")
    )

    config_tmpl = env.get_template("hermes-config.yaml.njk")
    config_out = config_tmpl.render(
        profile=profile,
        is_main=is_main_like,
        vault_path=vault_path,
        ctrl_api_url=ctrl_api_url,
        mcp_stdio_dir=mcp_stdio_dir,
        mcp_ctrl_script=mcp_ctrl_script,
        node_modules=node_modules,
        runtime_profile_dir=runtime_profile_dir,
        alfred_prime=alfred_prime,
        cross_tenant_peers=cross_tenant_peers,
        # Codex model tiers (gpt-5.6-terra / gpt-5.6-luna). Overridable via
        # .env (HERMES_MAIN_MODEL / _WORKERS_MODEL / _HEAVY_MODEL) so a model
        # bump is a one-line fix, not a rebuild.
        main_model=main_model_value,
        workers_model=os.environ.get("HERMES_WORKERS_MODEL", "gpt-5.6-luna"),
        # heavy = gpt-5.6-sol (Sir, 2026-08-06). The heavy profile carries
        # the reasoning-bound work — onboarding and Reflection, where
        # Reflection is what proposes instinct promotions — so it gets the
        # strongest tier. Baked here, not only on the volume, because
        # config.yaml is seed-once: a reseed would otherwise silently drop
        # heavy back to terra (the #433 drift class).
        heavy_model=os.environ.get("HERMES_HEAVY_MODEL", "gpt-5.6-sol"),
        # codex-builder runs Hermes' supervising agent on the same openai-
        # codex model the CLI it shells out to uses. Overridable so a
        # future Codex model bump is a one-line .env change, not a
        # template+rebuild. See docs/codex-builder-runtime.md §2.
        codex_builder_model=os.environ.get(
            "HERMES_CODEX_BUILDER_MODEL", "gpt-5-codex"
        ),
    )
    config_path = profile_dir / "config.yaml"
    # config.yaml is operator-owned: once it exists, `hermes config` / the
    # operator owns it, so init only SEEDS it when absent and never clobbers
    # an existing file. The .env (below) stays deployment-managed and is
    # always re-rendered. (When seeding, _preserve_switched_model_block is a
    # no-op since config_path does not exist — kept for the symmetric path.)
    if config_path.exists():
        print(f"[render] config.yaml present at {config_path} — preserved (operator-owned)")
        # Fleet-bake migration (2026-07-02): config.yaml is preserved verbatim,
        # so the template's kanban.dispatch_in_gateway=false never reaches an
        # EXISTING tenant — its stale `true` keeps the 0.17 kanban dispatcher
        # crashing the workers gateway (kanban.db.init.lock PermissionError under
        # the sandbox uid). Alfred doesn't use the kanban board, so force-disable
        # it. Targeted + idempotent: `dispatch_in_gateway` is a kanban-only key,
        # so this touches nothing else the operator may have edited.
        try:
            _cfg_text = config_path.read_text(encoding="utf-8")
            _cfg_new = re.sub(
                r"(dispatch_in_gateway:\s*)(?i:true)\b", r"\1false", _cfg_text
            )
            if "dispatch_in_gateway" not in _cfg_new:
                # No kanban dispatch key at all — an operator-preserved config that
                # predates the template's kanban block (e.g. home's codex-builder).
                # 0.17 DEFAULTS dispatch_in_gateway ON, so the gateway runs the
                # kanban dispatcher → 60s "tick failed" log noise (#175). Append a
                # disabled top-level block (config is a flat top-level mapping, so
                # a col-0 append is valid YAML).
                _cfg_new = _cfg_new.rstrip("\n") + (
                    "\n\n# alfred-black: kanban dispatcher disabled — Alfred uses"
                    " Paperclip + Plane, not the kanban board.\n"
                    "kanban:\n  dispatch_in_gateway: false\n"
                )
            if _cfg_new != _cfg_text:
                config_path.write_text(_cfg_new, encoding="utf-8")
                print(
                    f"[render] MIGRATED kanban.dispatch_in_gateway -> false in {config_path}"
                )
        except OSError as exc:
            print(f"[render] WARN: kanban migration skipped for {config_path}: {exc}")
    else:
        config_out = _preserve_switched_model_block(config_out, config_path)
        config_path.write_text(config_out, encoding="utf-8")
        config_path.chmod(0o640)
        print(f"[render] seeded {config_path} ({len(config_out)} bytes)")

    # --- .env ----------------------------------------------------------------
    env_tmpl = env.get_template("hermes-profile.env.njk")
    env_out = env_tmpl.render(
        profile=profile,
        is_main=is_main_like,
        api_server_port=api_server_port,
        api_server_key=gateway_token,
        # Bind 0.0.0.0 — the Hermes API server is now reached directly over
        # the compose network (the shim that used to front it is gone).
        api_server_host="0.0.0.0",
        api_server_cors=os.environ.get("HERMES_API_CORS_ORIGINS", ""),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        openai_api_key=os.environ.get("OPENAI_API_KEY", ""),
        # Relay/dashboard voice: Groq Whisper STT + the OpenAI realtime model.
        # env_file (.env) surfaces these into the init container; empty on a
        # tenant that doesn't use voice (harmless).
        openai_realtime_model=os.environ.get("OPENAI_REALTIME_MODEL", "gpt-realtime-2"),
        groq_api_key=os.environ.get("GROQ_API_KEY", ""),
        composio_api_key=os.environ.get("COMPOSIO_API_KEY", ""),
        composio_user_id=os.environ.get("COMPOSIO_USER_ID", ""),
        aas_api_key=os.environ.get("AAS_API_KEY", ""),
    )
    env_path = profile_dir / ".env"
    # Merge-preserve runtime-managed keys.
    #
    # Some env keys live in this file but are set at RUNTIME via ctrl-api UI
    # surfaces (e.g. /channels → Save Token → writeProfileEnvKeys in
    # packages/ctrl/src/api/routes/telegram.ts), NOT at init time. Without
    # preservation, every `docker compose up -d --no-deps init` cycle wipes
    # them and the user has to re-paste from the UI (or, worse, lose the
    # value if it wasn't also saved in Vaultwarden).
    #
    # We use an EXPLICIT allowlist of runtime-key prefixes (not a "preserve
    # everything not in the template" rule) so an operator who hand-edits the
    # file with a stale provider key doesn't accidentally pin that stale
    # value across re-renders.
    env_out = _merge_preserve_runtime_keys(env_out, env_path, profile)
    env_path.write_text(env_out, encoding="utf-8")
    # .env carries the API key + provider keys. We want it permissive
    # enough that sibling containers in the SAME compose stack — paperclip
    # (uid 1000), ctrl-api (root), vault-cli (root), the init container
    # itself (root, writes it) — can all read it without each having to
    # docker-engine-side `group_add` or share a numeric GID.
    #
    # 0o644 is deliberate, not lazy:
    #   * The file lives in a NAMED docker volume (`hermes_data`), not a
    #     host bind-mount. It is reachable only by containers in this
    #     compose stack that EXPLICITLY mount the volume — we control that
    #     list (hermes, ctrl-api, paperclip, vault-cli, sure-bootstrap).
    #     World-readable INSIDE the container ≠ world-readable on the
    #     host; the host's volume backing dir is root:root and unreadable
    #     to non-root host users.
    #   * Group-only (0o640) would require every consumer container to be
    #     added to gid 10000 via `group_add`. That fights gosu and any
    #     entrypoint that does its own setuid — supplementary groups are
    #     not preserved across uid transitions inside the container
    #     unless the consumer image adds the gid to /etc/group AND the
    #     entrypoint calls `initgroups()` (or uses `setpriv
    #     --init-groups`). The paperclip upstream entrypoint uses `gosu
    #     node "$@"`, gosu inherits the caller's supplementary groups
    #     fine, but the `node` user has no gid 10000 in /etc/group so the
    #     supplementary group dies at the uid transition. Fixing that
    #     properly requires customising the upstream entrypoint.
    #   * The 0o600 default this replaces was the original cause of an
    #     hour-long misdiagnosed paperclip-MCP HERMES_AUTH=401 storm on
    #     home (Sir, 2026-05-28): the paperclip node server runs as UID
    #     1000 and hit EACCES on this file, the adapter swallowed the
    #     error and sent every heartbeat with no Authorization header,
    #     Hermes rejected with 401, and the symptom (`invalid_api_key` on
    #     a key that worked in a `cat`-as-root docker-exec spot-check)
    #     sent the on-call chasing a phantom env-var bug.
    env_path.chmod(0o644)
    print(f"[render] wrote {env_path} ({len(env_out)} bytes)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
