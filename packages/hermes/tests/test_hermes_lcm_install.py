"""Static-text tests: hermes-lcm plugin is installed for the `main` profile.

`stephenschoettler/hermes-lcm` is Hermes' lossless cross-session context
engine. Install path: clone source + add `plugins.enabled: [hermes-lcm]`
plus `context.engine: lcm` to the profile config. main-only — workers /
heavy are stateless / capped-concurrency and LCM gives them no value.

We pin: Dockerfile clones at a pinned SHA into /opt/hermes-lcm;
supervisor.sh copies that baked location into the main profile dir
(idempotent); main config template carries the YAML blocks; workers +
heavy templates don't.

INSTALL CONTRACT (verified 2026-05-23 against hermes-lcm v0.11.1):

`stephenschoettler/hermes-lcm` is a **filesystem-manifest plugin**, NOT a
pip package. The upstream repo has:

  * `plugin.yaml`        — Hermes manifest (name, version, provides_tools)
  * `__init__.py`        — exposes `register(ctx)` that calls
                           `ctx.register_context_engine(LCMEngine(...))`
  * (no `pyproject.toml`, no `setup.py`, no entry-points)

Hermes' loader (`hermes_cli/plugins.py::PluginManager._scan_directory`)
discovers user plugins under `get_hermes_home() / "plugins" / <name>` —
and on a `hermes -p <profile>` invocation, `main.py::_apply_profile_override`
rewrites `HERMES_HOME` to `<root>/profiles/<profile>/`, so the effective
discovery path becomes `$HERMES_HOME/profiles/<profile>/plugins/<name>`.
That is exactly where supervisor.sh stages the plugin — pip install would
do nothing (no installable metadata) and the directory copy is sufficient.

RUNTIME LOAD VERIFICATION:

Because the plugin loads silently (no startup log line on success), a
broken install (wrong dir, wrong permissions, partial copy) is impossible
to diagnose from `docker logs`. supervisor.sh therefore probes the live
gateway after launch and logs a clear OK / WARNING line per profile. See
`test_supervisor_verifies_lcm_load_after_launch`.
"""
from pathlib import Path

HERMES = Path(__file__).resolve().parent.parent
DOCKERFILE = HERMES / "Dockerfile"
SUPERVISOR = HERMES / "docker" / "supervisor.sh"

# v0.11.1 → resolved 2026-05-23 via `git ls-remote --tags`.
PINNED_SHA = "2d108b759e33b72427350dffcb77281f7f61baf9"


def _render(profile: str) -> str:
    from jinja2 import Environment, FileSystemLoader, StrictUndefined
    env = Environment(
        loader=FileSystemLoader(str(HERMES)),
        undefined=StrictUndefined,
        keep_trailing_newline=True,
    )
    return env.get_template("hermes-config.yaml.njk").render(
        profile=profile,
        main_model="x/main",
        workers_model="x/workers",
        heavy_model="x/heavy",
        alfred_prime="",
        cross_tenant_peers="",
    )


def test_dockerfile_clones_hermes_lcm_at_pinned_sha():
    src = DOCKERFILE.read_text()
    assert "stephenschoettler/hermes-lcm" in src, (
        "Dockerfile must reference the hermes-lcm repo."
    )
    assert PINNED_SHA in src, (
        f"Dockerfile must pin hermes-lcm to commit {PINNED_SHA} (==v0.11.1) "
        "— never `main`/no pin; reproducibility + supply-chain hygiene."
    )
    assert "/opt/hermes-lcm" in src, (
        "Dockerfile must stage the plugin at /opt/hermes-lcm — the known "
        "location supervisor.sh copies from."
    )


def test_supervisor_installs_lcm_for_main_only():
    src = SUPERVISOR.read_text()
    assert "$HERMES_HOME/profiles/main/plugins/hermes-lcm" in src, (
        "supervisor.sh must install hermes-lcm into "
        "`$HERMES_HOME/profiles/main/plugins/hermes-lcm`."
    )
    assert "profiles/workers/plugins/hermes-lcm" not in src
    assert "profiles/heavy/plugins/hermes-lcm" not in src


def test_supervisor_lcm_install_is_idempotent():
    src = SUPERVISOR.read_text()
    assert (
        '! -e "$HERMES_HOME/profiles/main/plugins/hermes-lcm"' in src
        or '! -d "$HERMES_HOME/profiles/main/plugins/hermes-lcm"' in src
    ), "install must be guarded with `[[ ! -e ... ]]` or `[[ ! -d ... ]]`"
    assert "/opt/hermes-lcm" in src, (
        "supervisor.sh must copy from /opt/hermes-lcm (baked image location)."
    )


def test_main_config_has_lcm_plugin_block():
    rendered = _render("main")
    assert "plugins:" in rendered
    assert "hermes-lcm" in rendered, (
        "main config must enable `plugins.enabled: [hermes-lcm]`."
    )
    assert "engine: lcm" in rendered, (
        "main config must set `context.engine: lcm`."
    )


