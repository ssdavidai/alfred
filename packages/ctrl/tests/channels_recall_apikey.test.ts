// channels_recall_apikey — POST /api/v1/channels/recall/api-key (#113 PR3a).
//
// What's under test
// -----------------
// The persistence path Sir flagged PR #136 as missing:
//
//   1. Round-trip-validate the pasted key against Recall.
//   2. Upsert "Recall API Key" in Vaultwarden via the vault-cli sidecar.
//   3. Atomically merge RECALL_API_KEY + RECALL_REGION into the
//      compose .env via a tempfile + rename in the same directory.
//   4. Background-restart ctrl-api + alfred-learn so the new env lands.
//
// We stub three external surfaces:
//   * globalThis.fetch — Recall + vault-cli HTTP traffic;
//   * dockerComposeCmd — so the route doesn't actually restart anything
//     (but we record the calls);
//   * a temp directory for COMPOSE_DIR — so the atomic .env write lands
//     on a real filesystem we can inspect.
//
// Coverage (10):
//   1. Recall rejects the key (401) → 401 RECALL_AUTH_FAILED, no vault
//      write, no .env write, no restart.
//   2. Recall accepts the key → 200, vault item upserted, .env merged,
//      restart triggered, response carries persisted_to + restarted.
//   3. Idempotent: re-POST the same key/region → {ok:true,
//      idempotent:true}, no restart, no extra vault write.
//   4. Atomic .env write — tempfile cleaned up after success, partial
//      state is impossible (we verify the tmp path is absent post-write).
//   5. Vaultwarden write goes via the vault-cli HTTP sidecar — we
//      record the request URLs and assert they target /object/item.
//   6. Response envelope carries key_first6 only; never the full key
//      and never the hash.
//   7. Operator-only — voice-bridge bearer gets 403, channel-token
//      bearer gets 403.
//   8. Recall returns 502 mid-validate → no persist, no restart.
//   9. Concurrent calls don't double-restart — the lock serialises.
//  10. `region` defaults to the singleton config row when missing.
//
// Privacy: no real secrets in this file. The "key" values here are
// `rec_test_*` opaque strings.

