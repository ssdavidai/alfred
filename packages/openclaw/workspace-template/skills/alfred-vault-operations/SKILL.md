---
name: alfred-vault-operations
description: Read, write, search, and reason over the user's personal vault (matters, errands, instincts, chores, events, people, orgs, notes, and 20+ other record types). Use whenever Sir asks about what's in his vault, wants to create/update/delete a record, or wants you to pull context from prior entries.
version: "1.0"
metadata:
  openclaw:
    emoji: "📚"
---

# Alfred — Vault Operations

The vault is Sir's personal knowledge graph. Every important fact, relationship, matter, errand, decision, and observation lives in there as a typed Markdown record with YAML frontmatter. All vault operations go through the `ctrl_vault_*` tools — **never** touch files directly.

## Record types you'll encounter

| Type | Directory | What it is |
|---|---|---|
| `matter` | `matter/` | Long-lived areas of Sir's life/work that need standing attention (e.g. "Retool Community Champion Role", "Growing Family & Second Baby Preparation"). |
| `task` (errand) | `task/` | Specific actionable items derived from emails, meetings, or streams. Can be linked to a matter. |
| `instinct` | `instinct/` | Learned routing rules ("flag Stripe payment failures as urgent"). Observed by the learning system. |
| `chore` | `chore/` | Recurring scheduled workflows (Temporal-backed). Each has a generated Python workflow. |
| `event` | `event/` | Point-in-time records of something that happened (meeting, email, digest delivered). |
| `person` / `org` | `person/`, `org/` | People and organizations in Sir's network. Linked via wikilinks from other records. |
| `observation` | `observation/` | Atomic behavioral signals extracted from streams — the raw material for instincts. |
| `reflection` | `reflection/` | Synthesized insights from the learning pipeline's judgment step. |
| `note` / `decision` / `project` / `asset` / ... | various | General knowledge entries. |

## How to call vault operations

All vault operations go through the `ctrl` MCP tool. Never bypass it — never `bash cat` vault files or `docker ps` containers.

### Read

- **`ctrl endpoint="/api/v1/vault/context"`** — one-shot overview: counts per type + recent records. Use this FIRST if you don't know what's in the vault.
- **`ctrl endpoint="/api/v1/vault/list/{type}"`** — list all records of a given type. Replace `{type}` with `matter`, `task`, `chore`, `note`, `person`, `org`, etc. Returns path, name, status, frontmatter, and a body preview.
- **`ctrl endpoint="/api/v1/vault/records/{path}"`** — read a full record by its path relative to the vault root. Example: `ctrl endpoint="/api/v1/vault/records/matter/growing-family.md"`.
- **`ctrl endpoint="/api/v1/vault/search" query={"grep": "Firstbase", "type": "decision"}`** — full-text search. Optional `type` filter scopes to one kind of record.
- **`ctrl endpoint="/api/v1/vault/graph"`** — fetch the relationship graph (who/what links to what). Useful when Sir asks "what's related to X".
- **`ctrl endpoint="/api/v1/vault/schema"`** — look up the allowed fields + status enums for a given record type before you write one.
- **`ctrl endpoint="/api/v1/vault/inbox"`** — list files sitting in the inbox waiting for processing.

### Write

- **`ctrl endpoint="/api/v1/vault/records" method="POST" body={"type": "task", "name": "my-task", "content": "..."}`** — create a new record. Check the schema first for required fields.
- **`ctrl endpoint="/api/v1/vault/records/{path}" method="PATCH" body={"set": {"status": "done"}}`** — patch the frontmatter of an existing record (change status, add a tag, update owner, etc).
- **`ctrl endpoint="/api/v1/vault/inbox" method="POST" body={"filename": "note.md", "content": "..."}`** — drop something into the inbox for processing.
- **`ctrl endpoint="/api/v1/vault/records/{path}" method="DELETE"`** — delete a record. **Only when Sir explicitly asks.**

## Good behavior

1. **Read before writing.** If Sir asks you to "update the NeoTerra matter", call `ctrl_vault_list type=matter` or `ctrl_vault_search` first to find the exact path. Don't guess.
2. **Wikilinks matter.** When creating records, use `[[person/Full Name]]` / `[[org/Org Name]]` / `[[matter/slug]]` references in the body. The janitor sweeps for broken links.
3. **Required fields.** Every record needs `type`, `name`, `created` at minimum. Most need `status` too. Call `ctrl_vault_schema` if unsure.
4. **Don't duplicate.** Before creating, search for near-matches. The vault already has curator-extracted records from the inbox pipeline.
5. **Body content is where the insight lives.** Frontmatter is structure; the Markdown body is where you write the actual content, references, and history.

## Examples

**Sir: "What matters am I actively working on?"**
→ `ctrl endpoint="/api/v1/vault/list/matter"` → filter `status=active` → format as a list grouped by category.

**Sir: "Remind me what we decided about the Firstbase move."**
→ `ctrl endpoint="/api/v1/vault/search" query={"grep": "Firstbase", "type": "decision"}` → read the top result with `ctrl endpoint="/api/v1/vault/records/{path}"`.

**Sir: "Add an errand to follow up with Robert Clarke next week."**
→ `ctrl endpoint="/api/v1/vault/schema"` → `ctrl endpoint="/api/v1/vault/records" method="POST" body={"type": "task", "name": "follow-up-robert-clarke", "content": "---\ntype: task\nname: Follow up with Robert Clarke\nstatus: todo\nowner: human\n---\n\n# Follow up with Robert Clarke\n\n[[person/Robert Clarke]]\n"}`

**Sir: "Show me everything related to Ania."**
→ `ctrl_vault_search query=Ania` → for each result, read + present as a linked brief.
