// FilesPageCore — pure logic for /files (#114 PR3).
//
// Why this file exists
// --------------------
// FilesPage.tsx mixes React state, Wasp queries, framer-motion, and DOM
// drag/drop wiring. The four pieces that actually deserve test coverage
// are pure functions of inputs:
//
//   * quota math    — `used / soft_cap`, the 80%-of-soft warning band,
//                     the at-hard-cap red band, byte formatting.
//   * preview mode  — given a filename + content-type, which preview
//                     do we render? image / text / pdf / unknown.
//   * search debounce — the cooldown timer the search box uses so we
//                     don't fire a `/list?q=` on every keystroke.
//   * label edit    — optimistic-update state machine the inline pencil
//                     uses (idle → editing → saving → settled|reverted).
//
// All four are deterministic, side-effect-free, and free of React. The
// page composes them and wires them to `useState` / `useEffect`.

// ── shared file row shape (mirrors the ctrl-api response) ──────────────────
//
// `path` is the relative tail under FILES_ROOT (`<ULID>/<safe-name>`).
// `principal_label` is the only field /files lets the principal edit
// (PR2 of #114 — PATCH /api/v1/files/:path).
export interface FileRow {
  id: string;
  path: string;
  size_bytes: number;
  sha256: string;
  content_type: string | null;
  original_filename: string | null;
  principal_label: string | null;
  uploaded_by: string;
  uploaded_at: number;
  last_accessed_at: number | null;
  deleted_at: number | null;
  // #114 Lane B — extraction columns. `alfred_read_at` flips
  // null → unix-ms once the FileExtractionWorkflow finishes; drives
  // the "Alfred read it" badge. `summary` is the one-paragraph
  // description shown in the row's hover tooltip + side panel.
  // `extraction_error` is the subtle-error state (null on success or
  // while pending). All three are optional so existing rows + the
  // pre-Lane-B ctrl-api response shape stay assignable.
  alfred_read_at?: number | null;
  summary?: string | null;
  extraction_error?: string | null;
}

// #114 Lane B — visual state machine for the "Alfred read it" badge.
// Derived purely from the three extraction columns + the row's age:
//
//   * "settled" — extraction succeeded; show the brass-coloured
//                 "Alfred read it" pill + the summary tooltip.
//   * "pending" — extraction hasn't stamped yet AND the row is fresh
//                 (uploaded <2 min ago). Show a soft "Reading…" pulse.
//   * "stale"   — extraction hasn't stamped and the row is older than
//                 2 min. Either the workflow never fired (e.g. tenant
//                 booted without alfred-learn) or it dropped silently.
//                 Show nothing — no pulse, no badge.
//   * "errored" — `extraction_error` is set. Show the muted-rust
//                 "Alfred couldn't read this" affordance with the
//                 reason code as the tooltip.
export type BadgeState = "settled" | "pending" | "stale" | "errored";

/** Stale-after threshold for the "Reading…" pulse. Two minutes is
 *  comfortably above the §14 promise of 30s and accounts for a cold
 *  tenant warm-up (Hermes hit, first clerk call). */
export const PENDING_STALE_AFTER_MS = 2 * 60_000;

/** Derive the badge state from a row. `now` is injectable for tests. */
export function deriveBadgeState(
  row: FileRow,
  now: number = Date.now(),
): BadgeState {
  if (row.alfred_read_at && row.alfred_read_at > 0) return "settled";
  if (row.extraction_error && row.extraction_error.length > 0) {
    return "errored";
  }
  const age = now - (row.uploaded_at ?? 0);
  if (age <= PENDING_STALE_AFTER_MS) return "pending";
  return "stale";
}

/** Render the principal-readable label for the badge state. The
 *  "settled" copy is the row's tooltip on hover; this function returns
 *  the short pill text. */
export function badgeLabel(state: BadgeState): string {
  switch (state) {
    case "settled":
      return "Alfred read it";
    case "pending":
      return "Reading…";
    case "errored":
      return "Couldn't read";
    case "stale":
      return "";
  }
}

