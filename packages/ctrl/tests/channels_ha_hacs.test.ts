// Tier 4 HACS routes — `/ha/hacs/*` (#115/#158 PR5).
//
// Coverage:
//   1. `GET /ha/hacs/info` returns the verbatim hacs/info payload.
//   2. `GET /ha/hacs/repos` returns the filtered+normalised list. Query
//      params (`category`, `q`, `installed`, `pending`, `limit`) are
//      honoured.
//   3. `GET /ha/hacs/repo/:id` returns the row + the matching list view.
//   4. `POST /ha/hacs/repos` (add custom repo) validates url + category,
//      proxies to hacs/repositories/add. No gate, no snapshot.
//   5. `POST /ha/hacs/install` is gated — missing decision_ref returns
//      400. Snapshot fires BEFORE the upstream call. ha_integration_ref
//      row is written. Daybook entry is written.
//   6. `DELETE /ha/hacs/:id` is gated — same shape, no integration ledger
//      row (the install row stays for audit).
//   7. `POST /ha/hacs/:id/refresh` is no-gate, no-snapshot.
//   8. `POST /ha/hacs/install` surfaces upstream errors as 502 even when
//      the snapshot succeeded.
//
// We stand up the same fake HA WS server pattern PR1's
// channels_ha_ws_routes.test.ts uses and add hacs/* handlers to it.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket as WSWebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-ha-hacs-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.SQLITE_VEC_PATH = "";
process.env.HA_WS_AUTOSTART = "false";
process.env.HA_SNAPSHOT_DRY_RUN = "1";

fs.mkdirSync(path.join(tmp, "vault", "decision"), { recursive: true });
fs.mkdirSync(path.join(tmp, "vault", "daybook"), { recursive: true });

// Seed a decision the destructive verbs can reference.
const DECISION_ID = "01HACS00000000000000000001";
fs.writeFileSync(
  path.join(tmp, "vault", "decision", `${DECISION_ID}.md`),
  `---\ntype: decision\nid: "${DECISION_ID}"\nstate: open\nintent: done\n---\n\n# HACS install authorised\n`,
  "utf-8",
);

// ── fake HA WS server ──────────────────────────────────────────────────

let server: http.Server;
let wss: WebSocketServer;
let serverPort = 0;
const liveSockets: WSWebSocket[] = [];

// Test-side knobs the suite tweaks per case to drive specific WS
// behaviour.
const wsControl = {
  failNext: null as string | null, // when set, the NEXT call matching this type returns success:false
  installCalls: [] as Record<string, unknown>[],
  removeCalls: [] as Record<string, unknown>[],
  refreshCalls: [] as Record<string, unknown>[],
  addCalls: [] as Record<string, unknown>[],
  repos: [
    {
      id: "1",
      name: "better_thermostat",
      full_name: "KartoffelToby/better_thermostat",
      description: "A better thermostat",
      category: "integration",
      installed: true,
      installed_version: "0.9.0",
      available_version: "1.0.0",
      pending_update: true,
      topics: ["climate", "thermostat"],
    },
    {
      id: "2",
      name: "mushroom",
      full_name: "piitaya/lovelace-mushroom",
      description: "Cards for Home Assistant",
      category: "plugin",
      installed: false,
      installed_version: null,
      available_version: "2.5.0",
      pending_update: false,
      topics: ["dashboard"],
    },
    {
      id: "3",
      name: "ios_dark",
      full_name: "basnijholt/lovelace-ios-dark-mode-theme",
      description: "iOS-style dark theme",
      category: "theme",
      installed: true,
      installed_version: "1.2",
      available_version: "1.2",
      pending_update: false,
      topics: ["theme"],
    },
  ] as Record<string, unknown>[],
};

function setupServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    server = http.createServer();
    wss = new WebSocketServer({ server, path: "/api/websocket" });
    wss.on("connection", (ws) => {
      liveSockets.push(ws);
      ws.send(JSON.stringify({ type: "auth_required" }));
      ws.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth_ok" }));
          return;
        }
        const id = msg.id;
        const type = msg.type as string;
        // helper to send error
        const sendErr = (code: string, message: string): void => {
          ws.send(
            JSON.stringify({
              id,
              type: "result",
              success: false,
              error: { code, message },
            }),
          );
        };
        const sendOk = (result: unknown): void => {
          ws.send(JSON.stringify({ id, type: "result", success: true, result }));
        };
        if (wsControl.failNext === type) {
          wsControl.failNext = null;
          sendErr("internal_error", `forced failure for ${type}`);
          return;
        }
        if (type === "hacs/info") {
          sendOk({
            categories: [
              "integration",
              "plugin",
              "theme",
              "appdaemon",
              "netdaemon",
            ],
            country: "US",
            debug: false,
            dev: false,
            disabled_reason: null,
            has_pending_tasks: false,
            lovelace_mode: "storage",
            stage: "running",
          });
          return;
        }
        if (type === "hacs/repositories/list") {
          sendOk(wsControl.repos);
          return;
        }
        if (type === "hacs/repository/state") {
          const repo_id = msg.repository as string;
          const found = wsControl.repos.find((r) => r.id === repo_id);
          if (!found) {
            sendErr("not_found", `repo ${repo_id} not in catalogue`);
            return;
          }
          sendOk({ id: repo_id, status: "ok", state: found.installed ? "installed" : "available" });
          return;
        }
        if (type === "hacs/repositories/add") {
          wsControl.addCalls.push(msg);
          sendOk({ added: true });
          return;
        }
        if (type === "hacs/repository/download") {
          wsControl.installCalls.push(msg);
          sendOk({ downloaded: true });
          return;
        }
        if (type === "hacs/repository/remove") {
          wsControl.removeCalls.push(msg);
          sendOk({ removed: true });
          return;
        }
        if (type === "hacs/repository/refresh") {
          wsControl.refreshCalls.push(msg);
          sendOk({ refreshed: true });
          return;
        }
        if (type === "subscribe_events") {
          sendOk(null);
          return;
        }
        // Default — accept silently. Other Tier-4 callers may probe and
        // we don't want to crash on every unexpected message.
        sendOk(null);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") serverPort = addr.port;
      resolve();
    });
  });
}

function teardownServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    for (const s of liveSockets) {
      try {
        s.terminate();
      } catch {
        // best-effort
      }
    }
    liveSockets.length = 0;
    wss?.close(() => {
      server?.close(() => resolve());
    });
  });
}

await setupServer();
process.env.HA_WS_URL_OVERRIDE = `ws://127.0.0.1:${serverPort}/api/websocket`;

// Import after env is set so the modules see the right paths.
const { registerHaHacsRoutes, _resetHaHacsForTests } = await import(
  "../src/api/routes/channels_ha.js"
);
const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { getStateDb } = await import("../src/db/state.js");
const { _resetHaWsClientForTests, getHaWsClient } = await import(
  "../src/api/lib/ha_ws_client.js"
);

registerHaHacsRoutes();

// Seed ha_connection so the WS client connects.
getStateDb()
  .prepare(
    `INSERT INTO ha_connection (id, ha_url, label, vault_item_id, state)
     VALUES (1, ?, ?, ?, 'connected')
     ON CONFLICT(id) DO UPDATE SET state='connected'`,
  )
  .run("http://127.0.0.1:8123", "fake", "vw-test-id");

// Vault-cli mock so the WS client can read the LLAT.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url =
    typeof input === "string"
      ? input
      : ((input as { url?: string })?.url ?? String(input));
  if (url.includes("/object/item/")) {
    return new Response(
      JSON.stringify({
        success: true,
        data: { data: { login: { password: "llat_test" } } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return originalFetch(input as Parameters<typeof originalFetch>[0]);
}) as typeof fetch;

interface CallResult {
  status: number;
  payload: any;
}
async function call(
  method: string,
  p: string,
  body?: unknown,
): Promise<CallResult> {
  const [pathOnly, queryStr] = p.split("?", 2);
  const m = matchRoute(method, pathOnly);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    statusCode: 0,
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
      req: { method, headers: {}, url: p } as any,
      res,
      params: m!.params,
      body,
      query: new URLSearchParams(queryStr ?? ""),
    });
  } catch (err) {
    handleError(res, err);
  }
  return { status, payload };
}

