// Tests for the hass MCP tool catalogue (#110 PR2).
//
// Coverage:
//   1. The 11 read tools exist, have spec-compliant names, and their
//      input schemas accept / reject the spec's shape (entity_id format,
//      hours bounds, optional vs required).
//   2. The 5 PR3-deferred placeholders exist, have spec-compliant names,
//      and their buildRequest produces a body carrying the
//      `{deferred: true, target_pr: "PR3"}` marker.
//   3. Each read tool's buildRequest produces the right HTTP method +
//      ctrl-api path + query shape. This pins the wire contract that
//      ctrl-api's `/api/v1/channels/ha/*` routes implement.
//   4. The catalogue length is 16 (11 + 5) and the registry exposes
//      `hass` as a supported app.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ALL_HASS_TOOLS,
  HASS_READ_TOOLS,
  HASS_DEFERRED_TOOLS,
  HASS_ADDON_TOOLS,
  HASS_PR7_TOOLS,
  HASS_INTEGRATION_TOOLS,
  HASS_USER_TOOLS,
  HASS_HACS_TOOLS,
  HASS_PR2_TOOLS,
} from "./hass.js";
import { SUPPORTED_APPS, isAppId, getToolsForApp } from "./registry.js";

function getTool(name: string) {
  const t = ALL_HASS_TOOLS.find((x) => x.name === name);
  assert.ok(t, `tool ${name} not found in ALL_HASS_TOOLS`);
  return t;
}

// ─── catalogue shape ────────────────────────────────────────────────────

test("hass catalogue: exactly 85 tools (11 read + 15 write + 10 PR6 addon + 10 PR7 core+backup + 7 PR4 integration + 8 PR8 user + 8 PR5 HACS + 16 PR2 registries)", () => {
  assert.equal(HASS_READ_TOOLS.length, 11);
  // After #115 PR3 splice: PR4's 5 + PR3's 10 = 15 writes.
  assert.equal(HASS_DEFERRED_TOOLS.length, 15);
  // PR6: 10 supervisor addon tools.
  assert.equal(HASS_ADDON_TOOLS.length, 10);
  // PR7: 10 core lifecycle + backup CRUD tools.
  assert.equal(HASS_PR7_TOOLS.length, 10);
  // PR4 (issue #115): 7 integration tools.
  assert.equal(HASS_INTEGRATION_TOOLS.length, 7);
  // PR8: 8 user + LLAT tools (spec named 7; we added ha__list_user_llats
  // for token visibility before revoke).
  assert.equal(HASS_USER_TOOLS.length, 8);
  // PR5: 8 HACS tools.
  assert.equal(HASS_HACS_TOOLS.length, 8);
  // PR2: 16 registries CRUD tools (areas/devices/entities/labels).
  assert.equal(HASS_PR2_TOOLS.length, 16);
  assert.equal(ALL_HASS_TOOLS.length, 85);
});

test("registry: hass is a supported app and registers all 85 tools", () => {
  assert.ok(isAppId("hass"));
  assert.ok((SUPPORTED_APPS as Set<string>).has("hass"));
  const tools = getToolsForApp("hass");
  assert.equal(tools.length, 85);
});

test("hass: every tool name is unique", () => {
  const names = ALL_HASS_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test("hass: every tool name begins with `ha__`", () => {
  for (const tool of ALL_HASS_TOOLS) {
    assert.ok(
      tool.name.startsWith("ha__"),
      `tool ${tool.name} does not begin with ha__`,
    );
  }
});

test("hass: every tool has a non-empty description", () => {
  for (const tool of ALL_HASS_TOOLS) {
    assert.ok(
      typeof tool.description === "string" && tool.description.length > 30,
      `tool ${tool.name} has empty/short description`,
    );
  }
});

// ─── read tools — names exist and schemas match spec ────────────────────

const READ_TOOL_NAMES = [
  "ha__connection_status",
  "ha__list_entities",
  "ha__get_state",
  "ha__get_history",
  "ha__get_logbook",
  "ha__list_areas",
  "ha__list_devices",
  "ha__list_automations",
  "ha__list_scripts",
  "ha__get_calendars",
  "ha__resolve_entity",
];

for (const name of READ_TOOL_NAMES) {
  test(`read tool exists: ${name}`, () => {
    const t = HASS_READ_TOOLS.find((x) => x.name === name);
    assert.ok(t, `${name} missing from HASS_READ_TOOLS`);
  });
}

test("ha__connection_status: empty input schema, GET /status", () => {
  const t = getTool("ha__connection_status");
  const r = t.inputSchema.safeParse({});
  assert.equal(r.success, true);
  const req = t.buildRequest({});
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/channels/ha/status");
});

test("ha__list_entities: optional domain + area, builds registry query", () => {
  const t = getTool("ha__list_entities");
  assert.equal(t.inputSchema.safeParse({}).success, true);
  assert.equal(t.inputSchema.safeParse({ domain: "light" }).success, true);
  assert.equal(
    t.inputSchema.safeParse({ domain: "light", area: "kitchen" }).success,
    true,
  );

  const empty = t.buildRequest({});
  assert.equal(empty.method, "GET");
  assert.equal(empty.path, "/api/v1/channels/ha/registry");
  assert.deepEqual(empty.query, { kind: "entity" });

  const filtered = t.buildRequest({ domain: "light", area: "kitchen" });
  assert.deepEqual(filtered.query, {
    kind: "entity",
    domain: "light",
    area: "kitchen",
  });
});

test("ha__get_state: entity_id required + must be dotted HA form", () => {
  const t = getTool("ha__get_state");

  // Required.
  assert.equal(t.inputSchema.safeParse({}).success, false);

  // Must match `<domain>.<object>` lowercase.
  assert.equal(
    t.inputSchema.safeParse({ entity_id: "Light.Kitchen" }).success,
    false,
    "entity_id should be lowercase",
  );
  assert.equal(
    t.inputSchema.safeParse({ entity_id: "no_dot_entity" }).success,
    false,
    "entity_id must contain a dot",
  );

  // Valid.
  const ok = t.inputSchema.safeParse({ entity_id: "light.kitchen_main" });
  assert.equal(ok.success, true);

  const req = t.buildRequest({ entity_id: "light.kitchen_main" });
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/channels/ha/state/light.kitchen_main");
});

test("ha__get_state: entity_id with weird chars is URL-encoded", () => {
  const t = getTool("ha__get_state");
  // Slash in entity_id wouldn't validate (regex blocks it), so feed a
  // raw-pass-through to buildRequest — the encoding helper is what we want
  // to pin. Skip schema and call buildRequest directly.
  const req = t.buildRequest({ entity_id: "light.weird/id" });
  assert.equal(req.path, "/api/v1/channels/ha/state/light.weird%2Fid");
});

test("ha__get_history: entity_id required, hours bounds 1..168", () => {
  const t = getTool("ha__get_history");

  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({ entity_id: "light.kitchen_main", hours: 0 })
      .success,
    false,
    "hours must be ≥1",
  );
  assert.equal(
    t.inputSchema.safeParse({ entity_id: "light.kitchen_main", hours: 169 })
      .success,
    false,
    "hours must be ≤168",
  );
  assert.equal(
    t.inputSchema.safeParse({ entity_id: "light.kitchen_main", hours: 24 })
      .success,
    true,
  );

  const req = t.buildRequest({ entity_id: "light.kitchen_main", hours: 6 });
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/channels/ha/history");
  assert.deepEqual(req.query, { entity_id: "light.kitchen_main", hours: 6 });

  // Without hours → query omits it.
  const req2 = t.buildRequest({ entity_id: "light.kitchen_main" });
  assert.deepEqual(req2.query, { entity_id: "light.kitchen_main" });
});

test("ha__get_logbook: entity_id optional, hours bounds 1..168", () => {
  const t = getTool("ha__get_logbook");

  // No args is fine — the logbook is household-wide.
  assert.equal(t.inputSchema.safeParse({}).success, true);
  assert.equal(t.inputSchema.safeParse({ hours: 12 }).success, true);
  assert.equal(t.inputSchema.safeParse({ hours: 200 }).success, false);

  const req = t.buildRequest({});
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/channels/ha/logbook");
  assert.deepEqual(req.query, {});

  const req2 = t.buildRequest({
    entity_id: "binary_sensor.front_door",
    hours: 6,
  });
  assert.deepEqual(req2.query, {
    entity_id: "binary_sensor.front_door",
    hours: 6,
  });
});

test("ha__list_areas / list_automations / list_scripts: empty input, registry query by kind", () => {
  for (const [name, kind] of [
    ["ha__list_areas", "area"],
    ["ha__list_automations", "automation"],
    ["ha__list_scripts", "script"],
  ] as const) {
    const t = getTool(name);
    assert.equal(t.inputSchema.safeParse({}).success, true);
    const req = t.buildRequest({});
    assert.equal(req.method, "GET");
    assert.equal(req.path, "/api/v1/channels/ha/registry");
    assert.deepEqual(req.query, { kind });
  }
});

test("ha__list_devices: optional area filter, registry kind=device", () => {
  const t = getTool("ha__list_devices");
  assert.equal(t.inputSchema.safeParse({}).success, true);
  assert.equal(t.inputSchema.safeParse({ area: "kitchen" }).success, true);

  const req = t.buildRequest({});
  assert.deepEqual(req.query, { kind: "device" });

  const req2 = t.buildRequest({ area: "kitchen" });
  assert.deepEqual(req2.query, { kind: "device", area: "kitchen" });
});

test("ha__get_calendars: empty input, GET /calendars", () => {
  const t = getTool("ha__get_calendars");
  assert.equal(t.inputSchema.safeParse({}).success, true);
  const req = t.buildRequest({});
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/channels/ha/calendars");
});

test("ha__resolve_entity: query required, GET /resolve with q param", () => {
  const t = getTool("ha__resolve_entity");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(t.inputSchema.safeParse({ query: "" }).success, false);
  assert.equal(t.inputSchema.safeParse({ query: "kitchen light" }).success, true);

  const req = t.buildRequest({ query: "kitchen light" });
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/channels/ha/resolve");
  assert.deepEqual(req.query, { q: "kitchen light" });
});

// ─── write tools (#110 PR4) ─────────────────────────────────────────────
//
// PR4 fills in what PR2 left as deferred stubs. The 5 write tools must:
//   * carry real buildRequest mappings to /api/v1/channels/ha/* routes
//   * require `decision_ref` on every actual write (ha__call_service,
//     ha__apply_proposal, ha__rollback_snapshot)
//   * route through the ctrl-api routes that own the loop guard

const WRITE_TOOL_NAMES = [
  "ha__call_service",
  "ha__propose_automation",
  "ha__apply_proposal",
  "ha__rollback_snapshot",
  "ha__subscribe_events",
];

for (const name of WRITE_TOOL_NAMES) {
  test(`write tool exists: ${name}`, () => {
    const t = HASS_DEFERRED_TOOLS.find((x) => x.name === name);
    assert.ok(t, `${name} missing from HASS_DEFERRED_TOOLS`);
  });
}

// ── ha__call_service ──

test("ha__call_service: requires decision_ref (no client-side mint)", () => {
  const t = getTool("ha__call_service");
  // Without decision_ref — fails.
  assert.equal(
    t.inputSchema.safeParse({ domain: "light", service: "turn_on" }).success,
    false,
    "decision_ref is REQUIRED — the agent must derive a decision before calling this",
  );
  // With a short/whitespace decision_ref — fails the regex/min-length gate.
  assert.equal(
    t.inputSchema.safeParse({
      domain: "light",
      service: "turn_on",
      decision_ref: "x x x",
    }).success,
    false,
    "decision_ref must be ≥6 chars and contain no whitespace",
  );
  // With a valid decision_ref — passes.
  assert.equal(
    t.inputSchema.safeParse({
      domain: "light",
      service: "turn_on",
      target: { entity_id: "light.kitchen_main" },
      data: { brightness_pct: 60 },
      decision_ref: "decision/2026-05-29-kitchen-on.md",
    }).success,
    true,
  );
});

test("ha__call_service: builds POST /service with decision_ref in body", () => {
  const t = getTool("ha__call_service");
  const req = t.buildRequest({
    domain: "light",
    service: "turn_on",
    target: { entity_id: "light.kitchen_main" },
    data: { brightness_pct: 60 },
    decision_ref: "decision/2026-05-29-kitchen-on.md",
  });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/channels/ha/service");
  assert.deepEqual(req.body, {
    domain: "light",
    service: "turn_on",
    target: { entity_id: "light.kitchen_main" },
    data: { brightness_pct: 60 },
    decision_ref: "decision/2026-05-29-kitchen-on.md",
  });
});

test("ha__call_service: schema rejects domain or service missing", () => {
  const t = getTool("ha__call_service");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({
      service: "turn_on",
      decision_ref: "decision/2026-05-29.md",
    }).success,
    false,
    "domain required",
  );
  assert.equal(
    t.inputSchema.safeParse({
      domain: "light",
      decision_ref: "decision/2026-05-29.md",
    }).success,
    false,
    "service required",
  );
});

