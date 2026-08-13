"""In-place patch of LCMEngine in /opt/hermes-lcm/engine.py, applied at
image-build time inside packages/hermes/Dockerfile.

Why this exists (GH #424 — Hermes 0.19 per-agent engine copying)
-----------------------------------------------------------------
Hermes 0.19 deep-copies the context engine into each delegated / spawned
agent.  The default ``copy.deepcopy`` fails because LCMEngine's three SQLite
store objects (MessageStore, SummaryDAG, LifecycleStateStore) each hold a live
``sqlite3.Connection`` as ``self._conn``.  LCMEngine also holds a
``threading.RLock`` (``_auxiliary_session_lock``) and a ``threading.local``
(``_thread_context``), which are equally unpicklable.

The result: every delegated / spawned / background agent silently falls back to
Hermes' built-in compressor instead of LCM — 331 WARNING log lines in 7 days
on home (2026-08-06 audit).  Main-profile conversation is unaffected (it keeps
LCM); the regression is confined to the delegation path.

Fix
---
Add ``LCMEngine.__deepcopy__`` following the hint in Hermes' own warning
message.  The implementation:

  1. Creates a fresh ``LCMEngine`` from the same config and hermes_home —
     opening NEW connections to the shared WAL-mode ``lcm.db``.  Multiple
     concurrent readers/writers are safe under WAL.
  2. Copies only the mutable budget / counter scalars the parent has
     accumulated (model name, token counts, threshold settings, etc.).
  3. Intentionally does NOT copy session-binding state (_session_id,
     _foreground_session_id, cursor, etc.) — the sub-agent starts its own
     session against the shared durable store and reconciles its ingest
     cursor on the first write.

Applies against LCM ref 2d108b759e33b72427350dffcb77281f7f61baf9 (tag v0.11.1).
Re-verify the NEEDLE after bumping HERMES_LCM_REF.

The durable fix is upstreaming ``__deepcopy__`` to
stephenschoettler/hermes-lcm — that is the repo owner's call, not ours.

Idempotent (SENTINEL check) + tripwire'd (NEEDLE check exits 2 on mismatch).
"""

from __future__ import annotations

import pathlib
import sys

TARGET = "/opt/hermes-lcm/engine.py"

SENTINEL = "alfred-black: LCMEngine __deepcopy__"

# The last line of LCMEngine.__init__ and the first line of _set_context_length,
# verified byte-for-byte against hermes-lcm ref
# 2d108b759e33b72427350dffcb77281f7f61baf9 on home.alfred.black 2026-08-13.
NEEDLE = (
    "        self._auxiliary_session_lock = threading.RLock()\n"
    "\n"
    "    def _set_context_length(self, context_length: Any, *, source: str) -> bool:"
)

# The __deepcopy__ method is inserted between __init__ and _set_context_length.
_DEEPCOPY_METHOD = '''
    def __deepcopy__(self, memo):
        """alfred-black: LCMEngine __deepcopy__ for Hermes 0.19 per-agent
        engine copying (upstream workaround, GH #424; applies against LCM
        ref 2d108b759e33b72427350dffcb77281f7f61baf9 / tag v0.11.1).

        sqlite3.Connection, threading.RLock, and threading.local are not
        picklable, so the default deepcopy raises and Hermes falls back to
        the built-in compressor for every delegated / spawned agent.  This
        method creates a fresh LCMEngine from the same config (opening new
        connections to the shared WAL-mode lcm.db) and copies only the
        mutable budget / counter scalars the parent has accumulated.

        Session-binding state (_session_id, _foreground_session_id, …) is
        intentionally NOT copied — the sub-agent starts its own session
        against the shared durable store and reconciles its ingest cursor
        on the first write.
        """
        new_engine = LCMEngine(config=self._config, hermes_home=self._hermes_home)
        memo[id(self)] = new_engine
        _budget_attrs = (
            "model", "base_url", "api_key", "provider", "api_mode",
            "context_length", "_context_length_source",
            "threshold_tokens", "threshold_percent",
            "last_prompt_tokens", "last_completion_tokens",
            "last_total_tokens", "last_input_tokens", "last_output_tokens",
            "last_cache_read_tokens", "last_cache_write_tokens",
            "last_reasoning_tokens", "cache_metrics_available",
            "compression_count", "protect_first_n", "protect_last_n",
            "_context_probed", "_context_probe_persistable",
            "quiet_mode", "summary_model",
            "_last_overflow_recovery_failed",
            "_last_condensation_suppressed_reason",
            "_last_compression_status",
            "_last_compression_noop_reason",
        )
        for attr in _budget_attrs:
            if hasattr(self, attr):
                setattr(new_engine, attr, getattr(self, attr))
        return new_engine
'''

REPLACEMENT = (
    "        self._auxiliary_session_lock = threading.RLock()\n"
    + _DEEPCOPY_METHOD
    + "\n"
    "    def _set_context_length(self, context_length: Any, *, source: str) -> bool:"
)


def main() -> None:
    p = pathlib.Path(TARGET)
    src = p.read_text()

    if SENTINEL in src:
        print("LCMEngine.__deepcopy__: already patched, skipping")
        return

    if NEEDLE not in src:
        print(
            f"LCMEngine.__deepcopy__: NEEDLE_NOT_FOUND in {TARGET} — "
            f"upstream hermes-lcm may have moved this hunk; "
            f"re-author the patch after bumping HERMES_LCM_REF.",
            file=sys.stderr,
        )
        sys.exit(2)

    p.write_text(src.replace(NEEDLE, REPLACEMENT, 1))
    print("LCMEngine.__deepcopy__: patched (deepcopy support added for Hermes 0.19)")


if __name__ == "__main__":
    main()
