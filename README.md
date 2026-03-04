# Alfred + OpenClaw — One-Click Deploy

Deploy [Alfred](https://github.com/ssdavidai/alfred) (Obsidian vault operations suite) with [OpenClaw](https://github.com/openclaw/openclaw) (personal AI assistant) as its agent backend.

## Path A: Shell Script (Existing OpenClaw Users)

If you already have OpenClaw installed locally:

```bash
git clone https://github.com/ssdavidai/alfred-openclaw.git
cd alfred-openclaw
./setup.sh
```

**Prerequisites:** Python 3.11+, OpenClaw on PATH, git

The script will:
1. Clone and install Alfred with all surveyor dependencies
2. Scaffold an Obsidian vault from Alfred's template
3. Copy Alfred skills into your OpenClaw workspace
4. Generate config pointing to OpenRouter for embeddings
5. Print instructions for starting Alfred

Then run:
```bash
openclaw gateway        # Terminal 1: start OpenClaw
cd ~/.alfred && alfred up   # Terminal 2: start Alfred
```

## Path B: Docker Compose (Fresh Deploy)

For deploying both OpenClaw and Alfred from scratch:

```bash
git clone https://github.com/ssdavidai/alfred-openclaw.git
cd alfred-openclaw
cp .env.example .env    # Fill in your API keys
docker compose up --build
```

**Services:**
- **init** (one-shot) — scaffolds vault, copies skills, generates config
- **openclaw** (gateway) — serves on `:18789`, health-checked
- **alfred** (daemons) — all 4 vault operations daemons

**Volumes:** `vault_data`, `openclaw_state`, `alfred_data`

### Idempotency

| Operation | First run | Re-run |
|-----------|-----------|--------|
| Vault scaffold | Creates from template | Skips (only creates missing dirs) |
| Skills copy | Full copy + hash marker | Skips if hash matches |
| Config generation | Creates config.yaml | Skips (user edits preserved) |

`docker compose down -v` destroys volumes for a fresh start.

## Configuration

### API Keys (`.env`)

| Key | Required | Used by |
|-----|----------|---------|
| `ANTHROPIC_API_KEY` | Yes | OpenClaw (AI model) |
| `OPENROUTER_API_KEY` | Yes | Surveyor (embeddings + labeling) |
| `OPENAI_API_KEY` | No | OpenClaw (alternative model) |

### Surveyor Embeddings

Both paths configure OpenRouter's `text-embedding-3-small` (1536 dims) for embeddings by default. The surveyor's embedder supports dual-mode:
- **Ollama** (default): native `/api/embeddings` endpoint
- **OpenAI-compatible** (when `api_key` is set): standard `/embeddings` endpoint

## Repository Structure

```
├── setup.sh                 # Path A: interactive shell script
├── docker-compose.yml       # Path B: service orchestration
├── .env.example             # API key template
├── config.yaml.tpl          # Shared Alfred config template
├── openclaw-wrapper         # CLI invocation translator
├── init/
│   ├── Dockerfile           # Init container (clones Alfred for scaffold/skills)
│   └── entrypoint.sh        # Idempotent setup logic
├── dockerfiles/
│   ├── openclaw.Dockerfile  # Clones & builds OpenClaw
│   ├── alfred.Dockerfile    # Clones both, builds Alfred + OpenClaw CLI
│   └── alfred-entrypoint.sh # Alfred container startup
└── patches/
    └── surveyor-openai-compat.patch  # Alfred embedder dual-mode patch
```
