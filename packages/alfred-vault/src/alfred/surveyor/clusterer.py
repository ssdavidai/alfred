"""Stage 3: HDBSCAN semantic clustering + Leiden structural communities."""

from __future__ import annotations

from dataclasses import dataclass, field

import igraph as ig
import leidenalg
import numpy as np
import structlog
from sklearn.cluster import HDBSCAN

from .config import ClusteringConfig
from .parser import VaultRecord
from .state import PipelineState

log = structlog.get_logger()


@dataclass
class ClusterResult:
    """Results from a clustering run."""
    semantic: dict[str, int] = field(default_factory=dict)      # rel_path -> cluster_id
    structural: dict[str, int] = field(default_factory=dict)    # rel_path -> community_id
    changed_semantic: set[int] = field(default_factory=set)     # cluster IDs that changed membership
    changed_structural: set[int] = field(default_factory=set)   # community IDs that changed membership


class Clusterer:
    def __init__(self, config: ClusteringConfig, state: PipelineState) -> None:
        self.config = config
        self.state = state

    def run(
        self,
        paths: list[str],
        vectors: np.ndarray,
        records: dict[str, VaultRecord],
    ) -> ClusterResult:
        """Full recluster: HDBSCAN on vectors, Leiden on wikilink graph."""
        result = ClusterResult()

        if len(paths) < self.config.hdbscan.min_cluster_size:
            log.info("clusterer.too_few_files", count=len(paths))
            return result

        # --- HDBSCAN semantic clustering ---
        result.semantic = self._hdbscan_cluster(paths, vectors)

        # --- Leiden structural communities ---
        result.structural = self._leiden_cluster(paths, records)

        # --- Detect changed clusters ---
        result.changed_semantic = self._detect_changes(
            result.semantic, "semantic_cluster_id"
        )
        result.changed_structural = self._detect_changes(
            result.structural, "structural_community_id"
        )

        # Update state with new assignments
        self.state.update_clusters(result.semantic, result.structural)

        log.info(
            "clusterer.complete",
            semantic_clusters=len(set(result.semantic.values()) - {-1}),
            structural_communities=len(set(result.structural.values())),
            changed_semantic=len(result.changed_semantic),
            changed_structural=len(result.changed_structural),
        )
        return result

    def _hdbscan_cluster(self, paths: list[str], vectors: np.ndarray) -> dict[str, int]:
        """Run HDBSCAN on embedding vectors."""
        clusterer = HDBSCAN(
            min_cluster_size=self.config.hdbscan.min_cluster_size,
            min_samples=self.config.hdbscan.min_samples,
            metric="cosine",
        )
        labels = clusterer.fit_predict(vectors)
        return {path: int(label) for path, label in zip(paths, labels)}

    def _leiden_cluster(
        self, paths: list[str], records: dict[str, VaultRecord]
    ) -> dict[str, int]:
        """Build wikilink graph and run Leiden community detection."""
        # Build path index for resolving wikilinks
        path_index: dict[str, int] = {p: i for i, p in enumerate(paths)}

        # Also build a name-to-index map (filename without extension)
        name_index: dict[str, int] = {}
        for i, p in enumerate(paths):
            name = p.rsplit("/", 1)[-1].replace(".md", "")
            name_index[name] = i

        # Build edges from wikilinks
        edges: list[tuple[int, int]] = []
        for path in paths:
            src_idx = path_index[path]
            record = records.get(path)
            if record is None:
                continue
            for link in record.wikilinks:
                # Try to resolve link to a file in our index
                target_idx = self._resolve_link(link, path_index, name_index)
                if target_idx is not None and target_idx != src_idx:
                    edges.append((src_idx, target_idx))

        if not edges:
            # No links → everyone in community 0
            return {p: 0 for p in paths}

        # Build igraph
        g = ig.Graph(n=len(paths), edges=edges, directed=False)
        g.simplify()  # Remove duplicates and self-loops

        # Run Leiden
        partition = leidenalg.find_partition(
            g,
            leidenalg.RBConfigurationVertexPartition,
            resolution_parameter=self.config.leiden.resolution,
        )

        return {paths[i]: partition.membership[i] for i in range(len(paths))}

    def _resolve_link(
        self,
        link: str,
        path_index: dict[str, int],
        name_index: dict[str, int],
    ) -> int | None:
        """Resolve a wikilink target to a file index."""
        # Try exact path match first (e.g. "project/Eagle Farm")
        candidates = [
            link,
            f"{link}.md",
        ]
        for candidate in candidates:
            if candidate in path_index:
                return path_index[candidate]

        # Try name-only match (e.g. "Eagle Farm" → "project/Eagle Farm.md")
        # Strip any path prefix from the link
        name = link.rsplit("/", 1)[-1]
        if name in name_index:
            return name_index[name]

        return None

    def _detect_changes(
        self, new_assignments: dict[str, int], state_field: str
    ) -> set[int]:
        """Compare new cluster assignments against state, return IDs that changed."""
        changed: set[int] = set()
        for rel_path, new_id in new_assignments.items():
            file_state = self.state.files.get(rel_path)
            if file_state is None:
                # New file → its cluster is changed
                if new_id != -1:
                    changed.add(new_id)
                continue
            old_id = getattr(file_state, state_field, -1)
            if old_id != new_id:
                # File moved clusters → both old and new are changed
                if old_id != -1:
                    changed.add(old_id)
                if new_id != -1:
                    changed.add(new_id)
        return changed
