# MCP reverse-proxy trust and rate-limit identity

The MCP HTTP server must sit behind the supported reverse-proxy topology:

`mcp.<DOMAIN> -> Caddy (optional cloudflared) -> mcp-server:8787`

Set `TRUST_PROXY_HOPS` to the number of proxy hops that Express may trust. For the supported Caddy deployment use `TRUST_PROXY_HOPS=1`. Use `0` only for direct/local development. Values are bounded to 0–5; production startup fails closed when the variable is missing, malformed, or permissive (`true`, `*`, `all`, or wildcard CIDRs).

The proxy must overwrite the incoming `X-Forwarded-For` header rather than append to it. Do not expose port 8787 directly to the Internet. With one trusted hop, Express uses only the address immediately before Caddy as the client identity; extra caller-supplied addresses remain untrusted. This keeps IP-keyed rate limits resistant to spoofing.

After changing the topology, update `TRUST_PROXY_HOPS` and restart the MCP container. Regression coverage lives in `packages/mcp-server/src/trustProxy.test.ts`.
