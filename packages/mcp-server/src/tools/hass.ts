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

// ─── BEGIN #115 PR3 — automations / scenes / scripts CRUD ───────────────
//
// 10 new write tools, fronting the REST CRUD that ctrl-api exposes at
// /api/v1/channels/ha/{automations,scenes,scripts}. The HA REST API for
// these three surfaces is mature (long-standing /api/config/* endpoints),
// so unlike the registry CRUD (#115 PR2) these don't need the WS client.
//
// Per spec §4 gate matrix — locked YES on 2026-05-29:
//   * automation_create / automation_update : NO gate (reversible — Sir
//     can disable in HA UI)
//   * automation_delete                     : decision_ref REQUIRED
//   * scene_*                               : NO gate (cheap)
//   * script_*                              : NO gate (cheap)
//
// Snapshots + daybook entries — the ctrl-api side records every write in
// `ha_run` (today's audit ledger). The richer "daybook vault record" half
// of the locked YES default arrives in #115 PR1 (WS + daybook helper); we
// gate-fail-open here and stamp ha_run for now (see ctrl-api comments).
//
// Loop guard — automations/scenes/scripts CRUD doesn't loop back through
// state_changed events (the writes mutate config, they don't trigger
// entity state). The existing per-entity guard in #110 PR4 still applies
// transitively (`scene.activate` via call_service / etc.). PR3 CRUD
// itself bypasses the entity-state guard because the entity it touches is
// the automation/scene/script config object, not a stateful entity.

const HaAutomationTriggerSchema = z
  .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .describe(
    "HA trigger block(s). Either a single trigger object `{platform: 'time', at: '06:30'}` or an array of triggers. See https://www.home-assistant.io/docs/automation/trigger/ for the supported platforms.",
  );

const HaAutomationActionSchema = z
  .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .describe(
    "HA action block(s). Either a single action `{service: 'light.turn_on', target: {...}}` or an array of actions. See https://www.home-assistant.io/docs/automation/action/.",
  );

const HaAutomationConditionSchema = z
  .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .describe(
    "Optional HA condition block(s). Either a single condition or an array — automation only fires when all conditions evaluate true. See https://www.home-assistant.io/docs/automation/condition/.",
  );

