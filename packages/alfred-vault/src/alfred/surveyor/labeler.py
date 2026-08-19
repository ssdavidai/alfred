"""Stage 4: Hermes gateway LLM labeling — cluster tags + relationship suggestions."""

from __future__ import annotations

import asyncio
import json
from pathlib import PurePosixPath
from typing import Any

import httpx
import structlog

from .config import LabelerConfig, LabelerGatewayConfig
from .parser import VaultRecord

log = structlog.get_logger()

# Hermes session-key scope for the surveyor's cluster-labeling calls. Frozen
# contract: the surveyor agent_id is "surveyor-label" and rides the WORKERS
# profile (cheap). See FAILURE-MODES / Hermes profiles.
SURVEYOR_SESSION_KEY = "surveyor-label"
# Completion budget for one Hermes /v1/responses call. The handler blocks
# until the agent run finishes, so the HTTP read timeout IS the budget.
HERMES_TIMEOUT_SECONDS = 300.0


def _extract_balanced_json(text: str) -> Any:
    """Parse the first balanced JSON value out of possibly-prose model text.

    The surveyor relies on prompt-instructed JSON (there is no
    response_format / json_schema), so the model's text can arrive bare, or
    wrapped in ```json fences, or with leading/trailing prose — especially
    when it comes back from Hermes-as-agent rather than a bare completion.
    We try, in order:
      1. a direct ``json.loads`` of the stripped text;
      2. the contents of a ```json``` (or bare ```) code fence;
      3. the first balanced ``[...]`` or ``{...}`` span, scanned with
         string/escape awareness so braces inside strings don't fool it.
    Raises ``json.JSONDecodeError`` if nothing parses, so callers keep their
    existing try/except parse-error logging unchanged.
    """
    if not isinstance(text, str):
        raise json.JSONDecodeError("non-string response", str(text), 0)
    stripped = text.strip()
    if not stripped:
        raise json.JSONDecodeError("empty response", stripped, 0)

    # 1. Direct parse — the happy path for well-behaved bare-JSON output.
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass

    # 2. Code-fence: ```json ... ``` or ``` ... ```.
    if "```" in stripped:
        import re

        match = re.search(r"```(?:json)?\s*\n?([\s\S]*?)\n?```", stripped)
        if match:
            try:
                return json.loads(match.group(1).strip())
            except json.JSONDecodeError:
                pass

    # 3. First balanced JSON value (array or object), string-aware.
    span = _first_balanced_span(stripped)
    if span is not None:
        return json.loads(span)

    # Nothing salvageable — surface a parse error the caller already handles.
    raise json.JSONDecodeError("no JSON value found", stripped, 0)


