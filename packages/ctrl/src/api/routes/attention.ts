// Needs-attention surface for the SaaS dashboard.
//
//   GET    /api/v1/admin/needs-attention            → list pending records
//   POST   /api/v1/admin/needs-attention/:id/done   → Sir did it; mark done
//   POST   /api/v1/admin/needs-attention/:id/dispatch → re-route to agent
//   POST   /api/v1/admin/needs-attention/:id/skip   → record calibration negative
//
// Backed by vault/needs_attention/<ts>-<id>.md records that
// signal_actions.py:write_needs_attention_record produces. Each record's
// `:id` in URLs is the filename stem (no .md). The dashboard renders
// these as cards in the daily brief / inline list; Sir clicks a button
// per card to resolve it.
//
// Status transitions:
//   pending  ──/done──→ done           (Sir handled it manually)
//   pending  ──/skip──→ skipped        (negative calibration; Phase 6.7
//                                       feeds this into source-confidence)
//   pending  ──/dispatch──→ dispatched (re-route to openclaw main; status
//                                       gets stamped after dispatch_action_to_agent
//                                       returns; happens via a follow-up
//                                       Temporal workflow trigger that this
//                                       endpoint kicks off)
//
// All four transitions are PATCHes to the record's frontmatter +
// optionally an audit event under `event/needs_attention_action-*.md`
// so the calibration loop in T6.7.5 can read both the original signal
// AND the human resolution.
import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { VAULT_PATH } from "./vault.js";

const NEEDS_ATTENTION_DIR = path.join(VAULT_PATH, "needs_attention");
const EVENTS_DIR = path.join(VAULT_PATH, "event");

interface NeedsAttentionRecord {
  id: string;
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

function readNeedsAttention(id: string): NeedsAttentionRecord | null {
  const safe = id.replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!safe || safe !== id) return null;
  const fullPath = path.join(NEEDS_ATTENTION_DIR, `${safe}.md`);
  // Defence: ensure the resolved path is still under needs_attention.
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(NEEDS_ATTENTION_DIR) + path.sep)) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf-8");
  } catch {
    return null;
  }
  // Parse YAML frontmatter — minimal parser, same shape as steward's
  // audit records. We don't need full YAML; the records use only
  // top-level scalars and a few inline JSON values.
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) return null;
  const fmText = match[1];
  const body = match[2] ?? "";
  const fm: Record<string, unknown> = {};
  for (const line of fmText.split("\n")) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, k, v] = m;
    let value: unknown = v.trim();
    if (value === "null" || value === "") value = null;
    else if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
      value = Number(value);
    } else if (
      typeof value === "string" &&
      (value as string).startsWith('"') &&
      (value as string).endsWith('"')
    ) {
      value = (value as string).slice(1, -1);
    }
    fm[k] = value;
  }
  return {
    id: safe,
    path: `needs_attention/${safe}.md`,
    frontmatter: fm,
    body,
  };
}

