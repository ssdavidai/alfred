"""generate_chore_template_code — Opus generates a Python workflow file [S4-4].

This is the heart of Step 4: Opus reads an unmatched chore opportunity, the
activity manifest, and a few worked-example templates, and produces brand-new
Python source code for a Temporal workflow specifically designed for that
opportunity.

The activity does NOT write anything to disk — it just returns the generated
source as a string. Static validation (S4-5), smoke testing (S4-6), and
deployment (S4-7) are separate activities that consume the output.

Design contract:
  - Uses _call_llm direct OpenRouter (claude-opus-4-6, lower temperature
    than the brief generator since we want less creativity)
  - Up to 3 attempts with retry-feedback prompts on failure
  - Hard total timeout enforced via _call_llm's asyncio.wait_for budget
  - Returns {module_name, workflow_class_name, python_source, ...metadata}
  - Raises ChoreGenerationError on repeated failure so the caller (S4-8
    onboarding integration) can move on to the next opportunity
"""
from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any

from temporalio import activity

from src.activities.chore_generation_prompts import build_generation_prompt
from src.activities.onboarding_v3 import _call_llm, _parse_json_with_key

logger = logging.getLogger("alfred-learn")


# Total max attempts for the generation call (parse failure or empty
# response → retry with amended prompt). Each attempt consumes one Opus
# call so this is the cost ceiling per opportunity.
_GENERATION_MAX_ATTEMPTS = 3

# Where the standard-library template source code lives in the container.
# We read up to 6KB of each example to pass as worked code in the prompt.
_TEMPLATES_SOURCE_DIR = Path("/app/src/workflows/chores")
_MAX_EXAMPLE_CHARS = 6000


class ChoreGenerationError(RuntimeError):
    """Raised when generate_chore_template_code exhausts its retry budget."""


def _read_template_examples() -> dict[str, str]:
    """Return {template_id: source} for every standard-library template.

    Best-effort: missing files / read errors return empty entries rather
    than raising. The prompt builder skips empty examples.
    """
    examples: dict[str, str] = {}
    if not _TEMPLATES_SOURCE_DIR.exists():
        return examples
    for path in sorted(_TEMPLATES_SOURCE_DIR.glob("*.py")):
        if path.name.startswith("_"):
            continue
        try:
            examples[path.stem] = path.read_text()[:_MAX_EXAMPLE_CHARS]
        except OSError:
            continue
    return examples


def _slice_profile_for_opportunity(
    profile: dict[str, Any],
    opportunity: dict[str, Any],
) -> dict[str, Any]:
    """Pull only the profile fields relevant to one opportunity.

    The full profile can be 10KB+ — too much context for the prompt
    when we're already injecting the manifest + template examples. This
    helper picks the slices Opus actually needs to write a sensible
    workflow for THIS specific opportunity.
    """
    if not isinstance(profile, dict):
        return {}

    rhythm = profile.get("rhythm") or {}
    relationships = profile.get("relationships") or {}
    summary = profile.get("summary") or {}
    financial = profile.get("financial") or {}

    # Extract a focused slice
    sliced: dict[str, Any] = {
        "rhythm": {
            "work_start_estimate": rhythm.get("work_start_estimate"),
            "work_end_estimate": rhythm.get("work_end_estimate"),
            "weekend_activity_ratio": rhythm.get("weekend_activity_ratio"),
            "regularity_score": rhythm.get("regularity_score"),
            "peak_hours": rhythm.get("peak_hours"),
        },
        "communication_style": (
            relationships.get("communication_style") if isinstance(relationships, dict) else None
        ),
        "summary": {
            "communication_style": summary.get("communication_style"),
            "key_patterns": summary.get("key_patterns"),
            "work_hours": summary.get("work_hours"),
        },
    }

    # Tag-based heuristic to include extra context for specific opportunity types
    tags = set(opportunity.get("tags") or [])
    goal_lower = (opportunity.get("goal") or "").lower()
    desc_lower = (opportunity.get("description") or "").lower()
    needle = f"{goal_lower} {desc_lower} {' '.join(tags)}"

    if any(kw in needle for kw in ["financial", "subscription", "billing", "payment", "cash", "invoice"]):
        sliced["financial"] = {
            "detected_subscriptions": (financial.get("detected_subscriptions") or [])[:10],
            "payment_issues": (financial.get("payment_issues") or [])[:10],
            "detected_merchants": (financial.get("detected_merchants") or [])[:10],
        }

    if "matter" in needle or "digest" in needle:
        if isinstance(relationships, dict):
            sliced["top_correspondents"] = (
                relationships.get("top_correspondents") or []
            )[:10]

    return sliced


def _validate_envelope(parsed: dict[str, Any]) -> tuple[bool, str]:
    """Validate that the parsed Opus response has the required envelope keys.

    Returns (ok, error_message). Empty error_message on success.
    """
    if not isinstance(parsed, dict):
        return False, f"response is not a dict: {type(parsed).__name__}"
    module_name = parsed.get("module_name")
    workflow_class_name = parsed.get("workflow_class_name")
    python_source = parsed.get("python_source")

    if not isinstance(module_name, str) or not module_name:
        return False, "missing or empty 'module_name'"
    # snake_case identifier check
    if not module_name.replace("_", "").isalnum() or not module_name[0].isalpha():
        return False, f"module_name {module_name!r} is not a valid Python identifier"
    if not module_name.islower() and not all(c == "_" or c.islower() or c.isdigit() for c in module_name):
        return False, f"module_name {module_name!r} must be snake_case"

    if not isinstance(workflow_class_name, str) or not workflow_class_name:
        return False, "missing or empty 'workflow_class_name'"
    if not workflow_class_name.endswith("Workflow"):
        return False, f"workflow_class_name {workflow_class_name!r} must end with 'Workflow'"
    if not workflow_class_name[0].isupper():
        return False, f"workflow_class_name {workflow_class_name!r} must be CamelCase"

    if not isinstance(python_source, str) or not python_source.strip():
        return False, "missing or empty 'python_source'"
    if len(python_source) > 100_000:
        return False, f"python_source too large: {len(python_source)} bytes (max 100000)"

    return True, ""


