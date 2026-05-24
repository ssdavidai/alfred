// Multi-key settings endpoint — generalises the Gap-3b signal-action-mode
// endpoint to handle the wider family of principal-facing live↔shadow toggles
// (sir-matter-task #5).
//
// Endpoint shape under test:
//   GET  /api/v1/settings              → { <key>: ResolvedMode, ... } for every key
//   GET  /api/v1/settings/:key         → single ResolvedMode (also accepts hyphenated alias)
//   PUT  /api/v1/settings/:key  body { mode } → writes settings.json, returns ResolvedMode
//
// Registered keys (all share the {live,shadow} value space + env-override > file >
// default precedence):
//   signal_action_mode    env STEWARD_SIGNAL_ACTION_LIVE_MODE
//   state_mutator_mode    env STEWARD_LIVE_MODE
//   auto_task_create_mode env STEWARD_SIGNAL_AUTOCREATE_TASKS
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "settings-multi-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";
fs.mkdirSync(process.env.VAULT_PATH!, { recursive: true });

const { registerSettingsRoutes, SETTINGS_FILE } = await import(
  "../src/api/routes/settings.js"
);
const { matchRoute } = await import("../src/api/server.js");
registerSettingsRoutes();

const ALL_KEYS = [
  "signal_action_mode",
  "state_mutator_mode",
  "auto_task_create_mode",
] as const;

async function call(
  method: "GET" | "PUT",
  url: string,
  body?: unknown,
): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, url);
  assert.ok(m, `${method} ${url} must be registered`);
  let status = 200;
  let payload: any;
  const res = {
    writeHead(s: number) { status = s; return res; },
    end(json?: string) { payload = json ? JSON.parse(json) : undefined; },
  } as unknown as ServerResponse;
  try {
    await m!.handler({
      req: { url, method } as any, res, params: m!.params, body,
      query: new URLSearchParams(),
    });
  } catch (err: any) {
    if (err && typeof err.statusCode === "number") {
      status = err.statusCode;
      payload = { error: { code: err.code, message: err.message } };
    } else { throw err; }
  }
  return { status, payload };
}

function reset() {
  try { fs.unlinkSync(SETTINGS_FILE); } catch { /* ignore */ }
  try { fs.unlinkSync(SETTINGS_FILE + ".tmp"); } catch { /* ignore */ }
  delete process.env.STEWARD_SIGNAL_ACTION_LIVE_MODE;
  delete process.env.STEWARD_LIVE_MODE;
  delete process.env.STEWARD_SIGNAL_AUTOCREATE_TASKS;
}

describe("GET/PUT /api/v1/settings (multi-key, sir-matter-task #5)", () => {
  beforeEach(reset);

  it("combined GET returns all 3 keys with defaults when file is absent", async () => {
    const { status, payload } = await call("GET", "/api/v1/settings");
    assert.strictEqual(status, 200);
    for (const k of ALL_KEYS) {
      assert.deepEqual(payload[k], {
        mode: "live", source: "default", env_override_active: false,
      }, `key ${k}`);
    }
  });

  it("PUT one key is independent — other keys keep their defaults", async () => {
    await call("PUT", "/api/v1/settings/signal_action_mode", { mode: "shadow" });
    for (const k of ["state_mutator_mode", "auto_task_create_mode"]) {
      const { payload } = await call("GET", `/api/v1/settings/${k}`);
      assert.deepEqual(payload, {
        mode: "live", source: "default", env_override_active: false,
      }, `untouched ${k}`);
    }
  });

  it("PUT state_mutator_mode reflects in combined GET; other keys unchanged", async () => {
    await call("PUT", "/api/v1/settings/state_mutator_mode", { mode: "shadow" });
    const { payload } = await call("GET", "/api/v1/settings");
    assert.deepEqual(payload.state_mutator_mode, {
      mode: "shadow", source: "settings_file", env_override_active: false,
    });
    assert.strictEqual(payload.signal_action_mode.source, "default");
    assert.strictEqual(payload.auto_task_create_mode.source, "default");
  });

  it("PUT auto_task_create_mode persists to disk and reads back", async () => {
    await call("PUT", "/api/v1/settings/auto_task_create_mode", { mode: "shadow" });
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    assert.strictEqual(raw.auto_task_create_mode, "shadow");
    const g = await call("GET", "/api/v1/settings/auto_task_create_mode");
    assert.deepEqual(g.payload, {
      mode: "shadow", source: "settings_file", env_override_active: false,
    });
  });

  it("backwards compat: hyphenated GET + PUT /api/v1/settings/signal-action-mode still work", async () => {
    const put = await call("PUT", "/api/v1/settings/signal-action-mode", { mode: "shadow" });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")).signal_action_mode, "shadow");
    const get = await call("GET", "/api/v1/settings/signal-action-mode");
    assert.deepEqual(get.payload, {
      mode: "shadow", source: "settings_file", env_override_active: false,
    });
  });

  it("unknown key → 400 for both GET and PUT", async () => {
    assert.strictEqual((await call("GET", "/api/v1/settings/not_a_real_key")).status, 400);
    assert.strictEqual((await call("PUT", "/api/v1/settings/not_a_real_key", { mode: "live" })).status, 400);
  });

  it("invalid mode body → 400 for every registered key", async () => {
    for (const k of ALL_KEYS) {
      assert.strictEqual((await call("PUT", `/api/v1/settings/${k}`, { mode: "loud" })).status, 400, k);
      assert.strictEqual((await call("PUT", `/api/v1/settings/${k}`, {})).status, 400, `${k} empty`);
    }
  });

  it("env STEWARD_LIVE_MODE → state_mutator_mode reports env_override_active=true (settings.json loses)", async () => {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ state_mutator_mode: "shadow" }), "utf-8");
    process.env.STEWARD_LIVE_MODE = "shadow";
    const { payload } = await call("GET", "/api/v1/settings/state_mutator_mode");
    assert.deepEqual(payload, {
      mode: "shadow", source: "env_override", env_override_active: true,
    });
  });

  it("env STEWARD_SIGNAL_AUTOCREATE_TASKS → only auto_task_create_mode is env-coloured in combined GET", async () => {
    process.env.STEWARD_SIGNAL_AUTOCREATE_TASKS = "shadow";
    const { payload } = await call("GET", "/api/v1/settings");
    assert.strictEqual(payload.auto_task_create_mode.env_override_active, true);
    assert.strictEqual(payload.auto_task_create_mode.source, "env_override");
    assert.strictEqual(payload.signal_action_mode.env_override_active, false);
    assert.strictEqual(payload.state_mutator_mode.env_override_active, false);
  });

  it("PUT preserves unrelated keys already in settings.json (read-modify-write)", async () => {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      unrelated: "leave-me-alone", signal_action_mode: "live",
    }), "utf-8");
    await call("PUT", "/api/v1/settings/state_mutator_mode", { mode: "shadow" });
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    assert.strictEqual(raw.unrelated, "leave-me-alone");
    assert.strictEqual(raw.signal_action_mode, "live");
    assert.strictEqual(raw.state_mutator_mode, "shadow");
  });

  after(reset);
});
