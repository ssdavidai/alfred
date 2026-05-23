"""Four-pack generator: stream, matter, instinct, errand packs from profiler data."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_profile(onboard_path: str) -> dict[str, Any]:
    """Load onboard.json and return the profile sub-dict.

    Also injects top_domains from the onboard top level into the returned
    profile if not already present, since the normalizer needs it for
    accurate per-domain counts and the rest of the pack logic for filters.
    """
    with open(onboard_path, "r") as f:
        data: dict[str, Any] = json.load(f)
    profile: dict[str, Any] = dict(data.get("profile", {}) or {})
    if "top_domains" not in profile and data.get("top_domains"):
        profile["top_domains"] = data["top_domains"]
    return profile


def _save_onboard_key(onboard_path: str, key: str, value: Any) -> None:
    """Merge *value* into onboard.json under *key*."""
    with open(onboard_path, "r") as f:
        data: dict[str, Any] = json.load(f)
    data[key] = value
    with open(onboard_path, "w") as f:
        json.dump(data, f, indent=2, default=str)


def _slugify(name: str) -> str:
    """Lowercase, replace spaces/underscores with hyphens, strip non-alphanum."""
    s = name.lower()
    s = re.sub(r"[_\s]+", "-", s)
    s = re.sub(r"[^a-z0-9-]", "", s)
    s = re.sub(r"-+", "-", s)
    return s.strip("-")


def _normalize_sender_tiers(profile: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Normalize sender_tiers to the dict-of-list-of-dicts shape pack generators expect.

    The behavioral profiler currently emits sender_tiers as dict[str, list[str]] —
    a flat list of domain strings per tier. The pack generators were written
    against a richer dict-of-list-of-dicts shape with
    {domain, count, address, subject_keywords}. Rather than change the profiler
    (which feeds many consumers including LLM prompts and dashboard), this helper
    wraps strings into the expected dict shape, deriving counts and keywords from
    other parts of the profile where available.

    Pass-through behavior: if a tier already contains dicts (richer profiler
    output, future-proof), they are kept as-is.
    """
    raw = profile.get("sender_tiers", {})
    if not isinstance(raw, dict):
        return {}

    # Build a domain->count map from top_domains if available, else default to 1.
    top_domains = profile.get("top_domains") or []
    count_by_domain: dict[str, int] = {}
    for entry in top_domains:
        if isinstance(entry, dict):
            d = (entry.get("domain") or "").lower()
            if d:
                count_by_domain[d] = int(entry.get("count", 1))
        elif isinstance(entry, (list, tuple)) and len(entry) >= 2:
            try:
                count_by_domain[str(entry[0]).lower()] = int(entry[1])
            except (TypeError, ValueError):
                pass

    # Build a domain->subject_keywords map from relationships if available.
    keywords_by_domain: dict[str, list[str]] = {}
    for rel in profile.get("relationships", []):
        if not isinstance(rel, dict):
            continue
        d = (rel.get("domain") or "").lower()
        if not d:
            continue
        kws = rel.get("common_topics") or rel.get("keywords") or []
        if isinstance(kws, list):
            keywords_by_domain[d] = [str(k) for k in kws[:10]]

    normalized: dict[str, list[dict[str, Any]]] = {}
    for tier, senders in raw.items():
        if not isinstance(senders, list):
            continue
        out: list[dict[str, Any]] = []
        for s in senders:
            if isinstance(s, dict):
                # Already in the rich format — pass through
                out.append(s)
                continue
            if not isinstance(s, str):
                continue
            domain = s.lower().strip()
            if not domain:
                continue
            out.append({
                "domain": domain,
                "address": domain,
                "count": count_by_domain.get(domain, 1),
                "subject_keywords": keywords_by_domain.get(domain, []),
            })
        normalized[tier] = out
    return normalized


