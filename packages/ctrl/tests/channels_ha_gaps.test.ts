// Lane II — /api/v1/channels/ha/* HA gap + proposal surfaces (#110 PR6).
//
// PR6 adds five routes plus voice-bridge allowlist entries for the two
// reads:
//
//   POST  /api/v1/channels/ha/gaps/bulk                    — operator-only
//   GET   /api/v1/channels/ha/gaps                         — voice readable
//   GET   /api/v1/channels/ha/proposals                    — voice readable
//   PATCH /api/v1/channels/ha/gap/:id/dismiss              — principal action
//   POST  /api/v1/channels/ha/proposal/:id/reject          — principal action
//
// The bulk route dedupes by (kind, area_id) so a 6h refresh doesn't
// re-discover the same gap; rows whose (kind, area_id) vanish from the
// input get status='addressed' (the spec's closed_at semantic, ridden
// inside the ha_gap.status column since PR1 didn't ship a closed_at
// column).
//
// Coverage (10 tests):
//   1. bulk upsert inserts new gap rows
//   2. bulk upsert is idempotent on (kind, area_id)
//   3. bulk upsert tombstones vanished gaps (status → addressed)
//   4. bulk upsert returns the open rows for Phase C
//   5. GET /gaps returns open + closed sorted by severity then ts
//   6. GET /proposals returns pending + applied + other
//   7. dismissed gap excluded from open in subsequent GET /gaps
//   8. PATCH dismiss on unknown gap returns 404
//   9. POST reject on pending proposal returns 200, status flips
//  10. bulk POST without operator bearer returns 401 (when key set)

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-ha-pr6-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.SQLITE_VEC_PATH = "";
process.env.HA_VAULTWARDEN_FOLDER = "Home Assistant";
process.env.HA_LLAT_ITEM = "LLAT";

const {
  registerChannelsHaRoutes,
  _resetHaGapsForTests,
} = await import("../src/api/routes/channels_ha.js");
const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { getStateDb } = await import("../src/db/state.js");
const { setApiKey, setVoiceBridgeKey, _resetAuthForTests } = await import(
  "../src/api/auth.js"
);

registerChannelsHaRoutes();

