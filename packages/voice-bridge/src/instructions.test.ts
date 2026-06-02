// instructions.test.ts — #226 Lane V: per-call timezone anchor in voice instructions.
//
// Covers the 6 smoke sections from the contracts doc:
//   1. Setup — InstructionContext with voiceContext.timeZone = "Europe/Budapest"
//      and a fixed June now (2026-06-02T17:40:00Z).
//   2. Trigger — call buildInstructions(ctx, fixedNow).
//   3. Assert positive — output contains anchor line, "Europe/Budapest",
//      "+02:00" (DST sanity), and today/tomorrow date pair.
//   4. Assert non-UTC != UTC — Budapest offset is NOT "+00:00" / "Z".
//   5. Assert fallback — absent timeZone renders UTC anchor without crash.
//   6. Cleanup — pure function; assert no globals mutated.

import { test } from "node:test";
import assert from "node:assert/strict";

// A fixed June instant: 2026-06-02T17:40:00Z
// Europe/Budapest in June = CEST = UTC+02:00, so local time is 19:40:00+02:00.
const FIXED_NOW = new Date("2026-06-02T17:40:00Z");

test("buildTimeAnchor: Europe/Budapest June instant → +02:00 (DST sanity)", async () => {
  const { buildTimeAnchor } = await import("./instructions.js");
  const anchor = buildTimeAnchor("Europe/Budapest", FIXED_NOW);

  // Must contain the IANA zone name
  assert.match(anchor, /Europe\/Budapest/, "must contain IANA zone name");

  // Must contain UTC+02:00 (CEST — June DST offset)
  assert.match(anchor, /\+02:00/, "must show +02:00 offset for June Budapest");

  // Must NOT be UTC (prove zone is applied, not ignored)
  assert.doesNotMatch(
    anchor,
    /\+00:00/,
    "Budapest in June must not render as +00:00",
  );
  assert.doesNotMatch(anchor, /UTC\+00/, "must not render as UTC+00");

  // Must contain today/tomorrow date info
  assert.match(anchor, /Today is/, "must include today label");
  assert.match(anchor, /tomorrow is/, "must include tomorrow label");

  // Must contain June 2026 dates
  assert.match(anchor, /2026/, "must include the year");
  assert.match(anchor, /June/, "must include the month");

  // Must contain the calendar/timezone instruction sentence
  assert.match(
    anchor,
    /When calling calendar\/email tools/,
    "must include the tool-use instruction",
  );
  assert.match(
    anchor,
    /report times in it/,
    "must include the reporting instruction",
  );
});

test("buildInstructions: anchor prepended with Budapest timezone", async () => {
  const { buildInstructions } = await import("./instructions.js");

  const ctx = {
    tenantPhoneNumber: "+36201234567",
    voiceContext: {
      memoryMd: "Sir prefers brevity.",
      voiceSkill: "",
      openMatters: [],
      openTasks: [],
      recentSessions: [],
      generatedAt: "2026-06-02T17:00:00Z",
      timeZone: "Europe/Budapest",
    },
  };

  const result = buildInstructions(ctx, FIXED_NOW);

  // Section 3: Assert positive — anchor present
  assert.match(result, /Europe\/Budapest/, "output must contain IANA zone");
  assert.match(result, /\+02:00/, "output must contain +02:00 DST offset");
  assert.match(result, /Today is/, "output must contain today label");
  assert.match(result, /tomorrow is/, "output must contain tomorrow label");
  assert.match(
    result,
    /When calling calendar\/email tools/,
    "output must contain tool-use instruction",
  );

  // Section 4: Assert non-UTC != UTC — Budapest offset is NOT +00:00 / Z
  assert.doesNotMatch(
    result,
    /Current time:.*\+00:00/,
    "Budapest anchor must not show +00:00",
  );

  // The rest of the instructions must still be present (no regression)
  assert.match(result, /Yes, sir\?/, "persona greeting must still be present");
  assert.match(
    result,
    /Voice guardrails/,
    "guardrails block must still be present",
  );
});

test("buildInstructions: timeZone absent → UTC anchor without crash", async () => {
  const { buildInstructions } = await import("./instructions.js");

  // Section 5: fallback — no timeZone field
  const ctx = {
    tenantPhoneNumber: null,
    voiceContext: {
      memoryMd: "",
      voiceSkill: "",
      openMatters: [],
      openTasks: [],
      recentSessions: [],
      generatedAt: "2026-06-02T17:00:00Z",
      // timeZone intentionally absent
    },
  };

  let result: string;
  assert.doesNotThrow(() => {
    result = buildInstructions(ctx, FIXED_NOW);
  }, "must not throw when timeZone is absent");

  // Should still render an anchor (in UTC)
  assert.match(result!, /Today is/, "UTC fallback must still render today");
  assert.match(result!, /UTC/, "UTC fallback must mention UTC");
});

test("buildInstructions: null voiceContext → UTC anchor without crash", async () => {
  const { buildInstructions } = await import("./instructions.js");

  const ctx = {
    tenantPhoneNumber: null,
    voiceContext: null,
  };

  let result: string;
  assert.doesNotThrow(() => {
    result = buildInstructions(ctx, FIXED_NOW);
  }, "must not throw when voiceContext is null");

  // Should still render something (anchor in UTC)
  assert.match(result!, /Today is/, "UTC anchor must render even with null context");
});

test("buildTimeAnchor: UTC fallback renders correctly", async () => {
  const { buildTimeAnchor } = await import("./instructions.js");

  const anchor = buildTimeAnchor("UTC", FIXED_NOW);

  assert.match(anchor, /UTC/, "UTC anchor must mention UTC");
  assert.match(anchor, /\+00:00/, "UTC must show +00:00 offset");
  assert.match(anchor, /Today is/, "UTC anchor must include today");
  assert.match(anchor, /tomorrow is/, "UTC anchor must include tomorrow");
});

test("buildInstructions: no globals mutated (pure function)", async () => {
  const { buildInstructions } = await import("./instructions.js");

  const ctx = {
    tenantPhoneNumber: null,
    voiceContext: {
      memoryMd: "",
      voiceSkill: "",
      openMatters: [],
      openTasks: [],
      recentSessions: [],
      generatedAt: "2026-06-02T17:00:00Z",
      timeZone: "Europe/Budapest",
    },
  };

  // Capture global state before
  const dateNowBefore = Date.now();

  buildInstructions(ctx, FIXED_NOW);
  buildInstructions(ctx, FIXED_NOW);

  // Date.now() still advances normally (no freeze applied globally)
  const dateNowAfter = Date.now();
  assert.ok(
    dateNowAfter >= dateNowBefore,
    "Date.now() must not be frozen globally after buildInstructions",
  );

  // Two calls with same input produce same output (pure / deterministic)
  const r1 = buildInstructions(ctx, FIXED_NOW);
  const r2 = buildInstructions(ctx, FIXED_NOW);
  assert.equal(r1, r2, "buildInstructions must be deterministic with fixed now");
});
