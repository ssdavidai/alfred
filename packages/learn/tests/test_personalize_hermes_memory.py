"""Tests for personalize_opus seeding Hermes' MEMORY.md / USER.md.

Hermes' persistent memory (https://hermes-agent.nousresearch.com/docs/
user-guide/features/memory) loads MEMORY.md (~2200 char cap) and USER.md
(~1375 char cap) from ``$HERMES_HOME/memories/`` into every system prompt.
Onboarding distils them at that boundary so Alfred has the right baseline
from turn one — rather than waiting for Hermes' slow self-population.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from temporalio import activity
from temporalio.testing import ActivityEnvironment

from src.activities.onboarding_v3 import (
    _truncate_at_sentence_boundary,
    personalize_opus,
)


def _run_activity(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_test_wrapper")
    async def _wrapper() -> dict:
        return await coro_factory()

    return asyncio.run(env.run(_wrapper))


def _write_onboard(tmp_path: Path) -> str:
    path = tmp_path / "onboard.json"
    path.write_text(json.dumps({
        "facts": [{"category": "professional", "fact": "Runs Example LLC",
                   "confidence": "high"}],
        "patterns": [{"name": "tuesday-reviews", "description": "Stripe stats"}],
    }))
    return str(path)


def _make_response(status_code: int, text: str = ""):
    return type("R", (), {"status_code": status_code, "text": text,
                          "is_success": 200 <= status_code < 300})()


def _mock_client(response):
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None
    client.put = AsyncMock(return_value=response)
    return client


_BASE_FILES = {
    "user_md": "# User Profile\n\nSir runs Example LLC.",
    "soul_md": "# Alfred's Soul\n\nAddress him as Sir.",
    "memory_md": "# Memory Index\n\n[[Sam Lee]] partner.",
    "tools_md": "# Suggested Tools\n\nWeekly Stripe digest.",
    "rules_md": "# Standing Rules\n\n- Protect quiet hours.",
}


def _opus_response(memory_md: str, user_md: str) -> str:
    return json.dumps({**_BASE_FILES,
                       "hermes_memory_md": memory_md,
                       "hermes_user_md": user_md})


def _run_with_mocks(onboard, raw, *, exists_fn=None):
    """Wire patches around a personalize_opus run, capturing every
    Path.write_text call by path → content. Returns (result, written)."""
    client = _mock_client(_make_response(200, '{"ok":true}'))
    written: dict[str, str] = {}

    def _fake_write(self, content, *args, **kwargs):
        written[str(self)] = content

    exists_patch = (patch("pathlib.Path.exists", new=exists_fn)
                    if exists_fn is not None
                    else patch("pathlib.Path.exists", return_value=True))

    with patch("src.activities.onboarding_v3._call_llm",
               new=AsyncMock(return_value=raw)), \
         patch("httpx.AsyncClient", return_value=client), \
         exists_patch, \
         patch("pathlib.Path.mkdir", return_value=None), \
         patch("pathlib.Path.write_text", new=_fake_write):
        result = _run_activity(lambda: personalize_opus(onboard))
    return result, written, client


class TestPersonalizeHermesMemorySeed:
    """personalize_opus seeds Hermes' persistent memory files."""

    def test_parses_both_new_keys_and_writes_direct(self, tmp_path, monkeypatch):
        """Test #1: Opus response is parsed for BOTH hermes_memory_md and
        hermes_user_md, and they land at /hermes-state/memories/."""
        monkeypatch.setenv("AAS_API_KEY", "t")
        memory = "David Szabo-Stuban (Sir): Hungarian founder."
        user = ("Tone: concise, no theatrical enthusiasm. Languages: "
                "English primary, Hungarian preserved for legal/admin.")
        result, written, _ = _run_with_mocks(
            _write_onboard(tmp_path), _opus_response(memory, user),
        )
        assert "/hermes-state/memories/MEMORY.md" in written
        assert "/hermes-state/memories/USER.md" in written
        assert written["/hermes-state/memories/MEMORY.md"] == memory
        assert written["/hermes-state/memories/USER.md"] == user
        assert "hermes/MEMORY.md" in result["files_written"]
        assert "hermes/USER.md" in result["files_written"]

    def test_memory_over_cap_truncated_at_sentence(
        self, tmp_path, monkeypatch, caplog,
    ):
        """Test #2: a >2200-char hermes_memory_md is truncated at the
        last full sentence that fits; a log line is emitted."""
        monkeypatch.setenv("AAS_API_KEY", "t")
        sentence = "Sir runs Example LLC and lives in Budapest. "
        long_memory = (sentence * 70).strip()
        assert len(long_memory) > 2200
        with caplog.at_level("INFO", logger="alfred-learn"):
            _, written, _ = _run_with_mocks(
                _write_onboard(tmp_path),
                _opus_response(long_memory, "Tone: concise."),
            )
        seed = written["/hermes-state/memories/MEMORY.md"]
        assert len(seed) <= 2200
        assert seed.endswith(".") or seed.endswith(".\n")
        assert any("hermes_memory_md truncated" in r.message
                   for r in caplog.records)

    def test_user_over_cap_truncated_at_sentence(
        self, tmp_path, monkeypatch, caplog,
    ):
        """Test #3: same contract on USER.md with the 1375-char cap."""
        monkeypatch.setenv("AAS_API_KEY", "t")
        sentence = "Tone preference: concise, no theatrical enthusiasm. "
        long_user = (sentence * 40).strip()
        assert len(long_user) > 1375
        with caplog.at_level("INFO", logger="alfred-learn"):
            _, written, _ = _run_with_mocks(
                _write_onboard(tmp_path),
                _opus_response("Sir: founder.", long_user),
            )
        seed = written["/hermes-state/memories/USER.md"]
        assert len(seed) <= 1375
        assert seed.endswith(".") or seed.endswith(".\n")
        assert any("hermes_user_md truncated" in r.message
                   for r in caplog.records)

    def test_falls_back_to_alfred_data_when_hermes_state_missing(
        self, tmp_path, monkeypatch, caplog,
    ):
        """Test #4: when /hermes-state is not reachable, seed is staged
        under /alfred-data/ with a supervisor handoff log line."""
        monkeypatch.setenv("AAS_API_KEY", "t")

        def _no_hermes(self):
            return not str(self).startswith("/hermes-state")

        with caplog.at_level("INFO", logger="alfred-learn"):
            result, written, _ = _run_with_mocks(
                _write_onboard(tmp_path),
                _opus_response("Sir: founder.", "Tone: concise."),
                exists_fn=_no_hermes,
            )
        assert "/alfred-data/hermes_seed_memory.md" in written
        assert "/alfred-data/hermes_seed_user.md" in written
        assert not any(p.startswith("/hermes-state") for p in written)
        assert any("seeded hermes memory in /alfred-data" in r.message
                   for r in caplog.records)
        assert "alfred-data/hermes_seed_memory.md" in result["files_written"]

    def test_existing_five_workspace_writes_still_run(
        self, tmp_path, monkeypatch,
    ):
        """Test #5a: backwards-compat — the existing 5 workspace writes
        still happen exactly once each. The Hermes seed is additive."""
        monkeypatch.setenv("AAS_API_KEY", "t")
        result, _, client = _run_with_mocks(
            _write_onboard(tmp_path),
            _opus_response("Sir: founder.", "Tone: concise."),
        )
        for name in ("USER.md", "SOUL.md", "MEMORY.md",
                     "TOOLS.md", "RULES.md"):
            assert name in result["files_written"], f"regressed: {name}"
        assert client.put.await_count == 5

    def test_missing_hermes_keys_does_not_crash(self, tmp_path, monkeypatch):
        """Test #5b: backwards-compat — if Opus omits the new keys
        entirely, the activity completes successfully without seeding."""
        monkeypatch.setenv("AAS_API_KEY", "t")
        result, _, _ = _run_with_mocks(
            _write_onboard(tmp_path), json.dumps(_BASE_FILES),
        )
        five = [f for f in result["files_written"]
                if f.endswith(".md") and "/" not in f]
        assert sorted(five) == ["MEMORY.md", "RULES.md", "SOUL.md",
                                "TOOLS.md", "USER.md"]
        assert not any("hermes" in f.lower()
                       for f in result["files_written"])


