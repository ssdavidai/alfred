import { HETZNER_API_BASE, LABEL_SELECTOR } from "../data/constants.js";

export interface HetznerServer {
  id: number;
  name: string;
  status: string;
  public_net: {
    ipv4: { ip: string };
    ipv6: { ip: string };
  };
  server_type: { name: string };
  datacenter: { name: string; location: { name: string } };
  labels: Record<string, string>;
  created: string;
}

export interface HetznerVolume {
  id: number;
  name: string;
  size: number;
  server: number | null;
  location: { name: string };
  status: string;
}

export interface HetznerSSHKey {
  id: number;
  name: string;
  fingerprint: string;
  public_key: string;
}

export interface HetznerFirewall {
  id: number;
  name: string;
}

export interface HetznerImage {
  id: number;
  type: "snapshot" | "system" | "app" | "backup";
  status: string;
  description: string;
  image_size: number;
  created: string;
  created_from: { id: number; name: string } | null;
  labels: Record<string, string>;
}

export interface FirewallRule {
  direction: "in" | "out";
  protocol: "tcp" | "udp" | "icmp" | "gre" | "esp";
  port?: string;
  source_ips?: string[];
  destination_ips?: string[];
}

class HetznerClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${HETZNER_API_BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(
        `Hetzner API ${method} ${path} failed (${res.status}): ${errBody}`
      );
    }

    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  }

  // --- Server Type Availability ---

  /**
   * Check if a server type is available in a specific location.
   * Uses GET /server_types?name={type} and checks if the location
   * appears in the pricing list (empty = unavailable).
   */
  async isServerTypeAvailable(
    serverType: string,
    location: string
  ): Promise<boolean> {
    try {
      const data = await this.request<{
        server_types: Array<{
          name: string;
          prices: Array<{ location: string; price_monthly: { gross: string } }>;
        }>;
      }>("GET", `/server_types?name=${encodeURIComponent(serverType)}`);

      const st = data.server_types?.[0];
      if (!st) return false; // server type doesn't exist

      // Check if the location appears in the pricing list
      return st.prices.some((p) => p.location === location);
    } catch {
      // If API fails, assume available (let createServer fail with specific error)
      return true;
    }
  }

  // --- Servers ---

  async createServer(params: {
    name: string;
    server_type: string;
    location: string;
    image?: string | number;
    ssh_keys: number[];
    user_data?: string;
    firewalls?: { firewall: number }[];
    labels?: Record<string, string>;
  }): Promise<{ server: HetznerServer }> {
    return this.request("POST", "/servers", {
      name: params.name,
      server_type: params.server_type,
      location: params.location,
      image: params.image ?? "ubuntu-24.04",
      ssh_keys: params.ssh_keys,
      user_data: params.user_data,
      firewalls: params.firewalls,
      labels: {
        "managed-by": "alfred-ctrl",
        ...params.labels,
      },
    });
  }

  async getServer(id: number): Promise<{ server: HetznerServer }> {
    return this.request("GET", `/servers/${id}`);
  }

  async listServers(): Promise<{ servers: HetznerServer[] }> {
    return this.request(
      "GET",
      `/servers?label_selector=${LABEL_SELECTOR}&per_page=50`
    );
  }

  async deleteServer(id: number): Promise<void> {
    await this.request("DELETE", `/servers/${id}`);
  }

  async enableBackup(serverId: number): Promise<void> {
    await this.request("POST", `/servers/${serverId}/actions/enable_backup`);
  }

  async poweroffServer(serverId: number): Promise<void> {
    await this.request("POST", `/servers/${serverId}/actions/poweroff`);
  }

  // --- Volumes ---

  async createVolume(params: {
    name: string;
    size: number;
    location: string;
    labels?: Record<string, string>;
    automount?: boolean;
    format?: string;
  }): Promise<{ volume: HetznerVolume }> {
    return this.request("POST", "/volumes", {
      name: params.name,
      size: params.size,
      location: params.location,
      automount: params.automount ?? false,
      format: params.format,
      labels: {
        "managed-by": "alfred-ctrl",
        ...params.labels,
      },
    });
  }

  async listVolumes(): Promise<HetznerVolume[]> {
    const data = await this.request<{ volumes: HetznerVolume[] }>(
      "GET",
      `/volumes?per_page=50`
    );
    return data.volumes;
  }

  async deleteVolume(id: number): Promise<void> {
    await this.request("DELETE", `/volumes/${id}`);
  }

  async attachVolume(
    volumeId: number,
    serverId: number,
    automount?: boolean
  ): Promise<void> {
    await this.request("POST", `/volumes/${volumeId}/actions/attach`, {
      server: serverId,
      automount: automount ?? false,
    });
  }

  async detachVolume(volumeId: number): Promise<void> {
    await this.request("POST", `/volumes/${volumeId}/actions/detach`);
  }

  // --- SSH Keys ---

  async createSSHKey(
    name: string,
    publicKey: string
  ): Promise<{ ssh_key: HetznerSSHKey }> {
    return this.request("POST", "/ssh_keys", {
      name,
      public_key: publicKey,
      labels: { "managed-by": "alfred-ctrl" },
    });
  }

  async listSSHKeys(): Promise<HetznerSSHKey[]> {
    const data = await this.request<{ ssh_keys: HetznerSSHKey[] }>(
      "GET",
      `/ssh_keys?per_page=50`
    );
    return data.ssh_keys;
  }

  async deleteSSHKey(id: number): Promise<void> {
    await this.request("DELETE", `/ssh_keys/${id}`);
  }

  // --- Firewalls ---

  async createFirewall(
    name: string,
    rules: FirewallRule[]
  ): Promise<{ firewall: HetznerFirewall }> {
    return this.request("POST", "/firewalls", {
      name,
      rules,
      labels: { "managed-by": "alfred-ctrl" },
    });
  }

  async getFirewalls(): Promise<{ firewalls: HetznerFirewall[] }> {
    return this.request(
      "GET",
      `/firewalls?label_selector=${LABEL_SELECTOR}&per_page=50`
    );
  }

  async deleteFirewall(id: number): Promise<void> {
    await this.request("DELETE", `/firewalls/${id}`);
  }

  // --- Images / Snapshots ---

  async createImage(
    serverId: number,
    description: string,
    labels?: Record<string, string>
  ): Promise<{ image: HetznerImage }> {
    return this.request("POST", `/servers/${serverId}/actions/create_image`, {
      type: "snapshot",
      description,
      labels: {
        "managed-by": "alfred-ctrl",
        ...labels,
      },
    });
  }

  async listImages(
    type: "snapshot" | "system" = "snapshot",
    labelSelector?: string
  ): Promise<{ images: HetznerImage[] }> {
    const params = new URLSearchParams({ type, per_page: "50" });
    if (labelSelector) params.set("label_selector", labelSelector);
    return this.request("GET", `/images?${params}`);
  }

  async deleteImage(id: number): Promise<void> {
    await this.request("DELETE", `/images/${id}`);
  }

  async getImage(id: number): Promise<{ image: HetznerImage }> {
    return this.request("GET", `/images/${id}`);
  }
}

let client: HetznerClient | null = null;

export function getHetznerClient(): HetznerClient {
  if (client) return client;
  const token = process.env.HETZNER_API_TOKEN;
  if (!token) throw new Error("HETZNER_API_TOKEN not set");
  client = new HetznerClient(token);
  return client;
}

export { HetznerClient };
