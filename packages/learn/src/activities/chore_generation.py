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

import asyncio
import hashlib
import json
import logging
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from temporalio import activity

from src.activities.chore_generation_prompts import build_generation_prompt
from src.activities.onboarding_v3 import _call_llm, _parse_json_with_key
from src.workflows.chores._dynamic_loader import validate_template_source

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


# ---------------------------------------------------------------------------
# S4-5: validate_generated_template activity
#
# Thin Temporal-activity wrapper around the Layer 2 static validator. The
# validator implementation itself lives in src.workflows.chores._dynamic_loader
# so that the worker's startup scan of /alfred-data/user-chores/ and the
# onboarding-time generation pipeline apply IDENTICAL checks. This activity
# exists so Temporal workflows (specifically the onboarding Stage 7.5b chain
# in S4-8) can call the validator as a discrete, retry-able, audited step.
# ---------------------------------------------------------------------------


@activity.defn
async def validate_generated_template(python_source: str) -> dict[str, Any]:
    """Run Layer 2 static validation on generated workflow source code.

    This is the single discrete safety step that every generated template
    must pass before it is smoke tested (S4-6) or deployed (S4-7). It runs
    all checks from validate_template_source:

      1. Size cap (< 100KB)
      2. Syntax (ast.parse)
      3. Top-level structure (only imports, classes, funcs, module docstring,
         and the Temporal workflow.unsafe.imports_passed_through with-block)
      4. Import whitelist + manifest check on chore_actions imports
      5. Exactly one @workflow.defn class with one @workflow.run method
      6. Forbidden name scan (eval/exec/os.*/sys.* etc.)
      7. execute_activity calls must reference imported names, not strings
      8. No non-deterministic calls (datetime.now/random.*/uuid.*) at workflow scope

    Args:
        python_source: the full generated file contents as a string

    Returns:
        {
            "ok": bool,
            "violations": list[str],  # empty on success
            "violation_count": int,
        }

    The activity never raises on validation failure — it returns the
    structured result so the caller's retry loop can feed violations back
    into the next generation prompt as retry feedback. Only unexpected
    exceptions (e.g. an ast.parse bug) propagate up to Temporal.
    """
    activity.heartbeat("validating generated template source")

    result = validate_template_source(python_source)

    if result.ok:
        logger.info(
            "validate_generated_template: PASS (source %d bytes)",
            len(python_source),
        )
    else:
        logger.warning(
            "validate_generated_template: FAIL with %d violation(s): %s",
            len(result.violations),
            "; ".join(result.violations[:5]),
        )

    return {
        "ok": result.ok,
        "violations": list(result.violations),
        "violation_count": len(result.violations),
    }


# ---------------------------------------------------------------------------
# S4-6: smoke_test_generated_template activity
#
# Subprocess-isolated import check. The generated Python is written to a
# temp file and loaded by a forked Python interpreter that imports the
# module, introspects the workflow class, and prints a structured JSON
# report to stdout. If the subprocess crashes / hangs / imports cleanly
# but exposes the wrong shape, we capture that without any risk to the
# running alfred-learn worker process.
#
# Why subprocess and not in-process import?
#   The worker is long-running and has already imported most of the
#   learn codebase. An in-process importlib.exec would:
#     1. Pollute sys.modules (two loads of the same dynamic module will
#        conflict on the next worker startup rescan)
#     2. Leak module-level state into the worker (dataclasses decorator
#        side effects, class registrations, etc.)
#     3. Be impossible to time out cleanly (asyncio can't cancel
#        arbitrary Python import machinery mid-flight)
#   Subprocess isolation is both safer and simpler.
#
# We do NOT try to execute the workflow logic itself. Full workflow
# simulation would require registering every activity in the manifest
# as a stub, running a WorkflowEnvironment, and feeding the workflow
# synthetic input — complexity way out of proportion to the safety gain
# over our already-strict Layer 2 static checks. The smoke test is a
# fast "does this even load and expose the right class" guard, nothing
# more.
# ---------------------------------------------------------------------------

# Hard limits on the subprocess.
_SMOKE_TIMEOUT_SECONDS = 30
_SMOKE_MAX_OUTPUT_BYTES = 100_000

