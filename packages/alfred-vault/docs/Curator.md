# Curator

The Curator is an AI-powered tool that automatically processes raw inputs from your `inbox/` folder into structured vault records. It runs as a background daemon, continuously watching for new files and transforming unstructured content into your vault's ontology.

## Overview

Curator handles the ingestion pipeline for your Obsidian vault. It takes raw inputs like meeting transcripts, emails, voice memos, or rough notes and converts them into structured records with proper frontmatter, entity extraction, and wikilink relationships.

**Key capabilities:**
- Watches the `inbox/` folder for new files
- Extracts entities (people, organizations, projects, tasks, decisions, etc.)
- Creates structured vault records with proper templates and frontmatter
- Automatically interlinks related entities
- Enriches entities with contextual information
- Runs as a background daemon with auto-restart

## Architecture

### 4-Stage Pipeline

The Curator uses a sophisticated 4-stage pipeline (currently available with the OpenClaw backend; Claude and Zo backends use a single-call legacy mode):

#### Stage 1: Analyze + Create Note (LLM)

The LLM reads the inbox file and performs initial analysis:
- Creates a comprehensive note record in the vault using `alfred vault create note`
- Writes a JSON entity manifest to a temporary file listing all discovered entities
- The manifest contains: type, name, description, and fields for each entity
- Includes 3-attempt retry logic if the LLM fails to write the manifest file

#### Stage 2: Entity Resolution (Pure Python)

Pure Python logic processes the manifest:
- Reads and parses the entity manifest
- Normalizes entity names for consistency
- Checks for existing records in the vault (deduplication)
- Creates new entity records via `vault_create`
- Each entity receives its type-specific template with base-view embeds (Dataview sections like Assumptions, Decisions, Tasks) automatically appended

#### Stage 3: Interlinking (Pure Python)

Establishes relationships between records:
- Wires up wikilinks between the note and all resolved entities
- Edits the note to add entity links
- Edits each entity to add a backlink to the source note
- Creates a fully connected knowledge graph

#### Stage 4: Enrich Entities (LLM, per-entity)

Per-entity enrichment calls:
- Makes a focused LLM call for each newly created entity
- Fills in body content with relevant information from the source material
- Populates frontmatter fields specific to the entity type
- Uses context from the original inbox file for accurate enrichment

### Entity Extraction

The Curator extracts the following entity types:

**Entities:**
- person
- org (organization)
- project
- location
- conversation
- task
- event

**Learning Types:**
- decision
- assumption
- constraint

### Relevance Filtering

The Curator uses intelligent relevance filtering to avoid cluttering your vault:
- Reads `user-profile.md` from the vault root to understand your context
- Only creates entities you directly interact with
- Skips: media references, celebrities, third-party examples, subjects of analysis
- Focuses on: people you meet, projects you work on, decisions you make

## Configuration

Configure the Curator in the `curator` section of `config.yaml`:

```yaml
curator:
  interval: 60  # Polling interval in seconds

agent:
  backend: openclaw  # claude | zo | openclaw
  timeout: 300       # LLM call timeout in seconds
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `curator.interval` | int | 60 | Polling interval for inbox watching (seconds) |
| `agent.backend` | string | claude | AI backend to use (claude, zo, openclaw) |
| `agent.timeout` | int | 300 | LLM call timeout in seconds |

## CLI Usage

### Run as Foreground Daemon

```bash
alfred curator
```

Starts the Curator daemon in the foreground. Useful for debugging and development.

### Run as Background Daemon

```bash
alfred up --only curator
```

Starts only the Curator as a background daemon.

```bash
alfred up
```

Starts all Alfred daemons (including Curator) in the background.

### Batch Processing

```bash
alfred process
```

Processes all files in the inbox folder as a one-time batch operation.

```bash
alfred process -j 8
```

Parallel batch processing with 8 concurrent workers. Useful for processing large backlogs.

### Stop Daemon

```bash
alfred down
```

Stops all running Alfred daemons.

### Check Status

```bash
alfred status
```

Shows the status of all Alfred tools, including whether the Curator is running.

## Backend Support

The Curator supports three AI backends:

### Claude Code (subprocess)

Uses Claude via the `claude -p` CLI command in subprocess mode.

**Configuration:**
```yaml
agent:
  backend: claude
```

**Mode:** Single-call legacy mode

### Zo Computer (HTTP API)

Uses Zo's HTTP API for agent execution.

**Configuration:**
```yaml
agent:
  backend: zo
  zo_api_url: https://api.zo.dev
  zo_api_key: ${ZO_API_KEY}
```

**Mode:** Single-call legacy mode

### OpenClaw (subprocess)

Uses OpenClaw via the `openclaw agent --message` CLI command.

**Configuration:**
```yaml
agent:
  backend: openclaw
```

**Mode:** Full 4-stage pipeline (recommended)

**Note:** The 4-stage pipeline is currently only available with the OpenClaw backend. Claude and Zo backends use a single-call legacy mode where all processing happens in one LLM invocation.

## State Management

The Curator maintains state in `data/curator_state.json`:
- Tracks processed file hashes to avoid re-processing
- Records processing history and timestamps
- Can be deleted to force re-processing of all inbox files

All vault mutations are logged to `data/vault_audit.log` as an append-only JSONL audit trail.

## Workflow Example

1. Drop a file into `inbox/meeting-notes.md`
2. Curator detects the new file
3. Stage 1: LLM creates a note record and entity manifest
4. Stage 2: Python creates entity records (deduplicating against existing vault)
5. Stage 3: Python interlinks the note with all entities
6. Stage 4: LLM enriches each entity with contextual information
7. Source file is marked as processed in state
8. Your vault now contains a structured note with fully populated, interlinked entities

## Scope Restrictions

The Curator operates under scope enforcement defined in `vault/scope.py`:
- Can create new records
- Can edit existing records
- Cannot delete records
- Restricted to entity types defined in the vault schema

This ensures the Curator cannot accidentally destroy vault data.
