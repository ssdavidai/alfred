import {
  enqueueWorkerRun as enqueueWorkerRunInLedger,
  workerRunsDirectory,
} from "./ledger.js";
import type { WorkerName, WorkerRunRecord } from "./model.js";

const workerTails = new Map<WorkerName, Promise<void>>();

async function withWorkerLock<T>(worker: WorkerName, operation: () => T): Promise<T> {
  const previous = workerTails.get(worker) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => turn);
  workerTails.set(worker, tail);

  await previous;
  try {
    return operation();
  } finally {
    release();
    if (workerTails.get(worker) === tail) workerTails.delete(worker);
  }
}

/** Serialize the active-read/initial-write decision for each ctrl-api worker. */
export function enqueueWorkerRun<W extends WorkerName>(
  worker: W,
  body: unknown,
  now = new Date(),
  directory = workerRunsDirectory(),
): Promise<{ run: WorkerRunRecord<W>; reused: boolean }> {
  return withWorkerLock(worker, () => enqueueWorkerRunInLedger(worker, body, now, directory));
}
