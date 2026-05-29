// wyoming-server.test.ts — coverage for the Wyoming Protocol fallback
// (#112 PR5). The Wyoming spec lives at https://github.com/rhasspy/wyoming;
// we exercise the subset HA's `wyoming` integration calls into a satellite
// service:
//
//   1.  Encoder round-trips through the parser (event-only, no payload)
//   2.  Encoder round-trips through the parser (event + binary payload)
//   3.  Parser handles split frames across TCP chunks
//   4.  `describe` triggers an `info` reply with the right service shape
//   5.  `audio-start` → `audio-chunk` x N → `audio-stop` ends the session
//   6.  `audio-chunk` arriving before `audio-start` triggers a Wyoming error
//      event (NOT a silent drop). This deviates from the upstream spec —
//      Wyoming's reference impl drops silently. We surface it so HA's
//      misconfigured pipelines are visible in the operator-facing log
//      stream. Documented in the test name + this comment.
//   7.  `synthesize` is rejected with a typed error (we're a satellite, not
//      a TTS). HA gracefully falls back to its other configured TTS.
//   8.  The brain emitting `VoiceAssistantAudio` (PR2 wire) translates to
//      `audio-start` → `audio-chunk` → `audio-stop` on the Wyoming socket.
//   9.  Parser rejects a header that isn't JSON (protocol violation).
//   10. `lastHandshakeAt` updates after the first inbound frame.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

// env must be set BEFORE importing config-bearing modules; the SUT does not
// read env at import time but its sibling config.ts does.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "sk-test-dummy";
process.env.VOICE_BRIDGE_INTERNAL_TOKEN =
  process.env.VOICE_BRIDGE_INTERNAL_TOKEN ?? "test-internal-token";

import {
  encodeWyomingEvent,
  WyomingFrameParser,
  WyomingEventType,
  buildWyomingInfo,
  startWyomingServer,
  type WyomingEvent,
} from "./wyoming-server.js";
import {
  computeIdentity,
  buildVoiceAssistantAudio,
  buildVoiceAssistantEventResponse,
  type VoiceSessionConnection,
  type VoiceSessionHandle,
} from "./esphome-server.js";
import { MessageType, VoiceAssistantEvent } from "./esphome-protocol.js";

// ── Encoder / parser round-trips ─────────────────────────────────────────

test("wyoming: encoder/parser round-trip for a header-only event", () => {
  const wire = encodeWyomingEvent({ type: WyomingEventType.Describe });
  const parser = new WyomingFrameParser();
  const events = parser.push(wire);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, WyomingEventType.Describe);
  assert.equal(events[0].payload, undefined);
  assert.equal(parser.pendingBytes(), 0);
});

test("wyoming: encoder/parser round-trip for an event with binary payload", () => {
  const audio = Buffer.from([0x01, 0x02, 0x03, 0x04, 0xff, 0x7f]);
  const wire = encodeWyomingEvent({
    type: WyomingEventType.AudioChunk,
    data: { rate: 16000, width: 2, channels: 1 },
    payload: audio,
  });
  const parser = new WyomingFrameParser();
  const events = parser.push(wire);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, WyomingEventType.AudioChunk);
  assert.ok(events[0].payload);
  assert.deepEqual(Array.from(events[0].payload!), Array.from(audio));
  const data = events[0].data as { rate: number; width: number; channels: number };
  assert.equal(data.rate, 16000);
  assert.equal(data.width, 2);
  assert.equal(data.channels, 1);
});

test("wyoming: parser yields events across split TCP chunks", () => {
  const e1 = encodeWyomingEvent({ type: WyomingEventType.Describe });
  const e2 = encodeWyomingEvent({
    type: WyomingEventType.AudioStart,
    data: { rate: 16000, width: 2, channels: 1 },
  });
  const all = Buffer.concat([e1, e2]);
  const parser = new WyomingFrameParser();
  // Split mid-header to exercise the partial-header branch.
  const split = 10;
  const events1 = parser.push(all.subarray(0, split));
  const events2 = parser.push(all.subarray(split));
  const combined = [...events1, ...events2];
  assert.equal(combined.length, 2);
  assert.equal(combined[0].type, WyomingEventType.Describe);
  assert.equal(combined[1].type, WyomingEventType.AudioStart);
  assert.equal(parser.pendingBytes(), 0);
});

