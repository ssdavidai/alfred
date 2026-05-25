// Lane I — /api/v1/channels/telegram/* routes.
//
// Hermes natively supports Telegram via gateway/platforms/telegram.py. The
// bot token lives in Vaultwarden as the canonical record and is cached to
// /opt/alfred/.env on every PUT. ctrl-api orchestrates: it talks to vault-cli
// for the secret, mutates .env, restarts the hermes container, and proxies
// `hermes pairing` for DM-pairing codes.
//
// Six behaviours under test:
//   1. GET with no Vaultwarden item   → state: "unconfigured"
//   2. GET with item + Hermes healthy → state: "configured_running" w/ bot_handle
//   3. PUT valid token                → vault write + .env update + restart
//   4. PUT malformed token            → 400
//   5. DELETE                         → vault wipe + .env clear + restart
//   6. POST /pair                     → returns { code, expires_at }
//
// The route delegates filesystem mutation to fs.{read,write}FileSync and
// docker mutation to dockerExec / dockerComposeCmd from helpers.js. Both are
// mock-substituted so the test runs cleanly in CI without docker or
// vault-cli reachable. The vault-cli HTTP surface is mocked via global
// fetch — same pattern vaultwarden.ts itself uses.
import { mock, describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

// COMPOSE_DIR is read at module import by helpers.ts. Point it at a tmp dir so
// the .env path resolves under our control and we can assert its contents.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-routes-"));
process.env.COMPOSE_DIR = tmp;
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";
// vault-cli URL — never reached because we stub global fetch.
process.env.VAULT_CLI_URL = "http://vault-cli-stub:8087";
const ENV_PATH = path.join(tmp, ".env");

// Mocked subprocess surface — every test reseeds these.
const dockerExecCalls: { service: string; command: string[] }[] = [];
const dockerComposeCalls: string[][] = [];
let dockerExecImpl: (service: string, command: string[]) => Promise<string> =
  async () => "";
let dockerComposeCmdImpl: (args: string[]) => Promise<string> = async () => "";

const realHelpers = await import("../src/api/helpers.js");
mock.module("../src/api/helpers.js", {
  namedExports: {
    ...realHelpers,
    dockerExec: async (service: string, command: string[]) => {
      dockerExecCalls.push({ service, command: [...command] });
      return dockerExecImpl(service, command);
    },
    dockerComposeCmd: async (args: string[]) => {
      dockerComposeCalls.push([...args]);
      return dockerComposeCmdImpl(args);
    },
  },
});

// vault-cli mock — fetch() within the route reaches `/list/object/items?search=`
// and `/object/item/:id`. We let tests configure what the store contains.
interface VaultItem {
  id: string;
  name: string;
  type: 1;
  login: { username: string | null; password: string; uris: unknown[] };
}
let vaultStore: VaultItem[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input.url ?? String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  // /list/object/items?search=<name>
  if (url.includes("/list/object/items")) {
    const qIdx = url.indexOf("?");
    const params = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");
    const search = params.get("search") ?? "";
    const filtered = search
      ? vaultStore.filter((i) =>
          i.name.toLowerCase().includes(search.toLowerCase()),
        )
      : vaultStore.slice();
    return makeJsonResponse({ success: true, data: { data: filtered } });
  }
  // /object/item/:id
  const objectItemMatch = url.match(/\/object\/item\/([^/?]+)/);
  if (objectItemMatch && method === "GET") {
    const id = objectItemMatch[1];
    const item = vaultStore.find((i) => i.id === id);
    if (!item) return makeJsonResponse({ success: false, message: "not found" }, 404);
    return makeJsonResponse({ success: true, data: { data: item } });
  }
  // POST /object/item — create
  if (url.endsWith("/object/item") && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const id = "11111111-2222-3333-4444-" + String(Date.now()).padStart(12, "0");
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
  // PUT /object/item/:id — update
  if (objectItemMatch && method === "PUT") {
    const id = objectItemMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
    const body = JSON.parse(String(init?.body ?? "{}"));
    vaultStore[idx] = {
      ...vaultStore[idx],
      name: body.name ?? vaultStore[idx].name,
      login: {
        ...vaultStore[idx].login,
        ...(body.login ?? {}),
      },
    };
    return makeJsonResponse({ success: true, data: { data: vaultStore[idx] } });
  }
  // DELETE /object/item/:id
  if (objectItemMatch && method === "DELETE") {
    const id = objectItemMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
    vaultStore.splice(idx, 1);
    return makeJsonResponse({ success: true, data: {} });
  }
  // Health probe — not relied on here but be polite.
  return makeJsonResponse({ success: true, data: {} });
}) as typeof fetch;

function makeJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const { matchRoute } = await import("../src/api/server.js");
const { registerTelegramRoutes } = await import(
  "../src/api/routes/telegram.js"
);
registerTelegramRoutes();

async function call(
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    writeHead(c: number) {
      status = c;
      return res;
    },
    end(j?: string) {
      payload = j ? JSON.parse(j) : undefined;
    },
  } as unknown as ServerResponse;
  try {
    await m!.handler({
      req: { url: p } as any,
      res,
      params: m!.params,
      body,
      query: new URLSearchParams(),
    });
  } catch (err: any) {
    // server.ts catches ApiError and turns it into a JSON response with the
    // declared statusCode. Mirror that here so route-level throw works
    // ergonomically in the test.
    if (err && typeof err.statusCode === "number") {
      status = err.statusCode;
      payload = { error: { code: err.code, message: err.message } };
    } else {
      throw err;
    }
  }
  return { status, payload };
}

