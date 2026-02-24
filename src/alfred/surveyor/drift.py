"""Semantic drift snapshots and comparison logic for Surveyor."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import structlog

from .config import SemanticDriftConfig
from .state import PipelineState

log = structlog.get_logger()


@dataclass
class SnapshotCluster:
    label: str
    members: list[str] = field(default_factory=list)


@dataclass
class ClusterSnapshot:
    timestamp: str
    model_backend: str
    embedding_model: str
    total_records: int
    clusters: dict[str, SnapshotCluster] = field(default_factory=dict)


class DriftMonitor:
    """Persists snapshots and computes drift reports between consecutive runs."""

    def __init__(self, data_dir: Path, config: SemanticDriftConfig, enabled: bool) -> None:
        self.data_dir = data_dir
        self.config = config
        self.enabled = enabled
        self.snapshot_dir = self.data_dir / "semantic_snapshots"
        self.report_dir = self.data_dir / "semantic_drift"
        self.similarity_threshold = self._normalize_threshold(config.similarity_threshold)
        self.retention = self._normalize_retention(config.snapshot_retention)

    def process(self, state: PipelineState, model_backend: str, embedding_model: str) -> dict | None:
        if not self.enabled:
            return None

        previous = self.load_latest_snapshot()
        current = self._build_snapshot(state, model_backend, embedding_model)
        self._write_snapshot(current)
        self._prune_snapshots()

        if previous is None:
            log.info("drift.initial_snapshot_written")
            return None

        report = self._compare(previous, current)
        self._write_report(report)

        if self.config.warn_on_high_drift and report["overall_churn"] >= self.similarity_threshold:
            log.warning(
                "drift.high_churn_detected",
                overall_churn=round(report["overall_churn"], 4),
                threshold=self.similarity_threshold,
            )
        else:
            log.info("drift.report_written", overall_churn=round(report["overall_churn"], 4))

        return report

    def list_snapshots(self) -> list[Path]:
        if not self.snapshot_dir.exists():
            return []
        return sorted(self.snapshot_dir.glob("*.json"))

    def load_latest_snapshot(self) -> ClusterSnapshot | None:
        snapshots = self.list_snapshots()
        for path in reversed(snapshots):
            snapshot = self._read_snapshot(path)
            if snapshot is not None:
                return snapshot
        return None

    def list_reports(self) -> list[Path]:
        if not self.report_dir.exists():
            return []
        return sorted(self.report_dir.glob("*.log"))

    def load_latest_report(self) -> dict | None:
        reports = self.list_reports()
        for path in reversed(reports):
            try:
                return self.load_report(path.name)
            except (FileNotFoundError, ValueError):
                continue
        return None

    def load_report(self, timestamp: str) -> dict:
        report_path = self._resolve_report_path(timestamp)
        try:
            with open(report_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            raise ValueError(f"Invalid drift report format: {report_path.name}") from e

    def _build_snapshot(self, state: PipelineState, model_backend: str, embedding_model: str) -> ClusterSnapshot:
        semantic_members: dict[int, list[str]] = {}
        for rel_path, file_state in state.files.items():
            if file_state.semantic_cluster_id == -1:
                continue
            semantic_members.setdefault(file_state.semantic_cluster_id, []).append(rel_path)

        clusters: dict[str, SnapshotCluster] = {}
        for cluster_id, members in semantic_members.items():
            key = f"cluster_{cluster_id}"
            cluster_state = state.clusters.get(f"semantic_{cluster_id}")
            label = key
            if cluster_state and cluster_state.label:
                label = " / ".join(cluster_state.label)
            clusters[key] = SnapshotCluster(label=label, members=sorted(members))

        return ClusterSnapshot(
            timestamp=self._iso_now(),
            model_backend=model_backend,
            embedding_model=embedding_model,
            total_records=len(state.files),
            clusters=clusters,
        )

    def _write_snapshot(self, snapshot: ClusterSnapshot) -> Path:
        self.snapshot_dir.mkdir(parents=True, exist_ok=True)
        path = self.snapshot_dir / f"{self._filename_timestamp()}.json"
        payload = asdict(snapshot)
        tmp_path = path.with_suffix(".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        os.replace(tmp_path, path)
        return path

    def _read_snapshot(self, path: Path) -> ClusterSnapshot | None:
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, json.JSONDecodeError):
            log.warning("drift.snapshot_unreadable", path=str(path))
            return None
        clusters = {
            cid: SnapshotCluster(label=cdata.get("label", cid), members=cdata.get("members", []))
            for cid, cdata in raw.get("clusters", {}).items()
        }
        return ClusterSnapshot(
            timestamp=raw.get("timestamp", ""),
            model_backend=raw.get("model_backend", ""),
            embedding_model=raw.get("embedding_model", ""),
            total_records=int(raw.get("total_records", 0)),
            clusters=clusters,
        )

    def _prune_snapshots(self) -> None:
        snapshots = self.list_snapshots()
        while len(snapshots) > self.retention:
            oldest = snapshots.pop(0)
            try:
                oldest.unlink(missing_ok=True)
            except OSError:
                break

    def _compare(self, previous: ClusterSnapshot, current: ClusterSnapshot) -> dict:
        prev_sets = {cid: set(cluster.members) for cid, cluster in previous.clusters.items()}
        curr_sets = {cid: set(cluster.members) for cid, cluster in current.clusters.items()}
        prev_ids = list(prev_sets.keys())
        curr_ids = list(curr_sets.keys())

        jaccard: dict[tuple[str, str], float] = {}
        for prev_id in prev_ids:
            for curr_id in curr_ids:
                score = self._jaccard(prev_sets[prev_id], curr_sets[curr_id])
                jaccard[(prev_id, curr_id)] = score

        threshold = self.similarity_threshold
        new_clusters = [cid for cid in curr_ids if max((jaccard[(pid, cid)] for pid in prev_ids), default=0.0) < threshold]
        dissolved_clusters = [pid for pid in prev_ids if max((jaccard[(pid, cid)] for cid in curr_ids), default=0.0) < threshold]

        split_events: list[dict] = []
        for prev_id in prev_ids:
            matches = [(curr_id, jaccard[(prev_id, curr_id)]) for curr_id in curr_ids if jaccard[(prev_id, curr_id)] >= threshold]
            if len(matches) >= 2:
                split_events.append(
                    {
                        "previous_cluster": prev_id,
                        "current_clusters": [cid for cid, _ in matches],
                        "combined_similarity": round(sum(score for _, score in matches), 4),
                    }
                )

        merge_events: list[dict] = []
        for curr_id in curr_ids:
            matches = [(prev_id, jaccard[(prev_id, curr_id)]) for prev_id in prev_ids if jaccard[(prev_id, curr_id)] >= threshold]
            if len(matches) >= 2:
                merge_events.append(
                    {
                        "current_cluster": curr_id,
                        "previous_clusters": [pid for pid, _ in matches],
                        "combined_similarity": round(sum(score for _, score in matches), 4),
                    }
                )

        per_cluster: list[dict] = []
        for curr_id in curr_ids:
            best_prev, best_score = self._best_prev(curr_id, prev_ids, jaccard)
            membership_change = 1.0 - best_score
            split_likelihood = 0.0
            if best_prev:
                split_likelihood = min(
                    1.0,
                    sum(jaccard[(best_prev, other_curr)] for other_curr in curr_ids if other_curr != curr_id),
                )
            merge_likelihood = min(
                1.0,
                sum(jaccard[(prev_id, curr_id)] for prev_id in prev_ids if prev_id != best_prev),
            )
            per_cluster.append(
                {
                    "cluster_id": curr_id,
                    "label": current.clusters[curr_id].label,
                    "best_previous_cluster": best_prev,
                    "best_previous_label": previous.clusters[best_prev].label if best_prev else "",
                    "jaccard_similarity": round(best_score, 4),
                    "membership_change": round(membership_change, 4),
                    "split_likelihood": round(split_likelihood, 4),
                    "merge_likelihood": round(merge_likelihood, 4),
                }
            )

        per_cluster.sort(key=lambda item: item["membership_change"], reverse=True)
        most_unstable = per_cluster[0] if per_cluster else None

        prev_assignments = self._member_to_cluster(prev_sets)
        curr_assignments = self._member_to_cluster(curr_sets)
        members_union = set(prev_assignments.keys()) | set(curr_assignments.keys())
        moved = sum(1 for member in members_union if prev_assignments.get(member) != curr_assignments.get(member))
        overall_churn = (moved / len(members_union)) if members_union else 0.0

        return {
            "timestamp": self._iso_now(),
            "previous_snapshot_timestamp": previous.timestamp,
            "current_snapshot_timestamp": current.timestamp,
            "previous_model_backend": previous.model_backend,
            "current_model_backend": current.model_backend,
            "previous_embedding_model": previous.embedding_model,
            "current_embedding_model": current.embedding_model,
            "cluster_count_delta": len(curr_ids) - len(prev_ids),
            "previous_cluster_count": len(prev_ids),
            "current_cluster_count": len(curr_ids),
            "new_clusters": new_clusters,
            "dissolved_clusters": dissolved_clusters,
            "overall_churn": round(overall_churn, 4),
            "split_events": split_events,
            "merge_events": merge_events,
            "most_unstable_cluster": {
                "cluster_id": most_unstable["cluster_id"],
                "label": most_unstable["label"],
                "membership_change": most_unstable["membership_change"],
            } if most_unstable else None,
            "per_cluster_metrics": per_cluster,
        }

    def _write_report(self, report: dict) -> Path:
        self.report_dir.mkdir(parents=True, exist_ok=True)
        path = self.report_dir / f"{self._filename_timestamp()}.log"
        tmp_path = path.with_suffix(".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
        os.replace(tmp_path, path)
        self._prune_reports()
        return path

    def _resolve_report_path(self, timestamp: str) -> Path:
        candidate = Path(timestamp.strip())
        if candidate.is_absolute() or candidate.name != str(candidate):
            raise FileNotFoundError("Report path must be a filename in data/semantic_drift.")

        if candidate.suffix != ".log":
            candidate = candidate.with_suffix(".log")
        candidate = self.report_dir / candidate.name

        try:
            candidate.resolve().relative_to(self.report_dir.resolve())
        except ValueError as e:
            raise FileNotFoundError("Report path must stay within data/semantic_drift.") from e

        if not candidate.exists():
            raise FileNotFoundError(f"Drift report not found: {timestamp}")
        return candidate

    def _prune_reports(self) -> None:
        reports = self.list_reports()
        while len(reports) > self.retention:
            oldest = reports.pop(0)
            try:
                oldest.unlink(missing_ok=True)
            except OSError:
                break

    @staticmethod
    def _member_to_cluster(clusters: dict[str, set[str]]) -> dict[str, str]:
        out: dict[str, str] = {}
        for cluster_id, members in clusters.items():
            for member in members:
                out[member] = cluster_id
        return out

    @staticmethod
    def _jaccard(a: set[str], b: set[str]) -> float:
        if not a and not b:
            return 1.0
        union = a | b
        if not union:
            return 0.0
        return len(a & b) / len(union)

    @staticmethod
    def _best_prev(curr_id: str, prev_ids: list[str], scores: dict[tuple[str, str], float]) -> tuple[str, float]:
        best_prev = ""
        best_score = 0.0
        for prev_id in prev_ids:
            score = scores[(prev_id, curr_id)]
            if score > best_score:
                best_prev = prev_id
                best_score = score
        return best_prev, best_score

    @staticmethod
    def _iso_now() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _filename_timestamp() -> str:
        return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")

    @staticmethod
    def _normalize_threshold(value: float) -> float:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return 0.5
        if parsed < 0.0:
            return 0.0
        if parsed > 1.0:
            return 1.0
        return parsed

    @staticmethod
    def _normalize_retention(value: int) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return 10
        return max(1, parsed)
