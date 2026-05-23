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
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:  # pragma: no cover — Python <3.9, never our case
    ZoneInfo = None  # type: ignore[assignment]
    ZoneInfoNotFoundError = Exception  # type: ignore[assignment,misc]

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


# C.1: human-facing description bounds. Anything shorter than 80 chars
# isn't a real explanation; anything longer than 1200 is probably the
# whole rationale and shouldn't be in the user-facing summary.
_USER_FACING_MIN_CHARS = 80
_USER_FACING_MAX_CHARS = 1200

# Schedule field added in the generated-chore-schedule fix. Every generated
# chore should emit a 5-field cron (minute hour day-of-month month day-of-week)
# in UTC that matches what user_facing_description promises. Missing field
# triggers a retry; the caller still has a profile-derived fallback for the
# edge case where all attempts fail.
_CRON_FIELD_RE = re.compile(r"^[\d*,\-/]+$")


def _validate_cron_expression(cron: str) -> tuple[bool, str]:
    """Return (ok, error_message) for a 5-field UTC cron expression.

    Rejects common mistakes the LLM has historically made:
      - English descriptions ("every Tuesday at 9am")
      - 6-field crons (with seconds, Quartz-style)
      - The all-wildcards every-minute pattern
      - Out-of-range field values (e.g. hour 25, day 32)
      - Minute-wildcard with any other specific field (#475) — fires 60x/hour
      - Sub-hourly step intervals in minute field with any specific other
        field — no chore should fire more than once per hour

    Does NOT reject hour-granularity aggressive schedules like `0 * * * *`
    (top of every hour). That's legal and occasionally useful.
    """
    if not isinstance(cron, str):
        return False, f"schedule must be a string, got {type(cron).__name__}"
    cleaned = cron.strip()
    if not cleaned:
        return False, "schedule is empty"
    parts = cleaned.split()
    if len(parts) != 5:
        return False, (
            f"schedule must be a 5-field cron expression "
            f"(minute hour day-of-month month day-of-week), got {len(parts)} "
            f"field(s): {cleaned!r}"
        )
    field_names = ("minute", "hour", "day-of-month", "month", "day-of-week")
    field_ranges = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))
    for name, part, (lo, hi) in zip(field_names, parts, field_ranges):
        if not _CRON_FIELD_RE.match(part):
            return False, (
                f"schedule {name} field {part!r} contains invalid characters "
                f"(allowed: digits, '*', ',', '-', '/')"
            )
        # Pull out all decimal literals and range-check them.
        for num_str in re.findall(r"\d+", part):
            try:
                num = int(num_str)
            except ValueError:
                return False, f"schedule {name} field {part!r} has non-integer {num_str!r}"
            if num < lo or num > hi:
                return False, (
                    f"schedule {name} value {num} out of range "
                    f"(must be {lo}-{hi}); full cron was {cleaned!r}"
                )
    if all(p == "*" for p in parts):
        return False, (
            "schedule '* * * * *' fires every minute — this is never what a "
            "chore wants. Pick a specific cadence (e.g. '0 7 * * *' for daily "
            "7am UTC) that matches the user_facing_description."
        )

    # No chore should fire sub-hourly when any other field is pinned. The LLM
    # historically emitted patterns like '* 18 * * *' reading "every day at
    # 6pm" and translating it to "every minute when hour==18". Temporal parses
    # that as 60 firings per hour.
    minute = parts[0]
    other_specific = any(f not in ("*", "*/1") for f in parts[1:])
    if minute in ("*", "*/1") and other_specific:
        return False, (
            f"schedule minute field {minute!r} with a specific hour/day/month/"
            f"day-of-week would fire every minute of the scheduled window "
            f"(up to 60 firings per hour). Use a concrete minute (e.g. '0' "
            f"for top of hour). Full cron: {cleaned!r}"
        )
    m = re.match(r"^\*/([0-9]+)$", minute)
    if m:
        step = int(m.group(1))
        if step < 60 and other_specific:
            return False, (
                f"schedule fires every {step} minute(s) within a pinned "
                f"hour/day window — too frequent. Chores should fire at most "
                f"once per hour. Full cron: {cleaned!r}"
            )
    return True, ""


# ---------------------------------------------------------------------------
# Semantic-alignment validator (#478)
#
# The syntactic validator above only checks "is this a valid 5-field cron?"
# It cannot catch the case where Opus emits a sensible-looking cron that
# disagrees with the English description it just wrote in the same envelope:
#
#   description:  "Every day at 05:30 CET..."
#   cron:         "0 18 * * 0"      (Sunday 18:00 UTC = Monday 00:00 CET)
#                 ↑ wrong day AND wrong time
#
# This function parses regex-friendly cues out of the description (day-of-week
# words, "every day", "weekdays", "at HH:MM TZ") and compares them against
# the cron's day-of-week and minute/hour fields. When the description is
# vague ("regularly", "throughout the week") we skip the check rather than
# false-fail. Returns (True, "") on agreement / unknowable; (False, msg) on
# a hard contradiction.
# ---------------------------------------------------------------------------

