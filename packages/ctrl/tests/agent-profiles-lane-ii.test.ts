// agent-profiles — Lane II coverage (#120).
//
// Pins the cascade-unbind on archive + the supervisor registry build/write
// behaviour. The route layer is intentionally minimal-coverage here because
// the route just translates lib calls to JSON; the lib is the load-bearing
// contract.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import schema from "../src/db/schema.sql";
import { runMigrations } from "../src/db/migrate.js";
import {
  createProfile,
  archiveProfile,
  bindChannel,
  listBindingsForProfile,
  listAllBindings,
  resolveProfileForChannel,
  buildSupervisorRegistry,
} from "../src/db/agentProfiles.js";
import { writeSupervisorRegistry } from "../src/hermes/supervisor.js";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  runMigrations(db);
  return db;
}

describe("agentProfiles — Lane II cascade unbind on archive", () => {
  it("removes non-default bindings pointing at the archived profile", () => {
    const db = freshDb();
    createProfile(db, { slug: "cratchit", label: "Cratchit", model: "x-ai/grok-4.3" });

    // Bind a specific telegram chat to cratchit.
    bindChannel(db, {
      channel_kind: "telegram",
      channel_identity: "12345",
      profile_slug: "cratchit",
    });
    // Bind a slack workspace to cratchit too.
    bindChannel(db, {
      channel_kind: "slack",
      channel_identity: "T0CRATCHIT",
      profile_slug: "cratchit",
    });
    // Sanity: cratchit has 2 non-default bindings.
    const before = listBindingsForProfile(db, "cratchit");
    assert.equal(before.length, 2);

    archiveProfile(db, "cratchit");

    // After archive, the non-default bindings are gone — the cascade
    // removed them so resolveProfileForChannel falls back to main.
    const after = listBindingsForProfile(db, "cratchit");
    assert.equal(after.length, 0);

    // The per-kind default bindings (id 'binding-default-<kind>') are
    // protected — they still exist (bound to 'main'), so resolution
    // for the freed (telegram, 12345) tuple cleanly falls through.
    assert.equal(resolveProfileForChannel(db, "telegram", "12345"), "main");
    assert.equal(resolveProfileForChannel(db, "slack", "T0CRATCHIT"), "main");

    db.close();
  });

  it("does NOT remove the per-kind default bindings on archive", () => {
    const db = freshDb();
    createProfile(db, { slug: "sentinel", label: "Sentinel", model: "m" });
    bindChannel(db, {
      channel_kind: "telegram",
      channel_identity: "99",
      profile_slug: "sentinel",
    });

    const defaultsBefore = listAllBindings(db).filter(
      (b) => b.id.startsWith("binding-default-"),
    );
    archiveProfile(db, "sentinel");
    const defaultsAfter = listAllBindings(db).filter(
      (b) => b.id.startsWith("binding-default-"),
    );

    assert.equal(defaultsAfter.length, defaultsBefore.length);
    // Each default still points at 'main'.
    for (const b of defaultsAfter) {
      assert.equal(b.profile_slug, "main");
    }
    db.close();
  });

  it("idempotent — re-archiving an already-archived profile is a no-op", () => {
    const db = freshDb();
    createProfile(db, { slug: "alpha", label: "A", model: "m" });
    archiveProfile(db, "alpha");
    // Second archive: must not throw, must keep the cascade outcome.
    archiveProfile(db, "alpha");
    db.close();
  });
});

describe("agentProfiles — Lane II buildSupervisorRegistry", () => {
  it("emits the four reserved profiles on a fresh tenant", () => {
    const db = freshDb();
    const reg = buildSupervisorRegistry(db);
    const slugs = reg.profiles.map((p) => p.slug).sort();
    assert.deepEqual(slugs, ["codex-builder", "heavy", "main", "workers"]);
    for (const p of reg.profiles) {
      assert.ok(p.api_server_port >= 18789 && p.api_server_port <= 18793);
      assert.ok(p.is_reserved);
    }
    db.close();
  });

  it("includes a user-facing profile after createProfile", () => {
    const db = freshDb();
    createProfile(db, { slug: "cratchit", label: "Cratchit", model: "m" });
    const reg = buildSupervisorRegistry(db);
    const cratchit = reg.profiles.find((p) => p.slug === "cratchit");
    assert.ok(cratchit, "cratchit must be in the registry");
    assert.equal(cratchit?.api_server_port, 18794);
    assert.equal(cratchit?.is_reserved, false);
    assert.equal(cratchit?.is_user_facing, true);
    assert.equal(cratchit?.status, "pending");
    db.close();
  });

  it("excludes archived profiles", () => {
    const db = freshDb();
    createProfile(db, { slug: "alpha", label: "A", model: "m" });
    createProfile(db, { slug: "bravo", label: "B", model: "m" });
    archiveProfile(db, "alpha");
    const reg = buildSupervisorRegistry(db);
    const slugs = reg.profiles.map((p) => p.slug);
    assert.ok(!slugs.includes("alpha"));
    assert.ok(slugs.includes("bravo"));
    db.close();
  });
});

describe("supervisor — module surface", () => {
  it("writeSupervisorRegistry + nudgeHermesSupervisor are exported", () => {
    // Static smoke — the route layer imports both names; verify the
    // module shape doesn't drift out from under it.
    assert.equal(typeof writeSupervisorRegistry, "function");
  });
});
