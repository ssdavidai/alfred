// Gap 3b backend — GET/PUT /api/v1/settings/signal-action-mode.
//
// The endpoint persists the principal's chosen signal-action mode (live vs
// shadow) to /alfred-data/settings.json so Lane II's _resolve_mode reader
// picks it up. Read precedence: env STEWARD_SIGNAL_ACTION_LIVE_MODE (override)
// → settings.json `signal_action_mode` → default "live".
//
// Test discipline:
//   - GET default when file absent → mode=live, source=default
//   - PUT shadow → file written atomically → next GET returns mode=shadow,
//     source=settings_file
//   - PUT invalid value → 400
//   - Env override → GET reports env_override_active=true, mode from env,
//     source=env_override
//   - File malformed → GET falls back to default + logs warning
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "settings-sam-"));
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

const ROUTE = "/api/v1/settings/signal-action-mode";

async function call(
  method: "GET" | "PUT",
  body?: unknown,
): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, ROUTE);
  assert.ok(m, `${method} ${ROUTE} must be registered`);
  let status = 200;
  let payload: any;
  const res = {
    writeHead(s: number) {
      status = s;
      return res;
    },
    end(json?: string) {
      payload = json ? JSON.parse(json) : undefined;
    },
  } as unknown as ServerResponse;
  try {
    await m!.handler({
      req: { url: ROUTE, method } as any,
      res,
      params: m!.params,
      body,
      query: new URLSearchParams(),
    });
  } catch (err: any) {
    // ApiError thrown by handlers → translate into a status+payload like the
    // server's handleError would, so each test can assert against {status,payload}.
    if (err && typeof err.statusCode === "number") {
      status = err.statusCode;
      payload = { error: { code: err.code, message: err.message } };
    } else {
      throw err;
    }
  }
  return { status, payload };
}

function cleanFile() {
  try {
    fs.unlinkSync(SETTINGS_FILE);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(SETTINGS_FILE + ".tmp");
  } catch {
    /* ignore */
  }
}

describe("GET/PUT /api/v1/settings/signal-action-mode (Gap 3b)", () => {
  beforeEach(() => {
    cleanFile();
    delete process.env.STEWARD_SIGNAL_ACTION_LIVE_MODE;
  });

  it("GET default when settings file absent → mode=live, source=default", async () => {
    const { status, payload } = await call("GET");
    assert.strictEqual(status, 200);
    assert.deepEqual(payload, {
      mode: "live",
      source: "default",
      env_override_active: false,
    });
  });

  it("PUT shadow → next GET returns mode=shadow, source=settings_file; file is atomic", async () => {
    const put = await call("PUT", { mode: "shadow" });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.payload.mode, "shadow");
    assert.strictEqual(put.payload.source, "settings_file");

    // File on disk is JSON with the right key.
    const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.signal_action_mode, "shadow");

    // Temp file should not linger.
    assert.strictEqual(fs.existsSync(SETTINGS_FILE + ".tmp"), false);

    const get = await call("GET");
    assert.deepEqual(get.payload, {
      mode: "shadow",
      source: "settings_file",
      env_override_active: false,
    });
  });

  it("PUT preserves other keys already in settings.json", async () => {
    fs.writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ unrelated: "leave-me-alone", signal_action_mode: "live" }),
      "utf-8",
    );
    const put = await call("PUT", { mode: "shadow" });
    assert.strictEqual(put.status, 200);
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    assert.strictEqual(parsed.unrelated, "leave-me-alone");
    assert.strictEqual(parsed.signal_action_mode, "shadow");
  });

  it("PUT invalid mode → 400", async () => {
    const r1 = await call("PUT", { mode: "loud" });
    assert.strictEqual(r1.status, 400);
    const r2 = await call("PUT", {});
    assert.strictEqual(r2.status, 400);
    const r3 = await call("PUT", { mode: 7 });
    assert.strictEqual(r3.status, 400);
  });

  it("env override → source=env_override + env_override_active=true", async () => {
    fs.writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ signal_action_mode: "shadow" }),
      "utf-8",
    );
    process.env.STEWARD_SIGNAL_ACTION_LIVE_MODE = "live";
    const { payload } = await call("GET");
    assert.deepEqual(payload, {
      mode: "live",
      source: "env_override",
      env_override_active: true,
    });
  });

  it("env override accepts 'shadow' too", async () => {
    process.env.STEWARD_SIGNAL_ACTION_LIVE_MODE = "shadow";
    const { payload } = await call("GET");
    assert.deepEqual(payload, {
      mode: "shadow",
      source: "env_override",
      env_override_active: true,
    });
  });

  it("malformed settings.json → GET falls back to default, does not 500", async () => {
    fs.writeFileSync(SETTINGS_FILE, "{not valid json", "utf-8");
    const { status, payload } = await call("GET");
    assert.strictEqual(status, 200);
    assert.deepEqual(payload, {
      mode: "live",
      source: "default",
      env_override_active: false,
    });
  });

  after(() => cleanFile());
});
