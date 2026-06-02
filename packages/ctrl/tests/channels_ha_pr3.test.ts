// /api/v1/channels/ha/{automations,scenes,scripts}/* — #115 PR3 CRUD.
//
// REST-only (no WS dependency). Spec doc:
//   docs/specs/issue-115-ha-tier4-autonomy.md §4 (gate matrix locked YES).
//
// Coverage (10 round-trip tests):
//   1.  automations: list → 200 + array
//   2.  automations: create → 200 + automation_id slug + ha_run row
//   3.  automations: update via PUT → 200 + ha_run row
//   4.  automations: DELETE WITHOUT decision_ref → 400 VALIDATION_ERROR + no HA call
//   5.  automations: DELETE WITH valid decision_ref → 200 + decision_ref in ha_run
//   6.  scenes: create → 200 + scene_id slug + ha_run row
//   7.  scenes: DELETE → 200 (no gate)
//   8.  scripts: create → 200 + script_id slug + ha_run row
//   9.  scripts: update via PUT → 200 + ha_run row
//   10. all writes blocked when HA_NOT_CONNECTED → 409
//
// The HA REST surface is mocked via globalThis.fetch — same pattern as
// channels_ha_pr4.test.ts. The vault-cli stub serves the LLAT.

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-ha-pr3-"));
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
process.env.HA_LOOP_GUARD_COOLDOWN_MS = "60000";
process.env.HA_WS_URL_OVERRIDE = "skip"; // bypass real WS connect in tests

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

// HA mock state. Each test resets in beforeEach.
let haConfigGetMap: Map<string, string | null> = new Map();
let haConfigShouldFail = false;
let haStates: unknown[] = [];
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
  // HA /api/config — used by /connect.
  if (url === `${HA_URL}/api/config` && method === "GET") {
    return makeJsonResponse({ version: HA_VERSION }, 200);
  }

  // HA /api/states — for scenes/scripts list.
  if (url === `${HA_URL}/api/states` && method === "GET") {
    return makeJsonResponse(haStates, 200);
  }

  // HA /api/config/{automation,scene,script}/config (list) and /:id (get/post/delete).
  const cfgListMatch = url.match(
    /^http:\/\/homeassistant\.local:8123\/api\/config\/(automation|scene|script)\/config$/,
  );
  if (cfgListMatch && method === "GET") {
    if (haConfigShouldFail) {
      return makeJsonResponse({ error: "boom" }, 500);
    }
    const kind = cfgListMatch[1];
    const entries: unknown[] = [];
    for (const [key, val] of haConfigGetMap.entries()) {
      if (key.startsWith(`${kind}:`) && val !== null) {
        try {
          entries.push({ id: key.slice(kind.length + 1), ...JSON.parse(val) });
        } catch {
          // skip
        }
      }
    }
    return makeJsonResponse(entries, 200);
  }
  const cfgIdMatch = url.match(
    /^http:\/\/homeassistant\.local:8123\/api\/config\/(automation|scene|script)\/config\/([^/?]+)$/,
  );
  if (cfgIdMatch) {
    const kind = cfgIdMatch[1];
    const id = decodeURIComponent(cfgIdMatch[2]);
    const key = `${kind}:${id}`;
    if (method === "GET") {
      const v = haConfigGetMap.get(key);
      if (v === null || v === undefined) {
        return makeJsonResponse({ error: "not found" }, 404);
      }
      return makeTextResponse(v, 200);
    }
    if (method === "POST") {
      // Persist whatever was sent so subsequent GETs reflect it.
      haConfigGetMap.set(key, bodyRaw ?? "");
      return makeJsonResponse({ result: "ok" }, 200);
    }
    if (method === "DELETE") {
      if (!haConfigGetMap.has(key)) {
        return makeJsonResponse({ error: "not found" }, 404);
      }
      haConfigGetMap.delete(key);
      return makeJsonResponse({ result: "ok" }, 200);
    }
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
    // bw serve single-object endpoints are SINGLE-wrapped per #157.
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
    // single-object GET — bw serve responds with single-wrap envelope
    // (PR #157 fix lives in vault-cli helper read path; we match the
    // current production shape).
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
    // bw serve single-object endpoints are SINGLE-wrapped per #157.
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
  throw new Error(`unexpected fetch in test_channels_ha_pr3: ${method} ${url}`);
}) as typeof fetch;

