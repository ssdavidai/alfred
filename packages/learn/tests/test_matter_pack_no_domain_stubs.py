"""Phase 2 / Lane II — Commit 1: the rule-based matter pack fallback must
NOT write ``matter/<domain>-project.md`` stubs to the vault.

Background: the live 2026-05-23 onboarding fixture has 9 gold Opus matters
plus 8 junk ``<domain>-project.md`` stubs (444 Project, Github Project,
Google Project, Stripe Project, Zoom Project, Digitalocean Project,
Substack Project, Szabostuban Project). All 8 are from
``packs.generate_matter_pack`` — a fallback that fires whenever the Opus
path returns 0 matters AND has profile sender-tier data to lean on.

Per ``docs/GENERATORS.md`` §6 the fallback violates the promotion
contract ("the principal reads this" — a bare-domain stub is machine
bookkeeping). The fix: the fallback writes ZERO vault records and
returns a degraded marker the caller can persist as observability.

These tests prove the new contract — they fail against the pre-fix
code.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from temporalio import activity
from temporalio.testing import ActivityEnvironment

from src.activities import packs as packs_mod
from src.activities.packs import generate_matter_pack


class _FakeVaultClient:
    """Records every vault write so the test can assert the count is 0."""

    def __init__(self) -> None:
        self.written: list[tuple[str, str, str]] = []

    async def search_records(self, *_a: Any, **_k: Any) -> list[Any]:
        return []

    async def write_record(self, record_type: str, slug: str, content: str) -> str:
        self.written.append((record_type, slug, content))
        return f"{record_type}/{slug}.md"

    async def close(self) -> None:  # pragma: no cover - trivial
        pass


def _install(monkeypatch: pytest.MonkeyPatch, fake: _FakeVaultClient) -> None:
    monkeypatch.setattr(packs_mod, "VaultClient", lambda *_a, **_k: fake)
    import src.config as cfg
    monkeypatch.setattr(
        cfg, "load_config",
        lambda: type("C", (), {"alfred_ctrl_url": "http://ctrl-test:3100"})(),
    )


def _write_onboard(tmp_path: Path, data: dict[str, Any]) -> str:
    p = tmp_path / "onboard.json"
    p.write_text(json.dumps(data))
    return str(p)


def _run(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_test_matter_pack_wrapper")
    async def _wrap() -> dict[str, Any]:
        return await coro_factory()

    return asyncio.run(env.run(_wrap))


# Match the live fixture's profile shape: github / google / stripe / zoom
# sender_tiers populated with several senders per domain. The pre-fix
# fallback would write ``matter/github-project.md`` etc. for these.
def _live_like_profile() -> dict[str, Any]:
    return {
        "profile": {
            "sender_tiers": {
                "inner_circle": [
                    {"domain": "github.com", "address": "a@github.com",
                     "count": 320, "subject_keywords": []},
                ],
                "professional": [
                    {"domain": "stripe.com", "address": "b@stripe.com",
                     "count": 150, "subject_keywords": []},
                    {"domain": "google.com", "address": "c@google.com",
                     "count": 80, "subject_keywords": []},
                    {"domain": "zoom.us", "address": "d@zoom.us",
                     "count": 65, "subject_keywords": []},
                    {"domain": "digitalocean.com", "address": "e@digitalocean.com",
                     "count": 40, "subject_keywords": []},
                ],
            },
        },
    }


def test_fallback_writes_zero_domain_stub_matters_with_live_profile(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """Live-shaped profile: github/google/stripe/zoom/digitalocean each
    have multiple senders. Pre-fix this generator wrote 5 ``<domain>-
    project.md`` stubs. Post-fix: ZERO vault writes; the activity returns
    a result that carries ``created == 0`` and ``degraded`` is truthy.
    """
    fake = _FakeVaultClient()
    _install(monkeypatch, fake)
    path = _write_onboard(tmp_path, _live_like_profile())

    result = _run(lambda: generate_matter_pack(path))

    assert fake.written == [], (
        f"fallback wrote {len(fake.written)} vault records "
        f"(expected 0 — domain stubs violate the promotion contract): "
        f"{[w[1] for w in fake.written]}"
    )
    assert result.get("created", 0) == 0
    # The new contract: the caller can see this ran in degraded mode.
    assert result.get("degraded") is True, (
        f"result must carry degraded=True for observability; got {result}"
    )


def test_fallback_writes_zero_on_empty_profile(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """Empty profile, no senders → also zero writes (regression guard)."""
    fake = _FakeVaultClient()
    _install(monkeypatch, fake)
    path = _write_onboard(tmp_path, {"profile": {"sender_tiers": {}}})

    result = _run(lambda: generate_matter_pack(path))

    assert fake.written == []
    assert result.get("created", 0) == 0


def test_no_record_named_like_domain_stub(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """Defensive: even if the generator's body changes later, NO write
    may end with a ``<domain>-project`` slug (the signature of the
    deleted code path).
    """
    fake = _FakeVaultClient()
    _install(monkeypatch, fake)
    path = _write_onboard(tmp_path, _live_like_profile())

    _run(lambda: generate_matter_pack(path))

    domain_stubs = [w for w in fake.written if w[1].endswith("-project")]
    assert domain_stubs == [], (
        f"vault still got domain-stub matters: {[w[1] for w in domain_stubs]}"
    )
