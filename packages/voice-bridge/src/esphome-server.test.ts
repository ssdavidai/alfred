// esphome-server.test.ts — integration tests for the PR1 ESPHome Native API
// skeleton (issue #112). Verifies the wire-format codec round-trips cleanly
// and that a real TCP client can drive the connect-pair-idle handshake
// against the server end-to-end.
//
// Test surface (per spec §6 PR1 acceptance):
//   1. Server starts on a port (we use port 0 + boundPort() so tests don't
//      collide with a real :6053 listener).
//   2. HelloRequest → HelloResponse with apiVersionMajor=1, apiVersionMinor=10,
//      server_info populated, name="alfred-voice-bridge".
//   3. ConnectRequest → ConnectResponse(invalid_password=false) when no
//      password is configured; with-password path tested separately.
//   4. DeviceInfoRequest → DeviceInfoResponse with model="Alfred Voice Bridge",
//      friendly_name="Alfred", esphome_version="alfred-1.0".
//   5. PingRequest → PingResponse (empty payload).
//   6. ListEntitiesRequest → exactly one ListEntitiesVoiceAssistantResponse
//      followed by ListEntitiesDoneResponse.
//   7. Wire-format encode/decode round-trips for varints, frames, strings,
//      bools, and uint32 fields.
//
// Runs under `node --test`. Same dependency posture as openai-realtime.test.ts —
// just Node 22's builtin test runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";

// env must be set BEFORE importing config-bearing modules; the SUT does not
// read env at import time but its sibling config.ts does.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "sk-test-dummy";
process.env.VOICE_BRIDGE_INTERNAL_TOKEN =
  process.env.VOICE_BRIDGE_INTERNAL_TOKEN ?? "test-internal-token";

import {
  encodeVarint,
  decodeVarint,
  encodeFrame,
  tryDecodeFrame,
  FrameParser,
  decodeFields,
  fieldAsString,
  fieldAsUint,
  fieldAsBool,
  writeStringField,
  writeUint32Field,
  writeBoolField,
  MessageType,
} from "./esphome-protocol.js";
import {
  computeIdentity,
  buildHelloResponse,
  buildDeviceInfoResponse,
  buildListEntitiesVoiceAssistantResponse,
  startEsphomeServer,
  EMPTY_PAYLOAD,
} from "./esphome-server.js";

// ── wire-format round-trips ──────────────────────────────────────────────────

test("varint encode/decode round-trips for 0, 127, 128, 16384", () => {
  for (const v of [0, 1, 127, 128, 300, 16383, 16384, 16385, 1 << 28]) {
    const enc = encodeVarint(v);
    const dec = decodeVarint(enc, 0);
    assert.equal(dec.value, v, `value ${v} round-trip`);
    assert.equal(dec.next, enc.length, `value ${v} consumes all bytes`);
  }
});

test("varint encoding matches known protobuf bytes for sentinel values", () => {
  assert.deepEqual([...encodeVarint(0)], [0x00]);
  assert.deepEqual([...encodeVarint(1)], [0x01]);
  assert.deepEqual([...encodeVarint(127)], [0x7f]);
  // 128 = 0b1000_0000 → varint = 0x80 0x01
  assert.deepEqual([...encodeVarint(128)], [0x80, 0x01]);
  // 300 = 0b1_0010_1100 → 0xac 0x02
  assert.deepEqual([...encodeVarint(300)], [0xac, 0x02]);
});

test("varint rejects negative + non-integer values", () => {
  assert.throws(() => encodeVarint(-1), /non-negative/);
  assert.throws(() => encodeVarint(1.5), /finite integers/);
  assert.throws(() => encodeVarint(Infinity), /finite integers/);
});

test("varint decode rejects a 6-byte-long sequence (corrupt)", () => {
  // Six bytes all with high bit set = overflow — codec must reject.
  const bad = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.throws(() => decodeVarint(bad, 0), /too long/);
});

