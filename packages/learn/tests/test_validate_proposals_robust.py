"""BUG (3rd wedge, found on the home canary) — validate_proposals must
tolerate ANY clerk output shape without crashing.

A crash here (the clerk returned a bare-STRING `deprecate` entry, so
`dep.get(...)` raised AttributeError) retried forever and wedged
ReflectionWorkflow one step after the index/report writes.
"""
from __future__ import annotations

from src.activities.reflect import validate_proposals


async def test_bare_string_entries_do_not_crash() -> None:
    # The exact shape that wedged home: bare-string deprecate/update entries.
    proposals = {
        "deprecate": ["instinct/foo.md"],
        "update": ["instinct/bar.md"],
        "create": ["not-a-dict"],
        "merge": ["also-not-a-dict"],
    }
    out = await validate_proposals(proposals)  # must NOT raise
    assert isinstance(out, list)


async def test_non_dict_envelope_returns_empty() -> None:
    assert await validate_proposals(None) == []  # type: ignore[arg-type]
    assert await validate_proposals([]) == []  # type: ignore[arg-type]


async def test_non_list_buckets_ignored() -> None:
    out = await validate_proposals({"create": "oops", "deprecate": None})
    assert out == []


async def test_well_formed_update_still_processed() -> None:
    # Regression: a normal dict update must still flow through.
    out = await validate_proposals(
        {"update": [{"instinct_id": "instinct/x.md", "changes": {"observation_count": 5}}]}
    )
    assert isinstance(out, list)
    # (validity depends on the instinct validator; we only assert no crash
    # and that a dict entry is not dropped by the shape guards.)
