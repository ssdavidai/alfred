// wyoming-server.ts — Wyoming Protocol fallback for HA Voice (#112 PR5).
//
// Wyoming is the JSONL-over-TCP protocol that Home Assistant uses to talk to
// satellite / STT / TTS / wake-word services (the rhasspy/wyoming repo).
// HA's `wyoming` integration calls out to a Wyoming server when the operator
// picks one as the conversation / pipeline endpoint. This file implements
// the satellite-side surface so HA can route a full pipeline through us
// without going via the ESPHome Native API.
//
// THE WYOMING-vs-ESPHOME-NATIVE TRADE-OFF
// --------------------------------------
//
// Both transports terminate at the same brain (`EsphomeVoiceSession`), but
// they reach it through different HA-side stacks:
//
//   - ESPHome Native API (PR1/PR2):  satellite ──(api)──> voice-bridge :6053
//     HA discovers the bridge as if it were a single ESPHome firmware
//     device, the satellite is configured to forward voice_assistant audio
//     here directly. HA never sees the audio.
//
//   - Wyoming (this file):           satellite ──> HA Assist ──> wyoming
//     :10300 ──> voice-bridge        HA's wake/STT/intent/TTS stack sits
//     in the middle; the audio is decoded + re-encoded once. Costs ~30ms
//     latency + a serialisation round-trip per turn.
//
// We default to ESPHome Native (the audio path is shorter, the wake-word
// stays on-device for free, and the HA satellite "Just Works" via mDNS).
// Wyoming is the fallback for two cases:
//
//   1. HA-OS / HA-Cloud installs that can't reach voice-bridge's :6053 over
//      the LAN — they CAN reach :10300 because Wyoming is a normal HTTP-ish
//      service HA's REST + wyoming integrations both speak.
//   2. Non-ESPHome satellites (Raspberry Pi running Wyoming-Satellite, a
//      M5StickC running rhasspy-wyoming, etc.). The Wyoming protocol is the
//      universal "I have a microphone, please be my brain" interface in
//      HA's voice ecosystem.
//
// Off by default — flip WYOMING_ENABLED=1 in /opt/alfred/.env on tenants
// that prefer this route.
//
// WIRE FORMAT
// -----------
//
// Each event = one JSONL line (header) + optional binary payload:
//
//     {"type":"audio-chunk","data":{"rate":16000,"width":2,"channels":1},
//      "payload_length":640}\n
//     <640 raw bytes of pcm16>
//
// Header keys we honour:
//   type            string  — required, names the event (see WyomingEventType)
//   data            object  — event-specific payload (rate, width, etc.)
//   payload_length  uint    — 0 / absent for header-only events
//   version         string  — Wyoming protocol version we advertise (1.0.0)
//
// Reference: https://github.com/rhasspy/wyoming — README has the full event
// grammar. Where the spec is ambiguous (e.g. payload framing edge cases) we
// document the deviation in the test file `wyoming-server.test.ts`.
//
// NOT in scope for PR5:
//   - TLS termination — Wyoming runs as plain TCP behind the tailnet boundary.
//   - Authentication — same boundary applies; HA's Wyoming integration has
//     no built-in auth layer.
//   - Streaming `synthesize` text-to-audio — we forward OpenAI Realtime audio
//     as a stream of `audio-chunk` events instead; the brain doesn't do
//     standalone TTS turns.

import net from "node:net";
import {
  EsphomeServerIdentity,
  VoiceSessionFactory,
  VoiceSessionHandle,
  VoiceSessionConnection,
} from "./esphome-server.js";
import {
  MessageType,
  VoiceAssistantEvent,
} from "./esphome-protocol.js";

// ── Event grammar ──────────────────────────────────────────────────────────

/** Wyoming event names we read or emit. Sourced from
 * github.com/rhasspy/wyoming/blob/master/wyoming/event.py + the event docs
 * in github.com/rhasspy/wyoming-satellite. */
