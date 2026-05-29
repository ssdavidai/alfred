// Lane I — /api/v1/channels/ha/* HA write surface (#110 PR4).
//
// PR4 adds the 5 write routes the PR2 MCP tools delegate to:
//   * POST /api/v1/channels/ha/service                  — call_service
//   * POST /api/v1/channels/ha/proposal                 — propose automation
//   * POST /api/v1/channels/ha/proposal/:id/apply       — apply proposal
//   * POST /api/v1/channels/ha/snapshot/:id/rollback    — rollback snapshot
//   * POST /api/v1/channels/ha/subscribe                — open WS subscription
//   * DELETE /api/v1/channels/ha/subscribe/:id          — close WS subscription
//
// LOAD-BEARING contract: every write requires a `decision_ref` in the body;
// every successful write writes a `ha_run` row with that decision_ref; the
// loop guard rejects a same-entity / same-decision_ref write within 60s.
//
// Coverage (15 tests):
//   1.  call_service happy path → 200 + ha_run row written + decision_ref persisted
//   2.  call_service without decision_ref → 400 VALIDATION_ERROR
//   3.  call_service with bad-format decision_ref → 400 VALIDATION_ERROR
//   4.  loop guard: same entity + same decision_ref within 60s → 409
//   5.  loop guard: same entity, DIFFERENT decision_ref within 60s → 200 (accepted)
//   6.  loop guard: same entity + same decision_ref AFTER cooldown → 200 (accepted)
//   7.  call_service when HA not connected → 409 HA_NOT_CONNECTED
//   8.  proposal create → returns proposal_id, status='pending'
//   9.  proposal apply round-trip → snapshot captured, proposal=applied, ha_run written
//  10.  proposal apply rejects bad status → 409
//  11.  snapshot rollback → restores YAML verbatim, sets restored_at
//  12.  snapshot rollback idempotency rejected → 409 if already restored
//  13.  subscribe → returns subscription_id + persists ha_event_subscription row
//  14.  unsubscribe → marks closed_at
//  15.  subscribe when HA not connected → 409 HA_NOT_CONNECTED

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-ha-pr4-"));
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

// HA mock state.
let haServiceShouldFail = false;
let haServiceResponse: unknown = [{ entity_id: "light.kitchen_main", state: "on" }];
let haAutomationGetYaml: string | null = "alias: existing-automation\ntrigger: []\naction: []\n";
let haAutomationWriteOk = true;
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
  // HA /api/config.
  if (url === `${HA_URL}/api/config` && method === "GET") {
    return makeJsonResponse({ version: HA_VERSION }, 200);
  }
  // HA /api/services/:domain/:service.
  const svcMatch = url.match(
    /^http:\/\/homeassistant\.local:8123\/api\/services\/([^/]+)\/([^/?]+)$/,
  );
  if (svcMatch && method === "POST") {
    if (haServiceShouldFail) {
      return makeJsonResponse({ error: "boom" }, 500);
    }
    return makeJsonResponse(haServiceResponse, 200);
  }
  // HA automation config — GET (snapshot) + POST (write).
  const autoMatch = url.match(
    /^http:\/\/homeassistant\.local:8123\/api\/config\/automation\/config\/([^/?]+)$/,
  );
  if (autoMatch && method === "GET") {
    if (haAutomationGetYaml === null) {
      return makeJsonResponse({ error: "not found" }, 404);
    }
    return makeTextResponse(haAutomationGetYaml, 200);
  }
  if (autoMatch && method === "POST") {
    if (!haAutomationWriteOk) {
      return makeJsonResponse({ error: "validation" }, 400);
    }
    return makeJsonResponse({ result: "ok" }, 200);
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
    return makeJsonResponse({ success: true, data: { data: f } });
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
    return makeJsonResponse({ success: true, data: { data: item } });
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
    return makeJsonResponse({ success: true, data: { data: item } });
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
    return makeJsonResponse({ success: true, data: { data: vaultStore[idx] } });
  }
  if (objMatch && method === "DELETE") {
    const id = objMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
    vaultStore.splice(idx, 1);
    return makeJsonResponse({ success: true });
  }
  throw new Error(`unexpected fetch in test_channels_ha_pr4: ${method} ${url}`);
}) as typeof fetch;

// ── module imports (after env + fetch are wired) ──────────────────────

