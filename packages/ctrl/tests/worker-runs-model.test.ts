import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeWorkerRun, parseWorkerRunJson, WorkerRunDecodeError, WORKER_RUN_ROUTES } from "../src/api/workerRuns/model.js";

const now = "2026-07-21T12:00:00.000Z";
function queued(worker: "curator" | "distiller" | "janitor" = "curator"): any {
  return { schema_version: 1, run_id: "01K0ABCDEF1234567890GHJKMN", worker, state: "queued",
    trigger: { kind: "manual_api", route: WORKER_RUN_ROUTES[worker], requested_at: now },
    input: worker === "curator" ? { limit: null, dry_run: false, jobs: 4 } : worker === "distiller" ? { project: null } : {},
    timeout_policy: { claim_timeout_seconds: 60, heartbeat_timeout_seconds: 120, no_progress_timeout_seconds: 900, run_timeout_seconds: 21600 },
    timestamps: { created_at: now, queued_at: now, claimed_at: null, started_at: null, heartbeat_at: null, last_progress_at: null, last_successful_output_at: null, finished_at: null, updated_at: now },
    progress: { total: null, started: 0, succeeded: 0, failed: 0, skipped: 0, outputs_created: 0, outputs_modified: 0, outputs_deleted: 0 }, terminal_error: null,
    reliability: { attempt: 0, claim_id: null, worker_instance_id: null, pid: null, effective_jobs: null, heartbeat_sequence: 0, write_sequence: 0, exit_code: null, termination_signal: null, recovered_at: null, recovery_reason: null } };
}
const rejects = (record: any) => assert.throws(() => decodeWorkerRun(record), WorkerRunDecodeError);
function claimed(state: "running" | "succeeded" | "failed" | "timed_out", worker: "curator" | "distiller" | "janitor" = "curator"): any {
  const run = queued(worker); run.state = state; run.progress.total = 0; run.timestamps.last_progress_at = now;
  Object.assign(run.timestamps, { claimed_at: now, started_at: now, heartbeat_at: now, finished_at: state === "running" ? null : now });
  Object.assign(run.reliability, { attempt: 1, claim_id: "claim", worker_instance_id: "boot", pid: 42, effective_jobs: worker === "janitor" ? null : 1, write_sequence: 1 });
  if (state === "failed" || state === "timed_out") run.terminal_error = { code: "safe_error", message: "safe summary", retryable: false, at: now };
  return run;
}

describe("worker-run strict model", () => {
  it("decodes each contracted worker and preserves deleted-output accounting", () => {
    for (const worker of ["curator", "distiller", "janitor"] as const) assert.deepEqual(decodeWorkerRun(queued(worker)), queued(worker));
    assert.equal(parseWorkerRunJson(JSON.stringify(queued())).state, "queued");
  });
  it("decodes running and every terminal state, including a clean janitor run", () => {
    for (const state of ["running", "succeeded", "failed", "timed_out"] as const) assert.equal(decodeWorkerRun(claimed(state, state === "succeeded" ? "janitor" : "curator")).state, state);
    const output = claimed("running"); Object.assign(output.progress, { total: 1, started: 1, succeeded: 1, outputs_deleted: 1 }); output.timestamps.last_successful_output_at = now;
    assert.equal(decodeWorkerRun(output).progress.outputs_deleted, 1);
  });
  it("rejects malformed shape, missing nullable keys, and route/worker mismatches", () => {
    const extra = queued(); extra.uncontracted = true; rejects(extra);
    const missing = queued(); delete missing.timestamps.finished_at; rejects(missing);
    const provenance = queued("janitor"); provenance.trigger.route = WORKER_RUN_ROUTES.curator; rejects(provenance);
    assert.throws(() => parseWorkerRunJson("{"), WorkerRunDecodeError);
  });
  it("rejects invalid canonical inputs, timestamps, and counters", () => {
    const overflowUlid = queued(); overflowUlid.run_id = `Z${overflowUlid.run_id.slice(1)}`; rejects(overflowUlid);
    const input = queued(); input.input.jobs = 1.5; rejects(input);
    const project = queued("distiller"); project.input.project = " untrimmed "; rejects(project);
    const timestamp = queued(); timestamp.timestamps.updated_at = "yesterday"; rejects(timestamp);
    const counter = queued(); counter.progress.outputs_deleted = -1; rejects(counter);
    for (const key of ["attempt", "heartbeat_sequence", "write_sequence"]) { const reliability = queued(); reliability.reliability[key] = -1; rejects(reliability); }
    const outcomes = claimed("running"); Object.assign(outcomes.progress, { total: 1, succeeded: 1, failed: 1 }); rejects(outcomes);
    const janitor = claimed("running", "janitor"); Object.assign(janitor.progress, { total: 1, started: 0, succeeded: 1 }); rejects(janitor);
    const doubleCounted = claimed("running", "janitor"); Object.assign(doubleCounted.progress, { total: 1, started: 1, skipped: 1 }); rejects(doubleCounted);
  });
  it("requires terminal errors exactly for failed and timed-out states", () => {
    const activeError = queued(); activeError.terminal_error = { code: "bad", message: "safe", retryable: false, at: now }; rejects(activeError);
    const failed = queued(); failed.state = "failed"; rejects(failed);
    const janitor = claimed("succeeded", "janitor"); janitor.progress.total = 1; rejects(janitor);
  });
});
