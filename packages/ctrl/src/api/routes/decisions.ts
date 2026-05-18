// Decisions — first-class record of every human action on the Desk.
//
// Every click on Delegate / Defer / Delete / Do becomes a
// `decision/<ts>-<short>.md` vault record. The DecisionRouterWorkflow
// (alfred-learn) reads new decisions (state=open) and fans out the
// downstream side effects: source-record status flips, signal re-arms,
// agent dispatches, matter timeline appends, task closures, to_do
// spawns. Lifecycle:
//
//   open      → just written by the UI, side-effects not yet run
//   executing → router fired the side-effects; awaiting an external
//               outcome (agent completion) for terminal flip
//   completed → terminal state — either no async work was needed, or
//               the outcome arrived and was stamped
//   reversed  → principal undid this decision; router has already (or
//               will) run inverse side-effects
//
// Endpoints:
//
//   POST   /api/v1/decisions             — create a new decision
//   GET    /api/v1/decisions             — list (filter: state, source, since, limit)
//   GET    /api/v1/decisions/:id         — single record
//   PATCH  /api/v1/decisions/:id         — partial update (state, outcome_record, etc.)
//   POST   /api/v1/decisions/:id/reverse — flip to state=reversed
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import yaml from "js-yaml";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { VAULT_PATH } from "./vault.js";
import {
  readNeedsAttention,
  writeFrontmatterPatch,
  emitResolutionEvent,
} from "./attention.js";
import { syncVaultIndexFromContent } from "../vault_index_sync.js";

const DECISIONS_DIR = path.join(VAULT_PATH, "decision");

type DecisionIntent = "delegate" | "defer" | "done" | "take_mine" | "noise";
type DecisionSource =
  | "needs_attention"
  | "approval"
  | "judgment"
  | "to_do"
  | "desk_originated"
  | "pattern_proposal"
  // OBS-6: emitted by signal_router when an instinct fires
  // autonomously (chosen_path=agent, decision_reason=high_confidence_match).
  // The companion decision lets OBS-1 fold autonomous fires into the
  // observation pool with subject=principal_via_alfred so the
  // intuition engine keeps learning from Alfred's own moves.
  | "instinct_fire";
type DecisionState =
  | "open"
  | "scheduled"
  | "executing"
  | "completed"
  | "reversed";

const VALID_INTENTS: readonly DecisionIntent[] = [
  "delegate", "defer", "done", "take_mine", "noise",
];
const VALID_SOURCES: readonly DecisionSource[] = [
  "needs_attention",
  "approval",
  "judgment",
  "to_do",
  "desk_originated",
  "pattern_proposal",
  "instinct_fire",
];

// OBS-6: who acted. "principal" = Sir clicked from /desk; "alfred" =
// signal_router fired an instinct autonomously. OBS-1's decision→
// observation pipeline reads this to stamp subject=principal vs
// subject=principal_via_alfred.
type DecisionPrincipal = "principal" | "alfred";
const VALID_PRINCIPALS: readonly DecisionPrincipal[] = ["principal", "alfred"];
const VALID_STATES: readonly DecisionState[] = [
  "open", "scheduled", "executing", "completed", "reversed",
];

interface DecisionRecord {
  id: string;
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Read a decision record by id. Defends against path traversal — id
 *  must be alphanumeric / dash / dot / underscore only and the resolved
 *  path must live inside DECISIONS_DIR. */
function readDecision(id: string): DecisionRecord | null {
  const safe = id.replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!safe || safe !== id) return null;
  const fullPath = path.join(DECISIONS_DIR, `${safe}.md`);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(DECISIONS_DIR) + path.sep)) {
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
    // Malformed YAML — return null so the list endpoint can skip it.
    return null;
  }
  return {
    id: safe,
    path: `decision/${safe}.md`,
    frontmatter: fm,
    body: match[2] ?? "",
  };
}

/** Hand-write the YAML so field order is stable and js-yaml's quote
 *  style decisions don't surprise downstream readers. */
