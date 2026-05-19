"""Decay watcher — stamp freshness bands on needs_attention records,
auto-flip deeply stale ones, and (optionally) emit a one-shot
stale-notice signal asking the principal "is this still worth knowing?"
before a card disappears entirely.

The freshness logic lives in ``src.utils.decay``. This module is the
side-effecting half: read needs_attention from ctrl-api, compute the
current band per record, and patch back any change.

Lifecycle per record:

  1. Card lands with ``status: pending`` and ``origin_at`` set by
     signal_extract. Decay band = ``fresh``.
  2. As age accrues past the source-specific half-life, the band
     transitions to ``aging``. The principal still sees it on /desk
     but the UI groups it under "Aging".
  3. Once freshness drops below ``AGING_THRESHOLD`` (0.20), the card
     is ``stale`` — still visible but heavily de-emphasised.
  4. Once freshness drops below ``AUTO_FLIP_THRESHOLD`` (0.05), the
     status itself is flipped to ``stale`` so the card disappears.

The optional stale-notice pass (gated by env to keep clerk traffic
low) sends a small clerk prompt asking what's lost if the card is
dropped, then materialises a fresh needs_attention card of
``kind: stale_notice`` referencing the original. The principal sweeps
the notice (a single Yes/No interaction) instead of having to read the
underlying signal again.

SM-D-W8 — STATE-MUTATOR V2 RETROFIT
-----------------------------------

Per ``docs/STATE-MUTATION.md`` §7 W8, DecayWatcher now also adjusts
matter ``surface_class`` (state-adjacent — added to the matter
state-field allowlist in Phase A). The retrofit ships two pieces:

  * ``propose_decay_watcher_adjust`` — deterministic band-based
    propose function (``@propose_fn("decay_watcher.adjust")``) that
    maps recent matter activity to a surface_class band.
  * ``adjust_matter_surface_class_v2`` — wrapper activity the
    patched branch of ``DecayWatcherWorkflow.run`` dispatches per
    matter; it builds the ObservedWindow and routes through
    ``apply_state_change_v2`` so /decisions and the matter detail
    page see ``source="decay_watcher"`` entries on every surface_class
    move.

The legacy ``watch_decay`` activity (needs_attention freshness +
auto-flip) is unchanged — it operates on a record type the contract
explicitly puts out of scope (§2 ``needs_attention``).
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.decay import (
    AUTO_FLIP_THRESHOLD,
    band_for,
    freshness_score,
)
from src.utils.vault_client import VaultClient
from src.activities.state_mutator import (
    MutatorContentionError,
    ObservedWindow,
    ProposedMutation,
    apply_state_change_v2,
    propose_fn,
)

logger = logging.getLogger("decay-watcher")


def _http() -> httpx.AsyncClient:
    cfg = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    return httpx.AsyncClient(
        base_url=cfg.alfred_ctrl_url, headers=headers, timeout=60.0
    )


def _origin_of(rec: dict[str, Any]) -> str | None:
    """Pick the best origin timestamp from a needs_attention record.

    Prefers ``origin_at`` (the real-world event time, set by signal
    extraction), falls back to ``created`` (when Alfred wrote the
    record). When neither is present we cannot decay this record.
    """
    fm = rec.get("frontmatter") if isinstance(rec, dict) else None
    src: dict[str, Any] = fm if isinstance(fm, dict) else rec
    for key in ("origin_at", "created", "received_at"):
        v = src.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _source_of(rec: dict[str, Any]) -> str | None:
    """Pick the source label used for half-life lookup."""
    fm = rec.get("frontmatter") if isinstance(rec, dict) else None
    src: dict[str, Any] = fm if isinstance(fm, dict) else rec
    # Prefer the explicit kind if it's set (e.g. "stale_notice"),
    # otherwise the source bucket (e.g. "gmail").
    for key in ("kind", "source_type", "source"):
        v = src.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


@activity.defn
async def watch_decay() -> dict[str, Any]:
    """Scan pending needs_attention, stamp decay_band, auto-flip the
    deeply stale, return counts.

    Only operates on ``status: pending`` records — once a card has been
    handled (delegated, deferred, done, marked noise) the band stops
    mattering. Idempotent: if the band already matches what we'd write,
    no PATCH is issued.
    """
    now = datetime.now(timezone.utc)
    examined = 0
    stamped = 0
    auto_flipped = 0
    band_counts: dict[str, int] = {"fresh": 0, "aging": 0, "stale": 0, "unknown": 0}

    async with _http() as client:
        resp = await client.get(
            "/api/v1/admin/needs-attention?include=all&limit=1000",
        )
        resp.raise_for_status()
        recs = resp.json().get("records", []) or []
        for r in recs:
            fm = r.get("frontmatter") if isinstance(r, dict) else None
            src: dict[str, Any] = fm if isinstance(fm, dict) else r
            if src.get("status") != "pending":
                continue
            examined += 1
            origin = _origin_of(r)
            source_label = _source_of(r)
            score = freshness_score(origin, source_label, now=now)
            band = band_for(score)
            band_counts[band] = band_counts.get(band, 0) + 1
            na_id = r.get("id") or src.get("id")
            if not isinstance(na_id, str) or not na_id:
                continue

            # Decide what to write. We only PATCH if something actually
            # changes — the band, the score (rounded to 3 dp), or the
            # status itself when we auto-flip.
            existing_band = src.get("decay_band")
            existing_score = src.get("decay_score")
            rounded_score = round(score, 3) if isinstance(score, float) else None

            patch_set: dict[str, Any] = {}
            if rounded_score is not None and rounded_score != existing_score:
                patch_set["decay_score"] = rounded_score
            if band != existing_band:
                patch_set["decay_band"] = band

            # Auto-flip when deeply stale. Use score (not just band)
            # because the auto-flip threshold is below the stale band.
            if (
                isinstance(score, float)
                and score < AUTO_FLIP_THRESHOLD
                and src.get("status") == "pending"
            ):
                patch_set["status"] = "stale"
                patch_set["resolved_at"] = now.isoformat()
                patch_set["resolution_note"] = (
                    f"Auto-aged to stale at freshness={rounded_score} "
                    f"(source={source_label}, origin={origin})"
                )
                auto_flipped += 1

            if not patch_set:
                continue
            patch = await client.patch(
                f"/api/v1/vault/records/needs_attention/{na_id}.md",
                json={"set": patch_set},
            )
            if patch.status_code < 400:
                stamped += 1
            else:
                logger.warning(
                    "decay: patch failed na=%s status=%s",
                    na_id, patch.status_code,
                )

    if examined:
        logger.info(
            "decay_watcher: examined=%d stamped=%d auto_flipped=%d bands=%s",
            examined, stamped, auto_flipped, band_counts,
        )
    return {
        "examined": examined,
        "stamped": stamped,
        "auto_flipped": auto_flipped,
        "bands": band_counts,
    }


# ---------------------------------------------------------------------------
# SM-D-W8 — surface_class adjustment via state-mutator v2
# ---------------------------------------------------------------------------
#
# The legacy ``watch_decay`` activity above stamps freshness bands on
# needs_attention records — that record type is out of scope for the
# universal state-mutation contract (spec §2). What IS in scope is the
# matter ``surface_class`` field (added to the matter state-field
# allowlist in Phase A, ctrl-api stateFields.ts). Under spec §7 W8 the
# DecayWatcher takes on responsibility for adjusting matter
# surface_class based on activity-decay bands so /decisions and the
# matter detail page see ``source=decay_watcher`` entries for every
# band move.

# Activity-decay band thresholds — counted as "matter-touching"
# signals + decisions + events within the lookback window. Numbers
# picked to keep ``high`` reserved for matters that are genuinely
# receiving fresh input (Steward should be evaluating these every
# 30 min per src/activities/steward.py:81) and ``low`` for matters
# that have gone quiet but aren't dead.
ACTIVITY_BAND_HIGH_MIN = 5     # >=5 signals/decisions in window → high
ACTIVITY_BAND_NORMAL_MIN = 1   # >=1 in window → normal; below → low

# Lookback window for activity counting. Matches the spec's general
# "have things happened" interpretation — long enough to give "low"
# meaning (a fortnight without input is genuinely quiet) but short
# enough that a matter actively under discussion stays on "high".
ACTIVITY_LOOKBACK = timedelta(days=14)


def _activity_count(observed: ObservedWindow) -> int:
    """Count materially-relevant references in an ObservedWindow.

    Signals + decisions both count fully; ``other_refs`` (briefings,
    chore runs, prior state changes) contribute too — they all
    represent activity touching the matter inside the window.
    """
    return (
        len(observed.signal_paths)
        + len(observed.decision_paths)
        + len(observed.other_refs)
    )


def _band_for_activity_count(count: int) -> str:
    """Map activity count to a surface_class band.

    Deterministic, monotonic in count. The thresholds are gut numbers
    the principal can tune via env-var or rules-file once we have
    empirical data; doing so does NOT require a workflow.patched bump
    because the propose function runs in-process and re-running with
    new thresholds simply produces a new ProposedMutation (or None).
    """
    if count >= ACTIVITY_BAND_HIGH_MIN:
        return "high"
    if count >= ACTIVITY_BAND_NORMAL_MIN:
        return "normal"
    return "low"


@propose_fn("decay_watcher.adjust")
async def propose_decay_watcher_adjust(
    *,
    target: dict[str, Any],
    observed: ObservedWindow,
    args: dict[str, Any],
) -> ProposedMutation | None:
    """Deterministic propose function for the DecayWatcher surface_class pass.

    Contract:
      * ``target`` — matter snapshot from ``read_target``.
      * ``observed`` — the writer's reasoning window. Populated by the
        wrapper activity via ``gather_observed`` so signal/decision/event
        paths in the window are visible to the audit record.
      * ``args`` — caller-supplied context. The wrapper passes
        ``{"lookback_days": <int>}`` for log-line provenance; the
        propose function does not consult ``args`` for the band
        decision (the count comes from ``observed``).

    Returns ``ProposedMutation({"surface_class": <band>})`` when the
    computed band differs from the matter's current ``surface_class``;
    returns ``None`` (no v2 round-trip) when they match — the matter
    detail page should not see a no-op band stamp.
    """
    fm = target.get("frontmatter") if isinstance(target, dict) else None
    if not isinstance(fm, dict):
        fm = {}
    current_raw = fm.get("surface_class")
    current = str(current_raw).strip().lower() if isinstance(current_raw, str) else None

    count = _activity_count(observed)
    desired = _band_for_activity_count(count)

    if current == desired:
        logger.debug(
            "decay_watcher.adjust: current=%s desired=%s — no-op",
            current, desired,
        )
        return None

    lookback_days = args.get("lookback_days") if isinstance(args, dict) else None
    lookback_str = (
        f"{int(lookback_days)}d" if isinstance(lookback_days, int)
        else f"{ACTIVITY_LOOKBACK.days}d"
    )
    return ProposedMutation(
        fields={"surface_class": desired},
        reason=(
            f"Activity-decay band moved {current!r} -> {desired!r} "
            f"({count} signal/decision/event references in last "
            f"{lookback_str})."
        ),
        confidence=1.0,
        fan_out=(),
    )


@activity.defn
async def adjust_matter_surface_class_v2(
    matter_path: str,
    observed_end_iso: str,
) -> dict[str, Any]:
    """Per-matter wrapper the patched workflow branch dispatches.

    Stage layout mirrors ``nightly_narrative.apply_matter_narrative_v2``
    so the patched-branch surface in the workflow stays a single
    ``execute_activity`` call per matter (minimum replay-safety review
    area):

      1. Read the matter via state_mutator.read_target.
      2. Build ObservedWindow (start = prior as_of or now-14d,
         end = workflow-supplied iso) and populate signal/decision/event
         paths by scanning the lookback window.
      3. Call apply_state_change_v2 with propose_fn_name
         ``decay_watcher.adjust``; the mutator handles 409 retries.
      4. Return a small dict with the outcome status the workflow can
         aggregate.

    Output dict keys:
      * ``matter_path`` — echoed back for log-line correlation.
      * ``status`` — one of ``"mutated"`` / ``"no_change"`` / ``"error"``.
      * ``audit_record_path`` — present on ``mutated``.
      * ``new_surface_class`` — band the mutator wrote, on ``mutated``.
      * ``error_message`` — short reason, on ``error``.
    """
    canonical = (matter_path or "").strip()
    if not canonical:
        return {
            "matter_path": matter_path,
            "status": "error",
            "error_message": "invalid matter_path",
        }
    if not (canonical.startswith("matter/") and canonical.endswith(".md")):
        return {
            "matter_path": matter_path,
            "status": "error",
            "error_message": "not a matter path",
        }

    # Parse workflow-supplied iso so retries see the same end timestamp
    # (Temporal-determinism friendly).
    end_dt = _parse_observed_end(observed_end_iso)

    # We avoid importing read_target / gather_observed (would create a
    # circular activity dispatch dance) — call the underlying helpers
    # in-process. apply_state_change_v2 itself calls read_target inside,
    # so the propose function sees fresh frontmatter even if a race
    # advanced as_of between our pre-read and the POST.
    config = load_config()
    vault = VaultClient(config)
    try:
        try:
            record = await vault.read_record(canonical)
        except httpx.HTTPStatusError as exc:
            if exc.response is not None and exc.response.status_code == 404:
                return {
                    "matter_path": canonical,
                    "status": "no_change",
                }
            raise
        fm = record.get("frontmatter") if isinstance(record, dict) else None
        if not isinstance(fm, dict):
            fm = {}
    finally:
        await vault.close()

    prior_as_of_raw = fm.get("as_of")
    expected_as_of = (
        str(prior_as_of_raw).strip()
        if isinstance(prior_as_of_raw, str) and prior_as_of_raw
        else None
    )
    start_dt = (
        _parse_observed_end(prior_as_of_raw)
        if isinstance(prior_as_of_raw, str) and prior_as_of_raw
        else None
    )
    cutoff = end_dt - ACTIVITY_LOOKBACK
    if start_dt is None or start_dt < cutoff:
        start_dt = cutoff

    signal_paths, decision_paths, other_refs = await _collect_observed_paths(
        target_path=canonical,
        cutoff=start_dt,
    )
    observed = ObservedWindow(
        start=start_dt,
        end=end_dt,
        signal_paths=signal_paths,
        decision_paths=decision_paths,
        other_refs=other_refs,
    )

    try:
        result = await apply_state_change_v2(
            target_path=canonical,
            source="decay_watcher",
            observed=observed,
            propose_fn_name="decay_watcher.adjust",
            propose_fn_args={
                "lookback_days": ACTIVITY_LOOKBACK.days,
            },
            mode="live",
            expected_as_of=expected_as_of,
        )
    except MutatorContentionError as exc:
        logger.warning(
            "decay_watcher.adjust_v2: 409 retries exhausted matter=%s err=%s",
            canonical, exc,
        )
        return {
            "matter_path": canonical,
            "status": "error",
            "error_message": f"contention_exhausted: {exc}"[:300],
        }
    except httpx.HTTPError as exc:
        logger.warning(
            "decay_watcher.adjust_v2: v2 HTTP failed matter=%s err=%s",
            canonical, exc,
        )
        return {
            "matter_path": canonical,
            "status": "error",
            "error_message": f"http_error: {exc}"[:300],
        }
    except Exception as exc:  # noqa: BLE001 — defensive
        logger.warning(
            "decay_watcher.adjust_v2: unexpected matter=%s err=%r",
            canonical, exc,
        )
        return {
            "matter_path": canonical,
            "status": "error",
            "error_message": f"unexpected: {type(exc).__name__}: {exc}"[:300],
        }

    if not result.applied:
        return {
            "matter_path": canonical,
            "status": "no_change",
        }

    # The mutator's fields dict was the band; surface it on the
    # outcome so callers (and the workflow's aggregate result) can
    # report per-band counts without re-reading the matter.
    new_band = None
    if isinstance(result, object) and hasattr(result, "fan_out_triggered"):
        # We don't carry the patched fields on MutationResult — re-derive
        # from the propose function's logic for the log line.
        new_band = _band_for_activity_count(_activity_count(observed))
    logger.info(
        "decay_watcher.adjust_v2: matter=%s mutated band=%s audit=%s retries=%d",
        canonical, new_band, result.audit_record_path, result.retried_count,
    )
    return {
        "matter_path": canonical,
        "status": "mutated",
        "audit_record_path": result.audit_record_path,
        "new_surface_class": new_band,
    }


def _parse_observed_end(value: Any) -> datetime:
    """Best-effort ISO-string → aware UTC datetime; falls back to now."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value.strip():
        s = value.strip().replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(s)
        except ValueError:
            return datetime.now(timezone.utc)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    return datetime.now(timezone.utc)


