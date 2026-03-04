import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, ConflictError, NotFoundError } from "../errors.js";

const DATA_DIR = path.join(process.cwd(), "data");
const STREAMS_DIR = path.join(DATA_DIR, "streams");
const PROCESSED_EVENTS_PATH = path.join(STREAMS_DIR, "processed-events.json");

// Ensure streams directory exists
fs.mkdirSync(STREAMS_DIR, { recursive: true });

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
    sendJson(res, 200, { streams });
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

  // GET /api/v1/streams/events — get events across all streams with status filter
  addRoute("GET", "/api/v1/streams/events", async ({ res, query }) => {
    const status = query.get("status") as "unprocessed" | "processed" | "quarantined" | undefined;
    const limit = parseInt(query.get("limit") || "100", 10);

    const events = getAllEvents(status, Math.min(limit, 500));
    sendJson(res, 200, { events, count: events.length });
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
