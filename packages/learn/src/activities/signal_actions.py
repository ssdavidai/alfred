"""Signal action router (T6.4.1–T6.4.4).

When a signal has ``effect=action``, this module decides:

  * **HIGH path** — matched instinct + combined_confidence above the
    instinct's discretion threshold + env not pinned to shadow →
    dispatch the action to openclaw main as a subagent task. The
    response gets recorded as a follow-up signal record
    (``record_type=signal``, ``source_type=agent_outcome``).

  * **HUMAN path** — no matched instinct OR confidence below threshold
    OR effective mode is shadow → write a
    ``vault/needs_attention/<ts>-<id>.md`` record. The dashboard reads
    this directory to surface "Sir, please decide" cards.

Discretion gate: per-instinct ``discretion_threshold`` from the
instinct's frontmatter (default 0.85 if absent — same default as
``get_discretion_threshold`` for the 10–19 observations bucket). The
combined-confidence metric on the signal side is
``min(target_confidence, effect_confidence)`` — same shape
``apply_signal_mutation`` uses; the weakest link gates the action.

Hard rules:

  * NO mocks. Every code path runs against real openclaw via
    ``clerk._call_clerk`` (subagent dispatch) or real vault writes via
    ``VaultClient``.
  * Reuse existing discretion machinery
    (``src.matching.discretion.should_route_autonomously``).
  * Lazy-import ``httpx`` and other heavy deps inside activity bodies —
    Temporal's workflow sandbox can't proxy ``httpx``'s C-extension
    proxied subclasses; importing at module top crashes worker
    validation.
  * NO direct vault filesystem; all vault writes flow through
    ``VaultClient``.
  * NO direct Anthropic; all LLM calls flow through OpenClaw via
    ``_call_clerk``.

Env gate: ``STEWARD_SIGNAL_ACTION_LIVE_MODE`` (separate from
``STEWARD_SIGNAL_ROUTER_LIVE_MODE`` so Sir can soak the action surface
while mutations already run live). Default ``shadow``. Same shape as
``signal_mutations._resolve_signal_router_mode``.
"""
from __future__ import annotations

import logging
from typing import Any

from temporalio import activity

# Module-level logger — same name everything else in alfred-learn uses.
logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SIGNAL_ACTION_LIVE_MODE_ENV = "STEWARD_SIGNAL_ACTION_LIVE_MODE"

# Default discretion threshold when an instinct's frontmatter doesn't
# carry one. Same as the 10-19 observations bucket in
# ``get_discretion_threshold`` — "fairly certain this goes here".
DEFAULT_DISCRETION_THRESHOLD = 0.85

# Below this similarity score the candidate instinct is treated as "no
# matching instinct" → HUMAN path. Tuned conservatively: with the
# token-overlap scorer below, an unrelated instinct's description
# rarely scores above 0.10; a genuinely related one tends to land at
# 0.40+. 0.30 leaves headroom on both sides.
MATCH_FLOOR = 0.30

# Module-level cache for the active instincts list — avoid refetching
# every signal because instincts change rarely (daily reflection adjusts
# them at most). 5-minute TTL is short enough that a freshly-promoted
# instinct picks up within a router tick or two.
_INSTINCTS_CACHE: dict[str, Any] = {"loaded_at": None, "data": []}
_INSTINCTS_CACHE_TTL_SECS = 300


# ---------------------------------------------------------------------------
# Helpers — env / scoring / value coercion
# ---------------------------------------------------------------------------

def _resolve_signal_action_mode() -> str:
    """Return the effective live-mode for the signal action router.

    Same shape as ``signal_mutations._resolve_signal_router_mode`` but
    reads a separate env (``STEWARD_SIGNAL_ACTION_LIVE_MODE``) so the
    autonomous-action surface can soak in shadow while the mutation
    surface already runs live.

    Returns one of: ``"shadow"``, ``"live"``,
    ``"live_high_confidence_only"``. Anything unrecognised falls back
    to ``"shadow"`` — when in doubt, don't dispatch.
    """
    import os

    raw = (
        os.environ.get(SIGNAL_ACTION_LIVE_MODE_ENV) or "shadow"
    ).strip().lower()
    if raw in ("shadow", "live", "live_high_confidence_only"):
        return raw
    logger.warning(
        "signal_actions._resolve_signal_action_mode: unrecognised %s=%s "
        "— defaulting to shadow",
        SIGNAL_ACTION_LIVE_MODE_ENV, raw,
    )
    return "shadow"


def _coerce_float(value: Any, default: float = 0.0) -> float:
    """Best-effort float coercion clamped to [0.0, 1.0].

    Mirrors the defensive shape ``signal_mutations._coerce_float`` uses
    so YAML-round-tripped percentage / string values survive.
    """
    if value is None:
        return default
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    if f != f:  # NaN
        return default
    if f > 1.0 and f <= 100.0:
        f = f / 100.0
    if f < 0.0:
        return 0.0
    if f > 1.0:
        return 1.0
    return f


def _parse_action_proposal(value: Any) -> dict[str, Any] | None:
    """Coerce a frontmatter ``action_proposal`` field into a dict.

    ``write_signal_record`` serialises ``action_proposal`` as inline
    JSON in YAML. The ctrl-api PATCH path keeps that structure
    end-to-end, but a record written through an older scalar-only path
    may have stringified it. JSON-decode as a fallback so we don't drop
    a salvageable signal.
    """
    import json

    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        s = value.strip()
        if not s or s.lower() in ("null", "none"):
            return None
        try:
            decoded = json.loads(s)
        except (json.JSONDecodeError, TypeError):
            return None
        return decoded if isinstance(decoded, dict) else None
    return None


