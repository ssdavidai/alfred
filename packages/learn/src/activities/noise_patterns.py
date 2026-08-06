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
# #453 — the noise gate now honours the same promotion ladder the signal
# router does. `src.matching.tiers` imports no activities, so there is no
# cycle with signal_actions (which also reads from it).
from src.matching.tiers import AUTONOMOUS_TIER, TIER_ASKING, instinct_tier

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


# Body-scrape regex for the "**From**: ..." line that
# ``stream_vault._template_email`` writes when the gmail stream_event's
# frontmatter omits the sender. Matches the same shape
# ``decision_observations._sender_from_raw_quote`` consumes.
_BODY_FROM_RE = re.compile(
    r"\*\*From\*\*\s*:\s*(.+?)(?:\*\*To\*\*|\*\*Subject\*\*|\*\*Date\*\*|\n|$)",
    re.IGNORECASE,
)


def derive_signature(
    event_fm: dict[str, Any],
    event_body: str | None = None,
) -> dict[str, Any]:
    """Build a stable signature dict from a stream_event's frontmatter.

    The signature shape depends on source_type. For gmail we anchor on
    the sender; for gcal, the organiser + title keywords. When neither
    anchor fires we return ``kind: "unknown"`` so the legacy
    ``event_matches_noise`` matcher skips the event entirely — a
    single Noise click must never end up filtering a whole source_type.

    ``event_body`` (optional) is the rendered markdown body of the
    stream_event. The composio-gmail curator stamps the sender into
    the body's ``**From**: ...`` line but NOT into frontmatter, so
    without this argument every gmail event derived a broad
    fallback signature. Callers that have the body should pass it.

    Returns ``{"kind": "...", "value": "...", "label": "..."}`` where
    ``label`` is a human-readable description for the noise_pattern's
    name field. ``kind == "unknown"`` means "do not match anything".
    """
    source_type = str(event_fm.get("source_type") or event_fm.get("source") or "").lower()
    # #333: composio-ingested email events carry source_type="email" —
    # without this mapping they derived kind="unknown" and sender-domain
    # noise instincts NEVER matched on composio-fed tenants (all of them,
    # for email). The SUPPRESS arm was structurally dead for the most
    # common event type; home worked around it by re-anchoring instincts
    # on subject_keywords.
    if (
        source_type.startswith("composio-gmail")
        or source_type in ("gmail", "email")
    ):
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
        if not sender_norm and event_body:
            # Frontmatter doesn't carry the sender — fall back to the
            # ``**From**: ...`` line the email template writes into the
            # body. Same shape ``_gmail_sender_domain`` in signals.py
            # scrapes for the newsletter blocklist.
            m = _BODY_FROM_RE.search(event_body)
            if m:
                sender_norm = _normalize_sender(m.group(1))
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

    # ----- Unanchored: refuse to filter. -----
    # Previously this branch returned a broad ``source_type_topic``
    # signature, which meant one Noise click on an unanchorable event
    # could suppress an entire source_type's downstream events. The
    # legacy ``event_matches_noise`` matcher requires exact ``kind``
    # equality, so returning ``"unknown"`` keeps existing patterns
    # inert against an event we can't anchor.
    return {
        "kind": "unknown",
        "value": "",
        "label": f"{source_type or 'unknown'} / unanchored",
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
    event_body: str | None = None,
) -> dict[str, Any] | None:
    """Return the matching pattern (or None) for an incoming event.

    Computes the event's signature using ``derive_signature`` and then
    looks for a pattern with matching kind + value. Same idea as the
    filter table: stable signature → stable lookup.

    ``event_body`` is forwarded to ``derive_signature`` so the gmail
    branch can recover the sender from the template-emitted
    ``**From**: ...`` body line when frontmatter doesn't carry it.
    Without this the gmail signature collapsed to the broad fallback
    and a single Noise click filtered every gmail event (#262).
    Patterns with ``signature_kind == "unknown"`` never match anything
    because ``derive_signature`` no longer produces that kind for any
    anchorable event.
    """
    if not patterns:
        return None
    event_sig = derive_signature(event_fm, event_body=event_body)
    if event_sig["kind"] == "unknown":
        # Refuse to match unanchored events even if some legacy
        # pattern was stamped with ``unknown`` (we don't write that
        # value, but be defensive).
        return None
    for p in patterns:
        if p["kind"] == event_sig["kind"] and p["value"] == event_sig["value"]:
            return p
    return None


