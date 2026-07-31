// #316 — `POST /api/v1/workers/janitor/fix` answers 202 with
// `status_url: /api/v1/workers/runs/<id>`, but nothing ever served that path:
//
//   GET /api/v1/workers/runs/01KY6ENE704FFBV3ZPPQP8YBNG
//   {"error":{"code":"NOT_FOUND","message":"No route: ..."}}
//
// So an operator got a durable run id and no way to ask what happened to it —
// the opposite of "durable jobs with run IDs, progress and inspectable failure
// reasons". The ledger read helpers already existed; they were never exposed.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-read-routes-"));
process.env.ALFRED_DATA_DIR = root;

const { writeInitialWorkerRun } = await import("../src/api/workerRuns/ledger.js");
const { createQueuedWorkerRun } = await import("../src/api/workerRuns/request.js");
const { handleError } = await import("../src/api/errors.js");
const { registerWorkerRoutes } = await import("../src/api/routes/workers.js");
const { matchRoute } = await import("../src/api/server.js");

registerWorkerRoutes();

type Response = { status: number; body: any };

async function get(route: string): Promise<Response> {
  const [pathname, search = ""] = route.split("?");
  const match = matchRoute("GET", pathname);
  assert.ok(match, `${pathname} must be registered`);
  let status = 0;
  let payload: unknown;
  const res: any = {
    setHeader() {},
    writeHead(code: number) { status = code; return res; },
    end(chunk?: string) { if (chunk) payload = JSON.parse(chunk); return res; },
  };
  const ctx = {
    req: {} as any,
    res,
    params: match.params,
    query: new URLSearchParams(search),
    body: undefined,
  };
  try {
    await match.handler(ctx as any);
  } catch (error) {
    handleError(res, error);
  }
  return { status, body: payload };
}

function seed(worker: "curator" | "distiller" | "janitor", state: string, at: string) {
  const run = createQueuedWorkerRun(
    worker,
    worker === "curator" ? { jobs: 8 } : worker === "distiller" ? { project: null } : {},
    new Date(at),
  );
  (run as any).state = state;
  writeInitialWorkerRun(run as any);
  return run;
}

before(() => {
  seed("janitor", "queued", "2026-07-31T01:00:00.000Z");
  seed("distiller", "running", "2026-07-31T02:00:00.000Z");
  seed("curator", "succeeded", "2026-07-31T03:00:00.000Z");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

describe("GET /api/v1/workers/runs/:id (#316)", () => {
  it("serves the status_url the 202 advertises", async () => {
    const list = await get("/api/v1/workers/runs");
    const id = list.body.runs[0].run_id;

    const res = await get(`/api/v1/workers/runs/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.run_id, id);
    // The fields the contract asks to be inspectable.
    assert.ok(res.body.state);
    assert.ok(res.body.timestamps);
    assert.ok("terminal_error" in res.body);
    assert.ok(res.body.reliability);
  });

  it("404s a well-formed but unknown run id", async () => {
    const res = await get("/api/v1/workers/runs/01KY6ENE704FFBV3ZPPQP8YBNZ");
    assert.equal(res.status, 404);
  });

  it("rejects a malformed run id as 400, not 500", async () => {
    // Inspectability is the point — a bad id must not look like a server bug.
    const res = await get("/api/v1/workers/runs/not-a-ulid");
    assert.equal(res.status, 400);
  });
});

describe("GET /api/v1/workers/runs (#316)", () => {
  it("lists newest-first with state counts", async () => {
    const res = await get("/api/v1/workers/runs");
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 3);
    // ULIDs sort lexicographically by time; newest seeded run is first.
    const ids = res.body.runs.map((r: any) => r.run_id);
    assert.deepEqual([...ids].sort().reverse(), ids, "must be newest-first");
    assert.deepEqual(res.body.states, { queued: 1, running: 1, succeeded: 1 });
  });

  it("filters by worker", async () => {
    const res = await get("/api/v1/workers/runs?worker=distiller");
    assert.equal(res.body.count, 1);
    assert.equal(res.body.runs[0].worker, "distiller");
  });

  it("filters by state", async () => {
    const res = await get("/api/v1/workers/runs?state=queued");
    assert.equal(res.body.count, 1);
    assert.equal(res.body.runs[0].state, "queued");
  });

  it("honours limit while still reporting the true total", async () => {
    const res = await get("/api/v1/workers/runs?limit=1");
    assert.equal(res.body.count, 1);
    assert.equal(res.body.total, 3, "total must not be truncated by limit");
  });

  it("does not capture the collection path as a run id", async () => {
    // If /runs/:id were registered first, "runs" would 400 as a bad ULID.
    const res = await get("/api/v1/workers/runs");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.runs));
  });
});
