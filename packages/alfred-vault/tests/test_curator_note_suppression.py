"""Curator must not write per-service-sender summary notes
("GitHub Activity Summary", "Canva Service Emails", "Replit Email Digest
- May 23, 2026", ...) to the principal vault. They're bookkeeping
aggregates — per-domain volume already lives in onboard.json[top_domains]
— and the promotion contract (CLAUDE.md) keeps machine bookkeeping out
of the vault. We test the pure rule + the suppression hook directly.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from alfred.curator.note_filter import (
    _is_per_service_summary_note,
    _suppress_per_service_summary,
)


@pytest.mark.parametrize("name", [
    "GitHub Activity Summary",        # 4 near-dupes in the live tenant
    "GitHub Activity",
    "Canva Service Emails Summary",
    "Canva Service Emails",
    "Mailgun Service Emails",
    "DeskIn Service Emails",
    "Replit Email Digest - May 23, 2026",
    "Kit.com Email Digest",
    "Stripe Notifications Summary",
    "Vercel Notification Summary",
    "Linear Service & Notification Summary",
])
def test_per_service_summary_names_are_suppressed(name):
    assert _is_per_service_summary_note(name) is True, name


@pytest.mark.parametrize("name", [
    "Meeting notes — NeoTerra weekly 2026-05-14",
    "Daybook 2026-05-20",
    "How to reset the Hermes session key",
    "Q2 board activity recap",   # "activity" mid-sentence, not service-sender
    "Acme Corp onboarding plan",
    "",
    "   ",
])
def test_substantive_notes_are_kept(name):
    assert _is_per_service_summary_note(name) is False, name


def test_suppress_deletes_junk_note_and_returns_empty(tmp_path):
    (tmp_path / "note").mkdir()
    junk = tmp_path / "note" / "GitHub Activity Summary.md"
    junk.write_text("# GitHub Activity Summary\n")
    assert _suppress_per_service_summary(
        vault_path=tmp_path, note_path="note/GitHub Activity Summary.md",
    ) == ""
    assert not junk.exists()


def test_suppress_is_a_no_op_for_substantive_notes(tmp_path):
    (tmp_path / "note").mkdir()
    rel = "note/Meeting notes — NeoTerra weekly 2026-05-14.md"
    keep = tmp_path / rel
    keep.write_text("# real content\n")
    assert _suppress_per_service_summary(vault_path=tmp_path, note_path=rel) == rel
    assert keep.exists()


def test_suppress_tolerates_empty_path():
    assert _suppress_per_service_summary(vault_path=Path("/tmp"), note_path="") == ""


def test_suppress_tolerates_missing_file(tmp_path):
    """Junk-rule match on a path with no file on disk: no crash, returns ""."""
    assert _suppress_per_service_summary(
        vault_path=tmp_path, note_path="note/Canva Service Emails Summary.md",
    ) == ""
