import crypto from "crypto";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

interface CloudflareConfig {
  accountId: string;
  zoneId: string;
}

interface CloudflareResponse<T = unknown> {
  success: boolean;
  result: T;
  errors: Array<{ code: number; message: string }>;
}

interface TunnelCredentials {
  AccountTag: string;
  TunnelID: string;
  TunnelName: string;
  TunnelSecret: string;
}

export interface TunnelResult {
  id: string;
  name: string;
  credentials: TunnelCredentials;
}

function getConfig(): CloudflareConfig {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;

  if (!accountId || !zoneId) {
    throw new Error(
      "Cloudflare config missing: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID required"
    );
  }

  return { accountId, zoneId };
}

function getDomain(): string {
  return process.env.CLOUDFLARE_DOMAIN ?? "alfred.black";
}

function authHeaders(): Record<string, string> {
  // Support both API Token (Bearer) and Global API Key (X-Auth-Key + X-Auth-Email)
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (apiToken) {
    return {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    };
  }

  const apiKey = process.env.CLOUDFLARE_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL;
  if (apiKey && email) {
    return {
      "X-Auth-Key": apiKey,
      "X-Auth-Email": email,
      "Content-Type": "application/json",
    };
  }

  throw new Error(
    "Cloudflare auth missing: set CLOUDFLARE_API_TOKEN, or CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL"
  );
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${CF_API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return {} as T;

  const data = (await res.json()) as CloudflareResponse<T>;

  if (!data.success) {
    const errors = data.errors.map((e) => `${e.code}: ${e.message}`).join(", ");
    throw new Error(
      `Cloudflare API ${method} ${path} failed (${res.status}): ${errors}`
    );
  }

  return data.result;
}

// --- Public API ---

export function isConfigured(): boolean {
  const hasAuth = !!(
    process.env.CLOUDFLARE_API_TOKEN ||
    (process.env.CLOUDFLARE_API_KEY && process.env.CLOUDFLARE_EMAIL)
  );
  return hasAuth && !!process.env.CLOUDFLARE_ACCOUNT_ID && !!process.env.CLOUDFLARE_ZONE_ID;
}

export async function createTunnel(name: string): Promise<TunnelResult> {
  const { accountId } = getConfig();
  const tunnelSecret = crypto.randomBytes(32).toString("base64");

  const tunnel = await request<{ id: string; name: string }>(
    "POST",
    `/accounts/${accountId}/cfd_tunnel`,
    { name, tunnel_secret: tunnelSecret }
  );

  return {
    id: tunnel.id,
    name: tunnel.name,
    credentials: {
      AccountTag: accountId,
      TunnelID: tunnel.id,
      TunnelName: tunnel.name,
      TunnelSecret: tunnelSecret,
    },
  };
}

export async function deleteTunnel(tunnelId: string): Promise<void> {
  const { accountId } = getConfig();
  await request("DELETE", `/accounts/${accountId}/cfd_tunnel/${tunnelId}`);
}

export async function createDnsRecord(
  subdomain: string,
  tunnelId: string
): Promise<{ id: string }> {
  const { zoneId } = getConfig();
  const domain = getDomain();

  const record = await request<{ id: string }>(
    "POST",
    `/zones/${zoneId}/dns_records`,
    {
      type: "CNAME",
      name: `${subdomain}.${domain}`,
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
    }
  );

  return { id: record.id };
}

export async function deleteDnsRecord(recordId: string): Promise<void> {
  const { zoneId } = getConfig();
  await request("DELETE", `/zones/${zoneId}/dns_records/${recordId}`);
}

export async function createAccessApplication(
  subdomain: string,
  allowedEmails: string[]
): Promise<{ id: string }> {
  const { accountId } = getConfig();
  const domain = getDomain();
  const appDomain = `${subdomain}.${domain}`;

  const app = await request<{ id: string }>(
    "POST",
    `/accounts/${accountId}/access/apps`,
    {
      name: appDomain,
      domain: appDomain,
      type: "self_hosted",
      session_duration: "24h",
    }
  );

  await request(
    "POST",
    `/accounts/${accountId}/access/apps/${app.id}/policies`,
    {
      name: "Email allow policy",
      decision: "allow",
      include: [
        {
          email: { email: allowedEmails },
        },
      ],
    }
  );

  return { id: app.id };
}

export async function deleteAccessApplication(appId: string): Promise<void> {
  const { accountId } = getConfig();
  await request("DELETE", `/accounts/${accountId}/access/apps/${appId}`);
}
