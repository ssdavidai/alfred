"""assign_initial_chores — onboarding activity that creates chores from the profile.

Runs at the end of onboarding (Stage 7.5, after the four packs). Pure Python:
looks at the user's profile and decides which chore templates to activate with
what parameters. Writes vault chore records and creates Temporal schedules via
the existing ctrl-api POST /api/v1/schedules endpoint.

Adding a new template's onboarding rule is a code change in this module
(inside _decide_chores) — not a vault edit.

Design contract:
- No LLM calls. Deciding which chores to activate is deterministic matching
  against profile features. If future iterations want LLM-assisted param
  refinement, that should be added as a separate optional activity.
- Chore vault records store `params` as a JSON-encoded string scalar, because
  the ctrl-api vault.ts frontmatter parser is flat-only and flattens nested
  YAML mappings. The _base.load_chore_context helper decodes the JSON back
  into a dict on read.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Template registry — maps chore template ids to Temporal workflow type names.
# Adding a new template requires (1) creating the workflow under
# src/workflows/chores/, (2) exporting it from chores/__init__.py, and
# (3) adding an entry here.
# ---------------------------------------------------------------------------

_TEMPLATE_TO_WORKFLOW = {
    "subscription_watcher": "SubscriptionWatcherWorkflow",
    "weekly_matter_digest": "WeeklyMatterDigestWorkflow",
}


def _template_to_workflow_name(template_id: str) -> str:
    if template_id not in _TEMPLATE_TO_WORKFLOW:
        raise ValueError(f"Unknown chore template: {template_id}")
    return _TEMPLATE_TO_WORKFLOW[template_id]


def _resolve_workflow_type(chore: dict[str, Any]) -> str:
    """Return the Temporal workflow type name for a chore spec.

    Generated chores (from S4-8 onwards) carry an explicit
    `workflow_class_name` field set by the generation pipeline. Standard
    library chores use the `template` field mapped through
    _template_to_workflow_name. This helper picks the right path.
    """
    wf_class = chore.get("workflow_class_name")
    if isinstance(wf_class, str) and wf_class.strip():
        return wf_class.strip()
    return _template_to_workflow_name(chore["template"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _slugify(name: str) -> str:
    s = name.lower()
    s = re.sub(r"[_\s]+", "-", s)
    s = re.sub(r"[^a-z0-9-]", "", s)
    s = re.sub(r"-+", "-", s)
    return s.strip("-")


def _quote_yaml_scalar(value: str) -> str:
    """Return a single-quoted YAML scalar with embedded single quotes escaped.

    Used so we can embed JSON strings (which contain double quotes) inside
    the chore record's frontmatter without the vault.ts parser mangling them.
    """
    return "'" + value.replace("'", "''") + "'"


# ---------------------------------------------------------------------------
# Profile-derived param helpers (Step 1 of the bespoke chore plan)
#
# These helpers derive bespoke schedules, thresholds, and notification
# channels from the behavioral profiler's output instead of using hardcoded
# defaults. The profile fields we read are:
#   profile.rhythm.work_end_estimate       int hour 0-23 (UTC)
#   profile.rhythm.peak_hours              list[int] top hours 0-23
#   profile.rhythm.weekend_activity_ratio  float 0-1
#   profile.relationships.communication_style   enum
#   profile.summary.communication_style    enum (alternative location)
#   profile.meta.email_count               int
#
# All helpers fall back to safe defaults when the relevant profile fields
# are missing or have unexpected shapes, so onboarding never breaks because
# of a sparse profile.
# ---------------------------------------------------------------------------

# Cron DOW values — 0=Sunday, 1=Monday, ..., 5=Friday, 6=Saturday
_CRON_DOW_SUNDAY = 0
_CRON_DOW_FRIDAY = 5

# Default hours (UTC) used when the profile doesn't give us a signal
_DEFAULT_SUBSCRIPTION_HOUR_UTC = 9
_DEFAULT_DIGEST_HOUR_UTC = 18

# Clamp hours to "reasonable" waking window so we don't schedule 3am alerts
_HOUR_MIN_CLAMP = 8
_HOUR_MAX_CLAMP = 22


def _clamp_hour(hour: int) -> int:
    """Clamp a UTC hour to the 8-22 waking window."""
    return max(_HOUR_MIN_CLAMP, min(_HOUR_MAX_CLAMP, int(hour)))


def _derive_chore_schedule(template_id: str, profile: dict[str, Any]) -> str:
    """Return a cron expression tailored to the user's rhythm profile.

    Used for the two standard-library templates (`subscription_watcher` and
    `weekly_matter_digest`) where the schedule is baked into the template
    behavior rather than emitted per-user by a generator. For generator-authored
    templates, the LLM emits a schedule in its envelope and the caller in
    `_build_generated_chore_spec` prefers that; this function is only hit as
    a fallback if the envelope was missing the schedule field.

    For weekly chores, the hour is derived from `profile.rhythm.work_end_estimate`
    (the user stops work, then Alfred surfaces things soon after when they
    have time to look). The day is template-specific:
      - subscription_watcher: Friday (end of the work week)
      - weekly_matter_digest: Sunday if weekend activity is high, else Friday

    If the profile has no rhythm data at all, falls back to the old
    hardcoded defaults (`0 9 * * 5` for subscription, `0 18 * * 0` for digest).

    For unknown template_ids (e.g. generator-authored templates whose envelope
    was missing a schedule), returns the Sunday-18:00-UTC default as a
    conservative last resort. The caller logs a warning in that branch.
    """
    rhythm = profile.get("rhythm") or {}
    work_end = rhythm.get("work_end_estimate")
    weekend_ratio = rhythm.get("weekend_activity_ratio")

    if template_id == "subscription_watcher":
        # Fire Friday, just after work ends (so the user can review before weekend)
        if isinstance(work_end, int):
            hour = _clamp_hour(work_end + 1)
        else:
            hour = _DEFAULT_SUBSCRIPTION_HOUR_UTC
        return f"0 {hour} * * {_CRON_DOW_FRIDAY}"

    if template_id == "weekly_matter_digest":
        # Sunday if user works weekends too (≥30% activity ratio); else Friday end-of-day
        if isinstance(weekend_ratio, (int, float)) and float(weekend_ratio) >= 0.3:
            day = _CRON_DOW_SUNDAY
        else:
            day = _CRON_DOW_FRIDAY
        if isinstance(work_end, int):
            # Digest arrives a bit later than subscription watcher so it's read
            # at end of day rather than mid-transition.
            hour = _clamp_hour(work_end + 2)
        else:
            hour = _DEFAULT_DIGEST_HOUR_UTC
        return f"0 {hour} * * {day}"

    # Unknown template — fall back to the digest default
    return f"0 {_DEFAULT_DIGEST_HOUR_UTC} * * {_CRON_DOW_SUNDAY}"


# Communication style → alert threshold mapping. Per the plan:
#   selective → 0.85 (user prefers silence, only bother if very confident)
#   responsive → 0.70 (default — user responds when bothered)
#   batched → 0.55 (user wants to see more at once, looser threshold)
#   sparse → 0.90 (user rarely engages — don't poke them unless critical)
_COMMUNICATION_STYLE_TO_THRESHOLD: dict[str, float] = {
    "selective": 0.85,
    "responsive": 0.70,
    "batched": 0.55,
    "sparse": 0.90,
}

_DEFAULT_ALERT_THRESHOLD = 0.70


def _read_communication_style(profile: dict[str, Any]) -> str:
    """Return the user's communication style from the profile, or '' if unknown.

    The profiler exposes this in two places. We check both:
      1. profile.relationships.communication_style (canonical)
      2. profile.summary.communication_style (pre-computed for LLM prompts)
    """
    rel = profile.get("relationships") or {}
    if isinstance(rel, dict):
        style = rel.get("communication_style")
        if isinstance(style, str) and style:
            return style
    summary = profile.get("summary") or {}
    if isinstance(summary, dict):
        style = summary.get("communication_style")
        if isinstance(style, str) and style:
            return style
    return ""


def _derive_alert_threshold(template_id: str, profile: dict[str, Any]) -> float:
    """Return a bespoke alert threshold based on the user's communication style.

    Currently only used by subscription_watcher. Unknown templates get the
    default threshold. Unknown communication style also gets the default.
    """
    if template_id != "subscription_watcher":
        return _DEFAULT_ALERT_THRESHOLD
    style = _read_communication_style(profile)
    return _COMMUNICATION_STYLE_TO_THRESHOLD.get(style, _DEFAULT_ALERT_THRESHOLD)


# Email volume thresholds for digest event-count gating
_HIGH_VOLUME_EMAIL_COUNT = 2000
_MEDIUM_VOLUME_EMAIL_COUNT = 500

_MIN_EVENTS_HIGH = 5
_MIN_EVENTS_MEDIUM = 3
_MIN_EVENTS_LOW = 2
_DEFAULT_MIN_EVENTS = 3


def _derive_min_events_for_digest(profile: dict[str, Any]) -> int:
    """Return the minimum event count before a weekly digest fires.

    Scales with total email volume — high-volume users get a higher bar
    (so digests are meaningful) while low-volume users get a lower bar
    (so they still get a digest when anything meaningful happens).
    """
    meta = profile.get("meta") or {}
    email_count = meta.get("email_count") if isinstance(meta, dict) else None
    if not isinstance(email_count, int):
        return _DEFAULT_MIN_EVENTS
    if email_count >= _HIGH_VOLUME_EMAIL_COUNT:
        return _MIN_EVENTS_HIGH
    if email_count >= _MEDIUM_VOLUME_EMAIL_COUNT:
        return _MIN_EVENTS_MEDIUM
    return _MIN_EVENTS_LOW


def _infer_default_session_id(profile: dict[str, Any]) -> str:
    """Return the OpenClaw session id chores should deliver notifications to.

    Today every tenant has exactly one agent session named "main", so this
    is a no-op that always returns "main". It exists as a hook for future
    work: once per-user channel routing ships, this helper will inspect
    connected streams (telegram, slack, email) and pick the user's
    preferred notification session.
    """
    # Suppress lint on unused parameter — it's part of the future contract.
    _ = profile
    return "main"


# ---------------------------------------------------------------------------
# Decision logic — pure Python matching, no LLM
# ---------------------------------------------------------------------------

def _decide_chores(profile: dict[str, Any], facts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Decide which chores to activate for this user based on their profile.

    Returns a list of chore spec dicts, each with:
        template:    str                       # template id
        name:        str                       # human-readable chore name
        schedule:    str                       # cron expression
        params:      dict[str, Any]            # template-specific params (JSON-serializable)
        description: str                       # body text for the vault record
        tags:        list[str]                 # frontmatter tags
    """
    chores: list[dict[str, Any]] = []

    # -----------------------------------------------------------------------
    # 1. Subscription watcher
    # Activate if the user has a non-trivial financial footprint (multiple
    # detected services or at least one payment issue).
    # -----------------------------------------------------------------------
    financial = profile.get("financial") or {}
    detected_services = financial.get("detected_services") or []
    payment_issues = financial.get("payment_issues") or []
    sender_tiers = profile.get("sender_tiers") or {}
    service_tier = sender_tiers.get("service") or []

    financial_domains: set[str] = set()
    for entry in detected_services:
        if isinstance(entry, dict):
            d = (entry.get("domain") or "").lower()
            if d:
                financial_domains.add(d)
        elif isinstance(entry, str):
            financial_domains.add(entry.lower())
    for s in service_tier:
        if isinstance(s, dict):
            d = (s.get("domain") or "").lower()
            if d:
                financial_domains.add(d)
        elif isinstance(s, str):
            financial_domains.add(s.lower())

    if len(financial_domains) >= 5 or payment_issues:
        chores.append({
            "template": "subscription_watcher",
            "name": "Watch subscriptions",
            "schedule": _derive_chore_schedule("subscription_watcher", profile),
            "params": {
                "matter_domains": sorted(financial_domains)[:30],
                "alert_threshold": _derive_alert_threshold("subscription_watcher", profile),
                "session_id": _infer_default_session_id(profile),
            },
            "description": (
                "Reviews subscription billing weekly. Looks for failed charges, "
                "unexpected price increases, duplicate subscriptions, and abandoned "
                "services. Alerts only when something looks off."
            ),
            "tags": ["chore", "financial", "auto-generated"],
        })

    # -----------------------------------------------------------------------
    # 2. Weekly matter digests — top 3 matters by email_count
    #
    # The behavioral profiler exposes correspondents under
    # profile.relationships.top_correspondents (a list of dicts with
    # {name, domain, email_count, ...}). We also tolerate the legacy shape
    # where profile.relationships is itself a flat list of correspondent
    # dicts, in case the profiler schema changes.
    # -----------------------------------------------------------------------
    rel_block = profile.get("relationships") or []
    if isinstance(rel_block, dict):
        correspondents = rel_block.get("top_correspondents") or []
    elif isinstance(rel_block, list):
        correspondents = rel_block
    else:
        correspondents = []
    # Skip noisy generic personal-mail domains — they aren't useful matters.
    _SKIP_REL_DOMAINS = {
        "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com",
        "outlook.com", "icloud.com", "me.com", "live.com",
    }
    top_relationships = sorted(
        [
            r for r in correspondents
            if isinstance(r, dict)
            and (r.get("domain") or "").lower() not in _SKIP_REL_DOMAINS
        ],
        key=lambda r: int(r.get("email_count", 0) or 0),
        reverse=True,
    )[:3]
    seen_matter_slugs: set[str] = set()
    for rel in top_relationships:
        domain = (rel.get("domain") or "").lower()
        if not domain:
            continue
        name = rel.get("name") or domain.split(".")[0].title() or "matter"
        matter_slug = _slugify(name)
        if not matter_slug or matter_slug in seen_matter_slugs:
            continue
        seen_matter_slugs.add(matter_slug)
        chores.append({
            "template": "weekly_matter_digest",
            "name": f"Weekly digest — {name}",
            "schedule": _derive_chore_schedule("weekly_matter_digest", profile),
            "params": {
                "matter_slug": matter_slug,
                "session_id": _infer_default_session_id(profile),
                "min_events_for_digest": _derive_min_events_for_digest(profile),
            },
            "description": (
                f"Once a week, summarizes everything that happened on the "
                f"{name} matter. Skips silent weeks."
            ),
            "tags": ["chore", "digest", "auto-generated"],
        })

    return chores