# Day-of-week words → cron numeric value(s). Cron accepts both 0 and 7 for
# Sunday so we keep both in the acceptance set.
_WEEKDAY_WORDS: dict[str, set[int]] = {
    "sunday":    {0, 7},
    "sundays":   {0, 7},
    "sun":       {0, 7},
    "monday":    {1},
    "mondays":   {1},
    "mon":       {1},
    "tuesday":   {2},
    "tuesdays":  {2},
    "tue":       {2},
    "tues":      {2},
    "wednesday": {3},
    "wednesdays":{3},
    "wed":       {3},
    "weds":      {3},
    "thursday":  {4},
    "thursdays": {4},
    "thu":       {4},
    "thur":      {4},
    "thurs":     {4},
    "friday":    {5},
    "fridays":   {5},
    "fri":       {5},
    "saturday":  {6},
    "saturdays": {6},
    "sat":       {6},
}

# Phrases that mean "any day, daily cadence" — day-of-week MUST be wildcard.
_DAILY_PHRASES = (
    "every day",
    "each day",
    "every morning",
    "each morning",
    "every evening",
    "each evening",
    "every afternoon",
    "each afternoon",
    "every night",
    "each night",
    "daily",
    "nightly",
)

# Phrases that mean "weekdays only" → day-of-week == 1-5
_WEEKDAY_PHRASES = (
    "every weekday",
    "weekdays",
    "each weekday",
    "every business day",
    "business days",
    "workdays",
    "every workday",
)

# Phrases that mean "weekend only" → day-of-week == 0,6
_WEEKEND_PHRASES = (
    "every weekend",
    "weekends",
    "each weekend",
    "weekend mornings",
    "weekend evenings",
)

# Vague phrases — explicit no-day signals; skip the day check entirely.
_VAGUE_DAY_PHRASES = (
    "regularly",
    "periodically",
    "occasionally",
    "throughout the week",
    "whenever",
    "as needed",
    "from time to time",
    "now and then",
    "every so often",
)

# Time pattern matchers. We accept:
#   "at 05:30", "at 5:30am", "at 5 PM", "at 14:00", "at 9pm CET",
#   "at 18:00 UTC", "at 9 PM Budapest time"
# We DO NOT match bare numbers — "by 9" is too ambiguous.
_TIME_RE = re.compile(
    r"(?<![:\d])"                   # not preceded by digit/colon
    r"at\s+"
    r"(?P<hour>\d{1,2})"
    r"(?::(?P<minute>\d{2}))?"
    r"\s*"
    r"(?P<ampm>am|pm|AM|PM|a\.m\.|p\.m\.)?"
    r"(?:\s*(?P<tz>"
        r"UTC|GMT|"
        r"CET|CEST|EET|EEST|WET|WEST|"
        r"EST|EDT|CST|CDT|MST|MDT|PST|PDT|"
        r"AKST|AKDT|HST|"
        r"JST|KST|IST|AEST|AEDT|NZST|NZDT|"
        r"BST"
    r")(?![A-Za-z]))?",
    re.IGNORECASE,
)

# Recognised abbreviations → IANA zone we use for offset lookup. Only used
# when the description names a tz EXPLICITLY; otherwise we fall back to
# tenant_timezone.
_TZ_ABBREV_TO_IANA: dict[str, str] = {
    "utc": "UTC",
    "gmt": "UTC",
    "cet": "Europe/Paris",
    "cest": "Europe/Paris",
    "eet": "Europe/Bucharest",
    "eest": "Europe/Bucharest",
    "wet": "Europe/Lisbon",
    "west": "Europe/Lisbon",
    "est": "America/New_York",
    "edt": "America/New_York",
    "cst": "America/Chicago",
    "cdt": "America/Chicago",
    "mst": "America/Denver",
    "mdt": "America/Denver",
    "pst": "America/Los_Angeles",
    "pdt": "America/Los_Angeles",
    "akst": "America/Anchorage",
    "akdt": "America/Anchorage",
    "hst": "Pacific/Honolulu",
    "jst": "Asia/Tokyo",
    "kst": "Asia/Seoul",
    "ist": "Asia/Kolkata",
    "aest": "Australia/Sydney",
    "aedt": "Australia/Sydney",
    "nzst": "Pacific/Auckland",
    "nzdt": "Pacific/Auckland",
    "bst": "Europe/London",
}

# Multi-word regional phrases the LLM reaches for when it doesn't write a
# bare abbreviation. Match longest-first to avoid partial overlaps.
_TZ_PHRASE_TO_IANA: dict[str, str] = {
    "central european summer time": "Europe/Paris",
    "central european time":        "Europe/Paris",
    "eastern european summer time": "Europe/Bucharest",
    "eastern european time":        "Europe/Bucharest",
    "western european summer time": "Europe/Lisbon",
    "western european time":        "Europe/Lisbon",
    "british summer time":          "Europe/London",
    "greenwich mean time":          "UTC",
    "eastern daylight time":        "America/New_York",
    "eastern standard time":        "America/New_York",
    "eastern time":                 "America/New_York",
    "central daylight time":        "America/Chicago",
    "central standard time":        "America/Chicago",
    "central time":                 "America/Chicago",
    "mountain daylight time":       "America/Denver",
    "mountain standard time":       "America/Denver",
    "mountain time":                "America/Denver",
    "pacific daylight time":        "America/Los_Angeles",
    "pacific standard time":        "America/Los_Angeles",
    "pacific time":                 "America/Los_Angeles",
    "alaska time":                  "America/Anchorage",
    "hawaii time":                  "Pacific/Honolulu",
    "japan standard time":          "Asia/Tokyo",
    "korea standard time":          "Asia/Seoul",
    "india standard time":          "Asia/Kolkata",
    "australian eastern time":      "Australia/Sydney",
    "new zealand time":             "Pacific/Auckland",
}

