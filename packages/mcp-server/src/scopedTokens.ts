// Per-app scoped static bearer tokens — the headless auth path for
// non-interactive MCP clients (ElevenLabs / LiveKit voice agents, scripts).
//
// Three ways to authenticate a `POST /<app>/mcp` request now exist, checked
// in this order (see index.ts `authOrApprovalSecret`):
//   1. `MCP_APPROVAL_SECRET`  — tenant-wide master key (all apps). Kept so
//      existing integrations (the in-tenant voice-bridge, claude.ai's
//      /approve flow) keep working unchanged.
//   2. a scoped token (this module) — bound to ONE app, mintable/rotatable/
//      deletable per vendor from the dashboard. Preferred for third parties.
//   3. full OAuth 2.1 bearer — what claude.ai uses.
//
// Only the SHA-256 hash of a scoped token is persisted; the raw value is
// returned exactly once at mint/rotate time.

import { sha256, randomToken, randomShort } from "./oauth/storage.js";
import type { ScopedTokenRow } from "./oauth/storage.js";

/** The raw token carries a readable prefix so it's identifiable in logs / vaults. */
const TOKEN_LABEL = "alf";

export interface MintedScopedToken {
  /** Public management id (`tok_…`). */
  id: string;
  /** The raw bearer value — shown to the operator ONCE. */
  token: string;
  /** SHA-256 hash to persist. */
  token_hash: string;
  /** Display prefix (not secret). */
  prefix: string;
}

/**
 * Mint a fresh scoped token for `appId`. The raw token has the shape
 * `alf_<app>_<random>` so it's recognizable; the caller must persist
 * `token_hash` and hand `token` to the operator once.
 */
export function mintScopedToken(appId: string): MintedScopedToken {
  const token = `${TOKEN_LABEL}_${appId}_${randomToken(24)}`;
  return {
    id: `tok_${randomShort(12)}`,
    token,
    token_hash: sha256(token),
    prefix: token.slice(0, 16),
  };
}

/** Minimal storage surface `verifyScopedToken` needs — lets tests use a fake. */
export interface ScopedTokenReader {
  getScopedTokenByHash(token_hash: string): ScopedTokenRow | null;
  touchScopedToken(id: string, ts: number): void;
}

/**
 * Validate a bearer against the scoped tokens for `appId`. Returns true and
 * stamps `last_used_at` on success. A token bound to a different app, a
 * revoked token, or an unknown token all fail — so a token minted for
 * `/execute/mcp` cannot be replayed against `/sure/mcp`.
 */
export function verifyScopedToken(
  storage: ScopedTokenReader,
  appId: string,
  token: string,
  now: number,
): boolean {
  if (!token) return false;
  const row = storage.getScopedTokenByHash(sha256(token));
  if (!row) return false;
  if (row.app_id !== appId) return false;
  if (row.revoked_at) return false;
  storage.touchScopedToken(row.id, now);
  return true;
}
