/**
 * Dynamic model catalog — fetches available models from each provider
 * whose API key is configured. Results are cached for 1 hour.
 */

import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";
import { COMPOSE_DIR } from "../helpers.js";

const ENV_PATH = `${COMPOSE_DIR}/.env`;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  maxOutput?: number;
  pricing?: { input: number; output: number };
  source: "direct" | "openrouter";
  supportsImages?: boolean;
  supportsReasoning?: boolean;
}

interface ProviderGroup {
  provider: string;
  source: "direct" | "openrouter";
  models: ModelEntry[];
}

interface CachedResult {
  groups: ProviderGroup[];
  fetchedAt: number;
}

let cache: CachedResult | null = null;

/**
 * Drop the in-memory model catalog cache. Call this whenever the set of
 * configured provider API keys changes (e.g. after PATCH /admin/credentials)
 * so the next GET /admin/models reflects newly-available providers
 * immediately instead of waiting up to {@link CACHE_TTL_MS}.
 */
export function invalidateModelCatalogCache(): void {
  cache = null;
}

function readEnvKeys(): Set<string> {
  let content = "";
  try {
    content = fs.readFileSync(ENV_PATH, "utf-8");
  } catch {
    return new Set();
  }
  const keys = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (value) keys.add(key);
  }
  return keys;
}

function getEnvValue(key: string): string | null {
  let content = "";
  try {
    content = fs.readFileSync(ENV_PATH, "utf-8");
  } catch {
    return null;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    if (trimmed.slice(0, eqIdx).trim() === key) {
      return trimmed.slice(eqIdx + 1).trim();
    }
  }
  return null;
}

// --- Provider fetchers ---

async function fetchOpenRouterModels(apiKey: string): Promise<ModelEntry[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    data: Array<{
      id: string;
      name: string;
      context_length?: number;
      top_provider?: { max_completion_tokens?: number };
      pricing?: { prompt: string; completion: string };
      architecture?: { modality?: string; tokenizer?: string; instruct_type?: string };
    }>;
  };

  return (data.data || [])
    .filter((m) => {
      // Filter out non-chat models, embedding models, free models with no real use
      if (m.id.includes(":free") || m.id.includes("embed") || m.id.includes("moderation")) return false;
      return true;
    })
    .map((m) => {
      const inputPrice = parseFloat(m.pricing?.prompt || "0") * 1_000_000;
      const outputPrice = parseFloat(m.pricing?.completion || "0") * 1_000_000;
      return {
        id: `openrouter/${m.id}`,
        name: m.name || m.id,
        provider: m.id.split("/")[0] || "openrouter",
        contextWindow: m.context_length,
        maxOutput: m.top_provider?.max_completion_tokens,
        pricing: { input: inputPrice, output: outputPrice },
        source: "openrouter" as const,
        supportsImages: m.architecture?.modality?.includes("image") ?? false,
      };
    });
}

async function fetchAnthropicModels(apiKey: string): Promise<ModelEntry[]> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data: Array<{
        id: string;
        display_name?: string;
        type: string;
      }>;
    };
    return (data.data || [])
      .filter((m) => m.type === "model")
      .map((m) => ({
        id: `anthropic/${m.id}`,
        name: m.display_name || m.id,
        provider: "anthropic",
        source: "direct" as const,
      }));
  } catch {
    return [];
  }
}

async function fetchOpenAIModels(apiKey: string): Promise<ModelEntry[]> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data: Array<{ id: string; owned_by?: string }>;
    };
    return (data.data || [])
      .filter((m) => {
        // Only include chat models, not embeddings/tts/whisper/dall-e
        const id = m.id;
        if (id.includes("embed") || id.includes("tts") || id.includes("whisper")) return false;
        if (id.includes("dall-e") || id.includes("moderation")) return false;
        if (id.startsWith("ft:")) return false; // fine-tunes
        return true;
      })
      .map((m) => ({
        id: `openai/${m.id}`,
        name: m.id,
        provider: "openai",
        source: "direct" as const,
      }));
  } catch {
    return [];
  }
}

async function fetchGoogleModels(apiKey: string): Promise<ModelEntry[]> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      models: Array<{
        name: string;
        displayName?: string;
        supportedGenerationMethods?: string[];
        inputTokenLimit?: number;
        outputTokenLimit?: number;
      }>;
    };
    return (data.models || [])
      .filter((m) =>
        m.supportedGenerationMethods?.includes("generateContent"),
      )
      .map((m) => {
        const shortId = m.name.replace("models/", "");
        return {
          id: `google/${shortId}`,
          name: m.displayName || shortId,
          provider: "google",
          contextWindow: m.inputTokenLimit,
          maxOutput: m.outputTokenLimit,
          source: "direct" as const,
        };
      });
  } catch {
    return [];
  }
}

async function fetchXAIModels(apiKey: string): Promise<ModelEntry[]> {
  try {
    const res = await fetch("https://api.x.ai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data: Array<{ id: string; owned_by?: string }>;
    };
    return (data.data || []).map((m) => ({
      id: `x-ai/${m.id}`,
      name: m.id,
      provider: "xai",
      source: "direct" as const,
    }));
  } catch {
    return [];
  }
}

