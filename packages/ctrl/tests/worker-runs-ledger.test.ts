import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createQueuedWorkerRun } from "../src/api/workerRuns/request.js";
import { enqueueWorkerRun, listWorkerRuns, readWorkerRun, WorkerRunLedgerEntryError, workerRunsDirectory, writeInitialWorkerRun } from "../src/api/workerRuns/ledger.js";

const roots: string[] = [];
const ledger = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-runs-")); roots.push(root); return path.join(root, "state", "worker-runs"); };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("worker-run ledger", () => {
  it("resolves the shared production location and ALFRED_DATA_DIR override", () => {
    assert.equal(workerRunsDirectory(""), "/alfred-data/state/worker-runs");
    assert.equal(workerRunsDirectory("/tenant-data"), "/tenant-data/state/worker-runs");
  });

  it("creates a durable record with temp, file fsync, rename, then directory fsync", () => {
    const dir = "/data/state/worker-runs", run = createQueuedWorkerRun("curator", {}, new Date("2026-07-21T12:00:00Z"));
    const calls: string[] = []; let written = ""; let temporary = "";
    const io = {
      mkdirSync: (p: string) => { calls.push(`mkdir:${p}`); }, existsSync: () => false,
      openSync: (p: string, flag: string) => { calls.push(`open:${flag}:${p}`); if (flag === "wx") temporary = p; return flag === "wx" ? 1 : 2; },
      writeFileSync: (_fd: number, data: string) => { written = data; calls.push("write:1"); },
      fsyncSync: (fd: number) => { calls.push(`fsync:${fd}`); }, closeSync: (fd: number) => { calls.push(`close:${fd}`); },
      renameSync: (from: string, to: string) => { calls.push(`rename:${from}:${to}`); }, unlinkSync: () => {},
    } as unknown as typeof fs;
    writeInitialWorkerRun(run, dir, io);
    assert.equal(path.dirname(temporary), dir); assert.match(temporary, /\.tmp$/);
    assert.equal(JSON.parse(written).run_id, run.run_id);
    assert.deepEqual(calls.slice(-6), ["fsync:1", "close:1", `rename:${temporary}:${path.join(dir, `${run.run_id}.json`)}`, `open:r:${dir}`, "fsync:2", "close:2"]);
  });

  it("publishes only the complete final JSON and ignores temporary files", () => {
    const dir = ledger(), run = createQueuedWorkerRun("janitor", {}, new Date("2026-07-21T12:00:00Z"));
    writeInitialWorkerRun(run, dir);
    fs.writeFileSync(path.join(dir, `.${run.run_id}.crashed.tmp`), "{");
    fs.writeFileSync(path.join(dir, `${run.run_id}.json.inflight`), "{");
    assert.deepEqual(fs.readdirSync(dir).filter((name) => !name.includes("tmp") && name.endsWith(".json")), [`${run.run_id}.json`]);
    assert.deepEqual(readWorkerRun(run.run_id, dir), run);
    assert.deepEqual(listWorkerRuns(dir), [run]);
  });

  it("distinguishes an empty ledger from malformed or mismatched final entries", () => {
    const dir = ledger();
    assert.deepEqual(listWorkerRuns(dir), []);
    const run = createQueuedWorkerRun("distiller", {}, new Date("2026-07-21T12:00:00Z"));
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${run.run_id}.json`), "{");
    assert.throws(() => listWorkerRuns(dir), WorkerRunLedgerEntryError);
    fs.writeFileSync(path.join(dir, `${run.run_id}.json`), JSON.stringify({ ...run, run_id: "01K0ABCDEF1234567890GHJKMN" }));
    assert.throws(() => readWorkerRun(run.run_id, dir), WorkerRunLedgerEntryError);
    assert.equal(readWorkerRun("01K0ABCDEF1234567890GHJKMP", dir), null);
  });

  it("deduplicates concurrent same-worker enqueues without replacing immutable input", async () => {
    const dir = ledger();
    const [first, second] = await Promise.all([8, 1].map((jobs, minute) => Promise.resolve().then(
      () => enqueueWorkerRun("curator", { jobs }, new Date(`2026-07-21T12:0${minute}:00Z`), dir),
    )));
    const other = enqueueWorkerRun("janitor", {}, new Date("2026-07-21T12:01:00Z"), dir);
    assert.equal(first.reused, false); assert.equal(second.reused, true); assert.equal(other.reused, false);
    assert.equal(second.run.run_id, first.run.run_id); assert.deepEqual(second.run.input, { limit: null, dry_run: false, jobs: 8 });
    assert.throws(() => enqueueWorkerRun("curator", { jobs: 0 }, new Date(), dir));
    assert.equal(listWorkerRuns(dir).length, 2);
  });
});
