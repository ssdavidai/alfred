// Regression tests for GitHub #325: the focused-agent proxy aborted at 60s
// and reported the client-side abort as HERMES_WORKERS_UNREACHABLE — even
// though the workers gateway was answering /health in 3ms.
//
// Two distinct defects, both fixed in agents.ts:
//   Defect 1 — 60s cap defeats the tool's purpose. Fixed by HERMES_DELEGATE_TIMEOUT_MS
//               (default 300s). Tested by: "completes within budget" passing normally.
//   Defect 2 — Timeout reported as Unreachable. Fixed by distinguishing fetch
//               TimeoutError/AbortError (client-side deadline) from a
//               connection-level error and emitting the right code for each.
//               Tested directly below.
//
// The existing agents_focused_subagent.test.ts covers the health-probe path
// and gateway-returns-non-2xx. This file covers the fetch-THROWS path, which
// is where #325's mislabelling lived.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

// ─── test fixture ────────────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-timeout-"));
const hermesConfigDir = path.join(tmp, "hermes-state", "profiles");
fs.mkdirSync(path.join(hermesConfigDir, "workers"), { recursive: true });
fs.writeFileSync(
  path.join(hermesConfigDir, "workers", ".env"),
  // Obviously-fake sentinel key (real keys are 40+ hex chars; this is clearly synthetic).
  "API_SERVER_KEY=test-workers-key-fakefakefakefakefake\nOTHER=ignored\n",
);

process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";
process.env.HERMES_HOME = path.join(tmp, "hermes-state");
process.env.HERMES_CONFIG_DIR = hermesConfigDir;
process.env.HERMES_WORKERS_GATEWAY_URL = "http://hermes-timeout-test:18790";
// Do NOT override HERMES_DELEGATE_TIMEOUT_MS — the tests assert on the 300s default.

const realFetch = globalThis.fetch;

// Mutable per-test dispatch controls:
//   nextFetchError — if set, the mocked dispatch call throws this error instead of returning.
//   nextFetchResponse — the status + body the dispatch call returns when no error is set.
// The health probe always returns 200 so we isolate dispatch-path behaviour here.
let nextFetchError: Error | null = null;
let nextFetchResponse: { status: number; body: string } = {
  status: 200,
  body: JSON.stringify({ output: [{ content: [{ text: "task completed" }] }] }),
};

