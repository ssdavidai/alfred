/**
 * alfred-learn-media hook — detects media/file attachments in OpenClaw sessions
 * and writes StreamEvents to the media ingestion stream.
 *
 * Triggers: message events with file/media attachments
 * Writes to: /mnt/encrypted/alfred/streams/system-media-ingestion.jsonl
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// --- Per-session message buffer (last 3 messages for context) ---
const sessionBuffers = new Map();

const MEDIA_EXTENSIONS = {
  // Images
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  // PDFs
  ".pdf": "application/pdf",
  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".webm": "audio/webm",
  // Video
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  // Documents
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
};

function getExtension(filename) {
  if (!filename) return "";
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

function detectMimeType(filename, providedMime) {
  if (providedMime) return providedMime;
  const ext = getExtension(filename);
  return MEDIA_EXTENSIONS[ext] || null;
}

function isMediaFile(filename, providedMime) {
  if (providedMime) {
    const prefix = providedMime.split("/")[0];
    if (["image", "audio", "video"].includes(prefix)) return true;
    if (providedMime === "application/pdf") return true;
    if (providedMime.includes("document") || providedMime.includes("sheet"))
      return true;
    if (providedMime === "text/csv") return true;
  }
  const ext = getExtension(filename);
  return ext in MEDIA_EXTENSIONS;
}

function getSessionBuffer(sessionKey) {
  if (!sessionBuffers.has(sessionKey)) {
    sessionBuffers.set(sessionKey, []);
  }
  return sessionBuffers.get(sessionKey);
}

function pushToBuffer(sessionKey, role, content) {
  const buf = getSessionBuffer(sessionKey);
  buf.push({ role, content: String(content), at: new Date().toISOString() });
  // Keep only last 3
  if (buf.length > 3) {
    buf.splice(0, buf.length - 3);
  }
}

function writeStreamEvent(streamsDir, event) {
  if (!existsSync(streamsDir)) {
    mkdirSync(streamsDir, { recursive: true });
  }
  const streamPath = join(streamsDir, "system-media-ingestion.jsonl");
  appendFileSync(streamPath, JSON.stringify(event) + "\n", "utf-8");
}

const handler = async (event) => {
  if (event.type !== "message") return;
  const { action, sessionKey, context } = event;
  if (!sessionKey) return;

  // Only capture main agent sessions
  if (!sessionKey.startsWith("agent:main:")) return;

  const workspaceDir =
    context?.workspaceDir ??
    context?.cfg?.agents?.defaults?.workspace ??
    "/home/node/.openclaw/workspace";

  // Buffer messages for context (both directions)
  if (
    (action === "received" || action === "sent") &&
    context?.content
  ) {
    const role = action === "received" ? "user" : "assistant";
    pushToBuffer(sessionKey, role, context.content);
  }

  // Check for file attachments
  const files = context?.files ?? context?.attachments ?? [];
  if (!Array.isArray(files) || files.length === 0) return;

  const streamsDir = join(workspaceDir, "..", "alfred", "streams");

  for (const file of files) {
    const fileName = file.name ?? file.file_name ?? file.filename ?? null;
    const filePath = file.path ?? file.file_path ?? null;
    const providedMime = file.mime_type ?? file.mimeType ?? file.type ?? null;
    const fileSize = file.size ?? file.file_size ?? null;

    if (!fileName && !filePath) continue;
    const nameForDetection = fileName || filePath.split("/").pop();

    if (!isMediaFile(nameForDetection, providedMime)) continue;

    const mimeType = detectMimeType(nameForDetection, providedMime);
    const last3 = getSessionBuffer(sessionKey).slice();

    const streamEvent = {
      id: randomUUID(),
      stream_id: "system-media-ingestion",
      stream_type: "media",
      received_at: new Date().toISOString(),
      source_ref: `${sessionKey}:${nameForDetection}:${Date.now()}`,
      raw: {
        file_path: filePath,
        file_name: nameForDetection,
        mime_type: mimeType,
        file_size: fileSize,
        session_key: sessionKey,
        context: {
          last_3_messages: last3,
          timestamp: new Date().toISOString(),
        },
      },
      summary: `Media file: ${nameForDetection} (${mimeType})`,
    };

    writeStreamEvent(streamsDir, streamEvent);
  }
};

export default handler;
