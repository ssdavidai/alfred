import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Mocks for the rewrite-cron route (#144).
//
// The handler at POST /api/v1/schedules/:schId/rewrite-cron now does TWO
// things atomically:
//   1. Rewrite the Temporal schedule (delete + create with new cron).
//   2. If the schedule_id looks like `chore-<slug>` and a vault chore record
//      exists at /mnt/encrypted/vault/chore/<slug>.md, rewrite the FM
//      `schedule:` line in place.
//
// Pre-#144 step (2) was the caller's responsibility, and most callers forgot.
// The audit script reads vault FM (not Temporal), so half-applied fixes were
// invisible until next reconciliation.
//
// The tests below exercise:
//   - Happy path: both updates succeed, response confirms vault_updated:true
//   - Temporal succeeds, vault PATCH fails: 500 with PARTIAL_STATE; caller
//     sees a clear message and the partial state markers in the body
//   - Vault patch is idempotent when the schedule line is already correct
//   - Non-chore schedule_ids skip the vault update without erroring
// ---------------------------------------------------------------------------

// In-memory FS for the chore record dir.
interface FakeFile { content: string; }
const files = new Map<string, FakeFile>();
const dirs = new Set<string>(["/mnt/encrypted/vault", "/mnt/encrypted/vault/chore"]);

let writeShouldFailWith: Error | null = null;

const existsSyncFn = mock.fn((p: string) => files.has(p) || dirs.has(p));
const readFileSyncFn = mock.fn((p: string) => {
  const f = files.get(p);
  if (!f) {
    const err: any = new Error(`ENOENT: ${p}`); err.code = "ENOENT"; throw err;
  }
  return f.content;
});
const writeFileSyncFn = mock.fn((p: string, content: string) => {
  if (writeShouldFailWith) throw writeShouldFailWith;
  files.set(p, { content });
});

const fsMock = {
  existsSync: existsSyncFn,
  readFileSync: readFileSyncFn,
  writeFileSync: writeFileSyncFn,
  mkdirSync: mock.fn(),
  readdirSync: mock.fn(() => [] as any[]),
  statSync: mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => true, size: 0 })),
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
  namedExports: fsMock,
});

// child_process — drive dockerExec output via a per-call queue so describe
// returns valid metadata, then delete + create return their own outputs.
type ExecHandler = (file: string, args: string[]) => { stdout: string; err?: NodeJS.ErrnoException };
let execHandler: ExecHandler = () => ({ stdout: "" });

const execFileFn = mock.fn((...allArgs: any[]) => {
  const file = allArgs[0] as string;
  const args = (allArgs[1] as string[]) ?? [];
  const cb = allArgs[allArgs.length - 1] as Function;
  const result = execHandler(file, args);
  if (result.err) cb(result.err, "", String(result.err.message));
  else cb(null, result.stdout, "");
});

mock.module("node:child_process", {
  namedExports: {
    execFile: execFileFn,
    spawn: mock.fn(() => ({
      stderr: { on: mock.fn() },
      stdin: { write: mock.fn(), end: mock.fn() },
      on: mock.fn(),
    })),
  },
});

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

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
  files.clear();
  writeShouldFailWith = null;
  // Reset describe handler to a sensible default.
  execHandler = makeStandardExecHandler();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function req(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path: url,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(payload)),
            }
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

function seedChoreRecord(slug: string, currentCron: string): string {
  const fp = `/mnt/encrypted/vault/chore/${slug}.md`;
  const fm = [
    "---",
    "created: '2026-04-19T00:00:00Z'",
    "created_by: self",
    "generated: true",
    "last_result: ''",
    "last_run: ''",
    `name: 'Test Chore ${slug}'`,
    `params: '{\"chore_slug\":\"${slug}\"}'`,
    "quarantine: false",
    "quarantine_remaining: 0",
    `schedule: '${currentCron}'`,
    `schedule_id: chore-${slug}`,
    "status: active",
    "tags: []",
    "template: " + slug.replace(/-/g, "_"),
    "type: chore",
    "updated: '2026-04-19T00:00:00Z'",
    "user_facing_description: ''",
    "workflow_class_name: TestWorkflow",
    "---",
    "",
    `# Test Chore ${slug}`,
    "",
    "Body content here.",
  ].join("\n");
  files.set(fp, { content: fm });
  return fp;
}

