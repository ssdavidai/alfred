"""CLI entry point: distiller scan|run|watch|status|history."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import load_config
from .utils import setup_logging


def _add_config_arg(parser: argparse.ArgumentParser) -> None:
    """Add --config flag to a parser."""
    parser.add_argument(
        "--config", "-c",
        default="config.yaml",
        help="Path to config.yaml (default: config.yaml in cwd)",
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="distiller",
        description="Vault knowledge extractor — distills operational records into learning records",
    )
    _add_config_arg(parser)

    subparsers = parser.add_subparsers(dest="command", help="Subcommand")

    # scan
    scan_parser = subparsers.add_parser("scan", help="Identify candidates, print report (no agent)")
    _add_config_arg(scan_parser)
    scan_parser.add_argument("--project", "-p", default=None, help="Filter to a single project")

    # run
    run_parser = subparsers.add_parser("run", help="Scan + invoke agent to extract learnings")
    _add_config_arg(run_parser)
    run_parser.add_argument("--project", "-p", default=None, help="Filter to a single project")

    # watch
    watch_parser = subparsers.add_parser("watch", help="Daemon mode — extract on interval")
    _add_config_arg(watch_parser)

    # status
    status_parser = subparsers.add_parser("status", help="Show last run and state summary")
    _add_config_arg(status_parser)

    # history
    history_parser = subparsers.add_parser("history", help="Show past extraction runs")
    _add_config_arg(history_parser)
    history_parser.add_argument("--limit", "-n", type=int, default=10, help="Number of results to show")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    # Load config
    config = load_config(args.config)
    setup_logging(config.logging.level, config.logging.file)

    from alfred._data import get_skills_dir
    skills_dir = get_skills_dir()

    # Import CLI commands here to avoid circular imports
    from .cli import cmd_scan, cmd_run, cmd_watch, cmd_status, cmd_history

    if args.command == "scan":
        cmd_scan(config, skills_dir, project=getattr(args, "project", None))
    elif args.command == "run":
        cmd_run(config, skills_dir, project=getattr(args, "project", None))
    elif args.command == "watch":
        cmd_watch(config, skills_dir)
    elif args.command == "status":
        cmd_status(config)
    elif args.command == "history":
        cmd_history(config, limit=getattr(args, "limit", 10))
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
