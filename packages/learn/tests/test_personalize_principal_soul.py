"""Tests for the C-OB2 principal-facing ``vault/SOUL.md`` write
extension to ``personalize_opus`` (Commit 2, Phase 3 / Lane II).

The existing ``personalize_opus`` writes a SOUL.md to the *workspace*
endpoint (``PUT /api/v1/admin/workspace/SOUL.md``) — ctrl-api routes
that to the Hermes main profile dir; it is *Alfred's runtime persona*,
what the agent reads to decide how to behave.

C-OB2 requires a SECOND, principal-facing SOUL.md at ``vault/SOUL.md``
— the *principal's* persona, distinct from Alfred's runtime soul:
frontmatter ``subtype: principal_soul`` plus three sections (Values,
Tone preferences, What I care about), each a short paragraph.
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
            {"category": "personal", "fact": "Founder, family-first",
             "confidence": "high"},
        ],
        "patterns": [
            {"name": "Concise communicator",
             "description": "Replies in 1-2 sentences"},
        ],
    }))
    return str(path)


_GOOD_RESPONSE = json.dumps({
    "user_md": "# User Profile\n\nSir is the founder.",
    "soul_md": "# Alfred's Soul\n\nAddress him as Sir.",
    "memory_md": "# Memory Index\n\n[[Eszter]] — wife.",
    "tools_md": "# Suggested Tools\n\nMorning brief.",
    "rules_md": "# Standing Rules\n\n- Quiet hours.",
    "rules": {
        "personal_sovereignty": ["Founder authority on company direction"],
        "household": [
            "Eszter owns family decisions",
            "Viki owns admin",
        ],
        "communication": ["Concise"],
        "decision": [],
    },
    "soul": {
        "values": (
            "Family, sovereignty, focused work. Sir values "
            "time with his infant and partner above status work; "
            "values clean, considered decisions over volume; values "
            "deep technical mastery alongside political conviction."
        ),
        "tone_preferences": (
            "Sir prefers concise, direct prose with a hint of dry "
            "wit. Address him as Sir. Avoid corporate management "
            "language; speak as a thoughtful older butler who has "
            "served the household for years."
        ),
        "what_i_care_about": (
            "Family stability, the founder transition into the Kft, "
            "real estate over SaaS, and the screen-free childhood "
            "experiment. Surface what threatens these; filter what "
            "doesn't."
        ),
    },
})


def _resp(status: int, body=None):
    class R:
        status_code = status
        text = ""
        is_success = 200 <= status < 300

        def json(self) -> dict:
            return body or {"path": "SOUL.md"}

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


def _find_vault_soul_post(captured):
    for call in captured:
        if call["method"] == "POST" and "/api/v1/vault/records" in call["url"]:
            body = call.get("json") or {}
            if str(body.get("name") or "") in ("SOUL.md", "SOUL"):
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


class TestPersonalizePrincipalSoulMd:
    """C-OB2: ``personalize_opus`` writes ``vault/SOUL.md`` — the
    PRINCIPAL'S soul (distinct from Alfred's runtime soul which lives
    in the Hermes profile dir). Frontmatter ``subtype: principal_soul``;
    sections Values / Tone preferences / What I care about, each
    populated."""

    def test_vault_soul_md_is_written(self, tmp_path, monkeypatch):
        captured = _run(_GOOD_RESPONSE, tmp_path, monkeypatch)
        body = _find_vault_soul_post(captured)
        assert body is not None, (
            f"no POST /api/v1/vault/records writing SOUL.md; saw: "
            f"{[c['url'] for c in captured]}"
        )
        assert body.get("type") == "note", body

    def test_vault_soul_md_subtype_principal_soul(self, tmp_path, monkeypatch):
        """Frontmatter distinguishes the PRINCIPAL'S soul from the
        runtime SOUL.md (which has no subtype and lives elsewhere).
        ``subtype: principal_soul`` is the load-bearing marker.
        """
        captured = _run(_GOOD_RESPONSE, tmp_path, monkeypatch)
        body = _find_vault_soul_post(captured)
        assert body is not None
        content = body["content"]
        m = re.match(r"^---\n(.*?)\n---\n(.*)", content, re.DOTALL)
        assert m, f"no YAML frontmatter: {content[:200]!r}"
        fm = m.group(1)
        for required in (
            "type: note",
            "subtype: principal_soul",
            "status: active",
            "created_by: onboarding_pipeline",
        ):
            assert required in fm, f"missing {required!r}: {fm}"
        assert re.search(r"^created:\s*\d{4}-\d{2}-\d{2}", fm, re.MULTILINE), fm

    def test_vault_soul_md_all_three_sections_present(
        self, tmp_path, monkeypatch,
    ):
        """C-OB2: SOUL.md MUST carry all three sections — Values, Tone
        preferences, What I care about — each populated with a short
        paragraph from the Opus ``soul`` dict."""
        captured = _run(_GOOD_RESPONSE, tmp_path, monkeypatch)
        body = _find_vault_soul_post(captured)
        assert body is not None
        content = body["content"]
        # Section headings present in the rendered markdown.
        assert "## Values" in content, content
        assert "## Tone preferences" in content, content
        assert "## What I care about" in content, content

        # Each section non-empty — at least 20 chars of body under each.
        def _section_body(label: str) -> str:
            m = re.search(
                rf"## {re.escape(label)}\n+(.+?)(?=\n##\s|\Z)",
                content, re.DOTALL,
            )
            return (m.group(1).strip() if m else "")

        for label in ("Values", "Tone preferences", "What I care about"):
            section = _section_body(label)
            assert len(section) >= 20, (
                f"section ``## {label}`` looks empty in vault/SOUL.md: "
                f"{section!r}"
            )

    def test_principal_soul_distinguished_from_runtime_soul(
        self, tmp_path, monkeypatch,
    ):
        """The runtime SOUL.md (the workspace PUT) and the principal
        SOUL.md (this new vault POST) must BOTH be written, with
        different content surfaces: only the principal one carries
        ``subtype: principal_soul``.
        """
        captured = _run(_GOOD_RESPONSE, tmp_path, monkeypatch)

        runtime_soul_put = None
        for call in captured:
            if call["method"] == "PUT" and call["url"].endswith("/SOUL.md"):
                runtime_soul_put = call
                break
        assert runtime_soul_put is not None, "runtime SOUL.md workspace PUT missing"
        runtime_content = (runtime_soul_put.get("json") or {}).get("content", "")
        # Runtime soul is the existing Opus ``soul_md`` string — no
        # frontmatter, no subtype marker.
        assert "subtype: principal_soul" not in runtime_content

        principal_body = _find_vault_soul_post(captured)
        assert principal_body is not None
        assert "subtype: principal_soul" in principal_body["content"]
