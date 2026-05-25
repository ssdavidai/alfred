// Lane I — /api/v1/channels/telegram/* routes.
//
// Hermes' gateway reads Telegram config from per-profile files inside its
// data volume (NOT from container env). ctrl-api orchestrates by reading +
// writing those files via `docker exec hermes …` and bouncing the gateway.
// Vault-cli holds the canonical token; the per-profile .env is the cache the
// gateway reads on boot.
//
// Six behaviours under test:
//   1. GET with no .env token            → state: "unconfigured"
//   2. GET with token + state=connected  → state: "configured_running" + bot_handle + paired_chats
//   3. PUT valid token                   → vault write + .env upsert via docker exec + restart
//   4. PUT malformed token               → 400 + no side effects
//   5. DELETE                            → vault wipe + .env keys dropped + restart
//   6. POST /pair                        → returns { code, expires_at }
//
// All shell IO is mocked: dockerExec returns canned file contents based on
// which path the route asked for; dockerExecWithStdin captures the new
// content the route asked Hermes to write. The vault-cli HTTP surface is
// mocked via global fetch — same pattern vaultwarden.ts itself uses.

import { mock, describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

// COMPOSE_DIR is read at module import by helpers.ts. Point it at a tmp dir
// so any leftover module-load IO is harmless.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-routes-"));
process.env.COMPOSE_DIR = tmp;
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";
// vault-cli URL — never reached because we stub global fetch.
process.env.VAULT_CLI_URL = "http://vault-cli-stub:8087";
// Force the route's in-container path so we can assert against it.
process.env.HERMES_HOME_IN_CONTAINER = "/hermes-state";

const PROFILE_DIR = "/hermes-state/profiles/main";
const PROFILE_ENV_PATH = `${PROFILE_DIR}/.env`;
const GATEWAY_STATE_PATH = `${PROFILE_DIR}/gateway_state.json`;
const CHANNEL_DIR_PATH = `${PROFILE_DIR}/channel_directory.json`;

// ── docker exec mock state ───────────────────────────────────────────────
// Simulated files inside the hermes container — tests seed this. A missing
// key means the file doesn't exist (the route's `cat … || true` returns "").
let containerFiles: Record<string, string> = {};
const dockerExecCalls: { service: string; command: string[] }[] = [];
const dockerExecWithStdinCalls: { service: string; command: string[]; stdin: string }[] = [];
const dockerComposeCalls: string[][] = [];

let dockerExecOverride:
  | null
  | ((service: string, command: string[]) => Promise<string>) = null;

function defaultDockerExec(_service: string, command: string[]): string {
  // `sh -c "cat <path> 2>/dev/null || true"` → return the file (or "").
  if (command[0] === "sh" && command[1] === "-c") {
    const script = command[2] ?? "";
    const catMatch = script.match(/^cat\s+(\S+)\s+2>\/dev\/null\s+\|\|\s+true$/);
    if (catMatch) {
      return containerFiles[catMatch[1]] ?? "";
    }
    // Atomic-write script: `mkdir -p <DIR> && cat > <TMP> && mv <TMP> <DST>`
    // The actual write is captured by dockerExecWithStdin; if it ever lands
    // here (no stdin) just no-op.
    return "";
  }
  // hermes pairing surface — test overrides if needed.
  return "";
}

const realHelpers = await import("../src/api/helpers.js");
mock.module("../src/api/helpers.js", {
  namedExports: {
    ...realHelpers,
    dockerExec: async (service: string, command: string[]) => {
      dockerExecCalls.push({ service, command: [...command] });
      if (dockerExecOverride) return dockerExecOverride(service, command);
      return defaultDockerExec(service, command);
    },
    dockerExecWithStdin: async (
      service: string,
      command: string[],
      stdin: string,
    ) => {
      dockerExecWithStdinCalls.push({ service, command: [...command], stdin });
      // Parse `… && mv <tmp> <dst>` and persist `stdin` to the dst path so a
      // subsequent read sees the write.
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

// ── vault-cli mock (same shape as before) ─────────────────────────────────
interface VaultItem {
  id: string;
  name: string;
  type: 1;
  login: { username: string | null; password: string; uris: unknown[] };
}
let vaultStore: VaultItem[] = [];
// Telegram getMe is hit by /status when a token is set; return a stable handle.
let telegramGetMeHandle: string | null = "alfred_test_bot";

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input.url ?? String(input));
  const method = (init?.method ?? "GET").toUpperCase();

  // Telegram Bot API getMe — used by resolveBotHandle.
  if (url.startsWith("https://api.telegram.org/bot") && url.endsWith("/getMe")) {
    if (telegramGetMeHandle === null) {
      return makeJsonResponse({ ok: false, description: "Unauthorized" }, 401);
    }
    return makeJsonResponse({ ok: true, result: { id: 42, is_bot: true, username: telegramGetMeHandle } });
  }

  // vault-cli surface.
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
  const objectItemMatch = url.match(/\/object\/item\/([^/?]+)/);
  if (objectItemMatch && method === "GET") {
    const id = objectItemMatch[1];
    const item = vaultStore.find((i) => i.id === id);
    if (!item) return makeJsonResponse({ success: false, message: "not found" }, 404);
    return makeJsonResponse({ success: true, data: { data: item } });
  }
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
  if (objectItemMatch && method === "DELETE") {
    const id = objectItemMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
    vaultStore.splice(idx, 1);
    return makeJsonResponse({ success: true, data: {} });
  }

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

beforeEach(() => {
  vaultStore = [];
  containerFiles = {};
  dockerExecCalls.length = 0;
  dockerExecWithStdinCalls.length = 0;
  dockerComposeCalls.length = 0;
  dockerExecOverride = null;
  telegramGetMeHandle = "alfred_test_bot";
});

describe("Lane I — /api/v1/channels/telegram/* (per-profile .env)", () => {
  it("GET /status — no per-profile .env token → state: unconfigured", async () => {
    const { status, payload } = await call(
      "GET",
      "/api/v1/channels/telegram/status",
    );
    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.configured, false);
    assert.equal(payload.state, "unconfigured");
    assert.equal(payload.bot_handle, null);
    assert.deepEqual(payload.paired_chats, []);
    assert.equal(payload.error, null);
  });

  it("GET /status — token present + gateway_state=connected → configured_running w/ bot_handle + paired_chats", async () => {
    containerFiles[PROFILE_ENV_PATH] =
      `TELEGRAM_BOT_TOKEN=${VALID_TOKEN}\n` +
      `TELEGRAM_ALLOWED_USERS=david\n` +
      `# a comment\n`;
    containerFiles[GATEWAY_STATE_PATH] = JSON.stringify({
      platforms: { telegram: { state: "connected", error: null } },
    });
    containerFiles[CHANNEL_DIR_PATH] = JSON.stringify({
      telegram: [
        { chat_id: 12345, title: "Sir's DM", type: "private" },
        { chat_id: -100, title: "Household", type: "group" },
      ],
    });
    telegramGetMeHandle = "alfred_real_bot";

    const { status, payload } = await call(
      "GET",
      "/api/v1/channels/telegram/status",
    );
    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.configured, true);
    assert.equal(payload.state, "configured_running");
    assert.equal(payload.bot_handle, "@alfred_real_bot");
    assert.equal(payload.error, null);
    assert.equal(payload.paired_chats.length, 2);
    assert.equal(payload.paired_chats[0].name, "Sir's DM");
    assert.equal(payload.paired_chats[1].type, "group");

    // The route must have asked Hermes for the per-profile files (not host FS).
    const catCalls = dockerExecCalls.filter(
      (c) => c.command[0] === "sh" && c.command[1] === "-c" && /cat\s+\/hermes-state\/profiles\/main\//.test(c.command[2] ?? ""),
    );
    assert.ok(catCalls.length >= 2, `expected dockerExec cat reads against /hermes-state/profiles/main, got ${JSON.stringify(dockerExecCalls)}`);
  });

  it("PUT /token — valid → vault write + per-profile .env upsert via docker exec + restart", async () => {
    const { status, payload } = await call(
      "PUT",
      "/api/v1/channels/telegram/token",
      { token: VALID_TOKEN, allowed_users: "david" },
    );
    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true);
    assert.equal(payload.state, "configured_starting");

    // Vault canonical store updated.
    assert.equal(vaultStore.length, 1, "vault must hold one item now");
    assert.equal(vaultStore[0].name, "Telegram Bot Token");
    assert.equal(vaultStore[0].login.password, VALID_TOKEN);

    // The .env write went via dockerExecWithStdin → hermes container path.
    assert.equal(dockerExecWithStdinCalls.length, 1, `expected exactly one stdin-piped write, got ${dockerExecWithStdinCalls.length}`);
    const wr = dockerExecWithStdinCalls[0];
    assert.equal(wr.service, "hermes");
    assert.ok(/mv\s+\S+\s+\/hermes-state\/profiles\/main\/\.env$/.test(wr.command[2] ?? ""), `expected atomic mv to per-profile .env, got: ${wr.command.join(" ")}`);
    assert.match(wr.stdin, new RegExp(`TELEGRAM_BOT_TOKEN=${VALID_TOKEN.replace(/[-]/g, "\\-")}`));
    assert.match(wr.stdin, /TELEGRAM_ALLOWED_USERS=david/);

    // Persisted snapshot is now what a later /status would see.
    assert.match(containerFiles[PROFILE_ENV_PATH] ?? "", /TELEGRAM_BOT_TOKEN=/);

    // Hermes restarted.
    const restartCall = dockerComposeCalls.find(
      (c) => c[0] === "restart" && c.includes("hermes"),
    );
    assert.ok(restartCall, `expected hermes restart, got ${JSON.stringify(dockerComposeCalls)}`);
  });

  it("PUT /token — malformed → 400 + no side effects", async () => {
    const { status, payload } = await call(
      "PUT",
      "/api/v1/channels/telegram/token",
      { token: "not-a-real-token" },
    );
    assert.equal(status, 400, JSON.stringify(payload));
    assert.equal(vaultStore.length, 0, "vault must NOT be written on a 400");
    assert.equal(dockerExecWithStdinCalls.length, 0, "no .env write on a 400");
    assert.equal(dockerComposeCalls.length, 0, "no restart on a 400");
  });

  it("DELETE /token → vault wipe + .env keys dropped + restart (siblings preserved)", async () => {
    // Pre-seed everything DELETE has to undo.
    vaultStore.push({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      name: "Telegram Bot Token",
      type: 1,
      login: { username: null, password: VALID_TOKEN, uris: [] },
    });
    containerFiles[PROFILE_ENV_PATH] =
      `TELEGRAM_BOT_TOKEN=${VALID_TOKEN}\n` +
      `TELEGRAM_ALLOWED_USERS=david\n` +
      `TELEGRAM_HOME_CHANNEL=12345\n` +
      `# preserve me\n` +
      `OTHER_KEY=value\n`;

    const { status, payload } = await call(
      "DELETE",
      "/api/v1/channels/telegram/token",
    );
    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true);
    assert.equal(payload.state, "unconfigured");

    assert.equal(vaultStore.length, 0, "vault must be wiped");

    // The new .env content has no telegram keys but keeps the unrelated line.
    assert.equal(dockerExecWithStdinCalls.length, 1);
    const written = dockerExecWithStdinCalls[0].stdin;
    assert.doesNotMatch(written, /TELEGRAM_BOT_TOKEN=\S/);
    assert.doesNotMatch(written, /TELEGRAM_ALLOWED_USERS=\S/);
    assert.doesNotMatch(written, /TELEGRAM_HOME_CHANNEL=\S/);
    assert.match(written, /OTHER_KEY=value/);
    assert.match(written, /# preserve me/);

    const restartCall = dockerComposeCalls.find(
      (c) => c[0] === "restart" && c.includes("hermes"),
    );
    assert.ok(restartCall, "expected hermes restart on DELETE");
  });

  // POST /pair was removed 2026-05-25 — the underlying `hermes pairing mint`
  // CLI subcommand never existed (the real CLI is list/approve/revoke/clear).
  // The unified Telegram card on /channels now uses POST /test (send a real
  // probe) + DELETE /chats/:user_id (revoke an existing pairing). See
  // packages/ctrl/src/api/routes/telegram.ts module header.
  //
  // Direct matchRoute (not the call() helper which asserts registration) so
  // we can assert the *absence* of the route.
  it("POST /pair is NOT registered (route removed 2026-05-25)", () => {
    assert.equal(
      matchRoute("POST", "/api/v1/channels/telegram/pair"),
      null,
      "/api/v1/channels/telegram/pair must NOT be re-introduced",
    );
  });
});

process.on("exit", () => {
  globalThis.fetch = originalFetch;
});