export interface FilesUsage {
  used_bytes: number;
  count: number;
  soft_cap_bytes: number;
  hard_cap_bytes: number;
  upload_soft_bytes: number;
  upload_hard_bytes: number;
}

// ── 1 · quota math ─────────────────────────────────────────────────────────

export type QuotaBand = "calm" | "warn" | "alarm";

export interface QuotaView {
  /** 0..1 of soft cap (clamped to [0,1] — used for the bar width). */
  fractionOfSoft: number;
  /** True percent of soft cap (may exceed 100). */
  percentOfSoft: number;
  /** Band used to colour the bar — sage (calm), amber (warn ≥ 80% soft),
   *  red (alarm at or past hard cap). */
  band: QuotaBand;
  /** Human-readable used + soft cap pair (e.g. "1.2 GB / 10 GB"). */
  usedLabel: string;
  softCapLabel: string;
  /** "12% of 10 GB used" line shown next to the bar. */
  summaryLabel: string;
}

/** Bytes → human ("1.2 GB"). Binary (1024) base, two-letter unit. Negative
 *  inputs are treated as zero (the server should never send one but we
 *  defend the strip). */
export function formatBytes(bytes: number): string {
  const n = Math.max(0, Math.floor(bytes));
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Show one decimal for non-byte units, but trim a trailing ".0" so
  // "1 GB" doesn't render as "1.0 GB".
  const fixed = value.toFixed(1);
  const trimmed = fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
  return `${trimmed} ${units[unit]}`;
}

/** Derive the quota strip view from a `/usage` response. */
export function deriveQuotaView(u: FilesUsage): QuotaView {
  const soft = Math.max(1, u.soft_cap_bytes); // /1 guard, never /0
  const hard = Math.max(soft, u.hard_cap_bytes);
  const used = Math.max(0, u.used_bytes);
  const fraction = Math.min(1, used / soft);
  const percentExact = (used / soft) * 100;
  // Spec: amber at 80% of soft; red at or past hard cap.
  const band: QuotaBand =
    used >= hard ? "alarm" : percentExact >= 80 ? "warn" : "calm";
  const usedLabel = formatBytes(used);
  const softCapLabel = formatBytes(soft);
  const summaryLabel = `${Math.round(percentExact)}% of ${softCapLabel} used`;
  return {
    fractionOfSoft: fraction,
    percentOfSoft: percentExact,
    band,
    usedLabel,
    softCapLabel,
    summaryLabel,
  };
}

// ── 2 · preview mode ───────────────────────────────────────────────────────

export type PreviewMode =
  | "image"
  | "pdf"
  | "text"
  | "audio"
  | "video"
  | "unknown";

const EXT_TO_MODE: Record<string, PreviewMode> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  pdf: "pdf",
  txt: "text",
  md: "text",
  json: "text",
  csv: "text",
  html: "text",
  htm: "text",
  log: "text",
  yaml: "text",
  yml: "text",
  xml: "text",
  ts: "text",
  tsx: "text",
  js: "text",
  jsx: "text",
  py: "text",
  go: "text",
  rs: "text",
  sh: "text",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  ogg: "audio",
  mp4: "video",
  webm: "video",
  mov: "video",
};

/** Decide the preview mode from the row's content type + filename. The
 *  content type is preferred when present (the server sniffed it from the
 *  upload); the extension is a fallback for blobs the server couldn't
 *  identify (no Content-Type from the upload AND an unknown extension). */
export function derivePreviewMode(
  contentType: string | null | undefined,
  filename: string | null | undefined,
): PreviewMode {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct === "application/pdf") return "pdf";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  // text/* AND a small allowlist of structured text types we trust the
  // browser to render in a <pre> without escaping pain.
  if (
    ct.startsWith("text/") ||
    ct === "application/json" ||
    ct === "application/xml" ||
    ct === "application/x-yaml"
  ) {
    return "text";
  }

  const name = filename ?? "";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "unknown";
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_TO_MODE[ext] ?? "unknown";
}

// ── 3 · search debounce ────────────────────────────────────────────────────

export interface DebounceController {
  /** Trigger a new emission. Resets any pending timer; emits after `delayMs`. */
  push(value: string): void;
  /** Cancel the pending emission (e.g. on unmount). */
  cancel(): void;
  /** True iff a deferred emission is currently scheduled. */
  pending(): boolean;
}

