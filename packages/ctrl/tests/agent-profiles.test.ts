// agent-profiles — registry helper lib unit tests (#120 Lane I).
//
// Exercises the typed lib in src/db/agentProfiles.ts against an in-memory
// state.db with migrations applied. The HTTP surface is tested separately
// at the route layer; this file covers the contract every Lane (II/III/IV)
// reads from.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import schema from "../src/db/schema.sql";
import { runMigrations } from "../src/db/migrate.js";
import {
  PORT_RANGE_USER_LO,
  PORT_RANGE_USER_HI,
  RESERVED_SLUGS,
  KNOWN_CHANNEL_KINDS,
  validateSlug,
  listAllProfiles,
  listUserProfiles,
  getProfile,
  allocateUserPort,
  createProfile,
  archiveProfile,
  restoreProfile,
  setProfileStatus,
  listBindingsForProfile,
  listAllBindings,
  resolveProfileForChannel,
  bindChannel,
  unbindChannel,
} from "../src/db/agentProfiles.js";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  runMigrations(db);
  return db;
}

describe("agentProfiles — seed", () => {
  it("seeds the four reserved infra profiles", () => {
    const db = freshDb();
    const all = listAllProfiles(db);
    const slugs = all.map((p) => p.slug).sort();
    assert.deepEqual(slugs, ["codex-builder", "heavy", "main", "workers"]);
    for (const p of all) {
      assert.equal(p.is_reserved, true, `${p.slug} must be reserved`);
    }
    db.close();
  });

  it("seeds main as the only user-facing profile", () => {
    const db = freshDb();
    const user = listUserProfiles(db);
    assert.equal(user.length, 1);
    assert.equal(user[0].slug, "main");
    assert.equal(user[0].is_user_facing, true);
    db.close();
  });

  it("seeds reserved profiles on the correct infra ports", () => {
    const db = freshDb();
    const portFor = (slug: string) =>
      getProfile(db, slug)?.api_server_port ?? -1;
    assert.equal(portFor("main"), 18789);
    assert.equal(portFor("workers"), 18790);
    assert.equal(portFor("heavy"), 18791);
    assert.equal(portFor("codex-builder"), 18793);
    db.close();
  });

  it("seeds a (kind, NULL, 'main') default binding for every known channel kind", () => {
    const db = freshDb();
    const all = listAllBindings(db);
    const defaults = all.filter((b) => b.channel_identity === null);
    assert.equal(
      defaults.length,
      KNOWN_CHANNEL_KINDS.size,
      "one default per known channel kind",
    );
    for (const d of defaults) {
      assert.equal(d.profile_slug, "main");
      assert.ok(
        d.id.startsWith("binding-default-"),
        `default binding id has the expected prefix: ${d.id}`,
      );
    }
    db.close();
  });
});

describe("agentProfiles — validateSlug", () => {
  it("accepts kebab-case slugs", () => {
    assert.equal(validateSlug("cratchit"), "cratchit");
    assert.equal(validateSlug("sentinel-2"), "sentinel-2");
    assert.equal(validateSlug("a1"), "a1");
  });

  it("rejects malformed slugs", () => {
    assert.throws(() => validateSlug("Cratchit"), /must match/);
    assert.throws(() => validateSlug("with_underscore"), /must match/);
    assert.throws(() => validateSlug("a"), /must match/, "too short");
    assert.throws(() => validateSlug("1starts-with-digit"), /must match/);
    assert.throws(() => validateSlug("has space"), /must match/);
    assert.throws(() => validateSlug(""), /must match/);
    assert.throws(() => validateSlug("x".repeat(32)), /must match/, "too long");
    assert.throws(() => validateSlug(123 as unknown), /must be a string/);
  });

  it("rejects every reserved slug", () => {
    for (const slug of RESERVED_SLUGS) {
      assert.throws(
        () => validateSlug(slug),
        /reserved/,
        `${slug} must be reserved`,
      );
    }
  });
});

