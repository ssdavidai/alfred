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

    Lays them out newest-last so main reads them in conversational order
    (sender → reply → reminder). Marks outbound entries explicitly as "you"
    (the agent) and inbound as "Sir" — this matters because the journal
    sometimes records the bytes Sir saw before his actual session turn
    landed, so the timing in the chat history can look off; the labels
    anchor it.
    """
    if not entries:
        return ""
    # entries come back newest-first from ctrl-api; flip for narrative order.
    in_order = list(reversed(entries))
    lines: list[str] = []
    lines.append(
        "[system: one-alfred continuity context — recent exchanges with"
        " the principal across channels. The principal does NOT see this"
        " block. Use it to maintain the illusion of one continuous"
        " conversation across the workers/main/heavy session split.]"
    )
    for e in in_order:
        ts = str(e.get("ts", ""))[:19]
        direction = str(e.get("direction", "?"))
        channel = str(e.get("channel", "?"))
        message = str(e.get("message", "")).strip()
        if not message:
            continue
        # Compact label: time + who + channel. Single line per exchange.
        who = "you (Alfred)" if direction == "outbound" else "principal"
        # Truncate per-line to keep the context block bounded.
        snippet = message if len(message) <= 280 else message[:277] + "…"
        lines.append(f"  · {ts} {who} on {channel}: {snippet}")
    lines.append("[/system]")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Hook implementations
# ---------------------------------------------------------------------------

# Per-(channel, chat_id) latch: we only inject context on the FIRST inbound
# of a session (or after a long idle gap). Re-injecting on every turn would
# make main's prompt grow each turn — that's what Hermes' session history
# already does for free. The journal context is a "wake-up nudge" for the
# moment when main loses thread.
#
# Key: (channel, chat_id). Value: timestamp of last injection. Idle threshold
# is hardcoded (10 min) — short enough that a returning Sir gets nudged again,
# long enough that we don't spam main every turn of a multi-turn back-and-forth.
_LAST_INJECTION: dict[tuple[str, str], float] = {}
_LATCH_LOCK = threading.Lock()
_REINJECT_AFTER_S = 10 * 60


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
        if not platform or not chat_id or not text:
            return None
        channel = str(platform).lower()
        chat_id_str = str(chat_id)
        if not _should_inject(channel, chat_id_str):
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
    response_text: Optional[str] = None,
    platform: Optional[str] = None,
    **kwargs: Any,
) -> None:
    """Post-LLM hook — journal what main composed back to Sir.

    This is the journal's outbound recorder for direct-reply turns (Sir
    messages, main answers). For delegate-triggered outbound deliveries
    via /api/v1/alfred-deliver, the journal is already populated by
    ctrl-api — this hook only catches the in-session-reply case.

    Hermes signature varies by version; we accept everything via kwargs.
    """
    if not _is_enabled():
        return
    try:
        if not response_text or not platform or not session_id:
            return
        channel = str(platform).lower()
        if channel == "cli":
            return  # CLI sessions are dev-only — no Sir-facing exchange to record

        # Derive chat_id from the session_id (session keys for channel
        # sessions are `agent:main:{platform}:dm:{chat_id}` or similar).
        chat_id: str = ""
        sid = str(session_id)
        for marker in (":dm:", ":group:"):
            if marker in sid:
                chat_id = sid.split(marker, 1)[1].split(":")[0]
                break
        if not chat_id:
            return  # not a channel session we recognise — skip

        _http_post_json(
            "/api/v1/alfred-journal",
            {
                "channel": channel,
                "chat_id": chat_id,
                "direction": "outbound",
                "message": response_text,
                "source_kind": "reply",
                "hermes_session_id": sid,
                "hermes_profile": "main",
                "status": "delivered",
                "metadata": {
                    # Anything else the hook saw — useful for future debugging.
                    "tool_calls": kwargs.get("tool_calls"),
                },
            },
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("[one-alfred] post_llm_call journal failed: %s", e)


def _hook_pre_llm_call_inbound_journal(
    session_id: Optional[str] = None,
    user_message: Optional[str] = None,
    platform: Optional[str] = None,
    **_kwargs: Any,
) -> None:
    """Record Sir's actual inbound message in the journal (audit trail).

    This is separate from the pre_gateway_dispatch rewrite — that hook
    INJECTS context but doesn't journal. Pre-LLM is the moment when we
    know main has accepted the (possibly-rewritten) text and is about to
    process it; we want to journal Sir's ORIGINAL text, not the rewritten
    one. The dispatch hook stashed the original in ``event.text``; we
    re-read from ``user_message`` here which is the same canonical text
    before our rewrite (the gateway passes both).

    Best-effort: any failure here is logged but never blocks.
    """
    if not _is_enabled():
        return
    try:
        if not user_message or not platform or not session_id:
            return
        channel = str(platform).lower()
        if channel == "cli":
            return
        sid = str(session_id)
        chat_id: str = ""
        for marker in (":dm:", ":group:"):
            if marker in sid:
                chat_id = sid.split(marker, 1)[1].split(":")[0]
                break
        if not chat_id:
            return

        # If the user_message we see already CONTAINS our context-block
        # marker, strip it — we rewrote it in pre_gateway_dispatch but want
        # the journal to record only Sir's actual text.
        clean = user_message
        marker = "[system: one-alfred continuity context"
        if marker in clean:
            # Split on the closing tag we know we wrote.
            end_tag = "[/system]"
            idx = clean.find(end_tag)
            if idx >= 0:
                clean = clean[idx + len(end_tag):].lstrip()

        _http_post_json(
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
        )
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