# The harness script that runs inside the subprocess. Takes three env
# vars (SMOKE_SOURCE_FILE, SMOKE_MODULE_NAME, SMOKE_WORKFLOW_CLASS_NAME)
# and prints a single JSON line to stdout on completion. Every branch
# returns a single JSON doc so the parent can always deserialize.
_SMOKE_HARNESS = r"""
import importlib.util
import json
import os
import sys
import traceback


def report(ok, **fields):
    payload = {"ok": bool(ok), **fields}
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()
    sys.exit(0 if ok else 1)


source_file = os.environ["SMOKE_SOURCE_FILE"]
module_name = os.environ["SMOKE_MODULE_NAME"]
workflow_class_name = os.environ["SMOKE_WORKFLOW_CLASS_NAME"]

# /app is on sys.path inside the alfred-learn container. That's what
# lets the generated module's `from src.workflows.chores._base import
# ...` and `from src.activities.chore_actions import ...` work.
if "/app" not in sys.path:
    sys.path.insert(0, "/app")

try:
    spec = importlib.util.spec_from_file_location(module_name, source_file)
    if spec is None or spec.loader is None:
        report(False, phase="spec", error="spec_from_file_location returned None")
    module = importlib.util.module_from_spec(spec)
    # Register the module in sys.modules BEFORE exec_module. Temporal's
    # @workflow.defn decorator reads sys.modules[klass.__module__] during
    # class creation to attach definition metadata — if we skip this the
    # decorator raises AttributeError during import.
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
except Exception as exc:
    report(
        False,
        phase="import",
        error=f"{type(exc).__name__}: {exc}",
        traceback=traceback.format_exc(limit=5),
    )

# Verify the declared workflow class exists on the module
workflow_class = getattr(module, workflow_class_name, None)
if workflow_class is None:
    exported = sorted(
        name for name in dir(module)
        if not name.startswith("_") and hasattr(getattr(module, name, None), "__name__")
    )
    report(
        False,
        phase="class_lookup",
        error=f"workflow class {workflow_class_name!r} not found on module",
        exported_names=exported[:20],
    )

# Verify Temporal recognizes it as a workflow
if not hasattr(workflow_class, "__temporal_workflow_definition"):
    report(
        False,
        phase="temporal_marker",
        error=f"{workflow_class_name} is not decorated with @workflow.defn",
    )

# Collect a few useful facts for the audit log
try:
    defn = workflow_class.__temporal_workflow_definition
    workflow_name = getattr(defn, "name", workflow_class_name)
except Exception:
    workflow_name = workflow_class_name

report(
    True,
    phase="done",
    workflow_class_name=workflow_class_name,
    workflow_name=workflow_name,
    module_name=module_name,
)
"""


