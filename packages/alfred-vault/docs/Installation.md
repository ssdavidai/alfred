# Installation

## Requirements

- Python 3.11 or later
- An AI agent backend (see [Agent Backends](Agent-Backends))
- An Obsidian vault (or Alfred will scaffold one for you)

## Install from PyPI

```bash
# Base install (curator + janitor + distiller)
pip install alfred-vault

# With Temporal workflow engine
pip install "alfred-vault[temporal]"

# With surveyor (adds ML/vector dependencies)
pip install "alfred-vault[all]"
```

The base install includes the semantic layer workers (curator, janitor, distiller). The `[temporal]` extra adds the workflow engine. The `[all]` extra adds everything (surveyor ML/vector deps + Temporal).

## Install from Source

```bash
git clone https://github.com/ssdavidai/alfred.git
cd alfred
pip install -e .          # base (semantic layer workers)
pip install -e ".[all]"   # full (surveyor + temporal)
```

## Setup

Run the interactive quickstart wizard:

```bash
alfred quickstart
```

The wizard will:

1. Ask for your vault path (or create a new one)
2. Scaffold the vault directory structure (entity directories, templates, base views, starter views)
3. Create a `user-profile.md` in your vault root
4. Ask which agent backend to use (Claude Code, Zo Computer, or OpenClaw)
5. Write `config.yaml` and `.env`
6. Optionally configure the surveyor (Ollama for embeddings, OpenRouter for labeling)
7. Offer to start daemons immediately

## Manual Setup

If you prefer to configure manually:

```bash
cp config.yaml.example config.yaml
cp .env.example .env
```

Edit both files. See [Configuration](Configuration) for all options.

## Verifying Installation

```bash
alfred status          # check what's configured
alfred up --live       # start with dashboard to see everything working
```

## Temporal Setup (Kinetic Layer)

The Temporal workflow engine requires a running Temporal server:

1. **Install Temporal CLI**:
   ```bash
   # See: https://docs.temporal.io/cli#install
   brew install temporal  # macOS
   ```

2. **Start the dev server**:
   ```bash
   temporal server start-dev
   ```

3. **Add config** (optional — defaults work for local dev):
   ```yaml
   # config.yaml
   temporal:
     address: "127.0.0.1:7233"
     task_queue: "alfred-workflows"
     workflow_dirs: ["./workflows"]
   ```

4. **Start the worker**:
   ```bash
   alfred temporal worker
   ```

See [Kinetic Layer](Kinetic-Layer) for workflow authoring and schedule management.

## Surveyor-Specific Setup

The surveyor requires additional infrastructure:

1. **Ollama** (for local embeddings):
   ```bash
   # Install Ollama: https://ollama.com
   ollama pull nomic-embed-text    # or your preferred embedding model
   ```

2. **OpenRouter API key** (for cluster labeling):
   - Sign up at https://openrouter.ai
   - Add your API key to `.env`: `OPENROUTER_API_KEY=sk-or-...`

3. **Milvus Lite** (automatic):
   - Installed with `[all]` extra
   - File-based vector store at `data/milvus_lite.db`
   - No external server needed
