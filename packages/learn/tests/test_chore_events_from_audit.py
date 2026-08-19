"""Chore event lookups must read the audit table, not event/ markdown.

Both of these filtered on frontmatter fields — `matter` and `date` — that NO
event record carries. On the canonical tenant all 1,468 event records are
state-change / needs_attention_action audit mirrors, whose keys are
target/source/action/note. So both functions:

  * listed 500-1,000 records,
  * issued a SEPARATE read_record HTTP call for every one,
  * matched nothing,
  * returned [].

fetch_matter_events_last_week is called by the weekly-matter-digest chore, so
that digest's event section has been empty since the four-store cutover at a
cost of 500 round-trips per run.
"""
from __future__ import annotations

import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "activities" / "chore_actions.py"


def test_no_event_directory_listing_remains():
    src = SRC.read_text()
    offenders = [
        f"line {i}: {l.strip()}"
        for i, l in enumerate(src.splitlines(), 1)
        if re.search(r'list_records\(\s*["\']event["\']', l)
    ]
    assert not offenders, (
        "chore event lookups must query the audit table, not list event/:\n  "
        + "\n  ".join(offenders)
    )


def test_no_per_record_read_fanout():
    """The old shape issued one read_record per listed record — up to 1,000
    HTTP calls for a guaranteed-empty result."""
    src = SRC.read_text()
    assert "read_record(e[" not in src, (
        "per-record read fan-out reintroduced; the audit query returns the "
        "fields these functions need in one call"
    )


def test_they_filter_on_fields_that_actually_exist():
    """`matter` and `date` are absent from every event record. The audit row
    carries target_path / ts / summary, which is what the callers consume."""
    src = SRC.read_text()
    for fn in ("fetch_financial_events", "fetch_matter_events_last_week"):
        body = src[src.index(f"async def {fn}("):]
        body = body[: body.index("@activity.defn", 1)] if "@activity.defn" in body[1:] else body
        assert 'fm.get("matter")' not in body, f"{fn} still filters on the absent `matter` field"
        assert 'fm.get("date"' not in body, f"{fn} still filters on the absent `date` field"
        assert "list_audit" in body, f"{fn} should query the audit table"
