// AgentPhone — tenant-side ctrl-api routes.
//
// Phase 4 lands two endpoints used by the Voice Bridge:
//   GET  /api/v1/phone/voice-context   — bundle for the Realtime instructions primer
//   POST /api/v1/phone/transcript      — write call transcript to the streams pipeline
//
// Phase 5 will add /sms/inbound + authorized-numbers CRUD.
// Phase 6 will add outbound /sms + /call.

import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";

const VAULT_PATH = process.env.VAULT_PATH ?? "/vault";
const STREAMS_DIR = "/mnt/encrypted/alfred/streams";
// In-tenant view of the openclaw workspace (mounted at /home/node/.openclaw in
// the openclaw container; ctrl-api mounts /mnt/encrypted/openclaw → /openclaw-state).
const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR ?? "/openclaw-state/workspace";
const OPENCLAW_GATEWAY_URL =
  process.env.OPENCLAW_GATEWAY_URL ?? "http://openclaw:18789";
const GATEWAY_TOKEN_FILE = "/alfred-data/.gateway-token";

// 60 s in-memory cache of the voice context bundle. Voice calls fetch this on
// connect and we don't want to re-walk the vault per call.
let voiceContextCache: { at: number; bundle: VoiceContextBundle } | null = null;
const VOICE_CONTEXT_TTL_MS = 60_000;

interface VoiceContextBundle {
  memoryMd: string;
  voiceSkill: string;
  openMatters: Array<{ name: string; summary?: string }>;
  openTasks: Array<{ name: string; due?: string; summary?: string }>;
  recentSessions: Array<{ at: string; channel: string; summary: string }>;
  generatedAt: string;
}

function readFileSafe(path: string, max = 16_000): string {
  try {
    const text = fs.readFileSync(path, "utf-8");
    return text.length > max ? text.slice(0, max) : text;
  } catch {
    return "";
  }
}

function readJsonlTail(
  path: string,
  maxLines: number,
): Array<Record<string, unknown>> {
  try {
    const text = fs.readFileSync(path, "utf-8");
    const lines = text
      .split("\n")
      .filter((l: string) => l.trim().length > 0);
    return lines.slice(-maxLines).map((l: string) => JSON.parse(l));
  } catch {
    return [];
  }
}

function listVaultRecords(
  type: string,
  status?: string,
): Array<{ name: string; summary?: string; due?: string }> {
  const dir = `${VAULT_PATH}/${type}`;
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: Array<{ name: string; summary?: string; due?: string }> = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(`${dir}/${f}`, "utf-8");
      const fm = parseFrontmatter(raw);
      if (status && fm.status && fm.status !== status) continue;
      out.push({
        name: typeof fm.name === "string" ? fm.name : f.replace(/\.md$/, ""),
        summary: typeof fm.summary === "string" ? fm.summary : undefined,
        due: typeof fm.due === "string" ? fm.due : undefined,
      });
    } catch {
      // ignore malformed
    }
  }
  return out.slice(0, 20);
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  if (!raw.startsWith("---")) return {};
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return {};
  const body = raw.slice(3, end).trim();
  const out: Record<string, unknown> = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    let v: any = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (v === "true") v = true;
    else if (v === "false") v = false;
    out[m[1]] = v;
  }
  return out;
}

function buildVoiceContext(): VoiceContextBundle {
  const memoryMd = readFileSafe(`${WORKSPACE_DIR}/MEMORY.md`, 8_000);
  const voiceSkill = readFileSafe(
    `${WORKSPACE_DIR}/skills/alfred-voice/SKILL.md`,
    8_000,
  );
  const openMatters = listVaultRecords("matter", "active");
  const openTasks = listVaultRecords("task", "active");

  // Recent main-agent sessions: tail the system-openclaw-sessions stream.
  const sessionEvents = readJsonlTail(
    `${STREAMS_DIR}/system-openclaw-sessions.jsonl`,
    20,
  );
  const recentSessions = sessionEvents.map((e) => ({
    at: typeof e.received_at === "string" ? e.received_at : "",
    channel:
      typeof e.metadata === "object" && e.metadata
        ? String((e.metadata as any).channel ?? "openclaw")
        : "openclaw",
    summary: typeof e.summary === "string" ? e.summary : "",
  }));

  return {
    memoryMd,
    voiceSkill,
    openMatters,
    openTasks,
    recentSessions,
    generatedAt: new Date().toISOString(),
  };
}

