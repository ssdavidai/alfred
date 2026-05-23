"""Per-day email sampling for onboarding context-budget guard.

Lane II / harden, 2026-05-23. Onboarding's ``extract_facts_opus`` hit
Hermes "Context length exceeded: max compression attempts (3) reached"
because the metadata stage fed up to 5000 emails-with-snippets to the
heavy profile. Fix is option D — bucket by day, sample
``_PER_DAY_EMAIL_CAP`` per bucket, keep full snippets. These tests pin
the contract so the corpus stays bounded and representative.
"""
from __future__ import annotations

from src.activities._email_sampling import (
    _PER_DAY_EMAIL_CAP,
    sample_emails_per_day,
)


def _email(date: str, idx: int = 0, snippet: str = "snippet") -> dict:
    return {
        "from": f"sender{idx}@example.com",
        "to": "me@example.com",
        "subject": f"subject {idx}",
        "date": date,
        "snippet": snippet,
        "domain": "example.com",
    }


def test_per_day_cap_keeps_all_when_under_cap() -> None:
    """A day with 5 emails comes through with all 5 intact."""
    emails = [_email("2026-05-23", i) for i in range(5)]
    out = sample_emails_per_day(emails, cap=20)
    assert len(out) == 5
    assert {e["subject"] for e in out} == {f"subject {i}" for i in range(5)}


def test_per_day_cap_samples_when_over_cap() -> None:
    """100 emails on one day with cap=20 returns exactly 20 of them."""
    emails = [_email("2026-05-23", i) for i in range(100)]
    out = sample_emails_per_day(emails, cap=20)
    assert len(out) == 20
    # Every sampled email is from the input (no synthetic rows).
    input_subjects = {e["subject"] for e in emails}
    assert {e["subject"] for e in out} <= input_subjects


def test_per_day_seed_idempotent_within_day() -> None:
    """Two calls with the same input on the same UTC day pick the same 20."""
    emails = [_email("2026-05-23", i) for i in range(100)]
    a = sample_emails_per_day(emails, cap=20)
    b = sample_emails_per_day(emails, cap=20)
    assert [e["subject"] for e in a] == [e["subject"] for e in b]


def test_per_day_distributes_across_days() -> None:
    """50 on day A + 50 on day B with cap=20 → 20 from A and 20 from B."""
    emails = (
        [_email("2026-05-22", i) for i in range(50)]
        + [_email("2026-05-23", 100 + i) for i in range(50)]
    )
    out = sample_emails_per_day(emails, cap=20)
    by_day: dict[str, int] = {}
    for e in out:
        by_day[e["date"]] = by_day.get(e["date"], 0) + 1
    assert by_day == {"2026-05-22": 20, "2026-05-23": 20}
    assert len(out) == 40


def test_per_day_handles_malformed_date() -> None:
    """Empty / garbage dates bucket under 'unknown' and obey the cap."""
    emails = [_email("", i) for i in range(15)] + [
        _email("not-a-date", 100 + i) for i in range(15)
    ]
    out = sample_emails_per_day(emails, cap=20)
    # 30 went in, all 30 land in the 'unknown' bucket → capped at 20.
    assert len(out) == 20
    assert all(isinstance(e["subject"], str) for e in out)


def test_per_day_overall_cap_two_thousand_in_100_day_realistic() -> None:
    """100 days × 100 emails (10k) → ≤ 2000 out, ≥ 95 days represented."""
    emails = []
    for d in range(100):
        day = f"2026-{((d // 31) + 1):02d}-{((d % 31) + 1):02d}"
        for i in range(100):
            emails.append(_email(day, d * 1000 + i))
    out = sample_emails_per_day(emails, cap=_PER_DAY_EMAIL_CAP)
    assert len(out) <= 2000
    days_represented = {e["date"] for e in out}
    assert len(days_represented) >= 95


def test_full_snippet_preserved() -> None:
    """Long snippets are not truncated by the sampler (option D)."""
    long_snippet = "x" * 500
    emails = [_email("2026-05-23", i, snippet=long_snippet) for i in range(40)]
    out = sample_emails_per_day(emails, cap=20)
    assert len(out) == 20
    for e in out:
        assert e["snippet"] == long_snippet
        assert len(e["snippet"]) == 500
