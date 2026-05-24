"""Sir-matter-task #1 — onboarding-time tasks must link to a parent matter.

Symptom on the live tenant (2026-05-24):
  - 32 tasks all sitting with ``status: todo`` since cradle-write.
  - None have ``parent_matter``, ``matter_ref``, ``state``, or
    ``closure_predicate``.
  - Every ``/matters/:id.tasks`` returns ``[]`` because the matters
    aggregator (ctrl/src/api/routes/matters.ts) reads ``parent_matter``
    + ``state``, but the onboarding writer
    (``packs_opus._build_rich_errand_content``) only emits ``related_matter``
    (a freeform string) and ``status``.

This test pins the new rich shape ``_build_rich_errand_content`` MUST
emit so onboarding tasks land linked + queued for TaskRunner.

Required new frontmatter:
  - ``state: pending`` (matters aggregator reads this)
  - ``status: queued`` (TaskRunner filter; replaces legacy ``todo``)
  - ``parent_matter: matter/<slug>.md`` (matters aggregator forward ref)
  - ``matter_ref: matter/<slug>.md`` (alias different readers use)
  - ``signal_sources: []`` (Steward's source-of-truth list)
  - ``closure_predicate: null`` (optional; populated when auto-close)
"""
from __future__ import annotations

import re

import pytest

import src.activities.packs_opus as po


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _frontmatter_block(rendered: str) -> str:
    """Extract the YAML frontmatter (between the two `---` lines)."""
    m = re.match(r"^---\n(.*?)\n---", rendered, re.DOTALL)
    assert m, "rendered task must start with a YAML frontmatter block"
    return m.group(1)


def _fm_field(fm: str, key: str) -> str | None:
    """Return the (lstripped) value for a frontmatter scalar key, or None."""
    for line in fm.splitlines():
        if line.startswith(f"{key}:"):
            return line.split(":", 1)[1].strip()
    return None


def _has_field(fm: str, key: str) -> bool:
    return _fm_field(fm, key) is not None


# A baseline well-formed errand dict to feed the writer.
_BASE_ERRAND = {
    "name": "Verify Stripe API key rotation",
    "status": "todo",
    "owner": "human",
    "urgency": "normal",
    "due_hint": "this week",
    "related_matter": "Stripe billing migration",
    "context": (
        "We rotated the Stripe live API keys last month and the "
        "webhook endpoint must be re-verified to confirm no payment "
        "events are being silently dropped."
    ),
    "why_it_matters": "Missing webhook events lose customer payment data.",
    "first_action": "Check the Stripe dashboard webhook events log.",
    "dependencies": [],
}


# ---------------------------------------------------------------------------
# Tests — the new rich shape contract
# ---------------------------------------------------------------------------


def test_emits_state_pending():
    """matters.ts normalizes ``state: pending`` → MatterTask.state="pending".

    The matters aggregator (ctrl-api routes/matters.ts) reads ``state``
    directly. Without it the task collapses to "pending" by default —
    same end-state but means we never get an auto-derived "in_progress"
    rollup once the task moves.
    """
    rendered = po._build_rich_errand_content(_BASE_ERRAND)
    fm = _frontmatter_block(rendered)

    assert _fm_field(fm, "state") == "pending", (
        "onboarding task must emit `state: pending` so the matters "
        "aggregator can roll it up. Got fm:\n" + fm
    )


def test_emits_status_queued_not_todo():
    """TaskRunner filters on ``status in (queued, in_progress)``.

    Live tenant has 32 tasks at ``status: todo`` since cradle write —
    TaskRunner never picked them up because ``todo`` isn't in its
    filter set. Onboarding writes must land on ``queued`` so the very
    first TaskRunner tick after onboarding sees them.
    """
    rendered = po._build_rich_errand_content(_BASE_ERRAND)
    fm = _frontmatter_block(rendered)

    assert _fm_field(fm, "status") == "queued", (
        "onboarding task must emit `status: queued` (was `todo`). "
        "fm:\n" + fm
    )


