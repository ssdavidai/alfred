// files-tools.test.ts — guards the voice-bridge `files__*` read-only surface
// (#114 PR4). Four tools (list / stat / read_text / search), no writes, and
// a 32 KB `max_bytes` ceiling on read_text enforced client-side before any
// blob fetch crosses the wire.
//
// What this pins:
//
//   1. Each of the 4 tool defs has the right OpenAI Realtime shape:
//      `type: "function"`, `name: "files__<x>"`, `description` non-empty,
//      `parameters` is a JSON Schema object.
//
//   2. `files__read_text` enforces the `max_bytes` ceiling pre-fetch by
//      checking stat — when the stat row reports `size_bytes > cap`, the
//      tool returns `{too_large: true, ...}` and DOES NOT fetch the blob.
//      This is voice-side defence — the same surface from any other
//      caller can read the whole file via the ctrl-api blob route.
//
//   3. Binary content_types short-circuit through the same `too_large`
//      branch — voice can't read 2 MB of PDF aloud, telling Sir that
//      faster than waiting for the bytes is the right shape.
//
//   4. `isFilesToolName` matches all four tool names and only those four.
//
//   5. (Cross-package guard) The voice-bridge allowlist in ctrl-api/auth.ts
//      contains the right 4 routes — list + usage (exact) + stat + blob
//      (regex). Voice writes (POST upload, PATCH :path, DELETE :path) are
//      REJECTED. This is asserted from the ctrl-api side in
//      packages/ctrl/tests/auth-scoped-voice-bridge.test.ts (cannot reach
//      into ctrl-api auth from a voice-bridge test — different package, no
//      shared runtime — but the pattern is mirrored here).
//
// Runs under `node --test` after `tsc`. No mocha/jest.

import { test } from "node:test";
import assert from "node:assert/strict";

// IMPORTANT: env must be set before importing SUT (config.ts reads env at
// module-load time).
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "sk-test-dummy";
process.env.VOICE_BRIDGE_INTERNAL_TOKEN =
  process.env.VOICE_BRIDGE_INTERNAL_TOKEN ?? "test-internal-token";

// ──────────────────────────────────────────────────────────────────── 1. schemas

test("files__list — function schema is the OpenAI Realtime shape", async () => {
  const { FILES_LIST_TOOL } = await import("./files-tools.js");
  assert.equal(FILES_LIST_TOOL.type, "function");
  assert.equal(FILES_LIST_TOOL.name, "files__list");
  assert.ok(
    FILES_LIST_TOOL.description.length > 40,
    "description should be informative",
  );
  assert.equal(FILES_LIST_TOOL.parameters.type, "object");
  const props = FILES_LIST_TOOL.parameters.properties as Record<string, unknown>;
  for (const key of ["prefix", "q", "limit", "offset"]) {
    assert.ok(key in props, `files__list missing parameter: ${key}`);
  }
});

test("files__stat — function schema requires `path`", async () => {
  const { FILES_STAT_TOOL } = await import("./files-tools.js");
  assert.equal(FILES_STAT_TOOL.type, "function");
  assert.equal(FILES_STAT_TOOL.name, "files__stat");
  assert.ok(FILES_STAT_TOOL.description.length > 40);
  assert.deepEqual(FILES_STAT_TOOL.parameters.required, ["path"]);
});

test("files__read_text — function schema requires `path`, allows optional `max_bytes`", async () => {
  const { FILES_READ_TEXT_TOOL } = await import("./files-tools.js");
  assert.equal(FILES_READ_TEXT_TOOL.type, "function");
  assert.equal(FILES_READ_TEXT_TOOL.name, "files__read_text");
  assert.ok(FILES_READ_TEXT_TOOL.description.length > 40);
  const props = FILES_READ_TEXT_TOOL.parameters.properties as Record<
    string,
    Record<string, unknown>
  >;
  assert.ok("path" in props);
  assert.ok("max_bytes" in props);
  assert.deepEqual(FILES_READ_TEXT_TOOL.parameters.required, ["path"]);
  // Hard cap pinned at 64 KB.
  assert.equal(props.max_bytes.maximum, 64 * 1024);
});

test("files__search — function schema requires `q`", async () => {
  const { FILES_SEARCH_TOOL } = await import("./files-tools.js");
  assert.equal(FILES_SEARCH_TOOL.type, "function");
  assert.equal(FILES_SEARCH_TOOL.name, "files__search");
  assert.ok(FILES_SEARCH_TOOL.description.length > 40);
  assert.deepEqual(FILES_SEARCH_TOOL.parameters.required, ["q"]);
});