// ── ha__propose_automation ──

test("ha__propose_automation: accepts kind/summary/yaml + builds POST /proposal", () => {
  const t = getTool("ha__propose_automation");
  // kind + summary + yaml required.
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({ kind: "automation" }).success,
    false,
  );
  assert.equal(
    t.inputSchema.safeParse({
      kind: "automation",
      summary: "Morning routine",
      yaml: "alias: morning\ntrigger:\n  - platform: time\n    at: '06:30'\naction: []\n",
    }).success,
    true,
  );

  const req = t.buildRequest({
    kind: "automation",
    summary: "Morning routine",
    yaml: "alias: morning\n",
  });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/channels/ha/proposal");
  assert.deepEqual(req.body, {
    kind: "automation",
    summary: "Morning routine",
    yaml: "alias: morning\n",
  });

  // With gap_id — passes through.
  const req2 = t.buildRequest({
    kind: "automation",
    summary: "Morning routine",
    yaml: "alias: morning\n",
    gap_id: "gap-abc",
  });
  assert.equal((req2.body as Record<string, unknown>).gap_id, "gap-abc");
});

// ── ha__apply_proposal ──

test("ha__apply_proposal: takes proposal_id + decision_ref, builds POST /proposal/:id/apply", () => {
  const t = getTool("ha__apply_proposal");
  // decision_ref required.
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({ proposal_id: "01HXYZ" }).success,
    false,
    "decision_ref required to enforce loop-guard contract",
  );
  assert.equal(
    t.inputSchema.safeParse({
      proposal_id: "01HXYZ",
      decision_ref: "decision/2026-05-29-ha-baseline.md",
    }).success,
    true,
  );

  const req = t.buildRequest({
    proposal_id: "01HXYZ",
    decision_ref: "decision/2026-05-29-ha-baseline.md",
  });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/channels/ha/proposal/01HXYZ/apply");
  assert.deepEqual(req.body, {
    decision_ref: "decision/2026-05-29-ha-baseline.md",
  });
});

// ── ha__rollback_snapshot ──

test("ha__rollback_snapshot: takes snapshot_id + decision_ref, builds POST /snapshot/:id/rollback", () => {
  const t = getTool("ha__rollback_snapshot");
  // decision_ref required.
  assert.equal(t.inputSchema.safeParse({ snapshot_id: "01HSNAP" }).success, false);
  assert.equal(
    t.inputSchema.safeParse({
      snapshot_id: "01HSNAP",
      decision_ref: "decision/2026-05-29-rollback.md",
    }).success,
    true,
  );

  const req = t.buildRequest({
    snapshot_id: "01HSNAP",
    decision_ref: "decision/2026-05-29-rollback.md",
  });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/channels/ha/snapshot/01HSNAP/rollback");
  assert.deepEqual(req.body, {
    decision_ref: "decision/2026-05-29-rollback.md",
  });
});

// ── ha__subscribe_events ──

test("ha__subscribe_events: returns subscription_id-shaped POST /subscribe", () => {
  const t = getTool("ha__subscribe_events");
  // No filter is fine (household firehose).
  assert.equal(t.inputSchema.safeParse({}).success, true);
  // Filter with event_type.
  assert.equal(
    t.inputSchema.safeParse({
      filter: { event_type: "state_changed" },
    }).success,
    true,
  );
  // Filter with entity_id (must be dotted form).
  assert.equal(
    t.inputSchema.safeParse({
      filter: { entity_id: "binary_sensor.front_door" },
    }).success,
    true,
  );
  // Bad entity_id rejected.
  assert.equal(
    t.inputSchema.safeParse({
      filter: { entity_id: "Bad Entity" },
    }).success,
    false,
  );

  const empty = t.buildRequest({});
  assert.equal(empty.method, "POST");
  assert.equal(empty.path, "/api/v1/channels/ha/subscribe");
  assert.deepEqual(empty.body, {});

  const filtered = t.buildRequest({
    filter: { event_type: "state_changed", entity_id: "binary_sensor.front_door" },
  });
  assert.deepEqual(filtered.body, {
    filter: {
      event_type: "state_changed",
      entity_id: "binary_sensor.front_door",
    },
  });
});

// ─── mock ctrl-api response → tool result shape (smoke) ─────────────────

test("ha__list_entities buildRequest shape mocks cleanly against a fake fetch", async () => {
  const t = getTool("ha__list_entities");
  const req = t.buildRequest({ domain: "light" });

  // Mock ctrl-api response — what /registry?kind=entity&domain=light would
  // return after PR5 populates the registry.
  const mockResponse = {
    entities: [
      {
        entity_id: "light.kitchen_main",
        friendly_name: "Kitchen Main",
        area_id: "kitchen",
        state: "off",
      },
      {
        entity_id: "light.kitchen_island",
        friendly_name: "Kitchen Island",
        area_id: "kitchen",
        state: "off",
      },
    ],
  };

  // We don't invoke proxyToCtrl here (would require a fake fetch + a
  // CtrlContext); instead pin the buildRequest output that
  // `proxyToCtrl()` consumes. End-to-end coverage of proxyToCtrl lives
  // in alfred.test.ts patterns.
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/channels/ha/registry");
  assert.deepEqual(req.query, { kind: "entity", domain: "light" });

  // The MCP server's toolResult() wraps mockResponse into the text content
  // shape — we assert the contract by emulating the success path that
  // helpers.ts/toolResult takes.
  const text = JSON.stringify(mockResponse, null, 2);
  assert.ok(text.includes("light.kitchen_main"));
});

// ─── #115 PR3 — automations / scenes / scripts CRUD ─────────────────────
//
// 15 tests covering tool registration + schema validation +
// buildRequest shape for the 10 new CRUD tools. Hits the contract that
// `packages/ctrl/src/api/routes/channels_ha.ts` implements at
// `/api/v1/channels/ha/{automations,scenes,scripts}`.

const PR3_TOOL_NAMES = [
  "ha__list_automations_full",
  "ha__create_automation",
  "ha__update_automation",
  "ha__delete_automation",
  "ha__create_scene",
  "ha__update_scene",
  "ha__delete_scene",
  "ha__create_script",
  "ha__update_script",
  "ha__delete_script",
];

test("#115 PR3: all 10 CRUD tool names exist + begin with ha__", () => {
  for (const name of PR3_TOOL_NAMES) {
    const t = ALL_HASS_TOOLS.find((x) => x.name === name);
    assert.ok(t, `${name} missing from ALL_HASS_TOOLS`);
    assert.ok(name.startsWith("ha__"));
  }
});

test("#115 PR3: ha__list_automations_full → GET /automations", () => {
  const t = getTool("ha__list_automations_full");
  assert.equal(t.inputSchema.safeParse({}).success, true);
  const req = t.buildRequest({});
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/channels/ha/automations");
});

test("#115 PR3: ha__create_automation accepts {alias, trigger, action} minimal", () => {
  const t = getTool("ha__create_automation");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({
      alias: "Lights off sunrise",
      trigger: { platform: "sun", event: "sunrise" },
      action: { service: "light.turn_off", target: { area_id: "living_room" } },
    }).success,
    true,
  );
});

test("#115 PR3: ha__create_automation builds POST /automations with full body", () => {
  const t = getTool("ha__create_automation");
  const req = t.buildRequest({
    alias: "Lights off sunrise",
    trigger: { platform: "sun", event: "sunrise" },
    condition: { condition: "state", entity_id: "sun.sun", state: "above_horizon" },
    action: { service: "light.turn_off", target: { area_id: "living_room" } },
    description: "Created by Alfred 2026-05-29",
    mode: "single",
    initial_state: "off",
  });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/channels/ha/automations");
  assert.deepEqual(req.body, {
    alias: "Lights off sunrise",
    trigger: { platform: "sun", event: "sunrise" },
    condition: { condition: "state", entity_id: "sun.sun", state: "above_horizon" },
    action: { service: "light.turn_off", target: { area_id: "living_room" } },
    description: "Created by Alfred 2026-05-29",
    mode: "single",
    initial_state: "off",
  });
});

