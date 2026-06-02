// Voice-bridge `files__*` read-only surface — PR4 of issue #114.
//
// The Hermes `files` MCP catalogue (PR2, #130) ships nine tools:
//   list, stat, read_text, read_base64, search, delete, create, usage, describe
//
// Voice gets a CURATED read-only subset of FOUR — no writes ever, no base64
// envelopes (gpt-realtime-2 can't usefully ingest a 5 MB binary blob mid-call
// anyway):
//
//   files__list         — discover / paginate files Sir has uploaded
//   files__stat         — confirm one file's metadata
//   files__read_text    — inline a text file's contents, with a hard byte
//                         ceiling so we never drag a 2 MB log into the
//                         OpenAI Realtime session
//   files__search       — keyword find across path / original_filename /
//                         principal_label (the q-filter from PR2's PATCH)
//
// The ctrl-api routes these wrap (live in packages/ctrl/src/api/routes/files.ts):
//
//   GET /api/v1/files/list?prefix=&q=&limit=&offset=
//   GET /api/v1/files/stat/<path>          (route tail `*`)
//   GET /api/v1/files/blob/<path>          (route tail `*`)
//
// Three things voice does NOT get from the Hermes catalogue (deliberately):
//
//   * delete / create / describe — writes, all of them. Voice writes go via
//     MCP (alfred__create_vault_record, alfred__notify_principal, &c.) or
//     `self`-the-tool's POST surface, never through `files__*`. The
//     voice-bridge scoped ctrl-api bearer has no files-write routes in its
//     allowlist (see packages/ctrl/src/api/auth.ts) so even if the model
//     tried, the request would 401.
//
//   * read_base64 — 5 MB of base64 in a voice turn is a 6.7 MB round-trip
//     through the Realtime session window. Voice asks for "the receipt
//     PDF Sir uploaded" by NAME (read it back to Sir, not into the model).
//     If the model needs a base64 payload it can spawn a delegated agent
//     via alfred__spawn_alfred_task — `gpt-realtime-2` isn't a sensible
//     consumer for that surface.
//
//   * usage — diagnostic only; voice has no reason to recite tenant quota
//     numbers on a phone call. If we ever surface "how much space is
//     left, sir?" the right shape is a one-sentence summary, not the raw
//     `{used_bytes, count, soft_cap_bytes, hard_cap_bytes, ...}` row.
//     `usage` is allowlisted at the auth layer (cheap, idempotent) but
//     not exposed as a Realtime function tool — keeping the surface lean.
//
// `files__read_text` enforces a `max_bytes` ceiling client-side (default
// 32 KB, hard cap 64 KB). If `stat` reports the file as larger, the
// dispatcher SHORT-CIRCUITS — no blob fetch, returns `{too_large: true,
// size_bytes, suggestion}` so the model can tell Sir "that file is too
// large to read aloud" without burning network + Realtime tokens on a
// 2 MB transfer the model would have to truncate anyway.

import { ctrlApiAuthToken, ctrlApiUrl, type TenantContext } from "./tenant.js";
import type { ToolResult } from "./tools.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Default ceiling for files__read_text. ~8K tokens, comfortably under
 *  serializeToolResult's 24 KB cap (tools.ts) so the model sees the whole
 *  body, not a `[truncated]` tail. */
const READ_TEXT_DEFAULT_MAX_BYTES = 32 * 1024;

/** Hard cap. The model can REQUEST less via `max_bytes`, never more. */
const READ_TEXT_HARD_CAP_BYTES = 64 * 1024;

/** Per-call timeout for ctrl-api fetches. Matches tools.ts TOOL_TIMEOUT_MS. */
const TOOL_TIMEOUT_MS = 25_000;

// ── Tool schemas (OpenAI Realtime `session.update` `tools` payload shape) ────

