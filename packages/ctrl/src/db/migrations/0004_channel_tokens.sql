-- 0003_channel_tokens — the shared per-channel bearer-token surface.
--
-- Background. ctrl-api accepts inbound traffic from a growing set of external
-- channels: Paperclip (`pcp_*` board/agent keys + bootstrap), Home Assistant
-- conversation agent (issue #111, this migration), HA Voice (issue #112, later),
-- and a queue of future channels (Matter / HomeKit / arbitrary household
-- automations). Each new channel has historically invented its own auth
-- shape — Paperclip's per-Hermes-profile `PAPERCLIP_API_KEY`, voice-bridge's
-- `VOICE_BRIDGE_INTERNAL_TOKEN`, the master `AAS_API_KEY` for everything
-- else. The result is a fragmented rotation story and no audit pivot.
--
-- Sir's call (issue #111, decision Q2): one shared `channel_tokens` table.
-- Each row is one bearer token, keyed by `channel` so per-channel rotation +
-- listing + revoke is uniform. `token_hash` is `sha256(raw)`; the raw token
-- is shown once at mint and never stored. `scope_json` carries
-- channel-specific scope (e.g. HA installation id) so the auth path doesn't
-- need a parallel sidecar table for trivial scope data.
--
-- HA (the immediate user) writes one row per install with
-- `channel='ha-conversation'`, label='ha:<haInstanceId>', and the install
-- uuid in `scope_json.haInstanceId`. The validator path looks up by
-- `(channel, token_hash)` — a leaked HA token cannot reach the master surface
-- and cannot impersonate a Paperclip key because the channel discriminator
-- pins it.
--
-- Paperclip migration is OPTIONAL and follows in a separate housekeeping
-- pass. The existing Paperclip auth (per-Hermes-profile `PAPERCLIP_API_KEY`
-- + bootstrap-issued board/agent keys) keeps working as-is; nothing in this
-- migration touches Paperclip's surface. When Paperclip's next iteration
-- lands, its key writes pick up `channel='paperclip-heartbeat'` rows here
-- for one rotation+audit story.
--
-- Constraints / discipline:
--   * `token_hash` is sha256-of-raw — never reversible. Plaintext shown
--     once at mint.
--   * The hot lookup index `(token_hash) WHERE revoked_at IS NULL` covers
--     auth on every request. Uniqueness is enforced at mint time by
--     generating fresh random bytes (collision probability is 1 in 2^192
--     per 24-byte token).
--   * Indexes are partial (`WHERE revoked_at IS NULL`) so the hot lookup
--     path skips tombstones — a revoked token is just history.

CREATE TABLE IF NOT EXISTS channel_tokens (
  id              TEXT PRIMARY KEY,    -- ULID
  channel         TEXT NOT NULL,       -- 'ha-conversation' | 'ha-voice' |
                                       -- 'paperclip-heartbeat' | …
  token_hash      TEXT NOT NULL,       -- sha256(raw token), hex-lowercase
  label           TEXT,                -- human-friendly label, optional
  scope_json      TEXT,                -- JSON: channel-specific scope
                                       -- (e.g. {"haInstanceId":"<uuid>"})
  created_at      INTEGER NOT NULL,    -- unix ms
  last_used_at    INTEGER,             -- unix ms; null until first use
  last_used_ip    TEXT,                -- best-effort source ip
  rotated_from    TEXT,                -- prev token id when this row is
                                       -- a rotation (FK soft — old row may
                                       -- have been pruned in long-tail cleanup)
  revoked_at      INTEGER              -- unix ms; null when active
);

-- Hot path 1: list active tokens for a channel ("show me my HA tokens").
CREATE INDEX IF NOT EXISTS idx_channel_tokens_channel
  ON channel_tokens(channel) WHERE revoked_at IS NULL;

-- Hot path 2: auth lookup by token_hash on every authenticated request.
-- The validator queries with (token_hash, channel) so a leaked hash cannot
-- be replayed against a different channel's allowlist.
CREATE INDEX IF NOT EXISTS idx_channel_tokens_hash
  ON channel_tokens(token_hash) WHERE revoked_at IS NULL;
