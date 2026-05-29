# Issue #115 — Full HA autonomy (Tier 4): Alfred as HA's superuser

**Status:** spec draft 2026-05-29  
**Author:** Sir + Claude  
**Companion to:** #110 (HA integration), #111 (Alfred as conversation agent), #112 (HA voice bridge)

## The decision

Sir explicitly chose **Tier 4** when asked which autonomy level Alfred should
have over HA. That tier is *every CRUD verb on every HA surface:*

| Surface | Tier 1 (read) | Tier 2 (+CRUD entities) | Tier 3 (+addons/integrations) | **Tier 4 (+core+users)** |
|---|---|---|---|---|
| Entity state | ✅ | ✅ | ✅ | ✅ |
| Service calls | — | ✅ | ✅ | ✅ |
| Automations / scripts / scenes | — | ✅ | ✅ | ✅ |
| Areas / devices / labels | — | ✅ | ✅ | ✅ |
| Integrations (config_flow) | — | — | ✅ | ✅ |
| HACS custom components | — | — | ✅ | ✅ |
| Supervisor addons | — | — | ✅ | ✅ |
| HA core (restart / version / backups) | — | — | — | ✅ |
| Users / auth / API tokens | — | — | — | ✅ |

Today Alfred is at **Tier 1 + partial Tier 2** (11 read tools shipped in #128;
5 write stubs in PR3 that wave-D #143 wired to the write surface). Tier 4 is
~50 new tools spread across the next 4 waves.

## Why tier 4 specifically

Sir said "I want Alfred to be the one setting and maintaining everything for
me not me." A tier-3 Alfred can react to the principal's home but can't
adopt a new device class without Sir clicking through HA's UI; a tier-4
Alfred can. That changes the relationship from "Alfred operates what Sir
configured" to "Alfred maintains the home." Concretely:

- "I just got a new Hue bridge" → tier-3 Alfred says "Sir, please add the
  Hue integration in HA Settings." Tier-4 Alfred says "Done — 12 bulbs
  named, all grouped under Living Room, scenes Day/Night/Reading
  imported."
- "HA is out of date" → tier-3 Alfred surfaces a Desk card. Tier-4 Alfred
  reads the release notes, takes a snapshot, applies the OTA update,
  rolls back if any entity goes unavailable for >5min after restart.
- "My kid needs HA access without seeing the security cams" → tier-3
  Alfred is silent. Tier-4 Alfred provisions a HA user, mints an LLAT,
  configures a person-scoped allowlist, gives Sir the link.

## What's not yet decided (Sir to confirm)

The blast radius of tier 4 is higher. Three knobs to set:

1. **Approval gates.** Today the 5 PR4 write tools (`ha__call_service` etc.)
   are gated by `decision_ref` — every write either references a Desk
   decision Sir approved, or is rejected. Extend to all tier-4 verbs?
   Probably yes for `ha__core_restart` / `ha__user_create` / `ha__addon_install`;
   probably no for cheap entity-level CRUD (`ha__create_scene`,
   `ha__update_automation`). Suggested split below in §4.
2. **Snapshots.** Tier 4 writes can break HA in ways Tier 2 can't (a bad
   addon install vs. a wrong service call). Auto-snapshot before
   `addon_install`, `integration_add`, `core_restart`, `core_update`?
   Default yes.
3. **What gets a daybook entry vs. silent.** Cheap reversible writes
   silent; everything else recorded in a daybook so Sir has an audit
   trail.

Defaults proposed; Sir says yes or amends.

## Architecture

### REST vs WebSocket

HA's REST API is a strict subset of its WebSocket API. The Tier 4 surface
crosses that boundary:

- **REST-only:** `/api/states/*`, `/api/services/*`, `/api/history/*`,
  `/api/logbook/*`, `/api/calendars/*`, `/api/config/automation/*`,
  `/api/config/scene/*`, `/api/config/script/*` — already used.
- **WS-only:** `area_registry`, `device_registry`, `entity_registry`
  (full CRUD), `assist_pipeline/*`, `auth/*` (user mgmt), `hacs/*`,
  `supervisor/*` (addons), `backup/*`, `config_entries/flow/*`
  (integrations), `subscribe_events`.

