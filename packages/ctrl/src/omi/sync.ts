import {
  fields,
  mergeTask,
  remoteFields,
  type LocalTask,
  type TaskFields,
} from "./model.js";
import { OmiStore } from "./store.js";
import type { OmiRemote } from "./client.js";

export interface TaskPort {
  list(): Promise<LocalTask[]>;
  create(path: string, task: TaskFields, request?: string): Promise<LocalTask>;
  update(path: string, task: TaskFields): Promise<void>;
}
export async function synchronize(
  store: OmiStore,
  remote: OmiRemote,
  tasks: TaskPort,
) {
  const c = store.requireConnection();
  const lock = store.db
    .prepare(
      "UPDATE omi_connection SET lease_until=? WHERE id=1 AND lease_until<?",
    )
    .run(Date.now() + 300000, Date.now());
  if (!lock.changes) return { busy: true };
  let messages = 0,
    updated = 0;
  try {
    const rows = await remote.messages(
      c.last_sync_at
        ? new Date(
            Math.max(
              Date.parse(c.since),
              Date.parse(c.last_sync_at) - 86400000,
            ),
          ).toISOString()
        : c.since,
    );
    for (const m of rows.sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
    ))
      messages += Number(store.importMessage(c, m));
    const remotes = await remote.tasks();
    const locals = await tasks.list();
    // Only explicitly mapped management tasks are writable. Discovery never imports blindly.
    if (c.writes_enabled)
      for (const map of store.maps(c.account_id)) {
        store.db
          .prepare("UPDATE omi_connection SET lease_until=? WHERE id=1")
          .run(Date.now() + 300000);
        if (!store.requireConnection().writes_enabled) break;
        if (map.conflict) continue;
        const local = locals.find((t) => t.path === map.task_path);
        if (!local) {
          store.map(
            c.account_id,
            map.task_path,
            map.remote_id,
            map.baseline ? JSON.parse(map.baseline) : null,
            "local_missing",
          );
          continue;
        }
        if (!map.remote_id) {
          const normalized = (s: string) =>
            s.trim().replace(/\s+/g, " ").toLowerCase();
          if (
            remotes.some(
              (r) => normalized(r.description) === normalized(local.title),
            )
          ) {
            store.map(
              c.account_id,
              local.path,
              null,
              fields(local),
              "possible_duplicate",
            );
            continue;
          }
          // Mark before sending: a process crash cannot cause another POST on restart.
          store.map(
            c.account_id,
            local.path,
            null,
            fields(local),
            "create_pending",
          );
          try {
            const created = await remote.create(fields(local));
            if (
              JSON.stringify(remoteFields(created)) !==
              JSON.stringify(fields(local))
            )
              throw new Error(
                "Omi returned different task values; reconcile the returned task before retrying",
              );
            store.map(c.account_id, local.path, created.id, fields(local));
            updated++;
          } catch (e) {
            store.map(
              c.account_id,
              local.path,
              null,
              fields(local),
              "create_uncertain",
            );
            throw e;
          }
          continue;
        }
        const r = remotes.find((t) => t.id === map.remote_id);
        if (!r) {
          store.map(
            c.account_id,
            local.path,
            map.remote_id,
            map.baseline ? JSON.parse(map.baseline) : null,
            "remote_missing",
          );
          continue;
        }
        const rf = remoteFields(r),
          lf = fields(local);
        if (!map.baseline) {
          store.map(
            c.account_id,
            local.path,
            map.remote_id,
            null,
            "baseline_missing",
          );
          continue;
        }
        const { merged, conflicts } = mergeTask(
          JSON.parse(map.baseline),
          lf,
          rf,
        );
        if (conflicts.length) {
          store.map(
            c.account_id,
            local.path,
            map.remote_id,
            JSON.parse(map.baseline),
            JSON.stringify(conflicts),
          );
          continue;
        }
        if (merged.due_at === null && rf.due_at !== null) {
          store.map(
            c.account_id,
            local.path,
            map.remote_id,
            JSON.parse(map.baseline),
            "clear_due_in_omi",
          );
          continue;
        }
        // Deterministic PATCHes can be replayed; baseline advances only after both sides succeed.
        if (JSON.stringify(lf) !== JSON.stringify(merged))
          await tasks.update(local.path, merged);
        if (JSON.stringify(rf) !== JSON.stringify(merged))
          await remote.update(r.id, merged);
        store.map(c.account_id, local.path, r.id, merged);
        updated++;
      }
    store.db
      .prepare("UPDATE omi_connection SET last_sync_at=?,error=NULL WHERE id=1")
      .run(new Date().toISOString());
    return {
      messages,
      updated,
      unmapped: remotes.filter(
        (r) => !store.maps(c.account_id).some((m) => m.remote_id === r.id),
      ).length,
    };
  } catch (e) {
    store.db
      .prepare("UPDATE omi_connection SET error=? WHERE id=1")
      .run(e instanceof Error ? e.message : "Synchronization failed");
    throw e;
  } finally {
    store.db
      .prepare("UPDATE omi_connection SET lease_until=0 WHERE id=1")
      .run();
  }
}
