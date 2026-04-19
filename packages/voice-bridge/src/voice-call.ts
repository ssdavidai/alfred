// VoiceCall — one bridge session for one phone call.
//
// Lifecycle:
//   1. ctor: stash WS + tenantId + signed-query metadata
//   2. start(): fetch tenant, open Realtime WS, await Twilio `start` event
//   3. bidirectional bridge until either side closes
//   4. on Twilio `stop` or hard cap: dispose

import type { WebSocket as WsSocket } from "ws";
import {
  parseTwilioMessage,
  sendTwilioClear,
  sendTwilioMark,
  sendTwilioMedia,
} from "./twilio-stream.js";
import { OpenAIRealtimeClient } from "./openai-realtime.js";
import {
  fetchTenantContext,
  fetchVoiceContext,
  postCallTranscript,
  type TenantContext,
  type TranscriptTurn,
  type VoiceContextBundle,
} from "./tenant.js";
import { buildInstructions } from "./instructions.js";
import { config } from "./config.js";
import {
  ALL_TOOLS,
  dispatchComposioExecute,
  dispatchSelf,
  serializeToolResult,
} from "./tools.js";

export interface VoiceCallOpts {
  tenantId: string;
  initiator: "user" | "alfred";
  intent?: string; // present when initiator === "alfred"
}

export class VoiceCall {
  private twilioWs: WsSocket;
  private opts: VoiceCallOpts;
  private callId: string;
  private streamSid: string | null = null;
  private callerNumber: string | null = null;
  private tenantCtx: TenantContext | null = null;
  private voiceCtx: VoiceContextBundle | null = null;
  private realtime: OpenAIRealtimeClient | null = null;
  private hardCapTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private speaking = false;
  private disposed = false;
  private startedAt: string;
  private transcript: TranscriptTurn[] = [];
  private currentAssistantText = "";

  constructor(twilioWs: WsSocket, opts: VoiceCallOpts) {
    this.twilioWs = twilioWs;
    this.opts = opts;
    this.callId = `${opts.tenantId.slice(0, 8)}-${Date.now()}`;
    this.startedAt = new Date().toISOString();
  }

  async start(): Promise<void> {
    // Wire up Twilio first so we can react to `start` (which has streamSid).
    this.twilioWs.on("message", (data: Buffer) => this.onTwilioMessage(data));
    this.twilioWs.on("close", () => this.dispose("twilio-closed"));
    this.twilioWs.on("error", (err) => {
      console.error(`[call ${this.callId}] twilio WS error`, err);
      this.dispose("twilio-error");
    });

    // Look up tenant. Failure = bail out; we cannot bridge a call we can't tag.
    try {
      this.tenantCtx = await fetchTenantContext(this.opts.tenantId);
    } catch (err) {
      console.error(
        `[call ${this.callId}] tenant lookup failed for ${this.opts.tenantId}`,
        err,
      );
      this.dispose("tenant-lookup-failed");
      return;
    }

    // Best-effort cross-channel context fetch (≤3.5s timeout). Missing context
    // is recoverable — the bridge falls back to baseline persona.
    this.voiceCtx = await fetchVoiceContext(this.tenantCtx);

    // Open OpenAI Realtime and wire its events.
    this.realtime = new OpenAIRealtimeClient(this.callId);
    this.realtime.on((event) => this.onRealtimeEvent(event));
    try {
      await this.realtime.connect({
        instructions: buildInstructions({
          tenantPhoneNumber: this.tenantCtx.phoneNumber,
          initiator: this.opts.initiator,
          intent: this.opts.intent,
          voiceContext: this.voiceCtx,
        }),
        tools: ALL_TOOLS,
      });
    } catch (err) {
      console.error(`[call ${this.callId}] OpenAI Realtime connect failed`, err);
      this.dispose("openai-connect-failed");
      return;
    }

    // Hard cap to prevent runaway-cost calls.
    this.hardCapTimer = setTimeout(() => {
      console.log(
        `[call ${this.callId}] hard cap (${config.maxCallSeconds}s) reached`,
      );
      this.dispose("hard-cap");
    }, config.maxCallSeconds * 1_000);

    this.resetIdleTimer();

    console.log(
      `[call ${this.callId}] bridge started for tenant ${this.opts.tenantId} (${this.opts.initiator})`,
    );
  }

  private onTwilioMessage(data: Buffer): void {
    if (this.disposed) return;
    const event = parseTwilioMessage(data);
    if (!event) return;

    switch (event.event) {
      case "connected":
        // No-op; Twilio acks the WS.
        break;
      case "start":
        this.streamSid = event.streamSid;
        // Twilio includes the caller's E.164 number in start.start.customParameters
        // when set on the TwiML <Stream> — but we didn't set it. Fall back to the
        // top-level `from` field via Twilio's start payload (callSid is the SID).
        // For Phase 4 we just record the streamSid; the actual From comes from the
        // earlier voice webhook (we'll read it from the call leg in Phase 9 if
        // needed, or pass it in the TwiML <Parameter> when we tighten this up).
        // Trigger Alfred to speak first so we don't have dead air after pickup.
        // Semantic VAD would otherwise wait for user audio.
        this.realtime?.triggerGreeting();
        break;
      case "media":
        this.resetIdleTimer();
        // Barge-in: if we're mid-response and the user starts talking, cancel.
        // OpenAI's semantic VAD will drive the next turn.
        if (this.speaking) {
          this.handleBargeIn();
        }
        // Forward μ-law bytes verbatim.
        this.realtime?.appendAudio(event.media.payload);
        break;
      case "mark":
        // Twilio acked one of our marks. Could use this for finer playback
        // tracking; not needed in Phase 2.
        break;
      case "stop":
        this.dispose("twilio-stop");
        break;
    }
  }

