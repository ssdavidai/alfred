"""Static-text test: supervisor.sh must propagate openai-codex auth.json
across all three Hermes profiles on boot.

Background — Hermes uses three profiles (`main` :18789, `workers` :18790,
`heavy` :18791) and the operator authenticates against the upstream
openai-codex provider with `hermes auth login`. That command only writes
the OAuth tokens into the *sticky-default* profile's auth.json — now
`main/auth.json` after Lane V's prior commit (`8cc6feb`). The `workers`
and `heavy` profiles get NO `auth.json` file, so any call routed through
them (heavy → onboarding Opus stages, workers → clerk/curator) fails at
boot with `AuthError: No Codex credentials stored`.

The OAuth token is per-USER (one ChatGPT subscription is one identity),
so the same auth.json content works across every profile. supervisor.sh
must mirror `main/auth.json` to `workers/auth.json` and `heavy/auth.json`
whenever they are missing or smaller (heuristic: empty / stub).

This test pins the propagation block so a future supervisor.sh refactor
cannot silently drop it. We assert:

  1. The two literal anchors (the MAIN_AUTH path + the cp call) are in
     supervisor.sh.
  2. The block sits AFTER the `hermes profile use main` sticky-default
     call (which itself sits after `wait_for_profiles`) and BEFORE the
     main-gateway launch.
  3. The size-comparison guard exists — we don't overwrite a richer
     per-profile auth.json a user may have customised later.
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


def test_main_auth_path_anchor_present():
    """The MAIN_AUTH path literal must be in supervisor.sh."""
    src = _read()
    assert 'MAIN_AUTH="$HERMES_ROOT/profiles/main/auth.json"' in src, (
        "supervisor.sh must define MAIN_AUTH as the canonical path to the "
        "sticky-default profile's auth.json — the source of truth for the "
        "cross-profile propagation. Without this anchor a future refactor "
        "could silently point the propagation at the wrong file."
    )


def test_cp_call_anchor_present():
    """The literal `cp` call from main to per-profile auth.json must exist."""
    src = _read()
    assert 'cp "$MAIN_AUTH" "$P_AUTH"' in src, (
        "supervisor.sh must `cp \"$MAIN_AUTH\" \"$P_AUTH\"` — the actual "
        "propagation step. Without it `workers` and `heavy` get no "
        "auth.json and any call through them 401s with `No Codex "
        "credentials stored` until manually re-auth'd."
    )


def test_propagation_loops_over_workers_and_heavy():
    """The loop must explicitly target the workers + heavy profile names."""
    src = _read()
    # The brief specifies a `for p in workers heavy` loop. Pin that exact
    # shape so a refactor cannot accidentally limit the loop to one profile.
    assert "for p in workers heavy" in src, (
        "supervisor.sh must iterate over BOTH `workers` AND `heavy` — these "
        "are the two profiles `hermes auth login` does not touch."
    )


def test_propagation_is_after_sticky_default():
    """The propagation block must run AFTER `hermes profile use main`."""
    src = _read()
    sticky_line = _line_index(src, "hermes profile use main")
    cp_line = _line_index(src, 'cp "$MAIN_AUTH" "$P_AUTH"')
    assert sticky_line >= 0, "expected `hermes profile use main` line"
    assert cp_line >= 0, "expected propagation `cp` line"
    assert cp_line > sticky_line, (
        f"propagation `cp` (line {cp_line + 1}) must come AFTER "
        f"`hermes profile use main` (line {sticky_line + 1}) — the "
        f"sticky-default call comes after wait_for_profiles, so anchoring "
        f"the propagation after it guarantees profile dirs exist."
    )


def test_propagation_is_before_main_gateway_launch():
    """The propagation block must run BEFORE the gateway launch loop.

    #120 Lane II — anchor is the templated registry launch loop's
    `done < <(read_registry)` line (which replaces the previous trio of
    per-profile start_proc calls).
    """
    src = _read()
    cp_line = _line_index(src, 'cp "$MAIN_AUTH" "$P_AUTH"')
    launch_line = _line_index(src, "ANCHOR: BOOT_LAUNCH_LOOP")
    assert cp_line >= 0, "expected propagation `cp` line"
    assert launch_line >= 0, (
        "expected the registry-driven launch loop's "
        "`done < <(read_registry)` line — supervisor.sh was restructured"
    )
    assert cp_line < launch_line, (
        f"propagation `cp` (line {cp_line + 1}) must come BEFORE the "
        f"registry launch loop (line {launch_line + 1}) — "
        f"the gateways read auth.json on startup, so the per-profile "
        f"files must be in place before any of them boots."
    )


def test_propagation_has_size_comparison_guard():
    """The block must only overwrite a profile auth.json that is SMALLER.

    The size guard means we don't clobber a richer per-profile auth.json
    a user explicitly customised later (e.g. a separately-provisioned
    workers-only credential). We only fill in profiles that are smaller —
    a stub or missing file.
    """
    src = _read()
    assert 'P_SIZE" -lt "$MAIN_SIZE' in src, (
        "supervisor.sh must guard the `cp` with a size comparison "
        "(`P_SIZE -lt MAIN_SIZE`) so it only fills in stub/missing "
        "per-profile auth.json files and never clobbers a richer "
        "operator-supplied credential."
    )
