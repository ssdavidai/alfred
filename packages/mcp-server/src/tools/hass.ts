// Home Assistant MCP tool catalogue — the 7th MCP app on the Alfred stdio
// bundle, sitting alongside alfred / sure / plane / vaultwarden / execute
// / hermes. Lands the principal's HA install as a first-class operator
// surface so the voice/text Alfred can answer "is the kitchen window
// open?" and "set the bedroom to 21°" without the principal ever opening
// HA's own UI.
//
// SPEC: docs/specs/issue-110-ha-deep-integration.md §3 (MCP surface) +
//       §5 (the seven /api/v1/channels/ha/* contracts) +
//       §6 PR2 (read tools) + §6 PR4 (write tools).
//
// CATALOGUE — 16 tools:
//   * 11 reads in HASS_READ_TOOLS (PR2)
//   * 5 writes in HASS_WRITE_TOOLS (PR4) — alias `HASS_DEFERRED_TOOLS`
//     kept for back-compat with the PR2 wave.
//
// ──────────────────────────────────────────────────────────────────────
// Loop-guard contract (PR1 schema → PR4 enforcement). Load-bearing.
// ──────────────────────────────────────────────────────────────────────
//
// The fundamental safety boundary between #110 (Alfred → HA writes) and
// #111 (HA → Alfred conversation agent) is that Alfred's OWN writes
// must not flow back through the WS event stream as principal-relevant
// signals. Without the guard, `ha__call_service` toggling the kitchen
// light would echo back as a state_changed event → ingest as a
// stream_event → matter the Desk presents as a card → propose a chore
// → call ha__call_service again. A closed loop.
//
// Every PR4 write tool:
//   1. takes a `decision_ref` (vault path or ulid) in its input — the
//      agent's contract is "I decided X based on signal Y, run it";
//   2. delegates to ctrl-api, which persists a row in `ha_run` keyed
//      (entity_id, created_at, decision_ref) BEFORE issuing the upstream
//      HA request;
//   3. then ctrl-api issues the HA REST/WS request.
//
// HaWatcherWorkflow (PR3, in alfred-learn) uses the partial index
// `idx_ha_run_entity_recent` from migration 0005 to SUPPRESS state_changed
// events that fall inside a 30s window of an Alfred-originated write.
//
// Loop guard on the ctrl-api side: a second write to the SAME entity_id
// within HA_LOOP_GUARD_COOLDOWN_MS (default 60s) with the SAME
// decision_ref returns 409 CONFLICT. A different decision_ref always
// passes — that means the agent re-derived a decision from a NEW signal.
//
// The MCP tool's zod schema enforces decision_ref presence + shape on
// ha__call_service / ha__apply_proposal / ha__rollback_snapshot BEFORE
// any ctrl-api call fires.

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

// ─── 5 write/proposal/event tools (PR4 scope) ───────────────────────────
//
// PR4 fills in what PR2 left as `deferred` stubs. The exported binding
// `HASS_DEFERRED_TOOLS` is kept (alias) so the registry that pinned
// `HASS_READ_TOOLS + HASS_DEFERRED_TOOLS = 16` still resolves, AND so
// downstream callers that imported the old name keep working.
//
// LOOP-GUARD CONTRACT — see this file's header. ha__call_service requires
// `decision_ref` (no client-side mint) — the agent must have already
// derived a decision from a signal before it calls this tool. The MCP
// tool returns an error WITHOUT calling ctrl-api when `decision_ref` is
// missing (the zod schema enforces it).

