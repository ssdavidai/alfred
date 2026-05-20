# Surveyor

Surveyor is one of four AI-powered tools in Alfred for managing Obsidian vaults. Unlike the other three tools (Curator, Janitor, Distiller), Surveyor doesn't use the agent backend pattern. Instead, it runs a specialized machine learning pipeline that discovers semantic relationships within your vault.

## Overview

Surveyor analyzes your vault content to:
- Convert records into vector embeddings that capture semantic meaning
- Group semantically similar content into clusters
- Label clusters with hierarchical tags
- Suggest relationship links between related records that don't already link to each other
- Write discovered tags and relationships back to vault files

This creates an emergent ontology from your vault's actual content, helping you discover connections and themes you may not have explicitly encoded.

## Architecture

Surveyor operates independently of the agent system. It uses:
- **Ollama** (local) or **OpenRouter** (cloud) for generating embeddings
- **Milvus Lite** for vector storage (file-based database at `data/milvus_lite.db`)
- **HDBSCAN** for semantic clustering based on embedding similarity
- **Leiden algorithm** for structural community detection based on wikilink relationships
- **OpenRouter LLM** for intelligent cluster labeling and relationship suggestions

## Four-Stage Pipeline

Surveyor processes your vault through four sequential stages:

### 1. Embed

The embedder converts vault records into vector representations that capture semantic meaning.

**Process:**
- Scans all markdown files in the vault (respecting ignore rules)
- For each file, extracts frontmatter and body text
- Builds embedding text from record type, name, tags, and body content
- Sends text to embedding API and stores resulting vectors in Milvus
- Tracks file hashes to detect changes since last run
- Only processes new or modified files (incremental updates)

**Features:**
- Supports two embedding providers:
  - **Ollama** (default): Local embedding model, typically `nomic-embed-text`
  - **OpenAI-compatible API**: Cloud providers like OpenRouter with models like `openai/text-embedding-3-small`
- Retry logic with exponential backoff (max 5 retries, base delay 2s)
- Connection pooling for efficient HTTP requests
- Throttling between requests (200ms delay)
- Reports upserted and deleted embedding counts

**Configuration:**
```yaml
surveyor:
  ollama:
    base_url: "http://localhost:11434"
    model: "nomic-embed-text"
    embedding_dims: 768
    # api_key: "${OPENROUTER_API_KEY}"  # Optional: enables OpenAI-compatible mode
```

For OpenRouter embeddings:
```yaml
surveyor:
  ollama:
    base_url: "https://openrouter.ai/api/v1"
    model: "openai/text-embedding-3-small"
    embedding_dims: 1536
    api_key: "${OPENROUTER_API_KEY}"
```

### 2. Cluster

The clusterer analyzes embedding vectors and wikilink relationships to find groups of related content.

**Process:**
- Retrieves all embeddings from Milvus
- Runs **HDBSCAN** clustering on embedding vectors (semantic similarity)
- Builds a graph from wikilinks between records
- Runs **Leiden** community detection on the link graph (structural relationships)
- Detects which clusters changed membership since last run
- Updates state with new cluster assignments

**Features:**
- HDBSCAN parameters control cluster granularity:
  - `min_cluster_size`: Minimum records to form a cluster
  - `min_samples`: Minimum samples in a neighborhood for core points
- Leiden resolution parameter controls community size
- Tracks both semantic clusters (content similarity) and structural communities (link patterns)
- Skips clustering if vault has too few files
- Reports cluster counts and change counts

**Configuration:**
```yaml
surveyor:
  clustering:
    hdbscan:
      min_cluster_size: 3
      min_samples: 2
    leiden:
      resolution: 1.0
```

### 3. Label

The labeler uses an LLM to understand what each cluster represents and suggest meaningful tags.

**Process:**
- For each changed cluster, builds context from member records
- Sends cluster member summaries to OpenRouter LLM
- Asks for 1-3 hierarchical tags describing the cluster's theme
- Requests relationship suggestions for co-clustered files that don't link to each other
- Validates JSON responses and filters by confidence threshold

