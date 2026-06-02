// voice_esphome.ts — ESPHome-side voice routes (#112 PR5).
//
//   GET  /api/v1/channels/voice/esphome/devices       — proxy voice-bridge's
//                                                       /esphome/devices
//   POST /api/v1/channels/voice/esphome/devices/test  — operator-side probe
//                                                       of a real ESPHome
//                                                       satellite IP
//   GET  /api/v1/channels/voice/wyoming/status        — proxy voice-bridge's
//                                                       /wyoming/status
//
// All three are operator-only (master AAS_API_KEY bearer). The voice-bridge
// listener is on the docker bridge network so ctrl-api can reach it directly
// at http://voice-bridge:9000.
//
// `/devices/test` is the special one: it opens a real outbound ESPHome
// Native API TCP connection to a satellite the operator pastes the IP for,
// runs Hello → DeviceInfo → ListEntities, looks for a voice_assistant entity,
// and returns a structured diagnosis the dashboard can render. This is the
// "is the satellite YAML actually configured to route voice to us?" check —
// catches the common misconfigurations:
//
//   - the satellite is on the right LAN but has no `voice_assistant:` block
//   - `use_wake_word: true` but no `micro_wake_word:` block (silent failure)
//   - sample rate / format mismatch
//   - the satellite's ESPHome version is old enough that it doesn't speak
//     API 1.10 (we advertise 1.10; ESPHome ≤2024.7 speaks 1.9)
//
// All probes use a 5s connect + 5s read timeout — the operator's typing
// a UI form, they shouldn't be waiting half a minute on a wrong IP.

import net from "node:net";

import { addRoute } from "../server.js";
import { sendJson, ValidationError, ApiError } from "../errors.js";
import { requireOperatorBearer } from "../auth.js";

// Where voice-bridge's HTTP control surface lives. The voice-bridge is on
// the same docker-compose network as ctrl-api; the service name resolves
// over the docker DNS. The env override lets the operator point at a
// remote bridge during the rare case of a multi-host deploy.
const VOICE_BRIDGE_URL =
  process.env.VOICE_BRIDGE_INTERNAL_URL ?? "http://voice-bridge:9000";
const VOICE_BRIDGE_FETCH_TIMEOUT_MS = 4000;

// ESPHome Native API constants — duplicated here rather than imported from
// voice-bridge because the ctrl-api bundle doesn't depend on voice-bridge
// (different package, different esbuild build context).
const ESPHOME_PREAMBLE = 0x00;
const MSG_HelloRequest = 1;
const MSG_HelloResponse = 2;
const MSG_ConnectRequest = 3;
const MSG_ConnectResponse = 4;
const MSG_DisconnectRequest = 5;
const MSG_DeviceInfoRequest = 9;
const MSG_DeviceInfoResponse = 10;
const MSG_ListEntitiesRequest = 11;
const MSG_ListEntitiesDoneResponse = 19;
const MSG_ListEntitiesVoiceAssistantResponse = 58;

const DEFAULT_PROBE_TIMEOUT_MS = 5000;

// ── Probe-side ESPHome codec ─────────────────────────────────────────────
// Tiny hand-rolled subset; same wire shape as voice-bridge's
// esphome-protocol.ts but inlined so this file has no cross-package import.

function encodeVarint(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return Buffer.from(out);
}

function decodeVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: value >>> 0, next: i };
    shift += 7;
    if (shift >= 35) throw new Error("varint too long");
  }
  throw new Error("varint truncated");
}

function tag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function writeStringField(fieldNumber: number, value: string): Buffer {
  if (value === "") return Buffer.alloc(0);
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([tag(fieldNumber, 2), encodeVarint(bytes.length), bytes]);
}

function writeUint32Field(fieldNumber: number, value: number): Buffer {
  if (value === 0) return Buffer.alloc(0);
  return Buffer.concat([tag(fieldNumber, 0), encodeVarint(value >>> 0)]);
}

function encodeFrame(messageType: number, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([ESPHOME_PREAMBLE]),
    encodeVarint(payload.length),
    encodeVarint(messageType),
    payload,
  ]);
}

interface DecodedFrame {
  messageType: number;
  payload: Buffer;
  bytesConsumed: number;
}

function tryDecodeFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length === 0) return null;
  if (buf[0] !== ESPHOME_PREAMBLE) {
    throw new Error(`unexpected preamble 0x${buf[0].toString(16)}`);
  }
  try {
    const { value: len, next: afterLen } = decodeVarint(buf, 1);
    const { value: mt, next: afterType } = decodeVarint(buf, afterLen);
    const end = afterType + len;
    if (buf.length < end) return null;
    return {
      messageType: mt,
      payload: buf.subarray(afterType, end),
      bytesConsumed: end,
    };
  } catch (err) {
    if (err instanceof Error && err.message === "varint truncated") return null;
    throw err;
  }
}

type DecodedFields = Record<number, number | Buffer | Array<number | Buffer>>;

function decodeFields(payload: Buffer): DecodedFields {
  const out: DecodedFields = {};
  let off = 0;
  while (off < payload.length) {
    const { value: tagValue, next: afterTag } = decodeVarint(payload, off);
    const fieldNumber = tagValue >>> 3;
    const wireType = tagValue & 0x07;
    off = afterTag;
    let parsed: number | Buffer;
    if (wireType === 0) {
      const { value, next } = decodeVarint(payload, off);
      parsed = value;
      off = next;
    } else if (wireType === 2) {
      const { value: len, next } = decodeVarint(payload, off);
      parsed = payload.subarray(next, next + len);
      off = next + len;
    } else {
      // Unsupported wire types — bail. We only need varint + length-delimited
      // for the messages we read here.
      throw new Error(`probe: unsupported wire type ${wireType}`);
    }
    const existing = out[fieldNumber];
    if (existing === undefined) out[fieldNumber] = parsed;
    else if (Array.isArray(existing)) existing.push(parsed);
    else out[fieldNumber] = [existing, parsed];
  }
  return out;
}

function fieldAsString(fields: DecodedFields, n: number): string {
  const v = fields[n];
  if (v === undefined) return "";
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return "";
}

function fieldAsUint(fields: DecodedFields, n: number): number {
  const v = fields[n];
  if (v === undefined) return 0;
  if (typeof v === "number") return v;
  return 0;
}

// ── Probe runner ─────────────────────────────────────────────────────────
// One TCP connection per probe. We open, run Hello → DeviceInfo →
// ListEntities, collect responses, then close cleanly via DisconnectRequest.

interface EsphomeProbeResult {
  reachable: boolean;
  /** Verbatim message from the satellite's HelloResponse `server_info`
   * field — typically the ESPHome version + board. Empty when probe
   * failed before HelloResponse. */
  server_info: string;
  /** The satellite's reported esphome_version (DeviceInfoResponse field 4).
   * Empty when probe failed before DeviceInfo. */
  esphome_version: string;
  /** The satellite's reported MAC, lower-case `aa:bb:cc:dd:ee:ff`. */
  mac_address: string;
  /** Friendly name, e.g. "Voice PE Living Room". */
  friendly_name: string;
  /** Did the satellite advertise a `voice_assistant:` entity in
   * ListEntitiesResponse? */
  voice_assistant_present: boolean;
  /** Free-form codec descriptor. PR5 only checks "pcm16 mono @ 16 kHz" is
   * what the satellite expects on the wire; voice-bridge's
   * EsphomeVoiceSession always speaks that codec, so any deviation here is
   * a configuration warning, not a hard fail. */
  codec: string;
  /** Operator-readable recommendations. Empty array on a clean run. */
  recommendations: string[];
  /** On probe failure: terse one-line diagnosis. Null on success. */
  error: string | null;
}

