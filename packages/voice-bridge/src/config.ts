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

  // OpenAI Realtime config. Default model tracks the latest GA slug.
  openaiApiKey: required("OPENAI_API_KEY"),
  openaiModel: optional("OPENAI_REALTIME_MODEL", "gpt-realtime-1.5"),
  openaiVoice: optional("OPENAI_REALTIME_VOICE", "cedar"),

  // Per-call hard cap to prevent runaway minutes
  maxCallSeconds: Number(optional("MAX_CALL_SECONDS", "1800")),
  // Idle hangup if no audio either way (Phase 9 hardening)
  idleHangupSeconds: Number(optional("IDLE_HANGUP_SECONDS", "60")),
} as const;

export type Config = typeof config;
