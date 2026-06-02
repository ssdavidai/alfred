// recall-server — HTTP handler for `/voice/recall-turn` (#113 PR5).
//
// One POST = one in-meeting Realtime turn. ctrl-api calls this when its
// realtime subscriber heard the wake word inside a Recall meeting; we
// run one OpenAI Realtime exchange and return rendered audio + the
// transcript text. ctrl-api uploads the audio to Recall's output_audio
// endpoint, where it plays into the meeting.
//
// Auth: shared `Authorization: Bearer <VOICE_BRIDGE_INTERNAL_TOKEN>`. The
// header is the same secret ctrl-api uses on its side to accept
// /voice-bridge/* callbacks. Anyone with this token can drive Alfred's
// voice through Recall on this tenant — same blast radius as a SaaS
// internal token in single-VM mode.

import type { IncomingMessage, ServerResponse } from "http";
import { config } from "./config.js";
import { runRecallTurn } from "./recall-session.js";

const MAX_BODY_BYTES = 64 * 1024;

interface RecallTurnRequestBody {
  bot_id?: unknown;
  transcript?: unknown;
  wake_word?: unknown;
  meeting_context?: unknown;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`request body exceeded ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(b);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw);
}

function reply(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

export async function handleRecallTurnRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Auth — constant-time compare on the bearer header.
  const auth = req.headers["authorization"];
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
    reply(res, 401, { ok: false, error: "missing bearer" });
    return;
  }
  const offered = auth.slice("Bearer ".length).trim();
  const expected = config.internalToken;
  if (
    offered.length !== expected.length ||
    !timingSafeEqualStrings(offered, expected)
  ) {
    reply(res, 401, { ok: false, error: "bad bearer" });
    return;
  }
  let body: RecallTurnRequestBody;
  try {
    body = (await readJsonBody(req)) as RecallTurnRequestBody;
  } catch (err) {
    reply(res, 400, {
      ok: false,
      error: err instanceof Error ? err.message : "bad body",
    });
    return;
  }
  if (typeof body.bot_id !== "string" || body.bot_id.trim().length === 0) {
    reply(res, 400, { ok: false, error: "bot_id required" });
    return;
  }
  if (
    typeof body.transcript !== "string" ||
    body.transcript.trim().length === 0
  ) {
    reply(res, 400, { ok: false, error: "transcript required" });
    return;
  }
  const wakeWord =
    typeof body.wake_word === "string" && body.wake_word.trim().length > 0
      ? body.wake_word.trim()
      : "Alfred";
  const meetingContext =
    typeof body.meeting_context === "object" && body.meeting_context !== null
      ? (body.meeting_context as any)
      : null;
  const turn = await runRecallTurn({
    botId: body.bot_id.trim(),
    transcript: body.transcript.trim(),
    wakeWord,
    meetingContext,
  });
  if (!turn.ok) {
    reply(res, 502, {
      ok: false,
      latency_ms: turn.latency_ms,
      reason: turn.reason,
    });
    return;
  }
  reply(res, 200, {
    ok: true,
    audio_base64: turn.audio_base64,
    text: turn.text,
    latency_ms: turn.latency_ms,
  });
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
