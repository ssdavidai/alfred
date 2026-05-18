import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";

// Pure-helper import — no SSH, no fs writes, no transitive .njk/.sql loaders.
const { buildEnvWriteCommand } = await import("../src/infra/env-write.js");

// Fixture mirroring the four-key block that broke tenant-c (#681). The original
// bug rendered all four KEY=VALUE pairs into a SINGLE physical line of
// /opt/alfred/compose/.env separated by literal `\n` characters, which
// dotenv-style parsers treat as part of the first value. Result: only
// TENANT_ID parsed; AGENTPHONE_PHONE_NUMBER, SAAS_INTERNAL_URL, and
// VOICE_BRIDGE_INTERNAL_TOKEN were silently dropped.
const AGENTPHONE_BLOCK: Record<string, string> = {
  TENANT_ID: "00000000-0000-0000-0000-000000000abc",
  AGENTPHONE_PHONE_NUMBER: "+19782319359",
  SAAS_INTERNAL_URL: "https://alfred.black",
  VOICE_BRIDGE_INTERNAL_TOKEN: "deadbeef".repeat(8),
};

describe("buildEnvWriteCommand (#681 regression)", () => {
  it("returns null for an empty entries map", () => {
    assert.equal(buildEnvWriteCommand("/opt/alfred/compose/.env", {}), null);
  });

  it("emits one printf '%s\\n' argument per key, never a single joined string", () => {
    const cmd = buildEnvWriteCommand("/opt/alfred/compose/.env", AGENTPHONE_BLOCK);
    assert.ok(cmd, "expected non-null command for non-empty entries");

    // Each key MUST appear inside its own single-quoted printf argument:
    //   "KEY='VALUE'" (after JSON.stringify wrapping that becomes \"KEY='VALUE'\")
    for (const key of Object.keys(AGENTPHONE_BLOCK)) {
      const expected = `\"${key}='${AGENTPHONE_BLOCK[key]}'\"`;
      assert.ok(
        cmd.includes(expected),
        `expected printf argument ${expected} in command, got:\n${cmd}`,
      );
    }
  });

  it("uses printf '%s\\n' (format-string newline) — never a literal \\n inside an argument", () => {
    const cmd = buildEnvWriteCommand("/opt/alfred/compose/.env", AGENTPHONE_BLOCK);
    assert.ok(cmd);

    // The format string `'%s\n'` is what makes printf emit one newline per
    // argument. Without it (or if the newline is buried inside a single
    // argument), every KEY=VALUE pair lands on the same physical line.
    assert.ok(
      cmd.includes(`printf '%s\\n'`),
      `expected printf format \"%s\\n\" in command, got:\n${cmd}`,
    );

    // The argument list must NOT contain a literal `\n` joining two keys
    // together, e.g. "TENANT_ID=...\nAGENTPHONE_PHONE_NUMBER=..." in one
    // single-quoted printf argument. Verify by checking no value substring
    // contains another KEY= after a backslash-n.
    for (const key of Object.keys(AGENTPHONE_BLOCK)) {
      const otherKeys = Object.keys(AGENTPHONE_BLOCK).filter((k) => k !== key);
      for (const other of otherKeys) {
        const corruptionPattern = `${AGENTPHONE_BLOCK[key]}\\n${other}=`;
        assert.ok(
          !cmd.includes(corruptionPattern),
          `command contains literal-\\n joined keys (${key} → ${other}); ` +
            `this is the #681 bug pattern. Command:\n${cmd}`,
        );
      }
    }
  });

  it("emits one sed delete clause per key for idempotent re-runs", () => {
    const cmd = buildEnvWriteCommand("/opt/alfred/compose/.env", AGENTPHONE_BLOCK);
    assert.ok(cmd);
    for (const key of Object.keys(AGENTPHONE_BLOCK)) {
      assert.ok(
        cmd.includes(`-e \"/^${key}=/d\"`),
        `expected sed delete for ${key} in command, got:\n${cmd}`,
      );
    }
  });

  it("safely escapes embedded single quotes in values", () => {
    const tricky = { WEIRD: "it's a value" };
    const cmd = buildEnvWriteCommand("/opt/alfred/compose/.env", tricky);
    assert.ok(cmd);
    // The single quote in the value must be escaped via the bash
    // `'"'"'` idiom so the surrounding single-quoted string stays valid.
    // After JSON.stringify (which double-quote-wraps and \"-escapes), the
    // literal substring in the command is: it'\"'\"'s
    assert.ok(
      cmd.includes(`it'\\"'\\"'s`),
      `expected '\"'\"' single-quote escape, got:\n${cmd}`,
    );
    // And the round-trip via /bin/sh must give us back the original value.
    const tmp = path.join(os.tmpdir(), `alfred-env-quote-${process.pid}.env`);
    fs.writeFileSync(tmp, "");
    try {
      cp.execSync(buildEnvWriteCommand(tmp, tricky)!, { shell: "/bin/sh" });
      const written = fs.readFileSync(tmp, "utf8");
      assert.ok(
        written.includes(`WEIRD='it'"'"'s a value'`),
        `quote round-trip mismatch, got:\n${written}`,
      );
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  });

  it("simulates the full shell pipeline and confirms each key lands on its own line", () => {
    // The actual proof: run the generated command in /bin/sh (POSIX) against
    // a temp file, then read it back and assert each key lives on its own
    // physical line. This catches any future regression where the format
    // string or quoting drifts.
    const fakeEnv = path.join(os.tmpdir(), `alfred-env-test-${process.pid}.env`);
    fs.writeFileSync(fakeEnv, "EXISTING_KEY=preserved\nTENANT_ID=stale\n");
    try {
      const cmd = buildEnvWriteCommand(fakeEnv, AGENTPHONE_BLOCK);
      assert.ok(cmd);
      cp.execSync(cmd, { shell: "/bin/sh" });

      const written = fs.readFileSync(fakeEnv, "utf8");
      // Should NOT contain any literal backslash-n sequences.
      assert.ok(
        !written.includes("\\n"),
        `rendered .env contains literal \\n — the #681 bug is back. Content:\n${written}`,
      );
      // Each AgentPhone key should appear at the start of some line.
      for (const key of Object.keys(AGENTPHONE_BLOCK)) {
        const lines = written.split("\n");
        const matching = lines.filter((l: string) => l.startsWith(`${key}=`));
        assert.equal(
          matching.length,
          1,
          `expected exactly one ${key}= line, got ${matching.length}. ` +
            `Full file:\n${written}`,
        );
      }
      // The unrelated key must be preserved.
      assert.ok(
        written.includes("EXISTING_KEY=preserved"),
        `EXISTING_KEY line was clobbered. Content:\n${written}`,
      );
      // The stale TENANT_ID must have been replaced (not duplicated).
      const tenantIdLines = written
        .split("\n")
        .filter((l: string) => l.startsWith("TENANT_ID="));
      assert.equal(tenantIdLines.length, 1);
      assert.equal(
        tenantIdLines[0],
        `TENANT_ID='${AGENTPHONE_BLOCK.TENANT_ID}'`,
      );
    } finally {
      try {
        fs.unlinkSync(fakeEnv);
      } catch {}
    }
  });
});
