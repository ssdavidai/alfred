import * as fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { decodeWorkerRun, type WorkerName, type WorkerRunRecord } from "./model.js";
import { createQueuedWorkerRun } from "./request.js";

const RUN_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
type LedgerFs = Pick<typeof fs, "mkdirSync" | "existsSync" | "openSync" | "writeFileSync" | "fsyncSync" | "closeSync" | "renameSync" | "unlinkSync" | "readFileSync" | "readdirSync">;

export function workerRunsDirectory(dataDir: string | undefined = process.env.ALFRED_DATA_DIR): string {
  return path.join(dataDir || "/alfred-data", "state", "worker-runs");
}

export class WorkerRunLedgerEntryError extends Error {
  constructor(readonly entry: string, message: string, options?: ErrorOptions) {
    super(`worker-run ledger entry ${entry}: ${message}`, options);
    this.name = "WorkerRunLedgerEntryError";
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function readWorkerRun(
  runId: string,
  directory = workerRunsDirectory(),
  io: LedgerFs = fs,
): WorkerRunRecord | null {
  if (!RUN_ID.test(runId)) throw new WorkerRunLedgerEntryError(runId, "invalid run id");
  const file = path.join(directory, `${runId}.json`);
  try {
    const run = decodeWorkerRun(JSON.parse(io.readFileSync(file, "utf8")));
    if (run.run_id !== runId) throw new Error("run_id does not match filename");
    return run;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof WorkerRunLedgerEntryError) throw error;
    throw new WorkerRunLedgerEntryError(path.basename(file), "malformed or unreadable", { cause: error });
  }
}

export function listWorkerRuns(
  directory = workerRunsDirectory(),
  io: LedgerFs = fs,
): WorkerRunRecord[] {
  let entries: fs.Dirent[];
  try { entries = io.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (isNotFound(error)) return []; throw error; }
  const runs: WorkerRunRecord[] = [];
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (entry.name.startsWith(".") || entry.name.includes(".tmp") || !entry.name.endsWith(".json")) continue;
    const runId = entry.name.slice(0, -5);
    if (!entry.isFile() || !RUN_ID.test(runId)) throw new WorkerRunLedgerEntryError(entry.name, "invalid final filename");
    const run = readWorkerRun(runId, directory, io);
    if (run) runs.push(run); // A concurrent retention pass may remove a terminal entry.
  }
  return runs;
}

export function writeInitialWorkerRun(
  value: WorkerRunRecord,
  directory = workerRunsDirectory(),
  io: LedgerFs = fs,
): void {
  const run = decodeWorkerRun(value);
  if (run.state !== "queued") throw new WorkerRunLedgerEntryError(run.run_id, "initial record must be queued");
  io.mkdirSync(directory, { recursive: true });
  const finalPath = path.join(directory, `${run.run_id}.json`);
  if (io.existsSync(finalPath)) throw new WorkerRunLedgerEntryError(run.run_id, "record already exists");
  const temporaryPath = path.join(directory, `.${run.run_id}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = io.openSync(temporaryPath, "wx", 0o600);
    io.writeFileSync(fd, `${JSON.stringify(run)}\n`, "utf8");
    io.fsyncSync(fd); io.closeSync(fd); fd = null;
    io.renameSync(temporaryPath, finalPath);
    const directoryFd = io.openSync(directory, "r");
    try { io.fsyncSync(directoryFd); } finally { io.closeSync(directoryFd); }
  } catch (error) {
    if (fd !== null) try { io.closeSync(fd); } catch { /* preserve the write error */ }
    try { io.unlinkSync(temporaryPath); } catch { /* absent after rename or failed before create */ }
    throw error;
  }
}

export function enqueueWorkerRun<W extends WorkerName>(
  worker: W,
  body: unknown,
  now = new Date(),
  directory = workerRunsDirectory(),
): { run: WorkerRunRecord<W>; reused: boolean } {
  const candidate = createQueuedWorkerRun(worker, body, now); // Validate every trigger, including reuse.
  const active = listWorkerRuns(directory).find((run) => run.worker === worker && (run.state === "queued" || run.state === "running"));
  if (active) return { run: active as WorkerRunRecord<W>, reused: true };
  writeInitialWorkerRun(candidate, directory);
  return { run: candidate, reused: false };
}