async def _collect_observed_paths(
    *,
    target_path: str,
    cutoff: datetime,
) -> tuple[list[str], list[str], list[str]]:
    """Scan signal/decision/event records pointing at the matter.

    Returns ``(signal_paths, decision_paths, other_refs)`` for any
    record whose ``target_path`` / ``parent_matter`` / ``related_matters``
    matches ``target_path`` AND whose timestamp falls in the lookback
    window. Mirrors ``state_mutator.gather_observed`` but inlined here
    so we don't have to round-trip through Temporal's activity-call
    machinery for a deterministic vault scan.
    """
    config = load_config()
    vault = VaultClient(config)
    signal_paths: list[str] = []
    decision_paths: list[str] = []
    other_refs: list[str] = []

    try:
        # Signals are state.db rows (storage cutover #27) — query
        # ctrl-api's /api/v1/state/signals scoped to this matter
        # instead of walking vault/signal/.
        try:
            from src.utils.signal_state import (
                StateClient,
                signal_row_to_record,
            )

            async with StateClient(config) as sc:
                sig_rows = await sc.list_signals(
                    matter=target_path,
                    since=cutoff.isoformat(),
                    limit=10_000,
                )
            for row in sig_rows:
                rec = signal_row_to_record(row)
                fm = rec.get("frontmatter") or {}
                if not _record_targets_matter(fm, target_path):
                    if str(fm.get("target_matter_path") or "").strip() != target_path:
                        continue
                ts_raw = (
                    fm.get("applied_at")
                    or fm.get("created")
                    or rec.get("created")
                )
                ts = _parse_iso_aware(ts_raw)
                if ts is None or ts < cutoff:
                    continue
                sid = str(rec.get("id") or "").strip()
                if sid:
                    signal_paths.append(sid)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "decay_watcher.collect: state.db signal query failed "
                "target=%s err=%s", target_path, exc,
            )

        for record_type, sink in (
            ("decision", decision_paths),
            ("event", other_refs),
        ):
            try:
                records = await vault.list_records(record_type, limit=10_000)
            except httpx.HTTPError as exc:
                logger.warning(
                    "decay_watcher.collect: %s list failed target=%s err=%s",
                    record_type, target_path, exc,
                )
                continue
            for rec in records:
                if not isinstance(rec, dict):
                    continue
                fm = rec.get("frontmatter") or rec
                if not isinstance(fm, dict):
                    fm = {}
                if not _record_targets_matter(fm, target_path):
                    continue
                ts_raw = (
                    fm.get("applied_at")
                    or fm.get("created")
                    or rec.get("created")
                )
                ts = _parse_iso_aware(ts_raw)
                if ts is None or ts < cutoff:
                    continue
                path = str(rec.get("path") or fm.get("path") or "").strip()
                if path:
                    sink.append(path)
    finally:
        await vault.close()

    return signal_paths, decision_paths, other_refs