test("FILES_TOOLS is the 4-tool catalogue — no writes, no base64 reads", async () => {
  const { FILES_TOOLS } = await import("./files-tools.js");
  assert.equal(FILES_TOOLS.length, 4, "voice-bridge files surface must stay at 4 tools");
  const names = FILES_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "files__list",
    "files__read_text",
    "files__search",
    "files__stat",
  ]);
  // Defence in depth — assert no write-shaped names crept in.
  for (const writeName of [
    "files__create",
    "files__delete",
    "files__describe",
    "files__read_base64",
    "files__usage",
  ]) {
    assert.ok(
      !names.includes(writeName),
      `voice surface must NOT include ${writeName}`,
    );
  }
});

test("isFilesToolName matches the 4 tools and rejects everything else", async () => {
  const { isFilesToolName } = await import("./files-tools.js");
  for (const name of [
    "files__list",
    "files__stat",
    "files__read_text",
    "files__search",
  ]) {
    assert.equal(isFilesToolName(name), true, `${name} should be a files tool`);
  }
  for (const name of [
    "files__create",
    "files__delete",
    "files__describe",
    "files__read_base64",
    "files__usage",
    "self",
    "composio_execute",
    "alfred__list_briefings",
    "execute__list_connections",
    "",
  ]) {
    assert.equal(isFilesToolName(name), false, `${name} should NOT match`);
  }
});

// ──────────────────────────────────────────── 2. read_text ceiling enforcement

// Minimal fetch stub. The dispatcher calls `fetch` against two ctrl-api
// shapes: GET /api/v1/files/stat/<path> (JSON), and (only when stat OKs the
// fetch) GET /api/v1/files/blob/<path> (raw bytes). We mock the global
// `fetch` to return a stat row + remember whether the blob route was hit.

interface FetchCall {
  url: string;
  method?: string;
}

function installFetchMock(
  responder: (url: string) => { status: number; body: unknown; bodyKind?: "json" | "bytes"; contentType?: string },
): { calls: FetchCall[]; restore: () => void } {
  const original = (globalThis as any).fetch;
  const calls: FetchCall[] = [];
  (globalThis as any).fetch = async (urlIn: any, init: any = {}) => {
    const url = String(urlIn);
    calls.push({ url, method: init?.method ?? "GET" });
    const r = responder(url);
    const ct = r.contentType ?? (r.bodyKind === "bytes" ? "text/plain; charset=utf-8" : "application/json");
    const headers = new Headers({ "content-type": ct });
    const ok = r.status >= 200 && r.status < 300;
    if (r.bodyKind === "bytes") {
      const bytes =
        typeof r.body === "string"
          ? new TextEncoder().encode(r.body)
          : (r.body as Uint8Array);
      return {
        ok,
        status: r.status,
        headers,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        text: async () => new TextDecoder().decode(bytes),
      };
    }
    const text = JSON.stringify(r.body);
    return {
      ok,
      status: r.status,
      headers,
      text: async () => text,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    };
  };
  return {
    calls,
    restore: () => {
      (globalThis as any).fetch = original;
    },
  };
}

function fakeTenant(): any {
  // Mirrors the tenant-context shape voice-bridge passes. The dispatcher
  // only reads `tailscaleHost` + `aasApiKey` indirectly (via
  // ctrlApiUrl / ctrlApiAuthToken). Single-VM mode uses sentinel values.
  return {
    tenantId: "test-tenant",
    tailscaleHost: "local",
    aasApiKey: "",
    phoneNumber: "+15555550100",
  };
}