function writeFrontmatterPatch(
  rec: NeedsAttentionRecord,
  updates: Record<string, string | null>,
): void {
  const fullPath = path.join(NEEDS_ATTENTION_DIR, `${rec.id}.md`);
  const raw = fs.readFileSync(fullPath, "utf-8");
  const m = /^---\n([\s\S]*?)\n---(\n[\s\S]*)?$/.exec(raw);
  if (!m) {
    throw new Error(`Cannot patch frontmatter on malformed record ${rec.id}`);
  }
  const fmText = m[1];
  const rest = m[2] ?? "";
  const lines = fmText.split("\n");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const km = /^([A-Za-z0-9_]+):/.exec(line);
    if (km && km[1] in updates) {
      const k = km[1];
      seen.add(k);
      const v = updates[k];
      if (v === null) {
        out.push(`${k}: null`);
      } else {
        // Quote if contains a colon, hash, or starts with special chars.
        const needsQuote = /[:#]|^\s/.test(v);
        out.push(needsQuote ? `${k}: "${v.replace(/"/g, '\\"')}"` : `${k}: ${v}`);
      }
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of Object.entries(updates)) {
    if (seen.has(k)) continue;
    if (v === null) {
      out.push(`${k}: null`);
    } else {
      const needsQuote = /[:#]|^\s/.test(v);
      out.push(needsQuote ? `${k}: "${v.replace(/"/g, '\\"')}"` : `${k}: ${v}`);
    }
  }
  const next = `---\n${out.join("\n")}\n---${rest}`;
  fs.writeFileSync(fullPath, next, "utf-8");
}

function emitResolutionEvent(
  rec: NeedsAttentionRecord,
  action: "done" | "dispatched" | "skipped",
  note: string,
): string {
  // Emit event/needs_attention_action-<ts>-<id>.md so the calibration
  // loop in T6.7.5 can read both the original signal and the human
  // resolution. Same shape as steward audit records — frontmatter +
  // human-readable body.
  if (!fs.existsSync(EVENTS_DIR)) {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
  }
  const ts = new Date().toISOString().replace(/:/g, "-").replace(/\..*$/, "Z");
  const auditId = `needs_attention_action-${ts}-${rec.id}`;
  const auditPath = path.join(EVENTS_DIR, `${auditId}.md`);
  const sourceSignal = String(rec.frontmatter.source_signal_path ?? "");
  const reason = String(rec.frontmatter.decision_reason ?? "");
  const yaml = [
    "---",
    'type: "needs_attention_action"',
    `created: "${new Date().toISOString()}"`,
    `action: ${action}`,
    `target: "${rec.path}"`,
    `source_signal_path: "${sourceSignal}"`,
    `original_decision_reason: "${reason}"`,
    `note: ${note ? `"${note.replace(/"/g, '\\"')}"` : "null"}`,
    "---",
    "",
    `# Needs-attention resolved: ${rec.id}`,
    "",
    `Sir resolved \`${rec.path}\` via dashboard \`${action}\` button on ${new Date().toISOString()}.`,
    "",
    note ? `Note: ${note}` : "",
    "",
    sourceSignal
      ? `Original signal: \`${sourceSignal}\`. Calibration loop in T6.7.5 reads this audit + the source signal's source_type to feed back into per-source-type confidence weighting.`
      : "",
  ]
    .filter((s) => s !== "")
    .join("\n");
  fs.writeFileSync(auditPath, yaml + "\n", "utf-8");
  return `event/${auditId}.md`;
}

async function dispatchSignalToAgent(
  rec: NeedsAttentionRecord,
): Promise<{ outcome_signal_path: string | null; error: string | null }> {
  // Re-route this needs_attention item back through the action router
  // by triggering the al-signal-router schedule (which reads
  // status=unrouted). We restore the source signal record's status to
  // "unrouted" so the next router tick picks it up. The action will
  // then go through route_signal_action's HIGH path if the
  // STEWARD_SIGNAL_ACTION_LIVE_MODE env allows it.
  //
  // This endpoint does NOT directly call the openclaw subagent — that
  // happens inside the activity, which is workflow-managed (Temporal).
  // Bypassing the workflow would lose the audit trail + retry semantics.
  const sourceSignal = String(rec.frontmatter.source_signal_path ?? "");
  if (!sourceSignal) {
    return {
      outcome_signal_path: null,
      error: "no source_signal_path on needs_attention record",
    };
  }
  // Patch source signal: status=unrouted so router picks it up.
  const sigPath = path.join(VAULT_PATH, sourceSignal);
  const sigResolved = path.resolve(sigPath);
  if (!sigResolved.startsWith(path.resolve(VAULT_PATH) + path.sep)) {
    return { outcome_signal_path: null, error: "source signal path escapes vault" };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(sigResolved, "utf-8");
  } catch {
    return { outcome_signal_path: null, error: "source signal not readable" };
  }
  const m = /^---\n([\s\S]*?)\n---(\n[\s\S]*)?$/.exec(raw);
  if (!m) {
    return { outcome_signal_path: null, error: "source signal malformed" };
  }
  const newFm = m[1].replace(/^status:.*$/m, "status: unrouted");
  const newRaw = `---\n${newFm}\n---${m[2] ?? ""}`;
  fs.writeFileSync(sigResolved, newRaw, "utf-8");
  return { outcome_signal_path: sourceSignal, error: null };
}

