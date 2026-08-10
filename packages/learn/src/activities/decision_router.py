"""Decision router activities — the side-effect layer for human clicks.

Every click on the Desk's Delegate / Defer / Delete / Do buttons writes
a ``decision/<ts>-<short>.md`` vault record (via ctrl-api
``/api/v1/decisions``). These activities, driven by
``DecisionRouterWorkflow`` on a 60-second cadence, pick those records
up and fan out the downstream effects so the click is a single fast
write and everything else happens asynchronously:

- For ``intent=done`` on a needs_attention card → flip the underlying
  needs_attention record's ``status`` to ``done``.
- For ``intent=defer`` → flip to ``skipped``.
- For ``intent=delegate`` → call the existing ctrl-api dispatch route,
  which re-arms the source signal AND stamps ``decision_origin`` on it
  so the eventual outcome signal can be matched back to the decision.
  The decision is marked ``state=dispatching`` *before* the dispatch
  POST (#55 mark-before-dispatch — see the guard note below), then
  flips to ``executing`` after a successful dispatch and waits for the
  outcome.
- For ``intent=take_mine`` → spawn a ``to_do/<ts>.md`` record so the
  principal's personal queue is durable (no more in-React Backstage
  tray). Decision state flips to ``completed``.

Reversal:

- When a decision is flipped to ``state=reversed`` via
  ``POST /api/v1/decisions/:id/reverse``, the router runs the inverse
  side-effects where possible — flipping the source record's status
  back to ``pending``, cancelling any spawned ``to_do``, etc.
- ``intent=delegate`` reversal is best-effort: the desk card reopens
  but if the agent already fired we cannot rewind the world.

Outcome polling:

- For decisions in ``state=executing`` (delegate-class), the router
  watches the source signal's outcome — if a fresh outcome signal
  appears that references the decision's source_signal_path, the
  decision's ``outcome_record`` field gets stamped and state flips to
  ``completed``. Closes the loop.

Idempotency:

- The router only operates on ``state=open`` / ``state=reversed`` /
  ``state=executing`` decisions. Once flipped to ``completed`` the
  decision is terminal and the router skips it. State transitions are
  atomic ctrl-api PATCHes.
- ``intent=delegate`` is the one path with a real, non-idempotent side
  effect (a live agent dispatch). To make it exactly-once across
  retries, ``route_decision`` writes a non-terminal ``dispatching``
  state *before* the dispatch POST and the entry guard early-returns on
  ``dispatching`` (#55). ``dispatching`` is intentionally distinct from
  ``executing``: ``check_decision_outcomes`` polls only ``executing``
  decisions, so a decision stranded in ``dispatching`` (a crash between
  the mark and a successful dispatch) cannot poison the outcome poller.
  Such a stranded decision is observable — a WARNING log on every
  guarded re-entry plus the ``GET /api/v1/decisions/in-flight`` strip.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from temporalio import activity

from src.activities.signal_actions import dispatch_action_to_agent
from src.activities.state_mutator import (
    ObservedWindow,
    ProposedMutation,
    apply_state_change_v2,
    propose_fn,
)
from src.config import load_config
from src.matching.hours_approval import (
    build_acceptance,
    is_already_accepted,
    ledger_already_has_period,
    ledger_line,
)

logger = logging.getLogger("decision-router")


def _http() -> httpx.AsyncClient:
    """Build an authenticated client to ctrl-api."""
    cfg = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    return httpx.AsyncClient(
        base_url=cfg.alfred_ctrl_url, headers=headers, timeout=30.0
    )


# ---------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------


@activity.defn
async def list_decisions_by_state(state: str) -> list[dict[str, Any]]:
    """Return all decisions in the given state. Newest first."""
    async with _http() as client:
        resp = await client.get(f"/api/v1/decisions?state={state}&limit=500")
        resp.raise_for_status()
        return resp.json().get("decisions", []) or []


# ---------------------------------------------------------------------
# Stuck-dispatching recovery (Sir-incident 2026-05-25)
# ---------------------------------------------------------------------


# A ``state=dispatching`` decision is in flight for as long as
# route_decision is mid-dispatch (Hermes clerk call). After
# DISPATCHING_STALE_MINUTES has passed and the decision is still
# ``dispatching``, the activity is presumed dead and the decision is
# stuck. The workflow's normal list filter (open|reversed|executing)
# doesn't see ``dispatching``, so without this recovery the card is
# invisible forever.
#
# 10 minutes is the heuristic: longer than the Hermes 900s ceiling on
# the workers profile is the strict upper bound (900s ≈ 15min), but
# in practice clerk completes in 60-180s on the delegate path. 10min
# gives ~3-10x slack over typical, surfaces a stuck card within one
# Reflection window (daily 2am), and won't race a healthy slow
# clerk. If we ever see false-positive recoveries (clerk completed
# at minute 12 while we already PATCHed to executing) the only
# downside is that check_decision_outcomes picks up the executing
# decision normally — no double-dispatch (#55 idempotency holds).
DISPATCHING_STALE_MINUTES = 10


# A dispatch that can never succeed loops forever under the recovery
# pass: ``open → route_decision (dispatch fails) → dispatching →
# recover → open → …`` every ~60s, re-firing the action and
# re-notifying the principal each cycle (live incident 2026-07-15,
# ``office-ac-quiet-mode``). Cap the resurrections: after
# ``MAX_DISPATCH_ATTEMPTS`` reset-to-open cycles, move the decision to
# the terminal ``failed`` dead-letter state (surfaced exactly once,
# because a ``failed`` decision no longer appears in the
# ``?state=dispatching`` sweep) instead of resurrecting it again.
def _resolve_max_dispatch_attempts() -> int:
    """Resolve ``MAX_DISPATCH_ATTEMPTS`` defensively from the env
    override ``DECISION_MAX_DISPATCH_ATTEMPTS`` — falls back to 3 on
    unset/garbage, floored at a minimum of 1 (so the cap can never
    disable itself)."""
    raw = os.environ.get("DECISION_MAX_DISPATCH_ATTEMPTS", "")
    try:
        val = int(str(raw).strip())
    except (TypeError, ValueError):
        return 3
    return max(1, val)


MAX_DISPATCH_ATTEMPTS = _resolve_max_dispatch_attempts()


def _now_iso() -> str:
    """Current UTC instant as an ISO8601 string with a trailing ``Z``
    (parity with the ``created`` timestamp ctrl-api writes)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _parse_iso(ts: str) -> datetime | None:
    """Parse the ISO timestamp ctrl-api writes for ``created`` (always
    UTC, trailing ``Z``). Returns None on any parse failure so the
    recovery pass degrades to skip rather than crash."""
    if not isinstance(ts, str) or not ts.strip():
        return None
    s = ts.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


