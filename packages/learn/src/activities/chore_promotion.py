"""Chore promotion reflection activities [S5-2].

The weekly ChorePromotionReflectionWorkflow runs these activities in
sequence to identify generated chore templates worth promoting to the
standard library via a GitHub PR (S5-3):

  1. scan_user_chores_directory()
       List every generated template file on the encrypted volume and
       enrich each with its run history statistics (from S5-1).

  2. identify_promotion_candidates(templates, min_runs, min_success_rate)
       Filter the scan output to templates that have run enough times
       with a high enough success rate to be worth a PR. Pure Python —
       no LLM, no I/O.

  3. draft_promotion_proposal(candidate)
       Ask Opus to write a human-reviewable rationale for promoting
       this specific template. Returns a draft dict with title, body,
       and the template source code.

  4. save_promotion_draft(proposal)
       Persist the draft to /alfred-data/promotion-drafts/<slug>.json
       so S5-3's create_github_promotion_pr activity can pick it up
       later (either on the same workflow tick or via a manual
       operator trigger).

All activities are best-effort: a failure on one template doesn't
block the workflow from processing the next one. The workflow as a
whole always completes with a structured result even on partial
failure.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from temporalio import activity

from src.activities.onboarding_v3 import _call_llm
from src.workflows.chores._base import get_chore_run_statistics

logger = logging.getLogger("alfred-learn")


# Source of truth for deployed generated templates (written by S4-7).
_USER_CHORES_DIR = Path("/alfred-data/user-chores")

# Destination for drafted promotion proposals.
_PROMOTION_DRAFTS_DIR = Path("/alfred-data/promotion-drafts")

# Hard limit on how many candidates the reflection workflow drafts per
# tick. Opus calls are expensive — 5 drafts = 5 Opus calls = ~$2-5 per
# tick depending on template size.
_MAX_DRAFTS_PER_TICK = 5

# Cap on how much template source we include in the prompt. Temporal
# audit logs get big fast if we put every generated template in every
# prompt.
_MAX_TEMPLATE_SOURCE_CHARS = 12_000


@activity.defn
async def scan_user_chores_directory() -> list[dict[str, Any]]:
    """Walk /alfred-data/user-chores/ and return metadata for each file.

    For each .py file (excluding _private and __init__):
      - Read source from disk
      - Derive the module_name (stem) and a best-guess slug
      - Query run history via get_chore_run_statistics

    Returns a list of dicts:
        [
            {
                "module_name": str,
                "file_path": str,
                "bytes": int,
                "source": str,
                "slug_guesses": list[str],  # candidate chore slugs to stat
                "stats": dict,              # from get_chore_run_statistics
            },
            ...
        ]

    The `slug_guesses` field exists because the run history indexes by
    chore_slug (kebab-case) but the file is named after module_name
    (snake_case). The scan tries both and returns whichever has more
    matching entries. Empty list = no generated templates deployed.
    """
    results: list[dict[str, Any]] = []
    if not _USER_CHORES_DIR.exists() or not _USER_CHORES_DIR.is_dir():
        logger.info("scan_user_chores_directory: %s does not exist", _USER_CHORES_DIR)
        return results

    for path in sorted(_USER_CHORES_DIR.glob("*.py")):
        if path.name.startswith("_"):
            continue
        module_name = path.stem
        try:
            source = path.read_text()
        except OSError as exc:
            logger.warning("scan: failed to read %s: %s", path, exc)
            continue

        # The chore_slug convention from S4-8 is kebab-case of the
        # module_name. Try that first; fall back to module_name itself.
        kebab_slug = module_name.replace("_", "-")
        stats = await get_chore_run_statistics(kebab_slug, "")
        if stats.get("total_runs", 0) == 0:
            # No history under the kebab slug — try snake case
            snake_stats = await get_chore_run_statistics(module_name, "")
            if snake_stats.get("total_runs", 0) > stats.get("total_runs", 0):
                stats = snake_stats

        results.append({
            "module_name": module_name,
            "file_path": str(path),
            "bytes": len(source),
            "source": source,
            "slug_guesses": [kebab_slug, module_name],
            "stats": stats,
        })

    logger.info("scan_user_chores_directory: found %d generated templates", len(results))
    return results


@activity.defn
async def identify_promotion_candidates(
    templates: list[dict[str, Any]],
    min_runs: int = 20,
    min_success_rate: float = 0.95,
) -> list[dict[str, Any]]:
    """Filter scanned templates down to promotion-worthy candidates.

    Criteria:
      - total_runs >= min_runs (default 20)
      - live_runs / total_runs >= min_success_rate (default 0.95)
      - last_run is within the last 90 days (stale templates are
        probably abandoned, not promotion-worthy)

    Returns a copy of the input list filtered to entries that match all
    three criteria. Never raises — bad entries are skipped silently so
    the workflow continues.

    This activity is pure Python / no I/O / no LLM. The thresholds are
    passed as parameters so the caller (the workflow) can tune them per
    environment (e.g. lower bar for staging tenants).
    """
    candidates: list[dict[str, Any]] = []
    now = time.time()
    ninety_days_seconds = 90 * 24 * 60 * 60

    for entry in templates:
        stats = entry.get("stats") or {}
        total = stats.get("total_runs", 0)
        live = stats.get("live_runs", 0)
        last = stats.get("last_run")

        if not isinstance(total, int) or total < min_runs:
            continue
        if total == 0:  # defensive — shouldn't happen given the check above
            continue
        success_rate = live / total if total else 0.0
        if success_rate < min_success_rate:
            continue
        if not isinstance(last, (int, float)) or (now - last) > ninety_days_seconds:
            continue

        candidates.append({
            **entry,
            "success_rate": success_rate,
            "meets_thresholds": {
                "min_runs": min_runs,
                "min_success_rate": min_success_rate,
                "actual_runs": total,
                "actual_success_rate": success_rate,
            },
        })

    logger.info(
        "identify_promotion_candidates: %d templates → %d candidates (min_runs=%d, min_success_rate=%.2f)",
        len(templates), len(candidates), min_runs, min_success_rate,
    )
    return candidates


@activity.defn
async def draft_promotion_proposal(candidate: dict[str, Any]) -> dict[str, Any]:
    """Call Opus to write a PR title + body for promoting one candidate.

    Returns a draft dict:
        {
            "ok": bool,
            "module_name": str,
            "pr_title": str,              # <70 chars
            "pr_body": str,               # markdown, includes rationale + stats
            "python_source": str,         # unchanged from input
            "workflow_class_name": str,   # extracted from source via AST
            "candidate_stats": dict,
            "drafted_at": float,          # epoch timestamp
            "error": str,                 # on failure
        }

    On LLM failure we return {"ok": False, "error": ...} rather than
    raising — the calling workflow logs the failure and moves on to
    the next candidate.
    """
    import ast

    module_name = candidate.get("module_name", "")
    source = candidate.get("source", "")
    stats = candidate.get("stats", {})

    if not source:
        return {
            "ok": False,
            "module_name": module_name,
            "error": "candidate has no source",
            "drafted_at": time.time(),
        }

    # Extract the workflow class name from the source via AST — we can't
    # trust the filename to give it to us since module_name is snake_case
    # but the class is CamelCase.
    workflow_class_name = ""
    try:
        tree = ast.parse(source)
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                for dec in node.decorator_list:
                    # Match @workflow.defn or @workflow.defn(name=...)
                    target = dec
                    if isinstance(dec, ast.Call):
                        target = dec.func
                    if (
                        isinstance(target, ast.Attribute)
                        and target.attr == "defn"
                        and isinstance(target.value, ast.Name)
                        and target.value.id == "workflow"
                    ):
                        workflow_class_name = node.name
                        break
                if workflow_class_name:
                    break
    except SyntaxError:
        pass

    if not workflow_class_name:
        return {
            "ok": False,
            "module_name": module_name,
            "error": "could not extract workflow class name from source",
            "drafted_at": time.time(),
        }

    prompt = _build_promotion_prompt(
        module_name=module_name,
        workflow_class_name=workflow_class_name,
        source=source[:_MAX_TEMPLATE_SOURCE_CHARS],
        stats=stats,
    )

    activity.heartbeat(f"drafting promotion proposal for {module_name}")
    try:
        raw = await _call_llm(
            prompt,
            max_tokens=2048,
            heartbeat_message=f"opus drafting promotion for {module_name}",
        )
    except Exception as exc:
        logger.error("draft_promotion_proposal: LLM failed for %s: %s", module_name, exc)
        return {
            "ok": False,
            "module_name": module_name,
            "workflow_class_name": workflow_class_name,
            "error": f"LLM call failed: {type(exc).__name__}: {exc}",
            "drafted_at": time.time(),
        }

    pr_title, pr_body = _parse_promotion_response(raw, module_name)

    return {
        "ok": True,
        "module_name": module_name,
        "workflow_class_name": workflow_class_name,
        "pr_title": pr_title,
        "pr_body": pr_body,
        "python_source": source,
        "candidate_stats": stats,
        "drafted_at": time.time(),
    }


def _build_promotion_prompt(
    module_name: str,
    workflow_class_name: str,
    source: str,
    stats: dict[str, Any],
) -> str:
    """Construct the Opus prompt for drafting a promotion PR description."""
    total = stats.get("total_runs", 0)
    live = stats.get("live_runs", 0)
    dry = stats.get("dry_runs", 0)
    success_rate = (live / total * 100) if total else 0.0

    recent = stats.get("recent_runs") or []
    recent_summary = "\n".join(
        f"  - dry={r.get('was_dry_run')} summary={r.get('result_summary', '')[:120]}"
        for r in recent[-5:]
    )

    return f"""You are drafting a GitHub pull request to promote a generated Alfred chore template from a single tenant's per-user directory into the shared standard library.

