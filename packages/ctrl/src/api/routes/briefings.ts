// Briefings — read endpoints for the BriefingWorkflow snapshot records
// written by alfred-learn under the state-mutation contract (#893,
// spec §8.2).
//
// The composer writes one ``briefing/<YYYY-MM-DD>-<slot>.md`` per slot
// per day. The frontmatter follows spec §8.2 — a small flat block plus
// a structured `observed` block carried in a trailing HTML-comment YAML
// island (the ctrl-api YAML parser is flat-only; nested mappings round-
// trip via the comment for the dashboard to render).
//
// Two endpoints:
//
//   GET /api/v1/briefings
//     List briefings (chronological, newest-first by default).
//     Query params:
//       slot   "morning" | "evening" | "all" (default "all")
//       since  ISO timestamp filter on composed_at (>=)
//       until  ISO timestamp filter on composed_at (<=)
//       limit  default 30, max 100
//
//   GET /api/v1/briefings/:slugDate
//     Single full record. The slug shape is ``<YYYY-MM-DD>-<slot>``,
//     matching the filename stem under ``briefing/``.
//
// Both endpoints sit behind a 3s TTL cache keyed by the briefing
// directory's mtime — the BriefingWorkflow writes about once every
// 12 hours so we'd much rather serve a few seconds stale than re-walk
// on every Desk poll.

import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { VAULT_PATH, walkMd, readRecord, IGNORE_DIRS } from "./vault.js";

const BRIEFING_DIR = "briefing";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

const BRIEFING_LIST_TTL_MS = 3_000;
const BRIEFING_DETAIL_TTL_MS = 5_000;

// Filename → (date, slot). The composer writes
// ``briefing/<YYYY-MM-DD>-<slot>.md`` so the parse is mechanical;
// returns null for any record outside that convention (e.g. legacy
// briefing records that pre-date the slot-bearing filename).
function parseBriefingFilename(stem: string): { date: string; slot: "morning" | "evening" } | null {
  if (!stem) return null;
  const m = /^(\d{4}-\d{2}-\d{2})-(morning|evening)$/.exec(stem);
  if (!m) return null;
  return { date: m[1], slot: m[2] as "morning" | "evening" };
}

interface BriefingListItem {
  path: string;          // "briefing/2026-05-13-morning.md"
  slug_date: string;     // "2026-05-13-morning" — the URL slug for the detail endpoint
  slot: "morning" | "evening";
  date: string;          // "2026-05-13"
  composed_at: string;
  prior_briefing: string | null;
  window: { start: string; end: string };
  observed_matters_count: number;
  state_changes_count: number;
  signals_count: number;
  decisions_count: number;
}

interface BriefingDetail extends BriefingListItem {
  body: string;
  frontmatter: Record<string, unknown>;
}

// Mtime-cached list. The single key collapses every list call into one
// directory scan per TTL window. ctrl-api is per-tenant single-process
// so a Map keyed on the absolute dir path is a fine cache cardinality.
const _briefingListCache = new Map<
  string,
  { at: number; mtimeMs: number; body: BriefingListItem[] }
>();

function _briefingDirMtimeMs(): number {
  const dir = path.join(VAULT_PATH, BRIEFING_DIR);
  try {
    const st = fs.statSync(dir);
    return st.mtimeMs;
  } catch {
    // Directory missing — return 0 so a freshly-created briefing/
    // directory invalidates the cache.
    return 0;
  }
}

function _readAllBriefings(): BriefingListItem[] {
  const briefingDir = path.join(VAULT_PATH, BRIEFING_DIR);
  if (!fs.existsSync(briefingDir)) return [];

  const cacheKey = briefingDir;
  const now = Date.now();
  const mtimeMs = _briefingDirMtimeMs();
  const cached = _briefingListCache.get(cacheKey);
  if (
    cached &&
    cached.mtimeMs === mtimeMs &&
    now - cached.at < BRIEFING_LIST_TTL_MS
  ) {
    return cached.body;
  }

  const files = walkMd(briefingDir, VAULT_PATH, IGNORE_DIRS).filter(
    (p) => p.startsWith(`${BRIEFING_DIR}/`),
  );
  const out: BriefingListItem[] = [];
  for (const relPath of files) {
    const rec = readRecord(relPath);
    if (!rec) continue;
    const parsed = parseBriefingFilename(rec.stem);
    if (!parsed) continue;
    const fm = rec.fm;
    const slotFm = String(fm.slot ?? parsed.slot).toLowerCase();
    const slot: "morning" | "evening" =
      slotFm === "morning" || slotFm === "evening" ? slotFm : parsed.slot;
    const composed_at = _toIsoString(fm.composed_at);
    const prior_briefing_raw = String(fm.prior_briefing ?? "").trim();
    const prior_briefing = prior_briefing_raw || null;
    const window = {
      start: _toIsoString(fm.window_start),
      end: _toIsoString(fm.window_end) || composed_at,
    };
    const observed_matters_count = _coerceNonNegativeInt(fm.observed_matters_count);
    const state_changes_count = _coerceNonNegativeInt(fm.state_changes_count);
    const signals_count = _coerceNonNegativeInt(fm.signals_count);
    const decisions_count = _coerceNonNegativeInt(fm.decisions_count);
    out.push({
      path: relPath,
      slug_date: rec.stem,
      slot,
      date: parsed.date,
      composed_at: composed_at || `${parsed.date}T00:00:00Z`,
      prior_briefing,
      window,
      observed_matters_count,
      state_changes_count,
      signals_count,
      decisions_count,
    });
  }
  // Newest first by composed_at. Parse to epoch ms so we sort by real
  // chronology regardless of how YAML serialized the timestamp (Date
  // object → toString gives "Thu May 14 ..." which sorts incorrectly
  // as a raw string because 'T' < 'W').
  out.sort((a, b) => {
    const aT = Date.parse(a.composed_at);
    const bT = Date.parse(b.composed_at);
    return (Number.isFinite(bT) ? bT : 0) - (Number.isFinite(aT) ? aT : 0);
  });

  _briefingListCache.set(cacheKey, { at: now, mtimeMs, body: out });
  return out;
}

