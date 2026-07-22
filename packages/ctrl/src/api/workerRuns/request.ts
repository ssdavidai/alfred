import { ValidationError } from "../errors.js";
import { ulid } from "../../db/ulid.js";
import {
  DEFAULT_WORKER_RUN_TIMEOUT_POLICY,
  WORKER_RUN_ROUTES,
  type WorkerName,
  type WorkerRunInputByWorker,
  type WorkerRunRecord,
} from "./model.js";

type Body = Record<string, unknown>;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function objectBody(body: unknown): Body {
  if (body === undefined) return {};
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("body must be an object");
  }
  return body as Body;
}

function rejectUnknownKeys(body: Body, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ValidationError(`unknown request field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ValidationError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

export function parseWorkerRunInput<W extends WorkerName>(
  worker: W,
  body: unknown,
): WorkerRunInputByWorker[W] {
  const value = objectBody(body);
  if (worker === "curator") {
    rejectUnknownKeys(value, ["limit", "dry_run", "jobs"]);
    const limit = Object.hasOwn(value, "limit") ? value.limit : null;
    const dryRun = Object.hasOwn(value, "dry_run") ? value.dry_run : false;
    const jobs = Object.hasOwn(value, "jobs") ? value.jobs : 4;
    if (limit !== null) boundedInteger(limit, "limit", 1, 10_000);
    if (typeof dryRun !== "boolean") throw new ValidationError("dry_run must be a boolean");
    return { limit: limit as number | null, dry_run: dryRun, jobs: boundedInteger(jobs, "jobs", 1, 32) } as WorkerRunInputByWorker[W];
  }
  if (worker === "distiller") {
    rejectUnknownKeys(value, ["project"]);
    const project = Object.hasOwn(value, "project") ? value.project : null;
    if (project === null) return { project: null } as WorkerRunInputByWorker[W];
    if (typeof project !== "string") throw new ValidationError("project must be a string or null");
    if (CONTROL_CHARACTERS.test(project)) throw new ValidationError("project must not contain control characters");
    const trimmed = project.trim();
    if (trimmed.length < 1 || trimmed.length > 200) {
      throw new ValidationError("project must contain 1 to 200 characters after trimming");
    }
    return { project: trimmed } as WorkerRunInputByWorker[W];
  }
  if (worker === "janitor") {
    rejectUnknownKeys(value, []);
    return {} as WorkerRunInputByWorker[W];
  }
  throw new ValidationError("unknown worker");
}

export function createQueuedWorkerRun<W extends WorkerName>(
  worker: W,
  body: unknown,
  now: Date = new Date(),
): WorkerRunRecord<W> {
  const input = parseWorkerRunInput(worker, body);
  const at = now.toISOString();
  return {
    schema_version: 1,
    run_id: ulid(now.getTime()),
    worker,
    state: "queued",
    trigger: { kind: "manual_api", route: WORKER_RUN_ROUTES[worker], requested_at: at },
    input: { ...input },
    timeout_policy: { ...DEFAULT_WORKER_RUN_TIMEOUT_POLICY },
    timestamps: {
      created_at: at, queued_at: at, claimed_at: null, started_at: null,
      heartbeat_at: null, last_progress_at: null, last_successful_output_at: null,
      finished_at: null, updated_at: at,
    },
    progress: {
      total: null, started: 0, succeeded: 0, failed: 0, skipped: 0,
      outputs_created: 0, outputs_modified: 0, outputs_deleted: 0,
    },
    terminal_error: null,
    reliability: {
      attempt: 0, claim_id: null, worker_instance_id: null, pid: null,
      effective_jobs: null, heartbeat_sequence: 0, write_sequence: 0,
      exit_code: null, termination_signal: null, recovered_at: null, recovery_reason: null,
    },
  };
}
