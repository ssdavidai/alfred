import { before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

mock.module("node:child_process", {
  namedExports: {
    execFile: mock.fn((...args: any[]) => {
      const callback = args.at(-1) as Function;
      const stdout = args[0] === "/opt/alfred/healthcheck.sh" ? '{"containers":[]}' : "";
      callback(null, stdout, "");
    }),
    execFileSync: mock.fn(() => ""),
    spawn: mock.fn(),
  },
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "admin-activity-durable-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { getStateDb } = await import("../src/db/state.js");
const { appendAudit } = await import("../src/api/routes/state.js");
const { registerAdminRoutes } = await import("../src/api/routes/admin.js");
const { matchRoute } = await import("../src/api/server.js");

registerAdminRoutes();

async function getActivity(limit = 200): Promise<{ status: number; data: any }> {
  const match = matchRoute("GET", "/api/v1/admin/activity");
  assert.ok(match, "activity route must be registered");
  let status = 0;
  let data: any;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(json?: string) { data = json ? JSON.parse(json) : undefined; },
  } as unknown as ServerResponse;
  await match.handler({
    req: { url: `/api/v1/admin/activity?limit=${limit}` } as any,
    res, params: {}, body: undefined,
    query: new URLSearchParams(`limit=${limit}`),
  });
  return { status, data };
}

describe("GET /api/v1/admin/activity — durable audit ledger", () => {
  const workflowTs = "2026-07-17T09:00:00.000Z";
  const workflowPayload = {
    workflow_id: "wf-317", run_id: "run-abc", correlation_id: "corr-xyz",
  };

  before(() => {
    getStateDb();
    appendAudit({
      ts: "2026-07-17T08:00:00.000Z", action_type: "decision",
      actor: "principal", source: "desk", subject_ref: "decision:d-1",
      summary: "Approved durable activity",
    });
    appendAudit({
      ts: workflowTs, action_type: "workflow_run", actor: "alfred",
      source: "temporal", subject_ref: "workflow:wf-317",
      summary: "Workflow run completed", payload: workflowPayload,
    });
  });

  it("returns newest-first audit rows and preserves workflow correlation data", async () => {
    const { status, data } = await getActivity();
    assert.equal(status, 200);
    assert.equal(data.partial, false);
    assert.deepEqual(data.items.map((row: any) => row.action_type), ["workflow_run", "decision"]);
    assert.equal(data.newest_event_ts, workflowTs);
    assert.ok(!Number.isNaN(Date.parse(data.generated_at)));
    assert.deepEqual(data.sources, [{ name: "audit", ok: true, count: 2 }]);
    const workflow = data.items[0];
    for (const key of ["id", "ts", "action_type", "actor", "source", "summary", "subject_ref"])
      assert.ok(key in workflow, `missing ${key}`);
    assert.equal(workflow.subject_ref, "workflow:wf-317");
    assert.deepEqual(JSON.parse(workflow.payload_json), workflowPayload);
    assert.equal((await getActivity(1)).data.items.length, 1, "limit must be honored");
  });

  it("returns a complete empty freshness envelope for an empty audit table", async () => {
    getStateDb().exec("DELETE FROM audit");
    const { status, data } = await getActivity();
    assert.equal(status, 200);
    assert.deepEqual(data.items, []);
    assert.equal(data.newest_event_ts, null);
    assert.equal(data.partial, false);
    assert.deepEqual(data.sources, [{ name: "audit", ok: true, count: 0 }]);
  });

  it("returns 200 with partial:true when the audit store read throws", async () => {
    getStateDb().close();
    const { status, data } = await getActivity();
    assert.equal(status, 200);
    assert.deepEqual(data.items, []);
    assert.equal(data.partial, true);
    assert.deepEqual(data.sources, [{ name: "audit", ok: false, count: 0 }]);

    const dashboard = matchRoute("GET", "/api/v1/admin/dashboard");
    assert.ok(dashboard, "dashboard route must be registered");
    let dashboardStatus = 0;
    let dashboardData: any;
    const res = {
      writeHead(code: number) { dashboardStatus = code; return res; },
      end(json?: string) { dashboardData = json ? JSON.parse(json) : undefined; },
    } as unknown as ServerResponse;
    await dashboard.handler({
      req: { url: "/api/v1/admin/dashboard" } as any,
      res, params: {}, body: undefined, query: new URLSearchParams(),
    });
    assert.equal(dashboardStatus, 200);
    assert.equal(dashboardData.health.status, "degraded");
  });
});