export const FILES_LIST_TOOL = {
  type: "function" as const,
  name: "files__list",
  description:
    "List files Sir has uploaded to /files (PDFs, images, spreadsheets, text, …). Use as the DISCOVERY surface — call BEFORE files__stat / files__read_text so you know the exact `path` to pass. Optional `prefix` filters on the path column (`path LIKE prefix||'%'`). Optional `q` is a free-text keyword search across path / original_filename / principal_label. Paginated (default limit 50, max 200). Returns `{items, total, limit, offset}` — each item carries `path`, `size_bytes`, `content_type`, `original_filename`, `principal_label`, `uploaded_at`. Read-only, idempotent.",
  parameters: {
    type: "object",
    properties: {
      prefix: {
        type: "string",
        description:
          "Path prefix filter (e.g. `01J9X7…` for one ULID dir). Omit to list everything.",
      },
      q: {
        type: "string",
        description:
          "Free-text keyword (case-insensitive) — matches against path, original_filename, and principal_label.",
      },
      limit: {
        type: "integer",
        description: "Max entries per page (default 50, max 200).",
        minimum: 1,
        maximum: 200,
      },
      offset: {
        type: "integer",
        description: "Skip this many entries (default 0).",
        minimum: 0,
      },
    },
  },
};

export const FILES_STAT_TOOL = {
  type: "function" as const,
  name: "files__stat",
  description:
    "Read the metadata row for ONE file Sir has uploaded. Returns the same fields as files__list, but for a single known `path`. Use after files__list / files__search when you want to confirm a file exists and check its size + content_type before reading it. 404 if the path doesn't exist or was deleted. Cheap, idempotent.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Storage path of the file (e.g. `01J9X7…/receipt.pdf`). Get this from a prior files__list / files__search result.",
      },
    },
    required: ["path"],
  },
};

export const FILES_READ_TEXT_TOOL = {
  type: "function" as const,
  name: "files__read_text",
  description:
    "Read the UTF-8 contents of a TEXT file Sir uploaded (text/*, application/json, application/xml, etc.) and return it inline. Voice-bridge enforces a 32 KB ceiling by default (hard cap 64 KB) — if the file is larger, returns `{too_large: true, size_bytes, suggestion}` instead of the body. For binary files (PDF, image, audio, video, ZIP) this tool short-circuits with `too_large` even when small — tell Sir the file is binary and offer to spawn a delegate to extract its contents. Bumps `last_accessed_at` on the file row.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Storage path of the file (from files__list / files__search).",
      },
      max_bytes: {
        type: "integer",
        description: `Lower the ceiling below the 32 KB default. Hard cap is ${READ_TEXT_HARD_CAP_BYTES} bytes; values above are clamped.`,
        minimum: 1,
        maximum: READ_TEXT_HARD_CAP_BYTES,
      },
    },
    required: ["path"],
  },
};

export const FILES_SEARCH_TOOL = {
  type: "function" as const,
  name: "files__search",
  description:
    "Keyword search across the files Sir has uploaded — matches case-insensitively against path, original_filename, and principal_label. Use when Sir asks 'find that PDF I uploaded about X' or 'pull up the receipt from last week' and you don't have the exact path. Returns the same shape as files__list (`{items, total, limit, offset}`) so you can chain into files__stat / files__read_text. Read-only.",
  parameters: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description:
          "Search needle. Multi-word phrases are matched as a substring — don't tokenise. Distinctive nouns ('Acme contract', 'pizza receipt') work best.",
      },
      limit: {
        type: "integer",
        description: "Max entries (default 20, max 200).",
        minimum: 1,
        maximum: 200,
      },
    },
    required: ["q"],
  },
};

/** The 4-tool voice files surface, as an array (the shape voice-call.ts
 *  splats into the Realtime `tools` payload). */
export const FILES_TOOLS = [
  FILES_LIST_TOOL,
  FILES_STAT_TOOL,
  FILES_READ_TEXT_TOOL,
  FILES_SEARCH_TOOL,
];

/** Names — used by isFilesToolName() for the dispatcher route check. */
const FILES_TOOL_NAMES = new Set<string>(FILES_TOOLS.map((t) => t.name));

export function isFilesToolName(name: string): boolean {
  return FILES_TOOL_NAMES.has(name);
}

// ── Dispatchers ──────────────────────────────────────────────────────────────

/** Stat row shape we read from ctrl-api. Only the size/content-type fields
 *  matter for the `read_text` ceiling check — everything else passes through
 *  in the tool result unchanged. */