async function waitForWsConnected(): Promise<void> {
  getHaWsClient().start();
  for (let i = 0; i < 100; i++) {
    if (getHaWsClient().getStatus().connected) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("WS client never reached connected state");
}

describe("/api/v1/channels/ha/hacs/* — #115/#158 PR5", () => {
  before(async () => {
    await waitForWsConnected();
  });

  beforeEach(() => {
    wsControl.failNext = null;
    wsControl.installCalls.length = 0;
    wsControl.removeCalls.length = 0;
    wsControl.refreshCalls.length = 0;
    wsControl.addCalls.length = 0;
    _resetHaHacsForTests();
    try {
      getStateDb().prepare("DELETE FROM ha_backup_ref").run();
    } catch {
      // ignore
    }
  });

  after(async () => {
    _resetHaWsClientForTests();
    await teardownServer();
    globalThis.fetch = originalFetch;
  });

  // ── 1. GET /ha/hacs/info ──────────────────────────────────────────
  it("GET /ha/hacs/info — returns the verbatim hacs/info payload", async () => {
    const r = await call("GET", "/api/v1/channels/ha/hacs/info");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.deepEqual(r.payload.info.categories, [
      "integration",
      "plugin",
      "theme",
      "appdaemon",
      "netdaemon",
    ]);
    assert.equal(r.payload.info.stage, "running");
  });

  // ── 2. GET /ha/hacs/repos ─────────────────────────────────────────
  it("GET /ha/hacs/repos — returns the normalised list with total + count", async () => {
    const r = await call("GET", "/api/v1/channels/ha/hacs/repos");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.total, 3);
    assert.equal(r.payload.count, 3);
    assert.equal(r.payload.repos[0].name, "better_thermostat");
    assert.equal(r.payload.repos[0].pending_update, true);
    assert.equal(r.payload.repos[1].installed, false);
  });

  it("GET /ha/hacs/repos?category=plugin — filters by category", async () => {
    const r = await call(
      "GET",
      "/api/v1/channels/ha/hacs/repos?category=plugin",
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.count, 1);
    assert.equal(r.payload.repos[0].id, "2");
    assert.equal(r.payload.total, 3, "total reflects upstream, not filter");
  });

  it("GET /ha/hacs/repos?q=thermostat — substring matches name + topics", async () => {
    const r = await call(
      "GET",
      "/api/v1/channels/ha/hacs/repos?q=thermostat",
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.count, 1);
    assert.equal(r.payload.repos[0].id, "1");
  });

  it("GET /ha/hacs/repos?installed=1 — filters to installed-only", async () => {
    const r = await call(
      "GET",
      "/api/v1/channels/ha/hacs/repos?installed=true",
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.count, 2);
    for (const repo of r.payload.repos) {
      assert.equal(repo.installed, true);
    }
  });

  it("GET /ha/hacs/repos?pending=1 — filters to pending-update only", async () => {
    const r = await call(
      "GET",
      "/api/v1/channels/ha/hacs/repos?pending=1",
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.count, 1);
    assert.equal(r.payload.repos[0].pending_update, true);
  });

  it("GET /ha/hacs/repos?limit=2 — clamps the response", async () => {
    const r = await call(
      "GET",
      "/api/v1/channels/ha/hacs/repos?limit=2",
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.count, 2);
    assert.equal(r.payload.total, 3);
  });

  // ── 3. GET /ha/hacs/repo/:id ──────────────────────────────────────
  it("GET /ha/hacs/repo/:id — returns the state + the list view", async () => {
    const r = await call("GET", "/api/v1/channels/ha/hacs/repo/1");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.id, "1");
    assert.equal(r.payload.state.state, "installed");
    assert.equal(r.payload.repo.name, "better_thermostat");
  });

  it("GET /ha/hacs/repo/:id — rejects ids that violate the charset", async () => {
    const r = await call("GET", "/api/v1/channels/ha/hacs/repo/bad%2Fpath");
    // Either the path-router rejects (404) or our validator rejects
    // (400). Both are acceptable — what we forbid is the upstream
    // wsCall firing on a malformed id.
    assert.ok(
      r.status === 400 || r.status === 404,
      `expected 400/404, got ${r.status}: ${JSON.stringify(r.payload)}`,
    );
  });

  // ── 4. POST /ha/hacs/repos (add custom) ──────────────────────────
  it("POST /ha/hacs/repos — adds a custom repo, no gate, no snapshot", async () => {
    const r = await call(
      "POST",
      "/api/v1/channels/ha/hacs/repos",
      { url: "user/cool-thing", category: "integration" },
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.url, "user/cool-thing");
    assert.equal(r.payload.category, "integration");
    assert.equal(wsControl.addCalls.length, 1);
    assert.equal(wsControl.addCalls[0].repository, "user/cool-thing");
    assert.equal(wsControl.addCalls[0].category, "integration");
    // No backup row should have been written.
    const backups = getStateDb()
      .prepare("SELECT COUNT(*) AS n FROM ha_backup_ref")
      .get() as { n: number };
    assert.equal(backups.n, 0, "add must not snapshot");
  });

  it("POST /ha/hacs/repos — 400 on bad category", async () => {
    const r = await call(
      "POST",
      "/api/v1/channels/ha/hacs/repos",
      { url: "user/x", category: "bogus" },
    );
    assert.equal(r.status, 400);
    assert.equal(wsControl.addCalls.length, 0);
  });

  it("POST /ha/hacs/repos — 400 on bad url", async () => {
    const r = await call(
      "POST",
      "/api/v1/channels/ha/hacs/repos",
      { url: "not a url", category: "integration" },
    );
    assert.equal(r.status, 400);
  });

  it("POST /ha/hacs/repos — accepts a full github.com URL", async () => {
    const r = await call(
      "POST",
      "/api/v1/channels/ha/hacs/repos",
      {
        url: "https://github.com/user/cool-thing",
        category: "plugin",
      },
    );
    assert.equal(r.status, 200);
    assert.equal(
      wsControl.addCalls[0].repository,
      "https://github.com/user/cool-thing",
    );
  });

  // ── 5. POST /ha/hacs/install ─────────────────────────────────────
  it("POST /ha/hacs/install — REQUIRES decision_ref (400 without it)", async () => {
    const r = await call(
      "POST",
      "/api/v1/channels/ha/hacs/install",
      { repo_id: "1" },
    );
    assert.equal(r.status, 400, JSON.stringify(r.payload));
    assert.equal(
      wsControl.installCalls.length,
      0,
      "upstream must NOT fire on a gate violation",
    );
  });

  it("POST /ha/hacs/install — snapshots + writes integration ref + daybook", async () => {
    const r = await call(
      "POST",
      "/api/v1/channels/ha/hacs/install",
      { repo_id: "1", version: "1.0.0", decision_ref: DECISION_ID },
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.repo_id, "1");
    assert.equal(r.payload.version, "1.0.0");
    assert.equal(r.payload.entry_id, "hacs:1");
    assert.match(r.payload.ha_backup_id, /^dry-run-/);
    assert.equal(r.payload.daybook.written, true);
    // Upstream install ran with the right payload.
    assert.equal(wsControl.installCalls.length, 1);
    assert.equal(wsControl.installCalls[0].repository, "1");
    assert.equal(wsControl.installCalls[0].version, "1.0.0");
    // ha_integration_ref row landed.
    const row = getStateDb()
      .prepare("SELECT * FROM ha_integration_ref WHERE entry_id = ?")
      .get("hacs:1") as Record<string, unknown> | undefined;
    assert.ok(row, "ha_integration_ref row written");
    assert.equal(row!.installed_by, "alfred");
    assert.equal(row!.decision_ref, DECISION_ID);
    // ha_backup_ref row landed.
    const backupRow = getStateDb()
      .prepare("SELECT * FROM ha_backup_ref WHERE id = ?")
      .get(r.payload.backup_ref_id) as Record<string, unknown> | undefined;
    assert.ok(backupRow);
    assert.equal(backupRow!.triggered_by, "ha__hacs_install");
    // Daybook file has the entry.
    const dayPath = path.join(
      tmp,
      "vault",
      "daybook",
      `${new Date().toISOString().slice(0, 10)}.md`,
    );
    const md = fs.readFileSync(dayPath, "utf-8");
    assert.ok(md.includes("ha__hacs_install"));
    assert.ok(md.includes(DECISION_ID));
  });

  it("POST /ha/hacs/install — surfaces upstream errors as 502", async () => {
    wsControl.failNext = "hacs/repository/download";
    const r = await call(
      "POST",
      "/api/v1/channels/ha/hacs/install",
      { repo_id: "1", decision_ref: DECISION_ID },
    );
    assert.equal(r.status, 502, JSON.stringify(r.payload));
    // The snapshot fires BEFORE the upstream call, so the snapshot
    // row IS in the ledger even when the install fails — that's the
    // contract.
    const backupRows = getStateDb()
      .prepare("SELECT COUNT(*) AS n FROM ha_backup_ref WHERE triggered_by = ?")
      .get("ha__hacs_install") as { n: number };
    assert.equal(backupRows.n, 1);
    // But the integration ledger row does NOT exist — the install
    // failed, nothing was installed.
    const ledger = getStateDb()
      .prepare("SELECT COUNT(*) AS n FROM ha_integration_ref WHERE entry_id = ?")
      .get("hacs:1") as { n: number };
    assert.equal(ledger.n, 0, "no integration ledger row on failed install");
  });

  // ── 6. DELETE /ha/hacs/:id ──────────────────────────────────────
  it("DELETE /ha/hacs/:id — REQUIRES decision_ref", async () => {
    const r = await call(
      "DELETE",
      "/api/v1/channels/ha/hacs/2",
      {},
    );
    assert.equal(r.status, 400);
    assert.equal(wsControl.removeCalls.length, 0);
  });

  it("DELETE /ha/hacs/:id — snapshots + daybooks + removes", async () => {
    const r = await call(
      "DELETE",
      "/api/v1/channels/ha/hacs/2",
      { decision_ref: DECISION_ID },
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.repo_id, "2");
    assert.equal(r.payload.daybook.written, true);
    assert.equal(wsControl.removeCalls.length, 1);
    assert.equal(wsControl.removeCalls[0].repository, "2");
    const backupRows = getStateDb()
      .prepare("SELECT COUNT(*) AS n FROM ha_backup_ref WHERE triggered_by = ?")
      .get("ha__hacs_remove") as { n: number };
    assert.equal(backupRows.n, 1);
  });

  // ── 7. POST /ha/hacs/:id/refresh ─────────────────────────────────
  it("POST /ha/hacs/:id/refresh — no gate, no snapshot, no daybook", async () => {
    const r = await call(
      "POST",
      "/api/v1/channels/ha/hacs/1/refresh",
      {},
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.repo_id, "1");
    assert.equal(wsControl.refreshCalls.length, 1);
    assert.equal(wsControl.refreshCalls[0].repository, "1");
    const backupRows = getStateDb()
      .prepare("SELECT COUNT(*) AS n FROM ha_backup_ref")
      .get() as { n: number };
    assert.equal(backupRows.n, 0);
  });

  it("POST /ha/hacs/:id/refresh — rejects malformed id", async () => {
    const r = await call(
      "POST",
      "/api/v1/channels/ha/hacs/bad%2Fpath/refresh",
      {},
    );
    assert.ok(
      r.status === 400 || r.status === 404,
      `expected 400/404, got ${r.status}`,
    );
  });
});
