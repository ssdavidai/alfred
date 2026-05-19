// ============================================================================
// cold.db — Store 3 of the alfred-black four-store architecture.
//
// The forensic long tail. Rows in state.db (Store 2) age out of the hot tables
// after a TTL and get rolled here by the periodic compactor. The Desk audit
// feed and the /api/v1/state/audit query transparently read across the hot +
// cold tiers when a query window reaches past the cutoff.
//
// WHY NOT DUCKDB. PLAN.md Part I names "DuckDB/Parquet" as the candidate. A
// DuckDB node binding is a native addon — it would break ctrl-api's build
// contract (esbuild bundles a single dependency-free dist/api.mjs; node:sqlite
// is the only DB and it is built into Node 22) and would force per-arch native
// builds into the image. The plan's actual hard requirements are: single file,
// no daemon, dependency-light, columnar-ish compression. A second SQLite file
// whose row bodies are zstd-compressed satisfies every one of them with ZERO
// new dependencies:
//
//   * single file        — cold.db on the cold_data volume.
//   * no daemon          — node:sqlite, same as state.db / ingest.db.
//   * dependency-light   — zero npm deps; node:zlib zstd (Node >=22.15) or a
//                          gzip fallback on older runtimes.
//   * compression        — each archived row is stored as one zstd/gzip blob;
//                          cold archive is write-once / read-rarely, so a
//                          per-row blob is the right granularity. Typical
//                          ratio for JSON audit rows is ~4-6x.
//
// Forensic reads stay possible: the `id`, `ts`, and the table-specific filter
// columns (action_type, actor, source, kind, …) are kept as plain indexed
// columns alongside the compressed `body` blob, so a cold query filters and
// orders without decompressing — only the matched rows' bodies are inflated.
//
// SINGLE-WRITER DISCIPLINE holds: ctrl-api is the sole writer to cold.db, just
// as it is for state.db and ingest.db.
// ============================================================================

import { DatabaseSync } from "node:sqlite";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const COLD_DB_PATH =
  process.env.COLD_DB_PATH ?? path.join(process.cwd(), "data", "cold.db");

// Per-table TTL in days. A hot row older than this is rolled to cold.db.
// signal / observation / routing_decision: 90d (working-memory long tail).
// audit / link: 365d — the forensic ledger keeps a year before it cools.
export const COLD_TTL_DAYS: Record<string, number> = {
  signal: Number(process.env.COLD_TTL_SIGNAL_DAYS ?? "90"),
  observation: Number(process.env.COLD_TTL_OBSERVATION_DAYS ?? "90"),
  routing_decision: Number(process.env.COLD_TTL_ROUTING_DECISION_DAYS ?? "90"),
  audit: Number(process.env.COLD_TTL_AUDIT_DAYS ?? "365"),
  link: Number(process.env.COLD_TTL_LINK_DAYS ?? "365"),
};

// ── zstd / gzip codec ────────────────────────────────────────────────────────
// Node 22.15+ exposes zstd in node:zlib. Older runtimes fall back to gzip so
// the build and the compactor still work; the `codec` column records which
// was used so decompression always picks the right inflater.
const HAS_ZSTD =
  typeof (zlib as any).zstdCompressSync === "function" &&
  typeof (zlib as any).zstdDecompressSync === "function";

export const COLD_CODEC: "zstd" | "gzip" = HAS_ZSTD ? "zstd" : "gzip";

function compress(text: string): Buffer {
  const buf = Buffer.from(text, "utf-8");
  if (HAS_ZSTD) {
    return (zlib as any).zstdCompressSync(buf, {
      params: {
        // 19 is a strong ratio; cold archive is write-once so CPU is cheap.
        [(zlib as any).constants.ZSTD_c_compressionLevel ?? 0]: 19,
      },
    });
  }
  return zlib.gzipSync(buf, { level: 9 });
}

function decompress(blob: Buffer | Uint8Array, codec: string): string {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (codec === "zstd") {
    if (!HAS_ZSTD) {
      throw new Error(
        "cold.db row stored with zstd but this runtime has no zstd decoder",
      );
    }
    return (zlib as any).zstdDecompressSync(buf).toString("utf-8");
  }
  return zlib.gunzipSync(buf).toString("utf-8");
}

