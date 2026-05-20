// Vaultwarden MCP tool catalogue — exposes the per-tenant Vaultwarden
// secrets manager to claude.ai. Every tool routes through ctrl-api's
// /api/v1/vaultwarden/* endpoints (see packages/ctrl/src/api/routes/
// vaultwarden.ts), which themselves proxy a long-running `bw serve`
// instance in the vault-cli sidecar. So the call chain is:
//
//   claude.ai  →  /vaultwarden/mcp (this server)
//                 → ctrl-api /api/v1/vaultwarden/*
//                   → vault-cli :8087 (bw serve)
//                     → vaultwarden :80
//
// Why the catalogue is intentionally narrow: bw serve exposes more shapes
// (attachment download/upload, item move, password history, share) than
// we surface here. Every additional tool is one more attack surface from
// a 1-hour bearer token, so we ship the safe-read + safe-write subset Sir
// realistically wants from a chat: list/search/get items, create/update/
// delete login items, generate passwords, pick a folder. Attachments,
// sends, and password history can be added later if there's a real flow
// that needs them.

import { z } from "zod";
import type { ToolDef } from "./types.js";

const Uuid = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    "must be a Bitwarden id (UUID v4)",
  );

export const ALL_VAULTWARDEN_TOOLS: ToolDef[] = [
  // ── status ────────────────────────────────────────────────────────────
  {
    name: "vaultwarden_status",
    description:
      "Probe the local Vaultwarden + bw serve session. Returns serverUrl, lastSync, and userEmail. Use as a sanity check when other tools start failing — most often a fail here means vault-cli's bw session expired and the container is mid-restart. NOT idempotent in any side-effecting sense; always cheap to call. Backing: GET /api/v1/vaultwarden/status.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "GET", path: "/api/v1/vaultwarden/status" }),
  },

  // ── force a sync (Sir just edited in the web UI) ───────────────────────
  {
    name: "vaultwarden_sync",
    description:
      "Force vault-cli to re-pull the vault from the Vaultwarden server. Sir's vault-cli already auto-syncs every 5 minutes, but call this when Sir says 'I just changed the X password in the Vaultwarden web UI' so subsequent list/get tools see the fresh value without waiting. Returns {ok: true}. Backing: POST /api/v1/vaultwarden/sync.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "POST", path: "/api/v1/vaultwarden/sync" }),
  },

  // ── list items ────────────────────────────────────────────────────────
  {
    name: "list_vault_items",
    description:
      "List vault items (logins, secure notes, etc.) with optional filters. Returns name + id + folder/collection/organization metadata + login.username — but NOT login.password. Use when Sir asks 'what API keys do I have?' or 'list everything in the work folder'. To see a password value, follow up with `get_vault_item` on the specific id. Filters: search (substring on name + URI + username), folder_id, collection_id, organization_id. Backing: GET /api/v1/vaultwarden/items.",
    inputSchema: z.object({
      search: z.string().optional().describe("Substring search across item name, URIs, and login.username"),
      folder_id: Uuid.optional().describe("Restrict to one folder"),
      collection_id: Uuid.optional().describe("Restrict to one organization collection"),
      organization_id: Uuid.optional().describe("Restrict to one organization"),
    }),
    buildRequest: ({ search, folder_id, collection_id, organization_id }) => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (folder_id) params.set("folder_id", folder_id);
      if (collection_id) params.set("collection_id", collection_id);
      if (organization_id) params.set("organization_id", organization_id);
      const qs = params.toString();
      return { method: "GET", path: `/api/v1/vaultwarden/items${qs ? `?${qs}` : ""}` };
    },
  },

  // ── search items (POST so the search string can carry quotes/specials) ─
  {
    name: "search_vault_items",
    description:
      "Substring search across vault items. Same shape as `list_vault_items({search})` but POST so search strings with special characters don't need URL encoding. Returns the same metadata — passwords are not included; chase with `get_vault_item` for values. Backing: POST /api/v1/vaultwarden/items/search.",
    inputSchema: z.object({
      search: z.string().min(1).describe("Substring to match"),
      folder_id: Uuid.optional(),
      collection_id: Uuid.optional(),
      organization_id: Uuid.optional(),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/vaultwarden/items/search",
      body: args,
    }),
  },

  // ── get one item (returns the password) ───────────────────────────────
  {
    name: "get_vault_item",
    description:
      "Fetch a single vault item by id, INCLUDING login.password and (if present) login.totp. This is the ONLY tool in the catalogue that returns secret values; use it after `list_vault_items` / `search_vault_items` to surface the actual credential to Sir. Don't dump the response JSON — Sir wants the password value, not the envelope. Idempotent. Backing: GET /api/v1/vaultwarden/items/:id.",
    inputSchema: z.object({
      id: Uuid.describe("The Bitwarden item id (UUID)"),
    }),
    buildRequest: ({ id }) => ({
      method: "GET",
      path: `/api/v1/vaultwarden/items/${id}`,
    }),
  },

  // ── create login item ──────────────────────────────────────────────────
  {
    name: "create_vault_item",
    description:
      "Create a new login item. Required: name + value (the password / secret). Optional: notes, username, uris (array of URLs), folder_id. Use when Sir says 'save this API key as <name>' or 'add a Wise password'. NOT idempotent — re-running creates duplicates; if retrying after a network error, search by name first. Returns the created item with its new id. Backing: POST /api/v1/vaultwarden/items.",
    inputSchema: z.object({
      name: z.string().min(1).describe("Display name; this becomes the env-var name when migrate.sh imports back"),
      value: z.string().describe("The password / secret value"),
      username: z.string().optional().describe("Login username (for credentials that pair an account with a password)"),
      notes: z.string().optional().describe("Plaintext notes — used by migrate.sh as 'origin record' when importing back into .env"),
      folder_id: Uuid.optional().describe("Folder to file the new item under — get one from `list_vault_folders`"),
      uris: z.array(z.string()).optional().describe("Associated URLs (e.g. login URLs)"),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/vaultwarden/items",
      body: args,
    }),
  },

  // ── update item ────────────────────────────────────────────────────────
  {
    name: "update_vault_item",
    description:
      "Patch an existing login item. Pass only the fields Sir wants changed — anything omitted is preserved. Common shapes: rotate a value (`{id, value: 'newpw'}`), rename (`{id, name: 'WISE_KEY'}`), move folder (`{id, folder_id: '...'}`). After this returns, call `vault_refresh` to push the new value into /opt/alfred/compose/.env and restart impacted services — or tell Sir to do it manually. Backing: POST /api/v1/vaultwarden/items/:id (server-side merge).",
    inputSchema: z.object({
      id: Uuid,
      name: z.string().optional(),
      value: z.string().optional(),
      username: z.string().optional(),
      notes: z.string().optional(),
      folder_id: Uuid.nullable().optional().describe("Pass null to detach from any folder"),
      uris: z.array(z.string()).optional(),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: `/api/v1/vaultwarden/items/${args.id}`,
      body: args,
    }),
  },

  // ── delete item ────────────────────────────────────────────────────────
  {
    name: "delete_vault_item",
    description:
      "Delete a vault item (moves to Vaultwarden's trash, recoverable from the web UI for 30 days). Use sparingly — Sir's tenant secrets often have side effects when deleted (services that lose their API key on next reboot). Confirm with Sir before deleting unless he explicitly named the item. Returns {ok: true, id}. Backing: DELETE /api/v1/vaultwarden/items/:id.",
    inputSchema: z.object({
      id: Uuid,
    }),
    buildRequest: ({ id }) => ({
      method: "DELETE",
      path: `/api/v1/vaultwarden/items/${id}`,
    }),
  },

  // ── folders (read + create) ────────────────────────────────────────────
  {
    name: "list_vault_folders",
    description:
      "List all folders in Sir's vault. Returns id + name. Use when Sir mentions a folder by name (`'put it in work'`) — you need the id for `create_vault_item({folder_id})`. Backing: GET /api/v1/vaultwarden/folders.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "GET", path: "/api/v1/vaultwarden/folders" }),
  },

  {
    name: "create_vault_folder",
    description:
      "Create a new folder. Folders organize items in the web UI; they don't grant access (collections do that). Returns the new folder with its id. NOT idempotent — Sir can have two folders with the same name; check `list_vault_folders` first if dedup matters. Backing: POST /api/v1/vaultwarden/folders.",
    inputSchema: z.object({
      name: z.string().min(1),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/vaultwarden/folders",
      body: args,
    }),
  },

  // ── collections + organizations (read-only) ────────────────────────────
  {
    name: "list_vault_collections",
    description:
      "List organization collections. Sir's tenant Vaultwarden runs single-user by default, so this is empty unless Sir has set up a Bitwarden organization in the web UI. Read-only here — collection creation goes through the web UI. Backing: GET /api/v1/vaultwarden/collections.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "GET", path: "/api/v1/vaultwarden/collections" }),
  },

  {
    name: "list_vault_organizations",
    description:
      "List Bitwarden organizations Sir is a member of. Like collections, only populated if Sir set up an org in the web UI. Backing: GET /api/v1/vaultwarden/organizations.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "GET", path: "/api/v1/vaultwarden/organizations" }),
  },

  // ── password generator ────────────────────────────────────────────────
  {
    name: "generate_password",
    description:
      "Generate a random password using bw serve's built-in generator. Defaults to a 32-char password with letters + digits + symbols. Pass `passphrase: true` for diceware-style. Use when Sir asks 'give me a strong password' or before `create_vault_item` for a brand-new credential. The value is returned but NOT saved — chain with `create_vault_item({value: <returned>})` to persist. Backing: POST /api/v1/vaultwarden/generate.",
    inputSchema: z.object({
      length: z.number().int().positive().max(256).optional().describe("Default 32"),
      uppercase: z.boolean().optional().describe("Include A-Z (default true)"),
      lowercase: z.boolean().optional().describe("Include a-z (default true)"),
      number: z.boolean().optional().describe("Include digits (default true)"),
      special: z.boolean().optional().describe("Include symbols !@#$%^&* etc. (default true)"),
      passphrase: z.boolean().optional().describe("Generate diceware passphrase instead of random chars"),
      words: z.number().int().positive().max(20).optional().describe("Word count for passphrase (default 4)"),
      separator: z.string().length(1).optional().describe("Single-char separator for passphrase (default -)"),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/vaultwarden/generate",
      body: args,
    }),
  },

  // ── refresh-into-env (rotation propagation) ───────────────────────────
  {
    name: "vault_refresh",
    description:
      "Rewrite /opt/alfred/compose/.env from the current Vaultwarden state and restart impacted tenant services. Use this after `update_vault_item` so the rotated secret actually reaches the running containers. Default restarts openclaw + alfred (the most common consumers); pass `services: [...]` for narrower restarts (e.g. ['sure-web', 'sure-worker'] for SURE_POSTGRES_PASSWORD rotation). Refuses to restart ctrl-api itself (would 502 the response). Backing: POST /api/v1/admin/vault/refresh.",
    inputSchema: z.object({
      services: z
        .array(z.string().regex(/^[a-zA-Z0-9_-]+$/))
        .optional()
        .describe(
          "Compose services to recreate after vault-init runs. Default: ['openclaw', 'alfred'].",
        ),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/admin/vault/refresh",
      body: args,
    }),
  },
];