test("frame encode produces preamble + len + type + payload in order", () => {
  const payload = Buffer.from([0x10, 0x20, 0x30]);
  const frame = encodeFrame(0x07, payload);
  assert.equal(frame[0], 0x00, "preamble byte");
  assert.equal(frame[1], 3, "payload length");
  assert.equal(frame[2], 0x07, "message type");
  assert.deepEqual(frame.subarray(3), payload);
});

test("tryDecodeFrame returns null on partial input, full frame on completion", () => {
  const inner = Buffer.from([0xaa, 0xbb]);
  const frame = encodeFrame(MessageType.PingResponse, inner);
  // Partial — only first 2 bytes.
  assert.equal(tryDecodeFrame(frame.subarray(0, 2)), null);
  // Full.
  const decoded = tryDecodeFrame(frame);
  assert.ok(decoded);
  assert.equal(decoded.messageType, MessageType.PingResponse);
  assert.deepEqual(decoded.payload, inner);
  assert.equal(decoded.bytesConsumed, frame.length);
});

test("tryDecodeFrame rejects noise-encrypted (0x01) preamble", () => {
  const noise = Buffer.from([0x01, 0x00, 0x00]);
  assert.throws(() => tryDecodeFrame(noise), /noise-encrypted/);
});

test("FrameParser yields multiple frames from one chunk + handles split frames", () => {
  const parser = new FrameParser();
  const a = encodeFrame(MessageType.PingRequest, Buffer.alloc(0));
  const b = encodeFrame(MessageType.PingResponse, Buffer.from([0x05]));
  // Both in one push.
  let frames = parser.push(Buffer.concat([a, b]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].messageType, MessageType.PingRequest);
  assert.equal(frames[1].messageType, MessageType.PingResponse);
  assert.equal(parser.pendingBytes(), 0);

  // Now split a frame across two pushes.
  const c = encodeFrame(MessageType.HelloRequest, Buffer.from([0x10, 0x11, 0x12]));
  frames = parser.push(c.subarray(0, 2));
  assert.equal(frames.length, 0, "no frame yet on partial input");
  assert.equal(parser.pendingBytes(), 2);
  frames = parser.push(c.subarray(2));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].messageType, MessageType.HelloRequest);
  assert.equal(parser.pendingBytes(), 0);
});

test("field encoders skip default values + decode round-trip preserves set values", () => {
  // Build a fake payload with a mix of fields, decode, assert.
  const payload = Buffer.concat([
    writeUint32Field(1, 7),
    writeStringField(2, "hello"),
    writeBoolField(3, true),
    writeStringField(4, ""), // default → omitted
    writeUint32Field(5, 0), // default → omitted
    writeBoolField(6, false), // default → omitted
  ]);
  const fields = decodeFields(payload);
  assert.equal(fieldAsUint(fields, 1), 7);
  assert.equal(fieldAsString(fields, 2), "hello");
  assert.equal(fieldAsBool(fields, 3), true);
  // Defaults round-trip as zero values via the accessors.
  assert.equal(fieldAsString(fields, 4), "");
  assert.equal(fieldAsUint(fields, 5), 0);
  assert.equal(fieldAsBool(fields, 6), false);
});

// ── identity ─────────────────────────────────────────────────────────────────

test("computeIdentity produces a stable MAC from a fixed seed + LA bit set", () => {
  const id1 = computeIdentity({ tenantSeed: "fixed-seed" });
  const id2 = computeIdentity({ tenantSeed: "fixed-seed" });
  assert.equal(id1.macAddress, id2.macAddress, "same seed → same MAC");
  assert.match(id1.macAddress, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/);
  // First octet must have the locally-administered bit set (0x02) + unicast
  // (multicast bit clear).
  const firstOctet = parseInt(id1.macAddress.slice(0, 2), 16);
  assert.equal(firstOctet & 0x02, 0x02, "locally-administered bit");
  assert.equal(firstOctet & 0x01, 0x00, "unicast (multicast bit clear)");

  const id3 = computeIdentity({ tenantSeed: "different-seed" });
  assert.notEqual(id1.macAddress, id3.macAddress, "different seed → different MAC");
});

