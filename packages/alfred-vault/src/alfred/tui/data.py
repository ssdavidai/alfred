"""Data classes, log parsers, and per-tool event interpreters.

Extracted from the original ``dashboard.py`` so that both the Rich Live
dashboard and the Textual TUI can share them.
"""

from __future__ import annotations

import json
import re
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class WorkerInfo:
    name: str
    status: str = "pending"  # pending | running | stopped | restarting
    pid: int | None = None
    restart_count: int = 0
    exit_code: int | None = None
    last_death: float = 0.0  # monotonic time of last crash detection


@dataclass
class FeedEntry:
    timestamp: str
    severity: str  # "info" | "success" | "warning" | "error"
    message: str
    tool: str = ""  # set when merging across tools (log screen)


@dataclass
class WorkerFeed:
    entries: deque[FeedEntry] = field(default_factory=lambda: deque(maxlen=50))
    current_step: str = ""
    current_file: str = ""
    health: str = "idle"  # idle | working | degraded | failing | stopped
    llm_calls: int = 0
    stdout_chars: int = 0
    tokens: int = 0
    errors: int = 0
    warnings: int = 0


@dataclass
class MutationEntry:
    timestamp: str
    tool: str
    op: str
    path: str


@dataclass
class ToolStats:
    curator_processed: int = 0
    curator_last_run: str = ""
    janitor_tracked: int = 0
    janitor_issues: int = 0
    janitor_sweeps: int = 0
    distiller_sources: int = 0
    distiller_learnings: int = 0
    distiller_runs: int = 0
    surveyor_tracked: int = 0
    surveyor_clusters: int = 0
    surveyor_last_run: str = ""


@dataclass
class ToolHealth:
    error_count: int = 0
    warning_count: int = 0
    llm_calls: int = 0
    stdout_chars: int = 0
    tokens: int = 0


@dataclass
class DashboardData:
    """Shared data store — no threading lock (Textual runs on one event loop)."""

    workers: dict[str, WorkerInfo] = field(default_factory=dict)
    feeds: dict[str, WorkerFeed] = field(default_factory=dict)
    mutations: deque[MutationEntry] = field(
        default_factory=lambda: deque(maxlen=200)
    )
    stats: ToolStats = field(default_factory=ToolStats)
    health: dict[str, ToolHealth] = field(default_factory=dict)
    start_time: float = field(default_factory=time.time)


# ---------------------------------------------------------------------------
# ANSI stripping
# ---------------------------------------------------------------------------

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")


def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


# ---------------------------------------------------------------------------
# Log line parser — structlog ConsoleRenderer format
# ---------------------------------------------------------------------------


@dataclass
class _LogEntry:
    timestamp: str
    tool: str
    level: str
    event: str
    detail: str = ""


# Example: "2024-06-01T15:05:32 [info     ] daemon.starting        tool=curator"
_LOG_RE = re.compile(
    r"^(\S+)\s+"  # timestamp (ISO or HH:MM:SS)
    r"\[(\w+)\s*\]\s+"  # [level]
    r"(\S+)"  # event name
    r"(.*)$"  # rest (detail)
)


def parse_log_line(line: str, tool: str) -> _LogEntry | None:
    line = _strip_ansi(line).strip()
    if not line:
        return None
    m = _LOG_RE.match(line)
    if not m:
        return None
    ts_raw, level, event, detail = m.groups()
    ts = ts_raw
    if "T" in ts_raw:
        ts = ts_raw.split("T", 1)[1][:8]
    return _LogEntry(
        timestamp=ts,
        tool=tool,
        level=level.strip(),
        event=event.strip(),
        detail=detail.strip(),
    )


# ---------------------------------------------------------------------------
# Key=value parser for structlog detail strings
# ---------------------------------------------------------------------------

_KV_RE = re.compile(r'(\w+)=((?:"[^"]*"|\S+))')


def _parse_kv(detail: str) -> dict[str, str]:
    return {m.group(1): m.group(2).strip('"') for m in _KV_RE.finditer(detail)}


