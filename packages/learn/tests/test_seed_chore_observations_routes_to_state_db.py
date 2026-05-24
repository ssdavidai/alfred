"""Gap 5c — chore-run observation seeding routes to state.db, not vault.

Symptom on home.alfred.black: LearningWorkflow emits 18× HTTP 422 per
tick because ``seed_observations_from_chore_runs`` calls
``write_observation_record`` which POSTs ``/api/v1/vault/records`` with
``type=observation``. Post-storage-cutover (#26/#27) observations are
state.db rows, not vault records — ctrl-api's canonical_path middleware
rejects the write with 422 and suggests routing to
``/api/v1/state/observations`` instead.

Fix contract: ``seed_observations_from_chore_runs`` must call
``StateClient.create_observation`` (which POSTs
``/api/v1/state/observations``) for each entry, with kind=``chore_run``,
subject=``principal``, summary=the run summary, and the rich shape
carried in ``payload``. Mirrors how
``signal_observations.extract_obs_from_signal`` writes signal
observations to state.db.

Test: install a fake StateClient that records every create_observation
call; assert the seeder calls it (not the vault writer) for every new
entry.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from src.activities import observe


def _seed_history(path: Path, entries: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as fh:
        for e in entries:
            fh.write(json.dumps(e) + "\n")


class _FakeStateClient:
    """Captures create_observation calls. Mirrors StateClient's interface
    shape from src/utils/state_client.py.
    """

    instances: list["_FakeStateClient"] = []

    def __init__(self, config: Any) -> None:
        self.calls: list[dict[str, Any]] = []
        _FakeStateClient.instances.append(self)

    async def __aenter__(self) -> "_FakeStateClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def create_observation(
        self,
        *,
        subject: str,
        kind: str,
        summary: str,
        detail: str | None = None,
        ts: str | None = None,
        decision_ref: str | None = None,
        instinct_ref: str | None = None,
        confidence: float | None = None,
        status: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> str:
        self.calls.append({
            "subject": subject,
            "kind": kind,
            "summary": summary,
            "detail": detail,
            "ts": ts,
            "decision_ref": decision_ref,
            "instinct_ref": instinct_ref,
            "confidence": confidence,
            "status": status,
            "payload": payload,
        })
        return f"obs-ulid-{len(self.calls)}"


@pytest.fixture(autouse=True)
def _reset_state_client() -> None:
    _FakeStateClient.instances.clear()
    yield
    _FakeStateClient.instances.clear()


def _run() -> dict[str, Any]:
    from temporalio.testing import ActivityEnvironment

    env = ActivityEnvironment()
    return asyncio.run(env.run(observe.seed_observations_from_chore_runs))


def test_seeder_writes_to_state_db_not_vault(monkeypatch, tmp_path):
    """Gap 5c — every seeded entry must POST /api/v1/state/observations.

    Concretely: the activity must invoke StateClient.create_observation
    (the state.db writer) once per new entry, and must NOT call
    vault.write_observation_record (the now-422-ing vault writer).

    RED on unfixed code: the activity calls write_observation_record,
    so our StateClient fake gets zero calls.
    """
    history = tmp_path / "history.jsonl"
    cursor = tmp_path / "cursor.json"
    _seed_history(history, [
        {"timestamp": 100.0, "chore_slug": "watch-stripe", "result_summary": "ok", "was_dry_run": False},
        {"timestamp": 200.0, "chore_slug": "scan-inbox", "result_summary": "5 items", "was_dry_run": False},
        {"timestamp": 300.0, "chore_slug": "report-x", "result_summary": "done", "was_dry_run": True},
    ])

    # Sanity: import path the seeder should reach for.
    import src.utils.signal_state as ss
    import src.utils.state_client as sc_mod
    monkeypatch.setattr(sc_mod, "StateClient", _FakeStateClient)
    monkeypatch.setattr(ss, "StateClient", _FakeStateClient)

    # If the buggy code path still calls write_observation_record, blow up
    # — that proves the activity is still on the wrong path.
    async def _should_not_call(*args, **kwargs):
        raise AssertionError(
            "seed_observations_from_chore_runs must NOT call vault."
            "write_observation_record post Gap 5c fix — it should write to "
            "state.db via StateClient.create_observation."
        )

    with patch.object(observe, "_CHORE_RUN_HISTORY_PATH", history), \
         patch.object(observe, "_OBS_SEED_CURSOR_PATH", cursor), \
         patch("src.activities.vault.write_observation_record",
               new=_should_not_call):
        result = _run()

    assert result["ok"] is True
    assert result["seeded"] == 3, f"expected 3 seeded; got {result!r}"

    # The StateClient fake should have been used.
    assert _FakeStateClient.instances, (
        "StateClient was never instantiated — seeder isn't writing to "
        "state.db yet (it's still on the vault path)"
    )
    all_calls: list[dict[str, Any]] = []
    for inst in _FakeStateClient.instances:
        all_calls.extend(inst.calls)
    assert len(all_calls) == 3, (
        f"expected 3 create_observation calls; got {len(all_calls)}: "
        f"{all_calls!r}"
    )

    # Spot-check the shape — kind tags the source as chore_run, subject
    # is the principal (matches signal/decision observations), summary
    # carries the run result.
    by_summary = {c["summary"]: c for c in all_calls}
    assert any("watch-stripe" in (c.get("summary") or "") or
               "watch-stripe" in str(c.get("payload") or {})
               for c in all_calls), (
        f"watch-stripe entry should be reflected; got {all_calls!r}"
    )
    for c in all_calls:
        assert c["subject"] == "principal", (
            f"all observations carry subject=principal; got {c!r}"
        )
        assert c["kind"] == "chore_run", (
            f"chore-run observations must use kind=chore_run; got {c!r}"
        )
        payload = c.get("payload") or {}
        assert isinstance(payload, dict), "payload must be a dict"
        # The original rich shape must survive — chore_slug at minimum,
        # so pattern detection can cluster on it later.
        assert payload.get("source") == "chore_run" or "chore" in str(payload), (
            f"payload should mark source=chore_run; got {payload!r}"
        )
