"""Infra funnel matters are exempt from the per_matter_per_day cap.

Signal extraction routes the entire inbound stream through one synthetic
``matter_path="signal-extract"``. Before this fix the per_matter_per_day
noise-control cap (50) applied to it, throttling ALL extraction fleet-wide to
50 LLM calls/day and then pinning at 50/50 (deferred events re-list every tick
and re-burn the window) — observed live on a client tenant (2026-07-03):
``signal_extract.done listed=200 extracted=100 written=0 errors=100`` with
``cap per_matter_per_day hit (50/50)`` and ZERO real provider 429s.

These tests lock in:
  (1) a funnel matter in INFRA_MATTERS is NOT capped by per_matter_per_day
      (it stays gated by per_task/tenant-wide windows + the 429 backoff);
  (2) a real *business* matter is still capped at 50 (the exemption is scoped).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.config import Config  # noqa: E402
from src.activities.rate_guard import LIMITS, RateGuard  # noqa: E402


def _cfg(tmp_path: Path) -> Config:
    return Config(alfred_data_dir=str(tmp_path))


@pytest.mark.asyncio
async def test_signal_extract_matter_exempt_from_per_matter_cap(tmp_path: Path) -> None:
    """>50 signal-extract reservations in one window all stay allowed.

    Distinct task_paths keep per_task_per_day (6) clear; N is kept under
    per_minute (60) so this isolates the per_matter cap. Before the fix the
    (per_matter_per_day+1)th call was blocked with cap=per_matter_per_day.
    """
    n = LIMITS["per_matter_per_day"] + 5  # 55 — above the matter cap...
    assert n < LIMITS["per_minute"], "test must stay under the tenant-wide per_minute cap"

    guard = RateGuard(_cfg(tmp_path))
    for i in range(n):
        dec = await guard.check_and_reserve(
            task_path=f"ingest:event-{i}",   # unique per event → per_task stays 1
            matter_path="signal-extract",    # infra funnel → exempt
        )
        assert dec.allowed, (
            f"reservation {i + 1}/{n} blocked (cap={dec.cap}, reason={dec.reason}); "
            "signal-extract must be exempt from per_matter_per_day"
        )


@pytest.mark.asyncio
async def test_business_matter_still_capped_at_per_matter_limit(tmp_path: Path) -> None:
    """A real (non-infra) matter is still throttled at per_matter_per_day.

    Regression guard: the exemption is scoped to INFRA_MATTERS, so ordinary
    business matters keep their noise-control cap.
    """
    cap = LIMITS["per_matter_per_day"]
    assert cap + 1 < LIMITS["per_minute"], "keep the test under the per_minute cap"

    guard = RateGuard(_cfg(tmp_path))
    for i in range(cap):
        dec = await guard.check_and_reserve(
            task_path=f"task-{i}",           # unique → per_task stays clear
            matter_path="matter/acme-deal",  # a real business matter
        )
        assert dec.allowed, f"reservation {i + 1}/{cap} should be allowed"

    # The (cap+1)th on the same business matter is blocked by per_matter_per_day.
    blocked = await guard.check_and_reserve(
        task_path="task-final",
        matter_path="matter/acme-deal",
    )
    assert not blocked.allowed
    assert blocked.cap == "per_matter_per_day"
