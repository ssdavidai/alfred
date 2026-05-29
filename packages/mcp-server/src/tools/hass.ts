// Home Assistant MCP tool catalogue — the 7th MCP app on the Alfred stdio
// bundle, sitting alongside alfred / sure / plane / vaultwarden / execute
// / hermes. Lands the principal's HA install as a first-class operator
// surface so the voice/text Alfred can answer "is the kitchen window
// open?" and "set the bedroom to 21°" without the principal ever opening
// HA's own UI.
//
// SPEC: docs/specs/issue-110-ha-deep-integration.md §3 (MCP surface) +
//       §5 (the seven /api/v1/channels/ha/* contracts) +
//       §6 PR2 (this PR's scope).
//
// This file ships ONLY the read-side wave of the tool catalogue. The write
// half — ha__call_service, ha__propose_automation, ha__apply_proposal,
// ha__rollback_snapshot, ha__subscribe_events — is reserved for PR3 and
// stubbed below as `{ deferred: true, target_pr: "PR3" }` placeholders so
// the catalogue's shape is final from PR2 forward (no rename + skill-file
// churn between PR2 and PR3). The placeholders are intentionally callable:
// a workers-profile agent that picks one up gets a deterministic
// "this lands in PR3" response instead of a tool-not-found error.
//
// ──────────────────────────────────────────────────────────────────────
// Loop-guard contract — what PR3 inherits from PR1, restated here so the
// reader of this file sees it (the spec lives in
// packages/ctrl/src/db/migrations/0005_ha_channel.sql header).
// ──────────────────────────────────────────────────────────────────────
//
// Every PR3 write tool will:
//
//   1. mint a `decision_ref` (ulid) BEFORE the upstream HA call,
//   2. persist a row in `ha_run` keyed (entity_id, created_at,
//      decision_ref) BEFORE the upstream HA call,
//   3. then issue the HA REST/WS request.
//
// HaWatcherWorkflow (lands separately in PR3 alongside ha__subscribe_events)
// uses the partial index `idx_ha_run_entity_recent` from migration 0005 to
// SUPPRESS state_changed events that fall inside a 30s window of an
// Alfred-originated write. Without this guard, Alfred toggling the kitchen
// light would echo back as a signal → Desk card → propose chore → call
// ha__call_service again. A closed loop.
//
// PR2 does not write — but the file header reserves the contract so any
// PR3 implementer reads this comment block before touching a write tool.

import { z } from "zod";
import type { ToolDef } from "./types.js";

// ─── shared schema fragments ────────────────────────────────────────────

const EntityIdParam = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9_]+\.[a-z0-9_]+$/,
    "entity_id must be HA's dotted form, e.g. `light.kitchen_main`",
  )
  .describe(
    "An HA entity id in dotted form `<domain>.<object_id>` (e.g. `light.kitchen_main`, `binary_sensor.front_door`). NEVER invent these — resolve via `ha__list_entities` or `ha__resolve_entity` first.",
  );

// The marker every PR3-deferred tool returns so callers can distinguish
// "tool not implemented yet" from "tool failed at runtime".
const DEFERRED_MARKER = { deferred: true, target_pr: "PR3" } as const;

// Helper: build a ProxyOptions that lands on a synthetic ctrl-api route
// which doesn't exist yet. Each deferred tool wires the same path it
// WILL hit in PR3 so the catalogue's surface area is the spec-final
// shape. Until PR3 wires those routes, the call returns 404 from
// ctrl-api — but the description block tells the caller (and the
// model) "this is a PR3 surface", and the schema is already shaped
// for PR3's signature. PR3's diff against PR2 is then a 1-line
// `deferred: false` flip plus the implementation.
//
// The deferred buildRequest is never actually fired by the MCP server's
// tool-call wrapper — we override it inside runTool via a sentinel path
// match. Concretely: stdio-app + index.ts invoke `runTool(ctx, tool,
// args)` which calls `tool.buildRequest(args)` and then `proxyToCtrl()`.
// Both of those produce a structurally-valid ProxyOptions object but
// the actual `path` is "/api/v1/channels/ha/__deferred__/<tool>" — a
// path ctrl-api WILL 404 on, which is fine: the test suite calls
// `tool.buildRequest()` directly and asserts the `deferred` marker
// (see hass.test.ts), and the at-runtime case is documented in each
// deferred tool's description so the model surfaces the PR3 message.
function deferredRequest(toolName: string) {
  return {
    method: "POST" as const,
    path: `/api/v1/channels/ha/__deferred__/${toolName}`,
    body: { ...DEFERRED_MARKER, tool: toolName },
  };
}

