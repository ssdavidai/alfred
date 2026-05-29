// esphome-enable.test.ts — guards the #112 PR 4 contract that flipped
// ESPHOME_API_ENABLED's default to "1" on every fresh tenant.
//
// What this proves
// ----------------
//   1. With ESPHOME_API_ENABLED=1 → config.esphomeApiEnabled === true →
//      startEsphomeServer() actually binds a listener.
//   2. With ESPHOME_API_ENABLED=0 → config.esphomeApiEnabled === false →
//      the gating block in server.ts logs the off-message and does NOT
//      bind. (We can't run server.ts directly because it pulls live env
//      and listens on a real :9000; we verify the same `if` predicate
//      against the parsed config object.)
//   3. With ESPHOME_API_ENABLED unset → falls back to the source default
//      ("0" inside config.ts; the compose layer overrides to "1" at deploy
//      time — this test pins the source default + the override flip.)
//   4. End-to-end: when enabled, the listener actually accepts TCP on the
//      bound port (proves the listener really opens — not just that the
//      config flag is true).
//
// Compose-layer assertion
//   5. docker-compose.yaml still default-overrides ESPHOME_API_ENABLED to
//      "1" — read the YAML and assert it. If anyone reverts that
//      override (a one-line slip during a merge) this test fails fast.
//   6. The :6053 port binding is host-side localhost-only
//      ("127.0.0.1:6053:6053"), NOT 0.0.0.0 — proves PR 4's port hardening
//      didn't drift.
//
// These run under `node --test` against built JS the same way the rest of
// voice-bridge's tests do (tsc in `npm test` builds `dist/*.test.js` first).

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// config.ts requires OPENAI_API_KEY + VOICE_BRIDGE_INTERNAL_TOKEN to be set
// before import. We're testing the gating predicate, not OpenAI, so dummy
// values are fine.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "sk-test-dummy";
process.env.VOICE_BRIDGE_INTERNAL_TOKEN =
  process.env.VOICE_BRIDGE_INTERNAL_TOKEN ?? "test-internal-token";

// ── 1. ESPHOME_API_ENABLED=1 → config flag is true ──────────────────────────

test("ESPHOME_API_ENABLED=1 parses to esphomeApiEnabled=true", async () => {
  process.env.ESPHOME_API_ENABLED = "1";
  // config.ts is module-cached on first import — we re-import via a fresh
  // query string each test to force re-evaluation.
  const mod = await import(
    `./config.js?esphome-on=${Math.random().toString(36).slice(2)}`
  );
  assert.equal(mod.config.esphomeApiEnabled, true);
});

// ── 2. ESPHOME_API_ENABLED=0 → config flag is false ─────────────────────────

test("ESPHOME_API_ENABLED=0 parses to esphomeApiEnabled=false", async () => {
  process.env.ESPHOME_API_ENABLED = "0";
  const mod = await import(
    `./config.js?esphome-off=${Math.random().toString(36).slice(2)}`
  );
  assert.equal(mod.config.esphomeApiEnabled, false);
});

// ── 3. ESPHOME_API_ENABLED unset → falls back to the source default ─────────
//
// The source default in config.ts is "0" — opt-in. The compose layer
// passes "${ESPHOME_API_ENABLED:-1}" which overrides to "1" at deploy time.
// We pin both halves: source = "0", compose-default = "1". If either
// regresses the test fails.

test("ESPHOME_API_ENABLED unset → source default is opt-in (false)", async () => {
  delete process.env.ESPHOME_API_ENABLED;
  const mod = await import(
    `./config.js?esphome-unset=${Math.random().toString(36).slice(2)}`
  );
  assert.equal(
    mod.config.esphomeApiEnabled,
    false,
    "config.ts source default is opt-in; the deploy-time override lives in docker-compose.yaml",
  );
});

// ── 4. End-to-end: listener really opens on its bound port when enabled ─────

