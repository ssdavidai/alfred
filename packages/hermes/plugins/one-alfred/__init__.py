"""one-alfred — Hermes plugin that bridges the per-session split.

Sir's UX principle: the user must feel they are talking to ONE Alfred,
always. Internal session/profile/worker boundaries must never leak into the
perceived relationship. See packages/ctrl/docs/design/one-alfred.md.

This plugin is the inbound-side seam (Pattern B in the design). It runs on
the `main` profile only — the workers/heavy profiles don't talk to Sir
directly so they don't need the bridge.

TWO HOOKS
---------

* ``pre_gateway_dispatch`` fires on every user-originated channel-inbound
  message (Telegram, Slack, …) BEFORE auth + dispatch. We query ctrl-api's
  alfred_journal for recent exchanges on this (channel, chat_id) — or on
  this principal across channels — and prepend the journal as ephemeral
  system context to Sir's actual message. Hermes' main agent sees a
  coherent conversation: "I sent you a reminder 4 minutes ago about X;
  Sir is now replying about it."

  We do NOT rewrite Sir's literal session log (no fabricated history) —
  we splice journal context into THIS turn's prompt only.

* ``post_llm_call`` fires after main has composed its reply on the inbound
  path. We journal the composed reply as a synthetic outbound entry. This
  keeps the journal sync'd with Hermes' actual session history even when
  main answers Sir directly (no alfred-deliver round trip).

CONFIGURATION
-------------

Read from env at startup. Defaults are sane for the home compose stack:

  ONE_ALFRED_CTRL_API_URL    http://ctrl-api:3100
  ONE_ALFRED_CTRL_API_KEY    read from /alfred-data/.gateway-token (fallback)
  ONE_ALFRED_RECENT_LIMIT    20    (hard ceiling — main's context budget)
  ONE_ALFRED_RECENT_HOURS    24    (recency cut)
  ONE_ALFRED_ENABLED         "1"   (kill-switch — set to "0" to disable)

FAIL-SOFT
---------

Every code path here is graceful: if ctrl-api is down, if the journal is
empty, if anything throws — the hook returns ``None`` / ``{"action":
"allow"}`` and Sir's reply goes through unaugmented. Hermes' default
behaviour is the floor; the plugin only raises it.

"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Optional
from urllib import error as urlerror, request as urlrequest


logger = logging.getLogger("one-alfred")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CTRL_API_URL_DEFAULT = "http://ctrl-api:3100"
TOKEN_PATHS = [
    "/alfred-data/.gateway-token",  # ctrl-api↔Hermes shared token in compose
    "/mnt/encrypted/alfred/.gateway-token",
    "/app/data/.gateway-token",
]


def _get_ctrl_api_url() -> str:
    return os.getenv("ONE_ALFRED_CTRL_API_URL") or CTRL_API_URL_DEFAULT


def _get_ctrl_api_key() -> str:
    """Resolve the AAS key used to call ctrl-api.

    Priority:
      1) ONE_ALFRED_CTRL_API_KEY env (explicit override)
      2) AAS_API_KEY env (matches the rest of the platform)
      3) /alfred-data/.gateway-token (file fallback)
    """
    env = os.getenv("ONE_ALFRED_CTRL_API_KEY") or os.getenv("AAS_API_KEY")
    if env:
        return env
    for p in TOKEN_PATHS:
        try:
            tok = Path(p).read_text(encoding="utf-8").strip()
            if tok:
                return tok
        except OSError:
            continue
    return ""


def _is_enabled() -> bool:
    return os.getenv("ONE_ALFRED_ENABLED", "1").strip().lower() in {
        "1", "true", "yes", "on",
    }


def _recent_limit() -> int:
    try:
        return max(1, min(50, int(os.getenv("ONE_ALFRED_RECENT_LIMIT", "20"))))
    except ValueError:
        return 20


def _recent_hours() -> float:
    try:
        return max(0.1, float(os.getenv("ONE_ALFRED_RECENT_HOURS", "24")))
    except ValueError:
        return 24.0


# ---------------------------------------------------------------------------
# ctrl-api client — synchronous urllib so we don't drag httpx into hermes
# ---------------------------------------------------------------------------

# Short, hard timeout — the hook is on the inbound hot path, Hermes' inbound
# loop blocks on our return. If ctrl-api is unreachable in 3s, we'd rather
# proceed without context than wedge Sir's reply.
_HTTP_TIMEOUT_S = float(os.getenv("ONE_ALFRED_HTTP_TIMEOUT_S", "3.0"))


def _http_get_json(path: str, params: dict[str, Any]) -> Optional[dict[str, Any]]:
    """GET ctrl-api with a hard timeout, return parsed JSON or None on any error."""
    if not _is_enabled():
        return None
    key = _get_ctrl_api_key()
    if not key:
        logger.warning("[one-alfred] no AAS key available; skipping journal lookup")
        return None
    qs = "&".join(
        f"{k}={urlrequest.quote(str(v))}"
        for k, v in params.items()
        if v is not None and v != ""
    )
    url = f"{_get_ctrl_api_url().rstrip('/')}{path}{'?' + qs if qs else ''}"
    req = urlrequest.Request(
        url,
        headers={
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urlrequest.urlopen(req, timeout=_HTTP_TIMEOUT_S) as resp:
            raw = resp.read()
            return json.loads(raw.decode("utf-8"))
    except urlerror.URLError as e:
        logger.warning("[one-alfred] ctrl-api GET %s failed: %s", path, e)
        return None
    except Exception as e:  # noqa: BLE001
        logger.warning("[one-alfred] ctrl-api GET %s parse failed: %s", path, e)
        return None


def _http_post_json(path: str, body: dict[str, Any]) -> Optional[dict[str, Any]]:
    if not _is_enabled():
        return None
    key = _get_ctrl_api_key()
    if not key:
        return None
    url = f"{_get_ctrl_api_url().rstrip('/')}{path}"
    data = json.dumps(body).encode("utf-8")
    req = urlrequest.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=_HTTP_TIMEOUT_S) as resp:
            raw = resp.read()
            if not raw:
                return {}
            return json.loads(raw.decode("utf-8"))
    except urlerror.URLError as e:
        logger.warning("[one-alfred] ctrl-api POST %s failed: %s", path, e)
        return None
    except Exception as e:  # noqa: BLE001
        logger.warning("[one-alfred] ctrl-api POST %s parse failed: %s", path, e)
        return None


# ---------------------------------------------------------------------------
# Journal → context block formatter
# ---------------------------------------------------------------------------

def _format_journal_context(entries: list[dict[str, Any]]) -> str:
    """Render journal entries into a system-context block.

    HARD-WON FROM A LIVE TEST (2026-05-25, Sir incident):
    Earlier framing said "Use it to maintain the illusion of one continuous
    conversation" — and the LLM treated that as advisory. Sir messaged "hm?"
    in reply to a delegate reminder Alfred had just sent; the journal
    context block was injected with the reminder text, but main agent
    answered "I don't remember sending you a reminder."

    Why: from main's POV, its actual Hermes session history (`messages[]`)
    had NO record of the reminder, because alfred-deliver delivers via the
    direct Telegram bot API (not as a turn in main's session). The context
    block was just text in a system tag the LLM could read or ignore. Given
    a conflict between "system tag claims X" and "session history shows
    nothing", a polite model defers to history.

    The fix here: re-frame the block as AUTHORITATIVE first-person memory
    that the assistant SHOULD treat as true even when it isn't in
    `messages[]`. Drop the "illusion / Use it to maintain" hedge and use
    direct first-person ownership ("YOU sent these"). Also explicitly tell
    the assistant the canonical answer pattern when the user references one.

    Lays entries out newest-last so main reads them in conversational order.
    """
    if not entries:
        return ""
    # entries come back newest-first from ctrl-api; flip for narrative order.
    in_order = list(reversed(entries))
    lines: list[str] = []
    lines.append(
        "[ALFRED-CONTINUITY — authoritative]"
    )
    lines.append(
        "The following are messages YOU (Alfred) sent to the principal,"
        " and messages the principal sent you, across channels — including"
        " ones delivered outside this session (by your background workers /"
        " scheduled reminders / cron). These DID happen. Treat them as part"
        " of your memory even if they are not in this session's chat history."
        " When the principal references one (\"what was that reminder?\","
        " \"the one you sent me\", \"hm?\"), the answer must come from here."
    )
    lines.append("")
    for e in in_order:
        ts = str(e.get("ts", ""))[:19]
        direction = str(e.get("direction", "?"))
        channel = str(e.get("channel", "?"))
        message = str(e.get("message", "")).strip()
        if not message:
            continue
        # Compact label. Use first-person ownership for outbound so the
        # LLM internalises it as something IT said. Inbound is the principal.
        who = "YOU → principal" if direction == "outbound" else "principal → YOU"
        # Truncate per-line to keep the context block bounded.
        snippet = message if len(message) <= 280 else message[:277] + "…"
        lines.append(f"  [{ts}] {who} on {channel}: {snippet}")
    lines.append("[/ALFRED-CONTINUITY]")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Session -> chat resolution (Hermes 0.20)
# ---------------------------------------------------------------------------
#
# 0.20 changed session ids from `agent:main:<platform>:dm:<chat_id>` to
# `YYYYMMDD_HHMMSS_<hex>`. The two LLM hooks below used to derive the chat id
# by parsing the session id, so on 0.20 every real channel turn hit "no
# chat_id ... skip" and the journal's write side went silent for two weeks —
# fail-soft by design, INFO not surfaced, nobody noticed (2026-09-03).
#
# The chat id now lives on the gateway's session-store entry: `lookup_by_
# session_id()` returns a SessionEntry whose `origin.chat_id` is the chat, and
# whose `session_key` still carries the old `:dm:<chat_id>:` shape. The store
# is handed to pre_gateway_dispatch on every inbound; we keep the reference
# and resolve from it. Two fallbacks stay in place: the legacy key parse, and
# the last chat seen on that platform (one principal, one DM per platform).

_SESSION_STORE: Any = None
_LAST_CHAT_BY_PLATFORM: dict[str, str] = {}

# Platforms that are not a person talking to Alfred. Journaling them would
# record machinery as conversation.
_NON_CONVERSATION_PLATFORMS = {"", "cli", "subagent", "cron", "api_server", "unknown"}

# Liveness. The write path has now died silently twice (2026-05-25 a wrong
# kwarg name, 2026-08-19 a changed id format). A path that can fail without
# anyone noticing is worse than one that fails loudly, so: after this many
# journal-eligible turns with zero successful writes, log at ERROR.
_LIVENESS = {"eligible": 0, "written": 0, "alarmed": False}
_LIVENESS_THRESHOLD = 10


def _parse_chat_from_key(key: str) -> str:
    for marker in (":dm:", ":group:", ":channel:", ":thread:"):
        if marker in key:
            return key.split(marker, 1)[1].split(":")[0]
    return ""


def _resolve_chat_id(session_id: str, platform: str) -> str:
    store = _SESSION_STORE
    if store is not None:
        try:
            entry = store.lookup_by_session_id(session_id)
            if entry is not None:
                origin = getattr(entry, "origin", None)
                cid = getattr(origin, "chat_id", None) if origin is not None else None
                if cid:
                    return str(cid)
                cid = _parse_chat_from_key(str(getattr(entry, "session_key", "") or ""))
                if cid:
                    return cid
        except Exception as e:  # noqa: BLE001
            logger.warning("[one-alfred] session-store lookup failed for %s: %s", session_id, e)
    cid = _parse_chat_from_key(session_id)  # legacy id shape
    if cid:
        return cid
    return _LAST_CHAT_BY_PLATFORM.get(platform, "")


def _note_eligible_turn() -> None:
    _LIVENESS["eligible"] += 1
    if (
        not _LIVENESS["alarmed"]
        and _LIVENESS["written"] == 0
        and _LIVENESS["eligible"] >= _LIVENESS_THRESHOLD
    ):
        _LIVENESS["alarmed"] = True
        logger.error(
            "[one-alfred] LIVENESS: %d journal-eligible turns and ZERO journal writes "
            "— the continuity write path is dead. Check chat-id resolution and "
            "ctrl-api reachability.",
            _LIVENESS["eligible"],
        )


def _note_write(result: Optional[dict[str, Any]]) -> None:
    if result is None:
        return
    _LIVENESS["written"] += 1
    if _LIVENESS["alarmed"]:
        _LIVENESS["alarmed"] = False
        logger.info("[one-alfred] LIVENESS: journal writes resumed")


# ---------------------------------------------------------------------------
# Hook implementations
# ---------------------------------------------------------------------------

# Latch: dedupe rapid duplicate inbounds only. 2026-05-25 dropped the 10-min
# latch entirely after the Sir incident — Sir's "hm?" reply to a delegate
# reminder needed context EVERY turn until the journal got into main's
# session history (which on the cron/direct-delivery path never happens).
# The journal is small (<20 entries × ~50 tokens) so re-injecting every
# turn costs ~1k tokens of context — well within budget.
#
# The 5s dedupe window catches double-fires of the same hook only.
_LAST_INJECTION: dict[tuple[str, str], float] = {}
_LATCH_LOCK = threading.Lock()
_REINJECT_AFTER_S = 5


def _should_inject(channel: str, chat_id: str) -> bool:
    key = (channel, chat_id)
    now = time.time()
    with _LATCH_LOCK:
        last = _LAST_INJECTION.get(key, 0)
        if now - last < _REINJECT_AFTER_S:
            return False
        _LAST_INJECTION[key] = now
        return True


def _hook_pre_gateway_dispatch(
    event: Any,
    gateway: Any = None,
    session_store: Any = None,
    **_kwargs: Any,
) -> Optional[dict[str, Any]]:
    """Pre-dispatch hook — inject journal context into Sir's inbound text.

    Hermes signature: ``invoke_hook("pre_gateway_dispatch", event=event,
    gateway=self, session_store=self.session_store)``. We accept extras via
    ``**_kwargs`` to remain forward-compatible with new fields.
    """
    if not _is_enabled():
        return None
    try:
        source = getattr(event, "source", None)
        platform = getattr(getattr(source, "platform", None), "value", None) or getattr(
            source, "platform", None
        )
        chat_id = getattr(source, "chat_id", None)
        text = getattr(event, "text", None) or ""
        logger.info(
            "[one-alfred] pre_gateway_dispatch fired platform=%s chat=%s text_len=%d",
            platform, chat_id, len(text),
        )
        if not platform or not chat_id or not text:
            return None
        channel = str(platform).lower()
        chat_id_str = str(chat_id)
        global _SESSION_STORE
        store = session_store or getattr(gateway, "session_store", None)
        if store is not None:
            _SESSION_STORE = store
        _LAST_CHAT_BY_PLATFORM[channel] = chat_id_str
        if not _should_inject(channel, chat_id_str):
            logger.info("[one-alfred] pre_gateway_dispatch: latched (<5s) — skip")
            return None

        resp = _http_get_json(
            "/api/v1/alfred-journal/recent",
            {
                "channel": channel,
                "chat_id": chat_id_str,
                "limit": _recent_limit(),
                "within_hours": _recent_hours(),
            },
        )
        if not resp:
            return None
        entries = resp.get("entries") or []
        if not entries:
            return None

        context_block = _format_journal_context(entries)
        if not context_block:
            return None

        rewritten = f"{context_block}\n\n{text}"
        logger.info(
            "[one-alfred] injected %d journal entries into %s:%s inbound",
            len(entries), channel, chat_id_str,
        )
        return {"action": "rewrite", "text": rewritten}
    except Exception as e:  # noqa: BLE001
        # Never block Sir's reply — log and let Hermes proceed.
        logger.warning("[one-alfred] pre_gateway_dispatch failed: %s", e)
        return None


def _hook_post_llm_call(
    session_id: Optional[str] = None,
    assistant_response: Optional[str] = None,
    response_text: Optional[str] = None,  # legacy alias — kept for forward-compat
    platform: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """Post-LLM hook — journal what main composed back to Sir.

    Hermes' run_agent.py:15895 invocation passes the response under the
    kwarg name ``assistant_response`` (NOT ``response_text``) — verified
    against Hermes' live source. The earlier ``response_text`` keyword was
    a guess that silently no-op'd every call (2026-05-25 Sir incident:
    Alfred's reply to "hm?" never landed in the journal). Both names are
    now accepted for forward-compat; we prefer ``assistant_response``.

    This is the journal's outbound recorder for direct-reply turns (Sir
    messages, main answers). Delegate-triggered outbound deliveries via
    /api/v1/alfred-deliver journal themselves through ctrl-api; this
    hook only catches the in-session-reply case.
    """
    if not _is_enabled():
        return
    try:
        # Hermes uses ``assistant_response``; legacy callers may still pass
        # ``response_text``. Take whichever is non-empty.
        text = assistant_response or response_text
        if not text or not platform or not session_id:
            return
        channel = str(platform).lower()
        if channel in _NON_CONVERSATION_PLATFORMS:
            return  # machinery, not a person talking to Alfred

        sid = str(session_id)
        chat_id = _resolve_chat_id(sid, channel)
        if not chat_id:
            logger.warning("[one-alfred] post_llm_call: could not resolve chat for session=%s platform=%s", sid, channel)
            return

        _note_write(_http_post_json(
            "/api/v1/alfred-journal",
            {
                "channel": channel,
                "chat_id": chat_id,
                "direction": "outbound",
                "message": text,
                "source_kind": "reply",
                "hermes_session_id": sid,
                "hermes_profile": "main",
                "status": "delivered",
                "metadata": {
                    "model": kwargs.get("model"),
                },
            },
        ))
    except Exception as e:  # noqa: BLE001
        logger.warning("[one-alfred] post_llm_call journal failed: %s", e)


def _hook_pre_llm_call_inbound_journal(
    session_id: Optional[str] = None,
    user_message: Optional[str] = None,
    platform: Optional[str] = None,
    **_kwargs: Any,
) -> None:
    """Record Sir's actual inbound message in the journal (audit trail).

    Hermes' pre_llm_call invocation passes
    ``{session_id, user_message, conversation_history, is_first_turn, model,
       platform}`` per _DEFAULT_PAYLOADS in hermes_cli/hooks.py — we use the
    first three.

    Strips the [ALFRED-CONTINUITY ...] context block (which
    pre_gateway_dispatch may have prepended) so the journal records only
    Sir's original text, not the rewrite.

    Best-effort: any failure here is logged but never blocks. Logs a single
    INFO line per fire so the hook's liveness is visible in `docker logs
    hermes`.
    """
    if not _is_enabled():
        return
    logger.info(
        "[one-alfred] pre_llm_call fired session=%s platform=%s msg_len=%d",
        session_id, platform, len(user_message or ""),
    )
    try:
        if not user_message or not platform or not session_id:
            return
        channel = str(platform).lower()
        if channel in _NON_CONVERSATION_PLATFORMS:
            return
        sid = str(session_id)
        _note_eligible_turn()
        chat_id = _resolve_chat_id(sid, channel)
        if not chat_id:
            logger.warning("[one-alfred] pre_llm_call: could not resolve chat for session=%s platform=%s", sid, channel)
            return

        # If the user_message we see already CONTAINS our context-block
        # marker, strip it — we rewrote it in pre_gateway_dispatch but want
        # the journal to record only Sir's actual text. Tolerate BOTH the
        # current marker shape (2026-05-25 redesign) and the original.
        clean = user_message
        for start_tag, end_tag in (
            ("[ALFRED-CONTINUITY", "[/ALFRED-CONTINUITY]"),
            ("[system: one-alfred continuity context", "[/system]"),
        ):
            if start_tag in clean:
                idx = clean.find(end_tag)
                if idx >= 0:
                    clean = clean[idx + len(end_tag):].lstrip()
                    break

        _note_write(_http_post_json(
            "/api/v1/alfred-journal",
            {
                "channel": channel,
                "chat_id": chat_id,
                "direction": "inbound",
                "message": clean,
                "source_kind": "reply",
                "hermes_session_id": sid,
                "hermes_profile": "main",
                "status": "received",
            },
        ))
    except Exception as e:  # noqa: BLE001
        logger.warning("[one-alfred] pre_llm_call journal failed: %s", e)


# ---------------------------------------------------------------------------
# Plugin entry point
# ---------------------------------------------------------------------------

def register(ctx: Any) -> None:
    """Hermes plugin registration entry point.

    Called once per profile at startup. Wires the three hooks above into
    the gateway's invoke_hook fan-out.
    """
    ctx.register_hook("pre_gateway_dispatch", _hook_pre_gateway_dispatch)
    ctx.register_hook("pre_llm_call", _hook_pre_llm_call_inbound_journal)
    ctx.register_hook("post_llm_call", _hook_post_llm_call)
    logger.info(
        "[one-alfred] registered hooks: pre_gateway_dispatch, "
        "pre_llm_call (inbound-journal), post_llm_call (outbound-journal)"
    )
