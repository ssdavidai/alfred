# mcp-worker — operator setup runbook

One-time setup steps Sir runs (or his operator runs) before the Worker can be deployed and consumed by Claude Desktop. Everything below happens **once** per Cloudflare account + per tenant; after that, code merges to `main` deploy automatically via `.github/workflows/deploy-mcp-worker.yml`.

This v1 worker exposes david's Sure data only. Multi-tenant generalisation lives behind issue #772.

## What this Worker is

`alfred-mcp-worker` is a Cloudflare Worker that hosts an MCP (Model Context Protocol) server over streamable HTTP. It's hosted at `https://mcp.alfred.black/mcp`. Claude Desktop connects to it directly with a bearer token; tool calls are translated into authenticated REST requests against david's ctrl-api (`https://alfred-david-mnbqn4jg.alfred.black/api/v1/sure/*`).

```
┌──────────────────┐       streamable-HTTP MCP        ┌─────────────────────┐
│  Claude Desktop  │ ───────────────────────────────▶│  alfred-mcp-worker  │
│  (Sir's machine) │                                   │   (Cloudflare)      │
└──────────────────┘                                   └──────────┬──────────┘
                                                                  │  HTTPS + Bearer + CF-Access service token
                                                                  ▼
                                                       ┌─────────────────────┐
                                                       │  david.alfred.black │
                                                       │   ctrl-api :3100    │
                                                       └─────────────────────┘
```

## One-time Cloudflare setup (manual)

### 1. DNS

Create a CNAME at `mcp.alfred.black` pointing to `alfred.black` (proxied through Cloudflare = orange cloud on). Workers will pick up the route via the `routes` block in `wrangler.jsonc`.

```sh
# Or via dashboard: alfred.black zone → DNS → Add record →
# Type=CNAME, Name=mcp, Target=alfred.black, Proxy=on.
```

### 2. Cloudflare Access service token (OPTIONAL — only if Access is enabled)

David's tenant subdomain `alfred-david-mnbqn4jg.alfred.black` is currently bearer-only (no Access policy), so this step is **not required** at present. The Worker treats `DAVID_CF_ACCESS_CLIENT_ID` / `DAVID_CF_ACCESS_CLIENT_SECRET` as optional and only attaches the headers when both secrets are set.

If a future tenant subdomain DOES sit behind Cloudflare Access, do this once:

Cloudflare dashboard → Zero Trust → Access → Service Auth → Service Tokens → Create Service Token, name it `mcp-worker (<tenant>)`, capture the Client ID + Client Secret. Then attach it to the Access policy on the gated subdomain (Zero Trust → Access → Applications → (app) → Policies → Add policy → Service Auth → Service Token = `mcp-worker (<tenant>)`). Set both secrets via `wrangler secret put`.

### 3. Generate the MCP bearer token

This is the token Sir copies into Claude Desktop. Generate a high-entropy random string locally:

```sh
openssl rand -hex 32
# example: 5e8a3f2c1b9d7e0a4f6c2b8d1a3e7f5c9b0d4e8a2f6c1b9d7e3a5f0c4b8d1e2a
```

Save it somewhere safe (1Password / Vaultwarden) — you can't retrieve it from Cloudflare after `wrangler secret put`, you can only re-set it.

### 4. Set Worker secrets

From the repo root:

```sh
cd packages/mcp-worker
npm install
npx wrangler login   # only first time

# the bearer token Sir just generated (paste at the prompt)
npx wrangler secret put MCP_DAVID_BEARER

# david's AAS_API_KEY (read it from the david tenant: ssh david 'grep ^AAS_API_KEY= /opt/alfred/compose/.env')
npx wrangler secret put DAVID_AAS_API_KEY

# david's tenant ctrl-api base URL
echo "https://alfred-david-mnbqn4jg.alfred.black" | npx wrangler secret put DAVID_CTRL_URL

# OPTIONAL — only if Access is gating the subdomain:
# npx wrangler secret put DAVID_CF_ACCESS_CLIENT_ID
# npx wrangler secret put DAVID_CF_ACCESS_CLIENT_SECRET
```

### 5. First deploy

```sh
npx wrangler deploy
```

This will:

1. Bundle the Worker
2. Apply the v1 Durable Object migration (creates the `SureMCP` SQLite-backed DO class)
3. Bind the Worker to `mcp.alfred.black/*`
4. Surface the deploy URL

Confirm reachability:

```sh
curl https://mcp.alfred.black/health
# → {"ok":true,"service":"alfred-mcp-worker","tenant":"david","app":"sure"}
```

### 6. CI takes over

Subsequent merges to `main` that touch `packages/mcp-worker/**` deploy automatically via `.github/workflows/deploy-mcp-worker.yml`. The workflow needs two repo secrets:

- `CLOUDFLARE_API_TOKEN` (with edit permissions on the Workers + Workers KV scope for the alfred zone)
- `CLOUDFLARE_ACCOUNT_ID`

Set them in GitHub → repo → Settings → Secrets and variables → Actions.

## Connecting Claude Desktop

Open `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and add:

```json
{
  "mcpServers": {
    "alfred-sure": {
      "url": "https://mcp.alfred.black/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer <MCP_DAVID_BEARER>"
      }
    }
  }
}
```

Restart Claude Desktop. Ask "what tools do I have available?" — the catalogue (~78 Sure tools, names like `list_transactions`, `get_balance_sheet`, `bootstrap_sure_full`, etc.) should appear. Try a quick read:

> Show me my last 5 transactions.

Claude Desktop should call `list_transactions` with `per_page: 5` and surface the actual data from your tenant.

## Rotating secrets

- **MCP bearer**: `openssl rand -hex 32` → `npx wrangler secret put MCP_DAVID_BEARER` → update Claude Desktop config.
- **Cloudflare Access service token**: dashboard renew (annual). Update both `DAVID_CF_ACCESS_CLIENT_*` secrets via wrangler.
- **AAS_API_KEY**: rotate on david's tenant + Cloudflare Worker secret simultaneously, otherwise existing sessions break.

## Removing access (panic switch)

If the bearer leaks:

```sh
cd packages/mcp-worker
npx wrangler secret put MCP_DAVID_BEARER  # paste a fresh random string
```

All in-flight Claude Desktop sessions break immediately. Sir updates his config with the new bearer to restore access.

For full Worker shutdown:

```sh
npx wrangler delete
```

## Files

- `wrangler.jsonc` — Worker config, DO binding, route binding
- `src/index.ts` — Worker entry + auth gate
- `src/auth.ts` — bearer validation
- `src/env.ts` — typed Env interface
- `src/mcp/server.ts` — McpAgent subclass that registers all Sure tools
- `src/tools/sure.ts` — declarative catalogue of every `/api/v1/sure/*` tool
- `src/tools/helpers.ts` — `proxyToCtrl` + tool-result formatter
- `src/tools/types.ts` — `ToolDef` shape + `runTool` runner