def test_emits_parent_matter_from_related_matter_freeform():
    """``related_matter`` is a freeform Opus string ("Stripe billing
    migration"). The writer MUST resolve / fall it through to a vault
    path ``matter/<slug>.md`` so matters.ts ``parent_matter`` resolution
    finds it.
    """
    rendered = po._build_rich_errand_content(_BASE_ERRAND)
    fm = _frontmatter_block(rendered)

    pm = _fm_field(fm, "parent_matter")
    assert pm is not None, "must emit a parent_matter field"
    # Strip quotes if present.
    pm_clean = pm.strip().strip("'\"")
    assert pm_clean.startswith("matter/"), f"parent_matter must be a matter path: {pm!r}"
    assert pm_clean.endswith(".md"), f"parent_matter must end .md: {pm!r}"


def test_emits_matter_ref_alias_matches_parent_matter():
    """Some readers look at ``parent_matter``, some at ``matter_ref``.
    We emit both, identical.
    """
    rendered = po._build_rich_errand_content(_BASE_ERRAND)
    fm = _frontmatter_block(rendered)

    pm = _fm_field(fm, "parent_matter")
    mref = _fm_field(fm, "matter_ref")
    assert mref is not None, "must emit a matter_ref alias"
    assert mref == pm, (
        f"matter_ref must equal parent_matter; got pm={pm!r} mref={mref!r}"
    )


def test_emits_signal_sources_empty_list():
    """Onboarding-time tasks have no originating signal — emit an empty
    list rather than omitting the field, so Steward's evaluate_task
    activity (which reads signal_sources unconditionally) sees a
    well-typed value.
    """
    rendered = po._build_rich_errand_content(_BASE_ERRAND)
    fm = _frontmatter_block(rendered)

    val = _fm_field(fm, "signal_sources")
    assert val == "[]", (
        f"signal_sources must be the empty list []; got {val!r}.\nfm:\n{fm}"
    )


def test_emits_closure_predicate_null():
    """``closure_predicate`` is optional; emit ``null`` so the field is
    present (downstream tooling distinguishes "no predicate set" from
    "field missing").
    """
    rendered = po._build_rich_errand_content(_BASE_ERRAND)
    fm = _frontmatter_block(rendered)

    val = _fm_field(fm, "closure_predicate")
    assert val == "null", (
        f"closure_predicate must be `null`; got {val!r}.\nfm:\n{fm}"
    )


def test_inbox_fallback_when_no_related_matter():
    """No ``related_matter`` set on the errand → fall back to
    ``matter/inbox.md`` so the task still has a home.
    """
    errand = dict(_BASE_ERRAND)
    errand["related_matter"] = ""
    rendered = po._build_rich_errand_content(errand)
    fm = _frontmatter_block(rendered)

    pm = _fm_field(fm, "parent_matter")
    pm_clean = pm.strip().strip("'\"") if pm else ""
    assert pm_clean == "matter/inbox.md", (
        f"missing related_matter must fall back to matter/inbox.md; got {pm!r}"
    )


def test_inbox_fallback_when_related_matter_whitespace():
    """Defensive: whitespace-only ``related_matter`` is the same as missing."""
    errand = dict(_BASE_ERRAND)
    errand["related_matter"] = "   "
    rendered = po._build_rich_errand_content(errand)
    fm = _frontmatter_block(rendered)

    pm_clean = (_fm_field(fm, "parent_matter") or "").strip().strip("'\"")
    assert pm_clean == "matter/inbox.md"


def test_freeform_related_matter_is_slugified_into_path():
    """A freeform Opus name like "Stripe billing migration" becomes
    ``matter/stripe-billing-migration.md`` so the matter aggregator's
    ``extractMatterRef`` resolves it cleanly.
    """
    errand = dict(_BASE_ERRAND)
    errand["related_matter"] = "Stripe billing migration"
    rendered = po._build_rich_errand_content(errand)
    fm = _frontmatter_block(rendered)

    pm_clean = (_fm_field(fm, "parent_matter") or "").strip().strip("'\"")
    assert pm_clean == "matter/stripe-billing-migration.md"


def test_legacy_related_matter_string_still_present_for_humans():
    """Backwards-compat: the freeform ``related_matter`` line stays in
    the body so a human reader of the markdown still sees the
    Opus-generated description (we add ``parent_matter`` ALONGSIDE,
    not as a replacement).
    """
    rendered = po._build_rich_errand_content(_BASE_ERRAND)
    # The body still mentions the freeform matter name for readability.
    assert "Stripe billing migration" in rendered
