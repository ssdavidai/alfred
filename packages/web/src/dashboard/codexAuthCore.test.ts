import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deriveCodexViewState, isTerminal, shouldDispatchRestart } from "./codexAuthCore.ts";

describe("deriveCodexViewState", () => {
  test("null/undefined/not_started → idle", () => {
    assert.deepEqual(deriveCodexViewState(null, false), { phase: "idle" });
    assert.deepEqual(deriveCodexViewState(undefined, false), { phase: "idle" });
    assert.deepEqual(deriveCodexViewState({ status: "not_started" }, false), { phase: "idle" });
  });
  // Key case: user_code arrives seconds after start() — the UI must not assume
  // it is present in the first response. awaiting_approval WITHOUT code = waiting.
  test("awaiting_approval without user_code → waiting_for_code", () => {
    assert.deepEqual(deriveCodexViewState({ status: "awaiting_approval" }, false), { phase: "waiting_for_code" });
    // Also catches partial response (code present but no uri)
    assert.deepEqual(deriveCodexViewState({ status: "awaiting_approval", user_code: "X" }, false), { phase: "waiting_for_code" });
  });
  test("awaiting_approval with both fields → show_code, fields surfaced", () => {
    const vs = deriveCodexViewState(
      { status: "awaiting_approval", user_code: "ABCD-1234", verification_uri: "https://example.com/activate" },
      false,
    );
    assert.deepEqual(vs, { phase: "show_code", user_code: "ABCD-1234", verification_uri: "https://example.com/activate" });
  });
  test("complete → done", () => {
    assert.deepEqual(deriveCodexViewState({ status: "complete" }, false), { phase: "done" });
  });
  test("failed → failed phase with error surfaced (or non-empty fallback)", () => {
    assert.deepEqual(deriveCodexViewState({ status: "failed", error: "exit 1" }, false), { phase: "failed", error: "exit 1" });
    const noErr = deriveCodexViewState({ status: "failed" }, false);
    assert.equal(noErr.phase, "failed");
    assert.ok((noErr as { phase: "failed"; error: string }).error.length > 0);
  });
  // timeout and failed must produce DISTINCT phases; collapsing them is the failure mode.
  test("timeout → timeout (distinct from failed)", () => {
    const vs = deriveCodexViewState({ status: "timeout" }, false);
    assert.equal(vs.phase, "timeout");
    assert.notEqual(vs.phase, "failed");
  });
  test("restarting=true overrides any server status", () => {
    for (const s of ["complete", "failed", "timeout", "awaiting_approval"] as const)
      assert.equal(deriveCodexViewState({ status: s }, true).phase, "restarting", `override ${s}`);
  });
});

describe("isTerminal", () => {
  test("complete / failed / timeout are terminal", () => {
    assert.ok(isTerminal("complete") && isTerminal("failed") && isTerminal("timeout"));
  });
  test("not_started / awaiting_approval / undefined are not terminal", () => {
    assert.ok(!isTerminal("not_started") && !isTerminal("awaiting_approval") && !isTerminal(undefined));
  });
});

describe("shouldDispatchRestart", () => {
  test("complete + not yet sent → dispatch", () => {
    assert.ok(shouldDispatchRestart("complete", false));
  });
  // Reaching complete twice must dispatch restart once — the guard holds.
  test("complete + already sent → no second dispatch", () => {
    assert.ok(!shouldDispatchRestart("complete", true));
  });
  test("non-complete statuses never restart", () => {
    assert.ok(!shouldDispatchRestart("failed", false) && !shouldDispatchRestart("timeout", false)
      && !shouldDispatchRestart("awaiting_approval", false) && !shouldDispatchRestart(undefined, false));
  });
});
