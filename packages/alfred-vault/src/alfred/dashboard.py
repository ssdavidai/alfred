"""Live TUI dashboard for ``alfred up --live``."""

from __future__ import annotations

import json
import re
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from rich.layout import Layout
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class WorkerInfo:
    name: str
    status: str = "pending"     # pending | running | stopped | restarting
    pid: int | None = None
    restart_count: int = 0
    exit_code: int | None = None
    last_death: float = 0.0     # monotonic time of last crash detection


@dataclass
class FeedEntry:
    timestamp: str
    severity: str           # "info" | "success" | "warning" | "error"
    message: str            # Human-readable interpretation


@dataclass
class WorkerFeed:
    entries: deque[FeedEntry] = field(default_factory=lambda: deque(maxlen=50))
    current_step: str = ""
    current_file: str = ""
    health: str = "idle"        # idle | working | degraded | failing | stopped
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
    stdout_chars: int = 0    # proxy for tokens on CLI backends
    tokens: int = 0          # actual tokens (surveyor only, from labeler.usage)


@dataclass
class DashboardData:
    workers: dict[str, WorkerInfo] = field(default_factory=dict)
    feeds: dict[str, WorkerFeed] = field(default_factory=dict)
    mutations: deque[MutationEntry] = field(default_factory=lambda: deque(maxlen=50))
    stats: ToolStats = field(default_factory=ToolStats)
    health: dict[str, ToolHealth] = field(default_factory=dict)
    start_time: float = field(default_factory=time.time)
    lock: threading.Lock = field(default_factory=threading.Lock)


# ---------------------------------------------------------------------------
# ANSI stripping
# ---------------------------------------------------------------------------

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")

def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


# ---------------------------------------------------------------------------
# Log line parser — structlog ConsoleRenderer format
# ---------------------------------------------------------------------------

# Internal entry used only for parsing; not stored in DashboardData
@dataclass
class _LogEntry:
    timestamp: str
    tool: str
    level: str
    event: str
    detail: str = ""


# Example: "2024-06-01T15:05:32 [info     ] daemon.starting        tool=curator"
_LOG_RE = re.compile(
    r"^(\S+)\s+"           # timestamp (ISO or HH:MM:SS)
    r"\[(\w+)\s*\]\s+"     # [level]
    r"(\S+)"               # event name
    r"(.*)$"               # rest (detail)
)


def _parse_log_line(line: str, tool: str) -> _LogEntry | None:
    line = _strip_ansi(line).strip()
    if not line:
        return None
    m = _LOG_RE.match(line)
    if not m:
        return None
    ts_raw, level, event, detail = m.groups()
    # Extract just HH:MM:SS from the timestamp
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

def _interpret_curator(event: str, detail: str, kv: dict[str, str]) -> tuple[str, str, str, str] | None:
    """Return (severity, message, current_step, current_file) or None.

    current_step/current_file are empty string if unchanged.
    """
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

    # Pipeline stages
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
            return ("warning", f"Stage 1 done but found 0 entities", "Stage 2: Entity Resolution", "")
        return ("info", msg, "Stage 2: Entity Resolution", "")
    if event == "pipeline.s1_failed":
        return ("error", "Stage 1 FAILED \u2014 LLM produced no output", "", "")
    if event == "pipeline.s1_no_note_created":
        return ("warning", "Stage 1 \u2014 no note created (silent fail?)", "", "")
    if event == "pipeline.manifest_parse_failed":
        return ("warning", "Failed to parse LLM manifest", "", "")

    if event == "pipeline.s2_entity_created":
        entity = kv.get("entity", "?")
        path = kv.get("path", "")
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

    # LLM calls
    if event == "pipeline.llm_call":
        stage = kv.get("stage", "?")
        return ("info", f"LLM call for stage {stage}", "", "")
    if event == "pipeline.llm_timeout":
        return ("error", f"LLM timeout in stage {kv.get('stage', '?')}", "", "")
    if event == "pipeline.llm_nonzero_exit":
        return ("error", f"LLM failed (exit {kv.get('code', '?')}) in stage {kv.get('stage', '?')}", "", "")

    return None


