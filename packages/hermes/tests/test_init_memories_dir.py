"""Static-text pin: init creates $HERMES_HOME/memories/ as 0777 so
cross-container writers (alfred-learn @ uid 1000) can seed it.

WHY THIS GUARD EXISTS
---------------------
Hermes' built-in memory feature reads `MEMORY.md` + `USER.md` from
`$HERMES_HOME/memories/`. Two containers touch that dir on different uids:

  - hermes runtime (uid 10000)  → reads the files
  - alfred-learn  (uid 1000)    → seeds them (`personalize_opus`)

If init creates `$HERMES_HOME/memories/` with default perms
(root:root 0700) — which is exactly what an unconfigured `mkdir -p` plus
the `chown -R 10000:10000 "$HERMES_DATA_DIR"` step does — alfred-learn's
seed silently falls back to `/alfred-data/hermes_seed_*.md` with `EACCES`,
no consumer ever reads those files, and Hermes runs without a personalised
memory surface.

This was observed live on Sir's box (2026-05-23) and tactically patched in
place; a fresh VM would have the same broken perms without this fix.

The init container runs as root and owns the volumes, so chmod here is
durable. Hermes itself runs non-root and cannot fix perms after the fact.
0777 is the simplest portable answer on this single-tenant box where the
volume is private to the stack — and matches the existing 0777 posture of
`/alfred-data` and its sibling dirs.
"""
from pathlib import Path

HERMES = Path(__file__).resolve().parent.parent
ENTRYPOINT = HERMES / "init" / "entrypoint.sh"


def test_entrypoint_creates_memories_dir():
    """init MUST mkdir $HERMES_HOME/memories on every boot (idempotent)."""
    src = ENTRYPOINT.read_text()
    assert 'MEMORIES_DIR="${HERMES_DATA_DIR}/memories"' in src, (
        "entrypoint.sh must declare MEMORIES_DIR as "
        '`"${HERMES_DATA_DIR}/memories"` — Hermes\' built-in memory feature '
        "reads MEMORY.md + USER.md from that path."
    )
    assert 'mkdir -p "$MEMORIES_DIR"' in src, (
        "entrypoint.sh must `mkdir -p \"$MEMORIES_DIR\"` so the dir exists "
        "on a fresh VM (idempotent on re-runs)."
    )


def test_entrypoint_chmods_memories_dir_world_writable():
    """init MUST chmod 0777 so the cross-container writer can seed.

    alfred-learn runs as uid 1000; Hermes runs as uid 10000; init runs as
    root. Without this chmod, alfred-learn's `personalize_opus` step gets
    EACCES on `MEMORY.md` / `USER.md` writes and silently falls back to
    `/alfred-data/hermes_seed_*.md` (no consumer). 0777 is the documented
    posture for cross-container scratch on this single-tenant box.
    """
    src = ENTRYPOINT.read_text()
    assert 'chmod 0777 "$MEMORIES_DIR"' in src, (
        "entrypoint.sh must `chmod 0777 \"$MEMORIES_DIR\"` so alfred-learn "
        "(uid 1000) can seed MEMORY.md/USER.md the Hermes runtime (uid "
        "10000) then reads. Without it, the seed silently EACCES-fails."
    )


def test_memories_dir_setup_precedes_recursive_chown():
    """The `mkdir + chmod` for MEMORIES_DIR must come BEFORE the
    `chown -R 10000:10000 "$HERMES_DATA_DIR"` step.

    Order matters: the recursive chown rewrites ownership across the whole
    Hermes volume. If MEMORIES_DIR is created AFTER it, the chown is no
    longer covering the new dir — but more importantly, this ordering
    documents the intent: the dir's permissive mode is the durable answer,
    and chown-to-hermes is only the surrounding pre-chown step.
    """
    src = ENTRYPOINT.read_text()
    mem_setup = src.find('mkdir -p "$MEMORIES_DIR"')
    recursive_chown = src.find('chown -R 10000:10000 "$HERMES_DATA_DIR"')
    assert mem_setup > 0, "MEMORIES_DIR setup line not found"
    assert recursive_chown > 0, "recursive chown of HERMES_DATA_DIR not found"
    assert mem_setup < recursive_chown, (
        "MEMORIES_DIR mkdir+chmod must appear BEFORE the recursive "
        "`chown -R 10000:10000 \"$HERMES_DATA_DIR\"` so the dir is fully "
        "set up before init's final ownership pass."
    )


def test_memories_dir_setup_has_explanatory_comment():
    """The block must carry a comment explaining the 0777 — this is the
    kind of weird-looking permission that gets 'hardened' away by a later
    contributor unless its rationale is sitting next to it."""
    src = ENTRYPOINT.read_text()
    mem_idx = src.find('MEMORIES_DIR="${HERMES_DATA_DIR}/memories"')
    assert mem_idx > 0
    # Look ~600 chars BEFORE the assignment for an explanatory comment.
    preamble = src[max(0, mem_idx - 600) : mem_idx]
    assert "alfred-learn" in preamble or "uid 1000" in preamble, (
        "The MEMORIES_DIR setup block must carry a comment explaining "
        "why 0777 is correct (cross-container write between alfred-learn "
        "uid 1000 and hermes uid 10000) — otherwise a later 'security' "
        "pass will tighten it and silently break MEMORY.md seeding again."
    )
