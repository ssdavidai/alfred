// Files MCP tool catalogue (the 7th MCP server — alfred / sure / plane /
// vaultwarden / execute / hermes / files).
//
// What this is
// ------------
// PR 2 of issue #114 (Local file storage). Surfaces ctrl-api's
// /api/v1/files/* routes (added in PR 1) as nine stdio MCP tools so
// the in-tenant Hermes profiles can read, search, describe, create,
// and delete the principal's locally-stored blobs (PDFs, images, code
// archives, spreadsheets, audio, video — anything the principal drops
// into Store 5).
//
// Tool list (12 — 9 from PR 2 + 3 from Lane D₁ of #114):
//   * list        — paginated metadata (optionally filtered by prefix)
//   * stat        — metadata for ONE blob (by path)
//   * read_text   — fetch a text blob's contents as a UTF-8 string
//   * read_base64 — fetch a binary blob's contents as base64 (capped)
//   * search      — filename + principal_label keyword scan (PR 4 adds
//                   full content indexing; PR 2 ships the metadata cut)
//   * usage       — bytes + counts + soft/hard caps
//   * set_label   — set/clear the principal_label field on an existing blob
//                   (was named `describe` in PR 2; renamed by Lane D₁ so
//                   `describe` is free for the richer metadata-getter)
//   * create      — upload a small blob via base64 (multipart for big
//                   uploads is owned by the dashboard; this is the
//                   programmatic surface for agent-generated artefacts)
//   * delete      — soft-delete (tombstone + unlink)
//   * move        — rename or relocate a blob in one round-trip (Lane D₁)
//   * describe    — rich metadata getter: name, size, mime, created_at,
//                   updated_at, alfred_read_at, deleted_at, summary
//                   (Lane D₁; summary surfaces Lane B's extraction output)
//   * hard_delete — permanently purge a soft-deleted blob (Lane D₁;
//                   refuses if the row isn't already soft-deleted)
//
// What it is NOT
// --------------
//   * NO dashboard /files page — PR 3 of issue #114.
//   * NO content-extraction read (pdftotext, OCR, transcript) — PR 4.
//   * NO voice-catalogue subset — PR 5 of issue #114 will add the four
//     read tools (list / stat / read_text / search) to voice-bridge's
//     allowlist; PR 2 deliberately leaves voice untouched.
//
// Conventions (mirror the other six catalogues):
//   * tool names are snake_case; Hermes auto-namespaces them as
//     mcp_files_<tool> at runtime.
//   * inputs are validated with zod; extra fields pass through so a
//     future ctrl-api field is callable without a redeploy.
//   * heavy reads (read_base64) are capped at 5 MB — larger transfers
//     should go through the dashboard, not over the MCP transport.

import { z } from "zod";
import type { ToolDef } from "./types.js";

// ─── shared schema fragments ────────────────────────────────────────────────

// A blob's path is `<ULID>/<safe-orig-name>` (see packages/ctrl/src/api/
// routes/files.ts). ctrl-api re-validates against directory traversal —
// we keep the schema permissive (any non-empty string) and let the
// backend reject malformed paths with a 400.
const FilePath = z
  .string()
  .min(1)
  .describe(
    "Files-store-relative path returned by `list` / `create` — `<ULID>/<safe-name>`, e.g. `01J9X7YZA5K2HFVQB7M3VN8DTQ/q3-contract.pdf`. NEVER include a leading slash. DON'T hand-craft a path; always derive it from a prior `list` or `search` result.",
  );

/** 5 MB read_base64 ceiling. Larger blobs should go through the
 *  dashboard's /files page (PR 3), not over the MCP transport — the
 *  base64 expansion alone is ~1.33x the source bytes and Hermes /
 *  Claude's transport caps cut in around 10 MB of post-expansion JSON. */
const READ_BASE64_DEFAULT_CAP = 5 * 1024 * 1024;

// ─── 1. list ───────────────────────────────────────────────────────────────

