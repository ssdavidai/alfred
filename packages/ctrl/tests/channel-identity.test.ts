// channel-identity — unit tests for #206 Q6 Lane I per-(profile, channel)
// display_name + avatar routes.
//
// Routes under test:
//   GET    /api/v1/agent-profiles/:slug/channel-identities
//   GET    /api/v1/agent-profiles/:slug/channel-identities/:kind
//   PUT    /api/v1/agent-profiles/:slug/channel-identities/:kind  (multipart)
//   DELETE /api/v1/agent-profiles/:slug/channel-identities/:kind
//
// Same in-process harness as profiles-mcp-catalog.test.ts. Multipart bodies
// are framed by buildMultipart() — the real ctrl-api consumes them from
// req.on('data').

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

// ── isolate state.db + hermes-state ────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "channel-identity-test-"));
process.env.STATE_DB_PATH = path.join(TMP, "state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.VAULT_PATH = path.join(TMP, "vault");
process.env.ALFRED_DATA_DIR = TMP;
process.env.HERMES_CONFIG_DIR = path.join(TMP, "profiles");
process.env.HERMES_STATE_DIR_CTRL_VIEW = path.join(TMP, "hermes-state");
process.env.INGEST_DB_PATH = path.join(TMP, "ingest.db");
fs.mkdirSync(process.env.HERMES_CONFIG_DIR, { recursive: true });

// ── mock supervisor (no docker calls) ──────────────────────────────────────
mock.module("../src/hermes/supervisor.js", {
  namedExports: {
    writeSupervisorRegistry: () => {},
    nudgeHermesSupervisor: () => true,
    restartProfile: () => ({ scope: "per-profile", attempted: true, warning: null }),
    REGISTRY_PATH: path.join(TMP, "hermes-state", "profiles", "_registry.json"),
  },
});

const { matchRoute } = await import("../src/api/server.js");
const { registerProfileRoutes } = await import("../src/api/routes/profiles.js");
const { registerChannelIdentityRoutes } = await import(
  "../src/api/routes/channel_identity.js"
);
const { handleError } = await import("../src/api/errors.js");
const { getStateDb } = await import("../src/db/state.js");
const { createProfile, archiveProfile } = await import("../src/db/agentProfiles.js");
const { resolveChannelIdentity } = await import("../src/db/channelIdentity.js");

registerProfileRoutes();
registerChannelIdentityRoutes();

// ── multipart helper ───────────────────────────────────────────────────────
// Builds a minimal RFC 7578 multipart body. Used to drive the PUT handler.
function buildMultipart(
  parts: Array<{
    name: string;
    filename?: string;
    contentType?: string;
    data: Buffer | string;
  }>,
  boundary = "----testboundaryX1Y2Z3",
): { body: Buffer; contentType: string } {
  const segs: Buffer[] = [];
  for (const p of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) {
      header += `; filename="${p.filename}"`;
    }
    header += "\r\n";
    if (p.contentType) header += `Content-Type: ${p.contentType}\r\n`;
    header += "\r\n";
    segs.push(Buffer.from(header));
    segs.push(typeof p.data === "string" ? Buffer.from(p.data) : p.data);
    segs.push(Buffer.from("\r\n"));
  }
  segs.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(segs),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// PNG fixture — a 1×1 transparent PNG, smallest valid bytes.
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000000005000167a2b3e80000000049454e44ae426082",
  "hex",
);

