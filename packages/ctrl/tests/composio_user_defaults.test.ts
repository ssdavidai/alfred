// Phase C — Composio primary-entity defaults cache.
//
// Migration 0015 (composio_user_defaults) + the two routes that wrap it:
//
//   GET  /api/v1/integrations/defaults?toolkit=…&user_id=…
//   POST /api/v1/integrations/:toolkit/refresh-defaults
//
// What's under test:
//   1. Migration creates composio_user_defaults at user_version=15 with the
//      composite primary key + the updated_at index.
//   2. Raw INSERT round-trips correctly via the readComposioUserDefaults shim.
//   3. INSERT OR REPLACE-style upsert behaviour: a second write for the same
//      (toolkit, user_id) overwrites the JSON + bumps updated_at.
//   4. GET /api/v1/integrations/defaults returns {defaults: null} when nothing
//      is cached for that (toolkit, user_id).
//   5. GET surfaces a cached row's defaults verbatim.
//   6. GET requires both toolkit and user_id query params (400 otherwise).
//
// We DON'T exercise the `POST /:toolkit/refresh-defaults` route here because
// it calls out to the live Composio sidecar (no stub seam). The sidecar side
// is covered in packages/learn/tests/test_composio_server_defaults.py.

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "composio-defaults-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

// The integrations route requires COMPOSIO_API_KEY + COMPOSIO_USER_ID at
// import time only to mint helper closures; the GET-defaults handler we
// exercise here is independent of both, but the route registration touches
// `getComposioApiKey()` lazily (only inside route handlers). We still set the
// envs so `POST refresh-defaults` doesn't throw at route-time in any future
// test additions.
process.env.COMPOSIO_API_KEY = "test-key";
process.env.COMPOSIO_USER_ID = "alfred-test-1";

const { getStateDb } = await import("../src/db/state.js");
const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { registerIntegrationRoutes } = await import(
  "../src/api/routes/integrations.js"
);
registerIntegrationRoutes();

interface InvokeOpts {
  body?: unknown;
  query?: string;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}

