"""Send the First Brief via email at the end of onboarding.

The brief was written to the vault by the earlier onboarding stage.
This activity reads it back, rounds up the tenant owner's email from
the OWNER_EMAIL env var, and POSTs to ctrl-api /api/v1/email/send so
AgentMail delivers it to Sir's Gmail.

Non-blocking by design: if AgentMail is not configured (older tenants,
feature flag off, missing env), the activity logs and returns
{sent: False, reason: ...} without raising. The onboarding workflow
should treat this as a best-effort last step.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from temporalio import activity

logger = logging.getLogger("first-brief-email")


def _resolve_ctrl_api_base() -> str:
    return os.environ.get("ALFRED_CTRL_URL", "http://ctrl-api:3100").rstrip("/")


def _resolve_ctrl_api_token() -> str:
    return os.environ.get("AAS_API_KEY", "")


def _resolve_owner_email() -> str:
    """Owner email priority: env → onboard.json user_id (not reliable) → fail."""
    return (os.environ.get("OWNER_EMAIL") or "").strip()


def _resolve_brief_markdown(brief_path: str | None) -> str | None:
    """Read the brief markdown from the vault.

    brief_path is vault-relative (e.g. 'reflection/first-brief-...md').
    We resolve against VAULT_PATH (/vault inside the container).
    """
    if not brief_path:
        return None
    vault_root = Path(os.environ.get("VAULT_PATH", "/vault"))
    candidate = vault_root / brief_path.lstrip("/")
    if not candidate.is_file():
        return None
    try:
        return candidate.read_text(encoding="utf-8")
    except OSError:
        return None


@activity.defn
async def send_first_brief_email(brief_path: str | None) -> dict[str, Any]:
    """Deliver the First Brief to Sir's Gmail via the tenant's AgentMail inbox.

    Called as the terminal step of OnboardingPipelineWorkflow (after 'done'
    stage is committed and background processing has kicked off). Failures
    here should not mark onboarding as failed — Sir can still read the brief
    on the dashboard.

    Args:
        brief_path: vault-relative path to the brief record. Usually passed
            from the preceding stage via workflow state.

    Returns:
        {sent: bool, reason: str, status_code?: int}
    """
    import httpx

    owner_email = _resolve_owner_email()
    if not owner_email:
        logger.info("[first-brief-email] OWNER_EMAIL not set, skipping")
        return {"sent": False, "reason": "no OWNER_EMAIL configured"}

    brief_md = _resolve_brief_markdown(brief_path)
    if not brief_md:
        logger.warning(
            "[first-brief-email] brief markdown not readable at %s, skipping",
            brief_path,
        )
        return {"sent": False, "reason": f"brief not found at {brief_path}"}

    token = _resolve_ctrl_api_token()
    if not token:
        return {"sent": False, "reason": "no AAS_API_KEY configured"}

    # Strip YAML frontmatter if present so the email body is clean markdown
    body_text = brief_md
    if body_text.startswith("---\n"):
        parts = body_text.split("---\n", 2)
        if len(parts) == 3:
            body_text = parts[2].lstrip("\n")

    payload = {
        "to": [owner_email],
        "subject": "Your First Brief, Sir",
        "text": body_text,
        "labels": ["first-brief", "onboarding"],
    }

    url = f"{_resolve_ctrl_api_base()}/api/v1/email/send"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                url,
                json=payload,
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError as err:
        logger.warning("[first-brief-email] transport error: %s", err)
        return {"sent": False, "reason": f"transport: {err}"}

    if resp.status_code == 400 and "AGENTMAIL_API_KEY" in resp.text:
        # ctrl-api signals AgentMail not configured on this tenant —
        # acceptable: older tenants or flag off.
        logger.info("[first-brief-email] AgentMail not configured on tenant, skipping")
        return {
            "sent": False,
            "reason": "AgentMail not configured on tenant",
            "status_code": resp.status_code,
        }

    if resp.status_code < 200 or resp.status_code >= 300:
        logger.warning(
            "[first-brief-email] ctrl-api /email/send failed (status=%d): %s",
            resp.status_code,
            resp.text[:500],
        )
        return {
            "sent": False,
            "reason": f"ctrl-api returned {resp.status_code}",
            "status_code": resp.status_code,
        }

    logger.info("[first-brief-email] sent to %s (%d bytes)", owner_email, len(body_text))
    return {"sent": True, "reason": "ok", "status_code": resp.status_code}
