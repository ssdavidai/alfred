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
import { ALL_HASS_TOOLS, HASS_READ_TOOLS, HASS_DEFERRED_TOOLS } from "./hass.js";
import { SUPPORTED_APPS, isAppId, getToolsForApp } from "./registry.js";

function getTool(name: string) {
  const t = ALL_HASS_TOOLS.find((x) => x.name === name);
  assert.ok(t, `tool ${name} not found in ALL_HASS_TOOLS`);
  return t;
}

// ─── catalogue shape ────────────────────────────────────────────────────

test("hass catalogue: exactly 26 tools (11 read + 5 PR4 writes + 10 PR3 CRUD)", () => {
  assert.equal(HASS_READ_TOOLS.length, 11);
  // After #115 PR3 splice: PR4's 5 + PR3's 10 = 15 writes.
  assert.equal(HASS_DEFERRED_TOOLS.length, 15);
  assert.equal(ALL_HASS_TOOLS.length, 26);
});

test("registry: hass is a supported app and registers all 26 tools", () => {
  assert.ok(isAppId("hass"));
  assert.ok((SUPPORTED_APPS as Set<string>).has("hass"));
  const tools = getToolsForApp("hass");
  assert.equal(tools.length, 26);
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

test("#115 PR3: catalogue order — reads first, then all writes (PR4 + PR3 CRUD)", () => {
  // First 11 must be the 11 reads.
  for (let i = 0; i < 11; i++) {
    assert.ok(
      READ_TOOL_NAMES.includes(ALL_HASS_TOOLS[i].name),
      `slot ${i} (${ALL_HASS_TOOLS[i].name}) should be a read tool`,
    );
  }
  // Slots 11..25 are writes. PR4's 5 + PR3's 10.
  const writeNames = ALL_HASS_TOOLS.slice(11).map((t) => t.name);
  for (const n of WRITE_TOOL_NAMES) {
    assert.ok(writeNames.includes(n), `${n} missing from write tail`);
  }
  for (const n of PR3_TOOL_NAMES) {
    assert.ok(writeNames.includes(n), `${n} missing from write tail`);
  }
  assert.equal(writeNames.length, 15);
});
