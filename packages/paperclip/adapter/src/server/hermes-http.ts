/**
 * Hermes HTTP client.
 *
 * Tiny, dependency-free fetch wrapper around `POST /v1/responses` and
 * `GET /health`. Lifted from the canonical pattern in
 * `packages/ctrl/src/api/routes/channels_paperclip.ts` so the two surfaces
 * stay structurally consistent (we use the same fetch shape, the same
 * extractor, the same error discrimination).
 */

import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_HERMES_GATEWAY_URL,
  DEFAULT_HERMES_CONFIG_DIR,
  type HermesProfileName,
} from "../shared/constants.js";

// ── auth key resolver ────────────────────────────────────────────────────

/**
 * Read API_SERVER_KEY for a given Hermes profile out of its rendered
 * `.env`. The per-profile file is the source of truth at runtime
 * (`packages/ctrl/src/api/routes/channels_paperclip.ts::readHermesMainApiKey`
 * uses the identical resolver for the main profile; we observed live a
 * mismatch between the compose-level HERMES_API_SERVER_KEY seed and the
 * profile-level value (64 vs 43 chars), so reading the file directly is
 * what works).
 *
 * codex-builder support added 2026-05-28 (PR 3 of docs/codex-builder-
 * runtime.md): the sealed-runtime profile renders its own API_SERVER_KEY
 * in /hermes-state/profiles/codex-builder/.env. By passing the profile
 * name through here we can mint per-profile API auth from a single
 * resolver — no need for a parallel readHermesCodexBuilderApiKey() copy.
 *
 * Override the base dir via `HERMES_CONFIG_DIR` for tests / dev mounts.
 */
export function readHermesProfileApiKey(
  profile: HermesProfileName,
  configDir = process.env.HERMES_CONFIG_DIR ?? DEFAULT_HERMES_CONFIG_DIR,
): string | null {
  const envPath = path.join(configDir, profile, ".env");
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf-8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    if (t.slice(0, eq).trim() === "API_SERVER_KEY") {
      return t.slice(eq + 1).trim();
    }
  }
  return null;
}

/**
 * Back-compat shim. Old call sites (ctrl-api's channels_paperclip resolver,
 * internal one-off scripts) read the main-profile key by name; preserve
 * the entrypoint so this PR is a pure additive change for them.
 */
export function readHermesMainApiKey(
  configDir = process.env.HERMES_CONFIG_DIR ?? DEFAULT_HERMES_CONFIG_DIR,
): string | null {
  return readHermesProfileApiKey("main", configDir);
}

// ── response shape extractor ─────────────────────────────────────────────

/**
 * Walk the Hermes `/v1/responses` JSON envelope and concatenate the
 * assistant text. Canonical shape:
 *
 *   { output: [..., {type:"message", role:"assistant",
 *                    content:[{type:"output_text", text:"..."}]}],
 *     usage: { input_tokens, output_tokens, ... }
 *   }
 *
 * Tolerates `output` being a string, a single object, or absent (some
 * mocked transports return that shape). Mirrors
 * `extractHermesText` in `channels_paperclip.ts`.
 */
export function extractHermesText(resp: unknown): string {
  if (typeof resp !== "object" || resp === null) return "";
  const r = resp as Record<string, unknown>;
  const out = r.output;

  const partsToText = (parts: unknown): string => {
    if (typeof parts === "string") return parts;
    if (!Array.isArray(parts)) return "";
    const acc: string[] = [];
    for (const p of parts) {
      if (typeof p === "string") {
        acc.push(p);
      } else if (typeof p === "object" && p !== null) {
        const pp = p as Record<string, unknown>;
        if (typeof pp.text === "string") acc.push(pp.text);
        else if (typeof pp.content === "string") acc.push(pp.content);
      }
    }
    return acc.filter((s) => s.length > 0).join("\n");
  };

  if (Array.isArray(out)) {
    let messageText = "";
    for (const item of out) {
      if (typeof item !== "object" || item === null) continue;
      const it = item as Record<string, unknown>;
      if (it.type === "message") {
        const t = partsToText(it.content);
        if (t) messageText = t;
      }
    }
    if (messageText) return messageText;
    return partsToText(out);
  }
  if (typeof out === "string") return out;
  if (typeof out === "object" && out !== null) {
    const o = out as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.content === "string") return o.content;
  }
  const fallback = r.output_text;
  if (typeof fallback === "string") return fallback;
  return "";
}

