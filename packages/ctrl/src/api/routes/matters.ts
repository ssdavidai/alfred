// /api/v1/matters — long-running concerns aggregator (#859, #884).
//
// Matters in Alfred Black's vocabulary map to vault `project` records.
// Each Project has connected Conversation / Decision / Task / Note records
// that point at it via frontmatter (`project: [[<slug>]]`, `parent_matter`,
// `references`, etc.). This route walks the vault once, builds a per-matter
// tally, and surfaces the data the /matters index + detail pages need.
//
// RFC #884 ("Living matters & tasks") extends the detail aggregator with:
//   - matter.current_state / as_of / signal_count_24h (written by the
//     `nightly_narrative` workflow in alfred-learn)
//   - matter.timeline — chronological signal/action/task-transition feed
//     targeting this matter
//   - matter.tasks — tasks linked to this matter with state/current_state/as_of
// and the list endpoint with:
//   - state (derived from linked tasks: done/active/waiting)
//   - current_state (the matter's own frontmatter current_state)
//
// Endpoints:
//   GET /api/v1/matters
//     → { matters: [{ id, name, summary, last, next, counts, state, current_state }] }
//
//   GET /api/v1/matters/:id
//     → {
//         matter: {
//           id, name, summary, last, next,
//           about,
//           counts: { conversations, decisions, tasks, drafts },
//           recent_decisions: [{ date, label, outcome, path }],
//           vault_by_category: { conversations, decisions, tasks, drafts },
//           current_state, as_of, signal_count_24h,
//           timeline: [{ when, kind, headline, path }],
//           tasks: [{ id, path, name, state, current_state, as_of }],
//         }
//       }
//
// Path conventions (`matter/<slug>.md` is the file). The detail route
// accepts both `<slug>` and `matter/<slug>` for ergonomics.
import { addRoute } from "../server.js";
import { sendJson, NotFoundError } from "../errors.js";
import { VAULT_PATH, walkMd, readRecord } from "./vault.js";

const IGNORE_DIRS = new Set([".git", ".obsidian", "node_modules", ".trash"]);

interface MatterCounts {
  conversations: number;
  decisions: number;
  tasks: number;
  drafts: number;
}

interface MatterIndexRow {
  id: string;
  path: string;
  name: string;
  summary: string;
  last: string;
  next: string;
  counts: MatterCounts;
  state: "done" | "active" | "waiting";
  current_state: string | null;
}

interface VaultLink {
  title: string;
  path: string;
  date: string;
}

interface RecentDecision {
  date: string;
  label: string;
  outcome: "Handled" | "Held" | "Asked";
  path: string;
}

type TimelineKind =
  | "signal"
  | "task_transition"
  | "action"
  | "decision"
  // #889 state-mutation contract: every state mutation lands a
  // state_change entry on the target's `timeline` frontmatter list
  // alongside the event/state-change-*.md audit record. The composer
  // reads matter.fm.timeline and merges state_change kinds in.
  | "state_change";

interface TimelineEntry {
  when: string;
  kind: TimelineKind;
  headline: string;
  path: string;
  /** Populated only for kind=state_change. The full provenance
   *  payload (source, observed_window, changes summary, reason,
   *  confidence, mode, audit_record path) is forwarded verbatim from
   *  the matter frontmatter so the SaaS timeline renderer can render
   *  the inline summary without an extra fetch. */
  state_change?: StateChangeTimelineDetail;
}

/** Shape of a `state_change` entry in `matter.timeline` / `task.timeline`
 *  frontmatter (#889 spec §4.3). Fields are forwarded as-read from the
 *  vault — the composer doesn't re-derive any of them. */
export interface StateChangeTimelineDetail {
  id: string;                  // ulid
  source: string;              // dotted identifier
  prior_as_of: string | null;
  observed_window: {
    start: string;
    end: string;
    signals: number;
    decisions: number;
    other: string[];
  };
  changes: Record<string, unknown>;
  reason: string;
  confidence: number;
  mode: "shadow" | "live";
  audit_record: string;
}

type TaskState = "pending" | "in_progress" | "done" | "archived";

