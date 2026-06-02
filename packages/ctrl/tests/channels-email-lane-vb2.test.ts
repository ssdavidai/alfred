// #120 Lane Vb2 — per-profile AgentMail inbox routes.
//
// Covers the four new routes on /api/v1/channels/email/*:
//   * GET    /status?profile=<slug>            — fail-soft per-profile shape
//   * POST   /provision?profile=<slug>         — calls AgentMail + writes binding
//   * DELETE /inbox?profile=<slug>             — releases inbox + clears env
//   * POST   /test?profile=<slug>              — uses the profile's inbox creds
//
// AgentMail's HTTP API is mocked via a fetch stub keyed off URL path. The
// per-profile .env is written via docker-exec (mocked here to read/write an
// in-memory map).

import { mock, describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── env + path setup ─────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lane-vb2-email-"));
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.VAULT_PATH = path.join(tmp, "vault");
fs.mkdirSync(process.env.VAULT_PATH, { recursive: true });
process.env.ALFRED_DATA_DIR = tmp;
process.env.HERMES_CONFIG_DIR = path.join(tmp, "hermes-state", "profiles");
process.env.HERMES_STATE_DIR_CTRL_VIEW = path.join(tmp, "hermes-state");
fs.mkdirSync(process.env.HERMES_CONFIG_DIR, { recursive: true });
process.env.AGENTMAIL_MASTER_API_KEY = "am_master_test_key";
process.env.AGENTMAIL_SHARED_POD_ID = "pod_test";
process.env.AGENTMAIL_DOMAIN = "test.alfred.black";
process.env.SAAS_HOST = "https://alfred.black";
process.env.AGENTMAIL_BASE_URL = "https://stub.agentmail.test/v0";

// ── AgentMail mock state ─────────────────────────────────────────────────
const agentMailState = {
  inboxes: new Map<string, { inbox_id: string; email: string }>(),
  apiKeys: new Map<string, string>(), // inbox_id → plaintext api_key
  inboxesById: new Map<string, { inbox_id: string; email: string }>(),
  webhooksByKey: new Map<string, { url: string; inbox_ids: string[] }[]>(),
  callLog: [] as Array<{
    method: string;
    path: string;
    auth: string;
    body: any;
  }>,
  failCreate: false,
  failKey: false,
  failDelete: false,
  failSend: false,
  nextSendStatus: 200,
  nextSendBody: { message_id: "msg_abc" } as any,
};

function resetAgentMail(): void {
  agentMailState.inboxes.clear();
  agentMailState.apiKeys.clear();
  agentMailState.inboxesById.clear();
  agentMailState.webhooksByKey.clear();
  agentMailState.callLog = [];
  agentMailState.failCreate = false;
  agentMailState.failKey = false;
  agentMailState.failDelete = false;
  agentMailState.failSend = false;
  agentMailState.nextSendStatus = 200;
  agentMailState.nextSendBody = { message_id: "msg_abc" };
}

// Clear the sentinel profile's .env and binding row so each test starts
// from a clean slate. Used by the suites that share the same sentinel.
function resetSentinel(): void {
  const envPath = path.join(
    process.env.HERMES_CONFIG_DIR!,
    "lane-vb2-sentinel",
    ".env",
  );
  try {
    fs.unlinkSync(envPath);
  } catch {
    /* idempotent */
  }
  // Also strip any prior email bindings for this slug.
  // (Use the db directly — there's no public unbind-by-slug helper.)
  // Imported lazily inside the actual reset call.
}

globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const m = (init?.method ?? "GET").toUpperCase();
  const auth = String(init?.headers?.Authorization || "");
  const body = init?.body ? JSON.parse(init.body) : null;
  agentMailState.callLog.push({ method: m, path: u, auth, body });

  // POST /pods/<pod>/inboxes — create inbox
  const createMatch = u.match(/\/pods\/([^/]+)\/inboxes$/);
  if (createMatch && m === "POST") {
    if (agentMailState.failCreate) {
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    }
    const username = body?.username;
    const domain = body?.domain;
    const inboxId = `inbox_${username}`;
    const email = `${username}@${domain}`;
    const rec = { inbox_id: inboxId, email };
    agentMailState.inboxes.set(username, rec);
    agentMailState.inboxesById.set(inboxId, rec);
    return new Response(JSON.stringify(rec), { status: 201 });
  }

  // POST /inboxes/<id>/api-keys — mint
  const keyMatch = u.match(/\/inboxes\/([^/]+)\/api-keys$/);
  if (keyMatch && m === "POST") {
    if (agentMailState.failKey) {
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    }
    const inboxId = keyMatch[1];
    const apiKey = `am_inbox_${inboxId}_key`;
    agentMailState.apiKeys.set(inboxId, apiKey);
    return new Response(JSON.stringify({ api_key: apiKey }), { status: 201 });
  }

  // GET /webhooks — list
  if (/\/webhooks$/.test(u) && m === "GET") {
    const list = agentMailState.webhooksByKey.get(auth) ?? [];
    return new Response(JSON.stringify({ webhooks: list }), { status: 200 });
  }

  // POST /webhooks — create
  if (/\/webhooks$/.test(u) && m === "POST") {
    const list = agentMailState.webhooksByKey.get(auth) ?? [];
    list.push({ url: body.url, inbox_ids: body.inbox_ids });
    agentMailState.webhooksByKey.set(auth, list);
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  }

  // DELETE /inboxes/<id>
  const delMatch = u.match(/\/inboxes\/([^/]+)$/);
  if (delMatch && m === "DELETE") {
    if (agentMailState.failDelete) {
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    }
    const id = delMatch[1];
    const rec = agentMailState.inboxesById.get(id);
    if (rec) {
      agentMailState.inboxesById.delete(id);
      // best-effort: scrub username-keyed map too
      for (const [u2, r] of agentMailState.inboxes.entries()) {
        if (r.inbox_id === id) agentMailState.inboxes.delete(u2);
      }
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  // POST /inboxes/<id>/messages/send
  const sendMatch = u.match(/\/inboxes\/([^/]+)\/messages\/send$/);
  if (sendMatch && m === "POST") {
    if (agentMailState.failSend) {
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    }
    return new Response(JSON.stringify(agentMailState.nextSendBody), {
      status: agentMailState.nextSendStatus,
    });
  }

  return new Response("not-stubbed: " + u, { status: 501 });
}) as typeof globalThis.fetch;

// ── docker-exec mock — back the per-profile .env with the local FS ──────
//
// Lane V's other tests mock the docker exec helpers similarly. The .env
// file lives at process.env.HERMES_CONFIG_DIR/<slug>/.env on the local
// filesystem; we shell out to `sh -c "cat ... || true"` and
// `sh -c "mkdir -p ... && cat > tmp && mv tmp dst"` — both compile down
// to fs ops here.

mock.module("../src/api/helpers.js", {
  namedExports: {
    HERMES_CONTAINER: "hermes",
    HERMES_CMD: ["hermes"],
    ALFRED_CMD: ["alfred", "--config", "/app/data/config.yaml"],
    OPENCLAW_CMD: ["hermes"],
    OPENCLAW_CONTAINER: "hermes",
    COMPOSE_DIR: "/srv/alfred-black",
    execAsync: async () => ({ stdout: "", stderr: "" }),
    hostExec: async () => "",
    sudoExec: async () => "",
    parseJsonLines: (_raw: string) => [],
    getQuery: (url: string) => new URLSearchParams(url.split("?")[1] || ""),
    validateServiceName: (_name: string) => {},
    dockerComposeCmd: async (_args: string[]) => "",
    dockerExec: async (_container: string, command: string[]) => {
      // We support 'sh -c "cat <path> 2>/dev/null || true"'
      if (command[0] === "sh" && command[1] === "-c") {
        const script = command[2];
        const catMatch = script.match(/^cat (\S+) 2>\/dev\/null \|\| true$/);
        if (catMatch) {
          const p = catMatch[1];
          try {
            return fs.readFileSync(p, "utf-8");
          } catch {
            return "";
          }
        }
      }
      return "";
    },
    dockerExecWithStdin: async (
      _container: string,
      command: string[],
      stdin: string,
    ) => {
      // 'sh -c "mkdir -p <dir> && cat > tmp && mv tmp <path>"'
      if (command[0] === "sh" && command[1] === "-c") {
        const script = command[2];
        // Match: mkdir -p <dir> && cat > <tmp> && mv <tmp> <dst>
        const m = script.match(
          /^mkdir -p (\S+) && cat > (\S+) && mv \S+ (\S+)$/,
        );
        if (m) {
          const [, dir, , dst] = m;
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(dst, stdin, "utf-8");
          return "";
        }
        // Match: cat > <tmp> && mv <tmp> <dst>
        const m2 = script.match(/^cat > (\S+) && mv \S+ (\S+)$/);
        if (m2) {
          const [, , dst] = m2;
          fs.writeFileSync(dst, stdin, "utf-8");
          return "";
        }
      }
      return "";
    },
  },
});

// Seed main's .env so api_server_key reads succeed for the inbound handler.
fs.mkdirSync(path.join(process.env.HERMES_CONFIG_DIR!, "main"), {
  recursive: true,
});
fs.writeFileSync(
  path.join(process.env.HERMES_CONFIG_DIR!, "main/.env"),
  "API_SERVER_KEY=main-key-test\n",
);

const { matchRoute } = await import("../src/api/server.js");
const { registerChannelsEmailRoutes } = await import(
  "../src/api/routes/channelsEmail.js"
);
const { createProfile, archiveProfile, listAllBindings, resolveProfileForChannel } =
  await import("../src/db/agentProfiles.js");
const { getStateDb } = await import("../src/db/state.js");

registerChannelsEmailRoutes();

async function call(
  method: string,
  pathStr: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  // Strip query string for matchRoute, hand the parsed URLSearchParams in.
  const [pure, qs] = pathStr.split("?");
  const matched = matchRoute(method, pure);
  assert.ok(matched, `no route ${method} ${pure}`);
  let status = 0;
  let data: any = null;
  const res: any = {
    writeHead(s: number) {
      status = s;
    },
    end(j: string) {
      try {
        data = JSON.parse(j);
      } catch {
        data = j;
      }
    },
  };
  try {
    await matched.handler({
      res,
      params: matched.params,
      body,
      query: new URLSearchParams(qs || ""),
      req: {} as any,
    });
  } catch (e: any) {
    // The real ctrl-api server.ts catches thrown ApiErrors and translates
    // them to HTTP responses; the test harness mimics that translation here.
    const code = typeof e?.statusCode === "number" ? e.statusCode : 500;
    status = code;
    data = {
      error:
        typeof e?.message === "string"
          ? e.message
          : String(e ?? "unknown error"),
      code: e?.code ?? null,
    };
  }
  return { status, data };
}

describe("#120 Lane Vb2 — per-profile email status", () => {
  before(() => {
    const db = getStateDb();
    // 'main' is seeded by the migration; create a user-facing profile
    // we can test against.
    try {
      createProfile(db, {
        slug: "lane-vb2-sentinel",
        label: "Sentinel",
        model: "stub-model",
      });
    } catch {
      /* already created on previous run in same process */
    }
  });

  beforeEach(() => {
    resetAgentMail();
    resetSentinel();
    // Strip ALL email bindings (default + per-address). The migration's
    // 'binding-default-email' row is re-seeded below for routing.
    const db = getStateDb();
    db.exec(`DELETE FROM channel_profile_binding WHERE channel_kind='email'`);
    db.exec(
      `INSERT OR IGNORE INTO channel_profile_binding
        (id, channel_kind, channel_identity, profile_slug, created_at)
       VALUES
        ('binding-default-email', 'email', NULL, 'main', strftime('%s','now')*1000)`,
    );
  });

  it("status unconfigured → {configured:false, provision_available:true}", async () => {
    const r = await call(
      "GET",
      "/api/v1/channels/email/status?profile=lane-vb2-sentinel",
    );
    assert.equal(r.status, 200);
    assert.equal(r.data.configured, false);
    assert.equal(r.data.profile, "lane-vb2-sentinel");
    assert.equal(r.data.provision_available, true);
  });

  it("status surfaces provision_available:false when AGENTMAIL_MASTER_API_KEY is unset", async () => {
    const saved = process.env.AGENTMAIL_MASTER_API_KEY;
    delete process.env.AGENTMAIL_MASTER_API_KEY;
    try {
      const r = await call(
        "GET",
        "/api/v1/channels/email/status?profile=lane-vb2-sentinel",
      );
      assert.equal(r.data.provision_available, false);
      assert.match(r.data.provision_unavailable_reason ?? "", /MASTER_API_KEY/);
    } finally {
      process.env.AGENTMAIL_MASTER_API_KEY = saved;
    }
  });
});

describe("#120 Lane Vb2 — provision route happy path", () => {
  beforeEach(() => {
    resetAgentMail();
    resetSentinel();
    // Strip ALL email bindings (default + per-address). The migration's
    // 'binding-default-email' row is re-seeded below for routing.
    const db = getStateDb();
    db.exec(`DELETE FROM channel_profile_binding WHERE channel_kind='email'`);
    db.exec(
      `INSERT OR IGNORE INTO channel_profile_binding
        (id, channel_kind, channel_identity, profile_slug, created_at)
       VALUES
        ('binding-default-email', 'email', NULL, 'main', strftime('%s','now')*1000)`,
    );
  });

  it("calls AgentMail to create inbox + mint key, writes .env, writes binding, audits", async () => {
    const r = await call(
      "POST",
      "/api/v1/channels/email/provision?profile=lane-vb2-sentinel",
      { prefix: "sentinel-test" },
    );
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ok, true);
    assert.equal(r.data.address, "sentinel-test@test.alfred.black");
    assert.equal(r.data.inbox_id, "inbox_sentinel-test");
    assert.ok(r.data.binding_id);
    assert.notEqual(r.data.binding_id, "binding-default-email");

    // .env contains the new keys
    const envPath = path.join(
      process.env.HERMES_CONFIG_DIR!,
      "lane-vb2-sentinel",
      ".env",
    );
    const env = fs.readFileSync(envPath, "utf-8");
    assert.match(env, /^AGENTMAIL_INBOX_ID=inbox_sentinel-test$/m);
    assert.match(env, /^AGENTMAIL_INBOX_ADDRESS=sentinel-test@test\.alfred\.black$/m);
    assert.match(env, /^AGENTMAIL_API_KEY=am_inbox_inbox_sentinel-test_key$/m);

    // Binding row exists for the new address
    const bindings = listAllBindings(getStateDb());
    const row = bindings.find(
      (b) =>
        b.channel_kind === "email" &&
        (b.channel_identity || "").toLowerCase() ===
          "sentinel-test@test.alfred.black",
    );
    assert.ok(row, "expected email binding for sentinel-test address");
    assert.equal(row!.profile_slug, "lane-vb2-sentinel");

    // The resolver returns sentinel for the provisioned address
    const resolved = resolveProfileForChannel(
      getStateDb(),
      "email",
      "sentinel-test@test.alfred.black",
    );
    assert.equal(resolved, "lane-vb2-sentinel");

    // Main's default binding still says 'main'
    const mainDefault = resolveProfileForChannel(getStateDb(), "email", null);
    assert.equal(mainDefault, "main");

    // AgentMail was called: 1) inbox create  2) key mint  3) webhook GET 4) webhook POST
    const calls = agentMailState.callLog;
    assert.ok(
      calls.some(
        (c) => c.method === "POST" && /\/pods\/pod_test\/inboxes$/.test(c.path),
      ),
      "expected inbox-create call",
    );
    assert.ok(
      calls.some(
        (c) =>
          c.method === "POST" &&
          /\/inboxes\/inbox_sentinel-test\/api-keys$/.test(c.path),
      ),
      "expected api-key mint call",
    );
  });

  it("404s when the profile doesn't exist", async () => {
    const r = await call(
      "POST",
      "/api/v1/channels/email/provision?profile=no-such-profile",
      { prefix: "ghost" },
    );
    assert.ok(r.status >= 400 && r.status < 500, `got ${r.status}`);
  });

  it("refuses to provision when AGENTMAIL_MASTER_API_KEY is unset", async () => {
    const saved = process.env.AGENTMAIL_MASTER_API_KEY;
    delete process.env.AGENTMAIL_MASTER_API_KEY;
    try {
      const r = await call(
        "POST",
        "/api/v1/channels/email/provision?profile=lane-vb2-sentinel",
        { prefix: "blocked" },
      );
      assert.equal(r.status, 400);
      assert.equal(r.data.code, "master_key_missing");
    } finally {
      process.env.AGENTMAIL_MASTER_API_KEY = saved;
    }
  });

  it("refuses to provision for an archived profile", async () => {
    const db = getStateDb();
    try {
      createProfile(db, {
        slug: "lane-vb2-archived",
        label: "Archived",
        model: "stub-model",
      });
    } catch {
      /* idempotent */
    }
    archiveProfile(db, "lane-vb2-archived");
    const r = await call(
      "POST",
      "/api/v1/channels/email/provision?profile=lane-vb2-archived",
      {},
    );
    assert.ok(r.status >= 400 && r.status < 500);
  });
});

