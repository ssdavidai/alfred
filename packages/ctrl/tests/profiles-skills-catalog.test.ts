// profiles-skills-catalog — unit tests for #205 Lane I per-profile skill routes.
//
// Routes under test:
//   GET /api/v1/admin/profiles/:slug/skills
//   PUT /api/v1/admin/profiles/:slug/skills/:name
//
// Same in-process harness as profiles-mcp-catalog.test.ts.

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── isolate state.db + hermes-state ────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-skills-test-"));
process.env.STATE_DB_PATH = path.join(TMP, "state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.VAULT_PATH = path.join(TMP, "vault");
process.env.ALFRED_DATA_DIR = TMP;
process.env.HERMES_CONFIG_DIR = path.join(TMP, "profiles");
process.env.HERMES_STATE_DIR_CTRL_VIEW = path.join(TMP, "hermes-state");
process.env.INGEST_DB_PATH = path.join(TMP, "ingest.db");
fs.mkdirSync(process.env.HERMES_CONFIG_DIR, { recursive: true });

// ── mock the supervisor (no docker calls) ──────────────────────────────────
const nudgeCalls: string[] = [];
mock.module("../src/hermes/supervisor.js", {
  namedExports: {
    writeSupervisorRegistry: () => {},
    nudgeHermesSupervisor: () => {
      nudgeCalls.push("nudged");
      return true;
    },
    restartProfile: () => ({ scope: "per-profile", attempted: true, warning: null }),
    REGISTRY_PATH: path.join(TMP, "hermes-state", "profiles", "_registry.json"),
  },
});

const { matchRoute } = await import("../src/api/server.js");
const { registerProfileRoutes } = await import("../src/api/routes/profiles.js");
const { handleError } = await import("../src/api/errors.js");
const { getStateDb } = await import("../src/db/state.js");
const { createProfile } = await import("../src/db/agentProfiles.js");

registerProfileRoutes();

// ── http test helper (mirror of profiles-mcp-catalog) ─────────────────────
function invokeRoute(
  method: string,
  url: string,
  params: Record<string, string> = {},
  body?: unknown,
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

// ── fixture helpers ────────────────────────────────────────────────────────
const profDir = (slug: string) => path.join(process.env.HERMES_CONFIG_DIR!, slug);
const cfgPath = (slug: string) => path.join(profDir(slug), "config.yaml");
const readCfg = (slug: string) => fs.readFileSync(cfgPath(slug), "utf-8");
const writeCfg = (slug: string, content: string) => {
  fs.mkdirSync(profDir(slug), { recursive: true });
  fs.writeFileSync(cfgPath(slug), content, "utf-8");
};
const delCfg = (slug: string) => { try { fs.unlinkSync(cfgPath(slug)); } catch {} };
const rmSkills = (slug: string) =>
  fs.rmSync(path.join(profDir(slug), "skills"), { recursive: true, force: true });
const writeSkill = (slug: string, name: string, desc: string | null) => {
  const dir = path.join(profDir(slug), "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  const body = desc === null ? "Body without frontmatter.\n" :
    `---\ndescription: "${desc}"\n---\n\nBody.\n`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), body, "utf-8");
};
const writeBareDir = (slug: string, name: string) => {
  const dir = path.join(profDir(slug), "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.txt"), "stash\n", "utf-8");
};

// ── setup ──────────────────────────────────────────────────────────────────
const SLUG = "skills-test-sentinel";

before(() => {
  createProfile(getStateDb(), { slug: SLUG, label: "Skills Test", model: "gpt-4.1" });
  fs.mkdirSync(profDir(SLUG), { recursive: true });
  nudgeCalls.length = 0;
});

after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

// ── GET tests ──────────────────────────────────────────────────────────────

