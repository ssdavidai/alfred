"""Tests for the C-OB2 principal-facing ``vault/RULES.md`` write
extension to ``personalize_opus`` (Commit 1, Phase 3 / Lane II).

The existing ``personalize_opus`` writes a RULES.md to the *workspace*
endpoint (``PUT /api/v1/admin/workspace/RULES.md``) — ctrl-api routes
that to the Hermes main profile dir's AGENTS.md sentinel block, the
runtime surface the agent reads at decision time. C-OB2 requires a
SECOND, principal-facing RULES.md at ``vault/RULES.md`` —
``subtype: standing_rules``, sections by category, >= 3 bullets total.
"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from unittest.mock import AsyncMock, patch

from temporalio import activity
from temporalio.testing import ActivityEnvironment

from src.activities.onboarding_v3 import personalize_opus

# Service-summary-note regex from the golden suite — C-OB1 regression guard.
_SERVICE_NOTE_RE = re.compile(
    r"^[A-Za-z0-9.\- ]+? (Service Emails( Summary)?|Email Digest"
    r"|Activity Summary|Notifications? Summary|Service & Notification Summary"
    r"|Service Relationship Overview|Emails and Updates"
    r"|Security Alerts|Billing Issue Notifications)\b",
    re.IGNORECASE,
)


def _run_activity(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_test_wrapper")
    async def _wrapper() -> dict:
        return await coro_factory()

    return asyncio.run(env.run(_wrapper))


def _write_onboard(tmp_path: Path) -> str:
    path = tmp_path / "onboard.json"
    path.write_text(json.dumps({
        "facts": [
            {"category": "personal", "fact": "Founder of Szabostuban Kft",
             "confidence": "high"},
            {"category": "personal",
             "fact": "Eszter is on GYED, infant in the house",
             "confidence": "high"},
            {"category": "personal", "fact": "Viki manages admin",
             "confidence": "high"},
        ],
        "patterns": [
            {"name": "Quiet mornings", "description": "No email before 7 AM"},
        ],
    }))
    return str(path)


_GOOD_RESPONSE = json.dumps({
    "user_md": "# User Profile\n\nSir is the founder.",
    "soul_md": "# Alfred's Soul\n\nAddress him as Sir.",
    "memory_md": "# Memory Index\n\n[[Eszter]] — wife.",
    "tools_md": "# Suggested Tools\n\nMorning brief at 7 AM.",
    "rules_md": "# Standing Rules\n\n- Protect quiet hours.",
    "rules": {
        "personal_sovereignty": [
            "I am the founder; I make the call on company direction",
        ],
        "household": [
            "Eszter owns family and strategic decisions",
            "Viki owns operational admin",
            "5 AM quiet window — no notifications before 7 AM",
        ],
        "communication": [
            "Concise and direct",
            "Surface only what needs Sir's attention",
        ],
        "decision": ["Default to deferred unless time-critical"],
    },
})


def _resp(status: int, body=None):
    class R:
        status_code = status
        text = ""
        is_success = 200 <= status < 300

        def json(self) -> dict:
            return body or {"path": "RULES.md"}

        def raise_for_status(self) -> None:
            if self.status_code >= 400:
                raise AssertionError(f"HTTP {self.status_code}")

    return R()


def _mock_client(captured: list[dict]):
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None

    async def _put(url, *args, **kwargs):
        captured.append({"method": "PUT", "url": url, "json": kwargs.get("json")})
        return _resp(200)

    async def _post(url, *args, **kwargs):
        captured.append({"method": "POST", "url": url, "json": kwargs.get("json")})
        return _resp(201)

    client.put = AsyncMock(side_effect=_put)
    client.post = AsyncMock(side_effect=_post)
    return client


def _find_vault_rules_post(captured):
    for call in captured:
        if call["method"] == "POST" and "/api/v1/vault/records" in call["url"]:
            body = call.get("json") or {}
            if str(body.get("name") or "") in ("RULES.md", "RULES"):
                return body
    return None


def _run(response_json, tmp_path, monkeypatch):
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    onboard = _write_onboard(tmp_path)
    captured: list[dict] = []
    client = _mock_client(captured)
    with patch("src.activities.onboarding_v3._call_llm",
               new=AsyncMock(return_value=response_json)), \
         patch("httpx.AsyncClient", return_value=client):
        _run_activity(lambda: personalize_opus(onboard))
    return captured


class TestPersonalizePrincipalRulesMd:
    """C-OB2: ``personalize_opus`` writes ``vault/RULES.md`` via the
    vault records POST, with the contract frontmatter, sections, and
    >= 3 bullets total."""

    def test_vault_rules_md_is_written(self, tmp_path, monkeypatch):
        captured = _run(_GOOD_RESPONSE, tmp_path, monkeypatch)
        body = _find_vault_rules_post(captured)
        assert body is not None, (
            f"no POST /api/v1/vault/records writing RULES.md; saw: "
            f"{[c['url'] for c in captured]}"
        )
        assert body.get("type") == "note", body

    def test_vault_rules_md_has_correct_frontmatter(self, tmp_path, monkeypatch):
        captured = _run(_GOOD_RESPONSE, tmp_path, monkeypatch)
        body = _find_vault_rules_post(captured)
        assert body is not None
        content = body.get("content", "")
        m = re.match(r"^---\n(.*?)\n---\n(.*)", content, re.DOTALL)
        assert m, f"no YAML frontmatter: {content[:200]!r}"
        fm = m.group(1)
        for required in (
            "type: note",
            "subtype: standing_rules",
            "status: active",
            "created_by: onboarding_pipeline",
        ):
            assert required in fm, f"missing {required!r} in frontmatter: {fm}"
        assert re.search(r"^created:\s*\d{4}-\d{2}-\d{2}", fm, re.MULTILINE), fm

    def test_vault_rules_md_has_at_least_three_rules(self, tmp_path, monkeypatch):
        captured = _run(_GOOD_RESPONSE, tmp_path, monkeypatch)
        body = _find_vault_rules_post(captured)
        assert body is not None
        bullets = [
            ln for ln in body["content"].splitlines()
            if ln.startswith("- ") and len(ln) > 3
        ]
        assert len(bullets) >= 3, f"only {len(bullets)} rule bullets: {bullets}"

    def test_vault_rules_md_sections_omit_empty(self, tmp_path, monkeypatch):
        """Empty section keys produce no heading; only the household
        section has rules → only ``## Household rules`` is emitted."""
        single = json.dumps({
            "user_md": "# User Profile\n\nSir.",
            "soul_md": "# Alfred's Soul\n\nSir.",
            "memory_md": "# Memory Index\n\n.",
            "tools_md": "# Suggested Tools\n\n.",
            "rules_md": "# Standing Rules\n\n- Quiet hours.",
            "rules": {
                "personal_sovereignty": [],
                "household": [
                    "Eszter owns family decisions",
                    "Viki owns admin",
                    "Infant in house — protect early evening",
                ],
                "communication": [],
                "decision": [],
            },
        })
        captured = _run(single, tmp_path, monkeypatch)
        body = _find_vault_rules_post(captured)
        assert body is not None
        content = body["content"]
        assert "## Household rules" in content
        assert "## Personal sovereignty rules" not in content
        assert "## Communication rules" not in content
        assert "## Decision rules" not in content
        bullets = [ln for ln in content.splitlines() if ln.startswith("- ")]
        assert len(bullets) >= 3

    def test_vault_rules_md_name_does_not_match_service_summary(self):
        """C-OB1 cross-check: RULES isn't a curator service-summary."""
        assert _SERVICE_NOTE_RE.match("RULES") is None
        assert _SERVICE_NOTE_RE.match("RULES.md") is None