export const WyomingEventType = {
  // ── Discovery ─────────────────────────────────────────────────────────
  /** HA → us. "Tell me what you are." Triggers an `info` reply. */
  Describe: "describe",
  /** Us → HA. Response to `describe`. Carries `info` for each service this
   * server offers (asr, tts, satellite, wake, intent). */
  Info: "info",

  // ── Audio in (mic from HA, possibly forwarded from a satellite) ───────
  AudioStart: "audio-start",
  AudioChunk: "audio-chunk",
  AudioStop: "audio-stop",

  // ── Transcript (we emit a Wyoming `transcript` once the brain finishes) ─
  Transcript: "transcript",

  // ── Synthesis (HA → us when used as a TTS service; we use it for
  // "OpenAI-Realtime is about to speak the following"). PR5 keeps this
  // off the request path because the brain emits audio directly. ────────
  Synthesize: "synthesize",

  // ── Pipeline lifecycle (we emit these for HA's voice UI). ─────────────
  RunPipeline: "run-pipeline",
  RunEnd: "run-end",

  // ── Errors ────────────────────────────────────────────────────────────
  Error: "error",
} as const;

export type WyomingEventName = (typeof WyomingEventType)[keyof typeof WyomingEventType];

export interface WyomingEvent {
  type: string;
  data?: Record<string, unknown>;
  payload?: Buffer;
  /** Wyoming protocol version we received / emit. Optional in the header
   * (HA's `wyoming` integration sometimes omits it). */
  version?: string;
}

// ── Encoder / decoder ──────────────────────────────────────────────────────

/** Serialise one Wyoming event into the on-wire format:
 *  `<json header>\n[<binary payload>]`. */
export function encodeWyomingEvent(event: WyomingEvent): Buffer {
  const headerObj: Record<string, unknown> = { type: event.type };
  if (event.data !== undefined) headerObj.data = event.data;
  if (event.version !== undefined) headerObj.version = event.version;
  const payload = event.payload ?? Buffer.alloc(0);
  if (payload.length > 0) headerObj.payload_length = payload.length;
  const headerLine = Buffer.from(JSON.stringify(headerObj) + "\n", "utf-8");
  return payload.length > 0 ? Buffer.concat([headerLine, payload]) : headerLine;
}

/** Stateful framing parser. Wyoming events split across TCP chunks the same
 * way ESPHome frames do; this class smooths over both. Yields one event per
 * call to `push()` until the buffered bytes can't form a full event yet. */
export class WyomingFrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): WyomingEvent[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const events: WyomingEvent[] = [];

    while (this.buffer.length > 0) {
      // Find the header newline.
      const nl = this.buffer.indexOf(0x0a /* \n */);
      if (nl < 0) break; // partial header
      const headerBytes = this.buffer.subarray(0, nl);
      let header: Record<string, unknown>;
      try {
        header = JSON.parse(headerBytes.toString("utf-8")) as Record<
          string,
          unknown
        >;
      } catch (err) {
        throw new Error(
          `wyoming: header is not valid JSON (${headerBytes
            .toString("utf-8")
            .slice(0, 80)})`,
        );
      }
      if (typeof header.type !== "string" || header.type.length === 0) {
        throw new Error("wyoming: event header missing required `type`");
      }
      const payloadLen =
        typeof header.payload_length === "number" && header.payload_length > 0
          ? header.payload_length
          : 0;
      const totalNeeded = nl + 1 + payloadLen;
      if (this.buffer.length < totalNeeded) break; // partial payload
      const payload =
        payloadLen > 0
          ? this.buffer.subarray(nl + 1, nl + 1 + payloadLen)
          : undefined;
      events.push({
        type: header.type,
        data: header.data as Record<string, unknown> | undefined,
        version:
          typeof header.version === "string" ? header.version : undefined,
        payload,
      });
      this.buffer = this.buffer.subarray(totalNeeded);
    }

    return events;
  }

  /** Test hook — bytes buffered but not yet a full event. */
  pendingBytes(): number {
    return this.buffer.length;
  }
}

