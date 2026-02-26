"""CLI handlers for semantic drift monitor."""

from __future__ import annotations

from pathlib import Path

from .config import PipelineConfig
from .drift import DriftMonitor


def _monitor_from_config(config: PipelineConfig) -> DriftMonitor:
    return DriftMonitor(
        data_dir=Path(config.state.path).resolve().parent,
        config=config.semantic_drift,
        enabled=config.features.semantic_drift_monitor,
    )


def cmd_status(config: PipelineConfig) -> None:
    if not config.features.semantic_drift_monitor:
        print("Semantic drift monitor is disabled. Enable `features.semantic_drift_monitor` in config.yaml.")
        return

    monitor = _monitor_from_config(config)
    latest = monitor.load_latest_report()
    if latest is None:
        print("No drift report found yet. Run `alfred surveyor` to generate snapshots.")
        return

    print("Semantic Drift Status")
    print(f"Compared clusters: {latest.get('previous_cluster_count', '?')} -> {latest.get('current_cluster_count', '?')}")
    print(f"Cluster delta: {latest.get('cluster_count_delta', '?')}")
    print(f"New clusters: {len(latest.get('new_clusters', []))}")
    print(f"Dissolved clusters: {len(latest.get('dissolved_clusters', []))}")
    print(f"Overall churn: {round(latest.get('overall_churn', 0.0) * 100, 2)}%")

    unstable = latest.get("most_unstable_cluster")
    if unstable:
        print(
            "Most unstable: "
            f"{unstable.get('label', unstable.get('cluster_id', 'unknown'))} "
            f"({round(float(unstable.get('membership_change', 0.0)) * 100, 2)}% change)"
        )

    if latest.get("current_model_backend") != latest.get("previous_model_backend"):
        print(
            "Warning: model backend changed "
            f"({latest.get('previous_model_backend')} -> {latest.get('current_model_backend')})"
        )
    if latest.get("current_embedding_model") != latest.get("previous_embedding_model"):
        print(
            "Warning: embedding model changed "
            f"({latest.get('previous_embedding_model')} -> {latest.get('current_embedding_model')})"
        )


def cmd_history(config: PipelineConfig, limit: int = 10) -> None:
    if not config.features.semantic_drift_monitor:
        print("Semantic drift monitor is disabled. Enable `features.semantic_drift_monitor` in config.yaml.")
        return

    monitor = _monitor_from_config(config)
    reports = monitor.list_reports()
    if not reports:
        print("No drift history found.")
        return

    print("Semantic Drift History")
    for path in reports[-max(1, limit):]:
        print(path.name)


def cmd_show(config: PipelineConfig, timestamp: str) -> None:
    if not config.features.semantic_drift_monitor:
        print("Semantic drift monitor is disabled. Enable `features.semantic_drift_monitor` in config.yaml.")
        return

    monitor = _monitor_from_config(config)
    try:
        report = monitor.load_report(timestamp)
    except (FileNotFoundError, ValueError) as e:
        print(str(e))
        return

    import json
    print(json.dumps(report, indent=2))
