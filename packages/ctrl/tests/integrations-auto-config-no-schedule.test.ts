// Tests for /api/v1/integrations/:id/auto-config — stream-config-only path (#53).
//
// Background:
//   Before #53, auto-config ensured one Temporal schedule per stream
//   (`al-stream-pull-composio-<streamId.slice(0,20)>`) and ran a
//   describe/delete/recreate dance to heal a schedule whose encoded
//   `stream_id` had gone stale (NOTION_LIST_PAGES → NOTION_FETCH_DATA etc.).
//
//   Issue #53 collapsed the per-stream `al-stream-pull-*` schedules into a
//   single `al-stream-sweep` schedule (StreamSweepWorkflow) registered once
//   by alfred-learn. The sweep reads every stream config by id on each tick,
//   so auto-config no longer creates, deletes, or describes any Temporal
//   schedule — it just writes the stream config file. The stale-schedule
//   failure mode (and `describeScheduleStreamId`) no longer exists.
//
// Coverage:
//   - auto-config writes the recommended stream config
//   - auto-config makes NO `al-stream-pull-*` schedule call at all
//   - re-running auto-config is idempotent and still creates no schedule

import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Mocked Composio backend (single-toolkit fixture, ACTIVE Notion connection)
// ---------------------------------------------------------------------------

type FakeConn = {
  id: string;
  toolkit: { slug: string };
  user_id: string;
  member_id?: string;
  status: string;
  appName?: string;
};

const composioConns: Map<string, FakeConn> = new Map();

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();

  if (method === "GET" && /\/api\/v3\/connected_accounts(?:\?|$)/.test(u)) {
    const parsed = new URL(u);
    const filterUid = parsed.searchParams.get("user_id");
    const items = [...composioConns.values()].filter(
      (c) => !filterUid || c.user_id === filterUid,
    );
    return new Response(
      JSON.stringify({ items, next_cursor: null }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  const getMatch = u.match(/\/api\/v3\/connected_accounts\/([^?/]+)$/);
  if (method === "GET" && getMatch) {
    const id = decodeURIComponent(getMatch[1]);
    const conn = composioConns.get(id);
    if (!conn) return new Response("Not found", { status: 404 });
    return new Response(JSON.stringify(conn), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // Skill generation — return a tiny action set so generateComposioSkill
  // doesn't blow up.
  if (method === "GET" && u.includes("/api/v2/actions")) {
    return new Response(
      JSON.stringify({ items: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ error: "unmocked", url: u, method }),
    { status: 501 },
  );
}) as typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Mocked filesystem (same in-memory shape as integrations-disconnect.test.ts)
// ---------------------------------------------------------------------------

const memFs: Map<string, string> = new Map();
const memDirs: Set<string> = new Set();

function ensureParentDirs(p: string): void {
  const parts = p.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts.slice(0, -1)) {
    cur += `/${part}`;
    memDirs.add(cur);
  }
}

function listChildren(dir: string): string[] {
  const norm = dir.replace(/\/+$/, "");
  const childSet = new Set<string>();
  for (const f of memFs.keys()) {
    if (f.startsWith(`${norm}/`)) {
      const rest = f.slice(norm.length + 1);
      const top = rest.split("/")[0];
      if (top) childSet.add(top);
    }
  }
  for (const d of memDirs) {
    if (d.startsWith(`${norm}/`)) {
      const rest = d.slice(norm.length + 1);
      const top = rest.split("/")[0];
      if (top) childSet.add(top);
    }
  }
  return [...childSet];
}

const fsMock = {
  existsSync: mock.fn((p: string) => memFs.has(p) || memDirs.has(p)),
  readFileSync: mock.fn((p: string) => {
    if (!memFs.has(p)) {
      const err = new Error(`ENOENT: no such file or directory, open '${p}'`) as any;
      err.code = "ENOENT";
      throw err;
    }
    return memFs.get(p)!;
  }),
  writeFileSync: mock.fn((p: string, data: any) => {
    ensureParentDirs(p);
    memFs.set(p, typeof data === "string" ? data : String(data));
  }),
  mkdirSync: mock.fn((p: string) => {
    ensureParentDirs(p + "/x");
    memDirs.add(p);
  }),
  readdirSync: mock.fn((p: string) => listChildren(p)),
  statSync: mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false })),
  unlinkSync: mock.fn((p: string) => { memFs.delete(p); }),
  renameSync: mock.fn((from: string, to: string) => {
    if (memFs.has(from)) {
      memFs.set(to, memFs.get(from)!);
      memFs.delete(from);
    }
  }),
  appendFileSync: mock.fn(),
  rmSync: mock.fn((p: string) => {
    memFs.delete(p);
    memDirs.delete(p);
    for (const f of [...memFs.keys()]) {
      if (f.startsWith(`${p}/`)) memFs.delete(f);
    }
    for (const d of [...memDirs]) {
      if (d.startsWith(`${p}/`)) memDirs.delete(d);
    }
  }),
  chownSync: mock.fn(),
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
    writeFileSync: fsMock.writeFileSync,
    readdirSync: fsMock.readdirSync,
    mkdirSync: fsMock.mkdirSync,
    existsSync: fsMock.existsSync,
    statSync: fsMock.statSync,
    unlinkSync: fsMock.unlinkSync,
    renameSync: fsMock.renameSync,
    appendFileSync: fsMock.appendFileSync,
    rmSync: fsMock.rmSync,
    chownSync: fsMock.chownSync,
    openSync: fsMock.openSync,
    readSync: fsMock.readSync,
    closeSync: fsMock.closeSync,
    createReadStream: fsMock.createReadStream,
    Dirent: fsMock.Dirent,
  },
});