# ---------------------------------------------------------------------------
# Per-tool event interpreters
# ---------------------------------------------------------------------------


def _interpret_curator(
    event: str, detail: str, kv: dict[str, str]
) -> tuple[str, str, str, str] | None:
    """Return (severity, message, current_step, current_file) or None."""
    if event == "daemon.processing":
        f = kv.get("file", "?")
        return ("info", f"Processing inbox/{f}", f"Processing inbox/{f}", f)
    if event == "daemon.watching":
        inbox = kv.get("inbox", "inbox/")
        return ("info", f"Watching {inbox}", f"Watching {inbox}", "")
    if event == "daemon.starting":
        return ("info", "Curator starting", "Starting...", "")
    if event == "daemon.binary_file":
        f = kv.get("file", "?")
        return ("info", f"Skipped binary file {f}", "", "")
    if event == "daemon.read_failed":
        f = kv.get("file", "?")
        return ("warning", f"Failed to read {f}", "", "")
    if event == "pipeline.start":
        f = kv.get("file", "?")
        return ("info", f"Pipeline started for {f}", "Stage 1: Note Extraction", f)
    if event == "pipeline.s1_complete":
        note = kv.get("note_path", "")
        ent = kv.get("entities_found", "0")
        if note:
            note_name = note.rsplit("/", 1)[-1] if "/" in note else note
            msg = f"Stage 1 done \u2014 {note_name}, {ent} entities found"
        else:
            msg = f"Stage 1 done \u2014 {ent} entities found"
        if ent == "0":
            return ("warning", "Stage 1 done but found 0 entities", "Stage 2: Entity Resolution", "")
        return ("info", msg, "Stage 2: Entity Resolution", "")
    if event == "pipeline.s1_failed":
        return ("error", "Stage 1 FAILED \u2014 LLM produced no output", "", "")
    if event == "pipeline.s1_no_note_created":
        return ("warning", "Stage 1 \u2014 no note created (silent fail?)", "", "")
    if event == "pipeline.manifest_parse_failed":
        return ("warning", "Failed to parse LLM manifest", "", "")
    if event == "pipeline.s2_entity_created":
        entity = kv.get("entity", "?")
        return ("success", f"Created {entity}", "", "")
    if event == "pipeline.s2_entity_exists":
        entity = kv.get("entity", "?")
        return ("info", f"Skipped existing {entity}", "", "")
    if event == "pipeline.s2_create_failed":
        entity = kv.get("entity", "?")
        return ("error", f"Failed to create {entity}", "", "")
    if event == "pipeline.s2_skip_invalid":
        return ("warning", f"Skipped invalid entity: {kv.get('entity', '?')}", "", "")
    if event == "pipeline.s3_complete":
        n = kv.get("entities_linked", "0")
        return ("info", f"Stage 3 done \u2014 linked {n} entities", "Stage 4: Enrichment", "")
    if event == "pipeline.s3_note_link_failed":
        return ("warning", f"Failed to link note: {kv.get('error', '?')}", "", "")
    if event == "pipeline.s4_complete":
        n = kv.get("enriched", "0")
        return ("info", f"Stage 4 done \u2014 enriched {n} entities", "", "")
    if event == "pipeline.s4_enriched":
        entity = kv.get("entity", "?")
        return ("info", f"Enriched {entity}", "", "")
    if event == "pipeline.complete":
        ent = kv.get("entities_resolved", "0")
        enr = kv.get("entities_enriched", "0")
        note = kv.get("note", "")
        msg = f"Pipeline complete \u2014 {ent} entities, {enr} enriched"
        if note:
            msg = f"Pipeline complete \u2014 {note}, {ent} entities, {enr} enriched"
        if ent == "0" and enr == "0":
            return ("warning", "Pipeline 'complete' but nothing was created", "Watching inbox...", "")
        return ("success", msg, "Watching inbox...", "")
    if event == "daemon.no_changes":
        return ("warning", "Agent produced no vault changes", "", "")
    if event == "daemon.completed":
        created = kv.get("created", "0")
        modified = kv.get("modified", "0")
        if created == "0" and modified == "0":
            return ("warning", "File processed but no vault changes", "Watching inbox...", "")
        return ("success", f"Completed \u2014 {created} created, {modified} modified", "Watching inbox...", "")
    if event == "daemon.pipeline_failed":
        return ("error", "Pipeline invocation FAILED", "", "")
    if event == "daemon.agent_failed":
        return ("error", "Agent invocation FAILED", "", "")
    if event == "daemon.process_error":
        return ("error", f"Processing error for {kv.get('file', '?')}", "", "")
    if event == "pipeline.llm_call":
        stage = kv.get("stage", "?")
        return ("info", f"LLM call for stage {stage}", "", "")
    if event == "pipeline.llm_timeout":
        return ("error", f"LLM timeout in stage {kv.get('stage', '?')}", "", "")
    if event == "pipeline.llm_nonzero_exit":
        return ("error", f"LLM failed (exit {kv.get('code', '?')}) in stage {kv.get('stage', '?')}", "", "")
    return None


