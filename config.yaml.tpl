vault:
  path: "${VAULT_PATH}"
  ignore_dirs: ["_templates", "_bases", "_docs", ".obsidian", "view"]
  ignore_files: [".gitkeep"]

agent:
  backend: "openclaw"
  openclaw:
    command: "${OPENCLAW_WRAPPER_PATH}"
    args: []
    workspace_mount: ""
    timeout: 600

logging:
  level: "INFO"
  dir: "${DATA_DIR}"

curator:
  inbox_dir: "inbox"
  processed_dir: "inbox/processed"
  watcher:
    poll_interval: 5
    debounce_seconds: 10
  state:
    path: "${DATA_DIR}/curator_state.json"

janitor:
  sweep:
    interval_seconds: 3600
    deep_sweep_interval_hours: 24
    structural_only: false
    stub_body_threshold_chars: 50
    orphan_exempt_dirs: ["dashboard", "view"]
    max_files_per_agent_call: 30
    fix_log_in_vault: true
  state:
    path: "${DATA_DIR}/janitor_state.json"
    max_sweep_history: 20

distiller:
  extraction:
    interval_seconds: 3600
    deep_interval_hours: 24
    candidate_threshold: 0.3
    max_sources_per_batch: 20
    source_types: ["conversation", "session", "note", "task", "project"]
    learn_types: ["assumption", "decision", "constraint", "contradiction", "synthesis"]
  state:
    path: "${DATA_DIR}/distiller_state.json"
    max_run_history: 20

surveyor:
  watcher:
    debounce_seconds: 30
  ollama:
    base_url: "https://openrouter.ai/api/v1"
    model: "openai/text-embedding-3-small"
    embedding_dims: 1536
    api_key: "${OPENROUTER_API_KEY}"
  milvus:
    uri: "${DATA_DIR}/milvus_lite.db"
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
    path: "${DATA_DIR}/surveyor_state.json"