/**
 * Kimi Code (Moonshot) catalog. Kimi's coding endpoint
 * (https://api.kimi.com/coding/) does NOT expose a /v1/models listing,
 * so we mirror the upstream openclaw `extensions/kimi-coding/provider-catalog.ts`
 * static catalog. Pricing is $0 because access is subscription-based.
 *
 * The `apiKey` param is unused at the moment — we only emit the catalog
 * when a key is present. Kept in the signature for symmetry with the
 * other fetchers and to leave room for a future health probe.
 */
async function fetchKimiModels(_apiKey: string): Promise<ModelEntry[]> {
  return [
    {
      id: "kimi/kimi-code",
      name: "Kimi Code",
      provider: "kimi",
      contextWindow: 262144,
      maxOutput: 32768,
      pricing: { input: 0, output: 0 },
      source: "direct" as const,
      supportsImages: true,
      supportsReasoning: true,
    },
    {
      id: "kimi/k2p5",
      name: "Kimi Code (legacy model id)",
      provider: "kimi",
      contextWindow: 262144,
      maxOutput: 32768,
      pricing: { input: 0, output: 0 },
      source: "direct" as const,
      supportsImages: true,
      supportsReasoning: true,
    },
  ];
}

// --- Grouping and deduplication ---

function groupModels(allModels: ModelEntry[]): ProviderGroup[] {
  // Group by provider name
  const groups = new Map<string, { source: "direct" | "openrouter"; models: ModelEntry[] }>();

  // First pass: add direct models (higher priority)
  for (const m of allModels) {
    if (m.source !== "direct") continue;
    if (!groups.has(m.provider)) {
      groups.set(m.provider, { source: "direct", models: [] });
    }
    groups.get(m.provider)!.models.push(m);
  }

  // Second pass: add OpenRouter models, skip if direct version exists
  const directIds = new Set(
    allModels.filter((m) => m.source === "direct").map((m) => {
      // Normalize: "anthropic/claude-sonnet-4-5-20250929" matches "openrouter/anthropic/claude-sonnet-4-5-20250929"
      return m.id.replace(/^(openai|anthropic|google|x-ai|kimi)\//, "");
    }),
  );

  for (const m of allModels) {
    if (m.source !== "openrouter") continue;
    // Check if this model's base ID exists as a direct model
    const baseId = m.id.replace(/^openrouter\//, "").replace(/^(openai|anthropic|google|x-ai)\//, "");

    const providerName = m.provider;
    if (!groups.has(providerName)) {
      groups.set(providerName, { source: "openrouter", models: [] });
    }

    // If we have a direct version, mark the OpenRouter one but still include it
    // (user might want to route through OpenRouter for fallbacks)
    const isDuplicate = directIds.has(baseId);
    if (!isDuplicate) {
      groups.get(providerName)!.models.push(m);
    } else {
      // Add with a note that direct is also available
      groups.get(providerName)!.models.push({ ...m, name: `${m.name} (via OpenRouter)` });
    }
  }

  // Sort models within each group by name
  const result: ProviderGroup[] = [];
  for (const [provider, group] of groups) {
    group.models.sort((a, b) => a.name.localeCompare(b.name));
    result.push({ provider, source: group.source, models: group.models });
  }

  // Sort groups: direct providers first, then alphabetical
  result.sort((a, b) => {
    if (a.source !== b.source) return a.source === "direct" ? -1 : 1;
    return a.provider.localeCompare(b.provider);
  });

  return result;
}

async function fetchAllModels(): Promise<ProviderGroup[]> {
  const keys = readEnvKeys();
  const fetchers: Promise<ModelEntry[]>[] = [];

  if (keys.has("OPENROUTER_API_KEY")) {
    fetchers.push(fetchOpenRouterModels(getEnvValue("OPENROUTER_API_KEY")!));
  }
  if (keys.has("ANTHROPIC_API_KEY")) {
    fetchers.push(fetchAnthropicModels(getEnvValue("ANTHROPIC_API_KEY")!));
  }
  if (keys.has("OPENAI_API_KEY")) {
    fetchers.push(fetchOpenAIModels(getEnvValue("OPENAI_API_KEY")!));
  }
  if (keys.has("GOOGLE_API_KEY")) {
    fetchers.push(fetchGoogleModels(getEnvValue("GOOGLE_API_KEY")!));
  }
  if (keys.has("XAI_API_KEY")) {
    fetchers.push(fetchXAIModels(getEnvValue("XAI_API_KEY")!));
  }
  if (keys.has("KIMI_API_KEY")) {
    fetchers.push(fetchKimiModels(getEnvValue("KIMI_API_KEY")!));
  }

  const results = await Promise.allSettled(fetchers);
  const allModels: ModelEntry[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") allModels.push(...r.value);
  }

  return groupModels(allModels);
}

export function registerModelRoutes(): void {
  // GET /api/v1/admin/models — dynamic model catalog
  addRoute("GET", "/api/v1/admin/models", async ({ res, query }) => {
    const forceRefresh = query?.refresh === "true";

    if (!forceRefresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
      sendJson(res, 200, { groups: cache.groups, cached: true, fetchedAt: cache.fetchedAt });
      return;
    }

    const groups = await fetchAllModels();
    cache = { groups, fetchedAt: Date.now() };

    sendJson(res, 200, {
      groups,
      cached: false,
      fetchedAt: cache.fetchedAt,
      modelCount: groups.reduce((sum, g) => sum + g.models.length, 0),
    });
  });
}