// BotFather shape: <8-12 digits>:<35 chars [A-Za-z0-9_-]>.
const VALID_TOKEN = "123456789:ABCdef1234ghIklmnopqrstuvwxyzAB-Cze";
//                  ^9 digits  ^^                                ^^ 35 chars

beforeEach(() => {
  vaultStore = [];
  dockerExecCalls.length = 0;
  dockerComposeCalls.length = 0;
  dockerExecImpl = async () => "";
  dockerComposeCmdImpl = async () => "";
  // Wipe .env between tests for clean assertions.
  try {
    fs.unlinkSync(ENV_PATH);
  } catch {
    /* not there — fine */
  }
});

describe("Lane I — /api/v1/channels/telegram/*", () => {
  it("GET /status — no Vaultwarden item → state: unconfigured", async () => {
    const { status, payload } = await call(
      "GET",
      "/api/v1/channels/telegram/status",
    );
    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.configured, false);
    assert.equal(payload.state, "unconfigured");
    assert.equal(payload.bot_handle, null);
    assert.equal(payload.error, null);
  });

  it("GET /status — item exists + Hermes healthy → state: configured_running w/ bot_handle", async () => {
    vaultStore.push({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      name: "Telegram Bot Token",
      type: 1,
      login: { username: null, password: VALID_TOKEN, uris: [] },
    });
    // hermes gateway status returns JSON with telegram running + bot handle.
    dockerExecImpl = async (_svc, command) => {
      if (command.includes("gateway") && command.includes("status")) {
        return JSON.stringify({
          platforms: {
            telegram: {
              running: true,
              bot_handle: "@my_alfred_bot",
              last_message_at: "2026-05-25T10:00:00Z",
            },
          },
        });
      }
      return "";
    };

    const { status, payload } = await call(
      "GET",
      "/api/v1/channels/telegram/status",
    );
    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.configured, true);
    assert.equal(payload.state, "configured_running");
    assert.equal(payload.bot_handle, "@my_alfred_bot");
    assert.equal(payload.last_message_at, "2026-05-25T10:00:00Z");
    assert.equal(payload.error, null);
  });

  it("PUT /token — valid token → vault write + .env update + restart triggered", async () => {
    const { status, payload } = await call(
      "PUT",
      "/api/v1/channels/telegram/token",
      { token: VALID_TOKEN },
    );
    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true);
    assert.equal(payload.state, "configured_starting");

    // Vault holds an item with the right name + password.
    assert.equal(vaultStore.length, 1, "vault must hold one item now");
    assert.equal(vaultStore[0].name, "Telegram Bot Token");
    assert.equal(vaultStore[0].login.password, VALID_TOKEN);

    // .env contains the token.
    const envContent = fs.readFileSync(ENV_PATH, "utf-8");
    assert.match(envContent, new RegExp(`TELEGRAM_BOT_TOKEN=${VALID_TOKEN.replace(/[-]/g, "\\-")}`));

    // Hermes restarted.
    const restartCall = dockerComposeCalls.find(
      (c) => c[0] === "restart" && c.includes("hermes"),
    );
    assert.ok(restartCall, `expected hermes restart, got ${JSON.stringify(dockerComposeCalls)}`);
  });

  it("PUT /token — malformed token → 400", async () => {
    const { status, payload } = await call(
      "PUT",
      "/api/v1/channels/telegram/token",
      { token: "not-a-real-token" },
    );
    assert.equal(status, 400, JSON.stringify(payload));
    // No side effects.
    assert.equal(vaultStore.length, 0, "vault must NOT be written on a 400");
    assert.equal(dockerComposeCalls.length, 0, "no restart on a 400");
  });

  it("DELETE /token → wipe vault + clear .env + restart", async () => {
    // Pre-seed the cache so DELETE has something to wipe.
    vaultStore.push({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      name: "Telegram Bot Token",
      type: 1,
      login: { username: null, password: VALID_TOKEN, uris: [] },
    });
    fs.writeFileSync(ENV_PATH, `TELEGRAM_BOT_TOKEN=${VALID_TOKEN}\nFOO=bar\n`);

    const { status, payload } = await call(
      "DELETE",
      "/api/v1/channels/telegram/token",
    );
    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true);
    assert.equal(payload.state, "unconfigured");

    // Vault item is gone.
    assert.equal(vaultStore.length, 0, "vault must be wiped");
    // .env no longer contains the token line; OTHER lines preserved.
    const envContent = fs.readFileSync(ENV_PATH, "utf-8");
    assert.doesNotMatch(envContent, /TELEGRAM_BOT_TOKEN=\S/);
    assert.match(envContent, /FOO=bar/);
    // Hermes restarted.
    const restartCall = dockerComposeCalls.find(
      (c) => c[0] === "restart" && c.includes("hermes"),
    );
    assert.ok(restartCall, "expected hermes restart on DELETE");
  });

  it("POST /pair → returns { code, expires_at }", async () => {
    // `hermes -p main pairing` (with whichever generate subcommand) emits a
    // 6-digit code. The route MUST surface it as { code, expires_at }.
    dockerExecImpl = async (_svc, command) => {
      if (command.includes("pairing")) {
        return "Pairing code: ABC-123-XYZ (expires in 1 hour)\n";
      }
      return "";
    };
    const { status, payload } = await call(
      "POST",
      "/api/v1/channels/telegram/pair",
    );
    assert.equal(status, 200, JSON.stringify(payload));
    assert.ok(typeof payload.code === "string" && payload.code.length > 0, "code missing");
    assert.ok(
      typeof payload.expires_at === "string" && !Number.isNaN(Date.parse(payload.expires_at)),
      `expires_at must be ISO, got ${payload.expires_at}`,
    );
  });
});

// Tidy up.
process.on("exit", () => {
  globalThis.fetch = originalFetch;
});
