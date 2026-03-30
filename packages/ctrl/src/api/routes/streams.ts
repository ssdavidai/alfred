import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, ConflictError, NotFoundError } from "../errors.js";

const STREAMS_DIR = "/mnt/encrypted/alfred/streams";
const VAULT_PATH = "/mnt/encrypted/vault";
const PROCESSED_EVENTS_PATH = path.join(STREAMS_DIR, "processed-events.json");
const STREAM_CONFIGS_DIR = path.join(STREAMS_DIR, "configs");

// Ensure streams directory exists
fs.mkdirSync(STREAMS_DIR, { recursive: true });
fs.mkdirSync(STREAM_CONFIGS_DIR, { recursive: true });

interface StreamEvent {
  id: string;
  stream_id: string;
  stream_type: string;
  tenant_id?: string;
  received_at: string;
  source_ref?: string;
  raw: unknown;
  summary?: string;
  metadata?: Record<string, unknown>;
}

interface StreamMeta {
  id: string;
  name: string;
  type: string;
  source: string;
  enabled: boolean;
  status: string;
  last_event_at: string | null;
  event_count: number;
  system?: boolean;
  webhookToken?: string;
}

interface ProcessedEventState {
  event_id: string;
  status: "processed" | "quarantined";
  processed_at: string;
  vault_path?: string;
  classification?: string;
  quarantine_reason?: string;
}

interface ProcessedEventsData {
  events: Record<string, ProcessedEventState>;
}

interface StreamConfig {
  id: string;
  name: string;
  type: string;
  source: string;
  enabled: boolean;
  // Pull engine config
  pull_endpoint?: string;
  pull_method?: string;
  pull_headers?: Record<string, string>;
  pull_params?: Record<string, string>;
  detail_endpoint?: string;
  detail_id_field?: string;
  parser?: string;
  auth_type?: string;
  auth_config?: Record<string, unknown>;
  cursor_field?: string;
  cursor_value?: string;
  cursor_param?: string;
  schedule_cron?: string;
  schedule_interval_seconds?: number;
  last_pull_at?: string | null;
  last_pull_status?: string | null;
  last_pull_count?: number;
}

const SYSTEM_STREAMS: StreamMeta[] = [
  {
    id: "system-openclaw-sessions",
    name: "OpenClaw Chats",
    type: "system",
    source: "openclaw-sessions",
    enabled: true,
    status: "idle",
    last_event_at: null,
    event_count: 0,
    system: true,
  },
  {
    id: "system-inbox",
    name: "Inbox Uploads",
    type: "system",
    source: "inbox",
    enabled: true,
    status: "idle",
    last_event_at: null,
    event_count: 0,
    system: true,
  },
];

// ---------------------------------------------------------------------------
// File-based stream event storage (one JSON-lines file per stream)
// ---------------------------------------------------------------------------

function getStreamEventsPath(streamId: string): string {
  const safe = streamId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(STREAMS_DIR, `${safe}.jsonl`);
}

function getStreamMetaPath(): string {
  return path.join(STREAMS_DIR, "streams.json");
}

function loadStreamsMeta(): StreamMeta[] {
  const metaPath = getStreamMetaPath();
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return [];
  }
}

function saveStreamsMeta(streams: StreamMeta[]): void {
  fs.writeFileSync(getStreamMetaPath(), JSON.stringify(streams, null, 2));
}

function getStreamConfigPath(streamId: string): string {
  const safe = streamId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(STREAM_CONFIGS_DIR, `${safe}.json`);
}

function loadStreamConfig(streamId: string): StreamConfig | null {
  const configPath = getStreamConfigPath(streamId);
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
}

