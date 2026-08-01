# MCP reverse-proxy trust and rate-limit identity

The MCP HTTP server is exposed through the single Caddy ingress hop: `mcp.<DOMAIN> -> reverse_proxy mcp-server:8787`. Express must not use `trust proxy=true`: that accepts arbitrary `X-Forwarded-For` values and lets an untrusted caller evade IP-keyed OAuth rate limits.

Set `TRUST_PROXY_HOPS=1` for the supported Caddy deployment. The value is a bounded integer from 0 to 5 and is applied to Express's proxy trust. `0` is the safe direct-connection/local-development mode. Do not set `true`, `*`, `all`, or a wildcard CIDR. Production startup rejects those permissive values with an actionable error before the listener is created.

The edge proxy must overwrite, not append to, the incoming forwarded headers when it is the trusted hop. Do not expose port 8787 directly to the Internet. With one trusted hop, the client IP is the first address to the left of the Caddy hop; extra forwarded entries are not trusted.
