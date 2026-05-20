"""#BUG-3 — VaultClient.record_exists must be an exact-slug check, not a
grep substring search.

Re-onboard pack dedup used ``search_records(slug)`` (a grep substring
search). A slightly renamed re-run either false-positived (substring of an
existing record → wrongly skipped) or false-negatived (no substring → wrote
a duplicate, the matter 9->16 class). ``record_exists`` compares the
canonical ``<type>/<slug>.md`` path and the record ``slug`` exactly.
"""
from __future__ import annotations

from src.config import Config
from src.utils.vault_client import VaultClient


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _StubHttp:
    """Captures the list endpoint call and returns canned records."""

    def __init__(self, records):
        self._records = records
        self.calls: list[str] = []

    async def get(self, url, *args, **kwargs):
        self.calls.append(url)
        return _Resp({"results": list(self._records)})

    async def aclose(self):
        return None


def _client_with(records):
    vc = VaultClient(Config())
    vc._client = _StubHttp(records)  # type: ignore[assignment]
    return vc


async def test_exact_slug_match_exists():
    vc = _client_with([
        {"slug": "weekly-stripe-review", "path": "matter/weekly-stripe-review.md"},
    ])
    assert await vc.record_exists("matter", "weekly-stripe-review") is True


async def test_substring_overlap_is_not_a_match():
    """An existing ``weekly-stripe-reviews`` must NOT make a *new*
    ``weekly-stripe-review`` look like it already exists — that is exactly
    the grep false-positive the old code suffered."""
    vc = _client_with([
        {"slug": "weekly-stripe-reviews", "path": "matter/weekly-stripe-reviews.md"},
    ])
    assert await vc.record_exists("matter", "weekly-stripe-review") is False


async def test_path_match_without_slug_field():
    """Some listings expose only ``path``; the canonical path still matches."""
    vc = _client_with([
        {"path": "task/reply-to-pat.md"},
        {"path": "task/something-else.md"},
    ])
    assert await vc.record_exists("task", "reply-to-pat") is True
    assert await vc.record_exists("task", "reply") is False


async def test_uses_typed_listing_endpoint():
    vc = _client_with([])
    await vc.record_exists("instinct", "route-stripe-failures")
    assert vc._client.calls == ["/api/v1/vault/list/instinct"]  # type: ignore[attr-defined]
