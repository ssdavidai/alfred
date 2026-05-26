"""In-place patch of the pip-installed Hermes gateway package, applied at
image-build time inside packages/hermes/Dockerfile.

Why this exists
---------------
Upstream NousResearch/hermes-agent silently drops HTML attachments on
Slack (and any other channel that inherits SUPPORTED_DOCUMENT_TYPES from
gateway/platforms/base.py). The Slack adapter's else-branch hits
``continue`` when the file extension isn't in the whitelist, which means
.html / .htm uploads never reach the agent — no error to the sender, no
log line above DEBUG, no attachment for the LLM.

This script teaches the whitelist about HTML, AND adds .html/.htm to
slack.py's TEXT_INJECT_EXTENSIONS so a small HTML attachment (<=100 KB)
is inlined into the prompt as text rather than just being attached as a
media URL — the most useful default for things like saved emails or
articles.

Same gap exists for Telegram/Discord adapters by inheritance from
base.py — the base.py edit fixes all of them. TEXT_INJECT_EXTENSIONS is
Slack-specific.

Idempotent + tripwire'd
-----------------------
Each edit checks for ".html" before patching and exits 0 if already
done. If a future HERMES_REF bump moves the upstream needles, the script
exits 2 — the Dockerfile then fails the build loudly rather than
silently baking an unpatched image. When that happens, re-author the
patch against the new shape, or drop the script entirely if upstream
finally accepts HTML.

Sir 2026-05-26 — local-only durable fix for an upstream Hermes bug.
"""

from __future__ import annotations

import pathlib
import sys


BASE_PY = "/usr/local/lib/python3.12/site-packages/gateway/platforms/base.py"
SLACK_PY = "/usr/local/lib/python3.12/site-packages/gateway/platforms/slack.py"


def patch(path: str, needle: str, replacement: str, label: str) -> None:
    p = pathlib.Path(path)
    src = p.read_text()
    if '".html"' in src and '".htm"' in src:
        print(f"{label}: already patched, skipping")
        return
    if needle not in src:
        print(
            f"{label}: NEEDLE_NOT_FOUND in {path} — upstream Hermes "
            f"may have moved this hunk; re-author the patch.",
            file=sys.stderr,
        )
        sys.exit(2)
    p.write_text(src.replace(needle, replacement, 1))
    print(f"{label}: patched")


def main() -> None:
    # base.py — add .html / .htm right before .zip in SUPPORTED_DOCUMENT_TYPES.
    patch(
        BASE_PY,
        '    ".zip": "application/zip",',
        (
            '    ".html": "text/html",\n'
            '    ".htm": "text/html",\n'
            '    ".zip": "application/zip",'
        ),
        "base.py:SUPPORTED_DOCUMENT_TYPES",
    )

    # slack.py — add .html / .htm to TEXT_INJECT_EXTENSIONS so HTML <=100KB
    # inlines as text into the prompt.
    patch(
        SLACK_PY,
        '                        ".yaml", ".yml", ".toml", ".ini", ".cfg",',
        (
            '                        ".yaml", ".yml", ".toml", ".ini", ".cfg",\n'
            '                        ".html", ".htm",'
        ),
        "slack.py:TEXT_INJECT_EXTENSIONS",
    )


if __name__ == "__main__":
    main()