describe("#120 Lane Vb2 — DELETE inbox", () => {
  beforeEach(() => {
    resetAgentMail();
    resetSentinel();
    // Strip ALL email bindings (default + per-address). The migration's
    // 'binding-default-email' row is re-seeded below for routing.
    const db = getStateDb();
    db.exec(`DELETE FROM channel_profile_binding WHERE channel_kind='email'`);
    db.exec(
      `INSERT OR IGNORE INTO channel_profile_binding
        (id, channel_kind, channel_identity, profile_slug, created_at)
       VALUES
        ('binding-default-email', 'email', NULL, 'main', strftime('%s','now')*1000)`,
    );
  });

  it("releases the AgentMail inbox, wipes the .env, removes the binding", async () => {
    // Re-provision so we have an inbox to delete.
    const prov = await call(
      "POST",
      "/api/v1/channels/email/provision?profile=lane-vb2-sentinel",
      { prefix: "sentinel-delete-me" },
    );
    assert.equal(prov.status, 200, JSON.stringify(prov.data));
    const address = prov.data.address;

    const r = await call(
      "DELETE",
      "/api/v1/channels/email/inbox?profile=lane-vb2-sentinel",
    );
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ok, true);
    assert.equal(r.data.inbox_address, address);
    assert.equal(r.data.binding_removed, true);
    assert.equal(r.data.upstream_released, "ok");

    // .env keys gone
    const envPath = path.join(
      process.env.HERMES_CONFIG_DIR!,
      "lane-vb2-sentinel",
      ".env",
    );
    const env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
    assert.doesNotMatch(env, /^AGENTMAIL_INBOX_ID=/m);
    assert.doesNotMatch(env, /^AGENTMAIL_INBOX_ADDRESS=/m);

    // Binding gone — resolver falls back to main
    const resolved = resolveProfileForChannel(getStateDb(), "email", address);
    assert.equal(resolved, "main");
  });

  it("is idempotent on a profile with no inbox", async () => {
    // Profile created in earlier test; fresh resetAgentMail; no inbox.
    const r = await call(
      "DELETE",
      "/api/v1/channels/email/inbox?profile=lane-vb2-sentinel",
    );
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
  });
});

