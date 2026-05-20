# Distiller

Distiller is one of four AI-powered tools in Alfred that extracts latent knowledge from operational records and transforms it into a structured evidence graph. It reads conversations, session logs, project notes, and other vault content to identify and capture hidden insights that would otherwise remain buried in narrative text.

## Overview

Distiller operates on the principle that valuable knowledge often exists implicitly in operational records. Team assumptions, critical decisions, resource constraints, and contradictory information are frequently mentioned in passing but never formalized. Distiller surfaces these insights and creates dedicated learning records that form a queryable knowledge graph.

### What Distiller Does

- Scans vault records for signals of latent knowledge
- Extracts assumptions, decisions, constraints, contradictions, and syntheses
- Creates structured learning records with evidence links back to sources
- Performs cross-learning meta-analysis to detect patterns and conflicts
- Builds an evidence graph connecting learnings to their source records

### Two-Pass Pipeline

**Pass A: Per-Source Extraction**
Processes individual source records to extract learnings embedded in their content.

**Pass B: Cross-Learning Meta-Analysis**
Analyzes the complete learning graph to identify higher-order patterns, contradictions between decisions, shared assumptions across projects, and opportunities for synthesis.

## Learning Types

Distiller identifies five types of latent knowledge:

| Type | What it Captures | Example |
|------|------------------|---------|
| **assumption** | Beliefs the team operates on without explicit validation | "Timber prices will stay stable through Q2" |
| **decision** | Choices made with rationale and context | "Use REST over GraphQL for Acme API due to team familiarity" |
| **constraint** | Hard limits or boundaries identified during work | "Budget capped at $50k for Phase 1" |
| **contradiction** | Conflicting information across different sources | "Decision A recommends microservices but Decision B advocates for monolith" |
| **synthesis** | Patterns and connections across multiple observations | "Three separate projects converge on event-driven architecture" |

Each learning record includes:
- Confidence level (high/medium/low based on signal explicitness)
- Status (active, superseded, invalidated)
- Claim statement
- Evidence excerpt from source
- Links to source records
- Links to related entities (projects, people, organizations)

## Pass A: Per-Source Extraction

Pass A consists of four stages that transform raw vault content into structured learning records.

### Stage 0: Candidate Scanning (Pure Python)

Scans vault records for keyword signals indicating latent knowledge. Uses pattern matching to detect:
- Decision signals: "decided", "chose", "selected", "going with"
- Assumption signals: "assuming", "expect", "believe", "probably"
- Constraint signals: "limited to", "must", "cannot", "blocked by"
- Contradiction signals: "but", "however", "although", "conflict"
- Synthesis signals: "pattern", "trend", "consistently", "across"

Scores each candidate by signal density and recency. Only candidates exceeding `min_signal_score` are processed.

### Stage 1: Extract (LLM, per-source)

For each candidate source record:
1. LLM analyzes full content with context about learning types
2. Writes JSON manifest of discovered learnings to temp file
3. Each learning includes type, title, confidence, status, claim, evidence_excerpt, source_links, entity_links
4. 3-attempt retry logic handles manifest parsing failures

Confidence and status are calibrated by signal type:
- Explicit statements ("We decided to...") → high confidence, active status
- Implied or inferred learnings → low confidence, tentative status

### Stage 2: Dedup + Merge (Pure Python)

After extraction across all candidates:
1. Fuzzy title matching identifies duplicate learnings
2. Merges duplicates, preserving all source links
3. Tracks which sources contributed to each learning
4. Reports candidate count, merged count, and final deduplicated count

### Stage 3: Create Records (LLM, per-learning)

For each deduplicated learning:
1. Generates well-formed Markdown with YAML frontmatter
2. Creates record via `alfred vault create` command
3. Includes proper source links, entity links, and evidence sections
4. Follows vault schema conventions for learning types

## Pass B: Cross-Learning Meta-Analysis

Pass B analyzes the complete learning graph to discover higher-order insights.

### Meta-Analysis Capabilities