interface CallResult {
  status: number;
  payload: any;
}
async function call(
  method: string,
  p: string,
  body?: unknown,
  bearer?: string,
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
  } as unknown as ServerResponse;
  const headers: Record<string, string> = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  try {
    await m!.handler({
      req: { method, headers, url: p } as any,
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

const MASTER_KEY = "test-master-" + "a".repeat(40);

const morningGap = {
  kind: "no_morning_routine",
  summary: "No morning lighting routine.",
  severity: "medium",
  area_id: null,
  device_id: null,
  discovered_at: "2026-05-29T00:00:00Z",
  evidence: { light_count: 3 },
};

const motionHallGap = {
  kind: "no_motion_lighting",
  summary: "Motion sensor in Hallway isn't wired.",
  severity: "low",
  area_id: "hallway",
  device_id: null,
  discovered_at: "2026-05-29T00:00:00Z",
  evidence: { sensor: "binary_sensor.hall" },
};

const motionBathGap = {
  kind: "no_motion_lighting",
  summary: "Motion sensor in Bathroom isn't wired.",
  severity: "low",
  area_id: "bathroom",
  device_id: null,
  discovered_at: "2026-05-29T00:00:00Z",
  evidence: { sensor: "binary_sensor.bath" },
};

const cameraGap = {
  kind: "no_security_camera_notification",
  summary: "Cameras + motion sensors live.",
  severity: "high",
  area_id: null,
  device_id: null,
  discovered_at: "2026-05-29T00:00:00Z",
  evidence: { camera_count: 2 },
};

describe("/api/v1/channels/ha/* — #110 PR6 gap + proposal surfaces", () => {
  beforeEach(() => {
    _resetHaGapsForTests();
    _resetAuthForTests();
  });

  it("bulk upsert inserts new gap rows", async () => {
    const r = await call("POST", "/api/v1/channels/ha/gaps/bulk", {
      rows: [morningGap, motionHallGap, motionBathGap],
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.inserted, 3);
    assert.equal(r.payload.updated, 0);
    assert.equal(r.payload.addressed, 0);
    assert.equal(r.payload.gaps.length, 3);
    // Each returned gap has a server-minted id and the decoded fields.
    const morning = r.payload.gaps.find(
      (g: any) => g.kind === "no_morning_routine",
    );
    assert.ok(morning?.id);
    assert.equal(morning.severity, "medium");
    assert.equal(morning.area_id, null);
  });

  it("bulk upsert is idempotent — second identical batch updates instead of inserting", async () => {
    await call("POST", "/api/v1/channels/ha/gaps/bulk", {
      rows: [morningGap, motionHallGap],
    });
    const r = await call("POST", "/api/v1/channels/ha/gaps/bulk", {
      rows: [morningGap, motionHallGap],
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.inserted, 0);
    assert.equal(r.payload.updated, 2);
    assert.equal(r.payload.addressed, 0);
    const allRows = getStateDb()
      .prepare("SELECT id FROM ha_gap")
      .all() as Array<{ id: string }>;
    assert.equal(allRows.length, 2);
  });

  it("bulk upsert tombstones vanished gaps (status → addressed)", async () => {
    // Seed two areas with motion gaps + one whole-home gap.
    await call("POST", "/api/v1/channels/ha/gaps/bulk", {
      rows: [morningGap, motionHallGap, motionBathGap],
    });
    // Second pass — only the morning gap survives; both motion gaps vanish.
    const r = await call("POST", "/api/v1/channels/ha/gaps/bulk", {
      rows: [morningGap],
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.addressed, 2);
    const statuses = getStateDb()
      .prepare(
        "SELECT kind, evidence, status FROM ha_gap ORDER BY status, kind",
      )
      .all() as Array<{ kind: string; evidence: string | null; status: string }>;
    const addressed = statuses.filter((s) => s.status === "addressed");
    assert.equal(addressed.length, 2);
    const open = statuses.filter((s) => s.status === "open");
    assert.equal(open.length, 1);
    assert.equal(open[0].kind, "no_morning_routine");
  });

  it("bulk upsert returns the open rows for Phase C", async () => {
    const r = await call("POST", "/api/v1/channels/ha/gaps/bulk", {
      rows: [morningGap, cameraGap, motionHallGap],
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.gaps.length, 3);
    // Each row carries an id so Phase C can attach it to the proposal.
    for (const g of r.payload.gaps) {
      assert.ok(typeof g.id === "string" && g.id.length > 0);
    }
  });

  it("GET /gaps returns open + closed sorted by severity then ts", async () => {
    // Seed: high-camera, medium-morning, low-motion-hall, low-motion-bath.
    await call("POST", "/api/v1/channels/ha/gaps/bulk", {
      rows: [
        morningGap,
        { ...cameraGap, discovered_at: "2026-05-29T01:00:00Z" },
        motionHallGap,
        motionBathGap,
      ],
    });
    const r = await call("GET", "/api/v1/channels/ha/gaps");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.payload.open));
    assert.ok(Array.isArray(r.payload.closed));
    assert.equal(r.payload.open.length, 4);
    // Sort: high first, then medium, then low.
    assert.equal(r.payload.open[0].severity, "high");
    assert.equal(r.payload.open[1].severity, "medium");
    // Two low gaps last.
    assert.equal(r.payload.open[2].severity, "low");
    assert.equal(r.payload.open[3].severity, "low");
  });

  it("GET /proposals returns pending + applied + other buckets", async () => {
    // Seed a proposal via the existing POST /proposal route.
    const create = await call("POST", "/api/v1/channels/ha/proposal", {
      kind: "no_morning_routine",
      summary: "Wake the lights at sunrise.",
      yaml: "alias: x\ntrigger: []\naction: []\n",
    });
    assert.equal(create.status, 200, JSON.stringify(create.payload));
    const r = await call("GET", "/api/v1/channels/ha/proposals");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.payload.pending));
    assert.equal(r.payload.pending.length, 1);
    assert.equal(r.payload.pending[0].kind, "no_morning_routine");
    assert.equal(r.payload.pending[0].summary, "Wake the lights at sunrise.");
    assert.ok(r.payload.pending[0].yaml.includes("alias:"));
    assert.equal(r.payload.applied.length, 0);
  });

  it("dismissed gap is excluded from open in subsequent GET /gaps", async () => {
    const bulk = await call("POST", "/api/v1/channels/ha/gaps/bulk", {
      rows: [morningGap, motionHallGap],
    });
    const morningId = bulk.payload.gaps.find(
      (g: any) => g.kind === "no_morning_routine",
    ).id;
    const dismiss = await call(
      "PATCH",
      `/api/v1/channels/ha/gap/${morningId}/dismiss`,
    );
    assert.equal(dismiss.status, 200, JSON.stringify(dismiss.payload));
    assert.equal(dismiss.payload.status, "dismissed");
    const list = await call("GET", "/api/v1/channels/ha/gaps");
    assert.equal(list.status, 200);
    assert.equal(list.payload.open.length, 1);
    assert.equal(list.payload.open[0].kind, "no_motion_lighting");
    // Closed bucket carries the dismissed row.
    assert.equal(list.payload.closed.length, 1);
    assert.equal(list.payload.closed[0].kind, "no_morning_routine");
    assert.equal(list.payload.closed[0].status, "dismissed");
  });

  it("PATCH dismiss on unknown gap returns 404", async () => {
    const r = await call(
      "PATCH",
      "/api/v1/channels/ha/gap/01HX0000000000000000000000/dismiss",
    );
    assert.equal(r.status, 404);
    assert.equal(r.payload.error.code, "NOT_FOUND");
  });

  it("POST reject on pending proposal flips status, idempotent", async () => {
    const create = await call("POST", "/api/v1/channels/ha/proposal", {
      kind: "no_party_mode",
      summary: "Add party mode.",
      yaml: "alias: y\ntrigger: []\naction: []\n",
    });
    const id = create.payload.proposal_id;
    const r = await call(
      "POST",
      `/api/v1/channels/ha/proposal/${id}/reject`,
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.status, "rejected");
    // Idempotent — second reject on a rejected proposal is 200, not 409.
    const r2 = await call(
      "POST",
      `/api/v1/channels/ha/proposal/${id}/reject`,
    );
    assert.equal(r2.status, 200);
    assert.equal(r2.payload.status, "rejected");

    const list = await call("GET", "/api/v1/channels/ha/proposals");
    assert.equal(list.payload.pending.length, 0);
    assert.equal(list.payload.other.length, 1);
    assert.equal(list.payload.other[0].status, "rejected");
  });

  it("bulk POST without operator bearer returns 401 when key is set", async () => {
    setApiKey(MASTER_KEY);
    const r = await call("POST", "/api/v1/channels/ha/gaps/bulk", {
      rows: [morningGap],
    });
    assert.equal(r.status, 401);
    assert.equal(r.payload.error.code, "UNAUTHORIZED");

    // With the master key, the route succeeds.
    const ok = await call(
      "POST",
      "/api/v1/channels/ha/gaps/bulk",
      { rows: [morningGap] },
      MASTER_KEY,
    );
    assert.equal(ok.status, 200);
  });
});
