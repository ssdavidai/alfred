/**
 * Universal channel attachment endpoint.
 *
 * When the main agent receives a Slack / Telegram / SMS / webhook
 * message that references a file (audio, PDF, image, document), it calls
 * `self({endpoint: "/api/v1/channels/attachment/fetch", method: "POST",
 *   body: {source, file_ref, ...}})` to pull the file bytes into scope.
 *
 * This endpoint:
 *   1. Resolves the file URL + auth for the source channel.
 *   2. Downloads bytes into `/mnt/encrypted/vault/inbox/<safename>`.
 *   3. For audio: runs Groq Whisper inline for a transcript.
 *   4. Emits a `stream_type: "media"` event so MediaIngestionWorkflow
 *      builds a full vault record async (full transcription + linking).
 *   5. Returns the inline transcript/text + vault path so the agent has
 *      the content in-session, not "I don't see your file".
 *
 * Supported sources:
 *   - slack:     Composio SLACK_FILES_INFO → url_private_download → OAuth fetch
 *   - telegram:  Composio TELEGRAM_CORE_GET_FILE → file_path → public fetch
 *   - mms:       Twilio basic-auth fetch from mediaUrl
 *   - url:       Raw URL fetch (for pre-authenticated URLs)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";

const VAULT_PATH = process.env.VAULT_PATH ?? "/vault";
const INBOX_DIR = path.join(VAULT_PATH, "inbox");
const STREAMS_DIR = path.join(process.env.ALFRED_DATA_DIR ?? "/alfred-data", "streams");
const COMPOSIO_API = "https://backend.composio.dev/api/v3";
const GROQ_WHISPER_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

// Max fetched bytes per attachment — protects against runaway downloads of
// a 2GB file that would blow both disk and the Whisper transcription budget.
// Groq caps audio inputs at 25MB anyway.
const MAX_BYTES = 30 * 1024 * 1024; // 30 MB

const AUDIO_MIMES = new Set([
  "audio/wav", "audio/x-wav",
  "audio/mpeg", "audio/mp3",
  "audio/mp4", "audio/m4a", "audio/x-m4a",
  "audio/ogg", "audio/oga", "audio/opus", "audio/webm",
  "audio/flac", "audio/x-flac",
  "audio/amr", "audio/3gpp",
]);

const TEXT_DOC_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
]);

interface AttachmentRequest {
  source?: string;
  file_ref?: string;
  file_url?: string;
  file_name?: string;
  mime_type?: string;
  // For slack: channel id. For telegram: chat id / bot token optional.
  extra?: Record<string, unknown>;
}

interface AttachmentResult {
  ok: boolean;
  source: string;
  file_name: string;
  mime_type: string;
  size: number;
  vault_path: string;
  transcript?: string;
  text?: string;
  error?: string;
}

export function registerChannelsAttachmentRoutes(): void {
  addRoute(
    "POST",
    "/api/v1/channels/attachment/fetch",
    async ({ res, body }) => {
      const b = (body as AttachmentRequest | undefined) ?? {};
      const source = (b.source ?? "").toLowerCase().trim();
      if (!source) {
        throw new ValidationError("source required (slack|telegram|mms|url)");
      }

      // 1. Resolve URL + auth for this source.
      let downloadUrl = "";
      let authHeader: string | undefined;
      let nameHint = b.file_name ?? "";
      let mimeHint = b.mime_type ?? "";

      try {
        if (source === "slack") {
          const info = await resolveSlackFile(b);
          downloadUrl = info.url;
          authHeader = info.authHeader;
          nameHint = nameHint || info.fileName || "";
          mimeHint = mimeHint || info.mimeType || "";
        } else if (source === "telegram") {
          const info = await resolveTelegramFile(b);
          downloadUrl = info.url;
          nameHint = nameHint || info.fileName || "";
          mimeHint = mimeHint || info.mimeType || "";
        } else if (source === "mms") {
          const info = resolveMmsFile(b);
          downloadUrl = info.url;
          authHeader = info.authHeader;
          nameHint = nameHint || info.fileName || "";
          mimeHint = mimeHint || info.mimeType || "";
        } else if (source === "url") {
          downloadUrl = (b.file_url ?? "").trim();
          if (!downloadUrl) throw new ValidationError("file_url required for source=url");
        } else {
          throw new ValidationError(
            `unknown source: ${source} (want slack|telegram|mms|url)`,
          );
        }
      } catch (err: any) {
        sendJson(res, 400, {
          ok: false,
          source,
          error: `resolve failed: ${err?.message ?? err}`,
        });
        return;
      }

      // 2. Download bytes.
      let bytes: Buffer;
      let contentType = mimeHint;
      try {
        const downloadResult = await fetchBytes(downloadUrl, authHeader);
        bytes = downloadResult.bytes;
        contentType = contentType || downloadResult.contentType || "";
      } catch (err: any) {
        sendJson(res, 502, {
          ok: false,
          source,
          error: `download failed: ${err?.message ?? err}`,
        });
        return;
      }

      if (bytes.length === 0) {
        sendJson(res, 502, { ok: false, source, error: "downloaded 0 bytes" });
        return;
      }

      // 3. Save to vault inbox with a safe deterministic filename.
      if (!nameHint) {
        const ext = guessExt(contentType);
        nameHint = `attachment-${Date.now()}${ext}`;
      }
      const safeName = sanitiseFilename(nameHint);
      fs.mkdirSync(INBOX_DIR, { recursive: true });
      const vaultPath = path.join(INBOX_DIR, safeName);
      fs.writeFileSync(vaultPath, bytes);
      const result: AttachmentResult = {
        ok: true,
        source,
        file_name: safeName,
        mime_type: contentType,
        size: bytes.length,
        vault_path: `inbox/${safeName}`,
      };

      // 4. Inline processing based on type.
      const mimeLower = contentType.toLowerCase();
      if (AUDIO_MIMES.has(mimeLower) || mimeLower.startsWith("audio/")) {
        const transcript = await transcribeAudio(bytes, safeName, mimeLower);
        if (transcript) {
          result.transcript = transcript;
          result.text = transcript;
        }
      } else if (
        TEXT_DOC_MIMES.has(mimeLower) ||
        mimeLower.startsWith("text/")
      ) {
        // Small-body text docs: return content inline up to 30KB for the
        // agent's context window. Larger files leave it to downstream
        // MediaIngestionWorkflow.
        if (bytes.length <= 30 * 1024) {
          result.text = bytes.toString("utf-8");
        }
      }

      // 5. Emit stream event for async MediaIngestionWorkflow (full
      //    vault record + embed + surveyor linkage).
      try {
        emitMediaStreamEvent({
          source,
          vault_path: result.vault_path,
          file_name: safeName,
          mime_type: contentType,
          size: bytes.length,
          transcript: result.transcript,
        });
      } catch (err: any) {
        console.warn("[channels/attachment] emit stream event failed", err);
      }

      sendJson(res, 200, result);
    },
  );
}

// ---------------------------------------------------------------------------
// Source resolvers
// ---------------------------------------------------------------------------

async function resolveSlackFile(
  req: AttachmentRequest,
): Promise<{ url: string; authHeader?: string; fileName?: string; mimeType?: string }> {
  // Slack path: user passes file_ref (file_id, e.g. F0H0ABC). We call
  // Composio's SLACK_FILES_INFO to resolve the signed download URL. The
  // URL requires the user's Slack OAuth token to dereference.
  const fileId = (req.file_ref ?? "").trim();
  if (!fileId) {
    throw new Error("file_ref required for source=slack (pass Slack file_id like F0H0ABC)");
  }

  const composioKey = process.env.COMPOSIO_API_KEY ?? "";
  const userId = process.env.COMPOSIO_USER_ID ?? "";
  if (!composioKey || !userId) {
    throw new Error("COMPOSIO_API_KEY + COMPOSIO_USER_ID env vars required for Slack attachment fetch");
  }

  const actionResp = await fetch(`${COMPOSIO_API}/actions/execute`, {
    method: "POST",
    headers: {
      "x-api-key": composioKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "SLACK_FILES_INFO",
      arguments: { file: fileId },
      user_id: userId,
    }),
  });
  if (!actionResp.ok) {
    throw new Error(`Composio SLACK_FILES_INFO → ${actionResp.status}`);
  }
  const actionJson = (await actionResp.json()) as any;
  const file = actionJson?.data?.file ?? actionJson?.data ?? {};
  const url = file.url_private_download ?? file.url_private ?? "";
  if (!url) throw new Error("SLACK_FILES_INFO returned no url_private_download");

  // Slack private URLs need Authorization: Bearer <slack-token>. The token
  // lives inside Composio's connected_account auth config; easiest accessor
  // is to ask Composio for it via the connected_accounts endpoint.
  const slackToken = await fetchComposioSlackToken(composioKey, userId);
  return {
    url,
    authHeader: slackToken ? `Bearer ${slackToken}` : undefined,
    fileName: file.name ?? file.title ?? "",
    mimeType: file.mimetype ?? "",
  };
}

async function fetchComposioSlackToken(
  composioKey: string,
  userId: string,
): Promise<string> {
  const url = new URL(`${COMPOSIO_API}/connected_accounts`);
  url.searchParams.set("user_id", userId);
  const resp = await fetch(url.toString(), {
    headers: { "x-api-key": composioKey },
  });
  if (!resp.ok) return "";
  const data = (await resp.json()) as any;
  for (const acct of data?.items ?? []) {
    const slug = (acct?.toolkit?.slug ?? "").toLowerCase();
    if (slug === "slack") {
      return (
        acct?.auth_config?.credentials?.access_token ??
        acct?.auth_config?.access_token ??
        ""
      );
    }
  }
  return "";
}

async function resolveTelegramFile(
  req: AttachmentRequest,
): Promise<{ url: string; fileName?: string; mimeType?: string }> {
  const fileId = (req.file_ref ?? "").trim();
  if (!fileId) {
    throw new Error("file_ref required for source=telegram (pass Telegram file_id)");
  }

  const botToken =
    (req.extra?.["bot_token"] as string | undefined) ??
    process.env.TELEGRAM_BOT_TOKEN ??
    "";
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN env var required (or pass extra.bot_token)");
  }

  // Telegram's Bot API: getFile returns {file_path}. Then download from
  // https://api.telegram.org/file/bot<token>/<file_path>.
  const apiResp = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  if (!apiResp.ok) {
    throw new Error(`Telegram getFile → ${apiResp.status}`);
  }
  const apiJson = (await apiResp.json()) as any;
  const filePath = apiJson?.result?.file_path;
  if (!filePath) {
    throw new Error("Telegram getFile returned no file_path");
  }
  return {
    url: `https://api.telegram.org/file/bot${botToken}/${filePath}`,
    fileName: path.basename(filePath),
    // Guessed from extension by downloader.
    mimeType: "",
  };
}

function resolveMmsFile(
  req: AttachmentRequest,
): { url: string; authHeader?: string; fileName?: string; mimeType?: string } {
  // MMS: agent passes file_url (Twilio MediaUrl0, pre-signed). Twilio URLs
  // need HTTP basic auth (Account SID + Auth Token). Token lives on SaaS;
  // ctrl-api doesn't hold it. Instead we accept a `file_url` that the SMS
  // route should have proxied through the SaaS send-sms internal endpoint
  // with the Twilio auth already embedded OR the agent passes pre-fetched
  // bytes. Simpler MVP: attempt the fetch unauthenticated; if 401, bail
  // with a clear error telling the caller to use source=url after the
  // SaaS Twilio-side proxy has downloaded + re-published.
  const url = (req.file_url ?? "").trim();
  if (!url) {
    throw new Error("file_url required for source=mms (pass Twilio MediaUrl0)");
  }
  // No inline auth — the Twilio MediaUrl0 links are signed and expire
  // quickly; most work without auth for the short retention window.
  return {
    url,
    fileName: req.file_name ?? "",
    mimeType: req.mime_type ?? "",
  };
}

// ---------------------------------------------------------------------------
// Bytes fetcher
// ---------------------------------------------------------------------------

async function fetchBytes(
  url: string,
  authHeader?: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const headers: Record<string, string> = {};
  if (authHeader) headers["Authorization"] = authHeader;

  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(`download ${url} → ${resp.status}`);
  }
  const contentType = (resp.headers.get("content-type") ?? "").split(";")[0].trim();
  const arr = new Uint8Array(await resp.arrayBuffer());
  if (arr.byteLength > MAX_BYTES) {
    throw new Error(`file too large: ${arr.byteLength} bytes > ${MAX_BYTES}`);
  }
  return { bytes: Buffer.from(arr), contentType };
}

// ---------------------------------------------------------------------------
// Audio transcription (Groq Whisper)
// ---------------------------------------------------------------------------

async function transcribeAudio(
  bytes: Buffer,
  fileName: string,
  mimeType: string,
): Promise<string> {
  const groqKey = process.env.GROQ_API_KEY ?? "";
  if (!groqKey) {
    console.warn("[channels/attachment] GROQ_API_KEY not set — skipping transcription");
    return "";
  }

  // Groq caps audio at 25MB. Larger inputs should go straight to the async
  // MediaIngestionWorkflow, which can stream-upload.
  if (bytes.length > 24 * 1024 * 1024) {
    console.warn(
      "[channels/attachment] audio too big for Groq inline (%d bytes); deferring to async MediaIngestionWorkflow",
      bytes.length,
    );
    return "";
  }

  try {
    // Build multipart manually — node-fetch's FormData is limited, but the
    // native undici FormData in Node 22 handles Blob + File OK.
    const form = new FormData();
    // Blob accepts typed arrays; the cast below matches the standard Web API.
    form.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: mimeType || "audio/mpeg" }) as unknown as Blob,
      fileName,
    );
    form.append("model", "whisper-large-v3");
    form.append("response_format", "verbose_json");

    const resp = await fetch(GROQ_WHISPER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}` },
      body: form as any,
    });
    if (!resp.ok) {
      console.warn(
        "[channels/attachment] Groq %d: %s",
        resp.status,
        (await resp.text()).slice(0, 200),
      );
      return "";
    }
    const data = (await resp.json()) as any;
    return String(data?.text ?? "").trim();
  } catch (err: any) {
    console.warn("[channels/attachment] transcription error:", err?.message ?? err);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Stream emitter for async MediaIngestionWorkflow
// ---------------------------------------------------------------------------

function emitMediaStreamEvent(params: {
  source: string;
  vault_path: string;
  file_name: string;
  mime_type: string;
  size: number;
  transcript?: string;
}): void {
  fs.mkdirSync(STREAMS_DIR, { recursive: true });
  const jsonlPath = path.join(STREAMS_DIR, "system-media-ingestion.jsonl");
  const event = {
    id: crypto.randomUUID(),
    stream_id: "system-media-ingestion",
    stream_type: "media",
    received_at: new Date().toISOString(),
    source_ref: `${params.source}:${params.file_name}`,
    raw: {
      source: params.source,
      file_name: params.file_name,
      file_path: `/vault/${params.vault_path}`,
      mime_type: params.mime_type,
      file_size: params.size,
      transcript_hint: params.transcript?.slice(0, 500) ?? "",
    },
    metadata: {
      source: params.source,
    },
  };
  fs.appendFileSync(jsonlPath, JSON.stringify(event) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitiseFilename(name: string): string {
  // Keep alnum, dot, dash, underscore. Replace everything else with dash.
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
  return safe.slice(0, 120) || "attachment";
}

function guessExt(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes("mpeg") || lower.includes("mp3")) return ".mp3";
  if (lower.includes("m4a") || lower.includes("mp4")) return ".m4a";
  if (lower.includes("wav")) return ".wav";
  if (lower.includes("ogg") || lower.includes("opus")) return ".ogg";
  if (lower.includes("flac")) return ".flac";
  if (lower.includes("webm")) return ".webm";
  if (lower.includes("pdf")) return ".pdf";
  if (lower.includes("plain")) return ".txt";
  if (lower.includes("png")) return ".png";
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  return ".bin";
}
