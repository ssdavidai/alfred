// issue #185 — live MCP-server tool enumeration on /tools.
//
// Before this change, `/api/v1/hermes/allowed-tools` knew the names + count
// for `whitelist`-mode servers (config.yaml had the names) and the COUNT
// (=0) for `none`-mode servers. For `all`-mode servers (no `tools.include`
// in config.yaml), it returned `tool_count: null` and an empty `mcp_tools`
// slice — the UI rendered "all tools" with no expander and the misleading
// "exact list isn't surfaced here yet" copy.
//
// This test fixes the route to:
//   1. Leave the whitelist path UNCHANGED (LLM sees exactly those names).
//   2. Populate `all`-mode servers from the live runtime via
//      `hermes mcp test <server>` — count + names + descriptions.
//   3. Keep `none`-mode at empty (intentionally hidden from main).
//
// The `hermes mcp test` exec is mocked here so CI runs deterministic without
// touching a live container.
//
// Coverage:
//   - whitelist path unchanged (sure: count from config, names from config)
//   - all path populated from the mocked `hermes mcp test` output
//   - none path empty
//   - parser tolerates the real CLI output shape (header + tool rows)
//   - per-server cache: a second hit within the TTL skips dockerExec
//   - failure path (exec throws) — falls back without poisoning the rest

