// voice_esphome.test.ts — coverage for /api/v1/channels/voice/esphome/*
// (#112 PR5). Same shape as channels_ha_pr1.test.ts: stub out the network
// surface (here, a fake ESPHome satellite over TCP), drive the route
// handlers in-process via `matchRoute`, assert on the parsed response.
//
// Coverage:
//   1. probeEsphomeDevice — happy path against a fake satellite that
//      advertises a voice_assistant entity. `voice_assistant_present:true`,
//      no recommendations, ok:true.
//   2. probeEsphomeDevice — satellite responds but has NO voice_assistant
//      entity → ok:false + the "no voice_assistant: block" recommendation.
//   3. probeEsphomeDevice — satellite IP is closed (TCP refused) →
//      reachable:false + the unreachable recommendation.
//   4. probeEsphomeDevice — older ESPHome version (2024.5) gets the
//      upgrade recommendation appended.
//   5. POST /devices/test — bad body (missing ip) → ValidationError.
//   6. POST /devices/test — body with scheme prefix → ValidationError.
//   7. GET /devices — voice-bridge unavailable falls through to {devices:[],
//      unavailable:true} (matches the dashboard's expected shape).

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Same pattern as channels_ha_pr1.test.ts — set the data-dir env vars
// BEFORE we await-import the SUT so its top-level module bodies (which
// eagerly read these paths) land in tmp instead of /alfred-data.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voice-esphome-pr5-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.SQLITE_VEC_PATH = "";

// ── ESPHome satellite stub (re-uses the codec the SUT inlines) ─────────
// We avoid importing voice_esphome's encoder/decoder so the stub remains
// independent of the SUT under test — same trick channels_ha_pr1 uses
// for its HA mock.

function encVarint(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return Buffer.from(out);
}

function decVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = off;
  while (i < buf.length) {
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: value >>> 0, next: i };
    shift += 7;
  }
  throw new Error("varint truncated");
}

function tagBytes(fieldNumber: number, wireType: number): Buffer {
  return encVarint((fieldNumber << 3) | wireType);
}

function strField(n: number, s: string): Buffer {
  const b = Buffer.from(s, "utf-8");
  return Buffer.concat([tagBytes(n, 2), encVarint(b.length), b]);
}

function encFrame(mt: number, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0x00]),
    encVarint(payload.length),
    encVarint(mt),
    payload,
  ]);
}

const SAT_MSG = {
  HelloRequest: 1,
  HelloResponse: 2,
  ConnectRequest: 3,
  ConnectResponse: 4,
  DisconnectRequest: 5,
  DeviceInfoRequest: 9,
  DeviceInfoResponse: 10,
  ListEntitiesRequest: 11,
  ListEntitiesDoneResponse: 19,
  ListEntitiesVoiceAssistantResponse: 58,
};

interface FakeSatelliteOpts {
  esphomeVersion: string;
  hasVoiceAssistant: boolean;
  friendlyName?: string;
  mac?: string;
}

async function startFakeSatellite(
  opts: FakeSatelliteOpts,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length > 0) {
        if (buf[0] !== 0x00) {
          sock.destroy();
          return;
        }
        let len: number;
        let mt: number;
        let payloadStart: number;
        try {
          const a = decVarint(buf, 1);
          const b = decVarint(buf, a.next);
          len = a.value;
          mt = b.value;
          payloadStart = b.next;
        } catch {
          return; // partial frame, wait
        }
        if (buf.length < payloadStart + len) return;
        buf = buf.subarray(payloadStart + len);
        switch (mt) {
          case SAT_MSG.HelloRequest: {
            const payload = Buffer.concat([
              strField(3, `ESPHome ${opts.esphomeVersion} (fake)`),
              strField(4, "alfred-voice-pe"),
            ]);
            sock.write(encFrame(SAT_MSG.HelloResponse, payload));
            break;
          }
          case SAT_MSG.ConnectRequest: {
            sock.write(encFrame(SAT_MSG.ConnectResponse, Buffer.alloc(0)));
            break;
          }
          case SAT_MSG.DeviceInfoRequest: {
            const payload = Buffer.concat([
              strField(3, opts.mac ?? "aa:bb:cc:11:22:33"),
              strField(4, opts.esphomeVersion),
              strField(13, opts.friendlyName ?? "Voice PE Living Room"),
            ]);
            sock.write(encFrame(SAT_MSG.DeviceInfoResponse, payload));
            break;
          }
          case SAT_MSG.ListEntitiesRequest: {
            if (opts.hasVoiceAssistant) {
              sock.write(
                encFrame(
                  SAT_MSG.ListEntitiesVoiceAssistantResponse,
                  strField(1, "voice_assistant"),
                ),
              );
            }
            sock.write(
              encFrame(SAT_MSG.ListEntitiesDoneResponse, Buffer.alloc(0)),
            );
            break;
          }
          case SAT_MSG.DisconnectRequest: {
            sock.end();
            break;
          }
          default:
            break;
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// Import the SUT after we've stubbed the network surface.
const { probeEsphomeDevice, registerVoiceEsphomeRoutes } = await import(
  "../src/api/routes/voice_esphome.js"
);
const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { setApiKey, _resetAuthForTests } = await import("../src/api/auth.js");

registerVoiceEsphomeRoutes();

const MASTER_KEY = "test-master-" + "x".repeat(40);

interface CallResult {
  status: number;
  payload: any;
}

async function call(
  method: string,
  p: string,
  body?: unknown,
  token: string | undefined = MASTER_KEY,
): Promise<CallResult> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead(c: number) {
      status = c;
      return res;
    },
    end(j?: string) {
      payload = j ? JSON.parse(j) : undefined;
    },
  } as any;
  try {
    await m!.handler({
      req: {
        method,
        url: p,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      } as any,
      res,
      params: m!.params,
      body,
      query: new URLSearchParams(),
    });
  } catch (err) {
    handleError(res, err);
  }
  return { status, payload };
}