def _interpret_janitor(event: str, detail: str, kv: dict[str, str]) -> tuple[str, str, str, str] | None:
    if event == "daemon.starting":
        return ("info", "Janitor starting", "Starting...", "")

    if event == "sweep.start":
        sid = kv.get("sweep_id", "?")
        fix = kv.get("fix_mode", "false")
        mode = "fix" if fix == "True" or fix == "true" else "scan"
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
        # Flag if fix rate is poor
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

    # Pipeline stages
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


def _interpret_distiller(event: str, detail: str, kv: dict[str, str]) -> tuple[str, str, str, str] | None:
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

    # Pipeline stages
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


def _interpret_surveyor(event: str, detail: str, kv: dict[str, str]) -> tuple[str, str, str, str] | None:
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

    # Embedder
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

    # Clusterer
    if event == "clusterer.complete":
        sem = kv.get("semantic_clusters", "0")
        changed = kv.get("changed_semantic", "0")
        return ("info", f"Found {sem} clusters ({changed} changed)", "", "")
    if event == "clusterer.too_few_files":
        return ("info", "Too few files to cluster", "", "")

    # Labeler
    if event == "labeler.usage":
        return None  # tracked by health counters, not shown in feed
    if event == "labeler.llm_failed":
        return ("error", "Labeler LLM FAILED after retries", "", "")
    if event == "labeler.llm_error":
        return ("error", f"Labeler LLM error: {kv.get('error', '?')[:60]}", "", "")
    if event == "labeler.rate_limited":
        return ("warning", f"Rate limited, retrying in {kv.get('delay', '?')}s", "", "")

    # Writer
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


_INTERPRETERS: dict[str, Callable[[str, str, dict[str, str]], tuple[str, str, str, str] | None]] = {
    "curator": _interpret_curator,
    "janitor": _interpret_janitor,
    "distiller": _interpret_distiller,
    "surveyor": _interpret_surveyor,
}


# ---------------------------------------------------------------------------
# Background threads
# ---------------------------------------------------------------------------

_STDOUT_LEN_RE = re.compile(r"stdout_len=(\d+)")
_TOTAL_TOKENS_RE = re.compile(r"total_tokens=(\d+)")


