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

  // --- Servers ---

  async createServer(params: {
    name: string;
    server_type: string;
    location: string;
    ssh_keys: number[];
    user_data?: string;
    firewalls?: { firewall: number }[];
    labels?: Record<string, string>;
  }): Promise<{ server: HetznerServer }> {
    return this.request("POST", "/servers", {
      name: params.name,
      server_type: params.server_type,
      location: params.location,
      image: "ubuntu-24.04",
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
