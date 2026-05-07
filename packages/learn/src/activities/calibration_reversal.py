"""Reversal-driven calibration (T6.7.5).

Watches for new reversal records under the vault and converts each one
into a negative-feedback signal against the source-types that
contributed to the original Steward action. This closes the
calibration feedback loop that was opened by ``apply_state_change`` —
positive feedback (no-undo) flows through ``_update_calibration``
naturally, and now reversals do too, but via a distinct
``negative_signal=True`` path that bypasses the EMA smoothing.

Watched paths
-------------
We list two reversal-record kinds via the ctrl-api glob search:

  * ``event/steward-action-reversed-*.md`` — created by ctrl-api when
    Sir clicks Undo on a dashboard ``event/steward-action-*.md`` audit
    record.

  * ``event/signal-action-reversed-*.md`` — reserved for the
    forthcoming signal-router undo path (T6.4.x). Glob is registered
    today so the activity quietly ignores zero matches until that path
    starts emitting records.

Per-record contract
-------------------

  1. Skip if the reversal path already lives in the persistence
     cache's ``processed`` block.
  2. Read the reversal frontmatter via ctrl-api. Resolve the original
     action it ``reverses`` AND the ``target`` task whose
     ``signal_sources`` we'll touch.
  3. Derive the set of source-types that contributed to the original
     action — preferring the original action's
     ``signals_summary.sources`` list, falling back to source-name
     prefixes parsed from the target task's ``signal_sources`` block
     when the original isn't readable.
  4. Load the source-type calibration block from the persistence
     cache, hand it to ``_update_calibration`` with
     ``negative_signal=True``, write the new block back.
  5. Mark the reversal path processed in the cache.

Cache shape::

    {
      "calibration": [
        {
          "name": "signal-source:gmail",
          "confidence": 0.4,
          "negative_count": 3,
          "last_negative_at": "2026-05-06T08:30:00+00:00",
          "calibration_status": "live",
          "tick_count": 0,
          "signal_count": 0,
          "low_confidence_streak": 0
        },
        ...
      ],
      "processed": {
        "event/steward-action-reversed-2026-05-06T...md": {
          "processed_at": "2026-05-06T08:31:12+00:00",
          "applied_to": ["signal-source:gmail", "signal-source:sure"]
        },
        ...
      }
    }

Idempotency: the ``processed`` block is consulted first, so re-running
the activity on the same vault state is a cheap no-op. Crash-safe:
each cache write is atomic (``tmp + os.replace``).

Concurrency: a single Temporal worker drives this activity end to end,
so there's no read-modify-write race. If two workers ever ran, the
last-writer-wins semantics on ``os.replace`` would at worst lose one
processing record — the next tick would replay it, with only the
already-applied confidence drop landing twice; this is the only
per-source guarantee the activity is allowed to break, and the
worst-case outcome (a -0.2 drop instead of -0.1) is bounded and
self-healing as confidence climbs back via positive feedback.

Gating: ``STEWARD_REVERSAL_CALIBRATION_ENABLED`` must be ``true`` for
the activity body to do real work. Default ``false`` until the soak
window passes. The schedule that triggers this workflow is also gated
on the same env at registration time so a fully-disabled tenant pays
zero Temporal cost.
"""
from __future__ import annotations

import logging
from typing import Any

from temporalio import activity

logger = logging.getLogger("alfred-learn")


# Persistence cache lives next to ``rate-guard.json`` /
# ``signal-task-creation.json`` under alfred-learn's writable scratch
# dir. Never put this under the vault — it's internal bookkeeping.
CACHE_PATH = "/alfred-data/state/steward/reversal-calibration.json"

# Glob patterns we scan via ctrl-api. The signal-action-reversed glob
# is registered today and silently matches zero records until the
# signal-router undo path (T6.4.x) starts emitting them.
REVERSAL_GLOBS = (
    "event/steward-action-reversed-*.md",
    "event/signal-action-reversed-*.md",
)

# Hard cap on entries kept in the ``processed`` block before we trim
# oldest-first. Reversals are rare (handful per day on a saturated
# tenant); 50K is a comfortable ceiling that bounds disk + parse cost.
PROCESSED_CACHE_MAX_ENTRIES = 50_000

# Env gate. Default OFF — flip to ``true`` once smoke tests confirm
# the per-source confidence drop is landing where expected.
ENV_FLAG = "STEWARD_REVERSAL_CALIBRATION_ENABLED"


def _flag_enabled() -> bool:
    """Read ``STEWARD_REVERSAL_CALIBRATION_ENABLED`` at activity-invocation time.

    Re-checked per call (NOT cached) so flipping the env without a
    container restart still takes effect. Same pattern as the other
    Phase 6 env gates — see ``signal_router`` /
    ``stream_event_purge``.
    """
    import os
    return os.environ.get(ENV_FLAG, "").strip().lower() in (
        "true", "1", "yes",
    )


