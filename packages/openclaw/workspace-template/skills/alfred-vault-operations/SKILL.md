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

## Tools available to you

All of these reach ctrl-api and then the vault filesystem. You never bypass them.

### Read

- **`ctrl_vault_context`** — one-shot overview: counts per type + recent records. Use this FIRST if you don't know what's in the vault.
- **`ctrl_vault_list`** `{type}` — list all records of a given type. Returns path, name, status, frontmatter, and a body preview. Example: `ctrl_vault_list type=matter`.
- **`ctrl_vault_read`** `{path}` — read a full record by its path relative to the vault root. Example: `matter/growing-family-hannas-first-year.md`.
- **`ctrl_vault_search`** `{query, type?}` — full-text search. Optional type filter scopes to one kind of record.
- **`ctrl_vault_graph`** — fetch the relationship graph (who/what links to what). Useful when Sir asks "what's related to X".
- **`ctrl_vault_schema`** — look up the allowed fields + status enums for a given record type before you write one.
- **`ctrl_vault_inbox`** — list files sitting in the inbox waiting for the curator. Use to answer "what haven't you processed yet".

### Write

- **`ctrl_vault_create`** `{path, content, frontmatter?}` — create a brand new record. Body is markdown, frontmatter is a dict of YAML keys. Check the schema first for required fields.
- **`ctrl_vault_update`** `{path, set}` — patch the frontmatter of an existing record (change status, add a tag, update owner, etc). Body stays unchanged.
- **`ctrl_vault_inbox_add`** `{path, content}` — drop something into the inbox for the curator to process asynchronously. Use when Sir wants you to remember an unstructured blob without committing to a type.
- **`ctrl_vault_delete`** `{path}` — delete a record. **Use sparingly and only when Sir explicitly asks you to delete something specific.** Never delete to "clean up" without being asked.

## Good behavior

1. **Read before writing.** If Sir asks you to "update the NeoTerra matter", call `ctrl_vault_list type=matter` or `ctrl_vault_search` first to find the exact path. Don't guess.
2. **Wikilinks matter.** When creating records, use `[[person/Full Name]]` / `[[org/Org Name]]` / `[[matter/slug]]` references in the body. The janitor sweeps for broken links.
3. **Required fields.** Every record needs `type`, `name`, `created` at minimum. Most need `status` too. Call `ctrl_vault_schema` if unsure.
4. **Don't duplicate.** Before creating, search for near-matches. The vault already has curator-extracted records from the inbox pipeline.
5. **Body content is where the insight lives.** Frontmatter is structure; the Markdown body is where you write the actual content, references, and history.

## Examples

**Sir: "What matters am I actively working on?"**
→ `ctrl_vault_list type=matter` → filter `status=active` → format as a list grouped by category.

**Sir: "Remind me what we decided about the Firstbase move."**
→ `ctrl_vault_search query="Firstbase" type=decision` → read the top result with `ctrl_vault_read`.

**Sir: "Add an errand to follow up with Robert Clarke next week."**
→ `ctrl_vault_schema type=task` → `ctrl_vault_create path=task/Follow up with Robert Clarke.md` with frontmatter `{type: task, name: "Follow up with Robert Clarke", status: todo, created: <today>, due: <next week>, owner: human}` and a body referencing `[[person/Robert Clarke]]`.

**Sir: "Show me everything related to Ania."**
→ `ctrl_vault_search query=Ania` → for each result, read + present as a linked brief.
