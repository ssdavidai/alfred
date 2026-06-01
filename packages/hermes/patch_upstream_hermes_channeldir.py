"""In-place patch of the pip-installed Hermes atomic-write helper, applied
at image-build time inside packages/hermes/Dockerfile.

Why this exists
---------------
GH #222: the `codex-builder` profile's gateway wedges with
`[Errno 24] Too many open files`, leaving leaked `.channel_directory_*.tmp`
descriptors behind. Once the soft `nofile` limit (1024) is exhausted, every
subsequent socket / sqlite open fails — Slack `auth.test` drops, the kanban
sqlite store reports "unable to open database file", and the whole gateway
cascades into an unhealthy state.

The leaked file name `.channel_directory_<rand>.tmp` is produced by
`gateway/channel_directory.py:build_channel_directory()`, which writes the
directory via `atomic_json_write(DIRECTORY_PATH, directory)` — refreshed
every 5 minutes on a live gateway. But `channel_directory.py` itself is
**leak-safe**: it merely calls the shared helper inside its own try/except.

The ACTUAL leak is one level down, in the shared atomic-write helper
`utils.py:atomic_json_write` (and its siblings `atomic_yaml_write` +
`atomic_roundtrip_yaml_update`). All three do:

    fd, tmp_path = tempfile.mkstemp(...)            # raw fd, not yet owned
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:   # <-- the gap
            ...
        ...
    except BaseException:
        os.unlink(tmp_path)   # cleans the .tmp FILE
        raise                 # ...but the raw fd is NEVER closed

`tempfile.mkstemp()` returns a *raw* file descriptor that is only adopted by
the `with os.fdopen(fd) as f:` block. If `os.fdopen(fd, ...)` itself raises
— which is exactly what happens under fd pressure, the very `[Errno 24]`
condition we are trying to recover from — the `with` body is never entered,
so the raw `fd` is leaked. The `except BaseException` unlinks the `.tmp`
file (so the path cleanup is fine) but does NOT `os.close(fd)`. Each failed
write therefore burns one more descriptor, *accelerating* exhaustion: a
self-reinforcing leak that wedges the gateway permanently.

What this patch changes
-----------------------
Three call sites in `utils.py` (`atomic_json_write`, `atomic_yaml_write`,
`atomic_roundtrip_yaml_update`) all open the temp fd with the byte-identical
expression:

    os.fdopen(fd, "w", encoding="utf-8")

We replace each with a guarded wrapper that closes the raw `fd` if the
`os.fdopen` call fails:

    _alfred_fdopen_or_close(fd, "w", encoding="utf-8")

…where `_alfred_fdopen_or_close` is a tiny helper appended once at the END
of the module:

    def _alfred_fdopen_or_close(fd, *args, **kwargs):
        try:
            return os.fdopen(fd, *args, **kwargs)
        except BaseException:
            try:
                os.close(fd)
            except OSError:
                pass
            raise

On the happy path this is byte-for-byte equivalent to upstream
(`os.fdopen` succeeds, the returned object's own `with` closes it). On the
failure path it guarantees the raw descriptor is reclaimed before the
exception propagates — closing the leak for the channel-directory writer AND
every other atomic-write consumer (auth.json, config.yaml, sessions.json),
which is a strict improvement for all profiles, not just codex-builder.

NOTE on the target file (boundary diagnosis, GH #222)
-----------------------------------------------------
The orchestrator contract named `gateway/channel_directory.py` as the
suspected leak site. On inspecting the real upstream source at the pinned
ref (v2026.5.16), `channel_directory.py`'s writer is leak-safe — it only
calls `atomic_json_write`. The leak lives in `utils.py:atomic_json_write`.
Patching `utils.py` is the honest root-cause fix; patching the leak-safe
`channel_directory.py` would be a fabricated fix against a non-bug. The
build-time `grep -q` tripwire in the Dockerfile asserts the sentinel landed
in `utils.py`.

Idempotent + tripwire'd
-----------------------
The script checks for the alfred sentinel comment
`# alfred-black: fd-safe atomic write` before patching and exits 0 if it is
already present. If the needle (the shared `os.fdopen(...)` expression) is
absent — e.g. a future HERMES_REF bump rewrote the helper — the script
prints `NEEDLE_NOT_FOUND` to stderr and exits 2, so the Dockerfile fails the
build loudly rather than silently baking an unpatched image.

Sir 2026-06-01 — durable fix for GH #222 (codex-builder fd exhaustion /
`.channel_directory_*.tmp` leak that cascades to Slack + kanban).
"""

