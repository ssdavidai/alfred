// Resolve the hostname Twilio should connect its Media Stream WebSocket to.
//
// Twilio Media Streams use WS Upgrade. Cloudflare's WAF on the orange-cloud
// (proxied) `alfred.black` hostname drops those upgrades and the call fails
// with Twilio error 31920 ("Stream — WebSocket — Connection error"); end-user
// hears Twilio's "An application error has occurred" system voice and the
// call disconnects.
//
// We therefore route Media Stream traffic through `voice.alfred.black`, which
// is configured DNS-only at Cloudflare (grey cloud) so the WS upgrade reaches
// our origin (Caddy → voice-bridge) untouched.
//
// Both the inbound voice webhook (webhooks.ts) AND the outbound TwiML
// connect-bridge handler (internal.ts) MUST use this helper so they cannot
// silently diverge again. The outbound path missing this was the root cause
// of the realtime-call failure on Twilio CallSid CA0757796433449f44405dba27fbea44a8.
//
// Override via env var `VOICE_BRIDGE_WS_HOST` if a future deployment moves
// the bridge to a different hostname.
export function getVoiceBridgeWsHost(): string {
  return process.env.VOICE_BRIDGE_WS_HOST || "voice.alfred.black";
}