// ── http test helper ───────────────────────────────────────────────────────
function invokeRoute(
  method: string,
  url: string,
  opts: {
    params?: Record<string, string>;
    body?: unknown;
    multipart?: { body: Buffer; contentType: string };
  } = {},
): Promise<{ status: number; body: any }> {
  const matched = matchRoute(method, url);
  assert.ok(matched, `${method} ${url} must be registered`);
  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    let writeHeadStatus: number | null = null;
    const res: any = {
      statusCode: 200,
      setHeader() {},
      writeHead(s: number) {
        writeHeadStatus = s;
      },
      end(c?: any) {
        if (c !== undefined) chunks.push(c);
        try {
          const raw = Buffer.concat(
            chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c)))),
          ).toString();
          // Honour both writeHead(status) and direct res.statusCode = 204
          // mutation (the 204 DELETE path uses the latter).
          const status = writeHeadStatus ?? res.statusCode;
          resolve({ status, body: raw ? JSON.parse(raw) : {} });
        } catch (e) {
          reject(e);
        }
      },
      write(c: any) {
        chunks.push(c);
      },
    };
    // Build a fake IncomingMessage-ish object: Readable stream + headers.
    let req: any;
    if (opts.multipart) {
      req = Readable.from([opts.multipart.body]);
      req.headers = { "content-type": opts.multipart.contentType };
    } else {
      req = { headers: {} };
    }
    const merged = { ...(matched!.params ?? {}), ...(opts.params ?? {}) };
    Promise.resolve(
      matched!.handler({
        req,
        res,
        params: merged,
        query: new URLSearchParams(),
        body: opts.body ?? undefined,
      }),
    ).catch((err) => {
      try {
        handleError(res, err);
      } catch (e2) {
        reject(e2);
      }
    });
  });
}

// ── setup ──────────────────────────────────────────────────────────────────
const SLUG = "ci-test-sentinel";
const ARCHIVED_SLUG = "ci-test-archived";