def _parse_input_patterns(value: Any) -> dict[str, Any]:
    """Coerce an instinct's ``input_patterns`` field to a dict.

    Production data on david stores ``input_patterns`` as a JSON string
    inside frontmatter (see
    ``vault/instinct/batch-newsletter-noise-to-digest.md``); some older
    instincts stored it as a native YAML mapping. Tolerate both.
    """
    import json

    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return {}
        try:
            decoded = json.loads(s)
        except (json.JSONDecodeError, TypeError):
            return {}
        return decoded if isinstance(decoded, dict) else {}
    return {}


def _tokenize(text: str) -> set[str]:
    """Lowercase, split on non-alnum, drop short tokens.

    Used by the instinct matcher to score (signal text) vs.
    (instinct description + input_patterns). Conservative tokenizer —
    no stemming, no stopword removal — because the corpus is short and
    we want determinism over precision. Tokens <3 chars are dropped to
    cut down on "of/to/is" noise that would dominate Jaccard.
    """
    import re

    if not text:
        return set()
    parts = re.split(r"[^A-Za-z0-9]+", text.lower())
    return {p for p in parts if len(p) >= 3}


def _score_signal_against_instinct(
    signal_text: str,
    instinct: dict[str, Any],
) -> float:
    """Return a 0.0–1.0 similarity score between a signal and an instinct.

    Algorithm: token-set Jaccard between
    ``tokens(signal_text)`` and
    ``tokens(instinct.description + flatten(input_patterns))``.

    We weight ``input_patterns`` 2x by repeating its tokens — the
    pattern fields (``sender_domains``, ``subject_keywords``,
    ``input_types``) are the operationally significant signal. The
    description gets 1x weight to fold in semantic context that
    patterns can't express.

    Pure Python; deterministic; no LLM. Good enough as a first-pass
    filter — the discretion threshold then gates whether we autonomously
    dispatch. If the rough score plus the high-confidence threshold
    isn't enough to safely auto-dispatch, the human path catches it.
    """
    fm = instinct.get("frontmatter")
    if not isinstance(fm, dict):
        fm = instinct
    description = str(fm.get("description") or "").strip()
    input_patterns = _parse_input_patterns(fm.get("input_patterns"))

    instinct_text_parts: list[str] = []
    if description:
        instinct_text_parts.append(description)
    # Flatten input_patterns values — sender_domains, subject_keywords,
    # input_types, attachment_types — into one token corpus, then add
    # them again to weight 2x.
    pattern_tokens: list[str] = []
    for v in input_patterns.values():
        if isinstance(v, list):
            pattern_tokens.extend(str(x) for x in v if x is not None)
        elif isinstance(v, str):
            pattern_tokens.append(v)
    if pattern_tokens:
        instinct_text_parts.append(" ".join(pattern_tokens))
        instinct_text_parts.append(" ".join(pattern_tokens))

    instinct_tokens = _tokenize(" ".join(instinct_text_parts))
    signal_tokens = _tokenize(signal_text)
    if not instinct_tokens or not signal_tokens:
        return 0.0

    overlap = signal_tokens & instinct_tokens
    union = signal_tokens | instinct_tokens
    if not union:
        return 0.0
    return len(overlap) / len(union)


def _instinct_threshold(instinct: dict[str, Any]) -> float:
    """Pull the per-instinct discretion threshold from frontmatter.

    Falls back to ``DEFAULT_DISCRETION_THRESHOLD`` (0.85) when absent.
    Mirrors the contract in
    ``src.matching.discretion.should_route_autonomously`` — that helper
    looks up ``instinct["discretion_threshold"]`` directly, but the
    instincts we list from ctrl-api come back with the threshold inside
    ``frontmatter``. We unwrap here so the two callsites converge.
    """
    fm = instinct.get("frontmatter")
    if not isinstance(fm, dict):
        fm = instinct
    raw = fm.get("discretion_threshold")
    if raw is None:
        return DEFAULT_DISCRETION_THRESHOLD
    try:
        f = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_DISCRETION_THRESHOLD
    if f != f or f < 0.0:
        return DEFAULT_DISCRETION_THRESHOLD
    if f > 1.0:
        return 1.0
    return f


def _safe_filename_slug(s: str) -> str:
    """Lowercase + hyphenate a slug so it survives as a filename component.

    Mirrors ``steward._safe_filename_slug`` so audit / needs_attention
    records use the same naming convention everywhere.
    """
    import re

    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9_-]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "signal"


def _now_utc_iso() -> str:
    """Current UTC timestamp as second-precision ISO-8601."""
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ts_filename(ts_iso: str) -> str:
    """Convert an ISO timestamp into a filename-safe slice.

    ``2026-05-06T12:30:15+00:00`` → ``2026-05-06T12-30-15Z``. Same rule
    ``signals._slug_timestamp`` uses; duplicated locally to keep this
    module's surface free of cross-imports from peer activity files
    (which would risk circular imports during worker validation).
    """
    import re

    ts = (ts_iso or "").strip()
    if not ts:
        return "1970-01-01T00-00-00Z"
    ts = ts.replace("+00:00", "Z").replace(":", "-")
    ts = re.sub(r"[^A-Za-z0-9TZ\-]", "-", ts)
    return ts or "1970-01-01T00-00-00Z"


# ---------------------------------------------------------------------------
# Instinct cache — module-level, per-worker
# ---------------------------------------------------------------------------

