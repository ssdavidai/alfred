// F13 — standing rules resolve to an AGENTS.md sentinel section.
//
// The web standing-rules editor wrote RULES.md, but ctrl's ALLOWED_FILES had no
// RULES.md (it listed KNOWN_CONTACTS.md), so every Save Rules → 400 "Invalid
// workspace file". Hermes has no RULES.md loader; the right home is a sentinel
// block inside AGENTS.md (already allow-listed). This resolves the web↔ctrl
// drift: a RULES.md read/write is accepted and aliased onto the AGENTS.md
// `## Standing Rules` sentinel block, preserving everything outside the markers.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-rules-"));
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";
fs.mkdirSync(process.env.VAULT_PATH, { recursive: true });

const { matchRoute } = await import("../src/api/server.js");
const { registerWorkspaceRoutes } = await import("../src/api/routes/workspace.js");
registerWorkspaceRoutes();

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

describe("workspace standing rules → AGENTS.md sentinel (F13)", () => {
  it("does NOT 400 on a RULES.md write (no longer rejected)", async () => {
    const { status } = await call("PUT", "/api/v1/admin/workspace/RULES.md", {
      content: "# Standing rules\n\n- Never schedule meetings before 10am\n",
    });
    assert.equal(status, 200, "RULES.md write must be accepted (aliased to AGENTS.md section)");
  });

  it("the rules land in an AGENTS.md sentinel block", async () => {
    const { status, payload } = await call("GET", "/api/v1/admin/workspace/AGENTS.md");
    assert.equal(status, 200);
    assert.ok(payload.content.includes("BEGIN STANDING RULES"), "AGENTS.md must carry the sentinel block");
    assert.ok(payload.content.includes("Never schedule meetings before 10am"), "the rule must be inside AGENTS.md");
  });

  it("a RULES.md read returns the rules from the AGENTS.md sentinel block", async () => {
    const { status, payload } = await call("GET", "/api/v1/admin/workspace/RULES.md");
    assert.equal(status, 200);
    assert.ok(payload.content.includes("Never schedule meetings before 10am"), "RULES.md read must reflect the AGENTS.md section");
  });

  it("preserves AGENTS.md content outside the sentinel block", async () => {
    // Seed AGENTS.md with surrounding content, then write rules, then verify it survived.
    await call("PUT", "/api/v1/admin/workspace/AGENTS.md", {
      content: "# Alfred instructions\n\nYou are Alfred.\n",
    });
    await call("PUT", "/api/v1/admin/workspace/RULES.md", {
      content: "# Standing rules\n\n- Rule X\n",
    });
    const { payload } = await call("GET", "/api/v1/admin/workspace/AGENTS.md");
    assert.ok(payload.content.includes("You are Alfred."), "surrounding AGENTS.md content must be preserved");
    assert.ok(payload.content.includes("Rule X"), "the new rule must be present");
  });
});
