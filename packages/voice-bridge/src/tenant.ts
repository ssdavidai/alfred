// Per-call lookup against the SaaS internal endpoint.
// Returns the tenant's Tailscale host + AAS_API_KEY (for tool dispatch in
// Phase 3) and their assigned phone number.

import { config } from "./config.js";

export interface TenantContext {
  tailscaleHost: string;
  aasApiKey: string;
  phoneNumber: string | null;
}

export async function fetchTenantContext(
  tenantId: string,
): Promise<TenantContext> {
  const url = `${config.saasInternalUrl}/api/internal/voice-bridge/tenant/${encodeURIComponent(tenantId)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.internalToken}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    throw new Error(
      `Tenant lookup failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const body = (await res.json()) as TenantContext;
  if (!body.tailscaleHost || !body.aasApiKey) {
    throw new Error("Tenant lookup response missing tailscaleHost or aasApiKey");
  }
  return body;
}