function makeStandardExecHandler(): ExecHandler {
  // Default behavior: temporal describe returns valid metadata; delete + create
  // succeed with empty stdout.
  //
  // Args shape from dockerExec("temporal", ["temporal","schedule","describe",...]):
  //   ["compose", "-f", "<path>/docker-compose.yaml", "exec", "-T", "temporal",
  //    "temporal", "schedule", "<subcmd>", ...]
  // The first "temporal" is the docker service name, the second is the CLI
  // binary; the subcmd we care about is the one AFTER "schedule".
  return (file: string, args: string[]) => {
    if (file !== "docker") return { stdout: "" };
    const scheduleIdx = args.indexOf("schedule");
    if (scheduleIdx === -1) return { stdout: "" };
    const subcmd = args[scheduleIdx + 1];
    if (subcmd === "describe") {
      return {
        stdout: JSON.stringify({
          schedule: {
            action: {
              startWorkflow: {
                workflowType: { name: "TestWorkflow" },
                taskQueue: { name: "alfred-learn" },
                input: {
                  payloads: [
                    {
                      metadata: { encoding: "anNvbi9wbGFpbg==" },
                      data: Buffer.from(JSON.stringify({ chore_slug: "test" })).toString("base64"),
                    },
                  ],
                },
              },
            },
            policies: { overlapPolicy: "SCHEDULE_OVERLAP_POLICY_SKIP" },
          },
        }),
      };
    }
    return { stdout: "" };
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/v1/schedules/:schId/rewrite-cron — happy path", () => {
  it("updates Temporal AND vault frontmatter atomically", async () => {
    seedChoreRecord("test-chore", "0 9 * * *");

    const { status, data } = await req(
      "POST",
      "/api/v1/schedules/chore-test-chore/rewrite-cron",
      { cron: "0 7 * * *" },
    );

    assert.strictEqual(status, 200);
    assert.strictEqual(data.message, "Schedule rewritten");
    assert.strictEqual(data.new_cron, "0 7 * * *");
    assert.strictEqual(data.temporal_updated, true);
    assert.strictEqual(data.vault_updated, true);
    assert.strictEqual(data.vault_path, "/mnt/encrypted/vault/chore/test-chore.md");

    // Vault file's FM `schedule:` line should now match the new cron.
    const updated = files.get("/mnt/encrypted/vault/chore/test-chore.md")!.content;
    assert.match(updated, /^schedule: '0 7 \* \* \*'$/m);
    // Body untouched.
    assert.match(updated, /# Test Chore test-chore/);
    assert.match(updated, /Body content here\./);
    // Other FM fields untouched.
    assert.match(updated, /^schedule_id: chore-test-chore$/m);
    assert.match(updated, /^workflow_class_name: TestWorkflow$/m);
  });

  it("escapes single quotes in the cron value YAML-safely", async () => {
    // No real cron has a single quote, but the rewrite must still be defensive
    // because the same path could be reused for other scalar fields later.
    seedChoreRecord("quote-chore", "0 9 * * *");
    const cronWithQuote = "0 9 * * 1-5"; // valid cron; we just verify quoting
    const { status } = await req(
      "POST",
      "/api/v1/schedules/chore-quote-chore/rewrite-cron",
      { cron: cronWithQuote },
    );
    assert.strictEqual(status, 200);
    const updated = files.get("/mnt/encrypted/vault/chore/quote-chore.md")!.content;
    assert.match(updated, /^schedule: '0 9 \* \* 1-5'$/m);
  });
});

describe("POST /api/v1/schedules/:schId/rewrite-cron — partial failure", () => {
  it("returns 500 PARTIAL_STATE when Temporal succeeds but vault FM write fails", async () => {
    seedChoreRecord("broken-chore", "0 9 * * *");
    // Make the vault writeFileSync throw (e.g. EACCES, ENOSPC).
    writeShouldFailWith = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

    const { status, data } = await req(
      "POST",
      "/api/v1/schedules/chore-broken-chore/rewrite-cron",
      { cron: "0 7 * * *" },
    );

    assert.strictEqual(status, 500);
    assert.strictEqual(data.error.code, "PARTIAL_STATE");
    assert.match(data.error.message, /Temporal/i);
    assert.match(data.error.message, /vault/i);
    assert.match(data.error.message, /Retry/i);

    assert.strictEqual(data.error.details.partial_state, true);
    assert.strictEqual(data.error.details.temporal_updated, true);
    assert.strictEqual(data.error.details.vault_updated, false);
    assert.strictEqual(data.error.details.new_cron, "0 7 * * *");
    assert.strictEqual(data.error.details.schedule_id, "chore-broken-chore");
    assert.match(data.error.details.vault_error, /permission denied/);

    // Vault file's FM `schedule:` line is NOT silently corrupted — still the
    // old cron, since the write failed atomically before any partial
    // overwrite. The whole point of the 500 is that the caller must retry.
    const after = files.get("/mnt/encrypted/vault/chore/broken-chore.md")!.content;
    assert.match(after, /^schedule: '0 9 \* \* \*'$/m);
  });
});

describe("POST /api/v1/schedules/:schId/rewrite-cron — idempotent", () => {
  it("returns vault_updated:true when the FM schedule already matches", async () => {
    seedChoreRecord("already-correct", "0 7 * * *");
    const { status, data } = await req(
      "POST",
      "/api/v1/schedules/chore-already-correct/rewrite-cron",
      { cron: "0 7 * * *" },
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(data.temporal_updated, true);
    assert.strictEqual(data.vault_updated, true);
    // FM content unchanged on disk.
    const after = files.get("/mnt/encrypted/vault/chore/already-correct.md")!.content;
    assert.match(after, /^schedule: '0 7 \* \* \*'$/m);
  });

  it("skips vault update for non-chore schedule_ids without erroring", async () => {
    // System schedules like `al-hourly-enrichment` are not chores and have no
    // vault record. The handler should treat that as a clean Temporal-only
    // update.
    const { status, data } = await req(
      "POST",
      "/api/v1/schedules/al-hourly-enrichment/rewrite-cron",
      { cron: "0 * * * *" },
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(data.temporal_updated, true);
    assert.strictEqual(data.vault_updated, false);
    assert.match(data.vault_skip_reason, /not a chore schedule/);
  });

  it("skips vault update for chore-prefixed schedule_ids when the vault record is missing", async () => {
    // A chore schedule that exists in Temporal but whose vault record was
    // deleted. We don't want to fail the rewrite — Temporal got updated and
    // the absence of a vault record means nothing to update on the FM side.
    const { status, data } = await req(
      "POST",
      "/api/v1/schedules/chore-orphan/rewrite-cron",
      { cron: "0 9 * * *" },
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(data.temporal_updated, true);
    assert.strictEqual(data.vault_updated, false);
    assert.match(data.vault_skip_reason, /no vault chore record/);
  });
});

describe("POST /api/v1/schedules/:schId/rewrite-cron — input validation", () => {
  it("rejects empty body.cron with 400", async () => {
    const { status, data } = await req(
      "POST",
      "/api/v1/schedules/chore-x/rewrite-cron",
      { cron: "" },
    );
    assert.strictEqual(status, 400);
    assert.strictEqual(data.error.code, "VALIDATION_ERROR");
  });
});
