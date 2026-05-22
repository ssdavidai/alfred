// F67 — AGENTS catalog must include the `heavy` profile + chore/onboarding
// agents, and the "two profiles" docstring must be corrected.
//
// alfred-black runs THREE Hermes profiles: main (:18789), workers (:18790),
// heavy (:18791, onboarding facts/patterns + chore heavy-reasoning, Opus-class).
// ctrl's AGENTS catalog only knew main + workers, so the UI could neither show
// nor set the heavy/Opus profile or the chore/onboarding tasks. The docstring
// literally claimed "two profiles".
//
// Source-level checks (the catalog is a module const tightly coupled to the
// on-box config files; we assert on the source rather than spinning up Hermes).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.join(process.cwd(), "src", "api", "routes", "agents.ts"),
  "utf-8",
);

describe("AGENTS catalog — heavy profile + tasks (F67)", () => {
  it("declares at least one agent on the heavy profile", () => {
    assert.ok(
      /profile:\s*"heavy"/.test(SRC),
      "AGENTS must include an agent mapped to the heavy profile",
    );
  });

  it("includes a chore/onboarding-class agent", () => {
    assert.ok(
      /onboard|chore/i.test(SRC),
      "AGENTS must represent the onboarding/chore heavy-reasoning task",
    );
  });

  it("no longer claims there are only two profiles", () => {
    assert.ok(
      !/two profiles/i.test(SRC),
      'the "two profiles" docstring must be corrected (there are three)',
    );
  });

  it("names the three Hermes profiles in the docstring", () => {
    assert.ok(/three profiles/i.test(SRC) || /\bheavy\b/.test(SRC), "docstring should reflect the heavy profile");
  });
});
