// esphome-protocol.ts — minimal hand-rolled codec for the ESPHome Native API.
//
// Wire shape (plaintext / unencrypted variant — leading byte 0x00):
//
//   <0x00> <varint payload_length> <varint message_type> <protobuf payload>
//
// We do NOT implement the noise-encrypted variant (leading byte 0x01); v1 of
// the HA Voice bridge relies on the tailnet boundary for confidentiality (see
// spec §5.5). The spec keeps the door open to a Noise_NNpsk0 variant in v2.
//
// We hand-roll the protobuf encoder/decoder for the small subset of messages
// PR1 needs because (a) bringing in a 5 MB protobuf lib for ~10 messages is
// overkill, (b) the ESPHome API .proto evolves slowly enough that pinning a
// hand-coded subset is cheaper than tracking schema drift, and (c) protobufjs
// adds zero value over manual varint encoding for our wire-shape needs.
//
// Reference: https://github.com/esphome/esphome/blob/dev/esphome/components/api/api.proto
//
// The protobuf encoding rules we implement:
//   - Each field is <tag = (field_number << 3) | wire_type> <value>.
//   - Wire types used here:
//       0  varint           — int32, uint32, bool, enum
//       1  fixed64          — (NOT used in PR1; reserved for sint64 fields)
//       2  length-delimited — string, bytes, repeated, embedded message
//       5  fixed32          — (NOT used in PR1)
//   - Strings are length-delimited UTF-8 bytes.
//   - Default values (0, false, "", []) are conventionally omitted on the
//     wire — the decoder must treat absent fields as defaults.
//   - We do NOT implement packed-repeated decoding for PR1 (no message uses it).
//
// Tests in test_esphome_server.test.ts assert round-trip correctness against
// hand-computed byte sequences for each PR1 message type.

// ── Message type IDs (subset for PR1) ────────────────────────────────────────
// IDs taken from upstream esphome/components/api/api.proto. The full list is
// large (~150 messages); we ship only what the connect+pair+idle flow needs.
export const MessageType = {
  HelloRequest: 1,
  HelloResponse: 2,
  ConnectRequest: 3,
  ConnectResponse: 4,
  DisconnectRequest: 5,
  DisconnectResponse: 6,
  PingRequest: 7,
  PingResponse: 8,
  DeviceInfoRequest: 9,
  DeviceInfoResponse: 10,
  ListEntitiesRequest: 11,
  ListEntitiesDoneResponse: 19,
  SubscribeStatesRequest: 20,
  // Voice-assistant entity declaration. PR1 advertises only this one entity
  // to satisfy the spec's "single voice_assistant component" minimum; the
  // media_player / button / sensor companions land in PR2.
  ListEntitiesVoiceAssistantResponse: 58,
  // ── Voice-assistant message flow (PR2 — audio bridge to OpenAI Realtime) ──
  // IDs taken verbatim from upstream esphome/components/api/api.proto. These
  // are the only messages PR2 needs; timer/announce/wake-word-config land in
  // later PRs (PR4 timers, PR5 announcements, PR6 wake words).
  //
  // Wire direction (per api.proto):
  //   SubscribeVoiceAssistantRequest (89)  — HA → us. HA asks to subscribe.
  //   VoiceAssistantRequest          (90)  — us → HA OR HA → us. The spec
  //     annotates this as SOURCE_SERVER (i.e. emitted by the firmware/device),
  //     but in our deployment HA's `voice_assistant` ESPHome integration uses
  //     it as the start-of-pipeline signal both ways. We accept it as inbound
  //     (HA → us) to trigger a Realtime turn — the satellite path. Sending
  //     it ourselves is reserved for the wake-word-on-bridge path (PR4).
  //   VoiceAssistantResponse         (91)  — us → HA. ACKs a start request
  //     and tells HA we're ready to receive audio in-band (port=0 = API_AUDIO).
  //   VoiceAssistantEventResponse    (92)  — us → HA. Pipeline progress events
  //     (RUN_START, STT_END, INTENT_END, TTS_END, RUN_END) so HA's UI can
  //     reflect "Alfred is thinking / speaking".
  //   VoiceAssistantAudio            (106) — bidirectional. PCM-16 mono @ 16 kHz.
  //
  // Wire is identical regardless of direction; the SOURCE_SERVER vs
  // SOURCE_CLIENT annotation is a serialization-side hint, not a wire-format
  // distinction.
  SubscribeVoiceAssistantRequest: 89,
  VoiceAssistantRequest: 90,
  VoiceAssistantResponse: 91,
  VoiceAssistantEventResponse: 92,
  VoiceAssistantAudio: 106,
} as const;

