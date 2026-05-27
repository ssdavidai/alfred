/**
 * Unit tests for the HTTP client layer.
 *
 * We mock global fetch with a tiny in-process stub so we exercise the
 * exact code paths Paperclip will hit at runtime. No network is touched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  callHermesResponses,
  extractHermesText,
  extractHermesUsage,
  pingHermesHealth,
} from "../src/server/hermes-http.js";

type FetchMock = {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
};

function makeFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchMock {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn: typeof fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch: fn, calls };
}

describe("extractHermesText", () => {
  it("walks the canonical Responses envelope", () => {
    const envelope = {
      output: [
        { type: "reasoning", content: [{ type: "thought", text: "...." }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello world" }],
        },
      ],
    };
    assert.equal(extractHermesText(envelope), "hello world");
  });

  it("falls back to output_text when output is missing", () => {
    assert.equal(extractHermesText({ output_text: "fallback" }), "fallback");
  });

  it("returns empty string for malformed envelopes", () => {
    assert.equal(extractHermesText(null), "");
    assert.equal(extractHermesText("not an object"), "");
    assert.equal(extractHermesText({}), "");
  });

  it("joins multi-part assistant messages", () => {
    const envelope = {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "line 1" },
            { type: "output_text", text: "line 2" },
          ],
        },
      ],
    };
    assert.equal(extractHermesText(envelope), "line 1\nline 2");
  });
});

describe("extractHermesUsage", () => {
  it("reads OpenAI Responses-API shape", () => {
    const usage = extractHermesUsage({
      usage: {
        input_tokens: 120,
        output_tokens: 45,
        input_tokens_details: { cached_tokens: 80 },
      },
    });
    assert.deepEqual(usage, {
      inputTokens: 120,
      outputTokens: 45,
      cachedInputTokens: 80,
    });
  });

  it("tolerates camelCase + chat-completions shape", () => {
    assert.deepEqual(
      extractHermesUsage({ usage: { prompt_tokens: 1, completion_tokens: 2 } }),
      { inputTokens: 1, outputTokens: 2 },
    );
  });

  it("returns null when usage is absent", () => {
    assert.equal(extractHermesUsage({}), null);
    assert.equal(extractHermesUsage({ usage: {} }), null);
  });
});

describe("callHermesResponses — success", () => {
  it("POSTs to /v1/responses with session header + bearer", async () => {
    const mock = makeFetchMock(async () =>
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "hi from hermes" }],
            },
          ],
          usage: { input_tokens: 7, output_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await callHermesResponses({
      gatewayUrl: "http://hermes:18789",
      sessionKey: "paperclip-abc123",
      input: "do the thing",
      apiKey: "test-key",
      fetchImpl: mock.fetch,
    });

    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0]!.url, "http://hermes:18789/v1/responses");
    const init = mock.calls[0]!.init as RequestInit;
    assert.equal(init.method, "POST");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers["X-Hermes-Session-Key"], "paperclip-abc123");
    assert.equal(headers.Authorization, "Bearer test-key");
    assert.deepEqual(JSON.parse(init.body as string), { input: "do the thing" });

    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.text, "hi from hermes");
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3 });
  });

  it("strips trailing slash on the gateway URL", async () => {
    const mock = makeFetchMock(async () =>
      new Response(JSON.stringify({ output: [] }), { status: 200 }),
    );
    await callHermesResponses({
      gatewayUrl: "http://hermes:18789/",
      sessionKey: "k",
      input: "x",
      apiKey: null,
      fetchImpl: mock.fetch,
    });
    assert.equal(mock.calls[0]!.url, "http://hermes:18789/v1/responses");
  });
});

describe("callHermesResponses — failures", () => {
  it("classifies 401 as HERMES_AUTH", async () => {
    const mock = makeFetchMock(async () =>
      new Response("invalid api key", { status: 401 }),
    );
    const result = await callHermesResponses({
      sessionKey: "k",
      input: "x",
      apiKey: "bad",
      fetchImpl: mock.fetch,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "HERMES_AUTH");
    assert.equal(result.status, 401);
  });

  it("classifies 5xx as HERMES_HTTP", async () => {
    const mock = makeFetchMock(async () =>
      new Response("oops", { status: 502 }),
    );
    const result = await callHermesResponses({
      sessionKey: "k",
      input: "x",
      apiKey: null,
      fetchImpl: mock.fetch,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "HERMES_HTTP");
    assert.equal(result.status, 502);
  });

  it("classifies network error as HERMES_UNREACHABLE", async () => {
    const mock = makeFetchMock(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await callHermesResponses({
      sessionKey: "k",
      input: "x",
      apiKey: null,
      fetchImpl: mock.fetch,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "HERMES_UNREACHABLE");
  });

  it("classifies AbortError as HERMES_TIMEOUT", async () => {
    const mock = makeFetchMock(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const result = await callHermesResponses({
      sessionKey: "k",
      input: "x",
      apiKey: null,
      fetchImpl: mock.fetch,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "HERMES_TIMEOUT");
  });

  it("treats non-JSON 200 as HERMES_HTTP", async () => {
    const mock = makeFetchMock(async () =>
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    const result = await callHermesResponses({
      sessionKey: "k",
      input: "x",
      apiKey: null,
      fetchImpl: mock.fetch,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "HERMES_HTTP");
  });
});

describe("pingHermesHealth", () => {
  it("reports ok=true on 200", async () => {
    const mock = makeFetchMock(async () => new Response("OK", { status: 200 }));
    const res = await pingHermesHealth({
      gatewayUrl: "http://hermes:18789",
      fetchImpl: mock.fetch,
    });
    assert.equal(res.ok, true);
    assert.equal(mock.calls[0]!.url, "http://hermes:18789/health");
  });

  it("reports ok=false on 503", async () => {
    const mock = makeFetchMock(
      async () => new Response("starting up", { status: 503 }),
    );
    const res = await pingHermesHealth({
      gatewayUrl: "http://hermes:18789",
      fetchImpl: mock.fetch,
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 503);
  });

  it("reports ok=false on network error", async () => {
    const mock = makeFetchMock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await pingHermesHealth({
      gatewayUrl: "http://hermes:18789",
      fetchImpl: mock.fetch,
    });
    assert.equal(res.ok, false);
    assert.match(res.detail, /ECONNREFUSED/);
  });
});
