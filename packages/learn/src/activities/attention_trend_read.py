"""Attention trend read — fetch, clerk-read, write observation (#584)."""
from __future__ import annotations
import json, logging
from datetime import date as _date, datetime, timezone
from typing import Any
import httpx
from temporalio import activity
from src.activities.clerk import _call_clerk, _extract_json
from src.activities.nar_data import _ctrl_headers
from src.config import load_config

logger = logging.getLogger("alfred-learn")
_MAX_OBS = 5


async def _fetch_trends(ctrl_url: str, grain: str, from_: str, to: str) -> dict[str, Any]:
    async with httpx.AsyncClient(base_url=ctrl_url, timeout=30.0, headers=_ctrl_headers()) as h:
        r = await h.get("/api/v1/attention/trends", params={"grain": grain, "from": from_, "to": to})
        r.raise_for_status()
        return r.json()


def _full_period_days(period: dict[str, Any]) -> int:
    """Days from period['start'] to period['end'] inclusive — the canonical full-period length.

    Works for any grain: week (always 7), month (28–31), quarter (89–92).
    The period's start/end are the canonical ISO boundaries returned by ctrl-api.
    """
    start = _date.fromisoformat(period["start"][:10])
    end = _date.fromisoformat(period["end"][:10])
    return (end - start).days + 1


def _build_prompt(payload: dict[str, Any]) -> str:
    periods = payload.get("periods", [])
    grain = payload.get("grain", "week")
    coverage = payload.get("coverage", {})
    unmeasured = (not coverage.get("interruption_instrumented", True)
                  or any(not p.get("interruption_instrumented", True) for p in periods))
    guard = (
        "HARD CONSTRAINT: interruption figures are NOT instrumented.  "
        "Do NOT describe or compare them.  Omit interruption entirely.\n\n"
        if unmeasured else ""
    )

    # Annotate each period so the model can distinguish complete from partial windows.
    annotated: list[dict[str, Any]] = []
    partial_keys: list[str] = []
    for p in periods:
        try:
            full = _full_period_days(p)
        except (ValueError, TypeError, KeyError):
            full = None
        days = p.get("days", 0)
        if full is not None and days < full:
            status = f"PARTIAL ({days}/{full} days)"
            partial_keys.append(p.get("key", "?"))
        elif full is not None:
            status = f"full ({days} days)"
        else:
            status = f"({days} days)"
        annotated.append({**p, "_status": status})

    partial_rule = (
        f"PARTIAL PERIOD RULE: periods {partial_keys} are incomplete windows.  "
        "Do NOT use a partial period as one endpoint of a 'rose/fell/increased/decreased' "
        "comparison against a full period.  Either (a) normalise to a per-day rate and "
        "state that you are doing so, or (b) describe the partial period standalone "
        "without directional comparison to a full period.\n\n"
        if partial_keys else ""
    )
    return (
        f"You are reading Alfred's attention trend data for the principal.\n\n"
        f"{guard}"
        f"{partial_rule}"
        f"DATA:\n{json.dumps({'grain': grain, 'periods': annotated}, indent=2)}\n\n"
        "Produce 3–5 observations (fewer if data doesn't support 3).  Rules:\n"
        "- Cite the specific number supporting each observation.\n"
        "- Materiality: flag changes >10 % for displaced_hours, return_ratio, nar_hours, "
        "and per-class/per-bucket displaced figures — all are derived from displacement, "
        "which drifts ±single-digit % run-to-run, so smaller moves are noise.  Engaged "
        "and interruption counts are directly measured (not displacement-derived) and may "
        "be noted at a lower threshold — but omit interruption entirely if it is not "
        "instrumented for a period.\n"
        "- No praise, no encouragement.\n"
        "- If interruption_instrumented is false for a period, omit interruption.\n\n"
        "Useful shapes: return_ratio falling; class handed over more/less than prior period;\n"
        "bucket-size shift; outcome trend; something that stopped.\n\n"
        'Return JSON only: {"observations": [{"headline": "≤12 words",'
        ' "detail": "1-2 sentences + figure", "evidence": "field=value"}]}'
    )