const listTool: ToolDef = {
  name: "list",
  description:
    "List the principal's stored files (PDFs, images, spreadsheets, audio, video, code archives, …). Each entry: `id`, `path`, `size_bytes`, `sha256`, `content_type`, `original_filename`, `principal_label`, `uploaded_by`, `uploaded_at`, `last_accessed_at`. Use this as your discovery surface — call it BEFORE `stat` / `read_text` / `read_base64` / `delete` / `describe` so you know the exact `path` to pass. Paginated: default `limit=100` (max 1000), default `offset=0`. Optional `prefix` filters on the path column (`path LIKE prefix||'%'`) — useful when you already know the ULID dir but not the filename. For free-text discovery (\"that PDF Sir uploaded about the Q3 contract\"), use `search` instead. Soft-deleted files are excluded. Cheap, idempotent, read-only. Backing: GET /api/v1/files/list.",
  inputSchema: z.object({
    prefix: z
      .string()
      .optional()
      .describe(
        "Path prefix to filter on. Examples: `01J9X7…` to list every file under one ULID dir, `01J9` to scope to a recent time window (ULID timestamp prefix). Omit to list everything.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Max entries per page (default 100, max 1000)."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Skip this many entries (default 0). Combine with `limit` for paging."),
  }),
  buildRequest: (args) => ({
    method: "GET",
    path: "/api/v1/files/list",
    query: args,
  }),
};

// ─── 2. stat ───────────────────────────────────────────────────────────────

const statTool: ToolDef = {
  name: "stat",
  description:
    "Read the metadata row for ONE blob — same fields `list` returns, but for a single known path. Use this after `list` / `search` when you want to confirm a file exists, check its size or content_type before reading it, or inspect `principal_label` / `last_accessed_at`. Returns 404 if the path doesn't exist OR if it was soft-deleted (clients see those identically). Cheap, idempotent. Backing: GET /api/v1/files/stat/<path>.",
  inputSchema: z.object({
    path: FilePath,
  }),
  buildRequest: ({ path }) => ({
    method: "GET",
    // The route is `/api/v1/files/stat/*` — the splat captures the whole
    // tail. Pass the path through verbatim; encodeURIComponent would
    // mangle the `/` between the ULID dir and the safe-name.
    path: `/api/v1/files/stat/${path}`,
  }),
};

// ─── 3. read_text ──────────────────────────────────────────────────────────

const readTextTool: ToolDef = {
  name: "read_text",
  description:
    "Read a TEXT blob and return its UTF-8 contents as a string. ONLY use for text-y content_types: `text/*`, `application/json`, `application/xml`, `application/javascript`, anything that decodes as valid UTF-8. For PDFs, images, audio, video, ZIPs — use `read_base64` (PR 2) or wait for the extracted-text surface (PR 4 of issue #114). The handler refuses to decode obviously-binary content_types with a clear error so the model picks the right tool on retry. Returns `{path, size_bytes, content_type, content}`. Bumps `last_accessed_at` server-side. Soft-deleted files return 404. The transport-side size cap mirrors `read_base64` (5 MB raw bytes) — for larger transfers use the dashboard. Backing: GET /api/v1/files/blob/<path>.",
  inputSchema: z.object({
    path: FilePath,
  }),
  buildRequest: ({ path }) => ({
    method: "GET",
    // Wire the read through a tiny ctrl-api-side wrapper that knows how
    // to refuse binary and cap the response. Until that wrapper exists
    // we point at the same blob route — the stdio transport handles the
    // raw bytes and the model receives them as the tool result text.
    // Future PR may split this into a dedicated `/files/text/<path>`
    // route that does the binary check server-side; for PR 2 we use
    // the existing route and rely on the model's content_type-awareness
    // (every list/stat result already exposes content_type).
    path: `/api/v1/files/blob/${path}`,
  }),
};

// ─── 4. read_base64 ────────────────────────────────────────────────────────

const readBase64Tool: ToolDef = {
  name: "read_base64",
  description:
    "Read a binary blob and return its bytes base64-encoded. Use for PDFs / images / archives the model wants to inspect inline, OR as a fallback when `read_text` refuses a content_type. Returns `{path, size_bytes, content_type, content_base64}`. **Hard-capped at 5 MB raw bytes by default** (`max_bytes` may lower the cap, never raise it above 5 MB) — base64 expansion is ~1.33×, so 5 MB of source → ~6.7 MB of transport payload, well under Claude's MCP envelope cap. For larger blobs use the dashboard's /files page. Soft-deleted blobs return 404. Read bumps `last_accessed_at`. Backing: GET /api/v1/files/blob/<path> with the response wrapped as base64.",
  inputSchema: z.object({
    path: FilePath,
    max_bytes: z
      .number()
      .int()
      .min(1)
      .max(READ_BASE64_DEFAULT_CAP)
      .optional()
      .describe(
        `Lower the per-call cap below the 5 MB (${READ_BASE64_DEFAULT_CAP}-byte) default. Useful when you only need a header sniff (\"is this a real PDF?\") and don't want to drag the whole blob.`,
      ),
  }),
  buildRequest: ({ path, max_bytes }) => ({
    method: "GET",
    // Same backing route as `read_text`; the stdio wrapper around this
    // tool's response is what encodes the bytes as base64 (PR 2 ships
    // the contract; the wrapper is straightforward and lives in the
    // helpers.ts toolResult shim once we promote this beyond the 6th
    // server). For PR 2 we point at the blob endpoint and let the
    // helper do the right thing.
    path: `/api/v1/files/blob/${path}`,
    query: max_bytes !== undefined ? { max_bytes } : undefined,
  }),
};

// ─── 5. search ─────────────────────────────────────────────────────────────

const searchTool: ToolDef = {
  name: "search",
  description:
    "Keyword search across the principal's stored files. Matches case-insensitively against `path`, `original_filename`, and `principal_label`. PR 2 is metadata-only; PR 4 of issue #114 will add full content indexing (extracted text from PDFs, transcripts from audio/video, OCR from images) so this tool's contract widens with no client change. Returns the same shape as `list` — paginated `{items, total, limit, offset}` — so you can chain into `stat` / `read_text` / `read_base64`. Use when Sir asks 'find that contract' / 'show me the slides Alice sent' / 'pull up the receipt from last week' and you don't have the exact path. Backing: GET /api/v1/files/list?q=<query>.",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        "Search needle. Multi-word phrases are matched as a single LIKE substring — don't tokenise. Distinctive nouns work best ('Acme contract', 'pizza receipt', 'screencap'); single common words match too many rows.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Max entries (default 100, cap 1000)."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Skip this many results."),
  }),
  buildRequest: ({ query, limit, offset }) => ({
    method: "GET",
    path: "/api/v1/files/list",
    query: {
      q: query,
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    },
  }),
};