@activity.defn
async def recover_stuck_dispatching() -> dict[str, Any]:
    """Sweep ``state=dispatching`` decisions older than
    ``DISPATCHING_STALE_MINUTES`` and unstick them.

    Two branches, by ``side_effects.agent_dispatched``:

      * ``True`` → the Hermes call landed but the final ``executing``
        PATCH was dropped (route_decision's activity timed out
        between the dispatch and the state-write). PATCH to
        ``executing`` so check_decision_outcomes picks it up. This is
        a legitimate promotion and is **not** capped.
      * ``False`` / missing → presume the dispatch crashed. This branch
        is **capped** (issue #282): each reset increments
        ``side_effects.dispatch_attempts``. While ``attempts <
        MAX_DISPATCH_ATTEMPTS`` we PATCH back to ``open`` (as before) so
        the next tick's route_decision pass re-routes cleanly. Once
        ``attempts >= MAX_DISPATCH_ATTEMPTS`` the dispatch is presumed
        never able to succeed, so instead of resurrecting again we move
        the decision to the terminal ``failed`` dead-letter state and
        surface it exactly once — never re-firing the action forever.

    Every PATCH is audit-logged via ``POST /api/v1/state/audit`` with
    ``action_type=state-change``. The reset/promote path uses
    ``source=decision_router.recovery``; the dead-letter crossover uses
    ``source=decision_router.dead_letter`` so production can count
    dead-letters separately.

    Returns ``{scanned, recovered, reset_to_open,
    promoted_to_executing, dead_lettered}`` for observability.
    """
    scanned = 0
    recovered = 0
    reset_to_open = 0
    promoted_to_executing = 0
    dead_lettered = 0
    cutoff = datetime.now(timezone.utc) - timedelta(
        minutes=DISPATCHING_STALE_MINUTES,
    )

    async with _http() as client:
        resp = await client.get(
            "/api/v1/decisions?state=dispatching&limit=500",
        )
        resp.raise_for_status()
        rows = resp.json().get("decisions", []) or []
        scanned = len(rows)

        for d in rows:
            decision_id = str(d.get("id") or "").strip()
            if not decision_id:
                continue
            created = _parse_iso(str(d.get("created") or ""))
            if created is None:
                # Missing/unparseable created — be conservative and
                # skip. Workflow logs scanned-vs-recovered so a
                # systematic skip surfaces.
                continue
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            if created > cutoff:
                continue  # still in flight, leave alone

            side_effects = d.get("side_effects") or {}
            if not isinstance(side_effects, dict):
                side_effects = {}
            agent_dispatched = bool(side_effects.get("agent_dispatched"))

            # ---- Branch A: legitimate promotion (NOT capped) ----
            # agent_dispatched=true means the Hermes call landed but the
            # final executing PATCH was dropped. Promote to executing so
            # check_decision_outcomes picks it up. Uncapped by design.
            if agent_dispatched:
                new_state = "executing"
                reason = (
                    "agent_dispatched=true; final state-write dropped — "
                    "promoting to executing"
                )
                try:
                    patch_resp = await client.patch(
                        f"/api/v1/decisions/{decision_id}",
                        json={"state": new_state},
                    )
                    patch_resp.raise_for_status()
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "decision_router.recover_stuck_dispatching: PATCH "
                        "failed decision=%s new_state=%s err=%s",
                        decision_id, new_state, exc,
                    )
                    continue

                recovered += 1
                promoted_to_executing += 1
                await _emit_recovery_audit(
                    client,
                    decision_id=decision_id,
                    source="decision_router.recovery",
                    new_state=new_state,
                    reason=reason,
                    created=created,
                    agent_dispatched=True,
                    extra_changes=None,
                )
                logger.warning(
                    "decision_router.recover_stuck_dispatching: "
                    "unstuck decision=%s dispatching → %s (%s)",
                    decision_id, new_state, reason,
                )
                continue

            # ---- Branch B: presumed crash — CAPPED (issue #282) ----
            # Each reset increments dispatch_attempts. PATCH replaces the
            # whole side_effects object, so we merge client-side: read the
            # current object, add our bookkeeping keys, PATCH it back.
            prior = side_effects.get("dispatch_attempts", 0)
            try:
                prior = int(prior)
            except (TypeError, ValueError):
                prior = 0
            attempts = prior + 1
            now_iso = _now_iso()

            merged = dict(side_effects)
            merged["dispatch_attempts"] = attempts

            if attempts >= MAX_DISPATCH_ATTEMPTS:
                # Dead-letter: dispatch never succeeded across the cap.
                # Move to the terminal ``failed`` state (NOT open) so the
                # decision drops out of the ?state=dispatching sweep and
                # the surfacing audit below fires exactly once.
                new_state = "failed"
                dead_letter_reason = (
                    f"exceeded MAX_DISPATCH_ATTEMPTS ({MAX_DISPATCH_ATTEMPTS}) "
                    f"resurrections; dispatch never succeeded"
                )
                merged["dead_lettered_at"] = now_iso
                merged["dead_letter_reason"] = dead_letter_reason
                try:
                    patch_resp = await client.patch(
                        f"/api/v1/decisions/{decision_id}",
                        json={"state": new_state, "side_effects": merged},
                    )
                    patch_resp.raise_for_status()
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "decision_router.recover_stuck_dispatching: PATCH "
                        "failed decision=%s new_state=%s err=%s",
                        decision_id, new_state, exc,
                    )
                    continue

                recovered += 1
                dead_lettered += 1
                # Best-effort: an audit failure must NOT roll back the
                # ``failed`` PATCH (which already landed above). Fires
                # exactly once — a ``failed`` decision is no longer in
                # the ?state=dispatching sweep.
                await _emit_recovery_audit(
                    client,
                    decision_id=decision_id,
                    source="decision_router.dead_letter",
                    new_state=new_state,
                    reason=dead_letter_reason,
                    created=created,
                    agent_dispatched=False,
                    extra_changes={
                        "dispatch_attempts": attempts,
                        "dead_letter_reason": dead_letter_reason,
                    },
                )
                logger.error(
                    "decision_router.recover_stuck_dispatching: "
                    "DEAD-LETTER decision=%s dispatching → failed "
                    "after %d attempts (%s)",
                    decision_id, attempts, dead_letter_reason,
                )
                continue

            # Under the cap — reset to open as before, but stamp the
            # attempt counter + last_dispatch_at into side_effects.
            new_state = "open"
            reason = (
                "agent_dispatched=false/missing; presumed crash — "
                f"resetting to open for re-routing (attempt {attempts}/"
                f"{MAX_DISPATCH_ATTEMPTS})"
            )
            merged["last_dispatch_at"] = now_iso
            try:
                patch_resp = await client.patch(
                    f"/api/v1/decisions/{decision_id}",
                    json={"state": new_state, "side_effects": merged},
                )
                patch_resp.raise_for_status()
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "decision_router.recover_stuck_dispatching: PATCH "
                    "failed decision=%s new_state=%s err=%s",
                    decision_id, new_state, exc,
                )
                continue

            recovered += 1
            reset_to_open += 1
            await _emit_recovery_audit(
                client,
                decision_id=decision_id,
                source="decision_router.recovery",
                new_state=new_state,
                reason=reason,
                created=created,
                agent_dispatched=False,
                extra_changes={"dispatch_attempts": attempts},
            )
            logger.warning(
                "decision_router.recover_stuck_dispatching: "
                "unstuck decision=%s dispatching → %s (%s)",
                decision_id, new_state, reason,
            )

    return {
        "scanned": scanned,
        "recovered": recovered,
        "reset_to_open": reset_to_open,
        "promoted_to_executing": promoted_to_executing,
        "dead_lettered": dead_lettered,
    }


async def _emit_recovery_audit(
    client: Any,
    *,
    decision_id: str,
    source: str,
    new_state: str,
    reason: str,
    created: datetime,
    agent_dispatched: bool,
    extra_changes: dict[str, Any] | None,
) -> None:
    """Best-effort audit emit for the recovery pass. We post directly to
    ``/api/v1/state/audit`` (the StateClient envelope) rather than going
    through StateClient here — the existing ``_http`` client already
    holds the same bearer token and base URL, so this keeps the activity
    dependency-light and parity with decision_router's other HTTP calls.

    An audit-write failure MUST NOT roll back the state PATCH that
    already landed — all failure modes here are swallowed with a warning.
    """
    changes: dict[str, Any] = {
        "state": {"from": "dispatching", "to": new_state},
        "age_minutes": (
            (datetime.now(timezone.utc) - created).total_seconds() / 60.0
        ),
        "agent_dispatched": agent_dispatched,
    }
    if extra_changes:
        changes.update(extra_changes)
    verb = "dead-letter" if new_state == "failed" else "recovery"
    try:
        audit_resp = await client.post(
            "/api/v1/state/audit",
            json={
                "action_type": "state-change",
                "actor": "decision_router",
                "source": source,
                "target_path": f"decision/{decision_id}.md",
                "target_kind": "decision",
                "summary": (
                    f"{verb}: decision/{decision_id} "
                    f"dispatching → {new_state} ({reason})"
                ),
                "changes": changes,
                "mode": "live",
            },
        )
        if audit_resp.status_code >= 400:
            logger.warning(
                "decision_router.recover_stuck_dispatching: "
                "audit POST returned %s for decision=%s",
                audit_resp.status_code, decision_id,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "decision_router.recover_stuck_dispatching: "
            "audit POST failed decision=%s err=%s",
            decision_id, exc,
        )


