/**
 * alfred-inbox hook — buffers chat messages and flushes as stream events.
 *
 * Conversations are written to the system-openclaw-sessions stream.
 * The EventProcessor → Judgment → Curator pipeline handles classification,
 * routing, and structured record creation.
 *
 * Flush triggers:
 *   1. 10 conversation turns (configurable via flushTurns)
 *   2. 5 minutes idle since last message (configurable via flushIdleMs)
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// --- Per-session buffer ---
const sessions = new Map();

const DEFAULT_FLUSH_TURNS = 10;
const DEFAULT_FLUSH_IDLE_MS = 5 * 60 * 1000; // 5 minutes

function getConfig(event) {
  const cfg = event.context?.cfg;
  const entry =
    cfg?.hooks?.internal?.entries?.["alfred-inbox"] ?? {};
  return {
    flushTurns: entry.flushTurns ?? DEFAULT_FLUSH_TURNS,
    flushIdleMs: entry.flushIdleMs ?? DEFAULT_FLUSH_IDLE_MS,
  };
}

function getSession(sessionKey) {
  if (!sessions.has(sessionKey)) {
    sessions.set(sessionKey, {
      messages: [],
      turns: 0, // counts user+assistant pairs
      lastMessageAt: null,
      idleTimer: null,
    });
  }
  return sessions.get(sessionKey);
}

function clearSession(sessionKey) {
  const s = sessions.get(sessionKey);
  if (s?.idleTimer) clearTimeout(s.idleTimer);
  sessions.delete(sessionKey);
}

function flush(sessionKey, workspaceDir) {
  const session = sessions.get(sessionKey);
  if (!session || session.messages.length === 0) return;

  // Append a StreamEvent to the system-openclaw-sessions stream.
  // The EventProcessor → Judgment → Curator pipeline handles classification,
  // routing, and structured record creation. No direct inbox write needed.
  const streamsDir = join(workspaceDir, "..", "alfred", "streams");
  if (!existsSync(streamsDir)) {
    mkdirSync(streamsDir, { recursive: true });
  }

  const firstUserMsg = session.messages.find((m) => m.role === "user");
  const preview = firstUserMsg
    ? firstUserMsg.content.slice(0, 60).replace(/[\r\n]+/g, " ")
    : "chat";

  const streamEvent = {
    id: randomUUID(),
    stream_id: "system-openclaw-sessions",
    stream_type: "conversation",
    received_at: new Date().toISOString(),
    source_ref: `${sessionKey}:${Date.now()}`,
    raw: {
      session_key: sessionKey,
      messages: session.messages,
      turns: session.turns,
    },
    summary: `Chat session — ${session.turns} turns: ${preview}`,
  };
  const streamPath = join(streamsDir, "system-openclaw-sessions.jsonl");
  appendFileSync(streamPath, JSON.stringify(streamEvent) + "\n", "utf-8");

  clearSession(sessionKey);
}

function resetIdleTimer(sessionKey, workspaceDir, flushIdleMs) {
  const session = sessions.get(sessionKey);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    flush(sessionKey, workspaceDir);
  }, flushIdleMs);
}

const handler = async (event) => {
  // Only handle message events
  if (event.type !== "message") return;
  const { action, sessionKey, context } = event;
  if (!sessionKey) return;

  // Only capture main agent sessions (skip vault-curator etc.)
  if (!sessionKey.startsWith("agent:main:")) return;

  const workspaceDir =
    context?.workspaceDir ??
    context?.cfg?.agents?.defaults?.workspace ??
    "/home/node/.openclaw/workspace";

  const { flushTurns, flushIdleMs } = getConfig(event);
  const session = getSession(sessionKey);

  if (action === "received" && context?.content) {
    session.messages.push({
      role: "user",
      content: String(context.content),
      at: new Date().toISOString(),
    });
    session.lastMessageAt = Date.now();
    resetIdleTimer(sessionKey, workspaceDir, flushIdleMs);
  } else if (action === "sent" && context?.content && context?.success !== false) {
    session.messages.push({
      role: "assistant",
      content: String(context.content),
      at: new Date().toISOString(),
    });
    session.lastMessageAt = Date.now();
    session.turns += 1;

    // Flush on turn threshold
    if (session.turns >= flushTurns) {
      flush(sessionKey, workspaceDir);
    } else {
      resetIdleTimer(sessionKey, workspaceDir, flushIdleMs);
    }
  }
};

export default handler;