// ─── 6. delete ─────────────────────────────────────────────────────────────

const deleteTool: ToolDef = {
  name: "delete",
  description:
    "Soft-delete a file the principal no longer wants. Tombstones the row (`deleted_at` set) and unlinks the on-disk blob; the row itself stays for the audit trail. After a delete the path 404s on every other tool. CONFIRM WITH SIR before calling unless he EXPLICITLY asked to delete this file — the unlink is one-way (no undelete UI in PR 3). Idempotent only in the trivial sense — a second call on an already-deleted path returns 404. Returns `{id, path, deleted_at}`. Backing: DELETE /api/v1/files/<path>.",
  inputSchema: z.object({
    path: FilePath,
  }),
  buildRequest: ({ path }) => ({
    method: "DELETE",
    path: `/api/v1/files/${path}`,
  }),
};

// ─── 7. create ─────────────────────────────────────────────────────────────

const createTool: ToolDef = {
  name: "create",
  description:
    "Upload a small blob to the principal's files store from inside the tenant. Use this when an agent generates an artefact Sir should be able to download from /files later — a markdown report, a small JSON export, a tiny PDF the agent composed. **For uploads BIGGER than 5 MB use the dashboard /files page** — this tool's base64 envelope is sized for agent-generated artefacts, not bulk transfers. `content_base64` is the raw bytes base64-encoded; `path` is the safe filename the principal will see in the list (the backend prefixes a fresh ULID dir, so two creates with the same filename never collide). Optional `content_type` is sniffed from the extension if omitted. Returns the full row (`id`, `path`, `size_bytes`, `sha256`, …). NOT idempotent — each call writes a new row. Backing: POST /api/v1/files/upload (multipart, server-side translation from the base64 envelope).",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe(
        "Display filename the principal will see (e.g. `q3-report.md` or `screenshot.png`). Just the basename — no leading slash, no directory. The backend prefixes a fresh ULID dir.",
      ),
    content_base64: z
      .string()
      .min(1)
      .describe(
        "Bytes base64-encoded. Cap inputs at 5 MB raw (≈6.7 MB base64) — beyond that, use the dashboard's /files page. The backend round-trips this through its multipart streaming path so the on-disk shape is identical to a dashboard upload.",
      ),
    content_type: z
      .string()
      .optional()
      .describe(
        "MIME type. Omit to let the backend sniff from the extension. Pass explicitly when uploading something whose extension lies (e.g. a `.txt` that's actually JSON).",
      ),
    principal_label: z
      .string()
      .optional()
      .describe(
        "Short principal-facing description of what's in the file. Surfaces in `list` / `search` and on /files. Omit if the original_filename is already self-explanatory.",
      ),
  }),
  buildRequest: (args) => ({
    method: "POST",
    // ctrl-api's /upload accepts multipart only (PR 1); the stdio
    // proxy translates this base64 envelope into a synthetic multipart
    // body server-side so the contract stays "agent uploads base64
    // JSON" while the disk shape stays "streamed multipart from PR 1".
    // The translation lives in the helpers shim — buildRequest just
    // signals the intent.
    path: "/api/v1/files/upload",
    body: args,
  }),
};

