// F63 (C16) — approval secret reveal-once + rotate.
//
// GET /api/v1/claude-setup echoed MCP_APPROVAL_SECRET (and
// vault_login.master_password) cleartext on every load — a long-lived bearer
// secret returned in full on every dashboard render. C16: never echo the value
// on GET (approval_secret: null + approval_secret_set bool + last_rotated_at);
// add POST /api/v1/claude-setup/approval-secret/rotate that mints a fresh value,
// writes .env, restarts mcp-server, and returns the value EXACTLY once.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-secret-"));
process.env.COMPOSE_DIR = tmp;
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";
process.env.DOMAIN = "test.alfred.black";
fs.mkdirSync(path.join(tmp, "streams"), { recursive: true });

// Seed a .env carrying the existing approval secret (and an unrelated key to
// verify surgical update preserves it).
const SECRET = "a".repeat(64);
fs.writeFileSync(path.join(tmp, ".env"), `OTHER_KEY=keep-me\nMCP_APPROVAL_SECRET=${SECRET}\n`, "utf-8");
process.env.MCP_APPROVAL_SECRET = SECRET;

const { matchRoute } = await import("../src/api/server.js");
const { registerClaudeSetupRoutes } = await import("../src/api/routes/claudeSetup.js");
registerClaudeSetupRoutes();

async function call(method: string, pathname: string, body?: unknown): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, pathname);
  assert.ok(m, `${method} ${pathname} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(json?: string) { payload = json ? JSON.parse(json) : undefined; },
  } as unknown as ServerResponse;
  await m!.handler({ req: { url: pathname } as any, res, params: m!.params, body, query: new URLSearchParams() });
  return { status, payload };
}

describe("claude-setup approval secret (F63/C16)", () => {
  after(() => { delete process.env.MCP_APPROVAL_SECRET; });

  it("GET never echoes the cleartext secret", async () => {
    const { status, payload } = await call("GET", "/api/v1/claude-setup");
    assert.equal(status, 200);
    assert.equal(payload.approval_secret, null, "approval_secret must be null on GET");
    assert.equal(payload.approval_secret_set, true, "approval_secret_set must reflect that a secret exists");
    assert.ok("last_rotated_at" in payload, "GET must carry last_rotated_at");
  });

  it("GET never echoes vault_login.master_password (when present)", async () => {
    // master_password should be null even though VAULTWARDEN_BW_PASSWORD set.
    process.env.VAULTWARDEN_BW_PASSWORD = "vw-secret-123";
    try {
      const { payload } = await call("GET", "/api/v1/claude-setup");
      if (payload.vault_login) {
        assert.equal(payload.vault_login.master_password, null, "master_password must not be echoed");
        assert.equal(payload.vault_login.master_password_set, true, "vault_login must signal the password is set");
      }
    } finally {
      delete process.env.VAULTWARDEN_BW_PASSWORD;
    }
  });

  it("POST rotate mints a fresh value, returns it once, and writes .env", async () => {
    const { status, payload } = await call("POST", "/api/v1/claude-setup/approval-secret/rotate");
    assert.equal(status, 200, `rotate must 200, got ${status}: ${JSON.stringify(payload)}`);
    assert.ok(typeof payload.approval_secret === "string" && payload.approval_secret.length >= 32, "rotate returns the new value once");
    assert.notEqual(payload.approval_secret, SECRET, "rotated value must differ from the old");
    // .env updated, unrelated key preserved.
    const env = fs.readFileSync(path.join(tmp, ".env"), "utf-8");
    assert.ok(env.includes(`MCP_APPROVAL_SECRET=${payload.approval_secret}`), ".env must carry the new secret");
    assert.ok(env.includes("OTHER_KEY=keep-me"), "unrelated keys must be preserved");
  });
});