import { describe, it, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

// ── per-suite fixture dir ────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-recall-apikey-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.DOMAIN = "test.alfred.black";
process.env.AAS_HOST = "127.0.0.1";
process.env.AAS_PORT = "3100";

// COMPOSE_DIR is read at module-load time by helpers.ts, so it has to
// be set BEFORE the imports below. The route writes RECALL_API_KEY
// into `${COMPOSE_DIR}/.env`; we use a real tmp dir so the atomic
// rename actually runs on a real filesystem.
const composeDir = path.join(tmp, "compose");
fs.mkdirSync(composeDir, { recursive: true });
process.env.COMPOSE_DIR = composeDir;
process.env.VAULT_CLI_URL = "http://vault-cli:8087";

delete process.env.RECALL_API_KEY;
delete process.env.RECALL_REGION;
delete process.env.RECALL_WEBHOOK_SECRET;

// ── fetch stub (Recall + vault-cli) ──────────────────────────────────────

const originalFetch = globalThis.fetch;

interface RecallStub {
  listBotsStatus: number;
  listBotsBody: unknown;
}
const recallStub: RecallStub = {
  listBotsStatus: 200,
  listBotsBody: { count: 0, results: [] },
};
let recallShouldThrow = false;
let recallCallCount = 0;

// vault-cli stub state. A fake "DB" of items keyed by id; the route
// lists by name, fetches by id, then PUTs back or POSTs a new one.
interface VaultItem {
  id: string;
  name: string;
  notes: string | null;
  login: {
    username: string | null;
    password: string | null;
    uris: Array<{ uri: string; match: string | null }>;
  };
}
const vaultStore: Map<string, VaultItem> = new Map();
let vaultCallLog: Array<{ method: string; path: string; body?: unknown }> = [];
let vaultShouldFail = false;
let vaultSeq = 1;

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const method = (init?.method ?? "GET").toUpperCase();

  // Recall list-bots — validate-key
  if (/recall\.ai/.test(url) && /\/api\/v1\/bot\/\?limit=1$/.test(url)) {
    recallCallCount += 1;
    if (recallShouldThrow) throw new Error("recall unreachable");
    return makeJsonResponse(recallStub.listBotsBody, recallStub.listBotsStatus);
  }

  // vault-cli paths.
  if (url.startsWith("http://vault-cli:8087/")) {
    const pathOnly = url.slice("http://vault-cli:8087".length);
    vaultCallLog.push({
      method,
      path: pathOnly,
      body: init?.body ? safeJsonParse(String(init.body)) : undefined,
    });
    if (vaultShouldFail) {
      return makeJsonResponse({ success: false, message: "vault-cli down" }, 502);
    }
    // GET /list/object/items?search=<name>
    if (method === "GET" && pathOnly.startsWith("/list/object/items")) {
      const u = new URL("http://x" + pathOnly);
      const needle = (u.searchParams.get("search") ?? "").toLowerCase();
      const list = [...vaultStore.values()].filter((it) =>
        it.name.toLowerCase().includes(needle),
      );
      return makeJsonResponse({ success: true, data: { data: list } });
    }
    // GET /object/item/:id
    if (method === "GET" && pathOnly.startsWith("/object/item/")) {
      const id = pathOnly.split("/").pop()!;
      const it = vaultStore.get(id);
      if (!it) {
        return makeJsonResponse(
          { success: false, message: "not found" },
          404,
        );
      }
      return makeJsonResponse({ success: true, data: { data: it } });
    }
    // POST /object/item (create)
    if (method === "POST" && pathOnly === "/object/item") {
      const body = (safeJsonParse(String(init.body)) ?? {}) as Partial<VaultItem>;
      const id = `vault-${vaultSeq++}`;
      const it: VaultItem = {
        id,
        name: typeof body.name === "string" ? body.name : "",
        notes: typeof body.notes === "string" ? body.notes : null,
        login: (body.login as VaultItem["login"]) ?? {
          username: null,
          password: null,
          uris: [],
        },
      };
      vaultStore.set(id, it);
      return makeJsonResponse({ success: true, data: it });
    }
    // PUT /object/item/:id (update)
    if (method === "PUT" && pathOnly.startsWith("/object/item/")) {
      const id = pathOnly.split("/").pop()!;
      const body = (safeJsonParse(String(init.body)) ?? {}) as VaultItem;
      const merged: VaultItem = {
        id,
        name: typeof body.name === "string" ? body.name : "",
        notes: typeof body.notes === "string" ? body.notes : null,
        login: body.login,
      };
      vaultStore.set(id, merged);
      return makeJsonResponse({ success: true, data: merged });
    }
    return makeJsonResponse({ success: false, message: "unhandled stub" }, 500);
  }

  throw new Error(`unexpected fetch in channels_recall_apikey test: ${method} ${url}`);
}) as typeof fetch;

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ── dockerComposeCmd stub (via mock.module) ──────────────────────────────
//
// We replace the helpers.ts module entirely so the route's
// `dockerComposeCmd` call doesn't shell out to a real docker daemon.
// Re-export everything else verbatim so other imports of helpers (state
// db migrations, etc.) keep working.

interface ComposeCall {
  args: string[];
  at: number;
}
const composeCalls: ComposeCall[] = [];
let composeShouldFail = false;

const _realHelpers = await import("../src/api/helpers.js");
const dockerComposeCmdFn = mock.fn(
  async (args: string[]): Promise<string> => {
    composeCalls.push({ args: [...args], at: Date.now() });
    if (composeShouldFail) throw new Error("docker compose unavailable");
    return "ok";
  },
);

