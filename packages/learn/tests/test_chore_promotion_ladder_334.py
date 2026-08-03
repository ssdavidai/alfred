"""#334 — prove the chore→product ladder gate + dry-run posture.

The promotion workflow drafts a PR for chores with 20+ runs at >=95%
success. #334: nothing verified the qualification gate, the dry-run
posture (draft saved, real PR gated behind an opt-in flag), or that the
default repo points at the live monorepo.
"""
from __future__ import annotations

import asyncio
import time

from src.activities import chore_promotion as cp


def _tmpl(name, total, live, age_days=1):
    return {"module_name": name, "workflow_class_name": name.title(),
            "stats": {"total_runs": total, "live_runs": live,
                      "last_run": time.time() - age_days*86400}}


class TestQualificationGate:
    def test_qualifying_chore_selected(self):
        out = asyncio.run(cp.identify_promotion_candidates([_tmpl("payments_guard", 25, 25)]))
        assert len(out) == 1
        assert out[0]["success_rate"] == 1.0

    def test_below_min_runs_rejected(self):
        out = asyncio.run(cp.identify_promotion_candidates([_tmpl("x", 19, 19)]))
        assert out == []

    def test_below_success_rate_rejected(self):
        # 20 runs, 18 live = 0.90 < 0.95
        out = asyncio.run(cp.identify_promotion_candidates([_tmpl("x", 20, 18)]))
        assert out == []

    def test_stale_chore_rejected(self):
        out = asyncio.run(cp.identify_promotion_candidates([_tmpl("x", 30, 30, age_days=120)]))
        assert out == []

    def test_boundary_exactly_20_at_95(self):
        out = asyncio.run(cp.identify_promotion_candidates([_tmpl("x", 20, 19)]))  # 0.95
        assert len(out) == 1


class TestDryRunPosture:
    def test_default_repo_is_live_monorepo(self):
        assert cp._DEFAULT_PROMOTION_REPO == "ssdavidai/alfred"

    def test_auto_pr_defaults_off(self, monkeypatch):
        monkeypatch.delenv("ALFRED_PROMOTION_AUTO_PR", raising=False)
        assert asyncio.run(cp.promotion_auto_pr_enabled()) is False

    def test_pr_activity_refuses_without_token(self, monkeypatch):
        monkeypatch.delenv("ALFRED_PROMOTION_GITHUB_TOKEN", raising=False)
        out = asyncio.run(cp.create_github_promotion_pr(
            {"module_name": "m", "python_source": "x=1", "pr_title": "t", "pr_body": "b"}))
        assert out["ok"] is False and out["phase"] == "auth"