// ── Info response ──────────────────────────────────────────────────────────

/** Build the JSON we send back on `describe`. Wyoming's `info` event carries
 * one or more service-type arrays — we only advertise `satellite` (because
 * the brain answers the full pipeline) so HA wires us as the satellite + the
 * conversation/intent agent simultaneously. */
export function buildWyomingInfo(opts: {
  identity: EsphomeServerIdentity;
}): Record<string, unknown> {
  return {
    satellite: {
      name: opts.identity.friendlyName,
      attribution: {
        name: opts.identity.manufacturer,
        url: "https://alfred.black",
      },
      installed: true,
      description:
        "Alfred — GPT-Realtime butler. One brain across phone, Slack, and voice.",
      version: opts.identity.projectVersion,
      area: null,
      snd_format: { rate: 16000, width: 2, channels: 1 },
      mic_format: { rate: 16000, width: 2, channels: 1 },
    },
  };
}

// ── Per-connection session ─────────────────────────────────────────────────

/** Wyoming-side connection — one TCP socket from HA's wyoming integration.
 * Bridges audio in/out through the shared voiceSessionFactory so the same
 * `EsphomeVoiceSession` brain answers both ESPHome-Native and Wyoming
 * pipelines. */
export class WyomingConnection {
  private parser = new WyomingFrameParser();
  /** The active voice session for the current turn, if any. We open one on
   * the first `audio-start` and dispose on `audio-stop` or socket close. */
  private session: VoiceSessionHandle | null = null;
  /** Tracks the format HA announced in `audio-start` so we can sanity-check
   * subsequent chunks. The brain assumes 16 kHz pcm16 mono regardless; if
   * HA announces something else we transcode at the brain edge (PR2's
   * resampler in esphome-session.ts handles the rate conversion). */
  private inboundFormat: { rate: number; width: number; channels: number } | null =
    null;
  /** Outbound `audio-start` deferred until we have a first audio chunk to
   * ship — sending it earlier confuses HA when the brain decides to reply
   * with text-only. */
  private outboundAudioStarted = false;
  /** Last seen `info` request — we cache the response so repeat probes are
   * cheap. */
  private cachedInfo: Record<string, unknown> | null = null;

