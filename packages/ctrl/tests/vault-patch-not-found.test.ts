import { mock, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// PATCH /api/v1/vault/records/* — missing-record error mapping.
//
// The set/append/body_append branch shells out to `alfred vault edit` via
// dockerExec. When the target record does not exist the alfred CLI exits
// non-zero, and the raw ExecError used to bubble up as a misleading HTTP 500
// (noisy `PATCH …/chore/<x>.md → 500` logs from callers that legitimately
// update an absent record, e.g. the briefing chore-run recorder which already
// tolerates the failure). A missing record is "not found", not a server
// error — the handler must downgrade it to 404 NOT_FOUND, while a genuine
// edit failure on a record that DOES exist (schema error, lock contention)
// must still surface as 500. The discriminator is whether the file exists on
// disk after the failed CLI run.
// ---------------------------------------------------------------------------

// Configurable execFile mock: "ok" → success; "fail" → non-zero exit (the
// shape execFile produces, which execAsync rejects as an ExecError).
type ExecMode = "ok" | "fail";
let execMode: ExecMode = "ok";
let execStdoutOnSuccess = '{"updated":true}';

const execFileFn = mock.fn((...args: any[]) => {
  const cb = args[args.length - 1] as (
    err: (Error & { status?: number }) | null,
    stdout: string,
    stderr: string,
  ) => void;
  if (execMode === "ok") {
    cb(null, execStdoutOnSuccess, "");
    return;
  }
  const err = new Error("Command failed: docker compose exec ... alfred vault edit ...") as Error & {
    status?: number;
  };
  err.status = 1;
  // The alfred CLI reports a missing file on stderr with a non-zero exit.
  cb(err, "", "Error: record not found: chore/nope.md\n");
});

mock.module("node:child_process", {
  namedExports: {
    execFile: execFileFn,
    // execFileSync needed by src/api/routes/system.ts (ssh-keygen, unused here).
    execFileSync: mock.fn(() => ""),
    spawn: mock.fn(() => ({
      stderr: { on: mock.fn() },
      stdin: { write: mock.fn(), end: mock.fn() },
      on: mock.fn(),
    })),
  },
});

// Configurable fs.existsSync drives the missing-vs-present discriminator the
// catch block uses. Default false (record absent → 404). All other fs surface
// is no-op so the server boots and route registration doesn't fault.
let fileExists = false;
const existsSyncFn = mock.fn(() => fileExists);

const fsMock = {
  readFileSync: mock.fn(() => ""),
  writeFileSync: mock.fn(() => {}),
  readdirSync: mock.fn(() => [] as any[]),
  mkdirSync: mock.fn(),
  existsSync: existsSyncFn,
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
mock.module("node:fs", { defaultExport: fsMock, namedExports: fsMock });

const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;
before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
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
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
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

describe("PATCH /api/v1/vault/records/* — missing-record error mapping", () => {
  it("maps a failed `set` edit on an absent record to 404 NOT_FOUND (not 500)", async () => {
    execMode = "fail";
    fileExists = false; // CLI failed AND the file is not on disk → missing record
    const { status, data } = await req(
      "PATCH",
      "/api/v1/vault/records/chore/nonexistent.md",
      { set: { status: "done" } },
    );
    assert.strictEqual(status, 404, "missing record must be 404, not a misleading 500");
    assert.strictEqual(data.error.code, "NOT_FOUND");
    assert.ok(
      String(data.error.message).includes("chore/nonexistent.md"),
      `error message should name the record; got: ${data.error.message}`,
    );
  });

  it("keeps 500 EXEC_ERROR for a genuine edit failure on an existing record", async () => {
    execMode = "fail";
    fileExists = true; // CLI failed but the file IS present → real edit failure
    const { status, data } = await req(
      "PATCH",
      "/api/v1/vault/records/chore/present.md",
      { set: { status: "done" } },
    );
    assert.strictEqual(status, 500, "a real edit failure on an existing record stays 500");
    assert.strictEqual(data.error.code, "EXEC_ERROR");
  });

  it("still PATCHes an existing record successfully (no regression)", async () => {
    execMode = "ok";
    fileExists = true;
    execStdoutOnSuccess = '{"updated":true}';
    const { status, data } = await req(
      "PATCH",
      "/api/v1/vault/records/chore/present.md",
      { set: { status: "active" } },
    );
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data, { updated: true });
  });
});
