"""match_opportunities_to_templates — Opus-driven template matcher (Step 3, S3-2).

Replaces the keyword heuristic from S2-3 with an Opus call that reads:
  - The list of chore opportunities (from onboard.json["opportunities"])
  - The activity manifest (from src.chore_manifest.CHORE_ACTIVITY_LIST)
  - The existing template library source code (as worked examples)

and decides for each opportunity:
  - Which existing template fits, with bespoke params, OR
  - That no template fits and the opportunity should be flagged for Step 4
    (code generation)

This is the upgrade from "keyword overlap" to "semantic understanding" that
the user identified as the missing piece in the chore system. The activity
makes ONE Opus call per onboarding to match all opportunities at once,
keeping the cost bounded.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from temporalio import activity

from src.activities.clerk import _call_clerk
from src.activities.onboarding_v3 import _parse_json_with_key
from src.chore_manifest import (
    ActivityDescriptor,
    CHORE_ACTIVITY_LIST,
    render_manifest_for_prompt,
)
from src.workflows.chores import ALL_CHORE_TEMPLATES

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Where the chore template library lives in the container. We read source
# code from here so Opus has worked examples in the prompt.
_TEMPLATES_SOURCE_DIR = Path("/app/src/workflows/chores")

# Cap the source we send for each template (Opus context budget)
_MAX_TEMPLATE_SOURCE_CHARS = 6000

# Total max attempts for the Opus matching call (parse failure → retry)
_MATCH_MAX_ATTEMPTS = 3


# ---------------------------------------------------------------------------
# Template registry — kept in sync with assign_chores._TEMPLATE_TO_WORKFLOW.
# Source-of-truth for "which templates exist" comes from the chores package.
# ---------------------------------------------------------------------------

def _list_known_templates() -> list[dict[str, str]]:
    """Return a list of {template_id, workflow_name} for every known template.

    Pulls from src.workflows.chores.ALL_CHORE_TEMPLATES so adding a new
    template only requires touching the chores package — this matcher will
    pick it up automatically.
    """
    out: list[dict[str, str]] = []
    for cls in ALL_CHORE_TEMPLATES:
        workflow_name = getattr(cls, "__name__", "")
        # Map workflow class name to template id by lowercasing + snake_casing.
        # The convention: SubscriptionWatcherWorkflow -> subscription_watcher
        template_id = _workflow_class_to_template_id(workflow_name)
        out.append({
            "template_id": template_id,
            "workflow_name": workflow_name,
        })
    return out


def _workflow_class_to_template_id(class_name: str) -> str:
    """Map e.g. 'SubscriptionWatcherWorkflow' -> 'subscription_watcher'."""
    name = class_name
    if name.endswith("Workflow"):
        name = name[: -len("Workflow")]
    out: list[str] = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0 and not out[-1].endswith("_"):
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


def _read_template_source(template_id: str) -> str:
    """Best-effort read of one template's Python source for prompt inclusion.

    Returns empty string if the file isn't found (so the matcher still works
    in development environments where /app/src isn't available).
    """
    path = _TEMPLATES_SOURCE_DIR / f"{template_id}.py"
    try:
        text = path.read_text()
    except (FileNotFoundError, PermissionError):
        return ""
    return text[:_MAX_TEMPLATE_SOURCE_CHARS]


# ---------------------------------------------------------------------------
# Prompt builder
# ---------------------------------------------------------------------------

def _build_match_prompt(
    opportunities: list[dict[str, Any]],
    templates: list[dict[str, str]],
    manifest_block: str,
    template_examples: dict[str, str],
    retry_feedback: str = "",
) -> str:
    """Build the structured Opus prompt for matching opportunities → templates."""
    template_listing = "\n".join(
        f"- {t['template_id']} (workflow class: {t['workflow_name']})"
        for t in templates
    )

    examples_block = "\n\n".join(
        f"### Template `{tid}`\n```python\n{src}\n```"
        for tid, src in template_examples.items()
        if src
    )

    opps_block = json.dumps(opportunities, indent=2, default=str)[:8000]

    retry_block = ""
    if retry_feedback:
        retry_block = (
            "\n\n**IMPORTANT: previous attempt failed** — " + retry_feedback +
            "\nReturn strictly valid JSON matching the schema below.\n"
        )

    return f"""You are Alfred's template matching brain. You decide which existing chore template (if any) fits each chore opportunity the master should have.

