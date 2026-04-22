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
# How often to persist state during the labeling pass. Each label +
# suggest_relationships call costs 1-2 LLM round-trips; checkpointing
# every N clusters means a mid-pass kill loses at most this many
# clusters of work. 10 is a good balance — ~5s of extra disk I/O per
# full 200-cluster pass, minimal in the big picture.
LABEL_CHECKPOINT_EVERY = 10


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

        # Always run a startup sync — this reconciles any drift between the
        # vault on disk and persisted state (files added while surveyor was
        # down never fire watcher events). compute_diff makes this cheap —
        # only truly-new-or-changed files get re-embedded.
        await self._startup_sync()

        # Start filesystem watcher
        self.watcher.start()

        try:
            while not self._shutdown_requested:
                await self._tick()
                await asyncio.sleep(LOOP_INTERVAL)
        finally:
            await self.shutdown()

    async def _startup_sync(self) -> None:
        """Reconcile full vault against persisted state on boot.

        Runs a full filesystem rescan, diffs against state.files, and
        embeds only what's actually new or changed. Deleted files are
        purged. Unlike the prior `_initial_sync`, this path is idempotent:
        a partially-complete previous run (e.g. killed mid-labeling by
        alfred-update.timer) resumes cleanly instead of redoing everything
        from scratch.

        Also handles drift for tenants whose state file is intact but
        stale (files added to the vault while surveyor was down — the
        watcher only fires inotify events after startup, so those files
        are otherwise invisible to `_tick`).
        """
        log.info("daemon.startup_sync_start")

        hashes = self.watcher.full_scan()
        diff = self.state.compute_diff(hashes)

        log.info(
            "daemon.startup_sync_diff",
            on_disk=len(hashes),
            in_state=len(self.state.files),
            new=len(diff.new),
            changed=len(diff.changed),
            deleted=len(diff.deleted),
        )

        # Update state md5s for new/changed files BEFORE embedding.
        for rel in diff.new + diff.changed:
            if rel in hashes:
                self.state.update_file(rel, hashes[rel])

        # Embed only the delta. On a cold start this is everything; on a
        # resumed-after-restart case this is often zero or a handful.
        records = await self.embedder.process_diff(diff.new, diff.changed, diff.deleted)

        # Checkpoint here so the ~2min (cloud) / ~30min (local) embed work
        # survives even if the labeling pass crashes or gets killed.
        self.state.save()
        log.info("daemon.startup_embed_checkpoint", embedded=len(records))

        # Parse records that weren't freshly embedded so clustering sees
        # the full vault in memory.
        all_records = dict(records)
        for rel in hashes:
            if rel not in all_records:
                try:
                    all_records[rel] = parse_file(self.cfg.vault.path, rel)
                except Exception:
                    pass

        # Entity records that appeared for the FIRST TIME (diff.new, not
        # diff.changed) trigger the backfill pass on the next
        # _cluster_and_label call.
        from .labeler import ENTITY_RECORD_TYPES
        new_entity_paths = [
            p for p in diff.new
            if all_records.get(p) is not None
            and all_records[p].record_type in ENTITY_RECORD_TYPES
        ]

        await self._cluster_and_label(all_records, newly_added_entity_paths=new_entity_paths)
        self.state.save()
        log.info("daemon.startup_sync_complete", files=len(hashes))

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

        # Entity records that are genuinely NEW (not just changed) drive
        # the Stage-7 backfill pass — a renamed or edited matter
        # shouldn't re-spray related_matters across 3000 events.
        from .labeler import ENTITY_RECORD_TYPES
        new_entity_paths = [
            p for p in diff.new
            if all_records.get(p) is not None
            and all_records[p].record_type in ENTITY_RECORD_TYPES
        ]

        # Stage 3 + 4 + 5 + 6 + 7: Cluster, label, entity-link, noise-link, backfill
        await self._cluster_and_label(all_records, newly_added_entity_paths=new_entity_paths)
        self.state.save()

    async def _cluster_and_label(
        self,
        records: dict[str, VaultRecord],
        newly_added_entity_paths: list[str] | None = None,
    ) -> None:
        """Run clustering then label changed clusters.

        If `newly_added_entity_paths` is supplied and entity_link.backfill_enabled
        is true, a Stage-7 backfill pass runs after cluster + noise linking:
        for each new entity, scan every non-entity record in the vault and
        write the link when similarity is above threshold. This is the
        path that gives brand-new matters / persons / orgs / projects an
        immediate structural footprint instead of waiting for the next
        clustering pass to co-cluster them with something.
        """
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
        # Checkpoint state every N clusters so a mid-pass SIGKILL (e.g. the
        # tenant's alfred-update.timer recreating the container every 15
        # min) loses at most `LABEL_CHECKPOINT_EVERY` clusters of labeling
        # work, not the whole pass.
        processed_counter = {"count": 0}

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

                processed_counter["count"] += 1
                if processed_counter["count"] % LABEL_CHECKPOINT_EVERY == 0:
                    self.state.save()
                    log.info(
                        "daemon.label_checkpoint",
                        completed=processed_counter["count"],
                        total=len(all_changed),
                    )

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

        # Stage 6: noise-point entity linking. HDBSCAN assigns cluster id -1
        # to records that don't fit any cluster. Those records still deserve
        # related_* frontmatter — we just can't infer it from cluster
        # co-membership. Instead, compare each noise point directly against
        # every entity record in the vault and link above threshold.
        noise_paths = [p for p, cid in result.semantic.items() if cid == -1]
        if noise_paths:
            self._link_noise_points_to_entities(
                noise_paths, records, paths, vectors,
            )

        # Stage 7: backfill links FROM every non-entity record in the vault
        # TO each newly-created entity. This is the complement of the cluster
        # + noise passes, which link FROM a record TO nearby entities — here
        # we link FROM a new entity OUT to every record it's close to, so a
        # matter added at 3pm has its related-* footprint by 3:01pm rather
        # than waiting for the next cluster membership shift.
        if newly_added_entity_paths and self.cfg.entity_link.backfill_enabled:
            self._backfill_new_entities(
                newly_added_entity_paths, records, paths, vectors,
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

    def _link_noise_points_to_entities(
        self,
        noise_paths: list[str],
        records: dict[str, "VaultRecord"],
        all_paths: list[str],
        all_vectors,
    ) -> None:
        """Write related_* frontmatter for records that HDBSCAN assigned to
        noise (cluster id -1).

        These records aren't members of any cluster, so
        `_link_entities_in_clusters` never touches them — they'd stay
        unlinked forever. Instead, compare each noise point's embedding
        directly against every matter/person/org/project record in the
        vault and write the same typed frontmatter fields above threshold.

        Entity records that are themselves noise points are excluded as
        link *targets* (we don't want matter→matter self-links); they're
        still included as *sources* (their own related_* fields get
        populated if they sit alone in cluster-noise).
        """
        import numpy as np
        from .labeler import ENTITY_RECORD_TYPES

        path_to_vec: dict[str, "np.ndarray"] = {}
        for p, v in zip(all_paths, all_vectors):
            path_to_vec[p] = np.asarray(v, dtype=np.float32)

        # Collect entity paths by type from the FULL vault, not just cluster
        # members — we want to be able to link to an entity even when that
        # entity lives in a different cluster (or noise) from the source.
        all_entities_by_type: dict[str, list[str]] = {}
        for path, record in records.items():
            if record.record_type in ENTITY_RECORD_TYPES:
                all_entities_by_type.setdefault(record.record_type, []).append(path)

        if not all_entities_by_type:
            return

        writer_methods = {
            "matter": self.writer.write_related_matters,
            "person": self.writer.write_related_persons,
            "org": self.writer.write_related_orgs,
            "project": self.writer.write_related_projects,
        }

        threshold = self.cfg.entity_link.threshold
        max_per = self.cfg.entity_link.max_per_record

        total_added = 0
        noise_processed = 0
        for np_path in noise_paths:
            record = records.get(np_path)
            if record is None:
                continue
            np_vec = path_to_vec.get(np_path)
            if np_vec is None:
                continue

            # Determine this noise point's own record_type so we can skip
            # linking an entity to itself (and so matter→matter / person→
            # person self-links don't propagate through).
            src_type = record.record_type
            noise_processed += 1

            for entity_type, entity_paths in all_entities_by_type.items():
                scored: list[tuple[str, float]] = []
                for e_path in entity_paths:
                    if e_path == np_path:
                        continue  # self-link
                    # Also skip cross-type self-reference (e.g. linking a
                    # matter TO another matter via related_matters): the
                    # source was itself an entity of the same type, so that
                    # field shouldn't be used as a graph link for peers.
                    if src_type == entity_type:
                        continue
                    e_vec = path_to_vec.get(e_path)
                    if e_vec is None:
                        continue
                    sim = float(np.dot(np_vec, e_vec))
                    if sim >= threshold:
                        scored.append((e_path, sim))

                if not scored:
                    continue

                scored.sort(key=lambda x: x[1], reverse=True)
                to_write = [p for p, _ in scored[:max_per]]

                method = writer_methods[entity_type]
                added = method(np_path, to_write, max_total=max_per)
                total_added += added

        if noise_processed > 0:
            log.info(
                "daemon.noise_linking_complete",
                noise_processed=noise_processed,
                links_added=total_added,
                threshold=threshold,
                max_per_record=max_per,
            )

    def _backfill_new_entities(
        self,
        new_entity_paths: list[str],
        records: dict[str, "VaultRecord"],
        all_paths: list[str],
        all_vectors,
    ) -> None:
        """Reverse-direction scan for newly-created entity records.

        For each new entity E, walk every non-entity record R in the vault.
        If cos(E, R) >= threshold, append E's path to R's related_<E.type>
        frontmatter (up to max_per_record per field).

        This is the complement of the cluster/noise passes — they link FROM
        each record TO its nearest entities; this pass links FROM a new
        entity OUTWARDS to every record it's close to, so the new entity
        has a structural footprint immediately on creation.

        Cost: |new_entities| × |non_entity_records| numpy dot products.
        A new matter on David's ~3500-record vault = ~3500 dot products
        = sub-second.
        """
        import numpy as np
        from .labeler import ENTITY_RECORD_TYPES

        path_to_vec: dict[str, "np.ndarray"] = {}
        for p, v in zip(all_paths, all_vectors):
            path_to_vec[p] = np.asarray(v, dtype=np.float32)

        writer_methods = {
            "matter": self.writer.write_related_matters,
            "person": self.writer.write_related_persons,
            "org": self.writer.write_related_orgs,
            "project": self.writer.write_related_projects,
        }

        threshold = self.cfg.entity_link.threshold
        max_per = self.cfg.entity_link.max_per_record

        total_added = 0
        entities_processed = 0
        for entity_path in new_entity_paths:
            entity_record = records.get(entity_path)
            if entity_record is None:
                continue
            entity_type = entity_record.record_type
            if entity_type not in ENTITY_RECORD_TYPES:
                continue
            entity_vec = path_to_vec.get(entity_path)
            if entity_vec is None:
                continue

            entities_processed += 1
            method = writer_methods[entity_type]

            # For each non-entity record in the vault, check similarity.
            # Entity→entity self-type suppressed (same rule as noise
            # linking): a new matter doesn't get added to another matter's
            # related_matters list.
            for other_path, other_record in records.items():
                if other_path == entity_path:
                    continue
                if other_record.record_type == entity_type:
                    continue  # self-type suppression
                other_vec = path_to_vec.get(other_path)
                if other_vec is None:
                    continue
                sim = float(np.dot(entity_vec, other_vec))
                if sim < threshold:
                    continue
                # Write ONE entity at a time so each target record's
                # max_per_record cap is respected independently.
                added = method(other_path, [entity_path], max_total=max_per)
                total_added += added

        if entities_processed > 0:
            log.info(
                "daemon.entity_backfill_complete",
                entities_processed=entities_processed,
                links_added=total_added,
                threshold=threshold,
                max_per_record=max_per,
            )
