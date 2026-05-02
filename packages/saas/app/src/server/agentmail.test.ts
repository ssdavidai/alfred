/**
 * Unit tests for AgentMail per-tenant inbox provisioning.
 *
 * Run via:
 *   cd packages/saas/app
 *   npx -y tsx --test src/server/agentmail.test.ts
 *
 * or `make test-saas-unit` from repo root.
 *
 * These guard the worker-side provisioning entry point added in #686. The
 * mint API itself is exercised against a mocked `fetch` so the tests have
 * no external dependency.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildInboxUsername,
  buildFallbackUsername,
  isAgentMailEnabled,
  ensureInstanceHasAgentMail,
} from "./agentmail";

// Encryption needs a key (encryptApiKey is called inside
// provisionAgentMailForTenant). Set a deterministic one for the tests.
process.env.COLUMN_ENCRYPTION_KEY =
  process.env.COLUMN_ENCRYPTION_KEY ||
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
  delete process.env.AGENTMAIL_ENABLED;
  delete process.env.AGENTMAIL_MASTER_API_KEY;
  delete process.env.AGENTMAIL_SHARED_POD_ID;
});

test("buildInboxUsername strips and normalises common email patterns", () => {
  assert.equal(buildInboxUsername("david@szabostuban.com"), "alfred.david");
  assert.equal(buildInboxUsername("daveszab@gmail.com"), "alfred.daveszab");
  assert.equal(
    buildInboxUsername("david.szabostuban@gmail.com"),
    "alfred.david.szabostuban",
  );
  assert.equal(buildInboxUsername("Raj313@Gmail.com"), "alfred.raj313");
});

test("buildInboxUsername handles edge cases without crashing", () => {
  assert.equal(buildInboxUsername(""), "alfred.user");
  assert.equal(buildInboxUsername(null), "alfred.user");
  assert.equal(buildInboxUsername(undefined), "alfred.user");
  // local part collapses to empty after normalisation → "user" fallback
  assert.equal(buildInboxUsername("___@x.com"), "alfred.user");
});

test("buildFallbackUsername yields a stable prefix + 3-digit suffix", () => {
  const fb = buildFallbackUsername("david@szabostuban.com");
  assert.match(fb, /^alfred\.david\d{3}$/);
});

test("isAgentMailEnabled needs ENABLED + master key + pod id together", () => {
  assert.equal(isAgentMailEnabled(), false);
  process.env.AGENTMAIL_ENABLED = "true";
  assert.equal(isAgentMailEnabled(), false);
  process.env.AGENTMAIL_MASTER_API_KEY = "k";
  assert.equal(isAgentMailEnabled(), false);
  process.env.AGENTMAIL_SHARED_POD_ID = "p";
  assert.equal(isAgentMailEnabled(), true);
  process.env.AGENTMAIL_ENABLED = "false";
  assert.equal(isAgentMailEnabled(), false);
});

test("ensureInstanceHasAgentMail returns 'skipped' when feature flag off", async () => {
  let updated = false;
  const result = await ensureInstanceHasAgentMail({
    prismaInstance: {
      update: async () => {
        updated = true;
        return {};
      },
    },
    instance: { id: "i1", userId: "u1" },
    user: { id: "u1", email: "x@y.com" },
  });
  assert.equal(result.status, "skipped");
  assert.equal(updated, false, "no DB write when flag off");
});

test("ensureInstanceHasAgentMail reuses persisted creds without minting", async () => {
  process.env.AGENTMAIL_ENABLED = "true";
  process.env.AGENTMAIL_MASTER_API_KEY = "master-key";
  process.env.AGENTMAIL_SHARED_POD_ID = "pod-1";

  // Encrypt a known API key so reuse can decrypt it
  const { encryptApiKey } = await import("./columnCrypto");
  const encrypted = encryptApiKey("inbox-scoped-key");

  let updated = false;
  let fetchCalled = false;
  const realFetch = global.fetch;
  global.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 500 });
  }) as any;

  try {
    const result = await ensureInstanceHasAgentMail({
      prismaInstance: {
        update: async () => {
          updated = true;
          return {};
        },
      },
      instance: {
        id: "i1",
        userId: "u1",
        agentmailInboxId: "ibx_existing",
        agentmailInboxAddress: "alfred.x@mail.alfred.black",
        agentmailInboxApiKey: encrypted,
      },
      user: { id: "u1", email: "x@y.com" },
    });
    assert.equal(result.status, "reused");
    assert.equal(result.inboxId, "ibx_existing");
    assert.equal(result.inboxAddress, "alfred.x@mail.alfred.black");
    assert.equal(result.apiKey, "inbox-scoped-key");
    assert.equal(fetchCalled, false, "must not call AgentMail API on reuse");
    assert.equal(updated, false, "must not write to DB on reuse");
  } finally {
    global.fetch = realFetch;
  }
});

test("ensureInstanceHasAgentMail mints fresh creds + persists on success", async () => {
  process.env.AGENTMAIL_ENABLED = "true";
  process.env.AGENTMAIL_MASTER_API_KEY = "master-key";
  process.env.AGENTMAIL_SHARED_POD_ID = "pod-1";

  let inboxBody: any = null;
  let keyBody: any = null;
  const realFetch = global.fetch;
  global.fetch = (async (url: string, init: any) => {
    const u = String(url);
    if (u.endsWith(`/pods/pod-1/inboxes`)) {
      inboxBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          inbox_id: "ibx_new_123",
          email: "alfred.raj313@mail.alfred.black",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.endsWith(`/inboxes/ibx_new_123/api-keys`)) {
      keyBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ api_key: "am_key_secret_321" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as any;

  let persisted: any = null;
  try {
    const result = await ensureInstanceHasAgentMail({
      prismaInstance: {
        update: async (args: any) => {
          persisted = args;
          return {};
        },
      },
      instance: { id: "i1", userId: "u1" },
      user: { id: "u1", email: "raj313@gmail.com" },
    });
    assert.equal(result.status, "ok");
    assert.equal(result.inboxId, "ibx_new_123");
    assert.equal(result.inboxAddress, "alfred.raj313@mail.alfred.black");
    assert.equal(result.apiKey, "am_key_secret_321");
    assert.deepEqual(inboxBody?.username, "alfred.raj313");
    assert.equal(inboxBody?.client_id, "tenant-u1");
    assert.match(keyBody?.name, /^tenant-u1-main-/);
    assert.equal(persisted?.where?.id, "i1");
    assert.equal(persisted?.data?.agentmailInboxId, "ibx_new_123");
    assert.equal(persisted?.data?.agentmailProvisionStatus, "ok");
    // Encrypted blob, not plaintext
    assert.notEqual(persisted?.data?.agentmailInboxApiKey, "am_key_secret_321");
  } finally {
    global.fetch = realFetch;
  }
});

test("ensureInstanceHasAgentMail captures failure on Instance row + returns 'failed'", async () => {
  process.env.AGENTMAIL_ENABLED = "true";
  process.env.AGENTMAIL_MASTER_API_KEY = "master-key";
  process.env.AGENTMAIL_SHARED_POD_ID = "pod-1";

  const realFetch = global.fetch;
  global.fetch = (async () =>
    new Response(JSON.stringify({ error: "rate limit" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    })) as any;

  let persisted: any = null;
  try {
    const result = await ensureInstanceHasAgentMail({
      prismaInstance: {
        update: async (args: any) => {
          persisted = args;
          return {};
        },
      },
      instance: { id: "i1", userId: "u1" },
      user: { id: "u1", email: "raj313@gmail.com" },
    });
    assert.equal(result.status, "failed");
    assert.match(result.error || "", /429|rate/);
    assert.equal(persisted?.data?.agentmailProvisionStatus, "failed");
    assert.match(persisted?.data?.agentmailProvisionError || "", /429|rate/);
    // VM provisioning continues — the helper does not throw.
  } finally {
    global.fetch = realFetch;
  }
});
