// F6 — the dead `daily-digest` audit classifier + summary case must be gone.
//
// classifyAuditKind() listed "daily-digest" and formatAuditSummary() had a
// dedicated `case "daily-digest"` block, but the DailyDigest/DailyMorning/
// DailyEvening workflows were retired in f20556d — no writer emits these
// anymore, so the handling is dead code. (These helpers are themselves dead now
// that GET /api/v1/admin/audit reads the SQL ledger (F4), but F6's scope is the
// daily-digest references specifically.)
//
// A source-level guard: a deletion task whose green state is the absence of the
// dead token. Asserts the daily-digest classifier entry and summary case are
// removed from admin.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const adminSrc = fs.readFileSync(
  path.join(here, "../src/api/routes/admin.ts"),
  "utf-8",
);

describe("admin.ts — daily-digest dead code removed (F6)", () => {
  it("classifyAuditKind no longer lists daily-digest", () => {
    assert.ok(
      !/["']daily-digest["']/.test(adminSrc),
      "no 'daily-digest' string literal should remain in admin.ts",
    );
  });

  it("formatAuditSummary has no daily-digest case", () => {
    assert.ok(
      !/case\s+["']daily-digest["']/.test(adminSrc),
      "no `case \"daily-digest\"` should remain",
    );
    assert.ok(
      !/daily-digest-\(\\d/.test(adminSrc) && !adminSrc.includes("Daily digest"),
      "no daily-digest filename regex / 'Daily digest' summary should remain",
    );
  });
});
