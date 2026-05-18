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

Path-baking: the absolute paths baked INTO the rendered config.yaml
(mcp-stdio dir, ctrl-server.mjs, NODE_PATH) must be valid in the HERMES
RUNTIME container, which mounts the same volume at a different path
(HERMES_HOME, default /opt/data). Set HERMES_RUNTIME_PROFILE_DIR to that
runtime view (e.g. /opt/data/profiles/main); the script writes the files
through <profile_dir> but bakes paths from HERMES_RUNTIME_PROFILE_DIR.
When unset, it falls back to <profile_dir> (single-view setups).

The script is idempotent: it always overwrites config.yaml + .env so a
re-run picks up template or env changes. It never touches sessions,
memory, or skills.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined

# Internal Hermes API server ports — the hermes-shim binds the legacy
# 18789/18790 and forwards here. Must match docker/supervisor.sh and
# the shim's port table.
_INTERNAL_API_PORT = {"main": 18799, "workers": 18800}


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
    )
    config_path = profile_dir / "config.yaml"
    config_path.write_text(config_out, encoding="utf-8")
    config_path.chmod(0o640)
    print(f"[render] wrote {config_path} ({len(config_out)} bytes)")

    # --- .env ----------------------------------------------------------------
    env_tmpl = env.get_template("hermes-profile.env.njk")
    env_out = env_tmpl.render(
        profile=profile,
        api_server_port=_INTERNAL_API_PORT[profile],
        api_server_key=gateway_token,
        api_server_host="127.0.0.1",
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