## Available templates

{template_listing}

## Activity manifest (the building blocks each template can call)

{manifest_block}

## Example templates (worked source code)

{examples_block}

## Opportunities to match

{opps_block}

## Your task

For each opportunity, decide ONE of:

1. **MATCH**: an existing template fits this opportunity. You must specify:
   - `opportunity_id`: the opportunity's id
   - `template_id`: which template (must be one of the listed template ids)
   - `params`: a dict of bespoke parameters specific to this user's situation
   - `reason`: one sentence explaining why this template fits
2. **UNMATCHED**: no existing template can serve this opportunity (Step 4 will generate a new one). You must specify:
   - `opportunity_id`: the opportunity's id
   - `reason`: one sentence explaining what kind of template would be needed instead

## Decision rules

- Each opportunity must appear EXACTLY ONCE in either `matched` or `unmatched`. Never both, never zero.
- Be honest about fit. If an opportunity is about gym attendance and the only existing templates are subscription_watcher and weekly_matter_digest, mark it UNMATCHED. Don't force-fit.
- For matches, the `params` field should be tailored to the user. Look at the opportunity's data_sources, goal, and notify_when to fill in template-specific params. For example:
  - subscription_watcher needs: `matter_domains` (list of domains to watch), `alert_threshold` (0-1), `session_id` ("main")
  - weekly_matter_digest needs: `matter_slug`, `min_events_for_digest`, `session_id`

## Output format

Return ONLY valid JSON matching this exact schema:

```json
{{
  "matched": [
    {{
      "opportunity_id": "watch-subscriptions",
      "template_id": "subscription_watcher",
      "params": {{
        "matter_domains": ["stripe.com", "polar.sh"],
        "alert_threshold": 0.7,
        "session_id": "main"
      }},
      "reason": "The opportunity is about catching subscription anomalies, which is exactly what subscription_watcher does."
    }}
  ],
  "unmatched": [
    {{
      "opportunity_id": "gym-and-health-check-in",
      "reason": "Needs a new template that polls health/fitness data sources, not a subscription template."
    }}
  ]
}}
```

