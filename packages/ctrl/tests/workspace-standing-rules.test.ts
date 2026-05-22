// F13 — standing rules resolve to an AGENTS.md sentinel section.
//
// The web standing-rules editor wrote RULES.md, but ctrl's ALLOWED_FILES had no
// RULES.md (it listed KNOWN_CONTACTS.md), so every Save Rules → 400 "Invalid
// workspace file". Hermes has no RULES.md loader; the right home is a sentinel
// block inside AGENTS.md (already allow-listed). This resolves the web↔ctrl
// drift: a RULES.md read/write is accepted and aliased onto the AGENTS.md
// `## Standing Rules` sentinel block, preserving everything outside the markers.
//
// F14/C13 — destination split. SOUL.md and AGENTS.md (and therefore the
// RULES.md→AGENTS.md alias) are loaded by the Hermes MAIN gateway, so they must
// be written to the main profile dir (<HERMES_CONFIG_DIR>/main/), NOT /vault.
// The NON-gateway-loaded files (MEMORY.md / USER.md / TOOLS.md /
// KNOWN_CONTACTS.md) must stay at the vault root. These tests pin both halves.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-rules-"));
const VAULT_DIR = path.join(tmp, "vault");
const HERMES_PROFILES_DIR = path.join(tmp, "hermes-profiles");
const MAIN_PROFILE_DIR = path.join(HERMES_PROFILES_DIR, "main");
process.env.VAULT_PATH = VAULT_DIR;
process.env.HERMES_CONFIG_DIR = HERMES_PROFILES_DIR;
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";
fs.mkdirSync(VAULT_DIR, { recursive: true });

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

// ---------------------------------------------------------------------------
// F14/C13 — gateway-loaded files target the Hermes main profile dir; the rest
// stay at the vault root. We assert the actual on-disk destination of each PUT.
// ---------------------------------------------------------------------------
describe("workspace destination split → Hermes main profile dir (F14/C13)", () => {
  it("SOUL.md is written to <HERMES_CONFIG_DIR>/main/SOUL.md (where the gateway reads it), not /vault", async () => {
    const content = "You are Alfred, the principal's chief of staff.\n";
    const { status } = await call("PUT", "/api/v1/admin/workspace/SOUL.md", { content });
    assert.equal(status, 200);
    assert.equal(
      fs.readFileSync(path.join(MAIN_PROFILE_DIR, "SOUL.md"), "utf-8"),
      content,
      "SOUL.md must land in the main profile dir",
    );
    assert.ok(
      !fs.existsSync(path.join(VAULT_DIR, "SOUL.md")),
      "SOUL.md must NOT be written to the vault root",
    );
  });

  it("AGENTS.md is written to <HERMES_CONFIG_DIR>/main/AGENTS.md (the gateway TERMINAL_CWD), not /vault", async () => {
    const content = "# Alfred — instructions\n\nAlways defer to Sir.\n";
    const { status } = await call("PUT", "/api/v1/admin/workspace/AGENTS.md", { content });
    assert.equal(status, 200);
    assert.equal(
      fs.readFileSync(path.join(MAIN_PROFILE_DIR, "AGENTS.md"), "utf-8"),
      content,
      "AGENTS.md must land in the main profile dir",
    );
    assert.ok(
      !fs.existsSync(path.join(VAULT_DIR, "AGENTS.md")),
      "AGENTS.md must NOT be written to the vault root",
    );
  });

  it("a RULES.md PUT upserts the sentinel block in the PROFILE-dir AGENTS.md, not a vault AGENTS.md", async () => {
    const { status } = await call("PUT", "/api/v1/admin/workspace/RULES.md", {
      content: "# Standing rules\n\n- No calls during dinner\n",
    });
    assert.equal(status, 200);
    const agents = fs.readFileSync(path.join(MAIN_PROFILE_DIR, "AGENTS.md"), "utf-8");
    assert.ok(agents.includes("BEGIN STANDING RULES"), "sentinel block must be in the profile-dir AGENTS.md");
    assert.ok(agents.includes("No calls during dinner"), "the rule must be in the profile-dir AGENTS.md");
    assert.ok(
      !fs.existsSync(path.join(VAULT_DIR, "AGENTS.md")),
      "the RULES.md alias must NOT write a vault-root AGENTS.md",
    );
  });

  for (const f of ["MEMORY.md", "USER.md", "TOOLS.md", "KNOWN_CONTACTS.md"]) {
    it(`${f} stays at the vault root (NOT gateway-loaded — no regression)`, async () => {
      const content = `# ${f}\n\nsome ${f} content\n`;
      const { status } = await call("PUT", `/api/v1/admin/workspace/${f}`, { content });
      assert.equal(status, 200);
      assert.equal(
        fs.readFileSync(path.join(VAULT_DIR, f), "utf-8"),
        content,
        `${f} must land in the vault root`,
      );
      assert.ok(
        !fs.existsSync(path.join(MAIN_PROFILE_DIR, f)),
        `${f} must NOT be written to the main profile dir`,
      );
    });
  }
});
