// recall_realtime — ctrl-api side of the Recall.ai two-way voice loop (#113 PR5).
//
// PR2 (#129) shipped the recall_config + recall_bot + recall_event tables and
// the passive lifecycle webhook. PR3 surfaced the operator card. PR4 wired
// the auto-dispatcher. This file makes the bot ACTIVE: when a meeting moves
// into `in_call_recording`, we subscribe to Recall's per-bot real-time WS,
// listen for the wake word, and route a turn through voice-bridge so Alfred
// can answer back INTO the meeting.
//
// Surface:
//
//   - subscribeBotRealtime(botId)   — kicked off by the lifecycle webhook
//                                     once the bot transitions to
//                                     `in_meeting`. Opens the WS, watches
//                                     for transcript.final, fuzzy-matches
//                                     the wake word against the
//                                     configured phrase.
//
//   - stopBotRealtime(botId)        — called by the webhook when the bot
//                                     leaves / is terminated. Drops the
//                                     WS and clears in-memory state.
//
//   - persistTranscriptEvent(...)   — append-only ledger writer. Used by
//                                     both the subscriber and the SSE
//                                     stream consumers below.
//
//   - speakIntoMeeting(...)         — render text → audio → POST it to
//                                     Recall's `/bot/:id/output_audio`.
//                                     Used by the manual "Speak now"
//                                     button and by the auto-response
//                                     path after a wake-word hit.
//
// The fuzzy matcher uses a deterministic Jaro-Winkler similarity (no
// extra deps). Default threshold is 0.85 per the spec — high enough that
// "Hey Alfred" matches "hey, alfred" / "hey alfreds" but rejects "hey
// kindred" or "el dorado". The threshold is tunable via env so an
// operator can dial it tighter (false-positive cost = an unwanted reply
// in the middle of someone else's monologue; tighter wins for
// principal-attendee meetings where Sir does the wake-summoning).
//
// The voice-bridge round-trip lives at POST /api/v1/voice-bridge/recall-turn.
// We POST a JSON envelope of `{bot_id, transcript, wake_word, meeting_context}`
// and the bridge replies synchronously with PCM16 audio bytes. We then
// upload those bytes to Recall's output_audio endpoint. Doing the round-trip
// synchronously keeps the wake-word→speak loop under the 1500ms p95 budget
// (the latency floor is OpenAI Realtime's TTFB; Recall + voice-bridge add
// O(50ms) each at small payload sizes).
//
// Logs prefix-only the API key — `process.env.RECALL_API_KEY` is never
// echoed in any error or log line; we use the first six characters as a
// fingerprint when correlating Recall responses against tenant logs.

import crypto from "node:crypto";
import { WebSocket as WsSocket } from "ws";
import { getStateDb } from "../../db/state.js";
import type { DatabaseSync } from "node:sqlite";

// ── tunables (env-overridable) ─────────────────────────────────────────────

function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Jaro-Winkler similarity threshold — default 0.85 per spec.
 *
 * Higher = tighter match (fewer false positives, more missed summons).
 * Lower = looser (Alfred barges in more, including on close-sounding
 * non-summons). The spec note: false-positive cost in a meeting is an
 * unwanted reply on top of someone else's speaking turn — Recall's
 * output_audio is not interruptible by the speaker. Default to 0.85
 * which empirically catches casual "hey alfred" / "alfred" / "hey
 * alfreds" while rejecting "el dorado" / "all friends".
 */
function wakeWordThreshold(): number {
  return envNumber("RECALL_WAKE_WORD_THRESHOLD", 0.85);
}

/** Voice-bridge URL for the internal `recall-turn` POST. Default to the
 *  in-cluster sibling at http://voice-bridge:9000 — same shape as the
 *  esphome path. */
function voiceBridgeUrl(): string {
  return (
    process.env.VOICE_BRIDGE_INTERNAL_URL ??
    process.env.VOICE_BRIDGE_URL ??
    "http://voice-bridge:9000"
  );
}

function recallRegionHost(): string {
  // Recall region is on recall_config (set by the card). For voice we
  // accept the same value the rest of the routes read from
  // getOrSeedConfig — keeping it env-tunable for tests.
  return (
    process.env.RECALL_BASE_URL_OVERRIDE ?? "https://us-east-1.recall.ai"
  );
}