# ---------------------------------------------------------------------------
# Chore vault record rendering
# ---------------------------------------------------------------------------

def _build_chore_content(chore: dict[str, Any], schedule_id: str) -> str:
    """Render the chore vault record as a Markdown file with YAML frontmatter.

    Note the deliberate use of a JSON-encoded single-quoted scalar for
    `params` — this is required so the flat-only vault.ts frontmatter parser
    returns it as a usable string that the chore template can json.loads.

    Generated-template chores additionally carry:
      quarantine: true
      quarantine_remaining: 3
      generated: true
      workflow_class_name: <TheirGeneratedWorkflow>
    so S4-9's quarantine gate in _base.load_chore_context can enforce
    dry-run mode for the first 3 runs.
    """
    now = datetime.now(timezone.utc).isoformat()
    tags_yaml = "[" + ", ".join(chore.get("tags", ["chore"])) + "]"
    params_json = json.dumps(chore["params"], default=str, separators=(",", ":"))
    params_yaml = _quote_yaml_scalar(params_json)
    schedule_yaml = _quote_yaml_scalar(chore["schedule"])

    # Optional generation/quarantine metadata (only set for generated chores
    # from S4-8 onwards; standard library chores don't set these)
    generated = bool(chore.get("generated"))
    quarantine_lines = ""
    if generated:
        quarantine_lines = (
            f"generated: true\n"
            f"quarantine: true\n"
            f"quarantine_remaining: 3\n"
        )
        wf_class = chore.get("workflow_class_name")
        if isinstance(wf_class, str) and wf_class:
            quarantine_lines += f"workflow_class_name: {wf_class}\n"

    # C.1: user_facing_description is a plain-English explanation of what
    # the chore actually DOES (not what problem it solves). Set on both
    # generated chores (from the Opus envelope) and standard-library chores
    # if the caller passes one in. The Chores tab in Intelligence reads
    # this from frontmatter so we don't have to parse the body to render
    # the list view.
    user_facing_description = str(
        chore.get("user_facing_description", "") or ""
    ).strip()
    user_facing_lines = ""
    if user_facing_description:
        user_facing_lines = (
            f"user_facing_description: "
            f"{_quote_yaml_scalar(user_facing_description)}\n"
        )

    body_generated_note = ""
    if generated:
        body_generated_note = (
            "\n> **Generated chore.** This workflow was written specifically "
            "for you during onboarding by Opus. The first 3 runs execute in "
            "dry-run mode (no notifications, no vault writes) so we can "
            "confirm it behaves as expected before going live.\n"
        )

    # C.1: render the user-facing description as a "What this does" body
    # section right after the title, before the Run log. The Chores
    # detail page can either parse this section or just read the
    # frontmatter scalar.
    what_this_does = ""
    if user_facing_description:
        what_this_does = (
            f"\n## What this does\n\n"
            f"{user_facing_description}\n"
        )

    return (
        f"---\n"
        f"type: chore\n"
        f"name: {chore['name']}\n"
        f"status: active\n"
        f"template: {chore['template']}\n"
        f"schedule: {schedule_yaml}\n"
        f"schedule_id: {schedule_id}\n"
        f"params: {params_yaml}\n"
        f"{user_facing_lines}"
        f"{quarantine_lines}"
        f"created_by: onboarding_pipeline\n"
        f"created: {now}\n"
        f"last_run: null\n"
        f"last_result: null\n"
        f"tags: {tags_yaml}\n"
        f"---\n"
        f"\n"
        f"# {chore['name']}\n"
        f"\n"
        f"{chore['description']}\n"
        f"{body_generated_note}"
        f"{what_this_does}"
        f"\n"
        f"**Template:** `{chore['template']}`\n"
        f"**Schedule:** `{chore['schedule']}` (cron, UTC)\n"
        f"\n"
        f"## Run log\n"
    )


