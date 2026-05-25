// Lane I — /api/v1/channels/slack/* routes.
//
// Mirrors telegram-routes.test.ts (same docker-exec + vault-cli + fetch
// mock pattern). Six behaviours under test:
//   1. GET /status with no .env tokens   → state: "unconfigured"
//   2. GET /status with both tokens + valid Slack auth.test
//                                        → state: "configured_running" + workspace info
//   3. GET /status with bad bot_token   → state: "error" with auth.test error surfaced
//   4. PUT /tokens valid pair           → vault writes (2 items) + .env upsert + restart
//   5. PUT /tokens bad shape            → 400, no side effects
//   6. DELETE /tokens                   → vault wipes + all SLACK_* keys dropped + restart

import { mock, describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slack-routes-"));
process.env.COMPOSE_DIR = tmp;
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.VAULT_CLI_URL = "http://vault-cli-stub:8087";
process.env.HERMES_HOME_IN_CONTAINER = "/hermes-state";

const PROFILE_DIR = "/hermes-state/profiles/main";
const PROFILE_ENV_PATH = `${PROFILE_DIR}/.env`;

// ── docker exec mock state ───────────────────────────────────────────────
let containerFiles: Record<string, string> = {};
const dockerExecCalls: { service: string; command: string[] }[] = [];
const dockerExecWithStdinCalls: { service: string; command: string[]; stdin: string }[] = [];
const dockerComposeCalls: string[][] = [];

function defaultDockerExec(_service: string, command: string[]): string {
  if (command[0] === "sh" && command[1] === "-c") {
    const script = command[2] ?? "";
    const catMatch = script.match(/^cat\s+(\S+)\s+2>\/dev\/null\s+\|\|\s+true$/);
    if (catMatch) return containerFiles[catMatch[1]] ?? "";
    return "";
  }
  // hermes slack manifest — return a minimal fake JSON.
  if (command.includes("manifest")) {
    return JSON.stringify({ display_information: { name: "Alfred Black" } });
  }
  return "";
}

const realHelpers = await import("../src/api/helpers.js");
mock.module("../src/api/helpers.js", {
  namedExports: {
    ...realHelpers,
    dockerExec: async (service: string, command: string[]) => {
      dockerExecCalls.push({ service, command: [...command] });
      return defaultDockerExec(service, command);
    },
    dockerExecWithStdin: async (service: string, command: string[], stdin: string) => {
      dockerExecWithStdinCalls.push({ service, command: [...command], stdin });
      const script = command[2] ?? "";
      const mvMatch = script.match(/mv\s+\S+\s+(\S+)$/);
      if (mvMatch) containerFiles[mvMatch[1]] = stdin;
      return { stdout: "", stderr: "" };
    },
    dockerComposeCmd: async (args: string[]) => {
      dockerComposeCalls.push([...args]);
      return "";
    },
  },
});

// ── vault-cli + Slack API mock ────────────────────────────────────────────

interface VaultItem {
  id: string;
  name: string;
  type: 1;
  login: { username: string | null; password: string; uris: unknown[] };
}
let vaultStore: VaultItem[] = [];

// Slack auth.test result the mock returns. Tests flip this to simulate
// valid vs invalid bot tokens.
let slackAuthOk = true;
let slackAuthError: string | null = null;

const originalFetch = globalThis.fetch;
function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input.url ?? String(input));
  const method = (init?.method ?? "GET").toUpperCase();

  // Slack auth.test
  if (url === "https://slack.com/api/auth.test") {
    if (slackAuthOk) {
      return makeJsonResponse({
        ok: true,
        team: "Test Workspace",
        team_id: "T01TEST",
        user: "alfred_bot",
        user_id: "U01ALFRED",
        url: "https://test.slack.com/",
      });
    }
    return makeJsonResponse({ ok: false, error: slackAuthError ?? "invalid_auth" });
  }
  // Slack chat.postMessage — for the /test endpoint test.
  if (url === "https://slack.com/api/chat.postMessage") {
    return makeJsonResponse({ ok: true, ts: "1684567890.000100" });
  }

  // vault-cli
  if (url.includes("/list/object/items")) {
    const qIdx = url.indexOf("?");
    const params = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");
    const search = params.get("search") ?? "";
    const filtered = search
      ? vaultStore.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()))
      : vaultStore.slice();
    return makeJsonResponse({ success: true, data: { data: filtered } });
  }
  const objMatch = url.match(/\/object\/item\/([^/?]+)/);
  if (objMatch && method === "GET") {
    const id = objMatch[1];
    const item = vaultStore.find((i) => i.id === id);
    if (!item) return makeJsonResponse({ success: false, message: "not found" }, 404);
    return makeJsonResponse({ success: true, data: { data: item } });
  }
  if (url.endsWith("/object/item") && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const id = "id-" + String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
    const item: VaultItem = {
      id,
      name: body.name,
      type: 1,
      login: {
        username: body.login?.username ?? null,
        password: body.login?.password ?? "",
        uris: body.login?.uris ?? [],
      },
    };
    vaultStore.push(item);
    return makeJsonResponse({ success: true, data: { data: item } });
  }
  if (objMatch && method === "PUT") {
    const id = objMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
    const body = JSON.parse(String(init?.body ?? "{}"));
    vaultStore[idx] = {
      ...vaultStore[idx],
      name: body.name ?? vaultStore[idx].name,
      login: { ...vaultStore[idx].login, ...(body.login ?? {}) },
    };
    return makeJsonResponse({ success: true, data: { data: vaultStore[idx] } });
  }
  if (objMatch && method === "DELETE") {
    const id = objMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
    vaultStore.splice(idx, 1);
    return makeJsonResponse({ success: true });
  }
  throw new Error(`unexpected fetch in slack-routes test: ${method} ${url}`);
}) as typeof fetch;