before(() => {
  const db = getStateDb();
  createProfile(db, { slug: SLUG, label: "Channel Identity Sentinel", model: "gpt-4.1" });
  createProfile(db, {
    slug: ARCHIVED_SLUG,
    label: "Archived Sentinel",
    model: "gpt-4.1",
  });
  archiveProfile(db, ARCHIVED_SLUG);
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── GET list ───────────────────────────────────────────────────────────────

describe("GET /api/v1/agent-profiles/:slug/channel-identities", () => {
  it("returns 404 for an unknown slug", async () => {
    const { status, body } = await invokeRoute(
      "GET",
      "/api/v1/agent-profiles/:slug/channel-identities",
      { params: { slug: "no-such-profile" } },
    );
    assert.equal(status, 404);
    assert.match(body.error.message ?? body.error, /not found/i);
  });

  it("returns 200 + empty identities for a fresh profile", async () => {
    const { status, body } = await invokeRoute(
      "GET",
      "/api/v1/agent-profiles/:slug/channel-identities",
      { params: { slug: SLUG } },
    );
    assert.equal(status, 200);
    assert.deepEqual(body.identities, []);
  });
});

// ── PUT (multipart) ────────────────────────────────────────────────────────

describe("PUT /api/v1/agent-profiles/:slug/channel-identities/:kind", () => {
  it("returns 404 for an unknown profile", async () => {
    const mp = buildMultipart([{ name: "display_name", data: "Alfred" }]);
    const { status, body } = await invokeRoute(
      "PUT",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: "no-such-profile", kind: "telegram" }, multipart: mp },
    );
    assert.equal(status, 404);
    assert.match(body.error.message ?? body.error, /not found/i);
  });

  it("returns 409 for a reserved profile (main)", async () => {
    const mp = buildMultipart([{ name: "display_name", data: "Alfred" }]);
    const { status, body } = await invokeRoute(
      "PUT",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: "main", kind: "telegram" }, multipart: mp },
    );
    assert.equal(status, 409);
    assert.match(body.error.message ?? body.error, /reserved/i);
  });

  it("returns 409 for an archived profile", async () => {
    const mp = buildMultipart([{ name: "display_name", data: "Alfred" }]);
    const { status, body } = await invokeRoute(
      "PUT",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: ARCHIVED_SLUG, kind: "telegram" }, multipart: mp },
    );
    assert.equal(status, 409);
    assert.match(body.error.message ?? body.error, /archived/i);
  });

  it("returns 400 for an unknown channel kind", async () => {
    const mp = buildMultipart([{ name: "display_name", data: "Alfred" }]);
    const { status, body } = await invokeRoute(
      "PUT",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: SLUG, kind: "carrier-pigeon" }, multipart: mp },
    );
    assert.equal(status, 400);
    assert.match(body.error.message ?? body.error, /not a known channel/i);
  });

  it("returns 400 when no fields are supplied", async () => {
    // Send a multipart with no parts. Server should reject.
    const mp = buildMultipart([]);
    const { status, body } = await invokeRoute(
      "PUT",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: SLUG, kind: "telegram" }, multipart: mp },
    );
    assert.equal(status, 400);
    assert.match(body.error.message ?? body.error, /at least one/i);
  });

  it("returns 422 for a display_name > 64 chars", async () => {
    const long = "x".repeat(65);
    const mp = buildMultipart([{ name: "display_name", data: long }]);
    const { status, body } = await invokeRoute(
      "PUT",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: SLUG, kind: "telegram" }, multipart: mp },
    );
    assert.equal(status, 422);
    assert.match(body.error.message ?? body.error, /64/);
  });

  it("returns 400 for an avatar mime that isn't png/jpeg/webp", async () => {
    const mp = buildMultipart([
      {
        name: "avatar",
        filename: "evil.bmp",
        contentType: "image/bmp",
        data: Buffer.from([0x42, 0x4d, 0x00, 0x00]),
      },
    ]);
    const { status, body } = await invokeRoute(
      "PUT",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: SLUG, kind: "telegram" }, multipart: mp },
    );
    assert.equal(status, 400);
    assert.match(body.error.message ?? body.error, /not allowed|image\/png/i);
  });

  it("returns 400 for an avatar > 2 MB", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1024); // > 2 MiB
    const mp = buildMultipart([
      {
        name: "avatar",
        filename: "big.png",
        contentType: "image/png",
        data: big,
      },
    ]);
    const { status, body } = await invokeRoute(
      "PUT",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: SLUG, kind: "telegram" }, multipart: mp },
    );
    assert.equal(status, 400);
    assert.match(body.error.message ?? body.error, /exceeds|TOO_LARGE/i);
  });

  it("upserts display_name only — no avatar file written", async () => {
    const mp = buildMultipart([{ name: "display_name", data: "Alfred T." }]);
    const { status, body } = await invokeRoute(
      "PUT",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: SLUG, kind: "telegram" }, multipart: mp },
    );
    assert.equal(status, 200);
    assert.equal(body.channel_kind, "telegram");
    assert.equal(body.display_name, "Alfred T.");
    assert.equal(body.avatar_path, null);
    assert.equal(body.avatar_mime, null);
    // No avatar dir created (or empty if it was).
    const avatarsDir = path.join(
      process.env.HERMES_CONFIG_DIR!,
      SLUG,
      "avatars",
    );
    if (fs.existsSync(avatarsDir)) {
      const entries = fs.readdirSync(avatarsDir);
      assert.deepEqual(entries, [], "no avatar files written");
    }
  });

  it("upserts avatar — writes the PNG into the per-profile avatars dir", async () => {
    const mp = buildMultipart([
      {
        name: "avatar",
        filename: "av.png",
        contentType: "image/png",
        data: PNG_BYTES,
      },
    ]);
    const { status, body } = await invokeRoute(
      "PUT",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: SLUG, kind: "telegram" }, multipart: mp },
    );
    assert.equal(status, 200);
    assert.equal(body.avatar_mime, "image/png");
    assert.ok(
      body.avatar_path.endsWith(`/${SLUG}/avatars/telegram.png`),
      `avatar_path: ${body.avatar_path}`,
    );
    // The text field from the previous PUT was preserved.
    assert.equal(body.display_name, "Alfred T.");
    // The file actually exists on disk.
    assert.ok(fs.existsSync(body.avatar_path), "avatar file must exist on disk");
    const bytes = fs.readFileSync(body.avatar_path);
    assert.equal(bytes.length, PNG_BYTES.length);
  });

  it("upserts BOTH display_name and avatar in one PUT", async () => {
    const mp = buildMultipart([
      { name: "display_name", data: "Alfred T. v2" },
      {
        name: "avatar",
        filename: "av2.png",
        contentType: "image/png",
        data: PNG_BYTES,
      },
    ]);
    const { status, body } = await invokeRoute(
      "PUT",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: SLUG, kind: "slack" }, multipart: mp },
    );
    assert.equal(status, 200);
    assert.equal(body.display_name, "Alfred T. v2");
    assert.equal(body.avatar_mime, "image/png");
    assert.ok(body.avatar_path.endsWith(`/${SLUG}/avatars/slack.png`));
  });
});