// ── Jaro-Winkler similarity (pure helper, exported for tests) ─────────────

/** Classic Jaro similarity. Returns 0..1. */
function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(i + matchWindow + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions = transpositions / 2;
  return (
    matches / a.length / 3 +
    matches / b.length / 3 +
    (matches - transpositions) / matches / 3
  );
}

/** Jaro-Winkler boosts the score for shared prefixes (max 4 chars). */
export function jaroWinkler(a: string, b: string): number {
  const j = jaroSimilarity(a, b);
  if (j === 0) return 0;
  const maxPrefix = 4;
  let prefix = 0;
  for (let i = 0; i < Math.min(maxPrefix, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return j + prefix * 0.1 * (1 - j);
}

/** Normalise: lowercase, strip punctuation, collapse whitespace. */
function normaliseForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Return true if the wake word appears anywhere in `text` with Jaro-Winkler
 *  similarity ≥ threshold. We scan word n-grams whose length matches the
 *  wake-word word-count so "hey alfred" matches a phrase containing those
 *  two consecutive words even with punctuation/extra fillers. */
export function detectWakeWord(
  text: string,
  wakeWord: string,
  threshold: number = wakeWordThreshold(),
): { hit: boolean; score: number; matchedSpan: string | null } {
  const ww = normaliseForMatch(wakeWord);
  const t = normaliseForMatch(text);
  if (!ww || !t) return { hit: false, score: 0, matchedSpan: null };
  // Cheap exact-substring win.
  if (t.includes(ww)) {
    return { hit: true, score: 1, matchedSpan: ww };
  }
  const wwWords = ww.split(" ");
  const tWords = t.split(" ");
  if (tWords.length < wwWords.length) {
    const score = jaroWinkler(ww, t);
    return {
      hit: score >= threshold,
      score,
      matchedSpan: score >= threshold ? t : null,
    };
  }
  let best = 0;
  let bestSpan: string | null = null;
  for (let i = 0; i + wwWords.length <= tWords.length; i++) {
    const span = tWords.slice(i, i + wwWords.length).join(" ");
    const score = jaroWinkler(ww, span);
    if (score > best) {
      best = score;
      bestSpan = span;
    }
  }
  return { hit: best >= threshold, score: best, matchedSpan: bestSpan };
}

// ── In-memory subscriber registry ─────────────────────────────────────────

interface SubscriberEntry {
  botId: string;
  ws: WsSocket | null;
  closed: boolean;
  reconnectAttempt: number;
  // For testability: the per-event listener bus.
  listeners: Set<(event: unknown) => void>;
  // Cancellable reconnect-backoff timer so stopBotRealtime() can free
  // the event loop immediately rather than waiting up to 30s for the
  // next scheduled reconnect.
  reconnectTimer: NodeJS.Timeout | null;
}

const subscribers = new Map<string, SubscriberEntry>();

/** Test-visibility hook — the set of bot_ids we currently hold a WS open
 *  for. Not part of the public surface; tests use it to assert subscribe/
 *  unsubscribe lifecycles. */
export function _activeSubscribers(): string[] {
  return Array.from(subscribers.keys());
}

/** Test hook — replace globalThis.fetch indirectly. The realtime
 *  module uses the global fetch so node:test mocks via globalThis.fetch
 *  Just Work. */

// ── transcript-stream pub/sub ─────────────────────────────────────────────
//
// The SSE endpoint subscribes to a per-bot event bus so we can fan
// transcript fragments to the dashboard without polling. Each bot has at
// most a small handful of subscribers (one per browser tab on the operator
// dashboard).

type StreamListener = (event: TranscriptStreamFrame) => void;
const streamListeners = new Map<string, Set<StreamListener>>();

export interface TranscriptStreamFrame {
  kind: "partial" | "final" | "response" | "wake_word_hit";
  speaker: string | null;
  text: string;
  ts_ms: number;
  meeting_ms: number | null;
  score?: number;
}

export function subscribeTranscriptStream(
  botId: string,
  listener: StreamListener,
): () => void {
  let bucket = streamListeners.get(botId);
  if (!bucket) {
    bucket = new Set();
    streamListeners.set(botId, bucket);
  }
  bucket.add(listener);
  return () => {
    const b = streamListeners.get(botId);
    if (!b) return;
    b.delete(listener);
    if (b.size === 0) streamListeners.delete(botId);
  };
}

function emitStream(botId: string, frame: TranscriptStreamFrame): void {
  const bucket = streamListeners.get(botId);
  if (!bucket) return;
  for (const l of bucket) {
    try {
      l(frame);
    } catch (err) {
      console.warn(
        `[recall-realtime ${botId}] stream listener threw`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

// ── transcript persistence ─────────────────────────────────────────────────

export function persistTranscriptEvent(
  db: DatabaseSync,
  botId: string,
  kind: "partial" | "final" | "response",
  text: string,
  opts: { speaker?: string | null; meeting_ms?: number | null; ts_ms?: number } = {},
): number {
  const tsMs = opts.ts_ms ?? Date.now();
  const result = db
    .prepare(
      `INSERT INTO recall_transcript_event
        (bot_id, kind, speaker, text, ts_ms, meeting_ms)
      VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      botId,
      kind,
      opts.speaker ?? null,
      text,
      tsMs,
      opts.meeting_ms ?? null,
    );
  return Number(result.lastInsertRowid);
}

// ── Recall WS subscriber ───────────────────────────────────────────────────

function recallApiKey(): string | null {
  const raw = process.env.RECALL_API_KEY?.trim();
  return raw && raw.length > 0 ? raw : null;
}

interface BotRowMin {
  id: string;
  realtime_url: string | null;
  muted: number;
  meeting_context_json: string | null;
  calendar_event_id: string | null;
  status: string;
}

function readBotRow(db: DatabaseSync, botId: string): BotRowMin | null {
  return (
    (db
      .prepare(
        `SELECT id, realtime_url, muted, meeting_context_json,
                calendar_event_id, status
           FROM recall_bot
          WHERE id = ?`,
      )
      .get(botId) as BotRowMin | undefined) ?? null
  );
}

function readWakeWord(db: DatabaseSync): string {
  const row = db
    .prepare(`SELECT wake_word FROM recall_config WHERE id = 1`)
    .get() as { wake_word: string } | undefined;
  return row?.wake_word ?? "Alfred";
}

/** Subscribe to a bot's real-time WS. Idempotent — calling it twice for
 *  the same bot is a no-op. The function is async only for test
 *  convenience; callers may fire-and-forget. */
export async function subscribeBotRealtime(botId: string): Promise<void> {
  if (subscribers.has(botId)) return;
  const db = getStateDb();
  const row = readBotRow(db, botId);
  if (!row) {
    console.warn(`[recall-realtime ${botId}] no row in recall_bot — refusing to subscribe`);
    return;
  }
  if (!row.realtime_url) {
    console.warn(`[recall-realtime ${botId}] no realtime_url on row — refusing to subscribe`);
    return;
  }
  const apiKey = recallApiKey();
  if (!apiKey) {
    console.warn(`[recall-realtime ${botId}] RECALL_API_KEY missing — cannot subscribe`);
    return;
  }
  const entry: SubscriberEntry = {
    botId,
    ws: null,
    closed: false,
    reconnectAttempt: 0,
    listeners: new Set(),
    reconnectTimer: null,
  };
  subscribers.set(botId, entry);
  void openWebsocketWithBackoff(entry, row.realtime_url, apiKey);
}

async function openWebsocketWithBackoff(
  entry: SubscriberEntry,
  url: string,
  apiKey: string,
): Promise<void> {
  while (!entry.closed) {
    try {
      await openOneWebsocket(entry, url, apiKey);
      // Clean close — drop out of reconnect loop.
      if (entry.closed) return;
      entry.reconnectAttempt++;
    } catch (err) {
      console.warn(
        `[recall-realtime ${entry.botId}] WS error attempt ${entry.reconnectAttempt}:`,
        err instanceof Error ? err.message : String(err),
      );
      entry.reconnectAttempt++;
    }
    if (entry.closed) return;
    // Exponential backoff with cap: 1s, 2s, 4s, 8s, 16s, 30s, 30s, …
    const delay = Math.min(30_000, 1_000 * Math.pow(2, entry.reconnectAttempt - 1));
    await new Promise<void>((resolve) => {
      entry.reconnectTimer = setTimeout(() => {
        entry.reconnectTimer = null;
        resolve();
      }, delay);
    });
  }
}

function openOneWebsocket(
  entry: SubscriberEntry,
  url: string,
  apiKey: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = new WsSocket(url, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    entry.ws = ws;
    ws.on("open", () => {
      entry.reconnectAttempt = 0;
      console.log(`[recall-realtime ${entry.botId}] WS open`);
    });
    ws.on("message", (data) => {
      let event: any;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      // Fan out to in-process listeners.
      for (const l of entry.listeners) {
        try {
          l(event);
        } catch {
          /* swallow */
        }
      }
      // Process well-known Recall realtime event shapes.
      void handleRecallRealtimeEvent(entry.botId, event);
    });
    ws.on("close", () => {
      console.log(`[recall-realtime ${entry.botId}] WS closed`);
      if (entry.closed) {
        resolve();
      } else {
        // Surface a controlled "needs reconnect" via reject — the backoff
        // loop catches and waits.
        reject(new Error("ws closed unexpectedly"));
      }
    });
    ws.on("error", (err) => {
      // The close handler will resolve/reject; just log.
      console.warn(`[recall-realtime ${entry.botId}] WS error`, err);
    });
  });
}

/** Drop the WS + clean up listeners. Called from the lifecycle webhook
 *  when the bot terminates. */
export function stopBotRealtime(botId: string): void {
  const entry = subscribers.get(botId);
  if (!entry) return;
  entry.closed = true;
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }
  try {
    entry.ws?.close();
  } catch {
    /* swallow */
  }
  subscribers.delete(botId);
}

// ── inbound event handler ─────────────────────────────────────────────────

interface RecallTranscriptEvent {
  kind: "partial" | "final";
  speaker: string | null;
  text: string;
  meeting_ms: number | null;
}

/** Try to map a Recall realtime event to a transcript fragment. Returns
 *  null on shapes we don't recognise. */
export function extractTranscriptFragment(
  event: unknown,
): RecallTranscriptEvent | null {
  if (typeof event !== "object" || event === null) return null;
  const e = event as Record<string, unknown>;
  // Recall realtime emits events of shape:
  //   { type: "transcript.partial" | "transcript.final",
  //     data: { participant: {name}, text, words: [...], meeting_offset_ms } }
  // We tolerate also a flat shape (type at top-level, text/speaker as
  // siblings) for forward-compat.
  const t = typeof e.type === "string" ? e.type : null;
  if (!t || !/transcript\.(partial|final)/.test(t)) return null;
  const data = (e.data ?? e) as Record<string, unknown>;
  const text = typeof data.text === "string" ? data.text : "";
  if (!text.trim()) return null;
  const p = data.participant as Record<string, unknown> | undefined;
  let speaker: string | null = null;
  if (typeof data.speaker === "string") speaker = data.speaker;
  else if (p && typeof p.name === "string") speaker = p.name;
  const off =
    typeof data.meeting_offset_ms === "number" ? data.meeting_offset_ms : null;
  return {
    kind: t.endsWith("final") ? "final" : "partial",
    text,
    speaker,
    meeting_ms: off,
  };
}

async function handleRecallRealtimeEvent(
  botId: string,
  event: unknown,
): Promise<void> {
  const frag = extractTranscriptFragment(event);
  if (!frag) return;
  const db = getStateDb();
  persistTranscriptEvent(db, botId, frag.kind, frag.text, {
    speaker: frag.speaker,
    meeting_ms: frag.meeting_ms,
  });
  emitStream(botId, {
    kind: frag.kind,
    speaker: frag.speaker,
    text: frag.text,
    ts_ms: Date.now(),
    meeting_ms: frag.meeting_ms,
  });
  if (frag.kind !== "final") return;

  // Only run wake-word detection on FINAL fragments. Partials would
  // produce duplicate hits as the model rewords the trailing token.
  const wakeWord = readWakeWord(db);
  const match = detectWakeWord(frag.text, wakeWord);
  if (!match.hit) return;
  emitStream(botId, {
    kind: "wake_word_hit",
    speaker: frag.speaker,
    text: frag.text,
    ts_ms: Date.now(),
    meeting_ms: frag.meeting_ms,
    score: match.score,
  });
  const row = readBotRow(db, botId);
  if (!row) return;
  if (row.muted === 1) {
    console.log(
      `[recall-realtime ${botId}] wake-word hit but bot is muted; not responding`,
    );
    return;
  }
  db.prepare(
    `UPDATE recall_bot SET wake_word_triggers = wake_word_triggers + 1 WHERE id = ?`,
  ).run(botId);

  await triggerVoiceBridgeTurn(botId, frag.text, wakeWord, row).catch((err) => {
    console.error(
      `[recall-realtime ${botId}] voice-bridge turn failed:`,
      err instanceof Error ? err.message : String(err),
    );
  });
}

/** POST the wake-word transcript + meeting context to voice-bridge.
 *  Voice-bridge replies with PCM16 audio bytes; we relay those to
 *  Recall's output_audio endpoint. */
async function triggerVoiceBridgeTurn(
  botId: string,
  transcript: string,
  wakeWord: string,
  row: BotRowMin,
): Promise<void> {
  const bridgeUrl = `${voiceBridgeUrl()}/voice/recall-turn`;
  const internalToken = process.env.VOICE_BRIDGE_INTERNAL_TOKEN ?? "";
  const meetingContext = row.meeting_context_json
    ? safeParse(row.meeting_context_json)
    : null;
  let bridgeResp: Response;
  try {
    bridgeResp = await fetch(bridgeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${internalToken}`,
      },
      body: JSON.stringify({
        bot_id: botId,
        transcript,
        wake_word: wakeWord,
        meeting_context: meetingContext,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    console.error(
      `[recall-realtime ${botId}] voice-bridge unreachable:`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  if (!bridgeResp.ok) {
    console.warn(
      `[recall-realtime ${botId}] voice-bridge returned HTTP ${bridgeResp.status}`,
    );
    return;
  }
  // Voice-bridge contract: 2xx with `{audio_base64, text?}` JSON. The
  // bridge will have run OpenAI Realtime and synthesised PCM16 already.
  let body: { audio_base64?: string; text?: string };
  try {
    body = (await bridgeResp.json()) as { audio_base64?: string; text?: string };
  } catch {
    console.warn(`[recall-realtime ${botId}] voice-bridge response not JSON`);
    return;
  }
  if (typeof body.audio_base64 !== "string" || body.audio_base64.length === 0) {
    return;
  }
  if (typeof body.text === "string" && body.text.trim()) {
    const db = getStateDb();
    persistTranscriptEvent(db, botId, "response", body.text.trim(), {
      speaker: "Alfred",
    });
    emitStream(botId, {
      kind: "response",
      speaker: "Alfred",
      text: body.text.trim(),
      ts_ms: Date.now(),
      meeting_ms: null,
    });
  }
  await speakIntoMeeting(botId, body.audio_base64).catch((err) => {
    console.error(
      `[recall-realtime ${botId}] output_audio upload failed:`,
      err instanceof Error ? err.message : String(err),
    );
  });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ── output_audio uploader ─────────────────────────────────────────────────
//
// Recall's `/api/v2/bot/:id/output_audio` accepts a base64-encoded audio
// blob + the audio's mime/format hints. The endpoint is documented as
// SUPPORTING chunked playback (i.e. multiple POSTs across a single
// utterance), but for a 1-2 sentence butler response the whole utterance
// fits in one POST under 200 KB at 16 kHz pcm16; we therefore send the
// buffered audio in one shot.
//
// If a future audio buffer exceeds the documented per-POST size cap
// (Recall's docs say ~5 MB), break_into_chunks() splits at frame
// boundaries and posts sequentially with the same kind / sample_rate.
//
// Returns the upstream HTTP status so callers can decide whether to
// retry.

const RECALL_AUDIO_CHUNK_BYTES = 256 * 1024;

/** Split a base64 audio blob into <=N-byte chunks (decoded byte count). */
function chunkBase64(b64: string, chunkBytes: number): string[] {
  const buf = Buffer.from(b64, "base64");
  if (buf.length <= chunkBytes) return [b64];
  const out: string[] = [];
  for (let i = 0; i < buf.length; i += chunkBytes) {
    out.push(buf.subarray(i, i + chunkBytes).toString("base64"));
  }
  return out;
}

export async function speakIntoMeeting(
  botId: string,
  audioBase64: string,
  opts: { kind?: string; sampleRate?: number } = {},
): Promise<number> {
  const apiKey = recallApiKey();
  if (!apiKey) {
    throw new Error("RECALL_API_KEY missing — cannot post output_audio");
  }
  const url = `${recallRegionHost()}/api/v2/bot/${encodeURIComponent(botId)}/output_audio`;
  const chunks = chunkBase64(audioBase64, RECALL_AUDIO_CHUNK_BYTES);
  let lastStatus = 0;
  for (const chunk of chunks) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        kind: opts.kind ?? "audio/pcm",
        sample_rate: opts.sampleRate ?? 16_000,
        b64_data: chunk,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    lastStatus = resp.status;
    if (!resp.ok) {
      const keyPrefix = apiKey.slice(0, 6);
      let detail = "";
      try {
        detail = (await resp.text()).slice(0, 200);
      } catch {
        /* swallow */
      }
      console.warn(
        `[recall-realtime ${botId}] output_audio HTTP ${resp.status} (key ${keyPrefix}…): ${detail}`,
      );
      throw new Error(
        `Recall output_audio returned HTTP ${resp.status}${detail ? ` — ${detail}` : ""}`,
      );
    }
  }
  return lastStatus;
}

// ── manual TTS (`POST /respond`) ───────────────────────────────────────────
//
// Renders text → PCM16 audio via OpenAI's TTS endpoint, then uploads to
// Recall's output_audio. Used by the RecallCard's "Speak now" button and
// reachable as a programmatic CTA from MCP / cron / Sir's Telegram.
//
// Posture: the OpenAI key is read from env (`OPENAI_API_KEY` —
// the same one the gateway/voice-bridge use). Text is capped at 1000
// characters; longer text would exceed Recall's per-POST size cap on
// some accents.

export async function renderTtsToBase64(
  text: string,
  opts: { voice?: string; format?: "wav" | "pcm" } = {},
): Promise<{ audio_base64: string; sample_rate: number; format: string }> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY missing — cannot render TTS");
  }
  const voice = opts.voice ?? process.env.OPENAI_REALTIME_VOICE ?? "alloy";
  const format = opts.format ?? "wav";
  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts",
      input: text.slice(0, 1000),
      voice,
      response_format: format,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.text()).slice(0, 200);
    } catch {
      /* swallow */
    }
    throw new Error(`OpenAI TTS returned HTTP ${resp.status}${detail ? ` — ${detail}` : ""}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return {
    audio_base64: buf.toString("base64"),
    sample_rate: 24_000,
    format,
  };
}

// Re-exported deterministic helpers for unit tests; nothing leaks
// production state.
export const _recallRealtimeInternals = {
  jaroWinkler,
  detectWakeWord,
  extractTranscriptFragment,
  chunkBase64,
  normaliseForMatch,
};

/** SSE writer helper — formats a frame as a `data: ` line + flushes. */
export function writeSseFrame(
  res: { write: (chunk: string) => void },
  frame: TranscriptStreamFrame,
): void {
  const json = JSON.stringify(frame);
  res.write(`event: ${frame.kind}\n`);
  res.write(`data: ${json}\n\n`);
}

/** Voice-bridge HMAC for the inbound recall-turn callback path. ctrl-api
 *  accepts the bridge's POST to /api/v1/voice-bridge/recall-turn when the
 *  HMAC matches VOICE_BRIDGE_INTERNAL_TOKEN over the request body. Exported
 *  so the route handler can call it without re-implementing crypto. */
export function verifyVoiceBridgeSignature(
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  if (!header) return false;
  const secret = process.env.VOICE_BRIDGE_INTERNAL_TOKEN ?? "";
  if (!secret) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(header.replace(/^sha256=/, "")),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}
