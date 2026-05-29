// recall-session — one Recall.ai wake-word turn → OpenAI Realtime → PCM16 (#113 PR5).
//
// Unlike the ESPHome path (WS in, WS out, long-lived) and the Twilio path
// (Media Streams, long-lived), Recall in-meeting voice is a sequence of
// SHORT atomic turns:
//
//   ctrl-api hears the wake word on Recall's transcript stream.
//   ctrl-api POSTs `/voice/recall-turn` to this bridge with:
//     { bot_id, transcript, wake_word, meeting_context }
//   This file runs ONE OpenAI Realtime turn:
//     1. open ws to OpenAI
//     2. session.update with the RP butler persona + meeting prefix
//     3. push the transcript as a synthetic conversation.item.create
//     4. response.create
//     5. accumulate the response.output_audio.delta stream
//     6. close ws
//   We return `{audio_base64, text}` to ctrl-api; ctrl-api uploads the
//   audio to Recall's output_audio endpoint, which plays it INTO the
//   meeting.
//
// Why a fresh Realtime session per turn (not a long-lived one):
//   * Recall's transcript stream IS the conversation surface — we don't
//     need OpenAI Realtime's own VAD/turn-detection.
//   * Meeting bots run for an hour+; holding an OpenAI Realtime WS open
//     that long is wasteful and incurs reconnects on transient blips.
//   * Each turn carries its own meeting_context, so context isn't lost
//     between turns even though state isn't kept on the bridge side.
//
// Latency budget: the SUT keeps a tight loop — connect → session.update
// → conversation.item.create → response.create → audio accumulation →
// close. p95 ≤ 1500ms with the OpenAI Realtime endpoint at <250ms TTFB.

import { WebSocket as WsSocket } from "ws";
import { config } from "./config.js";
import {
  buildMeetingPrefix,
  type MeetingContextSnapshot,
} from "./recall-meeting-context.js";

export interface RecallTurnInput {
  botId: string;
  transcript: string;
  wakeWord: string;
  meetingContext: MeetingContextSnapshot | null;
  // Override the OpenAI Realtime URL — tests point at a mock server.
  realtimeBaseUrl?: string;
  // Override the OpenAI API key — tests use a dummy.
  openaiApiKey?: string;
  // Override the per-turn timeout (default 8s).
  timeoutMs?: number;
}