class TestTruncateAtSentenceBoundary:
    """Helper must keep the LAST sentence boundary in ``[0.85*cap, cap]``.

    Regression: the old helper iterated terminators by kind and returned
    on the FIRST kind ``rfind`` matched. For a bullet-form USER.md where
    only line 1 ended with ``.\\n``, it collapsed 1407 chars to 53.
    """

    def test_truncate_under_cap_returns_as_is(self):
        text = "x" * 1000
        assert _truncate_at_sentence_boundary(text, 1375) == text

    def test_truncate_just_over_cap_keeps_late_sentence_boundary(self):
        """Live bug: one early boundary (~53) + several late (>1169).
        Helper must keep a LATE one, NOT collapse to 53."""
        text = ("Tone: concise, high-signal, no theatrical enthusiasm. "
                + "a" * 740 + ". "    # ~800
                + "b" * 390 + ". "    # ~1200
                + "c" * 130 + ". "    # ~1340 (in-window)
                + "d" * 70)
        assert text[52] == "." and len(text) > 1375
        out = _truncate_at_sentence_boundary(text, 1375)
        assert len(out) > 100, f"regressed to early boundary: {len(out)}"
        assert int(1375 * 0.85) <= len(out) <= 1375
        assert out.endswith(".")

    def test_truncate_no_late_boundary_falls_back_to_hard_cap(self):
        """No boundary in [1169,1375] → hard-cap at 1374 + ``…``."""
        early = "Tone: concise, high-signal, no theatrical enthusiasm."
        body = "\n".join("- " + ("x" * 20) for _ in range(60))
        text = (early + "\n" + body + ("x" * 1407))[:1407]
        out = _truncate_at_sentence_boundary(text, 1375)
        assert len(out) == 1375 and out.endswith("…")

    def test_truncate_memory_md_cap_2200(self):
        """Same logic at the 2200-char MEMORY.md cap. Floor = 1870."""
        text = ("a" * 79 + ". " + "b" * 1400 + ". "
                + "c" * 640 + ". " + "d" * 200)  # late ~2150
        out = _truncate_at_sentence_boundary(text, 2200)
        assert int(2200 * 0.85) <= len(out) <= 2200
        assert out.endswith(".")

    @pytest.mark.parametrize("cap,floor", [(100, 85), (1375, 1168), (2200, 1870)])
    def test_truncate_floor_85_percent(self, cap, floor):
        """Boundary below floor → ellipsis. Above floor → accepted."""
        below = "x" * (floor - 2) + ". " + "y" * cap * 2
        out_below = _truncate_at_sentence_boundary(below, cap)
        assert len(out_below) == cap and out_below.endswith("…")
        above = "x" * (floor + 4) + ". " + "y" * cap * 2
        out_above = _truncate_at_sentence_boundary(above, cap)
        assert floor <= len(out_above) <= cap and out_above.endswith(".")

    def test_truncate_logs_path_hint(self, tmp_path, monkeypatch, caplog):
        """Log distinguishes ``sentence-boundary`` from
        ``hard-truncate-with-ellipsis`` so a regression is diagnosable."""
        monkeypatch.setenv("AAS_API_KEY", "t")
        early = "Tone: concise, high-signal, no theatrical enthusiasm."
        body = "\n".join("- " + ("x" * 20) for _ in range(60))
        long_user = (early + "\n" + body + ("x" * 1407))[:1407]
        with caplog.at_level("INFO", logger="alfred-learn"):
            _, written, _ = _run_with_mocks(
                _write_onboard(tmp_path),
                _opus_response("Sir: founder.", long_user),
            )
        seed = written["/hermes-state/memories/USER.md"]
        assert len(seed) == 1375 and seed.endswith("…")
        log_text = " ".join(r.message for r in caplog.records)
        assert "hermes_user_md truncated" in log_text
        assert "hard-truncate-with-ellipsis" in log_text
