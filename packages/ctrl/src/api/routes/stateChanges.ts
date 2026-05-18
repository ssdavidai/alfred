// State-mutation contract endpoints (#889, spec §5).
//
// Every mutation to a matter or task state field flows through
// POST /api/v1/state-changes. Direct PATCH of state fields is gated by
// STATE_CHANGE_ENFORCEMENT (see routes/vault.ts) — this route is the
// canonical path.
//
// One POST produces three artefacts atomically under a per-process
// vault-write mutex:
//   1. Target frontmatter patch (only state fields).
//   2. Append a `state_change` entry to target.frontmatter.timeline.
//   3. Write `event/state-change-<iso-ts>-<source-slug>-<target-slug>.md`
//      with the full undo recipe + observed-window paths + before/after
//      diff per spec §4.4.
//
// GET endpoints (spec §5.3, §11.1):
//   * GET /api/v1/state-changes              — paginated cross-target feed
//   * GET /api/v1/state-changes/sources      — 30-day source histogram

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import yaml from "js-yaml";
import { addRoute } from "../server.js";
import {
  sendJson,
  ValidationError,
  NotFoundError,
  ConflictError,
} from "../errors.js";
import {
  VAULT_PATH,
  walkMd,
  readRecord,
  IGNORE_DIRS,
  resolveVaultPath,
  emitVaultEditSignal,
} from "./vault.js";
import { vaultWalkCache } from "../vaultCache.js";
import {
  classifyTarget,
  stateFieldsFor,
  type StateFieldTarget,
} from "../stateFields.js";

// ---------------------------------------------------------------------------
// Source identifier regex (spec §5.1 step 3).
//
// Dotted identifier: lowercase letter start, lowercase/digit/underscore
// segments separated by dots, at least one dot required. Forces a
// namespace.action shape so the /sources histogram is meaningful.
//
// Segments AFTER the first dot may also contain ASCII hyphens — this is
// the minimal widening required by Phase F (#894) to admit
// `manual.<wasp-user-id>` where Wasp's `User.id` is a lowercase UUID v4
// (e.g. `8a3c1d2e-4b5f-49a7-9c10-7d8e2c1f0a4b`). Hyphens are still
// path-injection-safe: they can't introduce `/`, `\`, `.`, or `..` into
// the file path because the slug builder in `slugForSource` replaces
// dots with hyphens and otherwise only retains `[a-z0-9_-]`. Hyphens
// remain disallowed in the namespace prefix to keep identifiers like
// `briefing.morning` canonical (no `brief-ing.morning`).
//
// Examples that match:
//   briefing.morning
//   steward.evaluate_task
//   decision_router.promote
//   manual.user123
//   manual.8a3c1d2e-4b5f-49a7-9c10-7d8e2c1f0a4b
//   chore_actions.recompute_health
// Examples that reject:
//   STEWARD              (uppercase + no dot)
//   foo                  (no dot)
//   .foo                 (leading dot)
//   foo.                 (trailing dot)
//   manual.UPPER         (uppercase segment)
//   foo-bar.baz          (hyphen in the prefix segment)
// ---------------------------------------------------------------------------
const SOURCE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)+$/;

// Per-target ulid id length (Crockford-base32, 26 chars). Same encoding
// as the canonical `ulid` package — first 10 chars are the millisecond
// timestamp, last 16 are randomness. Generated inline rather than
// pulling a dep; ctrl-api ships zero-runtime-dep on purpose.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateUlid(now: number = Date.now()): string {
  let timePart = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  const randBytes = crypto.randomBytes(10);
  let randPart = "";
  // Encode 10 bytes (80 bits) as 16 Crockford chars. We pack the 80 bits
  // as a BigInt to avoid hand-rolling carry logic.
  let acc = 0n;
  for (const b of randBytes) {
    acc = (acc << 8n) | BigInt(b);
  }
  for (let i = 0; i < 16; i++) {
    randPart = CROCKFORD[Number(acc & 31n)] + randPart;
    acc >>= 5n;
  }
  return timePart + randPart;
}

