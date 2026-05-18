import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, ConflictError, NotFoundError, ApiError } from "../errors.js";
import {
  appendStreamLogEntry,
  readStreamLogSlice,
  listPartitionDates,
  getEnforcementMode,
  type StreamLogEntry,
} from "../stream_jsonl.js";
import { openStateDb } from "../../db/state.js";
import {
  getConsumerOffset,
  setConsumerOffset,
  markEventProcessed as sqlMarkEventProcessed,
  getEventProcessed,
  detectStuckPipeline,
} from "../../db/stream_queries.js";

const DEFAULT_CONSUMER = "event_processor";

const STREAMS_DIR = "/mnt/encrypted/alfred/streams";
const VAULT_PATH = "/mnt/encrypted/vault";
const PROCESSED_EVENTS_PATH = path.join(STREAMS_DIR, "processed-events.json");
const STREAM_CONFIGS_DIR = path.join(STREAMS_DIR, "configs");

// Public-facing host for SaaS-routed generic webhooks (everything that isn't
// Omi audio, which has its own tenant-side endpoint). Override via env if a
// non-default deployment moves the proxy.
const SAAS_HOST = process.env.SAAS_HOST ?? "https://alfred.black";

// Compose a ready-to-use public URL for a webhook-type stream so the agent
// never has to know its own tenant subdomain or invent host/token strings.
// Returns null when the stream isn't actually addressable (no webhookToken,
// or Omi without a TENANT_BASE_URL injected at provision time).
function composeWebhookUrl(
  source: string,
  webhookToken: string | undefined | null,
): string | null {
  if (!webhookToken) return null;
  if (source === "omi") {
    const base = process.env.TENANT_BASE_URL;
    if (!base) return null;
    return `${base.replace(/\/$/, "")}/api/v1/streams/omi/audio?token=${webhookToken}&uid=omi-device`;
  }
  return `${SAAS_HOST.replace(/\/$/, "")}/webhooks/${webhookToken}`;
}

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
  // Composio-backed stream config
  composio_action?: string;
  composio_connection_id?: string;
  composio_toolkit?: string;
  // Incremental sync
  pull_mode?: "snapshot" | "append" | "sync";
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
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];

    // Read only the tail of the file to avoid loading huge JSONL files into memory.
    // ~100KB per event worst case, so limit*100KB should be enough.
    const TAIL_BYTES = Math.min(stat.size, Math.max(limit * 100 * 1024, 1024 * 1024));
    const buf = Buffer.alloc(TAIL_BYTES);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buf, 0, TAIL_BYTES, stat.size - TAIL_BYTES);
    } finally {
      fs.closeSync(fd);
    }
    const tail = buf.toString("utf-8");
    const lines = tail.split("\n").filter(Boolean);

    // If we started mid-line (reading from middle of file), skip the first partial line
    const startIdx = (TAIL_BYTES < stat.size && lines.length > 0) ? 1 : 0;
    const validLines = lines.slice(startIdx);

    // Return most recent events first
    return validLines
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
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return false;
    const needle = `"source_ref":"${sourceRef}"`;
    const needleBuf = Buffer.from(needle);

    // Stream through the file in chunks to avoid loading it all into memory
    const BUF_SIZE = 256 * 1024;
    const buf = Buffer.alloc(BUF_SIZE + needleBuf.length);
    const fd = fs.openSync(filePath, "r");
    let carry = 0; // bytes carried from previous chunk (to handle needle spanning chunks)
    try {
      let bytesRead: number;
      while ((bytesRead = fs.readSync(fd, buf, carry, BUF_SIZE, null)) > 0) {
        const total = carry + bytesRead;
        if (buf.subarray(0, total).includes(needleBuf)) return true;
        // Carry the last (needle.length - 1) bytes to handle boundary matches
        carry = Math.min(total, needleBuf.length - 1);
        buf.copyWithin(0, total - carry, total);
      }
    } finally {
      fs.closeSync(fd);
    }
    return false;
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
  const effectiveLimit = Math.min(limit && limit > 0 ? limit : 500, 500);
  const processedData = statusFilter ? loadProcessedEvents() : null;

  // Collect recent events from each stream by reading only the tail of each file.
  // This avoids loading hundreds of MB of JSONL into memory at once.
  const candidates: StreamEvent[] = [];

  const files = fs.readdirSync(STREAMS_DIR);
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const filePath = path.join(STREAMS_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.size === 0) continue;

      // Read only the tail of the file — enough for ~effectiveLimit events per stream.
      // Gmail events can be 40-100KB each, so limit to 2MB tail per file to stay safe
      // within the 512MB container memory limit.
      const TAIL_BYTES = Math.min(stat.size, 2 * 1024 * 1024);
      const buf = Buffer.alloc(TAIL_BYTES);
      const fd = fs.openSync(filePath, "r");
      try {
        fs.readSync(fd, buf, 0, TAIL_BYTES, stat.size - TAIL_BYTES);
      } finally {
        fs.closeSync(fd);
      }
      const tail = buf.toString("utf-8");
      const lines = tail.split("\n").filter(Boolean);

      // If we started mid-line (reading from middle of file), skip the first partial line
      const startIdx = (TAIL_BYTES < stat.size && lines.length > 0) ? 1 : 0;

      // Take only the last effectiveLimit lines from this stream
      const recentLines = lines.slice(Math.max(startIdx, lines.length - effectiveLimit));

      for (const line of recentLines) {
        try {
          const event = JSON.parse(line) as StreamEvent;

          // Apply status filter inline to avoid accumulating unneeded events
          if (statusFilter && processedData) {
            const state = processedData.events[event.id];
            if (statusFilter === "unprocessed" && state) continue;
            if (statusFilter === "processed" && state?.status !== "processed") continue;
            if (statusFilter === "quarantined" && state?.status !== "quarantined") continue;
          }

          candidates.push(event);
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      continue;
    }
  }

  // Sort by received_at descending (most recent first)
  candidates.sort((a, b) => {
    const dateA = new Date(a.received_at).getTime();
    const dateB = new Date(b.received_at).getTime();
    return dateB - dateA;
  });

  return candidates.slice(0, effectiveLimit);
}

