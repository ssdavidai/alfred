// Tests for the stale-schedule recovery in /api/v1/integrations/:id/auto-config
// (Defect B in fix/composio-auto-config-on-callback-and-stale-schedule).
//
// Background:
//   When a tenant's Composio toolkit gets auto-configured, the route ensures a
//   Temporal schedule named `al-stream-pull-composio-<streamId.slice(0,20)>`
//   exists for the recommended stream. The legacy implementation treated
//   "AlreadyExists" as success, which left tenants firing forever against a
//   stale schedule whose encoded `stream_id` pointed at a Composio action that
//   no longer exists (e.g. NOTION_LIST_PAGES → NOTION_FETCH_DATA, where the
//   OLD streamId `composio-notion-notion-list-pages` truncates to a different
//   slice(0,20) than the NEW one — but for actions whose first 20 chars match,
//   the schedule is reused and stays stale).
//
// Coverage:
//   - Existing schedule with current stream_id → skipped (no delete + create)
//   - Existing schedule with stale stream_id → deleted + recreated
//   - No existing schedule → created normally
//   - Describe returns AlreadyExists race → caller handles gracefully

import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import yaml from "js-yaml";
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

const integrationsModule = await import("../src/api/routes/integrations.js");
const { createApiServer } = await import("../src/api/server.js");

const OPENCLAW_CONFIG_PATH = "/hermes-data/main/config.yaml";
const STREAM_CONFIGS_DIR = "/mnt/encrypted/alfred/streams/configs";

let server: http.Server;

before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  integrationsModule.flushPendingOpenclawWrites();
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