def _source_type_from_name(name: str) -> str:
    """Extract the source-type prefix from a fully-qualified source name.

    Maps full source names to the bucket used as the calibration key:

        ``vault:record:matter/foo.md``  -> ``vault:record``
        ``gmail:label:INBOX``            -> ``gmail``
        ``sure:account:1234``            -> ``sure``
        ``ctrl-api:stream:omi-audio``    -> ``ctrl-api:stream``
        ``signal:openclaw-chat``         -> ``signal:openclaw-chat``
        ``smoke_test``                   -> ``smoke_test``

    The source-name conventions are owned by the four
    ``gather_signals_*`` activities + ``apply_state_change``. The
    extraction rule is:

      * If the name contains ``:``, take everything up to the LAST
        segment that doesn't look like a parameter (heuristic: the
        prefix is the longest leading slice that matches a known
        bucket; otherwise just everything up to the first ``:``).
      * Otherwise, the name IS the type (covers smoke-test /
        synthetic-source names).
    """
    if not isinstance(name, str):
        return ""
    s = name.strip()
    if not s:
        return ""
    # Known multi-segment buckets first — order matters because
    # "signal:openclaw-chat" should match the longer bucket form.
    KNOWN_PREFIXES = (
        "vault:record",
        "ctrl-api:stream",
    )
    for p in KNOWN_PREFIXES:
        if s == p or s.startswith(p + ":"):
            return p
    if ":" in s:
        return s.split(":", 1)[0]
    return s


def _calibration_key(source_type: str) -> str:
    """Compose the per-source-type calibration key.

    Spec says: ``signal-source:<source_type>``. We normalize so
    ``vault:record`` becomes ``signal-source:vault:record`` (still
    unambiguous because ``signal-source:`` is a unique prefix).
    """
    return f"signal-source:{source_type}"


# ---------------------------------------------------------------------------
# Cache read/write — atomic, idempotent
# ---------------------------------------------------------------------------

def _load_cache() -> dict[str, Any]:
    """Load the persistence cache; defensive on every failure mode.

    Returns the empty default shape on FileNotFoundError /
    JSONDecodeError / OSError so the activity can always proceed —
    losing the cache means we re-process old reversals (idempotent
    side effect), not that we crash.
    """
    import json
    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"calibration": [], "processed": {}}
        # Tolerate partial caches — coerce missing keys to defaults.
        if not isinstance(data.get("calibration"), list):
            data["calibration"] = []
        if not isinstance(data.get("processed"), dict):
            data["processed"] = {}
        return data
    except FileNotFoundError:
        return {"calibration": [], "processed": {}}
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "calibration_reversal._load_cache: corrupt cache at %s — "
            "starting fresh err=%s",
            CACHE_PATH, exc,
        )
        return {"calibration": [], "processed": {}}


def _save_cache(data: dict[str, Any]) -> None:
    """Atomic write — tmp + os.replace.

    Trim ``processed`` to ``PROCESSED_CACHE_MAX_ENTRIES`` newest
    entries by ``processed_at`` if oversized. Best-effort trim;
    failures are swallowed.
    """
    import json
    import os

    try:
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    except OSError as exc:
        logger.warning(
            "calibration_reversal._save_cache: mkdir failed err=%s", exc,
        )
        return

    proc = data.get("processed") or {}
    if isinstance(proc, dict) and len(proc) > PROCESSED_CACHE_MAX_ENTRIES:
        try:
            sorted_items = sorted(
                proc.items(),
                key=lambda kv: (
                    kv[1].get("processed_at", "")
                    if isinstance(kv[1], dict)
                    else ""
                ),
                reverse=True,
            )
            data["processed"] = dict(sorted_items[:PROCESSED_CACHE_MAX_ENTRIES])
        except Exception:  # noqa: BLE001
            # Best-effort; oversized cache is harmless.
            pass

    tmp = CACHE_PATH + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=True, default=str)
        os.replace(tmp, CACHE_PATH)
    except OSError as exc:
        logger.warning(
            "calibration_reversal._save_cache: write failed err=%s", exc,
        )


def _ensure_calibration_entry(
    cal: list[dict[str, Any]],
    key: str,
) -> dict[str, Any]:
    """Find-or-create the entry for ``key`` in the calibration list.

    Mutates ``cal`` in place when creating a new entry. Returns the
    entry (mutable reference) so the caller can update fields and have
    them persist.
    """
    for entry in cal:
        if isinstance(entry, dict) and entry.get("name") == key:
            return entry
    new_entry = {
        "name": key,
        # Mid-confidence default mirrors _update_calibration's prior_conf
        # default — a brand-new source-type starts neutral.
        "confidence": 0.5,
        "calibration_status": "live",
        "tick_count": 0,
        "signal_count": 0,
        "low_confidence_streak": 0,
    }
    cal.append(new_entry)
    return new_entry