# City / region names → IANA zone. Hit when the description writes
# "Budapest time" or "Friday at 2pm Budapest time" instead of a bare abbrev.
# Multi-word entries before single words because we iterate longest-first.
_TZ_NAME_TO_IANA: dict[str, str] = {
    "budapest":      "Europe/Budapest",
    "warsaw":        "Europe/Warsaw",
    "berlin":        "Europe/Berlin",
    "vienna":        "Europe/Vienna",
    "prague":        "Europe/Prague",
    "paris":         "Europe/Paris",
    "madrid":        "Europe/Madrid",
    "rome":          "Europe/Rome",
    "amsterdam":     "Europe/Amsterdam",
    "brussels":      "Europe/Brussels",
    "lisbon":        "Europe/Lisbon",
    "london":        "Europe/London",
    "dublin":        "Europe/Dublin",
    "athens":        "Europe/Athens",
    "bucharest":     "Europe/Bucharest",
    "helsinki":      "Europe/Helsinki",
    "stockholm":     "Europe/Stockholm",
    "oslo":          "Europe/Oslo",
    "copenhagen":    "Europe/Copenhagen",
    "moscow":        "Europe/Moscow",
    "istanbul":      "Europe/Istanbul",
    "dubai":         "Asia/Dubai",
    "singapore":     "Asia/Singapore",
    "tokyo":         "Asia/Tokyo",
    "seoul":         "Asia/Seoul",
    "hong kong":     "Asia/Hong_Kong",
    "shanghai":      "Asia/Shanghai",
    "beijing":       "Asia/Shanghai",
    "kolkata":       "Asia/Kolkata",
    "mumbai":        "Asia/Kolkata",
    "delhi":         "Asia/Kolkata",
    "sydney":        "Australia/Sydney",
    "melbourne":     "Australia/Melbourne",
    "auckland":      "Pacific/Auckland",
    "honolulu":      "Pacific/Honolulu",
    "anchorage":     "America/Anchorage",
    "los angeles":   "America/Los_Angeles",
    "san francisco": "America/Los_Angeles",
    "denver":        "America/Denver",
    "chicago":       "America/Chicago",
    "new york":      "America/New_York",
    "toronto":       "America/Toronto",
    "mexico city":   "America/Mexico_City",
    "sao paulo":     "America/Sao_Paulo",
    "buenos aires":  "America/Argentina/Buenos_Aires",
}


def _extract_description_timezone(description: str) -> str | None:
    """Find an IANA timezone hinted at anywhere in the description.

    The LLM that authors `user_facing_description` reaches for several
    different ways to talk about timezones depending on context:

      "Every day at 05:30 CET..."                    -> abbrev adjacent to time
      "Every Friday at 18:00 CET..."                 -> abbrev adjacent
      "Every Friday at 2pm Budapest time..."         -> city after time
      "Every Sunday at 18:00 (Budapest time, 16:00 UTC), this..."
                                                     -> city + sanity-check abbrev
      "Every weekday at 14:30 (Central European time)..."
                                                     -> regional phrase
      "Every Monday at 06:30 local time (Budapest, ~04:30 UTC)..."
                                                     -> city in parenthetical

    The validator (and the offline audit script) used to look only at the
    abbreviation immediately following the time, which meant any of the
    other forms silently fell back to `tenant_timezone`. On a tenant whose
    `TENANT_TIMEZONE` was UTC that produced "off by 2 hour" false positives
    on every chore Opus authored in CET / CEST. This helper consolidates
    the lookup so callers can prefer description-stated tz and only fall
    back to the tenant-level setting when no signal is present.

    Priority order (most specific first):

      1. Abbreviation adjacent to the time clause (the existing _TIME_RE
         tz group). Highest signal because the author tied the tz directly
         to the time.
      2. City / region name (e.g. "Budapest", "Warsaw"). The author named
         a place; that is unambiguous.
      3. Multi-word regional phrase (e.g. "Central European time").
      4. Any abbreviation anywhere in the description (e.g. a parenthetical
         "(Budapest time, 16:00 UTC)" sanity-check). Lowest signal because
         the abbreviation may be the converted UTC equivalent rather than
         the local time the cron is supposed to fire at.

    Returns None when no signal is found, in which case callers should
    fall back to the tenant-level timezone.
    """
    if not isinstance(description, str) or not description.strip():
        return None
    low = description.lower()

    # 1) Abbreviation adjacent to the time clause — strongest signal.
    time_match = _TIME_RE.search(description)
    if time_match:
        tz_token = time_match.group("tz")
        if tz_token:
            iana = _TZ_ABBREV_TO_IANA.get(tz_token.lower())
            if iana:
                return iana

    # 2) City / region name. Iterate longest-first so "new york" beats "york",
    # "hong kong" beats "kong", etc. Word-boundary on a per-token basis to
    # avoid matching e.g. "rome" inside "syndrome".
    for name in sorted(_TZ_NAME_TO_IANA, key=len, reverse=True):
        # Multi-word names need a literal space-separator search; the simple
        # word-boundary check still works because re.escape preserves spaces.
        if re.search(rf"\b{re.escape(name)}\b", low):
            return _TZ_NAME_TO_IANA[name]

    # 3) Multi-word regional phrase.
    for phrase in sorted(_TZ_PHRASE_TO_IANA, key=len, reverse=True):
        if phrase in low:
            return _TZ_PHRASE_TO_IANA[phrase]

    # 4) Lone abbreviation anywhere in the description.
    for abbrev, iana in _TZ_ABBREV_TO_IANA.items():
        if re.search(rf"\b{re.escape(abbrev)}\b", low):
            return iana

    return None


