# Spec 056: Scoped Secret Management for Agent Tasks

**Version:** 0.1
**Date:** 27 March 2026
**Status:** Draft
**Author:** David Szabo-Stuban + Alfred

---

## Problem Statement

Every container in the tenant Docker stack shares a single `.env` file via `env_file: .env` in docker-compose. This means all services — openclaw, alfred, alfred-learn, ctrl-api — see every secret: OpenRouter keys, Anthropic keys, Gmail OAuth tokens, and internal tokens like `AAS_API_KEY`.

When TaskRunnerWorkflow (spec 003) executes agent tasks via `sessions_spawn`, the spawned subagent inherits the full OpenClaw environment, which in turn has access to every credential. A curator task that only needs the OpenRouter key can also read the Gmail OAuth token. A research task that needs web search could theoretically access billing credentials.

This violates least-privilege. As agents become more autonomous (instinct-driven execution, consequential errands), the blast radius of a compromised or misbehaving subagent grows. We need scoped secret injection so each task only sees the credentials it requires.

---

## Goals

1. **Least-privilege secrets**: each agent task receives only the credentials it needs
2. **Declarative scoping**: credential requirements are declared per-skill and per-task, not hard-coded
3. **Centralized management**: secrets are still managed via ctrl-api (`PATCH /api/v1/admin/credentials`), not scattered across files
4. **No external dependencies**: no HashiCorp Vault, no cloud KMS — keep it simple and self-contained per tenant
5. **Backwards compatible**: existing credential management and `.env` flow continue working for non-task contexts

---

## Current State

### Credential Storage

`packages/ctrl/src/api/routes/credentials.ts` manages a flat `.env` file at `COMPOSE_DIR/.env`. The `KNOWN_CREDENTIALS` array defines five provider keys (OpenRouter, Anthropic, OpenAI, xAI, Google). Protected keys (`AAS_API_KEY`) cannot be modified via the API. All credentials are simple `KEY=VALUE` pairs in a single file.

### Credential Consumption

`docker-compose.yaml.njk` shares `.env` with every service via `env_file: .env`. All five containers (init, openclaw, alfred, ctrl-api, alfred-learn) receive the complete set of environment variables.

### Task Execution

`packages/learn/src/activities/tasks.py` — `execute_task` spawns subagents via OpenClaw `sessions_spawn`. The subagent runs inside the openclaw container, which has every credential in its environment. There is no mechanism to restrict which env vars a spawned session can access.

The task schema (spec 003) already has `agent_id` and `skill_entry` fields, but no `required_credentials` or scope declaration.

---

## Design

### Approach: Secret Store Endpoint + Per-Task Injection

Rather than splitting `.env` into per-agent files (fragile, hard to manage) or deploying a vault service (overkill for a single-tenant VPS), we add a **secret store endpoint** to ctrl-api that serves scoped credential bundles on demand. Tasks declare which credential scopes they need, and the execution layer fetches only those credentials at runtime.

### Core Concepts

**Credential Scope** — a named group of credentials. Examples: `llm` (all LLM provider keys), `openrouter` (just the OpenRouter key), `email` (Gmail OAuth), `internal` (AAS_API_KEY, gateway tokens). Scopes are defined in ctrl-api, not in the .env file.

**Scope Declaration** — tasks and skills declare which scopes they need via a `required_scopes` field. If a task's skill file declares `required_scopes: [llm]`, the task inherits that scope.

**Secret Store Endpoint** — a new ctrl-api route that returns plaintext credential values for requested scopes, authenticated via `AAS_API_KEY`. Only callable from within the Docker network (localhost-bound).

### Scope Definitions

```typescript
const CREDENTIAL_SCOPES: Record<string, string[]> = {
  // LLM provider keys — needed by any task that calls an LLM
  "llm": [
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "XAI_API_KEY",
    "GOOGLE_API_KEY",
  ],

  // Individual provider scopes for fine-grained control
  "openrouter": ["OPENROUTER_API_KEY"],
  "anthropic":  ["ANTHROPIC_API_KEY"],
  "openai":     ["OPENAI_API_KEY"],

  // Email/calendar — OAuth tokens for communication tasks
  "email": ["GMAIL_OAUTH_TOKEN", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"],

  // Web search — API keys for search providers
  "search": ["SERP_API_KEY", "TAVILY_API_KEY"],

  // Internal — system tokens, never exposed to agent tasks
  "internal": ["AAS_API_KEY", "OPENCLAW_GATEWAY_TOKEN"],
};
```

The `internal` scope is **never grantable** to tasks. It exists only for documentation and is explicitly denied by the endpoint.

