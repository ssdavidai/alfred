import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "../src/api/errors.js";
import { decodeWorkerRun, DEFAULT_WORKER_RUN_TIMEOUT_POLICY, WORKER_RUN_ROUTES } from "../src/api/workerRuns/model.js";
import { createQueuedWorkerRun, parseWorkerRunInput } from "../src/api/workerRuns/request.js";

const at = new Date("2026-07-21T12:00:00.000Z");
const invalid = (worker: "curator" | "distiller" | "janitor", body: unknown) =>
  assert.throws(() => parseWorkerRunInput(worker, body), ValidationError);

describe("worker-run requests", () => {
  it("applies exact defaults and canonicalizes accepted values", () => {
    assert.deepEqual(parseWorkerRunInput("curator", undefined), { limit: null, dry_run: false, jobs: 4 });
    assert.deepEqual(parseWorkerRunInput("distiller", {}), { project: null });
    assert.deepEqual(parseWorkerRunInput("janitor", undefined), {});
    assert.deepEqual(parseWorkerRunInput("curator", { limit: 1, dry_run: true, jobs: 32 }), { limit: 1, dry_run: true, jobs: 32 });
    assert.deepEqual(parseWorkerRunInput("curator", { limit: 10_000, jobs: 1 }), { limit: 10_000, dry_run: false, jobs: 1 });
    assert.deepEqual(parseWorkerRunInput("distiller", { project: "  Project Ω  " }), { project: "Project Ω" });
  });

  it("rejects non-objects, unknown keys, wrong types, and out-of-range curator values", () => {
    for (const worker of ["curator", "distiller", "janitor"] as const) {
      for (const body of [null, [], "body", 1, false]) invalid(worker, body);
      invalid(worker, { provenance: "caller" });
    }
    for (const limit of [0, 10_001, 1.5, "1", undefined]) invalid("curator", { limit });
    for (const jobs of [0, 33, 1.5, "4", null]) invalid("curator", { jobs });
    for (const dry_run of [0, "false", null]) invalid("curator", { dry_run });
  });

  it("trims projects and rejects empty, overlong, typed, or controlled values", () => {
    assert.deepEqual(parseWorkerRunInput("distiller", { project: " x " }), { project: "x" });
    for (const project of ["", "   ", "x".repeat(201), 4, false, "line\nbreak", "nul\0byte", "del\u007fchar", "c1\u0085char"]) {
      invalid("distiller", { project });
    }
    assert.deepEqual(parseWorkerRunInput("distiller", { project: "x".repeat(200) }), { project: "x".repeat(200) });
  });

  it("creates valid initial records with fixed provenance and complete zero/null state", () => {
    for (const worker of ["curator", "distiller", "janitor"] as const) {
      const run = createQueuedWorkerRun(worker, undefined, at);
      assert.deepEqual(decodeWorkerRun(run), run);
      assert.match(run.run_id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      assert.deepEqual(run.trigger, { kind: "manual_api", route: WORKER_RUN_ROUTES[worker], requested_at: at.toISOString() });
      assert.deepEqual(run.timeout_policy, DEFAULT_WORKER_RUN_TIMEOUT_POLICY);
      assert.deepEqual(run.timestamps, { created_at: at.toISOString(), queued_at: at.toISOString(), claimed_at: null, started_at: null, heartbeat_at: null, last_progress_at: null, last_successful_output_at: null, finished_at: null, updated_at: at.toISOString() });
      assert.deepEqual(run.progress, { total: null, started: 0, succeeded: 0, failed: 0, skipped: 0, outputs_created: 0, outputs_modified: 0, outputs_deleted: 0 });
      assert.deepEqual(run.reliability, { attempt: 0, claim_id: null, worker_instance_id: null, pid: null, effective_jobs: null, heartbeat_sequence: 0, write_sequence: 0, exit_code: null, termination_signal: null, recovered_at: null, recovery_reason: null });
      assert.equal(run.terminal_error, null);
    }
  });

  it("mints fresh ids and independent timeout snapshots", () => {
    const first = createQueuedWorkerRun("curator", {});
    const second = createQueuedWorkerRun("curator", {});
    assert.notEqual(first.run_id, second.run_id);
    assert.notStrictEqual(first.timeout_policy, second.timeout_policy);
    assert.notStrictEqual(first.timeout_policy, DEFAULT_WORKER_RUN_TIMEOUT_POLICY);
  });
});