def _parse_cron_dow(cron_dow_field: str) -> set[int] | None:
    """Expand a cron day-of-week field into the set of integers it covers.

    Returns None for the wildcard '*' (meaning all days). Returns an empty
    set for an unparseable field (caller treats as "unknown — skip").
    """
    field = cron_dow_field.strip()
    if field == "*":
        return None
    days: set[int] = set()
    for part in field.split(","):
        part = part.strip()
        if not part:
            continue
        if part == "*":
            return None
        if "/" in part:
            base, _step = part.split("/", 1)
            try:
                step = int(_step)
            except ValueError:
                return set()
            if base == "*":
                base_lo, base_hi = 0, 7
            elif "-" in base:
                try:
                    base_lo, base_hi = (int(x) for x in base.split("-", 1))
                except ValueError:
                    return set()
            else:
                try:
                    base_lo = int(base)
                except ValueError:
                    return set()
                base_hi = 7
            days.update(range(base_lo, base_hi + 1, max(step, 1)))
            continue
        if "-" in part:
            try:
                lo, hi = (int(x) for x in part.split("-", 1))
            except ValueError:
                return set()
            days.update(range(lo, hi + 1))
            continue
        try:
            days.add(int(part))
        except ValueError:
            return set()
    return days


def _parse_cron_minute_hour(cron_minute: str, cron_hour: str) -> tuple[int, int] | None:
    """Best-effort extraction of a single (minute, hour) firing time from cron.

    Returns None if either field uses a range/step/list (in which case time
    comparison is ambiguous and the caller should skip the time check).
    """
    minute = cron_minute.strip()
    hour = cron_hour.strip()
    if any(c in minute for c in ",-/*") or any(c in hour for c in ",-/*"):
        return None
    try:
        return int(minute), int(hour)
    except ValueError:
        return None


def _description_implies_daily(description: str) -> bool:
    """True iff the description uses an unambiguous 'every day' phrase."""
    low = description.lower()
    return any(phrase in low for phrase in _DAILY_PHRASES)


def _description_implies_weekdays(description: str) -> bool:
    low = description.lower()
    return any(phrase in low for phrase in _WEEKDAY_PHRASES)


def _description_implies_weekend(description: str) -> bool:
    low = description.lower()
    return any(phrase in low for phrase in _WEEKEND_PHRASES)


def _description_is_vague_about_day(description: str) -> bool:
    low = description.lower()
    return any(phrase in low for phrase in _VAGUE_DAY_PHRASES)


def _description_named_days(description: str) -> set[int]:
    """Return the union of cron day-of-week numbers explicitly named.

    Empty set if the description doesn't name any day word. We use a word-
    boundary check so 'sunset' doesn't match 'sun'.
    """
    low = description.lower()
    found: set[int] = set()
    for word, days in _WEEKDAY_WORDS.items():
        if re.search(rf"\b{re.escape(word)}\b", low):
            found.update(days)
    return found


def _convert_local_to_utc(
    local_hour: int,
    local_minute: int,
    iana_zone: str,
) -> tuple[int, int] | None:
    """Convert a local clock time to UTC using a fixed reference date.

    We use today's date in the named zone for the offset lookup. DST shifts
    twice a year so we tolerate ±1 hour in the comparison, but anchoring on
    the current date keeps the answer right for ~6 months at a time.

    Returns None if the zone name is unrecognised.
    """
    if ZoneInfo is None:
        return None
    try:
        zone = ZoneInfo(iana_zone)
    except ZoneInfoNotFoundError:
        return None
    except Exception:
        return None
    from datetime import datetime
    now_local = datetime.now(zone)
    candidate = now_local.replace(
        hour=local_hour,
        minute=local_minute,
        second=0,
        microsecond=0,
    )
    utc = candidate.astimezone(ZoneInfo("UTC"))
    return utc.minute, utc.hour