# ---------------------------------------------------------------------
# Source-card-missing retirement helper (#414)
# ---------------------------------------------------------------------


async def _retire_source_card_missing(
    client: Any,
    *,
    decision_id: str,
    na_id: str,
    intent: str,
    existing_side_effects: dict[str, Any],
) -> dict[str, Any]:
    """Retire a decision whose needs_attention source card returned 404.

    A deleted card is terminal — the ``{done,dispatch,skip}`` POST can
    never succeed and Temporal must not retry forever. Mirror the #313
    ``source_card_missing`` retire pattern (scheduled_dispatch.py:100)
    and add an audit row so the retirement is searchable (#414 spec).

    Returns the ``route_decision`` result dict so callers can ``return``
    immediately after calling this helper.
    """
    now_iso = _now_iso()
    retired_se = dict(existing_side_effects)
    retired_se["decision_router"] = "source_card_missing"
    retired_se["retired_at"] = now_iso
    retired_se["retired_intent"] = intent
    logger.warning(
        "decision_router.route_decision: needs_attention/%s returned 404 "
        "on %s — source card deleted; retiring decision=%s as failed "
        "(side_effects.decision_router=source_card_missing)",
        na_id, intent, decision_id,
    )
    try:
        pr = await client.patch(
            f"/api/v1/decisions/{decision_id}",
            json={"state": "failed", "side_effects": retired_se},
        )
        pr.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "decision_router.route_decision: retire PATCH failed "
            "decision=%s err=%s — will retry next tick",
            decision_id, exc,
        )
        # Return without raising: Temporal sees success, the decision
        # stays open, and the next tick retries (ctrl-api blip path).
    # Best-effort audit — failure must NOT roll back the PATCH.
    try:
        await client.post(
            "/api/v1/state/audit",
            json={
                "action_type": "state-change",
                "actor": "decision_router",
                "source": "decision_router.source_card_missing",
                "target_path": f"decision/{decision_id}.md",
                "target_kind": "decision",
                "summary": (
                    f"source card needs_attention/{na_id} returned 404 "
                    f"on intent={intent}; retired as failed "
                    "(source_card_missing)"
                ),
                "changes": {
                    "state": {"from": "open", "to": "failed"},
                    "reason": "source_card_missing",
                    "na_id": na_id,
                    "intent": intent,
                },
                "mode": "live",
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "decision_router.route_decision: audit POST failed "
            "decision=%s err=%s",
            decision_id, exc,
        )
    return {
        "id": decision_id,
        "intent": intent,
        "source": "needs_attention",
        "next_state": "failed",
        "actions": ["source_card_missing"],
        "side_effects": retired_se,
    }


# ---------------------------------------------------------------------
# Hours-proposal approval (#485)
# ---------------------------------------------------------------------


async def _accept_hours_proposal_if_any(
    client: Any,
    source_record: str,
    note: str,
    decision_id: str,
) -> dict[str, Any] | None:
    """Book an approved hours period, when the Desk card is an hours approval.

    Returns None for every other card — the overwhelmingly common case — so
    this is a cheap no-op on the normal `done` path.

    ORDERING IS LOAD-BEARING: the ledger is appended BEFORE the proposal is
    marked accepted. The reverse order loses hours on a partial failure — a
    proposal marked accepted with nothing in the ledger means those hours
    vanish AND the next window silently skips the period, because the accepted
    ledger is the cursor. This order at worst leaves a re-runnable duplicate,
    which `is_already_accepted` catches.
    """
    card = await client.get(f"/api/v1/vault/records/{source_record}")
    if card.status_code >= 400:
        return None
    card_fm = (card.json() or {}).get("frontmatter") or {}
    if str(card_fm.get("approval_kind") or "") != "hours_proposal":
        return None

    proposal_ref = str(card_fm.get("proposal_ref") or "")
    ledger_ref = str(card_fm.get("ledger_ref") or "")
    if not proposal_ref or not ledger_ref:
        logger.warning(
            "decision_router: hours card %s lacks proposal_ref/ledger_ref — "
            "nothing booked",
            source_record,
        )
        return None

    pr = await client.get(f"/api/v1/vault/records/{proposal_ref}")
    pr.raise_for_status()
    proposal = (pr.json() or {}).get("frontmatter") or {}

    if is_already_accepted(proposal):
        logger.info(
            "decision_router: hours proposal %s already accepted — "
            "not appending twice",
            proposal_ref,
        )
        return {"proposal": proposal_ref, "skipped": "already_accepted"}

    fields = build_acceptance(proposal, note, decision_id, _now_iso())
    accepted_hours = fields.get("accepted_total_hours")

    # 1. Ledger first — but ask the LEDGER whether this period is already
    #    booked. `is_already_accepted` above reads the proposal, which is
    #    exactly the record that fails to update when step 2 errors, so it
    #    cannot protect a retry. Only the ledger knows what the ledger holds.
    lg = await client.get(f"/api/v1/vault/records/{ledger_ref}")
    lg.raise_for_status()
    if ledger_already_has_period((lg.json() or {}).get("body") or "", proposal):
        logger.info(
            "decision_router: ledger %s already books %s..%s — not appending "
            "twice; marking the proposal accepted to close the gap",
            ledger_ref, proposal.get("period_start"), proposal.get("period_end"),
        )
    else:
        lr = await client.patch(
            f"/api/v1/vault/records/{ledger_ref}",
            json={"body_append": "\n" + ledger_line(proposal, accepted_hours) + "\n"},
        )
        lr.raise_for_status()

    # 2. Only now mark the proposal accepted.
    ar = await client.patch(
        f"/api/v1/vault/records/{proposal_ref}", json={"set": fields}
    )
    ar.raise_for_status()

    # 3. Read back — a 200 on this route can be a silent no-op when the body
    #    shape is wrong (CLAUDE.md §15.1), so the write is not proof.
    check = await client.get(f"/api/v1/vault/records/{proposal_ref}")
    check_fm = (check.json() or {}).get("frontmatter") or {}
    if not is_already_accepted(check_fm):
        raise RuntimeError(
            f"hours proposal {proposal_ref} did not read back as accepted; "
            "ledger row was appended — re-run will be blocked by the "
            "idempotency guard, so reconcile by hand"
        )

    return {
        "proposal": proposal_ref,
        "ledger": ledger_ref,
        "hours": accepted_hours,
        "corrected": "correction_delta_hours" in fields,
    }


# ---------------------------------------------------------------------
# Forward routing (state=open → executing | completed)
# ---------------------------------------------------------------------


@activity.defn
async def route_decision(decision: dict[str, Any]) -> dict[str, Any]:
    """Fan out the side effects implied by a single decision.

    Returns a small audit dict describing what was done (or skipped).
    The caller (workflow) is responsible for the next iteration; this
    activity is one-shot and idempotent against a single decision.
    """
    decision_id = str(decision.get("id") or "")
    intent = str(decision.get("intent") or "").lower()
    source = str(decision.get("source") or "").lower()
    source_record = str(decision.get("source_record") or "")
    note = str(decision.get("note") or "")
    matter_ref = str(decision.get("matter_ref") or "")
    task_ref = str(decision.get("task_ref") or "")
    source_headline = str(decision.get("source_headline") or "")
    state = str(decision.get("state") or "open")
    existing_side_effects = decision.get("side_effects") or {}
    if not isinstance(existing_side_effects, dict):
        existing_side_effects = {}
    synchronous_flip = bool(existing_side_effects.get("synchronous_flip"))

    # Idempotency guard. The workflow only feeds this activity decisions
    # it listed in ``state=open``, but the activity is retried (Temporal
    # ``_ROUTE_RETRY``, maximum_attempts=3) and the workflow re-runs every
    # 60 s — so a decision can be re-presented here while a prior run is
    # mid-flight. A decision that has already advanced is skipped.
    #
    # ``dispatching`` (#55) is the non-terminal mark-before-dispatch state
    # written *before* the real agent dispatch on the ``intent=delegate``
    # path below. Before #55, route_decision POSTed the dispatch and only
    # *then* PATCHed the decision to ``executing`` — a run that died or
    # was retried between the dispatch POST and that PATCH re-entered with
    # the decision still ``open``, this guard missed, and the agent was
    # dispatched a SECOND time. Marking ``dispatching`` before the
    # dispatch closes that window: a crashed/retried run now finds the
    # decision ``dispatching`` and early-returns here WITHOUT re-firing.
    # Trade-off: a crash *between* the ``dispatching`` write and a
    # successful dispatch strands the decision in ``dispatching`` with no
    # agent run — a visible, sweepable stuck state (this WARNING + the
    # ``GET /api/v1/decisions/in-flight`` strip), strictly safer than a
    # silent double real-world dispatch.
    if state == "dispatching":
        logger.warning(
            "decision_router.route_decision: idempotency skip — "
            "decision=%s is 'dispatching' (mark-before-dispatch guard "
            "hit). If this decision never reaches 'executing' it is "
            "STUCK: a crash landed between the dispatching mark and the "
            "agent dispatch. created=%s — observable via "
            "GET /api/v1/decisions/in-flight",
            decision_id, str(decision.get("created") or "unknown"),
        )
        return {
            "id": decision_id,
            "skipped": True,
            "reason": "state=dispatching",
        }
    if state != "open":
        return {"id": decision_id, "skipped": True, "reason": f"state={state}"}

    if not decision_id or not intent or not source_record:
        # #369: this used to be a SILENT skip — the decision stayed
        # state=open and was re-fetched and re-skipped every 60s forever
        # (12 live orphans on home, written directly into the vault by an
        # out-of-repo tool without source_record, wedged 3-14 days).
        # Terminal-complete with a reason instead, mirroring the #313
        # source_card_missing retire pattern. Without source_record there
        # is no card to flip and no observation source — routing is
        # impossible, so completed-with-reason is the honest state.
        logger.warning(
            "decision_router.route_decision: decision=%s missing required "
            "fields (intent=%r source_record=%r) — retiring as completed "
            "with side_effects.decision_router=missing_source_record",
            decision_id, intent, source_record,
        )
        if decision_id:
            retired_side_effects = dict(existing_side_effects)
            retired_side_effects["decision_router"] = "missing_source_record"
            retired_side_effects["retired_at"] = (
                datetime.now(timezone.utc).isoformat()
            )
            try:
                async with _http() as client:
                    patch_resp = await client.patch(
                        f"/api/v1/decisions/{decision_id}",
                        json={
                            "state": "completed",
                            "side_effects": retired_side_effects,
                        },
                    )
                    patch_resp.raise_for_status()
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "decision_router.route_decision: retire PATCH failed "
                    "decision=%s err=%s — will retry next tick",
                    decision_id, exc,
                )
        return {
            "id": decision_id,
            "skipped": True,
            "reason": "missing required fields",
        }

    actions_taken: list[str] = []
    next_state = "completed"  # default — most intents are terminal
    side_effects: dict[str, Any] = dict(existing_side_effects)

    async with _http() as client:
        # ---- needs_attention card lifecycle ----
        if source == "needs_attention":
            # Strip "needs_attention/" prefix + ".md" suffix to get the id.
            na_id = (
                source_record.removeprefix("needs_attention/").removesuffix(".md")
            )
            if intent == "done":
                # If POST /api/v1/decisions already flipped the source
                # record synchronously (the common path now), skip the
                # second round-trip to avoid emitting a duplicate audit
                # event.
                if not synchronous_flip:
                    try:
                        resp = await client.post(
                            f"/api/v1/admin/needs-attention/{na_id}/done",
                            json={"note": note},
                        )
                        resp.raise_for_status()
                    except httpx.HTTPStatusError as exc:
                        if exc.response.status_code == 404:
                            # Card was deleted after the decision was minted.
                            # Terminal — retrying cannot restore a deleted card.
                            return await _retire_source_card_missing(
                                client, decision_id=decision_id, na_id=na_id,
                                intent=intent, existing_side_effects=side_effects,
                            )
                        raise  # 5xx / timeout → Temporal retries normally
                    actions_taken.append("needs_attention.done")
                    side_effects["needs_attention_audit"] = (
                        resp.json().get("audit_record_path")
                    )
                # F32 — closing the card must close the work it was about.
                # Before, the done branch only flipped the NA status, so a
                # linked task stayed open forever (#6). When the desk card
                # carries a ``task_ref`` (the underlying task/* the card was
                # raised against), PATCH it to ``status=done``. Best-effort:
                # a failed task close logs but never rolls back the NA flip
                # or the decision completion — the card is already handled.
                if task_ref.startswith("task/") and task_ref.endswith(".md"):
                    try:
                        tp = await client.patch(
                            f"/api/v1/vault/records/{task_ref}",
                            json={
                                "set": {
                                    "status": "done",
                                    "outcome": (
                                        f"closed via Desk 'done' on "
                                        f"decision/{decision_id}.md"
                                    ),
                                },
                            },
                        )
                        if tp.status_code < 400:
                            actions_taken.append("task.closed")
                            side_effects["closed_task"] = task_ref
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "decision_router: task close failed for %s on "
                            "done decision=%s: %s — NA flip stands",
                            task_ref, decision_id, exc,
                        )

                # #485 — an hours-proposal card is an approval, and approving
                # it must actually book the hours. Without this the card is
                # decorative, and worse than decorative: it looks like
                # approval happened while the ledger stays empty.
                try:
                    booked = await _accept_hours_proposal_if_any(
                        client, source_record, note, decision_id
                    )
                    if booked:
                        actions_taken.append("hours.accepted")
                        side_effects["hours_accepted"] = booked
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "decision_router: hours acceptance failed for %s on "
                        "decision=%s: %s — NA flip stands, proposal left open",
                        source_record, decision_id, exc,
                    )
            elif intent == "defer":
                # #5: resolve the resurface intent FIRST, independent of (and
                # before) the skip flip. The hourly DeferResurfaceWorkflow only
                # brings a ``skipped`` card back if it carries a ``resurface_at``;
                # if the resurface stamp is left to a fragile log-only path that
                # runs AFTER the skip, a parse miss buries the card forever.
                #
                # A defer NOTE expresses intent to come back. We turn it into a
                # concrete ``resurface_at`` via the clerk; if the clerk can't
                # parse a time (or fails entirely), we fall back to a default
                # horizon (the lenient "in a few days" = 3 days the defer prompt
                # itself uses) so the card is preserved, not dismissed. A
                # note-LESS defer is a deliberate dismiss — no resurface.
                import src.activities.defer_resurface as _defer_mod

                resurface_at: str | None = None
                resurface_reasoning: str | None = None
                if note:
                    try:
                        parsed = await _defer_mod.parse_resurface_time(note)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "decision_router: resurface parsing raised for %s: %s "
                            "— falling back to default horizon",
                            na_id, exc,
                        )
                        parsed = None
                    if isinstance(parsed, dict):
                        cand = parsed.get("resurface_at")
                        if isinstance(cand, str) and cand:
                            resurface_at = cand
                        resurface_reasoning = parsed.get("reasoning")
                    if not resurface_at:
                        # Parse miss/failure on a noted defer: don't lose the
                        # card. Default to +3 days at ~09:00 UTC.
                        fallback = (
                            datetime.now(timezone.utc) + timedelta(days=3)
                        ).replace(hour=9, minute=0, second=0, microsecond=0)
                        resurface_at = fallback.isoformat()
                        if not resurface_reasoning:
                            resurface_reasoning = (
                                "default horizon (no concrete time parsed)"
                            )
                        logger.info(
                            "decision_router: defer note for %s carried no "
                            "parseable time; defaulting resurface_at=%s",
                            na_id, resurface_at,
                        )

                # Stamp the resurface BEFORE the skip flip so a crash between
                # the two never leaves a skipped, un-resurfaceable card. The
                # stamp is its own ctrl-api PATCH; the skip flip follows.
                if resurface_at:
                    try:
                        await _defer_mod.stamp_resurface_on_needs_attention(
                            na_id, resurface_at, note,
                        )
                        actions_taken.append(
                            "needs_attention.resurface_scheduled"
                        )
                        side_effects["resurface_at"] = resurface_at
                        side_effects["resurface_reasoning"] = resurface_reasoning
                    except Exception as exc:  # noqa: BLE001
                        # A failed stamp must NOT be swallowed silently into a
                        # permanent skip — re-raise so Temporal retries the
                        # whole activity before the card is flipped to skipped.
                        logger.warning(
                            "decision_router: resurface stamp failed for %s: %s "
                            "— re-raising before skip flip",
                            na_id, exc,
                        )
                        raise

                if not synchronous_flip:
                    try:
                        resp = await client.post(
                            f"/api/v1/admin/needs-attention/{na_id}/skip",
                            json={"note": note},
                        )
                        resp.raise_for_status()
                    except httpx.HTTPStatusError as exc:
                        if exc.response.status_code == 404:
                            return await _retire_source_card_missing(
                                client, decision_id=decision_id, na_id=na_id,
                                intent=intent, existing_side_effects=side_effects,
                            )
                        raise
                    actions_taken.append("needs_attention.skip")
                    side_effects["needs_attention_audit"] = (
                        resp.json().get("audit_record_path")
                    )
            elif intent == "delegate":
                # Schedule-or-dispatch. If the principal's note carries a
                # "when" phrase (e.g. "send Adam Wednesday morning"),
                # we don't dispatch now — we flip the decision to
                # state=scheduled with execute_at stamped. The
                # ScheduledDispatchWorkflow (every 15 min) picks it up
                # when due and triggers the actual dispatch.
                #
                # Otherwise: real signal re-arm via the dispatch endpoint,
                # decision → executing, wait for outcome.
                execute_at = None
                schedule_reasoning = None
                if note:
                    try:
                        from src.activities.defer_resurface import (
                            parse_resurface_time,
                        )
                        parsed = await parse_resurface_time(
                            note, intent="delegate",
                        )
                        if isinstance(parsed, dict):
                            cand = parsed.get("resurface_at")
                            if isinstance(cand, str) and cand:
                                execute_at = cand
                                schedule_reasoning = parsed.get("reasoning")
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "delegate scheduling parse failed for %s: %s",
                            decision_id, exc,
                        )

                if execute_at:
                    # Scheduled: don't dispatch now.
                    # Flip source record from "dispatched" (sync optimistic)
                    # back to "scheduled" with execute_at stamped, so
                    # /desk and /matters reflect the right state.
                    await client.patch(
                        f"/api/v1/vault/records/needs_attention/{na_id}.md",
                        json={
                            "set": {
                                "status": "scheduled",
                                "execute_at": execute_at,
                                "schedule_note": note,
                            },
                        },
                    )
                    actions_taken.append("needs_attention.scheduled")
                    side_effects["execute_at"] = execute_at
                    if schedule_reasoning:
                        side_effects["schedule_reasoning"] = schedule_reasoning
                    side_effects["scheduled_for"] = execute_at
                    # Stamp execute_at on the decision itself so
                    # ScheduledDispatchWorkflow can find it.
                    next_state = "scheduled"
                else:
                    # No time-bearing note → fire dispatch now.
                    #
                    # #55 — mark-before-dispatch. Write the non-terminal
                    # ``dispatching`` state on the decision BEFORE the
                    # agent dispatch POST so the idempotency guard at the
                    # top of this activity catches a crashed/retried run
                    # and does NOT re-fire. The dispatch endpoint
                    # (``POST .../needs-attention/{na_id}/dispatch``)
                    # re-arms the source signal and triggers a real agent
                    # run — a non-idempotent side effect. Without this
                    # mark, a run that dies between a successful dispatch
                    # and the terminal ``state=executing`` PATCH at the
                    # bottom of this activity re-enters with the decision
                    # still ``open``, the guard misses, and the agent is
                    # dispatched a second time.
                    #
                    # ``dispatching`` is deliberately NOT ``executing``:
                    # ``check_decision_outcomes`` polls ``executing``
                    # decisions waiting for an outcome signal. If we set
                    # ``executing`` before the dispatch and the dispatch
                    # then failed, that poller would wait forever on a
                    # decision that never got an agent run. A
                    # ``dispatching`` decision is invisible to the poller.
                    #
                    # The mark write itself must succeed before we
                    # dispatch — if it fails we re-raise rather than
                    # dispatch unguarded, so Temporal retries the whole
                    # activity from a clean ``open`` state (no agent run
                    # has happened yet).
                    try:
                        mark = await client.patch(
                            f"/api/v1/decisions/{decision_id}",
                            json={"state": "dispatching"},
                        )
                        mark.raise_for_status()
                    except httpx.HTTPError as exc:
                        logger.warning(
                            "decision_router.route_decision: pre-dispatch "
                            "'dispatching' mark failed decision=%s err=%s "
                            "— re-raising before dispatch (no agent run "
                            "yet)",
                            decision_id, exc,
                        )
                        raise

                    try:
                        resp = await client.post(
                            f"/api/v1/admin/needs-attention/{na_id}/dispatch",
                            json={
                                "note": note,
                                "decision_origin": f"decision/{decision_id}.md",
                            },
                        )
                        resp.raise_for_status()
                    except httpx.HTTPStatusError as exc:
                        if exc.response.status_code == 404:
                            return await _retire_source_card_missing(
                                client, decision_id=decision_id, na_id=na_id,
                                intent=intent, existing_side_effects=side_effects,
                            )
                        raise
                    actions_taken.append("needs_attention.dispatch")
                    if not synchronous_flip:
                        side_effects["needs_attention_audit"] = (
                            resp.json().get("audit_record_path")
                        )
                    re_routed_signal = resp.json().get("re_routed_signal")
                    side_effects["re_routed_signal"] = re_routed_signal

                    # #218 — Lane I's #216 fix marks the re-routed signal
                    # ``status=routed_agent`` at mint time so
                    # SignalRouterWorkflow's ``status='unrouted'`` filter
                    # never picks it up — kills the runaway re-dispatch
                    # loop. The side effect: ``signal_actions.route_signal_action``'s
                    # ``principal_delegate_override`` branch (the prior
                    # caller of ``dispatch_action_to_agent`` for delegate
                    # clicks) is now unreachable from this path. So
                    # DecisionRouter has to fire the agent directly here.
                    #
                    # Idempotency:
                    #   * The state guard above (state != "open") catches
                    #     a re-tick once we PATCH to ``executing`` below.
                    #   * The ``dispatching`` guard catches a crashed/retried
                    #     run between the mark and the executing PATCH.
                    #   * Belt-and-suspenders: ``side_effects.agent_dispatched``
                    #     is checked here so a re-route triggered through
                    #     any other path (ops manual replay, an
                    #     out-of-band state reset) does not re-fire.
                    #
                    # Failure handling: a dispatch failure (clerk timeout,
                    # Hermes 5xx) is NON-fatal — we still flip the decision
                    # to ``executing`` and stamp ``agent_dispatch_error``
                    # for observability. The ctrl-api /dispatch POST above
                    # already stamped ``decision_origin`` on the re-routed
                    # signal so an outcome that DOES land (via a separate
                    # path) is still matched back to this decision by
                    # ``check_decision_outcomes``.
                    already_dispatched = bool(
                        side_effects.get("agent_dispatched")
                    )
                    if not already_dispatched:
                        # Pull action_proposal / target_path / matched_instinct
                        # off the re-routed signal so we can construct the
                        # canonical dispatch call. Best-effort: a signal read
                        # failure logs + falls back to a minimal proposal
                        # built from the decision's source_headline so the
                        # agent still has something to act on.
                        proposal: dict[str, Any] = {}
                        target_path_for_dispatch: str | None = None
                        matched_instinct_path = ""
                        if (
                            isinstance(re_routed_signal, str)
                            and re_routed_signal
                        ):
                            try:
                                from src.utils.signal_state import (
                                    read_signal_record,
                                )
                                sig_rec = await read_signal_record(
                                    re_routed_signal,
                                )
                                if isinstance(sig_rec, dict):
                                    sig_fm = sig_rec.get("frontmatter") or {}
                                    if isinstance(sig_fm, dict):
                                        raw_proposal = sig_fm.get(
                                            "action_proposal"
                                        )
                                        if isinstance(raw_proposal, dict):
                                            proposal = raw_proposal
                                        elif isinstance(raw_proposal, str):
                                            try:
                                                import json as _json
                                                cand = _json.loads(raw_proposal)
                                                if isinstance(cand, dict):
                                                    proposal = cand
                                            except (
                                                ValueError, TypeError
                                            ):
                                                proposal = {}
                                        tp_raw = sig_fm.get("target_path")
                                        if (
                                            isinstance(tp_raw, str)
                                            and tp_raw.strip()
                                        ):
                                            target_path_for_dispatch = (
                                                tp_raw.strip()
                                            )
                                        mi_raw = sig_fm.get("matched_instinct")
                                        if (
                                            isinstance(mi_raw, str)
                                            and mi_raw.strip()
                                        ):
                                            matched_instinct_path = (
                                                mi_raw.strip()
                                            )
                            except Exception as exc:  # noqa: BLE001
                                logger.warning(
                                    "decision_router.route_decision: "
                                    "signal read for delegate dispatch "
                                    "failed decision=%s signal=%s err=%s "
                                    "— falling back to minimal proposal",
                                    decision_id, re_routed_signal, exc,
                                )

                        if not proposal.get("what"):
                            # The principal's note (if any) IS the task
                            # — but even with no note, source_headline
                            # is what the principal saw on the card.
                            proposal = dict(proposal)
                            proposal["what"] = (
                                note or source_headline
                                or f"Handle decision/{decision_id}.md"
                            )

                        try:
                            dispatch_result = await dispatch_action_to_agent(
                                proposal,
                                target_path_for_dispatch,
                                matched_instinct_path,
                                source_signal_path=(
                                    re_routed_signal
                                    if isinstance(re_routed_signal, str)
                                    else ""
                                ),
                                principal_note=note,
                            )
                            side_effects["agent_dispatched"] = True
                            if isinstance(dispatch_result, dict):
                                outcome_signal = dispatch_result.get(
                                    "outcome_signal_path"
                                )
                                if outcome_signal:
                                    side_effects["agent_outcome_signal"] = (
                                        outcome_signal
                                    )
                                summary = dispatch_result.get(
                                    "agent_response_summary"
                                )
                                if isinstance(summary, str) and summary:
                                    side_effects[
                                        "agent_response_summary"
                                    ] = summary
                            actions_taken.append("agent.dispatched")
                        except Exception as exc:  # noqa: BLE001
                            # Non-fatal. The decision still advances to
                            # executing so check_decision_outcomes can
                            # match any outcome that lands via the
                            # ctrl-api decision_origin chain.
                            err_msg = str(exc)[:500]
                            side_effects["agent_dispatch_error"] = err_msg
                            actions_taken.append("agent.dispatch_failed")
                            logger.warning(
                                "decision_router.route_decision: "
                                "dispatch_action_to_agent failed "
                                "decision=%s signal=%s err=%s — "
                                "decision still advancing to executing",
                                decision_id, re_routed_signal, exc,
                            )

                    # Wait for the agent outcome before terminal flip.
                    next_state = "executing"
            elif intent == "noise":
                # OBS-8: noise clicks no longer materialise a
                # signal_noise_pattern record. The principal's gesture
                # now flows through the canonical observation pool:
                # the synchronous flip already set status=noise +
                # wrote the audit event; OBS-1 will write an
                # observation from this decision (subject=principal,
                # intent=noise) which feeds OBS-4's clusterer. After
                # MIN_CLUSTER_SIZE noise clicks on the same sender_key
                # accumulate, OBS-4 surfaces a pattern_proposal on
                # /desk; Sir adopts it → OBS-5 mints a noise instinct
                # → signal_extract pre-filter
                # (noise_patterns.load_noise_instincts) autonomously
                # suppresses future matches.
                #
                # Existing signal_noise_pattern records keep filtering
                # via the legacy load_active_noise_patterns path until
                # they age out. New ones are not written here.
                actions_taken.append("noise.observation_pending")
            elif intent == "take_mine":
                # Spawn a to_do. needs_attention itself stays pending so
                # the principal can still close it formally later via
                # the desk's "done" path if they want.
                todo_resp = await client.post(
                    "/api/v1/todos",
                    json={
                        "headline": source_headline or f"Handle {na_id}",
                        "decision_origin": f"decision/{decision_id}.md",
                        "source_record": source_record,
                        "matter_ref": matter_ref or None,
                    },
                )
                todo_resp.raise_for_status()
                actions_taken.append("todo.spawn")
                side_effects["todo_path"] = todo_resp.json().get("path")

        # ---- approval card lifecycle ----
        elif source == "approval":
            # Approvals are addressed by their full vault path
            # (encoded). The route_signal_action endpoints already
            # accept this shape.
            from urllib.parse import quote

            encoded = quote(source_record, safe="")
            if intent == "delegate" and not synchronous_flip:
                resp = await client.post(
                    f"/api/v1/approvals/{encoded}/approve",
                )
                resp.raise_for_status()
                actions_taken.append("approval.approve")
                next_state = "executing"
            elif intent == "done" and not synchronous_flip:
                resp = await client.post(
                    f"/api/v1/approvals/{encoded}/approve",
                )
                resp.raise_for_status()
                actions_taken.append("approval.approve")
                next_state = "executing"
            elif intent == "defer":
                # No native defer endpoint; decision record IS the audit.
                actions_taken.append("approval.defer_recorded")
            elif intent == "take_mine":
                todo_resp = await client.post(
                    "/api/v1/todos",
                    json={
                        "headline": source_headline or f"Handle {source_record}",
                        "decision_origin": f"decision/{decision_id}.md",
                        "source_record": source_record,
                        "matter_ref": matter_ref or None,
                    },
                )
                todo_resp.raise_for_status()
                actions_taken.append("todo.spawn")
                side_effects["todo_path"] = todo_resp.json().get("path")

        # ---- judgment card lifecycle ----
        elif source == "judgment":
            # Judgments are observations; the only side-effect available
            # is take_mine → spawn a to_do. Everything else is captured
            # by the decision record itself.
            if intent == "take_mine":
                todo_resp = await client.post(
                    "/api/v1/todos",
                    json={
                        "headline": source_headline or f"Act on {source_record}",
                        "decision_origin": f"decision/{decision_id}.md",
                        "source_record": source_record,
                        "matter_ref": matter_ref or None,
                    },
                )
                todo_resp.raise_for_status()
                actions_taken.append("todo.spawn")
                side_effects["todo_path"] = todo_resp.json().get("path")
            else:
                actions_taken.append(f"judgment.{intent}_recorded")

        # ---- to_do card lifecycle (Backstage "Done" button) ----
        elif source == "to_do":
            todo_id = (
                source_record.removeprefix("to_do/").removesuffix(".md")
            )
            if intent == "done":
                resp = await client.patch(
                    f"/api/v1/todos/{todo_id}",
                    json={"state": "completed"},
                )
                resp.raise_for_status()
                actions_taken.append("todo.complete")

        # ---- pattern_proposal lifecycle (the learning-loop closer) ----
        # When the principal clicks Delegate on a pattern-proposal card,
        # the rule gets materialized as an active instinct. Delete
        # marks it rejected (won't be re-proposed). Defer goes through
        # the normal resurface flow. take_mine spawns a to_do so the
        # principal can review the proposed rule manually.
        elif source == "pattern_proposal":
            from src.activities.decision_observations import (
                adopt_instinct_from_pattern,
                reject_pattern_proposal,
            )
            if intent == "delegate":
                result = await adopt_instinct_from_pattern(source_record)
                if result.get("ok"):
                    actions_taken.append("pattern.adopted")
                    side_effects["instinct_path"] = result.get("instinct_path")
                else:
                    actions_taken.append("pattern.adopt_failed")
                    side_effects["reason"] = result.get("reason")
            elif intent == "done" and not synchronous_flip:
                result = await reject_pattern_proposal(source_record)
                actions_taken.append(
                    "pattern.rejected" if result.get("ok") else "pattern.reject_failed"
                )
            elif intent == "take_mine":
                # Spawn a to_do "review this proposed rule manually".
                todo_resp = await client.post(
                    "/api/v1/todos",
                    json={
                        "headline": source_headline or "Review proposed rule",
                        "decision_origin": f"decision/{decision_id}.md",
                        "source_record": source_record,
                        "matter_ref": matter_ref or None,
                    },
                )
                todo_resp.raise_for_status()
                actions_taken.append("todo.spawn")
                side_effects["todo_path"] = todo_resp.json().get("path")
            elif intent == "defer":
                # Synchronous flip already set status=deferred. We
                # still want resurface parsing on the principal's note
                # since the synchronous code path doesn't call clerk.
                if not synchronous_flip:
                    await client.patch(
                        f"/api/v1/vault/records/{source_record}",
                        json={"set": {"status": "deferred"}},
                    )
                    actions_taken.append("pattern.deferred")
                if note:
                    try:
                        from src.activities.defer_resurface import (
                            parse_resurface_time,
                        )
                        parsed = await parse_resurface_time(note)
                        ra = parsed.get("resurface_at") if isinstance(parsed, dict) else None
                        if isinstance(ra, str) and ra:
                            await client.patch(
                                f"/api/v1/vault/records/{source_record}",
                                json={
                                    "set": {
                                        "resurface_at": ra,
                                        "defer_note": note,
                                    },
                                },
                            )
                            side_effects["resurface_at"] = ra
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "pattern defer: resurface parse failed for %s: %s",
                            source_record, exc,
                        )

        # ---- Atomic state transition on the decision ----
        now_iso = datetime.now(timezone.utc).isoformat()
        patch_body: dict[str, Any] = {"state": next_state}
        if next_state == "executing":
            patch_body["executing_at"] = now_iso
        elif next_state == "completed":
            patch_body["completed_at"] = now_iso
        elif next_state == "scheduled":
            patch_body["scheduled_at"] = now_iso
            sf_execute_at = side_effects.get("execute_at") if isinstance(side_effects, dict) else None
            if isinstance(sf_execute_at, str):
                patch_body["execute_at"] = sf_execute_at
            sf_reason = side_effects.get("schedule_reasoning") if isinstance(side_effects, dict) else None
            if isinstance(sf_reason, str):
                patch_body["scheduled_reasoning"] = sf_reason
        if side_effects:
            patch_body["side_effects"] = side_effects
        patch = await client.patch(
            f"/api/v1/decisions/{decision_id}",
            json=patch_body,
        )
        patch.raise_for_status()

    # ---- Extract an observation from the decision (training data
    # for the intuition engine). Runs OUT of the http context — its
    # own httpx + vault writes via VaultClient. Best-effort: failures
    # log but don't roll back the decision routing.
    try:
        from src.activities.decision_observations import (
            extract_observation_from_decision,
        )
        obs = await extract_observation_from_decision(decision)
        obs_path = obs.get("observation_path") if isinstance(obs, dict) else None
        if obs_path:
            actions_taken.append("observation.extracted")
            side_effects["observation_path"] = obs_path
            # Reflect the observation_path on the decision record so
            # the audit trail is symmetric.
            async with _http() as client2:
                await client2.patch(
                    f"/api/v1/decisions/{decision_id}",
                    json={"side_effects": side_effects},
                )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "decision_router: observation extraction failed for %s: %s",
            decision_id, exc,
        )

    logger.info(
        "decision_router: decision=%s intent=%s source=%s -> %s (actions=%s)",
        decision_id, intent, source, next_state, ",".join(actions_taken),
    )
    return {
        "id": decision_id,
        "intent": intent,
        "source": source,
        "next_state": next_state,
        "actions": actions_taken,
        "side_effects": side_effects,
    }


