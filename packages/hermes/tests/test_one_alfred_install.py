"""Static-text tests: the `one-alfred` plugin is installed for the main
profile only.

The plugin is the inbound-side seam of the "one Alfred" UX contract
(packages/ctrl/docs/design/one-alfred.md): it registers
`pre_gateway_dispatch` + `pre_llm_call` + `post_llm_call` hooks against
the gateway runtime, calls ctrl-api's alfred_journal for recent
exchanges, and injects them as system context so main sees a coherent
conversation across the workers/main/heavy session split.

Install contract:
  - Dockerfile COPYs packages/hermes/plugins/one-alfred → /opt/one-alfred
    (NOT a git clone like hermes-lcm — this is our own code, evolves
    with our releases).
  - supervisor.sh refreshes the install on every boot if the image's
    source mtime is newer than the deployed copy.
  - main profile's rendered config.yaml lists `one-alfred` under
    `plugins.enabled`. Workers + heavy must NOT enable it (they don't
    speak to Sir directly).
"""
from __future__ import annotations

from pathlib import Path

HERMES = Path(__file__).resolve().parent.parent
DOCKERFILE = HERMES / "Dockerfile"
SUPERVISOR = HERMES / "docker" / "supervisor.sh"
PLUGIN_DIR = HERMES / "plugins" / "one-alfred"


def _render(profile: str) -> str:
    """Render the hermes-config Nunjucks template — mirrors the render call
    in test_hermes_lcm_install.py so the context shape is consistent.
    """
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


# ---------------------------------------------------------------------------
# Plugin source — exists and ships the required files
# ---------------------------------------------------------------------------

def test_plugin_source_directory_exists():
    assert PLUGIN_DIR.is_dir(), f"{PLUGIN_DIR} must exist"


def test_plugin_has_yaml_manifest():
    manifest = PLUGIN_DIR / "plugin.yaml"
    assert manifest.is_file(), "plugin.yaml is required by Hermes' plugin discovery"
    text = manifest.read_text()
    assert "name: one-alfred" in text


def test_plugin_has_init_py_with_register():
    init = PLUGIN_DIR / "__init__.py"
    assert init.is_file(), "__init__.py is required (defines register(ctx))"
    text = init.read_text()
    assert "def register(ctx" in text, "register(ctx) entry point must exist"
    # Three hooks the design specifies.
    assert "pre_gateway_dispatch" in text
    assert "pre_llm_call" in text
    assert "post_llm_call" in text


# ---------------------------------------------------------------------------
# Dockerfile — bakes the plugin into the image at /opt/one-alfred
# ---------------------------------------------------------------------------

def test_dockerfile_copies_plugin_source():
    src = DOCKERFILE.read_text()
    assert "/opt/one-alfred" in src, (
        "Dockerfile must stage the plugin at /opt/one-alfred"
    )
    assert "packages/hermes/plugins/one-alfred" in src, (
        "Dockerfile must COPY from packages/hermes/plugins/one-alfred"
    )


def test_dockerfile_does_not_git_clone_plugin():
    """Our plugin ships in the repo — it must NOT be cloned from a
    third-party git repo (different lifecycle from hermes-lcm)."""
    src = DOCKERFILE.read_text()
    # Look for `git clone .* one-alfred` patterns — must be absent.
    bad = [
        line
        for line in src.splitlines()
        if "git clone" in line and "one-alfred" in line
    ]
    assert not bad, (
        f"Dockerfile must NOT git clone one-alfred (own-repo plugin): {bad}"
    )


# ---------------------------------------------------------------------------
# Supervisor — installs the plugin into $HERMES_HOME/profiles/main/plugins
# ---------------------------------------------------------------------------

def test_supervisor_deploys_plugin_to_main_only():
    src = SUPERVISOR.read_text()
    assert "/opt/one-alfred" in src, (
        "supervisor.sh must copy from /opt/one-alfred"
    )
    assert "profiles/main/plugins/one-alfred" in src, (
        "supervisor.sh must deploy into main's plugins dir"
    )
    assert "profiles/workers/plugins/one-alfred" not in src, (
        "workers must NOT get one-alfred"
    )
    assert "profiles/heavy/plugins/one-alfred" not in src, (
        "heavy must NOT get one-alfred"
    )


# ---------------------------------------------------------------------------
# Rendered config — main has one-alfred enabled, workers/heavy do not
# ---------------------------------------------------------------------------

def test_main_config_enables_one_alfred_plugin():
    rendered = _render("main")
    assert "one-alfred" in rendered, (
        "main config must list `one-alfred` under plugins.enabled"
    )


def test_workers_config_has_no_one_alfred_plugin():
    rendered = _render("workers")
    assert "one-alfred" not in rendered, (
        "workers profile must NOT enable one-alfred (does not speak to Sir)"
    )


def test_heavy_config_has_no_one_alfred_plugin():
    rendered = _render("heavy")
    assert "one-alfred" not in rendered, (
        "heavy profile must NOT enable one-alfred (does not speak to Sir)"
    )
