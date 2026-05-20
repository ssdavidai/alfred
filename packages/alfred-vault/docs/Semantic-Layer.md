# Semantic Layer

The Semantic Layer is Alfred's knowledge graph — an Obsidian vault that serves as a single source of truth and operational memory for both humans and agents.

## What Makes It Different

Most AI systems store memory in databases, vector stores, or proprietary formats. Alfred uses an Obsidian vault: Markdown files with YAML frontmatter, linked with wikilinks, browseable in Obsidian, and version-controlled with git.

This means:
- **Human-readable** — open any record in Obsidian (or any text editor) and understand it immediately
- **Agent-writable** — agents create and modify records via `alfred vault` CLI with scope enforcement
- **Wikilinked** — relationships are explicit `[[wikilinks]]`, not hidden in a database
- **Versioned** — git tracks every change; you can see what the agent did and revert if needed
- **Queryable** — Obsidian's Dataview plugin gives you live tables, charts, and dashboards

## The Four Workers

Four specialized workers maintain the vault continuously. Each has a defined scope — what it can and cannot do:

### Curator — Inbox to Structure

Watches `inbox/` for new files. When a file appears, the Curator reads it, passes it to an AI agent with full vault context, and the agent creates whatever records the content calls for.

A meeting transcript becomes: a conversation record, person records for participants, task records with assignees, and wikilinks connecting everything.

**Scope:** Create, Edit (no Delete)

See [Curator](Curator) for pipeline details.

### Janitor — Entropy to Order

Periodically sweeps the vault for structural problems:
- Broken wikilinks pointing to non-existent records
- Invalid or incomplete YAML frontmatter
- Orphaned files with no incoming links
- Stub records with minimal content

In fix mode, hands issues to the AI agent to repair automatically.

**Scope:** Edit, Delete (no Create)

See [Janitor](Janitor) for pipeline details.

### Distiller — Notes to Knowledge

Reads operational records (conversations, sessions, project notes) and surfaces latent knowledge:
- **Assumptions** — beliefs the team is operating on
- **Decisions** — choices made but never formally documented
- **Constraints** — limits mentioned in passing (regulatory, budget, technical)
- **Contradictions** — conflicting information across records
- **Syntheses** — patterns emerging from multiple sources

These form an evidence graph that evolves with your vault.

**Scope:** Create learning types only (no Edit, no Delete)

See [Distiller](Distiller) for pipeline details.

### Surveyor — Isolation to Connection

Embeds vault content into vectors, clusters by semantic similarity, and writes relationship tags back:

1. **Embed** — vectorize records via Ollama (local) or OpenAI-compatible API
2. **Cluster** — HDBSCAN on embeddings + Leiden community detection on wikilink graph
3. **Label** — LLM labels clusters and suggests relationships
4. **Write** — applies tags and wikilinks back to records

Three notes about the same theme that you never connected? Surveyor finds them.

**Scope:** Tag, Link (ML pipeline, no agent backend)

See [Surveyor](Surveyor) for pipeline details.

## Record Types

19 record types across three categories:

| Category | Types |
|----------|-------|
| **Operational** | project, task, session, conversation, input, note, process, run, event |
| **Entity** | person, org, location, account, asset |
| **Epistemic** | assumption, decision, constraint, contradiction, synthesis |

Each record is a Markdown file with YAML frontmatter containing typed fields (status, related records, dates). Relationships use Obsidian wikilinks: `[[type/Record Name]]`.

See [Vault Schema](Vault-Schema) for the complete field reference.

## Use Cases

### Task Manager

Drop meeting transcripts into inbox. The Curator extracts tasks, assigns them to people, links them to projects, and maintains status. Open a project page in Obsidian and see live Dataview tables of all related tasks, conversations, and people.

### CRM

Every conversation creates or updates person and org records. Relationships, interactions, and context accumulate automatically. Your vault becomes a relationship graph — open a person's page and see every conversation, task, and project they're connected to.

### Knowledge Base

The Distiller surfaces assumptions your team operates on, decisions that were made in passing, and contradictions between records. The Surveyor finds semantic clusters across hundreds of records. Together they build an evidence graph that evolves with your work.

## Vault Operations

All vault mutations go through the `alfred vault` CLI, which enforces scope restrictions and tracks changes:

```bash
alfred vault create <type> <name>    # create a record
alfred vault read <path>             # read a record (JSON output)
alfred vault edit <path>             # edit frontmatter/body
alfred vault list [type]             # list records
alfred vault search --grep "term"    # full-text search
alfred vault search --glob "*.md"    # pattern search
```

Every write operation is logged to a session file (per-invocation) and the audit log (`data/vault_audit.log`). This means every change is traceable — you always know what the agent did and when.

## Running the Workers

```bash
# Start all workers as background daemons
alfred up

# Start specific workers only
alfred up --only curator,janitor

# Interactive mode with live dashboard
alfred up --live

# Individual worker commands
alfred curator                    # curator daemon (foreground)
alfred janitor scan               # scan only (no fixes)
alfred janitor fix                # scan + AI fix
alfred distiller run              # scan + extract
alfred surveyor                   # full ML pipeline
```

Workers write state to `data/{tool}_state.json`. Deleting a state file forces re-processing — the vault itself is always the source of truth.