async def _replace_prior_read(ctrl_url: str, subject: str,
                               summary: str, detail: str, payload: dict[str, Any]) -> str | None:
    async with httpx.AsyncClient(base_url=ctrl_url, timeout=30.0, headers=_ctrl_headers()) as h:
        try:
            r = await h.get("/api/v1/state/observations",
                            params={"kind": "attention_read", "subject": subject, "limit": 5})
            r.raise_for_status()
            existing = r.json().get("observations", [])
        except Exception as exc:  # noqa: BLE001
            logger.warning("attention_trend_read: list failed: %s", exc)
            return None
        if not existing or not (obs_id := existing[0].get("id", "")):
            return None
        try:
            pr = await h.patch(f"/api/v1/state/observations/{obs_id}",
                               json={"summary": summary, "detail": detail,
                                     "payload": payload, "status": "open"})
            pr.raise_for_status()
            return obs_id
        except Exception as exc:  # noqa: BLE001
            logger.warning("attention_trend_read: patch %s failed: %s", obs_id, exc)
            return None


@activity.defn
async def read_attention_trends(params: dict[str, Any]) -> dict[str, Any]:
    """Fetch attention trends, read via clerk, write as attention_read observation."""
    config = load_config()
    grain, from_, to = params.get("grain", "week"), params.get("from", ""), params.get("to", "")
    if not from_ or not to:
        raise ValueError("read_attention_trends: 'from' and 'to' are required")
    subject = f"attention_trend:{grain}:{from_}:{to}"

    try:
        trend_payload = await _fetch_trends(config.alfred_ctrl_url, grain, from_, to)
    except Exception as exc:  # noqa: BLE001
        logger.warning("attention_trend_read: fetch failed: %s", exc)
        trend_payload = {"grain": grain, "from": from_, "to": to, "periods": []}

    observations: list[dict[str, Any]] = []
    try:
        out = await _call_clerk(_build_prompt(trend_payload), agent_id="learn-attention-trend-read")
        if isinstance(out, str):
            out = _extract_json(out)
        raw = out.get("observations", [])
        observations = raw[:_MAX_OBS] if isinstance(raw, list) else []
    except Exception as exc:  # noqa: BLE001
        logger.warning("attention_trend_read: clerk failed: %s", exc)

    now = datetime.now(timezone.utc).isoformat()
    obs_payload = {"grain": grain, "from": from_, "to": to,
                   "period_count": len(trend_payload.get("periods", [])),
                   "observations": observations, "generated_at": now}
    n = len(observations)
    summary = f"Attention trend read ({grain}, {from_} – {to}): {n} observation(s)"
    detail = ("\n\n".join(f"{o.get('headline','')}\n{o.get('detail','')}" for o in observations)
              or "(no observations — insufficient data)")

    replaced_id = await _replace_prior_read(config.alfred_ctrl_url, subject, summary, detail, obs_payload)
    if replaced_id:
        observation_id = replaced_id
    else:
        from src.utils.signal_state import StateClient
        try:
            async with StateClient(config) as sc:
                observation_id = await sc.create_observation(
                    subject=subject, kind="attention_read", summary=summary,
                    detail=detail, ts=now, confidence=1.0, status="open", payload=obs_payload)
        except Exception as exc:  # noqa: BLE001
            logger.warning("attention_trend_read: write failed: %s", exc)
            observation_id = ""

    activity.logger.info("attention_trend_read: %s %s–%s obs=%d replaced=%s",
                         grain, from_, to, n, bool(replaced_id))
    return {"observation_id": observation_id, "observations_count": n,
            "replaced": bool(replaced_id), "grain": grain, "from": from_, "to": to}