**Contradiction Detection**
Scans decisions and assumptions for conflicting claims. Creates contradiction records linking the conflicting learnings with analysis of the tension.

**Shared Assumption Analysis**
Identifies assumptions referenced across multiple projects or teams. Surfaces implicit dependencies and coordination risks.

**Pattern Synthesis**
Uses semantic clustering to group related learnings. Creates synthesis records that articulate patterns emerging across the evidence graph.

**Temporal Analysis**
Tracks how decisions evolve over time. Identifies superseded decisions and validates whether assumptions held true.

### Clustering Method

Pass B uses semantic embeddings to cluster learnings by conceptual similarity rather than keyword matching. This reveals non-obvious connections between learnings from different domains.

## Configuration

Distiller is configured in the `distiller` section of `config.yaml`:

```yaml
distiller:
  enabled: true
  interval: 300                    # Light scan interval (seconds)
  deep_interval_hours: 24          # Deep extraction interval (hours)
  min_signal_score: 3              # Minimum score for candidate processing
  batch_size: 10                   # Max candidates per extraction run
  pass_b_enabled: true             # Enable meta-analysis
```

### Agent Backend

Distiller uses the same agent backend configuration as other Alfred tools (`agent.backend` in `config.yaml`). Supports Claude Code, Zo Computer (HTTP), and OpenClaw backends.

## CLI Commands

### Scan for Candidates

```bash
alfred distiller scan
```

Performs keyword-based scanning to identify records containing extraction signals. Reports candidate count and score distribution without performing extraction.

### Run Extraction

```bash
alfred distiller run
```

Executes full extraction pipeline:
1. Scans for candidates
2. Extracts learnings from candidates
3. Deduplicates and merges
4. Creates vault records
5. Optionally runs Pass B meta-analysis

### Watch Mode (Daemon)

```bash
alfred distiller watch
```

Runs periodic extraction in foreground:
- Light scans every `interval` seconds
- Deep extraction every `deep_interval_hours` hours
- Continues until interrupted

### Background Daemon

```bash
alfred up --only distiller
```

Starts Distiller as a background daemon with auto-restart. Use `alfred down` to stop.

### Check Status

```bash
alfred status
```

Shows Distiller daemon status, last extraction time, and learning record counts.

## State Tracking

Distiller maintains state in `data/distiller_state.json`:

```json
{
  "processed_sources": {
    "conversation/weekly-sync-2024-01-15": "abc123hash",
    "session/project-kickoff": "def456hash"
  },
  "last_scan": "2024-01-20T10:30:00Z",
  "last_deep_run": "2024-01-20T08:00:00Z",
  "extraction_history": [...]
}
```

Source records are tracked by content hash. When a source is modified, it becomes eligible for re-extraction.

## Vault Scope

Distiller operates under the `distiller` scope defined in `vault/scope.py`:

**Allowed Operations:**
- Create learning records (assumption, decision, constraint, contradiction, synthesis)
- Read any vault record for context
- Edit existing learning records to add sources or update status

**Prohibited Operations:**
- Create non-learning records
- Delete any records
- Move or rename records

This scope ensures Distiller can build the learning graph without affecting operational records.

## Workflow Example

### Initial Extraction

```bash
# Scan vault for extraction candidates
alfred distiller scan

# Output:
# Found 42 candidates across 120 vault records
# Top candidates:
#   - conversation/architecture-debate (score: 8.5)
#   - session/budget-planning (score: 7.2)
#   - project/acme-api-design (score: 6.8)

# Run extraction
alfred distiller run

# Output:
# Stage 1: Extracted 23 learnings from 15 sources
# Stage 2: Merged 5 duplicates → 18 unique learnings
# Stage 3: Created 18 learning records
# Pass B: Identified 2 contradictions, created 1 synthesis
```

### Continuous Operation

```bash
# Start as background daemon
alfred up --only distiller

# Check status
alfred status

# Output:
# Distiller: running (PID 12345)
#   Last scan: 2 minutes ago
#   Last deep extraction: 6 hours ago
#   Learning records: 127 total (45 decisions, 38 assumptions, ...)
```