class LogTailThread(threading.Thread):
    """Tails data/{tool}.log files and feeds parsed entries into DashboardData."""

    def __init__(self, data: DashboardData, log_dir: Path, tools: list[str]):
        super().__init__(daemon=True)
        self._data = data
        self._log_dir = log_dir
        self._tools = tools
        self._positions: dict[str, int] = {}  # tool -> file offset
        self._stop = threading.Event()
        self._initial_done = False  # set after first full cycle

    def run(self) -> None:
        first_cycle = True
        while not self._stop.is_set():
            for tool in self._tools:
                path = self._log_dir / f"{tool}.log"
                if not path.exists():
                    continue
                try:
                    size = path.stat().st_size
                    pos = self._positions.get(tool, 0)
                    # Handle file truncation (log rotation)
                    if size < pos:
                        pos = 0
                    if size == pos:
                        continue
                    with open(path, "r", encoding="utf-8", errors="replace") as f:
                        f.seek(pos)
                        new_text = f.read()
                        self._positions[tool] = f.tell()
                    for line in new_text.splitlines():
                        entry = _parse_log_line(line, tool)
                        if entry:
                            with self._data.lock:
                                if self._initial_done:
                                    self._update_health(tool, entry)
                                    self._update_feed(tool, entry)
                except OSError:
                    continue
            if first_cycle:
                self._initial_done = True
                first_cycle = False
            self._stop.wait(0.5)

    def _update_health(self, tool: str, entry: _LogEntry) -> None:
        """Update health counters for a tool. Caller holds data.lock."""
        h = self._data.health.get(tool)
        if h is None:
            return
        if entry.level == "error":
            h.error_count += 1
        elif entry.level == "warning":
            h.warning_count += 1
        if entry.event == "pipeline.llm_call":
            h.llm_calls += 1
        elif entry.event == "pipeline.llm_completed":
            m = _STDOUT_LEN_RE.search(entry.detail)
            if m:
                h.stdout_chars += int(m.group(1))
        elif entry.event == "labeler.usage":
            h.llm_calls += 1
            m = _TOTAL_TOKENS_RE.search(entry.detail)
            if m:
                h.tokens += int(m.group(1))

    def _update_feed(self, tool: str, entry: _LogEntry) -> None:
        """Interpret a log event and add to the tool's feed. Caller holds data.lock."""
        feed = self._data.feeds.get(tool)
        if feed is None:
            return

        interpreter = _INTERPRETERS.get(tool)
        if interpreter is None:
            return

        kv = _parse_kv(entry.detail)
        result = interpreter(entry.event, entry.detail, kv)
        if result is None:
            return

        severity, message, step, file_ = result

        feed.entries.appendleft(FeedEntry(
            timestamp=entry.timestamp,
            severity=severity,
            message=message,
        ))

        if step:
            feed.current_step = step
        if file_:
            feed.current_file = file_

        # Update feed-level counters
        if severity == "error":
            feed.errors += 1
        elif severity == "warning":
            feed.warnings += 1

        # Sync LLM counters from health into feed
        h = self._data.health.get(tool)
        if h:
            feed.llm_calls = h.llm_calls
            feed.stdout_chars = h.stdout_chars
            feed.tokens = h.tokens

        # Update feed health based on worker status + error counts
        w = self._data.workers.get(tool)
        if w and w.status in ("stopped", "restarting"):
            feed.health = w.status
        elif feed.errors >= 5:
            feed.health = "failing"
        elif feed.errors > 0:
            feed.health = "degraded"
        elif step and step not in ("Idle", "Watching inbox...", "Watching vault"):
            feed.health = "working"
        else:
            feed.health = "idle"

    def stop(self) -> None:
        self._stop.set()


class AuditTailThread(threading.Thread):
    """Tails data/vault_audit.log and feeds MutationEntry into DashboardData."""

    def __init__(self, data: DashboardData, audit_path: Path):
        super().__init__(daemon=True)
        self._data = data
        self._audit_path = audit_path
        self._position: int = 0
        self._stop = threading.Event()

    def run(self) -> None:
        while not self._stop.is_set():
            if self._audit_path.exists():
                try:
                    size = self._audit_path.stat().st_size
                    if size < self._position:
                        self._position = 0
                    if size > self._position:
                        with open(self._audit_path, "r", encoding="utf-8", errors="replace") as f:
                            f.seek(self._position)
                            new_text = f.read()
                            self._position = f.tell()
                        for line in new_text.splitlines():
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                entry = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            ts_raw = entry.get("ts", "")
                            ts = ts_raw
                            if "T" in ts_raw:
                                ts = ts_raw.split("T", 1)[1][:8]
                            me = MutationEntry(
                                timestamp=ts,
                                tool=entry.get("tool", "?"),
                                op=entry.get("op", "?"),
                                path=entry.get("path", ""),
                            )
                            with self._data.lock:
                                self._data.mutations.appendleft(me)
                except OSError:
                    pass
            self._stop.wait(2.0)

    def stop(self) -> None:
        self._stop.set()


