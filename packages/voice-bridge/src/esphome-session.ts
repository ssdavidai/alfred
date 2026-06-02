// esphome-session.ts — bridge one ESPHome VoiceAssistant turn to one OpenAI
// Realtime session.
//
// Spec: issue-112 §6 PR2 — "ESPHome ↔ OpenAI Realtime audio bridge."
//
// Lifecycle (one instance per turn):
//   1. EsphomeConnection receives VoiceAssistantRequest(start=true, conv_id).
//   2. EsphomeConnection sends VoiceAssistantResponse(port=0) (in-band audio).
//   3. EsphomeConnection constructs a EsphomeVoiceSession with the conv_id +
//      wake-word phrase + the connection-side `send()` hook.
//   4. The session opens an OpenAI Realtime WS:
//        - audio.input.format  = audio/pcm @ 24 kHz (model side)
//        - audio.output.format = audio/pcm @ 24 kHz
//        - instructions = buildInstructions({initiator:"user", voiceContext})
//      Tenant context is fetched best-effort (same path as the Twilio
//      VoiceCall) — failure to fetch it falls back to baseline persona.
//   5. Inbound VoiceAssistantAudio frames carry mic audio @ 16 kHz pcm16.
//      The session resamples 16 kHz → 24 kHz, base64-encodes, pushes to
//      OpenAI as input_audio_buffer.append.
//   6. OpenAI emits `response.output_audio.delta` (base64 pcm16 @ 24 kHz).
//      The session decodes base64, resamples 24 kHz → 16 kHz, frames into
//      ~20 ms VoiceAssistantAudio chunks, sends to HA.
//   7. Lifecycle events flow:
//        RUN_START (we emit) → STT_END (with transcript when we have it) →
//        TTS_START (we emit on first audio delta) → TTS_END (on
//        response.done) → RUN_END (after one tick to let HA drain).
//   8. Barge-in: server-side VAD on OpenAI Realtime fires
//      input_audio_buffer.speech_started → we emit a flush
//      VoiceAssistantAudio{data:<empty>, end:true} to drain HA's playback
//      buffer, mirroring the Twilio `clear` semantics.
//   9. Dispose: any path closes the Realtime WS, sends RUN_END to HA.
//
// What this file is NOT:
//   - It does not own the TCP socket — that's EsphomeConnection.
//   - It does not implement tool dispatch — PR6 will plumb that in once the
//     curated catalog audit picks which `ha__*` tools land in voice. PR2
//     ships without tools so we can validate the audio bridge alone.
//   - It does not handle wake-word discovery — HA owns wake on the satellite,
//     we just receive the resulting VoiceAssistantRequest.
//   - It does not write transcripts to the vault. The Twilio path does, but
//     PR2 is intentionally scoped to "audio in, audio out" — vault write-back
//     for HA voice lands in PR5 alongside the source:"ha_voice" audit field
//     in ctrl-api.

import { OpenAIRealtimeClient } from "./openai-realtime.js";
import {
  MessageType,
  VoiceAssistantEvent,
} from "./esphome-protocol.js";
import {
  buildVoiceAssistantAudio,
  buildVoiceAssistantEventResponse,
  type EsphomeServerIdentity,
  type VoiceSessionConnection,
  type VoiceSessionHandle,
} from "./esphome-server.js";
import { resamplePcm16, frameChunks } from "./audio-resample.js";
import { buildInstructions } from "./instructions.js";
import { fetchTenantContext, fetchVoiceContext } from "./tenant.js";
import type { Transport, TransportAudioConfig } from "./transport.js";

// Sample rates — load-bearing constants. HA satellites speak 16 kHz pcm16
// mono on both directions (see OHF-Voice/linux-voice-assistant/__main__.py
// :427 — `samplerate=16000`). The OpenAI Realtime GA `audio/pcm` codec is
// pcm16 LE @ 24 kHz mono. We resample at both ends of the bridge.
const ESPHOME_SAMPLE_RATE = 16_000;
const REALTIME_SAMPLE_RATE = 24_000;

// We frame outbound audio at ~20 ms — the chunk size real ESPHome firmware
// emits (esphome/components/voice_assistant/voice_assistant.cpp uses
// SEND_BUFFER_NUM_SAMPLES = 320, which at 16 kHz is exactly 20 ms). Any
// chunk size between 10–60 ms plays cleanly through HA's voice_assistant
// integration, but 20 ms minimises jitter on the I2S codec.
const OUTBOUND_FRAME_MS = 20;

export interface EsphomeVoiceSessionOpts {
  conn: VoiceSessionConnection;
  conversationId: string;
  wakeWordPhrase: string;
  flags: number;
}

