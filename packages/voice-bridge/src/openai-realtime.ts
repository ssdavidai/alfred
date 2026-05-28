// OpenAI Realtime API client — persistent WS per call.
//
// Reference: https://platform.openai.com/docs/api-reference/realtime (GA schema,
// used by `gpt-realtime` / `gpt-realtime-1.5` / `gpt-realtime-2`). This is NOT the older preview
// API — the session shape is nested under `audio.input` / `audio.output`, and
// output events are renamed `response.output_audio.*`. Sending the preview
// shape causes the server to silently ignore codec config and cancel responses
// with `status: "cancelled"`, `reason: "client_cancelled"` — see
// openai-realtime-ga migration notes in deploy/AGENTPHONE_ROLLOUT.md.
//
// Outbound events to OpenAI:
//   session.update             — set instructions, audio codecs, VAD, tools
//   input_audio_buffer.append  — append base64 audio (we forward Twilio's μ-law verbatim)
//   input_audio_buffer.clear   — drop pending input (rarely needed; VAD handles barge-in)
//   response.cancel            — cancel an in-flight response (manual barge-in only)
//   response.create            — request a turn (mostly automatic with semantic VAD)
//   conversation.item.create   — used for function_call_output
//
// Inbound events we care about:
//   session.created / session.updated           — connection acks (diag: compare
//                                                 session.updated echo vs what we sent)
//   response.output_audio.delta                 — base64 audio chunk → forward to Twilio
//   response.output_audio_transcript.delta      — assistant TTS transcript
//   response.output_audio.done                  — audio finished (cue a Twilio mark)
//   response.done                               — full response complete
//   response.function_call_arguments.done       — tool-call dispatch point
//   input_audio_buffer.speech_started           — user started talking (server
//                                                 auto-cancels assistant per VAD config)
//   conversation.item.input_audio_transcription.completed — user-utterance transcript
//   error                                       — log + continue
//
// Connection handshake (race-safe — fixed 2026-05-28):
//
//   1. ws.open
//   2. server → session.created          (default config in effect)
//   3. client → session.update           (persona + VAD + tools)
//   4. server → session.updated          (config now applied)  ← connect() resolves HERE
//
// The previous implementation resolved on step 2, which meant the model could
// receive `response.create` (greeting trigger) or `input_audio_buffer.append`
// (Twilio media) before step 4 applied. Symptoms were:
//   * agent freelancing on the default persona instead of the RP butler
//   * default turn-detection (no semantic VAD interrupt) → not interruptible
//   * voice defaulted to generic American
// The race window is small (~100–500ms on OpenAI's side) but Twilio media
// streams start the moment Twilio gets a "start" event, so it hit every call.

import { WebSocket as WsSocket } from "ws";
import { config } from "./config.js";