  constructor(
    private readonly socket: net.Socket,
    private readonly opts: WyomingServerOptions,
  ) {
    const log = opts.log ?? defaultLog;
    const remote = socket.remoteAddress ?? "?";
    log("wyoming connection accepted", { remote });
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (err) =>
      log("wyoming socket error", { remote, err: err.message }),
    );
    socket.on("close", () => {
      log("wyoming connection closed", { remote });
      if (this.session) {
        try {
          this.session.close("wyoming-connection-closed");
        } catch {
          /* ignore */
        }
        this.session = null;
      }
    });
  }

  private onData(chunk: Buffer): void {
    let events: WyomingEvent[];
    try {
      events = this.parser.push(chunk);
    } catch (err) {
      const log = this.opts.log ?? defaultLog;
      log("wyoming parser error — closing connection", {
        err: err instanceof Error ? err.message : String(err),
      });
      this.socket.destroy();
      return;
    }
    for (const e of events) this.handleEvent(e);
  }

  private handleEvent(event: WyomingEvent): void {
    const log = this.opts.log ?? defaultLog;
    switch (event.type) {
      case WyomingEventType.Describe: {
        if (!this.cachedInfo) {
          this.cachedInfo = buildWyomingInfo({ identity: this.opts.identity });
        }
        this.sendEvent({
          type: WyomingEventType.Info,
          data: this.cachedInfo,
          version: "1.5.4",
        });
        return;
      }
      case WyomingEventType.AudioStart: {
        const data = (event.data ?? {}) as {
          rate?: number;
          width?: number;
          channels?: number;
        };
        this.inboundFormat = {
          rate: typeof data.rate === "number" ? data.rate : 16000,
          width: typeof data.width === "number" ? data.width : 2,
          channels: typeof data.channels === "number" ? data.channels : 1,
        };
        log("wyoming audio-start", this.inboundFormat as unknown as Record<
          string,
          unknown
        >);
        // Open a brain session. EsphomeVoiceSession assumes 16 kHz pcm16
        // mono on its `onInboundAudio` boundary — same wire shape Wyoming
        // gives us. If HA announces 8 kHz or stereo we still feed the
        // bytes through; the brain's `resamplePcm16` handles the upsample.
        this.openSession();
        return;
      }
      case WyomingEventType.AudioChunk: {
        if (!this.session) {
          // Stray chunk after audio-stop / before audio-start. Drop +
          // emit an error event so HA can surface the misordering instead
          // of silently dropping the turn.
          this.sendEvent({
            type: WyomingEventType.Error,
            data: {
              text: "audio-chunk arrived without a preceding audio-start",
              code: "no-active-session",
            },
          });
          return;
        }
        const data = event.payload ?? Buffer.alloc(0);
        if (data.length === 0) return; // header-only chunk = no-op
        this.session.onInboundAudio(data, false);
        return;
      }
      case WyomingEventType.AudioStop: {
        if (!this.session) return;
        // Signal end-of-mic to the brain.
        this.session.onInboundAudio(Buffer.alloc(0), true);
        return;
      }
      case WyomingEventType.Synthesize: {
        // HA can ask us to synthesize a text string standalone (as if we
        // were a TTS service). The brain doesn't offer that surface — we
        // only ship audio that comes out of a full pipeline turn — so we
        // surface an explicit error rather than silently 200. HA's TTS
        // selector will fall back to its other configured TTS.
        this.sendEvent({
          type: WyomingEventType.Error,
          data: {
            text:
              "Alfred Voice Bridge is a satellite, not a TTS service — pick a different TTS in the Assist pipeline.",
            code: "tts-not-supported",
          },
        });
        return;
      }
      case WyomingEventType.RunEnd:
      case "run-end": {
        // HA closing the pipeline mid-turn. Tear down our session.
        if (this.session) {
          try {
            this.session.close("ha-run-end");
          } catch {
            /* ignore */
          }
          this.session = null;
        }
        return;
      }
      default: {
        log("wyoming unhandled event (ignored)", { type: event.type });
        return;
      }
    }
  }

  private openSession(): void {
    if (this.session) {
      // Belt-and-braces — HA shouldn't open two pipelines on one connection,
      // but if it does we drop the old one. Same behaviour as
      // EsphomeConnection on overlapping VoiceAssistantRequest.
      try {
        this.session.close("wyoming-overlapping-start");
      } catch {
        /* ignore */
      }
      this.session = null;
    }

    const log = this.opts.log ?? defaultLog;
    // The Wyoming-side "connection hook" the brain expects: it speaks the
    // ESPHome Native API message vocabulary, so we translate inside `send`.
    // The brain only emits four message types end-to-end:
    //   - VoiceAssistantAudio          → us → HA `audio-chunk`
    //   - VoiceAssistantEventResponse  → us → HA `transcript` / `run-end`
    //   - VoiceAssistantResponse       → ignored (ack of audio-start)
    // Anything else gets logged + dropped.
    const connHook: VoiceSessionConnection = {
      send: (messageType, payload) =>
        this.translateAndSend(messageType, payload),
      log,
      identity: this.opts.identity,
    };
    try {
      this.session = this.opts.voiceSessionFactory({
        conn: connHook,
        conversationId: `wyoming-${Date.now()}`,
        wakeWordPhrase: "",
        flags: 0,
      });
    } catch (err) {
      log("wyoming session factory threw", {
        err: err instanceof Error ? err.message : String(err),
      });
      this.sendEvent({
        type: WyomingEventType.Error,
        data: {
          text: "session-init-failed",
          code: "openai-connect-failed",
        },
      });
    }
  }

  /** Convert one ESPHome-format outbound frame into the Wyoming-format
   * equivalent and ship it. */
  private translateAndSend(messageType: number, payload: Buffer): void {
    switch (messageType) {
      case MessageType.VoiceAssistantAudio: {
        // The brain frames audio as `pcm16 @ 16 kHz` with `data` (field 1) +
        // `end` (field 2). For Wyoming we re-wrap as `audio-chunk`.
        // We re-decode field 1 ourselves rather than depending on the
        // protobuf decoder here — the wire shape is `<tag(1,2)> <varint len>
        // <pcm bytes> <tag(2,0)> <bool>`. Simpler: the brain calls
        // `buildVoiceAssistantAudio({data, end})`, so we just strip the
        // protobuf tags by walking the payload.
        const { data, end } = decodeVoiceAssistantAudio(payload);
        if (!this.outboundAudioStarted && data.length > 0) {
          // First chunk of a TTS-style reply → emit `audio-start` so HA's
          // playback pipeline opens its sink.
          this.sendEvent({
            type: WyomingEventType.AudioStart,
            data: { rate: 16000, width: 2, channels: 1, timestamp: Date.now() },
          });
          this.outboundAudioStarted = true;
        }
        if (data.length > 0) {
          this.sendEvent({
            type: WyomingEventType.AudioChunk,
            data: { rate: 16000, width: 2, channels: 1 },
            payload: data,
          });
        }
        if (end && this.outboundAudioStarted) {
          this.sendEvent({
            type: WyomingEventType.AudioStop,
            data: { timestamp: Date.now() },
          });
          this.outboundAudioStarted = false;
        }
        return;
      }
      case MessageType.VoiceAssistantEventResponse: {
        const { eventType, dataKv } = decodeVoiceAssistantEvent(payload);
        if (eventType === VoiceAssistantEvent.STT_END) {
          // Carry the user transcript through to HA so its UI shows what
          // the principal said.
          const text = dataKv.text ?? "";
          this.sendEvent({
            type: WyomingEventType.Transcript,
            data: { text },
          });
          return;
        }
        if (eventType === VoiceAssistantEvent.RUN_END) {
          if (this.outboundAudioStarted) {
            this.sendEvent({
              type: WyomingEventType.AudioStop,
              data: { timestamp: Date.now() },
            });
            this.outboundAudioStarted = false;
          }
          this.sendEvent({
            type: WyomingEventType.RunEnd,
          });
          this.session = null;
          return;
        }
        if (eventType === VoiceAssistantEvent.ERROR) {
          this.sendEvent({
            type: WyomingEventType.Error,
            data: {
              text: dataKv.message ?? "openai-error",
              code: dataKv.code ?? "openai-error",
            },
          });
          return;
        }
        // RUN_START / TTS_START / TTS_END — Wyoming has no analog. Drop.
        return;
      }
      case MessageType.VoiceAssistantResponse: {
        // ACK of voice-start — Wyoming has no equivalent (HA pre-knows the
        // pipeline opened when `audio-chunk` events start arriving). Drop.
        return;
      }
      default: {
        // Anything else from the brain is unexpected on this transport.
        const log = this.opts.log ?? defaultLog;
        log("wyoming brain emitted unexpected esphome message", {
          messageType,
        });
        return;
      }
    }
  }

  private sendEvent(event: WyomingEvent): void {
    if (this.socket.destroyed) return;
    try {
      this.socket.write(encodeWyomingEvent(event));
    } catch (err) {
      const log = this.opts.log ?? defaultLog;
      log("wyoming write error", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── Server bootstrap ───────────────────────────────────────────────────────

export interface WyomingServerOptions {
  port: number;
  bindHost: string;
  identity: EsphomeServerIdentity;
  voiceSessionFactory: VoiceSessionFactory;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface WyomingServerHandle {
  server: net.Server;
  ready: Promise<void>;
  boundPort(): number;
  close(): Promise<void>;
  /** Unix-ms of the most recent `describe` we answered, or null. The
   * /channels card uses this as a freshness signal. */
  lastHandshakeAt(): number | null;
}

let _lastHandshakeAt: number | null = null;

export function startWyomingServer(opts: WyomingServerOptions): WyomingServerHandle {
  const log = opts.log ?? defaultLog;
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    new WyomingConnection(socket, opts);
    // Wrap the connection so we can tap `describe` for the handshake tag.
    // Cheaper than wiring a callback through WyomingConnection because the
    // server module is single-process.
    socket.once("data", () => {
      _lastHandshakeAt = Date.now();
    });
  });
  server.on("error", (err) => log("wyoming server error", { err: err.message }));

  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.bindHost, () => {
      server.removeListener("error", reject);
      log(`Wyoming Protocol listening on ${opts.bindHost}:${opts.port}`);
      resolve();
    });
  });

  return {
    server,
    ready,
    boundPort: () => {
      const addr = server.address();
      if (addr && typeof addr === "object") return addr.port;
      throw new Error("server not yet bound");
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    lastHandshakeAt: () => _lastHandshakeAt,
  };
}