async def _load_active_instincts(force: bool = False) -> list[dict[str, Any]]:
    """Return all active instincts, cached for ``_INSTINCTS_CACHE_TTL_SECS``.

    Instincts change at most daily (ReflectionWorkflow runs at 2am).
    Refetching from ctrl-api on every signal would flood the API for
    no win, so we cache module-level. ``force=True`` bypasses the
    cache (kept as an escape hatch — not used by the activity body but
    handy for future smoke tests).

    Cache state is per-worker-process. Restarting alfred-learn (the
    deploy path) drops the cache, so a fresh-instinct deploy is picked
    up on the next router tick after restart even before the TTL
    expires.
    """
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    loaded_at = _INSTINCTS_CACHE.get("loaded_at")
    if (
        not force
        and isinstance(loaded_at, datetime)
        and (now - loaded_at).total_seconds() < _INSTINCTS_CACHE_TTL_SECS
    ):
        return list(_INSTINCTS_CACHE.get("data") or [])

    # Lazy imports — see module docstring re: Temporal sandbox.
    import httpx
    from src.config import load_config
    from src.utils.vault_client import VaultClient

    cfg = load_config()
    client = VaultClient(cfg)
    try:
        try:
            records = await client.list_records("instinct", status="active")
        except httpx.HTTPError as exc:
            logger.warning(
                "signal_actions._load_active_instincts: list failed err=%s",
                exc,
            )
            # Don't poison the cache — return whatever we had previously
            # so a transient ctrl-api blip doesn't degrade the matcher.
            return list(_INSTINCTS_CACHE.get("data") or [])
    finally:
        await client.close()

    if not isinstance(records, list):
        records = []
    _INSTINCTS_CACHE["loaded_at"] = now
    _INSTINCTS_CACHE["data"] = records
    return list(records)


# ---------------------------------------------------------------------------
# Matcher — pick the best instinct for a signal
# ---------------------------------------------------------------------------

def _build_signal_text(signal_fm: dict[str, Any]) -> str:
    """Compose the signal-side text we score against each instinct.

    Combines ``action_proposal.what`` + the raw quote (which carries
    the original event content). We deliberately exclude the LLM
    reasoning to avoid steering the matcher with the LLM's own
    word choices for the proposed action.
    """
    proposal = _parse_action_proposal(signal_fm.get("action_proposal")) or {}
    parts: list[str] = []
    what = str(proposal.get("what") or "").strip()
    if what:
        parts.append(what)
    raw_quote = str(signal_fm.get("raw_quote") or "").strip()
    if raw_quote:
        parts.append(raw_quote)
    return " ".join(parts)


def _match_best_instinct(
    signal_fm: dict[str, Any],
    instincts: list[dict[str, Any]],
) -> tuple[dict[str, Any] | None, float]:
    """Return ``(instinct, score)`` of the best match, or ``(None, 0.0)``.

    Below ``MATCH_FLOOR`` we treat as "no matching instinct" (returns
    ``(None, score)``) so the caller takes the HUMAN path; ``score`` is
    still surfaced for the audit record so Sir can see how close we got.
    """
    signal_text = _build_signal_text(signal_fm)
    if not signal_text or not instincts:
        return None, 0.0
    best: dict[str, Any] | None = None
    best_score = 0.0
    for inst in instincts:
        if not isinstance(inst, dict):
            continue
        score = _score_signal_against_instinct(signal_text, inst)
        if score > best_score:
            best_score = score
            best = inst
    if best is None or best_score < MATCH_FLOOR:
        return None, best_score
    return best, best_score


# ---------------------------------------------------------------------------
# Audit record emission
# ---------------------------------------------------------------------------

async def _emit_signal_action_audit(
    *,
    signal_path: str,
    signal_fm: dict[str, Any],
    matched_instinct_path: str | None,
    matched_instinct_name: str | None,
    match_score: float,
    threshold: float,
    combined_confidence: float,
    chosen_path: str,
    decision_reason: str,
    agent_outcome: dict[str, Any] | None,
    needs_attention_path: str | None,
    effective_mode: str,
    env_mode: str,
) -> str:
    """Write ``event/signal-action-<ts>-<id>.md`` audit record.

    Captures the full decision context so the router's choices stay
    auditable even after the source signal is purged. Mirrors the
    layout of ``event/steward-action-*.md`` (top-level scalars first,
    then JSON-as-YAML nested fields) so dashboard frontmatter scans
    keep working.

    Returns the written vault path. Errors propagate so Temporal retry
    handles transient ctrl-api failures.
    """
    import json

    import httpx
    from src.config import load_config
    from src.utils.vault_client import VaultClient

    ts_iso = _now_utc_iso()
    ts_part = _ts_filename(ts_iso)
    # Pick a stable per-record suffix so retries land on the same path.
    # The signal_path uniquely identifies the signal we're auditing;
    # hash a short slice of it.
    import hashlib

    suffix_input = (signal_path or "").encode("utf-8", errors="replace")
    suffix = hashlib.sha256(suffix_input).hexdigest()[:8]
    name = f"signal-action-{ts_part}-{suffix}"

    payload: dict[str, Any] = {
        "type": "signal-action",
        "timestamp": ts_iso,
        "signal_path": signal_path,
        "chosen_path": chosen_path,
        "decision_reason": decision_reason,
        "matched_instinct": matched_instinct_path,
        "matched_instinct_name": matched_instinct_name,
        "match_score": round(match_score, 4),
        "threshold": round(threshold, 4),
        "combined_confidence": round(combined_confidence, 4),
        "effective_mode": effective_mode,
        "env_mode": env_mode,
        "needs_attention_path": needs_attention_path,
        "source_event_path": str(signal_fm.get("source_event_path") or ""),
        "source_type": str(signal_fm.get("source_type") or ""),
        "target_path": signal_fm.get("target_path"),
        "target_kind": signal_fm.get("target_kind"),
        "agent_outcome": agent_outcome,
    }

    # Render as JSON-as-YAML — same trick steward._render_audit_yaml uses.
    # YAML 1.2 is a strict superset of JSON for the structures we emit,
    # so json.dumps with indentation parses cleanly through js-yaml on
    # the read side.
    SCALAR_KEYS = (
        "type", "timestamp", "signal_path", "chosen_path",
        "decision_reason", "matched_instinct", "matched_instinct_name",
        "match_score", "threshold", "combined_confidence",
        "effective_mode", "env_mode", "needs_attention_path",
        "source_event_path", "source_type", "target_path", "target_kind",
    )
    NESTED_KEYS = ("agent_outcome",)

    def _scalar(v: Any) -> str:
        if v is None:
            return "null"
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, (int, float)):
            return str(v)
        s = str(v).replace("\\", "\\\\").replace('"', '\\"')
        return f'"{s}"'

    fm_lines: list[str] = []
    for k in SCALAR_KEYS:
        if k in payload:
            fm_lines.append(f"{k}: {_scalar(payload[k])}")
    for k in NESTED_KEYS:
        if k in payload:
            blob = json.dumps(payload[k], ensure_ascii=False, indent=2, default=str)
            fm_lines.append(f"{k}: {blob}")

    # Body — short human-readable summary.
    body_lines: list[str] = []
    body_lines.append(f"# signal-action: {chosen_path}")
    body_lines.append("")
    body_lines.append(f"- Reason: **{decision_reason}**")
    body_lines.append(f"- Source signal: `{signal_path}`")
    if matched_instinct_path:
        body_lines.append(
            f"- Matched instinct: `{matched_instinct_path}` "
            f"(score={match_score:.2f}, threshold={threshold:.2f})"
        )
    else:
        body_lines.append(
            f"- No matching instinct (best score={match_score:.2f}, "
            f"floor={MATCH_FLOOR:.2f})"
        )
    body_lines.append(
        f"- Combined confidence: {combined_confidence:.2f} "
        f"(mode={effective_mode}, env={env_mode})"
    )
    if needs_attention_path:
        body_lines.append(f"- Needs-attention card: `{needs_attention_path}`")
    if agent_outcome and isinstance(agent_outcome, dict):
        summary = str(agent_outcome.get("agent_response_summary") or "")
        if summary:
            body_lines.append(f"- Agent response: {summary}")
        outcome_path = str(agent_outcome.get("outcome_signal_path") or "")
        if outcome_path:
            body_lines.append(f"- Outcome signal: `{outcome_path}`")

    content = (
        "---\n" + "\n".join(fm_lines) + "\n---\n\n" + "\n".join(body_lines) + "\n"
    )

    cfg = load_config()
    client = VaultClient(cfg)
    try:
        try:
            return await client.write_record(
                record_type="event", name=name, content=content,
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "signal_actions._emit_signal_action_audit: write failed "
                "name=%s err=%s",
                name, exc,
            )
            raise
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Activity: write_needs_attention_record (T6.4.3)
# ---------------------------------------------------------------------------

