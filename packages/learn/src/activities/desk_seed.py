"""C-OB3 — day-one Desk seed.

A fresh onboarding leaves the Desk empty. ``seed_day_one_desk_cards``
reads the materialised matters, ranks them by time-anchor closeness
(rank 0 = this-week weekday phrase; rank 1 = next-month month-day /
quarter / "by X"; vague → dropped), and writes a ``needs_attention``
card for the top 2-3 so the Desk lands populated on day one.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


@dataclass
class _TimeAnchor:
    """``rank`` = 0 (this-week) | 1 (next-month). ``text`` is the
    matched substring used in the seeded card's headline."""
    rank: int
    text: str


_WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday",
             "friday", "saturday", "sunday")
_MONTHS = ("january", "february", "march", "april", "may", "june",
           "july", "august", "september", "october", "november", "december")
_WEEKDAY_OR = "|".join(_WEEKDAYS)
_MONTH_OR = "|".join(_MONTHS)

_RANK0_PATTERNS = [
    re.compile(
        rf"\b(?:next|this|coming|on|by|before|after)\s+({_WEEKDAY_OR})\b",
        re.IGNORECASE),
    re.compile(r"\b(next|this)\s+week\b", re.IGNORECASE),
    re.compile(rf"\b({_WEEKDAY_OR})\b", re.IGNORECASE),
]

_RANK1_PATTERNS = [
    re.compile(
        rf"\b({_MONTH_OR})\s+\d{{1,2}}(?:\s*,?\s*\d{{4}})?\b",
        re.IGNORECASE),
    re.compile(r"\bQ[1-4]\s*\d{4}\b"),
    re.compile(rf"\bby\s+({_MONTH_OR})\s+\d{{1,2}}\b", re.IGNORECASE),
]


def _find_time_anchor(body: str) -> _TimeAnchor | None:
    """Earliest-rank time anchor in ``body``, or None."""
    if not body:
        return None
    for p in _RANK0_PATTERNS:
        m = p.search(body)
        if m:
            return _TimeAnchor(rank=0, text=m.group(0))
    for p in _RANK1_PATTERNS:
        m = p.search(body)
        if m:
            return _TimeAnchor(rank=1, text=m.group(0))
    return None


def _extract_first_suggested_actions(body: str, max_count: int = 2) -> list[str]:
    """First ``max_count`` bullets out of ``## Suggested next actions``."""
    if not body:
        return []
    m = re.search(
        r"^##\s+Suggested next actions\s*\n(.*?)(?=^##\s|\Z)",
        body, re.DOTALL | re.MULTILINE,
    )
    if not m:
        return []
    bullets: list[str] = []
    for line in m.group(1).splitlines():
        line = line.strip()
        if line.startswith("- ") and len(line) > 3:
            bullets.append(line[2:].strip())
        if len(bullets) >= max_count:
            break
    return bullets


def _slug_of(matter: dict) -> str:
    path = str(matter.get("path") or "")
    if not path.startswith("matter/") or not path.endswith(".md"):
        return ""
    return path[len("matter/"):-len(".md")]


def _name_of(matter: dict) -> str:
    fm = matter.get("frontmatter") or {}
    return str(fm.get("name") or fm.get("title") or _slug_of(matter)).strip()


def _rank_matters_by_time_anchor(matters: list[dict]) -> list[dict]:
    """Filter to time-anchored matters; rank by closeness ASC. Stable
    on rank then on original list order for deterministic tests."""
    annotated: list[tuple[int, int, dict, _TimeAnchor]] = []
    for idx, m in enumerate(matters):
        anchor = _find_time_anchor(str(m.get("body") or ""))
        if anchor is None:
            continue
        annotated.append((anchor.rank, idx, m, anchor))
    annotated.sort(key=lambda t: (t[0], t[1]))
    out: list[dict] = []
    for _rank, _idx, m, anchor in annotated:
        c = dict(m)
        c["_anchor_text"] = anchor.text
        c["_anchor_rank"] = anchor.rank
        out.append(c)
    return out


def _rank_matters_by_activity(matters: list[dict], top_n: int = 3) -> list[dict]:
    """Gap 2 fallback ranker — top ``top_n`` matters by ``activity_score``
    (float; higher wins), then ``len(key_people)`` (density proxy), then
    original list order. Returned dicts carry ``_fallback=True`` so the
    card builder knows there's no date phrase to quote."""
    if not matters:
        return []

    def _score(m: dict) -> tuple[float, int]:
        fm = m.get("frontmatter") or {}
        try:
            score = float(fm.get("activity_score") or 0.0)
        except (TypeError, ValueError):
            score = 0.0
        kp = fm.get("key_people")
        return (score, len(kp) if isinstance(kp, list) else 0)

    indexed = list(enumerate(matters))
    indexed.sort(key=lambda t: (-_score(t[1])[0], -_score(t[1])[1], t[0]))
    out: list[dict] = []
    for _idx, m in indexed[:max(0, top_n)]:
        c = dict(m)
        c["_anchor_text"] = ""
        c["_anchor_rank"] = -1
        c["_fallback"] = True
        out.append(c)
    return out


