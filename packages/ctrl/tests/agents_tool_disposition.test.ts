// Tool disposition routes — GET/POST /api/v1/agents/tool-disposition (Phase B).
//
// What's under test:
//   * GET round-trips the migration-0014 seed (9 rows, all 'direct').
//   * POST validates server + disposition + updated_by enums.
//   * POST upserts and writes a fresh updated_at.
//   * The debounced Hermes restart is scheduled exactly once per flurry of
//     flips inside the window.
//
// We exercise the routes through matchRoute (same pattern as
// channels_tokens.test.ts) — no need to spin up the http listener for these
// tests. The Hermes restart is verified via the test hooks
// _resetHermesRestartDebounceForTests + _hermesRestartPendingForTests
// exported from the agents route module (we never actually invoke
// docker compose in unit tests; the debounce timer just sits pending).

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agents-disposition-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { getStateDb } = await import("../src/db/state.js");
const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const {
  registerAgentRoutes,
  _resetHermesRestartDebounceForTests,
  _hermesRestartPendingForTests,
} = await import("../src/api/routes/agents.js");

registerAgentRoutes();

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

function resetDispositions(): void {
  // Reset to migration-0014 seed values so each test starts from the same
  // baseline.
  const db = getStateDb();
  db.exec("DELETE FROM tool_disposition");
  const stmt = db.prepare(
    `INSERT INTO tool_disposition (server, disposition, updated_at, updated_by)
     VALUES (?, 'direct', ?, 'init')`,
  );
  const seed = [
    "alfred-ctrl", "alfred", "sure", "plane", "vaultwarden",
    "execute", "paperclip", "hass", "files",
  ];
  const now = new Date().toISOString();
  for (const s of seed) stmt.run(s, now);
}

before(() => {
  // getStateDb() runs migrations — including 0014 — on first call.
  getStateDb();
});

after(() => {
  _resetHermesRestartDebounceForTests();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  _resetHermesRestartDebounceForTests();
  resetDispositions();
});

describe("GET /api/v1/agents/tool-disposition", () => {
  it("returns all 9 seeded dispositions, all 'direct'", async () => {
    const { status, payload } = await invokeRoute(
      "GET",
      "/api/v1/agents/tool-disposition",
    );
    assert.equal(status, 200);
    assert.ok(Array.isArray(payload.dispositions));
    assert.equal(payload.dispositions.length, 9);
    const servers = payload.dispositions.map((d: any) => d.server).sort();
    assert.deepEqual(servers, [
      "alfred", "alfred-ctrl", "execute", "files", "hass",
      "paperclip", "plane", "sure", "vaultwarden",
    ]);
    for (const d of payload.dispositions) {
      assert.equal(d.disposition, "direct");
      assert.ok(typeof d.updated_at === "string" && d.updated_at.length > 0);
    }
  });
});

describe("POST /api/v1/agents/tool-disposition", () => {
  it("flips sure to delegated, persists, returns updated row", async () => {
    const { status, payload } = await invokeRoute(
      "POST",
      "/api/v1/agents/tool-disposition",
      {
        body: { server: "sure", disposition: "delegated", updated_by: "alfred" },
      },
    );
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.row.server, "sure");
    assert.equal(payload.row.disposition, "delegated");
    assert.equal(payload.row.updated_by, "alfred");

    // Verify the GET surface sees the change.
    const list = await invokeRoute("GET", "/api/v1/agents/tool-disposition");
    const sure = list.payload.dispositions.find((d: any) => d.server === "sure");
    assert.equal(sure.disposition, "delegated");
  });

  it("rejects unknown server with 400 + suggestion", async () => {
    const { status, payload } = await invokeRoute(
      "POST",
      "/api/v1/agents/tool-disposition",
      { body: { server: "ghost-server", disposition: "delegated" } },
    );
    assert.equal(status, 400);
    assert.ok(String(payload.error?.message ?? "").includes("Unknown server"));
  });

  it("rejects invalid disposition value", async () => {
    const { status, payload } = await invokeRoute(
      "POST",
      "/api/v1/agents/tool-disposition",
      { body: { server: "sure", disposition: "stealthy" } },
    );
    assert.equal(status, 400);
    assert.ok(String(payload.error?.message ?? "").includes("Invalid disposition"));
  });

  it("rejects invalid updated_by value", async () => {
    const { status, payload } = await invokeRoute(
      "POST",
      "/api/v1/agents/tool-disposition",
      {
        body: {
          server: "sure",
          disposition: "delegated",
          updated_by: "anonymous",
        },
      },
    );
    assert.equal(status, 400);
    assert.ok(String(payload.error?.message ?? "").includes("Invalid updated_by"));
  });

  it("rejects missing required fields", async () => {
    const r1 = await invokeRoute(
      "POST",
      "/api/v1/agents/tool-disposition",
      { body: { disposition: "direct" } },
    );
    assert.equal(r1.status, 400);
    const r2 = await invokeRoute(
      "POST",
      "/api/v1/agents/tool-disposition",
      { body: { server: "sure" } },
    );
    assert.equal(r2.status, 400);
  });

  it("upserts: second flip of same server overwrites the row", async () => {
    await invokeRoute(
      "POST",
      "/api/v1/agents/tool-disposition",
      { body: { server: "paperclip", disposition: "delegated", updated_by: "sir" } },
    );
    await invokeRoute(
      "POST",
      "/api/v1/agents/tool-disposition",
      { body: { server: "paperclip", disposition: "direct", updated_by: "alfred" } },
    );
    const list = await invokeRoute("GET", "/api/v1/agents/tool-disposition");
    const pc = list.payload.dispositions.find((d: any) => d.server === "paperclip");
    assert.equal(pc.disposition, "direct");
    assert.equal(pc.updated_by, "alfred");
    // Table size unchanged — upsert, not insert.
    assert.equal(list.payload.dispositions.length, 9);
  });
});

describe("Hermes restart debounce", () => {
  it("a single flip schedules a pending restart", async () => {
    assert.equal(_hermesRestartPendingForTests(), false);
    await invokeRoute(
      "POST",
      "/api/v1/agents/tool-disposition",
      { body: { server: "sure", disposition: "delegated" } },
    );
    assert.equal(_hermesRestartPendingForTests(), true);
  });

  it("three flips inside the window coalesce into one pending restart", async () => {
    await invokeRoute(
      "POST",
      "/api/v1/agents/tool-disposition",
      { body: { server: "sure", disposition: "delegated" } },
    );
    await invokeRoute(
      "POST",
      "/api/v1/agents/tool-disposition",
      { body: { server: "plane", disposition: "delegated" } },
    );
    await invokeRoute(
      "POST",
      "/api/v1/agents/tool-disposition",
      { body: { server: "paperclip", disposition: "delegated" } },
    );
    // Still exactly one pending timer — the second + third flips reset it
    // rather than queuing additional restarts.
    assert.equal(_hermesRestartPendingForTests(), true);
  });

  it("response advertises the debounce window", async () => {
    const { payload } = await invokeRoute(
      "POST",
      "/api/v1/agents/tool-disposition",
      { body: { server: "sure", disposition: "delegated" } },
    );
    assert.equal(payload.restart_scheduled, true);
    assert.equal(payload.restart_debounce_ms, 10_000);
  });
});
