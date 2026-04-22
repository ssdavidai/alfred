"""Load config.yaml → typed dataclasses with env var substitution."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class VaultConfig:
    path: Path
    ignore_dirs: list[str] = field(default_factory=lambda: ["_templates", "_bases", "_docs", ".obsidian", "view"])
    ignore_files: list[str] = field(default_factory=lambda: [".gitkeep"])


@dataclass
class WatcherConfig:
    debounce_seconds: float = 30.0


@dataclass
class OllamaConfig:
    base_url: str = "http://localhost:11434"
    model: str = "nomic-embed-text"
    embedding_dims: int = 768
    api_key: str = ""  # If set, uses OpenAI-compatible /v1/embeddings endpoint


@dataclass
class MilvusConfig:
    uri: str = "./data/milvus_lite.db"
    collection_name: str = "vault_embeddings"


@dataclass
class HdbscanConfig:
    min_cluster_size: int = 3
    min_samples: int = 2


@dataclass
class LeidenConfig:
    resolution: float = 1.0


@dataclass
class ClusteringConfig:
    hdbscan: HdbscanConfig = field(default_factory=HdbscanConfig)
    leiden: LeidenConfig = field(default_factory=LeidenConfig)


@dataclass
class OpenRouterConfig:
    api_key: str = ""
    base_url: str = "https://openrouter.ai/api/v1"
    model: str = "x-ai/grok-4.1-fast"
    temperature: float = 0.3


@dataclass
class LabelerConfig:
    max_files_per_cluster_context: int = 20
    body_preview_chars: int = 200
    min_cluster_size_to_label: int = 2
    # Max LLM calls in flight during the cluster-labeling pass. Each cluster
    # fires 2 sequential calls (label_cluster + suggest_relationships), and
    # we fan out across clusters. 8 keeps well under OpenRouter's default
    # rate limits for the fast-tier models while shortening full-vault
    # labeling from tens of minutes to single digits.
    max_concurrent: int = 8


@dataclass
class EntityLinkConfig:
    """Structured entity-link writeback — when a cluster contains entity
    records (matter/person/org/project), non-entity members with cosine
    similarity above threshold get the entity's vault path written into
    a typed frontmatter field (related_matters / related_persons / etc).
    """
    threshold: float = 0.75
    max_per_record: int = 5


@dataclass
class StateConfig:
    path: str = "./data/state.json"


@dataclass
class LoggingConfig:
    level: str = "INFO"
    file: str = "./data/pipeline.log"


@dataclass
class PipelineConfig:
    vault: VaultConfig
    watcher: WatcherConfig
    ollama: OllamaConfig
    milvus: MilvusConfig
    clustering: ClusteringConfig
    openrouter: OpenRouterConfig
    labeler: LabelerConfig
    state: StateConfig
    logging: LoggingConfig
    entity_link: EntityLinkConfig = field(default_factory=EntityLinkConfig)


_ENV_PATTERN = re.compile(r"\$\{(\w+)\}")


def _substitute_env(value: str) -> str:
    """Replace ${ENV_VAR} patterns with environment variable values."""
    def replacer(match: re.Match) -> str:
        var_name = match.group(1)
        env_val = os.environ.get(var_name, "")
        return env_val
    return _ENV_PATTERN.sub(replacer, value)


def _walk_and_substitute(obj: object) -> object:
    """Recursively substitute env vars in all string values."""
    if isinstance(obj, str):
        return _substitute_env(obj)
    if isinstance(obj, dict):
        return {k: _walk_and_substitute(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_walk_and_substitute(item) for item in obj]
    return obj


def _build_dataclass(cls, data: dict | None):
    """Build a dataclass from a dict, handling nested dataclasses."""
    if data is None:
        return cls()
    # Resolve string annotations to actual types
    import typing
    hints = typing.get_type_hints(cls)
    kwargs = {}
    for f in cls.__dataclass_fields__.values():
        if f.name not in data:
            continue
        val = data[f.name]
        resolved_type = hints.get(f.name, f.type)
        # Check if the field type is itself a dataclass
        origin = getattr(resolved_type, "__origin__", None)
        if origin is None and hasattr(resolved_type, "__dataclass_fields__"):
            kwargs[f.name] = _build_dataclass(resolved_type, val)
        elif resolved_type is Path or (isinstance(resolved_type, type) and issubclass(resolved_type, Path)):
            kwargs[f.name] = Path(val)
        else:
            kwargs[f.name] = val
    return cls(**kwargs)


def load_config(config_path: str | Path) -> PipelineConfig:
    """Load config.yaml, substitute env vars, return typed PipelineConfig."""
    config_path = Path(config_path)
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(config_path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    raw = _walk_and_substitute(raw)

    return PipelineConfig(
        vault=_build_dataclass(VaultConfig, raw.get("vault")),
        watcher=_build_dataclass(WatcherConfig, raw.get("watcher")),
        ollama=_build_dataclass(OllamaConfig, raw.get("ollama")),
        milvus=_build_dataclass(MilvusConfig, raw.get("milvus")),
        clustering=_build_dataclass(ClusteringConfig, raw.get("clustering")),
        openrouter=_build_dataclass(OpenRouterConfig, raw.get("openrouter")),
        labeler=_build_dataclass(LabelerConfig, raw.get("labeler")),
        state=_build_dataclass(StateConfig, raw.get("state")),
        logging=_build_dataclass(LoggingConfig, raw.get("logging")),
        entity_link=_build_dataclass(EntityLinkConfig, raw.get("entity_link")),
    )


def load_from_unified(raw: dict) -> PipelineConfig:
    """Build PipelineConfig from a pre-loaded unified config dict."""
    raw = _walk_and_substitute(raw)
    tool = raw.get("surveyor", {})
    return PipelineConfig(
        vault=_build_dataclass(VaultConfig, raw.get("vault")),
        watcher=_build_dataclass(WatcherConfig, tool.get("watcher")),
        ollama=_build_dataclass(OllamaConfig, tool.get("ollama")),
        milvus=_build_dataclass(MilvusConfig, tool.get("milvus")),
        clustering=_build_dataclass(ClusteringConfig, tool.get("clustering")),
        openrouter=_build_dataclass(OpenRouterConfig, tool.get("openrouter")),
        labeler=_build_dataclass(LabelerConfig, tool.get("labeler")),
        state=_build_dataclass(StateConfig, tool.get("state")),
        logging=_build_dataclass(LoggingConfig, raw.get("logging")),
        entity_link=_build_dataclass(EntityLinkConfig, tool.get("entity_link")),
    )
