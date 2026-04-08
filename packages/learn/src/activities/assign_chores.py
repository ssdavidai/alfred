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
            "schedule": "0 9 * * 5",  # Friday 9am (UTC)
            "params": {
                "matter_domains": sorted(financial_domains)[:30],
                "alert_threshold": 0.7,
                "session_id": "main",
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
            "schedule": "0 18 * * 0",  # Sunday 6pm (UTC)
            "params": {
                "matter_slug": matter_slug,
                "session_id": "main",
                "min_events_for_digest": 3,
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

    decided = _decide_chores(profile, facts)
    activity.heartbeat(f"decided {len(decided)} chores from profile")

    if not decided:
        return {"created": [], "failed": [], "decided": 0}

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
    }
