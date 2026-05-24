/**
 * Sir #8 — Terminal card on /channels.
 *
 * Smoke-tests the pure shape derivation that drives the card so we don't
 * regress the two paths the principal will see:
 *   1. pubkey null / nothing provisioned  → ready=false, empty-state copy
 *   2. pubkey + hostname present          → ready=true, command + target
 *
 * Run with:  cd packages/web && npx tsx --test src/dashboard/terminalCardCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_HERMES_EXEC,
  deriveTerminalCardState,
  type SshInfo,
} from "./terminalCardCore";

const NULL_SSH: SshInfo = {
  hostname: null,
  port: null,
  user: null,
  pubkey: null,
  hermes_exec: null,
};

test("derive: all-null SSH info reads as not-ready with the fallback command", () => {
  const s = deriveTerminalCardState(NULL_SSH);
  assert.equal(s.ready, false);
  assert.equal(s.sshTarget, "");
  // The derivation must never return an empty hermesExec — the card
  // copy hides it in the empty state but the value should still be sane.
  assert.equal(s.hermesExec, DEFAULT_HERMES_EXEC);
});

test("derive: pubkey + hostname + user yields ready and a default-port ssh target", () => {
  const s = deriveTerminalCardState({
    hostname: "alfred-vm.tail-scale.ts.net",
    port: 22,
    user: "deploy",
    pubkey: "ssh-ed25519 AAAA... alfred@vm",
    hermes_exec: null,
  });
  assert.equal(s.ready, true);
  // Port 22 is implicit — we omit `-p 22` so the command stays clean.
  assert.equal(s.sshTarget, "deploy@alfred-vm.tail-scale.ts.net");
  assert.equal(s.hermesExec, DEFAULT_HERMES_EXEC);
});

test("derive: non-default port is surfaced as ` -p <port>` in the target", () => {
  const s = deriveTerminalCardState({
    hostname: "alfred-vm.tail-scale.ts.net",
    port: 2222,
    user: "deploy",
    pubkey: "ssh-ed25519 AAAA... alfred@vm",
    hermes_exec: null,
  });
  assert.equal(s.ready, true);
  assert.equal(s.sshTarget, "deploy@alfred-vm.tail-scale.ts.net -p 2222");
});

test("derive: hermes_exec from ctrl-api wins over the fallback", () => {
  const s = deriveTerminalCardState({
    hostname: "vm",
    port: 22,
    user: "deploy",
    pubkey: "ssh-ed25519 AAAA...",
    hermes_exec: "docker exec -it custom-hermes hermes --debug",
  });
  assert.equal(s.hermesExec, "docker exec -it custom-hermes hermes --debug");
});

test("derive: hostname-only (no user) still yields a usable target", () => {
  const s = deriveTerminalCardState({
    hostname: "vm",
    port: 22,
    user: null,
    pubkey: "ssh-ed25519 AAAA...",
    hermes_exec: null,
  });
  // ready hinges on pubkey + hostname, so true here — the principal can
  // still grab the key and figure out a username.
  assert.equal(s.ready, true);
  assert.equal(s.sshTarget, "vm");
});
