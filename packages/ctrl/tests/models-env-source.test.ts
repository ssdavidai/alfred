// F65 (C17) — model catalog reads provider creds from a reachable source.
//
// The catalog read provider keys ONLY from `${COMPOSE_DIR}/.env`
// (/srv/alfred-black/.env), which is not mounted in the ctrl-api container, so
// readEnvKeys() → empty set → zero fetchers → GET /admin/models = {groups:[]}.
// The real creds live in the container environment (process.env, injected via
// F40/F43). Fix: read from the .env file UNION process.env so a key present in
// either source is discovered.
//
// We test the source resolution (readEnvKeys / getEnvValue) directly to avoid
// real provider network calls.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point COMPOSE_DIR at an empty dir so the .env file is ABSENT — mirrors the box.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "models-env-"));
process.env.COMPOSE_DIR = tmp; // no .env file written here
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";
fs.mkdirSync(path.join(tmp, "streams"), { recursive: true });

const models = await import("../src/api/routes/models.js");

describe("model catalog cred source — process.env fallback (F65)", () => {
  const SAVED = process.env.OPENROUTER_API_KEY;
  before(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-test-12345";
  });
  after(() => {
    if (SAVED === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = SAVED;
  });

  it("readEnvKeys discovers a key present only in process.env", () => {
    const keys = (models as any).readEnvKeys() as Set<string>;
    assert.ok(keys.has("OPENROUTER_API_KEY"), "key from process.env must be discovered when .env is absent");
  });

  it("getEnvValue returns the process.env value", () => {
    const v = (models as any).getEnvValue("OPENROUTER_API_KEY") as string | null;
    assert.equal(v, "sk-or-test-12345");
  });

  it("ignores empty-string values (not configured)", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "";
    try {
      const keys = (models as any).readEnvKeys() as Set<string>;
      assert.ok(!keys.has("ANTHROPIC_API_KEY"), "empty value must not count as configured");
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