import { mock, describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-allowed-tools-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

// Write a config.yaml the route can read. Three servers — one whitelist
// (sure, 2 names), one all (plane — no tools.include), one none
// (vaultwarden — empty tools.include). The route reads
// /opt/data/profiles/main/config.yaml by default; redirect via env.
const profileDir = path.join(tmp, "profiles", "main");
fs.mkdirSync(profileDir, { recursive: true });
const configYaml = `
platform_toolsets:
  cli:
    - terminal
    - file
mcp_servers:
  sure:
    transport: stdio
    tools:
      include:
        - get_balance_sheet
        - list_accounts
  plane:
    transport: stdio
  vaultwarden:
    transport: stdio
    tools:
      include: []
`;
fs.writeFileSync(path.join(profileDir, "config.yaml"), configYaml);
process.env.HERMES_HOME = tmp;

// ── helpers mock — stub dockerExec for `hermes mcp test <server>` ────────

const dockerExecCalls: { service: string; command: string[] }[] = [];
let dockerExecHandler: (
  service: string,
  command: string[],
) => string | Promise<string> = async () => "";

const realHelpers = await import("../src/api/helpers.js");
mock.module("../src/api/helpers.js", {
  namedExports: {
    ...realHelpers,
    dockerExec: async (service: string, command: string[]) => {
      dockerExecCalls.push({ service, command: [...command] });
      return await dockerExecHandler(service, command);
    },
    dockerComposeCmd: async () => "",
  },
});

const { matchRoute } = await import("../src/api/server.js");
const { registerHermesRoutes, _resetMcpToolsCacheForTest } = await import(
  "../src/api/routes/hermes.js"
);

registerHermesRoutes();

// Fake plane catalogue — what `hermes mcp test plane` returns. Real CLI
// shape: ~2-space-indented header, blank, then 4-space-indented rows of
// `<name>` + ≥2 spaces + truncated description.
const FAKE_PLANE_OUTPUT = `  Testing 'plane'...
  Transport: stdio → node
  Auth: none
  ✓ Connected (265ms)
  ✓ Tools discovered: 3

    get_issue                            Fetch a single Plane issue by id.
    list_issues                          Simple paginated list of issues in ONE project.
    create_issue                         Create a new issue in a Plane project.
`;

function invokeRoute(): Promise<{ status: number; body: any }> {
  const matched = matchRoute("GET", "/api/v1/hermes/allowed-tools");
  assert.ok(matched, "/api/v1/hermes/allowed-tools must be registered");
  return new Promise((resolve, reject) => {
    let bodyChunks: any[] = [];
    let status = 0;
    const res: any = {
      statusCode: 200,
      setHeader() {},
      writeHead(s: number) {
        status = s;
      },
      end(chunk?: any) {
        if (chunk !== undefined) bodyChunks.push(chunk);
        try {
          const raw = Buffer.concat(
            bodyChunks.map((c) =>
              Buffer.isBuffer(c) ? c : Buffer.from(String(c)),
            ),
          ).toString();
          resolve({ status: status || 200, body: raw ? JSON.parse(raw) : {} });
        } catch (e) {
          reject(e);
        }
      },
      write(chunk: any) {
        bodyChunks.push(chunk);
      },
    };
    Promise.resolve(
      matched!.handler({
        req: {} as any,
        res,
        params: matched!.params,
        query: new URLSearchParams(),
        body: undefined,
      }),
    ).catch(reject);
  });
}

beforeEach(() => {
  dockerExecCalls.length = 0;
  _resetMcpToolsCacheForTest();
  dockerExecHandler = async (_svc, command) => {
    // command shape: ['hermes', 'mcp', 'test', '<server>']
    const server = command[command.length - 1];
    if (server === "plane") return FAKE_PLANE_OUTPUT;
    throw new Error(`unmocked server: ${server}`);
  };
});

describe("issue #185 — /api/v1/hermes/allowed-tools enumerates `all`-mode MCP servers", () => {
  it("returns the whitelist names verbatim for whitelist-mode servers (config-driven, unchanged)", async () => {
    const { status, body } = await invokeRoute();
    assert.equal(status, 200);
    const inclusion = body.mcp_server_inclusion as any[];
    const sure = inclusion.find((i) => i.server === "sure");
    assert.ok(sure, "sure must appear in mcp_server_inclusion");
    assert.equal(sure.mode, "whitelist");
    assert.equal(sure.tool_count, 2);
    const sureTools = (body.mcp_tools as any[]).filter((t) => t.server === "sure");
    assert.deepEqual(
      sureTools.map((t) => t.name).sort(),
      ["get_balance_sheet", "list_accounts"],
    );
  });

  it("populates `all`-mode servers from `hermes mcp test <server>` — count + names", async () => {
    const { status, body } = await invokeRoute();
    assert.equal(status, 200);
    const inclusion = body.mcp_server_inclusion as any[];
    const plane = inclusion.find((i) => i.server === "plane");
    assert.ok(plane);
    assert.equal(plane.mode, "all");
    assert.equal(
      plane.tool_count,
      3,
      "discovered count from `hermes mcp test plane` (3 in fake output)",
    );
    const planeTools = (body.mcp_tools as any[]).filter(
      (t) => t.server === "plane",
    );
    assert.deepEqual(
      planeTools.map((t) => t.name).sort(),
      ["create_issue", "get_issue", "list_issues"],
    );
    // Descriptions came from the parsed CLI output.
    const issueRow = planeTools.find((t) => t.name === "get_issue");
    assert.match(issueRow.description, /Fetch a single Plane issue/);
    // And the call landed.
    assert.ok(
      dockerExecCalls.some(
        (c) =>
          c.service === "hermes" &&
          c.command.includes("mcp") &&
          c.command.includes("test") &&
          c.command.includes("plane"),
      ),
      "dockerExec must have been called with `hermes mcp test plane`",
    );
  });

  it("none-mode servers (tools.include === []) stay empty — intentionally hidden from main", async () => {
    const { status, body } = await invokeRoute();
    assert.equal(status, 200);
    const inclusion = body.mcp_server_inclusion as any[];
    const vw = inclusion.find((i) => i.server === "vaultwarden");
    assert.ok(vw);
    assert.equal(vw.mode, "none");
    assert.equal(vw.tool_count, 0);
    const vwTools = (body.mcp_tools as any[]).filter(
      (t) => t.server === "vaultwarden",
    );
    assert.equal(vwTools.length, 0);
    // And we did NOT run docker exec on vaultwarden (none-mode skips
    // discovery — the count is known to be 0 from config).
    assert.ok(
      !dockerExecCalls.some((c) => c.command.includes("vaultwarden")),
      "vaultwarden must not be queried via `hermes mcp test`",
    );
  });

  it("caches the per-server result: a second invocation within the TTL skips dockerExec", async () => {
    await invokeRoute();
    const firstCallCount = dockerExecCalls.length;
    await invokeRoute();
    const secondCallCount = dockerExecCalls.length;
    assert.equal(
      secondCallCount,
      firstCallCount,
      "second /allowed-tools hit must reuse the cached `plane` catalogue",
    );
  });

  it("if `hermes mcp test <server>` fails, the row still appears (mode='all', count=null, no tools)", async () => {
    dockerExecHandler = async () => {
      throw new Error("docker exec exploded");
    };
    const { status, body } = await invokeRoute();
    assert.equal(status, 200);
    const inclusion = body.mcp_server_inclusion as any[];
    const plane = inclusion.find((i) => i.server === "plane");
    assert.ok(plane, "plane must still appear when discovery fails");
    assert.equal(plane.mode, "all");
    assert.equal(
      plane.tool_count,
      null,
      "tool_count is null when discovery failed and no curated fallback exists",
    );
    const planeTools = (body.mcp_tools as any[]).filter(
      (t) => t.server === "plane",
    );
    assert.equal(planeTools.length, 0);
  });
});