def _record_targets_matter(fm: dict[str, Any], target_path: str) -> bool:
    """True iff frontmatter points back at the matter we're scoring."""
    tp = str(fm.get("target_path") or "").strip()
    if tp == target_path:
        return True
    parent = str(fm.get("parent_matter") or fm.get("matter") or "").strip()
    if parent == target_path:
        return True
    related = fm.get("related_matters")
    if isinstance(related, list):
        for r in related:
            if isinstance(r, str) and r.strip() == target_path:
                return True
    cands = fm.get("target_candidates")
    if isinstance(cands, list):
        for c in cands:
            if isinstance(c, dict) and str(c.get("path") or "").strip() == target_path:
                return True
            if isinstance(c, str) and c.strip() == target_path:
                return True
    return False


def _parse_iso_aware(value: Any) -> Optional[datetime]:
    """Parse an ISO timestamp into an aware UTC datetime or None."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


@activity.defn
async def list_active_matters_for_decay() -> list[str]:
    """Enumerate every matter the DecayWatcher should re-band.

    Skips matters whose ``state`` (Steward schema) or legacy ``status``
    sits in a terminal value — a matter that's done or archived
    shouldn't have its surface_class moved by activity-decay. Returns
    canonical ``matter/<slug>.md`` paths sorted alphabetically for
    deterministic Temporal replay.

    Env kill-switch: ``DECAY_WATCHER_MATTER_PASS_ENABLED=false`` (default)
    short-circuits to an empty list. SM-D-W8 introduced surface_class
    bands that didn't exist before; flag-off ships the code dormant so
    bands can be validated against david before going live.
    """
    if os.environ.get("DECAY_WATCHER_MATTER_PASS_ENABLED", "false").lower() != "true":
        return []
    config = load_config()
    vault = VaultClient(config)
    try:
        try:
            records = await vault.list_records("matter", limit=10_000)
        except httpx.HTTPError as exc:
            logger.warning(
                "decay_watcher.list_active_matters_for_decay: list failed: %s",
                exc,
            )
            return []
    finally:
        await vault.close()

    out: list[str] = []
    for rec in records:
        if not isinstance(rec, dict):
            continue
        fm = rec.get("frontmatter") or rec
        if not isinstance(fm, dict):
            fm = {}
        state = str(fm.get("state") or "").strip().lower()
        status = str(fm.get("status") or "").strip().lower()
        if state in ("done", "archived") or status in ("done", "archived", "completed"):
            continue
        path = str(rec.get("path") or "").strip()
        if not path.startswith("matter/") or not path.endswith(".md"):
            continue
        out.append(path)
    out.sort()
    return out
