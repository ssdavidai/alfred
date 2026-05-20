/**
 * Structlog activity feed parser.
 *
 * Parses docker compose log output from the alfred worker, maps structlog
 * events to human-readable messages, filters noise, and returns structured
 * activity items for the SaaS dashboard.
 */

export interface ActivityItem {
  timestamp: string;
  tool: "curator" | "janitor" | "distiller" | "surveyor" | "system";
  level: "info" | "warning" | "error";
  event: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Structlog line parser
// ---------------------------------------------------------------------------

// Docker compose log format: "SERVICE | TIMESTAMP [LEVEL ] event_name key=val ..."
// Sometimes the service prefix is absent (e.g. when fetching a single service).
// Structlog outputs ANSI color codes by default — strip them before matching.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const STRUCTLOG_RE =
  /^(?:\S+\s+\|\s+)?(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+\[(\w+)\s*\]\s+(\S+)\s*(.*)?$/;

const KV_RE = /(\w+)=(?:'([^']*)'|"([^"]*)"|(\S+))/g;

interface ParsedLine {
  timestamp: string;
  level: string;
  event: string;
  kv: Record<string, string>;
}

function parseLine(line: string): ParsedLine | null {
  // Strip ANSI color/style codes before parsing
  const clean = line.replace(ANSI_RE, "");
  const m = clean.match(STRUCTLOG_RE);
  if (!m) return null;

  const kv: Record<string, string> = {};
  const kvStr = m[4] ?? "";
  let match: RegExpExecArray | null;
  KV_RE.lastIndex = 0;
  while ((match = KV_RE.exec(kvStr)) !== null) {
    kv[match[1]] = match[2] ?? match[3] ?? match[4];
  }

  return {
    timestamp: m[1],
    level: m[2].toLowerCase(),
    event: m[3],
    kv,
  };
}

// ---------------------------------------------------------------------------
// Noise filter — events that are skipped entirely
// ---------------------------------------------------------------------------

const NOISE_EVENTS = new Set([
  "watcher.full_scan",
  "watcher.event",
  "watcher.started",
  "watcher.stopped",
  "watcher.no_changes",
  "state.loaded",
  "state.saved",
  "state.no_existing_state",
  "embedder.upserted",
  "embedder.deleted",
  "embedder.empty_text",
  "writer.snapshot",
  "daemon.tick",
  "daemon.sleeping",
  "daemon.no_changes",
  "config.loaded",
  "backend.initialized",
  "context.built",
  "pipeline.llm_call",
  "pipeline.manifest_parse_failed",
]);

// ---------------------------------------------------------------------------
// Event → tool mapping
// ---------------------------------------------------------------------------

const PREFIX_TOOL_MAP: Record<string, ActivityItem["tool"]> = {
  sweep: "janitor",
  autofix: "janitor",
  issue: "janitor",
  extraction: "distiller",
  embedder: "surveyor",
  clusterer: "surveyor",
  labeler: "surveyor",
  cluster: "surveyor",
  curator: "curator",
  janitor: "janitor",
  distiller: "distiller",
  surveyor: "surveyor",
};

// For shared prefixes (daemon.*, pipeline.*, context.*, writer.*) use specific event lookups
const SPECIFIC_TOOL_MAP: Record<string, ActivityItem["tool"]> = {
  "daemon.processing": "curator",
  "daemon.completed": "curator",
  "daemon.inbox_file": "curator",
  "daemon.pipeline_failed": "curator",
  "daemon.processing_diff": "surveyor",
  "daemon.labeling_complete": "surveyor",
  "daemon.embedding_complete": "surveyor",
  "daemon.deep_sweep": "janitor",
  "daemon.sweep_complete": "janitor",
  "daemon.deep_extraction": "distiller",
  "daemon.light_scan": "distiller",
  "daemon.extraction_complete": "distiller",
  "context.built": "system",
  "pipeline.start": "curator",
  "pipeline.llm_call": "curator",
  "pipeline.llm_nonzero_exit": "curator",
  "pipeline.s1_inbox_read": "curator",
  "pipeline.s1_complete": "curator",
  "pipeline.s1_failed": "curator",
  "pipeline.s1_no_note_created": "curator",
  "pipeline.s1_manifest_retry": "curator",
  "pipeline.manifest_parse_failed": "curator",
  "pipeline.s2_entity_created": "curator",
  "pipeline.s4_enriched": "curator",
  "pipeline.s3_created": "distiller",
  "writer.marked_processed": "curator",
  "daemon.started": "system",
  "daemon.stopped": "system",
  "daemon.shutdown": "system",
  "daemon.error": "system",
  "orchestrator.started": "system",
  "orchestrator.spawning": "system",
  "orchestrator.child_exited": "system",
  "orchestrator.shutdown": "system",
};

function inferTool(event: string): ActivityItem["tool"] {
  // Check specific event name first
  const specific = SPECIFIC_TOOL_MAP[event];
  if (specific) return specific;

  // Check prefix
  const prefix = event.split(".")[0];
  const byPrefix = PREFIX_TOOL_MAP[prefix];
  if (byPrefix) return byPrefix;

  return "system";
}

// ---------------------------------------------------------------------------
// Event → human-readable message
// ---------------------------------------------------------------------------

type MessageFn = (kv: Record<string, string>) => string;

const EVENT_MESSAGES: Record<string, MessageFn> = {
  // Curator
  "daemon.processing": (kv) => `Processing inbox file: ${kv.file || "unknown"}`,
  "daemon.completed": (kv) => {
    const parts = [];
    if (kv.created) parts.push(`${kv.created} created`);
    if (kv.modified) parts.push(`${kv.modified} modified`);
    return `Finished processing ${kv.file || "file"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
  },
  "daemon.inbox_file": (kv) => `New inbox file detected: ${kv.file || kv.path || "unknown"}`,
  "pipeline.s1_inbox_read": (kv) => `Reading inbox item: ${kv.file || kv.path || "unknown"}`,
  "pipeline.s2_entity_created": (kv) => `Created entity: ${kv.entity || kv.path || kv.type || "unknown"}`,
  "pipeline.s4_enriched": (kv) => `Enriched record: ${kv.path || kv.entity || "unknown"}`,
  "curator.scan_complete": (kv) => `Inbox scan complete — ${kv.found || "0"} files found`,
  "pipeline.start": (kv) => `Processing started: ${kv.file || "unknown"}`,
  "pipeline.s1_complete": (kv) => `Analysis complete — ${kv.entities_found || "0"} entities found`,
  "pipeline.s1_failed": (kv) => `Processing failed for ${kv.file || "unknown"}`,
  "pipeline.s1_no_note_created": (kv) => `No note created for ${kv.file || "unknown"}`,
  "pipeline.s1_manifest_retry": (kv) => `Retrying analysis (attempt ${kv.attempt || "?"}/${kv.max_attempts || "3"}) for ${kv.file || "unknown"}`,
  "pipeline.llm_nonzero_exit": (kv) => `AI agent returned error (exit code ${kv.code || "?"})`,
  "daemon.pipeline_failed": (kv) => `Pipeline failed: ${kv.summary || kv.file || "unknown error"}`,
  "writer.marked_processed": (kv) => `Moved to processed: ${kv.src?.split("/").pop() || kv.file || "unknown"}`,

  // Janitor
  "sweep.start": () => "Starting vault sweep",
  "sweep.complete": (kv) => `Sweep complete — ${kv.issues || "0"} issues found`,
  "sweep.clean": () => "Vault is clean — no issues found",
  "daemon.deep_sweep": () => "Starting deep vault sweep",
  "daemon.sweep_complete": (kv) => `Sweep finished — ${kv.fixed || kv.issues || "0"} issues addressed`,
  "issue.detected": (kv) => `Issue found: ${kv.code || ""} in ${kv.file || "unknown"}`,
  "issue.fixed": (kv) => `Fixed issue ${kv.code || ""} in ${kv.file || "unknown"}`,
  "autofix.fm001_fixed": (kv) => `Fixed missing frontmatter in ${kv.file || "unknown"}`,
  "autofix.fm002_fixed": (kv) => `Fixed invalid frontmatter in ${kv.file || "unknown"}`,
  "autofix.bl001_fixed": (kv) => `Fixed broken link in ${kv.file || "unknown"}`,
  "autofix.or001_fixed": (kv) => `Filed orphaned record: ${kv.file || "unknown"}`,
  "autofix.applied": (kv) => `Applied autofix ${kv.code || ""}: ${kv.file || "unknown"}`,

  // Distiller
  "extraction.start": () => "Starting knowledge extraction",
  "extraction.complete": (kv) => `Extraction complete — ${kv.created || "0"} records created`,
  "extraction.no_candidates": () => "No new records to analyze",
  "daemon.deep_extraction": () => "Starting deep knowledge extraction",
  "daemon.light_scan": () => "Starting light extraction scan",
  "daemon.extraction_complete": (kv) => `Extraction finished — ${kv.created || "0"} new insights`,
  "pipeline.s3_created": (kv) => `Created ${kv.type || "learning"} record: ${kv.path || "unknown"}`,

  // Surveyor
  "daemon.processing_diff": (kv) => `Processing vault changes: ${kv.diff || kv.changes || "incremental"}`,
  "daemon.labeling_complete": (kv) => `Labeling complete — ${kv.clusters || "0"} clusters labeled`,
  "daemon.embedding_complete": (kv) => `Embedding complete — ${kv.count || kv.records || "0"} records`,
  "embedder.diff_processed": (kv) => `Embeddings updated: ${kv.upserted || "0"} added, ${kv.deleted || "0"} removed`,
  "embedder.full_processed": (kv) => `Full embedding complete — ${kv.count || kv.total || "0"} records`,
  "clusterer.complete": (kv) => {
    const parts = [];
    if (kv.semantic_clusters) parts.push(`${kv.semantic_clusters} semantic`);
    if (kv.structural_communities) parts.push(`${kv.structural_communities} structural`);
    return `Clustering complete: ${parts.join(", ") || `${kv.clusters || "0"} clusters`}`;
  },
  "labeler.complete": (kv) => `Labeling complete — ${kv.labeled || kv.clusters || "0"} clusters`,
  "cluster.relationships": (kv) => `Discovered ${kv.count || "0"} new relationships`,

  // System / orchestrator
  "daemon.started": (kv) => `${kv.tool || "Daemon"} started`,
  "daemon.stopped": (kv) => `${kv.tool || "Daemon"} stopped`,
  "daemon.shutdown": () => "Daemon shutting down",
  "daemon.error": (kv) => `Error: ${kv.error || kv.message || "unknown error"}`,
  "orchestrator.started": () => "Alfred orchestrator started",
  "orchestrator.spawning": (kv) => `Starting ${kv.tool || "worker"}`,
  "orchestrator.child_exited": (kv) => `${kv.tool || "Worker"} exited (code ${kv.code || "?"})`,
  "orchestrator.shutdown": () => "Alfred orchestrator shutting down",
};

function normalizeLevel(level: string): ActivityItem["level"] {
  switch (level) {
    case "error":
    case "critical":
    case "fatal":
      return "error";
    case "warning":
    case "warn":
      return "warning";
    default:
      return "info";
  }
}

function humanizeEventName(event: string): string {
  // "daemon.processing_diff" → "Processing diff"
  const parts = event.split(".");
  const name = parts[parts.length - 1];
  const words = name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function buildMessage(event: string, kv: Record<string, string>): string {
  const fn = EVENT_MESSAGES[event];
  if (fn) return fn(kv);

  // Fallback: humanize event name + first few kv pairs
  const humanized = humanizeEventName(event);
  const kvParts = Object.entries(kv)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${v}`);
  return kvParts.length > 0 ? `${humanized} (${kvParts.join(", ")})` : humanized;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function parseActivityFeed(rawLogs: string, limit: number): ActivityItem[] {
  const lines = rawLogs.split("\n");
  const items: ActivityItem[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    const parsed = parseLine(line);
    if (!parsed) continue;

    // Skip noise events
    if (NOISE_EVENTS.has(parsed.event)) continue;

    items.push({
      timestamp: parsed.timestamp,
      tool: inferTool(parsed.event),
      level: normalizeLevel(parsed.level),
      event: parsed.event,
      message: buildMessage(parsed.event, parsed.kv),
    });
  }

  // Return last N items (most recent)
  return items.slice(-limit);
}
