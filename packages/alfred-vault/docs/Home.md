# Alfred

**Personal agentic infrastructure. Self-hosted. Always on.**

Alfred is a self-hosted agentic butler — a layered AI architecture that captures your data, maintains your knowledge, executes your workflows, and communicates on your behalf. It runs continuously on your own infrastructure, so your AI doesn't just respond when prompted — it observes, thinks, acts, and learns.

## The Six Layers

| Layer | What it is | Alfred components |
|-------|-----------|-------------------|
| **[Interface](Interface-Layer)** | Where you interact | Telegram, WhatsApp, Slack, iMessage, SMS, email, CLI, TUI |
| **[Agent](Agent-Backends)** | The AI that reasons | Claude Code, Zo Computer, OpenClaw — pluggable backends |
| **[Kinetic](Kinetic-Layer)** | The engine that executes | Temporal workflows — durable, scheduled, auditable |
| **[Semantic](Semantic-Layer)** | The memory that persists | Obsidian vault — human-readable, agent-writable knowledge graph |
| **Data** | The pipelines that capture | Omi transcripts, meetings, emails, RSS — raw signal in, structured knowledge out |
| **Infra** | Where it all runs | Mac Mini, VPS, personal cloud — your data, your control |

## Quick Start

```bash
pip install alfred-vault
alfred quickstart
alfred up
```

Drop a file into your vault's `inbox/` folder and watch the Curator process it into structured, interlinked records.

## Quick Navigation

**Getting Started**
- [Installation](Installation)
- [Configuration](Configuration)
- [User Profile](User-Profile)

**Architecture**
- [Six-Layer Architecture](Architecture)
- [Semantic Layer](Semantic-Layer) — vault as knowledge graph
- [Kinetic Layer](Kinetic-Layer) — Temporal workflow engine
- [Agent Backends](Agent-Backends) — Claude Code, Zo, OpenClaw

**Semantic Layer Workers**
- [Curator](Curator) — inbox processing (4-stage pipeline)
- [Janitor](Janitor) — vault quality (3-stage pipeline)
- [Distiller](Distiller) — knowledge extraction (2-pass pipeline)
- [Surveyor](Surveyor) — semantic mapping (4-stage pipeline)

**Reference**
- [CLI Commands](CLI-Commands)
- [Vault Schema](Vault-Schema)
- [Live Dashboard](Live-Dashboard)
