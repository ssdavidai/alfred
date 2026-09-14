-- Omi adapter state; business records remain in the vault.
CREATE TABLE omi_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES alfred_principal(id),
  credential_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  writes_enabled INTEGER NOT NULL DEFAULT 0,
  since TEXT NOT NULL,
  last_sync_at TEXT,
  error TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE omi_message_receipt (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  journal_id TEXT NOT NULL,
  PRIMARY KEY (account_id, message_id)
);
CREATE TABLE omi_task_map (
  account_id TEXT NOT NULL,
  task_path TEXT NOT NULL,
  remote_id TEXT,
  baseline TEXT,
  conflict TEXT,
  PRIMARY KEY (account_id, task_path),
  UNIQUE (account_id, remote_id)
);
CREATE TABLE omi_command (
  account_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  operation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','completed','uncertain')),
  result TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, request_id)
);
