"""Match an observation back to the instinct that would have fired it.

Used in two places:

1. ``activities/decision_observations.extract_observation`` and
   ``activities/signal_observations.extract_obs_from_signal`` — at write
   time, populate the ``instinct:`` frontmatter field on each new
   observation record so the /instincts UI can pull a per-instinct
   observation list.

2. ``scripts/backfill_observation_instinct`` — one-shot to retro-tag
   observations written before this field was introduced.

The scorer in ``src.matching.scorer`` is the canonical matcher (used
by judge.py for fire-or-not). We adapt observation frontmatter into
the metadata shape the scorer wants, then take the best-scoring
instinct above THRESHOLD. Below the threshold we return None — the
observation simply has no associated instinct, which is the honest
answer for ambient/uncategorisable activity.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from src.matching.metadata import extract_input_metadata
from src.matching.scorer import score_all_instincts

logger = logging.getLogger("alfred-learn")


# Threshold tuning: scorer weights sum to 1.0 (0.30 domain + 0.30 keywords +
# 0.15 input_type + 0.15 attachment + 0.10 tags). A single sender_domain
# match alone yields 0.30; we want strong-but-not-iron-clad matches.
#
# Gap 5b (2026-05-24): lowered 0.15 → 0.10 (first pass). Then audit found
# the deeper bug — scorer was doing set intersection of single-word input
# keywords against multi-word pattern phrases, returning 0.0 every time.
# Fix: scorer.py now does substring + tokenised match.
#
# With that in place, scoring for the live ``escalate-critical-payment-
# failures`` instinct on a decision-flow observation lands at ~0.03
# (keyword=0.09 × weight 0.30 + input_type=0 since decision→"other").
# Lowered threshold 0.10 → 0.05 (per Sir's spec) so the decision-flow
# observations actually pick up their instinct — the discretion gate
# downstream filters anyway, so surfacing more candidates is safe.
MATCH_THRESHOLD = 0.05


def build_observation_metadata(
    obs_fm: dict[str, Any],
    signal_fm: dict[str, Any] | None = None,
    event_fm: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Adapt an observation's frontmatter into the metadata shape the
    instinct scorer expects.

    The bare observation fields (``fact``, ``sender``, ``topic``) often
    aren't enough to match against rich instinct ``input_patterns``:
    the observation's ``sender`` is a display name ("Plex"), not an
    email domain ("plex.tv"). When the caller has the upstream
    ``signal_fm`` or ``event_fm`` in hand, pass them in and we'll fold
    their richer fields (``raw_quote`` with email headers, ``subject``,
    ``body``) into the metadata so the scorer can do its job.
    """
    sender = str(obs_fm.get("sender") or "").strip()
    fact = str(obs_fm.get("fact") or "").strip()
    name = str(obs_fm.get("name") or "").strip()
    topic = str(obs_fm.get("topic") or "").strip()
    event_kind = str(obs_fm.get("event_kind") or "").strip()
    source_type = (
        str(obs_fm.get("source_type") or "").strip()
        or _source_kind_to_input_type(str(obs_fm.get("source_kind") or "").strip())
    )

    # Pull richer text from upstream records when present. The signal
    # record's ``raw_quote`` contains the verbatim email headers
    # (``**From**: Zoom <no-reply@zoom.us>``), which is where real
    # domains live; without it we can't match ``sender_domains`` patterns.
    extra_body_parts: list[str] = [sender, event_kind]
    extra_summary_parts: list[str] = []
    if signal_fm:
        raw_quote = str(signal_fm.get("raw_quote") or "").strip()
        if raw_quote:
            extra_body_parts.append(raw_quote)
        reasoning = str(signal_fm.get("reasoning") or "").strip()
        if reasoning:
            extra_summary_parts.append(reasoning)
    if event_fm:
        ev_from = str(event_fm.get("from") or event_fm.get("sender") or "").strip()
        if ev_from:
            extra_body_parts.append(ev_from)
        ev_subject = str(event_fm.get("subject") or event_fm.get("title") or "").strip()
        if ev_subject:
            extra_summary_parts.append(ev_subject)
        ev_body = str(event_fm.get("body") or event_fm.get("content") or "").strip()
        if ev_body:
            # Cap event body to keep keyword extraction tractable on
            # long emails — the extractor takes the top-15 anyway.
            extra_body_parts.append(ev_body[:2000])

    synthetic: dict[str, Any] = {
        "summary": " ".join(filter(None, [fact, *extra_summary_parts])),
        "title": name,
        "subject": topic,
        "body": " ".join(filter(None, extra_body_parts)),
        "stream_type": source_type or "other",
    }
    return extract_input_metadata(synthetic)