export interface RecallTurnResult {
  ok: boolean;
  audio_base64: string;
  text: string;
  latency_ms: number;
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/** Run one Recall.ai wake-word turn through OpenAI Realtime and return
 *  the rendered audio + transcript. Stateless: opens a fresh session,
 *  closes it on response.done, never holds state between turns. */
export async function runRecallTurn(
  input: RecallTurnInput,
): Promise<RecallTurnResult> {
  const t0 = Date.now();
  // Resolve URL + key fresh on every turn — tests swap env per case.
  const baseUrl =
    input.realtimeBaseUrl ??
    process.env.OPENAI_REALTIME_BASE_URL ??
    config.openaiRealtimeBaseUrl;
  const apiKey = input.openaiApiKey ?? config.openaiApiKey;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}model=${encodeURIComponent(
    config.openaiModel,
  )}`;
  const instructions = buildRecallInstructions(input);

  return new Promise<RecallTurnResult>((resolve) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    const audioChunks: string[] = [];
    let transcriptText = "";
    let sessionReady = false;
    let requestSent = false;
    let ws: WsSocket | null = null;

    const settle = (result: RecallTurnResult) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      try {
        ws?.close();
      } catch {
        /* swallow */
      }
      resolve({ ...result, latency_ms: Date.now() - t0 });
    };

    timeoutHandle = setTimeout(() => {
      settle({
        ok: false,
        audio_base64: audioChunks.join(""),
        text: transcriptText,
        latency_ms: 0,
        reason: `turn timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    try {
      ws = new WsSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      settle({
        ok: false,
        audio_base64: "",
        text: "",
        latency_ms: 0,
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    ws.on("message", (data) => {
      if (settled) return;
      let event: any;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (event.type === "session.created") {
        ws!.send(
          JSON.stringify({
            type: "session.update",
            session: {
              type: "realtime",
              output_modalities: ["audio"],
              instructions,
              audio: {
                input: {
                  // We don't stream audio in this path — the input is the
                  // transcript text. Keep `format` set so the GA schema
                  // accepts the message; turn_detection isn't needed
                  // because we drive turns manually.
                  format: { type: "audio/pcm", rate: 24_000 },
                  turn_detection: null,
                },
                output: {
                  format: { type: "audio/pcm", rate: 16_000 },
                  voice: config.openaiVoice,
                },
              },
            },
          }),
        );
        return;
      }
      if (event.type === "session.updated") {
        sessionReady = true;
        if (!requestSent) {
          // Push the transcript as user input + ask for one response.
          ws!.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: input.transcript,
                  },
                ],
              },
            }),
          );
          ws!.send(JSON.stringify({ type: "response.create" }));
          requestSent = true;
        }
        return;
      }
      if (
        event.type === "response.output_audio.delta" &&
        typeof event.delta === "string"
      ) {
        audioChunks.push(event.delta);
        return;
      }
      if (
        event.type === "response.output_audio_transcript.delta" &&
        typeof event.delta === "string"
      ) {
        transcriptText += event.delta;
        return;
      }
      if (event.type === "response.done") {
        settle({
          ok: true,
          audio_base64: concatBase64(audioChunks),
          text: transcriptText.trim(),
          latency_ms: 0,
        });
        return;
      }
      if (event.type === "error") {
        settle({
          ok: false,
          audio_base64: concatBase64(audioChunks),
          text: transcriptText,
          latency_ms: 0,
          reason:
            typeof event.error === "object" && event.error !== null
              ? String((event.error as any).message ?? "openai error")
              : "openai error",
        });
        return;
      }
    });

    ws.on("error", (err) => {
      settle({
        ok: false,
        audio_base64: "",
        text: "",
        latency_ms: 0,
        reason: err instanceof Error ? err.message : String(err),
      });
    });

    ws.on("close", () => {
      // If we close before response.done, surface what we have.
      if (!settled) {
        settle({
          ok: requestSent && audioChunks.length > 0,
          audio_base64: concatBase64(audioChunks),
          text: transcriptText.trim(),
          latency_ms: 0,
          reason: sessionReady
            ? "ws closed before response.done"
            : "ws closed before session.updated",
        });
      }
    });
  });
}

/** Build the Realtime instructions string from the meeting prefix + a
 *  scoped butler persona. We intentionally don't pull the full call
 *  persona from instructions.ts — the meeting surface is short, dense,
 *  and shouldn't include the SMS/contact callouts that live in the
 *  phone path. */
export function buildRecallInstructions(input: RecallTurnInput): string {
  const prefix = buildMeetingPrefix(input.meetingContext, input.wakeWord);
  const persona = [
    "Speak in Received Pronunciation. No American drift. Crisp consonants, no rhoticity.",
    "Hold the accent through the entire response.",
    "Reply in ONE or TWO short sentences. No markdown, no lists, no spelled-out URLs.",
    "Speak numbers in full (\"twelve thousand euros\", not \"12,000\").",
    "If you don't have enough context to answer, say so politely in one sentence.",
    "Never speculate, never invent figures, never reference fictitious facts.",
  ].join("\n");
  return [prefix, persona].join("\n");
}

function concatBase64(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  // Concatenating multiple base64 strings only round-trips if each
  // individual chunk's byte length was a multiple of 3. The OpenAI
  // Realtime audio deltas align on PCM16 sample boundaries (2-byte
  // multiples), not necessarily 3-byte. Safe approach: decode each
  // chunk + re-encode the concat.
  const buffers = parts.map((p) => Buffer.from(p, "base64"));
  return Buffer.concat(buffers).toString("base64");
}
