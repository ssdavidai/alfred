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

// Mutation surfaces that Sure's REST API doesn't expose (account CRUD,
// rule CRUD) go through Rails-runner scripts inside sure-web. Each
// script reads JSON from a file in the shared /alfred-data volume,
// invokes Sure's ActiveRecord models directly, and prints a single
// JSON line on stdout. See packages/openclaw/init/sure-*-mutate.rb.
const MUTATE_HOST_DIR = "/mnt/encrypted/alfred";
const ACCOUNT_MUTATE_CONTAINER_PATH =
  "/alfred-data/sure-bootstrap/sure-account-mutate.rb";
const RULE_MUTATE_CONTAINER_PATH =
  "/alfred-data/sure-bootstrap/sure-rule-mutate.rb";
const TRANSFER_MUTATE_CONTAINER_PATH =
  "/alfred-data/sure-bootstrap/sure-transfer-mutate.rb";
const ENTRY_MUTATE_CONTAINER_PATH =
  "/alfred-data/sure-bootstrap/sure-entry-mutate.rb";
const CATEGORY_MUTATE_CONTAINER_PATH =
  "/alfred-data/sure-bootstrap/sure-category-mutate.rb";
const TAG_MUTATE_CONTAINER_PATH =
  "/alfred-data/sure-bootstrap/sure-tag-mutate.rb";
const MERCHANT_MUTATE_CONTAINER_PATH =
  "/alfred-data/sure-bootstrap/sure-merchant-mutate.rb";

interface MutateResult {
  ok: boolean;
  error?: string;
  status?: string;
  [key: string]: unknown;
}

async function runRailsRunnerMutate(
  scriptPath: string,
  op: string,
  payload: unknown,
  errCode: string,
): Promise<MutateResult> {
  const id = crypto.randomBytes(8).toString("hex");
  const hostFile = path.join(MUTATE_HOST_DIR, `.sure-mutate-${id}.json`);
  const containerFile = `/alfred-data/.sure-mutate-${id}.json`;

  fs.mkdirSync(MUTATE_HOST_DIR, { recursive: true });
  // 0644 — ctrl-api runs as root, sure-web runs as uid 1000 (rails).
  fs.writeFileSync(hostFile, JSON.stringify(payload ?? {}), { mode: 0o644 });

  let stdout: string;
  try {
    stdout = await dockerExec("sure-web", [
      "bin/rails",
      "runner",
      scriptPath,
      op,
      containerFile,
    ]);
  } catch (err) {
    throw new ApiError(
      502,
      errCode,
      `Rails-runner exec failed: ${(err as Error).message}`,
    );
  } finally {
    try {
      fs.unlinkSync(hostFile);
    } catch {
      /* best-effort cleanup */
    }
  }

  // Rails boot emits warnings before our line — scan from the bottom
  // for the JSON object.
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        return JSON.parse(line) as MutateResult;
      } catch {
        /* keep scanning */
      }
    }
  }
  throw new ApiError(
    502,
    "SURE_MUTATE_PARSE_FAILED",
    `Could not parse JSON from Rails-runner output: ${stdout.slice(0, 500)}`,
  );
}

const runAccountMutate = (op: string, payload: unknown) =>
  runRailsRunnerMutate(ACCOUNT_MUTATE_CONTAINER_PATH, op, payload, "SURE_MUTATE_EXEC_FAILED");

const runRuleMutate = (op: string, payload: unknown) =>
  runRailsRunnerMutate(RULE_MUTATE_CONTAINER_PATH, op, payload, "SURE_RULE_MUTATE_EXEC_FAILED");

const runTransferMutate = (op: string, payload: unknown) =>
  runRailsRunnerMutate(TRANSFER_MUTATE_CONTAINER_PATH, op, payload, "SURE_TRANSFER_MUTATE_EXEC_FAILED");

const runEntryMutate = (op: string, payload: unknown) =>
  runRailsRunnerMutate(ENTRY_MUTATE_CONTAINER_PATH, op, payload, "SURE_ENTRY_MUTATE_EXEC_FAILED");

