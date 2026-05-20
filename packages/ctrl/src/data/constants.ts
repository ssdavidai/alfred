import type { InstanceStatus, HealthStatus, Screen } from "./types.js";

export const HETZNER_API_BASE = "https://api.hetzner.cloud/v1";

export const LABEL_SELECTOR = "managed-by=alfred-ctrl";

export const DEFAULTS = {
  serverType: "cx33",
  location: "fsn1",
  alfredBasePath: "/opt/alfred",
  dockerComposeDir: "/opt/alfred/compose",
  cloudflaredDir: "/etc/cloudflared",
  sshUser: "deploy",
  cloudflareDomain: "alfred.black",
  cloudInitTimeout: 1_200_000, // 20 minutes (snapshot deploys take 10+ min on Hetzner before cloud-init starts)
  healthInterval: 60_000, // 1 minute
  // Default Hetzner volume size for new tenants. Raised 20 → 50 GB (#781) so
  // the first quarter of organic data growth + a few sidecars (Sure, Plane,
  // Vaultwarden, etc.) doesn't immediately blow past /mnt/encrypted capacity.
  // Existing tenants live-resize via `alfred-ctrl volume-resize <name> <gb>`.
  volumeSizeGb: 50,
} as const;

export const STATUS_COLORS: Record<InstanceStatus, string> = {
  provisioning: "yellow",
  cloud_init: "yellow",
  bootstrapping: "yellow",
  running: "green",
  error: "red",
  destroying: "magenta",
  destroyed: "gray",
};

export const HEALTH_COLORS: Record<HealthStatus, string> = {
  ok: "green",
  degraded: "yellow",
  down: "red",
  unreachable: "gray",
};

export const KEYBINDING_HINTS: Record<Screen, string> = {
  dashboard: "q:quit  n:new  r:refresh  enter:detail  arrows:navigate",
  provision: "esc:cancel  enter:next",
  detail: "esc:back  s:ssh  o:openclaw  a:alfred  l:logs  t:temporal  p:devices  u:update  d:destroy",
  logs: "esc:back",
  devices: "esc:back  a:approve  r:reject  x:remove  R:refresh",
};
