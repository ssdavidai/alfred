# Janitor

The Janitor is one of four AI-powered tools in Alfred for managing an Obsidian vault. It periodically scans every file in the vault for structural problems and automatically fixes issues like broken wikilinks, missing frontmatter fields, and orphaned files.

## Overview

Janitor maintains vault health by detecting and repairing structural problems across all vault records. It runs periodic sweeps with a multi-stage pipeline that combines deterministic Python fixes with targeted LLM calls for complex repairs.

**Key capabilities:**
- Detects broken wikilinks, invalid frontmatter, orphaned files, and stub records
- Applies deterministic fixes for common structural issues
- Uses LLM calls for link disambiguation and stub enrichment
- Supports both light (structural-only) and deep (full agent) sweep modes
- Respects vault scope rules (can edit and delete, but not create new records)

## Issue Detection

Janitor scans for the following issue types:

| Issue Code | Description |
|------------|-------------|
| **FM001** | Missing required frontmatter fields (type, status, name/title) |
| **FM002** | Invalid type (not in KNOWN_TYPES) |
| **FM003** | Invalid status for the record type |
| **FM004** | Wrong field types (string provided where list expected, or vice versa) |
| **LK001** | Broken wikilinks (target file doesn't exist in vault) |
| **ORPHAN** | Files with no incoming wikilinks from other records |

## 3-Stage Fix Pipeline

Janitor uses a three-stage pipeline to repair issues, progressing from fast deterministic fixes to targeted LLM interventions.

### Stage 1: Autofix (Pure Python)

Applies deterministic fixes for frontmatter issues (FM001-FM004) without any LLM calls.

**What it fixes:**
- Infers record type from directory placement (e.g., file in `person/` gets `type: person`)
- Infers name/title from filename if missing
- Fixes field type mismatches (converts strings to lists, lists to strings as needed)
- Repairs invalid status values to valid ones for the record type
- Adds missing required fields with sensible defaults

**Output:** Reports counts of fixed/flagged/skipped issues.

### Stage 2: Link Repair (LLM, per-file)

For each file with broken wikilinks, makes a focused LLM call to disambiguate and repair the links.

**Process:**
- Provides the file content and the broken link text
- Includes a list of existing vault records as candidate targets
- LLM suggests the correct target for each broken link
- Applies fixes via `alfred vault edit`

**Example:** A broken link `[[John]]` might be resolved to `[[person/John Smith]]` or `[[person/John Doe]]` based on context.

### Stage 3: Stub Enrichment (LLM, per-file)

For stub records (files with minimal body content), makes an LLM call to enrich them using existing vault context.

**Guidelines:**
- Only adds verifiable facts from existing vault records
- Expands relationships using existing wikilinks
- Does NOT generate speculative or filler content
- Preserves the record's original purpose and scope

## Sweep Modes

### Light Sweep (Structural-Only)

Fast scan that runs autofix (Stage 1) only. No LLM calls are made.

**Use when:**
- You want frequent health checks without API costs
- Frontmatter issues are the main concern
- Agent backend is not configured

**Configuration:**
```yaml
janitor:
  interval: 300  # seconds between light sweeps
  structural_only: true
```

### Deep Sweep (Full Pipeline)

Runs all three stages, including LLM-powered link repair and stub enrichment.

**Use when:**
- You have broken links that need disambiguation
- Stub records need enrichment
- Agent backend is configured and available

**Configuration:**
```yaml
janitor:
  interval: 300  # light sweep interval
  deep_interval_hours: 24  # deep sweep interval
  structural_only: false
```

## Configuration

Janitor configuration lives in the `janitor` section of `config.yaml`:

```yaml
janitor:
  # Scan interval for light sweeps (seconds)
  interval: 300

  # Deep sweep interval (hours)
  deep_interval_hours: 24

  # Whether to apply fixes or just report issues
  fix_mode: true

  # Skip LLM stages (Stage 2 & 3), run autofix only
  structural_only: false
```

### Global Agent Configuration

Janitor uses the global `agent` section for backend selection:

```yaml
agent:
  backend: claude  # or 'openclaw', 'zo'

  claude:
    default_model: claude-opus-4-6

  openclaw:
    agent_id: vault-janitor
    stagger_startup_seconds: 10

  zo:
    api_key: ${ZO_API_KEY}
    model: anthropic/claude-opus-4-6
```

## CLI Commands

### One-Shot Scan

Run a single structural scan and print a report (no fixes applied):

```bash
alfred janitor scan
```

**Output:** Lists all detected issues with file paths and issue codes.

### One-Shot Fix

Run a single scan and apply fixes:

```bash
alfred janitor fix
```

**Behavior:** Runs the full pipeline (all 3 stages) if agent is configured, or just autofix (Stage 1) if `structural_only: true`.

### Watch Daemon

Run periodic sweeps as a foreground daemon:

```bash
alfred janitor watch
```

**Behavior:** Runs light sweeps at `interval` seconds, and deep sweeps at `deep_interval_hours` hours (if configured).

### Background Daemon

Start Janitor as a background process:

```bash
alfred up --only janitor
```

Check status:

```bash
alfred status
```

Stop daemon:

```bash
alfred down
```

## Backend Support

### OpenClaw (Recommended for Pipeline Mode)

The 3-stage pipeline mode was designed for OpenClaw and works best with its agent architecture.

**Setup:**
1. Register a `vault-janitor` agent in OpenClaw
2. Set the agent's workspace to include vault schema files
3. Configure `janitor.structural_only: false` to enable all stages

**Concurrency:** OpenClaw requires `concurrency: 1` due to session locking.

### Claude Code

Uses a single-call legacy approach: all issues for a sweep are sent to Claude in one agent invocation.

**Tradeoffs:** Less granular than pipeline mode, but works well for small vaults.

### Zo Computer

Uses a single-call legacy approach with snapshot/diff fallback for mutation tracking.

**Tradeoffs:** No per-file pipeline, but good for HTTP-based agent workflows.

## State & Logging

### State File

Janitor maintains state in `data/janitor_state.json`:

```json
{
  "processed_hashes": {},
  "last_sweep": "2026-02-23T10:30:00Z",
  "last_deep_sweep": "2026-02-22T08:00:00Z",
  "sweep_count": 42
}
```

**Purpose:** Tracks sweep history and timing. Can be deleted to force a fresh sweep.

### Log Files

- **Tool log:** `data/janitor.log` — daemon activity, scan results, error messages
- **Audit log:** `data/vault_audit.log` — append-only JSONL of every vault mutation

### Mutation Tracking

For CLI backends (Claude, OpenClaw), changes are tracked via session-scoped JSONL files:

```jsonl
{"op": "edit", "path": "person/John Smith.md", "fields_changed": ["status", "tags"]}
{"op": "edit", "path": "project/Alpha.md", "fields_changed": ["related"]}
```

**Location:** `vault/.mutations/{session-id}.jsonl`

## Vault Scope Rules

Janitor operates under the `janitor` scope, which allows:

- **Edit:** Modify frontmatter and body content
- **Delete:** Remove orphaned or invalid files
- **Move:** Rename files (via Obsidian CLI if available)

**Restricted:**
- **Create:** Cannot create new records (use Curator for that)

See `src/alfred/vault/scope.py` for full scope definitions.

## Common Workflows

### Daily Health Check

Run a light sweep every 5 minutes, deep sweep once per day:

```yaml
janitor:
  interval: 300
  deep_interval_hours: 24
  fix_mode: true
  structural_only: false
```

```bash
alfred up --only janitor
```

### Structural-Only Mode (No LLM)

Fast, free, frequent scans with no API costs:

```yaml
janitor:
  interval: 60
  structural_only: true
  fix_mode: true
```

```bash
alfred up --only janitor
```

### Manual Fix Run

Scan the vault once and apply fixes interactively:

```bash
# Review issues first
alfred janitor scan

# Apply fixes
alfred janitor fix
```

## Troubleshooting

### "No issues detected" but vault has problems

**Check:**
- Ensure records are in correct directories (type must match directory)
- Verify `KNOWN_TYPES` includes the record types in your vault
- Check `data/janitor.log` for scan errors

### Link repairs are incorrect

**Fix:**
- Stage 2 relies on LLM understanding of context
- Ensure the agent has access to `vault/CLAUDE.md` (schema documentation)
- For OpenClaw, verify the workspace includes vault schema files

### Orphan detection flags valid files

**Explanation:** ORPHAN detection only checks for incoming wikilinks. Hub files (dashboards, indexes) may legitimately have no incoming links.

**Solution:** Exclude specific files/directories from orphan checks (feature not yet implemented).

### Deep sweeps not running

**Check:**
- Verify `structural_only: false` in config
- Ensure agent backend is configured
- Check `last_deep_sweep` timestamp in `data/janitor_state.json`
- Review `data/janitor.log` for agent errors

## Related Tools

- **Curator:** Processes inbox files into structured vault records
- **Distiller:** Extracts latent knowledge from operational records
- **Surveyor:** Discovers semantic relationships via embeddings and clustering

See the main Alfred documentation for architecture and setup guides.
