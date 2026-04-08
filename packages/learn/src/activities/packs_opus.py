"""Opus-authored versions of the four onboarding packs (B.1, B.2, B.3).

The rule-based matter/instinct/errand pack generators in ``packs.py`` are
keyword matching over sender tiers and domain counts — they produce thin
records that don't reflect who the user actually is. This module provides
Opus-driven alternatives that read facts + patterns + profile + brief and
write rich, user-specific records.

Design:
- Each ``generate_*_pack_opus`` activity calls Opus via ``_call_llm``
  (same helper as ``extract_facts_opus`` and ``discover_patterns_opus``).
- On any failure (LLM error, parse error, empty response, env flag off)
  the activity falls back to the rule-based version from ``packs.py``.
  Callers never have to know which path produced the records.
- All vault writes go through ``VaultClient`` (the ctrl-api wrapper),
  never direct filesystem writes.
- The markdown bodies have real sections, not just frontmatter. Users
  opening a matter record in the dashboard should see the story of
  that matter, not a domain name and a senders list.

Env flags:
- ``ALFRED_OPUS_PACKS_ENABLED`` — default ``"true"``. Set to ``"false"``
  to force the rule-based fallback for every pack (useful if OpenRouter
  is flaky or budget-constrained).
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

from temporalio import activity

from src.activities.onboarding_v3 import _call_llm, _parse_json_with_key
from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _opus_packs_enabled() -> bool:
    """Return True unless ALFRED_OPUS_PACKS_ENABLED=false is in the env."""
    return os.environ.get("ALFRED_OPUS_PACKS_ENABLED", "true").lower() != "false"


def _read_onboard_json(onboard_path: str) -> dict[str, Any]:
    """Load the whole onboard.json file, tolerate missing/broken."""
    try:
        with open(onboard_path, "r") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError) as exc:
        logger.warning("packs_opus: failed to read %s: %s", onboard_path, exc)
        return {}


def _slugify(name: str) -> str:
    """Lowercase, replace spaces/underscores with hyphens, strip non-alphanum."""
    import re
    s = name.lower()
    s = re.sub(r"[_\s]+", "-", s)
    s = re.sub(r"[^a-z0-9-]", "", s)
    s = re.sub(r"-+", "-", s)
    return s.strip("-")


def _escape_yaml_scalar(value: str) -> str:
    """Return a single-quoted YAML scalar with embedded quotes escaped.

    Used for string frontmatter values that may contain special characters
    (colons, quotes, newlines). The vault.ts parser on the ctrl-api side
    can handle both bare scalars and single-quoted scalars, so we always
    emit single-quoted for safety.
    """
    return "'" + str(value).replace("'", "''") + "'"


def _format_yaml_list(items: list[Any]) -> str:
    """Render a list of strings as a flow-style YAML list ``[a, b, c]``.

    Each element is rendered as a bare scalar if it looks safe, else
    single-quoted. Matches the flat-parser expectations in ``vault.ts``.
    """
    out: list[str] = []
    for item in items:
        s = str(item)
        if any(c in s for c in "{}[]:,#&*!|>'\"@`") or s != s.strip() or not s:
            out.append("'" + s.replace("'", "''") + "'")
        else:
            out.append(s)
    return "[" + ", ".join(out) + "]"


def _trim(text: str, max_chars: int) -> str:
    """Truncate text with an ellipsis marker if it exceeds max_chars."""
    if not isinstance(text, str):
        return ""
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."


# ---------------------------------------------------------------------------
# Matter pack (Opus-driven)
# ---------------------------------------------------------------------------

# Allowed values for matter frontmatter fields — enforced on write to
# avoid writing records the ctrl-api vault schema validator will reject.
_VALID_MATTER_STATUSES = {"active", "resolved", "abandoned"}
_VALID_MATTER_CATEGORIES = {
    "work", "personal", "financial", "health", "relationship",
    "logistics", "creative", "learning", "admin",
}


def _build_matter_prompt(
    facts: list[dict[str, Any]],
    patterns: list[Any],
    key_identity_facts: list[dict[str, Any]],
    profile_summary: dict[str, Any],
    brief_excerpt: str,
) -> str:
    """Construct the Opus prompt for matter-pack generation.

    The prompt is intentionally explicit about what a "matter" is and is
    not — Opus sometimes pattern-matches on the word "matter" and drifts
    toward legal case terminology without guidance.
    """
    # Compact fact summary grouped by category
    from collections import defaultdict
    by_cat: dict[str, list[str]] = defaultdict(list)
    for f in facts:
        if isinstance(f, dict):
            cat = f.get("category", "general")
            fact_text = f.get("fact", "")
            if fact_text:
                by_cat[cat].append(fact_text)

    fact_block_parts: list[str] = []
    for cat, items in sorted(by_cat.items()):
        fact_block_parts.append(f"### {cat.title()} ({len(items)})")
        for item in items[:20]:
            fact_block_parts.append(f"- {item}")
    fact_block = "\n".join(fact_block_parts) if fact_block_parts else "(no facts yet)"

    # Patterns
    pattern_lines: list[str] = []
    for p in patterns[:30]:
        if isinstance(p, dict):
            name = p.get("name") or p.get("title") or "unnamed"
            desc = p.get("description", "")
            pattern_lines.append(f"- **{name}**: {desc}")
        elif isinstance(p, str):
            pattern_lines.append(f"- {p}")
    pattern_block = "\n".join(pattern_lines) if pattern_lines else "(no patterns yet)"

    # Key identity facts
    identity_lines: list[str] = []
    for kif in key_identity_facts[:15]:
        if isinstance(kif, dict):
            display = kif.get("display") or kif.get("field", "")
            value = kif.get("value", "")
            if display and value:
                identity_lines.append(f"- {display}: {value}")
    identity_block = "\n".join(identity_lines) if identity_lines else "(no key identity facts)"

    # Profile summary is short — include verbatim
    profile_block = ""
    if isinstance(profile_summary, dict):
        summary = profile_summary.get("summary", {}) if profile_summary else {}
        if isinstance(summary, dict):
            for k in ("inner_circle", "communication_style", "work_hours",
                      "top_subscriptions", "key_patterns"):
                v = summary.get(k)
                if v:
                    if isinstance(v, list):
                        v = ", ".join(str(x) for x in v[:8])
                    profile_block += f"- {k}: {v}\n"
    if not profile_block:
        profile_block = "(no profile summary)"

    brief_section = _trim(brief_excerpt, 1500) if brief_excerpt else "(no brief yet)"

    return f"""You are Alfred, a personal AI butler. You are deciding what "matters" to track on behalf of your new master — ongoing areas of focus that deserve their own vault record so you can keep watching them over time.

