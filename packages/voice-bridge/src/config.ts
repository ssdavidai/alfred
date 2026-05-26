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

  // Per-call hard cap to prevent runaway minutes
  maxCallSeconds: Number(optional("MAX_CALL_SECONDS", "1800")),
  // Idle hangup if no audio either way (Phase 9 hardening)
  idleHangupSeconds: Number(optional("IDLE_HANGUP_SECONDS", "60")),
} as const;

export type Config = typeof config;
