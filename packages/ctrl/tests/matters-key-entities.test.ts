// C-B2 — matter detail returns vault-linkable key entities.
//
// `GET /api/v1/matters/:id` must add `key_entities: [{ name, path, type }]`
// resolving the matter's key people/orgs to person/<slug>.md / org/<slug>.md
// vault paths so the web can link them. A name with no record → path:null.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "matters-keyent-"));
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";

const VAULT = process.env.VAULT_PATH;
for (const d of ["matter", "person", "org"]) fs.mkdirSync(path.join(VAULT, d), { recursive: true });

const { matchRoute } = await import("../src/api/server.js");
const { registerMatterRoutes } = await import("../src/api/routes/matters.js");
registerMatterRoutes();

const write = (rel: string, lines: string[]) =>
  fs.writeFileSync(path.join(VAULT, rel), lines.join("\n") + "\n", "utf-8");

function seed(): void {
  write("person/rami-khouri.md", ["---", "type: person", "name: Rami Khouri", "---", "Engineer."]);
  // stem differs from name → must match on the name frontmatter.
  write("person/Zsolt.md", ["---", "type: person", "name: Zsolt Rapali", "---", "Partner."]);
  write("org/acme-corp.md", ["---", "type: org", "name: Acme Corp", "---", "Counterparty."]);
  write("matter/retaining-wall.md", [
    "---",
    "type: matter",
    "name: Retaining wall repair",
    "summary: Fix the retaining wall",
    "status: active",
    "key_people: [Rami Khouri, Zsolt Rapali, Nobody McGhost]",
    "related_persons: ['[[person/rami-khouri]]']",
    "related_orgs: ['[[org/Acme Corp]]']",
    "---",
    "## Context",
    "The wall is leaning.",
  ]);
}

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

describe("matters detail — key_entities resolution (C-B2)", () => {
  before(() => seed());

  it("resolves names to paths (stem/name-fm/wikilink), nulls the unknown, no regress", async () => {
    const { status, payload } = await call("GET", "/api/v1/matters/retaining-wall");
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(payload)}`);
    const m = payload.matter;
    const ents = m.key_entities as any[];
    assert.ok(Array.isArray(ents), "key_entities must be an array");
    const by = (n: string) => ents.find((e) => e.name === n);
    // stem match / name-fm match (stem "Zsolt" vs name "Zsolt Rapali") / org wikilink
    assert.deepEqual({ t: by("Rami Khouri")?.type, p: by("Rami Khouri")?.path },
      { t: "person", p: "person/rami-khouri.md" }, `Rami via stem; got ${JSON.stringify(ents)}`);
    assert.equal(by("Zsolt Rapali")?.path, "person/Zsolt.md", "Zsolt via name fm");
    assert.equal(ents.find((e) => e.type === "org")?.path, "org/acme-corp.md", "org via wikilink");
    // unresolved name → present, path:null, person-hinted
    assert.deepEqual({ t: by("Nobody McGhost")?.type, p: by("Nobody McGhost")?.path },
      { t: "person", p: null }, "unknown name → null path, still present");
    // no regress on existing detail fields
    assert.ok(typeof m.about === "string" && m.about.includes("wall is leaning"), "about carries body");
    assert.equal(m.summary, "Fix the retaining wall");
    assert.ok(m.vault_by_category && typeof m.vault_by_category === "object", "vault_by_category present");
    assert.ok(Array.isArray(m.timeline), "timeline present");
  });
});
