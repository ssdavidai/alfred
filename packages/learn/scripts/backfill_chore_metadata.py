"""Backfill chore metadata (Phase 2): display_name, display_body, category,
plus activities_used / tools_used / uses_llm / llm_agent_id / vault_reads /
vault_writes on every chore vault record.

For each chore on the tenant:

  1. Locate its Python source (user-generated at
     ``/alfred-data/user-chores/<module>.py`` OR standard-library at
     ``/app/src/workflows/chores/<template>.py``).
  2. Run ``chore_static_analyzer`` to derive the capability fields
     (activities_used, tools_used, uses_llm, llm_agent_id, vault_*).
     This is the source of truth — what the code actually does.
  3. Call clerk once per chore to produce ``display_name`` (≤ 50 chars)
     + ``display_body`` (markdown what+why, 60-160 words) + ``category``
     (one of: briefing | digest | watch | context-build | prefetch |
     maintenance). The LLM gets the existing user_facing_description as
     context so the rewrite preserves the principal's domain knowledge.
  4. PATCH the chore vault record's frontmatter via ctrl-api.

Idempotent: skips chores that already have display_name + display_body
set. Pass ``--force`` to re-derive everything.

Usage::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.backfill_chore_metadata [--dry-run] [--force]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from src.activities.chore_static_analyzer import analyze_chore_source
from src.activities.clerk import _call_clerk


logger = logging.getLogger("backfill-chore-metadata")


USER_CHORES_DIR = Path("/alfred-data/user-chores")
STDLIB_CHORES_DIR = Path("/app/src/workflows/chores")
_VALID_CATEGORIES = {
    "briefing", "digest", "watch",
    "context-build", "prefetch", "maintenance",
}


def _ctrl_url() -> str:
    return os.environ.get("ALFRED_CTRL_URL", "http://ctrl-api:3100")


def _auth() -> dict[str, str]:
    api_key = os.environ.get("AAS_API_KEY", "")
    if not api_key:
        raise RuntimeError("AAS_API_KEY unset")
    return {"Authorization": f"Bearer {api_key}"}


def _locate_source(fm: dict[str, Any]) -> Path | None:
    """Find the Python source for a chore.

    Generated chores live under user-chores keyed by template (same as
    module_name). Standard-library chores live under workflows/chores
    keyed by template (e.g. ``daily_morning_briefing``).
    """
    template = str(fm.get("template") or "").strip()
    if not template:
        return None
    user_path = USER_CHORES_DIR / f"{template}.py"
    if user_path.exists():
        return user_path
    stdlib_path = STDLIB_CHORES_DIR / f"{template}.py"
    if stdlib_path.exists():
        return stdlib_path
    return None


def _build_prompt(fm: dict[str, Any], manifest: dict[str, Any]) -> str:
    """Prompt for display_name + display_body + category. Feeds the
    LLM existing fields so the rewrite is grounded, not invented.
    """
    name = str(fm.get("name") or "").strip()
    description = str(fm.get("user_facing_description") or "").strip()
    schedule = str(fm.get("schedule") or "").strip()
    template = str(fm.get("template") or "").strip()
    activities = manifest.get("activities_used") or []
    tools = manifest.get("tools_used") or []
    uses_llm = bool(manifest.get("uses_llm"))
    vault_writes = manifest.get("vault_writes") or []
    vault_reads = manifest.get("vault_reads") or []

    capabilities_block = "\n".join([
        f"- activities: {', '.join(activities[:12])}" if activities else "- activities: (none detected)",
        f"- external tools: {', '.join(tools[:8])}" if tools else "- external tools: (none)",
        f"- uses LLM: {'yes' if uses_llm else 'no'}",
        f"- vault reads: {', '.join(vault_reads[:8])}" if vault_reads else "",
        f"- vault writes: {', '.join(vault_writes[:8])}" if vault_writes else "",
    ])

    return (
        "You are writing principal-facing labels for one of Alfred's chores "
        "(scheduled recurring work).\n\n"
        f"Chore name: {name}\n"
        f"Existing description: {description}\n"
        f"Schedule: {schedule} (UTC cron)\n"
        f"Template: {template}\n"
        f"Capabilities detected from source:\n{capabilities_block}\n\n"
        "Produce:\n"
        "  • display_name: short, principal-facing title. ≤ 50 chars. "
        "Sentence case. No trailing period. Examples: \"Daily morning briefing\", "
        "\"Watch subscriptions\", \"Weekly cash-flow forecast\".\n"
        "  • display_body: 60-160 words of MARKDOWN explaining what + why. "
        "Address the principal as \"you\" / \"your\". Use **bold** for the "
        "action verb. End with one sentence on what would go wrong without "
        "this chore. Butler-speak, careful, specific to this chore's actual "
        "capabilities (mention the tools and data sources where they matter).\n"
        "  • category: one of briefing | digest | watch | context-build | "
        "prefetch | maintenance. Pick the dominant intent.\n\n"
        "Respond with ONLY a JSON object of shape "
        '{"display_name":"...","display_body":"...","category":"..."}. '
        "No prose around it."
    )


def _parse_response(raw: Any) -> tuple[str, str, str]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return "", "", ""
    if not isinstance(raw, dict):
        return "", "", ""
    name = str(raw.get("display_name") or "").strip().strip('"').strip("'")
    body = str(raw.get("display_body") or "").strip()
    category = str(raw.get("category") or "").strip().lower()
    if len(name) > 50:
        cut = name[:50].rsplit(" ", 1)[0]
        name = (cut or name[:50]).rstrip(",;-")
    if category not in _VALID_CATEGORIES:
        category = ""  # let the page fall back to no chip
    return name, body, category


@dataclass
class Stats:
    chores: int = 0
    already_done: int = 0
    written: int = 0
    failures: int = 0
    no_source: int = 0
    errors: list[str] = field(default_factory=list)


async def _run(args: argparse.Namespace) -> Stats:
    stats = Stats()
    async with httpx.AsyncClient(
        base_url=_ctrl_url(), timeout=120.0, headers=_auth(),
    ) as client:
        r = await client.get("/api/v1/chores")
        r.raise_for_status()
        chores = r.json().get("chores", []) or []
        stats.chores = len(chores)
        logger.info("found %d chores", len(chores))

        for idx, ch in enumerate(chores):
            slug = ch.get("slug")
            if not slug:
                continue

            # Fetch the full record so we have user_facing_description etc.
            try:
                dr = await client.get(f"/api/v1/chores/{quote(slug, safe='')}")
                dr.raise_for_status()
            except httpx.HTTPError as exc:
                stats.failures += 1
                stats.errors.append(f"fetch {slug}: {exc}"[:300])
                continue
            data = dr.json()
            fm = data.get("frontmatter") or {}

            has_name = bool(str(fm.get("display_name") or "").strip())
            has_body = bool(str(fm.get("display_body") or "").strip())
            has_caps = bool(fm.get("activities_used"))
            if has_name and has_body and has_caps and not args.force:
                stats.already_done += 1
                continue

            # Locate + analyze the source
            source_path = _locate_source(fm)
            if source_path is None:
                stats.no_source += 1
                stats.errors.append(
                    f"no source for {slug} (template={fm.get('template')})",
                )
                logger.warning(
                    "[%d/%d] %s — source not found (template=%s); skipping",
                    idx + 1, len(chores), slug, fm.get("template"),
                )
                continue

            try:
                manifest = analyze_chore_source(
                    source_path.read_text(encoding="utf-8"),
                ).as_dict()
            except SyntaxError as exc:
                stats.failures += 1
                stats.errors.append(f"analyze {slug}: {exc}"[:300])
                logger.warning("analyze failed for %s: %s", slug, exc)
                continue

            logger.info(
                "[%d/%d] %s  src=%s  activities=%d tools=%d uses_llm=%s",
                idx + 1, len(chores), slug,
                source_path.name,
                len(manifest["activities_used"]),
                len(manifest["tools_used"]),
                manifest["uses_llm"],
            )

            # LLM pass for prose fields (skipped if we already have
            # them and only the capabilities are missing).
            if has_name and has_body and not args.force:
                display_name = str(fm.get("display_name"))
                display_body = str(fm.get("display_body"))
                category = str(fm.get("category") or "")
            else:
                prompt = _build_prompt(fm, manifest)
                try:
                    raw = await _call_clerk(prompt)
                except Exception as exc:  # noqa: BLE001
                    stats.failures += 1
                    stats.errors.append(f"clerk {slug}: {str(exc)[:200]}")
                    logger.warning("clerk failed for %s: %s", slug, exc)
                    if args.sleep > 0:
                        await asyncio.sleep(args.sleep)
                    continue
                display_name, display_body, category = _parse_response(raw)
                if not display_name or not display_body:
                    stats.failures += 1
                    stats.errors.append(
                        f"parse {slug}: name={display_name!r} body_len={len(display_body)}",
                    )
                    logger.warning(
                        "parse failure for %s: name=%r body_len=%d",
                        slug, display_name, len(display_body),
                    )
                    if args.sleep > 0:
                        await asyncio.sleep(args.sleep)
                    continue
                logger.info("  → name: %s  category: %s", display_name, category or "(none)")

            patch: dict[str, Any] = {
                "display_name": display_name,
                "display_body": display_body,
                "activities_used": manifest["activities_used"],
                "tools_used": manifest["tools_used"],
                "uses_llm": manifest["uses_llm"],
                "vault_reads": manifest["vault_reads"],
                "vault_writes": manifest["vault_writes"],
            }
            if category:
                patch["category"] = category
            if manifest.get("llm_agent_id"):
                patch["llm_agent_id"] = manifest["llm_agent_id"]

            if args.dry_run:
                if args.sleep > 0:
                    await asyncio.sleep(args.sleep)
                continue

            try:
                pr = await client.patch(
                    f"/api/v1/vault/records/{quote('chore/' + slug + '.md', safe='')}",
                    json={"json_set": patch},
                )
                pr.raise_for_status()
                stats.written += 1
            except httpx.HTTPError as exc:
                stats.failures += 1
                stats.errors.append(f"patch {slug}: {str(exc)[:200]}")
                logger.warning("patch failed for %s: %s", slug, exc)

            if args.sleep > 0:
                await asyncio.sleep(args.sleep)

    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--force", action="store_true",
        help="Re-derive metadata even when display_name + display_body already present.",
    )
    parser.add_argument(
        "--sleep", type=float, default=1.0,
        help="Seconds between clerk calls (default 1.0).",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    stats = asyncio.run(_run(args))
    print(f"chores:        {stats.chores}")
    print(f"already_done:  {stats.already_done}")
    print(f"written:       {stats.written}")
    print(f"no_source:     {stats.no_source}")
    print(f"failures:      {stats.failures}")
    if stats.errors:
        print("first errors:")
        for m in stats.errors[:5]:
            print(f"  - {m}")
    return 1 if stats.failures and not args.dry_run else 0


if __name__ == "__main__":
    sys.exit(main())