export const HASS_WRITE_TOOLS: ToolDef[] = [
  {
    name: "ha__call_service",
    description:
      "Call any HA service (REST `POST /api/services/:domain/:service`) — turn lights on/off, set thermostat, lock doors, play media. **Loop-guard contract:** REQUIRES a `decision_ref` (vault path or ulid of the decision row that authorised this write). ctrl-api persists a `ha_run` row with that decision_ref BEFORE firing the upstream call; HaWatcherWorkflow uses the same key to suppress the echo event so Alfred never loops on his own writes. A second call within 60s to the same entity_id with the SAME decision_ref returns 409 LOOP_GUARD — pass a different decision_ref (= you re-derived the decision from a new signal) or wait the cooldown.",
    inputSchema: z.object({
      domain: z
        .string()
        .min(1)
        .describe("HA service domain (e.g. `light`, `switch`, `climate`, `media_player`)."),
      service: z
        .string()
        .min(1)
        .describe("Service within the domain (e.g. `turn_on`, `turn_off`, `set_temperature`)."),
      target: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "HA target block (e.g. `{entity_id: 'light.kitchen_main'}` or `{area_id: 'kitchen'}`).",
        ),
      data: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Service-specific payload (e.g. `{brightness_pct: 60, transition: 2}` for `light.turn_on`).",
        ),
      decision_ref: z
        .string()
        .min(6)
        .max(256)
        .regex(
          /^[\x21-\x7E]+$/,
          "decision_ref must be printable ASCII with no whitespace",
        )
        .describe(
          "Vault path or ulid of the `decision/` record that authorised this write. REQUIRED. Alfred refuses without it (no client-side mint — the contract is 'I decided X based on signal Y, run it').",
        ),
    }),
    buildRequest: ({ domain, service, target, data, decision_ref }) => ({
      method: "POST",
      path: "/api/v1/channels/ha/service",
      body: {
        domain,
        service,
        ...(target !== undefined ? { target } : {}),
        ...(data !== undefined ? { data } : {}),
        decision_ref,
      },
    }),
  },

  {
    name: "ha__propose_automation",
    description:
      "Enqueue a baseline automation pack proposal — a draft YAML + a one-line summary — into `ha_proposal` for principal approval. Does NOT apply anything by itself; surfaces on the Desk/Brief approval card. Returns `{proposal_id, status:'pending'}`. The principal approves via the Desk card, and `ha__apply_proposal(proposal_id, decision_ref)` then runs the actual writes (with the loop-guard).",
    inputSchema: z.object({
      kind: z
        .string()
        .min(1)
        .describe(
          "Pack kind (e.g. `automation`, `scene`, `morning_routine`, `motion_lighting`).",
        ),
      summary: z
        .string()
        .min(1)
        .describe("One-line description Sir sees in the Brief approval card."),
      yaml: z
        .string()
        .min(1)
        .describe(
          "The full HA automation YAML to install on approval (multi-line string).",
        ),
      gap_id: z
        .string()
        .optional()
        .describe(
          "If this proposal addresses a row in `ha_gap`, link it here so the gap closes when applied.",
        ),
    }),
    buildRequest: ({ kind, summary, yaml, gap_id }) => ({
      method: "POST",
      path: "/api/v1/channels/ha/proposal",
      body: {
        kind,
        summary,
        yaml,
        ...(gap_id !== undefined ? { gap_id } : {}),
      },
    }),
  },

  {
    name: "ha__apply_proposal",
    description:
      "Apply an approved `ha_proposal` — installs the automation YAML against HA's `automation/config/<id>` endpoint, captures a snapshot of the prior YAML first (for rollback), persists a `ha_run` row with the loop-guard `decision_ref`. Returns `{proposal_id, snapshot_id, run_id}`.",
    inputSchema: z.object({
      proposal_id: z
        .string()
        .min(1)
        .describe("ULID of the row in `ha_proposal` to apply."),
      decision_ref: z
        .string()
        .min(6)
        .max(256)
        .regex(
          /^[\x21-\x7E]+$/,
          "decision_ref must be printable ASCII with no whitespace",
        )
        .describe(
          "Vault path or ulid of the `decision/` record that authorised this apply. REQUIRED.",
        ),
      automation_id: z
        .string()
        .optional()
        .describe(
          "Override the HA automation id the proposal installs under. Defaults to the proposal id.",
        ),
    }),
    buildRequest: ({ proposal_id, decision_ref, automation_id }) => ({
      method: "POST",
      path: `/api/v1/channels/ha/proposal/${encodeURIComponent(proposal_id)}/apply`,
      body: {
        decision_ref,
        ...(automation_id !== undefined ? { automation_id } : {}),
      },
    }),
  },

  {
    name: "ha__rollback_snapshot",
    description:
      "Roll back to a previously-captured `ha_snapshot`'s YAML — restores the pre-apply automation config to HA. **When to call:** Sir says 'undo that' OR the Brief surfaces a rollback affordance after a failed apply. Snapshot is consumed (the row gets `restored_at` set) — rolling back twice returns 409 CONFLICT.",
    inputSchema: z.object({
      snapshot_id: z
        .string()
        .min(1)
        .describe("ULID of the row in `ha_snapshot` to restore."),
      decision_ref: z
        .string()
        .min(6)
        .max(256)
        .regex(
          /^[\x21-\x7E]+$/,
          "decision_ref must be printable ASCII with no whitespace",
        )
        .describe(
          "Vault path or ulid of the `decision/` record that authorised the rollback. REQUIRED.",
        ),
    }),
    buildRequest: ({ snapshot_id, decision_ref }) => ({
      method: "POST",
      path: `/api/v1/channels/ha/snapshot/${encodeURIComponent(snapshot_id)}/rollback`,
      body: { decision_ref },
    }),
  },

  {
    name: "ha__subscribe_events",
    description:
      "Open a long-lived HA WS event subscription. Returns `{subscription_id, filter, started_at}`. ctrl-api spawns a WS subscriber against HA's `subscribe_events` and streams matching events into `ha_event` (the diagnostic ring). Close with `ha__unsubscribe_events(subscription_id)` (PR4 — DELETE /subscribe/:id). NOTE: the HaWatcherWorkflow already runs a household-wide watcher in PR3 — this tool is for narrow, agent-driven follow-up subscriptions (e.g. 'watch this door for the next 5 minutes').",
    inputSchema: z.object({
      filter: z
        .object({
          event_type: z
            .string()
            .min(1)
            .optional()
            .describe(
              "HA event type to subscribe to (e.g. `state_changed`, `automation_triggered`).",
            ),
          entity_id: EntityIdParam.optional().describe(
            "Narrow to one entity. Filter applied client-side after the WS event arrives.",
          ),
        })
        .optional()
        .describe("Optional filter — omit to subscribe to the household firehose."),
    }),
    buildRequest: ({ filter }) => ({
      method: "POST",
      path: "/api/v1/channels/ha/subscribe",
      body: filter !== undefined ? { filter } : {},
    }),
  },
];

// Back-compat alias — PR2 exported these stubs under `HASS_DEFERRED_TOOLS`,
// and downstream callers (registry.ts, tests) referenced that name. Keep
// the binding live so the PR2→PR4 transition doesn't churn import sites.
export const HASS_DEFERRED_TOOLS: ToolDef[] = HASS_WRITE_TOOLS;

// Final catalogue: 16 tools total = 11 read + 5 PR3 placeholders. Order
// kept deliberately (reads first, deferred last) so the model that lists
// the catalogue sees the safe read surface before the placeholders.
export const ALL_HASS_TOOLS: ToolDef[] = [
  ...HASS_READ_TOOLS,
  ...HASS_DEFERRED_TOOLS,
];