test("files__read_text — short-circuits with `too_large` when stat reports size > cap", async () => {
  const { dispatchFilesReadText, _FILES_READ_TEXT_LIMITS } = await import(
    "./files-tools.js"
  );

  const mock = installFetchMock((url) => {
    if (url.includes("/files/stat/")) {
      return {
        status: 200,
        body: {
          path: "01J9X7/big.txt",
          size_bytes: 500_000, // way over the 32 KB default
          content_type: "text/plain",
        },
      };
    }
    // Should NOT be hit — the stat-side cap must short-circuit.
    return { status: 200, body: { unreachable: true } };
  });

  try {
    const result = await dispatchFilesReadText(fakeTenant(), {
      path: "01J9X7/big.txt",
    });
    assert.equal(result.ok, true, "result should be ok=true with too_large body");
    const data = result.data as Record<string, unknown>;
    assert.equal(data.too_large, true, "too_large flag missing");
    assert.equal(data.size_bytes, 500_000);
    assert.equal(data.max_bytes, _FILES_READ_TEXT_LIMITS.DEFAULT);
    assert.ok(
      typeof data.suggestion === "string" && (data.suggestion as string).length > 0,
      "suggestion missing",
    );

    // Critical: assert the blob route was NEVER called. Voice paying for a
    // 500 KB transfer the model has to truncate anyway is exactly the trap
    // this guard exists to prevent.
    const blobCalls = mock.calls.filter((c) => c.url.includes("/files/blob/"));
    assert.equal(
      blobCalls.length,
      0,
      "files__read_text MUST NOT fetch the blob when too_large fires",
    );
  } finally {
    mock.restore();
  }
});

test("files__read_text — fetches blob and inlines content when within ceiling", async () => {
  const { dispatchFilesReadText } = await import("./files-tools.js");

  const mock = installFetchMock((url) => {
    if (url.includes("/files/stat/")) {
      return {
        status: 200,
        body: {
          path: "01J9X7/note.txt",
          size_bytes: 12, // small — within cap
          content_type: "text/plain",
        },
      };
    }
    if (url.includes("/files/blob/")) {
      return {
        status: 200,
        body: "hello, sir.",
        bodyKind: "bytes",
        contentType: "text/plain; charset=utf-8",
      };
    }
    return { status: 404, body: { error: "not found" } };
  });

  try {
    const result = await dispatchFilesReadText(fakeTenant(), {
      path: "01J9X7/note.txt",
    });
    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.too_large, undefined, "should not be too_large");
    assert.equal(data.content, "hello, sir.");
    assert.equal(data.path, "01J9X7/note.txt");
    assert.equal(data.size_bytes, 12);

    const blobCalls = mock.calls.filter((c) => c.url.includes("/files/blob/"));
    assert.equal(blobCalls.length, 1, "blob should be fetched once");
  } finally {
    mock.restore();
  }
});

test("files__read_text — short-circuits binary content_types as too_large", async () => {
  const { dispatchFilesReadText } = await import("./files-tools.js");

  const mock = installFetchMock((url) => {
    if (url.includes("/files/stat/")) {
      return {
        status: 200,
        body: {
          path: "01J9X7/receipt.pdf",
          size_bytes: 1024, // small but BINARY
          content_type: "application/pdf",
        },
      };
    }
    return { status: 200, body: { unreachable: true } };
  });

  try {
    const result = await dispatchFilesReadText(fakeTenant(), {
      path: "01J9X7/receipt.pdf",
    });
    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.too_large, true);
    assert.equal(data.binary, true);
    assert.equal(data.content_type, "application/pdf");

    const blobCalls = mock.calls.filter((c) => c.url.includes("/files/blob/"));
    assert.equal(blobCalls.length, 0, "binary should not fetch the blob");
  } finally {
    mock.restore();
  }
});

test("files__read_text — clamps a model-supplied max_bytes ABOVE the hard cap", async () => {
  const { dispatchFilesReadText, _FILES_READ_TEXT_LIMITS } = await import(
    "./files-tools.js"
  );

  // Stat reports a 70 KB file — JUST over the hard cap, and the model
  // tries to bypass the limit with `max_bytes: 1048576`. The dispatcher
  // must clamp to the hard cap and the file must come back as too_large.
  const mock = installFetchMock((url) => {
    if (url.includes("/files/stat/")) {
      return {
        status: 200,
        body: {
          path: "01J9X7/log.txt",
          size_bytes: 70 * 1024,
          content_type: "text/plain",
        },
      };
    }
    return { status: 200, body: "would be data", bodyKind: "bytes" };
  });

  try {
    const result = await dispatchFilesReadText(fakeTenant(), {
      path: "01J9X7/log.txt",
      max_bytes: 1_048_576, // 1 MB — way above the hard cap
    });
    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.too_large, true);
    assert.equal(
      data.max_bytes,
      _FILES_READ_TEXT_LIMITS.HARD_CAP,
      "model-supplied max_bytes must be clamped to hard cap",
    );
    const blobCalls = mock.calls.filter((c) => c.url.includes("/files/blob/"));
    assert.equal(blobCalls.length, 0);
  } finally {
    mock.restore();
  }
});

