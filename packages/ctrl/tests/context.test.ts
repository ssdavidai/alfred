import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Mocks must register BEFORE the route module is imported.
// The cross-channel context endpoint walks vault directories with
// fs.readdirSync + fs.statSync + fs.readFileSync, so the fs shim has to
// model an in-memory vault.
// ---------------------------------------------------------------------------

const execFileFn = mock.fn((...args: any[]) => {
  const cb = args[args.length - 1] as Function;
  cb(null, '{"ok":true}', "");
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

const VAULT_PATH = "/mnt/encrypted/vault";
// Use real wall-clock for mtimes so they slot inside the route's
// ``now - lookback_hours`` window. The route reads ``Date.now()`` at
// request time; mocking the clock would require patching globalThis.Date
// or temporal hooks, neither of which is needed here.
const NOW_MS = Date.now();

interface FakeFile {
  content: string;
  mtimeMs: number;
}

// dir → list of {name, isFile, isDir}
const dirs: Map<string, Array<{ name: string; isDir: boolean }>> = new Map();
const files: Map<string, FakeFile> = new Map();

function placeFile(relPath: string, content: string, mtimeMs: number): void {
  const full = path.join(VAULT_PATH, relPath);
  files.set(full, { content, mtimeMs });
  // Add to all parent dir indexes.
  let cur = full;
  while (true) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    const childName = path.basename(cur);
    const isDir = files.has(cur) ? false : true;
    const list = dirs.get(parent) ?? [];
    if (!list.find((e) => e.name === childName)) {
      list.push({ name: childName, isDir });
      dirs.set(parent, list);
    }
    cur = parent;
    if (parent === VAULT_PATH || parent === "/") break;
  }
}

const readdirSyncFn = mock.fn((dir: string, opts?: any) => {
  const list = dirs.get(dir) ?? [];
  if (opts?.withFileTypes) {
    return list.map((e) => ({
      name: e.name,
      isFile: () => !e.isDir,
      isDirectory: () => e.isDir,
    }));
  }
  return list.map((e) => e.name);
});

const statSyncFn = mock.fn((p: string) => {
  if (files.has(p)) {
    const f = files.get(p)!;
    return {
      mtimeMs: f.mtimeMs,
      size: f.content.length,
      isFile: () => true,
      isDirectory: () => false,
    };
  }
  if (dirs.has(p)) {
    return {
      mtimeMs: 0,
      size: 0,
      isFile: () => false,
      isDirectory: () => true,
    };
  }
  const err: NodeJS.ErrnoException = new Error(`ENOENT: ${p}`);
  err.code = "ENOENT";
  throw err;
});

const readFileSyncFn = mock.fn((p: string) => {
  if (files.has(p)) return files.get(p)!.content;
  const err: NodeJS.ErrnoException = new Error(`ENOENT: ${p}`);
  err.code = "ENOENT";
  throw err;
});

const writeFileSyncFn = mock.fn();
const existsSyncFn = mock.fn((p: string) => files.has(p) || dirs.has(p));
const renameSyncFn = mock.fn();
const appendFileSyncFn = mock.fn();
const mkdirSyncFn = mock.fn();
const unlinkSyncFn = mock.fn();
const openSyncFn = mock.fn(() => 0);
const readSyncFn = mock.fn(() => 0);
const closeSyncFn = mock.fn();
const createReadStreamFn = mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() }));
const mkdirFn = mock.fn(async () => undefined);
const writeFileFn = mock.fn(async () => undefined);

const fsMock = {
  readFileSync: readFileSyncFn,
  writeFileSync: writeFileSyncFn,
  readdirSync: readdirSyncFn,
  mkdirSync: mkdirSyncFn,
  existsSync: existsSyncFn,
  statSync: statSyncFn,
  unlinkSync: unlinkSyncFn,
  renameSync: renameSyncFn,
  appendFileSync: appendFileSyncFn,
  openSync: openSyncFn,
  readSync: readSyncFn,
  closeSync: closeSyncFn,
  createReadStream: createReadStreamFn,
  Dirent: class Dirent {
    name = "";
    isFile() { return true; }
    isDirectory() { return false; }
  },
  promises: { mkdir: mkdirFn, writeFile: writeFileFn },
};

mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: {
    readFileSync: readFileSyncFn,
    writeFileSync: writeFileSyncFn,
    readdirSync: readdirSyncFn,
    mkdirSync: mkdirSyncFn,
    existsSync: existsSyncFn,
    statSync: statSyncFn,
    unlinkSync: unlinkSyncFn,
    renameSync: renameSyncFn,
    appendFileSync: appendFileSyncFn,
    openSync: openSyncFn,
    readSync: readSyncFn,
    closeSync: closeSyncFn,
    createReadStream: createReadStreamFn,
    Dirent: class Dirent {
      name = "";
      isFile() { return true; }
      isDirectory() { return false; }
    },
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
  dirs.clear();
  files.clear();
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

// Helper: build a vault record string with frontmatter + body.
function record(fm: Record<string, string | number>, body: string): string {
  const fmLines = Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v}"` : v}`)
    .join("\n");
  return `---\n${fmLines}\n---\n\n${body}`;
}

// ===========================================================================
// POST /api/v1/context/cross-channel
// ===========================================================================

describe("POST /api/v1/context/cross-channel", () => {
  it("returns the default-channel summary with grouped counts and entities", async () => {
    const recent = NOW_MS - 1000 * 60 * 60; // 1h ago
    const old = NOW_MS - 1000 * 60 * 60 * 48; // 48h ago — outside default 24h lookback

    placeFile(
      "event/2026-04-25-slackthing.md",
      record(
        { type: "event", stream_type: "slack", thread_ts: "T1", summary: "Sir asked about Galerius" },
        "Sir asked about [[matter/galerius-furdo]] and pinged [[person/Boris]].",
      ),
      recent,
    );
    placeFile(
      "event/2026-04-25-slackthing-2.md",
      record(
        { type: "event", stream_type: "slack-message", thread_ts: "T2", summary: "follow-up" },
        "Follow-up about [[matter/favo]].",
      ),
      recent,
    );
    placeFile(
      "event/2026-04-25-planecomment.md",
      record(
        { type: "event", stream_type: "plane-comment", summary: "alfred replied on issue" },
        "Reply on [[matter/galerius-furdo]] referencing [[person/Taylor Herke]].",
      ),
      recent,
    );
    placeFile(
      "event/2026-04-25-email.md",
      record(
        { type: "event", stream_type: "agentmail", subject: "Q3 update", name: "Q3 update" },
        "Email body referencing [[person/Boris]].",
      ),
      recent,
    );
    placeFile(
      "session/voice-1.md",
      record(
        { type: "session", stream_type: "voice-call", duration_seconds: 600, summary: "Call with Sir" },
        "[[person/Taylor Herke]]",
      ),
      recent,
    );
    placeFile(
      "conversation/sms-thread-1.md",
      record(
        { type: "conversation", stream_type: "sms-inbound", thread_key: "T-sms-1", summary: "I'll be late" },
        "",
      ),
      recent,
    );
    // OLD record — must NOT count toward 24h default
    placeFile(
      "event/2026-04-23-old.md",
      record(
        { type: "event", stream_type: "slack", summary: "old chatter" },
        "[[matter/should-not-show]]",
      ),
      old,
    );
    // Untyped (no stream_type) — must be ignored
    placeFile(
      "event/2026-04-25-untyped.md",
      record({ type: "event", summary: "no stream type" }, "ignored"),
      recent,
    );

    const { status, data } = await req("POST", "/api/v1/context/cross-channel", {
      lookback_hours: 24,
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.lookback_hours, 24);
    assert.ok(data.now);

    // Channels populated as expected
    assert.strictEqual(data.channels.slack.count, 2);
    assert.strictEqual(data.channels.slack.thread_count, 2);
    assert.strictEqual(data.channels.plane.count, 1);
    assert.strictEqual(data.channels.email.count, 1);
    assert.deepStrictEqual(data.channels.email.subjects, ["Q3 update"]);
    assert.strictEqual(data.channels.voice.count, 1);
    assert.strictEqual(data.channels.voice.duration_minutes, 10);
    assert.strictEqual(data.channels.sms.count, 1);
    assert.strictEqual(data.channels.sms.thread_count, 1);
    assert.strictEqual(data.channels.omi.count, 0);

    // Active matters / persons collected via wikilinks, OLD record's
    // matter must NOT appear.
    assert.ok(data.active_matters.includes("matter/galerius-furdo.md"));
    assert.ok(data.active_matters.includes("matter/favo.md"));
    assert.ok(!data.active_matters.includes("matter/should-not-show.md"));
    assert.ok(data.active_persons.includes("person/Boris.md"));
    assert.ok(data.active_persons.includes("person/Taylor Herke.md"));

    // Caps echoed in the response so the agent knows when truncation
    // may have occurred.
    assert.strictEqual(data.truncated.per_channel_cap, 50);
    assert.strictEqual(data.truncated.entity_cap, 25);
  });

  it("respects the channels filter and skips unrequested buckets", async () => {
    const recent = NOW_MS - 1000 * 60 * 60;
    placeFile(
      "event/slack-1.md",
      record({ type: "event", stream_type: "slack", summary: "x" }, ""),
      recent,
    );
    placeFile(
      "event/email-1.md",
      record({ type: "event", stream_type: "agentmail", subject: "x" }, ""),
      recent,
    );

    const { status, data } = await req("POST", "/api/v1/context/cross-channel", {
      channels: ["plane"],
    });
    assert.strictEqual(status, 200);
    // Only plane bucket present
    assert.deepStrictEqual(Object.keys(data.channels), ["plane"]);
    assert.strictEqual(data.channels.plane.count, 0);
  });

  it("caps each channel summaries at 50 items even when 100 records are present", async () => {
    const recent = NOW_MS - 1000 * 60 * 30;
    for (let i = 0; i < 100; i++) {
      placeFile(
        `event/slack-${String(i).padStart(3, "0")}.md`,
        record(
          { type: "event", stream_type: "slack", summary: `msg ${i}` },
          "",
        ),
        recent + i, // distinct mtimes so the sort is deterministic
      );
    }
    const { status, data } = await req("POST", "/api/v1/context/cross-channel", {});
    assert.strictEqual(status, 200);
    assert.strictEqual(data.channels.slack.count, 100);
    assert.strictEqual(data.channels.slack.summaries.length, 50);
    // Newest first — so the FIRST item should be the highest-numbered msg.
    assert.ok(data.channels.slack.summaries[0].summary.includes("msg 99"));
  });

  it("rejects a non-positive lookback_hours", async () => {
    const { status, data } = await req("POST", "/api/v1/context/cross-channel", {
      lookback_hours: 0,
    });
    assert.strictEqual(status, 400);
    assert.ok(String(data.error?.message ?? "").includes("lookback_hours"));
  });

  it("rejects a non-array channels value", async () => {
    const { status, data } = await req("POST", "/api/v1/context/cross-channel", {
      channels: "slack",
    });
    assert.strictEqual(status, 400);
    assert.ok(String(data.error?.message ?? "").includes("channels"));
  });

  it("returns empty buckets when the vault is empty (no scanned dirs)", async () => {
    const { status, data } = await req("POST", "/api/v1/context/cross-channel", {});
    assert.strictEqual(status, 200);
    assert.strictEqual(data.channels.slack.count, 0);
    assert.deepStrictEqual(data.active_matters, []);
    assert.deepStrictEqual(data.active_persons, []);
  });

  it("clamps lookback_hours above the 30-day cap", async () => {
    const { status, data } = await req("POST", "/api/v1/context/cross-channel", {
      lookback_hours: 99999,
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.lookback_hours, 24 * 30);
  });
});