# ---------------------------------------------------------------------------
# Source-type derivation from a reversal record
# ---------------------------------------------------------------------------

async def _derive_source_types(
    client: Any,
    reversal_fm: dict[str, Any],
) -> set[str]:
    """Identify the source-types that contributed to the reversed action.

    Resolution order (first non-empty wins):

      1. Reversal record's own ``signal_sources`` block (forward-compat
         — we honour it if present even though today's reversal records
         don't carry one).
      2. Original action's ``signals_summary.sources`` list — read via
         ``client.read_record(reverses)``.
      3. Target task's ``signal_sources`` block — read via
         ``client.read_record(target)``. Last-resort path; the source
         names there are full-qualified (e.g.
         ``vault:record:matter/inbox.md``) so we extract the prefix.

    Returns an empty set when none of those resolutions yield anything
    actionable. Callers treat that as "no calibration to apply" rather
    than as an error.
    """
    types: set[str] = set()

    # 1. Forward-compat — direct on the reversal record.
    direct = reversal_fm.get("signal_sources")
    if isinstance(direct, list):
        for s in direct:
            if isinstance(s, dict):
                t = str(s.get("source_type") or "").strip()
                if t:
                    types.add(t)
                    continue
                # Fall through to name-prefix derivation.
                name = str(s.get("name") or "").strip()
                if name:
                    derived = _source_type_from_name(name)
                    if derived:
                        types.add(derived)
    if types:
        return types

    # 2. Walk back to the original action.
    original_path = str(reversal_fm.get("reverses") or "").strip()
    if original_path:
        try:
            original = await client.read_record(original_path)
        except Exception as exc:  # noqa: BLE001
            logger.info(
                "calibration_reversal._derive_source_types: "
                "read original failed path=%s err=%s",
                original_path, exc,
            )
            original = None
        if isinstance(original, dict):
            ofm = original.get("frontmatter")
            if isinstance(ofm, dict):
                summary = ofm.get("signals_summary")
                if isinstance(summary, dict):
                    raw = summary.get("sources") or []
                    if isinstance(raw, list):
                        for entry in raw:
                            t = str(entry or "").strip()
                            if not t:
                                continue
                            # signals_summary.sources entries are
                            # already source-types (e.g. "gmail",
                            # "smoke_test", "vault:record"). Pass
                            # through _source_type_from_name to
                            # normalize edge cases.
                            derived = _source_type_from_name(t)
                            if derived:
                                types.add(derived)
    if types:
        return types

    # 3. Last-resort — target task's signal_sources block.
    target_path = str(reversal_fm.get("target") or "").strip()
    if target_path:
        try:
            target = await client.read_record(target_path)
        except Exception as exc:  # noqa: BLE001
            logger.info(
                "calibration_reversal._derive_source_types: "
                "read target failed path=%s err=%s",
                target_path, exc,
            )
            target = None
        if isinstance(target, dict):
            tfm = target.get("frontmatter")
            if isinstance(tfm, dict):
                blk = tfm.get("signal_sources") or []
                if isinstance(blk, list):
                    for s in blk:
                        if isinstance(s, dict):
                            name = str(s.get("name") or "").strip()
                            if name:
                                derived = _source_type_from_name(name)
                                if derived:
                                    types.add(derived)

    return types


# ---------------------------------------------------------------------------
# Activity: process_reversals_for_calibration
# ---------------------------------------------------------------------------

