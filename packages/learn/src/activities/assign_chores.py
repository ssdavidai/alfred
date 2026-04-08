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
import os
import re
from datetime import datetime, timezone
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient


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

    For weekly chores, the hour is derived from `profile.rhythm.work_end_estimate`
    (the user stops work, then Alfred surfaces things soon after when they
    have time to look). The day is template-specific:
      - subscription_watcher: Friday (end of the work week)
      - weekly_matter_digest: Sunday if weekend activity is high, else Friday

    If the profile has no rhythm data at all, falls back to the old
    hardcoded defaults (`0 9 * * 5` for subscription, `0 18 * * 0` for digest).
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
    """
    now = datetime.now(timezone.utc).isoformat()
    tags_yaml = "[" + ", ".join(chore.get("tags", ["chore"])) + "]"
    params_json = json.dumps(chore["params"], default=str, separators=(",", ":"))
    params_yaml = _quote_yaml_scalar(params_json)
    schedule_yaml = _quote_yaml_scalar(chore["schedule"])

    return (
        f"---\n"
        f"type: chore\n"
        f"name: {chore['name']}\n"
        f"status: active\n"
        f"template: {chore['template']}\n"
        f"schedule: {schedule_yaml}\n"
        f"schedule_id: {schedule_id}\n"
        f"params: {params_yaml}\n"
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

@activity.defn
async def assign_initial_chores(onboard_path: str, user_id: str) -> dict[str, Any]:
    """Decide chores from the profile, write vault records, create schedules.

    Two paths:
      1. **Opportunity-driven** (preferred, when onboard.json["opportunities"]
         is populated by Stage 6's write_brief_and_opportunities_opus): each
         opportunity is keyword-matched to a template via the Step 2 heuristic.
         Matched ones become chores; unmatched ones are saved to
         onboard.json["unmatched_opportunities"] for Step 4 (code generation)
         to handle.
      2. **Rule-based** (fallback, when no opportunities are present — e.g.
         tenants onboarded before Step 2 shipped): the original _decide_chores
         flow that hardcoded matching against profile features.

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

    if isinstance(opportunities, list) and opportunities:
        # Path 1: opportunity-driven (Step 2)
        decided, unmatched = _decide_chores_from_opportunities(opportunities, profile)
        activity.heartbeat(
            f"opportunity match: {len(decided)} matched, {len(unmatched)} unmatched"
        )
        # Persist unmatched opportunities for Step 4 to pick up later
        if unmatched:
            try:
                onboard["unmatched_opportunities"] = unmatched
                with open(onboard_path, "w") as f:
                    json.dump(onboard, f, indent=2, default=str)
            except OSError as e:
                # Non-fatal — Step 4 will see the empty list and generate nothing
                activity.heartbeat(f"warning: failed to persist unmatched opportunities: {e}")
    else:
        # Path 2: legacy rule-based fallback
        decided = _decide_chores(profile, facts)
        activity.heartbeat(f"rule-based decision: {len(decided)} chores from profile")

    if not decided:
        return {
            "created": [],
            "failed": [],
            "decided": 0,
            "unmatched": len(unmatched),
            "source": "opportunities" if opportunities else "rules",
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
                    workflow_type = _template_to_workflow_name(chore["template"])
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
        "source": "opportunities" if opportunities else "rules",
    }
