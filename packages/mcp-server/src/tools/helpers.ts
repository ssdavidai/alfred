// Shared helper for all Sure tools: build a fetch request to the tenant's
// ctrl-api with the right auth headers, parse the response, return a
// uniform MCP `content` payload.
//
// Auth headers attached on every outbound request:
//   1. Authorization: Bearer <ctx.aasApiKey>
//      — ctrl-api's own API-key gate. The bearer comes from the OAuth
//      grant's `props` payload (set at /authorize approval time), not
//      from a global env secret.
//   2. CF-Access-Client-Id + CF-Access-Client-Secret (optional)
//      — only attached if the OAuth grant's `props` carry both. The tenant's
//      subdomain has no Access policy today, so these are unset.

import type { CtrlContext } from "./types.js";

export interface ProxyOptions {
  /** HTTP method. Defaults to GET. */
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Path relative to the ctrl base URL (must start with `/api/v1/`). */
  path: string;
  /**
   * Object whose entries become URL query params. Coerced to strings.
   * Arrays append the param once per element (`?ids=a&ids=b`).
   * Undefined / null / "" entries are omitted.
   */
  query?: Record<string, unknown>;
  /** Request body. Serialised as JSON for non-GET methods. */
  body?: unknown;
}

export interface ProxyResult {
  status: number;
  body: unknown;
}

/**
 * Build the absolute URL for a ctrl-api request, including query string.
 * Exported for tests.
 */
export function buildUrl(baseUrl: string, path: string, query?: ProxyOptions["query"]): string {
  // Trim trailing slash on base, leading slash on path will be preserved.
  const base = baseUrl.replace(/\/+$/, "");
  const u = new URL(base + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item !== undefined && item !== null) u.searchParams.append(k, String(item));
        }
      } else {
        u.searchParams.set(k, String(v));
      }
    }
  }
  return u.toString();
}

/**
 * Make an authenticated request to the tenant's ctrl-api.
 *
 * Returns the raw status + parsed body. Tools convert this into the MCP
 * tool-result shape (text content). Non-2xx responses are NOT thrown —
 * they're returned with the status so the caller can decide whether to
 * surface as an error result or pass through (e.g. 404 may be expected
 * when the tool is "find by name" and the name doesn't exist).
 */
export async function proxyToCtrl(ctx: CtrlContext, opts: ProxyOptions): Promise<ProxyResult> {
  const url = buildUrl(ctx.ctrlUrl, opts.path, opts.query);
  const method = opts.method ?? "GET";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.aasApiKey}`,
    Accept: "application/json",
  };
  if (ctx.cfAccessClientId && ctx.cfAccessClientSecret) {
    headers["CF-Access-Client-Id"] = ctx.cfAccessClientId;
    headers["CF-Access-Client-Secret"] = ctx.cfAccessClientSecret;
  }

  const init: RequestInit = { method, headers };
  if (opts.body !== undefined && method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  const resp = await fetch(url, init);
  const text = await resp.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: resp.status, body };
}

/**
 * Convert a ProxyResult into the MCP tool-result content shape that
 * Claude Desktop expects.
 *
 * Success (2xx) → JSON-stringified body as text content.
 * Failure (non-2xx) → text content + isError=true so the model knows the
 * call did not succeed (and surfaces the upstream error to Sir).
 */
export function toolResult(result: ProxyResult): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  const ok = result.status >= 200 && result.status < 300;
  const text =
    typeof result.body === "string"
      ? result.body
      : JSON.stringify(result.body, null, 2);

  if (!ok) {
    return {
      content: [
        {
          type: "text",
          text: `ctrl-api returned HTTP ${result.status}:\n\n${text}`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text }],
  };
}
