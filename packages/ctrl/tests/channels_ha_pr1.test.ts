// Lane I — /api/v1/channels/ha/* (#110 PR1).
//
// What's under test
// -----------------
// PR1 of issue #110 ships the Home Assistant channel skeleton:
//   * 7 ha_* tables (migration 0003_ha_channel.sql)
//   * 5 live routes (connect, status, disconnect, registry, snapshots)
//   * 11 stub routes (501 with "lands in PR2/5/6") — verified at server
//     wire-up time (see channels_ha.ts), not exhaustively here.
//   * voice-bridge `self` allowlist additions per spec §7 Q13.
//   * the load-bearing decision_ref + idx_ha_run_entity_recent loop-guard
//     contract (full watcher-side filtering is PR3 — this PR only proves
//     the schema + index exist and accept the row shape PR3 will read).
//
// Coverage (10 tests):
//   1. Connect happy path — HA /api/ probe returns 200, /api/config returns
//      version → 200 { ok, ha_version, state:'connected' }; ha_connection
//      row persisted; LLAT lands in Vaultwarden, NOT in state.db.
//   2. Connect with bad LLAT — HA returns 401 → 401 AUTH_FAILED, no
//      Vaultwarden write, no ha_connection row.
//   3. Connect with bad URL shape (file:// / no host) → 400 VALIDATION_ERROR.
//   4. Status when unconfigured → 200 { connected:false, state:'unconfigured' }.
//   5. Status after connect → 200 { connected:true, state:'connected',
//      ha_url, ha_version }.
//   6. Disconnect clears Vaultwarden item + ha_connection.
//   7. Registry empty (PR5 populates) → { entities:[], ...} shape.
//   8. Voice-bridge allowlist — accepts the 4 read routes spec §7 Q13 lists.
//   9. Voice-bridge allowlist — REJECTS HA writes (POST /connect,
//      POST /service, DELETE /disconnect).
//  10. Loop-guard contract — insert a row in ha_run with decision_ref +
//      a 10s-old created_at, prove the partial index finds it via the
//      watcher's lookup shape.
//
// Privacy: this is a public OSS repo. Tests use synthetic placeholders only
// — the LLAT is "llat_TEST_…" and never resembles a real long-lived token.

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-ha-pr1-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.SQLITE_VEC_PATH = "";
process.env.VAULT_CLI_URL = "http://vault-cli-stub:8087";
process.env.HA_VAULTWARDEN_FOLDER = "Home Assistant";
process.env.HA_LLAT_ITEM = "LLAT";
process.env.HA_PROBE_TIMEOUT_MS = "5000";

// Synthetic placeholders — never resemble a real HA LLAT.
const VALID_LLAT = "llat_TEST_" + "0".repeat(40);
const HA_URL = "http://homeassistant.local:8123";
const HA_VERSION = "2025.6.1";

// ── HA probe + vault-cli mock ─────────────────────────────────────────

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

// HA probe controls: independent for /api/ (auth) and /api/config (version).
let haApiStatus = 200;
let haApiVersionOk = true;
const haCalls: { url: string; auth: string }[] = [];

