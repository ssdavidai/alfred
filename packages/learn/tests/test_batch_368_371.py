"""Regression tests for the #368/#369/#371 batch (2026-08-01 deep-inspect).

#368 — briefings wrote ``record_type: briefing``; ctrl-api's vault list
filters on ``fm.type``, so briefing records never listed and
``get_prior_briefing`` silently used a naive 24h fallback on every run
since the BriefingWorkflow cutover ("Since yesterday" never had content).

#369 — ``route_decision`` silently no-op'd decisions missing
``source_record``: 12 live orphans on home re-fetched + re-skipped every
60s for 3-14 days. Now retired terminal with a stamped reason.

#371 — the signal-extract dead-letter gate read ``.type`` off Temporal's
``ActivityError`` wrapper (which has none) instead of ``__cause__``, so
the non_retryable classification was dead code.
"""
from __future__ import annotations

import asyncio
import inspect

import pytest


class TestBriefingTypeKey368:
    def test_writer_emits_type_not_record_type(self):
        """The frontmatter builder must key on `type:` — the only key the
        ctrl-api list endpoint filters on."""
        from src.activities import briefing as briefing_mod

        src = inspect.getsource(briefing_mod)
        assert '"type: briefing"' in src
        assert '"record_type: briefing"' not in src


class _FakeResp:
    def __init__(self, payload=None, status=200):
        self._payload = payload or {}
        self.status_code = status

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _FakeHttp:
    def __init__(self):
        self.patches: list[tuple[str, dict]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def patch(self, url, json=None):
        self.patches.append((url, json))
        return _FakeResp()

    async def get(self, url, **kw):
        return _FakeResp({"decisions": []})

    async def post(self, url, json=None):
        return _FakeResp()


class TestRouteDecisionRetires369:
    def test_missing_source_record_is_retired_not_silently_skipped(
        self, monkeypatch
    ):
        from src.activities import decision_router as dr

        fake = _FakeHttp()
        monkeypatch.setattr(dr, "_http", lambda: fake)

        out = asyncio.run(
            dr.route_decision(
                {
                    "id": "alfred-code-2026-07-28-build-gate",
                    "state": "open",
                    "intent": "delegate",
                    # source_record missing — the orphan shape
                }
            )
        )
        assert out["skipped"] is True
        assert out["reason"] == "missing required fields"
        # The decision must be PATCHed terminal with the stamped reason.
        assert len(fake.patches) == 1
        url, body = fake.patches[0]
        assert "alfred-code-2026-07-28-build-gate" in url
        assert body["state"] == "completed"
        assert body["side_effects"]["decision_router"] == "missing_source_record"
        assert "retired_at" in body["side_effects"]

    def test_decision_without_id_is_not_patched(self, monkeypatch):
        from src.activities import decision_router as dr

        fake = _FakeHttp()
        monkeypatch.setattr(dr, "_http", lambda: fake)
        out = asyncio.run(dr.route_decision({"state": "open"}))
        assert out["skipped"] is True
        assert fake.patches == []


class TestErrorTypeUnwrap371:
    def test_reads_type_from_cause(self):
        from temporalio.exceptions import ApplicationError

        from src.workflows.signals import _extract_error_type

        wrapper = RuntimeError("activity failed")  # stand-in wrapper, no .type
        wrapper.__cause__ = ApplicationError("bad payload", type="SchemaInvalid")
        assert _extract_error_type(wrapper) == "SchemaInvalid"

    def test_falls_back_to_wrapper_class_name(self):
        from src.workflows.signals import _extract_error_type

        assert _extract_error_type(ValueError("x")) == "ValueError"

    def test_direct_application_error_type_still_read(self):
        from temporalio.exceptions import ApplicationError

        from src.workflows.signals import _extract_error_type

        err = ApplicationError("boom", type="MalformedPayload")
        assert _extract_error_type(err) == "MalformedPayload"