const HA_WRITE_PR3_TOOLS: ToolDef[] = [
  // ── automations ────────────────────────────────────────────────────────

  {
    name: "ha__list_automations_full",
    description:
      "List every HA automation with its FULL config — alias / trigger / condition / action / mode — NOT the slim registry index `ha__list_automations` returns. Resolves via `GET /api/v1/channels/ha/automations` → REST `GET /api/config/automation/config`. **When to call:** before `ha__update_automation` (to read current trigger/action before patching), before proposing a NEW automation that might overlap an existing one (so you can edit instead of double-up), or when Sir asks 'show me the morning routine — what does it actually do?'. Cheap, idempotent. Returns `[{id, alias, description, mode, trigger, condition, action}, ...]`.",
    inputSchema: z.object({}),
    buildRequest: () => ({
      method: "GET",
      path: "/api/v1/channels/ha/automations",
    }),
  },

  {
    name: "ha__create_automation",
    description:
      "Create a brand-new HA automation. Resolves to `POST /api/v1/channels/ha/automations` → HA REST `POST /api/config/automation/config/<new_id>`. **No approval gate** — create is reversible (Sir disables it in HA UI in 5 seconds). The new automation is created in the OFF state by default unless you explicitly include `initial_state: 'on'` in the body. **Always `ha__list_automations_full` FIRST** so you don't author a third 'morning routine' on top of two existing ones. Example payload: `{alias: 'Lights off when sunny', trigger: {platform: 'sun', event: 'sunrise'}, action: {service: 'light.turn_off', target: {area_id: 'living_room'}}}`. Returns `{ok, automation_id, ha_response}`.",
    inputSchema: z.object({
      alias: z
        .string()
        .min(1)
        .describe(
          "Human-readable name for the automation (shown in HA UI + spoken by Alfred). Must be unique-ish — HA itself doesn't enforce uniqueness, but two automations with the same alias confuse principals.",
        ),
      trigger: HaAutomationTriggerSchema,
      condition: HaAutomationConditionSchema.optional(),
      action: HaAutomationActionSchema,
      description: z
        .string()
        .optional()
        .describe(
          "Optional longer description shown in HA's automation editor. Use this to record WHY Alfred created this automation (which signal / decision / observation).",
        ),
      mode: z
        .enum(["single", "restart", "queued", "parallel"])
        .optional()
        .describe(
          "How HA handles re-trigger while already running. `single` (default) drops re-triggers, `restart` cancels + reruns, `queued` queues them up, `parallel` runs concurrently.",
        ),
      initial_state: z
        .enum(["on", "off"])
        .optional()
        .describe(
          "Optional initial state. Default `off` — the principal turns it on in HA's UI after reviewing. Set `on` only when Alfred is confident the automation is safe to fire immediately.",
        ),
    }),
    buildRequest: ({
      alias,
      trigger,
      condition,
      action,
      description,
      mode,
      initial_state,
    }) => ({
      method: "POST",
      path: "/api/v1/channels/ha/automations",
      body: {
        alias,
        trigger,
        ...(condition !== undefined ? { condition } : {}),
        action,
        ...(description !== undefined ? { description } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(initial_state !== undefined ? { initial_state } : {}),
      },
    }),
  },

  {
    name: "ha__update_automation",
    description:
      "Update an existing HA automation by id. Resolves to `PUT /api/v1/channels/ha/automations/:id` (the underlying HA endpoint is idempotent — POST and PUT both upsert at the same URL). **No approval gate** (reversible). **Always `ha__list_automations_full` FIRST** to read the current config — HA's REST does a full-replace, not a patch. Only the fields you pass land; any unset field is wiped. Build the new body from the old one + your edits, don't ship a partial. Example: `{automation_id: 'lights_off_sunrise', alias: 'Lights off at sunrise', trigger: {platform: 'sun', event: 'sunrise'}, action: {service: 'light.turn_off', target: {area_id: 'living_room'}}}`. Returns `{ok, automation_id, ha_response}`.",
    inputSchema: z.object({
      automation_id: z
        .string()
        .min(1)
        .describe(
          "The id portion of the entity_id (e.g. `lights_off_sunrise` for entity `automation.lights_off_sunrise`). Read this from `ha__list_automations_full` — NEVER invent.",
        ),
      alias: z.string().optional(),
      trigger: HaAutomationTriggerSchema.optional(),
      condition: HaAutomationConditionSchema.optional(),
      action: HaAutomationActionSchema.optional(),
      description: z.string().optional(),
      mode: z.enum(["single", "restart", "queued", "parallel"]).optional(),
    }),
    buildRequest: ({
      automation_id,
      alias,
      trigger,
      condition,
      action,
      description,
      mode,
    }) => ({
      method: "PUT",
      path: `/api/v1/channels/ha/automations/${encodeURIComponent(automation_id)}`,
      body: {
        ...(alias !== undefined ? { alias } : {}),
        ...(trigger !== undefined ? { trigger } : {}),
        ...(condition !== undefined ? { condition } : {}),
        ...(action !== undefined ? { action } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(mode !== undefined ? { mode } : {}),
      },
    }),
  },

  {
    name: "ha__delete_automation",
    description:
      "Delete an HA automation. Resolves to `DELETE /api/v1/channels/ha/automations/:id` → HA REST `DELETE /api/config/automation/config/<id>`. **GATED:** `decision_ref` REQUIRED — deletion is irreversible without a backup (no undo button in HA UI). The agent's contract is 'I decided to remove this automation based on signal/observation X, run it'. ctrl-api persists a `ha_run` ledger row with the decision_ref + a daybook entry (per #115 default 3) BEFORE the upstream DELETE so the audit trail survives. If Sir might want this back later, `ha__list_automations_full` first and store the YAML in a `decision/` vault record before calling this.",
    inputSchema: z.object({
      automation_id: z
        .string()
        .min(1)
        .describe(
          "Automation id to delete. Read from `ha__list_automations_full`. NEVER invent.",
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
          "Vault path or ulid of the `decision/` record that authorised the delete. REQUIRED — Alfred refuses without it.",
        ),
    }),
    buildRequest: ({ automation_id, decision_ref }) => ({
      method: "DELETE",
      path: `/api/v1/channels/ha/automations/${encodeURIComponent(automation_id)}`,
      body: { decision_ref },
    }),
  },

  // ── scenes ─────────────────────────────────────────────────────────────

  {
    name: "ha__create_scene",
    description:
      "Create an HA scene — a snapshot of entity states the principal can re-enter with one tap or voice command. Resolves to `POST /api/v1/channels/ha/scenes`. **No approval gate** (cheap, reversible). Example for a bedtime scene: `{name: 'Bedtime', entities: {'light.bedroom_main': {state: 'on', brightness_pct: 15}, 'light.living_room_lamp': {state: 'off'}, 'climate.bedroom': {temperature: 19}}}`. The keys of `entities` are entity_ids; the values are `{state: 'on'|'off', ...attributes}` blocks HA replays on `scene.turn_on`. Returns `{ok, scene_id, ha_response}`.",
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .describe(
          "Human-readable scene name. Becomes the entity friendly name; the scene_id is derived as a slug of this.",
        ),
      entities: z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .describe(
          "Map of entity_id → state object. Each state object must include `state` (e.g. 'on', 'off', '22.5') plus any attributes (brightness, color, temperature, …) the entity supports. Build from `ha__get_state` reads if you want to capture a 'current' snapshot.",
        ),
      icon: z
        .string()
        .optional()
        .describe(
          "Optional MDI icon name (e.g. `mdi:weather-night` for bedtime). Shown in HA dashboards.",
        ),
    }),
    buildRequest: ({ name, entities, icon }) => ({
      method: "POST",
      path: "/api/v1/channels/ha/scenes",
      body: {
        name,
        entities,
        ...(icon !== undefined ? { icon } : {}),
      },
    }),
  },

  {
    name: "ha__update_scene",
    description:
      "Update an existing HA scene. Resolves to `PUT /api/v1/channels/ha/scenes/:id`. **No approval gate** (cheap). HA's REST does a full-replace — fetch the current scene via `GET /api/v1/channels/ha/scenes/:id` (or `ha__get_state` on the scene entity), merge your edits, ship the whole config. Returns `{ok, scene_id, ha_response}`.",
    inputSchema: z.object({
      scene_id: z
        .string()
        .min(1)
        .describe(
          "The id portion of the entity_id (e.g. `bedtime` for `scene.bedtime`). NEVER invent.",
        ),
      name: z.string().optional(),
      entities: z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .optional()
        .describe(
          "Replacement entity state map. See ha__create_scene for shape.",
        ),
      icon: z.string().optional(),
    }),
    buildRequest: ({ scene_id, name, entities, icon }) => ({
      method: "PUT",
      path: `/api/v1/channels/ha/scenes/${encodeURIComponent(scene_id)}`,
      body: {
        ...(name !== undefined ? { name } : {}),
        ...(entities !== undefined ? { entities } : {}),
        ...(icon !== undefined ? { icon } : {}),
      },
    }),
  },

  {
    name: "ha__delete_scene",
    description:
      "Delete an HA scene. Resolves to `DELETE /api/v1/channels/ha/scenes/:id`. **No approval gate** — scenes are cheap to recreate from a saved snapshot. Returns `{ok, scene_id, ha_response}`.",
    inputSchema: z.object({
      scene_id: z
        .string()
        .min(1)
        .describe("Scene id to delete. NEVER invent."),
    }),
    buildRequest: ({ scene_id }) => ({
      method: "DELETE",
      path: `/api/v1/channels/ha/scenes/${encodeURIComponent(scene_id)}`,
    }),
  },

  // ── scripts ────────────────────────────────────────────────────────────

  {
    name: "ha__create_script",
    description:
      "Create an HA script — a reusable, parameterised action sequence. Narrower than an automation (no trigger), broader than a scene (executes a sequence rather than a state snapshot). Resolves to `POST /api/v1/channels/ha/scripts`. **No approval gate** (cheap, reversible). Example: `{alias: 'Goodnight', sequence: [{service: 'scene.turn_on', target: {entity_id: 'scene.bedtime'}}, {delay: '00:05:00'}, {service: 'lock.lock', target: {entity_id: 'lock.front_door'}}]}`. Returns `{ok, script_id, ha_response}`.",
    inputSchema: z.object({
      alias: z
        .string()
        .min(1)
        .describe(
          "Human-readable script name. Becomes the entity friendly name; script_id is derived as a slug.",
        ),
      sequence: z
        .array(z.unknown())
        .describe(
          "Array of HA action steps the script runs sequentially. See https://www.home-assistant.io/docs/scripts/.",
        ),
      description: z.string().optional(),
      mode: z.enum(["single", "restart", "queued", "parallel"]).optional(),
      icon: z.string().optional(),
    }),
    buildRequest: ({ alias, sequence, description, mode, icon }) => ({
      method: "POST",
      path: "/api/v1/channels/ha/scripts",
      body: {
        alias,
        sequence,
        ...(description !== undefined ? { description } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(icon !== undefined ? { icon } : {}),
      },
    }),
  },

  {
    name: "ha__update_script",
    description:
      "Update an existing HA script. Resolves to `PUT /api/v1/channels/ha/scripts/:id`. **No approval gate** (cheap). HA's REST does a full-replace — read current config first, merge your edits, ship the whole config. Returns `{ok, script_id, ha_response}`.",
    inputSchema: z.object({
      script_id: z
        .string()
        .min(1)
        .describe(
          "The id portion of the entity_id (e.g. `goodnight` for `script.goodnight`). NEVER invent.",
        ),
      alias: z.string().optional(),
      sequence: z.array(z.unknown()).optional(),
      description: z.string().optional(),
      mode: z.enum(["single", "restart", "queued", "parallel"]).optional(),
      icon: z.string().optional(),
    }),
    buildRequest: ({ script_id, alias, sequence, description, mode, icon }) => ({
      method: "PUT",
      path: `/api/v1/channels/ha/scripts/${encodeURIComponent(script_id)}`,
      body: {
        ...(alias !== undefined ? { alias } : {}),
        ...(sequence !== undefined ? { sequence } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(icon !== undefined ? { icon } : {}),
      },
    }),
  },

  {
    name: "ha__delete_script",
    description:
      "Delete an HA script. Resolves to `DELETE /api/v1/channels/ha/scripts/:id`. **No approval gate** — scripts are cheap to recreate. Returns `{ok, script_id, ha_response}`.",
    inputSchema: z.object({
      script_id: z
        .string()
        .min(1)
        .describe("Script id to delete. NEVER invent."),
    }),
    buildRequest: ({ script_id }) => ({
      method: "DELETE",
      path: `/api/v1/channels/ha/scripts/${encodeURIComponent(script_id)}`,
    }),
  },
];

// Splice the PR3 tools onto HASS_WRITE_TOOLS so downstream importers
// (registry.ts, alias HASS_DEFERRED_TOOLS) pick them up without a churn.
HASS_WRITE_TOOLS.push(...HA_WRITE_PR3_TOOLS);

// ─── END #115 PR3 ──────────────────────────────────────────────────────

// Back-compat alias — PR2 exported these stubs under `HASS_DEFERRED_TOOLS`,
// and downstream callers (registry.ts, tests) referenced that name. Keep
// the binding live so the PR2→PR4 transition doesn't churn import sites.
export const HASS_DEFERRED_TOOLS: ToolDef[] = HASS_WRITE_TOOLS;

// ═════════════════════════════════════════════════════════════════════════
// === Tier 4 PR6: Supervisor addons ===
// ═════════════════════════════════════════════════════════════════════════
//
// Issue #115 PR6 — 10 new tools fronting ctrl-api's
// /api/v1/channels/ha/addons/* surface. These ONLY work on Home Assistant
// OS installations; on Container/Core/Supervised, ctrl-api responds with
// HTTP 501 {error: "supervisor_not_available", installation_type, message}
// and the proxy layer surfaces that envelope back to the model as a
// non-2xx tool result. Models are expected to read the `installation_type`
// from the error payload and explain to Sir, not retry blindly.
//
// Per the spec §4 gate matrix (locked YES 2026-05-29 by Sir):
//
// | Tool                | decision_ref | auto-snapshot |
// |---------------------|--------------|---------------|
// | ha__list_addons     | no           | no            |
// | ha__addon_info      | no           | no            |
// | ha__addon_install   | REQUIRED     | YES           |
// | ha__addon_uninstall | REQUIRED     | YES           |
// | ha__addon_configure | REQUIRED     | NO            |
// | ha__addon_start     | no           | no            |
// | ha__addon_stop      | no           | no            |
// | ha__addon_restart   | no           | no            |
// | ha__addon_update    | REQUIRED     | YES           |
// | ha__addon_logs      | no           | no            |
//
// Why these particular gates: install / uninstall / update can corrupt
// the HA install in ways the principal can't trivially reverse
// (Supervisor backups are slow and Sir's HA OS lives on a Raspberry Pi).
// Configure rewrites the options.json — destructive but reversible by
// re-running configure. start/stop/restart are cheap and reversible.
//
// Snapshot is recorded BEFORE the upstream call so a failed install
// still surfaces the intent in `ha_backup_ref`. The MCP tool returns
// `backup_ref_id` + `ha_backup_id` in the success envelope so the agent
// can mention "snapshot taken" in its reply to Sir.

const AddonSlugParam = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_\-.]{0,127}$/,
    "slug must be 1..128 chars of [A-Za-z0-9_.-], starting with [A-Za-z0-9]",
  )
  .describe(
    "Supervisor addon slug, e.g. `core_mosquitto`, `a0d7b954_nodered`, `core_zigbee2mqtt`. Resolve via `ha__list_addons` (each addon's `slug`) — never invent.",
  );

