import { HttpError } from "wasp/server";
import { Instance } from "wasp/entities";
import { encryptApiKey, decryptApiKey } from "./columnCrypto";

// 60s, not 15s. Several ctrl-api endpoints (admin/activity, vault/list/*,
// matters aggregator) scan thousands of vault files synchronously and
// regularly take 2-4 s under no load; under burst load from the Desk's
// ~12 parallel queries plus alfred-learn's background workers, individual
// requests serialise on the single Node event loop and routinely cross
// 15 s. The old ceiling caused 504 storms on every Desk action because
// the post-mutation invalidateQueries re-fires the whole fan-out at once.
const TENANT_API_TIMEOUT = 60_000;

interface ProxyOptions {
  method?: string;
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  timeoutMs?: number;
}

export async function proxyToTenant(
  instance: Instance | null,
  options: ProxyOptions,
): Promise<any> {
  if (!instance) {
    throw new HttpError(404, "No instance found. Please complete setup first.");
  }

  if (!instance.tailscaleHostname || !instance.apiKey) {
    throw new HttpError(
      503,
      "Instance is not ready yet. Please wait for provisioning to complete.",
    );
  }

  if (instance.status !== "running") {
    throw new HttpError(
      503,
      `Instance is ${instance.status}. It must be running to access the dashboard.`,
    );
  }

  // Preview-mode write blocker. Two modes:
  //   WRITE_BLOCK_TENANT_OPS=true                    → block ALL non-GET writes
  //   WRITE_BLOCK_TENANT_OPS_DENYLIST=host1,host2    → block writes only for
  //                                                    listed tailscale hostnames
  // The blanket switch takes precedence over the denylist.
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    if (process.env.WRITE_BLOCK_TENANT_OPS === 'true') {
      throw new HttpError(
        503,
        `Preview-mode write blocker — refusing ${method} ${options.path}`,
      );
    }
    const denylist = process.env.WRITE_BLOCK_TENANT_OPS_DENYLIST;
    if (denylist) {
      const blocked = denylist
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
      if (
        instance.tailscaleHostname &&
        blocked.includes(instance.tailscaleHostname)
      ) {
        throw new HttpError(
          503,
          `Preview-mode write blocker — refusing ${method} ${options.path}`,
        );
      }
    }
  }

  const apiKey = decryptApiKey(instance.apiKey);
  // Route through Cloudflare tunnel (subdomainUrl) since the Wasp
  // container runs on a Docker bridge network without Tailscale access.
  // The CF tunnel routes /api/v1/* to ctrl-api on port 3100.
  const url = instance.subdomainUrl
    ? buildSubdomainUrl(instance.subdomainUrl, options.path, options.query)
    : buildUrl(instance.tailscaleHostname, options.path, options.query);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || TENANT_API_TIMEOUT);

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // Sanitize error messages to avoid leaking internal details
      const safeMessage =
        response.status === 404
          ? "Resource not found"
          : response.status === 401
            ? "Authentication failed"
            : response.status >= 500
              ? "Internal tenant error"
              : text?.slice(0, 200) || response.statusText;
      throw new HttpError(response.status, safeMessage);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    return response.text();
  } catch (error: any) {
    if (error instanceof HttpError) throw error;
    if (error.name === "AbortError") {
      throw new HttpError(504, "Tenant API request timed out");
    }
    throw new HttpError(502, "Failed to reach tenant instance");
  } finally {
    clearTimeout(timeout);
  }
}

function buildUrl(
  hostname: string,
  path: string,
  query?: Record<string, string>,
): string {
  const base = `https://${hostname}:3100${path}`;
  if (!query || Object.keys(query).length === 0) return base;
  const params = new URLSearchParams(query);
  return `${base}?${params.toString()}`;
}

function buildSubdomainUrl(
  subdomainUrl: string,
  path: string,
  query?: Record<string, string>,
): string {
  // Route through Cloudflare tunnel: https://tenant.alfred.black/api/v1/...
  const base = `${subdomainUrl.replace(/\/$/, "")}${path}`;
  if (!query || Object.keys(query).length === 0) return base;
  const params = new URLSearchParams(query);
  return `${base}?${params.toString()}`;
}

export async function getUserInstance(context: any): Promise<Instance | null> {
  if (!context.user) {
    throw new HttpError(401, "Not authenticated");
  }
  return context.entities.Instance.findUnique({
    where: { userId: context.user.id },
  });
}

// Encryption helpers for API keys stored in PostgreSQL.
// Implementation lives in columnCrypto.ts so callers / tests can use
// these without pulling Wasp's `wasp/server` runtime; re-exported here
// for back-compat with every existing `from "../server/tenantProxy"`
// import in the codebase.
export { encryptApiKey, decryptApiKey };
