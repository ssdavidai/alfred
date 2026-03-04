import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { dockerExec, ALFRED_CMD } from "../helpers.js";

const VAULT_PATH = "/mnt/encrypted/vault";
const INBOX_PATH = `${VAULT_PATH}/inbox`;
const VAULT_ENV = { ALFRED_VAULT_PATH: "/vault" };

const IGNORE_DIRS = new Set(["_templates", "_bases", "_docs", ".obsidian", "view", "inbox", "dashboard"]);

const KNOWN_TYPES = [
  "person", "org", "project", "task", "event", "note", "location",
  "process", "account", "asset", "conversation", "input", "run",
  "session", "decision",
  "assumption", "constraint", "contradiction", "synthesis",
  "observation", "instinct",
];

const STATUS_BY_TYPE: Record<string, string[]> = {
  project: ["active", "paused", "completed", "abandoned", "proposed"],
  task: ["todo", "active", "blocked", "done", "cancelled"],
  session: ["active", "paused", "finished"],
  input: ["unprocessed", "processed", "deferred"],
  person: ["active", "inactive"],
  org: ["active", "inactive"],
  location: ["active", "inactive"],
  note: ["draft", "active", "review", "final"],
  decision: ["draft", "final", "superseded", "reversed"],
  process: ["active", "proposed", "design", "deprecated"],
  run: ["active", "completed", "blocked", "cancelled"],
  account: ["active", "suspended", "closed", "pending"],
  asset: ["active", "retired", "maintenance", "disposed"],
  conversation: ["active", "waiting", "resolved", "closed", "archived"],
  assumption: ["active", "challenged", "invalidated", "confirmed"],
  constraint: ["active", "expired", "waived", "superseded"],
  contradiction: ["unresolved", "resolved", "accepted"],
  synthesis: ["draft", "active", "superseded"],
  observation: ["unprocessed", "processed", "invalid"],
  instinct: ["active", "proposed", "deprecated", "merged"],
};

const TYPE_DIRECTORY: Record<string, string> = {
  project: "project",
  task: "task",
  person: "person",
  org: "org",
  location: "location",
  note: "note",
  decision: "decision",
  process: "process",
  run: "run",
  event: "event",
  account: "account",
  asset: "asset",
  conversation: "conversation",
  assumption: "assumption",
  constraint: "constraint",
  contradiction: "contradiction",
  synthesis: "synthesis",
  observation: "observation",
  instinct: "intuition/instincts",
};

const LIST_FIELDS = [
  "tags", "aliases", "related", "relationships", "participants",
  "outputs", "depends_on", "blocked_by", "based_on", "supports",
  "challenged_by", "approved_by", "confirmed_by", "invalidated_by",
  "cluster_sources", "governed_by", "references", "project",
];

const REQUIRED_FIELDS = ["type", "created"];

const NAME_FIELD_BY_TYPE: Record<string, string> = {
  conversation: "subject",
  input: "subject",
};

// ---------------------------------------------------------------------------
// Security: path validation & resolution
// ---------------------------------------------------------------------------

/** Resolve a relative vault path to an absolute path, rejecting traversal. */
function resolveVaultPath(relPath: string): string {
  if (relPath.includes("\0")) throw new ValidationError("Invalid path");
  const normalized = path.normalize(relPath);
  if (path.isAbsolute(normalized)) throw new ValidationError("Absolute paths not allowed");
  if (normalized.startsWith("..")) throw new ValidationError("Path traversal denied");
  const full = path.resolve(VAULT_PATH, normalized);
  const base = path.resolve(VAULT_PATH);
  if (!full.startsWith(base + path.sep) && full !== base) {
    throw new ValidationError("Path traversal denied");
  }
  return full;
}

// ---------------------------------------------------------------------------
// Lightweight YAML frontmatter parser (no npm dependency)
// ---------------------------------------------------------------------------

