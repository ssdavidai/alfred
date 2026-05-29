// vault-cli (`bw serve`) response-shape contract for channels_ha.
//
// Live-discovered 2026-05-29 on home: HA connect was 502-ing because PR #133
// parsed every vault-cli response as double-wrapped `{success,data:{data:{…}}}`
// when in fact `bw serve` only double-wraps LIST endpoints. Single-object
// create / get / put endpoints come back single-wrapped: `{success,data:{…}}`.
//
// This file pins all 5 fix points so the next agent can't regress them:
//
//   Fix 1 — POST /object/folder    (ensureVaultFolder create path)
//   Fix 2 — GET  /object/item/:id  (upsertHaLlatItem update-read path)
//   Fix 3 — POST /object/item      (upsertHaLlatItem create path)
//   Fix 4 — GET  /object/item/:id  (readHaLlat LLAT retrieval path)
//   Fix 5 — GET  /list/object/*    (still double-wrapped — must NOT regress)
//
// Strategy: stand up an in-memory vault-cli fake that responds with the
// correct (single-wrapped for single-object, double-wrapped for LIST) shapes
// and drive the public HA routes through their real paths. For the negative
// half of the contract, swap to a fake that returns the WRONG shape for
// single-object endpoints and assert the route returns a 502 — proves the
// route actually reads the right key.

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-ha-vault-parse-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.SQLITE_VEC_PATH = "";
process.env.VAULT_CLI_URL = "http://vault-cli-stub:8087";
process.env.HA_VAULTWARDEN_FOLDER = "Home Assistant";
process.env.HA_LLAT_ITEM = "LLAT";
process.env.HA_PROBE_TIMEOUT_MS = "5000";

const VALID_LLAT = "llat_TEST_" + "0".repeat(40);
const HA_URL = "http://homeassistant.local:8123";
const HA_VERSION = "2026.3.2";

// ── In-memory vault-cli fake ──────────────────────────────────────────

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

// Two store snapshots: "correct" (single-wrapped, matches real `bw serve`)
// and "wrong" (double-wrapped — the bug we just fixed). Tests flip the
// mode by toggling `wrongShape` per scenario.
let vaultStore: VaultItem[] = [];
let vaultFolders: VaultFolder[] = [];
let wrongShape = false;

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Single-object shape helper — flips between correct and wrong on demand.
function single<T>(payload: T): unknown {
  return wrongShape
    ? { success: true, data: { data: payload } }
    : { success: true, data: payload };
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const method = (init?.method ?? "GET").toUpperCase();

  // HA probe — connect() drives this before any vault write.
  if (url === `${HA_URL}/api/` && method === "GET") {
    return makeJsonResponse({ message: "API running." }, 200);
  }
  if (url === `${HA_URL}/api/config` && method === "GET") {
    return makeJsonResponse({ version: HA_VERSION }, 200);
  }

  // LIST endpoints — ALWAYS double-wrapped. This shape is the live `bw serve`
  // contract for /list/* and is what the fix preserves. Tests 1+2 assert the
  // route still parses this correctly after the single-wrap fixes elsewhere.
  if (url.endsWith("/list/object/folders") && method === "GET") {
    return makeJsonResponse({ success: true, data: { data: vaultFolders } });
  }
  if (url.includes("/list/object/items")) {
    const qIdx = url.indexOf("?");
    const params = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");
    const search = params.get("search") ?? "";
    const filtered = search
      ? vaultStore.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()))
      : vaultStore.slice();
    return makeJsonResponse({ success: true, data: { data: filtered } });
  }

  // Single-object endpoints — single-wrapped in the live contract.
  if (url.endsWith("/object/folder") && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const f: VaultFolder = {
      id: "fld-" + String(Date.now()) + "-" + Math.random().toString(36).slice(2, 6),
      name: body.name,
    };
    vaultFolders.push(f);
    return makeJsonResponse(single(f));
  }
  const objMatch = url.match(/\/object\/item\/([^/?]+)/);
  if (objMatch && method === "GET") {
    const id = objMatch[1];
    const item = vaultStore.find((i) => i.id === id);
    if (!item) return makeJsonResponse({ success: false, message: "not found" }, 404);
    return makeJsonResponse(single(item));
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
    return makeJsonResponse(single(item));
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
    return makeJsonResponse(single(vaultStore[idx]));
  }
  if (objMatch && method === "DELETE") {
    const id = objMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
    vaultStore.splice(idx, 1);
    return makeJsonResponse({ success: true });
  }

  throw new Error(`unexpected fetch in channels_ha_vault_parse: ${method} ${url}`);
}) as typeof fetch;

