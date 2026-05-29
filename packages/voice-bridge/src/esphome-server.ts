// esphome-server.ts — TCP listener that speaks the ESPHome Native API.
//
// PR1 scope (per docs/specs/issue-112-voice-via-ha.md §6):
//   - Accept TCP connections on :6053.
//   - Plaintext (0x00) framing only — noise (0x01) is out of scope for v1.
//   - HelloRequest → HelloResponse
//   - ConnectRequest → ConnectResponse (auth optional; PR1 ships unauth'd
//     per spec §5.5 — the HA_VOICE_API_TOKEN lane lands with #111's
//     channel_tokens table in PR2).
//   - DeviceInfoRequest → DeviceInfoResponse advertising
//     "Alfred Voice Bridge", deterministic per-tenant MAC, esphome_version
//     "alfred-1.0".
//   - ListEntitiesRequest → one ListEntitiesVoiceAssistantResponse +
//     ListEntitiesDoneResponse. The media_player / button / sensor companions
//     land in PR2.
//   - SubscribeStatesRequest → mark subscribed and idle (no entity state to
//     push in PR1 — the voice_assistant entity is stateless on the wire).
//   - PingRequest → PingResponse keepalive.
//
// EXPLICITLY NOT in PR1: voice_assistant audio flow (PR2/PR3), OpenAI bridge
// (PR3), MCP tools (PR6), per-area budget (PR7).
//
// To HA's ESPHome integration the result is a discoverable "Alfred Voice
// Bridge" device that pairs cleanly and lists one (unavailable-until-PR2)
// voice_assistant entity.

import net from "node:net";
import crypto from "node:crypto";
import os from "node:os";
import {
  MessageType,
  MessageTypeById,
  FrameParser,
  encodeFrame,
  decodeFields,
  fieldAsString,
  fieldAsUint,
  writeBoolField,
  writeStringField,
  writeUint32Field,
} from "./esphome-protocol.js";

// ── Identity ─────────────────────────────────────────────────────────────────
// HA's ESPHome integration keys devices by MAC. For real ESP32s that's the
// hardware MAC; for voice-bridge we hash the tenant id (or hostname when no
// tenant is configured) into a stable, locally-administered MAC. This means a
// re-deploy of the same tenant re-pairs without HA seeing a new device.

export interface EsphomeServerIdentity {
  /** Free-form device name surfaced in HA discovery. e.g. "Alfred". */
  friendlyName: string;
  /** Short object-id-style name, lowercase + safe for HA's slug rules. */
  name: string;
  /** Pinned esphome version string. We use "alfred-1.0" so HA never tries to OTA-upgrade us. */
  esphomeVersion: string;
  /** Lower-case `aa:bb:cc:dd:ee:ff`, derived from a stable seed. */
  macAddress: string;
  /** "alfred-voice-bridge" — the device model HA shows in the UI. */
  model: string;
  /** "Alfred Black" — manufacturer string in HA. */
  manufacturer: string;
  /** Project namespace (mDNS TXT `project_name`). */
  projectName: string;
  /** Pinned project version (mDNS TXT `project_version`). */
  projectVersion: string;
}

export function computeIdentity(opts: { tenantSeed?: string; friendlyName?: string }): EsphomeServerIdentity {
  const seed = opts.tenantSeed && opts.tenantSeed.length > 0 ? opts.tenantSeed : os.hostname();
  // SHA-256 of the seed, lower 6 bytes, set the locally-administered bit (0x02)
  // and clear the multicast bit (0x01) on the first octet — same trick the
  // ESPHome firmware uses for soft-MACs.
  const digest = crypto.createHash("sha256").update(`alfred-voice-bridge:${seed}`).digest();
  const macBytes = [
    (digest[0] & 0xfc) | 0x02,
    digest[1],
    digest[2],
    digest[3],
    digest[4],
    digest[5],
  ];
  const macAddress = macBytes.map((b) => b.toString(16).padStart(2, "0")).join(":");
  return {
    friendlyName: opts.friendlyName ?? "Alfred",
    name: "alfred-voice-bridge",
    esphomeVersion: "alfred-1.0",
    macAddress,
    model: "Alfred Voice Bridge",
    manufacturer: "Alfred Black",
    projectName: "alfred-black.voice-bridge",
    projectVersion: "1.0.0",
  };
}

// ── Message builders ─────────────────────────────────────────────────────────
// One helper per message. Field numbers come straight from
// esphome/components/api/api.proto. Default values are conventionally omitted
// on the wire (see esphome-protocol.ts) — our writers do this automatically.

