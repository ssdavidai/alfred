// Issue #115 PR6 — HA Supervisor addon CRUD integration tests.
//
// PR6 adds 11 routes fronting HA's Supervisor REST surface
// (`${ha_url}/api/hassio/*`). These ONLY work on HA OS; on Container HA /
// Core HA / Supervised installations, every route returns 501 with an
// `{error: "supervisor_not_available", installation_type, message}`
// envelope rather than crashing through to a 502 from HA.
//
// Coverage (10 tests):
//
//   1.  HAOS round-trip: list → info → install → start → configure →
//       stop → restart → uninstall — all 200, install/uninstall record
//       ha_backup_ref rows.
//   2.  Container HA: every addon route returns 501 with the
//       supervisor_not_available envelope.
//   3.  install without decision_ref → 400.
//   4.  install with malformed decision_ref → 400.
//   5.  uninstall without decision_ref → 400.
//   6.  configure without decision_ref → 400.
//   7.  configure without options → 400.
//   8.  update without decision_ref → 400.
//   9.  install with snapshot → ha_backup_ref row carries triggered_by +
//       decision_ref.
//  10.  logs respects `tail` query param + falls back to default.

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-ha-addons-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.SQLITE_VEC_PATH = "";
process.env.VAULT_CLI_URL = "http://vault-cli-stub:8087";
process.env.HA_VAULTWARDEN_FOLDER = "Home Assistant";
process.env.HA_LLAT_ITEM = "LLAT";
process.env.HA_PROBE_TIMEOUT_MS = "5000";
process.env.HA_WRITE_TIMEOUT_MS = "5000";
process.env.HA_ADDON_TIMEOUT_MS = "5000";
process.env.HA_WS_URL_OVERRIDE = "skip";

const VALID_LLAT = "llat_TEST_" + "0".repeat(40);
const HA_URL = "http://homeassistant.local:8123";
const HA_VERSION = "2025.6.1";

// ── fetch mock ─────────────────────────────────────────────────────────

interface VaultItem {
  id: string;
  name: string;
  type: 1;
  folderId: string | null;
  login: { username: string | null; password: string; uris: unknown[] };
}
interface VaultFolder {
  id: string;
  name: string;
}
let vaultStore: VaultItem[] = [];
let vaultFolders: VaultFolder[] = [];

// The configured installation_type returned by HA's /api/config probe.
let mockedInstallationType: string = "Home Assistant OS";

// Supervisor responses keyed by `<METHOD> <PATH>` and a default OK body.
// Tests can override per-call by mutating `supervisorRoutes`.
interface MockResp {
  status?: number;
  body?: unknown;
  raw?: string; // for /logs which is text/plain
}
let supervisorRoutes: Map<string, MockResp> = new Map();
function defaultOk(data: unknown = {}): MockResp {
  return { status: 200, body: { result: "ok", data } };
}