interface FileStatRow {
  path?: string;
  size_bytes?: number;
  content_type?: string;
  original_filename?: string;
  principal_label?: string | null;
  uploaded_at?: string;
  last_accessed_at?: string | null;
  deleted_at?: string | null;
}

/** Internal — fetch JSON from ctrl-api with the per-call AAS_API_KEY. Mirrors
 *  tools.ts ctrlFetch but parses the response (we need to inspect size/body
 *  on `read_text` rather than just relay). */
async function ctrlGetJson(
  tenant: TenantContext,
  path: string,
  query?: Record<string, string | number>,
): Promise<{ ok: boolean; status?: number; body?: unknown; error?: string }> {
  let url = ctrlApiUrl(tenant, path);
  if (query) {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(query).map(([k, v]) => [k, String(v)]),
      ),
    ).toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ctrlApiAuthToken(tenant)}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** Internal — fetch a text blob from ctrl-api, capping the BODY at `cap` bytes.
 *  We read the bytes (not JSON) so we can both (a) cap mid-stream and (b)
 *  decode as UTF-8 only when the content_type looks textual. */
async function ctrlGetBlobText(
  tenant: TenantContext,
  path: string,
  cap: number,
): Promise<{
  ok: boolean;
  status?: number;
  content_type?: string;
  body?: string;
  truncated?: boolean;
  error?: string;
}> {
  const url = ctrlApiUrl(tenant, `/api/v1/files/blob/${path}`);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ctrlApiAuthToken(tenant)}`,
      },
      signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `ctrl-api ${res.status}` };
    }
    const contentType =
      res.headers.get("content-type") ?? "application/octet-stream";
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let truncated = false;
    let used: Uint8Array = bytes;
    if (bytes.byteLength > cap) {
      used = bytes.slice(0, cap);
      truncated = true;
    }
    const body = new TextDecoder("utf-8", { fatal: false }).decode(used);
    return {
      ok: true,
      status: res.status,
      content_type: contentType,
      body,
      truncated,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** Treat anything not in this allowlist as "binary" for the read_text path.
 *  We refuse early instead of trying to decode 2 MB of PDF as UTF-8 — the
 *  model gets a sharper signal ("binary, not readable") than mojibake.
 *  Conservative — `application/json`, `application/javascript`,
 *  `application/xml`, plus anything `text/*`. */
function looksTextual(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase().split(";")[0].trim();
  if (ct.startsWith("text/")) return true;
  if (
    ct === "application/json" ||
    ct === "application/ld+json" ||
    ct === "application/xml" ||
    ct === "application/javascript" ||
    ct === "application/x-yaml" ||
    ct === "application/yaml"
  ) {
    return true;
  }
  return false;
}

export async function dispatchFilesList(
  tenant: TenantContext,
  args: {
    prefix?: string;
    q?: string;
    limit?: number;
    offset?: number;
  },
): Promise<ToolResult> {
  const query: Record<string, string | number> = {};
  if (typeof args.prefix === "string" && args.prefix) query.prefix = args.prefix;
  if (typeof args.q === "string" && args.q) query.q = args.q;
  // Voice ceiling on limit — default 50, hard cap 200. Realtime can't
  // usefully read out hundreds of file rows on a call.
  const requested = Number(args.limit ?? 50);
  query.limit = Math.min(
    200,
    Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 50),
  );
  if (typeof args.offset === "number" && args.offset >= 0) {
    query.offset = Math.floor(args.offset);
  }
  const r = await ctrlGetJson(tenant, "/api/v1/files/list", query);
  return { ok: r.ok, status: r.status, data: r.body, error: r.error };
}

export async function dispatchFilesStat(
  tenant: TenantContext,
  args: { path?: string },
): Promise<ToolResult> {
  if (!args.path) return { ok: false, error: "path argument required" };
  const r = await ctrlGetJson(tenant, `/api/v1/files/stat/${args.path}`);
  return { ok: r.ok, status: r.status, data: r.body, error: r.error };
}

export async function dispatchFilesSearch(
  tenant: TenantContext,
  args: { q?: string; limit?: number },
): Promise<ToolResult> {
  if (!args.q || !String(args.q).trim()) {
    return { ok: false, error: "q argument required" };
  }
  const requested = Number(args.limit ?? 20);
  const limit = Math.min(
    200,
    Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 20),
  );
  const r = await ctrlGetJson(tenant, "/api/v1/files/list", {
    q: String(args.q),
    limit,
  });
  return { ok: r.ok, status: r.status, data: r.body, error: r.error };
}

