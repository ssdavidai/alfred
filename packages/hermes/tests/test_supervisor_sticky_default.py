"""Static-text test: supervisor.sh must set `main` as the sticky default profile.

Background — the runtime image is started by tini → supervisor.sh, which
launches the three gateway profiles. An operator can ALSO `docker exec -it
alfred-black-hermes-1 hermes chat` to open an interactive Alfred TUI.

Without a sticky default, that interactive invocation falls back to
`/root/.hermes/` — a bare stock Hermes profile with no Alfred persona,
no MCP tools, no vault access. The CLI primitive `hermes profile use main`
exists exactly for this: it writes the sticky-default pointer Hermes reads
when invoked with no `-p`.

This test pins the wiring so a future refactor of supervisor.sh cannot
silently drop it. We assert three things:
  1. `hermes profile use main` is present in supervisor.sh.
  2. It sits AFTER the wait-for-init step (profiles must exist first — if
     we set the default before init renders main/, the call no-ops or sets
     a pointer to a non-existent profile).
  3. It sits BEFORE the `hermes -p main gateway run` launch (so the
     pointer is in place by the time anyone could `docker exec` in).
"""
from pathlib import Path

SUPERVISOR = (
    Path(__file__).resolve().parent.parent / "docker" / "supervisor.sh"
)


def _read():
    return SUPERVISOR.read_text()


def _line_index(haystack: str, needle: str) -> int:
    """Return 0-based line index of the first line containing `needle`,
    or -1 if absent. Substring match — pinning a fragment, not an exact line."""
    for i, line in enumerate(haystack.splitlines()):
        if needle in line:
            return i
    return -1


def test_supervisor_calls_profile_use_main():
    """The literal sticky-default call must be in supervisor.sh."""
    src = _read()
    assert "hermes profile use main" in src, (
        "supervisor.sh must call `hermes profile use main` to make `main` the "
        "sticky default profile for interactive `docker exec` sessions. "
        "Without it, `hermes chat` opens the bare /root/.hermes/ default — "
        "no Alfred persona, no MCP tools, no vault."
    )


def test_supervisor_sticky_default_is_after_wait_for_profiles():
    """The call must run AFTER init renders the profile configs."""
    src = _read()
    wait_line = _line_index(src, "wait_for_profiles")
    sticky_line = _line_index(src, "hermes profile use main")
    # `wait_for_profiles` appears twice (def + call). We want the *call* —
    # i.e. an occurrence whose line is not the function definition. The
    # call line never starts with `wait_for_profiles()` after `function` /
    # bash `name()` syntax: it's a bare call. Use the LAST occurrence,
    # which is the call (def is earlier).
    call_line = max(
        i for i, line in enumerate(src.splitlines())
        if "wait_for_profiles" in line and not line.lstrip().startswith(("#", "wait_for_profiles()"))
    )
    assert sticky_line > call_line, (
        f"`hermes profile use main` (line {sticky_line + 1}) must come AFTER "
        f"the `wait_for_profiles` call (line {call_line + 1}) — the init "
        f"container must finish rendering profiles before we set the default."
    )
    # Sanity: don't let the test accept a degenerate case where both equal -1.
    assert wait_line >= 0 and sticky_line >= 0


def test_supervisor_sticky_default_is_before_main_gateway_launch():
    """The call must run BEFORE the main gateway is launched.

    #120 Lane II — the literal `hermes -p main gateway run` line was
    replaced by the templated start_registered_profile function called
    from the registry loop. The boot-time launch is now anchored at the
    `done < <(read_registry)` line that closes the initial dispatch loop.
    """
    src = _read()
    sticky_line = _line_index(src, "hermes profile use main")
    launch_line = _line_index(src, "ANCHOR: BOOT_LAUNCH_LOOP")
    assert launch_line >= 0, (
        "expected the registry-driven launch loop's `done < <(read_registry)` "
        "line — supervisor.sh was restructured"
    )
    assert sticky_line >= 0
    assert sticky_line < launch_line, (
        f"`hermes profile use main` (line {sticky_line + 1}) must come BEFORE "
        f"the registry launch loop (line {launch_line + 1}) — so the pointer "
        f"is set the moment the container reports ready."
    )


def test_supervisor_sticky_default_is_best_effort():
    """The call must be best-effort — a failure must NOT abort the supervisor.

    supervisor.sh runs `set -uo pipefail` (NOT `-e`), but any operator
    reading the line should still see explicit `|| true` so it's obvious
    this is intentional and the supervisor won't die if the CLI changes
    its return code.
    """
    src = _read()
    # Find the sticky-default line and look at it directly.
    for line in src.splitlines():
        if "hermes profile use main" in line:
            assert "|| true" in line, (
                "the sticky-default call must be guarded with `|| true` so a "
                "non-zero return from a future Hermes CLI does not crash the "
                "supervisor at boot — this is housekeeping, not load-bearing."
            )
            return
    raise AssertionError("sticky-default line not found")
