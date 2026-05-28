// Per-call lookups.
//
//   fetchTenantContext(tenantId) — SaaS internal: { tailscaleHost, aasApiKey,
//                                  phoneNumber }. Required to bridge the call.
//   fetchVoiceContext(tenant)    — tenant ctrl-api: cross-channel context
//                                  bundle for the Realtime instructions primer.
//                                  Best-effort; failure means the agent loses
//                                  cross-channel memory but the call still works.
//
// Two deploy modes:
//   * Single-VM (alfred-black): ctrl-api is on the same compose network as
//     this bridge. Set AAS_API_KEY + TWILIO_PHONE_NUMBER on the bridge env
//     and we short-circuit the SaaS handshake — voice-context, transcript
//     ingest, and tenant identity all come from the local ctrl-api at
//     ${SAAS_INTERNAL_URL} (which on alfred-black is http://ctrl-api:3100).
//   * Multi-tenant SaaS (legacy): the bridge calls a SaaS internal endpoint
//     to look up the per-tenant tailscale host + AAS key, then hits the
//     tenant's ctrl-api over Tailscale on :3100.

import { config } from "./config.js";

/** Single-VM mode is engaged by docker-compose on the monorepo build. */
function singleVmMode(): boolean {
  return config.singleVmMode;
}

/** Build the ctrl-api URL for the current deploy mode.
 *
 *  Exported so the tool dispatchers in tools.ts share the same single-VM /
 *  legacy-SaaS routing. Prior to 2026-05-28 tools.ts hardcoded the legacy
 *  `https://${tailscaleHost}:3100` shape, which on single-VM (tailscaleHost
 *  is the sentinel string "local") triggered an instant DNS failure (~6ms),
 *  surfacing as `composio_execute ok=false status=err 6ms` during voice
 *  calls. The fetch never even left the container. */
export function ctrlApiUrl(tenant: TenantContext, path: string): string {
  if (singleVmMode()) {
    return `${config.saasInternalUrl}${path}`;
  }
  return `https://${tenant.tailscaleHost}:3100${path}`;
}

/**
 * Bearer token for the ctrl-api call. Single-VM mode presents this bridge's
 * own internalToken — ctrl-api's auth.ts accepts it as a SCOPED bearer for
 * the voice-bridge allowlist (see VOICE_BRIDGE_ALLOWLIST). Legacy SaaS
 * mode forwards the per-tenant aasApiKey returned by the SaaS handshake.
 *
 * Exported for the same reason as ctrlApiUrl above — tools.ts needs the
 * exact same single-VM routing.
 */
export function ctrlApiAuthToken(tenant: TenantContext): string {
  return singleVmMode() ? config.internalToken : tenant.aasApiKey;
}

export interface TenantContext {
  tailscaleHost: string;
  aasApiKey: string;
  phoneNumber: string | null;
}

export interface VoiceContextBundle {
  memoryMd: string;
  voiceSkill: string;
  openMatters: Array<{ name: string; summary?: string }>;
  openTasks: Array<{ name: string; due?: string; summary?: string }>;
  recentSessions: Array<{ at: string; channel: string; summary: string }>;
  // Per-MCP-server skill cheatsheets — one entry per server that has a
  // corresponding ops skill (vault-operations for alfred, sure-operations
  // for sure, plane-operations for plane, connected-apps for execute).
  // Each carries the SKILL.md description + H1 intro paragraph (~600 chars)
  // so the model knows WHEN to reach for each server. Per-tool detail is
  // in the tool schemas declared via session.update tools.
  //
  // Replaces the v1 `composioToolkits` action-dump (49+ action rows of
  // English-noise prose that diluted the persona on 2026-05-26 and let
  // bilingual primer content code-switch the agent). The model uses
  // `execute__list_composio_tools` on demand if it ever needs to enumerate.
  skills?: Array<{ name: string; description: string; body: string }>;
  generatedAt: string;
}

export async function fetchTenantContext(
  tenantId: string,
): Promise<TenantContext> {
  // Single-VM short-circuit: there's no SaaS to ask, so synthesize a
  // TenantContext from env. tailscaleHost stays as a sentinel string
  // ("local") because the URL builders above already key off
  // singleVmMode(). aasApiKey is empty here because the bridge does NOT
  // hold the ctrl-api master key on the monorepo build — ctrlApiAuthToken()
  // routes through internalToken instead (see auth.ts allowlist).
  if (singleVmMode()) {
    return {
      tailscaleHost: "local",
      aasApiKey: "",
      phoneNumber: config.ownerPhoneNumber || null,
    };
  }

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

export async function fetchVoiceContext(
  tenant: TenantContext,
): Promise<VoiceContextBundle | null> {
  const url = ctrlApiUrl(tenant, "/api/v1/phone/voice-context");
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${ctrlApiAuthToken(tenant)}` },
      signal: AbortSignal.timeout(3_500),
    });
    if (!res.ok) return null;
    return (await res.json()) as VoiceContextBundle;
  } catch {
    return null;
  }
}

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
  ts: string;
}

export async function postCallTranscript(
  tenant: TenantContext,
  payload: {
    callId: string;
    from: string;
    to: string;
    direction: "inbound" | "outbound";
    started_at: string;
    ended_at: string;
    transcript: TranscriptTurn[];
    summary?: string;
  },
): Promise<void> {
  const url = ctrlApiUrl(tenant, "/api/v1/phone/transcript");
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctrlApiAuthToken(tenant)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    console.error(`[transcript] failed to post`, err);
  }
}
