"""Watch inbox/ for new files with debounce."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

import frontmatter
from watchdog.events import FileCreatedEvent, FileModifiedEvent, FileSystemEventHandler
from watchdog.observers import Observer

from .utils import get_logger

log = get_logger(__name__)


class InboxHandler(FileSystemEventHandler):
    """Collect file events from inbox/ with debounce."""

    def __init__(self, debounce_seconds: float = 10.0) -> None:
        super().__init__()
        self.debounce_seconds = debounce_seconds
        self._pending: dict[str, float] = {}  # path -> last_event_time
        self._lock = asyncio.Lock() if False else None  # use threading lock for watchdog
        import threading
        self._lock = threading.Lock()

    def on_created(self, event: FileCreatedEvent) -> None:
        self._handle(event.src_path)

    def on_modified(self, event: FileModifiedEvent) -> None:
        self._handle(event.src_path)

    def _handle(self, src_path: str) -> None:
        path = Path(src_path)
        # Skip directories, processed/ subdirectory, and dotfiles
        if path.is_dir():
            return
        if "processed" in path.parts:
            return
        if path.name.startswith("."):
            return
        with self._lock:
            self._pending[str(path)] = time.time()
            log.debug("watcher.event", path=str(path))

    def collect_ready(self) -> list[Path]:
        """Return paths that have been stable past the debounce window."""
        now = time.time()
        ready: list[Path] = []
        with self._lock:
            still_pending: dict[str, float] = {}
            for path_str, last_time in self._pending.items():
                if now - last_time >= self.debounce_seconds:
                    ready.append(Path(path_str))
                else:
                    still_pending[path_str] = last_time
            self._pending = still_pending
        return ready


class InboxWatcher:
    """Manages the watchdog observer for the inbox directory."""

    def __init__(self, inbox_path: Path, debounce_seconds: float = 10.0) -> None:
        self.inbox_path = inbox_path
        self.handler = InboxHandler(debounce_seconds=debounce_seconds)
        self._observer: Observer | None = None

    def start(self) -> None:
        self.inbox_path.mkdir(parents=True, exist_ok=True)
        self._observer = Observer()
        self._observer.schedule(self.handler, str(self.inbox_path), recursive=False)
        self._observer.daemon = True
        self._observer.start()
        log.info("watcher.started", path=str(self.inbox_path))

    def stop(self) -> None:
        if self._observer:
            self._observer.stop()
            self._observer.join(timeout=5)
            log.info("watcher.stopped")

    def collect_ready(self) -> list[Path]:
        return self.handler.collect_ready()

    def full_scan(self, state_processed: set[str] | None = None) -> list[Path]:
        """Scan inbox for unprocessed files (startup catch-up).

        Note: state_processed is intentionally NOT used to skip files.
        A file re-uploaded with the same name should be reprocessed.
        Properly processed files are moved to processed/ and won't appear here.
        """
        unprocessed: list[Path] = []

        _skip_names = {".DS_Store", ".gitkeep", "Thumbs.db", ".gitignore"}
        for md_file in self.inbox_path.iterdir():
            if not md_file.is_file():
                continue
            if md_file.name.startswith(".") or md_file.name in _skip_names:
                continue
            # Check frontmatter status (handles edge case where move failed)
            try:
                post = frontmatter.load(str(md_file))
                if post.metadata.get("status") == "processed":
                    continue
            except Exception:
                pass
            unprocessed.append(md_file)

        log.info("watcher.full_scan", found=len(unprocessed))
        return unprocessed
