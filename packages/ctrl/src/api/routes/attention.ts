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
import crypto from "node:crypto";
import yaml from "js-yaml";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { VAULT_PATH } from "./vault.js";
import { attentionCache, invalidateVaultCachesForType } from "../vaultCache.js";
import { appendAudit } from "./state.js";
import { getStateDb } from "../../db/state.js";
import { indexVaultWrite } from "../../db/vaultIndex.js";

// A ULID is 26 chars of Crockford base32 (uppercase, no I/L/O/U). Signals were
// demoted out of the vault's signal/ directory into the `state.db signal`
// table, so a needs_attention record's `source_signal_path` now usually holds
// a ULID, not a `signal/….md` path. dispatchSignalToAgent must resolve the
// right store.
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const NEEDS_ATTENTION_DIR = path.join(VAULT_PATH, "needs_attention");
const EVENTS_DIR = path.join(VAULT_PATH, "event");

interface NeedsAttentionRecord {
  id: string;
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export function readNeedsAttention(id: string): NeedsAttentionRecord | null {
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
  // Parse YAML frontmatter with js-yaml. The Python writer emits multi-line
  // block scalars (long `action_what` / `reasoning` paragraphs wrap with an
  // indented continuation) and single-quoted values (`created`, `raw_quote`).
  // The previous line-by-line regex parser truncated the first and left the
  // literal quote characters on the second — both fields are user-visible.
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) return null;
  const fmText = match[1];
  const body = match[2] ?? "";
  let fm: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(fmText) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed YAML — keep fm empty rather than 500ing the whole list.
  }
  return {
    id: safe,
    path: `needs_attention/${safe}.md`,
    frontmatter: fm,
    body,
  };
}

export function writeFrontmatterPatch(
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
  // Bust the needs_attention-specific read caches; do not touch the
  // signal/matter/event caches that the Desk reads from every poll.
  invalidateVaultCachesForType("needs_attention");
}

export function emitResolutionEvent(
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

  // Mirror the resolution into state.db `audit` (PLAN.md Part I — the
  // needs_attention_action type is demoted to the audit ledger). The vault
  // `event/*.md` record above stays for the calibration loop's current
  // reader; Phase 2 moves that reader onto state.db too.
  appendAudit({
    action_type: "needs_attention_action",
    actor: "principal",
    target_path: rec.path,
    target_kind: "needs_attention",
    subject_ref: sourceSignal || null,
    summary: `needs_attention ${action}: ${rec.id}`,
    changes: { action, note: note || null },
    payload: {
      original_decision_reason: reason,
      source_signal_path: sourceSignal,
      event_record: `event/${auditId}.md`,
    },
  });

  return `event/${auditId}.md`;
}

// Gap 4 — the legacy needs-attention POST endpoints mirror the principal's
// click into a `decision/<ts>-<short>.md` so DecisionRouterWorkflow picks it
// up and downstream learning (observation extraction, matter timeline) fires
// for clicks that didn't go through POST /api/v1/decisions. This is *additive*
// — the legacy frontmatter patch + needs_attention_action audit must continue.
// If the mirror write throws (e.g. vault disk full) we log + swallow; the
// existing audit row is the contract this endpoint must honour.
//
// We mint the decision in `state=completed` because the legacy endpoints
// already performed the synchronous source-record flip (writeFrontmatterPatch
// above) — the workflow has nothing more to do beyond observation extraction,
// for which a completed decision is fine.
type LegacyAction = "done" | "dispatched" | "skipped";

function legacyActionToIntent(action: LegacyAction): string {
  // Maps the three legacy action names onto the canonical decision-intent
  // vocab (see VALID_INTENTS in decisions.ts: delegate|defer|done|take_mine|noise).
  //   done      → done       (Sir handled it manually)
  //   dispatched→ delegate   (re-route to an agent)
  //   skipped   → defer      (the existing POST /api/v1/decisions handler maps
  //                           intent=defer → NA status=skipped, so we round-trip
  //                           the same semantic the other direction)
  if (action === "done") return "done";
  if (action === "dispatched") return "delegate";
  return "defer";
}