const originalFetch = globalThis.fetch;
function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const authHeader =
    init?.headers?.Authorization ??
    init?.headers?.authorization ??
    "";
  haCalls.push({ url, auth: String(authHeader) });

  // HA /api/ — auth gate.
  if (url === `${HA_URL}/api/` && method === "GET") {
    if (haApiStatus !== 200) {
      return makeJsonResponse(
        { error: "Unauthorized" },
        haApiStatus,
      );
    }
    return makeJsonResponse({ message: "API running." }, 200);
  }
  // HA /api/config — version pull (best-effort).
  if (url === `${HA_URL}/api/config` && method === "GET") {
    if (!haApiVersionOk) {
      return makeJsonResponse({ error: "boom" }, 500);
    }
    return makeJsonResponse({ version: HA_VERSION }, 200);
  }

  // vault-cli folders — list + create.
  if (url.endsWith("/list/object/folders") && method === "GET") {
    return makeJsonResponse({ success: true, data: { data: vaultFolders } });
  }
  if (url.endsWith("/object/folder") && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const f: VaultFolder = {
      id: "fld-" + String(Date.now()) + "-" + Math.random().toString(36).slice(2, 6),
      name: body.name,
    };
    vaultFolders.push(f);
    // Single-object endpoint — vault-cli (`bw serve`) returns single-wrapped.
    return makeJsonResponse({ success: true, data: f });
  }

  // vault-cli items — list + get + create + put + delete.
  if (url.includes("/list/object/items")) {
    const qIdx = url.indexOf("?");
    const params = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");
    const search = params.get("search") ?? "";
    const filtered = search
      ? vaultStore.filter((i) =>
          i.name.toLowerCase().includes(search.toLowerCase()),
        )
      : vaultStore.slice();
    return makeJsonResponse({ success: true, data: { data: filtered } });
  }
  const objMatch = url.match(/\/object\/item\/([^/?]+)/);
  if (objMatch && method === "GET") {
    const id = objMatch[1];
    const item = vaultStore.find((i) => i.id === id);
    if (!item) return makeJsonResponse({ success: false, message: "not found" }, 404);
    // Single-object endpoint — vault-cli (`bw serve`) returns single-wrapped.
    return makeJsonResponse({ success: true, data: item });
  }
  if (url.endsWith("/object/item") && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const id =
      "id-" + String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
    const item: VaultItem = {
      id,
      name: body.name,
      type: 1,
      folderId: body.folderId ?? null,
      login: {
        username: body.login?.username ?? null,
        password: body.login?.password ?? "",
        uris: body.login?.uris ?? [],
      },
    };
    vaultStore.push(item);
    // Single-object endpoint — vault-cli (`bw serve`) returns single-wrapped.
    return makeJsonResponse({ success: true, data: item });
  }
  if (objMatch && method === "PUT") {
    const id = objMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
    const body = JSON.parse(String(init?.body ?? "{}"));
    vaultStore[idx] = {
      ...vaultStore[idx],
      name: body.name ?? vaultStore[idx].name,
      folderId: body.folderId ?? vaultStore[idx].folderId,
      login: { ...vaultStore[idx].login, ...(body.login ?? {}) },
    };
    // Single-object endpoint — vault-cli (`bw serve`) returns single-wrapped.
    return makeJsonResponse({ success: true, data: vaultStore[idx] });
  }
  if (objMatch && method === "DELETE") {
    const id = objMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
    vaultStore.splice(idx, 1);
    return makeJsonResponse({ success: true });
  }

  throw new Error(`unexpected fetch in test_channels_ha_pr1: ${method} ${url}`);
}) as typeof fetch;

// ── module imports (after env + fetch are set) ─────────────────────────

const { registerChannelsHaRoutes } = await import(
  "../src/api/routes/channels_ha.js"
);
const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { getStateDb } = await import("../src/db/state.js");
const {
  setApiKey,
  setVoiceBridgeKey,
  authenticate,
  _resetAuthForTests,
} = await import("../src/api/auth.js");
const { AuthError } = await import("../src/api/errors.js");

registerChannelsHaRoutes();

// ── route invoker (mirrors the channels_paperclip pattern) ─────────────

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

function fakeReq(token: string | undefined): any {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
}

const MASTER_KEY = "test-master-" + "x".repeat(40);
const VOICE_KEY = "test-voice-" + "y".repeat(40);

// ── tests ──────────────────────────────────────────────────────────────