export function registerAttentionRoutes(): void {
  // GET /api/v1/admin/needs-attention — list pending records (status=pending)
  // Optional query: ?include=all (return done/dispatched/skipped too — for the
  // history view) and ?limit=N.
  addRoute("GET", "/api/v1/admin/needs-attention", async ({ res, req }) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const includeAll = url.searchParams.get("include") === "all";
    const limit = Math.max(
      1,
      Math.min(500, parseInt(url.searchParams.get("limit") ?? "100", 10) || 100),
    );

    if (!fs.existsSync(NEEDS_ATTENTION_DIR)) {
      sendJson(res, 200, { records: [], count: 0 });
      return;
    }
    const files = fs
      .readdirSync(NEEDS_ATTENTION_DIR)
      .filter((f) => f.endsWith(".md"));
    const records: any[] = [];
    for (const f of files) {
      const id = f.replace(/\.md$/, "");
      const rec = readNeedsAttention(id);
      if (!rec) continue;
      const status = String(rec.frontmatter.status ?? "pending");
      if (!includeAll && status !== "pending") continue;
      records.push({
        id: rec.id,
        path: rec.path,
        status,
        created: rec.frontmatter.created,
        action_what: rec.frontmatter.action_what,
        suggested_actor: rec.frontmatter.suggested_actor,
        target_path: rec.frontmatter.target_path,
        target_kind: rec.frontmatter.target_kind,
        confidence: rec.frontmatter.confidence,
        decision_reason: rec.frontmatter.decision_reason,
        raw_quote: rec.frontmatter.raw_quote,
        body_preview: rec.body.slice(0, 500),
      });
    }
    // Newest pending first; for /include=all show by created desc as well.
    records.sort((a, b) => String(b.created ?? "").localeCompare(String(a.created ?? "")));
    sendJson(res, 200, {
      records: records.slice(0, limit),
      count: records.length,
    });
  });

  // POST /api/v1/admin/needs-attention/:id/done — Sir handled it
  addRoute(
    "POST",
    "/api/v1/admin/needs-attention/:id/done",
    async ({ res, params, body }) => {
      const id = params.id;
      const rec = readNeedsAttention(id);
      if (!rec) throw new NotFoundError(`needs_attention/${id} not found`);
      const note = (body as any)?.note ? String((body as any).note) : "";
      writeFrontmatterPatch(rec, {
        status: "done",
        resolved_at: new Date().toISOString(),
        resolution_note: note || null,
      });
      const auditPath = emitResolutionEvent(rec, "done", note);
      sendJson(res, 200, {
        ok: true,
        id,
        status: "done",
        audit_record_path: auditPath,
      });
    },
  );

  // POST /api/v1/admin/needs-attention/:id/dispatch — re-route to openclaw main
  addRoute(
    "POST",
    "/api/v1/admin/needs-attention/:id/dispatch",
    async ({ res, params, body }) => {
      const id = params.id;
      const rec = readNeedsAttention(id);
      if (!rec) throw new NotFoundError(`needs_attention/${id} not found`);
      const dispatchResult = await dispatchSignalToAgent(rec);
      if (dispatchResult.error) {
        throw new ValidationError(
          `dispatch failed: ${dispatchResult.error}`,
        );
      }
      const note = (body as any)?.note ? String((body as any).note) : "";
      writeFrontmatterPatch(rec, {
        status: "dispatched",
        resolved_at: new Date().toISOString(),
        resolution_note: note || null,
      });
      const auditPath = emitResolutionEvent(rec, "dispatched", note);
      sendJson(res, 200, {
        ok: true,
        id,
        status: "dispatched",
        re_routed_signal: dispatchResult.outcome_signal_path,
        audit_record_path: auditPath,
      });
    },
  );

  // POST /api/v1/admin/needs-attention/:id/skip — Sir doesn't want to do it
  addRoute(
    "POST",
    "/api/v1/admin/needs-attention/:id/skip",
    async ({ res, params, body }) => {
      const id = params.id;
      const rec = readNeedsAttention(id);
      if (!rec) throw new NotFoundError(`needs_attention/${id} not found`);
      const note = (body as any)?.note ? String((body as any).note) : "";
      writeFrontmatterPatch(rec, {
        status: "skipped",
        resolved_at: new Date().toISOString(),
        resolution_note: note || null,
      });
      const auditPath = emitResolutionEvent(rec, "skipped", note);
      sendJson(res, 200, {
        ok: true,
        id,
        status: "skipped",
        audit_record_path: auditPath,
      });
    },
  );
}
