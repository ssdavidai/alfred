"""Noise patterns — the upstream filter for "this should never have
surfaced" signals.

When the principal clicks the **Noise** button on a Desk card, they're
not just closing the item — they're saying *this category of signal
shouldn't have reached me at all*. The decision pipeline writes a
``decision/*.md`` record with ``intent: noise``; the
``DecisionRouterWorkflow`` then calls ``write_noise_pattern`` here,
which:

1. Reads the source event the noise-flagged card pointed at.
2. Derives a stable **signature** from the event's metadata — source
   type, sender (for gmail), organiser (for gcal), subject keywords,
   etc. The signature is what the upstream filter matches on.
3. Writes a ``signal_noise_pattern/*.md`` vault record with
   ``status: active``, ``training_strength: hard``, and a
   ``matches: 0`` counter.

The signal-extract pipeline consults these records before calling
clerk: if an incoming stream_event matches an active pattern with high
confidence, the LLM call is skipped, the event is marked processed in
the sidecar, and no signal is produced. Cost: free.

Three Noise clicks on the same signature → the pattern's
``training_strength`` gets promoted from ``hard`` to ``adopted`` and
the matcher's confidence floor relaxes (subtle wording variations
also get filtered).

This is the principal's upstream voice: not "delete after the fact"
but "I refuse the premise."
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config

logger = logging.getLogger("noise-patterns")


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


def _normalize_sender(raw: str) -> str:
    """Extract an email/handle from a header like '"Foo" <foo@bar.com>'.

    Returns the angle-bracket portion when present, falls back to the
    raw string lowercased + stripped. Empty when nothing parseable.
    """
    if not raw:
        return ""
    m = re.search(r"<([^>]+)>", raw)
    if m:
        return m.group(1).strip().lower()
    return raw.strip().lower()


def derive_signature(event_fm: dict[str, Any]) -> dict[str, Any]:
    """Build a stable signature dict from a stream_event's frontmatter.

    The signature shape depends on source_type. For gmail we anchor
    on the sender; for gcal, the organiser + title keywords; for omi,
    the speaker if known. Anything we can't anchor falls back to a
    source_type + topic_tags signature, which is broader but better
    than nothing.

    Returns ``{"kind": "...", "value": "...", "label": "..."}`` where
    ``label`` is a human-readable description for the noise_pattern's
    name field.
    """
    source_type = str(event_fm.get("source_type") or event_fm.get("source") or "").lower()
    if source_type.startswith("composio-gmail") or source_type == "gmail":
        source_type = "gmail"
    elif source_type.startswith("composio-googlecalendar") or source_type == "gcal":
        source_type = "gcal"

    # ----- Gmail: sender is king. Subject as secondary disambiguator. -----
    if source_type == "gmail":
        sender_raw = (
            event_fm.get("from")
            or event_fm.get("sender")
            or event_fm.get("From")
        )
        sender_norm = _normalize_sender(str(sender_raw or ""))
        if sender_norm:
            return {
                "kind": "gmail_sender",
                "value": sender_norm,
                "label": f"Gmail from {sender_norm}",
            }

    # ----- gcal: organiser + first 3 title words -----
    if source_type == "gcal":
        organiser_raw = (
            event_fm.get("organizer")
            or event_fm.get("organiser")
        )
        organiser = _normalize_sender(str(organiser_raw or ""))
        title = str(event_fm.get("name") or event_fm.get("title") or "")
        title_norm = re.sub(r"[^\w\s]", "", title).strip().lower()
        title_keywords = " ".join(title_norm.split()[:3])
        if organiser or title_keywords:
            value = f"{organiser}|{title_keywords}".strip("|")
            return {
                "kind": "gcal_organiser_title",
                "value": value,
                "label": f"Calendar: {organiser or 'unknown'} / {title_keywords or 'unknown'}",
            }

    # ----- Fallback: source_type + first topic tag -----
    tags = event_fm.get("alfred_tags") or event_fm.get("topic_tags") or []
    first_tag = ""
    if isinstance(tags, list) and tags:
        first_tag = str(tags[0]).strip().lower()
    value = f"{source_type}|{first_tag}".strip("|")
    return {
        "kind": "source_type_topic",
        "value": value or source_type or "unknown",
        "label": f"{source_type or 'unknown'} / {first_tag or 'no-topic'}",
    }


@activity.defn
async def write_noise_pattern(decision: dict[str, Any]) -> dict[str, Any]:
    """Materialise a noise pattern from a decision with intent=noise.

    Reads the decision's source_record (a needs_attention path), reads
    that needs_attention's source_event_path, derives a signature from
    the event's frontmatter, and writes a
    ``signal_noise_pattern/<ts>-<short>.md`` record. Returns the path
    on success or a ``{"ok": False, "reason": ...}`` dict on failure
    (failure is non-fatal — the principal's gesture is still captured
    in the decision record).
    """
    decision_id = str(decision.get("id") or "")
    source_record = str(decision.get("source_record") or "")
    note = str(decision.get("note") or "")
    if not decision_id or not source_record.startswith("needs_attention/"):
        return {"ok": False, "reason": "not a needs_attention noise"}

    async with _http() as client:
        # 1. Read the needs_attention record to get the source event path.
        try:
            na_resp = await client.get(
                f"/api/v1/vault/records/{source_record}"
            )
            na_resp.raise_for_status()
            na_record = na_resp.json()
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "noise_patterns.write_noise_pattern: read na failed %s: %s",
                source_record, exc,
            )
            return {"ok": False, "reason": f"na read: {exc}"}

        na_fm = na_record.get("frontmatter") if isinstance(na_record, dict) else {}
        if not isinstance(na_fm, dict):
            na_fm = {}
        source_event_path = str(na_fm.get("source_event_path") or "")
        if not source_event_path:
            return {"ok": False, "reason": "no source_event_path on na"}

        # 2. Read the source event to derive signature.
        try:
            ev_resp = await client.get(
                f"/api/v1/vault/records/{source_event_path}"
            )
            ev_resp.raise_for_status()
            event = ev_resp.json()
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "noise_patterns.write_noise_pattern: read event failed %s: %s",
                source_event_path, exc,
            )
            return {"ok": False, "reason": f"event read: {exc}"}
        event_fm = event.get("frontmatter") if isinstance(event, dict) else {}
        if not isinstance(event_fm, dict):
            event_fm = {}

        sig = derive_signature(event_fm)

    # 3. Write the noise_pattern record.
    now_iso = datetime.now(timezone.utc).isoformat()
    ts = now_iso.replace(":", "-").replace(".", "-")[:19] + "Z"
    short = hashlib.sha256(
        f"{sig['kind']}\x00{sig['value']}".encode("utf-8")
    ).hexdigest()[:8]
    name = f"{ts}-{short}"
    fm_lines = [
        "---",
        'type: "signal_noise_pattern"',
        f'name: {json.dumps(sig["label"])}',
        f'created: "{now_iso}"',
        f'signature_kind: {json.dumps(sig["kind"])}',
        f'signature_value: {json.dumps(sig["value"])}',
        f'source_type: {json.dumps(str(event_fm.get("source_type") or event_fm.get("source") or ""))}',
        f'source_decision: "decision/{decision_id}.md"',
        f'source_event_path: {json.dumps(source_event_path)}',
        f'note: {json.dumps(note) if note else "null"}',
        'training_strength: "hard"',
        'confidence: 1.0',
        'matches: 0',
        'status: "active"',
        "---",
        "",
        f"# Noise pattern: {sig['label']}",
        "",
        f"Principal marked `{source_record}` as noise at {now_iso}.",
        f"Source event: `{source_event_path}`",
        f"Signature kind: `{sig['kind']}`",
        f"Signature value: `{sig['value']}`",
        "",
        f"_Principal's note:_ {note}" if note else "",
        "",
        "This pattern is consulted by signal_extract before LLM calls. "
        "Matching stream_events are filtered before reaching the principal's Desk.",
    ]
    content = "\n".join([line for line in fm_lines if line != ""]) + "\n"

    from src.utils.vault_client import VaultClient
    cfg = load_config()
    vault = VaultClient(cfg)
    try:
        path = await vault.write_record(
            record_type="signal_noise_pattern", name=name, content=content,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "noise_patterns.write_noise_pattern: vault write failed: %s", exc,
        )
        return {"ok": False, "reason": f"vault write: {exc}"}
    finally:
        await vault.close()

    logger.info(
        "noise_patterns.write_noise_pattern: %s (kind=%s value=%s)",
        path, sig["kind"], sig["value"],
    )
    return {
        "ok": True,
        "noise_pattern_path": path,
        "signature_kind": sig["kind"],
        "signature_value": sig["value"],
    }


# ---------------------------------------------------------------------------
# Loader / matcher — consumed by signals.py before LLM calls
# ---------------------------------------------------------------------------
#
# Lives in this file (not signals.py) so the noise lookup is owned by
# the noise subsystem. Returns a list of {kind, value, path} that
# signal_extract can match against incoming event frontmatter.

# Module-level cache. Refreshed every 60s — fast enough for fresh
# patterns to start filtering, slow enough that we don't reload on
# every event.
_PATTERN_CACHE: dict[str, Any] = {"loaded_at": 0.0, "patterns": []}
_CACHE_TTL_S = 60.0


async def load_active_noise_patterns() -> list[dict[str, Any]]:
    """Return the active noise patterns from vault, with a 60s cache."""
    import time
    now = time.time()
    if now - _PATTERN_CACHE["loaded_at"] < _CACHE_TTL_S:
        return list(_PATTERN_CACHE["patterns"])
    patterns: list[dict[str, Any]] = []
    async with _http() as client:
        try:
            resp = await client.get(
                "/api/v1/vault/list/signal_noise_pattern?preview=500",
            )
            if resp.status_code >= 400:
                # Endpoint may not exist yet on older ctrl-api; treat
                # as no patterns rather than failing the caller.
                _PATTERN_CACHE["loaded_at"] = now
                _PATTERN_CACHE["patterns"] = []
                return []
            data = resp.json().get("results", []) or []
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "noise_patterns.load_active_noise_patterns: %s", exc,
            )
            _PATTERN_CACHE["loaded_at"] = now
            _PATTERN_CACHE["patterns"] = []
            return []
    for p in data:
        fm = p.get("frontmatter") if isinstance(p, dict) else {}
        if not isinstance(fm, dict):
            continue
        if str(fm.get("status") or "").strip() != "active":
            continue
        patterns.append({
            "kind": str(fm.get("signature_kind") or ""),
            "value": str(fm.get("signature_value") or ""),
            "path": str(p.get("path") or ""),
            "training_strength": str(fm.get("training_strength") or "hard"),
        })
    _PATTERN_CACHE["loaded_at"] = now
    _PATTERN_CACHE["patterns"] = patterns
    logger.info("noise_patterns: %d active patterns cached", len(patterns))
    return patterns


def event_matches_noise(
    event_fm: dict[str, Any],
    patterns: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Return the matching pattern (or None) for an incoming event.

    Computes the event's signature using ``derive_signature`` and then
    looks for a pattern with matching kind + value. Same idea as the
    filter table: stable signature → stable lookup.
    """
    if not patterns:
        return None
    event_sig = derive_signature(event_fm)
    for p in patterns:
        if p["kind"] == event_sig["kind"] and p["value"] == event_sig["value"]:
            return p
    return None