describe("agentProfiles — port allocation", () => {
  it("returns 18794 on a fresh tenant", () => {
    const db = freshDb();
    assert.equal(allocateUserPort(db), PORT_RANGE_USER_LO);
    db.close();
  });

  it("packs densely as profiles are created", () => {
    const db = freshDb();
    const a = createProfile(db, { slug: "alpha", label: "A", model: "m" });
    const b = createProfile(db, { slug: "bravo", label: "B", model: "m" });
    const c = createProfile(db, { slug: "charlie", label: "C", model: "m" });
    assert.equal(a.api_server_port, 18794);
    assert.equal(b.api_server_port, 18795);
    assert.equal(c.api_server_port, 18796);
    assert.equal(allocateUserPort(db), 18797);
    db.close();
  });

  it("reuses a freed port after archive", () => {
    const db = freshDb();
    createProfile(db, { slug: "alpha", label: "A", model: "m" }); // 18794
    createProfile(db, { slug: "bravo", label: "B", model: "m" }); // 18795
    archiveProfile(db, "alpha"); // frees 18794
    const c = createProfile(db, { slug: "charlie", label: "C", model: "m" });
    assert.equal(c.api_server_port, 18794, "lowest free port reused");
    db.close();
  });

  it("returns null when range is exhausted", () => {
    const db = freshDb();
    for (let i = 0; i < 6; i++) {
      createProfile(db, { slug: `p${i}`, label: `P${i}`, model: "m" });
    }
    assert.equal(allocateUserPort(db), null);
    db.close();
  });
});

describe("agentProfiles — createProfile", () => {
  it("creates a pending user-facing profile and packs the next free port", () => {
    const db = freshDb();
    const p = createProfile(db, {
      slug: "cratchit",
      label: "Cratchit",
      model: "x-ai/grok-4.3",
      description: "Joe's personal assistant",
    });
    assert.equal(p.slug, "cratchit");
    assert.equal(p.label, "Cratchit");
    assert.equal(p.description, "Joe's personal assistant");
    assert.equal(p.status, "pending");
    assert.equal(p.is_user_facing, true);
    assert.equal(p.is_reserved, false);
    assert.equal(p.deployment_shape, "supervised");
    assert.ok(
      p.api_server_port >= PORT_RANGE_USER_LO &&
        p.api_server_port <= PORT_RANGE_USER_HI,
      `port in user range, got ${p.api_server_port}`,
    );
    db.close();
  });

  it("rejects a reserved slug", () => {
    const db = freshDb();
    assert.throws(
      () => createProfile(db, { slug: "main", label: "x", model: "m" }),
      /reserved/,
    );
    db.close();
  });

  it("rejects a duplicate slug", () => {
    const db = freshDb();
    createProfile(db, { slug: "alpha", label: "A", model: "m" });
    assert.throws(
      () => createProfile(db, { slug: "alpha", label: "A2", model: "m" }),
      /already exists/,
    );
    db.close();
  });

  it("rejects 'sibling' deployment shape in v1", () => {
    const db = freshDb();
    assert.throws(
      () =>
        createProfile(db, {
          slug: "alpha",
          label: "A",
          model: "m",
          deployment_shape: "sibling",
        }),
      /not supported in v1/,
    );
    db.close();
  });

  it("rejects beyond 6 user profiles per tenant", () => {
    const db = freshDb();
    for (let i = 0; i < 6; i++) {
      createProfile(db, { slug: `p${i}`, label: `P${i}`, model: "m" });
    }
    assert.throws(
      () => createProfile(db, { slug: "seven", label: "7", model: "m" }),
      /no free user-facing port/,
    );
    db.close();
  });

  it("rejects empty label / model", () => {
    const db = freshDb();
    assert.throws(
      () => createProfile(db, { slug: "alpha", label: "", model: "m" }),
      /label/,
    );
    assert.throws(
      () => createProfile(db, { slug: "alpha", label: "A", model: "" }),
      /model/,
    );
    db.close();
  });
});