class StatReaderThread(threading.Thread):
    """Reads data/*_state.json periodically and updates ToolStats."""

    def __init__(self, data: DashboardData, state_dir: Path):
        super().__init__(daemon=True)
        self._data = data
        self._state_dir = state_dir
        self._stop = threading.Event()

    def run(self) -> None:
        while not self._stop.is_set():
            self._read_all()
            self._stop.wait(10.0)

    def _read_all(self) -> None:
        s = self._data.stats

        # Curator state
        self._read_curator(s)
        self._read_janitor(s)
        self._read_distiller(s)
        self._read_surveyor(s)

    def _load_json(self, name: str) -> dict[str, Any] | None:
        path = self._state_dir / name
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

    def _read_curator(self, s: ToolStats) -> None:
        data = self._load_json("curator_state.json")
        if not data:
            return
        with self._data.lock:
            processed = data.get("processed", {})
            s.curator_processed = len(processed)
            s.curator_last_run = data.get("last_run", "") or ""

    def _read_janitor(self, s: ToolStats) -> None:
        data = self._load_json("janitor_state.json")
        if not data:
            return
        with self._data.lock:
            files = data.get("files", {})
            s.janitor_tracked = len(files)
            s.janitor_issues = sum(
                1 for f in files.values()
                if isinstance(f, dict) and f.get("open_issues")
            )
            s.janitor_sweeps = len(data.get("sweeps", []))

    def _read_distiller(self, s: ToolStats) -> None:
        data = self._load_json("distiller_state.json")
        if not data:
            return
        with self._data.lock:
            files = data.get("files", {})
            s.distiller_sources = len(files)
            s.distiller_learnings = sum(
                len(f.get("learn_records_created", []))
                for f in files.values()
                if isinstance(f, dict)
            )
            s.distiller_runs = len(data.get("runs", []))

    def _read_surveyor(self, s: ToolStats) -> None:
        data = self._load_json("surveyor_state.json")
        if not data:
            return
        with self._data.lock:
            s.surveyor_tracked = len(data.get("files", {}))
            s.surveyor_clusters = len(data.get("clusters", {}))
            s.surveyor_last_run = data.get("last_run", "") or ""

    def stop(self) -> None:
        self._stop.set()


# ---------------------------------------------------------------------------
# Renderers
# ---------------------------------------------------------------------------

TOOL_COLORS = {
    "curator": "cyan",
    "janitor": "yellow",
    "distiller": "magenta",
    "surveyor": "green",
}

_SEVERITY_STYLES = {
    "info": "dim",
    "success": "green",
    "warning": "yellow",
    "error": "bold red",
}

_HEALTH_DISPLAY: dict[str, tuple[str, str]] = {
    "idle":       ("\u25cb idle",       "dim"),           # ○
    "working":    ("\u25cf working",    "bold cyan"),     # ●
    "degraded":   ("\u25d0 degraded",   "yellow"),        # ◐
    "failing":    ("\u26a0 failing",    "bold red"),      # ⚠
    "stopped":    ("\u25cf stopped",    "bold red"),      # ●
    "restarting": ("\u25cf restarting", "bold yellow"),   # ●
    "pending":    ("\u25cb pending",    "dim"),           # ○
}


def _compute_feed_health(w: WorkerInfo, feed: WorkerFeed) -> str:
    """Derive the display health from worker status and feed counters."""
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
    return feed.health  # idle or working, set by interpreter


def _format_llm_usage(tool: str, feed: WorkerFeed) -> str:
    """Format LLM usage string for a tool."""
    if feed.llm_calls == 0:
        return ""
    if tool == "surveyor" and feed.tokens > 0:
        return f"{feed.llm_calls} calls  {feed.tokens // 1000}k tokens"
    if feed.stdout_chars > 0:
        return f"{feed.llm_calls} calls  {feed.stdout_chars // 1000}k chars"
    return f"{feed.llm_calls} calls"


