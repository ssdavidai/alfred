/**
 * HTTP-mode `execute()` for the `hermes_local` Paperclip adapter on
 * alfred-black tenants. Replaces the upstream child-process spawn with a
 * `POST /v1/responses` against the tenant's Hermes container.
 *
 * The interface is identical: Paperclip passes us an
 * `AdapterExecutionContext`, we return an `AdapterExecutionResult`. What
 * changes is everything between — see DESIGN.md for the mapping table.
 */

import {
  ADAPTER_TYPE,
  DEFAULT_HERMES_GATEWAY_URL,
  DEFAULT_TIMEOUT_SEC,
  SESSION_KEY_PREFIX,
} from "../shared/constants.js";

import {
  callHermesResponses,
  readHermesMainApiKey,
  type HermesCallResult,
} from "./hermes-http.js";

import { buildPrompt } from "./prompt.js";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "../types/paperclip.js";

// ── config helpers ───────────────────────────────────────────────────────

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Resolve a per-agent Hermes session key. Hermes keys its message history
 * off the `X-Hermes-Session-Key` header; using the same value across
 * heartbeats gives us session continuity without needing the upstream
 * `--resume <sessionId>` round-trip.
 *
 * Strategy:
 *   1. If the agent.adapterConfig pins `sessionKey`, honour it (operator override).
 *   2. Otherwise derive from `paperclip-<agentId>`.
 *
 * Note: NOT keyed by issue/task. One Paperclip agent = one Hermes session.
 * Matches the existing ctrl-api heartbeat translator (channels_paperclip.ts).
 */
export function resolveSessionKey(
  agentId: string,
  config: Record<string, unknown>,
): string {
  const pinned = asString(config.sessionKey);
  if (pinned) return pinned;
  return `${SESSION_KEY_PREFIX}${agentId}`;
}

// ── main execute ─────────────────────────────────────────────────────────

export interface ExecuteDeps {
  /** Override for tests — defaults to the real HTTP path. */
  callHermes?: (
    sessionKey: string,
    input: string,
    opts: { gatewayUrl: string; apiKey: string | null; timeoutMs: number },
  ) => Promise<HermesCallResult>;
  /** Override for tests. */
  readApiKey?: () => string | null;
}

export function makeExecute(deps: ExecuteDeps = {}) {
  const callHermes =
    deps.callHermes ??
    (async (
      sessionKey: string,
      input: string,
      opts: { gatewayUrl: string; apiKey: string | null; timeoutMs: number },
    ) =>
      callHermesResponses({
        sessionKey,
        input,
        gatewayUrl: opts.gatewayUrl,
        apiKey: opts.apiKey,
        timeoutMs: opts.timeoutMs,
      }));
  const readApiKey = deps.readApiKey ?? (() => readHermesMainApiKey());

  return async function execute(
    ctx: AdapterExecutionContext,
  ): Promise<AdapterExecutionResult> {
    const agent = ctx.agent;
    const config = (agent?.adapterConfig ?? {}) as Record<string, unknown>;

    // Settings — we honour only those that make sense over HTTP.
    const gatewayUrl =
      asString(config.hermesGatewayUrl) ??
      process.env.HERMES_GATEWAY_URL ??
      DEFAULT_HERMES_GATEWAY_URL;
    const timeoutSec = asNumber(config.timeoutSec) ?? DEFAULT_TIMEOUT_SEC;
    const timeoutMs = Math.max(1_000, Math.floor(timeoutSec * 1000));

    const sessionKey = resolveSessionKey(agent?.id ?? "", config);
    const prompt = buildPrompt(ctx, config, agent);

    // Surface the invocation envelope to Paperclip's run-history (UI calls
    // this "command" + "commandArgs"). Helps an operator inspect a stuck
    // run without docker-shelling into hermes.
    try {
      await ctx.onMeta?.({
        adapterType: ADAPTER_TYPE,
        command: "hermes:/v1/responses",
        commandArgs: ["POST", gatewayUrl, `session=${sessionKey}`],
        prompt,
      });
    } catch {
      /* onMeta is optional, swallow */
    }

    await ctx.onLog(
      "stdout",
      `[hermes] Calling Hermes (gateway=${gatewayUrl}, session=${sessionKey}, timeout=${timeoutSec}s)\n`,
    );

    const apiKey = readApiKey();
    const result = await callHermes(sessionKey, prompt, {
      gatewayUrl,
      apiKey,
      timeoutMs,
    });

    if (!result.ok) {
      // Map our error codes onto Paperclip's exitCode / errorMessage shape.
      const errorMap: Record<string, string> = {
        HERMES_TIMEOUT: "hermes_timeout",
        HERMES_UNREACHABLE: "hermes_unreachable",
        HERMES_AUTH: "hermes_auth_failed",
        HERMES_HTTP: "hermes_http_error",
      };
      const errorCode = errorMap[result.code] ?? "hermes_unknown_error";
      const exitCode = result.code === "HERMES_TIMEOUT" ? 124 : 1;

      await ctx.onLog(
        "stderr",
        `[hermes] ${result.code}: ${result.detail}\n`,
      );

      return {
        exitCode,
        signal: null,
        timedOut: result.code === "HERMES_TIMEOUT",
        errorMessage: `Hermes call failed (${result.code}): ${result.detail.slice(
          0,
          512,
        )}`,
        errorCode,
        errorMeta: {
          httpStatus: result.status,
          gatewayUrl,
          sessionKey,
        },
        provider: null,
        model: null,
        // Persist the session key so the next heartbeat reuses it even on
        // a failed turn — Hermes' message history is durable across our
        // transport hiccups.
        sessionParams: { sessionKey },
        sessionDisplayId: sessionKey.slice(0, 24),
      };
    }

    // Success path.
    const text = result.text || "";
    const usage = result.usage;

    await ctx.onLog(
      "stdout",
      text || "[hermes] (empty response — agent produced no assistant text)\n",
    );
    if (text) {
      await ctx.onLog("stdout", "\n");
    }
    await ctx.onLog(
      "stdout",
      `[hermes] Done. ${
        usage
          ? `usage: ${usage.inputTokens}in / ${usage.outputTokens}out${
              usage.cachedInputTokens
                ? ` / ${usage.cachedInputTokens}cached`
                : ""
            }`
          : "usage: not surfaced"
      }\n`,
    );

    const executionResult: AdapterExecutionResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: null,
      model: null,
      summary: text ? text.slice(0, 2000) : null,
      sessionParams: { sessionKey },
      sessionDisplayId: sessionKey.slice(0, 24),
      resultJson: {
        result: text,
        session_key: sessionKey,
        usage: usage ?? null,
        // Hermes' Responses envelope keeps the model + provider it picked
        // in `raw.model` / `raw.provider` (when surfaced). Pass through
        // for any downstream Paperclip plotting.
        hermes_model: typeof result.raw.model === "string" ? result.raw.model : null,
      },
    };

    if (usage) {
      executionResult.usage = usage;
    }

    return executionResult;
  };
}

/** Public surface — matches upstream signature. */
export const execute = makeExecute();