def _interpret_janitor(
    event: str, detail: str, kv: dict[str, str]
) -> tuple[str, str, str, str] | None:
    if event == "daemon.starting":
        return ("info", "Janitor starting", "Starting...", "")
    if event == "sweep.start":
        sid = kv.get("sweep_id", "?")
        fix = kv.get("fix_mode", "false")
        mode = "fix" if fix in ("True", "true") else "scan"
        return ("info", f"Starting {mode} sweep #{sid}", f"Sweep #{sid}", "")
    if event == "sweep.clean":
        return ("success", "Sweep clean \u2014 no issues found", "Idle", "")
    if event == "sweep.complete":
        issues = kv.get("issues", "0")
        fixed = kv.get("fixed", "0")
        deleted = kv.get("deleted", "0")
        msg = f"Sweep done \u2014 {fixed}/{issues} issues fixed"
        if deleted != "0":
            msg += f", {deleted} deleted"
        try:
            if int(issues) > 0 and int(fixed) < int(issues) // 2:
                return ("warning", msg, "Idle", "")
        except ValueError:
            pass
        return ("success", msg, "Idle", "")
    if event == "sweep.agent_failed":
        return ("error", "Agent invocation FAILED", "", "")
    if event == "sweep.pipeline_failed":
        return ("error", "Pipeline invocation FAILED", "", "")
    if event == "sweep.agent_invoke":
        batch = kv.get("batch_issues", kv.get("batch_files", "?"))
        return ("info", f"Agent processing batch ({batch} issues)", "", "")
    if event == "scanner.scan_start":
        total = kv.get("total_files", "?")
        to_scan = kv.get("to_scan", "?")
        return ("info", f"Scanning {to_scan} of {total} files", "Scanning...", "")
    if event == "scanner.scan_complete":
        issues = kv.get("issues", "0")
        return ("info", f"Scan found {issues} issues", "", "")
    if event == "autofix.complete":
        fixed = kv.get("fixed", "0")
        flagged = kv.get("flagged", "0")
        skipped = kv.get("skipped", "0")
        return ("info", f"Autofix \u2014 {fixed} fixed, {flagged} flagged, {skipped} skipped", "", "")
    if event.startswith("autofix.fm") and event.endswith("_fixed"):
        f = kv.get("file", "?")
        short = f.rsplit("/", 1)[-1] if "/" in f else f
        return ("info", f"Fixed {short}", "", "")
    if event.startswith("autofix.fm") and event.endswith("_failed"):
        f = kv.get("file", "?")
        short = f.rsplit("/", 1)[-1] if "/" in f else f
        return ("warning", f"Failed to fix {short}", "", "")
    if event == "pipeline.start":
        issues = kv.get("issues", "?")
        return ("info", f"Pipeline started with {issues} issues", "Stage 1: Autofix", "")
    if event == "pipeline.s1_complete":
        fixed = kv.get("fixed", "0")
        flagged = kv.get("flagged", "0")
        return ("info", f"Stage 1 done \u2014 {fixed} fixed, {flagged} flagged", "Stage 2: Link Repair", "")
    if event == "pipeline.s2_complete":
        repaired = kv.get("repaired", "0")
        return ("info", f"Link repair \u2014 {repaired} links fixed", "Stage 3: Stub Enrichment", "")
    if event == "pipeline.s3_complete":
        enriched = kv.get("enriched", "0")
        return ("info", f"Stub enrichment \u2014 {enriched} records filled", "", "")
    if event == "pipeline.complete":
        fixed = kv.get("fixed", "0")
        links = kv.get("links_repaired", "0")
        stubs = kv.get("stubs_enriched", "0")
        return ("success", f"Pipeline complete \u2014 {fixed} fixed, {links} links, {stubs} stubs", "", "")
    if event == "pipeline.s2_llm_repair":
        f = kv.get("file", "?")
        short = f.rsplit("/", 1)[-1] if "/" in f else f
        return ("info", f"LLM repairing link in {short}", "", "")
    if event == "pipeline.llm_call":
        return ("info", f"LLM call for stage {kv.get('stage', '?')}", "", "")
    if event == "pipeline.llm_timeout":
        return ("error", f"LLM timeout in stage {kv.get('stage', '?')}", "", "")
    if event == "daemon.deep_sweep":
        return ("info", "Starting deep sweep", "Deep sweep", "")
    if event == "daemon.sweep_error":
        return ("error", "Sweep error", "", "")
    return None


