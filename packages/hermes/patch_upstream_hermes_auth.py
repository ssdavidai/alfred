"""In-place patch of ``hermes_constants.secure_parent_dir``, applied at
image-build time inside packages/hermes/Dockerfile.

Why this exists (GH #119 — re-authored for Hermes 0.17)
------------------------------------------------------
Upstream tightens the *parent directory* of the auth store to ``0o700`` on
every save (token refresh, provider login, cached-cred write-back). In 0.14
this was a bare ``os.chmod(<path>.parent, 0o700)`` in ``hermes_cli/auth.py``;
Hermes 0.17 refactored it into ``hermes_constants.secure_parent_dir()``, called
from auth.py's save paths (and the qwen/nous shared-store variants). The chmod
still fires — 0.17 only added a guard that refuses ``/`` and top-level dirs
(the #25821 host-bricking fix), which is orthogonal to our problem.

In alfred-black ``HERMES_HOME`` points at a *profile* dir
(e.g. ``/hermes-state/profiles/codex-builder``). PR #118 set the codex-builder
profile dir to ``0o711`` so the paperclip-hermes adapter (uid 1000) can
traverse to ``.env`` for the gateway's ``API_SERVER_KEY``; an auth-store save
then resets it to ``0o700`` and the next paperclip → :18793 dispatch 401s with
hermes_auth_failed / invalid_api_key (GH #119). The companion fix —
``HERMES_HOME_MODE=0711`` in the codex-builder profile ``.env`` — handles the
``_secure_dir(home)`` path at CLI startup; this patch handles the auth-save
path that fires at every token write.

The fix: teach ``secure_parent_dir`` to never chmod a Hermes *profile* directory
(``…/profiles/<name>``), whose mode is owned by the init container. Single site,
so all callers (auth save + variants) are covered at once. The #25821 root /
top-level guard is preserved.

Idempotent (sentinel) + tripwire'd (the Dockerfile fails the build if the needle
moves in a future HERMES_VERSION bump).
"""

from __future__ import annotations

import pathlib
import sys

TARGET = "/usr/local/lib/python3.12/site-packages/hermes_constants.py"

SENTINEL = "alfred-black: never chmod a Hermes profile dir"

# The exact tail of secure_parent_dir() in Hermes 0.17 (verified byte-for-byte
# against the golden home box, 2026-07-02).
NEEDLE = (
    "    try:\n"
    "        os.chmod(parent, 0o700)\n"
    "    except OSError:\n"
    "        pass"
)

REPLACEMENT = (
    "    # alfred-black: never chmod a Hermes profile dir (…/profiles/<name>) —\n"
    "    # its mode is owned by the init container (codex-builder is 0o711 so the\n"
    "    # paperclip-hermes adapter can traverse to .env for the gateway API key;\n"
    "    # upstream's 0o700 tighten on every auth-save 401s the next :18793\n"
    "    # dispatch — GH #119).\n"
    '    if parent.parent.name == "profiles":\n'
    "        return\n"
    "    try:\n"
    "        os.chmod(parent, 0o700)\n"
    "    except OSError:\n"
    "        pass"
)


def main() -> None:
    # Optional argv[1] target. The image installs Hermes twice: the pip wheel
    # into site-packages, AND the pinned 0.20.x tree under
    # /usr/local/lib/hermes-agent, which runs from its OWN venv with
    # PYTHONPATH/PYTHONHOME unset — so a site-packages-only patch never
    # reaches the code that actually runs. Both trees get patched; the
    # default keeps existing callers unchanged.
    target = sys.argv[1] if len(sys.argv) > 1 else TARGET
    p = pathlib.Path(target)
    src = p.read_text()
    if SENTINEL in src:
        print("secure_parent_dir: already patched, skipping")
        return
    if NEEDLE not in src:
        print(
            f"secure_parent_dir: NEEDLE_NOT_FOUND in {target} — upstream Hermes "
            f"may have moved this hunk; re-author the patch.",
            file=sys.stderr,
        )
        sys.exit(2)
    p.write_text(src.replace(NEEDLE, REPLACEMENT, 1))
    print("secure_parent_dir: patched (profile-dir guard added)")


if __name__ == "__main__":
    main()
