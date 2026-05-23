"""Static-text test: each `hermes -p <profile> gateway run` invocation in
supervisor.sh must launch with the process CWD set to that profile's dir.

Per the Hermes docs (user-guide/features/context-files), Hermes discovers
AGENTS.md / CLAUDE.md / .hermes.md / .cursorrules (in that precedence)
FROM THE PROCESS CWD at gateway boot, NOT from $HERMES_HOME or the profile
dir. Live evidence on test.alfred.black: each PID's cwd was `/` so the
per-profile AGENTS.md never loaded. The fix is to `cd` into the profile
dir before exec'ing hermes.
"""
from pathlib import Path

SUPERVISOR = (
    Path(__file__).resolve().parent.parent / "docker" / "supervisor.sh"
)


def _read():
    return SUPERVISOR.read_text()


def _start_proc_line(profile: str) -> str:
    """Return the start_proc line for the given profile, or '' if absent."""
    needle = f"hermes -p {profile} gateway"
    for line in _read().splitlines():
        if "start_proc" in line and needle in line:
            return line
    return ""


def _start_proc_idx(profile: str) -> int:
    needle = f"hermes -p {profile} gateway"
    for i, line in enumerate(_read().splitlines()):
        if "start_proc" in line and needle in line:
            return i
    return -1


def _cd_anchor_present(profile: str, line: str) -> bool:
    """Accept either the escaped or unescaped spelling, and the
    `${PROFILES_DIR}` / `$PROFILES_DIR` / `$HERMES_HOME/profiles/...`
    variants. The launch is a double-quoted string passed to start_proc,
    which then runs `bash -c "$cmd"`, so inner quotes are backslash-
    escaped in the source text."""
    return any(c in line for c in (
        f'cd "${{PROFILES_DIR}}/{profile}"',
        f'cd \\"${{PROFILES_DIR}}/{profile}\\"',
        f'cd "$PROFILES_DIR/{profile}"',
        f'cd \\"$PROFILES_DIR/{profile}\\"',
        f'cd "$HERMES_HOME/profiles/{profile}"',
        f'cd \\"$HERMES_HOME/profiles/{profile}\\"',
    ))


def test_main_gateway_cd_to_profile_dir():
    line = _start_proc_line("main")
    assert line, "expected start_proc for main"
    assert _cd_anchor_present("main", line), (
        f"main gateway must `cd` into its profile dir before exec so "
        f"Hermes auto-discovers profiles/main/AGENTS.md. line: {line!r}"
    )


def test_workers_gateway_cd_to_profile_dir():
    line = _start_proc_line("workers")
    assert line, "expected start_proc for workers"
    assert _cd_anchor_present("workers", line), (
        f"workers gateway must `cd` into its profile dir. line: {line!r}"
    )


def test_heavy_gateway_cd_to_profile_dir():
    line = _start_proc_line("heavy")
    assert line, "expected start_proc for heavy"
    assert _cd_anchor_present("heavy", line), (
        f"heavy gateway must `cd` into its profile dir. line: {line!r}"
    )


def test_each_launch_uses_exec_after_cd():
    """`exec hermes …` after the cd so the subshell hands the PID directly
    to hermes — the supervisor's `kill -0 $pid` bookkeeping depends on it."""
    for profile in ("main", "workers", "heavy"):
        line = _start_proc_line(profile)
        assert line, f"expected start_proc for {profile}"
        assert f"exec hermes -p {profile} gateway" in line, (
            f"{profile} launch must use `exec hermes -p {profile} gateway`. "
            f"line: {line!r}"
        )


def test_launches_remain_after_existing_boot_steps():
    """Launches must still come after wait_for_profiles + sticky-default +
    auth-propagation + the SOUL consolidation introduced in the prior commit."""
    src = _read()
    lines = src.splitlines()
    wait_call = max(
        i for i, line in enumerate(lines)
        if "wait_for_profiles" in line and not line.lstrip().startswith(("#", "wait_for_profiles()"))
    )
    sticky = next(i for i, l in enumerate(lines) if "hermes profile use main" in l)
    auth_cp = next(i for i, l in enumerate(lines) if 'cp "$MAIN_AUTH" "$P_AUTH"' in l)
    soul_cp = next(
        i for i, l in enumerate(lines)
        if 'cp "$HERMES_HOME/profiles/main/SOUL.md" "$HERMES_HOME/SOUL.md"' in l
    )
    earliest_launch = min(
        _start_proc_idx("main"),
        _start_proc_idx("workers"),
        _start_proc_idx("heavy"),
    )
    for name, idx in (
        ("wait_for_profiles", wait_call),
        ("sticky default", sticky),
        ("auth cp", auth_cp),
        ("SOUL cp", soul_cp),
    ):
        assert idx < earliest_launch, (
            f"{name} (line {idx + 1}) must come before the earliest "
            f"gateway launch (line {earliest_launch + 1})."
        )