describe("GET /api/v1/admin/profiles/:slug/skills", () => {
  it("returns 404 for an unknown slug", async () => {
    const { status, body } = await invokeRoute(
      "GET", "/api/v1/admin/profiles/:slug/skills", { slug: "no-such" });
    assert.equal(status, 404);
    assert.match(body.error.message ?? body.error, /not found/i);
  });

  it("returns 200 + empty skills when skills/ dir absent", async () => {
    rmSkills(SLUG); delCfg(SLUG);
    const { status, body } = await invokeRoute(
      "GET", "/api/v1/admin/profiles/:slug/skills", { slug: SLUG });
    assert.equal(status, 200);
    assert.equal(body.slug, SLUG);
    assert.equal(body.reserved, false);
    assert.deepEqual(body.skills, []);
  });

  it("returns alphabetically-sorted catalogue with descriptions; all enabled by default", async () => {
    rmSkills(SLUG); delCfg(SLUG);
    writeSkill(SLUG, "zeta-skill", "Last alpha.");
    writeSkill(SLUG, "alpha-skill", "First alpha.");
    writeSkill(SLUG, "middle-skill", null);
    const { status, body } = await invokeRoute(
      "GET", "/api/v1/admin/profiles/:slug/skills", { slug: SLUG });
    assert.equal(status, 200);
    assert.deepEqual(
      body.skills.map((s: any) => s.name),
      ["alpha-skill", "middle-skill", "zeta-skill"],
    );
    assert.equal(body.skills[0].description, "First alpha.");
    assert.equal(body.skills[1].description, null);
    for (const s of body.skills) {
      assert.equal(s.enabled, true);
      assert.equal(s.last_invoked_at, null);
    }
  });

  it("merges enabled=false from skills.disabled in config.yaml", async () => {
    rmSkills(SLUG);
    writeSkill(SLUG, "foo", "F."); writeSkill(SLUG, "bar", "B.");
    writeCfg(SLUG, `skills:\n  disabled:\n    - foo\n`);
    const { body } = await invokeRoute(
      "GET", "/api/v1/admin/profiles/:slug/skills", { slug: SLUG });
    const foo = body.skills.find((s: any) => s.name === "foo");
    const bar = body.skills.find((s: any) => s.name === "bar");
    assert.equal(foo.enabled, false);
    assert.equal(bar.enabled, true);
  });

  it("skips child directories without a SKILL.md", async () => {
    rmSkills(SLUG); delCfg(SLUG);
    writeSkill(SLUG, "real-skill", "R.");
    writeBareDir(SLUG, "not-a-skill");
    const { body } = await invokeRoute(
      "GET", "/api/v1/admin/profiles/:slug/skills", { slug: SLUG });
    assert.equal(body.skills.length, 1);
    assert.equal(body.skills[0].name, "real-skill");
  });

  it("returns reserved=true for 'main' and still surfaces the catalogue", async () => {
    writeSkill("main", "main-only-skill", "On main.");
    const { status, body } = await invokeRoute(
      "GET", "/api/v1/admin/profiles/:slug/skills", { slug: "main" });
    assert.equal(status, 200);
    assert.equal(body.reserved, true);
    assert.ok(body.skills.find((s: any) => s.name === "main-only-skill"));
  });
});

// ── PUT tests ──────────────────────────────────────────────────────────────