Tonight's HaBootstrap revealed that #110 PR5 hit this — areas/devices/scenes
came back 0 because PR5 used REST and those registries are WS-only. Issue
#149 tracks it.

**Tier 4 needs a long-lived HA WebSocket client in ctrl-api.** One
durable connection, auto-reconnect with exponential backoff, message
multiplexer with per-request `id` counter, drains the event stream
into `state.db.ha_event` for the LearningWorkflow to read.

### ctrl-api routes (new)

```
# Integrations
POST   /api/v1/channels/ha/integrations/discover       — config_flow flow_init
POST   /api/v1/channels/ha/integrations/configure      — config_flow flow_progress
GET    /api/v1/channels/ha/integrations               — list all config_entries
DELETE /api/v1/channels/ha/integrations/:entry_id     — config_entries/remove
POST   /api/v1/channels/ha/integrations/:entry_id/reload — config_entries/reload

# HACS
GET    /api/v1/channels/ha/hacs/repos                  — hacs/repositories/list
POST   /api/v1/channels/ha/hacs/install                — hacs/repository/download
DELETE /api/v1/channels/ha/hacs/:repo                  — hacs/repository/remove
POST   /api/v1/channels/ha/hacs/refresh                — hacs/repository/refresh

# Supervisor addons (HAOS-only — surface returns 501 on Container HA)
GET    /api/v1/channels/ha/addons                      — supervisor/addons
POST   /api/v1/channels/ha/addons/:slug/install        — supervisor/addons/<slug>/install
POST   /api/v1/channels/ha/addons/:slug/start          — supervisor/addons/<slug>/start
POST   /api/v1/channels/ha/addons/:slug/stop
POST   /api/v1/channels/ha/addons/:slug/uninstall
PUT    /api/v1/channels/ha/addons/:slug/options        — supervisor/addons/<slug>/options

# Core
POST   /api/v1/channels/ha/core/restart                — homeassistant/restart
POST   /api/v1/channels/ha/core/check_config           — homeassistant/check_config
POST   /api/v1/channels/ha/core/update                 — supervisor/core/update
GET    /api/v1/channels/ha/backups                     — backup/info
POST   /api/v1/channels/ha/backups                     — backup/generate
DELETE /api/v1/channels/ha/backups/:id                 — backup/remove
POST   /api/v1/channels/ha/backups/:id/restore         — backup/restore
GET    /api/v1/channels/ha/version                     — REST GET /api/config

# Users (HA Auth)
GET    /api/v1/channels/ha/users                       — config/auth/list
POST   /api/v1/channels/ha/users                       — config/auth/create
DELETE /api/v1/channels/ha/users/:id                   — config/auth/delete
POST   /api/v1/channels/ha/users/:id/long_lived_token  — auth/long_lived_access_token

# Areas / Devices / Entities / Labels (full CRUD via WS registries)
GET/POST/PUT/DELETE /api/v1/channels/ha/areas/...
GET/POST/PUT/DELETE /api/v1/channels/ha/devices/...
GET/POST/PUT/DELETE /api/v1/channels/ha/entities/...
GET/POST/PUT/DELETE /api/v1/channels/ha/labels/...

# Scenes / Scripts / Automations (full CRUD — REST exists, just wire it)
GET/POST/PUT/DELETE /api/v1/channels/ha/scenes/...
GET/POST/PUT/DELETE /api/v1/channels/ha/scripts/...
GET/POST/PUT/DELETE /api/v1/channels/ha/automations/...
```

### Hass MCP tools (new — ~35 tools)