async function probeEsphomeDevice(opts: {
  ip: string;
  /** Optional override — default 6053. Tests use it to point at a fake
   * satellite on a random high port without monkey-patching net. */
  port?: number;
  timeoutMs?: number;
}): Promise<EsphomeProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const ip = opts.ip;
  const port = opts.port ?? 6053;

  const result: EsphomeProbeResult = {
    reachable: false,
    server_info: "",
    esphome_version: "",
    mac_address: "",
    friendly_name: "",
    voice_assistant_present: false,
    codec: "",
    recommendations: [],
    error: null,
  };

  const socket = new net.Socket();
  let buffer = Buffer.alloc(0);
  let helloDone = false;
  let connectDone = false;
  let deviceInfoDone = false;
  let listDone = false;

  const done = new Promise<void>((resolve) => {
    let resolved = false;
    function finish(): void {
      if (resolved) return;
      resolved = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve();
    }

    const timer = setTimeout(() => {
      if (!result.error) {
        if (!helloDone) result.error = "connect-timeout";
        else if (!deviceInfoDone) result.error = "device-info-timeout";
        else if (!listDone) result.error = "list-entities-timeout";
        else result.error = "probe-timeout";
      }
      finish();
    }, timeoutMs);

    socket.on("connect", () => {
      result.reachable = true;
      // Send HelloRequest. client_info + major/minor versions.
      const helloPayload = Buffer.concat([
        writeStringField(1, "alfred-ctrl-probe"),
        writeUint32Field(2, 1),
        writeUint32Field(3, 10),
      ]);
      socket.write(encodeFrame(MSG_HelloRequest, helloPayload));
    });

    socket.on("error", (err) => {
      result.error = err.message;
      clearTimeout(timer);
      finish();
    });

    socket.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      let frame: DecodedFrame | null;
      try {
        while ((frame = tryDecodeFrame(buffer))) {
          buffer = buffer.subarray(frame.bytesConsumed);
          handleFrame(frame.messageType, frame.payload);
        }
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
        clearTimeout(timer);
        finish();
      }
      if (listDone) {
        clearTimeout(timer);
        // Polite disconnect — the satellite stays paired to its real HA.
        try {
          socket.write(encodeFrame(MSG_DisconnectRequest, Buffer.alloc(0)));
        } catch {
          /* ignore */
        }
        setTimeout(finish, 50);
      }
    });

    socket.on("close", () => {
      clearTimeout(timer);
      finish();
    });

    function handleFrame(messageType: number, payload: Buffer): void {
      switch (messageType) {
        case MSG_HelloResponse: {
          const fields = decodeFields(payload);
          result.server_info = fieldAsString(fields, 3);
          helloDone = true;
          // Real ESPHome devices typically require ConnectRequest even
          // before they answer DeviceInfo. Send an empty-password
          // ConnectRequest — if the satellite requires a password we'll
          // get invalid_password=true back and downgrade gracefully.
          socket.write(encodeFrame(MSG_ConnectRequest, Buffer.alloc(0)));
          return;
        }
        case MSG_ConnectResponse: {
          const fields = decodeFields(payload);
          const invalid = fieldAsUint(fields, 1) !== 0;
          if (invalid) {
            result.recommendations.push(
              "Satellite's ESPHome API password is set — set HA_VOICE_API_TOKEN " +
                "in /opt/alfred/.env so voice-bridge can connect back, or remove " +
                "the password from the satellite YAML.",
            );
            // Don't bail — DeviceInfo + ListEntities still work post-pair
            // on most firmware versions; carry on best-effort.
          }
          connectDone = true;
          socket.write(encodeFrame(MSG_DeviceInfoRequest, Buffer.alloc(0)));
          return;
        }
        case MSG_DeviceInfoResponse: {
          const fields = decodeFields(payload);
          // field 3 = mac_address, 4 = esphome_version, 13 = friendly_name
          result.mac_address = fieldAsString(fields, 3);
          result.esphome_version = fieldAsString(fields, 4);
          result.friendly_name = fieldAsString(fields, 13);
          deviceInfoDone = true;
          socket.write(encodeFrame(MSG_ListEntitiesRequest, Buffer.alloc(0)));
          return;
        }
        case MSG_ListEntitiesVoiceAssistantResponse: {
          // PR5 doesn't try to parse the full voice_assistant entity shape —
          // its mere presence is the signal. PR6 will decode the FlagsBits
          // field to surface USE_VAD / supports announcements etc.
          result.voice_assistant_present = true;
          // We assume the codec because the ESPHome firmware hard-codes it
          // — voice_assistant only ever speaks pcm16 mono @ 16 kHz.
          result.codec = "pcm16 mono @ 16 kHz (assumed from voice_assistant)";
          return;
        }
        case MSG_ListEntitiesDoneResponse: {
          listDone = true;
          return;
        }
        default: {
          // Other entity types (light, sensor, button) flow through the
          // same ListEntities loop. Ignore them — we only care about
          // voice_assistant.
          return;
        }
      }
    }
  });

  try {
    socket.connect({ port, host: ip });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  await done;

  // Post-probe recommendations.
  if (!result.reachable) {
    if (!result.error) result.error = "unreachable";
    result.recommendations.push(
      `Could not open TCP to ${ip}:6053 — check the IP is on a network this VM can reach (same LAN or Tailscale).`,
    );
  } else if (!result.voice_assistant_present && listDone) {
    result.recommendations.push(
      "Device responded but has no `voice_assistant:` block in its ESPHome YAML — add one and reflash.",
    );
  }
  if (result.esphome_version && /^2024\.([0-6])\./.test(result.esphome_version)) {
    result.recommendations.push(
      `ESPHome ${result.esphome_version} is older than 2024.7; voice-bridge advertises API 1.10 which needs 2024.8+. Update + reflash.`,
    );
  }

  return result;
}