// ---------------------------------------------------------------------------
// Mocked child_process — captures every `temporal schedule ...` call so we
// can both script `describe` outputs and assert on what create/delete the
// route attempted.
// ---------------------------------------------------------------------------

interface TemporalCall {
  verb: string; // "describe" | "create" | "delete" | other
  scheduleId?: string;
  input?: string; // value passed to --input
  args: string[];
}

const temporalCalls: TemporalCall[] = [];

// The describe responder is configurable per-test. Returning `null` makes the
// CLI exit non-zero (mimicking "no such schedule"), otherwise the string is
// emitted on stdout.
let describeResponder: (scheduleId: string) => string | null = () => null;

mock.module("node:child_process", {
  namedExports: {
    execFile: mock.fn((...callArgs: any[]) => {
      // execFile signature: (cmd, args, options, callback)
      const cmd = callArgs[0] as string;
      const args = (callArgs[1] ?? []) as string[];
      const cb = callArgs[callArgs.length - 1] as Function;

      // dockerExec composes: docker compose -f <path> exec -T <service> <command...>
      // Find the service name + the actual subcommand.
      if (cmd === "docker" && args[0] === "compose" && args.includes("exec")) {
        const execIdx = args.indexOf("exec");
        // args after "exec" are: [-e KEY=VAL]* [-T] <service> <command...>
        let i = execIdx + 1;
        while (i < args.length && (args[i] === "-e" || args[i] === "-T")) {
          if (args[i] === "-e") i += 2;
          else i += 1;
        }
        const service = args[i];
        const subArgs = args.slice(i + 1);
        if (service === "temporal" && subArgs[0] === "temporal" && subArgs[1] === "schedule") {
          const verb = subArgs[2];
          const idIdx = subArgs.indexOf("--schedule-id");
          const inputIdx = subArgs.indexOf("--input");
          const call: TemporalCall = {
            verb,
            scheduleId: idIdx >= 0 ? subArgs[idIdx + 1] : undefined,
            input: inputIdx >= 0 ? subArgs[inputIdx + 1] : undefined,
            args: subArgs,
          };
          temporalCalls.push(call);

          if (verb === "describe" && call.scheduleId) {
            const resp = describeResponder(call.scheduleId);
            if (resp == null) {
              const err = new Error("temporal CLI: schedule not found") as any;
              err.code = 1;
              cb(err, "", "Schedule not found");
              return;
            }
            cb(null, resp, "");
            return;
          }

          // create / delete / other → pretend success.
          cb(null, "{}", "");
          return;
        }
      }

      // Default: succeed silently.
      cb(null, "{}", "");
    }),
    spawn: mock.fn(() => ({
      stderr: { on: mock.fn() },
      stdin: { write: mock.fn(), end: mock.fn() },
      on: mock.fn(),
    })),
  },
});

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

process.env.COMPOSIO_API_KEY = "test-composio-key";
process.env.COMPOSIO_USER_ID = "alfred-test-user";
// Pin the data dir so the in-memory fs assertions know the config path.
// (integrations.ts derives STREAM_CONFIGS_DIR from ALFRED_DATA_DIR at
// module-load time, so this must be set before the import below.)
process.env.ALFRED_DATA_DIR = "/alfred-data";

