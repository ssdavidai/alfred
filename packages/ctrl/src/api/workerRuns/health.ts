import type { WorkerRunRecord } from "./model.js";

export const WORKER_RUN_HEALTH_REASONS = [
  "queue_age_exceeded",
  "heartbeat_stale",
  "no_progress",
  "hard_timeout_exceeded",
] as const;

export type WorkerRunHealthReason = typeof WORKER_RUN_HEALTH_REASONS[number];
export type WorkerRunHealthStatus = "idle" | "queued" | "running" | "stalled" | "failed" | "complete";

export interface WorkerRunHealth {
  status: WorkerRunHealthStatus;
  health_reasons: WorkerRunHealthReason[];
  queue_age_seconds: number | null;
  heartbeat_age_seconds: number | null;
  no_progress_age_seconds: number | null;
  run_age_seconds: number | null;
}

const ageSeconds = (from: string, until: number): number =>
  Math.max(0, (until - Date.parse(from)) / 1_000);

/** Derive inspection health without writing to, or otherwise owning, the run. */
export function deriveWorkerRunHealth(
  run: WorkerRunRecord | null,
  now = new Date(),
): WorkerRunHealth {
  if (run === null) return {
    status: "idle", health_reasons: [], queue_age_seconds: null,
    heartbeat_age_seconds: null, no_progress_age_seconds: null, run_age_seconds: null,
  };

  const observedAt = run.timestamps.finished_at === null
    ? now.getTime()
    : Date.parse(run.timestamps.finished_at);
  const queueUntil = run.timestamps.claimed_at === null
    ? observedAt
    : Date.parse(run.timestamps.claimed_at);
  const queueAge = ageSeconds(run.timestamps.queued_at, queueUntil);
  if (run.state === "queued") {
    const reasons: WorkerRunHealthReason[] = queueAge > run.timeout_policy.claim_timeout_seconds
      ? ["queue_age_exceeded"] : [];
    return {
      status: reasons.length === 0 ? "queued" : "stalled", health_reasons: reasons,
      queue_age_seconds: queueAge, heartbeat_age_seconds: null,
      no_progress_age_seconds: null, run_age_seconds: null,
    };
  }

  const heartbeatAge = ageSeconds(run.timestamps.heartbeat_at!, observedAt);
  const noProgressAge = ageSeconds(run.timestamps.last_progress_at ?? run.timestamps.started_at!, observedAt);
  const runAge = ageSeconds(run.timestamps.started_at!, observedAt);
  const reasons: WorkerRunHealthReason[] = [];
  if (run.state === "running") {
    if (queueAge > run.timeout_policy.claim_timeout_seconds) reasons.push("queue_age_exceeded");
    if (heartbeatAge > run.timeout_policy.heartbeat_timeout_seconds) reasons.push("heartbeat_stale");
    if (noProgressAge > run.timeout_policy.no_progress_timeout_seconds) reasons.push("no_progress");
    if (runAge > run.timeout_policy.run_timeout_seconds) reasons.push("hard_timeout_exceeded");
  }
  const status: WorkerRunHealthStatus = run.state === "running"
    ? (reasons.length === 0 ? "running" : "stalled")
    : run.state === "succeeded" ? "complete" : "failed";
  return {
    status, health_reasons: reasons, queue_age_seconds: queueAge,
    heartbeat_age_seconds: heartbeatAge, no_progress_age_seconds: noProgressAge,
    run_age_seconds: runAge,
  };
}
