import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { dockerComposeCmd } from "../helpers.js";

const VAULT_PATH = "/mnt/encrypted/vault";
const ALFRED_DATA = "/mnt/encrypted/alfred";
const STREAMS_DIR = path.join(ALFRED_DATA, "streams");
const QUARANTINE_DIR = path.join(VAULT_PATH, "inbox", "_quarantine");
const ENV_PATH = "/opt/alfred/compose/.env";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkMdDir(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMdDir(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

interface ParsedFm {
  frontmatter: Record<string, string>;
  body: string;
}

function parseFrontmatter(content: string): ParsedFm {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: content };
  const yamlBlock = content.slice(4, end);
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  const fm: Record<string, string> = {};
  for (const line of yamlBlock.split("\n")) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)/);
    if (m) fm[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return { frontmatter: fm, body };
}

function readVaultRecords(dir: string): Array<{ path: string; name: string; status: string; type: string; created: string; frontmatter: Record<string, string>; body: string }> {
  const files = walkMdDir(dir);
  const records: Array<{ path: string; name: string; status: string; type: string; created: string; frontmatter: Record<string, string>; body: string }> = [];
  for (const fullPath of files) {
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const { frontmatter: fm, body } = parseFrontmatter(content);
      records.push({
        path: path.relative(VAULT_PATH, fullPath),
        name: fm.name || fm.subject || path.basename(fullPath, ".md"),
        status: fm.status || "",
        type: fm.type || "",
        created: fm.created || "",
        frontmatter: fm,
        body,
      });
    } catch {
      // skip unreadable files
    }
  }
  return records;
}