// ── module imports (after env + fetch are wired) ──────────────────────

const { registerChannelsHaRoutes } = await import(
  "../src/api/routes/channels_ha.js"
);
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
  const m = matchRoute(method, p);
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
      query: new URLSearchParams(),
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

describe("/api/v1/channels/ha/{automations,scenes,scripts} — #115 PR3", () => {
  beforeEach(() => {
    vaultStore = [];
    vaultFolders = [];
    haCalls.length = 0;
    haConfigGetMap = new Map();
    haConfigShouldFail = false;
    haStates = [];
    const db = getStateDb();
    try {
      db.prepare("DELETE FROM ha_connection").run();
      db.prepare("DELETE FROM ha_run").run();
    } catch {
      // first run before any table exists
    }
  });

  // ── 1 ── automations list
  it("GET /automations → 200 + array (passes through HA list)", async () => {
    await connectHa();
    haConfigGetMap.set(
      "automation:morning_routine",
      JSON.stringify({
        alias: "Morning routine",
        trigger: { platform: "time", at: "06:30" },
        action: { service: "light.turn_on", target: { area_id: "kitchen" } },
      }),
    );

    const r = await call("GET", "/api/v1/channels/ha/automations");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.ok(Array.isArray(r.payload.data));
    assert.equal(r.payload.data.length, 1);
    assert.equal(r.payload.data[0].alias, "Morning routine");
  });

  // ── 2 ── automation create — happy path
  it("POST /automations → 200 + slug-derived automation_id + ha_run", async () => {
    await connectHa();

    const r = await call("POST", "/api/v1/channels/ha/automations", {
      alias: "Lights off at sunrise",
      trigger: { platform: "sun", event: "sunrise" },
      action: { service: "light.turn_off", target: { area_id: "living_room" } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.automation_id, "lights_off_at_sunrise");
    assert.ok(typeof r.payload.run_id === "string" && r.payload.run_id.length > 0);

    // ha_run row exists with the expected shape.
    const run = getStateDb()
      .prepare("SELECT * FROM ha_run WHERE id = ?")
      .get(r.payload.run_id) as any;
    assert.ok(run, "ha_run row must exist");
    assert.equal(run.kind, "automation_create");
    assert.equal(run.entity_id, "automation.lights_off_at_sunrise");
    assert.equal(run.outcome, "ok");
    // decision_ref is empty string (no gate on create); the schema's column
    // is NOT NULL but accepts empty strings.
    assert.equal(run.decision_ref, "");

    // HA was actually called.
    assert.ok(
      haCalls.some(
        (c) =>
          c.method === "POST" &&
          c.url ===
            `${HA_URL}/api/config/automation/config/lights_off_at_sunrise`,
      ),
    );
  });

  // ── 3 ── automation update via PUT
  it("PUT /automations/:id → 200 + ha_run row carries kind=automation_update", async () => {
    await connectHa();
    // Pre-existing config so HA's POST upsert is sensible.
    haConfigGetMap.set(
      "automation:morning_routine",
      JSON.stringify({ alias: "Morning routine", trigger: [], action: [] }),
    );

    const r = await call(
      "PUT",
      "/api/v1/channels/ha/automations/morning_routine",
      {
        alias: "Morning routine v2",
        action: { service: "light.turn_on", target: { area_id: "kitchen" } },
      },
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.automation_id, "morning_routine");

    const run = getStateDb()
      .prepare("SELECT * FROM ha_run WHERE id = ?")
      .get(r.payload.run_id) as any;
    assert.equal(run.kind, "automation_update");
    assert.equal(run.entity_id, "automation.morning_routine");
    assert.equal(run.outcome, "ok");
  });

  // ── 4 ── automation DELETE without decision_ref → 400
  it("DELETE /automations/:id WITHOUT decision_ref → 400 VALIDATION_ERROR, no HA call", async () => {
    await connectHa();
    haConfigGetMap.set(
      "automation:drop_me",
      JSON.stringify({ alias: "Drop me", trigger: [], action: [] }),
    );
    haCalls.length = 0;

    const r = await call(
      "DELETE",
      "/api/v1/channels/ha/automations/drop_me",
      {},
    );
    assert.equal(r.status, 400, JSON.stringify(r.payload));
    assert.equal(r.payload.error.code, "VALIDATION_ERROR");

    // No HA DELETE was fired.
    assert.equal(
      haCalls.filter(
        (c) =>
          c.method === "DELETE" && c.url.includes("/api/config/automation/"),
      ).length,
      0,
    );

    // The automation is still in the mock store (delete did not happen).
    assert.ok(haConfigGetMap.has("automation:drop_me"));
  });

  // ── 5 ── automation DELETE with valid decision_ref → 200
  it("DELETE /automations/:id with valid decision_ref → 200 + ha_run carries decision_ref", async () => {
    await connectHa();
    haConfigGetMap.set(
      "automation:drop_me",
      JSON.stringify({ alias: "Drop me", trigger: [], action: [] }),
    );

    const r = await call(
      "DELETE",
      "/api/v1/channels/ha/automations/drop_me",
      { decision_ref: "decision/2026-05-29-drop-me.md" },
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.automation_id, "drop_me");
    assert.equal(r.payload.decision_ref, "decision/2026-05-29-drop-me.md");

    const run = getStateDb()
      .prepare("SELECT * FROM ha_run WHERE id = ?")
      .get(r.payload.run_id) as any;
    assert.equal(run.kind, "automation_delete");
    assert.equal(run.entity_id, "automation.drop_me");
    assert.equal(run.outcome, "ok");
    assert.equal(run.decision_ref, "decision/2026-05-29-drop-me.md");

    // HA delete actually fired.
    assert.ok(
      haCalls.some(
        (c) =>
          c.method === "DELETE" &&
          c.url === `${HA_URL}/api/config/automation/config/drop_me`,
      ),
    );

    // Mock store no longer has the automation.
    assert.equal(haConfigGetMap.has("automation:drop_me"), false);
  });

  // ── 6 ── scene create — no gate, cheap
  it("POST /scenes → 200 + slug scene_id + ha_run kind=scene_create", async () => {
    await connectHa();

    const r = await call("POST", "/api/v1/channels/ha/scenes", {
      name: "Bedtime",
      entities: {
        "light.bedroom_main": { state: "on", brightness_pct: 15 },
        "light.living_room_lamp": { state: "off" },
      },
      icon: "mdi:weather-night",
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.scene_id, "bedtime");

    const run = getStateDb()
      .prepare("SELECT * FROM ha_run WHERE id = ?")
      .get(r.payload.run_id) as any;
    assert.equal(run.kind, "scene_create");
    assert.equal(run.entity_id, "scene.bedtime");
    assert.equal(run.outcome, "ok");
    // No gate, no decision_ref required → recorded as empty string.
    assert.equal(run.decision_ref, "");
  });

  // ── 7 ── scene DELETE — no gate, cheap
  it("DELETE /scenes/:id (no gate, no decision_ref) → 200 + ha_run kind=scene_delete", async () => {
    await connectHa();
    haConfigGetMap.set(
      "scene:bedtime",
      JSON.stringify({ name: "Bedtime", entities: {} }),
    );

    const r = await call(
      "DELETE",
      "/api/v1/channels/ha/scenes/bedtime",
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.scene_id, "bedtime");

    const run = getStateDb()
      .prepare("SELECT * FROM ha_run WHERE id = ?")
      .get(r.payload.run_id) as any;
    assert.equal(run.kind, "scene_delete");
    assert.equal(run.entity_id, "scene.bedtime");
    assert.equal(run.outcome, "ok");

    // Mock store no longer has the scene.
    assert.equal(haConfigGetMap.has("scene:bedtime"), false);
  });

  // ── 8 ── script create — no gate, cheap
  it("POST /scripts → 200 + slug script_id + ha_run kind=script_create", async () => {
    await connectHa();

    const r = await call("POST", "/api/v1/channels/ha/scripts", {
      alias: "Goodnight",
      sequence: [
        { service: "scene.turn_on", target: { entity_id: "scene.bedtime" } },
        { delay: "00:05:00" },
        { service: "lock.lock", target: { entity_id: "lock.front_door" } },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.script_id, "goodnight");

    const run = getStateDb()
      .prepare("SELECT * FROM ha_run WHERE id = ?")
      .get(r.payload.run_id) as any;
    assert.equal(run.kind, "script_create");
    assert.equal(run.entity_id, "script.goodnight");
    assert.equal(run.outcome, "ok");

    // HA was actually called with the alias body.
    const haPost = haCalls.find(
      (c) =>
        c.method === "POST" &&
        c.url === `${HA_URL}/api/config/script/config/goodnight`,
    );
    assert.ok(haPost, "HA POST must have fired");
    const sent = JSON.parse(haPost!.body!);
    assert.equal(sent.alias, "Goodnight");
    assert.equal(Array.isArray(sent.sequence), true);
    assert.equal(sent.sequence.length, 3);
  });

  // ── 9 ── script update via PUT
  it("PUT /scripts/:id → 200 + ha_run kind=script_update", async () => {
    await connectHa();
    haConfigGetMap.set(
      "script:goodnight",
      JSON.stringify({ alias: "Goodnight", sequence: [] }),
    );

    const r = await call(
      "PUT",
      "/api/v1/channels/ha/scripts/goodnight",
      { sequence: [{ delay: "00:01:00" }] },
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.script_id, "goodnight");

    const run = getStateDb()
      .prepare("SELECT * FROM ha_run WHERE id = ?")
      .get(r.payload.run_id) as any;
    assert.equal(run.kind, "script_update");
    assert.equal(run.entity_id, "script.goodnight");
    assert.equal(run.outcome, "ok");
  });

  // ── 10 ── all writes 409 when HA_NOT_CONNECTED
  it("all writes blocked when HA_NOT_CONNECTED → 409", async () => {
    // Deliberately NOT connecting first — the ha_connection row is empty.
    const cases: Array<[string, string, unknown]> = [
      ["POST", "/api/v1/channels/ha/automations", { alias: "x", trigger: {}, action: {} }],
      ["PUT", "/api/v1/channels/ha/automations/x", { alias: "x" }],
      [
        "DELETE",
        "/api/v1/channels/ha/automations/x",
        { decision_ref: "decision/2026-05-29-x.md" },
      ],
      ["POST", "/api/v1/channels/ha/scenes", { name: "x", entities: {} }],
      ["PUT", "/api/v1/channels/ha/scenes/x", { name: "x" }],
      ["DELETE", "/api/v1/channels/ha/scenes/x", undefined],
      ["POST", "/api/v1/channels/ha/scripts", { alias: "x", sequence: [] }],
      ["PUT", "/api/v1/channels/ha/scripts/x", { alias: "x" }],
      ["DELETE", "/api/v1/channels/ha/scripts/x", undefined],
    ];
    for (const [method, p, body] of cases) {
      const r = await call(method, p, body);
      assert.equal(
        r.status,
        409,
        `${method} ${p} should 409 when HA not connected; got ${JSON.stringify(r.payload)}`,
      );
    }
  });
});
