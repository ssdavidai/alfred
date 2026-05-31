// profiles.bootstrap — unit tests for #206 Q5 (per-profile bootstrap render).
//
// POST /api/v1/agent-profiles with optional {role, tone, first_actions[]}
// renders RULES.md + daybook.md into the profile dir. SOUL.md is unchanged
// (Hermes supervisor consolidates persona_template separately).
//
// Same in-process harness as profiles-mcp-catalog.test.ts.

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── isolate state.db + hermes-state ────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-bootstrap-"));
process.env.STATE_DB_PATH = path.join(TMP, "state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.VAULT_PATH = path.join(TMP, "vault");
process.env.ALFRED_DATA_DIR = TMP;
process.env.HERMES_CONFIG_DIR = path.join(TMP, "profiles");
process.env.HERMES_STATE_DIR_CTRL_VIEW = path.join(TMP, "hermes-state");
process.env.INGEST_DB_PATH = path.join(TMP, "ingest.db");
fs.mkdirSync(process.env.HERMES_CONFIG_DIR, { recursive: true });

// ── mock supervisor ────────────────────────────────────────────────────────
mock.module("../src/hermes/supervisor.js", {
  namedExports: {
    writeSupervisorRegistry: () => {},
    nudgeHermesSupervisor: () => true,
    restartProfile: () => ({ scope: "per-profile", attempted: true, warning: null }),
    REGISTRY_PATH: path.join(TMP, "hermes-state", "profiles", "_registry.json"),
  },
});

const { matchRoute } = await import("../src/api/server.js");
const { registerProfileRoutes } = await import("../src/api/routes/profiles.js");
const { handleError } = await import("../src/api/errors.js");

registerProfileRoutes();

// ── http test helper ───────────────────────────────────────────────────────
function invokeRoute(
  method: string,
  url: string,
  body?: unknown,
  params: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const matched = matchRoute(method, url);
  assert.ok(matched, `${method} ${url} must be registered`);
  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    let status = 200;
    const res: any = {
      statusCode: 200,
      setHeader() {},
      writeHead(s: number) { status = s; },
      end(c?: any) {
        if (c !== undefined) chunks.push(c);
        try {
          const raw = Buffer.concat(
            chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c)))),
          ).toString();
          resolve({ status, body: raw ? JSON.parse(raw) : {} });
        } catch (e) { reject(e); }
      },
      write(c: any) { chunks.push(c); },
    };
    const merged = { ...(matched!.params ?? {}), ...params };
    Promise.resolve(
      matched!.handler({
        req: {} as any, res, params: merged,
        query: new URLSearchParams(), body: body ?? undefined,
      }),
    ).catch((err) => {
      try { handleError(res, err); } catch (e2) { reject(e2); }
    });
  });
}

const profileDir = (slug: string) =>
  path.join(process.env.HERMES_CONFIG_DIR!, slug);

/**
 * Helper: archive a profile to free its allocated port slot. The user-port
 * range is only 18794..18799 (6 slots), so successful creates need to be
 * cleaned up between tests to avoid `no free user-facing port` 409s.
 */
async function archive(slug: string): Promise<void> {
  await invokeRoute("DELETE", "/api/v1/agent-profiles/:slug", undefined, {
    slug,
  });
}

after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

// ── tests ──────────────────────────────────────────────────────────────────

