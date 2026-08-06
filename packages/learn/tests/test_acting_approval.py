"""#452 — Alfred may not grant himself autonomy.

`Acting` is the tier that authorises unattended action: the signal router
(#446) and the noise gate (#453) both key on it. Reflection may propose the
promotion; only Sir may apply it.

Also pins a latent bug found while building this: `vault.py` used `logger`
and `_now_iso` without defining either. Because
`fetch_unprocessed_observations` swallows every exception and returns `[]`,
a NameError there would have made Reflection silently process ZERO
observations whenever a burst was present — a silent failure of exactly the
class #442/#445 were about.
"""

import inspect

import pytest

from src.activities import vault as vault_mod
from src.matching.tiers import AUTONOMOUS_TIER


class _FakeClient:
    """Records patches; serves a configurable current frontmatter."""

    def __init__(self, frontmatter):
        self._fm = dict(frontmatter)
        self.patched: list[dict] = []
        self.read_calls = 0

    async def read_record(self, path):
        self.read_calls += 1
        return {"path": path, "frontmatter": dict(self._fm)}

    async def patch_frontmatter(self, path, updates):
        self.patched.append(dict(updates))
        self._fm.update(updates)

    async def close(self):
        pass


@pytest.fixture(autouse=True)
def _no_audit(monkeypatch):
    """Audit writes are best-effort and need ctrl-api; stub the client out."""

    class _SC:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def append_audit(self, **kw):
            _no_audit.rows.append(kw)

    _no_audit.rows = []
    monkeypatch.setattr("src.utils.state_client.StateClient", _SC)


async def _hold(client, changes, current_tier="Confirming", pending=""):
    client._fm.setdefault("tier", current_tier)
    if pending:
        client._fm["pending_promotion"] = pending
    return await vault_mod._hold_acting_promotion(
        client, "instinct/x.md", changes
    )


class TestPromotionIsWithheld:
    @pytest.mark.asyncio
    async def test_acting_promotion_is_stripped_and_requested(self):
        c = _FakeClient({"tier": "Confirming"})
        out = await _hold(c, {"tier": "Acting", "confidence_score": 0.9})
        assert "tier" not in out, "the promotion must not be applied"
        assert out["confidence_score"] == 0.9, "the rest of the proposal still applies"
        marked = c.patched[0]
        assert marked["pending_promotion"] == AUTONOMOUS_TIER
        assert marked["pending_promotion_from"] == "Confirming"

    @pytest.mark.asyncio
    async def test_asking_to_confirming_is_not_held(self):
        c = _FakeClient({"tier": "Asking"})
        out = await _hold(c, {"tier": "Confirming"}, current_tier="Asking")
        assert out["tier"] == "Confirming"
        assert c.patched == []

    @pytest.mark.asyncio
    async def test_demotion_out_of_acting_is_never_held(self):
        c = _FakeClient({"tier": "Acting"})
        out = await _hold(c, {"tier": "Asking"}, current_tier="Acting")
        assert out["tier"] == "Asking", "demotion must be immediate"

    @pytest.mark.asyncio
    async def test_already_acting_passes_through(self):
        c = _FakeClient({"tier": "Acting"})
        out = await _hold(c, {"tier": "Acting"}, current_tier="Acting")
        assert out["tier"] == "Acting"
        assert c.patched == []

    @pytest.mark.asyncio
    async def test_non_tier_changes_are_untouched(self):
        c = _FakeClient({"tier": "Asking"})
        out = await _hold(c, {"confidence_score": 0.7}, current_tier="Asking")
        assert out == {"confidence_score": 0.7}
        assert c.read_calls == 0, "no read needed when no tier change proposed"

    @pytest.mark.asyncio
    async def test_request_is_idempotent(self):
        c = _FakeClient({"tier": "Confirming", "pending_promotion": "Acting"})
        out = await _hold(c, {"tier": "Acting"}, pending="Acting")
        assert "tier" not in out
        assert c.patched == [], "must not re-request while already pending"

    @pytest.mark.asyncio
    async def test_unreadable_record_fails_closed(self, monkeypatch):
        class _Broken(_FakeClient):
            async def read_record(self, path):
                raise RuntimeError("ctrl-api down")

        c = _Broken({"tier": "Confirming"})
        out = await vault_mod._hold_acting_promotion(c, "instinct/x.md", {"tier": "Acting"})
        assert "tier" not in out, "unverifiable promotion must be withheld"

    @pytest.mark.asyncio
    async def test_case_insensitive_proposal(self):
        c = _FakeClient({"tier": "Confirming"})
        out = await _hold(c, {"tier": "acting"})
        assert "tier" not in out


class TestResolution:
    @pytest.mark.asyncio
    async def test_approve_applies_the_tier(self, monkeypatch):
        c = _FakeClient({"tier": "Confirming", "pending_promotion": "Acting"})
        monkeypatch.setattr(vault_mod, "VaultClient", lambda cfg: c)
        res = await vault_mod.resolve_instinct_promotion("instinct/x.md", approved=True)
        assert res["applied"] is True
        assert c._fm["tier"] == AUTONOMOUS_TIER
        assert c._fm["pending_promotion"] == ""

    @pytest.mark.asyncio
    async def test_decline_leaves_tier_alone(self, monkeypatch):
        c = _FakeClient({"tier": "Confirming", "pending_promotion": "Acting"})
        monkeypatch.setattr(vault_mod, "VaultClient", lambda cfg: c)
        res = await vault_mod.resolve_instinct_promotion("instinct/x.md", approved=False)
        assert res["applied"] is False
        assert c._fm["tier"] == "Confirming"
        assert c._fm["pending_promotion"] == ""
        assert c._fm["promotion_declined_from"] == "Confirming"

    @pytest.mark.asyncio
    async def test_resolving_without_a_request_is_a_no_op(self, monkeypatch):
        c = _FakeClient({"tier": "Confirming"})
        monkeypatch.setattr(vault_mod, "VaultClient", lambda cfg: c)
        res = await vault_mod.resolve_instinct_promotion("instinct/x.md", approved=True)
        assert res == {"path": "instinct/x.md", "applied": False,
                       "reason": "no_pending_request"}
        assert c._fm["tier"] == "Confirming"


class TestModuleWiring:
    """Regression pins for the NameError shipped in #457."""

    def test_logger_is_defined(self):
        assert isinstance(getattr(vault_mod, "logger", None), object)
        assert hasattr(vault_mod.logger, "info")

    def test_now_iso_is_defined_and_utc(self):
        assert vault_mod._now_iso().endswith("+00:00")

    def test_fetch_observations_references_only_defined_names(self):
        """`fetch_unprocessed_observations` swallows exceptions and returns
        [], so an undefined name in it fails SILENTLY — Reflection would
        just see zero observations. Check the names it uses exist."""
        src = inspect.getsource(vault_mod.fetch_unprocessed_observations)
        for name in ("logger", "annotate_decision_bursts", "burst_summary"):
            assert name in src
        assert hasattr(vault_mod, "logger")
