"""CLI entry point: janitor scan|fix|watch|status|history|ignore."""

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
        prog="janitor",
        description="Vault quality sweeper — structural scanning + agent-backed semantic fixes",
    )
    _add_config_arg(parser)

    subparsers = parser.add_subparsers(dest="command", help="Subcommand")

    # scan
    scan_parser = subparsers.add_parser("scan", help="Run structural scan, print report")
    _add_config_arg(scan_parser)
    scan_parser.add_argument("--structural-only", action="store_true", help="Skip semantic checks")

    # fix
    fix_parser = subparsers.add_parser("fix", help="Scan + invoke agent to fix issues")
    _add_config_arg(fix_parser)
    fix_parser.add_argument("--structural-only", action="store_true", help="Only fix structural issues")

    # watch
    watch_parser = subparsers.add_parser("watch", help="Daemon mode — sweep on interval")
    _add_config_arg(watch_parser)

    # status
    status_parser = subparsers.add_parser("status", help="Show last sweep result and state summary")
    _add_config_arg(status_parser)

    # history
    history_parser = subparsers.add_parser("history", help="Show past sweep results")
    _add_config_arg(history_parser)
    history_parser.add_argument("--limit", "-n", type=int, default=10, help="Number of results to show")

    # ignore
    ignore_parser = subparsers.add_parser("ignore", help="Whitelist a file from future scans")
    _add_config_arg(ignore_parser)
    ignore_parser.add_argument("file", help="Relative path to the file to ignore")
    ignore_parser.add_argument("--reason", "-r", default="", help="Why this file is ignored")

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
    from .cli import cmd_scan, cmd_fix, cmd_watch, cmd_status, cmd_history, cmd_ignore

    if args.command == "scan":
        cmd_scan(config, skills_dir, structural_only=getattr(args, "structural_only", False))
    elif args.command == "fix":
        cmd_fix(config, skills_dir, structural_only=getattr(args, "structural_only", False))
    elif args.command == "watch":
        cmd_watch(config, skills_dir)
    elif args.command == "status":
        cmd_status(config)
    elif args.command == "history":
        cmd_history(config, limit=getattr(args, "limit", 10))
    elif args.command == "ignore":
        cmd_ignore(config, args.file, reason=getattr(args, "reason", ""))
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