# ---------------------------------------------------------------------------
# OBS-8: noise-instinct pre-filter — the replacement for signal_noise_pattern
# ---------------------------------------------------------------------------
#
# Architecture migration: Sir's Noise clicks now flow through the same
# observation→pattern_proposal→instinct loop as every other gesture
# (OBS-1 .. OBS-5). When a noise-rule emerges and Sir adopts it via
# /desk, the resulting instinct carries ``intent_key: "noise"`` plus
# ``input_patterns.sender_domains`` (glob patterns built by OBS-5's
# ``_sender_key_to_domain_patterns``). We consult those instincts at
# signal_extract pre-filter time so the autonomous suppression that
# ``signal_noise_pattern`` used to do is now done through the
# canonical instinct surface.
#
# Legacy ``signal_noise_pattern/*.md`` records keep firing via the
# existing ``load_active_noise_patterns`` + ``event_matches_noise``
# path until they age out. New noise rules land as instincts only.

import fnmatch

# Same 60s TTL cache as the legacy patterns.
_NOISE_INSTINCT_CACHE: dict[str, Any] = {"loaded_at": 0.0, "instincts": []}


async def load_noise_instincts() -> list[dict[str, Any]]:
    """Return active instincts that mean "keep this off the Desk".

    Includes BOTH ``intent_key: noise`` (OBS-5 machine-generated) and
    ``routing_rule.destination_type: hold`` (reflection/hand-authored).

    Result entries:
      ``{"path": <vault path>, "sender_domains": [<glob>...],
         "subject_keywords": [<kw>...]}``

    Empty list when none are present, when ctrl-api list fails, or
    when an instinct has no anchors (neither sender_domains nor
    subject_keywords — can't filter anything).
    """
    import time
    now = time.time()
    if now - _NOISE_INSTINCT_CACHE["loaded_at"] < _CACHE_TTL_S:
        return list(_NOISE_INSTINCT_CACHE["instincts"])

    out: list[dict[str, Any]] = []
    async with _http() as client:
        try:
            resp = await client.get(
                "/api/v1/vault/list/instinct?preview=200",
            )
            if resp.status_code >= 400:
                _NOISE_INSTINCT_CACHE["loaded_at"] = now
                _NOISE_INSTINCT_CACHE["instincts"] = []
                return []
            data = resp.json().get("results", []) or []
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "noise_patterns.load_noise_instincts: %s", exc,
            )
            _NOISE_INSTINCT_CACHE["loaded_at"] = now
            _NOISE_INSTINCT_CACHE["instincts"] = []
            return []

    for r in data:
        fm = r.get("frontmatter") if isinstance(r, dict) else {}
        if not isinstance(fm, dict):
            continue
        if str(fm.get("status") or "").strip().lower() != "active":
            continue
        # A noise/suppress instinct is one whose intent is to keep the
        # signal off the Desk. Two encodings exist in the wild:
        #   * OBS-5 machine-generated: top-level ``intent_key: noise``
        #   * reflection / hand-authored: ``routing_rule.destination_type: hold``
        # Honour BOTH — a maxed-confidence "hold" rule (e.g.
        # suppress-ci-github-workflow-noise) carried only the routing_rule
        # and was invisible to the intent_key-only gate, so it never
        # suppressed despite matching (BUG 3).
        intent_key = str(fm.get("intent_key") or "").strip().lower()
        rr = fm.get("routing_rule") or {}
        dest_type = ""
        if isinstance(rr, dict):
            dest_type = str(rr.get("destination_type") or "").strip().lower()
        if intent_key != "noise" and dest_type != "hold":
            continue
        # Pull sender_domains from input_patterns (preferred) or legacy
        # signals.domain_patterns mirror; also collect subject_keywords —
        # a CI/PR instinct anchors on the subject, not just the domain.
        ip = fm.get("input_patterns") or {}
        sender_domains: list[str] = []
        subject_keywords: list[str] = []
        if isinstance(ip, dict):
            v = ip.get("sender_domains") or []
            if isinstance(v, list):
                sender_domains.extend(str(x) for x in v if isinstance(x, str))
            k = ip.get("subject_keywords") or []
            if isinstance(k, list):
                subject_keywords.extend(str(x) for x in k if isinstance(x, str))
        if not sender_domains:
            sigs = fm.get("signals") or {}
            if isinstance(sigs, dict):
                v = sigs.get("domain_patterns") or []
                if isinstance(v, list):
                    sender_domains.extend(str(x) for x in v if isinstance(x, str))
        if not sender_domains and not subject_keywords:
            continue  # Noise instinct without anchors — can't filter
        # #453 — carry the ladder tier. Suppression is the most
        # destructive thing an instinct can do (the email ceases to
        # exist), so it must respect the same ladder the router does.
        # We still LOAD every noise instinct — the caller decides what a
        # sub-Acting match means — so a match stays observable instead of
        # the instinct silently vanishing from the gate.
        out.append({
            "path": str(r.get("path") or ""),
            "sender_domains": sender_domains,
            "subject_keywords": subject_keywords,
            "tier": instinct_tier(fm),
        })

    _NOISE_INSTINCT_CACHE["loaded_at"] = now
    _NOISE_INSTINCT_CACHE["instincts"] = out
    logger.info("noise_patterns: %d noise instincts cached", len(out))
    return out