def _validate_cron_matches_description(
    cron: str,
    description: str,
    tenant_timezone: str = "UTC",
) -> tuple[bool, str]:
    """Compare a cron expression against the English `user_facing_description`.

    The validator looks for two classes of disagreement:

      1. **Day-of-week mismatch**. If the description says "every day" /
         "daily" / "each morning", the cron's day-of-week field MUST be
         wildcard (`*`). If the description names a specific day
         ("every Friday", "Mondays at 9"), the cron's day-of-week MUST
         contain that day's numeric value (Mon=1 … Sun=0 OR 7). Same for
         "weekdays" (1-5) and "weekends" (0,6).

      2. **Time mismatch**. If the description gives a time ("at 05:30 CET",
         "at 9pm"), the cron's (minute, hour) must match within ±1 hour of
         the stated time after converting from the description's named
         timezone (or `tenant_timezone` if the description doesn't name one)
         to UTC. The ±1 hour tolerance covers DST.

    Both checks are skipped when the description is too vague to anchor on
    ("regularly", "periodically", "throughout the week"). We err on the
    side of NOT flagging an ambiguous description — false positives are
    worse than false negatives because they trigger an Opus retry burn.

    Args:
        cron: A 5-field UTC cron expression. Must already pass
            `_validate_cron_expression` (caller's responsibility — this
            function focuses on semantic alignment, not syntax).
        description: The `user_facing_description` Opus emitted in the same
            envelope as `cron`.
        tenant_timezone: IANA zone name for the tenant (e.g. "Europe/Budapest"),
            used when the description states a time but no timezone. Defaults
            to UTC so a description like "at 09:00" with cron `0 9 * * *`
            passes.

    Returns:
        (True, "") on agreement or insufficient signal.
        (False, message) when the cron contradicts the description.
    """
    if not isinstance(cron, str) or not cron.strip():
        return True, ""
    if not isinstance(description, str) or not description.strip():
        return True, ""

    parts = cron.strip().split()
    if len(parts) != 5:
        # Syntactic problem — leave it to _validate_cron_expression
        return True, ""

    cron_minute_field, cron_hour_field, _dom, _mon, cron_dow_field = parts
    cron_dow_set = _parse_cron_dow(cron_dow_field)

    # ----- DAY-OF-WEEK CHECK -----------------------------------------------
    is_daily = _description_implies_daily(description)
    is_weekdays = _description_implies_weekdays(description)
    is_weekend = _description_implies_weekend(description)
    named_days = _description_named_days(description)
    is_vague = _description_is_vague_about_day(description)

    # "every day" / "daily" / "each morning" → cron MUST be wildcard
    if is_daily and not is_weekdays and not is_weekend and not named_days:
        if cron_dow_set is not None:
            return False, (
                f"description says daily ('every day' / 'daily' / 'each morning') "
                f"but cron `{cron.strip()}` has day-of-week `{cron_dow_field}` — "
                f"day-of-week must be `*` for daily chores."
            )

    # "weekdays" → cron must be 1-5 (or contain 1,2,3,4,5)
    elif is_weekdays and not named_days:
        required = {1, 2, 3, 4, 5}
        if cron_dow_set is None or not required.issubset(cron_dow_set):
            return False, (
                f"description says weekdays but cron `{cron.strip()}` "
                f"day-of-week `{cron_dow_field}` does not cover Mon-Fri (1-5). "
                f"Use `1-5` or `1,2,3,4,5`."
            )

    # "weekends" → cron must contain 0 (or 7) and 6
    elif is_weekend and not named_days:
        if cron_dow_set is None:
            return False, (
                f"description says weekends but cron `{cron.strip()}` "
                f"day-of-week is `*` (fires every day). Use `0,6` or `6,0`."
            )
        has_sat = 6 in cron_dow_set
        has_sun = (0 in cron_dow_set) or (7 in cron_dow_set)
        if not (has_sat and has_sun):
            return False, (
                f"description says weekends but cron `{cron.strip()}` "
                f"day-of-week `{cron_dow_field}` doesn't cover both Saturday "
                f"and Sunday. Use `0,6` or `6,0`."
            )

    # Specific day(s) named ("every Friday", "Mondays") — cron must include them
    elif named_days:
        if cron_dow_set is None:
            return False, (
                f"description names specific day(s) {sorted(named_days)} but cron "
                f"`{cron.strip()}` day-of-week is `*` (fires every day, including "
                f"days the description didn't promise)."
            )
        normalized_cron = set(cron_dow_set)
        if 7 in normalized_cron:
            normalized_cron.add(0)
        if 0 in normalized_cron:
            normalized_cron.add(7)
        if not (named_days & normalized_cron):
            return False, (
                f"description names day(s) {sorted(named_days)} but cron "
                f"`{cron.strip()}` day-of-week `{cron_dow_field}` covers "
                f"{sorted(cron_dow_set)} — no overlap. Update cron to include "
                f"the named day(s)."
            )

    elif is_vague:
        pass

    # ----- TIME CHECK ------------------------------------------------------
    time_match = _TIME_RE.search(description)
    if time_match:
        try:
            hour = int(time_match.group("hour"))
            minute = int(time_match.group("minute") or 0)
        except (TypeError, ValueError):
            return True, ""

        ampm_raw = time_match.group("ampm")
        ampm = ampm_raw.lower().replace(".", "") if ampm_raw else None
        if ampm in ("pm", "p m") and hour < 12:
            hour += 12
        elif ampm in ("am", "a m") and hour == 12:
            hour = 0

        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            return True, ""

        tz_token_raw = time_match.group("tz")
        # Prefer description-stated tz (anywhere in the text — "Budapest",
        # "Central European time", "(Budapest time, 16:00 UTC)") over the
        # tenant fallback. Only when the description gives no signal at all
        # do we use tenant_timezone. See _extract_description_timezone for
        # the priority rules.
        iana_from_desc = _extract_description_timezone(description)
        if iana_from_desc:
            iana = iana_from_desc
        else:
            iana = tenant_timezone or "UTC"

        utc_tuple = _convert_local_to_utc(hour, minute, iana)
        if utc_tuple is None:
            expected_minute, expected_hour = minute, hour
        else:
            expected_minute, expected_hour = utc_tuple

        cron_time = _parse_cron_minute_hour(cron_minute_field, cron_hour_field)
        if cron_time is None:
            return True, ""

        actual_minute, actual_hour = cron_time

        # ±1 hour tolerance for DST drift
        hour_diff = (actual_hour - expected_hour) % 24
        if hour_diff > 12:
            hour_diff = 24 - hour_diff
        if hour_diff > 1:
            return False, (
                f"description says time {hour:02d}:{minute:02d} "
                f"({tz_token_raw or iana}) which is ~{expected_hour:02d}:"
                f"{expected_minute:02d} UTC but cron `{cron.strip()}` fires at "
                f"{actual_hour:02d}:{actual_minute:02d} UTC — off by "
                f"{hour_diff} hour(s). Recompute the UTC equivalent of the "
                f"local time and update minute/hour fields."
            )

    return True, ""