@activity.defn
async def process_reversals_for_calibration() -> dict[str, Any]:
    """Process new reversal records and apply negative-feedback calibration.

    Idempotent: relies on the persistence cache's ``processed`` map.
    Crash-safe: cache writes are atomic.

    Returns a summary dict::

        {
          "processed":        <int>,   # reversal records consumed this run
          "skipped":          <int>,   # already-cached reversal records
          "errors":           <int>,
          "error_messages":   [<str>, ...],   # capped at 10 entries
          "applied_keys":     [<str>, ...],   # union of cal keys touched
        }
    """
    # Lazy imports — keep workflow-sandbox happy and respect the
    # alfred-learn convention that heavy deps live inside activity
    # bodies.
    import os

    import httpx
    from src.activities.steward import _update_calibration
    from src.config import load_config
    from src.utils.vault_client import VaultClient

    summary: dict[str, Any] = {
        "processed": 0,
        "skipped": 0,
        "errors": 0,
        "error_messages": [],
        "applied_keys": [],
    }

    if not _flag_enabled():
        logger.info(
            "calibration_reversal: %s not set — no-op",
            ENV_FLAG,
        )
        return summary

    cfg = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    # 1. Discover all reversal records via the ctrl-api search/glob
    # endpoint. Two globs (steward-action-reversed-*, signal-action-
    # reversed-*) — the second matches zero today; leaving it
    # registered means T6.4.x's signal-router undo path lights up
    # automatically once it starts emitting records.
    discovered: list[str] = []
    try:
        async with httpx.AsyncClient(
            base_url=cfg.alfred_ctrl_url,
            timeout=60.0,
            headers=headers,
        ) as ctrl:
            for glob in REVERSAL_GLOBS:
                try:
                    resp = await ctrl.get(
                        "/api/v1/vault/search",
                        params={"glob": glob, "limit": 500},
                    )
                    resp.raise_for_status()
                except httpx.HTTPError as exc:
                    summary["errors"] += 1
                    summary["error_messages"].append(
                        f"glob {glob}: {exc}"[:500]
                    )
                    continue
                payload = resp.json() or {}
                results = payload.get("results") or []
                if not isinstance(results, list):
                    continue
                for r in results:
                    if not isinstance(r, dict):
                        continue
                    p = str(r.get("path") or "").strip()
                    if p:
                        discovered.append(p)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "calibration_reversal: glob discovery failed err=%s", exc,
        )
        summary["errors"] += 1
        summary["error_messages"].append(f"discover: {exc}"[:500])
        return summary

    if not discovered:
        logger.info("calibration_reversal: no reversal records found")
        return summary

    # 2. Load the cache. Skip already-processed reversals up front so
    # we don't read-record on records we don't need to.
    cache = _load_cache()
    processed_map = cache.setdefault("processed", {})
    cal_block = cache.setdefault("calibration", [])

    # De-dupe and pre-skip.
    pending: list[str] = []
    for path in dict.fromkeys(discovered):  # preserve order, drop dups
        if path in processed_map:
            summary["skipped"] += 1
            continue
        pending.append(path)

    if not pending:
        logger.info(
            "calibration_reversal: %d reversal(s) already processed; "
            "nothing new",
            summary["skipped"],
        )
        return summary

    # 3. Per-record loop. Read the reversal frontmatter, derive source-
    # types, apply negative feedback, mark processed. Per-record
    # try/except so one corrupt record can't stall the others.
    applied_keys_overall: set[str] = set()
    client = VaultClient(cfg)
    try:
        from datetime import datetime, timezone as _tz
        for path in pending:
            try:
                rec = await client.read_record(path)
            except Exception as exc:  # noqa: BLE001
                summary["errors"] += 1
                summary["error_messages"].append(
                    f"read {path}: {exc}"[:500]
                )
                continue

            fm = rec.get("frontmatter") if isinstance(rec, dict) else None
            if not isinstance(fm, dict):
                summary["errors"] += 1
                summary["error_messages"].append(
                    f"no frontmatter on {path}"[:500]
                )
                continue

            try:
                source_types = await _derive_source_types(client, fm)
            except Exception as exc:  # noqa: BLE001
                summary["errors"] += 1
                summary["error_messages"].append(
                    f"derive {path}: {exc}"[:500]
                )
                continue

            applied_to: list[str] = []
            for st in sorted(source_types):
                if not st:
                    continue
                key = _calibration_key(st)
                applied_to.append(key)
                applied_keys_overall.add(key)
                # Hand a single-entry list to _update_calibration so
                # we reuse the canonical reducer. The negative_signal
                # branch ignores signal_source_names + contributions
                # and applies a flat -0.1 with floor at 0.0.
                entry = _ensure_calibration_entry(cal_block, key)
                idx = cal_block.index(entry)
                updated, _trans, _prune = _update_calibration(
                    [entry],
                    set(),
                    source_contributions=None,
                    negative_signal=True,
                )
                if updated:
                    cal_block[idx] = updated[0]

            # Mark the reversal processed even when source_types was
            # empty — empty means we couldn't derive any contributors,
            # which is informational, not a retryable error. Re-trying
            # the same reversal won't yield new info.
            processed_map[path] = {
                "processed_at": datetime.now(_tz.utc).isoformat(
                    timespec="seconds",
                ),
                "applied_to": applied_to,
            }
            summary["processed"] += 1
    finally:
        await client.close()

    # 4. Single atomic write at the end. We accept that a crash
    # mid-loop can replay the unwritten records on the next tick — the
    # cost is at most a duplicate -0.1 hit, bounded and self-healing.
    _save_cache(cache)

    summary["applied_keys"] = sorted(applied_keys_overall)
    logger.info(
        "calibration_reversal: processed=%d skipped=%d errors=%d "
        "keys_touched=%d",
        summary["processed"],
        summary["skipped"],
        summary["errors"],
        len(applied_keys_overall),
    )
    # Cap error_messages so callers don't have to.
    summary["error_messages"] = summary["error_messages"][:10]
    return summary
