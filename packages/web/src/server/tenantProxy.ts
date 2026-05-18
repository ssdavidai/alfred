import { HttpError } from "wasp/server";
import { encryptApiKey, decryptApiKey } from "./columnCrypto";

// Single-VM reframe. There is no fleet, no per-user Acme Cloud instance, no
// Tailscale/Cloudflare ingress — the Wasp app, ctrl-api, and every other
// service share one Docker compose network. Every dashboard query/action
// proxies to the same local ctrl-api at a fixed service-DNS address.
//
// The two exported functions keep their original signatures so the ~17
// dashboard callers (and the apikeys proxy, reconcile worker, etc.) need
// zero changes — `getUserInstance` still returns "an instance", it's just
// a `{}` sentinel now, and `proxyToTenant` still takes it as its first arg.
const CTRL_API_URL = process.env.CTRL_API_URL ?? "http://ctrl-api:3100";
const CTRL_API_KEY = process.env.AAS_API_KEY ?? "";

// 60s, not 15s. Several ctrl-api endpoints (admin/activity, vault/list/*,
// matters aggregator) scan thousands of vault files synchronously and
// regularly take 2-4 s under no load; under burst load from the Desk's
// ~12 parallel queries plus alfred-learn's background workers, individual
// requests serialise on the single Node event loop and routinely cross
// 15 s.
const TENANT_API_TIMEOUT = 60_000;

// Sentinel "instance" — single-VM has exactly one local target, so there is
// no per-user instance row to carry. Callers still pass this through to
// `proxyToTenant` for signature compatibility; it is otherwise ignored.
export type Instance = Record<string, never>;

interface ProxyOptions {
  method?: string;
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  timeoutMs?: number;
}

export async function proxyToTenant(
  _instance: Instance | null,
  options: ProxyOptions,
): Promise<any> {
  if (!CTRL_API_KEY) {
    throw new HttpError(
      500,
      "AAS_API_KEY is not configured — cannot reach the local ctrl-api.",
    );
  }

  const url = buildUrl(options.path, options.query);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs || TENANT_API_TIMEOUT,
  );

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${CTRL_API_KEY}`,
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
              ? "Internal ctrl-api error"
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
      throw new HttpError(504, "ctrl-api request timed out");
    }
    throw new HttpError(502, "Failed to reach the local ctrl-api");
  } finally {
    clearTimeout(timeout);
  }
}

function buildUrl(path: string, query?: Record<string, string>): string {
  const base = `${CTRL_API_URL}${path}`;
  if (!query || Object.keys(query).length === 0) return base;
  const params = new URLSearchParams(query);
  return `${base}?${params.toString()}`;
}

export async function getUserInstance(context: any): Promise<Instance> {
  if (!context.user) {
    throw new HttpError(401, "Not authenticated");
  }
  // Single-VM: there is exactly one local ctrl-api. Return a sentinel so
  // every existing `const instance = await getUserInstance(context)` call
  // site keeps working without change.
  return {};
}

// Re-exported for back-compat with every existing
// `from "../server/tenantProxy"` import. `columnCrypto.ts` still encrypts
// OAuthCredential access/refresh tokens at rest.
export { encryptApiKey, decryptApiKey };