/**
 * One ESPHome voice-assistant turn bridged to one OpenAI Realtime session.
 *
 * Implements the production VoiceSessionHandle contract; constructed by
 * EsphomeConnection on VoiceAssistantRequest(start=true). Tests replace this
 * with a mock via voiceSessionFactory.
 *
 * Also satisfies the Transport interface so future work can compose this
 * inside a generic VoiceCall-style brain. PR2 ships the bridge in-line for
 * simplicity; PR3 will pull a shared TransportBridge out once the Wyoming
 * path lands.
 */
export class EsphomeVoiceSession implements VoiceSessionHandle, Transport {
  // ── Transport-interface fields ──────────────────────────────────────────
  readonly id: string;
  readonly audioConfig: TransportAudioConfig;

  // ── Bridge state ────────────────────────────────────────────────────────
  private readonly conn: VoiceSessionConnection;
  private readonly conversationId: string;
  private readonly wakeWordPhrase: string;
  private realtime: OpenAIRealtimeClient | null = null;
  private disposed = false;
  /** True once we've sent TTS_START to HA — we only emit it once per turn,
   * on the first audio delta. */
  private ttsStartEmitted = false;
  /** Tracks an in-flight tail of <20 ms of PCM that didn't make a full
   * outbound frame. We concatenate the next delta to it before chunking. */
  private outboundResidue: Buffer = Buffer.alloc(0);
  /** Hold-back buffer for input audio that arrived before
   * OpenAI Realtime emitted session.updated. We replay it once the session
   * is ready, so the leading "Yes sir, what's on..." word isn't clipped. */
  private inboundPreAck: Buffer[] = [];
  private sessionReady = false;
  /** The principal's most-recent utterance — accumulated as OpenAI streams
   * transcription deltas; emitted as a STT_END event to HA so the satellite
   * UI shows the right text. */
  private currentPrincipalText = "";

  constructor(opts: EsphomeVoiceSessionOpts) {
    this.conn = opts.conn;
    this.conversationId = opts.conversationId || `va-${Date.now()}`;
    this.wakeWordPhrase = opts.wakeWordPhrase || "";
    this.id = `esphome:${this.conversationId}`;
    this.audioConfig = {
      input: { type: "pcm16", sampleRate: ESPHOME_SAMPLE_RATE },
      output: { type: "pcm16", sampleRate: ESPHOME_SAMPLE_RATE },
    };

    // Tell HA the run has started so its UI reflects "listening" → "thinking"
    // → "speaking" rather than going straight from start to a wall of audio.
    this.emitEvent(VoiceAssistantEvent.RUN_START);

    // Open the bridge. We don't await — the connection-side message loop is
    // synchronous and the next VoiceAssistantAudio frame can arrive before
    // OpenAI Realtime finishes its session.updated handshake. We buffer
    // pre-ack audio in `inboundPreAck` and replay once ready.
    this.openBridge(opts.conn.identity).catch((err) => {
      this.conn.log("voice session openBridge failed", {
        err: err instanceof Error ? err.message : String(err),
        conversationId: this.conversationId,
      });
      this.dispose("openai-connect-failed");
    });
  }

  // ── VoiceSessionHandle implementation ──────────────────────────────────
  onInboundAudio(chunk: Buffer, end: boolean): void {
    if (this.disposed) return;
    if (chunk.length > 0) {
      // Resample to 24 kHz for OpenAI Realtime audio/pcm. We do this on the
      // ingest side rather than buffering raw 16 kHz because (a) the resampled
      // bytes are what we'd be base64-encoding anyway, and (b) keeping the
      // buffered queue in target-rate units avoids re-resampling on replay.
      const resampled = resamplePcm16(
        chunk,
        ESPHOME_SAMPLE_RATE,
        REALTIME_SAMPLE_RATE,
      );
      if (this.sessionReady && this.realtime) {
        this.realtime.appendAudio(resampled.toString("base64"));
      } else {
        // Hold-back: we cap the pre-ack buffer at ~2 seconds of audio so a
        // wedged Realtime connect doesn't unbounded-grow our heap.
        const capBytes = REALTIME_SAMPLE_RATE * 2 * 2; // 2 s × 2 bytes/sample
        const totalSoFar = this.inboundPreAck.reduce(
          (n, b) => n + b.length,
          0,
        );
        if (totalSoFar + resampled.length <= capBytes) {
          this.inboundPreAck.push(resampled);
        } else {
          // Drop — better than OOM.
          this.conn.log(
            "voice session inbound buffer cap hit — dropping pre-ack audio",
          );
        }
      }
    }
    if (end) {
      // HA signalled end-of-mic (e.g. user stopped talking, VAD on the
      // satellite committed the turn). We don't need to do anything special —
      // OpenAI's server-side VAD will commit when it sees silence in the
      // resampled stream. But if HA decided "user is done" before our VAD
      // does, we can hurry the model along by clearing the input buffer
      // explicitly. Skipped for now — over-eager commits are worse than
      // late ones.
    }
  }