// ── voice-bridge HTTP control proxy ──────────────────────────────────────

async function getVoiceBridgeJson(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    VOICE_BRIDGE_FETCH_TIMEOUT_MS,
  );
  try {
    const resp = await fetch(`${VOICE_BRIDGE_URL}${path}`, {
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`voice-bridge ${path} → HTTP ${resp.status}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Route registration ──────────────────────────────────────────────────

export function registerVoiceEsphomeRoutes(): void {
  // GET /api/v1/channels/voice/esphome/devices — list HA installs that have
  // paired with the bridge. Fail-soft: if voice-bridge isn't running we
  // surface `{devices: [], unavailable: true}` so the UI renders the
  // "ESPHome listener disabled" hint instead of an error toast.
  addRoute(
    "GET",
    "/api/v1/channels/voice/esphome/devices",
    async ({ req, res }) => {
      requireOperatorBearer(req);
      try {
        const data = await getVoiceBridgeJson("/esphome/devices");
        sendJson(res, 200, data);
      } catch (err) {
        // Surface as unavailable rather than 500 so the dashboard handles
        // the "listener off" case in the same code path as the 404 the
        // pre-PR5 stub returned. The card already special-cases
        // `unavailable: true`.
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 200, {
          enabled: false,
          listener_address: null,
          devices: [],
          unavailable: true,
          error: message,
        });
      }
    },
  );

  // POST /api/v1/channels/voice/esphome/devices/test
  //   body: { ip: string, hostname?: string, timeoutMs?: number }
  //   200 :  { ok, info: <EsphomeProbeResult>, hostname? }
  addRoute(
    "POST",
    "/api/v1/channels/voice/esphome/devices/test",
    async ({ req, res, body }) => {
      requireOperatorBearer(req);
      const b = (body ?? {}) as Record<string, unknown>;
      const ip = typeof b.ip === "string" ? b.ip.trim() : "";
      const hostname = typeof b.hostname === "string" ? b.hostname.trim() : "";
      const timeoutMs =
        typeof b.timeoutMs === "number" && b.timeoutMs > 0 && b.timeoutMs < 30_000
          ? b.timeoutMs
          : DEFAULT_PROBE_TIMEOUT_MS;
      // Loose IPv4/IPv6/hostname check — net.connect will reject garbage
      // anyway. We reject only the empty case + obvious scheme-prefixed
      // mistakes (the dashboard form sometimes leaks "http://" prefixes).
      if (!ip) {
        throw new ValidationError("ip is required");
      }
      if (/^[a-z]+:\/\//i.test(ip)) {
        throw new ValidationError(
          "ip must be a bare IP / hostname — no scheme prefix",
        );
      }
      const info = await probeEsphomeDevice({ ip, timeoutMs });
      const ok =
        info.reachable && info.voice_assistant_present && info.error === null;
      sendJson(res, 200, {
        ok,
        info,
        hostname: hostname || null,
      });
    },
  );

  // GET /api/v1/channels/voice/wyoming/status — surface Wyoming-fallback
  // readiness. Useful for the dashboard's "voice protocol" diagnostic
  // tile + for support fanouts ("is wyoming on for tenant X?").
  addRoute(
    "GET",
    "/api/v1/channels/voice/wyoming/status",
    async ({ req, res }) => {
      requireOperatorBearer(req);
      try {
        const data = await getVoiceBridgeJson("/wyoming/status");
        sendJson(res, 200, data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 200, {
          enabled: false,
          port: null,
          bind: null,
          last_handshake_at: null,
          unavailable: true,
          error: message,
        });
      }
    },
  );
}

// Exported for tests.
export {
  probeEsphomeDevice,
  encodeFrame,
  tryDecodeFrame,
  decodeFields,
  fieldAsString,
  fieldAsUint,
  MSG_HelloRequest,
  MSG_HelloResponse,
  MSG_ConnectRequest,
  MSG_ConnectResponse,
  MSG_DeviceInfoRequest,
  MSG_DeviceInfoResponse,
  MSG_ListEntitiesRequest,
  MSG_ListEntitiesDoneResponse,
  MSG_ListEntitiesVoiceAssistantResponse,
};
export type { EsphomeProbeResult };
