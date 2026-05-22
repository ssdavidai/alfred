// F10 — graph LINK_FIELDS must include the entity-relationship fields.
//
// The vault graph endpoint built edges only from a fixed LINK_FIELDS set that
// omitted `key_people`, `related_persons`, `related_orgs`, and `org`. Onboarding
// matters carry `key_people:`/`related_persons:` and persons carry `org:`, so
// every matter↔person and person↔org link produced ZERO edges — matters and
// persons were graph islands ("Linked from: no record yet").
//
// This test seeds a matter that references persons via key_people /
// related_persons and an org via related_orgs, plus a person that references an
// org via `org:`. Pre-fix the graph has no edges touching those fields;
// post-fix the deterministic edges resolve.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "graph-linkfields-"));
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";

const VAULT = process.env.VAULT_PATH;
for (const d of ["matter", "person", "org"]) {
  fs.mkdirSync(path.join(VAULT, d), { recursive: true });
}

const { matchRoute } = await import("../src/api/server.js");
const { registerVaultRoutes } = await import("../src/api/routes/vault.js");
registerVaultRoutes();

function writeRec(rel: string, fm: string, body = "body"): void {
  fs.writeFileSync(path.join(VAULT, rel), `---\n${fm}\n---\n\n${body}\n`, "utf-8");
}

async function call(method: string, pathname: string): Promise<{ status: number; payload: any }> {
  const qIdx = pathname.indexOf("?");
  const clean = qIdx >= 0 ? pathname.slice(0, qIdx) : pathname;
  const query = new URLSearchParams(qIdx >= 0 ? pathname.slice(qIdx + 1) : "");
  const m = matchRoute(method, clean);
  assert.ok(m, `${method} ${clean} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(json?: string) { payload = json ? JSON.parse(json) : undefined; },
  } as unknown as ServerResponse;
  await m!.handler({ req: { url: pathname } as any, res, params: m!.params, body: undefined, query });
  return { status, payload };
}

describe("vault graph LINK_FIELDS — entity fields (F10)", () => {
  before(() => {
    writeRec(
      "matter/acme-deal.md",
      [
        'type: matter',
        'name: Acme Deal',
        'key_people:',
        '  - "[[person/Jane Doe]]"',
        'related_persons:',
        '  - "[[person/John Smith]]"',
        'related_orgs:',
        '  - "[[org/Acme Corp]]"',
      ].join("\n"),
    );
    writeRec("person/Jane Doe.md", ['type: person', 'name: Jane Doe', 'org: "[[org/Acme Corp]]"'].join("\n"));
    writeRec("person/John Smith.md", ['type: person', 'name: John Smith'].join("\n"));
    writeRec("org/Acme Corp.md", ['type: org', 'name: Acme Corp'].join("\n"));
  });

  it("produces matter→person edges from key_people and related_persons", async () => {
    const { status, payload } = await call("GET", "/api/v1/vault/graph");
    assert.equal(status, 200);
    const rels = (payload.edges as any[]).map((e) => e.relation);
    assert.ok(rels.includes("key_people"), "key_people must produce an edge");
    assert.ok(rels.includes("related_persons"), "related_persons must produce an edge");
    assert.ok(rels.includes("related_orgs"), "related_orgs must produce an edge");
  });

  it("produces a person→org edge from the org field", async () => {
    const { payload } = await call("GET", "/api/v1/vault/graph");
    const orgEdge = (payload.edges as any[]).find(
      (e) => e.source === "person/Jane Doe.md" && e.relation === "org",
    );
    assert.ok(orgEdge, "person `org:` field must produce an edge to the org");
    assert.equal(orgEdge.target, "org/Acme Corp.md");
  });
});