# ---------------------------------------------------------------------
# Reverse routing (state=reversed → run inverse side-effects)
# ---------------------------------------------------------------------


@activity.defn
async def reverse_decision(decision: dict[str, Any]) -> dict[str, Any]:
    """Undo the side-effects of a decision flipped to state=reversed.

    Best-effort: external effects (agent dispatches that already
    completed) cannot be rewound; this function flips local state back
    so the desk card reopens, and stamps a marker on the decision so
    the workflow doesn't reprocess it.
    """
    decision_id = str(decision.get("id") or "")
    intent = str(decision.get("intent") or "").lower()
    source = str(decision.get("source") or "").lower()
    source_record = str(decision.get("source_record") or "")
    side_effects = decision.get("side_effects") or {}

    actions_undone: list[str] = []
    async with _http() as client:
        # needs_attention reversal: PATCH the source record's status
        # back to pending so it reappears in the queue.
        if source == "needs_attention":
            na_id = (
                source_record.removeprefix("needs_attention/").removesuffix(".md")
            )
            # ctrl-api doesn't have a dedicated "reopen" endpoint, but
            # the underlying patch helper accepts arbitrary status.
            # We use the workspace records endpoint to PATCH the source
            # frontmatter directly.
            patch = await client.patch(
                f"/api/v1/vault/records/needs_attention/{na_id}.md",
                json={
                    "set": {
                        "status": "pending",
                        "resolved_at": "",
                        "resolution_note": "",
                    },
                },
            )
            if patch.status_code < 400:
                actions_undone.append("needs_attention.reopen")

        # to_do reversal: cancel the spawned to_do (if any).
        if intent == "take_mine":
            todo_path = (side_effects or {}).get("todo_path")
            if isinstance(todo_path, str) and todo_path.startswith("to_do/"):
                todo_id = todo_path.removeprefix("to_do/").removesuffix(".md")
                resp = await client.patch(
                    f"/api/v1/todos/{todo_id}",
                    json={"state": "cancelled"},
                )
                if resp.status_code < 400:
                    actions_undone.append("todo.cancel")

        # to_do "done" reversal: re-open the to_do.
        if source == "to_do" and intent == "done":
            todo_id = source_record.removeprefix("to_do/").removesuffix(".md")
            resp = await client.patch(
                f"/api/v1/todos/{todo_id}",
                json={"state": "open"},
            )
            if resp.status_code < 400:
                actions_undone.append("todo.reopen")

        # Stamp the decision so we don't reprocess on the next tick.
        # Move state from "reversed" to a terminal-but-distinct marker
        # by simply appending a side_effects key.
        next_side_effects = dict(side_effects)
        next_side_effects["reversal_processed"] = True
        next_side_effects["reversal_undone"] = actions_undone
        await client.patch(
            f"/api/v1/decisions/{decision_id}",
            json={"side_effects": next_side_effects},
        )

    logger.info(
        "decision_router: reversed decision=%s intent=%s actions=%s",
        decision_id, intent, ",".join(actions_undone),
    )
    return {
        "id": decision_id,
        "actions_undone": actions_undone,
    }


