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
import { DatabaseSync } from "node:sqlite";
import { clusterBursts } from "../../db/engagedTime.js";
import { loadRateCard } from "./suppressionRateCard.js";
import { dockerExec } from "../helpers.js";

// A ULID is 26 chars of Crockford base32 (uppercase, no I/L/O/U). Signals were
// demoted out of the vault's signal/ directory into the `state.db signal`
// table, so a needs_attention record's `source_signal_path` now usually holds
// a ULID, not a `signal/….md` path. dispatchSignalToAgent must resolve the
// right store.
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Human-authored Hermes session sources counted as principal attention in NAR.
// Authorship rationale per docs/design/nar-method.md §2:
//   slack    — messages arrive via the Slack channel integration; Sir typed them.
//   telegram — messages arrive via the Telegram bot; Sir typed them.
//   web      — the dashboard chat surface; Sir typed them in the browser.
//   cli      — EXCLUDED: cli sessions are agent-driven one-shots (context-compressed
//              task lists, vault reads, "gather…" instructions). Live data shows 177
//              such sessions in June 2026, nearly all with a single user turn. Because
//              clusterBursts applies a 2-minute floor per burst, isolated one-shot agent
//              calls each became their own burst — inflating engaged by hours per month
//              and pushing NAR down. Confirmed machine traffic; removed here.
// Adding a new source requires confirming it is human-authored, not machine traffic.
// MUST stay identical to HUMAN_SOURCES in packages/learn/src/activities/nar_data.py.
// The two are read by different halves of the same formula — learn decides which
// sessions become displacement, ctrl decides which turns become engaged. A source
// present in one and absent from the other credits work with no attention cost
// against it (or the reverse), and the divergence is invisible on the statement.
export const HUMAN_SESSION_SOURCES = ["slack", "telegram", "web"] as const;

// Precomputed IN-clause fragment — these are static string literals, safe to interpolate.
const HUMAN_SOURCES_SQL = HUMAN_SESSION_SOURCES.map((s) => `'${s}'`).join(",");

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
// We mint the decision in `state=open` with `side_effects.synchronous_flip:
// true` so DecisionRouterWorkflow picks it up and runs
// extract_observation_from_decision (which closes the learning loop into
// state.db `observation` + `instinct_ref`). The router's six
// `if not synchronous_flip` guards (decision_router.py:194,307,426,479,486,
// 563,586) cleanly skip the action paths — the legacy endpoint already
// performed the synchronous source-record flip via writeFrontmatterPatch above.
// Then the router flips state → completed itself. Minting as `completed`
// (the previous shape) bypassed the observation extractor entirely and was
// the proximate cause of "0 kind=decision observations" on the live tenant.
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
      state: "open",
      outcome_record: null,
      time_to_decision_ms: null,
      reversed_at: null,
      is_reversible: intent !== "delegate",
      completed_at: null,
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
      changes: { intent, state: "open", note: note || null },
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
  // Stamp the source signal as a TERMINAL re-routed record so the rest
  // of the delegate pipeline (decision_router → check_decision_outcomes,
  // observation extractor) can match outcomes back to the principal's
  // intent — WITHOUT re-arming it on SignalRouterWorkflow's pickup queue.
  //
  // History (#216, 2026-05-24): the prior contract restored
  // ``status=unrouted`` so SignalRouterWorkflow picked the signal up on
  // its next 2-min tick and dispatched the agent. In practice this
  // looped: Sir clicked Delegate ONCE, the signal got dispatched 10
  // times over 10 minutes (one per router tick), each fire minted a
  // fresh ``decision/<ts>.md`` and polluted the observation pool. The
  // route_signal_action #54 idempotency guard only catches re-entries
  // when the status is already ``dispatching|routed_agent|routed_human``
  // — re-armed ``unrouted`` slipped past it on every tick.
  //
  // Option A (Sir-prescribed): mark ``status=routed_agent`` directly so
  // SignalRouter's ``list_unrouted_signals`` query (status='unrouted')
  // never returns this row. The terminal status mirrors the post-
  // incident remediation Sir did by hand. Trade-off acknowledged: a
  // re-routed signal can no longer be retried by SignalRouter — that
  // affordance is severed in exchange for cutting the loop dead.
  //
  // ``decision_origin`` is still stamped into ``payload_json`` so an
  // agent outcome that arrives later (via a separate path) can be
  // matched back to the originating decision by source_signal_path
  // chain — the linkage the calibration loop in T6.7.5 reads.
  const sourceSignal = String(rec.frontmatter.source_signal_path ?? "");
  if (!sourceSignal) {
    return {
      outcome_signal_path: null,
      error: "no source_signal_path on needs_attention record",
    };
  }

  // F3: a `source_signal_path` that is a bare ULID is a `state.db signal` row
  // (signals were demoted out of the vault). Stamp it terminal there —
  // status=routed_agent + decision_origin into payload_json — instead of
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
      "UPDATE signal SET status = 'routed_agent', payload_json = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(JSON.stringify(payload), sourceSignal);
    return { outcome_signal_path: sourceSignal, error: null };
  }

  // Legacy path: a vault-relative `signal/….md` file. Patch its frontmatter
  // status=routed_agent (#216) so the router does NOT pick it up.
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
  let newFm = m[1].replace(/^status:.*$/m, "status: routed_agent");
  // Stamp the originating decision path onto the re-routed signal so
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

