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
    """Load onboard.json and return the profile sub-dict."""
    with open(onboard_path, "r") as f:
        data: dict[str, Any] = json.load(f)
    return data.get("profile", {})


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
    threshold = instinct.get("discretion_threshold", 0.95)
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

    return f"""---
type: instinct
name: {name}
status: active
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
discretion_threshold: {threshold}
created: {now}
updated: {now}
tags: {tags}
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

    # Collect all domains from sender tiers and financial services
    detected_domains: set[str] = set()

    # From sender_tiers — keys are tier names, values are lists of senders
    for tier_name, senders in profile.get("sender_tiers", {}).items():
        if isinstance(senders, list):
            for sender in senders:
                domain = sender.get("domain", "") if isinstance(sender, dict) else ""
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
    """Create matter/project vault records for detected work domains.

    Groups by client domains, personal domains, and service domains.
    Names are inferred from domain + most common subject keywords.
    Deduplicates against existing vault records before creating.
    Creates 3-8 records.
    """
    profile = _load_profile(onboard_path)
    activity.heartbeat("loaded profile for matter generation")

    config = load_config()
    client = VaultClient(config)
    try:
        # Gather domain clusters from sender_tiers
        domain_groups: dict[str, dict[str, Any]] = {}  # domain → info

        for tier_name, senders in profile.get("sender_tiers", {}).items():
            if not isinstance(senders, list):
                continue
            for sender in senders:
                if not isinstance(sender, dict):
                    continue
                domain = sender.get("domain", "").lower()
                if not domain:
                    continue
                if domain not in domain_groups:
                    domain_groups[domain] = {
                        "tier": tier_name,
                        "count": 0,
                        "subjects": [],
                        "senders": [],
                    }
                domain_groups[domain]["count"] += sender.get("count", 1)
                domain_groups[domain]["senders"].append(
                    sender.get("address", sender.get("name", ""))
                )
                for kw in sender.get("subject_keywords", []):
                    domain_groups[domain]["subjects"].append(kw)

        # Also gather from relationships (top correspondents)
        for rel in profile.get("relationships", []):
            if not isinstance(rel, dict):
                continue
            domain = rel.get("domain", "").lower()
            if not domain:
                continue
            if domain not in domain_groups:
                domain_groups[domain] = {
                    "tier": "relationship",
                    "count": rel.get("email_count", 1),
                    "subjects": rel.get("common_topics", []),
                    "senders": [rel.get("name", rel.get("email", ""))],
                }

        activity.heartbeat("detected %d domain groups" % len(domain_groups))

        # Filter: skip known service/noise domains
        _SKIP_DOMAINS = {
            "gmail.com", "yahoo.com", "hotmail.com", "outlook.com",
            "googlemail.com", "icloud.com", "me.com", "live.com",
            "noreply.github.com",
        }
        candidates = {
            d: info for d, info in domain_groups.items()
            if d not in _SKIP_DOMAINS
            and not d.startswith("noreply")
            and info["count"] >= 2
        }

        # Sort by email count descending, take top 8
        sorted_domains = sorted(
            candidates.items(), key=lambda x: x[1]["count"], reverse=True
        )[:8]

        created = 0
        skipped_existing = 0

        for domain, info in sorted_domains:
            # Derive a human-readable name
            subjects = info.get("subjects", [])
            if subjects:
                # Most common keyword as descriptor
                from collections import Counter
                kw_counts = Counter(subjects)
                top_kw = kw_counts.most_common(1)[0][0]
                matter_name = f"{domain.split('.')[0].title()} — {top_kw.title()}"
            else:
                matter_name = f"{domain.split('.')[0].title()} Project"

            slug = _slugify(matter_name)

            # Dedup: search vault for existing record
            existing = await client.search_records(slug, record_type="matter")
            if existing:
                skipped_existing += 1
                continue

            now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            tier = info.get("tier", "unknown")
            senders_list = ", ".join(info.get("senders", [])[:5])

            content = f"""---
type: matter
name: {matter_name}
status: active
domain: {domain}
tier: {tier}
created: {now}
---

# {matter_name}

**Domain:** {domain}
**Detected tier:** {tier}
**Key contacts:** {senders_list}

