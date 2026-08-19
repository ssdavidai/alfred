-- 0021_codex_desktop — canonical Codex Desktop intake, delivery receipts,
-- mirror repair state, continuity revisions, and erasure tombstones (#685,
-- contract revision 685-r2).
--
-- alfred-state.db is canonical for this channel.  ingest.db is a
-- consume-and-expire mirror used by the existing learning pipeline.  A source
-- event is acknowledged only after its mirror exists; if the process stops in
-- between, the pending/repair_required rows below are sufficient to repair the
-- mirror without accepting the source event twice.

CREATE TABLE IF NOT EXISTS codex_desktop_installation (
  id                      TEXT PRIMARY KEY,
  principal_id            TEXT NOT NULL,
  label                   TEXT NOT NULL,
  product                 TEXT NOT NULL,
  product_version         TEXT NOT NULL,
  platform                TEXT NOT NULL CHECK (platform = 'macos'),
  adapter_version         TEXT NOT NULL,
  credential_hash         TEXT NOT NULL UNIQUE
    CHECK (
      length(credential_hash) = 64
      AND credential_hash NOT GLOB '*[^0-9a-f]*'
    ),
  credential_expires_at   TEXT NOT NULL,
  credential_rotated_at   TEXT,
  revoked_at              TEXT,
  revocation_reason       TEXT,
  last_seen_at            TEXT,
  deleted_at              TEXT,
  tombstone_until         TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (id, principal_id),
  FOREIGN KEY (principal_id) REFERENCES alfred_principal(id) ON DELETE RESTRICT,
  CHECK (deleted_at IS NULL OR tombstone_until IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_codex_desktop_installation_principal
  ON codex_desktop_installation(principal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_codex_desktop_installation_expiry
  ON codex_desktop_installation(credential_expires_at);
CREATE INDEX IF NOT EXISTS idx_codex_desktop_installation_tombstone
  ON codex_desktop_installation(tombstone_until)
  WHERE tombstone_until IS NOT NULL;

-- One row per submitted chunk.  id is the persisted acknowledgement id.
-- Exact replays return this row's original acknowledgement fields.  A chunk
-- remains unacknowledged while one of its source rows needs mirror repair.
CREATE TABLE IF NOT EXISTS codex_desktop_delivery_chunk (
  id                       TEXT PRIMARY KEY,
  installation_id          TEXT NOT NULL,
  principal_id             TEXT NOT NULL,
  opaque_session_id        TEXT NOT NULL,
  sequence_start           INTEGER NOT NULL CHECK (sequence_start >= 1),
  sequence_end             INTEGER NOT NULL CHECK (sequence_end >= sequence_start),
  idempotency_key          TEXT NOT NULL,
  canonical_payload_hash   TEXT NOT NULL
    CHECK (
      length(canonical_payload_hash) = 64
      AND canonical_payload_hash NOT GLOB '*[^0-9a-f]*'
    ),
  event_count              INTEGER NOT NULL CHECK (event_count BETWEEN 1 AND 256),
  mirror_state             TEXT NOT NULL DEFAULT 'pending'
    CHECK (mirror_state IN
      ('pending', 'mirrored', 'repair_required', 'tombstoned')),
  acknowledgement_at       TEXT,
  continuity_workspace_key TEXT,
  continuity_revision      INTEGER CHECK (continuity_revision IS NULL OR continuity_revision >= 1),
  retry_count              INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  last_retry_at            TEXT,
  deletion_id              TEXT,
  content_tombstoned_at    TEXT,
  retention_until          TEXT NOT NULL,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (event_count = sequence_end - sequence_start + 1),
  CHECK (
    acknowledgement_at IS NULL
    OR mirror_state IN ('mirrored', 'tombstoned')
  ),
  CHECK (
    content_tombstoned_at IS NULL
    OR (deletion_id IS NOT NULL AND mirror_state = 'tombstoned')
  ),
  UNIQUE (id, installation_id, principal_id),
  FOREIGN KEY (installation_id, principal_id)
    REFERENCES codex_desktop_installation(id, principal_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, continuity_workspace_key, continuity_revision)
    REFERENCES codex_desktop_continuity_revision(
      principal_id, workspace_key, revision
    ) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_desktop_chunk_idempotency
  ON codex_desktop_delivery_chunk(installation_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_desktop_chunk_sequence
  ON codex_desktop_delivery_chunk(
    installation_id, opaque_session_id, sequence_start, sequence_end
  );
CREATE INDEX IF NOT EXISTS idx_codex_desktop_chunk_session
  ON codex_desktop_delivery_chunk(
    installation_id, opaque_session_id, sequence_end DESC
  );
CREATE INDEX IF NOT EXISTS idx_codex_desktop_chunk_repair
  ON codex_desktop_delivery_chunk(mirror_state, created_at)
  WHERE acknowledgement_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_codex_desktop_chunk_retention
  ON codex_desktop_delivery_chunk(retention_until);

-- SQLite cannot express range exclusion as a UNIQUE constraint.  The route
-- resolves an exact replay before INSERT; every genuinely new range must be
-- later than all accepted/tombstoned ranges for the installation session.
-- Keeping tombstones in this table makes delayed delivery unable to reopen a
-- deleted range.
CREATE TRIGGER IF NOT EXISTS trg_codex_desktop_chunk_monotonic
BEFORE INSERT ON codex_desktop_delivery_chunk
WHEN EXISTS (
  SELECT 1
    FROM codex_desktop_delivery_chunk AS prior
   WHERE prior.installation_id = NEW.installation_id
     AND prior.opaque_session_id = NEW.opaque_session_id
     AND NEW.sequence_start <= prior.sequence_end
)
BEGIN
  SELECT RAISE(ABORT, 'codex_desktop_sequence_conflict');
END;

-- Canonical source record.  payload_json is the normalized revision-1 event
-- content.  It is nullable only after an erasure has installed a durable
-- tombstone.  workspace_cwd is content too and is cleared at the same time.
CREATE TABLE IF NOT EXISTS codex_desktop_source_event (
  id                       TEXT PRIMARY KEY,
  installation_id          TEXT NOT NULL,
  principal_id             TEXT NOT NULL,
  delivery_chunk_id        TEXT NOT NULL,
  source_event_id          TEXT NOT NULL,
  opaque_session_id        TEXT NOT NULL,
  opaque_turn_id           TEXT NOT NULL,
  event_sequence           INTEGER NOT NULL CHECK (event_sequence >= 1),
  event_kind               TEXT NOT NULL CHECK (event_kind = 'agent-turn-complete'),
  event_revision           INTEGER NOT NULL CHECK (event_revision = 1),
  captured_at              TEXT NOT NULL,
  workspace_cwd            TEXT,
  workspace_provenance     TEXT NOT NULL
    CHECK (workspace_provenance = 'codex-notify.cwd'),
  payload_json             TEXT,
  canonical_payload_hash   TEXT NOT NULL
    CHECK (
      length(canonical_payload_hash) = 64
      AND canonical_payload_hash NOT GLOB '*[^0-9a-f]*'
    ),
  mirror_state             TEXT NOT NULL DEFAULT 'pending'
    CHECK (mirror_state IN
      ('pending', 'mirrored', 'repair_required', 'tombstoned')),
  ingest_event_id          TEXT,
  mirror_attempt_count     INTEGER NOT NULL DEFAULT 0
    CHECK (mirror_attempt_count >= 0),
  last_mirror_attempt_at   TEXT,
  last_mirror_error_code   TEXT,
  continuity_workspace_key TEXT,
  continuity_revision      INTEGER CHECK (continuity_revision IS NULL OR continuity_revision >= 1),
  deletion_id              TEXT,
  content_tombstoned_at    TEXT,
  retention_until          TEXT NOT NULL,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (content_tombstoned_at IS NULL
      AND payload_json IS NOT NULL
      AND workspace_cwd IS NOT NULL)
    OR
    (content_tombstoned_at IS NOT NULL
      AND deletion_id IS NOT NULL
      AND payload_json IS NULL
      AND workspace_cwd IS NULL
      AND mirror_state = 'tombstoned')
  ),
  CHECK (mirror_state != 'mirrored' OR ingest_event_id IS NOT NULL),
  UNIQUE (id, installation_id, principal_id),
  FOREIGN KEY (installation_id, principal_id)
    REFERENCES codex_desktop_installation(id, principal_id) ON DELETE RESTRICT,
  FOREIGN KEY (delivery_chunk_id, installation_id, principal_id)
    REFERENCES codex_desktop_delivery_chunk(id, installation_id, principal_id)
      ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, continuity_workspace_key, continuity_revision)
    REFERENCES codex_desktop_continuity_revision(
      principal_id, workspace_key, revision
    ) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_desktop_source_identity
  ON codex_desktop_source_event(installation_id, source_event_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_desktop_event_sequence
  ON codex_desktop_source_event(
    installation_id, opaque_session_id, event_sequence
  );
CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_desktop_chunk_event_sequence
  ON codex_desktop_source_event(delivery_chunk_id, event_sequence);
CREATE INDEX IF NOT EXISTS idx_codex_desktop_source_chunk
  ON codex_desktop_source_event(delivery_chunk_id, event_sequence);
CREATE INDEX IF NOT EXISTS idx_codex_desktop_source_repair
  ON codex_desktop_source_event(mirror_state, created_at)
  WHERE mirror_state IN ('pending', 'repair_required');
CREATE INDEX IF NOT EXISTS idx_codex_desktop_source_retention
  ON codex_desktop_source_event(retention_until);
CREATE INDEX IF NOT EXISTS idx_codex_desktop_source_tombstone
  ON codex_desktop_source_event(deletion_id, content_tombstoned_at)
  WHERE content_tombstoned_at IS NOT NULL;

-- A source row cannot claim a different session or a sequence outside its
-- parent receipt.  This is intentionally a trigger rather than route-only
-- validation so repair/backfill code receives the same invariant.
CREATE TRIGGER IF NOT EXISTS trg_codex_desktop_source_receipt_bounds
BEFORE INSERT ON codex_desktop_source_event
WHEN NOT EXISTS (
  SELECT 1
    FROM codex_desktop_delivery_chunk AS receipt
   WHERE receipt.id = NEW.delivery_chunk_id
     AND receipt.installation_id = NEW.installation_id
     AND receipt.principal_id = NEW.principal_id
     AND receipt.opaque_session_id = NEW.opaque_session_id
     AND NEW.event_sequence BETWEEN receipt.sequence_start AND receipt.sequence_end
)
BEGIN
  SELECT RAISE(ABORT, 'codex_desktop_source_receipt_mismatch');
END;

-- Content-free continuity snapshots.  workspace_key is the lowercase SHA-256
-- of the request's normalized cwd; item_manifest_json contains only ordered
-- {kind,ref,content_hash} entries.  It is sufficient for no-change and unseen
-- delta calculation without creating a second task/matter/decision store.
CREATE TABLE IF NOT EXISTS codex_desktop_continuity_revision (
  principal_id       TEXT NOT NULL,
  workspace_key      TEXT NOT NULL
    CHECK (
      length(workspace_key) = 64
      AND workspace_key NOT GLOB '*[^0-9a-f]*'
    ),
  revision           INTEGER NOT NULL CHECK (revision >= 1),
  previous_revision  INTEGER CHECK (previous_revision IS NULL OR previous_revision >= 1),
  snapshot_hash      TEXT NOT NULL
    CHECK (
      length(snapshot_hash) = 64
      AND snapshot_hash NOT GLOB '*[^0-9a-f]*'
    ),
  item_manifest_json TEXT NOT NULL,
  reason             TEXT NOT NULL
    CHECK (reason IN ('snapshot', 'canonical_change', 'ingest', 'redaction', 'deletion')),
  retention_until    TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (principal_id, workspace_key, revision),
  FOREIGN KEY (principal_id) REFERENCES alfred_principal(id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, workspace_key, previous_revision)
    REFERENCES codex_desktop_continuity_revision(
      principal_id, workspace_key, revision
    ) ON DELETE RESTRICT,
  CHECK (
    (revision = 1 AND previous_revision IS NULL)
    OR (revision > 1 AND previous_revision = revision - 1)
  )
);

CREATE INDEX IF NOT EXISTS idx_codex_desktop_revision_head
  ON codex_desktop_continuity_revision(
    principal_id, workspace_key, revision DESC
  );
CREATE INDEX IF NOT EXISTS idx_codex_desktop_revision_retention
  ON codex_desktop_continuity_revision(retention_until);

-- Operator erasure ledger.  The request's free-text reason and raw session
-- id are deliberately absent: request_hash provides retry identity, while the
-- durable source/chunk tombstones carry the minimum identities required to
-- suppress delayed delivery.  last_error_code is allowlisted, never raw text.
CREATE TABLE IF NOT EXISTS codex_desktop_erasure_request (
  id                    TEXT PRIMARY KEY,
  installation_id       TEXT NOT NULL,
  principal_id          TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL,
  request_hash          TEXT NOT NULL
    CHECK (
      length(request_hash) = 64
      AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),
  scope_kind            TEXT NOT NULL CHECK (scope_kind IN ('session', 'installation')),
  scope_session_hash    TEXT,
  operation             TEXT NOT NULL CHECK (operation IN ('redact', 'delete')),
  state                 TEXT NOT NULL DEFAULT 'accepted'
    CHECK (state IN ('accepted', 'running', 'complete', 'degraded', 'failed')),
  source_rows_affected  INTEGER NOT NULL DEFAULT 0 CHECK (source_rows_affected >= 0),
  ingest_rows_affected  INTEGER NOT NULL DEFAULT 0 CHECK (ingest_rows_affected >= 0),
  journal_rows_affected INTEGER NOT NULL DEFAULT 0 CHECK (journal_rows_affected >= 0),
  derived_rows_affected INTEGER NOT NULL DEFAULT 0 CHECK (derived_rows_affected >= 0),
  lcm_state             TEXT NOT NULL DEFAULT 'pending'
    CHECK (lcm_state IN ('pending', 'complete', 'unavailable', 'not_applicable')),
  last_error_code       TEXT,
  accepted_at           TEXT NOT NULL,
  completed_at          TEXT,
  tombstone_until       TEXT NOT NULL,
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (installation_id, idempotency_key),
  UNIQUE (id, installation_id, principal_id),
  FOREIGN KEY (installation_id, principal_id)
    REFERENCES codex_desktop_installation(id, principal_id) ON DELETE RESTRICT,
  CHECK (
    (scope_kind = 'session' AND scope_session_hash IS NOT NULL)
    OR (scope_kind = 'installation' AND scope_session_hash IS NULL)
  ),
  CHECK (
    scope_session_hash IS NULL
    OR (
      length(scope_session_hash) = 64
      AND scope_session_hash NOT GLOB '*[^0-9a-f]*'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_codex_desktop_erasure_state
  ON codex_desktop_erasure_request(state, accepted_at);
CREATE INDEX IF NOT EXISTS idx_codex_desktop_erasure_tombstone
  ON codex_desktop_erasure_request(tombstone_until);
