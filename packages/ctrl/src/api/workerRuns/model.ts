export const WORKER_RUN_STATES = ["queued", "running", "succeeded", "failed", "timed_out"] as const;
export type WorkerRunState = typeof WORKER_RUN_STATES[number];
export type WorkerName = "curator" | "distiller" | "janitor";
export interface WorkerRunRouteByWorker {
  curator: "/api/v1/workers/process"; distiller: "/api/v1/workers/distiller/run"; janitor: "/api/v1/workers/janitor/fix";
}

export interface WorkerRunInputByWorker {
  curator: { limit: number | null; dry_run: boolean; jobs: number };
  distiller: { project: string | null };
  janitor: Record<string, never>;
}
export interface WorkerRunTimeoutPolicy { claim_timeout_seconds: number; heartbeat_timeout_seconds: number; no_progress_timeout_seconds: number; run_timeout_seconds: number }
export interface WorkerRunTimestamps { created_at: string; queued_at: string; claimed_at: string | null; started_at: string | null; heartbeat_at: string | null; last_progress_at: string | null; last_successful_output_at: string | null; finished_at: string | null; updated_at: string }
export interface WorkerRunProgress { total: number | null; started: number; succeeded: number; failed: number; skipped: number; outputs_created: number; outputs_modified: number; outputs_deleted: number }
export interface WorkerRunTerminalError { code: string; message: string; retryable: boolean; at: string }
export interface WorkerRunReliability { attempt: number; claim_id: string | null; worker_instance_id: string | null; pid: number | null; effective_jobs: number | null; heartbeat_sequence: number; write_sequence: number; exit_code: number | null; termination_signal: string | null; recovered_at: string | null; recovery_reason: string | null }
export interface WorkerRunRecord<W extends WorkerName = WorkerName> {
  schema_version: 1; run_id: string; worker: W; state: WorkerRunState;
  trigger: { kind: "manual_api"; route: WorkerRunRouteByWorker[W]; requested_at: string };
  input: WorkerRunInputByWorker[W]; timeout_policy: WorkerRunTimeoutPolicy;
  timestamps: WorkerRunTimestamps; progress: WorkerRunProgress;
  terminal_error: WorkerRunTerminalError | null; reliability: WorkerRunReliability;
}
export type WorkerRun = WorkerRunRecord;

export const WORKER_RUN_ROUTES: { readonly [W in WorkerName]: WorkerRunRouteByWorker[W] } = Object.freeze({
  curator: "/api/v1/workers/process", distiller: "/api/v1/workers/distiller/run", janitor: "/api/v1/workers/janitor/fix",
});
export const DEFAULT_WORKER_RUN_TIMEOUT_POLICY: Readonly<WorkerRunTimeoutPolicy> = Object.freeze({
  claim_timeout_seconds: 60, heartbeat_timeout_seconds: 120, no_progress_timeout_seconds: 900, run_timeout_seconds: 21600,
});

export class WorkerRunDecodeError extends Error {
  constructor(message: string) { super(message); this.name = "WorkerRunDecodeError"; }
}

type Obj = Record<string, unknown>;
const TOP = ["schema_version", "run_id", "worker", "state", "trigger", "input", "timeout_policy", "timestamps", "progress", "terminal_error", "reliability"];
const TS = ["created_at", "queued_at", "claimed_at", "started_at", "heartbeat_at", "last_progress_at", "last_successful_output_at", "finished_at", "updated_at"];
const PROGRESS = ["total", "started", "succeeded", "failed", "skipped", "outputs_created", "outputs_modified", "outputs_deleted"];
const RELIABILITY = ["attempt", "claim_id", "worker_instance_id", "pid", "effective_jobs", "heartbeat_sequence", "write_sequence", "exit_code", "termination_signal", "recovered_at", "recovery_reason"];
const ACTIVE_TS = ["claimed_at", "started_at", "heartbeat_at"];
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const fail = (path: string, why: string): never => { throw new WorkerRunDecodeError(`${path}: ${why}`); };
function exact(value: unknown, path: string, keys: readonly string[]): Obj {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "expected object");
  const actual = Object.keys(value as object);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail(path, `expected exactly ${keys.join(", ")}`);
  return value as Obj;
}
const uint = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const timestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const m = RFC3339.exec(value); if (!m || !Number.isFinite(Date.parse(value))) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[4] < 24 && +m[5] < 60 && +m[6] < 60 && (!m[7] || (+m[7] < 24 && +m[8] < 60));
};
const nullableString = (value: unknown): boolean => value === null || (typeof value === "string" && value.length > 0);

