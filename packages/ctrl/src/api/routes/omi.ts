import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";

const ALFRED_DATA_DIR = process.env.ALFRED_DATA_DIR ?? "/alfred-data";
const STREAMS_DIR = path.join(ALFRED_DATA_DIR, "streams");
const OMI_AUDIO_DIR = path.join(STREAMS_DIR, "omi-audio");
const STREAMS_META_PATH = path.join(STREAMS_DIR, "streams.json");

const parseNumericId = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

// ctrl-api runs as root in the deployment while alfred-learn runs as uid/gid
// 1000. A normal root-owned 0755 directory lets the processor read incoming
// PCM chunks but not create its processed/ directory, permanently blocking
// transcription. Hand each per-device directory to the processor account.
// The writable fallback keeps local/non-root development usable when chown is
// unavailable; the Docker volume is private to trusted stack services.
export function ensureOmiUidDirectory(uid: string): string {
  const uidDir = path.join(OMI_AUDIO_DIR, uid);
  fs.mkdirSync(uidDir, { recursive: true });

  const processorUid = parseNumericId(process.env.OMI_PROCESSOR_UID, 1000);
  const processorGid = parseNumericId(process.env.OMI_PROCESSOR_GID, 1000);
  try {
    fs.chownSync(uidDir, processorUid, processorGid);
    fs.chmodSync(uidDir, 0o770);
  } catch {
    fs.chmodSync(uidDir, 0o777);
  }

  return uidDir;
}

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
  const configPath = path.join(STREAMS_DIR, "configs", `${safe}.json`);
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
    // Sanitize uid: only [a-zA-Z0-9_-] survives. The OMI device has been
    // observed sending malformed query strings (e.g. `?uid=omi-device?sample_rate=16000`,
    // using `?` instead of `&` between params), which produced a literal `?` in
    // the uid value and a tooling-hostile directory name on disk. Forbidden
    // chars get squashed to `_`. Empty result falls back to "unknown".
    const rawUid = query.get("uid") || "";
    const uid = rawUid.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
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
      const uidDir = ensureOmiUidDirectory(uid);

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
