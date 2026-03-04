import * as ssh from "./ssh.js";

const TAILSCALE_API_BASE = "https://api.tailscale.com/api/v2";

export async function generateAuthKey(
  apiKey: string,
  tailnet: string,
  tenantTag?: string,
): Promise<string> {
  const tags = tenantTag ? [`tag:${tenantTag}`] : ["tag:alfred"];
  const res = await fetch(
    `${TAILSCALE_API_BASE}/tailnet/${tailnet}/keys`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        capabilities: {
          devices: {
            create: {
              reusable: false,
              ephemeral: true,
              preauthorized: true,
              tags,
            },
          },
        },
        expirySeconds: 3600,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tailscale API failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { key: string };
  return data.key;
}

export async function verifyConnected(
  host: string,
  keyPath: string
): Promise<{ hostname: string; ip: string } | null> {
  try {
    const result = await ssh.exec(
      host,
      keyPath,
      "tailscale status --json 2>/dev/null"
    );
    if (result.code !== 0) return null;

    const status = JSON.parse(result.stdout) as {
      Self: { DNSName: string; TailscaleIPs: string[] };
    };
    return {
      hostname: status.Self.DNSName.replace(/\.$/, ""),
      ip: status.Self.TailscaleIPs[0],
    };
  } catch {
    return null;
  }
}