describe("agentProfiles — archive", () => {
  it("refuses to archive a reserved profile", () => {
    const db = freshDb();
    assert.throws(() => archiveProfile(db, "main"), /reserved/);
    assert.throws(() => archiveProfile(db, "workers"), /reserved/);
    db.close();
  });

  it("archives a user profile and stamps archived_at", () => {
    const db = freshDb();
    const before = createProfile(db, {
      slug: "alpha",
      label: "A",
      model: "m",
    });
    assert.equal(before.archived_at, null);
    const after = archiveProfile(db, "alpha");
    assert.equal(after.status, "archived");
    assert.ok(after.archived_at != null);
    db.close();
  });

  it("is idempotent — re-archiving returns the same row", () => {
    const db = freshDb();
    createProfile(db, { slug: "alpha", label: "A", model: "m" });
    const a = archiveProfile(db, "alpha");
    const b = archiveProfile(db, "alpha");
    assert.equal(a.archived_at, b.archived_at);
    db.close();
  });

  it("throws on unknown slug", () => {
    const db = freshDb();
    assert.throws(() => archiveProfile(db, "nope"), /not found/);
    db.close();
  });
});

describe("agentProfiles — restore (Lane III)", () => {
  it("brings an archived profile back with status='pending'", () => {
    const db = freshDb();
    createProfile(db, { slug: "alpha", label: "A", model: "m" });
    archiveProfile(db, "alpha");
    const restored = restoreProfile(db, "alpha");
    assert.equal(restored.status, "pending");
    assert.equal(restored.archived_at, null);
    db.close();
  });

  it("refuses to restore a profile that isn't archived", () => {
    const db = freshDb();
    createProfile(db, { slug: "alpha", label: "A", model: "m" });
    assert.throws(() => restoreProfile(db, "alpha"), /not archived/);
    db.close();
  });

  it("throws on unknown slug", () => {
    const db = freshDb();
    assert.throws(() => restoreProfile(db, "nope"), /not found/);
    db.close();
  });

  it("refuses to restore a reserved profile (defensive)", () => {
    const db = freshDb();
    // main can't be archived in normal operation; the defensive guard
    // catches the case where a stray write flipped archived_at on a
    // reserved row.
    assert.throws(() => restoreProfile(db, "main"), /reserved/);
    db.close();
  });

  it("preserves the api_server_port across archive+restore", () => {
    const db = freshDb();
    const before = createProfile(db, {
      slug: "alpha",
      label: "A",
      model: "m",
    });
    archiveProfile(db, "alpha");
    const restored = restoreProfile(db, "alpha");
    assert.equal(restored.api_server_port, before.api_server_port);
    db.close();
  });
});

describe("agentProfiles — setProfileStatus", () => {
  it("flips status without touching other fields", () => {
    const db = freshDb();
    const before = createProfile(db, {
      slug: "alpha",
      label: "A",
      model: "m",
    });
    const after = setProfileStatus(db, "alpha", "running");
    assert.equal(after.status, "running");
    assert.equal(after.label, before.label);
    assert.equal(after.api_server_port, before.api_server_port);
    db.close();
  });

  it("routes status='archived' through archiveProfile", () => {
    const db = freshDb();
    createProfile(db, { slug: "alpha", label: "A", model: "m" });
    const after = setProfileStatus(db, "alpha", "archived");
    assert.equal(after.status, "archived");
    assert.ok(after.archived_at != null);
    db.close();
  });
});

