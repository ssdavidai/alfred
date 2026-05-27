/**
 * `testEnvironment()` — runs when a Paperclip operator clicks "Test" on
 * the agent. Replaces the upstream CLI-availability checks with an HTTP
 * ping against `hermes:18789/health` plus a config-file probe.
 */

import {
  ADAPTER_TYPE,
  DEFAULT_HERMES_GATEWAY_URL,
} from "../shared/constants.js";

import {
  pingHermesHealth,
  readHermesMainApiKey,
} from "./hermes-http.js";

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types/paperclip.js";

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export interface TestEnvironmentDeps {
  ping?: typeof pingHermesHealth;
  readApiKey?: () => string | null;
}

export function makeTestEnvironment(deps: TestEnvironmentDeps = {}) {
  const ping = deps.ping ?? pingHermesHealth;
  const readApiKey = deps.readApiKey ?? (() => readHermesMainApiKey());

  return async function testEnvironment(
    ctx: AdapterEnvironmentTestContext,
  ): Promise<AdapterEnvironmentTestResult> {
    const config = (ctx.config ?? {}) as Record<string, unknown>;
    const gatewayUrl =
      asString(config.hermesGatewayUrl) ??
      process.env.HERMES_GATEWAY_URL ??
      DEFAULT_HERMES_GATEWAY_URL;

    const checks: AdapterEnvironmentCheck[] = [];

    // 1. Health probe.
    const health = await ping({ gatewayUrl, timeoutMs: 5_000 });
    if (health.ok) {
      checks.push({
        level: "info",
        message: `Hermes /health reachable at ${gatewayUrl}`,
        code: "hermes_health_ok",
      });
    } else {
      checks.push({
        level: "error",
        message: `Hermes /health unreachable at ${gatewayUrl}`,
        detail: health.detail,
        hint:
          "Verify the hermes container is running (`docker compose ps hermes`), the paperclip container has network access to it, and HERMES_GATEWAY_URL is correct.",
        code: "hermes_health_unreachable",
      });
      return {
        adapterType: ADAPTER_TYPE,
        status: "fail",
        checks,
        testedAt: new Date().toISOString(),
      };
    }

    // 2. API key resolvable?
    const apiKey = readApiKey();
    if (apiKey && apiKey.length > 0) {
      checks.push({
        level: "info",
        message: `Hermes API_SERVER_KEY resolved (${apiKey.length} chars)`,
        code: "hermes_api_key_ok",
      });
    } else {
      checks.push({
        level: "warn",
        message:
          "Hermes API_SERVER_KEY could not be read from /hermes-state/profiles/main/.env",
        hint:
          "Bind-mount hermes_data:/hermes-state:ro into the paperclip container and ensure the hermes-init container has rendered the main profile. Without the key, Hermes will reject /v1/responses with 401.",
        code: "hermes_api_key_missing",
      });
    }

    // 3. Pass-through note about model / provider.
    checks.push({
      level: "info",
      message:
        "Model + provider are managed by Hermes (operator-owned config.yaml). Paperclip-side model/provider settings are ignored in HTTP mode.",
      code: "hermes_model_managed_by_hermes",
    });

    const hasErrors = checks.some((c) => c.level === "error");
    const hasWarnings = checks.some((c) => c.level === "warn");

    return {
      adapterType: ADAPTER_TYPE,
      status: hasErrors ? "fail" : hasWarnings ? "warn" : "pass",
      checks,
      testedAt: new Date().toISOString(),
    };
  };
}

export const testEnvironment = makeTestEnvironment();