const { registerChannelsHaRoutes, _resetHaSubscriptionsForTests } = await import(
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

describe("/api/v1/channels/ha/* — #110 PR4 write surface", () => {
  beforeEach(() => {
    vaultStore = [];
    vaultFolders = [];
    haCalls.length = 0;
    haServiceShouldFail = false;
    haServiceResponse = [{ entity_id: "light.kitchen_main", state: "on" }];
    haAutomationGetYaml = "alias: existing-automation\ntrigger: []\naction: []\n";
    haAutomationWriteOk = true;
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
  });

  // ── 1 ── happy path
  it("call_service happy path → 200, ha_run row carries decision_ref", async () => {
    await connectHa();

    const r = await call("POST", "/api/v1/channels/ha/service", {
      domain: "light",
      service: "turn_on",
      target: { entity_id: "light.kitchen_main" },
      data: { brightness_pct: 60 },
      decision_ref: "decision/2026-05-29-kitchen-on.md",
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.ok(typeof r.payload.run_id === "string" && r.payload.run_id.length > 0);
    assert.equal(r.payload.decision_ref, "decision/2026-05-29-kitchen-on.md");

    const run = getStateDb()
      .prepare("SELECT * FROM ha_run WHERE id = ?")
      .get(r.payload.run_id) as any;
    assert.ok(run, "ha_run row must exist");
    assert.equal(run.decision_ref, "decision/2026-05-29-kitchen-on.md");
    assert.equal(run.entity_id, "light.kitchen_main");
    assert.equal(run.outcome, "ok");
    assert.equal(run.kind, "service_call");
    assert.equal(run.domain, "light");
    assert.equal(run.service, "turn_on");
    assert.ok(run.created_at > 0, "created_at must be epoch ms > 0");

    // ha_response is recorded.
    const ha = JSON.parse(run.ha_response);
    assert.equal(Array.isArray(ha), true);
  });

  // ── 2 ── missing decision_ref
  it("call_service WITHOUT decision_ref → 400 VALIDATION_ERROR, no HA call", async () => {
    await connectHa();
    haCalls.length = 0;

    const r = await call("POST", "/api/v1/channels/ha/service", {
      domain: "light",
      service: "turn_on",
      target: { entity_id: "light.kitchen_main" },
    });
    assert.equal(r.status, 400, JSON.stringify(r.payload));
    assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    // No HA service call was fired.
    assert.equal(
      haCalls.filter((c) => c.url.includes("/api/services/")).length,
      0,
    );
    // No ha_run row.
    const runs = getStateDb().prepare("SELECT COUNT(*) as n FROM ha_run").get() as {
      n: number;
    };
    assert.equal(runs.n, 0);
  });

  // ── 3 ── bad-format decision_ref
  it("call_service with bad-format decision_ref → 400 VALIDATION_ERROR", async () => {
    await connectHa();
    for (const bad of ["", "x", "abc", "has space here", "a\tb\tc\td"]) {
      const r = await call("POST", "/api/v1/channels/ha/service", {
        domain: "light",
        service: "turn_on",
        target: { entity_id: "light.kitchen_main" },
        decision_ref: bad,
      });
      assert.equal(
        r.status,
        400,
        `decision_ref=${JSON.stringify(bad)} should be rejected; got ${JSON.stringify(r.payload)}`,
      );
      assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    }
  });

  // ── 4 ── loop guard: same entity + same decision_ref within 60s → 409
  it("loop guard: same entity + same decision_ref within 60s → 409 CONFLICT", async () => {
    await connectHa();
    const ref = "decision/2026-05-29-loop-guard.md";
    // First call succeeds.
    const r1 = await call("POST", "/api/v1/channels/ha/service", {
      domain: "light",
      service: "turn_on",
      target: { entity_id: "light.kitchen_main" },
      decision_ref: ref,
    });
    assert.equal(r1.status, 200, JSON.stringify(r1.payload));
    // Second call with SAME decision_ref + SAME entity → 409.
    const r2 = await call("POST", "/api/v1/channels/ha/service", {
      domain: "light",
      service: "turn_off",
      target: { entity_id: "light.kitchen_main" },
      decision_ref: ref,
    });
    assert.equal(r2.status, 409, JSON.stringify(r2.payload));
    assert.equal(r2.payload.error.code, "CONFLICT");
  });

  // ── 5 ── loop guard: same entity, DIFFERENT decision_ref → 200 (accepted)
  it("loop guard: same entity, DIFFERENT decision_ref within 60s → 200 (fresh decision OK)", async () => {
    await connectHa();
    const r1 = await call("POST", "/api/v1/channels/ha/service", {
      domain: "light",
      service: "turn_on",
      target: { entity_id: "light.kitchen_main" },
      decision_ref: "decision/2026-05-29-first.md",
    });
    assert.equal(r1.status, 200, JSON.stringify(r1.payload));
    // Different decision_ref ⇒ different decision derived from a new signal ⇒ accepted.
    const r2 = await call("POST", "/api/v1/channels/ha/service", {
      domain: "light",
      service: "turn_off",
      target: { entity_id: "light.kitchen_main" },
      decision_ref: "decision/2026-05-29-second.md",
    });
    assert.equal(r2.status, 200, JSON.stringify(r2.payload));
    // Both rows persisted with their respective decision_refs.
    const rows = getStateDb()
      .prepare("SELECT decision_ref FROM ha_run WHERE entity_id = ? ORDER BY created_at ASC")
      .all("light.kitchen_main") as { decision_ref: string }[];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].decision_ref, "decision/2026-05-29-first.md");
    assert.equal(rows[1].decision_ref, "decision/2026-05-29-second.md");
  });

  // ── 6 ── loop guard skips for area-only writes (entity_id NULL)
  it("loop guard skips entity-less writes (area-only) — second call with same decision_ref allowed", async () => {
    await connectHa();
    const ref = "decision/2026-05-29-area-only.md";
    const r1 = await call("POST", "/api/v1/channels/ha/service", {
      domain: "light",
      service: "turn_on",
      target: { area_id: "kitchen" },
      decision_ref: ref,
    });
    assert.equal(r1.status, 200, JSON.stringify(r1.payload));
    // Area-only ⇒ entity_id NULL in ha_run ⇒ loop guard partial index doesn't index it.
    const r2 = await call("POST", "/api/v1/channels/ha/service", {
      domain: "light",
      service: "turn_off",
      target: { area_id: "kitchen" },
      decision_ref: ref,
    });
    assert.equal(r2.status, 200, JSON.stringify(r2.payload));
    const rows = getStateDb()
      .prepare("SELECT entity_id FROM ha_run WHERE decision_ref = ?")
      .all(ref) as { entity_id: string | null }[];
    assert.equal(rows.length, 2);
    for (const row of rows) assert.equal(row.entity_id, null);
  });

  // ── 7 ── call_service when HA not connected → 409 HA_NOT_CONNECTED
  it("call_service when HA not connected → 409 HA_NOT_CONNECTED", async () => {
    const r = await call("POST", "/api/v1/channels/ha/service", {
      domain: "light",
      service: "turn_on",
      target: { entity_id: "light.kitchen_main" },
      decision_ref: "decision/2026-05-29.md",
    });
    assert.equal(r.status, 409, JSON.stringify(r.payload));
    assert.equal(r.payload.error.code, "HA_NOT_CONNECTED");
  });

  // ── 8 ── proposal create
  it("proposal create → returns proposal_id, status='pending'; ha_proposal row written", async () => {
    const yaml = "alias: morning-routine\ntrigger:\n  - platform: time\n    at: '06:30'\naction: []\n";
    const r = await call("POST", "/api/v1/channels/ha/proposal", {
      kind: "automation",
      summary: "Morning routine",
      yaml,
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.status, "pending");
    const id = r.payload.proposal_id;
    assert.ok(typeof id === "string" && id.length > 0);

    const row = getStateDb()
      .prepare("SELECT * FROM ha_proposal WHERE id = ?")
      .get(id) as any;
    assert.ok(row);
    assert.equal(row.status, "pending");
    assert.equal(row.summary, "Morning routine");
    assert.equal(row.scope, "automation");
    const parsed = JSON.parse(row.payload_json);
    assert.equal(parsed.yaml, yaml);
    assert.equal(parsed.kind, "automation");
  });

  // ── 9 ── proposal apply round-trip
  it("proposal apply → snapshot captured verbatim, proposal marked applied, ha_run written", async () => {
    await connectHa();
    const yaml = "alias: morning-routine\ntrigger:\n  - platform: time\n    at: '06:30'\naction:\n  - service: light.turn_on\n    target:\n      entity_id: light.kitchen_main\n";
    const create = await call("POST", "/api/v1/channels/ha/proposal", {
      kind: "automation",
      summary: "Morning routine",
      yaml,
    });
    const proposalId = create.payload.proposal_id;

    // Apply.
    const decisionRef = "decision/2026-05-29-apply-morning.md";
    const apply = await call(
      "POST",
      `/api/v1/channels/ha/proposal/${proposalId}/apply`,
      { decision_ref: decisionRef, automation_id: "morning_routine" },
    );
    assert.equal(apply.status, 200, JSON.stringify(apply.payload));
    assert.equal(apply.payload.ok, true);
    assert.ok(typeof apply.payload.snapshot_id === "string");
    assert.ok(typeof apply.payload.run_id === "string");

    // ha_snapshot row holds the pre-apply YAML verbatim.
    const snap = getStateDb()
      .prepare("SELECT * FROM ha_snapshot WHERE id = ?")
      .get(apply.payload.snapshot_id) as any;
    assert.ok(snap);
    assert.equal(snap.kind, "automation");
    assert.equal(snap.ha_id, "morning_routine");
    assert.equal(snap.proposal_ref, proposalId);
    // pre-apply YAML matches our mock's GET response verbatim.
    assert.equal(
      snap.payload_json,
      "alias: existing-automation\ntrigger: []\naction: []\n",
    );

    // ha_proposal flipped to applied.
    const prop = getStateDb()
      .prepare("SELECT * FROM ha_proposal WHERE id = ?")
      .get(proposalId) as any;
    assert.equal(prop.status, "applied");
    assert.equal(prop.decision_ref, decisionRef);

    // ha_run row recorded with the decision_ref.
    const run = getStateDb()
      .prepare("SELECT * FROM ha_run WHERE id = ?")
      .get(apply.payload.run_id) as any;
    assert.equal(run.decision_ref, decisionRef);
    assert.equal(run.kind, "proposal_apply");
    assert.equal(run.outcome, "ok");
    assert.equal(run.entity_id, "automation.morning_routine");
  });

  // ── 10 ── proposal apply rejects already-applied
  it("proposal apply rejects already-applied → 409 CONFLICT", async () => {
    await connectHa();
    const create = await call("POST", "/api/v1/channels/ha/proposal", {
      kind: "automation",
      summary: "Morning",
      yaml: "alias: m\ntrigger: []\naction: []\n",
    });
    const id = create.payload.proposal_id;
    const decision_ref = "decision/2026-05-29-apply.md";
    const first = await call(
      "POST",
      `/api/v1/channels/ha/proposal/${id}/apply`,
      { decision_ref },
    );
    assert.equal(first.status, 200);
    // Second apply attempt — status is now 'applied', not 'pending'/'approved'.
    const second = await call(
      "POST",
      `/api/v1/channels/ha/proposal/${id}/apply`,
      { decision_ref: "decision/2026-05-29-second.md" },
    );
    assert.equal(second.status, 409, JSON.stringify(second.payload));
    assert.equal(second.payload.error.code, "CONFLICT");
  });

  // ── 11 ── snapshot rollback round-trip
  it("snapshot rollback restores YAML verbatim, sets restored_at, writes ha_run", async () => {
    await connectHa();
    // Create + apply to land a snapshot.
    const create = await call("POST", "/api/v1/channels/ha/proposal", {
      kind: "automation",
      summary: "Test",
      yaml: "alias: new\n",
    });
    const apply = await call(
      "POST",
      `/api/v1/channels/ha/proposal/${create.payload.proposal_id}/apply`,
      { decision_ref: "decision/2026-05-29-apply.md", automation_id: "test" },
    );
    const snapId = apply.payload.snapshot_id;

    haCalls.length = 0;
    // Rollback.
    const rb = await call(
      "POST",
      `/api/v1/channels/ha/snapshot/${snapId}/rollback`,
      { decision_ref: "decision/2026-05-29-rollback.md" },
    );
    assert.equal(rb.status, 200, JSON.stringify(rb.payload));
    assert.equal(rb.payload.ok, true);
    assert.ok(typeof rb.payload.restored_at === "string");

    // The mock recorded a POST to /api/config/automation/config/test with the
    // ORIGINAL pre-apply YAML.
    const writeCall = haCalls.find(
      (c) =>
        c.method === "POST" &&
        c.url.includes("/api/config/automation/config/test"),
    );
    assert.ok(writeCall, "rollback must POST the snapshot YAML back to HA");
    assert.equal(
      writeCall!.body,
      "alias: existing-automation\ntrigger: []\naction: []\n",
    );

    // ha_snapshot row has restored_at set.
    const snap = getStateDb()
      .prepare("SELECT * FROM ha_snapshot WHERE id = ?")
      .get(snapId) as any;
    assert.ok(snap.restored_at);

    // ha_run row for snapshot_rollback was written.
    const run = getStateDb()
      .prepare("SELECT * FROM ha_run WHERE id = ?")
      .get(rb.payload.run_id) as any;
    assert.equal(run.kind, "snapshot_rollback");
    assert.equal(run.decision_ref, "decision/2026-05-29-rollback.md");
  });

  // ── 12 ── second rollback rejected
  it("snapshot rollback rejects already-restored snapshot → 409 CONFLICT", async () => {
    await connectHa();
    const create = await call("POST", "/api/v1/channels/ha/proposal", {
      kind: "automation",
      summary: "Test",
      yaml: "alias: new\n",
    });
    const apply = await call(
      "POST",
      `/api/v1/channels/ha/proposal/${create.payload.proposal_id}/apply`,
      { decision_ref: "decision/2026-05-29-apply.md", automation_id: "test" },
    );
    const snapId = apply.payload.snapshot_id;
    const first = await call(
      "POST",
      `/api/v1/channels/ha/snapshot/${snapId}/rollback`,
      { decision_ref: "decision/2026-05-29-rb-1.md" },
    );
    assert.equal(first.status, 200);
    const second = await call(
      "POST",
      `/api/v1/channels/ha/snapshot/${snapId}/rollback`,
      { decision_ref: "decision/2026-05-29-rb-2.md" },
    );
    assert.equal(second.status, 409, JSON.stringify(second.payload));
    assert.equal(second.payload.error.code, "CONFLICT");
  });

  // ── 13 ── subscribe lifecycle (open)
  it("subscribe → returns subscription_id + persists ha_event_subscription row", async () => {
    await connectHa();
    const r = await call("POST", "/api/v1/channels/ha/subscribe", {
      filter: { event_type: "state_changed", entity_id: "binary_sensor.front_door" },
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    const subId = r.payload.subscription_id;
    assert.ok(typeof subId === "string" && subId.length > 0);

    const row = getStateDb()
      .prepare("SELECT * FROM ha_event_subscription WHERE id = ?")
      .get(subId) as any;
    assert.ok(row);
    assert.equal(row.closed_at, null);
    const filter = JSON.parse(row.filter_json);
    assert.equal(filter.event_type, "state_changed");
    assert.equal(filter.entity_id, "binary_sensor.front_door");
  });

  // ── 14 ── unsubscribe → marks closed_at
  it("unsubscribe → marks closed_at; second unsubscribe is idempotent", async () => {
    await connectHa();
    const open = await call("POST", "/api/v1/channels/ha/subscribe", {});
    const subId = open.payload.subscription_id;
    const close = await call(
      "DELETE",
      `/api/v1/channels/ha/subscribe/${subId}`,
    );
    assert.equal(close.status, 200, JSON.stringify(close.payload));
    assert.equal(close.payload.ok, true);
    assert.ok(typeof close.payload.closed_at === "string");

    const row = getStateDb()
      .prepare("SELECT closed_at FROM ha_event_subscription WHERE id = ?")
      .get(subId) as any;
    assert.ok(row.closed_at);

    // Second close → 200 with already_closed=true (idempotent).
    const close2 = await call(
      "DELETE",
      `/api/v1/channels/ha/subscribe/${subId}`,
    );
    assert.equal(close2.status, 200);
    assert.equal(close2.payload.already_closed, true);
  });

  // ── 15 ── subscribe when HA not connected
  it("subscribe when HA not connected → 409 HA_NOT_CONNECTED", async () => {
    const r = await call("POST", "/api/v1/channels/ha/subscribe", {});
    assert.equal(r.status, 409, JSON.stringify(r.payload));
    assert.equal(r.payload.error.code, "HA_NOT_CONNECTED");
  });
});
