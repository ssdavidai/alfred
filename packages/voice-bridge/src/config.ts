// Runtime config for the Voice Bridge. Loaded once on boot from env.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  // HTTP+WS server port (Caddy proxies wss://alfred.black/voice/* here)
  port: Number(optional("VOICE_BRIDGE_PORT", "9000")),
  // Optional metrics endpoint (Phase 9)
  metricsPort: Number(optional("VOICE_BRIDGE_METRICS_PORT", "9001")),

  // Shared secret with SaaS — used to verify the ?sig= query on WS upgrade
  // and as Bearer for SaaS internal endpoints we call (e.g. tenant lookup).
  internalToken: required("VOICE_BRIDGE_INTERNAL_TOKEN"),

  // SaaS internal API base (e.g. https://alfred.black). The bridge is co-hosted
  // with SaaS on the same VM, so this is reachable over the host network.
  saasInternalUrl: optional("SAAS_INTERNAL_URL", "https://alfred.black"),

  // Single-VM mode. When ENABLE_SINGLE_VM_MODE=1 (set by docker-compose on
  // the alfred-black monorepo build), the bridge skips the legacy SaaS
  // tenant handshake (fetchTenantContext) and talks to the local ctrl-api
  // directly via saasInternalUrl (= http://ctrl-api:3100). Authentication
  // is the bridge's own internalToken — ctrl-api accepts it as a SCOPED
  // Bearer for exactly the two routes this service needs
  // (/voice-context GET + /transcript POST). See ctrl-api auth.ts
  // VOICE_BRIDGE_ALLOWLIST.
  //
  // Earlier Phase-4 iterations wired AAS_API_KEY (the ctrl-api master key)
  // into this container — a serious over-privilege. Removed in Phase 4.1.
  singleVmMode: optional("ENABLE_SINGLE_VM_MODE", "") === "1",
  ownerPhoneNumber: optional("TWILIO_PHONE_NUMBER", ""),

  // OpenAI Realtime config. Default model tracks the latest GA slug —
  // 2026-05-26: bumped gpt-realtime-1.5 → gpt-realtime-2 (GA model with
  // better non-American accent stability, which we lean on for the
  // Received-Pronunciation butler persona).
  openaiApiKey: required("OPENAI_API_KEY"),
  openaiModel: optional("OPENAI_REALTIME_MODEL", "gpt-realtime-2"),
  openaiVoice: optional("OPENAI_REALTIME_VOICE", "cedar"),
  // Optional override for the OpenAI Realtime WS base URL. Production leaves
  // this empty and points at wss://api.openai.com/v1/realtime. Tests set it
  // to ws://localhost:<port> with a mock server emulating session.created /
  // session.updated to validate the connect-handshake race fix.
  openaiRealtimeBaseUrl: optional(
    "OPENAI_REALTIME_BASE_URL",
    "wss://api.openai.com/v1/realtime",
  ),

  // Twilio account auth token — used to verify X-Twilio-Signature on the
  // inbound TwiML webhook. When empty we still serve TwiML but log a
  // warning. Set this in /opt/alfred/.env (or via the /channels SMS card)
  // to enable strict signature validation.
  twilioAuthToken: optional("TWILIO_AUTH_TOKEN", ""),

  // MCP-client wiring (see mcp-clients.ts). voice-bridge connects to each
  // of mcp-server's per-app HTTP endpoints as a programmatic client, the
  // same five servers Hermes-main connects to over stdio. The internal
  // docker URL avoids a Caddy hop on every tool call.
  mcpServerUrl: optional("MCP_SERVER_URL", "http://mcp-server:8787"),
  // Bearer token the bypass added in PR #44/#45 accepts. When this is
  // empty voice-bridge falls back to no auth and the MCP servers reject
  // every tools/call — surfacing as agent errors mid-call, which is what
  // we want for that misconfiguration (loud, debuggable).
  mcpApprovalSecret: optional("MCP_APPROVAL_SECRET", ""),

  // OPTIONAL external MCP servers, beyond the 6 baked-in mcp-server apps.
  // Used for tenant-specific surfaces — e.g. a client tenant wires in a
  // 7th server `cdsk` (Contractor's Desk) at https://joe.ngrok.pizza/mcp/mcp.
  // Format: comma-separated `name=url` pairs; optional `=bearer` if the
  // external server needs an Authorization header.
  //   MCP_EXTERNAL_SERVERS="cdsk=https://joe.ngrok.pizza/mcp/mcp"
  //   MCP_EXTERNAL_SERVERS="cdsk=https://x/mcp,xyz=https://y/mcp=BEARER"
  // Empty by default — no external servers on a stock tenant.
  mcpExternalServers: optional("MCP_EXTERNAL_SERVERS", ""),

  // Per-call hard cap to prevent runaway minutes
  maxCallSeconds: Number(optional("MAX_CALL_SECONDS", "1800")),
  // Idle hangup if no audio either way (Phase 9 hardening)
  idleHangupSeconds: Number(optional("IDLE_HANGUP_SECONDS", "60")),

  // ── ESPHome Native API (issue #112, PR1 skeleton) ───────────────────────
  // Second listener that speaks the ESPHome Native API so Home Assistant's
  // ESPHome integration discovers voice-bridge over mDNS and pairs with us.
  // PR1 ships the skeleton: handshake + device info + entity list. The
  // voice_assistant audio flow lands in PR2/PR3.
  //
  // Default is opt-in (ESPHOME_API_ENABLED=0) per spec §6 — flip to "1" once
  // the audio path stabilises. PR1 deploys flip the env in docker-compose.
  esphomeApiEnabled: optional("ESPHOME_API_ENABLED", "0") === "1",
  esphomeApiPort: Number(optional("ESPHOME_API_PORT", "6053")),
  esphomeApiBind: optional("ESPHOME_API_BIND", "0.0.0.0"),
  // Optional ConnectRequest password. PR1 default = empty (tailnet boundary
  // per spec §5.5 Q7 resolution). The HA_VOICE_API_TOKEN lane joins the
  // channel_tokens table from #111 in PR2.
  haVoiceApiToken: optional("HA_VOICE_API_TOKEN", ""),
  // Tenant seed used to derive a stable locally-administered MAC for the
  // synthetic ESPHome device. Falls back to os.hostname() in computeIdentity.
  esphomeTenantSeed: optional("ESPHOME_TENANT_SEED", ""),
  esphomeFriendlyName: optional("ESPHOME_FRIENDLY_NAME", "Alfred"),

  // ── Wyoming Protocol fallback (issue #112, PR5) ─────────────────────────
  // HA's Wyoming integration speaks a different on-wire shape than the
  // ESPHome Native API — JSONL events over a TCP socket on :10300. We
  // implement the satellite-side surface so HA can route a full Assist
  // pipeline through us without going via mDNS-discovered ESPHome.
  //
  // OFF by default (WYOMING_ENABLED=0) because the ESPHome Native API path
  // is shorter end-to-end. Flip to "1" on tenants whose HA install can't
  // reach :6053 over the LAN (HA-OS / HA-Cloud) but CAN reach a Wyoming
  // server on the same tailnet. See packages/voice-bridge/docs/
  // ha-pipeline-setup.md for the trade-off.
  wyomingEnabled: optional("WYOMING_ENABLED", "0") === "1",
  wyomingPort: Number(optional("WYOMING_PORT", "10300")),
  wyomingBind: optional("WYOMING_BIND", "0.0.0.0"),
} as const;

export type Config = typeof config;
