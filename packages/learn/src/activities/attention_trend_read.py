"""Attention trend read — fetch, clerk-read, write observation (#584)."""
from __future__ import annotations
import json, logging
from datetime import datetime, timezone
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
    return (
        f"You are reading Alfred's attention trend data for the principal.\n\n"
        f"{guard}DATA:\n{json.dumps({'grain': grain, 'periods': periods}, indent=2)}\n\n"
        "Produce 3–5 observations (fewer if data doesn't support 3).  Rules:\n"
        "- Cite the specific number supporting each observation.\n"
        "- Only flag displaced_hours changes >10 % (drift is single-digit %).\n"
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
