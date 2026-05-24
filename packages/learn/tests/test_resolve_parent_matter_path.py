"""Sir-fresh-deploy #2 — ``_resolve_parent_matter_path`` validates against
real matters + fuzzy task-name fallback.

Symptom on the live tenant (2026-05-24): the resolver in
``packs_opus._resolve_parent_matter_path`` blindly slugified Opus's
freeform ``related_matter`` (e.g. ``"Stripe billing migration"``) and
emitted ``matter/stripe-billing-migration.md`` — a phantom path that
points at no real matter record. The matters aggregator
(``ctrl/src/api/routes/matters.ts``) reads ``parent_matter`` for
task→matter linkage; phantoms make ``/matters/:id.tasks`` return
``[]``. Live evidence: 33 tasks orphaned at phantoms, required a
manual relinking pass with a hardcoded MANUAL dict.

The Opus prompt (``packs_opus._build_errand_prompt`` ~L1865) DOES
tell Opus to pick ``related_matter`` from the existing matters list,
but Opus paraphrases ~30-50% of the time. The fix is writer-side
validation so phantoms never get written in the first place.

Pinned behaviour (four-tier resolution, cleanest match wins):

  Tier 1 — exact slug match: slugify the freeform ``related_matter``
           and check the index for ``matter/<slug>.md``.
  Tier 2 — fuzzy name match against ``related_matter``: token-overlap
           coefficient ≥ ``_RELATED_MATTER_FUZZY_THRESHOLD`` against
           each matter's ``name``.
  Tier 3 — fuzzy name match against the task ``name`` (catches the
           empty-related-matter case where Opus left the field blank
           but the task title is rich enough to resolve itself).
  Tier 4 — inbox fallback (``matter/inbox.md``).

Determinism: matter-index iteration is sorted by slug, so ties break
the same way every time (lexicographically smaller slug wins).
"""
from __future__ import annotations

import pytest


# ---------------------------------------------------------------------------
# Fixture: a realistic matter index
# ---------------------------------------------------------------------------


def _index() -> list[dict[str, str]]:
    """A representative slice of an onboarding-time matter list.

    Names mirror the live-evidence matters that triggered Sir-fresh-deploy
    #2 (payments / subscription churn, contract workflow, household ops).
    """
    return [
        {"slug": "payments-and-subscription-continuity",
         "name": "Payments and subscription continuity"},
        {"slug": "pat-contract-negotiation",
         "name": "Pat contract negotiation"},
        {"slug": "robin-childcare-logistics",
         "name": "Robin childcare logistics"},
        {"slug": "neoterra-ntp-client-delivery",
         "name": "NeoTerra / NTP client delivery"},
    ]


# ---------------------------------------------------------------------------
# Tier 1 — exact slug match
# ---------------------------------------------------------------------------


class TestTier1ExactSlug:
    """Tier 1: slugify ``related_matter``, match against index slugs."""

    def test_exact_slug_match_returns_real_path(self):
        from src.activities.packs_opus import _resolve_parent_matter_path

        # "payments and subscription continuity" slugifies to
        # "payments-and-subscription-continuity" — exact slug hit.
        path = _resolve_parent_matter_path(
            "payments and subscription continuity",
            matter_index=_index(),
        )
        assert path == "matter/payments-and-subscription-continuity.md"

    def test_exact_slug_match_case_insensitive(self):
        from src.activities.packs_opus import _resolve_parent_matter_path

        # Same slug, different case input — slugify handles it.
        path = _resolve_parent_matter_path(
            "Pat Contract Negotiation",
            matter_index=_index(),
        )
        assert path == "matter/pat-contract-negotiation.md"


# ---------------------------------------------------------------------------
# Tier 2 — fuzzy ``related_matter`` against matter ``name``
# ---------------------------------------------------------------------------


class TestTier2FuzzyRelatedMatter:
    """Tier 2: token-overlap of freeform ``related_matter`` vs ``name``."""

    def test_paraphrased_related_matter_fuzzy_matches(self):
        from src.activities.packs_opus import _resolve_parent_matter_path

        # "subscription payments" vs "Payments and subscription continuity"
        # shares {subscription, payments} — overlap 2/2 = 1.0 ≥ threshold.
        # Slugifies to ``subscription-payments`` (no exact slug hit).
        path = _resolve_parent_matter_path(
            "subscription payments",
            matter_index=_index(),
        )
        assert path == "matter/payments-and-subscription-continuity.md"

    def test_partial_paraphrase_fuzzy_matches(self):
        from src.activities.packs_opus import _resolve_parent_matter_path

        # "Robin daycare" vs "Robin childcare logistics" — only ``robin``
        # overlaps but min-cardinality (overlap coefficient) sees 1/2 =
        # 0.5 ≥ threshold (0.40).
        path = _resolve_parent_matter_path(
            "Robin daycare",
            matter_index=_index(),
        )
        assert path == "matter/robin-childcare-logistics.md"


# ---------------------------------------------------------------------------
# Tier 3 — fuzzy task-NAME fallback (the field formerly known as #224)
# ---------------------------------------------------------------------------


