"""Static-text + behavioural test for #120 Lane IIb — supervisor self-renders
missing profile dirs.

Lane II (PRs #198/#199/#200) shipped the registry-driven activation path
(SIGUSR1 → reconcile_registry → start_registered_profile). That worked for
profiles whose dirs were already rendered by the init container, but a
profile created AT RUNTIME (via ctrl-api's POST /api/v1/agent-profiles) has
no rendered dir until the next init pass. The supervisor logged
``WARN: skipping launch of '<slug>' — profile dir not rendered`` and the
gateway never came up — the principal-creates-profile flow required an
operator step to fire init.

Lane IIb closes that gap: start_registered_profile inline-invokes the same
two renderer scripts the init container runs (render_hermes.py +
render_mcp_servers.py) when the profile dir is missing, then proceeds with
the existing launch path. The renderer scripts + .njk templates are baked
into the hermes runtime image under /opt/hermes-init/.

These tests are static-text checks against supervisor.sh + the Dockerfile.
A behavioural test would need a running hermes container; the smoke test in
the PR runbook does that end-to-end.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUPERVISOR = ROOT / "docker" / "supervisor.sh"
DOCKERFILE = ROOT / "Dockerfile"


def _read_supervisor() -> str:
    return SUPERVISOR.read_text()


def _read_dockerfile() -> str:
    return DOCKERFILE.read_text()


def test_supervisor_defines_render_profile_dir():
    """The helper that runs the renderer scripts inline must exist."""
    src = _read_supervisor()
    assert "render_profile_dir()" in src, (
        "supervisor.sh must define render_profile_dir() — the inline "
        "renderer the SIGUSR1 reconciler calls when a registered profile "
        "has no on-disk dir."
    )


def test_start_registered_profile_inline_renders_when_missing():
    """When a registered profile has no config.yaml/.env, the launcher must
    call render_profile_dir BEFORE returning. The old `WARN: skipping launch`
    early-return is no longer acceptable — that's the bug Lane IIb fixes."""
    src = _read_supervisor()
    assert "render_profile_dir \"$slug\" \"$port\"" in src, (
        "start_registered_profile must dispatch to render_profile_dir when "
        "the profile dir is missing (slug + port positional args)."
    )
    # The dead "skipping launch — profile dir not rendered" early-return MUST
    # be gone. Its presence means the supervisor silently no-ops on a new
    # profile, which is the regression Lane IIb closes.
    assert "WARN: skipping launch of" not in src or "profile dir not rendered" not in src, (
        "the legacy `WARN: skipping launch of … profile dir not rendered` "
        "early-return must be removed — Lane IIb requires the supervisor "
        "to render the missing dir inline, not skip."
    )


def test_render_profile_dir_invokes_both_renderer_scripts():
    """The helper must run BOTH render_hermes.py AND render_mcp_servers.py —
    the same two scripts the init container runs. Missing either leaves the
    rendered profile incomplete (missing MCP catalogue or missing .env)."""
    src = _read_supervisor()
    assert "render_hermes.py" in src, (
        "render_profile_dir must invoke render_hermes.py (the same script "
        "init runs to render config.yaml + .env)."
    )
    assert "render_mcp_servers.py" in src, (
        "render_profile_dir must invoke render_mcp_servers.py (the ADD-only "
        "MCP-server backfill mutator) — without it the rendered config "
        "lacks `hass` / `files` MCP entries for main-like profiles."
    )


def test_render_profile_dir_passes_registry_port_and_model():
    """The renderer takes the registry-allocated port + model via env. The
    init container passes HERMES_RENDER_PORT/HERMES_RENDER_MODEL; the
    supervisor's runtime self-render MUST use the same env contract so a
    runtime-rendered profile is byte-identical to a boot-rendered one."""
    src = _read_supervisor()
    assert "HERMES_RENDER_PORT=" in src, (
        "render_profile_dir must export HERMES_RENDER_PORT — "
        "render_hermes.py requires it for any non-reserved slug."
    )
    assert "HERMES_RENDER_MODEL=" in src, (
        "render_profile_dir must export HERMES_RENDER_MODEL — fed from the "
        "registry's model column so user-facing profile models propagate."
    )


def test_render_profile_dir_uses_gateway_token():
    """render_hermes.py's 4th positional arg is the gateway token (becomes
    API_SERVER_KEY in the .env). The runtime self-render reads it from the
    same file the init container writes (/alfred-data/.gateway-token)."""
    src = _read_supervisor()
    assert "OPENCLAW_GATEWAY_TOKEN_FILE" in src, (
        "render_profile_dir must read the gateway token from "
        "OPENCLAW_GATEWAY_TOKEN_FILE (default /alfred-data/.gateway-token) — "
        "no hardcoded token, no env-var token, same surface as init."
    )


