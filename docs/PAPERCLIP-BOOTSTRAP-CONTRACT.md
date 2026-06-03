# Frozen Contract — Agent-driven Paperclip Company Bootstrap (epic #242)

Phase-0, orchestrator-owned. Lanes build against THIS shape and never improvise
across the boundary. If a clause is wrong, the lane STOPs and reports.

Reference implementation for every Paperclip call: `packages/hermes/init/bootstrap-paperclip.sh`.

---

## C1 — ctrl-api Paperclip admin routes (provider; Lane CTRL, `packages/ctrl/**`)

New route file `packages/ctrl/src/api/routes/paperclip_admin.ts`, mounted under
`/api/v1/paperclip/admin`. Operator-authed via the existing `authenticate()` gate
(same as other admin routes). ctrl-api performs the privileged Paperclip calls
**server-side** using the **seed-credential Better-Auth cookie session** — the
proven path in `bootstrap-paperclip.sh` (steps 6–10).

### Auth (server-side, internal to ctrl-api)
- Read seed creds from `/alfred-data/paperclip-seed-credentials.json`
  (`{email,password,...}`, written by `bootstrap-paperclip.sh`).
- Establish a cookie session: `POST {PAPERCLIP_INTERNAL_URL}/api/auth/sign-in/email`
  with body `{email,password}` and headers `Host: <public-host>`, `Origin: <public-url>`
  (mandatory — Better-Auth drops Set-Cookie otherwise). Reuse the cookie jar for all calls.
- `PAPERCLIP_INTERNAL_URL` default `http://paperclip:3100`; public host/origin derived
  from `PAPERCLIP_BASE_URL` / `DOMAIN` (see bootstrap-paperclip.sh:139,146).
- If seed creds are absent → return `503 {error:"paperclip_not_seeded"}` (do not crash).

### Endpoints (request → response)

1. `POST /api/v1/paperclip/admin/companies`
   - body `{ "name": string, "description": string }`
   - → `200 { "companyId": string, "created": boolean }`
   - Idempotent: if a company with `name` exists, return its id with `created:false`
     (GET `/api/companies/` + match by name, per bootstrap-paperclip.sh:529–552).

2. `POST /api/v1/paperclip/admin/companies/:companyId/agents`
   - body `{ "name": string, "role": string, "title"?: string, "capabilities"?: string }`
   - ctrl-api FORCES `adapterType: "hermes_local"` and, on success, mints the runtime
     key (`POST /api/agents/<id>/keys {name:"<name>-runtime"}`).
   - → `200 { "agentId": string, "agentToken": string|null, "created": boolean }`
   - Idempotent by (companyId, name).

3. `POST /api/v1/paperclip/admin/users`
   - body `{ "email": string, "name": string, "password"?: string }` (generate a strong
     password if omitted; never log/persist it beyond the response).
   - Registers a Paperclip user (`POST /api/auth/sign-up/email`) and marks the identity
     **verified** (no mailer on tenants). Idempotent: existing email → `created:false`.
   - → `200 { "userId": string|null, "email": string, "password": string|null, "loginUrl": string, "created": boolean }`

4. `GET /api/v1/paperclip/admin/companies` → `200 { "companies": [{id,name}] }` (read-back)
5. `GET /api/v1/paperclip/admin/companies/:companyId/agents` → `200 { "agents": [{id,name,role}] }`

All write routes: on Paperclip 4xx that isn't an idempotent-exists case, return
`502 { error, detail }`. Never expose the seed password in any response except #3's own.

---

## C2 — mcp-server paperclip tools (consumer; Lane MCP, `packages/mcp-server/**`)

New `packages/mcp-server/src/tools/paperclip.ts` exporting `ALL_PAPERCLIP_TOOLS: ToolDef[]`,
registered in `registry.ts` under AppId **`"paperclip-admin"`** (add to `SUPPORTED_APPS` +
`REGISTRY`). Each tool `buildRequest` proxies to the C1 routes (standard `proxyToCtrl`,
Bearer AAS_API_KEY).

