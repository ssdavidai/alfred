import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs";
import schema from "./schema.sql";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;

  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, "alfred-ctrl.db");
  db = new DatabaseSync(dbPath);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(schema);

  // Migrations for existing databases
  try {
    db.exec("ALTER TABLE instances ADD COLUMN gateway_token TEXT");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE instances ADD COLUMN api_key TEXT");
  } catch {
    // Column already exists
  }

  // Cloudflare Tunnel + tenant isolation columns
  for (const col of [
    "tailscale_tag TEXT",
    "subdomain TEXT",
    "cf_tunnel_id TEXT",
    "cf_tunnel_name TEXT",
    "cf_dns_record_id TEXT",
    "cf_plane_dns_record_id TEXT",
    "cf_sure_dns_record_id TEXT",
    "cf_access_app_id TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE instances ADD COLUMN ${col}`);
    } catch {
      // Column already exists
    }
  }

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