def _source_kind_to_input_type(source_kind: str) -> str:
    """Decision-sourced observations have ``source_kind=decision``,
    which is meaningless for instinct matching. Fall back to ``other``
    so the input_type score contributes nothing — the match has to
    come from domain or keywords.
    """
    if source_kind in ("signal", "event"):
        return source_kind
    return ""


def best_instinct_path(
    obs_fm: dict[str, Any],
    instincts: list[dict[str, Any]],
    signal_fm: dict[str, Any] | None = None,
    event_fm: dict[str, Any] | None = None,
) -> str | None:
    """Score the observation against all instincts; return the path of
    the best-scoring instinct if it clears MATCH_THRESHOLD, else None.

    ``instincts`` entries can be the ``frontmatter`` dict directly or
    a vault-list result with shape ``{path, frontmatter, ...}`` — we
    unwrap whichever and feed the scorer the frontmatter.

    Pass ``signal_fm`` / ``event_fm`` when available to enrich the
    matched metadata with real sender domains, full subjects, etc.
    """
    if not instincts:
        return None
    metadata = build_observation_metadata(obs_fm, signal_fm=signal_fm, event_fm=event_fm)

    # Unwrap to (path, frontmatter) tuples — the scorer wants
    # frontmatter dicts, but we need to keep the path alongside.
    pairs: list[tuple[str, dict[str, Any]]] = []
    for entry in instincts:
        if not isinstance(entry, dict):
            continue
        if "frontmatter" in entry and isinstance(entry["frontmatter"], dict):
            path = str(entry.get("path") or "")
            fm = entry["frontmatter"]
        else:
            # Raw frontmatter — path must be embedded somewhere.
            path = str(entry.get("path") or "")
            fm = entry
        if not path:
            continue
        # Skip deprecated / disabled instincts; they should not pull
        # new observations.
        status = str(fm.get("status") or "").lower()
        if status in ("deprecated", "disabled"):
            continue
        pairs.append((path, fm))

    if not pairs:
        return None

    scores = score_all_instincts(metadata, [fm for _, fm in pairs])
    if not scores:
        return None
    best = scores[0]

    # Sir gap 5b (2026-05-24): surface the top score on every call so
    # the live tenant log shows what the scorer is actually computing.
    # Was a silent black box: 13 observations today had instinct_ref=
    # None and no debug signal of WHY. INFO-level is fine — one log
    # line per observation write is acceptable churn for the
    # observability gain.
    top_path = None
    for p, fm in pairs:
        if fm is best.instinct:
            top_path = p
            break
    logger.info(
        "instinct_match: top=%s score=%.4f threshold=%.4f domain=%.2f "
        "keywords=%.2f input_type=%.2f attachment=%.2f tags=%.2f",
        top_path or "?",
        best.score,
        MATCH_THRESHOLD,
        best.breakdown.get("domain", 0.0),
        best.breakdown.get("keywords", 0.0),
        best.breakdown.get("input_type", 0.0),
        best.breakdown.get("attachment", 0.0),
        best.breakdown.get("tags", 0.0),
    )

    if best.score < MATCH_THRESHOLD:
        return None
    return top_path


def _normalise_sender_for_domain(sender: str) -> str:
    """Some observation `sender` fields are bare display names
    (``"Plex"``, ``"Stripe Billing"``). The regex domain extractor
    needs an email-shaped string to find anything, so we pass these
    through as-is — they just won't contribute a domain score.
    """
    m = re.search(r"<([^>]+)>", sender)
    if m:
        return m.group(1)
    return sender
