import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "disk-watch-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";
delete process.env.DISK_ALERT_WARN_PCT;
delete process.env.DISK_ALERT_PAGE_PCT;
const { _resetDiskWatchForTests, runDiskWatch, sampleDiskUsage } = await import("../src/api/diskWatch.js");
type DiskInfo = Awaited<ReturnType<typeof sampleDiskUsage>>;

const info = (level: "ok" | "warn" | "page", pct: number): DiskInfo => ({ disk_total_bytes: 1000, disk_free_bytes: 1000 - pct * 10, disk_used_pct: pct, disk_alert_level: level, disk_alert_warn_pct: 80, disk_alert_page_pct: 90 });

describe("disk watcher", () => {
  beforeEach(() => _resetDiskWatchForTests());

  it("computes used percent and bytes from statfs on the state-db directory", async () => {
    process.env.STATE_DB_PATH = "/state/alfred-state.db";
    let sampled = "";
    const d = await sampleDiskUsage(async (p) => { sampled = p; return { blocks: 100n, bfree: 20n, bsize: 4096n }; });
    assert.equal(sampled, "/state");
    assert.equal(d.disk_used_pct, 80);
    assert.equal(d.disk_total_bytes, 409600);
    assert.equal(d.disk_free_bytes, 81920);
    process.env.STATE_DB_PATH = path.join(tmp, "state.db");
  });

  it("exposes structured disk pressure through admin/system-info", async () => {
    const { registerAdminRoutes } = await import("../src/api/routes/admin.js");
    const { matchRoute } = await import("../src/api/server.js");
    registerAdminRoutes();
    const route = matchRoute("GET", "/api/v1/admin/system-info");
    assert.ok(route);
    let payload: DiskInfo | undefined;
    const res = { writeHead() { return res; }, end(body: string) { payload = JSON.parse(body); } } as any;
    await route.handler({ req: {} as any, res, params: {}, body: undefined, query: new URLSearchParams() });
    assert.equal(payload?.disk_alert_warn_pct, 80);
    assert.equal(payload?.disk_alert_page_pct, 90);
    assert.equal(typeof payload?.disk_used_pct, "number");
  });

  it("deduplicates the warn audit/card for 24 hours", async () => {
    await runDiskWatch({ sample: async () => info("warn", 82) });
    await runDiskWatch({ sample: async () => info("warn", 82) });
    const [file] = fs.readdirSync(path.join(tmp, "vault", "needs_attention"));
    assert.ok(file);
    const { readNeedsAttention } = await import("../src/api/routes/attention.js");
    assert.equal(readNeedsAttention(file.replace(/\.md$/, ""))?.frontmatter.status, "pending");
    const { getStateDb } = await import("../src/db/state.js");
    const row = getStateDb().prepare("SELECT count(*) AS n FROM audit WHERE action_type = 'disk_pressure_warning'").get() as { n: number };
    assert.equal(row.n, 1);
    const indexed = getStateDb().prepare("SELECT status FROM vault_index WHERE path = ?").get(`needs_attention/${file}`) as { status: string } | undefined;
    assert.equal(indexed?.status, "pending");
  });

  it("persists page crossings so a restart does not notify again", async () => {
    let current = info("page", 92), calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => { calls++; assert.match(String(url), /\/api\/v1\/notifications$/); return new Response("{}", { status: 200 }); }) as typeof fetch;
    try {
      const deps = { sample: async () => current, recentWarn: () => true };
      await runDiskWatch(deps);
      _resetDiskWatchForTests();
      await runDiskWatch(deps);
      current = info("warn", 85); await runDiskWatch(deps);
      current = info("page", 93); await runDiskWatch(deps);
      assert.equal(calls, 2);
      const { getStateDb } = await import("../src/db/state.js");
      const row = getStateDb().prepare("SELECT count(*) AS n FROM audit WHERE action_type = 'disk_pressure_page'").get() as { n: number };
      assert.equal(row.n, 2);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("does nothing below threshold", async () => {
    let effects = 0;
    await runDiskWatch({ sample: async () => info("ok", 40), recentWarn: () => { effects++; return false; }, card: () => { effects++; return "x"; }, audit: () => { effects++; }, pageActive: () => false, auditPage: () => { effects++; }, notify: async () => { effects++; } });
    assert.equal(effects, 0);
  });
});
