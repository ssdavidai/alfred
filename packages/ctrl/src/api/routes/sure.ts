import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { addRoute } from "../server.js";
import { sendJson, ApiError, ValidationError } from "../errors.js";
import { dockerExec } from "../helpers.js";

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

function requireParam(params: Record<string, string>, name: string): string {
  const v = (params[name] || "").trim();
  if (!v) throw new ValidationError(`${name} is required`);
  return v;
}

// Account mutation goes through a Rails runner inside sure-web because
// Sure's public API is read-only for accounts. The script reads JSON
// from a file in the shared /alfred-data volume (mode 0o600), invokes
// Sure's ActiveRecord models directly, and prints a single JSON line on
// stdout. See packages/openclaw/init/sure-account-mutate.rb.
const ACCOUNT_MUTATE_HOST_DIR = "/mnt/encrypted/alfred";
const ACCOUNT_MUTATE_CONTAINER_PATH =
  "/alfred-data/sure-bootstrap/sure-account-mutate.rb";

interface AccountMutateResult {
  ok: boolean;
  account?: Record<string, unknown>;
  deleted?: string;
  error?: string;
  status?: string;
}

async function runAccountMutate(
  op: "create" | "update" | "delete",
  payload: unknown,
): Promise<AccountMutateResult> {
  const id = crypto.randomBytes(8).toString("hex");
  const hostFile = path.join(ACCOUNT_MUTATE_HOST_DIR, `.sure-mutate-${id}.json`);
  const containerFile = `/alfred-data/.sure-mutate-${id}.json`;

  fs.mkdirSync(ACCOUNT_MUTATE_HOST_DIR, { recursive: true });
  fs.writeFileSync(hostFile, JSON.stringify(payload), { mode: 0o600 });

  let stdout: string;
  try {
    stdout = await dockerExec("sure-web", [
      "bin/rails",
      "runner",
      ACCOUNT_MUTATE_CONTAINER_PATH,
      op,
      containerFile,
    ]);
  } catch (err) {
    fs.unlinkSync(hostFile);
    throw new ApiError(
      502,
      "SURE_MUTATE_EXEC_FAILED",
      `Failed to run account mutate via sure-web: ${(err as Error).message}`,
    );
  } finally {
    try {
      fs.unlinkSync(hostFile);
    } catch {
      /* best-effort cleanup */
    }
  }

  // The script prints a single JSON line. Rails boot can emit warnings
  // before our line, so scan from the bottom for the JSON object.
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        return JSON.parse(line) as AccountMutateResult;
      } catch {
        // keep scanning
      }
    }
  }
  throw new ApiError(
    502,
    "SURE_MUTATE_PARSE_FAILED",
    `Could not parse JSON from sure-account-mutate output: ${stdout.slice(0, 500)}`,
  );
}

function forwardMutateResult(
  res: import("node:http").ServerResponse,
  op: "create" | "update" | "delete",
  result: AccountMutateResult,
): void {
  if (!result.ok) {
    const status = result.status === "validation_error"
      ? 422
      : result.status === "not_found"
        ? 404
        : result.status === "linked_account"
          ? 409
          : 400;
    sendJson(res, status, {
      error: { code: "SURE_ACCOUNT_MUTATE_ERROR", message: result.error || "unknown error" },
    });
    return;
  }
  if (op === "create") {
    sendJson(res, 201, { account: result.account });
  } else if (op === "delete") {
    sendJson(res, 200, { deleted: result.deleted });
  } else {
    sendJson(res, 200, { account: result.account });
  }
}

