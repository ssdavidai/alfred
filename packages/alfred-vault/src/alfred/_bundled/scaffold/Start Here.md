---
type: note
status: active
subtype: guide
name: Start Here
description: Overview of the Alfred OS vault — what it is, how it works, and how to set it up
created:
tags:
  - guide
  - overview
---

# Alfred OS — Your Operating System in Obsidian

## What Is This?

Alfred OS is a unified operational system built on Obsidian. It turns your vault into a connected workspace where an AI assistant ("Alfred") manages records, synthesizes briefings, and processes instructions.

Not a project management tool. Not a CRM. Not an email client. All of those things — unified, connected, and intelligent.

---

## Quick Setup

### 1. Create your Person record
Create a file in `person/` using the Person template. This is your identity in the system.

### 2. Set up your Home view
Open `view/Home.md` and set the `owner:` field to link to your Person record:
```yaml
owner: "[[person/Your Name]]"
```
The Home view's bases use `file.hasLink(this.file)` — once your Person record is linked, all your tasks, conversations, and sessions will appear here automatically.

### 3. Create your first Project
Use the Project template to create a record in `project/`. Fill in the frontmatter — at minimum, give it a `name:` and set an `owner:`.

### 4. Create a Task
Use the Task template. Set `project:` to link to your project and `assigned:` to link to your Person record. It will automatically appear in the project's Tasks view, your Home view, and the Task Manager.

### 5. Explore
Open your project page — the base views will show your task. Open your Person page — the same task appears there too. Open the Home view — it's there as well. Open the Task Manager — it's there too. One record, many views. No duplication.

---

## How It Works

### Everything is a Record

Every piece of work, every conversation, every person, every project — it's a record in the vault with structured metadata. Records link to each other via `[[wikilinks]]` in frontmatter. The graph connects everything.

**20 record types:**

| Type | What it is |
|------|-----------|
| **Project** | A development or initiative |
| **Task** | Something that needs doing |
| **Session** | An automatically detected work period with captured output |
| **Conversation** | An ongoing exchange (email, Zoom, in-person, chat) |
| **Input** | A single inbound item (email, voice note, doc) |
| **Person** | Someone you work with |
| **Org** | A company or entity |
| **Location** | A physical site or address |
| **Account** | A financial, service, or platform account |
| **Asset** | Software, hardware, license, domain, or equipment |
| **Note** | Knowledge, analysis, reference material |
| **Decision** | A recorded decision with context |
| **Process** | A repeatable workflow |
| **Run** | An instance of a process in progress |
| **Event** | A meeting, call, or milestone |
| **Assumption** | A tracked belief with confidence and evidence trail |
| **Constraint** | A regulatory, contractual, or physical limit |
| **Contradiction** | A documented conflict between two claims |
| **Synthesis** | An insight synthesized from multiple sources |

### Pages Build Themselves

Every project, person, and conversation page has **embedded base views** — tables that automatically show all connected records. Open any project and you'll see:

- **Tasks** across the project, with assignee, status, priority, due date
- **Sessions** where work happened
- **Conversations** — exchanges linked to the project (email, Zoom, chat, in-person)
- **Notes** created during sessions

These aren't manually maintained lists. They're live queries. Create a new task and link it to a project → it appears in the table automatically. The filter is simple: *show me everything that links to this file.* One pattern, every page.

### Three Building Blocks

Everything in this vault is built from combinations of three primitives:

**1. Structured Base Views** (`this.file` pattern)
Live tables embedded in any page. They query the vault in real time based on what links to the current file. No maintenance — the data IS the view.

**2. Alfred Dynamic Sections** (`<!-- ALFRED:DYNAMIC -->`)
Sections of a page that Alfred rewrites periodically with synthesized intelligence. Not raw data — judgment. "What happened overnight, what needs your attention, what's at risk."

**3. Alfred Instructions** (`alfred_instructions` property)
An inline command queue. Any record can have an `alfred_instructions` field. Type a natural language instruction — "transcribe this", "create a task", "draft a reply" — and Alfred picks it up, executes it, and updates the field. Zero friction, no context switching.

**Any page can combine all three.** A view might have live task tables + a morning briefing + an inbox where you issue instructions.

### Sessions Are Automatic

You don't manually start or stop sessions. A **session tracker worker** runs periodically and automatically detects bounded work periods from your activity — chats, task completions, file changes, meetings. It creates structured session records so nothing is lost.

Each detected session produces a folder. **Human work** goes in the person's folder, **Alfred work** goes in Alfred's folder:
```
YYYY/MM/DD/
├── alice/1400_brand-review-zoom/     # Alice's work
│   ├── session.md
│   ├── Task - Review brand mockups.md
│   └── Note - Zoom Notes.md
├── alfred/0300_inbox-processing/     # Alfred's work
│   ├── session.md
│   ├── Task - Follow up on contract.md
│   └── ...
└── inbox/                            # Inbound items
    └── Input - Bob re contract.md
```

Provenance is built into the path — you always know who created what and when. Sessions link to each other automatically via `resumes:` links.

---

## File Structure

```
alfred-os/
├── _templates/       # Record templates (one per type)
├── _bases/           # Base view definitions
├── _docs/            # Architecture documentation
├── view/             # Views (Home, CRM, Task Manager)
├── project/          # Project records
├── person/           # People records
├── org/              # Organisation records
├── location/         # Location records
├── conversation/     # Conversation records
├── process/          # Process definitions
├── account/          # Financial/service accounts
├── asset/            # Software, hardware, licenses
├── learn/            # Epistemic records
│   ├── assumption/   # Tracked beliefs
│   ├── constraint/   # Limits on action
│   ├── contradiction/# Conflicting claims
│   ├── decision/     # Explicit choices
│   └── synthesis/    # Synthesized insights
└── YYYY/MM/DD/       # Date-organized temporal work
    ├── {person}/     # Human session folders
    ├── alfred/       # Alfred session folders
    └── inbox/        # Inbound items
```

---

## Design Documents

For full technical detail:

- [[_docs/architecture]] — record types, linking patterns, base views, vault structure
- [[_docs/base-views]] — YAML syntax, filter functions, embedding, troubleshooting
- [[_docs/sessions]] — automated session detection and tracking
- [[_docs/inputs-and-conversations]] — multi-channel ingestion and conversation tracking
- [[_docs/alfred-instructions]] — the inline command queue pattern
- [[_docs/relationships]] — curator denormalization and the relationship graph

---

## The Core Insight

The competitive advantage isn't any single feature. It's that **everything is connected and everything is a record.** An email links to a conversation, which links to a project, which links to tasks assigned to people, which link to sessions where work happened. The graph grows with every interaction.

The system gets smarter every day. Not because of AI magic — because every piece of work that passes through it leaves a structured, connected, searchable trace.
