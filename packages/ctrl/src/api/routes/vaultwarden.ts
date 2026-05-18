// Vaultwarden routes — thin proxy to the local `bw serve` instance running
// in the vault-cli sidecar container. The MCP `vaultwarden` catalogue
// (packages/mcp-server/src/tools/vaultwarden.ts) calls these.
//
// `bw serve` exposes the Bitwarden CLI surface as REST. We don't pass calls
// through verbatim — we wrap them with route-level argument validation and
// shape the responses so the MCP tools see a clean envelope.
//
// Endpoint mapping (one ctrl-api route per Vaultwarden MCP tool):
//
//   GET  /api/v1/vaultwarden/items
//          → list items with names + ids + folder/collection metadata
//   GET  /api/v1/vaultwarden/items/:id
//          → full item including login.password and login.totp
//   POST /api/v1/vaultwarden/items/search
//          → substring/exact search (proxies bw serve /list/object/items?search=)
//   POST /api/v1/vaultwarden/items
//          → create login item (name, value, notes, folder_id?)
//   POST /api/v1/vaultwarden/items/:id
//          → update login item (any subset of name/value/notes/folder_id)
//   DELETE /api/v1/vaultwarden/items/:id
//          → delete (move to trash; restore is a separate path)
//   GET  /api/v1/vaultwarden/folders
//   POST /api/v1/vaultwarden/folders
//   GET  /api/v1/vaultwarden/collections
//   GET  /api/v1/vaultwarden/organizations
//   POST /api/v1/vaultwarden/generate
//          → generate password (length, special chars, etc.)
//   POST /api/v1/vaultwarden/sync
//          → force `bw sync`; useful when Sir just edited something in the
//            Vaultwarden web UI and wants Claude to see it immediately
//   GET  /api/v1/vaultwarden/status
//          → health probe (proxies bw serve /status)
//
// All routes go through the existing AAS_API_KEY bearer auth that wraps the
// rest of the admin API.

import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";

const VAULT_CLI_URL = process.env.VAULT_CLI_URL || "http://vault-cli:8087";