| Tool | Approval gate | Snapshot before? |
|---|---|---|
| `ha__integration_discover` | none | no |
| `ha__integration_configure` | `decision_ref` | yes if reload-required |
| `ha__integration_remove` | `decision_ref` | yes |
| `ha__integration_reload` | `decision_ref` | no |
| `ha__hacs_search` | none | no |
| `ha__hacs_install` | `decision_ref` | yes |
| `ha__hacs_remove` | `decision_ref` | yes |
| `ha__hacs_refresh` | none | no |
| `ha__addon_list` | none | no |
| `ha__addon_install` | `decision_ref` | yes |
| `ha__addon_uninstall` | `decision_ref` | yes |
| `ha__addon_configure` | `decision_ref` | no |
| `ha__addon_start` / `ha__addon_stop` | none (reversible) | no |
| `ha__core_restart` | `decision_ref` | yes |
| `ha__core_update` | `decision_ref` | yes |
| `ha__core_check_config` | none | no |
| `ha__backup_create` | none | no |
| `ha__backup_restore` | `decision_ref` + Sir-confirm | n/a |
| `ha__backup_delete` | `decision_ref` | no |
| `ha__user_create` | `decision_ref` | no |
| `ha__user_delete` | `decision_ref` | no |
| `ha__user_mint_llat` | `decision_ref` | no |
| `ha__area_create` / `update` / `delete` | none | no |
| `ha__device_label` / `move` | none | no |
| `ha__entity_rename` / `hide` / `disable` | none | no |
| `ha__label_create` / `apply` / `remove` | none | no |
| `ha__scene_create` / `update` / `delete` | none | no |
| `ha__script_create` / `update` / `delete` | none | no |
| `ha__automation_create` / `update` / `delete` | none for create+update / `decision_ref` for delete | no |

**Rule:** gate any verb whose effect a non-technical principal couldn't
trivially reverse in <2 minutes through HA's own UI. Everything else
runs free.

### state.db additions

```sql
CREATE TABLE ha_backup_ref (        -- index of HA snapshots Alfred made
  id TEXT PRIMARY KEY,
  ha_backup_id TEXT NOT NULL,
  triggered_by TEXT NOT NULL,         -- 'ha__core_update', 'ha__addon_install', ...
  decision_ref TEXT,                  -- which decision the trigger came from
  ts TEXT NOT NULL
);

CREATE TABLE ha_integration_ref (   -- what Alfred added vs what Sir added
  entry_id TEXT PRIMARY KEY,
  installed_by TEXT NOT NULL,         -- 'alfred' | 'sir'
  decision_ref TEXT,
  installed_at TEXT
);

CREATE TABLE ha_user_ref (          -- principals Alfred provisioned
  ha_user_id TEXT PRIMARY KEY,
  name TEXT,
  decision_ref TEXT,
  llat_vw_id TEXT,                    -- Vaultwarden item id holding their LLAT
  created_at TEXT
);
```

Migration `0009_ha_tier4.sql` adds these.

## Phasing

- **PR1 — WS client.** Long-lived `ctrl-api ↔ HA` WS connection,
  auto-reconnect, request multiplexer, event-stream → `state.db.ha_event`.
  Closes #149 (the area/device gap).
- **PR2 — Registries CRUD.** `/areas/*`, `/devices/*`, `/entities/*`,
  `/labels/*` + matching MCP tools. No approval gate (cheap, reversible).
- **PR3 — Automations / scenes / scripts CRUD.** Wire the REST endpoints,
  add tools.
- **PR4 — Integrations.** config_flow REST. The trickiest one — flow
  steps can require multiple POSTs and user input. Skill doc tells
  Alfred how to drive multi-step flows.
- **PR5 — HACS.** WS API, install/remove/refresh, repo search.
- **PR6 — Supervisor addons.** HAOS-only; surface returns 501 on
  Container HA. PR3 of #110 already detects HA install type.
- **PR7 — Core + backups.** restart / update / check_config / backup CRUD.
  Snapshot-on-trigger logic.
- **PR8 — Users + LLAT.** Provision HA users, mint LLATs into a
  per-user Vaultwarden item.

Each PR shippable independently; PR1 is the load-bearing prerequisite
for PR2/PR5/PR8.

## Done criteria

- All 35 new MCP tools registered in main profile
- Approval-gate semantics enforced (test: a `ha__addon_install` without
  `decision_ref` returns 400)
- Backup-on-trigger tested with a real install/uninstall round-trip on home
- Skill doc (`alfred-mcp-skill.md`) updated with the tier-4 playbook
- `home.alfred.black` Alfred can answer "install the Hue integration with
  ip 192.168.1.42" end-to-end without Sir touching HA's UI.