# ---------------------------------------------------------------------
# Outcome linkage (state=executing → completed when outcome arrives)
# ---------------------------------------------------------------------


@activity.defn
async def check_decision_outcomes() -> dict[str, Any]:
    """Scan executing decisions and stamp outcome_record when one lands.

    Strategy: for each executing decision, the source signal carries a
    ``decision_origin`` field pointing back to our decision path.
    Outcome signals written by completed agent runs reference the
    original signal via ``source_signal_path``. We list recent
    ``signal/*.md`` records, filter to those with a fresh outcome
    field, and match by source_signal_path or by direct decision_origin
    chain.

    Returns ``{checked, matched, matches}`` where ``matches`` is a list
    of dicts shaped for SM-D-W7's downstream task-outcome linkage. Each
    match carries ``{decision_id, outcome_record, task_ref, intent,
    source_record, source_headline}`` so the workflow can route the
    task-side ``status="closed" + outcome=...`` write through
    ``apply_state_change_v2`` under its patched gate. Older callers
    that only read ``checked`` / ``matched`` keep working unchanged.
    """
    matched = 0
    match_records: list[dict[str, Any]] = []
    async with _http() as client:
        # 1. Get executing decisions.
        resp = await client.get("/api/v1/decisions?state=executing&limit=200")
        resp.raise_for_status()
        executing = resp.json().get("decisions", []) or []
        if not executing:
            return {"checked": 0, "matched": 0, "matches": []}

        # 2. Get recent agent-outcome signals from state.db (storage
        # cutover #27). Outcomes are ``signal`` rows with
        # ``source="agent_outcome"`` that carry ``source_signal_path``
        # in their payload, referencing the upstream signal. Replaces
        # the old ``GET /api/v1/vault/list/signal`` markdown walk.
        from src.config import load_config
        from src.utils.signal_state import StateClient, signal_row_to_record

        cfg = load_config()
        outcome_by_source: dict[str, str] = {}
        try:
            async with StateClient(cfg) as sc:
                outcome_rows = await sc.list_signals(
                    source="agent_outcome", limit=200,
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "decision_router.check_decision_outcomes: state.db signal "
                "query failed err=%s", exc,
            )
            return {"checked": len(executing), "matched": 0, "matches": []}

        # Build a quick map: source_signal_path → outcome signal id.
        for s in outcome_rows:
            rec = signal_row_to_record(s)
            fm = rec.get("frontmatter") or {}
            ssp = fm.get("source_signal_path")
            if isinstance(ssp, str) and ssp.strip():
                # Newer outcome signal that points back to an older one.
                outcome_by_source[ssp] = rec.get("id") or ""

        # 3. For each executing decision, locate its source signal,
        # check for an outcome.
        for d in executing:
            decision_id = str(d.get("id") or "")
            side_effects = d.get("side_effects") or {}
            source_signal = (side_effects or {}).get("re_routed_signal")
            if not isinstance(source_signal, str) or not source_signal:
                continue
            outcome = outcome_by_source.get(source_signal)
            if not outcome:
                continue
            # Match! Stamp the outcome on the decision and flip state.
            await client.patch(
                f"/api/v1/decisions/{decision_id}",
                json={
                    "state": "completed",
                    "outcome_record": outcome,
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                },
            )
            matched += 1

            # SM-D-W7 — surface the match so the workflow can route the
            # task-side closure through state_mutator v2. Only decisions
            # with a non-empty ``task_ref`` are eligible (otherwise the
            # decision doesn't speak to a specific task and there's
            # nothing to flip).
            match_records.append({
                "decision_id": decision_id,
                "outcome_record": outcome,
                "task_ref": str(d.get("task_ref") or "").strip(),
                "intent": str(d.get("intent") or "").strip(),
                "source_record": str(d.get("source_record") or "").strip(),
                "source_headline": str(d.get("source_headline") or "").strip(),
            })

    if matched:
        logger.info("decision_router: matched %d outcomes", matched)
    return {
        "checked": len(executing) if executing else 0,
        "matched": matched,
        "matches": match_records,
    }


