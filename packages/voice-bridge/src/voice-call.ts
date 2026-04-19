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
  type TwilioEvent,
} from "./twilio-stream.js";
import { OpenAIRealtimeClient } from "./openai-realtime.js";
import { fetchTenantContext, type TenantContext } from "./tenant.js";
import { buildInstructions } from "./instructions.js";
import { config } from "./config.js";

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
  private tenantCtx: TenantContext | null = null;
  private realtime: OpenAIRealtimeClient | null = null;
  private hardCapTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private speaking = false;
  private disposed = false;

  constructor(twilioWs: WsSocket, opts: VoiceCallOpts) {
    this.twilioWs = twilioWs;
    this.opts = opts;
    this.callId = `${opts.tenantId.slice(0, 8)}-${Date.now()}`;
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

    // Open OpenAI Realtime and wire its events.
    this.realtime = new OpenAIRealtimeClient(this.callId);
    this.realtime.on((event) => this.onRealtimeEvent(event));
    try {
      await this.realtime.connect({
        instructions: buildInstructions({
          tenantPhoneNumber: this.tenantCtx.phoneNumber,
          initiator: this.opts.initiator,
          intent: this.opts.intent,
        }),
        // tools left undefined for Phase 2; Phase 3 wires self + composio_execute
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
        break;
      case "response.audio.delta":
        if (event.delta) {
          sendTwilioMedia(this.twilioWs, this.streamSid, event.delta);
        }
        break;
      case "response.audio.done":
        // Mark playback so we know when Twilio finishes the buffer.
        sendTwilioMark(this.twilioWs, this.streamSid, `seg-${Date.now()}`);
        break;
      case "response.done":
        this.speaking = false;
        break;
      case "error":
        // logged inside the client; nothing extra here
        break;
      // response.function_call_arguments.done lands in Phase 3 (tool dispatch)
    }
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
}