interface ParsedRecord {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(content: string): ParsedRecord {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }
  const yamlBlock = content.slice(4, end);
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  const fm: Record<string, unknown> = {};
  let currentKey = "";
  let listValues: string[] | null = null;
  let multiLineQuote = ""; // accumulates multi-line quoted strings
  let multiLineChar = ""; // the quote character (' or ")

  const lines = yamlBlock.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    // Multi-line quoted string continuation
    if (multiLineChar) {
      const trimmed = line.trimEnd();
      if (trimmed.endsWith(multiLineChar)) {
        multiLineQuote += " " + trimmed.slice(0, -1).trim();
        fm[currentKey] = multiLineQuote;
        multiLineQuote = "";
        multiLineChar = "";
      } else {
        multiLineQuote += " " + trimmed.trim();
      }
      continue;
    }

    // List continuation: "- value"
    if (listValues !== null && /^\s+-\s/.test(line)) {
      listValues.push(line.replace(/^\s+-\s*/, "").replace(/^['"]|['"]$/g, "").trim());
      continue;
    }
    // Flush any pending list
    if (listValues !== null) {
      fm[currentKey] = listValues;
      listValues = null;
    }
    // "key: value" or "key:"
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)/);
    if (!m) continue;
    currentKey = m[1];
    let val = m[2].trim();
    if (val === "[]") {
      fm[currentKey] = [];
      continue;
    }
    if (val === "" || val === "null") {
      if (val === "null") {
        fm[currentKey] = "";
        continue;
      }
      // Could be empty scalar or start of block list — peek ahead
      listValues = [];
      continue;
    }
    // Inline list: [a, b, c]
    if (val.startsWith("[") && val.endsWith("]")) {
      fm[currentKey] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
      continue;
    }
    // Strip quotes — handle multi-line quoted strings
    if ((val.startsWith("'") || val.startsWith('"'))) {
      const qc = val[0];
      if (val.endsWith(qc) && val.length > 1) {
        val = val.slice(1, -1);
      } else {
        // Multi-line quoted string — accumulate until closing quote
        multiLineChar = qc;
        multiLineQuote = val.slice(1);
        continue;
      }
    }
    fm[currentKey] = val;
  }
  if (multiLineChar) fm[currentKey] = multiLineQuote;
  if (listValues !== null) fm[currentKey] = listValues;
  return { frontmatter: fm, body };
}

// ---------------------------------------------------------------------------
// Recursive .md file walker (sync, fast)
// ---------------------------------------------------------------------------

function walkMd(dir: string, base: string, ignoreDirs: Set<string>): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoreDirs.has(entry.name)) continue;
      results.push(...walkMd(path.join(dir, entry.name), base, ignoreDirs));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(path.relative(base, path.join(dir, entry.name)));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Shared read helper
// ---------------------------------------------------------------------------

function readRecord(relPath: string): { fm: Record<string, unknown>; body: string; stem: string } | null {
  const fullPath = path.join(VAULT_PATH, relPath);
  let content: string;
  try {
    content = fs.readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }
  const { frontmatter: fm, body } = parseFrontmatter(content);
  const stem = path.basename(relPath, ".md");
  return { fm, body, stem };
}