// ── GET one ────────────────────────────────────────────────────────────────

describe("GET /api/v1/agent-profiles/:slug/channel-identities/:kind", () => {
  it("returns 200 with the stored row for an existing identity", async () => {
    const { status, body } = await invokeRoute(
      "GET",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: SLUG, kind: "telegram" } },
    );
    assert.equal(status, 200);
    assert.equal(body.channel_kind, "telegram");
    assert.equal(body.display_name, "Alfred T.");
    assert.equal(body.avatar_mime, "image/png");
  });

  it("returns 404 when no row exists for that (slug, kind)", async () => {
    const { status, body } = await invokeRoute(
      "GET",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: SLUG, kind: "sms" } },
    );
    assert.equal(status, 404);
    assert.match(body.error.message ?? body.error, /not found/i);
  });
});

// ── resolveChannelIdentity (Lane IV consumer entrypoint) ──────────────────

describe("resolveChannelIdentity (Lane IV contract)", () => {
  it("returns the resolved identity for an existing row", () => {
    const r = resolveChannelIdentity(getStateDb(), SLUG, "telegram");
    assert.ok(r, "expected non-null");
    assert.equal(r!.display_name, "Alfred T.");
    assert.equal(r!.avatar_mime, "image/png");
    assert.ok(r!.avatar_path && r!.avatar_path.endsWith(".png"));
  });

  it("returns null when there is no row for that (slug, kind)", () => {
    const r = resolveChannelIdentity(getStateDb(), SLUG, "email");
    assert.equal(r, null);
  });
});

// ── DELETE ─────────────────────────────────────────────────────────────────

describe("DELETE /api/v1/agent-profiles/:slug/channel-identities/:kind", () => {
  it("returns 204 + unlinks the avatar file", async () => {
    // Snapshot the avatar_path before the delete.
    const before = await invokeRoute(
      "GET",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: SLUG, kind: "slack" } },
    );
    const avatarPath = before.body.avatar_path;
    assert.ok(fs.existsSync(avatarPath), "avatar must exist before DELETE");

    const { status } = await invokeRoute(
      "DELETE",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: SLUG, kind: "slack" } },
    );
    assert.equal(status, 204);
    assert.equal(
      fs.existsSync(avatarPath),
      false,
      "avatar file must be unlinked after DELETE",
    );
    // GET must now 404.
    const after = await invokeRoute(
      "GET",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: SLUG, kind: "slack" } },
    );
    assert.equal(after.status, 404);
  });

  it("returns 404 when the row never existed", async () => {
    const { status, body } = await invokeRoute(
      "DELETE",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: SLUG, kind: "ha" } },
    );
    assert.equal(status, 404);
    assert.match(body.error.message ?? body.error, /not found/i);
  });

  it("returns 409 for a reserved profile (main)", async () => {
    const { status, body } = await invokeRoute(
      "DELETE",
      "/api/v1/agent-profiles/:slug/channel-identities/:kind",
      { params: { slug: "main", kind: "telegram" } },
    );
    assert.equal(status, 409);
    assert.match(body.error.message ?? body.error, /reserved/i);
  });
});

// ── isolation assertion ───────────────────────────────────────────────────

describe("cross-profile isolation", () => {
  it("PUT on the sentinel profile never writes outside its own dir", () => {
    // 'main' profile's avatars dir must NOT exist or, if it exists, be empty.
    const mainAvatars = path.join(
      process.env.HERMES_CONFIG_DIR!,
      "main",
      "avatars",
    );
    if (fs.existsSync(mainAvatars)) {
      const entries = fs.readdirSync(mainAvatars);
      assert.deepEqual(entries, [], "main's avatars dir untouched");
    }
    // The sentinel's avatars dir DOES exist + contains the telegram.png.
    const sentinelAvatars = path.join(
      process.env.HERMES_CONFIG_DIR!,
      SLUG,
      "avatars",
    );
    const entries = fs.readdirSync(sentinelAvatars).sort();
    assert.ok(entries.includes("telegram.png"), `expected telegram.png; got ${entries.join(",")}`);
  });
});
