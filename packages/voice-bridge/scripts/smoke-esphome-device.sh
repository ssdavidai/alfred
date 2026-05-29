#!/usr/bin/env bash
# smoke-esphome-device.sh — bare ESPHome Native API probe.
#
# Same diagnosis ctrl-api's POST /api/v1/channels/voice/esphome/devices/test
# runs, but spawned from a laptop without ctrl-api in the loop. Useful when:
#
#   - You're SSH'd into the tenant VM and the master AAS_API_KEY isn't to
#     hand.
#   - You want to confirm "is :6053 even reachable from this host?" without
#     going through Caddy.
#   - You're debugging an integration outage and ctrl-api itself isn't
#     up — this script only depends on `node` + the voice-bridge dist.
#
# Usage:
#
#   packages/voice-bridge/scripts/smoke-esphome-device.sh --ip 192.168.1.50
#   packages/voice-bridge/scripts/smoke-esphome-device.sh --ip voice-pe.local --port 6053
#
# Exits 0 + prints OK on a healthy probe, exits non-zero + prints a one-
# line diagnosis on failure. Doesn't write anything. Doesn't keep state.

set -euo pipefail

IP=""
PORT="6053"
TIMEOUT_MS="5000"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ip)
      IP="${2:-}"
      shift 2
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --timeout-ms)
      TIMEOUT_MS="${2:-}"
      shift 2
      ;;
    --help|-h)
      cat <<EOF
smoke-esphome-device.sh — bare ESPHome Native API probe.

Usage:
  $(basename "$0") --ip <ip-or-hostname> [--port 6053] [--timeout-ms 5000]

Prints OK on success or a one-line diagnosis on failure.
EOF
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      echo "see --help" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$IP" ]]; then
  echo "error: --ip is required" >&2
  exit 2
fi

# We embed a tiny Node script rather than depending on the voice-bridge
# dist — keeps this runnable on a fresh VM checkout without `npm install`.
# Same wire shape as packages/voice-bridge/src/esphome-protocol.ts.
node --input-type=module -e "
const net = await import('node:net');
const ip = process.argv[1];
const port = Number(process.argv[2]);
const timeoutMs = Number(process.argv[3]);

function encVarint(v) {
  const out = [];
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v & 0x7f);
  return Buffer.from(out);
}
function decVarint(buf, off) {
  let value = 0, shift = 0, i = off;
  while (i < buf.length) {
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: value >>> 0, next: i };
    shift += 7;
  }
  throw new Error('varint truncated');
}
function tagBytes(n, w) { return encVarint((n << 3) | w); }
function strField(n, s) {
  const b = Buffer.from(s, 'utf-8');
  return Buffer.concat([tagBytes(n, 2), encVarint(b.length), b]);
}
function uintField(n, v) {
  if (v === 0) return Buffer.alloc(0);
  return Buffer.concat([tagBytes(n, 0), encVarint(v)]);
}
function encFrame(mt, payload) {
  return Buffer.concat([Buffer.from([0x00]), encVarint(payload.length), encVarint(mt), payload]);
}
function tryDecode(buf) {
  if (buf.length === 0) return null;
  if (buf[0] !== 0x00) throw new Error('unexpected preamble 0x' + buf[0].toString(16));
  try {
    const a = decVarint(buf, 1);
    const b = decVarint(buf, a.next);
    const end = b.next + a.value;
    if (buf.length < end) return null;
    return { messageType: b.value, payload: buf.subarray(b.next, end), bytesConsumed: end };
  } catch (e) {
    if (e.message === 'varint truncated') return null;
    throw e;
  }
}
function decFields(payload) {
  const out = {}; let off = 0;
  while (off < payload.length) {
    const t = decVarint(payload, off); const fieldN = t.value >>> 3; const wireType = t.value & 0x07; off = t.next;
    if (wireType === 0) { const v = decVarint(payload, off); out[fieldN] = v.value; off = v.next; }
    else if (wireType === 2) { const len = decVarint(payload, off); const bytes = payload.subarray(len.next, len.next + len.value); off = len.next + len.value; out[fieldN] = bytes; }
    else { break; }
  }
  return out;
}
function asStr(f, n) { const v = f[n]; return Buffer.isBuffer(v) ? v.toString('utf8') : ''; }

const MSG = { Hello: 1, HelloR: 2, Conn: 3, ConnR: 4, Disc: 5, DevI: 9, DevIR: 10, List: 11, ListD: 19, ListVA: 58 };

const sock = new net.Socket();
let buf = Buffer.alloc(0);
let helloDone = false, devDone = false, listDone = false, voicePresent = false;
let serverInfo = '', espVer = '', macAddr = '', friendlyName = '';

const timer = setTimeout(() => {
  console.error('FAIL probe-timeout (helloDone=' + helloDone + ' devDone=' + devDone + ' listDone=' + listDone + ')');
  sock.destroy();
  process.exit(3);
}, timeoutMs);

sock.on('connect', () => {
  const payload = Buffer.concat([
    strField(1, 'alfred-smoke-probe'),
    uintField(2, 1),
    uintField(3, 10),
  ]);
  sock.write(encFrame(MSG.Hello, payload));
});

sock.on('error', (err) => {
  clearTimeout(timer);
  console.error('FAIL connect-error ' + err.message);
  process.exit(4);
});

sock.on('data', (chunk) => {
  buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
  let frame;
  while ((frame = tryDecode(buf))) {
    buf = buf.subarray(frame.bytesConsumed);
    if (frame.messageType === MSG.HelloR) {
      helloDone = true;
      const f = decFields(frame.payload);
      serverInfo = asStr(f, 3);
      sock.write(encFrame(MSG.Conn, Buffer.alloc(0)));
    } else if (frame.messageType === MSG.ConnR) {
      sock.write(encFrame(MSG.DevI, Buffer.alloc(0)));
    } else if (frame.messageType === MSG.DevIR) {
      devDone = true;
      const f = decFields(frame.payload);
      macAddr = asStr(f, 3);
      espVer = asStr(f, 4);
      friendlyName = asStr(f, 13);
      sock.write(encFrame(MSG.List, Buffer.alloc(0)));
    } else if (frame.messageType === MSG.ListVA) {
      voicePresent = true;
    } else if (frame.messageType === MSG.ListD) {
      listDone = true;
      clearTimeout(timer);
      sock.write(encFrame(MSG.Disc, Buffer.alloc(0)));
      setTimeout(() => sock.destroy(), 50);
    }
  }
});

sock.on('close', () => {
  if (!listDone) return; // error handlers already exited
  if (!voicePresent) {
    console.log('FAIL no-voice-assistant esphome_version=' + espVer + ' friendly_name=' + friendlyName);
    process.exit(5);
  }
  console.log('OK ' + ip + ':' + port + ' esphome_version=' + espVer + ' mac=' + macAddr + ' friendly_name=' + friendlyName + ' voice_assistant=present');
  process.exit(0);
});

sock.connect({ port, host: ip });
" -- "$IP" "$PORT" "$TIMEOUT_MS"
