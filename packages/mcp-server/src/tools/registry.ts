// Per-app tool catalogues. The MCP server reads the OAuth grant's `props.appId`
// and registers ONLY that app's tools so a token bound to (sure) can't
// enumerate or call Plane tools — and vice versa.

import type { ToolDef } from "./types.js";
import { ALL_TOOLS as ALL_SURE_TOOLS } from "./sure.js";
import { ALL_PLANE_TOOLS } from "./plane.js";
import { ALL_ALFRED_TOOLS } from "./alfred.js";

export type AppId = "sure" | "plane" | "alfred";

export const SUPPORTED_APPS: ReadonlySet<AppId> = new Set(["sure", "plane", "alfred"]);

export function isAppId(value: string): value is AppId {
  return (SUPPORTED_APPS as Set<string>).has(value);
}

const REGISTRY: Record<AppId, ToolDef[]> = {
  sure: ALL_SURE_TOOLS,
  plane: ALL_PLANE_TOOLS,
  alfred: ALL_ALFRED_TOOLS,
};

export function getToolsForApp(app: AppId): ToolDef[] {
  return REGISTRY[app] ?? [];
}
