// Steward (#836 Phase 0.5) — recent-actions list + undo endpoint.
//
// The audit trail for Steward decisions lives entirely in the vault as
// ``event/steward-action-*.md`` records (and corresponding
// ``event/steward-action-reversed-*.md`` reversal records). These two
// routes are the dashboard's window into that trail:
//
// * ``GET /api/v1/steward/recent-actions`` — list view for the badges +
//   inline briefing section.
// * ``POST /api/v1/steward/undo/:action_id`` — execute the
//   ``undo_recipe`` embedded in a live-mode audit record. Refuses on
//   shadow records (nothing to undo), expired records, or already-
//   reversed records.
//
// All vault I/O reuses the helpers in ``./vault.js`` so we share the
// js-yaml-backed parser and the per-path write mutex (#593).
//
// NOTE: Briefing inline section ("Closed since last brief: N") is NOT
// implemented in this file. The daily briefing is delivered via Slack /
// AgentMail by the alfred-learn briefing renderer (Phase 5 work) — the
// dashboard does not render a briefing page today. When the briefing
// renderer lands it should consume this same recent-actions endpoint
// (filtered by ``timestamp >= last_brief_sent_at``).
import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { ApiError, sendJson, ValidationError, NotFoundError, ConflictError } from "../errors.js";
import { dockerExec, ALFRED_CMD } from "../helpers.js";
import { VAULT_PATH, VAULT_ENV, readRecord, walkMd, IGNORE_DIRS } from "./vault.js";
import { revertStewardAction, postStewardAction } from "./plane.js";
import { vaultWalkCache } from "../vaultCache.js";
import { syncVaultIndexFromContent } from "../vault_index_sync.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Audit records live under ``event/`` and start with this prefix. The
// alfred-learn ``apply_state_change`` activity is the sole writer for
// the primary records; the dashboard's confirm/dismiss/undo handlers
// emit the follow-up records (steward-action-{reversed,confirmed,
// dismissed}-*).
const STEWARD_ACTION_PREFIX = "steward-action-";
const STEWARD_REVERSED_PREFIX = "steward-action-reversed-";
const STEWARD_CONFIRMED_PREFIX = "steward-action-confirmed-";
const STEWARD_DISMISSED_PREFIX = "steward-action-dismissed-";
// Phase 5 (#841): source-pruned audit records emitted by the
// ``_emit_source_pruned_audit`` helper in alfred-learn. These ride the
// same vault directory as steward-action records but a different prefix
// so they don't get pulled into the primary recent-actions feed by
// default — opt in via ``include_source_pruned=1``.
const STEWARD_SOURCE_PRUNED_PREFIX = "steward-source-pruned-";

// Default lookback for the list endpoint. The dashboard inline UI only
// surfaces actions from the last ~24 h; older actions are still in the
// vault but the badge timeline is short by design (see RFC #832 §6).
const DEFAULT_RECENT_HOURS = 24;
// Cap returned actions so a tenant with hundreds of evaluations doesn't
// hand the dashboard a multi-MB JSON blob; the badge UI never needs
// more than the most recent few hundred.
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StewardEvidenceItem {
  source?: string;
  ref?: string;
  note?: string;
  [k: string]: unknown;
}

interface StewardUndoRecipe {
  vault_patch?: { target?: string; set?: Record<string, unknown> } | null;
  plane_revert?: {
    issue_id?: string;
    project_id?: string;
    delete_comment_id?: string | null;
    restore_state?: string | null;
    restore_archived?: boolean | null;
  } | null;
  expires_at?: string;
}

interface StewardActionRecord {
  path: string;
  timestamp: string;
  target: string;
  decision: string;
  confidence: number;
  mode: "shadow" | "live" | string;
  evidence: StewardEvidenceItem[];
  plane_action: unknown;
  undo_recipe: StewardUndoRecipe;
  is_reversible: boolean;
  pending_confirmation: boolean;
  signals_summary?: Record<string, unknown>;
}

