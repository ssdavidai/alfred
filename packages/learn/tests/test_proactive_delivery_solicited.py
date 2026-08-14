"""solicited=0 stamping on Alfred's proactive delivery paths (#580).

Five learn-owned senders must stamp solicited=0; the ambiguous observe path
must leave the key absent so the journal row stays NULL.
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from temporalio.testing import ActivityEnvironment

from src.activities.notify import escalate_to_user, notify_digest_ready
from src.activities.observe import execute_alfred_instructions


def _run(fn: Any, *args: Any) -> Any:
    return asyncio.run(ActivityEnvironment().run(fn, *args))


def _vc() -> tuple[Any, MagicMock]:
    vc = MagicMock()
    vc.notify = AsyncMock(return_value=None)
    vc.close = AsyncMock(return_value=None)
    return (lambda _cfg: vc), vc


def test_notify_digest_ready_stamps_solicited_zero() -> None:
    factory, vc = _vc()
    with patch("src.activities.notify.VaultClient", factory):
        _run(notify_digest_ready, "digest.md", "ready")
    _, kw = vc.notify.call_args
    assert kw.get("solicited") == 0


def test_escalate_to_user_stamps_solicited_zero() -> None:
    factory, vc = _vc()
    with patch("src.activities.notify.VaultClient", factory):
        _run(escalate_to_user, {"title": "x"}, None)
    _, kw = vc.notify.call_args
    assert kw.get("solicited") == 0


def test_no_proactive_sender_stamps_solicited_one() -> None:
    """learn never stamps 1 — only principal-reply paths may use that value."""
    factory, vc = _vc()
    with patch("src.activities.notify.VaultClient", factory):
        _run(notify_digest_ready, "d.md", "s")
    _, kw = vc.notify.call_args
    assert kw.get("solicited") != 1


# VaultClient.notify() — key absent when solicited not passed
def test_vault_client_notify_omits_solicited_key_when_not_passed() -> None:
    """Omitting solicited must leave the key absent (not None) so the DB stays NULL."""
    from src.utils.vault_client import VaultClient
    resp = MagicMock()
    resp.status_code = 200
    resp.raise_for_status.return_value = None
    inner = AsyncMock()
    inner.post = AsyncMock(return_value=resp)
    vc = object.__new__(VaultClient)
    vc._client = inner  # type: ignore[attr-defined]
    asyncio.run(vc.notify("p", "s"))
    body = inner.post.call_args.kwargs.get("json", {})
    assert "solicited" not in body


def test_vault_client_notify_routes_to_alfred_deliver() -> None:
    """/notifications does not forward solicited; must bypass it (#580)."""
    from src.utils.vault_client import VaultClient
    resp = MagicMock()
    resp.status_code = 200
    resp.raise_for_status.return_value = None
    inner = AsyncMock()
    inner.post = AsyncMock(return_value=resp)
    vc = object.__new__(VaultClient)
    vc._client = inner  # type: ignore[attr-defined]
    asyncio.run(vc.notify("p", "s", solicited=0))
    url = inner.post.call_args.args[0] if inner.post.call_args.args else ""
    assert "alfred-deliver" in url
    assert "notifications" not in url


def test_observe_execute_instructions_notify_solicited_absent() -> None:
    """Vault-instruction notify is direction-unknown; solicited must be absent."""
    vc = MagicMock()
    vc.read_record = AsyncMock(return_value={"content": "", "frontmatter": {}, "body": ""})
    vc.notify = AsyncMock(return_value=None)
    vc.update_record = AsyncMock(return_value=None)
    vc.close = AsyncMock(return_value=None)
    clerk_plan = {
        "understood": True,
        "actions": [{"type": "notify", "target": "p.md", "details": "msg"}],
    }
    with patch("src.activities.observe.VaultClient", lambda _cfg: vc):
        with patch(
            "src.activities.clerk.clerk_execute_instructions",
            AsyncMock(return_value=clerk_plan),
        ):
            _run(execute_alfred_instructions, {"path": "p.md", "target": "p.md", "details": "msg"})
    _, kw = vc.notify.call_args
    assert "solicited" not in kw