test("#115 PR3: ha__update_automation requires automation_id, builds PUT", () => {
  const t = getTool("ha__update_automation");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(t.inputSchema.safeParse({ alias: "x" }).success, false);
  assert.equal(
    t.inputSchema.safeParse({
      automation_id: "lights_off_sunrise",
      alias: "Lights off at sunrise",
    }).success,
    true,
  );
  const req = t.buildRequest({
    automation_id: "lights_off_sunrise",
    alias: "Lights off at sunrise",
    action: { service: "light.turn_off", target: { area_id: "living_room" } },
  });
  assert.equal(req.method, "PUT");
  assert.equal(req.path, "/api/v1/channels/ha/automations/lights_off_sunrise");
  assert.deepEqual(req.body, {
    alias: "Lights off at sunrise",
    action: { service: "light.turn_off", target: { area_id: "living_room" } },
  });
});

test("#115 PR3: ha__delete_automation requires decision_ref (gated)", () => {
  const t = getTool("ha__delete_automation");
  // automation_id alone — fails (decision_ref REQUIRED for irreversible delete).
  assert.equal(
    t.inputSchema.safeParse({ automation_id: "lights_off_sunrise" }).success,
    false,
  );
  // Valid.
  assert.equal(
    t.inputSchema.safeParse({
      automation_id: "lights_off_sunrise",
      decision_ref: "decision/2026-05-29-drop-sunrise.md",
    }).success,
    true,
  );
});

test("#115 PR3: ha__delete_automation rejects whitespace / too-short decision_ref", () => {
  const t = getTool("ha__delete_automation");
  assert.equal(
    t.inputSchema.safeParse({
      automation_id: "x",
      decision_ref: "abc def",
    }).success,
    false,
  );
  assert.equal(
    t.inputSchema.safeParse({
      automation_id: "x",
      decision_ref: "abc",
    }).success,
    false,
    "min 6 chars",
  );
});

test("#115 PR3: ha__delete_automation DELETE shape carries decision_ref in body", () => {
  const t = getTool("ha__delete_automation");
  const req = t.buildRequest({
    automation_id: "lights_off_sunrise",
    decision_ref: "decision/2026-05-29-drop-sunrise.md",
  });
  assert.equal(req.method, "DELETE");
  assert.equal(req.path, "/api/v1/channels/ha/automations/lights_off_sunrise");
  assert.deepEqual(req.body, {
    decision_ref: "decision/2026-05-29-drop-sunrise.md",
  });
});

test("#115 PR3: ha__create_scene accepts {name, entities}, builds POST", () => {
  const t = getTool("ha__create_scene");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(t.inputSchema.safeParse({ name: "Bedtime" }).success, false);
  assert.equal(
    t.inputSchema.safeParse({
      name: "Bedtime",
      entities: {
        "light.bedroom_main": { state: "on", brightness_pct: 15 },
        "light.living_room_lamp": { state: "off" },
      },
    }).success,
    true,
  );
  const req = t.buildRequest({
    name: "Bedtime",
    entities: {
      "light.bedroom_main": { state: "on", brightness_pct: 15 },
    },
    icon: "mdi:weather-night",
  });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/channels/ha/scenes");
  assert.deepEqual(req.body, {
    name: "Bedtime",
    entities: { "light.bedroom_main": { state: "on", brightness_pct: 15 } },
    icon: "mdi:weather-night",
  });
});

test("#115 PR3: ha__update_scene requires scene_id, builds PUT", () => {
  const t = getTool("ha__update_scene");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(t.inputSchema.safeParse({ name: "x" }).success, false);
  assert.equal(t.inputSchema.safeParse({ scene_id: "bedtime" }).success, true);
  const req = t.buildRequest({
    scene_id: "bedtime",
    entities: { "light.bedroom_main": { state: "off" } },
  });
  assert.equal(req.method, "PUT");
  assert.equal(req.path, "/api/v1/channels/ha/scenes/bedtime");
  assert.deepEqual(req.body, {
    entities: { "light.bedroom_main": { state: "off" } },
  });
});

test("#115 PR3: ha__delete_scene requires scene_id, DELETE without body", () => {
  const t = getTool("ha__delete_scene");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(t.inputSchema.safeParse({ scene_id: "bedtime" }).success, true);
  const req = t.buildRequest({ scene_id: "bedtime" });
  assert.equal(req.method, "DELETE");
  assert.equal(req.path, "/api/v1/channels/ha/scenes/bedtime");
  assert.equal(req.body, undefined);
});

test("#115 PR3: ha__create_script accepts {alias, sequence}, builds POST", () => {
  const t = getTool("ha__create_script");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(t.inputSchema.safeParse({ alias: "Goodnight" }).success, false);
  assert.equal(
    t.inputSchema.safeParse({
      alias: "Goodnight",
      sequence: [
        { service: "scene.turn_on", target: { entity_id: "scene.bedtime" } },
        { delay: "00:05:00" },
      ],
    }).success,
    true,
  );
  const req = t.buildRequest({
    alias: "Goodnight",
    sequence: [
      { service: "scene.turn_on", target: { entity_id: "scene.bedtime" } },
    ],
    mode: "single",
  });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/channels/ha/scripts");
  assert.deepEqual(req.body, {
    alias: "Goodnight",
    sequence: [
      { service: "scene.turn_on", target: { entity_id: "scene.bedtime" } },
    ],
    mode: "single",
  });
});

test("#115 PR3: ha__update_script requires script_id, builds PUT", () => {
  const t = getTool("ha__update_script");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(t.inputSchema.safeParse({ alias: "x" }).success, false);
  assert.equal(t.inputSchema.safeParse({ script_id: "goodnight" }).success, true);
  const req = t.buildRequest({
    script_id: "goodnight",
    sequence: [{ delay: "00:01:00" }],
  });
  assert.equal(req.method, "PUT");
  assert.equal(req.path, "/api/v1/channels/ha/scripts/goodnight");
  assert.deepEqual(req.body, { sequence: [{ delay: "00:01:00" }] });
});

test("#115 PR3: ha__delete_script DELETE without body", () => {
  const t = getTool("ha__delete_script");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(t.inputSchema.safeParse({ script_id: "goodnight" }).success, true);
  const req = t.buildRequest({ script_id: "goodnight" });
  assert.equal(req.method, "DELETE");
  assert.equal(req.path, "/api/v1/channels/ha/scripts/goodnight");
  assert.equal(req.body, undefined);
});

test("#115 PR3: catalogue order — reads first, then all writes (PR4 + PR3 CRUD), then PR6 addon", () => {
  // First 11 must be the 11 reads.
  for (let i = 0; i < 11; i++) {
    assert.ok(
      READ_TOOL_NAMES.includes(ALL_HASS_TOOLS[i].name),
      `slot ${i} (${ALL_HASS_TOOLS[i].name}) should be a read tool`,
    );
  }
  // Slots 11..25 are writes (15). PR4's 5 + PR3's 10.
  const writeNames = ALL_HASS_TOOLS.slice(11, 26).map((t) => t.name);
  for (const n of WRITE_TOOL_NAMES) {
    assert.ok(writeNames.includes(n), `${n} missing from write tail`);
  }
  for (const n of PR3_TOOL_NAMES) {
    assert.ok(writeNames.includes(n), `${n} missing from write tail`);
  }
  assert.equal(writeNames.length, 15);
});

// ─── #115 PR6 — Supervisor addon tools ─────────────────────────────────

const ADDON_TOOL_NAMES = [
  "ha__list_addons",
  "ha__addon_info",
  "ha__addon_install",
  "ha__addon_uninstall",
  "ha__addon_configure",
  "ha__addon_start",
  "ha__addon_stop",
  "ha__addon_restart",
  "ha__addon_update",
  "ha__addon_logs",
];