def _interpret_distiller(
    event: str, detail: str, kv: dict[str, str]
) -> tuple[str, str, str, str] | None:
    if event == "daemon.starting":
        return ("info", "Distiller starting", "Starting...", "")
    if event == "extraction.start":
        rid = kv.get("run_id", "?")
        return ("info", f"Starting extraction run #{rid}", f"Extraction #{rid}", "")
    if event == "extraction.no_candidates":
        return ("info", "No new candidates to process", "Idle", "")
    if event == "extraction.pipeline_invoke":
        project = kv.get("project", "?")
        sources = kv.get("sources", "?")
        return ("info", f"Analyzing {sources} sources for {project}", f"Analyzing {project}", "")
    if event == "extraction.agent_invoke":
        project = kv.get("project", "?")
        sources = kv.get("sources", "?")
        return ("info", f"Agent processing {sources} sources for {project}", "", "")
    if event == "extraction.pipeline_failed":
        return ("error", "Extraction pipeline FAILED", "", "")
    if event == "extraction.agent_failed":
        return ("error", "Agent invocation FAILED", "", "")
    if event == "extraction.complete":
        created = kv.get("records_created", "0")
        msg = f"Run complete \u2014 {created} records created"
        if created == "0":
            return ("warning", "Run complete but 0 records created", "Idle", "")
        return ("success", msg, "Idle", "")
    if event == "extraction.passb_start":
        return ("info", "Starting meta-analysis pass", "Meta-analysis", "")
    if event == "pipeline.start":
        project = kv.get("project", "?")
        sources = kv.get("sources", "?")
        return ("info", f"Pipeline for {project} ({sources} sources)", "", "")
    if event == "pipeline.s1_complete":
        source = kv.get("source", "?")
        learnings = kv.get("learnings", "0")
        short = source.rsplit("/", 1)[-1] if "/" in source else source
        return ("info", f"Extracted {learnings} learnings from {short}", "", "")
    if event == "pipeline.s1_manifest_file_missing":
        return ("warning", "No manifest from LLM (possible silent fail)", "", "")
    if event == "pipeline.s1_manifest_retry":
        attempt = kv.get("attempt", "?")
        return ("warning", f"Manifest missing, retrying (attempt {attempt})", "", "")
    if event == "pipeline.manifest_parse_failed":
        return ("warning", "Failed to parse LLM manifest", "", "")
    if event == "pipeline.s2_complete":
        candidates = kv.get("candidates", "0")
        after = kv.get("after_dedup", "0")
        merged = kv.get("merged", "0")
        return ("info", f"Dedup \u2014 {candidates} candidates, {after} unique ({merged} merged)", "", "")
    if event == "pipeline.s3_created":
        path = kv.get("path", "?")
        rtype = kv.get("type", "?")
        short = path.rsplit("/", 1)[-1].replace(".md", "") if "/" in path else path
        return ("success", f"Created {rtype}/{short}", "", "")
    if event == "pipeline.s3_no_record_created":
        title = kv.get("title", "?")
        return ("warning", f"No record created for: {title}", "", "")
    if event == "pipeline.passb_complete":
        meta = kv.get("meta_created", "0")
        return ("info", f"Meta-analysis \u2014 {meta} synthesis created", "", "")
    if event == "pipeline.passb_clusters":
        n = kv.get("clusters", "0")
        return ("info", f"Found {n} learning clusters for meta-analysis", "", "")
    if event == "pipeline.llm_call":
        return ("info", f"LLM call for stage {kv.get('stage', '?')}", "", "")
    if event == "pipeline.llm_timeout":
        return ("error", f"LLM timeout in stage {kv.get('stage', '?')}", "", "")
    if event == "daemon.deep_extraction":
        return ("info", "Starting deep extraction", "Deep extraction", "")
    if event == "daemon.light_scan":
        return ("info", "Running light scan", "Light scan", "")
    if event == "daemon.pending_candidates":
        count = kv.get("count", "?")
        return ("info", f"{count} pending candidates", "", "")
    if event == "daemon.extraction_error":
        return ("error", "Extraction error", "", "")
    return None


