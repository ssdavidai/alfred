# Agent Backends

Alfred's curator, janitor, and distiller delegate work to an AI agent. The agent receives a prompt and interacts with the vault through the `alfred vault` CLI. Three backend implementations are available.

## Backend Comparison

| Feature | Claude Code | Zo Computer | OpenClaw |
|---------|------------|-------------|----------|
| Type | Local subprocess | HTTP API | Local subprocess |
| Command | `claude -p` | HTTP POST | `openclaw agent` |
| Multi-stage pipelines | No (legacy mode) | No (legacy mode) | Yes |
| Setup | Install Claude Code CLI | API key | Install OpenClaw + register agents |
| Cost | Anthropic API usage | Zo API usage | Depends on model provider |
| Speed | Fast | Variable | Variable |

## Claude Code Backend

The default backend. Runs `claude -p` as a subprocess with the prompt piped to stdin.

### Setup

1. Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
2. Ensure `claude` is on your PATH
3. Set `agent.backend: claude` in `config.yaml`

### Configuration

```yaml
agent:
  backend: claude
  claude:
    command: claude
    args: ["-p"]
    timeout: 300
```

### How it Works

1. The prompt (skill text + vault context + task-specific content) is built
2. `claude -p` is spawned as a subprocess
3. The prompt is passed via stdin
4. stdout is captured and parsed for results
5. Vault mutations happen via `alfred vault` commands in the agent's environment

### Limitations

- Uses legacy single-call mode (no multi-stage pipelines)
- The entire task must complete in one agent call
- No manifest file support (relies on stdout parsing)

## Zo Computer Backend

HTTP-based backend that sends prompts to the Zo Computer API.

### Setup

1. Get a Zo API key
2. Add to `.env`: `ZO_API_KEY=your-key`
3. Set `agent.backend: zo` in `config.yaml`

### Configuration

```yaml
agent:
  backend: zo
  zo:
    url: https://api.zo.computer/v1/chat
    method: POST
    api_key: ${ZO_API_KEY}
    request_body_template: null  # optional custom template
```

### How it Works

1. The prompt is built and sent as an HTTP POST
2. The response contains the agent's output
3. Since Zo can't directly execute vault commands, a snapshot/diff approach is used
4. Changes are detected by comparing vault state before and after

### Limitations

- Uses legacy single-call mode
- No direct vault CLI access (snapshot/diff fallback)
- Network-dependent

## OpenClaw Backend

Subprocess-based backend that runs OpenClaw agents. Required for multi-stage pipelines.

### Setup

1. Install OpenClaw
2. Register agents in `~/.openclaw/openclaw.json`
3. Set `agent.backend: openclaw` in `config.yaml`

### Configuration

```yaml
agent:
  backend: openclaw
  openclaw:
    command: openclaw
    args: []
    agent_id: vault-curator    # default, overridden per tool
    timeout: 300
```

### Agent Registration

Each tool needs its own registered agent to avoid session conflicts:

```json
{
  "agents": {
    "list": [
      {
        "id": "vault-curator",
        "workspace": "/path/to/workspace"
      },
      {
        "id": "vault-janitor",
        "workspace": "/path/to/workspace"
      },
      {
        "id": "vault-distiller",
        "workspace": "/path/to/workspace"
      }
    ]
  }
}
```

### How it Works

1. Agent sessions are cleared before each invocation (prevents deadlocks)
2. The workspace CLAUDE.md is synced with the vault path
3. The prompt is written to a temp file (avoids OS arg length limits)
4. `openclaw agent --agent {id} --session-id {sid} --message "Follow instructions in {file}" --local --json`
5. Environment variables are injected: `ALFRED_VAULT_PATH`, `ALFRED_VAULT_SCOPE`, `ALFRED_VAULT_SESSION`
6. The agent executes vault commands and writes manifest files
7. stdout is captured as a fallback for manifest parsing

### Multi-Stage Pipeline Support

Only OpenClaw supports the multi-stage pipelines:
- Curator: 4 stages (analyze, resolve, interlink, enrich)
- Janitor: 3 stages (autofix, link repair, enrichment)
- Distiller: 2 passes (per-source extraction + cross-learning meta-analysis)

Each stage makes a separate, focused agent call with a targeted prompt.

### Important Notes

- Each agent is tied to a single session file — concurrent invocations deadlock
- Session files must be cleared between invocations
- Workspace files (AGENTS.md, SOUL.md, etc.) are loaded from the registered workspace, not from cwd
- Lock files are JSON: `{"pid": 12345, "createdAt": "..."}`

## Choosing a Backend

- **For best results**: Use OpenClaw. It supports multi-stage pipelines with focused per-stage prompts.
- **For simplicity**: Use Claude Code. One command, no registration, works out of the box.
- **For cloud deployment**: Use Zo Computer. HTTP-based, no local agent needed.

## Setting the Backend

In `config.yaml`:

```yaml
agent:
  backend: openclaw    # or: claude, zo
```

All three backends share the same vault operations layer. The only difference is how prompts are delivered to the LLM and how results are collected.