test("PR6: every addon tool name is registered and unique", () => {
  for (const name of ADDON_TOOL_NAMES) {
    const t = HASS_ADDON_TOOLS.find((x) => x.name === name);
    assert.ok(t, `${name} missing from HASS_ADDON_TOOLS`);
  }
  const names = HASS_ADDON_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test("PR6 ha__list_addons: empty input, GET /addons", () => {
  const t = getTool("ha__list_addons");
  assert.equal(t.inputSchema.safeParse({}).success, true);
  const r = t.buildRequest({});
  assert.equal(r.method, "GET");
  assert.equal(r.path, "/api/v1/channels/ha/addons");
});

test("PR6 ha__addon_info: slug required + slug format-gated, GET /addons/:slug", () => {
  const t = getTool("ha__addon_info");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({ slug: "core_mosquitto" }).success,
    true,
  );
  // slash rejected (URL-traversal guard).
  assert.equal(
    t.inputSchema.safeParse({ slug: "core/mosquitto" }).success,
    false,
  );
  // leading-special rejected.
  assert.equal(
    t.inputSchema.safeParse({ slug: "_underscore" }).success,
    false,
  );
  // URL-encoded slug in path.
  const r = t.buildRequest({ slug: "core_mosquitto" });
  assert.equal(r.method, "GET");
  assert.equal(r.path, "/api/v1/channels/ha/addons/core_mosquitto");
});

test("PR6 ha__addon_install: requires decision_ref + slug; builds POST /install with body", () => {
  const t = getTool("ha__addon_install");
  // slug-only — fails.
  assert.equal(
    t.inputSchema.safeParse({ slug: "core_mosquitto" }).success,
    false,
    "decision_ref required for install",
  );
  // decision_ref-only — fails.
  assert.equal(
    t.inputSchema.safeParse({ decision_ref: "decision/x.md" }).success,
    false,
    "slug required for install",
  );
  // short decision_ref rejected.
  assert.equal(
    t.inputSchema.safeParse({
      slug: "core_mosquitto",
      decision_ref: "abc",
    }).success,
    false,
  );
  // happy path.
  const ok = {
    slug: "core_mosquitto",
    decision_ref: "decision/2026-05-29-mosquitto.md",
  };
  assert.equal(t.inputSchema.safeParse(ok).success, true);
  const r = t.buildRequest(ok);
  assert.equal(r.method, "POST");
  assert.equal(
    r.path,
    "/api/v1/channels/ha/addons/core_mosquitto/install",
  );
  assert.deepEqual(r.body, { decision_ref: ok.decision_ref });
});

test("PR6 ha__addon_uninstall: same gate shape as install; builds POST /uninstall", () => {
  const t = getTool("ha__addon_uninstall");
  // decision_ref required.
  assert.equal(
    t.inputSchema.safeParse({ slug: "core_mosquitto" }).success,
    false,
  );
  const args = {
    slug: "core_mosquitto",
    decision_ref: "decision/2026-05-29-uninstall.md",
  };
  assert.equal(t.inputSchema.safeParse(args).success, true);
  const r = t.buildRequest(args);
  assert.equal(r.method, "POST");
  assert.equal(
    r.path,
    "/api/v1/channels/ha/addons/core_mosquitto/uninstall",
  );
  assert.deepEqual(r.body, { decision_ref: args.decision_ref });
});

test("PR6 ha__addon_configure: requires decision_ref + options object; builds PUT /options", () => {
  const t = getTool("ha__addon_configure");
  // missing options — fails.
  assert.equal(
    t.inputSchema.safeParse({
      slug: "core_mosquitto",
      decision_ref: "decision/2026-05-29.md",
    }).success,
    false,
  );
  // happy path.
  const args = {
    slug: "core_mosquitto",
    options: { logins: [{ username: "alfred", password: "x" }] },
    decision_ref: "decision/2026-05-29-cfg.md",
  };
  assert.equal(t.inputSchema.safeParse(args).success, true);
  const r = t.buildRequest(args);
  assert.equal(r.method, "PUT");
  assert.equal(
    r.path,
    "/api/v1/channels/ha/addons/core_mosquitto/options",
  );
  assert.deepEqual(r.body, {
    options: args.options,
    decision_ref: args.decision_ref,
  });
});

test("PR6 ha__addon_start / stop / restart: slug-only, no gate, build POST", () => {
  for (const verb of ["start", "stop", "restart"] as const) {
    const t = getTool(`ha__addon_${verb}`);
    assert.equal(t.inputSchema.safeParse({}).success, false);
    assert.equal(
      t.inputSchema.safeParse({ slug: "core_mosquitto" }).success,
      true,
    );
    const r = t.buildRequest({ slug: "core_mosquitto" });
    assert.equal(r.method, "POST");
    assert.equal(
      r.path,
      `/api/v1/channels/ha/addons/core_mosquitto/${verb}`,
    );
    assert.equal((r.body as unknown) ?? null, null);
  }
});

test("PR6 ha__addon_update: requires decision_ref; builds POST /update", () => {
  const t = getTool("ha__addon_update");
  // decision_ref required.
  assert.equal(
    t.inputSchema.safeParse({ slug: "core_mosquitto" }).success,
    false,
  );
  const args = {
    slug: "core_mosquitto",
    decision_ref: "decision/2026-05-29-update.md",
  };
  assert.equal(t.inputSchema.safeParse(args).success, true);
  const r = t.buildRequest(args);
  assert.equal(r.method, "POST");
  assert.equal(r.path, "/api/v1/channels/ha/addons/core_mosquitto/update");
  assert.deepEqual(r.body, { decision_ref: args.decision_ref });
});

test("PR6 ha__addon_logs: slug + optional tail; tail bounded 1..2000", () => {
  const t = getTool("ha__addon_logs");
  // slug only — fine, no gate.
  assert.equal(
    t.inputSchema.safeParse({ slug: "core_mosquitto" }).success,
    true,
  );
  assert.equal(
    t.inputSchema.safeParse({ slug: "core_mosquitto", tail: 50 }).success,
    true,
  );
  // tail out of bounds rejected.
  assert.equal(
    t.inputSchema.safeParse({ slug: "core_mosquitto", tail: 0 }).success,
    false,
  );
  assert.equal(
    t.inputSchema.safeParse({ slug: "core_mosquitto", tail: 5000 }).success,
    false,
  );
  // no tail.
  const empty = t.buildRequest({ slug: "core_mosquitto" });
  assert.equal(empty.method, "GET");
  assert.equal(
    empty.path,
    "/api/v1/channels/ha/addons/core_mosquitto/logs",
  );
  assert.equal(empty.query, undefined);
  // with tail.
  const tail = t.buildRequest({ slug: "core_mosquitto", tail: 50 });
  assert.deepEqual(tail.query, { tail: "50" });
});

test("PR6 addon tool descriptions: every gated tool mentions decision_ref + snapshot semantics", () => {
  const GATED = [
    "ha__addon_install",
    "ha__addon_uninstall",
    "ha__addon_configure",
    "ha__addon_update",
  ];
  const SNAPSHOTTED = [
    "ha__addon_install",
    "ha__addon_uninstall",
    "ha__addon_update",
  ];
  for (const name of GATED) {
    const t = getTool(name);
    assert.ok(
      t.description.toLowerCase().includes("decision_ref"),
      `${name} description must mention decision_ref`,
    );
  }
  for (const name of SNAPSHOTTED) {
    const t = getTool(name);
    assert.ok(
      /snapshot|backup/i.test(t.description),
      `${name} description must mention snapshot/backup`,
    );
  }
});

test("PR6 addon tool descriptions: every tool documents the HAOS-only constraint", () => {
  for (const name of ADDON_TOOL_NAMES) {
    const t = getTool(name);
    assert.ok(
      /HAOS-ONLY|Home Assistant OS|installation_type/i.test(t.description),
      `${name} description must document the HAOS-only constraint`,
    );
  }
});

test("PR6 addon tool slug guard: rejects empty + slash on the 9 slug-bearing tools", () => {
  // ha__list_addons has no slug input — skipped.
  for (const name of ADDON_TOOL_NAMES) {
    if (name === "ha__list_addons") continue;
    const t = getTool(name);

    // Empty slug.
    const emptySlug =
      name === "ha__addon_install" ||
      name === "ha__addon_uninstall" ||
      name === "ha__addon_update"
        ? { slug: "", decision_ref: "decision/x-2026-05-29.md" }
        : name === "ha__addon_configure"
          ? {
              slug: "",
              options: {},
              decision_ref: "decision/x-2026-05-29.md",
            }
          : { slug: "" };
    assert.equal(
      t.inputSchema.safeParse(emptySlug).success,
      false,
      `${name} must reject empty slug`,
    );

    // Slash in slug.
    const withSlash =
      name === "ha__addon_install" ||
      name === "ha__addon_uninstall" ||
      name === "ha__addon_update"
        ? { slug: "a/b", decision_ref: "decision/x-2026-05-29.md" }
        : name === "ha__addon_configure"
          ? {
              slug: "a/b",
              options: {},
              decision_ref: "decision/x-2026-05-29.md",
            }
          : { slug: "a/b" };
    assert.equal(
      t.inputSchema.safeParse(withSlash).success,
      false,
      `${name} must reject slug with '/'`,
    );
  }
});

// ─── #115 PR7 — Core lifecycle + backup CRUD tools ──────────────────────

const PR7_TOOL_NAMES = [
  "ha__core_version",
  "ha__core_check_config",
  "ha__core_reload_yaml",
  "ha__core_restart",
  "ha__core_update",
  "ha__list_backups",
  "ha__backup_info",
  "ha__create_backup",
  "ha__delete_backup",
  "ha__restore_backup",
];

test("PR7: every core+backup tool name is registered and unique", () => {
  for (const name of PR7_TOOL_NAMES) {
    const t = HASS_PR7_TOOLS.find((x) => x.name === name);
    assert.ok(t, `${name} missing from HASS_PR7_TOOLS`);
  }
  const names = HASS_PR7_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test("PR7 ha__core_version: empty input, GET /version", () => {
  const t = getTool("ha__core_version");
  assert.equal(t.inputSchema.safeParse({}).success, true);
  const r = t.buildRequest({});
  assert.equal(r.method, "GET");
  assert.equal(r.path, "/api/v1/channels/ha/version");
});

test("PR7 ha__core_check_config: empty input, POST /core/check_config with empty body", () => {
  const t = getTool("ha__core_check_config");
  assert.equal(t.inputSchema.safeParse({}).success, true);
  const r = t.buildRequest({});
  assert.equal(r.method, "POST");
  assert.equal(r.path, "/api/v1/channels/ha/core/check_config");
  assert.deepEqual(r.body, {});
});

test("PR7 ha__core_reload_yaml: empty input, POST /core/reload_yaml with empty body", () => {
  const t = getTool("ha__core_reload_yaml");
  assert.equal(t.inputSchema.safeParse({}).success, true);
  const r = t.buildRequest({});
  assert.equal(r.method, "POST");
  assert.equal(r.path, "/api/v1/channels/ha/core/reload_yaml");
  assert.deepEqual(r.body, {});
});

test("PR7 ha__core_restart: requires decision_ref; builds POST /core/restart", () => {
  const t = getTool("ha__core_restart");
  // empty — fails.
  assert.equal(t.inputSchema.safeParse({}).success, false);
  // short decision_ref rejected.
  assert.equal(
    t.inputSchema.safeParse({ decision_ref: "abc" }).success,
    false,
    "min 6 chars",
  );
  // whitespace rejected.
  assert.equal(
    t.inputSchema.safeParse({ decision_ref: "abc def" }).success,
    false,
  );
  // valid.
  const args = { decision_ref: "decision/2026-05-29-restart.md" };
  assert.equal(t.inputSchema.safeParse(args).success, true);
  const r = t.buildRequest(args);
  assert.equal(r.method, "POST");
  assert.equal(r.path, "/api/v1/channels/ha/core/restart");
  assert.deepEqual(r.body, { decision_ref: args.decision_ref });
});

test("PR7 ha__core_update: requires decision_ref, optional version pin", () => {
  const t = getTool("ha__core_update");
  // missing decision_ref — fails.
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({ version: "2025.7.0" }).success,
    false,
    "decision_ref required",
  );
  // happy path without version.
  const noVer = { decision_ref: "decision/2026-05-29-update.md" };
  assert.equal(t.inputSchema.safeParse(noVer).success, true);
  const r1 = t.buildRequest(noVer);
  assert.equal(r1.method, "POST");
  assert.equal(r1.path, "/api/v1/channels/ha/core/update");
  assert.deepEqual(r1.body, { decision_ref: noVer.decision_ref });
  // happy path with version.
  const withVer = {
    version: "2025.7.0",
    decision_ref: "decision/2026-05-29-update.md",
  };
  assert.equal(t.inputSchema.safeParse(withVer).success, true);
  const r2 = t.buildRequest(withVer);
  assert.deepEqual(r2.body, {
    decision_ref: withVer.decision_ref,
    version: withVer.version,
  });
  // bad version chars rejected.
  assert.equal(
    t.inputSchema.safeParse({
      version: "bad version",
      decision_ref: "decision/x-2026-05-29.md",
    }).success,
    false,
  );
});

test("PR7 ha__list_backups: empty input, GET /backups", () => {
  const t = getTool("ha__list_backups");
  assert.equal(t.inputSchema.safeParse({}).success, true);
  const r = t.buildRequest({});
  assert.equal(r.method, "GET");
  assert.equal(r.path, "/api/v1/channels/ha/backups");
});

test("PR7 ha__backup_info: backup_id required + format-gated, GET /backups/:id", () => {
  const t = getTool("ha__backup_info");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({ backup_id: "abc123" }).success,
    true,
  );
  // slash rejected (URL-traversal guard).
  assert.equal(
    t.inputSchema.safeParse({ backup_id: "abc/123" }).success,
    false,
  );
  // leading-special rejected.
  assert.equal(
    t.inputSchema.safeParse({ backup_id: "_abc" }).success,
    false,
  );
  const r = t.buildRequest({ backup_id: "abc123def" });
  assert.equal(r.method, "GET");
  assert.equal(r.path, "/api/v1/channels/ha/backups/abc123def");
});

test("PR7 ha__create_backup: all-optional, NO gate; builds POST /backups with optional fields", () => {
  const t = getTool("ha__create_backup");
  // empty is valid — cheap, no gate.
  assert.equal(t.inputSchema.safeParse({}).success, true);
  const empty = t.buildRequest({});
  assert.equal(empty.method, "POST");
  assert.equal(empty.path, "/api/v1/channels/ha/backups");
  assert.deepEqual(empty.body, {});
  // populated.
  const args = {
    name: "alfred-pre-zwave-fw",
    password: "secret",
    include_addons: ["core_mosquitto"],
    include_database: false,
    include_homeassistant: true,
    include_folders: ["share"],
  };
  assert.equal(t.inputSchema.safeParse(args).success, true);
  const r = t.buildRequest(args);
  assert.deepEqual(r.body, args);
});

test("PR7 ha__delete_backup: requires decision_ref + backup_id, DELETE", () => {
  const t = getTool("ha__delete_backup");
  // both required.
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({ backup_id: "abc" }).success,
    false,
    "decision_ref required",
  );
  assert.equal(
    t.inputSchema.safeParse({ decision_ref: "decision/x-2026-05-29.md" }).success,
    false,
    "backup_id required",
  );
  // happy path.
  const args = {
    backup_id: "abc123",
    decision_ref: "decision/2026-05-29-prune.md",
  };
  assert.equal(t.inputSchema.safeParse(args).success, true);
  const r = t.buildRequest(args);
  assert.equal(r.method, "DELETE");
  assert.equal(r.path, "/api/v1/channels/ha/backups/abc123");
  assert.deepEqual(r.body, { decision_ref: args.decision_ref });
});