/**
 * Pull a `{ inputTokens, outputTokens, cachedInputTokens }` shape out of
 * a Hermes `/v1/responses` envelope. Hermes follows the OpenAI Responses
 * shape, so the canonical keys are `usage.input_tokens`,
 * `usage.output_tokens`, `usage.input_tokens_details.cached_tokens`.
 *
 * Returns `null` when usage isn't surfaced.
 */
export interface HermesUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export function extractHermesUsage(resp: unknown): HermesUsage | null {
  if (typeof resp !== "object" || resp === null) return null;
  const r = resp as Record<string, unknown>;
  const u = r.usage;
  if (typeof u !== "object" || u === null) return null;
  const usage = u as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const input =
    num(usage.input_tokens) ?? num(usage.inputTokens) ?? num(usage.prompt_tokens);
  const output =
    num(usage.output_tokens) ??
    num(usage.outputTokens) ??
    num(usage.completion_tokens);
  if (input === null && output === null) return null;
  const result: HermesUsage = {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
  };
  // OpenAI Responses-API nests cached tokens under input_tokens_details.
  const details = usage.input_tokens_details;
  if (typeof details === "object" && details !== null) {
    const cached = num((details as Record<string, unknown>).cached_tokens);
    if (cached !== null) result.cachedInputTokens = cached;
  }
  return result;
}

// ── call surface ─────────────────────────────────────────────────────────

export type HermesCallResult =
  | {
      ok: true;
      text: string;
      usage: HermesUsage | null;
      raw: Record<string, unknown>;
    }
  | {
      ok: false;
      code: "HERMES_UNREACHABLE" | "HERMES_TIMEOUT" | "HERMES_AUTH" | "HERMES_HTTP";
      status: number | null;
      detail: string;
    };

export interface HermesCallOptions {
  gatewayUrl?: string;
  sessionKey: string;
  input: string;
  apiKey?: string | null;
  timeoutMs?: number;
  /** For tests — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * POST to `{gatewayUrl}/v1/responses` and return the parsed envelope +
 * a flattened assistant text. Discriminates timeout (504-flavoured) from
 * unreachable (502-flavoured) from HTTP-error (4xx/5xx with body).
 */
export async function callHermesResponses(
  opts: HermesCallOptions,
): Promise<HermesCallResult> {
  const base = (opts.gatewayUrl ?? DEFAULT_HERMES_GATEWAY_URL).replace(
    /\/+$/,
    "",
  );
  const url = `${base}/v1/responses`;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Hermes-Session-Key": opts.sessionKey,
  };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: opts.input }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const name = (err as Error)?.name ?? "";
    const isTimeout =
      name === "TimeoutError" || name === "AbortError" || /timeout/i.test(msg);
    return {
      ok: false,
      code: isTimeout ? "HERMES_TIMEOUT" : "HERMES_UNREACHABLE",
      status: null,
      detail: msg,
    };
  }

  if (!resp.ok) {
    // Read body best-effort for the error detail; truncate so we don't
    // explode a 5MB upstream error into the Paperclip transcript.
    let body = "";
    try {
      body = (await resp.text()).slice(0, 2048);
    } catch {
      /* ignore */
    }
    const isAuth = resp.status === 401 || resp.status === 403;
    return {
      ok: false,
      code: isAuth ? "HERMES_AUTH" : "HERMES_HTTP",
      status: resp.status,
      detail: body || `Hermes returned HTTP ${resp.status}`,
    };
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    return {
      ok: false,
      code: "HERMES_HTTP",
      status: resp.status,
      detail: "Hermes returned a non-JSON body",
    };
  }
  const text = extractHermesText(json);
  const usage = extractHermesUsage(json);
  return {
    ok: true,
    text,
    usage,
    raw: (json ?? {}) as Record<string, unknown>,
  };
}

/**
 * `GET {gatewayUrl}/health` — used by `testEnvironment`. Hermes' supervisor
 * gates a 200 on both gateways being up.
 */
export async function pingHermesHealth(opts: {
  gatewayUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status: number | null; detail: string }> {
  const base = (opts.gatewayUrl ?? DEFAULT_HERMES_GATEWAY_URL).replace(
    /\/+$/,
    "",
  );
  const url = `${base}/health`;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const resp = await fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.ok) {
      return { ok: true, status: resp.status, detail: "Hermes /health OK" };
    }
    return {
      ok: false,
      status: resp.status,
      detail: `Hermes /health returned HTTP ${resp.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
