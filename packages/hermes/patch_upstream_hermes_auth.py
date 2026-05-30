"""In-place patch of the pip-installed Hermes auth store, applied at
image-build time inside packages/hermes/Dockerfile.

Why this exists
---------------
Upstream NousResearch/hermes-agent's `hermes_cli/auth.py` hardens the
auth-store parent directory to 0o700 on every save:

    # Tighten parent dir to 0o700 so siblings can't traverse to creds.
    try:
        os.chmod(auth_file.parent, 0o700)
    except OSError:
        pass

For Hermes' single-user assumption (the parent is `~/.hermes/`) this is
fine. For alfred-black's per-profile layout where `HERMES_HOME` is the
*profile* directory itself, this chmod **rewrites the profile dir mode
on every OAuth token refresh** — silently undoing the init container's
careful 0o711 hardening on `/hermes-state/profiles/codex-builder`
(PR #118) and locking the paperclip-hermes adapter (uid 1000 via the
upstream `gosu node` entrypoint) out of `.env`.

The visible failure is identical to the pre-#118 state: every Paperclip
dispatch to the codex-builder profile gets
`hermes_auth_failed` / `invalid_api_key` because
`readHermesProfileApiKey("codex-builder")` returns null (EACCES on the
0o700 parent dir) and the adapter sends no `Authorization` header.

The companion fix lives in `hermes-profile.env.njk`:
`HERMES_HOME_MODE=0711` makes `_secure_dir(home)` honor 0o711 at every
CLI startup. This patch handles the `_save_auth_store` (and qwen + nous
shared-store) chmod path that fires on every token write — together
they cover both the startup and the runtime resets.

What this patch changes
-----------------------
Three call sites in `hermes_cli/auth.py` (~ line 1009 in
`_save_auth_store`, ~ line 1593 in `_save_qwen_cli_tokens`, ~ line 3556
in the nous-shared-store writer) all do the same
`os.chmod(<x>.parent, 0o700)`. We replace each with a guarded variant:

    if not _alfred_is_profile_dir(<x>.parent):
        os.chmod(<x>.parent, 0o700)

…where `_alfred_is_profile_dir` is a tiny helper appended to the module
that returns True iff the path lives under `/hermes-state/profiles/`
(matching every alfred-black profile dir, not just codex-builder). For
those paths, init owns the mode; the file itself is still chmod'd 0o600
by the same function below the change, so the auth tokens stay sealed.
On a real `~/.hermes/auth.json` install the helper returns False and
the patch is a no-op — the upstream tightening still happens.

The needles are picked to be byte-stable across upstream changes that
don't touch this specific chmod call; the build fails loudly via the
tripwire if a future HERMES_REF bump moves them.

Idempotent + tripwire'd
-----------------------
Each patch checks for the alfred sentinel comment
`# alfred-black: profile-dir-aware chmod` before patching and exits 0 if
already done. If a needle has moved, the script exits 2 — the
Dockerfile then fails the build rather than silently baking an
unpatched image.

Sir 2026-05-30 — durable fix for GH #119 (codex-feature-builder
heartbeat dispatch returns hermes_auth_failed).
"""

from __future__ import annotations

import pathlib
import sys


AUTH_PY = "/usr/local/lib/python3.12/site-packages/hermes_cli/auth.py"

SENTINEL = "# alfred-black: profile-dir-aware chmod"


# A small helper appended once at the END of the file. We do NOT touch
# the import block to keep the diff to upstream as narrow as possible —
# Python resolves _alfred_is_profile_dir lazily at call time, so its
# placement after the call sites is fine.
HELPER = '''


# === alfred-black patch (GH #119): profile-dir-aware parent chmod ============
# Hermes' upstream auth.py chmods the auth-store parent dir to 0o700 on every
# save (see needles patched in this file). In alfred-black HERMES_HOME points
# at a per-profile directory (e.g. /hermes-state/profiles/codex-builder)
# whose mode is owned by the init container — re-chmodding it here clobbers
# PR #118's 0o711 traverse-bit and locks the paperclip-hermes adapter
# (uid 1000) out of .env. The auth.json file itself stays 0o600, so credential
# hygiene is preserved by the file mode, not the dir mode.
#
# This helper is a no-op on a stock single-user install where the parent is
# ~/.hermes/ — the alfred-black sentinel path /hermes-state/profiles/ is only
# present in our containers.
def _alfred_is_profile_dir(parent_path) -> bool:  # pragma: no cover
    try:
        s = str(parent_path)
    except Exception:
        return False
    # Match /hermes-state/profiles/<name>/ — all 4 alfred-black profiles.
    return "/hermes-state/profiles/" in s
'''