def _build_card_content(
    matter: dict, actions: list[str], created_iso: str,
    name: str, anchor_text: str,
) -> str:
    """Render the C-OB3 ``needs_attention`` markdown for one seeded card.

    ``matter["_fallback"]=True`` (Gap 2) → no date phrase to quote;
    headline is the matter name and the body invites edit/dismiss/defer
    so the Day-1 Desk isn't empty on a thematic-only matter set."""
    matter_ref = matter.get("path") or f"matter/{_slug_of(matter)}.md"
    if matter.get("_fallback"):
        headline = name
        lines = [
            f"Alfred surfaced this matter from your inbox to start your "
            f"Desk. The matter is **{name}**. Edit, dismiss, or defer.",
        ]
        if actions:
            lines += ["", "Suggested next actions:", *(f"- {a}" for a in actions)]
        display_body = "\n".join(lines)
    else:
        headline = f"{name} — {anchor_text}".strip(" —")
        if actions:
            display_body = "\n".join(
                ["Suggested next actions:"] + [f"- {a}" for a in actions])
        else:
            display_body = (
                f"From matter {matter_ref}. Time anchor: {anchor_text}."
            )
    fm = (
        "---\n"
        "type: needs_attention\n"
        "status: pending\n"
        "source: onboarding_seed\n"
        f"source_matter_ref: {matter_ref}\n"
        f"display_headline: {json.dumps(headline, ensure_ascii=False)}\n"
        f"display_body: {json.dumps(display_body, ensure_ascii=False)}\n"
        f"created: {created_iso}\n"
        "created_by: onboarding_pipeline\n"
        "tags: [onboarding_seed, day_one]\n"
        "---\n"
    )
    body = (f"\n# {headline}\n\n"
            f"_Seeded by onboarding from `{matter_ref}`._\n\n"
            f"{display_body}\n")
    return fm + body


def _seed_slug(matter: dict) -> str:
    return f"day-one-{_slug_of(matter) or 'matter'}"


def _read_onboard(path: str) -> dict:
    try:
        with open(path) as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _write_onboard(path: str, data: dict) -> None:
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2)


@activity.defn
async def seed_day_one_desk_cards(onboard_path: str) -> dict[str, Any]:
    """Seed 2-3 ``needs_attention`` cards from the most time-critical
    onboarding matters. Idempotent via ``day_one_desk_seeded`` flag."""
    onboard = _read_onboard(onboard_path)
    if onboard.get("day_one_desk_seeded"):
        logger.info("seed_day_one_desk_cards: already seeded — skipping")
        return {"seeded": 0, "skipped": "already_seeded"}

    config = load_config()
    client = VaultClient(config)
    seeded = 0
    try:
        try:
            listing = await client.list_records("matter", limit=200)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "seed_day_one_desk_cards: list_records failed: %s", exc,
            )
            return {"seeded": 0, "error": "list_failed"}

        matters: list[dict] = []
        for entry in listing:
            path = entry.get("path") or ""
            if not path:
                continue
            try:
                matters.append(await client.read_record(path))
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "seed_day_one_desk_cards: read_record(%s) failed: %s",
                    path, exc,
                )

        ranked = _rank_matters_by_time_anchor(matters)
        if not ranked:
            # Gap 2 fallback: seed top 3 by activity_score / key_people so
            # Day-1 Desk isn't empty when matters are thematic (no anchors).
            ranked = _rank_matters_by_activity(matters, top_n=3)
            if not ranked:
                logger.info(
                    "seed_day_one_desk_cards: 0 time-anchored matters in %d "
                    "(fallback inactive: 0 matters available)", len(matters),
                )
                onboard["day_one_desk_seeded"] = True
                _write_onboard(onboard_path, onboard)
                return {"seeded": 0}
            logger.info(
                "seed_day_one_desk_cards: 0 time-anchored matters in %d "
                "(fallback active: %d cards seeded from top matters by "
                "activity)", len(matters), len(ranked),
            )
        else:
            logger.info(
                "seed_day_one_desk_cards: %d time-anchored matters in %d",
                len(ranked), len(matters),
            )

        created_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
        for matter in ranked[:3]:
            name = _name_of(matter)
            anchor_text = str(matter.get("_anchor_text") or "").strip()
            actions = _extract_first_suggested_actions(
                str(matter.get("body") or ""), max_count=2,
            )
            content = _build_card_content(
                matter, actions, created_iso, name, anchor_text,
            )
            slug = _seed_slug(matter)
            try:
                await client.write_record("needs_attention", slug, content)
                seeded += 1
                logger.info(
                    "seed_day_one_desk_cards: wrote needs_attention/%s.md "
                    "(anchor=%r)", slug, anchor_text,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "seed_day_one_desk_cards: write %s failed: %s", slug, exc,
                )

        onboard["day_one_desk_seeded"] = True
        _write_onboard(onboard_path, onboard)
        return {"seeded": seeded}
    finally:
        try:
            await client.close()
        except Exception:  # noqa: BLE001
            pass
