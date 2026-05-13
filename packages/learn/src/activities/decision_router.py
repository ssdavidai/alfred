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
  Decision state flips to ``executing`` and waits for the outcome.
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
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config

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
    source_headline = str(decision.get("source_headline") or "")
    state = str(decision.get("state") or "open")
    existing_side_effects = decision.get("side_effects") or {}
    if not isinstance(existing_side_effects, dict):
        existing_side_effects = {}
    synchronous_flip = bool(existing_side_effects.get("synchronous_flip"))

    if state != "open":
        return {"id": decision_id, "skipped": True, "reason": f"state={state}"}

    if not decision_id or not intent or not source_record:
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
                    resp = await client.post(
                        f"/api/v1/admin/needs-attention/{na_id}/done",
                        json={"note": note},
                    )
                    resp.raise_for_status()
                    actions_taken.append("needs_attention.done")
                    side_effects["needs_attention_audit"] = (
                        resp.json().get("audit_record_path")
                    )
            elif intent == "defer":
                if not synchronous_flip:
                    resp = await client.post(
                        f"/api/v1/admin/needs-attention/{na_id}/skip",
                        json={"note": note},
                    )
                    resp.raise_for_status()
                    actions_taken.append("needs_attention.skip")
                    side_effects["needs_attention_audit"] = (
                        resp.json().get("audit_record_path")
                    )
                # Resurface parsing always runs — the synchronous flip
                # doesn't call clerk. If the principal's defer note
                # carries a "when", turn it into a concrete
                # resurface_at; DeferResurfaceWorkflow (hourly) will
                # flip status back to pending when due.
                if note:
                    try:
                        from src.activities.defer_resurface import (
                            parse_resurface_time,
                            stamp_resurface_on_needs_attention,
                        )
                        parsed = await parse_resurface_time(note)
                        ra = parsed.get("resurface_at") if isinstance(parsed, dict) else None
                        if isinstance(ra, str) and ra:
                            await stamp_resurface_on_needs_attention(
                                na_id, ra, note,
                            )
                            actions_taken.append("needs_attention.resurface_scheduled")
                            side_effects["resurface_at"] = ra
                            side_effects["resurface_reasoning"] = (
                                parsed.get("reasoning") if isinstance(parsed, dict) else None
                            )
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "decision_router: resurface parsing failed for %s: %s",
                            na_id, exc,
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
                        parsed = await parse_resurface_time(note)
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
                    resp = await client.post(
                        f"/api/v1/admin/needs-attention/{na_id}/dispatch",
                        json={
                            "note": note,
                            "decision_origin": f"decision/{decision_id}.md",
                        },
                    )
                    resp.raise_for_status()
                    actions_taken.append("needs_attention.dispatch")
                    if not synchronous_flip:
                        side_effects["needs_attention_audit"] = (
                            resp.json().get("audit_record_path")
                        )
                    side_effects["re_routed_signal"] = (
                        resp.json().get("re_routed_signal")
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
        from datetime import datetime, timezone
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
    """
    matched = 0
    async with _http() as client:
        # 1. Get executing decisions.
        resp = await client.get("/api/v1/decisions?state=executing&limit=200")
        resp.raise_for_status()
        executing = resp.json().get("decisions", []) or []
        if not executing:
            return {"checked": 0, "matched": 0}

        # 2. Get recent signals — outcomes are written as signals and
        # tagged with `source_signal_path` referencing the upstream.
        sigs_resp = await client.get(
            "/api/v1/vault/list/signal?preview=200",
        )
        if sigs_resp.status_code >= 400:
            return {"checked": len(executing), "matched": 0}
        signals = sigs_resp.json().get("results", []) or []

        # Build a quick map: source_signal_path → outcome signal path.
        outcome_by_source: dict[str, str] = {}
        for s in signals:
            fm = s.get("frontmatter") if isinstance(s, dict) else None
            if not isinstance(fm, dict):
                continue
            ssp = fm.get("source_signal_path")
            if isinstance(ssp, str) and ssp.strip():
                # Newer signal that points back to an older one — treat
                # the newer one as a potential outcome.
                outcome_by_source[ssp] = str(s.get("path") or "")

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
            from datetime import datetime, timezone
            await client.patch(
                f"/api/v1/decisions/{decision_id}",
                json={
                    "state": "completed",
                    "outcome_record": outcome,
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                },
            )
            matched += 1

    if matched:
        logger.info("decision_router: matched %d outcomes", matched)
    return {"checked": len(executing) if executing else 0, "matched": matched}