function renderDecisionRecord(fields: Record<string, unknown>, body: string): string {
  const scalarOrder = [
    "type",
    "created",
    "principal",
    "source",
    "source_record",
    "source_headline",
    "intent",
    "note",
    "matter_ref",
    "task_ref",
    "state",
    "outcome_record",
    "time_to_decision_ms",
    "reversed_at",
    "is_reversible",
    "completed_at",
    "executing_at",
    "execute_at",
    "scheduled_at",
    "scheduled_reasoning",
  ];
  const lines: string[] = ["---"];
  for (const key of scalarOrder) {
    if (!(key in fields)) continue;
    const v = fields[key];
    if (v === null || v === undefined) {
      lines.push(`${key}: null`);
    } else if (typeof v === "boolean") {
      lines.push(`${key}: ${v ? "true" : "false"}`);
    } else if (typeof v === "number") {
      lines.push(`${key}: ${v}`);
    } else {
      // Always JSON-encode strings so quotes / newlines / em-dashes
      // round-trip cleanly. js-yaml on the read side accepts this.
      lines.push(`${key}: ${JSON.stringify(String(v))}`);
    }
  }
  // Nested side_effects object — serialize via js-yaml so the workflow's
  // pyyaml reader can round-trip it. Anything else in `fields` that
  // isn't a known scalar gets written through the same path so future
  // additions don't require touching this function.
  const writtenKeys = new Set(scalarOrder);
  const nested: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (writtenKeys.has(k)) continue;
    nested[k] = v;
  }
  if (Object.keys(nested).length) {
    // Render each top-level nested key with yaml.dump and merge into
    // the frontmatter block.
    for (const [k, v] of Object.entries(nested)) {
      if (v === null || v === undefined) {
        lines.push(`${k}: null`);
      } else if (typeof v === "object") {
        const dumped = yaml.dump({ [k]: v }, { lineWidth: 200 }).trimEnd();
        lines.push(dumped);
      } else if (typeof v === "boolean") {
        lines.push(`${k}: ${v ? "true" : "false"}`);
      } else if (typeof v === "number") {
        lines.push(`${k}: ${v}`);
      } else {
        lines.push(`${k}: ${JSON.stringify(String(v))}`);
      }
    }
  }
  lines.push("---");
  lines.push("");
  if (body) lines.push(body);
  return lines.join("\n") + "\n";
}