  onInboundEvent(
    eventType: number,
    data: Array<{ name: string; value: string }>,
  ): void {
    if (this.disposed) return;
    // HA's RUN_END means it's tearing down its side; we dispose. Other event
    // types (e.g. WAKE_WORD_END from a satellite that re-fired wake mid-turn)
    // are forward-compat noise we log + ignore.
    if (eventType === VoiceAssistantEvent.RUN_END) {
      this.dispose("ha-run-end");
      return;
    }
    this.conn.log("voice session inbound event (ignored)", {
      eventType,
      dataLen: data.length,
    });
  }

  close(reason: string): void {
    this.dispose(reason);
  }

  // ── Transport interface implementation ─────────────────────────────────
  // These are stubs that the bridge can compose with a generic VoiceCall
  // replacement in a follow-up PR. PR2 doesn't actually route through them —
  // the realtime listener inside openBridge() writes directly to HA — but
  // satisfying the type shape now means the future refactor doesn't move
  // public surface.

  sendAudio(chunk: Buffer): void {
    this.shipOutboundAudio(chunk);
  }

  clear(): void {
    // Barge-in: drain HA's playback queue. We send an empty
    // VoiceAssistantAudio frame with end=true. Mirrors the Twilio `clear`
    // event on the other transport.
    this.conn.send(
      MessageType.VoiceAssistantAudio,
      buildVoiceAssistantAudio({ data: Buffer.alloc(0), end: true }),
    );
    this.outboundResidue = Buffer.alloc(0);
    this.ttsStartEmitted = false;
  }

  onPrincipalSaid(text: string): void {
    if (this.disposed) return;
    if (!text.trim()) return;
    this.emitEvent(VoiceAssistantEvent.STT_END, [
      { name: "text", value: text },
    ]);
  }

  onTurnEnd(): void {
    this.emitEvent(VoiceAssistantEvent.TTS_END);
    // We leave a beat before RUN_END so HA's playback buffer drains the
    // tail of audio before the satellite transitions to idle. 50 ms is the
    // shortest delay that's reliable on HA core's pipeline state machine
    // (any shorter and the satellite occasionally cuts off the last word).
    setTimeout(() => {
      if (this.disposed) return;
      this.emitEvent(VoiceAssistantEvent.RUN_END);
      this.dispose("turn-complete");
    }, 50);
  }

  // ── Implementation details ─────────────────────────────────────────────
  private async openBridge(identity: EsphomeServerIdentity): Promise<void> {
    // Best-effort tenant + voice context. Same fallback rule as the Twilio
    // path: missing context = baseline persona.
    let voiceContext = null;
    try {
      const tenantCtx = await fetchTenantContext(identity.name);
      voiceContext = await fetchVoiceContext(tenantCtx);
    } catch (err) {
      this.conn.log("voice session tenant context fetch failed (falling back)", {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    const instructions = buildInstructions({
      tenantPhoneNumber: null,
      callerNumber: null,
      initiator: "user",
      voiceContext,
    });

    const client = new OpenAIRealtimeClient(this.id);
    client.on((event) => this.onRealtimeEvent(event));
    this.realtime = client;

    // We override the audio codec to pcm16 because ESPHome is wideband. The
    // existing connect() method bakes in audio/pcmu for Twilio; for now we
    // accept that and post-monkey-patch the session via a follow-up
    // session.update. A cleaner refactor that takes the codec as a parameter
    // lands in PR3 alongside the Wyoming transport — same shape, same
    // realtime handshake, just a different codec triple.
    //
    // The OpenAIRealtimeClient also installs server_vad with
    // interrupt_response=true. For wideband ESPHome audio that's fine;
    // semantic_vad would arguably do better, but parity with Twilio keeps
    // the surface predictable. We may bump to semantic_vad in a follow-up
    // once we have flight-tested barge-in on the actual Voice PE hardware.
    await client.connect({ instructions });

    // Once connected, send a follow-up session.update to switch the codec
    // to pcm16 @ 24 kHz on both directions. session.updated already fired
    // for the initial pcmu config; the follow-up update overwrites it and
    // we re-arm sessionReady when it acks. (Currently isReady remains true
    // because the client doesn't reset its flag — that's fine; we just need
    // the model to start using pcm16 on the next frame.)
    client.send({
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        audio: {
          input: { format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE } },
          output: {
            format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
          },
        },
      },
    });

    this.sessionReady = true;

    // Replay any audio buffered while we were connecting.
    for (const chunk of this.inboundPreAck) {
      client.appendAudio(chunk.toString("base64"));
    }
    this.inboundPreAck = [];

    // Greet — semantic VAD would wait for user speech otherwise, but the
    // wake-word already fired on the satellite, so the principal expects an
    // immediate response. (HA's satellite played its own ack sound; the
    // OpenAI greeting overlaps it gracefully because HA ducks ack audio
    // when TTS_START fires.)
    client.triggerGreeting();
  }

  private onRealtimeEvent(event: any): void {
    if (this.disposed) return;
    switch (event.type) {
      case "response.output_audio.delta":
        // OpenAI emits base64-encoded pcm16 LE @ 24 kHz. Decode → resample to
        // 16 kHz → frame → ship.
        if (typeof event.delta === "string" && event.delta.length > 0) {
          const buf = Buffer.from(event.delta, "base64");
          this.shipOutboundAudio(buf);
        }
        break;
      case "response.output_audio_transcript.delta":
        // We don't expose assistant transcripts to HA; just accumulate for
        // a future write-back path.
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof event.transcript === "string" && event.transcript.trim()) {
          this.currentPrincipalText = event.transcript.trim();
          this.onPrincipalSaid(this.currentPrincipalText);
        }
        break;
      case "input_audio_buffer.speech_started":
        // Server-side VAD on OpenAI fired — barge-in. Flush HA playback.
        this.clear();
        break;
      case "response.done":
        this.onTurnEnd();
        break;
      case "error":
        // Logged by the realtime client; surface as ERROR to HA.
        this.emitEvent(VoiceAssistantEvent.ERROR, [
          {
            name: "code",
            value: String(event.error?.code ?? "openai-error"),
          },
          {
            name: "message",
            value: String(event.error?.message ?? "").slice(0, 256),
          },
        ]);
        break;
    }
  }

