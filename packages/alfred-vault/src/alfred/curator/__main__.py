"""Entry point: python -m curator"""

from __future__ import annotations

import asyncio
import signal
import sys
from pathlib import Path

from .config import load_config
from .daemon import run
from .utils import setup_logging, get_logger


def main() -> None:
    config_path = sys.argv[1] if len(sys.argv) > 1 else "config.yaml"

    config = load_config(config_path)
    setup_logging(level=config.logging.level, log_file=config.logging.file)

    log = get_logger("curator")
    log.info("curator.starting", config=config_path)

    loop = asyncio.new_event_loop()

    # Graceful shutdown
    def _shutdown(sig: signal.Signals) -> None:
        log.info("curator.shutdown", signal=sig.name)
        for task in asyncio.all_tasks(loop):
            task.cancel()

    if sys.platform != "win32":
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, _shutdown, sig)

    try:
        from alfred._data import get_skills_dir
        loop.run_until_complete(run(config, get_skills_dir()))
    except KeyboardInterrupt:
        log.info("curator.interrupted")
    except asyncio.CancelledError:
        pass
    finally:
        loop.close()
        log.info("curator.exited")


if __name__ == "__main__":
    main()