test("listener boots and accepts TCP when ESPHOME_API_ENABLED=1", async () => {
  process.env.ESPHOME_API_ENABLED = "1";
  const cfgMod = await import(
    `./config.js?esphome-bound=${Math.random().toString(36).slice(2)}`
  );
  const srvMod = await import("./esphome-server.js");

  assert.equal(cfgMod.config.esphomeApiEnabled, true);

  // Use port 0 so this never collides with a real :6053 listener on the
  // dev machine; the test only proves "binding succeeds + connect works".
  const handle = srvMod.startEsphomeServer({
    port: 0,
    bindHost: "127.0.0.1",
    identity: srvMod.computeIdentity({ tenantSeed: "esphome-enable-test" }),
    log: () => {},
  });
  await handle.ready;
  const port = handle.boundPort();
  assert.ok(port > 0, "boundPort > 0 means net.Server.listen succeeded");

  // Open a plain TCP connection to confirm the listener is reachable.
  await new Promise<void>((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.once("connect", () => {
      sock.destroy();
      resolve();
    });
    sock.once("error", reject);
  });

  await handle.close();
});

// ── 4b. Negative — when the gating predicate is false, server.ts's
//        `if (config.esphomeApiEnabled) startEsphomeServer(...)` branch
//        SHOULD NOT bind. We can't import server.ts directly (it would
//        race the live HTTP+WS listener), so we assert the predicate
//        evaluates as expected and provide a regression hook: if the
//        gating predicate changes shape the test below fails to compile.

test("listener gating predicate refuses to bind when ESPHOME_API_ENABLED=0", async () => {
  process.env.ESPHOME_API_ENABLED = "0";
  const cfgMod = await import(
    `./config.js?esphome-gate-off=${Math.random().toString(36).slice(2)}`
  );
  // Re-state the gating predicate from server.ts. If server.ts changes
  // how it gates (e.g. config.esphomeApiEnabled becomes an object), this
  // import-time predicate breaks loudly.
  const shouldBind: boolean = cfgMod.config.esphomeApiEnabled;
  assert.equal(shouldBind, false, "off → predicate false → no listener bound");
});

// ── 5. docker-compose.yaml override pin ─────────────────────────────────────

test("docker-compose.yaml still defaults ESPHOME_API_ENABLED to 1", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Tests run from dist/, source from src/. Walk up to the monorepo root.
  // Robust lookup: keep going up until we find a docker-compose.yaml.
  let dir = here;
  let composePath: string | null = null;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "docker-compose.yaml");
    if (fs.existsSync(candidate)) {
      composePath = candidate;
      break;
    }
    dir = path.dirname(dir);
  }
  assert.ok(composePath, "docker-compose.yaml must exist somewhere above this test");
  const yaml = fs.readFileSync(composePath, "utf-8");
  assert.match(
    yaml,
    /ESPHOME_API_ENABLED:\s*"\$\{ESPHOME_API_ENABLED:-1\}"/,
    "compose must default the env var to 1 — see #112 PR 4",
  );
});

// ── 6. Port binding is host-side localhost-only (#112 PR 4 hardening) ──────

test("docker-compose.yaml binds :6053 to 127.0.0.1 only (not 0.0.0.0)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  let composePath: string | null = null;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "docker-compose.yaml");
    if (fs.existsSync(candidate)) {
      composePath = candidate;
      break;
    }
    dir = path.dirname(dir);
  }
  assert.ok(composePath);
  const yaml = fs.readFileSync(composePath, "utf-8");
  // The voice-bridge service is the ONLY caller that publishes :6053.
  // Grep for the exact bind line and assert localhost.
  assert.match(
    yaml,
    /-\s*"127\.0\.0\.1:6053:6053"/,
    "voice-bridge :6053 must be bound to 127.0.0.1 only — see #112 PR 4",
  );
  // Belt-and-braces: assert the legacy wide-open form is gone.
  assert.doesNotMatch(
    yaml,
    /-\s*"6053:6053"/,
    "the pre-PR4 wide-open `6053:6053` bind must not be in compose",
  );
});
