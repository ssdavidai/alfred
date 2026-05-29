"""HaBootstrapWorkflow Phase A + B + C — registry pull + gap + proposal (#110 PR5/PR6).

Pulls the operator-configured Home Assistant install's full entity /
area / device / automation surface every 6 hours (Temporal schedule
``al-ha-bootstrap``) and on demand from the HaCard "Refresh registry"
CTA. Writes the result into ``ha_registry`` via ctrl-api's bulk-upsert
route which also tombstones (does NOT delete) entities that vanished
from HA since the previous run.

Phase B (PR6, this file) — once the registry refresh completes, scan
the registry for missing baseline patterns ("no morning routine", "no
motion lighting", …) and write rows into ``ha_gap``.

Phase C (PR6, this file) — for each newly-opened gap, template a
concrete ``ha_proposal`` row (YAML automation pasted into the
principal's vault as ``pending``). The existing PR4 apply route is
what the principal clicks on the HaCard to ship it.

The workflow itself is a thin orchestrator over the activities:

  ``pull_ha_registry()``    — read ctrl-api status + LLAT, hit HA REST
                               in parallel, normalise into bulk-row shape.
  ``write_ha_registry()``   — POST to ctrl-api's bulk route.
  ``detect_ha_gaps()``      — (PR6 Phase B) re-read the registry and
                               upsert gap rows.
  ``generate_ha_proposals()`` — (PR6 Phase C) template a YAML proposal
                               per open gap.

Retry policy:

  * Known refusals (HA not connected, HA 401 from a rotated LLAT,
    ctrl-api unreachable) are surfaced as ``{"ok": False, "code":
    "..."}`` from the activity itself and the workflow audit-logs the
    refusal. These do NOT consume retry budget.
  * Unexpected exceptions (HA 5xx, transient timeouts, network blips)
    DO consume retry budget — up to 3 attempts with exponential
    backoff. Past that we audit-log the failure and let the next
    scheduled tick try again.

Per the LLAT-hygiene rules in CLAUDE.md, NEITHER the workflow nor
the activity body ever logs or persists the LLAT bytes. The pull
activity only carries the token in memory between fetching it from
ctrl-api and using it in the HA Authorization header.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.ha_bootstrap import (
        pull_ha_registry,
        write_ha_registry,
    )
    from src.activities.ha_gap_detection import (
        detect_ha_gaps,
        generate_ha_proposals,
    )


logger = logging.getLogger("ha-bootstrap-workflow")


# Retry policy for the pull. HA timeouts are common on under-provisioned
# Pi installs; 3 attempts with exponential backoff covers ~95% of
# transient outages without burning the cron tick's budget on a hard
# failure.
_PULL_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=10),
    maximum_interval=timedelta(minutes=2),
    maximum_attempts=3,
)

# Retry policy for the write. ctrl-api is local SQLite — the most
# realistic failure is a brief WAL contention with another writer, not
# a 5xx. 2 attempts is enough.
_WRITE_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=5),
    maximum_interval=timedelta(seconds=30),
    maximum_attempts=2,
)

# Retry policy for Phase B + Phase C. Same ctrl-api WAL-contention
# concern as the write — 2 attempts is enough.
_GAP_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=5),
    maximum_interval=timedelta(seconds=30),
    maximum_attempts=2,
)


@workflow.defn
class HaBootstrapWorkflow:
    """Pull the HA registry and refresh ha_registry once."""

    @workflow.run
    async def run(self) -> dict[str, Any]:
        logger.info("ha-bootstrap: starting registry pull")

        pull = await workflow.execute_activity(
            pull_ha_registry,
            start_to_close_timeout=timedelta(minutes=2),
            retry_policy=_PULL_RETRY,
        )

        if not isinstance(pull, dict):
            return {
                "ok": False,
                "code": "PULL_BAD_RESULT",
                "rows": 0,
            }

        if not pull.get("ok"):
            # Known refusal — surface the code without retrying.
            code = pull.get("code") or "PULL_FAILED"
            logger.warning("ha-bootstrap: pull refused with code=%s", code)
            return {
                "ok": False,
                "code": code,
                "rows": 0,
            }

        rows = pull.get("rows") or []
        if not isinstance(rows, list):
            rows = []

        write = await workflow.execute_activity(
            write_ha_registry,
            rows,
            start_to_close_timeout=timedelta(minutes=1),
            retry_policy=_WRITE_RETRY,
        )

        counts = pull.get("counts") or {}
        result: dict[str, Any] = {
            "ok": True,
            "pull": {
                "states": counts.get("states", 0),
                "areas": counts.get("areas", 0),
                "devices": counts.get("devices", 0),
                "entity_registry": counts.get("entity_registry", 0),
                "services": counts.get("services", 0),
            },
            "rows": len(rows),
            "write": write if isinstance(write, dict) else {},
        }
        logger.info(
            "ha-bootstrap: phase A complete rows=%d inserted=%d updated=%d tombstoned=%d",
            len(rows),
            result["write"].get("inserted", 0),
            result["write"].get("updated", 0),
            result["write"].get("tombstoned", 0),
        )

        # ── Phase B — gap detection ─────────────────────────────────────
        #
        # Now that the registry is fresh, scan it for the 8 baseline
        # patterns. A registry-empty install (operator just connected and
        # hasn't pulled yet) safely produces zero gaps because every
        # detector early-exits when no relevant entities exist.
        gaps_result = await workflow.execute_activity(
            detect_ha_gaps,
            start_to_close_timeout=timedelta(minutes=1),
            retry_policy=_GAP_RETRY,
        )
        if not isinstance(gaps_result, dict) or not gaps_result.get("ok"):
            code = (gaps_result or {}).get("code", "GAP_PHASE_FAILED")
            logger.warning("ha-bootstrap: phase B failed with code=%s", code)
            result["gap_phase"] = {"ok": False, "code": code}
            return result

        gap_rows = gaps_result.get("gaps") or []
        result["gap_phase"] = {
            "ok": True,
            "gap_count": len(gap_rows),
            "inserted": gaps_result.get("inserted", 0),
            "updated": gaps_result.get("updated", 0),
        }
        logger.info(
            "ha-bootstrap: phase B complete gaps=%d inserted=%d",
            len(gap_rows),
            gaps_result.get("inserted", 0),
        )

        # ── Phase C — proposal generation ───────────────────────────────
        #
        # Generate a proposal per open gap that doesn't already have one.
        # The activity is idempotent — re-running with the same gap list
        # safely skips gaps that already have a `proposal_ref`.
        if not gap_rows:
            result["proposal_phase"] = {"ok": True, "created": 0, "skipped": 0}
            return result

        prop_result = await workflow.execute_activity(
            generate_ha_proposals,
            gap_rows,
            start_to_close_timeout=timedelta(minutes=2),
            retry_policy=_GAP_RETRY,
        )
        if not isinstance(prop_result, dict) or not prop_result.get("ok"):
            code = (prop_result or {}).get("code", "PROPOSAL_PHASE_FAILED")
            logger.warning(
                "ha-bootstrap: phase C failed with code=%s", code
            )
            result["proposal_phase"] = {"ok": False, "code": code}
            return result

        result["proposal_phase"] = {
            "ok": True,
            "created": prop_result.get("created", 0),
            "skipped": prop_result.get("skipped", 0),
        }
        logger.info(
            "ha-bootstrap: phase C complete created=%d skipped=%d",
            prop_result.get("created", 0),
            prop_result.get("skipped", 0),
        )
        return result