  private onRealtimeEvent(event: any): void {
    if (this.disposed || !this.streamSid) return;

    switch (event.type) {
      case "response.created":
        this.speaking = true;
        this.currentAssistantText = "";
        break;
      case "response.audio.delta":
        if (event.delta) {
          sendTwilioMedia(this.twilioWs, this.streamSid, event.delta);
        }
        break;
      case "response.audio_transcript.delta":
        // Assistant's TTS transcript streamed as we speak — accumulate.
        if (typeof event.delta === "string") {
          this.currentAssistantText += event.delta;
        }
        break;
      case "response.audio.done":
        // Mark playback so we know when Twilio finishes the buffer.
        sendTwilioMark(this.twilioWs, this.streamSid, `seg-${Date.now()}`);
        break;
      case "response.done":
        this.speaking = false;
        if (this.currentAssistantText.trim()) {
          this.transcript.push({
            role: "assistant",
            text: this.currentAssistantText.trim(),
            ts: new Date().toISOString(),
          });
        }
        this.currentAssistantText = "";
        break;
      case "conversation.item.input_audio_transcription.completed":
        // User speech finished + transcribed.
        if (typeof event.transcript === "string" && event.transcript.trim()) {
          this.transcript.push({
            role: "user",
            text: event.transcript.trim(),
            ts: new Date().toISOString(),
          });
        }
        break;
      case "response.function_call_arguments.done":
        // Tool dispatch. The model has finished emitting JSON-encoded args
        // for a function call; parse, run, return the result, ask for the
        // next response cycle.
        this.handleToolCall(event).catch((err) => {
          console.error(`[call ${this.callId}] tool dispatch error`, err);
        });
        break;
      case "error":
        // logged inside the client; nothing extra here
        break;
    }
  }

  private async handleToolCall(event: any): Promise<void> {
    if (!this.tenantCtx || !this.realtime) return;
    const { name, call_id: callId, arguments: argsRaw } = event;
    let args: Record<string, unknown> = {};
    try {
      args = argsRaw ? JSON.parse(argsRaw) : {};
    } catch (err) {
      const errStr = (err as Error)?.message ?? String(err);
      this.realtime.submitToolResult(
        callId,
        serializeToolResult({
          ok: false,
          error: `Failed to parse tool arguments: ${errStr}`,
        }),
      );
      return;
    }

    let result;
    if (name === "self") {
      result = await dispatchSelf(this.tenantCtx, args);
    } else if (name === "composio_execute") {
      result = await dispatchComposioExecute(this.tenantCtx, args);
    } else {
      result = { ok: false, error: `Unknown tool: ${name}` };
    }
    this.realtime.submitToolResult(callId, serializeToolResult(result));
  }

  private handleBargeIn(): void {
    if (!this.streamSid) return;
    // Drop any audio Twilio is still buffering for playback,
    // and tell OpenAI to stop generating + clear its input scratch.
    sendTwilioClear(this.twilioWs, this.streamSid);
    this.realtime?.cancelResponse();
    this.speaking = false;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      console.log(`[call ${this.callId}] idle hangup`);
      this.dispose("idle");
    }, config.idleHangupSeconds * 1_000);
  }

  dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.hardCapTimer) clearTimeout(this.hardCapTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);

    // Fire-and-forget transcript write-back BEFORE closing the OpenAI WS,
    // so we still have the captured text in scope.
    this.flushTranscript(reason);

    try {
      this.realtime?.close();
    } catch {
      /* ignore */
    }
    try {
      if (this.twilioWs.readyState === this.twilioWs.OPEN) {
        this.twilioWs.close();
      }
    } catch {
      /* ignore */
    }
    console.log(`[call ${this.callId}] disposed (${reason})`);
  }

  private flushTranscript(reason: string): void {
    if (!this.tenantCtx) return;
    if (this.transcript.length === 0) return;
    const summary = this.buildSummary(reason);
    void postCallTranscript(this.tenantCtx, {
      callId: this.callId,
      from: this.callerNumber ?? "",
      to: this.tenantCtx.phoneNumber ?? "",
      direction: this.opts.initiator === "alfred" ? "outbound" : "inbound",
      started_at: this.startedAt,
      ended_at: new Date().toISOString(),
      transcript: this.transcript,
      summary,
    });
  }

  private buildSummary(reason: string): string {
    const userTurns = this.transcript.filter((t) => t.role === "user").length;
    const assistantTurns = this.transcript.filter(
      (t) => t.role === "assistant",
    ).length;
    const lastUser = [...this.transcript]
      .reverse()
      .find((t) => t.role === "user");
    const head = lastUser?.text?.slice(0, 100);
    const base = `Phone call, ${userTurns} user turn(s) / ${assistantTurns} reply turn(s)`;
    return head ? `${base}. Last user: ${head}` : `${base} (${reason})`;
  }
}