# ---------------------------------------------------------------------------
# Opportunity → template heuristic matcher (Step 2, PR S2-3)
#
# This is the interim heuristic that runs between Step 2 (brief generates
# structured opportunities) and Step 3 (Opus picks templates from the
# activity manifest). It keyword-matches an opportunity's goal/name/tags
# against each template's known domain to decide which template applies.
# Opportunities that don't match any template go to `unmatched_opportunities`
# in onboard.json for Step 4 to pick up (code generation).
#
# The heuristic is intentionally simple and easy to audit — it's a bridge,
# not a long-term solution.
# ---------------------------------------------------------------------------

# Keyword → template mapping. Each entry: template_id → list[str] keywords.
# Keywords are matched case-insensitively against the opportunity's name,
# goal, and description (all concatenated). First match wins.
_HEURISTIC_KEYWORD_MAP: list[tuple[str, list[str]]] = [
    # Financial / subscription patterns
    (
        "subscription_watcher",
        [
            "subscription", "invoice", "billing", "payment", "charge",
            "stripe", "polar", "mercury", "cash flow", "cash-flow",
            "price hike", "renewal", "recurring charge",
        ],
    ),
    # Weekly-digest patterns
    (
        "weekly_matter_digest",
        [
            "digest", "weekly summary", "weekly review", "weekly update",
            "matter", "project digest", "client summary",
        ],
    ),
]


