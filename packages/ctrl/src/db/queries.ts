import { getDb } from "./index.js";
import type {
  Instance,
  InstanceStatus,
  HealthCheck,
  HealthStatus,
  Event,
  EventType,
} from "../data/types.js";

// --- Instances ---

export function createInstance(
  customer_name: string,
  server_type: string,
  location: string
): Instance {
  const db = getDb();
  // Remove any previously destroyed instance with the same name
  // (Hetzner reuses names across provision/destroy cycles).
  db.prepare(
    `DELETE FROM instances WHERE customer_name = ? AND status = 'destroyed'`
  ).run(customer_name);
  const stmt = db.prepare(
    `INSERT INTO instances (customer_name, server_type, location)
     VALUES (?, ?, ?)
     RETURNING *`
  );
  return stmt.get(customer_name, server_type, location) as Instance;
}

export function getInstance(id: number): Instance | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM instances WHERE id = ?").get(id) as
    | Instance
    | undefined;
}

export function getInstanceByName(name: string): Instance | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM instances WHERE customer_name = ?")
    .get(name) as Instance | undefined;
}

export function listInstances(status?: InstanceStatus): Instance[] {
  const db = getDb();
  if (status) {
    return db
      .prepare("SELECT * FROM instances WHERE status = ? ORDER BY id")
      .all(status) as Instance[];
  }
  return db
    .prepare(
      "SELECT * FROM instances WHERE status != 'destroyed' ORDER BY id"
    )
    .all() as Instance[];
}

export function updateInstance(
  id: number,
  updates: Partial<
    Pick<
      Instance,
      | "status"
      | "server_id"
      | "ip_address"
      | "volume_id"
      | "tailscale_hostname"
      | "tailscale_ip"
      | "ssh_key_id"
      | "ssh_key_path"
      | "ssh_host_key"
      | "gateway_token"
      | "api_key"
      | "current_image_sha"
      | "last_healthy_sha"
      | "last_health_check"
      | "last_health_status"
      | "tailscale_tag"
      | "subdomain"
      | "cf_tunnel_id"
      | "cf_tunnel_name"
      | "cf_dns_record_id"
      | "cf_plane_dns_record_id"
      | "cf_sure_dns_record_id"
      | "cf_access_app_id"
    >
  >
): void {
  const db = getDb();
  const fields = Object.keys(updates) as (keyof typeof updates)[];
  if (fields.length === 0) return;

  const setClauses = fields.map((f) => `${f} = ?`);
  setClauses.push("updated_at = datetime('now')");
  const sql = `UPDATE instances SET ${setClauses.join(", ")} WHERE id = ?`;
  const values = fields.map((f) => updates[f] ?? null);
  values.push(id as any);
  db.prepare(sql).run(...values);
}

export function deleteInstance(id: number): void {
  const db = getDb();
  db.prepare("DELETE FROM instances WHERE id = ?").run(id);
}

// --- Health Checks ---

export function insertHealthCheck(
  instance_id: number,
  status: HealthStatus,
  disk_percent: number | null,
  memory_percent: number | null,
  response_json: string | null
): HealthCheck {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO health_checks (instance_id, status, disk_percent, memory_percent, response_json)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`
  );
  return stmt.get(
    instance_id,
    status,
    disk_percent,
    memory_percent,
    response_json
  ) as HealthCheck;
}

export function getLatestHealthChecks(
  instance_id: number,
  limit = 10
): HealthCheck[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM health_checks
       WHERE instance_id = ?
       ORDER BY checked_at DESC
       LIMIT ?`
    )
    .all(instance_id, limit) as HealthCheck[];
}

export function getHealthHistory(
  instance_id: number,
  hours = 24
): HealthCheck[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM health_checks
       WHERE instance_id = ?
         AND checked_at >= datetime('now', ?)
       ORDER BY checked_at ASC`
    )
    .all(instance_id, `-${hours} hours`) as HealthCheck[];
}

// --- Events ---

export function insertEvent(
  instance_id: number,
  event_type: EventType,
  message: string,
  details_json?: string
): Event {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO events (instance_id, event_type, message, details_json)
     VALUES (?, ?, ?, ?)
     RETURNING *`
  );
  return stmt.get(
    instance_id,
    event_type,
    message,
    details_json ?? null
  ) as Event;
}

export function getEvents(instance_id: number, limit = 50): Event[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM events
       WHERE instance_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(instance_id, limit) as Event[];
}