**Features:**
- Skips clusters smaller than `min_cluster_size_to_label`
- Limits context to `max_files_per_cluster_context` members
- Shows type, name, and body preview for each member
- Generates hierarchical tags (e.g., "construction/residential", "finance/invoicing")
- Suggests relationship types: "related-to", "supports", "depends-on", "part-of", "supersedes", "contradicts"
- Only includes relationship suggestions with confidence >= 0.5
- Rate limiting with 1-second delay between API calls
- Retry logic with exponential backoff (max 3 retries)
- Tracks token usage for cost monitoring

**Configuration:**
```yaml
surveyor:
  openrouter:
    api_key: "${OPENROUTER_API_KEY}"
    base_url: "https://openrouter.ai/api/v1"
    model: "x-ai/grok-4.1-fast"
    temperature: 0.3
  labeler:
    max_files_per_cluster_context: 20
    body_preview_chars: 200
    min_cluster_size_to_label: 2
```

### 4. Write

The writer applies discovered tags and relationships back to vault files.

**Process:**
- For each cluster with new labels, writes tags to member frontmatter
- For each suggested relationship, adds wikilink to source file's body
- Only modifies files that actually need changes
- Preserves existing frontmatter and content structure

**Features:**
- Writes tags under an `alfred_tags` frontmatter field
- Appends relationship wikilinks to file body with context
- Atomic writes to prevent corruption
- Updates cluster state with labeling timestamp and member list

## Requirements

Surveyor has additional dependencies beyond the base Alfred installation.

### Installation

**Base install** (Curator, Janitor, Distiller only):
```bash
pip install alfred-vault
```

**Full install** (includes Surveyor):
```bash
pip install "alfred-vault[all]"
```

The `[all]` extra installs machine learning and vector database dependencies:
- numpy
- scikit-learn
- hdbscan
- igraph
- leidenalg
- pymilvus
- httpx

### Runtime Requirements