def _build_opportunity_haystack(opportunity: dict[str, Any]) -> str:
    """Build the searchable text blob for keyword matching."""
    parts: list[str] = []
    for key in ("name", "goal", "description"):
        val = opportunity.get(key, "")
        if isinstance(val, str):
            parts.append(val)
    tags = opportunity.get("tags") or []
    if isinstance(tags, list):
        parts.extend(str(t) for t in tags if isinstance(t, str))
    return " \n ".join(parts).lower()


def _heuristic_match_opportunity(opportunity: dict[str, Any]) -> str | None:
    """Return the template id best matching this opportunity, or None.

    First-match-wins keyword scan against _HEURISTIC_KEYWORD_MAP.
    """
    haystack = _build_opportunity_haystack(opportunity)
    if not haystack:
        return None
    for template_id, keywords in _HEURISTIC_KEYWORD_MAP:
        for kw in keywords:
            if kw.lower() in haystack:
                return template_id
    return None


def _chore_spec_from_opportunity(
    opportunity: dict[str, Any],
    template_id: str,
    profile: dict[str, Any],
) -> dict[str, Any]:
    """Build a chore spec (for _build_chore_content) from a matched opportunity.

    Uses Step 1's profile-derived helpers for bespoke schedule/threshold/
    session_id defaults. The opportunity's name, description, and tags win
    over any template defaults because they were generated specifically
    for this user.
    """
    name = str(opportunity.get("name") or "Chore").strip() or "Chore"
    description = str(opportunity.get("description") or "").strip()
    tags = opportunity.get("tags") or []
    if not isinstance(tags, list):
        tags = []
    # Ensure "chore" and "auto-generated" are always present
    tag_set = {str(t) for t in tags if isinstance(t, str)}
    tag_set.update({"chore", "auto-generated"})

    spec: dict[str, Any] = {
        "template": template_id,
        "name": name,
        "schedule": _derive_chore_schedule(template_id, profile),
        "description": description or f"Generated from opportunity {opportunity.get('id', '')}",
        "tags": sorted(tag_set),
    }

    if template_id == "subscription_watcher":
        # matter_domains come from the profile's financial footprint since
        # the opportunity doesn't carry them directly in the schema today.
        financial = profile.get("financial") or {}
        sender_tiers = profile.get("sender_tiers") or {}
        financial_domains: set[str] = set()
        for entry in financial.get("detected_services") or []:
            if isinstance(entry, dict):
                d = (entry.get("domain") or "").lower()
                if d:
                    financial_domains.add(d)
            elif isinstance(entry, str):
                financial_domains.add(entry.lower())
        for s in sender_tiers.get("service") or []:
            if isinstance(s, dict):
                d = (s.get("domain") or "").lower()
                if d:
                    financial_domains.add(d)
            elif isinstance(s, str):
                financial_domains.add(s.lower())
        spec["params"] = {
            "matter_domains": sorted(financial_domains)[:30],
            "alert_threshold": _derive_alert_threshold("subscription_watcher", profile),
            "session_id": _infer_default_session_id(profile),
        }
    elif template_id == "weekly_matter_digest":
        # The matter_slug has to come from somewhere. If the opportunity
        # description mentions a specific matter, we try to slugify it;
        # otherwise we fall back to the opportunity's own id stripped of
        # generic prefixes. This is a heuristic — Step 3 will do this better.
        matter_slug = _extract_matter_slug_from_opportunity(opportunity)
        spec["params"] = {
            "matter_slug": matter_slug,
            "session_id": _infer_default_session_id(profile),
            "min_events_for_digest": _derive_min_events_for_digest(profile),
        }
    else:
        spec["params"] = {}

    return spec


def _extract_matter_slug_from_opportunity(opportunity: dict[str, Any]) -> str:
    """Best-effort: find a matter slug in the opportunity id/name/description.

    Looks for patterns like "weekly-foo-digest" (strips weekly- prefix and
    -digest suffix) or "foo-matter". Falls back to the opportunity id
    itself if no clean slug can be extracted.
    """
    opp_id = str(opportunity.get("id") or "")
    if opp_id:
        cleaned = opp_id
        for prefix in ("weekly-", "daily-", "monthly-"):
            if cleaned.startswith(prefix):
                cleaned = cleaned[len(prefix):]
                break
        for suffix in ("-digest", "-summary", "-review", "-matter"):
            if cleaned.endswith(suffix):
                cleaned = cleaned[: -len(suffix)]
                break
        if cleaned:
            return cleaned
    return opp_id or "unknown"


