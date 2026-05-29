// esphome-realtime-bridge.test.ts — integration tests for issue #112 PR2.
//
// Scope (per spec §6 PR2 acceptance):
//   1. Audio resampler shape — 16 kHz → 24 kHz, 24 kHz → 16 kHz, 22.05 kHz
//      round-trips. Same-rate copy. Empty input. Odd-byte rejection.
//   2. ESPHome connection handles SubscribeVoiceAssistantRequest +
//      VoiceAssistantRequest(start=true) by:
//        a. Sending VoiceAssistantResponse(port=0, error=false)
//        b. Spawning a VoiceSessionHandle via the injected factory
//        c. Forwarding VoiceAssistantAudio + VoiceAssistantEventResponse to
//           the session
//   3. The session emits VoiceAssistantEventResponse(RUN_START) on construction.
//   4. The session emits VoiceAssistantEventResponse(RUN_END) when the bridge
//      decides the turn is over (we exercise this via the mock factory).
//   5. clear() (barge-in) → emits VoiceAssistantAudio{data:<empty>, end:true}.
//   6. The persona instructions are applied to OpenAI Realtime session.update.
//   7. Audio flows forward: mock satellite sends pcm16 chunk → mock Realtime
//      sees input_audio_buffer.append carrying the resampled bytes.
//   8. Audio flows backward: mock Realtime sends response.output_audio.delta →
//      satellite receives VoiceAssistantAudio frames.
//
// Twilio path: NOT touched. PR2 preserves voice-call.ts byte-for-byte.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";

// env must be set BEFORE importing the SUTs that transitively load config.ts.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "sk-test-dummy";
process.env.VOICE_BRIDGE_INTERNAL_TOKEN =
  process.env.VOICE_BRIDGE_INTERNAL_TOKEN ?? "test-internal-token";
// Make the OpenAI ACK timeout aggressive so failure modes don't pad the
// test wallclock.
process.env.VOICE_BRIDGE_ACK_TIMEOUT_MS_FOR_TEST = "1500";

import { WebSocketServer } from "ws";
import { resamplePcm16, frameChunks } from "./audio-resample.js";
import {
  MessageType,
  VoiceAssistantEvent,
  FrameParser,
  encodeFrame,
  decodeFields,
  fieldAsBool,
  fieldAsString,
  fieldAsUint,
  writeBoolField,
  writeStringField,
  writeUint32Field,
  writeBytesField,
} from "./esphome-protocol.js";
import {
  computeIdentity,
  startEsphomeServer,
  buildVoiceAssistantAudio,
  buildVoiceAssistantEventResponse,
  EMPTY_PAYLOAD,
  type VoiceSessionHandle,
  type VoiceSessionFactory,
} from "./esphome-server.js";

// ── §1 audio-resample ────────────────────────────────────────────────────────

test("resamplePcm16: 16 kHz → 24 kHz produces 3:2 sample count", () => {
  // 320 input samples (20 ms @ 16 kHz) → 480 output samples (20 ms @ 24 kHz).
  const samples = 320;
  const input = Buffer.alloc(samples * 2);
  // Fill with a sloped ramp so we can spot-check interpolation behaviour.
  for (let i = 0; i < samples; i++) {
    input.writeInt16LE(i * 10, i * 2);
  }
  const out = resamplePcm16(input, 16_000, 24_000);
  assert.equal(out.length / 2, 480, "16k→24k yields 1.5× sample count");
  // First and last samples should match the input endpoints (modulo
  // floor() on the last sample's index — the last output sample is at
  // srcPos = 479 * (16/24) = 319.333…, so it interpolates between input[319]
  // and input[319] (clamped) → equals input[319] * (1-0.333) + input[319]
  // * 0.333 = input[319]).
  assert.equal(out.readInt16LE(0), input.readInt16LE(0), "first sample preserved");
  // The slope ensures monotonicity in the output too.
  let prev = -1;
  for (let i = 0; i < 480; i++) {
    const v = out.readInt16LE(i * 2);
    assert.ok(v >= prev, `output sample ${i} (=${v}) not monotonic vs prev=${prev}`);
    prev = v;
  }
});

