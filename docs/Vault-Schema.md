# Vault Schema

Alfred organizes vault records into 19 entity types plus 5 learning types. All records are Markdown files with YAML frontmatter and are linked together with Obsidian `[[wikilinks]]`.

## Record Types

### Operational Records

| Type | Directory | Purpose | Key Fields |
|------|-----------|---------|------------|
| `project` | `project/` | Bounded initiative with a goal | status, client, owner, parent, location |
| `task` | `task/` | Action item or to-do | status, project, assignee, due_date |
| `session` | `session/` | Work session log | status, project, participants |
| `conversation` | `conversation/` | Multi-turn exchange (meeting, chat, email) | status, participants, project |
| `input` | `input/` | External input (email, document, form) | status, source, project |
| `note` | `note/` | Free-form note or analysis | status, project, subtype |
| `process` | `process/` | Repeatable workflow or procedure | status, owner |
| `run` | `run/` | Instance of a process execution | status, process, project |
| `event` | `event/` | Scheduled or past event | status, date, location, participants |

### Entity Records

| Type | Directory | Purpose | Key Fields |
|------|-----------|---------|------------|
| `person` | `person/` | Individual person | status, org, role, email |
| `org` | `org/` | Organization or company | status, org_type |
| `location` | `location/` | Physical place | status, address |
| `account` | `account/` | Service account or subscription | status, provider, org |
| `asset` | `asset/` | Physical or digital asset | status, owner, location |

### Learning Records (Epistemic)

| Type | Directory | Purpose | Key Fields |
|------|-----------|---------|------------|
| `assumption` | `assumption/` | Belief being operated on | status, confidence, claim, evidence_excerpt |
| `decision` | `decision/` | Choice made with rationale | status, confidence, claim, evidence_excerpt |
| `constraint` | `constraint/` | Hard limit identified | status, confidence, claim, evidence_excerpt |
| `contradiction` | `contradiction/` | Conflicting information | status, confidence, claim, evidence_excerpt |
| `synthesis` | `synthesis/` | Pattern connecting multiple observations | status, confidence, claim, evidence_excerpt |

## Status Values

Each record type has a defined set of valid statuses:

| Types | Valid Statuses |
|-------|---------------|
| project | `active`, `paused`, `completed`, `abandoned`, `proposed` |
| task | `todo`, `in-progress`, `done`, `blocked`, `cancelled` |
| session, run | `active`, `completed` |
| conversation | `active`, `waiting`, `resolved`, `closed`, `archived` |
| person, org, location, account, asset | `active`, `inactive` |
| assumption, constraint | `active`, `retired`, `superseded` |
| decision | `final`, `draft`, `superseded`, `reversed` |
| contradiction | `unresolved`, `resolved` |
| synthesis | `draft`, `final` |

## Required Fields

Every record must have:
- `type` — the record type (one of the 19 types above)
- `name` (or type-specific name field like `subject` for decisions) — the record title
- `status` — current status
- `created` — ISO date of creation

## Relationship Fields

Records connect through multiple relationship types:

| Field | Type | Purpose |
|-------|------|---------|
| `related` | list | General relationships (`[[type/Name]]`) |
| `relationships` | list | Typed relationships (added by surveyor) |
| `supports` | list | What this record enables |
| `based_on` | list | Assumptions/decisions this rests on |
| `depends_on` | list | Operational prerequisites |
| `blocked_by` | list | Active blockers |
| `approved_by` | list | Authority chain (person links) |

All relationship values use wikilink syntax: `[[type/Record Name]]`

## Templates

Each record type has a template in the vault's `_templates/` directory. Templates define:

1. **Default frontmatter** — all fields with sensible defaults
2. **Body structure** — heading, description placeholder
3. **Base-view embeds** — Dataview sections like `![[project.base#Tasks]]`

When a record is created (via `alfred vault create` or the curator pipeline), the template is automatically applied. Even when custom body content is provided, base-view embeds are preserved and appended.

### Template Placeholders

- `{{title}}` — replaced with the record name
- `{{date}}` — replaced with today's ISO date

## Base Views

Base views live in `_bases/` and contain Dataview query definitions. They are embedded into records via Obsidian's transclusion syntax:

```markdown
## Tasks
![[project.base#Tasks]]
```

This renders a live table of all tasks linked to the current project. Each record type has its own base file with relevant sections.

### Example: project.base

Sections in `project.base`:
- Assumptions, Decisions, Constraints, Contradictions — learning records linked to this project
- Dependencies — projects this depends on
- Tasks — tasks assigned to this project
- Sub-projects — child projects
- Sessions, Conversations, Inputs, Notes — operational records linked to this project
- Learnings — all learning records referencing this project

## User Profile

The `user-profile.md` file in the vault root helps Alfred understand who the vault owner is. This enables context-aware entity extraction — the curator will only create records for entities relevant to the vault owner, not every person, company, or topic mentioned in source material.

The file is created during quickstart with a template. Fill it in with your name, work context, interests, and optionally things to ignore.