function saveStreamConfig(config: StreamConfig): void {
  const configPath = getStreamConfigPath(config.id);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function appendEvent(streamId: string, event: StreamEvent): void {
  const filePath = getStreamEventsPath(streamId);
  fs.appendFileSync(filePath, JSON.stringify(event) + "\n");
}

function readRecentEvents(streamId: string, limit: number = 50): StreamEvent[] {
  const filePath = getStreamEventsPath(streamId);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    // Return most recent events first
    return lines
      .slice(-limit)
      .reverse()
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function hasSourceRef(streamId: string, sourceRef: string): boolean {
  const filePath = getStreamEventsPath(streamId);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.includes(`"source_ref":"${sourceRef}"`);
  } catch {
    return false;
  }
}

function loadProcessedEvents(): ProcessedEventsData {
  try {
    const content = fs.readFileSync(PROCESSED_EVENTS_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return { events: {} };
  }
}

function saveProcessedEvents(data: ProcessedEventsData): void {
  fs.writeFileSync(PROCESSED_EVENTS_PATH, JSON.stringify(data, null, 2));
}

function getAllEvents(statusFilter?: "unprocessed" | "processed" | "quarantined", limit?: number): StreamEvent[] {
  const processedData = loadProcessedEvents();
  const allEvents: StreamEvent[] = [];

  // Read all stream JSONL files
  const files = fs.readdirSync(STREAMS_DIR);
  for (const file of files) {
    if (file.endsWith(".jsonl")) {
      const filePath = path.join(STREAMS_DIR, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const event = JSON.parse(line) as StreamEvent;
          allEvents.push(event);
        }
      } catch {
        // Skip files that can't be read
        continue;
      }
    }
  }

  // Filter by status if specified
  let filtered = allEvents;
  if (statusFilter) {
    filtered = allEvents.filter((event) => {
      const state = processedData.events[event.id];
      if (statusFilter === "unprocessed") {
        return !state;
      } else if (statusFilter === "processed") {
        return state?.status === "processed";
      } else if (statusFilter === "quarantined") {
        return state?.status === "quarantined";
      }
      return false;
    });
  }

  // Sort by received_at descending (most recent first)
  filtered.sort((a, b) => {
    const dateA = new Date(a.received_at).getTime();
    const dateB = new Date(b.received_at).getTime();
    return dateB - dateA;
  });

  // Apply limit if specified
  if (limit && limit > 0) {
    filtered = filtered.slice(0, limit);
  }

  return filtered;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerStreamRoutes(): void {
  // Ensure system streams exist in streams.json
  const streams = loadStreamsMeta();
  let changed = false;
  for (const sys of SYSTEM_STREAMS) {
    if (!streams.some((s) => s.id === sys.id)) {
      streams.push(sys);
      changed = true;
    }
  }
  if (changed) saveStreamsMeta(streams);

  // ---------------------------------------------------------------------------
  // Inbox → Stream bridge
  // ---------------------------------------------------------------------------

  // POST /api/v1/streams/inbox/scan — scan inbox for new files and ingest them as stream events
  addRoute("POST", "/api/v1/streams/inbox/scan", async ({ res }) => {
    const inboxDir = path.join(VAULT_PATH, "inbox");
    const skipNames = new Set([".DS_Store", ".gitkeep", "Thumbs.db", ".gitignore"]);

    let files: string[];
    try {
      files = fs.readdirSync(inboxDir).filter((f) => {
        if (f.startsWith(".") || skipNames.has(f)) return false;
        const full = path.join(inboxDir, f);
        try { return fs.statSync(full).isFile(); } catch { return false; }
      });
    } catch {
      files = [];
    }

    // Build set of existing source_refs in one pass (avoid O(files × events))
    const existingRefs = new Set<string>();
    const streamPath = getStreamEventsPath("system-inbox");
    try {
      const content = fs.readFileSync(streamPath, "utf-8");
      for (const line of content.trim().split("\n")) {
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.source_ref) existingRefs.add(evt.source_ref);
        } catch { /* skip malformed lines */ }
      }
    } catch { /* stream file may not exist yet */ }

    const ingested: Array<{ filename: string; event_id: string }> = [];
    const skipped: Array<{ filename: string; reason: string }> = [];

    const MAX_PREVIEW_BYTES = 4096; // only read first 4KB for preview/frontmatter

    for (const filename of files) {
      const fullPath = path.join(inboxDir, filename);

      // Check if this file was already ingested (by source_ref)
      const sourceRef = `inbox:${filename}`;
      if (existingRefs.has(sourceRef)) {
        skipped.push({ filename, reason: "already_ingested" });
        continue;
      }

      // Read only the first bytes for preview — avoid loading large/binary files fully
      let preview = "";
      let fileSize = 0;
      let isText = filename.endsWith(".md") || filename.endsWith(".txt") || filename.endsWith(".yaml") || filename.endsWith(".yml") || filename.endsWith(".json");
      try {
        const stat = fs.statSync(fullPath);
        fileSize = stat.size;
        if (isText || fileSize < 100_000) {
          // For text files or small files, read a preview chunk
          const fd = fs.openSync(fullPath, "r");
          const buf = Buffer.alloc(Math.min(MAX_PREVIEW_BYTES, fileSize));
          fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          preview = buf.toString("utf-8");
        }
      } catch {
        skipped.push({ filename, reason: "unreadable" });
        continue;
      }

      // Parse frontmatter if present (handle both LF and CRLF)
      let summary = `Inbox file: ${filename}`;
      if (preview) {
        const fmMatch = preview.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (fmMatch) {
          const titleMatch = fmMatch[1].match(/^(?:title|name|subject)\s*:\s*['"]?(.+?)['"]?\s*$/m);
          if (titleMatch) {
            summary = titleMatch[1];
          }
        }
      }

      // Create stream event
      const stat = fs.statSync(fullPath);
      const event: StreamEvent = {
        id: crypto.randomUUID(),
        stream_id: "system-inbox",
        stream_type: "inbox-upload",
        received_at: stat.mtime.toISOString(),
        source_ref: sourceRef,
        raw: {
          filename,
          path: path.join("inbox", filename),
          content_preview: preview.slice(0, 2000),
          content_length: fileSize,
          mime_type: isText ? "text/markdown" : "application/octet-stream",
        },
        summary,
        metadata: {
          original_path: path.join("inbox", filename),
        },
      };

      appendEvent("system-inbox", event);
      existingRefs.add(sourceRef); // track within this scan too
      ingested.push({ filename, event_id: event.id });
    }

    // Update stream meta
    if (ingested.length > 0) {
      const meta = loadStreamsMeta();
      const idx = meta.findIndex((s) => s.id === "system-inbox");
      if (idx >= 0) {
        meta[idx].last_event_at = new Date().toISOString();
        meta[idx].event_count = (meta[idx].event_count || 0) + ingested.length;
        saveStreamsMeta(meta);
      }
    }

    sendJson(res, 200, {
      ingested: ingested.length,
      skipped: skipped.length,
      details: { ingested, skipped },
    });
  });

  // POST /api/v1/streams/system/openclaw-sessions/report — harvest activity reports stats
  addRoute("POST", "/api/v1/streams/system/openclaw-sessions/report", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    const meta = loadStreamsMeta();
    const idx = meta.findIndex((s) => s.id === "system-openclaw-sessions");
    if (idx >= 0) {
      if (typeof b?.messages_harvested === "number" && b.messages_harvested > 0) {
        meta[idx].last_event_at = new Date().toISOString();
        meta[idx].event_count = (meta[idx].event_count || 0) + (b.messages_harvested as number);
      }
      if (typeof b?.status === "string") {
        meta[idx].status = b.status as string;
      }
      saveStreamsMeta(meta);
    }
    sendJson(res, 200, { status: "ok" });
  });

  // POST /api/v1/streams/ingest — receive a StreamEvent, store + queue
  addRoute("POST", "/api/v1/streams/ingest", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.stream_id !== "string" || typeof b.stream_type !== "string") {
      throw new ValidationError("stream_id and stream_type are required");
    }

    const streamId = b.stream_id as string;
    const sourceRef = typeof b.source_ref === "string" ? b.source_ref : undefined;

    // Dedup check
    if (sourceRef && hasSourceRef(streamId, sourceRef)) {
      sendJson(res, 200, { status: "duplicate", source_ref: sourceRef });
      return;
    }

    const event: StreamEvent = {
      id: crypto.randomUUID(),
      stream_id: streamId,
      stream_type: b.stream_type as string,
      tenant_id: typeof b.tenant_id === "string" ? b.tenant_id : undefined,
      received_at: typeof b.received_at === "string" ? b.received_at : new Date().toISOString(),
      source_ref: sourceRef,
      raw: b.raw ?? {},
      summary: typeof b.summary === "string" ? b.summary : undefined,
      metadata: typeof b.metadata === "object" && b.metadata !== null
        ? b.metadata as Record<string, unknown>
        : undefined,
    };

    appendEvent(streamId, event);

    // Update stream meta
    const streams = loadStreamsMeta();
    const idx = streams.findIndex((s) => s.id === streamId);
    if (idx >= 0) {
      streams[idx].last_event_at = event.received_at;
      streams[idx].event_count = (streams[idx].event_count || 0) + 1;
      saveStreamsMeta(streams);
    }

    sendJson(res, 201, { status: "ingested", event_id: event.id });
  });

  // GET /api/v1/streams — list streams for this tenant
  addRoute("GET", "/api/v1/streams", async ({ res }) => {
    const streams = loadStreamsMeta();

    // Compute accurate event counts + last_event_at from JSONL files
    for (const stream of streams) {
      const filePath = getStreamEventsPath(stream.id);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);
        stream.event_count = lines.length;
        // Find the most recent received_at
        if (lines.length > 0) {
          try {
            const last = JSON.parse(lines[lines.length - 1]);
            stream.last_event_at = last.received_at || stream.last_event_at;
          } catch { /* keep existing */ }
        }
      } catch {
        // No JSONL file = 0 events (keep existing count which may be 0)
      }
    }

    sendJson(res, 200, { streams });
  });

  // GET /api/v1/streams/events — MUST be before /:id to avoid matching "events" as an ID
  addRoute("GET", "/api/v1/streams/events", async ({ res, query }) => {
    const status = query.get("status") as "unprocessed" | "processed" | "quarantined" | undefined;
    const limit = parseInt(query.get("limit") || "100", 10);

    const events = getAllEvents(status, Math.min(limit, 500));
    sendJson(res, 200, { events, count: events.length });
  });

  // GET /api/v1/streams/:id — get full stream config by ID
  addRoute("GET", "/api/v1/streams/:id", async ({ res, params }) => {
    const streamId = params.id;

    // Load metadata
    const streams = loadStreamsMeta();
    const meta = streams.find((s) => s.id === streamId);
    if (!meta) {
      throw new NotFoundError(`Stream ${streamId} not found`);
    }

    // Load config (pull engine settings) if it exists
    const config = loadStreamConfig(streamId);

    // Merge meta + config into a unified response
    const stream: Record<string, unknown> = { ...meta };
    if (config) {
      // Overlay config fields onto the meta
      for (const [key, val] of Object.entries(config)) {
        if (val !== undefined) {
          stream[key] = val;
        }
      }
    }

    sendJson(res, 200, { stream });
  });

  // PATCH /api/v1/streams/:id — update stream config fields
  addRoute("PATCH", "/api/v1/streams/:id", async ({ res, params, body }) => {
    const streamId = params.id;
    const b = body as Record<string, unknown> | undefined;
    if (!b) {
      throw new ValidationError("Request body is required");
    }

    // Ensure stream exists in metadata
    const streams = loadStreamsMeta();
    const metaIdx = streams.findIndex((s) => s.id === streamId);
    if (metaIdx < 0) {
      throw new NotFoundError(`Stream ${streamId} not found`);
    }

    // Update metadata fields if provided
    const metaFields = ["name", "type", "source", "enabled", "status"] as const;
    for (const field of metaFields) {
      if (b[field] !== undefined) {
        (streams[metaIdx] as unknown as Record<string, unknown>)[field] = b[field];
      }
    }
    saveStreamsMeta(streams);

    // Update config fields
    const existing = loadStreamConfig(streamId) || {
      id: streamId,
      name: streams[metaIdx].name,
      type: streams[metaIdx].type,
      source: streams[metaIdx].source,
      enabled: streams[metaIdx].enabled,
    };

    const configFields = [
      "pull_endpoint", "pull_method", "pull_headers", "pull_params",
      "detail_endpoint", "detail_id_field", "parser",
      "auth_type", "auth_config",
      "cursor_field", "cursor_value", "cursor_param",
      "schedule_cron", "schedule_interval_seconds",
      "last_pull_at", "last_pull_status", "last_pull_count",
      "name", "type", "source", "enabled",
    ] as const;

    for (const field of configFields) {
      if (b[field] !== undefined) {
        (existing as unknown as Record<string, unknown>)[field] = b[field];
      }
    }

    saveStreamConfig(existing as StreamConfig);

    sendJson(res, 200, { stream: { ...streams[metaIdx], ...existing } });
  });

  // GET /api/v1/streams/:id/events — recent events for a stream
  addRoute("GET", "/api/v1/streams/:id/events", async ({ res, params, query }) => {
    const streamId = params.id;
    const limit = parseInt(query.get("limit") || "50", 10);
    const events = readRecentEvents(streamId, Math.min(limit, 200));
    sendJson(res, 200, { events, count: events.length });
  });

  // POST /api/v1/streams/:id/pause — pause a stream
  addRoute("POST", "/api/v1/streams/:id/pause", async ({ res, params }) => {
    const streams = loadStreamsMeta();
    const idx = streams.findIndex((s) => s.id === params.id);
    if (idx < 0) {
      throw new NotFoundError(`Stream ${params.id} not found`);
    }
    if (streams[idx].system) {
      throw new ValidationError("Cannot pause a system stream");
    }
    streams[idx].enabled = false;
    streams[idx].status = "paused";
    saveStreamsMeta(streams);
    sendJson(res, 200, { stream: streams[idx] });
  });

  // POST /api/v1/streams/:id/resume — resume a stream
  addRoute("POST", "/api/v1/streams/:id/resume", async ({ res, params }) => {
    const streams = loadStreamsMeta();
    const idx = streams.findIndex((s) => s.id === params.id);
    if (idx < 0) {
      throw new NotFoundError(`Stream ${params.id} not found`);
    }
    if (streams[idx].system) {
      throw new ValidationError("Cannot resume a system stream — it is always enabled");
    }
    streams[idx].enabled = true;
    streams[idx].status = "idle";
    saveStreamsMeta(streams);
    sendJson(res, 200, { stream: streams[idx] });
  });

  // POST /api/v1/streams — register a new stream on this tenant
  addRoute("POST", "/api/v1/streams", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.id !== "string" || typeof b.name !== "string") {
      throw new ValidationError("id and name are required");
    }

    const streams = loadStreamsMeta();
    if (streams.some((s) => s.id === b.id)) {
      throw new ConflictError(`Stream ${b.id} already exists`);
    }

    const stream: StreamMeta = {
      id: b.id as string,
      name: b.name as string,
      type: typeof b.type === "string" ? b.type : "custom",
      source: typeof b.source === "string" ? b.source : "custom",
      enabled: b.enabled !== false,
      status: "idle",
      last_event_at: null,
      event_count: 0,
      ...(typeof b.webhookToken === "string" ? { webhookToken: b.webhookToken } : {}),
    };

    streams.push(stream);
    saveStreamsMeta(streams);
    sendJson(res, 201, { stream });
  });

  // DELETE /api/v1/streams/:id — remove a stream and its events
  addRoute("DELETE", "/api/v1/streams/:id", async ({ res, params }) => {
    const streams = loadStreamsMeta();
    const idx = streams.findIndex((s) => s.id === params.id);
    if (idx < 0) {
      throw new NotFoundError(`Stream ${params.id} not found`);
    }
    if (streams[idx].system) {
      throw new ValidationError("Cannot delete a system stream");
    }

    streams.splice(idx, 1);
    saveStreamsMeta(streams);

    // Remove events file
    const eventsPath = getStreamEventsPath(params.id);
    try {
      fs.unlinkSync(eventsPath);
    } catch {
      // file may not exist
    }

    sendJson(res, 200, { status: "deleted" });
  });

  // POST /api/v1/streams/events/:id/processed — mark event as processed
  addRoute("POST", "/api/v1/streams/events/:id/processed", async ({ res, params, body }) => {
    const eventId = params.id;
    const b = body as Record<string, unknown> | undefined;

    const processedData = loadProcessedEvents();
    processedData.events[eventId] = {
      event_id: eventId,
      status: "processed",
      processed_at: new Date().toISOString(),
      vault_path: typeof b?.vault_path === "string" ? b.vault_path : undefined,
      classification: typeof b?.classification === "string" ? b.classification : undefined,
    };

    saveProcessedEvents(processedData);
    sendJson(res, 200, { status: "marked_processed", event_id: eventId });
  });

  // POST /api/v1/streams/events/:id/quarantine — mark event as quarantined
  addRoute("POST", "/api/v1/streams/events/:id/quarantine", async ({ res, params, body }) => {
    const eventId = params.id;
    const b = body as Record<string, unknown> | undefined;

    const processedData = loadProcessedEvents();
    processedData.events[eventId] = {
      event_id: eventId,
      status: "quarantined",
      processed_at: new Date().toISOString(),
      quarantine_reason: typeof b?.reason === "string" ? b.reason : "Unknown reason",
    };

    saveProcessedEvents(processedData);
    sendJson(res, 200, { status: "quarantined", event_id: eventId });
  });
}
