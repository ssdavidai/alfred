import { deriveWorkerRunHealth, type WorkerRunHealthReason, type WorkerRunHealthStatus } from "./health.js";
import type { WorkerName, WorkerRunRecord } from "./model.js";

export const WORKER_RUN_THROUGHPUT_WINDOW_SECONDS = 86_400;
export interface WorkerRunMetrics {
  queue_age_seconds: number | null;
  last_successful_output_at: string | null;
  failure_streak: number;
  throughput_window_seconds: 86400;
  trailing_effective_throughput_per_minute: number | null;
}
export interface WorkerRunSummary {
  status: WorkerRunHealthStatus;
  active_run_id: string | null;
  latest_run_id: string | null;
  health_reasons: WorkerRunHealthReason[];
  metrics: WorkerRunMetrics;
}
export type WorkerRunSummaries = { [W in WorkerName]: WorkerRunSummary };

const active = (run: WorkerRunRecord): boolean => run.state === "queued" || run.state === "running";
const terminal = (run: WorkerRunRecord): boolean => !active(run);
const newer = (left: WorkerRunRecord, right: WorkerRunRecord): number => {
  const byCreation = Date.parse(right.timestamps.created_at) - Date.parse(left.timestamps.created_at);
  return byCreation || right.run_id.localeCompare(left.run_id);
};
const newest = (runs: readonly WorkerRunRecord[]): WorkerRunRecord | null =>
  runs.length === 0 ? null : [...runs].sort(newer)[0];

/** Calculate the contracted read-only metrics for one worker's run history. */
export function deriveWorkerRunMetrics(
  runs: readonly WorkerRunRecord[],
  now = new Date(),
): WorkerRunMetrics {
  const representative = newest(runs.filter(active)) ?? newest(runs);
  const queueAge = deriveWorkerRunHealth(representative, now).queue_age_seconds;
  const outputs = runs.map((run) => run.timestamps.last_successful_output_at).filter((at): at is string => at !== null);
  const latestOutput = outputs.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  let failureStreak = 0;
  for (const run of [...runs].filter(terminal).sort(newer)) {
    if (run.state === "succeeded") break;
    failureStreak += 1;
  }

  const nowMs = now.getTime();
  const windowStart = nowMs - WORKER_RUN_THROUGHPUT_WINDOW_SECONDS * 1_000;
  let succeeded = 0, runningSeconds = 0;
  for (const run of runs) {
    if (run.timestamps.started_at === null) continue;
    const start = Math.max(windowStart, Date.parse(run.timestamps.started_at));
    const end = Math.min(nowMs, run.timestamps.finished_at === null ? nowMs : Date.parse(run.timestamps.finished_at));
    const overlap = Math.max(0, (end - start) / 1_000);
    if (overlap === 0) continue;
    succeeded += run.progress.succeeded;
    runningSeconds += overlap;
  }
  return {
    queue_age_seconds: queueAge, last_successful_output_at: latestOutput,
    failure_streak: failureStreak, throughput_window_seconds: WORKER_RUN_THROUGHPUT_WINDOW_SECONDS,
    trailing_effective_throughput_per_minute: runningSeconds === 0 ? null : succeeded * 60 / runningSeconds,
  };
}

export function summarizeWorkerRun(
  worker: WorkerName,
  runs: readonly WorkerRunRecord[],
  now = new Date(),
): WorkerRunSummary {
  const history = runs.filter((run) => run.worker === worker);
  const latest = newest(history), activeRun = newest(history.filter(active));
  const health = deriveWorkerRunHealth(activeRun ?? latest, now);
  return {
    status: health.status, active_run_id: activeRun?.run_id ?? null,
    latest_run_id: latest?.run_id ?? null, health_reasons: health.health_reasons,
    metrics: deriveWorkerRunMetrics(history, now),
  };
}

/** Build all status-route worker entries from one atomic ledger listing. */
export function summarizeWorkerRuns(
  runs: readonly WorkerRunRecord[],
  now = new Date(),
): WorkerRunSummaries {
  return {
    curator: summarizeWorkerRun("curator", runs, now),
    distiller: summarizeWorkerRun("distiller", runs, now),
    janitor: summarizeWorkerRun("janitor", runs, now),
  };
}