test("resamplePcm16: 24 kHz → 16 kHz produces 2:3 sample count", () => {
  // 480 input samples (20 ms @ 24 kHz) → 320 output samples (20 ms @ 16 kHz).
  const samples = 480;
  const input = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    input.writeInt16LE(i * 5, i * 2);
  }
  const out = resamplePcm16(input, 24_000, 16_000);
  assert.equal(out.length / 2, 320, "24k→16k yields 2/3× sample count");
  assert.equal(out.readInt16LE(0), 0, "first sample preserved");
});

test("resamplePcm16: 24 kHz → 22.05 kHz handles non-integer ratios", () => {
  const samples = 240; // 10 ms @ 24 kHz
  const input = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) input.writeInt16LE(i, i * 2);
  const out = resamplePcm16(input, 24_000, 22_050);
  const expected = Math.floor((samples * 22_050) / 24_000);
  assert.equal(
    out.length / 2,
    expected,
    "non-integer-ratio output count matches floor(n*22050/24000)",
  );
});

test("resamplePcm16: same rate returns a copy (independent buffer)", () => {
  const input = Buffer.from([0x10, 0x00, 0x20, 0x00, 0x30, 0x00]);
  const out = resamplePcm16(input, 16_000, 16_000);
  assert.deepEqual(out, input, "same-rate output bit-identical");
  out[0] = 0xff;
  assert.notEqual(input[0], 0xff, "mutating output must not mutate input");
});

test("resamplePcm16: empty input → empty output", () => {
  assert.equal(resamplePcm16(Buffer.alloc(0), 16_000, 24_000).length, 0);
});

test("resamplePcm16: odd-byte input throws (framing error)", () => {
  assert.throws(
    () => resamplePcm16(Buffer.from([0x01, 0x02, 0x03]), 16_000, 24_000),
    /length must be even/,
  );
});

test("resamplePcm16: zero or negative rate throws", () => {
  const buf = Buffer.from([0x00, 0x00, 0x10, 0x00]);
  assert.throws(() => resamplePcm16(buf, 0, 16_000), /positive number/);
  assert.throws(() => resamplePcm16(buf, 16_000, -1), /positive number/);
});

test("frameChunks: splits PCM into ~20 ms frames at 16 kHz", () => {
  // 50 ms of audio = 800 samples = 1600 bytes. 20 ms frames = 640 bytes each
  // → 2 full + one residual of 320 bytes.
  const buf = Buffer.alloc(1600);
  const frames = frameChunks(buf, 16_000, 20);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].length, 640);
  assert.equal(frames[1].length, 640);
  assert.equal(frames[2].length, 320);
});

// ── §2-4 ESPHome wire — VoiceAssistantResponse + lifecycle events ────────────

interface Recorded {
  messageType: number;
  payload: Buffer;
}

/** Connect to the test server, send frames, collect responses for `collectMs`. */
async function exchange(
  port: number,
  outgoing: Array<{ messageType: number; payload: Buffer }>,
  opts: { collectMs?: number; keepOpen?: boolean } = {},
): Promise<{ frames: Recorded[]; sock: net.Socket }> {
  const collectMs = opts.collectMs ?? 200;
  const sock = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });
  const parser = new FrameParser();
  const frames: Recorded[] = [];
  sock.on("data", (chunk: Buffer) => {
    for (const f of parser.push(chunk)) {
      frames.push({ messageType: f.messageType, payload: f.payload });
    }
  });
  for (const out of outgoing) {
    sock.write(encodeFrame(out.messageType, out.payload));
  }
  await new Promise<void>((resolve) => setTimeout(resolve, collectMs));
  if (!opts.keepOpen) sock.destroy();
  return { frames, sock };
}

/** Mock VoiceSessionHandle that records every call + lets the test drive
 * the connection-side `conn.send` for emitting events. */
