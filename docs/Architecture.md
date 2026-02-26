# Architecture

Alfred is a layered agentic architecture. Each layer has a distinct responsibility and can be understood, configured, and extended independently.

```
 Interface     Where you interact (Telegram, Slack, CLI, TUI, ...)
     |
   Agent        The AI that reasons (Claude Code, Zo, OpenClaw)
     |
  Kinetic       The engine that executes (Temporal workflows)
     |
 Semantic       The memory that persists (Obsidian vault + workers)
     |
   Data          The pipelines that capture (Omi, meetings, email, ...)
     |
   Infra         Where it all runs (Mac Mini, VPS, personal cloud)
```

## Layer Overview

### Infra Layer

Alfred runs anywhere you trust your data. There is no cloud dependency — everything is self-hosted by default.

- **Mac Mini / local machine** — simplest setup, good for personal use
- **VPS** — Hetzner, DigitalOcean, AWS, Linode — for always-on availability
- **Personal cloud** — Zo Computer — managed hosting with agent runtime included

### Data Layer

Pipelines that capture raw signal and feed it into the Semantic Layer's inbox for processing:

- **Omi wearable** — ambient conversation transcripts, processed into vault records automatically
- **Meeting integrations** — Zoom, Sembly AI, other transcript sources
- **Email digests** — forwarded or piped into inbox
- **Bulk imports** — `alfred ingest` splits ChatGPT/Anthropic conversation exports into individual inbox files
- **API webhooks** — anything that can write a file to `inbox/`

The Data Layer is extensible — any source that can produce a text file can feed Alfred.

### Semantic Layer

The Obsidian vault is a living knowledge graph — human-readable, agent-writable, wikilinked, and versioned. It serves as both the agent's operational memory and the human's second brain.

Four specialized workers maintain the vault continuously:

| Worker | Scope | Function |
|--------|-------|----------|
| **[Curator](Curator)** | Create, Edit | Processes inbox files into structured, interlinked records |
| **[Janitor](Janitor)** | Edit, Delete | Detects and repairs structural issues (broken links, orphans, invalid frontmatter) |
| **[Distiller](Distiller)** | Create (learning types) | Extracts latent knowledge: assumptions, decisions, constraints, contradictions |
| **[Surveyor](Surveyor)** | Tag, Link | Embeds, clusters, labels, and writes semantic relationship tags |

Each worker has **scope enforcement** — the Curator can create and edit but not delete; the Janitor can edit and delete but not create; the Distiller can only create learning-type records. This prevents any single worker from having unconstrained write access.

19 record types across three categories:
- **Operational**: project, task, session, conversation, input, note, process, run, event
- **Entity**: person, org, location, account, asset
- **Epistemic**: assumption, decision, constraint, contradiction, synthesis

See [Vault Schema](Vault-Schema) and [Semantic Layer](Semantic-Layer) for details.

### Kinetic Layer

A Temporal-based execution engine that orchestrates agent work as durable workflows. Workflows survive crashes, can sleep for days, and resume with full state.

Key components:
- **Activities** — `spawn_agent`, `run_script`, `notify_slack`, `ping_uptime`, `check_day_of_week`, `load_json_state`, `save_json_state`
- **Discovery** — scans configured directories for `@workflow.defn` classes
- **Schedules** — register cron-based schedules from Python definition files
- **Worker** — connects to Temporal server, runs workflows + activities with health watchdog

The core principle: **Python handles control flow, the agent handles reasoning.** A workflow loops through emails, but for each email it calls `spawn_agent` with a single atomic prompt. The agent never orchestrates — it only executes.

See [Kinetic Layer](Kinetic-Layer) for details.

### Agent Layer

Three pluggable backends that implement the same interface (`process(prompt, vault_path) -> result`):

| Backend | Type | Best for |
|---------|------|----------|
| **Claude Code** | Subprocess (`claude -p`) | Default, works out of the box |
| **Zo Computer** | HTTP API | Cloud-based, managed |
| **OpenClaw** | Subprocess (`openclaw agent`) | Multi-stage pipelines, multi-channel interface |

The Kinetic Layer supports per-workflow agent profiles — different workflows can use different backends, skills, and scopes.

