/**
 * alfred-inbox hook — buffers chat messages and flushes to vault inbox.
 *
 * Flush triggers:
 *   1. 10 conversation turns (configurable via flushTurns)
 *   2. 5 minutes idle since last message (configurable via flushIdleMs)
 */

import { writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
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

function buildMarkdown(session, sessionKey) {
  const msgs = session.messages;
  if (msgs.length === 0) return null;

  const firstUserMsg = msgs.find((m) => m.role === "user");
  const preview = firstUserMsg
    ? firstUserMsg.content.slice(0, 60).replace(/[\r\n]+/g, " ")
    : "chat";
  const ts = new Date().toISOString();
  const lines = msgs.map((m) => {
    const label = m.role === "user" ? "User" : "Assistant";
    return `**${label}:**\n${m.content}\n`;
  });

  const frontmatter = [
    "---",
    `title: 'OpenClaw Chat — ${preview.replace(/'/g, "''")}'`,
    `source: openclaw`,
    `session_key: ${sessionKey}`,
    `harvested_at: ${ts}`,
    `message_count: ${msgs.length}`,
    "---",
    "",
  ].join("\n");

  return frontmatter + lines.join("\n---\n\n");
}

function flush(sessionKey, workspaceDir) {
  const session = sessions.get(sessionKey);
  if (!session || session.messages.length === 0) return;

  const md = buildMarkdown(session, sessionKey);
  if (!md) return;

  const inboxDir = join(workspaceDir, "vault", "inbox");
  if (!existsSync(inboxDir)) {
    mkdirSync(inboxDir, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `openclaw-chat-${safeKey}-${ts}.md`;

  writeFileSync(join(inboxDir, filename), md, "utf-8");

  // Also append a StreamEvent to the system-openclaw-sessions stream
  const streamsDir = join(workspaceDir, "..", "alfred", "streams");
  if (!existsSync(streamsDir)) {
    mkdirSync(streamsDir, { recursive: true });
  }
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
    summary: `Chat session \u2014 ${session.turns} turns`,
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