function mockFactory(): {
  factory: VoiceSessionFactory;
  spawned: Array<{
    conversationId: string;
    wakeWordPhrase: string;
    handle: VoiceSessionHandle;
    sent: Recorded[];
    inboundAudio: Array<{ chunk: Buffer; end: boolean }>;
    inboundEvents: Array<{ eventType: number; data: any[] }>;
    closes: string[];
  }>;
} {
  const spawned: ReturnType<typeof mockFactory>["spawned"] = [];
  const factory: VoiceSessionFactory = ({ conn, conversationId, wakeWordPhrase }) => {
    const record = {
      conversationId,
      wakeWordPhrase,
      handle: null as unknown as VoiceSessionHandle,
      sent: [] as Recorded[],
      inboundAudio: [] as Array<{ chunk: Buffer; end: boolean }>,
      inboundEvents: [] as Array<{ eventType: number; data: any[] }>,
      closes: [] as string[],
    };
    // Spy on conn.send so we can assert what the session writes to HA.
    const origSend = conn.send;
    conn.send = (messageType: number, payload: Buffer) => {
      record.sent.push({ messageType, payload });
      origSend(messageType, payload);
    };
    const handle: VoiceSessionHandle = {
      onInboundAudio(chunk, end) {
        record.inboundAudio.push({ chunk, end });
      },
      onInboundEvent(eventType, data) {
        record.inboundEvents.push({ eventType, data });
      },
      close(reason) {
        record.closes.push(reason);
      },
    };
    record.handle = handle;
    spawned.push(record);
    // Immediately emit RUN_START — same as production EsphomeVoiceSession does.
    conn.send(
      MessageType.VoiceAssistantEventResponse,
      buildVoiceAssistantEventResponse({ eventType: VoiceAssistantEvent.RUN_START }),
    );
    return handle;
  };
  return { factory, spawned };
}

test("end-to-end: VoiceAssistantRequest(start=true) → ACK + factory spawn + RUN_START", async () => {
  const identity = computeIdentity({ tenantSeed: "test-va" });
  const { factory, spawned } = mockFactory();
  const handle = startEsphomeServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    log: () => {},
    voiceSessionFactory: factory,
  });
  await handle.ready;
  const port = handle.boundPort();
  try {
    const subPayload = Buffer.concat([
      writeBoolField(1, true),
      writeUint32Field(2, 1), // VOICE_ASSISTANT_SUBSCRIBE_API_AUDIO
    ]);
    const startPayload = Buffer.concat([
      writeBoolField(1, true),
      writeStringField(2, "conv-123"),
      writeUint32Field(3, 0),
      writeStringField(5, "ok nabu"),
    ]);
    const { frames } = await exchange(port, [
      { messageType: MessageType.SubscribeVoiceAssistantRequest, payload: subPayload },
      { messageType: MessageType.VoiceAssistantRequest, payload: startPayload },
    ]);
    // Expected response order:
    //   VoiceAssistantResponse  (ACK from connection)
    //   VoiceAssistantEventResponse(RUN_START)  (emitted by mock factory)
    const types = frames.map((f) => f.messageType);
    assert.deepEqual(types, [
      MessageType.VoiceAssistantResponse,
      MessageType.VoiceAssistantEventResponse,
    ]);
    const ack = decodeFields(frames[0].payload);
    assert.equal(fieldAsUint(ack, 1), 0, "port=0 (API audio)");
    assert.equal(fieldAsBool(ack, 2), false, "error=false");
    const runStart = decodeFields(frames[1].payload);
    assert.equal(
      fieldAsUint(runStart, 1),
      VoiceAssistantEvent.RUN_START,
      "event_type=RUN_START",
    );
    // Factory was called with the conversation id + wake word phrase HA sent.
    assert.equal(spawned.length, 1, "factory invoked exactly once");
    assert.equal(spawned[0].conversationId, "conv-123");
    assert.equal(spawned[0].wakeWordPhrase, "ok nabu");
  } finally {
    await handle.close();
  }
});

test("end-to-end: VoiceAssistantAudio frame forwarded to session", async () => {
  const identity = computeIdentity({ tenantSeed: "test-audio-in" });
  const { factory, spawned } = mockFactory();
  const handle = startEsphomeServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    log: () => {},
    voiceSessionFactory: factory,
  });
  await handle.ready;
  const port = handle.boundPort();
  try {
    const startPayload = Buffer.concat([
      writeBoolField(1, true),
      writeStringField(2, "conv-audio"),
    ]);
    const audioPayload = Buffer.concat([
      writeBytesField(1, Buffer.from([0x10, 0x11, 0x12, 0x13])),
    ]);
    await exchange(port, [
      { messageType: MessageType.VoiceAssistantRequest, payload: startPayload },
      { messageType: MessageType.VoiceAssistantAudio, payload: audioPayload },
    ]);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].inboundAudio.length, 1, "one audio frame forwarded");
    assert.deepEqual(
      spawned[0].inboundAudio[0].chunk,
      Buffer.from([0x10, 0x11, 0x12, 0x13]),
    );
    assert.equal(spawned[0].inboundAudio[0].end, false);
  } finally {
    await handle.close();
  }
});