const AddonDecisionRefParam = z
  .string()
  .min(6)
  .max(256)
  .regex(
    /^[\x21-\x7E]+$/,
    "decision_ref must be printable ASCII with no whitespace",
  )
  .describe(
    "Vault path or ulid of the `decision/` record that authorised this addon write. REQUIRED. Alfred refuses without it — the contract is 'I decided X based on signal Y, run it'.",
  );

export const HASS_ADDON_TOOLS: ToolDef[] = [
  {
    name: "ha__list_addons",
    description:
      "List Home Assistant Supervisor addons (installed + available in the store). **HAOS-ONLY** — on Container HA / Core HA / Supervised installations this returns a 501 envelope `{error: 'supervisor_not_available', installation_type, message}`. Read the `installation_type` and explain to Sir rather than retrying. Returns the Supervisor's verbatim `data` block, typically `{addons: [{slug, name, version, version_latest, state, repository, ...}], suggestions?: [...]}`. **When to call:** Sir asks 'what's installed on HA?' / 'do I have Mosquitto?' / before any other addon tool to resolve a slug.",
    inputSchema: z.object({}),
    buildRequest: () => ({
      method: "GET",
      path: "/api/v1/channels/ha/addons",
    }),
  },

  {
    name: "ha__addon_info",
    description:
      "Full info for one Supervisor addon — version, options schema, network ports, hostname, state, etc. **HAOS-ONLY** (see `ha__list_addons` for the 501 envelope shape). Returns `data` straight from Supervisor's `/addons/<slug>/info`. **When to call:** before `ha__addon_configure` (so you know the options schema), before `ha__addon_update` (to read the version delta), or when Sir asks 'what version of Mosquitto am I on?'.",
    inputSchema: z.object({
      slug: AddonSlugParam,
    }),
    buildRequest: ({ slug }) => ({
      method: "GET",
      path: `/api/v1/channels/ha/addons/${encodeURIComponent(slug)}`,
    }),
  },

  {
    name: "ha__addon_install",
    description:
      "Install a Supervisor addon. **HAOS-ONLY**. **DESTRUCTIVE** — pulls + starts a Docker container; can introduce new network surface, takes 30-300s. **GATED** — requires `decision_ref` referencing the `decision/` record Sir approved. **AUTO-SNAPSHOT** — ctrl-api records the intent in `ha_backup_ref` BEFORE the upstream call. The success envelope carries `backup_ref_id` and `ha_backup_id`; mention 'snapshot taken' to Sir in your reply. Sir's home (home.alfred.black) is HAOS so this surface is live.",
    inputSchema: z.object({
      slug: AddonSlugParam,
      decision_ref: AddonDecisionRefParam,
    }),
    buildRequest: ({ slug, decision_ref }) => ({
      method: "POST",
      path: `/api/v1/channels/ha/addons/${encodeURIComponent(slug)}/install`,
      body: { decision_ref },
    }),
  },

  {
    name: "ha__addon_uninstall",
    description:
      "Uninstall a Supervisor addon — stops + removes the container, drops its `/data` volume. **HAOS-ONLY**. **DESTRUCTIVE** (data loss possible). **GATED** — requires `decision_ref`. **AUTO-SNAPSHOT** — ctrl-api records the intent in `ha_backup_ref`. Confirm with Sir before calling; this is one of the few addon ops that can't be quickly undone without a restore.",
    inputSchema: z.object({
      slug: AddonSlugParam,
      decision_ref: AddonDecisionRefParam,
    }),
    buildRequest: ({ slug, decision_ref }) => ({
      method: "POST",
      path: `/api/v1/channels/ha/addons/${encodeURIComponent(slug)}/uninstall`,
      body: { decision_ref },
    }),
  },

  {
    name: "ha__addon_configure",
    description:
      "Update a Supervisor addon's `options.json`. **HAOS-ONLY**. **GATED** — requires `decision_ref`. **NO snapshot** (options swap is reversible by re-running configure with the prior values). Pass the full options object — Supervisor merges against the addon's schema. Read the current options via `ha__addon_info` first; never blind-write. The addon may need a restart after configure (call `ha__addon_restart` if Sir wants it applied immediately).",
    inputSchema: z.object({
      slug: AddonSlugParam,
      options: z
        .record(z.string(), z.unknown())
        .describe(
          "The full options object the addon receives in its `/data/options.json`. Shape is addon-specific — read `data.options` from `ha__addon_info` and modify, don't construct from scratch.",
        ),
      decision_ref: AddonDecisionRefParam,
    }),
    buildRequest: ({ slug, options, decision_ref }) => ({
      method: "PUT",
      path: `/api/v1/channels/ha/addons/${encodeURIComponent(slug)}/options`,
      body: { options, decision_ref },
    }),
  },

  {
    name: "ha__addon_start",
    description:
      "Start an installed Supervisor addon. **HAOS-ONLY**. NO gate (reversible — `ha__addon_stop` undoes it). NO snapshot. Use after `ha__addon_install` (Supervisor installs but doesn't always start) or to bring back an addon Sir stopped earlier.",
    inputSchema: z.object({
      slug: AddonSlugParam,
    }),
    buildRequest: ({ slug }) => ({
      method: "POST",
      path: `/api/v1/channels/ha/addons/${encodeURIComponent(slug)}/start`,
    }),
  },

  {
    name: "ha__addon_stop",
    description:
      "Stop a running Supervisor addon. **HAOS-ONLY**. NO gate (reversible — `ha__addon_start` undoes it). NO snapshot. Use to free up resources or before reconfiguring something the addon owns (e.g. stop Zigbee2MQTT before swapping the dongle).",
    inputSchema: z.object({
      slug: AddonSlugParam,
    }),
    buildRequest: ({ slug }) => ({
      method: "POST",
      path: `/api/v1/channels/ha/addons/${encodeURIComponent(slug)}/stop`,
    }),
  },

  {
    name: "ha__addon_restart",
    description:
      "Restart a Supervisor addon. **HAOS-ONLY**. NO gate (cheap, reversible). NO snapshot. Use after `ha__addon_configure` to apply the new options, or when Sir says 'the addon is stuck'.",
    inputSchema: z.object({
      slug: AddonSlugParam,
    }),
    buildRequest: ({ slug }) => ({
      method: "POST",
      path: `/api/v1/channels/ha/addons/${encodeURIComponent(slug)}/restart`,
    }),
  },

  {
    name: "ha__addon_update",
    description:
      "Update a Supervisor addon to the latest version. **HAOS-ONLY**. **GATED** — requires `decision_ref`. **AUTO-SNAPSHOT** — ctrl-api records the intent in `ha_backup_ref` BEFORE the upstream call (so a botched update is auditably rollback-able). Read the version delta via `ha__addon_info` first — `version` vs `version_latest`. Some addon updates require a config migration; surface the release notes to Sir if you can find them.",
    inputSchema: z.object({
      slug: AddonSlugParam,
      decision_ref: AddonDecisionRefParam,
    }),
    buildRequest: ({ slug, decision_ref }) => ({
      method: "POST",
      path: `/api/v1/channels/ha/addons/${encodeURIComponent(slug)}/update`,
      body: { decision_ref },
    }),
  },

  {
    name: "ha__addon_logs",
    description:
      "Last N lines of a Supervisor addon's stdout/stderr. **HAOS-ONLY**. NO gate (read). Default tail = 200 lines, max 2000. Returns `{ok, slug, tail, logs}` — `logs` is a single newline-joined string. **When to call:** Sir asks 'why is the addon failing?' / 'show me the Mosquitto logs' / after an `ha__addon_restart` to confirm it came back up.",
    inputSchema: z.object({
      slug: AddonSlugParam,
      tail: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe(
          "Number of trailing lines to return. Default 200, max 2000. Wider windows return more data; prefer narrow.",
        ),
    }),
    buildRequest: ({ slug, tail }) => ({
      method: "GET",
      path: `/api/v1/channels/ha/addons/${encodeURIComponent(slug)}/logs`,
      query: tail !== undefined ? { tail: String(tail) } : undefined,
    }),
  },
];