# ---------------------------------------------------------------------
# SM-D-W7 — state-mutator v2 outcome-link propose function + wrapper.
# ---------------------------------------------------------------------
#
# When the cascade closes the delegate loop (state=executing →
# state=completed with outcome_record stamped on the decision), the
# original task associated with the decision should also flip to
# ``status="closed"`` + ``outcome=<short summary referencing the
# outcome record>``. The decision-side write above already lands
# verbatim — this is the additional task-side write that closes the
# universal-contract loop.
#
# Deterministic: confidence=1.0. The decision cascade itself has
# already passed the principal's confidence gate (they clicked
# Delegate) and the outcome signal has materialised — there is no
# remaining LLM judgment to make.


@propose_fn("decision_router.outcome_link")
async def propose_decision_outcome_link(
    *,
    target: dict[str, Any],
    observed: ObservedWindow,
    args: dict[str, Any],
) -> ProposedMutation | None:
    """Translate a completed delegate-loop into a task closure mutation.

    ``args`` carries:
      * ``decision_id`` (str)
      * ``outcome_record`` (str) — vault path to the outcome signal
      * ``intent`` (str) — typically "delegate"
      * ``source_headline`` (str, optional)

    Returns ``None`` when the task is already closed/archived (so a
    re-tick of ``check_decision_outcomes`` doesn't double-stamp the
    audit). Otherwise proposes ``status="closed"`` + ``outcome=<short
    pointer to the outcome record>``. Confidence is 1.0 — the cascade
    already passed Sir's gate; this is bookkeeping.
    """
    fm = target.get("frontmatter") or {}
    if isinstance(fm, dict):
        current_status = str(fm.get("status") or "").strip().lower()
        if current_status in ("closed", "archived", "cancelled", "canceled", "done"):
            return None

    decision_id = str(args.get("decision_id") or "").strip()
    outcome_record = str(args.get("outcome_record") or "").strip()
    intent = str(args.get("intent") or "delegate").strip()
    source_headline = str(args.get("source_headline") or "").strip()

    if not outcome_record:
        return None

    outcome = (
        f"resolved by outcome {outcome_record}"
        if not source_headline
        else f"resolved by outcome {outcome_record} ({source_headline})"
    )[:500]

    reason = (
        f"DecisionRouter outcome linkage: decision={decision_id} "
        f"intent={intent} delivered outcome={outcome_record!r}; closing task."
    )[:500]

    return ProposedMutation(
        fields={"status": "closed", "outcome": outcome},
        reason=reason,
        confidence=1.0,
        fan_out=(),
    )


