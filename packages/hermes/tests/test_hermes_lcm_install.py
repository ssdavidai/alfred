"""Static-text tests: hermes-lcm plugin is installed for the `main` profile.

`stephenschoettler/hermes-lcm` is Hermes' lossless cross-session context
engine. Install path: clone source + add `plugins.enabled: [hermes-lcm]`
plus `context.engine: lcm` to the profile config. main-only — workers /
heavy are stateless / capped-concurrency and LCM gives them no value.

We pin: Dockerfile clones at a pinned SHA into /opt/hermes-lcm;
supervisor.sh copies that baked location into the main profile dir
(idempotent); main config template carries the YAML blocks; workers +
heavy templates don't.
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
