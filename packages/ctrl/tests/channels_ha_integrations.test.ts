// /api/v1/channels/ha/integrations/* — #115 PR4 config_flow CRUD.
//
// Drives HA's multi-step config_flow API through ctrl-api. All routes
// go through the long-lived HaWsClient (PR1) which the tests stub via
// `globalThis.__haWsTestStub`. We never open a real WS connection here
// — HA_WS_URL_OVERRIDE=skip keeps the singleton dormant.
//
// Coverage (14 tests):
//
//   1.  list integrations: empty → 200, [], alfred audit block defaults
//   2.  list available integrations: get_handlers returns the handler list
//   3.  discover (flow_init): valid domain → 200, flow_id + step shape
//   4.  discover: invalid domain shape → 400 VALIDATION_ERROR
//   5.  configure WITHOUT decision_ref → 400, no WS call, no snapshot
//   6.  configure WITH decision_ref, single-step `create_entry` → 200,
//       entry_id, ha_integration_ref row written, ha_backup_ref row written,
//       daybook line appended
//   7.  configure multi-step (form → progress → create_entry) — three calls,
//       three snapshots, ha_integration_ref written ONCE at create_entry
//   8.  configure: abort step → 200, no ha_integration_ref row, daybook
//       records the abort reason
//   9.  remove WITHOUT decision_ref → 400, no WS call
//  10.  remove WITH decision_ref → 200, snapshot + soft-delete (removed_at)
//  11.  reload: no gate; 200 + WS call to config_entries/reload
//  12.  info: existing entry → 200; missing entry → 404
//  13.  flow/:flow_id progress: existing flow → 200; missing → 404
//  14.  HA_NOT_CONNECTED: discover before /connect → 409

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-ha-integrations-"));
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
process.env.HA_INTEGRATION_TIMEOUT_MS = "5000";
process.env.HA_WS_URL_OVERRIDE = "skip";
// PR1's triggerBackupBeforeAction dry-run mode — stamps a placeholder
// ha_backup_id rather than touching the WS. The integration tests still
// drive ha_backup_ref correctly through this path.
process.env.HA_SNAPSHOT_DRY_RUN = "1";

const VALID_LLAT = "llat_TEST_" + "0".repeat(40);
const HA_URL = "http://homeassistant.local:8123";
const HA_VERSION = "2025.6.1";

// ── vault-cli fetch mock ───────────────────────────────────────────────

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

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const bodyRaw = init?.body !== undefined ? String(init.body) : undefined;

  // HA /api/ auth gate.
  if (url === `${HA_URL}/api/` && method === "GET") {
    return makeJsonResponse({ message: "API running." }, 200);
  }
  // HA /api/config — used by /connect.
  if (url === `${HA_URL}/api/config` && method === "GET") {
    return makeJsonResponse({ version: HA_VERSION }, 200);
  }

  // vault-cli folders.
  if (url.endsWith("/list/object/folders") && method === "GET") {
    return makeJsonResponse({ success: true, data: { data: vaultFolders } });
  }
  if (url.endsWith("/object/folder") && method === "POST") {
    const b = JSON.parse(bodyRaw ?? "{}");
    const f: VaultFolder = {
      id: "fld-" + String(Date.now()) + "-" + Math.random().toString(36).slice(2, 6),
      name: b.name,
    };
    vaultFolders.push(f);
    return makeJsonResponse({ success: true, data: f });
  }
  // vault-cli items.
  if (url.includes("/list/object/items")) {
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
  throw new Error(`unexpected fetch in test_channels_ha_integrations: ${method} ${url}`);
}) as typeof fetch;

// ── WS stub ─────────────────────────────────────────────────────────────
//
// channels_ha.ts:loadHaWsClient picks up globalThis.__haWsTestStub if
// set; we install ours below. The stub records every wsCall (type +
// payload) and returns either a queued response or a per-type default.

interface WsCall {
  type: string;
  payload: Record<string, unknown>;
}
const wsCalls: WsCall[] = [];
type WsResponder = (payload: Record<string, unknown>) => unknown;
const wsResponders = new Map<string, WsResponder>();

function setWsResponder(type: string, responder: WsResponder | unknown): void {
  if (typeof responder === "function") {
    wsResponders.set(type, responder as WsResponder);
  } else {
    wsResponders.set(type, () => responder);
  }
}

(globalThis as any).__haWsTestStub = {
  async wsCall(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    wsCalls.push({ type, payload });
    const r = wsResponders.get(type);
    if (!r) {
      throw new Error(`test stub: no wsCall responder for ${type}`);
    }
    return r(payload);
  },
};