// Voice-assistant pipeline events. The set of event types HA's
// voice_assistant integration recognises — emitting an unknown event_type is
// silently ignored. We emit a minimal subset that's enough to drive HA's UI
// state without misrepresenting the OpenAI Realtime pipeline (we don't have
// distinct STT/intent/TTS stages — the realtime model collapses them — so we
// fire RUN_START → STT_END (with the user transcript) → TTS_START →
// TTS_END → RUN_END in one continuous block per turn).
export const VoiceAssistantEvent = {
  ERROR: 0,
  RUN_START: 1,
  RUN_END: 2,
  STT_START: 3,
  STT_END: 4,
  INTENT_START: 5,
  INTENT_END: 6,
  TTS_START: 7,
  TTS_END: 8,
} as const;

export type MessageTypeName = keyof typeof MessageType;

// Reverse map for diagnostics + framing.
export const MessageTypeById: Record<number, MessageTypeName> = Object.fromEntries(
  Object.entries(MessageType).map(([k, v]) => [v, k as MessageTypeName]),
);

// ── Varint encode / decode ───────────────────────────────────────────────────
// Standard protobuf varint: 7 bits per byte, MSB set if more bytes follow.
// We assume non-negative values throughout PR1 (no zigzag) — the ESPHome API
// only uses unsigned varints for the message-type and payload-length headers.

export function encodeVarint(value: number): Buffer {
  if (value < 0) throw new Error("varint values must be non-negative");
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error("varint values must be finite integers");
  }
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return Buffer.from(out);
}

// Decode a single varint starting at `offset` in `buf`. Returns the decoded
// value and the offset just past the last consumed byte. Throws if `buf`
// runs out before a terminating byte (MSB clear) is seen.
export function decodeVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return { value: value >>> 0, next: i };
    }
    shift += 7;
    if (shift >= 35) {
      throw new Error("varint too long (>5 bytes) — corrupt frame?");
    }
  }
  throw new Error("varint truncated — buffer ended mid-value");
}

// ── Frame encode / decode ────────────────────────────────────────────────────
// One framed message: 0x00 + varint(len) + varint(type) + payload[len].

export function encodeFrame(messageType: number, payload: Buffer): Buffer {
  const lenVarint = encodeVarint(payload.length);
  const typeVarint = encodeVarint(messageType);
  return Buffer.concat([Buffer.from([0x00]), lenVarint, typeVarint, payload]);
}

export interface DecodedFrame {
  messageType: number;
  payload: Buffer;
  bytesConsumed: number;
}

// Attempt to decode one frame from the start of `buf`. Returns null if the
// buffer does not yet contain a complete frame (caller should wait for more
// data and retry). Throws on a malformed preamble byte — that is a protocol
// violation, not a partial frame.
export function tryDecodeFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length === 0) return null;
  if (buf[0] !== 0x00) {
    if (buf[0] === 0x01) {
      // Noise-encrypted frame — we don't speak this in v1.
      throw new Error(
        "noise-encrypted ESPHome frame (0x01) received — voice-bridge v1 only speaks plaintext",
      );
    }
    throw new Error(`unexpected ESPHome frame preamble 0x${buf[0].toString(16).padStart(2, "0")}`);
  }
  try {
    const { value: payloadLen, next: afterLen } = decodeVarint(buf, 1);
    const { value: messageType, next: afterType } = decodeVarint(buf, afterLen);
    const payloadEnd = afterType + payloadLen;
    if (buf.length < payloadEnd) return null; // partial frame
    return {
      messageType,
      payload: buf.subarray(afterType, payloadEnd),
      bytesConsumed: payloadEnd,
    };
  } catch (err) {
    // Truncated varint in the header — partial frame, wait for more data.
    if (err instanceof Error && err.message.startsWith("varint truncated")) return null;
    throw err;
  }
}

// ── Protobuf field codec helpers ─────────────────────────────────────────────
// Each helper writes one field; the caller composes them into a payload.

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;

function tag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

export function writeUint32Field(fieldNumber: number, value: number): Buffer {
  if (value === 0) return Buffer.alloc(0); // default — omit
  return Buffer.concat([tag(fieldNumber, WIRE_VARINT), encodeVarint(value >>> 0)]);
}

export function writeBoolField(fieldNumber: number, value: boolean): Buffer {
  if (!value) return Buffer.alloc(0); // default — omit
  return Buffer.concat([tag(fieldNumber, WIRE_VARINT), encodeVarint(1)]);
}