describe("agentProfiles — channel bindings", () => {
  it("resolves to the default profile when no exact match exists", () => {
    const db = freshDb();
    assert.equal(resolveProfileForChannel(db, "telegram", "12345"), "main");
    assert.equal(resolveProfileForChannel(db, "telegram", null), "main");
    db.close();
  });

  it("overrides the default with bindChannel(kind, NULL)", () => {
    const db = freshDb();
    createProfile(db, { slug: "cratchit", label: "C", model: "m" });
    bindChannel(db, {
      channel_kind: "telegram",
      channel_identity: null,
      profile_slug: "cratchit",
    });
    assert.equal(
      resolveProfileForChannel(db, "telegram", null),
      "cratchit",
      "default rebound",
    );
    assert.equal(
      resolveProfileForChannel(db, "telegram", "99999"),
      "cratchit",
      "default applies to unbound identities",
    );
    db.close();
  });

  it("exact (kind, id) binding beats default; other ids fall back to default", () => {
    const db = freshDb();
    createProfile(db, { slug: "alpha", label: "A", model: "m" });
    createProfile(db, { slug: "bravo", label: "B", model: "m" });
    // default 'telegram' → 'main' (seeded)
    // (telegram, '111') → 'alpha'
    bindChannel(db, {
      channel_kind: "telegram",
      channel_identity: "111",
      profile_slug: "alpha",
    });
    assert.equal(resolveProfileForChannel(db, "telegram", "111"), "alpha");
    assert.equal(resolveProfileForChannel(db, "telegram", "222"), "main");
    db.close();
  });

  it("rejects unknown channel_kind", () => {
    const db = freshDb();
    createProfile(db, { slug: "alpha", label: "A", model: "m" });
    assert.throws(
      () =>
        bindChannel(db, {
          channel_kind: "wibble",
          channel_identity: null,
          profile_slug: "alpha",
        }),
      /not a known channel/,
    );
    db.close();
  });

  it("rejects binding to an archived profile", () => {
    const db = freshDb();
    createProfile(db, { slug: "alpha", label: "A", model: "m" });
    archiveProfile(db, "alpha");
    assert.throws(
      () =>
        bindChannel(db, {
          channel_kind: "telegram",
          channel_identity: "111",
          profile_slug: "alpha",
        }),
      /archived/,
    );
    db.close();
  });

  it("UPSERTs on rebind — no duplicate rows", () => {
    const db = freshDb();
    createProfile(db, { slug: "alpha", label: "A", model: "m" });
    createProfile(db, { slug: "bravo", label: "B", model: "m" });
    const a1 = bindChannel(db, {
      channel_kind: "telegram",
      channel_identity: "111",
      profile_slug: "alpha",
    });
    const a2 = bindChannel(db, {
      channel_kind: "telegram",
      channel_identity: "111",
      profile_slug: "bravo",
    });
    assert.equal(a1.id, a2.id, "same row id");
    assert.equal(a2.profile_slug, "bravo");
    const rows = listAllBindings(db).filter(
      (b) => b.channel_kind === "telegram" && b.channel_identity === "111",
    );
    assert.equal(rows.length, 1, "no duplicate row");
    db.close();
  });

  it("UPSERTing a default binding reuses the binding-default-* id", () => {
    const db = freshDb();
    createProfile(db, { slug: "cratchit", label: "C", model: "m" });
    const b = bindChannel(db, {
      channel_kind: "telegram",
      channel_identity: null,
      profile_slug: "cratchit",
    });
    assert.equal(
      b.id,
      "binding-default-telegram",
      "default row id is reused on rebind",
    );
    db.close();
  });

  it("unbindChannel refuses binding-default-*", () => {
    const db = freshDb();
    assert.throws(
      () => unbindChannel(db, "binding-default-telegram"),
      /default and cannot be unbound/,
    );
    db.close();
  });

  it("unbindChannel removes a non-default binding; resolve falls back to default", () => {
    const db = freshDb();
    createProfile(db, { slug: "alpha", label: "A", model: "m" });
    const binding = bindChannel(db, {
      channel_kind: "telegram",
      channel_identity: "111",
      profile_slug: "alpha",
    });
    assert.equal(resolveProfileForChannel(db, "telegram", "111"), "alpha");
    unbindChannel(db, binding.id);
    assert.equal(
      resolveProfileForChannel(db, "telegram", "111"),
      "main",
      "falls back to (kind, NULL) default after unbind",
    );
    db.close();
  });

  it("listBindingsForProfile returns just that profile's bindings", () => {
    const db = freshDb();
    createProfile(db, { slug: "alpha", label: "A", model: "m" });
    bindChannel(db, {
      channel_kind: "telegram",
      channel_identity: "111",
      profile_slug: "alpha",
    });
    const main = listBindingsForProfile(db, "main");
    const alpha = listBindingsForProfile(db, "alpha");
    assert.equal(
      main.length,
      KNOWN_CHANNEL_KINDS.size,
      "main keeps all per-kind defaults",
    );
    assert.equal(alpha.length, 1);
    assert.equal(alpha[0].channel_kind, "telegram");
    assert.equal(alpha[0].channel_identity, "111");
    db.close();
  });
});

describe("agentProfiles — channel_tokens.profile_slug column", () => {
  it("is present after migration", () => {
    const db = freshDb();
    const colNames = (
      db.prepare("PRAGMA table_info(channel_tokens)").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    assert.ok(
      colNames.includes("profile_slug"),
      "channel_tokens.profile_slug column added by 0017",
    );
    db.close();
  });
});
