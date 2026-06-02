-- 0018_channel_identity — per-(profile, channel_kind) display name + avatar
-- (issue #206 Q6).
--
-- Sibling to #120 Lane III: while #120 introduced the agent_profile registry +
-- channel_profile_binding map (which AGENT handles which channel), this
-- migration captures the channel-side IDENTITY a given profile wears on a
-- given channel kind — the display name the recipient sees on Telegram /
-- Slack / SMS / Email, plus an optional avatar.
--
-- One row per (profile, channel_kind). Either field may be NULL; a row
-- with both NULL is allowed in the schema but pruned on DELETE by the
-- channelIdentity.ts lib (empty rows are pointless).
--
-- The avatar_path is the absolute path the ctrl-api route wrote the upload
-- to under /hermes-state/profiles/<slug>/avatars/<channel_kind>.<ext>.
-- Lane IV reads this column (via resolveChannelIdentity) at send time and
-- ships the bytes to the third-party API as part of the outbound message.
-- Lane IV does NOT write this table — the only writer is the PUT route
-- in routes/channel_identity.ts.
--
-- FK to agent_profile(slug) with ON DELETE CASCADE: if a profile is HARD
-- deleted (which the API never does — archive is soft), the identity rows
-- come with it. Archive doesn't delete the profile row, so identity rows
-- survive archive — restoring a profile preserves its identities.

CREATE TABLE IF NOT EXISTS channel_identity (
  profile_slug   TEXT NOT NULL,
  channel_kind   TEXT NOT NULL,
  display_name   TEXT,
  avatar_path    TEXT,
  avatar_mime    TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (profile_slug, channel_kind),
  FOREIGN KEY (profile_slug) REFERENCES agent_profile(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_channel_identity_profile
  ON channel_identity(profile_slug);
