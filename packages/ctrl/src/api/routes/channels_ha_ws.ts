// Tier 4 HA WS routes — health + WS-backed registries (#115/#158 PR1).
//
// Two surfaces here:
//
// 1. `GET /api/v1/channels/ha/ws/status` — the health-check endpoint for
//    the long-lived HA WS client. Returns the singleton's status object
//    so the dashboard's /channels/ha card can render "WS connected /
//    last_msg_at / reconnect_count / queue_depth".
//
// 2. `GET /api/v1/channels/ha/ws/registries` — WS-backed area/device/
//    entity/scene/script registry pull. This is the LOAD-BEARING fix
//    for #149: HaBootstrapWorkflow Phase A's REST calls to
//    `/api/config/area_registry/list` returned 404 because those
//    registries are WS-only. The Python activity (learn-side) now calls
//    this ctrl-api route instead, which proxies through the long-lived
//    WS client. The route returns the shape the bulk-upsert path
//    already accepts so the activity can pipe straight through.
//
// Why we do the WS call here, not in the activity
// ------------------------------------------------
// alfred-learn (Python) cannot share the long-lived `ha_ws_client` Node
// singleton that ctrl-api maintains. Opening a fresh WS per activity
// run would also race the loop-guard contract (PR3 watcher). The
// cleanest seam: ctrl-api owns ONE WS connection; everyone else calls
// REST routes that proxy through it. That's the architecture #115 spec
// §3.1 specifies and the model the rest of Tier 4 (PR2-PR8) extends.
//
// Auth
// ----
// Both routes are operator-only (master AAS_API_KEY). The status route
// could in principle be read by anyone, but until #115's audit ladder
// settles we keep them behind the master gate so a leaked voice/channel
// token can't probe the HA-side health.

import { addRoute } from "../server.js";
import { sendJson, ApiError } from "../errors.js";
import { getHaWsClient, TIER4_EVENT_STREAMS } from "../lib/ha_ws_client.js";

interface RegistryRow {
  kind: "area" | "device" | "entity" | "scene" | "script";
  ha_id: string;
  payload_json: string;
  friendly_name: string | null;
  area_id: string | null;
  domain: string | null;
  last_seen_at: string;
}

/**
 * Normalise an area record to the ctrl-api ha_registry shape.
 */
function areaToRow(area: Record<string, unknown>, ts: string): RegistryRow | null {
  const id = typeof area.area_id === "string" ? (area.area_id as string) : null;
  if (!id) return null;
  return {
    kind: "area",
    ha_id: id,
    payload_json: JSON.stringify(area),
    friendly_name: typeof area.name === "string" ? (area.name as string) : null,
    area_id: id,
    domain: null,
    last_seen_at: ts,
  };
}

function deviceToRow(device: Record<string, unknown>, ts: string): RegistryRow | null {
  const id = typeof device.id === "string" ? (device.id as string) : null;
  if (!id) return null;
  const name =
    typeof device.name_by_user === "string"
      ? (device.name_by_user as string)
      : typeof device.name === "string"
        ? (device.name as string)
        : null;
  return {
    kind: "device",
    ha_id: id,
    payload_json: JSON.stringify(device),
    friendly_name: name,
    area_id: typeof device.area_id === "string" ? (device.area_id as string) : null,
    domain: null,
    last_seen_at: ts,
  };
}

function entityRegToRow(e: Record<string, unknown>, ts: string): RegistryRow | null {
  const id = typeof e.entity_id === "string" ? (e.entity_id as string) : null;
  if (!id) return null;
  const domain = id.includes(".") ? id.split(".", 1)[0] : null;
  return {
    kind: "entity",
    ha_id: id,
    payload_json: JSON.stringify(e),
    friendly_name:
      typeof e.name === "string"
        ? (e.name as string)
        : typeof e.original_name === "string"
          ? (e.original_name as string)
          : null,
    area_id: typeof e.area_id === "string" ? (e.area_id as string) : null,
    domain,
    last_seen_at: ts,
  };
}