// Phase 5 (#841): shape returned for source-pruned events. The audit
// record itself only carries scalars (no undo recipe — pruning a
// signal source is not reversible from the dashboard; Sir reverts by
// editing the task frontmatter directly).
interface StewardSourcePrunedRecord {
  path: string;
  timestamp: string;
  target: string;
  source_name: string;
  reason: string;
  final_confidence: number;
  ticks_observed: number;
  total_signals: number;
  // Discriminator so dashboard renderers can branch on the same array.
  kind: "source-pruned";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce a timestamp value (ISO-8601 string or Date) to epoch ms. */
function parseTs(value: unknown): number | null {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  // Accept the ``2026-05-04T12:34:56Z`` form ISO renderers emit even
  // though Date.parse already understands the trailing-Z variant — the
  // explicit normalisation makes the failure surface obvious if a
  // future audit-record writer emits a non-standard shape.
  const normalised = s.endsWith("Z") ? s.slice(0, -1) + "+00:00" : s;
  const t = Date.parse(normalised);
  return Number.isFinite(t) ? t : null;
}

function isStewardActionPath(relPath: string): boolean {
  // Match both unix and windows separator forms — walkMd returns
  // platform-native paths.
  const normalised = relPath.replace(/\\/g, "/");
  return (
    normalised.startsWith(`event/${STEWARD_ACTION_PREFIX}`) &&
    normalised.endsWith(".md") &&
    // Follow-up records (reversal / confirmation / dismissal) belong
    // to the audit log but should not show up as primary "recent
    // actions" — the dashboard renders them as effects of an action,
    // not fresh decisions. Exclude here so the listing endpoint
    // doesn't have to lift the type-scalar check on every record.
    !normalised.startsWith(`event/${STEWARD_REVERSED_PREFIX}`) &&
    !normalised.startsWith(`event/${STEWARD_CONFIRMED_PREFIX}`) &&
    !normalised.startsWith(`event/${STEWARD_DISMISSED_PREFIX}`) &&
    // ``steward-action-`` is a prefix of ``steward-source-pruned-`` ONLY
    // when matched permissively — the explicit prefix-startsWith above
    // already excludes them since the latter starts with
    // ``steward-source-pruned-``, not ``steward-action-``. Belt-and-
    // braces: keep the negative check anyway in case the prefix
    // strings drift in a future refactor.
    !normalised.startsWith(`event/${STEWARD_SOURCE_PRUNED_PREFIX}`)
  );
}

function isStewardSourcePrunedPath(relPath: string): boolean {
  const normalised = relPath.replace(/\\/g, "/");
  return (
    normalised.startsWith(`event/${STEWARD_SOURCE_PRUNED_PREFIX}`) &&
    normalised.endsWith(".md")
  );
}

/** Read a source-pruned audit record into the dashboard-friendly shape. */
function loadSourcePrunedRecord(relPath: string): StewardSourcePrunedRecord | null {
  const rec = readRecord(relPath);
  if (!rec) return null;
  const fm = rec.fm;
  const recType = String(fm.type || "");
  if (recType !== "steward-source-pruned") return null;

  const finalConfidenceRaw = fm.final_confidence;
  const finalConfidence =
    typeof finalConfidenceRaw === "number"
      ? finalConfidenceRaw
      : Number.parseFloat(String(finalConfidenceRaw || "0")) || 0;
  const ticksRaw = fm.ticks_observed;
  const ticks =
    typeof ticksRaw === "number"
      ? ticksRaw
      : Number.parseInt(String(ticksRaw || "0"), 10) || 0;
  const signalsRaw = fm.total_signals;
  const totalSignals =
    typeof signalsRaw === "number"
      ? signalsRaw
      : Number.parseInt(String(signalsRaw || "0"), 10) || 0;

  return {
    path: relPath.replace(/\\/g, "/"),
    timestamp: String(fm.timestamp || ""),
    target: String(fm.target || ""),
    source_name: String(fm.source_name || ""),
    reason: String(fm.reason || ""),
    final_confidence: finalConfidence,
    ticks_observed: ticks,
    total_signals: totalSignals,
    kind: "source-pruned",
  };
}

function reversalPathFor(actionId: string): string {
  // ``action_id`` is the slug after ``event/steward-action-`` (no
  // ``.md`` suffix). The reversal record sits next to it:
  //   event/steward-action-2026-05-04T12-34-56Z-foo.md
  //   event/steward-action-reversed-2026-05-04T12-34-56Z-foo.md
  return `event/${STEWARD_REVERSED_PREFIX}${actionId}.md`;
}

function reversalAlreadyExists(actionId: string): boolean {
  const rel = reversalPathFor(actionId);
  const full = path.resolve(VAULT_PATH, rel);
  try {
    return fs.statSync(full).isFile();
  } catch {
    return false;
  }
}

/** Convert a raw frontmatter ``evidence`` value to a list of typed items. */
function normaliseEvidence(raw: unknown): StewardEvidenceItem[] {
  if (!Array.isArray(raw)) return [];
  const out: StewardEvidenceItem[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      out.push(item as StewardEvidenceItem);
    } else if (typeof item === "string") {
      // Older audit records (or hand-edited ones) may store evidence
      // as bare strings; surface them so the badge tooltip still has
      // SOMETHING to render.
      out.push({ note: item });
    }
  }
  return out;
}

function normaliseUndoRecipe(raw: unknown): StewardUndoRecipe {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const recipe: StewardUndoRecipe = {};
  if (r.vault_patch && typeof r.vault_patch === "object") {
    recipe.vault_patch = r.vault_patch as StewardUndoRecipe["vault_patch"];
  } else if (r.vault_patch === null) {
    recipe.vault_patch = null;
  }
  if (r.plane_revert && typeof r.plane_revert === "object") {
    recipe.plane_revert = r.plane_revert as StewardUndoRecipe["plane_revert"];
  } else if (r.plane_revert === null) {
    recipe.plane_revert = null;
  }
  if (typeof r.expires_at === "string") {
    recipe.expires_at = r.expires_at;
  }
  return recipe;
}