await import("../src/api/routes/integrations.js");
const { createApiServer } = await import("../src/api/server.js");

const STREAM_CONFIGS_DIR = `${process.env.ALFRED_DATA_DIR}/streams/configs`;

let server: http.Server;

before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  composioConns.clear();
  memFs.clear();
  memDirs.clear();
  temporalCalls.length = 0;
  describeResponder = () => null;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function req(method: string, pathname: string, body?: unknown): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path: pathname,
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

function seedConn(opts: { id: string; toolkit: string; status?: string }): void {
  composioConns.set(opts.id, {
    id: opts.id,
    toolkit: { slug: opts.toolkit },
    user_id: "alfred-test-user",
    member_id: "alfred-test-user",
    status: opts.status ?? "ACTIVE",
  });
}

/**
 * Build a Temporal `schedule describe --output json` response that encodes
 * `{stream_id}` as the workflow's first input payload — same envelope shape
 * the production CLI emits.
 */
function describeJson(streamId: string): string {
  const data = Buffer.from(JSON.stringify({ stream_id: streamId }), "utf-8").toString("base64");
  return JSON.stringify({
    schedule: { action: { startWorkflow: { input: { payloads: [{ data }] } } } },
  });
}

// ---------------------------------------------------------------------------
// auto-config — stream-config-only (no per-stream schedule, #53)
// ---------------------------------------------------------------------------

describe("auto-config — writes stream config, creates no schedule (#53)", () => {
  it("writes the recommended stream config and reports stream_created", async () => {
    seedConn({ id: "ca_notion", toolkit: "notion" });

    const { status, data } = await req(
      "POST",
      "/api/v1/integrations/ca_notion/auto-config",
    );

    assert.strictEqual(status, 200, `expected 200, got ${status} (${JSON.stringify(data)})`);
    const expectedStreamId = "composio-notion-notion-fetch-data";
    assert.strictEqual(data.stream_created, expectedStreamId);

    // The stream config file must have been written so the al-stream-sweep
    // schedule can pick it up on its next tick.
    const configPath = `${STREAM_CONFIGS_DIR}/${expectedStreamId}.json`;
    assert.ok(memFs.has(configPath), "stream config file should be written");
    const cfg = JSON.parse(memFs.get(configPath)!);
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.composio_action, "NOTION_FETCH_DATA");
    assert.strictEqual(typeof cfg.schedule_interval_seconds, "number");
  });

  it("makes NO al-stream-pull-* Temporal schedule call", async () => {
    seedConn({ id: "ca_notion", toolkit: "notion" });

    await req("POST", "/api/v1/integrations/ca_notion/auto-config");

    // #53: ctrl-api no longer creates/deletes/describes per-stream
    // schedules. The single al-stream-sweep schedule (owned by
    // alfred-learn's register_schedules) drives all streams.
    const scheduleCalls = temporalCalls.filter(
      (c) =>
        c.verb === "create" ||
        c.verb === "delete" ||
        c.verb === "describe",
    );
    assert.strictEqual(
      scheduleCalls.length,
      0,
      `auto-config must make no schedule calls — got ${JSON.stringify(scheduleCalls)}`,
    );
    // Belt-and-braces: nothing should reference the legacy id prefix.
    const legacy = temporalCalls.filter((c) =>
      (c.scheduleId ?? "").startsWith("al-stream-pull-"),
    );
    assert.strictEqual(legacy.length, 0, "no al-stream-pull-* schedule id touched");

    // The summary no longer carries schedule_* fields.
    // (stream_created is still reported for the reconciler.)
  });

  it("is idempotent on re-run and still creates no schedule", async () => {
    seedConn({ id: "ca_notion", toolkit: "notion" });

    const first = await req("POST", "/api/v1/integrations/ca_notion/auto-config");
    assert.strictEqual(first.status, 200);
    temporalCalls.length = 0;

    const second = await req("POST", "/api/v1/integrations/ca_notion/auto-config");
    assert.strictEqual(second.status, 200);
    assert.strictEqual(
      second.data.stream_created,
      "composio-notion-notion-fetch-data",
    );

    const scheduleCalls = temporalCalls.filter(
      (c) => c.verb === "create" || c.verb === "delete" || c.verb === "describe",
    );
    assert.strictEqual(scheduleCalls.length, 0, "re-run makes no schedule calls");
  });
});