Auto-generated from onboarding email analysis.
"""
            await client.write_record("matter", slug, content)
            created += 1

            if created >= 8:
                break

        activity.heartbeat("matter pack complete: %d created, %d skipped" % (created, skipped_existing))
        return {"created": created, "skipped_existing": skipped_existing}
    finally:
        await client.close()


@activity.defn
async def generate_instinct_pack(onboard_path: str) -> dict[str, Any]:
    """Create instinct vault records for clear routing patterns.

    Derives instincts from sender tier classifications and financial anomalies:
    - Noise tier domains -> tier2 stream-log
    - Newsletter tier domains -> tier2 stream-log
    - Inner circle -> priority, immediate triage
    - Financial + failed/declined -> urgent task

    High-confidence patterns get discretion_threshold 0.85, lower get 0.95.
    Creates 3-10 records.
    """
    profile = _load_profile(onboard_path)
    activity.heartbeat("loaded profile for instinct generation")

    config = load_config()
    client = VaultClient(config)
    try:
        created = 0
        sender_tiers = profile.get("sender_tiers", {})
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
                    "discretion_threshold": 0.85,
                    "confidence_score": 0.9,
                    "observation_count": len(noise_senders),
                    "tags": ["onboarding", "noise", "auto-generated"],
                    "routing_logic": "Route noise-tier senders directly to stream log without triage.",
                }
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
                    "discretion_threshold": 0.85,
                    "confidence_score": 0.85,
                    "observation_count": len(newsletter_senders),
                    "tags": ["onboarding", "newsletter", "auto-generated"],
                    "routing_logic": "Route newsletter senders to stream log for daily digest.",
                }
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
                    "discretion_threshold": 0.85,
                    "confidence_score": 0.95,
                    "observation_count": len(inner_senders),
                    "tags": ["onboarding", "inner-circle", "auto-generated"],
                    "routing_logic": "Route inner-circle contacts to immediate triage queue.",
                }
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
                    "discretion_threshold": 0.95,
                    "confidence_score": 0.8,
                    "observation_count": len(payment_issues),
                    "tags": ["onboarding", "financial", "urgent", "auto-generated"],
                    "routing_logic": "Route payment failure notifications to urgent task queue.",
                }
                content = _build_instinct_content(instinct)
                await client.write_record("instinct", "route-payment-failures-urgent", content)
                created += 1

        activity.heartbeat("financial instincts done")

        # --- Per-domain instincts for remaining high-volume senders ---
        # Create individual instincts for domains with many emails that
        # don't fall into the above categories.
        _covered_tiers = {"noise", "newsletter", "newsletters", "inner_circle", "inner-circle"}
        for tier_name, senders in sender_tiers.items():
            if tier_name in _covered_tiers:
                continue
            if not isinstance(senders, list):
                continue
            # Group by domain
            domain_senders: dict[str, list[dict[str, Any]]] = {}
            for s in senders:
                if not isinstance(s, dict):
                    continue
                d = s.get("domain", "").lower()
                if d:
                    domain_senders.setdefault(d, []).append(s)

            for domain, dom_senders in domain_senders.items():
                if created >= 10:
                    break
                if len(dom_senders) < 3:
                    continue

                slug = _slugify(f"route-{tier_name}-{domain.split('.')[0]}")
                instinct = {
                    "name": slug,
                    "description": f"Route {tier_name}-tier emails from {domain}",
                    "input_patterns": {
                        "sender_domains": [domain],
                        "subject_keywords": [],
                        "attachment_types": [],
                        "input_types": ["email"],
                    },
                    "routing_rule": {
                        "destination_type": "project",
                        "destination": f"{tier_name} triage",
                        "destination_resolver": None,
                        "process": "standard",
                        "default_assignee": "",
                    },
                    "discretion_threshold": 0.95,
                    "confidence_score": 0.7,
                    "observation_count": len(dom_senders),
                    "tags": ["onboarding", tier_name, "auto-generated"],
                    "routing_logic": f"Route {domain} emails to {tier_name} triage.",
                }
                content = _build_instinct_content(instinct)
                await client.write_record("instinct", slug, content)
                created += 1

            if created >= 10:
                break

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