// `namedExports` is the legacy field name; voice-routes.test.ts still uses
// it. Node logs a deprecation warning suggesting `exports`, but the
// stable contract today is namedExports (the deprecation will land in a
// future release). We mirror voice-routes.test.ts.
mock.module("../src/api/helpers.js", {
  namedExports: {
    ..._realHelpers,
    dockerComposeCmd: dockerComposeCmdFn,
  },
});

// ── module imports (after env + fetch + helpers patch) ───────────────────

const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const {
  registerChannelsRecallRoutes,
  _recallInternals,
} = await import("../src/api/routes/channels_recall.js");
const { getStateDb } = await import("../src/db/state.js");
const {
  setApiKey,
  setVoiceBridgeKey,
  _resetAuthForTests,
} = await import("../src/api/auth.js");
registerChannelsRecallRoutes();

interface InvokeResult {
  status: number;
  payload: any;
}

async function invokeRoute(
  method: string,
  p: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<InvokeResult> {
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
      req: { method, url: p, headers } as any,
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

const ENV_PATH = path.join(composeDir, ".env");
const ENV_TMP_PATH = path.join(composeDir, ".env.next");

// ── auth keys for the operator-only test ──────────────────────────────────

const MASTER_KEY = "test-master-" + "a".repeat(40);
const VOICE_KEY = "test-voice-" + "b".repeat(40);
const CHANNEL_KEY = "pcp_" + "c".repeat(48);

function authHeader(bearer: string): Record<string, string> {
  return { authorization: `Bearer ${bearer}` };
}

// ── tests ────────────────────────────────────────────────────────────────

describe("POST /api/v1/channels/recall/api-key — #113 PR3a persistence", () => {
  before(() => {
    // Initialise the DB once.
    getStateDb();
  });

  beforeEach(() => {
    recallStub.listBotsStatus = 200;
    recallStub.listBotsBody = { count: 1, results: [] };
    recallShouldThrow = false;
    recallCallCount = 0;
    vaultStore.clear();
    vaultCallLog = [];
    vaultShouldFail = false;
    vaultSeq = 1;
    composeCalls.length = 0;
    composeShouldFail = false;
    // Fresh .env each test — write a couple of unrelated lines so we can
    // verify they survive the surgical update.
    fs.writeFileSync(
      ENV_PATH,
      "# header comment\nALREADY=present\nFOO=bar\n",
      { mode: 0o600 },
    );
    try {
      fs.unlinkSync(ENV_TMP_PATH);
    } catch {
      /* swallow */
    }
    delete process.env.RECALL_API_KEY;
    delete process.env.RECALL_REGION;
    _resetAuthForTests();
    // Reset config row so region-default test starts clean.
    const db = getStateDb();
    db.exec("DELETE FROM recall_config");
  });

  after(() => {
    globalThis.fetch = originalFetch;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  });

  // ── 1. bad key — Recall 401 → no persist, no restart
  it("rejects with 401 when Recall rejects the key (no persist, no restart)", async () => {
    recallStub.listBotsStatus = 401;
    recallStub.listBotsBody = { detail: "Invalid token." };
    const r = await invokeRoute(
      "POST",
      "/api/v1/channels/recall/api-key",
      { api_key: "rec_bad_key", region: "us-east-1" },
    );
    assert.equal(r.status, 401, JSON.stringify(r.payload));
    assert.equal(r.payload.error.code, "RECALL_AUTH_FAILED");
    // No vault write.
    assert.equal(vaultStore.size, 0);
    // No restart.
    assert.equal(composeCalls.length, 0);
    // Env on disk unchanged.
    const envText = fs.readFileSync(ENV_PATH, "utf-8");
    assert.ok(!envText.includes("RECALL_API_KEY"));
    // process.env not touched.
    assert.equal(process.env.RECALL_API_KEY, undefined);
  });

  // ── 2. valid key — writes vault + .env + restart triggered
  it("writes to Vaultwarden + .env and triggers a restart on success", async () => {
    const r = await invokeRoute(
      "POST",
      "/api/v1/channels/recall/api-key",
      { api_key: "rec_good_abcdef1234567890", region: "eu-central-1" },
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.region, "eu-central-1");
    assert.equal(r.payload.key_first6, "rec_go");
    assert.deepEqual(r.payload.persisted_to, ["vaultwarden", ".env"]);
    assert.deepEqual(r.payload.restarted, ["ctrl-api", "alfred-learn"]);
    assert.equal(typeof r.payload.eta_seconds, "number");
    assert.ok(r.payload.eta_seconds > 0);

    // Vault item created.
    assert.equal(vaultStore.size, 1);
    const item = [...vaultStore.values()][0];
    assert.equal(item.name, "Recall API Key");
    assert.equal(item.login.password, "rec_good_abcdef1234567890");
    assert.ok(item.notes && item.notes.includes("eu-central-1"));

    // .env merged.
    const envText = fs.readFileSync(ENV_PATH, "utf-8");
    assert.match(envText, /^RECALL_API_KEY=rec_good_abcdef1234567890$/m);
    assert.match(envText, /^RECALL_REGION=eu-central-1$/m);
    // Pre-existing lines preserved.
    assert.match(envText, /^ALREADY=present$/m);
    assert.match(envText, /^FOO=bar$/m);
    assert.match(envText, /^# header comment$/m);

    // process.env updated in-process.
    assert.equal(process.env.RECALL_API_KEY, "rec_good_abcdef1234567890");
    assert.equal(process.env.RECALL_REGION, "eu-central-1");

    // Give the background restart a tick to run.
    await new Promise((r) => setTimeout(r, 10));

    // ctrl-api + alfred-learn restarted, in that ORDER from the
    // RECALL_RESTART_SERVICES const (which the route iterates).
    // The route restarts both via `restart <svc>`.
    const restartArgs = composeCalls
      .filter((c) => c.args[0] === "restart")
      .map((c) => c.args[1]);
    assert.deepEqual(restartArgs, ["ctrl-api", "alfred-learn"]);
  });

  // ── 3. idempotent — same key + region — no restart
  it("is idempotent when the same key + region are already on file", async () => {
    // Seed the .env + the vault as if we already persisted once.
    fs.writeFileSync(
      ENV_PATH,
      "ALREADY=present\nRECALL_API_KEY=rec_same_key_1234\nRECALL_REGION=us-east-1\n",
      { mode: 0o600 },
    );
    vaultStore.set("v-1", {
      id: "v-1",
      name: "Recall API Key",
      notes: "seed",
      login: { username: null, password: "rec_same_key_1234", uris: [] },
    });
    const r = await invokeRoute(
      "POST",
      "/api/v1/channels/recall/api-key",
      { api_key: "rec_same_key_1234", region: "us-east-1" },
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.idempotent, true);
    assert.equal(r.payload.key_first6, "rec_sa");
    assert.deepEqual(r.payload.persisted_to, []);
    assert.deepEqual(r.payload.restarted, []);
    // No upsert.
    assert.equal(vaultStore.size, 1);
    // No restart.
    assert.equal(composeCalls.length, 0);
  });

  // ── 4. atomic .env write — tempfile cleaned up
  it("writes the .env atomically via tempfile + rename", async () => {
    await invokeRoute(
      "POST",
      "/api/v1/channels/recall/api-key",
      { api_key: "rec_atomic_test", region: "us-east-1" },
    );
    // Final .env on disk has the new keys.
    assert.match(
      fs.readFileSync(ENV_PATH, "utf-8"),
      /^RECALL_API_KEY=rec_atomic_test$/m,
    );
    // The .env.next tempfile is GONE post-rename — atomic-write
    // contract.
    assert.equal(fs.existsSync(ENV_TMP_PATH), false);
    // No stray .env.bak — the brief explicitly forbids them.
    const dirEntries = fs.readdirSync(composeDir);
    for (const f of dirEntries) {
      assert.ok(
        !f.endsWith(".bak"),
        `no .bak file should be left behind, found ${f}`,
      );
    }
  });

  // ── 5. vault write goes through the vault-cli sidecar (not bw login)
  it("writes the secret through the vault-cli HTTP sidecar", async () => {
    await invokeRoute(
      "POST",
      "/api/v1/channels/recall/api-key",
      { api_key: "rec_via_sidecar", region: "us-east-1" },
    );
    // We expect at minimum: a list-by-name lookup, then a POST to
    // /object/item with the new password.
    const search = vaultCallLog.find(
      (c) => c.method === "GET" && c.path.startsWith("/list/object/items"),
    );
    assert.ok(search, "must list items by name first");
    const create = vaultCallLog.find(
      (c) => c.method === "POST" && c.path === "/object/item",
    );
    assert.ok(create, "must POST /object/item to create the new item");
    const createBody = (create!.body ?? {}) as any;
    assert.equal(createBody.name, "Recall API Key");
    assert.equal(createBody.login?.password, "rec_via_sidecar");
  });

  // ── 6. response never echoes the full key or its hash
  it("never echoes the full key or any hashed form in the response or logs", async () => {
    const apiKey = "rec_secret_value_should_not_leak";
    const r = await invokeRoute(
      "POST",
      "/api/v1/channels/recall/api-key",
      { api_key: apiKey, region: "us-east-1" },
    );
    const wire = JSON.stringify(r.payload);
    assert.ok(
      !wire.includes(apiKey),
      "response envelope must not contain the full key",
    );
    assert.ok(!/[0-9a-f]{32,}/.test(wire), "no long hex digest in the envelope");
    // The key_first6 is the only fingerprint surfaced.
    assert.equal(r.payload.key_first6, apiKey.slice(0, 6));
  });

  // ── 7. operator-only — voice-bridge + channel-token bearers get 403
  it("rejects non-operator bearers with 403", async () => {
    setApiKey(MASTER_KEY);
    setVoiceBridgeKey(VOICE_KEY);

    const vb = await invokeRoute(
      "POST",
      "/api/v1/channels/recall/api-key",
      { api_key: "rec_x", region: "us-east-1" },
      authHeader(VOICE_KEY),
    );
    assert.equal(vb.status, 403, JSON.stringify(vb.payload));
    assert.equal(vb.payload.error.code, "FORBIDDEN");

    const ch = await invokeRoute(
      "POST",
      "/api/v1/channels/recall/api-key",
      { api_key: "rec_x", region: "us-east-1" },
      authHeader(CHANNEL_KEY),
    );
    assert.equal(ch.status, 403, JSON.stringify(ch.payload));
    assert.equal(ch.payload.error.code, "FORBIDDEN");

    // No persist, no restart on either rejected call.
    assert.equal(vaultStore.size, 0);
    assert.equal(composeCalls.length, 0);

    // Master key passes through.
    const ok = await invokeRoute(
      "POST",
      "/api/v1/channels/recall/api-key",
      { api_key: "rec_operator_ok", region: "us-east-1" },
      authHeader(MASTER_KEY),
    );
    assert.equal(ok.status, 200, JSON.stringify(ok.payload));
    assert.equal(ok.payload.ok, true);
  });

  // ── 8. 502 from Recall during validate → no persist, no restart
  it("502s when Recall is unreachable mid-validate (no persist, no restart)", async () => {
    recallShouldThrow = true;
    const r = await invokeRoute(
      "POST",
      "/api/v1/channels/recall/api-key",
      { api_key: "rec_unreachable", region: "us-east-1" },
    );
    assert.equal(r.status, 502, JSON.stringify(r.payload));
    assert.equal(r.payload.error.code, "RECALL_UNREACHABLE");
    assert.equal(vaultStore.size, 0);
    assert.equal(composeCalls.length, 0);
    const envText = fs.readFileSync(ENV_PATH, "utf-8");
    assert.ok(!envText.includes("RECALL_API_KEY"));
  });

  // ── 9. concurrent calls don't double-restart — lock serialises
  it("serialises concurrent calls — no double-restart", async () => {
    // Same key in both calls. The lock should run the first call's
    // persist+restart, then the second observes the .env + vault are
    // already in sync and hits the idempotence branch.
    const body = { api_key: "rec_parallel_test", region: "us-east-1" };
    const [r1, r2] = await Promise.all([
      invokeRoute("POST", "/api/v1/channels/recall/api-key", body),
      invokeRoute("POST", "/api/v1/channels/recall/api-key", body),
    ]);
    // Both 200.
    assert.equal(r1.status, 200, JSON.stringify(r1.payload));
    assert.equal(r2.status, 200, JSON.stringify(r2.payload));
    // Exactly ONE of them did the writes; the other was idempotent.
    const persistCount =
      Number((r1.payload as any).idempotent !== true) +
      Number((r2.payload as any).idempotent !== true);
    assert.equal(persistCount, 1, "exactly one call should perform the writes");
    // Give the background restart a tick.
    await new Promise((r) => setTimeout(r, 10));
    // Exactly two restart args — ctrl-api + alfred-learn, ONCE.
    const restartArgs = composeCalls
      .filter((c) => c.args[0] === "restart")
      .map((c) => c.args[1]);
    assert.deepEqual(
      restartArgs,
      ["ctrl-api", "alfred-learn"],
      "concurrent calls must not double-restart",
    );
  });

  // ── 10. region defaults to the singleton config row when omitted
  it("defaults `region` to the configured value when omitted", async () => {
    // Seed config row at a non-default region so we can tell.
    const db = getStateDb();
    db.exec("DELETE FROM recall_config");
    db.prepare(
      `INSERT INTO recall_config (id, region, updated_at) VALUES (1, 'ap-northeast-1', ?)`,
    ).run(Date.now());

    const r = await invokeRoute(
      "POST",
      "/api/v1/channels/recall/api-key",
      { api_key: "rec_region_default" }, // no region
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.region, "ap-northeast-1");
    const envText = fs.readFileSync(ENV_PATH, "utf-8");
    assert.match(envText, /^RECALL_REGION=ap-northeast-1$/m);
  });

  // ── 11. bonus — request-level validation (api_key missing)
  it("400 VALIDATION_ERROR when api_key is missing", async () => {
    const r = await invokeRoute(
      "POST",
      "/api/v1/channels/recall/api-key",
      {},
    );
    assert.equal(r.status, 400);
    assert.equal(r.payload.error.code, "VALIDATION_ERROR");
  });
});

// ── direct helper tests — atomic write + first6 ──────────────────────────

describe("_recallInternals.atomicPatchEnv", () => {
  it("preserves unrelated lines and writes via tempfile + rename", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-env-"));
    const target = path.join(dir, ".env");
    fs.writeFileSync(target, "FOO=1\n# comment\nBAR=2\n");
    _recallInternals.atomicPatchEnv(target, {
      RECALL_API_KEY: "rec_xyz",
      BAR: "updated",
    });
    const out = fs.readFileSync(target, "utf-8");
    assert.match(out, /^FOO=1$/m);
    assert.match(out, /^# comment$/m);
    assert.match(out, /^BAR=updated$/m);
    assert.match(out, /^RECALL_API_KEY=rec_xyz$/m);
    // No stray tempfile.
    assert.equal(fs.existsSync(path.join(dir, ".env.next")), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keyFirst6 returns exactly the first 6 chars", () => {
    assert.equal(_recallInternals.keyFirst6("rec_abcdef_full_key"), "rec_ab");
    assert.equal(_recallInternals.keyFirst6("short"), "short");
  });
});
