import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import { queryRecentJournal } from "../../db/alfredJournal.js";
import { OmiStore, digest } from "../../omi/store.js";
import { OmiClient } from "../../omi/client.js";
import { synchronize } from "../../omi/sync.js";
import {
  taskPort,
  validateTask,
  ctrlRequest,
  readCredential,
  saveCredential,
} from "../../omi/runtime.js";
import { fields, remoteFields } from "../../omi/model.js";
import { VAULT_PATH, readRecord, resolveVaultPath } from "./vault.js";

const prefix = "/api/v1/channels/omi/pilot";
const store = () => new OmiStore(getStateDb());
const text = (s: unknown, max = 1000) => {
  if (typeof s !== "string" || !s.trim() || s.length > max)
    throw new ValidationError("Required text missing or too long");
  return s.trim();
};
const enabled = () => process.env.OMI_PILOT_ENABLED === "true";
function active() {
  if (!enabled()) throw new ValidationError("Omi chat pilot is disabled");
  return store().requireConnection();
}
function idle() {
  if (
    (
      store()
        .db.prepare("SELECT lease_until FROM omi_connection WHERE id=1")
        .get() as any
    )?.lease_until > Date.now()
  )
    throw new ValidationError(
      "Synchronization in progress; retry the same request after it finishes",
    );
}
async function remote() {
  const c = active();
  return new OmiClient(await readCredential(c.credential_ref));
}
async function sync() {
  if (!enabled() || !store().connection()?.enabled) return { disabled: true };
  return synchronize(store(), await remote(), taskPort);
}
function status() {
  const c = store().connection();
  return {
    available: enabled(),
    connected: !!c?.enabled,
    writes_enabled: !!c?.writes_enabled,
    last_sync_at: c?.last_sync_at ?? null,
    error: c?.error ?? null,
    continuity: "best_effort",
    mcp_url: process.env.OMI_MCP_PUBLIC_URL ?? null,
    conflicts: c
      ? store()
          .maps(c.account_id)
          .filter((m) => m.conflict)
      : [],
  };
}
export function registerOmiPilotRoutes() {
  addRoute("GET", prefix + "/status", async ({ res }) =>
    sendJson(res, 200, status()),
  );
  addRoute("PUT", prefix + "/connection", async ({ res, body }) => {
    if (!enabled()) throw new ValidationError("Omi chat pilot is disabled");
    const b = body as any,
      key = text(b?.api_key, 10000),
      email = text(b?.expected_email).toLowerCase();
    const client = new OmiClient(key),
      profile = await client.profile();
    if (
      String(profile?.email || "")
        .trim()
        .toLowerCase() !== email
    )
      throw new ValidationError(
        "Omi account does not match the expected email",
      );
    // Verify required read capabilities without creating provider data.
    await client.request("/chat?limit=1");
    await client.request("/action-items?limit=1");
    const s = store(),
      account = digest(email),
      prior = s.connection();
    if (prior && prior.account_id !== account)
      throw new ValidationError(
        "Different Omi account: existing mappings must be reconciled first",
      );
    if (
      (
        s.db
          .prepare("SELECT lease_until FROM omi_connection WHERE id=1")
          .get() as any
      )?.lease_until > Date.now()
    )
      throw new ValidationError(
        "Synchronization in progress; reconnect after it finishes",
      );
    const principal = s.db
      .prepare("SELECT id FROM alfred_principal WHERE is_owner=1")
      .get() as any;
    if (!principal)
      throw new ValidationError("Complete owner onboarding first");
    const ref = await saveCredential(
      "Omi chat and tasks (" + account.slice(0, 12) + ")",
      key,
    );
    s.db
      .prepare(
        `INSERT INTO omi_connection(id,account_id,principal_id,credential_ref,enabled,writes_enabled,since)
      VALUES(1,?,?,?,1,0,?) ON CONFLICT(id) DO UPDATE SET credential_ref=excluded.credential_ref,enabled=1,writes_enabled=0,error=NULL`,
      )
      .run(account, principal.id, ref, new Date().toISOString());
    sendJson(res, 200, status());
  });
  addRoute("DELETE", prefix + "/connection", async ({ res }) => {
    store()
      .db.prepare(
        "UPDATE omi_connection SET enabled=0,writes_enabled=0 WHERE id=1",
      )
      .run();
    sendJson(res, 200, status());
  });
  addRoute("POST", prefix + "/sync", async ({ res }) =>
    sendJson(res, 200, await sync()),
  );
  addRoute("GET", prefix + "/reconcile", async ({ res }) => {
    const c = active();
    sendJson(res, 200, {
      local: await taskPort.list(),
      remote: await (await remote()).tasks(),
      mappings: store().maps(c.account_id),
    });
  });
  addRoute("PUT", prefix + "/tasks", async ({ res, body }) => {
    idle();
    const c = active(),
      b = body as any,
      remotes = await (await remote()).tasks();
    const remoteId = b?.remote_id ? text(b.remote_id) : null;
    const r = remoteId ? remotes.find((x) => x.id === remoteId) : null;
    if (remoteId && !r) throw new ValidationError("Remote task not found");
    // Initial reconciliation is an operator action, never exposed through Omi MCP.
    let localPath = b?.task_path ? text(b.task_path) : null;
    if (!localPath) {
      if (!r) throw new ValidationError("Choose a remote or local task");
      localPath =
        "task/omi-" + digest(c.account_id + ":" + r.id).slice(0, 32) + ".md";
      await taskPort.create(localPath, remoteFields(r));
    }
    const local = (await taskPort.list()).find((x) => x.path === localPath);
    if (!local) throw new ValidationError("Local task not found");
    if (
      r &&
      JSON.stringify(fields(local)) !== JSON.stringify(remoteFields(r))
    ) {
      if (b.resolve !== "local" && b.resolve !== "remote")
        throw new ValidationError(
          "Values differ: explicitly choose local or remote",
        );
      if (b.resolve === "remote")
        await taskPort.update(localPath, remoteFields(r));
      else await (await remote()).update(r.id, fields(local));
    }
    store().map(
      c.account_id,
      localPath,
      remoteId,
      r && b.resolve !== "local" ? remoteFields(r) : fields(local),
    );
    sendJson(res, 200, { mapped: true, path: localPath });
  });
  addRoute("PUT", prefix + "/writes", async ({ res, body }) => {
    const c = active();
    const b = body as any;
    if (typeof b?.enabled !== "boolean")
      throw new ValidationError("enabled boolean required");
    if (
      b.enabled &&
      (!c.last_sync_at ||
        store()
          .maps(c.account_id)
          .some((m) => m.conflict))
    )
      throw new ValidationError(
        "Run synchronization and resolve conflicts before enabling writes",
      );
    store()
      .db.prepare("UPDATE omi_connection SET writes_enabled=? WHERE id=1")
      .run(Number(b.enabled));
    sendJson(res, 200, status());
  });
  addRoute("POST", prefix + "/context", async ({ res, body }) => {
    const c = active(),
      query = text((body as any)?.message, 8000);
    let refresh_error: string | null = null;
    try {
      await sync();
    } catch {
      refresh_error = "Omi refresh failed; context may be stale";
    }
    active();
    const identity: Record<string, string> = {};
    for (const name of ["SOUL.md", "USER.md", "RULES.md"]) {
      try {
        identity[name] = fs
          .readFileSync(path.join(VAULT_PATH, name), "utf8")
          .slice(0, name === "SOUL.md" ? 6000 : 3000);
      } catch {}
    }
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((x) => x.length > 2);
    const tasks = await taskPort.list();
    const [matters, commitments] = await Promise.all([
      ctrlRequest("/api/v1/vault/list/matter"),
      ctrlRequest("/api/v1/vault/list/commitment"),
    ]);
    const relevant = (items: any[]) =>
      items
        .map((x) => ({
          x,
          score: tokens.filter((t) =>
            JSON.stringify(x).toLowerCase().includes(t),
          ).length,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 12)
        .map((y) => y.x);
    const commands = store()
      .db.prepare(
        "SELECT request_id,operation,state,result,created_at FROM omi_command WHERE account_id=? ORDER BY created_at DESC LIMIT 12",
      )
      .all(c.account_id);
    sendJson(res, 200, {
      identity,
      principal_id: c.principal_id,
      recent_exchanges: queryRecentJournal(
        store().db,
        { principal_id: c.principal_id },
        { limit: 30, within_hours: 48 },
      ),
      tasks: relevant(tasks),
      matters: relevant(matters.results || []),
      commitments: relevant(commitments.results || []),
      action_outcomes: commands,
      sync: status(),
      refresh_error,
      instructions:
        "Use the supplied identity and language preferences. These exchanges are your actual shared history. Distinguish an action request from its verified outcome. Call this context tool before each reply; the host does not guarantee that call. Never claim a task or action succeeded without its result.",
    });
  });
  addRoute("POST", prefix + "/read", async ({ res, body }) => {
    active();
    const b = body as any;
    if (b?.kind === "connections") {
      sendJson(res, 200, await ctrlRequest("/api/v1/integrations"));
      return;
    }
    if (b?.kind === "tasks") {
      sendJson(res, 200, { tasks: await taskPort.list() });
      return;
    }
    const p = text(b?.path);
    if (
      !/^(matter|commitment|task|note|decision|person|org)\/[A-Za-z0-9_./-]+\.md$/.test(
        p,
      ) ||
      p.split("/").some((x) => x === ".." || x === "." || !x)
    )
      throw new ValidationError(
        "Only canonical business record paths can be read through this surface",
      );
    resolveVaultPath(p);
    const r = readRecord(p);
    if (!r) throw new ValidationError("Record not found");
    sendJson(res, 200, {
      path: p,
      frontmatter: r.fm,
      body: r.body.slice(0, 20000),
    });
  });
  addRoute("POST", prefix + "/command", async ({ res, body }) => {
    idle();
    const c = active();
    if (!c.writes_enabled)
      throw new ValidationError("Task writes are not enabled");
    const b = body as any,
      id = text(b?.request_id, 160),
      op = text(b?.operation);
    if (!["create_task", "update_task", "request_work"].includes(op))
      throw new ValidationError("Unsupported operation");
    const task = validateTask(b.task);
    if (op === "request_work" && task.completed)
      throw new ValidationError("A new work request must remain pending review");
    let taskPath =
      op === "update_task"
        ? text(b?.task_path)
        : "task/omi-" + digest(c.account_id + ":" + id).slice(0, 32) + ".md";
    if (
      op === "update_task" &&
      !store()
        .maps(c.account_id)
        .some((m) => m.task_path === taskPath)
    )
      throw new ValidationError("Task is not mapped to this connection");
    const request = op === "request_work" ? text(b?.request, 8000) : undefined;
    const result = await store().command(
      c.account_id,
      id,
      op,
      { task, taskPath, request: request ?? null },
      async () => {
        if (op === "update_task") await taskPort.update(taskPath, task);
        else await taskPort.create(taskPath, task, request);
        if (op !== "update_task")
          store().map(c.account_id, taskPath, null, fields(task));
        return {
          path: taskPath,
          status: op === "request_work" ? "awaiting_review" : "saved",
          external_action_executed: false,
        };
      },
    );
    sendJson(res, 200, result);
  });
}