export function buildHelloResponse(opts: {
  apiVersionMajor: number;
  apiVersionMinor: number;
  serverInfo: string;
  name: string;
}): Buffer {
  return Buffer.concat([
    writeUint32Field(1, opts.apiVersionMajor),
    writeUint32Field(2, opts.apiVersionMinor),
    writeStringField(3, opts.serverInfo),
    writeStringField(4, opts.name),
  ]);
}

export function buildConnectResponse(invalidPassword: boolean): Buffer {
  return writeBoolField(1, invalidPassword);
}

export function buildDeviceInfoResponse(opts: {
  usesPassword: boolean;
  identity: EsphomeServerIdentity;
}): Buffer {
  const { identity } = opts;
  return Buffer.concat([
    writeBoolField(1, opts.usesPassword),
    writeStringField(2, identity.name),
    writeStringField(3, identity.macAddress),
    writeStringField(4, identity.esphomeVersion),
    // compilation_time (5) — left empty; HA tolerates "".
    writeStringField(6, identity.model),
    writeBoolField(7, false), // has_deep_sleep = false (we never sleep)
    writeStringField(8, identity.projectName),
    writeStringField(9, identity.projectVersion),
    // webserver_port (10) — 0; we don't expose one.
    // legacy_bluetooth_proxy_version (11) — 0.
    writeStringField(12, identity.manufacturer),
    writeStringField(13, identity.friendlyName),
  ]);
}

export function buildListEntitiesVoiceAssistantResponse(opts: {
  objectId: string;
  key: number;
  name: string;
  uniqueId: string;
}): Buffer {
  return Buffer.concat([
    writeStringField(1, opts.objectId),
    writeUint32Field(2, opts.key),
    writeStringField(3, opts.name),
    writeStringField(4, opts.uniqueId),
    // disabled_by_default (5) = false
    // icon (6) = ""
    // entity_category (7) = 0 (NONE)
  ]);
}

// Empty-payload messages — PingResponse, DisconnectResponse,
// ListEntitiesDoneResponse all encode as a frame with a zero-length payload.
export const EMPTY_PAYLOAD = Buffer.alloc(0);

// ── Per-connection session ───────────────────────────────────────────────────

export interface EsphomeServerOptions {
  identity: EsphomeServerIdentity;
  /** When non-empty, ConnectRequest.password must match. PR1 ships empty. */
  password?: string;
  /** Logger override for tests. */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface SessionState {
  helloSeen: boolean;
  connected: boolean;
  authorized: boolean;
  subscribedStates: boolean;
}

function defaultLog(msg: string, extra?: Record<string, unknown>): void {
  if (extra) console.log(`[esphome] ${msg}`, extra);
  else console.log(`[esphome] ${msg}`);
}

export class EsphomeConnection {
  private parser = new FrameParser();
  private state: SessionState = {
    helloSeen: false,
    connected: false,
    authorized: false,
    subscribedStates: false,
  };

  constructor(
    private readonly socket: net.Socket,
    private readonly opts: EsphomeServerOptions,
  ) {
    const remote = socket.remoteAddress ?? "?";
    const log = opts.log ?? defaultLog;
    log("connection accepted", { remote });
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (err) => log("socket error", { remote, err: err.message }));
    socket.on("close", () => log("connection closed", { remote }));
  }

  private send(messageType: number, payload: Buffer): void {
    if (this.socket.destroyed) return;
    const frame = encodeFrame(messageType, payload);
    this.socket.write(frame);
  }