## Integration with Other Tools

### With Curator
Curator creates operational records that become extraction sources for Distiller. As new conversations, sessions, and observations flow into the vault, Distiller automatically processes them for latent knowledge.

### With Janitor
Janitor ensures learning records maintain proper links and frontmatter. If source records are moved or renamed, Janitor updates the references in learning records.

### With Surveyor
Surveyor's semantic clustering complements Distiller's Pass B meta-analysis. Surveyor can identify conceptually similar learnings across the vault and suggest relationship links that Distiller can analyze for contradictions or synthesis opportunities.

## Best Practices

### Signal Quality

Configure `min_signal_score` based on vault size and signal quality:
- Small vaults (< 500 records): score 2-3 catches most candidates
- Large vaults (> 1000 records): score 4-5 focuses on high-confidence signals
- Noisy vaults: score 6+ for precision over recall

### Extraction Frequency

Balance extraction frequency against vault activity:
- High-activity vaults: `interval: 300` (5 minutes), `deep_interval_hours: 12`
- Low-activity vaults: `interval: 1800` (30 minutes), `deep_interval_hours: 48`
- Ad-hoc extraction: Disable daemon, run `alfred distiller run` manually

### Source Record Quality

Distiller works best on narrative content with explicit reasoning:
- Meeting notes with decision rationale
- Project retrospectives
- Architecture discussions
- Planning documents with constraints

Short, factual records (contacts, tasks) typically yield few learnings.

### Learning Record Maintenance

Review and refine extracted learnings periodically:
- Update status field when assumptions are validated or invalidated
- Link related learnings to build evidence chains
- Add entity links to connect learnings to relevant projects/people
- Mark superseded decisions to maintain decision history

## Troubleshooting

### No Candidates Found

**Symptom:** `alfred distiller scan` reports 0 candidates

**Solutions:**
- Lower `min_signal_score` threshold
- Check that vault contains narrative content (not just structured entities)
- Review `data/distiller_state.json` — already-processed sources won't re-appear
- Manually trigger re-extraction by removing entries from `processed_sources`

### Extraction Failures

**Symptom:** Stage 1 or Stage 3 consistently fails

**Solutions:**
- Check `data/distiller.log` for LLM errors
- Verify agent backend is configured correctly
- Reduce `batch_size` to avoid rate limits
- Check that vault `CLAUDE.md` is in agent workspace (OpenClaw backend)

### Duplicate Learnings

**Symptom:** Similar learnings created with slightly different titles

**Solutions:**
- Stage 2 dedup uses fuzzy matching — very similar titles should merge
- Review merge threshold in code if needed
- Manually merge duplicates in vault and link to all sources

### Performance Issues

**Symptom:** Extraction takes too long or times out

**Solutions:**
- Reduce `batch_size` to process fewer candidates per run
- Increase `interval` to run less frequently
- Use faster backend (OpenClaw is typically faster than HTTP for serial processing)
- Consider extracting from specific sources manually rather than full scans

## Architecture Notes

### Agent-Writes-Directly Pattern

Distiller uses Alfred's agent-writes-directly pattern: the LLM agent receives vault context and creates learning records via `alfred vault create` commands. Changes are tracked through the mutation log (`vault/mutation_log.py`).

### Backend Independence

Distiller works with all three agent backends (Claude Code, Zo Computer, OpenClaw). The prompt builder (`backends/__init__.py`) handles backend-specific formatting, but the extraction pipeline is backend-agnostic.

### State Management

State files are bookkeeping only — the vault is the source of truth. You can safely delete `data/distiller_state.json` to force re-processing of all sources.

---

**See Also:**
- [Curator](Curator.md) — Processes inbox inputs into vault records
- [Janitor](Janitor.md) — Maintains vault structural integrity
- [Surveyor](Surveyor.md) — Semantic clustering and relationship discovery
- [Vault Schema](Vault-Schema.md) — Complete record type reference
