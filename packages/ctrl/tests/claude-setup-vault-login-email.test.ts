// Vaultwarden login email — surfaced on /settings#agent (Vault Login card).
//
// The Vaultwarden account on the merged single-VM stack is registered by the
// init-signup container with BW_USER=${ACME_EMAIL}; that is the ONLY email
// the Vaultwarden users table ever sees. OWNER_EMAIL is a different
// identity — the principal's email used for outbound attribution / the
// Brief — and Vaultwarden has no row for it. Surfacing OWNER_EMAIL on
// the Vault Login card told the principal "log into Vaultwarden as
// <yourself>", which fails with "invalid credentials" on every tenant
// (Sir live-confirmed on zsolt.alfred.black, 2026-05-27). The password
// shown is correct, but it's the password for ACME_EMAIL, not OWNER_EMAIL.
//
// This test pins the resolution order:
//   BW_USER  (a future stack might set it explicitly)
//   ACME_EMAIL  (the merged-stack signup identity — actual VW account)
//   OWNER_EMAIL  (last-resort fallback for any pre-merge tenant that did
//                 mirror OWNER_EMAIL into the signup payload)
//
// Regression for the Vaultwarden login email mismatch.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-login-email-"));
process.env.COMPOSE_DIR = tmp;
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";
process.env.DOMAIN = "test.alfred.black";
fs.mkdirSync(path.join(tmp, "streams"), { recursive: true });
fs.writeFileSync(path.join(tmp, ".env"), "PLACEHOLDER=1\n", "utf-8");

const { matchRoute } = await import("../src/api/server.js");
const { registerClaudeSetupRoutes } = await import("../src/api/routes/claudeSetup.js");
registerClaudeSetupRoutes();

async function call(method: string, pathname: string): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, pathname);
  assert.ok(m, `${method} ${pathname} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(json?: string) { payload = json ? JSON.parse(json) : undefined; },
  } as unknown as ServerResponse;
  await m!.handler({ req: { url: pathname } as any, res, params: m!.params, body: undefined, query: new URLSearchParams() });
  return { status, payload };
}

function clearEmailEnv() {
  delete process.env.BW_USER;
  delete process.env.ACME_EMAIL;
  delete process.env.OWNER_EMAIL;
  delete process.env.VAULTWARDEN_BW_PASSWORD;
  delete process.env.BW_PASSWORD;
}

describe("claude-setup vault_login.email resolution", () => {
  after(clearEmailEnv);

  it("merged-stack default: prefers ACME_EMAIL when BW_USER is unset (the bug fix)", async () => {
    clearEmailEnv();
    // Mirrors the live merged stack: BW_USER is never written to .env,
    // ACME_EMAIL is the bootstrap-signup identity, OWNER_EMAIL is the
    // principal's identity (which Vaultwarden has no row for).
    process.env.ACME_EMAIL = "operator@example.com";
    process.env.OWNER_EMAIL = "principal@example.com";
    process.env.VAULTWARDEN_BW_PASSWORD = "vw-secret";
    const { payload } = await call("GET", "/api/v1/claude-setup");
    assert.ok(payload.vault_login, "vault_login must be present when password is set");
    assert.equal(
      payload.vault_login.email,
      "operator@example.com",
      "must surface ACME_EMAIL (the actual VW account), NOT OWNER_EMAIL — that's the bug",
    );
  });

  it("BW_USER wins when explicitly set (future-stack override)", async () => {
    clearEmailEnv();
    process.env.BW_USER = "explicit@example.com";
    process.env.ACME_EMAIL = "operator@example.com";
    process.env.OWNER_EMAIL = "principal@example.com";
    process.env.VAULTWARDEN_BW_PASSWORD = "vw-secret";
    const { payload } = await call("GET", "/api/v1/claude-setup");
    assert.equal(payload.vault_login.email, "explicit@example.com");
  });

  it("falls back to OWNER_EMAIL only when neither BW_USER nor ACME_EMAIL is set", async () => {
    clearEmailEnv();
    process.env.OWNER_EMAIL = "principal@example.com";
    process.env.VAULTWARDEN_BW_PASSWORD = "vw-secret";
    const { payload } = await call("GET", "/api/v1/claude-setup");
    assert.equal(payload.vault_login.email, "principal@example.com");
  });

  it("vault_login is null when no password is provisioned", async () => {
    clearEmailEnv();
    process.env.ACME_EMAIL = "operator@example.com";
    const { payload } = await call("GET", "/api/v1/claude-setup");
    assert.equal(payload.vault_login, null);
  });
});
