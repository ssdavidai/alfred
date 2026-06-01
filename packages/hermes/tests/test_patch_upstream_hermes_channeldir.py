"""Tests for patch_upstream_hermes_channeldir.py — the in-place patch that
makes Hermes' shared atomic-write helper (utils.py) fd-safe.

GH #222: the codex-builder profile's gateway wedges with
`[Errno 24] Too many open files`, leaving leaked `.channel_directory_*.tmp`
descriptors behind. The leak is in `utils.py`'s atomic writers
(`atomic_json_write` / `atomic_yaml_write` / `atomic_roundtrip_yaml_update`):
`tempfile.mkstemp()` returns a *raw* fd that is only adopted by the
`with os.fdopen(fd, ...) as f:` block. If `os.fdopen` itself raises (exactly
what happens under fd pressure), the raw fd leaks — the enclosing
`except BaseException` unlinks the `.tmp` file but never `os.close(fd)`. Each
failed write burns one more descriptor, accelerating exhaustion until Slack
`auth.test` drops and the kanban sqlite store fails with "unable to open
database file".

`channel_directory.py` itself is leak-safe (it only *calls* the helper), so
the durable fix patches `utils.py`. These tests verify the patch script:

  1. Successfully patches a byte-exact synthetic upstream-shaped utils.py
     (all three fd-open call sites wrapped + the helper appended).
  2. Is idempotent (re-run is a byte-stable no-op).
  3. Fails loudly when the upstream needle has moved (tripwire, exit 2).
  4. The patched code is genuinely fd-safe: injecting an `os.fdopen` failure
     (the `[Errno 24]` condition) leaks NO file descriptor and leaves NO
     `.channel_directory_*.tmp` file behind, while the happy path still
     writes correctly.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest import mock

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
PATCH_SCRIPT = REPO_ROOT / "packages" / "hermes" / "patch_upstream_hermes_channeldir.py"


# A trimmed but byte-exact replica of the three upstream atomic-write sites
# the patch targets. The `os.fdopen(fd, "w", encoding="utf-8")` expression is
# byte-identical to upstream Hermes (hermes-agent v2026.5.16) — keep these
# aligned with the real upstream whenever it drifts; the build-time tripwire
# (`grep -q` in the Dockerfile) catches a moved needle in CI.
UPSTREAM_UTILS_PY_FIXTURE = '''"""Synthetic utils.py stub mirroring three atomic-write fd-open sites."""
import json
import os
import stat
import tempfile
from pathlib import Path
from typing import Any, Union


def _preserve_file_mode(path):
    try:
        return stat.S_IMODE(path.stat().st_mode) if path.exists() else None
    except OSError:
        return None


def _restore_file_mode(path, mode):
    if mode is None:
        return
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def atomic_replace(tmp_path, target):
    os.replace(str(tmp_path), str(target))
    return str(target)


def atomic_json_write(path, data, *, indent=2, **dump_kwargs):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    original_mode = _preserve_file_mode(path)
    fd, tmp_path = tempfile.mkstemp(
        dir=str(path.parent),
        prefix=f".{path.stem}_",
        suffix=".tmp",
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(
                data,
                f,
                indent=indent,
                ensure_ascii=False,
                **dump_kwargs,
            )
            f.flush()
            os.fsync(f.fileno())
        real_path = atomic_replace(tmp_path, path)
        _restore_file_mode(real_path, original_mode)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def atomic_yaml_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    original_mode = _preserve_file_mode(path)
    fd, tmp_path = tempfile.mkstemp(
        dir=str(path.parent),
        prefix=f".{path.stem}_",
        suffix=".tmp",
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(str(data))
            f.flush()
            os.fsync(f.fileno())
        real_path = atomic_replace(tmp_path, path)
        _restore_file_mode(real_path, original_mode)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def atomic_roundtrip_yaml_update(path, key_path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    original_mode = _preserve_file_mode(path)
    fd, tmp_path = tempfile.mkstemp(
        dir=str(path.parent),
        prefix=f".{path.stem}_",
        suffix=".tmp",
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(f"{key_path}: {value}\\n")
            f.flush()
            os.fsync(f.fileno())
        real_path = atomic_replace(tmp_path, path)
        _restore_file_mode(real_path, original_mode)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
'''


@pytest.fixture
def fake_utils_py(tmp_path):
    """Materialise a fake site-packages/utils.py under tmp_path."""
    site = tmp_path / "site-packages"
    site.mkdir(parents=True)
    utils = site / "utils.py"
    utils.write_text(UPSTREAM_UTILS_PY_FIXTURE)
    return utils


def _load_patch_module(monkeypatch, fake_utils_path):
    spec = importlib.util.spec_from_file_location(
        "patch_upstream_hermes_channeldir", PATCH_SCRIPT
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "CHANNELDIR_PY", str(fake_utils_path))
    return mod


def test_fixture_matches_real_upstream_needle():
    """Guard: the synthetic fixture must contain the exact byte-stable needle
    the patch script targets — three times — so this test suite stays an
    honest stand-in for the real upstream writer."""
    spec = importlib.util.spec_from_file_location(
        "patch_upstream_hermes_channeldir", PATCH_SCRIPT
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert UPSTREAM_UTILS_PY_FIXTURE.count(mod.NEEDLE) == mod.EXPECTED_SITES


def test_patch_applies_to_synthetic_upstream(fake_utils_py, monkeypatch):
    """All three fd-open sites are wrapped and the helper is appended."""
    mod = _load_patch_module(monkeypatch, fake_utils_py)
    mod.main()
    patched = fake_utils_py.read_text()

    # The sentinel landed (appears in the helper comment block).
    assert mod.SENTINEL in patched
    # The helper function was appended.
    assert "_alfred_fdopen_or_close" in patched
    # Every raw `os.fdopen(fd, ...)` call site is now the guarded wrapper.
    assert patched.count(mod.REPLACEMENT) == mod.EXPECTED_SITES
    # No `with os.fdopen(fd, ...)` call expression survives in the writers —
    # they all go through the wrapper now. (The string `os.fdopen` still
    # appears inside the helper body + its explanatory comment, which is why
    # we assert on the *call* form, not a bare substring count.)
    assert "with os.fdopen(fd" not in patched
    # The single real bare `os.fdopen(...)` call left is the one inside the
    # helper definition.
    assert patched.count("return os.fdopen(fd, *args, **kwargs)") == 1


def test_patch_is_idempotent(fake_utils_py, monkeypatch):
    """Re-running the patch must be a byte-stable no-op."""
    mod = _load_patch_module(monkeypatch, fake_utils_py)
    mod.main()
    first = fake_utils_py.read_text()
    mod.main()
    second = fake_utils_py.read_text()
    assert first == second


def test_patch_tripwire_on_missing_needle(tmp_path, monkeypatch):
    """If a future HERMES_REF bump rewrites the helper so the shared
    `os.fdopen(fd, ...)` expression no longer matches, the script must exit
    non-zero (not silently bake an unpatched image)."""
    site = tmp_path / "site-packages"
    site.mkdir(parents=True)
    utils = site / "utils.py"
    utils.write_text("# upstream rewrote the helper; no mkstemp fd-open here\nimport os\n")

    mod = _load_patch_module(monkeypatch, utils)
    with pytest.raises(SystemExit) as exc:
        mod.main()
    assert exc.value.code == 2


def _open_fds() -> set:
    """Return the set of open fd numbers for the current process."""
    return set(os.listdir("/proc/self/fd")) if os.path.isdir("/proc/self/fd") \
        else set(os.listdir("/dev/fd"))


@pytest.mark.skipif(
    not (os.path.isdir("/proc/self/fd") or os.path.isdir("/dev/fd")),
    reason="needs /proc/self/fd or /dev/fd to count descriptors",
)
def test_patched_writer_does_not_leak_fd_on_fdopen_failure(fake_utils_py, monkeypatch, tmp_path):
    """The functional smoke: exec the PATCHED utils.py, inject an
    `os.fdopen` failure (the `[Errno 24]` condition that wedges the gateway),
    and assert NO file descriptor is leaked AND NO `.channel_directory_*.tmp`
    file is left behind — while the happy path still writes correctly."""
    mod = _load_patch_module(monkeypatch, fake_utils_py)
    mod.main()

    # Exec the patched module into a fresh namespace.
    ns: dict = {}
    exec(fake_utils_py.read_text(), ns)
    atomic_json_write = ns["atomic_json_write"]

    target = tmp_path / "channel_directory.json"

    # 1. fdopen failure → the raw mkstemp fd must be reclaimed (no leak),
    #    and the `.tmp` file must be unlinked.
    before = _open_fds()
    with mock.patch("os.fdopen", side_effect=OSError(24, "Too many open files")):
        with pytest.raises(OSError) as exc:
            atomic_json_write(str(target), {"platforms": {}})
    assert exc.value.errno == 24
    after = _open_fds()
    leaked = after - before
    assert not leaked, f"leaked file descriptors: {leaked}"
    leftover = list(tmp_path.glob(".channel_directory_*.tmp"))
    assert not leftover, f"leftover temp files: {leftover}"

    # 2. Happy path still writes the file correctly.
    atomic_json_write(str(target), {"platforms": {"slack": []}})
    assert json.loads(target.read_text()) == {"platforms": {"slack": []}}
    # No stray temp file after a successful write either.
    assert not list(tmp_path.glob(".channel_directory_*.tmp"))


def test_unpatched_writer_leaks_fd_baseline(fake_utils_py, tmp_path):
    """Baseline (red without the fix): the UNPATCHED upstream writer DOES leak
    a descriptor when `os.fdopen` fails. This proves the bug is real and that
    the patch (asserted above) is what closes it — not the test setup."""
    ns: dict = {}
    exec(fake_utils_py.read_text(), ns)  # fixture is unpatched here
    atomic_json_write = ns["atomic_json_write"]

    target = tmp_path / "channel_directory.json"
    before = _open_fds()
    with mock.patch("os.fdopen", side_effect=OSError(24, "Too many open files")):
        with pytest.raises(OSError):
            atomic_json_write(str(target), {"platforms": {}})
    after = _open_fds()
    leaked = after - before
    # The unpatched writer leaks exactly the raw mkstemp fd.
    assert leaked, "expected the unpatched writer to leak an fd (baseline)"


def test_patch_script_runs_as_subprocess(fake_utils_py, tmp_path):
    """End-to-end: run the patch script as `python3 path/to/patch.py` via a
    thin shim that overrides CHANNELDIR_PY. Catches argv handling +
    import-time errors the in-process tests miss."""
    runner = tmp_path / "run_patch.py"
    runner.write_text(
        "import importlib.util\n"
        f"spec = importlib.util.spec_from_file_location('p', {str(PATCH_SCRIPT)!r})\n"
        "mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)\n"
        f"mod.CHANNELDIR_PY = {str(fake_utils_py)!r}\n"
        "mod.main()\n"
    )
    result = subprocess.run(
        [sys.executable, str(runner)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    patched = fake_utils_py.read_text()
    assert "_alfred_fdopen_or_close" in patched