describe("/api/v1/channels/ha/* — #110 PR1", () => {
  beforeEach(() => {
    vaultStore = [];
    vaultFolders = [];
    haCalls.length = 0;
    haApiStatus = 200;
    haApiVersionOk = true;
    // Wipe ha_connection between tests so we always start from
    // unconfigured.
    try {
      getStateDb().prepare("DELETE FROM ha_connection").run();
    } catch {
      /* table may not exist on the very first run before migrations
         ran — getStateDb() itself runs migrations though, so it should */
    }
  });

  // ── 1 ──
  it("connect happy path → 200, ha_connection row, Vaultwarden item", async () => {
    const r = await call("POST", "/api/v1/channels/ha/connect", {
      ha_url: HA_URL,
      llat: VALID_LLAT,
      label: "Main house",
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.state, "connected");
    assert.equal(r.payload.ha_version, HA_VERSION);

    // ha_connection row landed.
    const row = getStateDb()
      .prepare("SELECT * FROM ha_connection WHERE id = 1")
      .get() as any;
    assert.ok(row, "ha_connection row must exist");
    assert.equal(row.ha_url, HA_URL);
    assert.equal(row.label, "Main house");
    assert.equal(row.state, "connected");
    assert.equal(row.ha_version, HA_VERSION);
    assert.equal(Number(row.last_test_ok), 1);
    assert.ok(
      typeof row.vault_item_id === "string" && row.vault_item_id.length > 0,
      "vault_item_id must be set",
    );

    // The LLAT itself is NEVER in state.db — only the Vaultwarden item id.
    const serialised = JSON.stringify(row);
    assert.ok(
      !serialised.includes(VALID_LLAT),
      "ha_connection MUST NOT carry the LLAT",
    );

    // Vaultwarden got exactly one LLAT item, in the HA folder.
    assert.equal(vaultStore.length, 1);
    assert.equal(vaultStore[0].name, "LLAT");
    assert.equal(vaultStore[0].login.password, VALID_LLAT);
    assert.ok(vaultStore[0].folderId, "folderId must be set");
    const folder = vaultFolders.find((f) => f.id === vaultStore[0].folderId);
    assert.ok(folder, "folder must exist");
    assert.equal(folder!.name, "Home Assistant");
  });

  // ── 2 ──
  it("connect with bad LLAT → 401, no vault write, no state.db row", async () => {
    haApiStatus = 401;
    const r = await call("POST", "/api/v1/channels/ha/connect", {
      ha_url: HA_URL,
      llat: "wrong-llat",
    });
    assert.equal(r.status, 401, JSON.stringify(r.payload));
    assert.equal(r.payload.error.code, "AUTH_FAILED");

    // No Vaultwarden write — the upsert must come AFTER the probe.
    assert.equal(vaultStore.length, 0);

    // No ha_connection row.
    const row = getStateDb()
      .prepare("SELECT * FROM ha_connection WHERE id = 1")
      .get();
    assert.equal(row, undefined);
  });

  // ── 3 ──
  it("connect rejects malformed ha_url with 400 VALIDATION_ERROR", async () => {
    for (const bad of [
      { ha_url: "file:///etc/passwd", llat: VALID_LLAT, label: "x" },
      { ha_url: "not-a-url", llat: VALID_LLAT },
      { ha_url: "", llat: VALID_LLAT },
      { ha_url: HA_URL, llat: "" },
    ]) {
      const r = await call("POST", "/api/v1/channels/ha/connect", bad);
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}; got ${JSON.stringify(r.payload)}`);
      assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    }
    // No upstream calls fired (all four short-circuit before probeHa).
    assert.equal(haCalls.length, 0);
  });

  // ── 4 ──
  it("status when unconfigured → 200 { connected:false, state:'unconfigured' }", async () => {
    const r = await call("GET", "/api/v1/channels/ha/status");
    assert.equal(r.status, 200);
    assert.equal(r.payload.connected, false);
    assert.equal(r.payload.state, "unconfigured");
    assert.equal(r.payload.ha_url, null);
    assert.equal(r.payload.ha_version, null);
    assert.equal(r.payload.error, null);
  });

  // ── 5 ──
  it("status after connect → 200 { connected:true, state:'connected', ha_url, ha_version }", async () => {
    await call("POST", "/api/v1/channels/ha/connect", {
      ha_url: HA_URL,
      llat: VALID_LLAT,
    });
    const r = await call("GET", "/api/v1/channels/ha/status");
    assert.equal(r.status, 200);
    assert.equal(r.payload.connected, true);
    assert.equal(r.payload.state, "connected");
    assert.equal(r.payload.ha_url, HA_URL);
    assert.equal(r.payload.ha_version, HA_VERSION);
    assert.equal(r.payload.last_test_ok, true);
    // Defence in depth: /status NEVER leaks the LLAT.
    const ser = JSON.stringify(r.payload);
    assert.ok(!ser.includes(VALID_LLAT), "/status payload must not carry the LLAT");
  });

  // ── 6 ──
  it("disconnect clears Vaultwarden item + ha_connection", async () => {
    // Set up — connect first.
    await call("POST", "/api/v1/channels/ha/connect", {
      ha_url: HA_URL,
      llat: VALID_LLAT,
    });
    assert.equal(vaultStore.length, 1);

    // Disconnect.
    const r = await call("DELETE", "/api/v1/channels/ha/disconnect");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);

    // ha_connection wiped, Vaultwarden item removed.
    const row = getStateDb()
      .prepare("SELECT * FROM ha_connection WHERE id = 1")
      .get();
    assert.equal(row, undefined);
    assert.equal(vaultStore.length, 0);

    // /status flips back to unconfigured.
    const s = await call("GET", "/api/v1/channels/ha/status");
    assert.equal(s.payload.state, "unconfigured");
  });

  // ── 7 ──
  it("registry empty (PR5 populates) → spec-shaped empty buckets", async () => {
    const r = await call("GET", "/api/v1/channels/ha/registry");
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      entities: [],
      areas: [],
      devices: [],
      automations: [],
      scenes: [],
      helpers: [],
    });
  });

  // ── 8 ──
  it("voice-bridge allowlist accepts the 4 spec §7 Q13 read routes", () => {
    _resetAuthForTests();
    setApiKey(MASTER_KEY);
    setVoiceBridgeKey(VOICE_KEY);

    // Exact-match: /status, /registry.
    for (const pathname of [
      "/api/v1/channels/ha/status",
      "/api/v1/channels/ha/registry",
    ]) {
      assert.doesNotThrow(
        () => authenticate(fakeReq(VOICE_KEY), { method: "GET", pathname }),
        `voice-bridge token must accept GET ${pathname}`,
      );
    }
    // Pattern: /state/:entity_id, /automations.
    for (const pathname of [
      "/api/v1/channels/ha/state/light.kitchen",
      "/api/v1/channels/ha/state/binary_sensor.front_door",
      "/api/v1/channels/ha/automations",
    ]) {
      assert.doesNotThrow(
        () => authenticate(fakeReq(VOICE_KEY), { method: "GET", pathname }),
        `voice-bridge token must accept GET ${pathname}`,
      );
    }
  });

  // ── 9 ──
  it("voice-bridge allowlist REJECTS HA writes", () => {
    _resetAuthForTests();
    setApiKey(MASTER_KEY);
    setVoiceBridgeKey(VOICE_KEY);
    for (const route of [
      { method: "POST", pathname: "/api/v1/channels/ha/connect" },
      { method: "POST", pathname: "/api/v1/channels/ha/service" },
      { method: "DELETE", pathname: "/api/v1/channels/ha/disconnect" },
      { method: "POST", pathname: "/api/v1/channels/ha/automation" },
      { method: "PATCH", pathname: "/api/v1/channels/ha/automation/abc" },
      { method: "DELETE", pathname: "/api/v1/channels/ha/automation/abc" },
      { method: "POST", pathname: "/api/v1/channels/ha/proposal/approve" },
      { method: "POST", pathname: "/api/v1/channels/ha/proposal/reject" },
      { method: "POST", pathname: "/api/v1/channels/ha/discovery" },
      // Snapshots — not on the voice surface (Q13 lists only the 4 reads above).
      { method: "GET", pathname: "/api/v1/channels/ha/snapshots" },
      // Prefix anti-regression: /api/v1/channels/ha-something must NOT inherit.
      { method: "GET", pathname: "/api/v1/channels/ha-bridge/status" },
    ]) {
      assert.throws(
        () => authenticate(fakeReq(VOICE_KEY), route),
        AuthError,
        `voice-bridge MUST reject ${route.method} ${route.pathname}`,
      );
    }
  });

  // ── 10 — loop-guard contract ──
  it("loop-guard contract: ha_run row with decision_ref + recent created_at hits the partial index", () => {
    // Simulate what PR2's ha__call_service activity does: mint a
    // decision_ref, insert a ha_run row keyed by entity_id, then PR3's
    // HaWatcherWorkflow performs the lookup that the partial index
    // idx_ha_run_entity_recent backs.
    const db = getStateDb();
    const now = Date.now();
    const tenSecondsAgo = now - 10_000;
    const fortySecondsAgo = now - 40_000;

    db.prepare(
      `INSERT INTO ha_run (
         id, ts, actor, kind, domain, service, entity_id,
         payload_json, outcome, decision_ref, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-recent-with-ref",
      new Date(tenSecondsAgo).toISOString(),
      "alfred-ceo",
      "service_call",
      "light",
      "turn_off",
      "light.kitchen",
      JSON.stringify({}),
      "ok",
      "abc-decision-ref",
      tenSecondsAgo,
    );
    // A second row OUTSIDE the 30s window — must NOT match.
    db.prepare(
      `INSERT INTO ha_run (
         id, ts, actor, kind, domain, service, entity_id,
         payload_json, outcome, decision_ref, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-stale-with-ref",
      new Date(fortySecondsAgo).toISOString(),
      "alfred-ceo",
      "service_call",
      "light",
      "turn_off",
      "light.kitchen",
      JSON.stringify({}),
      "ok",
      "older-decision-ref",
      fortySecondsAgo,
    );
    // A third row WITHIN window but WITHOUT a decision_ref — non-Alfred
    // write, must NOT match (the partial index excludes it).
    db.prepare(
      `INSERT INTO ha_run (
         id, ts, actor, kind, domain, service, entity_id,
         payload_json, outcome, decision_ref, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-recent-without-ref",
      new Date(tenSecondsAgo).toISOString(),
      "voice",
      "service_call",
      "light",
      "turn_off",
      "light.kitchen",
      JSON.stringify({}),
      "ok",
      null, // decision_ref intentionally absent — outside the partial index
      tenSecondsAgo,
    );

    // The watcher's loop-guard probe — exactly the shape PR3 will run.
    const cutoff = now - 30_000;
    const matches = db
      .prepare(
        `SELECT id FROM ha_run
          WHERE entity_id = ?
            AND decision_ref IS NOT NULL
            AND created_at > ?
          ORDER BY created_at DESC`,
      )
      .all("light.kitchen", cutoff) as { id: string }[];
    assert.equal(matches.length, 1, "exactly one row must match the 30s loop-guard window");
    assert.equal(matches[0].id, "run-recent-with-ref");

    // Confirm the partial index exists and is wired to the column tuple
    // PR3 will probe — defence in depth against a future migration
    // accidentally dropping it.
    const indexes = db
      .prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'ha_run'`,
      )
      .all() as { name: string; sql: string | null }[];
    const partial = indexes.find(
      (i) => i.name === "idx_ha_run_entity_recent",
    );
    assert.ok(partial, "idx_ha_run_entity_recent must exist on ha_run");
    assert.ok(
      partial!.sql && partial!.sql.includes("decision_ref IS NOT NULL"),
      "partial index MUST be gated on decision_ref IS NOT NULL",
    );
    assert.ok(
      partial!.sql && partial!.sql.includes("entity_id"),
      "partial index MUST include entity_id (loop-guard probe key)",
    );
    assert.ok(
      partial!.sql && partial!.sql.includes("created_at"),
      "partial index MUST include created_at (loop-guard time window)",
    );
  });
});