// Hermes profile config is YAML with a `tools.enabled` list.
function seedOpenclawConfig(allow: string[]): void {
  const cfg = yaml.dump({ tools: { enabled: allow } });
  memFs.set(OPENCLAW_CONFIG_PATH, cfg);
  memFs.set("/hermes-data/workers/config.yaml", cfg);
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
// Defect B — auto-config swaps stale schedules
// ---------------------------------------------------------------------------

describe("auto-config — schedule freshness check (Defect B)", () => {
  it("creates a new schedule when none exists", async () => {
    seedConn({ id: "ca_notion", toolkit: "notion" });
    seedOpenclawConfig(["sessions_send"]);
    // describeResponder returns null → describe fails → exists: false.

    const { status, data } = await req(
      "POST",
      "/api/v1/integrations/ca_notion/auto-config",
    );
    integrationsModule.flushPendingOpenclawWrites();

    assert.strictEqual(status, 200, `expected 200, got ${status} (${JSON.stringify(data)})`);
    const expectedStreamId = "composio-notion-notion-fetch-data";
    assert.strictEqual(data.stream_created, expectedStreamId);
    assert.ok(
      typeof data.schedule_created === "string" && !data.schedule_created.includes("already exists"),
      "fresh create — schedule_created should NOT have the (already exists) suffix",
    );

    const creates = temporalCalls.filter((c) => c.verb === "create");
    assert.strictEqual(creates.length, 1, "exactly one create call");
    assert.strictEqual(creates[0].input, JSON.stringify({ stream_id: expectedStreamId }));

    const deletes = temporalCalls.filter((c) => c.verb === "delete");
    assert.strictEqual(deletes.length, 0, "nothing to delete on fresh create");
  });

  it("skips create when the existing schedule already encodes the right stream_id", async () => {
    seedConn({ id: "ca_notion", toolkit: "notion" });
    seedOpenclawConfig(["sessions_send"]);

    const expectedStreamId = "composio-notion-notion-fetch-data";
    const expectedScheduleId = `al-stream-pull-composio-${expectedStreamId.slice(0, 20)}`;
    describeResponder = (id) =>
      id === expectedScheduleId ? describeJson(expectedStreamId) : null;

    const { status, data } = await req(
      "POST",
      "/api/v1/integrations/ca_notion/auto-config",
    );
    integrationsModule.flushPendingOpenclawWrites();

    assert.strictEqual(status, 200, `expected 200, got ${status}`);
    assert.strictEqual(data.stream_created, expectedStreamId);
    assert.ok(
      String(data.schedule_created).includes("(already exists)"),
      "expected (already exists) marker — got " + JSON.stringify(data.schedule_created),
    );
    assert.ok(!data.schedule_replaced_stale, "no swap should have happened");

    const deletes = temporalCalls.filter((c) => c.verb === "delete");
    const creates = temporalCalls.filter((c) => c.verb === "create");
    assert.strictEqual(deletes.length, 0, "no delete on a fresh schedule");
    assert.strictEqual(creates.length, 0, "no create on a fresh schedule");
  });

  it("deletes + recreates when the existing schedule encodes a stale stream_id", async () => {
    seedConn({ id: "ca_notion", toolkit: "notion" });
    seedOpenclawConfig(["sessions_send"]);

    // Stale: schedule encodes the old NOTION_LIST_PAGES stream id even though
    // RECOMMENDED_STREAMS now points at NOTION_FETCH_DATA.
    const desiredStreamId = "composio-notion-notion-fetch-data";
    const staleStreamId = "composio-notion-notion-list-pages";
    const expectedScheduleId = `al-stream-pull-composio-${desiredStreamId.slice(0, 20)}`;
    describeResponder = (id) =>
      id === expectedScheduleId ? describeJson(staleStreamId) : null;

    const { status, data } = await req(
      "POST",
      "/api/v1/integrations/ca_notion/auto-config",
    );
    integrationsModule.flushPendingOpenclawWrites();

    assert.strictEqual(status, 200, `expected 200, got ${status} (${JSON.stringify(data)})`);
    assert.strictEqual(data.stream_created, desiredStreamId);
    assert.strictEqual(data.schedule_created, expectedScheduleId, "should be the bare id, not '(already exists)'");
    assert.deepStrictEqual(data.schedule_replaced_stale, {
      schedule_id: expectedScheduleId,
      old_stream_id: staleStreamId,
      new_stream_id: desiredStreamId,
    });

    const deletes = temporalCalls.filter((c) => c.verb === "delete");
    const creates = temporalCalls.filter((c) => c.verb === "create");
    assert.strictEqual(deletes.length, 1, "one delete on stale swap");
    assert.strictEqual(deletes[0].scheduleId, expectedScheduleId);
    assert.strictEqual(creates.length, 1, "one create on stale swap");
    assert.strictEqual(creates[0].scheduleId, expectedScheduleId);
    assert.strictEqual(creates[0].input, JSON.stringify({ stream_id: desiredStreamId }));
  });

  it("recreates when the existing schedule's input is unparseable (treated as stale)", async () => {
    seedConn({ id: "ca_notion", toolkit: "notion" });
    seedOpenclawConfig(["sessions_send"]);

    const desiredStreamId = "composio-notion-notion-fetch-data";
    const expectedScheduleId = `al-stream-pull-composio-${desiredStreamId.slice(0, 20)}`;
    // Schedule exists but describe returns no decodable stream_id. We choose
    // to recreate (safer than letting an opaque schedule fire forever).
    describeResponder = (id) =>
      id === expectedScheduleId ? JSON.stringify({ schedule: {} }) : null;

    const { status, data } = await req(
      "POST",
      "/api/v1/integrations/ca_notion/auto-config",
    );
    integrationsModule.flushPendingOpenclawWrites();

    assert.strictEqual(status, 200);
    assert.ok(
      data.schedule_replaced_stale,
      "schedule with unparseable args must be replaced",
    );
    assert.strictEqual(data.schedule_replaced_stale.old_stream_id, undefined);
    assert.strictEqual(data.schedule_replaced_stale.new_stream_id, desiredStreamId);

    const creates = temporalCalls.filter((c) => c.verb === "create");
    assert.strictEqual(creates.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Direct unit test of the helper
// ---------------------------------------------------------------------------

describe("describeScheduleStreamId helper", () => {
  it("returns exists:false when the schedule is missing", async () => {
    describeResponder = () => null;
    const out = await integrationsModule.describeScheduleStreamId(
      "al-stream-pull-composio-doesntexist",
    );
    assert.deepStrictEqual(out, { exists: false });
  });

  it("decodes a base64 payload to the stream_id", async () => {
    describeResponder = () => describeJson("composio-gmail-gmail-fetch-emails");
    const out = await integrationsModule.describeScheduleStreamId(
      "al-stream-pull-composio-composio-gmail-gma",
    );
    assert.deepStrictEqual(out, {
      exists: true,
      streamId: "composio-gmail-gmail-fetch-emails",
    });
  });

  it("returns exists:true with no streamId when payload is unparseable", async () => {
    describeResponder = () => JSON.stringify({ schedule: { action: {} } });
    const out = await integrationsModule.describeScheduleStreamId("al-foo");
    assert.deepStrictEqual(out, { exists: true, streamId: undefined });
  });
});
