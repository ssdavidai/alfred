// Every migrations/*.sql file must be registered in migrate.ts.
//
// migrate.ts loads migrations by STATIC IMPORT into an explicit MIGRATIONS
// array — esbuild inlines each .sql as a text string at build time. A file
// added to migrations/ but not imported there is therefore never applied,
// and nothing else catches it: the build succeeds, CI is green, and the
// column simply never appears. That happened with 0019 (#563 item 2), which
// merged, built, and deployed as a dead file.
//
// This test closes that gap. It is deliberately filesystem-driven rather
// than a hardcoded count, so it keeps working as migrations are appended.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "src", "db", "migrations");
const migrateTs = readFileSync(join(here, "..", "src", "db", "migrate.ts"), "utf8");

test("every migration file is imported by migrate.ts", () => {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.length > 0, "found no migration files — path wrong?");
  const missing = files.filter((f) => !migrateTs.includes(`./migrations/${f}`));
  assert.deepEqual(missing, [], `migration files not imported in migrate.ts: ${missing.join(", ")}`);
});

test("every migration file has a MIGRATIONS array entry", () => {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const missing: string[] = [];
  for (const f of files) {
    const n = Number(f.slice(0, 4));
    // The entry references the import alias mNNNN for this version.
    const alias = `m${String(n).padStart(4, "0")}`;
    const entry = new RegExp(`version:\\s*${n}\\b[^}]*sql:\\s*${alias}\\b`);
    if (!entry.test(migrateTs)) missing.push(f);
  }
  assert.deepEqual(missing, [], `migration files with no MIGRATIONS entry: ${missing.join(", ")}`);
});