def _interpret_surveyor(
    event: str, detail: str, kv: dict[str, str]
) -> tuple[str, str, str, str] | None:
    if event == "daemon.starting":
        return ("info", "Surveyor starting", "Starting...", "")
    if event == "daemon.initial_sync_start":
        return ("info", "Starting initial vault sync", "Initial sync", "")
    if event == "daemon.initial_sync_complete":
        files = kv.get("files", "0")
        return ("success", f"Initial sync complete \u2014 {files} files", "Watching vault", "")
    if event == "daemon.processing_diff":
        return ("info", "Processing file changes", "Embedding diff", "")
    if event == "daemon.no_embeddings_to_cluster":
        return ("info", "No embeddings \u2014 waiting for data", "Idle", "")
    if event == "daemon.no_changed_clusters":
        return ("info", "No changed clusters", "Watching vault", "")
    if event == "daemon.labeling_complete":
        n = kv.get("clusters_processed", "0")
        return ("success", f"Labeled {n} clusters", "Watching vault", "")
    if event == "embedder.diff_processed":
        up = kv.get("upserted", "0")
        deleted = kv.get("deleted", "0")
        return ("info", f"Embedded {up} files, removed {deleted}", "", "")
    if event == "embedder.upserted":
        path = kv.get("path", "?")
        short = path.rsplit("/", 1)[-1] if "/" in path else path
        return ("info", f"Embedded {short}", "", "")
    if event == "embedder.embed_failed":
        return ("error", "Embedding FAILED after retries", "", "")
    if event == "embedder.embed_retry":
        attempt = kv.get("attempt", "?")
        return ("warning", f"Embedding retry (attempt {attempt})", "", "")
    if event == "clusterer.complete":
        sem = kv.get("semantic_clusters", "0")
        changed = kv.get("changed_semantic", "0")
        return ("info", f"Found {sem} clusters ({changed} changed)", "", "")
    if event == "clusterer.too_few_files":
        return ("info", "Too few files to cluster", "", "")
    if event == "labeler.usage":
        return None
    if event == "labeler.llm_failed":
        return ("error", "Labeler LLM FAILED after retries", "", "")
    if event == "labeler.llm_error":
        return ("error", f"Labeler LLM error: {kv.get('error', '?')[:60]}", "", "")
    if event == "labeler.rate_limited":
        return ("warning", f"Rate limited, retrying in {kv.get('delay', '?')}s", "", "")
    if event == "writer.tags_written":
        path = kv.get("path", "?")
        tags = kv.get("tags", "?")
        short = path.rsplit("/", 1)[-1].replace(".md", "") if "/" in path else path
        return ("info", f"Tagged {short} with {tags}", "", "")
    if event == "writer.relationships_written":
        path = kv.get("path", "?")
        added = kv.get("added", "0")
        short = path.rsplit("/", 1)[-1].replace(".md", "") if "/" in path else path
        return ("info", f"Added {added} relationships to {short}", "", "")
    if event == "writer.write_error":
        return ("error", f"Write error: {kv.get('path', '?')}", "", "")
    return None


