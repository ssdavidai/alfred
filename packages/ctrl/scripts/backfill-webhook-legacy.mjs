#!/usr/bin/env node
/**
 * Backfill legacy webhook stream_event records into ingest.db.
 *
 * Before PR #508, POST /api/v1/webhooks/in/:token wrote a `stream_event`
 * markdown file into vault/stream_event/ and returned 202 unconditionally.
 * Nothing reads that directory — the canonical pipeline consumes ingest.db
 * after the #78 migration. Any delivery that arrived before #508 was silently
 * stranded; the sender believed it succeeded.
 *
 * This script scans vault/stream_event/webhook-*.md, identifies legacy webhook
 * records (source_type starts with "webhook:"), and inserts the missing
 * ingest.db rows idempotently so the existing EventProcessor picks them up.
 *
 * Usage (dry-run by default — reports what would be inserted, writes nothing):
 *   node packages/ctrl/scripts/backfill-webhook-legacy.mjs
 *
 * Apply inserts:
 *   node packages/ctrl/scripts/backfill-webhook-legacy.mjs --execute
 *
 * Running it on a tenant: the ctrl-api image copies only `dist/api.mjs` into
 * /app, so this file is NOT present in the container and cannot be exec'd from
 * a path there. Copy it in first, run it, then remove it. (Do not add scripts/
 * to the image for this — it is a one-shot recovery, not a recurring job.)
 *
 *   CTRL=alfred-black-ctrl-api-1
 *   docker cp packages/ctrl/scripts/backfill-webhook-legacy.mjs $CTRL:/tmp/bf.mjs
 *   docker exec $CTRL node /tmp/bf.mjs              # dry run — writes nothing
 *   docker exec $CTRL node /tmp/bf.mjs --execute    # apply
 *   docker exec $CTRL rm -f /tmp/bf.mjs
 *
 * A `docker cp` overlay does not survive `docker compose up -d --force-recreate`,
 * which is fine here — the inserted ingest.db rows are what persists.
 *
 * Environment (same defaults as ctrl-api):
 *   VAULT_PATH     (default: /vault)
 *   INGEST_DB_PATH (default: ./data/ingest.db)
 */

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ── Crockford-base32 ULID (inlined — no npm deps in operator scripts) ─────────
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(now = Date.now()) {
  let tp = "";
  let t = now;
  for (let i = 0; i < 10; i++) { tp = CROCKFORD[t % 32] + tp; t = Math.floor(t / 32); }
  const rb = crypto.randomBytes(10);
  let acc = 0n;
  for (const b of rb) acc = (acc << 8n) | BigInt(b);
  let rp = "";
  for (let i = 0; i < 16; i++) { rp = CROCKFORD[Number(acc & 31n)] + rp; acc >>= 5n; }
  return tp + rp;
}

// ── Pure helpers (exported so the test file can verify them) ──────────────────

/** Minimal YAML frontmatter parser — handles the flat shapes used by ctrl-api. */
export function parseFrontmatter(content) {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end === -1) return {};
  const out = {};
  for (const rawLine of content.slice(4, end).split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    out[key] = val === "null" || val === "~" ? null : val;
  }
  return out;
}

/**
 * Extract the JSON payload from the ```json code block written by the old
 * webhook handler. Returns { text, parsed } or null if no block found.
 */
export function extractPayload(content) {
  const MARKER = "```json\n";
  const start = content.indexOf(MARKER);
  if (start === -1) return null;
  const bodyStart = start + MARKER.length;
  const end = content.indexOf("\n```", bodyStart);
  if (end === -1) return null;
  const text = content.slice(bodyStart, end);
  try { return { text, parsed: JSON.parse(text) }; } catch { return { text, parsed: null }; }
}

/**
 * Compute the external_id for a legacy webhook record using the same formula
 * as PR #508's content-hash fallback: `token:sha256(token:payloadText)[0:32]`.
 * This is stable and deterministic — running the backfill twice deduplicates
 * via the UNIQUE(stream, external_id) constraint.
 */
export function computeExternalId(token, payloadText) {
  return `${token}:${crypto.createHash("sha256").update(`${token}:${payloadText}`).digest("hex").slice(0, 32)}`;
}

