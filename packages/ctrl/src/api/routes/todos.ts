// to_do records — the principal's personal "I'll do this myself" list.
//
// Spawned by the DecisionRouterWorkflow when the principal clicks "Do"
// on a desk card (intent=take_mine). Replaces the in-memory Backstage
// tray with a persistent, queryable record. Each to_do links back to
// the originating decision and the source card so the audit chain
// stays intact.
//
// Endpoints:
//
//   POST   /api/v1/todos              — create (used by the workflow)
//   GET    /api/v1/todos              — list (filter: state, since, limit)
//   GET    /api/v1/todos/:id          — single record
//   PATCH  /api/v1/todos/:id          — partial update (state, completed_at)
//
// Vault dir: to_do/
//
// Lifecycle:
//
//   open       → just spawned, principal hasn't acted on it yet
//   completed  → principal hit "Done" on Backstage
//   cancelled  → originating decision was reversed; this to_do is moot
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import yaml from "js-yaml";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { VAULT_PATH } from "./vault.js";

const TODOS_DIR = path.join(VAULT_PATH, "to_do");

type TodoState = "open" | "completed" | "cancelled";
const VALID_TODO_STATES: readonly TodoState[] = ["open", "completed", "cancelled"];

interface TodoRecord {
  id: string;
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

function readTodo(id: string): TodoRecord | null {
  const safe = id.replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!safe || safe !== id) return null;
  const fullPath = path.join(TODOS_DIR, `${safe}.md`);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(TODOS_DIR) + path.sep)) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf-8");
  } catch {
    return null;
  }
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) return null;
  let fm: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(match[1]) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return {
    id: safe,
    path: `to_do/${safe}.md`,
    frontmatter: fm,
    body: match[2] ?? "",
  };
}

function renderTodoRecord(fields: Record<string, unknown>, body: string): string {
  const order = [
    "type",
    "created",
    "headline",
    "decision_origin",
    "source_record",
    "matter_ref",
    "task_ref",
    "state",
    "completed_at",
    "cancelled_at",
  ];
  const lines: string[] = ["---"];
  for (const key of order) {
    if (!(key in fields)) continue;
    const v = fields[key];
    if (v === null || v === undefined) {
      lines.push(`${key}: null`);
    } else if (typeof v === "boolean") {
      lines.push(`${key}: ${v ? "true" : "false"}`);
    } else if (typeof v === "number") {
      lines.push(`${key}: ${v}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(String(v))}`);
    }
  }
  lines.push("---");
  lines.push("");
  if (body) lines.push(body);
  return lines.join("\n") + "\n";
}

