"""Entry point — asyncio.run + signal handling."""

from __future__ import annotations

import asyncio
import os
import signal
import sys
from pathlib import Path

from .config import load_config
from .daemon import Daemon
from .utils import setup_logging


def _load_env_file(env_path: Path | None = None) -> None:
    """Load a .env file into os.environ (without overriding existing vars)."""
    if env_path is None:
        env_path = Path(".env")
    if not env_path.is_file():
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                value = value[1:-1]
            if key not in os.environ:
                os.environ[key] = value


def main() -> None:
    _load_env_file()

    config_path = Path(__file__).resolve().parent.parent.parent / "config.yaml"
    if len(sys.argv) > 1:
        config_path = Path(sys.argv[1])

    cfg = load_config(config_path)
    setup_logging(level=cfg.logging.level, log_file=cfg.logging.file)

    daemon = Daemon(cfg)

    loop = asyncio.new_event_loop()

    def _shutdown(sig: signal.Signals) -> None:
        daemon.request_shutdown()

    if sys.platform != "win32":
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, _shutdown, sig)
    else:
        # On Windows, use signal.signal for SIGINT (Ctrl+C)
        signal.signal(signal.SIGINT, lambda s, f: _shutdown(s))

    try:
        loop.run_until_complete(daemon.run())
    except KeyboardInterrupt:
        daemon.request_shutdown()
        loop.run_until_complete(daemon.shutdown())
    finally:
        loop.close()


if __name__ == "__main__":
    main()