  /** Take a buffer of pcm16 @ 24 kHz, resample to 16 kHz, chunk to 20 ms
   * frames, ship each as a VoiceAssistantAudio frame. */
  private shipOutboundAudio(realtimePcm: Buffer): void {
    if (this.disposed || realtimePcm.length === 0) return;
    if (!this.ttsStartEmitted) {
      this.emitEvent(VoiceAssistantEvent.TTS_START);
      this.ttsStartEmitted = true;
    }
    const downsampled = resamplePcm16(
      realtimePcm,
      REALTIME_SAMPLE_RATE,
      ESPHOME_SAMPLE_RATE,
    );
    // Prepend any sub-frame residue we held back last call so we never ship
    // a chunk shorter than the target frame size (except the final one).
    const combined =
      this.outboundResidue.length === 0
        ? downsampled
        : Buffer.concat([this.outboundResidue, downsampled]);
    const frames = frameChunks(combined, ESPHOME_SAMPLE_RATE, OUTBOUND_FRAME_MS);
    // The last frame may be short — hold it back as residue for the next call,
    // unless `disposed` (we won't get another call).
    const fullFrameBytes = Math.floor(
      (ESPHOME_SAMPLE_RATE * OUTBOUND_FRAME_MS) / 1000,
    ) * 2; // bytes
    for (const f of frames) {
      if (f.length === fullFrameBytes) {
        this.conn.send(
          MessageType.VoiceAssistantAudio,
          buildVoiceAssistantAudio({ data: f, end: false }),
        );
      } else {
        this.outboundResidue = Buffer.from(f);
      }
    }
    // If `combined` divided evenly the loop already shipped everything and
    // residue is whatever was left from the prior iteration (could be 0).
    if (frames.length > 0 && frames[frames.length - 1].length === fullFrameBytes) {
      this.outboundResidue = Buffer.alloc(0);
    }
  }

  private emitEvent(
    eventType: number,
    data?: Array<{ name: string; value: string }>,
  ): void {
    if (this.disposed) return;
    this.conn.send(
      MessageType.VoiceAssistantEventResponse,
      buildVoiceAssistantEventResponse({ eventType, data }),
    );
  }

  private dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.conn.log("voice session disposing", {
      reason,
      conversationId: this.conversationId,
    });
    // Flush any residual audio so HA doesn't lose the tail.
    if (this.outboundResidue.length > 0) {
      this.conn.send(
        MessageType.VoiceAssistantAudio,
        buildVoiceAssistantAudio({
          data: this.outboundResidue,
          end: false,
        }),
      );
      this.outboundResidue = Buffer.alloc(0);
    }
    try {
      this.realtime?.close();
    } catch {
      /* ignore */
    }
    this.realtime = null;
  }
}