function countStreamEvents(streamId: string): number {
  const safe = streamId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(STREAMS_DIR, `${safe}.jsonl`);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function setEnvVar(key: string, value: string): void {
  let content = "";
  try {
    content = fs.readFileSync(ENV_PATH, "utf-8");
  } catch {
    // .env may not exist yet
  }
  const lines = content.split("\n");
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${key}=`)) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }
  if (!found) lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_PATH, lines.join("\n"));
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerLearningRoutes(): void {

  // GET /api/v1/learning/status — overall learning subsystem stats
  addRoute("GET", "/api/v1/learning/status", async ({ res }) => {
    const observationDir = path.join(VAULT_PATH, "observation");
    const instinctDir = path.join(VAULT_PATH, "intuition", "instincts");
    const reflectionDir = path.join(VAULT_PATH, "reflection");
    const eventDir = path.join(VAULT_PATH, "event");

    const observations = readVaultRecords(observationDir);
    const instincts = readVaultRecords(instinctDir);
    const reflections = readVaultRecords(reflectionDir);
    const streamProcessed = countStreamEvents("system-openclaw-sessions");

    // Check if alfred-learn is enabled
    let enabled = true;
    try {
      const envContent = fs.readFileSync(ENV_PATH, "utf-8");
      const match = envContent.match(/^ALFRED_LEARN_ENABLED=(.+)$/m);
      if (match) enabled = match[1].trim().toLowerCase() === "true";
    } catch {
      // default to true
    }

    // processedToday: count stream events processed today
    const todayPrefix = new Date().toISOString().slice(0, 10);
    let processedToday = 0;
    const processedEventsPath = path.join(STREAMS_DIR, "processed-events.json");
    try {
      const data = JSON.parse(fs.readFileSync(processedEventsPath, "utf-8"));
      const events = data.events as Record<string, { processed_at?: string }> | undefined;
      if (events) {
        for (const entry of Object.values(events)) {
          if (entry.processed_at && entry.processed_at.startsWith(todayPrefix)) {
            processedToday++;
          }
        }
      }
    } catch {
      // processed-events.json may not exist
    }

    // autoRouteRate: percentage of observations routed by alfred
    const totalObs = observations.length;
    let autoRouted = 0;
    if (totalObs > 0) {
      for (const obs of observations) {
        if (obs.frontmatter.routed_by === "alfred") {
          autoRouted++;
        }
      }
    }
    const autoRouteRate = totalObs > 0 ? Math.round((autoRouted / totalObs) * 100) : 0;

    // queueSize: count of unrouted inputs across the vault
    const allFiles = walkMdDir(VAULT_PATH);
    let queueSize = 0;
    for (const fullPath of allFiles) {
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const { frontmatter: fm } = parseFrontmatter(content);
        if (fm.status === "unrouted") queueSize++;
      } catch {
        // skip
      }
    }

    // recentActivity: last 20 lines from activity log
    const activityLogPath = "/mnt/encrypted/alfred/learn-activity.jsonl";
    let recentActivity: unknown[] = [];
    try {
      const content = fs.readFileSync(activityLogPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      recentActivity = lines.slice(-20).reverse().map((line: string) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
    } catch {
      // activity log may not exist
    }

    // lastDigest: find the most recent event file with tag "digest"
    let lastDigest: { timestamp: string; path: string; summary: string } | null = null;
    const eventRecords = readVaultRecords(eventDir);
    const digestRecords = eventRecords.filter((r) =>
      r.frontmatter.tag === "digest" || r.frontmatter.tags?.includes("digest")
    );
    if (digestRecords.length > 0) {
      digestRecords.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
      const latest = digestRecords[0];
      lastDigest = {
        timestamp: latest.created,
        path: latest.path,
        summary: latest.body.slice(0, 500),
      };
    }

    sendJson(res, 200, {
      enabled,
      observations: {
        total: observations.length,
        unprocessed: observations.filter((r) => r.status === "unprocessed").length,
        processed: observations.filter((r) => r.status === "processed").length,
        invalid: observations.filter((r) => r.status === "invalid").length,
      },
      instincts: {
        total: instincts.length,
        active: instincts.filter((r) => r.status === "active").length,
        proposed: instincts.filter((r) => r.status === "proposed").length,
        deprecated: instincts.filter((r) => r.status === "deprecated").length,
        merged: instincts.filter((r) => r.status === "merged").length,
      },
      reflections: { total: reflections.length },
      streams: { processed: streamProcessed },
      processedToday,
      autoRouteRate,
      queueSize,
      recentActivity,
      instinctCount: instincts.length,
      lastDigest,
    });
  });

  // GET /api/v1/learning/observations — paginated observation records
  addRoute("GET", "/api/v1/learning/observations", async ({ res, query }) => {
    const limit = Math.min(parseInt(query.get("limit") || "20", 10), 200);
    const offset = parseInt(query.get("offset") || "0", 10);

    const dir = path.join(VAULT_PATH, "observation");
    const records = readVaultRecords(dir);
    records.sort((a, b) => (b.created || "").localeCompare(a.created || ""));

    const page = records.slice(offset, offset + limit);
    sendJson(res, 200, { items: page, total: records.length, limit, offset });
  });

  // GET /api/v1/learning/instincts — list instinct records
  addRoute("GET", "/api/v1/learning/instincts", async ({ res }) => {
    const dir = path.join(VAULT_PATH, "intuition", "instincts");
    const records = readVaultRecords(dir);
    records.sort((a, b) => a.name.localeCompare(b.name));
    sendJson(res, 200, { items: records, total: records.length });
  });

  // GET /api/v1/learning/reflections — list reflection records
  addRoute("GET", "/api/v1/learning/reflections", async ({ res }) => {
    const dir = path.join(VAULT_PATH, "reflection");
    const records = readVaultRecords(dir);
    records.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
    sendJson(res, 200, { items: records, total: records.length });
  });

  // GET /api/v1/learning/queue — unrouted inputs
  addRoute("GET", "/api/v1/learning/queue", async ({ res }) => {
    const files = walkMdDir(VAULT_PATH);
    const unrouted: Array<{ path: string; name: string; type: string; created: string }> = [];
    for (const fullPath of files) {
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const { frontmatter: fm } = parseFrontmatter(content);
        if (fm.status === "unrouted") {
          unrouted.push({
            path: path.relative(VAULT_PATH, fullPath),
            name: fm.name || fm.subject || path.basename(fullPath, ".md"),
            type: fm.type || "",
            created: fm.created || "",
          });
        }
      } catch {
        // skip
      }
    }
    sendJson(res, 200, { items: unrouted, total: unrouted.length });
  });

  // POST /api/v1/learning/route — route an input to a destination
  addRoute("POST", "/api/v1/learning/route", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.input_id !== "string" || typeof b.destination !== "string") {
      throw new ValidationError("input_id and destination are required");
    }

    const inputId = b.input_id as string;
    const destination = b.destination as string;

    // Read the input record
    const inputPath = path.join(VAULT_PATH, inputId);
    let content: string;
    try {
      content = fs.readFileSync(inputPath, "utf-8");
    } catch {
      throw new NotFoundError(`Input not found: ${inputId}`);
    }

    const { frontmatter: fm } = parseFrontmatter(content);

    // Move the file to destination directory
    const destDir = path.join(VAULT_PATH, destination);
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, path.basename(inputId));
    fs.renameSync(inputPath, destPath);

    // Write an observation record for the routing action
    const obsDir = path.join(VAULT_PATH, "observation");
    fs.mkdirSync(obsDir, { recursive: true });
    const ts = new Date().toISOString();
    const obsName = `route-${sanitizeId(path.basename(inputId, ".md"))}-${ts.replace(/[:.]/g, "-")}`;
    const obsMd = [
      "---",
      `type: observation`,
      `status: unprocessed`,
      `name: '${obsName}'`,
      `created: ${ts}`,
      `source: api-route`,
      `input_ref: ${inputId}`,
      `destination: ${destination}`,
      "---",
      "",
      `Routed ${inputId} to ${destination}.`,
      "",
      `Original type: ${fm.type || "unknown"}`,
      `Original status: ${fm.status || "unknown"}`,
    ].join("\n");
    fs.writeFileSync(path.join(obsDir, `${obsName}.md`), obsMd, "utf-8");

    sendJson(res, 200, {
      message: `Routed ${inputId} to ${destination}`,
      observation: `observation/${obsName}.md`,
    });
  });

  // POST /api/v1/learning/bootstrap — add alfred-learn to compose + start it
  // Safe to call on any tenant (new or existing). Idempotent.
  addRoute("POST", "/api/v1/learning/bootstrap", async ({ res }) => {
    const composePath = "/opt/alfred/compose/docker-compose.yaml";
    let compose = "";
    try {
      compose = fs.readFileSync(composePath, "utf-8");
    } catch {
      throw new ValidationError("docker-compose.yaml not found");
    }

    // Only patch if alfred-learn not already present
    if (!compose.includes("alfred-learn:")) {
      const serviceBlock = `
  alfred-learn:
    image: ssdavidai00/alfred-learn:latest
    depends_on:
      temporal:
        condition: service_healthy
      openclaw:
        condition: service_healthy
    volumes:
      - /mnt/encrypted/vault:/vault
      - /mnt/encrypted/alfred:/alfred-data
    environment:
      - TEMPORAL_HOST=temporal:7233
      - OPENCLAW_GATEWAY_URL=http://openclaw:18789
      - OPENCLAW_GATEWAY_TOKEN_FILE=/alfred-data/.gateway-token
      - VAULT_PATH=/vault
      - TASK_QUEUE=alfred-learn
      - ALFRED_LEARN_ENABLED=\${ALFRED_LEARN_ENABLED:-true}
    env_file:
      - .env
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    mem_limit: 1g
    pids_limit: 128
`;
      // Append before the last line (or at end of services block)
      compose = compose.trimEnd() + "\n" + serviceBlock + "\n";
      fs.writeFileSync(composePath, compose, "utf-8");
    }

    // Pull latest image
    try {
      await dockerComposeCmd(["pull", "alfred-learn"]);
    } catch {
      // ignore pull errors (will use cached if available)
    }

    // Start the container
    await dockerComposeCmd(["up", "-d", "alfred-learn"]);
    setEnvVar("ALFRED_LEARN_ENABLED", "true");

    sendJson(res, 200, { message: "Alfred Learn bootstrapped and started" });
  });

  // POST /api/v1/learning/enable — enable alfred-learn
  addRoute("POST", "/api/v1/learning/enable", async ({ res }) => {
    setEnvVar("ALFRED_LEARN_ENABLED", "true");
    try {
      await dockerComposeCmd(["up", "-d", "alfred-learn"]);
    } catch {
      // container may not exist yet in older deployments
    }
    sendJson(res, 200, { message: "Alfred Learn enabled", enabled: true });
  });

  // POST /api/v1/learning/disable — disable alfred-learn
  addRoute("POST", "/api/v1/learning/disable", async ({ res }) => {
    setEnvVar("ALFRED_LEARN_ENABLED", "false");
    try {
      await dockerComposeCmd(["stop", "alfred-learn"]);
    } catch {
      // container may not be running
    }
    sendJson(res, 200, { message: "Alfred Learn disabled", enabled: false });
  });

  // GET /api/v1/learning/quarantine — list quarantined files
  addRoute("GET", "/api/v1/learning/quarantine", async ({ res }) => {
    let files: string[] = [];
    try {
      files = fs.readdirSync(QUARANTINE_DIR).filter((f) => !f.startsWith("."));
    } catch {
      // quarantine dir may not exist
    }

    const items = files.map((f) => {
      const fullPath = path.join(QUARANTINE_DIR, f);
      let size = 0;
      let mtime = "";
      try {
        const stat = fs.statSync(fullPath);
        size = stat.size;
        mtime = stat.mtime.toISOString();
      } catch {
        // skip stat errors
      }
      return { id: f, filename: f, size, modified_at: mtime };
    });

    sendJson(res, 200, { files: items, total: items.length });
  });

  // POST /api/v1/learning/quarantine/:id/retry — move back to inbox
  addRoute("POST", "/api/v1/learning/quarantine/:id/retry", async ({ res, params }) => {
    const id = sanitizeId(params.id);
    const src = path.join(QUARANTINE_DIR, id);
    const dest = path.join(VAULT_PATH, "inbox", id);

    if (!fs.existsSync(src)) {
      throw new NotFoundError(`Quarantined file not found: ${id}`);
    }

    fs.mkdirSync(path.join(VAULT_PATH, "inbox"), { recursive: true });
    fs.renameSync(src, dest);
    sendJson(res, 200, { message: `Moved ${id} back to inbox` });
  });

  // POST /api/v1/learning/quarantine/:id/dismiss — delete quarantined file
  addRoute("POST", "/api/v1/learning/quarantine/:id/dismiss", async ({ res, params }) => {
    const id = sanitizeId(params.id);
    const filePath = path.join(QUARANTINE_DIR, id);

    if (!fs.existsSync(filePath)) {
      throw new NotFoundError(`Quarantined file not found: ${id}`);
    }

    fs.unlinkSync(filePath);
    sendJson(res, 200, { message: `Dismissed quarantined file: ${id}` });
  });

  // GET /api/v1/learning/observations/:id — single observation detail
  addRoute("GET", "/api/v1/learning/observations/:id", async ({ res, params }) => {
    const id = sanitizeId(params.id);
    const filePath = path.join(VAULT_PATH, "observation", id);

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      throw new NotFoundError(`Observation not found: ${id}`);
    }

    const { frontmatter, body } = parseFrontmatter(content);
    sendJson(res, 200, {
      path: path.join("observation", id),
      frontmatter,
      body,
    });
  });

  // GET /api/v1/learning/instincts/:id — single instinct detail
  addRoute("GET", "/api/v1/learning/instincts/:id", async ({ res, params }) => {
    const id = sanitizeId(params.id);
    const filePath = path.join(VAULT_PATH, "intuition", "instincts", id);

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      throw new NotFoundError(`Instinct not found: ${id}`);
    }

    const { frontmatter, body } = parseFrontmatter(content);
    sendJson(res, 200, {
      path: path.join("intuition", "instincts", id),
      frontmatter,
      body,
    });
  });

  // GET /api/v1/learning/sessions — list session records
  addRoute("GET", "/api/v1/learning/sessions", async ({ res }) => {
    const dir = path.join(VAULT_PATH, "session");
    const records = readVaultRecords(dir);
    records.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
    sendJson(res, 200, { items: records, total: records.length });
  });
}