### Schema Changes

#### Skill Schema — add `required_scopes`

```yaml
---
type: skill
title: "Execution — Process Invoice"
domain: execution
tier: 2
required_scopes:
  - llm        # needs LLM for analysis
  - email      # needs email to send confirmation
---
```

#### Task Schema — add `required_scopes`

```yaml
---
type: task
status: queued
title: "Process invoice: Modalus February"
owner: "alfred"
tier: 2
skill_entry: "skill/execution-process-invoice.md"
required_scopes:
  - llm
# ...
---
```

Scope resolution order:
1. Task's own `required_scopes` (highest priority — explicit override)
2. Skill file's `required_scopes` (inherited if task doesn't declare its own)
3. Default: `["llm"]` (if neither declares scopes, assume LLM-only)

### New ctrl-api Endpoint

```
POST /api/v1/secrets/resolve
Authorization: Bearer <AAS_API_KEY>
Content-Type: application/json

{
  "scopes": ["llm", "email"],
  "task_path": "task/2026/03/27/process-invoice.md"  // optional, for audit log
}

Response 200:
{
  "credentials": {
    "OPENROUTER_API_KEY": "sk-or-v1-abc...",
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "OPENAI_API_KEY": "sk-...",
    "XAI_API_KEY": "xai-...",
    "GOOGLE_API_KEY": "AIza...",
    "GMAIL_OAUTH_TOKEN": "ya29...",
    "GMAIL_CLIENT_ID": "...",
    "GMAIL_CLIENT_SECRET": "..."
  },
  "resolved_scopes": ["llm", "email"],
  "denied_scopes": []
}

Response 403 (if internal scope requested):
{
  "error": "Scope 'internal' cannot be granted to tasks",
  "denied_scopes": ["internal"]
}
```

### Execution Flow Changes

#### `assemble_task_context` — resolve scopes

After assembling the prompt context, read the task's and skill's `required_scopes` fields. Merge them per the resolution order above.

#### `execute_task` — fetch and inject credentials

Before calling `sessions_spawn`, call the secret store endpoint to get the scoped credentials. Pass them as environment context to the spawned session.

```python
# In execute_task activity (tasks.py)
async def _resolve_task_credentials(
    config: Any,
    task: dict[str, Any],
    skill_scopes: list[str] | None,
) -> dict[str, str]:
    """Fetch scoped credentials for a task from ctrl-api."""
    # Determine scopes
    scopes = task.get("required_scopes", skill_scopes or ["llm"])

    ctrl_url = config.alfred_ctrl_url
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{ctrl_url}/api/v1/secrets/resolve",
            headers=headers,
            json={
                "scopes": scopes,
                "task_path": task.get("path", ""),
            },
        )
        resp.raise_for_status()
        return resp.json().get("credentials", {})
```

#### OpenClaw Integration — environment scoping

OpenClaw's `sessions_spawn` currently inherits the parent agent's full environment. Two options for passing scoped credentials:

**Option A (recommended for Phase 1): Prompt-based injection** — Include credential values in the system prompt as tool-accessible config. This works today without OpenClaw changes but is less secure (credentials in conversation context).

**Option B (target state): OpenClaw env override** — Extend `sessions_spawn` to accept an `env` parameter that overrides specific environment variables for the child session. This is the proper solution but requires OpenClaw changes.

For the initial implementation, use Option A with a clear migration path to Option B:

```python
# Option A: inject credentials into the task prompt
credential_block = "\n".join(
    f"- {key}: {value}" for key, value in credentials.items()
)
prompt = f"""...existing prompt...

## Available Credentials
The following credentials are available for this task. Use them when making API calls.
{credential_block}
"""
```

### Audit Trail

Every credential resolution is logged as a structured event:

```typescript
// In the /api/v1/secrets/resolve handler
console.log(JSON.stringify({
  event: "secret_resolve",
  timestamp: new Date().toISOString(),
  task_path: body.task_path,
  requested_scopes: body.scopes,
  resolved_keys: Object.keys(resolvedCredentials),
  denied_scopes: deniedScopes,
}));
```

This provides a searchable audit trail of which tasks accessed which credentials.

---

## Security Considerations

### What This Protects Against

1. **Credential sprawl** — subagent tasks no longer see credentials they don't need
2. **Scope escalation** — the `internal` scope is hardcoded as non-grantable; no task can request `AAS_API_KEY`
3. **Audit visibility** — every credential access is logged with the requesting task path

### What This Does NOT Protect Against

