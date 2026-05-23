"""Chunked fact extraction for the onboarding ``extract_facts_opus`` stage.

Lane II / harden, 2026-05-23. Even after per-day sampling cut the
corpus to ~1614 emails, the single-call prompt to heavy Hermes still
overflowed the model's context window — Hermes returned the literal
string ``"Context length exceeded: max compression attempts (3)
reached."`` and the stage degraded with 0 facts.

The fix is structural, not parametric: split the email corpus into
chunks below threshold, run extraction per chunk, merge + dedup. Any
future model-context-window change just rescales the chunk size; the
pipeline shape stays correct.

These tests pin the contract:
  * under-threshold corpora STAY single-call (no behaviour change).
  * over-threshold corpora chunk deterministically into 400s.
  * a per-chunk LLM call failure is tolerated; the others still merge.
  * if ALL chunks come back empty, the stage is marked degraded.
  * identity facts undergo a SECOND (cheap) synthesis pass over the
    candidate pool — never extracted from raw emails-in-one-shot.
  * heartbeats are emitted per chunk (Temporal needs that liveness
    signal — a 5-min sequence of chunks otherwise looks stalled).
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from temporalio import activity
from temporalio.testing import ActivityEnvironment

from src.activities._email_sampling import (
    _CHUNK_SIZE,
    _CHUNK_THRESHOLD,
    chunk_emails_for_extraction,
)


# --------------------------------------------------------------------- helpers


def _email(idx: int, date: str = "2026-05-23") -> dict[str, Any]:
    return {
        "from": f"sender{idx}@example.com",
        "to": "me@example.com",
        "subject": f"subject {idx}",
        "date": date,
        "snippet": f"snippet {idx}",
        "domain": "example.com",
    }


def _seed_onboard(tmp_path: Path, n_emails: int) -> str:
    """Seed an onboard.json with ``n_emails`` distinct emails."""
    path = tmp_path / "onboard.json"
    emails = [_email(i) for i in range(n_emails)]
    path.write_text(json.dumps({
        "user_id": "u-1",
        "stage": "metadata",
        "progress": {"current_day": 0, "total_days": 0,
                     "facts_count": 0, "patterns_count": 0},
        "emails": emails,
        "facts": [],
        "key_identity_facts": [],
    }))
    return str(path)


def _run(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_wrap")
    async def _wrapper() -> Any:
        return await coro_factory()

    return asyncio.run(env.run(_wrapper))


def _facts_response(facts: list[dict], identity: list[dict]) -> str:
    return json.dumps({"facts": facts, "key_identity_facts": identity})


# --------------------------------------------------------------------- chunker


def test_chunker_under_threshold_returns_single_chunk() -> None:
    """``len(emails) <= threshold`` → exactly one chunk = all emails."""
    emails = [_email(i) for i in range(_CHUNK_THRESHOLD)]
    chunks = chunk_emails_for_extraction(emails)
    assert len(chunks) == 1
    assert chunks[0] == emails


def test_chunker_above_threshold_chunks_into_size() -> None:
    """1614 emails → ⌈1614/400⌉ = 5 chunks (400, 400, 400, 400, 14)."""
    emails = [_email(i) for i in range(1614)]
    chunks = chunk_emails_for_extraction(emails)
    assert len(chunks) == 5
    assert [len(c) for c in chunks] == [400, 400, 400, 400, 14]


def test_chunker_preserves_order_newest_first() -> None:
    """First chunk holds the newest emails; last chunk holds the oldest."""
    emails = [_email(i) for i in range(1614)]
    chunks = chunk_emails_for_extraction(emails)
    # First chunk: the first 400 inputs (input order preserved).
    assert chunks[0][0]["subject"] == "subject 0"
    assert chunks[0][-1]["subject"] == "subject 399"
    # Last chunk: the remaining 14 oldest (positions 1600..1613).
    assert chunks[-1][0]["subject"] == "subject 1600"
    assert chunks[-1][-1]["subject"] == "subject 1613"


def test_chunker_empty_returns_empty() -> None:
    """No emails → no chunks (caller can short-circuit)."""
    assert chunk_emails_for_extraction([]) == []


# --------------------------------------------------------- single-call path


def test_under_threshold_runs_single_call(tmp_path, monkeypatch) -> None:
    """≤ threshold → exactly 1 ``_call_llm`` call; identity facts taken
    directly from that response (no synthesis pass)."""
    from src.activities.onboarding_v3 import extract_facts_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path, n_emails=300)

    response = _facts_response(
        facts=[{"category": "personal", "fact": "Has a dog named Biscuit",
                "confidence": "high"}],
        identity=[{"field": "name", "value": "Jane", "display": "Full name"}],
    )
    mock = AsyncMock(return_value=response)
    with patch("src.activities.onboarding_v3._call_llm", new=mock):
        _run(lambda: extract_facts_opus(onboard))

    assert mock.await_count == 1
    data = json.loads(Path(onboard).read_text())
    assert data["facts"] == [
        {"category": "personal", "fact": "Has a dog named Biscuit",
         "confidence": "high"},
    ]
    assert data["key_identity_facts"] == [
        {"field": "name", "value": "Jane", "display": "Full name"},
    ]


# --------------------------------------------------------- multi-chunk path


def test_above_threshold_chunks_into_400s(tmp_path, monkeypatch) -> None:
    """1614 emails → 5 per-chunk calls + 1 identity-synthesis call = 6."""
    from src.activities.onboarding_v3 import extract_facts_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path, n_emails=1614)

    per_chunk = _facts_response(
        facts=[{"category": "personal", "fact": "f", "confidence": "high"}],
        identity=[{"field": "name", "value": "Jane", "display": "Full name"}],
    )
    mock = AsyncMock(return_value=per_chunk)
    with patch("src.activities.onboarding_v3._call_llm", new=mock):
        _run(lambda: extract_facts_opus(onboard))

    # 5 chunk extractions + 1 identity synthesis pass = 6 calls.
    assert mock.await_count == 6


def test_chunks_merge_dedup_string_equal(tmp_path, monkeypatch) -> None:
    """Two chunks share a fact; merged output keeps each unique string once
    (case-insensitive, whitespace-collapsed)."""
    from src.activities.onboarding_v3 import extract_facts_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path, n_emails=801)  # → 3 chunks (400/400/1)

    chunk_a = _facts_response(
        facts=[
            {"category": "professional", "fact": "X works at NeoTerra",
             "confidence": "high"},
            {"category": "personal", "fact": "X lives in Lisbon",
             "confidence": "high"},
        ],
        identity=[{"field": "company", "value": "NeoTerra", "display": "Co"}],
    )
    chunk_b = _facts_response(
        facts=[
            {"category": "professional", "fact": "x works at neoterra",
             "confidence": "high"},
        ],
        identity=[{"field": "company", "value": "NeoTerra", "display": "Co"}],
    )
    chunk_c = _facts_response(facts=[], identity=[])
    synth = json.dumps({"key_identity_facts": [
        {"field": "company", "value": "NeoTerra", "display": "Co"},
    ]})
    mock = AsyncMock(side_effect=[chunk_a, chunk_b, chunk_c, synth])
    with patch("src.activities.onboarding_v3._call_llm", new=mock):
        _run(lambda: extract_facts_opus(onboard))

    data = json.loads(Path(onboard).read_text())
    fact_texts = [f.get("fact", "").lower().strip() for f in data["facts"]]
    # Both unique facts present; the duplicate of "works at neoterra" gone.
    assert "x works at neoterra" in fact_texts
    assert "x lives in lisbon" in fact_texts
    assert fact_texts.count("x works at neoterra") == 1


def test_one_chunk_fails_others_succeed(tmp_path, monkeypatch) -> None:
    """Chunk 2 of 3 raises; final facts = chunks 1 + 3 merged; NOT degraded."""
    from src.activities.onboarding_v3 import extract_facts_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path, n_emails=801)  # 3 chunks

    a = _facts_response(
        facts=[{"category": "p", "fact": "fact A", "confidence": "high"}],
        identity=[{"field": "name", "value": "A", "display": "F"}],
    )
    c = _facts_response(
        facts=[{"category": "p", "fact": "fact C", "confidence": "high"}],
        identity=[{"field": "name", "value": "C", "display": "F"}],
    )
    synth = json.dumps({"key_identity_facts": [
        {"field": "name", "value": "A", "display": "F"},
    ]})

    seq: list[Any] = [a, RuntimeError("hermes 402 on chunk 2"), c, synth]
    mock = AsyncMock(side_effect=seq)
    with patch("src.activities.onboarding_v3._call_llm", new=mock):
        _run(lambda: extract_facts_opus(onboard))

    data = json.loads(Path(onboard).read_text())
    fact_texts = {f["fact"] for f in data["facts"]}
    assert fact_texts == {"fact A", "fact C"}
    # Partial success → NOT marked degraded.
    assert "facts" not in data.get("degraded_stages", [])


def test_all_chunks_fail_marks_degraded(tmp_path, monkeypatch) -> None:
    """Every chunk yields zero facts → stage marked degraded (empty-parse)."""
    from src.activities.onboarding_v3 import extract_facts_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path, n_emails=801)  # 3 chunks

    nothing = _facts_response(facts=[], identity=[])
    mock = AsyncMock(side_effect=[nothing, nothing, nothing])
    with patch("src.activities.onboarding_v3._call_llm", new=mock):
        _run(lambda: extract_facts_opus(onboard))

    data = json.loads(Path(onboard).read_text())
    assert "facts" in data.get("degraded_stages", [])


def test_identity_facts_synthesis_pass(tmp_path, monkeypatch) -> None:
    """30 candidate identity facts across chunks → final synthesis call
    asked to pick 8-12; mocked to return 10; final list = those 10."""
    from src.activities.onboarding_v3 import extract_facts_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path, n_emails=801)  # 3 chunks

    def chunk_resp(start: int) -> str:
        return _facts_response(
            facts=[{"category": "p", "fact": f"f{start}",
                    "confidence": "high"}],
            identity=[
                {"field": f"f{start+i}", "value": f"v{start+i}",
                 "display": f"d{start+i}"} for i in range(10)
            ],
        )

    final_identity = [
        {"field": f"final{i}", "value": f"v{i}", "display": f"d{i}"}
        for i in range(10)
    ]
    synth_resp = json.dumps({"key_identity_facts": final_identity})

    mock = AsyncMock(side_effect=[
        chunk_resp(0), chunk_resp(10), chunk_resp(20), synth_resp,
    ])
    with patch("src.activities.onboarding_v3._call_llm", new=mock):
        _run(lambda: extract_facts_opus(onboard))

    data = json.loads(Path(onboard).read_text())
    assert data["key_identity_facts"] == final_identity
    # Synthesis pass got the candidate pool, NOT raw emails (cheap input).
    synth_call_kwargs = mock.call_args_list[-1]
    args = synth_call_kwargs.args
    kwargs = synth_call_kwargs.kwargs
    prompt_text = args[0] if args else kwargs.get("prompt", "")
    # Every candidate-pool entry should appear in the synthesis prompt.
    for i in range(30):
        assert f"f{i}" in prompt_text or f"v{i}" in prompt_text


def test_heartbeat_emitted_per_chunk(tmp_path, monkeypatch) -> None:
    """``activity.heartbeat`` is called at least once per chunk with a
    chunk-progress message (Temporal liveness signal)."""
    from src.activities.onboarding_v3 import extract_facts_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _seed_onboard(tmp_path, n_emails=1201)  # 4 chunks

    per_chunk = _facts_response(
        facts=[{"category": "p", "fact": "f", "confidence": "high"}],
        identity=[{"field": "name", "value": "J", "display": "F"}],
    )
    synth_resp = json.dumps({"key_identity_facts": [
        {"field": "name", "value": "J", "display": "F"},
    ]})

    hb_messages: list[str] = []

    def _record_heartbeat(*args, **_kwargs):
        if args:
            hb_messages.append(str(args[0]))

    mock = AsyncMock(side_effect=[per_chunk] * 4 + [synth_resp])
    with patch("src.activities.onboarding_v3._call_llm", new=mock), \
            patch("src.activities.onboarding_v3.activity.heartbeat",
                  side_effect=_record_heartbeat):
        _run(lambda: extract_facts_opus(onboard))

    # At least one heartbeat references each of the 4 chunks.
    chunk_hbs = [m for m in hb_messages if "chunk" in m.lower()]
    assert len(chunk_hbs) >= 4
    # Messages should be informative (carry the chunk index).
    joined = " | ".join(chunk_hbs).lower()
    for i in range(1, 5):
        assert f"{i}/4" in joined or f"chunk {i}" in joined
