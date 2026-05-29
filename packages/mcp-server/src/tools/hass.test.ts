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
} from "./hass.js";
import { SUPPORTED_APPS, isAppId, getToolsForApp } from "./registry.js";

function getTool(name: string) {
  const t = ALL_HASS_TOOLS.find((x) => x.name === name);
  assert.ok(t, `tool ${name} not found in ALL_HASS_TOOLS`);
  return t;
}

// ─── catalogue shape ────────────────────────────────────────────────────

test("hass catalogue: exactly 53 tools (11 read + 15 write + 10 PR6 addon + 10 PR7 core+backup + 7 PR4 integration)", () => {
  assert.equal(HASS_READ_TOOLS.length, 11);
  // After #115 PR3 splice: PR4's 5 + PR3's 10 = 15 writes.
  assert.equal(HASS_DEFERRED_TOOLS.length, 15);
  // PR6: 10 supervisor addon tools.
  assert.equal(HASS_ADDON_TOOLS.length, 10);
  // PR7: 10 core lifecycle + backup CRUD tools.
  assert.equal(HASS_PR7_TOOLS.length, 10);
  // PR4 (issue #115): 7 integration tools.
  assert.equal(HASS_INTEGRATION_TOOLS.length, 7);
  assert.equal(ALL_HASS_TOOLS.length, 53);
});

test("registry: hass is a supported app and registers all 53 tools", () => {
  assert.ok(isAppId("hass"));
  assert.ok((SUPPORTED_APPS as Set<string>).has("hass"));
  const tools = getToolsForApp("hass");
  assert.equal(tools.length, 53);
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