// ── Helpers: decode the two ESPHome messages the brain emits at us ────────
// We use these inside `WyomingConnection.translateAndSend` rather than
// pulling in `decodeFields` from `esphome-protocol.ts` because we only
// care about three field paths and the inline path is clearer.

function decodeVoiceAssistantAudio(payload: Buffer): {
  data: Buffer;
  end: boolean;
} {
  let data = Buffer.alloc(0);
  let end = false;
  let off = 0;
  while (off < payload.length) {
    const tag = payload[off++];
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 2 /* length-delimited */) {
      // varint length
      let len = 0;
      let shift = 0;
      while (off < payload.length) {
        const b = payload[off++];
        len |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      const bytes = payload.subarray(off, off + len);
      off += len;
      if (fieldNumber === 1) data = Buffer.from(bytes); // copy out
    } else if (wireType === 0 /* varint */) {
      let v = 0;
      let shift = 0;
      while (off < payload.length) {
        const b = payload[off++];
        v |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      if (fieldNumber === 2) end = v !== 0;
    } else {
      // Unsupported wire type — bail.
      break;
    }
  }
  return { data, end };
}

function decodeVoiceAssistantEvent(payload: Buffer): {
  eventType: number;
  dataKv: Record<string, string>;
} {
  let eventType = 0;
  const dataKv: Record<string, string> = {};
  let off = 0;
  while (off < payload.length) {
    const tag = payload[off++];
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 0) {
      let v = 0;
      let shift = 0;
      while (off < payload.length) {
        const b = payload[off++];
        v |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      if (fieldNumber === 1) eventType = v;
    } else if (wireType === 2) {
      let len = 0;
      let shift = 0;
      while (off < payload.length) {
        const b = payload[off++];
        len |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      const subPayload = payload.subarray(off, off + len);
      off += len;
      if (fieldNumber === 2 /* data — repeated submessage */) {
        const { name, value } = decodeKvSubmessage(subPayload);
        if (name) dataKv[name] = value;
      }
    } else {
      break;
    }
  }
  return { eventType, dataKv };
}

function decodeKvSubmessage(payload: Buffer): {
  name: string;
  value: string;
} {
  let name = "";
  let value = "";
  let off = 0;
  while (off < payload.length) {
    const tag = payload[off++];
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType !== 2) break;
    let len = 0;
    let shift = 0;
    while (off < payload.length) {
      const b = payload[off++];
      len |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    const str = payload.subarray(off, off + len).toString("utf-8");
    off += len;
    if (fieldNumber === 1) name = str;
    if (fieldNumber === 2) value = str;
  }
  return { name, value };
}

function defaultLog(msg: string, extra?: Record<string, unknown>): void {
  if (extra) console.log(`[wyoming] ${msg}`, extra);
  else console.log(`[wyoming] ${msg}`);
}