# Domain → stream type mapping
_STREAM_DOMAIN_MAP: dict[str, dict[str, str]] = {
    "github.com": {
        "name": "GitHub",
        "type": "github_webhook",
        "description": "GitHub webhook stream for repository events",
    },
    "calendar-notification@google.com": {
        "name": "Google Calendar",
        "type": "google_calendar",
        "description": "Google Calendar event notifications",
    },
    "notion.so": {
        "name": "Notion",
        "type": "notion_api",
        "description": "Notion API stream for workspace changes",
    },
    "clockify.me": {
        "name": "Clockify",
        "type": "clockify_webhook",
        "description": "Clockify webhook for time tracking events",
    },
    "linear.app": {
        "name": "Linear",
        "type": "linear_webhook",
        "description": "Linear webhook for issue tracking events",
    },
    "slack.com": {
        "name": "Slack",
        "type": "slack_webhook",
        "description": "Slack webhook for message events",
    },
    "trello.com": {
        "name": "Trello",
        "type": "trello_webhook",
        "description": "Trello webhook for board changes",
    },
    "asana.com": {
        "name": "Asana",
        "type": "asana_webhook",
        "description": "Asana webhook for task events",
    },
    "jira.atlassian.com": {
        "name": "Jira",
        "type": "jira_webhook",
        "description": "Jira webhook for issue events",
    },
    "figma.com": {
        "name": "Figma",
        "type": "figma_webhook",
        "description": "Figma webhook for design file events",
    },
    "stripe.com": {
        "name": "Stripe",
        "type": "stripe_webhook",
        "description": "Stripe webhook for payment events",
    },
    "polar.sh": {
        "name": "Polar",
        "type": "polar_webhook",
        "description": "Polar webhook for subscription events",
    },
}


def _build_instinct_content(instinct: dict[str, Any]) -> str:
    """Build markdown content for an instinct record (rich schema).

    Mirrors the schema used by ``src.activities.vault._build_instinct_content``
    so all instinct records stay consistent.
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    name = instinct.get("name", "Unnamed Instinct")
    description = instinct.get("description", "")
    obs_count = instinct.get("observation_count", 0)
    # discretion_threshold intentionally NOT seeded — see packs_opus.py
    # for the rationale. Runtime falls back to the obs-count formula.
    weights = instinct.get("matching_weights", {
        "domain": 0.30, "keywords": 0.30,
        "input_type": 0.15, "attachment": 0.15, "tags": 0.10,
    })
    confidence_score = instinct.get("confidence_score", 0.0)
    observations = instinct.get("observations", [])
    tags = instinct.get("tags", [])

    input_patterns = instinct.get("input_patterns", {
        "sender_domains": [],
        "subject_keywords": [],
        "attachment_types": [],
        "input_types": [],
    })

    routing_rule = instinct.get("routing_rule", {
        "destination_type": "project",
        "destination": "",
        "destination_resolver": None,
        "process": "",
        "default_assignee": "",
    })

    if observations:
        obs_entries = []
        for ref in observations:
            if ref.startswith("[["):
                obs_entries.append(f'  - "{ref}"')
            else:
                obs_entries.append(f'  - "[[{ref}]]"')
        obs_lines = "\n".join(obs_entries)
    else:
        obs_lines = "  []"

    resolver = routing_rule.get("destination_resolver")
    resolver_yaml = "null" if resolver is None else f'"{resolver}"'

    # C-OB4: surface tier + discretion_threshold + status when the caller
    # applied the day-zero caps (_apply_unearned_caps in packs_opus). The
    # legacy default ('status: active') is kept for non-onboarding paths
    # that never set status.
    status = str(instinct.get("status", "active")).strip().lower() or "active"
    tier = str(instinct.get("tier", "")).strip()
    discretion_threshold = instinct.get("discretion_threshold")
    extra_fm: list[str] = []
    if tier:
        extra_fm.append(f"tier: {tier}")
    if isinstance(discretion_threshold, (int, float)):
        extra_fm.append(f"discretion_threshold: {float(discretion_threshold)}")
    extra_fm_block = ("\n" + "\n".join(extra_fm)) if extra_fm else ""

    return f"""---
type: instinct
name: {name}
status: {status}
description: "{description}"
input_patterns:
  sender_domains: {input_patterns.get("sender_domains", [])}
  subject_keywords: {input_patterns.get("subject_keywords", [])}
  attachment_types: {input_patterns.get("attachment_types", [])}
  input_types: {input_patterns.get("input_types", [])}
routing_rule:
  destination_type: {routing_rule.get("destination_type", "project")}
  destination: "{routing_rule.get("destination", "")}"
  destination_resolver: {resolver_yaml}
  process: "{routing_rule.get("process", "")}"
  default_assignee: "{routing_rule.get("default_assignee", "")}"
confidence_score: {confidence_score}
observation_count: {obs_count}
observations:
{obs_lines}
last_reflection: {now}
matching_weights:
  domain: {weights.get("domain", 0.30)}
  keywords: {weights.get("keywords", 0.30)}
  input_type: {weights.get("input_type", 0.15)}
  attachment: {weights.get("attachment", 0.15)}
  tags: {weights.get("tags", 0.10)}
created: {now}
updated: {now}
tags: {tags}{extra_fm_block}
---

