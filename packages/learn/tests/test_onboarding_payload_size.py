"""Regression tests for issue #76 — onboarding activity completion payloads
must stay small enough to clear Temporal's 4 MB gRPC ``blobSizeLimit``.

The bug: a 100-day Gmail backfill writes ~5000 emails into onboard.json
(≈4.9 MB). Any activity that returns the *full* onboard dict carries that
corpus in its ``RespondActivityTaskCompleted`` message → ``ResourceExhausted``
→ Temporal retries → only a 0-email attempt's small payload commits → the
whole onboarding pipeline runs on zero data, silently (``error: null``).

The contract these tests pin:

* The email corpus is handed to downstream stages on the ``onboard.json``
  DISK side-channel — never through a Temporal activity result.
* ``composio_fetch_email_metadata`` writes the corpus to onboard.json and
  returns ONLY a tiny ``{count, domains}`` summary.
* ``init_onboard_json`` — even on a resume, when onboard.json already
  carries the corpus — returns only a tiny ``{stage, facts_count,
  patterns_count, user_id}`` summary, not the whole dict.

Unit tests with mocked Composio can't exercise the live 4 MB gRPC limit,
so these assert the *return value is small* directly — that is what the
limit actually constrains.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any
from unittest.mock import patch

from temporalio import activity
from temporalio.testing import ActivityEnvironment

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.onboarding import init_onboard_json  # noqa: E402
from src.activities import pull as pull_mod  # noqa: E402

# Temporal's default gRPC blob size limit. An activity completion payload
# above this is rejected with ResourceExhausted.
TEMPORAL_BLOB_LIMIT = 4 * 1024 * 1024

# A generous ceiling for a *summary* return value — orders of magnitude
# below the gRPC limit. A summary that ever approaches this is a bug.
SUMMARY_CEILING = 64 * 1024


def _payload_size(value: Any) -> int:
    """Approximate the serialized size of an activity return value.

    Temporal serializes activity results to JSON (the default data
    converter). ``len(json-bytes)`` is a faithful proxy for the
    ``RespondActivityTaskCompleted`` payload the 4 MB limit measures.
    """
    return len(json.dumps(value).encode("utf-8"))


def _big_corpus(n: int = 5000) -> list[dict[str, str]]:
    """A realistic ~5000-email corpus that serializes above the 4 MB gRPC
    limit — the size and shape that broke onboarding (#76).

    Gmail metadata snippets routinely run a few hundred characters; the
    snippet here is sized so the full corpus clears ``TEMPORAL_BLOB_LIMIT``,
    reproducing the real ``ResourceExhausted`` condition.
    """
    snippet = (
        "This is a representative email snippet with enough body text to "
        "make the corpus realistically large when multiplied across five "
        "thousand messages. Gmail metadata snippets commonly carry a few "
        "hundred characters of preview text per message, and the onboarding "
        "backfill keeps every one of them in onboard.json. "
    ) * 3
    return [
        {
            "from": f"sender{i}@example-domain-{i % 40}.com",
            "to": "owner@principal.example",
            "subject": f"Subject line number {i} — a representative email subject",
            "date": "Mon, 1 Jan 2026 12:00:00 +0000",
            "snippet": f"{snippet}Message ordinal {i}.",
            "domain": f"example-domain-{i % 40}.com",
        }
        for i in range(n)
    ]


# ---------------------------------------------------------------------------
# init_onboard_json — the resume path must NOT return the corpus
# ---------------------------------------------------------------------------


def test_init_onboard_json_resume_return_is_small(tmp_path: Path) -> None:
    """On a resume, onboard.json already holds the ~5000-email corpus.
    ``init_onboard_json`` must return a tiny summary — NOT the full dict.
    """
    onboard_path = str(tmp_path / "onboard.json")
    corpus = _big_corpus()
    onboard = {
        "user_id": "u1",
        "stage": "brief",
        "facts": [{"category": "general", "fact": f"fact {i}"} for i in range(120)],
        "patterns": [{"pattern": f"pattern {i}"} for i in range(30)],
        "emails": corpus,
        "top_domains": [["example-domain-0.com", 125]],
        "progress": {"current_day": 5000, "total_days": 5000},
    }
    Path(onboard_path).write_text(json.dumps(onboard))

    # Sanity: the on-disk file really does exceed the 4 MB gRPC limit —
    # this is the exact condition that broke onboarding.
    assert _payload_size(onboard) > TEMPORAL_BLOB_LIMIT

    env = ActivityEnvironment()

    @activity.defn(name="_test_init_resume")
    async def _wrapper() -> dict[str, Any]:
        return await init_onboard_json(onboard_path, "u1")

    result = asyncio.run(env.run(_wrapper))

    # The return value is a tiny summary, well under the gRPC limit.
    assert _payload_size(result) < SUMMARY_CEILING
    # It carries the resume signal the workflow needs — no corpus.
    assert result["stage"] == "brief"
    assert result["facts_count"] == 120
    assert result["patterns_count"] == 30
    assert "emails" not in result
    assert "facts" not in result
    assert "patterns" not in result

    # The corpus is preserved ON DISK — the disk side-channel downstream
    # stages read from.
    on_disk = json.loads(Path(onboard_path).read_text())
    assert len(on_disk["emails"]) == 5000
    assert len(on_disk["facts"]) == 120


def test_init_onboard_json_fresh_return_is_small(tmp_path: Path) -> None:
    """A fresh onboard.json also yields a tiny summary with zero counts."""
    onboard_path = str(tmp_path / "onboard.json")
    env = ActivityEnvironment()

    @activity.defn(name="_test_init_fresh")
    async def _wrapper() -> dict[str, Any]:
        return await init_onboard_json(onboard_path, "u1")

    result = asyncio.run(env.run(_wrapper))
    assert _payload_size(result) < SUMMARY_CEILING
    assert result["stage"] == "metadata"
    assert result["facts_count"] == 0
    assert result["patterns_count"] == 0
    assert "emails" not in result


# ---------------------------------------------------------------------------
# composio_fetch_email_metadata — corpus to disk, tiny summary returned
# ---------------------------------------------------------------------------


def test_composio_fetch_email_metadata_returns_summary_not_corpus(
    tmp_path: Path,
) -> None:
    """``composio_fetch_email_metadata`` must write the ~5000-email corpus
    to onboard.json and return ONLY a small ``{count, domains}`` summary —
    the corpus must never travel through the Temporal activity result.
    """
    onboard_path = str(tmp_path / "onboard.json")
    corpus = _big_corpus()

    # Drive _composio_gmail_pages without a live Composio call: one page
    # carrying the whole corpus, then an empty page to terminate the loop.
    pages = [list(corpus), []]

    async def _fake_pages(query, max_messages, page_size=500):  # type: ignore[no-untyped-def]
        for page in pages:
            yield page

    env = ActivityEnvironment()

    @activity.defn(name="_test_composio_fetch")
    async def _wrapper() -> dict[str, Any]:
        return await pull_mod.composio_fetch_email_metadata("u1")

    with patch.dict("os.environ", {"ONBOARD_PATH": onboard_path}), patch.object(
        pull_mod, "_composio_gmail_pages", _fake_pages
    ):
        result = asyncio.run(env.run(_wrapper))

    # The return value is a tiny summary — orders of magnitude under the
    # 4 MB gRPC limit that broke onboarding (#76).
    assert _payload_size(result) < SUMMARY_CEILING
    assert result["count"] == 5000
    assert result["domains"] > 0
    # Crucially: the corpus itself is NOT in the return value.
    assert "emails" not in result

    # The corpus landed on the onboard.json DISK side-channel — the shape
    # the behavioral profiler and the Opus stages read.
    on_disk = json.loads(Path(onboard_path).read_text())
    assert len(on_disk["emails"]) == 5000
    assert on_disk["emails"][0]["from"].startswith("sender0@")
    assert on_disk["progress"]["total_days"] == 5000
