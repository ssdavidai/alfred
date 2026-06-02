---
name: alfred-files
description: Read, search, describe, move, and (carefully) delete the principal's locally-stored files (PDFs, images, code, audio, video, generated artefacts). The 8th MCP server — surfaces Store 5 (alfred-state.db files table + on-disk /files volume). Use for "find that contract", "rename this to draft.md", "what's the size of the PDF Alfred read?", "empty the recycle bin".
license: alfred-platform internal — see the parent monorepo's LICENSE
---

# Alfred Files MCP

Sir drops binary blobs into `/files` on his tenant; this MCP catalogue is how
Alfred (and every focused subagent that opens `files`) reads, finds, describes,
moves, and deletes them. The full design is in
`docs/specs/issue-114-local-file-storage.md`; this skill is the conversational
playbook.

The catalogue is **12 tools** as of Lane D₁:

| Tool | Verb | One-liner |
|------|------|-----------|
| `list` | GET | paginated metadata, optional `prefix` filter |
| `stat` | GET | the audit-shape metadata row for ONE path |
| `read_text` | GET | UTF-8 contents of a text blob |
| `read_base64` | GET | base64 bytes of a binary blob (≤5 MB) |
| `search` | GET | keyword search across path / filename / principal_label |
| `usage` | GET | bytes + counts + soft/hard caps |
| `create` | POST | upload a small (≤5 MB) base64-encoded blob |
| `set_label` | PATCH | set/clear the `principal_label` field (was `describe` in PR 2) |
| `delete` | DELETE | soft-delete (tombstone + unlink) |
| `move` | POST | rename or relocate a blob (Lane D₁) |
| `describe` | GET | rich metadata getter: name, size, mime, created/updated/read/deleted timestamps, summary (Lane D₁) |
| `hard_delete` | POST | permanently purge a soft-deleted blob (Lane D₁) |

`describe` and `stat` look similar but answer different questions:

- **`stat`** — the audit-row shape. Soft-deleted rows 404. Use when you
  want to confirm a file exists and check size / content_type before a
  read.
- **`describe`** — the conversational shape: `{id, name, path, size_bytes,
  mime, principal_label, summary, created_at, updated_at,
  alfred_read_at, deleted_at}`. **Soft-deleted rows are returned** with
  `deleted_at` populated so the principal can ask "did I delete that?"
  and get an answer.

---

## When to use each Lane D₁ tool

### `move`

Sir says "rename that to `final-draft.md`" / "actually call it `report.pdf`"
or you generated an artefact and want a cleaner name on disk.

Takes `{file_id, new_path}`:
- `file_id` is the 26-char ULID from `list` / `stat` / `describe` (NOT the
  path — the path is what's changing).
- `new_path` is **usually** a bare basename (`final-draft.md`) — the move
  keeps the existing ULID dir and just renames the file. The full
  `<ULID>/<safe-name>` shape also works but is rare.

Two refuse modes (both 409):
- `SHARED_BLOB` — the file's bytes are shared with another upload via
  dedupe (`ref_count > 1`). Delete the row and re-upload under the new
  name; the dedupe layer will skip the second upload.
- `COLD_BLOB` — the file is in the 90-day cold archive. Restore first
  (`POST /api/v1/files/cold-restore/:file_id`, operator-only), then move.

Writes a `files_move` audit row with `{path: {from, to}}` so the move is
recoverable in /study#audit.

#### Example

> Sir: "Rename that screenshot to `tailscale-logs.png`."
>
> ```
> describe({path: "01J9X.../screencap.png"})
> → {id: "01J9X...", name: "screencap.png", ...}
>
> move({file_id: "01J9X...", new_path: "tailscale-logs.png"})
> → {id: "01J9X...", path: "01J9X.../tailscale-logs.png",
>    original_filename: "tailscale-logs.png", ...}
>
> "Done — that's now `tailscale-logs.png` in your files store, Sir."
> ```

### `describe`

Sir says "tell me about that file" / "what's the size of the contract
Alfred read?" / "when did I last open the Q3 PDF?" / "did I delete the
old draft?".

Takes `{path}`. Returns the conversational projection (see table above).
**Use this instead of `stat`** when the principal is asking a metadata
question rather than the model needing audit-shape data before a read.

`summary` is populated by Lane B's FileExtractionWorkflow (per-mime
extractor → workers-gateway summariser → PATCH writeback). Null while
extraction is pending or on error.

#### Example

> Sir: "When did Alfred last read the Acme contract?"
>
> ```
> search({query: "Acme contract"})
> → {items: [{id: "01J9X...", path: "01J9X.../acme.pdf", ...}], ...}
>
> describe({path: "01J9X.../acme.pdf"})
> → {alfred_read_at: 1717023456789, created_at: 1716000000000, ...}
>
> "Sir, you uploaded that on 2026-05-17 and I last read it
>  on 2026-05-29 at 23:37."
> ```

### `hard_delete`

The "really empty the recycle bin" step. **CONFIRM WITH SIR before
calling unless he EXPLICITLY asked to permanently delete** — purge is
one-way and the on-disk bytes are unlinked (the audit ledger keeps the
breadcrumb).

Takes `{file_id}`. Two-stage gate:
1. The file MUST be soft-deleted first (`delete` tool). If it isn't,
   the route 409s with `PURGE_REQUIRES_SOFT_DELETE` — `describe` on the
   path will confirm whether `deleted_at` is populated.
2. If the bytes are shared via dedupe (`ref_count > 1`) only the
   per-file row is dropped; the canonical bytes stay for the other
   references.

Writes a `files_purge` audit row.

#### Example

> Sir: "Permanently delete the old draft, please."
>
> ```
> describe({path: "01J9X.../draft.md"})
> → {deleted_at: 1717020000000, ...}  // already soft-deleted
>
> hard_delete({file_id: "01J9X..."})
> → {id: "01J9X...", path: "01J9X.../draft.md", purged_at: 1717023500000}
>
> "Gone for good, Sir. The audit ledger has the breadcrumb."
> ```
>
> If `describe` shows `deleted_at: null`, soft-delete first:
>
> ```
> delete({path: "01J9X.../draft.md"})
> hard_delete({file_id: "01J9X..."})
> ```

---

## Self-protection rule for `hard_delete`

`hard_delete` is the only IRREVERSIBLE tool in the catalogue (`delete` is
recoverable; the bytes stay on disk under `deleted_at`). Two guardrails:

1. **Never** call `hard_delete` on a file you haven't explicitly been
   told to permanently delete. "Clean up old files" / "tidy the recycle
   bin" is ambiguous — confirm the specific files first.
2. The two-stage backend gate is the seatbelt: if a slip-up sends a
   live row through `hard_delete`, the route 409s. Don't reach around
   it by soft-deleting first "just to satisfy the gate" — the
   soft-delete is itself a principal-facing event.
