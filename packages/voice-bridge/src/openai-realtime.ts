// OpenAI Realtime API client — persistent WS per call.
//
// Reference: https://platform.openai.com/docs/api-reference/realtime
//
// Outbound events to OpenAI:
//   session.update             — set instructions, voice, formats, VAD, tools
//   input_audio_buffer.append  — append base64 audio (we forward Twilio's μ-law as-is)
//   input_audio_buffer.clear   — drop pending input (used on barge-in)
//   response.cancel            — cancel an in-flight response (used on barge-in)
//   response.create            — request a turn (mostly automatic with semantic VAD)
//   conversation.item.create   — Phase 3, used for function_call_output
//
// Inbound events we care about:
//   session.created / session.updated  — connection acks
//   response.audio.delta               — base64 audio chunk (forward to Twilio)
//   response.audio.done                — audio finished (request a Twilio mark)
//   response.done                      — full response complete
//   response.function_call_arguments.done — Phase 3 tool call dispatch
//   error                              — log + continue

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
      const ws = new WsSocket(url, {
        headers: {
          Authorization: `Bearer ${config.openaiApiKey}`,
          "OpenAI-Beta": "realtime=v1",
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
          // Configure the session now that it's alive.
          this.send({
            type: "session.update",
            session: {
              instructions: sessionConfig.instructions,
              voice: sessionConfig.voice ?? config.openaiVoice,
              input_audio_format: "g711_ulaw",
              output_audio_format: "g711_ulaw",
              turn_detection: {
                type: "semantic_vad",
                eagerness: "medium",
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