/** Subset of buildDayStatement return read by the trends aggregator. */
interface DayStatement {
  nar_hours: number;
  displaced: { total_hours: number; explicit: { hours: number; items: Array<{ count: number; minutes: number }> }; inferred: { hours: number; items: Array<{ bucket: string|null; minutes: number; outcome: string|null; engaged_minutes: number|null }> }; autonomous: { hours: number; items: Array<{ bucket: string|null; minutes: number }> } };
  engaged: { hours: number }; interruption: { hours: number };
  allocation: { work: {displaced_hours:number;engaged_hours:number}; life: {displaced_hours:number;engaged_hours:number}; unallocated: {displaced_hours:number;engaged_hours:number} };
  stats: { sessions: number };
}

/** Period key + canonical ISO start/end for a grain+date string. Exported for tests. */
export function periodKeyBounds(grain: "week"|"month"|"quarter", dateStr: string): {key:string;start:string;end:string} {
  if (grain === "week") {
    const d=new Date(`${dateStr}T00:00:00Z`), dow=d.getUTCDay()||7; // Mon=1…Sun=7
    const mon=new Date(d); mon.setUTCDate(d.getUTCDate()-dow+1);
    const sun=new Date(mon); sun.setUTCDate(mon.getUTCDate()+6);
    const thu=new Date(d); thu.setUTCDate(d.getUTCDate()-dow+4); // Thursday = ISO week anchor
    const wn=Math.ceil(((thu.getTime()-Date.UTC(thu.getUTCFullYear(),0,1))/86400000+1)/7);
    return {key:`${thu.getUTCFullYear()}-W${String(wn).padStart(2,"0")}`,start:mon.toISOString().slice(0,10),end:sun.toISOString().slice(0,10)};
  }
  const [y,mo]=dateStr.slice(0,7).split("-").map(Number);
  if (grain === "month") return {key:dateStr.slice(0,7),start:`${y}-${String(mo).padStart(2,"0")}-01`,end:new Date(Date.UTC(y,mo,0)).toISOString().slice(0,10)};
  const q=Math.ceil(mo/3), qm1=(q-1)*3+1;
  return {key:`${y}-Q${q}`,start:`${y}-${String(qm1).padStart(2,"0")}-01`,end:new Date(Date.UTC(y,q*3,0)).toISOString().slice(0,10)};
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
      // Gap 4 — mint the mirrored decision (intent=delegate). Additive on
      // UI clicks (no decision in flight yet), suppressed when called from
      // DecisionRouter (decision_origin set in the request body): the caller
      // is already processing a decision and minting a mirror would create
      // a 1/min loop where every router tick mints a fresh delegate decision
      // via this endpoint (#218 incident 2026-05-24).
      const decisionPath = decisionOrigin
        ? null
        : mintDecisionMirror(rec, "dispatched", note);
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

  // POST /api/v1/admin/needs-attention/bulk — bulk done|defer|noise over pending cards.
  // dry_run=true: preview, no writes. Apply: ONE audit row + ONE decision for the batch.
  // delegate excluded. Unknown/resolved ids skipped. The batch decision is NOT
  // reversible: the batch decision carries side_effects.source_records and
  // DecisionRouter re-opens every listed card on reverse (#559), skipping any
  // that have since been deleted rather than aborting the batch.
  addRoute("POST", "/api/v1/admin/needs-attention/bulk", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const intent = String(b.intent ?? "").trim().toLowerCase();
    const note = typeof b.note === "string" ? b.note.trim() : "";
    const dryRun = b.dry_run === true || String(b.dry_run) === "true";
    if (!["done", "defer", "noise"].includes(intent))
      throw new ValidationError("intent must be one of done | defer | noise (delegate excluded — fires agents)");
    if (!Array.isArray(b.ids) || !(b.ids as unknown[]).length)
      throw new ValidationError("ids must be a non-empty array");

    const toApply: NeedsAttentionRecord[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const rawId of b.ids as unknown[]) {
      const id = String(rawId ?? "").trim();
      const rec = readNeedsAttention(id);
      if (!rec) { skipped.push({ id, reason: "not_found" }); continue; }
      const st = String(rec.frontmatter.status ?? "pending");
      if (st !== "pending") { skipped.push({ id, reason: `already_resolved:${st}` }); continue; }
      toApply.push(rec);
    }
    if (dryRun) {
      return sendJson(res, 200, { dry_run: true, intent,
        would_apply: toApply.length, would_skip: skipped.length, skipped,
        noise_warning: intent !== "noise" ? null :
          `Marking ${toApply.length} card(s) noise trains suppression. This batch is ONE act — suppression still applies.`,
        reversal_note: "Reversible: POST /api/v1/decisions/:id/reverse re-opens every card in this batch. Cards deleted since the batch was applied are skipped and reported.",
        note: note || null });
    }
    if (!toApply.length)
      return sendJson(res, 200, { ok: true, applied: 0, skipped, decision_path: null, audit_id: null });

    const nowIso = new Date().toISOString();
    const naStatus = intent === "defer" ? "skipped" : intent; // defer→skipped on the card
    const appliedIds: string[] = [];
    for (const rec of toApply) {
      writeFrontmatterPatch(rec, { status: naStatus, resolved_at: nowIso, resolution_note: note || `bulk ${intent}` });
      appliedIds.push(rec.id);
    }

    // ONE decision record — hand-written YAML (avoids the attention↔decisions import cycle).
    const nowTs = nowIso.replace(/:/g, "-").replace(/\..*$/, "Z");
    const shortId = crypto.createHash("sha256").update(`bulk\x00${intent}\x00${nowIso}`).digest("hex").slice(0, 8);
    const decisionId = `${nowTs}-${shortId}`;
    const decisionDir = path.join(VAULT_PATH, "decision");
    if (!fs.existsSync(decisionDir)) fs.mkdirSync(decisionDir, { recursive: true });
    const sideEffects = { bulk: true, count: appliedIds.length, synchronous_flip: true,
      source_records: appliedIds.map((id) => `needs_attention/${id}.md`),
      actions: [`needs_attention.${naStatus}`],
      reversal_note: "reversible via POST /api/v1/decisions/:id/reverse (#559)" };
    const front = [
      `type: "decision"`, `created: ${JSON.stringify(nowIso)}`, `principal: "principal"`,
      `source: "needs_attention"`, `source_record: "needs_attention/bulk"`,
      `source_headline: ${JSON.stringify(`Bulk ${intent}: ${appliedIds.length} cards`)}`,
      `intent: ${JSON.stringify(intent)}`, `note: ${note ? JSON.stringify(note) : "null"}`,
      `matter_ref: null`, `task_ref: null`, `state: "open"`, `outcome_record: null`,
      `time_to_decision_ms: null`, `reversed_at: null`, `is_reversible: true`,
      `completed_at: null`, `decision_origin: "bulk_triage"`,
      yaml.dump({ side_effects: sideEffects }, { lineWidth: 200 }).trimEnd(),
    ].join("\n");
    const bodyTxt = [
      `# Decision: bulk ${intent} on needs_attention (${appliedIds.length} cards)`, "",
      `Principal bulk-${intent} on ${appliedIds.length} cards at ${nowIso}.`,
      ...(note ? [`Note: ${note}`] : []),
    ].join("\n");
    fs.writeFileSync(path.join(decisionDir, `${decisionId}.md`), `---\n${front}\n---\n\n${bodyTxt}\n`, "utf-8");
    indexVaultWrite(`decision/${decisionId}.md`);

    // ONE audit row for the entire batch — NOT one per card.
    const auditId = appendAudit({ ts: nowIso, action_type: "decision", actor: "principal",
      source: "needs_attention", target_path: `decision/${decisionId}.md`, target_kind: "decision",
      summary: `bulk ${intent}: ${appliedIds.length} cards`,
      changes: { intent, state: "open", count: appliedIds.length, note: note || null },
      payload: { decision_origin: "bulk_triage", bulk: true, ids: appliedIds, skipped } });

    sendJson(res, 200, { ok: true, applied: appliedIds.length, skipped,
      decision_path: `decision/${decisionId}.md`, audit_id: auditId });
  });

  // NAR statement/stats/recompute — rates from docs/design/nar-method.md.
  const HERMES_CONFIG_DIR = process.env.HERMES_CONFIG_DIR ?? "/hermes-state/profiles";
  const GAP_MS = 10 * 60 * 1000, FLOOR_MS = 2 * 60 * 1000;
  const BUCKET_MINUTES: Record<string, number> = { S: 5, M: 20, L: 60, XL: 120 };
  const INTERRUPTION_RATE_MINUTES = 2;

  function buildDayStatement(dateStr: string): object {
    const db = getStateDb();
    const rateCard = loadRateCard();
    const suppressionRate = rateCard.rate_minutes_per_item;

    // Day window: midnight UTC to midnight UTC.
    const dayStart = `${dateStr}T00:00:00Z`;
    const dayEnd   = `${dateStr}T23:59:59.999Z`;

    const entries = db.prepare(
      `SELECT action_class, summary, evidence_kind, evidence_ref,
              session_ref, baseline_minutes, estimation_method,
              acceptance, acceptance_path, displaced_minutes, notes
         FROM nar_entry
        WHERE occurred_at >= ? AND occurred_at <= ?
        ORDER BY occurred_at`,
    ).all(dayStart, dayEnd) as Array<{
      action_class: string; summary: string; evidence_kind: string; evidence_ref: string;
      session_ref: string | null; baseline_minutes: number | null; estimation_method: string | null;
      acceptance: string; acceptance_path: string | null; displaced_minutes: number | null;
      notes: string | null;
    }>;

    // Classify entries.
    const explicitBuckets = new Map<string, { count: number; rate_minutes: number; minutes: number }>();
    const inferredItems: object[] = [];
    const autonomousItems: object[] = [];
    const unratedCounts = new Map<string, number>();
    let selfCorrections = 0;
    // Allocation tracking (work / life / unallocated) — sums in minutes.
    const allocDisplacedMin: Record<"work"|"life"|"unallocated", number> = { work: 0, life: 0, unallocated: 0 };
    const allocEngagedMin:   Record<"work"|"life"|"unallocated", number> = { work: 0, life: 0, unallocated: 0 };

    for (const row of entries) {
      const notesData = row.notes ? (() => { try { return JSON.parse(row.notes!); } catch { return {}; } })() : {};
      if (notesData.outcome === "corrective") selfCorrections++;
      const mins = row.displaced_minutes ?? 0;

      // Every entry contributes displaced minutes to exactly one allocation bucket.
      const alloc: "work"|"life"|"unallocated" =
        (notesData.allocation === "work" || notesData.allocation === "life")
          ? (notesData.allocation as "work"|"life") : "unallocated";
      allocDisplacedMin[alloc] += mins;

      if (row.evidence_kind === "session" && row.acceptance_path === "inferred") {
        // Inferred — conversational bucket work.
        // engaged_minutes: only on conversational entries written by the recap (null otherwise).
        // nar_minutes: null when engaged is null — unknown engagement is not the same as zero.
        const engaged_minutes: number|null = notesData.engaged_minutes ?? null;
        const nar_minutes: number|null = engaged_minutes !== null ? mins - engaged_minutes : null;
        if (engaged_minutes !== null) allocEngagedMin[alloc] += engaged_minutes;
        inferredItems.push({
          label: row.summary, bucket: notesData.bucket ?? null, minutes: mins,
          turns: notesData.turns ?? null, tools: notesData.tools ?? null,
          evidence_kind: row.evidence_kind, evidence_ref: row.evidence_ref,
          outcome: notesData.outcome ?? null,
          engaged_minutes, nar_minutes,
        });
      } else if (
        row.evidence_kind === "chore_run" ||
        (row.acceptance_path === "explicit" && row.evidence_kind !== "decision" && row.evidence_kind !== "audit")
      ) {
        // Autonomous — unattended artifact production.
        // Chore runs carry no per-session engagement measurement (null deliberately).
        autonomousItems.push({
          label: row.summary, bucket: notesData.bucket ?? null, minutes: mins,
          evidence_kind: row.evidence_kind, evidence_ref: row.evidence_ref,
          engaged_minutes: null, nar_minutes: null,
        });
      } else {
        // Explicit or unrated — rate-card actions.
        // Suppression always uses the rate-card value. Other action classes
        // (e.g. desk_decision noise rows) carry their own displaced_minutes set
        // by the recap workflow; null displaced_minutes means no agreed rate →
        // unrated. The prior code hard-coded null for every non-suppression row,
        // which dropped the desk_decision explicit group entirely (#584).
        const rate = row.action_class === "suppression" ? suppressionRate : row.displaced_minutes;
        if (rate !== null) {
          const existing = explicitBuckets.get(row.action_class);
          if (existing) {
            existing.count++;
            existing.minutes += rate;
          } else {
            explicitBuckets.set(row.action_class, { count: 1, rate_minutes: rate, minutes: rate });
          }
        } else {
          unratedCounts.set(row.action_class, (unratedCounts.get(row.action_class) ?? 0) + 1);
        }
      }
    }

    // Human turns: Hermes main profile, allowlist sources only (not HA/audio).
    // messages.timestamp is epoch seconds REAL. Degrades gracefully if store missing.
    const hsDbPath = path.join(HERMES_CONFIG_DIR, "main", "state.db");
    const dayStartEp = new Date(dayStart).getTime() / 1000;
    const dayEndEp = new Date(dayEnd).getTime() / 1000;
    let hermesTs: number[] = [];
    if (fs.existsSync(hsDbPath)) {
      let hsDb: any;
      try {
        hsDb = new DatabaseSync(`file:${hsDbPath}?mode=ro`);
        hermesTs = (hsDb.prepare(
          `SELECT m.timestamp FROM messages m JOIN sessions s ON m.session_id=s.id
           WHERE m.role='user' AND s.source IN (${HUMAN_SOURCES_SQL})
             AND s.parent_session_id IS NULL
             AND m.timestamp>=? AND m.timestamp<=?`,
        ).all(dayStartEp, dayEndEp) as Array<{ timestamp: number }>).map(r => r.timestamp);
        hsDb.close();
      } catch { try { (hsDb as any)?.close(); } catch { /**/ } }
    }
    // Desk decisions by the principal (actor='principal' excludes machine-authored rows).
    const decisionAudit = db.prepare(
      `SELECT ts FROM audit WHERE action_type='decision' AND actor='principal'
        AND ts>=? AND ts<=?`,
    ).all(dayStart, dayEnd) as Array<{ ts: string }>;
    const burstDates = [
      ...hermesTs.map(t => new Date(t * 1000)),
      ...decisionAudit.map((r) => new Date(r.ts)),
    ];
    const { totalMs, burstCount } = clusterBursts(burstDates, GAP_MS, FLOOR_MS);
    const engagedHours = totalMs / (1000 * 60 * 60);

    // Interruption: unsolicited outbound.
    // Two sub-counts kept separate for disclosure in the response.
    //   from_flag:        solicited = 0  (authoritative — the writer said so)
    //   from_source_kind: solicited IS NULL AND source_kind IN ('cron','system')
    //                     (historical fallback — both are machine-initiated by
    //                      definition; safe to classify without guessing)
    // solicited = 1 is never counted. NULL with any other source_kind stays
    // unknown and is not counted.
    const flagRow = db.prepare(
      `SELECT COUNT(*) AS n FROM alfred_journal
         WHERE direction = 'outbound' AND solicited = 0 AND ts >= ? AND ts <= ?`,
    ).get(dayStart, dayEnd) as { n: number };
    const sourceKindRow = db.prepare(
      `SELECT COUNT(*) AS n FROM alfred_journal
         WHERE direction = 'outbound'
           AND solicited IS NULL
           AND source_kind IN ('cron', 'system')
           AND ts >= ? AND ts <= ?`,
    ).get(dayStart, dayEnd) as { n: number };
    const interruptionFromFlag       = flagRow.n;
    const interruptionFromSourceKind = sourceKindRow.n;
    const interruptionCount          = interruptionFromFlag + interruptionFromSourceKind;
    const interruptionHours          = (interruptionCount * INTERRUPTION_RATE_MINUTES) / 60;

    // Totals.
    const explicitItems = [...explicitBuckets.entries()].map(([action_class, v]) => ({
      label: action_class === "suppression" ? "Suppressed items" : action_class,
      count: v.count, rate_minutes: v.rate_minutes, minutes: v.minutes,
    }));
    const explicitHours  = explicitItems.reduce((s, i) => s + (i as any).minutes, 0) / 60;
    const inferredHours  = inferredItems.reduce((s, i) => s + ((i as any).minutes ?? 0), 0) / 60;
    const autonomousHours = autonomousItems.reduce((s, i) => s + ((i as any).minutes ?? 0), 0) / 60;
    const displacedHours = explicitHours + inferredHours + autonomousHours;
    const narHours       = displacedHours - engagedHours - interruptionHours;

    // Stats block — quality counters derived from the same day's data.
    // hard_failures: no dedicated field in nar_entry schema; always 0 until a
    // source signal is introduced. self_corrections: requires notes.outcome="corrective"
    // written by the recap workflow; zero when the field is absent.
    const statsSessions   = new Set(
      entries.map((e) => e.session_ref).filter((s): s is string => s !== null),
    ).size;
    const statsBlocked    = entries.filter((e) => e.acceptance === "rejected").length;
    const statsArtifacts  = autonomousItems.filter(
      (i) => ((i as any).minutes ?? 0) > suppressionRate,
    ).length;
    const statsDenom      = engagedHours + interruptionHours;
    const statsRatio      = statsDenom === 0 ? 0 : Math.round((displacedHours / statsDenom) * 1000) / 1000;

    // Allocation block — displaced / engaged / interruption per bucket.
    // interruption is unattributed (comes from alfred_journal with no allocation),
    // so the full day's interruption lands in unallocated; work and life carry zero.
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const allocBlock = {
      work: {
        displaced_hours:    r3(allocDisplacedMin.work / 60),
        engaged_hours:      r3(allocEngagedMin.work / 60),
        interruption_hours: 0,
        nar_hours:          r3((allocDisplacedMin.work - allocEngagedMin.work) / 60),
      },
      life: {
        displaced_hours:    r3(allocDisplacedMin.life / 60),
        engaged_hours:      r3(allocEngagedMin.life / 60),
        interruption_hours: 0,
        nar_hours:          r3((allocDisplacedMin.life - allocEngagedMin.life) / 60),
      },
      unallocated: {
        displaced_hours:    r3(allocDisplacedMin.unallocated / 60),
        engaged_hours:      r3(allocEngagedMin.unallocated / 60),
        interruption_hours: r3(interruptionHours),
        nar_hours:          r3((allocDisplacedMin.unallocated - allocEngagedMin.unallocated) / 60 - interruptionHours),
      },
    };
    // Reconciliation: per-session engaged (summed from notes) vs day-level burst clustering.
    // The two measures are correct measures of different scopes; do not force them to agree.
    const attributedEngagedHours = r3(
      (allocEngagedMin.work + allocEngagedMin.life + allocEngagedMin.unallocated) / 60,
    );
    const allocReconciliation = {
      attributed_engaged_hours: attributedEngagedHours,
      day_engaged_hours:        r3(engagedHours),
      difference_hours:         r3(engagedHours - attributedEngagedHours),
    };

    return {
      date: dateStr,
      nar_hours: Math.round(narHours * 1000) / 1000,
      displaced: {
        total_hours: Math.round(displacedHours * 1000) / 1000,
        explicit:   { hours: Math.round(explicitHours * 1000) / 1000,   items: explicitItems },
        inferred:   { hours: Math.round(inferredHours * 1000) / 1000,   items: inferredItems },
        autonomous: { hours: Math.round(autonomousHours * 1000) / 1000, items: autonomousItems },
      },
      engaged: {
        hours: Math.round(engagedHours * 1000) / 1000,
        events: burstDates.length, bursts: burstCount,
      },
      interruption: {
        hours: Math.round(interruptionHours * 1000) / 1000,
        count: interruptionCount,
        from_flag:        interruptionFromFlag,
        from_source_kind: interruptionFromSourceKind,
        rate_minutes: INTERRUPTION_RATE_MINUTES,
      },
      allocation: allocBlock,
      allocation_reconciliation: allocReconciliation,
      rates: {
        suppression_minutes_per_item: suppressionRate,
        bucket_minutes: BUCKET_MINUTES,
        interruption_minutes: INTERRUPTION_RATE_MINUTES,
      },
      unrated: [...unratedCounts.entries()].map(([action_class, count]) => ({ action_class, count })),
      stats: {
        sessions: statsSessions,
        turns: burstDates.length,
        self_corrections: selfCorrections,
        blocked: statsBlocked,
        hard_failures: 0,
        return_ratio: statsRatio,
        autonomous_artifacts: statsArtifacts,
      },
    };
  }

  addRoute("GET", "/api/v1/attention/statement", async ({ res, query }) => {
    const date  = query.get("date");
    const from  = query.get("from");
    const to    = query.get("to");

    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError("date must be YYYY-MM-DD");
      sendJson(res, 200, buildDayStatement(date));
      return;
    }
    if (!from || !to) throw new ValidationError("date= or from= and to= are required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new ValidationError("from and to must be YYYY-MM-DD");
    }

    // Enumerate the days in the range (inclusive).
    const days: string[] = [];
    for (let d = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
         d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }
    const dayStatements = days.map(buildDayStatement) as Array<{
      nar_hours: number; displaced: { total_hours: number }; engaged: { hours: number };
    }>;
    const totals = {
      nar_hours:       Math.round(dayStatements.reduce((s, d) => s + d.nar_hours, 0) * 1000) / 1000,
      displaced_hours: Math.round(dayStatements.reduce((s, d) => s + d.displaced.total_hours, 0) * 1000) / 1000,
      engaged_hours:   Math.round(dayStatements.reduce((s, d) => s + d.engaged.hours, 0) * 1000) / 1000,
    };
    sendJson(res, 200, { from, to, days: dayStatements, totals });
  });

  addRoute("GET", "/api/v1/attention/stats", async ({ res, query }) => {
    const from = query.get("from");
    const to   = query.get("to");
    if (!from || !to) throw new ValidationError("from= and to= are required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new ValidationError("from and to must be YYYY-MM-DD");
    }
    const days: string[] = [];
    for (let d = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
         d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }
    const dayStatements = days.map(buildDayStatement) as Array<{
      date: string; nar_hours: number;
      displaced: { total_hours: number }; engaged: { hours: number };
    }>;
    const series = dayStatements.map((d) => ({
      date: d.date, nar_hours: d.nar_hours,
      displaced_hours: d.displaced.total_hours, engaged_hours: d.engaged.hours,
    }));
    const totals = {
      nar_hours:       Math.round(series.reduce((s, d) => s + d.nar_hours, 0) * 1000) / 1000,
      displaced_hours: Math.round(series.reduce((s, d) => s + d.displaced_hours, 0) * 1000) / 1000,
      engaged_hours:   Math.round(series.reduce((s, d) => s + d.engaged_hours, 0) * 1000) / 1000,
    };
    sendJson(res, 200, { from, to, totals, series });
  });

  addRoute("POST", "/api/v1/attention/recompute", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const date = typeof b.date === "string" ? b.date : null;
    const from  = typeof b.from === "string" ? b.from : null;
    const to    = typeof b.to === "string" ? b.to : null;

    if (!date && (!from || !to)) {
      throw new ValidationError("body must contain date or from+to");
    }
    const input = date
      ? JSON.stringify({ date })
      : JSON.stringify({ from, to });

    // Fire-and-forget — 202 immediately; Temporal unavailable is not a client error.
    const wfId = `nar-recap-${date ?? `${from}--${to}`}-${Date.now()}`;
    let handle: string | null = wfId;
    try {
      const out = await dockerExec("temporal", [
        "temporal","workflow","start","--type","NarDayRecapWorkflow",
        "--task-queue","alfred-learn","--workflow-id",wfId,"--input",input,"--output","json",
      ]);
      try { const p = JSON.parse(out.trim()); handle = p?.workflowId ?? p?.workflow_id ?? wfId; } catch { /**/ }
    } catch { handle = null; }

    sendJson(res, 202, { ok: true, handle, date, from, to });
  });

  // GET /api/v1/attention/trends — weekly/monthly/quarterly NAR rollups (#584).
  // Reuses buildDayStatement per day; does NOT reimplement displacement/engaged logic.
  addRoute("GET", "/api/v1/attention/trends", async ({ res, query }) => {
    const grain=(query.get("grain")??"") as "week"|"month"|"quarter";
    const from=query.get("from")??"", to=query.get("to")??"";
    if (!["week","month","quarter"].includes(grain)) throw new ValidationError("grain must be week|month|quarter");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new ValidationError("from and to must be YYYY-MM-DD");
    const fromD=new Date(`${from}T00:00:00Z`), toD=new Date(`${to}T00:00:00Z`);
    if (isNaN(fromD.getTime())||isNaN(toD.getTime())||fromD>toD) throw new ValidationError("from must be ≤ to");
    const total=Math.round((toD.getTime()-fromD.getTime())/86400000)+1;
    if (total>400) throw new ValidationError(`range ${total} days exceeds 400-day cap`);

    const dates:string[]=[];
    for (let d=new Date(fromD);d<=toD;d.setUTCDate(d.getUTCDate()+1)) dates.push(d.toISOString().slice(0,10));
    const dayResults=dates.map(buildDayStatement) as DayStatement[];
    const r3=(v:number)=>Math.round(v*1000)/1000;
    type PG={key:string;start:string;end:string;indices:number[]};
    const pm=new Map<string,PG>();
    for (let i=0;i<dates.length;i++) {
      const {key,start,end}=periodKeyBounds(grain,dates[i]);
      if (!pm.has(key)) pm.set(key,{key,start,end,indices:[]});
      pm.get(key)!.indices.push(i);
    }

    const db=getStateDb();
    const cf=`${from}T00:00:00Z`, ct=`${to}T23:59:59.999Z`;
    const firstJ=(db.prepare(`SELECT MIN(DATE(ts)) AS d FROM alfred_journal WHERE direction='outbound' AND ts>=? AND ts<=?`).get(cf,ct) as {d:string|null}).d;
    const daysData=(db.prepare(`SELECT COUNT(DISTINCT DATE(occurred_at)) AS n FROM nar_entry WHERE occurred_at>=? AND occurred_at<=?`).get(cf,ct) as {n:number}).n;

    const periods=[];
    for (const pg of pm.values()) {
      const drs=pg.indices.map(i=>dayResults[i]);
      let nar=0,disp=0,eng=0,intr=0,sess=0;
      const al:Record<"work"|"life"|"unallocated",{d:number;e:number}>={work:{d:0,e:0},life:{d:0,e:0},unallocated:{d:0,e:0}};
      let cDisp=0,cEng=0,cCnt=0,aDisp=0,aCnt=0,eDisp=0,eCnt=0;
      const bkt:Record<string,{count:number;displaced_hours:number}>={};
      // Items with bucket=null/undefined/"none" land in unbucketed, not by_bucket.
      // "none" is a sentinel written by vigilance chore sweeps; it must not appear
      // as a size tier beside S/M/L/XL — it would skew any size comparison.
      let ubCnt=0,ubDisp=0;
      const oc={delivered:0,failed:0,unknown:0};
      for (const dr of drs) {
        nar+=dr.nar_hours; disp+=dr.displaced.total_hours;
        // engaged_hours per period = SUM of daily burst-clustered values.
        // Daily clustering is the defined measure; summing days is the only
        // aggregation consistent with it — re-clustering would merge sessions.
        eng+=dr.engaged.hours; intr+=dr.interruption.hours; sess+=dr.stats.sessions;
        for (const a of (["work","life","unallocated"] as const)) { al[a].d+=dr.allocation[a].displaced_hours; al[a].e+=dr.allocation[a].engaged_hours; }
        cDisp+=dr.displaced.inferred.hours; cCnt+=dr.displaced.inferred.items.length;
        for (const it of dr.displaced.inferred.items) {
          cEng+=(it.engaged_minutes??0)/60;
          if (it.bucket && it.bucket!=="none") { bkt[it.bucket]??={count:0,displaced_hours:0}; bkt[it.bucket].count++; bkt[it.bucket].displaced_hours+=it.minutes/60; }
          else { ubCnt++; ubDisp+=it.minutes/60; }
          const o=it.outcome??null;
          if (o==="delivered") oc.delivered++; else if (o==="failed") oc.failed++; else oc.unknown++;
        }
        aDisp+=dr.displaced.autonomous.hours; aCnt+=dr.displaced.autonomous.items.length;
        for (const it of dr.displaced.autonomous.items)
          if (it.bucket && it.bucket!=="none") { bkt[it.bucket]??={count:0,displaced_hours:0}; bkt[it.bucket].count++; bkt[it.bucket].displaced_hours+=it.minutes/60; }
          else { ubCnt++; ubDisp+=it.minutes/60; }
        eDisp+=dr.displaced.explicit.hours; eCnt+=dr.displaced.explicit.items.reduce((s,x)=>s+x.count,0);
      }
      // interruption_instrumented false = "nothing recorded" not "no interruptions occurred"
      const pS=`${dates[pg.indices[0]]}T00:00:00Z`, pE=`${dates[pg.indices[pg.indices.length-1]]}T23:59:59.999Z`;
      const jn=(db.prepare(`SELECT COUNT(*) AS n FROM alfred_journal WHERE direction='outbound' AND ts>=? AND ts<=?`).get(pS,pE) as {n:number}).n;
      periods.push({
        key:pg.key,start:pg.start,end:pg.end,days:pg.indices.length,
        nar_hours:r3(nar),displaced_hours:r3(disp),engaged_hours:r3(eng),interruption_hours:r3(intr),
        interruption_instrumented:jn>0,return_ratio:eng===0?null:r3(disp/eng),
        allocation:{work:{displaced_hours:r3(al.work.d),engaged_hours:r3(al.work.e)},life:{displaced_hours:r3(al.life.d),engaged_hours:r3(al.life.e)},unallocated:{displaced_hours:r3(al.unallocated.d),engaged_hours:r3(al.unallocated.e)}},
        by_class:{conversational:{displaced_hours:r3(cDisp),engaged_hours:r3(cEng),count:cCnt},autonomous:{displaced_hours:r3(aDisp),engaged_hours:0,count:aCnt},explicit:{displaced_hours:r3(eDisp),engaged_hours:0,count:eCnt}},
        by_bucket:Object.fromEntries(Object.entries(bkt).map(([k,v])=>[k,{count:v.count,displaced_hours:r3(v.displaced_hours)}])),
        unbucketed:{count:ubCnt,displaced_hours:r3(ubDisp)},
        outcomes:oc,sessions:sess,
      });
    }
    // Join the clerk-written interpretation for this exact window.
    // kind='attention_read', subject='attention_trend:{grain}:{from}:{to}'.
    // null = workflow has not run for this window yet (normal until first run).
    // {generated_at, observations:[]} = ran but found nothing to say (show, not null).
    const obsRow=(db.prepare(
      `SELECT payload_json FROM observation WHERE kind='attention_read' AND subject=? ORDER BY ts DESC LIMIT 1`
    ).get(`attention_trend:${grain}:${from}:${to}`) as {payload_json:string}|undefined);
    let read:{generated_at:string;observations:unknown[]}|null=null;
    if (obsRow?.payload_json) {
      try {
        const p=JSON.parse(obsRow.payload_json);
        read={generated_at:p.generated_at??null,observations:Array.isArray(p.observations)?p.observations:[]};
      } catch { /* malformed payload — treat as not generated */ }
    }
    sendJson(res,200,{grain,from,to,
      coverage:{interruption_instrumented_from:firstJ??null,days_total:dates.length,days_with_data:daysData},
      periods,read});
  });
}
