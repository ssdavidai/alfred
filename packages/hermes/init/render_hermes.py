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
    render_hermes.py <profile> <profile_dir> <template_dir>

Environment (read for template variables):
    OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY
    COMPOSIO_API_KEY, COMPOSIO_USER_ID
    AAS_API_KEY
    ALFRED_PRIME, CROSS_TENANT_PEERS
    HERMES_VAULT_PATH        (default /vault)
    CTRL_API_URL             (default http://ctrl-api:3100)
    HERMES_API_CORS_ORIGINS  (optional CORS allowlist)

Positional:
    <profile>       "main" | "workers"
    <profile_dir>   absolute path where this process WRITES config.yaml +
                    .env (the init container's view of the volume,
                    e.g. /hermes-data/profiles/main)
    <template_dir>  directory holding the two .njk templates
    <gateway_token> the value of /alfred-data/.gateway-token — becomes
                    API_SERVER_KEY in the profile .env

The Hermes API server binds the canonical ports 18789 (main) / 18790
(workers) directly — the hermes-shim that used to front it was retired in
issue #40.

Path-baking: the absolute paths baked INTO the rendered config.yaml
(mcp-stdio dir, ctrl-server.mjs, NODE_PATH) must be valid in the HERMES
RUNTIME container, which mounts the same volume at a different path
(HERMES_HOME, default /opt/data). Set HERMES_RUNTIME_PROFILE_DIR to that
runtime view (e.g. /opt/data/profiles/main); the script writes the files
through <profile_dir> but bakes paths from HERMES_RUNTIME_PROFILE_DIR.
When unset, it falls back to <profile_dir> (single-view setups).

The script is idempotent: it re-renders config.yaml + .env on every run so
template and .env changes propagate. The ONE exception: if the principal
has switched the LLM provider away from the default (openrouter) using
Hermes' own `hermes model` command, the `model:` block in config.yaml is
preserved across re-renders rather than clobbered back to the template
default. It never touches sessions, memory, skills, or auth.json.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined

# Hermes API server ports — the canonical ports every caller already uses.
# The hermes-shim was retired (issue #40); the Hermes API server now binds
# these ports directly. Must match docker/supervisor.sh and the EXPOSE in
# the Dockerfile.
_API_SERVER_PORT = {"main": 18789, "workers": 18790}

# The template renders the `model:` block with `provider: openrouter`. Hermes
# owns provider/model selection natively (`hermes model`, with a live model
# picker) and that edit lands in config.yaml — which this script re-renders
# on every boot. To avoid clobbering a deliberate switch, a re-render keeps
# the existing `model:` block whenever its provider is no longer the default.
_DEFAULT_PROVIDER = "openrouter"


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
    if not provider or provider == _DEFAULT_PROVIDER:
        return rendered  # still on the default — re-render from the template
    new_lines = rendered.splitlines(keepends=True)
    print(f"[render] preserving user-switched model: block (provider={provider})")
    return (
        "".join(new_lines[: new_span[0]])
        + old_block
        + "".join(new_lines[new_span[1] :])
    )


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

    if profile not in ("main", "workers"):
        print(f"error: profile must be main|workers, got {profile!r}", file=sys.stderr)
        return 2
    if not gateway_token:
        print("error: gateway token is empty", file=sys.stderr)
        return 2

    profile_dir.mkdir(parents=True, exist_ok=True)

    vault_path = os.environ.get("HERMES_VAULT_PATH", "/vault")
    ctrl_api_url = os.environ.get("CTRL_API_URL", "http://ctrl-api:3100")
    alfred_prime = os.environ.get("ALFRED_PRIME", "").strip()
    cross_tenant_peers = os.environ.get("CROSS_TENANT_PEERS", "").strip()

    # Paths baked into config.yaml must be valid in the Hermes RUNTIME
    # container. Use HERMES_RUNTIME_PROFILE_DIR when set; else the write dir.
    runtime_dir = Path(
        os.environ.get("HERMES_RUNTIME_PROFILE_DIR", str(profile_dir))
    )
    mcp_stdio_dir = str(runtime_dir / "mcp-stdio")
    mcp_ctrl_script = str(runtime_dir / "mcp" / "ctrl-server.mjs")
    node_modules = str(runtime_dir / "mcp-stdio" / "node_modules")

    env = Environment(
        loader=FileSystemLoader(str(template_dir)),
        undefined=StrictUndefined,
        keep_trailing_newline=True,
    )

    # --- config.yaml ---------------------------------------------------------
    config_tmpl = env.get_template("hermes-config.yaml.njk")
    config_out = config_tmpl.render(
        profile=profile,
        vault_path=vault_path,
        ctrl_api_url=ctrl_api_url,
        mcp_stdio_dir=mcp_stdio_dir,
        mcp_ctrl_script=mcp_ctrl_script,
        node_modules=node_modules,
        alfred_prime=alfred_prime,
        cross_tenant_peers=cross_tenant_peers,
        # Bare OpenRouter model IDs (no `openrouter/` prefix — `provider:
        # openrouter` + base_url route it). Overridable via .env so a
        # stale model ID is a one-line fix, not a rebuild.
        main_model=os.environ.get("HERMES_MAIN_MODEL", "x-ai/grok-4.3"),
        workers_model=os.environ.get("HERMES_WORKERS_MODEL", "openai/gpt-4.1-nano"),
    )
    config_path = profile_dir / "config.yaml"
    config_out = _preserve_switched_model_block(config_out, config_path)
    config_path.write_text(config_out, encoding="utf-8")
    config_path.chmod(0o640)
    print(f"[render] wrote {config_path} ({len(config_out)} bytes)")

    # --- .env ----------------------------------------------------------------
    env_tmpl = env.get_template("hermes-profile.env.njk")
    env_out = env_tmpl.render(
        profile=profile,
        api_server_port=_API_SERVER_PORT[profile],
        api_server_key=gateway_token,
        # Bind 0.0.0.0 — the Hermes API server is now reached directly over
        # the compose network (the shim that used to front it is gone).
        api_server_host="0.0.0.0",
        api_server_cors=os.environ.get("HERMES_API_CORS_ORIGINS", ""),
        openrouter_api_key=os.environ.get("OPENROUTER_API_KEY", ""),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        openai_api_key=os.environ.get("OPENAI_API_KEY", ""),
        composio_api_key=os.environ.get("COMPOSIO_API_KEY", ""),
        composio_user_id=os.environ.get("COMPOSIO_USER_ID", ""),
        aas_api_key=os.environ.get("AAS_API_KEY", ""),
    )
    env_path = profile_dir / ".env"
    env_path.write_text(env_out, encoding="utf-8")
    # .env carries the API key + provider keys — restrict it.
    env_path.chmod(0o600)
    print(f"[render] wrote {env_path} ({len(env_out)} bytes)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