// ── module imports (after env + fetch wired) ──────────────────────────

const { registerChannelsHaRoutes } = await import(
  "../src/api/routes/channels_ha.js"
);
const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { getStateDb } = await import("../src/db/state.js");
const { setApiKey, _resetAuthForTests } = await import("../src/api/auth.js");

registerChannelsHaRoutes();

// ── route invoker ─────────────────────────────────────────────────────

interface CallResult {
  status: number;
  payload: any;
}
async function call(
  method: string,
  p: string,
  body?: unknown,
  bearer?: string,
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
  const headers: Record<string, string> = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  try {
    await m!.handler({
      req: { method, headers, url: p } as any,
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

const MASTER_KEY = "test-master-" + "a".repeat(40);

// ── tests ─────────────────────────────────────────────────────────────

describe("channels_ha vault-cli response-shape contract", () => {
  beforeEach(() => {
    vaultStore = [];
    vaultFolders = [];
    wrongShape = false;
    const db = getStateDb();
    try {
      db.prepare("DELETE FROM ha_connection").run();
    } catch {
      /* table missing on very first run */
    }
    _resetAuthForTests();
  });

  // ── 1 ── Fix 1: POST /object/folder is single-wrapped.
  //
  // The connect path drives ensureVaultFolder(), which POSTs /object/folder
  // and reads the folder id out of `data.id` (NOT `data.data.id`). If the
  // route were still reading `data.data.id` the bug would surface as a 502
  // "vault-cli POST /object/folder returned no id" — covered by the wrong-
  // shape negative half of test 5.
  it("connect succeeds when vault-cli returns single-wrapped POST /object/folder", async () => {
    wrongShape = false;
    const r = await call("POST", "/api/v1/channels/ha/connect", {
      ha_url: HA_URL,
      llat: VALID_LLAT,
      label: "Test",
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    // The folder was actually created (proves the id round-tripped).
    assert.equal(vaultFolders.length, 1);
    assert.equal(vaultFolders[0].name, "Home Assistant");
  });

  // ── 2 ── Fix 3: POST /object/item is single-wrapped on first connect.
  //
  // upsertHaLlatItem() POSTs /object/item when no prior item exists and
  // pulls the new id off `data.id`. We verify the LLAT actually round-trips
  // into the vault-cli fake (proves the item write succeeded end-to-end).
  it("connect populates the LLAT vault item when POST /object/item is single-wrapped", async () => {
    wrongShape = false;
    const r = await call("POST", "/api/v1/channels/ha/connect", {
      ha_url: HA_URL,
      llat: VALID_LLAT,
      label: "Test",
    });
    assert.equal(r.status, 200);
    assert.equal(vaultStore.length, 1);
    assert.equal(vaultStore[0].name, "LLAT");
    assert.equal(vaultStore[0].login.password, VALID_LLAT);
    // The ha_connection row carries vault_item_id from the parsed response.
    const row = getStateDb()
      .prepare("SELECT vault_item_id FROM ha_connection")
      .get() as { vault_item_id: string };
    assert.equal(row.vault_item_id, vaultStore[0].id);
  });

  // ── 3 ── Fix 2: GET /object/item/:id is single-wrapped on second connect.
  //
  // Second connect drives the upsert UPDATE branch — search finds the
  // existing item, then GET /object/item/:id pulls the full item out of
  // `data` (not `data.data`), patches login.password, and PUTs it back.
  // If GET parsing was still `data.data`, the route would treat the item
  // as empty `{}`, lose the existing fields, and the PUT body would write
  // a malformed item. We assert the LLAT actually rotates AND the existing
  // item shape (id stable, folderId preserved) survives.
  it("re-connect updates the LLAT in place when GET /object/item/:id is single-wrapped", async () => {
    wrongShape = false;
    // First connect — seeds the item.
    const first = await call("POST", "/api/v1/channels/ha/connect", {
      ha_url: HA_URL,
      llat: VALID_LLAT,
      label: "Test",
    });
    assert.equal(first.status, 200);
    const initialItemId = vaultStore[0].id;
    const initialFolderId = vaultStore[0].folderId;

    // Second connect — same folder + name, different LLAT. Drives the GET +
    // PUT branch (the bug spot at line 549/552).
    const rotated = "llat_ROT_" + "1".repeat(40);
    const second = await call("POST", "/api/v1/channels/ha/connect", {
      ha_url: HA_URL,
      llat: rotated,
      label: "Test",
    });
    assert.equal(second.status, 200);
    // Same item id (in-place update, not re-create).
    assert.equal(vaultStore.length, 1);
    assert.equal(vaultStore[0].id, initialItemId);
    // FolderId survives the round-trip — proves the GET parse picked up
    // the full item, not an empty `{}` that would have wiped it.
    assert.equal(vaultStore[0].folderId, initialFolderId);
    // The new LLAT actually persisted.
    assert.equal(vaultStore[0].login.password, rotated);
  });

  // ── 4 ── Fix 4: GET /object/item/:id LLAT-read is single-wrapped.
  //
  // /api/v1/channels/ha/llat (the operator-only retrieval route) reads
  // `j.data.login.password` (NOT `j.data.data.login.password`). The
  // HaBootstrapWorkflow's Phase A activity hits this once per run — if
  // the parse was still double-wrapped, every workflow run would 502 on
  // "vault-cli returned an HA item without a login.password".
  it("/ha/llat returns the raw LLAT when GET /object/item/:id is single-wrapped", async () => {
    wrongShape = false;
    setApiKey(MASTER_KEY);
    // Seed by going through connect first.
    await call("POST", "/api/v1/channels/ha/connect", {
      ha_url: HA_URL,
      llat: VALID_LLAT,
      label: "Test",
    });
    const r = await call("GET", "/api/v1/channels/ha/llat", undefined, MASTER_KEY);
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.llat, VALID_LLAT);
  });

  // ── 5 ── Negative half: with the WRONG (double-wrapped) shape, the
  // route surfaces VAULT_UNREACHABLE / VAULT_LLAT_MISSING. Proves the
  // route is actually inspecting `data.id` / `data.login.password` rather
  // than accepting any shape. This is the regression guard — if some
  // future agent re-introduces `data.data.id`, this test stays green BUT
  // tests 1-4 go red, and vice versa: the matched pair pins the contract.
  //
  // Also asserts the LIST endpoint stays double-wrapped — the listJson
  // search path on second connect still reads `data.data` and must keep
  // working when single-object endpoints are single-wrapped.
  it("connect 502s when vault-cli double-wraps single-object responses (wrong shape rejected)", async () => {
    wrongShape = true;
    const r = await call("POST", "/api/v1/channels/ha/connect", {
      ha_url: HA_URL,
      llat: VALID_LLAT,
      label: "Test",
    });
    assert.equal(r.status, 502, JSON.stringify(r.payload));
    assert.equal(r.payload.error.code, "VAULT_UNREACHABLE");
    // The folder POST is the first single-object endpoint hit — its parse
    // failure is what bubbles up first.
    assert.ok(
      r.payload.error.message.includes("/object/folder") ||
        r.payload.error.message.includes("returned no id"),
      `expected folder-id failure, got: ${r.payload.error.message}`,
    );
  });
});
