// /api/v1/matters — long-running concerns aggregator (#859).
//
// Matters in Alfred Black's vocabulary map to vault `project` records.
// Each Project has connected Conversation / Decision / Task / Note records
// that point at it via frontmatter (`project: [[<slug>]]`, `parent_matter`,
// `references`, etc.). This route walks the vault once, builds a per-matter
// tally, and surfaces the data the /matters index + detail pages need.
//
// Endpoints:
//   GET /api/v1/matters
//     → { matters: [{ id, name, summary, last, next, counts: {...} }] }
//
//   GET /api/v1/matters/:id
//     → {
//         matter: {
//           id, name, summary, last, next,
//           about,
//           counts: { conversations, decisions, tasks, drafts },
//           recent_decisions: [{ date, label, outcome, path }],
//           vault_by_category: { conversations: [{title, path}], decisions, tasks, drafts },
//         }
//       }
//
// Path conventions (`matter/<slug>.md` is the file). The detail route
// accepts both `<slug>` and `matter/<slug>` for ergonomics.
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, NotFoundError } from "../errors.js";
import { VAULT_PATH, walkMd, readRecord } from "./vault.js";

const IGNORE_DIRS = new Set([".git", ".obsidian", "node_modules", ".trash"]);

interface MatterIndexRow {
  id: string;
  path: string;
  name: string;
  summary: string;
  last: string;
  next: string;
  counts: {
    conversations: number;
    decisions: number;
    tasks: number;
    drafts: number;
  };
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

interface MatterDetail extends MatterIndexRow {
  about: string;
  recent_decisions: RecentDecision[];
  vault_by_category: {
    conversations: VaultLink[];
    decisions: VaultLink[];
    tasks: VaultLink[];
    drafts: VaultLink[];
  };
}

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

/** Walk all records once and group by matter id. */
function buildMatterIndex(): {
  byId: Map<string, MatterDetail>;
  ordered: MatterDetail[];
} {
  const files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
  const byId = new Map<string, MatterDetail>();
  const childrenByMatter = new Map<
    string,
    { type: string; rec: { fm: Record<string, unknown>; body: string; stem: string }; relPath: string }[]
  >();

  // First pass — pull every project record into the index.
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
    });
  }

  // Second pass — bin every other record by which matter it touches.
  for (const relPath of files) {
    const display = relPath.replace(/\\/g, "/");
    if (display.startsWith("matter/")) continue;
    const rec = readRecord(relPath);
    if (!rec) continue;
    const recType = String(rec.fm.type ?? "");
    if (!recType) continue;

    // Collect all candidate matter refs from this record.
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

  // Third pass — fold children into matter detail.
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
        case "task":
          matter.counts.tasks += 1;
          matter.vault_by_category.tasks.push(link);
          break;
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
    }));
    sendJson(res, 200, { matters, count: matters.length });
  });

  addRoute("GET", "/api/v1/matters/:id", async ({ res, params }) => {
    const id = normalizeMatterId(params.id);
    if (!id) throw new NotFoundError("Matter not found");
    const { byId } = buildMatterIndex();
    const matter = byId.get(id);
    if (!matter) throw new NotFoundError("Matter not found");
    sendJson(res, 200, { matter });
  });
}

// Re-exported for tests / future tooling.
export const _internal = { buildMatterIndex, normalizeMatterId };