const haCalls: { url: string; method: string; body: string | undefined }[] = [];

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function makeTextResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const bodyRaw = init?.body !== undefined ? String(init.body) : undefined;
  haCalls.push({ url, method, body: bodyRaw });

  // HA /api/ auth gate.
  if (url === `${HA_URL}/api/` && method === "GET") {
    return makeJsonResponse({ message: "API running." }, 200);
  }
  // HA /api/config (used both by /connect AND PR6's installation_type probe).
  if (url === `${HA_URL}/api/config` && method === "GET") {
    return makeJsonResponse(
      {
        version: HA_VERSION,
        installation_type: mockedInstallationType,
      },
      200,
    );
  }

  // Supervisor — match `${HA_URL}/api/hassio/<rest>`.
  if (url.startsWith(`${HA_URL}/api/hassio/`)) {
    const supPath = url.slice(`${HA_URL}`.length); // includes /api/hassio/...
    const key = `${method} ${supPath}`;
    const resp = supervisorRoutes.get(key);
    if (!resp) {
      return makeJsonResponse(
        { result: "error", message: `no mock for ${key}` },
        404,
      );
    }
    if (resp.raw !== undefined) {
      return makeTextResponse(resp.raw, resp.status ?? 200);
    }
    return makeJsonResponse(resp.body ?? null, resp.status ?? 200);
  }

  // vault-cli folders.
  if (url.endsWith("/list/object/folders") && method === "GET") {
    // LIST endpoints are double-wrapped per the helper expectation.
    return makeJsonResponse({ success: true, data: { data: vaultFolders } });
  }
  if (url.endsWith("/object/folder") && method === "POST") {
    const b = JSON.parse(bodyRaw ?? "{}");
    const f: VaultFolder = {
      id: "fld-" + String(Date.now()) + "-" + Math.random().toString(36).slice(2, 6),
      name: b.name,
    };
    vaultFolders.push(f);
    // SINGLE-object create endpoints are single-wrapped per the
    // post-23917969 fix on channels_ha.ts:ensureVaultFolder.
    return makeJsonResponse({ success: true, data: f });
  }
  // vault-cli items.
  if (url.includes("/list/object/items")) {
    // LIST endpoints stay double-wrapped per the helper expectation.
    const qIdx = url.indexOf("?");
    const params = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");
    const search = params.get("search") ?? "";
    const filtered = search
      ? vaultStore.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()))
      : vaultStore.slice();
    return makeJsonResponse({ success: true, data: { data: filtered } });
  }
  const objMatch = url.match(/\/object\/item\/([^/?]+)/);
  if (objMatch && method === "GET") {
    const id = objMatch[1];
    const item = vaultStore.find((i) => i.id === id);
    if (!item) return makeJsonResponse({ success: false, message: "not found" }, 404);
    // SINGLE-object endpoints are single-wrapped post-23917969.
    return makeJsonResponse({ success: true, data: item });
  }
  if (url.endsWith("/object/item") && method === "POST") {
    const b = JSON.parse(bodyRaw ?? "{}");
    const id = "id-" + String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
    const item: VaultItem = {
      id,
      name: b.name,
      type: 1,
      folderId: b.folderId ?? null,
      login: {
        username: b.login?.username ?? null,
        password: b.login?.password ?? "",
        uris: b.login?.uris ?? [],
      },
    };
    vaultStore.push(item);
    return makeJsonResponse({ success: true, data: item });
  }
  if (objMatch && method === "PUT") {
    const id = objMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
    const b = JSON.parse(bodyRaw ?? "{}");
    vaultStore[idx] = {
      ...vaultStore[idx],
      name: b.name ?? vaultStore[idx].name,
      folderId: b.folderId ?? vaultStore[idx].folderId,
      login: { ...vaultStore[idx].login, ...(b.login ?? {}) },
    };
    return makeJsonResponse({ success: true, data: vaultStore[idx] });
  }
  if (objMatch && method === "DELETE") {
    const id = objMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
    vaultStore.splice(idx, 1);
    return makeJsonResponse({ success: true });
  }
  throw new Error(`unexpected fetch in test_channels_ha_addons: ${method} ${url}`);
}) as typeof fetch;

// ── module imports (after env + fetch are wired) ──────────────────────

const {
  registerChannelsHaRoutes,
  _resetHaSubscriptionsForTests,
  _resetHaAddonsForTests,
  _resetHaInstallationTypeCache,
} = await import("../src/api/routes/channels_ha.js");
const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { getStateDb } = await import("../src/db/state.js");

registerChannelsHaRoutes();

interface CallResult {
  status: number;
  payload: any;
}
async function call(
  method: string,
  p: string,
  body?: unknown,
): Promise<CallResult> {
  // Split the query string off so matchRoute() matches against the path
  // alone (PR4's call helper doesn't pass a query, but PR6's /logs needs
  // it).
  const qIdx = p.indexOf("?");
  const pathname = qIdx >= 0 ? p.slice(0, qIdx) : p;
  const query = new URLSearchParams(qIdx >= 0 ? p.slice(qIdx + 1) : "");
  const m = matchRoute(method, pathname);
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
      query,
    });
  } catch (err) {
    handleError(res, err);
  }
  return { status, payload };
}

async function connectHa(): Promise<void> {
  const r = await call("POST", "/api/v1/channels/ha/connect", {
    ha_url: HA_URL,
    llat: VALID_LLAT,
    label: "Test",
  });
  assert.equal(r.status, 200, JSON.stringify(r.payload));
}

// ── tests ──────────────────────────────────────────────────────────────