INTERPRETERS: dict[
    str,
    Callable[[str, str, dict[str, str]], tuple[str, str, str, str] | None],
] = {
    "curator": _interpret_curator,
    "janitor": _interpret_janitor,
    "distiller": _interpret_distiller,
    "surveyor": _interpret_surveyor,
}


# ---------------------------------------------------------------------------
# Health-tracking regex helpers (from LogTailThread)
# ---------------------------------------------------------------------------

_STDOUT_LEN_RE = re.compile(r"stdout_len=(\d+)")
_TOTAL_TOKENS_RE = re.compile(r"total_tokens=(\d+)")


def update_health(health: ToolHealth, entry: _LogEntry) -> None:
    """Update health counters from a log entry."""
    if entry.level == "error":
        health.error_count += 1
    elif entry.level == "warning":
        health.warning_count += 1
    if entry.event == "pipeline.llm_call":
        health.llm_calls += 1
    elif entry.event == "pipeline.llm_completed":
        m = _STDOUT_LEN_RE.search(entry.detail)
        if m:
            health.stdout_chars += int(m.group(1))
    elif entry.event == "labeler.usage":
        health.llm_calls += 1
        m = _TOTAL_TOKENS_RE.search(entry.detail)
        if m:
            health.tokens += int(m.group(1))


def interpret_and_feed(
    tool: str,
    entry: _LogEntry,
    feed: WorkerFeed,
    health: ToolHealth,
    worker: WorkerInfo | None = None,
) -> FeedEntry | None:
    """Interpret a log entry and update the feed. Returns the new FeedEntry or None."""
    interpreter = INTERPRETERS.get(tool)
    if interpreter is None:
        return None

    kv = _parse_kv(entry.detail)
    result = interpreter(entry.event, entry.detail, kv)
    if result is None:
        return None

    severity, message, step, file_ = result

    fe = FeedEntry(
        timestamp=entry.timestamp,
        severity=severity,
        message=message,
        tool=tool,
    )
    feed.entries.appendleft(fe)

    if step:
        feed.current_step = step
    if file_:
        feed.current_file = file_

    if severity == "error":
        feed.errors += 1
    elif severity == "warning":
        feed.warnings += 1

    # Sync LLM counters
    feed.llm_calls = health.llm_calls
    feed.stdout_chars = health.stdout_chars
    feed.tokens = health.tokens

    # Update feed health
    if worker and worker.status in ("stopped", "restarting"):
        feed.health = worker.status
    elif feed.errors >= 5:
        feed.health = "failing"
    elif feed.errors > 0:
        feed.health = "degraded"
    elif step and step not in ("Idle", "Watching inbox...", "Watching vault"):
        feed.health = "working"
    else:
        feed.health = "idle"

    return fe


# ---------------------------------------------------------------------------
# Audit log parser
# ---------------------------------------------------------------------------