test("computeIdentity sets the spec-mandated identity fields", () => {
  const id = computeIdentity({ tenantSeed: "t1", friendlyName: "Alfred" });
  assert.equal(id.model, "Alfred Voice Bridge");
  assert.equal(id.name, "alfred-voice-bridge");
  assert.equal(id.esphomeVersion, "alfred-1.0");
  assert.equal(id.friendlyName, "Alfred");
  assert.equal(id.manufacturer, "Alfred Black");
  assert.equal(id.projectName, "alfred-black.voice-bridge");
});

// ── message builders (decode-self round-trip) ────────────────────────────────

test("buildHelloResponse round-trips through decodeFields", () => {
  const payload = buildHelloResponse({
    apiVersionMajor: 1,
    apiVersionMinor: 10,
    serverInfo: "Alfred Voice Bridge (alfred-1.0)",
    name: "alfred-voice-bridge",
  });
  const fields = decodeFields(payload);
  assert.equal(fieldAsUint(fields, 1), 1);
  assert.equal(fieldAsUint(fields, 2), 10);
  assert.equal(fieldAsString(fields, 3), "Alfred Voice Bridge (alfred-1.0)");
  assert.equal(fieldAsString(fields, 4), "alfred-voice-bridge");
});

test("buildDeviceInfoResponse encodes model + friendly_name + esphome_version", () => {
  const identity = computeIdentity({ tenantSeed: "t1" });
  const payload = buildDeviceInfoResponse({ usesPassword: false, identity });
  const fields = decodeFields(payload);
  // uses_password (1) omitted because false
  assert.equal(fieldAsBool(fields, 1), false);
  assert.equal(fieldAsString(fields, 2), "alfred-voice-bridge");
  assert.equal(fieldAsString(fields, 3), identity.macAddress);
  assert.equal(fieldAsString(fields, 4), "alfred-1.0");
  assert.equal(fieldAsString(fields, 6), "Alfred Voice Bridge");
  assert.equal(fieldAsBool(fields, 7), false); // has_deep_sleep
  assert.equal(fieldAsString(fields, 8), "alfred-black.voice-bridge");
  assert.equal(fieldAsString(fields, 12), "Alfred Black");
  assert.equal(fieldAsString(fields, 13), "Alfred");
});

test("buildListEntitiesVoiceAssistantResponse encodes object_id + key + name", () => {
  const payload = buildListEntitiesVoiceAssistantResponse({
    objectId: "alfred_voice_assistant",
    key: 0x12345678,
    name: "Alfred",
    uniqueId: "alfred-voice-bridge_voice_assistant",
  });
  const fields = decodeFields(payload);
  assert.equal(fieldAsString(fields, 1), "alfred_voice_assistant");
  assert.equal(fieldAsUint(fields, 2), 0x12345678);
  assert.equal(fieldAsString(fields, 3), "Alfred");
  assert.equal(fieldAsString(fields, 4), "alfred-voice-bridge_voice_assistant");
});

// ── end-to-end TCP server ────────────────────────────────────────────────────

// Helper — connect to the server, write some frames, collect frames the server
// sends back, then close. Returns the frames in receive order.
async function exchange(
  port: number,
  outgoing: Array<{ messageType: number; payload: Buffer }>,
  opts: { collectMs?: number } = {},
): Promise<Array<{ messageType: number; payload: Buffer }>> {
  const collectMs = opts.collectMs ?? 200;
  const sock = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  const parser = new FrameParser();
  const received: Array<{ messageType: number; payload: Buffer }> = [];
  sock.on("data", (chunk: Buffer) => {
    for (const f of parser.push(chunk)) {
      received.push({ messageType: f.messageType, payload: f.payload });
    }
  });
  for (const out of outgoing) {
    sock.write(encodeFrame(out.messageType, out.payload));
  }
  await new Promise<void>((resolve) => setTimeout(resolve, collectMs));
  sock.destroy();
  return received;
}

