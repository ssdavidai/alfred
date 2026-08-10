// Sure balance-anchor provenance classifier (#318 slice 1).
// Mapping (frozen in PR #337): has_provider_anchor true→fresh/provider,
// false→stale/cached_fallback, null|absent|upstream-down→unknown.
// "unknown" must never render as "fresh" — that distinction is the feature.
// observed_at comes from provider_observed_at only; never substitute
// generated_at or now() (those describe when we asked, not when observed).

export interface AnchorEntry {
  account_id: string;
  has_provider_anchor: boolean | null;
  provider_status: string | null;
  provider_observed_at: string | null;
}

interface AnchorStateResponse { accounts: AnchorEntry[] }

export interface BalanceProvenance {
  source: "provider" | "cached_fallback" | null;
  observed_at: string | null;
  freshness: "fresh" | "stale" | "unknown";
  fallback_reason: string | null;
}

export function classifyProvenance(entry: AnchorEntry | undefined): BalanceProvenance {
  if (entry === undefined || entry.has_provider_anchor === null) {
    return { source: null, observed_at: null, freshness: "unknown", fallback_reason: null };
  }
  if (entry.has_provider_anchor) {
    return { source: "provider", observed_at: entry.provider_observed_at ?? null,
             freshness: "fresh", fallback_reason: null };
  }
  const reason = entry.provider_status
    ? `provider reports ${entry.provider_status}`
    : "provider anchor unavailable";
  return { source: "cached_fallback", observed_at: entry.provider_observed_at ?? null,
           freshness: "stale", fallback_reason: reason };
}

export function buildAnchorMap(accounts: AnchorEntry[]): Map<string, AnchorEntry> {
  const map = new Map<string, AnchorEntry>();
  for (const e of accounts) map.set(e.account_id, e);
  return map;
}

// --- Aggregate data_quality (#318 slice 2) ---------------------------------
// partial:true when any account is stale or unknown — the signal that a
// net-worth figure must not be presented as settled fact.
// Accounts absent from anchorMap (empty map = upstream anchor call failed)
// classify as "unknown" so the aggregate still returns 200 gracefully.

export interface DataQuality {
  fresh_accounts: number;
  stale_accounts: number;
  unknown_accounts: number;
  partial: boolean;
}

export function buildDataQuality(
  anchorMap: Map<string, AnchorEntry>,
  accounts: Array<{ id?: unknown }>,
): DataQuality {
  let fresh = 0, stale = 0, unknown = 0;
  for (const acc of accounts) {
    const p = classifyProvenance(anchorMap.get(acc.id as string));
    if (p.freshness === "fresh") fresh++;
    else if (p.freshness === "stale") stale++;
    else unknown++;
  }
  return { fresh_accounts: fresh, stale_accounts: stale, unknown_accounts: unknown,
           partial: stale > 0 || unknown > 0 };
}

// --- Sync-health remediation hint (#318 slice 2) ---------------------------
// Specific to provider_status (not boilerplate) so the principal knows
// exactly what to do: re-authorise vs trigger a sync vs no action needed.

export function remediationHint(
  freshness: "fresh" | "stale" | "unknown",
  providerStatus: string | null,
): string | null {
  if (freshness === "fresh") return null;
  if (freshness === "stale") {
    return providerStatus === "DISCONNECTED"
      ? "Re-authorise the provider connection in Sure to restore live balance updates."
      : "Trigger a manual sync in Sure — the provider connection is active but the last balance pull failed.";
  }
  return "Account not linked to a provider or anchor state unavailable. If manually entered, no action is needed.";
}

// ---------------------------------------------------------------------------
// Fetch anchor-state from Sure and return a map keyed by account_id.
// Returns empty Map on any error, timeout, or malformed response so the
// caller still returns 200 with every account marked freshness:"unknown".
export async function fetchAnchorMap(
  base: string,
  token: string,
  timeoutMs = 2000,
): Promise<Map<string, AnchorEntry>> {
  const url = `${base}/api/v1/alfred/balance_anchor_state`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url,
      { headers: { "X-Api-Key": token, Accept: "application/json" }, signal: controller.signal });
    if (!resp.ok) return new Map();
    const data = (await resp.json()) as AnchorStateResponse;
    if (!Array.isArray(data?.accounts)) return new Map();
    return buildAnchorMap(data.accounts);
  } catch { return new Map(); } finally { clearTimeout(timer); }
}
