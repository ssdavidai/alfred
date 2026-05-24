"""Gap 5b — surface scorer exceptions on the instinct match path.

Symptom on home.alfred.black: signal-observations get ``instinct_ref=null``
even when the scorer would have matched. The root cause is
``_score_observation_against_instincts`` in decision_observations.py
swallowing every exception with:

    except Exception:
        return None

…which means a real scorer bug (KeyError, AttributeError on the metadata
shape, a bad instinct frontmatter) gets silently filed as "no match"
and the observation goes out with ``instinct_ref=null``. We lose every
signal of what's actually wrong.

This test pins the contract: on scorer raise, the resolver must
(a) return None (don't break the caller) AND
(b) emit a WARNING log so a fan-out audit can see the failure.

The current code logs at DEBUG (the default ``logger.debug`` line),
which is suppressed by the production logging config. Flip to WARNING.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

import src.activities.decision_observations as do


class _FakeVaultClient:
    """Returns one instinct so the scorer is exercised."""

    def __init__(self, config: Any) -> None:
        pass

    async def list_records(self, record_type: str, limit: int = 100) -> list[dict[str, Any]]:
        return [
            {
                "path": "instinct/whatever.md",
                "frontmatter": {
                    "type": "instinct",
                    "name": "whatever",
                    "input_patterns": {"sender_domains": ["example.com"]},
                },
            }
        ]

    async def close(self) -> None:
        return None


def test_scorer_exception_is_logged_as_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """When ``best_instinct_path`` raises, the resolver must log a WARNING.

    RED on unfixed code: the except branch calls ``logger.debug`` which
    isn't captured at the WARNING level the prod config uses, so the
    audit fan-out sees zero signal of the underlying scorer bug.
    """
    import src.utils.vault_client as vc_mod
    import src.config as cfg_mod
    import src.matching.instinct_match as im

    monkeypatch.setattr(vc_mod, "VaultClient", _FakeVaultClient)
    monkeypatch.setattr(do, "VaultClient", _FakeVaultClient, raising=False)
    monkeypatch.setattr(cfg_mod, "load_config", lambda: object())

    def _boom(*args: Any, **kwargs: Any) -> str:
        raise RuntimeError("scorer exploded — synthetic test failure")

    monkeypatch.setattr(im, "best_instinct_path", _boom)
    # The function also imports the symbol locally inside the try block,
    # so monkeypatching the module attribute is sufficient — the
    # ``from src.matching.instinct_match import best_instinct_path``
    # inside the function picks up our replacement.

    with caplog.at_level("WARNING", logger="alfred-learn"):
        result = asyncio.run(
            do._match_instinct_for_observation(
                fact_clean="anything",
                sender="someone",
                topic="topic",
                name_label="name",
                source_kind="signal",
            )
        )

    assert result is None, "resolver must still return None on scorer raise"
    assert any(
        rec.levelname == "WARNING"
        and ("scorer" in rec.message.lower() or "match" in rec.message.lower())
        for rec in caplog.records
    ), (
        "expected a WARNING log mentioning scorer/match; "
        f"got {[(r.levelname, r.message) for r in caplog.records]!r}"
    )


def test_match_threshold_is_lowered_to_005() -> None:
    """Gap 5b second-pass: MATCH_THRESHOLD 0.10 → 0.05.

    After the scorer's substring + tokenised match fix (signal text
    + multi-word patterns now actually overlap), the decision-flow
    observations still scored ~0.027 because they have no
    ``input_type`` boost (source_kind=decision → input_type=other).
    Lowering the threshold to 0.05 lets the decision-flow observations
    pick up their instinct. The discretion gate downstream filters
    anyway, so surfacing more candidates is safe.
    """
    from src.matching.instinct_match import MATCH_THRESHOLD

    assert MATCH_THRESHOLD == pytest.approx(0.05), (
        f"MATCH_THRESHOLD must be 0.05 after gap 5b second-pass; "
        f"got {MATCH_THRESHOLD!r}"
    )
