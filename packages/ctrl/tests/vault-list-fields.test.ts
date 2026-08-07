// `GET /api/v1/vault/list/:type?fields=a,b` — compact listing.
//
// WHY. The endpoint always returned full frontmatter plus a body preview.
// Listing a type whose records carry long narrative frontmatter is therefore
// unusable at scale: 16 matters, each with a multi-sentence `current_state`,
// produced a 372 KB response that truncated before the caller could read the
// list. A scheduled job iterating matters could not even discover them — it
// failed at step one, three runs in a row, and correctly reported that it
// could not determine the matter set without risking omissions.
//
// These tests cover the projection logic directly. The route wiring is
// exercised on the tenant, because `routes/vault.ts` is not importable
// standalone (see vault-known-types.test.ts for why).

import { test } from "node:test";
import assert from "node:assert/strict";

type Row = {
  path: string;
  name: string;
  status: string;
  frontmatter: Record<string, unknown>;
  body_preview?: string;
};

/** Mirror of the projection applied in the route. */
function project(rows: Row[], fieldsParam: string) {
  const wanted = new Set(
    fieldsParam.split(",").map((f) => f.trim()).filter(Boolean),
  );
  return rows.map((r) => {
    const fm: Record<string, unknown> = {};
    for (const k of wanted) {
      if (k in r.frontmatter) fm[k] = r.frontmatter[k];
    }
    return { path: r.path, name: r.name, status: r.status, frontmatter: fm };
  });
}

const ROWS: Row[] = [
  {
    path: "matter/a.md",
    name: "A",
    status: "active",
    frontmatter: {
      commitment_register: true,
      current_state: "x".repeat(4000),
      as_of: "2026-08-01",
    },
    body_preview: "y".repeat(500),
  },
  {
    path: "matter/b.md",
    name: "B",
    status: "active",
    frontmatter: { current_state: "x".repeat(4000) },
    body_preview: "y".repeat(500),
  },
];

test("only the requested frontmatter keys survive", () => {
  const out = project(ROWS, "commitment_register");
  assert.deepEqual(Object.keys(out[0].frontmatter), ["commitment_register"]);
  assert.equal(out[0].frontmatter.commitment_register, true);
});

test("the narrative that caused the truncation is dropped", () => {
  const out = project(ROWS, "commitment_register");
  const size = JSON.stringify(out).length;
  const full = JSON.stringify(ROWS).length;
  assert.ok(
    size < full / 10,
    `compact listing must be far smaller: ${size} vs ${full}`,
  );
  assert.ok(!JSON.stringify(out).includes("current_state"));
});

test("the body preview is dropped too", () => {
  const out = project(ROWS, "commitment_register");
  assert.ok(!("body_preview" in out[0]));
});

test("identity fields are always kept", () => {
  // A caller selecting one frontmatter key still needs to know which record
  // it belongs to; dropping path/name/status would make the response useless.
  const out = project(ROWS, "commitment_register");
  assert.equal(out[0].path, "matter/a.md");
  assert.equal(out[0].name, "A");
  assert.equal(out[0].status, "active");
});

test("a record missing the key yields an empty object, not a dropped row", () => {
  // The caller must still see record B in order to conclude it is NOT
  // enabled. Omitting it would look identical to the record not existing.
  const out = project(ROWS, "commitment_register");
  assert.equal(out.length, 2);
  assert.deepEqual(out[1].frontmatter, {});
});

test("several keys can be selected at once", () => {
  const out = project(ROWS, "commitment_register,as_of");
  assert.deepEqual(
    Object.keys(out[0].frontmatter).sort(),
    ["as_of", "commitment_register"],
  );
});

test("whitespace and empty entries are tolerated", () => {
  const out = project(ROWS, " commitment_register , , as_of ");
  assert.deepEqual(
    Object.keys(out[0].frontmatter).sort(),
    ["as_of", "commitment_register"],
  );
});