function sanitizeFilename(name: string): string {
  const sanitized = name.replace(/[\/\\:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new ValidationError("Invalid filename");
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerVaultRoutes(): void {

  // --- READ OPERATIONS: direct filesystem (fast, no docker overhead) ---

  // Vault context — returns all records grouped by type
  addRoute("GET", "/api/v1/vault/context", async ({ res }) => {
    const files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
    const byType: Record<string, Array<{ path: string; name: string; status: string }>> = {};

    for (const relPath of files) {
      const rec = readRecord(relPath);
      if (!rec) continue;
      const recType = String(rec.fm.type || "");
      if (!recType) continue;

      const display = relPath.replace(/\\/g, "/").replace(/\.md$/, "");
      byType[recType] = byType[recType] || [];
      byType[recType].push({
        path: display,
        name: rec.stem,
        status: String(rec.fm.status || ""),
      });
    }
    sendJson(res, 200, {
      records_by_type: byType,
      total: Object.values(byType).reduce((s, a) => s + a.length, 0),
    });
  });

  // Vault search — glob and/or grep
  addRoute("GET", "/api/v1/vault/search", async ({ res, query }) => {
    const globPat = query.get("glob");
    const grepPat = query.get("grep");

    // Validate glob (no traversal)
    if (globPat && (globPat.includes("..") || path.isAbsolute(globPat))) {
      throw new ValidationError("Invalid glob pattern");
    }

    let files: string[];
    if (globPat) {
      // Use Node glob-style: list all md files, then match against pattern
      const all = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
      const re = globToRegex(globPat);
      files = all.filter((f) => re.test(f));
    } else {
      files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
    }

    const results: Array<{ path: string; name: string; type: string; status: string }> = [];
    for (const relPath of files) {
      if (grepPat) {
        try {
          const content = fs.readFileSync(path.join(VAULT_PATH, relPath), "utf-8");
          if (!content.toLowerCase().includes(grepPat.toLowerCase())) continue;
        } catch {
          continue;
        }
      }
      const rec = readRecord(relPath);
      if (!rec) continue;
      results.push({
        path: relPath.replace(/\\/g, "/"),
        name: String(rec.fm.name || rec.fm.subject || rec.stem),
        type: String(rec.fm.type || ""),
        status: String(rec.fm.status || ""),
      });
    }
    sendJson(res, 200, { results, count: results.length });
  });

  // Vault list by type
  addRoute("GET", "/api/v1/vault/list/:type", async ({ res, params }) => {
    const type = params.type;
    if (!KNOWN_TYPES.includes(type)) {
      throw new ValidationError(`Unknown vault type: ${type}. Known types: ${KNOWN_TYPES.join(", ")}`);
    }
    const files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);
    const results: Array<{ path: string; name: string; status: string }> = [];
    for (const relPath of files) {
      const rec = readRecord(relPath);
      if (!rec) continue;
      if (rec.fm.type !== type) continue;
      results.push({
        path: relPath.replace(/\\/g, "/"),
        name: String(rec.fm.name || rec.fm.subject || rec.stem),
        status: String(rec.fm.status || ""),
      });
    }
    results.sort((a, b) => a.name.localeCompare(b.name));
    sendJson(res, 200, { results, count: results.length });
  });

  // Read vault record
  addRoute("GET", "/api/v1/vault/records/*", async ({ res, params }) => {
    let relPath = params.path;
    resolveVaultPath(relPath); // validate traversal
    let rec = readRecord(relPath);
    // Try appending .md if the path doesn't have it
    if (!rec && !relPath.endsWith(".md")) {
      relPath = relPath + ".md";
      resolveVaultPath(relPath);
      rec = readRecord(relPath);
    }
    if (!rec) {
      sendJson(res, 404, { error: "Record not found" });
      return;
    }
    sendJson(res, 200, { path: relPath, frontmatter: rec.fm, body: rec.body });
  });

  // --- WRITE OPERATIONS: keep docker-exec for safety (scope, logging) ---

  // Create vault record
  addRoute("POST", "/api/v1/vault/records", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.type !== "string" || typeof b.name !== "string") {
      throw new ValidationError("type and name are required");
    }

    const args = [...ALFRED_CMD, "vault", "create", b.type as string, b.name as string];
    if (b.fields && typeof b.fields === "object") {
      for (const [k, v] of Object.entries(b.fields as Record<string, string>)) {
        args.push("--set", `${k}=${String(v)}`);
      }
    }

    const stdout = await dockerExec("alfred", args, VAULT_ENV);
    try {
      sendJson(res, 201, JSON.parse(stdout));
    } catch {
      sendJson(res, 201, { raw: stdout });
    }
  });

  // Edit vault record
  addRoute("PATCH", "/api/v1/vault/records/*", async ({ res, params, body }) => {
    const recordPath = params.path;
    const b = body as Record<string, unknown> | undefined;
    if (!b) throw new ValidationError("Request body required");

    const args = [...ALFRED_CMD, "vault", "edit", recordPath];
    if (b.set && typeof b.set === "object") {
      for (const [k, v] of Object.entries(b.set as Record<string, string>)) {
        args.push("--set", `${k}=${String(v)}`);
      }
    }
    if (b.append && typeof b.append === "object") {
      for (const [k, v] of Object.entries(b.append as Record<string, string>)) {
        args.push("--append", `${k}=${String(v)}`);
      }
    }
    if (typeof b.body_append === "string") {
      args.push("--body-append", b.body_append as string);
    }
    // body-stdin is a flag, not an argument — would need stdin piping
    // For now, body-append handles most use cases

    const stdout = await dockerExec("alfred", args, VAULT_ENV);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout });
    }
  });

  // Move vault record
  addRoute("POST", "/api/v1/vault/move", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.from !== "string" || typeof b.to !== "string") {
      throw new ValidationError("from and to are required");
    }

    const stdout = await dockerExec("alfred", [...ALFRED_CMD, "vault", "move", b.from as string, b.to as string], VAULT_ENV);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout });
    }
  });

  // Delete vault record
  addRoute("DELETE", "/api/v1/vault/records/*", async ({ res, params }) => {
    const recordPath = params.path;
    const args = [...ALFRED_CMD, "vault", "delete", recordPath];

    const stdout = await dockerExec("alfred", args, VAULT_ENV);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, { raw: stdout });
    }
  });

  // --- GRAPH: nodes + edges + agent activity ---

  addRoute("GET", "/api/v1/vault/graph", async ({ res }) => {
    const AUDIT_LOG = "/mnt/encrypted/alfred/vault_audit.log";
    const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    const LINK_FIELDS = new Set([
      "related", "relationships", "participants", "outputs", "depends_on",
      "blocked_by", "based_on", "supports", "challenged_by", "references",
      "project", "approved_by", "confirmed_by", "invalidated_by",
      "governed_by", "cluster_sources",
    ]);

    const files = walkMd(VAULT_PATH, VAULT_PATH, IGNORE_DIRS);

    // Build a lookup of stem → relPath for wikilink resolution
    const stemToPath: Record<string, string> = {};
    // Also allow "type/Name" format
    for (const relPath of files) {
      const stem = path.basename(relPath, ".md");
      const display = relPath.replace(/\\/g, "/");
      stemToPath[stem] = display;
      // Also index "type/Name" (without .md)
      stemToPath[display.replace(/\.md$/, "")] = display;
    }

    interface GraphNode {
      id: string;
      type: string;
      name: string;
      status: string;
    }

    interface GraphEdge {
      source: string;
      target: string;
      relation: string;
    }

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const nodeIds = new Set<string>();

    for (const relPath of files) {
      const rec = readRecord(relPath);
      if (!rec) continue;
      const recType = String(rec.fm.type || "");
      if (!recType) continue;

      const display = relPath.replace(/\\/g, "/");
      const nameField = NAME_FIELD_BY_TYPE[recType] || "name";
      const name = String(rec.fm[nameField] || rec.stem);

      nodes.push({
        id: display,
        type: recType,
        name,
        status: String(rec.fm.status || ""),
      });
      nodeIds.add(display);

      // Extract edges from frontmatter list fields
      for (const field of LINK_FIELDS) {
        const val = rec.fm[field];
        if (!val) continue;
        const items = Array.isArray(val) ? val : [val];
        for (const item of items) {
          const s = String(item).trim();
          // Could be a wikilink [[...]] or bare name
          const wlMatch = s.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
          const ref = wlMatch ? wlMatch[1] : s;
          // Resolve to a file path
          const target = stemToPath[ref] || stemToPath[ref.replace(/\.md$/, "")];
          if (target && target !== display) {
            edges.push({ source: display, target, relation: field });
          }
        }
      }

      // Extract wikilinks from body text
      let wlm: RegExpExecArray | null;
      WIKILINK_RE.lastIndex = 0;
      while ((wlm = WIKILINK_RE.exec(rec.body)) !== null) {
        const ref = wlm[1].trim();
        const target = stemToPath[ref] || stemToPath[ref.replace(/\.md$/, "")];
        if (target && target !== display) {
          edges.push({ source: display, target, relation: "body_link" });
        }
      }
    }

    // Filter edges to only include nodes that exist
    const validEdges = edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));

    // Deduplicate edges (same source+target+relation)
    const edgeKeys = new Set<string>();
    const dedupedEdges: GraphEdge[] = [];
    for (const e of validEdges) {
      const key = `${e.source}|${e.target}|${e.relation}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        dedupedEdges.push(e);
      }
    }

    // Parse recent agent activity from audit log
    interface ActivityEntry {
      agent: string;
      file: string;
      action: string;
      ts: string;
    }
    const activity: ActivityEntry[] = [];
    try {
      const logContent = fs.readFileSync(AUDIT_LOG, "utf-8");
      const lines = logContent.split("\n").filter(Boolean).slice(-500);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.path || entry.file) {
            activity.push({
              agent: entry.tool || entry.scope || entry.agent || "unknown",
              file: entry.path || entry.file || "",
              action: entry.op || entry.action || entry.operation || "unknown",
              ts: entry.ts || entry.timestamp || "",
            });
          }
        } catch {
          // Skip non-JSON lines
        }
      }
    } catch {
      // Audit log may not exist yet
    }

    sendJson(res, 200, { nodes, edges: dedupedEdges, activity });
  });

  // --- STATIC / NON-VAULT ---

  // Vault schema
  addRoute("GET", "/api/v1/vault/schema", async ({ res }) => {
    sendJson(res, 200, {
      known_types: KNOWN_TYPES,
      status_by_type: STATUS_BY_TYPE,
      list_fields: LIST_FIELDS,
      required_fields: REQUIRED_FIELDS,
      name_field_by_type: NAME_FIELD_BY_TYPE,
      type_directory: TYPE_DIRECTORY,
    });
  });

  // Upload single file to inbox
  addRoute("POST", "/api/v1/vault/inbox", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.filename !== "string" || typeof b.content !== "string") {
      throw new ValidationError("filename and content are required");
    }
    const filename = sanitizeFilename(b.filename as string);
    const filePath = path.join(INBOX_PATH, filename);
    if (b.encoding === "base64") {
      fs.writeFileSync(filePath, Buffer.from(b.content as string, "base64"));
    } else {
      fs.writeFileSync(filePath, b.content as string, "utf-8");
    }
    sendJson(res, 201, { message: `Uploaded ${filename} to inbox`, filename });
  });

  // Upload multiple files to inbox
  addRoute("POST", "/api/v1/vault/inbox/bulk", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || !Array.isArray(b.files)) {
      throw new ValidationError("files array is required");
    }
    const results: string[] = [];
    for (const file of b.files as Array<{ filename: string; content: string; encoding?: string }>) {
      if (typeof file.filename !== "string" || typeof file.content !== "string") {
        throw new ValidationError("Each file must have filename and content");
      }
      const filename = sanitizeFilename(file.filename);
      const filePath = path.join(INBOX_PATH, filename);
      if (file.encoding === "base64") {
        fs.writeFileSync(filePath, Buffer.from(file.content, "base64"));
      } else {
        fs.writeFileSync(filePath, file.content, "utf-8");
      }
      results.push(filename);
    }
    sendJson(res, 201, { message: `Uploaded ${results.length} files to inbox`, filenames: results });
  });

  // List inbox files
  addRoute("GET", "/api/v1/vault/inbox", async ({ res }) => {
    let files: string[] = [];
    try {
      files = fs.readdirSync(INBOX_PATH).filter(f => !f.startsWith("."));
    } catch {
      // inbox dir may not exist yet
    }
    sendJson(res, 200, { files });
  });
}

// ---------------------------------------------------------------------------
// Simple glob-to-regex converter for vault search
// ---------------------------------------------------------------------------

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++; // skip second *
      if (glob[i + 1] === "/") i++; // skip trailing /
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, "i");
}