def _decide_chores_from_opportunities(
    opportunities: list[dict[str, Any]],
    profile: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Try to convert each opportunity into a chore spec.

    Returns (matched_chore_specs, unmatched_opportunities). Matched chores
    go through the normal vault-write + Temporal-schedule path; unmatched
    opportunities are persisted to onboard.json for Step 4 to generate
    templates for.
    """
    matched_chores: list[dict[str, Any]] = []
    unmatched: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for opp in opportunities:
        if not isinstance(opp, dict):
            continue
        template_id = _heuristic_match_opportunity(opp)
        if template_id is None:
            unmatched.append(
                {
                    "opportunity": opp,
                    "reason": "no template keyword match (step 2 heuristic)",
                }
            )
            continue
        spec = _chore_spec_from_opportunity(opp, template_id, profile)
        # De-duplicate by chore name (Opus sometimes proposes multiple
        # opportunities that reduce to the same template — we pick the first).
        if spec["name"] in seen_names:
            unmatched.append(
                {
                    "opportunity": opp,
                    "reason": f"duplicate chore name {spec['name']!r}",
                }
            )
            continue
        seen_names.add(spec["name"])
        matched_chores.append(spec)
    return matched_chores, unmatched


# ---------------------------------------------------------------------------
# Temporal schedule creation (via existing ctrl-api endpoint)
# ---------------------------------------------------------------------------

async def _create_schedule(
    http_client: httpx.AsyncClient,
    ctrl_url: str,
    api_key: str,
    schedule_id: str,
    workflow_type: str,
    task_queue: str,
    cron: str,
    workflow_input: dict[str, Any],
) -> tuple[bool, str]:
    """POST to ctrl-api /api/v1/schedules. Returns (ok, error_message)."""
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        resp = await http_client.post(
            f"{ctrl_url}/api/v1/schedules",
            json={
                "schedule_id": schedule_id,
                "workflow_type": workflow_type,
                "task_queue": task_queue,
                "cron": cron,
                "input": workflow_input,
            },
            headers=headers,
        )
    except Exception as e:
        return False, f"request failed: {e}"

    if resp.status_code >= 400:
        return False, f"http {resp.status_code}: {resp.text[:200]}"
    return True, ""


# ---------------------------------------------------------------------------
# The activity
# ---------------------------------------------------------------------------

def _chore_spec_from_opus_match(
    opus_match: dict[str, Any],
    opportunity: dict[str, Any],
    profile: dict[str, Any],
) -> dict[str, Any]:
    """Build a chore spec from an Opus matcher result + the original opportunity.

    Differs from `_chore_spec_from_opportunity` (the keyword heuristic version)
    because Opus has already chosen the template AND proposed bespoke params.
    We trust Opus's params for the template-specific fields and only fall back
    to Step 1's profile-derived helpers when Opus omitted a field.
    """
    template_id = opus_match["template_id"]
    opus_params = opus_match.get("params") or {}
    name = str(opportunity.get("name") or "Chore").strip() or "Chore"
    description = str(opportunity.get("description") or "").strip()
    tags = opportunity.get("tags") or []
    if not isinstance(tags, list):
        tags = []
    tag_set = {str(t) for t in tags if isinstance(t, str)}
    tag_set.update({"chore", "auto-generated"})

    spec: dict[str, Any] = {
        "template": template_id,
        "name": name,
        "schedule": _derive_chore_schedule(template_id, profile),
        "description": description or f"Generated from opportunity {opportunity.get('id', '')}",
        "tags": sorted(tag_set),
    }

    if template_id == "subscription_watcher":
        # Trust Opus's matter_domains if it provided them, else derive from profile
        opus_domains = opus_params.get("matter_domains")
        if isinstance(opus_domains, list) and opus_domains:
            matter_domains = [str(d).lower() for d in opus_domains if isinstance(d, str)][:30]
        else:
            financial_domains: set[str] = set()
            financial = profile.get("financial") or {}
            sender_tiers = profile.get("sender_tiers") or {}
            for entry in financial.get("detected_services") or []:
                if isinstance(entry, dict):
                    d = (entry.get("domain") or "").lower()
                    if d:
                        financial_domains.add(d)
                elif isinstance(entry, str):
                    financial_domains.add(entry.lower())
            for s in sender_tiers.get("service") or []:
                if isinstance(s, dict):
                    d = (s.get("domain") or "").lower()
                    if d:
                        financial_domains.add(d)
                elif isinstance(s, str):
                    financial_domains.add(s.lower())
            matter_domains = sorted(financial_domains)[:30]
        opus_threshold = opus_params.get("alert_threshold")
        threshold = (
            float(opus_threshold)
            if isinstance(opus_threshold, (int, float)) and 0 <= float(opus_threshold) <= 1
            else _derive_alert_threshold("subscription_watcher", profile)
        )
        spec["params"] = {
            "matter_domains": matter_domains,
            "alert_threshold": threshold,
            "session_id": str(opus_params.get("session_id") or _infer_default_session_id(profile)),
        }
    elif template_id == "weekly_matter_digest":
        opus_slug = opus_params.get("matter_slug")
        if isinstance(opus_slug, str) and opus_slug:
            matter_slug = opus_slug
        else:
            matter_slug = _extract_matter_slug_from_opportunity(opportunity)
        opus_min = opus_params.get("min_events_for_digest")
        min_events = (
            int(opus_min) if isinstance(opus_min, int) and opus_min > 0
            else _derive_min_events_for_digest(profile)
        )
        spec["params"] = {
            "matter_slug": matter_slug,
            "session_id": str(opus_params.get("session_id") or _infer_default_session_id(profile)),
            "min_events_for_digest": min_events,
        }
    else:
        # Unknown template (shouldn't happen since the matcher validates) —
        # fall through with empty params and let the chore record creation
        # surface the failure clearly.
        spec["params"] = opus_params if isinstance(opus_params, dict) else {}

    return spec


# ---------------------------------------------------------------------------
# Step 4: generation pipeline for unmatched opportunities (S4-8)
#
# For each unmatched opportunity we invoke the full chain:
#   generate → validate → smoke → deploy
# and build a chore spec for the successfully generated template. The
# resulting spec has:
#   - template = the module_name (unique per generated template)
#   - workflow_class_name = the CamelCase class name from generation
#   - params = {"chore_slug": slug}   (generated templates load their
#     context via load_chore_context, so they only need the slug)
#   - schedule = profile-derived schedule
#   - generated = True (triggers quarantine metadata in _build_chore_content)
#
# The caller (onboarding_pipeline) is responsible for calling
# restart_learn_worker ONCE after all generations so the worker picks
# up the newly deployed templates.
# ---------------------------------------------------------------------------

# Hard cap to keep generation time bounded. ~3 Opus calls per
# generation × 10 opportunities ≈ 30 Opus calls worst case. Each
# _call_llm invocation has its own 10-minute timeout so the total wall
# time is bounded well under Temporal's workflow deadline.
#
# Default raised from 3 → 10 when the matcher was made skip-by-default
# (every opportunity now goes to bespoke generation, so a cap of 3
# would silently drop most opportunities on typical 5-8-opportunity
# onboardings). Overridable via ALFRED_CHORE_MAX_GENERATED env var
# with a hard safety ceiling of 20.
_MAX_GENERATED_CHORES_PER_ONBOARDING_DEFAULT = 10


def _max_generated_chores_per_onboarding() -> int:
    """Read the generation cap from env, fall back to the default.

    Invalid or negative values → default. Capped at 20 as a safety
    ceiling so a typo in .env can't run an unbounded number of Opus
    calls per onboarding.
    """
    raw = os.environ.get("ALFRED_CHORE_MAX_GENERATED", "").strip()
    if not raw:
        return _MAX_GENERATED_CHORES_PER_ONBOARDING_DEFAULT
    try:
        n = int(raw)
    except ValueError:
        return _MAX_GENERATED_CHORES_PER_ONBOARDING_DEFAULT
    if n < 1:
        return _MAX_GENERATED_CHORES_PER_ONBOARDING_DEFAULT
    return min(n, 20)


def _append_generation_audit(entry: dict[str, Any]) -> None:
    """Best-effort append to the shared chore-generation audit log.

    Writes to the same file `chore_generation._append_deploy_audit` uses
    (/alfred-data/chore-generation-audit.jsonl) so the ctrl-api
    /api/v1/admin/chore-generation-audit route returns a unified view of
    every phase across the pipeline. Failures are swallowed — the audit
    log is a debugging aid, never load-bearing.
    """
    try:
        from pathlib import Path as _Path
        import time as _time

        log_path = _Path("/alfred-data/chore-generation-audit.jsonl")
        log_path.parent.mkdir(parents=True, exist_ok=True)
        entry_with_ts = dict(entry)
        entry_with_ts.setdefault("timestamp", _time.time())
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry_with_ts, default=str) + "\n")
    except OSError:
        pass


def _slug_from_module_name(module_name: str) -> str:
    """Convert snake_case module name to kebab-case slug for the chore record."""
    return module_name.replace("_", "-")


async def _generate_chore_from_opportunity(
    opportunity: dict[str, Any],
    profile: dict[str, Any],
) -> dict[str, Any]:
    """Run the full generation chain for one unmatched opportunity.

    Returns a result dict:
      {"ok": True, "spec": <chore spec>, "phases": [...]}
      OR
      {"ok": False, "error": str, "phase": str, "opportunity_id": str}

    Never raises — failures are returned as structured errors so the
    caller can continue with the next opportunity.
    """
    from src.activities.chore_generation import (
        deploy_generated_template,
        generate_chore_template_code,
        smoke_test_generated_template,
        validate_generated_template,
        ChoreGenerationError,
    )

    opp_id = str(opportunity.get("id", "unknown"))
    phases: list[str] = []

    # Phase 1: Opus generation
    activity.heartbeat(f"generating template for {opp_id}")
    try:
        gen = await generate_chore_template_code(opportunity, profile)
    except ChoreGenerationError as exc:
        _append_generation_audit({
            "phase": "generate", "status": "failed",
            "opportunity_id": opp_id, "error": str(exc),
        })
        return {
            "ok": False, "opportunity_id": opp_id,
            "phase": "generate", "error": str(exc), "phases": phases,
        }
    except Exception as exc:
        _append_generation_audit({
            "phase": "generate", "status": "failed",
            "opportunity_id": opp_id,
            "error": f"{type(exc).__name__}: {exc}",
        })
        return {
            "ok": False, "opportunity_id": opp_id,
            "phase": "generate", "error": f"{type(exc).__name__}: {exc}", "phases": phases,
        }
    phases.append(f"generated:{gen.get('attempts', 1)}attempts")
    python_source = gen["python_source"]
    module_name = gen["module_name"]
    workflow_class_name = gen["workflow_class_name"]
    _append_generation_audit({
        "phase": "generate", "status": "ok",
        "opportunity_id": opp_id,
        "module_name": module_name,
        "workflow_class_name": workflow_class_name,
        "attempts": gen.get("attempts", 1),
        "bytes": len(python_source),
    })

    # Phase 2: static validation
    activity.heartbeat(f"validating {module_name}")
    vres = await validate_generated_template(python_source)
    if not vres["ok"]:
        _append_generation_audit({
            "phase": "validate", "status": "failed",
            "opportunity_id": opp_id,
            "module_name": module_name,
            "violations": vres["violations"][:10],
        })
        return {
            "ok": False, "opportunity_id": opp_id,
            "phase": "validate",
            "error": "; ".join(vres["violations"][:5]),
            "phases": phases,
        }
    phases.append("validated")
    _append_generation_audit({
        "phase": "validate", "status": "ok",
        "opportunity_id": opp_id,
        "module_name": module_name,
    })

    # Phase 3: subprocess smoke test
    activity.heartbeat(f"smoke testing {module_name}")
    sres = await smoke_test_generated_template(python_source, module_name, workflow_class_name)
    if not sres["ok"]:
        _append_generation_audit({
            "phase": "smoke", "status": "failed",
            "opportunity_id": opp_id,
            "module_name": module_name,
            "smoke_phase": sres.get("phase"),
            "error": sres.get("error", "")[:500],
        })
        return {
            "ok": False, "opportunity_id": opp_id,
            "phase": "smoke",
            "error": f"{sres.get('phase','?')}: {sres.get('error','')}"[:400],
            "phases": phases,
        }
    phases.append(f"smoke_ok:{sres.get('duration_seconds', 0):.1f}s")
    _append_generation_audit({
        "phase": "smoke", "status": "ok",
        "opportunity_id": opp_id,
        "module_name": module_name,
        "duration_seconds": sres.get("duration_seconds", 0),
    })

    # Phase 4: deploy to user-chores dir (deploy writes its own audit entry)
    activity.heartbeat(f"deploying {module_name}")
    dres = await deploy_generated_template(python_source, module_name, workflow_class_name)
    if not dres["ok"]:
        return {
            "ok": False, "opportunity_id": opp_id,
            "phase": "deploy",
            "error": dres.get("error", ""),
            "phases": phases,
        }
    phases.append("deployed" + (":idempotent" if dres.get("idempotent") else ""))

    # Build the chore spec for the successfully deployed template
    name = str(opportunity.get("name") or workflow_class_name).strip()
    description = str(opportunity.get("description") or "").strip()
    # C.1: prefer the user_facing_description from the generation envelope
    # over the opportunity description. The opportunity description was
    # the *promise* in the brief; the user_facing_description is what
    # the chore actually does. The Chores tab shows the latter.
    user_facing_description = str(gen.get("user_facing_description", "") or "").strip()
    tags = opportunity.get("tags") or []
    if not isinstance(tags, list):
        tags = []
    tag_set = {str(t) for t in tags if isinstance(t, str)}
    tag_set.update({"chore", "generated", "quarantine"})

    # Generated templates load their own context via load_chore_context, so
    # they only need the chore slug in their workflow input dataclass. The
    # slug of the chore record itself is derived from the module_name.
    chore_slug = _slug_from_module_name(module_name)

    # Prefer the schedule the LLM emitted in its envelope. It's the field
    # that actually matches what user_facing_description promises (e.g.
    # "every weekday at 14:30" → `30 14 * * 1-5`). The old code path fell
    # through to _derive_chore_schedule for every generated template because
    # their module_ids don't match the two known standard-library templates,
    # which quietly stamped all generated chores with Sunday-18:00-UTC. The
    # generator now emits `schedule` as part of its required output schema
    # (see chore_generation.py _validate_cron_expression) so this branch is
    # the normal path; the fallback only fires for backwards-compat envelopes
    # written before this fix shipped.
    gen_schedule = str(gen.get("schedule") or "").strip()
    if gen_schedule:
        chore_schedule = gen_schedule
        logger.info(
            "assign_chores: using LLM-emitted schedule %r for generated template %s",
            chore_schedule, module_name,
        )
    else:
        chore_schedule = _derive_chore_schedule(module_name, profile)
        logger.warning(
            "assign_chores: generation envelope for %s had no schedule field; "
            "falling back to _derive_chore_schedule → %r. Regenerate on next "
            "onboarding to get a user-facing-description-accurate cron.",
            module_name, chore_schedule,
        )

    spec: dict[str, Any] = {
        "template": module_name,  # unique per generated template
        "workflow_class_name": workflow_class_name,
        "name": name,
        "description": description or f"Generated from opportunity {opp_id}",
        "user_facing_description": user_facing_description,
        "schedule": chore_schedule,
        "tags": sorted(tag_set),
        "params": {"chore_slug": chore_slug},
        "generated": True,
    }

    return {
        "ok": True,
        "spec": spec,
        "phases": phases,
        "source_hash": dres.get("source_hash", ""),
        "path": dres.get("path", ""),
    }


@activity.defn
async def assign_initial_chores(onboard_path: str, user_id: str) -> dict[str, Any]:
    """Decide chores from the profile, write vault records, create schedules.

    Four paths in priority order (first match wins):
      0. **Skip-matching** (DEFAULT, when opportunities exist): every
         opportunity becomes an unmatched candidate for the Step 4
         generation pipeline. No Opus matcher, no keyword heuristic —
         just bespoke Python Temporal workflows for every opportunity.
         Controlled by ALFRED_CHORE_SKIP_TEMPLATE_MATCHING (default
         "true"). This is the mega-plan's intended default.
      1. **Opus-driven matching** (opt-in when SKIP_TEMPLATE_MATCHING=
         "false" and opportunities exist): calls
         match_opportunities_to_templates from chore_matching.py. Opus
         picks the best template per opportunity with bespoke params.
         Unmatched opportunities still flow into Step 4 generation.
      2. **Keyword heuristic fallback** (when the Opus matcher fails or
         is disabled via ALFRED_CHORE_OPUS_MATCHING_ENABLED=false): the
         _decide_chores_from_opportunities heuristic from S2-3.
      3. **Rule-based fallback** (when no opportunities are present —
         e.g. tenants onboarded before Step 2 shipped): the original
         _decide_chores flow matching against profile features.

    Idempotent-ish: if a schedule with the same id already exists, the
    ctrl-api call will fail and we record it in `failed` but continue with
    the rest. Re-running the activity for the same user is safe — vault
    writes overwrite existing records, and schedule conflicts are tolerated.
    """
    try:
        with open(onboard_path) as f:
            onboard = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        return {"created": [], "failed": [f"onboard.json read failed: {e}"], "decided": 0}

    profile = onboard.get("profile") or {}
    facts = onboard.get("facts") or []
    opportunities = onboard.get("opportunities") or []

    unmatched: list[dict[str, Any]] = []
    decided: list[dict[str, Any]]
    matching_source = "rules"

    opus_matching_enabled = (
        os.environ.get("ALFRED_CHORE_OPUS_MATCHING_ENABLED", "true").lower() != "false"
    )

    # DEFAULT: skip the matcher entirely and send every opportunity
    # through the bespoke generation pipeline. Every onboarded user
    # gets brand-new Python Temporal workflows tailored to their
    # specific facts/patterns/profile rather than drawing from a
    # shared standard-library menu.
    #
    # Set ALFRED_CHORE_SKIP_TEMPLATE_MATCHING=false to opt back INTO
    # the legacy matcher-first flow (Opus matcher first, keyword
    # heuristic as fallback). Kept as an opt-out so tenants that want
    # to save Opus tokens can still reuse existing templates — but
    # the mega-plan's intent is full personalization, so the default
    # flipped once the generation pipeline was verified on david.
    #
    # Cost implication: ~3 Opus calls per generated template × up to
    # ALFRED_CHORE_MAX_GENERATED (default 10) = up to 30 Opus calls
    # per onboarding worst case. ~$10-30/onboarding for code
    # generation alone.
    skip_template_matching = (
        os.environ.get("ALFRED_CHORE_SKIP_TEMPLATE_MATCHING", "true").lower() != "false"
    )

    if isinstance(opportunities, list) and opportunities and skip_template_matching:
        # Path 0: skip matching entirely — every opportunity becomes a
        # generation candidate. No Opus matcher, no keyword heuristic.
        matching_source = "skipped"
        decided = []
        unmatched = [
            {
                "opportunity": opp,
                "reason": "template matching skipped via ALFRED_CHORE_SKIP_TEMPLATE_MATCHING",
            }
            for opp in opportunities
            if isinstance(opp, dict)
        ]
        activity.heartbeat(
            f"skip-matching mode: {len(unmatched)} opportunities → all flagged for generation"
        )
    elif isinstance(opportunities, list) and opportunities and opus_matching_enabled:
        # Path 1: Opus-driven matching (Step 3)
        try:
            from src.activities.chore_matching import match_opportunities_to_templates
            opus_result = await match_opportunities_to_templates(onboard_path, opportunities)
        except Exception as exc:
            activity.heartbeat(f"opus matcher raised {type(exc).__name__}: {exc}")
            opus_result = None

        if opus_result and not opus_result.get("fallback"):
            matching_source = "opus"
            opus_matched = opus_result.get("matched", [])
            opus_unmatched_raw = opus_result.get("unmatched", [])
            # Build a lookup for the original opportunities so we can pull name/description
            opp_by_id = {
                o.get("id"): o
                for o in opportunities
                if isinstance(o, dict) and isinstance(o.get("id"), str)
            }
            decided = []
            seen_names: set[str] = set()
            for match in opus_matched:
                opp = opp_by_id.get(match.get("opportunity_id"))
                if not opp:
                    continue
                spec = _chore_spec_from_opus_match(match, opp, profile)
                if spec["name"] in seen_names:
                    continue
                seen_names.add(spec["name"])
                decided.append(spec)
            # Reshape unmatched for the persistence step
            unmatched = []
            for u in opus_unmatched_raw:
                opp = opp_by_id.get(u.get("opportunity_id"))
                if opp is None:
                    continue
                unmatched.append({"opportunity": opp, "reason": u.get("reason", "")})
            activity.heartbeat(
                f"opus match: {len(decided)} matched, {len(unmatched)} unmatched"
            )
        else:
            # Opus failed or returned fallback — try the keyword heuristic
            matching_source = "keyword_fallback"
            decided, unmatched = _decide_chores_from_opportunities(opportunities, profile)
            activity.heartbeat(
                f"keyword fallback: {len(decided)} matched, {len(unmatched)} unmatched"
            )
    elif isinstance(opportunities, list) and opportunities:
        # Path 2: keyword heuristic (when Opus matching is disabled by env flag)
        matching_source = "keyword"
        decided, unmatched = _decide_chores_from_opportunities(opportunities, profile)
        activity.heartbeat(
            f"keyword match: {len(decided)} matched, {len(unmatched)} unmatched"
        )
    else:
        # Path 3: legacy rule-based fallback
        matching_source = "rules"
        decided = _decide_chores(profile, facts)
        activity.heartbeat(f"rule-based decision: {len(decided)} chores from profile")

    # Persist unmatched opportunities for Step 4 to pick up later
    if unmatched:
        try:
            onboard["unmatched_opportunities"] = unmatched
            with open(onboard_path, "w") as f:
                json.dump(onboard, f, indent=2, default=str)
        except OSError as e:
            activity.heartbeat(f"warning: failed to persist unmatched opportunities: {e}")

    # --------------------------------------------------------------
    # Step 4 (S4-8): generation pipeline for unmatched opportunities
    #
    # For each unmatched opportunity (capped at _MAX_GENERATED_CHORES_
    # PER_ONBOARDING) run the full generate → validate → smoke → deploy
    # chain. Successful generations become new chore specs that get
    # appended to `decided` and persisted as quarantined chores. The
    # caller workflow is responsible for calling restart_learn_worker
    # ONCE after assign_initial_chores returns so the dynamically
    # deployed templates get picked up.
    # --------------------------------------------------------------
    generation_enabled = (
        os.environ.get("ALFRED_CHORE_GENERATION_ENABLED", "true").lower() != "false"
    )
    generated_count = 0
    generation_failures: list[dict[str, Any]] = []
    generation_results: list[dict[str, Any]] = []
    if generation_enabled and unmatched:
        max_generated = _max_generated_chores_per_onboarding()
        to_generate = unmatched[:max_generated]
        activity.heartbeat(
            f"S4-8: attempting generation for {len(to_generate)} unmatched opportunities "
            f"(of {len(unmatched)} total, cap={max_generated})"
        )
        for u in to_generate:
            opp = u.get("opportunity") or {}
            if not isinstance(opp, dict):
                continue
            result = await _generate_chore_from_opportunity(opp, profile)
            generation_results.append(result)
            if result["ok"]:
                decided.append(result["spec"])
                generated_count += 1
                activity.heartbeat(
                    f"S4-8: generated {result['spec']['template']} "
                    f"(phases: {','.join(result['phases'])})"
                )
            else:
                generation_failures.append({
                    "opportunity_id": result.get("opportunity_id", ""),
                    "phase": result.get("phase", "?"),
                    "error": result.get("error", ""),
                })
                activity.heartbeat(
                    f"S4-8: generation failed at phase={result.get('phase')} "
                    f"for {result.get('opportunity_id')}"
                )

    if not decided:
        return {
            "created": [],
            "failed": [],
            "decided": 0,
            "unmatched": len(unmatched),
            "generated": generated_count,
            "generation_failures": generation_failures,
            "source": matching_source,
        }

    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")

    vault = VaultClient(config)
    created: list[str] = []
    failed: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=30.0) as http_client:
            for chore in decided:
                slug = _slugify(chore["name"])
                if not slug:
                    failed.append(f"empty slug for chore {chore.get('name')!r}")
                    continue
                schedule_id = f"chore-{slug}"

                # 1. Write the chore vault record
                try:
                    content = _build_chore_content(chore, schedule_id)
                    await vault.write_record("chore", slug, content)
                except Exception as e:
                    failed.append(f"{slug}: vault write failed: {e}")
                    continue

                # 2. Create the Temporal schedule
                try:
                    workflow_type = _resolve_workflow_type(chore)
                except ValueError as e:
                    failed.append(f"{slug}: {e}")
                    continue

                ok, err = await _create_schedule(
                    http_client=http_client,
                    ctrl_url=config.alfred_ctrl_url,
                    api_key=api_key,
                    schedule_id=schedule_id,
                    workflow_type=workflow_type,
                    task_queue=config.task_queue,
                    cron=chore["schedule"],
                    workflow_input={"chore_slug": slug},
                )
                if not ok:
                    failed.append(f"{slug}: schedule create failed: {err}")
                    continue

                created.append(slug)
                activity.heartbeat(f"created chore {slug}")
    finally:
        await vault.close()

    return {
        "created": created,
        "failed": failed,
        "decided": len(decided),
        "unmatched": len(unmatched),
        "generated": generated_count,
        "generation_failures": generation_failures,
        "source": matching_source,
    }