interface MatterTask {
  id: string;
  path: string;
  name: string;
  state: TaskState;
  current_state: string | null;
  as_of: string | null;
  /** Provenance — where this task came from. One of:
   *    - `decision/<ts>.md`     (principal clicked Delegate/Do on the Desk)
   *    - `instinct/<id>.md`     (autonomous fire by a matched instinct)
   *    - `legacy/pre-arch11`    (one-time grandfather stamp on pre-ARCH-11 records)
   *    - "" (or null) when the task pre-dates the stamp and the backfill
   *      hasn't run yet — surfaced as "unknown" by the UI. */
  decision_origin: string | null;
  /** Owner — who is on the hook for this task.
   *    - `principal`      Sir clicked Delegate/Do
   *    - `alfred`         autonomous fire from an instinct
   *    - `<email>`        the sender of the source signal (inbound mail)
   *    - `external`       signal-sourced but no resolvable sender
   *    - `unknown`        pre-stamp grandfather / unrouted */
  owner: string | null;
}

interface MatterDetail extends Omit<MatterIndexRow, "state"> {
  about: string;
  recent_decisions: RecentDecision[];
  vault_by_category: {
    conversations: VaultLink[];
    decisions: VaultLink[];
    tasks: VaultLink[];
    drafts: VaultLink[];
  };
  // RFC #884 — Living Narratives layer.
  current_state: string | null;
  as_of: string | null;
  signal_count_24h: number;
  timeline: TimelineEntry[];
  tasks: MatterTask[];
  state: "done" | "active" | "waiting";
}

const TIMELINE_CAP = 100;

// ---------------------------------------------------------------------------
// Per-matter detail cache (#884).
//
// Mirrors the /api/v1/vault/index pattern from #873: 60s TTL, keyed by
// matter id. ctrl-api runs one process per tenant, so cache cardinality
// is the active set of matters. We cache the full response body so all
// the timeline/tasks composition only runs at most once per minute per
// matter.
// ---------------------------------------------------------------------------
const MATTER_DETAIL_TTL_MS = 60_000;
const _matterDetailCache = new Map<string, { at: number; body: { matter: MatterDetail } }>();

/** Resolve a matter id (slug or `matter/<slug>` or full path) to its
 *  filename stem. Returns null if it doesn't look like a matter id. */
