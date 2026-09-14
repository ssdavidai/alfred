import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTask } from "../src/omi/model.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { OmiStore } from "../src/omi/store.js";
import { synchronize, type TaskPort } from "../src/omi/sync.js";
import type { LocalTask, RemoteTask } from "../src/omi/model.js";
import type { OmiRemote } from "../src/omi/client.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const f of [
    "0002_alfred_journal.sql",
    "0019_journal_solicited.sql",
    "0022_omi_pilot.sql",
  ])
    db.exec(
      fs.readFileSync(
        new URL("../src/db/migrations/" + f, import.meta.url),
        "utf8",
      ),
    );
  db.prepare(
    "INSERT OR IGNORE INTO alfred_principal(id,display_name,is_owner) VALUES('owner','Test owner',1)",
  ).run();
  db.prepare(
    "INSERT INTO omi_connection(id,account_id,principal_id,credential_ref,enabled,writes_enabled,since) VALUES(1,'account-a','owner','secret-ref',1,1,'2026-01-01T00:00:00Z')",
  ).run();
  const store = new OmiStore(db);
  const locals: LocalTask[] = [{ path: "task/test.md", ...base }];
  const remotes: RemoteTask[] = [];
  let creates = 0;
  const remote: OmiRemote = {
    messages: async () => [],
    tasks: async () => remotes,
    create: async (t) => {
      creates++;
      const r = {
        id: "remote-" + creates,
        description: t.title,
        due_at: t.due_at,
        completed: t.completed,
      };
      remotes.push(r);
      return r;
    },
    update: async (id, t) => {
      Object.assign(remotes.find((x) => x.id === id)!, {
        description: t.title,
        due_at: t.due_at,
        completed: t.completed,
      });
    },
  };
  const port: TaskPort = {
    list: async () => locals,
    create: async (path, t) => {
      const l = { path, ...t };
      locals.push(l);
      return l;
    },
    update: async (path, t) => {
      Object.assign(locals.find((x) => x.path === path)!, t);
    },
  };
  return { db, store, locals, remotes, remote, port, creates: () => creates };
}
const base = { title: "Call supplier", due_at: null, completed: false };
test("merges edits to independent task fields", () => {
  assert.deepEqual(
    mergeTask(
      base,
      { ...base, title: "Call supplier tomorrow" },
      { ...base, completed: true },
    ),
    {
      merged: { ...base, title: "Call supplier tomorrow", completed: true },
      conflicts: [],
    },
  );
});
test("simultaneous title edits become a conflict, not silent data loss", () => {
  assert.deepEqual(
    mergeTask(base, { ...base, title: "Local" }, { ...base, title: "Remote" })
      .conflicts,
    ["title"],
  );
});
test("vertical slice: canonical task mirrors once and Omi completion returns", async () => {
  const f = fixture();
  f.store.map("account-a", "task/test.md", null, base);
  await synchronize(f.store, f.remote, f.port);
  await synchronize(f.store, f.remote, f.port);
  assert.equal(f.creates(), 1);
  assert.equal(f.remotes.length, 1);
  f.remotes[0].completed = true;
  await synchronize(f.store, f.remote, f.port);
  assert.equal(f.locals[0].completed, true);
  f.db.close();
});
test("actual human and assistant messages deduplicate and retain provider time", () => {
  const f = fixture(),
    c = f.store.requireConnection();
  for (const sender of ["human", "ai"]) {
    const m = {
      id: sender,
      text: sender === "human" ? "Hello" : "Hello back",
      sender,
      created_at: "2026-09-01T12:34:00Z",
    };
    assert.equal(f.store.importMessage(c, m), true);
    assert.equal(f.store.importMessage(c, m), false);
  }
  const rows = f.db
    .prepare(
      "SELECT direction,ts,principal_id FROM alfred_journal ORDER BY direction",
    )
    .all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ts, "2026-09-01T12:34:00.000Z");
  assert.equal(rows[1].principal_id, "owner");
  f.db.close();
});
test("lost create response cannot produce a duplicate on the next tick", async () => {
  const f = fixture();
  f.store.map("account-a", "task/test.md", null, base);
  const original = f.remote.create;
  f.remote.create = async (t) => {
    await original(t);
    throw new Error("response lost");
  };
  await assert.rejects(synchronize(f.store, f.remote, f.port));
  await synchronize(f.store, f.remote, f.port);
  assert.equal(f.creates(), 1);
  assert.equal(f.store.maps("account-a")[0].conflict, "create_uncertain");
  f.db.close();
});
test("unmapped and missing provider tasks never delete or import canonical tasks", async () => {
  const f = fixture();
  f.store.map("account-a", "task/test.md", "gone", base);
  f.remotes.push({
    id: "unmapped",
    description: "Unreviewed",
    completed: false,
  });
  await synchronize(f.store, f.remote, f.port);
  assert.equal(f.locals.length, 1);
  assert.equal(f.locals[0].completed, false);
  assert.equal(f.store.maps("account-a")[0].conflict, "remote_missing");
  f.db.close();
});
test("command receipts prevent replays and payload substitution, including after uncertainty", async () => {
  const f = fixture();
  let writes = 0;
  const run = () =>
    f.store.command(
      "account-a",
      "request_123",
      "create",
      { title: "A" },
      async () => ({ count: ++writes }),
    );
  assert.deepEqual(await run(), await run());
  assert.equal(writes, 1);
  await assert.rejects(
    f.store.command(
      "account-a",
      "request_123",
      "create",
      { title: "B" },
      async () => ({}),
    ),
    /different input/,
  );
  await assert.rejects(
    f.store.command("account-a", "request_456", "send", {}, async () => {
      writes++;
      throw new Error("lost");
    }),
  );
  await assert.rejects(
    f.store.command("account-a", "request_456", "send", {}, async () => {
      writes++;
      return {};
    }),
    /uncertain/,
  );
  assert.equal(writes, 2);
  f.db.close();
});
test("disconnect blocks cached clients and writes-off still imports history", async () => {
  const f = fixture();
  f.store.map("account-a", "task/test.md", null, base);
  f.db.exec("UPDATE omi_connection SET writes_enabled=0");
  await synchronize(f.store, f.remote, f.port);
  assert.equal(f.creates(), 0);
  f.db.exec("UPDATE omi_connection SET enabled=0");
  await assert.rejects(synchronize(f.store, f.remote, f.port), /disconnected/);
  f.db.close();
});
test("a matching title is a review candidate, never an automatic identity match", async () => {
  const f = fixture();
  f.store.map("account-a", "task/test.md", null, base);
  f.remotes.push({ id: "existing", description: base.title, completed: false });
  await synchronize(f.store, f.remote, f.port);
  assert.equal(f.creates(), 0);
  assert.equal(f.store.maps("account-a")[0].remote_id, null);
  assert.equal(f.store.maps("account-a")[0].conflict, "possible_duplicate");
  f.db.close();
});
test("unsupported date clearing is visible instead of falsely advancing baseline", async () => {
  const f = fixture();
  const dated = { ...base, due_at: "2026-10-01T00:00:00.000Z" };
  f.store.map("account-a", "task/test.md", "dated", dated);
  f.remotes.push({
    id: "dated",
    description: base.title,
    completed: false,
    due_at: dated.due_at,
  });
  await synchronize(f.store, f.remote, f.port);
  assert.equal(f.store.maps("account-a")[0].conflict, "clear_due_in_omi");
  f.db.close();
});
