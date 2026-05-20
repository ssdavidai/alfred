# Configuration

Alfred is configured through two files: `config.yaml` and `.env`. The quickstart wizard generates both.

## Environment Variables

Store secrets in `.env` (loaded automatically):

```bash
# Required for Zo backend
ZO_API_KEY=your-zo-api-key

# Required for surveyor labeling
OPENROUTER_API_KEY=sk-or-your-key

# Optional: override embedding provider
OLLAMA_BASE_URL=http://localhost:11434
```

## config.yaml

The config file uses `${VAR}` syntax for environment variable substitution. Here's a complete reference:

### vault

```yaml
vault:
  path: /path/to/your/vault
  ignore_dirs:
    - .obsidian
    - _templates
    - _bases
    - view
```

- `path` — absolute path to the Obsidian vault
- `ignore_dirs` — directories to skip during scans

### agent

```yaml
agent:
  backend: openclaw              # claude | zo | openclaw
  timeout: 300                   # LLM call timeout in seconds

  claude:
    command: claude
    args: ["-p"]

  zo:
    url: https://api.zo.computer/v1/chat
    method: POST
    api_key: ${ZO_API_KEY}

  openclaw:
    command: openclaw
    args: []
    agent_id: vault-curator      # overridden per-tool
    timeout: 300
```

### logging

```yaml
logging:
  dir: ./data                    # log directory
  level: info                    # debug | info | warning | error
```

### curator

```yaml
curator:
  interval: 30                   # inbox polling interval (seconds)
  inbox_subdir: inbox            # folder name within vault
```

### janitor

```yaml
janitor:
  interval: 300                  # light sweep interval (seconds)
  deep_interval_hours: 6         # deep sweep interval (hours)
  fix_mode: true                 # apply fixes (false = report only)
  structural_only: false         # skip LLM stages
```

### distiller

```yaml
distiller:
  interval: 600                  # light scan interval (seconds)
  deep_interval_hours: 12        # deep extraction interval (hours)
  min_signal_score: 3            # minimum candidate score to process
```

### surveyor

```yaml
surveyor:
  interval: 1800                 # daemon polling interval (seconds)

  embedder:
    provider: ollama             # ollama | openrouter
    model: nomic-embed-text
    batch_size: 10
    max_text_length: 4000        # truncate long documents

  clusterer:
    min_cluster_size: 3
    min_samples: 2

  labeler:
    min_cluster_size_to_label: 2
    max_files_per_cluster_context: 10
    body_preview_chars: 500

  openrouter:
    api_key: ${OPENROUTER_API_KEY}
    base_url: https://openrouter.ai/api/v1
    model: anthropic/claude-sonnet-4-20250514
    temperature: 0.3
```

## Per-Tool Agent IDs (OpenClaw)

When using the OpenClaw backend, each tool uses a separate agent ID to avoid session conflicts:

```yaml
agent:
  openclaw:
    agent_id: vault-curator      # default, overridden per-tool

curator:
  agent_id: vault-curator

janitor:
  agent_id: vault-janitor

distiller:
  agent_id: vault-distiller
```

Each agent must be pre-registered in OpenClaw's configuration (`~/.openclaw/openclaw.json`).

## Config Loading

Each tool has its own `config.py` with typed dataclasses. All follow the same pattern:

1. `load_from_unified(raw: dict)` takes the pre-loaded config dict
2. `_substitute_env()` replaces `${VAR}` placeholders with environment variables
3. `_build()` recursively constructs dataclasses from nested dicts
4. Config is loaded lazily in CLI handlers (not at import time)
