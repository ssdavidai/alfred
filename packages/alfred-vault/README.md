<div align="center">

# Alfred

**The agent you can forget about.**

Turn any agentic runtime into an ambient butler that manages your digital life — so you can be present for the rest of it.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-green.svg)](https://python.org)
[![PyPI](https://img.shields.io/pypi/v/alfred-vault.svg)](https://pypi.org/project/alfred-vault/)

</div>

---

200 emails on Tuesday. Alfred surfaced 1 that actually required attention.

A meeting transcript dropped into the inbox at 3pm. By 3:02, Alfred had created the conversation record, updated three people records, filed two tasks under the right project, and linked everything together. Nobody asked for this. Nobody prompted anything. It just happened.

That night, Alfred noticed two records in the vault contradicted each other and flagged it. Fixed three broken links. Discovered a cluster of notes about the same theme that were never connected. Wrote the relationships. By morning, the knowledge graph was richer than when everyone went home.

**This is what a butler does.** Not just tasks when asked. Anticipatory attention. Owning things so you don't have to hold them in your head.

---

## What is Alfred?

Alfred connects to your agentic runtime — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenClaw](https://openclaw.com), or [Zo Computer](https://zo.computer) — and turns it into a butler you set up once and forget about.

It does three things:

**1. It maintains a knowledge graph that never goes stale.**
An Obsidian vault with 20 structured record types, wikilinked together, readable by both you and your agents. Four background workers — Curator, Janitor, Distiller, Surveyor — continuously process, clean, extract, and connect. The vault is your agent's operational memory and your second brain. Same artifact.

**2. It executes durable workflows on your behalf.**
A Temporal-based engine that runs scheduled and triggered operations. Daily briefings. Inbox processing. Vault health sweeps. If it crashes, it picks up where it left off. Write workflows in Python — the agent handles reasoning, Python handles control flow.

**3. It meets you where you already are.**
Telegram. WhatsApp. Slack. iMessage. Email. CLI. Whatever channels your runtime supports. Not another app to check — the butler comes to you.

The goal isn't to talk to your AI more. The goal is to **prompt less and live more.**

---

## Get Started

```bash
pip install alfred-vault
alfred quickstart
alfred up
```

Three commands. Drop a file into `inbox/` and it's handled.

---

## The Four Workers

Alfred's semantic layer — four specialized workers that maintain your vault around the clock:

| | |
|---|---|
| **Curator** | Watches `inbox/`. Turns raw files — transcripts, emails, voice memos — into structured, interlinked records. Creates people, tasks, conversations, projects. Links everything. |
| **Janitor** | Sweeps for entropy. Broken wikilinks, invalid frontmatter, orphaned files, stub records. Fixes them automatically. |
| **Distiller** | Reads your operational records and surfaces what's implicit — assumptions, decisions, constraints, contradictions. Builds an evidence graph that evolves with your vault. |
| **Surveyor** | Embeds your vault into vectors, clusters by semantic similarity, and writes relationship tags back. Finds connections you'd never spot manually. |

Each worker has **scope enforcement** — the Curator can create but not delete, the Janitor can delete but not create, the Distiller can only create learning records. No single worker has unconstrained access.

## Workflow Engine

The kinetic layer — durable, scheduled execution powered by [Temporal](https://temporal.io):

```bash
alfred temporal worker                    # start the worker
alfred temporal run DailyBriefing         # trigger a workflow
alfred temporal schedule register crons.py  # register schedules
```

Built-in activities: `spawn_agent`, `run_script`, `notify_slack`, `load_json_state`, `save_json_state`, and more. Per-workflow agent profiles — different workflows can use different backends, skills, and scopes.

## Agent Backends

Alfred doesn't contain an AI — it plugs into one:

| Backend | Type | Setup |
|---------|------|-------|
| **Claude Code** | Subprocess | Default. `claude` on PATH |
| **Zo Computer** | HTTP API | Set `ZO_API_KEY` |
| **OpenClaw** | Subprocess | `openclaw` on PATH. Multi-stage pipelines. |

Switch backends in config. No rewiring. The butler adapts to whichever runtime you run.

---

## Architecture

Six layers, each independent:

```
 Interface     Telegram · WhatsApp · Slack · iMessage · email · CLI · TUI
     |
   Agent        Claude Code · Zo Computer · OpenClaw
     |
  Kinetic       Temporal — durable, scheduled workflow execution
     |
 Semantic       Obsidian vault — knowledge graph for humans and agents
     |
   Data          Omi · Zoom · email · RSS — ambient capture pipelines
     |
   Infra         Mac Mini · VPS · personal cloud — your hardware, your data
```

**Infra** — Runs on a Mac Mini under your desk, a Hetzner VPS, or a Zo Computer instance. Self-hosted. Your data never leaves your control.

**Data** — Anything that produces text can feed the inbox. Omi wearable transcripts, Zoom recordings, email digests, bulk conversation exports (`alfred ingest`).

**Semantic** — The Obsidian vault. 20 record types, YAML frontmatter, wikilinks. Maintained by four workers. Not a database — a browseable, versioned, git-tracked knowledge base.

**Kinetic** — Temporal workflows. Cron schedules, one-off triggers, durable execution. Crashes don't lose state. The agent sleeps for days and resumes with full context.

**Agent** — Pluggable AI backends. Per-workflow profiles. The butler delegates reasoning to whichever model you trust.

**Interface** — Governed by your runtime. OpenClaw routes Telegram, WhatsApp, Slack, iMessage, Discord, Signal. Zo routes Telegram, SMS, email. Locally: `alfred` CLI and `alfred tui` dashboard.

---

## Install

```bash
pip install alfred-vault                    # core workers
pip install "alfred-vault[temporal]"        # + workflow engine
pip install "alfred-vault[all]"             # everything
```

<details>
<summary>From source</summary>

```bash
git clone https://github.com/ssdavidai/alfred.git
cd alfred && pip install -e ".[all]"
```
</details>

## CLI

```bash
alfred up                              # start workers (background)
alfred down                            # stop
alfred status                          # overview
alfred tui                             # live dashboard

alfred temporal worker                 # start workflow worker
alfred temporal run <workflow>         # trigger a workflow
alfred temporal schedule register <f>  # register cron schedules

alfred vault create <type> <name>      # create record
alfred vault list [type]               # list records
alfred process                         # batch-process inbox
alfred ingest <file>                   # import conversation export
```

## Documentation

[GitHub Wiki](https://github.com/ssdavidai/alfred/wiki) · [Architecture](docs/Architecture.md) · [Semantic Layer](docs/Semantic-Layer.md) · [Kinetic Layer](docs/Kinetic-Layer.md) · [Agent Backends](docs/Agent-Backends.md)

[Curator](docs/Curator.md) · [Janitor](docs/Janitor.md) · [Distiller](docs/Distiller.md) · [Surveyor](docs/Surveyor.md) · [Vault Schema](docs/Vault-Schema.md) · [CLI Commands](docs/CLI-Commands.md)

## Contributing

Early-stage, actively developed. Issues, PRs, and ideas welcome.

## License

[MIT](LICENSE) · Built by [David Szabo-Stuban](https://screenlessdad.com)
