-- 0021_codex_desktop — bounded delivery receipts and provenance for the
-- supported Codex Desktop channel contract (#684, contract revision 684-r2).
--
-- These tables deliberately contain no event body, transcript, plaintext
-- credential, independent memory, or LCM state.  ctrl-api projects accepted
-- source payloads into the existing ingest/journal path in the same
-- transaction, then retains only bounded hashes, identities, acknowledgements,
-- projection references, and deletion tombstones here.

CREATE TABLE IF NOT EXISTS codex_desktop_installation (
  id                    TEXT PRIMARY KEY,
  label                 TEXT NOT NULL,
  product               TEXT NOT NULL,
  product_version       TEXT NOT NULL,
  platform              TEXT NOT NULL CHECK (platform = 'macos'),
  adapter_version       TEXT NOT NULL,
  token_hash            TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  token_expires_at      TEXT NOT NULL,
  credential_rotated_at TEXT,
  revoked_at            TEXT,
  revocation_reason     TEXT,
  last_seen_at          TEXT,
  health_state          TEXT NOT NULL DEFAULT 'enrolled'
    CHECK (health_state IN ('enrolled', 'healthy', 'degraded', 'blocked')),
  health_reason         TEXT,
  redaction_state       TEXT NOT NULL DEFAULT 'active'
    CHECK (redaction_state IN ('active', 'redacted', 'deleted')),
  redacted_at           TEXT,
  deleted_at            TEXT,
  retention_until       TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_codex_desktop_installation_expiry
  ON codex_desktop_installation(token_expires_at);
CREATE INDEX IF NOT EXISTS idx_codex_desktop_installation_revoked
  ON codex_desktop_installation(revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_codex_desktop_installation_retention
  ON codex_desktop_installation(retention_until);

CREATE TABLE IF NOT EXISTS codex_desktop_delivery_chunk (
  id                     TEXT PRIMARY KEY, -- stable acknowledgement id
  installation_id        TEXT NOT NULL,
  opaque_session_id      TEXT NOT NULL,
  sequence_start         INTEGER NOT NULL CHECK (sequence_start >= 1),
  sequence_end           INTEGER NOT NULL CHECK (sequence_end >= sequence_start),
  idempotency_key        TEXT NOT NULL,
  canonical_payload_hash TEXT NOT NULL CHECK (length(canonical_payload_hash) = 64),
  event_count            INTEGER NOT NULL
    CHECK (event_count BETWEEN 1 AND 256),
  projection_status      TEXT NOT NULL DEFAULT 'pending'
    CHECK (projection_status IN
      ('pending', 'projected', 'partial', 'quarantined', 'redacted', 'deleted')),
  existing_ingest_ref    TEXT,
  acknowledgement_at     TEXT NOT NULL,
  redaction_state        TEXT NOT NULL DEFAULT 'active'
    CHECK (redaction_state IN ('active', 'redacted', 'deleted')),
  redacted_at            TEXT,
  deleted_at             TEXT,
  retention_until        TEXT NOT NULL,
  received_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (event_count = sequence_end - sequence_start + 1),
  UNIQUE (id, installation_id),
  FOREIGN KEY (installation_id)
    REFERENCES codex_desktop_installation(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_desktop_chunk_idempotency
  ON codex_desktop_delivery_chunk(installation_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_desktop_chunk_sequence
  ON codex_desktop_delivery_chunk(
    installation_id, opaque_session_id, sequence_start, sequence_end
  );
CREATE INDEX IF NOT EXISTS idx_codex_desktop_chunk_session
  ON codex_desktop_delivery_chunk(installation_id, opaque_session_id, sequence_end);
CREATE INDEX IF NOT EXISTS idx_codex_desktop_chunk_projection
  ON codex_desktop_delivery_chunk(projection_status, received_at);
CREATE INDEX IF NOT EXISTS idx_codex_desktop_chunk_retention
  ON codex_desktop_delivery_chunk(retention_until);

CREATE TABLE IF NOT EXISTS codex_desktop_source_event (
  id                     TEXT PRIMARY KEY,
  installation_id        TEXT NOT NULL,
  delivery_chunk_id      TEXT NOT NULL,
  source_event_id        TEXT NOT NULL,
  opaque_session_id      TEXT NOT NULL,
  opaque_turn_id         TEXT NOT NULL,
  event_sequence         INTEGER NOT NULL CHECK (event_sequence >= 1),
  event_kind             TEXT NOT NULL,
  event_revision         INTEGER NOT NULL CHECK (event_revision >= 1),
  canonical_payload_hash TEXT NOT NULL CHECK (length(canonical_payload_hash) = 64),
  observed_at            TEXT NOT NULL,
  projection_status      TEXT NOT NULL DEFAULT 'pending'
    CHECK (projection_status IN
      ('pending', 'projected', 'quarantined', 'redacted', 'deleted')),
  existing_ingest_ref    TEXT,
  existing_journal_ref   TEXT,
  redaction_state        TEXT NOT NULL DEFAULT 'active'
    CHECK (redaction_state IN ('active', 'redacted', 'deleted')),
  redacted_at            TEXT,
  deleted_at             TEXT,
  retention_until        TEXT NOT NULL,
  received_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (installation_id)
    REFERENCES codex_desktop_installation(id) ON DELETE RESTRICT,
  FOREIGN KEY (delivery_chunk_id, installation_id)
    REFERENCES codex_desktop_delivery_chunk(id, installation_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_desktop_source_identity
  ON codex_desktop_source_event(installation_id, source_event_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_desktop_event_sequence
  ON codex_desktop_source_event(
    installation_id, opaque_session_id, event_sequence
  );
CREATE INDEX IF NOT EXISTS idx_codex_desktop_source_chunk
  ON codex_desktop_source_event(delivery_chunk_id, event_sequence);
CREATE INDEX IF NOT EXISTS idx_codex_desktop_source_turn
  ON codex_desktop_source_event(installation_id, opaque_session_id, opaque_turn_id);
CREATE INDEX IF NOT EXISTS idx_codex_desktop_source_projection
  ON codex_desktop_source_event(projection_status, received_at);
CREATE INDEX IF NOT EXISTS idx_codex_desktop_source_retention
  ON codex_desktop_source_event(retention_until);
