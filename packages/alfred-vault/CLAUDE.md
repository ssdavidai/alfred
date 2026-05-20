# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Alfred is a Python monorepo containing four AI-powered tools for managing an Obsidian vault. All tools share one config (`config.yaml`), one CLI entry point (`alfred`), and common infrastructure.

| Tool | Purpose |
|------|---------|
| **Curator** | Watches `inbox/` and processes raw inputs into structured vault records |
| **Janitor** | Scans vault for structural issues (broken links, invalid frontmatter, orphans) and fixes them |
| **Distiller** | Extracts latent knowledge (assumptions, decisions, constraints) from operational records |
| **Surveyor** | Embeds vault content, clusters semantically, labels clusters, discovers relationships |

## Install & Run

```bash
# Base install (curator + janitor + distiller)
pip install -e .

# Full install (adds surveyor with ML/vector deps)
pip install -e ".[all]"

# Setup
cp config.yaml.example config.yaml
cp .env.example .env

# Run
alfred quickstart        # Interactive setup wizard
alfred up                # Start all daemons (background)
alfred up --foreground   # Stay attached (dev/debug)
alfred up --only curator,janitor  # Start selected daemons
alfred down              # Stop daemons
alfred status            # Per-tool status overview
```

There are no tests, linter, or CI configured.

## Architecture

### Source Layout

All code lives under `src/alfred/`. Each tool follows the same module pattern:
- `config.py` — typed dataclass config loaded from the tool's section in `config.yaml`
- `daemon.py` — async watcher/daemon entry point
- `state.py` — JSON-based state persistence (processed hashes, sweep history)
- `cli.py` — subcommand handlers
- `backends/__init__.py` — `BaseBackend` ABC, `BackendResult` dataclass, and prompt builder
- `backends/cli.py`, `http.py`, `openclaw.py` — concrete backend implementations

Shared infrastructure:
- `src/alfred/cli.py` — top-level argparse CLI dispatcher, all subcommand handlers
- `src/alfred/daemon.py` — background process spawn/stop via re-exec pattern (`alfred up` re-launches itself with `--_internal-foreground`)
- `src/alfred/orchestrator.py` — multiprocess daemon manager with auto-restart (max 5 retries)
- `src/alfred/_data.py` — `importlib.resources` locator for bundled skills/scaffold/examples

### Agent-Writes-Directly Pattern

Curator, Janitor, and Distiller delegate work to an AI agent backend. The agent receives a skill prompt (from `src/alfred/_bundled/skills/vault-{tool}/SKILL.md`) plus vault context, then reads/writes vault files via the `alfred vault` CLI. The tool's job is orchestration: detecting changes, invoking the agent, reading the mutation log, and updating state.

**Important flow:** For CLI backends (Claude Code, OpenClaw), each agent invocation gets environment variables (`ALFRED_VAULT_PATH`, `ALFRED_VAULT_SCOPE`, `ALFRED_VAULT_SESSION`) injected. The agent uses `alfred vault` commands (never direct filesystem access). Changes are tracked via a JSONL session file (`vault/mutation_log.py`). For the HTTP backend (Zo), a snapshot/diff fallback is used instead.

**Scope enforcement:** Each tool has a scope (`curator`, `janitor`, `distiller`) that restricts which vault operations the agent can perform. Defined in `vault/scope.py` with `SCOPE_RULES` dict. Curator can create/edit but not delete; janitor can edit/delete but not create; distiller can only create learning types.

Three pluggable backends in each tool's `backends/`: Claude Code (subprocess via `claude -p`), Zo Computer (HTTP API), OpenClaw (subprocess via `openclaw agent --message`). Selected via `agent.backend` in config.

### Each Tool's Backend Has Its Own Prompt Builder

Each tool's `backends/__init__.py` contains a different `build_*_prompt()` function tailored to that tool's needs. Curator sends inbox content + vault context. Janitor sends issue reports + affected records. Distiller sends source records + existing learning records for dedup. They are NOT shared — each tool has independent prompt assembly.

### Surveyor Pipeline

Surveyor doesn't use the agent backend. It has its own 4-stage pipeline:
1. **Embed** — vectorize vault records via Ollama (local) or OpenAI-compatible API (OpenRouter)
2. **Cluster** — HDBSCAN + Leiden community detection
3. **Label** — LLM labels clusters and suggests relationships (OpenRouter)
4. **Write** — writes cluster tags and relationship wikilinks back to vault

Vector store: Milvus Lite (file-based, `data/milvus_lite.db`).

### Bundled Data (`src/alfred/_bundled/`)

Shipped in the wheel. Located via `_data.py` using `importlib.resources`:
- `skills/vault-{curator,janitor,distiller}/SKILL.md` — full prompts with record type schemas, extraction rules, worked examples. Reference files in the same directory are inlined into the prompt at runtime.
- `scaffold/` — vault directory structure, Obsidian config, `_templates/` (per-type Markdown templates with `{{title}}`/`{{date}}` placeholders), `_bases/` (Dataview base views), starter views.

### Config Loading Pattern

Each tool has its own `config.py` with typed dataclasses. All follow the same pattern:
- `load_from_unified(raw: dict)` takes the pre-loaded unified config dict and builds the tool's config
- `_substitute_env()` replaces `${VAR}` placeholders with environment variables
- `_build()` recursively constructs dataclasses from nested dicts
- Config is loaded lazily in CLI handlers (not at import time)

### Vault Operations Layer (`src/alfred/vault/`)

- `ops.py` — CRUD operations (`vault_create`, `vault_read`, `vault_edit`, `vault_move`, `vault_delete`, `vault_search`, `vault_list`, `vault_context`). Integrates with Obsidian CLI (1.12+) when available for search and moves.
- `schema.py` — `KNOWN_TYPES` (20 entity types), `LEARN_TYPES` (5), `STATUS_BY_TYPE`, `TYPE_DIRECTORY`, `LIST_FIELDS`, `REQUIRED_FIELDS`, `NAME_FIELD_BY_TYPE`
- `scope.py` — per-tool operation restrictions
- `mutation_log.py` — session-scoped JSONL mutation tracking, audit log
- `obsidian.py` — optional Obsidian CLI integration
- `cli.py` — `alfred vault` subcommands (JSON output)

### State & Data

- Per-tool state: `data/{tool}_state.json` — tracks processed file hashes, sweep/run history
- Per-tool logs: `data/{tool}.log`
- Audit log: `data/vault_audit.log` — append-only JSONL of every vault mutation
- PID file: `data/alfred.pid` — for daemon management
- The vault itself is the source of truth; state files are just bookkeeping and can be deleted to force re-processing

### Execution Model

- Curator, Janitor, Distiller use `asyncio` for watcher loops and agent I/O
- `alfred up` uses `multiprocessing` to spawn one process per tool with auto-restart (max 5 retries, exit code 78 = missing deps, skip restart)
- `alfred up` (no flag) daemonizes via re-exec; `alfred down` uses sentinel file + SIGTERM
- Graceful shutdown via signal handling in `orchestrator.py`

## Key Config

`config.yaml` has sections: `vault`, `agent`, `logging`, `curator`, `janitor`, `distiller`, `surveyor`. Environment variables are substituted via `${VAR}` syntax. See `config.yaml.example` for all options.

## Vault Record Format

Records are Markdown files with YAML frontmatter. 20 entity types (person, org, project, task, etc.) plus 5 learning types (assumption, decision, constraint, contradiction, synthesis). Relationships use Obsidian wikilinks: `[[type/Record Name]]`. The full schema is in `scaffold/CLAUDE.md` and the skill files.