// ═════════════════════════════════════════════════════════════════════════
// === END Tier 4 PR6 ═══════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════
// === Tier 4 PR7: Core lifecycle + Backup CRUD ===
// ═════════════════════════════════════════════════════════════════════════
//
// Issue #115 PR7 — 10 new tools fronting ctrl-api's
// /api/v1/channels/ha/core/* + /api/v1/channels/ha/backups/* + /version
// surfaces.
//
// Per the spec §4 gate matrix (locked YES 2026-05-29 by Sir):
//
// | Tool                  | decision_ref | auto-snapshot |
// |-----------------------|--------------|---------------|
// | ha__core_version      | no           | no            |
// | ha__core_check_config | no           | no            |
// | ha__core_reload_yaml  | no           | no            |
// | ha__core_restart      | REQUIRED     | YES           |
// | ha__core_update       | REQUIRED     | YES           |
// | ha__list_backups      | no           | no            |
// | ha__backup_info       | no           | no            |
// | ha__create_backup     | no           | no (this IS a backup)
// | ha__delete_backup     | REQUIRED     | no            |
// | ha__restore_backup    | REQUIRED     | NO (restoring IS the recovery)
//
// Why these particular gates:
//   * core_restart / core_update: HA goes down for 2-10 min. Sir's
//     household notices. decision_ref + auto-snapshot mandatory.
//   * delete_backup: backups themselves are how we roll back; deleting
//     one is unrecoverable. decision_ref required.
//   * restore_backup: HA stops for several minutes during the restore,
//     comes back at a different state. decision_ref required. No
//     snapshot because restoring IS the recovery action — backing up
//     the broken state we're about to overwrite would be backwards.
//   * create_backup: explicit Sir-asked backups are always fine; no
//     gate. ctrl-api still persists a `ha_backup_ref` row with
//     `triggered_by='user'` so the ledger is complete.