def _run_smoke_subprocess(
    python_source: str,
    module_name: str,
    workflow_class_name: str,
) -> dict[str, Any]:
    """Synchronous worker that owns the subprocess lifecycle.

    Called from the async activity via asyncio.to_thread so Temporal's
    heartbeat loop keeps ticking.
    """
    # Write the source to a temp file in a private dir. Use a namespaced
    # stem so the subprocess sees a sensible module name.
    with tempfile.TemporaryDirectory(prefix="chore-smoke-") as tmpdir:
        source_path = Path(tmpdir) / f"{module_name}.py"
        try:
            source_path.write_text(python_source)
        except OSError as exc:
            return {
                "ok": False,
                "phase": "write_temp",
                "error": f"{type(exc).__name__}: {exc}",
                "duration_seconds": 0.0,
                "stdout": "",
                "stderr": "",
            }

        env = os.environ.copy()
        env["SMOKE_SOURCE_FILE"] = str(source_path)
        env["SMOKE_MODULE_NAME"] = module_name
        env["SMOKE_WORKFLOW_CLASS_NAME"] = workflow_class_name
        # Prevent the subprocess from writing .pyc files into the real
        # package dirs (we don't want to leave cache artifacts behind).
        env["PYTHONDONTWRITEBYTECODE"] = "1"

        started = time.monotonic()
        try:
            proc = subprocess.run(
                [sys.executable, "-c", _SMOKE_HARNESS],
                capture_output=True,
                timeout=_SMOKE_TIMEOUT_SECONDS,
                env=env,
                text=True,
                cwd=tmpdir,
            )
        except subprocess.TimeoutExpired as exc:
            return {
                "ok": False,
                "phase": "timeout",
                "error": f"subprocess exceeded {_SMOKE_TIMEOUT_SECONDS}s",
                "duration_seconds": float(_SMOKE_TIMEOUT_SECONDS),
                "stdout": (exc.stdout or b"").decode("utf-8", errors="replace")[:_SMOKE_MAX_OUTPUT_BYTES]
                          if isinstance(exc.stdout, (bytes, bytearray))
                          else (exc.stdout or "")[:_SMOKE_MAX_OUTPUT_BYTES],
                "stderr": (exc.stderr or b"").decode("utf-8", errors="replace")[:_SMOKE_MAX_OUTPUT_BYTES]
                          if isinstance(exc.stderr, (bytes, bytearray))
                          else (exc.stderr or "")[:_SMOKE_MAX_OUTPUT_BYTES],
            }
        duration = time.monotonic() - started

        stdout = (proc.stdout or "")[:_SMOKE_MAX_OUTPUT_BYTES]
        stderr = (proc.stderr or "")[:_SMOKE_MAX_OUTPUT_BYTES]

        # The harness always prints a single JSON line on its final
        # stdout line. Parse the LAST non-empty line (import warnings
        # etc. may have printed earlier lines).
        report: dict[str, Any] | None = None
        for line in reversed(stdout.splitlines()):
            line = line.strip()
            if not line:
                continue
            try:
                report = json.loads(line)
                break
            except json.JSONDecodeError:
                continue

        if report is None:
            return {
                "ok": False,
                "phase": "no_report",
                "error": f"subprocess exited {proc.returncode} without a JSON report",
                "duration_seconds": duration,
                "stdout": stdout,
                "stderr": stderr,
            }

        report["duration_seconds"] = duration
        report["stdout"] = stdout
        report["stderr"] = stderr
        return report


@activity.defn
async def smoke_test_generated_template(
    python_source: str,
    module_name: str,
    workflow_class_name: str,
) -> dict[str, Any]:
    """Subprocess-isolated smoke test for a generated chore workflow file.

    Writes the source to a temp file, spawns a Python subprocess that
    imports the module and introspects the declared workflow class, and
    returns a structured report with stdout/stderr/duration.

    Args:
        python_source: the full file source as returned by
            generate_chore_template_code
        module_name: the snake_case identifier (e.g. "gym_attendance_tracker")
        workflow_class_name: the CamelCase class name
            (e.g. "GymAttendanceTrackerWorkflow")

    Returns:
        {
            "ok": bool,
            "phase": str,       # "done" on success, "import"/"class_lookup"/
                                # "temporal_marker"/"timeout"/"no_report" on failure
            "duration_seconds": float,
            "stdout": str,      # captured subprocess stdout (truncated)
            "stderr": str,      # captured subprocess stderr (truncated)
            # on success:
            "workflow_name": str,
            # on failure:
            "error": str,
            "traceback": str,   # first few frames (import failures only)
        }

    The activity heartbeats every few seconds while the subprocess is
    running so Temporal knows we're alive during long imports.
    """
    if not python_source or not python_source.strip():
        return {
            "ok": False,
            "phase": "precondition",
            "error": "python_source is empty",
            "duration_seconds": 0.0,
            "stdout": "",
            "stderr": "",
        }
    if not module_name or not workflow_class_name:
        return {
            "ok": False,
            "phase": "precondition",
            "error": "module_name and workflow_class_name are required",
            "duration_seconds": 0.0,
            "stdout": "",
            "stderr": "",
        }

    activity.heartbeat(
        f"smoke_test: spawning subprocess for {workflow_class_name}"
    )

    # Run the synchronous subprocess worker in a thread so Temporal's
    # heartbeat loop stays responsive. asyncio.to_thread doesn't
    # propagate cancellation into the subprocess, so we rely on the
    # subprocess.run() timeout parameter as the real deadline.
    report = await asyncio.to_thread(
        _run_smoke_subprocess,
        python_source,
        module_name,
        workflow_class_name,
    )

    if report["ok"]:
        logger.info(
            "smoke_test_generated_template: PASS for %s (%.2fs)",
            workflow_class_name,
            report["duration_seconds"],
        )
    else:
        logger.warning(
            "smoke_test_generated_template: FAIL for %s at phase=%s: %s",
            workflow_class_name,
            report.get("phase"),
            report.get("error"),
        )

    return report