describe("POST /api/v1/agent-profiles — Q5 bootstrap render", () => {
  it("writes RULES.md when role is provided (no daybook.md when first_actions empty)", async () => {
    const slug = "cratchit-role";
    const { status } = await invokeRoute(
      "POST",
      "/api/v1/agent-profiles",
      {
        slug,
        label: "Cratchit",
        model: "claude-sonnet-4-6",
        role: "household bookkeeper",
      },
    );
    assert.equal(status, 202);
    const rules = path.join(profileDir(slug), "RULES.md");
    assert.ok(fs.existsSync(rules), "RULES.md must be written");
    const content = fs.readFileSync(rules, "utf-8");
    assert.match(content, /# Rules for Cratchit/);
    assert.match(content, /household bookkeeper/);
    // daybook.md NOT written.
    const daybook = path.join(profileDir(slug), "daybook.md");
    assert.equal(fs.existsSync(daybook), false, "daybook.md must NOT be written");
    await archive(slug);
  });

  it("writes RULES.md when tone alone is provided", async () => {
    const slug = "cratchit-tone";
    const { status } = await invokeRoute(
      "POST",
      "/api/v1/agent-profiles",
      {
        slug,
        label: "Cratchit Tone",
        model: "claude-sonnet-4-6",
        tone: "dry",
      },
    );
    assert.equal(status, 202);
    const rules = path.join(profileDir(slug), "RULES.md");
    assert.ok(fs.existsSync(rules));
    const content = fs.readFileSync(rules, "utf-8");
    assert.match(content, /## Tone\s*\ndry/);
    await archive(slug);
  });

  it("writes daybook.md when first_actions is provided", async () => {
    const slug = "cratchit-actions";
    const { status } = await invokeRoute(
      "POST",
      "/api/v1/agent-profiles",
      {
        slug,
        label: "Cratchit Actions",
        model: "claude-sonnet-4-6",
        first_actions: [
          "Reconcile Sunday's grocery receipts against Sure",
          "Flag any subscription that auto-renewed this week",
        ],
      },
    );
    assert.equal(status, 202);
    const daybook = path.join(profileDir(slug), "daybook.md");
    assert.ok(fs.existsSync(daybook));
    const content = fs.readFileSync(daybook, "utf-8");
    assert.match(content, /# Daybook — Cratchit Actions/);
    assert.match(content, /- \[ \] Reconcile Sunday's grocery receipts/);
    assert.match(content, /- \[ \] Flag any subscription/);
    await archive(slug);
  });

  it("writes nothing when first_actions is empty AND no role/tone", async () => {
    const slug = "cratchit-empty";
    const { status } = await invokeRoute(
      "POST",
      "/api/v1/agent-profiles",
      {
        slug,
        label: "Cratchit Empty",
        model: "claude-sonnet-4-6",
        first_actions: [],
      },
    );
    assert.equal(status, 202);
    assert.equal(
      fs.existsSync(path.join(profileDir(slug), "RULES.md")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(profileDir(slug), "daybook.md")),
      false,
    );
    await archive(slug);
  });

  it("writes BOTH RULES.md AND daybook.md when role + first_actions both given", async () => {
    const slug = "cratchit-full";
    const { status } = await invokeRoute(
      "POST",
      "/api/v1/agent-profiles",
      {
        slug,
        label: "Cratchit Full",
        model: "claude-sonnet-4-6",
        role: "household bookkeeper",
        tone: "dry",
        first_actions: ["Reconcile receipts"],
      },
    );
    assert.equal(status, 202);
    assert.ok(fs.existsSync(path.join(profileDir(slug), "RULES.md")));
    assert.ok(fs.existsSync(path.join(profileDir(slug), "daybook.md")));
    await archive(slug);
  });

  it("does NOT clobber an existing RULES.md", async () => {
    const slug = "cratchit-preexisting";
    // Pre-create the profile dir + a hand-edited RULES.md.
    fs.mkdirSync(profileDir(slug), { recursive: true });
    const existingPath = path.join(profileDir(slug), "RULES.md");
    const SENTINEL = "# Hand-edited rules — DO NOT clobber\n";
    fs.writeFileSync(existingPath, SENTINEL, "utf-8");

    const { status } = await invokeRoute(
      "POST",
      "/api/v1/agent-profiles",
      {
        slug,
        label: "Cratchit Pre",
        model: "claude-sonnet-4-6",
        role: "should not overwrite",
      },
    );
    assert.equal(status, 202);
    const after = fs.readFileSync(existingPath, "utf-8");
    assert.equal(after, SENTINEL, "existing RULES.md must be preserved");
    await archive(slug);
  });

  it("does NOT clobber an existing daybook.md", async () => {
    const slug = "cratchit-preexisting-daybook";
    fs.mkdirSync(profileDir(slug), { recursive: true });
    const existingPath = path.join(profileDir(slug), "daybook.md");
    const SENTINEL = "# Hand-edited daybook\n";
    fs.writeFileSync(existingPath, SENTINEL, "utf-8");

    const { status } = await invokeRoute(
      "POST",
      "/api/v1/agent-profiles",
      {
        slug,
        label: "Cratchit Pre Daybook",
        model: "claude-sonnet-4-6",
        first_actions: ["should not appear in file"],
      },
    );
    assert.equal(status, 202);
    const after = fs.readFileSync(existingPath, "utf-8");
    assert.equal(after, SENTINEL, "existing daybook.md must be preserved");
    await archive(slug);
  });
});

describe("POST /api/v1/agent-profiles — Q5 validation", () => {
  it("rejects role > 200 chars with 422", async () => {
    const { status, body } = await invokeRoute(
      "POST",
      "/api/v1/agent-profiles",
      {
        slug: "v-role-too-long",
        label: "V",
        model: "claude-sonnet-4-6",
        role: "x".repeat(201),
      },
    );
    assert.equal(status, 422);
    assert.equal(body.error.code, "PROMOTION_FAIL");
    assert.equal(body.error.details?.field, "role");
  });

  it("rejects role with a newline (must be single line) with 422", async () => {
    const { status, body } = await invokeRoute(
      "POST",
      "/api/v1/agent-profiles",
      {
        slug: "v-role-newline",
        label: "V",
        model: "claude-sonnet-4-6",
        role: "household\nbookkeeper",
      },
    );
    assert.equal(status, 422);
    assert.equal(body.error.code, "PROMOTION_FAIL");
    assert.equal(body.error.details?.field, "role");
  });

  it("rejects tone > 64 chars with 422", async () => {
    const { status, body } = await invokeRoute(
      "POST",
      "/api/v1/agent-profiles",
      {
        slug: "v-tone-too-long",
        label: "V",
        model: "claude-sonnet-4-6",
        tone: "y".repeat(65),
      },
    );
    assert.equal(status, 422);
    assert.equal(body.error.details?.field, "tone");
  });

  it("rejects first_actions > 10 items with 422", async () => {
    const { status, body } = await invokeRoute(
      "POST",
      "/api/v1/agent-profiles",
      {
        slug: "v-actions-too-many",
        label: "V",
        model: "claude-sonnet-4-6",
        first_actions: new Array(11).fill("an action"),
      },
    );
    assert.equal(status, 422);
    assert.equal(body.error.details?.field, "first_actions");
  });

  it("rejects first_actions[i] > 200 chars with 422", async () => {
    const { status, body } = await invokeRoute(
      "POST",
      "/api/v1/agent-profiles",
      {
        slug: "v-action-too-long",
        label: "V",
        model: "claude-sonnet-4-6",
        first_actions: ["ok action", "z".repeat(201)],
      },
    );
    assert.equal(status, 422);
    assert.match(body.error.details?.field, /first_actions/);
  });

  it("rejects first_actions that isn't an array with 422", async () => {
    const { status, body } = await invokeRoute(
      "POST",
      "/api/v1/agent-profiles",
      {
        slug: "v-actions-not-array",
        label: "V",
        model: "claude-sonnet-4-6",
        first_actions: "not an array",
      },
    );
    assert.equal(status, 422);
    assert.equal(body.error.details?.field, "first_actions");
  });
});