describe("#120 Lane Vb2 — test send", () => {
  beforeEach(() => {
    resetAgentMail();
    resetSentinel();
    // Strip ALL email bindings (default + per-address). The migration's
    // 'binding-default-email' row is re-seeded below for routing.
    const db = getStateDb();
    db.exec(`DELETE FROM channel_profile_binding WHERE channel_kind='email'`);
    db.exec(
      `INSERT OR IGNORE INTO channel_profile_binding
        (id, channel_kind, channel_identity, profile_slug, created_at)
       VALUES
        ('binding-default-email', 'email', NULL, 'main', strftime('%s','now')*1000)`,
    );
  });

  it("uses the profile's inbox creds (not main's) for outbound", async () => {
    const prov = await call(
      "POST",
      "/api/v1/channels/email/provision?profile=lane-vb2-sentinel",
      { prefix: "sentinel-tst" },
    );
    assert.equal(prov.status, 200);
    // Reset call log so we observe ONLY the test send.
    agentMailState.callLog = [];

    const r = await call(
      "POST",
      "/api/v1/channels/email/test?profile=lane-vb2-sentinel",
      { to: "ops@example.com" },
    );
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ok, true);
    assert.equal(r.data.from, "sentinel-tst@test.alfred.black");
    assert.equal(r.data.to, "ops@example.com");

    // The send call MUST have used the inbox-scoped key, not the master key.
    const sendCall = agentMailState.callLog.find((c) =>
      /\/inboxes\/inbox_sentinel-tst\/messages\/send$/.test(c.path),
    );
    assert.ok(sendCall, "expected send call");
    assert.equal(
      sendCall!.auth,
      "Bearer am_inbox_inbox_sentinel-tst_key",
      "send must auth with profile's inbox key, not master",
    );
  });

  it("refuses test on a profile with no inbox", async () => {
    // No provision in this test — fresh slate.
    const r = await call(
      "POST",
      "/api/v1/channels/email/test?profile=lane-vb2-sentinel",
      { to: "ops@example.com" },
    );
    assert.equal(r.status, 400);
    assert.equal(r.data.code, "not_configured");
  });
});

