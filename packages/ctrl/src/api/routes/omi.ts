import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";

const OMI_AUDIO_DIR = "/mnt/encrypted/alfred/streams/omi-audio";
const STREAMS_META_PATH = "/mnt/encrypted/alfred/streams/streams.json";

interface StreamMeta {
  id: string;
  source: string;
  enabled: boolean;
  [key: string]: unknown;
}

interface StreamConfig {
  webhookToken?: string;
  [key: string]: unknown;
}

function loadStreamsMeta(): StreamMeta[] {
  try {
    return JSON.parse(fs.readFileSync(STREAMS_META_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function loadStreamConfig(streamId: string): StreamConfig | null {
  const safe = streamId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const configPath = path.join("/mnt/encrypted/alfred/streams/configs", `${safe}.json`);
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
}

function findOmiStream(token: string): { streamId: string; meta: StreamMeta } | null {
  const streams = loadStreamsMeta();
  for (const meta of streams) {
    if (meta.source !== "omi") continue;
    // Check token in stream metadata (synced from SaaS) or config file
    if ((meta as any).webhookToken === token) {
      return { streamId: meta.id, meta };
    }
    const config = loadStreamConfig(meta.id);
    if (config?.webhookToken === token) {
      return { streamId: meta.id, meta };
    }
  }
  return null;
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function registerOmiRoutes(): void {
  // POST /api/v1/streams/omi/audio?uid=xxx&sample_rate=16000&token=webhookToken
  // Body: raw PCM16 audio bytes from Omi device
  // Always returns 200 (never block the device)
  addRoute("POST", "/api/v1/streams/omi/audio", async ({ req, res, query }) => {
    const token = query.get("token") || "";
    const uid = query.get("uid") || "unknown";
    const sampleRate = parseInt(query.get("sample_rate") || "16000", 10);

    // Always respond 200 to never block the Omi device
    try {
      // Validate webhook token
      if (!token) {
        console.warn("[omi] Audio chunk rejected: missing token");
        sendJson(res, 200, { status: "error", reason: "missing_token" });
        return;
      }

      const omiStream = findOmiStream(token);
      if (!omiStream) {
        console.warn("[omi] Audio chunk rejected: invalid token");
        sendJson(res, 200, { status: "error", reason: "invalid_token" });
        return;
      }

      // Read raw PCM bytes from request body
      const audioBytes = await readRawBody(req);
      if (audioBytes.length === 0) {
        sendJson(res, 200, { status: "error", reason: "empty_body" });
        return;
      }

      // Create directory for this uid
      const uidDir = path.join(OMI_AUDIO_DIR, uid);
      fs.mkdirSync(uidDir, { recursive: true });

      // Write audio chunk and metadata
      const timestamp = Date.now();
      const pcmPath = path.join(uidDir, `${timestamp}.pcm`);
      const metaPath = path.join(uidDir, `${timestamp}.meta.json`);

      fs.writeFileSync(pcmPath, audioBytes);
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          uid,
          sample_rate: sampleRate,
          size_bytes: audioBytes.length,
          received_at: new Date().toISOString(),
          stream_id: omiStream.streamId,
        })
      );

      console.log(
        `[omi] Audio chunk received: uid=${uid} size=${audioBytes.length} stream=${omiStream.streamId}`
      );
      sendJson(res, 200, { status: "ok", size_bytes: audioBytes.length });
    } catch (err) {
      console.error("[omi] Audio chunk handler error:", err);
      sendJson(res, 200, { status: "error", reason: "internal_error" });
    }
  });
}
