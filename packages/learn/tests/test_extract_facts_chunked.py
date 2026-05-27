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

Plus (#83, incremental persistence):
  * each chunk's result is persisted to ``onboard["facts_partial"]``
    BEFORE the next chunk runs — so a Temporal activity timeout in
    chunk N+1 doesn't discard chunks 1..N's LLM work on the retry.
  * on retry, chunks whose fingerprint is already in ``facts_partial``
    are SKIPPED — no LLM call, the cached facts are merged in.
  * ``facts_partial`` is cleared from ``onboard.json`` once the stage
    completes successfully (no stale scratch on the next re-onboard).
  * a chunk that fails its LLM call is NOT persisted to
    ``facts_partial`` — the retry MUST re-attempt it.
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


# --------------------------------------------------------- #83 incremental
# Issue #83: a Temporal activity-level timeout during chunk N discarded
# ALL chunks' work on retry. These tests pin the incremental-persistence
# contract that fixes that wedge.


def test_facts_partial_persists_after_each_chunk(tmp_path, monkeypatch) -> None:
    """After every per-chunk LLM call returns, ``onboard["facts_partial"]``
    is updated AND the file is rewritten — so a kill BETWEEN chunks
    leaves chunks 1..N-1's work durable on disk."""
    from src.activities.onboarding_v3 import extract_facts_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard_path = _seed_onboard(tmp_path, n_emails=801)  # 3 chunks

    # Snapshot the file after each _call_llm return so we can assert
    # facts_partial grew monotonically.
    snapshots: list[dict[str, Any]] = []

    def _record_snapshot(*_a, **_kw):
        # Re-read the file directly from disk, NOT the in-memory dict —
        # we are testing durability.
        try:
            snapshots.append(json.loads(Path(onboard_path).read_text()))
        except Exception:  # noqa: BLE001 — best-effort snapshot
            snapshots.append({})

    per_chunk = _facts_response(
        facts=[{"category": "p", "fact": "f", "confidence": "high"}],
        identity=[{"field": "name", "value": "J", "display": "F"}],
    )
    synth = json.dumps({"key_identity_facts": [
        {"field": "name", "value": "J", "display": "F"},
    ]})

    # Capture a snapshot every time _call_llm is invoked — BEFORE the
    # next call we want to see the previous chunk's partial already on
    # disk.
    seq = [per_chunk, per_chunk, per_chunk, synth]
    call_idx = {"i": 0}

    async def _mock_call(*_a, **_kw):
        # Snapshot the file BEFORE this call, then return next response.
        _record_snapshot()
        r = seq[call_idx["i"]]
        call_idx["i"] += 1
        return r

    with patch("src.activities.onboarding_v3._call_llm", new=_mock_call):
        _run(lambda: extract_facts_opus(onboard_path))

    # Snapshots in order: before chunk 1, before chunk 2, before chunk 3,
    # before synthesis. Pre-chunk-2 snapshot must contain chunk 1's
    # partial; pre-chunk-3 must contain chunks 1 + 2.
    assert len(snapshots) >= 3
    pre_chunk1 = snapshots[0].get("facts_partial") or {}
    pre_chunk2 = snapshots[1].get("facts_partial") or {}
    pre_chunk3 = snapshots[2].get("facts_partial") or {}
    assert len(pre_chunk1) == 0
    assert len(pre_chunk2) == 1
    assert len(pre_chunk3) == 2

    # Final file: facts_partial wiped after the successful run.
    final = json.loads(Path(onboard_path).read_text())
    assert "facts_partial" not in final or final["facts_partial"] in (
        {}, None
    )


def test_resume_skips_chunks_with_cached_partials(
    tmp_path, monkeypatch,
) -> None:
    """If ``onboard["facts_partial"]`` already holds chunks 1 + 2 at
    activity entry, only chunk 3 (and the synthesis pass) call the LLM."""
    from src.activities._email_sampling import chunk_emails_for_extraction
    from src.activities.onboarding_v3 import (
        _chunk_fingerprint,
        extract_facts_opus,
    )

    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard_path = _seed_onboard(tmp_path, n_emails=801)  # 3 chunks

    # Pre-seed facts_partial with chunks 1 and 2 (simulating a prior
    # activity attempt that durably persisted those before timing out
    # mid-chunk-3).
    emails = [_email(i) for i in range(801)]
    chunks = chunk_emails_for_extraction(emails)
    assert len(chunks) == 3
    cached_partials = {
        _chunk_fingerprint(chunks[0]): {
            "facts": [{"category": "p", "fact": "cached A",
                       "confidence": "high"}],
            "identity": [{"field": "name", "value": "A", "display": "F"}],
            "n_emails": len(chunks[0]),
            "ts": "2026-05-27T15:00:00+00:00",
        },
        _chunk_fingerprint(chunks[1]): {
            "facts": [{"category": "p", "fact": "cached B",
                       "confidence": "high"}],
            "identity": [{"field": "name", "value": "B", "display": "F"}],
            "n_emails": len(chunks[1]),
            "ts": "2026-05-27T15:05:00+00:00",
        },
    }
    data = json.loads(Path(onboard_path).read_text())
    data["facts_partial"] = cached_partials
    Path(onboard_path).write_text(json.dumps(data))

    fresh_chunk3 = _facts_response(
        facts=[{"category": "p", "fact": "fresh C", "confidence": "high"}],
        identity=[{"field": "name", "value": "C", "display": "F"}],
    )
    synth = json.dumps({"key_identity_facts": [
        {"field": "name", "value": "A", "display": "F"},
    ]})
    mock = AsyncMock(side_effect=[fresh_chunk3, synth])
    with patch("src.activities.onboarding_v3._call_llm", new=mock):
        _run(lambda: extract_facts_opus(onboard_path))

    # Only TWO LLM calls — chunk 3 + synthesis. Chunks 1+2 were resumed.
    assert mock.await_count == 2

    # All three chunks' facts are present in the final result.
    final = json.loads(Path(onboard_path).read_text())
    fact_texts = {f["fact"] for f in final["facts"]}
    assert fact_texts == {"cached A", "cached B", "fresh C"}


def test_chunk_failure_does_not_poison_facts_partial(
    tmp_path, monkeypatch,
) -> None:
    """A chunk whose LLM call RAISES is NOT persisted to facts_partial —
    the retry must re-attempt it. Surviving chunks ARE persisted."""
    from src.activities.onboarding_v3 import extract_facts_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard_path = _seed_onboard(tmp_path, n_emails=801)  # 3 chunks

    # Intercept facts_partial state at the moment the failing chunk
    # raises. We read it FROM DISK between calls.
    seen_partial_sizes: list[int] = []

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

    seq: list[Any] = [a, RuntimeError("transient hermes 5xx"), c, synth]
    call_idx = {"i": 0}

    async def _mock_call(*_a, **_kw):
        # Read facts_partial size BEFORE returning this call's result.
        try:
            d = json.loads(Path(onboard_path).read_text())
            seen_partial_sizes.append(len(d.get("facts_partial") or {}))
        except Exception:  # noqa: BLE001
            seen_partial_sizes.append(-1)
        item = seq[call_idx["i"]]
        call_idx["i"] += 1
        if isinstance(item, Exception):
            raise item
        return item

    with patch("src.activities.onboarding_v3._call_llm", new=_mock_call):
        _run(lambda: extract_facts_opus(onboard_path))

    # Sequence of facts_partial sizes seen BEFORE each LLM call:
    #   chunk 1 → 0 (empty)
    #   chunk 2 → 1 (chunk 1 persisted)
    #   chunk 3 → 1 (chunk 2 FAILED, NOT persisted)
    #   synth   → 2 (chunk 3 persisted)
    assert seen_partial_sizes[0] == 0
    assert seen_partial_sizes[1] == 1
    # Chunk 2 raised → still 1 (the failed chunk MUST not poison the cache).
    assert seen_partial_sizes[2] == 1
    assert seen_partial_sizes[3] == 2

    # Final output merges chunks 1 + 3, drops chunk 2, NOT degraded.
    final = json.loads(Path(onboard_path).read_text())
    fact_texts = {f["fact"] for f in final["facts"]}
    assert fact_texts == {"fact A", "fact C"}
    assert "facts" not in final.get("degraded_stages", [])
    # And facts_partial is cleared at end-of-stage.
    assert not final.get("facts_partial")


def test_resume_with_all_chunks_cached_makes_no_chunk_llm_calls(
    tmp_path, monkeypatch,
) -> None:
    """If every chunk's fingerprint is already in facts_partial, the
    per-chunk extraction loop makes ZERO LLM calls — only the identity
    synthesis pass runs (multi-chunk only)."""
    from src.activities._email_sampling import chunk_emails_for_extraction
    from src.activities.onboarding_v3 import (
        _chunk_fingerprint,
        extract_facts_opus,
    )

    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard_path = _seed_onboard(tmp_path, n_emails=801)  # 3 chunks

    emails = [_email(i) for i in range(801)]
    chunks = chunk_emails_for_extraction(emails)
    cached = {
        _chunk_fingerprint(c): {
            "facts": [{"category": "p", "fact": f"cached {i}",
                       "confidence": "high"}],
            "identity": [{"field": "name", "value": f"C{i}",
                          "display": "F"}],
            "n_emails": len(c),
            "ts": "2026-05-27T15:00:00+00:00",
        } for i, c in enumerate(chunks)
    }
    data = json.loads(Path(onboard_path).read_text())
    data["facts_partial"] = cached
    Path(onboard_path).write_text(json.dumps(data))

    synth = json.dumps({"key_identity_facts": [
        {"field": "name", "value": "C0", "display": "F"},
    ]})
    mock = AsyncMock(side_effect=[synth])
    with patch("src.activities.onboarding_v3._call_llm", new=mock):
        _run(lambda: extract_facts_opus(onboard_path))

    # Only the synthesis pass — zero per-chunk LLM calls.
    assert mock.await_count == 1

    final = json.loads(Path(onboard_path).read_text())
    fact_texts = {f["fact"] for f in final["facts"]}
    assert fact_texts == {"cached 0", "cached 1", "cached 2"}


def test_corrupt_facts_partial_is_ignored(tmp_path, monkeypatch) -> None:
    """A facts_partial that isn't a dict (corrupted) is silently ignored —
    the activity recomputes from scratch and rewrites the field with a
    valid dict shape."""
    from src.activities.onboarding_v3 import extract_facts_opus
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard_path = _seed_onboard(tmp_path, n_emails=801)  # 3 chunks

    data = json.loads(Path(onboard_path).read_text())
    data["facts_partial"] = "this is not a dict"  # corrupt shape
    Path(onboard_path).write_text(json.dumps(data))

    per_chunk = _facts_response(
        facts=[{"category": "p", "fact": "f", "confidence": "high"}],
        identity=[{"field": "name", "value": "J", "display": "F"}],
    )
    synth = json.dumps({"key_identity_facts": [
        {"field": "name", "value": "J", "display": "F"},
    ]})
    mock = AsyncMock(side_effect=[per_chunk, per_chunk, per_chunk, synth])
    with patch("src.activities.onboarding_v3._call_llm", new=mock):
        _run(lambda: extract_facts_opus(onboard_path))

    # All 3 chunks called (cache was unusable) + 1 synth.
    assert mock.await_count == 4
    final = json.loads(Path(onboard_path).read_text())
    # Cleanup wiped the field at end-of-stage.
    assert not final.get("facts_partial")


def test_chunk_fingerprint_is_stable_and_distinguishing() -> None:
    """The fingerprint is content-stable (same chunk → same hash) AND
    distinguishing (different chunks → different hash). This is the
    idempotency-key contract."""
    from src.activities.onboarding_v3 import _chunk_fingerprint

    a = [_email(1), _email(2), _email(3)]
    b = [_email(1), _email(2), _email(3)]  # same content
    c = [_email(1), _email(2), _email(4)]  # one email differs
    d = [_email(2), _email(1), _email(3)]  # same content, REORDERED

    assert _chunk_fingerprint(a) == _chunk_fingerprint(b)
    assert _chunk_fingerprint(a) != _chunk_fingerprint(c)
    # Order matters: the chunker is deterministic, so a reorder would
    # represent a real chunk-shape change.
    assert _chunk_fingerprint(a) != _chunk_fingerprint(d)
    # Empty chunk has a stable fingerprint too (SHA of empty input).
    assert _chunk_fingerprint([]) == _chunk_fingerprint([])