def render_worker_panel(
    tool: str,
    data: DashboardData,
    max_feed_lines: int = 20,
) -> Panel:
    """Render a single worker's feed panel."""
    color = TOOL_COLORS.get(tool, "white")
    text = Text()

    with data.lock:
        w = data.workers.get(tool)
        feed = data.feeds.get(tool, WorkerFeed())
        h = data.health.get(tool, ToolHealth())

        # Derive health
        if w:
            health = _compute_feed_health(w, feed)
            pid = w.pid
        else:
            health = "pending"
            pid = None

        health_label, health_style = _HEALTH_DISPLAY.get(health, ("\u25cb ?", "dim"))
        pid_str = f"pid {pid}" if pid else ""

        # Build title: "Curator — ✓ healthy — pid 1234"
        title_parts = [tool.capitalize()]
        title_parts.append(health_label)
        if pid_str:
            title_parts.append(pid_str)
        title = " \u2014 ".join(title_parts)

        # Current step line (bold)
        step = feed.current_step or ("Watching inbox..." if tool == "curator" else "Idle")
        text.append(step, style=f"bold {color}")
        text.append("\n")

        # Feed entries
        entries = list(feed.entries)[:max_feed_lines]
        if entries:
            text.append("\n")
            for i, e in enumerate(entries):
                if i > 0:
                    text.append("\n")
                style = _SEVERITY_STYLES.get(e.severity, "dim")
                text.append(f"{e.timestamp}  ", style="dim")
                if e.severity == "warning":
                    text.append("\u26a0 ", style="yellow")
                elif e.severity == "error":
                    text.append("\u2716 ", style="bold red")
                elif e.severity == "success":
                    text.append("\u2713 ", style="green")
                text.append(e.message, style=style)
        else:
            text.append("Waiting for activity...", style="dim italic")

        # LLM usage footer
        usage = _format_llm_usage(tool, feed)
        if usage:
            text.append("\n")
            text.append(f"\n{usage}", style="dim")

    return Panel(
        text,
        title=title,
        border_style=color,
        title_align="left",
    )


def render_footer(data: DashboardData) -> Text:
    elapsed = time.time() - data.start_time
    mins, secs = divmod(int(elapsed), 60)
    hours, mins = divmod(mins, 60)
    if hours:
        uptime = f"{hours}h {mins:02d}m {secs:02d}s"
    else:
        uptime = f"{mins}m {secs:02d}s"

    with data.lock:
        active = sum(1 for w in data.workers.values() if w.status == "running")
        total = len(data.workers)
        total_errors = sum(f.errors for f in data.feeds.values())
        total_warnings = sum(f.warnings for f in data.feeds.values())

        # Last 3 mutations for footer strip
        recent_muts = list(data.mutations)[:3]

    footer = Text()
    footer.append(f" Uptime: {uptime}", style="bold")
    footer.append(f"  |  {active}/{total} workers", style="bold")

    if total_errors > 0:
        footer.append(f"  |  {total_errors} errors", style="bold red")
    if total_warnings > 0:
        footer.append(f"  {total_warnings} warnings", style="yellow")
    if total_errors == 0 and total_warnings == 0:
        footer.append("  |  no errors", style="dim")

    # Recent mutations
    if recent_muts:
        op_sym = {"create": "+", "modify": "~", "delete": "-"}
        op_sty = {"create": "green", "modify": "yellow", "delete": "red"}
        footer.append("  |  ")
        for i, m in enumerate(recent_muts):
            if i > 0:
                footer.append("  ")
            sym = op_sym.get(m.op, "?")
            sty = op_sty.get(m.op, "white")
            footer.append(f"{sym}", style=f"bold {sty}")
            short = m.path.rsplit("/", 1)[-1] if "/" in m.path else m.path
            footer.append(f"{short}", style=sty)

    footer.append("  |  Ctrl+C to stop", style="dim")
    return footer


def _short_ago(iso_ts: str) -> str:
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