def parse_audit_line(line: str) -> MutationEntry | None:
    """Parse a single JSONL audit log line into a MutationEntry."""
    line = line.strip()
    if not line:
        return None
    try:
        entry = json.loads(line)
    except json.JSONDecodeError:
        return None
    ts_raw = entry.get("ts", "")
    ts = ts_raw
    if "T" in ts_raw:
        ts = ts_raw.split("T", 1)[1][:8]
    return MutationEntry(
        timestamp=ts,
        tool=entry.get("tool", "?"),
        op=entry.get("op", "?"),
        path=entry.get("path", ""),
    )


# ---------------------------------------------------------------------------
# State JSON readers
# ---------------------------------------------------------------------------


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def read_stats(state_dir: Path) -> ToolStats:
    """Read all tool state JSON files and return aggregated stats."""
    s = ToolStats()

    data = _load_json(state_dir / "curator_state.json")
    if data:
        s.curator_processed = len(data.get("processed", {}))
        s.curator_last_run = data.get("last_run", "") or ""

    data = _load_json(state_dir / "janitor_state.json")
    if data:
        files = data.get("files", {})
        s.janitor_tracked = len(files)
        s.janitor_issues = sum(
            1
            for f in files.values()
            if isinstance(f, dict) and f.get("open_issues")
        )
        s.janitor_sweeps = len(data.get("sweeps", []))

    data = _load_json(state_dir / "distiller_state.json")
    if data:
        files = data.get("files", {})
        s.distiller_sources = len(files)
        s.distiller_learnings = sum(
            len(f.get("learn_records_created", []))
            for f in files.values()
            if isinstance(f, dict)
        )
        s.distiller_runs = len(data.get("runs", []))

    data = _load_json(state_dir / "surveyor_state.json")
    if data:
        s.surveyor_tracked = len(data.get("files", {}))
        s.surveyor_clusters = len(data.get("clusters", {}))
        s.surveyor_last_run = data.get("last_run", "") or ""

    return s


# ---------------------------------------------------------------------------
# Display helpers
# ---------------------------------------------------------------------------

TOOL_COLORS: dict[str, str] = {
    "curator": "cyan",
    "janitor": "yellow",
    "distiller": "magenta",
    "surveyor": "green",
}

SEVERITY_STYLES: dict[str, str] = {
    "info": "dim",
    "success": "green",
    "warning": "yellow",
    "error": "bold red",
}

HEALTH_DISPLAY: dict[str, tuple[str, str]] = {
    "idle": ("\u25cb idle", "dim"),
    "working": ("\u25cf working", "bold cyan"),
    "degraded": ("\u25d0 degraded", "yellow"),
    "failing": ("\u26a0 failing", "bold red"),
    "stopped": ("\u25cf stopped", "bold red"),
    "restarting": ("\u25cf restarting", "bold yellow"),
    "pending": ("\u25cb pending", "dim"),
}


def compute_feed_health(w: WorkerInfo, feed: WorkerFeed) -> str:
    if w.status == "stopped":
        return "stopped"
    if w.status == "restarting":
        return "restarting"
    if w.status != "running":
        return "pending"
    if feed.errors >= 5:
        return "failing"
    if feed.errors > 0:
        return "degraded"
    return feed.health


def format_llm_usage(tool: str, feed: WorkerFeed) -> str:
    if feed.llm_calls == 0:
        return ""
    if tool == "surveyor" and feed.tokens > 0:
        return f"{feed.llm_calls} calls  {feed.tokens // 1000}k tokens"
    if feed.stdout_chars > 0:
        return f"{feed.llm_calls} calls  {feed.stdout_chars // 1000}k chars"
    return f"{feed.llm_calls} calls"


def short_ago(iso_ts: str) -> str:
    """Convert an ISO timestamp to a short 'Xm ago' string."""
    if not iso_ts:
        return "never"
    try:
        from datetime import datetime, timezone

        dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - dt
        secs = int(delta.total_seconds())
        if secs < 60:
            return f"{secs}s ago"
        elif secs < 3600:
            return f"{secs // 60}m ago"
        else:
            return f"{secs // 3600}h ago"
    except (ValueError, TypeError):
        return iso_ts[:19]
