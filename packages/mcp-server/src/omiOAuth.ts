// Omi omits RFC8707 resource while authorizing. Only its exact registered
// HTTPS callback gets the restricted Omi resource as a fallback.
export function omiResourceFallback(
  resource: URL | undefined,
  redirectUri: string,
  publicUrl: string,
): URL | undefined {
  if (resource) return resource;
  if (redirectUri !== "https://api.omi.me/v1/apps/mcp/callback")
    return undefined;
  return new URL("/omi/mcp", publicUrl);
}
