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

from src.activities.clerk import _call_clerk
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
- A financial arrangement ("Monthly cash flow with partner Sam Lee")
- A logistics responsibility ("Robin's nursery and pickup routine")
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


def _split_person_name(raw: str) -> tuple[str, str]:
    """Split a key_person string into (bare_name, annotation).

    Opus sometimes emits names with a trailing role annotation despite the
    prompt asking for bare names — e.g. ``"Pat (advisor)"`` or
    ``"Sam Lee — partner"``. The wikilink target must be the BARE name so
    it resolves against the curator-authored ``person/<Name>.md`` records;
    the annotation is kept as trailing display text on the body bullet.

    Returns ``("Pat", "(advisor)")`` / ``("Sam Lee", "— partner")`` /
    ``("Rami Khouri", "")``.
    """
    import re as _re
    s = (raw or "").strip()
    # Trailing parenthetical: "Name (role)".
    m = _re.match(r"^(.*?)\s*(\([^)]*\))\s*$", s)
    if m and m.group(1).strip():
        return m.group(1).strip(), m.group(2).strip()
    # Trailing em/en-dash or comma annotation: "Name — role" / "Name, role".
    m = _re.match(r"^(.*?)\s*([—–,-]\s*.+)$", s)
    if m and m.group(1).strip():
        return m.group(1).strip(), m.group(2).strip()
    return s, ""


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
    # Opus may emit an org list (key_orgs/related_orgs) on some matters; the
    # base matter schema doesn't require it, so treat it as optional.
    key_orgs = [
        str(x).strip()
        for x in (matter.get("key_orgs") or matter.get("related_orgs") or [])
        if str(x).strip()
    ]

    # F37 — wikilink targets for the file-walk graph. The bare name (role
    # annotation stripped) is the link target so it resolves against the
    # curator-authored person/org records; ctrl's graph LINK_FIELDS read
    # ``related_persons`` / ``related_orgs`` (F10) to materialise the
    # matter↔entity edges. Deterministic; no LLM.
    person_links = [f"[[person/{_split_person_name(p)[0]}]]" for p in key_people]
    org_links = [f"[[org/{_split_person_name(o)[0]}]]" for o in key_orgs]

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
        f"related_persons: {_format_yaml_list(person_links)}",
        f"related_orgs: {_format_yaml_list(org_links)}",
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
        for p in key_people:
            bare, annotation = _split_person_name(p)
            bullet = f"- [[person/{bare}]]"
            if annotation:
                bullet += f" {annotation}"
            body_parts.append(bullet)

    if key_orgs:
        body_parts += ["", "## Organizations", ""]
        for o in key_orgs:
            bare, annotation = _split_person_name(o)
            bullet = f"- [[org/{bare}]]"
            if annotation:
                bullet += f" {annotation}"
            body_parts.append(bullet)

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
                if await client.record_exists("matter", slug):
                    skipped_existing += 1
                    continue
            except Exception as exc:
                logger.warning(
                    "matter_pack_opus: existence check failed for %s: %s (proceeding anyway)",
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
# B9 — onboarding seeds an enriched, interlinked knowledge graph
# ---------------------------------------------------------------------------
# Matters used to be graph islands: people named in a matter were body text
# with no person/org record. F37 made the matter emit ``[[person/Name]]``
# wikilinks; F36 materialised bare stubs ("Alfred will enrich this later").
# B9 expands that single stage into two passes (the activity NAME is kept —
# ``materialize_matter_entities`` — for Temporal replay-safety + worker
# registration; only the body grows):
#
#   * Pass A (deterministic-first) — upgrade each matter-named entity from a
#     bare stub into a real CURATOR-SCHEMA record: a 2-3 sentence description
#     derived from the fact-substring + matter context, ``aliases``/``email``/
#     ``role``/``org`` frontmatter, and the curator's ``![[person.base#…]]``
#     body embeds so the two are interchangeable. Idempotent: an existing
#     (curator-authored) body is NEVER clobbered — only ``related`` is unioned.
#
#   * Pass B (LLM-gated) — one BATCHED plain-completion ``_call_llm`` call over
#     ``onboard["facts"]`` (NOT the agentic ``_call_clerk``, which would try to
#     write the records itself instead of returning JSON) that emits CANONICAL
#     ``person``/``org``/``place`` records (never ``project``/``location``/
#     ``observation`` — those 422 at ctrl) with descriptions + person→org ties,
#     for fact-corpus entities not already recorded. Gated behind
#     ``ONBOARDING_KG_SEED`` (default on) + an entity cap; degrades cleanly to a
#     no-op if the LLM/credits are out.
#
# Interlinking is deterministic in both passes: matter→person ``[[person/
# Name]]`` (pack already emits), person→matter backlink (UNION into
# ``related``), person→``[[org/Name]]``.


# Canonical entity types ctrl-api will accept (place, NOT location; never
# project/observation — see promotionContract.ts). Pass B filters to these.
_CANONICAL_ENTITY_TYPES = {"person", "org", "place"}

# Base-view embeds matching the curator schema (vault-curator/SKILL.md). A
# person/org record the curator would author carries these so the dashboard
# base views render and the curator treats a seeded record as one of its own
# on a later pass. ``place`` has no dedicated base — use the generic one the
# curator uses for location bodies.
_PERSON_BASE_EMBEDS = (
    "## Decisions\n![[person.base#Decisions]]\n"
    "## Tasks\n![[person.base#Tasks]]\n"
    "## Projects\n![[person.base#Projects]]\n"
    "## Sessions\n![[person.base#Sessions]]\n"
    "## Learnings\n![[person.base#Learnings]]\n"
    "## Accounts\n![[person.base#Accounts]]\n"
    "## Assets\n![[person.base#Assets]]\n"
    "## Notes\n![[person.base#Notes]]\n"
)
_ORG_BASE_EMBEDS = (
    "## People\n![[org.base#People]]\n"
    "## Projects\n![[org.base#Projects]]\n"
    "## Tasks\n![[org.base#Tasks]]\n"
    "## Accounts\n![[org.base#Accounts]]\n"
    "## Assets\n![[org.base#Assets]]\n"
    "## Notes\n![[org.base#Notes]]\n"
)
_PLACE_BASE_EMBEDS = "![[related.base#All]]\n"


def _base_embeds(record_type: str) -> str:
    if record_type == "person":
        return _PERSON_BASE_EMBEDS
    if record_type == "org":
        return _ORG_BASE_EMBEDS
    return _PLACE_BASE_EMBEDS


def _normalize_entity_name(name: str) -> str:
    """Normalise a free-text entity name to the curator's Title-Case form.

    The curator owns ``person/Title Case Name.md`` and ctrl resolves graph
    edges by exact ``stemToPath`` match, so the seeder must align casing
    before the existence check to avoid a duplicate
    (``person/rj-johnson.md`` vs ``person/RJ Johnson.md``). Tokens that are
    already mixed/all-caps (``RJ``, ``McKay``) are preserved; lowercase
    tokens get title-cased.
    """
    cleaned = " ".join((name or "").split())
    if not cleaned:
        return ""
    out: list[str] = []
    for tok in cleaned.split(" "):
        # Preserve a token that already carries an internal/leading capital
        # (acronyms like "RJ", camel like "McKay"); only title-case an all-
        # lowercase token.
        if tok and tok == tok.lower():
            out.append(tok[:1].upper() + tok[1:])
        else:
            out.append(tok)
    return " ".join(out)


def _parse_entity_wikilink(value: str) -> tuple[str, str] | None:
    """Parse ``[[person/Name]]`` / ``[[org/Name]]`` → ``(type, name)``;
    None for non-wikilinks or non-person/org targets."""
    import re
    s = (value or "").strip()
    m = re.match(r"^\[\[(person|org)/(.+?)\]\]$", s)
    if not m:
        return None
    name = m.group(2).strip()
    return (m.group(1), name) if name else None


def _facts_mentioning(facts: list[dict[str, Any]], name: str, limit: int = 6) -> list[str]:
    """Return fact strings that mention ``name`` (case-insensitive substring).

    Deterministic context-gathering for Pass A's description — the same idea
    as the retired ``write_facts_to_vault`` (onboarding.py), but it feeds an
    enriched curator-schema record instead of demoted per-fact observations.
    """
    needle = (name or "").strip().casefold()
    if not needle:
        return []
    hits: list[str] = []
    for f in facts:
        if not isinstance(f, dict):
            continue
        text = str(f.get("fact", "")).strip()
        if text and needle in text.casefold():
            hits.append(text)
            if len(hits) >= limit:
                break
    return hits


def _enriched_entity_content(
    record_type: str,
    name: str,
    *,
    description: str,
    related: list[str],
    org_link: str = "",
    role: str = "",
    email: str = "",
    aliases: list[str] | None = None,
    source_note: str = "",
) -> str:
    """Render a curator-schema person/org/place record with a real body.

    Matches vault-curator/SKILL.md so the seeded record is interchangeable
    with a curator-authored one: flat frontmatter (``aliases``, ``org``,
    ``role``, ``email``, ``related``), a ``# Name`` heading + description
    blockquote, then the base-view embeds. No demoted ``observation`` types.
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    desc = (description or "").strip() or f"{name} — discovered during onboarding."
    fm_lines = [
        "---",
        f"type: {record_type}",
        f"name: {_escape_yaml_scalar(name)}",
        "status: active",
        f"aliases: {_format_yaml_list(aliases or [])}",
        f"description: {_escape_yaml_scalar(desc)}",
    ]
    if record_type == "person":
        # org/role/email are person-schema fields (curator SKILL.md 130-146).
        if org_link:
            fm_lines.append(f"org: {_escape_yaml_scalar(org_link)}")
        if role:
            fm_lines.append(f"role: {_escape_yaml_scalar(role)}")
        if email:
            fm_lines.append(f"email: {_escape_yaml_scalar(email)}")
    fm_lines += [
        f"related: {_format_yaml_list(related)}",
        f"created: {now}",
        "created_by: onboarding_pipeline",
        "generated: true",
        "tags: [onboarding, auto-discovered]",
        "---",
    ]
    body = [f"# {name}", "", f"> {desc}", ""]
    if source_note:
        body += [source_note, ""]
    body.append(_base_embeds(record_type))
    return "\n".join(fm_lines) + "\n\n" + "\n".join(body)


def _union_related(existing: Any, additions: list[str]) -> list[str]:
    """Union an existing ``related`` value with new links, order-stable, deduped.

    ctrl-api's ``json_set`` REPLACES a frontmatter value (``fm[k] = v``,
    vault.ts) — it does NOT union lists. So the union must happen on this
    side: read the record's current ``related`` and merge before writing the
    full list back. (Risk #3 in debug/0522c/onboarding-kg-scope.md: the F36
    stage relied on a union ctrl never provided, silently clobbering existing
    backlinks.) Casefold dedup so ``[[matter/x]]`` isn't added twice.
    """
    out: list[str] = []
    seen: set[str] = set()
    src: list[Any] = []
    if isinstance(existing, list):
        src = existing
    elif isinstance(existing, str) and existing.strip():
        src = [existing]
    for v in [*src, *additions]:
        s = str(v).strip()
        if not s:
            continue
        key = s.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


# ---------------------------------------------------------------------------
# C-OB1 person filter — non-human / truncated names must NOT reach the vault.
# ---------------------------------------------------------------------------
# Live evidence (fixture onboarding_golden/, 2026-05-23):
# * ``person/Github Notifications.md`` — Pass B's LLM emitted a system
#   sender as a person.
# * ``person/David Szabo-St.md`` — Pass A copied a key_people string the
#   matter generator truncated mid-surname.
# * ``person/david@szabostuban.com.md`` — would have been written if the
#   facts list ever named an email as an entity.
# The two helpers below gate _create_or_merge_entity's person path.

import re as _re_person_filter

_PERSON_TLD_RE = _re_person_filter.compile(
    r"\.(com|io|net|org|ai|co|so)\b", _re_person_filter.IGNORECASE,
)
_PERSON_NOTIFICATIONS_RE = _re_person_filter.compile(
    r"\bnotifications?$", _re_person_filter.IGNORECASE,
)


def _is_capitalized_token(token: str) -> bool:
    """Token has a Unicode-uppercase first character.

    Uses ``str.isupper`` (Unicode-aware by design — ``"Ü".isupper()`` is
    ``True``, ``"ü".isupper()`` is ``False``) rather than an ASCII
    ``re.match(r"[A-Z]", …)`` test. The ASCII regex silently dropped
    real Hungarian names like ``Üveges Gábor`` / ``Ágnes Sirhuber`` /
    ``Éva Bíró`` from the materialise pipeline — live failure on the
    2026-05-23 onboarding, the sister bug to Lane I's ctrl-api gate fix
    (``b51697d``). Do NOT replace this helper with an ASCII ``[A-Z]``
    test or ``token.isascii() and …`` shortcut; the regression tests in
    ``test_person_filter_materialize`` will catch it, but the intent
    lives here.
    """
    return bool(token) and token[0].isupper()


def _is_plausible_human_name(name: str) -> bool:
    """C-OB1: every person record name must look like a real human.

    Rejects:
    * a Notifications? suffix (``Github Notifications``);
    * an email address (anything containing ``@``);
    * a TLD substring (``.com``/``.io``/``.net``/``.org``/``.ai``/``.co``/``.so``);
    * a name with fewer than 2 capitalised tokens (the truncation signal —
      ``Github`` alone, lowercase ``david``).

    A name is split on whitespace AND on hyphen so a hyphenated surname
    (``Szabo-Stuban``) yields multiple cap tokens. Capitalisation is
    tested with the Unicode-aware ``_is_capitalized_token`` helper so
    Hungarian names like ``Üveges Gábor`` / ``Éva Bíró`` pass the gate
    (the sister bug to Lane I's ctrl-api ASCII-only fix, ``b51697d``).
    """
    s = (name or "").strip()
    if not s:
        return False
    if "@" in s:
        return False
    if _PERSON_NOTIFICATIONS_RE.search(s):
        return False
    if _PERSON_TLD_RE.search(s):
        return False
    parts: list[str] = []
    for tok in s.split():
        parts.extend(t for t in tok.split("-") if t)
    # Unicode-aware capitalisation check — see ``_is_capitalized_token``
    # for the Hungarian-name rationale.
    cap_tokens = [t for t in parts if _is_capitalized_token(t)]
    if len(cap_tokens) < 2:
        return False
    return True


def _person_tokens(name: str) -> set[str]:
    """Tokenise a person name for overlap scoring — split on whitespace AND
    hyphen, lowercase, strip punctuation. Mirrors the test suite's
    ``_tokens`` so the threshold maths agree.
    """
    return {
        t.lower()
        for t in _re_person_filter.findall(
            r"[A-Za-zÀ-ÿ0-9]+", name or "",
        )
    }


def _dedupe_truncated_persons(
    existing_names: list[str], candidate: str,
) -> str | None:
    """If ``candidate`` is a token-prefix/subset of any existing name (or
    vice versa) with token-overlap ≥ 0.65, return the LONGER canonical
    name so the caller merges onto it instead of writing a duplicate.

    Returns ``None`` when no truncation match exists. Live case:
    ``David Szabo-St`` vs ``David Szabo-Stuban`` → ``{david, szabo, st}``
    vs ``{david, szabo, stuban}`` → overlap 2/3 = 0.667 ≥ 0.65, longer
    name wins.
    """
    cand_tokens = _person_tokens(candidate)
    if not cand_tokens:
        return None
    for existing in existing_names:
        ex_tokens = _person_tokens(existing)
        if not ex_tokens:
            continue
        inter = cand_tokens & ex_tokens
        if not inter:
            continue
        # min-cardinality overlap (the truncation-aware shape — a strict
        # subset gets 1.0, a one-token overlap on 3-tok names gets 0.33).
        overlap = len(inter) / min(len(cand_tokens), len(ex_tokens))
        if overlap < 0.65:
            continue
        # The longer name is the canonical surface form.
        if len(existing) >= len(candidate):
            return existing
        return candidate
    return None


# ---------------------------------------------------------------------------
# C-OB1 org filter — bare-domain org names must be grounded in the facts.
# ---------------------------------------------------------------------------
# Live evidence: the only org the 2026-05-23 onboarding materialised was
# ``org/github.com.md``. The matter pack emits ``[[org/github.com]]`` from
# the curator-discovered sender domain, and the materialise stage walked
# the wikilink without checking whether the name was a real company.
# This helper draws the line at "is this string in onboard.facts?".

_ORG_TLD_RE = _re_person_filter.compile(
    r"\.(com|io|net|org|ai|co|so|hu|uk|de|us|app|dev)\b",
    _re_person_filter.IGNORECASE,
)


# Gap 3 — deterministic facts → org extraction. Live 2026-05-23: Pass B
# (LLM) timed out at 180s, ``org: 0`` despite 1635 facts naming NeoTerra/
# Stylers/Wise/Mercury/Gránit Bank/Ugly Code LLC/Szabó-Stubán Kft. Regex
# pass extracts these without an LLM call so must-have orgs materialise
# even when Pass B degrades.
_ORG_SUFFIX_WORDS = (
    "Kft", "Bt", "Zrt", "Nyrt",  # Hungarian corporate forms
    "Ltd", "LLC", "Inc", "Corp", "Co", "GmbH", "AG", "SA", "PLC",
    "Group", "Bank", "Property", "Properties", "Holdings", "Holding",
    "Solutions", "Capital", "Ventures", "Studios", "Labs", "Partners",
    "Trust", "Foundation", "Business",
)
# 0-3 leading Title-Case tokens (Unicode-safe — [A-ZÀ-Ý] covers 'Á','Ü')
# + required company-shape suffix.
_ORG_NAME_RE = _re_person_filter.compile(
    r"(?:(?<![A-Za-z0-9])(?:[A-ZÀ-Ý][\w'’\-]{1,}\s+){0,3}"
    rf"(?:{'|'.join(_ORG_SUFFIX_WORDS)})\.?)", _re_person_filter.UNICODE,
)


def _extract_org_candidates_from_facts(
    facts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Walk ``facts`` → org candidates. Deduped (case-insensitive),
    gated through ``_org_name_is_plausible``. Items are
    ``{"name", "description", "source": "facts"}``."""
    if not facts:
        return []
    facts_corpus = "\n".join(
        str(f.get("fact", "")).strip()
        for f in facts if isinstance(f, dict)
    )
    seen: dict[str, dict[str, Any]] = {}
    for f in facts:
        if not isinstance(f, dict):
            continue
        text = str(f.get("fact", "")).strip()
        if not text:
            continue
        for raw in _ORG_NAME_RE.findall(text):
            name = " ".join((raw or "").split()).rstrip(".,;:")
            # Bare suffix without leading proper-name tokens isn't an org.
            if not name or name in _ORG_SUFFIX_WORDS:
                continue
            if not _org_name_is_plausible(name, facts_corpus):
                continue
            key = name.casefold()
            if key not in seen:
                seen[key] = {"name": name, "description": text,
                             "source": "facts"}
    return list(seen.values())


def _org_name_is_plausible(name: str, facts_corpus: str) -> bool:
    """C-OB1 org gate.

    * A name with a TLD substring (``github.com``, ``stripe.io``) is
      allowed ONLY if the same string appears verbatim (case-insensitive)
      in ``facts_corpus`` — proves the principal's facts use this string
      as the org's surface form.
    * A non-TLD proper name (``NeoTerra Property Group``, ``Acme Co``)
      is allowed unconditionally — proper-name pass-through.
    * An empty/whitespace name is rejected.
    """
    s = (name or "").strip()
    if not s:
        return False
    if _ORG_TLD_RE.search(s):
        # Domain-shaped: require literal grounding in the facts corpus.
        return s.casefold() in (facts_corpus or "").casefold()
    return True


async def _create_or_merge_entity(
    client: VaultClient,
    *,
    record_type: str,
    name: str,
    backlinks: list[str],
    description: str,
    org_link: str = "",
    role: str = "",
    email: str = "",
    aliases: list[str] | None = None,
    source_note: str = "",
    existing_fm: dict[str, dict[str, Any]] | None = None,
    facts_corpus: str = "",
) -> str:
    """Idempotent create-or-merge for one entity.

    - If a record already exists (exact path/slug, casefold-aware) → NEVER
      overwrite the body; only patch the missing links (``related`` UNIONED
      with the existing value client-side — see ``_union_related`` — plus
      ``org`` if the record doesn't already carry one). Returns ``"merged"``.
    - Else create an enriched curator-schema record. Returns ``"created"``.

    ``existing_fm`` is the cached ``{casefold_name: frontmatter}`` map for
    this type (avoids an O(N) ``record_exists`` listing per entity AND gives
    the current ``related`` for a real union).

    C-OB1 person filter: a candidate person whose name doesn't pass
    ``_is_plausible_human_name`` is dropped (``"skipped"``). A candidate
    that's a tokenwise prefix/truncation of an existing person collapses
    onto the canonical (longer) name via ``_dedupe_truncated_persons``.

    C-OB1 org filter: a domain-shaped org name must appear verbatim in
    ``facts_corpus`` or it is dropped (the live ``org/github.com`` junk).
    A proper-name org passes unconditionally.
    """
    norm = _normalize_entity_name(name)
    if not norm:
        return "skipped"

    # C-OB1: gate the person path. Orgs/places go through commits 3+'s
    # own filters; here we only intercept persons.
    if record_type == "person":
        if not _is_plausible_human_name(norm):
            logger.info(
                "materialize: dropping implausible person name %r "
                "(C-OB1: Notifications/@/TLD/single-cap)",
                norm,
            )
            return "skipped"
        if existing_fm:
            canonical = _dedupe_truncated_persons(
                [str(v.get("name") or "") for v in existing_fm.values()],
                norm,
            )
            if canonical and canonical != norm:
                logger.info(
                    "materialize: collapsing truncated person %r → %r",
                    norm, canonical,
                )
                norm = _normalize_entity_name(canonical)
                if not norm:
                    return "skipped"
    # C-OB1 org gate: reject a TLD-shaped name that isn't in the facts.
    if record_type == "org" and not _org_name_is_plausible(norm, facts_corpus):
        logger.info(
            "materialize: dropping domain-shaped org %r "
            "(C-OB1: not in facts_corpus)", norm,
        )
        return "skipped"
    cf = norm.casefold()
    cached = existing_fm if existing_fm is not None else None
    if cached is not None:
        exists = cf in cached
        current_fm = cached.get(cf) or {}
    else:
        exists = await client.record_exists(record_type, norm)
        current_fm = {}
    if exists:
        updates: dict[str, Any] = {}
        if backlinks:
            # UNION with the record's current related — never replace.
            merged = _union_related(current_fm.get("related"), backlinks)
            if merged:
                updates["related"] = merged
        # Only fill an org tie the record is missing — don't overwrite a
        # curator-authored org.
        if record_type == "person" and org_link and not str(
            current_fm.get("org") or "").strip():
            updates["org"] = org_link
        if updates:
            await client.patch_frontmatter_structured(
                f"{record_type}/{norm}.md", json_updates=updates,
            )
            if cached is not None and "related" in updates:
                current_fm["related"] = updates["related"]
        return "merged"
    await client.write_record(
        record_type, norm,
        _enriched_entity_content(
            record_type, norm,
            description=description, related=backlinks,
            org_link=org_link, role=role, email=email,
            aliases=aliases, source_note=source_note,
        ),
    )
    if cached is not None:
        cached[cf] = {"name": norm, "related": list(backlinks),
                      "org": org_link}
    return "created"


def _org_name_from_link(org_link: str) -> str:
    """Extract the bare org name from an ``[[org/Name]]`` wikilink (or a bare
    name). Returns the normalised name, or "" if there's nothing to extract."""
    s = (org_link or "").strip()
    if not s:
        return ""
    parsed = _parse_entity_wikilink(s)
    if parsed and parsed[0] == "org":
        return _normalize_entity_name(parsed[1])
    return _normalize_entity_name(s)


async def _ensure_org_for_person(
    client: VaultClient,
    org_link: str,
    *,
    person_name: str,
    backlinks: list[str],
    listing: dict[str, dict[str, Any]],
    facts_corpus: str = "",
) -> bool:
    """B9: symmetrically materialise the org named by a person→org tie.

    The live gap was 20 person but 0 org records: an LLM/matter that names a
    person with an ``org`` tie produces a dangling ``[[org/Name]]`` wikilink
    but no org record unless the org also happened to be listed as a
    standalone entity. This create-or-merges that org so the edge resolves.
    Returns True iff a NEW org record was created.

    ``facts_corpus`` is passed through to the C-OB1 org filter so a
    person→org tie carrying a bare domain (``[[org/github.com]]``) is
    dropped just like a standalone domain org would be.
    """
    org_name = _org_name_from_link(org_link)
    if not org_name:
        return False
    outcome = await _create_or_merge_entity(
        client,
        record_type="org", name=org_name,
        backlinks=backlinks,
        description=f"Organization associated with {person_name}.",
        source_note="_Seeded during onboarding from a person→org tie._",
        existing_fm=listing,
        facts_corpus=facts_corpus,
    )
    return outcome == "created"


def _kg_seed_enabled() -> bool:
    """Pass B (LLM corpus seeding) gate. Default on, env-overridable."""
    return os.environ.get("ONBOARDING_KG_SEED", "true").strip().lower() != "false"


def _kg_seed_cap() -> int:
    """Max entities Pass B will materialise (bounds scale on a huge corpus).

    Default 250 (env-overridable): Pass B is ONE LLM extraction call (already
    paid) plus cheap per-entity create-or-merge vault writes — not per-entity
    expensive — so the full extracted corpus should seed, not just a slice.
    """
    try:
        return max(0, int(os.environ.get("ONBOARDING_KG_SEED_CAP", "250")))
    except ValueError:
        return 250


def _build_corpus_entity_prompt(facts: list[dict[str, Any]]) -> str:
    """Prompt for Pass B's single batched entity-extraction call.

    Reuses the *idea* of the retired ``write_facts_to_vault`` prompt but
    constrains the type vocabulary to the canonical person/org/place (ctrl
    422s anything else) and asks for a person→org tie so the graph resolves
    those edges.
    """
    lines: list[str] = []
    for f in facts:
        if isinstance(f, dict):
            t = str(f.get("fact", "")).strip()
            if t:
                lines.append(f"- {t}")
    fact_block = "\n".join(lines) if lines else "(no facts)"
    return f"""You are Alfred's clerk. Extract STRUCTURED ENTITIES from these facts about your principal so each gets its own vault record.

FACTS ({len(lines)}):
{fact_block}

For each DISTINCT real-world person, organization, or physical place mentioned, emit one entity. Skip the principal themselves, generic roles ("my accountant" with no name), and anything that isn't a concrete named entity.

Fields per entity:
- type: EXACTLY one of `person`, `org`, `place`. Never `project`, `location`, or anything else.
- name: the proper name (full name for people, Title Case).
- description: 2-3 sentences about this entity and how it relates to the principal, grounded in the facts.
- org: (person only) the organization this person belongs to, as a bare name (e.g. "Acme Co") — omit or empty if unknown.
- role: (person only) their job title or role — omit if unknown.
- email: (person only) their email if it appears in the facts — omit otherwise.

Return ONLY valid JSON. No preamble, no markdown fences:
{{
  "entities": [
    {{"type": "person", "name": "Full Name", "description": "...", "org": "Acme Co", "role": "Founder", "email": ""}},
    {{"type": "org", "name": "Acme Co", "description": "..."}},
    {{"type": "place", "name": "Berlin Office", "description": "..."}}
  ]
}}

Be thorough but honest — extract every clearly-named entity, invent nothing."""


@activity.defn
async def materialize_matter_entities(onboard_path: str) -> dict[str, Any]:
    """Seed an enriched, interlinked vault knowledge graph (B9).

    Pass A — for each matter's ``related_persons``/``related_orgs`` wikilink:
    create an enriched curator-schema record if none exists (description from
    the fact-substring + matter context, person→org tie, base embeds), else
    union the matter backlink onto the entity's ``related`` (never clobber a
    curator body). Deterministic.

    Pass B — one batched plain-completion ``_call_llm`` call (NOT the agentic
    ``_call_clerk``) over ``onboard["facts"]`` emits canonical person/org/place
    records for the broader corpus, create-or-merged the same way. Gated by
    ``ONBOARDING_KG_SEED`` + an entity cap; no-ops cleanly on LLM failure. The
    activity never raises — onboarding must not be blocked by graph seeding.

    Idempotent + best-effort. The activity NAME is kept stable for Temporal
    replay-safety; only the body expanded (see module note above).
    """
    config = load_config()
    client = VaultClient(config)
    onboard = _read_onboard_json(onboard_path)
    facts = onboard.get("facts") or []
    if not isinstance(facts, list):
        facts = []

    # C-OB1 org filter needs the facts string corpus: an org name only
    # earns a record if it's named in the principal's facts (proves it's
    # a real company, not a bare sender domain). Built once per run.
    facts_corpus = "\n".join(
        str(f.get("fact", "")).strip()
        for f in facts if isinstance(f, dict)
    )

    created = 0
    linked = 0
    seeded = 0

    # Cache the typed listing ONCE per type (avoid O(N²) record_exists over
    # hundreds of entities — each existence check would otherwise re-list).
    # Maps casefold(normalized name) → that record's frontmatter, so a merge
    # can UNION the existing ``related`` instead of clobbering it.
    existing_fm_cache: dict[str, dict[str, dict[str, Any]]] = {}

    async def _ensure_listing(record_type: str) -> dict[str, dict[str, Any]]:
        if record_type not in existing_fm_cache:
            try:
                recs = await client.list_records(record_type, limit=1000)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "materialize: listing %s failed: %s", record_type, exc)
                recs = []
            by_name: dict[str, dict[str, Any]] = {}
            for r in recs or []:
                fm = dict(r.get("frontmatter") or {})
                nm = str(fm.get("name") or r.get("name") or "").strip()
                if not nm:
                    path = str(r.get("path") or "")
                    if "/" in path:
                        nm = path.split("/", 1)[1].rsplit(".md", 1)[0]
                if nm:
                    by_name[_normalize_entity_name(nm).casefold()] = fm
            existing_fm_cache[record_type] = by_name
        return existing_fm_cache[record_type]

    try:
        # ---- Pass A: enrich matter-named entities -----------------------
        try:
            matters = await client.list_records("matter", limit=500)
        except Exception as exc:  # noqa: BLE001
            logger.warning("materialize_matter_entities: matter list failed: %s", exc)
            matters = []

        for rec in matters or []:
            matter_path = str(rec.get("path") or "").strip()
            fm = rec.get("frontmatter") or rec
            if not matter_path.startswith("matter/"):
                continue
            matter_context = str(
                fm.get("context") or fm.get("description") or "").strip()
            matter_name = str(fm.get("name") or "").strip()
            backlink = f"[[{matter_path[:-3]}]]"

            # Collect this matter's org wikilinks so a person can be tied to
            # the matter's org (person→org edge). One org/matter is the common
            # case; pick the first as the tie.
            org_vals = fm.get("related_orgs")
            matter_org_link = ""
            if isinstance(org_vals, list):
                for ov in org_vals:
                    p = _parse_entity_wikilink(str(ov))
                    if p and p[0] == "org":
                        matter_org_link = f"[[org/{_normalize_entity_name(p[1])}]]"
                        break

            for field in ("related_persons", "related_orgs"):
                vals = fm.get(field)
                if not isinstance(vals, list):
                    continue
                for link in vals:
                    parsed = _parse_entity_wikilink(str(link))
                    if not parsed:
                        continue
                    etype, raw_name = parsed
                    name = _normalize_entity_name(raw_name)
                    if not name:
                        continue
                    # Deterministic description: fact substrings + matter context.
                    hits = _facts_mentioning(facts, name)
                    if hits:
                        desc = " ".join(hits[:3])
                    elif matter_context:
                        desc = (
                            f"Involved in the matter “{matter_name or matter_path[7:-3]}”. "
                            f"{matter_context[:280]}"
                        ).strip()
                    else:
                        desc = f"Named in the matter “{matter_name or matter_path[7:-3]}”."
                    org_link = matter_org_link if etype == "person" else ""
                    try:
                        listing = await _ensure_listing(etype)
                        outcome = await _create_or_merge_entity(
                            client,
                            record_type=etype, name=name,
                            backlinks=[backlink],
                            description=desc,
                            org_link=org_link,
                            source_note=f"_Seeded during onboarding from `{matter_path}`._",
                            existing_fm=listing,
                            facts_corpus=facts_corpus,
                        )
                        if outcome == "created":
                            created += 1
                        linked += 1
                        # B9: a person→org tie must also materialise the org,
                        # not just leave a dangling [[org/Name]] link.
                        if etype == "person" and org_link:
                            org_listing = await _ensure_listing("org")
                            if await _ensure_org_for_person(
                                client, org_link,
                                person_name=name, backlinks=[backlink],
                                listing=org_listing,
                                facts_corpus=facts_corpus,
                            ):
                                created += 1
                        activity.heartbeat(f"materialize: {etype}/{name}")
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "materialize_matter_entities: %s/%s failed: %s",
                            etype, name, exc,
                        )

        # Pass A.5 (Gap 3): deterministic facts → orgs. Writes must-have
        # org records BEFORE Pass B so a 180s timeout doesn't leave
        # the vault with org: 0.
        facts_orgs: list[dict[str, Any]] = []
        if facts:
            try:
                facts_orgs = _extract_org_candidates_from_facts(facts)
            except Exception as exc:  # noqa: BLE001
                logger.warning("materialize: Pass A.5 extract failed: %s", exc)
        if facts_orgs:
            logger.info(
                "materialize: Pass A.5 extracted %d org(s) from facts",
                len(facts_orgs),
            )
            org_listing = await _ensure_listing("org")
            for cand in facts_orgs:
                name = cand.get("name") or ""
                try:
                    outcome = await _create_or_merge_entity(
                        client, record_type="org", name=name,
                        backlinks=[],
                        description=cand.get("description") or "",
                        source_note=(
                            "_Seeded during onboarding from a fact "
                            "naming this organization._"
                        ),
                        existing_fm=org_listing,
                        facts_corpus=facts_corpus,
                    )
                    if outcome == "created":
                        seeded += 1
                    activity.heartbeat(f"materialize(facts): org/{name}")
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "materialize: Pass A.5 org/%s failed: %s", name, exc)

        # ---- Pass B: seed the broader fact corpus (LLM-gated) -----------
        if facts and _kg_seed_enabled():
            cap = _kg_seed_cap()
            try:
                prompt = _build_corpus_entity_prompt(facts)
                # Plain completion (NOT _call_clerk): the agentic clerk runs an
                # MCP-tooled agent that would try to CREATE these records itself
                # and trip same_tool_failure_halt, returning a meta-explanation
                # instead of JSON. _call_llm returns the entities JSON we ask for.
                # Shorter total_timeout (90s, down from the default 600s) so
                # the activity degrades-and-continues faster when the LLM call
                # times out — the must-have orgs are already written by Pass
                # A.5, so Pass B is enhancement, not blocking.
                raw = await _call_llm(
                    prompt, max_tokens=8192, total_timeout=90.0,
                    heartbeat_message="materialize: Pass B corpus entity extraction",
                )
                parsed = _parse_json_with_key(raw, "entities")
                entities = parsed.get("entities") if isinstance(parsed, dict) else None
            except Exception as exc:  # noqa: BLE001
                # Degrade gracefully — Pass B is non-essential; never crash.
                # Phase 4: also record the stage in onboard["degraded_stages"]
                # for observability when this is a 402 / credit wall — the UI
                # can then surface "finished with reduced fidelity" instead of
                # the failure being silent in the worker log.
                logger.warning(
                    "materialize: Pass B corpus seed skipped (LLM unavailable): %s",
                    exc,
                )
                try:
                    from src.activities.onboarding_v3 import _handle_llm_degraded
                    _handle_llm_degraded(
                        "materialize", onboard_path, exc,
                        activity_name="materialize_matter_entities",
                    )
                except Exception:  # noqa: BLE001 — observability bookkeeping only
                    pass
                entities = None

            if isinstance(entities, list):
                for ent in entities:
                    if seeded >= cap:
                        logger.info("materialize: Pass B hit entity cap %d", cap)
                        break
                    if not isinstance(ent, dict):
                        continue
                    etype = str(ent.get("type", "")).strip().lower()
                    if etype not in _CANONICAL_ENTITY_TYPES:
                        continue  # never write project/location/observation
                    name = _normalize_entity_name(str(ent.get("name", "")))
                    if not name:
                        continue
                    description = str(ent.get("description", "")).strip()
                    org_link = ""
                    if etype == "person":
                        raw_org = str(ent.get("org", "")).strip()
                        if raw_org:
                            org_link = f"[[org/{_normalize_entity_name(raw_org)}]]"
                    role = str(ent.get("role", "")).strip()
                    email = str(ent.get("email", "")).strip()
                    try:
                        listing = await _ensure_listing(etype)
                        outcome = await _create_or_merge_entity(
                            client,
                            record_type=etype, name=name,
                            backlinks=[],
                            description=description,
                            org_link=org_link, role=role, email=email,
                            existing_fm=listing,
                            facts_corpus=facts_corpus,
                        )
                        if outcome == "created":
                            seeded += 1
                        # B9: materialise the org the person is tied to, even
                        # when the LLM didn't emit it as a standalone entity.
                        if etype == "person" and org_link:
                            org_listing = await _ensure_listing("org")
                            if await _ensure_org_for_person(
                                client, org_link,
                                person_name=name, backlinks=[],
                                listing=org_listing,
                                facts_corpus=facts_corpus,
                            ):
                                seeded += 1
                        activity.heartbeat(f"materialize(seed): {etype}/{name}")
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "materialize: Pass B %s/%s failed: %s",
                            etype, name, exc,
                        )

        logger.info(
            "materialize_matter_entities: created %d (matter), linked %d, "
            "seeded %d (corpus) across %d matters",
            created, linked, seeded, len(matters or []),
        )
        return {
            "created": created,
            "linked": linked,
            "seeded": seeded,
            "matters": len(matters or []),
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

- "Reply to Pat's contract revision" (owner: human, due: this week)
- "Cancel the second Polar.sh subscription" (owner: human, urgency: normal)
- "Book Robin's 9-month checkup with Dr. Smith" (owner: human, due: next month)
- "Draft the BuildTrack proposal response" (owner: human, due: by Friday)
- "Confirm the Example Co H2 invoice with Sam Lee" (owner: human, urgency: normal)
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

- **name**: short imperative title (max 80 chars). E.g. "Reply to Pat's contract revision"
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
                if await client.record_exists("task", slug):
                    skipped_existing += 1
                    continue
            except Exception as exc:
                logger.warning(
                    "errand_pack_opus: existence check failed for %s: %s (proceeding)",
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


# ---------------------------------------------------------------------------
# Instinct pack (Opus-driven, Plan B.3)
# ---------------------------------------------------------------------------

# instinct statuses per vault.ts STATUS_BY_TYPE
_VALID_INSTINCT_STATUSES = {"active", "proposed", "deprecated", "merged"}

# Routing destinations Opus is allowed to pick. Constrains the instinct
# to existing concepts in the system rather than letting Opus invent new
# routing targets.
_VALID_ROUTING_DESTINATIONS = {
    "stream", "triage", "matter", "errand", "log", "digest",
    "notification", "draft", "review",
}


def _build_instinct_prompt(
    facts: list[dict[str, Any]],
    patterns: list[Any],
    key_identity_facts: list[dict[str, Any]],
    profile_summary: dict[str, Any],
    matters_brief: list[dict[str, Any]],
) -> str:
    """Construct the Opus prompt for instinct-pack generation.

    Instincts are rules-of-thumb that the judgment layer applies to incoming
    inputs (emails, events, requests). The prompt is explicit about what
    fields are needed because the existing _build_instinct_content function
    expects a structured dict.
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
        for item in items[:15]:
            fact_block_parts.append(f"- {item}")
    fact_block = "\n".join(fact_block_parts) if fact_block_parts else "(no facts yet)"

    # Patterns are the most important input for instincts
    pattern_lines: list[str] = []
    for p in patterns[:30]:
        if isinstance(p, dict):
            name = p.get("name") or p.get("title") or "unnamed"
            desc = p.get("description", "")
            pattern_lines.append(f"- **{name}**: {desc}")
        elif isinstance(p, str):
            pattern_lines.append(f"- {p}")
    pattern_block = "\n".join(pattern_lines) if pattern_lines else "(no patterns yet)"

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

    matter_names: list[str] = []
    for m in matters_brief[:10]:
        if isinstance(m, dict):
            n = m.get("name") or m.get("title") or ""
            if n:
                matter_names.append(str(n))
    matters_block = "\n".join(f"- {n}" for n in matter_names) if matter_names else "(no matters yet)"

    return f"""You are Alfred, a personal AI butler. You are deciding what INSTINCTS to set up — rules-of-thumb your judgment layer can apply to incoming inputs (emails, events, requests) so you can act with discretion instead of asking the user about every single thing.

## What an instinct IS

An instinct is a learned rule that says: "When I see X, I should do Y, with this much confidence." Examples:

- "When an email comes from anyone in the inner circle (Sam Lee, Pat, tenant-a), surface it to triage immediately and never archive without asking."
- "When a Stripe payment fails or is declined, always escalate to urgent — this user is sensitive about cash flow and missing one creates real downstream pain."
- "When a newsletter arrives from any of these 12 domains, send straight to the daily digest log — never to inbox triage."
- "When a calendar invite arrives outside the user's stated work hours (9-6 CET), batch it for evening review rather than interrupting current focus."
- "When Robin's nursery is the sender, always elevate urgency and notify both parents, not just the user."

The judgment layer uses these instincts as defaults. The user can always override or refine them later.

## What an instinct is NOT

- A specific errand or task
- A matter (an ongoing area)
- A chore (a recurring scheduled automation)
- A general piece of advice ("be careful about cash flow")

## Your inputs

### Profile summary
{profile_block}

### Existing matters (so instincts can reference them)
{matters_block}

### Facts ({sum(len(v) for v in by_cat.values())} total, grouped by category)
{fact_block}

### Patterns discovered by behavioral analysis (this is your most important input)
{pattern_block}

## Your task

Derive 5-12 instincts from the patterns and facts. Lean heavily on the patterns — instincts are crystallized rules that explain how to handle inputs that match a pattern. For EACH instinct:

- **name**: short kebab-case slug (max 60 chars), e.g. `route-inner-circle-priority`
- **description**: 1-2 sentences, plain English description of what this instinct does
- **status**: `active` (default) or `proposed` (if you're not 100% sure the user would approve)
- **trigger_summary**: 1 sentence — when does this fire?
- **action_summary**: 1 sentence — what does Alfred do when it fires?
- **rationale**: 2-3 paragraphs explaining WHY this rule exists, grounded in the specific patterns and facts you saw. This is the part the user will read when reviewing.
- **examples**: 2-4 concrete examples drawn from the user's actual facts/patterns. Real names, real domains.
- **input_patterns**:
  - sender_domains: list of domain strings (lowercase, like ["stripe.com", "polar.sh"])
  - subject_keywords: list of keyword strings (lowercase)
  - input_types: list of input type strings, usually ["email"] or ["event"]
- **routing_rule**:
  - destination_type: one of `stream`, `triage`, `matter`, `errand`, `log`, `digest`, `notification`, `draft`, `review`
  - destination: short label of where to route (e.g. "tier2 stream-log", "priority triage")
  - process: short label of what to do (e.g. "archive", "urgent-triage", "daily-digest")
- **confidence_score**: float 0.0-1.0. How confident YOU are this rule is right for this user. (Do NOT emit a discretion_threshold — new instincts always start at Asking and earn autonomy as real observations accumulate; autonomy is never granted at creation.)
- **execution** (OPTIONAL): include ONLY when the instinct's action goes BEYOND simple routing. If the instinct should CREATE A TASK (e.g. "create an urgent errand with specific details", "draft a reply", "summarize and notify"), set `execution.enabled: true`. For pure routing instincts ("file newsletters to digest", "route to project folder"), omit or set `enabled: false`.

## Output format

Return ONLY valid JSON. No preamble, no fences:

```json
{{
  "instincts": [
    {{
      "name": "route-inner-circle-priority",
      "description": "...",
      "status": "active",
      "trigger_summary": "...",
      "action_summary": "...",
      "rationale": "...",
      "examples": ["...", "..."],
      "input_patterns": {{
        "sender_domains": ["..."],
        "subject_keywords": ["..."],
        "input_types": ["email"]
      }},
      "routing_rule": {{
        "destination_type": "triage",
        "destination": "priority triage queue",
        "process": "urgent-triage"
      }},
      "execution": {{
        "enabled": false,
        "task_title_template": "{{title}}",
        "tier": 2,
        "requires_approval": true
      }},
      "confidence_score": 0.9
    }}
  ]
}}
```

execution field rules:
- enabled: true ONLY if the instinct should spawn an execution task (create errand, draft reply, summarize + notify). false for pure routing.
- tier: 2 (default), 3 (for event-driven patterns with clear non-destructive actions)
- requires_approval: ALWAYS true for onboarding-generated instincts. The trust gradient auto-relaxes as observation_count grows.

Be honest: write fewer instincts if the patterns don't support more. Don't invent rules that aren't backed by evidence. Empty `subject_keywords` is fine. But `rationale` and `examples` must always be substantive — these are what justify the rule to the user.
"""


def _validate_instinct(instinct: dict[str, Any]) -> tuple[bool, str]:
    """Return (ok, reason) for a single instinct dict from the Opus response."""
    if not isinstance(instinct, dict):
        return False, "not a dict"

    name = instinct.get("name", "")
    if not isinstance(name, str) or not name.strip():
        return False, "missing or empty name"
    if len(name) > 80:
        return False, "name too long"

    status = str(instinct.get("status", "active")).strip().lower()
    if status not in _VALID_INSTINCT_STATUSES:
        return False, f"invalid status: {status}"

    description = instinct.get("description", "")
    if not isinstance(description, str) or len(description.strip()) < 10:
        return False, "description too short"

    rationale = instinct.get("rationale", "")
    if not isinstance(rationale, str) or len(rationale.strip()) < 60:
        return False, "rationale too short (needs at least one real paragraph)"

    examples = instinct.get("examples", [])
    if not isinstance(examples, list) or len(examples) < 1:
        return False, "examples must be a non-empty list"

    input_patterns = instinct.get("input_patterns", {})
    if not isinstance(input_patterns, dict):
        return False, "input_patterns not a dict"
    if not isinstance(input_patterns.get("sender_domains", []), list):
        return False, "input_patterns.sender_domains not a list"
    if not isinstance(input_patterns.get("subject_keywords", []), list):
        return False, "input_patterns.subject_keywords not a list"

    routing_rule = instinct.get("routing_rule", {})
    if not isinstance(routing_rule, dict):
        return False, "routing_rule not a dict"
    dest_type = str(routing_rule.get("destination_type", "")).strip().lower()
    if dest_type and dest_type not in _VALID_ROUTING_DESTINATIONS:
        return False, f"invalid destination_type: {dest_type}"

    threshold = instinct.get("discretion_threshold")
    if isinstance(threshold, (int, float)):
        if not (0.0 <= float(threshold) <= 1.0):
            return False, "discretion_threshold out of range 0..1"
    elif threshold is not None:
        return False, "discretion_threshold not a number"

    # execution block is optional — validate structure if present
    execution = instinct.get("execution")
    if execution is not None:
        if not isinstance(execution, dict):
            return False, "execution must be a dict"
        if "enabled" in execution and not isinstance(execution["enabled"], bool):
            return False, "execution.enabled must be a boolean"

    return True, ""


# ---------------------------------------------------------------------------
# C-OB4 instinct seeding caps — applied by BOTH packs_opus and packs.
# ---------------------------------------------------------------------------
# At observation_count==0 every newly-seeded instinct must carry the
# 'unearned' posture: Asking tier, status unconfirmed, discretion_
# threshold >= 0.7 (raise-only floor), confidence_score <= 0.4. Live
# 2026-05-23 had 9 Opus instincts at confidence 0.86-0.91 with no tier
# — exactly the premature-trust hole GENERATORS.md §7 calls out.

_UNEARNED_CONFIDENCE_CAP = 0.4
_UNEARNED_DISCRETION_FLOOR = 0.95  # matches discretion.py's <5-obs Asking bar


def _apply_unearned_caps(instinct: dict[str, Any]) -> None:
    """Mutate ``instinct`` in place to enforce the C-OB4 seeding caps.

    Idempotent. Safe to call on a record that already meets the caps.
    """
    instinct["tier"] = "Asking"
    instinct["status"] = "unconfirmed"
    try:
        cur_conf = float(instinct.get("confidence_score", 0.0))
    except (TypeError, ValueError):
        cur_conf = 0.0
    instinct["confidence_score"] = min(cur_conf, _UNEARNED_CONFIDENCE_CAP)
    try:
        cur_thresh = float(instinct.get("discretion_threshold", 0.0))
    except (TypeError, ValueError):
        cur_thresh = 0.0
    instinct["discretion_threshold"] = max(cur_thresh, _UNEARNED_DISCRETION_FLOOR)


def _build_rich_instinct_content(instinct: dict[str, Any]) -> str:
    """Render a validated instinct dict as a markdown record with rich body.

    Uses the flat-YAML frontmatter pattern (no nested mappings) so it
    round-trips through the ctrl-api vault parser. The structured pattern
    fields are JSON-encoded into single-quoted scalars; templates that
    consume them parse the scalars back to dicts on read.

    Body has Description, Rationale, and Examples sections so users
    reviewing instincts in the dashboard see real justification.

    Callers seeding at observation_count=0 should run
    ``_apply_unearned_caps(instinct)`` first; this renderer reads the
    capped tier/status/discretion_threshold/confidence values out of
    ``instinct`` and emits them in frontmatter so the C-OB4 posture is
    visible to the principal in the vault record.
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    name = str(instinct["name"]).strip()
    status = str(instinct.get("status", "active")).strip().lower()
    tier = str(instinct.get("tier", "")).strip()
    description = str(instinct["description"]).strip()
    rationale = str(instinct["rationale"]).strip()
    examples = [str(e).strip() for e in instinct.get("examples", []) if str(e).strip()]
    trigger_summary = str(instinct.get("trigger_summary", "")).strip()
    action_summary = str(instinct.get("action_summary", "")).strip()

    input_patterns = instinct.get("input_patterns") or {}
    routing_rule = instinct.get("routing_rule") or {}
    confidence = float(instinct.get("confidence_score", 0.85))
    discretion_threshold = instinct.get("discretion_threshold")

    # Encode the structured nested fields as JSON-scalar strings so the
    # flat parser on the read side can round-trip them via json.loads.
    input_patterns_json = json.dumps(input_patterns, default=str, separators=(",", ":"))
    routing_rule_json = json.dumps(routing_rule, default=str, separators=(",", ":"))

    fm_lines = [
        "---",
        "type: instinct",
        f"name: {_escape_yaml_scalar(name)}",
        f"status: {status}",
        f"description: {_escape_yaml_scalar(description)}",
        f"created: {now}",
        f"updated: {now}",
        f"created_by: onboarding_pipeline",
        f"generated: true",
        f"confidence_score: {confidence}",
        f"observation_count: 0",
        f"input_patterns: {_escape_yaml_scalar(input_patterns_json)}",
        f"routing_rule: {_escape_yaml_scalar(routing_rule_json)}",
    ]
    # C-OB4: surface the capped tier + discretion floor when they're set
    # (e.g. via _apply_unearned_caps for the day-zero seeding path).
    if tier:
        fm_lines.append(f"tier: {tier}")
    if isinstance(discretion_threshold, (int, float)):
        fm_lines.append(f"discretion_threshold: {float(discretion_threshold)}")

    # Persist execution block if the LLM included one
    execution = instinct.get("execution")
    if isinstance(execution, dict) and execution:
        execution_json = json.dumps(execution, default=str, separators=(",", ":"))
        fm_lines.append(f"execution: {_escape_yaml_scalar(execution_json)}")

    fm_lines += [
        "tags: [onboarding, instinct, auto-generated]",
        "---",
    ]

    body_parts: list[str] = [
        f"# {name}",
        "",
        f"> {description}",
    ]
    if trigger_summary or action_summary:
        body_parts += ["", "## Trigger and action", ""]
        if trigger_summary:
            body_parts.append(f"**When:** {trigger_summary}")
        if action_summary:
            body_parts.append(f"**Then:** {action_summary}")

    body_parts += [
        "",
        "## Rationale",
        "",
        rationale,
    ]

    if examples:
        body_parts += ["", "## Examples", ""]
        body_parts += [f"- {e}" for e in examples]

    # Routing summary table for the dashboard
    dest_type = routing_rule.get("destination_type", "")
    destination = routing_rule.get("destination", "")
    process = routing_rule.get("process", "")
    if dest_type or destination or process:
        body_parts += ["", "## Routing", ""]
        if dest_type:
            body_parts.append(f"- **Destination type:** {dest_type}")
        if destination:
            body_parts.append(f"- **Destination:** {destination}")
        if process:
            body_parts.append(f"- **Process:** {process}")

    # No discretion-threshold line — day-zero instincts start at Asking
    # and earn autonomy from accumulated observations (see frontmatter
    # note above), so there is no seeded threshold to report.
    summary_bits = [f"**Confidence:** {confidence:.2f}"]
    body_parts += [
        "",
        "  |  ".join(summary_bits),
        "",
        "---",
        "",
        f"*Auto-generated by Alfred during onboarding on {now}.*",
        "",
    ]

    return "\n".join(fm_lines) + "\n\n" + "\n".join(body_parts)


@activity.defn
async def generate_instinct_pack_opus(onboard_path: str) -> dict[str, Any]:
    """Opus-driven instinct pack generator (Plan B.3).

    Reads facts + patterns + profile + matters and asks Opus to derive
    5-12 instincts (rules-of-thumb the judgment layer can apply). Writes
    rich markdown instinct records.

    Falls back to ``generate_instinct_pack`` on every expected failure mode.
    """
    if not _opus_packs_enabled():
        logger.info("instinct_pack_opus: disabled by env flag, using rule-based")
        from src.activities.packs import generate_instinct_pack
        rb = await generate_instinct_pack(onboard_path)
        return {**rb, "source": "rule_based_env_flag"}

    activity.heartbeat("instinct_pack_opus: reading onboard.json")
    onboard = _read_onboard_json(onboard_path)
    facts = onboard.get("facts") or []
    patterns = onboard.get("patterns") or []
    key_identity_facts = onboard.get("key_identity_facts") or []
    profile = onboard.get("profile") or {}
    matters_brief = onboard.get("matters_brief") or []

    if not patterns and not facts:
        logger.info("instinct_pack_opus: no patterns/facts, falling back")
        from src.activities.packs import generate_instinct_pack
        rb = await generate_instinct_pack(onboard_path)
        return {**rb, "source": "rule_based_no_context"}

    prompt = _build_instinct_prompt(
        facts, patterns, key_identity_facts, profile, matters_brief
    )

    activity.heartbeat(
        f"instinct_pack_opus: calling Opus ({len(patterns)} patterns)"
    )
    try:
        # 16384 tokens because instincts have nested input_patterns and
        # routing_rule dicts plus 2-3 paragraph rationales each — at
        # 5-12 instincts the response runs ~30-50KB and 8192 tokens
        # truncates mid-instinct, defeating the brace-repair fallback.
        raw = await _call_llm(
            prompt,
            max_tokens=16384,
            heartbeat_message="instinct_pack_opus: waiting on Opus",
        )
    except Exception as exc:
        logger.error("instinct_pack_opus: LLM failed: %s — falling back", exc)
        from src.activities.packs import generate_instinct_pack
        rb = await generate_instinct_pack(onboard_path)
        return {**rb, "source": "rule_based_llm_error", "llm_error": str(exc)}

    parsed = _parse_json_with_key(raw, "instincts") or {}
    instincts = parsed.get("instincts") if isinstance(parsed, dict) else None
    if not isinstance(instincts, list) or not instincts:
        logger.error(
            "instinct_pack_opus: failed to parse 'instincts' (len=%d), falling back",
            len(raw) if isinstance(raw, str) else 0,
        )
        from src.activities.packs import generate_instinct_pack
        rb = await generate_instinct_pack(onboard_path)
        return {**rb, "source": "rule_based_parse_error"}

    config = load_config()
    client = VaultClient(config)
    created = 0
    skipped_existing = 0
    skipped_invalid = 0
    rejected_reasons: list[str] = []
    try:
        for instinct in instincts[:12]:
            ok, reason = _validate_instinct(instinct)
            if not ok:
                skipped_invalid += 1
                rejected_reasons.append(reason)
                logger.warning("instinct_pack_opus: rejecting: %s", reason)
                continue

            slug = _slugify(instinct["name"])
            if not slug:
                skipped_invalid += 1
                continue

            try:
                if await client.record_exists("instinct", slug):
                    skipped_existing += 1
                    continue
            except Exception as exc:
                logger.warning(
                    "instinct_pack_opus: existence check failed for %s: %s (proceeding)",
                    slug, exc,
                )

            # C-OB4: day-zero instincts seed with Asking tier, status
            # unconfirmed, capped confidence, and a discretion floor —
            # autonomy is earned via observations, never granted by the
            # LLM's prior. _apply_unearned_caps mutates the dict in place.
            _apply_unearned_caps(instinct)

            content = _build_rich_instinct_content(instinct)
            try:
                await client.write_record("instinct", slug, content)
                created += 1
                activity.heartbeat(f"instinct_pack_opus: wrote {slug}")
            except Exception as exc:
                logger.error("instinct_pack_opus: write failed for %s: %s", slug, exc)
                skipped_invalid += 1
                rejected_reasons.append(f"write failed: {exc}")

        logger.info(
            "instinct_pack_opus: created %d, skipped_existing %d, invalid %d",
            created, skipped_existing, skipped_invalid,
        )

        if created == 0:
            logger.warning("instinct_pack_opus: no valid instincts created, falling back")
            from src.activities.packs import generate_instinct_pack
            rb = await generate_instinct_pack(onboard_path)
            return {
                **rb,
                "source": "rule_based_no_valid_instincts",
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