  private onData(chunk: Buffer): void {
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      const log = this.opts.log ?? defaultLog;
      log("frame parse error — closing connection", {
        err: err instanceof Error ? err.message : String(err),
      });
      this.socket.destroy();
      return;
    }
    for (const frame of frames) {
      this.handleFrame(frame.messageType, frame.payload);
    }
  }

  private handleFrame(messageType: number, payload: Buffer): void {
    const log = this.opts.log ?? defaultLog;
    const typeName = MessageTypeById[messageType] ?? `unknown(${messageType})`;

    // Order matters: HelloRequest must come first per the ESPHome handshake.
    // We're lenient — log + ignore unknown messages rather than disconnect —
    // because the ESPHome API evolves and dropping connections on every new
    // message type would make us brittle to HA upgrades.
    switch (messageType) {
      case MessageType.HelloRequest: {
        const fields = decodeFields(payload);
        const clientInfo = fieldAsString(fields, 1);
        log("HelloRequest", {
          clientInfo,
          clientMajor: fieldAsUint(fields, 2),
          clientMinor: fieldAsUint(fields, 3),
        });
        this.state.helloSeen = true;
        const resp = buildHelloResponse({
          // We advertise API 1.10 — matches what aioesphomeapi expects from
          // current HA Core. Anything newer would risk HA trying to use
          // features we don't implement; anything older drops voice_assistant.
          apiVersionMajor: 1,
          apiVersionMinor: 10,
          serverInfo: `${this.opts.identity.model} (${this.opts.identity.esphomeVersion})`,
          name: this.opts.identity.name,
        });
        this.send(MessageType.HelloResponse, resp);
        return;
      }
      case MessageType.ConnectRequest: {
        const fields = decodeFields(payload);
        const password = fieldAsString(fields, 1);
        const requirePassword = !!this.opts.password && this.opts.password.length > 0;
        const invalid = requirePassword && password !== this.opts.password;
        log("ConnectRequest", { requirePassword, invalid });
        this.send(MessageType.ConnectResponse, buildConnectResponse(invalid));
        if (!invalid) {
          this.state.connected = true;
          this.state.authorized = true;
        }
        return;
      }
      case MessageType.DisconnectRequest: {
        log("DisconnectRequest");
        this.send(MessageType.DisconnectResponse, EMPTY_PAYLOAD);
        this.socket.end();
        return;
      }
      case MessageType.PingRequest: {
        this.send(MessageType.PingResponse, EMPTY_PAYLOAD);
        return;
      }
      case MessageType.DeviceInfoRequest: {
        log("DeviceInfoRequest");
        const resp = buildDeviceInfoResponse({
          usesPassword: !!this.opts.password && this.opts.password.length > 0,
          identity: this.opts.identity,
        });
        this.send(MessageType.DeviceInfoResponse, resp);
        return;
      }
      case MessageType.ListEntitiesRequest: {
        log("ListEntitiesRequest");
        // PR1 advertises exactly one voice_assistant entity. The wider entity
        // set (media_player, button, sensor) lands in PR2 when we wire
        // SubscribeVoiceAssistantRequest.
        this.send(
          MessageType.ListEntitiesVoiceAssistantResponse,
          buildListEntitiesVoiceAssistantResponse({
            objectId: "alfred_voice_assistant",
            // The `key` field is a stable per-entity uint32 HA uses to address
            // state updates. We use a hash of the object_id so re-deploys of
            // the same identity yield the same key.
            key: stableEntityKey("alfred_voice_assistant", this.opts.identity.macAddress),
            name: "Alfred",
            uniqueId: `${this.opts.identity.name}_voice_assistant`,
          }),
        );
        this.send(MessageType.ListEntitiesDoneResponse, EMPTY_PAYLOAD);
        return;
      }
      case MessageType.SubscribeStatesRequest: {
        log("SubscribeStatesRequest");
        // PR1 has no entity state to push (voice_assistant carries no state
        // before SubscribeVoiceAssistantRequest, which lands in PR2). HA's
        // ESPHome integration tolerates a quiet stream — it expects deltas,
        // not heartbeats — so we simply mark ourselves subscribed and idle.
        this.state.subscribedStates = true;
        return;
      }
      default: {
        log("unhandled message (ignored)", { typeName, messageType });
        return;
      }
    }
  }
}

// ── Server bootstrap ─────────────────────────────────────────────────────────

export interface StartEsphomeServerOptions {
  port: number;
  bindHost: string;
  identity: EsphomeServerIdentity;
  password?: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface EsphomeServerHandle {
  server: net.Server;
  /** Resolves when the listener is bound. */
  ready: Promise<void>;
  /** Resolved port after bind — useful when port=0 in tests. */
  boundPort(): number;
  close(): Promise<void>;
}

export function startEsphomeServer(opts: StartEsphomeServerOptions): EsphomeServerHandle {
  const log = opts.log ?? defaultLog;
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    new EsphomeConnection(socket, {
      identity: opts.identity,
      password: opts.password,
      log: opts.log,
    });
  });
  server.on("error", (err) => log("server error", { err: err.message }));

  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.bindHost, () => {
      server.removeListener("error", reject);
      log(`ESPHome Native API listening on ${opts.bindHost}:${opts.port}`);
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
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function stableEntityKey(objectId: string, macAddress: string): number {
  const digest = crypto.createHash("sha256").update(`${macAddress}|${objectId}`).digest();
  // Lower 31 bits — HA's protobuf decoder treats this as a uint32; keep MSB
  // clear so we never collide with the varint-encoding sign-bit ambiguity.
  return (
    ((digest[0] & 0x7f) << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]
  ) >>> 0;
}
