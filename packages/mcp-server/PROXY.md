# MCP reverse-proxy topology

The MCP container must sit behind a fixed, known reverse-proxy chain. The supported production topology is one Caddy hop (or Caddy plus one Cloudflare Tunnel hop) immediately in front of the container. Set `NODE_ENV=production` and set `TRUST_PROXY_HOPS` to the exact number of proxy hops: `1` for Caddy, or `2` when cloudflared is a distinct hop.

`TRUST_PROXY_HOPS` is bounded to 0–4 and must be an integer. The server refuses to start in production when it is missing or malformed. Do not set Express `trust proxy` to `true`, a permissive function, or a value larger than the actual chain: forwarded headers are attacker-controlled at the public edge, and trusting them would let clients rotate the IP used by rate limiting.

If the deployment topology changes, update the hop count and verify that the outermost proxy overwrites `X-Forwarded-For` rather than appending untrusted client input. Direct public access to port 8787 is unsupported.
