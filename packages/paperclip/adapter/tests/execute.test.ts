/**
 * execute() integration tests.
 *
 * We exercise the public makeExecute() factory with the HTTP call
 * stubbed, so a single test asserts both the upstream-compatible result
 * shape AND that the adapter wired the session-key / prompt / errors
 * correctly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  makeExecute,
  pickGatewayUrlForAgent,
  resolveSessionKey,
} from "../src/server/execute.js";
import type {
  AdapterAgent,
  AdapterExecutionContext,
} from "../src/types/paperclip.js";
import type { HermesCallResult } from "../src/server/hermes-http.js";
import {
  DEFAULT_HERMES_GATEWAY_URL,
  HERMES_CODEX_BUILDER_GATEWAY_URL,
} from "../src/shared/constants.js";

function makeAgent(over: Partial<AdapterAgent> = {}): AdapterAgent {
  return {
    id: "agent-123",
    companyId: "company-456",
    name: "hermes",
    adapterType: "hermes_local",
    adapterConfig: {},
    ...over,
  };
}

function makeCtx(
  agent: AdapterAgent,
  cfg: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext {
  const logs: { stream: "stdout" | "stderr"; chunk: string }[] = [];
  const meta: unknown[] = [];
  const ctx: AdapterExecutionContext = {
    runId: "run-789",
    agent,
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {},
    context: {},
    onLog: async (stream, chunk) => {
      logs.push({ stream, chunk });
    },
    onMeta: async (m) => {
      meta.push(m);
    },
    ...cfg,
  };
  (ctx as any).__logs = logs;
  (ctx as any).__meta = meta;
  return ctx;
}

describe("resolveSessionKey", () => {
  it("derives paperclip-<agentId> by default", () => {
    assert.equal(
      resolveSessionKey("abc", {}),
      "paperclip-abc",
    );
  });

  it("honours a pinned override", () => {
    assert.equal(
      resolveSessionKey("abc", { sessionKey: "custom-key" }),
      "custom-key",
    );
  });
});

describe("execute — happy path", () => {
  it("returns Paperclip-shaped result with usage + session params", async () => {
    let captured: { sessionKey: string; input: string } | null = null;
    const execute = makeExecute({
      readApiKey: (_p) => "stub-key",
      callHermes: async (sessionKey, input) => {
        captured = { sessionKey, input };
        const result: HermesCallResult = {
          ok: true,
          text: "all done",
          usage: { inputTokens: 100, outputTokens: 50 },
          raw: { model: "anthropic/claude-sonnet-4" },
        };
        return result;
      },
    });

    const agent = makeAgent();
    const ctx = makeCtx(agent);
    const result = await execute(ctx);

    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 50 });
    assert.equal(result.summary, "all done");
    assert.deepEqual(result.sessionParams, { sessionKey: "paperclip-agent-123" });
    assert.equal(result.sessionDisplayId, "paperclip-agent-123");
    assert.ok(result.resultJson);
    assert.equal(result.resultJson?.hermes_model, "anthropic/claude-sonnet-4");

    assert.ok(captured);
    assert.equal(captured!.sessionKey, "paperclip-agent-123");
    assert.ok(captured!.input.includes('You are "hermes"'));
    assert.ok((ctx as any).__meta.length === 1);
  });

  it("renders task variables into the prompt", async () => {
    let prompt: string | null = null;
    const execute = makeExecute({
      readApiKey: (_p) => null,
      callHermes: async (_session, input) => {
        prompt = input;
        return { ok: true, text: "", usage: null, raw: {} };
      },
    });
    const ctx = makeCtx(makeAgent());
    ctx.config = {
      taskId: "TRA-42",
      taskTitle: "Fix the thing",
      taskBody: "Body of the task",
    };
    await execute(ctx);
    assert.ok(prompt);
    assert.match(prompt!, /Issue ID: TRA-42/);
    assert.match(prompt!, /Title: Fix the thing/);
    assert.match(prompt!, /Body of the task/);
    // noTask section must be omitted when taskId present
    assert.doesNotMatch(prompt!, /Heartbeat Wake/);
  });

  it("renders the noTask section when no task assigned", async () => {
    let prompt: string | null = null;
    const execute = makeExecute({
      readApiKey: (_p) => null,
      callHermes: async (_session, input) => {
        prompt = input;
        return { ok: true, text: "ok", usage: null, raw: {} };
      },
    });
    await execute(makeCtx(makeAgent()));
    assert.ok(prompt);
    assert.match(prompt!, /Heartbeat Wake/);
    assert.doesNotMatch(prompt!, /Assigned Task/);
  });
});

describe("execute — error paths", () => {
  it("maps HERMES_AUTH to a 1-exit with errorCode", async () => {
    const execute = makeExecute({
      readApiKey: (_p) => "wrong-key",
      callHermes: async () => ({
        ok: false,
        code: "HERMES_AUTH",
        status: 401,
        detail: "invalid",
      }),
    });
    const result = await execute(makeCtx(makeAgent()));
    assert.equal(result.exitCode, 1);
    assert.equal(result.timedOut, false);
    assert.equal(result.errorCode, "hermes_auth_failed");
    assert.match(result.errorMessage ?? "", /HERMES_AUTH/);
  });

  it("maps HERMES_TIMEOUT to exit 124 + timedOut=true", async () => {
    const execute = makeExecute({
      readApiKey: (_p) => "k",
      callHermes: async () => ({
        ok: false,
        code: "HERMES_TIMEOUT",
        status: null,
        detail: "fetch timed out",
      }),
    });
    const result = await execute(makeCtx(makeAgent()));
    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, true);
    assert.equal(result.errorCode, "hermes_timeout");
  });

  it("preserves session key on transient failure", async () => {
    const execute = makeExecute({
      readApiKey: (_p) => "k",
      callHermes: async () => ({
        ok: false,
        code: "HERMES_UNREACHABLE",
        status: null,
        detail: "connection refused",
      }),
    });
    const result = await execute(makeCtx(makeAgent({ id: "xyz" })));
    assert.deepEqual(result.sessionParams, { sessionKey: "paperclip-xyz" });
    assert.equal(result.errorCode, "hermes_unreachable");
  });
});

describe("execute — session continuity", () => {
  it("reuses the same session key across heartbeats", async () => {
    const seen: string[] = [];
    const execute = makeExecute({
      readApiKey: (_p) => "k",
      callHermes: async (sessionKey) => {
        seen.push(sessionKey);
        return { ok: true, text: "ok", usage: null, raw: {} };
      },
    });
    const agent = makeAgent({ id: "stable-id" });
    await execute(makeCtx(agent));
    await execute(makeCtx(agent));
    await execute(makeCtx(agent));
    assert.deepEqual(seen, [
      "paperclip-stable-id",
      "paperclip-stable-id",
      "paperclip-stable-id",
    ]);
  });

  it("honours a pinned sessionKey from adapterConfig", async () => {
    let captured: string | null = null;
    const execute = makeExecute({
      readApiKey: (_p) => "k",
      callHermes: async (sessionKey) => {
        captured = sessionKey;
        return { ok: true, text: "ok", usage: null, raw: {} };
      },
    });
    const agent = makeAgent({ adapterConfig: { sessionKey: "custom-session" } });
    await execute(makeCtx(agent));
    assert.equal(captured, "custom-session");
  });
});

// =============================================================================
// pickGatewayUrlForAgent — codex-builder routing (PR 3 of
// docs/codex-builder-runtime.md)
// =============================================================================
describe("pickGatewayUrlForAgent", () => {
  it("routes codex-feature-builder to the codex-builder gateway", () => {
    const result = pickGatewayUrlForAgent(
      makeAgent({ name: "codex-feature-builder" }),
      {},
    );
    assert.equal(result.gatewayUrl, HERMES_CODEX_BUILDER_GATEWAY_URL);
    assert.equal(result.gatewayUrl, "http://hermes:18793");
    assert.equal(result.profile, "codex-builder");
  });

  it("is case-insensitive on the agent name lookup", () => {
    const result = pickGatewayUrlForAgent(
      makeAgent({ name: "Codex-Feature-Builder" }),
      {},
    );
    assert.equal(result.gatewayUrl, HERMES_CODEX_BUILDER_GATEWAY_URL);
    assert.equal(result.profile, "codex-builder");
  });

  it("routes every other agent name to the main gateway", () => {
    for (const name of [
      "hermes",
      "alfred-engineering-orchestrator",
      "alfred-code-reviewer",
      "ceo",
      "",
      "codex",
      "feature-builder",
      "codex-feature-builderx",
    ]) {
      const result = pickGatewayUrlForAgent(makeAgent({ name }), {});
      assert.equal(
        result.gatewayUrl,
        DEFAULT_HERMES_GATEWAY_URL,
        `name=${JSON.stringify(name)} must route to main, got ${result.gatewayUrl}`,
      );
      assert.equal(result.profile, "main");
    }
  });

  it("falls back to main when agent is null or missing a name", () => {
    assert.equal(
      pickGatewayUrlForAgent(null, {}).gatewayUrl,
      DEFAULT_HERMES_GATEWAY_URL,
    );
    assert.equal(
      pickGatewayUrlForAgent(undefined, {}).gatewayUrl,
      DEFAULT_HERMES_GATEWAY_URL,
    );
  });

  it("operator override (config.hermesGatewayUrl) wins even for codex-feature-builder", () => {
    // The override targets the network surface, not the auth surface —
    // profile stays `main` so the caller reads the main API key.
    const result = pickGatewayUrlForAgent(
      makeAgent({ name: "codex-feature-builder" }),
      { hermesGatewayUrl: "http://debug:18794" },
    );
    assert.equal(result.gatewayUrl, "http://debug:18794");
    assert.equal(result.profile, "main");
  });
});

describe("execute — routing wiring", () => {
  it("calls the codex-builder gateway with the codex-builder API key", async () => {
    let captured: { gatewayUrl: string; apiKey: string | null } | null = null;
    const execute = makeExecute({
      readApiKey: (p) =>
        p === "codex-builder" ? "codex-builder-key" : "main-key",
      callHermes: async (_sessionKey, _input, opts) => {
        captured = { gatewayUrl: opts.gatewayUrl, apiKey: opts.apiKey };
        return { ok: true, text: "ok", usage: null, raw: {} };
      },
    });
    const agent = makeAgent({ name: "codex-feature-builder" });
    await execute(makeCtx(agent));
    assert.ok(captured);
    assert.equal(captured!.gatewayUrl, "http://hermes:18793");
    assert.equal(captured!.apiKey, "codex-builder-key");
  });

  it("calls the main gateway with the main API key for everyone else", async () => {
    let captured: { gatewayUrl: string; apiKey: string | null } | null = null;
    const execute = makeExecute({
      readApiKey: (p) =>
        p === "codex-builder" ? "codex-builder-key" : "main-key",
      callHermes: async (_sessionKey, _input, opts) => {
        captured = { gatewayUrl: opts.gatewayUrl, apiKey: opts.apiKey };
        return { ok: true, text: "ok", usage: null, raw: {} };
      },
    });
    const agent = makeAgent({ name: "alfred-engineering-orchestrator" });
    await execute(makeCtx(agent));
    assert.ok(captured);
    assert.equal(captured!.gatewayUrl, "http://hermes:18789");
    assert.equal(captured!.apiKey, "main-key");
  });

  it("logs the profile name on the [hermes] line so an operator can diff", async () => {
    const logs: string[] = [];
    const execute = makeExecute({
      readApiKey: (_p) => "k",
      callHermes: async () => ({ ok: true, text: "ok", usage: null, raw: {} }),
    });
    const agent = makeAgent({ name: "codex-feature-builder" });
    const ctx = makeCtx(agent);
    ctx.onLog = async (_stream, chunk) => {
      logs.push(chunk);
    };
    await execute(ctx);
    const callingLine = logs.find((l) => l.startsWith("[hermes] Calling"));
    assert.ok(callingLine, "expected a [hermes] Calling log line");
    assert.match(callingLine!, /profile=codex-builder/);
    assert.match(callingLine!, /gateway=http:\/\/hermes:18793/);
  });
});
