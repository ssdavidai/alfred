"""Static-text test: the templated `hermes -p <profile> gateway run`
invocation in supervisor.sh must launch with the process CWD set to that
profile's dir.

Per the Hermes docs (user-guide/features/context-files), Hermes discovers
AGENTS.md / CLAUDE.md / .hermes.md / .cursorrules (in that precedence)
FROM THE PROCESS CWD at gateway boot, NOT from $HERMES_HOME or the profile
dir. Live evidence on test.alfred.black: each PID's cwd was `/` so the
per-profile AGENTS.md never loaded. The fix is to `cd` into the profile
dir before exec'ing hermes.

#120 Lane II — the three per-profile start_proc lines were replaced by a
single templated start_registered_profile() function called once per slug
from the registry. We now anchor against:
  * the start_registered_profile() body (must `cd "${profile_dir}"`),
  * the registry-iterating launch loop (must call start_registered_profile),
  * codex-builder's own boot-time launch (still its own block).
"""
from pathlib import Path

SUPERVISOR = (
    Path(__file__).resolve().parent.parent / "docker" / "supervisor.sh"
)


def _read():
    return SUPERVISOR.read_text()


def test_start_registered_profile_cd_before_exec():
    """The templated launcher must `cd "${profile_dir}"` before exec'ing
    hermes — otherwise the gateway's process CWD is the supervisor's `/`
    and per-profile AGENTS.md is not loaded."""
    src = _read()
    # Find the start_registered_profile function body and assert the
    # templated launch command does `cd "${profile_dir}" && ... exec hermes`.
    assert "start_registered_profile()" in src, (
        "expected start_registered_profile() helper in supervisor.sh"
    )
    # The launcher line uses ${profile_dir} (computed inside the function)
    # plus ${slug} for the -p flag. start_proc takes a double-quoted
    # command string so the inner quotes around ${profile_dir} are
    # backslash-escaped in the source text.
    assert 'cd \\"${profile_dir}\\"' in src, (
        'templated launcher must `cd \\"${profile_dir}\\"` before exec hermes '
        "(escaped because the start_proc command is itself double-quoted)"
    )
    assert "exec hermes -p ${slug} gateway run --replace" in src, (
        "templated launcher must end in `exec hermes -p ${slug} gateway "
        "run --replace`"
    )


def test_registry_launch_loop_present():
    """The registry-driven launch loop must iterate read_registry and
    call start_registered_profile for each slug — that's how the four
    reserved profiles + any user-facing profile are spawned at boot."""
    src = _read()
    # The initial launch loop reads the registry and dispatches to the
    # launcher. Both anchors must coexist for the boot to work.
    assert "read_registry" in src, (
        "expected read_registry helper to enumerate the registry JSON"
    )
    assert "start_registered_profile" in src, (
        "expected start_registered_profile dispatch from the launch loop"
    )


def test_codex_builder_still_separate():
    """codex-builder retains its own boot-time launch (setpriv + egress
    jail + reset-env) — it is NOT routed through start_registered_profile."""
    src = _read()
    assert "ENABLE_CODEX_BUILDER" in src
    assert "setpriv --reuid=10001" in src, (
        "codex-builder launch must still drop to uid 10001 via setpriv"
    )
    # And the codex-builder branch should explicitly mark itself in
    # REGISTRY_LAUNCHED so the SIGUSR1 reconciler doesn't double-start it.
    assert 'REGISTRY_LAUNCHED["codex-builder"]=1' in src, (
        "codex-builder must record itself in REGISTRY_LAUNCHED so the "
        "SIGUSR1 reconciler doesn't try to spawn it via the generic path"
    )


def test_launches_remain_after_existing_boot_steps():
    """The registry-iterating launch loop must still come after
    wait_for_profiles + sticky-default + auth-propagation + the SOUL
    consolidation."""
    src = _read()
    lines = src.splitlines()

    def _line_with(needle: str) -> int:
        for i, line in enumerate(lines):
            if needle in line and not line.lstrip().startswith(("#",)):
                return i
        return -1

    wait_call = -1
    for i, line in enumerate(lines):
        # the CALL to wait_for_profiles (not the definition or the comment).
        if "wait_for_profiles" in line:
            if line.lstrip().startswith(("#", "wait_for_profiles()")):
                continue
            wait_call = i
    sticky = _line_with("hermes profile use main")
    auth_cp = _line_with('cp "$MAIN_AUTH" "$P_AUTH"')
    soul_cp = _line_with(
        'cp "$HERMES_HOME/profiles/main/SOUL.md" "$HERMES_HOME/SOUL.md"'
    )
    # The boot-time launch loop's `done < <(read_registry)` line. The
    # phrase appears earlier in reconcile_registry and wait_for_profiles —
    # we want the LAST occurrence (the launch loop sits at the bottom of
    # the script, after the boot-time setup).
    launch_loop = -1
    for i, line in enumerate(lines):
        if "ANCHOR: BOOT_LAUNCH_LOOP" in line:
            launch_loop = i  # keep updating — keep the LAST match

    assert launch_loop >= 0, "expected the registry-driven launch loop"
    for name, idx in (
        ("wait_for_profiles", wait_call),
        ("sticky default", sticky),
        ("auth cp", auth_cp),
        ("SOUL cp", soul_cp),
    ):
        assert idx >= 0, f"expected anchor: {name}"
        assert idx < launch_loop, (
            f"{name} (line {idx + 1}) must come before the registry launch "
            f"loop (line {launch_loop + 1})."
        )