test("PR7 ha__restore_backup: requires decision_ref + backup_id, optional password", () => {
  const t = getTool("ha__restore_backup");
  // missing decision_ref → fails.
  assert.equal(
    t.inputSchema.safeParse({ backup_id: "abc" }).success,
    false,
  );
  // happy path no password.
  const noPw = {
    backup_id: "abc123",
    decision_ref: "decision/2026-05-29-restore.md",
  };
  assert.equal(t.inputSchema.safeParse(noPw).success, true);
  const r1 = t.buildRequest(noPw);
  assert.equal(r1.method, "POST");
  assert.equal(r1.path, "/api/v1/channels/ha/backups/abc123/restore");
  assert.deepEqual(r1.body, { decision_ref: noPw.decision_ref });
  // with password.
  const withPw = {
    backup_id: "abc123",
    password: "encrypted-archive-pass",
    decision_ref: "decision/2026-05-29-restore.md",
  };
  assert.equal(t.inputSchema.safeParse(withPw).success, true);
  const r2 = t.buildRequest(withPw);
  assert.deepEqual(r2.body, {
    decision_ref: withPw.decision_ref,
    password: withPw.password,
  });
});

test("PR7: every gated tool description mentions decision_ref + warns destructive", () => {
  const GATED = [
    "ha__core_restart",
    "ha__core_update",
    "ha__delete_backup",
    "ha__restore_backup",
  ];
  for (const name of GATED) {
    const t = getTool(name);
    assert.ok(
      t.description.toLowerCase().includes("decision_ref"),
      `${name} description must mention decision_ref`,
    );
    assert.ok(
      /destructive|stops? ha|offline|irreversible|several minutes/i.test(
        t.description,
      ),
      `${name} description must warn about its blast radius`,
    );
  }
});

test("PR7: snapshot-on-trigger tools describe the auto-snapshot semantics", () => {
  const SNAPSHOTTED = ["ha__core_restart", "ha__core_update"];
  for (const name of SNAPSHOTTED) {
    const t = getTool(name);
    assert.ok(
      /auto-snapshot|snapshot taken|backup_ref_id|ha_backup_id/i.test(
        t.description,
      ),
      `${name} description must explain the auto-snapshot semantics`,
    );
  }
});

test("PR7 ha__restore_backup: description explicitly warns 'stops HA for several minutes'", () => {
  const t = getTool("ha__restore_backup");
  assert.ok(
    /stops? ha|several minutes/i.test(t.description),
    "ha__restore_backup description must spell out the HA-stop blast radius",
  );
});

// ─── PR4: Integrations (#115) ───────────────────────────────────────────

const INTEGRATION_TOOL_NAMES = [
  "ha__list_integrations",
  "ha__list_available_integrations",
  "ha__integration_info",
  "ha__integration_discover",
  "ha__integration_configure",
  "ha__integration_reload",
  "ha__integration_remove",
];

test("PR4 integration: all 7 tool names registered", () => {
  for (const name of INTEGRATION_TOOL_NAMES) {
    getTool(name); // throws if missing
  }
  assert.equal(HASS_INTEGRATION_TOOLS.length, INTEGRATION_TOOL_NAMES.length);
});

test("PR4 integration: ha__list_integrations builds a GET /api/v1/channels/ha/integrations", () => {
  const t = getTool("ha__list_integrations");
  const req = t.buildRequest({});
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/channels/ha/integrations");
});

test("PR4 integration: ha__list_available_integrations builds a GET /api/v1/channels/ha/integrations/available", () => {
  const t = getTool("ha__list_available_integrations");
  const req = t.buildRequest({});
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/channels/ha/integrations/available");
});

test("PR4 integration: ha__integration_discover requires `domain` and builds POST with the body", () => {
  const t = getTool("ha__integration_discover");
  // missing domain
  assert.equal(t.inputSchema.safeParse({}).success, false);
  // invalid domain (uppercase)
  assert.equal(t.inputSchema.safeParse({ domain: "Hue" }).success, false);
  // valid
  const ok = t.inputSchema.safeParse({ domain: "hue" });
  assert.ok(ok.success);
  const req = t.buildRequest({ domain: "hue" });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/channels/ha/integrations/discover");
  assert.deepEqual(req.body, { domain: "hue" });

  const reqAdv = t.buildRequest({
    domain: "hue",
    show_advanced_options: true,
  });
  assert.deepEqual(reqAdv.body, { domain: "hue", show_advanced_options: true });
});

test("PR4 integration: ha__integration_configure requires decision_ref + flow_id + data", () => {
  const t = getTool("ha__integration_configure");
  // missing decision_ref
  assert.equal(
    t.inputSchema.safeParse({ flow_id: "abc", data: {} }).success,
    false,
    "rejects missing decision_ref",
  );
  // bad flow_id shape
  assert.equal(
    t.inputSchema.safeParse({
      flow_id: "bad flow id",
      data: {},
      decision_ref: "decision/2026-05-29-x.md",
    }).success,
    false,
    "rejects flow_id with whitespace",
  );
  // good shape
  const ok = t.inputSchema.safeParse({
    flow_id: "abc123",
    data: { host: "192.168.1.42" },
    decision_ref: "decision/2026-05-29-hue.md",
  });
  assert.ok(ok.success);
  const req = t.buildRequest({
    flow_id: "abc123",
    data: { host: "192.168.1.42" },
    decision_ref: "decision/2026-05-29-hue.md",
  });
  assert.equal(req.method, "POST");
  assert.equal(
    req.path,
    "/api/v1/channels/ha/integrations/configure/abc123",
  );
  assert.deepEqual(req.body, {
    data: { host: "192.168.1.42" },
    decision_ref: "decision/2026-05-29-hue.md",
  });
});

test("PR4 integration: ha__integration_remove gated on decision_ref + entry_id, builds DELETE", () => {
  const t = getTool("ha__integration_remove");
  // missing decision_ref
  assert.equal(
    t.inputSchema.safeParse({ entry_id: "01JC..." }).success,
    false,
    "rejects missing decision_ref",
  );
  // valid
  const ok = t.inputSchema.safeParse({
    entry_id: "01JC123",
    decision_ref: "decision/2026-05-29-rm.md",
  });
  assert.ok(ok.success);
  const req = t.buildRequest({
    entry_id: "01JC123",
    decision_ref: "decision/2026-05-29-rm.md",
  });
  assert.equal(req.method, "DELETE");
  assert.equal(req.path, "/api/v1/channels/ha/integrations/01JC123");
  assert.deepEqual(req.body, { decision_ref: "decision/2026-05-29-rm.md" });
});

// #115 — Alfred self-protection guard on ha__integration_remove.
// Regression guard: tonight (2026-05-30) Sir accidentally asked Alfred to
// remove the alfred-ha integration, conversation.alfred disappeared, Voice PE
// went silent, took ~20 min to recover. The skill doc + tool description both
// now carry an exact-phrase requirement before Alfred will remove the entry
// whose domain is `alfred`. These two tests pin that — a future refactor that
// drops the guard fails CI before it ships.
test("#115 self-protection: ha__integration_remove description carries the SELF-PROTECTION + exact-phrase guard", () => {
  const t = getTool("ha__integration_remove");
  assert.ok(
    /SELF-PROTECTION/.test(t.description),
    "description must mention SELF-PROTECTION (regression guard)",
  );
  assert.ok(
    t.description.includes(
      "yes, sever my own connection to Home Assistant",
    ),
    "description must include the EXACT confirmation phrase verbatim",
  );
  assert.ok(
    /alfred/.test(t.description),
    "description must name the `alfred` domain so the model knows when the guard fires",
  );
});

test("#115 self-protection: skill doc names the exact phrase under ha__integration_remove", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  // src/tools/hass.test.ts → ../../skills/alfred-mcp-skill.md
  const skillPath = resolve(here, "../../skills/alfred-mcp-skill.md");
  const doc = await readFile(skillPath, "utf8");
  assert.ok(
    doc.includes("yes, sever my own connection to Home Assistant"),
    "skill doc must carry the EXACT confirmation phrase (case-sensitive)",
  );
  // and the phrase must appear inside the PR4 integration_remove section, not
  // some unrelated paragraph. Anchor on the PR4 section header.
  const pr4Idx = doc.indexOf(
    '### "Install / remove / reload a Home Assistant integration"',
  );
  assert.ok(pr4Idx >= 0, "PR4 section header must exist");
  const phraseIdx = doc.indexOf(
    "yes, sever my own connection to Home Assistant",
  );
  assert.ok(
    phraseIdx > pr4Idx,
    "the confirmation phrase must appear inside (after) the PR4 section header",
  );
});

