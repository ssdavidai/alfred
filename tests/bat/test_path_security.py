"""Tests for path hardening behavior."""

import pytest

from alfred.bat.path_security import PathHardener, PathSecurityError


def test_symlink_component_blocked_when_disallowed(tmp_path):
    base = tmp_path / "vault"
    real = base / "real"
    real.mkdir(parents=True)
    (real / "file.txt").write_text("ok", encoding="utf-8")

    link = base / "link"
    try:
        link.symlink_to(real, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation not supported in this environment")

    # Allowed when symlinks are permitted.
    resolved = PathHardener.validate("link/file.txt", base_dir=base, allow_symlinks=True)
    assert resolved.exists()

    # Blocked when symlinks are explicitly disallowed.
    with pytest.raises(PathSecurityError):
        PathHardener.validate("link/file.txt", base_dir=base, allow_symlinks=False)