// ---------------------------------------------------------------------------
// Vault-root write mutex.
//
// ctrl-api runs one process per tenant, so a single in-process Mutex
// serialises every state-change POST. Lock hold time is small (three
// file writes); contention is rare per spec §9.3.
// ---------------------------------------------------------------------------

let _vaultLockTail: Promise<unknown> = Promise.resolve();

async function withVaultLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = _vaultLockTail;
  let release: () => void;
  const current = new Promise<void>((r) => {
    release = r;
  });
  _vaultLockTail = previous.then(() => current, () => current);
  try {
    await previous;
  } catch {
    // Swallow upstream errors — the previous holder already failed
    // its own caller; we proceed regardless.
  }
  try {
    return await fn();
  } finally {
    release!();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function slugForSource(source: string): string {
  return source.replace(/\./g, "-").replace(/[^a-z0-9_-]/g, "");
}

function slugForTarget(targetPath: string): string {
  const norm = targetPath.replace(/\\/g, "/");
  const base = norm.split("/").pop() ?? norm;
  return base.replace(/\.md$/, "");
}

function isoForFilename(ts: string): string {
  // 2026-05-13T07:00:14.123Z → 2026-05-13T070014
  // Filesystem-safe + sortable. Drops millis + colons.
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return ts.replace(/[^0-9A-Za-z-]/g, "");
  return `${m[1]}T${m[2]}${m[3]}${m[4]}`;
}

interface ObservedWindowIn {
  start: string;
  end: string;
  signal_paths?: unknown;
  decision_paths?: unknown;
  other_refs?: unknown;
}

interface StateChangePostBody {
  target_path?: unknown;
  source?: unknown;
  expected_as_of?: unknown;
  observed_window?: unknown;
  fields?: unknown;
  reason?: unknown;
  confidence?: unknown;
  mode?: unknown;
  undo_recipe?: unknown;
}

interface TimelineEntry {
  when: string;
  kind: "state_change";
  id: string;
  source: string;
  prior_as_of: string | null;
  observed_window: {
    start: string;
    end: string;
    signals: number;
    decisions: number;
    other: string[];
  };
  changes: Record<string, { changed: boolean; from?: unknown; to?: unknown; prior_len?: number; new_len?: number }>;
  reason: string;
  confidence: number;
  mode: "shadow" | "live";
  audit_record: string;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string" && v) out.push(v);
  }
  return out;
}

function parseFrontmatterRaw(content: string): { fm: Record<string, unknown>; body: string; hadFm: boolean } {
  if (!content.startsWith("---")) {
    return { fm: {}, body: content, hadFm: false };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { fm: {}, body: content, hadFm: false };
  }
  const yamlBlock = content.slice(4, end);
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  const parsed = yaml.load(yamlBlock, { schema: yaml.DEFAULT_SCHEMA });
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { fm: parsed as Record<string, unknown>, body, hadFm: true };
  }
  return { fm: {}, body, hadFm: true };
}

function rewriteRecordFile(fullPath: string, fm: Record<string, unknown>, body: string): void {
  const newYaml = yaml.dump(fm, {
    schema: yaml.DEFAULT_SCHEMA,
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });
  const yamlClean = newYaml.endsWith("\n") ? newYaml.slice(0, -1) : newYaml;
  const bodyPart = body.startsWith("\n") ? body : body ? "\n" + body : "";
  const rewritten = "---\n" + yamlClean + "\n---\n" + bodyPart;
  fs.writeFileSync(fullPath, rewritten, "utf-8");
}

function summarizeFieldChange(prior: unknown, next: unknown): { changed: boolean; from?: unknown; to?: unknown; prior_len?: number; new_len?: number } {
  // Long string fields (current_state) get length-only summary in the
  // timeline (full diff in the audit record per spec §4.3).
  if (typeof prior === "string" && typeof next === "string" && (prior.length > 80 || next.length > 80)) {
    return {
      changed: prior !== next,
      prior_len: prior.length,
      new_len: next.length,
    };
  }
  const changed = prior === undefined ? next !== undefined : prior !== next;
  return { changed, from: prior ?? null, to: next };
}