export function registerTodoRoutes(): void {
  // ─────────────────────────────────────────────────────────────
  // POST /api/v1/todos
  // ─────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/todos", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const headline = typeof b.headline === "string" ? b.headline.trim() : "";
    if (!headline) throw new ValidationError("headline required");

    if (!fs.existsSync(TODOS_DIR)) {
      fs.mkdirSync(TODOS_DIR, { recursive: true });
    }

    const nowIso = new Date().toISOString();
    const ts = nowIso.replace(/:/g, "-").replace(/\..*$/, "Z");
    const shortId = crypto
      .createHash("sha256")
      .update(`${headline}\x00${nowIso}`)
      .digest("hex")
      .slice(0, 8);
    const id = `${ts}-${shortId}`;
    const fullPath = path.join(TODOS_DIR, `${id}.md`);

    const decisionOrigin =
      typeof b.decision_origin === "string" ? b.decision_origin.trim() : "";
    const sourceRecord =
      typeof b.source_record === "string" ? b.source_record.trim() : "";
    const matterRef =
      typeof b.matter_ref === "string" ? b.matter_ref.trim() : "";
    const taskRef = typeof b.task_ref === "string" ? b.task_ref.trim() : "";

    const fields: Record<string, unknown> = {
      type: "to_do",
      created: nowIso,
      headline,
      decision_origin: decisionOrigin || null,
      source_record: sourceRecord || null,
      matter_ref: matterRef || null,
      task_ref: taskRef || null,
      state: "open",
      completed_at: null,
      cancelled_at: null,
    };

    const bodyText = [
      `# To-do: ${headline}`,
      "",
      `Spawned at ${nowIso}.`,
      decisionOrigin ? `From decision: \`${decisionOrigin}\`` : "",
      sourceRecord ? `Source card: \`${sourceRecord}\`` : "",
      matterRef ? `Matter: \`${matterRef}\`` : "",
    ]
      .filter((s) => s !== "")
      .join("\n");

    fs.writeFileSync(fullPath, renderTodoRecord(fields, bodyText), "utf-8");
    sendJson(res, 201, {
      ok: true,
      id,
      path: `to_do/${id}.md`,
      frontmatter: fields,
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /api/v1/todos
  // ─────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/todos", async ({ res, req }) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const stateFilter = url.searchParams.get("state");
    const since = url.searchParams.get("since");
    const limit = Math.max(
      1,
      Math.min(500, parseInt(url.searchParams.get("limit") ?? "200", 10) || 200),
    );

    if (!fs.existsSync(TODOS_DIR)) {
      sendJson(res, 200, { todos: [], count: 0 });
      return;
    }
    const files = fs.readdirSync(TODOS_DIR).filter((f) => f.endsWith(".md"));
    const records: any[] = [];
    for (const f of files) {
      const id = f.replace(/\.md$/, "");
      const rec = readTodo(id);
      if (!rec) continue;
      const fm = rec.frontmatter;
      const state = String(fm.state ?? "open");
      if (stateFilter && state !== stateFilter) continue;
      const created = String(fm.created ?? "");
      if (since && created < since) continue;
      records.push({
        id: rec.id,
        path: rec.path,
        ...fm,
      });
    }
    records.sort((a, b) =>
      String(b.created ?? "").localeCompare(String(a.created ?? "")),
    );
    sendJson(res, 200, {
      todos: records.slice(0, limit),
      count: records.length,
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /api/v1/todos/:id
  // ─────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/todos/:id", async ({ res, params }) => {
    const rec = readTodo(params.id);
    if (!rec) throw new NotFoundError(`to_do/${params.id} not found`);
    sendJson(res, 200, {
      id: rec.id,
      path: rec.path,
      ...rec.frontmatter,
      body: rec.body,
    });
  });

  // ─────────────────────────────────────────────────────────────
  // PATCH /api/v1/todos/:id
  //
  // Used by the UI to mark a to_do completed and by the
  // DecisionRouterWorkflow to cancel a to_do whose originating
  // decision was reversed.
  // ─────────────────────────────────────────────────────────────
  addRoute("PATCH", "/api/v1/todos/:id", async ({ res, params, body }) => {
    const rec = readTodo(params.id);
    if (!rec) throw new NotFoundError(`to_do/${params.id} not found`);
    const updates = (body ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...rec.frontmatter };
    if ("state" in updates) {
      const s = String(updates.state ?? "").toLowerCase();
      if (!VALID_TODO_STATES.includes(s as TodoState)) {
        throw new ValidationError(
          `state must be one of ${VALID_TODO_STATES.join(" | ")}, got ${s}`,
        );
      }
      next.state = s;
      if (s === "completed" && !next.completed_at) {
        next.completed_at = new Date().toISOString();
      }
      if (s === "cancelled" && !next.cancelled_at) {
        next.cancelled_at = new Date().toISOString();
      }
    }
    const fullPath = path.join(TODOS_DIR, `${rec.id}.md`);
    fs.writeFileSync(fullPath, renderTodoRecord(next, rec.body), "utf-8");
    sendJson(res, 200, {
      ok: true,
      id: rec.id,
      path: rec.path,
      frontmatter: next,
    });
  });
}