/** files__read_text — two-phase: stat first (so we can cap pre-fetch), THEN
 *  blob if it's small enough + textual. Stat is cheap; the blob is the
 *  expensive one (it streams bytes off disk and into the Realtime session).
 *  Short-circuiting on `too_large` saves the network + the model context. */
export async function dispatchFilesReadText(
  tenant: TenantContext,
  args: { path?: string; max_bytes?: number },
): Promise<ToolResult> {
  if (!args.path) return { ok: false, error: "path argument required" };
  // Resolve effective ceiling. Default 32 KB; clamp to [1, hard cap] when
  // the model passes its own. The model CANNOT raise the ceiling above
  // READ_TEXT_HARD_CAP_BYTES — gpt-realtime sometimes generates a default
  // 1048576 number out of habit; clamp it.
  const requested = Number(args.max_bytes ?? READ_TEXT_DEFAULT_MAX_BYTES);
  const cap = Math.min(
    READ_TEXT_HARD_CAP_BYTES,
    Math.max(
      1,
      Number.isFinite(requested) ? Math.floor(requested) : READ_TEXT_DEFAULT_MAX_BYTES,
    ),
  );

  // Phase 1 — stat. If the file is bigger than `cap`, short-circuit.
  const stat = await ctrlGetJson(tenant, `/api/v1/files/stat/${args.path}`);
  if (!stat.ok) {
    return { ok: false, status: stat.status, data: stat.body, error: stat.error };
  }
  const row = (stat.body ?? {}) as FileStatRow;
  const sizeBytes = typeof row.size_bytes === "number" ? row.size_bytes : 0;
  const contentType = row.content_type;

  if (!looksTextual(contentType)) {
    return {
      ok: true,
      status: 200,
      data: {
        too_large: true,
        binary: true,
        path: args.path,
        size_bytes: sizeBytes,
        content_type: contentType,
        suggestion:
          "This file is binary — voice can't inline its contents. Use the dashboard /files page to download, or spawn a delegate (alfred__spawn_alfred_task) to extract it.",
      },
    };
  }

  if (sizeBytes > cap) {
    return {
      ok: true,
      status: 200,
      data: {
        too_large: true,
        path: args.path,
        size_bytes: sizeBytes,
        content_type: contentType,
        max_bytes: cap,
        suggestion: `File is ${sizeBytes} bytes, over the ${cap}-byte voice ceiling. Tell Sir it's too large to read aloud, or use the dashboard /files page to open it.`,
      },
    };
  }

  // Phase 2 — fetch the blob, decode as UTF-8 with the same cap as a
  // belt-and-braces guard (in case the stat row's size_bytes drifted under
  // concurrent writes).
  const blob = await ctrlGetBlobText(tenant, args.path, cap);
  if (!blob.ok) {
    return { ok: false, status: blob.status, error: blob.error };
  }
  return {
    ok: true,
    status: 200,
    data: {
      path: args.path,
      size_bytes: sizeBytes,
      content_type: blob.content_type ?? contentType,
      content: blob.body ?? "",
      truncated: blob.truncated === true,
    },
  };
}

/** Single entry point the voice-call dispatcher uses for any `files__*`
 *  tool. Centralises the routing so voice-call.ts doesn't need to import
 *  every dispatcher individually. */
export async function dispatchFilesTool(
  name: string,
  tenant: TenantContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "files__list":
      return dispatchFilesList(tenant, args as any);
    case "files__stat":
      return dispatchFilesStat(tenant, args as any);
    case "files__read_text":
      return dispatchFilesReadText(tenant, args as any);
    case "files__search":
      return dispatchFilesSearch(tenant, args as any);
    default:
      return { ok: false, error: `unknown files tool: ${name}` };
  }
}

/** Exposed for tests. */
export const _FILES_READ_TEXT_LIMITS = {
  DEFAULT: READ_TEXT_DEFAULT_MAX_BYTES,
  HARD_CAP: READ_TEXT_HARD_CAP_BYTES,
};