function sceneOrScriptToRow(
  kind: "scene" | "script",
  rec: Record<string, unknown>,
  ts: string,
): RegistryRow | null {
  const id =
    typeof rec.entity_id === "string"
      ? (rec.entity_id as string)
      : typeof rec.id === "string"
        ? (rec.id as string)
        : null;
  if (!id) return null;
  return {
    kind,
    ha_id: id,
    payload_json: JSON.stringify(rec),
    friendly_name: typeof rec.name === "string" ? (rec.name as string) : null,
    area_id: null,
    domain: kind,
    last_seen_at: ts,
  };
}

export function registerHaWsRoutes(): void {
  // ────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/ws/status
  // ────────────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/channels/ha/ws/status", async ({ res }) => {
    const client = getHaWsClient();
    const status = client.getStatus();
    sendJson(res, 200, {
      ...status,
      subscribed_event_types: [...TIER4_EVENT_STREAMS],
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/ha/ws/registries
  //
  // Pulls area / device / entity / scene / script registries via the
  // long-lived WS client. Returns a `rows` array shaped for the existing
  // bulk-upsert path (POST /registry/bulk).
  //
  // Closes #149 — HaBootstrapWorkflow Phase A can call this instead of
  // the HA REST `/api/config/area_registry/list` etc. that returned 404.
  // ────────────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/channels/ha/ws/registries", async ({ res }) => {
    const client = getHaWsClient();
    const ts = new Date().toISOString();
    let areas: unknown;
    let devices: unknown;
    let entities: unknown;
    let scenes: unknown;
    let scripts: unknown;
    try {
      [areas, devices, entities, scenes, scripts] = await Promise.all([
        client.wsCall("config/area_registry/list"),
        client.wsCall("config/device_registry/list"),
        client.wsCall("config/entity_registry/list"),
        // scenes / scripts aren't strictly registries on every HA
        // version — best-effort, default to []. The `wsCall` rejects on
        // error so we trap each independently rather than racing them.
        client.wsCall("config/scene/list").catch(() => []),
        client.wsCall("config/script/list").catch(() => []),
      ]);
    } catch (err) {
      throw new ApiError(
        502,
        "HA_WS_REGISTRY_FAILED",
        `HA WS registry pull failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const rows: RegistryRow[] = [];
    if (Array.isArray(areas)) {
      for (const a of areas) {
        const r = areaToRow(a as Record<string, unknown>, ts);
        if (r) rows.push(r);
      }
    }
    if (Array.isArray(devices)) {
      for (const d of devices) {
        const r = deviceToRow(d as Record<string, unknown>, ts);
        if (r) rows.push(r);
      }
    }
    if (Array.isArray(entities)) {
      for (const e of entities) {
        const r = entityRegToRow(e as Record<string, unknown>, ts);
        if (r) rows.push(r);
      }
    }
    if (Array.isArray(scenes)) {
      for (const s of scenes) {
        const r = sceneOrScriptToRow("scene", s as Record<string, unknown>, ts);
        if (r) rows.push(r);
      }
    }
    if (Array.isArray(scripts)) {
      for (const s of scripts) {
        const r = sceneOrScriptToRow("script", s as Record<string, unknown>, ts);
        if (r) rows.push(r);
      }
    }
    sendJson(res, 200, {
      ok: true,
      counts: {
        areas: Array.isArray(areas) ? (areas as unknown[]).length : 0,
        devices: Array.isArray(devices) ? (devices as unknown[]).length : 0,
        entities: Array.isArray(entities) ? (entities as unknown[]).length : 0,
        scenes: Array.isArray(scenes) ? (scenes as unknown[]).length : 0,
        scripts: Array.isArray(scripts) ? (scripts as unknown[]).length : 0,
      },
      rows,
    });
  });
}