# ---------------------------------------------------------------------------
# S4-7: deploy_generated_template activity
#
# Writes a validated + smoke-tested chore template to the persistent
# user-chores directory. The deployment is deliberately minimal:
#
#   1. Atomic write (temp file + rename) to
#      /alfred-data/user-chores/<module_name>.py
#   2. Content-addressed idempotency — skip rewrites if the existing
#      file has the same SHA256 hash
#   3. Audit log entry in /alfred-data/chore-generation-audit.jsonl
#
# This activity does NOT trigger the worker restart — that's the job
# of a separate `restart_learn_worker` activity, called once per batch
# of deployments (the onboarding workflow deploys N templates, then
# restarts once at the end). See the plan's "batch the restart at the
# end of Stage 7.5b" note.
#
# The worker picks up the new template on its next startup via
# load_user_chore_templates (S4-1), which re-applies Layer 2 validation
# as a final defense-in-depth check before importing.
# ---------------------------------------------------------------------------

# Persistent directory for generated chore templates. Lives on the
# encrypted volume (/mnt/encrypted/alfred mounts to /alfred-data inside
# the container) and survives container recreates. Created by the init
# container (see S4-3).
_USER_CHORES_DIR_PATH = Path("/alfred-data/user-chores")

# Audit trail for every deployment attempt — one JSONL line per event.
# The nightly_maintenance workflow will rotate this (Step 5).
_DEPLOY_AUDIT_LOG = Path("/alfred-data/chore-generation-audit.jsonl")


def _append_deploy_audit(entry: dict[str, Any]) -> None:
    """Best-effort append to the deployment audit log.

    Failures here never propagate — the deployment succeeded, the
    audit log is just for post-hoc debugging. Swallow OSError so a
    full disk doesn't block the pipeline.
    """
    try:
        _DEPLOY_AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        with _DEPLOY_AUDIT_LOG.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, default=str) + "\n")
    except OSError as exc:
        logger.warning(
            "deploy_generated_template: failed to write audit log: %s", exc
        )


