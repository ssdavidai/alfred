-- 0017_agent_profiles — multi-profile Hermes registry (issue #120 Lane I).
--
-- Today Alfred = one user-facing `main` profile + a handful of background
-- infra profiles (`workers`, `heavy`, optionally `codex-builder`). The
-- principal's intent (per issue #120) is to be able to spawn additional
-- user-facing personas — Joe's tenant did this by hand with a
-- `docker-compose.override.yaml` sibling container for `cratchit`; this
-- table is the productized seam that captures intent durably in state.db.
--
-- This migration ONLY introduces the registry. It deliberately does NOT
-- rewire Hermes' supervisor or any channel route — that's Lane II / IV
-- follow-up work. Until those land, channel routes still hard-code
-- `main`; the registry just records what the principal asked for.
--
-- Tables:
--   * agent_profile           — one row per Hermes profile (reserved infra
--                               + user-facing personas).
--   * channel_profile_binding — which profile a given channel kind (or
--                               channel identity) is bound to.
--
-- Plus a `profile_slug` column added to channel_tokens so token-bearer
-- channels (HA, future shapes) can carry the binding in the token itself.
--
-- Seed rules:
--   * The four reserved infra slots are seeded so the registry is the
--     single source of truth from boot. `is_reserved=1` blocks DELETE;
--     `is_user_facing=0` keeps workers/heavy/codex-builder out of the
--     UI list. `main` IS surfaced (is_user_facing=1) since it's the
--     principal-facing conversational agent.
--   * Each known channel kind seeds a `(channel_kind, NULL, 'main')`
--     binding so back-compat reads return `main` until the principal
--     explicitly rebinds via Lane III's UI.
--
-- Port allocation rule (enforced in code, not SQL):
--   18789..18793 reserved for infra; 18794..18799 for user-facing.
--   Hard cap = 6 user-facing profiles per tenant (port range exhausted).

CREATE TABLE IF NOT EXISTS agent_profile (
  slug              TEXT PRIMARY KEY,
                       -- ^[a-z][a-z0-9-]{1,30}$ enforced at the API layer.
  label             TEXT NOT NULL,
                       -- Human-friendly name (e.g. "Cratchit", "Alfred").
  description       TEXT,
                       -- Short summary the picker shows. Optional.
  model             TEXT NOT NULL,
                       -- Provider/model id passed to Hermes config (e.g.
                       -- "x-ai/grok-4.3", "anthropic/claude-opus-4-6").
  deployment_shape  TEXT NOT NULL DEFAULT 'supervised',
                       -- 'supervised' | 'sibling'. v1 only writes
                       -- 'supervised'; 'sibling' admits Joe's existing
                       -- override-file rig at registry level (Lane VI).
  api_server_port   INTEGER NOT NULL,
                       -- Hermes /v1 port. 18789..18793 infra; 18794..18799
                       -- user-facing.
  persona_template  TEXT,
                       -- Raw SOUL.md seed; written into the profile dir on
                       -- first render (Lane II). NULL = use Hermes' stock
                       -- persona.
  status            TEXT NOT NULL DEFAULT 'pending',
                       -- 'pending'  — registry written, Hermes side not yet
                       --              activated.
                       -- 'running'  — Hermes gateway responding on the port.
                       -- 'stopped'  — process intentionally not launched
                       --              (e.g. codex-builder when the flag is
                       --              off; user-soft-stopped profile).
                       -- 'archived' — DELETE'd; port freed for reuse.
  is_user_facing    INTEGER NOT NULL DEFAULT 1,
                       -- 1 = appears in /profiles list and ProfileSwitcher.
                       -- 0 = infra; hidden from UI.
  is_reserved       INTEGER NOT NULL DEFAULT 0,
                       -- 1 = cannot be deleted; cannot be created via API.
                       -- The four seeded infra rows.
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  archived_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_profile_status
  ON agent_profile(status) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_profile_port
  ON agent_profile(api_server_port) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_profile_user_facing
  ON agent_profile(is_user_facing) WHERE archived_at IS NULL;

-- Seed the four reserved infra slots. is_user_facing=1 on `main` since
-- the principal does see Alfred on every conversational channel; the
-- other three (workers/heavy/codex-builder) are background.
INSERT INTO agent_profile (
  slug, label, description, model, deployment_shape,
  api_server_port, status, is_user_facing, is_reserved,
  created_at, updated_at
) VALUES
  ('main',          'Alfred',
   'Your conversational Alfred on every channel (Slack/Telegram/SMS), with memory.',
   'x-ai/grok-4.3', 'supervised', 18789, 'running', 1, 1,
   strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('workers',       'Workers',
   'Clerk, curator, janitor, distiller — cheap, high-volume background work.',
   'openai/gpt-4.1-nano', 'supervised', 18790, 'running', 0, 1,
   strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('heavy',         'Heavy',
   'Onboarding facts/patterns + chore heavy-reasoning — Opus-class, slow and expensive.',
   'anthropic/claude-opus-4-6', 'supervised', 18791, 'running', 0, 1,
   strftime('%s','now')*1000, strftime('%s','now')*1000),
  ('codex-builder', 'Codex builder',
   'Sealed builder runtime — uid 10001, egress-jailed. Flag-gated; off on most tenants.',
   'gpt-5-codex', 'supervised', 18793, 'stopped', 0, 1,
   strftime('%s','now')*1000, strftime('%s','now')*1000)
ON CONFLICT(slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS channel_profile_binding (
  id              TEXT PRIMARY KEY,
                       -- 'binding-default-<kind>' for the (kind, NULL)
                       -- defaults; ULID for everything else. The prefix
                       -- guards DELETE in the API layer.
  channel_kind    TEXT NOT NULL,
                       -- 'telegram'|'slack'|'sms'|'email'|'paperclip'|
                       -- 'terminal'|'voice'|'ha'|'omi'|'recall'|'tailscale'.
                       -- Enforced at the API layer (KNOWN_CHANNEL_KINDS).
  channel_identity TEXT,
                       -- channel-side identity (e.g. telegram chat id,
                       -- slack workspace, twilio number); NULL = default
                       -- binding for the kind.
  profile_slug    TEXT NOT NULL REFERENCES agent_profile(slug),
  created_at      INTEGER NOT NULL,
  UNIQUE (channel_kind, channel_identity)
);

CREATE INDEX IF NOT EXISTS idx_channel_profile_binding_profile
  ON channel_profile_binding(profile_slug);

-- Seed: every known channel kind defaults to 'main' for back-compat.
-- Lane III's UI rebinds these one row at a time.
INSERT OR IGNORE INTO channel_profile_binding
  (id, channel_kind, channel_identity, profile_slug, created_at)
VALUES
  ('binding-default-telegram',  'telegram',  NULL, 'main', strftime('%s','now')*1000),
  ('binding-default-slack',     'slack',     NULL, 'main', strftime('%s','now')*1000),
  ('binding-default-sms',       'sms',       NULL, 'main', strftime('%s','now')*1000),
  ('binding-default-email',     'email',     NULL, 'main', strftime('%s','now')*1000),
  ('binding-default-paperclip', 'paperclip', NULL, 'main', strftime('%s','now')*1000),
  ('binding-default-terminal',  'terminal',  NULL, 'main', strftime('%s','now')*1000),
  ('binding-default-voice',     'voice',     NULL, 'main', strftime('%s','now')*1000),
  ('binding-default-ha',        'ha',        NULL, 'main', strftime('%s','now')*1000),
  ('binding-default-omi',       'omi',       NULL, 'main', strftime('%s','now')*1000),
  ('binding-default-recall',    'recall',    NULL, 'main', strftime('%s','now')*1000),
  ('binding-default-tailscale', 'tailscale', NULL, 'main', strftime('%s','now')*1000);

-- Extend channel_tokens with profile pointer (back-compat: nullable,
-- callers that have not been Lane-IV-updated still implicitly carry 'main').
ALTER TABLE channel_tokens ADD COLUMN profile_slug TEXT;

CREATE INDEX IF NOT EXISTS idx_channel_tokens_profile
  ON channel_tokens(profile_slug) WHERE revoked_at IS NULL;
