// Per-app tool catalogues. The MCP server reads the OAuth grant's `props.appId`
// and registers ONLY that app's tools so a token bound to (sure) can't
// enumerate or call Plane tools — and vice versa.

import type { ToolDef } from "./types.js";
import { ALL_TOOLS as ALL_SURE_TOOLS } from "./sure.js";
import { ALL_ALFRED_TOOLS } from "./alfred.js";
import { ALL_VAULTWARDEN_TOOLS } from "./vaultwarden.js";
import { ALL_EXECUTE_TOOLS } from "./execute.js";
import { ALL_HERMES_TOOLS } from "./hermes.js";
import { ALL_HASS_TOOLS } from "./hass.js";
import { ALL_FILES_TOOLS } from "./files.js";
import { ALL_PAPERCLIP_TOOLS } from "./paperclip.js";

// `hermes` — 6th MCP server (added 2026-05-26). Surfaces the Hermes runtime
// itself (scheduling, run delegation, model selection) so the voice agent
// can schedule reminders and delegate background work.
//
// `hass` — 7th MCP server (added 2026-05-29 / #110 PR2). Surfaces the
// principal's Home Assistant install via 11 read tools (registry / state
// / history / logbook / calendars / fuzzy entity resolution) plus 5 PR3
// placeholders for the write surface (call_service / propose / apply /
// rollback / subscribe). The write tools mint a `decision_ref` and honour
// the loop-guard contract pinned by migration 0005_ha_channel.sql.
//
// `files` — 8th MCP server (added 2026-05-29 / #114 PR2). Surfaces the
// principal's local Store-5 blob store so in-tenant agents can list,
// search, read, describe, create, and delete files the principal dropped
// in via /files. The voice-bridge catalogue subset is deferred to PR 5 of
// issue #114 (read-only tools only on voice).
//
// `paperclip` — 9th MCP server (added 2026-06-03 / epic #242). Surfaces the
// per-tenant Paperclip company/agent bootstrap admin surface (create company,
// create agent, register principal user, plus read-backs). Tools proxy to
// ctrl-api /api/v1/paperclip/admin/* which performs the privileged Paperclip
// calls server-side via the seed-credential cookie session. The skill
// `alfred-paperclip-bootstrap` drives these (confirm-first flow). Contract:
// docs/PAPERCLIP-BOOTSTRAP-CONTRACT.md C2.
export type AppId =
  | "sure"
  | "alfred"
  | "vaultwarden"
  | "execute"
  | "hermes"
  | "hass"
  | "files"
  | "paperclip-admin";

export const SUPPORTED_APPS: ReadonlySet<AppId> = new Set([
  "sure",
  "alfred",
  "vaultwarden",
  "execute",
  "hermes",
  "hass",
  "files",
  "paperclip-admin",
]);

export function isAppId(value: string): value is AppId {
  return (SUPPORTED_APPS as Set<string>).has(value);
}

const REGISTRY: Record<AppId, ToolDef[]> = {
  sure: ALL_SURE_TOOLS,
  alfred: ALL_ALFRED_TOOLS,
  vaultwarden: ALL_VAULTWARDEN_TOOLS,
  execute: ALL_EXECUTE_TOOLS,
  hermes: ALL_HERMES_TOOLS,
  hass: ALL_HASS_TOOLS,
  files: ALL_FILES_TOOLS,
  "paperclip-admin": ALL_PAPERCLIP_TOOLS,
};

export function getToolsForApp(app: AppId): ToolDef[] {
  return REGISTRY[app] ?? [];
}
