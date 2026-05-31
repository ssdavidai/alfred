// agentProfiles — Lane IV channel-context resolver tests.
//
// Lane IV adds `resolveProfileContextForChannel(db, kind, identity?)` — the
// helper every channel route uses to figure out (a) which Hermes profile owns
// this inbound, (b) which port that profile's gateway is on, (c) which .env
// the API_SERVER_KEY lives in, (d) the journal scoping key. This test
// exercises that helper end-to-end against the seeded registry + the on-disk
// profile dir layout (overridden via HERMES_CONFIG_DIR for hermeticity).
//
// What's covered:
//   * happy path — bound profile, .env present → context complete
//   * default binding (per-kind NULL) → falls back to 'main'
//   * archived-target cascade — bound profile is archived → cascade to main
//   * missing .env — api_server_key=null, no exception
//   * journal_scope_key matches slug
//   * port resolution honours per-profile api_server_port

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import schema from "../src/db/schema.sql";
import { runMigrations } from "../src/db/migrate.js";
import {
  bindChannel,
  createProfile,
  archiveProfile,
  resolveProfileContextForChannel,
} from "../src/db/agentProfiles.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lane-iv-ctx-"));
process.env.HERMES_CONFIG_DIR = TMP;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  runMigrations(db);
  return db;
}

function writeProfileEnv(slug: string, body: string): void {
  const dir = path.join(TMP, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".env"), body);
}

describe("resolveProfileContextForChannel — Lane IV", () => {
  before(() => {
    // Seed the 'main' profile's .env so api_server_key reads succeed.
    writeProfileEnv(
      "main",
      "# managed by render_hermes.py\nAPI_SERVER_KEY=main-key-43char-xxxxxxxxxxxxxxxxxxxxxx\nFOO=bar\n",
    );
  });

  after(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("happy path — default binding returns main context", () => {
    const db = freshDb();
    const ctx = resolveProfileContextForChannel(db, "telegram", null);
    assert.equal(ctx.slug, "main");
    assert.equal(ctx.bound_slug, "main");
    assert.equal(ctx.cascaded, false);
    assert.equal(ctx.api_server_port, 18789);
    assert.equal(
      ctx.api_server_key,
      "main-key-43char-xxxxxxxxxxxxxxxxxxxxxx",
    );
    assert.ok(ctx.profile_dir.endsWith("/main"));
    assert.equal(ctx.journal_scope_key, "main");
    db.close();
  });

  it("exact-match binding routes to a user-facing profile", () => {
    const db = freshDb();
    createProfile(db, {
      slug: "sentinel",
      label: "Sentinel",
      model: "x-ai/grok-4.3",
    });
    bindChannel(db, {
      channel_kind: "telegram",
      channel_identity: "55555",
      profile_slug: "sentinel",
    });
    writeProfileEnv("sentinel", "API_SERVER_KEY=sentinel-secret\n");

    const ctx = resolveProfileContextForChannel(db, "telegram", "55555");
    assert.equal(ctx.slug, "sentinel");
    assert.equal(ctx.bound_slug, "sentinel");
    assert.equal(ctx.cascaded, false);
    assert.equal(ctx.api_server_port, 18794); // first user-facing port
    assert.equal(ctx.api_server_key, "sentinel-secret");
    assert.equal(ctx.journal_scope_key, "sentinel");
    db.close();
  });

  it("unbound chat_id falls back to the per-kind default binding", () => {
    const db = freshDb();
    createProfile(db, {
      slug: "sentinel",
      label: "Sentinel",
      model: "x-ai/grok-4.3",
    });
    // Only 55555 is bound; 99999 should fall to the default → main.
    bindChannel(db, {
      channel_kind: "telegram",
      channel_identity: "55555",
      profile_slug: "sentinel",
    });

    const ctx = resolveProfileContextForChannel(db, "telegram", "99999");
    assert.equal(ctx.slug, "main");
    assert.equal(ctx.bound_slug, "main");
    assert.equal(ctx.cascaded, false);
    db.close();
  });

  it("archived bound profile cascades to main", () => {
    const db = freshDb();
    createProfile(db, {
      slug: "sentinel",
      label: "Sentinel",
      model: "x-ai/grok-4.3",
    });
    bindChannel(db, {
      channel_kind: "telegram",
      channel_identity: "55555",
      profile_slug: "sentinel",
    });
    // Now archive sentinel WITHOUT unbinding (Lane III is expected to
    // rebind first; we test the backstop).
    archiveProfile(db, "sentinel");

    const ctx = resolveProfileContextForChannel(db, "telegram", "55555");
    assert.equal(ctx.slug, "main");
    assert.equal(ctx.bound_slug, "sentinel");
    assert.equal(ctx.cascaded, true);
    assert.equal(ctx.api_server_port, 18789);
    db.close();
  });

  it("missing per-profile .env returns api_server_key=null without throwing", () => {
    const db = freshDb();
    createProfile(db, {
      slug: "ghost",
      label: "Ghost",
      model: "x-ai/grok-4.3",
    });
    bindChannel(db, {
      channel_kind: "slack",
      channel_identity: "T123:C456",
      profile_slug: "ghost",
    });
    // NB: we deliberately do NOT writeProfileEnv("ghost") — its dir is missing.

    const ctx = resolveProfileContextForChannel(db, "slack", "T123:C456");
    assert.equal(ctx.slug, "ghost");
    assert.equal(ctx.api_server_key, null);
    assert.ok(ctx.profile_dir.endsWith("/ghost"));
    db.close();
  });

  it("journal_scope_key matches the resolved slug (Lane IV contract)", () => {
    const db = freshDb();
    const cases = [
      ["telegram", null, "main"],
      ["slack", null, "main"],
      ["paperclip", null, "main"],
      ["email", null, "main"],
    ] as const;
    for (const [kind, ident, expectedSlug] of cases) {
      const ctx = resolveProfileContextForChannel(db, kind, ident);
      assert.equal(
        ctx.journal_scope_key,
        expectedSlug,
        `${kind}:${ident} should scope as ${expectedSlug}`,
      );
    }
    db.close();
  });

  it("per-kind defaults route independently", () => {
    const db = freshDb();
    createProfile(db, {
      slug: "sentinel",
      label: "Sentinel",
      model: "x-ai/grok-4.3",
    });
    // Rebind ONLY slack to sentinel; telegram should still default to main.
    bindChannel(db, {
      channel_kind: "slack",
      channel_identity: null,
      profile_slug: "sentinel",
    });

    const slackCtx = resolveProfileContextForChannel(db, "slack", null);
    assert.equal(slackCtx.slug, "sentinel");

    const tgCtx = resolveProfileContextForChannel(db, "telegram", null);
    assert.equal(tgCtx.slug, "main");
    db.close();
  });
});