// ---------------------------------------------------------------------------
// Exported helpers (used by other route modules, e.g. vault.ts inbox upload)
// ---------------------------------------------------------------------------

/**
 * Core event fields that must not be overwritten by `extra` — if a caller
 * accidentally (or deliberately) passes one of these in `extra`, the value
 * is dropped before spreading so the generated/authoritative values win.
 */
const RESERVED_EVENT_KEYS = new Set<string>([
  "id",
  "stream_id",
  "stream_type",
  "tenant_id",
  "received_at",
  "source_ref",
  "raw",
  "summary",
]);

/**
 * Emit a stream event with the given stream_id/stream_type and extra fields.
 * Also bumps the stream meta's event_count / last_event_at when the stream
 * is registered. Used by the inbox upload path so binary files surface as
 * `stream_type: "media"` events for MediaIngestionWorkflow to pick up.
 */
export function emitStreamEvent(args: {
  stream_id: string;
  stream_type: string;
  source_ref?: string;
  raw?: unknown;
  summary?: string;
  metadata?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}): StreamEvent {
  const safeExtra = Object.fromEntries(
    Object.entries(args.extra || {}).filter(([k]) => !RESERVED_EVENT_KEYS.has(k)),
  );
  const event: StreamEvent = {
    id: crypto.randomUUID(),
    stream_id: args.stream_id,
    stream_type: args.stream_type,
    received_at: new Date().toISOString(),
    source_ref: args.source_ref,
    raw: args.raw ?? {},
    summary: args.summary,
    metadata: args.metadata,
    ...safeExtra,
  };
  appendEvent(args.stream_id, event);

  // Bump stream meta if registered
  const meta = loadStreamsMeta();
  const idx = meta.findIndex((s) => s.id === args.stream_id);
  if (idx >= 0) {
    meta[idx].last_event_at = event.received_at;
    meta[idx].event_count = (meta[idx].event_count || 0) + 1;
    saveStreamsMeta(meta);
  }

  return event;
}

// ---------------------------------------------------------------------------
// Stream schema descriptor (agent-facing setup reference)
//
// Surfaces three things the agent needs in order to create or configure a
// stream from a conversation, but which were previously only knowable by
// reading the source: (1) the FIELDS that the PATCH route accepts and what
// they mean, (2) the ARCHETYPES — end-to-end recipes for the five ways events
// flow into Alfred, with worked example bodies, and (3) RECOMMENDED templates
// for Composio toolkits that ship with auto-config defaults. Also lists known
// stream_type values that downstream workflows route on, plus the system
// stream id prefixes the agent must NOT delete or pause.
//
// This is documentation, not runtime: integrations.ts owns the canonical
// RECOMMENDED_STREAMS used during auto-config. The mirror here is for agent
// guidance and intentionally stays in sync by hand — drift is fine because
// auto-config is what actually wires Composio streams up.
// ---------------------------------------------------------------------------