/** Build a debounce controller. `delayMs` typically 300 for search boxes;
 *  `onEmit` is called with the latest pushed value after the cooldown.
 *
 *  Why a controller and not a hook: hooks aren't testable without a
 *  React renderer. The page wraps this in a useEffect; the test asserts
 *  the timing contract directly with `setTimeout`-style fake timers. */
export function makeDebounceController(
  delayMs: number,
  onEmit: (value: string) => void,
  scheduler: {
    setTimeout: (cb: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  } = globalThis as unknown as {
    setTimeout: (cb: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  },
): DebounceController {
  let handle: unknown = null;
  let lastValue = "";

  function clear() {
    if (handle !== null) {
      scheduler.clearTimeout(handle);
      handle = null;
    }
  }

  return {
    push(value: string) {
      lastValue = value;
      clear();
      handle = scheduler.setTimeout(() => {
        handle = null;
        onEmit(lastValue);
      }, delayMs);
    },
    cancel() {
      clear();
    },
    pending() {
      return handle !== null;
    },
  };
}

// ── 4 · label-edit state machine ───────────────────────────────────────────

export type LabelEditState =
  | { kind: "idle"; value: string | null }
  | { kind: "editing"; draft: string; original: string | null }
  | { kind: "saving"; draft: string; original: string | null }
  | { kind: "settled"; value: string | null }
  | { kind: "reverted"; value: string | null; error: string };

export type LabelEditEvent =
  | { type: "begin" }
  | { type: "change"; draft: string }
  | { type: "commit" }
  | { type: "cancel" }
  | { type: "saved"; value: string | null }
  | { type: "failed"; error: string };

/** Pure reducer driving the inline-pencil edit. Optimistic-update logic
 *  (apply the draft to the row immediately on `commit`, then either
 *  `saved` confirms or `failed` reverts) is split between this state
 *  machine and the row-level optimistic value held in `labelDraftFor()`. */
export function reduceLabelEdit(
  state: LabelEditState,
  event: LabelEditEvent,
): LabelEditState {
  switch (state.kind) {
    case "idle":
    case "settled":
    case "reverted":
      if (event.type === "begin") {
        const original =
          state.kind === "idle"
            ? state.value
            : state.kind === "settled"
              ? state.value
              : state.value;
        return { kind: "editing", draft: original ?? "", original };
      }
      return state;
    case "editing":
      if (event.type === "change") {
        return { ...state, draft: event.draft };
      }
      if (event.type === "cancel") {
        return { kind: "idle", value: state.original };
      }
      if (event.type === "commit") {
        return { kind: "saving", draft: state.draft, original: state.original };
      }
      return state;
    case "saving":
      if (event.type === "saved") {
        return { kind: "settled", value: event.value };
      }
      if (event.type === "failed") {
        return {
          kind: "reverted",
          value: state.original,
          error: event.error,
        };
      }
      return state;
    default:
      return state;
  }
}

/** Optimistic value to render the row with during an edit cycle. While
 *  editing/saving, the UI shows the draft; while settled, it shows the
 *  newly-saved value; while reverted, the original. */
export function labelDraftFor(
  state: LabelEditState,
  fallback: string | null,
): string | null {
  switch (state.kind) {
    case "idle":
      return state.value ?? fallback;
    case "editing":
    case "saving":
      return state.draft;
    case "settled":
      return state.value;
    case "reverted":
      return state.value;
  }
}

// ── 5 · upload state machine ───────────────────────────────────────────────
//
// The DnD upload zone tracks each in-flight upload as a UploadItem. This
// is the pure helper that derives the visual state from progress numbers,
// so the test can assert "at byte 0 of N we're queued; at N of N we're
// done; mid-stream we're uploading with a percent".

export type UploadStatus =
  | "queued"
  | "uploading"
  | "completed"
  | "failed"
  | "rejected";

export interface UploadItem {
  /** Stable client-side key (random per session). */
  key: string;
  filename: string;
  size: number;
  loaded: number;
  status: UploadStatus;
  /** Set on `failed`/`rejected`. */
  error?: string;
  /** Set on `completed` — the server-returned path so the UI can refresh
   *  the list view + jump to the new row. */
  resultPath?: string;
}

/** Percent (0..100) for a queued/uploading row. Completed reports 100,
 *  failed/rejected report whatever progress was made. */
export function uploadPercent(item: UploadItem): number {
  if (item.status === "completed") return 100;
  if (item.size <= 0) return 0;
  return Math.min(100, Math.max(0, (item.loaded / item.size) * 100));
}

/** Decide whether a queued upload should be rejected outright before
 *  we even open a request — e.g. it would push us past the hard cap.
 *  Returns null when accepted, or a human-readable reason when not. */
export function shouldRejectUpload(
  size: number,
  usage: FilesUsage,
): string | null {
  if (size > usage.upload_hard_bytes) {
    return `File exceeds the ${formatBytes(usage.upload_hard_bytes)} per-upload hard cap.`;
  }
  if (usage.used_bytes + size > usage.hard_cap_bytes) {
    return "Upload would push the file store past its hard cap.";
  }
  return null;
}

// ── 6 · path helpers ───────────────────────────────────────────────────────
//
// Two pure helpers the page uses to build the breadcrumb / prefix tree
// from a flat list of `<ULID>/<safe-name>` paths.

export interface PrefixNode {
  /** The path segment for THIS node (e.g. "01HX..." or a virtual
   *  group). Empty string for the root. */
  segment: string;
  /** The full prefix from root down to this node (`a/b/`-style). */
  prefix: string;
  /** Direct children of this node (other prefix nodes — leaves omitted). */
  children: PrefixNode[];
  /** Number of files whose `path` starts with this node's prefix. */
  count: number;
}

/** Build a one-level prefix tree from the flat list of rows. Files
 *  uploaded via PR1 always have a `<ULID>/<filename>` shape, so the
 *  ULID is the only "directory" — the tree is intentionally shallow,
 *  matching the spec's "no subdirectories yet" stance. Returned in
 *  most-recently-uploaded-first order (the ULID prefix is monotonic). */
export function buildPrefixTree(rows: FileRow[]): PrefixNode {
  const root: PrefixNode = {
    segment: "",
    prefix: "",
    children: [],
    count: rows.length,
  };
  const byTopSeg = new Map<string, PrefixNode>();
  // Iterate newest-first so child order is newest-first by construction.
  const ordered = [...rows].sort((a, b) => b.uploaded_at - a.uploaded_at);
  for (const row of ordered) {
    const norm = row.path.replace(/\\/g, "/");
    const first = norm.split("/", 1)[0];
    if (!first) continue;
    let node = byTopSeg.get(first);
    if (!node) {
      node = { segment: first, prefix: `${first}/`, children: [], count: 0 };
      byTopSeg.set(first, node);
      root.children.push(node);
    }
    node.count += 1;
  }
  return root;
}

/** Filter a row list to those under `prefix` (POSIX path comparison).
 *  An empty prefix returns the input unchanged. */
export function filterByPrefix(rows: FileRow[], prefix: string): FileRow[] {
  if (!prefix) return rows;
  return rows.filter((r) => r.path.startsWith(prefix));
}

/** Truncate a sha256 hex string to a stable 12-char prefix (the column
 *  shows enough to disambiguate; the full hash is in the side panel). */
export function shortSha(sha: string): string {
  return (sha ?? "").slice(0, 12);
}

/** Format an ISO-ms timestamp as "2 hours ago" / "yesterday" / a date.
 *  The fixed "now" is injectable for tests. */
export function formatUploadedAt(
  uploadedAtMs: number,
  now: Date = new Date(),
): string {
  const delta = now.getTime() - uploadedAtMs;
  if (delta < 0) return "in the future";
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "just now";
  if (delta < hour) return `${Math.floor(delta / minute)} min ago`;
  if (delta < day) return `${Math.floor(delta / hour)} h ago`;
  if (delta < 7 * day) return `${Math.floor(delta / day)} d ago`;
  return new Date(uploadedAtMs).toISOString().slice(0, 10);
}
