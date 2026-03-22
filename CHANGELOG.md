# Changelog

All notable changes to the alfred-platform monorepo.

## [0.2.0] — 2026-03-22

### ✨ Features

- **Curator ↔ alfred-learn filing loop** (PR #3): Judgment workflow now routes
  via `POST /api/v1/curator/route-and-process`, injecting routing metadata as
  YAML frontmatter. Falls back to raw `fs.renameSync` when Curator is unavailable.
  Observations are enriched with Curator results (entities created/linked).

- **Inbox as a stream** (PR #4): New `system-inbox` stream type unifies all
  input paths. `POST /api/v1/streams/inbox/scan` scans the filesystem inbox and
  creates stream events. All inputs now converge through
  streams → EventProcessor → Judgment → Curator.

- **ctrl API in Docker compose** (PR #6): The `ctrl-api` service now runs as a
  `node:22-slim` container inside the same Docker network as alfred-learn and
  alfred-worker. Fixes the long-standing bug where alfred-learn could never
  reach the ctrl API (systemd bound to `127.0.0.1`, unreachable from Docker
  bridge). `deploy-api` auto-migrates existing tenants.

- **Clerk via OpenClaw sessions_spawn**: Classification now spawns a full
  OpenClaw subagent with tool access (read, pdf, exec). The Clerk can actually
  inspect inbox files — PDFs, documents, etc. — instead of classifying from
  filename/metadata alone. Uses `sessions_spawn(sandbox=inherit)` +
  `sessions_history` polling pattern.

- **ctrl-api vault/records accepts raw content**: `POST /api/v1/vault/records`
  now accepts a `content` field and writes the markdown file directly to the
  vault filesystem, instead of calling the `alfred vault create` CLI (which
  doesn't support raw content).

### 🐛 Bug Fixes

- **Provisioner fixes** (PR #5): Bootstrap script retries containers stuck in
  `Created` state (uses `jq`), `exit 1` on failure, numeric UID chown for SSH
  keys.

- **VaultClient auth**: Added `AAS_API_KEY` as `Authorization: Bearer` header
  to all ctrl-api requests. Previously all calls returned 401.

- **Gateway token sync**: Provisioner and `deploy-api` now write the correct
  gateway auth token to `.gateway-token` (was writing OpenClaw's internal
  auto-generated token instead of the configured one).

- **Robust JSON extraction**: LLM responses wrapped in markdown fences or with
  extra prose text are now handled gracefully (try direct parse → strip code
  fences → find first/last braces).

- **OpenClaw crash prevention**: `subagents.allowAgents` must go on
  `agents.list[].subagents`, NOT `gateway.tools` or `agents.defaults.subagents`.
  Both wrong locations crash OpenClaw with "Unrecognized key".

- **Activity timeout**: `classify_event` Temporal activity timeout bumped from
  60s to 300s to accommodate large LLM inference (e.g., Qwen 35B on local GPU).

- **OpenClaw config for cross-agent access**: Added `tools.sessions.visibility=all`
  and `tools.agentToAgent.enabled=true` to config template so sessions_spawn
  polling works across agent boundaries.

### 🏗️ Architecture

- **Model-agnostic Clerk**: The Clerk no longer hardcodes any model. It spawns
  via OpenClaw `sessions_spawn`, which uses whatever model the `learn-clerk`
  agent is configured with in `openclaw.json`. Tenants can use any provider:
  OpenRouter (default free tier), DGX Spark Ollama, Anthropic, etc.

- **Removed CLERK_BASE_URL/CLERK_MODEL**: Direct LLM calling bypassed OpenClaw
  entirely. Now all inference goes through OpenClaw, giving the Clerk full tool
  access and model-agnostic routing.

### 📦 Packages Changed

- `packages/learn` — Clerk rewrite, config cleanup, timeout fixes
- `packages/ctrl` — ctrl-api Docker service, vault write endpoint, provisioner fixes,
  OpenClaw config template updates

### ⚙️ Configuration

**New tenants** get the updated config automatically via the provisioner template.

**Existing tenants** need these additions to `openclaw.json`:

```json
{
  "tools": {
    "sessions": { "visibility": "all" },
    "agentToAgent": { "enabled": true, "allow": ["*"] }
  },
  "gateway": {
    "tools": {
      "allow": ["sessions_send", "sessions_spawn", "sessions_history", "sessions_list"]
    }
  }
}
```

**Default model** (template): `openrouter/meta-llama/llama-3.3-70b-instruct:free`
Tenants can override per-agent models in their `openclaw.json`.

---

## [0.1.0] — 2026-03-21

Initial release with:
- Temporal-based learning workflows (EventProcessor, SessionTracker, Learning,
  Reflection, Judgment, DailyDigest)
- OpenClaw integration for LLM inference
- Vault CRUD via ctrl API
- SaaS frontend with Stripe billing
- Multi-tenant provisioning on Hetzner Cloud
- LUKS-encrypted data volumes per tenant