export function writeStringField(fieldNumber: number, value: string): Buffer {
  if (value === "") return Buffer.alloc(0); // default — omit
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([
    tag(fieldNumber, WIRE_LENGTH_DELIMITED),
    encodeVarint(bytes.length),
    bytes,
  ]);
}

export function writeBytesField(fieldNumber: number, value: Buffer): Buffer {
  if (value.length === 0) return Buffer.alloc(0);
  return Buffer.concat([
    tag(fieldNumber, WIRE_LENGTH_DELIMITED),
    encodeVarint(value.length),
    value,
  ]);
}

/** Embedded-message field writer. Per the protobuf spec a sub-message is
 * length-delimited (same wire type as a string / bytes field), with the
 * payload being the serialised sub-message. Used for VoiceAssistantEventData
 * (repeated string-string pairs) inside VoiceAssistantEventResponse.
 *
 * Unlike writeBytesField we do NOT omit an empty submessage — a present-but-
 * empty submessage is meaningful (it asserts the field is set to its default
 * struct value). Callers that want "absent" should not call this. */
export function writeSubmessageField(
  fieldNumber: number,
  payload: Buffer,
): Buffer {
  return Buffer.concat([
    tag(fieldNumber, WIRE_LENGTH_DELIMITED),
    encodeVarint(payload.length),
    payload,
  ]);
}

// ── Generic field decoder ────────────────────────────────────────────────────
// Decodes a payload into a map of field-number → raw value. Wire types we
// understand:
//   varint → number
//   length-delimited → Buffer (caller decides string vs bytes vs sub-message)
// Unknown wire types throw; unknown field numbers are preserved (forward-compat).

export type DecodedFields = Record<number, number | Buffer | Array<number | Buffer>>;

export function decodeFields(payload: Buffer): DecodedFields {
  const out: DecodedFields = {};
  let offset = 0;
  while (offset < payload.length) {
    const { value: tagValue, next: afterTag } = decodeVarint(payload, offset);
    const fieldNumber = tagValue >>> 3;
    const wireType = tagValue & 0x07;
    offset = afterTag;

    let parsed: number | Buffer;
    if (wireType === WIRE_VARINT) {
      const { value, next } = decodeVarint(payload, offset);
      parsed = value;
      offset = next;
    } else if (wireType === WIRE_LENGTH_DELIMITED) {
      const { value: len, next: afterLen } = decodeVarint(payload, offset);
      parsed = payload.subarray(afterLen, afterLen + len);
      offset = afterLen + len;
    } else {
      throw new Error(
        `unsupported wire type ${wireType} for field ${fieldNumber} (PR1 codec only handles varint + length-delimited)`,
      );
    }

    const existing = out[fieldNumber];
    if (existing === undefined) {
      out[fieldNumber] = parsed;
    } else if (Array.isArray(existing)) {
      existing.push(parsed);
    } else {
      out[fieldNumber] = [existing, parsed];
    }
  }
  return out;
}

export function fieldAsString(fields: DecodedFields, fieldNumber: number): string {
  const v = fields[fieldNumber];
  if (v === undefined) return "";
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  throw new Error(`field ${fieldNumber} is not a string`);
}

export function fieldAsUint(fields: DecodedFields, fieldNumber: number): number {
  const v = fields[fieldNumber];
  if (v === undefined) return 0;
  if (typeof v === "number") return v;
  throw new Error(`field ${fieldNumber} is not a varint`);
}

export function fieldAsBool(fields: DecodedFields, fieldNumber: number): boolean {
  return fieldAsUint(fields, fieldNumber) !== 0;
}

// ── Stream parser ────────────────────────────────────────────────────────────
// One per TCP connection. Accumulates inbound bytes; yields complete frames
// as the buffer fills. The TCP layer can deliver partial frames or several
// frames in one chunk — this class smooths over both.

export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  // Append a chunk and return all newly-complete frames in arrival order.
  push(chunk: Buffer): DecodedFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: DecodedFrame[] = [];
    while (this.buffer.length > 0) {
      const frame = tryDecodeFrame(this.buffer);
      if (!frame) break; // partial — wait for more data
      frames.push(frame);
      this.buffer = this.buffer.subarray(frame.bytesConsumed);
    }
    return frames;
  }

  // Test helper — exposes pending bytes that haven't yet formed a complete
  // frame. Used to assert partial-frame handling in unit tests.
  pendingBytes(): number {
    return this.buffer.length;
  }
}
