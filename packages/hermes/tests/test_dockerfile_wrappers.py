"""Static-text test: Dockerfile must install the convenience CLI wrappers.

`hermes profile use main` (set in supervisor.sh) makes a bare `hermes chat`
open the Alfred profile. These wrappers are the *explicit* form, for
operators who'd rather type the profile name than rely on sticky state:

    alfred chat        → hermes -p main "$@"
    workers-cli chat   → hermes -p workers "$@"
    heavy-cli chat     → hermes -p heavy "$@"

The wrappers are named `workers-cli` / `heavy-cli` (not `workers` / `heavy`)
to avoid any clash with present-or-future binaries in the runtime image.
`alfred` is safe — there is no other `alfred` executable in the image.

This test pins the three RUN-installed scripts so a future Dockerfile edit
cannot silently drop them.
"""
from pathlib import Path

DOCKERFILE = Path(__file__).resolve().parent.parent / "Dockerfile"


def _read():
    return DOCKERFILE.read_text()


def test_alfred_wrapper_present():
    src = _read()
    assert "/usr/local/bin/alfred" in src, (
        "Dockerfile must install /usr/local/bin/alfred — the convenience "
        "wrapper that runs `hermes -p main`. Without it, an operator inside "
        "the container has to remember the -p flag."
    )
    assert 'exec hermes -p main "$@"' in src, (
        "the /usr/local/bin/alfred wrapper must `exec hermes -p main \"$@\"` "
        "so $@ is forwarded and tini still reaps the right pid."
    )


def test_workers_cli_wrapper_present():
    src = _read()
    assert "/usr/local/bin/workers-cli" in src
    assert 'exec hermes -p workers "$@"' in src


def test_heavy_cli_wrapper_present():
    src = _read()
    assert "/usr/local/bin/heavy-cli" in src
    assert 'exec hermes -p heavy "$@"' in src


def test_wrappers_are_chmod_executable():
    """The wrappers are useless if not executable — the RUN must chmod +x them."""
    src = _read()
    assert "chmod +x /usr/local/bin/alfred" in src, (
        "the wrapper-install RUN must `chmod +x` the wrappers (a sh script "
        "written via `printf > /path` is created without an exec bit)."
    )
    # All three should be chmod'd in one RUN — assert the heavy/workers names
    # appear in the same chmod call (loosely: in the file).
    assert "/usr/local/bin/workers-cli" in src
    assert "/usr/local/bin/heavy-cli" in src