test("end-to-end: VoiceAssistantEventResponse(RUN_END) from HA closes the session", async () => {
  const identity = computeIdentity({ tenantSeed: "test-run-end" });
  const { factory, spawned } = mockFactory();
  const handle = startEsphomeServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    log: () => {},
    voiceSessionFactory: factory,
  });
  await handle.ready;
  const port = handle.boundPort();
  try {
    const startPayload = Buffer.concat([
      writeBoolField(1, true),
      writeStringField(2, "c"),
    ]);
    const runEndPayload = Buffer.concat([
      // event_type=2 (RUN_END) — but encoded explicitly so it survives the
      // default-omit rule on writeUint32Field.
      Buffer.from([(1 << 3) | 0]),
      Buffer.from([VoiceAssistantEvent.RUN_END]),
    ]);
    await exchange(port, [
      { messageType: MessageType.VoiceAssistantRequest, payload: startPayload },
      { messageType: MessageType.VoiceAssistantEventResponse, payload: runEndPayload },
    ]);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].inboundEvents.length, 1);
    assert.equal(spawned[0].inboundEvents[0].eventType, VoiceAssistantEvent.RUN_END);
    // The connection nulls its voiceSession on RUN_END but does NOT call
    // close() on the session — the session itself is responsible for that
    // via its own onInboundEvent handler in production. The mock here just
    // records the event.
  } finally {
    await handle.close();
  }
});

test("end-to-end: VoiceAssistantRequest(start=false) cancels in-flight session", async () => {
  const identity = computeIdentity({ tenantSeed: "test-cancel" });
  const { factory, spawned } = mockFactory();
  const handle = startEsphomeServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    log: () => {},
    voiceSessionFactory: factory,
  });
  await handle.ready;
  const port = handle.boundPort();
  try {
    const startPayload = Buffer.concat([
      writeBoolField(1, true),
      writeStringField(2, "c"),
    ]);
    // start=false omits field 1 (default-bool=false). We send an empty payload
    // which decodes to start=false.
    await exchange(port, [
      { messageType: MessageType.VoiceAssistantRequest, payload: startPayload },
      { messageType: MessageType.VoiceAssistantRequest, payload: EMPTY_PAYLOAD },
    ]);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].closes.length, 1, "close called on cancel");
    assert.equal(spawned[0].closes[0], "ha-cancelled");
  } finally {
    await handle.close();
  }
});

// ── §5-7 audio flow against a real EsphomeVoiceSession + mock OpenAI ────────
// These exercise the production session class end-to-end against a mock WS
// emulating OpenAI Realtime. They prove (a) instructions arrive on
// session.update with the RP-butler persona, (b) inbound ESPHome audio is
// resampled and forwarded as input_audio_buffer.append, (c) outbound
// response.output_audio.delta arrives back as VoiceAssistantAudio frames.

interface MockOpenAI {
  wss: WebSocketServer;
  port: number;
  /** Last session payload the client sent (initial pcmu + the pcm16 follow-up). */
  sessionUpdates: any[];
  /** input_audio_buffer.append events the client sent, in order. */
  inputAudio: string[];
  close: () => Promise<void>;
  /** Trigger a response.output_audio.delta event to the connected client. */
  emitAudioDelta: (base64Pcm: string) => void;
  /** Trigger response.done. */
  emitResponseDone: () => void;
  /** Trigger an OpenAI server-side speech_started event (barge-in). */
  emitSpeechStarted: () => void;
  /** Trigger the user-transcript event. */
  emitTranscript: (text: string) => void;
}

