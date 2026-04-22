"""Stage 4: OpenRouter LLM labeling — cluster tags + relationship suggestions."""

from __future__ import annotations

import asyncio
import json
from pathlib import PurePosixPath

import structlog
from openai import AsyncOpenAI

from .config import LabelerConfig, OpenRouterConfig
from .parser import VaultRecord

log = structlog.get_logger()

# Record types that are first-class entities in the vault taxonomy. When a
# cluster contains one of these, its filename stem becomes a canonical
# cluster tag so every member inherits the entity slug and downstream
# consumers can match on `alfred_tags: [<entity-slug>]`.
ENTITY_RECORD_TYPES = frozenset({"matter", "person", "org", "project"})


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
    def __init__(self, openrouter_cfg: OpenRouterConfig, labeler_cfg: LabelerConfig) -> None:
        self.client = AsyncOpenAI(
            api_key=openrouter_cfg.api_key,
            base_url=openrouter_cfg.base_url,
        )
        self.model = openrouter_cfg.model
        self.temperature = openrouter_cfg.temperature
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
                parsed = json.loads(response)
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
            rels = json.loads(response)
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
        """Make an LLM call with rate limiting and retry."""
        for attempt in range(MAX_RETRIES):
            try:
                resp = await self.client.chat.completions.create(
                    model=self.model,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=self.temperature,
                )
                if resp.usage:
                    log.info(
                        "labeler.usage",
                        total_tokens=resp.usage.total_tokens,
                        prompt_tokens=resp.usage.prompt_tokens,
                        completion_tokens=resp.usage.completion_tokens,
                    )
                await asyncio.sleep(API_CALL_DELAY)
                return resp.choices[0].message.content
            except Exception as e:
                error_str = str(e)
                if "429" in error_str:
                    delay = RETRY_BASE_DELAY * (2 ** attempt)
                    log.warning("labeler.rate_limited", attempt=attempt + 1, delay=delay)
                    await asyncio.sleep(delay)
                else:
                    log.error("labeler.llm_error", error=error_str)
                    return None
        log.error("labeler.llm_failed", max_retries=MAX_RETRIES)
        return None