@activity.defn
async def write_needs_attention_record(
    signal: dict[str, Any],
    matched_instinct_path: str | None,
    decision_reason: str,
) -> str:
    """Write a ``needs_attention/<ts>-<id>.md`` card for Sir's surface.

    Args:
      signal: full record dict (frontmatter + body) of the source signal.
      matched_instinct_path: the best-match instinct path, or ``None`` if
        none cleared the match floor.
      decision_reason: one of ``"no_matching_instinct"``,
        ``"low_confidence"``, ``"shadow_mode"``.

    Returns the written vault path.

    Idempotency: filename derives deterministically from the signal's
    ``source_event_path`` + ``raw_quote`` so a Temporal retry hits the
    same path. Status starts at ``pending``; ctrl-api endpoints (T6.4.5)
    will mutate it to ``done``/``dispatched``/``skipped``.
    """
    import hashlib
    import json

    import httpx
    from src.config import load_config
    from src.utils.vault_client import VaultClient

    if not isinstance(signal, dict):
        raise ValueError(
            f"write_needs_attention_record: signal must be dict, got "
            f"{type(signal).__name__}"
        )

    fm = signal.get("frontmatter") or {}
    if not isinstance(fm, dict):
        fm = {}

    proposal = _parse_action_proposal(fm.get("action_proposal")) or {}

    source_event_path = str(fm.get("source_event_path") or "")
    raw_quote = str(fm.get("raw_quote") or "")
    reasoning = str(fm.get("reasoning") or "")
    source_signal_path = str(signal.get("path") or "")
    target_path = fm.get("target_path")
    target_kind = fm.get("target_kind")
    action_what = str(proposal.get("what") or "").strip()
    suggested_actor = str(proposal.get("suggested_actor") or "").strip()
    due_at = proposal.get("due_at")
    # Voiced surface fields lifted from the signal frontmatter when
    # the extraction prompt produced them. The desk renders these in
    # preference to action_what / reasoning.
    display_headline_raw = fm.get("display_headline")
    display_body_raw = fm.get("display_body")
    display_headline = (
        str(display_headline_raw).strip()
        if isinstance(display_headline_raw, str) and display_headline_raw.strip()
        else ""
    )
    display_body = (
        str(display_body_raw).strip()
        if isinstance(display_body_raw, str) and display_body_raw.strip()
        else ""
    )

    # Confidence — for actions, target_confidence only gates when there
    # IS a target (target_kind set). Many actions don't bind to a specific
    # task ("auto-route newsletters", "send confirmation email") — gating
    # those on target_confidence=0 would force every targetless action to
    # the human path even when the matched instinct's threshold is clearly
    # satisfied by effect_confidence alone.
    target_confidence = _coerce_float(fm.get("target_confidence"), 0.0)
    effect_confidence = _coerce_float(fm.get("effect_confidence"), 0.0)
    if target_kind in ("task", "matter"):
        combined_confidence = min(target_confidence, effect_confidence)
    else:
        combined_confidence = effect_confidence

    # Idempotency: derive the filename from STABLE inputs only. The
    # docstring claims "filename derives deterministically from
    # source_event_path + raw_quote so a Temporal retry hits the same
    # path" — but the original code used _now_utc_iso() for the
    # timestamp prefix, which advances on every retry. Result: all
    # retries had the same `-<short_id>` suffix but unique timestamp
    # prefixes, so each retry wrote a NEW file instead of overwriting
    # the previous attempt. Confirmed on david 2026-05-12: a single
    # signal produced 38 needs_attention cards across retries +
    # workflow ticks.
    #
    # Fix: anchor the timestamp to the source signal's `created`
    # field (stable across retries) rather than current time. The
    # short_id is already a hash of source_event_path + raw_quote.
    # Both inputs survive Temporal retries unchanged, so the full
    # name is now genuinely deterministic.
    signal_created = str(fm.get("created") or "").strip()
    ts_iso_for_name = signal_created or _now_utc_iso()
    ts_now = _now_utc_iso()  # for the `created` field on the card itself
    ts_part = _ts_filename(ts_iso_for_name)
    digest_input = (
        f"{source_event_path}\x00{raw_quote}".encode("utf-8", errors="replace")
    )
    short_id = hashlib.sha256(digest_input).hexdigest()[:8]
    name = f"{ts_part}-{short_id}"

    # Pre-write idempotency check. Even with the deterministic name,
    # write_record may not be atomic with respect to retries from
    # parallel ticks. Belt-and-suspenders: if the target path already
    # exists, return it instead of writing again.
    target_existing_path = f"needs_attention/{name}.md"
    try:
        check_cfg = load_config()
        check_client = VaultClient(check_cfg)
        try:
            existing = await check_client.read_record(target_existing_path)
            if isinstance(existing, dict):
                logger.info(
                    "signal_actions.write_needs_attention_record: "
                    "idempotency hit — path=%s already exists (retry)",
                    target_existing_path,
                )
                return target_existing_path
        except httpx.HTTPStatusError as exc:
            if exc.response is None or exc.response.status_code != 404:
                raise
            # 404 → not present → safe to write below.
        finally:
            await check_client.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "signal_actions.write_needs_attention_record: "
            "idempotency check failed (continuing to write) err=%s",
            exc,
        )

    def _scalar(v: Any) -> str:
        if v is None:
            return "null"
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, (int, float)):
            return str(v)
        s = str(v).replace("\\", "\\\\").replace('"', '\\"')
        return f'"{s}"'

    # ``due_at`` — preserve None vs. string distinction. The
    # action_proposal schema uses null when no deadline applies.
    if due_at is None:
        due_at_yaml = "null"
    else:
        due_at_yaml = _scalar(str(due_at))

    # origin_at = when the underlying real-world event happened. Copy
    # from the source signal so /desk can show the principal's clock
    # (when the email arrived, when the meeting was) instead of
    # Alfred's clock (when this card was written).
    signal_origin_at = str(fm.get("origin_at") or "").strip()
    origin_at_line = (
        f"origin_at: {_scalar(signal_origin_at)}"
        if signal_origin_at else "origin_at: null"
    )

    fm_lines = [
        "---",
        f"type: {_scalar('needs_attention')}",
        f"created: {_scalar(ts_now)}",
        origin_at_line,
        f"source_signal_path: {_scalar(source_signal_path)}",
        f"source_event_path: {_scalar(source_event_path)}",
        f"action_what: {_scalar(action_what)}",
        f"suggested_actor: {_scalar(suggested_actor)}",
        f"due_at: {due_at_yaml}",
        f"target_path: {_scalar(target_path) if target_path else 'null'}",
        f"target_kind: {_scalar(target_kind) if target_kind else 'null'}",
        f"matched_instinct: {_scalar(matched_instinct_path) if matched_instinct_path else 'null'}",
        f"decision_reason: {_scalar(decision_reason)}",
        f"confidence: {round(combined_confidence, 4)}",
        f"target_confidence: {round(target_confidence, 4)}",
        f"effect_confidence: {round(effect_confidence, 4)}",
        f"status: {_scalar('pending')}",
        # raw_quote + reasoning as JSON-encoded scalars to survive
        # multi-line content + YAML metacharacters cleanly.
        f"raw_quote: {json.dumps(raw_quote, ensure_ascii=False)}",
        f"reasoning: {json.dumps(reasoning, ensure_ascii=False)}",
        # Voiced surface fields — only emitted when the upstream
        # signal carried them. Same JSON-encoded scalar trick so
        # quotes/newlines/em-dashes survive intact.
        f"display_headline: {json.dumps(display_headline, ensure_ascii=False)}"
        if display_headline else "display_headline: null",
        f"display_body: {json.dumps(display_body, ensure_ascii=False)}"
        if display_body else "display_body: null",
        "---",
        "",
    ]

    # Body — Sir-readable card. Mirrors how steward audit bodies render
    # in the dashboard so the visual style stays consistent.
    body_lines: list[str] = []
    body_lines.append(f"# Needs Attention: {action_what or '(no action text)'}")
    body_lines.append("")
    if suggested_actor:
        body_lines.append(f"**Suggested actor:** {suggested_actor}")
    if due_at:
        body_lines.append(f"**Due:** {due_at}")
    if target_path:
        body_lines.append(
            f"**Target:** `{target_path}` ({target_kind or 'unknown kind'})"
        )
    else:
        body_lines.append("**Target:** none — open-ended action")
    body_lines.append("")
    body_lines.append(f"_Decision reason:_ **{decision_reason}**")
    body_lines.append(
        f"_Confidence:_ {combined_confidence:.2f} "
        f"(target {target_confidence:.2f} · effect {effect_confidence:.2f})"
    )
    if matched_instinct_path:
        body_lines.append(f"_Matched instinct:_ `{matched_instinct_path}`")
    body_lines.append("")
    if reasoning:
        body_lines.append("## Reasoning")
        body_lines.append("")
        body_lines.append(reasoning)
        body_lines.append("")
    if raw_quote:
        body_lines.append("## Raw quote")
        body_lines.append("")
        for line in raw_quote.splitlines() or [raw_quote]:
            body_lines.append(f"> {line}")
        body_lines.append("")
    body_lines.append("## Source")
    body_lines.append("")
    body_lines.append(f"- Signal: `{source_signal_path or '(unknown)'}`")
    if source_event_path:
        body_lines.append(f"- Event: `{source_event_path}`")

    content = "\n".join(fm_lines) + "\n".join(body_lines) + "\n"

    cfg = load_config()
    client = VaultClient(cfg)
    try:
        try:
            written = await client.write_record(
                record_type="needs_attention", name=name, content=content,
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "signal_actions.write_needs_attention_record: write failed "
                "name=%s err=%s",
                name, exc,
            )
            raise
        logger.info(
            "signal_actions.write_needs_attention_record: wrote path=%s "
            "reason=%s confidence=%.2f matched=%s",
            written, decision_reason, combined_confidence,
            matched_instinct_path or "none",
        )
        return written
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Activity: dispatch_action_to_agent (T6.4.2)
# ---------------------------------------------------------------------------