test("wyoming: parser rejects a non-JSON header", () => {
  const parser = new WyomingFrameParser();
  const bad = Buffer.from("not-valid-json\n", "utf-8");
  assert.throws(
    () => parser.push(bad),
    /not valid JSON/,
  );
});

// ── Info response ────────────────────────────────────────────────────────

test("wyoming: info response advertises a satellite with 16 kHz pcm16 mono", () => {
  const identity = computeIdentity({ tenantSeed: "wyoming-test-A" });
  const info = buildWyomingInfo({ identity });
  assert.ok(info.satellite, "satellite section present");
  const sat = info.satellite as Record<string, unknown>;
  assert.equal(sat.installed, true);
  assert.equal((sat.snd_format as { rate: number }).rate, 16000);
  assert.equal((sat.mic_format as { rate: number }).rate, 16000);
  assert.equal((sat.snd_format as { width: number }).width, 2);
  assert.equal((sat.mic_format as { channels: number }).channels, 1);
  assert.equal(sat.name, identity.friendlyName);
});

// ── End-to-end: drive a real socket ──────────────────────────────────────

// Helper — open a TCP connection to a Wyoming server, send events, collect
// the reply within `collectMs`. Same shape as esphome-server.test.ts's
// `exchange()`.
async function exchange(
  port: number,
  outgoing: WyomingEvent[],
  opts: { collectMs?: number } = {},
): Promise<WyomingEvent[]> {
  const collectMs = opts.collectMs ?? 200;
  const sock = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  const parser = new WyomingFrameParser();
  const received: WyomingEvent[] = [];
  sock.on("data", (chunk: Buffer) => {
    for (const e of parser.push(chunk)) received.push(e);
  });
  for (const out of outgoing) sock.write(encodeWyomingEvent(out));
  await new Promise<void>((resolve) => setTimeout(resolve, collectMs));
  sock.destroy();
  return received;
}

function makeRecordingSession(
  capture: { inbound: Array<{ data: Buffer; end: boolean }>; closed: string[] },
): VoiceSessionHandle & { _emit: (mt: number, p: Buffer) => void } {
  // We need access to the connection hook so we can simulate the brain
  // emitting outbound frames. The factory we register below captures it
  // into `connRef` and the test calls it through `session._emit`.
  return {
    onInboundAudio(chunk: Buffer, end: boolean) {
      capture.inbound.push({ data: Buffer.from(chunk), end });
    },
    onInboundEvent() {
      /* no-op for these tests */
    },
    close(reason: string) {
      capture.closed.push(reason);
    },
    _emit() {
      /* set by factory below */
    },
  };
}

test("wyoming: audio-start → audio-chunk* → audio-stop drives a session end-to-end", async () => {
  const identity = computeIdentity({ tenantSeed: "wyoming-test-B" });
  const capture = { inbound: [] as Array<{ data: Buffer; end: boolean }>, closed: [] as string[] };
  const handle = startWyomingServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    voiceSessionFactory: () => makeRecordingSession(capture),
    log: () => {},
  });
  await handle.ready;
  const port = handle.boundPort();

  try {
    const chunk1 = Buffer.alloc(640, 0x10);
    const chunk2 = Buffer.alloc(640, 0x20);
    await exchange(
      port,
      [
        {
          type: WyomingEventType.AudioStart,
          data: { rate: 16000, width: 2, channels: 1 },
        },
        {
          type: WyomingEventType.AudioChunk,
          data: { rate: 16000, width: 2, channels: 1 },
          payload: chunk1,
        },
        {
          type: WyomingEventType.AudioChunk,
          data: { rate: 16000, width: 2, channels: 1 },
          payload: chunk2,
        },
        { type: WyomingEventType.AudioStop, data: { timestamp: 1 } },
      ],
      { collectMs: 250 },
    );
    // After audio-stop, the session must have observed exactly 3 inbound
    // calls (two chunks + one end-of-mic marker).
    assert.equal(capture.inbound.length, 3, "two chunks + one end-mic call");
    assert.equal(capture.inbound[0].data.length, 640);
    assert.equal(capture.inbound[1].data.length, 640);
    assert.equal(capture.inbound[2].end, true);
    assert.equal(capture.inbound[2].data.length, 0);
  } finally {
    await handle.close();
  }
});

