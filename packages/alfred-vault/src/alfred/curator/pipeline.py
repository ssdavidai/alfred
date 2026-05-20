"""4-stage curator pipeline — replaces the monolithic single-call approach.

Stage 1: ANALYZE + WRITE NOTE (LLM) — short prompt, creates one note, returns JSON entity manifest
Stage 2: ENTITY RESOLUTION (pure Python) — deduplicate & create entities via vault ops
Stage 3: INTERLINK (pure Python) — wire up wikilinks between note and entities
Stage 4: ENRICH ENTITIES (LLM, per-entity) — fill body + frontmatter for each entity
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from alfred.vault.mutation_log import log_mutation
from alfred.vault.ops import VaultError, vault_create, vault_edit, vault_read

from .backends import VAULT_CLI_REFERENCE
from .backends.openclaw import OpenClawBackend, _clear_agent_sessions, sync_workspace_claude_md
from .config import CuratorConfig
from .utils import get_logger

log = get_logger(__name__)


@dataclass
class PipelineResult:
    """Result from the 4-stage pipeline."""

    success: bool = False
    note_path: str = ""
    entities_created: list[str] = field(default_factory=list)
    entities_existing: list[str] = field(default_factory=list)
    entities_enriched: list[str] = field(default_factory=list)
    summary: str = ""


# Entity types that don't benefit from LLM enrichment (too simple)
_SKIP_ENRICH_TYPES = {"location", "event"}


def _load_stage_prompt(stage_file: str) -> str:
    """Load a stage prompt from the bundled skills directory."""
    from alfred._data import get_skills_dir

    prompt_path = get_skills_dir() / "vault-curator" / "prompts" / stage_file
    if not prompt_path.exists():
        log.warning("pipeline.prompt_not_found", path=str(prompt_path))
        return ""
    return prompt_path.read_text(encoding="utf-8")


def _load_user_profile(vault_path: Path) -> str:
    """Load the vault owner's profile for entity relevance filtering.

    Searches for a user-profile.md in the vault root first, then falls back
    to common locations.
    """
    candidates = [
        vault_path / "user-profile.md",
        Path.home() / ".config" / "alfred" / "user-profile.md",
    ]
    for path in candidates:
        if path.exists():
            try:
                text = path.read_text(encoding="utf-8")
                if text.strip():
                    return text
            except OSError:
                continue
    return "(no user profile available — use your best judgement about relevance)"


def _extract_entities_from_text(text: str) -> list[dict] | None:
    """Find a JSON object with an "entities" array anywhere in text.

    Uses brace-depth tracking to handle nested objects.
    """
    for match in re.finditer(r'\{[^{}]*"entities"\s*:\s*\[', text):
        start = match.start()
        depth = 0
        for i in range(start, len(text)):
            if text[i] == '{':
                depth += 1
            elif text[i] == '}':
                depth -= 1
                if depth == 0:
                    candidate = text[start:i + 1]
                    try:
                        data = json.loads(candidate)
                        if isinstance(data.get("entities"), list):
                            return data["entities"]
                    except json.JSONDecodeError:
                        continue
                    break
    return None


def _parse_entity_manifest(stdout: str) -> list[dict]:
    """Extract the JSON entity manifest from LLM stdout.

    Searches in order:
    1. Markdown fenced code blocks (```json ... ```)
    2. Raw JSON with {"entities": [...]} anywhere in output
    3. Entire stdout as JSON
    """
    if not stdout or '"entities"' not in stdout:
        log.warning("pipeline.manifest_parse_failed", stdout_len=len(stdout))
        return []

    # Tier 1: Extract from markdown code blocks (```json ... ```)
    for block_match in re.finditer(r'```(?:json)?\s*\n(.*?)\n```', stdout, re.DOTALL):
        block = block_match.group(1).strip()
        if '"entities"' in block:
            result = _extract_entities_from_text(block)
            if result is not None:
                return result

    # Tier 2: Find JSON with "entities" anywhere in the raw output
    result = _extract_entities_from_text(stdout)
    if result is not None:
        return result

    # Tier 3: Try to parse the entire stdout as JSON
    try:
        data = json.loads(stdout.strip())
        if isinstance(data.get("entities"), list):
            return data["entities"]
    except (json.JSONDecodeError, AttributeError):
        pass

    log.warning("pipeline.manifest_parse_failed", stdout_len=len(stdout))
    return []


def _find_created_note(stdout: str, session_path: str) -> str:
    """Find the note path created in Stage 1 by reading the mutation log."""
    from alfred.vault.mutation_log import read_mutations

    mutations = read_mutations(session_path)
    for path in mutations.get("files_created", []):
        if path.startswith("note/"):
            return path
    return ""


async def _call_llm(
    prompt: str,
    config: CuratorConfig,
    session_path: str,
    stage_label: str,
) -> str:
    """Make an isolated OpenClaw call and return stdout.

    Handles session clearing, workspace sync, subprocess exec with
    --local --json, and timeout.
    """
    oc = config.agent.openclaw
    session_id = f"curator-{stage_label}-{uuid.uuid4().hex[:8]}"

    # Clear previous session state
    _clear_agent_sessions(oc.agent_id)

    # Ensure workspace has latest vault CLAUDE.md
    sync_workspace_claude_md(oc.agent_id, str(config.vault.vault_path))

    # Write prompt to a temp file and pass via stdin to avoid
    # OSError: [Errno 7] Argument list too long when the prompt
    # (which includes full inbox content) exceeds the OS arg limit.
    prompt_file = None
    try:
        prompt_file = tempfile.NamedTemporaryFile(
            mode="w",
            prefix=f"alfred-curator-{stage_label}-",
            suffix=".md",
            delete=False,
            encoding="utf-8",
        )
        prompt_file.write(prompt)
        prompt_file.close()
        prompt_path = prompt_file.name
    except OSError:
        log.error("pipeline.prompt_file_write_failed", stage=stage_label)
        return ""

    cmd = [
        oc.command, "agent", *oc.args,
        "--agent", oc.agent_id,
        "--session-id", session_id,
        "--message", f"Follow the instructions in {prompt_path}",
        "--local", "--json",
    ]

    env = {
        **os.environ,
        "ALFRED_VAULT_PATH": str(config.vault.vault_path),
        "ALFRED_VAULT_SCOPE": "curator",
        "ALFRED_VAULT_SESSION": session_path,
    }

    log.info(
        "pipeline.llm_call",
        stage=stage_label,
        agent_id=oc.agent_id,
        session_id=session_id,
        prompt_file=prompt_path,
    )

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(),
            timeout=oc.timeout,
        )
    except asyncio.TimeoutError:
        log.error("pipeline.llm_timeout", stage=stage_label, timeout=oc.timeout)
        return ""
    except FileNotFoundError:
        log.error("pipeline.command_not_found", command=oc.command)
        return ""
    finally:
        # Clean up prompt temp file
        if prompt_file is not None:
            try:
                os.unlink(prompt_path)
            except OSError:
                pass

    raw = stdout_bytes.decode("utf-8", errors="replace")
    err = stderr_bytes.decode("utf-8", errors="replace")

    if proc.returncode != 0:
        log.warning(
            "pipeline.llm_nonzero_exit",
            stage=stage_label,
            code=proc.returncode,
            stderr=err[:500],
        )
        return raw  # Return whatever output we got — note may still have been created

    log.info("pipeline.llm_completed", stage=stage_label, stdout_len=len(raw))
    return raw


# ---------------------------------------------------------------------------
# Stage 1: Analyze + Write Note (LLM)
# ---------------------------------------------------------------------------


async def _stage1_analyze(
    inbox_content: str,
    inbox_filename: str,
    vault_context_text: str,
    config: CuratorConfig,
    session_path: str,
) -> tuple[str, list[dict]]:
    """Stage 1: LLM creates a note and returns an entity manifest.

    Returns (note_path, entity_manifest).

    The LLM is instructed to write the entity manifest JSON to a temp file
    rather than stdout, because OpenClaw's stdout contains the full agent
    conversation mixed in, making JSON extraction unreliable.  We fall back
    to stdout parsing if the temp file is missing or unreadable.
    """
    template = _load_stage_prompt("stage1_analyze.md")
    if not template:
        return "", []

    # Generate a unique manifest file path for the LLM to write to.
    # Use /alfred-data/ (shared volume between alfred and openclaw-workers
    # containers) instead of /tmp (separate tmpfs per container).
    manifest_id = uuid.uuid4().hex[:12]
    manifest_path = f"/alfred-data/alfred-curator-{manifest_id}-manifest.json"

    prompt = template.format(
        vault_cli_reference=VAULT_CLI_REFERENCE,
        vault_context=vault_context_text,
        inbox_filename=inbox_filename,
        inbox_content=inbox_content,
        manifest_path=manifest_path,
        user_profile=_load_user_profile(config.vault.vault_path),
    )

    max_attempts = 3
    note_path = ""
    manifest: list[dict] = []

    for attempt in range(1, max_attempts + 1):
        stdout = await _call_llm(prompt, config, session_path, "s1-analyze")

        # Find the note that was created via mutation log (only on first attempt)
        if not note_path:
            note_path = _find_created_note(stdout, session_path)
            if not note_path:
                log.warning("pipeline.s1_no_note_created", file=inbox_filename)

        # Try to read the entity manifest from the temp file first.
        # The manifest_path uses /alfred-data/ (openclaw-workers mount point),
        # but the alfred container mounts the same volume at /app/data/.
        # Try both paths.
        try:
            manifest_file = Path(manifest_path)
            if not manifest_file.exists():
                # Translate /alfred-data/ → /app/data/ for cross-container access
                alt_path = manifest_path.replace("/alfred-data/", "/app/data/")
                alt_file = Path(alt_path)
                if alt_file.exists():
                    manifest_file = alt_file
            if manifest_file.exists():
                raw_json = manifest_file.read_text(encoding="utf-8").strip()
                data = json.loads(raw_json)
                if isinstance(data.get("entities"), list):
                    manifest = data["entities"]
                    log.info(
                        "pipeline.manifest_from_file",
                        path=manifest_path,
                        entities=len(manifest),
                    )
        except (json.JSONDecodeError, OSError, KeyError) as e:
            log.warning("pipeline.manifest_file_read_failed", path=manifest_path, error=str(e))
        finally:
            # Clean up the temp manifest file (try both possible paths)
            for p in [manifest_path, manifest_path.replace("/alfred-data/", "/app/data/")]:
                try:
                    Path(p).unlink(missing_ok=True)
                except OSError:
                    pass

        # Fallback: parse entity manifest from stdout if file method failed
        if not manifest:
            manifest = _parse_entity_manifest(stdout)
            if manifest:
                log.info("pipeline.manifest_from_stdout", entities=len(manifest))

        if manifest:
            break

        if attempt < max_attempts:
            log.warning(
                "pipeline.s1_manifest_retry",
                file=inbox_filename,
                attempt=attempt,
                max_attempts=max_attempts,
            )

    log.info(
        "pipeline.s1_complete",
        note_path=note_path,
        entities_found=len(manifest),
    )
    return note_path, manifest


# ---------------------------------------------------------------------------
# Stage 2: Entity Resolution + Creation (pure Python)
# ---------------------------------------------------------------------------


def _normalize_name(name: str, entity_type: str) -> str:
    """Normalize entity name for matching."""
    name = name.strip()
    if entity_type == "person":
        # Title case for persons
        name = name.title()
    return name


def _entity_exists(vault_path: Path, entity_type: str, name: str) -> str | None:
    """Check if an entity already exists. Returns rel_path if found, else None."""
    from alfred.vault.schema import TYPE_DIRECTORY

    directory = TYPE_DIRECTORY.get(entity_type, entity_type)
    candidate = vault_path / directory / f"{name}.md"
    if candidate.exists():
        return f"{directory}/{name}.md"
    return None


def _resolve_entities(
    manifest: list[dict],
    vault_path: Path,
    session_path: str,
) -> dict[str, str]:
    """Stage 2: For each entity in the manifest, check if it exists or create it.

    Returns a map: "type/Name" -> rel_path (e.g. "person/John Smith" -> "person/John Smith.md")
    """
    from alfred.vault.schema import TYPE_DIRECTORY

    resolved: dict[str, str] = {}

    for entity in manifest:
        entity_type = entity.get("type", "")
        name = entity.get("name", "")
        description = entity.get("description", "")
        fields = entity.get("fields", {})

        if not entity_type or not name:
            log.warning("pipeline.s2_skip_invalid", entity=entity)
            continue

        name = _normalize_name(name, entity_type)
        directory = TYPE_DIRECTORY.get(entity_type, entity_type)
        entity_key = f"{directory}/{name}"

        # Check if already resolved in this batch
        if entity_key in resolved:
            continue

        # Check if exists in vault
        existing_path = _entity_exists(vault_path, entity_type, name)
        if existing_path:
            resolved[entity_key] = existing_path
            log.info("pipeline.s2_entity_exists", entity=entity_key)
            continue

        # Use the full body from the manifest if provided, otherwise fall back
        # to a simple heading + description.
        manifest_body = entity.get("body", "")
        if manifest_body and manifest_body.strip():
            body = manifest_body
            # Ensure it ends with a newline
            if not body.endswith("\n"):
                body += "\n"
        else:
            body = f"# {name}\n\n{description}\n" if description else f"# {name}\n"

        # Parse fields — strip wrapping quotes from wikilink values
        set_fields: dict = {}
        for k, v in fields.items():
            if isinstance(v, str):
                # Remove outer escaped quotes: \"[[...]]\" -> [[...]]
                v = v.strip('"')
            set_fields[k] = v

        try:
            result = vault_create(
                vault_path,
                entity_type,
                name,
                set_fields=set_fields,
                body=body,
            )
            rel_path = result["path"]
            resolved[entity_key] = rel_path
            log_mutation(session_path, "create", rel_path)
            log.info("pipeline.s2_entity_created", entity=entity_key, path=rel_path)
        except VaultError as e:
            log.warning("pipeline.s2_create_failed", entity=entity_key, error=str(e))
            # If creation failed because it already exists, record the path anyway
            if "already exists" in str(e).lower():
                resolved[entity_key] = f"{directory}/{name}.md"

    return resolved


# ---------------------------------------------------------------------------
# Stage 3: Interlink (pure Python)
# ---------------------------------------------------------------------------


def _interlink(
    note_path: str,
    resolved_entities: dict[str, str],
    manifest: list[dict],
    vault_path: Path,
    session_path: str,
) -> None:
    """Stage 3: Wire up wikilinks between the note and all entities."""
    if not note_path:
        return

    # Build wikilink-style references (without .md extension)
    entity_links = []
    for entity_key in resolved_entities:
        entity_links.append(f"[[{entity_key}]]")

    # Edit the note to add related links to all entities
    if entity_links:
        try:
            vault_edit(
                vault_path,
                note_path,
                set_fields={"related": entity_links},
            )
            log_mutation(session_path, "edit", note_path)
            log.info("pipeline.s3_note_linked", note=note_path, links=len(entity_links))
        except VaultError as e:
            log.warning("pipeline.s3_note_link_failed", error=str(e))

    # Edit each entity to add a related link back to the note
    note_link = f"[[{note_path.removesuffix('.md')}]]"
    for entity_key, entity_rel_path in resolved_entities.items():
        try:
            vault_edit(
                vault_path,
                entity_rel_path,
                append_fields={"related": note_link},
            )
            log_mutation(session_path, "edit", entity_rel_path)
        except VaultError as e:
            log.warning(
                "pipeline.s3_entity_link_failed",
                entity=entity_key,
                error=str(e),
            )

    log.info("pipeline.s3_complete", entities_linked=len(resolved_entities))


# ---------------------------------------------------------------------------
# Stage 4: Enrich Entities (LLM, per-entity)
# ---------------------------------------------------------------------------


async def _stage4_enrich(
    inbox_content: str,
    inbox_filename: str,
    note_path: str,
    resolved_entities: dict[str, str],
    manifest: list[dict],
    config: CuratorConfig,
    session_path: str,
) -> list[str]:
    """Stage 4: Enrich each entity with LLM. Returns list of enriched entity paths."""
    template = _load_stage_prompt("stage4_enrich.md")
    if not template:
        return []

    vault_path = config.vault.vault_path
    enriched: list[str] = []

    # Build a lookup from entity_key to manifest entry
    manifest_by_key: dict[str, dict] = {}
    for entity in manifest:
        from alfred.vault.schema import TYPE_DIRECTORY

        etype = entity.get("type", "")
        ename = _normalize_name(entity.get("name", ""), etype)
        directory = TYPE_DIRECTORY.get(etype, etype)
        key = f"{directory}/{ename}"
        manifest_by_key[key] = entity

    for entity_key, entity_rel_path in resolved_entities.items():
        # Determine entity type from the key
        parts = entity_key.split("/", 1)
        if len(parts) != 2:
            continue
        entity_dir, entity_name = parts

        # Look up the manifest entry for this entity
        manifest_entry = manifest_by_key.get(entity_key, {})
        entity_type = manifest_entry.get("type", entity_dir)

        # Skip types that don't benefit from enrichment
        if entity_type in _SKIP_ENRICH_TYPES:
            log.info("pipeline.s4_skip", entity=entity_key, reason="type_skip_list")
            continue

        # Read current entity content
        try:
            record = vault_read(vault_path, entity_rel_path)
            entity_content = json.dumps(record, indent=2, default=str)
        except VaultError:
            entity_content = "(could not read)"

        # Determine if this is a new entity (was it created in Stage 2?)
        # Check if it's in the entities_created list we'll track
        is_new = entity_key not in {
            k for k, v in resolved_entities.items()
            if _entity_exists(vault_path, entity_type, entity_name.split("/")[-1] if "/" in entity_name else entity_name) and entity_key != k
        }

        prompt = template.format(
            vault_cli_reference=VAULT_CLI_REFERENCE,
            inbox_filename=inbox_filename,
            inbox_content=inbox_content,
            note_path=note_path,
            entity_path=entity_rel_path,
            entity_type=entity_type,
            is_new="yes" if is_new else "no (existing record)",
            entity_content=entity_content,
        )

        # Sanitize entity name for the stage label
        safe_name = re.sub(r'[^a-zA-Z0-9_-]', '', entity_name.replace(' ', '-'))[:30]
        stage_label = f"s4-{entity_type}-{safe_name}"

        await _call_llm(prompt, config, session_path, stage_label)
        enriched.append(entity_rel_path)

        log.info("pipeline.s4_enriched", entity=entity_key)

    log.info("pipeline.s4_complete", enriched=len(enriched))
    return enriched


# ---------------------------------------------------------------------------
# Pipeline entry point
# ---------------------------------------------------------------------------


async def run_pipeline(
    inbox_file: Path,
    inbox_content: str,
    vault_context_text: str,
    config: CuratorConfig,
    session_path: str,
) -> PipelineResult:
    """Run the 4-stage curator pipeline on a single inbox file.

    Args:
        inbox_file: Path to the inbox file being processed.
        inbox_content: Text content of the inbox file.
        vault_context_text: Pre-built vault context prompt text.
        config: Curator configuration.
        session_path: Path to the mutation log session file.

    Returns:
        PipelineResult with success status and details.
    """
    filename = inbox_file.name
    result = PipelineResult()

    log.info("pipeline.start", file=filename)

    # Stage 1: Analyze + Write Note (LLM)
    note_path, manifest = await _stage1_analyze(
        inbox_content=inbox_content,
        inbox_filename=filename,
        vault_context_text=vault_context_text,
        config=config,
        session_path=session_path,
    )
    result.note_path = note_path

    if not note_path and not manifest:
        result.summary = "Stage 1 failed: no note created and no entities found"
        log.error("pipeline.s1_failed", file=filename)
        return result

    # Stage 2: Entity Resolution + Creation (pure Python)
    resolved = _resolve_entities(
        manifest=manifest,
        vault_path=config.vault.vault_path,
        session_path=session_path,
    )

    # Classify entities as created vs existing
    for entity_key, entity_path in resolved.items():
        parts = entity_key.split("/", 1)
        if len(parts) == 2:
            entity_name = parts[1]
            entity_type_dir = parts[0]
            # If the entity existed before Stage 2 started, it's existing
            # We can check by looking at the manifest — entities that were created
            # in this stage are new
            from alfred.vault.schema import TYPE_DIRECTORY

            # Reverse lookup: find the type from the directory
            type_for_dir = {v: k for k, v in TYPE_DIRECTORY.items()}.get(entity_type_dir, entity_type_dir)
            if _entity_exists(config.vault.vault_path, type_for_dir, entity_name):
                # It exists now; could be new or existing — we don't track this precisely,
                # but the mutation log does. For reporting, assume entities in mutation log
                # as "create" are new.
                pass
        result.entities_created.append(entity_path)

    # Stage 3: Interlink (pure Python)
    _interlink(
        note_path=note_path,
        resolved_entities=resolved,
        manifest=manifest,
        vault_path=config.vault.vault_path,
        session_path=session_path,
    )

    # Stage 4: Enrich Entities (LLM, per-entity)
    # Gated behind config flag — skipping saves one LLM call per entity.
    # Entities retain their stub content from Stage 2 (which already includes
    # the description from the manifest). Ref: ssdavidai/alfred#14
    if not config.skip_entity_enrichment:
        enriched = await _stage4_enrich(
            inbox_content=inbox_content,
            inbox_filename=filename,
            note_path=note_path,
            resolved_entities=resolved,
            manifest=manifest,
            config=config,
            session_path=session_path,
        )
        result.entities_enriched = enriched
    else:
        log.info("pipeline.s4_skipped", reason="skip_entity_enrichment=True")
        result.entities_enriched = []

    result.success = True
    # Use result.entities_enriched (always set in both branches above) rather
    # than the local `enriched`, which is unbound when stage 4 is skipped.
    result.summary = (
        f"Created note: {note_path}, "
        f"resolved {len(resolved)} entities, "
        f"enriched {len(result.entities_enriched)} entities"
    )

    log.info(
        "pipeline.complete",
        file=filename,
        note=note_path,
        entities_resolved=len(resolved),
        entities_enriched=len(result.entities_enriched),
    )

    return result
