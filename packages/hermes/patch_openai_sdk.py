"""In-place patch of the pip-installed openai Python SDK, applied at
image-build time inside packages/hermes/Dockerfile.

Why this exists
---------------
2026-05-27 OpenAI changed the streaming response shape on their Codex
backend (`https://chatgpt.com/backend-api/codex/responses`). During the
`response.output_item.added` event, the snapshot the SDK accumulates now
carries `output: None` instead of `output: []`. The SDK's response parser
at `openai/lib/_parsing/_responses.py:61` then crashes with:

    for output in response.output:
    TypeError: 'NoneType' object is not iterable

…and every Hermes-main turn using `openai-codex` provider fails with
"Non-retryable client error: 'NoneType' object is not iterable". The
agent has no fallback configured, so the user gets a 36-char error
message on every channel.

Hermes' own code in `run_agent.py:7142` already knows how to backfill an
empty `final_response.output` from the streamed event items + collected
text deltas — the SDK just needs to stop crashing in the snapshot
accumulator before that backfill can run.

This patch is one line: `for output in (response.output or []):`.
Idempotent (skips if already patched) + tripwire'd (fails the build if a
future openai SDK bump moves the line — at which point we re-author or
drop the patch).

Sir 2026-05-27 — local-only durable fix for an upstream openai SDK bug
exposed by an OpenAI backend change.
"""

from __future__ import annotations

import pathlib
import sys


RESPONSES_PY = (
    "/usr/local/lib/python3.12/site-packages/openai/lib/_parsing/_responses.py"
)
NEEDLE = "    for output in response.output:"
REPLACEMENT = "    for output in (response.output or []):"
SENTINEL = "(response.output or [])"


def main() -> None:
    p = pathlib.Path(RESPONSES_PY)
    src = p.read_text()
    if SENTINEL in src:
        print(f"openai/_parsing/_responses.py: already patched, skipping")
        return
    if NEEDLE not in src:
        print(
            "openai/_parsing/_responses.py: NEEDLE_NOT_FOUND — openai SDK may "
            "have moved or fixed this. Re-author the patch (or drop it if "
            "fixed upstream).",
            file=sys.stderr,
        )
        sys.exit(2)
    p.write_text(src.replace(NEEDLE, REPLACEMENT, 1))
    print("openai/_parsing/_responses.py: patched")


if __name__ == "__main__":
    main()