export function registerSureRoutes(): void {
  // Full Sure API surface — every endpoint in docs.sure.am/openapi.yaml is
  // mirrored here under /api/v1/sure/<sure-path>. Path parameters are
  // forwarded verbatim (URL-encoded). GET endpoints forward the query
  // string; POST/PATCH endpoints forward the JSON body. Sure has no
  // POST /accounts: accounts are created by provider syncs (Lunchflow,
  // Plaid, etc.) or via the Sure web UI, not the REST API.

  // --- Accounts ------------------------------------------------------
  // GET goes through Sure's REST API. POST/PATCH/DELETE go through the
  // Rails-runner script because Sure's public API exposes only `index`.
  addRoute("GET", "/api/v1/sure/accounts", async ({ res, query }) => {
    const r = await sureProxy("GET", "/accounts", query, null);
    forwardSureResponse(res, r);
  });
  addRoute("POST", "/api/v1/sure/accounts", async ({ res, body }) => {
    const result = await runAccountMutate("create", body);
    forwardMutateResult(res, "create", result);
  });
  addRoute("PATCH", "/api/v1/sure/accounts/:id", async ({ res, params, body }) => {
    const id = requireParam(params, "id");
    const payload = { ...(body as Record<string, unknown>), id };
    const result = await runAccountMutate("update", payload);
    forwardMutateResult(res, "update", result);
  });
  addRoute("DELETE", "/api/v1/sure/accounts/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const result = await runAccountMutate("delete", { id });
    forwardMutateResult(res, "delete", result);
  });

  // --- Balance sheet --------------------------------------------------
  addRoute("GET", "/api/v1/sure/balance_sheet", async ({ res }) => {
    const r = await sureProxy("GET", "/balance_sheet", null, null);
    forwardSureResponse(res, r);
  });
  // Backward-compat alias for the hyphenated form shipped in the initial
  // skill draft. New callers should use /balance_sheet to match Sure.
  addRoute("GET", "/api/v1/sure/balance-sheet", async ({ res }) => {
    const r = await sureProxy("GET", "/balance_sheet", null, null);
    forwardSureResponse(res, r);
  });

  // --- Categories -----------------------------------------------------
  addRoute("GET", "/api/v1/sure/categories", async ({ res, query }) => {
    const r = await sureProxy("GET", "/categories", query, null);
    forwardSureResponse(res, r);
  });
  addRoute("GET", "/api/v1/sure/categories/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy("GET", `/categories/${encodeURIComponent(id)}`, null, null);
    forwardSureResponse(res, r);
  });

  // --- Chats (Sure-internal AI assistant chats — distinct from the
  //     external-assistant bridge at /api/v1/sure/assistant) -----------
  addRoute("GET", "/api/v1/sure/chats", async ({ res, query }) => {
    const r = await sureProxy("GET", "/chats", query, null);
    forwardSureResponse(res, r);
  });
  addRoute("POST", "/api/v1/sure/chats", async ({ res, body }) => {
    const r = await sureProxy("POST", "/chats", null, body);
    forwardSureResponse(res, r);
  });
  addRoute("GET", "/api/v1/sure/chats/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy("GET", `/chats/${encodeURIComponent(id)}`, null, null);
    forwardSureResponse(res, r);
  });
  addRoute("PATCH", "/api/v1/sure/chats/:id", async ({ res, params, body }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy("PATCH", `/chats/${encodeURIComponent(id)}`, null, body);
    forwardSureResponse(res, r);
  });
  addRoute("DELETE", "/api/v1/sure/chats/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy("DELETE", `/chats/${encodeURIComponent(id)}`, null, null);
    forwardSureResponse(res, r);
  });
  addRoute("POST", "/api/v1/sure/chats/:chat_id/messages", async ({ res, params, body }) => {
    const chatId = requireParam(params, "chat_id");
    const r = await sureProxy(
      "POST",
      `/chats/${encodeURIComponent(chatId)}/messages`,
      null,
      body,
    );
    forwardSureResponse(res, r);
  });
  addRoute("POST", "/api/v1/sure/chats/:chat_id/messages/retry", async ({ res, params, body }) => {
    const chatId = requireParam(params, "chat_id");
    const r = await sureProxy(
      "POST",
      `/chats/${encodeURIComponent(chatId)}/messages/retry`,
      null,
      body,
    );
    forwardSureResponse(res, r);
  });

  // --- Holdings (read-only — created via trades/valuations) ------------
  addRoute("GET", "/api/v1/sure/holdings", async ({ res, query }) => {
    const r = await sureProxy("GET", "/holdings", query, null);
    forwardSureResponse(res, r);
  });
  addRoute("GET", "/api/v1/sure/holdings/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy("GET", `/holdings/${encodeURIComponent(id)}`, null, null);
    forwardSureResponse(res, r);
  });

  // --- Imports (CSV bulk imports) -------------------------------------
  addRoute("GET", "/api/v1/sure/imports", async ({ res, query }) => {
    const r = await sureProxy("GET", "/imports", query, null);
    forwardSureResponse(res, r);
  });
  addRoute("POST", "/api/v1/sure/imports", async ({ res, body }) => {
    const r = await sureProxy("POST", "/imports", null, body);
    forwardSureResponse(res, r);
  });
  addRoute("GET", "/api/v1/sure/imports/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy("GET", `/imports/${encodeURIComponent(id)}`, null, null);
    forwardSureResponse(res, r);
  });

  // --- Merchants (read-only — Sure infers from transactions) -----------
  addRoute("GET", "/api/v1/sure/merchants", async ({ res, query }) => {
    const r = await sureProxy("GET", "/merchants", query, null);
    forwardSureResponse(res, r);
  });
  addRoute("GET", "/api/v1/sure/merchants/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy("GET", `/merchants/${encodeURIComponent(id)}`, null, null);
    forwardSureResponse(res, r);
  });

  // --- Sync -----------------------------------------------------------
  addRoute("POST", "/api/v1/sure/sync", async ({ res, body }) => {
    const r = await sureProxy("POST", "/sync", null, body);
    forwardSureResponse(res, r);
  });

  // --- Tags -----------------------------------------------------------
  addRoute("GET", "/api/v1/sure/tags", async ({ res, query }) => {
    const r = await sureProxy("GET", "/tags", query, null);
    forwardSureResponse(res, r);
  });
  addRoute("POST", "/api/v1/sure/tags", async ({ res, body }) => {
    const r = await sureProxy("POST", "/tags", null, body);
    forwardSureResponse(res, r);
  });
  addRoute("GET", "/api/v1/sure/tags/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy("GET", `/tags/${encodeURIComponent(id)}`, null, null);
    forwardSureResponse(res, r);
  });
  addRoute("PATCH", "/api/v1/sure/tags/:id", async ({ res, params, body }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy("PATCH", `/tags/${encodeURIComponent(id)}`, null, body);
    forwardSureResponse(res, r);
  });
  addRoute("DELETE", "/api/v1/sure/tags/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy("DELETE", `/tags/${encodeURIComponent(id)}`, null, null);
    forwardSureResponse(res, r);
  });

  // --- Trades (investment trades) -------------------------------------
  addRoute("GET", "/api/v1/sure/trades", async ({ res, query }) => {
    const r = await sureProxy("GET", "/trades", query, null);
    forwardSureResponse(res, r);
  });
  addRoute("POST", "/api/v1/sure/trades", async ({ res, body }) => {
    const r = await sureProxy("POST", "/trades", null, body);
    forwardSureResponse(res, r);
  });
  addRoute("GET", "/api/v1/sure/trades/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy("GET", `/trades/${encodeURIComponent(id)}`, null, null);
    forwardSureResponse(res, r);
  });
  addRoute("PATCH", "/api/v1/sure/trades/:id", async ({ res, params, body }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy("PATCH", `/trades/${encodeURIComponent(id)}`, null, body);
    forwardSureResponse(res, r);
  });
  addRoute("DELETE", "/api/v1/sure/trades/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy("DELETE", `/trades/${encodeURIComponent(id)}`, null, null);
    forwardSureResponse(res, r);
  });

  // --- Transactions ---------------------------------------------------
  addRoute("GET", "/api/v1/sure/transactions", async ({ res, query }) => {
    const r = await sureProxy("GET", "/transactions", query, null);
    forwardSureResponse(res, r);
  });
  addRoute("POST", "/api/v1/sure/transactions", async ({ res, body }) => {
    const r = await sureProxy("POST", "/transactions", null, body);
    forwardSureResponse(res, r);
  });
  addRoute("GET", "/api/v1/sure/transactions/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy(
      "GET",
      `/transactions/${encodeURIComponent(id)}`,
      null,
      null,
    );
    forwardSureResponse(res, r);
  });
  addRoute("PATCH", "/api/v1/sure/transactions/:id", async ({ res, params, body }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy(
      "PATCH",
      `/transactions/${encodeURIComponent(id)}`,
      null,
      body,
    );
    forwardSureResponse(res, r);
  });
  addRoute("DELETE", "/api/v1/sure/transactions/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy(
      "DELETE",
      `/transactions/${encodeURIComponent(id)}`,
      null,
      null,
    );
    forwardSureResponse(res, r);
  });

  // --- Usage ----------------------------------------------------------
  addRoute("GET", "/api/v1/sure/usage", async ({ res }) => {
    const r = await sureProxy("GET", "/usage", null, null);
    forwardSureResponse(res, r);
  });

  // --- Users (admin / destructive) ------------------------------------
  // DELETE /users/me deactivates the API user. DELETE /users/reset wipes
  // all data and returns Sure to a fresh state. Both are exposed because
  // the platform mirrors Sure's full surface; they are nuclear options
  // and the skill warns the agent accordingly.
  addRoute("DELETE", "/api/v1/sure/users/me", async ({ res }) => {
    const r = await sureProxy("DELETE", "/users/me", null, null);
    forwardSureResponse(res, r);
  });
  addRoute("DELETE", "/api/v1/sure/users/reset", async ({ res }) => {
    const r = await sureProxy("DELETE", "/users/reset", null, null);
    forwardSureResponse(res, r);
  });

  // --- Valuations (manual balance reconciliation) ---------------------
  addRoute("POST", "/api/v1/sure/valuations", async ({ res, body }) => {
    const r = await sureProxy("POST", "/valuations", null, body);
    forwardSureResponse(res, r);
  });
  addRoute("GET", "/api/v1/sure/valuations/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy("GET", `/valuations/${encodeURIComponent(id)}`, null, null);
    forwardSureResponse(res, r);
  });
  addRoute("PATCH", "/api/v1/sure/valuations/:id", async ({ res, params, body }) => {
    const id = requireParam(params, "id");
    const r = await sureProxy("PATCH", `/valuations/${encodeURIComponent(id)}`, null, body);
    forwardSureResponse(res, r);
  });
}