const CoreDecisionRefParam = z
  .string()
  .min(6)
  .max(256)
  .regex(
    /^[\x21-\x7E]+$/,
    "decision_ref must be printable ASCII with no whitespace",
  )
  .describe(
    "Vault path or ulid of the `decision/` record that authorised this destructive HA core/backup write. REQUIRED — Alfred refuses without it.",
  );

const BackupIdParam = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,127}$/,
    "backup_id must be 1..128 chars of [A-Za-z0-9_.-], starting with [A-Za-z0-9]",
  )
  .describe(
    "HA backup id (slug). Read via `ha__list_backups` (each backup's `slug` / `backup_id` field) — never invent.",
  );

export const HASS_PR7_TOOLS: ToolDef[] = [
  {
    name: "ha__core_version",
    description:
      "Read HA's `/api/config` — returns `{ha_version, installation_type, location_name, data}` where `ha_version` is the running HA version (e.g. `2025.6.1`) and `installation_type` is one of `Home Assistant OS` / `Home Assistant Container` / `Home Assistant Core` / `Home Assistant Supervised`. **When to call:** before `ha__core_update` (to read current vs latest), when Sir asks 'what HA am I on?', or as a cheap connectivity probe. No gate. Idempotent.",
    inputSchema: z.object({}),
    buildRequest: () => ({
      method: "GET",
      path: "/api/v1/channels/ha/version",
    }),
  },

  {
    name: "ha__core_check_config",
    description:
      "Run HA's config check — verifies configuration.yaml parses cleanly and HA could restart without crashing. Resolves to `POST /api/services/homeassistant/check_config`. **When to call:** ALWAYS before `ha__core_restart` (so a malformed yaml doesn't take HA down) and after a `ha__core_reload_yaml` that hits an error. No gate. Idempotent. Returns the HA service-call result verbatim.",
    inputSchema: z.object({}),
    buildRequest: () => ({
      method: "POST",
      path: "/api/v1/channels/ha/core/check_config",
      body: {},
    }),
  },

  {
    name: "ha__core_reload_yaml",
    description:
      "Reload every HA YAML-defined domain (automations / scripts / scenes / helpers / templates / customise) without restarting HA. Resolves to `POST /api/services/homeassistant/reload_all`. **When to call:** after editing yaml that's outside the REST CRUD surface (most automations / scenes / scripts already reload on their own POST/PUT; this is the broad refresh). No gate (idempotent — reloading again at any time is fine). NOT a restart — entities stay alive. Returns the HA service-call result verbatim.",
    inputSchema: z.object({}),
    buildRequest: () => ({
      method: "POST",
      path: "/api/v1/channels/ha/core/reload_yaml",
      body: {},
    }),
  },

  {
    name: "ha__core_restart",
    description:
      "Restart HA's core process. **DESTRUCTIVE** — HA is OFFLINE for 30-120s while it comes back. Entities go unavailable; automations don't fire. **GATED** — requires `decision_ref`. **AUTO-SNAPSHOT** — ctrl-api triggers a real HA backup via `backup/generate` BEFORE the restart and records it in `ha_backup_ref`. The success envelope returns `backup_ref_id` + `ha_backup_id` + `backup_name`; mention 'snapshot taken' to Sir. **Always `ha__core_check_config` FIRST** — restarting on a broken config takes HA down hard.",
    inputSchema: z.object({
      decision_ref: CoreDecisionRefParam,
    }),
    buildRequest: ({ decision_ref }) => ({
      method: "POST",
      path: "/api/v1/channels/ha/core/restart",
      body: { decision_ref },
    }),
  },

  {
    name: "ha__core_update",
    description:
      "Update HA Core to a newer version via Supervisor's OTA path. **HAOS / Supervised ONLY** — Container HA's update is pulled-image swap (Sir does that with docker compose). **DESTRUCTIVE** — HA is OFFLINE for 3-10 min during the update. **GATED** — requires `decision_ref`. **AUTO-SNAPSHOT** — ctrl-api triggers a real HA backup BEFORE the update and records it in `ha_backup_ref`; rollback is `ha__restore_backup({backup_id: ha_backup_id, …})`. Optional `version` pin (e.g. `2025.7.0`); omit for the latest stable. Read `ha__core_version` first to compare current vs target.",
    inputSchema: z.object({
      version: z
        .string()
        .min(1)
        .max(32)
        .regex(
          /^[A-Za-z0-9._\-+]+$/,
          "version must be 1..32 chars of [A-Za-z0-9._-+]",
        )
        .optional()
        .describe(
          "Pin the update to a specific HA Core version (e.g. `2025.7.0`). Omit to install the latest stable. Read the current version via `ha__core_version` first.",
        ),
      decision_ref: CoreDecisionRefParam,
    }),
    buildRequest: ({ version, decision_ref }) => ({
      method: "POST",
      path: "/api/v1/channels/ha/core/update",
      body: {
        decision_ref,
        ...(version !== undefined ? { version } : {}),
      },
    }),
  },

  {
    name: "ha__list_backups",
    description:
      "List every backup HA knows about — both Alfred-triggered (recorded in `ha_backup_ref`) and HA's own strategy/auto/user-initiated ones. Resolves to WS `backup/info`. Returns `data` straight from HA, typically `{backups: [{slug, name, date, size, type, …}, ...]}`. **When to call:** before `ha__restore_backup` (to find the right slug), when Sir asks 'what backups do I have?', or after `ha__create_backup` to confirm it landed. No gate. Idempotent.",
    inputSchema: z.object({}),
    buildRequest: () => ({
      method: "GET",
      path: "/api/v1/channels/ha/backups",
    }),
  },

  {
    name: "ha__backup_info",
    description:
      "Full details for one HA backup — date, size, addons included, folders included, password-protected y/n, compatible HA version. Resolves to WS `backup/details`. **When to call:** before `ha__restore_backup` (to confirm the backup includes what Sir needs back), when Sir asks 'what's in that backup?'. No gate. Idempotent.",
    inputSchema: z.object({
      backup_id: BackupIdParam,
    }),
    buildRequest: ({ backup_id }) => ({
      method: "GET",
      path: `/api/v1/channels/ha/backups/${encodeURIComponent(backup_id)}`,
    }),
  },

  {
    name: "ha__create_backup",
    description:
      "Generate a fresh HA backup. Resolves to WS `backup/generate`. **No gate** — explicit user-requested backups are always fine, and ctrl-api records the result in `ha_backup_ref` with `triggered_by='user'` so the ledger is complete. **When to call:** Sir asks 'back up HA', or Alfred proactively snapshots before a risky change Alfred can't trigger via a gated verb (e.g. before a long manual session). All fields optional — pass `{}` for the default backup. `password` encrypts the archive; `include_addons` etc. let Sir choose a partial backup.",
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe(
          "Human-readable backup name. HA assigns one if omitted; pass an Alfred-flavour name (e.g. `alfred-pre-zwave-firmware-2026-05-29`) when the trigger is contextual.",
        ),
      password: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional password — encrypts the backup archive. Without it the backup is plaintext on Sir's disk.",
        ),
      include_addons: z
        .array(z.string())
        .optional()
        .describe(
          "Optional addon slug list. Omit for HA's default (all addons).",
        ),
      include_database: z
        .boolean()
        .optional()
        .describe(
          "Include the HA recorder database. Default true; setting false drops the largest piece for a faster backup.",
        ),
      include_homeassistant: z
        .boolean()
        .optional()
        .describe(
          "Include the HA core (config + state). Default true — flipping false produces an addons-only backup.",
        ),
      include_folders: z
        .array(z.string())
        .optional()
        .describe(
          "Optional list of supervisor-known folders to include (e.g. `share`, `media`, `ssl`). Omit for HA's default set.",
        ),
    }),
    buildRequest: ({
      name,
      password,
      include_addons,
      include_database,
      include_homeassistant,
      include_folders,
    }) => ({
      method: "POST",
      path: "/api/v1/channels/ha/backups",
      body: {
        ...(name !== undefined ? { name } : {}),
        ...(password !== undefined ? { password } : {}),
        ...(include_addons !== undefined ? { include_addons } : {}),
        ...(include_database !== undefined ? { include_database } : {}),
        ...(include_homeassistant !== undefined ? { include_homeassistant } : {}),
        ...(include_folders !== undefined ? { include_folders } : {}),
      },
    }),
  },

  {
    name: "ha__delete_backup",
    description:
      "Delete an HA backup. Resolves to WS `backup/delete`. **DESTRUCTIVE + IRREVERSIBLE** — backups themselves are how Alfred rolls back; once a backup is gone, that point-in-time is gone. **GATED** — requires `decision_ref`. **NO snapshot** (we don't auto-snapshot backups before deleting them; that'd be silly). **When to call:** Sir asks to prune old backups, or after a successful restore Sir wants the staging backup gone. ctrl-api records the delete in the daybook.",
    inputSchema: z.object({
      backup_id: BackupIdParam,
      decision_ref: CoreDecisionRefParam,
    }),
    buildRequest: ({ backup_id, decision_ref }) => ({
      method: "DELETE",
      path: `/api/v1/channels/ha/backups/${encodeURIComponent(backup_id)}`,
      body: { decision_ref },
    }),
  },

  {
    name: "ha__restore_backup",
    description:
      "Restore HA from a backup. **DESTRUCTIVE — THIS STOPS HA FOR SEVERAL MINUTES.** HA shuts down, the backup is unpacked over the current state, HA restarts at the backup's snapshot point. State + automations + addons that existed at the backup time come back; anything changed since the backup is LOST. **GATED** — requires `decision_ref`. **NO auto-snapshot** — restoring IS the recovery action; backing up the broken state we're about to overwrite would be backwards. **When to call:** Sir says 'roll back', OR an Alfred-triggered destructive verb (core_restart/core_update/addon_install) failed and Sir wants the pre-snapshot state back. Read `ha__backup_info` FIRST to confirm the backup includes what Sir needs. The MCP envelope returns when the restore is QUEUED — HA itself restarts to apply it; follow up with `ha__core_version` after a minute to confirm it came back.",
    inputSchema: z.object({
      backup_id: BackupIdParam,
      password: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Password for the backup if it was created encrypted. Omit for unencrypted backups; pass the password Sir used at `ha__create_backup` time otherwise.",
        ),
      decision_ref: CoreDecisionRefParam,
    }),
    buildRequest: ({ backup_id, password, decision_ref }) => ({
      method: "POST",
      path: `/api/v1/channels/ha/backups/${encodeURIComponent(backup_id)}/restore`,
      body: {
        decision_ref,
        ...(password !== undefined ? { password } : {}),
      },
    }),
  },
];

// ═════════════════════════════════════════════════════════════════════════
// === END Tier 4 PR7 ═══════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════

// Final catalogue: 46 tools total = 11 read + 15 writes (5 PR4 + 10 PR3 CRUD)
// + 10 PR6 supervisor addon + 10 PR7 core+backups. Order kept deliberately
// (reads first, automations/scenes/scripts next, addon-CRUD next, core+backups
// last) so the model that lists the catalogue sees the safe read surface
// before the destructive surfaces.
export const ALL_HASS_TOOLS: ToolDef[] = [
  ...HASS_READ_TOOLS,
  ...HASS_DEFERRED_TOOLS,
  ...HASS_ADDON_TOOLS,
  ...HASS_PR7_TOOLS,
];