from __future__ import annotations

import pathlib
import sys


# `utils` is a top-level `py-modules` entry in upstream pyproject.toml
# (NOT under a package), so it installs flat at site-packages/utils.py.
# `gateway` is a package, so channel_directory.py — which merely *calls*
# this helper — lives at site-packages/gateway/channel_directory.py.
CHANNELDIR_PY = "/usr/local/lib/python3.12/site-packages/utils.py"

SENTINEL = "# alfred-black: fd-safe atomic write"

# The byte-identical fd-open expression shared by all three atomic writers
# in upstream utils.py (atomic_json_write / atomic_yaml_write /
# atomic_roundtrip_yaml_update). We swap it for the guarded wrapper below.
NEEDLE = 'os.fdopen(fd, "w", encoding="utf-8")'
REPLACEMENT = '_alfred_fdopen_or_close(fd, "w", encoding="utf-8")'

# Expect exactly this many occurrences in the pinned upstream. If a future
# bump changes the count, the tripwire logic below treats <1 as drift; we
# patch every occurrence with replace() so a count drift up/down is still a
# strict improvement (every site gets the guard) — but we assert >=1.
EXPECTED_SITES = 3


# A small helper appended once at the END of the file. We do NOT touch the
# import block — `os` is already imported at module top in upstream utils.py,
# and Python resolves `_alfred_fdopen_or_close` lazily at call time, so its
# placement after the call sites is fine.
HELPER = '''


# === alfred-black patch (GH #222): fd-safe temp-file open ====================
# Upstream utils.py adopts the mkstemp temp fd inside a context manager.
# tempfile.mkstemp() hands back a *raw* descriptor that is only adopted once
# that block is entered. If the fdopen call itself raises — exactly what
# happens under fd pressure, the `[Errno 24] Too many open files` condition —
# the block body is never reached and the raw fd leaks. The enclosing
# `except BaseException` unlinks the `.tmp` file but never closes the raw fd,
# so each failed write burns one more descriptor and accelerates exhaustion
# until the gateway wedges (Slack drops, kanban sqlite "unable to open
# database file").
#
# This wrapper closes the raw fd if the open fails, before re-raising. On the
# happy path it is identical to a bare open call. It is a strict improvement
# for every atomic-write consumer (channel_directory.json, auth.json,
# config.yaml, sessions.json), not just codex-builder.  # alfred-black: fd-safe atomic write
def _alfred_fdopen_or_close(fd, *args, **kwargs):  # pragma: no cover
    try:
        return os.fdopen(fd, *args, **kwargs)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        raise
'''


def patch_file(path: str, helper: str) -> None:
    p = pathlib.Path(path)
    src = p.read_text()

    if SENTINEL in src:
        print(f"{path}: already patched (sentinel present), skipping")
        return

    count = src.count(NEEDLE)
    if count < 1:
        print(
            f"channel_directory(utils.py): NEEDLE_NOT_FOUND in {path} — the "
            f"shared `os.fdopen(fd, ...)` atomic-write expression is absent; "
            f"upstream Hermes may have rewritten the helper. Re-author the "
            f"patch.",
            file=sys.stderr,
        )
        sys.exit(2)

    if count != EXPECTED_SITES:
        # Not fatal — patching every occurrence is still correct — but log it
        # so a drift in the number of atomic writers is visible in the build.
        print(
            f"{path}: WARNING expected {EXPECTED_SITES} fd-open sites, "
            f"found {count} — patching all of them.",
            file=sys.stderr,
        )

    # Replace every occurrence of the raw fd-open with the guarded wrapper.
    new_src = src.replace(NEEDLE, REPLACEMENT)
    print(f"utils.py: patched {count} fd-open site(s) → _alfred_fdopen_or_close")

    # Append the helper at the end of the file (after any trailing newline).
    # Idempotent because we check SENTINEL above; the helper body contains the
    # sentinel string.
    if not new_src.endswith("\n"):
        new_src += "\n"
    new_src += helper

    p.write_text(new_src)
    print(f"{path}: helper appended ({len(helper)} bytes)")


def main() -> None:
    patch_file(CHANNELDIR_PY, HELPER)


if __name__ == "__main__":
    main()