// Timeout for the session.update ACK. If `session.updated` doesn't land within
// this window after we send `session.update`, we error the call hard rather
// than silently running on default OpenAI Realtime config.
//
// Production default is 5s. Tests override via VOICE_BRIDGE_ACK_TIMEOUT_MS_FOR_TEST
// so they don't have to sit on the prod timeout for every negative case. The
// override is read at call-time, not at module-load time, because Node's test
// runner sets env per-test.
function ackTimeoutMs(): number {
  const override = process.env.VOICE_BRIDGE_ACK_TIMEOUT_MS_FOR_TEST;
  if (override) {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 5_000;
}

const DEBUG = process.env.VOICE_BRIDGE_DEBUG === "1";

export interface RealtimeSessionConfig {
  instructions: string;
  voice?: string;
  // Tools wire up in Phase 3.
  tools?: Array<Record<string, unknown>>;
}

export type RealtimeListener = (event: any) => void;

export class OpenAIRealtimeClient {
  private ws: WsSocket | null = null;
  private listeners = new Set<RealtimeListener>();
  private closed = false;
  private callId: string;
  // True once OpenAI has echoed back `session.updated` confirming our persona
  // + VAD + tools are applied. Until this flips, we MUST NOT send audio or
  // request responses, otherwise the model runs on default config (generic
  // assistant, server_vad / no interrupt, default voice).
  private sessionReady = false;

  constructor(callId: string) {
    this.callId = callId;
  }

  get isOpen(): boolean {
    return !this.closed && this.ws?.readyState === this.ws?.OPEN;
  }

  /** True once the model is configured with our persona/VAD/tools. */
  get isReady(): boolean {
    return this.isOpen && this.sessionReady;
  }

  on(listener: RealtimeListener): void {
    this.listeners.add(listener);
  }

  // Open the WS, send session.update, and wait for the server's `session.updated`
  // echo before resolving. Hard 5s timeout — we'd rather hang up than serve a
  // call on the default OpenAI persona.
  async connect(sessionConfig: RealtimeSessionConfig): Promise<void> {
    // Read the base URL fresh at connect-time so tests can swap it between
    // cases without having to reload the SUT module each time.
    const baseUrl =
      process.env.OPENAI_REALTIME_BASE_URL ?? config.openaiRealtimeBaseUrl;
    const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}model=${encodeURIComponent(config.openaiModel)}`;
    return new Promise((resolve, reject) => {
      // GA endpoint does NOT want the `OpenAI-Beta: realtime=v1` header — it
      // silently flips the session into a compat mode that rejects GA-shape
      // session.update payloads.
      const ws = new WsSocket(url, {
        headers: {
          Authorization: `Bearer ${config.openaiApiKey}`,
        },
      });
      this.ws = ws;

      let settled = false;
      let ackTimer: NodeJS.Timeout | null = null;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (ackTimer) {
          clearTimeout(ackTimer);
          ackTimer = null;
        }
        if (err) reject(err);
        else resolve();
      };

      ws.on("open", () => {
        // Session config arrives *after* server emits session.created. Defer the
        // session.update until then so we don't race the model boot.
      });

      ws.on("message", (data) => {
        let event: any;
        try {
          event = JSON.parse(data.toString());
        } catch (err) {
          console.error(`[realtime ${this.callId}] non-JSON message`, err);
          return;
        }

        if (event.type === "session.created") {
          // Configure the session now that it's alive — GA schema:
          //   session.type: "realtime"  (required discriminator)
          //   output_modalities: ["audio"]  (replaces preview `modalities`)
          //   audio.{input,output}.format.type = "audio/pcmu"  (replaces
          //     flat input_audio_format / output_audio_format)
          //   audio.input.{turn_detection,transcription,noise_reduction}
          //   audio.output.voice  (replaces top-level `voice`)
          this.send({
            type: "session.update",
            session: {
              type: "realtime",
              output_modalities: ["audio"],
              instructions: sessionConfig.instructions,
              audio: {
                input: {
                  format: { type: "audio/pcmu" },
                  turn_detection: {
                    type: "semantic_vad",
                    eagerness: "medium",
                    // With `interrupt_response: true` the server auto-cancels the
                    // in-flight response when the user starts talking — the
                    // bridge does NOT need to send `response.cancel` itself.
                    create_response: true,
                    interrupt_response: true,
                  },
                  // Capture user speech as text so the bridge can build a transcript
                  // for vault write-back at hangup.
                  transcription: { model: "gpt-4o-mini-transcribe" },
                },
                output: {
                  format: { type: "audio/pcmu" },
                  voice: sessionConfig.voice ?? config.openaiVoice,
                },
              },
              ...(sessionConfig.tools
                ? { tools: sessionConfig.tools, tool_choice: "auto" }
                : {}),
            },
          });
          // Arm the ACK timeout — if `session.updated` doesn't arrive within
          // this window we hang up rather than run on defaults.
          const tmo = ackTimeoutMs();
          ackTimer = setTimeout(() => {
            settle(
              new Error(
                `session.update ACK timeout after ${tmo}ms — refusing to serve call on default config`,
              ),
            );
          }, tmo);
        }

        if (event.type === "session.updated" && !this.sessionReady) {
          this.sessionReady = true;
          if (DEBUG) {
            // One-line debug breadcrumb so future regressions can be diagnosed
            // without a hot-patch. Set VOICE_BRIDGE_DEBUG=1 to enable.
            const td = event.session?.audio?.input?.turn_detection;
            const voice = event.session?.audio?.output?.voice;
            const instrLen =
              typeof event.session?.instructions === "string"
                ? event.session.instructions.length
                : -1;
            console.log(
              `[realtime ${this.callId}] session.updated turn_detection=${td?.type} voice=${voice} instrLen=${instrLen}`,
            );
          }
          settle();
        }

        for (const l of this.listeners) {
          try {
            l(event);
          } catch (err) {
            console.error(`[realtime ${this.callId}] listener error`, err);
          }
        }

        if (event.type === "error") {
          console.error(`[realtime ${this.callId}] error event:`, event.error);
        }
      });

      ws.on("close", (code, reason) => {
        if (!this.closed) {
          console.log(
            `[realtime ${this.callId}] WS closed code=${code} reason=${reason.toString()}`,
          );
        }
        // If the WS closes before we got `session.updated`, surface that as a
        // connect failure so the caller disposes the call cleanly.
        if (!settled) {
          settle(
            new Error(
              `WS closed before session.updated (code=${code} reason=${reason.toString()})`,
            ),
          );
        }
      });

      ws.on("error", (err) => {
        console.error(`[realtime ${this.callId}] WS error`, err);
        if (this.ws?.readyState === this.ws?.CONNECTING) {
          settle(err as Error);
        }
      });
    });
  }

  send(event: object): void {
    if (!this.isOpen || !this.ws) return;
    this.ws.send(JSON.stringify(event));
  }

  // Append a base64 μ-law chunk to the model's input buffer. Twilio's payload
  // passes through unchanged — both sides speak g711_ulaw natively.
  //
  // Hard guard: if the session is not yet ready (session.updated unseen) we
  // drop the chunk on the floor. Happy-path callers wait for `connect()` to
  // resolve before sending audio, so this is defence-in-depth against a race
  // regression and against early Twilio media frames slipping past
  // VoiceCall.initialise() (which won't happen today — `this.realtime` is
  // null until connect resolves — but we belt-and-braces it).
  appendAudio(payloadBase64: string): void {
    if (!this.sessionReady) return;
    this.send({ type: "input_audio_buffer.append", audio: payloadBase64 });
  }

  // Barge-in: drop pending input + cancel in-flight response.
  cancelResponse(): void {
    this.send({ type: "input_audio_buffer.clear" });
    this.send({ type: "response.cancel" });
  }

  // Greet immediately on call connect — semantic VAD waits for user speech
  // otherwise, which would mean dead air after pickup. We only trigger the
  // greeting AFTER `session.updated` has applied; until then `response.create`
  // would run on the default persona (generic American assistant, no RP).
  triggerGreeting(): void {
    if (!this.sessionReady) {
      console.warn(
        `[realtime ${this.callId}] triggerGreeting() called before session.updated — refusing`,
      );
      return;
    }
    this.send({ type: "response.create" });
  }

  // Submit a function-call result back to the model + ask it to continue.
  // Sequence per OpenAI Realtime docs:
  //   1. conversation.item.create  (function_call_output)
  //   2. response.create           (resume the turn)
  submitToolResult(callId: string, output: string): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output,
      },
    });
    this.send({ type: "response.create" });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}
