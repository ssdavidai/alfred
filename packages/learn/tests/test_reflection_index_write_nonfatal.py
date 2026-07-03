"""BUG 1 — rebuild_intuition_index must never wedge ReflectionWorkflow.

The "index" vault type is rejected by ctrl-api's promotion contract
(HTTP 422). Before the fix, that write raised, the workflow step had no
retry cap, and ReflectionWorkflow retried it ~26k times over a month —
so the observation backlog never drained and no instinct was ever
promoted. The activity must now swallow the write failure and return.
"""
from __future__ import annotations

from src.activities import vault as vmod


async def test_rebuild_intuition_index_swallows_write_failure(monkeypatch) -> None:
    class _FakeClient:
        async def list_records(self, _type):
            return [{"name": "n", "path": "instinct/n.md", "observation_count": 1}]

        async def write_record(self, *a, **k):
            # Mirror the real ctrl-api rejection of a non-canonical type.
            raise RuntimeError("422 PROMOTION_CONTRACT_VIOLATION: index")

        async def close(self):
            return None

    monkeypatch.setattr(vmod, "VaultClient", lambda *a, **k: _FakeClient())
    monkeypatch.setattr(vmod, "load_config", lambda: object())

    # Must NOT raise. (Pre-fix this propagated the 422 and wedged the run.)
    await vmod.rebuild_intuition_index()


async def test_write_reflection_report_swallows_write_failure(monkeypatch) -> None:
    # The SECOND wedge point (found on the home canary): "reflection" is also a
    # non-canonical type → 422. Must swallow and return "" so the workflow
    # completes and the observation backlog drains.
    class _FakeClient:
        async def write_record(self, *a, **k):
            raise RuntimeError("422 PROMOTION_CONTRACT_VIOLATION: reflection")

        async def close(self):
            return None

    monkeypatch.setattr(vmod, "VaultClient", lambda *a, **k: _FakeClient())
    monkeypatch.setattr(vmod, "load_config", lambda: object())

    out = await vmod.write_reflection_report([], [], 0)
    assert out == ""
