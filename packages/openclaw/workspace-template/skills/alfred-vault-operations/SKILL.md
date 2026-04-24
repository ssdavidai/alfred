---
name: alfred-vault-operations
description: Read, write, search, and reason over the user's personal vault (matters, errands, instincts, chores, events, people, orgs, notes, and 20+ other record types). Use whenever Sir asks about what's in his vault, wants to create/update/delete a record, or wants you to pull context from prior entries.
version: "1.0"
metadata:
  openclaw:
    emoji: "📚"
---

# Alfred — Vault Operations

The vault is Sir's personal knowledge graph. Every important fact, relationship, matter, errand, decision, and observation lives in there as a typed Markdown record with YAML frontmatter. All vault operations go through the `self` MCP tool — **never** touch files directly.

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

All vault operations on THIS tenant go through the `self` MCP tool. Never bypass it — never `bash cat` vault files or `docker ps` containers. If you're Alfred Prime and need to touch another tenant's vault, use the `tenant` tool (see `alfred-prime-federation`).

### Read

- **`self endpoint="/api/v1/vault/context"`** — one-shot overview: counts per type + recent records. Use this FIRST if you don't know what's in the vault.
- **`self endpoint="/api/v1/vault/list/{type}"`** — list all records of a given type. Replace `{type}` with `matter`, `task`, `chore`, `note`, `person`, `org`, etc. Returns path, name, status, frontmatter, and a body preview.
- **`self endpoint="/api/v1/vault/records/{path}"`** — read a full record by its path relative to the vault root. Example: `self endpoint="/api/v1/vault/records/matter/growing-family.md"`.
- **`self endpoint="/api/v1/vault/search" query={"grep": "Firstbase", "type": "decision"}`** — full-text search. Optional `type` filter scopes to one kind of record.
- **`self endpoint="/api/v1/vault/graph"`** — fetch the relationship graph (who/what links to what). Useful when Sir asks "what's related to X".
- **`self endpoint="/api/v1/vault/schema"`** — look up the allowed fields + status enums for a given record type before you write one.
- **`self endpoint="/api/v1/vault/inbox"`** — list files sitting in the inbox waiting for processing.

### Write

- **`self endpoint="/api/v1/vault/records" method="POST" body={"type": "task", "name": "my-task", "content": "..."}`** — create a new record. Check the schema first for required fields.
- **`self endpoint="/api/v1/vault/records/{path}" method="PATCH" body={"set": {"status": "done"}}`** — patch the frontmatter of an existing record (change status, add a tag, update owner, etc).
- **`self endpoint="/api/v1/vault/inbox" method="POST" body={"filename": "note.md", "content": "..."}`** — drop something into the inbox for processing.
- **`self endpoint="/api/v1/vault/records/{path}" method="DELETE"`** — delete a record. **Only when Sir explicitly asks.**

## Task ownership: alfred vs human

Every `task` record carries an `owner:` field that answers "whose responsibility is this?"

- **`owner: human`** — Sir has to do it. Dashboards show it on his todo list; you can surface it when he asks "what do I need to do?". You do NOT act on human-owned tasks unsupervised.
- **`owner: alfred`** — you are expected to do it. You may pick it up from a scheduled execution (via `TaskRunnerWorkflow`) or on request. When Sir says "and while you're at it, draft the follow-up email", the task you write has `owner: alfred`.

The split matters because it's the difference between a reminder for Sir and a job for you. Get it wrong and Sir will have phantom todos, or you'll fail to complete work you agreed to do.

**Rule of thumb:**
- "Remind me to…", "I need to…", "Follow up with…" → `owner: human`
- "Draft the…", "Send a note…", "Schedule the…", "Can you look into…" → `owner: alfred`
- Ambiguous → ask. Don't guess.

If the task needs human approval before execution (either because the instinct has `requires_approval: true` or because Sir's trust band says so), set `owner: alfred` and leave `approved: false` — JudgmentWorkflow's trust gate will surface it on the dashboard for Sir to green-light.

## Good behavior

1. **Read before writing.** If Sir asks you to "update the NeoTerra matter", call `self endpoint="/api/v1/vault/list/matter"` or `self endpoint="/api/v1/vault/search" query={"grep":"NeoTerra"}` first to find the exact path. Don't guess.
2. **Wikilinks matter.** When creating records, use `[[person/Full Name]]` / `[[org/Org Name]]` / `[[matter/slug]]` references in the body. The janitor sweeps for broken links.
3. **Required fields.** Every record needs `type`, `name`, `created` at minimum. Most need `status` too. Call `self endpoint="/api/v1/vault/schema"` if unsure.
4. **Task owner is required.** Every `task` record gets `owner: alfred` or `owner: human`. No default, no "figure it out later".
5. **Don't duplicate.** Before creating, search for near-matches. The vault already has curator-extracted records from the inbox pipeline.
6. **Body content is where the insight lives.** Frontmatter is structure; the Markdown body is where you write the actual content, references, and history.
7. **Tool output stays out of Sir's reply.** Empty search results, 404s on missing records, `{error: true, ...}` envelopes from `self` — all of these are signals for YOUR reasoning, never text for Sir. If a search returns `{"results": [], "count": 0}`, reply with something like "I don't see any NeoTerra matters in the vault yet, Sir — shall I create one?" Do NOT paste the raw JSON. If a record read fails, paraphrase in one prose sentence and suggest a next step (broaden the search, check a different type, ask Sir for the exact name). The first character of your Sir-facing message is never `{`.

## Examples

**Sir: "What matters am I actively working on?"**
→ `self endpoint="/api/v1/vault/list/matter"` → filter `status=active` → format as a list grouped by category.

**Sir: "Remind me what we decided about the Firstbase move."**
→ `self endpoint="/api/v1/vault/search" query={"grep": "Firstbase", "type": "decision"}` → read the top result with `self endpoint="/api/v1/vault/records/{path}"`.

**Sir: "Add an errand to follow up with Robert Clarke next week."**
→ `self endpoint="/api/v1/vault/schema"` → `self endpoint="/api/v1/vault/records" method="POST" body={"type": "task", "name": "follow-up-robert-clarke", "content": "---\ntype: task\nname: Follow up with Robert Clarke\nstatus: todo\nowner: human\n---\n\n# Follow up with Robert Clarke\n\n[[person/Robert Clarke]]\n"}`
(owner=human because Sir's the one following up.)

**Sir: "Can you draft me a reply to Robert's email?"**
→ `self endpoint="/api/v1/vault/records" method="POST" body={"type": "task", "name": "draft-reply-robert-clarke", "content": "---\ntype: task\nname: Draft reply to Robert Clarke\nstatus: todo\nowner: alfred\n---\n\n# Draft reply to Robert Clarke\n\n[[person/Robert Clarke]]\n"}`
(owner=alfred because Sir handed the work to you. You'd typically then proceed to draft inline rather than just creating the task, but the record captures the work for the task queue.)

**Sir: "Show me everything related to Ania."**
→ `self endpoint="/api/v1/vault/search" query={"grep":"Ania"}` → for each result, read + present as a linked brief.
