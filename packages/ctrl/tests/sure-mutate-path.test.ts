import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Regression for FAILURE-MODES Part 4 (Sure/Plane bug #2):
//
// On the merged single-VM stack ctrl-api mounts `alfred_data:/alfred-data`
// (NOT the old deploy-template `/mnt/encrypted/alfred`). The Rails-runner
// mutate path writes the payload to a host file, then tells sure-web to
// read it back through the SHARED /alfred-data volume. If the writer puts
// the payload under /mnt/encrypted/alfred it lands in ctrl-api's overlay
// FS — sure-web never sees it and every mutate op fails.
//
// The contract: the directory ctrl-api WRITES the payload into must be the
// same directory sure-web READS it from, i.e. the writer dir prefix must
// match the container path (/alfred-data) it hands the runner.
// ---------------------------------------------------------------------------

let execFileStdout = '{"ok":true,"transfer":{"id":"t-1"}}';
const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
const execFileFn = mock.fn((...args: any[]) => {
  execFileCalls.push({ cmd: args[0] as string, args: args[1] as string[] });
  const cb = args[args.length - 1] as Function;
  cb(null, execFileStdout, "");
});

mock.module("node:child_process", {
  namedExports: {
    execFile: execFileFn,
    spawn: mock.fn(() => ({
      stdout: { on: mock.fn() },
      stderr: { on: mock.fn() },
      stdin: { write: mock.fn(), end: mock.fn() },
      on: mock.fn(),
      kill: mock.fn(),
    })),
  },
});

const writeFileSyncCalls: Array<{ path: string }> = [];
const writeFileSyncFn = mock.fn((p: string) => {
  writeFileSyncCalls.push({ path: String(p) });
});
const fsMock = {
  readFileSync: mock.fn(() => ""),
  writeFileSync: writeFileSyncFn,
  readdirSync: mock.fn(() => [] as any[]),
  mkdirSync: mock.fn(),
  existsSync: mock.fn(() => false),
  statSync: mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false })),
  unlinkSync: mock.fn(),
  renameSync: mock.fn(),
  appendFileSync: mock.fn(),
  openSync: mock.fn(() => 0),
  readSync: mock.fn(() => 0),
  closeSync: mock.fn(),
  createReadStream: mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() })),
  Dirent: class Dirent { name = ""; isFile() { return true; } isDirectory() { return false; } },
  promises: { mkdir: mock.fn(async () => undefined), writeFile: mock.fn(async () => undefined) },
};

mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: {
    readFileSync: fsMock.readFileSync,
    writeFileSync: writeFileSyncFn,
    readdirSync: fsMock.readdirSync,
    mkdirSync: fsMock.mkdirSync,
    existsSync: fsMock.existsSync,
    statSync: fsMock.statSync,
    unlinkSync: fsMock.unlinkSync,
    renameSync: fsMock.renameSync,
    appendFileSync: fsMock.appendFileSync,
    openSync: fsMock.openSync,
    readSync: fsMock.readSync,
    closeSync: fsMock.closeSync,
    createReadStream: fsMock.createReadStream,
    Dirent: fsMock.Dirent,
  },
});

const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;

before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  writeFileSyncCalls.length = 0;
  execFileCalls.length = 0;
  execFileStdout = '{"ok":true,"transfer":{"id":"t-1"}}';
});

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }
          : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (c: Buffer) => { raw += c.toString(); });
        res.on("end", () => {
          try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode!, data: raw }); }
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

describe("Sure mutate payload writer/reader path agreement", () => {
  it("writes the payload into the same /alfred-data dir the runner reads", async () => {
    const { status } = await req("POST", "/api/v1/sure/transfers", {
      source_account_id: "a", destination_account_id: "b", amount: "100", date: "2026-04-30",
    });
    assert.strictEqual(status, 201);

    // The payload write must target /alfred-data (the shared mount), not
    // the old /mnt/encrypted/alfred host path that doesn't exist on the
    // merged stack's ctrl-api container.
    assert.strictEqual(writeFileSyncCalls.length >= 1, true, "expected a payload write");
    const written = writeFileSyncCalls[0].path;
    assert.match(
      written,
      /^\/alfred-data\/\.sure-mutate-[0-9a-f]+\.json$/,
      `payload written to ${written}, expected /alfred-data/.sure-mutate-*.json`,
    );

    // The runner is told to read the container path; the writer dir prefix
    // must equal that container path's dir.
    const runnerArgs = execFileCalls.at(-1)!.args;
    const containerFile = runnerArgs[runnerArgs.length - 1];
    assert.match(containerFile, /^\/alfred-data\/\.sure-mutate-[0-9a-f]+\.json$/);
    assert.strictEqual(
      written,
      containerFile,
      "writer path and runner-read path must be the identical shared-volume path",
    );
  });
});
