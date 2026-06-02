// VoiceCall — one bridge session for one phone call.
//
// Lifecycle:
//   1. ctor: stash WS + tenantId
//   2. start(): wire Twilio WS listeners; return immediately.
//   3. onTwilioMessage 'start': verify sig from customParameters; if valid,
//      fetch tenant context + open OpenAI Realtime. If invalid, dispose
//      immediately — no tenant lookup, no OpenAI minutes burned.
//   4. bidirectional bridge until either side closes.
//   5. on Twilio `stop` or hard cap: dispose.
//
// Sig lives in customParameters (not query string) because Twilio <Stream>
// silently strips `?k=v` from stream URLs — see ../../saas/app/src/server/
// twilio/webhooks.ts and ./server.ts for the matching emission + verify.

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
import { verifySig, bumpMetric } from "./server.js";
import {
  ALL_TOOLS,
  dispatchComposioExecute,
  dispatchSelf,
  serializeToolResult,
} from "./tools.js";
import {
  dispatchMcp,
  getVoiceMcpToolDefs,
  isMcpToolName,
} from "./mcp-clients.js";
import {
  FILES_TOOLS,
  dispatchFilesTool,
  isFilesToolName,
} from "./files-tools.js";

const VOICE_DEBUG = process.env.VOICE_BRIDGE_DEBUG === "1";

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
  private _startDeadline: NodeJS.Timeout | null = null;
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
    // Wire up Twilio listeners and return. We intentionally do NOT fetch the
    // tenant or open OpenAI Realtime yet — sig verification happens on the
    // first `start` Twilio event (which carries customParameters.sig), and
    // we don't want to burn tenant-lookup or OpenAI connect cost on a call
    // that fails the sig check.
    this.twilioWs.on("message", (data: Buffer) => this.onTwilioMessage(data));
    this.twilioWs.on("close", () => this.dispose("twilio-closed"));
    this.twilioWs.on("error", (err) => {
      console.error(`[call ${this.callId}] twilio WS error`, err);
      this.dispose("twilio-error");
    });

    // Safety net: if Twilio never sends `start`, dispose after 10s so we don't
    // hold an idle WS indefinitely.
    const startDeadline = setTimeout(() => {
      if (!this.streamSid && !this.disposed) {
        console.log(
          `[call ${this.callId}] never received Twilio start event; disposing`,
        );
        this.dispose("no-twilio-start");
      }
    }, 10_000);
    // Clear the deadline once we're running.
    this._startDeadline = startDeadline;
  }

  // Runs after sig verification on the Twilio `start` event.
  private async initialise(): Promise<void> {
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
    // #120 Lane Vb — thread the per-profile OPENAI_API_KEY (if any) into
    // the client so the Realtime session bills against the resolved
    // profile's OpenAI account, not the boot-time instance default.
    this.realtime = new OpenAIRealtimeClient(this.callId, {
      apiKeyOverride: this.tenantCtx.openaiApiKey ?? null,
    });
    this.realtime.on((event) => this.onRealtimeEvent(event));
    const voiceMcpTools = getVoiceMcpToolDefs();
    const totalTools = ALL_TOOLS.length + FILES_TOOLS.length + voiceMcpTools.length;
    if (VOICE_DEBUG) {
      console.log(
        `[call ${this.callId}] curated tool catalog: ${totalTools} tools ` +
          `(${ALL_TOOLS.length} static + ${FILES_TOOLS.length} files + ` +
          `${voiceMcpTools.length} MCP; ` +
          `ceiling is 16384 tokens for instructions+tools per OpenAI Realtime)`,
      );
    }
    try {
      await this.realtime.connect({
        instructions: buildInstructions({
          tenantPhoneNumber: this.tenantCtx.phoneNumber,
          callerNumber: this.callerNumber,
          initiator: this.opts.initiator,
          intent: this.opts.intent,
          voiceContext: this.voiceCtx,
        }),
        // ALL_TOOLS = static [self, composio_execute]. MCP tools are merged in
        // dynamically — server.ts already called connectAllMcp() at boot, so
        // by the time a call lands the catalog is populated. Empty list is
        // a soft failure (every MCP server was unreachable at boot); voice
        // still works on self + composio.
        //
        // We deliberately ship a CURATED voice subset (getVoiceMcpToolDefs)
        // rather than the full 157-tool union — see mcp-clients.ts allowlist
        // header for the 16,384-token Realtime ceiling rationale.
        //
        // FILES_TOOLS are the read-only files surface (#114 PR4) — four
        // tools (list / stat / read_text / search) that wrap the principal-
        // facing /files store. Writes (delete / create / describe) and
        // base64 reads are intentionally absent — voice doesn't write to
        // the files store, and a 5 MB binary blob isn't useful in a
        // Realtime turn. See files-tools.ts for the rationale.
        tools: [...ALL_TOOLS, ...FILES_TOOLS, ...voiceMcpTools],
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

    // Trigger Alfred to speak first so we don't have dead air after pickup.
    // Semantic VAD would otherwise wait for user audio.
    this.realtime?.triggerGreeting();

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
      case "start": {
        this.streamSid = event.streamSid;
        if (this._startDeadline) {
          clearTimeout(this._startDeadline);
          this._startDeadline = null;
        }
        // Verify sig from customParameters BEFORE any billable work.
        // SaaS emits <Parameter name="sig" value="<hmac>"/> in the <Stream>;
        // it arrives as event.start.customParameters.sig.
        const params = (event as any).start?.customParameters ?? {};
        const sig: string | undefined = params.sig;
        if (!verifySig(this.opts.tenantId, sig)) {
          bumpMetric("callsRejectedBadSig");
          console.warn(
            `[call ${this.callId}] sig verification failed — disposing`,
          );
          this.dispose("bad-sig");
          return;
        }
        // Capture caller number if SaaS included it as a parameter (optional).
        if (typeof params.from === "string") {
          this.callerNumber = params.from;
        }
        // Sig is valid → fetch tenant + connect OpenAI. Fire-and-forget; the
        // `start` handler itself returns synchronously.
        this.initialise().catch((err) => {
          console.error(`[call ${this.callId}] initialise failed`, err);
          this.dispose("initialise-failed");
        });
        break;
      }
      case "media":
        this.resetIdleTimer();
        // Forward μ-law bytes verbatim. Barge-in is handled by the OpenAI
        // server-side VAD (`interrupt_response: true`), NOT by cancelling on
        // every media packet — the preview API required client-side cancellation
        // which in GA causes `status: "cancelled"` responses with zero tokens.
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
        this.currentAssistantText = "";
        break;
      case "response.output_audio.delta":
        // GA event name (was `response.audio.delta` in the preview API).
        if (event.delta) {
          sendTwilioMedia(this.twilioWs, this.streamSid, event.delta);
        }
        break;
      case "response.output_audio_transcript.delta":
        // Assistant's TTS transcript streamed as we speak — accumulate.
        if (typeof event.delta === "string") {
          this.currentAssistantText += event.delta;
        }
        break;
      case "response.output_audio.done":
        // Mark playback so we know when Twilio finishes the buffer.
        sendTwilioMark(this.twilioWs, this.streamSid, `seg-${Date.now()}`);
        break;
      case "response.done":
        if (this.currentAssistantText.trim()) {
          this.transcript.push({
            role: "assistant",
            text: this.currentAssistantText.trim(),
            ts: new Date().toISOString(),
          });
        }
        this.currentAssistantText = "";
        break;
      case "input_audio_buffer.speech_started":
        // Server-side VAD detected the user starting to talk. With
        // `interrupt_response: true` on turn_detection the server will also emit
        // `response.cancelled` and tear down the in-flight TTS. But Twilio has
        // already buffered everything we forwarded up to this point — without a
        // `clear` event Twilio keeps playing the cached audio for another
        // 500-2000 ms, which is the "Alfred keeps talking after I interrupt"
        // symptom Sir reported on the 2026-05-27 home call. The `clear` drops
        // every pending media frame in Twilio's queue, so playback stops the
        // moment the cancel completes server-side.
        if (VOICE_DEBUG) {
          console.log(`[call ${this.callId}] VAD: speech_started — clearing Twilio playback buffer`);
        }
        sendTwilioClear(this.twilioWs, this.streamSid);
        this.currentAssistantText = "";
        break;
      case "input_audio_buffer.speech_stopped":
        if (VOICE_DEBUG) {
          console.log(`[call ${this.callId}] VAD: speech_stopped`);
        }
        break;
      case "response.cancelled":
        // Server confirmed it killed the in-flight response on VAD barge-in.
        if (VOICE_DEBUG) {
          console.log(`[call ${this.callId}] response.cancelled (barge-in)`);
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
    // Metrics bump — best-effort import to avoid circular type deps at compile
    // time in case server.ts is not yet built when this is loaded.
    try {
      const { bumpMetric } = await import("./server.js");
      bumpMetric("toolDispatches");
    } catch {
      /* ignore */
    }
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

    // Per-dispatch breadcrumb (DEBUG-gated). The pre-curation debug build
    // logged nothing on the dispatch path, so post-mortems had to cross-
    // reference ctrl-api access logs to reconstruct which tools the model
    // tried. With this in place a single `docker logs voice-bridge` over the
    // call window shows the full tool-call timeline. Args length only, never
    // the args themselves — they can carry secrets (`composio_execute` action
    // arguments, `self` request bodies).
    const dispatchStart = Date.now();
    let result;
    if (name === "self") {
      result = await dispatchSelf(this.tenantCtx, args);
    } else if (name === "composio_execute") {
      result = await dispatchComposioExecute(this.tenantCtx, args);
    } else if (isFilesToolName(name)) {
      // files__* — the read-only files surface added by #114 PR4. The
      // dispatcher lives in files-tools.ts and short-circuits read_text
      // when the file is binary or larger than the 32 KB voice ceiling.
      result = await dispatchFilesTool(name, this.tenantCtx, args);
    } else if (isMcpToolName(name)) {
      // <server>__<tool> shape — route to the MCP client we connected at
      // voice-bridge boot. See mcp-clients.ts for the dispatcher.
      result = await dispatchMcp(name, args);
    } else {
      result = { ok: false, error: `Unknown tool: ${name}` };
    }
    if (VOICE_DEBUG) {
      const ms = Date.now() - dispatchStart;
      const status =
        typeof (result as any)?.status === "number"
          ? (result as any).status
          : (result as any)?.ok
            ? "ok"
            : "err";
      const argsLen = argsRaw ? String(argsRaw).length : 0;
      console.log(
        `[call ${this.callId}] tool ${name} ok=${(result as any)?.ok} status=${status} ${ms}ms argsLen=${argsLen}`,
      );
    }
    this.realtime.submitToolResult(callId, serializeToolResult(result));
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
    if (this._startDeadline) clearTimeout(this._startDeadline);
    bumpMetric("callsDisposed");

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