export function registerDecisionRoutes(): void {
  // ─────────────────────────────────────────────────────────────
  // POST /api/v1/decisions
  //
  // Creates a new decision record. Required body fields: source,
  // source_record, intent. Optional: note, matter_ref, task_ref,
  // source_headline, time_to_decision_ms.
  //
  // Returns the created record (id, path, frontmatter). The
  // DecisionRouterWorkflow will pick it up within ~60s and fan out the
  // side effects.
  // ─────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/decisions", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const source = String(b.source ?? "").trim().toLowerCase() as DecisionSource;
    const sourceRecord = String(b.source_record ?? "").trim();
    const intent = String(b.intent ?? "").trim().toLowerCase() as DecisionIntent;

    if (!VALID_SOURCES.includes(source)) {
      throw new ValidationError(
        `source must be one of ${VALID_SOURCES.join(" | ")}, got ${source}`,
      );
    }
    if (!VALID_INTENTS.includes(intent)) {
      throw new ValidationError(
        `intent must be one of ${VALID_INTENTS.join(" | ")}, got ${intent}`,
      );
    }
    if (!sourceRecord) {
      throw new ValidationError("source_record required");
    }

    if (!fs.existsSync(DECISIONS_DIR)) {
      fs.mkdirSync(DECISIONS_DIR, { recursive: true });
    }

    const nowIso = new Date().toISOString();
    const ts = nowIso.replace(/:/g, "-").replace(/\..*$/, "Z");
    // Short stable id derived from source_record + timestamp so
    // double-clicks within the same second don't collide.
    const shortId = crypto
      .createHash("sha256")
      .update(`${sourceRecord}\x00${nowIso}`)
      .digest("hex")
      .slice(0, 8);
    const id = `${ts}-${shortId}`;
    const fullPath = path.join(DECISIONS_DIR, `${id}.md`);

    // Which intents are reversible? `delegate` is best-effort
    // reversible (we can flip the source record's status back, but
    // can't unsend any agent action that already fired). The rest are
    // fully reversible at the record level.
    const isReversible = intent !== "delegate" ? true : false;

    const note = typeof b.note === "string" ? b.note.trim() : "";
    const matterRef = typeof b.matter_ref === "string" ? b.matter_ref.trim() : "";
    const taskRef = typeof b.task_ref === "string" ? b.task_ref.trim() : "";
    const sourceHeadline =
      typeof b.source_headline === "string" ? b.source_headline.trim() : "";
    const ttd =
      typeof b.time_to_decision_ms === "number" ? b.time_to_decision_ms : null;

    // ─────────────────────────────────────────────────────────────
    // Synchronous source-record flip — the queue needs to be
    // immediately consistent. Without this, the source record (e.g.
    // needs_attention/<id>.md) keeps status=pending until the
    // DecisionRouterWorkflow ticks (~60s), and any query refetch in
    // that window pulls the card right back onto the Desk. We apply
    // the cheap status mutations here; the workflow still runs but
    // only for observation extraction and outcome polling.
    // ─────────────────────────────────────────────────────────────
    const synchronousActions: string[] = [];
    const synchronousSideEffects: Record<string, unknown> = {};
    let synchronousFlipOk = false;
    try {
      if (source === "needs_attention") {
        const naId = sourceRecord
          .replace(/^needs_attention\//, "")
          .replace(/\.md$/, "");
        const rec = readNeedsAttention(naId);
        if (rec) {
          if (intent === "done") {
            writeFrontmatterPatch(rec, {
              status: "done",
              resolved_at: new Date().toISOString(),
              resolution_note: note || null,
            });
            const auditPath = emitResolutionEvent(rec, "done", note);
            synchronousActions.push("needs_attention.done");
            synchronousSideEffects.needs_attention_audit = auditPath;
            synchronousFlipOk = true;
          } else if (intent === "defer") {
            writeFrontmatterPatch(rec, {
              status: "skipped",
              resolved_at: new Date().toISOString(),
              resolution_note: note || null,
            });
            const auditPath = emitResolutionEvent(rec, "skipped", note);
            synchronousActions.push("needs_attention.skip");
            synchronousSideEffects.needs_attention_audit = auditPath;
            synchronousFlipOk = true;
          } else if (intent === "take_mine") {
            // Drop the card off /desk (status=done) and stamp a
            // resolution note that points to the to_do (workflow
            // spawns the actual to_do record).
            writeFrontmatterPatch(rec, {
              status: "done",
              resolved_at: new Date().toISOString(),
              resolution_note: "Sir took this on directly (to_do spawned)",
            });
            const auditPath = emitResolutionEvent(
              rec, "done", note || "took on directly",
            );
            synchronousActions.push("needs_attention.claimed");
            synchronousSideEffects.needs_attention_audit = auditPath;
            synchronousFlipOk = true;
          } else if (intent === "delegate") {
            // Flip to dispatched optimistically so the card drops
            // off the queue; workflow still runs the actual
            // dispatchSignalToAgent in the next tick. If dispatch
            // fails the workflow can revert.
            writeFrontmatterPatch(rec, {
              status: "dispatched",
              resolved_at: new Date().toISOString(),
              resolution_note: note || null,
            });
            const auditPath = emitResolutionEvent(rec, "dispatched", note);
            synchronousActions.push("needs_attention.dispatched_optimistic");
            synchronousSideEffects.needs_attention_audit = auditPath;
            // state stays "open" — workflow handles real dispatch.
          } else if (intent === "noise") {
            // Mark-as-noise: the principal is saying "this category
            // of signal should never have surfaced." Flip to a
            // dedicated `noise` status so the desk filter drops it
            // and the workflow's noise_pattern activity can pick it
            // up + write a filter rule that subsequent signal
            // extractions consult.
            writeFrontmatterPatch(rec, {
              status: "noise",
              resolved_at: new Date().toISOString(),
              resolution_note: note || "marked as noise by principal",
            });
            const auditPath = emitResolutionEvent(
              rec, "done", note || "noise",
            );
            synchronousActions.push("needs_attention.noise");
            synchronousSideEffects.needs_attention_audit = auditPath;
            synchronousFlipOk = true;
            // state goes "completed" synchronously; workflow still
            // runs to materialise the noise_pattern record.
          }
        }
      } else if (source === "pattern_proposal") {
        // Pattern proposals carry their state in frontmatter.status.
        // Flip immediately so the proposal drops off /desk; the
        // workflow does the heavier write (instinct record on
        // delegate).
        const fullPpPath = path.join(VAULT_PATH, sourceRecord);
        if (fs.existsSync(fullPpPath)) {
          const raw = fs.readFileSync(fullPpPath, "utf-8");
          const mm = /^---\n([\s\S]*?)\n---(\n[\s\S]*)?$/.exec(raw);
          if (mm) {
            const fmText = mm[1];
            const rest = mm[2] ?? "";
            let nextStatus: string | null = null;
            if (intent === "done") nextStatus = "rejected";
            else if (intent === "delegate") nextStatus = "adopting";
            else if (intent === "defer") nextStatus = "deferred";
            else if (intent === "take_mine") nextStatus = "in_review";
            if (nextStatus) {
              const lines = fmText.split("\n");
              let foundStatus = false;
              const next = lines
                .map((line) => {
                  if (/^status:/.test(line)) {
                    foundStatus = true;
                    return `status: "${nextStatus}"`;
                  }
                  return line;
                });
              if (!foundStatus) next.push(`status: "${nextStatus}"`);
              const ppContent = `---\n${next.join("\n")}\n---${rest}`;
              fs.writeFileSync(fullPpPath, ppContent, "utf-8");
              // STORE-P1-3: synchronous status flip on pattern_proposal —
              // mirror the write into vault_index so the next desk list
              // reflects the new status.
              syncVaultIndexFromContent({
                vaultPath: VAULT_PATH,
                relPath: sourceRecord,
                content: ppContent,
              });
              synchronousActions.push(`pattern_proposal.${nextStatus}`);
              synchronousFlipOk = (intent !== "delegate"); // workflow still needs to write the instinct
            }
          }
        }
      } else if (source === "approval") {
        // Approval records use frontmatter.status too — flip directly.
        const fullApPath = path.join(VAULT_PATH, sourceRecord);
        if (fs.existsSync(fullApPath)) {
          const raw = fs.readFileSync(fullApPath, "utf-8");
          const mm = /^---\n([\s\S]*?)\n---(\n[\s\S]*)?$/.exec(raw);
          if (mm) {
            const fmText = mm[1];
            const rest = mm[2] ?? "";
            let nextStatus: string | null = null;
            if (intent === "done" || intent === "delegate") nextStatus = "approved";
            else if (intent === "defer") nextStatus = "deferred";
            else if (intent === "take_mine") nextStatus = "claimed";
            if (nextStatus) {
              const lines = fmText.split("\n");
              let foundStatus = false;
              const next = lines.map((line) => {
                if (/^status:/.test(line)) {
                  foundStatus = true;
                  return `status: "${nextStatus}"`;
                }
                return line;
              });
              if (!foundStatus) next.push(`status: "${nextStatus}"`);
              const apContent = `---\n${next.join("\n")}\n---${rest}`;
              fs.writeFileSync(fullApPath, apContent, "utf-8");
              // STORE-P1-3: index the approval status flip.
              syncVaultIndexFromContent({
                vaultPath: VAULT_PATH,
                relPath: sourceRecord,
                content: apContent,
              });
              synchronousActions.push(`approval.${nextStatus}`);
              synchronousFlipOk = (intent !== "delegate");
            }
          }
        }
      } else if (source === "judgment") {
        // Judgments are observations the principal acknowledges or
        // dismisses — same frontmatter-status pattern.
        const fullJuPath = path.join(VAULT_PATH, sourceRecord);
        if (fs.existsSync(fullJuPath)) {
          const raw = fs.readFileSync(fullJuPath, "utf-8");
          const mm = /^---\n([\s\S]*?)\n---(\n[\s\S]*)?$/.exec(raw);
          if (mm) {
            const fmText = mm[1];
            const rest = mm[2] ?? "";
            let nextStatus: string | null = null;
            if (intent === "done") nextStatus = "acknowledged";
            else if (intent === "defer") nextStatus = "deferred";
            else if (intent === "delegate") nextStatus = "actioned";
            else if (intent === "take_mine") nextStatus = "claimed";
            if (nextStatus) {
              const lines = fmText.split("\n");
              let foundStatus = false;
              const next = lines.map((line) => {
                if (/^status:/.test(line)) {
                  foundStatus = true;
                  return `status: "${nextStatus}"`;
                }
                return line;
              });
              if (!foundStatus) next.push(`status: "${nextStatus}"`);
              const juContent = `---\n${next.join("\n")}\n---${rest}`;
              fs.writeFileSync(fullJuPath, juContent, "utf-8");
              // STORE-P1-3: index the judgment status flip.
              syncVaultIndexFromContent({
                vaultPath: VAULT_PATH,
                relPath: sourceRecord,
                content: juContent,
              });
              synchronousActions.push(`judgment.${nextStatus}`);
              synchronousFlipOk = true;
            }
          }
        }
      }
    } catch (err) {
      // Best-effort: the synchronous flip is an optimization. If it
      // fails the workflow will still pick up the decision and do
      // the side-effects ~60s later. Log and continue.
      console.error(
        `[decisions] synchronous flip failed for ${source}/${sourceRecord}:`,
        err,
      );
    }

    if (synchronousActions.length) {
      synchronousSideEffects.synchronous_flip = true;
      synchronousSideEffects.actions = synchronousActions;
    }

    // For cheap intents that fully completed synchronously, mark the
    // decision state=completed now. For delegate (which still needs
    // the workflow to actually dispatch) and pattern_proposal/delegate
    // (workflow writes the instinct), leave state=open.
    const initialState: DecisionState =
      synchronousFlipOk && intent !== "delegate" ? "completed" : "open";

    // OBS-6: optional `principal` field on the body — defaults to
    // "principal" (Sir clicked) but signal_router POSTs with "alfred"
    // for autonomous instinct fires.
    const principalRaw = String(b.principal ?? "principal").trim().toLowerCase();
    if (!VALID_PRINCIPALS.includes(principalRaw as DecisionPrincipal)) {
      throw new ValidationError(
        `principal must be one of ${VALID_PRINCIPALS.join(" | ")}, got ${principalRaw}`,
      );
    }
    const principal = principalRaw as DecisionPrincipal;
    // Optional decision_origin — for instinct_fire decisions, this is
    // the matched instinct path so the observation layer + audit
    // ledger can trace which rule fired.
    const decisionOrigin = typeof b.decision_origin === "string"
      ? b.decision_origin.trim()
      : "";

    const fields: Record<string, unknown> = {
      type: "decision",
      created: nowIso,
      principal,
      source,
      source_record: sourceRecord,
      source_headline: sourceHeadline || null,
      intent,
      note: note || null,
      matter_ref: matterRef || null,
      task_ref: taskRef || null,
      state: initialState,
      outcome_record: null,
      time_to_decision_ms: ttd,
      reversed_at: null,
      is_reversible: isReversible,
      side_effects: Object.keys(synchronousSideEffects).length
        ? synchronousSideEffects
        : null,
      completed_at: initialState === "completed" ? nowIso : null,
      ...(decisionOrigin ? { decision_origin: decisionOrigin } : {}),
    };

    const bodyText = [
      `# Decision: ${intent} on ${source}`,
      "",
      `Principal clicked **${intent}** on \`${sourceRecord}\` via the Today desk at ${nowIso}.`,
      "",
      sourceHeadline ? `Card headline: ${sourceHeadline}` : "",
      note ? `Note: ${note}` : "",
      matterRef ? `Matter: \`${matterRef}\`` : "",
      taskRef ? `Task: \`${taskRef}\`` : "",
      synchronousActions.length
        ? `Source flipped synchronously: ${synchronousActions.join(", ")}`
        : "",
    ]
      .filter((s) => s !== "")
      .join("\n");

    fs.writeFileSync(fullPath, renderDecisionRecord(fields, bodyText), "utf-8");
    // STORE-P1-3: index the brand-new decision row.
    syncVaultIndexFromContent({
      vaultPath: VAULT_PATH,
      relPath: `decision/${id}.md`,
      content: renderDecisionRecord(fields, bodyText),
    });

    sendJson(res, 201, {
      ok: true,
      id,
      path: `decision/${id}.md`,
      frontmatter: fields,
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /api/v1/decisions
  //
  // List decisions, newest first. Query params:
  //   state   — filter (open | executing | completed | reversed)
  //   source  — filter (needs_attention | approval | judgment | to_do)
  //   since   — ISO timestamp; only return decisions created on/after
  //   limit   — default 100, max 500
  // ─────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/decisions", async ({ res, req }) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const stateFilter = url.searchParams.get("state");
    const sourceFilter = url.searchParams.get("source");
    const since = url.searchParams.get("since");
    const limit = Math.max(
      1,
      Math.min(500, parseInt(url.searchParams.get("limit") ?? "100", 10) || 100),
    );

    if (!fs.existsSync(DECISIONS_DIR)) {
      sendJson(res, 200, { decisions: [], count: 0 });
      return;
    }
    const files = fs.readdirSync(DECISIONS_DIR).filter((f) => f.endsWith(".md"));
    const records: any[] = [];
    for (const f of files) {
      const id = f.replace(/\.md$/, "");
      const rec = readDecision(id);
      if (!rec) continue;
      const fm = rec.frontmatter;
      const state = String(fm.state ?? "open");
      if (stateFilter && state !== stateFilter) continue;
      if (sourceFilter && String(fm.source ?? "") !== sourceFilter) continue;
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
      decisions: records.slice(0, limit),
      count: records.length,
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /api/v1/decisions/in-flight
  //
  // Returns the currently-in-flight decisions for the "What Alfred is
  // doing now" Desk strip. In-flight = state in [open, scheduled,
  // executing]. Decisions in `open` for >10 min are surfaced too —
  // they're effectively stuck (workflow should have picked them up
  // within 60s). Sorted by `created` desc so the most recent action
  // appears first.
  // ─────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/decisions/in-flight", async ({ res, req }) => {
    if (!fs.existsSync(DECISIONS_DIR)) {
      sendJson(res, 200, { decisions: [], count: 0 });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const limit = Math.max(
      1,
      Math.min(200, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50),
    );
    const files = fs.readdirSync(DECISIONS_DIR).filter((f) => f.endsWith(".md"));
    const records: any[] = [];
    for (const f of files) {
      const id = f.replace(/\.md$/, "");
      const rec = readDecision(id);
      if (!rec) continue;
      const fm = rec.frontmatter;
      const state = String(fm.state ?? "open");
      if (state !== "open" && state !== "scheduled" && state !== "executing") {
        continue;
      }
      // Reject malformed/legacy decision-shaped records that don't
      // match the AB 1.0 decision schema. The vault has fixture files
      // (e.g. `decision/test.md` from April 4 with `approved_by` etc.)
      // that predate this surface entirely. Skip anything that doesn't
      // carry an intent + source_record — without those, the strip
      // would render "(no headline)" against an unparseable date.
      const intent = String(fm.intent ?? "").trim().toLowerCase();
      const sourceRecord = String(fm.source_record ?? "").trim();
      if (
        !VALID_INTENTS.includes(intent as DecisionIntent) ||
        !sourceRecord
      ) {
        continue;
      }
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
      decisions: records.slice(0, limit),
      count: records.length,
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /api/v1/decisions/:id
  // ─────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/decisions/:id", async ({ res, params }) => {
    const rec = readDecision(params.id);
    if (!rec) throw new NotFoundError(`decision/${params.id} not found`);
    sendJson(res, 200, {
      id: rec.id,
      path: rec.path,
      ...rec.frontmatter,
      body: rec.body,
    });
  });

  // ─────────────────────────────────────────────────────────────
  // PATCH /api/v1/decisions/:id
  //
  // Partial update — used by the DecisionRouterWorkflow to flip state,
  // stamp outcome_record, etc. Only allows a whitelisted set of fields
  // to mutate so the audit trail can't be rewritten.
  // ─────────────────────────────────────────────────────────────
  addRoute("PATCH", "/api/v1/decisions/:id", async ({ res, params, body }) => {
    const rec = readDecision(params.id);
    if (!rec) throw new NotFoundError(`decision/${params.id} not found`);
    const updates = (body ?? {}) as Record<string, unknown>;
    const allowed = new Set([
      "state",
      "outcome_record",
      "reversed_at",
      "executing_at",
      "completed_at",
      "side_effects",
      "execute_at",
      "scheduled_at",
      "scheduled_reasoning",
    ]);
    const next: Record<string, unknown> = { ...rec.frontmatter };
    for (const [k, v] of Object.entries(updates)) {
      if (!allowed.has(k)) continue;
      next[k] = v;
    }
    if ("state" in updates) {
      const s = String(updates.state ?? "").toLowerCase();
      if (!VALID_STATES.includes(s as DecisionState)) {
        throw new ValidationError(
          `state must be one of ${VALID_STATES.join(" | ")}, got ${s}`,
        );
      }
      next.state = s;
    }
    const fullPath = path.join(DECISIONS_DIR, `${rec.id}.md`);
    const patchedContent = renderDecisionRecord(next, rec.body);
    fs.writeFileSync(fullPath, patchedContent, "utf-8");
    // STORE-P1-3: index the patched decision row.
    syncVaultIndexFromContent({
      vaultPath: VAULT_PATH,
      relPath: rec.path,
      content: patchedContent,
    });
    sendJson(res, 200, {
      ok: true,
      id: rec.id,
      path: rec.path,
      frontmatter: next,
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /api/v1/admin/pattern-proposals
  //
  // Lists `decision_pattern/*.md` records with status=proposed so the
  // /desk page can surface them as cards alongside needs_attention /
  // approval / judgment. The principal's Delegate click adopts the
  // rule (router writes an instinct); Delete rejects it; Defer uses
  // the standard resurface flow. Closes the learning loop: clicks →
  // patterns → instincts → auto-routing.
  // ─────────────────────────────────────────────────────────────
  addRoute(
    "GET",
    "/api/v1/admin/pattern-proposals",
    async ({ res, req }) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const limit = Math.max(
        1,
        Math.min(
          200,
          parseInt(url.searchParams.get("limit") ?? "100", 10) || 100,
        ),
      );
      const patternsDir = DECISIONS_DIR.replace(
        /\/decision$/,
        "/decision_pattern",
      );
      if (!fs.existsSync(patternsDir)) {
        sendJson(res, 200, { proposals: [], count: 0 });
        return;
      }
      const files = fs
        .readdirSync(patternsDir)
        .filter((f) => f.endsWith(".md"));
      const records: any[] = [];
      for (const f of files) {
        const id = f.replace(/\.md$/, "");
        const fullPath = path.join(patternsDir, `${id}.md`);
        let raw: string;
        try {
          raw = fs.readFileSync(fullPath, "utf-8");
        } catch {
          continue;
        }
        const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
        if (!m) continue;
        let fm: Record<string, unknown> = {};
        try {
          const parsed = yaml.load(m[1]) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            fm = parsed as Record<string, unknown>;
          }
        } catch {
          continue;
        }
        const status = String(fm.status ?? "proposed");
        if (status !== "proposed") continue;
        records.push({
          id,
          path: `decision_pattern/${id}.md`,
          ...fm,
        });
      }
      records.sort((a, b) =>
        String(b.created ?? "").localeCompare(String(a.created ?? "")),
      );
      sendJson(res, 200, {
        proposals: records.slice(0, limit),
        count: records.length,
      });
    },
  );

  // ─────────────────────────────────────────────────────────────
  // POST /api/v1/decisions/:id/reverse
  //
  // Mark a decision as reversed. The DecisionRouterWorkflow picks it
  // up on the next 60s tick and runs inverse side-effects where
  // possible (status flip-back on source record, to_do cancel). For
  // intents whose external effects already landed (e.g. delegate where
  // the agent fired) the reverse is best-effort: the desk card
  // reopens but the world isn't rewound.
  // ─────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/decisions/:id/reverse", async ({ res, params }) => {
    const rec = readDecision(params.id);
    if (!rec) throw new NotFoundError(`decision/${params.id} not found`);
    if (rec.frontmatter.state === "reversed") {
      sendJson(res, 200, {
        ok: true,
        id: rec.id,
        already_reversed: true,
      });
      return;
    }
    if (rec.frontmatter.is_reversible === false) {
      throw new ValidationError(
        `decision/${rec.id} is not reversible (intent=${rec.frontmatter.intent})`,
      );
    }
    const next: Record<string, unknown> = { ...rec.frontmatter };
    next.state = "reversed";
    next.reversed_at = new Date().toISOString();
    const fullPath = path.join(DECISIONS_DIR, `${rec.id}.md`);
    const reversedContent = renderDecisionRecord(next, rec.body);
    fs.writeFileSync(fullPath, reversedContent, "utf-8");
    // STORE-P1-3: index the reversed decision row.
    syncVaultIndexFromContent({
      vaultPath: VAULT_PATH,
      relPath: rec.path,
      content: reversedContent,
    });
    sendJson(res, 200, {
      ok: true,
      id: rec.id,
      path: rec.path,
      frontmatter: next,
    });
  });
}