function normalizeMatterId(raw: string): string | null {
  if (!raw) return null;
  let id = raw.trim();
  id = id.replace(/^matter\//, "");
  id = id.replace(/\.md$/, "");
  // Defence: id may be a slug only — disallow paths.
  if (id.includes("/") || id.includes("\\")) return null;
  return id || null;
}

/** Pull a stable id reference out of various frontmatter shapes
 *  (`[[matter/foo]]`, `matter/foo`, `matter/foo.md`, `foo`). */
function extractMatterRef(value: unknown): string | null {
  if (!value) return null;
  let s = String(value).trim();
  const wl = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(s);
  if (wl) s = wl[1];
  s = s.replace(/^matter\//, "").replace(/\.md$/, "");
  if (!s || s.includes("/")) return null;
  return s;
}

/** Pull a task ref shaped like `[[task/foo]]`, `task/foo`, `task/foo.md`,
 *  or bare `foo` out of a frontmatter scalar. Returns the stem only. */
function extractTaskRef(value: unknown): string | null {
  if (!value) return null;
  let s = String(value).trim();
  const wl = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(s);
  if (wl) s = wl[1];
  s = s.replace(/^task\//, "").replace(/\.md$/, "");
  if (!s || s.includes("/")) return null;
  return s;
}

/** First sentence cap at `cap` chars. Falls back to first `cap` chars. */
function firstSentence(text: string, cap = 100): string {
  if (!text) return "";
  const trimmed = String(text).replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  // Match through the first ., !, or ? followed by whitespace or EOL.
  const m = trimmed.match(/^[^.!?]*[.!?](?=\s|$)/);
  const candidate = m ? m[0] : trimmed;
  if (candidate.length <= cap) return candidate.trim();
  return candidate.slice(0, cap).trim();
}

/** Read frontmatter of an event/signal-action-*.md record, returning
 *  the action's `created`/`timestamp` and a one-line headline derived
 *  from the body (which leads with `# signal-action: <chosen_path>` then
 *  a bulleted summary). Returns null if the record can't be read. */
function summarizeSignalAction(
  relPath: string,
): { when: string; headline: string } | null {
  const rec = readRecord(relPath);
  if (!rec) return null;
  // Signal-action audit records use `timestamp` (signal_actions.py); the
  // older steward-action audit records use `created`. Cover both.
  const when = String(
    rec.fm.timestamp ?? rec.fm.created ?? rec.fm.created_at ?? "",
  );
  // Headline preference:
  //   1. explicit `summary` frontmatter field (matches the contract spec)
  //   2. first non-heading sentence from the body
  //   3. first 100 chars of the body
  let headline = "";
  if (typeof rec.fm.summary === "string" && rec.fm.summary.trim()) {
    headline = firstSentence(rec.fm.summary, 100);
  }
  if (!headline) {
    // Strip leading `# ...` heading; pull the first prose line.
    const bodyLines = rec.body.split("\n").map((l) => l.trim()).filter(Boolean);
    const proseLine = bodyLines.find((l) => !l.startsWith("#"));
    if (proseLine) {
      // Strip bullet markers and bold markers so the headline reads as prose.
      const cleaned = proseLine
        .replace(/^[-*]\s+/, "")
        .replace(/\*\*/g, "")
        .replace(/^_+|_+$/g, "");
      headline = firstSentence(cleaned, 100) || cleaned.slice(0, 100);
    }
    if (!headline) headline = rec.body.replace(/\s+/g, " ").trim().slice(0, 100);
  }
  return { when, headline };
}

/** Extract `kind: state_change` entries from a matter or task frontmatter
 *  `timeline` list (#889 spec §4.3) and yield TimelineEntry rows ready to
 *  merge into the composed timeline. Tolerates missing fields by skipping
 *  malformed rows — the writer (POST /state-changes) is the source of
 *  truth for the shape; the reader is permissive. */
function extractStateChangeTimeline(
  fm: Record<string, unknown>,
  fallbackPath: string,
): TimelineEntry[] {
  const raw = fm.timeline;
  if (!Array.isArray(raw)) return [];
  const out: TimelineEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (String(e.kind ?? "") !== "state_change") continue;
    const when = String(e.when ?? "");
    if (!when) continue;
    const source = String(e.source ?? "");
    const reason = String(e.reason ?? "");
    const mode = e.mode === "live" ? "live" : "shadow";
    const confidence =
      typeof e.confidence === "number" && Number.isFinite(e.confidence)
        ? e.confidence
        : 1.0;
    const audit = String(e.audit_record ?? "");
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
        ? (e.changes as Record<string, unknown>)
        : {};
    const headline = reason
      ? firstSentence(reason, 100)
      : source
        ? `State change by ${source}`
        : "State change";
    out.push({
      when,
      kind: "state_change",
      headline,
      path: audit || fallbackPath,
      state_change: {
        id: String(e.id ?? ""),
        source,
        prior_as_of:
          typeof e.prior_as_of === "string" && e.prior_as_of
            ? (e.prior_as_of as string)
            : null,
        observed_window,
        changes,
        reason,
        confidence,
        mode,
        audit_record: audit,
      },
    });
  }
  return out;
}

/** Coerce a frontmatter task state to one of the four canonical values.
 *  Defaults to "pending" when missing/unknown. */
function normalizeTaskState(raw: unknown): TaskState {
  const s = String(raw ?? "").toLowerCase().trim();
  if (s === "in_progress" || s === "in-progress" || s === "active") return "in_progress";
  if (s === "done" || s === "completed" || s === "complete") return "done";
  if (s === "archived" || s === "cancelled" || s === "canceled") return "archived";
  // Any other value (todo, snoozed, blocked, open, ...) collapses to pending.
  return "pending";
}

/** True if any of the archive conventions mark this task terminal-archived.
 *
 *  Three conventions live in the vault for historical reasons:
 *    - `archived: true` (boolean flag, set by archive_orphan_tasks.py)
 *    - `state: archived` (canonical, used by the matters aggregator)
 *    - `status: cancelled` (legacy alias from the same orphan archiver)
 *  Any of them is enough; the new cold-archival writer sets all three so
 *  consumers don't have to know which convention won. */
function isArchivedTaskFm(fm: Record<string, unknown>): boolean {
  const archivedRaw = fm.archived;
  if (archivedRaw === true) return true;
  if (typeof archivedRaw === "string" && archivedRaw.toLowerCase() === "true") {
    return true;
  }
  const state = String(fm.state ?? "").toLowerCase().trim();
  if (state === "archived") return true;
  const status = String(fm.status ?? "").toLowerCase().trim();
  if (status === "archived" || status === "cancelled" || status === "canceled") {
    return true;
  }
  return false;
}

/** Derive the matter's roll-up state from its linked tasks. */
function deriveMatterState(tasks: MatterTask[]): "done" | "active" | "waiting" {
  if (tasks.length === 0) return "waiting";
  let anyOpen = false;
  let anyInProgress = false;
  for (const t of tasks) {
    if (t.state === "in_progress") anyInProgress = true;
    if (t.state !== "done" && t.state !== "archived") anyOpen = true;
  }
  if (!anyOpen) return "done";
  if (anyInProgress) return "active";
  return "waiting";
}

/** Resolve a task's display name: frontmatter title/name, then first H1, then stem. */
function resolveTaskName(
  fm: Record<string, unknown>,
  body: string,
  stem: string,
): string {
  const fmName = fm.name ?? fm.title ?? fm.subject;
  if (typeof fmName === "string" && fmName.trim()) return fmName.trim();
  const h1 = body.match(/^\s*#\s+(.+?)\s*$/m);
  if (h1) return h1[1].trim();
  return stem;
}

interface MatterIndexResult {
  byId: Map<string, MatterDetail>;
  ordered: MatterDetail[];
}

/** Walk all records once and group by matter id. */
function buildMatterIndex(): MatterIndexResult {
  const files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
  const byId = new Map<string, MatterDetail>();
  const childrenByMatter = new Map<
    string,
    { type: string; rec: { fm: Record<string, unknown>; body: string; stem: string }; relPath: string }[]
  >();

  // -------------------------------------------------------------------------
  // Pass 1 — Build the per-matter detail skeleton + parse explicit
  // `tasks:` arrays from each matter's frontmatter (forward reference
  // from matter → task; the reverse direction is handled in pass 2).
  // -------------------------------------------------------------------------
  const tasksDeclaredByMatter = new Map<string, Set<string>>();
  for (const relPath of files) {
    const display = relPath.replace(/\\/g, "/");
    if (!display.startsWith("matter/")) continue;
    const rec = readRecord(relPath);
    if (!rec) continue;
    if (rec.fm.type && String(rec.fm.type) !== "matter" && String(rec.fm.type) !== "project") {
      // Defence: matter/ files should be type=matter (or the legacy
      // `project` synonym). Skip strays.
      continue;
    }
    const id = rec.stem;
    const name = String(rec.fm.name ?? rec.fm.title ?? id);
    const summary = String(rec.fm.summary ?? rec.fm.description ?? "");
    const next = String(rec.fm.next_action ?? rec.fm.next ?? "");
    const currentState =
      typeof rec.fm.current_state === "string" && rec.fm.current_state.trim()
        ? (rec.fm.current_state as string)
        : null;
    const asOf =
      typeof rec.fm.as_of === "string" && rec.fm.as_of.trim()
        ? (rec.fm.as_of as string)
        : null;
    let signalCount24h = 0;
    const rawCount = rec.fm.signal_count_24h;
    if (typeof rawCount === "number" && Number.isFinite(rawCount)) {
      signalCount24h = Math.max(0, Math.trunc(rawCount));
    } else if (typeof rawCount === "string" && rawCount.trim()) {
      const n = Number.parseInt(rawCount, 10);
      if (Number.isFinite(n)) signalCount24h = Math.max(0, n);
    }
    const stateChangeEntries = extractStateChangeTimeline(rec.fm, display);
    byId.set(id, {
      id,
      path: display,
      name,
      summary,
      last: "",
      next,
      counts: { conversations: 0, decisions: 0, tasks: 0, drafts: 0 },
      about: rec.body.trim() ? rec.body.trim() : summary,
      recent_decisions: [],
      vault_by_category: {
        conversations: [],
        decisions: [],
        tasks: [],
        drafts: [],
      },
      current_state: currentState,
      as_of: asOf,
      signal_count_24h: signalCount24h,
      timeline: [...stateChangeEntries],
      tasks: [],
      state: "waiting",
    });
    // Forward-declared tasks: `tasks: [[[task/foo]], task/bar, baz]`
    const declared = rec.fm.tasks;
    if (declared) {
      const items = Array.isArray(declared) ? declared : [declared];
      const set = new Set<string>();
      for (const v of items) {
        const ref = extractTaskRef(v);
        if (ref) set.add(ref);
      }
      if (set.size > 0) tasksDeclaredByMatter.set(id, set);
    }
  }

  // -------------------------------------------------------------------------
  // Pass 2 — Walk every non-matter record once and bin against each
  // matter it references. Also build the reverse task→matter index used
  // for the per-matter `tasks` array and the task-transition timeline.
  // -------------------------------------------------------------------------
  // task stem → MatterTask (for cross-matter lookup in pass 3)
  const tasksByStem = new Map<
    string,
    { task: MatterTask; matterRefs: Set<string>; created: string }
  >();
  // signal path → { fm, body }; we use this when expanding the timeline
  // so we don't have to re-read the file.
  type SignalRecord = { fm: Record<string, unknown>; body: string; stem: string };
  const signalsByPath = new Map<string, SignalRecord>();
  // Per-matter signal collector (passes to timeline composition).
  const signalsByMatter = new Map<string, string[]>();

  for (const relPath of files) {
    const display = relPath.replace(/\\/g, "/");
    if (display.startsWith("matter/")) continue;
    const rec = readRecord(relPath);
    if (!rec) continue;
    const recType = String(rec.fm.type ?? "");

    // ---- Signal records (#884 timeline source 1) ----
    if (recType === "signal" || display.startsWith("signal/")) {
      signalsByPath.set(display, rec);
      const candidates = rec.fm.target_candidates;
      // A signal carries an embedding-similarity ranking across all matters.
      // Originally we attached it to EVERY candidate path, which polluted
      // matter timelines with tangentially-related signals (e.g. a Miro
      // password reset showed up on /matters/erste-agentic-coding-makerspace
      // because Erste was its #2 candidate with score 0.19). Fix: only the
      // top candidate, and only if its score clears MIN_SIGNAL_SCORE.
      const MIN_SIGNAL_SCORE = 0.4;
      if (Array.isArray(candidates) && candidates.length > 0) {
        let top: { path: string; score: number } | null = null;
        for (const c of candidates) {
          if (!c || typeof c !== "object") continue;
          const tp = String((c as { path?: unknown }).path ?? "");
          const sc = Number((c as { score?: unknown }).score ?? 0);
          if (!tp.startsWith("matter/")) continue;
          if (Number.isNaN(sc)) continue;
          if (top === null || sc > top.score) top = { path: tp, score: sc };
        }
        if (top !== null && top.score >= MIN_SIGNAL_SCORE) {
          const id = extractMatterRef(top.path);
          if (id && byId.has(id)) {
            let bucket = signalsByMatter.get(id);
            if (!bucket) {
              bucket = [];
              signalsByMatter.set(id, bucket);
            }
            bucket.push(display);
          }
        }
      }
      // Signals don't participate in the legacy by-category buckets;
      // fall through past the category folding.
    }

    // ---- Decision records (RFC: clicks on the Desk surface as
    // first-class records with their own timeline contribution). ----
    if (recType === "decision" || display.startsWith("decision/")) {
      // `matter_ref` is a path like "matter/<id>.md" or just an id.
      const matterRefRaw = rec.fm.matter_ref;
      if (
        typeof matterRefRaw === "string" &&
        matterRefRaw.trim() &&
        matterRefRaw !== "null"
      ) {
        const matterId = extractMatterRef(matterRefRaw);
        if (matterId && byId.has(matterId)) {
          const matter = byId.get(matterId)!;
          const when = String(rec.fm.created ?? "");
          const intent = String(rec.fm.intent ?? "");
          const sourceHeadline = String(rec.fm.source_headline ?? "");
          const state = String(rec.fm.state ?? "open");
          // Headline maps the click into a one-line ledger entry.
          const verb =
            intent === "delegate"
              ? "Delegated to Alfred"
              : intent === "defer"
                ? "Deferred"
                : intent === "done"
                  ? "Closed"
                  : intent === "take_mine"
                    ? "Took it personally"
                    : "Decided";
          const headline = sourceHeadline
            ? `${verb}: ${firstSentence(sourceHeadline, 80)}`
            : verb;
          matter.timeline.push({
            when,
            kind: "decision",
            headline:
              state === "reversed" ? `[undone] ${headline}` : headline,
            path: display,
          });
          // Also bump the matter's roll-up counters and the
          // per-category bucket so /matters and /matters/:id reflect
          // the Desk clicks. Decisions don't fall through to the
          // general childrenByMatter pass below (we `continue` after
          // this block, since decisions use `matter_ref` not the
          // generic refs collection), so the count has to land here.
          matter.counts.decisions += 1;
          matter.vault_by_category.decisions.push({
            title: headline,
            path: display,
            date: when,
          });
          // Roll into recent_decisions too — a Desk click IS a
          // decision-of-record.
          const outcomeStatus = String(rec.fm.state ?? "").toLowerCase();
          const outcome: RecentDecision["outcome"] =
            outcomeStatus === "open" || outcomeStatus === "scheduled"
              ? "Held"
              : outcomeStatus === "reversed"
                ? "Asked"
                : "Handled";
          matter.recent_decisions.push({
            date: when.slice(0, 10),
            label: headline,
            outcome,
            path: display,
          });
          if (when > (matter.last ?? "")) matter.last = when;
        }
      }
      continue;
    }

    if (!recType) continue;

    // ---- Task records: build the task index for the new tasks[] array. ----
    if (recType === "task") {
      const stem = rec.stem;
      const taskRelPath = display;
      const taskFm = rec.fm;
      const matterRefs = new Set<string>();
      // Direct refs first.
      for (const k of ["matter", "parent_matter", "project"]) {
        const v = taskFm[k];
        if (!v) continue;
        const items = Array.isArray(v) ? v : [v];
        for (const it of items) {
          const id = extractMatterRef(it);
          if (id) matterRefs.add(id);
        }
      }
      const currentStateRaw = taskFm.current_state;
      const asOfRaw = taskFm.as_of;
      const decisionOriginRaw = taskFm.decision_origin;
      const ownerRaw = taskFm.owner;
      const task: MatterTask = {
        id: stem,
        path: taskRelPath,
        name: resolveTaskName(taskFm, rec.body, stem),
        state: normalizeTaskState(taskFm.state),
        current_state:
          typeof currentStateRaw === "string" && currentStateRaw.trim()
            ? currentStateRaw
            : null,
        as_of:
          typeof asOfRaw === "string" && asOfRaw.trim() ? asOfRaw : null,
        decision_origin:
          typeof decisionOriginRaw === "string" && decisionOriginRaw.trim() && decisionOriginRaw !== "null"
            ? decisionOriginRaw
            : null,
        owner:
          typeof ownerRaw === "string" && ownerRaw.trim() && ownerRaw !== "null"
            ? ownerRaw
            : null,
      };
      const created = String(taskFm.created ?? taskFm.updated ?? "");
      tasksByStem.set(stem, { task, matterRefs, created });
    }

    // Collect all candidate matter refs from this record (for the
    // existing per-category aggregation).
    const refs = new Set<string>();
    const candidates: unknown[] = [
      rec.fm.parent_matter,
      rec.fm.matter,
      rec.fm.project,
      rec.fm.matters,
      rec.fm.related,
      rec.fm.references,
    ];
    for (const c of candidates) {
      if (!c) continue;
      const items = Array.isArray(c) ? c : [c];
      for (const v of items) {
        const id = extractMatterRef(v);
        if (id && byId.has(id)) refs.add(id);
      }
    }
    // Wikilinks in the body, in case frontmatter is sparse.
    const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_RE.exec(rec.body))) {
      const id = extractMatterRef(m[1]);
      if (id && byId.has(id)) refs.add(id);
    }
    if (refs.size === 0) continue;

    for (const matterId of refs) {
      let bucket = childrenByMatter.get(matterId);
      if (!bucket) {
        bucket = [];
        childrenByMatter.set(matterId, bucket);
      }
      bucket.push({ type: recType, rec, relPath: display });
    }
  }

  // -------------------------------------------------------------------------
  // Pass 3 — Fold the existing per-category aggregation, compose the
  // tasks[] array per matter, and build the timeline.
  // -------------------------------------------------------------------------
  for (const [matterId, kids] of childrenByMatter) {
    const matter = byId.get(matterId);
    if (!matter) continue;
    let lastIso = "";
    for (const k of kids) {
      const created = String(k.rec.fm.created ?? k.rec.fm.updated ?? "");
      const title = String(
        k.rec.fm.subject ??
          k.rec.fm.name ??
          k.rec.fm.title ??
          k.rec.stem ??
          k.relPath,
      );
      const link: VaultLink = { title, path: k.relPath, date: created };
      if (created > lastIso) lastIso = created;

      switch (k.type) {
        case "conversation":
          matter.counts.conversations += 1;
          matter.vault_by_category.conversations.push(link);
          break;
        case "decision": {
          matter.counts.decisions += 1;
          matter.vault_by_category.decisions.push(link);
          // Also produce a recent_decisions row with a heuristic outcome.
          const status = String(k.rec.fm.status ?? "").toLowerCase();
          let outcome: RecentDecision["outcome"] = "Handled";
          if (status === "draft" || status === "asked") outcome = "Asked";
          else if (status === "review" || status === "held") outcome = "Held";
          matter.recent_decisions.push({
            date: created.slice(0, 10),
            label: title,
            outcome,
            path: k.relPath,
          });
          break;
        }
        case "task": {
          // Counter-aware filter: skip tasks that any of the archive
          // conventions mark terminal. `vault_by_category.tasks` still
          // gets the link so the record stays browseable from the
          // matter detail page; only the headline count drops.
          const taskArchived = isArchivedTaskFm(k.rec.fm);
          if (!taskArchived) {
            matter.counts.tasks += 1;
          }
          matter.vault_by_category.tasks.push(link);
          break;
        }
        case "note":
        case "synthesis": {
          const status = String(k.rec.fm.status ?? "").toLowerCase();
          if (status === "draft" || status === "review") {
            matter.counts.drafts += 1;
            matter.vault_by_category.drafts.push(link);
          }
          break;
        }
        default:
          // Other types are folded into the timestamp-tracking but no
          // visible bucket.
          break;
      }
    }
    if (lastIso && !matter.last) matter.last = lastIso.slice(0, 10);
    // Newest-first per category.
    for (const cat of [
      matter.vault_by_category.conversations,
      matter.vault_by_category.decisions,
      matter.vault_by_category.tasks,
      matter.vault_by_category.drafts,
    ]) {
      cat.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    }
    matter.recent_decisions.sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
    );
    matter.recent_decisions = matter.recent_decisions.slice(0, 10);
  }

  // -------------------------------------------------------------------------
  // Compose per-matter tasks[] from (a) task→matter refs and (b) the
  // matter's own `tasks:` frontmatter array.
  // -------------------------------------------------------------------------
  for (const [stem, entry] of tasksByStem) {
    // From task→matter refs.
    for (const matterId of entry.matterRefs) {
      const matter = byId.get(matterId);
      if (matter) matter.tasks.push(entry.task);
    }
    // From matter.tasks[] forward refs (a task may be listed even if
    // it has no `matter:` field back-pointing).
    for (const [matterId, declared] of tasksDeclaredByMatter) {
      if (!declared.has(stem)) continue;
      const matter = byId.get(matterId);
      if (!matter) continue;
      if (entry.matterRefs.has(matterId)) continue; // already added
      matter.tasks.push(entry.task);
    }
  }

  // Deduplicate per-matter tasks (a task can both back-ref and be
  // forward-listed) and sort newest-first by as_of when present.
  for (const matter of byId.values()) {
    if (matter.tasks.length === 0) continue;
    const seen = new Set<string>();
    matter.tasks = matter.tasks.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
    matter.tasks.sort((a, b) => {
      const aw = a.as_of ?? "";
      const bw = b.as_of ?? "";
      if (aw === bw) return a.name.localeCompare(b.name);
      return aw < bw ? 1 : -1;
    });
    matter.state = deriveMatterState(matter.tasks);
  }

  // -------------------------------------------------------------------------
  // Timeline composition (#884) — three sources merged, newest-first,
  // capped at 100.
  // -------------------------------------------------------------------------
  for (const [matterId, signalPaths] of signalsByMatter) {
    const matter = byId.get(matterId);
    if (!matter) continue;
    for (const sp of signalPaths) {
      const rec = signalsByPath.get(sp);
      if (!rec) continue;
      // 1. Signal entry.
      const when = String(rec.fm.created ?? rec.fm.applied_at ?? "");
      let headline = "";
      const proposal = rec.fm.action_proposal;
      if (proposal && typeof proposal === "object" && !Array.isArray(proposal)) {
        const what = (proposal as { what?: unknown }).what;
        if (typeof what === "string" && what.trim()) {
          headline = firstSentence(what, 100);
        }
      }
      if (!headline && typeof rec.fm.reasoning === "string") {
        headline = firstSentence(rec.fm.reasoning, 100);
      }
      if (!headline) headline = rec.stem;
      matter.timeline.push({
        when,
        kind: "signal",
        headline,
        path: sp,
      });
      // 2. Linked signal-action audit entry.
      const auditPath = rec.fm.audit_record_path;
      if (typeof auditPath === "string" && auditPath.trim()) {
        const summary = summarizeSignalAction(auditPath.trim());
        if (summary) {
          matter.timeline.push({
            when: summary.when,
            kind: "action",
            headline: summary.headline,
            path: auditPath.trim(),
          });
        }
      }
    }
  }

  // 3. Task-transition entries — one per linked task with both state + as_of set.
  for (const matter of byId.values()) {
    for (const t of matter.tasks) {
      if (!t.as_of) continue;
      matter.timeline.push({
        when: t.as_of,
        kind: "task_transition",
        headline: `Task '${t.name}' → ${t.state}`,
        path: t.path,
      });
    }
  }

  // Sort newest-first, cap at 100.
  for (const matter of byId.values()) {
    matter.timeline.sort((a, b) =>
      a.when < b.when ? 1 : a.when > b.when ? -1 : 0,
    );
    if (matter.timeline.length > TIMELINE_CAP) {
      matter.timeline = matter.timeline.slice(0, TIMELINE_CAP);
    }
  }

  // Final ordering — most recently active first.
  const ordered = [...byId.values()].sort((a, b) =>
    a.last < b.last ? 1 : a.last > b.last ? -1 : 0,
  );
  return { byId, ordered };
}