{retry_block}
Return ONLY the JSON object. No markdown, no preamble, no explanation."""


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _validate_match_response(
    parsed: dict[str, Any],
    opportunity_ids: set[str],
    valid_template_ids: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    """Validate the parsed Opus response. Returns (matched, unmatched, error).

    On success: error is empty string.
    On failure: error is a human-readable reason that gets fed back to Opus
    in the retry prompt.
    """
    matched_raw = parsed.get("matched")
    unmatched_raw = parsed.get("unmatched")
    if not isinstance(matched_raw, list) or not isinstance(unmatched_raw, list):
        return [], [], "response missing 'matched' or 'unmatched' list"

    matched: list[dict[str, Any]] = []
    unmatched: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for entry in matched_raw:
        if not isinstance(entry, dict):
            continue
        opp_id = entry.get("opportunity_id")
        template_id = entry.get("template_id")
        params = entry.get("params") or {}
        reason = entry.get("reason", "")
        if not isinstance(opp_id, str) or opp_id not in opportunity_ids:
            continue
        if not isinstance(template_id, str) or template_id not in valid_template_ids:
            # Opus picked a template that doesn't exist — flag as unmatched instead
            unmatched.append({
                "opportunity_id": opp_id,
                "reason": f"opus chose unknown template {template_id!r}",
            })
            seen_ids.add(opp_id)
            continue
        if not isinstance(params, dict):
            params = {}
        matched.append({
            "opportunity_id": opp_id,
            "template_id": template_id,
            "params": params,
            "reason": reason if isinstance(reason, str) else "",
        })
        seen_ids.add(opp_id)

    for entry in unmatched_raw:
        if not isinstance(entry, dict):
            continue
        opp_id = entry.get("opportunity_id")
        reason = entry.get("reason", "")
        if not isinstance(opp_id, str) or opp_id not in opportunity_ids:
            continue
        if opp_id in seen_ids:
            continue  # already accounted for
        unmatched.append({
            "opportunity_id": opp_id,
            "reason": reason if isinstance(reason, str) else "",
        })
        seen_ids.add(opp_id)

    # Any opportunities Opus didn't return at all → mark unmatched with a reason
    missing = opportunity_ids - seen_ids
    for missing_id in missing:
        unmatched.append({
            "opportunity_id": missing_id,
            "reason": "opus omitted this opportunity from the response",
        })

    return matched, unmatched, ""


# ---------------------------------------------------------------------------
# The activity
# ---------------------------------------------------------------------------

@activity.defn
async def match_opportunities_to_templates(
    onboard_path: str,
    opportunities: list[dict[str, Any]],
) -> dict[str, Any]:
    """Use Opus to match each opportunity to an existing template (or flag unmatched).

    One Opus call per onboarding regardless of opportunity count. The Opus
    response is parsed via the same robust _parse_json_with_key helper used
    elsewhere in the chore system. On parse failure: retry up to 3 times
    with amended prompts. On repeated failure: every opportunity goes to
    unmatched (Step 4 picks them up).

    Returns: {
      matched: [{opportunity_id, template_id, params, reason}],
      unmatched: [{opportunity_id, reason}],
      attempts: int,
      fallback: bool   # True if we hit the failure path
    }
    """
    if not opportunities:
        return {"matched": [], "unmatched": [], "attempts": 0, "fallback": False}

    templates = _list_known_templates()
    valid_template_ids = {t["template_id"] for t in templates}
    opportunity_ids = {
        o.get("id") for o in opportunities if isinstance(o, dict) and isinstance(o.get("id"), str)
    }

    # Read template source files for worked examples in the prompt
    template_examples = {
        t["template_id"]: _read_template_source(t["template_id"])
        for t in templates
    }

    # Render the activity manifest, filtered to types relevant for chores
    manifest_block = render_manifest_for_prompt(
        filter_classifications={
            "pure_python", "vault_read", "vault_write", "llm", "notification",
        }
    )
    # Cap manifest length so it fits in the context budget
    if len(manifest_block) > 12000:
        manifest_block = manifest_block[:12000] + "\n... (manifest truncated)"

    last_error = ""
    matched: list[dict[str, Any]] = []
    unmatched: list[dict[str, Any]] = []
    attempts = 0

    while attempts < _MATCH_MAX_ATTEMPTS:
        attempts += 1
        activity.heartbeat(f"opus matcher attempt {attempts}")

        prompt = _build_match_prompt(
            opportunities=opportunities,
            templates=templates,
            manifest_block=manifest_block,
            template_examples=template_examples,
            retry_feedback=last_error,
        )

        try:
            result = await _call_clerk(prompt)
        except Exception as exc:
            logger.error("chore_matching: clerk call failed (attempt %d): %s", attempts, exc)
            last_error = f"clerk call raised {type(exc).__name__}: {exc}"
            continue

        # _call_clerk by default returns a parsed dict via _extract_json. If
        # it returns a string for some reason, fall back to _parse_json_with_key
        # which handles markdown fences + brace repair.
        if isinstance(result, dict) and "matched" in result:
            parsed = result
        elif isinstance(result, str):
            parsed = _parse_json_with_key(result, "matched")
        else:
            last_error = f"clerk returned unexpected shape {type(result).__name__}"
            continue

        if not parsed or "matched" not in parsed:
            last_error = "response missing 'matched' key after parsing"
            continue

        matched, unmatched, validation_err = _validate_match_response(
            parsed=parsed,
            opportunity_ids=opportunity_ids,
            valid_template_ids=valid_template_ids,
        )
        if validation_err:
            last_error = validation_err
            continue

        if not matched and not unmatched:
            last_error = "response had zero matched and zero unmatched entries"
            continue

        logger.info(
            "chore_matching: %d matched, %d unmatched after %d attempts",
            len(matched), len(unmatched), attempts,
        )
        return {
            "matched": matched,
            "unmatched": unmatched,
            "attempts": attempts,
            "fallback": False,
        }

    # All attempts exhausted — mark every opportunity unmatched so Step 4
    # gets a chance to handle them. Onboarding never blocks on this stage.
    logger.error(
        "chore_matching: all %d attempts failed (%s) — marking everything unmatched",
        _MATCH_MAX_ATTEMPTS, last_error,
    )
    return {
        "matched": [],
        "unmatched": [
            {"opportunity_id": oid, "reason": f"opus matcher failed: {last_error}"}
            for oid in opportunity_ids
        ],
        "attempts": attempts,
        "fallback": True,
    }