@activity.defn
async def apply_decision_outcome_link_v2(
    task_path: str,
    decision_id: str,
    outcome_record: str,
    intent: str,
    source_headline: str,
    mode: str = "live",
) -> dict[str, Any]:
    """Workflow-callable wrapper around ``apply_state_change_v2``.

    Best-effort: a v2 failure logs + returns ``{applied: False, error:
    ...}`` so a transient ctrl-api blip on one match doesn't break the
    rest of the tick. The decision-side state flip has already landed
    above; this wrapper just adds the task-side audit + write.
    """
    if mode not in ("shadow", "live"):
        mode = "live"

    now = datetime.now(timezone.utc)
    observed = ObservedWindow(
        start=now,
        end=now,
        signal_paths=[outcome_record] if outcome_record else [],
        decision_paths=[f"decision/{decision_id}.md"] if decision_id else [],
        other_refs=[],
    )

    try:
        result = await apply_state_change_v2(
            target_path=task_path,
            source="decision_router.outcome_link",
            observed=observed,
            propose_fn_name="decision_router.outcome_link",
            propose_fn_args={
                "decision_id": decision_id,
                "outcome_record": outcome_record,
                "intent": intent,
                "source_headline": source_headline,
            },
            mode=mode,  # type: ignore[arg-type]
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "decision_router.apply_decision_outcome_link_v2: v2 call failed "
            "task=%s decision=%s err=%s",
            task_path, decision_id, exc,
        )
        return {"applied": False, "error": str(exc)[:300]}

    return {
        "applied": bool(result.applied),
        "audit_record_path": result.audit_record_path,
        "timeline_entry_id": result.timeline_entry_id,
        "new_as_of": result.new_as_of,
        "effective_mode": result.effective_mode,
        "pending_confirmation": result.pending_confirmation,
    }
