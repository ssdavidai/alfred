import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeWorkerRuns } from "../src/api/workerRuns/metrics.js";
import type { WorkerName, WorkerRunRecord, WorkerRunState } from "../src/api/workerRuns/model.js";
import { createQueuedWorkerRun } from "../src/api/workerRuns/request.js";

const date = (value: string) => new Date(value);
function run(worker: WorkerName, state: WorkerRunState, created: string, started?: string, finished?: string, succeeded = 0): WorkerRunRecord {
  const value = createQueuedWorkerRun(worker, {}, date(created));
  value.state = state;
  if (state === "queued") return value;
  Object.assign(value.timestamps, {
    claimed_at: started!, started_at: started!, heartbeat_at: started!,
    last_progress_at: started!, finished_at: state === "running" ? null : finished!,
    updated_at: state === "running" ? started! : finished!,
  });
  Object.assign(value.progress, { total: succeeded, started: succeeded, succeeded });
  Object.assign(value.reliability, {
    attempt: 1, claim_id: "claim", worker_instance_id: "boot", pid: 42,
    effective_jobs: worker === "janitor" ? null : 1, write_sequence: 1,
    exit_code: state === "running" ? null : state === "succeeded" ? 0 : 1,
  });
  if (state === "failed" || state === "timed_out") value.terminal_error = {
    code: "worker_failed", message: "safe", retryable: false, at: finished!,
  };
  return value;
}

describe("worker-run status metrics", () => {
  it("identifies active and latest runs for all workers and preserves derived health", () => {
    const curatorDone = run("curator", "succeeded", "2026-07-21T10:00:00Z", "2026-07-21T10:01:00Z", "2026-07-21T10:02:00Z");
    const curatorActive = run("curator", "running", "2026-07-21T11:00:00Z", "2026-07-21T11:00:30Z");
    const distiller = run("distiller", "failed", "2026-07-21T09:00:00Z", "2026-07-21T09:01:00Z", "2026-07-21T09:02:00Z");
    const janitor = run("janitor", "queued", "2026-07-21T11:59:30Z");
    const result = summarizeWorkerRuns([janitor, curatorActive, distiller, curatorDone], date("2026-07-21T12:00:00Z"));
    assert.deepEqual([result.curator.active_run_id, result.curator.latest_run_id, result.curator.status], [curatorActive.run_id, curatorActive.run_id, "stalled"]);
    assert.deepEqual(result.curator.health_reasons, ["heartbeat_stale", "no_progress"]);
    assert.deepEqual([result.distiller.active_run_id, result.distiller.latest_run_id, result.distiller.status], [null, distiller.run_id, "failed"]);
    assert.deepEqual([result.janitor.active_run_id, result.janitor.latest_run_id, result.janitor.status], [janitor.run_id, janitor.run_id, "queued"]);
    assert.equal(result.janitor.metrics.queue_age_seconds, 30);
  });

  it("uses the newest output and counts consecutive terminal failures while ignoring active runs", () => {
    const success = run("curator", "succeeded", "2026-07-20T08:00:00Z", "2026-07-20T08:00:00Z", "2026-07-20T08:10:00Z", 1);
    success.progress.outputs_created = 1; success.timestamps.last_successful_output_at = "2026-07-20T08:09:00Z";
    const failed = run("curator", "failed", "2026-07-20T09:00:00Z", "2026-07-20T09:00:00Z", "2026-07-20T09:10:00Z");
    failed.progress.outputs_modified = 1; failed.timestamps.last_successful_output_at = "2026-07-20T09:05:00Z";
    const timedOut = run("curator", "timed_out", "2026-07-20T10:00:00Z", "2026-07-20T10:00:00Z", "2026-07-20T10:10:00Z");
    const active = run("curator", "running", "2026-07-20T11:00:00Z", "2026-07-20T11:00:00Z");
    const metrics = summarizeWorkerRuns([active, success, timedOut, failed], date("2026-07-20T11:01:00Z")).curator.metrics;
    assert.equal(metrics.last_successful_output_at, "2026-07-20T09:05:00Z");
    assert.equal(metrics.failure_streak, 2);
    assert.equal(metrics.throughput_window_seconds, 86_400);
  });

  it("divides successes by only trailing-window running time, including failed and no-progress time", () => {
    const completed = run("curator", "succeeded", "2026-07-21T10:00:00Z", "2026-07-21T11:00:00Z", "2026-07-21T13:00:00Z", 60);
    const failed = run("curator", "failed", "2026-07-21T14:00:00Z", "2026-07-21T14:00:00Z", "2026-07-21T15:00:00Z");
    const noProgress = run("curator", "running", "2026-07-22T11:00:00Z", "2026-07-22T11:00:00Z");
    const queued = run("curator", "queued", "2026-07-22T00:00:00Z");
    const beforeWindow = run("curator", "succeeded", "2026-07-20T01:00:00Z", "2026-07-20T01:00:00Z", "2026-07-20T02:00:00Z", 1_000);
    const metrics = summarizeWorkerRuns([completed, failed, noProgress, queued, beforeWindow], date("2026-07-22T12:00:00Z")).curator.metrics;
    assert.equal(metrics.trailing_effective_throughput_per_minute, 1 / 3);
  });

  it("returns null throughput and idle identifiers with zero running time", () => {
    const result = summarizeWorkerRuns([], date("2026-07-22T12:00:00Z"));
    assert.deepEqual(result.janitor, {
      status: "idle", active_run_id: null, latest_run_id: null, health_reasons: [],
      metrics: { queue_age_seconds: null, last_successful_output_at: null, failure_streak: 0,
        throughput_window_seconds: 86_400, trailing_effective_throughput_per_minute: null },
    });
    const queued = run("distiller", "queued", "2026-07-22T11:00:00Z");
    assert.equal(summarizeWorkerRuns([queued], date("2026-07-22T12:00:00Z")).distiller.metrics.trailing_effective_throughput_per_minute, null);
  });
});
