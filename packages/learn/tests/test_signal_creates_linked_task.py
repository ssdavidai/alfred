"""Sir-matter-task #4 — auto-created tasks carry parent_matter linkage.

When auto-task creation is live (which after sir-matter-task #4 is the
default) and a signal targets ``matter/<slug>.md``, the resulting task
record MUST land with the rich shape:

  - ``parent_matter`` = the signal's matter_ref
  - ``matter_ref``    = same (alias)
  - ``state: pending``
  - ``status: queued``
  - ``signal_sources`` populated with the source_event_path

This pins the contract via the rendered frontmatter — we don't actually
invoke clerk/vault here, just the rendering helper, because the LLM +
ctrl-api roundtrips are independently tested elsewhere and don't add
signal to this contract pin.
"""
from __future__ import annotations

import re

from src.activities.task_creation import _render_task_content


def _frontmatter(rendered: str) -> str:
    m = re.match(r"^---\n(.*?)\n---", rendered, re.DOTALL)
    assert m
    return m.group(1)


def _fm_field(fm: str, key: str) -> str | None:
    for line in fm.splitlines():
        if line.startswith(f"{key}:"):
            return line.split(":", 1)[1].strip()
    return None


def test_auto_task_carries_parent_matter_from_signal_target():
    """Signal whose extractor resolved target_kind=matter, target_path=
    matter/stripe-billing.md → the auto-created task lands with
    parent_matter pointed at that matter."""
    rendered = _render_task_content(
        title="Verify Stripe webhook recovery",
        description="Confirm the rotated keys are receiving payment events.",
        slug="0abc1234-verify-stripe-webhook-recovery",
        parent_matter="matter/stripe-billing.md",
        due_at=None,
        signal={
            "source_event_path": "stream_event/2026-05-24-abc123.md",
            "source_type": "gmail",
            "target_kind": "matter",
            "target_path": "matter/stripe-billing.md",
        },
        created_iso="2026-05-24T12:00:00+00:00",
        closure_predicates=[],
    )
    fm = _frontmatter(rendered)

    pm = (_fm_field(fm, "parent_matter") or "").strip().strip("'\"")
    assert pm == "matter/stripe-billing.md"


def test_auto_task_carries_matter_ref_alias():
    """The ``matter_ref`` alias is emitted alongside ``parent_matter``
    so different readers (matters.ts vs decisions) both resolve."""
    rendered = _render_task_content(
        title="t",
        description="d",
        slug="s",
        parent_matter="matter/foo.md",
        due_at=None,
        signal={"source_event_path": "e", "source_type": "gmail"},
        created_iso="2026-05-24T12:00:00Z",
        closure_predicates=[],
    )
    fm = _frontmatter(rendered)

    pm = (_fm_field(fm, "parent_matter") or "").strip().strip("'\"")
    mref = (_fm_field(fm, "matter_ref") or "").strip().strip("'\"")
    assert mref == pm == "matter/foo.md"


def test_auto_task_lands_state_pending_status_queued():
    """Was ``state: open, status: todo`` — none of which TaskRunner
    picks up. Now ``state: pending, status: queued`` so the first
    TaskRunner tick after creation sees the task."""
    rendered = _render_task_content(
        title="t",
        description="d",
        slug="s",
        parent_matter="matter/foo.md",
        due_at=None,
        signal={"source_event_path": "e", "source_type": "gmail"},
        created_iso="2026-05-24T12:00:00Z",
        closure_predicates=[],
    )
    fm = _frontmatter(rendered)

    assert _fm_field(fm, "state") == "pending"
    assert _fm_field(fm, "status") == "queued"


def test_auto_task_emits_closure_predicate_field():
    """``closure_predicate: null`` (singular) is emitted for tooling
    that distinguishes "no predicate" from "field missing".
    """
    rendered = _render_task_content(
        title="t",
        description="d",
        slug="s",
        parent_matter="matter/foo.md",
        due_at=None,
        signal={"source_event_path": "e", "source_type": "gmail"},
        created_iso="2026-05-24T12:00:00Z",
        closure_predicates=[],
    )
    fm = _frontmatter(rendered)

    assert _fm_field(fm, "closure_predicate") == "null"


def test_auto_task_inbox_fallback_when_no_matter():
    """Caller passes ``matter/inbox.md`` when no specific matter could
    be inferred — the renderer must accept that path unchanged."""
    rendered = _render_task_content(
        title="t",
        description="d",
        slug="s",
        parent_matter="matter/inbox.md",
        due_at=None,
        signal={"source_event_path": "e", "source_type": "gmail"},
        created_iso="2026-05-24T12:00:00Z",
        closure_predicates=[],
    )
    fm = _frontmatter(rendered)

    pm = (_fm_field(fm, "parent_matter") or "").strip().strip("'\"")
    mref = (_fm_field(fm, "matter_ref") or "").strip().strip("'\"")
    assert pm == "matter/inbox.md"
    assert mref == "matter/inbox.md"


def test_auto_task_signal_sources_populated_from_source_event():
    """``signal_sources`` lists the originating event so Steward's
    evaluate_task can audit the task's provenance."""
    rendered = _render_task_content(
        title="t",
        description="d",
        slug="s",
        parent_matter="matter/foo.md",
        due_at=None,
        signal={
            "source_event_path": "stream_event/2026-05-24-abc.md",
            "source_type": "gmail",
        },
        created_iso="2026-05-24T12:00:00Z",
        closure_predicates=[],
    )

    assert "signal_sources:" in rendered
    assert "stream_event/2026-05-24-abc.md" in rendered
    assert "source_type: 'gmail'" in rendered
