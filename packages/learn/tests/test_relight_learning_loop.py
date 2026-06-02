"""Regression guards for the observation→instinct loop relight.

Two distinct bugs starved the loop after the #232 status-vocab fix made
reflection actually fetch observations:

1. ``steward._emit_source_pruned_audit`` had a leftover
   ``finally: await client.close()`` over a ``client`` it never defines (it
   writes via ``async with StateClient(cfg) as sc``). That raised NameError on
   EVERY source-prune — the audit landed, the activity then failed in the
   finally, Temporal retried, and a duplicate audit landed each retry (the
   steward error storm + runaway ``steward-source-pruned`` audit count).

2. ``ReflectionWorkflow`` fetched a 200-observation batch and gave
   ``clerk_reflect`` a 120s StartToClose timeout. One LLM pass over 200
   observations + the instinct set blew past 120s → the whole workflow failed →
   nothing was marked processed → a backlog could never drain.

These are source-level guards (cheap, no network) so the two regressions
can't silently come back.
"""
import inspect
import re


def test_emit_source_pruned_audit_does_not_close_undefined_client():
    from src.activities import steward

    src = inspect.getsource(steward._emit_source_pruned_audit)
    # The function uses `async with StateClient(...) as sc` — it must NOT
    # reference a bare `client` (there is none to close).
    assert "client.close()" not in src, (
        "_emit_source_pruned_audit must not close a `client` it never opens — "
        "that finally raised NameError on every source-prune."
    )
    assert "StateClient" in src, "should still write its audit via StateClient"


def test_reflection_fetch_batch_is_bounded():
    from src.activities import vault

    src = inspect.getsource(vault.fetch_unprocessed_observations)
    m = re.search(r"list_observations\([^)]*limit=(\d+)", src, re.DOTALL)
    assert m, "fetch_unprocessed_observations must pass an explicit limit"
    limit = int(m.group(1))
    # 200 was the value that overflowed clerk_reflect's timeout. Keep the batch
    # small enough that one reflection comfortably completes.
    assert limit <= 100, f"reflection batch limit {limit} is too large (was 200)"


def test_reflection_clerk_timeout_has_headroom():
    import src.workflows.reflection as refl

    src = inspect.getsource(refl)
    # The clerk_reflect activity is the slow LLM step. Find every
    # start_to_close_timeout=timedelta(seconds=N) and assert the largest one
    # (the clerk_reflect call) is generous — 120s was the value that failed.
    seconds = [int(x) for x in re.findall(r"start_to_close_timeout=timedelta\(seconds=(\d+)\)", src)]
    assert seconds, "reflection workflow should set activity timeouts"
    assert max(seconds) >= 300, (
        f"clerk_reflect timeout headroom too small (max={max(seconds)}s); 120s timed out on the backlog"
    )