**For embeddings:**
- **Option A**: Ollama running locally at `http://localhost:11434` (default)
  - Install from [ollama.com](https://ollama.com)
  - Pull embedding model: `ollama pull nomic-embed-text`
- **Option B**: OpenRouter API key for cloud embeddings
  - Sign up at [openrouter.ai](https://openrouter.ai)
  - Set `OPENROUTER_API_KEY` environment variable

**For labeling:**
- OpenRouter API key (required)
- Set `OPENROUTER_API_KEY` in environment or `.env` file

## Configuration

All configuration lives in `config.yaml` under the `surveyor` section.

### Full Example

```yaml
surveyor:
  watcher:
    debounce_seconds: 30

  ollama:
    base_url: "http://localhost:11434"
    model: "nomic-embed-text"
    embedding_dims: 768

  milvus:
    uri: "./data/milvus_lite.db"
    collection_name: "vault_embeddings"

  clustering:
    hdbscan:
      min_cluster_size: 3
      min_samples: 2
    leiden:
      resolution: 1.0

  openrouter:
    api_key: "${OPENROUTER_API_KEY}"
    base_url: "https://openrouter.ai/api/v1"
    model: "x-ai/grok-4.1-fast"
    temperature: 0.3

  labeler:
    max_files_per_cluster_context: 20
    body_preview_chars: 200
    min_cluster_size_to_label: 2

  state:
    path: "./data/surveyor_state.json"
```

### Key Parameters

**Watcher:**
- `debounce_seconds`: Wait time after file changes before processing (default: 30)

**Ollama/Embeddings:**
- `base_url`: Embedding API endpoint
- `model`: Embedding model name
- `embedding_dims`: Vector dimensions (768 for nomic-embed-text, 1536 for text-embedding-3-small)
- `api_key`: Optional, enables OpenAI-compatible mode

**Milvus:**
- `uri`: Database file path (default: `./data/milvus_lite.db`)
- `collection_name`: Collection name for embeddings (default: `vault_embeddings`)

**Clustering:**
- `hdbscan.min_cluster_size`: Minimum records to form a cluster (default: 3)
- `hdbscan.min_samples`: Minimum samples in neighborhood (default: 2)
- `leiden.resolution`: Community detection resolution (default: 1.0)

**OpenRouter:**
- `api_key`: OpenRouter API key (use `${OPENROUTER_API_KEY}` for env var substitution)
- `base_url`: API endpoint (default: `https://openrouter.ai/api/v1`)
- `model`: LLM model for labeling (default: `x-ai/grok-4.1-fast`)
- `temperature`: Sampling temperature (default: 0.3)

**Labeler:**
- `max_files_per_cluster_context`: Max files to include in cluster context (default: 20)
- `body_preview_chars`: Characters of body to include in preview (default: 200)
- `min_cluster_size_to_label`: Skip labeling clusters smaller than this (default: 2)

**State:**
- `path`: State persistence file location (default: `./data/surveyor_state.json`)

## Usage

### Run Once

Run the full pipeline once and exit:

```bash
alfred surveyor
```

This executes all four stages (embed, cluster, label, write) sequentially.

### Run as Daemon

Run as a background daemon that watches for vault changes:

```bash
# Start in background
alfred up --only surveyor

# Check status
alfred status

# Stop daemon
alfred down
```

The daemon watches for file changes and automatically re-runs the pipeline when debounce period expires (default 30 seconds).

### Run with All Tools

Include surveyor with other Alfred tools:

```bash
# Start all daemons
alfred up

# Start specific tools
alfred up --only curator,surveyor

# Run in foreground for debugging
alfred up --only surveyor --foreground
```

## State and Data

Surveyor maintains several data files:

- `data/milvus_lite.db`: Vector database with embeddings
- `data/surveyor_state.json`: File hashes, cluster assignments, labeling history
- `data/surveyor.log`: Processing logs
- `data/vault_audit.log`: Append-only log of all vault mutations

State files can be deleted to force full re-processing. The vault itself is always the source of truth.

## Performance Characteristics

**Embedding:**
- Incremental: Only processes new/changed files
- Speed depends on embedding provider (Ollama is faster locally)
- Connection pooling reduces HTTP overhead
- Retry logic handles transient failures

**Clustering:**
- Full reclustering on each run (detects changes from previous state)
- Requires minimum file count (default: 3)
- HDBSCAN scales well to thousands of documents
- Leiden runs on sparse wikilink graph

**Labeling:**
- Only labels clusters with changed membership
- Rate limited (1 second between API calls)
- Skips tiny clusters (configurable threshold)
- Token usage tracked for cost monitoring

## Troubleshooting

### Surveyor Dependencies Not Installed

**Error:** `Surveyor dependencies not installed: No module named 'hdbscan'`

**Solution:**
```bash
pip install "alfred-vault[all]"
```

### Ollama Connection Failed

**Error:** Connection refused to `http://localhost:11434`

**Solution:**
1. Check Ollama is running: `ollama list`
2. Start Ollama if needed
3. Pull embedding model: `ollama pull nomic-embed-text`

### OpenRouter API Key Missing

**Error:** Authentication error from OpenRouter

**Solution:**
1. Sign up at [openrouter.ai](https://openrouter.ai)
2. Get API key from dashboard
3. Add to `.env`: `OPENROUTER_API_KEY=your-key-here`
4. Reference in config: `api_key: "${OPENROUTER_API_KEY}"`

### Too Few Files to Cluster

**Log:** `clusterer.too_few_files`

**Explanation:** Vault has fewer files than `min_cluster_size`. This is normal for new vaults.

**Solution:** Add more content or reduce `clustering.hdbscan.min_cluster_size` in config.

### Milvus Database Lock

**Error:** Database is locked by another process

**Solution:**
1. Ensure only one surveyor instance is running
2. Stop all instances: `alfred down`
3. Check for stale processes: `ps aux | grep alfred`
4. Delete lock file if safe: `rm data/milvus_lite.db.lock`

## Comparison with Other Tools

| Tool | Uses Agent Backend | Purpose | Dependencies |
|------|-------------------|---------|--------------|
| **Curator** | Yes | Process inbox into structured records | Base |
| **Janitor** | Yes | Fix structural issues | Base |
| **Distiller** | Yes | Extract latent knowledge | Base |
| **Surveyor** | No | Discover semantic relationships | ML extras `[all]` |

Surveyor is the only tool that:
- Requires ML/vector dependencies
- Doesn't use the agent prompt system
- Directly analyzes content embeddings
- Runs specialized clustering algorithms
- Has external API requirements (Ollama or OpenRouter)

## See Also

- [Installation Guide](Installation.md)
- [Configuration Reference](Configuration.md)
- [Curator Documentation](Curator.md)
- [Janitor Documentation](Janitor.md)
- [Distiller Documentation](Distiller.md)