/** Read a single audit record and shape it for the dashboard. */
function loadActionRecord(relPath: string): StewardActionRecord | null {
  const rec = readRecord(relPath);
  if (!rec) return null;
  const fm = rec.fm;
  const recType = String(fm.type || "");
  // Defensive — only emit records that actually claim to be steward
  // actions. The filename prefix is the primary filter but we re-check
  // the ``type`` scalar so a hand-edited file can't slip into the
  // listing with a different type.
  if (recType !== "steward-action") return null;

  const timestamp = String(fm.timestamp || "");
  const target = String(fm.target || "");
  const decision = String(fm.decision || "");
  const confidenceRaw = fm.confidence;
  const confidence =
    typeof confidenceRaw === "number"
      ? confidenceRaw
      : Number.parseFloat(String(confidenceRaw || "0")) || 0;
  const mode = String(fm.mode || "shadow");

  const evidence = normaliseEvidence(fm.evidence);
  const undoRecipe = normaliseUndoRecipe(fm.undo_recipe);
  const planeAction = fm.plane_action ?? null;
  const pendingConfirmation = Boolean(fm.pending_confirmation);
  const signalsSummary =
    fm.signals_summary && typeof fm.signals_summary === "object"
      ? (fm.signals_summary as Record<string, unknown>)
      : undefined;

  // Reversibility is the cheapest check we can do here so the
  // dashboard doesn't need a second round-trip per action. Reversal
  // requires:
  //   1. mode === "live" (shadow records have no state to undo)
  //   2. now < expires_at (the 7-day undo window)
  //   3. no reversal record on disk yet
  //
  // The undo HANDLER re-checks all three under a lock — this flag is
  // purely a UI affordance.
  //
  // Pending-confirmation records ARE reversible — even though Plane
  // wasn't touched, the vault frontmatter was patched with
  // ``pending_confirmation: true`` and undo flips it back. Dismiss
  // does the lighter-weight version of the same revert.
  let reversible = false;
  if (mode === "live") {
    const expiresMs = parseTs(undoRecipe.expires_at);
    if (expiresMs !== null && Date.now() < expiresMs) {
      const stem = path.basename(relPath, ".md");
      const actionId = stem.startsWith(STEWARD_ACTION_PREFIX)
        ? stem.slice(STEWARD_ACTION_PREFIX.length)
        : stem;
      reversible = !reversalAlreadyExists(actionId);
    }
  }

  return {
    path: relPath.replace(/\\/g, "/"),
    timestamp,
    target,
    decision,
    confidence,
    mode,
    evidence,
    plane_action: planeAction,
    undo_recipe: undoRecipe,
    is_reversible: reversible,
    pending_confirmation: pendingConfirmation,
    signals_summary: signalsSummary,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerStewardRoutes(): void {
  // GET /api/v1/steward/recent-actions
  //
  // Lists steward-action audit records since ``since`` (default: 24 h
  // ago), newest-first, capped at ``limit`` (default 100, max 500).
  addRoute("GET", "/api/v1/steward/recent-actions", async ({ res, query }) => {
    // since — ISO-8601 string. Default: now - DEFAULT_RECENT_HOURS.
    const sinceRaw = query.get("since");
    let sinceMs: number;
    if (sinceRaw && sinceRaw.trim()) {
      const parsed = parseTs(sinceRaw);
      if (parsed === null) {
        throw new ValidationError(
          `Invalid 'since' parameter — expected ISO-8601 timestamp, got: ${sinceRaw}`,
        );
      }
      sinceMs = parsed;
    } else {
      sinceMs = Date.now() - DEFAULT_RECENT_HOURS * 60 * 60 * 1000;
    }

    // limit — bounded.
    const limitRaw = query.get("limit");
    let limit = DEFAULT_LIMIT;
    if (limitRaw !== null && limitRaw !== "") {
      const n = Number.parseInt(limitRaw, 10);
      if (!Number.isFinite(n) || n < 1 || n > MAX_LIMIT) {
        throw new ValidationError(`limit must be 1..${MAX_LIMIT}`);
      }
      limit = n;
    }

    // Optional ``target=task/<slug>.md`` filter. The dashboard badge
    // component fetches per-task to scope its tooltip; passing the
    // filter here saves a full-list walk on the client side.
    const target = (query.get("target") || "").trim();

    // Phase 5 (#841): opt-in inclusion of steward-source-pruned audit
    // records in the same response. Default off so existing dashboard
    // clients see exactly the same shape they always did. New clients
    // that want the calibration-loop view pass include_source_pruned=1.
    const includeSourcePrunedRaw = query.get("include_source_pruned") || "";
    const includeSourcePruned =
      includeSourcePrunedRaw === "1" ||
      includeSourcePrunedRaw.toLowerCase() === "true";

    // Walk the vault for steward audit records. ``walkMd`` is sync
    // (fast) and skips the IGNORE_DIRS the rest of the vault routes
    // use — we want the same skip-list so a misplaced record under
    // ``_templates/`` etc. doesn't pollute the timeline.
    //
    // Cache the (since, limit, target, include_source_pruned) tuple
    // for a few seconds so the Desk's per-page-load + per-click
    // refetches collapse onto a single walk + loadActionRecord pass.
    //
    // ``sinceMs`` for the default code path is ``now - 24h``, recomputed
    // every call — without bucketing every request produces a unique
    // cache key and we miss 100% of the time. Round to a 3 s window so
    // bursts share a key while preserving 3 s freshness.
    const sinceBucket = Math.floor(sinceMs / 3_000);
    const cacheKey = `steward:${sinceBucket}:${limit}:${target}:${includeSourcePruned ? 1 : 0}`;
    const responsePayload = await vaultWalkCache.get(cacheKey, () => {
      const allFiles = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
      const actions: StewardActionRecord[] = [];
      const sourcePruned: StewardSourcePrunedRecord[] = [];
      for (const relPath of allFiles) {
        if (isStewardActionPath(relPath)) {
          const record = loadActionRecord(relPath);
          if (!record) continue;
          const tsMs = parseTs(record.timestamp);
          if (tsMs === null || tsMs < sinceMs) continue;
          if (target && record.target !== target) continue;
          actions.push(record);
          continue;
        }
        if (includeSourcePruned && isStewardSourcePrunedPath(relPath)) {
          const record = loadSourcePrunedRecord(relPath);
          if (!record) continue;
          const tsMs = parseTs(record.timestamp);
          if (tsMs === null || tsMs < sinceMs) continue;
          if (target && record.target !== target) continue;
          sourcePruned.push(record);
        }
      }

      // Newest first — timeline UI expectation.
      actions.sort((a, b) => {
        const ta = parseTs(a.timestamp) ?? 0;
        const tb = parseTs(b.timestamp) ?? 0;
        return tb - ta;
      });
      sourcePruned.sort((a, b) => {
        const ta = parseTs(a.timestamp) ?? 0;
        const tb = parseTs(b.timestamp) ?? 0;
        return tb - ta;
      });

      const truncated = actions.length > limit;
      const payload: Record<string, unknown> = {
        actions: actions.slice(0, limit),
        count: Math.min(actions.length, limit),
        since: new Date(sinceMs).toISOString(),
        truncated,
      };
      if (includeSourcePruned) {
        const sourcePrunedTruncated = sourcePruned.length > limit;
        payload.source_pruned = sourcePruned.slice(0, limit);
        payload.source_pruned_count = Math.min(sourcePruned.length, limit);
        payload.source_pruned_truncated = sourcePrunedTruncated;
      }
      return payload;
    });
    sendJson(res, 200, responsePayload);
  });

  // POST /api/v1/steward/undo/:action_id
  //
  // Reverses a live-mode steward action. ``action_id`` is the
  // filename slug after ``event/steward-action-`` (no extension).
  addRoute("POST", "/api/v1/steward/undo/:action_id", async ({ res, params }) => {
    const actionId = (params.action_id || "").trim();
    if (!actionId) {
      throw new ValidationError("action_id is required");
    }
    // Defence-in-depth — refuse anything that could escape the event/
    // directory. The ``:action_id`` route segment doesn't allow ``/``,
    // but a stray ``..`` segment would still resolve to a parent dir
    // through ``path.resolve`` if we let it through.
    if (actionId.includes("..") || actionId.includes("/") || actionId.includes("\\")) {
      throw new ValidationError("action_id contains invalid characters");
    }

    const auditRel = `event/${STEWARD_ACTION_PREFIX}${actionId}.md`;
    const auditFull = path.resolve(VAULT_PATH, auditRel);
    if (!auditFull.startsWith(path.resolve(VAULT_PATH) + path.sep)) {
      throw new ValidationError("action_id resolves outside the vault");
    }

    const record = loadActionRecord(auditRel);
    if (!record) {
      throw new NotFoundError(`Steward action not found: ${actionId}`);
    }

    if (record.mode !== "live") {
      // Phase 0.5 contract — shadow records didn't change anything.
      throw new ValidationError(
        "shadow actions cannot be undone (no state was mutated)",
      );
    }

    // Window check — explicit 410 Gone for an expired window so the
    // dashboard can distinguish "you missed it" from "it doesn't
    // exist".
    const expiresMs = parseTs(record.undo_recipe.expires_at);
    if (expiresMs === null) {
      throw new ApiError(
        500,
        "STEWARD_UNDO_INVALID",
        "audit record is missing undo_recipe.expires_at",
      );
    }
    if (Date.now() >= expiresMs) {
      throw new ApiError(410, "STEWARD_UNDO_EXPIRED", "undo window expired");
    }

    if (reversalAlreadyExists(actionId)) {
      throw new ConflictError("already reversed");
    }

    // Execute the recipe.
    //
    // 1. vault_patch — PATCH the task frontmatter to revert the prior
    //    state. We go through the alfred CLI (same path
    //    ``record_steward_check`` uses) so the per-file lock + audit
    //    log are consistent with normal vault writes.
    const vaultPatch = record.undo_recipe.vault_patch;
    let vaultPatchApplied = false;
    if (vaultPatch && vaultPatch.target && vaultPatch.set && typeof vaultPatch.set === "object") {
      const target = vaultPatch.target;
      const set = vaultPatch.set as Record<string, unknown>;
      // Strip the leading ``./`` if some caller normalised the target
      // weirdly; CLI rejects absolute paths.
      const cleanTarget = target.replace(/^\.\//, "");
      const args = [...ALFRED_CMD, "vault", "edit", cleanTarget];
      for (const [k, v] of Object.entries(set)) {
        let val: string;
        if (typeof v === "boolean") val = v ? "true" : "false";
        else if (v === null || v === undefined) val = "";
        else val = String(v);
        args.push("--set", `${k}=${val}`);
      }
      try {
        await dockerExec("alfred", args, VAULT_ENV);
        vaultPatchApplied = true;
      } catch (err) {
        // The CLI's exit-on-not-found returns a structured payload —
        // the dashboard cares whether the undo actually flipped any
        // state, so surface this clearly rather than swallowing it.
        const e = err as { stderr?: string; message?: string };
        throw new ApiError(
          500,
          "STEWARD_UNDO_VAULT_PATCH_FAILED",
          `vault_patch failed: ${e.message ?? String(err)}`,
          {
            stderr: (e.stderr ?? "").slice(0, 500),
            target: cleanTarget,
          },
        );
      }
    }

    // 2. plane_revert (#839 Phase 3) — issue a Plane DELETE for
    //    ``delete_comment_id`` (404 OK), a state-restore PATCH for
    //    ``restore_state``, and an archived-flag restore. Helper is
    //    idempotent so a re-run on a partial revert is safe.
    const planeRevert = record.undo_recipe.plane_revert;
    let planeRevertApplied = false;
    if (planeRevert && planeRevert.issue_id) {
      const projectId = (planeRevert.project_id || "").trim();
      if (!projectId) {
        // Pre-Phase-3 audit records may carry plane_revert without a
        // project_id (we added the field in this PR). Surface clearly
        // so the dashboard can fall back to "vault-only undo" while
        // an operator manually reverts the Plane side.
        throw new ApiError(
          409,
          "STEWARD_UNDO_PLANE_PROJECT_MISSING",
          "plane_revert is missing project_id — undo cannot reach Plane without it",
        );
      }
      try {
        await revertStewardAction(
          planeRevert.issue_id,
          planeRevert.delete_comment_id ?? null,
          planeRevert.restore_state ?? null,
          typeof planeRevert.restore_archived === "boolean"
            ? planeRevert.restore_archived
            : null,
          projectId,
        );
        planeRevertApplied = true;
      } catch (err) {
        const e = err as { code?: string; message?: string };
        throw new ApiError(
          502,
          "STEWARD_UNDO_PLANE_REVERT_FAILED",
          `plane_revert failed: ${e.message ?? String(err)}`,
          {
            code: e.code,
            issue_id: planeRevert.issue_id,
            project_id: projectId,
          },
        );
      }
    }

    // 3. Write the reversal record. We compose the YAML by hand for
    //    the same reasons the Python apply_state_change activity
    //    does — no extra YAML serialiser dependency, and the structure
    //    is small.
    const reversedAt = new Date().toISOString();
    const reversalRel = reversalPathFor(actionId);
    const reversalContent = renderReversalRecord({
      actionId,
      reversedAt,
      auditPath: record.path,
      target: record.target,
      decision: record.decision,
      vaultPatchApplied,
      planeRevertApplied,
      reversedBy: "dashboard-undo",
    });
    const reversalFull = path.resolve(VAULT_PATH, reversalRel);
    if (!reversalFull.startsWith(path.resolve(VAULT_PATH) + path.sep)) {
      throw new ApiError(
        500,
        "STEWARD_UNDO_PATH_INVALID",
        "computed reversal path resolves outside the vault",
      );
    }
    await fs.promises.mkdir(path.dirname(reversalFull), { recursive: true });
    // ``wx`` ensures we don't clobber a concurrent reversal —
    // ``reversalAlreadyExists`` above is the optimistic check; this
    // flag is the real guard against TOCTOU.
    try {
      await fs.promises.writeFile(reversalFull, reversalContent, { flag: "wx" });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EEXIST") {
        throw new ConflictError("already reversed");
      }
      throw err;
    }
    // STORE-P1-3: index the new reversal audit row.
    syncVaultIndexFromContent({
      vaultPath: VAULT_PATH,
      relPath: reversalRel,
      content: reversalContent,
    });

    sendJson(res, 200, {
      ok: true,
      reversed_path: reversalRel,
      reversed_at: reversedAt,
      vault_patch_applied: vaultPatchApplied,
      plane_revert_applied: planeRevertApplied,
    });
  });

  // POST /api/v1/steward/confirm/:action_id  (#839 Phase 3)
  //
  // Promote a pending-confirmation Steward action to a full live
  // action. Pre-conditions:
  //
  //   1. Audit record exists + is mode=live + pending_confirmation=true.
  //   2. Action hasn't been confirmed yet (no follow-up record on
  //      disk).
  //   3. Undo window hasn't expired.
  //
  // Side effects (atomic from the operator's POV — failures surface
  // as 502 + the original audit record stays untouched so a retry can
  // re-run cleanly):
  //
  //   a. Read the prior task frontmatter to capture plane_issue_id +
  //      parent_matter (then plane_project_id) — same path
  //      apply_state_change(live) takes.
  //   b. Call ``postStewardAction`` to comment + transition Plane.
  //   c. Patch the task vault frontmatter: clear pending_confirmation,
  //      apply the decision-implied state, stamp last_steward_outcome
  //      with mode="live" and the new comment id.
  //   d. Write a follow-up audit record
  //      ``event/steward-action-confirmed-<actionId>.md`` carrying the
  //      undo_recipe so the dashboard can still reverse the now-live
  //      action via the existing /undo path.
  addRoute(
    "POST",
    "/api/v1/steward/confirm/:action_id",
    async ({ res, params }) => {
      const actionId = (params.action_id || "").trim();
      if (!actionId) {
        throw new ValidationError("action_id is required");
      }
      if (
        actionId.includes("..") ||
        actionId.includes("/") ||
        actionId.includes("\\")
      ) {
        throw new ValidationError("action_id contains invalid characters");
      }

      const auditRel = `event/${STEWARD_ACTION_PREFIX}${actionId}.md`;
      const auditFull = path.resolve(VAULT_PATH, auditRel);
      if (!auditFull.startsWith(path.resolve(VAULT_PATH) + path.sep)) {
        throw new ValidationError("action_id resolves outside the vault");
      }

      const record = loadActionRecord(auditRel);
      if (!record) {
        throw new NotFoundError(`Steward action not found: ${actionId}`);
      }

      // Confirm only makes sense on a pending-confirmation live record.
      // Shadow records have no Plane action to fire; non-pending live
      // records already fired their action.
      if (record.mode !== "live") {
        throw new ValidationError(
          "shadow actions cannot be confirmed (no Plane action would fire)",
        );
      }
      if (!record.pending_confirmation) {
        throw new ValidationError(
          "this action is not pending confirmation — it either fired live already or is a shadow record",
        );
      }

      // Window check.
      const expiresMs = parseTs(record.undo_recipe.expires_at);
      if (expiresMs === null) {
        throw new ApiError(
          500,
          "STEWARD_CONFIRM_INVALID",
          "audit record is missing undo_recipe.expires_at",
        );
      }
      if (Date.now() >= expiresMs) {
        throw new ApiError(
          410,
          "STEWARD_CONFIRM_EXPIRED",
          "confirm window expired",
        );
      }

      // Idempotency: existing follow-up record means a confirm or
      // dismiss has already landed. Refuse to fire a second time.
      const followUpRel = followUpPathFor(actionId, "confirmed");
      if (fs.existsSync(path.resolve(VAULT_PATH, followUpRel))) {
        throw new ConflictError("already confirmed");
      }
      const dismissedRel = followUpPathFor(actionId, "dismissed");
      if (fs.existsSync(path.resolve(VAULT_PATH, dismissedRel))) {
        throw new ConflictError("already dismissed; cannot confirm");
      }
      if (reversalAlreadyExists(actionId)) {
        throw new ConflictError("already reversed");
      }

      // Read the target task frontmatter so we know plane_issue_id +
      // parent_matter. We don't go through alfred-learn for this — the
      // CLI's read path is sync and avoids the Temporal round-trip.
      const targetRel = (record.target || "").replace(/^\.\//, "");
      if (!targetRel) {
        throw new ApiError(
          500,
          "STEWARD_CONFIRM_INVALID",
          "audit record has no target",
        );
      }
      const taskRec = readRecord(targetRel);
      if (!taskRec) {
        throw new ApiError(
          404,
          "STEWARD_CONFIRM_TARGET_MISSING",
          `target task missing: ${targetRel}`,
        );
      }
      const taskFm = taskRec.fm;
      const planeIssueId = String(taskFm.plane_issue_id || "").trim();
      const parentMatterRaw = String(taskFm.parent_matter || "").trim();
      const parentMatter = parentMatterRaw
        ? normaliseMatterPath(parentMatterRaw)
        : "";
      let projectId = "";
      if (parentMatter) {
        const matterRec = readRecord(parentMatter);
        if (matterRec) {
          projectId = String(matterRec.fm.plane_project_id || "").trim();
        }
      }

      // Plane post — the actual confirmation step. We bump confidence
      // to 1.0 for the new comment so it reads "Auto-update by Alfred
      // (..., confidence 100%)" — this distinguishes the confirmed
      // version from the original pending one in the Plane comment
      // history.
      let planeResult: Awaited<ReturnType<typeof postStewardAction>> | null =
        null;
      let planePartialReason: string | null = null;
      const decisionRequiresPlane =
        record.decision === "likely_done" ||
        record.decision === "stale_archive_candidate";
      if (decisionRequiresPlane && planeIssueId && projectId) {
        try {
          planeResult = await postStewardAction(
            planeIssueId,
            record.decision,
            1.0,
            record.evidence,
            record.path,
            projectId,
          );
        } catch (err) {
          const e = err as { message?: string };
          // Don't fail the whole confirm — the operator opted in, we'll
          // record the partial-applied flag on the follow-up record so
          // the dashboard can surface "confirmed but Plane errored".
          planePartialReason = `plane_post_failed: ${e.message ?? String(err)}`;
          console.warn(
            `[steward.confirm] plane_post_failed action=${actionId}: ${e.message ?? String(err)}`,
          );
        }
      } else if (decisionRequiresPlane) {
        planePartialReason = !planeIssueId
          ? "task_has_no_plane_issue_id"
          : "matter_has_no_plane_project_id";
      }

      // Patch vault frontmatter: clear pending_confirmation, apply the
      // implied state, stamp the new outcome.
      const nowIso = new Date().toISOString();
      const scalarSet: Record<string, string> = {
        pending_confirmation: "false",
        last_steward_check_at: nowIso,
      };
      if (record.decision === "likely_done") {
        scalarSet.state = "done";
      } else if (record.decision === "stale_archive_candidate") {
        scalarSet.state = "archived";
      }

      const cleanTarget = targetRel;
      const args = [...ALFRED_CMD, "vault", "edit", cleanTarget];
      for (const [k, v] of Object.entries(scalarSet)) {
        args.push("--set", `${k}=${v}`);
      }
      let vaultPatchApplied = false;
      try {
        await dockerExec("alfred", args, VAULT_ENV);
        vaultPatchApplied = true;
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        throw new ApiError(
          500,
          "STEWARD_CONFIRM_VAULT_PATCH_FAILED",
          `vault patch failed: ${e.message ?? String(err)}`,
          {
            stderr: (e.stderr ?? "").slice(0, 500),
            target: cleanTarget,
          },
        );
      }

      // Write the follow-up audit record. Carries an undo_recipe so
      // the dashboard's existing /undo route can reverse the confirmed
      // action (we wire this by writing a fresh steward-action record
      // — the /undo handler keys off the file's audit_id slug, not the
      // confirmed-prefix).
      const followUpFull = path.resolve(VAULT_PATH, followUpRel);
      const reverseRecipe = {
        vault_patch: {
          target: cleanTarget,
          set: {
            // Restore the prior pending_confirmation flag so a
            // reverse-undo of a confirmed action lands the task back
            // in its pre-confirmation state (still pending review).
            pending_confirmation: true,
            // Restore prior state. We try the audit record's
            // recorded prior_state; fallback "open" if blank.
            state:
              (record.undo_recipe.vault_patch?.set?.state as
                | string
                | undefined) || "open",
          },
        },
        plane_revert: planeResult
          ? {
              issue_id: planeIssueId,
              project_id: projectId,
              delete_comment_id: planeResult.comment_id,
              restore_state: planeResult.prior_state_id,
              restore_archived: planeResult.prior_archived,
            }
          : null,
        expires_at: new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      };
      await fs.promises.mkdir(path.dirname(followUpFull), { recursive: true });
      const followUpContent = renderConfirmedRecord({
        actionId,
        confirmedAt: nowIso,
        auditPath: record.path,
        target: cleanTarget,
        decision: record.decision,
        vaultPatchApplied,
        planeAction: planeResult,
        planePartialReason,
        reverseRecipe,
      });
      try {
        await fs.promises.writeFile(followUpFull, followUpContent, {
          flag: "wx",
        });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "EEXIST") {
          throw new ConflictError("already confirmed");
        }
        throw err;
      }
      // STORE-P1-3: index the new confirm follow-up audit row.
      syncVaultIndexFromContent({
        vaultPath: VAULT_PATH,
        relPath: followUpRel,
        content: followUpContent,
      });

      sendJson(res, 200, {
        ok: true,
        confirmed_path: followUpRel,
        confirmed_at: nowIso,
        vault_patch_applied: vaultPatchApplied,
        plane_action: planeResult,
        partially_applied: !!planePartialReason,
        partially_applied_reason: planePartialReason,
      });
    },
  );

  // POST /api/v1/steward/dismiss/:action_id  (#839 Phase 3)
  //
  // Dismiss a pending-confirmation Steward action — the inverse
  // operation of confirm. Pre-conditions identical to confirm; side
  // effects:
  //
  //   a. Patch task vault frontmatter: clear pending_confirmation
  //      (and ONLY that field — state is left untouched, since the
  //      operator declined the suggestion).
  //   b. Write a follow-up audit record
  //      ``event/steward-action-dismissed-<actionId>.md`` so the
  //      dashboard timeline shows the override.
  addRoute(
    "POST",
    "/api/v1/steward/dismiss/:action_id",
    async ({ res, params }) => {
      const actionId = (params.action_id || "").trim();
      if (!actionId) {
        throw new ValidationError("action_id is required");
      }
      if (
        actionId.includes("..") ||
        actionId.includes("/") ||
        actionId.includes("\\")
      ) {
        throw new ValidationError("action_id contains invalid characters");
      }

      const auditRel = `event/${STEWARD_ACTION_PREFIX}${actionId}.md`;
      const auditFull = path.resolve(VAULT_PATH, auditRel);
      if (!auditFull.startsWith(path.resolve(VAULT_PATH) + path.sep)) {
        throw new ValidationError("action_id resolves outside the vault");
      }

      const record = loadActionRecord(auditRel);
      if (!record) {
        throw new NotFoundError(`Steward action not found: ${actionId}`);
      }
      if (record.mode !== "live") {
        throw new ValidationError(
          "shadow actions cannot be dismissed (nothing was pending)",
        );
      }
      if (!record.pending_confirmation) {
        throw new ValidationError(
          "this action is not pending confirmation",
        );
      }

      const expiresMs = parseTs(record.undo_recipe.expires_at);
      if (expiresMs === null) {
        throw new ApiError(
          500,
          "STEWARD_DISMISS_INVALID",
          "audit record is missing undo_recipe.expires_at",
        );
      }
      if (Date.now() >= expiresMs) {
        throw new ApiError(
          410,
          "STEWARD_DISMISS_EXPIRED",
          "dismiss window expired",
        );
      }

      const followUpRel = followUpPathFor(actionId, "dismissed");
      if (fs.existsSync(path.resolve(VAULT_PATH, followUpRel))) {
        throw new ConflictError("already dismissed");
      }
      const confirmedRel = followUpPathFor(actionId, "confirmed");
      if (fs.existsSync(path.resolve(VAULT_PATH, confirmedRel))) {
        throw new ConflictError("already confirmed; cannot dismiss");
      }

      const targetRel = (record.target || "").replace(/^\.\//, "");
      if (!targetRel) {
        throw new ApiError(
          500,
          "STEWARD_DISMISS_INVALID",
          "audit record has no target",
        );
      }

      // Patch the task: clear pending_confirmation only.
      const args = [
        ...ALFRED_CMD,
        "vault",
        "edit",
        targetRel,
        "--set",
        "pending_confirmation=false",
      ];
      let vaultPatchApplied = false;
      try {
        await dockerExec("alfred", args, VAULT_ENV);
        vaultPatchApplied = true;
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        throw new ApiError(
          500,
          "STEWARD_DISMISS_VAULT_PATCH_FAILED",
          `vault patch failed: ${e.message ?? String(err)}`,
          {
            stderr: (e.stderr ?? "").slice(0, 500),
            target: targetRel,
          },
        );
      }

      const dismissedAt = new Date().toISOString();
      const followUpFull = path.resolve(VAULT_PATH, followUpRel);
      await fs.promises.mkdir(path.dirname(followUpFull), { recursive: true });
      const followUpContent = renderDismissedRecord({
        actionId,
        dismissedAt,
        auditPath: record.path,
        target: targetRel,
        decision: record.decision,
        vaultPatchApplied,
      });
      try {
        await fs.promises.writeFile(followUpFull, followUpContent, {
          flag: "wx",
        });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "EEXIST") {
          throw new ConflictError("already dismissed");
        }
        throw err;
      }
      // STORE-P1-3: index the new dismiss follow-up audit row.
      syncVaultIndexFromContent({
        vaultPath: VAULT_PATH,
        relPath: followUpRel,
        content: followUpContent,
      });

      sendJson(res, 200, {
        ok: true,
        dismissed_path: followUpRel,
        dismissed_at: dismissedAt,
        vault_patch_applied: vaultPatchApplied,
      });
    },
  );
}

/** Construct a confirmed/dismissed follow-up record path. */
function followUpPathFor(
  actionId: string,
  kind: "confirmed" | "dismissed",
): string {
  return `event/${STEWARD_ACTION_PREFIX}${kind}-${actionId}.md`;
}

/** Normalise a matter ref to ``matter/<slug>.md`` form. */
function normaliseMatterPath(raw: string): string {
  let s = raw.trim();
  if (!s) return "";
  if (s.startsWith("[[") && s.endsWith("]]")) {
    s = s.slice(2, -2);
  }
  if (!s.startsWith("matter/")) {
    s = `matter/${s}`;
  }
  if (!s.endsWith(".md")) {
    s = `${s}.md`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Reversal-record rendering
// ---------------------------------------------------------------------------

function yamlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function renderReversalRecord(args: {
  actionId: string;
  reversedAt: string;
  auditPath: string;
  target: string;
  decision: string;
  vaultPatchApplied: boolean;
  planeRevertApplied: boolean;
  reversedBy: string;
}): string {
  const lines: string[] = [
    "---",
    'type: steward-action-reversed',
    `timestamp: "${yamlEscape(args.reversedAt)}"`,
    `action_id: "${yamlEscape(args.actionId)}"`,
    `reverses: "${yamlEscape(args.auditPath)}"`,
    `target: "${yamlEscape(args.target)}"`,
    `original_decision: "${yamlEscape(args.decision)}"`,
    `reversed_by: "${yamlEscape(args.reversedBy)}"`,
    `vault_patch_applied: ${args.vaultPatchApplied ? "true" : "false"}`,
    `plane_revert_applied: ${args.planeRevertApplied ? "true" : "false"}`,
    "---",
    "",
    `# Steward action reversed: ${args.actionId}`,
    "",
    `Reverted on ${args.reversedAt} via dashboard undo. Original audit ` +
      `record: \`${args.auditPath}\`. Target: \`${args.target}\`. ` +
      `Original decision: **${args.decision}**.`,
    "",
    args.vaultPatchApplied
      ? "Vault frontmatter was reverted to its prior state via the embedded undo_recipe.vault_patch."
      : "No vault patch was applied (recipe carried no vault_patch or it was empty).",
    "",
    args.planeRevertApplied
      ? "Plane comment + state transition were reverted via the embedded undo_recipe.plane_revert."
      : "No Plane revert was applied (Phase 0.5 audit records always carry plane_revert: null).",
    "",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Confirmed / dismissed follow-up record rendering (#839 Phase 3)
// ---------------------------------------------------------------------------

function renderConfirmedRecord(args: {
  actionId: string;
  confirmedAt: string;
  auditPath: string;
  target: string;
  decision: string;
  vaultPatchApplied: boolean;
  planeAction: object | null;
  planePartialReason: string | null;
  reverseRecipe: Record<string, unknown>;
}): string {
  // Frontmatter is JSON-as-YAML for consistency with apply_state_change
  // — see _render_audit_yaml in the Python side for the rationale.
  const lines: string[] = [
    "---",
    "type: steward-action-confirmed",
    `timestamp: "${yamlEscape(args.confirmedAt)}"`,
    `action_id: "${yamlEscape(args.actionId)}"`,
    `confirms: "${yamlEscape(args.auditPath)}"`,
    `target: "${yamlEscape(args.target)}"`,
    `original_decision: "${yamlEscape(args.decision)}"`,
    "confirmed_by: \"dashboard-confirm\"",
    `vault_patch_applied: ${args.vaultPatchApplied ? "true" : "false"}`,
    `plane_action: ${JSON.stringify(args.planeAction ?? null)}`,
    `partially_applied: ${args.planePartialReason ? "true" : "false"}`,
    `partially_applied_reason: ${
      args.planePartialReason
        ? `"${yamlEscape(args.planePartialReason)}"`
        : "null"
    }`,
    `undo_recipe: ${JSON.stringify(args.reverseRecipe)}`,
    "---",
    "",
    `# Steward action confirmed: ${args.actionId}`,
    "",
    `Confirmed on ${args.confirmedAt} via dashboard. Original ` +
      `pending-confirmation audit record: \`${args.auditPath}\`. Target: ` +
      `\`${args.target}\`. Decision: **${args.decision}**.`,
    "",
    args.vaultPatchApplied
      ? "Vault frontmatter was patched to clear pending_confirmation and apply the decision-implied state."
      : "Vault patch did not apply — see the error response.",
    "",
    args.planeAction
      ? "Plane comment posted and state transitioned. Reverse via dashboard Undo."
      : args.planePartialReason
        ? `Plane action skipped: ${args.planePartialReason}. The vault patch still applied.`
        : "No Plane action was required for this decision.",
    "",
  ];
  return lines.join("\n");
}

function renderDismissedRecord(args: {
  actionId: string;
  dismissedAt: string;
  auditPath: string;
  target: string;
  decision: string;
  vaultPatchApplied: boolean;
}): string {
  const lines: string[] = [
    "---",
    "type: steward-action-dismissed",
    `timestamp: "${yamlEscape(args.dismissedAt)}"`,
    `action_id: "${yamlEscape(args.actionId)}"`,
    `dismisses: "${yamlEscape(args.auditPath)}"`,
    `target: "${yamlEscape(args.target)}"`,
    `original_decision: "${yamlEscape(args.decision)}"`,
    'dismissed_by: "dashboard-dismiss"',
    `vault_patch_applied: ${args.vaultPatchApplied ? "true" : "false"}`,
    "---",
    "",
    `# Steward action dismissed: ${args.actionId}`,
    "",
    `Dismissed on ${args.dismissedAt} via dashboard. Original ` +
      `pending-confirmation audit record: \`${args.auditPath}\`. Target: ` +
      `\`${args.target}\`. Decision: **${args.decision}**.`,
    "",
    "The task was patched to clear pending_confirmation. No Plane " +
      "action was taken — Steward's suggestion was overridden.",
    "",
  ];
  return lines.join("\n");
}