export function mintDecisionMirror(
  rec: NeedsAttentionRecord,
  action: LegacyAction,
  note: string,
): string | null {
  try {
    const decisionsDir = path.join(VAULT_PATH, "decision");
    if (!fs.existsSync(decisionsDir)) {
      fs.mkdirSync(decisionsDir, { recursive: true });
    }
    const nowIso = new Date().toISOString();
    const ts = nowIso.replace(/:/g, "-").replace(/\..*$/, "Z");
    const sourceRecord = rec.path; // e.g. "needs_attention/<id>.md"
    const shortId = crypto
      .createHash("sha256")
      .update(`${sourceRecord}\x00${nowIso}`)
      .digest("hex")
      .slice(0, 8);
    const id = `${ts}-${shortId}`;
    const fullPath = path.join(decisionsDir, `${id}.md`);
    const intent = legacyActionToIntent(action);

    // Mirror the field ordering the canonical POST /api/v1/decisions writer
    // uses (see renderDecisionRecord in decisions.ts) so downstream readers
    // don't need a code path for "legacy-minted decisions".
    const sourceHeadline =
      typeof rec.frontmatter.display_headline === "string"
        ? rec.frontmatter.display_headline
        : typeof rec.frontmatter.action_what === "string"
          ? rec.frontmatter.action_what
          : null;
    const matterRef =
      rec.frontmatter.target_kind === "matter" &&
      typeof rec.frontmatter.target_path === "string"
        ? rec.frontmatter.target_path
        : typeof rec.frontmatter.matter_ref === "string"
          ? rec.frontmatter.matter_ref
          : null;
    const taskRef =
      rec.frontmatter.target_kind === "task" &&
      typeof rec.frontmatter.target_path === "string"
        ? rec.frontmatter.target_path
        : typeof rec.frontmatter.task_ref === "string"
          ? rec.frontmatter.task_ref
          : null;

    const fields: Record<string, unknown> = {
      type: "decision",
      created: nowIso,
      principal: "principal",
      source: "needs_attention",
      source_record: sourceRecord,
      source_headline: sourceHeadline,
      intent,
      note: note || null,
      matter_ref: matterRef,
      task_ref: taskRef,
      state: "completed",
      outcome_record: null,
      time_to_decision_ms: null,
      reversed_at: null,
      is_reversible: intent !== "delegate",
      completed_at: nowIso,
      side_effects: {
        synchronous_flip: true,
        actions: [`needs_attention.${action}`],
        minted_by: "attention_legacy_endpoint",
      },
    };

    // Hand-written YAML, same shape as renderDecisionRecord in decisions.ts
    // (kept inline here to avoid an attention.ts ↔ decisions.ts import cycle —
    // decisions.ts already imports readNeedsAttention/etc from this file).
    const lines: string[] = ["---"];
    const scalarOrder = [
      "type", "created", "principal", "source", "source_record",
      "source_headline", "intent", "note", "matter_ref", "task_ref",
      "state", "outcome_record", "time_to_decision_ms",
      "reversed_at", "is_reversible", "completed_at",
    ];
    const written = new Set<string>();
    for (const k of scalarOrder) {
      if (!(k in fields)) continue;
      written.add(k);
      const v = fields[k];
      if (v === null || v === undefined) lines.push(`${k}: null`);
      else if (typeof v === "boolean") lines.push(`${k}: ${v ? "true" : "false"}`);
      else if (typeof v === "number") lines.push(`${k}: ${v}`);
      else lines.push(`${k}: ${JSON.stringify(String(v))}`);
    }
    for (const [k, v] of Object.entries(fields)) {
      if (written.has(k)) continue;
      const dumped = yaml.dump({ [k]: v }, { lineWidth: 200 }).trimEnd();
      lines.push(dumped);
    }
    lines.push("---");
    lines.push("");
    lines.push(`# Decision: ${intent} on needs_attention (legacy endpoint)`);
    lines.push("");
    lines.push(
      `Principal clicked **${action}** on \`${sourceRecord}\` via the legacy ` +
        `needs-attention endpoint at ${nowIso}.`,
    );
    if (note) {
      lines.push("");
      lines.push(`Note: ${note}`);
    }
    fs.writeFileSync(fullPath, lines.join("\n") + "\n", "utf-8");

    // Index into state.db vault_index — every reader of decisions queries
    // vault_index WHERE record_type='decision', so without this hook the
    // mirror would be invisible to /api/v1/decisions + the Desk ledger.
    indexVaultWrite(`decision/${id}.md`);

    // Mirror the decision into state.db audit (parallel to what POST
    // /api/v1/decisions does for principal-initiated decisions). The
    // existing needs_attention_action audit row stays — it's the legacy
    // calibration loop's reader.
    appendAudit({
      ts: nowIso,
      action_type: "decision",
      actor: "principal",
      source: "needs_attention",
      target_path: `decision/${id}.md`,
      target_kind: "decision",
      subject_ref: sourceRecord,
      summary: `decision: ${intent} on needs_attention (legacy)`,
      changes: { intent, state: "completed", note: note || null },
      payload: { ...fields },
    });

    return `decision/${id}.md`;
  } catch (err) {
    console.warn(
      `[attention] mintDecisionMirror failed for ${rec.id} (${action}); ` +
        `legacy audit row still emitted: ${(err as Error).message}`,
    );
    return null;
  }
}

