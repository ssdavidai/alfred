"""Static-text test: supervisor.sh must consolidate the Alfred persona
SOUL.md from `profiles/main/SOUL.md` to `$HERMES_HOME/SOUL.md`.

Background — per the official Hermes docs
(https://hermes-agent.nousresearch.com/docs/user-guide/features/personality),
the persona file Hermes actually loads is `$HERMES_HOME/SOUL.md` (a single
global file), NOT per-profile copies. Live evidence on test.alfred.black:

  /hermes-state/SOUL.md                  — 513 bytes, stock Nous default
  /hermes-state/profiles/main/SOUL.md    — 565 bytes, rendered Alfred persona

Hermes serves the stock identity, not Alfred. The init container's step 2g
already lays the Alfred persona into each profile dir, but Hermes never
reads it from there. supervisor.sh must reconcile: copy the (richer,
Alfred-personalised) `profiles/main/SOUL.md` to `$HERMES_HOME/SOUL.md`
when the latter is missing, stock, or smaller than the main profile's
version.

We pin:
  1. The block is present in supervisor.sh (uses literal
     `cp "$HERMES_HOME/profiles/main/SOUL.md" "$HERMES_HOME/SOUL.md"`).
  2. The block is non-destructive — guarded by a size/stock check so a
     richer hand-edited `$HERMES_HOME/SOUL.md` is preserved.
  3. The block runs AFTER `wait_for_profiles` (the profile dir must
     exist) and BEFORE the `hermes -p main gateway run` launch (so the
     persona is in place at boot).
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


def test_soul_consolidation_cp_anchor_present():
    """The literal `cp` from profiles/main/SOUL.md to $HERMES_HOME/SOUL.md must exist."""
    src = _read()
    assert 'cp "$HERMES_HOME/profiles/main/SOUL.md" "$HERMES_HOME/SOUL.md"' in src, (
        "supervisor.sh must `cp \"$HERMES_HOME/profiles/main/SOUL.md\" "
        "\"$HERMES_HOME/SOUL.md\"` — the file Hermes actually reads is "
        "$HERMES_HOME/SOUL.md, not the per-profile copy. Without this "
        "consolidation the live agent boots with the stock Nous persona."
    )


def test_soul_consolidation_is_guarded():
    """The consolidation must be wrapped in an `if` so it does not clobber
    a richer hand-edited $HERMES_HOME/SOUL.md.

    The guard must check the source exists + is non-trivial (>200 bytes)
    AND the destination is either missing OR smaller OR matches the
    stock Nous identity. We pin the three anchors that together prove
    the guard exists.
    """
    src = _read()
    # Source-exists anchor — `[[ -s "$HERMES_HOME/profiles/main/SOUL.md" ]]`
    # or an equivalent test on the same path.
    assert '-s "$HERMES_HOME/profiles/main/SOUL.md"' in src \
        or '-f "$HERMES_HOME/profiles/main/SOUL.md"' in src, (
        "supervisor.sh must guard the consolidation with a test that "
        "`$HERMES_HOME/profiles/main/SOUL.md` actually exists + is "
        "non-empty before copying it."
    )
    # Stock-Nous marker — the safe overwrite path checks for the stock
    # identity string in the destination.
    assert "You are Hermes Agent" in src, (
        "supervisor.sh must reference the stock Nous identity marker "
        "(`You are Hermes Agent`) so the guard can detect a stock SOUL "
        "and replace it. Without this the consolidation is unsafe and "
        "would clobber a hand-edit."
    )


def test_soul_consolidation_size_guard():
    """The guard must also include a size comparison so a richer
    $HERMES_HOME/SOUL.md (larger than the main profile's) is preserved."""
    src = _read()
    # MAIN_SOUL_SIZE vs HOME_SOUL_SIZE comparison anchor (similar shape
    # to the existing auth.json propagation block).
    assert "MAIN_SOUL_SIZE" in src and "HOME_SOUL_SIZE" in src, (
        "supervisor.sh must declare MAIN_SOUL_SIZE + HOME_SOUL_SIZE and "
        "compare them so it only overwrites a smaller / stock destination."
    )


def test_soul_consolidation_runs_after_wait_for_profiles():
    """The consolidation must run AFTER `wait_for_profiles` (so the
    profile dir already exists)."""
    src = _read()
    lines = src.splitlines()
    # `wait_for_profiles` appears twice (def + call). We want the call —
    # the same indexing trick used in the sticky-default test.
    call_line = max(
        i for i, line in enumerate(lines)
        if "wait_for_profiles" in line and not line.lstrip().startswith(("#", "wait_for_profiles()"))
    )
    cp_line = _line_index(
        src,
        'cp "$HERMES_HOME/profiles/main/SOUL.md" "$HERMES_HOME/SOUL.md"',
    )
    assert cp_line > call_line, (
        f"SOUL consolidation `cp` (line {cp_line + 1}) must come AFTER "
        f"the `wait_for_profiles` call (line {call_line + 1}) — the "
        f"main profile dir must exist before we read its SOUL.md."
    )


def test_soul_consolidation_runs_before_main_gateway_launch():
    """The consolidation must run BEFORE the main gateway boots."""
    src = _read()
    cp_line = _line_index(
        src,
        'cp "$HERMES_HOME/profiles/main/SOUL.md" "$HERMES_HOME/SOUL.md"',
    )
    launch_line = _line_index(src, "hermes -p main gateway run")
    assert cp_line >= 0, "expected SOUL consolidation cp line"
    assert launch_line >= 0, "expected main gateway launch line"
    assert cp_line < launch_line, (
        f"SOUL consolidation `cp` (line {cp_line + 1}) must come BEFORE "
        f"the `hermes -p main gateway run` launch (line {launch_line + 1}) — "
        f"Hermes reads $HERMES_HOME/SOUL.md at gateway boot, so the "
        f"persona must be in place beforehand."
    )


def test_soul_consolidation_logs_outcome():
    """A log line MUST report the consolidation so operators can see it
    in `docker logs alfred-black-hermes-1`."""
    src = _read()
    # Anchor on the literal log message fragment the brief specifies.
    assert "consolidated SOUL.md" in src, (
        "supervisor.sh must log `[supervisor] consolidated SOUL.md ...` "
        "when it performs the copy — operators need a visible trace that "
        "the global persona was rewritten on boot."
    )
