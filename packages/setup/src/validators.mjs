// validators.mjs — live API-key validation.
//
// Each validator returns an object:
//   { ok: true,  detail }          — key verified
//   { ok: false, error }           — key rejected by the provider (hard fail)
//   { ok: 'warn', warning, ... }   — could not verify; accept as entered
//
// Network errors never throw out of these — they degrade to { ok: 'warn' }.
// The wizard hard-blocks on { ok:false } and accepts (with a printed warning)
// on { ok:'warn' }.

const TIMEOUT_MS = 15000;

async function timedFetch(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── OpenRouter ───────────────────────────────────────────────────────
// GET /api/v1/models with Bearer auth. 200 = valid. Returns the model list
// so the wizard can offer it in the model-selection autocomplete.
export async function validateOpenRouter(key) {
  try {
    const res = await timedFetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 200) {
      let models = [];
      try {
        const body = await res.json();
        models = Array.isArray(body?.data)
          ? body.data.map((m) => m.id).filter(Boolean)
          : [];
      } catch {
        // 200 but unparseable body — still valid, just no model list.
      }
      return {
        ok: true,
        detail: `verified — ${models.length} models available`,
        models,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `OpenRouter rejected the key (HTTP ${res.status}).` };
    }
    return {
      ok: 'warn',
      warning: `OpenRouter returned HTTP ${res.status} — could not confirm the key.`,
      models: [],
    };
  } catch (e) {
    return {
      ok: 'warn',
      warning: `couldn't verify (network: ${e.message}) — accepting as entered`,
      models: [],
    };
  }
}

// ── Anthropic ────────────────────────────────────────────────────────
// GET /v1/models with x-api-key + anthropic-version. 200 = valid.
export async function validateAnthropic(key) {
  try {
    const res = await timedFetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
    });
    if (res.status === 200) return { ok: true, detail: 'verified' };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `Anthropic rejected the key (HTTP ${res.status}).` };
    }
    return {
      ok: 'warn',
      warning: `Anthropic returned HTTP ${res.status} — could not confirm the key.`,
    };
  } catch (e) {
    return {
      ok: 'warn',
      warning: `couldn't verify (network: ${e.message}) — accepting as entered`,
    };
  }
}

// ── Composio ─────────────────────────────────────────────────────────
// No officially-documented public "verify key" endpoint. Best-effort: hit an
// authenticated endpoint and treat 401/403 as a clearly-wrong key, anything
// else as "looks OK". Never hard-blocks beyond a clear 401/403.
export async function validateComposio(key) {
  // /api/v1/client/auth/client_info is an authenticated info endpoint on the
  // Composio backend; a valid key yields 200, a wrong key yields 401/403.
  try {
    const res = await timedFetch(
      'https://backend.composio.dev/api/v1/client/auth/client_info',
      { headers: { 'x-api-key': key } }
    );
    if (res.status === 200) return { ok: true, detail: 'verified' };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `Composio rejected the key (HTTP ${res.status}).` };
    }
    // 404 / 5xx / anything else — endpoint may have moved; do not hard-block.
    return {
      ok: 'warn',
      warning: `Composio returned HTTP ${res.status} — could not confirm; accepting as entered`,
    };
  } catch (e) {
    return {
      ok: 'warn',
      warning: `couldn't verify (network: ${e.message}) — accepting as entered`,
    };
  }
}