## The template

- Module name: `{module_name}`
- Workflow class: `{workflow_class_name}`
- Usage history on this tenant:
  - Total runs: {total} ({live} live, {dry} dry-runs during quarantine)
  - Success rate: {success_rate:.1f}%
  - Recent results:
{recent_summary if recent_summary else "    (no recent runs)"}

## The template source

```python
{source}
```

## What to write

Return ONLY valid JSON matching this schema. No markdown fences, no preamble:

```json
{{
  "pr_title": "<short PR title, under 70 chars, starts with 'chore: promote'>",
  "pr_body": "<markdown body, 3-6 paragraphs, includes: what the template does, why it's worth promoting (cite usage data), what similar users might benefit from it, any concerns a reviewer should weigh>"
}}
```

The PR body will be rendered on GitHub. Use markdown headers, bullet lists, and fenced code blocks freely. Be honest about limitations — this is for a human reviewer who is going to decide whether to merge. Don't oversell.

Begin.
"""


def _parse_promotion_response(raw: Any, module_name: str) -> tuple[str, str]:
    """Best-effort parse of Opus's promotion response.

    Returns (pr_title, pr_body). On parse failure, returns reasonable
    defaults constructed from the module_name so the draft still looks
    presentable to a human reviewer.
    """
    default_title = f"chore: promote {module_name} to standard library"
    default_body = (
        f"Automatic promotion draft for `{module_name}`. "
        f"Opus was unable to generate a structured rationale — please fill in manually."
    )

    if not isinstance(raw, str):
        return default_title, default_body

    text = raw.strip()
    # Strip markdown fences if Opus ignored the instruction
    if text.startswith("```"):
        nl = text.find("\n")
        if nl > 0:
            text = text[nl + 1 :]
            if text.endswith("```"):
                text = text[:-3].rstrip()

    # Try direct parse first
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        parsed = None

    if not isinstance(parsed, dict):
        # Try finding the first {...} fragment
        first = text.find("{")
        last = text.rfind("}")
        if first >= 0 and last > first:
            try:
                parsed = json.loads(text[first : last + 1])
            except (json.JSONDecodeError, ValueError):
                parsed = None

    if not isinstance(parsed, dict):
        return default_title, default_body

    title = str(parsed.get("pr_title") or default_title).strip()
    body = str(parsed.get("pr_body") or default_body).strip()

    # Safety: cap title length
    if len(title) > 100:
        title = title[:97] + "..."

    return title, body


@activity.defn
async def save_promotion_draft(proposal: dict[str, Any]) -> dict[str, Any]:
    """Persist a drafted promotion proposal to disk.

    Writes to /alfred-data/promotion-drafts/<module_name>-<timestamp>.json
    so the S5-3 create_github_promotion_pr activity (or a manual operator
    script) can pick it up later. One file per draft — we never overwrite.

    Returns:
        {
            "ok": bool,
            "path": str,      # absolute path of the saved draft
            "error": str,     # on failure
        }

    Swallows OSError and returns ok=False on failure. The workflow
    continues even if one save fails.
    """
    if not proposal.get("ok"):
        return {
            "ok": False,
            "path": "",
            "error": f"refusing to save a non-ok proposal: {proposal.get('error', 'unknown')}",
        }

    module_name = str(proposal.get("module_name") or "unknown")
    ts = int(time.time())
    filename = f"{module_name}-{ts}.json"
    target = _PROMOTION_DRAFTS_DIR / filename

    try:
        _PROMOTION_DRAFTS_DIR.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(proposal, default=str, indent=2), encoding="utf-8")
    except OSError as exc:
        logger.error("save_promotion_draft: failed to write %s: %s", target, exc)
        return {
            "ok": False,
            "path": str(target),
            "error": f"{type(exc).__name__}: {exc}",
        }

    logger.info("save_promotion_draft: wrote %s", target)
    return {"ok": True, "path": str(target)}


# ---------------------------------------------------------------------------
# S5-3: create_github_promotion_pr activity
#
# Takes a drafted proposal (from save_promotion_draft) and opens a real
# GitHub pull request that adds the template file to the standard
# library. Uses the GitHub REST API directly via httpx — we deliberately
# avoid the `gh` CLI because it would bloat the alfred-learn Docker
# image with a Go binary just for a handful of REST calls.
#
# Auth via env:
#   ALFRED_PROMOTION_GITHUB_TOKEN  — PAT or fine-grained token with
#                                    repo:write on the target repo
#   ALFRED_PROMOTION_REPO          — "owner/name" (default: ssdavidai/alfred-platform)
#   ALFRED_PROMOTION_BASE_BRANCH   — base branch to PR against (default: main)
#
# Missing token → activity returns ok=False gracefully (never raises).
# Wrong token → GitHub returns 401, activity returns structured error.
# Network failure → returned as structured error for retry.
# ---------------------------------------------------------------------------

_GITHUB_API_BASE = "https://api.github.com"
_DEFAULT_PROMOTION_REPO = "ssdavidai/alfred-platform"
_DEFAULT_PROMOTION_BASE_BRANCH = "main"
_STANDARD_LIBRARY_DIR = "packages/learn/src/workflows/chores"


def _promotion_repo() -> str:
    return os.environ.get("ALFRED_PROMOTION_REPO", _DEFAULT_PROMOTION_REPO)


def _promotion_base_branch() -> str:
    return os.environ.get("ALFRED_PROMOTION_BASE_BRANCH", _DEFAULT_PROMOTION_BASE_BRANCH)


def _promotion_github_token() -> str:
    return os.environ.get("ALFRED_PROMOTION_GITHUB_TOKEN", "")


@activity.defn
async def create_github_promotion_pr(draft: dict[str, Any]) -> dict[str, Any]:
    """Open a GitHub PR that promotes the drafted template to the standard library.

    Flow (all via GitHub REST API — no git clone, no gh CLI):
      1. GET /repos/{repo}/git/refs/heads/{base}       → get base SHA
      2. POST /repos/{repo}/git/refs                    → create new branch
      3. PUT /repos/{repo}/contents/{path}              → create file on branch
      4. POST /repos/{repo}/pulls                       → open the PR
      5. (best-effort) POST /repos/{repo}/issues/{N}/labels → apply labels

    Args:
        draft: a proposal dict from draft_promotion_proposal / save_promotion_draft.
            Must contain: module_name, workflow_class_name, pr_title,
            pr_body, python_source.

    Returns:
        {
            "ok": bool,
            "pr_url": str,      # HTML url of the created PR
            "pr_number": int,   # PR number
            "branch": str,      # name of the created branch
            "error": str,       # on failure
            "phase": str,       # which step failed: "auth"|"get_base"|
                                # "create_branch"|"create_file"|"create_pr"|"label"
        }

    Never raises on expected failures (missing token, HTTP error, etc.) —
    returns a structured error dict so the calling workflow can log and
    move on. Only unexpected Python errors (e.g. malformed draft dict)
    propagate up to Temporal.
    """
    import httpx  # local import — keeps activity discovery cheap

    if not isinstance(draft, dict):
        return {
            "ok": False,
            "phase": "precondition",
            "error": f"draft is not a dict: {type(draft).__name__}",
        }

    module_name = draft.get("module_name")
    python_source = draft.get("python_source")
    pr_title = draft.get("pr_title")
    pr_body = draft.get("pr_body")

    if not all(isinstance(v, str) and v for v in [module_name, python_source, pr_title, pr_body]):
        return {
            "ok": False,
            "phase": "precondition",
            "error": "draft missing required fields (module_name, python_source, pr_title, pr_body)",
        }

    token = _promotion_github_token()
    if not token:
        return {
            "ok": False,
            "phase": "auth",
            "error": "ALFRED_PROMOTION_GITHUB_TOKEN not set — skipping GitHub PR creation",
        }

    repo = _promotion_repo()
    base = _promotion_base_branch()
    branch = f"chore-promotion/{module_name}-{int(time.time())}"
    file_path = f"{_STANDARD_LIBRARY_DIR}/{module_name}.py"

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "alfred-learn-chore-promotion",
    }

    activity.heartbeat(f"create_github_promotion_pr: opening PR for {module_name}")

    async with httpx.AsyncClient(timeout=30.0) as client:
        # 1. Get base branch SHA
        try:
            r = await client.get(
                f"{_GITHUB_API_BASE}/repos/{repo}/git/refs/heads/{base}",
                headers=headers,
            )
        except httpx.HTTPError as exc:
            return {
                "ok": False, "phase": "get_base",
                "error": f"network error: {type(exc).__name__}: {exc}",
            }
        if r.status_code != 200:
            return {
                "ok": False, "phase": "get_base",
                "error": f"{r.status_code}: {r.text[:300]}",
            }
        base_sha = r.json().get("object", {}).get("sha", "")
        if not base_sha:
            return {
                "ok": False, "phase": "get_base",
                "error": "no sha in base branch response",
            }

        # 2. Create new branch from base
        try:
            r = await client.post(
                f"{_GITHUB_API_BASE}/repos/{repo}/git/refs",
                headers=headers,
                json={"ref": f"refs/heads/{branch}", "sha": base_sha},
            )
        except httpx.HTTPError as exc:
            return {
                "ok": False, "phase": "create_branch",
                "error": f"network error: {type(exc).__name__}: {exc}",
            }
        if r.status_code not in (200, 201):
            return {
                "ok": False, "phase": "create_branch",
                "error": f"{r.status_code}: {r.text[:300]}",
                "branch": branch,
            }

        # 3. Create the template file on the new branch
        encoded_source = base64.b64encode(
            python_source.encode("utf-8")
        ).decode("ascii")
        commit_message = (
            f"chore: promote {module_name} to standard library\n\n"
            f"Auto-generated by ChorePromotionReflectionWorkflow (S5-2).\n"
            f"See PR body for rationale + usage stats."
        )
        try:
            r = await client.put(
                f"{_GITHUB_API_BASE}/repos/{repo}/contents/{file_path}",
                headers=headers,
                json={
                    "message": commit_message,
                    "content": encoded_source,
                    "branch": branch,
                },
            )
        except httpx.HTTPError as exc:
            return {
                "ok": False, "phase": "create_file",
                "error": f"network error: {type(exc).__name__}: {exc}",
                "branch": branch,
            }
        if r.status_code not in (200, 201):
            return {
                "ok": False, "phase": "create_file",
                "error": f"{r.status_code}: {r.text[:300]}",
                "branch": branch,
            }

        # 4. Open the PR
        try:
            r = await client.post(
                f"{_GITHUB_API_BASE}/repos/{repo}/pulls",
                headers=headers,
                json={
                    "title": pr_title,
                    "body": pr_body,
                    "head": branch,
                    "base": base,
                    "draft": True,  # Always open as draft — humans decide when to mark ready
                },
            )
        except httpx.HTTPError as exc:
            return {
                "ok": False, "phase": "create_pr",
                "error": f"network error: {type(exc).__name__}: {exc}",
                "branch": branch,
            }
        if r.status_code not in (200, 201):
            return {
                "ok": False, "phase": "create_pr",
                "error": f"{r.status_code}: {r.text[:300]}",
                "branch": branch,
            }

        pr_data = r.json()
        pr_number = pr_data.get("number")
        pr_url = pr_data.get("html_url", "")

        # 5. Best-effort label application (missing labels silently ignored by GitHub)
        if isinstance(pr_number, int):
            try:
                await client.post(
                    f"{_GITHUB_API_BASE}/repos/{repo}/issues/{pr_number}/labels",
                    headers=headers,
                    json={"labels": ["chore-system", "promotion-candidate", "needs-review"]},
                )
            except httpx.HTTPError:
                # Labels are cosmetic — don't fail the whole PR creation
                pass

        logger.info(
            "create_github_promotion_pr: opened PR #%s for %s at %s",
            pr_number, module_name, pr_url,
        )
        return {
            "ok": True,
            "phase": "done",
            "pr_url": pr_url,
            "pr_number": pr_number,
            "branch": branch,
        }
