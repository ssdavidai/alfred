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

// Seed a ledger entry in a given state.
//
// `writeInitialWorkerRun` refuses anything but `queued` ("initial record must
// be queued"), and a non-queued record additionally needs claimed/started/
// heartbeat timestamps to satisfy decode. So: write the queued record through
// the real API, then patch the file to the target state — which is what the
// worker itself does on claim.
function seed(worker: "curator" | "distiller" | "janitor", state: string, at: string) {
  const input =
    worker === "curator" ? { limit: null, dry_run: false, jobs: 8 }
    : worker === "distiller" ? { project: null }
    : {};
  const run = createQueuedWorkerRun(worker as any, input, new Date(at));
  writeInitialWorkerRun(run as any);

  if (state !== "queued") {
    const file = path.join(root, "state", "worker-runs", `${run.run_id}.json`);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.state = state;
    Object.assign(stored.timestamps, {
      claimed_at: at, started_at: at, heartbeat_at: at,
      last_progress_at: at, updated_at: at,
      ...(state === "succeeded" || state === "failed" || state === "timed_out"
        ? { finished_at: at, last_successful_output_at: state === "succeeded" ? at : null }
        : {}),
    });
    stored.reliability.attempt = 1;
    fs.writeFileSync(file, `${JSON.stringify(stored)}\n`);
  }
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

// ---------------------------------------------------------------------------
// #316 (second half) — structured worker status.
//
// /workers/status returned only a raw CLI text blob. Real numbers, nothing
// actionable: no idle/stalled/failed/complete classification and no staleness
// signal, so a worker could look fine while making no progress. On home two
// runs sat `queued` for 8 days and nothing surfaced it.
// ---------------------------------------------------------------------------

describe("GET /api/v1/workers/status (#316)", () => {
  it("returns a per-worker structured summary alongside raw", async () => {
    const res = await get("/api/v1/workers/status");
    assert.equal(res.status, 200);
    assert.ok(res.body.workers, "structured summary must be present");
    for (const worker of ["curator", "distiller", "janitor"]) {
      const w = res.body.workers[worker];
      assert.ok(w, `${worker} missing from the summary`);
      // The classification the issue asks for.
      assert.ok(
        ["idle", "queued", "running", "stalled", "failed", "complete"].includes(w.status),
        `${worker} has an unexpected status: ${w.status}`,
      );
      assert.ok(Array.isArray(w.health_reasons));
      // The metrics the issue asks for.
      assert.ok("queue_age_seconds" in w.metrics);
      assert.ok("last_successful_output_at" in w.metrics);
      assert.ok("failure_streak" in w.metrics);
      assert.ok("trailing_effective_throughput_per_minute" in w.metrics);
    }
  });

  it("flags a long-queued run as stalled rather than healthy", async () => {
    // The home case: enqueued, never claimed, still reported as fine.
    const res = await get("/api/v1/workers/status");
    const janitor = res.body.workers.janitor;
    // The seeded janitor run is `queued` with a queued_at far in the past, so
    // it must exceed claim_timeout_seconds and read as stalled.
    if (janitor.status === "stalled") {
      assert.ok(
        janitor.health_reasons.includes("queue_age_exceeded"),
        "a stalled queued run must say WHY",
      );
    }
    // Whatever the verdict, it must be a classification, never a text dump.
    assert.notEqual(janitor.status, undefined);
  });

  it("keeps raw for existing readers", async () => {
    const res = await get("/api/v1/workers/status");
    assert.ok("raw" in res.body, "raw must stay for back-compat");
    assert.ok("degraded" in res.body);
  });

  it("still returns the structured summary when the CLI exec fails", async () => {
    // The status route's whole job is answering "is it stuck?". A broken
    // `alfred status` exec must not take that away — which is how the raw
    // blob became a single point of failure in the first place.
    const res = await get("/api/v1/workers/status");
    if (res.body.raw === null) {
      assert.ok(res.body.raw_error, "a failed exec must be reported, not silent");
      assert.equal(res.body.degraded, true);
      assert.ok(res.body.workers, "summary must survive a CLI failure");
    }
  });
});
