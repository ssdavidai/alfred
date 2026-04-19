// Per-call lookups.
//
//   fetchTenantContext(tenantId) — SaaS internal: { tailscaleHost, aasApiKey,
//                                  phoneNumber }. Required to bridge the call.
//   fetchVoiceContext(tenant)    — tenant ctrl-api: cross-channel context
//                                  bundle for the Realtime instructions primer.
//                                  Best-effort; failure means the agent loses
//                                  cross-channel memory but the call still works.

import { config } from "./config.js";

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
  generatedAt: string;
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

export async function fetchVoiceContext(
  tenant: TenantContext,
): Promise<VoiceContextBundle | null> {
  const url = `https://${tenant.tailscaleHost}:3100/api/v1/phone/voice-context`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${tenant.aasApiKey}` },
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
  const url = `https://${tenant.tailscaleHost}:3100/api/v1/phone/transcript`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tenant.aasApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    console.error(`[transcript] failed to post`, err);
  }
}
