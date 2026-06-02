// transport.ts — the thin abstraction that lets one bridge brain talk to two
// audio carriers (Twilio Media Streams and ESPHome Native API VoiceAssistant).
//
// The brain is the OpenAI Realtime turn — same persona, same tools, same
// session.update handshake, same barge-in semantics. The transport is the
// last-mile wire to the principal's ear (PSTN through Twilio; HA Voice
// satellite through ESPHome). Each transport implements a small set of audio
// + lifecycle methods; the bridge holds the transport and the Realtime client
// and copies bytes between them.
//
// Why an interface rather than two specialised bridge classes:
//   - The OpenAI Realtime client is byte-for-byte the same on both paths.
//     Twilio gives us μ-law @ 8 kHz, ESPHome gives us pcm16 @ 16 kHz; the
//     model can speak either format on input AND output (audio.input.format
//     and audio.output.format are configurable per session). So the only
//     transport-specific code is the codec config + the bytes-in/bytes-out
//     plumbing.
//   - We want the persona, the guardrails, and the tool dispatch logic to
//     stay in one place. Adding a third transport (Wyoming in PR3, FreeSWITCH
//     in some future PR) shouldn't require copy-pasting the persona block.
//
// Why methods rather than events:
//   - The bridge owns the lifecycle (when to clear playback, when to declare
//     an utterance done). Methods make the call sites explicit.
//   - Events would imply we want multiple listeners. We do not — each call
//     has exactly one transport.
//
// What is NOT in this interface (kept transport-specific):
//   - Session-establishment plumbing. Twilio's sig verification, ESPHome's
//     SubscribeVoiceAssistantRequest, Wyoming's `info` exchange — each
//     transport bootstraps itself and only asks for a brain once it's ready.
//   - Codec choice. Each transport configures its own session.update with
//     the right audio.input.format / audio.output.format because the OpenAI
//     Realtime API only allows one codec per session. The brain reads
//     `audioConfig` off the transport (see TransportAudioConfig below) and
//     copies it into session.update.
//   - Tenant identity, tool catalog, persona context. Those flow from
//     buildInstructions() + fetchVoiceContext() and are transport-agnostic.

import type { Buffer } from "node:buffer";

/** Sample rate + codec the transport speaks on the wire. The bridge uses
 * this to (a) configure OpenAI Realtime's audio.input.format and
 * audio.output.format, and (b) decide whether resampling is needed on the
 * boundary. Twilio: g711_ulaw @ 8 kHz. ESPHome: pcm16 LE @ 16 kHz. */
export type TransportAudioCodec =
  | { type: "g711_ulaw"; sampleRate: 8000 }
  | { type: "pcm16"; sampleRate: number };

export interface TransportAudioConfig {
  /** Format spoken into the transport (carrier → bridge → model). */
  input: TransportAudioCodec;
  /** Format the transport accepts on playback (model → bridge → carrier). */
  output: TransportAudioCodec;
}

/** What the bridge tells the transport to do. */
export interface Transport {
  /** Human-readable id for log lines. e.g. "twilio:CAxxxx" or "esphome:HA-sub-1". */
  readonly id: string;

  /** Audio format contract — see TransportAudioConfig. */
  readonly audioConfig: TransportAudioConfig;

  /**
   * Ship a chunk of output audio to the carrier. Bytes are encoded per
   * `audioConfig.output` — Twilio gets base64-μ-law inside a JSON envelope,
   * ESPHome gets a raw PCM16 buffer inside a VoiceAssistantAudio frame.
   *
   * The bridge calls this on every `response.output_audio.delta` from
   * OpenAI Realtime. Implementations MUST tolerate sub-frame chunk sizes
   * (the bridge does not pre-frame).
   *
   * The bridge passes raw bytes in the codec specified by audioConfig.output —
   * the transport is responsible for any envelope serialisation (base64 for
   * Twilio, varint-prefixed length-delimited for ESPHome).
   */
  sendAudio(chunk: Buffer): void;

  /**
   * Drop any queued output audio in the carrier's playback buffer. Called
   * by the bridge on `input_audio_buffer.speech_started` (server-side VAD
   * detected user starting to talk → barge-in).
   *
   * On Twilio this maps to a `{event:"clear"}` JSON message which empties
   * Twilio's playback queue. On ESPHome this maps to a `VoiceAssistantAudio{
   * data:<empty>, end:true }` frame, then a follow-up
   * `VoiceAssistantEventResponse{event_type: TTS_END}` so HA marks the run as
   * idle. (See esphome-session.ts for the exact wire.)
   *
   * MUST be idempotent — the bridge may call it more than once per turn.
   */
  clear(): void;

  /**
   * Inform the transport that the principal said something (i.e. the model's
   * `conversation.item.input_audio_transcription.completed` event fired with
   * a non-empty transcript). Used by ESPHome to forward `STT_END` to HA's
   * pipeline UI; Twilio just logs it. The transport MUST NOT block on this.
   */
  onPrincipalSaid(text: string): void;

  /**
   * Inform the transport that the turn is complete (model finished speaking
   * + OpenAI sent `response.done`). Used by ESPHome to send `RUN_END` to HA
   * so the satellite's "listening / thinking / speaking" indicator returns
   * to idle. Twilio implementations no-op.
   */
  onTurnEnd(): void;

  /**
   * Tear down the transport — close sockets, free buffers. Called by the
   * bridge on dispose; the transport MUST tolerate being called twice. An
   * optional `reason` is logged but does not change behaviour — provided so
   * the same hook can serve as VoiceSessionHandle.close (which takes a
   * reason for log lines).
   */
  close(reason?: string): void;
}

/**
 * Callbacks the transport invokes on the bridge. Symmetric with Transport —
 * the bridge passes one of these to the transport at construction, and the
 * transport calls these to push events into the brain.
 */
export interface TransportHandlers {
  /** Carrier delivered an input-audio chunk. Encoded per `audioConfig.input`.
   * For Twilio, the transport passes the raw base64 string the carrier sent
   * (decoded into Buffer is wasted work — OpenAI accepts base64 directly).
   * For ESPHome the transport passes the raw PCM16 bytes; the bridge handles
   * resampling + base64-encode before pushing to OpenAI. To unify the
   * interface we always pass Buffer; the bridge knows which lane it's on
   * from `audioConfig.input.type`.
   */
  onAudio(chunk: Buffer): void;

  /** Carrier signalled session end. Bridge will call transport.close(). */
  onClose(reason: string): void;
}