export function registerMatterRoutes(): void {
  addRoute("GET", "/api/v1/matters", async ({ res }) => {
    const { ordered } = buildMatterIndex();
    const matters: MatterIndexRow[] = ordered.map((m) => ({
      id: m.id,
      path: m.path,
      name: m.name,
      summary: m.summary,
      last: m.last,
      next: m.next,
      counts: m.counts,
      state: m.state,
      current_state: m.current_state,
    }));
    sendJson(res, 200, { matters, count: matters.length });
  });

  addRoute("GET", "/api/v1/matters/:id", async ({ res, params }) => {
    const id = normalizeMatterId(params.id);
    if (!id) throw new NotFoundError("Matter not found");
    const now = Date.now();
    const cached = _matterDetailCache.get(id);
    if (cached && now - cached.at < MATTER_DETAIL_TTL_MS) {
      sendJson(res, 200, cached.body);
      return;
    }
    const { byId } = buildMatterIndex();
    const matter = byId.get(id);
    if (!matter) throw new NotFoundError("Matter not found");
    const body = { matter };
    _matterDetailCache.set(id, { at: now, body });
    sendJson(res, 200, body);
  });
}

// Re-exported for tests / future tooling.
export const _internal = {
  buildMatterIndex,
  normalizeMatterId,
  normalizeTaskState,
  deriveMatterState,
  firstSentence,
};