// ── schema ───────────────────────────────────────────────────────────────────
// One archive table per hot table. The plain columns are exactly the ones the
// hot-tier list endpoints filter / order on, so a cold query never has to
// inflate a body just to decide whether a row matches. `body` is the full hot
// row JSON, compressed. `archived_at` records when the compactor moved it.
const COLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS archive_signal (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  kind        TEXT,
  source      TEXT,
  status      TEXT,
  matter_ref  TEXT,
  codec       TEXT NOT NULL,
  body        BLOB NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_archive_signal_ts     ON archive_signal(ts DESC);
CREATE INDEX IF NOT EXISTS idx_archive_signal_kind   ON archive_signal(kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_archive_signal_status ON archive_signal(status, ts DESC);

CREATE TABLE IF NOT EXISTS archive_observation (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  subject     TEXT,
  kind        TEXT,
  status      TEXT,
  codec       TEXT NOT NULL,
  body        BLOB NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_archive_observation_ts   ON archive_observation(ts DESC);
CREATE INDEX IF NOT EXISTS idx_archive_observation_kind ON archive_observation(kind, ts DESC);

CREATE TABLE IF NOT EXISTS archive_routing_decision (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  tier        TEXT,
  chosen_path TEXT,
  outcome     TEXT,
  signal_id   TEXT,
  codec       TEXT NOT NULL,
  body        BLOB NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_archive_routing_decision_ts   ON archive_routing_decision(ts DESC);
CREATE INDEX IF NOT EXISTS idx_archive_routing_decision_tier ON archive_routing_decision(tier, ts DESC);

CREATE TABLE IF NOT EXISTS archive_audit (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  action_type TEXT,
  actor       TEXT,
  source      TEXT,
  target_path TEXT,
  subject_ref TEXT,
  mode        TEXT,
  codec       TEXT NOT NULL,
  body        BLOB NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_archive_audit_ts     ON archive_audit(ts DESC);
CREATE INDEX IF NOT EXISTS idx_archive_audit_type   ON archive_audit(action_type, ts DESC);
CREATE INDEX IF NOT EXISTS idx_archive_audit_actor  ON archive_audit(actor, ts DESC);
CREATE INDEX IF NOT EXISTS idx_archive_audit_source ON archive_audit(source, ts DESC);
CREATE INDEX IF NOT EXISTS idx_archive_audit_target ON archive_audit(target_path, ts DESC);

CREATE TABLE IF NOT EXISTS archive_link (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  src_ref     TEXT,
  dst_ref     TEXT,
  rel         TEXT,
  codec       TEXT NOT NULL,
  body        BLOB NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_archive_link_ts  ON archive_link(ts DESC);
CREATE INDEX IF NOT EXISTS idx_archive_link_src ON archive_link(src_ref);
CREATE INDEX IF NOT EXISTS idx_archive_link_dst ON archive_link(dst_ref);

-- One row per compactor run, for observability — mirrors ingest_sweep_log.
CREATE TABLE IF NOT EXISTS cold_compact_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at      TEXT NOT NULL DEFAULT (datetime('now')),
  table_name  TEXT NOT NULL,
  cutoff_ts   TEXT NOT NULL,
  rows_moved  INTEGER NOT NULL DEFAULT 0,
  bytes_cold  INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER NOT NULL DEFAULT 1,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_cold_compact_ran ON cold_compact_log(ran_at DESC);
`;

let _db: DatabaseSync | null = null;

/** Open (or return the cached) cold.db handle. Idempotent. */
export function getColdDb(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(COLD_DB_PATH), { recursive: true });
  const db = new DatabaseSync(COLD_DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(COLD_SCHEMA);
  _db = db;
  return db;
}

export function closeColdDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ── codec helpers, exported for the cross-tier readers ───────────────────────
export { compress as coldCompress, decompress as coldDecompress };

export { COLD_DB_PATH };