function _toIsoString(value: unknown): string {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : "";
  }
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  // Already ISO-ish (starts with 4-digit year + dash) — keep as-is.
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;
  // Fall back to Date.parse for human-readable forms ("Thu May 14 ..."),
  // which sort lexicographically wrong but round-trip cleanly through Date.
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : raw;
}

function _coerceNonNegativeInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

// Detail cache — each slug-date gets its own entry, mtime-keyed on the
// underlying .md file. We don't reuse the list cache here because the
// list intentionally strips the body to keep the response small; the
// detail endpoint serves the full body + raw frontmatter.
const _briefingDetailCache = new Map<
  string,
  { at: number; mtimeMs: number; body: BriefingDetail }
>();

function _readBriefingDetail(slugDate: string): BriefingDetail | null {
  const parsed = parseBriefingFilename(slugDate);
  if (!parsed) return null;
  const relPath = `${BRIEFING_DIR}/${slugDate}.md`;
  const absPath = path.join(VAULT_PATH, relPath);
  let mtimeMs = 0;
  try {
    const st = fs.statSync(absPath);
    mtimeMs = st.mtimeMs;
  } catch {
    return null;
  }

  const now = Date.now();
  const cached = _briefingDetailCache.get(slugDate);
  if (
    cached &&
    cached.mtimeMs === mtimeMs &&
    now - cached.at < BRIEFING_DETAIL_TTL_MS
  ) {
    return cached.body;
  }

  const rec = readRecord(relPath);
  if (!rec) return null;
  const fm = rec.fm;
  const slotFm = String(fm.slot ?? parsed.slot).toLowerCase();
  const slot: "morning" | "evening" =
    slotFm === "morning" || slotFm === "evening" ? slotFm : parsed.slot;
  const composed_at = _toIsoString(fm.composed_at) || `${parsed.date}T00:00:00Z`;
  const prior_briefing_raw = String(fm.prior_briefing ?? "").trim();
  const prior_briefing = prior_briefing_raw || null;
  const detail: BriefingDetail = {
    path: relPath,
    slug_date: rec.stem,
    slot,
    date: parsed.date,
    composed_at,
    prior_briefing,
    window: {
      start: _toIsoString(fm.window_start),
      end: _toIsoString(fm.window_end) || composed_at,
    },
    observed_matters_count: _coerceNonNegativeInt(fm.observed_matters_count),
    state_changes_count: _coerceNonNegativeInt(fm.state_changes_count),
    signals_count: _coerceNonNegativeInt(fm.signals_count),
    decisions_count: _coerceNonNegativeInt(fm.decisions_count),
    body: rec.body,
    frontmatter: fm,
  };

  _briefingDetailCache.set(slugDate, { at: now, mtimeMs, body: detail });
  return detail;
}

// SLUG-DATE matcher — used for the path parameter validation. Mirrors
// parseBriefingFilename but operates on the raw URL segment before we
// touch the filesystem.
const SLUG_DATE_RE = /^\d{4}-\d{2}-\d{2}-(?:morning|evening)$/;

export function registerBriefingsRoutes(): void {
  // GET /api/v1/briefings — list briefings, slot+window filters.
  addRoute("GET", "/api/v1/briefings", async ({ res, query }) => {
    const slotParam = (query.get("slot") || "all").trim().toLowerCase();
    if (!["all", "morning", "evening"].includes(slotParam)) {
      throw new ValidationError(
        `slot must be one of morning|evening|all (got ${JSON.stringify(slotParam)})`,
      );
    }
    const since = (query.get("since") || "").trim();
    const until = (query.get("until") || "").trim();
    let limit = parseInt(query.get("limit") || `${DEFAULT_LIMIT}`, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    let items = _readAllBriefings();
    if (slotParam !== "all") {
      items = items.filter((b) => b.slot === slotParam);
    }
    if (since) {
      items = items.filter((b) => b.composed_at >= since);
    }
    if (until) {
      items = items.filter((b) => b.composed_at <= until);
    }
    const total = items.length;
    const briefings = items.slice(0, limit);
    sendJson(res, 200, { briefings, total });
  });

  // GET /api/v1/briefings/:slugDate — single full record.
  addRoute("GET", "/api/v1/briefings/:slugDate", async ({ res, params }) => {
    const slugDate = (params?.slugDate || "").trim();
    if (!slugDate || !SLUG_DATE_RE.test(slugDate)) {
      throw new ValidationError(
        `slug-date must match YYYY-MM-DD-(morning|evening) (got ${JSON.stringify(slugDate)})`,
      );
    }
    const detail = _readBriefingDetail(slugDate);
    if (!detail) {
      throw new NotFoundError(`briefing ${slugDate} not found`);
    }
    sendJson(res, 200, detail);
  });
}
