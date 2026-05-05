CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'provisioning',
  server_id INTEGER,
  ip_address TEXT,
  volume_id INTEGER,
  tailscale_hostname TEXT,
  tailscale_ip TEXT,
  ssh_key_id INTEGER,
  ssh_key_path TEXT,
  ssh_host_key TEXT,
  server_type TEXT NOT NULL DEFAULT 'cx22',
  location TEXT NOT NULL DEFAULT 'fsn1',
  gateway_token TEXT,
  api_key TEXT,
  tailscale_tag TEXT,
  subdomain TEXT,
  cf_tunnel_id TEXT,
  cf_tunnel_name TEXT,
  cf_dns_record_id TEXT,
  cf_plane_dns_record_id TEXT,
  cf_sure_dns_record_id TEXT,
  cf_vault_dns_record_id TEXT,
  cf_vault_access_app_id TEXT,
  cf_access_app_id TEXT,
  cf_vexa_dns_record_id TEXT,
  current_image_sha TEXT,
  last_healthy_sha TEXT,
  last_health_check TEXT,
  last_health_status TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS health_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL,
  disk_percent REAL,
  memory_percent REAL,
  response_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_health_checks_instance
  ON health_checks(instance_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_instance
  ON events(instance_id, created_at DESC);
