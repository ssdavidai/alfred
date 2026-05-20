"""Stage 1: watchdog filesystem watcher + debounce + full_scan."""

from __future__ import annotations

import time
from pathlib import Path, PurePosixPath

import structlog
from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from .config import VaultConfig, WatcherConfig
from .utils import compute_md5

log = structlog.get_logger()


class _VaultEventHandler(FileSystemEventHandler):
    """Collect .md file events with timestamps for debouncing."""

    def __init__(self, vault_path: Path, ignore_dirs: set[str], ignore_files: set[str]) -> None:
        self.vault_path = vault_path
        self.ignore_dirs = ignore_dirs
        self.ignore_files = ignore_files
        self.touched: dict[str, float] = {}  # rel_path -> last_event_time

    def _rel_path(self, abs_path: str) -> str | None:
        """Convert absolute path to vault-relative path (forward slashes). Returns None if should ignore."""
        try:
            rel = Path(abs_path).resolve().relative_to(self.vault_path.resolve())
        except ValueError:
            return None
        rel_str = str(PurePosixPath(rel))
        return rel_str

    def _should_ignore(self, rel_path: str) -> bool:
        parts = rel_path.split("/")
        # Check ignore_dirs
        for part in parts[:-1]:
            if part in self.ignore_dirs:
                return True
        # Check ignore_files
        if parts[-1] in self.ignore_files:
            return True
        # Only .md files
        if not rel_path.endswith(".md"):
            return True
        return False

    def on_any_event(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        src = event.src_path
        rel = self._rel_path(src)
        if rel is None or self._should_ignore(rel):
            return
        self.touched[rel] = time.monotonic()

    def collect_debounced(self, debounce_seconds: float) -> list[str]:
        """Return paths that have been quiet for longer than debounce_seconds."""
        now = time.monotonic()
        ready = [
            path for path, ts in self.touched.items()
            if (now - ts) >= debounce_seconds
        ]
        for path in ready:
            del self.touched[path]
        return ready


class VaultWatcher:
    """Watches the vault directory for .md file changes."""

    def __init__(self, vault_cfg: VaultConfig, watcher_cfg: WatcherConfig) -> None:
        self.vault_path = vault_cfg.path.resolve()
        self.debounce_seconds = watcher_cfg.debounce_seconds
        self.ignore_dirs = set(vault_cfg.ignore_dirs)
        self.ignore_files = set(vault_cfg.ignore_files)

        self._handler = _VaultEventHandler(self.vault_path, self.ignore_dirs, self.ignore_files)
        self._observer = Observer()

    def start(self) -> None:
        """Start watching the vault directory."""
        self._observer.schedule(self._handler, str(self.vault_path), recursive=True)
        self._observer.start()
        log.info("watcher.started", path=str(self.vault_path))

    def stop(self) -> None:
        """Stop the watcher."""
        self._observer.stop()
        self._observer.join(timeout=5)
        log.info("watcher.stopped")

    def collect_debounced(self) -> list[str]:
        """Return paths that have been quiet long enough."""
        return self._handler.collect_debounced(self.debounce_seconds)

    def full_scan(self) -> dict[str, str]:
        """Walk all eligible .md files and return {rel_path: md5}."""
        hashes: dict[str, str] = {}
        for md_file in self.vault_path.rglob("*.md"):
            try:
                rel = md_file.resolve().relative_to(self.vault_path.resolve())
            except ValueError:
                continue
            rel_str = str(PurePosixPath(rel))
            if self._handler._should_ignore(rel_str):
                continue
            try:
                hashes[rel_str] = compute_md5(md_file)
            except OSError:
                log.warning("watcher.hash_error", path=rel_str)
        log.info("watcher.full_scan_complete", files=len(hashes))
        return hashes
