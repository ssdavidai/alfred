import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enqueueWorkerRun } from "../src/api/workerRuns/enqueue.js";
import { listWorkerRuns, writeInitialWorkerRun } from "../src/api/workerRuns/ledger.js";
import type { WorkerRunRecord } from "../src/api/workerRuns/model.js";
import { createQueuedWorkerRun } from "../src/api/workerRuns/request.js";

const roots: string[] = [];
function ledger(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-run-enqueue-"));
  roots.push(root);
  return path.join(root, "state", "worker-runs");
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function runningRun(at: string): WorkerRunRecord<"curator"> {
  const run = createQueuedWorkerRun("curator", { jobs: 8 }, new Date(at));
  run.state = "running";
  Object.assign(run.timestamps, {
    claimed_at: at,
    started_at: at,
    heartbeat_at: at,
    last_progress_at: at,
    updated_at: at,
  });
  run.progress.total = 0;
  Object.assign(run.reliability, {
    attempt: 1,
    claim_id: "claim",
    worker_instance_id: "boot",
    pid: 42,
    effective_jobs: 1,
    write_sequence: 1,
  });
  return run;
}

function seedFinal(run: WorkerRunRecord, directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${run.run_id}.json`), `${JSON.stringify(run)}\n`);
}

describe("serialized worker-run enqueue", () => {
  it("durably creates exactly one queued record for concurrent same-worker requests", async () => {
    const directory = ledger();
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      enqueueWorkerRun("curator", { jobs: (index % 8) + 1 }, new Date(1_752_840_000_000 + index), directory),
    ));

    assert.equal(results.filter(({ reused }) => !reused).length, 1);
    assert.equal(new Set(results.map(({ run }) => run.run_id)).size, 1);
    assert.deepEqual(results[0].run.input, { limit: null, dry_run: false, jobs: 1 });
    assert.ok(results.slice(1).every(({ reused, run }) => reused && run.input.jobs === 1));
    assert.deepEqual(listWorkerRuns(directory), [results[0].run]);
  });

  it("reuses queued, running, and read-derived stalled runs with their original input", async () => {
    for (const state of ["queued", "running", "stalled"] as const) {
      const directory = ledger();
      const original = state === "queued"
        ? createQueuedWorkerRun("curator", { jobs: 8 }, new Date("2026-07-21T12:00:00Z"))
        : runningRun(state === "running" ? "2026-07-21T12:59:30.000Z" : "2026-07-21T12:00:00.000Z");
      if (state === "queued") writeInitialWorkerRun(original, directory);
      else seedFinal(original, directory); // Old running timestamps derive as stalled at read time.

      const result = await enqueueWorkerRun(
        "curator",
        { limit: 5, dry_run: true, jobs: 1 },
        new Date("2026-07-21T13:00:00Z"),
        directory,
      );
      assert.equal(result.reused, true, state);
      assert.equal(result.run.run_id, original.run_id, state);
      assert.deepEqual(result.run.input, { limit: null, dry_run: false, jobs: 8 }, state);
      assert.equal(listWorkerRuns(directory).length, 1, state);
    }
  });

  it("validates reused requests and releases the worker lock after rejection", async () => {
    const directory = ledger();
    const first = await enqueueWorkerRun("distiller", { project: "original" }, new Date(), directory);
    await assert.rejects(enqueueWorkerRun("distiller", { project: "line\nbreak" }, new Date(), directory));
    const reused = await enqueueWorkerRun("distiller", { project: "later" }, new Date(), directory);

    assert.equal(reused.reused, true);
    assert.equal(reused.run.run_id, first.run.run_id);
    assert.deepEqual(reused.run.input, { project: "original" });
    assert.equal(listWorkerRuns(directory).length, 1);
  });

  it("does not share active runs across workers", async () => {
    const directory = ledger();
    const [curator, distiller, janitor] = await Promise.all([
      enqueueWorkerRun("curator", {}, new Date(), directory),
      enqueueWorkerRun("distiller", {}, new Date(), directory),
      enqueueWorkerRun("janitor", {}, new Date(), directory),
    ]);

    assert.ok([curator, distiller, janitor].every(({ reused }) => !reused));
    assert.equal(listWorkerRuns(directory).length, 3);
  });
});