@activity.defn
async def dispatch_action_to_agent(
    action_proposal: dict[str, Any],
    target_path: str | None,
    matched_instinct_path: str,
) -> dict[str, Any]:
    """Dispatch an autonomous action to openclaw main via clerk subagent.

    Builds an "act as Alfred main" prompt and calls
    ``clerk._call_clerk`` with ``raw=True`` so we get the agent's
    natural-language response back. The response is recorded as a
    follow-up signal record (``record_type=signal``,
    ``source_type=agent_outcome``) so the audit trail captures what
    the agent actually did.

    Args:
      action_proposal: the signal's ``action_proposal`` dict
        (``{"what", "suggested_actor", "due_at"}``).
      target_path: optional target task/matter path; ``None`` means
        open-ended action.
      matched_instinct_path: vault path of the instinct that authorised
        autonomous dispatch (used for context in the prompt and for the
        outcome signal record's provenance).

    Returns ``{"outcome_signal_path": "...", "agent_response_summary": "..."}``.

    Errors propagate so Temporal retry handles transient clerk /
    ctrl-api failures. The router's per-signal try/except catches the
    re-raise and counts it as an error so a wedged clerk doesn't sink
    the rest of the batch.
    """
    import hashlib
    import json

    import httpx
    from src.activities.clerk import _call_clerk
    from src.config import load_config
    from src.utils.vault_client import VaultClient

    if not isinstance(action_proposal, dict):
        raise ValueError(
            f"dispatch_action_to_agent: action_proposal must be dict, got "
            f"{type(action_proposal).__name__}"
        )

    what = str(action_proposal.get("what") or "").strip()
    suggested_actor = str(action_proposal.get("suggested_actor") or "").strip()
    due_at = action_proposal.get("due_at")

    if not what:
        raise ValueError(
            "dispatch_action_to_agent: action_proposal.what is empty"
        )

    # Read the matched instinct for guidance text — ctrl-api list returns
    # frontmatter only on most paths, so re-read the record for body too.
    instinct_description = ""
    instinct_name = ""
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        try:
            inst_rec = await client.read_record(matched_instinct_path)
        except (httpx.HTTPError, OSError) as exc:
            logger.warning(
                "signal_actions.dispatch_action_to_agent: instinct read "
                "failed path=%s err=%s — proceeding with empty guidance",
                matched_instinct_path, exc,
            )
            inst_rec = None
        if isinstance(inst_rec, dict):
            inst_fm = inst_rec.get("frontmatter") or {}
            if isinstance(inst_fm, dict):
                instinct_description = str(
                    inst_fm.get("description") or ""
                ).strip()
                instinct_name = str(inst_fm.get("name") or "").strip()
    finally:
        await client.close()

    if not instinct_name:
        # Fall back to filename stem so the prompt always has SOMETHING
        # human-readable.
        stem = matched_instinct_path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        instinct_name = stem or "unknown-instinct"

    target_clause = f"`{target_path}`" if target_path else "none"
    due_clause = str(due_at) if due_at else "none"
    guidance_clause = instinct_description or "(no guidance text on record)"

    prompt = (
        "You are Alfred. Sir has an item that needs handling automatically "
        f"per his instinct '{instinct_name}'.\n\n"
        f"Action: {what}\n"
        f"Suggested actor: {suggested_actor or 'unspecified'}\n"
        f"Due: {due_clause}\n"
        f"Target task/matter: {target_clause}\n\n"
        f"Instinct guidance: {guidance_clause}\n\n"
        "Do the action and report what you did in 1-2 sentences."
    )

    # Call clerk with raw=True — we want natural-language response, not
    # JSON. The clerk subagent has full tool access (Plane, vault, etc.)
    # so it can actually carry out the action.
    try:
        agent_raw = await _call_clerk(prompt, raw=True)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "signal_actions.dispatch_action_to_agent: clerk call failed "
            "what=%r instinct=%s err=%s",
            what[:100], matched_instinct_path, exc,
        )
        raise

    # _call_clerk(raw=True) returns str | dict — defensively coerce.
    if isinstance(agent_raw, dict):
        agent_text = json.dumps(agent_raw, ensure_ascii=False)
    else:
        agent_text = str(agent_raw or "").strip()

    summary = agent_text[:500]
    if len(agent_text) > 500:
        summary = summary + "…"

    # Write the outcome as a follow-up signal record. We use the existing
    # signal/ record_type so the same dashboard / audit views surface it.
    ts_iso = _now_utc_iso()
    ts_part = _ts_filename(ts_iso)
    digest_input = f"{matched_instinct_path}\x00{what}\x00{ts_iso}".encode(
        "utf-8", errors="replace",
    )
    short_id = hashlib.sha256(digest_input).hexdigest()[:8]
    outcome_name = f"{ts_part}-agent-outcome-{short_id}"

    def _scalar(v: Any) -> str:
        if v is None:
            return "null"
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, (int, float)):
            return str(v)
        s = str(v).replace("\\", "\\\\").replace('"', '\\"')
        return f'"{s}"'

    fm_lines = [
        "---",
        f"type: {_scalar('signal')}",
        f"created: {_scalar(ts_iso)}",
        f"source_type: {_scalar('agent_outcome')}",
        f"source_event_path: {_scalar('')}",
        f"matched_instinct: {_scalar(matched_instinct_path)}",
        f"matched_instinct_name: {_scalar(instinct_name)}",
        f"target_path: {_scalar(target_path) if target_path else 'null'}",
        f"action_what: {_scalar(what)}",
        f"suggested_actor: {_scalar(suggested_actor)}",
        f"effect: {_scalar('agent_outcome')}",
        # The router-managed status fields stay at their terminal values;
        # this is a leaf record (the agent has spoken).
        f"status: {_scalar('agent_responded')}",
        f"agent_response: {json.dumps(agent_text, ensure_ascii=False)}",
        "---",
        "",
    ]
    body_lines = [
        f"# Agent outcome for: {what}",
        "",
        f"**Instinct:** `{matched_instinct_path}` ({instinct_name})",
        f"**Target:** {target_clause}",
        "",
        "## Agent response",
        "",
        agent_text or "(empty response)",
        "",
    ]
    content = "\n".join(fm_lines) + "\n".join(body_lines) + "\n"

    cfg = load_config()
    client = VaultClient(cfg)
    try:
        try:
            outcome_path = await client.write_record(
                record_type="signal", name=outcome_name, content=content,
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "signal_actions.dispatch_action_to_agent: outcome record "
                "write failed name=%s err=%s",
                outcome_name, exc,
            )
            raise
    finally:
        await client.close()

    logger.info(
        "signal_actions.dispatch_action_to_agent: dispatched + recorded "
        "instinct=%s target=%s outcome=%s",
        matched_instinct_path, target_path or "none", outcome_path,
    )

    return {
        "outcome_signal_path": outcome_path,
        "agent_response_summary": summary,
    }