test("wyoming: audio-chunk without audio-start emits an error event (PR5 deviation)", async () => {
  const identity = computeIdentity({ tenantSeed: "wyoming-test-C" });
  const handle = startWyomingServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    voiceSessionFactory: () =>
      makeRecordingSession({ inbound: [], closed: [] }),
    log: () => {},
  });
  await handle.ready;
  const port = handle.boundPort();
  try {
    const replies = await exchange(
      port,
      [
        {
          type: WyomingEventType.AudioChunk,
          data: { rate: 16000, width: 2, channels: 1 },
          payload: Buffer.alloc(640),
        },
      ],
      { collectMs: 150 },
    );
    // Should see exactly one `error` event with the no-active-session code.
    const errors = replies.filter((e) => e.type === WyomingEventType.Error);
    assert.equal(errors.length, 1, "exactly one error event");
    const data = errors[0].data as { code: string };
    assert.equal(data.code, "no-active-session");
  } finally {
    await handle.close();
  }
});

test("wyoming: synthesize is rejected with tts-not-supported", async () => {
  const identity = computeIdentity({ tenantSeed: "wyoming-test-D" });
  const handle = startWyomingServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    voiceSessionFactory: () =>
      makeRecordingSession({ inbound: [], closed: [] }),
    log: () => {},
  });
  await handle.ready;
  const port = handle.boundPort();
  try {
    const replies = await exchange(
      port,
      [
        {
          type: WyomingEventType.Synthesize,
          data: { text: "the rain in spain stays mainly in the plain" },
        },
      ],
      { collectMs: 150 },
    );
    const errors = replies.filter((e) => e.type === WyomingEventType.Error);
    assert.equal(errors.length, 1);
    const data = errors[0].data as { code: string };
    assert.equal(data.code, "tts-not-supported");
  } finally {
    await handle.close();
  }
});

test("wyoming: describe triggers an info reply with satellite shape", async () => {
  const identity = computeIdentity({ tenantSeed: "wyoming-test-E" });
  const handle = startWyomingServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    voiceSessionFactory: () =>
      makeRecordingSession({ inbound: [], closed: [] }),
    log: () => {},
  });
  await handle.ready;
  const port = handle.boundPort();
  try {
    const replies = await exchange(
      port,
      [{ type: WyomingEventType.Describe }],
      { collectMs: 150 },
    );
    const infos = replies.filter((e) => e.type === WyomingEventType.Info);
    assert.equal(infos.length, 1, "exactly one info reply");
    const data = infos[0].data as { satellite: { name: string; installed: boolean } };
    assert.ok(data.satellite, "info carries a satellite section");
    assert.equal(data.satellite.name, identity.friendlyName);
    assert.equal(data.satellite.installed, true);
  } finally {
    await handle.close();
  }
});

