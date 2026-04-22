"""Main loop orchestrator — watch → embed → cluster → label → write-back."""

from __future__ import annotations

import asyncio
from pathlib import Path

import structlog

from .clusterer import Clusterer
from .config import PipelineConfig
from .embedder import Embedder
from .labeler import Labeler
from .parser import parse_file, VaultRecord
from .state import PipelineState
from .utils import compute_md5
from .watcher import VaultWatcher
from .writer import VaultWriter

log = structlog.get_logger()

LOOP_INTERVAL = 5.0  # seconds


class Daemon:
    def __init__(self, cfg: PipelineConfig) -> None:
        self.cfg = cfg
        self._shutdown_requested = False

        self.state = PipelineState(cfg.state.path)
        self.watcher = VaultWatcher(cfg.vault, cfg.watcher)
        self.embedder = Embedder(cfg.ollama, cfg.milvus, cfg.vault.path, self.state)
        self.clusterer = Clusterer(cfg.clustering, self.state)
        self.labeler = Labeler(cfg.openrouter, cfg.labeler)
        self.writer = VaultWriter(cfg.vault.path, self.state)

    def request_shutdown(self) -> None:
        log.info("daemon.shutdown_requested")
        self._shutdown_requested = True

    async def shutdown(self) -> None:
        """Graceful shutdown: stop watcher, close HTTP clients, save state."""
        log.info("daemon.shutting_down")
        self.watcher.stop()
        await self.embedder.close()
        self.state.save()
        log.info("daemon.shutdown_complete")

    async def run(self) -> None:
        """Main daemon loop."""
        log.info("daemon.starting")
        self.state.load()

        # Initial sync if no state exists
        if not self.state.files:
            await self._initial_sync()

        # Start filesystem watcher
        self.watcher.start()

        try:
            while not self._shutdown_requested:
                await self._tick()
                await asyncio.sleep(LOOP_INTERVAL)
        finally:
            await self.shutdown()

    async def _initial_sync(self) -> None:
        """Full scan → embed all → cluster → label."""
        log.info("daemon.initial_sync_start")

        hashes = self.watcher.full_scan()
        for rel, md5 in hashes.items():
            self.state.update_file(rel, md5)

        all_paths = list(hashes.keys())
        records = await self.embedder.process_diff(all_paths, [], [])

        # Need all records for clustering — parse any we didn't get from embedder
        all_records = dict(records)
        for rel in all_paths:
            if rel not in all_records:
                try:
                    all_records[rel] = parse_file(self.cfg.vault.path, rel)
                except Exception:
                    pass

        await self._cluster_and_label(all_records)
        self.state.save()
        log.info("daemon.initial_sync_complete", files=len(hashes))

    async def _tick(self) -> None:
        """One iteration of the main loop."""
        # Collect debounced file events
        debounced = self.watcher.collect_debounced()
        if not debounced:
            return

        # Compute hashes for touched files
        current_hashes: dict[str, str] = {}
        vault_path = self.cfg.vault.path
        for rel in debounced:
            full = vault_path / rel
            if full.exists():
                try:
                    current_hashes[rel] = compute_md5(full)
                except OSError:
                    pass

        # Also include all known files for a complete diff
        for rel, fs in self.state.files.items():
            if rel not in current_hashes:
                full = vault_path / rel
                if full.exists():
                    current_hashes[rel] = fs.md5
                # If file doesn't exist, it's not in current_hashes → will be detected as deleted

        diff = self.state.compute_diff(current_hashes)
        if diff.empty:
            return

        log.info("daemon.processing_diff", diff=str(diff))

        # Update state with new hashes
        for rel in diff.new + diff.changed:
            if rel in current_hashes:
                self.state.update_file(rel, current_hashes[rel])

        # Stage 2: Embed
        records = await self.embedder.process_diff(diff.new, diff.changed, diff.deleted)

        # Parse all known records for clustering
        all_records: dict[str, VaultRecord] = {}
        for rel in self.state.files:
            if rel in records:
                all_records[rel] = records[rel]
            else:
                try:
                    all_records[rel] = parse_file(self.cfg.vault.path, rel)
                except Exception:
                    pass

        # Stage 3 + 4: Cluster and label
        await self._cluster_and_label(all_records)
        self.state.save()

    async def _cluster_and_label(self, records: dict[str, VaultRecord]) -> None:
        """Run clustering then label changed clusters."""
        # Get all embeddings for clustering
        embedding_data = self.embedder.get_all_embeddings()
        if embedding_data is None:
            log.info("daemon.no_embeddings_to_cluster")
            return

        paths, vectors = embedding_data

        # Stage 3: Cluster
        result = self.clusterer.run(paths, vectors, records)

        # Stage 4: Label changed clusters
        all_changed = result.changed_semantic | result.changed_structural
        if not all_changed:
            log.info("daemon.no_changed_clusters")
            return

        # Build cluster membership map (semantic)
        cluster_members: dict[int, list[str]] = {}
        for path, cid in result.semantic.items():
            if cid == -1:
                continue
            cluster_members.setdefault(cid, []).append(path)

        # Clusters are independent — their label calls and relationship
        # suggestions don't share state. Fan them out through an asyncio
        # semaphore so we can keep up to `max_concurrent` LLM calls in
        # flight instead of serialising 208 × 2 calls at ~5-10s each.
        from .state import ClusterState
        from datetime import datetime, timezone

        semaphore = asyncio.Semaphore(self.cfg.labeler.max_concurrent)

        async def _process_cluster(cid: int) -> None:
            members = cluster_members.get(cid, [])
            if len(members) < self.cfg.labeler.min_cluster_size_to_label:
                return

            async with semaphore:
                tags = await self.labeler.label_cluster(cid, members, records)
                if tags:
                    for path in members:
                        self.writer.write_alfred_tags(path, tags)
                    cluster_key = f"semantic_{cid}"
                    self.state.clusters[cluster_key] = ClusterState(
                        label=tags,
                        member_files=members,
                        last_labeled=datetime.now(timezone.utc).isoformat(),
                    )

                rels = await self.labeler.suggest_relationships(
                    cid, members, records
                )
                for rel in rels:
                    source = rel.get("source", "")
                    if source in records:
                        self.writer.write_relationships(source, [rel])

        # gather() with return_exceptions=True keeps the pass running even
        # if one cluster's LLM call blows up — we'd rather log and keep
        # labeling the rest than abort the whole surveyor tick.
        results = await asyncio.gather(
            *(_process_cluster(cid) for cid in all_changed),
            return_exceptions=True,
        )
        failures = [r for r in results if isinstance(r, Exception)]
        for err in failures:
            log.warning("daemon.cluster_label_error", error=str(err)[:200])

        log.info(
            "daemon.labeling_complete",
            clusters_processed=len(all_changed),
            failed=len(failures),
            concurrency=self.cfg.labeler.max_concurrent,
        )

        # Stage 5: structured entity-link writeback. For each cluster whose
        # membership changed, walk non-entity members and add typed
        # frontmatter links (related_matters / related_persons / related_orgs
        # / related_projects) to any entity member of the same cluster whose
        # cosine similarity is above the configured threshold.
        self._link_entities_in_clusters(
            all_changed, cluster_members, records, paths, vectors,
        )

    def _link_entities_in_clusters(
        self,
        changed_cluster_ids: set[int],
        cluster_members: dict[int, list[str]],
        records: dict[str, "VaultRecord"],
        all_paths: list[str],
        all_vectors,
    ) -> None:
        """Write structured entity-link frontmatter for records whose cluster
        contains entity records (matter/person/org/project).

        For each non-entity member of a changed cluster, compute cosine
        similarity against each entity member. Above threshold → add the
        entity's vault path to the appropriate typed frontmatter field.

        Requires numpy; surveyor already imports it for embedding work.
        """
        import numpy as np
        from .labeler import ENTITY_RECORD_TYPES

        # Build path → vector lookup once (all_paths + all_vectors come from
        # embedder.get_all_embeddings()).
        path_to_vec: dict[str, "np.ndarray"] = {}
        for p, v in zip(all_paths, all_vectors):
            path_to_vec[p] = np.asarray(v, dtype=np.float32)

        # Entity type → frontmatter field name → writer method.
        # Kept local to avoid polluting module namespace.
        writer_methods = {
            "matter": self.writer.write_related_matters,
            "person": self.writer.write_related_persons,
            "org": self.writer.write_related_orgs,
            "project": self.writer.write_related_projects,
        }

        threshold = self.cfg.entity_link.threshold
        max_per = self.cfg.entity_link.max_per_record

        total_added = 0
        clusters_processed = 0
        for cid in changed_cluster_ids:
            members = cluster_members.get(cid, [])
            if len(members) < 2:
                continue

            # Partition: entities by type, regulars separately
            entities_by_type: dict[str, list[str]] = {}
            regulars: list[str] = []
            for path in members:
                record = records.get(path)
                if record is None:
                    continue
                if record.record_type in ENTITY_RECORD_TYPES:
                    entities_by_type.setdefault(record.record_type, []).append(path)
                else:
                    regulars.append(path)

            if not entities_by_type or not regulars:
                continue
            clusters_processed += 1

            for reg_path in regulars:
                reg_vec = path_to_vec.get(reg_path)
                if reg_vec is None:
                    continue

                for entity_type, entity_paths in entities_by_type.items():
                    # Compute cos(reg_path, each entity), keep those above
                    # threshold, sort by similarity desc, cap at max_per.
                    scored: list[tuple[str, float]] = []
                    for e_path in entity_paths:
                        e_vec = path_to_vec.get(e_path)
                        if e_vec is None:
                            continue
                        # Vectors are already L2-normalised in the embedder,
                        # so dot product == cosine similarity.
                        sim = float(np.dot(reg_vec, e_vec))
                        if sim >= threshold:
                            scored.append((e_path, sim))

                    if not scored:
                        continue

                    scored.sort(key=lambda x: x[1], reverse=True)
                    to_write = [p for p, _ in scored[:max_per]]

                    method = writer_methods[entity_type]
                    added = method(reg_path, to_write, max_total=max_per)
                    total_added += added

        if clusters_processed > 0:
            log.info(
                "daemon.entity_linking_complete",
                clusters_processed=clusters_processed,
                links_added=total_added,
                threshold=threshold,
                max_per_record=max_per,
            )
