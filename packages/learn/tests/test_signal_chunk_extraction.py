"""Chunked signal extraction (#524) — extract_signals_from_event (multi path).

Production logs show ``multi=True`` for 7+ days; the single path is unreachable.
Four tests: fast path (small body → 1 chunk), ceiling enforcement, multi-chunk
fan-out with body_len in logs, and dedupe by ``effect|target_hint``.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.utils.signal_prompts import (  # noqa: E402
    SIGNAL_BODY_CHUNK_SIZE,
    SIGNAL_BODY_CHUNK_THRESHOLD,
    SIGNAL_MAX_CHUNKS,
    chunk_body_for_signal_extraction,
)


# ---------------------------------------------------------------------------
# Rate-guard stub — get_rate_guard is lazily imported inside the activity
# so we patch src.activities.rate_guard, not the signals module namespace.
# ---------------------------------------------------------------------------

class _AllowedDecision:
    allowed = True
    cap = None
    reason = ""
    backoff_until = 0.0


class _MockRateGuard:
    async def check_and_reserve(self, **kwargs: Any) -> _AllowedDecision:
        return _AllowedDecision()

    async def record_cap_skip(self, **kwargs: Any) -> None:
        pass

    async def record_429(self, secs: int) -> None:
        pass


def _patch_rate_guard() -> Any:
    guard = _MockRateGuard()
    return patch("src.activities.rate_guard.get_rate_guard", return_value=guard)


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _make_fake_event(body: str) -> dict[str, Any]:
    return {"frontmatter": {"source_type": "webhook"}, "content": body}


def _action_signal(target_hint: str = "project-alpha", confidence: float = 0.9) -> dict[str, Any]:
    return {
        "effect": "action",
        "effect_confidence": confidence,
        "reasoning": "follow up needed",
        "target_kind_hint": "task",
        "target_hint": target_hint,
        "mutation_proposal": None,
        "action_proposal": {"summary": "follow up"},
        "display_headline": "Follow up",
        "display_body": "Action body",
    }


# ---------------------------------------------------------------------------
# 1–2. chunk_body_for_signal_extraction unit tests (pure, no mocks)
# ---------------------------------------------------------------------------

def test_small_body_single_chunk() -> None:
    """Bodies at or under the threshold return exactly one chunk, tail_dropped=False."""
    body = "x" * SIGNAL_BODY_CHUNK_THRESHOLD
    chunks, tail_dropped = chunk_body_for_signal_extraction(body)
    assert len(chunks) == 1
    assert chunks[0] == body
    assert tail_dropped is False


def test_ceiling_enforced_and_tail_dropped() -> None:
    """Bodies longer than MAX_CHUNKS × CHUNK_SIZE are capped; tail_dropped=True."""
    oversized = "Z" * (SIGNAL_MAX_CHUNKS * SIGNAL_BODY_CHUNK_SIZE + 500)
    chunks, tail_dropped = chunk_body_for_signal_extraction(oversized)
    assert len(chunks) == SIGNAL_MAX_CHUNKS
    assert tail_dropped is True


# ---------------------------------------------------------------------------
# 3–4. extract_signals_from_event activity tests (multi-signal path)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_large_body_chunks_each_contribute(caplog: pytest.LogCaptureFixture) -> None:
    """A body > threshold fans out to one LLM call per chunk; body_len logged."""
    import src.activities.signals as signals_mod

    large_body = "W" * (SIGNAL_BODY_CHUNK_SIZE * 3)  # exactly 3 chunks of 2000
    assert len(large_body) > SIGNAL_BODY_CHUNK_THRESHOLD

    fake_event = _make_fake_event(large_body)
    call_count = {"n": 0}

    async def fake_clerk(prompt: str, raw: bool = True) -> dict[str, Any]:
        call_count["n"] += 1
        return {"signals": [_action_signal(target_hint=f"task-chunk-{call_count['n']}")]}

    async def fake_read(self: Any, path: str) -> dict[str, Any]:
        return fake_event

    async def fake_resolve(target_hint: str, target_kind_hint: str, *, client: Any) -> dict[str, Any]:
        return {"target_path": None, "target_kind": None, "target_confidence": 0.0,
                "candidates": [], "ambiguous": False}

    async def fake_noise(*a: Any, **k: Any) -> list[Any]:
        return []

    async def fake_task_create(sig: Any) -> str | None:
        return None

    with caplog.at_level(logging.INFO, logger="alfred-learn"):
        with (
            patch.object(signals_mod.VaultClient, "read_record", fake_read),
            patch("src.activities.signals._pre_filter", return_value=(True, "")),
            patch("src.activities.signals._resolve_target", fake_resolve),
            patch("src.activities.clerk._call_clerk", fake_clerk),
            patch("src.activities.noise_patterns.load_active_noise_patterns", fake_noise),
            patch("src.activities.noise_patterns.load_noise_instincts", fake_noise),
            patch("src.activities.signals._load_soul_md", return_value=None),
            patch("src.activities.task_creation.create_task_from_signal", fake_task_create),
            _patch_rate_guard(),
        ):
            results = await signals_mod.extract_signals_from_event("stream_event/large.md")

    assert call_count["n"] == 3, f"Expected 3 LLM calls for 3 chunks, got {call_count['n']}"
    # 3 distinct target_hints → 3 signals (no dedupe)
    assert len(results) == 3, f"Expected 3 signals, got {len(results)}"

    combined = " ".join(r.message for r in caplog.records)
    assert "body_len=6000" in combined, f"body_len missing from logs: {combined!r}"
    assert "n_chunks=3" in combined, f"n_chunks missing from logs: {combined!r}"


@pytest.mark.asyncio
async def test_duplicate_signals_deduplicated() -> None:
    """Signals with the same (effect, target_hint) across chunks collapse to one."""
    import src.activities.signals as signals_mod

    large_body = "M" * (SIGNAL_BODY_CHUNK_SIZE * 3)  # exactly 3 chunks
    fake_event = _make_fake_event(large_body)
    call_count = {"n": 0}
    SAME_TARGET = "budget-matter"

    async def fake_clerk(prompt: str, raw: bool = True) -> dict[str, Any]:
        call_count["n"] += 1
        return {"signals": [_action_signal(target_hint=SAME_TARGET)]}

    async def fake_read(self: Any, path: str) -> dict[str, Any]:
        return fake_event

    async def fake_resolve(target_hint: str, target_kind_hint: str, *, client: Any) -> dict[str, Any]:
        return {"target_path": None, "target_kind": None, "target_confidence": 0.0,
                "candidates": [], "ambiguous": False}

    async def fake_noise(*a: Any, **k: Any) -> list[Any]:
        return []

    async def fake_task_create(sig: Any) -> str | None:
        return None

    with (
        patch.object(signals_mod.VaultClient, "read_record", fake_read),
        patch("src.activities.signals._pre_filter", return_value=(True, "")),
        patch("src.activities.signals._resolve_target", fake_resolve),
        patch("src.activities.clerk._call_clerk", fake_clerk),
        patch("src.activities.noise_patterns.load_active_noise_patterns", fake_noise),
        patch("src.activities.noise_patterns.load_noise_instincts", fake_noise),
        patch("src.activities.signals._load_soul_md", return_value=None),
        patch("src.activities.task_creation.create_task_from_signal", fake_task_create),
        _patch_rate_guard(),
    ):
        results = await signals_mod.extract_signals_from_event("stream_event/dup.md")

    # 3 chunks × 1 signal each, same target_hint → deduplicated to 1
    assert len(results) == 1, f"Expected 1 signal after dedupe, got {len(results)}"
    assert call_count["n"] == 3, f"Expected 3 LLM calls, got {call_count['n']}"