def test_render_profile_dir_sources_main_env_for_provider_keys():
    """main/.env carries AAS_API_KEY, OPENAI_API_KEY, COMPOSIO_*, etc. that
    the hermes runtime container's compose env does NOT propagate. The
    self-render must source main/.env BEFORE invoking render_hermes.py, else
    the new profile's .env has those keys blank and the new gateway 401s on
    every ctrl-api call."""
    src = _read_supervisor()
    # Look for the source pattern that pulls main/.env into the subshell.
    # Allow either `. "${PROFILES_DIR}/main/.env"` or the same with
    # alternative quoting; the substring `/main/.env` inside a `.` block is
    # the load-bearing piece.
    main_env_sourced = (
        '"${PROFILES_DIR}/main/.env"' in src
        and ". \"${PROFILES_DIR}/main/.env\"" in src
    )
    assert main_env_sourced, (
        "render_profile_dir must `. \"${PROFILES_DIR}/main/.env\"` inside "
        "its subshell so AAS_API_KEY / COMPOSIO_* / OPENAI_API_KEY values "
        "propagate into the rendered profile's .env."
    )


def test_render_profile_dir_returns_nonzero_on_render_failure():
    """If the renderer scripts crash or the gateway token is missing, the
    helper must return non-zero so start_registered_profile skips the
    launch (the existing `skip launch` path the SIGUSR1 reconciler retries
    on the next tick). Surfacing a clean ERROR log line is part of the
    contract."""
    src = _read_supervisor()
    # The ERROR log line emitted on a failed inline render.
    assert "ERROR: inline render failed for" in src, (
        "start_registered_profile must log an ERROR (not silently skip) "
        "when render_profile_dir returns non-zero — operators rely on this "
        "to triage why a profile didn't come up."
    )


def test_render_profile_dir_logs_info_line():
    """The supervisor must log a clear INFO line when an inline render
    fires. The smoke test in the PR runbook greps for this — it's the only
    visible signal that the supervisor (not init) did the work."""
    src = _read_supervisor()
    assert "INFO: profile dir missing for" in src, (
        "render_profile_dir must log `INFO: profile dir missing for '<slug>' "
        "— rendering inline` so operators can confirm the runtime self-render "
        "path fired (not the init container)."
    )


def test_dockerfile_bakes_renderer_scripts_into_runtime_image():
    """The runtime image (NOT the init image) must carry render_hermes.py +
    render_mcp_servers.py + the two .njk templates at /opt/hermes-init/.
    Without them the supervisor's self-render path can't fire and the bug
    Lane IIb fixes regresses."""
    src = _read_dockerfile()
    assert "/opt/hermes-init/render_hermes.py" in src, (
        "Dockerfile must COPY packages/hermes/init/render_hermes.py to "
        "/opt/hermes-init/render_hermes.py for the runtime self-render."
    )
    assert "/opt/hermes-init/render_mcp_servers.py" in src, (
        "Dockerfile must COPY packages/hermes/init/render_mcp_servers.py to "
        "/opt/hermes-init/render_mcp_servers.py for the runtime self-render."
    )
    assert "/opt/hermes-init/templates/hermes-config.yaml.njk" in src, (
        "Dockerfile must COPY packages/hermes/hermes-config.yaml.njk to "
        "/opt/hermes-init/templates/hermes-config.yaml.njk — render_hermes "
        "needs the template directory on the runtime image."
    )
    assert "/opt/hermes-init/templates/hermes-profile.env.njk" in src, (
        "Dockerfile must COPY packages/hermes/hermes-profile.env.njk to "
        "/opt/hermes-init/templates/hermes-profile.env.njk — render_hermes "
        "needs the .env template too."
    )


def test_dockerfile_installs_jinja_and_ruamel_for_renderers():
    """render_hermes.py imports jinja2; render_mcp_servers.py imports
    ruamel.yaml. Both must be pip-installed in the runtime image — without
    them the renderer scripts crash on import and self-render is dead."""
    src = _read_dockerfile()
    # The init Dockerfile pins jinja2==3.1.6 and ruamel.yaml==0.18.6. The
    # runtime Dockerfile must install the same versions for byte-stable
    # output across re-renders (init + runtime produce identical bytes).
    assert "jinja2==3.1.6" in src, (
        "Dockerfile must pin jinja2==3.1.6 (same version as the init image) "
        "for the supervisor self-render path."
    )
    assert "ruamel.yaml==0.18.6" in src, (
        "Dockerfile must pin ruamel.yaml==0.18.6 (same version as the init "
        "image) so render_mcp_servers.py can load."
    )


def test_render_profile_dir_called_from_start_registered_profile():
    """Behavioural anchor: the render call must sit INSIDE
    start_registered_profile's missing-dir branch, not as a separate boot
    hook. The whole point of Lane IIb is that the SIGUSR1 reconciler's
    start_registered_profile call (one per registered slug) closes the gap
    end-to-end."""
    src = _read_supervisor()
    lines = src.splitlines()
    # Find the function definition line.
    fn_start = next(
        (i for i, ln in enumerate(lines) if ln.startswith("start_registered_profile()")),
        -1,
    )
    assert fn_start >= 0
    # Find the next top-level function definition (or end of file).
    fn_end = len(lines)
    for i in range(fn_start + 1, len(lines)):
        ln = lines[i]
        if ln.startswith("}") and (i + 1 >= len(lines) or not lines[i + 1].startswith("    ")):
            fn_end = i + 1
            break
    body = "\n".join(lines[fn_start:fn_end])
    assert "render_profile_dir" in body, (
        "start_registered_profile's body must call render_profile_dir — it's "
        "the closure of the Lane IIb fix; placing the render call elsewhere "
        "(e.g. in reconcile_registry directly) loses the per-slug retry "
        "semantics and the existing test fixtures."
    )
