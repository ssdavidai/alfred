import { addRoute } from "../server.js";
import { sendJson, ApiError, ValidationError } from "../errors.js";

interface SureConfig {
  token: string;
  base: string;
}

function requireSureConfig(): SureConfig {
  const token = process.env.SURE_API_KEY;
  const base = (process.env.SURE_API_URL || "http://sure-web:3000").replace(/\/+$/, "");
  if (!token) {
    throw new ApiError(
      500,
      "NOT_CONFIGURED",
      "Sure not configured on this tenant (missing SURE_API_KEY)",
    );
  }
  return { token, base };
}

interface SureProxyResult {
  status: number;
  data: unknown;
  errorText?: string;
}

async function sureProxy(
  method: string,
  path: string,
  query: URLSearchParams | null,
  body: unknown,
): Promise<SureProxyResult> {
  const cfg = requireSureConfig();
  const qs = query ? query.toString() : "";
  const url = `${cfg.base}/api/v1${path}${qs ? `?${qs}` : ""}`;

  const headers: Record<string, string> = {
    "X-Api-Key": cfg.token,
    Accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined && body !== null && method !== "GET" && method !== "DELETE") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    throw new ApiError(
      502,
      "SURE_UNREACHABLE",
      `Failed to reach Sure: ${(err as Error).message}`,
    );
  }

  const ct = resp.headers.get("content-type") || "";
  if (!resp.ok) {
    const errorText = (await resp.text().catch(() => "")).slice(0, 500);
    return { status: resp.status, data: null, errorText };
  }

  if (resp.status === 204 || !ct.includes("application/json")) {
    return { status: resp.status, data: null };
  }

  let data: unknown = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }
  return { status: resp.status, data };
}

function forwardSureResponse(
  res: import("node:http").ServerResponse,
  result: SureProxyResult,
): void {
  if (result.errorText !== undefined && (result.status < 200 || result.status >= 300)) {
    sendJson(res, result.status, {
      error: {
        code: "SURE_API_ERROR",
        message: result.errorText || `Sure responded with ${result.status}`,
      },
    });
    return;
  }
  sendJson(res, result.status || 200, result.data ?? {});
}

function requireTransactionId(params: Record<string, string>): string {
  const id = (params.id || "").trim();
  if (!id) {
    throw new ValidationError("id is required");
  }
  return id;
}

export function registerSureRoutes(): void {
  addRoute("GET", "/api/v1/sure/balance-sheet", async ({ res }) => {
    const result = await sureProxy("GET", "/balance_sheet", null, null);
    forwardSureResponse(res, result);
  });

  addRoute("GET", "/api/v1/sure/accounts", async ({ res, query }) => {
    const result = await sureProxy("GET", "/accounts", query, null);
    forwardSureResponse(res, result);
  });

  addRoute("GET", "/api/v1/sure/transactions", async ({ res, query }) => {
    const result = await sureProxy("GET", "/transactions", query, null);
    forwardSureResponse(res, result);
  });

  addRoute("POST", "/api/v1/sure/transactions", async ({ res, body }) => {
    const result = await sureProxy("POST", "/transactions", null, body);
    forwardSureResponse(res, result);
  });

  addRoute("PATCH", "/api/v1/sure/transactions/:id", async ({ res, params, body }) => {
    const id = requireTransactionId(params);
    const result = await sureProxy(
      "PATCH",
      `/transactions/${encodeURIComponent(id)}`,
      null,
      body,
    );
    forwardSureResponse(res, result);
  });

  addRoute("DELETE", "/api/v1/sure/transactions/:id", async ({ res, params }) => {
    const id = requireTransactionId(params);
    const result = await sureProxy(
      "DELETE",
      `/transactions/${encodeURIComponent(id)}`,
      null,
      null,
    );
    forwardSureResponse(res, result);
  });

  addRoute("GET", "/api/v1/sure/categories", async ({ res, query }) => {
    const result = await sureProxy("GET", "/categories", query, null);
    forwardSureResponse(res, result);
  });

  addRoute("GET", "/api/v1/sure/merchants", async ({ res, query }) => {
    const result = await sureProxy("GET", "/merchants", query, null);
    forwardSureResponse(res, result);
  });

  addRoute("POST", "/api/v1/sure/sync", async ({ res, body }) => {
    const result = await sureProxy("POST", "/sync", null, body);
    forwardSureResponse(res, result);
  });

  addRoute("POST", "/api/v1/sure/valuations", async ({ res, body }) => {
    const result = await sureProxy("POST", "/valuations", null, body);
    forwardSureResponse(res, result);
  });

  addRoute("GET", "/api/v1/sure/usage", async ({ res }) => {
    const result = await sureProxy("GET", "/usage", null, null);
    forwardSureResponse(res, result);
  });
}
