// Per-app tool catalogues. The MCP server reads the OAuth grant's `props.appId`
// and registers ONLY that app's tools so a token bound to (sure) can't
// enumerate or call Plane tools — and vice versa.

import type { ToolDef } from "./types.js";
import { ALL_TOOLS as ALL_SURE_TOOLS } from "./sure.js";
import { ALL_PLANE_TOOLS } from "./plane.js";
import { ALL_ALFRED_TOOLS } from "./alfred.js";
import { ALL_VAULTWARDEN_TOOLS } from "./vaultwarden.js";
import { ALL_EXECUTE_TOOLS } from "./execute.js";
import { ALL_HERMES_TOOLS } from "./hermes.js";
import { ALL_HASS_TOOLS } from "./hass.js";

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
export type AppId =
  | "sure"
  | "plane"
  | "alfred"
  | "vaultwarden"
  | "execute"
  | "hermes"
  | "hass";

export const SUPPORTED_APPS: ReadonlySet<AppId> = new Set([
  "sure",
  "plane",
  "alfred",
  "vaultwarden",
  "execute",
  "hermes",
  "hass",
]);

export function isAppId(value: string): value is AppId {
  return (SUPPORTED_APPS as Set<string>).has(value);
}

const REGISTRY: Record<AppId, ToolDef[]> = {
  sure: ALL_SURE_TOOLS,
  plane: ALL_PLANE_TOOLS,
  alfred: ALL_ALFRED_TOOLS,
  vaultwarden: ALL_VAULTWARDEN_TOOLS,
  execute: ALL_EXECUTE_TOOLS,
  hermes: ALL_HERMES_TOOLS,
  hass: ALL_HASS_TOOLS,
};

export function getToolsForApp(app: AppId): ToolDef[] {
  return REGISTRY[app] ?? [];
}