test("end-to-end: HelloRequest → HelloResponse on a real TCP connection", async () => {
  const identity = computeIdentity({ tenantSeed: "test-tenant" });
  const handle = startEsphomeServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    log: () => {}, // quiet test logs
  });
  await handle.ready;
  const port = handle.boundPort();

  try {
    const helloPayload = Buffer.concat([
      writeStringField(1, "ha-test-client"),
      writeUint32Field(2, 1),
      writeUint32Field(3, 10),
    ]);
    const frames = await exchange(port, [
      { messageType: MessageType.HelloRequest, payload: helloPayload },
    ]);
    assert.equal(frames.length, 1, "exactly one HelloResponse");
    assert.equal(frames[0].messageType, MessageType.HelloResponse);
    const fields = decodeFields(frames[0].payload);
    assert.equal(fieldAsUint(fields, 1), 1, "api_version_major");
    assert.equal(fieldAsUint(fields, 2), 10, "api_version_minor");
    assert.match(fieldAsString(fields, 3), /Alfred Voice Bridge/, "server_info");
    assert.equal(fieldAsString(fields, 4), "alfred-voice-bridge", "name");
  } finally {
    await handle.close();
  }
});

test("end-to-end: ConnectRequest with empty password succeeds (PR1 default)", async () => {
  const identity = computeIdentity({ tenantSeed: "test-tenant" });
  const handle = startEsphomeServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    log: () => {},
  });
  await handle.ready;
  const port = handle.boundPort();

  try {
    const frames = await exchange(port, [
      // ConnectRequest with no password set on the server — payload is empty,
      // matches HA's behaviour when the user leaves the password field blank
      // in the integration config flow.
      { messageType: MessageType.ConnectRequest, payload: EMPTY_PAYLOAD },
    ]);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].messageType, MessageType.ConnectResponse);
    const fields = decodeFields(frames[0].payload);
    // invalid_password (1) omitted from the wire because false — accessor
    // returns false on omitted fields by design.
    assert.equal(fieldAsBool(fields, 1), false);
  } finally {
    await handle.close();
  }
});

test("end-to-end: ConnectRequest with wrong password returns invalid_password=true", async () => {
  const identity = computeIdentity({ tenantSeed: "test-tenant" });
  const handle = startEsphomeServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    password: "secret-token",
    log: () => {},
  });
  await handle.ready;
  const port = handle.boundPort();

  try {
    const wrongPwPayload = writeStringField(1, "wrong-password");
    const frames = await exchange(port, [
      { messageType: MessageType.ConnectRequest, payload: wrongPwPayload },
    ]);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].messageType, MessageType.ConnectResponse);
    const fields = decodeFields(frames[0].payload);
    assert.equal(fieldAsBool(fields, 1), true, "invalid_password must be true");
  } finally {
    await handle.close();
  }
});

test("end-to-end: DeviceInfoRequest returns model + friendly_name + mac", async () => {
  const identity = computeIdentity({ tenantSeed: "test-tenant-A" });
  const handle = startEsphomeServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    log: () => {},
  });
  await handle.ready;
  const port = handle.boundPort();

  try {
    const frames = await exchange(port, [
      { messageType: MessageType.DeviceInfoRequest, payload: EMPTY_PAYLOAD },
    ]);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].messageType, MessageType.DeviceInfoResponse);
    const fields = decodeFields(frames[0].payload);
    assert.equal(fieldAsString(fields, 2), "alfred-voice-bridge", "name");
    assert.equal(fieldAsString(fields, 3), identity.macAddress, "mac");
    assert.equal(fieldAsString(fields, 4), "alfred-1.0", "esphome_version");
    assert.equal(fieldAsString(fields, 6), "Alfred Voice Bridge", "model");
    assert.equal(fieldAsString(fields, 12), "Alfred Black", "manufacturer");
    assert.equal(fieldAsString(fields, 13), "Alfred", "friendly_name");
  } finally {
    await handle.close();
  }
});

test("end-to-end: PingRequest returns PingResponse (keepalive)", async () => {
  const identity = computeIdentity({ tenantSeed: "test-tenant" });
  const handle = startEsphomeServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    log: () => {},
  });
  await handle.ready;
  const port = handle.boundPort();

  try {
    const frames = await exchange(port, [
      { messageType: MessageType.PingRequest, payload: EMPTY_PAYLOAD },
    ]);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].messageType, MessageType.PingResponse);
    assert.equal(frames[0].payload.length, 0, "PingResponse is empty");
  } finally {
    await handle.close();
  }
});