See [Agent Backends](Agent-Backends) for setup details.

### Interface Layer

The interface is typically provided by your agent runtime, not by Alfred directly:

| Runtime | Channels |
|---------|----------|
| **OpenClaw** | Telegram, WhatsApp, Slack, iMessage, Discord, Signal |
| **Zo Computer** | Telegram, SMS, email |
| **Local** | CLI (`alfred`), TUI dashboard (`alfred tui`), Claude Code |

Alfred's CLI and TUI serve as the local interface for configuration, monitoring, and direct commands.

---

## Design Patterns

### Agent-Writes-Directly

Semantic layer workers delegate work to an AI agent backend. The agent receives a skill prompt plus vault context, then reads/writes vault files via the `alfred vault` CLI. The worker's job is orchestration: detecting changes, invoking the agent, reading the mutation log, and updating state.

Each agent invocation gets environment variables injected:
- `ALFRED_VAULT_PATH` — path to the vault
- `ALFRED_VAULT_SCOPE` — worker scope (restricts operations)
- `ALFRED_VAULT_SESSION` — mutation log session file

### Pipeline vs Legacy Mode

The multi-stage pipelines (Curator 4-stage, Janitor 3-stage, Distiller 2-pass) currently only work with the OpenClaw backend. Claude Code and Zo backends fall back to a legacy single-call mode where one agent call handles everything.

### Config Loading

Each component has its own `config.py` with typed dataclasses. All follow the same pattern:
1. `load_from_unified(raw: dict)` takes the pre-loaded unified config
2. `_substitute_env()` replaces `${VAR}` placeholders
3. `_build()` recursively constructs dataclasses
4. Config loaded lazily in CLI handlers (not at import time)

---

## Source Layout

```
src/alfred/
  cli.py               # Top-level argparse CLI dispatcher
  daemon.py            # Background process spawn/stop (re-exec pattern)
  orchestrator.py      # Multiprocess daemon manager with auto-restart
  quickstart.py        # Interactive setup wizard
  _data.py             # Bundled resource locator (importlib.resources)

  curator/             # Semantic layer — inbox processor
  janitor/             # Semantic layer — vault quality
  distiller/           # Semantic layer — knowledge extraction
  surveyor/            # Semantic layer — semantic mapping

  temporal/            # Kinetic layer — workflow execution engine
    config.py          # TemporalConfig, AgentProfile, TemporalRuntime
    activities.py      # AlfredActivities (spawn_agent, run_script, etc.)
    worker.py          # Worker startup, health watchdog
    discovery.py       # Scan directories for @workflow.defn classes
    schedules.py       # Schedule registration/listing
    cli.py             # CLI handlers for alfred temporal

  vault/               # Vault operations layer
    ops.py             # CRUD operations
    schema.py          # Record types, status values, field definitions
    scope.py           # Per-worker operation restrictions
    mutation_log.py    # Session-scoped JSONL mutation tracking
    cli.py             # alfred vault subcommands

  _bundled/            # Data files shipped in the wheel
    skills/            # Per-worker skill prompts
    scaffold/          # Vault directory scaffolding
    examples/          # Example Temporal workflows
    tui_js/            # Bundled Ink TUI
```

## Execution Model

### Semantic Layer Daemons (`alfred up`)

- `alfred up` uses `multiprocessing` to spawn one process per worker
- `orchestrator.py` manages auto-restart (max 5 retries, exit code 78 = missing deps)
- `orchestrator.py` writes `data/workers.json` every 2s (consumed by TUI)
- Daemon mode via re-exec pattern; `alfred down` uses sentinel file + SIGTERM

### Kinetic Layer Worker (`alfred temporal worker`)

- Connects to Temporal server, registers discovered workflows + built-in activities
- Health watchdog probes server every 60s, exits after 5 consecutive failures
- One worker process handles all workflows on the configured task queue

### State & Mutation Tracking

- Per-worker state files: `data/{tool}_state.json` — tracks processed file hashes, history
- Audit log: `data/vault_audit.log` — append-only JSONL of every vault mutation
- Session files: per-invocation JSONL for mutation tracking
- The vault itself is the source of truth — state files are just bookkeeping
