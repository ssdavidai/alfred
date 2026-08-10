// #465 — POST /api/v1/webhooks/in/:token must atomically enqueue a canonical
// ingest.db event before returning 202. Prior behaviour: raw fs.writeFileSync
// into vault/stream_event/ (a directory nothing reads after #78) followed by
// unconditional 202, so the sender believed it succeeded while the event was
// invisible to the pipeline forever.
//
// Four cases exercised here:
//   1. Happy path — ingest.db row created, 202 returned.
//   2. ingest.db failure — 5xx surfaced, no false 202.
//   3. Redelivery of the same payload — exactly one row, 202 with idempotent flag.
//   4. Markdown write failure — still 202 (secondary path must not abort).
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ── Environment ──────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-atomic-"));
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.ALFRED_DATA_DIR = path.join(tmp, "alfred-data");
process.env.SQLITE_VEC_PATH = "";
process.env.TENANT_BASE_URL = "https://test.alfred.black";

// ── Module loading ────────────────────────────────────────────────────────────
await import("../src/api/routes/webhooksInbound.js");
const { createApiServer } = await import("../src/api/server.js");
const { getIngestDb } = await import("../src/db/ingest.js");

// ── Helpers ───────────────────────────────────────────────────────────────────
let server: http.Server;
before(async () => {
  server = createApiServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  // Reset ingest.db between tests so row counts are deterministic.
  getIngestDb().exec("DELETE FROM stream_event");
});

/** Build a fake webhook_endpoint record so token lookups succeed. */
function seedWebhookRecord(token: string, label: string): void {
  const dir = path.join(process.env.VAULT_PATH!, "webhook_endpoint");
  fs.mkdirSync(dir, { recursive: true });
  const body =
    `---\ntype: "webhook_endpoint"\ntoken: "${token}"\nlabel: "${label}"\ncreated_at: "2026-08-10T00:00:00Z"\nevent_count: 0\nlast_event_at: null\n---\n`;
  fs.writeFileSync(path.join(dir, `${token}.md`), body, "utf-8");
}

/** Fire POST /api/v1/webhooks/in/:token with optional extra headers. */
async function postWebhook(
  token: string,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    ...extraHeaders,
  };
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port: addr.port, path: `/api/v1/webhooks/in/${token}`, method: "POST", headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode!, data: raw }); }
        });
      },
    );
    r.on("error", reject);
    r.write(body);
    r.end();
  });
}

function countRows(): number {
  return (getIngestDb().prepare("SELECT COUNT(*) AS n FROM stream_event").get() as { n: number }).n;
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("POST /webhooks/in/:token — atomic ingest.db enqueue (#465)", () => {
  const TOKEN = "aabbccdd11223344";

  before(() => {
    seedWebhookRecord(TOKEN, "Test Webhook");
  });

  it("1. happy path — 202 and a row lands in ingest.db", async () => {
    const { status, data } = await postWebhook(TOKEN, { event: "meeting.completed", id: "rec-001" });
    assert.strictEqual(status, 202, `expected 202, got ${status}: ${JSON.stringify(data)}`);
    assert.strictEqual(data.status, "accepted");
    assert.strictEqual(countRows(), 1, "expected exactly one ingest row");

    // Confirm the row has the expected shape.
    const row = getIngestDb()
      .prepare("SELECT stream, channel, external_id FROM stream_event LIMIT 1")
      .get() as { stream: string; channel: string; external_id: string };
    assert.strictEqual(row.stream, "webhook");
    assert.match(row.channel, /^webhook:/);
    assert.ok(row.external_id, "external_id must be set");
  });

  it("2. ingest.db failure → 5xx, no false 202", async () => {
    // Force a genuine non-UNIQUE failure by dropping the table.
    getIngestDb().exec("DROP TABLE IF EXISTS stream_event");

    const { status } = await postWebhook(TOKEN, { event: "meeting.completed", id: "rec-fail" });
    assert.notStrictEqual(status, 202, "a dropped-event must NOT return 202");
    assert.ok(status >= 500, `expected 5xx, got ${status}`);

    // Restore for subsequent tests.
    getIngestDb().exec(`
      CREATE TABLE IF NOT EXISTS stream_event (
        id TEXT PRIMARY KEY, ts TEXT NOT NULL, stream TEXT NOT NULL,
        channel TEXT, external_id TEXT, kind TEXT NOT NULL DEFAULT 'message',
        payload_json TEXT NOT NULL, processed_at TEXT, processed_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_event_external
        ON stream_event(stream, external_id) WHERE external_id IS NOT NULL;
    `);
  });

  it("3. redelivery of the same payload → one row, 202 with idempotent flag", async () => {
    const payload = { event: "meeting.completed", id: "rec-002" };
    const r1 = await postWebhook(TOKEN, payload);
    const r2 = await postWebhook(TOKEN, payload);

    assert.strictEqual(r1.status, 202, `first delivery must be 202, got ${r1.status}`);
    assert.strictEqual(r2.status, 202, `re-delivery must also be 202, got ${r2.status}`);
    assert.strictEqual(r2.data?.idempotent, true, "re-delivery response must carry idempotent:true");
    assert.strictEqual(countRows(), 1, "re-delivery must not create a duplicate row");
  });

  it("3b. X-Webhook-Delivery header used as idempotency key", async () => {
    const payload = { event: "other", id: "rec-003" };
    const deliveryId = "unique-delivery-abc";
    const r1 = await postWebhook(TOKEN, payload, { "x-webhook-delivery": deliveryId });
    const r2 = await postWebhook(TOKEN, { event: "mutated" }, { "x-webhook-delivery": deliveryId });

    assert.strictEqual(r1.status, 202);
    assert.strictEqual(r2.status, 202);
    assert.strictEqual(r2.data?.idempotent, true, "same delivery header → idempotent");
    assert.strictEqual(countRows(), 1, "header-keyed dedup: one row only");
  });

  it("4. markdown write failing → still 202 (secondary path must not abort)", async () => {
    // Make STREAM_EVENT_DIR unwritable.
    const eventDir = path.join(process.env.VAULT_PATH!, "stream_event");
    fs.mkdirSync(eventDir, { recursive: true });
    fs.chmodSync(eventDir, 0o444); // read-only

    try {
      const { status, data } = await postWebhook(TOKEN, { event: "meeting.completed", id: "rec-004" });
      assert.strictEqual(status, 202, `expected 202 even when markdown fails, got ${status}: ${JSON.stringify(data)}`);
      assert.strictEqual(countRows(), 1, "ingest.db row must still land when markdown fails");
    } finally {
      fs.chmodSync(eventDir, 0o755); // restore
    }
  });
});
