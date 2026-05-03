// Per-tenant config stored in MCP_TENANTS KV. Provisioner writes one row per
// tenant at ship-time (mirroring the peer-registration pattern from #761).
// The worker reads it during the OAuth /authorize approval flow to bind the
// access token's `props` to the right tenant and ctrl-api credentials.

import type { Env } from "./env.js";

export interface TenantConfig {
  /**
   * Human-readable tenant id used in URLs (e.g. "david", "rapali", "miguel").
   * Must match `[a-z0-9][a-z0-9-]*` and be unique across the fleet.
   */
  id: string;
  /** Display name for the OAuth approval page header. */
  label: string;
  /** Base URL of the tenant's ctrl-api (no trailing slash). */
  ctrlUrl: string;
  /** Bearer token forwarded to the ctrl-api on every backend call. */
  aasApiKey: string;
  /**
   * Pre-shared secret Sir enters on /authorize to approve a new Claude
   * Custom Connector registration. Per-tenant so different tenants can have
   * different operators / different rotation cadences.
   */
  approvalSecret: string;
  /** OPTIONAL Cloudflare Access service-token credentials. */
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

/**
 * Apps surfaced through this Worker. Each maps to a tool catalogue; the
 * McpAgent registers only the tools matching `props.app` so the catalogue
 * stays scoped to what the OAuth grant authorises.
 */
export type AppId = "sure" | "plane";

export const SUPPORTED_APPS: ReadonlySet<AppId> = new Set(["sure", "plane"]);

export function isAppId(value: string): value is AppId {
  return (SUPPORTED_APPS as Set<string>).has(value);
}

/**
 * Read a tenant's config from KV. Returns null on missing key, throws on
 * malformed JSON (operator misconfig — surface loudly).
 */
export async function getTenantConfig(
  env: Env,
  tenantId: string,
): Promise<TenantConfig | null> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(tenantId)) return null;
  const raw = await env.MCP_TENANTS.get(tenantId);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as TenantConfig;
  if (!parsed.ctrlUrl || !parsed.aasApiKey || !parsed.approvalSecret) {
    throw new Error(`MCP_TENANTS["${tenantId}"] missing required fields`);
  }
  parsed.id = tenantId;
  parsed.label = parsed.label ?? tenantId;
  return parsed;
}

/**
 * Parse a request URL into (tenant_id, app_id) when the path matches the
 * canonical /mcp/<tenant>/<app>(/<sub>)? shape. Returns null otherwise (so
 * the caller can fall through to other routes — /health, /.well-known,
 * etc.). The leading /mcp prefix lines up with the OAuthProvider's
 * apiRoute = ["/mcp"] so wrangler's startsWith matcher captures every
 * tenant + app combo without per-tenant config in wrangler.jsonc.
 */
export function parseTenantAppPath(
  pathname: string,
): { tenantId: string; appId: AppId; subpath: string } | null {
  const match = pathname.match(
    /^\/mcp\/([a-z0-9][a-z0-9-]*)\/([a-z]+)(\/.*)?$/,
  );
  if (!match) return null;
  const [, tenantId, app, subpath] = match;
  if (!isAppId(app)) return null;
  return { tenantId, appId: app, subpath: subpath ?? "" };
}