const { registerSlackRoutes } = await import("../src/api/routes/slack.js");
const { matchRoute } = await import("../src/api/server.js");
registerSlackRoutes();

interface CallResult {
  status: number;
  payload: any;
}
async function call(
  method: string,
  p: string,
  body?: unknown,
): Promise<CallResult> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res: any = {
    statusCode: 0,
    setHeader() {},
    writeHead(c: number) { status = c; },
    end(j?: string) {
      payload = j ? JSON.parse(j) : undefined;
    },
  };
  try {
    await m!.handler({
      req: { method, headers: {} } as any,
      res,
      params: {},
      body,
      query: new URLSearchParams(),
    });
  } catch (e: any) {
    if (e?.statusCode) {
      status = e.statusCode;
      payload = { error: { code: e.code, message: e.message } };
    } else {
      throw e;
    }
  }
  return { status: status || res.statusCode, payload };
}

describe("/api/v1/channels/slack/*", () => {
  beforeEach(() => {
    containerFiles = {};
    dockerExecCalls.length = 0;
    dockerExecWithStdinCalls.length = 0;
    dockerComposeCalls.length = 0;
    vaultStore = [];
    slackAuthOk = true;
    slackAuthError = null;
  });

  it("GET /status returns unconfigured when no tokens in .env", async () => {
    containerFiles[PROFILE_ENV_PATH] = "# empty\n";
    const r = await call("GET", "/api/v1/channels/slack/status");
    assert.equal(r.status, 200);
    assert.equal(r.payload.state, "unconfigured");
    assert.equal(r.payload.configured, false);
  });

  it("GET /status returns configured_running + workspace info when both tokens + auth.test ok", async () => {
    containerFiles[PROFILE_ENV_PATH] =
      "SLACK_BOT_TOKEN=xoxb-1234567890\n" +
      "SLACK_APP_TOKEN=xapp-1ABCD-12345678\n";
    const r = await call("GET", "/api/v1/channels/slack/status");
    assert.equal(r.status, 200);
    assert.equal(r.payload.state, "configured_running");
    assert.equal(r.payload.workspace.team, "Test Workspace");
    assert.equal(r.payload.workspace.team_id, "T01TEST");
    assert.equal(r.payload.workspace.bot_user, "@alfred_bot");
  });

  it("GET /status surfaces auth.test error as state=error (token rejected)", async () => {
    containerFiles[PROFILE_ENV_PATH] =
      "SLACK_BOT_TOKEN=xoxb-rejected\nSLACK_APP_TOKEN=xapp-rejected\n";
    slackAuthOk = false;
    slackAuthError = "invalid_auth";
    const r = await call("GET", "/api/v1/channels/slack/status");
    assert.equal(r.status, 200);
    assert.equal(r.payload.state, "error");
    assert.equal(r.payload.error, "invalid_auth");
  });

  it("PUT /tokens with valid pair writes 2 vault items + .env keys + restarts hermes", async () => {
    const r = await call("PUT", "/api/v1/channels/slack/tokens", {
      bot_token: "xoxb-1234567890-abcd1234EFGH",
      app_token: "xapp-1-A1B2C3D4-9876543210-secret",
      allowed_users: "U01ABC,U02DEF",
      home_channel: "C09HOME",
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.state, "configured_starting");
    // Vault has both items now.
    assert.equal(vaultStore.length, 2);
    assert.ok(vaultStore.some((i) => i.name === "Slack Bot Token"));
    assert.ok(vaultStore.some((i) => i.name === "Slack App Token"));
    // .env was written via dockerExecWithStdin — capture and inspect.
    const wrote = dockerExecWithStdinCalls.find((c) =>
      c.command[2]?.includes(PROFILE_ENV_PATH),
    );
    assert.ok(wrote, "dockerExecWithStdin should have written the .env");
    assert.match(wrote.stdin, /SLACK_BOT_TOKEN=xoxb-/);
    assert.match(wrote.stdin, /SLACK_APP_TOKEN=xapp-/);
    assert.match(wrote.stdin, /SLACK_ALLOWED_USERS=U01ABC,U02DEF/);
    assert.match(wrote.stdin, /SLACK_HOME_CHANNEL=C09HOME/);
    // Restart hermes was fired.
    assert.ok(
      dockerComposeCalls.some(
        (c) => c[0] === "restart" && c[1] === "hermes",
      ),
      "hermes restart should fire",
    );
  });

  it("PUT /tokens rejects a malformed bot_token (no xoxb- prefix) → 400", async () => {
    const r = await call("PUT", "/api/v1/channels/slack/tokens", {
      bot_token: "not-a-slack-token",
      app_token: "xapp-1-A1B2C3D4-9876543210-secret",
    });
    assert.equal(r.status, 400);
    assert.equal(vaultStore.length, 0, "no side effects on validation failure");
    assert.equal(
      dockerExecWithStdinCalls.length,
      0,
      ".env write must not happen on validation failure",
    );
  });

  it("DELETE /tokens wipes vault items + drops all SLACK_* keys + restarts hermes", async () => {
    // Seed: both vault items + .env with all 5 keys set.
    vaultStore = [
      {
        id: "v1",
        name: "Slack Bot Token",
        type: 1,
        login: { username: null, password: "xoxb-…", uris: [] },
      },
      {
        id: "v2",
        name: "Slack App Token",
        type: 1,
        login: { username: null, password: "xapp-…", uris: [] },
      },
    ];
    containerFiles[PROFILE_ENV_PATH] =
      "SLACK_BOT_TOKEN=xoxb-old\n" +
      "SLACK_APP_TOKEN=xapp-old\n" +
      "SLACK_ALLOWED_USERS=U01\n" +
      "SLACK_HOME_CHANNEL=C01\n" +
      "SLACK_ALLOWED_CHANNELS=C01,C02\n" +
      "OPENROUTER_API_KEY=keep-me\n";
    const r = await call("DELETE", "/api/v1/channels/slack/tokens");
    assert.equal(r.status, 200);
    assert.equal(r.payload.state, "unconfigured");
    // Vault items wiped.
    assert.equal(vaultStore.length, 0);
    // .env rewrite must drop all SLACK_* but keep OPENROUTER_API_KEY.
    const wrote = dockerExecWithStdinCalls.find((c) =>
      c.command[2]?.includes(PROFILE_ENV_PATH),
    );
    assert.ok(wrote);
    assert.doesNotMatch(wrote.stdin, /^SLACK_/m, "all SLACK_* must be dropped");
    assert.match(wrote.stdin, /OPENROUTER_API_KEY=keep-me/, "non-slack keys preserved");
    // Restart fired.
    assert.ok(
      dockerComposeCalls.some((c) => c[0] === "restart" && c[1] === "hermes"),
    );
  });

  it("GET /manifest returns the hermes-generated manifest JSON", async () => {
    const r = await call("GET", "/api/v1/channels/slack/manifest");
    assert.equal(r.status, 200);
    assert.equal(typeof r.payload.manifest, "string");
    // The mock returned a minimal JSON object — verify it parses + has the
    // shape we expect (the real CLI output is larger but same shape).
    const parsed = JSON.parse(r.payload.manifest);
    assert.equal(parsed.display_information.name, "Alfred Black");
  });
});

process.on("exit", () => {
  globalThis.fetch = originalFetch;
});