## What a matter IS

A matter is an ongoing area of responsibility, concern, or opportunity that has a continuing life beyond any single email or task. Examples:

- A professional relationship with a client ("Acme Corp collaboration")
- A personal project ("Writing the novel")
- A household decision ("Deciding whether to buy the house in Brighton")
- A health context ("Ongoing physio for knee injury")
- A financial arrangement ("Monthly cash flow with partner Eszter")
- A logistics responsibility ("Hanna's nursery and pickup routine")
- A creative direction ("Alfred Black product vision")

## What a matter is NOT

- A domain name (stripe.com is a service, not a matter)
- A single email or thread
- A single task or todo
- A person (that's a person record)
- An organization (that's an org record)
- A label or tag

## Your inputs

### Key identity facts
{identity_block}

### Profile summary
{profile_block}

### Facts ({sum(len(v) for v in by_cat.values())} total, grouped by category)
{fact_block}

### Patterns discovered by behavioral analysis
{pattern_block}

### First brief excerpt (Alfred's welcome letter to the user)
{brief_section}

## Your task

Decide 5-10 matters that are the most important things for Alfred to track on behalf of this user. Lean towards the ones that are clearly visible in the facts and patterns — do not invent matters that aren't supported by evidence. Skip anything that already fits better as a single person, org, or task record.

For EACH matter, write:

- **name**: short human title (max 70 chars). This is how it'll appear in the Matters tab.
- **category**: one of `work`, `personal`, `financial`, `health`, `relationship`, `logistics`, `creative`, `learning`, `admin`
- **status**: `active` (the default) or `resolved` (if clearly past) — never `abandoned`
- **description**: one-sentence summary of what this matter is about.
- **context**: 3-5 paragraphs of real backstory. Who is involved? What is the history? What is Alfred expected to watch for? Why does this matter to the user? Write this as if briefing a new personal assistant who is about to take over this area. Tie it to specific facts where possible.
- **key_people**: list of names mentioned in facts (max 8). Use the real names, not labels like "co-founder".
- **related_patterns**: list of pattern names from the patterns block above that relate to this matter (max 5). Use the exact name strings from the block.
- **open_questions**: 3-5 specific questions Alfred should be thinking about or asking the user. Not generic — specific to this matter and this user.
- **suggested_next_actions**: 2-4 concrete next actions Alfred could take or propose. Actionable, specific, grounded in the facts.

## Output format

Return ONLY valid JSON matching this exact shape. No preamble, no markdown fences, no trailing text:

```json
{{
  "matters": [
    {{
      "name": "...",
      "category": "work",
      "status": "active",
      "description": "...",
      "context": "...",
      "key_people": ["..."],
      "related_patterns": ["..."],
      "open_questions": ["...", "...", "..."],
      "suggested_next_actions": ["...", "..."]
    }}
  ]
}}
```

Be honest about gaps — if you can't write 5 good matters from the evidence, write fewer. Empty `key_people` or `related_patterns` lists are fine if the evidence doesn't support them. But `context` and `open_questions` must always be filled in substantively (no placeholder text like "TBD" or "Unknown").
"""


def _validate_matter(matter: dict[str, Any]) -> tuple[bool, str]:
    """Return (ok, reason) for a single matter dict from the Opus response.

    Validates types, enum values, and minimum content length. Used to reject
    malformed entries before they reach vault.ts.
    """
    if not isinstance(matter, dict):
        return False, "not a dict"

    name = matter.get("name", "")
    if not isinstance(name, str) or not name.strip():
        return False, "missing or empty name"
    if len(name) > 120:
        return False, "name too long"

    category = str(matter.get("category", "")).strip().lower()
    if category and category not in _VALID_MATTER_CATEGORIES:
        return False, f"invalid category: {category}"

    status = str(matter.get("status", "active")).strip().lower()
    if status not in _VALID_MATTER_STATUSES:
        return False, f"invalid status: {status}"

    description = matter.get("description", "")
    if not isinstance(description, str) or len(description.strip()) < 10:
        return False, "description too short"

    context = matter.get("context", "")
    if not isinstance(context, str) or len(context.strip()) < 60:
        return False, "context too short (needs at least a real paragraph)"

    for list_field in ("key_people", "related_patterns", "open_questions", "suggested_next_actions"):
        val = matter.get(list_field, [])
        if not isinstance(val, list):
            return False, f"{list_field} not a list"

    return True, ""


def _build_rich_matter_content(matter: dict[str, Any]) -> str:
    """Render a validated matter dict as a markdown record with rich body."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    name = str(matter["name"]).strip()
    category = str(matter.get("category", "")).strip().lower() or "personal"
    status = str(matter.get("status", "active")).strip().lower()
    description = str(matter["description"]).strip()
    context = str(matter["context"]).strip()

    key_people = [str(x).strip() for x in matter.get("key_people", []) if str(x).strip()]
    related_patterns = [str(x).strip() for x in matter.get("related_patterns", []) if str(x).strip()]
    open_questions = [str(x).strip() for x in matter.get("open_questions", []) if str(x).strip()]
    next_actions = [str(x).strip() for x in matter.get("suggested_next_actions", []) if str(x).strip()]

    # Frontmatter (flat only — no nested maps, vault.ts can't handle them)
    fm_lines = [
        "---",
        f"type: matter",
        f"name: {_escape_yaml_scalar(name)}",
        f"status: {status}",
        f"category: {category}",
        f"description: {_escape_yaml_scalar(description)}",
        f"created: {now}",
        f"created_by: onboarding_pipeline",
        f"generated: true",
        f"key_people: {_format_yaml_list(key_people)}",
        f"related_patterns: {_format_yaml_list(related_patterns)}",
        f"tags: [onboarding, matter, auto-generated, {category}]",
        "---",
    ]

    # Body sections
    body_parts: list[str] = [
        f"# {name}",
        "",
        f"> {description}",
        "",
        "## Context",
        "",
        context,
    ]

    if key_people:
        body_parts += ["", "## Key people", ""]
        body_parts += [f"- {p}" for p in key_people]

    if related_patterns:
        body_parts += ["", "## Related patterns", ""]
        body_parts += [f"- {p}" for p in related_patterns]

    if open_questions:
        body_parts += ["", "## Open questions", ""]
        body_parts += [f"- {q}" for q in open_questions]

    if next_actions:
        body_parts += ["", "## Suggested next actions", ""]
        body_parts += [f"- {a}" for a in next_actions]

    body_parts += [
        "",
        "---",
        "",
        f"*Auto-generated by Alfred during onboarding on {now}. "
        f"Feel free to edit this matter — Alfred will respect your changes on next reflection.*",
        "",
    ]

    return "\n".join(fm_lines) + "\n\n" + "\n".join(body_parts)


@activity.defn
async def generate_matter_pack_opus(onboard_path: str) -> dict[str, Any]:
    """Opus-driven matter pack generator.

    Reads facts + patterns + profile + brief from onboard.json, asks Opus
    to identify 5-10 matters worth tracking for this specific user, writes
    rich markdown matter records to the vault.

    Falls back to the rule-based ``generate_matter_pack`` when:
    - ``ALFRED_OPUS_PACKS_ENABLED`` is "false"
    - There are no facts or patterns in onboard.json
    - The LLM call raises an exception
    - The JSON response can't be parsed
    - Every matter in the response fails validation

    Returns a dict with ``created`` count and ``source`` ("opus" or
    "rule_based") for observability.
    """
    if not _opus_packs_enabled():
        logger.info("matter_pack_opus: disabled by env flag, using rule-based")
        from src.activities.packs import generate_matter_pack
        rb = await generate_matter_pack(onboard_path)
        return {**rb, "source": "rule_based_env_flag"}

    activity.heartbeat("matter_pack_opus: reading onboard.json")
    onboard = _read_onboard_json(onboard_path)
    facts = onboard.get("facts") or []
    patterns = onboard.get("patterns") or []
    key_identity_facts = onboard.get("key_identity_facts") or []
    profile = onboard.get("profile") or {}
    brief = onboard.get("brief") or onboard.get("brief_letter") or ""

    if not facts and not patterns:
        logger.info(
            "matter_pack_opus: no facts/patterns in onboard.json, falling back"
        )
        from src.activities.packs import generate_matter_pack
        rb = await generate_matter_pack(onboard_path)
        return {**rb, "source": "rule_based_no_context"}

    prompt = _build_matter_prompt(facts, patterns, key_identity_facts, profile, brief)

    activity.heartbeat(
        f"matter_pack_opus: calling Opus ({len(facts)} facts, {len(patterns)} patterns)"
    )
    try:
        raw = await _call_llm(
            prompt,
            max_tokens=8192,
            heartbeat_message="matter_pack_opus: waiting on Opus",
        )
    except Exception as exc:
        logger.error("matter_pack_opus: LLM call failed: %s — falling back", exc)
        from src.activities.packs import generate_matter_pack
        rb = await generate_matter_pack(onboard_path)
        return {**rb, "source": "rule_based_llm_error", "llm_error": str(exc)}

    # Parse the JSON envelope
    parsed = _parse_json_with_key(raw, "matters") or {}
    matters = parsed.get("matters") if isinstance(parsed, dict) else None
    if not isinstance(matters, list) or not matters:
        logger.error(
            "matter_pack_opus: failed to parse 'matters' from LLM response (len=%d), falling back",
            len(raw) if isinstance(raw, str) else 0,
        )
        from src.activities.packs import generate_matter_pack
        rb = await generate_matter_pack(onboard_path)
        return {**rb, "source": "rule_based_parse_error"}

    # Validate + write
    config = load_config()
    client = VaultClient(config)
    created = 0
    skipped_existing = 0
    skipped_invalid = 0
    rejected_reasons: list[str] = []
    try:
        for matter in matters[:10]:
            ok, reason = _validate_matter(matter)
            if not ok:
                skipped_invalid += 1
                rejected_reasons.append(reason)
                logger.warning("matter_pack_opus: rejecting matter: %s", reason)
                continue

            slug = _slugify(matter["name"])
            if not slug:
                skipped_invalid += 1
                rejected_reasons.append("empty slug")
                continue

            try:
                existing = await client.search_records(slug, record_type="matter")
                if existing:
                    skipped_existing += 1
                    continue
            except Exception as exc:
                logger.warning(
                    "matter_pack_opus: search failed for %s: %s (proceeding anyway)",
                    slug, exc,
                )

            content = _build_rich_matter_content(matter)
            try:
                await client.write_record("matter", slug, content)
                created += 1
                activity.heartbeat(f"matter_pack_opus: wrote matter/{slug}.md")
            except Exception as exc:
                logger.error("matter_pack_opus: write failed for %s: %s", slug, exc)
                skipped_invalid += 1
                rejected_reasons.append(f"write failed: {exc}")

        logger.info(
            "matter_pack_opus: created %d, skipped_existing %d, invalid %d",
            created, skipped_existing, skipped_invalid,
        )

        # If Opus produced nothing valid, fall back so the user at least has records
        if created == 0:
            logger.warning(
                "matter_pack_opus: no valid matters created, falling back to rule-based"
            )
            from src.activities.packs import generate_matter_pack
            rb = await generate_matter_pack(onboard_path)
            return {
                **rb,
                "source": "rule_based_no_valid_matters",
                "opus_rejected": rejected_reasons[:5],
            }

        return {
            "created": created,
            "skipped_existing": skipped_existing,
            "skipped_invalid": skipped_invalid,
            "source": "opus",
            "rejected_reasons": rejected_reasons[:5] if rejected_reasons else [],
        }
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Errand pack (Opus-driven, Plan B.2)
# ---------------------------------------------------------------------------

# task statuses per vault.ts STATUS_BY_TYPE
_VALID_ERRAND_STATUSES = {"todo", "active", "blocked", "done", "cancelled"}
_VALID_ERRAND_URGENCIES = {"low", "normal", "high", "urgent"}


def _build_errand_prompt(
    facts: list[dict[str, Any]],
    patterns: list[Any],
    key_identity_facts: list[dict[str, Any]],
    profile_summary: dict[str, Any],
    brief_excerpt: str,
    matters_brief: list[dict[str, Any]],
) -> str:
    """Construct the Opus prompt for errand-pack generation.

    Errands are discrete actionable items with a clear owner, in contrast
    to matters (ongoing areas) and chores (recurring automations). The
    prompt is explicit about this distinction so Opus doesn't drift.
    """
    from collections import defaultdict

    # Compact fact summary
    by_cat: dict[str, list[str]] = defaultdict(list)
    for f in facts:
        if isinstance(f, dict):
            cat = f.get("category", "general")
            fact_text = f.get("fact", "")
            if fact_text:
                by_cat[cat].append(fact_text)

    fact_block_parts: list[str] = []
    for cat, items in sorted(by_cat.items()):
        fact_block_parts.append(f"### {cat.title()} ({len(items)})")
        for item in items[:18]:
            fact_block_parts.append(f"- {item}")
    fact_block = "\n".join(fact_block_parts) if fact_block_parts else "(no facts yet)"

    # Patterns
    pattern_lines: list[str] = []
    for p in patterns[:25]:
        if isinstance(p, dict):
            name = p.get("name") or p.get("title") or "unnamed"
            desc = p.get("description", "")
            pattern_lines.append(f"- **{name}**: {desc}")
        elif isinstance(p, str):
            pattern_lines.append(f"- {p}")
    pattern_block = "\n".join(pattern_lines) if pattern_lines else "(no patterns yet)"

    # Identity
    identity_lines: list[str] = []
    for kif in key_identity_facts[:12]:
        if isinstance(kif, dict):
            display = kif.get("display") or kif.get("field", "")
            value = kif.get("value", "")
            if display and value:
                identity_lines.append(f"- {display}: {value}")
    identity_block = "\n".join(identity_lines) if identity_lines else "(no key identity facts)"

    # Profile summary
    profile_block = ""
    if isinstance(profile_summary, dict):
        summary = profile_summary.get("summary", {}) if profile_summary else {}
        if isinstance(summary, dict):
            for k in ("inner_circle", "communication_style", "work_hours",
                      "top_subscriptions", "key_patterns"):
                v = summary.get(k)
                if v:
                    if isinstance(v, list):
                        v = ", ".join(str(x) for x in v[:8])
                    profile_block += f"- {k}: {v}\n"
    if not profile_block:
        profile_block = "(no profile summary)"

    # Matters context — short list of names so errands can reference them
    matter_names: list[str] = []
    for m in matters_brief[:15]:
        if isinstance(m, dict):
            n = m.get("name") or m.get("title") or ""
            if n:
                matter_names.append(str(n))
    matters_block = "\n".join(f"- {n}" for n in matter_names) if matter_names else "(no matters yet)"

    brief_section = _trim(brief_excerpt, 1500) if brief_excerpt else "(no brief yet)"

    return f"""You are Alfred, a personal AI butler. You are deciding what errands the user has on their plate that need explicit tracking — discrete actionable items, each with a clear owner and a definite end-state.

## What an errand IS

An errand is a single concrete thing that needs doing. It has an end-state (it can be marked done) and one clear owner (Alfred or the human). Examples:

- "Reply to Stan's contract revision" (owner: human, due: this week)
- "Cancel the second Polar.sh subscription" (owner: human, urgency: normal)
- "Book Hanna's 9-month checkup with Dr. Kovács" (owner: human, due: next month)
- "Draft the BuildTrack proposal response" (owner: human, due: by Friday)
- "Confirm the Stylers H2 invoice with Eszter" (owner: human, urgency: normal)
- "Send weekly investor update" (owner: human, recurring → flag as recurring)

## What an errand is NOT

- A matter (ongoing area of focus — separate record type)
- A chore (recurring automation — separate record type)
- A pattern or instinct (Alfred's own behavior — separate record type)
- A vague aspiration ("get healthier")
- A todo without enough context to actually start ("do the thing")

## Your inputs

### Key identity facts
{identity_block}

### Profile summary
{profile_block}

### Existing matters (don't duplicate as errands — link to them via the related_matter field)
{matters_block}

### Facts ({sum(len(v) for v in by_cat.values())} total, grouped by category)
{fact_block}

### Patterns discovered by behavioral analysis
{pattern_block}

### First brief excerpt
{brief_section}

## Your task

Identify 5-15 errands the user clearly has on their plate based on the evidence. Skip anything that isn't actually evident from the facts. For EACH errand:

- **name**: short imperative title (max 80 chars). E.g. "Reply to Stan's contract revision"
- **status**: `todo` (default for new errands), `active` (in progress), `blocked` (waiting on someone)
- **owner**: `human` or `alfred` — who's the doer
- **urgency**: `low`, `normal`, `high`, or `urgent`
- **due_hint**: free-text deadline hint, e.g. "by Friday", "this week", "before nursery payment", or empty string if none
- **related_matter**: name of an existing matter from the list above that this errand belongs to, or empty string
- **context**: 1-2 short paragraphs — what's the situation, what's already happened, what specifically needs to happen next
- **why_it_matters**: 1 sentence — why is this on the list, what's the consequence of not doing it
- **dependencies**: list of other things that must happen first (max 3, free-text)
- **first_action**: 1 sentence — the very first concrete step (the easiest possible "starting move")

## Output format

Return ONLY valid JSON. No preamble, no markdown fences, no trailing text:

```json
{{
  "errands": [
    {{
      "name": "...",
      "status": "todo",
      "owner": "human",
      "urgency": "normal",
      "due_hint": "...",
      "related_matter": "...",
      "context": "...",
      "why_it_matters": "...",
      "dependencies": ["...", "..."],
      "first_action": "..."
    }}
  ]
}}
```

Be honest about gaps — if you can only see 3 real errands, write 3. Don't invent. Empty `dependencies` and `related_matter` are fine. But `context`, `why_it_matters`, and `first_action` must always be substantive.
"""


def _validate_errand(errand: dict[str, Any]) -> tuple[bool, str]:
    """Return (ok, reason) for a single errand dict from the Opus response."""
    if not isinstance(errand, dict):
        return False, "not a dict"

    name = errand.get("name", "")
    if not isinstance(name, str) or not name.strip():
        return False, "missing or empty name"
    if len(name) > 140:
        return False, "name too long"

    status = str(errand.get("status", "todo")).strip().lower()
    if status not in _VALID_ERRAND_STATUSES:
        return False, f"invalid status: {status}"

    owner = str(errand.get("owner", "human")).strip().lower()
    if owner not in {"human", "alfred"}:
        return False, f"invalid owner: {owner}"

    urgency = str(errand.get("urgency", "normal")).strip().lower()
    if urgency not in _VALID_ERRAND_URGENCIES:
        return False, f"invalid urgency: {urgency}"

    context = errand.get("context", "")
    if not isinstance(context, str) or len(context.strip()) < 30:
        return False, "context too short"

    why = errand.get("why_it_matters", "")
    if not isinstance(why, str) or len(why.strip()) < 10:
        return False, "why_it_matters too short"

    first_action = errand.get("first_action", "")
    if not isinstance(first_action, str) or len(first_action.strip()) < 10:
        return False, "first_action too short"

    deps = errand.get("dependencies", [])
    if not isinstance(deps, list):
        return False, "dependencies not a list"

    return True, ""


def _build_rich_errand_content(errand: dict[str, Any]) -> str:
    """Render a validated errand dict as a markdown task record."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    name = str(errand["name"]).strip()
    status = str(errand.get("status", "todo")).strip().lower()
    owner = str(errand.get("owner", "human")).strip().lower()
    urgency = str(errand.get("urgency", "normal")).strip().lower()
    due_hint = str(errand.get("due_hint", "")).strip()
    related_matter = str(errand.get("related_matter", "")).strip()
    context = str(errand["context"]).strip()
    why = str(errand["why_it_matters"]).strip()
    first_action = str(errand["first_action"]).strip()
    deps = [str(d).strip() for d in errand.get("dependencies", []) if str(d).strip()]

    fm_lines = [
        "---",
        "type: task",
        f"name: {_escape_yaml_scalar(name)}",
        f"status: {status}",
        f"owner: {owner}",
        f"urgency: {urgency}",
        f"created: {now}",
        f"created_by: onboarding_pipeline",
        f"generated: true",
    ]
    if due_hint:
        fm_lines.append(f"due_hint: {_escape_yaml_scalar(due_hint)}")
    if related_matter:
        fm_lines.append(f"related_matter: {_escape_yaml_scalar(related_matter)}")
    fm_lines += [
        f"tags: [onboarding, errand, auto-generated, {urgency}]",
        "---",
    ]

    body_parts: list[str] = [
        f"# {name}",
        "",
        f"**Owner:** {owner.title()}  |  **Urgency:** {urgency}  |  **Status:** {status}",
    ]
    if due_hint:
        body_parts.append(f"**Due:** {due_hint}")
    if related_matter:
        body_parts.append(f"**Related matter:** {related_matter}")

    body_parts += [
        "",
        "## Context",
        "",
        context,
        "",
        "## Why it matters",
        "",
        why,
    ]

    if deps:
        body_parts += ["", "## Dependencies", ""]
        body_parts += [f"- {d}" for d in deps]

    body_parts += [
        "",
        "## First action",
        "",
        first_action,
        "",
        "---",
        "",
        f"*Auto-generated by Alfred during onboarding on {now}.*",
        "",
    ]

    return "\n".join(fm_lines) + "\n\n" + "\n".join(body_parts)


@activity.defn
async def generate_errand_pack_opus(onboard_path: str) -> dict[str, Any]:
    """Opus-driven errand pack generator (Plan B.2).

    Reads facts + patterns + profile + brief + existing matters from
    onboard.json and identifies 5-15 actionable items with clear owners.
    Writes `task` type vault records with substantive bodies.

    Falls back to ``generate_errand_pack`` on every expected failure mode.
    """
    if not _opus_packs_enabled():
        logger.info("errand_pack_opus: disabled by env flag, using rule-based")
        from src.activities.packs import generate_errand_pack
        rb = await generate_errand_pack(onboard_path)
        return {**rb, "source": "rule_based_env_flag"}

    activity.heartbeat("errand_pack_opus: reading onboard.json")
    onboard = _read_onboard_json(onboard_path)
    facts = onboard.get("facts") or []
    patterns = onboard.get("patterns") or []
    key_identity_facts = onboard.get("key_identity_facts") or []
    profile = onboard.get("profile") or {}
    brief = onboard.get("brief") or onboard.get("brief_letter") or ""
    matters_brief = onboard.get("matters_brief") or []  # set by matter pack if present

    if not facts and not patterns:
        logger.info(
            "errand_pack_opus: no facts/patterns in onboard.json, falling back"
        )
        from src.activities.packs import generate_errand_pack
        rb = await generate_errand_pack(onboard_path)
        return {**rb, "source": "rule_based_no_context"}

    prompt = _build_errand_prompt(
        facts, patterns, key_identity_facts, profile, brief, matters_brief
    )

    activity.heartbeat(
        f"errand_pack_opus: calling Opus ({len(facts)} facts, {len(patterns)} patterns)"
    )
    try:
        raw = await _call_llm(
            prompt,
            max_tokens=8192,
            heartbeat_message="errand_pack_opus: waiting on Opus",
        )
    except Exception as exc:
        logger.error("errand_pack_opus: LLM call failed: %s — falling back", exc)
        from src.activities.packs import generate_errand_pack
        rb = await generate_errand_pack(onboard_path)
        return {**rb, "source": "rule_based_llm_error", "llm_error": str(exc)}

    parsed = _parse_json_with_key(raw, "errands") or {}
    errands = parsed.get("errands") if isinstance(parsed, dict) else None
    if not isinstance(errands, list) or not errands:
        logger.error(
            "errand_pack_opus: failed to parse 'errands' (len=%d), falling back",
            len(raw) if isinstance(raw, str) else 0,
        )
        from src.activities.packs import generate_errand_pack
        rb = await generate_errand_pack(onboard_path)
        return {**rb, "source": "rule_based_parse_error"}

    config = load_config()
    client = VaultClient(config)
    created = 0
    skipped_existing = 0
    skipped_invalid = 0
    rejected_reasons: list[str] = []
    try:
        for errand in errands[:15]:
            ok, reason = _validate_errand(errand)
            if not ok:
                skipped_invalid += 1
                rejected_reasons.append(reason)
                logger.warning("errand_pack_opus: rejecting errand: %s", reason)
                continue

            slug = _slugify(errand["name"])
            if not slug:
                skipped_invalid += 1
                rejected_reasons.append("empty slug")
                continue

            try:
                existing = await client.search_records(slug, record_type="task")
                if existing:
                    skipped_existing += 1
                    continue
            except Exception as exc:
                logger.warning(
                    "errand_pack_opus: search failed for %s: %s (proceeding)",
                    slug, exc,
                )

            content = _build_rich_errand_content(errand)
            try:
                await client.write_record("task", slug, content)
                created += 1
                activity.heartbeat(f"errand_pack_opus: wrote task/{slug}.md")
            except Exception as exc:
                logger.error("errand_pack_opus: write failed for %s: %s", slug, exc)
                skipped_invalid += 1
                rejected_reasons.append(f"write failed: {exc}")

        logger.info(
            "errand_pack_opus: created %d, skipped_existing %d, invalid %d",
            created, skipped_existing, skipped_invalid,
        )

        if created == 0:
            logger.warning(
                "errand_pack_opus: no valid errands created, falling back"
            )
            from src.activities.packs import generate_errand_pack
            rb = await generate_errand_pack(onboard_path)
            return {
                **rb,
                "source": "rule_based_no_valid_errands",
                "opus_rejected": rejected_reasons[:5],
            }

        return {
            "created": created,
            "skipped_existing": skipped_existing,
            "skipped_invalid": skipped_invalid,
            "source": "opus",
            "rejected_reasons": rejected_reasons[:5] if rejected_reasons else [],
        }
    finally:
        await client.close()
