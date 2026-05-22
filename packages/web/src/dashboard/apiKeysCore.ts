// apiKeysCore — pure helper for the API-keys quick-start (F76).
// Import-free (no React/Wasp) so it unit-tests under node:test.

/**
 * The programmatic base URL for the quick-start curl. This is the Wasp server
 * host (the `api.` subdomain, `config.apiUrl`) — NOT the apex SPA host (which
 * only serves the React bundle) and NOT the dead `/user-api` base. Trailing
 * slash stripped. Falls back to https://api.alfred.black when unset.
 */
export function apiBaseUrl(apiUrl: string | undefined | null): string {
  const base = (apiUrl ?? "").replace(/\/+$/, "");
  return base || "https://api.alfred.black";
}