> **NAME COLLISION (frozen decision):** the config key `paperclip` is already taken by the
> UPSTREAM `@paperclipai/mcp-server` (board-key, ~40 operational tools the
> `alfred-paperclip-operations` skill uses). The new admin bundle is a DIFFERENT binary,
> so its AppId / config-server key / stdio arg are all **`paperclip-admin`**. The TOOL
> NAMES below stay `paperclip_*` (the skill references those, not the server key).

Tools (names frozen — the SKILL depends on them):
- `paperclip_create_company {name, description}` → C1 #1
- `paperclip_create_agent {companyId, name, role, title?, capabilities?}` → C1 #2
- `paperclip_register_user {email, name, password?}` → C1 #3
- `paperclip_list_companies {}` → C1 #4
- `paperclip_list_agents {companyId}` → C1 #5

Tests in `paperclip.test.ts` (schema + buildRequest path/method/body), per the existing
`alfred.test.ts` pattern. VERIFY: `cd packages/mcp-server && npm test && npm run typecheck`.

---

## C3 — Org spec (the doc→org structure the SKILL produces & confirms)

```json
{
  "company":  { "name": "string", "description": "string" },
  "principal": { "email": "string", "name": "string" },
  "agents": [
    { "name": "string", "role": "string", "title": "string", "capabilities": "string" }
  ]
}
```
The first agent is conventionally the CEO (`role:"ceo"`). All agents are created
`hermes_local` (forced by C1 #2). The skill derives this from the attached document.

---

## C4 — bootstrap skill (consumer; Lane SKILL, `packages/hermes/workspace-template/skills/`)

New dir `alfred-paperclip-bootstrap/SKILL.md` (platform skill — `alfred-` prefix is
init-managed). Frontmatter `name: alfred-paperclip-bootstrap`, a one-line `description`,
`version: "1.0"`. Body follows the 4-section format (see `alfred-skill-authoring`).

**Confirm-first flow (REQUIRED):**
1. Read the attached document.
2. Derive a C3 org spec.
3. **Present the spec to the principal and STOP — no tool calls yet.**
4. Only after explicit "yes": call `paperclip_create_company` → for each agent
   `paperclip_create_agent` → `paperclip_register_user` → read back with
   `paperclip_list_agents` → report company, agents, and the login.
5. On "no"/edits: revise the spec and re-confirm; create nothing until approved.

VERIFY (Lane SKILL): `docker compose config` (the skill is a static file; ensure the
init render still parses). No code build.

---

## C5 — profile registration & toolset exposure (Lane CONFIG, `packages/hermes/init/render_mcp_servers.py`)

- Add a `_PAPERCLIP_ADMIN_BLOCK` (stdio: `node {mcp_stdio_dir}/dist/bin/stdio-app.js
  paperclip-admin`, env `CTRL_API_URL`,`AAS_API_KEY`, timeout 120) and register server key
  **`paperclip-admin`** (NOT `paperclip` — that key is the upstream ops server) on the
  `main` AND `workers` profiles (where `hermes_local` agents run). `heavy` is
  background-reasoning with no MCP servers today → leave out.
- Idempotent, operator-safe (add-only), per the existing mutator pattern. Because the key
  is new (`paperclip-admin`), the add-only mutator lands cleanly with no collision.
- VERIFY: `cd packages/ctrl && npm run build` is N/A; for init python use
  `python3 -c "import ast; ast.parse(open('packages/hermes/init/render_mcp_servers.py').read())"`
  plus any existing pytest under `packages/hermes`.

---

## C6 — skills→paperclip visibility (Lane ADAPTER, `packages/paperclip/**`) — polish, lands last

Replace the `mode:"unsupported"` stub in
`packages/paperclip/adapter/src/server/skills.ts` so it reports the Hermes-loaded skill
set once the gateway exposes it. Independent of C1–C5; do not block MVP on it.

---

## Merge order
C1 (provider) before C2/C4 (consumers). C5 after C2 (needs the registry entry to exist).
C3 is a doc clause (no code). C6 anytime. The commit gate enforces lane globs.