test("PR4 integration: ha__integration_reload is gateless and builds POST .../reload", () => {
  const t = getTool("ha__integration_reload");
  const ok = t.inputSchema.safeParse({ entry_id: "01JC123" });
  assert.ok(ok.success, "no decision_ref required");
  const req = t.buildRequest({ entry_id: "01JC123" });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/channels/ha/integrations/01JC123/reload");
});

test("PR4 integration: ha__integration_info builds GET, gateless", () => {
  const t = getTool("ha__integration_info");
  const ok = t.inputSchema.safeParse({ entry_id: "01JC123" });
  assert.ok(ok.success);
  const req = t.buildRequest({ entry_id: "01JC123" });
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/channels/ha/integrations/01JC123");
});

test("PR4 integration: configure description explains the multi-step pattern", () => {
  const t = getTool("ha__integration_configure");
  assert.ok(
    /step\.type/i.test(t.description),
    "configure description must explain step.type semantics",
  );
  assert.ok(
    /snapshot|backup/i.test(t.description),
    "configure description must mention snapshot/backup",
  );
});

test("PR4 integration: discover description explains the multi-step pattern", () => {
  const t = getTool("ha__integration_discover");
  assert.ok(
    /flow_id/i.test(t.description),
    "discover description must mention flow_id",
  );
  assert.ok(
    /no gate/i.test(t.description) || /inspection/i.test(t.description),
    "discover description must mention no-gate semantics",
  );
});

test("PR4 integration: every name starts with `ha__` and is unique", () => {
  const names = HASS_INTEGRATION_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.ok(n.startsWith("ha__"));
});
// ═════════════════════════════════════════════════════════════════════════
// #115 PR8 — HA users + per-user LLATs
// ═════════════════════════════════════════════════════════════════════════

const USER_TOOL_NAMES = [
  "ha__list_users",
  "ha__user_info",
  "ha__create_user",
  "ha__update_user",
  "ha__delete_user",
  "ha__list_user_llats",
  "ha__mint_llat",
  "ha__revoke_llat",
];

for (const name of USER_TOOL_NAMES) {
  test(`PR8 user tool exists: ${name}`, () => {
    const t = HASS_USER_TOOLS.find((x) => x.name === name);
    assert.ok(t, `${name} missing from HASS_USER_TOOLS`);
  });
}

test("PR8: ha__list_users → GET /users", () => {
  const t = getTool("ha__list_users");
  const r = t.inputSchema.safeParse({});
  assert.equal(r.success, true);
  const req = t.buildRequest({});
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/channels/ha/users");
});

test("PR8: ha__user_info → GET /users/:id; rejects empty id", () => {
  const t = getTool("ha__user_info");
  assert.equal(t.inputSchema.safeParse({ user_id: "abc123" }).success, true);
  assert.equal(t.inputSchema.safeParse({ user_id: "" }).success, false);
  assert.equal(t.inputSchema.safeParse({}).success, false);
  const req = t.buildRequest({ user_id: "u_abc" });
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/channels/ha/users/u_abc");
});

test("PR8: ha__create_user requires name + decision_ref", () => {
  const t = getTool("ha__create_user");
  // Missing decision_ref
  assert.equal(t.inputSchema.safeParse({ name: "Kid" }).success, false);
  // Bad decision_ref shape
  assert.equal(
    t.inputSchema.safeParse({ name: "Kid", decision_ref: "x" }).success,
    false,
  );
  // Bad name (control char)
  assert.equal(
    t.inputSchema.safeParse({
      name: "K\x01id",
      decision_ref: "decision/2026-05-29-kid.md",
    }).success,
    false,
  );
  // OK
  const ok = t.inputSchema.safeParse({
    name: "Kid",
    group_ids: ["system-read-only"],
    decision_ref: "decision/2026-05-29-kid.md",
  });
  assert.equal(ok.success, true);
  const req = t.buildRequest(ok.data);
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/channels/ha/users");
  assert.deepEqual(req.body, {
    name: "Kid",
    group_ids: ["system-read-only"],
    decision_ref: "decision/2026-05-29-kid.md",
  });
});

test("PR8: ha__update_user accepts is_active flip without name", () => {
  const t = getTool("ha__update_user");
  const ok = t.inputSchema.safeParse({
    user_id: "u_abc",
    is_active: false,
    decision_ref: "decision/2026-05-29-deactivate.md",
  });
  assert.equal(ok.success, true);
  const req = t.buildRequest(ok.data);
  assert.equal(req.method, "PUT");
  assert.equal(req.path, "/api/v1/channels/ha/users/u_abc");
  assert.deepEqual(req.body, {
    is_active: false,
    decision_ref: "decision/2026-05-29-deactivate.md",
  });
});

test("PR8: ha__delete_user → DELETE with decision_ref in query", () => {
  const t = getTool("ha__delete_user");
  assert.equal(
    t.inputSchema.safeParse({ user_id: "u_abc" }).success,
    false,
    "must require decision_ref",
  );
  const ok = t.inputSchema.safeParse({
    user_id: "u_abc",
    decision_ref: "decision/2026-05-29-drop.md",
  });
  assert.equal(ok.success, true);
  const req = t.buildRequest(ok.data);
  assert.equal(req.method, "DELETE");
  assert.equal(req.path, "/api/v1/channels/ha/users/u_abc");
  assert.deepEqual(req.query, { decision_ref: "decision/2026-05-29-drop.md" });
});

test("PR8: ha__mint_llat sends ?safe=1 — token NEVER returned to the model", () => {
  const t = getTool("ha__mint_llat");
  // Description must carry the load-bearing rule.
  assert.match(
    t.description,
    /NEVER include.+minted LLAT|MASKING IS LOAD-BEARING/i,
    "ha__mint_llat description must spell out the masking rule",
  );
  const ok = t.inputSchema.safeParse({
    user_id: "u_abc",
    client_name: "alfred-mcp",
    decision_ref: "decision/2026-05-29-mint.md",
  });
  assert.equal(ok.success, true);
  const req = t.buildRequest(ok.data);
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/channels/ha/users/u_abc/llat");
  // `?safe=1` MUST be set — this is the kill switch that stops the raw
  // token from being included in the route response.
  assert.equal(req.query?.safe, "1");
  assert.deepEqual(req.body, {
    client_name: "alfred-mcp",
    decision_ref: "decision/2026-05-29-mint.md",
  });
});

test("PR8: ha__mint_llat lifespan_days bounds", () => {
  const t = getTool("ha__mint_llat");
  // Zero / negative rejected.
  assert.equal(
    t.inputSchema.safeParse({
      user_id: "u_abc",
      client_name: "x",
      lifespan_days: 0,
      decision_ref: "decision/2026-05-29-mint.md",
    }).success,
    false,
  );
  assert.equal(
    t.inputSchema.safeParse({
      user_id: "u_abc",
      client_name: "x",
      lifespan_days: -1,
      decision_ref: "decision/2026-05-29-mint.md",
    }).success,
    false,
  );
  // 10y boundary.
  assert.equal(
    t.inputSchema.safeParse({
      user_id: "u_abc",
      client_name: "x",
      lifespan_days: 365 * 10,
      decision_ref: "decision/2026-05-29-mint.md",
    }).success,
    true,
  );
  // 1d ok.
  assert.equal(
    t.inputSchema.safeParse({
      user_id: "u_abc",
      client_name: "x",
      lifespan_days: 1,
      decision_ref: "decision/2026-05-29-mint.md",
    }).success,
    true,
  );
});

test("PR8: ha__list_user_llats → GET /users/:id/llat (no decision_ref)", () => {
  const t = getTool("ha__list_user_llats");
  const ok = t.inputSchema.safeParse({ user_id: "u_abc" });
  assert.equal(ok.success, true);
  const req = t.buildRequest(ok.data);
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/channels/ha/users/u_abc/llat");
});

test("PR8: ha__revoke_llat → DELETE /users/:id/llat/:token_id", () => {
  const t = getTool("ha__revoke_llat");
  assert.equal(
    t.inputSchema.safeParse({
      user_id: "u_abc",
      ha_token_id: "tok_xyz",
    }).success,
    false,
    "must require decision_ref",
  );
  const ok = t.inputSchema.safeParse({
    user_id: "u_abc",
    ha_token_id: "tok_xyz",
    decision_ref: "decision/2026-05-29-revoke.md",
  });
  assert.equal(ok.success, true);
  const req = t.buildRequest(ok.data);
  assert.equal(req.method, "DELETE");
  assert.equal(req.path, "/api/v1/channels/ha/users/u_abc/llat/tok_xyz");
  assert.deepEqual(req.query, { decision_ref: "decision/2026-05-29-revoke.md" });
});

test("PR8: every user tool name begins with ha__ and is unique", () => {
  const names = HASS_USER_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.ok(n.startsWith("ha__"));
});

test("PR8: destructive verbs require decision_ref by schema", () => {
  const destructive = [
    "ha__create_user",
    "ha__update_user",
    "ha__delete_user",
    "ha__mint_llat",
    "ha__revoke_llat",
  ];
  for (const name of destructive) {
    const t = getTool(name);
    // None of these schemas allow decision_ref absent.
    const sample: Record<string, unknown> =
      name === "ha__create_user"
        ? { name: "X" }
        : name === "ha__update_user"
          ? { user_id: "u_abc", name: "X" }
          : name === "ha__delete_user"
            ? { user_id: "u_abc" }
            : name === "ha__mint_llat"
              ? { user_id: "u_abc", client_name: "x" }
              : { user_id: "u_abc", ha_token_id: "t" };
    assert.equal(
      t.inputSchema.safeParse(sample).success,
      false,
      `${name} must require decision_ref`,
    );
  }
});

test("PR8: ha__mint_llat response shape MUST be redacted (the model never sees token values)", () => {
  // This test pins the documentation-side contract — the description
  // tells the LLM "NEVER include a minted LLAT in any user-facing
  // response". The runtime guarantee lives at the ctrl-api layer
  // (`?safe=1` strips the token), tested separately in
  // tests/channels_ha_users.test.ts.
  const t = getTool("ha__mint_llat");
  assert.match(t.description, /NEVER include|llat_vw_id|vault id is the receipt/i);
  assert.match(t.description, /MASKING IS LOAD-BEARING|redacted: true/i);
});

// ═════════════════════════════════════════════════════════════════════════
// === Tier 4 PR5: HACS tool unit tests ===
// ═════════════════════════════════════════════════════════════════════════
//
// 11 tests covering the 8 PR5 HACS tools:
//   1. all 8 names exist in HASS_HACS_TOOLS
//   2-9. one buildRequest + schema test per tool
//   10. gated tools (install/remove) call out decision_ref in description
//   11. non-gated tools accept input without decision_ref