1. **Compromised ctrl-api** — if ctrl-api is compromised, all credentials are accessible (they're still in `.env`). This is inherent to the single-tenant model.
2. **Prompt injection** — an LLM with credential values in its context could be tricked into leaking them. Option B (OpenClaw env override) mitigates this.
3. **OpenClaw environment** — until Option B is implemented, the openclaw container still has all credentials in its process environment. Scoping is enforced at the task layer, not the container layer.

### Threat Model Boundary

This design targets **defense in depth for autonomous agent execution**. It is not a zero-trust secrets system. The trust boundary is the tenant VPS — within it, ctrl-api is the authority. The goal is to reduce the blast radius of a misbehaving task, not to prevent a determined attacker with container access.

---

## Implementation Plan

### Phase 1: Secret Store Endpoint (ctrl-api)

**Estimated effort:** 2-3 hours

- [ ] 1.1 Add `CREDENTIAL_SCOPES` map to `credentials.ts` (or new `secrets.ts`)
- [ ] 1.2 Implement `POST /api/v1/secrets/resolve` endpoint
- [ ] 1.3 Add `internal` scope deny-list enforcement
- [ ] 1.4 Add structured audit logging for every resolve call
- [ ] 1.5 Add scope listing endpoint: `GET /api/v1/secrets/scopes` (returns scope names and their key lists, values masked)
- [ ] 1.6 Update `KNOWN_CREDENTIALS` to include scope membership metadata

### Phase 2: Skill and Task Schema Extension

**Estimated effort:** 1-2 hours

- [ ] 2.1 Add `required_scopes` to skill template (`_templates/skill.md`)
- [ ] 2.2 Add `required_scopes` to task template (`_templates/task.md`)
- [ ] 2.3 Update `VALID_FRONTMATTER_FIELDS` in schema validators if applicable
- [ ] 2.4 Add `required_scopes` to existing seed skill files

### Phase 3: Task Execution Integration (alfred-learn)

**Estimated effort:** 3-4 hours

- [ ] 3.1 Add `_resolve_task_credentials` helper to `tasks.py`
- [ ] 3.2 Update `assemble_task_context` to read skill's `required_scopes`
- [ ] 3.3 Update `execute_task` to call secret store and inject scoped credentials
- [ ] 3.4 Implement fallback: if secret store is unavailable, log warning and proceed with default `llm` scope from environment
- [ ] 3.5 Update `_llm_evaluate_consequentials` to use scoped credentials (scope: `llm` only)

### Phase 4: Dashboard Visibility (optional, future)

**Estimated effort:** 2-3 hours

- [ ] 4.1 Add scope column to credentials management page
- [ ] 4.2 Show which tasks/skills require which scopes
- [ ] 4.3 Add audit log viewer for credential access events

### Phase 5: OpenClaw Environment Override (future)

**Estimated effort:** 4-6 hours (requires OpenClaw changes)

- [ ] 5.1 Extend `sessions_spawn` to accept `env` parameter
- [ ] 5.2 Update `execute_task` to use env override instead of prompt injection
- [ ] 5.3 Remove credential values from prompt context
- [ ] 5.4 Ensure child sessions cannot access parent's env vars outside the provided set

---

## Dependencies

| Dependency | Status |
|-----------|--------|
| ctrl-api credential management | Done (credentials.ts) |
| TaskRunnerWorkflow | Done (spec 003, implemented) |
| Skill schema with frontmatter | Done (spec 003, implemented) |
| OpenClaw sessions_spawn | Done (existing) |
| OpenClaw env override for sessions | Not started (Phase 5) |

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Prompt injection leaks credentials (Option A) | Move to Option B (env override) as soon as feasible. In the meantime, limit credential values to short-lived tokens where possible. |
| Scope definitions become stale as new credentials are added | `CREDENTIAL_SCOPES` is defined alongside `KNOWN_CREDENTIALS` in the same file — adding a credential requires updating scopes. |
| Tasks fail because they lack a needed scope | Default to `["llm"]` scope. Log denied scopes clearly. Skill authors must declare scopes. |
| Secret store endpoint adds latency to task execution | Single HTTP call over localhost Docker network — sub-millisecond. Cache resolved credentials for the duration of the task. |

---

## Success Criteria

1. A task with `required_scopes: [llm]` can access OpenRouter but NOT Gmail OAuth tokens
2. A task with `required_scopes: [llm, email]` can access both LLM keys and email credentials
3. Requesting `internal` scope returns a 403
4. Every credential resolution is logged with task path, scopes, and resolved keys
5. Existing credential management (PATCH /api/v1/admin/credentials) continues to work unchanged
6. TaskRunnerWorkflow executes tasks with scoped credentials without regression