class TestTier3FuzzyTaskName:
    """Tier 3: empty ``related_matter`` but the task name carries enough
    signal to resolve a matter (folded in from old task #224).
    """

    def test_empty_related_matter_task_name_resolves(self):
        from src.activities.packs_opus import _resolve_parent_matter_path

        # The canonical live-evidence example: Opus left related_matter
        # empty but the task title carries the topic.
        path = _resolve_parent_matter_path(
            related_matter="",
            matter_index=_index(),
            task_name="Audit card ending 4822 for failed subscriptions",
        )
        # "audit", "card", "ending", "4822", "for", "failed", "subscriptions"
        # vs "payments", "and", "subscription", "continuity":
        #   token sets — exact match needs "subscriptions" vs "subscription"
        # …which DON'T match as raw tokens. We expect the implementation to
        # either stem or fall back to inbox here; pinning the contract:
        # ``subscriptions`` (plural) does NOT match ``subscription``
        # (singular) as a token. So this test verifies the **stricter**
        # behaviour: tier-3 only fires on real overlap, otherwise inbox.
        # The richer "Audit failed Stripe subscription" example tests the
        # positive path below.
        assert path == "matter/inbox.md"

    def test_task_name_with_real_overlap_resolves(self):
        from src.activities.packs_opus import _resolve_parent_matter_path

        # Task name explicitly shares tokens with matter name — clean
        # tier-3 hit. {pat, contract} ∩ {pat, contract, negotiation} =
        # 2/2 = 1.0 overlap coefficient ≥ threshold.
        path = _resolve_parent_matter_path(
            related_matter="",
            matter_index=_index(),
            task_name="Send Pat contract addendum",
        )
        assert path == "matter/pat-contract-negotiation.md"

    def test_tier3_only_when_tier2_empty(self):
        from src.activities.packs_opus import _resolve_parent_matter_path

        # related_matter is non-empty and DOES resolve via tier 2 — the
        # task name must NOT override that resolution.
        # "Pat contract" resolves to pat-contract-negotiation; the task
        # name mentions a different matter ("childcare"), which would have
        # resolved tier-3 to robin-childcare-logistics. Tier 2 wins.
        path = _resolve_parent_matter_path(
            related_matter="Pat contract",
            matter_index=_index(),
            task_name="Robin childcare reminder",
        )
        assert path == "matter/pat-contract-negotiation.md"


# ---------------------------------------------------------------------------
# Tier 4 — inbox fallback
# ---------------------------------------------------------------------------


class TestTier4Inbox:
    """Tier 4: nothing resolved — fall back to ``matter/inbox.md``."""

    def test_empty_related_matter_and_unrelated_task_name(self):
        from src.activities.packs_opus import _resolve_parent_matter_path

        path = _resolve_parent_matter_path(
            related_matter="",
            matter_index=_index(),
            task_name="Random unrelated thing",
        )
        assert path == "matter/inbox.md"

    def test_empty_matter_index_yields_inbox(self):
        from src.activities.packs_opus import _resolve_parent_matter_path

        # Even with a freeform related_matter, an empty index means we
        # can't validate anything → inbox (the SAFE default; the alternative
        # would be writing a phantom path, which is the bug we're fixing).
        path = _resolve_parent_matter_path(
            "Some Plausible Matter",
            matter_index=[],
        )
        assert path == "matter/inbox.md"

    def test_whitespace_related_matter_yields_inbox(self):
        from src.activities.packs_opus import _resolve_parent_matter_path

        path = _resolve_parent_matter_path(
            "   ",
            matter_index=_index(),
        )
        assert path == "matter/inbox.md"

    def test_unrelated_related_matter_yields_inbox(self):
        from src.activities.packs_opus import _resolve_parent_matter_path

        # The freeform string has no overlap with any indexed matter
        # AND slugifies to something that's not in the index. The OLD
        # (broken) behaviour was to write a phantom path. The NEW
        # behaviour is to fall back to inbox so the matters aggregator
        # picks the task up under the orphan home.
        path = _resolve_parent_matter_path(
            "Unrelated cosmic project xyzzy",
            matter_index=_index(),
        )
        assert path == "matter/inbox.md"


# ---------------------------------------------------------------------------
# Determinism — tie-breaking + back-compat
# ---------------------------------------------------------------------------


class TestDeterminism:
    """Same input → same output. Tie-break by sorted slug."""

    def test_tie_breaking_is_deterministic(self):
        """Two matters whose names tie on overlap with the same input must
        resolve to the lexicographically smaller slug, every time."""
        from src.activities.packs_opus import _resolve_parent_matter_path

        # Construct an index where two matters tie EXACTLY on overlap
        # with the input. "Alpha matter" and "Zeta matter" both share
        # exactly {matter} with the input "matter only" — same overlap.
        idx = [
            {"slug": "zeta-matter", "name": "Zeta matter"},
            {"slug": "alpha-matter", "name": "Alpha matter"},
        ]
        # Run twice with index in different orders; both must produce
        # the same answer (the sorted-by-slug winner).
        a = _resolve_parent_matter_path("matter only", matter_index=idx)
        b = _resolve_parent_matter_path(
            "matter only",
            matter_index=list(reversed(idx)),
        )
        assert a == b
        # alpha-matter sorts before zeta-matter.
        assert a == "matter/alpha-matter.md"


class TestBackCompat:
    """The resolver MUST still be callable with the old single-arg shape.

    ``_build_rich_errand_content`` was the only caller, but the function
    is module-public (single underscore) and might be referenced from
    other in-flight branches (lane orchestration). When ``matter_index``
    is omitted entirely, the legacy slug-then-fall-back behaviour is fine
    — the index-aware tiers just don't activate.
    """

    def test_no_index_falls_back_to_inbox_on_empty(self):
        from src.activities.packs_opus import _resolve_parent_matter_path

        # No second arg — the old single-arg call site.
        assert _resolve_parent_matter_path("") == "matter/inbox.md"

    def test_no_index_returns_inbox_for_unknown(self):
        from src.activities.packs_opus import _resolve_parent_matter_path

        # Without an index to validate against, we can't safely emit
        # ``matter/<slug>.md`` (that's the phantom bug). Inbox is the
        # safe default — the matters aggregator will pick the task up
        # there until a backfill links it correctly.
        assert (
            _resolve_parent_matter_path("Some unknown thing")
            == "matter/inbox.md"
        )