export async function dispatchSignalToAgent(
  rec: NeedsAttentionRecord,
  decisionOrigin?: string,
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

  // F3: a `source_signal_path` that is a bare ULID is a `state.db signal` row
  // (signals were demoted out of the vault). Re-arm it there — flip
  // status=unrouted and stamp decision_origin into payload_json — instead of
  // doing fs.readFileSync(path.join(VAULT_PATH, ulid)) which always ENOENT'd
  // → 400 (the headline Delegate-fails bug).
  if (ULID_RE.test(sourceSignal)) {
    const db = getStateDb();
    const row = db
      .prepare("SELECT id, payload_json FROM signal WHERE id = ?")
      .get(sourceSignal) as { id: string; payload_json: string | null } | undefined;
    if (!row) {
      return {
        outcome_signal_path: null,
        error: `state.db signal ${sourceSignal} not found (advisory card has no real signal to delegate)`,
      };
    }
    let payload: Record<string, unknown> = {};
    if (row.payload_json) {
      try {
        const parsed = JSON.parse(row.payload_json);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        /* keep payload empty on malformed json */
      }
    }
    if (decisionOrigin) payload.decision_origin = decisionOrigin;
    db.prepare(
      "UPDATE signal SET status = 'unrouted', payload_json = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(JSON.stringify(payload), sourceSignal);
    return { outcome_signal_path: sourceSignal, error: null };
  }

  // Legacy path: a vault-relative `signal/….md` file. Patch its frontmatter
  // status=unrouted so the router picks it up.
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
  let newFm = m[1].replace(/^status:.*$/m, "status: unrouted");
  // Stamp the originating decision path onto the re-armed signal so
  // outcomes the agent writes later can be matched back to the
  // principal's intent. Idempotent: replace if present, append if not.
  if (decisionOrigin) {
    const safeOrigin = JSON.stringify(decisionOrigin);
    if (/^decision_origin:/m.test(newFm)) {
      newFm = newFm.replace(/^decision_origin:.*$/m, `decision_origin: ${safeOrigin}`);
    } else {
      newFm = `${newFm}\ndecision_origin: ${safeOrigin}`;
    }
  }
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

    const cacheKey = `${includeAll ? "all" : "pending"}:${limit}`;
    const payload = await attentionCache.get(cacheKey, () => {
      if (!fs.existsSync(NEEDS_ATTENTION_DIR)) {
        return { records: [], count: 0 };
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
        // origin_at = when the underlying event happened (email
        // arrival, calendar event time). The Desk shows this as
        // "arrived" so the principal sees the source's date, not
        // Alfred's processing time.
        origin_at: rec.frontmatter.origin_at ?? null,
        action_what: rec.frontmatter.action_what,
        suggested_actor: rec.frontmatter.suggested_actor,
        target_path: rec.frontmatter.target_path,
        target_kind: rec.frontmatter.target_kind,
        // C-B5 provenance — already on the NA frontmatter (signal_actions.py
        // stamps them) but dropped at this layer until now. The Desk card and
        // Decisions page bind to these names to show "from <signal> · Matter
        // <m> / Task <t>". All nullable: advisory/open-ended cards carry no
        // source signal, matched instinct, or matter/task target.
        source_signal_path: rec.frontmatter.source_signal_path ?? null,
        matched_instinct: rec.frontmatter.matched_instinct ?? null,
        matter_ref: rec.frontmatter.matter_ref ?? null,
        task_ref: rec.frontmatter.task_ref ?? null,
        confidence: rec.frontmatter.confidence,
        decision_reason: rec.frontmatter.decision_reason,
        // The model-written paragraph explaining *why* the steward
        // flagged this and what action is implied. This is the field
        // the desk card should show as its "why" — the raw_quote is
        // just the upstream source text and is too noisy for the UI.
        reasoning: rec.frontmatter.reasoning,
        // Voiced surface fields — Alfred's in-character headline +
        // body. Populated when the signal-extraction LLM produces
        // them; older cards are null and the UI falls back to
        // action_what + reasoning.
        display_headline: rec.frontmatter.display_headline ?? null,
        display_body: rec.frontmatter.display_body ?? null,
        raw_quote: rec.frontmatter.raw_quote,
        // Decay band stamped by DecayWatcherWorkflow — fresh/aging/stale.
        // The Desk groups the queue under these bands so the principal
        // sees aging cards under the fold without losing them entirely.
        decay_band: rec.frontmatter.decay_band ?? null,
        decay_score: rec.frontmatter.decay_score ?? null,
        body_preview: rec.body.slice(0, 500),
      });
    }
      // Newest pending first; for /include=all show by created desc as well.
      records.sort((a, b) => String(b.created ?? "").localeCompare(String(a.created ?? "")));
      return {
        records: records.slice(0, limit),
        count: records.length,
      };
    });
    sendJson(res, 200, payload);
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
      // Gap 4 — also mint a decision/<ts>.md so DecisionRouterWorkflow
      // picks the click up. Additive; failure here does NOT fail the
      // request (the audit row is the existing contract).
      const decisionPath = mintDecisionMirror(rec, "done", note);
      sendJson(res, 200, {
        ok: true,
        id,
        status: "done",
        audit_record_path: auditPath,
        decision_record_path: decisionPath,
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
      // Optional `decision_origin` (path to the originating decision
      // record) gets stamped onto the re-armed signal so the outcome
      // can be matched back to the human's intent by the
      // DecisionRouterWorkflow.
      const decisionOrigin =
        (body as any)?.decision_origin
          ? String((body as any).decision_origin)
          : undefined;
      const dispatchResult = await dispatchSignalToAgent(rec, decisionOrigin);
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
      // Gap 4 — mint the mirrored decision (intent=delegate). Additive.
      const decisionPath = mintDecisionMirror(rec, "dispatched", note);
      sendJson(res, 200, {
        ok: true,
        id,
        status: "dispatched",
        re_routed_signal: dispatchResult.outcome_signal_path,
        audit_record_path: auditPath,
        decision_record_path: decisionPath,
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
      // Gap 4 — mint the mirrored decision (intent=defer). Additive.
      const decisionPath = mintDecisionMirror(rec, "skipped", note);
      sendJson(res, 200, {
        ok: true,
        id,
        status: "skipped",
        audit_record_path: auditPath,
        decision_record_path: decisionPath,
      });
    },
  );

  // POST /api/v1/admin/desk-action — generic desk-card action audit.
  // Every click on the Desk's Delegate / Defer / Delete / Do buttons must
  // produce a permanent audit record, regardless of source type. The
  // per-source endpoints above still mutate the underlying record's
  // status — this endpoint is *additive* and writes a unified audit
  // event capturing the user's intent (incl. the optional note) so the
  // ledger never loses an action.
  //
  // For "Do" — which doesn't have a per-source endpoint — this is the
  // only call. The user is moving the item to their personal Backstage
  // tray; the underlying source record stays in its current status.
  addRoute("POST", "/api/v1/admin/desk-action", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const source = String(b.source ?? "").trim().toLowerCase();
    const sourceId = String(b.source_id ?? "").trim();
    const action = String(b.action ?? "").trim().toLowerCase();
    const note = b.note ? String(b.note) : "";
    if (!["needs_attention", "approval", "judgment", "pattern_proposal"].includes(source)) {
      throw new ValidationError(
        `source must be one of needs_attention | approval | judgment | pattern_proposal, got ${source}`,
      );
    }
    if (!["delegate", "defer", "delete", "do", "noise"].includes(action)) {
      throw new ValidationError(
        `action must be one of delegate | defer | delete | do | noise, got ${action}`,
      );
    }
    if (!sourceId) throw new ValidationError("source_id required");

    if (!fs.existsSync(EVENTS_DIR)) {
      fs.mkdirSync(EVENTS_DIR, { recursive: true });
    }
    const nowIso = new Date().toISOString();
    const ts = nowIso.replace(/:/g, "-").replace(/\..*$/, "Z");
    // Short hash of source+id so audit filenames stay unique even if the
    // same user clicks the same button twice in a second.
    const shortId = ts.slice(-6) + "-" + sourceId.slice(0, 8).replace(/[^a-zA-Z0-9]/g, "x");
    const auditId = `desk-action-${ts}-${shortId}`;
    const auditPath = path.join(EVENTS_DIR, `${auditId}.md`);
    const escNote = note.replace(/"/g, '\\"').replace(/\n/g, " ");
    const safeSourceId = sourceId.replace(/"/g, '\\"');
    const yaml = [
      "---",
      'type: "desk_action"',
      `created: "${nowIso}"`,
      `source: "${source}"`,
      `source_id: "${safeSourceId}"`,
      `action: "${action}"`,
      `note: ${note ? `"${escNote}"` : "null"}`,
      "---",
      "",
      `# Desk action: ${action} on ${source}/${sourceId}`,
      "",
      `Sir clicked **${action}** on a \`${source}\` card via the Today desk at ${nowIso}.`,
      "",
      note ? `Note: ${note}` : "",
    ]
      .filter((s) => s !== "")
      .join("\n");
    fs.writeFileSync(auditPath, yaml + "\n", "utf-8");

    // Mirror the desk action into state.db `audit` (PLAN.md Part I — the
    // desk-action type is demoted to the audit ledger).
    appendAudit({
      ts: nowIso,
      action_type: "desk_action",
      actor: "principal",
      source,
      subject_ref: sourceId,
      summary: `desk action ${action} on ${source}/${sourceId}`,
      changes: { action, note: note || null },
      payload: { event_record: `event/${auditId}.md` },
    });

    sendJson(res, 200, {
      ok: true,
      source,
      source_id: sourceId,
      action,
      audit_record_path: `event/${auditId}.md`,
    });
  });
}