// ─── 11 read tools (PR2 scope) ──────────────────────────────────────────

export const HASS_READ_TOOLS: ToolDef[] = [
  {
    name: "ha__connection_status",
    description:
      "Probe ctrl-api for the current Home Assistant connection state. Returns `{state, ha_url, ha_version, last_test_at, last_test_ok, last_test_error, last_discovery_at, entity_count, area_count, automation_count}`. State is one of `unconfigured` / `connecting` / `connected` / `error`. **When to call:** Sir asks 'is the house connected?' / 'is HA up?', OR before a multi-step HA flow so you can fail fast with a clear message if state is `error` / `unconfigured`. Cheap, idempotent, side-effect-free.",
    inputSchema: z.object({}),
    buildRequest: () => ({
      method: "GET",
      path: "/api/v1/channels/ha/status",
    }),
  },

  {
    name: "ha__list_entities",
    description:
      "List HA entities from the cached `ha_registry` (refreshed by Phase A of HaBootstrapWorkflow on every connect + every 6h). Filter by `domain` (e.g. `light` / `switch` / `sensor` / `binary_sensor` / `climate` / `cover` / `media_player`) or `area` (matches area id OR area name). **When to call:** before any `ha__get_state` or PR3 `ha__call_service` you need to resolve an entity_id. Cheap, idempotent. Returns the registry's cached snapshot — if the principal recently added a device and you don't see it, the registry hasn't refreshed yet (PR5's discovery activity owns the refresh cadence; this PR returns whatever the cache holds).",
    inputSchema: z.object({
      domain: z
        .string()
        .optional()
        .describe(
          "HA entity-domain filter (one of `light` / `switch` / `sensor` / `binary_sensor` / `climate` / `cover` / `media_player` / `lock` / `fan` / `vacuum` / `script` / `automation` / `scene` / …). Omit for all domains.",
        ),
      area: z
        .string()
        .optional()
        .describe(
          "Area filter. Matches either `area_id` (e.g. `kitchen`) or the human name (e.g. `Kitchen`). Omit for all areas.",
        ),
    }),
    buildRequest: ({ domain, area }) => ({
      method: "GET",
      path: "/api/v1/channels/ha/registry",
      query: {
        kind: "entity",
        ...(domain !== undefined ? { domain } : {}),
        ...(area !== undefined ? { area } : {}),
      },
    }),
  },

  {
    name: "ha__get_state",
    description:
      "Live state pull for one entity via ctrl-api's proxy to HA REST `GET /api/states/<entity_id>`. Returns `{entity_id, state, attributes, last_changed, last_updated}`. **When to call:** Sir asks a state question — 'is the bedroom window open?', 'how warm is the kids' room?', 'is the front door locked?'. ALWAYS resolve the entity_id via `ha__list_entities` or `ha__resolve_entity` first; never invent. The reply Sir hears should be in plain language with units, NOT the raw entity_id. Cheap, idempotent.",
    inputSchema: z.object({
      entity_id: EntityIdParam,
    }),
    buildRequest: ({ entity_id }) => ({
      method: "GET",
      path: `/api/v1/channels/ha/state/${encodeURIComponent(entity_id)}`,
    }),
  },

  {
    name: "ha__get_history",
    description:
      "Historical state series for one entity via ctrl-api's proxy to HA REST `GET /api/history/period`. Returns an array of state-changes within the last `hours` (default 24, max 168 = one week). **When to call:** Sir asks 'when did the front door last open?', 'what's the bedroom temperature trend?', 'has the kettle been on today?'. Idempotent — but the result set scales with `hours`; prefer narrow windows. For long-range trends, summarise the series in your reply rather than dumping every datapoint.",
    inputSchema: z.object({
      entity_id: EntityIdParam,
      hours: z
        .number()
        .int()
        .min(1)
        .max(168)
        .optional()
        .describe(
          "Look-back window in hours. Default 24, max 168 (one week). Wider windows return more data; prefer narrow.",
        ),
    }),
    buildRequest: ({ entity_id, hours }) => ({
      method: "GET",
      path: "/api/v1/channels/ha/history",
      query: {
        entity_id,
        ...(hours !== undefined ? { hours } : {}),
      },
    }),
  },

  {
    name: "ha__get_logbook",
    description:
      "Human-readable event log via ctrl-api's proxy to HA REST `GET /api/logbook`. The logbook is HA's narrative ledger — 'Front door opened', 'Morning routine fired', 'Kitchen light turned on by Alfred'. **When to call:** Sir asks 'what happened last night?' / 'did the morning routine fire?' / 'who turned the lights on?'. Without `entity_id` returns ALL events in the window (chatty — prefer scoped). `hours` defaults to 24, max 168. Idempotent.",
    inputSchema: z.object({
      entity_id: EntityIdParam.optional().describe(
        "Scope the logbook to one entity. Omit for the household-wide log (chatty — narrow when you can).",
      ),
      hours: z
        .number()
        .int()
        .min(1)
        .max(168)
        .optional()
        .describe(
          "Look-back window in hours. Default 24, max 168.",
        ),
    }),
    buildRequest: ({ entity_id, hours }) => ({
      method: "GET",
      path: "/api/v1/channels/ha/logbook",
      query: {
        ...(entity_id !== undefined ? { entity_id } : {}),
        ...(hours !== undefined ? { hours } : {}),
      },
    }),
  },

  {
    name: "ha__list_areas",
    description:
      "List HA areas (rooms) from the cached registry. Returns `{area_id, name, entity_ids[], device_ids[]}` per area. **When to call:** Sir asks 'what rooms have you got?' / 'list the areas' / before scoping any room-wide action ('all lights in the living room'). Cheap, idempotent. Bootstrap workflow (PR5) keeps this up to date.",
    inputSchema: z.object({}),
    buildRequest: () => ({
      method: "GET",
      path: "/api/v1/channels/ha/registry",
      query: { kind: "area" },
    }),
  },

  {
    name: "ha__list_devices",
    description:
      "List physical HA devices from the cached registry — one device can own multiple entities (a multi-sensor reports temp + humidity + motion as three entities but is one device). Optionally filter by area. Returns `{device_id, name, manufacturer, model, area_id, entity_ids[]}`. **When to call:** Sir asks 'what's in the bedroom?' / 'what devices have I got?' / before describing the substance of a room. Cheap, idempotent.",
    inputSchema: z.object({
      area: z
        .string()
        .optional()
        .describe(
          "Area filter — matches area_id or human name. Omit for all areas.",
        ),
    }),
    buildRequest: ({ area }) => ({
      method: "GET",
      path: "/api/v1/channels/ha/registry",
      query: {
        kind: "device",
        ...(area !== undefined ? { area } : {}),
      },
    }),
  },

  {
    name: "ha__list_automations",
    description:
      "List existing HA automations — both Alfred-authored AND principal-authored. Returns `{automation_id, alias, description, mode, state, last_triggered}` per automation. **When to call:** Sir asks 'what automations have I got?' / 'is the morning routine set up?' / before proposing a new automation (so you don't double up on something HA already has). State is `on` (will fire on next trigger) or `off` (disabled). Cheap, idempotent. Authoritatively-named automations are listed under the registry's `automation` kind alongside their live `automation.<slug>` entity state.",
    inputSchema: z.object({}),
    buildRequest: () => ({
      method: "GET",
      path: "/api/v1/channels/ha/registry",
      query: { kind: "automation" },
    }),
  },

  {
    name: "ha__list_scripts",
    description:
      "List HA scripts (parameterised reusable action sequences — narrower than automations, broader than scenes). Returns `{script_id, alias, description, last_triggered}` per script. **When to call:** Sir asks 'what scripts have I got?' / before proposing a new script. Less common than automations — most homes have a few scripts attached to dashboards / voice intents. Cheap, idempotent.",
    inputSchema: z.object({}),
    buildRequest: () => ({
      method: "GET",
      path: "/api/v1/channels/ha/registry",
      query: { kind: "script" },
    }),
  },

  {
    name: "ha__get_calendars",
    description:
      "List HA's connected calendars via ctrl-api's proxy to HA REST `GET /api/calendars`. HA's calendars are read-only views (Google Calendar / CalDAV / local) that automations can trigger from. Returns `[{entity_id, name}, ...]`. **When to call:** rarely — only when Sir asks about HA-side calendars specifically. For Sir's actual scheduling, use the `alfred` MCP's vault/chore tools, not this. Cheap, idempotent.",
    inputSchema: z.object({}),
    buildRequest: () => ({
      method: "GET",
      path: "/api/v1/channels/ha/calendars",
    }),
  },

  {
    name: "ha__resolve_entity",
    description:
      "Fuzzy-match a principal-friendly phrase to an entity_id from the cached registry. E.g. 'kitchen light' → `light.kitchen_main`, 'bedroom temp' → `sensor.bedroom_temperature`, 'front door' → `binary_sensor.front_door` OR `lock.front_door` depending on context. Returns `{candidates: [{entity_id, friendly_name, area, score}, ...]}` sorted best-first. **When to call:** Sir says 'turn off the kitchen light' — call this BEFORE `ha__get_state` or PR3's `ha__call_service` to pick the right entity_id. If multiple high-score candidates exist (e.g. 'bedroom light' when there are three lamps in the bedroom), ask Sir to clarify which one rather than guessing. Cheap, idempotent.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          "The principal-friendly phrase (e.g. 'kitchen light', 'front door', 'bedroom temp'). Substring match + friendly-name match + area-name match are combined for ranking.",
        ),
    }),
    buildRequest: ({ query }) => ({
      method: "GET",
      path: "/api/v1/channels/ha/resolve",
      query: { q: query },
    }),
  },
];