test("end-to-end: ListEntitiesRequest returns voice_assistant + done", async () => {
  const identity = computeIdentity({ tenantSeed: "test-tenant" });
  const handle = startEsphomeServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    log: () => {},
  });
  await handle.ready;
  const port = handle.boundPort();

  try {
    const frames = await exchange(port, [
      { messageType: MessageType.ListEntitiesRequest, payload: EMPTY_PAYLOAD },
    ]);
    // Expected: exactly 2 — one voice_assistant entity + done.
    assert.equal(frames.length, 2, "two frames: voice_assistant + done");
    assert.equal(frames[0].messageType, MessageType.ListEntitiesVoiceAssistantResponse);
    const va = decodeFields(frames[0].payload);
    assert.equal(fieldAsString(va, 1), "alfred_voice_assistant", "object_id");
    assert.ok(fieldAsUint(va, 2) > 0, "key is non-zero");
    assert.equal(fieldAsString(va, 3), "Alfred", "name");
    assert.equal(frames[1].messageType, MessageType.ListEntitiesDoneResponse);
    assert.equal(frames[1].payload.length, 0, "done payload is empty");
  } finally {
    await handle.close();
  }
});

test("end-to-end: full handshake sequence Hello → Connect → DeviceInfo → ListEntities → Ping", async () => {
  const identity = computeIdentity({ tenantSeed: "test-handshake" });
  const handle = startEsphomeServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    log: () => {},
  });
  await handle.ready;
  const port = handle.boundPort();

  try {
    const helloPayload = Buffer.concat([
      writeStringField(1, "aioesphomeapi"),
      writeUint32Field(2, 1),
      writeUint32Field(3, 10),
    ]);
    const frames = await exchange(
      port,
      [
        { messageType: MessageType.HelloRequest, payload: helloPayload },
        { messageType: MessageType.ConnectRequest, payload: EMPTY_PAYLOAD },
        { messageType: MessageType.DeviceInfoRequest, payload: EMPTY_PAYLOAD },
        { messageType: MessageType.ListEntitiesRequest, payload: EMPTY_PAYLOAD },
        { messageType: MessageType.SubscribeStatesRequest, payload: EMPTY_PAYLOAD },
        { messageType: MessageType.PingRequest, payload: EMPTY_PAYLOAD },
      ],
      { collectMs: 300 },
    );

    // Expect: HelloResponse, ConnectResponse, DeviceInfoResponse,
    // ListEntitiesVoiceAssistantResponse, ListEntitiesDoneResponse, PingResponse.
    // SubscribeStatesRequest does NOT produce a response in PR1 (no entity
    // state to push yet).
    const types = frames.map((f) => f.messageType);
    assert.deepEqual(
      types,
      [
        MessageType.HelloResponse,
        MessageType.ConnectResponse,
        MessageType.DeviceInfoResponse,
        MessageType.ListEntitiesVoiceAssistantResponse,
        MessageType.ListEntitiesDoneResponse,
        MessageType.PingResponse,
      ],
      "full PR1 handshake produces the expected response sequence",
    );
  } finally {
    await handle.close();
  }
});

test("end-to-end: unknown message type is ignored (forward compat)", async () => {
  // Future ESPHome releases add new message types; PR1 must not disconnect on
  // them — that would make HA upgrades break voice-bridge silently.
  const identity = computeIdentity({ tenantSeed: "test-tenant" });
  const handle = startEsphomeServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity,
    log: () => {},
  });
  await handle.ready;
  const port = handle.boundPort();

  try {
    const frames = await exchange(port, [
      // A made-up message type. The server should log + ignore.
      { messageType: 9999, payload: Buffer.from([0x42]) },
      // Follow-up Ping must still work — i.e. the connection wasn't dropped.
      { messageType: MessageType.PingRequest, payload: EMPTY_PAYLOAD },
    ]);
    assert.equal(frames.length, 1, "only PingResponse is returned");
    assert.equal(frames[0].messageType, MessageType.PingResponse);
  } finally {
    await handle.close();
  }
});