def _autocorrect_cron_dow_for_description(
    cron: str,
    description: str,
) -> str | None:
    """Coerce a wildcard cron day-of-week to match an unambiguous description.

    BUG #181: Opus reliably emits a sensible minute/hour but leaves the
    day-of-week as `*` even when its own `user_facing_description` clearly
    promises "weekdays" / "weekends" / a named day. The semantic validator
    (`_validate_cron_matches_description`) then rejects the envelope, the
    generator re-rolls the LLM, and the chores stage hits StartToClose. Most
    of these are trivially fixable: the firing time is right, only the DOW
    field is too broad.

    This deterministically fixes that one class — and ONLY that class:
      * fires only when the cron's DOW field is the wildcard `*` (we never
        overwrite an explicit DOW the LLM chose — that stays the validator's
        call), and
      * only when the description unambiguously implies a DOW restriction
        (weekdays → `1-5`, weekends → `0,6`, a named day → that day).

    Returns the corrected 5-field cron string, or None when there is nothing
    safe to correct (daily/vague descriptions, non-wildcard DOW, unparseable
    cron, or a named-day set we can't render). The minute/hour/day-of-month/
    month fields are preserved verbatim; only the DOW field is rewritten.
    """
    if not isinstance(cron, str) or not isinstance(description, str):
        return None
    parts = cron.strip().split()
    if len(parts) != 5:
        return None
    minute_f, hour_f, dom_f, mon_f, dow_f = parts
    # Only fill in a wildcard DOW; never override an explicit choice.
    if dow_f.strip() != "*":
        return None

    is_daily = _description_implies_daily(description)
    is_weekdays = _description_implies_weekdays(description)
    is_weekend = _description_implies_weekend(description)
    named_days = _description_named_days(description)

    new_dow: str | None = None
    # Mirror the precedence in _validate_cron_matches_description: a daily
    # phrase wants the wildcard we already have, so leave it alone.
    if is_weekdays and not named_days:
        new_dow = "1-5"
    elif is_weekend and not named_days:
        new_dow = "0,6"
    elif named_days and not is_daily:
        # Render the named days as a sorted comma list, normalising the
        # 0/7 Sunday duplication down to a single 0.
        normalized = {0 if d == 7 else d for d in named_days}
        if not normalized:
            return None
        new_dow = ",".join(str(d) for d in sorted(normalized))

    if new_dow is None:
        return None
    return f"{minute_f} {hour_f} {dom_f} {mon_f} {new_dow}"


def _resolve_tenant_timezone() -> str:
    """Return the tenant's IANA timezone for description-cron comparison.

    Reads the env var directly so this stays usable from the audit script
    (which doesn't go through `load_config()`). Defaults to UTC when unset.
    """
    return os.environ.get("TENANT_TIMEZONE", "UTC") or "UTC"


