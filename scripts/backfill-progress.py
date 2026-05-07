#!/usr/bin/env python3
"""Live TUI for the Phase 6 signal-extraction backfill on david.

Polls david over SSH every few seconds, renders a progress bar +
breakdown of stream events processed, signals produced, items needing
attention. Plain ANSI — no third-party deps.

Usage:
  ./scripts/backfill-progress.py              # poll every 5s
  ./scripts/backfill-progress.py --interval 10
  ./scripts/backfill-progress.py --tenant david   # default
  ./scripts/backfill-progress.py --once       # one snapshot, no loop

Quit with Ctrl-C.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from collections import deque
from datetime import datetime, timezone

# ---------- ANSI ----------
RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
BLUE = "\033[34m"
MAGENTA = "\033[35m"
CYAN = "\033[36m"
GREY = "\033[90m"
HIDE_CURSOR = "\033[?25l"
SHOW_CURSOR = "\033[?25h"
CLEAR_SCREEN = "\033[2J\033[H"


def fetch(tenant: str) -> dict | None:
    """Single SSH call returning all counters as a colon-delimited line.
    Falls back to None on transient errors so the loop keeps going."""
    cmd = (
        "total=$(ls /mnt/encrypted/vault/stream_event/ 2>/dev/null | wc -l); "
        "extracted=$(grep -L 'signal_extracted_at: null' "
        "/mnt/encrypted/vault/stream_event/*.md 2>/dev/null | wc -l); "
        "signals=$(ls /mnt/encrypted/vault/signal/ 2>/dev/null | wc -l); "
        "needs=$(ls /mnt/encrypted/vault/needs_attention/ 2>/dev/null | wc -l); "
        "tasks=$(ls /mnt/encrypted/vault/task/ 2>/dev/null | wc -l); "
        "auto_tasks=$(ls /mnt/encrypted/vault/event/auto-task-created-* "
        "2>/dev/null | wc -l); "
        "router_tick=$(docker logs --since 6m compose-alfred-learn-1 2>&1 "
        "| grep -c 'signal_router.start' || true); "
        "extract_tick=$(docker logs --since 6m compose-alfred-learn-1 2>&1 "
        "| grep -c 'signal_extract.start' || true); "
        "errors=$(docker logs --since 6m compose-alfred-learn-1 2>&1 "
        "| grep -cE 'extract_failed|list_failed' || true); "
        "echo \"$total:$extracted:$signals:$needs:$tasks:$auto_tasks:"
        "$router_tick:$extract_tick:$errors\""
    )
    try:
        proc = subprocess.run(
            ["ssh", tenant, cmd],
            capture_output=True, text=True, timeout=20,
        )
        line = proc.stdout.strip().splitlines()[-1] if proc.stdout else ""
        parts = line.split(":")
        if len(parts) != 9:
            return None
        return {
            "total": int(parts[0]),
            "extracted": int(parts[1]),
            "signals": int(parts[2]),
            "needs": int(parts[3]),
            "tasks": int(parts[4]),
            "auto_tasks": int(parts[5]),
            "router_tick": int(parts[6]),
            "extract_tick": int(parts[7]),
            "errors": int(parts[8]),
        }
    except (subprocess.TimeoutExpired, ValueError, IndexError):
        return None


def bar(pct: float, width: int = 50, color: str = GREEN) -> str:
    filled = int(width * pct / 100)
    return (
        color + "█" * filled + GREY + "░" * (width - filled) + RESET
    )


def format_eta(secs: float | None) -> str:
    if secs is None or secs <= 0 or secs == float("inf"):
        return "—"
    if secs < 60:
        return f"{int(secs)}s"
    if secs < 3600:
        return f"{int(secs / 60)}m"
    if secs < 86400:
        h = int(secs / 3600)
        m = int((secs % 3600) / 60)
        return f"{h}h {m}m"
    d = int(secs / 86400)
    h = int((secs % 86400) / 3600)
    return f"{d}d {h}h"


def render(data: dict, history: deque) -> str:
    cols = shutil.get_terminal_size((80, 24)).columns
    lines: list[str] = []

    total = data["total"]
    extracted = data["extracted"]
    pct = (extracted * 100 / total) if total > 0 else 0
    remaining = total - extracted

    # Rate from history (records/sec over last N samples)
    rate_per_min = 0.0
    eta_secs: float | None = None
    if len(history) >= 2:
        dt = (history[-1][0] - history[0][0])
        de = (history[-1][1] - history[0][1])
        if dt > 0 and de > 0:
            rate_per_sec = de / dt
            rate_per_min = rate_per_sec * 60
            if remaining > 0:
                eta_secs = remaining / rate_per_sec

    bar_width = max(20, min(60, cols - 30))
    bar_color = (
        GREEN if rate_per_min > 5 else
        YELLOW if rate_per_min > 0 else
        RED
    )

    now = datetime.now(timezone.utc).strftime("%H:%M:%SZ")
    lines.append(f"{BOLD}{CYAN}Alfred Phase-6 backfill{RESET}  {GREY}{now}{RESET}")
    lines.append("")

    lines.append(
        f"  {bar(pct, bar_width, bar_color)} "
        f"{BOLD}{pct:5.1f}%{RESET}  "
        f"{extracted:,}/{total:,}"
    )
    lines.append("")

    lines.append(
        f"  {GREY}rate{RESET}  {BOLD}{rate_per_min:>5.1f}{RESET} rec/min   "
        f"{GREY}eta{RESET}  {BOLD}{format_eta(eta_secs):>8}{RESET}   "
        f"{GREY}remaining{RESET}  {BOLD}{remaining:,}{RESET}"
    )
    lines.append("")

    # Vault breakdown
    lines.append(f"  {BOLD}Vault{RESET}")
    lines.append(
        f"    {GREEN}●{RESET} signals          "
        f"{BOLD}{data['signals']:>5}{RESET}"
    )
    lines.append(
        f"    {YELLOW}●{RESET} needs attention  "
        f"{BOLD}{data['needs']:>5}{RESET}"
    )
    lines.append(
        f"    {BLUE}●{RESET} tasks            "
        f"{BOLD}{data['tasks']:>5}{RESET}  "
        f"{GREY}({data['auto_tasks']} auto-created from signals){RESET}"
    )
    lines.append("")

    # Workflow ticks (last 6 min)
    lines.append(f"  {BOLD}Workflow activity (last 6 min){RESET}")
    et_color = GREEN if data["extract_tick"] > 0 else YELLOW
    rt_color = GREEN if data["router_tick"] > 0 else YELLOW
    err_color = RED if data["errors"] > 0 else GREEN
    lines.append(
        f"    {et_color}●{RESET} extract ticks    "
        f"{BOLD}{data['extract_tick']:>5}{RESET}"
    )
    lines.append(
        f"    {rt_color}●{RESET} router ticks     "
        f"{BOLD}{data['router_tick']:>5}{RESET}"
    )
    lines.append(
        f"    {err_color}●{RESET} errors           "
        f"{BOLD}{data['errors']:>5}{RESET}"
    )
    lines.append("")
    lines.append(
        f"  {GREY}polling every {{interval}}s · ctrl-c to quit{RESET}"
    )

    return "\n".join(lines)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--tenant", default="david", help="ssh host alias")
    p.add_argument("--interval", type=float, default=5.0,
                   help="polling interval in seconds (default 5)")
    p.add_argument("--once", action="store_true",
                   help="print one snapshot and exit")
    p.add_argument("--no-clear", action="store_true",
                   help="don't clear screen between updates")
    args = p.parse_args()

    history: deque = deque(maxlen=24)  # ~2 min of samples at 5s
    sys.stdout.write(HIDE_CURSOR if not args.once else "")
    sys.stdout.flush()

    try:
        while True:
            data = fetch(args.tenant)
            if data is None:
                if not args.no_clear and not args.once:
                    sys.stdout.write(CLEAR_SCREEN)
                sys.stdout.write(
                    f"{YELLOW}fetch failed (network/ssh) — retrying...{RESET}\n"
                )
                sys.stdout.flush()
            else:
                history.append((time.time(), data["extracted"]))
                if not args.no_clear and not args.once:
                    sys.stdout.write(CLEAR_SCREEN)
                rendered = render(data, history).replace(
                    "{interval}", str(int(args.interval))
                )
                sys.stdout.write(rendered)
                sys.stdout.write("\n")
                sys.stdout.flush()
            if args.once:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write(SHOW_CURSOR)
        sys.stdout.write("\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
