/**
 * Tests for `composeRulesFile` — pure helper composing on-wire vault notes.
 *   cd packages/web && npx tsx --test src/onboarding/rulesFileCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { composeRulesFile } from "./rulesFileCore";

const BODY = "# Standing Rules\n\n## Personal sovereignty rules\n- one rule\n";

test("preserves existing frontmatter verbatim + appends body", () => {
  const out = composeRulesFile(
    {
      type: "note",
      subtype: "standing_rules",
      status: "active",
      created: "2026-05-20T14:00:00+00:00",
      created_by: "onboarding_pipeline",
    },
    BODY,
  );
  assert.match(out, /^---\n/);
  assert.match(out, /\n---\n/);
  assert.match(out, /type: note/);
  assert.match(out, /subtype: standing_rules/);
  assert.match(out, /status: active/);
  assert.match(out, /created_by: onboarding_pipeline/);
  assert.ok(out.endsWith(BODY));
});

test("missing frontmatter → seeds type: note + subtype: standing_rules", () => {
  const out = composeRulesFile(null, BODY);
  assert.match(out, /type: note/);
  assert.match(out, /subtype: standing_rules/);
  assert.ok(out.endsWith(BODY));
});

test("undefined frontmatter is equivalent to null", () => {
  const out = composeRulesFile(undefined, BODY);
  assert.match(out, /type: note/);
  assert.match(out, /subtype: standing_rules/);
});

test("a YAML-special string value is JSON-quoted so it round-trips", () => {
  const out = composeRulesFile(
    { type: "note", created: "2026-05-20T14:00:00+00:00" },
    BODY,
  );
  assert.match(out, /created: "2026-05-20T14:00:00\+00:00"/);
  assert.match(out, /type: note/);
});

test("doesn't downgrade an existing custom subtype to standing_rules", () => {
  const out = composeRulesFile({ type: "note", subtype: "custom_kind" }, BODY);
  assert.match(out, /subtype: custom_kind/);
  assert.ok(!out.includes("subtype: standing_rules"));
});
