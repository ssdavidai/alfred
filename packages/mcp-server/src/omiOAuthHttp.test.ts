import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

test("Omi OAuth without resource completes PKCE and cannot initialize another app", async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as any).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const base = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_URL: base,
      TENANT_LABEL: "test",
      DATA_DIR: mkdtempSync(join(tmpdir(), "omi-oauth-")),
      CTRL_URL: "http://127.0.0.1:1",
      AAS_API_KEY: "test-controller-key",
      MCP_APPROVAL_SECRET: "test-approval-secret",
    },
    stdio: "ignore",
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + "/health")).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ready, "MCP server starts");
    const post = async (p: string, b: unknown) =>
      fetch(base + p, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(b),
      });
    const registered = await post("/register", {
      client_name: "Omi test",
      redirect_uris: ["https://api.omi.me/v1/apps/mcp/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    assert.equal(registered.status, 201);
    const client = (await registered.json()) as any;
    const verifier = "a".repeat(64),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://api.omi.me/v1/apps/mcp/callback",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "test-state",
    });
    const approval = await fetch(base + "/authorize?" + params);
    assert.equal(approval.status, 200);
    const html = await approval.text();
    assert.match(html, /name="app" value="omi"/);
    const form = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://api.omi.me/v1/apps/mcp/callback",
      code_challenge: challenge,
      app: "omi",
      state: "test-state",
      resource: base + "/omi/mcp",
      secret: "test-approval-secret",
    });
    const approved = await fetch(base + "/approve", {
      method: "POST",
      body: form,
      redirect: "manual",
    });
    assert.equal(approved.status, 302);
    const code = new URL(approved.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const tokenResponse = await fetch(base + "/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: "https://api.omi.me/v1/apps/mcp/callback",
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = (await tokenResponse.json()) as any;
    const init = (app: string, token: string) =>
      fetch(base + "/" + app + "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        }),
      });
    assert.equal((await init("omi", tokens.access_token)).status, 200);
    assert.equal((await init("execute", tokens.access_token)).status, 403);
    assert.equal((await init("vaultwarden", tokens.access_token)).status, 403);
    assert.equal((await init("omi", "wrong-token")).status, 401);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((r) => child.once("exit", () => r()));
  }
});
