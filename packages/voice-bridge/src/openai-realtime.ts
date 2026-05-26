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

import { WebSocket as WsSocket } from "ws";
import { config } from "./config.js";

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

  constructor(callId: string) {
    this.callId = callId;
  }

  get isOpen(): boolean {
    return !this.closed && this.ws?.readyState === this.ws?.OPEN;
  }

  on(listener: RealtimeListener): void {
    this.listeners.add(listener);
  }

  // Open the WS and wait for session.created. Resolves once configured.
  async connect(sessionConfig: RealtimeSessionConfig): Promise<void> {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.openaiModel)}`;
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
          resolve();
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
      });

      ws.on("error", (err) => {
        console.error(`[realtime ${this.callId}] WS error`, err);
        if (this.ws?.readyState === this.ws?.CONNECTING) {
          reject(err);
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
  appendAudio(payloadBase64: string): void {
    this.send({ type: "input_audio_buffer.append", audio: payloadBase64 });
  }

  // Barge-in: drop pending input + cancel in-flight response.
  cancelResponse(): void {
    this.send({ type: "input_audio_buffer.clear" });
    this.send({ type: "response.cancel" });
  }

  // Greet immediately on call connect — semantic VAD waits for user speech
  // otherwise, which would mean dead air after pickup.
  triggerGreeting(): void {
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