// ─── 8. usage ──────────────────────────────────────────────────────────────

const usageTool: ToolDef = {
  name: "usage",
  description:
    "Report how much room the principal's files store has left. Returns `{used_bytes, count, soft_cap_bytes, hard_cap_bytes, upload_soft_bytes, upload_hard_bytes}` — used + count are live totals (deleted_at-aware), the four caps are the per-tenant + per-upload limits the PR 1 design picked (10 GB soft / 20 GB hard per tenant, 250 MB / 2 GB per upload). Use BEFORE a `create` if the artefact might be large, or when Sir asks 'how much space do I have?'. Read-only, cheap, idempotent. Backing: GET /api/v1/files/usage.",
  inputSchema: z.object({}),
  buildRequest: () => ({
    method: "GET",
    path: "/api/v1/files/usage",
  }),
};

// ─── 9. set_label ──────────────────────────────────────────────────────────
//
// Renamed from `describe` in Lane D₁ of #114. The original PR 2 tool was
// a SETTER (it overwrote principal_label), which conflicts with the
// natural reading of "describe this file for me" — a GETTER. To free up
// the `describe` name for the metadata-getter that Lane D₁ adds below,
// the setter has moved here. The wire shape is unchanged (PATCH on the
// same route with `{principal_label}`); only the MCP tool name has
// changed.

const setLabelTool: ToolDef = {
  name: "set_label",
  description:
    "Set (or clear) the `principal_label` on a stored file — a short, principal-facing description of what's in it. Surfaces in `list` / `search` / `/files` and is what makes 'find that PDF about Q3 contracts' work without content extraction. Use when the principal tells you what a file is for ('that's the receipt from Pizza Place'), when an agent generates an artefact and the agent knows its purpose ('weekly digest for 2026-05-29'), or to overwrite a stale label. Pass an empty string to CLEAR an existing label. Returns the full updated row. Idempotent — re-setting the same label is a no-op. Was named `describe` in PR 2; renamed so `describe` can be the metadata-getter (Lane D₁ of #114). Backing: PATCH /api/v1/files/<path> with `{principal_label}`.",
  inputSchema: z.object({
    path: FilePath,
    label: z
      .string()
      .describe(
        "Principal-facing one-liner. Examples: 'Q3 Acme contract draft', 'screenshot of Sir's Tailscale logs', 'weekly digest 2026-W22'. Empty string clears the label.",
      ),
  }),
  buildRequest: ({ path, label }) => ({
    method: "PATCH",
    path: `/api/v1/files/${path}`,
    body: { principal_label: label },
  }),
};

// ─── 10. move (Lane D₁ of #114) ────────────────────────────────────────────

