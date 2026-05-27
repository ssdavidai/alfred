/**
 * Session codec for HTTP-mode Hermes.
 *
 * Paperclip persists `sessionParams` between heartbeats. We use this to
 * round-trip the Hermes session key. Compatibility shim: if an existing
 * agent has the upstream `sessionId` (from the CLI-mode adapter), accept
 * it as the session key so we don't force a forced reset.
 */

import type { AdapterSessionCodec } from "../types/paperclip.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    // Prefer the new `sessionKey` field; fall back to the legacy
    // upstream `sessionId` so existing agents keep working.
    const sessionKey =
      readNonEmptyString(record.sessionKey) ??
      readNonEmptyString(record.session_key) ??
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id);
    if (!sessionKey) return null;
    return { sessionKey };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionKey =
      readNonEmptyString(params.sessionKey) ??
      readNonEmptyString(params.session_key) ??
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id);
    if (!sessionKey) return null;
    return { sessionKey };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionKey) ??
      readNonEmptyString(params.session_key) ??
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id)
    );
  },
};