# Each patch tuple: (needle, replacement, label).
PATCHES = [
    # 1. _save_auth_store — the OAuth provider token store. Hit on every
    #    `_save_auth_store(auth_store)` call (provider login, token
    #    refresh, write-back of cached creds). This is the call site that
    #    most often resets the codex-builder profile dir at runtime.
    (
        (
            "    auth_file.parent.mkdir(parents=True, exist_ok=True)\n"
            "    # Tighten parent dir to 0o700 so siblings can't traverse to creds.\n"
            "    # No-op on Windows (POSIX mode bits not enforced); ignore failures.\n"
            "    try:\n"
            "        os.chmod(auth_file.parent, 0o700)\n"
            "    except OSError:\n"
            "        pass\n"
        ),
        (
            "    auth_file.parent.mkdir(parents=True, exist_ok=True)\n"
            "    # Tighten parent dir to 0o700 so siblings can't traverse to creds.\n"
            "    # No-op on Windows (POSIX mode bits not enforced); ignore failures.\n"
            "    # " + SENTINEL + " (GH #119) — skip when parent is an alfred-black\n"
            "    # profile dir; init owns the mode (0o711 for codex-builder).\n"
            "    try:\n"
            "        if not _alfred_is_profile_dir(auth_file.parent):\n"
            "            os.chmod(auth_file.parent, 0o700)\n"
            "    except OSError:\n"
            "        pass\n"
        ),
        "auth.py:_save_auth_store",
    ),
    # 2. _save_qwen_cli_tokens — Qwen CLI's token store. Also calls
    #    chmod(parent, 0o700) on every save. Same fix.
    (
        (
            "def _save_qwen_cli_tokens(tokens: Dict[str, Any]) -> Path:\n"
            "    auth_path = _qwen_cli_auth_path()\n"
            "    auth_path.parent.mkdir(parents=True, exist_ok=True)\n"
            "    try:\n"
            "        os.chmod(auth_path.parent, 0o700)\n"
            "    except OSError:\n"
            "        pass\n"
        ),
        (
            "def _save_qwen_cli_tokens(tokens: Dict[str, Any]) -> Path:\n"
            "    auth_path = _qwen_cli_auth_path()\n"
            "    auth_path.parent.mkdir(parents=True, exist_ok=True)\n"
            "    # " + SENTINEL + " (GH #119) — see helper at file end.\n"
            "    try:\n"
            "        if not _alfred_is_profile_dir(auth_path.parent):\n"
            "            os.chmod(auth_path.parent, 0o700)\n"
            "    except OSError:\n"
            "        pass\n"
        ),
        "auth.py:_save_qwen_cli_tokens",
    ),
    # 3. nous shared store writer — same pattern, nested under
    #    `with _nous_shared_store_lock():`. Less frequently hit on
    #    codex-builder (no Nous account by default) but patched for
    #    completeness so a future cross-profile auth share doesn't
    #    silently reintroduce the regression.
    (
        (
            "            path = _nous_shared_store_path()\n"
            "            path.parent.mkdir(parents=True, exist_ok=True)\n"
            "            try:\n"
            "                os.chmod(path.parent, 0o700)\n"
            "            except OSError:\n"
            "                pass\n"
        ),
        (
            "            path = _nous_shared_store_path()\n"
            "            path.parent.mkdir(parents=True, exist_ok=True)\n"
            "            # " + SENTINEL + " (GH #119) — see helper at file end.\n"
            "            try:\n"
            "                if not _alfred_is_profile_dir(path.parent):\n"
            "                    os.chmod(path.parent, 0o700)\n"
            "            except OSError:\n"
            "                pass\n"
        ),
        "auth.py:_nous_shared_store",
    ),
]


def patch_file(path: str, patches, helper: str) -> None:
    p = pathlib.Path(path)
    src = p.read_text()

    if SENTINEL in src:
        print(f"{path}: already patched (sentinel present), skipping")
        return

    new_src = src
    for needle, replacement, label in patches:
        if needle not in new_src:
            print(
                f"{label}: NEEDLE_NOT_FOUND in {path} — upstream Hermes "
                f"may have moved this hunk; re-author the patch.",
                file=sys.stderr,
            )
            sys.exit(2)
        new_src = new_src.replace(needle, replacement, 1)
        print(f"{label}: patched")

    # Append the helper at the end of the file (after any trailing
    # newline). Idempotent because we check SENTINEL above; the helper
    # body contains the sentinel string.
    if not new_src.endswith("\n"):
        new_src += "\n"
    new_src += helper

    p.write_text(new_src)
    print(f"{path}: helper appended ({len(helper)} bytes)")


def main() -> None:
    patch_file(AUTH_PY, PATCHES, HELPER)


if __name__ == "__main__":
    main()