def _first_balanced_span(text: str) -> str | None:
    """Return the substring of the first balanced ``[...]``/``{...}`` value.

    Walks from the first opening bracket/brace, tracking string literals and
    escapes so that brackets appearing inside string values don't unbalance
    the count. Returns ``None`` if no opener is found or it never balances.
    """
    opener_idx = -1
    opener = ""
    for i, ch in enumerate(text):
        if ch in "[{":
            opener_idx = i
            opener = ch
            break
    if opener_idx == -1:
        return None
    closer = "]" if opener == "[" else "}"

    depth = 0
    in_string = False
    escaped = False
    for i in range(opener_idx, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return text[opener_idx : i + 1]
    return None

# Record types that are first-class entities in the vault taxonomy. When a
# cluster contains one of these, its filename stem becomes a canonical
# cluster tag so every member inherits the entity slug and downstream
# consumers can match on `alfred_tags: [<entity-slug>]`.
# bug #13 got this backwards, and the correction is the point of this comment.
# It observed "matter" here, saw that schema.KNOWN_TYPES had no "matter", and
# removed "matter" — keeping "project". The premise was the stale half: this
# daemon's KNOWN_TYPES predated the four-store cutover, and `matter` is the
# canonical type while `project` is the name it replaced. ctrl-api rejects
# `project` with 422, so the cluster path was writing `related_project` links
# at a type the rest of the system refuses. Reversed here.
ENTITY_RECORD_TYPES = frozenset({"person", "org", "matter"})


def _slug_from_rel_path(rel_path: str) -> str:
    """Derive the slug from a vault rel_path — filename stem, no extension.

    `matter/alfred-product-development-launch.md` → `alfred-product-development-launch`
    """
    name = PurePosixPath(rel_path).name
    if name.lower().endswith(".md"):
        name = name[:-3]
    return name

CLUSTER_LABEL_PROMPT = """\
You are labeling a cluster of related documents from an Obsidian vault.

Each document has a type, name, and body preview. Based on the thematic content, assign 1-3 descriptive tags that capture what this cluster is about.

Tags should be:
- Hierarchical where appropriate (e.g. "construction/residential", "finance/invoicing")
- Lowercase, using / for hierarchy
- Descriptive of the shared theme, not the document types

Documents in this cluster:
{members}

Respond with ONLY a JSON array of tag strings. Example: ["construction/residential", "project-management"]
"""

RELATIONSHIP_PROMPT = """\
You are analyzing documents from an Obsidian vault that were found to be semantically related (in the same cluster) but don't currently link to each other.

For each pair, suggest whether a relationship exists and what type it is.

Possible relationship types: "related-to", "supports", "depends-on", "part-of", "supersedes", "contradicts"

Documents:
{pairs}

Respond with ONLY a JSON array of objects, each with:
- "source": source file path
- "target": target file path
- "type": relationship type
- "context": brief explanation (max 50 chars)
- "confidence": float 0-1

Only include pairs where confidence >= 0.5. If no relationships are found, return [].
"""

# Rate limiting
API_CALL_DELAY = 1.0
MAX_RETRIES = 3
RETRY_BASE_DELAY = 2.0


class Labeler:
    def __init__(self, gateway_cfg: LabelerGatewayConfig, labeler_cfg: LabelerConfig) -> None:
        # All LLM calls route through the Hermes WORKERS gateway.
        # An empty hermes_gateway_url is a misconfiguration — the labeler
        # will raise RuntimeError at the first call rather than falling back
        # to any third-party provider.
        self.hermes_gateway_url = gateway_cfg.hermes_gateway_url.rstrip("/")
        self.hermes_gateway_token = gateway_cfg.resolved_gateway_token()
        self.max_files = labeler_cfg.max_files_per_cluster_context
        self.body_preview_chars = labeler_cfg.body_preview_chars
        self.min_cluster_size = labeler_cfg.min_cluster_size_to_label

    async def label_cluster(
        self,
        cluster_id: int,
        member_paths: list[str],
        records: dict[str, VaultRecord],
    ) -> list[str]:
        """Get 1-3 descriptive tags for a cluster from the LLM.

        When the cluster contains one or more first-class entity records
        (matter/person/org/project), their slugs are added as canonical
        tags alongside the LLM-generated descriptive labels. This lets
        downstream consumers match on a stable slug ("erste-makerspace")
        rather than the LLM's occasionally-drifting descriptive labels.
        Entity slugs come FIRST in the tag list so they have priority
        across the 3-tag cap in existing consumers.
        """
        if len(member_paths) < self.min_cluster_size:
            return []

        # Collect entity slugs from the cluster's members. These are
        # added unconditionally — no LLM judgement needed, the slug is
        # derived deterministically from the record's rel_path.
        entity_slugs: list[str] = []
        seen_slugs: set[str] = set()
        for path in member_paths:
            record = records.get(path)
            if record is None:
                continue
            if record.record_type not in ENTITY_RECORD_TYPES:
                continue
            slug = _slug_from_rel_path(path)
            if slug and slug not in seen_slugs:
                entity_slugs.append(slug)
                seen_slugs.add(slug)

        # Build member summaries and get LLM-generated descriptive tags.
        members_text = self._build_member_summaries(member_paths, records)
        prompt = CLUSTER_LABEL_PROMPT.format(members=members_text)

        response = await self._llm_call(prompt)
        llm_tags: list[str] = []
        if response is not None:
            try:
                parsed = _extract_balanced_json(response)
                if isinstance(parsed, list) and all(isinstance(t, str) for t in parsed):
                    llm_tags = parsed[:3]
            except (json.JSONDecodeError, TypeError):
                log.warning(
                    "labeler.parse_error",
                    cluster_id=cluster_id,
                    response=response[:200],
                )

        # Merge: entity slugs first (canonical), then LLM tags, dedupe
        # (LLM tags that happen to match a slug get dropped).
        merged: list[str] = list(entity_slugs)
        for tag in llm_tags:
            if tag not in seen_slugs:
                merged.append(tag)
                seen_slugs.add(tag)

        return merged

    async def suggest_relationships(
        self,
        cluster_id: int,
        member_paths: list[str],
        records: dict[str, VaultRecord],
    ) -> list[dict]:
        """Suggest relationships for co-clustered files that lack links between them."""
        if len(member_paths) < 2:
            return []

        # Find pairs that don't already link to each other
        unlinked_pairs = self._find_unlinked_pairs(member_paths, records)
        if not unlinked_pairs:
            return []

        # Truncate pairs for context
        unlinked_pairs = unlinked_pairs[:10]

        pairs_text = self._build_pairs_text(unlinked_pairs, records)
        prompt = RELATIONSHIP_PROMPT.format(pairs=pairs_text)

        response = await self._llm_call(prompt)
        if response is None:
            return []

        try:
            rels = _extract_balanced_json(response)
            if isinstance(rels, list):
                return [
                    r for r in rels
                    if isinstance(r, dict)
                    and all(k in r for k in ("source", "target", "type", "context", "confidence"))
                    and r["confidence"] >= 0.5
                ]
        except (json.JSONDecodeError, TypeError):
            log.warning("labeler.rel_parse_error", cluster_id=cluster_id, response=response[:200])

        return []

    def _build_member_summaries(
        self, paths: list[str], records: dict[str, VaultRecord]
    ) -> str:
        """Build text summaries of cluster members for the LLM."""
        lines: list[str] = []
        for path in paths[: self.max_files]:
            record = records.get(path)
            if record is None:
                lines.append(f"- [{path}] (no content available)")
                continue
            name = record.frontmatter.get("name", path)
            rtype = record.record_type
            preview = record.body[: self.body_preview_chars].replace("\n", " ").strip()
            lines.append(f"- [{rtype}] {name}: {preview}")
        return "\n".join(lines)

    def _find_unlinked_pairs(
        self, paths: list[str], records: dict[str, VaultRecord]
    ) -> list[tuple[str, str]]:
        """Find pairs of files in the cluster that don't link to each other."""
        # Build set of existing links for each file
        link_sets: dict[str, set[str]] = {}
        for path in paths:
            record = records.get(path)
            if record:
                link_sets[path] = set(record.wikilinks)
            else:
                link_sets[path] = set()

        pairs: list[tuple[str, str]] = []
        for i, p1 in enumerate(paths):
            for p2 in paths[i + 1 :]:
                # Check if either links to the other (by name or path)
                p1_name = p1.rsplit("/", 1)[-1].replace(".md", "")
                p2_name = p2.rsplit("/", 1)[-1].replace(".md", "")
                if p2_name not in link_sets.get(p1, set()) and p1_name not in link_sets.get(p2, set()):
                    pairs.append((p1, p2))
        return pairs

    def _build_pairs_text(
        self, pairs: list[tuple[str, str]], records: dict[str, VaultRecord]
    ) -> str:
        lines: list[str] = []
        for src, tgt in pairs:
            src_rec = records.get(src)
            tgt_rec = records.get(tgt)
            src_name = src_rec.frontmatter.get("name", src) if src_rec else src
            tgt_name = tgt_rec.frontmatter.get("name", tgt) if tgt_rec else tgt
            src_type = src_rec.record_type if src_rec else "unknown"
            tgt_type = tgt_rec.record_type if tgt_rec else "unknown"
            lines.append(f"- [{src_type}] {src_name} ({src}) ↔ [{tgt_type}] {tgt_name} ({tgt})")
        return "\n".join(lines)

    async def _llm_call(self, prompt: str) -> str | None:
        """Make a Hermes WORKERS gateway call with rate limiting and retry.

        Raises ``RuntimeError`` if the gateway URL is not configured —
        there is no fallback to any third-party provider.
        """
        if not self.hermes_gateway_url:
            raise RuntimeError(
                "Labeler: SURVEYOR_HERMES_GATEWAY_URL is not set. "
                "The surveyor labeler requires the Hermes WORKERS gateway. "
                "Set SURVEYOR_HERMES_GATEWAY_URL=http://hermes:18790 in the environment."
            )
        return await self._llm_call_hermes(prompt)

    async def _llm_call_hermes(self, prompt: str) -> str | None:
        """Platform path — Hermes WORKERS gateway via ``POST /v1/responses``.

        The model is deliberately NOT sent: the WORKERS profile owns model
        selection server-side (frozen contract). The call blocks until the
        agent run completes, so the read timeout is the completion budget. We
        return the final assistant text so the caller's prose-tolerant JSON
        extractor can take it from there.
        """
        url = f"{self.hermes_gateway_url}/v1/responses"
        headers = {
            "Authorization": f"Bearer {self.hermes_gateway_token}",
            "X-Hermes-Session-Key": SURVEYOR_SESSION_KEY,
            "Content-Type": "application/json",
        }
        timeout = httpx.Timeout(HERMES_TIMEOUT_SECONDS, connect=30.0)
        for attempt in range(MAX_RETRIES):
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    resp = await client.post(url, headers=headers, json={"input": prompt})
                if resp.status_code == 429 or resp.status_code >= 500:
                    delay = RETRY_BASE_DELAY * (2 ** attempt)
                    log.warning(
                        "labeler.hermes_retryable",
                        status=resp.status_code,
                        attempt=attempt + 1,
                        delay=delay,
                    )
                    await asyncio.sleep(delay)
                    continue
                if resp.status_code >= 400:
                    # 401/402/403/4xx — auth / payment / bad request. Retrying
                    # burns the same dead token; give up like the direct path.
                    log.error(
                        "labeler.hermes_error",
                        status=resp.status_code,
                        body=resp.text[:200],
                    )
                    return None
                await asyncio.sleep(API_CALL_DELAY)
                return _response_output_text(resp.json())
            except Exception as e:
                log.error("labeler.hermes_exception", error=str(e), attempt=attempt + 1)
                await asyncio.sleep(RETRY_BASE_DELAY * (2 ** attempt))
        log.error("labeler.hermes_failed", max_retries=MAX_RETRIES)
        return None


def _response_output_text(response: Any) -> str:
    """Pull the assistant's final text out of a Hermes ``/v1/responses`` body.

    Mirrors alfred-learn's clerk extractor. The canonical shape is::

        {"output": [ ...,
                     {"type": "message", "role": "assistant",
                      "content": [{"type": "output_text", "text": "..."}]} ]}

    We take the last assistant ``message`` item, with a few defensive
    fallbacks (top-level ``output_text``, or ``output`` itself being a
    string / parts list) for older or mocked transports.
    """
    if not isinstance(response, dict):
        return ""
    out = response.get("output")
    if isinstance(out, list):
        message_text = ""
        for item in out:
            if isinstance(item, dict) and item.get("type") == "message":
                text = _content_parts_text(item.get("content"))
                if text:
                    message_text = text
        if message_text:
            return message_text
        return _content_parts_text(out)
    if isinstance(out, str):
        return out
    if isinstance(out, dict):
        return _content_parts_text(out)
    fallback = response.get("output_text")
    if isinstance(fallback, str):
        return fallback
    return ""


def _content_parts_text(content: Any) -> str:
    """Concatenate the text of an OpenAI-style Responses ``content`` parts list.

    Accepts a plain string, a list of part dicts (``text`` or ``content``
    keys), bare strings in a list, or a single part dict — the gateway has
    emitted each variant across versions.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict):
                if isinstance(part.get("text"), str):
                    parts.append(part["text"])
                elif isinstance(part.get("content"), str):
                    parts.append(part["content"])
            elif isinstance(part, str):
                parts.append(part)
        return "\n".join(p for p in parts if p)
    if isinstance(content, dict):
        if isinstance(content.get("text"), str):
            return content["text"]
        if isinstance(content.get("content"), str):
            return content["content"]
        if isinstance(content.get("content"), list):
            return _content_parts_text(content["content"])
    return ""