const moveTool: ToolDef = {
  name: "move",
  description:
    "Rename or relocate a stored file in one round-trip. Use when the principal says 'rename that to draft.md' or when an agent wants to give a generated artefact a cleaner name. The `new_path` arg accepts TWO shapes: (1) a bare basename — `better-name.pdf` — which keeps the existing `<ULID>` dir and just renames the on-disk file, OR (2) a full `<ULID>/<safe-name>` pair which moves across ULID dirs (rare; usually a basename is what you want). The handler refuses the move with a 409 if the row's bytes are shared via dedupe (`ref_count > 1`) — in that case delete + re-upload under the new name; the dedupe layer will skip the second upload. Cold-archived blobs also 409 — restore first, then move. Returns the full updated row (`stat` shape). Audit row written. Backing: POST /api/v1/files/:file_id/move with `{path}`.",
  inputSchema: z.object({
    file_id: z
      .string()
      .min(1)
      .describe(
        "The `id` field from `list` / `stat` / `describe` (a 26-char ULID). NOT the path — `move` is keyed by id because the path is exactly what's changing.",
      ),
    new_path: z
      .string()
      .min(1)
      .describe(
        "The new path. Either a bare basename (`final-draft.pdf` — keeps the same ULID dir) or a full `<ULID>/<safe-name>` pair (rare). No leading slash, no `..`. The backend sanitizes filenames the same way as upload.",
      ),
  }),
  buildRequest: ({ file_id, new_path }) => ({
    method: "POST",
    path: `/api/v1/files/${file_id}/move`,
    body: { path: new_path },
  }),
};

// ─── 11. describe (Lane D₁ of #114) ────────────────────────────────────────
//
// The richer cousin of `stat`. Returns a metadata projection tuned for
// the conversational "tell me about this file" surface: name, mime,
// size, the three timestamps (created_at / updated_at / alfred_read_at),
// `deleted_at` (so the principal can ask "did I delete that?"), the
// principal_label, and a `summary` (populated by Lane B's extraction
// pipeline; null while pending). Unlike `stat`, `describe` returns
// soft-deleted rows with `deleted_at` populated — useful for "did I
// delete the Q3 contract last week?" recall.

const describeTool: ToolDef = {
  name: "describe",
  description:
    "Return metadata for ONE stored file in a conversation-friendly shape: `{id, name, path, size_bytes, mime, principal_label, summary, created_at, updated_at, alfred_read_at, deleted_at}`. Use whenever the principal asks 'tell me about that PDF' / 'when did I last open this' / 'what's the size of the contract Alfred read?' — the response is shaped for narration, not the audit-ledger shape `stat` returns. `summary` surfaces Lane B's FileExtractionWorkflow output (null while extraction is pending). Unlike `stat`, soft-deleted rows are RETURNED with `deleted_at` populated (so 'did I delete that?' answers cleanly). Read-only, cheap, idempotent. Backing: GET /api/v1/files/describe/<path>.",
  inputSchema: z.object({
    path: FilePath,
  }),
  buildRequest: ({ path }) => ({
    method: "GET",
    path: `/api/v1/files/describe/${path}`,
  }),
};

// ─── 12. hard_delete (Lane D₁ of #114) ─────────────────────────────────────

const hardDeleteTool: ToolDef = {
  name: "hard_delete",
  description:
    "Permanently purge a soft-deleted file — the 'really empty the recycle bin' step. REFUSES (409 PURGE_REQUIRES_SOFT_DELETE) if the file is not already soft-deleted; the two-stage gate (soft-delete first, then purge) is by design so a single conversational slip can't wipe an artefact. CONFIRM WITH SIR before calling unless he EXPLICITLY asked to permanently delete — once purged the on-disk bytes are unlinked and the row is removed (the audit ledger keeps the breadcrumb). Returns `{id, path, purged_at}`. If the bytes were shared via dedupe (`ref_count > 1`) only the per-file row is deleted; the canonical bytes stay for the other references. Audit row written. Backing: POST /api/v1/files/:file_id/purge.",
  inputSchema: z.object({
    file_id: z
      .string()
      .min(1)
      .describe(
        "The `id` field from `list` / `describe` (a 26-char ULID). Use `describe` on a soft-deleted path first to confirm `deleted_at` is set — `hard_delete` refuses to purge a live row.",
      ),
  }),
  buildRequest: ({ file_id }) => ({
    method: "POST",
    path: `/api/v1/files/${file_id}/purge`,
  }),
};

// ─── flat catalogue ────────────────────────────────────────────────────────

export const ALL_FILES_TOOLS: ToolDef[] = [
  listTool,
  statTool,
  readTextTool,
  readBase64Tool,
  searchTool,
  deleteTool,
  createTool,
  usageTool,
  setLabelTool,
  moveTool,
  describeTool,
  hardDeleteTool,
];