describe("#120 Lane Vb2 — inbound route honours per-profile binding", () => {
  beforeEach(() => {
    resetAgentMail();
    process.env.AGENTMAIL_WEBHOOK_TOKEN = "test-token";
    // Inbound handler reads API_SERVER_KEY from the resolved profile's .env
    // to auth its fire-and-forget POST /v1/runs. Seed both main + sentinel
    // so neither path falls off the end. The .env file is preserved by the
    // provision route's writeProfileEmailEnvKeys which keeps unrelated keys.
    const sentDir = path.join(process.env.HERMES_CONFIG_DIR!, "lane-vb2-sentinel");
    fs.mkdirSync(sentDir, { recursive: true });
    fs.writeFileSync(
      path.join(sentDir, ".env"),
      "API_SERVER_KEY=sentinel-key-test\n",
    );
  });

  it("inbound to the provisioned address resolves to the sentinel profile", async () => {
    const prov = await call(
      "POST",
      "/api/v1/channels/email/provision?profile=lane-vb2-sentinel",
      { prefix: "sentinel-route" },
    );
    assert.equal(prov.status, 200);
    const address = prov.data.address;

    // Webhook fetch is fire-and-forget; we just check the 202 + profile.
    const r = await call(
      "POST",
      "/api/v1/channels/email/inbound?token=test-token",
      {
        message: {
          to: [address],
          from_: ["smoke@example.com"],
          subject: "test",
          text: "hi",
          message_id: "m1",
          thread_id: "t1",
        },
      },
    );
    assert.equal(r.status, 202);
    assert.equal(r.data.accepted, true);
    assert.equal(r.data.profile, "lane-vb2-sentinel");
  });

  it("inbound to a not-bound address falls back to main", async () => {
    const r = await call(
      "POST",
      "/api/v1/channels/email/inbound?token=test-token",
      {
        message: {
          to: ["ghost@test.alfred.black"],
          from_: ["smoke@example.com"],
          subject: "test",
          text: "hi",
          message_id: "m2",
          thread_id: "t2",
        },
      },
    );
    assert.equal(r.status, 202);
    assert.equal(r.data.profile, "main");
  });
});