const HACS_TOOL_NAMES = [
  "ha__hacs_info",
  "ha__hacs_search",
  "ha__hacs_repo_info",
  "ha__hacs_add_custom_repo",
  "ha__hacs_install",
  "ha__hacs_remove",
  "ha__hacs_refresh",
  "ha__hacs_pending_updates",
];

test("HACS PR5: all 8 tool names present in HASS_HACS_TOOLS", () => {
  for (const name of HACS_TOOL_NAMES) {
    assert.ok(
      HASS_HACS_TOOLS.find((t) => t.name === name),
      `${name} missing from HASS_HACS_TOOLS`,
    );
  }
});

test("ha__hacs_info: empty input schema, GET /hacs/info", () => {
  const t = getTool("ha__hacs_info");
  assert.equal(t.inputSchema.safeParse({}).success, true);
  const r = t.buildRequest({});
  assert.equal(r.method, "GET");
  assert.equal(r.path, "/api/v1/channels/ha/hacs/info");
});

test("ha__hacs_search: optional query/category/installed/limit, builds GET /hacs/repos", () => {
  const t = getTool("ha__hacs_search");
  // Empty is valid (limit defaults).
  assert.equal(t.inputSchema.safeParse({}).success, true);
  // Bad category rejected.
  assert.equal(
    t.inputSchema.safeParse({ category: "bogus" }).success,
    false,
  );
  // Limit out of range rejected.
  assert.equal(
    t.inputSchema.safeParse({ limit: 999 }).success,
    false,
  );
  const r1 = t.buildRequest({
    query: "thermostat",
    category: "integration",
    installed: true,
    limit: 25,
  });
  assert.equal(r1.method, "GET");
  assert.equal(r1.path, "/api/v1/channels/ha/hacs/repos");
  assert.deepEqual(r1.query, {
    q: "thermostat",
    category: "integration",
    installed: "1",
    limit: "25",
  });
  // No filters → bare query
  const r2 = t.buildRequest({ limit: 50 });
  assert.deepEqual(r2.query, { limit: "50" });
});

test("ha__hacs_repo_info: repo_id required, encodeURIComponent applied", () => {
  const t = getTool("ha__hacs_repo_info");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  // Bad charset rejected at the schema level (no traversal possible).
  assert.equal(
    t.inputSchema.safeParse({ repo_id: "../bad" }).success,
    false,
  );
  const r = t.buildRequest({ repo_id: "42" });
  assert.equal(r.method, "GET");
  assert.equal(r.path, "/api/v1/channels/ha/hacs/repo/42");
});

test("ha__hacs_add_custom_repo: url + category required, both shapes accepted", () => {
  const t = getTool("ha__hacs_add_custom_repo");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({ url: "not a url", category: "integration" })
      .success,
    false,
    "bad url rejected",
  );
  assert.equal(
    t.inputSchema.safeParse({ url: "user/repo", category: "bogus" }).success,
    false,
    "bad category rejected",
  );
  // owner/repo form
  const r1 = t.buildRequest({ url: "user/x", category: "integration" });
  assert.equal(r1.method, "POST");
  assert.equal(r1.path, "/api/v1/channels/ha/hacs/repos");
  assert.deepEqual(r1.body, { url: "user/x", category: "integration" });
  // Full URL form
  const r2 = t.buildRequest({
    url: "https://github.com/user/x",
    category: "plugin",
  });
  assert.equal(r2.body!.url, "https://github.com/user/x");
});

test("ha__hacs_install: decision_ref REQUIRED, version optional, body shape", () => {
  const t = getTool("ha__hacs_install");
  // Missing decision_ref rejected at schema level.
  assert.equal(
    t.inputSchema.safeParse({ repo_id: "1" }).success,
    false,
    "missing decision_ref → schema reject",
  );
  // Bad decision_ref shape rejected (whitespace).
  assert.equal(
    t.inputSchema.safeParse({
      repo_id: "1",
      decision_ref: "with space",
    }).success,
    false,
  );
  const r1 = t.buildRequest({
    repo_id: "1",
    decision_ref: "01JABC0000000000000000001",
  });
  assert.equal(r1.method, "POST");
  assert.equal(r1.path, "/api/v1/channels/ha/hacs/install");
  assert.deepEqual(r1.body, {
    repo_id: "1",
    decision_ref: "01JABC0000000000000000001",
  });
  const r2 = t.buildRequest({
    repo_id: "1",
    version: "1.0.0",
    decision_ref: "01JABC0000000000000000001",
  });
  assert.equal(r2.body!.version, "1.0.0");
});

test("ha__hacs_remove: decision_ref REQUIRED, DELETE with encodeURIComponent on id", () => {
  const t = getTool("ha__hacs_remove");
  assert.equal(t.inputSchema.safeParse({ repo_id: "1" }).success, false);
  const r = t.buildRequest({
    repo_id: "42",
    decision_ref: "01JABC0000000000000000001",
  });
  assert.equal(r.method, "DELETE");
  assert.equal(r.path, "/api/v1/channels/ha/hacs/42");
  assert.deepEqual(r.body, { decision_ref: "01JABC0000000000000000001" });
});

test("ha__hacs_refresh: repo_id only, POST + empty body", () => {
  const t = getTool("ha__hacs_refresh");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  const r = t.buildRequest({ repo_id: "5" });
  assert.equal(r.method, "POST");
  assert.equal(r.path, "/api/v1/channels/ha/hacs/5/refresh");
  assert.deepEqual(r.body, {});
});

test("ha__hacs_pending_updates: GET with pending=1, limit honoured", () => {
  const t = getTool("ha__hacs_pending_updates");
  // Defaulted limit means empty input is valid.
  assert.equal(t.inputSchema.safeParse({}).success, true);
  const r = t.buildRequest({ limit: 25 });
  assert.equal(r.method, "GET");
  assert.equal(r.path, "/api/v1/channels/ha/hacs/repos");
  assert.deepEqual(r.query, { pending: "1", limit: "25" });
});

test("HACS PR5: gated tools (install/remove) advertise decision_ref in description", () => {
  for (const name of ["ha__hacs_install", "ha__hacs_remove"]) {
    const t = getTool(name);
    assert.ok(
      /decision_ref/i.test(t.description),
      `${name} description must call out decision_ref`,
    );
  }
});

test("HACS PR5: non-gated tools (info/search/repo_info/add_custom_repo/refresh/pending_updates) DO NOT require decision_ref", () => {
  for (const name of [
    "ha__hacs_info",
    "ha__hacs_search",
    "ha__hacs_repo_info",
    "ha__hacs_add_custom_repo",
    "ha__hacs_refresh",
    "ha__hacs_pending_updates",
  ]) {
    const t = getTool(name);
    const sample: Record<string, unknown> = {};
    if (name === "ha__hacs_repo_info") sample.repo_id = "1";
    if (name === "ha__hacs_add_custom_repo") {
      sample.url = "user/x";
      sample.category = "integration";
    }
    if (name === "ha__hacs_refresh") sample.repo_id = "1";
    // No decision_ref in any of these.
    const r = t.inputSchema.safeParse(sample);
    assert.equal(r.success, true, `${name} must accept input WITHOUT decision_ref`);
  }
});

// ─── #115 PR2 — registries CRUD tools (areas/devices/entities/labels) ──

const PR2_TOOL_NAMES = [
  "ha__area_create",
  "ha__area_update",
  "ha__area_delete",
  "ha__device_set_area",
  "ha__device_set_name",
  "ha__device_disable",
  "ha__device_label",
  "ha__entity_rename",
  "ha__entity_set_area",
  "ha__entity_hide",
  "ha__entity_disable",
  "ha__entity_label",
  "ha__label_create",
  "ha__label_update",
  "ha__label_delete",
  "ha__label_apply",
];

test("PR2: every registries tool is registered and unique", () => {
  for (const name of PR2_TOOL_NAMES) {
    const t = HASS_PR2_TOOLS.find((x) => x.name === name);
    assert.ok(t, `${name} missing from HASS_PR2_TOOLS`);
  }
  const names = HASS_PR2_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  // No tool name from PR2 collides with an earlier wave.
  for (const t of HASS_PR2_TOOLS) {
    const matches = ALL_HASS_TOOLS.filter((x) => x.name === t.name).length;
    assert.equal(matches, 1, `${t.name} must appear exactly once in ALL_HASS_TOOLS`);
  }
});

test("PR2 ha__area_create: name required; POST /areas; optional fields ride along", () => {
  const t = getTool("ha__area_create");
  assert.equal(t.inputSchema.safeParse({}).success, false, "name required");
  const minimal = { name: "Garage" };
  assert.equal(t.inputSchema.safeParse(minimal).success, true);
  const r1 = t.buildRequest(minimal);
  assert.equal(r1.method, "POST");
  assert.equal(r1.path, "/api/v1/channels/ha/areas");
  assert.deepEqual(r1.body, { name: "Garage" });
  // optional fields pass through.
  const full = {
    name: "Master Bedroom",
    icon: "mdi:bed",
    picture: "/local/master.jpg",
    floor_id: "upstairs",
    aliases: ["main bedroom", "our room"],
    labels: ["bedtime"],
  };
  assert.equal(t.inputSchema.safeParse(full).success, true);
  const r2 = t.buildRequest(full);
  assert.deepEqual(r2.body, full);
});

test("PR2 ha__area_update: area_id required, optional name/icon/etc.; PUT /areas/:id", () => {
  const t = getTool("ha__area_update");
  assert.equal(t.inputSchema.safeParse({}).success, false, "area_id required");
  // bad id chars rejected.
  assert.equal(
    t.inputSchema.safeParse({ area_id: "../etc" }).success,
    false,
    "URL-traversal guard",
  );
  // valid with just area_id.
  const minimal = { area_id: "kitchen" };
  assert.equal(t.inputSchema.safeParse(minimal).success, true);
  const r1 = t.buildRequest(minimal);
  assert.equal(r1.method, "PUT");
  assert.equal(r1.path, "/api/v1/channels/ha/areas/kitchen");
  assert.deepEqual(r1.body, {});
  // null icon clears the icon (HA semantics).
  const withNull = { area_id: "kitchen", icon: null, name: "Lounge" };
  assert.equal(t.inputSchema.safeParse(withNull).success, true);
  const r2 = t.buildRequest(withNull);
  assert.deepEqual(r2.body, { name: "Lounge", icon: null });
});

test("PR2 ha__area_delete: area_id required, NO body, DELETE /areas/:id", () => {
  const t = getTool("ha__area_delete");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  const r = t.buildRequest({ area_id: "kitchen" });
  assert.equal(r.method, "DELETE");
  assert.equal(r.path, "/api/v1/channels/ha/areas/kitchen");
  assert.equal(r.body, undefined);
});