describe("/api/v1/channels/ha/addons — #115 PR6 supervisor addon CRUD", () => {
  beforeEach(() => {
    vaultStore = [];
    vaultFolders = [];
    haCalls.length = 0;
    supervisorRoutes = new Map();
    mockedInstallationType = "Home Assistant OS";
    const db = getStateDb();
    try {
      db.prepare("DELETE FROM ha_connection").run();
      db.prepare("DELETE FROM ha_run").run();
      db.prepare("DELETE FROM ha_proposal").run();
      db.prepare("DELETE FROM ha_snapshot").run();
      db.prepare("DELETE FROM ha_event").run();
      db.prepare("DELETE FROM ha_event_subscription").run();
    } catch {
      // first run before any table exists
    }
    _resetHaSubscriptionsForTests();
    _resetHaAddonsForTests();
    _resetHaInstallationTypeCache();
  });

  // ── 1 ── HAOS full round-trip
  it("HAOS round-trip: list → info → install → start → configure → stop → restart → uninstall", async () => {
    await connectHa();
    // Pre-seed Supervisor mocks for every step.
    supervisorRoutes.set(
      "GET /api/hassio/addons",
      defaultOk({
        addons: [
          {
            slug: "core_mosquitto",
            name: "Mosquitto broker",
            version: "6.4.1",
            state: "stopped",
          },
        ],
      }),
    );
    supervisorRoutes.set(
      "GET /api/hassio/addons/core_mosquitto/info",
      defaultOk({
        slug: "core_mosquitto",
        version: "6.4.1",
        version_latest: "6.5.0",
        state: "stopped",
        options: { logins: [] },
      }),
    );
    supervisorRoutes.set(
      "POST /api/hassio/addons/core_mosquitto/install",
      defaultOk({}),
    );
    supervisorRoutes.set(
      "POST /api/hassio/addons/core_mosquitto/start",
      defaultOk({}),
    );
    supervisorRoutes.set(
      "POST /api/hassio/addons/core_mosquitto/options",
      defaultOk({}),
    );
    supervisorRoutes.set(
      "POST /api/hassio/addons/core_mosquitto/stop",
      defaultOk({}),
    );
    supervisorRoutes.set(
      "POST /api/hassio/addons/core_mosquitto/restart",
      defaultOk({}),
    );
    supervisorRoutes.set(
      "POST /api/hassio/addons/core_mosquitto/uninstall",
      defaultOk({}),
    );

    const decision_ref = "decision/2026-05-29-mosquitto-install.md";

    // list
    const list = await call("GET", "/api/v1/channels/ha/addons");
    assert.equal(list.status, 200, JSON.stringify(list.payload));
    assert.equal(list.payload.installation_type, "Home Assistant OS");
    assert.ok(Array.isArray(list.payload.data?.addons));

    // info
    const info = await call(
      "GET",
      "/api/v1/channels/ha/addons/core_mosquitto",
    );
    assert.equal(info.status, 200, JSON.stringify(info.payload));
    assert.equal(info.payload.slug, "core_mosquitto");
    assert.equal(info.payload.data?.slug, "core_mosquitto");

    // install
    const install = await call(
      "POST",
      "/api/v1/channels/ha/addons/core_mosquitto/install",
      { decision_ref },
    );
    assert.equal(install.status, 200, JSON.stringify(install.payload));
    assert.equal(install.payload.decision_ref, decision_ref);
    assert.ok(typeof install.payload.backup_ref_id === "string");
    assert.ok(typeof install.payload.ha_backup_id === "string");

    // start
    const start = await call(
      "POST",
      "/api/v1/channels/ha/addons/core_mosquitto/start",
    );
    assert.equal(start.status, 200, JSON.stringify(start.payload));

    // configure
    const configure = await call(
      "PUT",
      "/api/v1/channels/ha/addons/core_mosquitto/options",
      {
        decision_ref: "decision/2026-05-29-mosquitto-cfg.md",
        options: { logins: [{ username: "alfred", password: "x" }] },
      },
    );
    assert.equal(configure.status, 200, JSON.stringify(configure.payload));
    assert.equal(
      configure.payload.decision_ref,
      "decision/2026-05-29-mosquitto-cfg.md",
    );

    // stop
    const stop = await call(
      "POST",
      "/api/v1/channels/ha/addons/core_mosquitto/stop",
    );
    assert.equal(stop.status, 200, JSON.stringify(stop.payload));

    // restart
    const restart = await call(
      "POST",
      "/api/v1/channels/ha/addons/core_mosquitto/restart",
    );
    assert.equal(restart.status, 200, JSON.stringify(restart.payload));

    // uninstall
    const uninstall = await call(
      "POST",
      "/api/v1/channels/ha/addons/core_mosquitto/uninstall",
      { decision_ref: "decision/2026-05-29-mosquitto-uninstall.md" },
    );
    assert.equal(uninstall.status, 200, JSON.stringify(uninstall.payload));
    assert.ok(typeof uninstall.payload.backup_ref_id === "string");

    // ha_backup_ref carries both snapshot intents.
    const refs = getStateDb()
      .prepare(
        "SELECT triggered_by, decision_ref FROM ha_backup_ref ORDER BY ts",
      )
      .all() as any[];
    assert.equal(refs.length, 2);
    assert.equal(refs[0].triggered_by, "ha__addon_install");
    assert.equal(refs[1].triggered_by, "ha__addon_uninstall");
  });

  // ── 2 ── Container HA: every route 501s
  it("Container HA returns 501 supervisor_not_available on every addon route", async () => {
    await connectHa();
    mockedInstallationType = "Home Assistant Container";
    _resetHaInstallationTypeCache(); // re-probe

    const checks: { method: string; path: string; body?: any }[] = [
      { method: "GET", path: "/api/v1/channels/ha/addons" },
      { method: "GET", path: "/api/v1/channels/ha/addons/core_mosquitto" },
      {
        method: "POST",
        path: "/api/v1/channels/ha/addons/core_mosquitto/install",
        body: { decision_ref: "decision/2026-05-29.md" },
      },
      {
        method: "POST",
        path: "/api/v1/channels/ha/addons/core_mosquitto/uninstall",
        body: { decision_ref: "decision/2026-05-29.md" },
      },
      {
        method: "PUT",
        path: "/api/v1/channels/ha/addons/core_mosquitto/options",
        body: { decision_ref: "decision/2026-05-29.md", options: {} },
      },
      {
        method: "POST",
        path: "/api/v1/channels/ha/addons/core_mosquitto/start",
      },
      {
        method: "POST",
        path: "/api/v1/channels/ha/addons/core_mosquitto/stop",
      },
      {
        method: "POST",
        path: "/api/v1/channels/ha/addons/core_mosquitto/restart",
      },
      {
        method: "POST",
        path: "/api/v1/channels/ha/addons/core_mosquitto/update",
        body: { decision_ref: "decision/2026-05-29.md" },
      },
      {
        method: "GET",
        path: "/api/v1/channels/ha/addons/core_mosquitto/logs",
      },
      {
        method: "GET",
        path: "/api/v1/channels/ha/addons/core_mosquitto/stats",
      },
    ];
    for (const c of checks) {
      const r = await call(c.method, c.path, c.body);
      assert.equal(
        r.status,
        501,
        `${c.method} ${c.path} expected 501, got ${r.status}: ${JSON.stringify(r.payload)}`,
      );
      assert.equal(r.payload.error, "supervisor_not_available");
      assert.equal(r.payload.installation_type, "Home Assistant Container");
      assert.ok(typeof r.payload.message === "string");
    }
  });

  // ── 3 ── install without decision_ref
  it("install without decision_ref → 400 VALIDATION_ERROR", async () => {
    await connectHa();
    const r = await call(
      "POST",
      "/api/v1/channels/ha/addons/core_mosquitto/install",
      {},
    );
    assert.equal(r.status, 400, JSON.stringify(r.payload));
    assert.equal(r.payload.error?.code, "VALIDATION_ERROR");
  });

  // ── 4 ── install with malformed decision_ref
  it("install with malformed decision_ref (too short) → 400 VALIDATION_ERROR", async () => {
    await connectHa();
    const r = await call(
      "POST",
      "/api/v1/channels/ha/addons/core_mosquitto/install",
      { decision_ref: "x" },
    );
    assert.equal(r.status, 400, JSON.stringify(r.payload));
    assert.equal(r.payload.error?.code, "VALIDATION_ERROR");
  });

  // ── 5 ── uninstall without decision_ref
  it("uninstall without decision_ref → 400 VALIDATION_ERROR", async () => {
    await connectHa();
    const r = await call(
      "POST",
      "/api/v1/channels/ha/addons/core_mosquitto/uninstall",
      {},
    );
    assert.equal(r.status, 400, JSON.stringify(r.payload));
    assert.equal(r.payload.error?.code, "VALIDATION_ERROR");
  });

  // ── 6 ── configure without decision_ref
  it("configure without decision_ref → 400 VALIDATION_ERROR", async () => {
    await connectHa();
    const r = await call(
      "PUT",
      "/api/v1/channels/ha/addons/core_mosquitto/options",
      { options: {} },
    );
    assert.equal(r.status, 400, JSON.stringify(r.payload));
    assert.equal(r.payload.error?.code, "VALIDATION_ERROR");
  });

  // ── 7 ── configure without options
  it("configure without options → 400 VALIDATION_ERROR", async () => {
    await connectHa();
    const r = await call(
      "PUT",
      "/api/v1/channels/ha/addons/core_mosquitto/options",
      { decision_ref: "decision/2026-05-29-cfg.md" },
    );
    assert.equal(r.status, 400, JSON.stringify(r.payload));
    assert.equal(r.payload.error?.code, "VALIDATION_ERROR");
  });

  // ── 8 ── update without decision_ref
  it("update without decision_ref → 400 VALIDATION_ERROR", async () => {
    await connectHa();
    const r = await call(
      "POST",
      "/api/v1/channels/ha/addons/core_mosquitto/update",
      {},
    );
    assert.equal(r.status, 400, JSON.stringify(r.payload));
    assert.equal(r.payload.error?.code, "VALIDATION_ERROR");
  });

  // ── 9 ── snapshot recorded in ha_backup_ref on install
  it("install records ha_backup_ref row with triggered_by + decision_ref BEFORE upstream call", async () => {
    await connectHa();
    // Pre-arrange upstream install to fail — snapshot row should still
    // land because it's recorded before the upstream call.
    supervisorRoutes.set(
      "POST /api/hassio/addons/core_mosquitto/install",
      { status: 500, body: { result: "error", message: "boom" } },
    );

    const r = await call(
      "POST",
      "/api/v1/channels/ha/addons/core_mosquitto/install",
      { decision_ref: "decision/2026-05-29-snapshot-test.md" },
    );
    // Upstream fails → ctrl-api returns the upstream status code.
    assert.notEqual(r.status, 200);
    // But ha_backup_ref should carry the intent.
    const refs = getStateDb()
      .prepare(
        "SELECT triggered_by, decision_ref, ha_backup_id FROM ha_backup_ref",
      )
      .all() as any[];
    assert.equal(refs.length, 1);
    assert.equal(refs[0].triggered_by, "ha__addon_install");
    assert.equal(
      refs[0].decision_ref,
      "decision/2026-05-29-snapshot-test.md",
    );
    // PR1 isn't shipped yet → ha_backup_id is the `pending-pr1-<ulid>`
    // placeholder.
    assert.ok(
      String(refs[0].ha_backup_id).startsWith("pending-pr1-"),
      `expected placeholder, got ${refs[0].ha_backup_id}`,
    );
  });

  // ── 10 ── logs honours `tail` query param
  it("logs respects tail query param (default 200, max 2000)", async () => {
    await connectHa();
    // 500 lines of synthetic log.
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) lines.push(`line ${i}`);
    const fullText = lines.join("\n");
    supervisorRoutes.set(
      "GET /api/hassio/addons/core_mosquitto/logs",
      { raw: fullText },
    );

    // Default — tail = 200 → last 200 of 500.
    const def = await call(
      "GET",
      "/api/v1/channels/ha/addons/core_mosquitto/logs",
    );
    assert.equal(def.status, 200, JSON.stringify(def.payload));
    assert.equal(def.payload.tail, 200);
    assert.ok(def.payload.logs.startsWith("line 300"));
    assert.ok(def.payload.logs.endsWith("line 499"));

    // Explicit tail=50.
    const small = await call(
      "GET",
      "/api/v1/channels/ha/addons/core_mosquitto/logs?tail=50",
    );
    assert.equal(small.status, 200, JSON.stringify(small.payload));
    assert.equal(small.payload.tail, 50);
    assert.ok(small.payload.logs.startsWith("line 450"));

    // tail clamp — request 5000, served capped at 2000 (which is ≥ 500 →
    // returns all 500 lines).
    const big = await call(
      "GET",
      "/api/v1/channels/ha/addons/core_mosquitto/logs?tail=5000",
    );
    assert.equal(big.status, 200, JSON.stringify(big.payload));
    assert.equal(big.payload.tail, 500);
  });
});
