import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omi-directory-permissions-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.OMI_PROCESSOR_UID = String(process.getuid?.() ?? 1000);
process.env.OMI_PROCESSOR_GID = String(process.getgid?.() ?? 1000);

const { ensureOmiUidDirectory } = await import("../src/api/routes/omi.js");

describe("Omi audio directory permissions", () => {
  it("repairs an existing 0755 device directory for the processor", () => {
    const deviceDir = path.join(tmp, "streams", "omi-audio", "device-1");
    fs.mkdirSync(deviceDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(deviceDir, 0o755);

    const result = ensureOmiUidDirectory("device-1");
    const stat = fs.statSync(result);

    assert.equal(result, deviceDir);
    assert.equal(stat.mode & 0o777, 0o770);
    assert.equal(stat.uid, process.getuid?.() ?? 1000);
    assert.equal(stat.gid, process.getgid?.() ?? 1000);

    const processedDir = path.join(result, "processed");
    fs.mkdirSync(processedDir);
    assert.ok(fs.statSync(processedDir).isDirectory());
  });
});