// ── Main (only runs when executed directly, not on import by tests) ───────────
async function main() {
  const DRY_RUN = !process.argv.includes("--execute");
  const VAULT_ROOT = process.env.VAULT_PATH ?? "/vault";
  const INGEST_DB_PATH = process.env.INGEST_DB_PATH ?? path.join(process.cwd(), "data", "ingest.db");
  const STREAM_EVENT_DIR = path.join(VAULT_ROOT, "stream_event");

  console.log(`[backfill] mode=${DRY_RUN ? "DRY-RUN (pass --execute to apply)" : "EXECUTE"}`);
  console.log(`[backfill] vault/stream_event = ${STREAM_EVENT_DIR}`);
  console.log(`[backfill] ingest.db          = ${INGEST_DB_PATH}`);

  let db;
  try {
    db = new DatabaseSync(INGEST_DB_PATH);
    db.exec("PRAGMA busy_timeout = 5000");
  } catch (err) {
    console.error(`[backfill] ERROR: cannot open ingest.db: ${err}`);
    process.exit(1);
  }

  if (!fs.existsSync(STREAM_EVENT_DIR)) {
    console.log("[backfill] stream_event dir not found — nothing to backfill");
    return;
  }

  // Only look at files written by the webhook handler: `webhook-<tokenPrefix>-<ts>-<uuid>.md`
  const entries = fs.readdirSync(STREAM_EVENT_DIR)
    .filter(f => f.endsWith(".md") && f.startsWith("webhook-"))
    .sort();

  console.log(`[backfill] ${entries.length} candidate file(s) (webhook-*.md)\n`);

  let inserted = 0, alreadyPresent = 0, skipped = 0;
  const failed = [];

  for (const filename of entries) {
    const label = filename;
    let content;
    try { content = fs.readFileSync(path.join(STREAM_EVENT_DIR, filename), "utf-8"); }
    catch (err) { console.log(`  SKIP    ${label} — unreadable: ${err.message}`); skipped++; continue; }

    const fm = parseFrontmatter(content);
    const sourceType = String(fm.source_type ?? "");
    if (!sourceType.startsWith("webhook:")) {
      console.log(`  SKIP    ${label} — source_type="${sourceType}" not webhook:`);
      skipped++; continue;
    }

    // Token lives in source_ref as "<token>:<shortUuid>"; split on last colon.
    const sourceRef = String(fm.source_ref ?? "");
    const colonIdx = sourceRef.lastIndexOf(":");
    if (colonIdx <= 0) {
      console.log(`  SKIP    ${label} — source_ref="${sourceRef}" malformed`);
      skipped++; continue;
    }
    const token = sourceRef.slice(0, colonIdx);

    const result = extractPayload(content);
    if (!result || !result.parsed) {
      console.log(`  SKIP    ${label} — ${!result ? "no ```json block" : "malformed JSON"}`);
      skipped++; continue;
    }

    const receivedAt = String(fm.received_at ?? new Date().toISOString());
    const externalId = computeExternalId(token, result.text);
    const shortId = externalId.slice(0, 28) + "…";

    const existing = db.prepare(
      "SELECT 1 FROM stream_event WHERE stream='webhook' AND external_id=?",
    ).get(externalId);
    if (existing) {
      console.log(`  PRESENT ${label}  (external_id=${shortId})`);
      alreadyPresent++; continue;
    }

    if (DRY_RUN) {
      console.log(`  WOULD-INSERT ${label}  channel="${sourceType}"  external_id=${shortId}`);
      inserted++; continue;
    }

    try {
      db.prepare(
        `INSERT INTO stream_event (id, ts, stream, channel, external_id, kind, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ulid(), receivedAt, "webhook", sourceType, externalId, "webhook",
        JSON.stringify({ source_type: sourceType, source_ref: sourceRef, received_at: receivedAt, payload: result.parsed }),
      );
      console.log(`  INSERTED ${label}  external_id=${shortId}`);
      inserted++;
    } catch (err) {
      if (String(err).includes("UNIQUE")) {
        console.log(`  PRESENT (race) ${label}`);
        alreadyPresent++;
      } else {
        console.log(`  ERROR   ${label} — ${String(err).slice(0, 120)}`);
        failed.push(filename);
      }
    }
  }

  const verb = DRY_RUN ? "would-insert" : "inserted";
  console.log(`\n[backfill] ${verb}=${inserted}  already-present=${alreadyPresent}  skipped=${skipped}  errors=${failed.length}`);
  if (failed.length) {
    console.error("[backfill] Failed files:\n" + failed.map(f => "  " + f).join("\n"));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
