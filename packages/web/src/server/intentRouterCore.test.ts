import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyIntent,
  formatIntent,
  buildFastPathEnvelope,
  tryFastPath,
} from "./intentRouterCore";

// ── classifier: hits ─────────────────────────────────────────────────────────
test("classifies pending-decision asks", () => {
  for (const q of [
    "pending decisions",
    "what's on my desk",
    "show my open decisions",
    "any decisions waiting?",
    "list my decisions",
  ]) {
    const r = classifyIntent(q);
    assert.equal(r?.key, "decisions", q);
    assert.equal(r?.ctrlPath, "/api/v1/decisions?state=open");
  }
});

test("classifies matters / plate asks", () => {
  for (const q of ["my matters", "what's on my plate", "active matters"]) {
    assert.equal(classifyIntent(q)?.key, "matters", q);
  }
});

test("classifies chores asks", () => {
  for (const q of ["my chores", "chore status", "what chores are due"]) {
    assert.equal(classifyIntent(q)?.key, "chores", q);
  }
});

test("classifies Sure balance asks", () => {
  for (const q of ["my balance", "account balances", "net worth", "sure balance"]) {
    assert.equal(classifyIntent(q)?.key, "balance", q);
  }
});

// ── classifier: fail-open non-matches ────────────────────────────────────────
test("does not fast-path command-shaped or nuanced asks", () => {
  for (const q of [
    "create a decision about the wall",
    "why do I have so many chores?",
    "how is my balance trending vs last month and what should I cut",
    "draft an email about the matters",
    "mark that chore done",
    "should I defer this decision",
    "plan my week around these matters",
  ]) {
    assert.equal(classifyIntent(q), null, q);
  }
});

test("does not fast-path empty, long, or unrelated input", () => {
  assert.equal(classifyIntent(""), null);
  assert.equal(classifyIntent("   "), null);
  assert.equal(classifyIntent("tell me a joke about bees"), null);
  assert.equal(classifyIntent("x".repeat(200)), null);
  assert.equal(classifyIntent("what is the meaning of decisions in philosophy generally speaking today"), null); // >90 chars
});

// ── formatters ───────────────────────────────────────────────────────────────
test("fmt decisions: count + items, empty state, bad shape", () => {
  assert.match(
    formatIntent("decisions", { decisions: [{ summary: "Pay NAV" }, { title: "Reply Rob" }], count: 2 }) ?? "",
    /2 pending decision/,
  );
  assert.match(formatIntent("decisions", { decisions: [], count: 0 }) ?? "", /no pending decisions/i);
  assert.equal(formatIntent("decisions", { nope: 1 }), null); // unfamiliar → null
});

test("fmt matters: names + state", () => {
  const out = formatIntent("matters", { matters: [{ name: "NeoTerra", state: "active" }], count: 1 });
  assert.match(out ?? "", /NeoTerra — active/);
});

test("fmt chores: name + status + next", () => {
  const out = formatIntent("chores", {
    chores: [{ name: "Weekly review", status: "active", next_run_at: "2026-08-10" }],
  });
  assert.match(out ?? "", /Weekly review/);
});

test("fmt balance: account + balance + currency", () => {
  const out = formatIntent("balance", {
    accounts: [{ name: "Checking", balance: 1234.5, currency: "HUF" }],
  });
  assert.match(out ?? "", /Checking: 1234.5 HUF/);
  assert.equal(formatIntent("balance", { total: 5 }), null); // no accounts array → null
});

// ── envelope ─────────────────────────────────────────────────────────────────
test("envelope is a completed /v1/responses shape the widget renders", () => {
  const env: any = buildFastPathEnvelope("hello", "fastpath-1");
  assert.equal(env.status, "completed");
  assert.equal(env.object, "response");
  assert.equal(env.output[0].content[0].text, "hello");
  assert.equal(env.fast_path, true);
});

// ── tryFastPath orchestration (fail-open) ────────────────────────────────────
test("tryFastPath: hit returns envelope", async () => {
  const env = await tryFastPath(
    "my chores",
    async () => ({ chores: [{ name: "A", status: "active" }] }),
    () => "id-1",
  );
  assert.equal((env as any)?.status, "completed");
  assert.match((env as any).output[0].content[0].text, /You have 1 chore/);
});

test("tryFastPath: classifier miss → null", async () => {
  const env = await tryFastPath("why is the sky blue", async () => ({}), () => "id");
  assert.equal(env, null);
});

test("tryFastPath: unfamiliar ctrl shape → null (fall through)", async () => {
  const env = await tryFastPath("my chores", async () => ({ unexpected: true }), () => "id");
  assert.equal(env, null);
});

test("tryFastPath: ctrl-api error → null (fail-open)", async () => {
  const env = await tryFastPath(
    "my chores",
    async () => {
      throw new Error("ctrl-api down");
    },
    () => "id",
  );
  assert.equal(env, null);
});