async function startMockOpenAI(): Promise<MockOpenAI> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  const sessionUpdates: any[] = [];
  const inputAudio: string[] = [];
  let connectedWs: any = null;
  wss.on("connection", (ws) => {
    connectedWs = ws;
    // 1. session.created
    ws.send(JSON.stringify({ type: "session.created", session: { id: "s_test" } }));
    ws.on("message", (raw: Buffer) => {
      const ev = JSON.parse(raw.toString());
      if (ev.type === "session.update") {
        sessionUpdates.push(ev);
        ws.send(JSON.stringify({ type: "session.updated", session: ev.session }));
      } else if (ev.type === "input_audio_buffer.append") {
        inputAudio.push(ev.audio);
      }
    });
  });
  return {
    wss,
    port,
    sessionUpdates,
    inputAudio,
    close: () =>
      new Promise((resolve, reject) =>
        wss.close((err) => (err ? reject(err) : resolve())),
      ),
    emitAudioDelta: (base64Pcm: string) => {
      if (connectedWs)
        connectedWs.send(
          JSON.stringify({ type: "response.output_audio.delta", delta: base64Pcm }),
        );
    },
    emitResponseDone: () => {
      if (connectedWs)
        connectedWs.send(
          JSON.stringify({ type: "response.done", response: { id: "r1" } }),
        );
    },
    emitSpeechStarted: () => {
      if (connectedWs)
        connectedWs.send(
          JSON.stringify({ type: "input_audio_buffer.speech_started" }),
        );
    },
    emitTranscript: (text: string) => {
      if (connectedWs)
        connectedWs.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.completed",
            transcript: text,
          }),
        );
    },
  };
}

test("EsphomeVoiceSession: session.update carries RP-butler persona", async () => {
  const mock = await startMockOpenAI();
  process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${mock.port}/`;
  // Single-VM mode bypasses tenant lookup — same path production uses.
  process.env.ENABLE_SINGLE_VM_MODE = "1";

  // Dynamic-import so the env settings above take effect.
  const { EsphomeVoiceSession } = await import("./esphome-session.js");

  const sent: Recorded[] = [];
  const session = new EsphomeVoiceSession({
    conversationId: "conv-persona",
    wakeWordPhrase: "alfred",
    flags: 0,
    conn: {
      identity: computeIdentity({ tenantSeed: "persona-test" }),
      log: () => {},
      send: (messageType: number, payload: Buffer) => {
        sent.push({ messageType, payload });
      },
    },
  });

  // Give the bridge time to: open WS → session.created → send session.update
  // → receive session.updated → send follow-up pcm16 session.update.
  await new Promise((r) => setTimeout(r, 600));

  // 2 session.updates expected: initial pcmu (from OpenAIRealtimeClient
  // default) + pcm16 follow-up from EsphomeVoiceSession.openBridge.
  assert.ok(
    mock.sessionUpdates.length >= 1,
    `expected ≥1 session.update, got ${mock.sessionUpdates.length}`,
  );
  const first = mock.sessionUpdates[0];
  assert.match(
    first.session.instructions,
    /Received Pronunciation/,
    "RP-butler persona must be in instructions",
  );
  assert.match(
    first.session.instructions,
    /Yes, sir/,
    "greeting line must be in instructions",
  );
  // RUN_START + (eventually) other events were emitted on the connection.
  assert.ok(
    sent.some(
      (s) =>
        s.messageType === MessageType.VoiceAssistantEventResponse &&
        decodeFields(s.payload)[1] === VoiceAssistantEvent.RUN_START,
    ),
    "RUN_START was not emitted on session open",
  );

  session.close("test-cleanup");
  await mock.close();
});

test("EsphomeVoiceSession: inbound PCM forwarded to OpenAI as resampled input_audio_buffer.append", async () => {
  const mock = await startMockOpenAI();
  process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${mock.port}/`;
  process.env.ENABLE_SINGLE_VM_MODE = "1";

  const { EsphomeVoiceSession } = await import("./esphome-session.js");

  const session = new EsphomeVoiceSession({
    conversationId: "conv-audio-fwd",
    wakeWordPhrase: "",
    flags: 0,
    conn: {
      identity: computeIdentity({ tenantSeed: "audio-fwd" }),
      log: () => {},
      send: () => {},
    },
  });

  // Wait for openBridge to finish.
  await new Promise((r) => setTimeout(r, 600));

  // 320 samples = 20 ms @ 16 kHz. We fill with a ramp so we can detect the
  // resampler ran (output should be 480 samples at 24 kHz).
  const inputBuf = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) inputBuf.writeInt16LE(i * 50, i * 2);
  session.onInboundAudio(inputBuf, false);

  await new Promise((r) => setTimeout(r, 100));
  assert.ok(mock.inputAudio.length >= 1, "no input_audio_buffer.append received");
  // base64-decode the forwarded audio — expect 480 samples (24 kHz, 20 ms).
  const decoded = Buffer.from(mock.inputAudio[0], "base64");
  assert.equal(
    decoded.length,
    960,
    `expected 960 bytes (480 samples @ 24 kHz), got ${decoded.length}`,
  );

  session.close("test-cleanup");
  await mock.close();
});