# ---------------------------------------------------------------------------
# Activity: route_signal_action (T6.4.1)
# ---------------------------------------------------------------------------

@activity.defn
async def route_signal_action(
    signal_path: str,
    mode: str = "shadow",
) -> dict[str, Any]:
    """Route one ``effect=action`` signal to agent dispatch or human surface.

    Steps (mirrors the spec docstring):

      1. Read the signal record.
      2. Validate ``effect == "action"``. Else no-op (defensive).
      3. Load active instincts (cached).
      4. Match against instincts. Below ``MATCH_FLOOR`` → no-match.
      5. Compute combined confidence ``min(target, effect)``.
      6. Resolve effective mode: caller-mode ∩ env-veto.
      7. Branch:
         a. HIGH path — instinct + threshold + non-shadow → dispatch.
         b. HUMAN path — anything else → write needs_attention card.
      8. Mark signal status (``routed_agent`` / ``routed_human``) +
         ``audit_record_path`` (the outcome signal path or the
         needs_attention path, respectively) + ``applied_at``.
      9. Emit the audit ``event/signal-action-*.md`` record.

    Returns a dict matching the workflow's expected counter shape::

        {
          "signal_path": "...",
          "signal_status": "routed_agent" | "routed_human" | "skipped",
          "skip_reason": "" | "<why>",
          "chosen_path": "agent" | "human" | "skipped",
          "decision_reason": "high_confidence_match" | ...,
          "audit_record_path": "event/signal-action-...md",
          "needs_attention_path": "needs_attention/...md" | None,
          "outcome_signal_path": "signal/...-agent-outcome-...md" | None,
          "matched_instinct": "instinct/..." | None,
          "match_score": 0.0..1.0,
          "threshold": 0.0..1.0,
          "combined_confidence": 0.0..1.0,
          "effective_mode": "shadow" | "live" | ...,
        }
    """
    import httpx
    from src.config import load_config
    from src.utils.vault_client import VaultClient

    if not signal_path or not isinstance(signal_path, str):
        raise ValueError(
            f"route_signal_action: invalid signal_path={signal_path!r}"
        )
    if mode not in ("shadow", "live"):
        raise ValueError(
            f"route_signal_action: unsupported mode={mode!r}"
        )

    env_mode = _resolve_signal_action_mode()
    # Caller-intent ∩ env-veto. Env can only DOWNGRADE — even if the
    # caller passes mode='live', env=shadow forces shadow on this tick.
    if mode == "live" and env_mode == "shadow":
        effective_mode = "shadow"
        logger.info(
            "signal_actions.route_signal_action: downgraded caller "
            "mode='live' to 'shadow' — %s=shadow",
            SIGNAL_ACTION_LIVE_MODE_ENV,
        )
    else:
        effective_mode = mode

    cfg = load_config()
    client = VaultClient(cfg)
    try:
        # 1. Read the signal record.
        try:
            record = await client.read_record(signal_path)
        except httpx.HTTPStatusError as exc:
            if exc.response is not None and exc.response.status_code == 404:
                logger.warning(
                    "signal_actions.route_signal_action: 404 path=%s "
                    "— signal vanished",
                    signal_path,
                )
                return {
                    "signal_path": signal_path,
                    "signal_status": "skipped",
                    "skip_reason": "signal_not_found",
                    "chosen_path": "skipped",
                }
            raise
        if not isinstance(record, dict):
            return {
                "signal_path": signal_path,
                "signal_status": "skipped",
                "skip_reason": "bad_record_shape",
                "chosen_path": "skipped",
            }

        fm = record.get("frontmatter") or {}
        if not isinstance(fm, dict):
            fm = {}

        # Idempotency guard. If the signal is already routed, return a
        # skip — the activity is being retried (likely because a prior
        # attempt's PATCH step failed and Temporal re-ran the whole
        # function from the top). Without this gate, every retry calls
        # `write_needs_attention_record` again, leaving duplicate
        # pending cards on the Desk. Symptom on david 2026-05-12:
        # 38 needs_attention cards from a single signal, all created
        # in clusters of 3 every ~2 min as the workflow ticked + the
        # retry chain fired. With the guard: re-entry returns early,
        # no duplicate write, no duplicate audit, signal stays at its
        # already-set status.
        existing_status = str(fm.get("status") or "").strip().lower()
        if existing_status in ("routed_human", "routed_agent"):
            logger.info(
                "signal_actions.route_signal_action: idempotency skip "
                "path=%s already_status=%s",
                signal_path, existing_status,
            )
            return {
                "signal_path": signal_path,
                "signal_status": existing_status,
                "skip_reason": "already_routed",
                "chosen_path": "skipped",
                "decision_reason": "idempotency_guard",
                "audit_record_path": str(fm.get("audit_record_path") or ""),
                "needs_attention_path": None,
                "outcome_signal_path": None,
            }

        # 2. Validate effect.
        effect = str(fm.get("effect") or "").strip().lower()
        if effect != "action":
            return {
                "signal_path": signal_path,
                "signal_status": "skipped",
                "skip_reason": f"effect_is_{effect or 'missing'}",
                "chosen_path": "skipped",
            }

        proposal = _parse_action_proposal(fm.get("action_proposal"))
        if not proposal or not isinstance(proposal, dict):
            return {
                "signal_path": signal_path,
                "signal_status": "skipped",
                "skip_reason": "no_action_proposal",
                "chosen_path": "skipped",
            }

        # 3. Load instincts (cached).
        instincts = await _load_active_instincts()

        # 4. Match.
        matched, match_score = _match_best_instinct(fm, instincts)
        matched_path: str | None = None
        matched_name: str | None = None
        threshold = DEFAULT_DISCRETION_THRESHOLD
        if matched is not None:
            matched_path = str(matched.get("path") or "").strip() or None
            inst_fm = matched.get("frontmatter") or matched
            if isinstance(inst_fm, dict):
                matched_name = str(inst_fm.get("name") or "").strip() or None
            threshold = _instinct_threshold(matched)

        # 5. Combined confidence — for actions, target_confidence only
        # gates when there IS a target (target_kind set). Many actions
        # don't bind to a specific task ("auto-route newsletters") —
        # gating those on target_confidence=0 would force every
        # targetless action to the human path even when the matched
        # instinct's threshold is clearly satisfied by effect_confidence
        # alone.
        target_confidence = _coerce_float(fm.get("target_confidence"), 0.0)
        effect_confidence = _coerce_float(fm.get("effect_confidence"), 0.0)
        target_kind_for_combined = fm.get("target_kind")
        if target_kind_for_combined in ("task", "matter"):
            combined_confidence = min(target_confidence, effect_confidence)
        else:
            combined_confidence = effect_confidence

        # 6. Branch decision.
        chosen_path: str
        decision_reason: str
        agent_outcome: dict[str, Any] | None = None
        needs_attention_path: str | None = None

        if matched is None or matched_path is None:
            chosen_path = "human"
            decision_reason = "no_matching_instinct"
        elif combined_confidence < threshold:
            chosen_path = "human"
            decision_reason = "low_confidence"
        elif effective_mode == "shadow":
            chosen_path = "human"
            decision_reason = "shadow_mode"
        else:
            chosen_path = "agent"
            decision_reason = "high_confidence_match"

        # 7. Execute the branch.
        target_path = fm.get("target_path")
        if isinstance(target_path, str) and not target_path.strip():
            target_path = None

        if chosen_path == "agent":
            # We've passed all gates — dispatch.
            try:
                agent_outcome = await dispatch_action_to_agent(
                    proposal,
                    target_path,
                    matched_path or "",
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "signal_actions.route_signal_action: agent dispatch "
                    "failed path=%s err=%s — re-raising for Temporal retry",
                    signal_path, exc,
                )
                raise
        else:
            # HUMAN path — write the needs_attention card.
            needs_attention_path = await write_needs_attention_record(
                record,
                matched_path,
                decision_reason,
            )

        # 8. Emit the audit record.
        audit_path = await _emit_signal_action_audit(
            signal_path=signal_path,
            signal_fm=fm,
            matched_instinct_path=matched_path,
            matched_instinct_name=matched_name,
            match_score=match_score,
            threshold=threshold,
            combined_confidence=combined_confidence,
            chosen_path=chosen_path,
            decision_reason=decision_reason,
            agent_outcome=agent_outcome,
            needs_attention_path=needs_attention_path,
            effective_mode=effective_mode,
            env_mode=env_mode,
        )

        # 9. Mark the signal record. The audit record path goes into
        # ``audit_record_path``; ``status`` is the routing outcome.
        signal_status = (
            "routed_agent" if chosen_path == "agent" else "routed_human"
        )
        try:
            await client.patch_frontmatter_structured(
                signal_path,
                scalar_updates={
                    "status": signal_status,
                    "applied_at": _now_utc_iso(),
                    "audit_record_path": audit_path,
                },
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "signal_actions.route_signal_action: status PATCH failed "
                "path=%s status=%s err=%s",
                signal_path, signal_status, exc,
            )
            raise

        logger.info(
            "signal_actions.route_signal_action: routed path=%s "
            "chosen=%s reason=%s instinct=%s score=%.2f conf=%.2f "
            "threshold=%.2f mode=%s audit=%s",
            signal_path, chosen_path, decision_reason,
            matched_path or "none", match_score, combined_confidence,
            threshold, effective_mode, audit_path,
        )

        return {
            "signal_path": signal_path,
            "signal_status": signal_status,
            "skip_reason": "",
            "chosen_path": chosen_path,
            "decision_reason": decision_reason,
            "audit_record_path": audit_path,
            "needs_attention_path": needs_attention_path,
            "outcome_signal_path": (
                agent_outcome.get("outcome_signal_path") if agent_outcome else None
            ),
            "matched_instinct": matched_path,
            "match_score": round(match_score, 4),
            "threshold": round(threshold, 4),
            "combined_confidence": round(combined_confidence, 4),
            "effective_mode": effective_mode,
        }
    finally:
        await client.close()