// ───────────────────────────────────────────────────────── 3. allowlist regex shapes

// Mirror of the regex shapes in packages/ctrl/src/api/auth.ts. Re-asserted
// here so a drift in either file fails the voice-bridge test suite — the
// allowlist is the load-bearing security boundary; if it doesn't match
// the dispatcher routes, the tool 401s and Sir hears "the files surface is
// unavailable" instead of getting his contract back.

const VOICE_FILES_EXACT = new Set<string>([
  "GET:/api/v1/files/list",
  "GET:/api/v1/files/usage",
]);

const VOICE_FILES_PATTERNS: Array<{ method: string; regex: RegExp }> = [
  { method: "GET", regex: /^\/api\/v1\/files\/stat\/.+$/ },
  { method: "GET", regex: /^\/api\/v1\/files\/blob\/.+$/ },
];

function voiceAllowsFilesRoute(method: string, pathname: string): boolean {
  if (VOICE_FILES_EXACT.has(`${method}:${pathname}`)) return true;
  for (const p of VOICE_FILES_PATTERNS) {
    if (p.method === method && p.regex.test(pathname)) return true;
  }
  return false;
}

test("voice allowlist accepts the 4 read-only files routes", () => {
  for (const pathname of [
    "/api/v1/files/list",
    "/api/v1/files/usage",
  ]) {
    assert.equal(
      voiceAllowsFilesRoute("GET", pathname),
      true,
      `voice should accept GET ${pathname}`,
    );
  }
  // Pattern-matched routes — stat + blob with ULID/safe-name shapes.
  for (const pathname of [
    "/api/v1/files/stat/01J9X7C0H4Q2Z8/photo.jpg",
    "/api/v1/files/stat/01J9X7C0H4Q2Z8/some/nested/name.pdf",
    "/api/v1/files/blob/01J9X7C0H4Q2Z8/photo.jpg",
    "/api/v1/files/blob/01J9X7C0H4Q2Z8/nested/q3-report.md",
  ]) {
    assert.equal(
      voiceAllowsFilesRoute("GET", pathname),
      true,
      `voice should accept GET ${pathname}`,
    );
  }
});

test("voice allowlist REJECTS files writes (POST upload, PATCH :path, DELETE :path)", () => {
  // The contract is read-only — these routes ARE the ones Hermes' `files`
  // MCP catalogue surfaces, and voice MUST NOT inherit them. The matcher
  // here mirrors ctrl-api auth.ts; a regression that adds them to voice
  // would be caught by both this test and auth-scoped-voice-bridge.test.ts.
  for (const route of [
    { method: "POST", pathname: "/api/v1/files/upload" },
    { method: "DELETE", pathname: "/api/v1/files/01J9X7C0H4Q2Z8/photo.jpg" },
    { method: "PATCH", pathname: "/api/v1/files/01J9X7C0H4Q2Z8/photo.jpg" },
    // Anti-regression — prefix-neighbour rejections.
    { method: "GET", pathname: "/api/v1/files" }, // bare path
    { method: "GET", pathname: "/api/v1/files/listing" }, // prefix-neighbour to /list
    { method: "GET", pathname: "/api/v1/files/usage/extra" }, // prefix-neighbour
    { method: "POST", pathname: "/api/v1/files/list" }, // wrong method
  ]) {
    assert.equal(
      voiceAllowsFilesRoute(route.method, route.pathname),
      false,
      `voice allowlist MUST reject ${route.method} ${route.pathname}`,
    );
  }
});

// ───────────────────────────────────────── 4. instructions surface mentions files

test("voice persona mentions files__* read-only surface and the `too_large` rule", async () => {
  const { buildInstructions } = await import("./instructions.js");
  const out = buildInstructions({
    tenantPhoneNumber: "+15555550100",
    initiator: "user",
    voiceContext: null,
  });
  // Persona surfaces the four files tools by name (so the model has them
  // top-of-mind when Sir says "read me that file").
  assert.match(out, /files__list/);
  assert.match(out, /files__read_text/);
  // Guardrail #7 — respect the too_large flag instead of hallucinating
  // contents. Last-line rule, recency-weighted attention.
  assert.match(out, /too_large/);
  assert.match(out, /Voice guardrails — read these last/);
});