function getVoiceContextCached(): VoiceContextBundle {
  const now = Date.now();
  if (voiceContextCache && now - voiceContextCache.at < VOICE_CONTEXT_TTL_MS) {
    return voiceContextCache.bundle;
  }
  const bundle = buildVoiceContext();
  voiceContextCache = { at: now, bundle };
  return bundle;
}

function getGatewayToken(): string {
  try {
    return fs.readFileSync(GATEWAY_TOKEN_FILE, "utf-8").trim();
  } catch {
    return "";
  }
}

async function notifyMainSession(message: string): Promise<void> {
  const token = getGatewayToken();
  if (!token) return;
  try {
    await fetch(`${OPENCLAW_GATEWAY_URL}/v1/sessions/message`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_id: "alfred-main",
        message,
        metadata: { source: "agentphone", type: "voice-call-summary" },
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    console.warn("[phone] notifyMainSession failed", err);
  }
}

async function ingestStreamEvent(event: Record<string, unknown>): Promise<void> {
  // Same effect as posting to /api/v1/streams/ingest, but inline so we don't
  // pay the localhost auth round-trip. ctrl-api server is the only writer for
  // this directory in normal operation.
  const safe = String(event["stream_id"] ?? "voice-call").replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );
  const path = `${STREAMS_DIR}/${safe}.jsonl`;
  fs.mkdirSync(STREAMS_DIR, { recursive: true });
  fs.appendFileSync(path, JSON.stringify(event) + "\n", "utf-8");
}

export function registerPhoneRoutes(): void {
  // GET /api/v1/phone/voice-context — bundle for the bridge to inline
  addRoute("GET", "/api/v1/phone/voice-context", async ({ res }) => {
    sendJson(res, 200, getVoiceContextCached());
  });

  // POST /api/v1/phone/transcript — bridge posts the full call transcript
  addRoute("POST", "/api/v1/phone/transcript", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b) throw new ValidationError("body required");
    const from = typeof b.from === "string" ? b.from : "";
    const to = typeof b.to === "string" ? b.to : "";
    const callId = typeof b.callId === "string" ? b.callId : "";
    const startedAt =
      typeof b.started_at === "string"
        ? b.started_at
        : new Date().toISOString();
    const endedAt =
      typeof b.ended_at === "string" ? b.ended_at : new Date().toISOString();
    const transcript = Array.isArray(b.transcript) ? b.transcript : [];
    const summary =
      typeof b.summary === "string" && b.summary.trim().length > 0
        ? b.summary
        : `Call from ${from || "unknown"}`;

    const event = {
      id: cryptoRandomId(),
      stream_id: "voice-call",
      stream_type: "voice-call",
      received_at: endedAt,
      source_ref: callId || `${from}-${endedAt}`,
      raw: {
        from,
        to,
        started_at: startedAt,
        ended_at: endedAt,
        duration_seconds: durationSeconds(startedAt, endedAt),
        transcript,
        callId,
      },
      summary,
    };

    await ingestStreamEvent(event);
    // Best-effort cross-channel-memory ping. Failure does not block.
    void notifyMainSession(`Phone call ended: ${summary}`);
    sendJson(res, 201, { status: "ingested", event_id: event.id });
  });
}

function cryptoRandomId(): string {
  // Cheap, no crypto import needed; ctrl-api is single-process.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function durationSeconds(start: string, end: string): number {
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return 0;
  return Math.max(0, Math.round((e - s) / 1000));
}
