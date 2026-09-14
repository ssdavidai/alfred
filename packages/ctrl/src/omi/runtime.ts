import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  VAULT_PATH,
  readRecord,
  walkMd,
  resolveVaultPath,
} from "../api/routes/vault.js";
import type { TaskPort } from "./sync.js";
import type { LocalTask, TaskFields } from "./model.js";

export async function ctrlRequest(
  endpoint: string,
  method = "GET",
  body?: unknown,
): Promise<any> {
  const r = await fetch(
    `http://127.0.0.1:${process.env.AAS_PORT || 3100}${endpoint}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${process.env.AAS_API_KEY}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!r.ok)
    throw new Error(
      `Business command failed (${r.status}); inspect the task before retrying`,
    );
  return r.json();
}
export function readTasks(): LocalTask[] {
  const root = path.join(VAULT_PATH, "task");
  if (!fs.existsSync(root)) return [];
  return walkMd(root, VAULT_PATH, new Set()).flatMap((p) => {
    const rec = readRecord(p);
    if (!rec || rec.fm.status === "cancelled" || rec.fm.archived) return [];
    const due = Object.hasOwn(rec.fm, "due_at")
      ? rec.fm.due_at
      : (rec.fm.due_date ?? rec.fm.due);
    return [
      {
        path: p,
        title: String(rec.fm.title || rec.fm.name || rec.stem),
        due_at:
          due && Number.isFinite(Date.parse(String(due)))
            ? new Date(String(due)).toISOString()
            : null,
        completed:
          rec.fm.status === "done" ||
          (!rec.fm.status && rec.fm.state === "done"),
      },
    ];
  });
}
export function validateTask(t: unknown): TaskFields {
  const b = t as TaskFields;
  if (
    !b ||
    typeof b.title !== "string" ||
    !b.title.trim() ||
    b.title.length > 1000 ||
    typeof b.completed !== "boolean"
  )
    throw new Error("A title and completed boolean are required");
  if (
    b.due_at !== null &&
    (typeof b.due_at !== "string" || !Number.isFinite(Date.parse(b.due_at)))
  )
    throw new Error("due_at must be an ISO date or null");
  return {
    title: b.title.trim(),
    completed: b.completed,
    due_at: b.due_at ? new Date(b.due_at).toISOString() : null,
  };
}
export const taskPort: TaskPort = {
  async list() {
    return readTasks();
  },
  async create(taskPath, t, request) {
    if (!/^task\/omi-[a-f0-9]{32}\.md$/.test(taskPath))
      throw new Error("Invalid adapter task path");
    resolveVaultPath(taskPath);
    const existing = readTasks().find((x) => x.path === taskPath);
    if (existing) return existing;
    const fm = {
      type: "task",
      title: t.title,
      status: t.completed ? "done" : "todo",
      state: t.completed ? "done" : "pending",
      owner: "human",
      created_by: "human",
      requires_approval: true,
      due_at: t.due_at,
      created: new Date().toISOString(),
      source: "omi-chat",
      tags: ["omi", "management"],
      ...(request ? { omi_request: request } : {}),
    };
    await ctrlRequest("/api/v1/vault/records", "POST", {
      type: "task",
      name: taskPath,
      content: `---\n${yaml.dump(fm)}---\n\n${request || t.title}\n`,
    });
    return { path: taskPath, ...t };
  },
  async update(taskPath, t) {
    if (!/^task\/[A-Za-z0-9_./-]+\.md$/.test(taskPath))
      throw new Error("Invalid task path");
    resolveVaultPath(taskPath);
    const old = readTasks().find((x) => x.path === taskPath);
    if (!old) throw new Error("Task missing; manual reconciliation required");
    if (old.completed !== t.completed) {
      const now = new Date().toISOString();
      const rec = readRecord(taskPath);
      await ctrlRequest("/api/v1/state-changes", "POST", {
        target_path: taskPath,
        source: "omi.task_update",
        fields: { status: t.completed ? "done" : "todo" },
        expected_as_of: rec?.fm.as_of,
        observed_window: { start: now, end: now, other_refs: [taskPath] },
        mode: "live",
        confidence: 1,
        reason:
          "Management task completion changed through the linked Omi surface.",
      });
    }
    await ctrlRequest("/api/v1/vault/records/" + taskPath, "PATCH", {
      json_set: {
        title: t.title,
        due_at: t.due_at,
        state: t.completed ? "done" : "pending",
      },
    });
  },
};

const vaultUrl = process.env.VAULT_CLI_URL || "http://vault-cli:8087";
async function secretCall(
  endpoint: string,
  method = "GET",
  body?: unknown,
): Promise<any> {
  const r = await fetch(vaultUrl + endpoint, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error("Credential store unavailable");
  const env = (await r.json()) as any;
  if (env.success === false)
    throw new Error("Credential store rejected request");
  return env.data ?? env;
}
export async function saveCredential(
  name: string,
  key: string,
): Promise<string> {
  const found = await secretCall(
    "/list/object/items?search=" + encodeURIComponent(name),
  );
  const list = Array.isArray(found) ? found : found.data;
  if (!Array.isArray(list))
    throw new Error("Unexpected credential store response");
  const item = list.find((x: any) => x.name === name);
  if (item) {
    await secretCall("/object/item/" + encodeURIComponent(item.id), "PUT", {
      ...item,
      login: { ...item.login, password: key },
    });
    return item.id;
  }
  const created = await secretCall("/object/item", "POST", {
    type: 1,
    name,
    login: { username: null, password: key, uris: [] },
  });
  const id = created.id ?? created.data?.id;
  if (typeof id !== "string")
    throw new Error("Credential reference not returned");
  return id;
}
export async function readCredential(id: string): Promise<string> {
  const r = await secretCall("/object/item/" + encodeURIComponent(id));
  const key = (r.data ?? r).login?.password;
  if (typeof key !== "string" || !key)
    throw new Error("Omi credential missing");
  return key;
}
