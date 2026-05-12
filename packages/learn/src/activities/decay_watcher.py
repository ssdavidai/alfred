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
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.decay import (
    AUTO_FLIP_THRESHOLD,
    band_for,
    freshness_score,
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
