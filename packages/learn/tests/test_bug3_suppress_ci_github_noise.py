"""BUG 3 — a matched suppression instinct must actually suppress.

`suppress-ci-github-workflow-noise` was matched for display but never
enforced: the extract-time noise filter (`load_noise_instincts` +
`event_matches_noise_instinct`) skipped it (it carries
`routing_rule.destination_type: hold`, not `intent_key: noise`), the
`gcal_organiser` kind check was dead, its bare `github.com` glob never
matched `notifications@github.com`, and its `subject_keywords` were
never consulted. These pin the fix.
"""
from __future__ import annotations

from src.activities.noise_patterns import (
    event_matches_noise_instinct,
    load_noise_instincts,
)


def _ci_instinct() -> dict:
    return {
        "path": "instinct/suppress-ci-github-workflow-noise.md",
        "sender_domains": ["github.com"],  # bare, no wildcard (hand-authored)
        "subject_keywords": ["CI failed", "workflow failed"],
    }


def test_bare_domain_glob_matches_real_sender() -> None:
    # notifications@github.com must match a bare "github.com" anchor.
    event = {"source_type": "gmail", "from": "GitHub <notifications@github.com>"}
    m = event_matches_noise_instinct(event, [_ci_instinct()])
    assert m is not None
    assert m["path"] == "instinct/suppress-ci-github-workflow-noise.md"


def test_sender_recovered_from_body() -> None:
    # No top-level `from`; the sender lives only in the rendered body.
    event = {"source_type": "gmail"}
    body = "**From**: GitHub <notifications@github.com>\n**Subject**: run failed"
    m = event_matches_noise_instinct(event, [_ci_instinct()], event_body=body)
    assert m is not None


def test_subject_keyword_match_without_sender() -> None:
    event = {"source_type": "gmail", "subject": "CI failed on main"}
    inst = {
        "path": "instinct/x.md",
        "sender_domains": [],
        "subject_keywords": ["CI failed"],
    }
    m = event_matches_noise_instinct(event, [inst])
    assert m is not None
    assert m["matched_keyword"] == "CI failed"
    assert m["kind"] == "instinct_subject_keyword"


def test_non_github_stays_narrow() -> None:
    event = {"source_type": "gmail", "from": "hello@example.com", "subject": "Lunch?"}
    assert event_matches_noise_instinct(event, [_ci_instinct()]) is None


async def test_load_honours_destination_type_hold(monkeypatch) -> None:
    """An instinct with routing_rule.destination_type=hold and NO
    intent_key must still load (it was invisible to the old gate)."""
    import src.activities.noise_patterns as np

    class _Resp:
        status_code = 200

        def json(self) -> dict:
            return {
                "results": [
                    {
                        "path": "instinct/suppress-ci-github-workflow-noise.md",
                        "frontmatter": {
                            "status": "active",
                            "routing_rule": {"destination_type": "hold"},
                            "input_patterns": {
                                "sender_domains": ["github.com"],
                                "subject_keywords": ["CI failed"],
                            },
                        },
                    }
                ]
            }

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, *a, **k):
            return _Resp()

    monkeypatch.setattr(np, "_http", lambda: _Client())
    np._NOISE_INSTINCT_CACHE["loaded_at"] = 0.0  # bust the 60s cache
    out = await load_noise_instincts()
    np._NOISE_INSTINCT_CACHE["loaded_at"] = 0.0  # don't poison other tests
    assert len(out) == 1
    assert out[0]["path"] == "instinct/suppress-ci-github-workflow-noise.md"
    assert out[0]["sender_domains"] == ["github.com"]
    assert out[0]["subject_keywords"] == ["CI failed"]
