// --- Screens ---

export type Screen = "dashboard" | "provision" | "detail" | "logs" | "devices";

// --- Instance ---

export type InstanceStatus =
  | "provisioning"
  | "cloud_init"
  | "bootstrapping"
  | "running"
  | "error"
  | "destroying"
  | "destroyed";

export interface Instance {
  id: number;
  customer_name: string;
  status: InstanceStatus;
  server_id: number | null;
  ip_address: string | null;
  volume_id: number | null;
  tailscale_hostname: string | null;
  tailscale_ip: string | null;
  ssh_key_id: number | null;
  ssh_key_path: string | null;
  ssh_host_key: string | null;
  gateway_token: string | null;
  api_key: string | null;
  tailscale_tag: string | null;
  subdomain: string | null;
  cf_tunnel_id: string | null;
  cf_tunnel_name: string | null;
  cf_dns_record_id: string | null;
  cf_access_app_id: string | null;
  server_type: string;
  location: string;
  current_image_sha: string | null;
  last_healthy_sha: string | null;
  last_health_check: string | null;
  last_health_status: HealthStatus | null;
  created_at: string;
  updated_at: string;
}

export interface InstanceConfig {
  customer_name: string;
  customer_email?: string;
  server_type: string;
  location: string;
  tailscale_authkey: string;
  openrouter_api_key?: string;
  tailscale_tag?: string;
  subdomain?: string;
  snapshot_id?: number;
}

// --- Provisioning ---

export type ProvisioningStep =
  | "generate_keypair"
  | "upload_ssh_key"
  | "ensure_firewall"
  | "create_volume"
  | "render_cloud_init"
  | "create_server"
  | "wait_cloud_init"
  | "upload_env"
  | "configure_backups"
  | "upload_compose"
  | "start_containers"
  | "bootstrap_openclaw"
  | "backup_luks_key"
  | "deploy_api"
  | "setup_tunnel"
  | "health_check"
  | "done";

export interface ProvisioningState {
  step: ProvisioningStep;
  instance_id: number | null;
  server_id: number | null;
  volume_id: number | null;
  ssh_key_id: number | null;
  ip_address: string | null;
  error: string | null;
  logs: string[];
}

// --- Health ---

export type HealthStatus = "ok" | "degraded" | "down" | "unreachable";

export interface HealthCheck {
  id: number;
  instance_id: number;
  checked_at: string;
  status: HealthStatus;
  disk_percent: number | null;
  memory_percent: number | null;
  response_json: string | null;
}

export interface ContainerStatus {
  Name: string;
  Service: string;
  State: string;
  Health: string;
  ExitCode: number;
}

// --- OpenClaw Devices ---

export interface OpenClawDevice {
  requestId?: string; // only on pending devices
  deviceId: string;
  displayName?: string;
  platform: string;
  clientId: string;
  clientMode: string;
  role: string;
  roles: string[];
  scopes: string[];
  createdAtMs?: number;
  approvedAtMs?: number;
  ts?: number; // pending request timestamp
}

// --- Events ---

export type EventType =
  | "provisioned"
  | "cloud_init_complete"
  | "bootstrap_complete"
  | "running"
  | "destroying"
  | "destroyed"
  | "error"
  | "health_ok"
  | "health_degraded"
  | "health_down"
  | "health_unreachable"
  | "updated"
  | "rolled_back"
  | "api_deployed"
  | "tunnel_repaired";

export interface Event {
  id: number;
  instance_id: number;
  event_type: EventType;
  message: string;
  details_json: string | null;
  created_at: string;
}
