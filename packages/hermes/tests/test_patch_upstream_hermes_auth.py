"""Tests for patch_upstream_hermes_auth.py — the in-place patch that
teaches Hermes' auth.py to skip the parent-dir chmod 0o700 when the
parent is an alfred-black profile dir.

GH #119: the codex-feature-builder paperclip dispatch was failing with
hermes_auth_failed / invalid_api_key because Hermes' own
_save_auth_store was reaching down on every save and re-chmodding
/hermes-state/profiles/codex-builder back to 0o700, undoing PR #118's
0o711 traverse bit and locking the paperclip-hermes adapter (uid 1000)
out of `.env`.

These tests verify the patch script:

  1. Successfully patches a synthetic upstream-shaped auth.py.
  2. Is idempotent (re-run is a no-op).
  3. Fails loudly when an upstream needle has moved (tripwire).
  4. The patched code's runtime guard skips the chmod for
     /hermes-state/profiles/* paths AND preserves it for any other
     parent (e.g. ~/.hermes/).
"""
from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
PATCH_SCRIPT = REPO_ROOT / "packages" / "hermes" / "patch_upstream_hermes_auth.py"


# A trimmed but byte-exact replica of the three upstream chmod sites the
# patch script targets. The signatures below match upstream Hermes
# (hermes-agent v2026.5.16) exactly — keep these aligned with the real
# upstream signatures whenever they drift. When the upstream Hermes
# moves them, both this fixture AND the patch script need to update,
# and the build-time tripwire will catch the drift in CI.
UPSTREAM_AUTH_PY_FIXTURE = '''"""Synthetic hermes_cli/auth.py stub mirroring three chmod call sites."""
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict


def _auth_file_path() -> Path:
    return Path("/tmp/auth.json")


def _qwen_cli_auth_path() -> Path:
    return Path("/tmp/qwen-auth.json")


def _nous_shared_store_path() -> Path:
    return Path("/tmp/nous-shared.json")


@contextmanager
def _nous_shared_store_lock():
    yield


def _save_auth_store(auth_store: Dict[str, Any]) -> Path:
    auth_file = _auth_file_path()
    auth_file.parent.mkdir(parents=True, exist_ok=True)
    # Tighten parent dir to 0o700 so siblings can't traverse to creds.
    # No-op on Windows (POSIX mode bits not enforced); ignore failures.
    try:
        os.chmod(auth_file.parent, 0o700)
    except OSError:
        pass
    return auth_file


def _save_qwen_cli_tokens(tokens: Dict[str, Any]) -> Path:
    auth_path = _qwen_cli_auth_path()
    auth_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(auth_path.parent, 0o700)
    except OSError:
        pass
    return auth_path


def _save_nous_shared(state):
    try:
        with _nous_shared_store_lock():
            path = _nous_shared_store_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(path.parent, 0o700)
            except OSError:
                pass
    except Exception:
        pass
'''


@pytest.fixture
def fake_auth_py(tmp_path):
    """Materialise a fake hermes_cli/auth.py under tmp_path/site-packages."""
    site = tmp_path / "site-packages" / "hermes_cli"
    site.mkdir(parents=True)
    auth = site / "auth.py"
    auth.write_text(UPSTREAM_AUTH_PY_FIXTURE)
    return auth


def _load_patch_module(monkeypatch, fake_auth_path):
    spec = importlib.util.spec_from_file_location(
        "patch_upstream_hermes_auth", PATCH_SCRIPT
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "AUTH_PY", str(fake_auth_path))
    return mod


def test_patch_applies_to_synthetic_upstream(fake_auth_py, monkeypatch):
    """All three call sites are patched and the helper is appended."""
    mod = _load_patch_module(monkeypatch, fake_auth_py)
    mod.main()
    patched = fake_auth_py.read_text()

    # Sentinel present at each of the three call sites (+ the helper
    # comment block reuses the phrase, so we expect >= 3).
    assert patched.count(mod.SENTINEL) >= 3, (
        f"sentinel count: {patched.count(mod.SENTINEL)}"
    )
    # Helper function appended.
    assert "_alfred_is_profile_dir" in patched
    assert "/hermes-state/profiles/" in patched
    # The original `os.chmod(..., 0o700)` lines are now guarded — each
    # call site references the helper. Exactly three call-site guards.
    assert patched.count("if not _alfred_is_profile_dir") == 3


def test_patch_is_idempotent(fake_auth_py, monkeypatch):
    """Re-running the patch must be a byte-stable no-op."""
    mod = _load_patch_module(monkeypatch, fake_auth_py)
    mod.main()
    first = fake_auth_py.read_text()
    mod.main()
    second = fake_auth_py.read_text()
    assert first == second


def test_patch_tripwire_on_missing_needle(tmp_path, monkeypatch):
    """If a future HERMES_REF bump moves the upstream chmod hunk so the
    needle no longer matches, the script must exit non-zero (not
    silently bake an unpatched image).
    """
    site = tmp_path / "site-packages" / "hermes_cli"
    site.mkdir(parents=True)
    auth = site / "auth.py"
    auth.write_text("# upstream moved; no chmod calls here at all\nimport os\n")

    mod = _load_patch_module(monkeypatch, auth)
    with pytest.raises(SystemExit) as exc:
        mod.main()
    assert exc.value.code == 2


def test_patched_helper_returns_true_for_profile_dirs(fake_auth_py, monkeypatch):
    """The helper appended by the patch must recognise any
    `/hermes-state/profiles/<name>/` parent (codex-builder, main,
    workers, heavy) as an alfred-black profile dir, AND must return
    False for stock single-user installs.
    """
    mod = _load_patch_module(monkeypatch, fake_auth_py)
    mod.main()

    # Exec the patched file into a fresh namespace and pull the helper.
    ns: dict = {}
    exec(fake_auth_py.read_text(), ns)
    helper = ns["_alfred_is_profile_dir"]

    for name in ("codex-builder", "main", "workers", "heavy"):
        assert helper(Path(f"/hermes-state/profiles/{name}")) is True, name
    # Stock single-user install path: must NOT match — the patch is a
    # no-op on a real user's machine. This is the graceful-degradation
    # contract: on a non-alfred-black box, the upstream tightening still
    # happens, so we don't ship a security regression to anybody else.
    assert helper(Path("/root/.hermes")) is False
    assert helper(Path("/home/sir/.hermes")) is False
    # Nested paths still match (substring contract is intentional —
    # `/hermes-state/profiles/codex-builder/.codex` would also count,
    # which is fine: those subdirs aren't chmod'd by auth.py in upstream;
    # only the auth-file parent is).
    assert helper(Path("/hermes-state/profiles/main/sub/dir")) is True


def test_patch_script_runs_as_subprocess(fake_auth_py, tmp_path):
    """End-to-end: run the patch script as `python3 path/to/patch.py`
    via a thin shim that overrides AUTH_PY. This catches argv handling
    + import-time errors that the in-process tests miss.
    """
    # Write a runner that imports the patch module, redirects AUTH_PY,
    # then calls main().
    runner = tmp_path / "run_patch.py"
    runner.write_text(
        "import importlib.util\n"
        f"spec = importlib.util.spec_from_file_location('p', {str(PATCH_SCRIPT)!r})\n"
        "mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)\n"
        f"mod.AUTH_PY = {str(fake_auth_py)!r}\n"
        "mod.main()\n"
    )
    result = subprocess.run(
        [sys.executable, str(runner)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    patched = fake_auth_py.read_text()
    assert "_alfred_is_profile_dir" in patched