function renderAuditYaml(payload: Record<string, unknown>): string {
  const dumped = yaml.dump(payload, {
    schema: yaml.DEFAULT_SCHEMA,
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });
  return dumped.endsWith("\n") ? dumped.slice(0, -1) : dumped;
}

// ---------------------------------------------------------------------------
// Index walker for GET /state-changes.
//
// Cached through vaultWalkCache (3s TTL) — every state_change entry on
// every matter/task timeline is read into a flat list. Filtered/paginated
// at the route level.
// ---------------------------------------------------------------------------

interface IndexedStateChange {
  target_path: string;
  when: string;
  id: string;
  source: string;
  prior_as_of: string | null;
  observed_window: TimelineEntry["observed_window"];
  changes: TimelineEntry["changes"];
  reason: string;
  confidence: number;
  mode: "shadow" | "live";
  audit_record: string;
}

function indexAllStateChanges(): IndexedStateChange[] {
  const files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
  const out: IndexedStateChange[] = [];
  for (const relPath of files) {
    const display = relPath.replace(/\\/g, "/");
    if (!display.startsWith("matter/") && !display.startsWith("task/")) continue;
    const rec = readRecord(relPath);
    if (!rec) continue;
    const tl = rec.fm.timeline;
    if (!Array.isArray(tl)) continue;
    for (const entry of tl) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      if (String(e.kind ?? "") !== "state_change") continue;
      const when = String(e.when ?? "");
      if (!when) continue;
      const ow = (e.observed_window ?? {}) as Record<string, unknown>;
      const otherRaw = ow.other;
      const observed_window = {
        start: String(ow.start ?? ""),
        end: String(ow.end ?? when),
        signals: typeof ow.signals === "number" ? ow.signals : 0,
        decisions: typeof ow.decisions === "number" ? ow.decisions : 0,
        other: Array.isArray(otherRaw) ? otherRaw.map(String) : [],
      };
      const changes =
        e.changes && typeof e.changes === "object" && !Array.isArray(e.changes)
          ? (e.changes as TimelineEntry["changes"])
          : {};
      const mode = e.mode === "live" ? "live" : "shadow";
      const confidence =
        typeof e.confidence === "number" && Number.isFinite(e.confidence)
          ? e.confidence
          : 1.0;
      out.push({
        target_path: display,
        when,
        id: String(e.id ?? ""),
        source: String(e.source ?? ""),
        prior_as_of:
          typeof e.prior_as_of === "string" && e.prior_as_of
            ? (e.prior_as_of as string)
            : null,
        observed_window,
        changes,
        reason: String(e.reason ?? ""),
        confidence,
        mode,
        audit_record: String(e.audit_record ?? ""),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerStateChangeRoutes(): void {
  // POST /api/v1/state-changes (spec §5.1)
  addRoute("POST", "/api/v1/state-changes", async ({ res, body }) => {
    const b = (body ?? {}) as StateChangePostBody;

    // 1. target_path validation
    if (typeof b.target_path !== "string" || !b.target_path) {
      throw new ValidationError("target_path is required");
    }
    const targetPath = b.target_path.replace(/\\/g, "/");
    const targetKind = classifyTarget(targetPath);
    if (!targetKind) {
      throw new ValidationError(
        `target_path must be matter/*.md or task/*.md (got ${b.target_path})`,
      );
    }
    const absTargetPath = resolveVaultPath(targetPath);
    if (!fs.existsSync(absTargetPath)) {
      throw new NotFoundError(`target not found: ${targetPath}`);
    }

    // 2. source regex
    if (typeof b.source !== "string" || !SOURCE_RE.test(b.source)) {
      throw new ValidationError(
        `source must match ${SOURCE_RE.source} (got ${JSON.stringify(b.source)})`,
      );
    }
    const source = b.source;

    // 3. fields allowlist
    if (!b.fields || typeof b.fields !== "object" || Array.isArray(b.fields)) {
      throw new ValidationError("fields object is required");
    }
    const fields = b.fields as Record<string, unknown>;
    const allow = new Set(stateFieldsFor(targetKind));
    for (const k of Object.keys(fields)) {
      if (!allow.has(k)) {
        throw new ValidationError(
          `field '${k}' is not a declared state field for ${targetKind}. ` +
            `Allowed: ${[...allow].join(", ")}`,
        );
      }
    }
    if (Object.keys(fields).length === 0) {
      throw new ValidationError("fields must not be empty");
    }

    // 4. observed_window
    if (
      !b.observed_window ||
      typeof b.observed_window !== "object" ||
      Array.isArray(b.observed_window)
    ) {
      throw new ValidationError("observed_window is required");
    }
    const owIn = b.observed_window as ObservedWindowIn;
    if (typeof owIn.start !== "string" || typeof owIn.end !== "string") {
      throw new ValidationError("observed_window.start and observed_window.end are required ISO strings");
    }

    // 5. reason / mode / confidence
    const reason = typeof b.reason === "string" ? b.reason : "";
    const mode: "shadow" | "live" = b.mode === "live" ? "live" : "shadow";
    let confidence = 1.0;
    if (typeof b.confidence === "number" && Number.isFinite(b.confidence)) {
      if (b.confidence < 0 || b.confidence > 1) {
        throw new ValidationError("confidence must be in [0.0, 1.0]");
      }
      confidence = b.confidence;
    }

    const undoRecipe = b.undo_recipe && typeof b.undo_recipe === "object" && !Array.isArray(b.undo_recipe)
      ? (b.undo_recipe as Record<string, unknown>)
      : null;

    const signalPaths = asStringArray(owIn.signal_paths);
    const decisionPaths = asStringArray(owIn.decision_paths);
    const otherRefs = asStringArray(owIn.other_refs);

    // 6. Atomic three-artefact write under the vault mutex.
    const result = await withVaultLock(async () => {
      // Read target as-of-now for optimistic concurrency.
      const raw = fs.readFileSync(absTargetPath, "utf-8");
      const { fm, body: targetBody, hadFm } = parseFrontmatterRaw(raw);
      if (!hadFm) {
        throw new ValidationError(
          `target ${targetPath} has no frontmatter — refusing to mutate`,
        );
      }
      const currentAsOf =
        typeof fm.as_of === "string" && fm.as_of ? fm.as_of : null;
      const expectedRaw = b.expected_as_of;
      const expectedAsOf =
        typeof expectedRaw === "string" && expectedRaw ? expectedRaw : null;
      if (expectedAsOf !== null && currentAsOf !== expectedAsOf) {
        throw new ConflictError(
          `as_of mismatch: target current_as_of=${currentAsOf ?? "null"} expected_as_of=${expectedAsOf}`,
        );
      }
      const priorAsOf = currentAsOf;

      // Compose per-field change summary for timeline + audit.
      const priorValues: Record<string, unknown> = {};
      const changesSummary: TimelineEntry["changes"] = {};
      const auditChanges: Record<string, Record<string, unknown>> = {};
      for (const k of Object.keys(fields)) {
        const prior = fm[k];
        const next = fields[k];
        priorValues[k] = prior ?? null;
        changesSummary[k] = summarizeFieldChange(prior, next);
        // Audit record carries full prior+new values (no length-only
        // truncation) per spec §4.4.
        auditChanges[k] = { from: prior ?? null, to: next ?? null };
      }

      const newAsOf =
        typeof fields.as_of === "string" && fields.as_of
          ? (fields.as_of as string)
          : owIn.end;
      const whenIso = newAsOf;
      const ulid = generateUlid();
      const sourceSlug = slugForSource(source);
      const targetSlug = slugForTarget(targetPath);
      const auditName = `state-change-${isoForFilename(whenIso)}-${sourceSlug}-${targetSlug}`;
      const auditRelPath = `event/${auditName}.md`;

      // 6a. Merge state fields into target frontmatter.
      const nextFm = { ...fm };
      for (const [k, v] of Object.entries(fields)) {
        nextFm[k] = v;
      }
      // Always stamp as_of to the observed-window end (per spec §4.2),
      // unless the caller passed an explicit as_of in fields.
      if (!("as_of" in fields)) {
        nextFm.as_of = owIn.end;
      }

      // 6b. Append the state_change timeline entry.
      const timelineEntry: TimelineEntry = {
        when: whenIso,
        kind: "state_change",
        id: ulid,
        source,
        prior_as_of: priorAsOf,
        observed_window: {
          start: owIn.start,
          end: owIn.end,
          signals: signalPaths.length,
          decisions: decisionPaths.length,
          other: otherRefs,
        },
        changes: changesSummary,
        reason,
        confidence,
        mode,
        audit_record: auditRelPath,
      };
      const existingTimeline = Array.isArray(nextFm.timeline)
        ? (nextFm.timeline as unknown[])
        : [];
      nextFm.timeline = [...existingTimeline, timelineEntry];

      // 6c. Write the audit record. We compose first so a YAML serialise
      // failure aborts before we touch the target.
      const auditPayload: Record<string, unknown> = {
        record_type: "event",
        event_type: "state_change",
        target_kind: targetKind,
        target_path: targetPath,
        source,
        when: whenIso,
        mode,
        effective_mode: mode,
        confidence,
        prior_as_of: priorAsOf,
        observed_window: {
          start: owIn.start,
          end: owIn.end,
          signal_paths: signalPaths,
          decision_paths: decisionPaths,
          other_refs: otherRefs,
        },
        changes: auditChanges,
        timeline_entry_id: ulid,
      };
      if (undoRecipe) {
        auditPayload.undo_recipe = undoRecipe;
      }

      // Shadow mode: audit ONLY. No frontmatter patch, no timeline append.
      // This matches Steward Phase 0.5 (steward.py:9) precedent — "In mode=shadow
      // it writes one event/steward-action-*.md" — and spec §4.5: sub-threshold
      // and shadow writes preserve the target as-is.
      const isShadow = mode === "shadow";
      if (isShadow) {
        // Null out the timeline_entry_id in the audit payload so the audit
        // record doesn't reference a timeline entry that doesn't exist.
        auditPayload.timeline_entry_id = null;
      }

      const auditYaml = renderAuditYaml(auditPayload);
      const narrativeLines = [
        `# State change: ${source} on ${targetPath}`,
        "",
        reason || "_(no reason supplied)_",
      ];
      if (isShadow) {
        narrativeLines.push(
          "",
          "Mode is `shadow` — this audit record reflects what a live-mode " +
            "cutover would have applied. Target frontmatter is unchanged.",
        );
      }
      const auditContent =
        "---\n" + auditYaml + "\n---\n\n" + narrativeLines.join("\n") + "\n";

      const auditFullDir = path.resolve(VAULT_PATH, "event");
      fs.mkdirSync(auditFullDir, { recursive: true });
      const auditFullPath = path.resolve(auditFullDir, `${auditName}.md`);

      if (!isShadow) {
        // Live: patch target frontmatter (with appended timeline entry), then
        // write audit. Both inside the vault-mutex critical section; a crash
        // between leaves a dangling timeline ref recoverable by
        // vault_integrity_check (spec §9.3). Target first ensures readers see
        // the bumped as_of before the audit pointer.
        rewriteRecordFile(absTargetPath, nextFm, targetBody);
        fs.writeFileSync(auditFullPath, auditContent, "utf-8");
        emitVaultEditSignal(targetPath, "edit");
        emitVaultEditSignal(auditRelPath, "create");
      } else {
        // Shadow: audit only. Target untouched.
        fs.writeFileSync(auditFullPath, auditContent, "utf-8");
        emitVaultEditSignal(auditRelPath, "create");
      }

      return {
        audit_record_path: auditRelPath,
        timeline_entry_id: isShadow ? null : ulid,
        new_as_of: isShadow ? priorAsOf : String(nextFm.as_of ?? owIn.end),
      };
    });

    sendJson(res, 200, result);
  });

  // GET /api/v1/state-changes (spec §5.3)
  addRoute("GET", "/api/v1/state-changes", async ({ res, query }) => {
    const target = query.get("target");
    const source = query.get("source");
    const since = query.get("since");
    const until = query.get("until");
    const limitRaw = query.get("limit");
    const offsetRaw = query.get("offset");
    const limit = Math.min(
      Math.max(1, parseInt(limitRaw ?? "50", 10) || 50),
      200,
    );
    const offset = Math.max(0, parseInt(offsetRaw ?? "0", 10) || 0);

    const cacheKey = `state-changes:${target ?? ""}:${source ?? ""}:${since ?? ""}:${until ?? ""}`;
    const all = (await vaultWalkCache.get(cacheKey, () => indexAllStateChanges())) as IndexedStateChange[];

    const filtered = all.filter((e: IndexedStateChange) => {
      if (target && e.target_path !== target.replace(/\\/g, "/")) return false;
      if (source && e.source !== source) return false;
      if (since && e.when < since) return false;
      if (until && e.when > until) return false;
      return true;
    });
    filtered.sort((a: IndexedStateChange, b: IndexedStateChange) =>
      a.when < b.when ? 1 : a.when > b.when ? -1 : 0,
    );

    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);
    sendJson(res, 200, { entries: page, total, limit, offset });
  });

  // GET /api/v1/state-changes/sources (spec §11.1)
  //
  // Distinct sources seen in the last 30 days with counts and last-seen
  // timestamps. Cached 5 min — this powers the source-filter pills on
  // /decisions, which doesn't need fresher than that.
  addRoute("GET", "/api/v1/state-changes/sources", async ({ res }) => {
    const body = await _sourcesCache.get();
    sendJson(res, 200, body);
  });
}

// ---------------------------------------------------------------------------
// 5-minute source histogram cache.
// ---------------------------------------------------------------------------

interface SourcesResponse {
  sources: Array<{ source: string; count: number; last_seen: string }>;
  window_start: string;
  window_end: string;
}

const _sourcesCache = (() => {
  const TTL_MS = 5 * 60_000;
  let entry: { at: number; body: SourcesResponse } | null = null;
  let inflight: Promise<SourcesResponse> | null = null;
  return {
    async get(): Promise<SourcesResponse> {
      const now = Date.now();
      if (entry && now - entry.at < TTL_MS) return entry.body;
      if (inflight) return inflight;
      inflight = (async () => {
        const all = indexAllStateChanges();
        const windowEnd = new Date();
        const windowStart = new Date(windowEnd.getTime() - 30 * 24 * 60 * 60_000);
        const startIso = windowStart.toISOString();
        const endIso = windowEnd.toISOString();
        const byName = new Map<string, { count: number; last_seen: string }>();
        for (const e of all) {
          if (!e.source) continue;
          if (e.when < startIso || e.when > endIso) continue;
          const cur = byName.get(e.source);
          if (cur) {
            cur.count += 1;
            if (e.when > cur.last_seen) cur.last_seen = e.when;
          } else {
            byName.set(e.source, { count: 1, last_seen: e.when });
          }
        }
        const sources = [...byName.entries()]
          .map(([source, v]) => ({ source, count: v.count, last_seen: v.last_seen }))
          .sort((a, b) => b.count - a.count);
        const body: SourcesResponse = {
          sources,
          window_start: startIso,
          window_end: endIso,
        };
        entry = { at: Date.now(), body };
        inflight = null;
        return body;
      })();
      return inflight;
    },
  };
})();

// Re-exports for testing.
export const _internal = {
  SOURCE_RE,
  generateUlid,
  slugForSource,
  slugForTarget,
  isoForFilename,
  indexAllStateChanges,
};
