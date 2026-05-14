// /api/v1/brief/today — today's letterpress brief.
//
// The DailyDigestWorkflow (alfred-learn, daily 6pm) writes a vault record
// of `type: event` with `tags: [digest, daily]`. The path is
// `event/YYYY/MM/DD/<slug>.md`. This route finds today's most-recent
// digest record and renders it into the shape /brief expects:
//
//   {
//     date: "2026-05-12",
//     subject: "Your Brief.",
//     sections: [{ title, items: [{ id, line, reasoning }] }],
//     small_matter: string | null,
//   }
//
// Body parsing — the digest body is markdown with `## <Section>` headings
// each followed by a bullet list. We split the body on h2 headings, then
// turn each `- item` line into a `{ line }` entry. There is no separate
// `reasoning` field in the digest today, so reasoning is left empty; the
// frontend renders it only when present.
//
// Empty / no-digest-yet responses return 200 with `sections: []` so the
// page renders a polite "Nothing yet" instead of a 404 error toast.
import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";
import { VAULT_PATH, walkMd, readRecord } from "./vault.js";

const IGNORE_DIRS = new Set([".git", ".obsidian", "node_modules", ".trash"]);

interface BriefItem {
  id: string;
  line: string;
  reasoning: string;
}

interface BriefSection {
  title: string;
  items: BriefItem[];
}

interface BriefResponse {
  date: string;
  subject: string;
  sections: BriefSection[];
  small_matter: string | null;
}

/** Parse the digest body into sections + a trailing "small matter" line.
 *
 * The DailyDigest writer (`packages/learn/src/activities/vault.py
 * write_digest_record`) emits:
 *
 *     # <title>
 *
 *     <summary>
 *
 *     ## Highlights
 *     - bullet
 *     - bullet
 *
 *     <body>
 *
 * For the letterpress brief we treat:
 *   - the leading h1 + summary as a header (rendered separately by the
 *     page from the frontmatter)
 *   - every `## <name>` section as a brief section
 *   - bullets as items
 *   - any *italic* trailing paragraph (after the last section) as the
 *     "small matter" — this is the convention the writer follows when it
 *     has one
 */
function parseDigestBody(body: string): {
  sections: BriefSection[];
  small_matter: string | null;
} {
  if (!body) return { sections: [], small_matter: null };
  const lines = body.split("\n");
  const sections: BriefSection[] = [];
  let cur: BriefSection | null = null;
  let trailingItalics: string[] = [];
  let inLeadIn = true;
  let itemIdx = 0;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      cur = { title: h2[1], items: [] };
      sections.push(cur);
      inLeadIn = false;
      trailingItalics = [];
      continue;
    }
    if (inLeadIn) continue; // skip h1 + summary; the page renders these separately
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (bullet && cur) {
      cur.items.push({
        id: `${sections.length}-${itemIdx++}`,
        line: bullet[1],
        reasoning: "",
      });
      continue;
    }
    // After all sections, an italic paragraph is the "small matter".
    const italic = /^\*(.+)\*\s*$/.exec(line) || /^_(.+)_\s*$/.exec(line);
    if (italic) trailingItalics.push(italic[1]);
  }
  const small_matter = trailingItalics.length
    ? trailingItalics.join(" ").trim() || null
    : null;
  return { sections, small_matter };
}

/** Find today's (or most-recent) digest record under event/. */
function findTodaysDigest(): {
  path: string;
  fm: Record<string, unknown>;
  body: string;
} | null {
  const files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS).filter((p) =>
    p.startsWith("event/"),
  );
  // Today's date as YYYY-MM-DD prefix in `created`. We accept the
  // newest digest from the last 7 days as a fallback so the brief page
  // stays populated even if the 6pm workflow hasn't fired yet today.
  const today = new Date().toISOString().slice(0, 10);
  const candidates: Array<{
    path: string;
    fm: Record<string, unknown>;
    body: string;
    created: string;
  }> = [];
  for (const rel of files) {
    const rec = readRecord(rel);
    if (!rec) continue;
    const fm = rec.fm;
    const tags = Array.isArray(fm.tags) ? (fm.tags as unknown[]) : [];
    const isDigest =
      tags.some((t) => String(t).toLowerCase() === "digest") ||
      tags.some((t) => String(t).toLowerCase() === "daily");
    if (!isDigest) continue;
    const created = String(fm.created ?? "");
    candidates.push({ path: rel, fm, body: rec.body, created });
  }
  if (candidates.length === 0) return null;
  // Prefer today; otherwise newest-first.
  candidates.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  const todays = candidates.find((c) => c.created.startsWith(today));
  return todays ?? candidates[0];
}

export function registerBriefRoutes(): void {
  addRoute("GET", "/api/v1/brief/today", async ({ res }) => {
    const today = new Date().toISOString().slice(0, 10);
    const found = findTodaysDigest();
    if (!found) {
      const empty: BriefResponse = {
        date: today,
        subject: "Your Brief.",
        sections: [],
        small_matter: null,
      };
      sendJson(res, 200, empty);
      return;
    }
    const parsed = parseDigestBody(found.body);
    const created = String(found.fm.created ?? "");
    const dateStr = created ? created.slice(0, 10) : today;
    const subject = String(found.fm.name ?? found.fm.title ?? "Your Brief.");
    const payload: BriefResponse = {
      date: dateStr,
      subject,
      sections: parsed.sections,
      small_matter: parsed.small_matter,
    };
    sendJson(res, 200, payload);
  });
}