// ── module imports (after env + stubs are wired) ──────────────────────

const {
  registerChannelsHaRoutes,
  _resetHaSubscriptionsForTests,
  _resetHaAddonsForTests,
  _resetHaInstallationTypeCache,
  _resetHaIntegrationsForTests,
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

describe("/api/v1/channels/ha/integrations — #115 PR4 config_flow CRUD", () => {
  beforeEach(() => {
    vaultStore = [];
    vaultFolders = [];
    wsCalls.length = 0;
    wsResponders.clear();
    const db = getStateDb();
    try {
      db.prepare("DELETE FROM ha_connection").run();
      db.prepare("DELETE FROM ha_run").run();
      db.prepare("DELETE FROM ha_proposal").run();
      db.prepare("DELETE FROM ha_snapshot").run();
      db.prepare("DELETE FROM ha_event").run();
      db.prepare("DELETE FROM ha_event_subscription").run();
      db.prepare("DELETE FROM ha_backup_ref").run();
      db.prepare("DELETE FROM ha_integration_ref").run();
    } catch {
      // first run before any table exists
    }
    _resetHaSubscriptionsForTests();
    _resetHaAddonsForTests();
    _resetHaInstallationTypeCache();
    _resetHaIntegrationsForTests();
    // Clean the daybook directory between tests so the read-back is
    // deterministic per-test.
    try {
      fs.rmSync(path.join(tmp, "vault", "daybook"), {
        recursive: true,
        force: true,
      });
    } catch {
      // best-effort
    }
  });

  // ── 1 ── list integrations: empty
  it("GET /integrations returns 200 + entries (empty), each row gains alfred audit block defaults", async () => {
    await connectHa();
    setWsResponder("config_entries/get", []);
    const r = await call("GET", "/api/v1/channels/ha/integrations");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.deepEqual(r.payload.entries, []);

    // And with one row already in HA, the route hydrates the alfred audit block.
    setWsResponder("config_entries/get", [
      { entry_id: "01JC123ABC", title: "Hue Bridge", domain: "hue", state: "loaded" },
    ]);
    const r2 = await call("GET", "/api/v1/channels/ha/integrations");
    assert.equal(r2.status, 200);
    assert.equal(r2.payload.entries.length, 1);
    assert.equal(r2.payload.entries[0].entry_id, "01JC123ABC");
    // No matching ha_integration_ref row → 'sir' default.
    assert.equal(r2.payload.entries[0].alfred.installed_by, "sir");
    assert.equal(r2.payload.entries[0].alfred.decision_ref, null);
  });

  // ── 2 ── list available integrations
  it("GET /integrations/available returns 200 + handlers", async () => {
    await connectHa();
    setWsResponder(
      "config_entries/get_handlers",
      ["hue", "mqtt", "nest", "google_assistant"],
    );
    const r = await call("GET", "/api/v1/channels/ha/integrations/available");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.deepEqual(r.payload.handlers, ["hue", "mqtt", "nest", "google_assistant"]);
    // Verify WS was called exactly once with the right type.
    const handlerCalls = wsCalls.filter(
      (c) => c.type === "config_entries/get_handlers",
    );
    assert.equal(handlerCalls.length, 1);
  });

  // ── 3 ── discover (flow_init): valid domain
  it("POST /integrations/discover returns flow_id + first step descriptor", async () => {
    await connectHa();
    setWsResponder("config_entries/flow/init", (payload) => {
      assert.equal(payload.handler, "hue");
      assert.equal(payload.show_advanced_options, false);
      return {
        flow_id: "abc123flow",
        handler: "hue",
        step_id: "init",
        type: "form",
        data_schema: [{ name: "host", type: "string" }],
        errors: {},
      };
    });
    const r = await call(
      "POST",
      "/api/v1/channels/ha/integrations/discover",
      { domain: "hue" },
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.flow_id, "abc123flow");
    assert.equal(r.payload.domain, "hue");
    assert.equal(r.payload.step.type, "form");
    assert.equal(r.payload.step.step_id, "init");
  });

  // ── 4 ── discover: invalid domain shape
  it("POST /integrations/discover rejects malformed domain", async () => {
    await connectHa();
    // No WS responder needed — assertion fires before the WS call.
    const r = await call(
      "POST",
      "/api/v1/channels/ha/integrations/discover",
      { domain: "Has-Caps" },
    );
    assert.equal(r.status, 400);
    assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    // No WS call happened.
    const initCalls = wsCalls.filter(
      (c) => c.type === "config_entries/flow/init",
    );
    assert.equal(initCalls.length, 0);
  });

  // ── 5 ── configure WITHOUT decision_ref
  it("POST /integrations/configure/:flow_id rejects missing decision_ref BEFORE snapshot + WS call", async () => {
    await connectHa();
    const r = await call(
      "POST",
      "/api/v1/channels/ha/integrations/configure/abc123flow",
      { data: { host: "192.168.1.42" } }, // no decision_ref
    );
    assert.equal(r.status, 400);
    assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    // No WS call to flow/configure.
    const cfg = wsCalls.filter(
      (c) => c.type === "config_entries/flow/configure",
    );
    assert.equal(cfg.length, 0);
    // No backup row recorded.
    const refs = getStateDb()
      .prepare("SELECT id FROM ha_backup_ref")
      .all() as { id: string }[];
    assert.equal(refs.length, 0);
  });

  // ── 6 ── configure single-step create_entry
  it("POST /integrations/configure/:flow_id (single-step → create_entry) writes ha_integration_ref + daybook", async () => {
    await connectHa();
    setWsResponder("config_entries/flow/configure", (payload) => {
      assert.equal(payload.flow_id, "abc123flow");
      assert.deepEqual(payload.data, { host: "192.168.1.42" });
      return {
        type: "create_entry",
        flow_id: "abc123flow",
        handler: "hue",
        title: "Hue Bridge",
        result: { entry_id: "01JC123ABC", title: "Hue Bridge" },
      };
    });
    const decision_ref = "decision/2026-05-29-hue.md";
    const r = await call(
      "POST",
      "/api/v1/channels/ha/integrations/configure/abc123flow",
      { data: { host: "192.168.1.42" }, decision_ref },
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.flow_id, "abc123flow");
    assert.equal(r.payload.entry_id, "01JC123ABC");
    assert.equal(r.payload.decision_ref, decision_ref);
    assert.ok(typeof r.payload.backup_ref_id === "string" && r.payload.backup_ref_id.length > 0);
    assert.ok(typeof r.payload.ha_backup_id === "string");

    // ha_integration_ref row written.
    const ref = getStateDb()
      .prepare(
        "SELECT entry_id, installed_by, decision_ref, removed_at FROM ha_integration_ref WHERE entry_id = ?",
      )
      .get("01JC123ABC") as any;
    assert.equal(ref.entry_id, "01JC123ABC");
    assert.equal(ref.installed_by, "alfred");
    assert.equal(ref.decision_ref, decision_ref);
    assert.equal(ref.removed_at, null);

    // ha_backup_ref row written.
    const brefs = getStateDb()
      .prepare(
        "SELECT triggered_by, decision_ref FROM ha_backup_ref ORDER BY ts",
      )
      .all() as any[];
    assert.equal(brefs.length, 1);
    assert.equal(brefs[0].triggered_by, "ha__integration_configure");
    assert.equal(brefs[0].decision_ref, decision_ref);

    // Daybook line appended for the create_entry.
    const day = new Date().toISOString().slice(0, 10);
    const dayPath = path.join(tmp, "vault", "daybook", `${day}.md`);
    const txt = fs.readFileSync(dayPath, "utf-8");
    assert.ok(txt.includes("HA writes"), `daybook missing HA writes section: ${txt}`);
    assert.ok(
      txt.includes("ha__integration_configure"),
      `daybook missing action: ${txt}`,
    );
    assert.ok(
      txt.includes("01JC123ABC"),
      `daybook missing entry_id: ${txt}`,
    );
  });

  // ── 7 ── configure multi-step (form → progress → create_entry)
  it("POST /integrations/configure/:flow_id multi-step: 3 snapshots, ref written once on create_entry", async () => {
    await connectHa();
    let step = 0;
    setWsResponder("config_entries/flow/configure", () => {
      step++;
      if (step === 1) {
        // First configure response is another form (e.g. "press the button").
        return {
          type: "form",
          flow_id: "multi-flow",
          step_id: "link",
          data_schema: [],
          description_placeholders: { name: "Living Room bridge" },
        };
      }
      if (step === 2) {
        // Second response: progress (HA is still working).
        return {
          type: "progress",
          flow_id: "multi-flow",
          progress_action: "wait_for_authorisation",
        };
      }
      // Third response: create_entry.
      return {
        type: "create_entry",
        flow_id: "multi-flow",
        title: "Hue Bridge",
        result: { entry_id: "01JCMULTI", title: "Hue Bridge" },
      };
    });
    const decision_ref = "decision/2026-05-29-hue-multi.md";

    // Step 1: form-pass-through.
    const r1 = await call(
      "POST",
      "/api/v1/channels/ha/integrations/configure/multi-flow",
      { data: { host: "192.168.1.42" }, decision_ref },
    );
    assert.equal(r1.status, 200);
    assert.equal(r1.payload.entry_id, null);
    assert.equal(r1.payload.step.type, "form");
    // No ha_integration_ref row yet.
    let refCount = (
      getStateDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM ha_integration_ref WHERE entry_id = ?",
        )
        .get("01JCMULTI") as any
    ).n;
    assert.equal(refCount, 0);

    // Step 2: progress.
    const r2 = await call(
      "POST",
      "/api/v1/channels/ha/integrations/configure/multi-flow",
      { data: {}, decision_ref },
    );
    assert.equal(r2.status, 200);
    assert.equal(r2.payload.entry_id, null);
    assert.equal(r2.payload.step.type, "progress");

    // Step 3: create_entry.
    const r3 = await call(
      "POST",
      "/api/v1/channels/ha/integrations/configure/multi-flow",
      { data: {}, decision_ref },
    );
    assert.equal(r3.status, 200);
    assert.equal(r3.payload.entry_id, "01JCMULTI");

    // 3 snapshot rows (one per configure step).
    const brefs = getStateDb()
      .prepare(
        "SELECT triggered_by FROM ha_backup_ref WHERE decision_ref = ? ORDER BY ts",
      )
      .all(decision_ref) as any[];
    assert.equal(brefs.length, 3);
    assert.equal(brefs[0].triggered_by, "ha__integration_configure");

    // Ref row written exactly once, at the create_entry step.
    refCount = (
      getStateDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM ha_integration_ref WHERE entry_id = ?",
        )
        .get("01JCMULTI") as any
    ).n;
    assert.equal(refCount, 1);
  });

  // ── 8 ── configure: abort step
  it("POST /integrations/configure abort step records daybook reason but no ha_integration_ref row", async () => {
    await connectHa();
    setWsResponder("config_entries/flow/configure", () => ({
      type: "abort",
      flow_id: "abort-flow",
      reason: "already_configured",
    }));
    const decision_ref = "decision/2026-05-29-hue-abort.md";
    const r = await call(
      "POST",
      "/api/v1/channels/ha/integrations/configure/abort-flow",
      { data: { host: "x.x.x.x" }, decision_ref },
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.entry_id, null);
    assert.equal(r.payload.step.type, "abort");
    assert.equal(r.payload.step.reason, "already_configured");

    // ha_integration_ref still empty.
    const cnt = (
      getStateDb()
        .prepare("SELECT COUNT(*) AS n FROM ha_integration_ref")
        .get() as any
    ).n;
    assert.equal(cnt, 0);

    // Daybook records the abort reason.
    const day = new Date().toISOString().slice(0, 10);
    const dayPath = path.join(tmp, "vault", "daybook", `${day}.md`);
    const txt = fs.readFileSync(dayPath, "utf-8");
    assert.ok(txt.includes("already_configured"), `daybook missing reason: ${txt}`);
  });

  // ── 9 ── remove WITHOUT decision_ref
  it("DELETE /integrations/:entry_id rejects missing decision_ref BEFORE WS call", async () => {
    await connectHa();
    const r = await call(
      "DELETE",
      "/api/v1/channels/ha/integrations/01JC123ABC",
      {}, // no decision_ref
    );
    assert.equal(r.status, 400);
    assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    const cfg = wsCalls.filter((c) => c.type === "config_entries/remove");
    assert.equal(cfg.length, 0);
  });

  // ── 10 ── remove WITH decision_ref → soft-delete
  it("DELETE /integrations/:entry_id stamps removed_at + snapshot + daybook", async () => {
    await connectHa();
    // Pre-seed the integration ref so we observe the soft-delete on an
    // alfred-installed row (not a sir-installed upsert).
    setWsResponder("config_entries/flow/configure", () => ({
      type: "create_entry",
      flow_id: "f1",
      result: { entry_id: "01JCRM", title: "Removable" },
    }));
    const decision_ref_install = "decision/2026-05-29-install.md";
    await call(
      "POST",
      "/api/v1/channels/ha/integrations/configure/f1",
      { data: {}, decision_ref: decision_ref_install },
    );
    const refBefore = getStateDb()
      .prepare(
        "SELECT installed_by, removed_at FROM ha_integration_ref WHERE entry_id = ?",
      )
      .get("01JCRM") as any;
    assert.equal(refBefore.installed_by, "alfred");
    assert.equal(refBefore.removed_at, null);

    // Now remove.
    setWsResponder("config_entries/remove", () => ({ require_restart: false }));
    const decision_ref_rm = "decision/2026-05-29-remove.md";
    const r = await call(
      "DELETE",
      "/api/v1/channels/ha/integrations/01JCRM",
      { decision_ref: decision_ref_rm },
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.entry_id, "01JCRM");
    assert.ok(typeof r.payload.backup_ref_id === "string");

    // Soft-delete stamped.
    const refAfter = getStateDb()
      .prepare(
        "SELECT installed_by, removed_at FROM ha_integration_ref WHERE entry_id = ?",
      )
      .get("01JCRM") as any;
    assert.equal(refAfter.installed_by, "alfred");
    assert.ok(typeof refAfter.removed_at === "string" && refAfter.removed_at.length > 0);

    // ha_backup_ref includes the remove snapshot.
    const brefs = getStateDb()
      .prepare(
        "SELECT triggered_by FROM ha_backup_ref WHERE decision_ref = ?",
      )
      .all(decision_ref_rm) as any[];
    assert.equal(brefs.length, 1);
    assert.equal(brefs[0].triggered_by, "ha__integration_remove");
  });

  // ── 11 ── reload
  it("POST /integrations/:entry_id/reload — no gate, no snapshot, WS reload called", async () => {
    await connectHa();
    setWsResponder("config_entries/reload", (payload) => {
      assert.equal(payload.entry_id, "01JCRELOAD");
      return { require_restart: false };
    });
    const r = await call(
      "POST",
      "/api/v1/channels/ha/integrations/01JCRELOAD/reload",
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.entry_id, "01JCRELOAD");
    // No backup row recorded.
    const cnt = (
      getStateDb()
        .prepare("SELECT COUNT(*) AS n FROM ha_backup_ref")
        .get() as any
    ).n;
    assert.equal(cnt, 0);
  });

  // ── 12 ── info: existing + missing
  it("GET /integrations/:entry_id returns 200 on match + 404 on miss", async () => {
    await connectHa();
    setWsResponder("config_entries/get", [
      { entry_id: "01JCINFO", title: "Existing", domain: "hue" },
    ]);
    const ok = await call(
      "GET",
      "/api/v1/channels/ha/integrations/01JCINFO",
    );
    assert.equal(ok.status, 200, JSON.stringify(ok.payload));
    assert.equal(ok.payload.entry_id, "01JCINFO");
    assert.equal(ok.payload.entry.title, "Existing");

    const miss = await call(
      "GET",
      "/api/v1/channels/ha/integrations/01JCMISSING",
    );
    assert.equal(miss.status, 404, JSON.stringify(miss.payload));
  });

  // ── 13 ── flow progress
  it("GET /integrations/flow/:flow_id returns 200 on match + 404 on miss", async () => {
    await connectHa();
    setWsResponder("config_entries/flow/progress", () => [
      {
        flow_id: "live-flow",
        handler: "hue",
        step_id: "link",
        type: "form",
      },
    ]);
    const ok = await call(
      "GET",
      "/api/v1/channels/ha/integrations/flow/live-flow",
    );
    assert.equal(ok.status, 200, JSON.stringify(ok.payload));
    assert.equal(ok.payload.flow_id, "live-flow");
    assert.equal(ok.payload.flow.step_id, "link");

    const miss = await call(
      "GET",
      "/api/v1/channels/ha/integrations/flow/dead-flow",
    );
    assert.equal(miss.status, 404, JSON.stringify(miss.payload));
  });

  // ── 14 ── HA_NOT_CONNECTED gate
  it("POST /integrations/discover returns 409 HA_NOT_CONNECTED before /connect", async () => {
    // intentionally NOT calling connectHa()
    const r = await call(
      "POST",
      "/api/v1/channels/ha/integrations/discover",
      { domain: "hue" },
    );
    assert.equal(r.status, 409, JSON.stringify(r.payload));
    assert.equal(r.payload.error.code, "HA_NOT_CONNECTED");
    // No WS call happened.
    const initCalls = wsCalls.filter(
      (c) => c.type === "config_entries/flow/init",
    );
    assert.equal(initCalls.length, 0);
  });
});