describe("PUT /api/v1/admin/profiles/:slug/skills/:name", () => {
  it("returns 409 for a reserved profile (main)", async () => {
    const { status, body } = await invokeRoute(
      "PUT", "/api/v1/admin/profiles/:slug/skills/:name",
      { slug: "main", name: "any" }, { enabled: false });
    assert.equal(status, 409);
    assert.match(body.error.message ?? body.error, /reserved_profile/);
  });

  it("returns 404 for an unknown profile slug", async () => {
    const { status, body } = await invokeRoute(
      "PUT", "/api/v1/admin/profiles/:slug/skills/:name",
      { slug: "no-such", name: "any" }, { enabled: false });
    assert.equal(status, 404);
    assert.match(body.error.message ?? body.error, /not found/i);
  });

  it("returns 400 when skill name fails the regex", async () => {
    const { status, body } = await invokeRoute(
      "PUT", "/api/v1/admin/profiles/:slug/skills/:name",
      { slug: SLUG, name: "BadName" }, { enabled: false });
    assert.equal(status, 400);
    assert.match(body.error.message ?? body.error, /invalid_skill_name/);
  });

  it("returns 400 when 'enabled' is missing or non-boolean", async () => {
    rmSkills(SLUG); writeSkill(SLUG, "some-skill", "ok");
    const r1 = await invokeRoute(
      "PUT", "/api/v1/admin/profiles/:slug/skills/:name",
      { slug: SLUG, name: "some-skill" }, {});
    assert.equal(r1.status, 400);
    assert.match(r1.body.error.message ?? r1.body.error, /enabled_required_boolean/);
    const r2 = await invokeRoute(
      "PUT", "/api/v1/admin/profiles/:slug/skills/:name",
      { slug: SLUG, name: "some-skill" }, { enabled: "yes" });
    assert.equal(r2.status, 400);
    assert.match(r2.body.error.message ?? r2.body.error, /enabled_required_boolean/);
  });

  it("returns 404 when skill directory is missing on disk", async () => {
    rmSkills(SLUG);
    const { status, body } = await invokeRoute(
      "PUT", "/api/v1/admin/profiles/:slug/skills/:name",
      { slug: SLUG, name: "ghost" }, { enabled: false });
    assert.equal(status, 404);
    assert.match(body.error.message ?? body.error, /not found/i);
  });

  it("toggles a skill OFF then ON; empty disabled array is dropped from config", async () => {
    rmSkills(SLUG); delCfg(SLUG);
    writeSkill(SLUG, "toggle-skill", "T.");
    nudgeCalls.length = 0;
    const off = await invokeRoute(
      "PUT", "/api/v1/admin/profiles/:slug/skills/:name",
      { slug: SLUG, name: "toggle-skill" }, { enabled: false });
    assert.equal(off.status, 200);
    assert.deepEqual(off.body, { ok: true, name: "toggle-skill", enabled: false });
    const yamlOff = readCfg(SLUG);
    assert.match(yamlOff, /disabled:/);
    assert.match(yamlOff, /toggle-skill/);
    assert.ok(nudgeCalls.length > 0);
    const on = await invokeRoute(
      "PUT", "/api/v1/admin/profiles/:slug/skills/:name",
      { slug: SLUG, name: "toggle-skill" }, { enabled: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.enabled, true);
    assert.doesNotMatch(readCfg(SLUG), /disabled:/);
  });

  it("preserves sibling skills.* keys across mutation", async () => {
    rmSkills(SLUG);
    writeSkill(SLUG, "pres-skill", "p");
    writeCfg(SLUG, `skills:\n  creation_nudge_interval: 42\n`);
    const { status } = await invokeRoute(
      "PUT", "/api/v1/admin/profiles/:slug/skills/:name",
      { slug: SLUG, name: "pres-skill" }, { enabled: false });
    assert.equal(status, 200);
    const yaml = readCfg(SLUG);
    assert.match(yaml, /creation_nudge_interval: 42/);
    assert.match(yaml, /disabled:/);
  });

  it("preserves other top-level keys (mcp_servers) across mutation", async () => {
    rmSkills(SLUG);
    writeSkill(SLUG, "co-skill", "c");
    writeCfg(SLUG, `mcp_servers:\n  alfred-ctrl:\n    url: "http://ctrl-api:3100"\nskills:\n  creation_nudge_interval: 7\n`);
    const { status } = await invokeRoute(
      "PUT", "/api/v1/admin/profiles/:slug/skills/:name",
      { slug: SLUG, name: "co-skill" }, { enabled: false });
    assert.equal(status, 200);
    const yaml = readCfg(SLUG);
    assert.match(yaml, /mcp_servers:/);
    assert.match(yaml, /alfred-ctrl:/);
    assert.match(yaml, /creation_nudge_interval: 7/);
  });

  it("is idempotent — disabling twice leaves a single entry", async () => {
    rmSkills(SLUG); delCfg(SLUG);
    writeSkill(SLUG, "idem-skill", "i");
    await invokeRoute("PUT", "/api/v1/admin/profiles/:slug/skills/:name",
      { slug: SLUG, name: "idem-skill" }, { enabled: false });
    await invokeRoute("PUT", "/api/v1/admin/profiles/:slug/skills/:name",
      { slug: SLUG, name: "idem-skill" }, { enabled: false });
    const matches = readCfg(SLUG).match(/idem-skill/g) ?? [];
    assert.equal(matches.length, 1);
  });

  it("sorts and dedupes the disabled array deterministically", async () => {
    rmSkills(SLUG);
    writeSkill(SLUG, "zeta", "z"); writeSkill(SLUG, "alpha", "a");
    writeCfg(SLUG, `skills:\n  disabled:\n    - zeta\n    - zeta\n`);
    const { status } = await invokeRoute(
      "PUT", "/api/v1/admin/profiles/:slug/skills/:name",
      { slug: SLUG, name: "alpha" }, { enabled: false });
    assert.equal(status, 200);
    const yaml = readCfg(SLUG);
    const alphaIdx = yaml.indexOf("- alpha");
    const zetaIdx = yaml.indexOf("- zeta");
    assert.ok(alphaIdx > 0 && zetaIdx > alphaIdx, "alpha sorted before zeta");
    assert.equal((yaml.match(/- zeta/g) ?? []).length, 1, "zeta deduped");
  });

  it("nudges supervisor on every successful mutation", async () => {
    rmSkills(SLUG); delCfg(SLUG);
    writeSkill(SLUG, "nudge-skill", "n");
    nudgeCalls.length = 0;
    const { status } = await invokeRoute(
      "PUT", "/api/v1/admin/profiles/:slug/skills/:name",
      { slug: SLUG, name: "nudge-skill" }, { enabled: false });
    assert.equal(status, 200);
    assert.ok(nudgeCalls.length >= 1);
  });

  it("creates config.yaml when none exists yet (fresh profile path)", async () => {
    rmSkills(SLUG); delCfg(SLUG);
    writeSkill(SLUG, "fresh-skill", "f");
    assert.equal(fs.existsSync(cfgPath(SLUG)), false);
    const { status } = await invokeRoute(
      "PUT", "/api/v1/admin/profiles/:slug/skills/:name",
      { slug: SLUG, name: "fresh-skill" }, { enabled: false });
    assert.equal(status, 200);
    assert.match(readCfg(SLUG), /fresh-skill/);
  });
});
