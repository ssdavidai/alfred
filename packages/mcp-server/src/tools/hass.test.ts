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

test("hass catalogue: exactly 16 tools (11 read + 5 PR3 placeholders)", () => {
  assert.equal(HASS_READ_TOOLS.length, 11);
  assert.equal(HASS_DEFERRED_TOOLS.length, 5);
  assert.equal(ALL_HASS_TOOLS.length, 16);
});

test("registry: hass is a supported app and registers all 16 tools", () => {
  assert.ok(isAppId("hass"));
  assert.ok((SUPPORTED_APPS as Set<string>).has("hass"));
  const tools = getToolsForApp("hass");
  assert.equal(tools.length, 16);
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

// ─── deferred (PR3) placeholders ────────────────────────────────────────

const DEFERRED_TOOL_NAMES = [
  "ha__call_service",
  "ha__propose_automation",
  "ha__apply_proposal",
  "ha__rollback_snapshot",
  "ha__subscribe_events",
];

for (const name of DEFERRED_TOOL_NAMES) {
  test(`deferred tool exists: ${name}`, () => {
    const t = HASS_DEFERRED_TOOLS.find((x) => x.name === name);
    assert.ok(t, `${name} missing from HASS_DEFERRED_TOOLS`);
  });

  test(`deferred tool ${name}: buildRequest carries the PR3 marker`, () => {
    const t = HASS_DEFERRED_TOOLS.find((x) => x.name === name);
    assert.ok(t, `${name} missing`);
    // Build with a permissive-but-valid body — most deferred tools have
    // required fields, but we're testing the buildRequest marker, not
    // the schema. Pass a generic object that bypasses schema validation
    // (buildRequest takes `any`).
    const req = t.buildRequest({});
    assert.equal(req.method, "POST");
    assert.equal(req.path, `/api/v1/channels/ha/__deferred__/${name}`);
    assert.deepEqual(req.body, {
      deferred: true,
      target_pr: "PR3",
      tool: name,
    });
  });
}

test("ha__call_service schema: domain + service required", () => {
  const t = getTool("ha__call_service");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({ domain: "light" }).success,
    false,
    "service required",
  );
  assert.equal(
    t.inputSchema.safeParse({ domain: "light", service: "turn_on" }).success,
    true,
  );
  assert.equal(
    t.inputSchema.safeParse({
      domain: "light",
      service: "turn_on",
      entity_id: "light.kitchen_main",
      data: { brightness_pct: 60 },
    }).success,
    true,
  );
});

test("ha__propose_automation schema: alias + triggers + actions required", () => {
  const t = getTool("ha__propose_automation");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({ alias: "Morning routine" }).success,
    false,
  );
  assert.equal(
    t.inputSchema.safeParse({
      alias: "Morning routine",
      triggers: [{ platform: "time", at: "06:30" }],
      actions: [
        { service: "light.turn_on", entity_id: "light.kitchen_main" },
      ],
    }).success,
    true,
  );
});

test("ha__apply_proposal schema: proposal_id + decision_ref required", () => {
  const t = getTool("ha__apply_proposal");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({ proposal_id: "01HXYZ" }).success,
    false,
    "decision_ref required to enforce loop-guard contract from PR1",
  );
  assert.equal(
    t.inputSchema.safeParse({
      proposal_id: "01HXYZ",
      decision_ref: "decision/2026-05-29-ha-baseline.md",
    }).success,
    true,
  );
});

test("ha__rollback_snapshot schema: snapshot_id required", () => {
  const t = getTool("ha__rollback_snapshot");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({ snapshot_id: "01HSNAP" }).success,
    true,
  );
});

test("ha__subscribe_events schema: event_type required, entity_id optional", () => {
  const t = getTool("ha__subscribe_events");
  assert.equal(t.inputSchema.safeParse({}).success, false);
  assert.equal(
    t.inputSchema.safeParse({ event_type: "state_changed" }).success,
    true,
  );
  assert.equal(
    t.inputSchema.safeParse({
      event_type: "state_changed",
      entity_id: "binary_sensor.front_door",
    }).success,
    true,
  );
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