## Routing Logic
{instinct.get("routing_logic", "Route matching inputs to " + routing_rule.get("destination", ""))}

## Exceptions
{instinct.get("exceptions", "None defined yet.")}
"""


# ---------------------------------------------------------------------------
# Activities
# ---------------------------------------------------------------------------

@activity.defn
async def generate_stream_pack(onboard_path: str) -> dict[str, Any]:
    """Suggest streams based on detected email domains in the profiler output.

    Writes ``suggested_streams`` into onboard.json but does NOT create the
    streams — that is left to a later confirmation step.
    """
    profile = _load_profile(onboard_path)
    activity.heartbeat("loaded profile for stream detection")

    sender_tiers = _normalize_sender_tiers(profile)

    # Collect all domains from sender tiers and financial services
    detected_domains: set[str] = set()

    # From sender_tiers — keys are tier names, values are lists of senders
    for tier_name, senders in sender_tiers.items():
        for sender in senders:
            domain = sender.get("domain", "")
            if domain:
                detected_domains.add(domain.lower())

    # From financial.detected_services
    for svc in profile.get("financial", {}).get("detected_services", []):
        domain = svc.get("domain", "") if isinstance(svc, dict) else str(svc)
        if domain:
            detected_domains.add(domain.lower())

    activity.heartbeat("scanning %d domains for stream matches" % len(detected_domains))

    suggested: list[dict[str, str]] = []
    seen_types: set[str] = set()

    for domain in sorted(detected_domains):
        # Check exact match first
        match = _STREAM_DOMAIN_MAP.get(domain)
        if not match:
            # Check if domain ends with a known key (e.g. "noreply@github.com" → "github.com")
            for known_domain, mapping in _STREAM_DOMAIN_MAP.items():
                if domain.endswith(known_domain) or known_domain in domain:
                    match = mapping
                    break

        if match and match["type"] not in seen_types:
            suggested.append({
                "name": match["name"],
                "type": match["type"],
                "description": match["description"],
                "detected_from_domain": domain,
            })
            seen_types.add(match["type"])

    _save_onboard_key(onboard_path, "suggested_streams", suggested)

    return {"suggested": len(suggested)}


@activity.defn
async def generate_matter_pack(onboard_path: str) -> dict[str, Any]:
    """Degraded-mode no-op fallback for the matter pack.

    Pre-2026-05-23 this generator wrote ``matter/<domain>-project.md``
    stubs ("Github Project", "Stripe Project", …) keyed off
    ``profile.sender_tiers`` — a bare domain count is machine bookkeeping
    and does NOT satisfy the promotion contract ("the principal reads
    this", per ``CLAUDE.md`` §Storage Architecture). Live runs showed
    eight such stubs leaking into the vault next to the gold Opus
    matters; ``docs/GENERATORS.md`` §6 labels the path KILL.

    The Opus generator (``packs_opus.generate_matter_pack_opus``) is
    GOLD and remains the only path that produces vault matter records.
    This fallback is kept callable so the existing Opus-side fallback
    chain still has something to invoke on a 402/parse/no-context path,
    but it writes NOTHING to the vault — instead it logs a degraded
    marker and returns ``{"created": 0, "degraded": True}`` so the
    caller's response carries the gap visibly.

    A future commit can route the degraded marker into
    ``alfred-state.db.observation`` for forensic introspection; today
    the contract is "no vault write here, ever".

    The dedup primitives the live writers use (``search_records`` /
    ``record_exists`` + ``skipped_existing`` accounting) live in
    ``generate_errand_pack`` below and in ``packs_opus.py``; this no-op
    fallback obviously has no records to dedup.
    """
    activity.heartbeat("matter pack fallback entered (no-op, degraded mode)")
    # Best-effort profile peek so the log carries the candidate count we
    # would have written, for ops/observability. We do NOT touch the
    # vault.
    try:
        profile = _load_profile(onboard_path)
        sender_tiers = _normalize_sender_tiers(profile)
        candidate_domains = {
            (s.get("domain") or "").lower()
            for senders in sender_tiers.values() if isinstance(senders, list)
            for s in senders if isinstance(s, dict) and s.get("domain")
        }
        candidate_domains.discard("")
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        candidate_domains = set()

    activity.heartbeat(
        "matter pack fallback: %d candidate domains skipped (degraded)"
        % len(candidate_domains)
    )
    return {
        "created": 0,
        "skipped_existing": 0,
        "degraded": True,
        "degraded_reason": "matter_pack_fallback_disabled",
        "candidate_domains": sorted(candidate_domains),
    }


@activity.defn
async def generate_instinct_pack(onboard_path: str) -> dict[str, Any]:
    """Create instinct vault records for clear routing patterns.

    Derives instincts from sender tier classifications and financial anomalies:
    - Noise tier domains -> tier2 stream-log
    - Newsletter tier domains -> tier2 stream-log
    - Inner circle -> priority, immediate triage
    - Financial + failed/declined -> urgent task

    Day-zero instincts are NOT seeded with a discretion_threshold or a
    fake observation_count: they start at Asking (0 observations) and
    earn autonomy as real decision-sourced observations accumulate. See
    src/matching/discretion.py and packs_opus.py for the rationale.
    Creates 3-10 records.
    """
    profile = _load_profile(onboard_path)
    activity.heartbeat("loaded profile for instinct generation")

    config = load_config()
    client = VaultClient(config)
    try:
        created = 0
        sender_tiers = _normalize_sender_tiers(profile)
        payment_issues = profile.get("financial", {}).get("payment_issues", [])

        # --- Noise tier instincts ---
        noise_senders = sender_tiers.get("noise", [])
        if isinstance(noise_senders, list) and noise_senders:
            noise_domains = list({
                s.get("domain", "").lower()
                for s in noise_senders
                if isinstance(s, dict) and s.get("domain")
            })[:10]

            if noise_domains:
                instinct = {
                    "name": "route-noise-to-log",
                    "description": "Auto-route noise-tier senders to stream log",
                    "input_patterns": {
                        "sender_domains": noise_domains,
                        "subject_keywords": [],
                        "attachment_types": [],
                        "input_types": ["email"],
                    },
                    "routing_rule": {
                        "destination_type": "stream",
                        "destination": "tier2 stream-log",
                        "destination_resolver": None,
                        "process": "archive",
                        "default_assignee": "",
                    },
                    "confidence_score": 0.9,
                    "observation_count": 0,
                    "tags": ["onboarding", "noise", "auto-generated"],
                    "routing_logic": "Route noise-tier senders directly to stream log without triage.",
                }
                # C-OB4 cap before write (Asking/unconfirmed/<=0.4/>=0.7).
                from src.activities.packs_opus import _apply_unearned_caps
                _apply_unearned_caps(instinct)
                content = _build_instinct_content(instinct)
                await client.write_record("instinct", "route-noise-to-log", content)
                created += 1

        activity.heartbeat("noise instincts done")

        # --- Newsletter tier instincts ---
        newsletter_senders = sender_tiers.get("newsletter", sender_tiers.get("newsletters", []))
        if isinstance(newsletter_senders, list) and newsletter_senders:
            newsletter_domains = list({
                s.get("domain", "").lower()
                for s in newsletter_senders
                if isinstance(s, dict) and s.get("domain")
            })[:10]

            if newsletter_domains:
                instinct = {
                    "name": "route-newsletters-to-log",
                    "description": "Auto-route newsletter senders to stream log",
                    "input_patterns": {
                        "sender_domains": newsletter_domains,
                        "subject_keywords": [],
                        "attachment_types": [],
                        "input_types": ["email"],
                    },
                    "routing_rule": {
                        "destination_type": "stream",
                        "destination": "tier2 stream-log",
                        "destination_resolver": None,
                        "process": "digest",
                        "default_assignee": "",
                    },
                    "confidence_score": 0.85,
                    "observation_count": 0,
                    "tags": ["onboarding", "newsletter", "auto-generated"],
                    "routing_logic": "Route newsletter senders to stream log for daily digest.",
                }
                from src.activities.packs_opus import _apply_unearned_caps
                _apply_unearned_caps(instinct)
                content = _build_instinct_content(instinct)
                await client.write_record("instinct", "route-newsletters-to-log", content)
                created += 1

        activity.heartbeat("newsletter instincts done")

        # --- Inner circle instincts ---
        inner_senders = sender_tiers.get("inner_circle", sender_tiers.get("inner-circle", []))
        if isinstance(inner_senders, list) and inner_senders:
            inner_domains = list({
                s.get("domain", "").lower()
                for s in inner_senders
                if isinstance(s, dict) and s.get("domain")
            })[:10]

            if inner_domains:
                instinct = {
                    "name": "route-inner-circle-priority",
                    "description": "Prioritize inner-circle contacts for immediate triage",
                    "input_patterns": {
                        "sender_domains": inner_domains,
                        "subject_keywords": [],
                        "attachment_types": [],
                        "input_types": ["email"],
                    },
                    "routing_rule": {
                        "destination_type": "triage",
                        "destination": "priority, immediate triage",
                        "destination_resolver": None,
                        "process": "urgent-triage",
                        "default_assignee": "",
                    },
                    "confidence_score": 0.95,
                    "observation_count": 0,
                    "tags": ["onboarding", "inner-circle", "auto-generated"],
                    "routing_logic": "Route inner-circle contacts to immediate triage queue.",
                }
                from src.activities.packs_opus import _apply_unearned_caps
                _apply_unearned_caps(instinct)
                content = _build_instinct_content(instinct)
                await client.write_record("instinct", "route-inner-circle-priority", content)
                created += 1

        activity.heartbeat("inner circle instincts done")

        # --- Financial failure instincts ---
        if payment_issues:
            failed_domains = list({
                issue.get("domain", "").lower()
                for issue in payment_issues
                if isinstance(issue, dict) and issue.get("domain")
            })[:5]

            failed_keywords = ["failed", "declined", "overdue", "past due", "payment failed"]

            if failed_domains:
                instinct = {
                    "name": "route-payment-failures-urgent",
                    "description": "Flag payment failures and declined transactions as urgent tasks",
                    "input_patterns": {
                        "sender_domains": failed_domains,
                        "subject_keywords": failed_keywords,
                        "attachment_types": [],
                        "input_types": ["email"],
                    },
                    "routing_rule": {
                        "destination_type": "task",
                        "destination": "urgent task",
                        "destination_resolver": None,
                        "process": "urgent-review",
                        "default_assignee": "",
                    },
                    "confidence_score": 0.8,
                    "observation_count": 0,
                    "tags": ["onboarding", "financial", "urgent", "auto-generated"],
                    "routing_logic": "Route payment failure notifications to urgent task queue.",
                }
                from src.activities.packs_opus import _apply_unearned_caps
                _apply_unearned_caps(instinct)
                content = _build_instinct_content(instinct)
                await client.write_record("instinct", "route-payment-failures-urgent", content)
                created += 1

        activity.heartbeat("financial instincts done")

        # C-OB4: the legacy per-domain branch (`route-<tier>-<domain>`
        # stubs from sender-tier discovery) is SKIPPED at observation
        # count = 0. A per-domain instinct has zero grounding to lean
        # on at seeding — it must come from observed decisions, not from
        # a profiler heuristic. The 4 canned instincts above are the
        # only rule-based instincts that may seed.
        activity.heartbeat(
            "per-domain instinct branch skipped (C-OB4: obs=0 grounding)"
        )

        activity.heartbeat("instinct pack complete: %d created" % created)
        return {"created": created}
    finally:
        await client.close()


@activity.defn
async def generate_errand_pack(onboard_path: str) -> dict[str, Any]:
    """Create task vault records for recurring patterns detected in email rhythm.

    Each task has: name, status "pending", recurrence hint in description,
    and a related matter if detectable.  Creates 2-5 records.
    """
    profile = _load_profile(onboard_path)
    activity.heartbeat("loaded profile for errand generation")

    config = load_config()
    client = VaultClient(config)
    try:
        routines = profile.get("rhythm", {}).get("detected_routines", [])
        created = 0

        for routine in routines[:5]:
            if not isinstance(routine, dict):
                continue

            name = routine.get("name", routine.get("label", ""))
            if not name:
                continue

            slug = _slugify(name)
            frequency = routine.get("frequency", routine.get("recurrence", "unknown"))
            description = routine.get("description", "")
            related_matter = routine.get("related_matter", routine.get("domain", ""))
            day_hint = routine.get("day", routine.get("preferred_day", ""))
            time_hint = routine.get("time", routine.get("preferred_time", ""))

            now = datetime.now(timezone.utc).strftime("%Y-%m-%d")

            recurrence_parts = [f"**Recurrence:** {frequency}"]
            if day_hint:
                recurrence_parts.append(f"**Preferred day:** {day_hint}")
            if time_hint:
                recurrence_parts.append(f"**Preferred time:** {time_hint}")
            recurrence_block = "\n".join(recurrence_parts)

            matter_line = ""
            if related_matter:
                matter_line = f"related_matter: {related_matter}\n"

            content = f"""---
type: task
name: {name}
status: pending
created: {now}
{matter_line}recurrence: {frequency}
tags: [onboarding, errand, auto-generated]
---

# {name}

{description}

{recurrence_block}

Auto-generated errand from onboarding email rhythm analysis.
"""
            await client.write_record("task", slug, content)
            created += 1

        activity.heartbeat("errand pack complete: %d created" % created)
        return {"created": created}
    finally:
        await client.close()