test("EsphomeVoiceSession: response.output_audio.delta arrives at HA as VoiceAssistantAudio frames", async () => {
  const mock = await startMockOpenAI();
  process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${mock.port}/`;
  process.env.ENABLE_SINGLE_VM_MODE = "1";

  const { EsphomeVoiceSession } = await import("./esphome-session.js");

  const sent: Recorded[] = [];
  const session = new EsphomeVoiceSession({
    conversationId: "conv-audio-back",
    wakeWordPhrase: "",
    flags: 0,
    conn: {
      identity: computeIdentity({ tenantSeed: "audio-back" }),
      log: () => {},
      send: (messageType: number, payload: Buffer) => {
        sent.push({ messageType, payload });
      },
    },
  });

  await new Promise((r) => setTimeout(r, 600));

  // 60 ms of audio @ 24 kHz pcm16 = 1440 samples = 2880 bytes. Resampled to
  // 16 kHz = 960 samples = 1920 bytes = three 20 ms (640-byte) frames out.
  const samples = 1440;
  const outPcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) outPcm.writeInt16LE(i, i * 2);
  mock.emitAudioDelta(outPcm.toString("base64"));

  await new Promise((r) => setTimeout(r, 150));

  // We expect:
  //   - one TTS_START event response
  //   - >=1 VoiceAssistantAudio frame
  const audioFrames = sent.filter(
    (s) => s.messageType === MessageType.VoiceAssistantAudio,
  );
  assert.ok(audioFrames.length >= 2, `expected ≥2 audio frames, got ${audioFrames.length}`);
  // Each full frame should carry 640 bytes (20 ms @ 16 kHz). The last may
  // carry the residue, but here 1920 bytes = exactly 3 × 640 so we expect 3.
  assert.equal(audioFrames.length, 3, "1920-byte output should chunk to 3 frames");
  for (const f of audioFrames) {
    const fields = decodeFields(f.payload);
    const dataField = fields[1];
    assert.ok(Buffer.isBuffer(dataField), "data field is a buffer");
    assert.equal(
      (dataField as Buffer).length,
      640,
      "each frame carries 640 bytes (20 ms @ 16 kHz)",
    );
  }
  const ttsStart = sent.find(
    (s) =>
      s.messageType === MessageType.VoiceAssistantEventResponse &&
      decodeFields(s.payload)[1] === VoiceAssistantEvent.TTS_START,
  );
  assert.ok(ttsStart, "TTS_START event was not emitted");

  session.close("test-cleanup");
  await mock.close();
});

test("EsphomeVoiceSession: speech_started triggers a clear() flush to HA", async () => {
  const mock = await startMockOpenAI();
  process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${mock.port}/`;
  process.env.ENABLE_SINGLE_VM_MODE = "1";

  const { EsphomeVoiceSession } = await import("./esphome-session.js");

  const sent: Recorded[] = [];
  const session = new EsphomeVoiceSession({
    conversationId: "conv-bargein",
    wakeWordPhrase: "",
    flags: 0,
    conn: {
      identity: computeIdentity({ tenantSeed: "bargein" }),
      log: () => {},
      send: (messageType: number, payload: Buffer) => {
        sent.push({ messageType, payload });
      },
    },
  });

  await new Promise((r) => setTimeout(r, 600));

  // Ship some output audio first, so the residue + ttsStartEmitted state
  // exist. Then fire speech_started → the session should ship a flush
  // VoiceAssistantAudio{data:<empty>, end:true}.
  const partial = Buffer.alloc(640); // 20 ms @ 24 kHz worth of zeroes
  mock.emitAudioDelta(partial.toString("base64"));
  await new Promise((r) => setTimeout(r, 50));

  const beforeFlush = sent.length;
  mock.emitSpeechStarted();
  await new Promise((r) => setTimeout(r, 100));

  // Look for the flush — an audio frame with data length 0 and end=true.
  const newFrames = sent.slice(beforeFlush);
  const flush = newFrames.find((s) => {
    if (s.messageType !== MessageType.VoiceAssistantAudio) return false;
    const fields = decodeFields(s.payload);
    const dataField = fields[1];
    const data = Buffer.isBuffer(dataField) ? dataField : Buffer.alloc(0);
    return data.length === 0 && fieldAsBool(fields, 2) === true;
  });
  assert.ok(flush, "expected an empty VoiceAssistantAudio{end:true} flush on speech_started");

  session.close("test-cleanup");
  await mock.close();
});