globalThis.fetch = (async (url: any, _init?: any) => {
  // Saturation probe (#540) — always reports an idle gateway so dispatch
  // proceeds and this file keeps testing the dispatch path. Must be matched
  // BEFORE the /health arm: "/health/detailed" does not end with "/health",
  // so without this it fell through to the dispatch arm and consumed the
  // injected error, which the probe then swallowed by design (fail-open).
  if (String(url).endsWith("/health/detailed")) {
    return new Response(
      JSON.stringify({ status: "ok", gateway_busy: false, active_agents: 0 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  // Health probe — always healthy so we can isolate dispatch errors.
  if (String(url).endsWith("/health")) {
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }
  // Dispatch call — either throw or return the configured response.
  if (nextFetchError) {
    const err = nextFetchError;
    nextFetchError = null;
    throw err;
  }
  return new Response(nextFetchResponse.body, {
    status: nextFetchResponse.status,
    headers: { "content-type": "application/json" },
  });
}) as typeof globalThis.fetch;

const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { registerAgentRoutes, _resetHermesRestartDebounceForTests } = await import("../src/api/routes/agents.js");
const { getStateDb } = await import("../src/db/state.js");

registerAgentRoutes();
getStateDb();

after(() => {
  _resetHermesRestartDebounceForTests();
  globalThis.fetch = realFetch;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function invoke(body: unknown): Promise<{ status: number; payload: any }> {
  const m = matchRoute("POST", "/api/v1/agents/focused-subagent");
  assert.ok(m, "route must be registered");
  let status = 0;
  let payload: any;
  const res = {
    setHeader() {},
    writeHead(c: number) { status = c; return res; },
    end(j?: string) { payload = j ? JSON.parse(j) : undefined; },
  } as unknown as ServerResponse;
  try {
    await m!.handler({
      req: { method: "POST", url: "/api/v1/agents/focused-subagent", headers: {}, socket: { remoteAddress: "10.0.0.1" } } as any,
      res,
      params: m!.params,
      body,
      query: new URLSearchParams(""),
    });
  } catch (err) {
    handleError(res, err);
  }
  return { status, payload };
}

// ─── #325 regression: error taxonomy ────────────────────────────────────────

describe("focused-subagent timeout vs unreachable taxonomy (#325)", () => {
  it("TimeoutError from fetch yields HERMES_WORKERS_TIMEOUT, not HERMES_WORKERS_UNREACHABLE", async () => {
    // #325: this was the lie — a client-side deadline abort was reported as
    // the gateway being down, even when /health answered in 3ms. The fix:
    // check err.name before picking the error code.
    const te = new Error("The operation was aborted due to timeout");
    te.name = "TimeoutError"; // AbortSignal.timeout() produces this name in Node 18+
    nextFetchError = te;

    const r = await invoke({ task: "long-running task", domain: "sure" });

    assert.equal(r.status, 504);
    assert.equal(r.payload.ok, false);
    assert.equal(r.payload.error, "HERMES_WORKERS_TIMEOUT",
      "a client-side AbortSignal.timeout() must not be labelled UNREACHABLE");
  });

  it("HERMES_WORKERS_TIMEOUT detail names the budget cap and the env knob to raise", async () => {
    // The detail must give the operator enough information to act:
    // which limit was hit (the ms value) and which knob raises it.
    const te = new Error("The operation was aborted due to timeout");
    te.name = "TimeoutError";
    nextFetchError = te;

    const r = await invoke({ task: "slow task", domain: "sure" });

    const detail = String(r.payload.detail ?? "");
    assert.ok(
      detail.includes("300000") || detail.includes("300_000"),
      `detail must mention the 300 000 ms default budget; got: ${detail}`,
    );
    assert.ok(
      detail.includes("HERMES_DELEGATE_TIMEOUT_MS"),
      `detail must name the env knob; got: ${detail}`,
    );
  });

  it("AbortError is also classified as HERMES_WORKERS_TIMEOUT", async () => {
    // fetch can also surface a manual controller.abort() as AbortError;
    // both abort flavours indicate "we ran out of time", not "gateway down".
    const ae = new Error("The operation was aborted");
    ae.name = "AbortError";
    nextFetchError = ae;

    const r = await invoke({ task: "cancellable task", domain: "sure" });

    assert.equal(r.status, 504);
    assert.equal(r.payload.error, "HERMES_WORKERS_TIMEOUT");
  });

  it("connection-level failure still yields HERMES_WORKERS_UNREACHABLE", async () => {
    // ECONNREFUSED/DNS errors are genuine "gateway is down" conditions —
    // they must keep the UNREACHABLE code so the operator knows to check
    // whether the workers container is running, not just adjust a timeout.
    const ce = new TypeError("fetch failed — connect ECONNREFUSED 10.0.0.1:18790");
    // Node's undici throws TypeError (not TimeoutError/AbortError) for
    // connection-level failures, so err.name is "TypeError" here.
    nextFetchError = ce;

    const r = await invoke({ task: "task", domain: "sure" });

    assert.equal(r.status, 504);
    assert.equal(r.payload.error, "HERMES_WORKERS_UNREACHABLE",
      "a connection-level failure must be labelled UNREACHABLE, not TIMEOUT");
  });

  it("a run that completes within the budget returns ok:true with the subagent reply", async () => {
    // Baseline: the happy path must still work — raising the budget must not
    // break normal fast runs.
    nextFetchResponse = {
      status: 200,
      body: JSON.stringify({ output: [{ content: [{ text: "Balance is $4,231." }] }] }),
    };

    const r = await invoke({ task: "balance?", domain: "sure" });

    assert.equal(r.status, 200);
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.reply, "Balance is $4,231.");
    assert.match(r.payload.session_key, /^focus-sure-[a-f0-9]{8}$/);
  });
});