test("wyoming: brain emitting VoiceAssistantAudio translates to audio-start + audio-chunk + audio-stop", async () => {
  // This test uses a factory that captures the connection hook so we can
  // pretend to be the brain emitting outbound frames.
  const identity = computeIdentity({ tenantSeed: "wyoming-test-F" });
  // Wrapped in a holder so the closure assignment doesn't get narrowed
  // to `never` by TS's control-flow analysis across the await boundaries.
  const captured: { conn: VoiceSessionConnection | null } = { conn: null };
  const handle = startWyomingServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    voiceSessionFactory: ({ conn }) => {
      captured.conn = conn;
      return {
        onInboundAudio() {
          /* no-op */
        },
        onInboundEvent() {
          /* no-op */
        },
        close() {
          /* no-op */
        },
      };
    },
    log: () => {},
  });
  await handle.ready;
  const port = handle.boundPort();
  try {
    // Open the connection + collect outbound events.
    const sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
    const parser = new WyomingFrameParser();
    const replies: WyomingEvent[] = [];
    sock.on("data", (c: Buffer) => {
      for (const e of parser.push(c)) replies.push(e);
    });
    // Trigger session open by sending audio-start.
    sock.write(
      encodeWyomingEvent({
        type: WyomingEventType.AudioStart,
        data: { rate: 16000, width: 2, channels: 1 },
      }),
    );
    // Wait briefly for the factory to fire.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(captured.conn, "connection hook captured");

    // Brain emits one TTS chunk + one end frame.
    const ttsChunk = Buffer.alloc(640, 0x42);
    captured.conn!.send(
      MessageType.VoiceAssistantAudio,
      buildVoiceAssistantAudio({ data: ttsChunk, end: false }),
    );
    captured.conn!.send(
      MessageType.VoiceAssistantAudio,
      buildVoiceAssistantAudio({ data: Buffer.alloc(0), end: true }),
    );
    await new Promise((r) => setTimeout(r, 100));

    sock.destroy();

    const audioStarts = replies.filter(
      (e) => e.type === WyomingEventType.AudioStart,
    );
    const audioChunks = replies.filter(
      (e) => e.type === WyomingEventType.AudioChunk,
    );
    const audioStops = replies.filter(
      (e) => e.type === WyomingEventType.AudioStop,
    );
    assert.equal(audioStarts.length, 1, "exactly one outbound audio-start");
    assert.equal(audioChunks.length, 1, "exactly one outbound audio-chunk");
    assert.equal(audioStops.length, 1, "exactly one outbound audio-stop");
    assert.deepEqual(
      Array.from(audioChunks[0].payload!),
      Array.from(ttsChunk),
      "tts chunk arrives byte-exact",
    );
  } finally {
    await handle.close();
  }
});

test("wyoming: brain STT_END event maps to a Wyoming transcript event", async () => {
  const identity = computeIdentity({ tenantSeed: "wyoming-test-G" });
  const captured: { conn: VoiceSessionConnection | null } = { conn: null };
  const handle = startWyomingServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    voiceSessionFactory: ({ conn }) => {
      captured.conn = conn;
      return {
        onInboundAudio() {
          /* no-op */
        },
        onInboundEvent() {
          /* no-op */
        },
        close() {
          /* no-op */
        },
      };
    },
    log: () => {},
  });
  await handle.ready;
  const port = handle.boundPort();
  try {
    const sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
    const parser = new WyomingFrameParser();
    const replies: WyomingEvent[] = [];
    sock.on("data", (c: Buffer) => {
      for (const e of parser.push(c)) replies.push(e);
    });
    sock.write(
      encodeWyomingEvent({
        type: WyomingEventType.AudioStart,
        data: { rate: 16000, width: 2, channels: 1 },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(captured.conn);
    captured.conn!.send(
      MessageType.VoiceAssistantEventResponse,
      buildVoiceAssistantEventResponse({
        eventType: VoiceAssistantEvent.STT_END,
        data: [{ name: "text", value: "what is on my desk today" }],
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    sock.destroy();

    const transcripts = replies.filter(
      (e) => e.type === WyomingEventType.Transcript,
    );
    assert.equal(transcripts.length, 1, "exactly one transcript event");
    const data = transcripts[0].data as { text: string };
    assert.equal(data.text, "what is on my desk today");
  } finally {
    await handle.close();
  }
});

test("wyoming: lastHandshakeAt updates after the first frame on a connection", async () => {
  const identity = computeIdentity({ tenantSeed: "wyoming-test-H" });
  const handle = startWyomingServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    voiceSessionFactory: () =>
      makeRecordingSession({ inbound: [], closed: [] }),
    log: () => {},
  });
  await handle.ready;
  const port = handle.boundPort();
  try {
    const before = handle.lastHandshakeAt();
    await exchange(
      port,
      [{ type: WyomingEventType.Describe }],
      { collectMs: 150 },
    );
    const after = handle.lastHandshakeAt();
    assert.ok(after !== null, "lastHandshakeAt is set after a frame arrives");
    if (before !== null) {
      assert.ok(after! >= before, "handshake time advances monotonically");
    }
  } finally {
    await handle.close();
  }
});
