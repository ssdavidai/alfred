/**
 * Tests for /verify's view-state decision (verifyPageCore).
 *
 * The wedge being fixed: /verify polled `getOnboardingProgress` every 8s
 * and gated its "loading" message on whether key_identity_facts was empty.
 * When extract_facts_opus degraded (e.g. a 402 credit dip during fact
 * extraction on miguel.alfred.black on 2026-05-27), key_identity_facts
 * stayed empty FOREVER and the page sat on
 * "A moment — Alfred is sorting his observations."
 *
 *   cd packages/web && npx tsx --test src/onboarding/verifyPageCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FACTS_SETTLED_STAGES,
  verifyViewState,
} from "./verifyPageCore";

test("backend mid-pipeline + empty facts → waiting (the calm spinner)", () => {
  const state = verifyViewState({ stage: "facts", factsCount: 0 });
  assert.equal(state, "waiting");
});

test("backend at metadata stage + empty facts → waiting", () => {
  const state = verifyViewState({ stage: "metadata", factsCount: 0 });
  assert.equal(state, "waiting");
});

test("getOnboardingProgress not yet resolved + empty facts → waiting", () => {
  const state = verifyViewState({ stage: undefined, factsCount: 0 });
  assert.equal(state, "waiting");
});

test("non-zero facts → list (the happy path)", () => {
  const state = verifyViewState({
    stage: "awaiting_verification",
    factsCount: 8,
  });
  assert.equal(state, "list");
});

test("non-zero facts BEFORE settle (early hydrate) → list", () => {
  // Defensive: if some future change has the backend stamp facts before
  // setting stage=awaiting_verification, we should still render them.
  const state = verifyViewState({ stage: "personalize", factsCount: 3 });
  assert.equal(state, "list");
});

test("awaiting_verification + 0 facts → empty (the wedge fix)", () => {
  // Live miguel.alfred.black state on 2026-05-27 18:00Z:
  //   stage=awaiting_verification, key_identity_facts=[]
  // The old code showed "Alfred is sorting his observations" forever.
  const state = verifyViewState({
    stage: "awaiting_verification",
    factsCount: 0,
  });
  assert.equal(state, "empty");
});

test("post-verification stages also count as settled", () => {
  // A workflow that completed all the way to `done` with zero facts —
  // e.g. the brief-stage workflow that runs after corrections — should
  // also show the empty state if the principal navigates back to
  // /verify, never the eternal spinner.
  for (const stage of ["brief", "packs", "chores", "done"] as const) {
    const state = verifyViewState({ stage, factsCount: 0 });
    assert.equal(state, "empty", `stage=${stage} should resolve to empty`);
  }
});

test("FACTS_SETTLED_STAGES covers every post-facts stage from STAGE_ORDER", () => {
  // STAGE_ORDER in onboarding_pipeline.py is:
  //   metadata, profiler, facts, patterns, personalize,
  //   awaiting_verification, brief, packs, chores, done
  // Everything strictly AFTER `personalize` is settled.
  const expected = new Set([
    "awaiting_verification",
    "brief",
    "packs",
    "chores",
    "done",
  ]);
  assert.deepEqual(new Set(FACTS_SETTLED_STAGES), expected);
});

test("stages strictly before awaiting_verification are NOT settled", () => {
  for (const stage of [
    "metadata",
    "profiler",
    "facts",
    "patterns",
    "personalize",
  ]) {
    assert.equal(
      FACTS_SETTLED_STAGES.has(stage),
      false,
      `stage=${stage} must not be classified as settled`,
    );
  }
});