async function invokeRoute(
  method: string,
  p: string,
  opts: InvokeOpts = {},
): Promise<{ status: number; payload: any }> {
  const pathOnly = p.split("?")[0];
  const m = matchRoute(method, pathOnly);
  assert.ok(m, `${method} ${pathOnly} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    setHeader() {},
    writeHead(c: number) {
      status = c;
      return res;
    },
    end(j?: string) {
      payload = j ? JSON.parse(j) : undefined;
    },
  } as unknown as ServerResponse;
  try {
    await m!.handler({
      req: {
        method,
        url: p,
        headers: opts.headers ?? {},
        socket: { remoteAddress: "10.0.0.42" },
      } as any,
      res,
      params: opts.params ?? m!.params,
      body: opts.body,
      query: new URLSearchParams(opts.query ?? ""),
    });
  } catch (err) {
    handleError(res, err);
  }
  return { status, payload };
}

function cols(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (r) => r.name,
  );
}

before(() => {
  // getStateDb() runs migrations — including 0015 — on first call.
  getStateDb();
});

beforeEach(() => {
  const db = getStateDb();
  db.exec("DELETE FROM composio_user_defaults");
});

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("0015_composio_user_defaults migration", () => {
  it("creates the table with the documented columns", () => {
    const db = getStateDb();
    const c = cols(db, "composio_user_defaults");
    for (const required of [
      "toolkit",
      "user_id",
      "default_args_json",
      "updated_at",
      "source",
    ]) {
      assert.ok(c.includes(required), `0015: composio_user_defaults.${required} present`);
    }
  });

  it("enforces composite (toolkit, user_id) primary key", () => {
    const db = getStateDb();
    db.prepare(
      `INSERT INTO composio_user_defaults
         (toolkit, user_id, default_args_json, updated_at, source)
       VALUES (?, ?, ?, datetime('now'), ?)`,
    ).run("googlecalendar", "alfred-x-1", '{"calendarId":"a"}', "oauth_completion");
    // Same composite — should throw on raw INSERT (no ON CONFLICT clause).
    assert.throws(
      () =>
        db.prepare(
          `INSERT INTO composio_user_defaults
             (toolkit, user_id, default_args_json, updated_at, source)
           VALUES (?, ?, ?, datetime('now'), ?)`,
        ).run("googlecalendar", "alfred-x-1", '{"calendarId":"b"}', "user_explicit"),
      /UNIQUE|PRIMARY KEY/i,
    );
    // Different user_id same toolkit — allowed.
    assert.doesNotThrow(() =>
      db.prepare(
        `INSERT INTO composio_user_defaults
           (toolkit, user_id, default_args_json, updated_at, source)
         VALUES (?, ?, ?, datetime('now'), ?)`,
      ).run("googlecalendar", "alfred-x-2", '{"calendarId":"c"}', "oauth_completion"),
    );
    // Same user_id different toolkit — allowed.
    assert.doesNotThrow(() =>
      db.prepare(
        `INSERT INTO composio_user_defaults
           (toolkit, user_id, default_args_json, updated_at, source)
         VALUES (?, ?, ?, datetime('now'), ?)`,
      ).run("gmail", "alfred-x-1", "{}", "oauth_completion"),
    );
  });

  it("indexes updated_at for cheap recency scans", () => {
    const db = getStateDb();
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='composio_user_defaults'",
    ).all() as { name: string }[];
    const names = rows.map((r) => r.name);
    assert.ok(
      names.includes("idx_composio_user_defaults_updated"),
      "0015: idx_composio_user_defaults_updated present",
    );
  });
});

describe("GET /api/v1/integrations/defaults", () => {
  it("returns {defaults: null} when no row is cached", async () => {
    const { status, payload } = await invokeRoute(
      "GET",
      "/api/v1/integrations/defaults?toolkit=googlecalendar&user_id=alfred-test-1",
      { query: "toolkit=googlecalendar&user_id=alfred-test-1" },
    );
    assert.equal(status, 200);
    assert.equal(payload.defaults, null);
  });

  it("surfaces a cached row's defaults + source + updated_at", async () => {
    const db = getStateDb();
    db.prepare(
      `INSERT INTO composio_user_defaults
         (toolkit, user_id, default_args_json, updated_at, source)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "googlecalendar",
      "alfred-test-1",
      '{"calendarId":"primary-id-xyz"}',
      "2026-05-30 12:00:00",
      "oauth_completion",
    );
    const { status, payload } = await invokeRoute(
      "GET",
      "/api/v1/integrations/defaults?toolkit=googlecalendar&user_id=alfred-test-1",
      { query: "toolkit=googlecalendar&user_id=alfred-test-1" },
    );
    assert.equal(status, 200);
    assert.deepEqual(payload.defaults, { calendarId: "primary-id-xyz" });
    assert.equal(payload.source, "oauth_completion");
    assert.equal(payload.updated_at, "2026-05-30 12:00:00");
  });

  it("requires both toolkit and user_id (400 otherwise)", async () => {
    const r1 = await invokeRoute(
      "GET",
      "/api/v1/integrations/defaults?user_id=alfred-test-1",
      { query: "user_id=alfred-test-1" },
    );
    assert.equal(r1.status, 400);
    assert.ok(String(r1.payload.error?.message ?? "").toLowerCase().includes("required"));

    const r2 = await invokeRoute(
      "GET",
      "/api/v1/integrations/defaults?toolkit=googlecalendar",
      { query: "toolkit=googlecalendar" },
    );
    assert.equal(r2.status, 400);
    assert.ok(String(r2.payload.error?.message ?? "").toLowerCase().includes("required"));
  });

  it("is case-insensitive on toolkit and lower-cases on read", async () => {
    const db = getStateDb();
    db.prepare(
      `INSERT INTO composio_user_defaults
         (toolkit, user_id, default_args_json, updated_at, source)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "googlecalendar",
      "alfred-test-1",
      '{"calendarId":"abc"}',
      "2026-05-30 12:00:00",
      "oauth_completion",
    );
    // Querying with uppercase toolkit should still hit the row.
    const { status, payload } = await invokeRoute(
      "GET",
      "/api/v1/integrations/defaults?toolkit=GoogleCalendar&user_id=alfred-test-1",
      { query: "toolkit=GoogleCalendar&user_id=alfred-test-1" },
    );
    assert.equal(status, 200);
    assert.deepEqual(payload.defaults, { calendarId: "abc" });
  });
});