def _domain_matches(sig_value: str, glob: str) -> bool:
    """Does `sig_value` (an address or sender string) match a domain rule?

    #453 — the previous test was ``fnmatch(sig_value, f"*{g}*")``: an
    UNANCHORED substring. A rule for ``google.com`` therefore also matched
    ``notgoogle.community`` and ``google.com.phish.example``. For a filter
    whose effect is "this email ceases to exist", that is far too loose.

    Now a bare domain matches only as a proper domain component:
    ``google.com`` matches ``x@google.com`` and ``x@mail.google.com`` but
    not ``notgoogle.community``. Explicit globs (containing ``*`` / ``?``)
    are still honoured verbatim, so hand-authored ``*.szamlazz.hu`` rules
    keep working.
    """
    g = (glob or "").strip().lower()
    v = (sig_value or "").strip().lower()
    if not g or not v:
        return False
    if "*" in g or "?" in g:
        return fnmatch.fnmatch(v, g) or fnmatch.fnmatch(v, f"*{g}")
    # Bare domain: match the domain itself or any subdomain of it, whether
    # the signature is a bare domain or a full address.
    local, _, host = v.rpartition("@")
    host = host or v
    return host == g or host.endswith("." + g)


def event_matches_noise_instinct(
    event_fm: dict[str, Any],
    noise_instincts: list[dict[str, Any]],
    event_body: str | None = None,
) -> dict[str, Any] | None:
    """Return the first matching noise instinct (or None).

    Matches on TWO anchors:
      * sender-domain globs vs the event's derived signature (gmail
        sender / gcal organiser / slack user);
      * subject_keywords substrings vs the event subject/title.

    ``event_body`` is forwarded to ``derive_signature`` so the sender is
    recoverable from a ``**From**:`` header in the rendered body (the
    composio-gmail curator often does not stamp a top-level ``from``).
    Bare (wildcard-free) sender globs are also tried as ``*glob*`` so a
    hand-authored ``github.com`` anchor matches ``x@notifications.github.com``.
    """
    if not noise_instincts:
        return None
    sig = derive_signature(event_fm, event_body=event_body)
    sig_value = (sig.get("value") or "").strip().lower()
    # Subject text for keyword matching — a CI/PR instinct anchors here.
    subject_text = " ".join(
        str(event_fm.get(k) or "")
        for k in ("subject", "title", "name", "display_headline")
    ).strip().lower()
    # ``gcal_organiser_title`` is what derive_signature actually emits;
    # the old allowlist listed ``gcal_organiser`` and was dead.
    sender_kinds = ("gmail_sender", "gcal_organiser_title", "slack_user")
    for inst in noise_instincts:
        tier = str(inst.get("tier") or TIER_ASKING)
        # 1. sender-domain globs
        if sig.get("kind") in sender_kinds and sig_value:
            for glob in inst.get("sender_domains", []):
                if _domain_matches(sig_value, glob):
                    return {
                        "kind": f"instinct_{sig['kind']}",
                        "value": sig_value,
                        "path": inst["path"],
                        "matched_glob": glob,
                        "tier": tier,
                        "suppress": tier == AUTONOMOUS_TIER,
                    }
        # 2. subject-keyword substrings (the anchor CI instincts carry)
        if subject_text:
            for kw in inst.get("subject_keywords", []):
                k = kw.strip().lower()
                if k and k in subject_text:
                    return {
                        "kind": "instinct_subject_keyword",
                        "value": subject_text[:120],
                        "path": inst["path"],
                        "matched_keyword": kw,
                        "tier": tier,
                        "suppress": tier == AUTONOMOUS_TIER,
                    }
    return None