def test_workers_config_has_no_lcm_block():
    rendered = _render("workers")
    assert "hermes-lcm" not in rendered, "workers must NOT enable hermes-lcm"
    assert "engine: lcm" not in rendered


def test_heavy_config_has_no_lcm_block():
    rendered = _render("heavy")
    assert "hermes-lcm" not in rendered, "heavy must NOT enable hermes-lcm"
    assert "engine: lcm" not in rendered


def test_dockerfile_does_not_pip_install_lcm():
    """hermes-lcm is a filesystem-manifest plugin, NOT a pip package.

    Upstream `stephenschoettler/hermes-lcm` v0.11.1 ships:
      - `plugin.yaml`  (Hermes manifest)
      - `__init__.py`  (`register(ctx)` entry point)

    It has NO `pyproject.toml` / `setup.py` / `setup.cfg`. Running
    `pip install /opt/hermes-lcm` would fail with "neither 'setup.py'
    nor 'pyproject.toml' found". Hermes discovers this kind of plugin
    by scanning `$HERMES_HOME/plugins/<name>/plugin.yaml` directly
    (see `hermes_cli/plugins.py::_scan_directory`) — no Python
    install step is required or possible.
    """
    src = DOCKERFILE.read_text()
    # The bake section MUST NOT pip-install /opt/hermes-lcm.
    lcm_block_start = src.index("Bake the hermes-lcm plugin")
    lcm_block_end = src.index("=", lcm_block_start + 100)
    lcm_block_end = src.index("=" * 30, lcm_block_end)
    lcm_block = src[lcm_block_start:lcm_block_end]
    assert "pip install" not in lcm_block, (
        "Do NOT `pip install /opt/hermes-lcm` — the upstream plugin has no "
        "pyproject.toml/setup.py. It is a filesystem-manifest plugin "
        "loaded by Hermes from $HERMES_HOME/plugins/<name>/plugin.yaml."
    )


def test_supervisor_verifies_lcm_load_after_launch():
    """supervisor.sh must probe whether hermes-lcm is actually active and log it.

    Because the plugin loads silently (no Hermes startup log entry on
    success), a broken install — wrong destination dir, partial copy,
    wrong HERMES_HOME, plugin contract mismatch with the running Hermes
    version — produces ZERO signal in `docker logs`. The supervisor
    therefore polls the gateway's /v1/tools endpoint after launch and
    logs one of:

      [supervisor] hermes-lcm OK: context engine 'lcm' active on main
      [supervisor] WARNING: hermes-lcm in main/config.yaml but not loaded …

    so the live runtime state is obvious from `docker logs hermes` alone.
    """
    src = SUPERVISOR.read_text()
    assert "verify_lcm" in src or "lcm_load_check" in src or "lcm-verify" in src, (
        "supervisor.sh must contain an LCM-load verification step "
        "(function/label name must include 'verify_lcm', 'lcm_load_check', "
        "or 'lcm-verify')."
    )
    # The probe must hit the live gateway, not just re-check the filesystem.
    # We accept either an HTTP probe to /v1/tools or a `hermes plugins` CLI
    # query — both surface the actual loaded-plugin state.
    has_http_probe = "18789/v1/tools" in src or "localhost:18789/v1/tools" in src
    has_cli_probe = "hermes -p main plugins" in src or "hermes plugins" in src
    assert has_http_probe or has_cli_probe, (
        "supervisor.sh LCM verify step must probe the live runtime "
        "(curl http://localhost:18789/v1/tools | grep lcm_  OR  hermes -p main plugins list)."
    )
    # And it must emit a clear WARNING on failure so `docker logs` shows it.
    assert "WARNING: hermes-lcm" in src, (
        "supervisor.sh must log a clear 'WARNING: hermes-lcm …' line when "
        "the plugin is configured but not active — silent failure is the "
        "exact bug this guards against."
    )


def test_supervisor_lcm_verify_runs_in_background():
    """The verify step must NOT block the supervisor's main supervise loop.

    The probe waits for the gateway's /health to come up (start-period
    is 180s in the Dockerfile HEALTHCHECK) — if it ran inline it would
    delay the supervise loop and stall the workers/heavy restart watch.
    """
    src = SUPERVISOR.read_text()
    # Look for a backgrounded invocation (`&` at end of the call, or `nohup`,
    # or a `(...) &` group).
    # We don't try to parse bash; we just require the keyword `verify_lcm`
    # (or equivalent) to appear with a trailing `&` or as a `( ... ) &` block.
    import re
    bg_patterns = [
        r"verify_lcm[^&\n]*&",            # `verify_lcm ... &`
        r"\(\s*verify_lcm",               # `( verify_lcm ...`  (assumed `) &` later)
        r"lcm_load_check[^&\n]*&",
        r"\(\s*lcm_load_check",
    ]
    assert any(re.search(p, src) for p in bg_patterns), (
        "LCM verify must be backgrounded (`verify_lcm &` or `( verify_lcm ... ) &`) "
        "so it doesn't block the supervisor's restart loop while waiting "
        "for /health."
    )