// The SUT accepts an optional `port` arg; tests use it to point at our
// fake satellite on a random high port instead of the real :6053.
async function probeAgainstFake(port: number, opts: { timeoutMs?: number } = {}) {
  const result = await probeEsphomeDevice({
    ip: "127.0.0.1",
    port,
    timeoutMs: opts.timeoutMs ?? 3000,
  });
  return { result };
}

test("probeEsphomeDevice — happy path: voice_assistant entity present, ok:true", async () => {
  const fake = await startFakeSatellite({
    esphomeVersion: "2024.10.3",
    hasVoiceAssistant: true,
  });
  try {
    const { result } = await probeAgainstFake(fake.port);
    assert.equal(result.reachable, true, "tcp connect succeeded");
    assert.equal(result.error, null, "no probe error");
    assert.equal(result.voice_assistant_present, true);
    assert.equal(result.esphome_version, "2024.10.3");
    assert.equal(result.friendly_name, "Voice PE Living Room");
    assert.equal(result.mac_address, "aa:bb:cc:11:22:33");
    assert.deepEqual(result.recommendations, []);
  } finally {
    await fake.close();
  }
});

test("probeEsphomeDevice — no voice_assistant block surfaces a recommendation", async () => {
  const fake = await startFakeSatellite({
    esphomeVersion: "2024.10.3",
    hasVoiceAssistant: false,
  });
  try {
    const { result } = await probeAgainstFake(fake.port);
    assert.equal(result.reachable, true);
    assert.equal(result.voice_assistant_present, false);
    const matched = result.recommendations.find((r) =>
      r.includes("voice_assistant:"),
    );
    assert.ok(
      matched,
      "should recommend adding a voice_assistant: block; got " +
        JSON.stringify(result.recommendations),
    );
  } finally {
    await fake.close();
  }
});

test("probeEsphomeDevice — unreachable IP surfaces reachable:false + recommendation", async () => {
  // Dial a port that's definitely not listening (port 1, which on most
  // systems immediately returns ECONNREFUSED). Faster than depending on
  // a connect timeout — the test stays under 100ms.
  const result = await probeEsphomeDevice({
    ip: "127.0.0.1",
    port: 1,
    timeoutMs: 1500,
  });
  assert.equal(result.reachable, false);
  assert.ok(result.error, "error string set");
  const recommendation = result.recommendations.find((r) =>
    r.includes("Could not open TCP"),
  );
  assert.ok(
    recommendation,
    "should suggest checking IP/network reachability",
  );
});

test("probeEsphomeDevice — old ESPHome version is flagged for upgrade", async () => {
  const fake = await startFakeSatellite({
    esphomeVersion: "2024.5.0",
    hasVoiceAssistant: true,
  });
  try {
    const { result } = await probeAgainstFake(fake.port);
    assert.equal(result.reachable, true);
    assert.equal(result.voice_assistant_present, true);
    const matched = result.recommendations.find((r) =>
      r.includes("older than 2024.7"),
    );
    assert.ok(
      matched,
      "should recommend upgrading the satellite; got " +
        JSON.stringify(result.recommendations),
    );
  } finally {
    await fake.close();
  }
});

// ── Route-level tests ───────────────────────────────────────────────────

test("POST /devices/test — empty body rejects with ValidationError (ip required)", async () => {
  _resetAuthForTests();
  setApiKey(MASTER_KEY);
  const r = await call(
    "POST",
    "/api/v1/channels/voice/esphome/devices/test",
    {},
  );
  assert.equal(r.status, 400, JSON.stringify(r.payload));
  assert.match(JSON.stringify(r.payload), /ip is required/);
});

test("POST /devices/test — body with scheme prefix is rejected", async () => {
  _resetAuthForTests();
  setApiKey(MASTER_KEY);
  const r = await call(
    "POST",
    "/api/v1/channels/voice/esphome/devices/test",
    { ip: "http://192.168.1.50" },
  );
  assert.equal(r.status, 400, JSON.stringify(r.payload));
  assert.match(JSON.stringify(r.payload), /scheme prefix/);
});

test("GET /esphome/devices — voice-bridge unreachable returns unavailable:true", async () => {
  _resetAuthForTests();
  setApiKey(MASTER_KEY);
  // Point VOICE_BRIDGE_INTERNAL_URL at an unreachable host BEFORE the
  // route module gets reloaded — but in this test pattern the module is
  // already imported, so we drive the fail path by patching `fetch`. The
  // SUT's `getVoiceBridgeJson` uses the global fetch.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED 172.18.0.42:9000");
  }) as typeof fetch;
  try {
    const r = await call("GET", "/api/v1/channels/voice/esphome/devices");
    assert.equal(r.status, 200);
    assert.equal(r.payload.unavailable, true);
    assert.equal(r.payload.enabled, false);
    assert.deepEqual(r.payload.devices, []);
    assert.match(r.payload.error, /ECONNREFUSED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
