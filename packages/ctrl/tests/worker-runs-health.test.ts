import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveWorkerRunHealth } from "../src/api/workerRuns/health.js";
import type { WorkerRunRecord, WorkerRunState } from "../src/api/workerRuns/model.js";
import { createQueuedWorkerRun } from "../src/api/workerRuns/request.js";

const at = (value: string) => new Date(value);

function claimedRun(state: Exclude<WorkerRunState, "queued">): WorkerRunRecord<"curator"> {
  const run = createQueuedWorkerRun("curator", {}, at("2026-07-21T12:00:00Z"));
  run.state = state;
  Object.assign(run.timestamps, {
    claimed_at: "2026-07-21T12:00:30Z", started_at: "2026-07-21T12:00:30Z",
    heartbeat_at: "2026-07-21T12:00:30Z", updated_at: "2026-07-21T12:00:30Z",
    finished_at: state === "running" ? null : "2026-07-21T13:00:30Z",
  });
  Object.assign(run.reliability, {
    attempt: 1, claim_id: "claim", worker_instance_id: "boot", pid: 42,
    effective_jobs: 1, write_sequence: 1, exit_code: state === "running" ? null : 0,
  });
  if (state === "failed" || state === "timed_out") run.terminal_error = {
    code: "worker_failed", message: "failed", retryable: false,
    at: run.timestamps.finished_at!,
  };
  return run;
}

describe("worker-run health", () => {
  it("derives idle and live queued health at the exact claim boundary", () => {
    assert.deepEqual(deriveWorkerRunHealth(null, at("2026-07-21T12:00:00Z")), {
      status: "idle", health_reasons: [], queue_age_seconds: null,
      heartbeat_age_seconds: null, no_progress_age_seconds: null, run_age_seconds: null,
    });
    const run = createQueuedWorkerRun("curator", {}, at("2026-07-21T12:00:00Z"));
    assert.equal(deriveWorkerRunHealth(run, at("2026-07-21T12:01:00Z")).status, "queued");
    assert.deepEqual(deriveWorkerRunHealth(run, at("2026-07-21T12:01:00.001Z")), {
      status: "stalled", health_reasons: ["queue_age_exceeded"], queue_age_seconds: 60.001,
      heartbeat_age_seconds: null, no_progress_age_seconds: null, run_age_seconds: null,
    });
  });

  it("freezes queue age at claim while running timeout ages remain live", () => {
    const run = claimedRun("running");
    const first = deriveWorkerRunHealth(run, at("2026-07-21T12:01:00Z"));
    const later = deriveWorkerRunHealth(run, at("2026-07-21T12:02:00Z"));
    assert.equal(first.status, "running");
    assert.equal(first.queue_age_seconds, 30);
    assert.equal(later.queue_age_seconds, 30);
    assert.equal(later.heartbeat_age_seconds, 90);
    assert.equal(later.no_progress_age_seconds, 90);
    assert.equal(later.run_age_seconds, 90);
  });

  it("emits simultaneous running reasons in the contracted order", () => {
    const run = claimedRun("running");
    Object.assign(run.timeout_policy, {
      claim_timeout_seconds: 1, heartbeat_timeout_seconds: 1,
      no_progress_timeout_seconds: 1, run_timeout_seconds: 1,
    });
    assert.deepEqual(deriveWorkerRunHealth(run, at("2026-07-21T12:01:01Z")).health_reasons, [
      "queue_age_exceeded", "heartbeat_stale", "no_progress", "hard_timeout_exceeded",
    ]);
    assert.equal(deriveWorkerRunHealth(run, at("2026-07-21T12:01:01Z")).status, "stalled");
  });

  it("maps terminal states and freezes every age without mutating the record", () => {
    for (const state of ["succeeded", "failed", "timed_out"] as const) {
      const run = claimedRun(state), before = structuredClone(run);
      const first = deriveWorkerRunHealth(run, at("2026-07-22T00:00:00Z"));
      const later = deriveWorkerRunHealth(run, at("2026-07-23T00:00:00Z"));
      assert.equal(first.status, state === "succeeded" ? "complete" : "failed");
      assert.deepEqual(first, later);
      assert.deepEqual(first.health_reasons, []);
      assert.deepEqual(first, {
        ...first, queue_age_seconds: 30, heartbeat_age_seconds: 3_600,
        no_progress_age_seconds: 3_600, run_age_seconds: 3_600,
      });
      assert.deepEqual(run, before);
    }
  });
});