def _validate_envelope(parsed: dict[str, Any]) -> tuple[bool, str]:
    """Validate that the parsed Opus response has the required envelope keys.

    Returns (ok, error_message). Empty error_message on success.
    """
    if not isinstance(parsed, dict):
        return False, f"response is not a dict: {type(parsed).__name__}"
    module_name = parsed.get("module_name")
    workflow_class_name = parsed.get("workflow_class_name")
    python_source = parsed.get("python_source")
    user_facing_description = parsed.get("user_facing_description")
    schedule = parsed.get("schedule")

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

    # C.1: user_facing_description is required for the new Chores UI.
    # We accept missing field for backwards compat but emit a warning,
    # so already-deployed templates from before C.1 still pass validation
    # (the calling code substitutes a default).
    if user_facing_description is not None:
        if not isinstance(user_facing_description, str):
            return False, "user_facing_description must be a string"
        ufd = user_facing_description.strip()
        if ufd:
            if len(ufd) < _USER_FACING_MIN_CHARS:
                return False, (
                    f"user_facing_description too short ({len(ufd)} chars, "
                    f"minimum {_USER_FACING_MIN_CHARS})"
                )
            if len(ufd) > _USER_FACING_MAX_CHARS:
                return False, (
                    f"user_facing_description too long ({len(ufd)} chars, "
                    f"maximum {_USER_FACING_MAX_CHARS})"
                )

    # schedule: required going forward, but tolerated as missing for
    # backwards compat — the caller in assign_chores._build_generated_chore_spec
    # falls back to _derive_chore_schedule if this field is absent. When it
    # IS present, it must be a valid 5-field UTC cron; otherwise we reject
    # with precise feedback so Opus can fix the format on retry.
    if schedule is not None:
        ok, err = _validate_cron_expression(schedule)
        if not ok:
            return False, f"schedule invalid: {err}"
        # #478 — semantic alignment between cron and user_facing_description.
        # Only run this when both fields are present; the syntactic check
        # above is sufficient for backwards-compat envelopes.
        if isinstance(user_facing_description, str) and user_facing_description.strip():
            tz = _resolve_tenant_timezone()
            ok, err = _validate_cron_matches_description(
                schedule,
                user_facing_description,
                tenant_timezone=tz,
            )
            if not ok:
                return False, f"schedule does not match user_facing_description: {err}"

    # Phase 2 metadata fields: display_name, display_body, category.
    # All optional — pre-Phase-2 envelopes pass without them. When the
    # LLM emits them, validate shape so the principal-facing detail
    # page gets coherent values rather than half-broken markdown.
    display_name = parsed.get("display_name")
    if display_name is not None:
        if not isinstance(display_name, str):
            return False, "display_name must be a string"
        dn = display_name.strip()
        if dn and len(dn) > 60:
            return False, f"display_name too long ({len(dn)} chars, max 60)"

    display_body = parsed.get("display_body")
    if display_body is not None:
        if not isinstance(display_body, str):
            return False, "display_body must be a string"
        db = display_body.strip()
        if db:
            if len(db) < 40:
                return False, f"display_body too short ({len(db)} chars, min 40)"
            if len(db) > 2000:
                return False, f"display_body too long ({len(db)} chars, max 2000)"

    category = parsed.get("category")
    if category is not None:
        if not isinstance(category, str):
            return False, "category must be a string"
        cat = category.strip().lower()
        valid_categories = {
            "briefing", "digest", "watch",
            "context-build", "prefetch", "maintenance",
        }
        if cat and cat not in valid_categories:
            return False, (
                f"category {cat!r} not one of {sorted(valid_categories)}"
            )

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

        # BUG #181: before validating, deterministically fix the most common
        # cron-vs-description mismatch — a wildcard day-of-week when the
        # description clearly says weekdays/weekends/a named day. This avoids
        # an LLM re-roll (and the StartToClose timeout it caused) for the
        # trivially-correctable case. Anything the autocorrect can't fix
        # (e.g. a wrong firing HOUR) still falls through to the validator and
        # the bounded retry loop below, so an irreparable chore is skipped
        # rather than looped.
        _sched = parsed.get("schedule")
        if isinstance(_sched, str) and _sched.strip():
            _ufd = parsed.get("user_facing_description")
            if isinstance(_ufd, str) and _ufd.strip():
                _fixed = _autocorrect_cron_dow_for_description(_sched, _ufd)
                if _fixed is not None and _fixed != _sched.strip():
                    logger.info(
                        "chore_generation: autocorrected cron DOW %r -> %r "
                        "to match description",
                        _sched, _fixed,
                    )
                    parsed["schedule"] = _fixed

        ok, validation_err = _validate_envelope(parsed)
        if not ok:
            logger.error("chore_generation: envelope validation failed: %s", validation_err)
            last_error = f"envelope validation: {validation_err}"
            continue

        # Static structural validation of the python_source. This is the
        # SAME check that runs in assign_chores._generate_chore_from_opportunity
        # (Phase 2) and in the worker's load_user_chore_templates() startup
        # scan. Running it here gives us an early re-roll: when Opus emits
        # something the static validator will reject (e.g. the tenant-c
        # import-ordering bug — `with workflow.unsafe.imports_passed_through():`
        # before `from temporalio import workflow`), we feed the violation
        # back into the next prompt attempt instead of waiting for the
        # downstream phase to fail and abandoning the opportunity.
        static_result = validate_template_source(parsed["python_source"])
        if not static_result.ok:
            preview = "; ".join(static_result.violations[:3])
            logger.error(
                "chore_generation: static validation failed on attempt %d: %s",
                attempt, preview,
            )
            last_error = (
                "python_source failed static validation. Fix the following "
                "and re-emit valid Python: " + preview
            )
            continue

        logger.info(
            "chore_generation: generated %s (%d chars) in %d attempt(s)",
            parsed["workflow_class_name"],
            len(parsed["python_source"]),
            attempt,
        )
        # C.1: pass through user_facing_description if present, else default
        # to a generic explanation tied to the module name. Backwards-compat
        # path for envelopes generated before C.1 shipped.
        ufd = parsed.get("user_facing_description", "") or ""
        ufd = ufd.strip()
        if not ufd:
            ufd = (
                f"Generated chore '{parsed['module_name']}'. "
                "No user-facing description was emitted by the generator — "
                "edit this chore to add one."
            )

        # Schedule: pass through the cron string if the envelope had one.
        # The validator already checked its shape in _validate_envelope.
        # If missing, leave as empty string — the caller falls back to
        # _derive_chore_schedule (pre-fix behavior).
        schedule = parsed.get("schedule", "") or ""
        schedule = schedule.strip() if isinstance(schedule, str) else ""

        return {
            "module_name": parsed["module_name"],
            "workflow_class_name": parsed["workflow_class_name"],
            "python_source": parsed["python_source"],
            "user_facing_description": ufd,
            "schedule": schedule,
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
            "ok": bool,               # True ONLY on a confirmed (200) restart
            "status": str,            # "restarted" | "in_progress" | "failed"
            "in_progress": bool,      # True when indeterminate (429/connect)
            "status_code": int | None,
            "response_body": str,     # first 500 chars
            "duration_seconds": float,
            "error": str,             # on failure / indeterminate
        }

    Note: because this activity KILLS its own worker, the HTTP response may
    not come back before the process dies. That ConnectError — and a 429 from
    the ctrl-api rate limiter (30-second window, S4-2) — are *indeterminate*,
    not confirmed successes (#S2-2): they report ``status="in_progress"`` with
    ``ok=False`` so a genuine restart failure surfaces and the schedule-vs-
    register race (S2-1) stays detectable, instead of being masked as success.
    """
    import httpx  # local import — keeps worker startup fast

    activity.heartbeat("restart_learn_worker: calling ctrl-api")

    token = _resolve_ctrl_api_token()
    if not token:
        return {
            "ok": False,
            "status": "failed",
            "in_progress": False,
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
        # The ctrl-api may have killed us before the HTTP response came back —
        # OR ctrl-api is genuinely unreachable. We CANNOT tell the two apart
        # here, so this is indeterminate, not a confirmed success (#S2-2). Mark
        # it in_progress (ok=False) so a real outage isn't masked; a follow-up
        # check / retry on the restarted worker confirms the actual outcome.
        logger.info(
            "restart_learn_worker: connect error (restart may be in flight, or ctrl-api unreachable): %s",
            exc,
        )
        return {
            "ok": False,
            "status": "in_progress",
            "in_progress": True,
            "status_code": None,
            "response_body": "",
            "duration_seconds": time.monotonic() - started,
            "error": f"ConnectError: {exc}",
            "note": "connection dropped during restart — outcome unconfirmed",
        }
    except Exception as exc:
        logger.error("restart_learn_worker: unexpected error: %s", exc)
        return {
            "ok": False,
            "status": "failed",
            "in_progress": False,
            "status_code": None,
            "response_body": "",
            "duration_seconds": time.monotonic() - started,
            "error": f"{type(exc).__name__}: {exc}",
        }

    duration = time.monotonic() - started
    body_snippet = resp.text[:500] if resp.text else ""

    # 200 is the only CONFIRMED restart. A 429 means the ctrl-api rate limiter
    # rejected us because a restart happened in the last 30s — a restart is
    # underway, but THIS call did not perform/confirm it, so it is in_progress
    # (ok=False), not success (#S2-2). Reporting 429 as success was how a stuck
    # retry storm looked green while chores stayed unregistered (S2-1).
    if resp.status_code == 200:
        logger.info(
            "restart_learn_worker: ctrl-api confirmed restart 200 (%.2fs)", duration,
        )
        return {
            "ok": True,
            "status": "restarted",
            "in_progress": False,
            "status_code": 200,
            "response_body": body_snippet,
            "duration_seconds": duration,
        }

    if resp.status_code == 429:
        logger.info(
            "restart_learn_worker: ctrl-api 429 rate-limited — restart underway "
            "elsewhere, outcome unconfirmed (%.2fs)", duration,
        )
        return {
            "ok": False,
            "status": "in_progress",
            "in_progress": True,
            "status_code": 429,
            "response_body": body_snippet,
            "duration_seconds": duration,
            "error": "rate-limited (429) — restart in progress, unconfirmed",
        }

    logger.error(
        "restart_learn_worker: unexpected status %d: %s",
        resp.status_code, body_snippet,
    )
    return {
        "ok": False,
        "status": "failed",
        "in_progress": False,
        "status_code": resp.status_code,
        "response_body": body_snippet,
        "duration_seconds": duration,
        "error": f"unexpected status {resp.status_code}",
    }
