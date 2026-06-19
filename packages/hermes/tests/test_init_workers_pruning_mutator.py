"""Tests for render_workers_pruning.py — the idempotent ADD-only mutator that
backfills the disk-bloat GC cron (prune-old-sessions + vacuum-state-db) onto
the background profiles' (workers / heavy) config.yaml.

Why this script exists: `render_hermes.py` is seed-only — once config.yaml
exists on disk, init never re-renders it. So the GC `cron:` block added to
hermes-config.yaml.njk for the background profiles is invisible to any tenant
whose config.yaml was seeded before the change — exactly the bloated fleet
(2026-06-19: zsolt workers state.db 111G + sessions/ 140G filled the disk).

This mutator runs after render_hermes.py on every init boot. It is:
  - ADD-only: an operator-tuned job with the same name survives verbatim
  - Per-profile: workers + heavy only (no-op on main / codex-builder)
  - Idempotent: returns "present" with no rewrite when both jobs exist
  - Best-effort: missing config returns a sentinel, never raises
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


HERMES = Path(__file__).resolve().parent.parent
RENDER_SCRIPT = HERMES / "init" / "render_workers_pruning.py"


def _load_render_module():
    spec = importlib.util.spec_from_file_location(
        "render_workers_pruning", RENDER_SCRIPT
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


RUNTIME_DIR = "/hermes-state/profiles/workers"


def _call(mod, config: Path, profile: str = "workers", runtime: str = RUNTIME_DIR):
    return mod.ensure_workers_pruning(
        config, profile=profile, runtime_profile_dir=runtime
    )


# --- core behaviour ---------------------------------------------------------
def test_added_when_no_cron_block(tmp_path: Path, render_module):
    """A workers config.yaml with no `cron:` block at all gets both GC jobs
    injected (the pre-change seed shape — the template renders no cron for
    the background profiles before this fix)."""
    config = tmp_path / "config.yaml"
    config.write_text(
        "model:\n  default: x-ai/grok-4.1-fast\n", encoding="utf-8"
    )

    assert _call(render_module, config) == "added"

    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    jobs = {j["name"]: j for j in data["cron"]["jobs"]}
    assert set(jobs) == {"prune-old-sessions", "vacuum-state-db"}
    assert data["cron"]["wrap_response"] is False
    # The prune job targets the runtime sessions dir + the 7-day window.
    assert f"{RUNTIME_DIR}/sessions" in jobs["prune-old-sessions"]["command"]
    assert "-mtime +7" in jobs["prune-old-sessions"]["command"]
    assert "request_dump_*.json" in jobs["prune-old-sessions"]["command"]
    # The vacuum job targets state.db.
    assert f"{RUNTIME_DIR}/state.db" in jobs["vacuum-state-db"]["command"]
    assert "VACUUM" in jobs["vacuum-state-db"]["command"]
    # Existing keys preserved.
    assert data["model"]["default"] == "x-ai/grok-4.1-fast"


def test_added_when_cron_exists_without_gc_jobs(tmp_path: Path, render_module):
    """A config that already has `cron:` for some other reason gets the GC
    jobs grafted into `cron.jobs` WITHOUT dropping the operator's job."""
    config = tmp_path / "config.yaml"
    config.write_text(
        "cron:\n"
        "  wrap_response: true\n"
        "  jobs:\n"
        "    - name: operator-job\n"
        "      schedule: '0 9 * * *'\n"
        "      command: echo hi\n",
        encoding="utf-8",
    )

    assert _call(render_module, config) == "added"

    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    names = {j["name"] for j in data["cron"]["jobs"]}
    assert "operator-job" in names  # preserved
    assert {"prune-old-sessions", "vacuum-state-db"} <= names
    # An operator wrap_response is NOT overwritten.
    assert data["cron"]["wrap_response"] is True


def test_noop_when_both_jobs_present(tmp_path: Path, render_module):
    """If both GC jobs already exist (previously injected / operator-set),
    the mutator is a no-op and does not rewrite the file."""
    config = tmp_path / "config.yaml"
    config.write_text(
        "cron:\n"
        "  wrap_response: false\n"
        "  jobs:\n"
        "    - name: prune-old-sessions\n"
        "      schedule: '23 3 * * *'\n"
        "      command: custom-prune\n"
        "    - name: vacuum-state-db\n"
        "      schedule: '43 3 * * *'\n"
        "      command: custom-vacuum\n",
        encoding="utf-8",
    )
    original = config.read_text()

    assert _call(render_module, config) == "present"
    assert config.read_text() == original  # byte-equal, no rewrite


