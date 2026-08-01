# MCP reverse-proxy trust

The MCP server is reachable through one Caddy reverse-proxy hop. Configure `TRUST_PROXY_HOPS=1`; `0` is direct/local mode. The server accepts only a bounded integer hop count (0-5). It rejects `true`, `*`, `all`, and wildcard CIDRs in production because Express would then trust arbitrary `X-Forwarded-For` values and an attacker could spoof the IP-keyed rate-limit identity.

Caddy must overwrite forwarded headers and port 8787 must not be Internet-facing. With one trusted hop, only the address immediately to the left of Caddy is trusted; additional client-supplied entries are not. Regression coverage is in `src/trustProxy.test.ts`.