def build_layout(data: DashboardData, tools: list[str]) -> Layout:
    layout = Layout(name="root")

    n = len(tools)
    if n == 0:
        layout.update(Text("No workers configured", style="dim"))
        return layout

    if n == 1:
        layout.split_column(
            Layout(name="grid"),
            Layout(name="footer", size=1),
        )
        layout["grid"].update(render_worker_panel(tools[0], data))
    elif n == 2:
        layout.split_column(
            Layout(name="grid"),
            Layout(name="footer", size=1),
        )
        layout["grid"].split_row(
            Layout(render_worker_panel(tools[0], data), name="left"),
            Layout(render_worker_panel(tools[1], data), name="right"),
        )
    elif n == 3:
        layout.split_column(
            Layout(name="top"),
            Layout(name="bottom"),
            Layout(name="footer", size=1),
        )
        layout["top"].split_row(
            Layout(render_worker_panel(tools[0], data), name="tl"),
            Layout(render_worker_panel(tools[1], data), name="tr"),
        )
        layout["bottom"].update(render_worker_panel(tools[2], data))
    else:
        # 4+ tools: 2x2 grid (use first 4)
        display_tools = tools[:4]
        layout.split_column(
            Layout(name="top"),
            Layout(name="bottom"),
            Layout(name="footer", size=1),
        )
        layout["top"].split_row(
            Layout(render_worker_panel(display_tools[0], data), name="tl"),
            Layout(render_worker_panel(display_tools[1], data), name="tr"),
        )
        layout["bottom"].split_row(
            Layout(render_worker_panel(display_tools[2], data), name="bl"),
            Layout(render_worker_panel(display_tools[3], data), name="br"),
        )

    layout["footer"].update(render_footer(data))
    return layout


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_live_dashboard(
    tools: list[str],
    processes: dict[str, Any],          # multiprocessing.Process objects
    restart_counts: dict[str, int],
    start_process: Callable[[str], Any],
    sentinel_path: Path | None,
    log_dir: Path,
    state_dir: Path,
    max_restarts: int = 5,
    missing_deps_exit: int = 78,
) -> None:
    """Run the Rich Live dashboard until Ctrl+C or sentinel file."""
    import multiprocessing  # noqa: for type hints in this scope

    data = DashboardData()
    data.start_time = time.time()

    # Initialize worker info, health, and feeds
    for tool in tools:
        p = processes.get(tool)
        data.workers[tool] = WorkerInfo(
            name=tool,
            status="running" if (p and p.is_alive()) else "pending",
            pid=p.pid if p else None,
            restart_count=restart_counts.get(tool, 0),
        )
        data.health[tool] = ToolHealth()
        data.feeds[tool] = WorkerFeed()

    # Start background threads
    log_tail = LogTailThread(data, log_dir, tools)
    audit_tail = AuditTailThread(data, log_dir / "vault_audit.log")
    stat_reader = StatReaderThread(data, state_dir)
    log_tail.start()
    audit_tail.start()
    stat_reader.start()

    active_tools = list(tools)

    try:
        with Live(build_layout(data, active_tools), screen=True, refresh_per_second=4) as live:
            while True:
                # Check sentinel file (alfred down)
                if sentinel_path and sentinel_path.exists():
                    break

                # Update worker health
                now = time.monotonic()
                with data.lock:
                    for tool in list(active_tools):
                        p = processes.get(tool)
                        if not p:
                            continue
                        w = data.workers[tool]
                        if p.is_alive():
                            w.status = "running"
                            w.pid = p.pid
                        elif w.status != "restarting":
                            # First detection of death — record time, don't restart yet
                            exit_code = p.exitcode
                            w.exit_code = exit_code
                            w.pid = None

                            if exit_code == missing_deps_exit:
                                w.status = "stopped"
                                active_tools = [t for t in active_tools if t != tool]
                                continue

                            w.last_death = now
                            restart_counts[tool] = restart_counts.get(tool, 0) + 1
                            w.restart_count = restart_counts[tool]

                            if restart_counts[tool] <= max_restarts:
                                w.status = "restarting"
                            else:
                                w.status = "stopped"

                # Restart dead workers after cooldown (outside the lock)
                restart_cooldown = 5.0  # seconds — matches original monitor loop
                for tool in list(active_tools):
                    w = data.workers.get(tool)
                    if w and w.status == "restarting" and (now - w.last_death) >= restart_cooldown:
                        new_p = start_process(tool)
                        processes[tool] = new_p
                        with data.lock:
                            w.status = "running"
                            w.pid = new_p.pid

                live.update(build_layout(data, active_tools))
                time.sleep(0.25)

    except KeyboardInterrupt:
        pass
    finally:
        log_tail.stop()
        audit_tail.stop()
        stat_reader.stop()