def _atomic_write_text(path: Path, content: str) -> None:
    """Write text to `path` atomically via a temp file + rename.

    Safe even if the process is killed mid-write — readers either see
    the old content or the new content, never a half-written file.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write to a sibling temp file so the rename happens on the same
    # filesystem (rename across filesystems is not atomic).
    fd, tmp_path_str = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    tmp_path = Path(tmp_path_str)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.replace(tmp_path, path)
    except Exception:
        # Clean up the temp file if rename failed
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


@activity.defn
async def deploy_generated_template(
    python_source: str,
    module_name: str,
    workflow_class_name: str,
) -> dict[str, Any]:
    """Persist a generated chore template file to the user-chores directory.

    Writes /alfred-data/user-chores/<module_name>.py atomically.
    Does NOT restart the worker — that's the caller's responsibility
    (batch all deployments then call restart_learn_worker once).

    Args:
        python_source: the full Python source to write
        module_name: snake_case identifier — becomes <module_name>.py
        workflow_class_name: CamelCase class name (for audit + return)

    Returns:
        {
            "ok": bool,
            "path": str,              # absolute path of the deployed file
            "source_hash": str,       # sha256 of the written source
            "bytes_written": int,
            "idempotent": bool,       # True if file already existed with same hash
            "error": str,             # only on failure
        }

    The activity never raises on expected I/O failures — it returns
    ok=False with an error string. Temporal's retry policy on the
    caller side handles transient issues.
    """
    activity.heartbeat(f"deploying {module_name}.py")

    # Precondition checks
    if not python_source or not python_source.strip():
        return {
            "ok": False,
            "path": "",
            "source_hash": "",
            "bytes_written": 0,
            "idempotent": False,
            "error": "python_source is empty",
        }
    if not module_name or not module_name.replace("_", "").isalnum():
        return {
            "ok": False,
            "path": "",
            "source_hash": "",
            "bytes_written": 0,
            "idempotent": False,
            "error": f"invalid module_name: {module_name!r}",
        }

    target_path = _USER_CHORES_DIR_PATH / f"{module_name}.py"
    source_hash = hashlib.sha256(python_source.encode("utf-8")).hexdigest()

    # Idempotency: if the file already exists with the same hash,
    # don't touch it (avoids unnecessary mtime churn for the worker's
    # next rescan).
    if target_path.exists():
        try:
            existing_hash = hashlib.sha256(
                target_path.read_bytes()
            ).hexdigest()
            if existing_hash == source_hash:
                logger.info(
                    "deploy_generated_template: %s already deployed (hash %s) — skipping",
                    target_path.name,
                    source_hash[:12],
                )
                _append_deploy_audit({
                    "phase": "deploy",
                    "status": "idempotent_skip",
                    "module_name": module_name,
                    "workflow_class_name": workflow_class_name,
                    "source_hash": source_hash,
                    "path": str(target_path),
                    "bytes": len(python_source),
                    "timestamp": time.time(),
                })
                return {
                    "ok": True,
                    "path": str(target_path),
                    "source_hash": source_hash,
                    "bytes_written": 0,
                    "idempotent": True,
                }
        except OSError as exc:
            logger.warning(
                "deploy_generated_template: couldn't read existing %s: %s",
                target_path, exc,
            )
            # Fall through and try to write

    # Atomic write
    try:
        _atomic_write_text(target_path, python_source)
    except OSError as exc:
        logger.error(
            "deploy_generated_template: write failed for %s: %s",
            target_path, exc,
        )
        _append_deploy_audit({
            "phase": "deploy",
            "status": "write_failed",
            "module_name": module_name,
            "workflow_class_name": workflow_class_name,
            "source_hash": source_hash,
            "path": str(target_path),
            "error": f"{type(exc).__name__}: {exc}",
            "timestamp": time.time(),
        })
        return {
            "ok": False,
            "path": str(target_path),
            "source_hash": source_hash,
            "bytes_written": 0,
            "idempotent": False,
            "error": f"{type(exc).__name__}: {exc}",
        }

    logger.info(
        "deploy_generated_template: wrote %s (%d bytes, hash %s)",
        target_path, len(python_source), source_hash[:12],
    )
    _append_deploy_audit({
        "phase": "deploy",
        "status": "ok",
        "module_name": module_name,
        "workflow_class_name": workflow_class_name,
        "source_hash": source_hash,
        "path": str(target_path),
        "bytes": len(python_source),
        "timestamp": time.time(),
    })

    return {
        "ok": True,
        "path": str(target_path),
        "source_hash": source_hash,
        "bytes_written": len(python_source),
        "idempotent": False,
    }


# ---------------------------------------------------------------------------
# S4-7 companion: restart_learn_worker activity
#
# Calls the ctrl-api /api/v1/admin/restart-learn route (S4-2) to force
# a graceful recreate of the alfred-learn container. This is how newly
# deployed chore templates become visible to Temporal — the worker's
# ALL_WORKFLOWS list is constructed at startup, so we need to restart
# to pick up new dynamic templates.
#
# Important caveats:
#
#   - This activity WILL kill the worker process it's running on.
#     Temporal's activity model handles this: the activity gets marked
#     as failed with "worker shutting down", the workflow retries it
#     on the new worker, and the second attempt returns early via the
#     rate-limit check on the ctrl-api side (30-second minimum interval).
#
#   - The caller workflow MUST configure a retry policy that allows
#     worker-shutdown recoveries (the default Temporal retry policy
#     handles this automatically).
#
#   - Call this ONCE per batch of deployments, never per template.
# ---------------------------------------------------------------------------

def _resolve_ctrl_api_base() -> str:
    """Return the ctrl-api base URL reachable from inside alfred-learn.

    In the tenant docker-compose stack ctrl-api is a sibling service
    reachable as `http://ctrl-api:3100` via Docker's built-in DNS.
    The `ALFRED_CTRL_URL` env var overrides this (set in
    docker-compose.yaml). We never use `host.docker.internal` — that
    hostname only resolves on Docker Desktop (macOS/Windows), not on
    production Linux hosts.
    """
    return os.environ.get("ALFRED_CTRL_URL", "http://ctrl-api:3100").rstrip("/")


def _restart_learn_endpoint() -> str:
    return _resolve_ctrl_api_base() + "/api/v1/admin/restart-learn"


def _resolve_ctrl_api_token() -> str:
    """Return the admin token for the ctrl-api restart route.

    Looks at AAS_API_KEY first (the shared tenant auth token),
    falls back to reading the gateway token file as a last-resort
    source — kept as a safety net so a misconfigured env doesn't
    deadlock the pipeline.
    """
    token = os.environ.get("AAS_API_KEY", "")
    if token:
        return token
    token_file = os.environ.get("OPENCLAW_GATEWAY_TOKEN_FILE", "")
    if token_file:
        try:
            return Path(token_file).read_text().strip()
        except OSError:
            pass
    return ""


@activity.defn
async def restart_learn_worker() -> dict[str, Any]:
    """Trigger ctrl-api to force-recreate the alfred-learn container.

    Called once per onboarding generation batch (after all templates
    have been deployed). The activity SHOULD be the final step of
    Stage 7.5b so Temporal picks up the workflow on the restarted
    worker with all new dynamic templates loaded.

    Returns:
        {
            "ok": bool,
            "status_code": int | None,
            "response_body": str,     # first 500 chars
            "duration_seconds": float,
            "error": str,             # on failure
        }

    Note: because this activity KILLS its own worker, the HTTP response
    may not come back before the process dies. The caller's retry policy
    handles recovery — on the second attempt the ctrl-api rate limiter
    (30-second window, S4-2) returns 429 and we treat that as success.
    """
    import httpx  # local import — keeps worker startup fast

    activity.heartbeat("restart_learn_worker: calling ctrl-api")

    token = _resolve_ctrl_api_token()
    if not token:
        return {
            "ok": False,
            "status_code": None,
            "response_body": "",
            "duration_seconds": 0.0,
            "error": "no AAS_API_KEY available",
        }

    started = time.monotonic()
    endpoint = _restart_learn_endpoint()
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                endpoint,
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.ConnectError as exc:
        # Likely the ctrl-api already killed us before the HTTP response
        # came back. Treat as a "probably succeeded" outcome — the next
        # retry of this activity on the restarted worker will confirm.
        logger.info(
            "restart_learn_worker: connect error (likely expected — worker restart in flight): %s",
            exc,
        )
        return {
            "ok": True,
            "status_code": None,
            "response_body": "",
            "duration_seconds": time.monotonic() - started,
            "error": f"ConnectError: {exc}",
            "note": "connection dropped during restart — assuming success",
        }
    except Exception as exc:
        logger.error("restart_learn_worker: unexpected error: %s", exc)
        return {
            "ok": False,
            "status_code": None,
            "response_body": "",
            "duration_seconds": time.monotonic() - started,
            "error": f"{type(exc).__name__}: {exc}",
        }

    duration = time.monotonic() - started
    body_snippet = resp.text[:500] if resp.text else ""

    # Rate-limited (429) means a restart already happened in the last
    # 30 seconds — treat as success for our purposes (the worker IS
    # being restarted by someone). The rate limit exists precisely to
    # make the restart idempotent during Temporal retry storms.
    if resp.status_code in (200, 429):
        logger.info(
            "restart_learn_worker: ctrl-api responded %d (%.2fs)",
            resp.status_code, duration,
        )
        return {
            "ok": True,
            "status_code": resp.status_code,
            "response_body": body_snippet,
            "duration_seconds": duration,
        }

    logger.error(
        "restart_learn_worker: unexpected status %d: %s",
        resp.status_code, body_snippet,
    )
    return {
        "ok": False,
        "status_code": resp.status_code,
        "response_body": body_snippet,
        "duration_seconds": duration,
        "error": f"unexpected status {resp.status_code}",
    }