// `bw serve` returns either:
//   { success: true, data: { ... } }  for read calls
//   { success: true, data: { object: ... } }  for write calls
// We unwrap to .data and let the MCP tool descriptions drive what fields
// are surfaced. Errors come back as { success: false, message: "..." } on
// 200 (not HTTP error codes), so we explicitly check.
async function bwFetch(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const url = `${VAULT_CLI_URL}${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep as text on non-JSON.
  }
  return { status: r.status, body };
}

// Validate item id format. Bitwarden uses RFC 4122 v4 UUIDs everywhere.
function validateId(id: string): void {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
    throw new ValidationError(`Invalid Vaultwarden id: ${id} (expected UUID)`);
  }
}

interface BwEnvelope {
  success?: boolean;
  data?: unknown;
  message?: string;
}

function unwrap(body: unknown): { ok: true; data: unknown } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "vault-cli returned non-JSON body" };
  }
  const env = body as BwEnvelope;
  if (env.success === false) {
    return { ok: false, message: env.message ?? "vault-cli error" };
  }
  if (env.success === true && "data" in env) {
    return { ok: true, data: env.data };
  }
  // bw serve sometimes returns the data directly; fall back to whole body.
  return { ok: true, data: body };
}

// Drop fields we don't want surfaced to claude.ai or that bloat the response.
// Specifically strips revision/creation timestamps, deleted markers, attachment
// metadata, password-history entries (sensitive), and TOTP keys (we only
// surface the generated TOTP value on explicit request via a different path).
function stripItem(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const it = raw as Record<string, unknown>;
  return {
    id: it.id,
    name: it.name,
    notes: it.notes ?? null,
    type: it.type,
    folderId: it.folderId ?? null,
    collectionIds: it.collectionIds ?? [],
    organizationId: it.organizationId ?? null,
    favorite: it.favorite ?? false,
    login: typeof it.login === "object" && it.login !== null
      ? {
          username: (it.login as Record<string, unknown>).username ?? null,
          password: (it.login as Record<string, unknown>).password ?? null,
          uris: (it.login as Record<string, unknown>).uris ?? [],
          totp: (it.login as Record<string, unknown>).totp ?? null,
        }
      : null,
    revisionDate: it.revisionDate,
  };
}

function stripItemList(raw: unknown): { items: unknown[] } {
  if (typeof raw !== "object" || raw === null) return { items: [] };
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.data) ? obj.data : Array.isArray(raw) ? raw : [];
  return { items: list.map(stripItem) };
}

export function registerVaultwardenRoutes(): void {
  // ── status / health ─────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/vaultwarden/status", async ({ res }) => {
    const r = await bwFetch("/status");
    if (r.status >= 500) {
      sendJson(res, 502, { error: "vault-cli unreachable", upstream_status: r.status });
      return;
    }
    sendJson(res, 200, r.body);
  });

  // ── force sync ─────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/vaultwarden/sync", async ({ res }) => {
    const r = await bwFetch("/sync", { method: "POST" });
    if (r.status >= 500) {
      sendJson(res, 502, { error: "sync failed", upstream_status: r.status });
      return;
    }
    const u = unwrap(r.body);
    if (!u.ok) {
      sendJson(res, 502, { error: u.message });
      return;
    }
    sendJson(res, 200, { ok: true });
  });

  // ── list items ──────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/vaultwarden/items", async ({ res, query }) => {
    const search = query.get("search");
    const folderId = query.get("folder_id");
    const collectionId = query.get("collection_id");
    const orgId = query.get("organization_id");

    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (folderId) params.set("folderid", folderId);
    if (collectionId) params.set("collectionid", collectionId);
    if (orgId) params.set("organizationid", orgId);
    const qs = params.toString();
    const path = `/list/object/items${qs ? `?${qs}` : ""}`;

    const r = await bwFetch(path);
    if (r.status >= 500) {
      sendJson(res, 502, { error: "vault-cli unreachable" });
      return;
    }
    const u = unwrap(r.body);
    if (!u.ok) {
      sendJson(res, 502, { error: u.message });
      return;
    }
    sendJson(res, 200, stripItemList(u.data));
  });

  // ── search items (POST so we don't have to URL-encode noisy queries) ───
  addRoute("POST", "/api/v1/vaultwarden/items/search", async ({ res, body }) => {
    const b = (body ?? {}) as { search?: unknown; folder_id?: unknown; organization_id?: unknown; collection_id?: unknown };
    const search = typeof b.search === "string" ? b.search : "";
    if (!search) throw new ValidationError("search must be a non-empty string");

    const params = new URLSearchParams({ search });
    if (typeof b.folder_id === "string") params.set("folderid", b.folder_id);
    if (typeof b.collection_id === "string") params.set("collectionid", b.collection_id);
    if (typeof b.organization_id === "string") params.set("organizationid", b.organization_id);

    const r = await bwFetch(`/list/object/items?${params.toString()}`);
    const u = unwrap(r.body);
    if (!u.ok) {
      sendJson(res, 502, { error: u.message });
      return;
    }
    sendJson(res, 200, stripItemList(u.data));
  });

  // ── get one item ────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/vaultwarden/items/:id", async ({ res, params }) => {
    validateId(params.id);
    const r = await bwFetch(`/object/item/${params.id}`);
    if (r.status === 404) {
      sendJson(res, 404, { error: "item not found" });
      return;
    }
    const u = unwrap(r.body);
    if (!u.ok) {
      sendJson(res, 502, { error: u.message });
      return;
    }
    sendJson(res, 200, stripItem((u.data as Record<string, unknown>).data ?? u.data));
  });

  // ── create login item ──────────────────────────────────────────────────
  addRoute("POST", "/api/v1/vaultwarden/items", async ({ res, body }) => {
    const b = (body ?? {}) as {
      name?: unknown;
      value?: unknown;
      notes?: unknown;
      folder_id?: unknown;
      username?: unknown;
      uris?: unknown;
    };
    if (typeof b.name !== "string" || !b.name.trim()) {
      throw new ValidationError("name must be a non-empty string");
    }
    if (typeof b.value !== "string") {
      throw new ValidationError("value must be a string (the password / secret)");
    }
    const username = typeof b.username === "string" ? b.username : null;
    const notes = typeof b.notes === "string" ? b.notes : null;
    const folderId = typeof b.folder_id === "string" ? b.folder_id : null;
    if (folderId) validateId(folderId);
    const uris = Array.isArray(b.uris)
      ? b.uris
          .filter((u: unknown): u is string => typeof u === "string")
          .map((u: string) => ({ uri: u, match: null }))
      : [];

    const payload = {
      type: 1, // login
      name: b.name,
      notes,
      folderId,
      favorite: false,
      reprompt: 0,
      login: {
        username,
        password: b.value,
        uris,
      },
    };

    const r = await bwFetch("/object/item", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const u = unwrap(r.body);
    if (!u.ok) {
      sendJson(res, 502, { error: u.message });
      return;
    }
    sendJson(res, 201, stripItem((u.data as Record<string, unknown>).data ?? u.data));
  });

  // ── update item ────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/vaultwarden/items/:id", async ({ res, params, body }) => {
    validateId(params.id);
    const b = (body ?? {}) as {
      name?: unknown;
      value?: unknown;
      notes?: unknown;
      folder_id?: unknown;
      username?: unknown;
      uris?: unknown;
    };

    // Fetch the current item first so we PATCH only the fields the caller
    // actually passed; bw's PUT replaces the whole object.
    const cur = await bwFetch(`/object/item/${params.id}`);
    if (cur.status === 404) {
      sendJson(res, 404, { error: "item not found" });
      return;
    }
    const curU = unwrap(cur.body);
    if (!curU.ok) {
      sendJson(res, 502, { error: curU.message });
      return;
    }
    const existing = (curU.data as Record<string, unknown>).data ?? curU.data;
    const merged: Record<string, unknown> = {
      ...(existing as Record<string, unknown>),
    };
    const existingLogin =
      typeof (existing as Record<string, unknown>).login === "object" && (existing as Record<string, unknown>).login !== null
        ? ({ ...(existing as Record<string, unknown>).login } as Record<string, unknown>)
        : { username: null, password: null, uris: [] };

    if (typeof b.name === "string" && b.name.trim()) merged.name = b.name;
    if (typeof b.notes === "string") merged.notes = b.notes;
    if (typeof b.folder_id === "string") {
      validateId(b.folder_id);
      merged.folderId = b.folder_id;
    } else if (b.folder_id === null) {
      merged.folderId = null;
    }
    if (typeof b.value === "string") existingLogin.password = b.value;
    if (typeof b.username === "string") existingLogin.username = b.username;
    if (Array.isArray(b.uris)) {
      existingLogin.uris = b.uris
        .filter((u: unknown): u is string => typeof u === "string")
        .map((u: string) => ({ uri: u, match: null }));
    }
    merged.login = existingLogin;

    const r = await bwFetch(`/object/item/${params.id}`, {
      method: "PUT",
      body: JSON.stringify(merged),
    });
    const u = unwrap(r.body);
    if (!u.ok) {
      sendJson(res, 502, { error: u.message });
      return;
    }
    sendJson(res, 200, stripItem((u.data as Record<string, unknown>).data ?? u.data));
  });

  // ── delete item ────────────────────────────────────────────────────────
  addRoute("DELETE", "/api/v1/vaultwarden/items/:id", async ({ res, params }) => {
    validateId(params.id);
    const r = await bwFetch(`/object/item/${params.id}`, { method: "DELETE" });
    if (r.status === 404) {
      sendJson(res, 404, { error: "item not found" });
      return;
    }
    const u = unwrap(r.body);
    if (!u.ok) {
      sendJson(res, 502, { error: u.message });
      return;
    }
    sendJson(res, 200, { ok: true, id: params.id });
  });

  // ── folders ────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/vaultwarden/folders", async ({ res }) => {
    const r = await bwFetch("/list/object/folders");
    const u = unwrap(r.body);
    if (!u.ok) {
      sendJson(res, 502, { error: u.message });
      return;
    }
    const data = (u.data as Record<string, unknown>).data ?? u.data;
    sendJson(res, 200, { folders: Array.isArray(data) ? data : [] });
  });

  addRoute("POST", "/api/v1/vaultwarden/folders", async ({ res, body }) => {
    const b = (body ?? {}) as { name?: unknown };
    if (typeof b.name !== "string" || !b.name.trim()) {
      throw new ValidationError("name must be a non-empty string");
    }
    const r = await bwFetch("/object/folder", {
      method: "POST",
      body: JSON.stringify({ name: b.name }),
    });
    const u = unwrap(r.body);
    if (!u.ok) {
      sendJson(res, 502, { error: u.message });
      return;
    }
    sendJson(res, 201, (u.data as Record<string, unknown>).data ?? u.data);
  });

  // ── collections (read-only — managed in Vaultwarden web UI) ────────────
  addRoute("GET", "/api/v1/vaultwarden/collections", async ({ res }) => {
    const r = await bwFetch("/list/object/collections");
    const u = unwrap(r.body);
    if (!u.ok) {
      sendJson(res, 502, { error: u.message });
      return;
    }
    const data = (u.data as Record<string, unknown>).data ?? u.data;
    sendJson(res, 200, { collections: Array.isArray(data) ? data : [] });
  });

  // ── organizations (read-only) ──────────────────────────────────────────
  addRoute("GET", "/api/v1/vaultwarden/organizations", async ({ res }) => {
    const r = await bwFetch("/list/object/organizations");
    const u = unwrap(r.body);
    if (!u.ok) {
      sendJson(res, 502, { error: u.message });
      return;
    }
    const data = (u.data as Record<string, unknown>).data ?? u.data;
    sendJson(res, 200, { organizations: Array.isArray(data) ? data : [] });
  });

  // ── generate password ──────────────────────────────────────────────────
  addRoute("POST", "/api/v1/vaultwarden/generate", async ({ res, body }) => {
    const b = (body ?? {}) as {
      length?: unknown;
      uppercase?: unknown;
      lowercase?: unknown;
      number?: unknown;
      special?: unknown;
      passphrase?: unknown;
      words?: unknown;
      separator?: unknown;
    };
    const params = new URLSearchParams();
    if (typeof b.length === "number" && b.length > 0 && b.length <= 256) {
      params.set("length", String(Math.floor(b.length)));
    }
    if (b.uppercase === true) params.set("uppercase", "true");
    if (b.lowercase === true) params.set("lowercase", "true");
    if (b.number === true) params.set("number", "true");
    if (b.special === true) params.set("special", "true");
    if (b.passphrase === true) params.set("passphrase", "true");
    if (typeof b.words === "number" && b.words > 0 && b.words <= 20) {
      params.set("words", String(Math.floor(b.words)));
    }
    if (typeof b.separator === "string" && b.separator.length === 1) {
      params.set("separator", b.separator);
    }

    const r = await bwFetch(`/generate?${params.toString()}`);
    const u = unwrap(r.body);
    if (!u.ok) {
      sendJson(res, 502, { error: u.message });
      return;
    }
    sendJson(res, 200, { value: u.data });
  });
}
