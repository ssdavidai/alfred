"""Prompt templates for the Step 4 chore code generation activity.

Kept in a separate module so the prompt text can be edited / iterated on
without touching the activity logic. The prompt is the contract Opus must
satisfy when generating a new chore template:
  - Real Temporal workflow Python file
  - Forbidden imports listed explicitly
  - Required structure shown via worked examples
  - Activity manifest given as the call menu
  - Output format specified as a strict JSON envelope
"""
from __future__ import annotations

from typing import Any

from src.chore_manifest import (
    FORBIDDEN_IMPORTS,
    render_manifest_for_prompt,
)


def _render_forbidden_imports() -> str:
    """Render the forbidden import list for the prompt."""
    return ", ".join(sorted(FORBIDDEN_IMPORTS))


def build_generation_prompt(
    opportunity: dict[str, Any],
    profile_slice: dict[str, Any],
    template_examples: dict[str, str],
    retry_feedback: str = "",
) -> str:
    """Construct the Opus prompt that generates one new chore template.

    Args:
        opportunity: the unmatched ChoreOpportunity dict from onboard.json
        profile_slice: a small dict containing only the profile fields
            relevant to this opportunity (rhythm, communication_style,
            relevant matter list, etc.) — never the full profile (would
            blow the context budget)
        template_examples: dict[template_id -> source code] of the
            existing standard-library templates as worked examples
        retry_feedback: appended on retry attempts to tell Opus what was
            wrong with its previous response (validation violations,
            JSON parse errors, etc.)
    """
    import json

    forbidden = _render_forbidden_imports()
    manifest_block = render_manifest_for_prompt(
        filter_classifications={
            "pure_python", "vault_read", "vault_write", "llm", "notification",
        }
    )
    if len(manifest_block) > 12000:
        manifest_block = manifest_block[:12000] + "\n... (manifest truncated)"

    examples_block = "\n\n".join(
        f"### Example template `{tid}`\n```python\n{src}\n```"
        for tid, src in template_examples.items()
        if src
    )

    opportunity_block = json.dumps(opportunity, indent=2, default=str)
    profile_block = json.dumps(profile_slice, indent=2, default=str)[:3000]

    retry_block = ""
    if retry_feedback:
        retry_block = (
            "\n\n**IMPORTANT: previous generation attempt failed validation** —\n"
            + retry_feedback
            + "\nFix the specific issues above. Return strictly valid Python that "
            + "passes every check listed in the contract section.\n"
        )

    return f"""You are Alfred's chore template generator. Your job: write a NEW Python Temporal workflow file that implements one specific chore opportunity for the master.

## The opportunity you need to implement

```json
{opportunity_block}
```

## Relevant profile context

```json
{profile_block}
```

## Hard contract — your generated code MUST satisfy ALL of these

The generated file goes through a strict static validator before deployment. ANY violation rejects your code and triggers a retry.

### Required structure
1. Module starts with `from __future__ import annotations`
2. Exactly ONE class decorated with `@workflow.defn(name="<class_name>")`
3. That class has exactly ONE method decorated with `@workflow.run`
4. An input dataclass and a result dataclass, both at module scope
5. NO top-level statements except: imports, class definitions, and `with workflow.unsafe.imports_passed_through():` for activity imports

### Allowed imports — and ONLY these
- `from __future__ import annotations`
- `from dataclasses import dataclass, field`
- `from datetime import timedelta, datetime, timezone`
- `from typing import Any, Optional`
- `from temporalio import workflow`
- `from temporalio.common import RetryPolicy`
- `from src.workflows.chores._base import load_chore_context, record_chore_run`
- `from src.activities.chore_actions import <names from manifest>` (inside `with workflow.unsafe.imports_passed_through():`)
- `import json`

### Forbidden — never reference these
{forbidden}

Also: never call `eval`, `exec`, `compile`, `__import__`, `globals`, `locals`, `open`, `breakpoint`, `getattr`/`setattr`/`delattr`, `vars`, `dir`.

### Determinism (Temporal replay safety)
- NO `datetime.now()`, `random.*`, `uuid.*`, `time.time()` at workflow scope. Always wrap such non-deterministic calls inside an activity.

### Activity calls
- Every `workflow.execute_activity(NAME, ...)` MUST reference an activity NAME that was imported from `chore_actions` or `_base`. String literals are rejected.
- Always set `start_to_close_timeout` (use `timedelta(seconds=N)` or `timedelta(minutes=N)`)
- For activities that fetch data, also set `heartbeat_timeout=timedelta(seconds=60)` and `retry_policy=RetryPolicy(maximum_attempts=3)`
- For LLM-calling activities (ask_alfred_*, *_via_llm), set `start_to_close_timeout=timedelta(minutes=5)`, `heartbeat_timeout=timedelta(seconds=60)`, `retry_policy=RetryPolicy(maximum_attempts=2)`

## Activity manifest (the menu of things you can call)

These are the ONLY activities you may call from the generated workflow. Do NOT invent new ones.

{manifest_block}

## Worked examples (study these — your output should follow the same shape)

{examples_block}

## Design rules — write code that matches Alfred's philosophy

1. **Python does the work, LLM only judges.** The workflow handles control flow, state, filtering, and diffing in deterministic Python. The LLM is consulted ONLY at decision gates (e.g. "is this anomaly worth notifying the user about?"). Most ticks of most chores should make ZERO LLM calls.
2. **Cheap deterministic filtering before any LLM call.** Use threshold checks, count comparisons, and snapshot diffs to decide whether to bother the LLM. Only escalate to the LLM when the cheap path can't decide.
3. **Heartbeat during long calls.** If you call an activity that takes more than ~30 seconds, the activity itself heartbeats — you don't need to do anything special.
4. **Idempotent activities.** Activities that write data should tolerate being called twice without side effects piling up.
5. **Quiet weeks should be silent.** If nothing interesting happened, return early without calling `send_chore_notification`. The user doesn't want a "nothing to report" message every week.

## Your output format

Return ONLY valid JSON matching this exact schema. No markdown fences, no preamble, no trailing explanation.

```json
{{
  "module_name": "<a snake_case slug, e.g. 'gym_attendance_tracker'>",
  "workflow_class_name": "<a CamelCase class name, e.g. 'GymAttendanceTrackerWorkflow' — must end with 'Workflow'>",
  "python_source": "<the full Python file source as a single string with \\n line breaks>"
}}
```

The `module_name` must be a valid Python identifier (lowercase, snake_case). The `workflow_class_name` must end with `Workflow` and be a valid Python class name. The `python_source` must be the COMPLETE file contents — every line, every import, every blank line. Do NOT abbreviate with "...".

{retry_block}
Begin generating now.
"""
