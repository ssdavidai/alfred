// Per-app tool catalogues. McpAgent.init() reads `props.app` and registers
// only the tools matching the OAuth grant's app scope, so a token bound to
// (david, sure) cannot enumerate or call Plane tools.

import type { AppId } from "../tenants.js";
import type { ToolDef } from "./types.js";
import { ALL_TOOLS as ALL_SURE_TOOLS } from "./sure.js";
import { ALL_PLANE_TOOLS } from "./plane.js";

const REGISTRY: Record<AppId, ToolDef[]> = {
  sure: ALL_SURE_TOOLS,
  plane: ALL_PLANE_TOOLS,
};

export function getToolsForApp(app: AppId): ToolDef[] {
  return REGISTRY[app] ?? [];
}