test("PR2 ha__device_set_area: device_id + area_id (nullable); PUT /devices/:id with area_id only", () => {
  const t = getTool("ha__device_set_area");
  // both required.
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({ device_id: "abc123" }).success,
    false,
    "area_id required (null allowed)",
  );
  // null area_id is valid (unassign).
  const unassign = { device_id: "abc123def456", area_id: null };
  assert.equal(t.inputSchema.safeParse(unassign).success, true);
  const r1 = t.buildRequest(unassign);
  assert.equal(r1.method, "PUT");
  assert.equal(r1.path, "/api/v1/channels/ha/devices/abc123def456");
  assert.deepEqual(r1.body, { area_id: null });
  // string area_id.
  const r2 = t.buildRequest({ device_id: "abc123def456", area_id: "garage" });
  assert.deepEqual(r2.body, { area_id: "garage" });
});

test("PR2 ha__device_set_name: PUT /devices/:id with name_by_user; null restores integration name", () => {
  const t = getTool("ha__device_set_name");
  // null name is valid (clear).
  const args = { device_id: "abc123", name: "Living Room Sconce" };
  assert.equal(t.inputSchema.safeParse(args).success, true);
  const r = t.buildRequest(args);
  assert.equal(r.method, "PUT");
  assert.equal(r.path, "/api/v1/channels/ha/devices/abc123");
  assert.deepEqual(r.body, { name_by_user: "Living Room Sconce" });
  // null clears.
  const clear = { device_id: "abc123", name: null };
  assert.equal(t.inputSchema.safeParse(clear).success, true);
  assert.deepEqual(t.buildRequest(clear).body, { name_by_user: null });
});

test("PR2 ha__device_disable: PUT /devices/:id with disabled_by; only 'user'/null sane values", () => {
  const t = getTool("ha__device_disable");
  // 'user' valid.
  assert.equal(
    t.inputSchema.safeParse({ device_id: "abc", disabled_by: "user" }).success,
    true,
  );
  // null valid (re-enable).
  assert.equal(
    t.inputSchema.safeParse({ device_id: "abc", disabled_by: null }).success,
    true,
  );
  // bogus enum value rejected.
  assert.equal(
    t.inputSchema.safeParse({ device_id: "abc", disabled_by: "alfred" })
      .success,
    false,
  );
  const r = t.buildRequest({ device_id: "abc", disabled_by: "user" });
  assert.equal(r.path, "/api/v1/channels/ha/devices/abc");
  assert.deepEqual(r.body, { disabled_by: "user" });
});

test("PR2 ha__device_label: full-replace labels; PUT /devices/:id with labels array", () => {
  const t = getTool("ha__device_label");
  // labels required.
  assert.equal(t.inputSchema.safeParse({ device_id: "abc" }).success, false);
  // empty array is valid (clears labels).
  assert.equal(
    t.inputSchema.safeParse({ device_id: "abc", labels: [] }).success,
    true,
  );
  const args = { device_id: "abc", labels: ["critical", "bedtime"] };
  assert.equal(t.inputSchema.safeParse(args).success, true);
  const r = t.buildRequest(args);
  assert.equal(r.method, "PUT");
  assert.deepEqual(r.body, { labels: ["critical", "bedtime"] });
});

test("PR2 ha__entity_rename: entity_id (dotted) + name (nullable); PUT /entities/:id", () => {
  const t = getTool("ha__entity_rename");
  // bad entity_id format rejected.
  assert.equal(
    t.inputSchema.safeParse({ entity_id: "NoDot", name: "x" }).success,
    false,
  );
  assert.equal(
    t.inputSchema.safeParse({ entity_id: "light.kitchen_main", name: "Kitchen Main" })
      .success,
    true,
  );
  const r = t.buildRequest({
    entity_id: "light.kitchen_main",
    name: "Kitchen Main",
    icon: "mdi:lightbulb",
  });
  assert.equal(r.method, "PUT");
  assert.equal(r.path, "/api/v1/channels/ha/entities/light.kitchen_main");
  assert.deepEqual(r.body, { name: "Kitchen Main", icon: "mdi:lightbulb" });
});

test("PR2 ha__entity_set_area: PUT /entities/:id with area_id; null clears the override", () => {
  const t = getTool("ha__entity_set_area");
  assert.equal(
    t.inputSchema.safeParse({ entity_id: "light.kitchen_main", area_id: "kitchen" })
      .success,
    true,
  );
  assert.equal(
    t.inputSchema.safeParse({ entity_id: "light.kitchen_main", area_id: null })
      .success,
    true,
  );
  const r = t.buildRequest({
    entity_id: "light.kitchen_main",
    area_id: "kitchen",
  });
  assert.equal(r.method, "PUT");
  assert.equal(r.path, "/api/v1/channels/ha/entities/light.kitchen_main");
  assert.deepEqual(r.body, { area_id: "kitchen" });
});

test("PR2 ha__entity_hide and ha__entity_disable: PUT /entities/:id with the right field", () => {
  const tHide = getTool("ha__entity_hide");
  const rHide = tHide.buildRequest({
    entity_id: "binary_sensor.diag_n",
    hidden_by: "user",
  });
  assert.deepEqual(rHide.body, { hidden_by: "user" });
  // bogus enum rejected.
  assert.equal(
    tHide.inputSchema.safeParse({
      entity_id: "binary_sensor.x",
      hidden_by: "alfred",
    }).success,
    false,
  );

  const tDis = getTool("ha__entity_disable");
  const rDis = tDis.buildRequest({
    entity_id: "sensor.cloud_thing",
    disabled_by: null,
  });
  assert.deepEqual(rDis.body, { disabled_by: null });
});

test("PR2 ha__entity_label: PUT /entities/:id with labels array", () => {
  const t = getTool("ha__entity_label");
  const args = { entity_id: "light.kitchen_main", labels: ["security"] };
  assert.equal(t.inputSchema.safeParse(args).success, true);
  const r = t.buildRequest(args);
  assert.equal(r.path, "/api/v1/channels/ha/entities/light.kitchen_main");
  assert.deepEqual(r.body, { labels: ["security"] });
});

test("PR2 ha__label_create: name required; POST /labels with optional fields", () => {
  const t = getTool("ha__label_create");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  const minimal = { name: "Bedtime" };
  assert.equal(t.inputSchema.safeParse(minimal).success, true);
  assert.deepEqual(t.buildRequest(minimal).body, { name: "Bedtime" });
  const full = {
    name: "Critical",
    color: "red",
    icon: "mdi:alert",
    description: "Devices that must always work.",
  };
  assert.equal(t.inputSchema.safeParse(full).success, true);
  const r = t.buildRequest(full);
  assert.equal(r.method, "POST");
  assert.equal(r.path, "/api/v1/channels/ha/labels");
  assert.deepEqual(r.body, full);
});

test("PR2 ha__label_update and ha__label_delete: PUT and DELETE /labels/:id", () => {
  const tUpd = getTool("ha__label_update");
  assert.equal(tUpd.inputSchema.safeParse({}).success, false);
  const upd = {
    label_id: "bedtime",
    name: "Evening Routine",
    color: null,
    icon: "mdi:weather-night",
  };
  assert.equal(tUpd.inputSchema.safeParse(upd).success, true);
  const rUpd = tUpd.buildRequest(upd);
  assert.equal(rUpd.method, "PUT");
  assert.equal(rUpd.path, "/api/v1/channels/ha/labels/bedtime");
  assert.deepEqual(rUpd.body, {
    name: "Evening Routine",
    color: null,
    icon: "mdi:weather-night",
  });

  const tDel = getTool("ha__label_delete");
  assert.equal(tDel.inputSchema.safeParse({}).success, false);
  const rDel = tDel.buildRequest({ label_id: "bedtime" });
  assert.equal(rDel.method, "DELETE");
  assert.equal(rDel.path, "/api/v1/channels/ha/labels/bedtime");
  assert.equal(rDel.body, undefined);
});

test("PR2 ha__label_apply: target_kind routes to the right registry PUT, body carries [label_id]", () => {
  const t = getTool("ha__label_apply");
  // bad enum rejected.
  assert.equal(
    t.inputSchema.safeParse({
      target_kind: "thingie",
      target_id: "x",
      label_id: "y",
    }).success,
    false,
  );
  // area.
  const rA = t.buildRequest({
    target_kind: "area",
    target_id: "kitchen",
    label_id: "critical",
  });
  assert.equal(rA.path, "/api/v1/channels/ha/areas/kitchen");
  assert.deepEqual(rA.body, { labels: ["critical"] });
  // device.
  const rD = t.buildRequest({
    target_kind: "device",
    target_id: "abc123",
    label_id: "bedtime",
  });
  assert.equal(rD.path, "/api/v1/channels/ha/devices/abc123");
  assert.deepEqual(rD.body, { labels: ["bedtime"] });
  // entity.
  const rE = t.buildRequest({
    target_kind: "entity",
    target_id: "light.kitchen_main",
    label_id: "security",
  });
  assert.equal(rE.path, "/api/v1/channels/ha/entities/light.kitchen_main");
  assert.deepEqual(rE.body, { labels: ["security"] });
});

test("PR2: every tool description has 'No approval gate' AND mentions a list-tool resolution hint", () => {
  // Sir's locked YES: cheap reversible verbs run free. Tests pin the
  // tool docs so a future agent doesn't quietly add a gate.
  for (const t of HASS_PR2_TOOLS) {
    assert.ok(
      /no approval gate/i.test(t.description),
      `${t.name} description must say 'No approval gate' to pin the locked-YES default`,
    );
  }
  // Resolution hints — every CRUD tool whose id comes from the principal
  // (device/entity/label updates) should point at the list endpoint that
  // resolves the id. Areas are slug-shaped + small in number so the
  // mention isn't strictly required for area updates/deletes.
  const ID_TOOL_HINTS: Record<string, RegExp> = {
    ha__device_set_area: /ha__list_devices|ha__list_areas/,
    ha__device_set_name: /ha__list_devices/,
    ha__device_label: /ha__list_devices/,
    ha__entity_rename: /ha__list_entities/,
    ha__entity_set_area: /ha__list_entities|ha__list_areas/,
    ha__entity_label: /ha__list_entities/,
    ha__label_update: /ha__list_labels/,
    ha__label_delete: /ha__list_labels/,
  };
  for (const [name, re] of Object.entries(ID_TOOL_HINTS)) {
    const t = getTool(name);
    assert.ok(
      re.test(t.description),
      `${name} description should hint at the list tool that resolves ids (${re})`,
    );
  }
});