function getStreamsSchema(): Record<string, unknown> {
  return {
    fields: {
      id: { type: "string", required: true, description: "Stable identifier, kebab-case. Used in URLs and event records. Cannot be changed once set." },
      name: { type: "string", required: true, description: "Human-readable label shown in the dashboard." },
      type: { type: "string", default: "custom", description: "Free-form classification. Common values: 'webhook', 'pull', 'composio', 'ambient', 'system', 'custom'." },
      source: { type: "string", default: "custom", description: "Where events originate. Free-form but agents should prefer canonical slugs: 'gmail', 'googlecalendar', 'github', 'notion', 'omi', 'plane', 'agentmail', 'twilio', 'composio:<toolkit>', or a hostname for custom HTTP." },
      enabled: { type: "boolean", default: true, description: "Stream is paused when false. Schedules skip disabled streams." },
      status: { type: "enum", values: ["idle", "active", "paused", "error"], description: "Last-known runtime state. Set by pull workers; agent reads only." },
      webhookToken: { type: "string", description: "Server-generated for webhook archetype. The agent should never set or invent this — the POST handler creates one for any type='webhook' stream that doesn't already have one." },
      webhook_url: { type: "string", description: "Read-only, server-composed. Present on responses for type='webhook' streams (GET list, GET single, POST create). Already includes the right host (SaaS proxy for generic webhooks, tenant subdomain for Omi audio) — copy it verbatim. Do NOT compose a webhook URL by hand." },
      pull_endpoint: { type: "string", description: "Custom HTTP-pull URL. Pull worker GETs this on the configured schedule." },
      pull_method: { type: "enum", values: ["GET", "POST"], default: "GET", description: "HTTP method for pull_endpoint." },
      pull_headers: { type: "object", description: "Static headers to send with each pull. Use auth_config for secrets, this for static keys like User-Agent." },
      pull_params: { type: "object", description: "Static query params for GET / body for POST." },
      pull_mode: { type: "enum", values: ["snapshot", "append", "sync"], description: "snapshot = blind every pull, dedupe via (stream_id, source_ref). append = filter by timestamp > cursor_value. sync = use a sync token (e.g. Google Calendar nextSyncToken)." },
      detail_endpoint: { type: "string", description: "Optional second-stage URL template, e.g. {{id}} expanded per item from the list call." },
      detail_id_field: { type: "string", description: "Field name on each list item used to expand detail_endpoint." },
      parser: { type: "enum", values: ["json", "rss", "atom", "custom"], default: "json", description: "How to interpret the response body." },
      auth_type: { type: "enum", values: ["none", "bearer", "basic", "api_key", "oauth"], description: "Auth scheme for pull_endpoint. Composio archetype handles auth via the connection — don't set this for composio streams." },
      auth_config: { type: "object", description: "Auth params. bearer: {token}. basic: {username, password}. api_key: {header, value} or {query, value}." },
      cursor_field: { type: "string", description: "Path to the timestamp/id on each event used for incremental pulls (append mode). Dot-notation supported, e.g. 'updated_at'." },
      cursor_value: { type: "string", description: "Last-seen cursor. Pull worker writes back after each successful pull. Initialize to '' for full backfill on first run." },
      cursor_param: { type: "string", description: "Query param name to send the cursor as on the next pull, e.g. 'since' or 'after'." },
      schedule_cron: { type: "string", description: "Standard 5-field cron. Mutually exclusive with schedule_interval_seconds." },
      schedule_interval_seconds: { type: "number", description: "Simple interval scheduler. Use this for most pulls. 300 = 5 min, 600 = 10 min." },
      composio_action: { type: "string", description: "Composio SDK action slug, e.g. 'GMAIL_FETCH_EMAILS'. Required for the composio archetype." },
      composio_connection_id: { type: "string", description: "ID of the ACTIVE ComposioConnection on this tenant. Look up via GET /api/v1/integrations." },
      composio_toolkit: { type: "string", description: "Toolkit slug, e.g. 'gmail'. Must match a connection's toolkit." },
      composio_args: { type: "object", description: "Arguments passed to the Composio action. See the recommended[] entries below for sane defaults per toolkit." },
      last_pull_at: { type: "string", description: "ISO timestamp of last successful pull. Read-only." },
      last_pull_status: { type: "string", description: "'ok' or error message. Read-only." },
      last_pull_count: { type: "number", description: "Events returned by last pull. Read-only." },
    },

    archetypes: [
      {
        id: "composio_pull",
        title: "Composio app stream (Gmail, Calendar, GitHub, Notion, etc.)",
        when_to_use: "User has connected a third-party app via Composio and wants periodic ingestion. Prefer auto-config — POST /api/v1/integrations/:id/auto-config will create the stream + Temporal schedule + skill in one call.",
        manual_recipe: {
          step_1: "Look up the connection: self({endpoint: '/api/v1/integrations'}). Find the ACTIVE row for the toolkit.",
          step_2: "Pick an action: see recommended[] below, or self({endpoint: '/api/v1/integrations/<toolkit>/actions'}) for the full list.",
          step_3: "POST /api/v1/streams with the body example.",
          step_4: "Register the schedule via Temporal — easier path: just call POST /api/v1/integrations/<connection_id>/auto-config and let it wire everything up.",
        },
        example_body: {
          id: "composio-gmail",
          name: "Gmail",
          type: "composio",
          source: "gmail",
          enabled: true,
          composio_action: "GMAIL_FETCH_EMAILS",
          composio_toolkit: "gmail",
          composio_connection_id: "<from /api/v1/integrations>",
          composio_args: { userId: "me", format: "metadata", maxResults: 50 },
          schedule_interval_seconds: 300,
          pull_mode: "append",
          cursor_field: "messageTimestamp",
        },
      },
      {
        id: "webhook_push",
        title: "Custom webhook (external service POSTs events)",
        when_to_use: "Any service that supports outgoing webhooks — Clockify, Zapier, custom scripts, GitHub repo webhooks (separate from the Composio github stream), monitoring tools, etc.",
        manual_recipe: {
          step_1: "Check first: GET /api/v1/streams. If a stream with this source already exists, reuse its existing `webhook_url` (every webhook-type stream in the list response carries the field). Do NOT create duplicates.",
          step_2: "If creating: POST /api/v1/streams with type: 'webhook'. The server auto-generates the webhookToken AND composes a fully-formed public URL. Read `response.stream.webhook_url` — it is the complete URL, ready to hand to the user. Do NOT compose URLs yourself; do NOT invent hosts or tokens.",
          step_3: "Hand `response.stream.webhook_url` to the user verbatim with instructions to paste it into the source service's webhook configuration. No schedule needed — events arrive as the source pushes them.",
        },
        example_body: {
          id: "webhook-clockify",
          name: "Clockify Time Entries",
          type: "webhook",
          source: "clockify",
          enabled: true,
        },
        post_create_response_shape: {
          stream: {
            id: "webhook-clockify",
            type: "webhook",
            source: "clockify",
            webhookToken: "<server-generated 48-char hex>",
            webhook_url: "https://alfred.black/webhooks/<webhookToken> — copy this field verbatim, do not reconstruct it",
          },
        },
        notes: "Body must be JSON. No signature verification on the generic /webhooks/:token receiver — tokens are the only auth. The webhook_url is composed server-side; if it is missing from the response, do not invent one — report the error to the user instead.",
      },
      {
        id: "http_pull",
        title: "Custom HTTP poll (no Composio adapter exists)",
        when_to_use: "Public or simple-auth HTTP API the agent wants to poll directly. Use only when no Composio toolkit covers the service.",
        manual_recipe: {
          step_1: "POST /api/v1/streams with type: 'pull' and the example fields.",
          step_2: "PATCH the auth_config separately (don't include secrets in conversation logs).",
          step_3: "Register a Temporal schedule that calls the StreamPullerWorkflow with this stream_id, OR use schedule_interval_seconds and let the next reconciler pick it up.",
        },
        example_body: {
          id: "pull-status-page",
          name: "Vendor Status Page",
          type: "pull",
          source: "vendor.com",
          enabled: true,
          pull_endpoint: "https://api.vendor.com/v1/incidents",
          pull_method: "GET",
          parser: "json",
          schedule_interval_seconds: 600,
          pull_mode: "append",
          cursor_field: "updated_at",
          cursor_param: "since",
          auth_type: "bearer",
        },
      },
      {
        id: "omi_audio_push",
        title: "Omi ambient audio (wearable / app feeds raw audio in)",
        when_to_use: "User wears an Omi pendant or runs the Omi mobile app and wants ambient conversations transcribed into the vault.",
        manual_recipe: {
          step_1: "Check first: GET /api/v1/streams. If a stream with `source: \"omi\"` already exists, REUSE it — read its existing `webhook_url` out of the list response and hand that to the user. Do NOT create a duplicate.",
          step_2: "If creating: POST /api/v1/streams with the example body. The server auto-generates the webhookToken AND composes the full Omi audio URL using this tenant's own subdomain. Read `response.stream.webhook_url` — it is the complete URL, ready to paste into the Omi app.",
          step_3: "Hand `response.stream.webhook_url` to the user verbatim with the instruction: 'Paste this into the Omi app developer settings as the audio stream endpoint.' Audio chunks POST as raw bytes (Content-Type: application/octet-stream); the tenant ctrl-api decodes them and emits stream_type 'omi-audio' events for MediaIngestionWorkflow to transcribe via Groq Whisper into conversation/ vault records.",
        },
        example_body: {
          id: "omi-audio",
          name: "Omi Ambient",
          type: "webhook",
          source: "omi",
          enabled: true,
        },
        post_create_response_shape: {
          stream: {
            id: "omi-audio",
            type: "webhook",
            source: "omi",
            webhookToken: "<server-generated>",
            webhook_url: "<tenant-subdomain>/api/v1/streams/omi/audio?token=<webhookToken>&uid=omi-device — copy this field verbatim, do not reconstruct it",
          },
        },
        notes: "Distinct from the generic webhook_push archetype: Omi has its own dedicated tenant-side endpoint (/api/v1/streams/omi/audio) that handles raw audio, not the SaaS-side /webhooks/:token JSON receiver. webhook_url is composed server-side using TENANT_BASE_URL — if it is missing from the response, the tenant was provisioned without TENANT_BASE_URL and you should report the gap to the user, not fabricate a host.",
      },
      {
        id: "manual_ingest",
        title: "One-off event injection",
        when_to_use: "User asks the agent to record something that didn't come through any stream — e.g. 'log this meeting note as if it were a calendar event'. Useful for testing.",
        manual_recipe: {
          step_1: "POST /api/v1/streams/ingest with stream_id, stream_type, and raw fields. Stream doesn't have to pre-exist — ingest auto-creates a meta entry.",
        },
        example_body: {
          stream_id: "manual-notes",
          stream_type: "note",
          raw: { text: "Caught up with Anna re Series B at 3pm", timestamp: "2026-04-29T15:00:00Z" },
          summary: "Series B catchup with Anna",
        },
      },
    ],

    // Mirrors integrations.ts:RECOMMENDED_STREAMS for agent reference. Auto-config
    // remains the canonical path for setting these up — this list lets the agent
    // *talk about* them and construct correct manual bodies if needed.
    recommended: {
      gmail: {
        composio_action: "GMAIL_FETCH_EMAILS",
        composio_args: { userId: "me", format: "metadata", maxResults: 50 },
        schedule_interval_seconds: 300,
        pull_mode: "append",
        notes: "format=metadata strips bodies (~1KB/msg vs ~104KB) so the openclaw tool-result cap doesn't truncate. Use format='full' only for fetching one specific message by id.",
      },
      googlecalendar: {
        composio_action: "GOOGLECALENDAR_EVENTS_LIST",
        composio_args: { calendarId: "primary" },
        schedule_interval_seconds: 300,
        pull_mode: "sync",
        notes: "Uses Google's nextSyncToken for true delta pulls.",
      },
      github: {
        composio_action: "GITHUB_LIST_NOTIFICATIONS_FOR_THE_AUTHENTICATED_USER",
        composio_args: {},
        schedule_interval_seconds: 300,
        pull_mode: "append",
        notes: "Polls the authed user's notifications feed.",
      },
      notion: {
        composio_action: "NOTION_FETCH_DATA",
        composio_args: { get_all: false, get_pages: true, get_databases: true, page_size: 50 },
        schedule_interval_seconds: 600,
        pull_mode: "snapshot",
        notes: "Snapshot mode + (stream_id, source_ref) dedupe — Notion's search API has no last_edited_time filter.",
      },
    },

    // stream_type values on individual events. Workflows route on these.
    // Anything not listed flows through generic EventProcessorWorkflow.
    known_event_types: [
      { type: "agentmail", processed_by: "EventProcessorWorkflow → email-template render", description: "Inbound email when sender is NOT in /vault/.auth/authorized_senders.json." },
      { type: "voice-call", processed_by: "stream_vault → conversation/ record", description: "Twilio voice call transcript posted on hangup." },
      { type: "sms", processed_by: "EventProcessorWorkflow", description: "Inbound SMS when sender is NOT authorized." },
      { type: "omi-audio", processed_by: "MediaIngestionWorkflow → Whisper → conversation/", description: "Audio chunk from Omi pendant. Transcribed via Groq." },
      { type: "media", processed_by: "MediaIngestionWorkflow", description: "Generic binary upload (image, PDF, audio). Routed by MIME type." },
      { type: "inbox-upload", processed_by: "Curator", description: "Text content uploaded to inbox via dashboard or scan endpoint." },
      { type: "plane", processed_by: "PlaneReverseSyncWorkflow", description: "Plane.so issue/cycle webhook events." },
      { type: "conversation", processed_by: "EventProcessorWorkflow → conversation/ record", description: "Generic transcript-shaped event." },
      { type: "note", processed_by: "EventProcessorWorkflow → event/ record", description: "Generic free-form event used by manual_ingest." },
    ],

    // System streams the agent must NOT delete or pause. The DELETE route
    // already enforces this server-side, but listing the patterns here lets
    // the agent reason about them without poking the API.
    system_streams: [
      "openclaw-sessions",
      "system-inbox",
      "agentmail-*",
      "phone-voice",
      "phone-sms",
      "omi-audio",
      "plane-webhook",
    ],
  };
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

    // Compute event counts + last_event_at without loading entire files into memory
    for (const stream of streams) {
      const filePath = getStreamEventsPath(stream.id);
      try {
        const stat = fs.statSync(filePath);
        if (stat.size === 0) continue;

        // Count lines by streaming through the file in chunks
        let lineCount = 0;
        const BUF_SIZE = 64 * 1024;
        const buf = Buffer.alloc(BUF_SIZE);
        const fd = fs.openSync(filePath, "r");
        try {
          let bytesRead: number;
          while ((bytesRead = fs.readSync(fd, buf, 0, BUF_SIZE, null)) > 0) {
            for (let i = 0; i < bytesRead; i++) {
              if (buf[i] === 0x0a) lineCount++;
            }
          }
          stream.event_count = lineCount;

          // Read just the last line for last_event_at (read last 4KB)
          const tailSize = Math.min(stat.size, 4096);
          const tailBuf = Buffer.alloc(tailSize);
          fs.readSync(fd, tailBuf, 0, tailSize, stat.size - tailSize);
          const tail = tailBuf.toString("utf-8");
          const lastNewline = tail.lastIndexOf("\n", tail.length - 2);
          const lastLine = lastNewline >= 0 ? tail.slice(lastNewline + 1).trim() : tail.trim();
          if (lastLine) {
            try {
              const last = JSON.parse(lastLine);
              stream.last_event_at = last.received_at || stream.last_event_at;
            } catch { /* keep existing */ }
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // No JSONL file = 0 events (keep existing count which may be 0)
      }
    }

    // Attach a fully-composed public webhook_url to every webhook-type stream
    // so the agent can copy it verbatim instead of constructing it. Omi uses
    // its dedicated tenant endpoint; everything else routes via the SaaS proxy.
    const enriched = streams.map((s) => {
      if (s.type !== "webhook") return s;
      const url = composeWebhookUrl(s.source, s.webhookToken);
      return url ? { ...s, webhook_url: url } : s;
    });

    sendJson(res, 200, { streams: enriched });
  });

  // GET /api/v1/streams/stuck-report — STORE-P4-2 stuck-consumer detector.
  //
  // Reports events in /vault/_raw/<date>.jsonl partitions older than
  // `stuck_after_days` (default 7) that are NOT in stream_event_processed.
  // The raw event being old isn't the problem on its own — the daily
  // compactor garbage-collects processed events at 7d. Anything past
  // the cutoff that's not marked processed = stuck consumer.
  //
  // MUST be registered before "/:id" so "stuck-report" doesn't match as
  // a stream id.
  addRoute("GET", "/api/v1/streams/stuck-report", async ({ res, query }) => {
    const stuckAfterDays = Math.max(
      1,
      parseInt(query.get("stuck_after_days") || "7", 10) || 7,
    );
    const sampleSize = Math.max(
      1,
      Math.min(parseInt(query.get("sample_size") || "10", 10) || 10, 100),
    );
    const db = openStateDb();
    const report = detectStuckPipeline(db, {
      stuck_after_days: stuckAfterDays,
      sample_size: sampleSize,
    });
    sendJson(res, 200, { ...report, stuck_after_days: stuckAfterDays });
  });

  // GET /api/v1/streams/schema — agent-facing reference for creating + configuring
  // streams. Returns the field descriptor, archetypes (recipes), recommended
  // Composio templates, known stream_type values, and system-stream patterns.
  // MUST be registered before "/:id" so "schema" doesn't match as a stream id.
  addRoute("GET", "/api/v1/streams/schema", async ({ res }) => {
    sendJson(res, 200, getStreamsSchema());
  });

  // GET /api/v1/streams/events — MUST be before /:id to avoid matching "events" as an ID
  //
  // STORE-P4-1: when `consumer=<name>` is set, this becomes a consume-and-advance
  // read against the date-partitioned JSONL log at /vault/_raw/YYYY-MM-DD.jsonl.
  // The endpoint atomically:
  //   1. Picks up where stream_consumer_offset(consumer, date) left off
  //   2. Reads up to `max` lines from the current date partition
  //   3. If the current partition is exhausted, advances to the next date
  //      with unread content
  //   4. Writes the new offset back to stream_consumer_offset
  //
  // The consumer is expected to call POST /streams/events/:id/processed for
  // every event it successfully handles. Events left un-marked-processed
  // beyond 7 days fire the stuck-pipeline alert (STORE-P4-2).
  //
  // Without `consumer`, falls back to the legacy stream-id-keyed scan over
  // /mnt/encrypted/alfred/streams/*.jsonl (used by dashboard "Recent Events").
  addRoute("GET", "/api/v1/streams/events", async ({ res, query }) => {
    const consumer = query.get("consumer");

    if (consumer) {
      const max = Math.min(
        Math.max(1, parseInt(query.get("max") || query.get("limit") || "200", 10)),
        500,
      );
      const db = openStateDb();
      const dates = listPartitionDates();
      const out: StreamLogEntry[] = [];
      let advanced = false;
      let lastDate: string | undefined;
      let lastOffset = 0;
      let remaining = max;

      // Walk forward across day boundaries until we hit `max` or exhaust
      // every partition. Today's file is always the last one (lex sort on
      // YYYY-MM-DD); older partitions take precedence so the consumer
      // drains oldest-first and the stuck-pipeline alert can spot a
      // backlog by date.
      for (const date of dates) {
        if (remaining <= 0) break;
        const offset = getConsumerOffset(db, consumer, date);
        const { entries, nextOffset, reachedEnd } = readStreamLogSlice(
          date,
          offset,
          remaining,
        );
        if (entries.length === 0 && reachedEnd) {
          continue;
        }
        out.push(...entries);
        remaining -= entries.length;
        if (nextOffset !== offset) {
          setConsumerOffset(db, consumer, date, nextOffset);
          advanced = true;
          lastDate = date;
          lastOffset = nextOffset;
        }
      }

      sendJson(res, 200, {
        events: out,
        count: out.length,
        consumer,
        // Surface the last (date, offset) we wrote so a debug client can
        // verify forward progress.
        last_date: advanced ? lastDate : undefined,
        last_offset: advanced ? lastOffset : undefined,
      });
      return;
    }

    const status = query.get("status") as "unprocessed" | "processed" | "quarantined" | undefined;
    const limit = parseInt(query.get("limit") || "100", 10);

    const events = getAllEvents(status, Math.min(limit, 500));
    sendJson(res, 200, { events, count: events.length });
  });

  // POST /api/v1/streams/events — STORE-P4-1 writer-side append.
  //
  // Replaces the legacy "write one .md per event under /vault/stream_event/"
  // pattern with an append to /vault/_raw/YYYY-MM-DD.jsonl.
  //
  // The body shape mirrors the StreamLogEntry contract:
  //   { id, ts_ns?, source_type, source_id?, received_at?, headers?, payload }
  //
  // `id` MUST be the upstream provider's stable event id (gmail message id,
  // gcal event id, composio event id) so a re-delivery is idempotent. If the
  // caller omits it we synthesise a UUIDv4, but downstream dedup is then
  // best-effort only.
  //
  // Shadow-write (STREAM_LOG_ENFORCEMENT=shadow, default): writes the JSONL
  // line AND also emits a legacy /mnt/encrypted/alfred/streams/<stream_id>.jsonl
  // event when `stream_id` is supplied, so the existing dashboard "Recent
  // Events" surface keeps working during the soak.
  addRoute("POST", "/api/v1/streams/events", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.source_type !== "string") {
      throw new ValidationError("source_type is required");
    }

    const id =
      typeof b.id === "string" && b.id
        ? (b.id as string)
        : typeof b.source_id === "string" && b.source_id
          ? (b.source_id as string)
          : crypto.randomUUID();

    const nowNs = (BigInt(Date.now()) * 1_000_000n).toString();
    const tsNs =
      typeof b.ts_ns === "string"
        ? b.ts_ns
        : typeof b.ts_ns === "number"
          ? String(Math.trunc(b.ts_ns))
          : nowNs;

    const receivedAt =
      typeof b.received_at === "string" ? b.received_at : new Date().toISOString();

    const entry: StreamLogEntry = {
      id,
      ts_ns: tsNs,
      source_type: b.source_type as string,
      source_id: typeof b.source_id === "string" ? (b.source_id as string) : id,
      received_at: receivedAt,
      headers:
        typeof b.headers === "object" && b.headers !== null
          ? (b.headers as Record<string, unknown>)
          : undefined,
      payload: b.payload ?? {},
    };

    const written = appendStreamLogEntry(entry);

    // Shadow-write the legacy stream-id JSONL when the caller supplied a
    // stream_id so /api/v1/streams/:id/events keeps returning rows.
    const enforcement = getEnforcementMode();
    let legacyAppended = false;
    const streamId = typeof b.stream_id === "string" ? (b.stream_id as string) : undefined;
    if (enforcement === "shadow" && streamId) {
      const legacy: StreamEvent = {
        id,
        stream_id: streamId,
        stream_type:
          typeof b.stream_type === "string" ? (b.stream_type as string) : entry.source_type,
        received_at: receivedAt,
        source_ref: typeof b.source_ref === "string" ? (b.source_ref as string) : undefined,
        raw: entry.payload,
        summary: typeof b.summary === "string" ? (b.summary as string) : undefined,
      };
      try {
        appendEvent(streamId, legacy);
        legacyAppended = true;
        const streams = loadStreamsMeta();
        const idx = streams.findIndex((s) => s.id === streamId);
        if (idx >= 0) {
          streams[idx].last_event_at = receivedAt;
          streams[idx].event_count = (streams[idx].event_count || 0) + 1;
          saveStreamsMeta(streams);
        }
      } catch {
        // Shadow write is best-effort — the JSONL line is the source of truth.
      }
    } else if (enforcement === "reject" && streamId) {
      // In `reject` mode callers must use the new endpoint shape; we still
      // accept the write but don't shadow-mirror it.
    }

    sendJson(res, 201, {
      status: "appended",
      event_id: id,
      date: written.date,
      bytes: written.bytes,
      legacy_shadow_written: legacyAppended,
      enforcement,
    });
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

    // Compose webhook_url for webhook-type streams (see comment on the list route).
    if (meta.type === "webhook") {
      const url = composeWebhookUrl(meta.source, meta.webhookToken);
      if (url) stream.webhook_url = url;
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
      "composio_action", "composio_connection_id", "composio_toolkit",
      "composio_args",
      "pull_mode",
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

    const type = typeof b.type === "string" ? b.type : "custom";
    const source = typeof b.source === "string" ? b.source : "custom";

    // Auto-generate a webhookToken for webhook-type streams when the caller
    // didn't provide one. Mirrors SaaS-side streamCreate (operations.ts) so
    // that a stream created directly through ctrl-api is immediately
    // addressable — the agent can read webhook_url out of the response and
    // hand it to the user without a follow-up request to seed the token.
    let webhookToken: string | undefined;
    if (typeof b.webhookToken === "string") {
      webhookToken = b.webhookToken;
    } else if (type === "webhook") {
      webhookToken = crypto.randomBytes(24).toString("hex");
    }

    const stream: StreamMeta = {
      id: b.id as string,
      name: b.name as string,
      type,
      source,
      enabled: b.enabled !== false,
      status: "idle",
      last_event_at: null,
      event_count: 0,
      ...(webhookToken ? { webhookToken } : {}),
    };

    streams.push(stream);
    saveStreamsMeta(streams);

    // Compose the public webhook URL so the agent never has to know its own
    // tenant subdomain or hand-construct a URL. See composeWebhookUrl above.
    const responseStream: Record<string, unknown> = { ...stream };
    if (type === "webhook") {
      const url = composeWebhookUrl(source, webhookToken);
      if (url) responseStream.webhook_url = url;
    }

    sendJson(res, 201, { stream: responseStream });
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
  //
  // STORE-P4-1: this now writes to BOTH:
  //   * stream_event_processed (state.db) — authoritative for the JSONL
  //     compactor and idempotency on next consume
  //   * processed-events.json (legacy) — kept during soak so the existing
  //     "Recent Events" dashboard filter still works
  addRoute("POST", "/api/v1/streams/events/:id/processed", async ({ res, params, body }) => {
    const eventId = params.id;
    const b = body as Record<string, unknown> | undefined;

    // Authoritative: record in SQLite. `date` defaults to today UTC if the
    // caller doesn't know which partition the event came from — the
    // compactor cross-checks the JSONL anyway.
    const date =
      typeof b?.date === "string" ? (b.date as string) : new Date().toISOString().slice(0, 10);
    const consumer =
      typeof b?.consumer === "string" ? (b.consumer as string) : DEFAULT_CONSUMER;
    try {
      const db = openStateDb();
      sqlMarkEventProcessed(db, eventId, date, consumer);
    } catch (err) {
      // Surface as a 500 — losing this row would let the compactor keep
      // the event forever, which defeats the 7d TTL.
      throw new ApiError(
        500,
        "STREAM_PROCESSED_WRITE_FAILED",
        `failed to record processed event: ${(err as Error).message}`,
      );
    }

    // Legacy mirror — best-effort.
    try {
      const processedData = loadProcessedEvents();
      processedData.events[eventId] = {
        event_id: eventId,
        status: "processed",
        processed_at: new Date().toISOString(),
        vault_path: typeof b?.vault_path === "string" ? b.vault_path : undefined,
        classification: typeof b?.classification === "string" ? b.classification : undefined,
      };
      saveProcessedEvents(processedData);
    } catch {
      /* ignore — SQL row is the source of truth */
    }

    sendJson(res, 200, {
      status: "marked_processed",
      event_id: eventId,
      date,
      consumer,
    });
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

  // POST /api/v1/streams/prune — remove processed events older than retention period from JSONL files.
  // Keeps unprocessed events and recently-processed events (default 7 days).
  // Also prunes stale entries from processed-events.json.
  addRoute("POST", "/api/v1/streams/prune", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    const retentionDays = Math.max(Number(b?.retention_days) || 7, 1);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    const processedData = loadProcessedEvents();
    const processedIds = new Set<string>();
    const staleIds: string[] = [];

    // Build set of events that are processed AND older than retention
    for (const [id, state] of Object.entries(processedData.events)) {
      const processedAt = new Date(state.processed_at).getTime();
      if (processedAt < cutoff) {
        processedIds.add(id);
        staleIds.push(id);
      }
    }

    let totalRemoved = 0;
    let totalKept = 0;
    let bytesReclaimed = 0;

    // Rewrite each JSONL file, keeping only unprocessed + recently-processed events
    const files = fs.readdirSync(STREAMS_DIR);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = path.join(STREAMS_DIR, file);
      const beforeSize = fs.statSync(filePath).size;

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      const kept: string[] = [];

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const eventId = event.id || event.source_ref || "";
          if (processedIds.has(eventId)) {
            totalRemoved++;
          } else {
            kept.push(line);
            totalKept++;
          }
        } catch {
          kept.push(line); // keep unparseable lines
        }
      }

      fs.writeFileSync(filePath, kept.join("\n") + (kept.length ? "\n" : ""));
      bytesReclaimed += beforeSize - fs.statSync(filePath).size;
    }

    // Prune stale entries from processed-events.json
    for (const id of staleIds) {
      delete processedData.events[id];
    }
    saveProcessedEvents(processedData);

    sendJson(res, 200, {
      pruned: totalRemoved,
      kept: totalKept,
      stale_tracking_removed: staleIds.length,
      bytes_reclaimed: bytesReclaimed,
      retention_days: retentionDays,
    });
  });

  // POST /api/v1/streams/raw/compact — STORE-P4-1 daily compactor.
  //
  // For each /vault/_raw/YYYY-MM-DD.jsonl partition:
  //   * If date is older than `hard_delete_days` (default 30): drop the
  //     whole file, drop matching stream_event_processed rows.
  //   * Else if date is older than `soft_compact_days` (default 7):
  //     rewrite the file keeping only lines whose id is NOT marked
  //     processed. If the slim file is empty, delete it.
  //   * Today and recent files are untouched.
  //
  // Runs as a one-shot activity from the daily maintenance workflow.
  // Returns counts so the workflow can surface them in Temporal UI.
  addRoute("POST", "/api/v1/streams/raw/compact", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    const softDays = Math.max(
      1,
      Number(b?.soft_compact_days ?? b?.retention_days ?? 7),
    );
    const hardDays = Math.max(softDays, Number(b?.hard_delete_days ?? 30));
    const today = new Date().toISOString().slice(0, 10);

    const dates = listPartitionDates();
    const db = openStateDb();

    // Lazy-load: heavy modules deferred so the route handler stays cold-startable.
    const { compactPartition, deletePartition } = await import("../stream_jsonl.js");
    const { listProcessedIdsForDate, deleteProcessedOlderThan } = await import(
      "../../db/stream_queries.js"
    );

    const ageDays = (date: string): number => {
      const partition = new Date(`${date}T00:00:00Z`).getTime();
      const now = new Date(`${today}T00:00:00Z`).getTime();
      return Math.floor((now - partition) / 86_400_000);
    };

    const summary: Array<{
      date: string;
      action: "delete" | "compact" | "skip";
      kept: number;
      dropped: number;
      removed: boolean;
    }> = [];

    for (const date of dates) {
      const age = ageDays(date);
      if (age >= hardDays) {
        const removed = deletePartition(date);
        summary.push({ date, action: "delete", kept: 0, dropped: 0, removed });
        continue;
      }
      if (age >= softDays) {
        const dropIds = listProcessedIdsForDate(db, date);
        const { kept, dropped, removed } = compactPartition(date, dropIds);
        summary.push({ date, action: "compact", kept, dropped, removed });
        continue;
      }
      summary.push({ date, action: "skip", kept: 0, dropped: 0, removed: false });
    }

    // GC the processed-events table for rows older than the hard cutoff so
    // it doesn't accumulate forever. ns precision: cutoff is hardDays ago.
    const cutoffNs =
      (BigInt(Date.now()) - BigInt(hardDays) * 86_400_000n) * 1_000_000n;
    const droppedRows = deleteProcessedOlderThan(db, cutoffNs);

    sendJson(res, 200, {
      soft_compact_days: softDays,
      hard_delete_days: hardDays,
      partitions: summary,
      processed_rows_pruned: droppedRows,
    });
  });
}
