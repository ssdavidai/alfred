CREATE TABLE IF NOT EXISTS _migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
