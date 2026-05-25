-- 0002_alfred_journal — the continuity layer for "one Alfred" UX.
--
-- Background. Sir's principle: the user must feel they are talking to ONE
-- Alfred, always — internal session/profile/worker boundaries must never
-- leak into the perceived relationship. See docs/design/one-alfred.md.
--
-- Hermes ships per-(user, channel) sessions (e.g. agent:main:telegram:dm:432094090)
-- but offers no native primitive that bridges them. Every native delivery path
-- (cron, webhook, /v1/runs, /v1/responses) spawns its own synthetic session, so
-- outbound deliveries Sir SEES end up in his channel but main's actual session
-- never records that the exchange happened. Sir replies later, main has amnesia,
-- the illusion of one Alfred breaks.
--
-- Fix: ctrl-api owns continuity. Every Alfred↔Sir exchange — outbound AND inbound,
-- across every channel — is journalled here. A Hermes pre_gateway_dispatch hook
-- queries this table on every inbound message and rewrites the user message to
-- include recent journal context. Main now sees a coherent conversation.
--
-- This migration adds the two tables that make that possible.

-- ----------------------------------------------------------------------------
-- alfred_principal — Phase 3: cross-channel identity.
--
-- Sir is ONE principal whether he messages from Telegram chat 432094090, his
-- Slack DM, or his email thread. This table is the mapping. ctrl-api's hook
-- helper looks up principal_id from (channel, chat_id) and queries the journal
-- by principal — so a Telegram reply has memory of a Slack delegate.
--
-- Today: one row, the owner. Tomorrow: each household member can be their own
-- principal with their own channel bindings. The shape is built once.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alfred_principal (
  id           TEXT PRIMARY KEY,         -- short slug, e.g. 'owner' / 'spouse' / 'kid-1'
  display_name TEXT NOT NULL,            -- 'David Szabo-Stuban'
  is_owner     INTEGER NOT NULL DEFAULT 0, -- exactly one row should have this set
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- (channel, chat_id) → principal_id. A principal may have many bindings (one
-- per channel they use). A binding cannot belong to two principals — that's
-- enforced by the composite PK.
CREATE TABLE IF NOT EXISTS alfred_principal_channel (
  channel      TEXT NOT NULL,            -- 'telegram' | 'slack' | 'email' | 'web' | 'phone' | …
  chat_id      TEXT NOT NULL,            -- channel-specific id (Telegram chat_id, Slack user, …)
  principal_id TEXT NOT NULL,            -- FK → alfred_principal.id
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, chat_id),
  FOREIGN KEY (principal_id) REFERENCES alfred_principal(id)
);
CREATE INDEX IF NOT EXISTS idx_alfred_principal_channel_by_principal
  ON alfred_principal_channel(principal_id);

-- ----------------------------------------------------------------------------
-- alfred_journal — the append-only ledger of every Alfred↔Sir exchange.
--
-- One row per message. `direction='outbound'` is something Alfred said to Sir,
-- `direction='inbound'` is something Sir said to Alfred. The Hermes hook reads
-- this table (most recent first, windowed by recency + principal) and injects
-- the entries as context into main's next turn.
--
-- The journal is decoupled from Hermes' SQLite session store — Hermes' store is
-- per-session, profile-scoped, opaque, and lossy across resets. The journal is
-- per-principal, cross-channel, queryable, durable. They serve different roles.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alfred_journal (
  id                TEXT PRIMARY KEY,    -- ULID
  ts                TEXT NOT NULL,       -- ISO-8601 UTC

  -- Identity
  principal_id      TEXT,                -- FK → alfred_principal.id; nullable for system-only entries
  channel           TEXT NOT NULL,       -- 'telegram' | 'slack' | 'email' | 'web' | 'phone' | …
  chat_id           TEXT NOT NULL,       -- channel-specific identifier

  -- Direction + content
  direction         TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  message           TEXT NOT NULL,       -- the exact bytes Sir saw (outbound) or typed (inbound)

  -- Provenance — what caused this exchange
  source_kind       TEXT,                -- 'delegate' | 'instinct' | 'reply' | 'init' | 'system'
  source_ref        TEXT,                -- e.g. decision_id, signal_id, observation_id

  -- Hermes runtime linkage (best-effort, for debugging)
  hermes_session_id TEXT,                -- the Hermes session the exchange landed in
  hermes_profile    TEXT,                -- 'main' | 'workers' | 'heavy'

  -- Status — outbound starts 'pending', flips to 'delivered' / 'failed' once
  -- the Hermes webhook callback returns.
  status            TEXT NOT NULL DEFAULT 'delivered'
                          CHECK (status IN ('pending', 'delivered', 'failed', 'received')),
  delivery_error    TEXT,                -- non-null when status='failed'

  -- Full structured payload (JSON) for richer context the hook may want to
  -- surface: original principal_note, summary, source_headline, tool calls,
  -- etc. The display layer reads `message`; the LLM-injection layer can pull
  -- extra fields from here for richer context.
  metadata          TEXT,

  -- Timestamps for ordering / TTL
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Lookups: "what has Alfred said to/heard from this user on this channel
-- recently?" — the hot path for the pre_gateway_dispatch hook.
CREATE INDEX IF NOT EXISTS idx_alfred_journal_lookup
  ON alfred_journal(channel, chat_id, ts DESC);

-- Cross-channel lookup by principal — Phase 3.
CREATE INDEX IF NOT EXISTS idx_alfred_journal_by_principal
  ON alfred_journal(principal_id, ts DESC);

-- For correlating an outbound back to the delegate / signal / observation it
-- came from (UI: "what cards has Alfred actually delivered to Sir?").
CREATE INDEX IF NOT EXISTS idx_alfred_journal_by_source
  ON alfred_journal(source_kind, source_ref);

-- Pending-outbound sweep (for retry / observability of stuck deliveries).
CREATE INDEX IF NOT EXISTS idx_alfred_journal_pending
  ON alfred_journal(status, ts) WHERE status = 'pending';

-- ----------------------------------------------------------------------------
-- Bootstrap the owner principal.
--
-- ALFRED_OWNER_EMAIL is the canonical identity in the env; for the principal
-- row we use a fixed id 'owner' so all the code paths can resolve it without
-- a lookup. Telegram/Slack/etc. bindings are added by the channel-pairing
-- code paths (notifications.ts, channelsEmail.ts, etc.) lazily — they don't
-- need to exist at migration time.
-- ----------------------------------------------------------------------------
INSERT OR IGNORE INTO alfred_principal (id, display_name, is_owner)
VALUES ('owner', 'Sir', 1);
