# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

This is an **Obsidian vault** — the Alfred OS canonical vault. It's a productized operational system built on Obsidian, where an AI assistant ("Alfred") manages records, synthesizes briefings, and processes instructions.

There are no build steps, tests, or linting commands. The vault is edited directly as markdown files with YAML frontmatter.

## Architecture

### Record Types (19 types, all markdown + YAML frontmatter)

Every file is a **record** with a `type` frontmatter property. The core types are: `project`, `task`, `session`, `conversation`, `input`, `person`, `org`, `location`, `note`, `decision`, `process`, `run`, `event`.

The **Learn system** adds 5 epistemic types: `assumption`, `constraint`, `contradiction`, `decision` (v2 via learn-decision template), `synthesis`. Each has its own top-level directory (e.g. `assumption/`, `decision/`). They track beliefs, limits, conflicts, choices, and synthesized insights with confidence levels and evidence chains.

**Resource types** `account` and `asset` track financial/service accounts and software/hardware/licenses. They integrate into person, org, and project views.

Each type has a **template** in `_templates/` defining its frontmatter schema and body structure.

### Three Building Blocks

1. **Base Views** (`_bases/*.base`) — YAML filter/sort definitions that Obsidian renders as live tables. Embedded in pages via `![[project.base#Tasks]]` syntax. The key pattern is `file.hasLink(this.file)` — "show me everything that links to the current file."

2. **Alfred Dynamic Sections** — Blocks wrapped in `<!-- ALFRED:DYNAMIC -->` / `<!-- END ALFRED:DYNAMIC -->` that Alfred rewrites periodically with synthesized intelligence (briefings, summaries, observations).

3. **Alfred Instructions** — The `alfred_instructions` frontmatter property on any record. Users type natural language commands; Alfred polls for pending instructions, executes them, and updates the field.

### File Organization

- `_templates/` — Record type templates (one per type)
- `_bases/` — Base view definitions (`.base` files with YAML filters/sorts)
- `view/` — Views (Home, CRM, Task Manager) combining base views + Alfred dynamic sections
- `project/`, `task/`, `person/`, `org/`, `location/`, `conversation/`, `process/`, `account/`, `asset/`, `event/`, `note/`, `run/`, `input/`, `session/` — Entity records by type
- `assumption/`, `constraint/`, `contradiction/`, `decision/`, `synthesis/` — Epistemic (learn) records
- `YYYY/MM/DD/` — Date-organized temporal content:
  - `inbox/` — Inbound items (emails, voice memos)
  - `{person}/HHMM_{slug}/` — Human session folders (session.md + tasks, notes, decisions)
  - `alfred/HHMM_{slug}/` — Alfred session folders (automated work — inbox processing, runs, session extraction)

### Key Conventions

- **Linking:** Records reference each other via `[[wikilinks]]` in frontmatter (e.g., `project: "[[project/My Project]]"`). The graph connects everything.
- **Status values vary by type:** tasks use `todo|active|blocked|done|cancelled`; projects use `active|paused|completed|abandoned|proposed`; inputs use `unprocessed|processed|deferred`; conversations use `active|waiting|resolved|closed|archived`.
- **Session folders** are the unit of work. Human work: `YYYY/MM/DD/{person}/HHMM_{slug}/`. Alfred work: `YYYY/MM/DD/alfred/HHMM_{slug}/`. Provenance is the folder path. Sessions are created automatically by the session tracker worker.
- **Base views use `this.file` pattern** — project pages, person pages, and views all embed the same base definitions; the `file.hasLink(this.file)` filter makes each page show only its own related records.