@activity.defn
async def generate_chore_template_code(
    opportunity: dict[str, Any],
    profile: dict[str, Any],
) -> dict[str, Any]:
    """Generate a new Python Temporal workflow file for one chore opportunity.

    Args:
        opportunity: a ChoreOpportunity dict (from onboard.json["opportunities"]
            or onboard.json["unmatched_opportunities"][i]["opportunity"])
        profile: the full profile dict from onboard.json["profile"]

    Returns:
        {
            "module_name": str,        # snake_case identifier
            "workflow_class_name": str, # CamelCase ending in Workflow
            "python_source": str,      # the full file contents
            "prompt_hash": str,        # sha256 of the final prompt for audit
            "attempts": int,           # how many tries it took
        }

    Raises:
        ChoreGenerationError if all attempts fail.
    """
    # Build the prompt context once (cheap), then iterate per attempt only
    # changing the retry_feedback to nudge Opus on failure.
    profile_slice = _slice_profile_for_opportunity(profile, opportunity)
    template_examples = _read_template_examples()

    last_error = ""
    for attempt in range(1, _GENERATION_MAX_ATTEMPTS + 1):
        activity.heartbeat(f"chore_generation: opus attempt {attempt}")

        prompt = build_generation_prompt(
            opportunity=opportunity,
            profile_slice=profile_slice,
            template_examples=template_examples,
            retry_feedback=last_error,
        )
        prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16]

        try:
            raw = await _call_llm(
                prompt,
                max_tokens=8192,
                heartbeat_message=f"opus generating chore template (attempt {attempt})",
            )
        except Exception as exc:
            logger.error(
                "chore_generation: _call_llm raised on attempt %d: %s",
                attempt, exc,
            )
            last_error = f"LLM call raised {type(exc).__name__}: {exc}"
            continue

        # Robust parse — _parse_json_with_key handles markdown fences,
        # truncated JSON, brace repair. We key on python_source which is
        # NOT a list, so the helper's "must be a list" gate will fail.
        # Instead, try direct json.loads first then fall back to the helper
        # by passing a list-valued key... actually we need a different parser
        # path. Inline a simpler one.
        parsed = _try_parse_envelope(raw)
        if parsed is None:
            logger.error(
                "chore_generation: failed to parse JSON envelope on attempt %d (raw[:200]=%r)",
                attempt, raw[:200] if isinstance(raw, str) else raw,
            )
            last_error = "response was not valid JSON matching {module_name, workflow_class_name, python_source}"
            continue

        ok, validation_err = _validate_envelope(parsed)
        if not ok:
            logger.error("chore_generation: envelope validation failed: %s", validation_err)
            last_error = f"envelope validation: {validation_err}"
            continue

        logger.info(
            "chore_generation: generated %s (%d chars) in %d attempt(s)",
            parsed["workflow_class_name"],
            len(parsed["python_source"]),
            attempt,
        )
        return {
            "module_name": parsed["module_name"],
            "workflow_class_name": parsed["workflow_class_name"],
            "python_source": parsed["python_source"],
            "prompt_hash": prompt_hash,
            "attempts": attempt,
        }

    raise ChoreGenerationError(
        f"generate_chore_template_code exhausted {_GENERATION_MAX_ATTEMPTS} attempts: {last_error}"
    )


def _try_parse_envelope(raw: Any) -> dict[str, Any] | None:
    """Best-effort parse of an Opus response into the {module_name, ...} envelope.

    Handles:
      - Plain JSON
      - JSON wrapped in markdown code fences (```json\\n{...}\\n```)
      - Leading/trailing whitespace and explanation text
      - Brace repair for truncated responses

    Returns None on unparseable input.
    """
    if isinstance(raw, dict):
        return raw  # already parsed (e.g. clerk path)
    if not isinstance(raw, str):
        return None

    text = raw.strip()

    # 1. Direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 2. Strip markdown fence if present
    if text.startswith("```"):
        # Find the inner content between fences
        first_nl = text.find("\n")
        if first_nl > 0:
            inner = text[first_nl + 1:]
            if inner.endswith("```"):
                inner = inner[: -3].rstrip()
            try:
                return json.loads(inner)
            except json.JSONDecodeError:
                text = inner

    # 3. Find first { and last } and try parsing that fragment
    first = text.find("{")
    last = text.rfind("}")
    if first >= 0 and last > first:
        fragment = text[first : last + 1]
        try:
            return json.loads(fragment)
        except json.JSONDecodeError:
            pass

    # 4. Brace repair for truncated JSON
    if first >= 0:
        fragment = text[first:]
        ob = fragment.count("[") - fragment.count("]")
        oc = fragment.count("{") - fragment.count("}")
        repaired = fragment + ("]" * max(0, ob)) + ("}" * max(0, oc))
        try:
            return json.loads(repaired)
        except json.JSONDecodeError:
            pass

    return None