def test_operator_tuned_job_preserved(tmp_path: Path, render_module):
    """An operator-tuned prune job (different schedule/command, same name)
    survives verbatim — the mutator is ADD-only, keyed by job name. Only the
    missing vacuum job is grafted."""
    config = tmp_path / "config.yaml"
    config.write_text(
        "cron:\n"
        "  jobs:\n"
        "    - name: prune-old-sessions\n"
        "      schedule: '0 2 * * *'\n"
        "      command: find /custom -mtime +30 -delete\n",
        encoding="utf-8",
    )

    assert _call(render_module, config) == "added"

    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    jobs = {j["name"]: j for j in data["cron"]["jobs"]}
    # Operator's prune job untouched.
    assert jobs["prune-old-sessions"]["schedule"] == "0 2 * * *"
    assert jobs["prune-old-sessions"]["command"] == "find /custom -mtime +30 -delete"
    # Vacuum job backfilled.
    assert "vacuum-state-db" in jobs


def test_heavy_profile_also_gets_gc(tmp_path: Path, render_module):
    """The heavy profile is a background profile too — it gets the GC cron."""
    config = tmp_path / "config.yaml"
    config.write_text("model:\n  default: anthropic/claude-opus\n", encoding="utf-8")
    runtime = "/hermes-state/profiles/heavy"

    assert _call(render_module, config, profile="heavy", runtime=runtime) == "added"

    from ruamel.yaml import YAML
    data = YAML().load(config.read_text())
    names = {j["name"] for j in data["cron"]["jobs"]}
    assert {"prune-old-sessions", "vacuum-state-db"} <= names
    assert f"{runtime}/sessions" in {
        seg
        for j in data["cron"]["jobs"]
        for seg in [j["command"]]
        if runtime in j["command"]
    } or any(runtime in j["command"] for j in data["cron"]["jobs"])


def test_main_profile_skipped(tmp_path: Path, render_module):
    """main renders its own cron block (wrap_response + reminders) and its
    sessions are the live chat surface — never touched by this mutator."""
    config = tmp_path / "config.yaml"
    config.write_text("cron:\n  wrap_response: false\n", encoding="utf-8")
    original = config.read_text()

    assert _call(render_module, config, profile="main") == "skipped"
    assert config.read_text() == original


def test_codex_builder_skipped(tmp_path: Path, render_module):
    """codex-builder has its own cleanup-old-runs GC and is a sealed runtime
    — this mutator must not touch it."""
    config = tmp_path / "config.yaml"
    config.write_text("cron:\n  jobs: []\n", encoding="utf-8")

    assert _call(render_module, config, profile="codex-builder") == "skipped"


def test_no_config_returns_cleanly(tmp_path: Path, render_module):
    """A missing config.yaml is recoverable — return a sentinel, never raise,
    so init never aborts on a fresh boot before render_hermes seeds the file."""
    assert _call(render_module, tmp_path / "missing.yaml") == "skipped"


# --- entrypoint.sh + Dockerfile wire pins -----------------------------------
def test_entrypoint_invokes_pruning_step():
    """The init entrypoint must call render_workers_pruning.py, guarded for
    the case where the profile's config.yaml does not yet exist."""
    src = (HERMES / "init" / "entrypoint.sh").read_text()
    assert "render_workers_pruning.py" in src


def test_entrypoint_pruning_runs_after_render_hermes():
    """Order matters: render_hermes seeds the file; render_workers_pruning
    backfills the GC cron onto it."""
    src = (HERMES / "init" / "entrypoint.sh").read_text()
    render_idx = src.find("python3 /setup/render_hermes.py")
    prune_idx = src.find("python3 /setup/render_workers_pruning.py")
    assert 0 < render_idx < prune_idx


def test_dockerfile_copies_render_workers_pruning():
    """The init image must bundle the mutator alongside the other mutators."""
    dockerfile = (HERMES / "init" / "Dockerfile").read_text()
    assert "COPY packages/hermes/init/render_workers_pruning.py" in dockerfile


# --- template wire pin ------------------------------------------------------
def test_template_renders_gc_cron_for_workers():
    """The .njk template must render the two GC jobs for the workers profile
    (new-tenant first-seed path). Mirrors what the mutator backfills."""
    jinja2 = pytest.importorskip("jinja2")
    import yaml as pyyaml

    src = (HERMES / "hermes-config.yaml.njk").read_text()
    out = jinja2.Environment().from_string(src).render(
        profile="workers",
        is_main=False,
        workers_model="x-ai/grok-4.1-fast",
        runtime_profile_dir="/hermes-state/profiles/workers",
    )
    data = pyyaml.safe_load(out)
    names = {j["name"] for j in data["cron"]["jobs"]}
    assert {"prune-old-sessions", "vacuum-state-db"} == names