// ─── 5 PR3-deferred placeholders (write/proposal/event surfaces) ────────
//
// Each placeholder pins the spec-final tool name + input schema PR3 will
// implement. PR3's diff = swap each `buildRequest: () => deferredRequest()`
// for the real ProxyOptions builder, remove the deferred-marker comment
// at the bottom of the tool's description, and wire the loop-guard
// contract restated in this file's header.

export const HASS_DEFERRED_TOOLS: ToolDef[] = [
  {
    name: "ha__call_service",
    description:
      "PR3. Call any HA service (REST `POST /api/services/:domain/:service`) — turn lights on/off, set thermostat, lock doors, play media. **PR3 contract:** writes a `ha_run` audit row with a freshly-minted `decision_ref` BEFORE issuing the upstream call (loop-guard — see this file's header). PR2 returns `{deferred: true, target_pr: \"PR3\"}` so a workers-profile agent that reaches for it gets a clear message instead of a runtime error.",
    inputSchema: z.object({
      domain: z
        .string()
        .min(1)
        .describe("HA service domain (e.g. `light`, `switch`, `climate`, `media_player`)."),
      service: z
        .string()
        .min(1)
        .describe("Service within the domain (e.g. `turn_on`, `turn_off`, `set_temperature`)."),
      entity_id: EntityIdParam.optional().describe(
        "Target entity. Either `entity_id` or `area_id` (or both) — at least one required when PR3 ships.",
      ),
      area_id: z
        .string()
        .optional()
        .describe(
          "Target area. Service applies to every matching entity in the area.",
        ),
      data: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Service-specific payload (e.g. `{brightness_pct: 60, transition: 2}` for `light.turn_on`).",
        ),
    }),
    buildRequest: () => deferredRequest("ha__call_service"),
  },

  {
    name: "ha__propose_automation",
    description:
      "PR3. Enqueue an automation proposal — a draft YAML + a description of what it does — into the `ha_proposal` queue for principal approval. Does NOT apply anything. Returns `{proposal_id}` once PR3 ships; PR2 returns `{deferred: true, target_pr: \"PR3\"}`. The approval gate is `/api/v1/channels/ha/proposal/approve` and Sir's Brief card; only after approval does Alfred call the apply path (which respects the loop-guard).",
    inputSchema: z.object({
      alias: z
        .string()
        .min(1)
        .describe("Human-readable name (e.g. 'Morning routine — weekdays')."),
      description: z
        .string()
        .optional()
        .describe(
          "Plain-language explanation Sir sees in the approval card.",
        ),
      mode: z
        .enum(["single", "restart", "queued", "parallel"])
        .optional()
        .describe(
          "HA automation `mode` field. Default `single` — see HA docs.",
        ),
      triggers: z
        .array(z.record(z.string(), z.unknown()))
        .describe("HA trigger blocks — at least one."),
      conditions: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe("HA condition blocks. Optional."),
      actions: z
        .array(z.record(z.string(), z.unknown()))
        .describe("HA action blocks — at least one."),
    }),
    buildRequest: () => deferredRequest("ha__propose_automation"),
  },

  {
    name: "ha__apply_proposal",
    description:
      "PR3. Apply an already-approved `ha_proposal` — installs automations + scenes + helpers + area assignments listed in the proposal pack. Requires the proposal's status to be `approved` AND a `decision_ref` (the Desk/Brief click that authorised it — Alfred refuses without). Every write minted by this call rides the loop-guard contract (see this file's header). PR2 returns `{deferred: true, target_pr: \"PR3\"}`.",
    inputSchema: z.object({
      proposal_id: z
        .string()
        .min(1)
        .describe("ULID of the row in `ha_proposal` to apply."),
      decision_ref: z
        .string()
        .min(1)
        .describe(
          "Vault path of the `decision/` record that authorised this apply. Alfred refuses without it.",
        ),
    }),
    buildRequest: () => deferredRequest("ha__apply_proposal"),
  },

  {
    name: "ha__rollback_snapshot",
    description:
      "PR3. Roll back a previously-applied automation/scene write to the YAML snapshot ctrl-api captured BEFORE the change (table `ha_snapshot`, populated by `ha__apply_proposal`). **When to call:** Sir says 'undo that' or the Brief surfaces a rollback affordance after a failed apply. PR2 returns `{deferred: true, target_pr: \"PR3\"}`.",
    inputSchema: z.object({
      snapshot_id: z
        .string()
        .min(1)
        .describe("ULID of the row in `ha_snapshot` to restore."),
    }),
    buildRequest: () => deferredRequest("ha__rollback_snapshot"),
  },

  {
    name: "ha__subscribe_events",
    description:
      "PR3. Subscribe to a filtered HA WS event stream (e.g. `state_changed` for one entity, or `automation_triggered` for one automation). Returns a subscription handle PR3 will wire through HaWatcherWorkflow's long-lived WS connection — the watcher is the only thing in the stack that holds the actual WS, and the loop-guard suppresses Alfred-originated echoes here. PR2 returns `{deferred: true, target_pr: \"PR3\"}`.",
    inputSchema: z.object({
      event_type: z
        .string()
        .min(1)
        .describe(
          "HA event type (e.g. `state_changed`, `automation_triggered`, `call_service`).",
        ),
      entity_id: EntityIdParam.optional().describe(
        "Optional entity-id filter — narrows the firehose to one entity.",
      ),
    }),
    buildRequest: () => deferredRequest("ha__subscribe_events"),
  },
];

// Final catalogue: 16 tools total = 11 read + 5 PR3 placeholders. Order
// kept deliberately (reads first, deferred last) so the model that lists
// the catalogue sees the safe read surface before the placeholders.
export const ALL_HASS_TOOLS: ToolDef[] = [
  ...HASS_READ_TOOLS,
  ...HASS_DEFERRED_TOOLS,
];
