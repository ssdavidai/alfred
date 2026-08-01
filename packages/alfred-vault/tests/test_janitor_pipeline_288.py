"""#288 L3/L4 — janitor repairs apply in Python, never via agent CLI.

The agentic stages previously instructed the LLM to run `alfred vault
edit` — a CLI that does not exist in the agent's container — so no
ambiguous link repair or enrichment EVER landed (zsolt incident
2026-07-15: failed repairs re-queued every sweep and spammed Slack).
The agent now returns JSON; the janitor applies it deterministically.
"""
from __future__ import annotations

import asyncio

import pytest

from alfred.janitor import pipeline as pl
from alfred.janitor.issues import Issue


class TestParseLlmJson:
    def test_pure_json(self):
        assert pl._parse_llm_json('{"chosen": "person/Jane Doe"}') == {
            "chosen": "person/Jane Doe"
        }

    def test_fenced_and_prosed(self):
        raw = 'Sure!\n```json\n{"chosen": null}\n```\nDone.'
        assert pl._parse_llm_json(raw) == {"chosen": None}

    def test_garbage_is_empty(self):
        assert pl._parse_llm_json("I edited the file for you") == {}
        assert pl._parse_llm_json("") == {}


class TestStage2ChoiceApplication:
    def _run(self, monkeypatch, tmp_path, llm_reply):
        vault = tmp_path
        (vault / "note").mkdir()
        (vault / "person").mkdir()
        f = vault / "note" / "n.md"
        f.write_text("---\ntype: note\n---\nsee [[Jane Do]]\n")
        (vault / "person" / "Jane Doe.md").write_text("---\ntype: person\n---\nx")
        (vault / "person" / "Janet Doeman.md").write_text("---\ntype: person\n---\ny")

        class _Cfg:
            class vault:  # noqa: N801
                vault_path = vault
                ignore_dirs = []

        applied = []
        monkeypatch.setattr(
            pl, "_load_stage_prompt", lambda name: "prompt {file_path} {broken_target} {candidates} {candidate_names}"
        )
        monkeypatch.setattr(
            pl, "_find_link_candidates",
            lambda *a, **k: [
                {"name": "person/Jane Doe", "path": "person/Jane Doe.md"},
                {"name": "person/Janet Doeman", "path": "person/Janet Doeman.md"},
            ],
        )
        monkeypatch.setattr(pl, "_is_unambiguous_match", lambda *a: None)

        async def fake_llm(prompt, config, session_path, label):
            return llm_reply

        monkeypatch.setattr(pl, "_call_llm", fake_llm)
        monkeypatch.setattr(
            pl, "_fix_link_in_python",
            lambda file, old, new, vp, sp: applied.append((file, old, new)) or True,
        )
        issue = Issue(file="note/n.md", code="LINK001",
                      message="Broken wikilink: [[Jane Do]]", severity="warn")
        n = asyncio.run(pl._stage2_link_repair([issue], _Cfg(), "/tmp/s"))
        return n, applied

    def test_valid_choice_is_applied_in_python(self, monkeypatch, tmp_path):
        n, applied = self._run(monkeypatch, tmp_path, '{"chosen": "person/Jane Doe"}')
        assert n == 1
        assert applied == [("note/n.md", "Jane Do", "person/Jane Doe")]

    def test_null_choice_applies_nothing(self, monkeypatch, tmp_path):
        n, applied = self._run(monkeypatch, tmp_path, '{"chosen": null}')
        assert n == 0 and applied == []

    def test_hallucinated_choice_rejected(self, monkeypatch, tmp_path):
        """A choice outside the candidate list must never be applied."""
        n, applied = self._run(monkeypatch, tmp_path, '{"chosen": "person/Mallory"}')
        assert n == 0 and applied == []


class TestStage3Guardrails:
    def test_templates_and_docs_exempt(self):
        """#288 L4 — scaffolding is never enrichment fodder."""
        issues = [
            Issue(file="_templates/person.md", code="STUB001", message="stub", severity="info"),
            Issue(file="_docs/README.md", code="STUB001", message="stub", severity="info"),
        ]

        class _Cfg:
            class vault:  # noqa: N801
                vault_path = None
                ignore_dirs = []

            class sweep:  # noqa: N801
                max_stubs_per_sweep = 10
                max_enrichment_attempts = 3

        n = asyncio.run(pl._stage3_enrich(issues, _Cfg(), "/tmp/s", state=None))
        assert n == 0