const runCategoryMutate = (op: string, payload: unknown) =>
  runRailsRunnerMutate(CATEGORY_MUTATE_CONTAINER_PATH, op, payload, "SURE_CATEGORY_MUTATE_EXEC_FAILED");

const runTagMutate = (op: string, payload: unknown) =>
  runRailsRunnerMutate(TAG_MUTATE_CONTAINER_PATH, op, payload, "SURE_TAG_MUTATE_EXEC_FAILED");

const runMerchantMutate = (op: string, payload: unknown) =>
  runRailsRunnerMutate(MERCHANT_MUTATE_CONTAINER_PATH, op, payload, "SURE_MERCHANT_MUTATE_EXEC_FAILED");

function statusFromMutateResult(result: MutateResult): number {
  if (result.ok) return 200;
  switch (result.status) {
    case "validation_error":
      return 422;
    case "not_found":
      return 404;
    case "linked_account":
      return 409;
    default:
      return 400;
  }
}

function forwardMutateResult(
  res: import("node:http").ServerResponse,
  op: "create" | "update" | "delete",
  result: MutateResult,
  errorCode: string,
): void {
  if (!result.ok) {
    sendJson(res, statusFromMutateResult(result), {
      error: { code: errorCode, message: result.error || "unknown error" },
    });
    return;
  }
  // Always forward the whole envelope. `delete` previously projected only
  // `{deleted}`; that broke as soon as scripts started emitting other
  // shapes (e.g. {rejected: id}, {deleted_count: N, transaction_ids: [...]}).
  // create gets 201; everything else gets 200.
  sendJson(res, op === "create" ? 201 : 200, result);
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
    forwardMutateResult(res, "create", result, "SURE_ACCOUNT_MUTATE_ERROR");
  });
  addRoute("PATCH", "/api/v1/sure/accounts/:id", async ({ res, params, body }) => {
    const id = requireParam(params, "id");
    const payload = { ...(body as Record<string, unknown>), id };
    const result = await runAccountMutate("update", payload);
    forwardMutateResult(res, "update", result, "SURE_ACCOUNT_MUTATE_ERROR");
  });
  addRoute("DELETE", "/api/v1/sure/accounts/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const result = await runAccountMutate("delete", { id });
    forwardMutateResult(res, "delete", result, "SURE_ACCOUNT_MUTATE_ERROR");
  });

  // --- Rules (platform extension — Sure's Rules engine has no REST API)
  // GET list / show via the runner's `list` and `show` ops.
  // POST/PATCH/DELETE create/update/delete rules.
  // POST /preview returns matching transactions WITHOUT saving the rule.
  // POST /:id/apply runs the rule against historical transactions.
  addRoute("GET", "/api/v1/sure/rules", async ({ res, query }) => {
    const limit = parseInt(query.get("limit") || "100", 10);
    const result = await runRuleMutate("list", { limit });
    if (!result.ok) {
      sendJson(res, statusFromMutateResult(result), {
        error: { code: "SURE_RULE_MUTATE_ERROR", message: result.error || "unknown error" },
      });
      return;
    }
    sendJson(res, 200, result);
  });
  addRoute("GET", "/api/v1/sure/rules/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const result = await runRuleMutate("show", { id });
    if (!result.ok) {
      sendJson(res, statusFromMutateResult(result), {
        error: { code: "SURE_RULE_MUTATE_ERROR", message: result.error || "unknown error" },
      });
      return;
    }
    sendJson(res, 200, result);
  });
  addRoute("POST", "/api/v1/sure/rules", async ({ res, body }) => {
    const result = await runRuleMutate("create", body);
    forwardMutateResult(res, "create", result, "SURE_RULE_MUTATE_ERROR");
  });
  addRoute("PATCH", "/api/v1/sure/rules/:id", async ({ res, params, body }) => {
    const id = requireParam(params, "id");
    const payload = { ...(body as Record<string, unknown>), id };
    const result = await runRuleMutate("update", payload);
    forwardMutateResult(res, "update", result, "SURE_RULE_MUTATE_ERROR");
  });
  addRoute("DELETE", "/api/v1/sure/rules/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const result = await runRuleMutate("delete", { id });
    forwardMutateResult(res, "delete", result, "SURE_RULE_MUTATE_ERROR");
  });
  addRoute("POST", "/api/v1/sure/rules/:id/apply", async ({ res, params, body }) => {
    const id = requireParam(params, "id");
    const payload = { ...(body as Record<string, unknown>), id };
    const result = await runRuleMutate("apply", payload);
    if (!result.ok) {
      sendJson(res, statusFromMutateResult(result), {
        error: { code: "SURE_RULE_APPLY_ERROR", message: result.error || "unknown error" },
      });
      return;
    }
    sendJson(res, 200, result);
  });
  addRoute("POST", "/api/v1/sure/rules/preview", async ({ res, body }) => {
    const result = await runRuleMutate("preview", body);
    if (!result.ok) {
      sendJson(res, statusFromMutateResult(result), {
        error: { code: "SURE_RULE_PREVIEW_ERROR", message: result.error || "unknown error" },
      });
      return;
    }
    sendJson(res, 200, result);
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

  // --- Transfers (platform extension — Sure has no /transfers REST API)
  // Pairs an outflow on the source account with an inflow on the
  // destination account via Transfer::Creator. Loan payments to
  // liability accounts get kind: loan_payment automatically.
  addRoute("POST", "/api/v1/sure/transfers", async ({ res, body }) => {
    const result = await runTransferMutate("create", body);
    forwardMutateResult(res, "create", result, "SURE_TRANSFER_MUTATE_ERROR");
  });
  addRoute("POST", "/api/v1/sure/transfers/match", async ({ res, body }) => {
    const result = await runTransferMutate("match", body);
    forwardMutateResult(res, "create", result, "SURE_TRANSFER_MUTATE_ERROR");
  });
  addRoute("POST", "/api/v1/sure/transfers/:id/confirm", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const result = await runTransferMutate("confirm", { id });
    forwardMutateResult(res, "update", result, "SURE_TRANSFER_MUTATE_ERROR");
  });
  addRoute("POST", "/api/v1/sure/transfers/:id/reject", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const result = await runTransferMutate("reject", { id });
    forwardMutateResult(res, "delete", result, "SURE_TRANSFER_MUTATE_ERROR");
  });
  addRoute("DELETE", "/api/v1/sure/transfers/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const result = await runTransferMutate("destroy", { id });
    forwardMutateResult(res, "delete", result, "SURE_TRANSFER_MUTATE_ERROR");
  });

  // --- Transaction split / unsplit / bulk operations (platform extension)
  // Sure exposes none of these via REST; web controllers + Entry model
  // methods (Entry#split! / Entry#unsplit! / Entry::Bulkable.bulk_update!)
  // are the canonical paths.
  addRoute("POST", "/api/v1/sure/transactions/:id/split", async ({ res, params, body }) => {
    const id = requireParam(params, "id");
    const payload = { ...(body as Record<string, unknown>), id };
    const result = await runEntryMutate("split", payload);
    forwardMutateResult(res, "update", result, "SURE_ENTRY_MUTATE_ERROR");
  });
  addRoute("POST", "/api/v1/sure/transactions/:id/unsplit", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const result = await runEntryMutate("unsplit", { id });
    forwardMutateResult(res, "update", result, "SURE_ENTRY_MUTATE_ERROR");
  });
  addRoute("POST", "/api/v1/sure/transactions/bulk_update", async ({ res, body }) => {
    const result = await runEntryMutate("bulk_update", body);
    forwardMutateResult(res, "update", result, "SURE_ENTRY_MUTATE_ERROR");
  });
  addRoute("POST", "/api/v1/sure/transactions/bulk_delete", async ({ res, body }) => {
    const result = await runEntryMutate("bulk_delete", body);
    forwardMutateResult(res, "delete", result, "SURE_ENTRY_MUTATE_ERROR");
  });

  // --- Category mutations (platform extension — Sure's REST API is GET-only)
  addRoute("POST", "/api/v1/sure/categories/bootstrap", async ({ res }) => {
    const result = await runCategoryMutate("bootstrap", {});
    forwardMutateResult(res, "update", result, "SURE_CATEGORY_MUTATE_ERROR");
  });
  addRoute("POST", "/api/v1/sure/categories", async ({ res, body }) => {
    const result = await runCategoryMutate("create", body);
    forwardMutateResult(res, "create", result, "SURE_CATEGORY_MUTATE_ERROR");
  });
  addRoute("PATCH", "/api/v1/sure/categories/:id", async ({ res, params, body }) => {
    const id = requireParam(params, "id");
    const payload = { ...(body as Record<string, unknown>), id };
    const result = await runCategoryMutate("update", payload);
    forwardMutateResult(res, "update", result, "SURE_CATEGORY_MUTATE_ERROR");
  });
  addRoute("DELETE", "/api/v1/sure/categories/:id", async ({ res, params, query }) => {
    const id = requireParam(params, "id");
    const replacementId = query.get("replacement_id") || undefined;
    const result = await runCategoryMutate("replace_and_destroy", { id, replacement_id: replacementId });
    forwardMutateResult(res, "delete", result, "SURE_CATEGORY_MUTATE_ERROR");
  });

  // --- Tag merge (platform extension — REST tag CRUD already covers create/update/delete)
  addRoute("POST", "/api/v1/sure/tags/:id/merge_into/:replacement_id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const replacementId = requireParam(params, "replacement_id");
    const result = await runTagMutate("replace_and_destroy", { id, replacement_id: replacementId });
    forwardMutateResult(res, "delete", result, "SURE_TAG_MUTATE_ERROR");
  });

  // --- Merchant mutations (platform extension — REST merchants endpoint is GET-only)
  addRoute("POST", "/api/v1/sure/merchants", async ({ res, body }) => {
    const result = await runMerchantMutate("create", body);
    forwardMutateResult(res, "create", result, "SURE_MERCHANT_MUTATE_ERROR");
  });
  addRoute("PATCH", "/api/v1/sure/merchants/:id", async ({ res, params, body }) => {
    const id = requireParam(params, "id");
    const payload = { ...(body as Record<string, unknown>), id };
    const result = await runMerchantMutate("update", payload);
    forwardMutateResult(res, "update", result, "SURE_MERCHANT_MUTATE_ERROR");
  });
  addRoute("DELETE", "/api/v1/sure/merchants/:id", async ({ res, params }) => {
    const id = requireParam(params, "id");
    const result = await runMerchantMutate("destroy", { id });
    forwardMutateResult(res, "delete", result, "SURE_MERCHANT_MUTATE_ERROR");
  });
  addRoute("POST", "/api/v1/sure/merchants/merge", async ({ res, body }) => {
    const result = await runMerchantMutate("merge", body);
    forwardMutateResult(res, "update", result, "SURE_MERCHANT_MUTATE_ERROR");
  });
  addRoute("POST", "/api/v1/sure/merchants/enhance", async ({ res }) => {
    const result = await runMerchantMutate("enhance", {});
    forwardMutateResult(res, "update", result, "SURE_MERCHANT_MUTATE_ERROR");
  });

  // --- Rule apply_all (runs every family rule against historical transactions)
  addRoute("POST", "/api/v1/sure/rules/apply_all", async ({ res, body }) => {
    const result = await runRuleMutate("apply_all", body);
    if (!result.ok) {
      sendJson(res, statusFromMutateResult(result), {
        error: { code: "SURE_RULE_APPLY_ERROR", message: result.error || "unknown error" },
      });
      return;
    }
    sendJson(res, 200, result);
  });
}