test("EsphomeVoiceSession: response.done emits TTS_END then RUN_END", async () => {
  const mock = await startMockOpenAI();
  process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${mock.port}/`;
  process.env.ENABLE_SINGLE_VM_MODE = "1";

  const { EsphomeVoiceSession } = await import("./esphome-session.js");

  const sent: Recorded[] = [];
  const session = new EsphomeVoiceSession({
    conversationId: "conv-done",
    wakeWordPhrase: "",
    flags: 0,
    conn: {
      identity: computeIdentity({ tenantSeed: "done" }),
      log: () => {},
      send: (messageType: number, payload: Buffer) => {
        sent.push({ messageType, payload });
      },
    },
  });
  await new Promise((r) => setTimeout(r, 600));

  mock.emitResponseDone();
  // RUN_END is gated by a 50 ms timeout in onTurnEnd to let HA drain.
  await new Promise((r) => setTimeout(r, 200));

  const events = sent
    .filter((s) => s.messageType === MessageType.VoiceAssistantEventResponse)
    .map((s) => decodeFields(s.payload)[1]);
  assert.ok(
    events.includes(VoiceAssistantEvent.TTS_END),
    "TTS_END event missing — was: " + JSON.stringify(events),
  );
  assert.ok(
    events.includes(VoiceAssistantEvent.RUN_END),
    "RUN_END event missing — was: " + JSON.stringify(events),
  );

  session.close("test-cleanup");
  await mock.close();
});

test("EsphomeVoiceSession: principal transcript emits STT_END with text", async () => {
  const mock = await startMockOpenAI();
  process.env.OPENAI_REALTIME_BASE_URL = `ws://127.0.0.1:${mock.port}/`;
  process.env.ENABLE_SINGLE_VM_MODE = "1";

  const { EsphomeVoiceSession } = await import("./esphome-session.js");

  const sent: Recorded[] = [];
  const session = new EsphomeVoiceSession({
    conversationId: "conv-transcript",
    wakeWordPhrase: "",
    flags: 0,
    conn: {
      identity: computeIdentity({ tenantSeed: "transcript" }),
      log: () => {},
      send: (messageType: number, payload: Buffer) => {
        sent.push({ messageType, payload });
      },
    },
  });
  await new Promise((r) => setTimeout(r, 600));

  mock.emitTranscript("What's on my calendar this evening?");
  await new Promise((r) => setTimeout(r, 80));

  const sttEnd = sent.find((s) => {
    if (s.messageType !== MessageType.VoiceAssistantEventResponse) return false;
    const fields = decodeFields(s.payload);
    return fieldAsUint(fields, 1) === VoiceAssistantEvent.STT_END;
  });
  assert.ok(sttEnd, "STT_END event was not emitted");
  // Decode the embedded data entries — should carry name="text", value=<transcript>.
  const fields = decodeFields(sttEnd!.payload);
  const sub = fields[2];
  const subs = Array.isArray(sub) ? sub : [sub];
  const firstSub = subs[0];
  assert.ok(Buffer.isBuffer(firstSub), "STT_END data sub-message present");
  const inner = decodeFields(firstSub as Buffer);
  assert.equal(fieldAsString(inner, 1), "text");
  assert.equal(fieldAsString(inner, 2), "What's on my calendar this evening?");

  session.close("test-cleanup");
  await mock.close();
});