export function decodeWorkerRun(value: unknown): WorkerRunRecord {
  const run = exact(value, "run", TOP);
  if (run.schema_version !== 1) fail("run.schema_version", "expected 1");
  if (typeof run.run_id !== "string" || !ULID.test(run.run_id)) fail("run.run_id", "expected uppercase ULID");
  if (!(["curator", "distiller", "janitor"] as unknown[]).includes(run.worker)) fail("run.worker", "invalid worker");
  if (!(WORKER_RUN_STATES as readonly unknown[]).includes(run.state)) fail("run.state", "invalid state");
  const worker = run.worker as WorkerName, state = run.state as WorkerRunState;

  const trigger = exact(run.trigger, "run.trigger", ["kind", "route", "requested_at"]);
  if (trigger.kind !== "manual_api" || trigger.route !== WORKER_RUN_ROUTES[worker]) fail("run.trigger", "provenance does not match worker");
  if (!timestamp(trigger.requested_at)) fail("run.trigger.requested_at", "invalid timestamp");

  const inputKeys = worker === "curator" ? ["limit", "dry_run", "jobs"] : worker === "distiller" ? ["project"] : [];
  const input = exact(run.input, "run.input", inputKeys);
  if (worker === "curator" && !((input.limit === null || (positive(input.limit) && input.limit <= 10000)) && typeof input.dry_run === "boolean" && positive(input.jobs) && input.jobs <= 32)) fail("run.input", "invalid curator input");
  if (worker === "distiller" && !(input.project === null || (typeof input.project === "string" && input.project === input.project.trim() && input.project.length >= 1 && input.project.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/u.test(input.project)))) fail("run.input.project", "invalid distiller project");

  const policy = exact(run.timeout_policy, "run.timeout_policy", Object.keys(DEFAULT_WORKER_RUN_TIMEOUT_POLICY));
  for (const key of Object.keys(DEFAULT_WORKER_RUN_TIMEOUT_POLICY)) if (!positive(policy[key])) fail(`run.timeout_policy.${key}`, "expected positive integer");
  const times = exact(run.timestamps, "run.timestamps", TS);
  for (const key of TS) if (!(times[key] === null || timestamp(times[key]))) fail(`run.timestamps.${key}`, "invalid timestamp");
  for (const key of ["created_at", "queued_at", "updated_at"]) if (times[key] === null) fail(`run.timestamps.${key}`, "must not be null");

  const progress = exact(run.progress, "run.progress", PROGRESS);
  if (!(progress.total === null || uint(progress.total))) fail("run.progress.total", "expected null or non-negative integer");
  for (const key of PROGRESS.slice(1)) if (!uint(progress[key])) fail(`run.progress.${key}`, "expected non-negative integer");
  if (progress.total === null && PROGRESS.slice(1).some((key) => progress[key] !== 0)) fail("run.progress", "counters require discovered total");
  const total = progress.total;
  if (typeof total === "number" && ["started", "succeeded", "failed", "skipped"].some((key) => (progress[key] as number) > total)) fail("run.progress", "counter exceeds total");
  if (typeof total === "number" && (progress.succeeded as number) + (progress.failed as number) + (progress.skipped as number) > total) fail("run.progress", "outcomes exceed total");
  const outputs = (progress.outputs_created as number) + (progress.outputs_modified as number) + (progress.outputs_deleted as number);
  const progressed = progress.total !== null || PROGRESS.slice(1).some((key) => progress[key] !== 0);
  if (progressed !== (times.last_progress_at !== null)) fail("run.timestamps.last_progress_at", "must track counter progress");
  if ((outputs === 0) !== (times.last_successful_output_at === null)) fail("run.timestamps.last_successful_output_at", "must track successful outputs");

  let terminal: Obj | null = null;
  if (run.terminal_error !== null) {
    terminal = exact(run.terminal_error, "run.terminal_error", ["code", "message", "retryable", "at"]);
    if (typeof terminal.code !== "string" || !terminal.code || typeof terminal.message !== "string" || !terminal.message || typeof terminal.retryable !== "boolean" || !timestamp(terminal.at)) fail("run.terminal_error", "invalid terminal error");
  }
  const failed = state === "failed" || state === "timed_out";
  if (failed !== (terminal !== null)) fail("run.terminal_error", "does not match state");

  const reliability = exact(run.reliability, "run.reliability", RELIABILITY);
  for (const key of ["attempt", "heartbeat_sequence", "write_sequence"]) if (!uint(reliability[key])) fail(`run.reliability.${key}`, "expected non-negative integer");
  if ((reliability.heartbeat_sequence as number) > (reliability.write_sequence as number)) fail("run.reliability", "heartbeat sequence exceeds write sequence");
  if (!(reliability.pid === null || positive(reliability.pid))) fail("run.reliability.pid", "invalid pid");
  if (!(reliability.effective_jobs === null || (positive(reliability.effective_jobs) && reliability.effective_jobs <= 32)) || (worker === "janitor" && reliability.effective_jobs !== null)) fail("run.reliability.effective_jobs", "invalid effective jobs");
  if (!(reliability.exit_code === null || Number.isSafeInteger(reliability.exit_code))) fail("run.reliability.exit_code", "invalid exit code");
  for (const key of ["claim_id", "worker_instance_id", "termination_signal", "recovery_reason"]) if (!nullableString(reliability[key])) fail(`run.reliability.${key}`, "expected null or non-empty string");
  if (!(reliability.recovered_at === null || timestamp(reliability.recovered_at)) || ((reliability.recovered_at === null) !== (reliability.recovery_reason === null))) fail("run.reliability", "invalid recovery metadata");

  if (state === "queued") {
    if (ACTIVE_TS.concat(["last_progress_at", "last_successful_output_at", "finished_at"]).some((key) => times[key] !== null) || progress.total !== null || PROGRESS.slice(1).some((key) => progress[key] !== 0) || ["claim_id", "worker_instance_id", "pid", "effective_jobs", "exit_code", "termination_signal", "recovered_at", "recovery_reason"].some((key) => reliability[key] !== null) || reliability.attempt !== 0 || reliability.heartbeat_sequence !== 0 || reliability.write_sequence !== 0) fail("run", "queued record is not initial");
  } else {
    if (ACTIVE_TS.some((key) => times[key] === null) || reliability.attempt !== 1 || !nullableString(reliability.claim_id) || reliability.claim_id === null || !nullableString(reliability.worker_instance_id) || reliability.worker_instance_id === null || !positive(reliability.pid) || !positive(reliability.write_sequence)) fail("run", "claimed record lacks ownership fields");
    if ((state === "running") !== (times.finished_at === null)) fail("run.timestamps.finished_at", "does not match state");
    if (state === "running" && ["exit_code", "termination_signal", "recovered_at", "recovery_reason"].some((key) => reliability[key] !== null)) fail("run.reliability", "running record has terminal metadata");
  }
  if (worker === "janitor" && state === "succeeded" && (progress.total === null || (progress.succeeded as number) + (progress.failed as number) + (progress.skipped as number) !== progress.total || progress.started !== (progress.succeeded as number) + (progress.failed as number))) fail("run.progress", "invalid succeeded janitor accounting");
  return run as unknown as WorkerRunRecord;
}

export function parseWorkerRunJson(raw: string): WorkerRunRecord {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail("run", "invalid JSON"); }
  return decodeWorkerRun(value);
}
export const parseWorkerRun = decodeWorkerRun;
