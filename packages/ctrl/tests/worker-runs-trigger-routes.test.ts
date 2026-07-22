import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-trigger-routes-"));
process.env.ALFRED_DATA_DIR = root;
const realEnqueue = await import("../src/api/workerRuns/enqueue.js");
let enqueueFailure: Error | null = null;
mock.module("../src/api/workerRuns/enqueue.js", {
  namedExports: {
    enqueueWorkerRun: (...args: Parameters<typeof realEnqueue.enqueueWorkerRun>) => {
      if (enqueueFailure) throw enqueueFailure;
      return realEnqueue.enqueueWorkerRun(...args);
    },
  },
});
const realHelpers = await import("../src/api/helpers.js");
const executionCalls: unknown[][] = [];
mock.module("../src/api/helpers.js", {
  namedExports: {
    ...realHelpers,
    dockerExec: async (...args: unknown[]) => {
      executionCalls.push(args);
      throw new Error("manual trigger must not execute a worker");
    },
  },
});
const { handleError } = await import("../src/api/errors.js");
const { registerWorkerRoutes } = await import("../src/api/routes/workers.js");
const { matchRoute } = await import("../src/api/server.js");
registerWorkerRoutes();
type Response = { status: number; body: any; headers: Record<string, string> };
async function call(route: string, body?: unknown): Promise<Response> {
  const match = matchRoute("POST", route);
  assert.ok(match, `${route} must be registered`);
  let status = 0, payload: unknown;
  const headers: Record<string, string> = {};
  const res: any = {
    setHeader(name: string, value: string | number) {
      headers[name.toLowerCase()] = String(value);
    },
    writeHead(code: number, values?: Record<string, string | number>) {
      status = code;
      for (const [name, value] of Object.entries(values ?? {})) {
        headers[name.toLowerCase()] = String(value);
      }
    },
    end(value?: string) { payload = value ? JSON.parse(value) : undefined; },
  };
  try { await match.handler({ req: {} as any, res, params: {}, body, query: new URLSearchParams() }); }
  catch (error) { handleError(res, error); }
  return { status, body: payload, headers };
}
beforeEach(() => {
  enqueueFailure = null; executionCalls.length = 0;
  fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));
describe("durable manual worker trigger routes", () => {
  it("returns canonical defaults, a precise 202 shape, and identical Location", async () => {
    const cases = [
      ["/api/v1/workers/process", "curator", { limit: null, dry_run: false, jobs: 4 }],
      ["/api/v1/workers/distiller/run", "distiller", { project: null }],
      ["/api/v1/workers/janitor/fix", "janitor", {}],
    ] as const;
    for (const [route, worker, input] of cases) {
      const response = await call(route);
      assert.equal(response.status, 202); assert.equal(response.body.worker, worker);
      assert.deepEqual(Object.keys(response.body).sort(), ["input", "reused", "run_id", "state", "status_url", "worker"]);
      assert.equal(response.body.state, "queued"); assert.equal(response.body.reused, false); assert.deepEqual(response.body.input, input);
      assert.equal(response.body.status_url, `/api/v1/workers/runs/${response.body.run_id}`);
      assert.equal(response.headers.location, response.body.status_url);
    }
    assert.deepEqual(executionCalls, []);
  });
  it("canonicalizes valid input and rejects invalid bodies and unknown fields", async () => {
    const curator = await call("/api/v1/workers/process", { limit: 10_000, dry_run: true, jobs: 32 }); const distiller = await call("/api/v1/workers/distiller/run", { project: "  Project Ω  " });
    assert.deepEqual(curator.body.input, { limit: 10_000, dry_run: true, jobs: 32 });
    assert.deepEqual(distiller.body.input, { project: "Project Ω" });
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    for (const [route, body] of [
      ["/api/v1/workers/process", { jobs: 0 }],
      ["/api/v1/workers/process", { extra: true }],
      ["/api/v1/workers/distiller/run", { project: "line\nbreak" }],
      ["/api/v1/workers/distiller/run", []],
      ["/api/v1/workers/janitor/fix", { scan: true }],
      ["/api/v1/workers/janitor/fix", null],
    ] as const) {
      const response = await call(route, body);
      assert.equal(response.status, 400, `${route}: ${JSON.stringify(body)}`); assert.equal(response.body.error.code, "VALIDATION_ERROR");
    }
    assert.deepEqual(executionCalls, []);
  });
  it("surfaces durable enqueue failure without a false acceptance", async () => {
    enqueueFailure = new Error("disk fsync failed"); const response = await call("/api/v1/workers/process", {});
    assert.equal(response.status, 500); assert.equal(response.body.error.code, "INTERNAL_ERROR"); assert.equal(response.headers.location, undefined);
    assert.deepEqual(executionCalls, []);
  });
  it("atomically reuses concurrent same-worker triggers while workers remain independent", async () => {
    const curatorResponses = await Promise.all(Array.from({ length: 20 }, (_, jobs) =>
      call("/api/v1/workers/process", { jobs: (jobs % 16) + 1 }),
    ));
    assert.equal(curatorResponses.filter((response) => response.body.reused === false).length, 1); assert.equal(new Set(curatorResponses.map((response) => response.body.run_id)).size, 1);
    assert.ok(curatorResponses.every((response) => response.status === 202 && response.body.state === "queued"));
    const [distiller, janitor] = await Promise.all([
      call("/api/v1/workers/distiller/run", { project: "independent" }),
      call("/api/v1/workers/janitor/fix", {}),
    ]);
    assert.equal(distiller.body.reused, false); assert.equal(janitor.body.reused, false);
    assert.equal(new Set([curatorResponses[0].body.run_id, distiller.body.run_id, janitor.body.run_id]).size, 3);
    assert.deepEqual(executionCalls, []);
  });
});
